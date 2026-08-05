package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tjmisko/switchboard-dashboard/internal/flags"
)

// The two-lane defect that motivated flagging, as a provider would emit it: one
// session, a real 19-second lane, and a ghost lane the reader synthesized out to
// the window bound. See internal/flags/overlay_test.go for the full derivation.
const (
	ghostSession   = "296eb0f0-44c5-4406-84a9-04abae0db150"
	realLaneStart  = "2026-08-05T10:29:18.669751036-07:00"
	ghostLaneStart = "2026-08-05T10:29:37.438991459-07:00"
)

const ghostFixtureJSON = `{"window":"2026-08-05","lanes":[` +
	`{"session_id":"` + ghostSession + `","pid":1241937,"project":"screening-overhaul","name":"screening-overhaul-86",` +
	`"start":"` + realLaneStart + `","end":"2026-08-05T10:29:37.437833786-07:00",` +
	`"intervals":[{"status":"working","start":"2026-08-05T10:29:21.338413048-07:00","end":"2026-08-05T10:29:37.437833786-07:00"}]},` +
	`{"session_id":"` + ghostSession + `","pid":1241937,"project":"screening-overhaul",` +
	`"start":"` + ghostLaneStart + `","end":"2026-08-05T13:41:34.680948947-07:00",` +
	`"intervals":[{"status":"idle","start":"` + ghostLaneStart + `","end":"2026-08-05T13:41:34.680948947-07:00"}]}],` +
	`"summary":{"from":"2026-08-05T00:00:00Z","to":"2026-08-05T23:59:59Z","sessions":2,"by_status":{"idle":11517241957488},` +
	`"attention_union":0,"attention_per_session":0,"attention_fanout":0},"totals":{},"unmodeled_field":"must survive"}`

// stubInvestigator returns a fixed verdict (or error) and records that it ran.
type stubInvestigator struct {
	verdict flags.Verdict
	err     error
	calls   chan flags.Record
}

func newStubInvestigator(v flags.Verdict, err error) *stubInvestigator {
	return &stubInvestigator{verdict: v, err: err, calls: make(chan flags.Record, 8)}
}

func (s *stubInvestigator) Investigate(_ context.Context, record flags.Record) (flags.Verdict, error) {
	s.calls <- record
	return s.verdict, s.err
}

func ghostServer(t *testing.T) (*Server, string) {
	t.Helper()
	stub := writeStub(t, "#!/bin/sh\ncat <<'JSONEOF'\n"+ghostFixtureJSON+"\nJSONEOF\n")
	dir := t.TempDir()
	return &Server{Ctl: stub, Flags: flags.NewStore(dir)}, dir
}

func postJSON(t *testing.T, srv *Server, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(raw)))
	req.Header.Set("Content-Type", "application/json")
	srv.Handler().ServeHTTP(rec, req)
	return rec
}

func getTimeline(t *testing.T, srv *Server) (string, map[string]json.RawMessage) {
	t.Helper()
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/timeline?day=2026-08-05", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("timeline status = %d, want 200", rec.Code)
	}
	var parsed map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &parsed); err != nil {
		t.Fatalf("timeline body is not JSON: %v", err)
	}
	return strings.TrimSpace(rec.Body.String()), parsed
}

func laneStarts(t *testing.T, parsed map[string]json.RawMessage) []string {
	t.Helper()
	var lanes []struct {
		Start string `json:"start"`
	}
	if err := json.Unmarshal(parsed["lanes"], &lanes); err != nil {
		t.Fatalf("decode lanes: %v", err)
	}
	starts := make([]string, len(lanes))
	for i, lane := range lanes {
		starts[i] = lane.Start
	}
	return starts
}

func TestTimelineShouldProxyBytesVerbatimWhenNoFlagApplies(t *testing.T) {
	// The single-provider path's byte-verbatim guarantee is what preserves fields
	// the Go structs do not model. It has to survive the flag layer for every
	// window nobody has flagged — which is nearly all of them.
	srv, _ := ghostServer(t)
	body, parsed := getTimeline(t, srv)

	if body != ghostFixtureJSON {
		t.Errorf("body was re-encoded despite no active flag:\n got %s\nwant %s", body, ghostFixtureJSON)
	}
	if _, ok := parsed["unmodeled_field"]; !ok {
		t.Error("a field the structs do not model was dropped")
	}
}

