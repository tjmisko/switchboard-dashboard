package timeline

import "time"

// The plausibility caps for the trailing-interval post-check. They mirror
// internal/history/suspect.go in the switchboard daemon, which runs the same
// check for its own provider before the envelope ever reaches us; these copies
// exist for the providers this repo compiles itself (arachne), so a ghost looks
// the same whichever adapter produced it.
//
// Calibration (switchboard's 31-day corpus): the longest legitimate trailing
// interval observed was 2h25m, the shortest ghost 4h36m — 4h sits in that gap.
// Paired subagent spans topped out at 1h29m while reader-capped ones were all
// 10h+, so 2h separates them with room to spare.
const (
	DefaultSuspectTrailingCap = 4 * time.Hour
	DefaultSuspectSubagentCap = 2 * time.Hour
)

// trustedEndNanos is the last instant of a lane that is backed by evidence: its
// SuspectSince when the producer flagged it, otherwise its end. The bool is
// false when the lane is unflagged (or carries an unparsable SuspectSince), in
// which case the caller should treat the whole lane as trustworthy — a producer
// that does not run the check must not have its lanes silently clipped.
func trustedEndNanos(lane *Lane) (int64, bool) {
	if !lane.Suspect || lane.SuspectSince == "" {
		return 0, false
	}
	ns, ok := ParseNanos(lane.SuspectSince)
	if !ok {
		return 0, false
	}
	return ns, true
}

// clipToTrusted trims a span to the part of it that predates the lane's
// synthesized tail. Returns ok=false when the span lies entirely inside the
// tail, i.e. when there is nothing left to credit.
func clipToTrusted(start, end, trustedEnd int64) (int64, int64, bool) {
	if start >= trustedEnd {
		return 0, 0, false
	}
	if end > trustedEnd {
		end = trustedEnd
	}
	return start, end, true
}
