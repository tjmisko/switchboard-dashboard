package arachne

import (
	"testing"
	"time"
)

func mustTime(t *testing.T, s string) time.Time {
	t.Helper()
	tm, err := time.Parse(time.RFC3339, s)
	if err != nil {
		t.Fatalf("parse %q: %v", s, err)
	}
	return tm
}

func TestCompile_shouldBuildLaneWithWorkingIntervalForClosedSession(t *testing.T) {
	events := []Event{
		{Type: EventSessionStart, TS: "2026-07-22T10:00:00Z", SessionID: "feat-f71", StartedAt: "2026-07-22T10:00:00Z", Agent: "opus", TaskID: "F71.1", Project: "Arachne", ProjectFull: "Arachne"},
		{Type: EventSessionEnd, TS: "2026-07-22T10:30:00Z", SessionID: "feat-f71", End: "2026-07-22T10:30:00Z", Reason: ReasonExited},
	}
	tl := Compile(events, CompileOptions{Now: mustTime(t, "2026-07-22T11:00:00Z"), Window: "2026-07-22"})
	if len(tl.Lanes) != 1 {
		t.Fatalf("lanes = %d, want 1", len(tl.Lanes))
	}
	l := tl.Lanes[0]
	if l.SessionID != "feat-f71" || l.Agent != "opus" || l.Provider != "arachne" {
		t.Fatalf("lane metadata wrong: %+v", l)
	}
	if l.Start != "2026-07-22T10:00:00Z" || l.End != "2026-07-22T10:30:00Z" {
		t.Fatalf("lane bounds wrong: start=%q end=%q", l.Start, l.End)
	}
	if len(l.Intervals) != 1 || l.Intervals[0].Status != "working" {
		t.Fatalf("expected a single working interval, got %+v", l.Intervals)
	}
	if l.Name != "F71.1" || len(l.Names) != 1 || l.Names[0].Label != "F71.1" {
		t.Fatalf("task label not set: name=%q names=%+v", l.Name, l.Names)
	}
	if tl.Summary.Sessions != 1 || tl.Summary.ByStatus["working"] != 1800000000000 {
		t.Fatalf("summary wrong: %+v", tl.Summary)
	}
	if tl.Summary.From != "2026-07-22T10:00:00Z" || tl.Summary.To != "2026-07-22T10:30:00Z" {
		t.Fatalf("from/to wrong: %+v", tl.Summary)
	}
}

func TestCompile_shouldEndOpenSessionAtNow(t *testing.T) {
	events := []Event{
		{Type: EventSessionStart, TS: "2026-07-22T10:00:00Z", SessionID: "feat-f71", StartedAt: "2026-07-22T10:00:00Z"},
	}
	tl := Compile(events, CompileOptions{Now: mustTime(t, "2026-07-22T10:20:00Z")})
	if tl.Lanes[0].End != "2026-07-22T10:20:00Z" {
		t.Fatalf("open session should end at now, got %q", tl.Lanes[0].End)
	}
	if tl.Summary.ByStatus["working"] != 1200000000000 {
		t.Fatalf("working ns = %d, want 1.2e12", tl.Summary.ByStatus["working"])
	}
}

func TestCompile_shouldRecomputeAttentionUnionAcrossOverlappingSessions(t *testing.T) {
	events := []Event{
		{Type: EventSessionStart, TS: "a", SessionID: "x", StartedAt: "2026-07-22T10:00:00Z"},
		{Type: EventSessionEnd, TS: "b", SessionID: "x", End: "2026-07-22T10:30:00Z"},
		{Type: EventSessionStart, TS: "c", SessionID: "y", StartedAt: "2026-07-22T10:15:00Z"},
		{Type: EventSessionEnd, TS: "d", SessionID: "y", End: "2026-07-22T10:45:00Z"},
	}
	tl := Compile(events, CompileOptions{Now: mustTime(t, "2026-07-22T11:00:00Z")})
	if tl.Summary.AttentionUnion != 2700000000000 {
		t.Fatalf("attention_union = %d, want 2.7e12 (45min union)", tl.Summary.AttentionUnion)
	}
	if tl.Summary.AttentionPerSession != 3600000000000 {
		t.Fatalf("attention_per_session = %d, want 3.6e12 (60min sum)", tl.Summary.AttentionPerSession)
	}
}

