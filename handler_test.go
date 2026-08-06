package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/tjmisko/switchboard-dashboard/internal/provider"
	"github.com/tjmisko/switchboard-dashboard/internal/sessiondigest"
)

const fixtureJSON = `{"window":"2026-06-20","lanes":null,"summary":{"from":"2026-06-20T09:00:00Z","to":"2026-06-20T09:48:00Z","sessions":0,"by_status":{},"attention_union":0,"attention_per_session":0,"attention_fanout":0},"totals":{"tok_in":1,"tok_out":2,"tok_cache_read":3,"tok_cache_create":4,"subagents":0}}`

// writeStub creates an executable shell script and returns its path.
func writeStub(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "stub-ctl")
	if err := os.WriteFile(p, []byte(body), 0o755); err != nil {
		t.Fatalf("write stub: %v", err)
	}
	return p
}

func TestHandleTimeline_servesFixtureJSON(t *testing.T) {
	stub := writeStub(t, "#!/bin/sh\ncat <<'JSONEOF'\n"+fixtureJSON+"\nJSONEOF\n")
	srv := &Server{Ctl: stub}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/timeline?day=2026-06-20", nil)
	srv.Handler().ServeHTTP(rec, req)

	res := rec.Result()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	if ct := res.Header.Get("Content-Type"); ct != "application/json" {
		t.Fatalf("content-type = %q, want application/json", ct)
	}
	if got := strings.TrimSpace(rec.Body.String()); got != fixtureJSON {
		t.Fatalf("body = %q, want fixture", got)
	}
	// confirm it parses as the contract shape with null lanes handled.
	var parsed map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &parsed); err != nil {
		t.Fatalf("body is not valid json: %v", err)
	}
	for _, k := range []string{"window", "lanes", "summary", "totals"} {
		if _, ok := parsed[k]; !ok {
			t.Fatalf("body missing top-level key %q", k)
		}
	}
}

func TestHandleTimeline_forwardsQueryParamsToArgv(t *testing.T) {
	argvFile := filepath.Join(t.TempDir(), "argv.txt")
	body := "#!/bin/sh\n: > " + argvFile + "\nfor a in \"$@\"; do printf '%s\\n' \"$a\" >> " + argvFile + "; done\nprintf '%s' '" + fixtureJSON + "'\n"
	stub := writeStub(t, body)
	srv := &Server{Ctl: stub, Dir: "/server/default"}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet,
		"/api/timeline?day=2026-06-20&since=2026-06-01&until=2026-06-30&dir=/from/query", nil)
	srv.Handler().ServeHTTP(rec, req)

	if rec.Result().StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", rec.Result().StatusCode, rec.Body.String())
	}

	raw, err := os.ReadFile(argvFile)
	if err != nil {
		t.Fatalf("read argv file: %v", err)
	}
	args := strings.Fields(strings.TrimSpace(string(raw)))

	// base argv (the binary path is argv[0] and is NOT echoed by "$@")
	mustContainPair(t, args, "--day", "2026-06-20")
	mustContainPair(t, args, "--since", "2026-06-01")
	mustContainPair(t, args, "--until", "2026-06-30")
	mustContainPair(t, args, "--dir", "/from/query") // query dir overrides server default
	if !contains(args, "--json") || args[0] != "timeline" {
		t.Fatalf("argv missing base flags: %v", args)
	}
}

func TestHandleTimeline_usesServerDirWhenQueryDirAbsent(t *testing.T) {
	argvFile := filepath.Join(t.TempDir(), "argv.txt")
	body := "#!/bin/sh\n: > " + argvFile + "\nfor a in \"$@\"; do printf '%s\\n' \"$a\" >> " + argvFile + "; done\nprintf '%s' '" + fixtureJSON + "'\n"
	stub := writeStub(t, body)
	srv := &Server{Ctl: stub, Dir: "/server/default"}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/timeline?day=2026-06-20", nil)
	srv.Handler().ServeHTTP(rec, req)

	raw, err := os.ReadFile(argvFile)
	if err != nil {
		t.Fatalf("read argv file: %v", err)
	}
	args := strings.Fields(strings.TrimSpace(string(raw)))
	mustContainPair(t, args, "--dir", "/server/default")
}

// countingStub writes one line per invocation to a counter file, so a test can
// assert how many provider subprocesses a sequence of requests actually spawned.
func countingStub(t *testing.T, counter string) string {
	t.Helper()
	return writeStub(t, "#!/bin/sh\necho run >> "+counter+"\nprintf '%s' '"+fixtureJSON+"'\n")
}

func countRuns(t *testing.T, counter string) int {
	t.Helper()
	raw, err := os.ReadFile(counter)
	if err != nil {
		if os.IsNotExist(err) {
			return 0
		}
		t.Fatalf("read counter: %v", err)
	}
	return len(strings.Fields(string(raw)))
}

// The provider spawn is ~1.5s and flat in payload size, so re-answering a
// finished day from memory is the whole point of the cache.
func TestHandleTimeline_shouldSpawnTheProviderOnlyOnceWhenAClosedDayIsRequestedTwice(t *testing.T) {
	counter := filepath.Join(t.TempDir(), "runs.txt")
	srv := &Server{Ctl: countingStub(t, counter)}

	var bodies []string
	for i := 0; i < 2; i++ {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/api/timeline?day=2026-06-20", nil)
		srv.Handler().ServeHTTP(rec, req)
		if rec.Result().StatusCode != http.StatusOK {
			t.Fatalf("request %d: status = %d, want 200", i, rec.Result().StatusCode)
		}
		bodies = append(bodies, strings.TrimSpace(rec.Body.String()))
	}

	if n := countRuns(t, counter); n != 1 {
		t.Fatalf("provider spawned %d times for two requests of one closed day, want 1", n)
	}
	if bodies[0] != bodies[1] {
		t.Fatalf("cached body differs from the live one:\n live: %q\ncached: %q", bodies[0], bodies[1])
	}
	if bodies[1] != fixtureJSON {
		t.Fatalf("cached body = %q, want the fixture verbatim", bodies[1])
	}
}

