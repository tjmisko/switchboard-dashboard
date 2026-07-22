package arachne

import (
	"bytes"
	"strings"
	"testing"
)

func TestWriteReadEvents_shouldRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	in := []Event{
		{Type: EventSessionStart, TS: "2026-07-22T03:00:00Z", SessionID: "feat-f71", StartedAt: "2026-07-22T02:00:00Z", Agent: "opus", TaskID: "F71.1"},
		{Type: EventSubagentSpawn, TS: "2026-07-22T03:01:00Z", SessionID: "feat-f71", ToolUseID: "toolu_1", AgentType: "Explore"},
	}
	for _, e := range in {
		if err := WriteEvent(&buf, e); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	got, err := ReadEvents(&buf)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(got) != 2 || got[0].SessionID != "feat-f71" || got[0].StartedAt != "2026-07-22T02:00:00Z" || got[1].ToolUseID != "toolu_1" {
		t.Fatalf("round trip mismatch: %+v", got)
	}
}

func TestReadEvents_shouldTolerateTornFinalLine(t *testing.T) {
	data := `{"type":"session_start","ts":"t","session_id":"a"}
{"type":"session_end","ts":"t2","session_id":"a","end":"t2"}
{"type":"session_start","ts":"t3` // torn write from a crash mid-append
	got, err := ReadEvents(strings.NewReader(data))
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 valid events (torn line dropped), got %d: %+v", len(got), got)
	}
}

func TestReconstruct_shouldReturnOpenSessionsWithOpenSubagents(t *testing.T) {
	events := []Event{
		{Type: EventSessionStart, TS: "t0", SessionID: "a"},
		{Type: EventSessionStart, TS: "t0", SessionID: "b"},
		{Type: EventSubagentSpawn, TS: "t1", SessionID: "a", ToolUseID: "s1", AgentType: "Explore"},
		{Type: EventSubagentSpawn, TS: "t2", SessionID: "a", ToolUseID: "s2"},
		{Type: EventSubagentStop, TS: "t3", SessionID: "a", ToolUseID: "s2"},
		{Type: EventSessionEnd, TS: "t4", SessionID: "b", End: "t4"},
	}
	open := Reconstruct(events)
	if len(open) != 1 {
		t.Fatalf("expected only session a open, got %d", len(open))
	}
	a := open["a"]
	if a == nil {
		t.Fatalf("session a should be open")
	}
	if len(a.OpenSubagents) != 1 {
		t.Fatalf("a should have 1 open subagent (s2 closed), got %d", len(a.OpenSubagents))
	}
	if _, ok := a.OpenSubagents["s1"]; !ok {
		t.Fatalf("s1 should still be open")
	}
	if a.LastTS != "t3" {
		t.Fatalf("LastTS = %q, want t3 (a's latest event)", a.LastTS)
	}
}
