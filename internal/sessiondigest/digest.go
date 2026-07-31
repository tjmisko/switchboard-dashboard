// Package sessiondigest condenses Claude Code session transcripts into
// compact per-session records. The digest half (this file) is deterministic
// extraction — titles, human prompts, authored tool descriptions, files
// edited, commit subjects, and the subagent roster. The condense half
// (condense.go) tops a digest with an LLM-written name/description/summary,
// the analog of the authored identity a subagent already gets at spawn time.
//
// Subagent names and descriptions are harvested verbatim: the parent model
// authored them when it spawned the agent, so they are never re-summarized.
package sessiondigest

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	maxPromptRunes    = 500
	maxFinalTextRunes = 2000
)

// Digest is the deterministic, no-LLM condensation of one session transcript:
// everything about "what happened" that can be extracted mechanically. It is
// useful on its own as an index and is the only thing the LLM condenser sees.
type Digest struct {
	SessionID          string         `json:"sessionId"`
	ProjectSlug        string         `json:"projectSlug,omitempty"`
	ProjectDir         string         `json:"projectDir,omitempty"`
	GitBranch          string         `json:"gitBranch,omitempty"`
	Title              string         `json:"title,omitempty"`     // last custom-title, else last ai-title
	AgentName          string         `json:"agentName,omitempty"` // last agent-name record
	StartedAt          string         `json:"startedAt,omitempty"`
	EndedAt            string         `json:"endedAt,omitempty"`
	UserPrompts        []string       `json:"userPrompts,omitempty"`
	FinalAssistantText string         `json:"finalAssistantText,omitempty"`
	FilesEdited        []string       `json:"filesEdited,omitempty"`
	BashDescriptions   []string       `json:"bashDescriptions,omitempty"`
	CommitSubjects     []string       `json:"commitSubjects,omitempty"`
	ToolCounts         map[string]int `json:"toolCounts,omitempty"`
	Subagents          []Subagent     `json:"subagents,omitempty"`
}

// Subagent is a delegated agent's identity, harvested verbatim. The JSON tags
// match the agent-*.meta.json files Claude Code writes, so those unmarshal
// directly.
type Subagent struct {
	Name        string `json:"name,omitempty"`
	AgentType   string `json:"agentType,omitempty"`
	Description string `json:"description,omitempty"`
	Model       string `json:"model,omitempty"`
}

// Thin reports whether the digest carries so little signal (no prompts, no
// edits, no commits, no delegations) that an LLM summary would be guesswork —
// e.g. the transcript left behind by a stray `claude -p` invocation.
func (d Digest) Thin() bool {
	return len(d.UserPrompts) == 0 && len(d.FilesEdited) == 0 &&
		len(d.CommitSubjects) == 0 && len(d.Subagents) == 0
}

// commitLine matches the confirmation git prints on commit, as echoed back in
// Bash tool_result payloads: "[branch abc1234] subject".
var commitLine = regexp.MustCompile(`(?m)^\[[^\]\n]* ([0-9a-f]{7,40})\] (.+)$`)

