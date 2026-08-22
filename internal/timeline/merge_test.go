package timeline

import "testing"

func ptrI64(v int64) *int64 { return &v }

// twoProviders builds two single-lane envelopes with overlapping working
// intervals so union-vs-sum behavior is observable.
func twoProviders() []Sourced {
	a := &Timeline{
		Window: "2026-06-26",
		Lanes: []Lane{{
			SessionID: "sess-a",
			PID:       111,
			Agent:     "claude",
			Project:   "alpha",
			Start:     "2026-06-26T10:00:00Z",
			End:       "2026-06-26T10:30:00Z",
			Intervals: []Interval{{Status: "working", Start: "2026-06-26T10:00:00Z", End: "2026-06-26T10:30:00Z"}},
			CostUSD:   2.0,
			TokIn:     100,
		}},
		Summary: Summary{
			From: "2026-06-26T10:00:00Z", To: "2026-06-26T10:30:00Z",
			Sessions: 1, ByStatus: map[string]int64{"working": 1800000000000},
			AttentionPerSession: 1800000000000, AttentionFanout: 1800000000000,
			AttendedActive: ptrI64(100000000000), DelegatedActive: ptrI64(300000000000),
		},
		Totals:     Totals{TokIn: 100, CostUSD: 2.0, Subagents: 0},
		PlanWindow: &PlanWindow{Hours: 5, CostUSD: 5.0},
	}
	b := &Timeline{
		Window: "2026-06-26",
		Lanes: []Lane{{
			SessionID: "sess-b",
			Agent:     "opus",
			Project:   "beta",
			Start:     "2026-06-26T10:15:00Z",
			End:       "2026-06-26T10:45:00Z",
			Intervals: []Interval{{Status: "working", Start: "2026-06-26T10:15:00Z", End: "2026-06-26T10:45:00Z"}},
			CostUSD:   1.0,
			TokIn:     50,
		}},
		Summary: Summary{
			From: "2026-06-26T10:15:00Z", To: "2026-06-26T10:45:00Z",
			Sessions: 1, ByStatus: map[string]int64{"working": 1800000000000},
			AttentionPerSession: 1800000000000, AttentionFanout: 1800000000000,
		},
		Totals:     Totals{TokIn: 50, CostUSD: 1.0, Subagents: 2},
		PlanWindow: &PlanWindow{Hours: 5, CostUSD: 9.0},
	}
	return []Sourced{{Provider: "claude", Timeline: a}, {Provider: "arachne", Timeline: b}}
}

func TestMerge_shouldNamespaceSessionIDsAndTagProviderWhenMerging(t *testing.T) {
	out := Merge(twoProviders(), MergeOptions{})
	if len(out.Lanes) != 2 {
		t.Fatalf("expected 2 lanes, got %d", len(out.Lanes))
	}
	byID := map[string]Lane{}
	for _, l := range out.Lanes {
		byID[l.SessionID] = l
	}
	if _, ok := byID["claude:sess-a"]; !ok {
		t.Fatalf("expected namespaced id claude:sess-a, got %v", keysOf(byID))
	}
	if _, ok := byID["arachne:sess-b"]; !ok {
		t.Fatalf("expected namespaced id arachne:sess-b, got %v", keysOf(byID))
	}
	if byID["claude:sess-a"].Provider != "claude" || byID["arachne:sess-b"].Provider != "arachne" {
		t.Fatalf("lanes not tagged with provider: %+v", out.Lanes)
	}
}

func TestMerge_shouldSumAdditiveSummaryAndTotalsWhenMerging(t *testing.T) {
	out := Merge(twoProviders(), MergeOptions{})
	if out.Summary.Sessions != 2 {
		t.Fatalf("sessions = %d, want 2", out.Summary.Sessions)
	}
	if out.Summary.ByStatus["working"] != 3600000000000 {
		t.Fatalf("by_status.working = %d, want 3.6e12", out.Summary.ByStatus["working"])
	}
	if out.Summary.AttentionPerSession != 3600000000000 {
		t.Fatalf("attention_per_session = %d, want 3.6e12", out.Summary.AttentionPerSession)
	}
	if out.Totals.TokIn != 150 || out.Totals.CostUSD != 3.0 || out.Totals.Subagents != 2 {
		t.Fatalf("totals not summed: %+v", out.Totals)
	}
}

