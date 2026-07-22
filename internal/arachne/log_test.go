package arachne

import "testing"

func TestScanLog_shouldExtractTaskSpawnsResultsAndUsageSkippingPreamble(t *testing.T) {
	chunk := []byte(`Arachne parallel agent started at ... (preamble, not JSON)
{"type":"assistant","timestamp":"2026-07-22T03:00:00Z","message":{"usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":100,"cache_creation_input_tokens":2},"content":[{"type":"tool_use","id":"toolu_1","name":"Task","input":{"subagent_type":"Explore","description":"map the repo"}}]}}
{"type":"user","timestamp":"2026-07-22T03:05:00Z","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","is_error":false,"content":"done"}]}}
{"type":"assistant","timestamp":"2026-07-22T03:06:00Z","message":{"usage":{"input_tokens":3,"output_tokens":7},"content":[{"type":"tool_use","id":"toolu_bash","name":"Bash","input":{"command":"ls"}}]}}
`)
	got := ScanLog(chunk)
	if len(got.Spawns) != 1 {
		t.Fatalf("spawns = %d, want 1 (Bash must not count): %+v", len(got.Spawns), got.Spawns)
	}
	sp := got.Spawns[0]
	if sp.ToolUseID != "toolu_1" || sp.AgentType != "Explore" || sp.Description != "map the repo" || sp.TS != "2026-07-22T03:00:00Z" {
		t.Fatalf("spawn wrong: %+v", sp)
	}
	if len(got.Results) != 1 || got.Results[0].ToolUseID != "toolu_1" || got.Results[0].TS != "2026-07-22T03:05:00Z" {
		t.Fatalf("results wrong: %+v", got.Results)
	}
	if got.Usage.TokIn != 13 || got.Usage.TokOut != 12 || got.Usage.TokCacheRead != 100 || got.Usage.TokCacheCreate != 2 {
		t.Fatalf("usage summed wrong: %+v", got.Usage)
	}
	if got.Consumed != len(chunk) {
		t.Fatalf("consumed = %d, want %d (all lines newline-terminated)", got.Consumed, len(chunk))
	}
}

func TestScanLog_shouldLeaveTrailingPartialLineUnconsumed(t *testing.T) {
	chunk := []byte(`{"type":"user","timestamp":"t1","message":{"content":[{"type":"tool_result","tool_use_id":"a"}]}}
{"type":"assistant","timestamp":"t2","message":{"content":[{"type":"tool_use","id":"toolu_x","name":"Task","input":{"subagent_type":"g"}}]}`) // no trailing newline
	got := ScanLog(chunk)
	if len(got.Results) != 1 {
		t.Fatalf("results = %d, want 1 (only the complete line)", len(got.Results))
	}
	if len(got.Spawns) != 0 {
		t.Fatalf("partial trailing line must not be parsed, got spawns %+v", got.Spawns)
	}
	firstLineLen := 0
	for i, b := range chunk {
		if b == '\n' {
			firstLineLen = i + 1
			break
		}
	}
	if got.Consumed != firstLineLen {
		t.Fatalf("consumed = %d, want %d (stop at last newline)", got.Consumed, firstLineLen)
	}
}
