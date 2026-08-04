package main

import (
	"embed"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/tjmisko/switchboard-dashboard/internal/provider"
	"github.com/tjmisko/switchboard-dashboard/internal/timeline"
)

// Embed only the served assets (not web/*.test.js, which is dev-only).
//
//go:embed web/index.html web/model.js web/app.js web/style.css web/favicon.svg
var webFS embed.FS

// DefaultPlanPath is the cached OAuth plan-usage file Claude Code writes while a
// session runs. The dashboard reads it READ-ONLY for the official utilization %
// — it never calls the OAuth endpoint or refreshes the token.
const DefaultPlanPath = "/tmp/claude-plan-usage.json"

// planStaleAfter is how old the cached file may be before the % is flagged
// stale. The file only refreshes while a Claude Code session is live, so a gap
// is expected and surfaced (grayed) rather than treated as an error.
const planStaleAfter = 5 * time.Minute

// Server wires the configured providers into HTTP handlers. With no explicit
// Providers, it synthesizes a single "claude" provider from Ctl/Dir, preserving
// the original byte-for-byte switchboard-ctl proxy behavior.
type Server struct {
	Ctl      string // path or name of switchboard-ctl for the default claude provider
	Dir      string // default history dir for the default claude provider; "" lets ctl default
	PlanPath string // cached OAuth plan-usage file; "" uses DefaultPlanPath
	// SummariesDir is the session-summary record store written by
	// cmd/session-digest (<dir>/<project-slug>/<session-id>.json); "" disables
	// the /api/summaries endpoint (it serves an empty set).
	SummariesDir string
	// Providers, when non-empty, replaces the default single-claude provider with
	// an explicit adapter set whose envelopes are merged into one unified view.
	Providers []provider.Provider
	// Settings are the operator-model tunables served to the frontend. The zero
	// value is not meaningful — main loads them (defaults when unconfigured).
	Settings Settings
}

// providerList returns the configured providers, or a single default claude
// provider built from Ctl/Dir when none are configured.
func (s *Server) providerList() []provider.Provider {
	if len(s.Providers) > 0 {
		return s.Providers
	}
	ctl := s.Ctl
	if ctl == "" {
		ctl = "switchboard-ctl"
	}
	// --plan-window attaches the rolling 5h plan_window total (the $ half of the
	// cost gauge); it is always "now"-anchored, so we request it unconditionally.
	base := []string{ctl, "timeline", "--json", "--plan-window"}
	return []provider.Provider{
		provider.NewSubprocessProvider("claude", "Claude", base, s.Dir, provider.Capabilities{Plan: true}),
	}
}

// Handler returns the mux serving both the API and the embedded static UI.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/timeline", s.handleTimeline)
	mux.HandleFunc("/api/plan", s.handlePlan)
	mux.HandleFunc("/api/summaries", s.handleSummaries)
	mux.HandleFunc("/api/settings", s.handleSettings)
	mux.Handle("/", s.staticHandler())
	return mux
}

// staticHandler serves the embedded web/ assets (index.html, app.js, style.css)
// rooted at /.
func (s *Server) staticHandler() http.Handler {
	sub, err := fs.Sub(webFS, "web")
	if err != nil {
		// embed guarantees web/ exists at build time; a failure here is a bug.
		panic(err)
	}
	return http.FileServer(http.FS(sub))
}

// timelineError is the JSON body returned when ctl fails.
type timelineError struct {
	Error  string `json:"error"`
	Stderr string `json:"stderr,omitempty"`
}

