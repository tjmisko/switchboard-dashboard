"use strict";

// Behavioral tests for the pure render model (model.js). Run with: node --test
// (node:test + node:assert, no deps). These cover the session-name-spans
// contract: identity keying, mid-life rename -> one bar / multiple segments,
// parallel sessions -> separate bars, and the pre-/name lead fallback.

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  laneIdentity, leadLabel, nameSegments, buildBars, spanInefficiency, switchArrivals, packLanes,
  workIntervalsMs, concurrencyProfile, projectHoursMs,
} = require("./model.js");

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

// ---------------------------------------------------------------------------
// concurrency ("agents aloft"): workIntervalsMs + concurrencyProfile
// ---------------------------------------------------------------------------

// min helper: an epoch-ms instant `min` minutes past BASE.
function ms(min) { return baseMs + min * 60000; }

test("workIntervalsMs counts only 'working' intervals, not idle/permission/dormant", () => {
  const lanes = [{
    intervals: [
      interval("working", ms(0), ms(10)),
      interval("dormant", ms(10), ms(20)),      // waiting on subagent — not itself aloft
      interval("delegating", ms(20), ms(30)),   // legacy alias — not itself aloft
      interval("idle", ms(30), ms(40)),
      interval("permission", ms(40), ms(50)),
      interval("working", ms(50), ms(60)),
    ],
  }];
  const iv = workIntervalsMs(lanes);
  assert.deepEqual(iv, [[ms(0), ms(10)], [ms(50), ms(60)]], "only the two working runs survive");
});

test("workIntervalsMs adds each subagent span alongside the parent's working spans", () => {
  const lanes = [{
    intervals: [interval("working", ms(0), ms(10)), interval("dormant", ms(10), ms(30))],
    subagents: [
      { start: new Date(ms(10)).toISOString(), end: new Date(ms(25)).toISOString() },
      { start: new Date(ms(12)).toISOString(), end: new Date(ms(30)).toISOString() },
    ],
  }];
  const iv = workIntervalsMs(lanes);
  assert.equal(iv.length, 3, "one working span + two subagent spans");
  assert.deepEqual(iv[0], [ms(0), ms(10)]);
});

test("concurrencyProfile reports peak overlap and a step point per change", () => {
  // A: [0,30), B: [10,40), C: [50,60). Peak overlap is 2 (A∩B on [10,30)).
  const prof = concurrencyProfile([[ms(0), ms(30)], [ms(10), ms(40)], [ms(50), ms(60)]]);
  assert.equal(prof.maxN, 2, "A and B overlap -> peak 2");
  // breakpoints at every event boundary, level = count active AT/AFTER that t
  assert.deepEqual(
    prof.points.map((p) => [p.t, p.n]),
    [[ms(0), 1], [ms(10), 2], [ms(30), 1], [ms(40), 0], [ms(50), 1], [ms(60), 0]],
  );
});

test("concurrencyProfile: avgActive = ∫n dt ÷ active time (the force multiplier)", () => {
  // Two fully-overlapping 10-min spans: aloft = 2 for the whole 10 min.
  // integral = 2 agents × 10 min = 20 agent-min; active = 10 min -> avg = 2.0.
  const prof = concurrencyProfile([[ms(0), ms(10)], [ms(0), ms(10)]]);
  assert.equal(prof.activeMs, 10 * 60000);
  assert.equal(prof.integralMs, 20 * 60000);
  assert.equal(prof.avgActive, 2);
});

test("concurrencyProfile: avgActive counts only active time, ignoring the idle gap", () => {
  // A: [0,10) alone, then a gap, then B+C overlapping [30,40).
  // integral = 1×10 + 2×10 = 30 agent-min; active = 10 + 10 = 20 min -> avg 1.5.
  const prof = concurrencyProfile([[ms(0), ms(10)], [ms(30), ms(40)], [ms(30), ms(40)]]);
  assert.equal(prof.maxN, 2);
  assert.equal(prof.activeMs, 20 * 60000, "the 20-min gap is not active time");
  assert.equal(prof.avgActive, 1.5, "diluted only by active moments, not the gap");
});

test("concurrencyProfile handles no intervals: empty points, null average", () => {
  const prof = concurrencyProfile([]);
  assert.deepEqual(prof.points, []);
  assert.equal(prof.maxN, 0);
  assert.equal(prof.activeMs, 0);
  assert.equal(prof.avgActive, null);
});

