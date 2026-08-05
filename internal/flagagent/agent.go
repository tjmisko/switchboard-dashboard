// Package flagagent runs the investigation behind a flagged lane: a headless
// Claude Code process that reads the raw activity log, works out why the
// timeline drew what it drew, and returns a verdict.
//
// The agent has NO write tool. Its entire effect on the world is the
// schema-validated flags.Verdict it returns, which the caller then acts on. That
// is a stronger guarantee than fencing Write and Edit to one directory: a fence
// is a configuration and configurations are got wrong, whereas an agent holding
// no write tool cannot damage anything whatever it concludes. The worst outcome
// available to a confused model here is a wrong overlay, and overlays revert.
package flagagent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strings"

	"github.com/tjmisko/switchboard-dashboard/internal/flags"
)

// The tool scope, named here rather than inline so the safety property is
// asserted in one place (see TestClaudeRunnerArgsShouldGrantNoWriteToolWhenScoped).
const (
	// claudeToolsFlag is the whole built-in set this agent may use. None of these
	// four can modify anything.
	claudeToolsFlag = "Read,Glob,Grep,Bash"

	// claudeDisallowedFlag re-states the ban on the write-shaped tools. It is
	// redundant against claudeToolsFlag today and deliberately kept: if the
	// built-in set ever grows a default this list is the belt to that braces.
	claudeDisallowedFlag = "Edit,Write,NotebookEdit,WebFetch,WebSearch,Task"

	// claudeAllowedFlag pre-approves exactly the read commands the investigation
	// needs. Anything outside it fails rather than prompting — a headless session
	// cannot answer a permission prompt, and one that blocked on it would spend
	// the entire timeout waiting.
	claudeAllowedFlag = "Read Glob Grep " +
		"Bash(rg *) Bash(jq *) Bash(ls *) Bash(wc *) " +
		"Bash(switchboard-ctl timeline *) " +
		"Bash(switchboard-ctl history *) " +
		"Bash(switchboard-ctl diagnose *)"
)

// Runner produces a model's raw response for a prompt. It mirrors
// sessiondigest.Runner so tests substitute a fake and no real `claude -p` ever
// runs under `go test`.
type Runner func(ctx context.Context, prompt string) (string, error)

// Agent investigates flagged lanes.
type Agent struct {
	Run Runner
	// Model is recorded on the resulting AgentRun so a verdict can be read back
	// against what produced it.
	Model string
}

// New returns an Agent driven by run.
func New(run Runner, model string) *Agent { return &Agent{Run: run, Model: model} }

// Investigate diagnoses one flagged lane.
func (a *Agent) Investigate(ctx context.Context, record flags.Record) (flags.Verdict, error) {
	if a == nil || a.Run == nil {
		return flags.Verdict{}, errors.New("flagagent: no runner configured")
	}
	out, err := a.Run(ctx, BuildPrompt(record))
	if err != nil {
		return flags.Verdict{}, err
	}
	return ParseVerdict(out)
}

// VerdictSchema is the JSON Schema handed to `claude -p --json-schema`. It is
// the same closed vocabulary flags.Verdict.Validate enforces, stated where the
// model can see it — the schema makes the right answer easy to produce, and the
// validation makes a wrong one impossible to act on. Both are needed: the schema
// is guidance, not a guarantee we control.
const VerdictSchema = `{
  "type": "object",
  "required": ["verdict", "confidence", "root_cause", "action"],
  "properties": {
    "verdict": {"type": "string", "enum": ["ghost-lane", "split-lane", "misattributed-project", "empty-status-interval", "stale-summary", "correct-data", "unknown"]},
    "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
    "root_cause": {"type": "string"},
    "evidence": {"type": "array", "items": {"type": "string"}},
    "action": {
      "type": "object",
      "required": ["type"],
      "properties": {
        "type": {"type": "string", "enum": ["none", "suppress-lane", "clip-at", "merge-into"]},
        "merge_into_lane_start": {"type": "string"},
        "clip_at": {"type": "string"}
      }
    },
    "upstream": {
      "type": "object",
      "properties": {
        "repo": {"type": "string", "enum": ["switchboard", "switchboard-dashboard", "none"]},
        "file": {"type": "string"},
        "title": {"type": "string"},
        "body": {"type": "string"}
      }
    }
  }
}`

