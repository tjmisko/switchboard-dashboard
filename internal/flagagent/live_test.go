package flagagent

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/tjmisko/switchboard-dashboard/internal/flags"
)

// TestLiveInvestigationShouldDiagnoseTheKnownGhostWhenRunAgainstRealHistory
// exercises the real `claude -p` path end to end against the real activity log.
//
// It is skipped unless SWITCHBOARD_LIVE_AGENT=1, because it costs money and
// needs both a logged-in `claude` and a populated history directory — none of
// which belong in an ordinary `go test ./...`. Every other test in this package
// runs against a stub.
//
// The lane it investigates is the one that motivated the whole feature: session
// 296eb0f0 on 2026-08-05, where a session_end stamped 1.16ms before the final
// transition split one 19-second session into a real lane plus a ghost stretched
// to three hours. It is the hardest available check of whether the prompt,
// tool scope, and schema actually produce a usable verdict, because the right
// answer is known and is NOT the obvious one — a model that pattern-matches
// "long idle lane" without reading the events tends to call it correct-data.
func TestLiveInvestigationShouldDiagnoseTheKnownGhostWhenRunAgainstRealHistory(t *testing.T) {
	if os.Getenv("SWITCHBOARD_LIVE_AGENT") != "1" {
		t.Skip("set SWITCHBOARD_LIVE_AGENT=1 to run the live `claude -p` investigation")
	}

	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("resolve home: %v", err)
	}
	historyDir := filepath.Join(home, ".local", "state", "switchboard", "history")
	if _, err := os.Stat(historyDir); err != nil {
		t.Skipf("no history at %s: %v", historyDir, err)
	}

	runner := ClaudeRunner("sonnet", t.TempDir(), historyDir, "0.50")
	agent := New(runner, "sonnet")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	verdict, err := agent.Investigate(ctx, ghostRecord())
	if err != nil {
		t.Fatalf("Investigate: %v", err)
	}
	t.Logf("verdict=%s confidence=%s action=%s\nroot cause: %s\nevidence: %v",
		verdict.Verdict, verdict.Confidence, verdict.Action.Type, verdict.RootCause, verdict.Evidence)

	if verdict.Verdict == "correct-data" {
		t.Errorf("called a synthesized 3h lane correct; the events show a 19-second session")
	}
	if verdict.Action.Type == flags.ActionMergeInto {
		t.Errorf("merging a synthesized lane into its real sibling would import the artifact")
	}
	if len(verdict.Evidence) == 0 {
		t.Error("no evidence cited; the prompt asks for the log lines the verdict stands on")
	}
}