func TestMerge_shouldRecomputeAttentionUnionAsCrossProviderUnionNotSum(t *testing.T) {
	out := Merge(twoProviders(), MergeOptions{})
	// A: 10:00-10:30, B: 10:15-10:45 → union 10:00-10:45 = 45min = 2.7e12 ns.
	// A naive sum would be 60min = 3.6e12; the union proves overlap is not double-counted.
	const want = int64(2700000000000)
	if out.Summary.AttentionUnion != want {
		t.Fatalf("attention_union = %d, want %d (union, not sum)", out.Summary.AttentionUnion, want)
	}
}

func TestMerge_shouldSpanFromToAcrossProvidersWhenMerging(t *testing.T) {
	out := Merge(twoProviders(), MergeOptions{})
	if out.Summary.From != "2026-06-26T10:00:00Z" {
		t.Fatalf("from = %q, want earliest 10:00", out.Summary.From)
	}
	if out.Summary.To != "2026-06-26T10:45:00Z" {
		t.Fatalf("to = %q, want latest 10:45", out.Summary.To)
	}
}

func TestMerge_shouldRecomputeDelegationEffectivenessFromSummedComponents(t *testing.T) {
	out := Merge(twoProviders(), MergeOptions{})
	if out.Summary.DelegationEffectiveness == nil {
		t.Fatalf("expected delegation_effectiveness to be recomputed")
	}
	// delegated 300 / (attended 100 + delegated 300) = 0.75
	if got := *out.Summary.DelegationEffectiveness; got < 0.749 || got > 0.751 {
		t.Fatalf("delegation_effectiveness = %v, want 0.75", got)
	}
}

func TestMerge_shouldTakePlanWindowFromFirstProviderThatSuppliesOne(t *testing.T) {
	out := Merge(twoProviders(), MergeOptions{})
	if out.PlanWindow == nil || out.PlanWindow.CostUSD != 5.0 {
		t.Fatalf("plan_window = %+v, want first provider's (cost 5.0)", out.PlanWindow)
	}
}

func TestMerge_shouldOverrideWindowLabelWhenOptionSet(t *testing.T) {
	out := Merge(twoProviders(), MergeOptions{Window: "2026-06-26..2026-06-27"})
	if out.Window != "2026-06-26..2026-06-27" {
		t.Fatalf("window = %q, want overridden range", out.Window)
	}
}

func TestMerge_shouldPreserveNamespaceAndUnionCanonicalAgentTimelines(t *testing.T) {
	const minute = int64(60 * 1e9)
	inputs := []Sourced{
		{Provider: "host", Timeline: &Timeline{
			AgentTimeline: &AgentTimeline{
				Roots: []AgentRootTimeline{{
					SessionID: "root-a", PID: 11, Provider: "codex",
					Nodes: []AgentTimelineNode{{
						ThreadID: "child-a", ParentThreadID: "root-a", Depth: 1,
						Activity:  []AgentActivitySpan{{Start: "2026-06-26T10:05:00Z", End: "2026-06-26T10:20:00Z"}},
						Attention: []AgentAttentionSpan{{Reason: "approval", Start: "2026-06-26T10:10:00Z", End: "2026-06-26T10:15:00Z"}},
					}},
				}},
				Summary: AgentSummary{AgentActivity: 15 * minute, UserAttention: 5 * minute, ApprovalAttention: 5 * minute},
			},
			Summary: Summary{ByStatus: map[string]int64{}},
		}},
		{Provider: "remote", Timeline: &Timeline{
			AgentTimeline: &AgentTimeline{
				Roots: []AgentRootTimeline{{
					SessionID: "root-b", PID: 22, Provider: "claude",
					Nodes: []AgentTimelineNode{{
						ThreadID: "child-b", ParentThreadID: "root-b", Depth: 1,
						Activity:  []AgentActivitySpan{{Start: "2026-06-26T10:10:00Z", End: "2026-06-26T10:25:00Z"}},
						Attention: []AgentAttentionSpan{{Reason: "user_input", Start: "2026-06-26T10:12:00Z", End: "2026-06-26T10:18:00Z"}},
					}},
				}},
				Summary: AgentSummary{AgentActivity: 15 * minute, UserAttention: 6 * minute, UserInputAttention: 6 * minute},
			},
			Summary: Summary{ByStatus: map[string]int64{}},
		}},
	}

	out := Merge(inputs, MergeOptions{})
	if out.AgentTimeline == nil || len(out.AgentTimeline.Roots) != 2 {
		t.Fatalf("agent_timeline = %+v, want two roots", out.AgentTimeline)
	}
	if got := out.AgentTimeline.Roots[0]; got.SessionID != "host:root-a" || got.Provider != "codex" {
		t.Fatalf("first root = %+v, want namespaced id with Codex semantics retained", got)
	}
	if got := out.AgentTimeline.Roots[1]; got.SessionID != "remote:root-b" || got.Provider != "claude" {
		t.Fatalf("second root = %+v, want namespaced id with Claude semantics retained", got)
	}
	summary := out.AgentTimeline.Summary
	if summary.AgentActivity != 30*minute || summary.ActivityUnion != 20*minute {
		t.Fatalf("agent activity = sum %d / union %d, want 30m / 20m", summary.AgentActivity, summary.ActivityUnion)
	}
	if summary.UserAttention != 11*minute || summary.UserAttentionUnion != 8*minute {
		t.Fatalf("user attention = sum %d / union %d, want 11m / 8m", summary.UserAttention, summary.UserAttentionUnion)
	}
	if summary.ApprovalAttention != 5*minute || summary.UserInputAttention != 6*minute {
		t.Fatalf("attention reasons lost: %+v", summary)
	}
}