// handleTimeline produces the timeline envelope. With a single provider it
// proxies that provider's stdout verbatim (byte-identical, preserving any fields
// the Go structs don't model). With multiple providers it fetches them in
// parallel and merges their envelopes into one unified, namespaced view; a
// provider that fails is recorded in provider_errors rather than blanking the
// whole dashboard, and only an all-providers-failed request becomes a 502.
func (s *Server) handleTimeline(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	ps := s.providerList()
	ctx := r.Context()

	if len(ps) == 1 {
		params := provider.Params{Day: q.Get("day"), Since: q.Get("since"), Until: q.Get("until"), Dir: q.Get("dir")}
		raw, err := ps[0].Fetch(ctx, params)
		if err != nil {
			s.writeTimelineError(w, ps[0].ID(), err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(raw)
		return
	}

	// Multi-provider: the query dir is single-source and does not map across
	// providers, so each uses its own configured dir; only the window flags
	// (day/since/until) are provider-agnostic and forwarded.
	params := provider.Params{Day: q.Get("day"), Since: q.Get("since"), Until: q.Get("until")}

	type result struct {
		id  string
		tl  *timeline.Timeline
		err error
	}
	results := make([]result, len(ps))
	var wg sync.WaitGroup
	for i, p := range ps {
		wg.Add(1)
		go func(i int, p provider.Provider) {
			defer wg.Done()
			raw, err := p.Fetch(ctx, params)
			if err != nil {
				results[i] = result{id: p.ID(), err: err}
				return
			}
			tl, perr := timeline.Parse(raw)
			if perr != nil {
				results[i] = result{id: p.ID(), err: perr}
				return
			}
			results[i] = result{id: p.ID(), tl: tl}
		}(i, p)
	}
	wg.Wait()

	var sourced []timeline.Sourced
	var provErrs []timeline.ProviderError
	for _, res := range results {
		if res.err != nil {
			provErrs = append(provErrs, timeline.ProviderError{Provider: res.id, Error: providerErrString(res.err)})
			continue
		}
		sourced = append(sourced, timeline.Sourced{Provider: res.id, Timeline: res.tl})
	}

	if len(sourced) == 0 {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(timelineError{Error: "all providers failed", Stderr: joinProviderErrors(provErrs)})
		return
	}

	merged := timeline.Merge(sourced, timeline.MergeOptions{Window: windowLabel(q)})
	merged.ProviderErrors = append(merged.ProviderErrors, provErrs...)
	out, err := merged.Marshal()
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(timelineError{Error: "merge encode failed: " + err.Error()})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(out)
}

// writeTimelineError writes a 502 for a single-provider failure, surfacing the
// subprocess stderr when present.
func (s *Server) writeTimelineError(w http.ResponseWriter, id string, err error) {
	stderr := ""
	var ee *provider.ExecError
	if errors.As(err, &ee) {
		stderr = ee.Stderr
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusBadGateway)
	_ = json.NewEncoder(w).Encode(timelineError{
		Error:  "provider " + id + " failed: " + err.Error(),
		Stderr: stderr,
	})
}

// providerErrString renders a provider failure into a single line, folding in
// the subprocess stderr when available.
func providerErrString(err error) string {
	var ee *provider.ExecError
	if errors.As(err, &ee) && strings.TrimSpace(ee.Stderr) != "" {
		return err.Error() + ": " + strings.TrimSpace(ee.Stderr)
	}
	return err.Error()
}

// joinProviderErrors renders the collected provider errors for an all-failed 502.
func joinProviderErrors(errs []timeline.ProviderError) string {
	parts := make([]string, 0, len(errs))
	for _, e := range errs {
		parts = append(parts, e.Provider+": "+e.Error)
	}
	return strings.Join(parts, "; ")
}

// windowLabel derives a display window label for the merged envelope from the
// request params.
func windowLabel(q map[string][]string) string {
	get := func(k string) string {
		if v := q[k]; len(v) > 0 {
			return v[0]
		}
		return ""
	}
	if day := get("day"); day != "" {
		return day
	}
	since := get("since")
	if since == "" {
		return ""
	}
	if until := get("until"); until != "" {
		return since + ".." + until
	}
	return since
}

// planBucket is one rolling-limit window from the cached OAuth file. The
// *_dollars fields are always null for a solo subscription (Anthropic only
// exposes utilization %), so we surface the percentage and its reset time.
type planBucket struct {
	Utilization *float64 `json:"utilization"`
	ResetsAt    *string  `json:"resets_at"`
}

// planFile is the subset of /tmp/claude-plan-usage.json the dashboard reads.
type planFile struct {
	FiveHour     *planBucket `json:"five_hour"`
	SevenDay     *planBucket `json:"seven_day"`
	SevenDayOpus *planBucket `json:"seven_day_opus"`
}

// planResponse is the normalized /api/plan body. `available:false` is a 200 (an
// absent cache file is an expected, non-error state) so the UI degrades
// gracefully; `stale` and `age_seconds` are derived from the file mtime so the
// UI can gray out a % that hasn't refreshed recently.
type planResponse struct {
	Available    bool        `json:"available"`
	Error        string      `json:"error,omitempty"`
	Mtime        string      `json:"mtime,omitempty"`
	AgeSeconds   int64       `json:"age_seconds,omitempty"`
	Stale        bool        `json:"stale,omitempty"`
	FiveHour     *planBucket `json:"five_hour,omitempty"`
	SevenDay     *planBucket `json:"seven_day,omitempty"`
	SevenDayOpus *planBucket `json:"seven_day_opus,omitempty"`
}

// planPath resolves the configured plan file, defaulting to DefaultPlanPath.
func (s *Server) planPath() string {
	if s.PlanPath != "" {
		return s.PlanPath
	}
	return DefaultPlanPath
}

// readPlan reads and normalizes the cached plan-usage file relative to `now`
// (injected for testable staleness). It never writes and never errors on a
// missing file — absence yields {available:false}.
func readPlan(path string, now time.Time) planResponse {
	info, err := os.Stat(path)
	if err != nil {
		// Missing file is the common, expected case (no recent session).
		return planResponse{Available: false}
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return planResponse{Available: false, Error: err.Error()}
	}
	var pf planFile
	if err := json.Unmarshal(raw, &pf); err != nil {
		return planResponse{Available: false, Error: "malformed plan cache: " + err.Error()}
	}
	age := now.Sub(info.ModTime())
	if age < 0 {
		age = 0
	}
	return planResponse{
		Available:    true,
		Mtime:        info.ModTime().UTC().Format(time.RFC3339),
		AgeSeconds:   int64(age.Seconds()),
		Stale:        age > planStaleAfter,
		FiveHour:     pf.FiveHour,
		SevenDay:     pf.SevenDay,
		SevenDayOpus: pf.SevenDayOpus,
	}
}

// handleSettings serves the operator-model tunables the frontend applies. Always
// 200 JSON: an unconfigured dashboard serves the defaults, which are the same
// numbers the frontend falls back to if this fetch fails.
func (s *Server) handleSettings(w http.ResponseWriter, r *http.Request) {
	out := s.Settings
	if out.AwayAfterMs <= 0 { // zero value Server (tests, embedders) → ship defaults
		out = DefaultSettings()
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

// handlePlan serves the read-only plan-usage view. Always 200 JSON.
func (s *Server) handlePlan(w http.ResponseWriter, r *http.Request) {
	resp := readPlan(s.planPath(), time.Now())
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

// summaryEntry is the per-session slice of a session-digest record the UI
// needs for hover enrichment: the generated identity, not the full digest.
type summaryEntry struct {
	Name        string   `json:"name,omitempty"`
	Description string   `json:"description"`
	Tasks       []string `json:"tasks,omitempty"`
	Summary     string   `json:"summary,omitempty"`
	GeneratedAt string   `json:"generated_at,omitempty"`
}

// summariesResponse maps session id → generated summary. Sessions without a
// generated summary (digest-only records) are omitted — the UI already shows
// digest-level identity from the timeline itself.
type summariesResponse struct {
	Sessions map[string]summaryEntry `json:"sessions"`
}

// summaryRecord is the subset of cmd/session-digest's Record this endpoint
// reads back from disk.
type summaryRecord struct {
	Digest struct {
		SessionID string `json:"sessionId"`
	} `json:"digest"`
	Summary *struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		// tasks is held raw and decoded by summaryTasks: typing it []string
		// here would make an unexpected shape fail the whole record's
		// Unmarshal, costing the session its name and prose over a field that
		// is only enrichment.
		Tasks   json.RawMessage `json:"tasks"`
		Summary string          `json:"summary"`
	} `json:"summary"`
	GeneratedAt string `json:"generatedAt"`
}

// summaryTasks decodes a record's raw tasks field, keeping the entries that are
// strings and dropping anything else. A malformed or unexpected shape yields no
// bullets rather than discarding the record.
func summaryTasks(raw json.RawMessage) []string {
	var elements []json.RawMessage
	if json.Unmarshal(raw, &elements) != nil {
		return nil
	}
	var tasks []string
	for _, element := range elements {
		var task string
		if json.Unmarshal(element, &task) == nil && task != "" {
			tasks = append(tasks, task)
		}
	}
	return tasks
}

// readSummaries walks dir (<project-slug>/<session-id>.json, as written by
// cmd/session-digest) and collects the generated summaries by session id. A
// missing or empty dir yields an empty map; malformed records are skipped —
// the endpoint is best-effort enrichment, never an error surface.
func readSummaries(dir string) map[string]summaryEntry {
	out := map[string]summaryEntry{}
	if dir == "" {
		return out
	}
	slugs, err := os.ReadDir(dir)
	if err != nil {
		return out
	}
	for _, slug := range slugs {
		if !slug.IsDir() {
			continue
		}
		slugDir := filepath.Join(dir, slug.Name())
		files, err := os.ReadDir(slugDir)
		if err != nil {
			continue
		}
		for _, f := range files {
			if f.IsDir() || !strings.HasSuffix(f.Name(), ".json") {
				continue
			}
			raw, err := os.ReadFile(filepath.Join(slugDir, f.Name()))
			if err != nil {
				continue
			}
			var rec summaryRecord
			if json.Unmarshal(raw, &rec) != nil || rec.Summary == nil || rec.Summary.Description == "" {
				continue
			}
			id := rec.Digest.SessionID
			if id == "" {
				id = strings.TrimSuffix(f.Name(), ".json")
			}
			out[id] = summaryEntry{
				Name:        rec.Summary.Name,
				Description: rec.Summary.Description,
				Tasks:       summaryTasks(rec.Summary.Tasks),
				Summary:     rec.Summary.Summary,
				GeneratedAt: rec.GeneratedAt,
			}
		}
	}
	return out
}

// handleSummaries serves the session-summary map. Always 200 JSON; an absent
// store is the expected pre-backfill state and yields an empty set.
func (s *Server) handleSummaries(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(summariesResponse{Sessions: readSummaries(s.SummariesDir)})
}
