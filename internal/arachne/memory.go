// The `memory --json` surface.
//
// Memory rides its own endpoint rather than the timeline envelope (README's
// Memory section has the reasoning), so this is a document of its own with its
// own fold — not a field on a Lane. /api/memory queries every provider through
// the same subcommand, so the shape here mirrors switchboard-ctl's.
//
// The fold differs in kind from the usage fold in compile.go. Tokens are
// cumulative, so last-wins is right and totals sum. Memory is an instantaneous
// gauge: the series stays a series, the average is time-weighted, and the peak
// comes from the kernel's own high-water mark rather than from whatever the
// sampler happened to catch.

package arachne

import (
	"sort"
	"time"
)

// MemoryDoc is the `memory --json` document.
//
// It deliberately carries no `pressure` series. Pressure is machine-wide, and
// /api/memory keeps only the first provider that reports it — an Arachne
// container shares its host with the switchboard daemon, so reporting it here
// would be a second observation of the same physical memory, and whichever
// provider lost the tie-break would have contributed nothing anyway. Leave it
// to the host's own observer.
type MemoryDoc struct {
	Window   string          `json:"window,omitempty"`
	Sessions []MemorySession `json:"sessions"`
}

// MemorySession is one session's memory record, in bytes throughout.
//
// PeakAgentBytes and AvgAgentBytes are always null for an Arachne lane: the
// figure is a whole-container total and a container has no meaningful inner
// boundary, so there is no agent-versus-spawned split to report. They are
// pointers without omitempty precisely so they travel as explicit nulls — the
// dashboard's spawnedBytes reads a missing side as "no split available", while
// a zero would claim the entire container was spawned work.
type MemorySession struct {
	SessionID string `json:"session_id"`
	Agent     string `json:"agent,omitempty"`
	Project   string `json:"project,omitempty"`

	PeakAgentBytes *int64 `json:"peak_agent_bytes"`
	AvgAgentBytes  *int64 `json:"avg_agent_bytes"`
	PeakTreeBytes  *int64 `json:"peak_tree_bytes"`
	AvgTreeBytes   *int64 `json:"avg_tree_bytes"`

	Mem []MemorySample `json:"mem,omitempty"`
}

// MemorySample is one point of a session's series. Agent is null here for the
// same reason as the scalars above.
type MemorySample struct {
	TS    string `json:"ts"`
	Agent *int64 `json:"agent"`
	Tree  *int64 `json:"tree"`
}

// CompileMemory folds the history's memory events into the memory document,
// windowed the same way Compile windows lanes.
//
// Sessions with no memory events at all are omitted rather than emitted as a
// row of nulls: every session recorded before the sampler existed would
// otherwise pad the document with entries carrying nothing, and the endpoint
// keys records into a map where an absent entry already means "unenriched".
func CompileMemory(events []Event, opts CompileOptions) MemoryDoc {
	sessions := aggregate(events)
	nowRFC := opts.Now.UTC().Format(time.RFC3339)

	// Same order as Compile: by start time, then id.
	sort.Slice(sessions, func(i, j int) bool {
		si, sj := sessStartTS(sessions[i]), sessStartTS(sessions[j])
		if si != sj {
			return si < sj
		}
		return sessions[i].id < sessions[j].id
	})

	doc := MemoryDoc{Window: opts.Window, Sessions: []MemorySession{}}
	for _, s := range sessions {
		startRFC := sessStartTS(s)
		endRFC := s.endTS
		unclosed := endRFC == ""
		if unclosed {
			endRFC = nowRFC
		}
		if !overlapsWindow(startRFC, endRFC, opts) {
			continue
		}
		pts := sortedMem(s.mem)
		if len(pts) == 0 {
			continue
		}
		// The same bound the lane gets. In practice nothing is ever cut here — a
		// container that died stops having a cgroup to read, so there are no
		// samples in the synthesized tail — but a figure the envelope would not
		// credit must not reappear on the hover that annotates it.
		if sus, ok := suspectTrailing(s, startRFC, endRFC, unclosed); ok {
			pts = clipPoints(pts, sus.trustedNs)
			if len(pts) == 0 {
				continue
			}
		}

		rec := MemorySession{
			SessionID: s.id,
			Agent:     orDefault(s.start.Agent, "arachne"),
			Project:   orDefault(s.start.Project, "arachne"),
			Mem:       make([]MemorySample, 0, len(pts)),
		}
		for _, p := range pts {
			if !p.sample {
				continue // an oom_kill reading contributes its peak, not a point
			}
			tree := p.tree
			rec.Mem = append(rec.Mem, MemorySample{TS: p.ts, Tree: &tree})
		}
		if peak, ok := peakBytes(pts); ok {
			rec.PeakTreeBytes = &peak
		}
		if avg, ok := timeWeightedAvg(pts); ok {
			rec.AvgTreeBytes = &avg
		}
		doc.Sessions = append(doc.Sessions, rec)
	}
	return doc
}

