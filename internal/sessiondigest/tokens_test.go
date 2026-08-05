package sessiondigest

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// assistantRecord builds one assistant transcript line. Callers vary msgID to
// say whether two lines are the same API response written twice (the shape
// TestTokens...ContentBlock covers) or two distinct responses; extra carries
// any additional top-level fields, e.g. `,"isSidechain":true`.
func assistantRecord(msgID, model, extra string, in, cacheCreate, cacheRead, out int) string {
	return fmt.Sprintf(`{"type":"assistant"%s,"requestId":"req_%s","message":{"id":"%s","model":"%s",`+
		`"role":"assistant","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":%d,`+
		`"cache_creation_input_tokens":%d,"cache_read_input_tokens":%d,"output_tokens":%d,`+
		`"cache_creation":{"ephemeral_1h_input_tokens":%d,"ephemeral_5m_input_tokens":0}}}}`,
		extra, msgID, msgID, model, in, cacheCreate, cacheRead, out, cacheCreate)
}

func TestTokensShouldCountOneResponseWhenItSpansSeveralContentBlockRecords(t *testing.T) {
	// One API response, four records — the shape Claude Code actually writes for
	// a turn with a text block and three tool_use blocks. Every line repeats the
	// identical usage; summing them all would inflate this session fourfold.
	line := assistantRecord("msg_same", "claude-opus-5", "", 2, 14013, 20949, 359)
	path := writeTranscript(t, t.TempDir(), line, line, line, line)

	d, err := BuildFromTranscript(path, "")
	if err != nil {
		t.Fatal(err)
	}
	if d.Tokens == nil {
		t.Fatal("Tokens = nil, want the session's spend")
	}
	got := d.Tokens.Main
	if got.Responses != 1 {
		t.Errorf("Responses = %d, want 1 — records deduplicated on message.id", got.Responses)
	}
	if got.Output != 359 || got.InputFresh != 2 || got.CacheCreation != 14013 || got.CacheRead != 20949 {
		t.Errorf("counts = %#v, want each field counted exactly once", got)
	}
}

func TestTokensShouldSumInputComponentsSeparatelyRatherThanInputTokensAlone(t *testing.T) {
	path := writeTranscript(t, t.TempDir(),
		assistantRecord("msg_1", "claude-opus-5", "", 2, 1000, 0, 100),
		assistantRecord("msg_2", "claude-opus-5", "", 3, 500, 1000, 200),
	)
	d, err := BuildFromTranscript(path, "")
	if err != nil {
		t.Fatal(err)
	}
	got := d.Tokens.Main
	if got.InputFresh != 5 {
		t.Errorf("InputFresh = %d, want 5 — the uncached remainder only", got.InputFresh)
	}
	if got.CacheCreation != 1500 || got.CacheCreation1h != 1500 || got.CacheCreation5m != 0 {
		t.Errorf("cache creation = %#v, want the 1h/5m split preserved", got)
	}
	if got.CacheRead != 1000 {
		t.Errorf("CacheRead = %d, want 1000", got.CacheRead)
	}
	if got.Output != 300 {
		t.Errorf("Output = %d, want 300", got.Output)
	}
	// The three components exist so a reader can form billed input; that sum is
	// three orders of magnitude off InputFresh, which is the whole point.
	if billed := got.InputFresh + got.CacheCreation + got.CacheRead; billed != 2505 {
		t.Errorf("billed input = %d, want 2505", billed)
	}
}

func TestTokensShouldReportPeakTurnInputAsTheLargestTurnNotTheTotal(t *testing.T) {
	path := writeTranscript(t, t.TempDir(),
		assistantRecord("msg_1", "claude-opus-5", "", 2, 10_000, 0, 50),     // turn = 10,002
		assistantRecord("msg_2", "claude-opus-5", "", 2, 5_000, 30_000, 50), // turn = 35,002 ← peak
		assistantRecord("msg_3", "claude-opus-5", "", 2, 0, 20_000, 50),     // turn = 20,002
	)
	d, err := BuildFromTranscript(path, "")
	if err != nil {
		t.Fatal(err)
	}
	if got := d.Tokens.Main.PeakTurnInput; got != 35_002 {
		t.Errorf("PeakTurnInput = %d, want 35002 — the largest single turn", got)
	}
}

