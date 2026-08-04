package arachne

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

// memHarness is a recorder wired to a fake docker and a fixture cgroup tree,
// with the fixture files rewritable so a test can move memory over time.
type memHarness struct {
	t       *testing.T
	rec     *Recorder
	scope   string
	history string
	now     time.Time
	fd      *fakeDocker
}

const memProbeID = "aa11bb22cc33dd44ee55ff6600112233445566778899aabbccddeeff00112233"

func newMemHarness(t *testing.T, names [][]string) *memHarness {
	t.Helper()
	dir := t.TempDir()
	root := t.TempDir()
	ws := t.TempDir()
	scope := systemdScopeDir(root, memProbeID)
	writeCgroupFixture(t, scope, map[string]string{
		"memory.current": "1000\n",
		"memory.peak":    "1000\n",
		"memory.max":     "3221225472\n",
		"memory.events":  "oom_kill 0\n",
	})

	h := &memHarness{
		t:       t,
		scope:   scope,
		history: filepath.Join(dir, "history.jsonl"),
		now:     time.Date(2026, 7, 22, 3, 0, 0, 0, time.UTC),
	}
	// One container run across every poll: the same name always wearing the same
	// id, so the restart check sees continuity and the cgroup fixture above stays
	// the one being read.
	running := make([][]Running, len(names))
	for i, poll := range names {
		for _, name := range poll {
			running[i] = append(running[i], up(name, memProbeID))
		}
	}
	h.fd = &fakeDocker{
		running: running,
		inspect: map[string]Container{
			"arachne-agent-feat-f71": {
				Name: "arachne-agent-feat-f71", Slug: "feat-f71", ID: memProbeID,
				StartedAt: "2026-07-22T03:00:00Z", Workspace: ws,
			},
		},
	}
	h.rec = NewRecorder(Config{
		Docker: h.fd, HistoryPath: h.history, StatePath: filepath.Join(dir, "state.json"),
		CgroupRoot: root, Now: func() time.Time { return h.now },
	})
	w, err := OpenWriter(h.history)
	if err != nil {
		t.Fatalf("open writer: %v", err)
	}
	h.rec.writer = w
	return h
}

// set rewrites the fixture files, standing in for the kernel moving the numbers.
func (h *memHarness) set(files map[string]string) {
	h.t.Helper()
	writeCgroupFixture(h.t, h.scope, files)
}

func (h *memHarness) tick() {
	h.t.Helper()
	if err := h.rec.tick(context.Background()); err != nil {
		h.t.Fatalf("tick: %v", err)
	}
	h.now = h.now.Add(5 * time.Second)
}

func (h *memHarness) events() []Event {
	h.t.Helper()
	h.rec.writer.Close()
	evs, err := LoadEvents(h.history)
	if err != nil {
		h.t.Fatalf("load: %v", err)
	}
	return evs
}

func eventsOfType(evs []Event, kind string) []Event {
	var out []Event
	for _, e := range evs {
		if e.Type == kind {
			out = append(out, e)
		}
	}
	return out
}

func TestMemorySampleEvery_shouldFitTheSampleIntervalIntoThePollInterval(t *testing.T) {
	cases := []struct {
		interval time.Duration
		want     int
	}{
		{5 * time.Second, 6},  // the default: a sample every 30s
		{1 * time.Second, 30}, //
		{10 * time.Second, 3}, //
		{7 * time.Second, 5},  // rounds up, never sampling slower than asked
		{30 * time.Second, 1}, // interval already at the cadence
		{60 * time.Second, 1}, // slower than the cadence: every poll
		{0, 1},                // unset
		{-1 * time.Second, 1}, // nonsense
	}
	for _, tc := range cases {
		if got := memorySampleEvery(tc.interval); got != tc.want {
			t.Errorf("memorySampleEvery(%s) = %d, want %d", tc.interval, got, tc.want)
		}
	}
}

func TestRecorder_shouldSampleMemoryOnTheFirstPollThenEverySixth(t *testing.T) {
	live := []string{"arachne-agent-feat-f71"}
	h := newMemHarness(t, [][]string{live, live, live, live, live, live, live, live})
	for i := 0; i < 8; i++ {
		h.tick()
	}
	samples := eventsOfType(h.events(), EventMemorySample)

	// Polls 0 and 6 sample; the five in between are read but not written.
	if len(samples) != 2 {
		t.Fatalf("got %d memory samples over 8 polls, want 2 (poll 0 and poll 6)", len(samples))
	}
	if samples[0].TS != "2026-07-22T03:00:00Z" {
		t.Errorf("first sample at %s, want the session's very first poll", samples[0].TS)
	}
	if samples[1].TS != "2026-07-22T03:00:30Z" {
		t.Errorf("second sample at %s, want 30s after the first", samples[1].TS)
	}
	if samples[0].MemTreeBytes != 1000 || samples[0].MemMaxBytes != 3221225472 {
		t.Errorf("sample carries wrong figures: %+v", samples[0])
	}
}

