package arachne

import (
	"bytes"
	"encoding/json"
)

// The Arachne per-container log is the container's stdout: a human-readable
// entrypoint preamble followed by one Claude Code stream-json object per line.
// We parse only the JSON lines and extract:
//   - Task subagent spawns (assistant tool_use with name=="Task"),
//   - tool_result ids (to close subagents; the recorder matches these against
//     the Task ids it is tracking, ignoring Bash/Edit/etc. results),
//   - per-assistant token usage (summed to a cumulative session total).
//
// The system "task_started"/"task_notification" events are deliberately NOT
// treated as subagents: those are local_bash background commands, not LLM
// subagents (see the ops report). Only real Claude Task sidechains count.

// SubagentSpawn is a detected Task delegation.
type SubagentSpawn struct {
	ToolUseID   string
	AgentType   string
	Description string
	TS          string
}

// SubagentResult is a tool_result observed in the stream; the recorder decides
// whether it closes a tracked subagent.
type SubagentResult struct {
	ToolUseID string
	TS        string
}

// LogScan is the result of scanning a log chunk.
type LogScan struct {
	Spawns  []SubagentSpawn
	Results []SubagentResult
	Usage   Usage // summed token usage across assistant events in the chunk
	// Consumed is the number of bytes up to and including the last complete line,
	// so an incremental tailer can advance its offset without splitting a line.
	Consumed int
}

type rawEvent struct {
	Type      string     `json:"type"`
	Timestamp string     `json:"timestamp"`
	Message   rawMessage `json:"message"`
}

type rawMessage struct {
	Content []rawContent `json:"content"`
	Usage   *rawUsage    `json:"usage"`
}

type rawContent struct {
	Type      string       `json:"type"`
	ID        string       `json:"id"`
	Name      string       `json:"name"`
	Input     rawTaskInput `json:"input"`
	ToolUseID string       `json:"tool_use_id"`
}

type rawTaskInput struct {
	SubagentType string `json:"subagent_type"`
	Description  string `json:"description"`
}

type rawUsage struct {
	InputTokens              int64 `json:"input_tokens"`
	OutputTokens             int64 `json:"output_tokens"`
	CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
	CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
}

// ScanLog parses complete (newline-terminated) lines from chunk. A trailing
// partial line is left unconsumed for the next chunk.
func ScanLog(chunk []byte) LogScan {
	var out LogScan
	consumed := 0
	for {
		rel := bytes.IndexByte(chunk[consumed:], '\n')
		if rel < 0 {
			break
		}
		line := chunk[consumed : consumed+rel]
		consumed += rel + 1
		scanLine(line, &out)
	}
	out.Consumed = consumed
	return out
}

func scanLine(line []byte, out *LogScan) {
	line = bytes.TrimSpace(line)
	if len(line) == 0 || line[0] != '{' {
		return // entrypoint preamble / non-JSON line
	}
	var e rawEvent
	if err := json.Unmarshal(line, &e); err != nil {
		return
	}
	switch e.Type {
	case "assistant":
		if e.Message.Usage != nil {
			u := e.Message.Usage
			out.Usage.TokIn += u.InputTokens
			out.Usage.TokOut += u.OutputTokens
			out.Usage.TokCacheRead += u.CacheReadInputTokens
			out.Usage.TokCacheCreate += u.CacheCreationInputTokens
		}
		for _, c := range e.Message.Content {
			if c.Type == "tool_use" && c.Name == "Task" && c.ID != "" {
				out.Spawns = append(out.Spawns, SubagentSpawn{
					ToolUseID:   c.ID,
					AgentType:   c.Input.SubagentType,
					Description: c.Input.Description,
					TS:          e.Timestamp,
				})
			}
		}
	case "user":
		for _, c := range e.Message.Content {
			if c.Type == "tool_result" && c.ToolUseID != "" {
				out.Results = append(out.Results, SubagentResult{ToolUseID: c.ToolUseID, TS: e.Timestamp})
			}
		}
	}
}
