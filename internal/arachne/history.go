// Package arachne implements a switchboard data provider for Arachne's
// docker-based long-running agent sessions.
//
// Arachne keeps no session history of its own: each agent is a `docker run --rm`
// container named arachne-agent-<branch-slug>, so once it exits Docker forgets
// it. The recorder therefore polls `docker ps` on an interval and writes an
// append-only history log of lifecycle events; the compiler turns that log into
// the normalized timeline envelope the dashboard renders. Subagents (Claude
// `Task` sidechains) are parsed from each container's stream-json log.
//
// This file defines the history event schema and its append-only I/O plus the
// state reconstruction used for restart reconciliation.
package arachne

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
)

// Event kinds in the append-only history log.
const (
	EventSessionStart  = "session_start"
	EventSessionEnd    = "session_end"
	EventSubagentSpawn = "subagent_spawn"
	EventSubagentStop  = "subagent_stop"
	EventUsageSample   = "usage_sample"
)

// Session-end reasons.
const (
	ReasonExited   = "exited"   // container observed to disappear between polls
	ReasonInferred = "inferred" // container gone while the recorder was down
)

// Event is one line of the history log. Fields are shared across kinds; only the
// relevant ones are populated per Type. Timestamps are RFC3339.
type Event struct {
	Type      string `json:"type"`
	TS        string `json:"ts"`
	SessionID string `json:"session_id,omitempty"`
	Container string `json:"container,omitempty"`

	// session_start metadata
	Agent       string `json:"agent,omitempty"`
	Project     string `json:"project,omitempty"`
	ProjectFull string `json:"project_full,omitempty"`
	TaskID      string `json:"task_id,omitempty"`
	Phase       string `json:"phase,omitempty"`
	Brief       string `json:"brief,omitempty"`
	Workspace   string `json:"workspace,omitempty"`
	StartedAt   string `json:"started_at,omitempty"`

	// session_end
	End    string `json:"end,omitempty"`
	Reason string `json:"reason,omitempty"`

	// subagent_spawn / subagent_stop
	ToolUseID   string `json:"tool_use_id,omitempty"`
	AgentType   string `json:"agent_type,omitempty"`
	Description string `json:"description,omitempty"`

	// usage_sample: cumulative session totals as of TS
	TokIn          int64   `json:"tok_in,omitempty"`
	TokOut         int64   `json:"tok_out,omitempty"`
	TokCacheRead   int64   `json:"tok_cache_read,omitempty"`
	TokCacheCreate int64   `json:"tok_cache_create,omitempty"`
	CostUSD        float64 `json:"cost_usd,omitempty"`
}

// WriteEvent appends one JSON event line to w.
func WriteEvent(w io.Writer, e Event) error {
	b, err := json.Marshal(e)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	_, err = w.Write(b)
	return err
}

// ReadEvents parses a history stream. Blank and malformed lines are skipped so a
// partially-written trailing line (from a crash mid-append) never aborts a load.
func ReadEvents(r io.Reader) ([]Event, error) {
	var out []Event
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var e Event
		if err := json.Unmarshal(line, &e); err != nil {
			continue // tolerate a torn final line
		}
		if e.Type == "" {
			continue
		}
		out = append(out, e)
	}
	return out, sc.Err()
}

// LoadEvents reads all history events from a file. A missing file yields an
// empty slice, not an error (a fresh recorder has no history yet).
func LoadEvents(path string) ([]Event, error) {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	defer f.Close()
	return ReadEvents(f)
}

// Writer appends events to the history log file, flushing each line so a crash
// loses at most the in-flight write.
type Writer struct {
	f *os.File
}

// OpenWriter opens (creating parent dirs) the history log for appending.
func OpenWriter(path string) (*Writer, error) {
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, err
		}
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	return &Writer{f: f}, nil
}

// Append writes one event and syncs it to disk.
func (w *Writer) Append(e Event) error {
	if err := WriteEvent(w.f, e); err != nil {
		return err
	}
	return w.f.Sync()
}

// Close closes the underlying file.
func (w *Writer) Close() error { return w.f.Close() }

// Usage is a cumulative token/cost tally for a session.
type Usage struct {
	TokIn          int64   `json:"tok_in"`
	TokOut         int64   `json:"tok_out"`
	TokCacheRead   int64   `json:"tok_cache_read"`
	TokCacheCreate int64   `json:"tok_cache_create"`
	CostUSD        float64 `json:"cost_usd"`
}

// OpenSession is a session that has started but not yet ended, reconstructed
// from the history log for restart reconciliation.
type OpenSession struct {
	Start         Event            // the originating session_start
	LastTS        string           // max ts of any event seen for this session
	OpenSubagents map[string]Event // tool_use_id -> spawn event, still running
	Usage         Usage            // latest cumulative usage
}

// Reconstruct replays the history and returns the sessions still open (started
// with no matching session_end), each carrying its still-open subagents, latest
// usage, and the last timestamp observed — enough to reconcile against a fresh
// `docker ps` after a recorder restart.
func Reconstruct(events []Event) map[string]*OpenSession {
	open := map[string]*OpenSession{}
	for _, e := range events {
		if e.SessionID == "" {
			continue
		}
		switch e.Type {
		case EventSessionStart:
			open[e.SessionID] = &OpenSession{
				Start:         e,
				LastTS:        e.TS,
				OpenSubagents: map[string]Event{},
			}
		case EventSessionEnd:
			delete(open, e.SessionID)
		case EventSubagentSpawn:
			if s := open[e.SessionID]; s != nil {
				s.OpenSubagents[e.ToolUseID] = e
			}
		case EventSubagentStop:
			if s := open[e.SessionID]; s != nil {
				delete(s.OpenSubagents, e.ToolUseID)
			}
		case EventUsageSample:
			if s := open[e.SessionID]; s != nil {
				s.Usage = Usage{
					TokIn:          e.TokIn,
					TokOut:         e.TokOut,
					TokCacheRead:   e.TokCacheRead,
					TokCacheCreate: e.TokCacheCreate,
					CostUSD:        e.CostUSD,
				}
			}
		}
		if s := open[e.SessionID]; s != nil && e.TS > s.LastTS {
			s.LastTS = e.TS
		}
	}
	return open
}