// memPoint is one parsed memory event. sample distinguishes a series point from
// an oom_kill, which carries a real reading but is not part of the series.
type memPoint struct {
	ts     string
	ns     int64
	tree   int64
	peak   int64
	sample bool
}

// sortedMem returns a run's samples in time order, without disturbing the
// collected slice.
//
// The samples are gathered in aggregate, where run ownership is known, but that
// is the only thing aggregate does with them: they are never touched into the
// evidence bound, so a sample still cannot influence a lane. Folding them in a
// separate pass keyed by session id — which is what this replaced — stopped
// working when a slug came to host a sequence of runs, because the fold had no
// way to tell which run a sample fell inside.
func sortedMem(pts []memPoint) []memPoint {
	if len(pts) < 2 {
		return pts
	}
	out := make([]memPoint, len(pts))
	copy(out, pts)
	sort.SliceStable(out, func(i, j int) bool { return out[i].ns < out[j].ns })
	return out
}

// clipPoints drops everything at or after a suspect lane's trusted bound.
func clipPoints(pts []memPoint, trustedNs int64) []memPoint {
	out := make([]memPoint, 0, len(pts))
	for _, p := range pts {
		if p.ns >= trustedNs {
			continue
		}
		out = append(out, p)
	}
	return out
}

// peakBytes returns the session's high-water mark.
//
// It prefers memory.peak, which the kernel maintains continuously, so the
// answer is exact no matter how sparsely the recorder sampled — that is what
// lets the sample cadence be slow without costing accuracy. The observed
// readings are folded in as a floor for the case where memory.peak was
// unavailable (an older kernel) and came through as zero.
func peakBytes(pts []memPoint) (int64, bool) {
	var peak int64
	found := false
	for _, p := range pts {
		for _, v := range [2]int64{p.peak, p.tree} {
			if v > 0 {
				found = true
			}
			if v > peak {
				peak = v
			}
		}
	}
	return peak, found
}

// timeWeightedAvg averages the series by how long each reading stood, which is
// what an instantaneous gauge sampled on a timer means: a value holds until the
// next one replaces it. A plain mean would let a burst of closely spaced
// readings outweigh a level that actually held for an hour.
//
// The final reading closes the series and so carries no weight of its own; a
// lone reading is its own average. Arithmetic goes through float64 because
// bytes times nanoseconds overflows int64 within seconds.
func timeWeightedAvg(pts []memPoint) (int64, bool) {
	sam := make([]memPoint, 0, len(pts))
	for _, p := range pts {
		if p.sample {
			sam = append(sam, p)
		}
	}
	if len(sam) == 0 {
		return 0, false
	}
	if len(sam) == 1 {
		return sam[0].tree, true
	}
	var weighted, total float64
	for i := 0; i+1 < len(sam); i++ {
		dt := float64(sam[i+1].ns - sam[i].ns)
		if dt <= 0 {
			continue
		}
		weighted += float64(sam[i].tree) * dt
		total += dt
	}
	if total <= 0 {
		return sam[len(sam)-1].tree, true // every reading landed on one instant
	}
	return int64(weighted / total), true
}
