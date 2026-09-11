// Package timeline defines the normalized "timeline envelope" that every
// Switchboard data provider emits and the dashboard renders. The envelope is the
// stable adapter contract: a provider observes some source (Claude Code history,
// Arachne docker sessions, …) and turns it into this shape. The frontend knows
// only this contract, so any source that can produce a valid envelope plugs in
// unchanged.
//
// Units are load-bearing and identical across providers:
//   - durations are NANOSECONDS (by_status, attention_*),
//   - token fields are RAW COUNTS,
//   - deprecated cost_usd and every field under cost are dollar FLOATS,
//   - all timestamps are RFC3339 strings.
//
// The struct set below models every field the dashboard currently reads. The
// single-provider path proxies bytes verbatim (see the dashboard handler), so it
// never loses unknown/future fields; only the multi-provider Merge path
// round-trips through these structs, so a new envelope field that must survive a
// merge has to be added here.
package timeline

import "encoding/json"

// Timeline is the top-level envelope.
type Timeline struct {
	Window         string          `json:"window"`
	Lanes          []Lane          `json:"lanes"`
	Summary        Summary         `json:"summary"`
	Totals         Totals          `json:"totals"`
	Activity       []Activity      `json:"activity,omitempty"`
	AgentTimeline  *AgentTimeline  `json:"agent_timeline,omitempty"`
	PlanWindow     *PlanWindow     `json:"plan_window,omitempty"`
	ProviderErrors []ProviderError `json:"provider_errors,omitempty"`
}

// Lane is one session's bar. Identity is keyed by session_id (falling back to
// pid). Agent names the semantic agent implementation (for example claude or
// codex); Provider names the adapter namespace used to merge it. A Switchboard
// adapter can therefore emit both semantic kinds without flattening their UI
// identity or colliding with another adapter's session ids.
type Lane struct {
	SessionID   string     `json:"session_id,omitempty"`
	PID         int        `json:"pid,omitempty"`
	Agent       string     `json:"agent,omitempty"`
	Provider    string     `json:"provider,omitempty"`
	Project     string     `json:"project,omitempty"`
	ProjectFull string     `json:"project_full,omitempty"`
	Start       string     `json:"start"`
	End         string     `json:"end"`
	Intervals   []Interval `json:"intervals"`
	Labels      []Span     `json:"labels,omitempty"`
	Name        string     `json:"name,omitempty"`
	Names       []Span     `json:"names,omitempty"`
	Subagents   []Subagent `json:"subagents,omitempty"`
	Focus       []TimeSpan `json:"focus,omitempty"`
	// CostUSD is the nullable deprecated wire alias for Cost.APIEquivalentUSD. It
	// is retained for schema compatibility but never accepted as the source of a
	// dashboard estimate. A supported structured Cost distinguishes unknown from
	// an explicit zero.
	CostUSD *float64      `json:"cost_usd,omitempty"`
	Cost    *CostEstimate `json:"cost,omitempty"`
	// PricingGroups retain the exact provider/model/route dimensions used to
	// price this lane. VendorUsage is provider-native cumulative corroboration;
	// it is deliberately separate from additive window cost.
	PricingGroups []PricingGroup        `json:"pricing_groups,omitempty"`
	VendorUsage   *VendorUsageAggregate `json:"vendor_usage,omitempty"`
	UsageCoverage string                `json:"usage_coverage,omitempty"`

	// Agent is the client implementation. These fields identify who executed and
	// billed the request; neither can safely be inferred from Agent alone.
	ExecutionProvider string `json:"execution_provider,omitempty"`
	BillingRoute      string `json:"billing_route,omitempty"`
	Model             string `json:"model,omitempty"`
	ServiceTier       string `json:"service_tier,omitempty"`
	Speed             string `json:"speed,omitempty"`
	InferenceGeo      string `json:"inference_geo,omitempty"`
	ReasoningEffort   string `json:"reasoning_effort,omitempty"`

	TokIn          int64           `json:"tok_in,omitempty"`
	TokOut         int64           `json:"tok_out,omitempty"`
	TokCacheRead   int64           `json:"tok_cache_read,omitempty"`
	TokCacheCreate int64           `json:"tok_cache_create,omitempty"`
	Usage          *UsageBreakdown `json:"usage,omitempty"`

	// Suspect and friends carry the producer's trailing-interval plausibility
	// post-check: the lane's length is an artifact of the end bound rather than of
	// anything observed. Start/End/Intervals are NOT truncated — SuspectSince is
	// the last instant with evidence behind it, and everything from there to End is
	// synthesized. Consumers render the tail as untrusted rather than hiding it,
	// and must not credit it as work. Producers that do not run the check omit all
	// three, so an unflagged lane is indistinguishable from today's envelope.
	Suspect       bool   `json:"suspect,omitempty"`
	SuspectReason string `json:"suspect_reason,omitempty"`
	SuspectSince  string `json:"suspect_since,omitempty"`
}

