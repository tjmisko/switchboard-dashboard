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
)

const fixtureJSON = `{"window":"2026-06-20","lanes":null,"summary":{"from":"2026-06-20T09:00:00Z","to":"2026-06-20T09:48:00Z","sessions":0,"by_status":{},"attention_union":0,"attention_per_session":0,"attention_fanout":0},"totals":{"tok_in":1,"tok_out":2,"tok_cache_read":3,"tok_cache_create":4,"subagents":0}}`

func TestArgvFor_mapsParamsToFlags(t *testing.T) {
	tests := []struct {
		name string
		ctl  string
		in   TimelineParams
		want []string
	}{
		{
			name: "should emit base argv with plan-window when no params set",
			ctl:  "switchboard-ctl",
			in:   TimelineParams{},
			want: []string{"switchboard-ctl", "timeline", "--json", "--plan-window"},
		},
		{
			name: "should forward day and dir when set",
			ctl:  "/usr/bin/ctl",
			in:   TimelineParams{Day: "2026-06-20", Dir: "/var/hist"},
			want: []string{"/usr/bin/ctl", "timeline", "--json", "--plan-window", "--dir", "/var/hist", "--day", "2026-06-20"},
		},
		{
			name: "should forward a since/until range",
			ctl:  "ctl",
			in:   TimelineParams{Since: "2026-06-20", Until: "2026-06-26"},
			want: []string{"ctl", "timeline", "--json", "--plan-window", "--since", "2026-06-20", "--until", "2026-06-26"},
		},
		{
			name: "should forward every flag together",
			ctl:  "ctl",
			in:   TimelineParams{Day: "2026-06-20", Since: "2026-06-01", Until: "2026-06-30", Dir: "/d"},
			want: []string{"ctl", "timeline", "--json", "--plan-window", "--dir", "/d", "--day", "2026-06-20", "--since", "2026-06-01", "--until", "2026-06-30"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := argvFor(tc.ctl, tc.in)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("argvFor() = %v, want %v", got, tc.want)
			}
		})
	}
}

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