func TestTokensShouldBucketPerModelWhenASessionSpansSeveralModels(t *testing.T) {
	path := writeTranscript(t, t.TempDir(),
		assistantRecord("msg_1", "claude-opus-5", "", 1, 100, 0, 10),
		assistantRecord("msg_2", "claude-fable-5", "", 1, 200, 0, 20),
		assistantRecord("msg_3", "claude-opus-5", "", 1, 300, 0, 30),
	)
	d, err := BuildFromTranscript(path, "")
	if err != nil {
		t.Fatal(err)
	}
	byModel := d.Tokens.ByModel
	if len(byModel) != 2 {
		t.Fatalf("ByModel = %#v, want one bucket per model", byModel)
	}
	if opus := byModel["claude-opus-5"]; opus.Responses != 2 || opus.Output != 40 || opus.CacheCreation != 400 {
		t.Errorf("opus bucket = %#v", opus)
	}
	if fable := byModel["claude-fable-5"]; fable.Responses != 1 || fable.Output != 20 {
		t.Errorf("fable bucket = %#v", fable)
	}
}

func TestTokensShouldKeepSidechainSpendOutOfTheMainBucketWhileStillCountingIt(t *testing.T) {
	path := writeTranscript(t, t.TempDir(),
		assistantRecord("msg_1", "claude-opus-5", "", 1, 100, 0, 10),
		assistantRecord("msg_2", "claude-haiku-4-5-20251001", `,"isSidechain":true`, 1, 700, 0, 70),
	)
	d, err := BuildFromTranscript(path, "")
	if err != nil {
		t.Fatal(err)
	}
	if d.Tokens.Main.Output != 10 || d.Tokens.Main.Responses != 1 {
		t.Errorf("Main = %#v, want only the session's own turn", d.Tokens.Main)
	}
	if d.Tokens.Sidechain == nil {
		t.Fatal("Sidechain = nil, want the delegated turn counted")
	}
	if d.Tokens.Sidechain.Output != 70 {
		t.Errorf("Sidechain.Output = %d, want 70", d.Tokens.Sidechain.Output)
	}
	// The two splits partition the same responses, so they must reconcile.
	var byModelOutput int
	for _, bucket := range d.Tokens.ByModel {
		byModelOutput += bucket.Output
	}
	if byModelOutput != d.Tokens.Main.Output+d.Tokens.Sidechain.Output {
		t.Errorf("ByModel sums to %d, want main+sidechain = %d", byModelOutput,
			d.Tokens.Main.Output+d.Tokens.Sidechain.Output)
	}
}

