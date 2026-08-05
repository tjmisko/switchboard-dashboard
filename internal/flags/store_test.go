package flags

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testRecord() Record {
	return Record{
		SessionID: "claude:296eb0f0-44c5-4406-84a9-04abae0db150",
		LaneStart: "2026-08-05T10:29:37.438991459-07:00",
		LaneEnd:   "2026-08-05T13:41:34.680948947-07:00",
		Project:   "screening-overhaul",
		FlaggedAt: "2026-08-05T13:45:00Z",
		Note:      "3h idle bar, session was seconds",
		Status:    StatusPending,
		Action:    Action{Type: ActionNone},
	}
}

func TestKeyShouldCollapseEquivalentTimestampSpellingsWhenOffsetsDiffer(t *testing.T) {
	// The same instant, written three ways a producer might legitimately emit.
	// A flag filed against one spelling must find the lane under any other, or
	// re-flagging the same lane silently creates a second record.
	same := []string{
		"2026-08-05T10:29:37.438991459-07:00",
		"2026-08-05T17:29:37.438991459Z",
		"2026-08-05T18:29:37.438991459+01:00",
	}
	want := Key("s", same[0])
	for _, ts := range same[1:] {
		if got := Key("s", ts); got != want {
			t.Errorf("Key(%q) = %q, want %q", ts, got, want)
		}
	}
}

func TestKeyShouldSeparateLanesWhenOneSessionProducesSeveral(t *testing.T) {
	// The defect this package exists for: one session id, two lanes. Flagging
	// the ghost must not touch its real sibling.
	id := "296eb0f0-44c5-4406-84a9-04abae0db150"
	real := Key(id, "2026-08-05T10:29:18.669751036-07:00")
	ghost := Key(id, "2026-08-05T10:29:37.438991459-07:00")
	if real == ghost {
		t.Fatalf("two lanes of one session share key %q", real)
	}
}