// SystemPrompt frames the investigation. It is appended to the default system
// prompt rather than replacing it, so the agent keeps its ordinary tool sense.
const SystemPrompt = `You are diagnosing a data-quality problem in a session-timeline dashboard.

The dashboard renders "lanes" (one session's bar over time) derived from an
append-only activity log at ~/.local/state/switchboard/history/YYYY-MM-DD.jsonl.
Each line is one event: session_start, transition, session_end, usage_sample,
memory_sample, session_label, focus, activity, subagent_spawn, subagent_stop.
The schema is documented at ~/Projects/switchboard/docs/history-schema.md — read
it before concluding anything.

A reader groups events by session_id, orders them by timestamp, and turns
consecutive transitions into intervals. Known ways that goes wrong:

- GHOST LANE: a trailing event arrives after the session_end that closed the
  lane, so the reader opens a second lane nothing ever closes and stretches it to
  the window bound. Look for a session_end whose timestamp PRECEDES a later
  transition for the same session, often by under a millisecond, because the two
  were written by different code paths racing. The synthesized lane is usually a
  single long interval with no name.
- SPLIT LANE: one session's work reported as two lanes where BOTH halves hold
  observed events. This is not a ghost, and the repair is different.
- MISATTRIBUTED PROJECT: correct timing, wrong project grouping — usually a cwd
  that resolved to an unexpected abbreviation.
- EMPTY STATUS INTERVAL: an interval whose status is the empty string.
- STALE SUMMARY: the lane is fine but its summary describes different work.

Investigate with the read-only tools you have. Useful commands:
  rg <session-id> ~/.local/state/switchboard/history/*.jsonl | jq .
  switchboard-ctl timeline --day <D> --json | jq '.lanes[] | select(...)'
  switchboard-ctl diagnose --session <id> --json

Decide between these repairs, and be conservative:
- suppress-lane: the lane is PURE SYNTHESIS. Nothing real is lost by removing it.
- merge-into: the lane holds real work belonging to a sibling lane of the same
  session. Give that sibling's exact start timestamp in merge_into_lane_start.
  Never merge a synthesized lane into a real one — that imports the artifact into
  a lane that was fine.
- clip-at: the lane's head is real and its tail is synthesized. Give the instant
  the evidence stops in clip_at.
- none: the data is correct, or you cannot tell. "correct-data" and "unknown" are
  respectable answers and are much better than a guess.

Use confidence "high" ONLY when the raw events prove the verdict — a repair at
high confidence is applied without anyone reviewing it first. If you are
reasoning by plausibility rather than from specific log lines, say "medium" or
"low".

Put the exact log lines you relied on in evidence, verbatim and short.

If the timing points at a reproducible defect in the producer, draft an upstream
issue: repo "switchboard" for the daemon and reader, "switchboard-dashboard" for
the renderer, "none" if there is no clear defect. The draft is filed by a human,
not by you.`

// BuildPrompt renders the flagged lane into the investigation prompt.
func BuildPrompt(record flags.Record) string {
	var sb strings.Builder
	sb.WriteString("Investigate this flagged timeline lane and return your verdict as JSON.\n\n")
	field := func(key, value string) {
		if value != "" {
			fmt.Fprintf(&sb, "%s: %s\n", key, value)
		}
	}
	field("session_id", record.SessionID)
	field("lane_start", record.LaneStart)
	field("lane_end", record.LaneEnd)
	field("project", record.Project)
	field("provider", record.Provider)
	if record.Note != "" {
		fmt.Fprintf(&sb, "\nThe operator flagged it and said: %q\n", record.Note)
	} else {
		sb.WriteString("\nThe operator flagged it without saying why.\n")
	}
	sb.WriteString("\nWork out what actually happened, from the raw events.\n")
	return sb.String()
}

