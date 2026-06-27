"use strict";

// Behavioral tests for the pure render model (model.js). Run with: node --test
// (node:test + node:assert, no deps). These cover the session-name-spans
// contract: identity keying, mid-life rename -> one bar / multiple segments,
// parallel sessions -> separate bars, and the pre-/name lead fallback.

const test = require("node:test");
const assert = require("node:assert/strict");
const { laneIdentity, leadLabel, nameSegments, buildBars } = require("./model.js");

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