func TestRecorder_shouldEmitAnOOMKillEventTheTickTheCounterMoves(t *testing.T) {
	live := []string{"arachne-agent-feat-f71"}
	h := newMemHarness(t, [][]string{live, live, live, live})

	h.tick() // poll 0: counter at 0
	h.set(map[string]string{
		"memory.current": "3000000000\n",
		"memory.peak":    "3221225472\n",
		"memory.max":     "3221225472\n",
		"memory.events":  "oom_kill 1\n",
	})
	h.tick() // poll 1: the cage fires
	h.tick() // poll 2: counter flat, nothing more to say
	h.tick()

	kills := eventsOfType(h.events(), EventOOMKill)
	if len(kills) != 1 {
		t.Fatalf("got %d oom_kill events, want exactly 1 (a flat counter is not a new kill)", len(kills))
	}
	k := kills[0]
	if k.TS != "2026-07-22T03:00:05Z" {
		t.Errorf("oom_kill at %s, want the poll that observed it", k.TS)
	}
	if k.OOMKills != 1 || k.OOMKillDelta != 1 {
		t.Errorf("counts wrong: cumulative=%d delta=%d, want 1 and 1", k.OOMKills, k.OOMKillDelta)
	}
	// The kill lands between two samples, so without the figures riding along
	// there would be no record of what memory was doing when the cage fired.
	if k.MemTreeBytes != 3000000000 || k.MemMaxBytes != 3221225472 {
		t.Errorf("oom_kill carries no usable context: %+v", k)
	}
}

func TestRecorder_shouldDetectAnOOMKillBetweenSamples(t *testing.T) {
	// The whole point of reading every poll rather than every sample: a kill in
	// poll 1 must not wait for the next 30s sample, because the container is
	// usually gone by then and its cgroup with it.
	live := []string{"arachne-agent-feat-f71"}
	h := newMemHarness(t, [][]string{live, live, {}})

	h.tick()
	h.set(map[string]string{
		"memory.current": "3200000000\n",
		"memory.peak":    "3221225472\n",
		"memory.max":     "3221225472\n",
		"memory.events":  "oom_kill 1\n",
	})
	h.tick() // observed here
	h.tick() // container gone

	evs := h.events()
	if len(eventsOfType(evs, EventOOMKill)) != 1 {
		t.Fatalf("the kill was lost: %d oom_kill events", len(eventsOfType(evs, EventOOMKill)))
	}
	// It must also land before the session_end, so a reader sees the cause
	// before the effect.
	var killAt, endAt = -1, -1
	for i, e := range evs {
		if e.Type == EventOOMKill {
			killAt = i
		}
		if e.Type == EventSessionEnd {
			endAt = i
		}
	}
	if killAt < 0 || endAt < 0 || killAt > endAt {
		t.Fatalf("oom_kill at %d, session_end at %d — the kill must precede the end", killAt, endAt)
	}
}

func TestRecorder_shouldFlushTheLastReadingWhenTheContainerDisappears(t *testing.T) {
	// The cgroup vanishes with the container, so the reading held from the last
	// poll is the only record of how the session ended. Losing it would truncate
	// the series up to 30s early and take the final high-water mark with it.
	live := []string{"arachne-agent-feat-f71"}
	h := newMemHarness(t, [][]string{live, live, {}})

	h.tick() // poll 0 samples
	h.set(map[string]string{
		"memory.current": "2500000000\n",
		"memory.peak":    "2600000000\n",
		"memory.max":     "3221225472\n",
		"memory.events":  "oom_kill 0\n",
	})
	h.tick() // poll 1: read, held, not written (not a sample poll)
	h.tick() // poll 2: gone

	samples := eventsOfType(h.events(), EventMemorySample)
	if len(samples) != 2 {
		t.Fatalf("got %d samples, want 2 (the first poll and the flush on exit)", len(samples))
	}
	last := samples[1]
	if last.MemPeakBytes != 2600000000 {
		t.Errorf("flushed peak = %d, want the last reading's 2600000000", last.MemPeakBytes)
	}
	if last.TS != "2026-07-22T03:00:05Z" {
		t.Errorf("flushed sample at %s, want the poll that read it", last.TS)
	}
}

func TestRecorder_shouldNotSampleAContainerWithNoCgroup(t *testing.T) {
	// A container whose cgroup we cannot resolve must degrade to no memory data,
	// never to a tick failure or a run of zeroes.
	dir := t.TempDir()
	h := &memHarness{
		t:       t,
		history: filepath.Join(dir, "history.jsonl"),
		now:     time.Date(2026, 7, 22, 3, 0, 0, 0, time.UTC),
	}
	fd := &fakeDocker{
		running: [][]Running{{up("arachne-agent-feat-f71", memProbeID)}, {up("arachne-agent-feat-f71", memProbeID)}},
		inspect: map[string]Container{
			"arachne-agent-feat-f71": {Name: "arachne-agent-feat-f71", Slug: "feat-f71", ID: memProbeID},
		},
	}
	h.rec = NewRecorder(Config{
		Docker: fd, HistoryPath: h.history,
		CgroupRoot: t.TempDir(), // empty: no scope directory anywhere
		Now:        func() time.Time { return h.now },
	})
	w, err := OpenWriter(h.history)
	if err != nil {
		t.Fatalf("open writer: %v", err)
	}
	h.rec.writer = w

	h.tick()
	h.tick()

	evs := h.events()
	if n := len(eventsOfType(evs, EventMemorySample)); n != 0 {
		t.Fatalf("got %d memory samples for a container with no cgroup, want 0", n)
	}
	if n := len(eventsOfType(evs, EventSessionStart)); n != 1 {
		t.Fatalf("the session itself should still be recorded; got %d starts", n)
	}
}

