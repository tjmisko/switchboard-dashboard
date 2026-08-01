package arachne

import (
	"testing"

	"github.com/tjmisko/switchboard-dashboard/internal/timeline"
)

// The merged view's central premise is that a day looks the same merged as it
// does single-provider. Every other merge test asserts a hand-computed constant
// against a hand-built envelope, which cannot catch the two halves drifting
// apart; this one closes the loop end to end. Compile is the only producer this
// repo owns, so it is the only place we can compute attention_union twice by two
// independent code paths — arachne's own accumulator and timeline.laneAloftSpans
// re-deriving it from the emitted lanes — and demand they agree.
//
// Each case also pins the expected constant, so the two paths agreeing on a
// wrong number still fails.
func TestCompileThenMerge_shouldPreserveAttentionUnionExactly(t *testing.T) {
	cases := []struct {
		name   string
		events []Event
		now    string
		want   int64 // ns
	}{
		{
			// The ghost: unclosed, silent for five hours, stretched to now. Only
			// the evidenced half hour may survive either path.
			name: "ghost lane",
			events: []Event{
				{Type: EventSessionStart, TS: "2026-07-22T06:00:00Z", SessionID: "ghost", StartedAt: "2026-07-22T06:00:00Z"},
				{Type: EventUsageSample, TS: "2026-07-22T06:30:00Z", SessionID: "ghost", TokIn: 10},
			},
			now:  "2026-07-22T11:30:00Z",
			want: 30 * 60 * 1e9, // 06:00–06:30
		},
		{
			// The 2026-07-22 shape: a ghost whose synthesized tail also carries an
			// unpaired subagent, so both the lane clip and the phantom skip run.
			name: "ghost lane with a phantom subagent",
			events: []Event{
				{Type: EventSessionStart, TS: "2026-07-22T06:00:00Z", SessionID: "ghost", StartedAt: "2026-07-22T06:00:00Z"},
				{Type: EventSubagentSpawn, TS: "2026-07-22T06:10:00Z", SessionID: "ghost", ToolUseID: "s1", AgentType: "Explore"},
			},
			now:  "2026-07-22T12:00:00Z",
			want: 10 * 60 * 1e9, // 06:00–06:10, the last evidence
		},
		{
			// A lane its own session_end closed is never suspect, so there is no
			// clip to hide behind — the phantom skip is on its own here. The
			// unpaired span was stretched to `now`, more than two hours past the
			// lane's close, so crediting it would extend the union to 13:05.
			name: "closed lane with a phantom subagent",
			events: []Event{
				{Type: EventSessionStart, TS: "2026-07-22T10:00:00Z", SessionID: "parent", StartedAt: "2026-07-22T10:00:00Z"},
				{Type: EventSubagentSpawn, TS: "2026-07-22T10:05:00Z", SessionID: "parent", ToolUseID: "s1", AgentType: "Explore"},
				{Type: EventSessionEnd, TS: "2026-07-22T11:00:00Z", SessionID: "parent", End: "2026-07-22T11:00:00Z", Reason: ReasonExited},
			},
			now:  "2026-07-22T13:05:00Z",
			want: 3600 * 1e9, // the parent lane, 10:00–11:00, and nothing more
		},
		{
			// The false positive to guard against: still open, but talking. A long
			// session is not a ghost, and neither path may clip it.
			name: "unclosed but talkative lane",
			events: []Event{
				{Type: EventSessionStart, TS: "2026-07-22T01:00:00Z", SessionID: "busy", StartedAt: "2026-07-22T01:00:00Z"},
				{Type: EventUsageSample, TS: "2026-07-22T05:00:00Z", SessionID: "busy", TokIn: 10},
				{Type: EventUsageSample, TS: "2026-07-22T10:55:00Z", SessionID: "busy", TokIn: 20},
			},
			now:  "2026-07-22T11:00:00Z",
			want: 10 * 3600 * 1e9, // 01:00–11:00, uncut
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tl := Compile(tc.events, CompileOptions{Now: mustTime(t, tc.now), Window: "2026-07-22"})
			if tl.Summary.AttentionUnion != tc.want {
				t.Fatalf("arachne attention_union = %d, want %d", tl.Summary.AttentionUnion, tc.want)
			}
			merged := timeline.Merge([]timeline.Sourced{{Provider: "arachne", Timeline: tl}}, timeline.MergeOptions{})
			if merged.Summary.AttentionUnion != tl.Summary.AttentionUnion {
				t.Errorf("merged attention_union = %d, want %d (the provider's own figure, unchanged)",
					merged.Summary.AttentionUnion, tl.Summary.AttentionUnion)
			}
		})
	}
}
