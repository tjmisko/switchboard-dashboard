package timeline

import (
	"sort"
	"strconv"
	"time"
)

// Sourced pairs a provider id with the envelope it produced, so Merge can tag
// and namespace lanes by origin.
type Sourced struct {
	Provider string
	Timeline *Timeline
}

// MergeOptions tunes the merged envelope.
type MergeOptions struct {
	// Window overrides the merged window label (e.g. the requested day/range).
	// When empty the first input's window is used.
	Window string
}

// Merge combines multiple provider envelopes into one unified envelope for the
// "merged, namespaced" dashboard view.
//
//   - Lanes from every provider are concatenated; each lane is tagged with its
//     provider id and its session_id namespaced as "<provider>:<id>" so ids never
//     collide across providers.
//   - Additive summary/totals fields are summed (this is exactly correct: they
//     are per-session or per-status sums).
//   - from/to become the min/max across providers.
//   - attention_union is the ONE non-additive field, so it is recomputed as the
//     cross-provider wall-clock during which at least one lane is "aloft"
//     (a working interval or a running subagent) — the same notion the
//     concurrency chart uses. It is therefore a genuine union, not a double-
//     counted sum.
//   - delegation_effectiveness is recomputed from the summed attended/delegated.
//   - plan_window is taken from the first provider that supplies one (a plan is a
//     single-account concept, not additive).
//   - operator activity is unioned across providers.
func Merge(inputs []Sourced, opts MergeOptions) *Timeline {
	out := &Timeline{
		Lanes:   []Lane{},
		Summary: Summary{ByStatus: map[string]int64{}},
	}

	var from, to string
	var promptSum, attendedSum, delegatedSum int64
	var havePrompt, haveAttended, haveDelegated bool
	var activityInputs [][]Activity

	for _, in := range inputs {
		t := in.Timeline
		if t == nil {
			continue
		}
		if out.Window == "" {
			out.Window = t.Window
		}

		for i := range t.Lanes {
			lane := t.Lanes[i] // struct copy; safe to mutate
			if lane.Provider == "" {
				lane.Provider = in.Provider
			}
			lane.SessionID = namespaceID(in.Provider, lane.SessionID, lane.PID, i)
			out.Lanes = append(out.Lanes, lane)
		}

		out.Summary.Sessions += t.Summary.Sessions
		for k, v := range t.Summary.ByStatus {
			out.Summary.ByStatus[k] += v
		}
		out.Summary.AttentionPerSession += t.Summary.AttentionPerSession
		out.Summary.AttentionFanout += t.Summary.AttentionFanout
		// Both are plain per-provider counts of what that provider already excluded
		// from the figures above, so they sum like the rest of the aggregates.
		out.Summary.SuspectLanes += t.Summary.SuspectLanes
		out.Summary.SuspectDuration += t.Summary.SuspectDuration
		if t.Summary.PromptActive != nil {
			promptSum += *t.Summary.PromptActive
			havePrompt = true
		}
		if t.Summary.AttendedActive != nil {
			attendedSum += *t.Summary.AttendedActive
			haveAttended = true
		}
		if t.Summary.DelegatedActive != nil {
			delegatedSum += *t.Summary.DelegatedActive
			haveDelegated = true
		}
		from = earlierNonEmpty(from, t.Summary.From)
		to = laterNonEmpty(to, t.Summary.To)

		out.Totals.TokIn += t.Totals.TokIn
		out.Totals.TokOut += t.Totals.TokOut
		out.Totals.TokCacheRead += t.Totals.TokCacheRead
		out.Totals.TokCacheCreate += t.Totals.TokCacheCreate
		out.Totals.Subagents += t.Totals.Subagents
		out.Totals.CostUSD += t.Totals.CostUSD

		if out.PlanWindow == nil && t.PlanWindow != nil {
			out.PlanWindow = t.PlanWindow
		}
		out.ProviderErrors = append(out.ProviderErrors, t.ProviderErrors...)
		if len(t.Activity) > 0 {
			activityInputs = append(activityInputs, t.Activity)
		}
	}

	out.Summary.From = from
	out.Summary.To = to
	if havePrompt {
		out.Summary.PromptActive = &promptSum
	}
	if haveAttended {
		out.Summary.AttendedActive = &attendedSum
	}
	if haveDelegated {
		out.Summary.DelegatedActive = &delegatedSum
	}
	if haveAttended && haveDelegated {
		if denom := attendedSum + delegatedSum; denom > 0 {
			eff := float64(delegatedSum) / float64(denom)
			out.Summary.DelegationEffectiveness = &eff
		}
	}

	var spans [][2]int64
	for i := range out.Lanes {
		spans = append(spans, laneAloftSpans(&out.Lanes[i])...)
	}
	out.Summary.AttentionUnion = UnionNanos(spans)

	out.Activity = mergeActivity(activityInputs)

	if opts.Window != "" {
		out.Window = opts.Window
	}
	return out
}

