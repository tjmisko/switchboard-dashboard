package main

import (
	"bytes"
	"embed"
	"encoding/json"
	"io/fs"
	"net/http"
	"os/exec"
)

//go:embed web
var webFS embed.FS

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
	Ctl string // path or name of switchboard-ctl (resolved via PATH by exec)
	Dir string // default history dir; "" lets ctl pick its own default
}

// Handler returns the mux serving both the API and the embedded static UI.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/timeline", s.handleTimeline)
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
