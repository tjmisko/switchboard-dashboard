package arachne

import (
	"os"
	"path/filepath"
)

// Default file names within the recorder's output directory.
const (
	HistoryFileName = "history.jsonl"
	StateFileName   = "state.json"
)

// DefaultDir is the recorder's output directory (~/.arachne-switchboard),
// falling back to the current directory when the home dir is unknown.
func DefaultDir() string {
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return filepath.Join(home, ".arachne-switchboard")
	}
	return ".arachne-switchboard"
}

// DefaultHistoryPath is the default append-only history log path.
func DefaultHistoryPath() string { return filepath.Join(DefaultDir(), HistoryFileName) }

// DefaultStatePath is the default reconciliation snapshot path.
func DefaultStatePath() string { return filepath.Join(DefaultDir(), StateFileName) }