// Interval is one status segment of a lane. Subagents is the count of subagents
// running during a delegating segment (0 when absent).
type Interval struct {
	Status    string `json:"status"`
	Start     string `json:"start"`
	End       string `json:"end"`
	Subagents int    `json:"subagents,omitempty"`
}

// Span is a labeled sub-interval (used for labels[] and names[] history).
type Span struct {
	Label string `json:"label"`
	Start string `json:"start"`
	End   string `json:"end"`
}

// Subagent is one delegated Task sub-bar drawn under its parent lane.
type Subagent struct {
	AgentType   string `json:"agent_type"`
	ToolUseID   string `json:"tool_use_id"`
	Description string `json:"description,omitempty"`
	Start       string `json:"start"`
	End         string `json:"end"`

	// Suspect marks a span the producer closed at the lane's bound rather than at
	// an observed stop, and which ran too long to be a plausible unit of delegated
	// work. The span is still emitted in full; it is simply not credited as
	// compute, and the UI draws it as a phantom.
	Suspect       bool   `json:"suspect,omitempty"`
	SuspectReason string `json:"suspect_reason,omitempty"`
}

// TimeSpan is an unlabeled [start,end] window (used for focus[]).
type TimeSpan struct {
	Start string `json:"start"`
	End   string `json:"end"`
}

// Activity is one operator-activity segment (active vs idle wall-clock).
type Activity struct {
	State string `json:"state"`
	Start string `json:"start"`
	End   string `json:"end"`
}

// AgentTimeline is Switchboard's provider-neutral child-thread surface. Root
// work remains in Lanes; only descendants appear here, so a consumer can layer
// Claude or Codex child agents beneath the owning session without counting the
// root twice. It is additive to the legacy Lane.Subagents projection because
// Claude emits both during the graph migration while Codex has only this form.
type AgentTimeline struct {
	Roots   []AgentRootTimeline `json:"roots"`
	Summary AgentSummary        `json:"summary"`
}

// AgentRootTimeline groups child nodes under their owning provider root.
type AgentRootTimeline struct {
	SessionID     string              `json:"session_id,omitempty"`
	PID           int                 `json:"pid,omitempty"`
	Provider      string              `json:"provider,omitempty"`
	Nodes         []AgentTimelineNode `json:"nodes"`
	AgentActivity int64               `json:"agent_activity"`
	UserAttention int64               `json:"user_attention"`
}

// AgentTimelineNode is one provider-neutral child thread. Runtime, attention,
// and lifecycle are the last observed values for display; Activity and
// Attention carry the historical intervals the dashboard can draw and account
// for. Structural presence alone is not activity: a topology-only node can
// legitimately have no Activity spans.
type AgentTimelineNode struct {
	ThreadID       string               `json:"thread_id"`
	ParentThreadID string               `json:"parent_thread_id,omitempty"`
	Nickname       string               `json:"nickname,omitempty"`
	Role           string               `json:"role,omitempty"`
	Depth          int                  `json:"depth"`
	Runtime        string               `json:"runtime"`
	AttentionState string               `json:"attention_state"`
	Lifecycle      string               `json:"lifecycle"`
	Activity       []AgentActivitySpan  `json:"activity,omitempty"`
	Attention      []AgentAttentionSpan `json:"attention,omitempty"`
}

