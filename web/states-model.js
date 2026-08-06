"use strict";

// states-model.js — the writer-state model: the table, and the two pure
// functions over it. DOM-free, same split as model.js/app.js — the browser
// takes it as globals (states.js), the node suite takes it by require
// (states.test.js).
//
// The TRANSITIONS table below is TRANSCRIBED FROM THE SPEC, not authored here:
// it is generated from Switchboard's `docs/writer-state-model.md`, which is
// itself generated from `internal/writerstate/state.go` by
// `go generate ./internal/writerstate`. If the model changes, regenerate that
// doc and re-derive this file rather than editing cells by hand — a page that
// teaches a state machine the daemon no longer runs is worse than no page.
//
// `applyEvidence` and `fold` mirror `Apply` and `Fold` from that package,
// branch for branch. states.test.js is what keeps them honest: it re-derives
// the properties the Go suite asserts (totality, the single door into Blocked,
// the fold's priority and tie-break) from this table rather than trusting the
// transcription.
//
// The prose (STATES, EVIDENCE, LADDER) IS authored here: the spec argues to a
// reader who already knows the system, and this page's job is the ramp up to
// that reader. The two must agree on facts; they deliberately differ in voice.

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api; // node test
  } else {
    Object.assign(root, api); // browser: expose as globals for states.js
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {

// ---------------------------------------------------------------------------
// states
//
// `folds` is the fold branch a writer in this state contributes to, which is
// what makes the state visible on your bar. It is a contribution, not a result:
// only Blocked and the two active states decide a color on their own (see
// LADDER, and the sandbox in §5).
// ---------------------------------------------------------------------------
const STATES = [
  {
    id: "Unknown",
    folds: "gray",
    group: "no idea",
    short: "Nothing has been observed about this writer yet.",
    body:
      "Distinct from Ended: “I don't know” and “it finished” are different claims, and a " +
      "confident wrong guess is its own class of bug.",
    you: "Wait a tick.",
  },
  {
    id: "Working",
    folds: "green",
    group: "busy",
    short: "A turn is in flight and no tool is outstanding.",
    body: "The writer is producing tokens. The ordinary shape of work happening.",
    you: "Nothing.",
  },
  {
    id: "ToolInFlight",
    folds: "green",
    group: "busy",
    short: "A tool was dispatched and its result has not come back.",
    body: "Split out of Working only because its on-disk signature is Blocked's. See the twins below.",
    you: "Nothing. The wait is machine-side.",
    twin: true,
  },
  {
    id: "Blocked",
    folds: "red",
    group: "wants you",
    short: "A dispatched tool is gated on a human decision.",
    body: "The only state a notification alone can establish, and the only one that folds to red.",
    you: "Answer it. That writer is stopped until you do.",
    twin: true,
  },
  {
    id: "Ended",
    folds: "orange",
    group: "done",
    short: "The turn finished — Stop fired, or the writer drained.",
    body: "Work stopped on its own terms. Nothing is stuck and nothing is running.",
    you: "Your move, when you can.",
  },
  {
    id: "Interrupted",
    folds: "orange",
    group: "done",
    short: "You stopped the turn, or a prompt was declined.",
    body:
      "Folds the same as Ended; the distinction is forensic. It separates a decline from an " +
      "approve, which are otherwise indistinguishable.",
    you: "Your move, when you can.",
  },
  {
    id: "Dead",
    folds: "hidden",
    group: "gone",
    short: "The writer no longer exists.",
    body: "Absorbing. Anything that looks like its return is a new writer under a new key.",
    you: "Nothing.",
  },
];

// ---------------------------------------------------------------------------
// evidence
//
// Grouped by source, because the source is what BOUNDS what a kind can prove.
// `proves` / `cannot` are the honest pair: every kind here is believed exactly
// as far as its second line allows.
// ---------------------------------------------------------------------------
// Named for what a source IS, not for how Claude supplies it: the shape is the
// adapter contract, and `claude` is what today's one instantiation happens to
// use. A provider that cannot supply the notification source can never paint
// red — the evidence kinds keep their shipped names because those are the
// strings a contributor greps for in the daemon's log lines.
const SOURCES = [
  {
    id: "hook",
    label: "notification",
    badge: "notify",
    tag: "the agent tells us",
    claude: "hooks — Claude and Codex both",
    strength: "Authoritative, and it names the writer it belongs to.",
    weakness: "Edge-triggered: fires once and never repeats. A lost one is lost.",
  },
  {
    id: "transcript",
    label: "the agent's log",
    badge: "log",
    tag: "we read what the writer wrote",
    claude: "Claude's transcript tail; Codex's rollout file",
    strength: "Level-triggered: re-readable on every tick, and survives a restart.",
    weakness: "Ambiguous by construction — the same bytes fit more than one state.",
  },
  {
    id: "clock/liveness",
    label: "clock · liveness",
    badge: "clock",
    tag: "time passed, or the process is gone",
    claude: "pid state and file mtimes",
    strength: "Cannot be wrong about absence.",
    weakness: "Proves only that something stopped happening.",
  },
];

const EVIDENCE = [
  {
    id: "UserPromptSubmit", src: "hook",
    gloss: "You submitted a turn to this writer.",
  },
  {
    id: "PermissionRequest", src: "hook", key: true,
    gloss: "A tool needs your approval. The only evidence that can establish Blocked, and it never repeats.",
  },
  {
    id: "ToolMatched", src: "hook",
    gloss:
      "A tool came back and correlates to this writer's own pending prompt: same writer, same " +
      "tool, input hashes agreeing or absent on both sides.",
  },
  {
    id: "ToolUncorrelated", src: "hook",
    gloss:
      "A different tool of this writer's came back. Agents dispatch in parallel, so a blocked " +
      "writer completing a sibling is routine. Must never resolve a prompt.",
  },
  { id: "Stop", src: "hook", gloss: "This writer's turn ended." },
  {
    id: "TailActivity", src: "transcript",
    gloss:
      "The writer wrote something — but not what. A blocked turn keeps emitting for seconds " +
      "after its prompt.",
  },
  {
    id: "TailAllMatched", src: "transcript", key: true,
    gloss:
      "Every dispatched tool has a result. The only predicate strong enough to prove a gate opened.",
  },
  {
    id: "TailUnmatched", src: "transcript",
    gloss:
      "A dispatched tool has no result. The shared signature — fits ToolInFlight and Blocked " +
      "alike, so it may never move a writer into or out of Blocked.",
  },
  { id: "TailInterrupt", src: "transcript", gloss: "An interrupt notice in the writer's own file." },
  {
    id: "TailUnreadable", src: "transcript",
    gloss: "The log cannot answer: missing, truncated, or a tail window that missed the dispatch. Fails closed.",
  },
  {
    id: "QuiescentPastCap", src: "clock/liveness",
    gloss: "Silent past its cap. The backstop that stops a crashed subagent's prompt latching red forever.",
  },
  { id: "Gone", src: "clock/liveness", universal: "Dead", gloss: "Proof the writer no longer exists." },
  {
    id: "SessionRotated", src: "clock/liveness", universal: "Unknown",
    gloss: "A context reset or fork changed the session id under the same pid, retiring every prompt recorded against it.",
  },
];

// ---------------------------------------------------------------------------
// the fold ladder — layer 3, priority order, first match wins
// ---------------------------------------------------------------------------
const LADDER = [
  { rule: "case1-gone", cond: "liveness is gone", color: "hidden", say: "no chip at all" },
  { rule: "case2-suspended", cond: "liveness is suspended", color: "suspended", say: "you paused this yourself" },
  { rule: "fold-blocked", cond: "ANY writer is Blocked", color: "red", say: "a decision of yours is blocking work" },
  { rule: "fold-active", cond: "ANY writer is Working or ToolInFlight", color: "green", say: "work is happening — leave it" },
  { rule: "case13-unknown", cond: "EVERY writer is Unknown, or there are none", color: "gray", say: "nothing observed yet" },
  { rule: "fold-quiet", cond: "otherwise", color: "orange", say: "stopped; wants a new prompt" },
];

// How a fold color shows up on the timeline you were just looking at. The
// dashboard's lane vocabulary predates this model and is not going to be
// renamed, so the mapping is the page's job.
// These are the status names in docs/provider-contract.md, which is what every
// provider emits — so the glosses are written in plain terms rather than in
// writer-state vocabulary. This is the first thing on the page; the reader has
// not met a "writer" yet.
const LANE_MAP = [
  { color: "green", lane: "working", note: "The session is producing." },
  { color: "green", lane: "dormant", note: "It handed off. The subagent bar underneath carries the work.", badge: "delegating" },
  { color: "orange", lane: "idle", note: "Alive, waiting on a prompt from you." },
  { color: "red", lane: "permission", note: "Waiting on your approval. The only status asking you for anything." },
  { color: "suspended", lane: "suspended", note: "You paused the process (Ctrl-Z)." },
  { color: "gray", lane: "unknown", note: "Nothing observed. Drawn as an empty lane." },
];

// ---------------------------------------------------------------------------
// TRANSITIONS — [from, evidence, to, isHold, why, shippedRuleId]
// Generated. See the file header.
// ---------------------------------------------------------------------------
const TRANSITIONS = [
  ["Unknown", "UserPromptSubmit", "Working", 0, "the user submitted a turn", "hook edge"],
  ["Unknown", "PermissionRequest", "Blocked", 0, "the only evidence that establishes Blocked", "hook edge"],
  ["Unknown", "ToolMatched", "Working", 0, "a tool completed, so the writer is live", "hook edge"],
  ["Unknown", "ToolUncorrelated", "Working", 0, "a tool completed, so the writer is live", "hook edge"],
  ["Unknown", "Stop", "Ended", 0, "the turn ended", "hook edge"],
  ["Unknown", "TailActivity", "Working", 0, "the writer's own file grew", "resume-activity"],
  ["Unknown", "TailAllMatched", "Unknown", 1, "proves only that no tool is outstanding — silent on whether a turn is running", ""],
  ["Unknown", "TailUnmatched", "ToolInFlight", 0, "a tool is dispatched and unreturned", ""],
  ["Unknown", "TailInterrupt", "Interrupted", 0, "the user stopped the turn", "case6-interrupt"],
  ["Unknown", "TailUnreadable", "Unknown", 1, "no information; fail closed", ""],
  ["Unknown", "QuiescentPastCap", "Unknown", 1, "already the least committal state", ""],
  ["Working", "UserPromptSubmit", "Working", 1, "already working", "hook edge"],
  ["Working", "PermissionRequest", "Blocked", 0, "a dispatched tool is gated on the user", "hook edge"],
  ["Working", "ToolMatched", "Working", 1, "a tool completed and the turn continues", "hook edge"],
  ["Working", "ToolUncorrelated", "Working", 1, "a tool completed and the turn continues", "hook edge"],
  ["Working", "Stop", "Ended", 0, "the turn ended", "hook edge"],
  ["Working", "TailActivity", "Working", 1, "still producing", "resume-activity"],
  ["Working", "TailAllMatched", "Working", 1, "no tool outstanding; the turn continues", ""],
  ["Working", "TailUnmatched", "ToolInFlight", 0, "a tool is dispatched and unreturned", ""],
  ["Working", "TailInterrupt", "Interrupted", 0, "the user stopped the turn", "case6-interrupt"],
  ["Working", "TailUnreadable", "Working", 1, "no information; fail closed", ""],
  ["Working", "QuiescentPastCap", "Ended", 0, "a writer silent past the cap is not working any more", "case6-idle-title"],
  ["ToolInFlight", "UserPromptSubmit", "Working", 0, "a new turn supersedes the outstanding call", "hook edge"],
  ["ToolInFlight", "PermissionRequest", "Blocked", 0, "the gate is discovered after dispatch — the hook can trail the tool_use", "hook edge"],
  ["ToolInFlight", "ToolMatched", "Working", 0, "the outstanding call returned", "hook edge"],
  ["ToolInFlight", "ToolUncorrelated", "ToolInFlight", 1, "one tool returned, but parallel dispatch means others may remain; the tail decides", "hook edge"],
  ["ToolInFlight", "Stop", "Ended", 0, "the turn ended", "hook edge"],
  ["ToolInFlight", "TailActivity", "ToolInFlight", 1, "content grew, but the dispatched call is still out", ""],
  ["ToolInFlight", "TailAllMatched", "Working", 0, "every dispatched call returned", ""],
  ["ToolInFlight", "TailUnmatched", "ToolInFlight", 1, "still waiting on a call", ""],
  ["ToolInFlight", "TailInterrupt", "Interrupted", 0, "the user stopped the turn", "case6-interrupt"],
  ["ToolInFlight", "TailUnreadable", "ToolInFlight", 1, "no information; fail closed", ""],
  ["ToolInFlight", "QuiescentPastCap", "Ended", 0, "a call outstanding past the cap is abandoned, not running", ""],
  ["Blocked", "UserPromptSubmit", "Blocked", 1, "typing is not answering — queueing a message while a prompt waits is routine (plan Q6)", "case12-hold-nontool-event"],
  ["Blocked", "PermissionRequest", "Blocked", 1, "a second prompt for the same writer; still blocked", ""],
  ["Blocked", "ToolMatched", "Working", 0, "the approved call itself completed — the hook-speed approve path", "case9-approve-toolmatch"],
  ["Blocked", "ToolUncorrelated", "Blocked", 1, "a sibling or differing call is not this prompt; parallel dispatch makes this routine", "case12-hold-bare-result / case12-hold-teammate-collision / case12-hold-input-mismatch"],
  ["Blocked", "Stop", "Blocked", 1, "the turn ending says nothing about the prompt (defect 5)", "case12-hold-nontool-event"],
  ["Blocked", "TailActivity", "Blocked", 1, "activity does not distinguish Blocked from ToolInFlight — the prompt's OWN turn produces it", ""],
  ["Blocked", "TailAllMatched", "Working", 0, "the sound predicate: every dispatched call returned, so the gate opened", "case9-approve-resume"],
  ["Blocked", "TailUnmatched", "Blocked", 1, "the shared signature — consistent with Blocked, so it proves nothing and must not move", ""],
  ["Blocked", "TailInterrupt", "Interrupted", 0, "the prompt was declined or the turn interrupted", "case10-decline-idle / case11-decline-delegating"],
  ["Blocked", "TailUnreadable", "Blocked", 1, "no information; fail closed and let the cap bound it", "case15-ttl-backstop"],
  ["Blocked", "QuiescentPastCap", "Ended", 0, "an unanswerable prompt must not latch red forever (case 19)", "case19-stale-writer-backstop"],
  ["Ended", "UserPromptSubmit", "Working", 0, "a new turn began", "hook edge"],
  ["Ended", "PermissionRequest", "Blocked", 0, "the writer woke and immediately gated", "hook edge"],
  ["Ended", "ToolMatched", "Working", 0, "the writer resumed and ran a tool", "hook edge"],
  ["Ended", "ToolUncorrelated", "Working", 0, "the writer resumed and ran a tool", "hook edge"],
  ["Ended", "Stop", "Ended", 1, "already ended", "hook edge"],
  ["Ended", "TailActivity", "Working", 0, "the writer resumed", "resume-activity"],
  ["Ended", "TailAllMatched", "Ended", 1, "no tool outstanding, consistent with a finished turn", ""],
  ["Ended", "TailUnmatched", "ToolInFlight", 0, "the writer resumed and dispatched", "resume-activity"],
  ["Ended", "TailInterrupt", "Interrupted", 0, "record the stop kind; folds identically", "case6-interrupt"],
  ["Ended", "TailUnreadable", "Ended", 1, "no information; fail closed", ""],
  ["Ended", "QuiescentPastCap", "Ended", 1, "already terminal for color purposes", ""],
  ["Interrupted", "UserPromptSubmit", "Working", 0, "a new turn began", "hook edge"],
  ["Interrupted", "PermissionRequest", "Blocked", 0, "the writer woke and immediately gated", "hook edge"],
  ["Interrupted", "ToolMatched", "Working", 0, "the writer resumed and ran a tool", "hook edge"],
  ["Interrupted", "ToolUncorrelated", "Working", 0, "the writer resumed and ran a tool", "hook edge"],
  ["Interrupted", "Stop", "Ended", 0, "the interrupted turn closed out", "hook edge"],
  ["Interrupted", "TailActivity", "Working", 0, "the writer resumed", "resume-activity"],
  ["Interrupted", "TailAllMatched", "Interrupted", 1, "no tool outstanding, consistent with a stopped turn", ""],
  ["Interrupted", "TailUnmatched", "ToolInFlight", 0, "the writer resumed and dispatched", "resume-activity"],
  ["Interrupted", "TailInterrupt", "Interrupted", 1, "already interrupted", "case6-interrupt"],
  ["Interrupted", "TailUnreadable", "Interrupted", 1, "no information; fail closed", ""],
  ["Interrupted", "QuiescentPastCap", "Interrupted", 1, "already terminal for color purposes", ""],
];

// Cells where the SHIPPED daemon does something different from the model above.
// These are defects, not design choices, and the page marks them in the matrix
// rather than letting them read as ordinary rows.
const DIVERGENCES = [
  {
    from: "Working", ev: "QuiescentPastCap", to: "Ended", shipped: "case6-idle-title",
    note:
      "The shipped demotion reads the session's terminal-pane title, which cannot be attributed " +
      "to a writer: with a subagent live it demotes on the parent's idle glyph regardless of " +
      "which writer went quiet.",
  },
  {
    from: "Blocked", ev: "TailAllMatched", to: "Working", shipped: "case9-approve-resume",
    note:
      "The shipped rule fires on any assistant line dated after the prompt rather than on " +
      "all-matched, so a parallel auto-approved sibling's line drops the red on the next tick. " +
      "Reproduced against the 2026-08-05 transcript: cleared at age 5s, prompt unanswered for a " +
      "further 3m07s.",
  },
];

// State changes the model defines that no shipped rule implements. All four are
// ToolInFlight cells, which is the finding: the daemon has no representation of
// that state at all, which is exactly why it cannot tell Blocked from a tool
// that is merely running.
const GAPS = [
  { from: "Unknown", ev: "TailUnmatched", to: "ToolInFlight", why: "a tool is dispatched and unreturned" },
  { from: "Working", ev: "TailUnmatched", to: "ToolInFlight", why: "a tool is dispatched and unreturned" },
  { from: "ToolInFlight", ev: "TailAllMatched", to: "Working", why: "every dispatched call returned" },
  { from: "ToolInFlight", ev: "QuiescentPastCap", to: "Ended", why: "a call outstanding past the cap is abandoned, not running" },
];

// ---------------------------------------------------------------------------
// derived indexes
// ---------------------------------------------------------------------------

// The live states and evidence kinds, in the order the diagram and the matrix
// both walk them. Dead is absent from the row set because it is absorbing and
// reached only by a universal rule; Gone and SessionRotated are absent from the
// column set for the same reason — a column of six identical cells teaches
// nothing the rule strip above it does not.
const LIVE_STATES = STATES.filter((s) => s.id !== "Dead").map((s) => s.id);
const LIVE_EVIDENCE = EVIDENCE.filter((e) => !e.universal);

// The tuples above, as records — so no consumer has to know the table is
// stored positionally — plus a (from, evidence) index for O(1) lookup.
const ROWS = TRANSITIONS.map(([from, ev, to, hold, why, shipped]) => ({
  from, ev, to, hold: !!hold, why, shipped,
}));
const TBL = new Map(ROWS.map((r) => [r.from + "|" + r.ev, r]));

function transitionFor(from, ev) { return TBL.get(from + "|" + ev); }
function divergenceFor(from, ev) { return DIVERGENCES.find((d) => d.from === from && d.ev === ev); }
function gapFor(from, ev) { return GAPS.find((g) => g.from === from && g.ev === ev); }

// applyEvidence is the per-writer transition function, mirroring
// writerstate.Apply: three universal rules first, then the table. Total by
// construction — an unlisted cell throws rather than guessing, because a
// missing cell is exactly the class of gap this model exists to make
// impossible.
function applyEvidence(state, ev) {
  if (state === "Dead") {
    return { to: "Dead", hold: true, why: "a gone writer never returns; a new writer gets a new key" };
  }
  if (ev === "Gone") {
    return { to: "Dead", hold: false, why: "the writer no longer exists" };
  }
  if (ev === "SessionRotated") {
    return {
      to: "Unknown", hold: state === "Unknown",
      why: "a /clear or fork retires every prompt recorded under the old session id",
    };
  }
  const t = transitionFor(state, ev);
  if (!t) throw new Error(`states-model: no transition for (${state}, ${ev})`);
  return t;
}

// fold maps the session's belief onto a chip color, mirroring writerstate.Fold:
// pure, total, and with no memory. The keys are sorted so the writer NAMED as
// the reason is the same one on every tick — a verdict that permutes between
// ticks is unreadable and undiffable.
function fold(writers, live) {
  if (live === "gone") return { color: "hidden", rule: "case1-gone" };
  if (live === "suspended") return { color: "suspended", rule: "case2-suspended" };

  const keys = Object.keys(writers).sort();

  for (const k of keys) {
    if (writers[k] === "Blocked") return { color: "red", rule: "fold-blocked", writer: k };
  }
  for (const k of keys) {
    if (writers[k] === "Working" || writers[k] === "ToolInFlight") {
      return { color: "green", rule: "fold-active", writer: k, delegating: delegating(writers, k) };
    }
  }
  // Every writer Unknown — or no writers at all — is "we have no idea", which
  // is its own color. Guessing working or idle here is the confident-wrong-
  // guess error the model names as its own class.
  if (keys.every((k) => writers[k] === "Unknown")) return { color: "gray", rule: "case13-unknown" };
  return { color: "orange", rule: "fold-quiet" };
}

// delegating reports the shape where the writer carrying the green is a
// teammate while the main thread ("" by convention) has finished. Purely a
// rendering hint — the fold already returns green for it without a special case.
function delegating(writers, active) {
  if (active === "") return false;
  const main = writers[""];
  if (main === undefined) return true;
  return main !== "Working" && main !== "ToolInFlight";
}

  return {
    STATES, SOURCES, EVIDENCE, LADDER, LANE_MAP,
    TRANSITIONS, ROWS, DIVERGENCES, GAPS,
    LIVE_STATES, LIVE_EVIDENCE,
    transitionFor, divergenceFor, gapFor, applyEvidence, fold, delegating,
  };
});