// Today is the window the 3s poll watches; caching it would freeze the
// dashboard's whole point.
func TestHandleTimeline_shouldSpawnTheProviderEveryTimeForTodayAndForTheBareLiveWindow(t *testing.T) {
	today := time.Now().Format("2006-01-02")
	for _, tc := range []struct{ name, query string }{
		{"explicit today", "/api/timeline?day=" + today},
		{"bare live window", "/api/timeline"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			counter := filepath.Join(t.TempDir(), "runs.txt")
			srv := &Server{Ctl: countingStub(t, counter)}
			for i := 0; i < 3; i++ {
				rec := httptest.NewRecorder()
				srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, tc.query, nil))
				if rec.Result().StatusCode != http.StatusOK {
					t.Fatalf("request %d: status = %d, want 200", i, rec.Result().StatusCode)
				}
			}
			if n := countRuns(t, counter); n != 3 {
				t.Fatalf("provider spawned %d times, want 3 — the live window must never be cached", n)
			}
		})
	}
}

// A failing day must not poison the cache: the next request has to retry the
// provider rather than being handed a 502 from memory.
func TestHandleTimeline_shouldNotCacheAFailedClosedDay(t *testing.T) {
	counter := filepath.Join(t.TempDir(), "runs.txt")
	stub := writeStub(t, "#!/bin/sh\necho run >> "+counter+"\necho 'boom' >&2\nexit 1\n")
	srv := &Server{Ctl: stub}

	for i := 0; i < 2; i++ {
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/timeline?day=2026-06-20", nil))
		if rec.Result().StatusCode != http.StatusBadGateway {
			t.Fatalf("request %d: status = %d, want 502", i, rec.Result().StatusCode)
		}
	}
	if n := countRuns(t, counter); n != 2 {
		t.Fatalf("provider spawned %d times, want 2 — a failure must not be cached", n)
	}
}

func TestHandleTimeline_nonZeroExitYields502(t *testing.T) {
	stub := writeStub(t, "#!/bin/sh\necho 'boom: bad day arg' >&2\nexit 3\n")
	srv := &Server{Ctl: stub}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/timeline?day=nope", nil)
	srv.Handler().ServeHTTP(rec, req)

	res := rec.Result()
	if res.StatusCode != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", res.StatusCode)
	}
	if ct := res.Header.Get("Content-Type"); ct != "application/json" {
		t.Fatalf("content-type = %q, want application/json", ct)
	}
	var body timelineError
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("error body is not json: %v (%q)", err, rec.Body.String())
	}
	if body.Error == "" {
		t.Fatalf("expected non-empty error field, got %+v", body)
	}
	if !strings.Contains(body.Stderr, "boom: bad day arg") {
		t.Fatalf("stderr not propagated, got %q", body.Stderr)
	}
}

// nameSpanFixture mirrors the v2 contract fields the dashboard renders session
// name-spans from: stable identity (session_id), the slug-only names[] history,
// and the optional pretty project_full. It carries two concurrent sessions, one
// of which was renamed mid-life (two names[] spans).
const nameSpanFixture = `{"window":"2026-06-26","lanes":[` +
	`{"session_id":"s-rename","pid":111,"project":"sb","project_full":"switchboard","start":"2026-06-26T17:00:00-07:00","end":"2026-06-26T18:00:00-07:00","names":[{"label":"first","start":"2026-06-26T17:10:00-07:00","end":"2026-06-26T17:40:00-07:00"},{"label":"second","start":"2026-06-26T17:40:00-07:00","end":"2026-06-26T18:00:00-07:00"}],"intervals":[]},` +
	`{"session_id":"s-concurrent","pid":222,"project":"sspi","start":"2026-06-26T17:05:00-07:00","end":"2026-06-26T18:05:00-07:00","names":[{"label":"beta","start":"2026-06-26T17:05:00-07:00","end":"2026-06-26T18:05:00-07:00"}],"intervals":[]}` +
	`],"summary":{"from":"2026-06-26T17:00:00-07:00","to":"2026-06-26T18:05:00-07:00","sessions":2,"by_status":{},"attention_union":0,"attention_per_session":0,"attention_fanout":0},"totals":{}}`