// AgentActivitySpan is one child thread's pending/running interval. A child can
// stop and later restart, so one AgentTimelineNode may carry several disjoint
// spans with the same stable ThreadID.
type AgentActivitySpan struct {
	Start         string `json:"start"`
	End           string `json:"end"`
	Suspect       bool   `json:"suspect,omitempty"`
	SuspectReason string `json:"suspect_reason,omitempty"`
}

// AgentAttentionSpan is a child wait that requires the operator. Reason stays
// split between approval and user_input so the UI can say what is blocked.
type AgentAttentionSpan struct {
	Reason        string `json:"reason"`
	Start         string `json:"start"`
	End           string `json:"end"`
	Suspect       bool   `json:"suspect,omitempty"`
	SuspectReason string `json:"suspect_reason,omitempty"`
}

// AgentSummary carries the canonical child-only aggregates. Like Summary,
// durations are integer nanoseconds. ActivityUnion and UserAttentionUnion are
// non-additive and are recomputed when envelopes are merged.
type AgentSummary struct {
	AgentActivity      int64 `json:"agent_activity"`
	ActivityUnion      int64 `json:"activity_union"`
	UserAttention      int64 `json:"user_attention"`
	UserAttentionUnion int64 `json:"user_attention_union"`
	ApprovalAttention  int64 `json:"approval_attention"`
	UserInputAttention int64 `json:"user_input_attention"`
	SuspectSpans       int   `json:"suspect_spans"`
	SuspectDuration    int64 `json:"suspect_duration"`
}

// Summary carries window-level aggregates. Durations are nanoseconds. The
// attention decomposition (prompt/attended/delegated/effectiveness) is optional;
// providers that do not model operator attention omit it.
type Summary struct {
	From                    string           `json:"from"`
	To                      string           `json:"to"`
	Sessions                int              `json:"sessions"`
	ByStatus                map[string]int64 `json:"by_status"`
	AttentionUnion          int64            `json:"attention_union"`
	AttentionPerSession     int64            `json:"attention_per_session"`
	AttentionFanout         int64            `json:"attention_fanout"`
	PromptActive            *int64           `json:"prompt_active,omitempty"`
	AttendedActive          *int64           `json:"attended_active,omitempty"`
	DelegatedActive         *int64           `json:"delegated_active,omitempty"`
	DelegationEffectiveness *float64         `json:"delegation_effectiveness,omitempty"`

	// SuspectLanes counts lanes flagged by the plausibility post-check and
	// SuspectDuration is exactly how much synthesized tail every other figure in
	// this Summary already excludes. A consumer that re-derives an "active" number
	// by summing interval durations will disagree with these aggregates unless it
	// clips each suspect lane at its SuspectSince.
	SuspectLanes    int   `json:"suspect_lanes,omitempty"`
	SuspectDuration int64 `json:"suspect_duration,omitempty"`
}

// Totals carries window-level token/cost/subagent sums.
type Totals struct {
	TokIn          int64                 `json:"tok_in,omitempty"`
	TokOut         int64                 `json:"tok_out,omitempty"`
	TokCacheRead   int64                 `json:"tok_cache_read,omitempty"`
	TokCacheCreate int64                 `json:"tok_cache_create,omitempty"`
	Subagents      int                   `json:"subagents,omitempty"`
	CostUSD        *float64              `json:"cost_usd,omitempty"`
	Usage          *UsageBreakdown       `json:"usage,omitempty"`
	PricingGroups  []PricingGroup        `json:"pricing_groups,omitempty"`
	VendorUsage    *VendorUsageAggregate `json:"vendor_usage,omitempty"`
	Cost           *CostEstimate         `json:"cost,omitempty"`
	UsageCoverage  string                `json:"usage_coverage,omitempty"`
}

