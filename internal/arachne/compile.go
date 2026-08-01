package arachne

import (
	"fmt"
	"sort"
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
		trustedNs := int64(0)
		if unclosed {
			evidenceTS := s.lastTS
			if evidenceTS == "" {
				evidenceTS = startRFC
			}
			if es, ee, ok := timeline.SpanNanos(evidenceTS, endRFC); ok && ee-es >= int64(timeline.DefaultSuspectTrailingCap) {
				lane.Suspect = true
				lane.SuspectSince = evidenceTS
				lane.SuspectReason = fmt.Sprintf("unclosed lane stretched to now: %s since the last event >= %s cap",
					roundSec(time.Duration(ee-es)), roundSec(timeline.DefaultSuspectTrailingCap))
				trustedNs = es
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
			if trustedNs > 0 && trustedNs < creditEnd {
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
			if trustedNs > 0 {
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

type sess struct {
	id        string
	start     Event
	endTS     string
	endReason string
	subOpen   map[string]*sub
	subs      []*sub
	usage     Usage
	seen      bool

	// lastTS is the newest event timestamp seen for this session, and lastNs its
	// parsed form. For a session that never logged a session_end, this is the last
	// instant there is evidence for — everything between it and the bound Compile
	// stretches the lane to is inference. See the suspect check in Compile.
	lastTS string
	lastNs int64
}

// aggregate folds the event stream into per-session records.
func aggregate(events []Event) []*sess {
	byID := map[string]*sess{}
	order := []*sess{}
	get := func(id string) *sess {
		s := byID[id]
		if s == nil {
			s = &sess{id: id, subOpen: map[string]*sub{}}
			byID[id] = s
			order = append(order, s)
		}
		return s
	}
	for _, e := range events {
		if e.SessionID == "" {
			continue
		}
		s := get(e.SessionID)
		if ns, ok := timeline.ParseNanos(e.TS); ok && ns > s.lastNs {
			s.lastTS, s.lastNs = e.TS, ns
		}
		switch e.Type {
		case EventSessionStart:
			s.start = e
			s.seen = true
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
	out := make([]*sess, 0, len(order))
	for _, s := range order {
		if s.seen {
			out = append(out, s) // drop sessions we never saw start for
		}
	}
	return out
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
