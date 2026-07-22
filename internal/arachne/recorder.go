package arachne

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"time"
)

// DockerClient is the docker surface the recorder needs (satisfied by *Client).
type DockerClient interface {
	ListRunningNames(ctx context.Context) ([]string, error)
	Inspect(ctx context.Context, name string) (Container, error)
}

// Config configures a Recorder.
type Config struct {
	Docker      DockerClient
	HistoryPath string        // append-only history log
	StatePath   string        // reconciliation snapshot (overwritten each tick)
	Interval    time.Duration // poll cadence
	// Now injects the clock (defaults to time.Now). Tick timestamps use it.
	Now func() time.Time
}

// Recorder polls docker for Arachne session containers, tails their stream-json
// logs for subagents and usage, and writes an append-only history the compiler
// turns into a timeline. It is the durable memory Arachne itself lacks (--rm
// containers vanish on exit).
type Recorder struct {
	docker      DockerClient
	historyPath string
	statePath   string
	interval    time.Duration
	now         func() time.Time

	writer *Writer
	live   map[string]*liveSession // keyed by session slug
}

type liveSession struct {
	container Container
	lastSeen  string
	logOffset int64
	openSubs  map[string]SubagentSpawn // tool_use_id -> Task spawn still running
	usage     Usage
}

// NewRecorder builds a Recorder from Config.
func NewRecorder(cfg Config) *Recorder {
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	interval := cfg.Interval
	if interval <= 0 {
		interval = 5 * time.Second
	}
	return &Recorder{
		docker:      cfg.Docker,
		historyPath: cfg.HistoryPath,
		statePath:   cfg.StatePath,
		interval:    interval,
		now:         now,
		live:        map[string]*liveSession{},
	}
}

// Run reconciles against current docker state, then polls until ctx is
// cancelled. It returns ctx.Err() on shutdown.
func (r *Recorder) Run(ctx context.Context) error {
	w, err := OpenWriter(r.historyPath)
	if err != nil {
		return err
	}
	r.writer = w
	defer r.writer.Close()

	if err := r.reconcile(ctx); err != nil {
		return err
	}
	if err := r.tick(ctx); err != nil && ctx.Err() == nil {
		return err
	}

	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if err := r.tick(ctx); err != nil && ctx.Err() == nil {
				return err
			}
		}
	}
}

// reconcile aligns persisted history with current docker state after a restart:
// sessions open in history but no longer running are closed at their last-seen
// time (reason "inferred"); sessions still running are resumed from the state
// snapshot's log offset.
func (r *Recorder) reconcile(ctx context.Context) error {
	events, err := LoadEvents(r.historyPath)
	if err != nil {
		return err
	}
	open := Reconstruct(events)
	state := loadState(r.statePath)

	names, err := r.docker.ListRunningNames(ctx)
	if err != nil {
		return err
	}
	liveSet := map[string]string{} // slug -> name
	for _, n := range names {
		liveSet[SlugOf(n)] = n
	}
	nowTS := r.nowTS()

	// Close sessions that ended while we were down.
	for slug, os_ := range open {
		if _, stillLive := liveSet[slug]; stillLive {
			continue
		}
		end := os_.LastTS
		if state != nil {
			if ss, ok := state.Sessions[slug]; ok && ss.LastSeen > end {
				end = ss.LastSeen
			}
		}
		if end == "" {
			end = nowTS
		}
		for id := range os_.OpenSubagents {
			_ = r.writer.Append(Event{Type: EventSubagentStop, TS: nowTS, SessionID: slug, ToolUseID: id, End: end})
		}
		_ = r.writer.Append(Event{Type: EventSessionEnd, TS: nowTS, SessionID: slug, End: end, Reason: ReasonInferred})
	}

	// Resume sessions still running.
	for slug, name := range liveSet {
		os_, wasOpen := open[slug]
		if !wasOpen {
			continue // handled as new by the first tick
		}
		c, err := r.docker.Inspect(ctx, name)
		if err != nil {
			continue
		}
		ls := &liveSession{
			container: c,
			lastSeen:  os_.LastTS,
			openSubs:  map[string]SubagentSpawn{},
			usage:     os_.Usage,
		}
		// Restore open subagents from history.
		for id, ev := range os_.OpenSubagents {
			ls.openSubs[id] = SubagentSpawn{ToolUseID: id, AgentType: ev.AgentType, Description: ev.Description, TS: ev.TS}
		}
		// Resume the log at the persisted offset; without one, skip the backlog
		// to avoid re-emitting subagents we already recorded before the crash.
		if state != nil {
			if ss, ok := state.Sessions[slug]; ok {
				ls.logOffset = ss.LogOffset
				if ss.LastSeen > ls.lastSeen {
					ls.lastSeen = ss.LastSeen
				}
			} else {
				ls.logOffset = fileSize(c.LogPath())
			}
		} else {
			ls.logOffset = fileSize(c.LogPath())
		}
		r.live[slug] = ls
	}
	return nil
}