// namespaceID prefixes a lane's identity with its provider so merged sessions
// never collide. It mirrors the frontend's laneIdentity fallback (session_id,
// else pid) so identity is stable across a refresh.
func namespaceID(provider, sessionID string, pid, idx int) string {
	base := sessionID
	if base == "" {
		if pid != 0 {
			base = "pid:" + strconv.Itoa(pid)
		} else {
			base = "lane:" + strconv.Itoa(idx)
		}
	}
	if provider == "" {
		return base
	}
	return provider + ":" + base
}

// isActiveStatus reports whether an interval status is the parent thread's own
// agent work. It mirrors isActive in the switchboard daemon's
// internal/history/timeline.go, which is what its summary counts: "delegating"
// is the legacy spelling of a parent handing off to a subagent (superseded by
// "dormant", still present in older history), and the producer credits it, so
// attention_union must too or a merged day would undercount a legacy stream.
// Idle, permission, suspended, and dormant are not active — for dormant the
// subagent span carries the compute, and it is added separately below.
func isActiveStatus(status string) bool {
	return status == "working" || status == "delegating"
}

// laneAloftSpans is the lane's contribution to attention_union: the [startNs,
// endNs] windows during which it was "aloft" — every active interval plus every
// subagent span, left un-deduplicated because Merge unions them.
//
// A suspect lane contributes only the part of itself that predates its
// synthesized tail, and a suspect subagent span contributes nothing at all —
// otherwise the merged union would re-credit exactly the phantom time each
// provider's own summary already subtracted, and a merged day would disagree
// with the same day single-provider. web/model.js workIntervalsMs applies the
// same clip and the same phantom skip (via clipSpanMs) so the Go merge and the
// JS chart agree on which time is evidenced. The chart still omits
// delegating/dormant parents, which this counts: it plots INSTANTANEOUS fanout,
// where crediting a parent alongside the subagent it is waiting on would read as
// two agents aloft; a union cannot double-count, so the two differ only for
// legacy delegating time that no subagent span already covers.
func laneAloftSpans(lane *Lane) [][2]int64 {
	var out [][2]int64
	trustedEnd, clip := trustedEndNanos(lane)
	for _, iv := range lane.Intervals {
		if !isActiveStatus(iv.Status) {
			continue
		}
		s, e, ok := SpanNanos(iv.Start, iv.End)
		if !ok {
			continue
		}
		if clip {
			if s, e, ok = clipToTrusted(s, e, trustedEnd); !ok {
				continue
			}
		}
		out = append(out, [2]int64{s, e})
	}
	for _, sa := range lane.Subagents {
		if sa.Suspect {
			continue
		}
		s, e, ok := SpanNanos(sa.Start, sa.End)
		if !ok {
			continue
		}
		if clip {
			if s, e, ok = clipToTrusted(s, e, trustedEnd); !ok {
				continue
			}
		}
		out = append(out, [2]int64{s, e})
	}
	return out
}

