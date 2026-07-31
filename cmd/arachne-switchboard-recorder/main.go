// Command arachne-switchboard-recorder is the standalone daemon that gives the
// Switchboard dashboard visibility into Arachne's docker-based long-running
// sessions. Arachne containers run with `--rm` and set no labels, so once one
// exits Docker forgets it entirely. This daemon polls `docker ps` on an interval,
// inspects each arachne-agent-* container for its session metadata, tails the
// container's stream-json log for Task subagents and token usage, and writes an
// append-only history log that survives restarts. The arachne-switchboard-ctl
// compiler turns that history into a timeline envelope for the dashboard.
package main

import (
	"context"
	"flag"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/tjmisko/switchboard-dashboard/internal/arachne"
)

func main() {
	historyPath := flag.String("history", arachne.DefaultHistoryPath(), "append-only history log path")
	statePath := flag.String("state", arachne.DefaultStatePath(), "reconciliation state snapshot path")
	interval := flag.Duration("interval", 5*time.Second, "docker poll interval")
	dockerBin := flag.String("docker", "docker", "docker binary (resolved via PATH)")
	flag.Parse()

	client := &arachne.Client{Runner: arachne.ExecRunner{Bin: *dockerBin}}
	rec := arachne.NewRecorder(arachne.Config{
		Docker:      client,
		HistoryPath: *historyPath,
		StatePath:   *statePath,
		Interval:    *interval,
	})

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	log.Printf("arachne-switchboard-recorder polling every %s (history=%q state=%q)", *interval, *historyPath, *statePath)
	if err := rec.Run(ctx); err != nil && err != context.Canceled {
		log.Fatalf("recorder: %v", err)
	}
	log.Printf("arachne-switchboard-recorder stopped")
}
