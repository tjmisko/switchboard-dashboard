package flags

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// ErrDisabled is returned by every mutating Store method when the dashboard was
// started without a flag directory. Reads degrade to empty instead, so the
// frontend can ask unconditionally and simply find nothing.
var ErrDisabled = errors.New("flags: store is disabled")

// issuesFile is the append-only investigation log. It sits inside the store
// directory but is deliberately not a record file: List globs *.json, this is
// .jsonl, and nothing ever rewrites it.
const issuesFile = "issues.jsonl"

// Store persists flag records under a directory the dashboard owns.
//
// Records are rewritten in place as an investigation progresses — that is what
// the browser polls — while issues.jsonl only ever grows. The split is the point:
// the record answers "what is the state of this flag right now", the log answers
// "what have we learned about this data over time", and the second question is
// the one that outlives any individual lane.
type Store struct {
	dir string
	mu  sync.Mutex
}

// NewStore returns a store rooted at dir. An empty dir yields a disabled store:
// reads are empty and writes are ErrDisabled, which is how --flags-dir="" turns
// the whole feature off without any caller branching on it.
func NewStore(dir string) *Store { return &Store{dir: dir} }

// Enabled reports whether this store can hold anything.
func (s *Store) Enabled() bool { return s != nil && s.dir != "" }

// Dir is the store's root, or "" when disabled.
func (s *Store) Dir() string {
	if s == nil {
		return ""
	}
	return s.dir
}

func (s *Store) path(key string) string { return filepath.Join(s.dir, key+".json") }

// List returns every record, by key. A disabled store, a missing directory, and
// an empty one are all the same answer — an empty map — because none of them is
// a condition the UI should render differently.
//
// An unreadable or malformed record is skipped rather than failing the batch:
// one corrupt file must not blank the flag layer for every other lane.
func (s *Store) List() (map[string]Record, error) {
	out := map[string]Record{}
	if !s.Enabled() {
		return out, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	entries, err := os.ReadDir(s.dir)
	if err != nil {
		if os.IsNotExist(err) {
			return out, nil
		}
		return out, err
	}
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		key := entry.Name()[:len(entry.Name())-len(".json")]
		record, err := s.readLocked(key)
		if err != nil {
			continue
		}
		out[key] = record
	}
	return out, nil
}

// Get returns one record. The bool distinguishes "no such flag" from "a flag
// that failed to load", which the caller reports differently.
func (s *Store) Get(key string) (Record, bool, error) {
	if !s.Enabled() {
		return Record{}, false, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	record, err := s.readLocked(key)
	if err != nil {
		if os.IsNotExist(err) {
			return Record{}, false, nil
		}
		return Record{}, false, err
	}
	return record, true, nil
}

func (s *Store) readLocked(key string) (Record, error) {
	raw, err := os.ReadFile(s.path(key))
	if err != nil {
		return Record{}, err
	}
	var record Record
	if err := json.Unmarshal(raw, &record); err != nil {
		return Record{}, err
	}
	return record, nil
}

// Save writes a record atomically (tmp + rename), so a crash mid-write leaves
// the previous version intact rather than a truncated file the next read would
// skip. Mirrors cmd/session-digest's writeRecord.
func (s *Store) Save(record Record) error {
	if !s.Enabled() {
		return ErrDisabled
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.saveLocked(record)
}

func (s *Store) saveLocked(record Record) error {
	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return err
	}
	path := s.path(record.Key())
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(raw, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// Update applies mutate to the stored record under the store lock and saves the
// result. It exists so the HTTP handler and a running investigation can both
// touch the same flag without a read-modify-write race losing one of them —
// which matters because the investigation is the slow writer and the operator
// clicking revert is the fast one.
//
// mutate returning false abandons the update, leaving the record untouched.
func (s *Store) Update(key string, mutate func(*Record) bool) (Record, error) {
	if !s.Enabled() {
		return Record{}, ErrDisabled
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	record, err := s.readLocked(key)
	if err != nil {
		return Record{}, err
	}
	if !mutate(&record) {
		return record, nil
	}
	if err := s.saveLocked(record); err != nil {
		return Record{}, err
	}
	return record, nil
}

// IssueEntry is one line of the append-only investigation log: what was flagged,
// what it turned out to be, and what was done about it.
//
// It duplicates fields the record already holds on purpose. A record is mutable
// and can be reverted or re-investigated; the log is the immutable trail, and a
// line that referred out to a record would lose its meaning the moment that
// record changed.
type IssueEntry struct {
	TS        string    `json:"ts"`
	Event     string    `json:"event"` // flagged | resolved | reverted
	Key       string    `json:"key"`
	SessionID string    `json:"session_id,omitempty"`
	LaneStart string    `json:"lane_start,omitempty"`
	Project   string    `json:"project,omitempty"`
	Note      string    `json:"note,omitempty"`
	Verdict   string    `json:"verdict,omitempty"`
	Confidence string   `json:"confidence,omitempty"`
	RootCause string    `json:"root_cause,omitempty"`
	Evidence  []string  `json:"evidence,omitempty"`
	Action    Action    `json:"action,omitzero"`
	Upstream  *Upstream `json:"upstream,omitempty"`
	Agent     *AgentRun `json:"agent,omitempty"`
}

// AppendIssue adds one line to issues.jsonl. Append-only: the file is opened
// O_APPEND and never truncated or rewritten, so the log survives every later
// revert and re-investigation of the lane it describes.
func (s *Store) AppendIssue(entry IssueEntry) error {
	if !s.Enabled() {
		return ErrDisabled
	}
	if entry.TS == "" {
		entry.TS = time.Now().UTC().Format(time.RFC3339)
	}
	raw, err := json.Marshal(entry)
	if err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(s.dir, issuesFile), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := f.Write(append(raw, '\n')); err != nil {
		return err
	}
	return f.Sync()
}
