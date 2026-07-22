package arachne

import (
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
		if endRFC == "" {
			endRFC = nowRFC // still running
		}
		if !overlapsWindow(startRFC, endRFC, opts) {
			continue
		}

		subs := make([]timeline.Subagent, 0, len(s.subs))
		for _, su := range s.subs {
			suEnd := su.endTS
			if suEnd == "" {
				suEnd = nowRFC
			}
			subs = append(subs, timeline.Subagent{
				AgentType:   su.agentType,
				ToolUseID:   su.toolUseID,
				Description: su.description,
				Start:       su.startTS,
				End:         suEnd,
			})
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
		out.Lanes = append(out.Lanes, lane)

		// aggregates
		if ws, we, ok := timeline.SpanNanos(startRFC, endRFC); ok {
			dur := we - ws
			out.Summary.ByStatus["working"] += dur
			out.Summary.AttentionPerSession += dur
			out.Summary.AttentionFanout += dur
			aloftSpans = append(aloftSpans, [2]int64{ws, we})
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
		}
		for _, su := range subs {
			if ss, se, ok := timeline.SpanNanos(su.Start, su.End); ok {
				out.Summary.AttentionFanout += se - ss
				aloftSpans = append(aloftSpans, [2]int64{ss, se})
			}
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