// TestHandleTimeline_preservesSessionNameSpanContract pins the proxy boundary:
// the dashboard renders name-spans entirely client-side, so the handler must
// pass session_id, names[], and project_full through untouched. A future change
// that re-encodes or filters the timeline would silently break the feature; this
// catches that.
func TestHandleTimeline_preservesSessionNameSpanContract(t *testing.T) {
	stub := writeStub(t, "#!/bin/sh\ncat <<'JSONEOF'\n"+nameSpanFixture+"\nJSONEOF\n")
	srv := &Server{Ctl: stub}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/timeline?day=2026-06-26", nil)
	srv.Handler().ServeHTTP(rec, req)

	if rec.Result().StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Result().StatusCode)
	}

	type nameSpan struct {
		Label string `json:"label"`
		Start string `json:"start"`
		End   string `json:"end"`
	}
	type lane struct {
		SessionID   string     `json:"session_id"`
		PID         int        `json:"pid"`
		ProjectFull string     `json:"project_full"`
		Names       []nameSpan `json:"names"`
	}
	var body struct {
		Lanes []lane `json:"lanes"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("timeline body not json: %v (%q)", err, rec.Body.String())
	}

	// Two distinct concurrent sessions survive the proxy (never merged by name).
	byID := map[string]lane{}
	for _, l := range body.Lanes {
		byID[l.SessionID] = l
	}
	if len(byID) != 2 {
		t.Fatalf("expected 2 distinct sessions, got %d: %+v", len(byID), body.Lanes)
	}

	// The renamed session keeps its full slug-span history and pretty name.
	r, ok := byID["s-rename"]
	if !ok {
		t.Fatalf("s-rename session missing from proxied body")
	}
	if r.ProjectFull != "switchboard" {
		t.Fatalf("project_full not preserved: %q", r.ProjectFull)
	}
	if len(r.Names) != 2 || r.Names[0].Label != "first" || r.Names[1].Label != "second" {
		t.Fatalf("names[] span history not preserved: %+v", r.Names)
	}
}

func TestServer_servesEmbeddedIndex(t *testing.T) {
	srv := &Server{Ctl: "unused"}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	srv.Handler().ServeHTTP(rec, req)

	if rec.Result().StatusCode != http.StatusOK {
		t.Fatalf("GET / status = %d, want 200", rec.Result().StatusCode)
	}
	if !strings.Contains(rec.Body.String(), "<title>") {
		t.Fatalf("index.html not served; body did not contain <title>")
	}
}

// The field guide is a second embedded page, and its three assets are listed on
// their own //go:embed line. A missing one is a 404 the compiler cannot catch,
// so each is fetched here — the page is inert without any of them.
func TestServer_servesEmbeddedFieldGuide(t *testing.T) {
	srv := &Server{Ctl: "unused"}
	for _, path := range []string{"/states.html", "/states.css", "/states.js", "/states-model.js"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		srv.Handler().ServeHTTP(rec, req)

		if rec.Result().StatusCode != http.StatusOK {
			t.Fatalf("GET %s status = %d, want 200", path, rec.Result().StatusCode)
		}
		if rec.Body.Len() == 0 {
			t.Fatalf("GET %s served an empty body", path)
		}
	}
}

// --- multi-provider merge ---

func TestHandleTimeline_mergesMultipleProvidersAndNamespacesLanes(t *testing.T) {
	claudeEnv := `{"window":"2026-06-26","lanes":[{"session_id":"c1","agent":"claude","project":"sb","start":"2026-06-26T10:00:00Z","end":"2026-06-26T10:30:00Z","intervals":[{"status":"working","start":"2026-06-26T10:00:00Z","end":"2026-06-26T10:30:00Z"}]}],"summary":{"from":"2026-06-26T10:00:00Z","to":"2026-06-26T10:30:00Z","sessions":1,"by_status":{"working":1800000000000},"attention_union":1800000000000,"attention_per_session":1800000000000,"attention_fanout":1800000000000},"totals":{"cost_usd":1.0}}`
	arachneEnv := `{"window":"2026-06-26","lanes":[{"session_id":"feat-f71","agent":"opus","project":"Arachne","start":"2026-06-26T10:10:00Z","end":"2026-06-26T10:50:00Z","intervals":[{"status":"working","start":"2026-06-26T10:10:00Z","end":"2026-06-26T10:50:00Z"}]}],"summary":{"from":"2026-06-26T10:10:00Z","to":"2026-06-26T10:50:00Z","sessions":1,"by_status":{"working":2400000000000},"attention_union":2400000000000,"attention_per_session":2400000000000,"attention_fanout":2400000000000},"totals":{"cost_usd":2.0}}`
	claudeStub := writeStub(t, "#!/bin/sh\ncat <<'JSONEOF'\n"+claudeEnv+"\nJSONEOF\n")
	arachneStub := writeStub(t, "#!/bin/sh\ncat <<'JSONEOF'\n"+arachneEnv+"\nJSONEOF\n")
	srv := &Server{Providers: []provider.Provider{
		provider.NewSubprocessProvider("claude", "Claude", []string{claudeStub}, "", provider.Capabilities{Plan: true}),
		provider.NewSubprocessProvider("arachne", "Arachne", []string{arachneStub}, "", provider.Capabilities{}),
	}}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/timeline?day=2026-06-26", nil)
	srv.Handler().ServeHTTP(rec, req)

	if rec.Result().StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", rec.Result().StatusCode, rec.Body.String())
	}
	var body struct {
		Lanes []struct {
			SessionID string `json:"session_id"`
			Provider  string `json:"provider"`
		} `json:"lanes"`
		Totals struct {
			CostUSD float64 `json:"cost_usd"`
		} `json:"totals"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body not json: %v (%q)", err, rec.Body.String())
	}
	byID := map[string]string{}
	for _, l := range body.Lanes {
		byID[l.SessionID] = l.Provider
	}
	if byID["claude:c1"] != "claude" {
		t.Fatalf("expected claude:c1 tagged claude, got %+v", byID)
	}
	if byID["arachne:feat-f71"] != "arachne" {
		t.Fatalf("expected arachne:feat-f71 tagged arachne, got %+v", byID)
	}
	if body.Totals.CostUSD != 3.0 {
		t.Fatalf("merged cost = %v, want 3.0", body.Totals.CostUSD)
	}
}

