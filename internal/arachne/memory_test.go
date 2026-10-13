package arachne

import (
	"encoding/json"
	"testing"

	"github.com/tjmisko/switchboard-dashboard/internal/timeline"
)

func memEvents() []Event {
	return []Event{
		{Type: EventSessionStart, TS: "2026-07-22T03:00:00Z", SessionID: "feat-f71",
			StartedAt: "2026-07-22T03:00:00Z", Agent: "opus", Project: "Arachne"},
		{Type: EventMemorySample, TS: "2026-07-22T03:00:00Z", SessionID: "feat-f71",
			MemTreeBytes: 1000, MemPeakBytes: 1000, MemMaxBytes: 3221225472},
		{Type: EventMemorySample, TS: "2026-07-22T03:00:30Z", SessionID: "feat-f71",
			MemTreeBytes: 3000, MemPeakBytes: 3000, MemMaxBytes: 3221225472},
		{Type: EventMemorySample, TS: "2026-07-22T03:01:30Z", SessionID: "feat-f71",
			MemTreeBytes: 2000, MemPeakBytes: 3000, MemMaxBytes: 3221225472},
		{Type: EventSessionEnd, TS: "2026-07-22T03:02:00Z", SessionID: "feat-f71",
			End: "2026-07-22T03:02:00Z", Reason: ReasonExited},
	}
}

func compileMem(t *testing.T, events []Event, now string) MemoryDoc {
	t.Helper()
	return CompileMemory(events, CompileOptions{Now: mustTime(t, now), Window: "2026-07-22"})
}

func TestCompileMemory_shouldReportTreeFiguresAndTheSeries(t *testing.T) {
	doc := compileMem(t, memEvents(), "2026-07-22T04:00:00Z")
	if len(doc.Sessions) != 1 {
		t.Fatalf("got %d sessions, want 1", len(doc.Sessions))
	}
	s := doc.Sessions[0]
	if s.SessionID != "feat-f71" {
		t.Fatalf("session_id = %q", s.SessionID)
	}
	if s.PeakTreeBytes == nil || *s.PeakTreeBytes != 3000 {
		t.Fatalf("peak_tree_bytes = %v, want 3000 (the kernel's high-water mark)", s.PeakTreeBytes)
	}
	// 1000 held 30s, then 3000 held 60s; the closing reading carries no weight.
	// A plain mean would say 2000 and overweight the short first leg.
	if s.AvgTreeBytes == nil || *s.AvgTreeBytes != 2333 {
		t.Fatalf("avg_tree_bytes = %v, want 2333 (time-weighted: (1000*30 + 3000*60)/90)", s.AvgTreeBytes)
	}
	if len(s.Mem) != 3 {
		t.Fatalf("got %d series points, want 3", len(s.Mem))
	}
	if s.Mem[0].TS != "2026-07-22T03:00:00Z" || s.Mem[0].Tree == nil || *s.Mem[0].Tree != 1000 {
		t.Fatalf("first point wrong: %+v", s.Mem[0])
	}
	if doc.Window != "2026-07-22" {
		t.Fatalf("window = %q", doc.Window)
	}
}

func TestCompileMemory_shouldEmitTheAgentSplitAsExplicitNull(t *testing.T) {
	// The single most breakable thing in this document. A container total has no
	// meaningful inner boundary, so there is no agent-vs-spawned split. The
	// dashboard's spawnedBytes reads a missing side as "no split available"; a
	// zero would instead claim the entire container was spawned work.
	doc := compileMem(t, memEvents(), "2026-07-22T04:00:00Z")
	s := doc.Sessions[0]
	if s.PeakAgentBytes != nil || s.AvgAgentBytes != nil {
		t.Fatalf("agent figures must be absent, got peak=%v avg=%v", s.PeakAgentBytes, s.AvgAgentBytes)
	}

	b, err := json.Marshal(doc)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var wire struct {
		Sessions []map[string]json.RawMessage `json:"sessions"`
	}
	if err := json.Unmarshal(b, &wire); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, key := range []string{"peak_agent_bytes", "avg_agent_bytes"} {
		raw, present := wire.Sessions[0][key]
		if !present {
			t.Fatalf("%s is missing from the wire; it must be present and null", key)
		}
		if string(raw) != "null" {
			t.Fatalf("%s = %s, want null (0 would read as a real figure)", key, raw)
		}
	}
	// Same rule inside the series.
	var series struct {
		Sessions []struct {
			Mem []map[string]json.RawMessage `json:"mem"`
		} `json:"sessions"`
	}
	if err := json.Unmarshal(b, &series); err != nil {
		t.Fatalf("unmarshal series: %v", err)
	}
	raw, present := series.Sessions[0].Mem[0]["agent"]
	if !present || string(raw) != "null" {
		t.Fatalf("mem[0].agent = %s (present=%v), want null", raw, present)
	}
}

