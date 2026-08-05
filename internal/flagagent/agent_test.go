package flagagent

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/tjmisko/switchboard-dashboard/internal/flags"
)

const goodVerdict = `{
  "verdict": "ghost-lane",
  "confidence": "high",
  "root_cause": "session_end is stamped 1.16ms before the trailing transition",
  "evidence": ["10:29:37.437833786 session_end", "10:29:37.438991459 transition"],
  "action": {"type": "suppress-lane"},
  "upstream": {"repo": "switchboard", "title": "reader splits a lane on an out-of-order session_end"}
}`

func ghostRecord() flags.Record {
	return flags.Record{
		SessionID: "296eb0f0-44c5-4406-84a9-04abae0db150",
		LaneStart: "2026-08-05T10:29:37.438991459-07:00",
		LaneEnd:   "2026-08-05T13:41:34.680948947-07:00",
		Project:   "screening-overhaul",
		Note:      "3h idle, session was seconds",
	}
}

func runnerReturning(out string) Runner {
	return func(context.Context, string) (string, error) { return out, nil }
}

func TestInvestigateShouldReturnVerdictWhenModelAnswersCleanly(t *testing.T) {
	agent := New(runnerReturning(goodVerdict), "sonnet")
	verdict, err := agent.Investigate(context.Background(), ghostRecord())
	if err != nil {
		t.Fatalf("Investigate: %v", err)
	}
	if verdict.Verdict != "ghost-lane" || verdict.Action.Type != flags.ActionSuppress {
		t.Errorf("verdict = %+v", verdict)
	}
	if !verdict.AutoApplicable() {
		t.Error("a high-confidence, well-formed verdict should be auto-applicable")
	}
	if len(verdict.Evidence) != 2 {
		t.Errorf("evidence = %v, want both log lines", verdict.Evidence)
	}
}

func TestParseVerdictShouldUnwrapWhenOutputFormatJSONWrapsTheAnswer(t *testing.T) {
	// `claude -p --output-format json` returns an envelope whose "result" holds
	// the answer as a string. Both shapes have to work: the flag is not worth
	// losing to a wrapper.
	envelope := `{"type":"result","subtype":"success","is_error":false,"result":` +
		mustJSONString(t, goodVerdict) + `,"total_cost_usd":0.04}`
	verdict, err := ParseVerdict(envelope)
	if err != nil {
		t.Fatalf("ParseVerdict: %v", err)
	}
	if verdict.Verdict != "ghost-lane" {
		t.Errorf("verdict = %q", verdict.Verdict)
	}
}

func TestParseVerdictShouldToleratePreambleWhenModelAddsFencesOrProse(t *testing.T) {
	for _, name := range []string{"fenced", "prose", "both"} {
		t.Run(name, func(t *testing.T) {
			body := goodVerdict
			switch name {
			case "fenced":
				body = "```json\n" + body + "\n```"
			case "prose":
				body = "Here is what I found:\n" + body
			case "both":
				body = "Here is what I found:\n```json\n" + body + "\n```\nHope that helps."
			}
			verdict, err := ParseVerdict(body)
			if err != nil {
				t.Fatalf("ParseVerdict: %v", err)
			}
			if verdict.Verdict != "ghost-lane" {
				t.Errorf("verdict = %q", verdict.Verdict)
			}
		})
	}
}

func TestParseVerdictShouldRejectWhenValueIsOutsideTheClosedEnum(t *testing.T) {
	// The whole safety argument is that the agent's only channel is this struct.
	// An unrecognized value has to be an error, never coerced into a known one.
	cases := map[string]string{
		"unknown action":          `{"verdict":"ghost-lane","confidence":"high","root_cause":"x","action":{"type":"rm -rf"}}`,
		"unknown verdict":         `{"verdict":"delete-the-database","confidence":"high","root_cause":"x","action":{"type":"none"}}`,
		"unknown confidence":      `{"verdict":"ghost-lane","confidence":"certain","root_cause":"x","action":{"type":"none"}}`,
		"merge without a target":  `{"verdict":"split-lane","confidence":"high","root_cause":"x","action":{"type":"merge-into"}}`,
		"clip without an instant": `{"verdict":"ghost-lane","confidence":"high","root_cause":"x","action":{"type":"clip-at"}}`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseVerdict(body); err == nil {
				t.Fatal("ParseVerdict accepted a verdict outside the closed enum")
			}
		})
	}
}