func TestHandleTimeline_mergeDegradesWhenOneProviderFails(t *testing.T) {
	goodEnv := `{"window":"x","lanes":[{"session_id":"c1","start":"2026-06-26T10:00:00Z","end":"2026-06-26T10:30:00Z","intervals":[]}],"summary":{"from":"2026-06-26T10:00:00Z","to":"2026-06-26T10:30:00Z","sessions":1,"by_status":{}},"totals":{}}`
	goodStub := writeStub(t, "#!/bin/sh\ncat <<'JSONEOF'\n"+goodEnv+"\nJSONEOF\n")
	badStub := writeStub(t, "#!/bin/sh\necho 'docker: not found' >&2\nexit 1\n")
	srv := &Server{Providers: []provider.Provider{
		provider.NewSubprocessProvider("claude", "Claude", []string{goodStub}, "", provider.Capabilities{Plan: true}),
		provider.NewSubprocessProvider("arachne", "Arachne", []string{badStub}, "", provider.Capabilities{}),
	}}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/timeline?day=2026-06-26", nil)
	srv.Handler().ServeHTTP(rec, req)
	if rec.Result().StatusCode != http.StatusOK {
		t.Fatalf("one failed provider should still 200, got %d", rec.Result().StatusCode)
	}
	var body struct {
		Lanes []struct {
			SessionID string `json:"session_id"`
		} `json:"lanes"`
		ProviderErrors []struct {
			Provider string `json:"provider"`
			Error    string `json:"error"`
		} `json:"provider_errors"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body not json: %v", err)
	}
	if len(body.Lanes) != 1 || body.Lanes[0].SessionID != "claude:c1" {
		t.Fatalf("expected the surviving claude lane, got %+v", body.Lanes)
	}
	if len(body.ProviderErrors) != 1 || body.ProviderErrors[0].Provider != "arachne" {
		t.Fatalf("expected arachne provider_error, got %+v", body.ProviderErrors)
	}
	if !strings.Contains(body.ProviderErrors[0].Error, "docker: not found") {
		t.Fatalf("expected stderr in provider_error, got %q", body.ProviderErrors[0].Error)
	}
}

func TestHandleTimeline_mergeAllProvidersFailingYields502(t *testing.T) {
	bad := writeStub(t, "#!/bin/sh\necho boom >&2\nexit 1\n")
	srv := &Server{Providers: []provider.Provider{
		provider.NewSubprocessProvider("a", "A", []string{bad}, "", provider.Capabilities{}),
		provider.NewSubprocessProvider("b", "B", []string{bad}, "", provider.Capabilities{}),
	}}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/timeline?day=2026-06-26", nil)
	srv.Handler().ServeHTTP(rec, req)
	if rec.Result().StatusCode != http.StatusBadGateway {
		t.Fatalf("all providers failing should 502, got %d", rec.Result().StatusCode)
	}
}

// --- /api/plan ---

const planFixture = `{"five_hour":{"utilization":42.0,"resets_at":"2026-06-26T18:39:59Z","limit_dollars":null,"used_dollars":null,"remaining_dollars":null},"seven_day":{"utilization":34.0,"resets_at":"2026-07-01T03:59:59Z"},"seven_day_opus":{"utilization":61.0,"resets_at":"2026-07-01T03:59:59Z"}}`

func writePlan(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "claude-plan-usage.json")
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatalf("write plan: %v", err)
	}
	return p
}

func TestReadPlan_presentFileIsAvailableAndFresh(t *testing.T) {
	p := writePlan(t, planFixture)
	info, _ := os.Stat(p)
	got := readPlan(p, info.ModTime().Add(30*time.Second))

	if !got.Available {
		t.Fatalf("expected available, got %+v", got)
	}
	if got.Stale {
		t.Fatalf("30s-old file should not be stale")
	}
	if got.FiveHour == nil || got.FiveHour.Utilization == nil || *got.FiveHour.Utilization != 42 {
		t.Fatalf("five_hour utilization not parsed: %+v", got.FiveHour)
	}
	if got.SevenDay == nil || got.SevenDay.Utilization == nil || *got.SevenDay.Utilization != 34 {
		t.Fatalf("seven_day utilization not parsed: %+v", got.SevenDay)
	}
	if got.AgeSeconds < 29 || got.AgeSeconds > 31 {
		t.Fatalf("age_seconds = %d, want ~30", got.AgeSeconds)
	}
	if got.Mtime == "" {
		t.Fatalf("expected mtime stamp")
	}
}

func TestReadPlan_absentFileDegradesGracefully(t *testing.T) {
	got := readPlan(filepath.Join(t.TempDir(), "does-not-exist.json"), time.Now())
	if got.Available {
		t.Fatalf("absent file should be unavailable, got %+v", got)
	}
	if got.Error != "" {
		t.Fatalf("absent file is expected, not an error: %q", got.Error)
	}
}

func TestReadPlan_oldMtimeIsStale(t *testing.T) {
	p := writePlan(t, planFixture)
	old := time.Now().Add(-10 * time.Minute)
	if err := os.Chtimes(p, old, old); err != nil {
		t.Fatalf("chtimes: %v", err)
	}
	got := readPlan(p, time.Now())
	if !got.Available {
		t.Fatalf("expected available even when stale")
	}
	if !got.Stale {
		t.Fatalf("10m-old file should be stale, age=%ds", got.AgeSeconds)
	}
	if got.AgeSeconds < 9*60 {
		t.Fatalf("age_seconds = %d, want ~600", got.AgeSeconds)
	}
}

func TestReadPlan_malformedJSONIsUnavailableWithError(t *testing.T) {
	p := writePlan(t, "{not json")
	got := readPlan(p, time.Now())
	if got.Available {
		t.Fatalf("malformed file should be unavailable")
	}
	if got.Error == "" {
		t.Fatalf("expected an error message for malformed json")
	}
}

func TestHandlePlan_servesNormalizedJSON(t *testing.T) {
	p := writePlan(t, planFixture)
	srv := &Server{Ctl: "unused", PlanPath: p}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/plan", nil)
	srv.Handler().ServeHTTP(rec, req)

	res := rec.Result()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	if ct := res.Header.Get("Content-Type"); ct != "application/json" {
		t.Fatalf("content-type = %q, want application/json", ct)
	}
	var body planResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("plan body not json: %v (%q)", err, rec.Body.String())
	}
	if !body.Available || body.FiveHour == nil {
		t.Fatalf("expected available plan with five_hour, got %+v", body)
	}
}

func TestHandlePlan_absentFileReturns200Unavailable(t *testing.T) {
	srv := &Server{Ctl: "unused", PlanPath: filepath.Join(t.TempDir(), "nope.json")}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/plan", nil)
	srv.Handler().ServeHTTP(rec, req)

	if rec.Result().StatusCode != http.StatusOK {
		t.Fatalf("absent plan file should still be 200, got %d", rec.Result().StatusCode)
	}
	var body planResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("plan body not json: %v", err)
	}
	if body.Available {
		t.Fatalf("expected available=false for absent file")
	}
}

// helpers

func contains(args []string, want string) bool {
	for _, a := range args {
		if a == want {
			return true
		}
	}
	return false
}

func mustContainPair(t *testing.T, args []string, flag, val string) {
	t.Helper()
	for i := 0; i < len(args)-1; i++ {
		if args[i] == flag && args[i+1] == val {
			return
		}
	}
	t.Fatalf("expected argv to contain %q %q, got %v", flag, val, args)
}

// writeSummaryRecord drops a session-digest record file under
// dir/<slug>/<id>.json with the given summary JSON fragment ("" for a
// digest-only record).
func writeSummaryRecord(t *testing.T, dir, slug, id, summaryJSON string) {
	t.Helper()
	writeSummaryRecordWithTokens(t, dir, slug, id, summaryJSON, "")
}

// writeSummaryRecordWithTokens is writeSummaryRecord plus a digest.tokens
// fragment ("" for a record written before token counts existed).
func writeSummaryRecordWithTokens(t *testing.T, dir, slug, id, summaryJSON, tokensJSON string) {
	t.Helper()
	slugDir := filepath.Join(dir, slug)
	if err := os.MkdirAll(slugDir, 0o755); err != nil {
		t.Fatal(err)
	}
	body := `{"digest":{"sessionId":"` + id + `"`
	if tokensJSON != "" {
		body += `,"tokens":` + tokensJSON
	}
	body += `}`
	if summaryJSON != "" {
		body += `,"summary":` + summaryJSON + `,"generatedAt":"2026-07-31T22:00:00Z"`
	}
	body += `}`
	if err := os.WriteFile(filepath.Join(slugDir, id+".json"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestSummariesShouldServeGeneratedRecordsAndOmitRecordsThatCarryNothing(t *testing.T) {
	dir := t.TempDir()
	writeSummaryRecord(t, dir, "-home-u-proj", "sess-summarized",
		`{"name":"fix-flaky-test","description":"Fixed the flaky auth test","summary":"The session fixed a race."}`)
	// No summary AND no token counts: everything this record holds is already on
	// the timeline, so it stays omitted.
	writeSummaryRecord(t, dir, "-home-u-proj", "sess-digest-only", "")

	srv := &Server{SummariesDir: dir}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/summaries", nil)
	srv.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var resp struct {
		Sessions map[string]struct {
			Name        string `json:"name"`
			Description string `json:"description"`
			Summary     string `json:"summary"`
		} `json:"sessions"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Sessions) != 1 {
		t.Fatalf("sessions = %v, want only the summarized one", resp.Sessions)
	}
	got, ok := resp.Sessions["sess-summarized"]
	if !ok {
		t.Fatalf("missing sess-summarized in %v", resp.Sessions)
	}
	if got.Name != "fix-flaky-test" || got.Description != "Fixed the flaky auth test" {
		t.Errorf("entry = %+v, want summary fields verbatim", got)
	}
}

