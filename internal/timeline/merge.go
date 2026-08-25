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
			lane.Cost = mergeCostEstimates(nil, lane.Cost, lane.CostUSD, laneHasUsage(lane))
			lane.CostUSD = apiEquivalentAlias(lane.Cost)
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
		mergeUsageBreakdown(&out.Totals.Usage, t.Totals.Usage)
		out.Totals.PricingGroups = append(out.Totals.PricingGroups, t.Totals.PricingGroups...)
		out.Totals.VendorUsage = mergeVendorUsage(out.Totals.VendorUsage, t.Totals.VendorUsage)
		out.Totals.UsageCoverage = mergedIdentity(out.Totals.UsageCoverage, t.Totals.UsageCoverage)
		out.Totals.Cost = mergeCostEstimates(
			out.Totals.Cost,
			t.Totals.Cost,
			t.Totals.CostUSD,
			totalsHaveUsage(t.Totals),
		)
		out.Totals.CostUSD = apiEquivalentAlias(out.Totals.Cost)

		if out.PlanWindow == nil && t.PlanWindow != nil {
			out.PlanWindow = t.PlanWindow
		}
		mergeAgentTimeline(out, in)
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
	recomputeAgentUnions(out.AgentTimeline)

	if opts.Window != "" {
		out.Window = opts.Window
	}
	return out
}

// mergeCostEstimates combines like-for-like amounts while preserving absence.
// A legacy cost_usd is accepted as an API-equivalent amount, but marked partial
// because it carries neither billing semantics nor pricing provenance. Usage
// with no estimate creates an explicit unknown component instead of adding zero.
func mergeCostEstimates(dst, incoming *CostEstimate, legacy *float64, hasUsage bool) *CostEstimate {
	src := normalizeCostEstimate(incoming, legacy, hasUsage)
	if src == nil {
		return dst
	}
	if dst == nil {
		return src
	}

	dst.APIEquivalentUSD = sumOptionalFloat(dst.APIEquivalentUSD, src.APIEquivalentUSD)
	dst.VendorEstimatedUSD = sumOptionalFloat(dst.VendorEstimatedUSD, src.VendorEstimatedUSD)
	dst.PlanCredits = sumOptionalFloat(dst.PlanCredits, src.PlanCredits)
	dst.EstimatedBilledUSD = sumOptionalFloat(dst.EstimatedBilledUSD, src.EstimatedBilledUSD)
	dst.Status = mergedCostStatus(dst.Status, src.Status, costHasAmount(dst))
	dst.Legacy = dst.Legacy || src.Legacy
	dst.PricedUsageEvents += src.PricedUsageEvents
	dst.UnpricedUsageEvents += src.UnpricedUsageEvents
	dst.PricedTokens += src.PricedTokens
	dst.UnpricedTokens += src.UnpricedTokens
	dst.PricedToolUnits += src.PricedToolUnits
	dst.UnpricedToolUnits += src.UnpricedToolUnits
	dst.UnpricedEvents += src.UnpricedEvents
	dst.UnpricedReasons = mergeStrings(dst.UnpricedReasons, src.UnpricedReasons)

	if dst.Coverage != nil && src.Coverage != nil {
		// Event counts, when supplied, are the exact aggregate. Otherwise retain
		// the conservative minimum rather than averaging provider percentages
		// whose denominators may differ.
		v := min(*dst.Coverage, *src.Coverage)
		dst.Coverage = &v
	} else if dst.Coverage == nil && src.Coverage != nil {
		dst.Coverage = cloneFloat(src.Coverage)
	}
	if total := dst.PricedTokens + dst.UnpricedTokens + dst.PricedToolUnits + dst.UnpricedToolUnits; total > 0 {
		v := float64(dst.PricedTokens+dst.PricedToolUnits) / float64(total)
		dst.Coverage = &v
	} else if total := dst.PricedUsageEvents + dst.UnpricedUsageEvents; total > 0 {
		v := float64(dst.PricedUsageEvents) / float64(total)
		dst.Coverage = &v
	}

	dst.PricingSources = mergeStrings(costSources(dst), costSources(src))
	if len(dst.PricingSources) == 1 {
		dst.PricingSource = dst.PricingSources[0]
	} else if len(dst.PricingSources) > 1 {
		dst.PricingSource = ""
	}
	dst.PricingRetrievedAt = earlierTimestamp(dst.PricingRetrievedAt, src.PricingRetrievedAt)
	dst.PricingEffectiveAt = earlierTimestamp(dst.PricingEffectiveAt, src.PricingEffectiveAt)
	dst.PricingProvider = mergedIdentity(dst.PricingProvider, src.PricingProvider)
	dst.PricingVersions = mergeStrings(costVersions(dst), costVersions(src))
	version := mergedIdentity(dst.PricingVersion, src.PricingVersion)
	if len(dst.PricingVersions) == 1 {
		version = dst.PricingVersions[0]
	} else if len(dst.PricingVersions) > 1 {
		version = "mixed"
	}
	kind := mergedIdentity(dst.PricingKind, src.PricingKind)
	dst.MixedPricingVersions = dst.MixedPricingVersions || src.MixedPricingVersions ||
		len(dst.PricingVersions) > 1 || version == "mixed" || kind == "mixed" || dst.PricingProvider == "mixed"
	dst.PricingVersion = version
	dst.PricingKind = kind
	return dst
}

