package arachne

import (
	"encoding/json"
	"testing"
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