// tokensFragment is a digest.tokens block in the shape sessiondigest writes.
const tokensFragment = `{"main":{"responses":236,"inputFresh":646,"cacheCreation":259595,` +
	`"cacheCreation1h":259595,"cacheRead":34532761,"output":104821,"peakTurnInput":236518},` +
	`"sidechain":{"responses":55,"inputFresh":101,"cacheCreation":352990,"cacheRead":2646005,` +
	`"output":14546,"peakTurnInput":97105},` +
	`"byModel":{"claude-opus-5":{"responses":291,"inputFresh":747,"cacheCreation":612585,` +
	`"cacheRead":37178766,"output":119367,"peakTurnInput":236518}}}`

func TestSummariesShouldServeTokenCountsWhenTheRecordCarriesThem(t *testing.T) {
	dir := t.TempDir()
	writeSummaryRecordWithTokens(t, dir, "-home-u-proj", "sess-spendy",
		`{"name":"big-one","description":"Burned a lot","summary":"Long session."}`, tokensFragment)

	srv := &Server{SummariesDir: dir}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/summaries", nil)
	srv.Handler().ServeHTTP(rec, req)

	var resp struct {
		Sessions map[string]struct {
			Description string                    `json:"description"`
			Tokens      *sessiondigest.TokenUsage `json:"tokens"`
		} `json:"sessions"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	got := resp.Sessions["sess-spendy"]
	if got.Tokens == nil {
		t.Fatal("tokens absent; want the digest's counts forwarded")
	}
	if got.Tokens.Main.Output != 104821 || got.Tokens.Main.PeakTurnInput != 236518 {
		t.Errorf("main = %#v, want the record's counts verbatim", got.Tokens.Main)
	}
	if got.Tokens.Sidechain == nil || got.Tokens.Sidechain.Output != 14546 {
		t.Errorf("sidechain = %#v, want the delegated spend forwarded", got.Tokens.Sidechain)
	}
	if got.Tokens.ByModel["claude-opus-5"].Responses != 291 {
		t.Errorf("byModel = %#v, want the per-model bucket forwarded", got.Tokens.ByModel)
	}
	if got.Description != "Burned a lot" {
		t.Errorf("description = %q, want the summary still served alongside", got.Description)
	}
}

func TestSummariesShouldServeDigestOnlyRecordsWhenTheyCarryTokenCounts(t *testing.T) {
	// Token counts exist for every session that called the API, including the
	// thin ones the condenser never summarizes. Gating them behind an LLM
	// summary would hide data already on disk.
	dir := t.TempDir()
	writeSummaryRecordWithTokens(t, dir, "-home-u-proj", "sess-thin", "", tokensFragment)

	srv := &Server{SummariesDir: dir}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/summaries", nil)
	srv.Handler().ServeHTTP(rec, req)

	var resp struct {
		Sessions map[string]struct {
			Description string                    `json:"description"`
			Name        string                    `json:"name"`
			Tokens      *sessiondigest.TokenUsage `json:"tokens"`
		} `json:"sessions"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	got, ok := resp.Sessions["sess-thin"]
	if !ok {
		t.Fatalf("sess-thin omitted; sessions = %v", resp.Sessions)
	}
	if got.Tokens == nil || got.Tokens.Main.Output != 104821 {
		t.Errorf("tokens = %#v, want the counts served without a summary", got.Tokens)
	}
	if got.Description != "" || got.Name != "" {
		t.Errorf("entry = %+v, want no fabricated summary fields", got)
	}
}

func TestSummariesShouldPassTasksThroughWhenTheRecordCarriesThem(t *testing.T) {
	dir := t.TempDir()
	writeSummaryRecord(t, dir, "-home-u-proj", "sess-multi",
		`{"name":"three-jobs","description":"Did three jobs","tasks":["Fixed the lookup","Added the endpoint"],"summary":"A mixed session."}`)
	writeSummaryRecord(t, dir, "-home-u-proj", "sess-prose",
		`{"name":"one-job","description":"Did one job","summary":"A single continuous task."}`)

	srv := &Server{SummariesDir: dir}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/summaries", nil)
	srv.Handler().ServeHTTP(rec, req)

	var resp struct {
		Sessions map[string]struct {
			Tasks []string `json:"tasks"`
		} `json:"sessions"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	want := []string{"Fixed the lookup", "Added the endpoint"}
	if got := resp.Sessions["sess-multi"].Tasks; !reflect.DeepEqual(got, want) {
		t.Errorf("tasks = %#v, want %#v", got, want)
	}
	if got := resp.Sessions["sess-prose"].Tasks; len(got) != 0 {
		t.Errorf("tasks = %#v, want none for a prose-only record", got)
	}
}

func TestSummariesShouldKeepTheRecordWhenItsTasksFieldHasAnUnexpectedShape(t *testing.T) {
	// tasks is enrichment: a schema change or a malformed field there must cost
	// the bullets alone, never the session's name, description and prose.
	dir := t.TempDir()
	writeSummaryRecord(t, dir, "-home-u-proj", "sess-object-tasks",
		`{"name":"odd-shape","description":"Did the work anyway","tasks":{"1":"Fixed the lookup"},"summary":"Landed on main."}`)
	writeSummaryRecord(t, dir, "-home-u-proj", "sess-mixed-tasks",
		`{"name":"mixed","description":"Mixed list","tasks":["Fixed the lookup",{"task":"dropped"}],"summary":"Landed."}`)

	srv := &Server{SummariesDir: dir}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/summaries", nil)
	srv.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var resp struct {
		Sessions map[string]struct {
			Name        string   `json:"name"`
			Description string   `json:"description"`
			Tasks       []string `json:"tasks"`
			Summary     string   `json:"summary"`
		} `json:"sessions"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	got, ok := resp.Sessions["sess-object-tasks"]
	if !ok {
		t.Fatalf("record dropped over its tasks field; sessions = %v", resp.Sessions)
	}
	if got.Name != "odd-shape" || got.Description != "Did the work anyway" || got.Summary != "Landed on main." {
		t.Errorf("entry = %+v, want name, description and prose preserved", got)
	}
	if len(got.Tasks) != 0 {
		t.Errorf("tasks = %#v, want none for an unreadable field", got.Tasks)
	}
	if want := []string{"Fixed the lookup"}; !reflect.DeepEqual(resp.Sessions["sess-mixed-tasks"].Tasks, want) {
		t.Errorf("tasks = %#v, want the string entries kept %#v", resp.Sessions["sess-mixed-tasks"].Tasks, want)
	}
}

// --- /api/memory ---

// memoryFixtureHost is a host provider's `memory --json`: an agent/tree split per
// session plus the machine-wide pressure series.
const memoryFixtureHost = `{"window":"2026-06-26","sessions":[` +
	`{"session_id":"s1","pid":4821,"agent":"claude","project":"sb","peak_agent_bytes":612368384,"avg_agent_bytes":498073600,"peak_tree_bytes":3221225472,"avg_tree_bytes":1503238553,` +
	`"mem":[{"ts":"2026-06-26T13:00:00Z","agent":402653184,"tree":402653184},{"ts":"2026-06-26T13:20:00Z","agent":528482304,"tree":3221225472}]}` +
	`],"pressure":[` +
	`{"ts":"2026-06-26T13:00:00Z","avail_bytes":21474836480,"psi_avg10":0.0,"psi_stall_us":0},` +
	`{"ts":"2026-06-26T13:20:00Z","avail_bytes":17179869184,"psi_avg10":2.1,"psi_stall_us":96000}]}`

// memoryFixtureContainer is a container provider on the SAME host: a tree figure
// with no agent split, a colliding raw session id, and — because pressure is
// machine-wide — a verbatim repeat of the host's pressure series.
const memoryFixtureContainer = `{"window":"2026-06-26","sessions":[` +
	`{"session_id":"s1","project":"Arachne","peak_agent_bytes":null,"avg_agent_bytes":null,"peak_tree_bytes":8589934592,"avg_tree_bytes":4294967296,` +
	`"mem":[{"ts":"2026-06-26T13:05:00Z","agent":null,"tree":8589934592}]}` +
	`],"pressure":[` +
	`{"ts":"2026-06-26T13:00:00Z","avail_bytes":21474836480,"psi_avg10":0.0,"psi_stall_us":0},` +
	`{"ts":"2026-06-26T13:20:00Z","avail_bytes":17179869184,"psi_avg10":2.1,"psi_stall_us":96000}]}`

// writeMemoryStub builds a ctl stub that serves the memory document — and fails
// loudly for any other subcommand, so every test through it also pins that the
// handler asked for `memory` rather than reusing the timeline argv.
func writeMemoryStub(t *testing.T, doc string) string {
	t.Helper()
	return writeStub(t, "#!/bin/sh\nif [ \"$1\" != memory ]; then echo \"stub: want memory, got $1\" >&2; exit 2; fi\ncat <<'JSONEOF'\n"+doc+"\nJSONEOF\n")
}

// noMemoryStub imitates a ctl build that predates the subcommand: it rejects
// `memory` the way a real CLI rejects an unknown one.
func noMemoryStub(t *testing.T) string {
	t.Helper()
	return writeStub(t, "#!/bin/sh\nif [ \"$1\" = memory ]; then echo 'unknown subcommand \"memory\"' >&2; exit 1; fi\nprintf '%s' '"+fixtureJSON+"'\n")
}

type memoryBody struct {
	Sessions map[string]struct {
		PeakAgentBytes *int64 `json:"peak_agent_bytes"`
		AvgAgentBytes  *int64 `json:"avg_agent_bytes"`
		PeakTreeBytes  *int64 `json:"peak_tree_bytes"`
		AvgTreeBytes   *int64 `json:"avg_tree_bytes"`
		Mem            []struct {
			TS    string `json:"ts"`
			Agent *int64 `json:"agent"`
			Tree  *int64 `json:"tree"`
		} `json:"mem"`
	} `json:"sessions"`
	Pressure []struct {
		TS         string   `json:"ts"`
		AvailBytes *int64   `json:"avail_bytes"`
		PSIAvg10   *float64 `json:"psi_avg10"`
		PSIStallUS *int64   `json:"psi_stall_us"`
	} `json:"pressure"`
}

// getMemory issues the request and decodes the body, asserting the endpoint's
// standing promise that it is always a 200.
func getMemory(t *testing.T, srv *Server, query string) (memoryBody, string) {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/memory"+query, nil)
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", rec.Code, rec.Body.String())
	}
	if ct := rec.Result().Header.Get("Content-Type"); ct != "application/json" {
		t.Fatalf("content-type = %q, want application/json", ct)
	}
	var body memoryBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("memory body not json: %v (%q)", err, rec.Body.String())
	}
	return body, rec.Body.String()
}