func TestRecorder_shouldNotReportAnOOMKillThatHappenedWhileItWasDown(t *testing.T) {
	// memory.events is cumulative over the container's life and does not reset
	// when we restart, so a nonzero counter at reconcile is history, not news.
	// Dating it to now would put a phantom kill on the timeline.
	dir := t.TempDir()
	root := t.TempDir()
	historyPath := filepath.Join(dir, "history.jsonl")
	writeCgroupFixture(t, systemdScopeDir(root, memProbeID), map[string]string{
		"memory.current": "1000\n",
		"memory.peak":    "1000\n",
		"memory.events":  "oom_kill 2\n", // two kills happened while we were down
	})

	// A history with the session already open.
	w, err := OpenWriter(historyPath)
	if err != nil {
		t.Fatalf("open writer: %v", err)
	}
	if err := w.Append(Event{
		Type: EventSessionStart, TS: "2026-07-22T02:00:00Z", SessionID: "feat-f71",
		Container: "arachne-agent-feat-f71", StartedAt: "2026-07-22T02:00:00Z",
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	w.Close()

	now := time.Date(2026, 7, 22, 3, 0, 0, 0, time.UTC)
	fd := &fakeDocker{
		running: [][]Running{{up("arachne-agent-feat-f71", memProbeID)}, {up("arachne-agent-feat-f71", memProbeID)}},
		inspect: map[string]Container{
			"arachne-agent-feat-f71": {Name: "arachne-agent-feat-f71", Slug: "feat-f71", ID: memProbeID},
		},
	}
	rec := NewRecorder(Config{
		Docker: fd, HistoryPath: historyPath, CgroupRoot: root,
		Now: func() time.Time { return now },
	})
	w2, err := OpenWriter(historyPath)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	rec.writer = w2
	if err := rec.reconcile(context.Background()); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if err := rec.tick(context.Background()); err != nil {
		t.Fatalf("tick: %v", err)
	}
	rec.writer.Close()

	evs, err := LoadEvents(historyPath)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if n := len(eventsOfType(evs, EventOOMKill)); n != 0 {
		t.Fatalf("got %d oom_kill events after a restart, want 0 — the counter was primed, not replayed", n)
	}
}

func TestRecorder_shouldReportAKillThatArrivesAfterARestartPrimedTheCounter(t *testing.T) {
	// The other half of the priming rule: priming must not blind us to the next
	// real kill.
	dir := t.TempDir()
	root := t.TempDir()
	historyPath := filepath.Join(dir, "history.jsonl")
	scope := systemdScopeDir(root, memProbeID)
	writeCgroupFixture(t, scope, map[string]string{
		"memory.current": "1000\n",
		"memory.events":  "oom_kill 2\n",
	})

	w, err := OpenWriter(historyPath)
	if err != nil {
		t.Fatalf("open writer: %v", err)
	}
	if err := w.Append(Event{
		Type: EventSessionStart, TS: "2026-07-22T02:00:00Z", SessionID: "feat-f71",
		Container: "arachne-agent-feat-f71", StartedAt: "2026-07-22T02:00:00Z",
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	w.Close()

	now := time.Date(2026, 7, 22, 3, 0, 0, 0, time.UTC)
	fd := &fakeDocker{
		running: [][]Running{{up("arachne-agent-feat-f71", memProbeID)}, {up("arachne-agent-feat-f71", memProbeID)}},
		inspect: map[string]Container{
			"arachne-agent-feat-f71": {Name: "arachne-agent-feat-f71", Slug: "feat-f71", ID: memProbeID},
		},
	}
	rec := NewRecorder(Config{Docker: fd, HistoryPath: historyPath, CgroupRoot: root, Now: func() time.Time { return now }})
	w2, err := OpenWriter(historyPath)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	rec.writer = w2
	if err := rec.reconcile(context.Background()); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	writeCgroupFixture(t, scope, map[string]string{
		"memory.current": "1000\n",
		"memory.events":  "oom_kill 3\n", // a third kill, this one on our watch
	})
	if err := rec.tick(context.Background()); err != nil {
		t.Fatalf("tick: %v", err)
	}
	rec.writer.Close()

	evs, err := LoadEvents(historyPath)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	kills := eventsOfType(evs, EventOOMKill)
	if len(kills) != 1 {
		t.Fatalf("got %d oom_kill events, want 1", len(kills))
	}
	if kills[0].OOMKills != 3 || kills[0].OOMKillDelta != 1 {
		t.Fatalf("cumulative=%d delta=%d, want 3 and 1 — the delta is what happened on our watch",
			kills[0].OOMKills, kills[0].OOMKillDelta)
	}
}