func TestCompileMemory_shouldNotEmitPressure(t *testing.T) {
	// Pressure is machine-wide and /api/memory keeps only the first provider that
	// reports it. An Arachne container shares its host with the switchboard
	// daemon, so a second observation of the same physical memory would either be
	// discarded or double-count stall time depending on provider order.
	b, err := json.Marshal(compileMem(t, memEvents(), "2026-07-22T04:00:00Z"))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var wire map[string]json.RawMessage
	if err := json.Unmarshal(b, &wire); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, present := wire["pressure"]; present {
		t.Fatalf("the document must carry no pressure series, got %s", wire["pressure"])
	}
}

func TestCompileMemory_shouldOmitSessionsWithNoMemoryEvents(t *testing.T) {
	// Every session recorded before the sampler existed. An absent entry already
	// means "unenriched" to the endpoint, so a row of nulls would be pure noise.
	events := []Event{
		{Type: EventSessionStart, TS: "2026-07-22T03:00:00Z", SessionID: "old", StartedAt: "2026-07-22T03:00:00Z"},
		{Type: EventUsageSample, TS: "2026-07-22T03:10:00Z", SessionID: "old", TokIn: 10},
		{Type: EventSessionEnd, TS: "2026-07-22T03:20:00Z", SessionID: "old", End: "2026-07-22T03:20:00Z"},
	}
	doc := compileMem(t, events, "2026-07-22T04:00:00Z")
	if len(doc.Sessions) != 0 {
		t.Fatalf("got %d sessions, want 0", len(doc.Sessions))
	}
	// It must still be a JSON array, never null, so a consumer can range over it.
	b, _ := json.Marshal(doc)
	var wire struct {
		Sessions json.RawMessage `json:"sessions"`
	}
	_ = json.Unmarshal(b, &wire)
	if string(wire.Sessions) != "[]" {
		t.Fatalf("sessions = %s, want []", wire.Sessions)
	}
}

func TestCompileMemory_shouldUseTheKernelPeakOverTheSampledMaximum(t *testing.T) {
	// The point of memory.peak: a spike between two samples is still caught. The
	// series never sees 9000, but the kernel did.
	events := []Event{
		{Type: EventSessionStart, TS: "2026-07-22T03:00:00Z", SessionID: "s", StartedAt: "2026-07-22T03:00:00Z"},
		{Type: EventMemorySample, TS: "2026-07-22T03:00:00Z", SessionID: "s", MemTreeBytes: 1000, MemPeakBytes: 1000},
		{Type: EventMemorySample, TS: "2026-07-22T03:00:30Z", SessionID: "s", MemTreeBytes: 1200, MemPeakBytes: 9000},
		{Type: EventSessionEnd, TS: "2026-07-22T03:01:00Z", SessionID: "s", End: "2026-07-22T03:01:00Z"},
	}
	doc := compileMem(t, events, "2026-07-22T04:00:00Z")
	if got := doc.Sessions[0].PeakTreeBytes; got == nil || *got != 9000 {
		t.Fatalf("peak_tree_bytes = %v, want 9000 from memory.peak, not 1200 from the samples", got)
	}
}

func TestCompileMemory_shouldFallBackToObservedReadingsWithoutAKernelPeak(t *testing.T) {
	// An older kernel with no memory.peak reports zero; the observed readings are
	// then the best floor available rather than no figure at all.
	events := []Event{
		{Type: EventSessionStart, TS: "2026-07-22T03:00:00Z", SessionID: "s", StartedAt: "2026-07-22T03:00:00Z"},
		{Type: EventMemorySample, TS: "2026-07-22T03:00:00Z", SessionID: "s", MemTreeBytes: 1000},
		{Type: EventMemorySample, TS: "2026-07-22T03:00:30Z", SessionID: "s", MemTreeBytes: 4000},
		{Type: EventSessionEnd, TS: "2026-07-22T03:01:00Z", SessionID: "s", End: "2026-07-22T03:01:00Z"},
	}
	doc := compileMem(t, events, "2026-07-22T04:00:00Z")
	if got := doc.Sessions[0].PeakTreeBytes; got == nil || *got != 4000 {
		t.Fatalf("peak_tree_bytes = %v, want the observed 4000", got)
	}
}

