package arachne

import (
	"fmt"
	"sort"
	"strconv"
	"time"

	"github.com/tjmisko/switchboard-dashboard/internal/timeline"
)

// CompileOptions windows and stamps the compiled envelope.
type CompileOptions struct {
	// Now is the clock used to close still-open sessions and subagents (their
	// end is "now"). Required.
	Now time.Time
	// Window is the display label for the envelope.
	Window string
	// Since/Until bound which sessions appear (a session is included if it
	// overlaps the window). A zero time means unbounded on that side.
	Since time.Time
	Until time.Time
}

// Compile turns the append-only Arachne history into a timeline envelope. Each
// session becomes one lane with a single "working" interval spanning its
// lifetime — a running Arachne container is an agent aloft for its whole life
// (unattended auto mode) — plus subagent sub-bars and cumulative token totals.
// Still-open sessions/subagents are closed at opts.Now.
func Compile(events []Event, opts CompileOptions) *timeline.Timeline {
	sessions := aggregate(events)
	nowRFC := opts.Now.UTC().Format(time.RFC3339)

	// Deterministic order: by start time, then id.
	sort.Slice(sessions, func(i, j int) bool {
		si, sj := sessStartTS(sessions[i]), sessStartTS(sessions[j])
		if si != sj {
			return si < sj
		}
		return sessions[i].id < sessions[j].id
	})

	out := &timeline.Timeline{
		Window:  opts.Window,
		Lanes:   []timeline.Lane{},
		Summary: timeline.Summary{ByStatus: map[string]int64{}},
	}
	var fromNs, toNs int64
	haveBounds := false
	var aloftSpans [][2]int64

	for _, s := range sessions {
		startRFC := sessStartTS(s)
		endRFC := s.endTS
		unclosed := endRFC == ""
		if unclosed {
			endRFC = nowRFC // still running
		}
		// A run that ends before it starts is not a short session, it is a
		// broken one, and it draws as nothing at all — the failure that hid a
		// whole day of Arachne work behind one inverted span. aggregate no
		// longer produces one, but a history an older recorder wrote still can,
		// and SpanNanos answers "no span" to a backwards pair rather than a
		// negative one: unclamped, such a lane skips every aggregate below in
		// silence. Hold the invariant here, where it is still visible.
		if ss, okS := timeline.ParseNanos(startRFC); okS {
			if ee, okE := timeline.ParseNanos(endRFC); okE && ee < ss {
				endRFC = startRFC
			}
		}
		if !overlapsWindow(startRFC, endRFC, opts) {
			continue
		}

		subs := make([]timeline.Subagent, 0, len(s.subs))
		for _, su := range s.subs {
			suEnd := su.endTS
			unpaired := suEnd == ""
			if unpaired {
				suEnd = nowRFC
			}
			sa := timeline.Subagent{
				AgentType:   su.agentType,
				ToolUseID:   su.toolUseID,
				Description: su.description,
				Start:       su.startTS,
				End:         suEnd,
			}
			// A span we had to close at the bound, that ran longer than a plausible
			// unit of delegated work, is a phantom: the stop event never arrived.
			if unpaired {
				if ss, se, ok := timeline.SpanNanos(sa.Start, sa.End); ok && se-ss >= int64(timeline.DefaultSuspectSubagentCap) {
					sa.Suspect = true
					sa.SuspectReason = fmt.Sprintf("unpaired subagent stretched to now: span %s >= %s cap",
						roundSec(time.Duration(se-ss)), roundSec(timeline.DefaultSuspectSubagentCap))
				}
			}
			subs = append(subs, sa)
		}

		lane := timeline.Lane{
			SessionID:      s.id,
			Agent:          orDefault(s.start.Agent, "arachne"),
			Provider:       "arachne",
			Project:        orDefault(s.start.Project, "arachne"),
			ProjectFull:    s.start.ProjectFull,
			Start:          startRFC,
			End:            endRFC,
			Intervals:      []timeline.Interval{{Status: "working", Start: startRFC, End: endRFC}},
			Subagents:      subs,
			TokIn:          s.usage.TokIn,
			TokOut:         s.usage.TokOut,
			TokCacheRead:   s.usage.TokCacheRead,
			TokCacheCreate: s.usage.TokCacheCreate,
			CostUSD:        s.usage.CostUSD,
		}
		if s.start.TaskID != "" {
			lane.Name = s.start.TaskID
			lane.Names = []timeline.Span{{Label: s.start.TaskID, Start: startRFC, End: endRFC}}
		}

		// The plausibility post-check, the same one the switchboard daemon runs over
		// its own lanes: a lane nothing ever closed, stretched to the bound, whose
		// stretch since the last observed event is longer than a session plausibly
		// sits silent. Both halves matter — a live session emitting events all along
		// is long, not suspect, however long it runs. The lane is flagged, never
		// truncated; only the credit below is held to the evidence.
		// trustedNs is meaningful only when clip is set: 0 is a real instant (the
		// Unix epoch), not a sentinel, so the flag carries "there is a bound" the
		// way timeline.trustedEndNanos does.
		var trustedNs int64
		clip := false
		if unclosed {
			evidenceTS := s.lastTS
			if evidenceTS == "" {
				evidenceTS = startRFC
			}
			if es, ee, ok := timeline.SpanNanos(evidenceTS, endRFC); ok && ee-es >= int64(timeline.DefaultSuspectTrailingCap) {
				lane.Suspect = true
				lane.SuspectSince = evidenceTS
				// Everything up to and including "cap" is a contract with the
				// daemon's internal/history/suspect.go, which words the same
				// condition for its own lanes: in a merged day the two sentences sit
				// in one list, and an operator must not be able to tell which
				// provider wrote which. Leading with the cap comparison and trailing
				// with the status is what makes that possible on the daemon's side —
				// its status clause then has a noun slot to sit in and no "a
				// unknown-status lane" to disagree with. Arachne appends no such
				// clause: its lane is one synthesized "working" interval (see
				// Intervals above), so a status is a constant and carries nothing.
				lane.SuspectReason = fmt.Sprintf("unclosed lane stretched to now: silent %s >= %s cap",
					roundSec(time.Duration(ee-es)), roundSec(timeline.DefaultSuspectTrailingCap))
				trustedNs, clip = es, true
				out.Summary.SuspectLanes++
				out.Summary.SuspectDuration += ee - es
			}
		}
		out.Lanes = append(out.Lanes, lane)

		// aggregates
		if ws, we, ok := timeline.SpanNanos(startRFC, endRFC); ok {
			// Window bounds cover the lane as DRAWN — the tail is still on screen even
			// when it is not counted — so from/to take the full extent.
			if !haveBounds {
				fromNs, toNs, haveBounds = ws, we, true
			} else {
				if ws < fromNs {
					fromNs = ws
				}
				if we > toNs {
					toNs = we
				}
			}
			creditEnd := we
			if clip && trustedNs < creditEnd {
				creditEnd = trustedNs
			}
			if creditEnd > ws {
				dur := creditEnd - ws
				out.Summary.ByStatus["working"] += dur
				out.Summary.AttentionPerSession += dur
				out.Summary.AttentionFanout += dur
				aloftSpans = append(aloftSpans, [2]int64{ws, creditEnd})
			}
		}
		for _, su := range subs {
			if su.Suspect {
				continue // a phantom span is drawn, never credited
			}
			ss, se, ok := timeline.SpanNanos(su.Start, su.End)
			if !ok {
				continue
			}
			if clip {
				if ss >= trustedNs {
					continue
				}
				if se > trustedNs {
					se = trustedNs
				}
			}
			out.Summary.AttentionFanout += se - ss
			aloftSpans = append(aloftSpans, [2]int64{ss, se})
		}

		out.Totals.TokIn += s.usage.TokIn
		out.Totals.TokOut += s.usage.TokOut
		out.Totals.TokCacheRead += s.usage.TokCacheRead
		out.Totals.TokCacheCreate += s.usage.TokCacheCreate
		out.Totals.CostUSD += s.usage.CostUSD
		out.Totals.Subagents += len(subs)
	}

	out.Summary.Sessions = len(out.Lanes)
	out.Summary.AttentionUnion = timeline.UnionNanos(aloftSpans)
	if haveBounds {
		out.Summary.From = timeline.NanoToRFC(fromNs)
		out.Summary.To = timeline.NanoToRFC(toNs)
	}
	return out
}

