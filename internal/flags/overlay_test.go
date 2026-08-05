package flags

import (
	"testing"

	"github.com/tjmisko/switchboard-dashboard/internal/timeline"
)

// The lanes below are the real 2026-08-05 defect, copied from
// `switchboard-ctl timeline --day 2026-08-05 --json`.
//
// One session, two lanes. The session ran for 19 seconds; its session_end was
// stamped 1.16ms BEFORE the final working→idle transition but appended after it,
// so the reader — which orders by timestamp — closed the lane on the end event
// and then opened a second one for the trailing transition that nothing would
// ever close. That second lane stretched to the window bound and drew as three
// hours of idle in its own project group. It is not marked suspect: 3h sits
// under the producer's 4h trailing cap.
const (
	ghostSession   = "296eb0f0-44c5-4406-84a9-04abae0db150"
	realLaneStart  = "2026-08-05T10:29:18.669751036-07:00"
	realLaneEnd    = "2026-08-05T10:29:37.437833786-07:00"
	ghostLaneStart = "2026-08-05T10:29:37.438991459-07:00"
	ghostLaneEnd   = "2026-08-05T13:41:34.680948947-07:00"
)

func ghostEnvelope() *timeline.Timeline {
	return &timeline.Timeline{
		Window: "2026-08-05",
		Lanes: []timeline.Lane{
			{
				SessionID: ghostSession, PID: 1241937, Agent: "claude",
				Project: "screening-overhaul", Name: "screening-overhaul-86",
				Start: realLaneStart, End: realLaneEnd,
				Intervals: []timeline.Interval{
					{Status: "", Start: realLaneStart, End: "2026-08-05T10:29:19.454619596-07:00"},
					{Status: "idle", Start: "2026-08-05T10:29:19.454619596-07:00", End: "2026-08-05T10:29:21.338413048-07:00"},
					{Status: "working", Start: "2026-08-05T10:29:21.338413048-07:00", End: realLaneEnd},
				},
			},
			{
				SessionID: ghostSession, PID: 1241937, Agent: "claude",
				Project: "screening-overhaul",
				Start:   ghostLaneStart, End: ghostLaneEnd,
				Intervals: []timeline.Interval{
					{Status: "idle", Start: ghostLaneStart, End: ghostLaneEnd},
				},
			},
		},
		Summary: timeline.Summary{Sessions: 2, ByStatus: map[string]int64{"idle": 11517241957488}},
	}
}

func flagFor(laneStart string, action Action, verdict string) map[string]Record {
	record := Record{
		SessionID: ghostSession,
		LaneStart: laneStart,
		Status:    StatusApplied,
		Verdict:   verdict,
		Action:    action,
	}
	return map[string]Record{record.Key(): record}
}

func TestApplyShouldRemoveOnlyTheGhostWhenOneSessionHasTwoLanes(t *testing.T) {
	tl := ghostEnvelope()
	applied := Apply(tl, flagFor(ghostLaneStart, Action{Type: ActionSuppress}, "ghost-lane"))

	if len(applied) != 1 {
		t.Fatalf("applied %d overlays, want 1", len(applied))
	}
	if len(tl.Lanes) != 1 {
		t.Fatalf("envelope holds %d lanes, want 1", len(tl.Lanes))
	}
	survivor := tl.Lanes[0]
	if survivor.Start != realLaneStart {
		t.Errorf("the wrong lane survived: start %q, want %q", survivor.Start, realLaneStart)
	}
	if survivor.Name != "screening-overhaul-86" {
		t.Errorf("survivor lost its name: %q", survivor.Name)
	}
	if len(survivor.Intervals) != 3 {
		t.Errorf("survivor has %d intervals, want its original 3", len(survivor.Intervals))
	}

	want := int64(11517241957488) // 3h11m57.241957488s of pure synthesis
	if applied[0].RemovedNS != want {
		t.Errorf("removed_ns = %d, want %d", applied[0].RemovedNS, want)
	}
	if applied[0].Verdict != "ghost-lane" {
		t.Errorf("verdict = %q, want ghost-lane", applied[0].Verdict)
	}
}

