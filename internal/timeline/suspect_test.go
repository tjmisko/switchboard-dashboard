package timeline

import "testing"

const hourNs = int64(3600) * 1e9

// suspectLane is a six-hour lane whose last four hours are synthesized: the
// producer flagged it and dated the evidence at 11:00.
func suspectLane() Lane {
	return Lane{
		SessionID:     "ghost",
		Agent:         "claude",
		Project:       "alpha",
		Start:         "2026-07-22T10:00:00Z",
		End:           "2026-07-22T16:00:00Z",
		Intervals:     []Interval{{Status: "working", Start: "2026-07-22T10:00:00Z", End: "2026-07-22T16:00:00Z"}},
		Suspect:       true,
		SuspectReason: "unclosed lane stretched to now: final \"working\" interval 5h0m0s >= 4h0m0s cap",
		SuspectSince:  "2026-07-22T11:00:00Z",
	}
}

func TestMerge_shouldExcludeTheSynthesizedTailFromUnionWhenALaneIsSuspect(t *testing.T) {
	in := []Sourced{{Provider: "claude", Timeline: &Timeline{
		Lanes:   []Lane{suspectLane()},
		Summary: Summary{ByStatus: map[string]int64{}},
	}}}
	out := Merge(in, MergeOptions{})
	if out.Summary.AttentionUnion != hourNs {
		t.Errorf("attention_union = %d, want %d (10:00–11:00 only)", out.Summary.AttentionUnion, hourNs)
	}
}

func TestMerge_shouldKeepTheSuspectLaneIntactWhenMerging(t *testing.T) {
	in := []Sourced{{Provider: "claude", Timeline: &Timeline{
		Lanes:   []Lane{suspectLane()},
		Summary: Summary{ByStatus: map[string]int64{}},
	}}}
	out := Merge(in, MergeOptions{})
	got := out.Lanes[0]
	// Flag, never drop: the operator has to be able to see what was flagged, so the
	// bar keeps its full extent and carries the reason through the merge.
	if got.End != "2026-07-22T16:00:00Z" || len(got.Intervals) != 1 {
		t.Errorf("lane was truncated by the merge: %+v", got)
	}
	if !got.Suspect || got.SuspectSince != "2026-07-22T11:00:00Z" || got.SuspectReason == "" {
		t.Errorf("suspect fields lost in the merge: %+v", got)
	}
}

func TestMerge_shouldSumSuspectCountersAcrossProviders(t *testing.T) {
	in := []Sourced{
		{Provider: "claude", Timeline: &Timeline{
			Lanes:   []Lane{suspectLane()},
			Summary: Summary{ByStatus: map[string]int64{}, SuspectLanes: 1, SuspectDuration: 5 * hourNs},
		}},
		{Provider: "arachne", Timeline: &Timeline{
			Lanes:   []Lane{suspectLane()},
			Summary: Summary{ByStatus: map[string]int64{}, SuspectLanes: 2, SuspectDuration: 3 * hourNs},
		}},
	}
	out := Merge(in, MergeOptions{})
	if out.Summary.SuspectLanes != 3 {
		t.Errorf("suspect_lanes = %d, want 3", out.Summary.SuspectLanes)
	}
	if out.Summary.SuspectDuration != 8*hourNs {
		t.Errorf("suspect_duration = %d, want %d", out.Summary.SuspectDuration, 8*hourNs)
	}
}

func TestMerge_shouldNotCreditASuspectSubagentSpanWhenComputingUnion(t *testing.T) {
	lane := Lane{
		SessionID: "parent",
		Start:     "2026-07-22T10:00:00Z",
		End:       "2026-07-22T10:30:00Z",
		Intervals: []Interval{{Status: "working", Start: "2026-07-22T10:00:00Z", End: "2026-07-22T10:30:00Z"}},
		Subagents: []Subagent{
			{AgentType: "Explore", Start: "2026-07-22T10:00:00Z", End: "2026-07-22T14:00:00Z",
				Suspect: true, SuspectReason: "unpaired subagent stretched to now: span 4h0m0s >= 2h0m0s cap"},
		},
	}
	in := []Sourced{{Provider: "claude", Timeline: &Timeline{
		Lanes:   []Lane{lane},
		Summary: Summary{ByStatus: map[string]int64{}},
	}}}
	out := Merge(in, MergeOptions{})
	// Without the phantom the lane is aloft for its own half hour and no longer.
	if want := hourNs / 2; out.Summary.AttentionUnion != want {
		t.Errorf("attention_union = %d, want %d (the phantom span must not extend it)", out.Summary.AttentionUnion, want)
	}
	if !out.Lanes[0].Subagents[0].Suspect {
		t.Error("subagent suspect flag lost in the merge")
	}
}

func TestMerge_shouldNotClipLanesWhenTheProducerOmitsTheSuspectFields(t *testing.T) {
	// A provider that never runs the post-check must be merged exactly as before —
	// silently clipping its lanes would invent a bug where there was none.
	lane := suspectLane()
	lane.Suspect = false
	lane.SuspectReason = ""
	in := []Sourced{{Provider: "claude", Timeline: &Timeline{
		Lanes:   []Lane{lane},
		Summary: Summary{ByStatus: map[string]int64{}},
	}}}
	out := Merge(in, MergeOptions{})
	if want := 6 * hourNs; out.Summary.AttentionUnion != want {
		t.Errorf("attention_union = %d, want %d (unflagged lanes count in full)", out.Summary.AttentionUnion, want)
	}
}

func TestMerge_shouldCountTheFullLaneWhenSuspectSinceIsUnparsable(t *testing.T) {
	// Fail open, not closed: a malformed timestamp must not silently erase real time.
	lane := suspectLane()
	lane.SuspectSince = "not-a-timestamp"
	in := []Sourced{{Provider: "claude", Timeline: &Timeline{
		Lanes:   []Lane{lane},
		Summary: Summary{ByStatus: map[string]int64{}},
	}}}
	out := Merge(in, MergeOptions{})
	if want := 6 * hourNs; out.Summary.AttentionUnion != want {
		t.Errorf("attention_union = %d, want %d", out.Summary.AttentionUnion, want)
	}
}
