// Command arachne-switchboard-ctl compiles the recorder's append-only history
// into the documents the Switchboard dashboard consumes. It implements the same
// consumer contract as switchboard-ctl, so the dashboard plugs it in as just
// another provider:
//
//	arachne-switchboard-ctl timeline --json [--dir D] [--day D] [--since S] [--until U]
//	arachne-switchboard-ctl memory   --json [--dir D] [--day D] [--since S] [--until U]
//
// `timeline` prints the envelope the lanes are drawn from. `memory` prints the
// separate document behind /api/memory — separate because a live sample series
// would change the timeline bytes on every poll and defeat the dashboard's
// unchanged-means-no-repaint check.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/tjmisko/switchboard-dashboard/internal/arachne"
)

const usage = "usage: arachne-switchboard-ctl {timeline|memory} --json [--dir D | --history F] [--day D] [--since S] [--until U]"

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}
	sub := os.Args[1]
	if sub != "timeline" && sub != "memory" {
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}

	events, opts := load(sub, os.Args[2:])

	var out []byte
	var err error
	if sub == "memory" {
		out, err = json.Marshal(arachne.CompileMemory(events, opts))
	} else {
		out, err = arachne.Compile(events, opts).Marshal()
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "encode: %v\n", err)
		os.Exit(1)
	}
	os.Stdout.Write(out)
}

// load parses the window flags both subcommands share and reads the history.
// The flag set is identical for the two so the dashboard can derive one
// invocation from the other by swapping the subcommand alone, which is exactly
// what SubprocessProvider.memoryArgv does.
func load(sub string, args []string) ([]arachne.Event, arachne.CompileOptions) {
	fs := flag.NewFlagSet(sub, flag.ExitOnError)
	_ = fs.Bool("json", false, "emit JSON (the only supported format)")
	_ = fs.Bool("plan-window", false, "accepted for contract compatibility; Arachne has no plan window")
	dir := fs.String("dir", "", "recorder output directory (contains history.jsonl)")
	historyFile := fs.String("history", "", "explicit history log path (overrides --dir)")
	day := fs.String("day", "", "restrict to a calendar day YYYY-MM-DD (local time)")
	since := fs.String("since", "", "window start date YYYY-MM-DD (local time)")
	until := fs.String("until", "", "window end date YYYY-MM-DD (local time, inclusive)")
	if err := fs.Parse(args); err != nil {
		os.Exit(2)
	}

	path := *historyFile
	if path == "" {
		d := *dir
		if d == "" {
			d = arachne.DefaultDir()
		}
		path = filepath.Join(d, arachne.HistoryFileName)
	}

	events, err := arachne.LoadEvents(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "read history %s: %v\n", path, err)
		os.Exit(1)
	}

	sinceT, untilT, label, err := windowBounds(*day, *since, *until)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%v\n", err)
		os.Exit(2)
	}
	return events, arachne.CompileOptions{
		Now:    time.Now(),
		Window: label,
		Since:  sinceT,
		Until:  untilT,
	}
}

// windowBounds turns the day/since/until flags into a [since, until) time window
// (local calendar days) and a display label. A zero time means unbounded.
func windowBounds(day, since, until string) (time.Time, time.Time, string, error) {
	const layout = "2006-01-02"
	parse := func(s string) (time.Time, error) {
		return time.ParseInLocation(layout, s, time.Local)
	}
	if day != "" {
		d, err := parse(day)
		if err != nil {
			return time.Time{}, time.Time{}, "", fmt.Errorf("bad --day %q: %w", day, err)
		}
		return d, d.AddDate(0, 0, 1), day, nil
	}
	var sinceT, untilT time.Time
	label := ""
	if since != "" {
		d, err := parse(since)
		if err != nil {
			return time.Time{}, time.Time{}, "", fmt.Errorf("bad --since %q: %w", since, err)
		}
		sinceT = d
		label = since
	}
	if until != "" {
		d, err := parse(until)
		if err != nil {
			return time.Time{}, time.Time{}, "", fmt.Errorf("bad --until %q: %w", until, err)
		}
		untilT = d.AddDate(0, 0, 1) // inclusive of the until day
		if label != "" {
			label += ".." + until
		} else {
			label = until
		}
	}
	return sinceT, untilT, label, nil
}
