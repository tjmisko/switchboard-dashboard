// Command arachne-switchboard-ctl compiles the recorder's append-only history
// into a Switchboard timeline envelope. It implements the same consumer contract
// as switchboard-ctl — `arachne-switchboard-ctl timeline --json [--dir D]
// [--day D] [--since S] [--until U]` prints an envelope on stdout — so the
// dashboard plugs it in as just another provider.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/tjmisko/switchboard-dashboard/internal/arachne"
)

func main() {
	if len(os.Args) < 2 || os.Args[1] != "timeline" {
		fmt.Fprintln(os.Stderr, "usage: arachne-switchboard-ctl timeline --json [--dir D | --history F] [--day D] [--since S] [--until U]")
		os.Exit(2)
	}

	fs := flag.NewFlagSet("timeline", flag.ExitOnError)
	_ = fs.Bool("json", false, "emit JSON (the only supported format)")
	_ = fs.Bool("plan-window", false, "accepted for contract compatibility; Arachne has no plan window")
	dir := fs.String("dir", "", "recorder output directory (contains history.jsonl)")
	historyFile := fs.String("history", "", "explicit history log path (overrides --dir)")
	day := fs.String("day", "", "restrict to a calendar day YYYY-MM-DD (local time)")
	since := fs.String("since", "", "window start date YYYY-MM-DD (local time)")
	until := fs.String("until", "", "window end date YYYY-MM-DD (local time, inclusive)")
	if err := fs.Parse(os.Args[2:]); err != nil {
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

	tl := arachne.Compile(events, arachne.CompileOptions{
		Now:    time.Now(),
		Window: label,
		Since:  sinceT,
		Until:  untilT,
	})
	out, err := tl.Marshal()
	if err != nil {
		fmt.Fprintf(os.Stderr, "encode: %v\n", err)
		os.Exit(1)
	}
	os.Stdout.Write(out)
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