func TestApplyShouldLeaveSummaryUntouchedWhenLanesAreRepaired(t *testing.T) {
	// Deliberate: the aggregates keep describing what the producer reported, and
	// flags_applied is what a consumer shows beside them. A half-corrected total
	// is worse than an uncorrected one that says so.
	tl := ghostEnvelope()
	before := tl.Summary
	Apply(tl, flagFor(ghostLaneStart, Action{Type: ActionSuppress}, "ghost-lane"))

	if tl.Summary.Sessions != before.Sessions {
		t.Errorf("summary.sessions changed to %d", tl.Summary.Sessions)
	}
	if tl.Summary.ByStatus["idle"] != before.ByStatus["idle"] {
		t.Errorf("summary.by_status changed to %v", tl.Summary.ByStatus)
	}
	if len(tl.FlagsApplied) != 1 {
		t.Fatalf("flags_applied holds %d entries, want 1", len(tl.FlagsApplied))
	}
	if tl.FlagsApplied[0].RemovedNS == 0 {
		t.Error("flags_applied reports no removed time, so a consumer cannot reconcile the totals")
	}
}

func TestApplyShouldChangeNothingWhenNoOverlayIsActive(t *testing.T) {
	// The single-provider path proxies provider bytes verbatim, and that property
	// must survive whenever no flag actually bites. Apply returning nil is what
	// the handler tests for.
	inactive := []Record{
		{SessionID: ghostSession, LaneStart: ghostLaneStart, Status: StatusPending, Action: Action{Type: ActionSuppress}},
		{SessionID: ghostSession, LaneStart: ghostLaneStart, Status: StatusReverted, Action: Action{Type: ActionSuppress}},
		{SessionID: ghostSession, LaneStart: ghostLaneStart, Status: StatusApplied, Action: Action{Type: ActionNone}},
		{SessionID: ghostSession, LaneStart: ghostLaneStart, Status: StatusPendingReview, Action: Action{Type: ActionSuppress}},
	}
	for _, record := range inactive {
		t.Run(string(record.Status)+"/"+string(record.Action.Type), func(t *testing.T) {
			tl := ghostEnvelope()
			applied := Apply(tl, map[string]Record{record.Key(): record})
			if applied != nil {
				t.Errorf("Apply reported %v, want nil", applied)
			}
			if len(tl.Lanes) != 2 {
				t.Errorf("lanes changed to %d, want 2", len(tl.Lanes))
			}
		})
	}
}

func TestApplyShouldIgnoreFlagsWhenTheirLaneIsNotInThisWindow(t *testing.T) {
	// Flags outlive the day they were filed on. Paging back to last Tuesday must
	// not have last Tuesday's repairs fire against unrelated lanes.
	tl := ghostEnvelope()
	stray := Record{
		SessionID: "some-other-session",
		LaneStart: "2026-07-30T09:00:00Z",
		Status:    StatusApplied,
		Action:    Action{Type: ActionSuppress},
	}
	applied := Apply(tl, map[string]Record{stray.Key(): stray})
	if len(applied) != 0 {
		t.Errorf("Apply reported %v for an absent lane", applied)
	}
	if len(tl.Lanes) != 2 {
		t.Errorf("lanes changed to %d, want 2", len(tl.Lanes))
	}
}

func TestClipShouldTruncateTrailingIntervalWhenLaneTailIsSynthesized(t *testing.T) {
	tl := ghostEnvelope()
	at := "2026-08-05T11:00:00.000000000-07:00"
	applied := Apply(tl, flagFor(ghostLaneStart, Action{Type: ActionClipAt, ClipAt: at}, "ghost-lane"))

	if len(applied) != 1 || len(tl.Lanes) != 2 {
		t.Fatalf("applied %d overlays over %d lanes, want 1 over 2", len(applied), len(tl.Lanes))
	}
	clipped := tl.Lanes[1]
	if clipped.End != at {
		t.Errorf("lane end = %q, want %q", clipped.End, at)
	}
	if len(clipped.Intervals) != 1 || clipped.Intervals[0].End != at {
		t.Errorf("straddling interval not truncated: %+v", clipped.Intervals)
	}
	if applied[0].RemovedNS <= 0 {
		t.Errorf("removed_ns = %d, want the clipped tail", applied[0].RemovedNS)
	}
}

func TestClipShouldKeepLaneWholeWhenPointIsUnusable(t *testing.T) {
	// A clip outside the lane would either do nothing or erase it. Neither is a
	// repair, so the lane is left alone and nothing is reported as applied.
	for _, at := range []string{"", "not-a-timestamp", "2026-08-05T09:00:00-07:00", "2026-08-05T23:00:00-07:00"} {
		t.Run(at, func(t *testing.T) {
			tl := ghostEnvelope()
			applied := Apply(tl, flagFor(ghostLaneStart, Action{Type: ActionClipAt, ClipAt: at}, "ghost-lane"))
			if len(applied) != 0 {
				t.Errorf("Apply reported %v, want nothing applied", applied)
			}
			if len(tl.Lanes) != 2 || tl.Lanes[1].End != ghostLaneEnd {
				t.Errorf("lane was modified: end = %q", tl.Lanes[1].End)
			}
		})
	}
}

