package flagagent

import (
	"strings"
	"testing"

	"github.com/tjmisko/switchboard-dashboard/internal/flags"
)

func TestBuildPromptShouldNameTheDayFileWhenLaneHasAStart(t *testing.T) {
	// Without this the agent finds its own evidence, and on a lane with no
	// session id that means grepping by pid across the whole directory — tens of
	// megabytes. One real investigation spent five minutes doing exactly that and
	// was killed before reaching a verdict.
	prompt := BuildPrompt(ghostRecord())
	if !strings.Contains(prompt, "history/2026-08-05.jsonl") {
		t.Errorf("prompt does not name the day-file:\n%s", prompt)
	}
	if !strings.Contains(prompt, "not the whole directory") {
		t.Error("prompt does not tell the agent to stay out of the rest of the directory")
	}
}

func TestBuildPromptShouldNameBothDayFilesWhenLaneRanAcrossMidnight(t *testing.T) {
	record := flags.Record{
		LaneStart: "2026-07-22T14:06:01.201943595-07:00",
		LaneEnd:   "2026-07-23T00:00:00-07:00",
	}
	prompt := BuildPrompt(record)
	for _, day := range []string{"2026-07-22.jsonl", "2026-07-23.jsonl"} {
		if !strings.Contains(prompt, day) {
			t.Errorf("prompt is missing %s:\n%s", day, prompt)
		}
	}
}

func TestBuildPromptShouldNotRepeatTheDayFileWhenLaneStartsAndEndsSameDay(t *testing.T) {
	record := flags.Record{
		LaneStart: "2026-08-05T10:00:00-07:00",
		LaneEnd:   "2026-08-05T11:00:00-07:00",
	}
	if n := strings.Count(BuildPrompt(record), "2026-08-05.jsonl"); n != 1 {
		t.Errorf("day-file named %d times, want 1", n)
	}
}

func TestBuildPromptShouldGivePidToSearchOnWhenLaneHasNoSessionID(t *testing.T) {
	// The 2026-07-22 arachne phantom: it died before its first hook, so it never
	// got a session id and the pid is the only handle that exists.
	record := flags.Record{
		PID:       1236334,
		Project:   "arachne",
		LaneStart: "2026-07-22T14:06:01.201943595-07:00",
		LaneEnd:   "2026-07-23T00:00:00-07:00",
	}
	prompt := BuildPrompt(record)
	if !strings.Contains(prompt, `"pid":1236334`) {
		t.Errorf("prompt does not give the pid to group by:\n%s", prompt)
	}
	if !strings.Contains(prompt, "NO session_id") {
		t.Error("prompt does not say the session id is missing")
	}
	if !strings.Contains(prompt, "reused") {
		t.Error("prompt does not warn that a pid is reused where a session id is not")
	}
}

func TestBuildPromptShouldNotClaimAMissingSessionIDWhenOneIsPresent(t *testing.T) {
	if strings.Contains(BuildPrompt(ghostRecord()), "NO session_id") {
		t.Error("prompt claims a session id is missing when the record carries one")
	}
}