// PlanWindow is the rolling plan-usage total (a Claude/Anthropic capability;
// providers without a plan concept omit it).
type PlanWindow struct {
	Hours                    float64         `json:"hours,omitempty"`
	From                     string          `json:"from,omitempty"`
	To                       string          `json:"to,omitempty"`
	CostUSD                  *float64        `json:"cost_usd,omitempty"`
	Usage                    *UsageBreakdown `json:"usage,omitempty"`
	PricingGroups            []PricingGroup  `json:"pricing_groups,omitempty"`
	Cost                     *CostEstimate   `json:"cost,omitempty"`
	VendorUsageOmittedReason string          `json:"vendor_usage_omitted_reason,omitempty"`
	UsageCoverage            string          `json:"usage_coverage,omitempty"`
	TokIn                    int64           `json:"tok_in,omitempty"`
	TokOut                   int64           `json:"tok_out,omitempty"`
	TokCacheRead             int64           `json:"tok_cache_read,omitempty"`
	TokCacheCreate           int64           `json:"tok_cache_create,omitempty"`
}

// UsageBreakdown preserves provider billing dimensions that cannot be safely
// collapsed into the four legacy tok_* fields. ReasoningOutputTokens is a
// breakdown of OutputTokens, not an additional billable bucket.
type UsageBreakdown struct {
	InputTokens                 int64 `json:"input_tokens,omitempty"`
	CachedInputTokens           int64 `json:"cached_input_tokens,omitempty"`
	CacheWriteInputTokens       int64 `json:"cache_write_input_tokens,omitempty"`
	CacheWrite5mInputTokens     int64 `json:"cache_write_5m_input_tokens,omitempty"`
	CacheWrite1hInputTokens     int64 `json:"cache_write_1h_input_tokens,omitempty"`
	OutputTokens                int64 `json:"output_tokens,omitempty"`
	ReasoningOutputTokens       int64 `json:"reasoning_output_tokens,omitempty"`
	TotalTokens                 int64 `json:"total_tokens,omitempty"`
	ModelContextWindow          int64 `json:"model_context_window,omitempty"`
	WebSearchRequests           int64 `json:"web_search_requests,omitempty"`
	WebFetchRequests            int64 `json:"web_fetch_requests,omitempty"`
	CodeExecutionRequests       int64 `json:"code_execution_requests,omitempty"`
	UnclassifiedServerToolUnits int64 `json:"unclassified_server_tool_units,omitempty"`
}

// BillingIdentity answers three separate questions: which client initiated a
// request, which provider executed it, and which route/account was billed.
// Empty fields remain unknown; consumers must not infer them from AgentClient.
type BillingIdentity struct {
	AgentClient       string `json:"agent_client,omitempty"`
	ExecutionProvider string `json:"execution_provider,omitempty"`
	BillingRoute      string `json:"billing_route,omitempty"`
	AccountKind       string `json:"account_kind,omitempty"`
	AuthMode          string `json:"auth_mode,omitempty"`
	Model             string `json:"model,omitempty"`
	ServiceTier       string `json:"service_tier,omitempty"`
	Speed             string `json:"speed,omitempty"`
	InferenceGeo      string `json:"inference_geo,omitempty"`
	ReasoningEffort   string `json:"reasoning_effort,omitempty"`
}

// PricingGroup keeps unlike request identities auditable instead of flattening
// a session that changed model, tier, geography, or billing route.
type PricingGroup struct {
	Identity BillingIdentity `json:"identity"`
	Usage    UsageBreakdown  `json:"usage"`
	Cost     CostEstimate    `json:"cost"`
	Events   int64           `json:"events"`
}

// VendorUsageSnapshot is a provider's cumulative thread/account estimate. It
// is not an additive token delta and therefore never contributes to window
// token totals without a matching baseline.
type VendorUsageSnapshot struct {
	ThreadID              string             `json:"thread_id,omitempty"`
	EstimatedUsageCredits float64            `json:"estimated_usage_credits"`
	EstimatedUsageUSD     *float64           `json:"estimated_usage_usd"`
	Groups                []VendorUsageGroup `json:"groups,omitempty"`
	ObservedAt            string             `json:"observed_at"`
	Revision              int64              `json:"revision,omitempty"`
	Stale                 bool               `json:"stale,omitempty"`
}

type VendorUsageGroup struct {
	Model                 *string `json:"model"`
	ReasoningEffort       *string `json:"reasoning_effort"`
	Speed                 *string `json:"speed"`
	InputTokens           *int64  `json:"input_tokens"`
	CachedInputTokens     *int64  `json:"cached_input_tokens"`
	NetNewInputTokens     *int64  `json:"net_new_input_tokens"`
	OutputTokens          *int64  `json:"output_tokens"`
	TotalTokens           *int64  `json:"total_tokens"`
	EstimatedUsageCredits float64 `json:"estimated_usage_credits"`
}