// oneLane wraps a single lane as a single provider's envelope.
func oneLane(lane Lane) []Sourced {
	return []Sourced{{Provider: "claude", Timeline: &Timeline{
		Lanes:   []Lane{lane},
		Summary: Summary{ByStatus: map[string]int64{}},
	}}}
}

func TestMerge_shouldCountDelegatingIntervalsAsActiveLikeTheProducer(t *testing.T) {
	// "delegating" is the legacy spelling of a parent handing off to a subagent,
	// superseded by "dormant" but still present in older history. The producer's
	// isActive counts it, so a merged day that skipped it would report 1h where
	// the same day single-provider reports 3h.
	lane := Lane{
		SessionID: "legacy",
		Start:     "2026-07-22T06:00:00Z",
		End:       "2026-07-22T09:00:00Z",
		Intervals: []Interval{
			{Status: "working", Start: "2026-07-22T06:00:00Z", End: "2026-07-22T07:00:00Z"},
			{Status: "delegating", Start: "2026-07-22T07:00:00Z", End: "2026-07-22T09:00:00Z"},
		},
	}
	out := Merge(oneLane(lane), MergeOptions{})
	if want := int64(3 * 3600 * 1e9); out.Summary.AttentionUnion != want {
		t.Errorf("attention_union = %d, want %d (working + delegating)", out.Summary.AttentionUnion, want)
	}
}

func TestMerge_shouldNotDoubleCountDelegatingTimeItsSubagentSpanAlreadyCovers(t *testing.T) {
	// The union is what protects us here: a legacy lane can carry BOTH the
	// delegating interval and the subagent span it was waiting on, and the
	// overlapping wall-clock must be credited once.
	lane := Lane{
		SessionID: "legacy",
		Start:     "2026-07-22T06:00:00Z",
		End:       "2026-07-22T09:00:00Z",
		Intervals: []Interval{
			{Status: "working", Start: "2026-07-22T06:00:00Z", End: "2026-07-22T07:00:00Z"},
			{Status: "delegating", Start: "2026-07-22T07:00:00Z", End: "2026-07-22T09:00:00Z"},
		},
		Subagents: []Subagent{{AgentType: "Explore", Start: "2026-07-22T07:00:00Z", End: "2026-07-22T09:00:00Z"}},
	}
	out := Merge(oneLane(lane), MergeOptions{})
	if want := int64(3 * 3600 * 1e9); out.Summary.AttentionUnion != want {
		t.Errorf("attention_union = %d, want %d (the delegated hours counted once)", out.Summary.AttentionUnion, want)
	}
}

func TestMerge_shouldNotCountADormantIntervalAsActiveOnItsOwn(t *testing.T) {
	// dormant is the modern status for the same waiting, and the producer does NOT
	// count it: the subagent span is what carries the compute. Widening the active
	// set to delegating must not have swept dormant in with it.
	lane := Lane{
		SessionID: "modern",
		Start:     "2026-07-22T06:00:00Z",
		End:       "2026-07-22T09:00:00Z",
		Intervals: []Interval{
			{Status: "working", Start: "2026-07-22T06:00:00Z", End: "2026-07-22T07:00:00Z"},
			{Status: "dormant", Start: "2026-07-22T07:00:00Z", End: "2026-07-22T09:00:00Z"},
		},
	}
	out := Merge(oneLane(lane), MergeOptions{})
	if want := int64(3600 * 1e9); out.Summary.AttentionUnion != want {
		t.Errorf("attention_union = %d, want %d (the working hour only)", out.Summary.AttentionUnion, want)
	}
}

func keysOf(m map[string]Lane) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