func TestMemoryShouldKeySessionsByRawIdWhenThereIsOneProvider(t *testing.T) {
	// The single-provider timeline path is a verbatim proxy, so its lane
	// session_ids are un-namespaced; memory keys must match them exactly or every
	// hover looks up an id that does not exist.
	srv := &Server{Ctl: writeMemoryStub(t, memoryFixtureHost)}

	body, _ := getMemory(t, srv, "?day=2026-06-26")

	got, ok := body.Sessions["s1"]
	if !ok {
		t.Fatalf("sessions = %v, want the raw session id s1", body.Sessions)
	}
	if got.PeakAgentBytes == nil || *got.PeakAgentBytes != 612368384 {
		t.Errorf("peak_agent_bytes = %v, want 612368384 verbatim", got.PeakAgentBytes)
	}
	if got.PeakTreeBytes == nil || *got.PeakTreeBytes != 3221225472 {
		t.Errorf("peak_tree_bytes = %v, want 3221225472 verbatim", got.PeakTreeBytes)
	}
	if got.AvgTreeBytes == nil || *got.AvgTreeBytes != 1503238553 {
		t.Errorf("avg_tree_bytes = %v, want the time-weighted average verbatim", got.AvgTreeBytes)
	}
	if len(got.Mem) != 2 || got.Mem[1].Tree == nil || *got.Mem[1].Tree != 3221225472 {
		t.Errorf("mem series = %+v, want both samples with their tree figures", got.Mem)
	}
	if len(body.Pressure) != 2 || body.Pressure[1].PSIStallUS == nil || *body.Pressure[1].PSIStallUS != 96000 {
		t.Errorf("pressure = %+v, want the provider's series verbatim", body.Pressure)
	}
}

