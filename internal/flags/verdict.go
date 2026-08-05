package flags

import (
	"errors"
	"fmt"
	"time"

	"github.com/tjmisko/switchboard-dashboard/internal/timeline"
)

// Verdict is what an investigation concluded about a flagged lane. It is the
// ONLY thing an investigating agent produces: the agent has no write tool, so
// every effect it can have on the world passes through this struct and the
// validation below.
//
// That is deliberate. Scoping an agent by fencing Write and Edit to one
// directory is a configuration, and configurations are got wrong; an agent with
// no write tool at all cannot damage anything whatever it concludes. The worst
// outcome available to a confused model here is a wrong — and reversible —
// overlay.
type Verdict struct {
	Verdict    string    `json:"verdict"`
	Confidence string    `json:"confidence"`
	RootCause  string    `json:"root_cause"`
	Evidence   []string  `json:"evidence,omitempty"`
	Action     Action    `json:"action"`
	Upstream   *Upstream `json:"upstream,omitempty"`
}

// The closed vocabularies a verdict is checked against. A value outside these
// sets is rejected rather than coerced: the point of a closed enum is that an
// unrecognized repair is refused, not guessed at.
var (
	knownVerdicts = map[string]bool{
		"ghost-lane":            true, // a lane the reader synthesized past the last real event
		"split-lane":            true, // one session's work reported as two lanes
		"misattributed-project": true, // correct timing, wrong project grouping
		"empty-status-interval": true, // an interval carrying no status at all
		"stale-summary":         true, // the lane is fine; its summary describes other work
		"correct-data":          true, // the data is right and the flag was a false alarm
		"unknown":               true, // investigated, nothing conclusive
	}
	knownConfidence = map[string]bool{"high": true, "medium": true, "low": true}
)

// Validate reports why a verdict cannot be trusted, or nil when it can.
func (v Verdict) Validate() error {
	if !knownVerdicts[v.Verdict] {
		return fmt.Errorf("unknown verdict %q", v.Verdict)
	}
	if !knownConfidence[v.Confidence] {
		return fmt.Errorf("unknown confidence %q", v.Confidence)
	}
	if !v.Action.Type.Valid() {
		return fmt.Errorf("unknown action %q", v.Action.Type)
	}
	switch v.Action.Type {
	case ActionMergeInto:
		if v.Action.MergeIntoLaneStart == "" {
			return fmt.Errorf("action %q needs merge_into_lane_start", v.Action.Type)
		}
	case ActionClipAt:
		if v.Action.ClipAt == "" {
			return fmt.Errorf("action %q needs clip_at", v.Action.Type)
		}
	}
	return nil
}

// AutoApplicable reports whether this verdict may take effect without the
// operator looking at it first.
//
// The gate is confidence, not correctness — we cannot check correctness. A
// high-confidence verdict acts immediately because the overlay is reversible and
// the alternative is a dashboard that stays wrong until someone reads a queue.
// Anything less waits, because a repair nobody is sure of is exactly the kind
// that should cost a glance rather than a surprise.
func (v Verdict) AutoApplicable() bool {
	return v.Validate() == nil && v.Confidence == "high"
}

// ApplicableTo reports why this verdict's action cannot actually repair the lane
// it was written for, or nil when it can.
//
// Validate checks the verdict against itself; this checks it against the lane.
// The two are separate because a verdict can be perfectly well-formed and still
// be a no-op here — and a no-op that is recorded as "applied" is the worst
// outcome available, because the record then claims a repair the operator can
// see did not happen.
//
// Observed: an investigation of a lane holding one observed instant and nine
// hours of inference returned clip-at *at the lane start*. Reasonable in intent
// — everything after that instant is synthesis — but as a clip it removes the
// whole lane, which is what suppress-lane is for. Rather than reinterpret the
// verdict (the same coercion the closed enum exists to prevent), the mismatch is
// surfaced and the operator decides.
func (v Verdict) ApplicableTo(record Record) error {
	switch v.Action.Type {
	case ActionClipAt:
		cut, ok := timeline.ParseNanos(v.Action.ClipAt)
		if !ok {
			return fmt.Errorf("clip_at %q is not a timestamp", v.Action.ClipAt)
		}
		if start, ok := timeline.ParseNanos(record.LaneStart); ok && cut <= start {
			return errors.New("clip_at is at or before the lane start, so it would remove the whole lane; " +
				"suppress-lane is the repair for a lane that is entirely synthesized")
		}
		if end, ok := timeline.ParseNanos(record.LaneEnd); ok && cut >= end {
			return errors.New("clip_at is at or after the lane end, so it would change nothing")
		}
	case ActionMergeInto:
		if v.Action.MergeIntoLaneStart == record.LaneStart {
			return errors.New("merge_into_lane_start names the flagged lane itself")
		}
	}
	return nil
}

// Resolve records a verdict on the flag and settles its status: applied when the
// verdict is confident enough to act on AND can actually act on this lane,
// pending_review otherwise.
func (r *Record) Resolve(v Verdict, run *AgentRun, now time.Time) {
	r.Verdict = v.Verdict
	r.Confidence = v.Confidence
	r.RootCause = v.RootCause
	r.Evidence = v.Evidence
	r.Action = v.Action
	r.Upstream = v.Upstream
	r.Agent = run
	r.ResolvedAt = now.UTC().Format(time.RFC3339)
	r.Blocked = ""
	if !v.AutoApplicable() {
		r.Status = StatusPendingReview
		return
	}
	if err := v.ApplicableTo(*r); err != nil {
		r.Status = StatusPendingReview
		r.Blocked = err.Error()
		return
	}
	r.Status = StatusApplied
}

// Fail records an investigation that produced no usable verdict. The flag stays
// on the lane — the operator's judgement that something is wrong survives the
// agent's failure to explain it — and the reason is kept for the issue log.
func (r *Record) Fail(reason string, run *AgentRun, now time.Time) {
	if run == nil {
		run = &AgentRun{}
	}
	if run.Error == "" {
		run.Error = reason
	}
	r.Status = StatusFailed
	r.Agent = run
	r.Action = Action{Type: ActionNone}
	r.ResolvedAt = now.UTC().Format(time.RFC3339)
}
