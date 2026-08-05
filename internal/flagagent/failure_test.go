package flagagent

import (
	"strings"
	"testing"
)

func TestSummarizeFailureShouldNameTheBudgetWhenARunRanOutOfMoney(t *testing.T) {
	// Observed for real: a lane with no session id sends the agent searching by
	// pid across day-files, and the run stopped mid-tool-use having spent $0.67
	// against a $0.50 ceiling. Raw, that surfaced as a kilobyte of token
	// accounting where the reason should be — and the fix for "out of money" is
	// nothing like the fix for a crash, so the two must not read alike.
	envelope := `{"is_error":true,"duration_api_ms":101160,"num_turns":18,"stop_reason":"tool_use",` +
		`"total_cost_usd":0.6702315,"usage":{"input_tokens":18,"cache_read_input_tokens":278917}}`

	got := summarizeFailure([]byte(envelope))
	for _, want := range []string{"18 turns", "$0.67", "tool_use", "--investigate-budget"} {
		if !strings.Contains(got, want) {
			t.Errorf("summary is missing %q: %s", want, got)
		}
	}
	if strings.Contains(got, "cache_read_input_tokens") {
		t.Errorf("summary leaked raw token accounting: %s", got)
	}
}

func TestSummarizeFailureShouldFallBackWhenOutputIsNotAnEnvelope(t *testing.T) {
	for _, raw := range []string{"panic: boom", "", "not json at all"} {
		if got := summarizeFailure([]byte(raw)); got != strings.TrimSpace(raw) {
			t.Errorf("summarizeFailure(%q) = %q, want it passed through", raw, got)
		}
	}
}

func TestSummarizeFailureShouldPreferResultProseWhenNoCostIsReported(t *testing.T) {
	got := summarizeFailure([]byte(`{"is_error":true,"result":"Credit balance is too low"}`))
	if got != "Credit balance is too low" {
		t.Errorf("summarizeFailure = %q, want the envelope's own prose", got)
	}
}

func TestSummarizeFailureShouldPassThroughWhenEnvelopeIsNotAnError(t *testing.T) {
	// A successful envelope reaching here would mean the caller misread the exit
	// status; do not rewrite it into a failure message.
	raw := `{"is_error":false,"result":"{}"}`
	if got := summarizeFailure([]byte(raw)); got != raw {
		t.Errorf("summarizeFailure rewrote a non-error envelope: %q", got)
	}
}
