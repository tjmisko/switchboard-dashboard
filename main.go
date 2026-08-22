// Command switchboard-dashboard serves a small web UI over the activity
// timeline produced by Switchboard. It shells out to `switchboard-ctl timeline
// --json` (the stable consumer contract) and renders the result; it never reads
// history files directly.
package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/tjmisko/switchboard-dashboard/internal/provider"
)

func main() {
	port := flag.Int("port", 8080, "HTTP port to listen on")
	ctl := flag.String("ctl", "switchboard-ctl", "switchboard-ctl binary (resolved via PATH)")
	dir := flag.String("dir", "", "history dir passed to ctl as --dir; empty uses ctl's own default")
	plan := flag.String("plan", DefaultPlanPath, "cached OAuth plan-usage file, read read-only for the utilization gauge")
	summaries := flag.String("summaries", defaultSummariesDir(), "session-summary records written by session-digest; empty disables /api/summaries")
	providers := flag.String("providers", "", "providers config JSON; when set, replaces the default Switchboard adapter with a merged adapter set")
	settingsPath := flag.String("settings", DefaultSettingsPath(), "operator-model settings JSON (away threshold, switch recovery); missing file means defaults")
	flag.Parse()

	settings, err := LoadSettings(*settingsPath)
	if err != nil {
		log.Fatalf("%v", err)
	}

	srv := &Server{Ctl: *ctl, Dir: *dir, PlanPath: *plan, SummariesDir: *summaries, Settings: settings}
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

	addr := fmt.Sprintf(":%d", *port)
	httpServer := &http.Server{
		Addr:              addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	log.Printf("switchboard-dashboard listening on http://localhost%s (ctl=%q dir=%q plan=%q)", addr, *ctl, *dir, *plan)
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
