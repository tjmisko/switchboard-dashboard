package sessiondigest

import (
	"os"
	"path/filepath"
	"strings"
	"time"
)

// SessionRef locates one session transcript on disk.
type SessionRef struct {
	ProjectSlug    string
	SessionID      string
	TranscriptPath string
	SubagentsDir   string // may not exist; BuildFromTranscript tolerates that
	ModTime        time.Time
}

// FindSessions walks projectsDir (normally ~/.claude/projects) and returns
// one ref per <slug>/<session-id>.jsonl transcript, in ReadDir order (sorted
// by slug, then session id).
func FindSessions(projectsDir string) ([]SessionRef, error) {
	slugs, err := os.ReadDir(projectsDir)
	if err != nil {
		return nil, err
	}
	var refs []SessionRef
	for _, slug := range slugs {
		if !slug.IsDir() {
			continue
		}
		slugDir := filepath.Join(projectsDir, slug.Name())
		files, err := os.ReadDir(slugDir)
		if err != nil {
			continue
		}
		for _, f := range files {
			if f.IsDir() || !strings.HasSuffix(f.Name(), ".jsonl") {
				continue
			}
			info, err := f.Info()
			if err != nil {
				continue
			}
			id := strings.TrimSuffix(f.Name(), ".jsonl")
			refs = append(refs, SessionRef{
				ProjectSlug:    slug.Name(),
				SessionID:      id,
				TranscriptPath: filepath.Join(slugDir, f.Name()),
				SubagentsDir:   filepath.Join(slugDir, id, "subagents"),
				ModTime:        info.ModTime(),
			})
		}
	}
	return refs, nil
}

// SlugFor maps an absolute directory to Claude Code's project-slug encoding
// ('/' and '.' each become '-'), e.g. /home/x/.claude → -home-x--claude.
// Callers use it to recognize — and skip — the slug their own `claude -p`
// summarizer runs write transcripts under.
func SlugFor(dir string) string {
	return strings.NewReplacer("/", "-", ".", "-").Replace(dir)
}
