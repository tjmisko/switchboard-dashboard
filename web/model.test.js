"use strict";

// Behavioral tests for the pure render model (model.js). Run with: node --test
// (node:test + node:assert, no deps). These cover the session-name-spans
// contract: identity keying, mid-life rename -> one bar / multiple segments,
// parallel sessions -> separate bars, and the pre-/name lead fallback.

const test = require("node:test");
const assert = require("node:assert/strict");
const { laneIdentity, leadLabel, nameSegments, buildBars, spanInefficiency, switchArrivals, packLanes } = require("./model.js");

// ms helper: a fixed base instant + offset minutes, as RFC3339 with offset.
const BASE = "2026-06-26T17:00:00-07:00";
const baseMs = Date.parse(BASE);
function at(min) {
  return new Date(baseMs + min * 60000).toISOString();
}
function span(label, fromMin, toMin) {
  return { label, start: at(fromMin), end: at(toMin) };
}

test("laneIdentity keys by session_id when present", () => {
  assert.equal(laneIdentity({ session_id: "abc", pid: 42 }), "abc");
});

test("laneIdentity falls back to pid when session_id is absent", () => {
  assert.equal(laneIdentity({ pid: 42 }), "pid:42");
  assert.equal(laneIdentity({ session_id: "", pid: 42 }), "pid:42");
});

test("a session renamed mid-life renders one bar with multiple name segments", () => {
  // lane.start at -5, two /name spans back to back, ending at lane.end.
  const lane = {
    session_id: "s1",
    pid: 100,
    project: "sb",
    start: at(-5),
    end: at(60),
    names: [span("first-name", 0, 30), span("second-name", 30, 60)],
  };
  const bars = buildBars([lane]);
  assert.equal(bars.length, 1, "one session -> one bar");

  const segs = bars[0].segments;
  const nameSegs = segs.filter((s) => s.kind === "name");
  assert.equal(nameSegs.length, 2, "two /name spans -> two name segments");
  assert.deepEqual(
    nameSegs.map((s) => s.label),
    ["first-name", "second-name"],
    "segments labeled by each slug in order",
  );

  // the leading pre-/name stretch is present and labeled by the project fallback.
  const lead = segs.find((s) => s.kind === "lead");
  assert.ok(lead, "a lead segment covers the pre-/name stretch");
  assert.equal(lead.label, "sb");
  assert.equal(lead.start, Date.parse(at(-5)));
  assert.equal(lead.end, Date.parse(at(0)), "lead ends where the first /name begins");

  // segments are contiguous and the last name reaches lane.end.
  for (let i = 1; i < segs.length; i++) assert.equal(segs[i].start, segs[i - 1].end);
  assert.equal(segs[segs.length - 1].end, Date.parse(at(60)));
});

test("renaming never splits a session into multiple bars (identity is stable)", () => {
  const lane = {
    session_id: "s1",
    pid: 100,
    start: at(0),
    end: at(60),
    names: [span("old", 0, 30), span("new", 30, 60)],
  };
  const bars = buildBars([lane]);
  assert.equal(bars.length, 1);
  assert.equal(bars[0].key, "s1", "the single bar is keyed by session identity");
});

test("two concurrent sessions render as two separate bars, each independently named", () => {
  const a = {
    session_id: "A",
    pid: 1,
    project: "sb",
    start: at(0),
    end: at(50),
    names: [span("alpha", 5, 50)],
  };
  const b = {
    session_id: "B",
    pid: 2,
    project: "sspi",
    start: at(10),
    end: at(60),
    names: [span("beta", 12, 60)],
  };
  const bars = buildBars([a, b]);
  assert.equal(bars.length, 2, "two overlapping sessions -> two bars (never merged)");
  assert.deepEqual(bars.map((x) => x.key), ["A", "B"]);

  const labelsOf = (bar) => bar.segments.filter((s) => s.kind === "name").map((s) => s.label);
  assert.deepEqual(labelsOf(bars[0]), ["alpha"]);
  assert.deepEqual(labelsOf(bars[1]), ["beta"]);
});

