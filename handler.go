package main

import (
	"bytes"
	"embed"
	"encoding/json"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"time"
)

//go:embed web
var webFS embed.FS

// DefaultPlanPath is the cached OAuth plan-usage file Claude Code writes while a
// session runs. The dashboard reads it READ-ONLY for the official utilization %
// — it never calls the OAuth endpoint or refreshes the token.
const DefaultPlanPath = "/tmp/claude-plan-usage.json"

// planStaleAfter is how old the cached file may be before the % is flagged
// stale. The file only refreshes while a Claude Code session is live, so a gap
// is expected and surfaced (grayed) rather than treated as an error.
const planStaleAfter = 5 * time.Minute

// TimelineParams holds the request-derived inputs that map onto
// `switchboard-ctl timeline` flags.
type TimelineParams struct {
	Day   string
	Since string
	Until string
	Dir   string
}

// argvFor builds the full argv for invoking switchboard-ctl, including the
// binary itself as argv[0]. It is a pure function so the param->flag mapping
// can be unit-tested directly. Empty params are omitted, letting ctl apply its
// own defaults.
func argvFor(ctl string, p TimelineParams) []string {
	argv := []string{ctl, "timeline", "--json"}
	if p.Dir != "" {
		argv = append(argv, "--dir", p.Dir)
	}
	if p.Day != "" {
		argv = append(argv, "--day", p.Day)
	}
	if p.Since != "" {
		argv = append(argv, "--since", p.Since)
	}
	if p.Until != "" {
		argv = append(argv, "--until", p.Until)
	}
	return argv
}

// Server wires the configured ctl binary and history dir into HTTP handlers.
type Server struct {
	Ctl      string // path or name of switchboard-ctl (resolved via PATH by exec)
	Dir      string // default history dir; "" lets ctl pick its own default
	PlanPath string // cached OAuth plan-usage file; "" uses DefaultPlanPath
}

// Handler returns the mux serving both the API and the embedded static UI.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/timeline", s.handleTimeline)
	mux.HandleFunc("/api/plan", s.handlePlan)
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

// handleTimeline execs `switchboard-ctl timeline --json` with the requested
// window and proxies its stdout. A non-zero ctl exit becomes a 502 carrying the
// captured stderr.
func (s *Server) handleTimeline(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	dir := q.Get("dir")
	if dir == "" {
		dir = s.Dir
	}
	p := TimelineParams{
		Day:   q.Get("day"),
		Since: q.Get("since"),
		Until: q.Get("until"),
		Dir:   dir,
	}
	argv := argvFor(s.Ctl, p)

	cmd := exec.CommandContext(r.Context(), argv[0], argv[1:]...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(timelineError{
			Error:  "switchboard-ctl failed: " + err.Error(),
			Stderr: stderr.String(),
		})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(stdout.Bytes())
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

// handlePlan serves the read-only plan-usage view. Always 200 JSON.
func (s *Server) handlePlan(w http.ResponseWriter, r *http.Request) {
	resp := readPlan(s.planPath(), time.Now())
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}