func normalizeCostEstimate(in *CostEstimate, legacy *float64, hasUsage bool) *CostEstimate {
	if in == nil {
		if legacy != nil {
			c := &CostEstimate{
				APIEquivalentUSD: cloneFloat(legacy),
				Status:           "partial",
				Legacy:           true,
			}
			if hasUsage {
				c.PricedUsageEvents = 1
				one := 1.0
				c.Coverage = &one
			}
			return c
		}
		if !hasUsage {
			return nil
		}
		zero := 0.0
		return &CostEstimate{Status: "unknown", Coverage: &zero, UnpricedUsageEvents: 1}
	}

	c := *in
	c.APIEquivalentUSD = cloneFloat(in.APIEquivalentUSD)
	c.VendorEstimatedUSD = cloneFloat(in.VendorEstimatedUSD)
	c.PlanCredits = cloneFloat(in.PlanCredits)
	c.EstimatedBilledUSD = cloneFloat(in.EstimatedBilledUSD)
	c.Coverage = cloneFloat(in.Coverage)
	c.PricingSources = append([]string(nil), in.PricingSources...)
	c.PricingVersions = append([]string(nil), in.PricingVersions...)
	c.UnpricedReasons = append([]string(nil), in.UnpricedReasons...)
	if c.PricingKind == "" {
		c.PricingKind = c.PriceKind
	}
	c.PriceKind = ""
	if c.PricingEffectiveAt == "" {
		c.PricingEffectiveAt = c.PricingAsOf
	}
	c.PricingAsOf = ""
	if c.APIEquivalentUSD == nil && legacy != nil {
		c.APIEquivalentUSD = cloneFloat(legacy)
	}
	if c.Status == "" {
		if costHasAmount(&c) {
			c.Status = "estimated"
		} else if hasUsage {
			c.Status = "unknown"
		}
	}
	if hasUsage && c.PricedUsageEvents == 0 && c.UnpricedUsageEvents == 0 && c.UnpricedEvents == 0 {
		if costHasAmount(&c) {
			c.PricedUsageEvents = 1
		} else {
			c.UnpricedUsageEvents = 1
		}
	}
	return &c
}

func sumOptionalFloat(a, b *float64) *float64 {
	if a == nil {
		return cloneFloat(b)
	}
	if b == nil {
		return a
	}
	v := *a + *b
	return &v
}

func cloneFloat(v *float64) *float64 {
	if v == nil {
		return nil
	}
	c := *v
	return &c
}

func costHasAmount(c *CostEstimate) bool {
	return c != nil && (c.APIEquivalentUSD != nil || c.VendorEstimatedUSD != nil ||
		c.PlanCredits != nil || c.EstimatedBilledUSD != nil)
}

func apiEquivalentAlias(c *CostEstimate) *float64 {
	if c == nil {
		return nil
	}
	return cloneFloat(c.APIEquivalentUSD)
}

func mergedCostStatus(a, b string, haveAmount bool) string {
	if a == "" {
		return b
	}
	if b == "" {
		return a
	}
	if a == "partial" || b == "partial" {
		return "partial"
	}
	if a == "unknown" || b == "unknown" {
		if haveAmount {
			return "partial"
		}
		return "unknown"
	}
	if a == "stale" || b == "stale" {
		return "stale"
	}
	if a == "included" && b == "included" {
		return "included"
	}
	return "estimated"
}

func costSources(c *CostEstimate) []string {
	if c == nil {
		return nil
	}
	values := append([]string(nil), c.PricingSources...)
	if c.PricingSource != "" {
		values = append(values, c.PricingSource)
	}
	return mergeStrings(nil, values)
}

func costVersions(c *CostEstimate) []string {
	if c == nil {
		return nil
	}
	values := append([]string(nil), c.PricingVersions...)
	if c.PricingVersion != "" && c.PricingVersion != "mixed" {
		values = append(values, c.PricingVersion)
	}
	return mergeStrings(nil, values)
}

// mergeVendorUsage preserves provider-native cumulative estimates as their own
// explicitly scoped aggregate. It never feeds those values into window token
// totals or API-equivalent cost.
func mergeVendorUsage(dst, src *VendorUsageAggregate) *VendorUsageAggregate {
	if src == nil {
		return dst
	}
	if dst == nil {
		copy := *src
		copy.Snapshots = append([]ScopedVendorUsage(nil), src.Snapshots...)
		copy.Cost = *normalizeCostEstimate(&src.Cost, nil, false)
		return &copy
	}
	dst.Snapshots = append(dst.Snapshots, src.Snapshots...)
	dst.Cost = *mergeCostEstimates(&dst.Cost, &src.Cost, nil, false)
	if dst.Scope != src.Scope {
		dst.Scope = "mixed_cumulative_snapshots"
	}
	return dst
}