func TestMemoryShouldNamespaceSessionKeysWhenProvidersAreMerged(t *testing.T) {
	// Both providers report a session called "s1". timeline.Merge namespaces lane
	// ids the same way, so these keys still line up with the lanes they enrich.
	srv := &Server{Providers: []provider.Provider{
		provider.NewSubprocessProvider("claude", "Claude", []string{writeMemoryStub(t, memoryFixtureHost)}, "", provider.Capabilities{Memory: true}),
		provider.NewSubprocessProvider("arachne", "Arachne", []string{writeMemoryStub(t, memoryFixtureContainer)}, "", provider.Capabilities{Memory: true}),
	}}

	body, raw := getMemory(t, srv, "?day=2026-06-26")

	if len(body.Sessions) != 2 {
		t.Fatalf("sessions = %v, want both providers' s1 kept apart", body.Sessions)
	}
	host, ok := body.Sessions["claude:s1"]
	if !ok {
		t.Fatalf("missing claude:s1 in %v", body.Sessions)
	}
	if host.PeakAgentBytes == nil || *host.PeakAgentBytes != 612368384 {
		t.Errorf("claude peak_agent_bytes = %v, want 612368384", host.PeakAgentBytes)
	}
	container, ok := body.Sessions["arachne:s1"]
	if !ok {
		t.Fatalf("missing arachne:s1 in %v", body.Sessions)
	}
	if container.PeakTreeBytes == nil || *container.PeakTreeBytes != 8589934592 {
		t.Errorf("arachne peak_tree_bytes = %v, want 8589934592 (not the host's)", container.PeakTreeBytes)
	}
	// A container total has no meaningful inner boundary, so the agent split is
	// absent — and must arrive as an explicit null rather than a dropped key,
	// since 0 bytes is a legal reading the UI has to tell apart from "unknown".
	if container.PeakAgentBytes != nil {
		t.Errorf("arachne peak_agent_bytes = %v, want null", *container.PeakAgentBytes)
	}
	if !strings.Contains(raw, `"peak_agent_bytes":null`) {
		t.Errorf("body should carry an explicit null agent figure, got %s", raw)
	}
	if len(container.Mem) != 1 || container.Mem[0].Agent != nil || container.Mem[0].Tree == nil {
		t.Errorf("container sample = %+v, want a tree-only reading", container.Mem)
	}
}

func TestMemoryShouldNotDoubleTheMachineWidePressureSeries(t *testing.T) {
	// Two providers on one host observe the same physical memory and report the
	// same series. Concatenating them would double the reported stall time and
	// halve the apparent available bytes, so the first provider's series wins.
	srv := &Server{Providers: []provider.Provider{
		provider.NewSubprocessProvider("claude", "Claude", []string{writeMemoryStub(t, memoryFixtureHost)}, "", provider.Capabilities{Memory: true}),
		provider.NewSubprocessProvider("arachne", "Arachne", []string{writeMemoryStub(t, memoryFixtureContainer)}, "", provider.Capabilities{Memory: true}),
	}}

	body, _ := getMemory(t, srv, "?day=2026-06-26")

	if len(body.Pressure) != 2 {
		t.Fatalf("pressure has %d points, want the 2 of a single series: %+v", len(body.Pressure), body.Pressure)
	}
	var stall int64
	for _, p := range body.Pressure {
		if p.PSIStallUS != nil {
			stall += *p.PSIStallUS
		}
	}
	if stall != 96000 {
		t.Errorf("total stall = %dus, want 96000 (summing both providers would give 192000)", stall)
	}
	if body.Pressure[0].TS != "2026-06-26T13:00:00Z" || body.Pressure[1].TS != "2026-06-26T13:20:00Z" {
		t.Errorf("pressure timestamps = %+v, want one ordered series", body.Pressure)
	}
}