func TestTimelineShouldDropGhostLaneWhenFlagIsApplied(t *testing.T) {
	srv, _ := ghostServer(t)
	srv.Investigator = newStubInvestigator(flags.Verdict{
		Verdict:    "ghost-lane",
		Confidence: "high",
		RootCause:  "session_end precedes the trailing transition; the reader split the lane",
		Action:     flags.Action{Type: flags.ActionSuppress},
	}, nil)

	rec := postJSON(t, srv, "/api/flags", flagRequest{
		SessionID: ghostSession, LaneStart: ghostLaneStart,
		Project: "screening-overhaul", Note: "3h idle, session was seconds",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /api/flags = %d, want 200", rec.Code)
	}
	waitForStatus(t, srv, flags.Key(ghostSession, ghostLaneStart), flags.StatusApplied)

	_, parsed := getTimeline(t, srv)
	starts := laneStarts(t, parsed)
	if len(starts) != 1 || starts[0] != realLaneStart {
		t.Fatalf("lanes = %v, want only the real lane %q", starts, realLaneStart)
	}

	var applied []struct {
		Action    string `json:"action"`
		Verdict   string `json:"verdict"`
		RemovedNS int64  `json:"removed_ns"`
	}
	if err := json.Unmarshal(parsed["flags_applied"], &applied); err != nil {
		t.Fatalf("decode flags_applied: %v", err)
	}
	if len(applied) != 1 || applied[0].Action != "suppress-lane" || applied[0].Verdict != "ghost-lane" {
		t.Fatalf("flags_applied = %+v", applied)
	}
	if applied[0].RemovedNS != 11517241957488 {
		t.Errorf("removed_ns = %d, want 11517241957488", applied[0].RemovedNS)
	}
}

func TestRevertShouldRestoreLaneWhenOperatorWithdrawsTheFlag(t *testing.T) {
	srv, _ := ghostServer(t)
	srv.Investigator = newStubInvestigator(flags.Verdict{
		Verdict: "ghost-lane", Confidence: "high", RootCause: "…",
		Action: flags.Action{Type: flags.ActionSuppress},
	}, nil)

	postJSON(t, srv, "/api/flags", flagRequest{SessionID: ghostSession, LaneStart: ghostLaneStart})
	waitForStatus(t, srv, flags.Key(ghostSession, ghostLaneStart), flags.StatusApplied)
	if _, parsed := getTimeline(t, srv); len(laneStarts(t, parsed)) != 1 {
		t.Fatal("precondition: the ghost lane was not suppressed")
	}

	rec := postJSON(t, srv, "/api/flags/revert", flagRequest{SessionID: ghostSession, LaneStart: ghostLaneStart})
	if rec.Code != http.StatusOK {
		t.Fatalf("revert = %d, want 200", rec.Code)
	}

	body, parsed := getTimeline(t, srv)
	if got := len(laneStarts(t, parsed)); got != 2 {
		t.Fatalf("lanes = %d after revert, want both back", got)
	}
	if body != ghostFixtureJSON {
		t.Error("a fully reverted window is no longer byte-verbatim")
	}
}

func TestFlagShouldNotBeAppliedWhenConfidenceIsBelowHigh(t *testing.T) {
	// A repair nobody is sure of should cost a glance, not a surprise.
	srv, _ := ghostServer(t)
	srv.Investigator = newStubInvestigator(flags.Verdict{
		Verdict: "ghost-lane", Confidence: "medium", RootCause: "maybe",
		Action: flags.Action{Type: flags.ActionSuppress},
	}, nil)

	postJSON(t, srv, "/api/flags", flagRequest{SessionID: ghostSession, LaneStart: ghostLaneStart})
	record := waitForStatus(t, srv, flags.Key(ghostSession, ghostLaneStart), flags.StatusPendingReview)
	if record.Verdict != "ghost-lane" {
		t.Errorf("verdict was lost: %+v", record)
	}
	if _, parsed := getTimeline(t, srv); len(laneStarts(t, parsed)) != 2 {
		t.Error("an unreviewed verdict changed the rendered lanes")
	}
}

func TestFlagShouldFailClosedWhenVerdictIsOutsideTheClosedEnum(t *testing.T) {
	// The agent's output is the only channel it has to affect anything, so an
	// unrecognized action must be refused rather than coerced into a known one.
	srv, _ := ghostServer(t)
	srv.Investigator = newStubInvestigator(flags.Verdict{
		Verdict: "ghost-lane", Confidence: "high",
		Action: flags.Action{Type: flags.ActionType("delete-everything")},
	}, nil)

	postJSON(t, srv, "/api/flags", flagRequest{SessionID: ghostSession, LaneStart: ghostLaneStart})
	record := waitForStatus(t, srv, flags.Key(ghostSession, ghostLaneStart), flags.StatusFailed)
	if !strings.Contains(record.Agent.Error, "delete-everything") {
		t.Errorf("failure did not name the rejected action: %q", record.Agent.Error)
	}
	if _, parsed := getTimeline(t, srv); len(laneStarts(t, parsed)) != 2 {
		t.Error("a rejected verdict still changed the rendered lanes")
	}
}

func TestFlagShouldKeepTheFlagWhenInvestigationErrors(t *testing.T) {
	// The operator's judgement that something is wrong outlives the agent's
	// failure to explain it.
	srv, _ := ghostServer(t)
	srv.Investigator = newStubInvestigator(flags.Verdict{}, errors.New("claude -p: exit status 1"))

	postJSON(t, srv, "/api/flags", flagRequest{SessionID: ghostSession, LaneStart: ghostLaneStart, Note: "looks wrong"})
	record := waitForStatus(t, srv, flags.Key(ghostSession, ghostLaneStart), flags.StatusFailed)
	if record.Note != "looks wrong" {
		t.Errorf("the operator's note was lost: %+v", record)
	}
	if record.Agent == nil || !strings.Contains(record.Agent.Error, "exit status 1") {
		t.Errorf("the failure reason was not kept: %+v", record.Agent)
	}
}

func TestFlagShouldBeIdempotentWhileInvestigationIsInFlight(t *testing.T) {
	// A double-click must not buy a second agent on the same question.
	srv, _ := ghostServer(t)
	blocked := make(chan struct{})
	srv.Investigator = investigatorFunc(func(ctx context.Context, r flags.Record) (flags.Verdict, error) {
		<-blocked
		return flags.Verdict{Verdict: "correct-data", Confidence: "high", Action: flags.Action{Type: flags.ActionNone}}, nil
	})

	req := flagRequest{SessionID: ghostSession, LaneStart: ghostLaneStart}
	for i := range 3 {
		if rec := postJSON(t, srv, "/api/flags", req); rec.Code != http.StatusOK {
			t.Fatalf("POST %d = %d, want 200", i, rec.Code)
		}
	}
	close(blocked)

	waitForStatus(t, srv, flags.Key(ghostSession, ghostLaneStart), flags.StatusApplied)
	list, err := srv.Flags.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 1 {
		t.Errorf("three POSTs produced %d records, want 1", len(list))
	}
}

func TestFlagEndpointsShould404WhenStoreIsDisabled(t *testing.T) {
	stub := writeStub(t, "#!/bin/sh\ncat <<'JSONEOF'\n"+ghostFixtureJSON+"\nJSONEOF\n")
	srv := &Server{Ctl: stub, Flags: flags.NewStore("")}

	for _, path := range []string{"/api/flags", "/api/flags/revert"} {
		if rec := postJSON(t, srv, path, flagRequest{LaneStart: ghostLaneStart}); rec.Code != http.StatusNotFound {
			t.Errorf("POST %s = %d, want 404", path, rec.Code)
		}
	}

	// The read stays a 200 empty set: the frontend asks unconditionally, and an
	// unconfigured dashboard has no flags rather than an error.
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/flags", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/flags = %d, want 200", rec.Code)
	}
	var body flagsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Flags) != 0 {
		t.Errorf("flags = %v, want empty", body.Flags)
	}
}

