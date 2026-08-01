package sessiondigest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

// Summary is the LLM-generated session identity — the analog of the authored
// name/description a subagent gets from its parent at spawn time, which
// interactive sessions otherwise lack — plus the discrete work items and a
// short narrative.
type Summary struct {
	Name        string   `json:"name"`            // kebab-case slug for the work
	Description string   `json:"description"`     // one sentence, hover-modal sized
	Summary     string   `json:"summary"`         // framing prose: 1-2 sentences with tasks, 3-6 without
	Tasks       []string `json:"tasks,omitempty"` // distinct tasks, chronological, at most maxSummaryTasks
}

// Record is the persisted per-session artifact: the deterministic digest plus
// the generated summary, the output-schema version that generated it, and its
// provenance.
type Record struct {
	Digest         Digest   `json:"digest"`
	Summary        *Summary `json:"summary,omitempty"`
	SummaryVersion int      `json:"summaryVersion,omitempty"`
	Model          string   `json:"model,omitempty"`
	GeneratedAt    string   `json:"generatedAt,omitempty"`
}

// CurrentSummaryVersion is the condenser's output-schema version. v2 added
// Summary.Tasks; records still at an older version are re-condensed by a plain
// `-condense` run (see NeedsCondense) so the archive converges on the current
// shape without -force, which would needlessly rebuild every digest too.
const CurrentSummaryVersion = 2

// maxSummaryTasks caps the task list. The prompt already asks for the six most
// substantial tasks when a session had more, so truncating here is only a
// backstop against a model that ignores the cap.
const maxSummaryTasks = 6

// Runner produces the model's raw response for a prompt. The default is
// ClaudeRunner; tests substitute a fake.
type Runner func(prompt string) (string, error)

// Caps on how much of each digest list the condenser prompt includes; the
// overflow is noted so the model knows the list was truncated.
const (
	maxPromptLinesInPrompt = 30
	maxListLinesInPrompt   = 40
)

// BuildPrompt renders a digest into the condenser prompt. The model sees only
// this digest — never the raw transcript — which keeps the call cheap and the
// output grounded in extracted facts.
func BuildPrompt(d Digest) string {
	var sb strings.Builder
	sb.WriteString(`Write an archival index card for a finished Claude Code session, from its digest below.
Return ONLY a JSON object, no prose and no code fences:
{"name": "...", "description": "...", "tasks": ["...", "..."], "summary": "..."}
- "name": kebab-case slug naming the work, at most six words
- "description": one sentence, under 120 characters, saying what the session did
- "tasks": one entry per DISTINCT task the session completed, in chronological order.
  Return [] when the session was a single continuous task — never a one-entry list.
  At most 6 entries. If the session had more distinct tasks than that, keep the SIX
  MOST SUBSTANTIAL ones, not the first six.
  Each entry is a short past-tense clause under 120 characters, not a sentence:
  "Fixed the merged-view session-id lookup". No leading bullet or number.
- "summary": when "tasks" is non-empty, 1-2 plain sentences of framing only — what the
  session was about and where it landed — since the tasks already list the work.
  When "tasks" is empty, 3-6 plain sentences on what happened and where it landed.

Session digest:
`)
	field := func(key, value string) {
		if value != "" {
			fmt.Fprintf(&sb, "%s: %s\n", key, value)
		}
	}
	field("title", d.Title)
	field("agent-name", d.AgentName)
	field("project", d.ProjectDir)
	field("branch", d.GitBranch)
	field("started", d.StartedAt)
	field("ended", d.EndedAt)

	list := func(key string, values []string, limit int) {
		if len(values) == 0 {
			return
		}
		fmt.Fprintf(&sb, "%s:\n", key)
		shown := len(values)
		if shown > limit {
			shown = limit
		}
		for _, v := range values[:shown] {
			fmt.Fprintf(&sb, "  - %s\n", strings.ReplaceAll(v, "\n", " "))
		}
		if len(values) > shown {
			fmt.Fprintf(&sb, "  … and %d more\n", len(values)-shown)
		}
	}
	list("user prompts (in order)", d.UserPrompts, maxPromptLinesInPrompt)
	list("commits", d.CommitSubjects, maxListLinesInPrompt)
	list("files edited", d.FilesEdited, maxListLinesInPrompt)
	list("bash steps", d.BashDescriptions, maxListLinesInPrompt)

	if len(d.Subagents) > 0 {
		sb.WriteString("subagents delegated (descriptions authored at spawn):\n")
		for _, sa := range d.Subagents {
			label := sa.Name
			if label == "" {
				label = sa.AgentType
			}
			if label == "" {
				label = "agent"
			}
			fmt.Fprintf(&sb, "  - %s: %s\n", label, sa.Description)
		}
	}
	if d.FinalAssistantText != "" {
		sb.WriteString("final assistant message:\n")
		for _, line := range strings.Split(strings.TrimSpace(d.FinalAssistantText), "\n") {
			sb.WriteString("  " + line + "\n")
		}
	}
	return sb.String()
}

