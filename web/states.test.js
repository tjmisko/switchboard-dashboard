"use strict";

// Behavioral tests for the writer-state model the field guide teaches
// (states-model.js). Run with: node --test
//
// These are not decoration. The table in states-model.js is TRANSCRIBED from
// Switchboard's internal/writerstate, and a transcription that drifts is worse
// than no page — it would document a machine the daemon does not run. So these
// re-derive, from the transcribed table alone, the properties the Go suite
// asserts about the real one: totality, the single door into Blocked, what may
// leave it, and the fold's priority order and tie-break.

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  STATES, EVIDENCE, LADDER, LANE_MAP,
  ROWS, DIVERGENCES, GAPS, LIVE_STATES, LIVE_EVIDENCE,
  transitionFor, applyEvidence, fold,
} = require("./states-model.js");

// --- the table ------------------------------------------------------------

test("should define every live state x evidence cell when the table is walked", () => {
  for (const from of LIVE_STATES) {
    for (const e of LIVE_EVIDENCE) {
      const t = transitionFor(from, e.id);
      assert.ok(t, `missing cell (${from}, ${e.id})`);
      assert.equal(typeof t.why, "string");
      assert.notEqual(t.why, "", `cell (${from}, ${e.id}) has no reason`);
    }
  }
  assert.equal(ROWS.length, LIVE_STATES.length * LIVE_EVIDENCE.length);
  assert.equal(ROWS.length, 66);
});

test("should land on a declared state when any cell is applied", () => {
  const declared = new Set(STATES.map((s) => s.id));
  for (const r of ROWS) assert.ok(declared.has(r.to), `unknown destination ${r.to}`);
});

test("should mark a cell as a hold exactly when it does not move the writer", () => {
  for (const r of ROWS) assert.equal(r.hold, r.to === r.from, `${r.from} + ${r.ev}`);
});

test("should enter Blocked only on PermissionRequest, from every other live state", () => {
  const doors = ROWS.filter((r) => !r.hold && r.to === "Blocked");
  assert.deepEqual([...new Set(doors.map((r) => r.ev))], ["PermissionRequest"]);
  assert.deepEqual(
    doors.map((r) => r.from).sort(),
    LIVE_STATES.filter((s) => s !== "Blocked").sort()
  );
});

test("should leave Blocked only on sanctioned proof of resolution", () => {
  const exits = ROWS.filter((r) => r.from === "Blocked" && !r.hold);
  assert.deepEqual(
    exits.map((r) => r.ev).sort(),
    ["QuiescentPastCap", "TailAllMatched", "TailInterrupt", "ToolMatched"]
  );
});

test("should hold Blocked when evidence carries the twins' shared signature", () => {
  // TailUnmatched and TailActivity are consistent with ToolInFlight too, so
  // neither can distinguish "waiting on you" from "waiting on a machine".
  for (const ev of ["TailUnmatched", "TailActivity"]) {
    assert.equal(transitionFor("Blocked", ev).to, "Blocked", ev);
  }
});

test("should hold every state when the transcript is unreadable", () => {
  for (const from of LIVE_STATES) {
    assert.equal(transitionFor(from, "TailUnreadable").to, from, from);
  }
});

// --- the universal rules --------------------------------------------------

test("should send any writer to Dead when it is gone", () => {
  for (const s of STATES) assert.equal(applyEvidence(s.id, "Gone").to, "Dead", s.id);
});

test("should return every writer to Unknown when the session rotates", () => {
  for (const from of LIVE_STATES) {
    assert.equal(applyEvidence(from, "SessionRotated").to, "Unknown", from);
  }
});

test("should keep a Dead writer dead whatever evidence arrives", () => {
  for (const e of EVIDENCE) assert.equal(applyEvidence("Dead", e.id).to, "Dead", e.id);
});

test("should throw rather than guess when a cell does not exist", () => {
  assert.throws(() => applyEvidence("Working", "NoSuchEvidence"), /no transition/);
});

// --- the fold -------------------------------------------------------------

test("should hide the chip when the process is gone, whatever the writers say", () => {
  assert.equal(fold({ "": "Blocked" }, "gone").color, "hidden");
});