func TestCompileMemory_shouldCountAnOOMKillTowardThePeakButNotTheSeries(t *testing.T) {
	// A kill between samples carries a real reading. It belongs in the peak — it
	// is the moment memory was highest — but it is not a scheduled series point.
	events := []Event{
		{Type: EventSessionStart, TS: "2026-07-22T03:00:00Z", SessionID: "s", StartedAt: "2026-07-22T03:00:00Z"},
		{Type: EventMemorySample, TS: "2026-07-22T03:00:00Z", SessionID: "s", MemTreeBytes: 1000, MemPeakBytes: 1000},
		{Type: EventOOMKill, TS: "2026-07-22T03:00:10Z", SessionID: "s",
			OOMKills: 1, OOMKillDelta: 1, MemTreeBytes: 8000, MemPeakBytes: 8000},
		{Type: EventSessionEnd, TS: "2026-07-22T03:00:20Z", SessionID: "s", End: "2026-07-22T03:00:20Z"},
	}
	doc := compileMem(t, events, "2026-07-22T04:00:00Z")
	s := doc.Sessions[0]
	if got := s.PeakTreeBytes; got == nil || *got != 8000 {
		t.Fatalf("peak_tree_bytes = %v, want the 8000 observed at the kill", got)
	}
	if len(s.Mem) != 1 {
		t.Fatalf("got %d series points, want only the one scheduled sample", len(s.Mem))
	}
}

func TestCompileMemory_shouldAverageASingleReadingAsItself(t *testing.T) {
	events := []Event{
		{Type: EventSessionStart, TS: "2026-07-22T03:00:00Z", SessionID: "s", StartedAt: "2026-07-22T03:00:00Z"},
		{Type: EventMemorySample, TS: "2026-07-22T03:00:00Z", SessionID: "s", MemTreeBytes: 777, MemPeakBytes: 777},
	}
	doc := compileMem(t, events, "2026-07-22T03:00:30Z")
	if got := doc.Sessions[0].AvgTreeBytes; got == nil || *got != 777 {
		t.Fatalf("avg_tree_bytes = %v, want 777", got)
	}
}

func TestCompileMemory_shouldAttributeSamplesToTheRunTheyFiredIn(t *testing.T) {
	// The pump restarts a container under the same name once per phase task, so a
	// slug hosts a sequence of runs and only the run open at the time owns a
	// sample. Folding memory by slug — which is what the separate pass did —
	// pooled every run's samples under the first run's id and left the later runs
	// with nothing, so a branch's second container drew a hover with no figures.
	events := []Event{
		{Type: EventSessionStart, TS: "2026-07-22T03:00:00Z", SessionID: "feat-f71",
			StartedAt: "2026-07-22T03:00:00Z", Agent: "opus", Project: "Arachne"},
		{Type: EventMemorySample, TS: "2026-07-22T03:00:30Z", SessionID: "feat-f71",
			MemTreeBytes: 1000, MemPeakBytes: 1000},
		{Type: EventSessionEnd, TS: "2026-07-22T03:01:00Z", SessionID: "feat-f71",
			End: "2026-07-22T03:01:00Z", Reason: ReasonExited},

		{Type: EventSessionStart, TS: "2026-07-22T03:02:00Z", SessionID: "feat-f71",
			StartedAt: "2026-07-22T03:02:00Z", Agent: "opus", Project: "Arachne"},
		{Type: EventMemorySample, TS: "2026-07-22T03:02:30Z", SessionID: "feat-f71",
			MemTreeBytes: 9000, MemPeakBytes: 9000},
		{Type: EventSessionEnd, TS: "2026-07-22T03:03:00Z", SessionID: "feat-f71",
			End: "2026-07-22T03:03:00Z", Reason: ReasonExited},
	}
	doc := compileMem(t, events, "2026-07-22T04:00:00Z")
	if len(doc.Sessions) != 2 {
		t.Fatalf("got %d sessions, want 2 — one per container run", len(doc.Sessions))
	}
	first, second := doc.Sessions[0], doc.Sessions[1]
	if first.SessionID != "feat-f71" || second.SessionID != "feat-f71#2" {
		t.Fatalf("run ids = %q, %q; want the bare slug then #2", first.SessionID, second.SessionID)
	}
	if len(first.Mem) != 1 || first.Mem[0].Tree == nil || *first.Mem[0].Tree != 1000 {
		t.Fatalf("first run got %+v, want only its own 1000 sample", first.Mem)
	}
	if len(second.Mem) != 1 || second.Mem[0].Tree == nil || *second.Mem[0].Tree != 9000 {
		t.Fatalf("second run got %+v, want only its own 9000 sample", second.Mem)
	}
	if second.PeakTreeBytes == nil || *second.PeakTreeBytes != 9000 {
		t.Fatalf("second run peak = %v, want 9000", second.PeakTreeBytes)
	}
}