test("two concurrent sessions that share a name stay separate bars", () => {
  const a = { session_id: "A", pid: 1, start: at(0), end: at(30), names: [span("same", 0, 30)] };
  const b = { session_id: "B", pid: 2, start: at(0), end: at(30), names: [span("same", 0, 30)] };
  const bars = buildBars([a, b]);
  assert.equal(bars.length, 2);
  assert.notEqual(bars[0].key, bars[1].key);
});

test("a session with no /name yet is one lead segment over its whole life", () => {
  const lane = { session_id: "s1", pid: 9, project: "dots", start: at(0), end: at(40), names: null };
  const segs = nameSegments(lane);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].kind, "lead");
  assert.equal(segs[0].label, "dots");
  assert.equal(segs[0].start, Date.parse(at(0)));
  assert.equal(segs[0].end, Date.parse(at(40)));
});

test("lead label prefers project_full, then project, then first raw label", () => {
  assert.equal(leadLabel({ project_full: "Switchboard", project: "sb" }), "Switchboard");
  assert.equal(leadLabel({ project: "sb" }), "sb");
  assert.equal(leadLabel({ labels: [{ label: "Claude Code" }] }), "Claude Code");
  assert.equal(leadLabel({}), "");
});

test("no leading lead segment when the first /name starts at lane.start", () => {
  const lane = { session_id: "s1", pid: 1, project: "sb", start: at(0), end: at(30), names: [span("n", 0, 30)] };
  const segs = nameSegments(lane);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].kind, "name");
  assert.equal(segs[0].label, "n");
});

// interval helper: an {status, start, end} run in epoch-ms bounds.
function interval(status, fromMs, toMs) {
  return { status, start: new Date(fromMs).toISOString(), end: new Date(toMs).toISOString() };
}

test("spanInefficiency returns 0.5 when the span is exactly half idle/waiting", () => {
  const segStart = baseMs;
  const segEnd = baseMs + 60000; // 60s span
  const lane = {
    intervals: [
      interval("active", segStart, segStart + 30000),
      interval("idle", segStart + 30000, segEnd),
    ],
  };
  assert.equal(spanInefficiency(lane, segStart, segEnd), 0.5);
});

test("spanInefficiency returns 0 when the span is fully working with no waiting status", () => {
  const segStart = baseMs;
  const segEnd = baseMs + 60000;
  const lane = {
    intervals: [
      interval("active", segStart, segStart + 30000),
      interval("active", segStart + 30000, segEnd),
    ],
  };
  assert.equal(spanInefficiency(lane, segStart, segEnd), 0);
});

test("spanInefficiency returns null when the span has zero length", () => {
  const at0 = baseMs;
  const lane = { intervals: [interval("idle", at0 - 1000, at0 + 1000)] };
  assert.equal(spanInefficiency(lane, at0, at0), null);
});

test("spanInefficiency does not count delegating/dormant (waiting on a subagent) as inefficient", () => {
  const segStart = baseMs;
  const segEnd = baseMs + 100000; // 100s span
  const lane = {
    intervals: [
      interval("working", segStart, segStart + 20000),
      interval("dormant", segStart + 20000, segStart + 60000),   // waiting on subagent — productive
      interval("delegating", segStart + 60000, segStart + 90000), // legacy alias — also productive
      interval("idle", segStart + 90000, segEnd),                 // 10s genuinely idle
    ],
  };
  // only the trailing 10s of idle out of 100s counts as inefficient
  assert.equal(spanInefficiency(lane, segStart, segEnd), 0.1);
});

// switchArrivals: which focus arrivals are real context switches. focusSpan makes
// a {start,end} focus span dwelt `dwellMs` starting `fromMs`.
function focusSpan(fromMs, dwellMs) {
  return { start: new Date(fromMs).toISOString(), end: new Date(fromMs + dwellMs).toISOString() };
}

test("switchArrivals keeps a focus arrival whose dwell meets the flicker floor", () => {
  assert.deepEqual(switchArrivals([focusSpan(baseMs, 500)], 500), [baseMs]);
});

