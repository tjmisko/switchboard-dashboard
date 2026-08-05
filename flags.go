package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/tjmisko/switchboard-dashboard/internal/flags"
	"github.com/tjmisko/switchboard-dashboard/internal/timeline"
)

// Investigator diagnoses a flagged lane. A nil Investigator disables
// investigation entirely: flags are still recorded, and a verdict can still be
// written by hand into the store, so the repair half of the feature works with
// no model in the loop at all.
type Investigator interface {
	Investigate(ctx context.Context, record flags.Record) (flags.Verdict, error)
}

// investigationTimeout bounds one investigation, matching the ceiling
// cmd/session-digest puts on its own `claude -p` calls.
const investigationTimeout = 5 * time.Minute

// flagRequest is the POST body for filing or reverting a flag. The lane is
// identified the same way the store keys it — session id plus lane start —
// because one session can own several lanes and the operator right-clicked
// exactly one of them.
type flagRequest struct {
	SessionID string `json:"session_id"`
	LaneStart string `json:"lane_start"`
	LaneEnd   string `json:"lane_end,omitempty"`
	Provider  string `json:"provider,omitempty"`
	Project   string `json:"project,omitempty"`
	Note      string `json:"note,omitempty"`
}

// flagsResponse is the GET /api/flags body: every flag, keyed as the store keys
// it, so the frontend can look one up from a lane without a scan.
type flagsResponse struct {
	Flags map[string]flags.Record `json:"flags"`
}

// applyFlags overlays the active repairs onto a raw provider envelope.
//
// It returns ok=false when nothing applied, and the caller then writes the
// provider's bytes through untouched. That is what preserves the single-provider
// path's byte-verbatim proxy — including fields these structs do not model —
// for the overwhelmingly common case of a window with no flags on it. Only a
// window that a flag actually bites is re-encoded, and only there does the
// round-trip through the Go structs cost unknown fields.
func (s *Server) applyFlags(raw []byte) ([]byte, bool) {
	if !s.Flags.Enabled() {
		return raw, false
	}
	records, err := s.Flags.List()
	if err != nil || len(records) == 0 {
		return raw, false
	}
	tl, err := timeline.Parse(raw)
	if err != nil {
		// An envelope we cannot parse is one we must not rewrite. Pass it through
		// and let the frontend deal with whatever the provider produced.
		return raw, false
	}
	if applied := flags.Apply(tl, records); len(applied) == 0 {
		return raw, false
	}
	out, err := tl.Marshal()
	if err != nil {
		return raw, false
	}
	return out, true
}

// handleFlagsList serves every stored flag. Always 200 with a (possibly empty)
// set, including when the store is disabled — the frontend asks unconditionally
// and an unconfigured dashboard simply has no flags, which is not an error.
func (s *Server) handleFlagsList(w http.ResponseWriter, r *http.Request) {
	records, err := s.Flags.List()
	if err != nil {
		log.Printf("flags: list: %v", err)
	}
	if records == nil {
		records = map[string]flags.Record{}
	}
	writeJSON(w, flagsResponse{Flags: records})
}

// handleFlagCreate files a flag on one lane and kicks off its investigation.
//
// Filing is idempotent on (session_id, lane_start): re-flagging a lane whose
// investigation is still running returns the existing record rather than
// starting a second agent on the same question. Re-flagging one that has already
// settled DOES re-open it — that is the operator saying the verdict was wrong,
// which is the one case where spending another investigation is the point.
func (s *Server) handleFlagCreate(w http.ResponseWriter, r *http.Request) {
	if !requireSameOrigin(w, r) {
		return
	}
	if !s.Flags.Enabled() {
		http.Error(w, "flag store is not configured", http.StatusNotFound)
		return
	}

	var req flagRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		http.Error(w, "malformed request body", http.StatusBadRequest)
		return
	}
	if req.LaneStart == "" {
		http.Error(w, "lane_start is required", http.StatusBadRequest)
		return
	}

	key := flags.Key(req.SessionID, req.LaneStart)
	if existing, ok, _ := s.Flags.Get(key); ok && inFlight(existing.Status) {
		writeJSON(w, existing)
		return
	}

	record := flags.Record{
		SessionID: req.SessionID,
		LaneStart: req.LaneStart,
		LaneEnd:   req.LaneEnd,
		Provider:  req.Provider,
		Project:   req.Project,
		Note:      req.Note,
		FlaggedAt: time.Now().UTC().Format(time.RFC3339),
		Status:    flags.StatusPending,
		Action:    flags.Action{Type: flags.ActionNone},
	}
	if err := s.Flags.Save(record); err != nil {
		http.Error(w, "could not record the flag: "+err.Error(), http.StatusInternalServerError)
		return
	}
	s.appendIssue(flags.IssueEntry{
		Event: "flagged", Key: key, SessionID: record.SessionID,
		LaneStart: record.LaneStart, Project: record.Project, Note: record.Note,
	})

	s.startInvestigation(record)
	writeJSON(w, record)
}