func mergeStrings(a, b []string) []string {
	seen := make(map[string]bool, len(a)+len(b))
	out := make([]string, 0, len(a)+len(b))
	for _, values := range [][]string{a, b} {
		for _, value := range values {
			if value == "" || seen[value] {
				continue
			}
			seen[value] = true
			out = append(out, value)
		}
	}
	sort.Strings(out)
	return out
}

func earlierTimestamp(a, b string) string {
	if a == "" {
		return b
	}
	if b == "" {
		return a
	}
	at, aerr := time.Parse(time.RFC3339Nano, a)
	bt, berr := time.Parse(time.RFC3339Nano, b)
	if aerr == nil && berr == nil {
		if bt.Before(at) {
			return b
		}
		return a
	}
	if b < a {
		return b
	}
	return a
}

func mergedIdentity(a, b string) string {
	if a == "" {
		return b
	}
	if b == "" || a == b {
		return a
	}
	return "mixed"
}

func laneHasUsage(lane Lane) bool {
	return lane.TokIn != 0 || lane.TokOut != 0 || lane.TokCacheRead != 0 ||
		lane.TokCacheCreate != 0 || usageHasValues(lane.Usage)
}

func totalsHaveUsage(t Totals) bool {
	return t.TokIn != 0 || t.TokOut != 0 || t.TokCacheRead != 0 ||
		t.TokCacheCreate != 0 || usageHasValues(t.Usage)
}

func usageHasValues(u *UsageBreakdown) bool {
	return u != nil && *u != (UsageBreakdown{})
}

func mergeUsageBreakdown(dst **UsageBreakdown, src *UsageBreakdown) {
	if src == nil {
		return
	}
	if *dst == nil {
		copy := *src
		*dst = &copy
		return
	}
	d := *dst
	d.InputTokens += src.InputTokens
	d.CachedInputTokens += src.CachedInputTokens
	d.CacheWriteInputTokens += src.CacheWriteInputTokens
	d.CacheWrite5mInputTokens += src.CacheWrite5mInputTokens
	d.CacheWrite1hInputTokens += src.CacheWrite1hInputTokens
	d.OutputTokens += src.OutputTokens
	d.ReasoningOutputTokens += src.ReasoningOutputTokens
	d.TotalTokens += src.TotalTokens
	d.ModelContextWindow = max(d.ModelContextWindow, src.ModelContextWindow)
	d.WebSearchRequests += src.WebSearchRequests
	d.WebFetchRequests += src.WebFetchRequests
	d.CodeExecutionRequests += src.CodeExecutionRequests
	d.UnclassifiedServerToolUnits += src.UnclassifiedServerToolUnits
}

// mergeAgentTimeline preserves Switchboard's additive child-thread surface in
// a multi-provider response. Root ids are namespaced with the adapter id by the
// same rule as lane ids, so the frontend can join a child graph to its session
// without collisions. The root's own Provider field remains Claude/Codex: it is
// the graph semantics discriminator, not the subprocess adapter namespace.
func mergeAgentTimeline(out *Timeline, in Sourced) {
	if in.Timeline == nil || in.Timeline.AgentTimeline == nil {
		return
	}
	if out.AgentTimeline == nil {
		out.AgentTimeline = &AgentTimeline{Roots: []AgentRootTimeline{}}
	}
	src := in.Timeline.AgentTimeline
	for i, root := range src.Roots {
		root.SessionID = namespaceID(in.Provider, root.SessionID, root.PID, i)
		if root.Provider == "" {
			root.Provider = in.Provider
		}
		out.AgentTimeline.Roots = append(out.AgentTimeline.Roots, root)
	}
	out.AgentTimeline.Summary.AgentActivity += src.Summary.AgentActivity
	out.AgentTimeline.Summary.UserAttention += src.Summary.UserAttention
	out.AgentTimeline.Summary.ApprovalAttention += src.Summary.ApprovalAttention
	out.AgentTimeline.Summary.UserInputAttention += src.Summary.UserInputAttention
	out.AgentTimeline.Summary.SuspectSpans += src.Summary.SuspectSpans
	out.AgentTimeline.Summary.SuspectDuration += src.Summary.SuspectDuration
}

// recomputeAgentUnions handles the two canonical graph figures that cannot be
// added across providers. Suspect spans stay visible but carry no credit, just
// as they do in Switchboard's producer and in laneAloftSpans above.
func recomputeAgentUnions(agents *AgentTimeline) {
	if agents == nil {
		return
	}
	var activity, attention [][2]int64
	for _, root := range agents.Roots {
		for _, node := range root.Nodes {
			for _, span := range node.Activity {
				if span.Suspect {
					continue
				}
				if start, end, ok := SpanNanos(span.Start, span.End); ok {
					activity = append(activity, [2]int64{start, end})
				}
			}
			for _, span := range node.Attention {
				if span.Suspect {
					continue
				}
				if start, end, ok := SpanNanos(span.Start, span.End); ok {
					attention = append(attention, [2]int64{start, end})
				}
			}
		}
	}
	agents.Summary.ActivityUnion = UnionNanos(activity)
	agents.Summary.UserAttentionUnion = UnionNanos(attention)
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
