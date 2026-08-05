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
//   - cost_usd is a FLOAT in dollars,
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
	PlanWindow     *PlanWindow     `json:"plan_window,omitempty"`
	ProviderErrors []ProviderError `json:"provider_errors,omitempty"`
	FlagsApplied   []FlagApplied   `json:"flags_applied,omitempty"`
}

// FlagApplied records one operator flag whose repair changed the lanes above.
//
// It exists because Summary is deliberately NOT recomputed when a flag repairs a
// lane. Re-deriving attention_union and its siblings means reimplementing the
// producer's interval algebra against a set of lanes it never saw, and a total
// that is half-corrected is worse than one that is uncorrected and says so.
// Instead the aggregates keep describing the data as the producer reported it,
// and this list is what a consumer shows beside them — the same treatment the
// schema prescribes for suspect_duration: put the excluded quantity next to the
// total rather than hiding it inside.
//
// RemovedNS is the lane wall-clock the repair took out of Lanes, so a UI can say
// "3 lanes repaired, 9h12m removed" without re-walking the intervals itself.
type FlagApplied struct {
	Key       string `json:"key"`
	SessionID string `json:"session_id,omitempty"`
	LaneStart string `json:"lane_start"`
	Action    string `json:"action"`
	Verdict   string `json:"verdict,omitempty"`
	RemovedNS int64  `json:"removed_ns,omitempty"`
}

// Lane is one session's bar. Identity is keyed by session_id (falling back to
// pid); Provider names the adapter that produced it so the UI can tag/color it
// and so merged session ids never collide across providers.
type Lane struct {
	SessionID      string     `json:"session_id,omitempty"`
	PID            int        `json:"pid,omitempty"`
	Agent          string     `json:"agent,omitempty"`
	Provider       string     `json:"provider,omitempty"`
	Project        string     `json:"project,omitempty"`
	ProjectFull    string     `json:"project_full,omitempty"`
	Start          string     `json:"start"`
	End            string     `json:"end"`
	Intervals      []Interval `json:"intervals"`
	Labels         []Span     `json:"labels,omitempty"`
	Name           string     `json:"name,omitempty"`
	Names          []Span     `json:"names,omitempty"`
	Subagents      []Subagent `json:"subagents,omitempty"`
	Focus          []TimeSpan `json:"focus,omitempty"`
	CostUSD        float64    `json:"cost_usd,omitempty"`
	TokIn          int64      `json:"tok_in,omitempty"`
	TokOut         int64      `json:"tok_out,omitempty"`
	TokCacheRead   int64      `json:"tok_cache_read,omitempty"`
	TokCacheCreate int64      `json:"tok_cache_create,omitempty"`

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
	TokIn          int64   `json:"tok_in,omitempty"`
	TokOut         int64   `json:"tok_out,omitempty"`
	TokCacheRead   int64   `json:"tok_cache_read,omitempty"`
	TokCacheCreate int64   `json:"tok_cache_create,omitempty"`
	Subagents      int     `json:"subagents,omitempty"`
	CostUSD        float64 `json:"cost_usd,omitempty"`
}

// PlanWindow is the rolling plan-usage total (a Claude/Anthropic capability;
// providers without a plan concept omit it).
type PlanWindow struct {
	Hours          float64 `json:"hours,omitempty"`
	From           string  `json:"from,omitempty"`
	To             string  `json:"to,omitempty"`
	CostUSD        float64 `json:"cost_usd,omitempty"`
	TokIn          int64   `json:"tok_in,omitempty"`
	TokOut         int64   `json:"tok_out,omitempty"`
	TokCacheRead   int64   `json:"tok_cache_read,omitempty"`
	TokCacheCreate int64   `json:"tok_cache_create,omitempty"`
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