test("concurrencyProfile merges simultaneous starts into one point at the shared instant", () => {
  // three spans all opening at the same t -> a single breakpoint of level 3.
  const prof = concurrencyProfile([[ms(0), ms(10)], [ms(0), ms(20)], [ms(0), ms(30)]]);
  assert.equal(prof.maxN, 3);
  assert.equal(prof.points[0].t, ms(0));
  assert.equal(prof.points[0].n, 3, "coincident starts collapse to one +3 step");
});

// ---------------------------------------------------------------------------
// projectHoursMs: agent-time totalled per project
// ---------------------------------------------------------------------------

// subagent helper: a {start,end} subagent span in epoch-ms bounds.
function subagent(fromMs, toMs) {
  return { start: new Date(fromMs).toISOString(), end: new Date(toMs).toISOString() };
}
const MIN = 60000;

// totals strips the per-session parts, leaving the {project, ms, sessions}
// rollup — most cases here assert on the rollup; parts get their own tests.
function totals(rows) {
  return rows.map(({ project, ms, sessions }) => ({ project, ms, sessions }));
}

test("projectHoursMs groups by project_full, falling back to project then '(no project)'", () => {
  const lanes = [
    { project_full: "Switchboard", project: "sb", intervals: [interval("working", ms(0), ms(30))] },
    { project: "sspi", intervals: [interval("working", ms(0), ms(20))] },
    { intervals: [interval("working", ms(0), ms(10))] },
  ];
  assert.deepEqual(totals(projectHoursMs(lanes)), [
    { project: "Switchboard", ms: 30 * MIN, sessions: 1 },
    { project: "sspi", ms: 20 * MIN, sessions: 1 },
    { project: "(no project)", ms: 10 * MIN, sessions: 1 },
  ]);
});

test("projectHoursMs merges lanes that share a project and counts them as sessions", () => {
  const lanes = [
    { project_full: "Switchboard", intervals: [interval("working", ms(0), ms(30))] },
    { project_full: "Switchboard", intervals: [interval("working", ms(40), ms(50))] },
  ];
  assert.deepEqual(totals(projectHoursMs(lanes)), [
    { project: "Switchboard", ms: 40 * MIN, sessions: 2 },
  ]);
});

test("projectHoursMs adds subagent spans to the lane's project total", () => {
  // 10 min of parent work + two subagent spans (15 + 8 min) = 33 agent-min.
  const lanes = [{
    project: "sb",
    intervals: [interval("working", ms(0), ms(10)), interval("dormant", ms(10), ms(30))],
    subagents: [subagent(ms(10), ms(25)), subagent(ms(12), ms(20))],
  }];
  assert.deepEqual(totals(projectHoursMs(lanes)), [{ project: "sb", ms: 33 * MIN, sessions: 1 }]);
});

test("projectHoursMs counts only 'working' intervals, not idle/permission/dormant/suspended", () => {
  const lanes = [{
    project: "sb",
    intervals: [
      interval("working", ms(0), ms(10)),
      interval("idle", ms(10), ms(20)),
      interval("permission", ms(20), ms(30)),
      interval("dormant", ms(30), ms(40)),
      interval("suspended", ms(40), ms(50)),
      interval("working", ms(50), ms(55)),
    ],
  }];
  assert.deepEqual(totals(projectHoursMs(lanes)), [{ project: "sb", ms: 15 * MIN, sessions: 1 }]);
});

test("projectHoursMs sums overlapping work as agent-time rather than unioning it", () => {
  // Two lanes on the same project working the same wall-clock 10 min: the point
  // of fanout is that this is 20 agent-min, not 10.
  const lanes = [
    { project: "sb", intervals: [interval("working", ms(0), ms(10))] },
    { project: "sb", intervals: [interval("working", ms(0), ms(10))] },
  ];
  assert.deepEqual(totals(projectHoursMs(lanes)), [{ project: "sb", ms: 20 * MIN, sessions: 2 }]);
});

test("projectHoursMs sums overlapping spans within a single lane too", () => {
  // A parent working while its own subagent runs is two concurrent work streams.
  const lanes = [{
    project: "sb",
    intervals: [interval("working", ms(0), ms(10)), interval("working", ms(5), ms(15))],
    subagents: [subagent(ms(0), ms(10))],
  }];
  assert.deepEqual(totals(projectHoursMs(lanes)), [{ project: "sb", ms: 30 * MIN, sessions: 1 }]);
});

test("projectHoursMs sorts by ms descending, breaking ties by project name ascending", () => {
  const lanes = [
    { project: "zeta", intervals: [interval("working", ms(0), ms(10))] },
    { project: "alpha", intervals: [interval("working", ms(0), ms(10))] },
    { project: "middle", intervals: [interval("working", ms(0), ms(50))] },
  ];
  assert.deepEqual(
    projectHoursMs(lanes).map((p) => p.project),
    ["middle", "alpha", "zeta"],
    "biggest first; the two equal totals fall back to name order",
  );
});