func TestKeyShouldStripPathSeparatorsWhenProviderNamespacesTheSessionID(t *testing.T) {
	// A merged multi-provider id is "claude:<uuid>", and the key becomes a
	// filename — so anything that could escape the store directory or confuse a
	// path join has to be gone.
	for _, id := range []string{"claude:296eb0f0", "../../etc/passwd", "a/b\\c"} {
		key := Key(id, "2026-08-05T10:29:37Z")
		if filepath.Base(key) != key {
			t.Errorf("Key(%q) = %q, which is not a bare filename stem", id, key)
		}
		if strings.ContainsAny(key, `:/\`) {
			t.Errorf("Key(%q) = %q, which still holds a path character", id, key)
		}
	}
}

func TestStoreShouldRoundTripRecordWhenSaved(t *testing.T) {
	store := NewStore(t.TempDir())
	want := testRecord()
	if err := store.Save(want); err != nil {
		t.Fatalf("Save: %v", err)
	}
	got, ok, err := store.Get(want.Key())
	if err != nil || !ok {
		t.Fatalf("Get: ok=%v err=%v", ok, err)
	}
	if got.SessionID != want.SessionID || got.LaneStart != want.LaneStart || got.Note != want.Note {
		t.Errorf("round trip lost data: %+v", got)
	}
}

func TestStoreShouldReportEmptyWhenDisabled(t *testing.T) {
	store := NewStore("")
	if store.Enabled() {
		t.Fatal("empty dir should disable the store")
	}
	list, err := store.List()
	if err != nil || len(list) != 0 {
		t.Errorf("List on disabled store = %v, %v; want empty, nil", list, err)
	}
	if _, ok, err := store.Get("anything"); ok || err != nil {
		t.Errorf("Get on disabled store = ok %v err %v; want false, nil", ok, err)
	}
	if err := store.Save(testRecord()); err != ErrDisabled {
		t.Errorf("Save on disabled store = %v, want ErrDisabled", err)
	}
	if err := store.AppendIssue(IssueEntry{Event: "flagged"}); err != ErrDisabled {
		t.Errorf("AppendIssue on disabled store = %v, want ErrDisabled", err)
	}
}

func TestStoreShouldReportEmptyWhenDirectoryIsMissing(t *testing.T) {
	// The store directory is created lazily on first write, so every read before
	// the first flag hits a path that does not exist. That is the normal state of
	// a fresh install, not an error to surface.
	store := NewStore(filepath.Join(t.TempDir(), "never-created"))
	list, err := store.List()
	if err != nil {
		t.Fatalf("List on missing dir: %v", err)
	}
	if len(list) != 0 {
		t.Errorf("List = %v, want empty", list)
	}
}

func TestListShouldSkipCorruptRecordWhenOthersAreValid(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(dir)
	good := testRecord()
	if err := store.Save(good); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "corrupt.json"), []byte("{not json"), 0o644); err != nil {
		t.Fatalf("write corrupt: %v", err)
	}

	list, err := store.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("List returned %d records, want 1 (the corrupt one skipped)", len(list))
	}
	if _, ok := list[good.Key()]; !ok {
		t.Errorf("good record missing from %v", list)
	}
}

func TestListShouldIgnoreIssueLogWhenItSitsInTheStore(t *testing.T) {
	store := NewStore(t.TempDir())
	if err := store.AppendIssue(IssueEntry{Event: "flagged", Key: "k"}); err != nil {
		t.Fatalf("AppendIssue: %v", err)
	}
	list, err := store.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 0 {
		t.Errorf("issues.jsonl was read as a record: %v", list)
	}
}

func TestUpdateShouldLeaveRecordUntouchedWhenMutateDeclines(t *testing.T) {
	store := NewStore(t.TempDir())
	record := testRecord()
	if err := store.Save(record); err != nil {
		t.Fatalf("Save: %v", err)
	}
	got, err := store.Update(record.Key(), func(r *Record) bool {
		r.Note = "should not persist"
		return false
	})
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if got.Note != "should not persist" {
		t.Errorf("Update returned %q, want the mutated in-memory copy", got.Note)
	}
	reread, _, err := store.Get(record.Key())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if reread.Note != record.Note {
		t.Errorf("declined update still wrote: note = %q, want %q", reread.Note, record.Note)
	}
}

func TestAppendIssueShouldOnlyGrowWhenCalledRepeatedly(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(dir)
	events := []string{"flagged", "resolved", "reverted"}
	for _, event := range events {
		if err := store.AppendIssue(IssueEntry{Event: event, Key: "k", Verdict: "ghost-lane"}); err != nil {
			t.Fatalf("AppendIssue(%s): %v", event, err)
		}
	}

	f, err := os.Open(filepath.Join(dir, issuesFile))
	if err != nil {
		t.Fatalf("open issues log: %v", err)
	}
	defer f.Close()

	var got []string
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		var entry IssueEntry
		if err := json.Unmarshal(scanner.Bytes(), &entry); err != nil {
			t.Fatalf("line is not JSON: %v", err)
		}
		if entry.TS == "" {
			t.Error("entry written without a timestamp")
		}
		got = append(got, entry.Event)
	}
	if len(got) != len(events) {
		t.Fatalf("log holds %v, want %v", got, events)
	}
	for i := range events {
		if got[i] != events[i] {
			t.Errorf("line %d = %q, want %q", i, got[i], events[i])
		}
	}
}

func TestActiveShouldGateOnStatusAndActionWhenOverlayIsConsidered(t *testing.T) {
	cases := []struct {
		name   string
		status Status
		action ActionType
		want   bool
	}{
		{"applied suppression is active", StatusApplied, ActionSuppress, true},
		{"applied merge is active", StatusApplied, ActionMergeInto, true},
		{"applied no-op changes nothing", StatusApplied, ActionNone, false},
		{"pending has no verdict yet", StatusPending, ActionSuppress, false},
		{"pending review is not auto-applied", StatusPendingReview, ActionSuppress, false},
		{"reverted is withdrawn", StatusReverted, ActionSuppress, false},
		{"failed produced nothing to apply", StatusFailed, ActionSuppress, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			record := testRecord()
			record.Status = tc.status
			record.Action = Action{Type: tc.action}
			if got := record.Active(); got != tc.want {
				t.Errorf("Active() = %v, want %v", got, tc.want)
			}
		})
	}
}
