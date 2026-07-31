package sessiondigest

import (
	"bytes"
	"encoding/json"
	"strings"
)

// A Claude Code transcript (~/.claude/projects/<slug>/<session-id>.jsonl) is
// one JSON object per line. The format is versioned and undocumented: record
// types come and go across releases, so parsing is tolerant — unknown types
// and malformed lines are skipped, and every field is optional.
//
// Record types this package reads:
//   - "custom-title" / "ai-title" / "agent-name": session identity, appended
//     repeatedly as the session evolves; the last of each kind wins.
//   - "user": real prompts (string or text-block content) and tool_result
//     payloads (scanned for git-commit confirmation lines).
//   - "assistant": text blocks (the last one is the session's closing word)
//     and tool_use blocks (authored Bash descriptions, files edited, and
//     Task/Agent subagent spawns).

type entry struct {
	Type        string `json:"type"`
	IsMeta      bool   `json:"isMeta"`
	IsSidechain bool   `json:"isSidechain"`
	Timestamp   string `json:"timestamp"`
	SessionID   string `json:"sessionId"`
	GitBranch   string `json:"gitBranch"`
	Cwd         string `json:"cwd"`

	AITitle     string `json:"aiTitle"`     // type=="ai-title"
	CustomTitle string `json:"customTitle"` // type=="custom-title"
	AgentName   string `json:"agentName"`   // type=="agent-name"

	Message struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"` // string or []block; parsed by blocks()
	} `json:"message"`
}

// block is one element of an array-form message.content.
type block struct {
	Type    string          `json:"type"` // "text", "tool_use", "tool_result"
	Text    string          `json:"text"`
	Name    string          `json:"name"`    // tool name on a tool_use
	Content json.RawMessage `json:"content"` // tool_result payload: string or nested text blocks
	Input   struct {
		// Task/Agent spawns carry the identity the parent model authored for
		// the subagent. Older releases name the tool "Task" and set
		// subagent_type; current ones name it "Agent" and set name.
		SubagentType string `json:"subagent_type"`
		AgentName    string `json:"name"`
		Description  string `json:"description"` // also Bash's authored one-line description
		FilePath     string `json:"file_path"`   // Edit/Write/NotebookEdit target
	} `json:"input"`
}

// blocks parses message.content tolerantly: an array yields its typed blocks,
// a bare string yields one synthetic text block, anything else (null, object,
// unparseable) yields nil.
func (e entry) blocks() []block {
	raw := bytes.TrimSpace(e.Message.Content)
	if len(raw) == 0 {
		return nil
	}
	switch raw[0] {
	case '[':
		var bs []block
		if json.Unmarshal(raw, &bs) != nil {
			return nil
		}
		return bs
	case '"':
		var s string
		if json.Unmarshal(raw, &s) != nil {
			return nil
		}
		return []block{{Type: "text", Text: s}}
	}
	return nil
}

// resultText flattens a tool_result block's payload, which is either a bare
// string or a nested array of text blocks.
func (b block) resultText() string {
	raw := bytes.TrimSpace(b.Content)
	if len(raw) == 0 {
		return ""
	}
	switch raw[0] {
	case '"':
		var s string
		if json.Unmarshal(raw, &s) != nil {
			return ""
		}
		return s
	case '[':
		var bs []block
		if json.Unmarshal(raw, &bs) != nil {
			return ""
		}
		var sb strings.Builder
		for _, nested := range bs {
			if nested.Type == "text" && nested.Text != "" {
				sb.WriteString(nested.Text)
				sb.WriteByte('\n')
			}
		}
		return sb.String()
	}
	return ""
}