type ScopedVendorUsage struct {
	SessionID     string              `json:"session_id,omitempty"`
	ThreadID      string              `json:"thread_id,omitempty"`
	UsageEventID  string              `json:"usage_event_id,omitempty"`
	UsageRevision int64               `json:"usage_revision,omitempty"`
	UsageSourceID string              `json:"usage_source_id,omitempty"`
	Identity      BillingIdentity     `json:"identity"`
	Snapshot      VendorUsageSnapshot `json:"snapshot"`
}

type VendorUsageAggregate struct {
	Scope     string              `json:"scope"`
	Snapshots []ScopedVendorUsage `json:"snapshots"`
	Cost      CostEstimate        `json:"cost"`
}

// CostEstimate keeps unlike billing concepts separate. APIEquivalentUSD is a
// public on-demand-rate comparison; EstimatedBilledUSD is the best supported
// incremental charge. VendorEstimatedUSD and PlanCredits are retained instead
// of being coerced into either one. Nil amounts mean unavailable, never zero.
type CostEstimate struct {
	APIEquivalentUSD   *float64 `json:"api_equivalent_usd,omitempty"`
	VendorEstimatedUSD *float64 `json:"vendor_estimated_usd,omitempty"`
	PlanCredits        *float64 `json:"plan_credits,omitempty"`
	EstimatedBilledUSD *float64 `json:"estimated_billed_usd,omitempty"`

	Status   string   `json:"status,omitempty"` // estimated, included, partial, stale, unknown
	Coverage *float64 `json:"coverage,omitempty"`
	Legacy   bool     `json:"legacy,omitempty"`

	// PricingKind is the canonical producer field. PriceKind accepts the short-
	// lived dashboard draft so a rolling upgrade does not discard provenance.
	PricingKind string `json:"pricing_kind,omitempty"` // e.g. spot_estimate
	PriceKind   string `json:"price_kind,omitempty"`

	PricedUsageEvents   int      `json:"priced_usage_events,omitempty"`
	UnpricedUsageEvents int      `json:"unpriced_usage_events,omitempty"`
	PricedTokens        int64    `json:"priced_tokens,omitempty"`
	UnpricedTokens      int64    `json:"unpriced_tokens,omitempty"`
	PricedToolUnits     int64    `json:"priced_tool_units,omitempty"`
	UnpricedToolUnits   int64    `json:"unpriced_tool_units,omitempty"`
	UnpricedEvents      int64    `json:"unpriced_events,omitempty"`
	UnpricedReasons     []string `json:"unpriced_reasons,omitempty"`

	PricingProvider      string   `json:"pricing_provider,omitempty"`
	PricingSource        string   `json:"pricing_source,omitempty"`
	PricingSources       []string `json:"pricing_sources,omitempty"`
	PricingRetrievedAt   string   `json:"pricing_retrieved_at,omitempty"`
	PricingEffectiveAt   string   `json:"pricing_effective_at,omitempty"`
	PricingAsOf          string   `json:"pricing_as_of,omitempty"` // rolling-upgrade alias
	PricingVersion       string   `json:"pricing_version,omitempty"`
	PricingVersions      []string `json:"pricing_versions,omitempty"`
	MixedPricingVersions bool     `json:"mixed_pricing_versions,omitempty"`
}

// ProviderError records a provider that failed to produce an envelope, so the
// dashboard can render the providers that succeeded and still surface the gap.
type ProviderError struct {
	Provider string `json:"provider"`
	Error    string `json:"error"`
}

// Parse decodes an envelope from provider stdout.
func Parse(b []byte) (*Timeline, error) {
	var t Timeline
	if err := json.Unmarshal(b, &t); err != nil {
		return nil, err
	}
	return &t, nil
}

// Marshal encodes an envelope for the HTTP response.
func (t *Timeline) Marshal() ([]byte, error) {
	return json.Marshal(t)
}