// ParseSummary extracts the condenser's JSON object from a model response,
// tolerating code fences and surrounding prose. Only description is required:
// a schema-confused reply that drops or mangles tasks still yields a usable
// card rather than an error.
func ParseSummary(out string) (Summary, error) {
	start := strings.Index(out, "{")
	end := strings.LastIndex(out, "}")
	if start < 0 || end <= start {
		return Summary{}, errors.New("no JSON object in model output")
	}
	// tasks is decoded raw because models return it as an array, as one
	// newline-delimited string, or as null — see parseTasks.
	var wire struct {
		Name        string          `json:"name"`
		Description string          `json:"description"`
		Summary     string          `json:"summary"`
		Tasks       json.RawMessage `json:"tasks"`
	}
	if err := json.Unmarshal([]byte(out[start:end+1]), &wire); err != nil {
		return Summary{}, fmt.Errorf("parse summary JSON: %w", err)
	}
	if wire.Description == "" {
		return Summary{}, errors.New("summary JSON missing description")
	}
	return Summary{
		Name:        wire.Name,
		Description: wire.Description,
		Summary:     wire.Summary,
		Tasks:       parseTasks(wire.Tasks),
	}, nil
}

// taskMarker matches a list marker the model sometimes leaves on an entry
// ("- ", "* ", "1. "). Every marker must be followed by whitespace: that is
// what keeps a task opening with a flag ("-force also rebuilds digests") or a
// decimal ("3.5x faster parse") from losing its leading characters.
var taskMarker = regexp.MustCompile(`^(?:[-*•]|\d+[.)])\s+`)

// parseTasks normalizes the model's tasks field: absent, null, a JSON array of
// strings, or a single string holding newline-delimited bullets. Entries are
// stripped of list markers, trimmed, dropped when empty, and capped at
// maxSummaryTasks. An unparseable field yields no tasks rather than an error —
// tasks are optional enrichment, never a reason to lose the whole summary.
func parseTasks(raw json.RawMessage) []string {
	if len(raw) == 0 {
		return nil
	}
	var entries []string
	if err := json.Unmarshal(raw, &entries); err != nil {
		var single string
		if json.Unmarshal(raw, &single) != nil {
			return nil
		}
		entries = strings.Split(single, "\n")
	}
	var tasks []string
	for _, entry := range entries {
		task := strings.TrimSpace(taskMarker.ReplaceAllString(strings.TrimSpace(entry), ""))
		if task == "" {
			continue
		}
		tasks = append(tasks, task)
		if len(tasks) == maxSummaryTasks {
			break
		}
	}
	return tasks
}

// NeedsCondense reports whether a record's summary has to be generated: it is
// missing, it was written by an older output schema (so it lacks fields the
// current one carries, such as Tasks), or the caller passed -force.
func NeedsCondense(record Record, force bool) bool {
	if force {
		return true
	}
	if record.Summary == nil {
		return true
	}
	return record.SummaryVersion < CurrentSummaryVersion
}

// Condense generates a Summary for the digest via run.
func Condense(d Digest, run Runner) (Summary, error) {
	out, err := run(BuildPrompt(d))
	if err != nil {
		return Summary{}, err
	}
	return ParseSummary(out)
}

// ClaudeRunner shells out to `claude -p` in headless mode. dir becomes the
// subprocess working directory so the summarizer's own transcripts land under
// dir's project slug — which callers skip via SlugFor — instead of polluting
// real projects.
func ClaudeRunner(model, dir string, timeout time.Duration) Runner {
	return func(prompt string) (string, error) {
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		cmd := exec.CommandContext(ctx, "claude", "-p", "--model", model)
		cmd.Dir = dir
		cmd.Stdin = strings.NewReader(prompt)
		out, err := cmd.Output()
		if err != nil {
			var exitErr *exec.ExitError
			if errors.As(err, &exitErr) && len(exitErr.Stderr) > 0 {
				return "", fmt.Errorf("claude -p: %w: %s", err, exitErr.Stderr)
			}
			return "", fmt.Errorf("claude -p: %w", err)
		}
		return string(out), nil
	}
}