test("projectHoursMs drops projects whose lanes did no work at all", () => {
  const lanes = [
    { project: "sb", intervals: [interval("working", ms(0), ms(10))] },
    { project: "idle-only", intervals: [interval("idle", ms(0), ms(60))] },
    { project: "empty", intervals: [], subagents: [] },
  ];
  assert.deepEqual(totals(projectHoursMs(lanes)), [{ project: "sb", ms: 10 * MIN, sessions: 1 }]);
});

test("projectHoursMs counts only lanes that contributed time toward sessions", () => {
  const lanes = [
    { project: "sb", intervals: [interval("working", ms(0), ms(10))] },
    { project: "sb", intervals: [interval("idle", ms(0), ms(60))] },  // no work -> not a session
    { project: "sb", intervals: [interval("working", ms(20), ms(25))] },
  ];
  assert.deepEqual(totals(projectHoursMs(lanes)), [{ project: "sb", ms: 15 * MIN, sessions: 2 }]);
});

test("projectHoursMs ignores unparseable timestamps and non-positive spans", () => {
  const lanes = [{
    project: "sb",
    intervals: [
      { status: "working", start: "nope", end: "nah" },
      interval("working", ms(10), ms(10)),  // zero length
      interval("working", ms(30), ms(20)),  // end before start
      interval("working", ms(0), ms(10)),
    ],
    subagents: [{ start: "nope", end: "nah" }, subagent(ms(40), ms(40))],
  }];
  assert.deepEqual(totals(projectHoursMs(lanes)), [{ project: "sb", ms: 10 * MIN, sessions: 1 }]);
});

test("projectHoursMs returns an empty list for no lanes", () => {
  assert.deepEqual(projectHoursMs([]), []);
  assert.deepEqual(projectHoursMs(null), []);
  assert.deepEqual(projectHoursMs(undefined), []);
});

test("projectHoursMs parts break the total down per session in lane-start order", () => {
  // the later-starting lane is listed first in the input to prove parts order
  // comes from lane.start, not input order.
  const lanes = [
    { project: "sb", start: at(20), names: [span("beta", 20, 30)], intervals: [interval("working", ms(20), ms(30))] },
    { project: "sb", start: at(0), names: [span("alpha", 0, 10)], intervals: [interval("working", ms(0), ms(10)), interval("working", ms(5), ms(10))] },
  ];
  assert.deepEqual(projectHoursMs(lanes), [{
    project: "sb", ms: 25 * MIN, sessions: 2,
    parts: [
      { label: "alpha", ms: 15 * MIN, startMs: ms(0) },
      { label: "beta", ms: 10 * MIN, startMs: ms(20) },
    ],
  }]);
});

test("projectHoursMs part labels prefer the latest names[] slug, then the lead fallbacks", () => {
  const lanes = [
    { project: "sb", start: at(0), names: [span("old", 0, 5), span("new", 5, 10)], intervals: [interval("working", ms(0), ms(10))] },
    { project: "sb", start: at(20), intervals: [interval("working", ms(20), ms(30))] },
    { start: at(0), labels: [{ label: "Claude Code" }], intervals: [interval("working", ms(0), ms(10))] },
    { start: at(20), intervals: [interval("working", ms(20), ms(30))] },
  ];
  const rows = projectHoursMs(lanes);
  assert.deepEqual(
    rows.find((r) => r.project === "sb").parts.map((p) => p.label),
    ["new", "sb"],
    "renamed session shows its CURRENT slug; an unnamed one falls back to the lead label",
  );
  assert.deepEqual(
    rows.find((r) => r.project === "(no project)").parts.map((p) => p.label),
    ["Claude Code", "session"],
    "projectless lanes fall through to raw labels[], then the generic 'session'",
  );
});

test("projectHoursMs parts with unparseable lane starts sort last with null startMs", () => {
  const lanes = [
    { project: "sb", names: [span("undated", 0, 10)], intervals: [interval("working", ms(0), ms(10))] },
    { project: "sb", start: at(30), names: [span("dated", 30, 40)], intervals: [interval("working", ms(30), ms(40))] },
  ];
  assert.deepEqual(projectHoursMs(lanes)[0].parts, [
    { label: "dated", ms: 10 * MIN, startMs: ms(30) },
    { label: "undated", ms: 10 * MIN, startMs: null },
  ]);
});
