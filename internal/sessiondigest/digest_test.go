package sessiondigest

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeTranscript writes lines as a session .jsonl into dir and returns its path.
func writeTranscript(t *testing.T, dir string, lines ...string) string {
	t.Helper()
	path := filepath.Join(dir, "11111111-2222-3333-4444-555555555555.jsonl")
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestDigestShouldPreferCustomTitleOverAITitleWhenBothPresent(t *testing.T) {
	path := writeTranscript(t, t.TempDir(),
		`{"type":"ai-title","aiTitle":"First auto title"}`,
		`{"type":"custom-title","customTitle":"my-renamed-session"}`,
		`{"type":"ai-title","aiTitle":"Later auto title"}`,
	)
	d, err := BuildFromTranscript(path, "")
	if err != nil {
		t.Fatal(err)
	}
	if d.Title != "my-renamed-session" {
		t.Errorf("Title = %q, want the custom title", d.Title)
	}
}

func TestDigestShouldFallBackToLastAITitleWhenNoCustomTitle(t *testing.T) {
	path := writeTranscript(t, t.TempDir(),
		`{"type":"ai-title","aiTitle":"First auto title"}`,
		`{"type":"ai-title","aiTitle":"Later auto title"}`,
		`{"type":"agent-name","agentName":"later-auto-title"}`,
	)
	d, err := BuildFromTranscript(path, "")
	if err != nil {
		t.Fatal(err)
	}
	if d.Title != "Later auto title" {
		t.Errorf("Title = %q, want the last ai-title", d.Title)
	}
	if d.AgentName != "later-auto-title" {
		t.Errorf("AgentName = %q, want the agent-name record", d.AgentName)
	}
}

func TestDigestShouldCollectOnlyHumanPromptsWhenTranscriptHasHarnessNoise(t *testing.T) {
	path := writeTranscript(t, t.TempDir(),
		`{"type":"user","isMeta":true,"message":{"role":"user","content":"<local-command-caveat>Caveat: ...</local-command-caveat>"}}`,
		`{"type":"user","message":{"role":"user","content":"<command-name>/clear</command-name>"}}`,
		`{"type":"user","message":{"role":"user","content":"please fix the flaky test"}}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"ok"}]}}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"now add coverage"},{"type":"image","source":{}}]}}`,
		`{"type":"user","message":{"role":"user","content":"[Request interrupted by user]"}}`,
	)
	d, err := BuildFromTranscript(path, "")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"please fix the flaky test", "now add coverage"}
	if len(d.UserPrompts) != len(want) {
		t.Fatalf("UserPrompts = %#v, want %#v", d.UserPrompts, want)
	}
	for i := range want {
		if d.UserPrompts[i] != want[i] {
			t.Errorf("UserPrompts[%d] = %q, want %q", i, d.UserPrompts[i], want[i])
		}
	}
}

func TestDigestShouldTruncateOverlongPromptsWhenCollecting(t *testing.T) {
	long := strings.Repeat("x", 600)
	path := writeTranscript(t, t.TempDir(),
		`{"type":"user","message":{"role":"user","content":"`+long+`"}}`,
	)
	d, err := BuildFromTranscript(path, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(d.UserPrompts) != 1 {
		t.Fatalf("UserPrompts count = %d, want 1", len(d.UserPrompts))
	}
	if got := []rune(d.UserPrompts[0]); len(got) != maxPromptRunes+1 || !strings.HasSuffix(d.UserPrompts[0], "…") {
		t.Errorf("prompt not truncated to %d runes + ellipsis (got %d runes)", maxPromptRunes, len(got))
	}
}

func TestDigestShouldKeepLastAssistantTextAsFinalWord(t *testing.T) {
	path := writeTranscript(t, t.TempDir(),
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"working on it"}]}}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"done: tests pass"}]}}`,
	)
	d, err := BuildFromTranscript(path, "")
	if err != nil {
		t.Fatal(err)
	}
	if d.FinalAssistantText != "done: tests pass" {
		t.Errorf("FinalAssistantText = %q, want the last text block", d.FinalAssistantText)
	}
}

func TestDigestShouldHarvestAuthoredToolArtifactsWhenScanningAssistantTurns(t *testing.T) {
	path := writeTranscript(t, t.TempDir(),
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"go test ./...","description":"Run all tests"}}]}}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"go test ./...","description":"Run all tests"}}]}}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/repo/a.go"}}]}}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Write","input":{"file_path":"/repo/a.go"}}]}}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_9","content":"[main abc1234] feat: add digest\n 1 file changed"}]}}`,
	)
	d, err := BuildFromTranscript(path, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(d.BashDescriptions) != 1 || d.BashDescriptions[0] != "Run all tests" {
		t.Errorf("BashDescriptions = %#v, want one deduplicated entry", d.BashDescriptions)
	}
	if len(d.FilesEdited) != 1 || d.FilesEdited[0] != "/repo/a.go" {
		t.Errorf("FilesEdited = %#v, want one unique path", d.FilesEdited)
	}
	if len(d.CommitSubjects) != 1 || d.CommitSubjects[0] != "feat: add digest" {
		t.Errorf("CommitSubjects = %#v, want the commit subject line", d.CommitSubjects)
	}
	if d.ToolCounts["Bash"] != 2 || d.ToolCounts["Edit"] != 1 || d.ToolCounts["Write"] != 1 {
		t.Errorf("ToolCounts = %#v", d.ToolCounts)
	}
}

