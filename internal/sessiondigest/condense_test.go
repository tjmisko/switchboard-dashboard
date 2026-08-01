package sessiondigest

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestBuildPromptShouldCapListsAndNoteOverflow(t *testing.T) {
	var prompts []string
	for i := 0; i < maxPromptLinesInPrompt+5; i++ {
		prompts = append(prompts, fmt.Sprintf("prompt %d", i))
	}
	p := BuildPrompt(Digest{Title: "Big session", UserPrompts: prompts})
	if !strings.Contains(p, "title: Big session") {
		t.Error("prompt missing title field")
	}
	if !strings.Contains(p, fmt.Sprintf("prompt %d", maxPromptLinesInPrompt-1)) {
		t.Error("prompt missing last included list entry")
	}
	if strings.Contains(p, fmt.Sprintf("prompt %d", maxPromptLinesInPrompt)) {
		t.Error("prompt includes entries past the cap")
	}
	if !strings.Contains(p, "… and 5 more") {
		t.Error("prompt missing overflow note")
	}
}

func TestBuildPromptShouldRenderSubagentDescriptionsVerbatim(t *testing.T) {
	p := BuildPrompt(Digest{Subagents: []Subagent{
		{Name: "model-agent", Description: "Add projectHoursMs to model"},
		{AgentType: "Explore", Description: "Audit module code in crates/web"},
	}})
	if !strings.Contains(p, "model-agent: Add projectHoursMs to model") {
		t.Error("prompt missing named subagent line")
	}
	if !strings.Contains(p, "Explore: Audit module code in crates/web") {
		t.Error("prompt missing agent-type fallback label")
	}
}

func TestBuildPromptShouldRequestTasksWhenRenderingAnyDigest(t *testing.T) {
	p := BuildPrompt(Digest{Title: "Multi-task day"})
	if !strings.Contains(p, `"tasks"`) {
		t.Error("prompt does not request a tasks field")
	}
	// the prompt's cap and the parser's backstop must not drift apart.
	if !strings.Contains(p, fmt.Sprintf("At most %d entries", maxSummaryTasks)) {
		t.Errorf("prompt does not state the %d-entry cap", maxSummaryTasks)
	}
	if !strings.Contains(p, "MOST SUBSTANTIAL") {
		t.Error("prompt does not state which tasks to keep past the cap")
	}
	if !strings.Contains(p, "chronological order") {
		t.Error("prompt does not ask for chronological order")
	}
	if !strings.Contains(p, "1-2 plain sentences") || !strings.Contains(p, "3-6 plain sentences") {
		t.Error("prompt does not state the shorter-prose-with-tasks rule")
	}
}

func TestParseSummaryShouldExtractJSONWhenModelWrapsItInFencesOrProse(t *testing.T) {
	out := "Sure! Here is the card:\n```json\n{\"name\":\"fix-flaky-test\",\"description\":\"Fixed the flaky auth test\",\"summary\":\"The session fixed a race.\"}\n```\n"
	s, err := ParseSummary(out)
	if err != nil {
		t.Fatal(err)
	}
	if s.Name != "fix-flaky-test" || s.Description != "Fixed the flaky auth test" {
		t.Errorf("Summary = %#v", s)
	}
}

func TestParseSummaryShouldErrorWhenDescriptionMissing(t *testing.T) {
	if _, err := ParseSummary(`{"name":"x","summary":"y"}`); err == nil {
		t.Error("want error for summary JSON without description")
	}
	if _, err := ParseSummary("no json here"); err == nil {
		t.Error("want error when output has no JSON object")
	}
}

func TestParseSummaryShouldKeepTasksInOrderWhenModelReturnsAnArray(t *testing.T) {
	s, err := ParseSummary(`{"name":"n","description":"d","summary":"s","tasks":["Fixed the lookup","Added the endpoint"]}`)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"Fixed the lookup", "Added the endpoint"}
	if !reflect.DeepEqual(s.Tasks, want) {
		t.Errorf("Tasks = %#v, want %#v", s.Tasks, want)
	}
}

func TestParseSummaryShouldYieldNoTasksWhenFieldIsAbsentOrNull(t *testing.T) {
	for _, out := range []string{
		`{"name":"n","description":"d","summary":"s"}`,
		`{"name":"n","description":"d","summary":"s","tasks":null}`,
		`{"name":"n","description":"d","summary":"s","tasks":[]}`,
		`{"name":"n","description":"d","summary":"s","tasks":42}`,
	} {
		s, err := ParseSummary(out)
		if err != nil {
			t.Fatalf("ParseSummary(%s): %v", out, err)
		}
		if len(s.Tasks) != 0 {
			t.Errorf("ParseSummary(%s).Tasks = %#v, want none", out, s.Tasks)
		}
	}
}

func TestParseSummaryShouldSplitAndStripMarkersWhenTasksIsOneBulletString(t *testing.T) {
	out := `{"name":"n","description":"d","summary":"s","tasks":"- Fixed the lookup\n* Added the endpoint\n1. Wrote the docs\n\n"}`
	s, err := ParseSummary(out)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"Fixed the lookup", "Added the endpoint", "Wrote the docs"}
	if !reflect.DeepEqual(s.Tasks, want) {
		t.Errorf("Tasks = %#v, want %#v", s.Tasks, want)
	}
}

