package sessiondigest

import (
	"fmt"
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