// mergeActivity unions the "active" operator spans across providers and refills
// the gaps with idle, yielding an alternating timeline over the covered window.
// Returns nil when no provider supplied activity.
func mergeActivity(inputs [][]Activity) []Activity {
	if len(inputs) == 0 {
		return nil
	}
	var active [][2]int64
	var lo, hi int64
	haveBounds := false
	for _, acts := range inputs {
		for _, a := range acts {
			s, e, ok := SpanNanos(a.Start, a.End)
			if !ok {
				continue
			}
			if !haveBounds {
				lo, hi, haveBounds = s, e, true
			} else {
				if s < lo {
					lo = s
				}
				if e > hi {
					hi = e
				}
			}
			if a.State == "active" {
				active = append(active, [2]int64{s, e})
			}
		}
	}
	if !haveBounds {
		return nil
	}
	merged := unionSpans(active)
	var out []Activity
	cursor := lo
	for _, sp := range merged {
		if sp[0] > cursor {
			out = append(out, Activity{State: "idle", Start: NanoToRFC(cursor), End: NanoToRFC(sp[0])})
		}
		out = append(out, Activity{State: "active", Start: NanoToRFC(sp[0]), End: NanoToRFC(sp[1])})
		cursor = sp[1]
	}
	if cursor < hi {
		out = append(out, Activity{State: "idle", Start: NanoToRFC(cursor), End: NanoToRFC(hi)})
	}
	return out
}

// --- shared time helpers (exported for the arachne compiler) ---

// ParseNanos parses an RFC3339 (with or without fractional seconds) timestamp to
// Unix nanoseconds. ok is false for empty/unparseable input.
func ParseNanos(s string) (int64, bool) {
	if s == "" {
		return 0, false
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return 0, false
	}
	return t.UnixNano(), true
}

// SpanNanos parses a start/end pair, returning ok only for a strictly positive
// span with both endpoints parseable.
func SpanNanos(start, end string) (int64, int64, bool) {
	s, ok1 := ParseNanos(start)
	e, ok2 := ParseNanos(end)
	if !ok1 || !ok2 || e <= s {
		return 0, 0, false
	}
	return s, e, true
}

// NanoToRFC formats Unix nanoseconds as an RFC3339 UTC timestamp.
func NanoToRFC(n int64) string {
	return time.Unix(0, n).UTC().Format(time.RFC3339)
}

// unionSpans merges overlapping/adjacent [start,end] spans into sorted,
// non-overlapping spans.
func unionSpans(spans [][2]int64) [][2]int64 {
	if len(spans) == 0 {
		return nil
	}
	cp := make([][2]int64, len(spans))
	copy(cp, spans)
	sort.Slice(cp, func(i, j int) bool { return cp[i][0] < cp[j][0] })
	out := [][2]int64{cp[0]}
	for _, sp := range cp[1:] {
		last := &out[len(out)-1]
		if sp[0] > last[1] {
			out = append(out, sp)
		} else if sp[1] > last[1] {
			last[1] = sp[1]
		}
	}
	return out
}

// UnionNanos returns the total length of the union of the given spans.
func UnionNanos(spans [][2]int64) int64 {
	var total int64
	for _, sp := range unionSpans(spans) {
		total += sp[1] - sp[0]
	}
	return total
}

func earlierNonEmpty(a, b string) string {
	if a == "" {
		return b
	}
	if b == "" {
		return a
	}
	ta, oka := ParseNanos(a)
	tb, okb := ParseNanos(b)
	if !oka {
		return b
	}
	if !okb {
		return a
	}
	if tb < ta {
		return b
	}
	return a
}

func laterNonEmpty(a, b string) string {
	if a == "" {
		return b
	}
	if b == "" {
		return a
	}
	ta, oka := ParseNanos(a)
	tb, okb := ParseNanos(b)
	if !oka {
		return b
	}
	if !okb {
		return a
	}
	if tb > ta {
		return b
	}
	return a
}