func TestMemoryShouldFallBackToALaterProvidersPressureWhenTheFirstHasNone(t *testing.T) {
	// First-provider-wins is about the first NON-EMPTY series: a provider that
	// cannot read pressure must not silence the one that can.
	noPressure := `{"window":"2026-06-26","sessions":[{"session_id":"s1","peak_tree_bytes":1024,"avg_tree_bytes":1024}],"pressure":[]}`
	srv := &Server{Providers: []provider.Provider{
		provider.NewSubprocessProvider("arachne", "Arachne", []string{writeMemoryStub(t, noPressure)}, "", provider.Capabilities{Memory: true}),
		provider.NewSubprocessProvider("claude", "Claude", []string{writeMemoryStub(t, memoryFixtureHost)}, "", provider.Capabilities{Memory: true}),
	}}

	body, _ := getMemory(t, srv, "?day=2026-06-26")

	if len(body.Pressure) != 2 {
		t.Fatalf("pressure = %+v, want the second provider's series", body.Pressure)
	}
}

func TestMemoryShouldServeAnEmptySetWhenTheProviderHasNoMemorySubcommand(t *testing.T) {
	// An older ctl exits non-zero on `memory`. That is an expected state, not an
	// error surface: /api/timeline 502s on a failed provider, this one does not.
	srv := &Server{Ctl: noMemoryStub(t)}

	body, raw := getMemory(t, srv, "?day=2026-06-26")

	if len(body.Sessions) != 0 {
		t.Fatalf("sessions = %v, want empty", body.Sessions)
	}
	if len(body.Pressure) != 0 {
		t.Fatalf("pressure = %v, want empty", body.Pressure)
	}
	if !strings.Contains(raw, `"sessions":{}`) {
		t.Errorf("sessions should be an empty object, not null: %s", raw)
	}
}

func TestMemoryShouldKeepTheOtherProvidersWhenOneHasNoMemorySupport(t *testing.T) {
	srv := &Server{Providers: []provider.Provider{
		provider.NewSubprocessProvider("arachne", "Arachne", []string{noMemoryStub(t)}, "", provider.Capabilities{}),
		provider.NewSubprocessProvider("claude", "Claude", []string{writeMemoryStub(t, memoryFixtureHost)}, "", provider.Capabilities{Memory: true}),
	}}

	body, _ := getMemory(t, srv, "?day=2026-06-26")

	if len(body.Sessions) != 1 {
		t.Fatalf("sessions = %v, want only the provider that answered", body.Sessions)
	}
	if _, ok := body.Sessions["claude:s1"]; !ok {
		t.Errorf("missing claude:s1 in %v", body.Sessions)
	}
	if len(body.Pressure) != 2 {
		t.Errorf("pressure = %+v, want the answering provider's series", body.Pressure)
	}
}

func TestMemoryShouldSurviveAProviderPrintingSomethingUnreadable(t *testing.T) {
	srv := &Server{Providers: []provider.Provider{
		provider.NewSubprocessProvider("broken", "Broken", []string{writeMemoryStub(t, "not json at all")}, "", provider.Capabilities{Memory: true}),
		provider.NewSubprocessProvider("claude", "Claude", []string{writeMemoryStub(t, memoryFixtureHost)}, "", provider.Capabilities{Memory: true}),
	}}

	body, _ := getMemory(t, srv, "?day=2026-06-26")

	if _, ok := body.Sessions["claude:s1"]; !ok {
		t.Fatalf("sessions = %v, want the readable provider kept", body.Sessions)
	}
}

func TestMemoryShouldDropARecordThatCarriesNoSessionId(t *testing.T) {
	// The key IS the lane identity; a record without one cannot enrich anything,
	// and keying it on "" would collide every such record onto one entry.
	doc := `{"window":"2026-06-26","sessions":[{"session_id":"","peak_tree_bytes":1},{"session_id":"s1","peak_tree_bytes":2}],"pressure":[]}`
	srv := &Server{Ctl: writeMemoryStub(t, doc)}

	body, _ := getMemory(t, srv, "?day=2026-06-26")

	if len(body.Sessions) != 1 {
		t.Fatalf("sessions = %v, want only the keyable record", body.Sessions)
	}
	if _, ok := body.Sessions["s1"]; !ok {
		t.Errorf("missing s1 in %v", body.Sessions)
	}
}

func TestMemoryShouldForwardTheRequestedWindowToTheProvider(t *testing.T) {
	argvFile := filepath.Join(t.TempDir(), "argv.txt")
	body := "#!/bin/sh\n: > " + argvFile + "\nfor a in \"$@\"; do printf '%s\\n' \"$a\" >> " + argvFile + "; done\nprintf '%s' '" + memoryFixtureHost + "'\n"
	srv := &Server{Ctl: writeStub(t, body), Dir: "/server/default"}

	getMemory(t, srv, "?day=2026-06-26&since=2026-06-01&until=2026-06-30&dir=/from/query")

	raw, err := os.ReadFile(argvFile)
	if err != nil {
		t.Fatalf("read argv file: %v", err)
	}
	args := strings.Fields(strings.TrimSpace(string(raw)))
	if len(args) == 0 || args[0] != "memory" {
		t.Fatalf("argv = %v, want the memory subcommand first", args)
	}
	if !contains(args, "--json") {
		t.Fatalf("argv = %v, want --json", args)
	}
	// --plan-window is a timeline flag; carrying it over would fail the call.
	if contains(args, "--plan-window") {
		t.Fatalf("argv = %v, should not carry the timeline flags", args)
	}
	mustContainPair(t, args, "--day", "2026-06-26")
	mustContainPair(t, args, "--since", "2026-06-01")
	mustContainPair(t, args, "--until", "2026-06-30")
	mustContainPair(t, args, "--dir", "/from/query")
}

func TestSummariesShouldServeEmptySetWhenStoreMissing(t *testing.T) {
	srv := &Server{SummariesDir: filepath.Join(t.TempDir(), "nonexistent")}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/summaries", nil)
	srv.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 for a missing store", rec.Code)
	}
	var resp struct {
		Sessions map[string]any `json:"sessions"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Sessions) != 0 {
		t.Fatalf("sessions = %v, want empty", resp.Sessions)
	}
}