func TestFlagShouldRejectPostWhenRequestIsCrossOrigin(t *testing.T) {
	// Loopback binding keeps the network out; this keeps a stray browser tab out.
	srv, _ := ghostServer(t)
	cases := []struct {
		name    string
		headers map[string]string
		want    int
	}{
		{"same-origin fetch", map[string]string{"Sec-Fetch-Site": "same-origin"}, http.StatusOK},
		{"typed into the address bar", map[string]string{"Sec-Fetch-Site": "none"}, http.StatusOK},
		{"another site", map[string]string{"Sec-Fetch-Site": "cross-site"}, http.StatusForbidden},
		{"another port on localhost", map[string]string{"Sec-Fetch-Site": "same-site"}, http.StatusForbidden},
		{"legacy browser, foreign origin", map[string]string{"Origin": "http://evil.example"}, http.StatusForbidden},
		{"no browser headers at all (curl)", nil, http.StatusOK},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw, _ := json.Marshal(flagRequest{SessionID: ghostSession, LaneStart: ghostLaneStart})
			req := httptest.NewRequest(http.MethodPost, "/api/flags", strings.NewReader(string(raw)))
			for k, v := range tc.headers {
				req.Header.Set(k, v)
			}
			rec := httptest.NewRecorder()
			srv.Handler().ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Errorf("status = %d, want %d", rec.Code, tc.want)
			}
		})
	}
}