func TestClipShouldDropSuspectFlagWhenTailItWarnedAboutIsGone(t *testing.T) {
	tl := ghostEnvelope()
	tl.Lanes[1].Suspect = true
	tl.Lanes[1].SuspectSince = ghostLaneStart
	tl.Lanes[1].SuspectReason = "unclosed lane stretched to now"

	Apply(tl, flagFor(ghostLaneStart, Action{Type: ActionClipAt, ClipAt: "2026-08-05T11:00:00-07:00"}, "ghost-lane"))

	clipped := tl.Lanes[1]
	if clipped.Suspect || clipped.SuspectSince != "" || clipped.SuspectReason != "" {
		t.Errorf("clipped lane still carries the producer's suspect flag: %+v", clipped)
	}
}

func TestMergeShouldFoldSplitLaneBackIntoItsSiblingWhenBothHoldRealWork(t *testing.T) {
	// The split-lane defect, distinct from the ghost: a daemon restart used to
	// make a live session's id appear to change, splitting one session's lane in
	// two where BOTH halves hold observed events. Suppressing either would throw
	// away real work, so these merge instead.
	tl := ghostEnvelope()
	tl.Lanes[1].Intervals = []timeline.Interval{
		{Status: "working", Start: ghostLaneStart, End: ghostLaneEnd},
	}
	tl.Lanes[1].CostUSD = 2.5
	tl.Lanes[1].TokOut = 400
	tl.Lanes[0].CostUSD = 1.0
	tl.Lanes[0].TokOut = 100

	applied := Apply(tl, flagFor(ghostLaneStart, Action{
		Type:               ActionMergeInto,
		MergeIntoLaneStart: realLaneStart,
	}, "split-lane"))

	if len(applied) != 1 {
		t.Fatalf("applied %d overlays, want 1", len(applied))
	}
	if len(tl.Lanes) != 1 {
		t.Fatalf("envelope holds %d lanes, want 1 merged lane", len(tl.Lanes))
	}
	merged := tl.Lanes[0]
	if merged.Start != realLaneStart || merged.End != ghostLaneEnd {
		t.Errorf("merged bounds = %q..%q, want %q..%q", merged.Start, merged.End, realLaneStart, ghostLaneEnd)
	}
	if len(merged.Intervals) != 4 {
		t.Fatalf("merged lane has %d intervals, want 4", len(merged.Intervals))
	}
	for i := 1; i < len(merged.Intervals); i++ {
		if earlier(merged.Intervals[i].Start, merged.Intervals[i-1].Start) {
			t.Errorf("merged intervals are out of order at %d: %+v", i, merged.Intervals)
		}
	}
	if merged.CostUSD != 3.5 || merged.TokOut != 500 {
		t.Errorf("merged usage = $%.2f / %d tok, want $3.50 / 500", merged.CostUSD, merged.TokOut)
	}
	if merged.Name != "screening-overhaul-86" {
		t.Errorf("merged lane name = %q, want the surviving name", merged.Name)
	}
}

func TestMergeShouldKeepOrphanWhenTargetLaneIsAbsent(t *testing.T) {
	// Relocating data into a lane that is not here would silently delete it. The
	// operator asked to move the lane, not to lose it.
	tl := ghostEnvelope()
	applied := Apply(tl, flagFor(ghostLaneStart, Action{
		Type:               ActionMergeInto,
		MergeIntoLaneStart: "2026-07-04T12:00:00Z",
	}, "split-lane"))

	if len(applied) != 0 {
		t.Errorf("Apply reported %v for an unresolvable merge", applied)
	}
	if len(tl.Lanes) != 2 {
		t.Errorf("lanes = %d, want both kept", len(tl.Lanes))
	}
}

func TestMergeShouldTakeNameFromAbsorbedLaneWhenTargetHasNone(t *testing.T) {
	tl := ghostEnvelope()
	tl.Lanes[0].Name = ""
	tl.Lanes[1].Name = "recovered-name"

	Apply(tl, flagFor(ghostLaneStart, Action{
		Type:               ActionMergeInto,
		MergeIntoLaneStart: realLaneStart,
	}, "split-lane"))

	if len(tl.Lanes) != 1 {
		t.Fatalf("lanes = %d, want 1", len(tl.Lanes))
	}
	if tl.Lanes[0].Name != "recovered-name" {
		t.Errorf("merged lane name = %q, want recovered-name", tl.Lanes[0].Name)
	}
}