// The envelope and this document are read together — the hover draws the series
// inside the bar Compile emitted — so the two must stop believing a lane at the
// same instant. That takes deriving the live bound the same way: read raw, this
// document's `now` ran up to a full quantum ahead of the bound the lane was
// closed at, and anywhere within a quantum of the trailing cap the two disagreed
// about whether the tail was evidence or inference.
func TestCompileMemory_shouldClipOnTheSameBoundTheLaneIsCreditedTo(t *testing.T) {
	// 08:00:10 is 10s short of the 4h cap measured from the 12:00:00 bucket
	// boundary, and 10s past it measured from the instant each compile below is
	// taken at. Which of the two a surface used is the whole test.
	const (
		start        = "2026-07-22T07:00:00Z"
		lastEvidence = "2026-07-22T08:00:10Z"
		tail         = "2026-07-22T08:01:10Z"
	)
	events := []Event{
		{Type: EventSessionStart, TS: start, SessionID: "feat-f71",
			StartedAt: start, Agent: "opus", Project: "Arachne"},
		{Type: EventMemorySample, TS: "2026-07-22T07:50:10Z", SessionID: "feat-f71",
			MemTreeBytes: 1000, MemPeakBytes: 1000},
		// Token accrual is work, and it is the last thing this session was heard
		// doing. The samples around it are not evidence of anything: a hung
		// container still holds its pages.
		{Type: EventUsageSample, TS: lastEvidence, SessionID: "feat-f71"},
		{Type: EventMemorySample, TS: tail, SessionID: "feat-f71",
			MemTreeBytes: 9000, MemPeakBytes: 9000},
	}

	suspect := func(now string) bool {
		t.Helper()
		tl := Compile(events, CompileOptions{Now: mustTime(t, now), Window: "2026-07-22"})
		if len(tl.Lanes) != 1 {
			t.Fatalf("lanes = %d, want 1", len(tl.Lanes))
		}
		return tl.Lanes[0].Suspect
	}
	series := func(now string) []MemorySample {
		t.Helper()
		doc := compileMem(t, events, now)
		if len(doc.Sessions) != 1 {
			t.Fatalf("sessions = %d, want 1", len(doc.Sessions))
		}
		return doc.Sessions[0].Mem
	}

	t.Run("should keep the tail while the envelope still credits the lane", func(t *testing.T) {
		const now = "2026-07-22T12:00:20Z" // inside the bucket the bound truncates to
		if suspect(now) {
			t.Fatalf("the lane is flagged at 3h59m50s of silence — the fixture no longer straddles the cap")
		}
		if got := series(now); len(got) != 2 {
			t.Errorf("series has %d points, want 2 — clipped at an instant the lane is credited to in full: %+v", len(got), got)
		}
	})

	t.Run("should clip the tail once the envelope stops crediting the lane", func(t *testing.T) {
		const now = "2026-07-22T12:00:30Z" // the next bucket: silence is past the cap
		if !suspect(now) {
			t.Fatalf("the lane is unflagged at 4h0m20s of silence, past the %s cap", timeline.DefaultSuspectTrailingCap)
		}
		got := series(now)
		if len(got) != 1 {
			t.Fatalf("series has %d points, want 1 — the tail outlived the evidence: %+v", len(got), got)
		}
		// The clipped reading was 9000; if the clip failed, the peak says so.
		doc := compileMem(t, events, now)
		if p := doc.Sessions[0].PeakTreeBytes; p == nil || *p != 1000 {
			t.Errorf("peak_tree_bytes = %v, want 1000 — a post-evidence reading was folded in", p)
		}
	})
}

func TestCompileMemory_shouldDropSessionsOutsideTheWindow(t *testing.T) {
	events := memEvents()
	doc := CompileMemory(events, CompileOptions{
		Now:    mustTime(t, "2026-07-24T00:00:00Z"),
		Window: "2026-07-23",
		Since:  mustTime(t, "2026-07-23T00:00:00Z"),
		Until:  mustTime(t, "2026-07-24T00:00:00Z"),
	})
	if len(doc.Sessions) != 0 {
		t.Fatalf("got %d sessions, want 0 for a day the session did not touch", len(doc.Sessions))
	}
}