func TestCompile_shouldIncludeSubagentsInLaneFanoutAndTotals(t *testing.T) {
	events := []Event{
		{Type: EventSessionStart, TS: "a", SessionID: "x", StartedAt: "2026-07-22T10:00:00Z"},
		{Type: EventSubagentSpawn, TS: "2026-07-22T10:05:00Z", SessionID: "x", ToolUseID: "s1", AgentType: "Explore", Description: "d"},
		{Type: EventSubagentStop, TS: "2026-07-22T10:15:00Z", SessionID: "x", ToolUseID: "s1"},
		{Type: EventSessionEnd, TS: "z", SessionID: "x", End: "2026-07-22T10:30:00Z"},
	}
	tl := Compile(events, CompileOptions{Now: mustTime(t, "2026-07-22T11:00:00Z")})
	l := tl.Lanes[0]
	if len(l.Subagents) != 1 || l.Subagents[0].ToolUseID != "s1" || l.Subagents[0].Start != "2026-07-22T10:05:00Z" || l.Subagents[0].End != "2026-07-22T10:15:00Z" {
		t.Fatalf("subagent wrong: %+v", l.Subagents)
	}
	if tl.Totals.Subagents != 1 {
		t.Fatalf("totals.subagents = %d, want 1", tl.Totals.Subagents)
	}
	if tl.Summary.AttentionFanout != 2400000000000 {
		t.Fatalf("fanout = %d, want 2.4e12 (30min work + 10min subagent)", tl.Summary.AttentionFanout)
	}
}

func TestCompile_shouldEndOpenSubagentAtNow(t *testing.T) {
	events := []Event{
		{Type: EventSessionStart, TS: "a", SessionID: "x", StartedAt: "2026-07-22T10:00:00Z"},
		{Type: EventSubagentSpawn, TS: "2026-07-22T10:05:00Z", SessionID: "x", ToolUseID: "s1", AgentType: "Explore"},
	}
	tl := Compile(events, CompileOptions{Now: mustTime(t, "2026-07-22T10:20:00Z")})
	if tl.Lanes[0].Subagents[0].End != "2026-07-22T10:20:00Z" {
		t.Fatalf("open subagent should end at now, got %q", tl.Lanes[0].Subagents[0].End)
	}
}

func TestCompile_shouldExcludeSessionsOutsideWindow(t *testing.T) {
	events := []Event{
		{Type: EventSessionStart, TS: "a", SessionID: "old", StartedAt: "2026-07-20T10:00:00Z"},
		{Type: EventSessionEnd, TS: "b", SessionID: "old", End: "2026-07-20T10:30:00Z"},
		{Type: EventSessionStart, TS: "c", SessionID: "new", StartedAt: "2026-07-22T10:00:00Z"},
		{Type: EventSessionEnd, TS: "d", SessionID: "new", End: "2026-07-22T10:30:00Z"},
	}
	tl := Compile(events, CompileOptions{
		Now:   mustTime(t, "2026-07-22T11:00:00Z"),
		Since: mustTime(t, "2026-07-22T00:00:00Z"),
		Until: mustTime(t, "2026-07-23T00:00:00Z"),
	})
	if len(tl.Lanes) != 1 || tl.Lanes[0].SessionID != "new" {
		t.Fatalf("windowing wrong, want only 'new': %+v", tl.Lanes)
	}
}

func TestCompile_shouldCarryUsageIntoLaneAndTotals(t *testing.T) {
	events := []Event{
		{Type: EventSessionStart, TS: "a", SessionID: "x", StartedAt: "2026-07-22T10:00:00Z"},
		{Type: EventUsageSample, TS: "2026-07-22T10:10:00Z", SessionID: "x", TokIn: 1000, TokOut: 200, TokCacheRead: 5000, TokCacheCreate: 50},
		{Type: EventSessionEnd, TS: "z", SessionID: "x", End: "2026-07-22T10:30:00Z"},
	}
	tl := Compile(events, CompileOptions{Now: mustTime(t, "2026-07-22T11:00:00Z")})
	l := tl.Lanes[0]
	if l.TokIn != 1000 || l.TokOut != 200 || l.TokCacheRead != 5000 || l.TokCacheCreate != 50 {
		t.Fatalf("lane usage wrong: %+v", l)
	}
	if tl.Totals.TokIn != 1000 || tl.Totals.TokOut != 200 {
		t.Fatalf("totals wrong: %+v", tl.Totals)
	}
}

func TestCompile_shouldDropSessionsWithoutAStart(t *testing.T) {
	events := []Event{
		{Type: EventSubagentSpawn, TS: "a", SessionID: "ghost", ToolUseID: "s1"},
		{Type: EventSessionEnd, TS: "b", SessionID: "ghost", End: "2026-07-22T10:30:00Z"},
	}
	tl := Compile(events, CompileOptions{Now: mustTime(t, "2026-07-22T11:00:00Z")})
	if len(tl.Lanes) != 0 {
		t.Fatalf("a session we never saw start for should be dropped, got %+v", tl.Lanes)
	}
}