type sub struct {
	toolUseID   string
	agentType   string
	description string
	startTS     string
	endTS       string
}

// sess is one container RUN. See aggregate for why that is not the same thing
// as one session slug.
type sess struct {
	id        string
	start     Event
	endTS     string
	endReason string
	subOpen   map[string]*sub
	subs      []*sub
	usage     Usage

	// lastTS is the newest event timestamp seen for this session, and lastNs its
	// parsed form. For a session that never logged a session_end, this is the last
	// instant there is evidence for — everything between it and the bound Compile
	// stretches the lane to is inference. See the suspect check in Compile.
	lastTS string
	lastNs int64
}

// touch advances the run's last-evidence mark. A timestamp that will not parse
// cannot move it: the suspect check measures silence from this instant, and a
// garbled clock must not be able to shorten or extend that silence.
func (s *sess) touch(ts string) {
	if ns, ok := timeline.ParseNanos(ts); ok && ns > s.lastNs {
		s.lastTS, s.lastNs = ts, ns
	}
}

// lastEvidence is the newest instant this run is attested at: its last event,
// or its start when nothing followed (or nothing parsed).
func (s *sess) lastEvidence() string {
	if s.lastTS != "" {
		return s.lastTS
	}
	return sessStartTS(s)
}

// aggregate folds the event stream into per-RUN records.
//
// A session is one container run, not one branch. Arachne names a container
// after its worktree branch (arachne-agent-<slug>) and the pump restarts that
// same name once per phase task, so a slug recurs all day. Keyed on the slug
// alone, every run of a branch folded into a single record that took its start
// from the newest run and its end from the previous one — an inverted span that
// drew as nothing, credited no time, and buried every earlier run of the day
// behind it. Each session_start therefore opens a fresh run, and only a slug's
// newest run is open to the events that follow it.
func aggregate(events []Event) []*sess {
	current := map[string]*sess{} // slug -> the run events attach to
	runs := map[string]int{}      // slug -> runs opened so far, for the id suffix
	order := []*sess{}

	for _, e := range events {
		if e.SessionID == "" {
			continue
		}

		if e.Type == EventSessionStart {
			// A start for a slug whose run is still open means we never saw the
			// old container go — a restart that landed inside one poll, or a
			// history torn by a crash. Close it at its last evidence rather than
			// let the new run inherit its span, subagents, and token totals.
			if prev := current[e.SessionID]; prev != nil && prev.endTS == "" {
				prev.endTS = prev.lastEvidence()
				prev.endReason = ReasonInferred
			}
			runs[e.SessionID]++
			s := &sess{id: runID(e.SessionID, runs[e.SessionID]), start: e, subOpen: map[string]*sub{}}
			s.touch(e.TS)
			current[e.SessionID] = s
			order = append(order, s)
			continue
		}

		// Nothing open to attach to: either no start for this slug was ever
		// recorded, or its run is closed — and a closed run is final, so no
		// later event may reopen it, extend its evidence, or restate its usage.
		s := current[e.SessionID]
		if s == nil || s.endTS != "" {
			continue
		}
		s.touch(e.TS)

		switch e.Type {
		case EventSessionEnd:
			s.endTS = e.End
			if s.endTS == "" {
				s.endTS = e.TS
			}
			s.endReason = e.Reason
		case EventSubagentSpawn:
			su := &sub{toolUseID: e.ToolUseID, agentType: e.AgentType, description: e.Description, startTS: e.TS}
			s.subOpen[e.ToolUseID] = su
			s.subs = append(s.subs, su)
		case EventSubagentStop:
			if su := s.subOpen[e.ToolUseID]; su != nil {
				su.endTS = e.TS
				delete(s.subOpen, e.ToolUseID)
			}
		case EventUsageSample:
			s.usage = Usage{
				TokIn:          e.TokIn,
				TokOut:         e.TokOut,
				TokCacheRead:   e.TokCacheRead,
				TokCacheCreate: e.TokCacheCreate,
				CostUSD:        e.CostUSD,
			}
		}
	}
	return order
}