// handleFlagRevert withdraws an applied repair. The record survives as
// StatusReverted and the withdrawal is appended to the issue log: an overlay the
// operator rejected is evidence about the investigator, and deleting it would
// throw that away.
func (s *Server) handleFlagRevert(w http.ResponseWriter, r *http.Request) {
	if !requireSameOrigin(w, r) {
		return
	}
	if !s.Flags.Enabled() {
		http.Error(w, "flag store is not configured", http.StatusNotFound)
		return
	}

	var req flagRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		http.Error(w, "malformed request body", http.StatusBadRequest)
		return
	}
	key := flags.Key(req.SessionID, req.LaneStart)

	record, err := s.Flags.Update(key, func(rec *flags.Record) bool {
		if rec.Status == flags.StatusReverted {
			return false
		}
		rec.Status = flags.StatusReverted
		return true
	})
	if err != nil {
		http.Error(w, "no such flag", http.StatusNotFound)
		return
	}
	s.appendIssue(flags.IssueEntry{
		Event: "reverted", Key: key, SessionID: record.SessionID,
		LaneStart: record.LaneStart, Project: record.Project,
		Verdict: record.Verdict, Action: record.Action,
	})
	writeJSON(w, record)
}

// inFlight reports whether an investigation is already working on this flag, and
// so whether a repeat POST should be absorbed rather than acted on.
func inFlight(status flags.Status) bool {
	return status == flags.StatusPending || status == flags.StatusInvestigating
}

// startInvestigation runs the investigator in the background and folds its
// verdict into the record.
//
// It is detached from the request context on purpose: the operator's click is
// over in milliseconds and the investigation takes minutes, so tying its
// lifetime to the HTTP request would cancel every investigation the instant the
// browser got its answer.
func (s *Server) startInvestigation(record flags.Record) {
	if s.Investigator == nil {
		return
	}
	key := record.Key()
	if _, err := s.Flags.Update(key, func(rec *flags.Record) bool {
		rec.Status = flags.StatusInvestigating
		return true
	}); err != nil {
		log.Printf("flags: mark investigating %s: %v", key, err)
		return
	}

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), investigationTimeout)
		defer cancel()

		started := time.Now()
		verdict, err := s.Investigator.Investigate(ctx, record)
		run := &flags.AgentRun{DurationMS: time.Since(started).Milliseconds()}

		updated, uerr := s.Flags.Update(key, func(rec *flags.Record) bool {
			switch {
			case err != nil:
				rec.Fail(err.Error(), run, time.Now())
			default:
				if verr := verdict.Validate(); verr != nil {
					rec.Fail("unusable verdict: "+verr.Error(), run, time.Now())
					return true
				}
				rec.Resolve(verdict, run, time.Now())
			}
			return true
		})
		if uerr != nil {
			log.Printf("flags: record verdict %s: %v", key, uerr)
			return
		}
		s.appendIssue(flags.IssueEntry{
			Event: "resolved", Key: key, SessionID: updated.SessionID,
			LaneStart: updated.LaneStart, Project: updated.Project, Note: updated.Note,
			Verdict: updated.Verdict, Confidence: updated.Confidence,
			RootCause: updated.RootCause, Evidence: updated.Evidence,
			Action: updated.Action, Upstream: updated.Upstream, Agent: updated.Agent,
		})
	}()
}

// appendIssue writes one line of the durable investigation log. A failure here
// is logged and swallowed: losing a log line must not fail the operator's
// action, since the flag itself — the thing that changes what they see — has
// already been recorded.
func (s *Server) appendIssue(entry flags.IssueEntry) {
	if err := s.Flags.AppendIssue(entry); err != nil {
		log.Printf("flags: append issue %s: %v", entry.Key, err)
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
