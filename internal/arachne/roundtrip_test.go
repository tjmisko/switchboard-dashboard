package arachne

import (
	"testing"

	"github.com/tjmisko/switchboard-dashboard/internal/timeline"
)

// The memory document annotates the very lanes the envelope draws, so the two
// have to agree about where a session's evidence stops. Compile and
// CompileMemory reach that bound by their own routes — one to clip credited
// attention, the other to clip the series — and a lane the envelope refuses to
// credit past 06:30 must not carry a hover figure measured at 09:00.
//
// The second case is the one that pays for the whole test. Memory samples are
// events like any other, and left in the general lastTS fold they would count as
// evidence of life, so a container that died silently would look alive right up
// to the bound: no suspect flag, no clip, on either path.
func TestCompileAndCompileMemory_shouldClipAtTheSameTrustedBound(t *testing.T) {
	cases := []struct {
		name        string
		events      []Event
		now         string
		wantSuspect bool
		wantPoints  int // series points surviving the clip
	}{
		{
			// Talking through its life: nothing is suspect, nothing is clipped.
			name: "live lane keeps its whole series",
			events: []Event{
				{Type: EventSessionStart, TS: "2026-07-22T06:00:00Z", SessionID: "busy", StartedAt: "2026-07-22T06:00:00Z"},
				{Type: EventMemorySample, TS: "2026-07-22T06:00:00Z", SessionID: "busy", MemTreeBytes: 1000, MemPeakBytes: 1000},
				{Type: EventUsageSample, TS: "2026-07-22T09:00:00Z", SessionID: "busy", TokIn: 10},
				{Type: EventMemorySample, TS: "2026-07-22T09:30:00Z", SessionID: "busy", MemTreeBytes: 2000, MemPeakBytes: 2000},
			},
			now:         "2026-07-22T10:00:00Z",
			wantSuspect: false,
			wantPoints:  2,
		},
		{
			// The ghost that only ever sampled. Its last real evidence is the
			// 06:30 usage sample; the memory samples that follow are our timer
			// talking, not the agent, and must neither clear the suspect flag nor
			// survive the clip.
			name: "sampled ghost is still a ghost",
			events: []Event{
				{Type: EventSessionStart, TS: "2026-07-22T06:00:00Z", SessionID: "ghost", StartedAt: "2026-07-22T06:00:00Z"},
				{Type: EventUsageSample, TS: "2026-07-22T06:30:00Z", SessionID: "ghost", TokIn: 10},
				{Type: EventMemorySample, TS: "2026-07-22T06:00:00Z", SessionID: "ghost", MemTreeBytes: 1000, MemPeakBytes: 1000},
				{Type: EventMemorySample, TS: "2026-07-22T08:00:00Z", SessionID: "ghost", MemTreeBytes: 5000, MemPeakBytes: 5000},
				{Type: EventMemorySample, TS: "2026-07-22T11:00:00Z", SessionID: "ghost", MemTreeBytes: 9000, MemPeakBytes: 9000},
			},
			now:         "2026-07-22T11:30:00Z",
			wantSuspect: true,
			wantPoints:  1, // only the 06:00 reading predates the 06:30 bound
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			opts := CompileOptions{Now: mustTime(t, tc.now), Window: "2026-07-22"}
			tl := Compile(tc.events, opts)
			if len(tl.Lanes) != 1 {
				t.Fatalf("got %d lanes, want 1", len(tl.Lanes))
			}
			lane := tl.Lanes[0]
			if lane.Suspect != tc.wantSuspect {
				t.Fatalf("lane.Suspect = %v, want %v (reason %q)", lane.Suspect, tc.wantSuspect, lane.SuspectReason)
			}

			doc := CompileMemory(tc.events, opts)
			if len(doc.Sessions) != 1 {
				t.Fatalf("got %d memory sessions, want 1", len(doc.Sessions))
			}
			mem := doc.Sessions[0]
			if len(mem.Mem) != tc.wantPoints {
				t.Fatalf("series has %d points, want %d", len(mem.Mem), tc.wantPoints)
			}
			if !tc.wantSuspect {
				return
			}
			// Every surviving point must predate the bound the envelope published,
			// which is the only place the two paths are forced to agree.
			bound, ok := timeline.ParseNanos(lane.SuspectSince)
			if !ok {
				t.Fatalf("lane.SuspectSince = %q is unparsable", lane.SuspectSince)
			}
			for _, p := range mem.Mem {
				ns, ok := timeline.ParseNanos(p.TS)
				if !ok {
					t.Fatalf("series point %q is unparsable", p.TS)
				}
				if ns >= bound {
					t.Fatalf("series point at %s survived the lane's %s bound", p.TS, lane.SuspectSince)
				}
			}
			// And the peak may not be the one read from the synthesized tail.
			if mem.PeakTreeBytes == nil || *mem.PeakTreeBytes != 1000 {
				t.Fatalf("peak_tree_bytes = %v, want 1000 — the 9000 was read after the lane went dark",
					mem.PeakTreeBytes)
			}
		})
	}
}

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
