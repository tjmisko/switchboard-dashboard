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
	running    [][]Running // result per successive ListRunning call
	call       int
	inspect    map[string]Container
	inspectSeq map[string][]Container // successive Inspect results per name
	inspectErr error
}

func (f *fakeDocker) ListRunning(ctx context.Context) ([]Running, error) {
	i := f.call
	f.call++
	if i < len(f.running) {
		return f.running[i], nil
	}
	if len(f.running) > 0 {
		return f.running[len(f.running)-1], nil
	}
	return nil, nil
}

// up is one running container for the fake's ListRunning script.
func up(name, id string) Running { return Running{Name: name, ID: id} }

func (f *fakeDocker) Inspect(ctx context.Context, name string) (Container, error) {
	if f.inspectErr != nil {
		return Container{}, f.inspectErr
	}
	// A name outlives the container wearing it, so inspecting the same name
	// twice may legitimately describe two different containers.
	if seq := f.inspectSeq[name]; len(seq) > 0 {
		if len(seq) > 1 {
			f.inspectSeq[name] = seq[1:]
		}
		return seq[0], nil
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
		running: [][]Running{{up("arachne-agent-feat-f71", "c1")}, {up("arachne-agent-feat-f71", "c1")}, {}},
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

	fd := &fakeDocker{running: [][]Running{{}}} // nothing running now
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

// The pump restarts arachne-agent-<slug> for the next phase task, so the name
// outlives the container. Watching names alone, this tick sees "still running":
// the two runs fuse into one endless session, and the new container's freshly
// truncated log gets read at the dead one's offset. The container id is the only
// thing that says otherwise.
func TestRecorder_shouldRecordARestartUnderTheSameNameAsTwoSessions(t *testing.T) {
	dir := t.TempDir()
	ws := t.TempDir()
	historyPath := filepath.Join(dir, "history.jsonl")
	statePath := filepath.Join(dir, "state.json")

	fd := &fakeDocker{
		running: [][]Running{
			{up("arachne-agent-feat-f79", "c1")},
			{up("arachne-agent-feat-f79", "c2")}, // same name, new container
			{},
		},
		inspectSeq: map[string][]Container{
			"arachne-agent-feat-f79": {
				{Name: "arachne-agent-feat-f79", Slug: "feat-f79", StartedAt: "2026-08-04T16:21:31Z", TaskID: "F79.2", Agent: "opus", Workspace: ws, RepoRoot: "/home/x/Arachne"},
				{Name: "arachne-agent-feat-f79", Slug: "feat-f79", StartedAt: "2026-08-04T18:00:43Z", TaskID: "F79.6", Agent: "opus", Workspace: ws, RepoRoot: "/home/x/Arachne"},
			},
		},
	}
	cur := mustTime(t, "2026-08-04T18:00:00Z")
	r := NewRecorder(Config{Docker: fd, HistoryPath: historyPath, StatePath: statePath, Now: func() time.Time { return cur }})
	w, err := OpenWriter(historyPath)
	if err != nil {
		t.Fatalf("open writer: %v", err)
	}
	r.writer = w

	ctx := context.Background()
	for _, tick := range []string{"first run", "restart", "gone"} {
		if err := r.tick(ctx); err != nil {
			t.Fatalf("tick (%s): %v", tick, err)
		}
		cur = cur.Add(5 * time.Second)
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
	want := []string{EventSessionStart, EventSessionEnd, EventSessionStart, EventSessionEnd}
	if fmt.Sprint(types) != fmt.Sprint(want) {
		t.Fatalf("event sequence = %v, want %v", types, want)
	}
	// The old run closes at the last tick that saw it alive, never at the new
	// one's start: the seconds between belong to neither container.
	if events[1].End != "2026-08-04T18:00:00Z" || events[1].Reason != ReasonExited {
		t.Errorf("first run should close at its last-seen 18:00:00Z, got %+v", events[1])
	}
	if events[2].StartedAt != "2026-08-04T18:00:43Z" || events[2].TaskID != "F79.6" {
		t.Errorf("second run should carry the NEW container's metadata, got %+v", events[2])
	}

	// And the compiler draws what the recorder wrote: two runs, not one.
	tl := Compile(events, CompileOptions{Now: mustTime(t, "2026-08-04T18:30:00Z")})
	if len(tl.Lanes) != 2 {
		t.Fatalf("compiled lanes = %d, want 2: %+v", len(tl.Lanes), tl.Lanes)
	}
	if tl.Lanes[0].SessionID != "feat-f79" || tl.Lanes[1].SessionID != "feat-f79#2" {
		t.Errorf("compiled ids = %q, %q; want the slug then #2", tl.Lanes[0].SessionID, tl.Lanes[1].SessionID)
	}
}

// The same restart, across a recorder outage. History has the old run open,
// docker has a container of that name running, and only the id in the state
// snapshot says they are not the same container.
func TestRecorder_reconcile_shouldCloseASessionWhoseContainerRestartedWhileDown(t *testing.T) {
	dir := t.TempDir()
	historyPath := filepath.Join(dir, "history.jsonl")
	statePath := filepath.Join(dir, "state.json")

	w, err := OpenWriter(historyPath)
	if err != nil {
		t.Fatalf("open writer: %v", err)
	}
	_ = w.Append(Event{Type: EventSessionStart, TS: "2026-08-04T16:21:32Z", SessionID: "feat-f79", StartedAt: "2026-08-04T16:21:31Z", Workspace: "/ws"})
	w.Close()

	stateJSON := `{"updated":"2026-08-04T17:59:00Z","sessions":{"feat-f79":{"last_seen":"2026-08-04T17:59:00Z","container_id":"c1","log_offset":42,"usage":{}}}}`
	if err := os.WriteFile(statePath, []byte(stateJSON), 0o644); err != nil {
		t.Fatalf("write state: %v", err)
	}

	fd := &fakeDocker{running: [][]Running{{up("arachne-agent-feat-f79", "c2")}}} // same name, new container
	cur := mustTime(t, "2026-08-04T18:05:00Z")
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
	if last.Type != EventSessionEnd || last.Reason != ReasonInferred || last.End != "2026-08-04T17:59:00Z" {
		t.Fatalf("the run we had open should close at its last-seen, got %+v", last)
	}
	if _, resumed := r.live["feat-f79"]; resumed {
		t.Error("the new container must be left to the first tick, not resumed onto the run we just closed")
	}
}

// The guard against the opposite mistake: an unchanged container is the same
// session it always was, and ending it would lose a live run for nothing.
func TestRecorder_reconcile_shouldResumeASessionWhoseContainerIsUnchanged(t *testing.T) {
	dir := t.TempDir()
	historyPath := filepath.Join(dir, "history.jsonl")
	statePath := filepath.Join(dir, "state.json")

	w, err := OpenWriter(historyPath)
	if err != nil {
		t.Fatalf("open writer: %v", err)
	}
	_ = w.Append(Event{Type: EventSessionStart, TS: "2026-08-04T16:21:32Z", SessionID: "feat-f79", StartedAt: "2026-08-04T16:21:31Z", Workspace: "/ws"})
	w.Close()

	stateJSON := `{"updated":"2026-08-04T17:59:00Z","sessions":{"feat-f79":{"last_seen":"2026-08-04T17:59:00Z","container_id":"c1","log_offset":42,"usage":{}}}}`
	if err := os.WriteFile(statePath, []byte(stateJSON), 0o644); err != nil {
		t.Fatalf("write state: %v", err)
	}

	fd := &fakeDocker{
		running: [][]Running{{up("arachne-agent-feat-f79", "c1")}},
		inspect: map[string]Container{
			"arachne-agent-feat-f79": {Name: "arachne-agent-feat-f79", Slug: "feat-f79", StartedAt: "2026-08-04T16:21:31Z", Workspace: "/ws"},
		},
	}
	cur := mustTime(t, "2026-08-04T18:05:00Z")
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
	if len(events) != 1 {
		t.Fatalf("a resumed session should write no events, got %+v", events[1:])
	}
	ls, resumed := r.live["feat-f79"]
	if !resumed {
		t.Fatal("an unchanged container should be resumed, not dropped")
	}
	if ls.logOffset != 42 || ls.containerID != "c1" {
		t.Errorf("resumed at offset %d id %q, want 42 and c1", ls.logOffset, ls.containerID)
	}
}
