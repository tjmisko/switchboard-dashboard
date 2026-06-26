// Command switchboard-dashboard serves a small web UI over the activity
// timeline produced by switchboard. It shells out to `switchboard-ctl timeline
// --json` (the stable consumer contract) and renders the result; it never reads
// history files directly.
package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"time"
)

func main() {
	port := flag.Int("port", 8080, "HTTP port to listen on")
	ctl := flag.String("ctl", "switchboard-ctl", "switchboard-ctl binary (resolved via PATH)")
	dir := flag.String("dir", "", "history dir passed to ctl as --dir; empty uses ctl's own default")
	plan := flag.String("plan", DefaultPlanPath, "cached OAuth plan-usage file, read read-only for the utilization gauge")
	flag.Parse()

	srv := &Server{Ctl: *ctl, Dir: *dir, PlanPath: *plan}

	addr := fmt.Sprintf(":%d", *port)
	httpServer := &http.Server{
		Addr:              addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	log.Printf("switchboard-dashboard listening on http://localhost%s (ctl=%q dir=%q plan=%q)", addr, *ctl, *dir, *plan)
	log.Fatal(httpServer.ListenAndServe())
}