func TestParseVerdictShouldFailWhenModelReturnsNoObject(t *testing.T) {
	for _, body := range []string{"", "I could not work it out.", "```\n```"} {
		if _, err := ParseVerdict(body); err == nil {
			t.Errorf("ParseVerdict(%q) succeeded, want an error", body)
		}
	}
}

func TestParseVerdictShouldFailWhenEnvelopeReportsAnError(t *testing.T) {
	// An errored envelope carries prose in "result". Building a verdict out of an
	// error message would turn a failed run into a confident repair.
	envelope := `{"type":"result","is_error":true,"result":"Error: budget exceeded"}`
	if _, err := ParseVerdict(envelope); err == nil {
		t.Fatal("ParseVerdict accepted an errored envelope")
	}
}

func TestInvestigateShouldPropagateWhenRunnerFails(t *testing.T) {
	agent := New(func(context.Context, string) (string, error) {
		return "", errors.New("claude -p: exit status 1")
	}, "sonnet")
	if _, err := agent.Investigate(context.Background(), ghostRecord()); err == nil {
		t.Fatal("Investigate swallowed a runner failure")
	}
}

func TestInvestigateShouldFailWhenNoRunnerIsConfigured(t *testing.T) {
	agent := &Agent{}
	if _, err := agent.Investigate(context.Background(), ghostRecord()); err == nil {
		t.Fatal("an agent with no runner should not silently succeed")
	}
}

func TestBuildPromptShouldCarryTheLaneWhenOperatorAddedANote(t *testing.T) {
	prompt := BuildPrompt(ghostRecord())
	for _, want := range []string{
		"296eb0f0-44c5-4406-84a9-04abae0db150",
		"2026-08-05T10:29:37.438991459-07:00",
		"screening-overhaul",
		"3h idle, session was seconds",
	} {
		if !strings.Contains(prompt, want) {
			t.Errorf("prompt is missing %q:\n%s", want, prompt)
		}
	}
}

func TestBuildPromptShouldSaySoWhenOperatorGaveNoReason(t *testing.T) {
	record := ghostRecord()
	record.Note = ""
	prompt := BuildPrompt(record)
	if !strings.Contains(prompt, "without saying why") {
		t.Errorf("prompt does not account for a missing note:\n%s", prompt)
	}
}

func TestClaudeRunnerArgsShouldGrantNoWriteToolWhenScoped(t *testing.T) {
	// This asserts the safety property in the one place it is expressed. The
	// agent's remit is "read the log and answer"; anything that could mutate the
	// machine has to be absent from --tools and named in --disallowedTools.
	if strings.Contains(claudeToolsFlag, "Write") || strings.Contains(claudeToolsFlag, "Edit") {
		t.Fatalf("--tools grants a write tool: %q", claudeToolsFlag)
	}
	for _, banned := range []string{"Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Task"} {
		if !strings.Contains(claudeDisallowedFlag, banned) {
			t.Errorf("--disallowedTools does not name %q: %q", banned, claudeDisallowedFlag)
		}
	}
}

func TestVerdictSchemaShouldMatchTheEnumsTheValidatorEnforces(t *testing.T) {
	// The schema tells the model what is allowed and the validator decides what
	// is acted on. If they drift, the model is guided toward answers that will be
	// thrown away.
	for _, verdict := range []string{
		"ghost-lane", "split-lane", "misattributed-project",
		"empty-status-interval", "stale-summary", "correct-data", "unknown",
	} {
		if !strings.Contains(VerdictSchema, `"`+verdict+`"`) {
			t.Errorf("schema omits verdict %q the validator accepts", verdict)
		}
	}
	for _, action := range []string{"none", "suppress-lane", "clip-at", "merge-into"} {
		if !strings.Contains(VerdictSchema, `"`+action+`"`) {
			t.Errorf("schema omits action %q the validator accepts", action)
		}
	}
}

// mustJSONString encodes s as a JSON string literal, so a verdict can be nested
// inside the --output-format json envelope the way `claude -p` nests it.
func mustJSONString(t *testing.T, s string) string {
	t.Helper()
	raw, err := json.Marshal(s)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(raw)
}