test("should grey the chip when the process is suspended, whatever the writers say", () => {
  assert.equal(fold({ "": "Working" }, "suspended").color, "suspended");
});

test("should go red when any writer is blocked, even while others work", () => {
  const v = fold({ "": "Working", "sub-1": "Blocked", "sub-2": "Working" }, "running");
  assert.equal(v.color, "red");
  assert.equal(v.rule, "fold-blocked");
  assert.equal(v.writer, "sub-1");
});

test("should go green when a teammate works and the main thread has ended", () => {
  const v = fold({ "": "Ended", "sub-1": "Working" }, "running");
  assert.equal(v.color, "green");
  assert.equal(v.writer, "sub-1");
  assert.equal(v.delegating, true);
});

test("should not report delegating when the main thread is the one working", () => {
  const v = fold({ "": "Working", "sub-1": "Ended" }, "running");
  assert.equal(v.color, "green");
  assert.equal(v.writer, "");
  assert.equal(v.delegating, false);
});

test("should count a writer with a tool in flight as work happening", () => {
  assert.equal(fold({ "": "ToolInFlight" }, "running").color, "green");
});

test("should go gray only when every writer is unknown", () => {
  assert.equal(fold({ "": "Unknown", "sub-1": "Unknown" }, "running").color, "gray");
  assert.equal(fold({}, "running").color, "gray");
  assert.equal(fold({ "": "Unknown", "sub-1": "Ended" }, "running").color, "orange");
});

test("should go orange when nothing runs and nothing is stuck", () => {
  const v = fold({ "": "Ended", "sub-1": "Interrupted" }, "running");
  assert.equal(v.color, "orange");
  assert.equal(v.rule, "fold-quiet");
});

test("should name the same deciding writer whatever order the writers were added", () => {
  const a = fold({ "sub-2": "Blocked", "sub-1": "Blocked" }, "running");
  const b = fold({ "sub-1": "Blocked", "sub-2": "Blocked" }, "running");
  assert.equal(a.writer, b.writer);
  assert.equal(a.writer, "sub-1");
});

test("should reach exactly one ladder rung for every verdict the fold can return", () => {
  const rules = new Set(LADDER.map((r) => r.rule));
  const verdicts = [
    fold({ "": "Blocked" }, "running"),
    fold({ "": "Working" }, "running"),
    fold({ "": "Ended" }, "running"),
    fold({ "": "Unknown" }, "running"),
    fold({ "": "Working" }, "suspended"),
    fold({ "": "Working" }, "gone"),
  ];
  for (const v of verdicts) assert.ok(rules.has(v.rule), `ladder has no rung for ${v.rule}`);
  assert.equal(new Set(verdicts.map((v) => v.rule)).size, LADDER.length);
});

// --- the page's own claims ------------------------------------------------

test("should describe every declared state and evidence kind in the prose", () => {
  for (const s of STATES) {
    assert.ok(s.short && s.body && s.you, `state ${s.id} is missing prose`);
  }
  for (const e of EVIDENCE) {
    assert.ok(e.gloss, `evidence ${e.id} is missing a gloss`);
  }
});

test("should point every divergence and gap at a cell that exists", () => {
  for (const d of DIVERGENCES) {
    const t = transitionFor(d.from, d.ev);
    assert.ok(t, `divergence names a missing cell (${d.from}, ${d.ev})`);
    assert.equal(t.to, d.to);
    assert.ok(d.note, "a divergence with no explanation is just a marker");
  }
  for (const g of GAPS) {
    const t = transitionFor(g.from, g.ev);
    assert.ok(t, `gap names a missing cell (${g.from}, ${g.ev})`);
    assert.equal(t.to, g.to);
    assert.equal(t.shipped, "", `${g.from}+${g.ev} is listed as a gap but names a shipped rule`);
  }
});

test("should map every lane color the timeline can paint to a fold outcome", () => {
  const colors = new Set(LADDER.map((r) => r.color));
  for (const l of LANE_MAP) assert.ok(colors.has(l.color), `lane ${l.lane} maps to unknown ${l.color}`);
});