// BuildFromTranscript digests one transcript. subagentsDir is the session's
// subagents/ metadata directory — the authoritative roster; when it is empty
// or missing (older sessions predate it), Task/Agent tool_use records in the
// transcript serve as the fallback roster.
func BuildFromTranscript(transcriptPath, subagentsDir string) (Digest, error) {
	f, err := os.Open(transcriptPath)
	if err != nil {
		return Digest{}, err
	}
	defer f.Close()

	d := Digest{ToolCounts: map[string]int{}}
	var aiTitle, customTitle string
	var spawns []Subagent
	seenFile := map[string]bool{}
	seenBashDesc := map[string]bool{}
	seenCommit := map[string]bool{}

	sc := bufio.NewScanner(f)
	// Transcript lines can carry megabytes of pasted or base64 content.
	sc.Buffer(make([]byte, 0, 1<<20), 64<<20)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 || line[0] != '{' {
			continue
		}
		var e entry
		if json.Unmarshal(line, &e) != nil {
			continue
		}
		if d.SessionID == "" && e.SessionID != "" {
			d.SessionID = e.SessionID
		}
		if d.GitBranch == "" && e.GitBranch != "" {
			d.GitBranch = e.GitBranch
		}
		if d.ProjectDir == "" && e.Cwd != "" {
			d.ProjectDir = e.Cwd
		}
		if e.Timestamp != "" {
			if d.StartedAt == "" || e.Timestamp < d.StartedAt {
				d.StartedAt = e.Timestamp
			}
			if e.Timestamp > d.EndedAt {
				d.EndedAt = e.Timestamp
			}
		}

		switch e.Type {
		case "ai-title":
			if e.AITitle != "" {
				aiTitle = e.AITitle
			}
		case "custom-title":
			if e.CustomTitle != "" {
				customTitle = e.CustomTitle
			}
		case "agent-name":
			if e.AgentName != "" {
				d.AgentName = e.AgentName
			}
		case "user":
			if e.IsSidechain {
				continue
			}
			blocks := e.blocks()
			hasToolResult := false
			for _, b := range blocks {
				if b.Type != "tool_result" {
					continue
				}
				hasToolResult = true
				for _, m := range commitLine.FindAllStringSubmatch(b.resultText(), -1) {
					if subject := m[2]; !seenCommit[subject] {
						seenCommit[subject] = true
						d.CommitSubjects = append(d.CommitSubjects, subject)
					}
				}
			}
			if e.IsMeta || hasToolResult {
				continue
			}
			var parts []string
			for _, b := range blocks {
				if b.Type == "text" && b.Text != "" {
					parts = append(parts, b.Text)
				}
			}
			if p := promptText(strings.Join(parts, "\n")); p != "" {
				d.UserPrompts = append(d.UserPrompts, p)
			}
		case "assistant":
			if e.IsSidechain {
				continue
			}
			for _, b := range e.blocks() {
				switch b.Type {
				case "text":
					if strings.TrimSpace(b.Text) != "" {
						d.FinalAssistantText = truncate(b.Text, maxFinalTextRunes)
					}
				case "tool_use":
					d.ToolCounts[b.Name]++
					switch b.Name {
					case "Bash":
						if desc := b.Input.Description; desc != "" && !seenBashDesc[desc] {
							seenBashDesc[desc] = true
							d.BashDescriptions = append(d.BashDescriptions, desc)
						}
					case "Edit", "Write", "NotebookEdit":
						if fp := b.Input.FilePath; fp != "" && !seenFile[fp] {
							seenFile[fp] = true
							d.FilesEdited = append(d.FilesEdited, fp)
						}
					case "Task", "Agent":
						spawn := Subagent{
							Name:        b.Input.AgentName,
							AgentType:   b.Input.SubagentType,
							Description: b.Input.Description,
						}
						if spawn.Description != "" || spawn.Name != "" {
							spawns = append(spawns, spawn)
						}
					}
				}
			}
		}
	}
	if err := sc.Err(); err != nil {
		return Digest{}, fmt.Errorf("scan %s: %w", transcriptPath, err)
	}

	d.Title = customTitle
	if d.Title == "" {
		d.Title = aiTitle
	}
	if d.SessionID == "" {
		d.SessionID = strings.TrimSuffix(filepath.Base(transcriptPath), ".jsonl")
	}
	if roster := subagentsFromDir(subagentsDir); len(roster) > 0 {
		d.Subagents = roster
	} else {
		d.Subagents = spawns
	}
	if len(d.ToolCounts) == 0 {
		d.ToolCounts = nil
	}
	return d, nil
}

// subagentsFromDir reads the agent-*.meta.json files Claude Code writes under
// ~/.claude/projects/<slug>/<session-id>/subagents/. A missing dir returns nil.
func subagentsFromDir(dir string) []Subagent {
	if dir == "" {
		return nil
	}
	des, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []Subagent
	for _, de := range des {
		if de.IsDir() || !strings.HasSuffix(de.Name(), ".meta.json") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, de.Name()))
		if err != nil {
			continue
		}
		var sa Subagent
		if json.Unmarshal(raw, &sa) != nil {
			continue
		}
		if sa.Description == "" && sa.Name == "" {
			continue
		}
		out = append(out, sa)
	}
	return out
}

// promptText filters transcript user content down to prompts a human actually
// typed: harness-injected records (slash-command echoes, hook output,
// interruption markers, system reminders) are dropped, and what survives is
// truncated to keep digests compact.
func promptText(s string) string {
	s = strings.TrimSpace(s)
	for _, skip := range []string{
		"<command-name>",
		"<local-command",
		"<user-prompt-submit-hook>",
		"<system-reminder>",
		"[Request interrupted",
	} {
		if strings.HasPrefix(s, skip) {
			return ""
		}
	}
	return truncate(s, maxPromptRunes)
}

func truncate(s string, max int) string {
	s = strings.TrimSpace(s)
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max]) + "…"
}