test("switchArrivals drops sub-flicker focus events (notification / focus-follows-mouse)", () => {
  assert.deepEqual(switchArrivals([focusSpan(baseMs, 300)], 500), []);
});

test("switchArrivals keeps brief-but-real switches above the floor — thrash still counts", () => {
  // Regression guard: a ~1s glance is a real context switch and must be charged,
  // even though it is far below the 15s editing threshold. The prior code showed
  // these in the count/overlay but never subtracted their recovery, overstating
  // free time by ~10x on a heavy-thrash session.
  const spans = [
    focusSpan(baseMs + 0, 1200),
    focusSpan(baseMs + 5000, 800),
    focusSpan(baseMs + 9000, 200),    // sub-flicker: dropped
    focusSpan(baseMs + 12000, 60000), // a real ≥15s engagement
  ];
  assert.deepEqual(switchArrivals(spans, 500), [baseMs + 0, baseMs + 5000, baseMs + 12000]);
});

test("switchArrivals returns arrival starts sorted ascending", () => {
  const spans = [focusSpan(baseMs + 10000, 1000), focusSpan(baseMs, 1000)];
  assert.deepEqual(switchArrivals(spans, 500), [baseMs, baseMs + 10000]);
});

test("switchArrivals ignores unparseable spans and empty/absent input", () => {
  assert.deepEqual(switchArrivals([], 500), []);
  assert.deepEqual(switchArrivals(null, 500), []);
  assert.deepEqual(switchArrivals([{ start: "nope", end: "nope" }], 500), []);
});

// packLanes: greedy interval partitioning of a group's lanes into shared rows.
function laneSpan(id, fromMin, toMin) {
  return { session_id: id, start: at(fromMin), end: at(toMin) };
}
const idsOf = (rows) => rows.map((row) => row.map((l) => l.session_id));

test("packLanes packs two time-serializable sessions onto one row", () => {
  const rows = packLanes([laneSpan("A", 0, 10), laneSpan("B", 10, 20)]);
  assert.equal(rows.length, 1, "non-overlapping sessions share a row");
  assert.equal(rows[0].length, 2);
  assert.deepEqual(idsOf(rows), [["A", "B"]]);
});

test("packLanes splits two overlapping sessions onto separate rows", () => {
  const rows = packLanes([laneSpan("A", 0, 30), laneSpan("B", 10, 40)]);
  assert.equal(rows.length, 2, "overlap forces a second row");
});

test("packLanes packs a later session back onto row 1 (the Switchboard case)", () => {
  // A and B overlap (B opens row 2); C starts after A ends, so it packs onto row 1.
  const rows = packLanes([laneSpan("A", 0, 20), laneSpan("B", 5, 60), laneSpan("C", 25, 45)]);
  assert.equal(rows.length, 2, "max simultaneous overlap is 2 -> 2 rows");
  assert.deepEqual(idsOf(rows), [["A", "C"], ["B"]]);
});

test("packLanes preserves start order within a row regardless of input order", () => {
  const rows = packLanes([laneSpan("C", 20, 30), laneSpan("A", 0, 5), laneSpan("B", 10, 15)]);
  assert.equal(rows.length, 1);
  assert.deepEqual(idsOf(rows), [["A", "B", "C"]], "row lanes sorted by start");
});

test("packLanes treats adjacency (nextStart === prevEnd) as packable", () => {
  const rows = packLanes([laneSpan("A", 0, 10), laneSpan("B", 10, 20), laneSpan("C", 20, 30)]);
  assert.deepEqual(idsOf(rows), [["A", "B", "C"]]);
});

test("packLanes puts each unparseable-bounds lane on its own row without crashing", () => {
  const rows = packLanes([{ session_id: "X", start: "nope", end: "nah" }, laneSpan("A", 0, 10)]);
  assert.equal(rows.length, 2);
  // the bounded lane packs first; the unbounded one is appended on its own row.
  assert.deepEqual(idsOf(rows), [["A"], ["X"]]);
});

test("packLanes returns an empty list for no lanes", () => {
  assert.deepEqual(packLanes([]), []);
  assert.deepEqual(packLanes(null), []);
});
