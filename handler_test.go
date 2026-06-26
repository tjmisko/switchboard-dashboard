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
			name: "should emit only base argv when no params set",
			ctl:  "switchboard-ctl",
			in:   TimelineParams{},
			want: []string{"switchboard-ctl", "timeline", "--json"},
		},
		{
			name: "should forward day and dir when set",
			ctl:  "/usr/bin/ctl",
			in:   TimelineParams{Day: "2026-06-20", Dir: "/var/hist"},
			want: []string{"/usr/bin/ctl", "timeline", "--json", "--dir", "/var/hist", "--day", "2026-06-20"},
		},
		{
			name: "should forward a since/until range",
			ctl:  "ctl",
			in:   TimelineParams{Since: "2026-06-20", Until: "2026-06-26"},
			want: []string{"ctl", "timeline", "--json", "--since", "2026-06-20", "--until", "2026-06-26"},
		},
		{
			name: "should forward every flag together",
			ctl:  "ctl",
			in:   TimelineParams{Day: "2026-06-20", Since: "2026-06-01", Until: "2026-06-30", Dir: "/d"},
			want: []string{"ctl", "timeline", "--json", "--dir", "/d", "--day", "2026-06-20", "--since", "2026-06-01", "--until", "2026-06-30"},
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
