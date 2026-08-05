// Package flags is the dashboard's record of timeline data the operator has
// declared wrong, and the reversible repairs applied on top of it.
//
// The activity log the timeline is derived from is append-only and owned by the
// producer (Switchboard, Arachne, …), so nothing here ever edits it. A flag is
// instead an OVERLAY: a declarative statement — suppress this lane, clip it
// here, fold it into that one — stored beside the log and applied to the
// envelope on its way to the browser. That keeps every repair reversible, keeps
// the producers the single source of truth, and leaves `switchboard-ctl timeline
// --json` byte-identical for anyone else reading it.
//
// The other half of a flag is evidence. Each investigation appends one line to
// issues.jsonl — verdict, root cause, and the events behind it — so a class of
// defect that is invisible in any single day accumulates into something you can
// actually fix upstream.
package flags

import (
	"strconv"
	"strings"
	"time"
)

// Status is where a flag is in its lifecycle. A flag is born Pending, an
// investigation moves it to Investigating, and it settles in exactly one
// terminal state.
type Status string

const (
	StatusPending       Status = "pending"        // filed, investigation not started
	StatusInvestigating Status = "investigating"  // an agent is looking at it
	StatusApplied       Status = "applied"        // verdict reached, overlay in force
	StatusPendingReview Status = "pending_review" // verdict reached, too unsure to auto-apply
	StatusFailed        Status = "failed"         // the investigation did not produce a verdict
	StatusReverted      Status = "reverted"       // the operator undid an applied overlay
)

// ActionType is the closed set of repairs an overlay may express. It is closed
// on purpose: the investigating agent's output is validated against exactly
// these values, so a confused model can only ever ask for a repair the dashboard
// already knows how to undo.
type ActionType string

const (
	// ActionNone records a verdict that changes nothing — most usefully
	// "correct-data", where the lane is ugly but honest.
	ActionNone ActionType = "none"
	// ActionSuppress drops the lane from the rendered envelope.
	ActionSuppress ActionType = "suppress-lane"
	// ActionClipAt truncates the lane (and its trailing interval) at an instant,
	// for a lane whose head is real and whose tail is synthesized.
	ActionClipAt ActionType = "clip-at"
	// ActionMergeInto folds the lane's intervals into a sibling lane of the same
	// session. This is the repair for a lane the reader split in two: it keeps the
	// real work instead of throwing it away with the artifact.
	ActionMergeInto ActionType = "merge-into"
)

// Valid reports whether t is one of the four known repairs.
func (t ActionType) Valid() bool {
	switch t {
	case ActionNone, ActionSuppress, ActionClipAt, ActionMergeInto:
		return true
	}
	return false
}

// Action is the repair itself. The extra fields are per-type and ignored when
// they do not apply.
type Action struct {
	Type ActionType `json:"type"`
	// MergeIntoLaneStart identifies the sibling lane to fold into, by its start
	// timestamp (ActionMergeInto only).
	MergeIntoLaneStart string `json:"merge_into_lane_start,omitempty"`
	// ClipAt is the instant past which the lane is inference (ActionClipAt only).
	ClipAt string `json:"clip_at,omitempty"`
}

// Upstream is the investigator's draft of a bug report for whoever produced the
// bad data. It is written down, never filed: the overlay fixes the view, and a
// human decides whether the underlying defect is worth a ticket.
type Upstream struct {
	Repo  string `json:"repo,omitempty"`
	File  string `json:"file,omitempty"`
	Title string `json:"title,omitempty"`
	Body  string `json:"body,omitempty"`
}

// AgentRun is the provenance of an investigation: what ran, what it cost, and
// how it failed if it did.
type AgentRun struct {
	Model      string  `json:"model,omitempty"`
	CostUSD    float64 `json:"cost_usd,omitempty"`
	DurationMS int64   `json:"duration_ms,omitempty"`
	Error      string  `json:"error,omitempty"`
}

// Record is one flagged lane: what the operator pointed at, what the
// investigation concluded, and the repair now in force.
//
// It is keyed on session id AND lane start rather than session id alone,
// because one session can legitimately produce several lanes — and, in the
// defect that motivated this package, produces a real lane plus a ghost that
// must be flagged without touching its sibling.
type Record struct {
	SessionID string `json:"session_id"`
	LaneStart string `json:"lane_start"`
	LaneEnd   string `json:"lane_end,omitempty"`
	Provider  string `json:"provider,omitempty"`
	Project   string `json:"project,omitempty"`

	FlaggedAt string `json:"flagged_at"`
	Note      string `json:"note,omitempty"`
	Status    Status `json:"status"`

	Verdict    string   `json:"verdict,omitempty"`
	Confidence string   `json:"confidence,omitempty"`
	RootCause  string   `json:"root_cause,omitempty"`
	Evidence   []string `json:"evidence,omitempty"`

	Action     Action    `json:"action"`
	Upstream   *Upstream `json:"upstream,omitempty"`
	Agent      *AgentRun `json:"agent,omitempty"`
	ResolvedAt string    `json:"resolved_at,omitempty"`
}

// Key is the record's stable identity, and its filename stem.
func (r Record) Key() string { return Key(r.SessionID, r.LaneStart) }

// Active reports whether this record's overlay should be applied to an
// envelope. Only an applied, non-trivial repair counts: a pending flag has no
// verdict yet, a reverted one has been withdrawn, and a "none" action is a
// verdict that deliberately changes nothing.
func (r Record) Active() bool {
	return r.Status == StatusApplied && r.Action.Type.Valid() && r.Action.Type != ActionNone
}

// Key builds the record identity from a session id and a lane start.
//
// The lane start is normalized to epoch milliseconds rather than kept as text,
// because the same instant reaches us spelled several ways — a different offset,
// a different number of fractional digits — and two spellings of one lane must
// not become two flags. Sessions that carry no id fall back to the timestamp
// alone, which still separates lanes within the window a flag is scoped to.
func Key(sessionID, laneStart string) string {
	stem := sanitize(sessionID)
	if stem == "" {
		stem = "session"
	}
	return stem + "__" + strconv.FormatInt(epochMillis(laneStart), 10)
}

// epochMillis parses an RFC3339 instant, returning 0 for anything unparsable so
// a malformed timestamp still yields a deterministic (if uninformative) key
// rather than an error the caller has to thread through the UI.
func epochMillis(ts string) int64 {
	t, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil {
		return 0
	}
	return t.UnixMilli()
}

// sanitize reduces an identifier to characters that are safe in a filename on
// every platform. Merged multi-provider ids are namespaced ("claude:<uuid>"),
// so at minimum the colon has to go.
func sanitize(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '-':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	return strings.Trim(b.String(), "-")
}
