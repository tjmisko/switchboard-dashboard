package arachne

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type fakeDocker struct {
	names      [][]string // result per successive ListRunningNames call
	call       int
	inspect    map[string]Container
	inspectErr error
}

func (f *fakeDocker) ListRunningNames(ctx context.Context) ([]string, error) {
	i := f.call
	f.call++
	if i < len(f.names) {
		return f.names[i], nil
	}
	if len(f.names) > 0 {
		return f.names[len(f.names)-1], nil
	}
	return nil, nil
}

func (f *fakeDocker) Inspect(ctx context.Context, name string) (Container, error) {
	if f.inspectErr != nil {
		return Container{}, f.inspectErr
	}
	c, ok := f.inspect[name]
	if !ok {
		return Container{}, fmt.Errorf("no inspect for %s", name)
	}
	return c, nil
}

func TestRecorder_shouldRecordLifecycleSubagentsAndExit(t *testing.T) {
	dir := t.TempDir()
	ws := t.TempDir()
	historyPath := filepath.Join(dir, "history.jsonl")
	statePath := filepath.Join(dir, "state.json")
	logPath := filepath.Join(ws, ".arachne-agent.log")

	fd := &fakeDocker{
		names: [][]string{{"arachne-agent-feat-f71"}, {"arachne-agent-feat-f71"}, {}},
		inspect: map[string]Container{
			"arachne-agent-feat-f71": {
				Name: "arachne-agent-feat-f71", Slug: "feat-f71",
				StartedAt: "2026-07-22T02:00:00Z", Agent: "opus", TaskID: "F71.1",
				Workspace: ws, RepoRoot: "/home/x/Arachne",
			},
		},
	}
	cur := time.Date(2026, 7, 22, 3, 0, 0, 0, time.UTC)
	r := NewRecorder(Config{Docker: fd, HistoryPath: historyPath, StatePath: statePath, Now: func() time.Time { return cur }})
	w, err := OpenWriter(historyPath)
	if err != nil {
		t.Fatalf("open writer: %v", err)
	}
	r.writer = w

	ctx := context.Background()

	// tick 1: new container appears -> session_start
	if err := r.tick(ctx); err != nil {
		t.Fatalf("tick1: %v", err)
	}

	// a Task subagent runs and completes; append it to the container log
	logBody := `Arachne parallel agent started (preamble)
{"type":"assistant","timestamp":"2026-07-22T03:00:02Z","message":{"usage":{"input_tokens":100,"output_tokens":20,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"content":[{"type":"tool_use","id":"toolu_a","name":"Task","input":{"subagent_type":"Explore","description":"map"}}]}}
{"type":"user","timestamp":"2026-07-22T03:00:03Z","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_a"}]}}
`
	if err := os.WriteFile(logPath, []byte(logBody), 0o644); err != nil {
		t.Fatalf("write log: %v", err)
	}

	// tick 2: advance log -> subagent_spawn, subagent_stop, usage_sample
	cur = cur.Add(5 * time.Second)
	if err := r.tick(ctx); err != nil {
		t.Fatalf("tick2: %v", err)
	}

	// tick 3: container gone -> session_end (exited) at last-seen (tick 2's time)
	cur = cur.Add(5 * time.Second)
	if err := r.tick(ctx); err != nil {
		t.Fatalf("tick3: %v", err)
	}
	r.writer.Close()

	events, err := LoadEvents(historyPath)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	var types []string
	for _, e := range events {
		types = append(types, e.Type)
	}
	want := []string{EventSessionStart, EventSubagentSpawn, EventSubagentStop, EventUsageSample, EventSessionEnd}
	if fmt.Sprint(types) != fmt.Sprint(want) {
		t.Fatalf("event sequence = %v, want %v", types, want)
	}

	start := events[0]
	if start.SessionID != "feat-f71" || start.StartedAt != "2026-07-22T02:00:00Z" || start.Project != "Arachne" || start.TaskID != "F71.1" {
		t.Fatalf("session_start metadata wrong: %+v", start)
	}
	end := events[len(events)-1]
	if end.Reason != ReasonExited || end.End != "2026-07-22T03:00:05Z" {
		t.Fatalf("session_end should be exited at last-seen 03:00:05, got %+v", end)
	}

	// The compiled envelope has one ended lane with one subagent.
	tl := Compile(events, CompileOptions{Now: mustTime(t, "2026-07-22T03:10:00Z")})
	if len(tl.Lanes) != 1 || len(tl.Lanes[0].Subagents) != 1 {
		t.Fatalf("compiled lanes/subagents wrong: %+v", tl.Lanes)
	}
	if tl.Lanes[0].End != "2026-07-22T03:00:05Z" {
		t.Fatalf("compiled lane end = %q, want the exit time", tl.Lanes[0].End)
	}
	if tl.Lanes[0].TokIn != 100 || tl.Lanes[0].TokOut != 20 {
		t.Fatalf("compiled usage wrong: %+v", tl.Lanes[0])
	}
}

func TestRecorder_reconcile_shouldInferEndForSessionGoneWhileDown(t *testing.T) {
	dir := t.TempDir()
	historyPath := filepath.Join(dir, "history.jsonl")
	statePath := filepath.Join(dir, "state.json")

	// Seed history with a session that started and never ended (recorder crashed).
	w, err := OpenWriter(historyPath)
	if err != nil {
		t.Fatalf("open writer: %v", err)
	}
	_ = w.Append(Event{Type: EventSessionStart, TS: "2026-07-22T03:00:00Z", SessionID: "feat-f71", StartedAt: "2026-07-22T02:00:00Z", Workspace: "/ws"})
	w.Close()

	// Seed state snapshot with a later last-seen than the last history event.
	stateJSON := `{"updated":"2026-07-22T03:05:00Z","sessions":{"feat-f71":{"last_seen":"2026-07-22T03:05:00Z","log_offset":0,"usage":{}}}}`
	if err := os.WriteFile(statePath, []byte(stateJSON), 0o644); err != nil {
		t.Fatalf("write state: %v", err)
	}

	fd := &fakeDocker{names: [][]string{{}}} // nothing running now
	cur := time.Date(2026, 7, 22, 4, 0, 0, 0, time.UTC)
	r := NewRecorder(Config{Docker: fd, HistoryPath: historyPath, StatePath: statePath, Now: func() time.Time { return cur }})
	w2, err := OpenWriter(historyPath)
	if err != nil {
		t.Fatalf("open writer 2: %v", err)
	}
	r.writer = w2
	if err := r.reconcile(context.Background()); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	w2.Close()

	events, err := LoadEvents(historyPath)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	last := events[len(events)-1]
	if last.Type != EventSessionEnd || last.Reason != ReasonInferred {
		t.Fatalf("expected an inferred session_end, got %+v", last)
	}
	if last.End != "2026-07-22T03:05:00Z" {
		t.Fatalf("inferred end should be last-seen 03:05:00 from state, got %q", last.End)
	}
}