func TestDigestShouldHarvestSubagentRosterFromMetaDirWhenPresent(t *testing.T) {
	dir := t.TempDir()
	path := writeTranscript(t, dir,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Agent","input":{"name":"stale-spawn","description":"Should be shadowed by meta dir"}}]}}`,
	)
	subagents := filepath.Join(dir, "11111111-2222-3333-4444-555555555555", "subagents")
	if err := os.MkdirAll(subagents, 0o755); err != nil {
		t.Fatal(err)
	}
	meta := `{"agentType":"model-agent","description":"Add projectHoursMs to model","name":"model-agent","model":"claude-opus-5"}`
	if err := os.WriteFile(filepath.Join(subagents, "agent-amodel-agent-1.meta.json"), []byte(meta), 0o644); err != nil {
		t.Fatal(err)
	}
	d, err := BuildFromTranscript(path, subagents)
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Subagents) != 1 {
		t.Fatalf("Subagents = %#v, want exactly the meta-dir roster", d.Subagents)
	}
	sa := d.Subagents[0]
	if sa.Name != "model-agent" || sa.Description != "Add projectHoursMs to model" || sa.Model != "claude-opus-5" {
		t.Errorf("Subagent = %#v, want meta.json fields verbatim", sa)
	}
}

func TestDigestShouldFallBackToSpawnRecordsWhenMetaDirMissing(t *testing.T) {
	dir := t.TempDir()
	path := writeTranscript(t, dir,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Task","input":{"subagent_type":"Explore","description":"Audit module code in crates/web"}}]}}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Agent","input":{"name":"markup-agent","description":"Markup+CSS for projects tab"}}]}}`,
	)
	d, err := BuildFromTranscript(path, filepath.Join(dir, "nonexistent", "subagents"))
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Subagents) != 2 {
		t.Fatalf("Subagents = %#v, want both Task and Agent spawns", d.Subagents)
	}
	if d.Subagents[0].AgentType != "Explore" || d.Subagents[0].Description != "Audit module code in crates/web" {
		t.Errorf("Task spawn = %#v", d.Subagents[0])
	}
	if d.Subagents[1].Name != "markup-agent" || d.Subagents[1].Description != "Markup+CSS for projects tab" {
		t.Errorf("Agent spawn = %#v", d.Subagents[1])
	}
}

func TestDigestShouldIgnoreSidechainEntriesWhenCollecting(t *testing.T) {
	path := writeTranscript(t, t.TempDir(),
		`{"type":"user","isSidechain":true,"message":{"role":"user","content":"subagent internal prompt"}}`,
		`{"type":"assistant","isSidechain":true,"message":{"role":"assistant","content":[{"type":"text","text":"subagent internal reply"}]}}`,
		`{"type":"user","message":{"role":"user","content":"the real prompt"}}`,
	)
	d, err := BuildFromTranscript(path, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(d.UserPrompts) != 1 || d.UserPrompts[0] != "the real prompt" {
		t.Errorf("UserPrompts = %#v, want only main-chain prompts", d.UserPrompts)
	}
	if d.FinalAssistantText != "" {
		t.Errorf("FinalAssistantText = %q, want sidechain text ignored", d.FinalAssistantText)
	}
}

func TestDigestShouldRecordSessionSpanFromEntryTimestamps(t *testing.T) {
	path := writeTranscript(t, t.TempDir(),
		`{"type":"user","timestamp":"2026-07-31T21:14:04.155Z","sessionId":"sess-1","gitBranch":"main","cwd":"/repo","message":{"role":"user","content":"start"}}`,
		`{"type":"assistant","timestamp":"2026-07-31T21:40:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"end"}]}}`,
	)
	d, err := BuildFromTranscript(path, "")
	if err != nil {
		t.Fatal(err)
	}
	if d.StartedAt != "2026-07-31T21:14:04.155Z" || d.EndedAt != "2026-07-31T21:40:00.000Z" {
		t.Errorf("span = %q..%q", d.StartedAt, d.EndedAt)
	}
	if d.SessionID != "sess-1" || d.GitBranch != "main" || d.ProjectDir != "/repo" {
		t.Errorf("identity = %q %q %q", d.SessionID, d.GitBranch, d.ProjectDir)
	}
}

func TestDigestShouldMarkSessionsWithNoSignalAsThin(t *testing.T) {
	thin := Digest{FinalAssistantText: "hello"}
	if !thin.Thin() {
		t.Error("digest with only assistant text should be thin")
	}
	solid := Digest{UserPrompts: []string{"do the thing"}}
	if solid.Thin() {
		t.Error("digest with a user prompt should not be thin")
	}
}

func TestFindSessionsShouldLocateTranscriptsAndSubagentDirs(t *testing.T) {
	projects := t.TempDir()
	slugDir := filepath.Join(projects, "-home-user-repo")
	if err := os.MkdirAll(filepath.Join(slugDir, "sess-1", "subagents"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(slugDir, "sess-1.jsonl"), []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(slugDir, "notes.txt"), []byte("skip me"), 0o644); err != nil {
		t.Fatal(err)
	}
	refs, err := FindSessions(projects)
	if err != nil {
		t.Fatal(err)
	}
	if len(refs) != 1 {
		t.Fatalf("refs = %#v, want exactly the one transcript", refs)
	}
	ref := refs[0]
	if ref.ProjectSlug != "-home-user-repo" || ref.SessionID != "sess-1" {
		t.Errorf("ref identity = %q %q", ref.ProjectSlug, ref.SessionID)
	}
	if ref.SubagentsDir != filepath.Join(slugDir, "sess-1", "subagents") {
		t.Errorf("SubagentsDir = %q", ref.SubagentsDir)
	}
}

func TestSlugForShouldMatchClaudeCodeProjectDirEncoding(t *testing.T) {
	if got := SlugFor("/home/tjmisko/.claude"); got != "-home-tjmisko--claude" {
		t.Errorf("SlugFor = %q, want -home-tjmisko--claude", got)
	}
}
