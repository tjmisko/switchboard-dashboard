package sessiondigest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// Summary is the LLM-generated session identity — the analog of the authored
// name/description a subagent gets from its parent at spawn time, which
// interactive sessions otherwise lack — plus a short narrative.
type Summary struct {
	Name        string `json:"name"`        // kebab-case slug for the work
	Description string `json:"description"` // one sentence, hover-modal sized
	Summary     string `json:"summary"`     // 3-6 sentences on what happened
}

// Record is the persisted per-session artifact: the deterministic digest plus
// the generated summary and its provenance.
type Record struct {
	Digest      Digest   `json:"digest"`
	Summary     *Summary `json:"summary,omitempty"`
	Model       string   `json:"model,omitempty"`
	GeneratedAt string   `json:"generatedAt,omitempty"`
}

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
{"name": "...", "description": "...", "summary": "..."}
- "name": kebab-case slug naming the work, at most six words
- "description": one sentence, under 120 characters, saying what the session did
- "summary": 3-6 plain sentences on what happened and where it landed

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
// tolerating code fences and surrounding prose.
func ParseSummary(out string) (Summary, error) {
	start := strings.Index(out, "{")
	end := strings.LastIndex(out, "}")
	if start < 0 || end <= start {
		return Summary{}, errors.New("no JSON object in model output")
	}
	var s Summary
	if err := json.Unmarshal([]byte(out[start:end+1]), &s); err != nil {
		return Summary{}, fmt.Errorf("parse summary JSON: %w", err)
	}
	if s.Description == "" {
		return Summary{}, errors.New("summary JSON missing description")
	}
	return s, nil
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
