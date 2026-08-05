package sessiondigest

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
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
//   - "assistant": text blocks (the last one is the session's closing word),
//     tool_use blocks (authored Bash descriptions, files edited, and Task/Agent
//     subagent spawns), and message.usage — the token counts tokens.go sums.

type entry struct {
	Type        string `json:"type"`
	IsMeta      bool   `json:"isMeta"`
	IsSidechain bool   `json:"isSidechain"`
	Timestamp   string `json:"timestamp"`
	SessionID   string `json:"sessionId"`
	GitBranch   string `json:"gitBranch"`
	Cwd         string `json:"cwd"`
	// RequestID identifies the HTTP call behind an assistant record; it is the
	// fallback key when message.id is absent. See tokenAccumulator.add.
	RequestID string `json:"requestId"`

	AITitle     string `json:"aiTitle"`     // type=="ai-title"
	CustomTitle string `json:"customTitle"` // type=="custom-title"
	AgentName   string `json:"agentName"`   // type=="agent-name"

	Message struct {
		// ID is the API response's identity, NOT the record's: one response is
		// written as one record per content block, each repeating this id and a
		// byte-identical usage. Summing without deduplicating on it inflates a
		// session's tokens by however many blocks its responses carried.
		ID      string          `json:"id"`
		Model   string          `json:"model"` // "<synthetic>" on client-injected records
		Role    string          `json:"role"`
		Usage   *usage          `json:"usage"`   // assistant records only
		Content json.RawMessage `json:"content"` // string or []block; parsed by blocks()
	} `json:"message"`
}

// usage mirrors message.usage on an assistant record. Every field is optional
// and absent ones read as zero, the same tolerance the rest of this file keeps:
// the format is versioned and undocumented, so a block that gains or loses a
// field must not cost the record.
//
// The sibling iterations[] array — a per-attempt copy of these same numbers — is
// deliberately not read. It is length 1 on every record that has one and its
// entries sum to exactly these top-level fields, so reading both would double
// every count.
type usage struct {
	InputTokens              int `json:"input_tokens"` // uncached remainder only; see TokenCounts
	CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
	CacheReadInputTokens     int `json:"cache_read_input_tokens"`
	OutputTokens             int `json:"output_tokens"`
	CacheCreation            struct {
		Ephemeral1h int `json:"ephemeral_1h_input_tokens"`
		Ephemeral5m int `json:"ephemeral_5m_input_tokens"`
	} `json:"cache_creation"`
}

// turnInput is the prompt this turn actually paid for: the uncached remainder
// plus the cache write plus the cache read. Every turn resends the whole
// conversation, so this — not input_tokens — is the size of a turn.
func (u usage) turnInput() int {
	return u.InputTokens + u.CacheCreationInputTokens + u.CacheReadInputTokens
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

// scanEntries reads a transcript line by line and hands each parsed record to
// visit. Blank lines, non-JSON lines, and records that fail to parse are
// skipped rather than failing the file — see the tolerance note above. The
// buffer is sized for the pathological case: a single line can carry megabytes
// of pasted or base64 content.
func scanEntries(path string, visit func(entry)) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
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
		visit(e)
	}
	if err := sc.Err(); err != nil {
		return fmt.Errorf("scan %s: %w", path, err)
	}
	return nil
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