// runID names the Nth run of a slug. The first run keeps the bare slug, so the
// ordinary one-container-per-branch day reads exactly as it always has; a
// restart appends "#N", which is what lets the dashboard — whose bars are keyed
// on session_id — draw a branch's runs as the separate sessions they are.
func runID(slug string, run int) string {
	if run <= 1 {
		return slug
	}
	return slug + "#" + strconv.Itoa(run)
}

// roundSec keeps the suspect reason strings readable (and identical in shape to
// the daemon's, which the operator sees side by side in a merged view).
func roundSec(d time.Duration) time.Duration { return d.Round(time.Second) }

func sessStartTS(s *sess) string {
	if s.start.StartedAt != "" {
		return s.start.StartedAt
	}
	return s.start.TS
}

func overlapsWindow(startRFC, endRFC string, opts CompileOptions) bool {
	if opts.Since.IsZero() && opts.Until.IsZero() {
		return true
	}
	s, okS := timeline.ParseNanos(startRFC)
	e, okE := timeline.ParseNanos(endRFC)
	if !okS || !okE {
		return true // don't drop what we can't measure
	}
	if !opts.Since.IsZero() && e < opts.Since.UnixNano() {
		return false
	}
	if !opts.Until.IsZero() && s >= opts.Until.UnixNano() {
		return false
	}
	return true
}

func orDefault(v, def string) string {
	if v == "" {
		return def
	}
	return v
}
