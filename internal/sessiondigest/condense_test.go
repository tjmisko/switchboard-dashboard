package sessiondigest

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"
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

func TestParseSummaryShouldKeepTheStringEntriesWhenTheTaskArrayIsMixed(t *testing.T) {
	// a model that slips one object (or number) into an otherwise fine list
	// costs that entry alone, not the whole session's bullets.
	s, err := ParseSummary(`{"name":"n","description":"d","summary":"s","tasks":["Fixed the lookup",42,{"task":"Added the endpoint"},"Wrote the docs"]}`)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"Fixed the lookup", "Wrote the docs"}
	if !reflect.DeepEqual(s.Tasks, want) {
		t.Errorf("Tasks = %#v, want %#v", s.Tasks, want)
	}

	// an array with no string entries at all still yields none.
	s, err = ParseSummary(`{"name":"n","description":"d","summary":"s","tasks":[{"task":"a"},{"task":"b"}]}`)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Tasks) != 0 {
		t.Errorf("Tasks = %#v, want none for an all-object array", s.Tasks)
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

func TestNeedsCondenseShouldFollowTheStampedDigestHash(t *testing.T) {
	ended := Digest{
		Title:       "Wire projects view",
		UserPrompts: []string{"add a projects tab"},
		FilesEdited: []string{"web/app.js"},
	}
	// the same session resumed and ended again: same record, fatter digest.
	resumed := Digest{
		Title:       "Wire projects view",
		UserPrompts: []string{"add a projects tab", "now add the totals row"},
		FilesEdited: []string{"web/app.js", "web/model.js"},
	}
	// a rebuild that read the same transcript: byte-identical content, fresh
	// slices, so the hash has to compare content and not identity.
	rebuilt := Digest{
		Title:       "Wire projects view",
		UserPrompts: []string{"add a projects tab"},
		FilesEdited: []string{"web/app.js"},
	}
	current := func(d Digest, hash string) Record {
		return Record{
			Digest:         d,
			Summary:        &Summary{Description: "Added a stacked hours tab"},
			SummaryVersion: CurrentSummaryVersion,
			DigestHash:     hash,
		}
	}

	for _, tc := range []struct {
		name   string
		record Record
		force  bool
		want   bool
	}{
		{
			name:   "rebuilt digest with new content re-condenses",
			record: current(resumed, HashDigest(ended)),
			want:   true,
		},
		{
			name:   "rebuilt digest with identical content does not",
			record: current(rebuilt, HashDigest(ended)),
			want:   false,
		},
		{
			name:   "record from before the hash existed does not",
			record: current(resumed, ""),
			want:   false,
		},
		{
			name: "older schema version re-condenses whatever the hash says",
			record: Record{
				Digest:         ended,
				Summary:        &Summary{Description: "d"},
				SummaryVersion: CurrentSummaryVersion - 1,
				DigestHash:     HashDigest(ended),
			},
			want: true,
		},
		{
			name:   "missing summary re-condenses",
			record: Record{Digest: ended, DigestHash: HashDigest(ended)},
			want:   true,
		},
		{
			name:   "force re-condenses a matching hash",
			record: current(rebuilt, HashDigest(ended)),
			force:  true,
			want:   true,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := NeedsCondense(tc.record, tc.force); got != tc.want {
				t.Errorf("NeedsCondense = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestHashDigestShouldMatchWhenTwoDigestsCarryEqualPromptContent(t *testing.T) {
	build := func() Digest {
		return Digest{
			Title:              "Wire projects view",
			AgentName:          "projects-agent",
			ProjectDir:         "/home/u/Projects/switchboard",
			GitBranch:          "feat/projects-tab",
			StartedAt:          "2026-07-31T20:00:00Z",
			EndedAt:            "2026-07-31T22:00:00Z",
			UserPrompts:        []string{"add a projects tab", "now the totals row"},
			CommitSubjects:     []string{"feat: add the projects tab"},
			FilesEdited:        []string{"web/app.js", "web/model.js"},
			BashDescriptions:   []string{"Run the go tests"},
			Subagents:          []Subagent{{Name: "model-agent", Description: "Add projectHoursMs"}},
			FinalAssistantText: "Done — the tab renders.",
		}
	}
	if HashDigest(build()) != HashDigest(build()) {
		t.Error("want one hash for two separately built but equal digests")
	}
	changed := build()
	changed.UserPrompts = append(changed.UserPrompts, "and a legend")
	if HashDigest(changed) == HashDigest(build()) {
		t.Error("want a different hash once a prompt-visible field changes")
	}
}

func TestHashDigestShouldIgnoreFieldsThePromptNeverShows(t *testing.T) {
	// re-condensing costs a real `claude -p` call, so a change the summary
	// could not possibly have reflected must not trigger one.
	base := Digest{
		Title:       "Wire projects view",
		UserPrompts: []string{"add a projects tab"},
		Subagents:   []Subagent{{Name: "model-agent", Description: "Add projectHoursMs"}},
	}
	invisible := base
	invisible.SessionID = "9f1c-2b7e"
	invisible.ProjectSlug = "-home-u-Projects-switchboard"
	invisible.ToolCounts = map[string]int{"Edit": 12, "Bash": 4}
	invisible.Subagents = []Subagent{{Name: "model-agent", Description: "Add projectHoursMs", Model: "opus"}}
	if HashDigest(invisible) != HashDigest(base) {
		t.Error("want the same hash when only fields outside the prompt differ")
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

func TestCondenseRecordShouldStampTheSchemaVersionWhenTheRunnerSucceeds(t *testing.T) {
	// the stamp is what stops the next plain -condense run from re-summarizing
	// the entire archive, one `claude -p` call per record.
	record := Record{Digest: Digest{Title: "Wire projects view"}}
	run := func(string) (string, error) {
		return `{"name":"projects-tab","description":"Added a stacked hours tab","summary":"Built the tab.","tasks":["Added the tab","Wired the totals"]}`, nil
	}
	now := time.Date(2026, 7, 31, 22, 0, 0, 0, time.UTC)
	if err := CondenseRecord(&record, run, "haiku", now); err != nil {
		t.Fatal(err)
	}
	if record.Summary == nil || record.Summary.Name != "projects-tab" {
		t.Fatalf("Summary = %#v", record.Summary)
	}
	if record.SummaryVersion != CurrentSummaryVersion {
		t.Errorf("SummaryVersion = %d, want %d", record.SummaryVersion, CurrentSummaryVersion)
	}
	if NeedsCondense(record, false) {
		t.Error("want the stamped record skipped by the next unforced run")
	}
	if record.Model != "haiku" {
		t.Errorf("Model = %q, want the model that generated it", record.Model)
	}
	if record.GeneratedAt != "2026-07-31T22:00:00Z" {
		t.Errorf("GeneratedAt = %q, want the run time in RFC3339 UTC", record.GeneratedAt)
	}
	if record.DigestHash != HashDigest(record.Digest) {
		t.Errorf("DigestHash = %q, want the hash of the digest it summarized", record.DigestHash)
	}
	// and that stamp is what catches the resume the version stamp cannot: same
	// record, digest rebuilt from a longer transcript.
	record.Digest.UserPrompts = append(record.Digest.UserPrompts, "now add the totals row")
	if !NeedsCondense(record, false) {
		t.Error("want a re-condense once the stamped digest is rebuilt with new content")
	}
}

func TestCondenseRecordShouldLeaveTheRecordStaleWhenTheRunnerFails(t *testing.T) {
	// a failed call must not stamp the version: the record has no summary, so
	// the next run has to try again rather than treat it as current.
	for _, run := range []Runner{
		func(string) (string, error) { return "", errors.New("claude -p: exit 1") },
		func(string) (string, error) { return "I could not summarize that.", nil },
	} {
		record := Record{Digest: Digest{Title: "Wire projects view"}}
		if err := CondenseRecord(&record, run, "haiku", time.Now()); err == nil {
			t.Fatal("want an error from a failed condense")
		}
		if record.Summary != nil || record.SummaryVersion != 0 || record.GeneratedAt != "" || record.DigestHash != "" {
			t.Errorf("record = %#v, want it untouched by a failed condense", record)
		}
		if !NeedsCondense(record, false) {
			t.Error("want the failed record still queued for the next run")
		}
	}
}
