// Command session-digest condenses Claude Code session transcripts into
// per-session summary records. The digest half is deterministic extraction
// from ~/.claude/projects/<slug>/<session-id>.jsonl (titles, human prompts,
// files edited, commit subjects, subagent roster); -condense tops records
// with an LLM-written name/description/summary via `claude -p`.
//
// Records land in -out as <slug>/<session-id>.json and are updated
// incrementally: a digest is rebuilt when its transcript is newer than the
// record, and a summary is generated when it is missing or was written by an
// older output schema (or with -force). Subagent descriptions are harvested
// verbatim — the parent model authored them at spawn time — and are never
// re-summarized.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/tjmisko/switchboard-dashboard/internal/sessiondigest"
)

func main() {
	home, err := os.UserHomeDir()
	if err != nil {
		log.Fatalf("resolve home dir: %v", err)
	}
	projects := flag.String("projects", filepath.Join(home, ".claude", "projects"), "Claude Code projects dir to scan")
	out := flag.String("out", filepath.Join(home, ".local", "share", "switchboard", "summaries"), "output dir for per-session records")
	project := flag.String("project", "", "only process sessions under this project slug")
	session := flag.String("session", "", "only process this session id (also bypasses -min-idle)")
	condense := flag.Bool("condense", false, "generate name/description/tasks/summary via `claude -p` for records lacking one or written by an older schema")
	model := flag.String("model", "haiku", "model passed to `claude -p`")
	minIdle := flag.Duration("min-idle", 10*time.Minute, "skip transcripts modified more recently than this (likely still live)")
	force := flag.Bool("force", false, "rebuild digests and regenerate summaries even when up to date")
	printOnly := flag.Bool("print", false, "print records to stdout instead of writing files")
	flag.Parse()

	refs, err := sessiondigest.FindSessions(*projects)
	if err != nil {
		log.Fatalf("find sessions: %v", err)
	}

	// The summarizer's own `claude -p` runs (rooted at -out) leave transcripts
	// under this slug; digesting them would summarize the summarizer.
	selfSlug := sessiondigest.SlugFor(*out)

	var run sessiondigest.Runner
	if *condense {
		run = sessiondigest.ClaudeRunner(*model, *out, 5*time.Minute)
		if err := os.MkdirAll(*out, 0o755); err != nil {
			log.Fatalf("create out dir: %v", err)
		}
	}

	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")

	var digested, condensed, skippedLive, skippedThin int
	for _, ref := range refs {
		if ref.ProjectSlug == selfSlug {
			continue
		}
		if *project != "" && ref.ProjectSlug != *project {
			continue
		}
		if *session != "" && ref.SessionID != *session {
			continue
		}
		if *session == "" && time.Since(ref.ModTime) < *minIdle {
			skippedLive++
			continue
		}

		recordPath := filepath.Join(*out, ref.ProjectSlug, ref.SessionID+".json")
		record, haveRecord := readRecord(recordPath)
		stale := !haveRecord || *force
		if !stale {
			if info, err := os.Stat(recordPath); err == nil && ref.ModTime.After(info.ModTime()) {
				stale = true
			}
		}

		changed := false
		if stale {
			digest, err := sessiondigest.BuildFromTranscript(ref.TranscriptPath, ref.SubagentsDir)
			if err != nil {
				log.Printf("digest %s/%s: %v", ref.ProjectSlug, ref.SessionID, err)
				continue
			}
			digest.ProjectSlug = ref.ProjectSlug
			record.Digest = digest
			digested++
			changed = true
		}

		if *condense && sessiondigest.NeedsCondense(record, *force) {
			if record.Digest.Thin() {
				skippedThin++
			} else if err := sessiondigest.CondenseRecord(&record, run, *model, time.Now()); err != nil {
				log.Printf("condense %s/%s: %v", ref.ProjectSlug, ref.SessionID, err)
			} else {
				condensed++
				changed = true
			}
		}

		if *printOnly {
			if err := encoder.Encode(record); err != nil {
				log.Fatalf("encode record: %v", err)
			}
			continue
		}
		if changed {
			if err := writeRecord(recordPath, record); err != nil {
				log.Printf("write %s: %v", recordPath, err)
			}
		}
	}

	fmt.Fprintf(os.Stderr, "session-digest: %d digested, %d condensed, %d skipped as recently active, %d skipped as thin\n",
		digested, condensed, skippedLive, skippedThin)
}

func readRecord(path string) (sessiondigest.Record, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return sessiondigest.Record{}, false
	}
	var record sessiondigest.Record
	if err := json.Unmarshal(raw, &record); err != nil {
		return sessiondigest.Record{}, false
	}
	return record, true
}

// writeRecord writes atomically (tmp + rename) so a crashed run never leaves a
// truncated record behind.
func writeRecord(path string, record sessiondigest.Record) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(raw, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
