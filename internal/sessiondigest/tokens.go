package sessiondigest

import (
	"os"
	"path/filepath"
	"strings"
)

// Token accounting for a session, summed from the message.usage block every
// assistant record carries. This is pure extraction from data already on disk:
// no API call, no estimate, and — because token counts are not prompt-visible —
// no re-condense when they are backfilled. See Digest.Tokens.

// syntheticModel marks records the client injected rather than the API
// returning them (an API-error placeholder, say). They carry no real spend.
const syntheticModel = "<synthetic>"

// TokenCounts is one bucket of token spend. The three input components are kept
// separate rather than pre-summed because they answer different questions and
// cost wildly different amounts — a cache read is roughly a tenth the price of
// a fresh input token, and it dominates the raw total on any long session, so
// one undifferentiated "input" figure is actively misleading.
//
// Two aggregations are worth forming from these:
//
//   - billed input — InputFresh + CacheCreation + CacheRead, summed over turns.
//     Correct for cost, because every turn genuinely resends the conversation.
//   - peak context — PeakTurnInput, the largest single turn. Answers "how big
//     did this session get", which is usually what a reader means by "input".
type TokenCounts struct {
	Responses int `json:"responses"` // API responses, deduplicated on message.id
	// InputFresh is input_tokens: the UNCACHED REMAINDER of the prompt, not the
	// prompt. It is frequently literally 2. Never report it as "input".
	InputFresh      int `json:"inputFresh"`
	CacheCreation   int `json:"cacheCreation"`
	CacheCreation1h int `json:"cacheCreation1h,omitempty"`
	CacheCreation5m int `json:"cacheCreation5m,omitempty"`
	CacheRead       int `json:"cacheRead"`
	// Output is output_tokens, which INCLUDES thinking tokens. Thinking cannot
	// be broken out: the API's usage block has no field for it, and the thinking
	// text that would let it be estimated is not persisted (`thinking.display`
	// defaults to "omitted", leaving signature-only blocks with empty text). The
	// client does compute a running estimate from thinking_delta stream events,
	// but flags those messages ephemeral and the transcript writer skips them.
	// See README's "Session summaries" section.
	Output int `json:"output"`
	// PeakTurnInput is the largest turnInput seen in this bucket — the session's
	// high-water context mark, not a sum.
	PeakTurnInput int `json:"peakTurnInput"`
}

// add folds one API response's usage in. Callers must deduplicate first.
func (c *TokenCounts) add(u usage) {
	c.Responses++
	c.InputFresh += u.InputTokens
	c.CacheCreation += u.CacheCreationInputTokens
	c.CacheCreation1h += u.CacheCreation.Ephemeral1h
	c.CacheCreation5m += u.CacheCreation.Ephemeral5m
	c.CacheRead += u.CacheReadInputTokens
	c.Output += u.OutputTokens
	if turn := u.turnInput(); turn > c.PeakTurnInput {
		c.PeakTurnInput = turn
	}
}

// TokenUsage is a session's token spend, split two ways: by whether the spend
// was the session's own or a delegated subagent's, and by model.
//
// The two splits partition the same responses, so Main + Sidechain equals the
// sum over ByModel. A session that used one model still gets a ByModel entry —
// the caller needs the name to price it, and a session's total is not
// convertible to a cost figure without one, since sessions routinely span
// several models.
type TokenUsage struct {
	Main TokenCounts `json:"main"`
	// Sidechain is a pointer purely so it can be omitted: encoding/json's
	// omitempty does nothing for a struct value, and most sessions delegate
	// nothing. Nil means "no subagent spend", never "not measured".
	Sidechain *TokenCounts           `json:"sidechain,omitempty"`
	ByModel   map[string]TokenCounts `json:"byModel,omitempty"`
}

// tokenAccumulator sums usage across a transcript walk.
type tokenAccumulator struct {
	main      TokenCounts
	sidechain TokenCounts
	byModel   map[string]TokenCounts
	seen      map[string]struct{}
}

func newTokenAccumulator() *tokenAccumulator {
	return &tokenAccumulator{
		byModel: map[string]TokenCounts{},
		seen:    map[string]struct{}{},
	}
}

// add folds one transcript record in, ignoring everything that is not an
// assistant record carrying usage. delegated routes the spend to the sidechain
// bucket; callers walking the session's own transcript pass e.IsSidechain,
// while addSubagentTranscripts passes true unconditionally — those files hold
// nothing but delegated turns, so their bucket is not the flag's to decide.
//
// Deduplication is the whole point of the seen set: Claude Code writes one
// record per content block and repeats the identical usage on each, so a
// response with three tool_use blocks appears four times. On a real transcript
// that is a ~75% overcount. message.id is the key — it identifies the response
// itself — with requestId as the fallback for records that lack one. A record
// with neither is counted rather than dropped: a missing key means we cannot
// tell it apart from a sibling, and silently discarding real spend is the worse
// error of the two. The set spans every file a session contributes, so a
// release that goes back to inlining subagent turns cannot double-count them.
func (a *tokenAccumulator) add(e entry, delegated bool) {
	if e.Type != "assistant" || e.Message.Usage == nil || e.Message.Model == syntheticModel {
		return
	}
	key := e.Message.ID
	if key == "" {
		key = e.RequestID
	}
	if key != "" {
		if _, dup := a.seen[key]; dup {
			return
		}
		a.seen[key] = struct{}{}
	}

	u := *e.Message.Usage
	if delegated {
		a.sidechain.add(u)
	} else {
		a.main.add(u)
	}
	if model := e.Message.Model; model != "" {
		bucket := a.byModel[model]
		bucket.add(u)
		a.byModel[model] = bucket
	}
}

// addSubagentTranscripts folds in the delegated turns that current Claude Code
// releases write to their OWN files, as agent-*.jsonl siblings of the
// agent-*.meta.json roster under <session-id>/subagents/. Nothing else reads
// them: FindSessions walks only top-level <session-id>.jsonl transcripts, so
// without this a delegation-heavy session reports its orchestration turns and
// silently omits every token the subagents actually spent.
//
// Older releases inlined those same turns in the parent transcript flagged
// isSidechain, which the main walk already routes; both shapes therefore land
// in the sidechain bucket, and the shared dedupe set means a session recorded
// in both shapes is counted once. A missing or unreadable dir is the normal
// case for a session that delegated nothing, and yields nothing.
func (a *tokenAccumulator) addSubagentTranscripts(dir string) {
	if dir == "" {
		return
	}
	des, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, de := range des {
		if de.IsDir() || !strings.HasSuffix(de.Name(), ".jsonl") {
			continue
		}
		// A subagent transcript that fails mid-scan keeps whatever it yielded:
		// token counts are enrichment, never a reason to fail the whole digest.
		_ = scanEntries(filepath.Join(dir, de.Name()), func(e entry) { a.add(e, true) })
	}
}

// result is the accumulated spend, or nil when the transcript held no assistant
// records at all. Nil is meaningful: it is what distinguishes a session that
// predates this field — or never called the API — from one that spent zero.
func (a *tokenAccumulator) result() *TokenUsage {
	if a.main.Responses == 0 && a.sidechain.Responses == 0 {
		return nil
	}
	out := &TokenUsage{Main: a.main}
	if a.sidechain.Responses > 0 {
		sidechain := a.sidechain
		out.Sidechain = &sidechain
	}
	if len(a.byModel) > 0 {
		out.ByModel = a.byModel
	}
	return out
}