// tick performs one poll: detect new/gone containers and advance each live
// session's log.
func (r *Recorder) tick(ctx context.Context) error {
	names, err := r.docker.ListRunningNames(ctx)
	if err != nil {
		return err
	}
	nowTS := r.nowTS()
	curr := map[string]string{}
	for _, n := range names {
		curr[SlugOf(n)] = n
	}

	// New containers.
	for slug, name := range curr {
		if _, ok := r.live[slug]; ok {
			continue
		}
		c, err := r.docker.Inspect(ctx, name)
		if err != nil {
			continue // try again next tick
		}
		start := c.StartedAt
		if start == "" {
			start = nowTS
		}
		project := "arachne"
		if c.RepoRoot != "" {
			project = filepath.Base(c.RepoRoot)
		}
		_ = r.writer.Append(Event{
			Type: EventSessionStart, TS: nowTS, SessionID: slug, Container: name,
			Agent: c.Agent, Project: project, ProjectFull: project,
			TaskID: c.TaskID, Phase: c.Phase, Brief: c.Brief,
			Workspace: c.Workspace, StartedAt: start,
		})
		r.live[slug] = &liveSession{container: c, lastSeen: nowTS, openSubs: map[string]SubagentSpawn{}}
	}

	// Gone containers.
	for slug, ls := range r.live {
		if _, ok := curr[slug]; ok {
			continue
		}
		end := ls.lastSeen
		if end == "" {
			end = nowTS
		}
		for id := range ls.openSubs {
			_ = r.writer.Append(Event{Type: EventSubagentStop, TS: nowTS, SessionID: slug, ToolUseID: id, End: end})
		}
		_ = r.writer.Append(Event{Type: EventSessionEnd, TS: nowTS, SessionID: slug, End: end, Reason: ReasonExited})
		delete(r.live, slug)
	}

	// Advance logs for surviving sessions.
	for slug, ls := range r.live {
		if _, ok := curr[slug]; !ok {
			continue
		}
		ls.lastSeen = nowTS
		r.advanceLog(slug, ls, nowTS)
	}

	r.writeState(nowTS)
	return nil
}

// advanceLog reads a session's log tail and records subagents and usage.
func (r *Recorder) advanceLog(slug string, ls *liveSession, nowTS string) {
	path := ls.container.LogPath()
	if path == "" {
		return
	}
	if sz := fileSize(path); sz < ls.logOffset {
		ls.logOffset = sz // log truncated/rotated; realign without re-reading
	}
	chunk, err := readFrom(path, ls.logOffset)
	if err != nil || len(chunk) == 0 {
		return
	}
	scan := ScanLog(chunk)
	ls.logOffset += int64(scan.Consumed)

	for _, sp := range scan.Spawns {
		if _, open := ls.openSubs[sp.ToolUseID]; open {
			continue
		}
		ls.openSubs[sp.ToolUseID] = sp
		_ = r.writer.Append(Event{
			Type: EventSubagentSpawn, TS: firstNonEmpty(sp.TS, nowTS), SessionID: slug,
			ToolUseID: sp.ToolUseID, AgentType: sp.AgentType, Description: sp.Description,
		})
	}
	for _, res := range scan.Results {
		if _, open := ls.openSubs[res.ToolUseID]; !open {
			continue // a Bash/Edit result, not a tracked subagent
		}
		delete(ls.openSubs, res.ToolUseID)
		_ = r.writer.Append(Event{
			Type: EventSubagentStop, TS: firstNonEmpty(res.TS, nowTS), SessionID: slug,
			ToolUseID: res.ToolUseID, End: firstNonEmpty(res.TS, nowTS),
		})
	}
	if scan.Usage != (Usage{}) {
		ls.usage.TokIn += scan.Usage.TokIn
		ls.usage.TokOut += scan.Usage.TokOut
		ls.usage.TokCacheRead += scan.Usage.TokCacheRead
		ls.usage.TokCacheCreate += scan.Usage.TokCacheCreate
		_ = r.writer.Append(Event{
			Type: EventUsageSample, TS: nowTS, SessionID: slug,
			TokIn: ls.usage.TokIn, TokOut: ls.usage.TokOut,
			TokCacheRead: ls.usage.TokCacheRead, TokCacheCreate: ls.usage.TokCacheCreate,
			CostUSD: ls.usage.CostUSD,
		})
	}
}

func (r *Recorder) nowTS() string { return r.now().UTC().Format(time.RFC3339) }

// --- state snapshot ---

type stateSnapshot struct {
	Updated  string                  `json:"updated"`
	Sessions map[string]sessionState `json:"sessions"`
}

type sessionState struct {
	LastSeen  string `json:"last_seen"`
	LogOffset int64  `json:"log_offset"`
	Usage     Usage  `json:"usage"`
}

func (r *Recorder) writeState(nowTS string) {
	if r.statePath == "" {
		return
	}
	snap := stateSnapshot{Updated: nowTS, Sessions: map[string]sessionState{}}
	for slug, ls := range r.live {
		snap.Sessions[slug] = sessionState{LastSeen: ls.lastSeen, LogOffset: ls.logOffset, Usage: ls.usage}
	}
	b, err := json.Marshal(snap)
	if err != nil {
		return
	}
	if dir := filepath.Dir(r.statePath); dir != "" {
		_ = os.MkdirAll(dir, 0o755)
	}
	tmp := r.statePath + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return
	}
	_ = os.Rename(tmp, r.statePath) // atomic replace
}

func loadState(path string) *stateSnapshot {
	if path == "" {
		return nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var snap stateSnapshot
	if err := json.Unmarshal(b, &snap); err != nil {
		return nil
	}
	if snap.Sessions == nil {
		snap.Sessions = map[string]sessionState{}
	}
	return &snap
}

// --- small fs helpers ---

func fileSize(path string) int64 {
	if path == "" {
		return 0
	}
	st, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return st.Size()
}

func readFrom(path string, offset int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	defer f.Close()
	if offset > 0 {
		if _, err := f.Seek(offset, io.SeekStart); err != nil {
			return nil, err
		}
	}
	return io.ReadAll(f)
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