func TestFlagShouldRejectRequestWhenLaneStartIsMissing(t *testing.T) {
	srv, _ := ghostServer(t)
	if rec := postJSON(t, srv, "/api/flags", flagRequest{SessionID: ghostSession}); rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestIssueLogShouldRecordFlagAndVerdictWhenInvestigationCompletes(t *testing.T) {
	srv, dir := ghostServer(t)
	srv.Investigator = newStubInvestigator(flags.Verdict{
		Verdict: "ghost-lane", Confidence: "high",
		RootCause: "session_end precedes the trailing transition by 1.16ms",
		Evidence:  []string{"10:29:37.437833786 session_end", "10:29:37.438991459 transition"},
		Action:    flags.Action{Type: flags.ActionSuppress},
		Upstream:  &flags.Upstream{Repo: "switchboard", Title: "reader splits a lane on an out-of-order session_end"},
	}, nil)

	postJSON(t, srv, "/api/flags", flagRequest{SessionID: ghostSession, LaneStart: ghostLaneStart, Note: "bad data"})
	waitForStatus(t, srv, flags.Key(ghostSession, ghostLaneStart), flags.StatusApplied)

	entries := readIssueLog(t, dir)
	if len(entries) != 2 {
		t.Fatalf("issue log holds %d entries, want flagged + resolved: %+v", len(entries), entries)
	}
	if entries[0].Event != "flagged" || entries[0].Note != "bad data" {
		t.Errorf("first entry = %+v", entries[0])
	}
	resolved := entries[1]
	if resolved.Event != "resolved" || resolved.Verdict != "ghost-lane" {
		t.Errorf("second entry = %+v", resolved)
	}
	if len(resolved.Evidence) != 2 {
		t.Errorf("evidence was not carried into the log: %+v", resolved.Evidence)
	}
	if resolved.Upstream == nil || resolved.Upstream.Repo != "switchboard" {
		t.Errorf("upstream draft was not carried into the log: %+v", resolved.Upstream)
	}
}

// investigatorFunc adapts a function to the Investigator interface.
type investigatorFunc func(context.Context, flags.Record) (flags.Verdict, error)

func (f investigatorFunc) Investigate(ctx context.Context, r flags.Record) (flags.Verdict, error) {
	return f(ctx, r)
}

// waitForStatus polls the store until the flag reaches want. The investigation
// runs on its own goroutine, deliberately detached from the request, so the POST
// returning is not the signal that it has finished.
func waitForStatus(t *testing.T, srv *Server, key string, want flags.Status) flags.Record {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	var last flags.Record
	for time.Now().Before(deadline) {
		record, ok, err := srv.Flags.Get(key)
		if err == nil && ok {
			last = record
			if record.Status == want {
				return record
			}
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("flag %s never reached %q (last status %q)", key, want, last.Status)
	return last
}

func readIssueLog(t *testing.T, dir string) []flags.IssueEntry {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dir, "issues.jsonl"))
	if err != nil {
		t.Fatalf("read issue log: %v", err)
	}
	var entries []flags.IssueEntry
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		if line == "" {
			continue
		}
		var entry flags.IssueEntry
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			t.Fatalf("issue log line is not JSON: %v", err)
		}
		entries = append(entries, entry)
	}
	return entries
}
