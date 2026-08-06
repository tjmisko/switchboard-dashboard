package flags

import (
	"sort"

	"github.com/tjmisko/switchboard-dashboard/internal/timeline"
)

// Apply rewrites tl in place according to the active overlays in records, and
// returns what it changed for the envelope's flags_applied list.
//
// Summary and Totals are left alone — see timeline.FlagApplied for why. Nothing
// here touches the producer's data on disk; this is the last step before the
// envelope is handed to the browser, and re-running the producer yields the
// original lanes unchanged.
//
// Returns nil when no overlay matched, which the caller uses to keep the
// single-provider fast path byte-verbatim.
func Apply(tl *timeline.Timeline, records map[string]Record) []timeline.FlagApplied {
	if tl == nil || len(records) == 0 {
		return nil
	}

	// Index the active overlays by the lane they name. A record whose lane is not
	// in this window simply never matches — flags outlive the day they were filed
	// on, and asking for last Tuesday must not resurrect last Tuesday's repairs.
	active := map[string]Record{}
	for _, record := range records {
		if record.Active() {
			active[record.Key()] = record
		}
	}
	if len(active) == 0 {
		return nil
	}

	var applied []timeline.FlagApplied
	kept := make([]timeline.Lane, 0, len(tl.Lanes))
	// merges are resolved after the pass, because a lane may be folded into a
	// sibling that appears later in Lanes and has not been visited yet.
	type pendingMerge struct {
		lane   timeline.Lane
		record Record
	}
	var merges []pendingMerge

	for _, lane := range tl.Lanes {
		record, ok := active[Key(lane.SessionID, lane.Start)]
		if !ok {
			kept = append(kept, lane)
			continue
		}

		switch record.Action.Type {
		case ActionSuppress:
			applied = append(applied, note(record, lane, laneNanos(lane)))

		case ActionClipAt:
			clipped, removed, ok := clipLane(lane, record.Action.ClipAt)
			if !ok {
				// An unparseable or out-of-range clip point is not a licence to drop
				// the lane. Leave it whole and say nothing was applied.
				kept = append(kept, lane)
				continue
			}
			kept = append(kept, clipped)
			applied = append(applied, note(record, lane, removed))

		case ActionMergeInto:
			merges = append(merges, pendingMerge{lane: lane, record: record})

		default:
			kept = append(kept, lane)
		}
	}

	for _, merge := range merges {
		target := Key(merge.lane.SessionID, merge.record.Action.MergeIntoLaneStart)
		index := -1
		for i := range kept {
			if Key(kept[i].SessionID, kept[i].Start) == target {
				index = i
				break
			}
		}
		if index < 0 {
			// The lane to merge into is not in this window (or was itself
			// suppressed). Keeping the orphan is the conservative answer: the
			// operator asked to relocate this data, not to lose it.
			kept = append(kept, merge.lane)
			continue
		}
		kept[index] = mergeLanes(kept[index], merge.lane)
		applied = append(applied, note(merge.record, merge.lane, 0))
	}

	tl.Lanes = kept
	tl.FlagsApplied = append(tl.FlagsApplied, applied...)
	return applied
}

func note(record Record, lane timeline.Lane, removed int64) timeline.FlagApplied {
	return timeline.FlagApplied{
		Key:       record.Key(),
		SessionID: lane.SessionID,
		LaneStart: lane.Start,
		Action:    string(record.Action.Type),
		Verdict:   record.Verdict,
		RemovedNS: removed,
	}
}

// laneNanos is a lane's wall-clock span, or 0 when its bounds do not parse.
func laneNanos(lane timeline.Lane) int64 {
	start, end, ok := timeline.SpanNanos(lane.Start, lane.End)
	if !ok {
		return 0
	}
	return end - start
}

// clipLane truncates a lane at `at`, dropping intervals that begin at or after
// it and shortening the one that straddles it. Returns ok=false when `at` is
// unparseable or falls outside the lane, since neither is a repair — it would
// either do nothing or erase the lane, and both deserve to be refused loudly
// rather than performed quietly.
func clipLane(lane timeline.Lane, at string) (timeline.Lane, int64, bool) {
	cut, ok := timeline.ParseNanos(at)
	if !ok {
		return lane, 0, false
	}
	start, end, ok := timeline.SpanNanos(lane.Start, lane.End)
	if !ok || cut <= start || cut >= end {
		return lane, 0, false
	}

	intervals := make([]timeline.Interval, 0, len(lane.Intervals))
	for _, iv := range lane.Intervals {
		ivStart, ok := timeline.ParseNanos(iv.Start)
		if !ok {
			intervals = append(intervals, iv)
			continue
		}
		if ivStart >= cut {
			continue
		}
		if ivEnd, ok := timeline.ParseNanos(iv.End); ok && ivEnd > cut {
			iv.End = at
		}
		intervals = append(intervals, iv)
	}

	lane.Intervals = intervals
	lane.End = at
	// The clip supersedes the producer's own trailing-interval flag: the tail it
	// was warning about is the tail we just removed, and leaving the lane marked
	// suspect would keep the UI hatching a stretch that no longer exists.
	lane.Suspect = false
	lane.SuspectReason = ""
	lane.SuspectSince = ""
	return lane, end - cut, true
}

// mergeLanes folds src into dst: one lane the reader split in two becomes one
// lane again. Intervals, subagent spans and focus spans are concatenated and
// re-sorted; token and cost figures add; the bounds widen to cover both.
//
// This is the repair for a genuine split — two halves that each hold observed
// events. It is the wrong repair for a lane that is pure synthesis, because it
// would import that synthesis into a lane that was fine: those get suppressed.
func mergeLanes(dst, src timeline.Lane) timeline.Lane {
	dst.Intervals = sortIntervals(append(dst.Intervals, src.Intervals...))
	dst.Subagents = append(dst.Subagents, src.Subagents...)
	dst.Focus = append(dst.Focus, src.Focus...)
	dst.Labels = sortSpans(append(dst.Labels, src.Labels...))
	dst.Names = sortSpans(append(dst.Names, src.Names...))

	dst.CostUSD += src.CostUSD
	dst.TokIn += src.TokIn
	dst.TokOut += src.TokOut
	dst.TokCacheRead += src.TokCacheRead
	dst.TokCacheCreate += src.TokCacheCreate

	if earlier(src.Start, dst.Start) {
		dst.Start = src.Start
	}
	if earlier(dst.End, src.End) {
		dst.End = src.End
	}
	// The absorbed lane may have carried the name; a merged lane that rendered
	// unnamed would be a visible regression from the split it repaired.
	if dst.Name == "" {
		dst.Name = src.Name
	}
	return dst
}

// earlier reports a < b, treating an unparseable timestamp as "not earlier" so a
// malformed bound never widens a lane.
func earlier(a, b string) bool {
	an, aok := timeline.ParseNanos(a)
	bn, bok := timeline.ParseNanos(b)
	if !aok || !bok {
		return false
	}
	return an < bn
}

func sortIntervals(intervals []timeline.Interval) []timeline.Interval {
	sort.SliceStable(intervals, func(i, j int) bool {
		return earlier(intervals[i].Start, intervals[j].Start)
	})
	return intervals
}

func sortSpans(spans []timeline.Span) []timeline.Span {
	sort.SliceStable(spans, func(i, j int) bool {
		return earlier(spans[i].Start, spans[j].Start)
	})
	return spans
}
