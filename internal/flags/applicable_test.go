package flags

import (
	"strings"
	"testing"
	"time"
)

func clipVerdict(at string) Verdict {
	return Verdict{
		Verdict: "ghost-lane", Confidence: "high", RootCause: "x",
		Action: Action{Type: ActionClipAt, ClipAt: at},
	}
}

func laneRecord() Record {
	return Record{
		PID:       1236334,
		LaneStart: "2026-07-22T14:06:01.201943595-07:00",
		LaneEnd:   "2026-07-23T00:00:00-07:00",
		Status:    StatusInvestigating,
	}
}

func TestResolveShouldNotClaimAppliedWhenClipSitsAtTheLaneStart(t *testing.T) {
	// Observed for real on the 2026-07-22 arachne phantom: a confident verdict
	// returned clip-at at the lane start. clipLane correctly refuses it, so
	// marking the record "applied" would have it claim a repair the operator can
	// plainly see did not happen.
	record := laneRecord()
	record.Resolve(clipVerdict(record.LaneStart), &AgentRun{}, time.Now())

	if record.Status != StatusPendingReview {
		t.Errorf("status = %q, want pending_review", record.Status)
	}
	if record.Active() {
		t.Error("an unapplicable verdict must not produce an active overlay")
	}
	if !strings.Contains(record.Blocked, "suppress-lane") {
		t.Errorf("blocked reason does not point at the right repair: %q", record.Blocked)
	}
	if record.Verdict != "ghost-lane" || record.RootCause != "x" {
		t.Error("the diagnosis itself should survive; only its application was refused")
	}
}

func TestResolveShouldNotClaimAppliedWhenClipSitsAtOrPastTheLaneEnd(t *testing.T) {
	for _, at := range []string{"2026-07-23T00:00:00-07:00", "2026-07-24T09:00:00-07:00"} {
		record := laneRecord()
		record.Resolve(clipVerdict(at), &AgentRun{}, time.Now())
		if record.Status != StatusPendingReview {
			t.Errorf("clip at %s: status = %q, want pending_review", at, record.Status)
		}
		if !strings.Contains(record.Blocked, "change nothing") {
			t.Errorf("clip at %s: blocked = %q", at, record.Blocked)
		}
	}
}

func TestResolveShouldApplyWhenClipFallsStrictlyInsideTheLane(t *testing.T) {
	record := laneRecord()
	record.Resolve(clipVerdict("2026-07-22T16:00:00-07:00"), &AgentRun{}, time.Now())
	if record.Status != StatusApplied {
		t.Errorf("status = %q, want applied", record.Status)
	}
	if record.Blocked != "" {
		t.Errorf("blocked = %q, want empty on an applicable verdict", record.Blocked)
	}
	if !record.Active() {
		t.Error("an applicable, confident verdict should yield an active overlay")
	}
}

func TestResolveShouldRefuseWhenMergeTargetsTheFlaggedLaneItself(t *testing.T) {
	record := laneRecord()
	record.Resolve(Verdict{
		Verdict: "split-lane", Confidence: "high", RootCause: "x",
		Action: Action{Type: ActionMergeInto, MergeIntoLaneStart: record.LaneStart},
	}, &AgentRun{}, time.Now())

	if record.Status != StatusPendingReview {
		t.Errorf("status = %q, want pending_review", record.Status)
	}
	if !strings.Contains(record.Blocked, "itself") {
		t.Errorf("blocked = %q", record.Blocked)
	}
}

func TestResolveShouldClearBlockedWhenARetrySucceeds(t *testing.T) {
	// Re-investigating a blocked flag has to be able to unblock it, or the stale
	// reason outlives the problem it described.
	record := laneRecord()
	record.Resolve(clipVerdict(record.LaneStart), &AgentRun{}, time.Now())
	if record.Blocked == "" {
		t.Fatal("precondition: the first verdict should have been blocked")
	}
	record.Resolve(Verdict{
		Verdict: "ghost-lane", Confidence: "high", RootCause: "x",
		Action: Action{Type: ActionSuppress},
	}, &AgentRun{}, time.Now())

	if record.Status != StatusApplied || record.Blocked != "" {
		t.Errorf("retry left status=%q blocked=%q", record.Status, record.Blocked)
	}
}
