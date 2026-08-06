// Command switchboard-dashboard serves a small web UI over the activity
// timeline produced by Switchboard. It shells out to `switchboard-ctl timeline
// --json` (the stable consumer contract) and renders the result; it never reads
// history files directly.
package main

import (
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/tjmisko/switchboard-dashboard/internal/flagagent"
	"github.com/tjmisko/switchboard-dashboard/internal/flags"
	"github.com/tjmisko/switchboard-dashboard/internal/provider"
)

func main() {
	port := flag.Int("port", 8080, "HTTP port to listen on")
	bind := flag.String("bind", DefaultBindAddr, "interface to listen on; the default keeps the server off the network")
	ctl := flag.String("ctl", "switchboard-ctl", "switchboard-ctl binary (resolved via PATH)")
	dir := flag.String("dir", "", "history dir passed to ctl as --dir; empty uses ctl's own default")
	plan := flag.String("plan", DefaultPlanPath, "cached OAuth plan-usage file, read read-only for the utilization gauge")
	summaries := flag.String("summaries", defaultSummariesDir(), "session-summary records written by session-digest; empty disables /api/summaries")
	providers := flag.String("providers", "", "providers config JSON; when set, replaces the default single claude provider with a merged adapter set")
	settingsPath := flag.String("settings", DefaultSettingsPath(), "operator-model settings JSON (away threshold, switch recovery); missing file means defaults")
	flagsDir := flag.String("flags-dir", defaultFlagsDir(), "store for operator data-quality flags and their reversible overlays; empty disables flagging")
	investigate := flag.String("investigate", "sonnet", "model for the `claude -p` investigation a flag spawns; empty records flags without investigating them")
	// $0.50 was the first guess and it was too low: a lane with no session id
	// makes the agent search by pid across day-files, and one such investigation
	// stopped mid-tool-use having spent $0.67. The ceiling has to clear the hard
	// cases, not the easy ones — a cheap lane still costs what it costs.
	investigateBudget := flag.String("investigate-budget", "1.50", "dollar ceiling for a single investigation (claude --max-budget-usd)")
	flag.Parse()

	settings, err := LoadSettings(*settingsPath)
	if err != nil {
		log.Fatalf("%v", err)
	}

	srv := &Server{
		Ctl: *ctl, Dir: *dir, PlanPath: *plan, SummariesDir: *summaries,
		Settings: settings, Flags: flags.NewStore(*flagsDir),
	}
	if *flagsDir != "" && *investigate != "" {
		// The investigation runs rooted at the flag store, which keeps its own
		// transcripts out of the projects session-digest scans — the same trick
		// sessiondigest.ClaudeRunner uses to avoid summarizing itself.
		runner := flagagent.ClaudeRunner(*investigate, *flagsDir, historyDir(*dir), *investigateBudget)
		srv.Investigator = flagagent.Limit(flagagent.New(runner, *investigate), maxConcurrentInvestigations)
		log.Printf("switchboard-dashboard investigating flags with %q (max $%s each, %d at a time)",
			*investigate, *investigateBudget, maxConcurrentInvestigations)
	}
	if *providers != "" {
		cfg, err := provider.LoadConfig(*providers)
		if err != nil {
			log.Fatalf("load providers config: %v", err)
		}
		provs, err := cfg.Build()
		if err != nil {
			log.Fatalf("build providers: %v", err)
		}
		srv.Providers = provs
		log.Printf("switchboard-dashboard using %d merged providers from %s", len(provs), *providers)
	}

	// Settle anything a previous process left mid-investigation before serving:
	// its goroutine died with that process, so the record would otherwise sit at
	// "investigating" forever and absorb every re-flag.
	srv.RecoverInterrupted()

	addr := net.JoinHostPort(*bind, strconv.Itoa(*port))
	httpServer := &http.Server{
		Addr:              addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	log.Printf("switchboard-dashboard listening on http://%s (ctl=%q dir=%q plan=%q)", addr, *ctl, *dir, *plan)
	log.Fatal(httpServer.ListenAndServe())
}

// defaultSummariesDir is where cmd/session-digest writes its records; missing
// is fine (the endpoint serves an empty set until a backfill runs).
func defaultSummariesDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".local", "share", "switchboard", "summaries")
}

// maxConcurrentInvestigations caps the agents in flight. Flags arrive in bursts
// — an operator who notices one bad lane usually notices three — and each
// investigation is a whole Claude Code process reading a multi-megabyte log.
const maxConcurrentInvestigations = 2

// historyDir resolves the directory the investigation is granted read access to
// (claude --add-dir). It is the dashboard's configured --dir when set, and
// otherwise the location switchboard-ctl itself defaults to, because the
// evidence lives outside the agent's working directory either way.
func historyDir(configured string) string {
	if configured != "" {
		return configured
	}
	if state := os.Getenv("XDG_STATE_HOME"); state != "" {
		return filepath.Join(state, "switchboard", "history")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".local", "state", "switchboard", "history")
}

// defaultFlagsDir is where the dashboard keeps its own flag records. It lives
// under state rather than share (losing it loses operator judgement that cannot
// be regenerated) and beside switchboard's history rather than inside it, since
// the log there belongs to the producer and nothing here may write to it.
func defaultFlagsDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".local", "state", "switchboard", "flags")
}