// ParseVerdict extracts the verdict from a model response.
//
// It tolerates the two shapes `claude -p` produces — a bare JSON object, and the
// --output-format json envelope that wraps the answer in a "result" string —
// plus the code fences and stray prose a model sometimes adds anyway. Then it
// validates: a response that parses but asks for something outside the closed
// enum is an error here, not a repair to attempt.
func ParseVerdict(out string) (flags.Verdict, error) {
	body := unwrapResult(out)
	start := strings.Index(body, "{")
	end := strings.LastIndex(body, "}")
	if start < 0 || end <= start {
		return flags.Verdict{}, errors.New("no JSON object in model output")
	}
	var verdict flags.Verdict
	if err := json.Unmarshal([]byte(body[start:end+1]), &verdict); err != nil {
		return flags.Verdict{}, fmt.Errorf("parse verdict JSON: %w", err)
	}
	if err := verdict.Validate(); err != nil {
		return flags.Verdict{}, err
	}
	return verdict, nil
}

// maxDetail bounds how much of a failed run's output rides along in the error.
// The message is stored on the flag record and shown in the UI, and a runaway
// transcript there would bury the flag it belongs to.
const maxDetail = 600

func truncateDetail(s string) string {
	if len(s) <= maxDetail {
		return s
	}
	return s[:maxDetail] + "…"
}

// unwrapResult pulls the answer out of the `--output-format json` envelope when
// one is present, and otherwise hands the text back untouched. An envelope whose
// is_error is set surfaces as no usable object rather than as a verdict built
// from an error message.
func unwrapResult(out string) string {
	var envelope struct {
		Result  string `json:"result"`
		IsError bool   `json:"is_error"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &envelope); err != nil {
		return out
	}
	if envelope.IsError {
		return ""
	}
	if envelope.Result == "" {
		return out
	}
	return envelope.Result
}

// ClaudeRunner shells out to a tightly scoped headless `claude -p`.
//
// Every restriction here is load-bearing:
//
//   - --tools names the only built-ins the session may use, and none of them can
//     write. --disallowedTools re-states the ban on the write-shaped tools so a
//     future change to the built-in set cannot quietly widen the agent.
//   - --allowedTools pre-approves exactly the read commands the investigation
//     needs, so nothing has to prompt — a headless session cannot answer a
//     permission prompt, and one that hangs on it would burn the whole timeout.
//   - --permission-mode dontAsk makes anything outside that list fail instead of
//     blocking.
//   - --add-dir grants the history directory, which is outside the working
//     directory and is where the evidence actually lives. Read-only by
//     construction: no tool in the set can write there.
//   - --max-budget-usd caps the spend of a single investigation. (There is no
//     --max-turns flag on current Claude Code; the budget is the turn bound.)
//   - --no-session-persistence keeps investigations out of ~/.claude/projects,
//     so they never become sessions the dashboard then renders.
//
// dir becomes the working directory, following the trick in
// sessiondigest.ClaudeRunner: rooting the process somewhere the digester skips
// keeps the investigator from summarizing itself.
func ClaudeRunner(model, dir, historyDir string, maxUSD string) Runner {
	return func(ctx context.Context, prompt string) (string, error) {
		args := []string{
			"-p",
			"--model", model,
			"--output-format", "json",
			"--json-schema", VerdictSchema,
			"--append-system-prompt", SystemPrompt,
			"--permission-mode", "dontAsk",
			"--tools", claudeToolsFlag,
			"--disallowedTools", claudeDisallowedFlag,
			"--allowedTools", claudeAllowedFlag,
			"--max-budget-usd", maxUSD,
			"--no-session-persistence",
		}
		if historyDir != "" {
			args = append(args, "--add-dir", historyDir)
		}

		cmd := exec.CommandContext(ctx, "claude", args...)
		cmd.Dir = dir
		cmd.Stdin = strings.NewReader(prompt)
		out, err := cmd.Output()
		if err != nil {
			// A failing `claude -p --output-format json` writes its diagnosis to
			// STDOUT as an error envelope and leaves stderr empty, so reporting
			// stderr alone yields a bare "exit status 1" that says nothing. Both
			// streams go into the message, trimmed, or a failed investigation is
			// undebuggable from the flag record it lands in.
			detail := strings.TrimSpace(string(out))
			var exitErr *exec.ExitError
			if errors.As(err, &exitErr) && len(exitErr.Stderr) > 0 {
				if detail != "" {
					detail += "; "
				}
				detail += strings.TrimSpace(string(exitErr.Stderr))
			}
			if detail != "" {
				return "", fmt.Errorf("claude -p: %w: %s", err, truncateDetail(detail))
			}
			return "", fmt.Errorf("claude -p: %w", err)
		}
		return string(out), nil
	}
}
