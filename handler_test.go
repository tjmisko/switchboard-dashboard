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
	slugDir := filepath.Join(dir, slug)
	if err := os.MkdirAll(slugDir, 0o755); err != nil {
		t.Fatal(err)
	}
	body := `{"digest":{"sessionId":"` + id + `"}`
	if summaryJSON != "" {
		body += `,"summary":` + summaryJSON + `,"generatedAt":"2026-07-31T22:00:00Z"`
	}
	body += `}`
	if err := os.WriteFile(filepath.Join(slugDir, id+".json"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestSummariesShouldServeGeneratedRecordsAndOmitDigestOnlyOnes(t *testing.T) {
	dir := t.TempDir()
	writeSummaryRecord(t, dir, "-home-u-proj", "sess-summarized",
		`{"name":"fix-flaky-test","description":"Fixed the flaky auth test","summary":"The session fixed a race."}`)
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