func TestParseSummaryShouldKeepLeadingCharactersWhenATaskOpensLikeAMarker(t *testing.T) {
	// marker stripping only fires on a marker followed by whitespace, so a
	// decimal or a flag at the head of a task survives intact.
	want := []string{
		"3.5x faster parse on the hot path",
		"2.0 migration finished",
		"-force now rebuilds digests",
		"*args unpacking fixed",
	}
	var entries []string
	for _, task := range want {
		raw, err := json.Marshal(task)
		if err != nil {
			t.Fatal(err)
		}
		entries = append(entries, string(raw))
	}
	out := fmt.Sprintf(`{"name":"n","description":"d","summary":"s","tasks":[%s]}`, strings.Join(entries, ","))
	s, err := ParseSummary(out)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(s.Tasks, want) {
		t.Errorf("Tasks = %#v, want %#v", s.Tasks, want)
	}
}

func TestParseSummaryShouldCapTasksWhenModelReturnsMoreThanTheLimit(t *testing.T) {
	var entries []string
	for i := 0; i < maxSummaryTasks+3; i++ {
		entries = append(entries, fmt.Sprintf(`"task %d"`, i))
	}
	out := fmt.Sprintf(`{"name":"n","description":"d","summary":"s","tasks":[%s]}`, strings.Join(entries, ","))
	s, err := ParseSummary(out)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Tasks) != maxSummaryTasks {
		t.Fatalf("len(Tasks) = %d, want %d", len(s.Tasks), maxSummaryTasks)
	}
	if s.Tasks[maxSummaryTasks-1] != fmt.Sprintf("task %d", maxSummaryTasks-1) {
		t.Errorf("Tasks = %#v, want the first %d entries kept", s.Tasks, maxSummaryTasks)
	}
}

func TestParseSummaryShouldCapTasksWhenTheBulletStringHoldsMoreThanTheLimit(t *testing.T) {
	// the newline-string path splits before it caps, so it needs its own guard.
	var lines []string
	for i := 0; i < maxSummaryTasks+2; i++ {
		lines = append(lines, fmt.Sprintf("- task %d", i))
	}
	raw, err := json.Marshal(strings.Join(lines, "\n"))
	if err != nil {
		t.Fatal(err)
	}
	out := fmt.Sprintf(`{"name":"n","description":"d","summary":"s","tasks":%s}`, raw)
	s, err := ParseSummary(out)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Tasks) != maxSummaryTasks {
		t.Fatalf("len(Tasks) = %d, want %d", len(s.Tasks), maxSummaryTasks)
	}
	if s.Tasks[maxSummaryTasks-1] != fmt.Sprintf("task %d", maxSummaryTasks-1) {
		t.Errorf("Tasks = %#v, want the first %d lines kept", s.Tasks, maxSummaryTasks)
	}
}

func TestNeedsCondenseShouldRegenerateWhenSummaryIsMissingOrPredatesTheSchema(t *testing.T) {
	digestOnly := Record{}
	if !NeedsCondense(digestOnly, false) {
		t.Error("want condense for a record with no summary")
	}
	v1 := Record{Summary: &Summary{Description: "d"}, SummaryVersion: 0}
	if !NeedsCondense(v1, false) {
		t.Error("want re-condense for a record written by an older schema version")
	}
}

func TestNeedsCondenseShouldSkipACurrentRecordUnlessForced(t *testing.T) {
	current := Record{Summary: &Summary{Description: "d"}, SummaryVersion: CurrentSummaryVersion}
	if NeedsCondense(current, false) {
		t.Error("want no condense for a record already at the current schema version")
	}
	if !NeedsCondense(current, true) {
		t.Error("want condense for a current record when forced")
	}
}

func TestNeedsCondenseShouldLeaveARecordWrittenByANewerSchemaAlone(t *testing.T) {
	// a newer binary sharing the store writes records this one cannot produce;
	// re-condensing them would downgrade their summaries. Only an older version
	// is stale, which is why the check is `<` and not `!=`.
	future := Record{Summary: &Summary{Description: "d"}, SummaryVersion: CurrentSummaryVersion + 1}
	if NeedsCondense(future, false) {
		t.Error("want no condense for a record written by a newer schema version")
	}
}

func TestCondenseShouldFeedDigestPromptToRunnerAndParseItsReply(t *testing.T) {
	d := Digest{Title: "Wire projects view", UserPrompts: []string{"add a projects tab"}}
	var seen string
	run := func(prompt string) (string, error) {
		seen = prompt
		return `{"name":"projects-tab","description":"Added a stacked per-project hours tab","summary":"Built the tab."}`, nil
	}
	s, err := Condense(d, run)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(seen, "add a projects tab") {
		t.Error("runner prompt missing digest content")
	}
	if s.Name != "projects-tab" {
		t.Errorf("Summary = %#v", s)
	}
}