func TestTokensShouldCountDelegatedSpendFromSubagentTranscriptFiles(t *testing.T) {
	// Current releases write a subagent's turns to its own agent-*.jsonl beside
	// the roster metadata, not into the parent transcript. Nothing else reads
	// those files, so without this the session omits every delegated token.
	dir := t.TempDir()
	path := writeTranscript(t, dir,
		assistantRecord("msg_parent", "claude-opus-5", "", 1, 100, 0, 10),
	)
	subagents := filepath.Join(dir, "11111111-2222-3333-4444-555555555555", "subagents")
	if err := os.MkdirAll(subagents, 0o755); err != nil {
		t.Fatal(err)
	}
	agent := assistantRecord("msg_agent", "claude-haiku-4-5-20251001", `,"isSidechain":true`, 1, 700, 0, 70)
	if err := os.WriteFile(filepath.Join(subagents, "agent-aexplore-1.jsonl"), []byte(agent+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	d, err := BuildFromTranscript(path, subagents)
	if err != nil {
		t.Fatal(err)
	}
	if d.Tokens.Main.Output != 10 {
		t.Errorf("Main.Output = %d, want only the parent's own turn", d.Tokens.Main.Output)
	}
	if d.Tokens.Sidechain == nil || d.Tokens.Sidechain.Output != 70 {
		t.Fatalf("Sidechain = %#v, want the subagent file's spend", d.Tokens.Sidechain)
	}
	if _, ok := d.Tokens.ByModel["claude-haiku-4-5-20251001"]; !ok {
		t.Errorf("ByModel = %#v, want the subagent's model priced separately", d.Tokens.ByModel)
	}
}

func TestTokensShouldCountADelegatedTurnOnceWhenItAppearsInBothTheParentAndTheSubagentFile(t *testing.T) {
	// Belt and braces for a release that inlines subagent turns AND writes the
	// sibling file: the dedupe set spans both, so the response is counted once.
	dir := t.TempDir()
	agent := assistantRecord("msg_agent", "claude-haiku-4-5-20251001", `,"isSidechain":true`, 1, 700, 0, 70)
	path := writeTranscript(t, dir,
		assistantRecord("msg_parent", "claude-opus-5", "", 1, 100, 0, 10),
		agent,
	)
	subagents := filepath.Join(dir, "11111111-2222-3333-4444-555555555555", "subagents")
	if err := os.MkdirAll(subagents, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(subagents, "agent-aexplore-1.jsonl"), []byte(agent+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	d, err := BuildFromTranscript(path, subagents)
	if err != nil {
		t.Fatal(err)
	}
	if d.Tokens.Sidechain.Responses != 1 || d.Tokens.Sidechain.Output != 70 {
		t.Errorf("Sidechain = %#v, want the shared turn counted exactly once", d.Tokens.Sidechain)
	}
}

func TestTokensShouldOmitSidechainWhenTheSessionDelegatedNothing(t *testing.T) {
	path := writeTranscript(t, t.TempDir(),
		assistantRecord("msg_1", "claude-opus-5", "", 1, 100, 0, 10),
	)
	d, err := BuildFromTranscript(path, "")
	if err != nil {
		t.Fatal(err)
	}
	if d.Tokens.Sidechain != nil {
		t.Errorf("Sidechain = %#v, want nil when nothing was delegated", d.Tokens.Sidechain)
	}
}

func TestTokensShouldSkipSyntheticModelRecords(t *testing.T) {
	path := writeTranscript(t, t.TempDir(),
		assistantRecord("msg_1", "claude-opus-5", "", 1, 100, 0, 10),
		assistantRecord("msg_2", "<synthetic>", "", 0, 0, 0, 0),
	)
	d, err := BuildFromTranscript(path, "")
	if err != nil {
		t.Fatal(err)
	}
	if d.Tokens.Main.Responses != 1 {
		t.Errorf("Responses = %d, want the client-injected record skipped", d.Tokens.Main.Responses)
	}
	if _, ok := d.Tokens.ByModel[syntheticModel]; ok {
		t.Error("ByModel carries a <synthetic> bucket, want it skipped")
	}
}

func TestTokensShouldBeNilWhenTranscriptHasNoAssistantRecords(t *testing.T) {
	path := writeTranscript(t, t.TempDir(),
		`{"type":"user","message":{"role":"user","content":"just a prompt"}}`,
	)
	d, err := BuildFromTranscript(path, "")
	if err != nil {
		t.Fatal(err)
	}
	if d.Tokens != nil {
		t.Errorf("Tokens = %#v, want nil so it reads as \"never measured\"", d.Tokens)
	}
}

func TestTokensShouldFallBackToRequestIDWhenMessageIDIsAbsent(t *testing.T) {
	// Records without message.id must still deduplicate, or the content-block
	// overcount returns for any release that drops the field.
	line := `{"type":"assistant","requestId":"req_abc","message":{"model":"claude-opus-5","role":"assistant",` +
		`"content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":2,"output_tokens":50}}}`
	path := writeTranscript(t, t.TempDir(), line, line)
	d, err := BuildFromTranscript(path, "")
	if err != nil {
		t.Fatal(err)
	}
	if d.Tokens.Main.Responses != 1 || d.Tokens.Main.Output != 50 {
		t.Errorf("Main = %#v, want one response deduplicated on requestId", d.Tokens.Main)
	}
}

func TestTokensShouldNotChangeTheDigestHashWhenOnlyCountsDiffer(t *testing.T) {
	// The hash decides whether a record is re-condensed. Token counts are not
	// prompt-visible, so a backfill that adds them must cost zero `claude -p`
	// calls — otherwise the first run re-summarizes the entire archive.
	base := Digest{
		Title:       "same session",
		UserPrompts: []string{"do the thing"},
	}
	withTokens := base
	withTokens.Tokens = &TokenUsage{Main: TokenCounts{Responses: 12, Output: 5000, CacheRead: 1 << 20}}
	if HashDigest(base) != HashDigest(withTokens) {
		t.Error("adding token counts changed the digest hash — a plain -condense run would re-summarize every record")
	}
}
