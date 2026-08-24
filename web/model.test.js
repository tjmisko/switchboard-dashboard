"use strict";

// Behavioral tests for the pure render model (model.js). Run with: node --test
// (node:test + node:assert, no deps). These cover the session-name-spans
// contract: identity keying, mid-life rename -> one bar / multiple segments,
// parallel sessions -> separate bars, and the pre-/name lead fallback.

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  laneIdentity, rawSessionId, laneProvider, providerLabel, providerLegend, adaptProviderTimeline,
  leadLabel, nameSegments, buildBars, spanInefficiency, switchArrivals,
  deflickerIntervals, deflickerLanes, FLICKER_MS,
  presenceSplitMs, awayIdleMs, packLanes,
  aloftSpans, workIntervalsMs, concurrencyProfile, graphAwareAttention, alignLiveTail,
  projectHoursMs, suspectSinceMs, clipSpanMs, laneActiveMs,
  freeBlockStats, FREE_BLOCK_DEEP_MS, FREE_BLOCK_FRAG_MS,
  freeBucketStats, FREE_BUCKETS,
  suspectTailMs, normalizeView, VIEW_ORDER, stepView, scaleGeometry,
  parseISODate, stepISODate, stepISOMonth, clampISODate, monthGrid,
  localDayBoundsMs, dayWindowMs,
  fmtBytes, spawnedBytes, laneMemory, memoryWindow, pressureWindow,
  summaryTasks, summaryBodyHTML, summaryHintText,
  fmtTokens, shortModel, tokenBilled, tokenTotals, tokenRowsHTML,
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

// presenceSplitMs / awayIdleMs: the idle-while-away carve-out (issue #20). A
// session parked overnight draws darkened and its idle time comes off the
// clock, but ONLY where an activity stream gives evidence the operator left.

test("presenceSplitMs marks the whole span away when the operator was never present", () => {
  assert.deepEqual(presenceSplitMs(baseMs, baseMs + 60000, []), [
    { s: baseMs, e: baseMs + 60000, away: true },
  ]);
});

test("presenceSplitMs yields one attended piece when presence covers the whole span", () => {
  assert.deepEqual(presenceSplitMs(baseMs, baseMs + 60000, [[baseMs - 1000, baseMs + 61000]]), [
    { s: baseMs, e: baseMs + 60000, away: false },
  ]);
});

test("presenceSplitMs tiles away/present/away around a mid-span presence window", () => {
  const present = [[baseMs + 20000, baseMs + 40000]];
  assert.deepEqual(presenceSplitMs(baseMs, baseMs + 60000, present), [
    { s: baseMs, e: baseMs + 20000, away: true },
    { s: baseMs + 20000, e: baseMs + 40000, away: false },
    { s: baseMs + 40000, e: baseMs + 60000, away: true },
  ]);
});

test("presenceSplitMs ignores presence outside the span and returns [] for an empty span", () => {
  assert.deepEqual(presenceSplitMs(baseMs, baseMs + 10000, [[baseMs - 5000, baseMs - 1000], [baseMs + 20000, baseMs + 30000]]), [
    { s: baseMs, e: baseMs + 10000, away: true },
  ]);
  assert.deepEqual(presenceSplitMs(baseMs, baseMs, [[baseMs - 1000, baseMs + 1000]]), []);
  assert.deepEqual(presenceSplitMs(NaN, baseMs, []), []);
});

test("awayIdleMs fails open to 0 without an activity stream (presentPairs null)", () => {
  const lane = { intervals: [interval("idle", baseMs, baseMs + 3600000)] };
  assert.equal(awayIdleMs(lane, null), 0);
  assert.equal(awayIdleMs(lane, undefined), 0);
});

test("awayIdleMs counts only the idle time the presence union does not cover", () => {
  // parked overnight: present for the first 10s and the last 10s, away between
  const lane = {
    intervals: [
      interval("idle", baseMs, baseMs + 100000),
      interval("working", baseMs + 100000, baseMs + 160000), // away but working — not idle parking
    ],
  };
  const present = [[baseMs, baseMs + 10000], [baseMs + 90000, baseMs + 100000]];
  assert.equal(awayIdleMs(lane, present), 80000);
});

test("awayIdleMs writes off all idle time when the stream shows the operator never active", () => {
  const lane = { intervals: [interval("idle", baseMs, baseMs + 50000)] };
  assert.equal(awayIdleMs(lane, []), 50000);
});

test("awayIdleMs clips idle at the evidence bound so it subtracts cleanly from by_status", () => {
  // idle 0–100s, but everything past 40s is a synthesized tail the summary
  // already excluded; only the trusted 40s may be written off as away.
  const lane = {
    suspect: true,
    suspect_since: new Date(baseMs + 40000).toISOString(),
    intervals: [interval("idle", baseMs, baseMs + 100000)],
  };
  assert.equal(awayIdleMs(lane, []), 40000);
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

// ---------------------------------------------------------------------------
// live tail: which aloft spans are still in flight, and squaring them off
// ---------------------------------------------------------------------------

test("aloftSpans should mark a lane's last working interval open when nothing superseded it", () => {
  const lanes = [{ intervals: [interval("idle", ms(0), ms(5)), interval("working", ms(5), ms(20))] }];
  const spans = aloftSpans(lanes);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].open, true, "the lane has reported nothing after it");
});

test("aloftSpans should mark a working interval closed once the lane reports a later status", () => {
  const lanes = [{ intervals: [interval("working", ms(0), ms(10)), interval("idle", ms(10), ms(20))] }];
  const spans = aloftSpans(lanes);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].open, false, "going idle is the agent landing, not a stale sample");
});

test("aloftSpans should mark a subagent span open only when it runs to the lane's newest sample", () => {
  const lanes = [{
    intervals: [interval("delegating", ms(0), ms(20))],
    subagents: [
      { start: new Date(ms(0)).toISOString(), end: new Date(ms(12)).toISOString() },  // finished
      { start: new Date(ms(5)).toISOString(), end: new Date(ms(20)).toISOString() },  // still running
    ],
  }];
  const spans = aloftSpans(lanes);
  assert.deepEqual(spans.map((x) => x.open), [false, true]);
});

test("alignLiveTail should extend every still-open span to the newest sample", () => {
  // three streams, sampled 20s / 10s / 2s before now — all still running. The
  // staggered ends would decay 3 -> 2 -> 1 -> 0 at the right edge.
  const now = ms(60);
  const spans = [
    { s: ms(0), e: now - 20000, open: true },
    { s: ms(10), e: now - 10000, open: true },
    { s: ms(20), e: now - 2000, open: true },
  ];
  const { intervals, tail } = alignLiveTail(spans, now, true);
  assert.deepEqual(tail, { t: now - 2000, n: 3 }, "all three are aloft at the newest sample");
  assert.deepEqual(intervals.map((iv) => iv[1]), [now - 2000, now - 2000, now - 2000]);
});

test("alignLiveTail should leave closed spans where they ended", () => {
  const now = ms(60);
  const spans = [
    { s: ms(0), e: ms(30), open: false },        // landed half an hour ago
    { s: ms(40), e: now - 3000, open: true },    // still up
  ];
  const { intervals, tail } = alignLiveTail(spans, now, true);
  assert.deepEqual(intervals[0], [ms(0), ms(30)], "a finished span is not resurrected");
  assert.equal(tail.n, 1, "only the open stream counts as aloft");
});

test("alignLiveTail should return no tail for a historical window", () => {
  const now = ms(60);
  const spans = [{ s: ms(0), e: now - 3000, open: true }];
  const { intervals, tail } = alignLiveTail(spans, now, false);
  assert.equal(tail, null, "a closed day's drop to zero is real");
  assert.deepEqual(intervals, [[ms(0), now - 3000]], "spans pass through untouched");
});

test("alignLiveTail should return no tail when the feed has gone stale", () => {
  const now = ms(60);
  const spans = [{ s: ms(0), e: now - 10 * 60000, open: true }];
  assert.equal(alignLiveTail(spans, now, true).tail, null, "10-minute-old sample is not live");
});

test("alignLiveTail should return no tail when nothing is open", () => {
  const now = ms(60);
  const spans = [{ s: ms(0), e: now - 3000, open: false }];
  assert.equal(alignLiveTail(spans, now, true).tail, null);
  assert.equal(alignLiveTail([], now, true).tail, null);
});

test("alignLiveTail should count only the streams covering the newest sample", () => {
  // one stream went stale 5 minutes ago (open, but its lane stopped reporting)
  // while another is live: the marker reads 1, not 2.
  const now = ms(60);
  const spans = [
    { s: ms(0), e: now - 5 * 60000, open: true },
    { s: ms(50), e: now - 1000, open: true },
  ];
  assert.deepEqual(alignLiveTail(spans, now, true).tail, { t: now - 1000, n: 1 });
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
    project: "sb", ms: 25 * MIN, sessions: 2, costUsd: null,
    parts: [
      { label: "alpha", ms: 15 * MIN, startMs: ms(0), costUsd: null, sessionId: null },
      { label: "beta", ms: 10 * MIN, startMs: ms(20), costUsd: null, sessionId: null },
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
    { label: "dated", ms: 10 * MIN, startMs: ms(30), costUsd: null, sessionId: null },
    { label: "undated", ms: 10 * MIN, startMs: null, costUsd: null, sessionId: null },
  ]);
});

test("projectHoursMs sums cost over the lanes that contributed the time", () => {
  const lanes = [
    { project: "sb", start: at(0), cost_usd: 4.5, intervals: [interval("working", ms(0), ms(10))] },
    { project: "sb", start: at(20), cost_usd: 1.25, intervals: [interval("working", ms(20), ms(30))] },
  ];
  const row = projectHoursMs(lanes)[0];
  assert.equal(row.costUsd, 5.75);
  assert.deepEqual(row.parts.map((p) => p.costUsd), [4.5, 1.25]);
});

test("projectHoursMs reports costUsd null when no contributing lane recorded a cost", () => {
  // "not recorded" must not render as "$0.00 spent" — a provider that omits
  // cost is silent, not free.
  const lanes = [{ project: "sb", start: at(0), intervals: [interval("working", ms(0), ms(10))] }];
  assert.equal(projectHoursMs(lanes)[0].costUsd, null);
});

test("projectHoursMs cost counts only lanes that contributed work", () => {
  // the row exists because of the working lane; a lane that did nothing is not
  // a part of the stack, so its spend is not in the row's total either — the
  // total always equals the sum of the parts drawn under it.
  const lanes = [
    { project: "sb", start: at(0), cost_usd: 2, intervals: [interval("working", ms(0), ms(10))] },
    { project: "sb", start: at(20), cost_usd: 99, intervals: [interval("idle", ms(20), ms(30))] },
  ];
  const row = projectHoursMs(lanes)[0];
  assert.equal(row.costUsd, 2);
  assert.equal(row.parts.length, 1);
});

test("projectHoursMs keeps a suspect lane's full cost while clipping its time", () => {
  // the evidence bound is a claim about observed TIME; the tokens were bought
  // either way, so the dollars are not clipped with the tail.
  const lanes = [{
    project: "sb", start: at(0), cost_usd: 3,
    suspect: true, suspect_since: at(10),
    intervals: [interval("working", ms(0), ms(60))],
  }];
  const row = projectHoursMs(lanes)[0];
  assert.equal(row.ms, 10 * MIN, "time stops at the evidence bound");
  assert.equal(row.costUsd, 3, "spend does not");
});

test("projectHoursMs parts carry the bare session id for joining to summaries", () => {
  const lanes = [
    { project: "sb", start: at(0), provider: "claude", session_id: "claude:abc", intervals: [interval("working", ms(0), ms(10))] },
    { project: "sb", start: at(20), session_id: "plain-id", intervals: [interval("working", ms(20), ms(30))] },
  ];
  assert.deepEqual(projectHoursMs(lanes)[0].parts.map((p) => p.sessionId), ["abc", "plain-id"]);
});

// ---------------------------------------------------------------------------
// freeBlockStats — the SHAPE of the operator's free time
// ---------------------------------------------------------------------------

// block(minutes) → one free interval of that length, laid end to end from BASE
// with a 1ms nudge so successive blocks never share a boundary.
let blockCursor = 0;
function block(minutes) {
  const s = baseMs + blockCursor;
  blockCursor += minutes * MIN + 1;
  return [s, s + minutes * MIN];
}

test("freeBlockStats should return an empty distribution when there are no blocks", () => {
  const s = freeBlockStats([]);
  assert.equal(s.count, 0);
  assert.equal(s.totalMs, 0);
  assert.equal(s.medianMs, null);
  assert.equal(s.longestMs, null);
  assert.equal(s.deepFrac, null);
  assert.equal(s.maxBinCount, 0);
  assert.deepEqual(s.bins.map((b) => b.count), [0, 0, 0, 0, 0, 0], "the bins still exist, so a plot can draw an empty axis");
  assert.deepEqual(freeBlockStats(null).bins.length, 6);
});

test("freeBlockStats should tell identical free-time totals apart by their shape", () => {
  // the whole point: 60 minutes as one block vs. as 60 one-minute slivers.
  blockCursor = 0;
  const whole = freeBlockStats([block(60)]);
  blockCursor = 0;
  const shredded = freeBlockStats(Array.from({ length: 60 }, () => block(1)));
  assert.equal(whole.totalMs, shredded.totalMs, "same hour of free time");
  assert.equal(whole.deepFrac, 1);
  assert.equal(shredded.deepFrac, 0, "a minute at a time is an hour you could start nothing in");
  assert.equal(whole.count, 1);
  assert.equal(shredded.count, 60);
});

test("freeBlockStats should bucket each block by duration", () => {
  blockCursor = 0;
  const s = freeBlockStats([block(0.5), block(3), block(10), block(20), block(45), block(90)]);
  assert.deepEqual(s.bins.map((b) => b.count), [1, 1, 1, 1, 1, 1]);
  assert.deepEqual(s.bins.map((b) => b.label), ["<1m", "1–5m", "5–15m", "15–30m", "30–60m", "1h+"]);
  assert.equal(s.maxBinCount, 1);
});

test("freeBlockStats should place a block exactly on a bucket floor in the higher bucket", () => {
  blockCursor = 0;
  const s = freeBlockStats([block(1), block(5), block(15), block(30), block(60)]);
  assert.deepEqual(s.bins.map((b) => b.count), [0, 1, 1, 1, 1, 1], "each edge belongs to the bucket it opens");
});

test("freeBlockStats should return blocks longest-first, whatever order they arrived in", () => {
  blockCursor = 0;
  const s = freeBlockStats([block(3), block(45), block(0.5), block(20)]);
  assert.deepEqual(s.blocksMs.map((ms) => ms / MIN), [45, 20, 3, 0.5],
    "the rank plot draws left to right, so the model hands them over already ranked");
  assert.equal(s.blocksMs.length, s.count);
  assert.equal(s.blocksMs.reduce((a, b) => a + b, 0), s.totalMs, "the ranked list is the whole distribution, not a sample");
});

test("freeBlockStats should count blocks under 5m as fragments", () => {
  blockCursor = 0;
  const s = freeBlockStats([block(0.5), block(2), block(10), block(60)]);
  assert.equal(s.fragCount, 2, "the half-minute and the two-minute gaps");
  assert.equal(s.fragMs, 2.5 * MIN);
  assert.equal(FREE_BLOCK_FRAG_MS, 5 * MIN);
});

test("freeBlockStats should treat a block exactly on the 5m fragment ceiling as real free time", () => {
  blockCursor = 0;
  const s = freeBlockStats([block(5)]);
  assert.equal(s.fragCount, 0, "5m is the ceiling the fragments sit BELOW, matching the bucket edges");
  assert.equal(s.fragMs, 0);
});

test("freeBlockStats should report no fragments for a day that came back whole", () => {
  blockCursor = 0;
  const s = freeBlockStats([block(45), block(30)]);
  assert.equal(s.fragCount, 0);
  assert.equal(s.fragMs, 0);
  assert.equal(s.deepFrac, 1);
});

test("freeBlockStats should report the median rather than let one long block speak for the day", () => {
  blockCursor = 0;
  const s = freeBlockStats([block(1), block(1), block(1), block(1), block(180)]);
  assert.equal(s.medianMs, 1 * MIN, "the typical block is a minute");
  assert.equal(s.longestMs, 180 * MIN);
  assert.ok(s.meanMs > 30 * MIN, "the mean is the figure that would have lied");
});

test("freeBlockStats should average the two middle blocks for an even count", () => {
  blockCursor = 0;
  const s = freeBlockStats([block(2), block(4), block(10), block(20)]);
  assert.equal(s.medianMs, 7 * MIN);
});

test("freeBlockStats should credit deep work only to blocks at or over the threshold", () => {
  blockCursor = 0;
  const s = freeBlockStats([block(14), block(15), block(60)]);
  assert.equal(FREE_BLOCK_DEEP_MS, 15 * MIN);
  assert.equal(s.deepCount, 2);
  assert.equal(s.deepMs, 75 * MIN);
  assert.equal(s.deepFrac, (75 * MIN) / (89 * MIN));
});

test("freeBlockStats should drop malformed and non-positive intervals", () => {
  const s = freeBlockStats([
    [baseMs, baseMs],                       // zero length
    [baseMs + 1000, baseMs],                // inverted
    [NaN, baseMs + 1000],                   // unparseable
    [baseMs, baseMs + 10 * MIN],            // the only real block
    null,
  ]);
  assert.equal(s.count, 1);
  assert.equal(s.totalMs, 10 * MIN);
});

// ---------------------------------------------------------------------------
// freeBucketStats — the four buckets the card reads its percentages off
// ---------------------------------------------------------------------------

// lens(minutes...) → the bucket table for those block lengths, keyed by label.
function lens(...minutes) {
  const s = freeBucketStats(minutes.map((m) => m * MIN));
  const by = {};
  for (const b of s.buckets) by[b.label] = b;
  return { s, by };
}

test("freeBucketStats should split the blocks into the four buckets, longest first", () => {
  const { s } = lens(90, 30, 10, 2);
  assert.deepEqual(s.buckets.map((b) => b.label), ["1h+", "15m–1h", "5–15m", "<5m"],
    "the legend reads left to right in the same order the ranked plot draws");
  assert.deepEqual(s.buckets.map((b) => b.count), [1, 1, 1, 1]);
  assert.equal(s.totalMs, 132 * MIN);
});

test("freeBucketStats should report each bucket's share of all block time", () => {
  const { by, s } = lens(60, 20, 10, 10);
  assert.equal(s.totalMs, 100 * MIN);
  assert.deepEqual(s.buckets.map((b) => b.frac), [0.6, 0.2, 0.2, 0]);
  assert.equal(by["5–15m"].ms, 20 * MIN, "two ten-minute blocks, not one twenty");
  assert.equal(by["5–15m"].count, 2);
});

test("freeBucketStats should place a block exactly on an edge in the longer bucket", () => {
  const { s } = lens(60, 15, 5);
  assert.deepEqual(s.buckets.map((b) => b.count), [1, 1, 1, 0],
    "each edge opens its bucket, matching freeBlockStats' bins");
});

test("freeBucketStats should agree with the deep and fragment lines the card brackets", () => {
  // The two usable buckets ARE the ≥15m share, and the last bucket IS the
  // fringe — the card prints both, so they must not drift apart.
  const mins = [90, 20, 16, 9, 3, 1];
  const { s } = lens(...mins);
  const blocks = freeBlockStats(mins.map((m) => [baseMs, baseMs + m * MIN]));
  const usableMs = s.buckets[0].ms + s.buckets[1].ms;
  assert.equal(usableMs, blocks.deepMs);
  assert.equal(s.buckets[0].count + s.buckets[1].count, blocks.deepCount);
  assert.equal(s.buckets[3].ms, blocks.fragMs);
  assert.equal(s.buckets[3].count, blocks.fragCount);
  assert.equal(FREE_BUCKETS[1].minMs, FREE_BLOCK_DEEP_MS);
  assert.equal(FREE_BUCKETS[2].minMs, FREE_BLOCK_FRAG_MS);
});

test("freeBucketStats should hand each bucket its own blocks, longest first", () => {
  const { by } = lens(7, 40, 6, 25, 12);
  assert.deepEqual(by["15m–1h"].blocksMs.map((ms) => ms / MIN), [40, 25]);
  assert.deepEqual(by["5–15m"].blocksMs.map((ms) => ms / MIN), [12, 7, 6],
    "the renderer draws a bucket's bars without re-sorting them");
  assert.equal(by["1h+"].blocksMs.length, 0);
});

test("freeBucketStats should return empty buckets rather than nothing for a day with no blocks", () => {
  const s = freeBucketStats([]);
  assert.equal(s.totalMs, 0);
  assert.deepEqual(s.buckets.map((b) => b.count), [0, 0, 0, 0], "the legend still has four cells to draw");
  assert.deepEqual(s.buckets.map((b) => b.frac), [null, null, null, null], "no share, rather than a fabricated 0%");
  assert.equal(freeBucketStats(null).buckets.length, 4);
});

test("freeBucketStats should drop non-positive and malformed lengths", () => {
  const s = freeBucketStats([0, -5 * MIN, NaN, null, undefined, 30 * MIN]);
  assert.equal(s.totalMs, 30 * MIN);
  assert.deepEqual(s.buckets.map((b) => b.count), [0, 1, 0, 0]);
});

// ---------------------------------------------------------------------------
// rawSessionId — joining lanes to stores keyed by the bare session UUID
// ---------------------------------------------------------------------------

test("rawSessionId should strip the lane's own provider namespace in the merged view", () => {
  const lane = { provider: "claude", session_id: "claude:abc-123" };
  assert.equal(rawSessionId(lane), "abc-123");
});

test("rawSessionId should pass a single-provider id through unchanged", () => {
  assert.equal(rawSessionId({ session_id: "abc-123" }), "abc-123");
});

test("rawSessionId should not strip a foreign or coincidental prefix", () => {
  // A different provider's prefix (or an id that merely contains a colon)
  // is not this lane's namespace — leave it alone.
  assert.equal(rawSessionId({ provider: "arachne", session_id: "claude:abc" }), "claude:abc");
});

test("rawSessionId should return null when the lane has no session id", () => {
  assert.equal(rawSessionId({ pid: 42 }), null);
  assert.equal(rawSessionId(null), null);
});

// ---------------------------------------------------------------------------
// provider adapters — mixed Claude/Codex roots and canonical child threads
// ---------------------------------------------------------------------------

test("laneProvider should distinguish Codex from Claude inside one switchboard source", () => {
  assert.equal(laneProvider({ agent: "claude" }), "claude");
  assert.equal(laneProvider({ agent: "codex" }), "codex");
  assert.equal(laneProvider({ provider: "claude", agent: "codex" }), "codex",
    "legacy merged configs called the whole switchboard source claude");
  assert.equal(laneProvider({ provider: "arachne", agent: "opus" }), "arachne");
});

test("providerLabel should give Codex its product and company identity", () => {
  assert.equal(providerLabel("codex"), "Codex / OpenAI");
  assert.equal(providerLabel("claude"), "Claude");
  assert.equal(providerLabel("arachne"), "Arachne");
});

test("adaptProviderTimeline should project nested Codex threads without duplicating Claude subagents", () => {
  const claude = {
    session_id: "claude:c-root", provider: "claude", agent: "claude", pid: 1,
    start: at(0), end: at(10),
    intervals: [
      { status: "working", start: at(0), end: at(5) },
      { status: "dormant", start: at(5), end: at(7), subagents: 1 },
      { status: "working", start: at(7), end: at(10) },
    ],
    subagents: [{ agent_type: "Explore", tool_use_id: "legacy", start: at(5), end: at(7) }],
  };
  const codex = {
    // The source namespace says claude because that is what older provider
    // configs called switchboard-ctl. lane.agent is the semantic provider.
    session_id: "claude:x-root", provider: "claude", agent: "codex", pid: 2,
    start: at(0), end: at(10),
    intervals: [{ status: "working", start: at(0), end: at(10) }],
  };
  const input = {
    lanes: [claude, codex],
    summary: { by_status: { working: 18 * 60e9, dormant: 2 * 60e9 }, attention_union: 10 * 60e9, attention_per_session: 20 * 60e9, attention_fanout: 20 * 60e9 },
    totals: { subagents: 1 },
    agent_timeline: {
      roots: [{
        session_id: "claude:x-root", provider: "codex", pid: 2,
        nodes: [
          {
            thread_id: "child-a", parent_thread_id: "x-root", nickname: "Atlas", role: "explorer", depth: 1,
            runtime: "idle", attention_state: "none", lifecycle: "completed",
            activity: [{ start: at(2), end: at(8) }],
            attention: [{ reason: "approval", start: at(3), end: at(4) }],
          },
          {
            thread_id: "child-b", parent_thread_id: "child-a", role: "reviewer", depth: 2,
            runtime: "idle", attention_state: "none", lifecycle: "completed",
            activity: [{ start: at(4), end: at(6) }],
          },
        ],
      }],
      summary: {},
    },
  };

  const got = adaptProviderTimeline(input);
  assert.notEqual(got, input, "the wire payload remains untouched");
  assert.equal(got.lanes[0].subagents.length, 1, "Claude keeps only its native legacy projection");
  assert.equal(got.lanes[1].subagents.length, 2, "Codex receives one bar per canonical child activity span");
  assert.deepEqual(got.lanes[1].subagents.map((child) => child.tool_use_id), ["child-a", "child-b"]);
  assert.equal(got.lanes[1].subagents[0].agent_type, "Atlas");
  assert.equal(got.lanes[1].subagents[1].agent_type, "reviewer");
  assert.equal(got.lanes[1].subagents[1].depth, 2, "nested graph depth reaches the sub-bar record");
  assert.equal(got.lanes[1].subagents[0].attention[0].reason, "approval");
  assert.deepEqual(got.lanes.map((lane) => lane.data_provider), ["claude", "codex"],
    "mixed roots get provider accents even though their adapter namespace is shared");

  assert.deepEqual(got.lanes[1].intervals, codex.intervals,
    "an active child does not imply the Codex root stopped working");
  assert.strictEqual(got.summary, input.summary,
    "canonical graph evidence stays additive instead of silently rewriting the legacy summary");
  assert.strictEqual(got.totals, input.totals,
    "canonical nodes are not reclassified as legacy Task launches");
  const profile = concurrencyProfile(workIntervalsMs(got.lanes));
  assert.equal(profile.maxN, 4, "nested Codex children are visible as separate agents aloft");
  assert.equal(profile.integralMs, 28 * MIN,
    "Codex root work and child work remain separately observable when they overlap");
  assert.deepEqual(graphAwareAttention(got.summary, got.lanes), {
    attention_union: 10 * 60e9,
    attention_per_session: 20 * 60e9,
    attention_fanout: 28 * 60e9,
  }, "graph-aware headline accounting is derived without mutating the wire summary");
});

test("adaptProviderTimeline should degrade without changing accounting when canonical child history is absent", () => {
  const input = {
    lanes: [{ session_id: "x", agent: "codex", intervals: [] }],
    summary: { attention_fanout: 7 }, totals: { subagents: 0 },
  };
  const got = adaptProviderTimeline(input);
  assert.deepEqual(got.summary, input.summary);
  assert.deepEqual(got.totals, input.totals);
  assert.equal(got.lanes[0].data_provider, "codex",
    "a Codex-only live feed still opts into the provider label and accent");
  assert.deepEqual(providerLegend(got.lanes), [{
    provider: "codex", label: "Codex / OpenAI", count: 1,
  }], "the rendered provider key remains visible for one online Codex session");
  assert.deepEqual(got.lanes[0].subagents, undefined);
  assert.deepEqual(graphAwareAttention(input.summary, got.lanes), {
    attention_union: 0,
    attention_per_session: 0,
    attention_fanout: 7,
  }, "old and activity-free payloads keep the producer's established figures");
});

test("adaptProviderTimeline should keep a lone Claude feed visually untagged", () => {
  const got = adaptProviderTimeline({ lanes: [{ session_id: "c", agent: "claude", intervals: [] }] });
  assert.equal(got.lanes[0].data_provider, undefined);
  assert.deepEqual(providerLegend(got.lanes), []);
});

test("adaptProviderTimeline should preserve stop-and-restart spans for one exact Codex child", () => {
  const input = {
    lanes: [{
      session_id: "root", agent: "codex", pid: 7,
      intervals: [{ status: "working", start: at(0), end: at(20) }],
    }],
    summary: { attention_union: 20 * MIN * 1e6, attention_per_session: 20 * MIN * 1e6, attention_fanout: 20 * MIN * 1e6 },
    agent_timeline: { roots: [{
      session_id: "root", pid: 7, provider: "codex",
      nodes: [{
        thread_id: "child", parent_thread_id: "root", nickname: "Atlas", depth: 1,
        runtime: "idle", attention_state: "none", lifecycle: "completed",
        activity: [
          { start: at(2), end: at(12) },
          { start: at(14), end: at(18) },
        ],
      }],
    }], summary: { agent_activity: 14 * MIN * 1e6 } },
  };

  const got = adaptProviderTimeline(input);
  assert.deepEqual(got.lanes[0].subagents.map((span) => [span.tool_use_id, span.start, span.end]), [
    ["child", at(2), at(12)],
    ["child", at(14), at(18)],
  ], "one child identity may contribute several disjoint activity intervals");
  assert.equal(concurrencyProfile(workIntervalsMs(got.lanes)).integralMs, 34 * MIN,
    "the root and both exact child intervals contribute to fanout");
});

test("adaptProviderTimeline should not infer fanout from topology-only Codex children", () => {
  const input = {
    lanes: [{ session_id: "root", agent: "codex", pid: 7, intervals: [] }],
    summary: { attention_fanout: 11 },
    agent_timeline: { roots: [{
      session_id: "root", pid: 7, provider: "codex",
      nodes: [{
        thread_id: "child", parent_thread_id: "root", depth: 1,
        runtime: "not_loaded", attention_state: "none", lifecycle: "unknown",
      }],
    }], summary: {} },
  };

  const got = adaptProviderTimeline(input);
  assert.equal(got.lanes[0].subagents, undefined,
    "structural presence without positive lifecycle evidence is not activity");
  assert.equal(graphAwareAttention(got.summary, got.lanes).attention_fanout, 11,
    "a topology-only node does not opt the headline into inferred accounting");
});

// ---------------------------------------------------------------------------
// suspect lanes — the plausibility post-check (switchboard-dashboard#2)
// ---------------------------------------------------------------------------

// a six-hour lane whose last five hours nothing ever observed
function ghostLane() {
  return {
    session_id: "ghost",
    start: at(0),
    end: at(360),
    intervals: [{ status: "working", start: at(0), end: at(360) }],
    suspect: true,
    suspect_reason: "unclosed lane stretched to now: silent 5h0m0s >= 4h0m0s cap",
    suspect_since: at(60),
  };
}

test("laneActiveMs should stop at the evidence bound when the lane is suspect", () => {
  assert.equal(laneActiveMs(ghostLane()), 60 * MIN);
});

test("laneActiveMs should count the whole lane when it is not flagged", () => {
  const lane = ghostLane();
  lane.suspect = false;
  assert.equal(laneActiveMs(lane), 360 * MIN);
});

test("laneActiveMs should count the whole lane when suspect_since is unusable", () => {
  // Fail open: a malformed timestamp must not silently erase real work.
  const lane = ghostLane();
  lane.suspect_since = "not-a-timestamp";
  assert.equal(laneActiveMs(lane), 360 * MIN);
  const missing = ghostLane();
  delete missing.suspect_since;
  assert.equal(laneActiveMs(missing), 360 * MIN);
});

test("laneActiveMs should drop intervals that start inside the synthesized tail", () => {
  const lane = ghostLane();
  lane.intervals = [
    { status: "working", start: at(0), end: at(30) },   // wholly trusted
    { status: "idle", start: at(30), end: at(90) },     // straddles the bound
    { status: "working", start: at(90), end: at(360) }, // wholly synthesized
  ];
  assert.equal(laneActiveMs(lane), 60 * MIN);
});

test("suspectSinceMs should return null for a lane the producer did not flag", () => {
  assert.equal(suspectSinceMs({ intervals: [] }), null);
  assert.equal(suspectSinceMs(null), null);
});

test("suspectTailMs should span from the last evidence to the lane end", () => {
  assert.deepEqual(suspectTailMs(ghostLane()), [baseMs + 60 * MIN, baseMs + 360 * MIN]);
});

test("suspectTailMs should return null when there is no tail to draw", () => {
  const lane = ghostLane();
  lane.end = lane.suspect_since; // flagged, but nothing was synthesized
  assert.equal(suspectTailMs(lane), null);
  assert.equal(suspectTailMs({ start: at(0), end: at(10) }), null);
});

// clipSpanMs boundaries. These four cases are the contract shared with
// clipToTrusted in internal/timeline/suspect.go — the Go merge and this model
// re-derive the same figures from the same envelope, so they have to agree on
// every edge or a merged day silently disagrees with a single-provider one.
test("clipSpanMs should drop a span that starts exactly at the cut", () => {
  assert.equal(clipSpanMs(ms(60), ms(90), ms(60)), null);
});

test("clipSpanMs should keep a span that ends exactly at the cut in full", () => {
  assert.deepEqual(clipSpanMs(ms(30), ms(60), ms(60)), [ms(30), ms(60)]);
});

test("clipSpanMs should drop a zero-length span at the cut", () => {
  assert.equal(clipSpanMs(ms(60), ms(60), ms(60)), null);
});

test("clipSpanMs should drop an inverted span whether or not a cut applies", () => {
  assert.equal(clipSpanMs(ms(60), ms(30), null), null);
  assert.equal(clipSpanMs(ms(60), ms(30), ms(90)), null);
  assert.equal(clipSpanMs(ms(60), ms(30), ms(45)), null);
});

test("clipSpanMs should trim a straddling span and pass a trusted one through", () => {
  assert.deepEqual(clipSpanMs(ms(30), ms(90), ms(60)), [ms(30), ms(60)]);
  assert.deepEqual(clipSpanMs(ms(0), ms(30), null), [ms(0), ms(30)]);
});

test("clipSpanMs should drop a span with an unparseable endpoint", () => {
  assert.equal(clipSpanMs(NaN, ms(30), null), null);
  assert.equal(clipSpanMs(ms(0), NaN, ms(60)), null);
});

// ---------------------------------------------------------------------------
// suspect lanes: the aloft chart and the projects view. Both re-derive agent
// time from the same lanes the producer already summarized, so both have to
// clip at the evidence bound — otherwise the chart's "active" readout and the
// attention card's union disagree on the same page.
// ---------------------------------------------------------------------------

// a suspect lane whose synthesized tail carries a phantom subagent: the exact
// shape of the 2026-07-22 episode, where three phantom spans each read as 4½
// hours of work nobody ever did.
function ghostLaneWithPhantom() {
  const lane = ghostLane();
  lane.project = "alpha";
  lane.subagents = [{ agent_type: "Explore", start: at(60), end: at(360), suspect: true }];
  return lane;
}

test("workIntervalsMs should hold a suspect lane's working interval to the evidence bound", () => {
  assert.deepEqual(workIntervalsMs([ghostLane()]), [[ms(0), ms(60)]]);
});

test("workIntervalsMs should not credit a phantom subagent span at all", () => {
  assert.deepEqual(workIntervalsMs([ghostLaneWithPhantom()]), [[ms(0), ms(60)]]);
});

test("workIntervalsMs should trim a non-phantom subagent span at the evidence bound", () => {
  // A span the producer did NOT flag still cannot run past the last evidence:
  // it is trimmed, not dropped, so its trusted head is kept.
  const lane = ghostLane();
  lane.subagents = [{ start: at(30), end: at(120) }];
  assert.deepEqual(workIntervalsMs([lane]), [[ms(0), ms(60)], [ms(30), ms(60)]]);
});

test("workIntervalsMs should count an unflagged lane's spans in full", () => {
  const lane = ghostLaneWithPhantom();
  lane.suspect = false;
  lane.subagents[0].suspect = false;
  assert.deepEqual(workIntervalsMs([lane]), [[ms(0), ms(360)], [ms(60), ms(360)]]);
});

test("the aloft chart should agree with the producer's union on a ghost lane", () => {
  // The regression this whole guard exists for: before the clip, the chart
  // labeled 6h "active" and peaked at 2 agents on a lane the summary credited
  // one hour of, with only one agent ever evidenced.
  const prof = concurrencyProfile(workIntervalsMs([ghostLaneWithPhantom()]));
  assert.equal(prof.activeMs, 60 * MIN, "active time matches attention_union");
  assert.equal(prof.maxN, 1, "only one agent was ever evidenced");
  assert.equal(prof.integralMs, 60 * MIN, "no phantom agent-minutes");
  assert.equal(laneActiveMs(ghostLaneWithPhantom()), prof.activeMs);
});

test("projectHoursMs should credit a suspect lane only its evidenced fanout", () => {
  // Unclipped this project reads 11h — 6h of lane plus a 5h phantom — against
  // the 1h the producer's fanout reports.
  const rows = projectHoursMs([ghostLaneWithPhantom()]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].project, "alpha");
  assert.equal(rows[0].ms, 60 * MIN);
  assert.equal(rows[0].parts[0].ms, 60 * MIN, "the session's stacked part is clipped too");
});

test("projectHoursMs should drop a lane whose evidenced work is entirely phantom", () => {
  // Nothing survives the clip, so the lane contributes no part and the project
  // disappears rather than showing a zero-hour row.
  const lane = ghostLaneWithPhantom();
  lane.intervals = [{ status: "working", start: at(60), end: at(360) }];
  assert.deepEqual(projectHoursMs([lane]), []);
});

test("projectHoursMs should count an unflagged lane's spans in full", () => {
  const lane = ghostLaneWithPhantom();
  lane.suspect = false;
  lane.subagents[0].suspect = false;
  assert.equal(projectHoursMs([lane])[0].ms, 360 * MIN + 300 * MIN);
});

// ---------------------------------------------------------------------------
// session summary rendering — task bullets vs. prose on the pinned card
// ---------------------------------------------------------------------------

test("summaryBodyHTML should list the tasks above the prose when the summary has tasks", () => {
  const html = summaryBodyHTML({
    description: "Did three jobs",
    tasks: ["Fixed the lookup", "Added the endpoint"],
    summary: "A mixed session that landed on main.",
  });
  assert.match(html, /<ul class="po-tasks">/, "tasks render as a bullet list");
  assert.match(html, /<li>Fixed the lookup<\/li><li>Added the endpoint<\/li>/, "one li per task, in order");
  assert.ok(
    html.indexOf('class="po-tasks"') < html.indexOf('class="po-summary"'),
    "the bullets sit above the framing prose",
  );
});

test("summaryBodyHTML should render prose alone when the summary has no tasks", () => {
  // pre-v2 records (and genuinely single-task sessions) must keep the old layout.
  for (const sum of [
    { description: "d", summary: "One continuous task." },
    { description: "d", tasks: [], summary: "One continuous task." },
    { description: "d", tasks: ["   ", ""], summary: "One continuous task." },
  ]) {
    const html = summaryBodyHTML(sum);
    assert.doesNotMatch(html, /po-tasks/, "no empty bullet list");
    assert.equal(html, `<div class="po-summary">One continuous task.</div>`);
  }
});

test("summaryBodyHTML should escape markup when a task or the prose contains HTML", () => {
  const html = summaryBodyHTML({
    tasks: ["<img src=x onerror=alert(1)> & \"quoted\""],
    summary: "<script>alert(2)</script>",
  });
  assert.doesNotMatch(html, /<img|<script/, "no raw markup survives into the card");
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; &amp; &quot;quoted&quot;/);
  assert.match(html, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
});

test("summaryBodyHTML should render nothing when there is no summary record", () => {
  assert.equal(summaryBodyHTML(null), "");
  assert.equal(summaryBodyHTML({ description: "d" }), "");
});

test("summaryTasks should trim entries and drop empties when the model pads the list", () => {
  assert.deepEqual(summaryTasks({ tasks: ["  Fixed it  ", "", "   ", null, "Shipped it"] }),
    ["Fixed it", "Shipped it"]);
  assert.deepEqual(summaryTasks(null), []);
});

test("summaryTasks should yield no tasks when the field is not an array", () => {
  // unreachable through the shipped endpoint, which always sends an array —
  // but the helper must not throw for a caller that reuses it on raw input.
  for (const tasks of ["a\nb", 42, true, { 1: "Fixed it" }]) {
    assert.deepEqual(summaryTasks({ description: "d", tasks }), []);
  }
  assert.equal(summaryBodyHTML({ tasks: "a\nb", summary: "Prose." }),
    `<div class="po-summary">Prose.</div>`);
  assert.equal(summaryHintText({ tasks: "a\nb", summary: "Prose." }),
    "click for the session summary");
});

test("summaryHintText should advertise the step count when the session had several tasks", () => {
  assert.equal(
    summaryHintText({ tasks: ["a", "b", "c", "d", "e"], summary: "s" }),
    "click for 5 steps",
  );
});

test("summaryHintText should keep the plain hint when there are no tasks to count", () => {
  assert.equal(summaryHintText({ summary: "s" }), "click for the session summary");
  assert.equal(summaryHintText({ tasks: ["only one"], summary: "s" }), "click for the session summary");
});

test("summaryHintText should advertise the summary when a lone task is all the digest holds", () => {
  // the tooltip shows the description only, so that one bullet is still
  // something new behind the click even with no prose to follow it.
  const sum = { description: "d", tasks: ["Fixed the lookup"] };
  assert.equal(summaryHintText(sum), "click for the session summary");
  assert.notEqual(summaryBodyHTML(sum), "", "the card does render that bullet");
});

test("summaryHintText should still promise details when the digest has nothing", () => {
  // Every session bar pins a card now — identity, cost, tokens, memory — so the
  // hint can never be empty. Before, a digest-less session was unclickable and
  // its pid and spend were reachable from nowhere at all.
  for (const sum of [
    null, {}, { name: "amber-kite" }, { description: "d" },
    { description: "d", tasks: [] }, { description: "d", tasks: ["  "] },
  ]) {
    assert.equal(summaryHintText(sum), "click for details", `for ${JSON.stringify(sum)}`);
    assert.equal(summaryBodyHTML(sum), "", "and the digest contributes no body");
  }
});

test("summaryHintText should sharpen the promise exactly as far as the digest allows", () => {
  // three tiers, in order of how precisely the card can be described: a counted
  // list of steps, a summary, or just "details".
  const cases = [
    [{ description: "d", tasks: ["a", "b"] }, "click for 2 steps"],
    [{ description: "", tasks: ["a", "b"], summary: "Prose." }, "click for 2 steps"],
    [{ description: "d", summary: "Prose." }, "click for the session summary"],
    [{ tasks: ["only one"] }, "click for the session summary"],
    [{ description: "d", tasks: "a\nb", summary: "Prose." }, "click for the session summary"],
    [{ name: "amber-kite", description: "Reworked the gate" }, "click for details"],
  ];
  for (const [sum, want] of cases) {
    assert.equal(summaryHintText(sum), want, `for ${JSON.stringify(sum)}`);
  }
});

// ---------------------------------------------------------------------------
// token spend — digest.tokens as /api/summaries serves it
// ---------------------------------------------------------------------------

// A record in the shape internal/sessiondigest writes, with the real numbers
// from one switchboard-dashboard session (236 responses across 413 records).
function tokensFixture(overrides) {
  return Object.assign({
    main: {
      responses: 236, inputFresh: 646, cacheCreation: 259595, cacheCreation1h: 259595,
      cacheRead: 34532761, output: 104821, peakTurnInput: 236518,
    },
    byModel: {
      "claude-opus-5": {
        responses: 236, inputFresh: 646, cacheCreation: 259595,
        cacheRead: 34532761, output: 104821, peakTurnInput: 236518,
      },
    },
  }, overrides);
}

test("fmtTokens should scale a count to the unit a reader can hold", () => {
  assert.equal(fmtTokens(2), "2");
  assert.equal(fmtTokens(999), "999");
  assert.equal(fmtTokens(1000), "1k");
  assert.equal(fmtTokens(9500), "9.5k");
  assert.equal(fmtTokens(104821), "105k");
  assert.equal(fmtTokens(34532761), "35M");
  assert.equal(fmtTokens(2400000000), "2.4B");
  assert.equal(fmtTokens(undefined), "—", "an absent count must not render as 0");
});

test("shortModel should drop the constant prefix and the dated suffix", () => {
  assert.equal(shortModel("claude-opus-5"), "opus-5");
  assert.equal(shortModel("claude-haiku-4-5-20251001"), "haiku-4-5");
  assert.equal(shortModel(""), "");
});

test("tokenBilled should sum all three input components, not input_tokens alone", () => {
  // The trap the whole feature turns on: inputFresh is the UNCACHED REMAINDER,
  // here 646 against 34.8M actually sent. Reporting it as "input" is off by
  // four orders of magnitude.
  const main = tokensFixture().main;
  assert.equal(tokenBilled(main), 646 + 259595 + 34532761);
  assert.notEqual(tokenBilled(main), main.inputFresh);
  assert.equal(tokenBilled(null), 0);
});

test("tokenTotals should fold delegated spend into the headline while keeping the split", () => {
  // A subagent's tokens are still this session's spend, so the headline sums
  // both; the delegated share stays separately readable.
  const t = tokenTotals(tokensFixture({
    sidechain: {
      responses: 55, inputFresh: 101, cacheCreation: 352990,
      cacheRead: 2646005, output: 14546, peakTurnInput: 97105,
    },
  }));
  assert.equal(t.output, 104821 + 14546);
  assert.equal(t.responses, 236 + 55);
  assert.equal(t.cacheRead, 34532761 + 2646005);
  assert.equal(t.delegatedOutput, 14546);
  assert.equal(t.delegatedResponses, 55);
});

test("tokenTotals should report peak context from the main chain alone", () => {
  // A subagent runs its own conversation in its own window. Folding its peak in
  // — by summing, or by taking a max that could come from the subagent — would
  // report a context size that never existed on either side.
  const t = tokenTotals(tokensFixture({
    sidechain: { responses: 3, output: 10, cacheRead: 5, peakTurnInput: 999999 },
  }));
  assert.equal(t.peakContext, 236518, "peak context is the session's own high-water mark");
});

test("tokenTotals should report nothing when no response was ever recorded", () => {
  assert.equal(tokenTotals(null), null);
  assert.equal(tokenTotals({}), null);
  assert.equal(tokenTotals({ main: { responses: 0 } }), null);
});

test("tokenRowsHTML should render nothing when the session never called the API", () => {
  // A lane with no record must render exactly as it did before the feature.
  assert.equal(tokenRowsHTML(null), "");
  assert.equal(tokenRowsHTML(undefined), "");
  assert.equal(tokenRowsHTML({ main: { responses: 0 } }), "");
});

test("tokenRowsHTML should show output, billed input, and the cache split", () => {
  const html = tokenRowsHTML(tokensFixture());
  assert.match(html, /105k<\/b> out/, "output leads");
  assert.match(html, /35M<\/b> in/, "billed input, not the 646-token remainder");
  assert.ok(!html.includes("646"), "the uncached remainder is never shown as the input figure");
  assert.match(html, /35M read/, "the cache read is broken out — it is a tenth the price");
  assert.match(html, /260k written/);
  assert.match(html, /peak ctx<\/span> 237k/);
  assert.match(html, /236 turns/);
});

test("tokenRowsHTML should keep every row inside the tooltip's width", () => {
  // The tooltip is ~44 monospace columns; a row that wraps reads as two ragged
  // half-facts, which is what the three-row split exists to prevent.
  const html = tokenRowsHTML(tokensFixture({
    sidechain: { responses: 55, output: 14546, cacheRead: 2646005, peakTurnInput: 97105 },
    byModel: {
      "claude-opus-5": { responses: 236, output: 104821, cacheRead: 34532761 },
      "claude-haiku-4-5-20251001": { responses: 55, output: 14546, cacheRead: 2646005 },
    },
  }));
  for (const row of html.split("</div>").filter((r) => r.trim())) {
    const text = row.replace(/<[^>]*>/g, "");
    assert.ok(text.length <= 44, `row is ${text.length} columns and will wrap: ${text}`);
  }
});

test("tokenRowsHTML should break out the models only when a session used several", () => {
  const single = tokenRowsHTML(tokensFixture());
  assert.ok(!single.includes("opus-5"), "one model needs no breakdown");

  const mixed = tokenRowsHTML(tokensFixture({
    byModel: {
      "claude-opus-5": { responses: 200, output: 90000, cacheRead: 30000000 },
      "claude-fable-5": { responses: 36, output: 14821, cacheRead: 4532761 },
    },
  }));
  assert.match(mixed, /opus-5<\/span> 90k/);
  assert.match(mixed, /fable-5<\/span> 15k/);
  // heaviest first: a session total is not convertible to cost without knowing
  // which model spent the bulk of it.
  assert.ok(mixed.indexOf("opus-5") < mixed.indexOf("fable-5"), "sorted by output, heaviest first");
});

test("tokenRowsHTML should omit the delegated row when the session delegated nothing", () => {
  assert.ok(!tokenRowsHTML(tokensFixture()).includes("delegated"));
  const delegated = tokenRowsHTML(tokensFixture({
    sidechain: { responses: 55, output: 14546, cacheRead: 2646005, peakTurnInput: 97105 },
  }));
  assert.match(delegated, /delegated<\/span> 15k out/);
  assert.match(delegated, /over 55 turns/);
});

test("tokenRowsHTML should use the caller's row class so both surfaces are styled", () => {
  // .tooltip .t-row and .popout .po-row are scoped separately, so a hardcoded
  // class renders unstyled rows on whichever surface it does not match.
  assert.match(tokenRowsHTML(tokensFixture()), /class="t-row"/);
  assert.match(tokenRowsHTML(tokensFixture(), "po-row"), /class="po-row"/);
  assert.ok(!tokenRowsHTML(tokensFixture(), "po-row").includes(`class="t-row"`));
});

test("tokenRowsHTML should escape a model name before interpolating it", () => {
  const html = tokenRowsHTML(tokensFixture({
    byModel: {
      "claude-<img src=x onerror=alert(1)>": { responses: 1, output: 10 },
      "claude-opus-5": { responses: 1, output: 20 },
    },
  }));
  assert.ok(!html.includes("<img"), "markup in a model id must not reach innerHTML");
  assert.match(html, /&lt;img/);
});

// ---------------------------------------------------------------------------
// normalizeView — the chart-view name, incl. the pre-rename "bars" spelling
// ---------------------------------------------------------------------------

test("normalizeView should resolve the legacy 'bars' spelling to 'sessions'", () => {
  // Guards the rename's back-compat: every persisted sb-view and every existing
  // ?view=bars link still lands on the sessions view. Deleting this branch would
  // silently break both.
  assert.equal(normalizeView("bars"), "sessions");
});

test("normalizeView should pass the current view names through unchanged", () => {
  assert.equal(normalizeView("sessions"), "sessions");
  assert.equal(normalizeView("line"), "line");
  assert.equal(normalizeView("projects"), "projects");
});

test("normalizeView should return null when the view is unknown or missing", () => {
  // Both call sites fall back on a falsy return, so absent must be as falsy as bogus.
  assert.equal(normalizeView(null), null);
  assert.equal(normalizeView(undefined), null);
  assert.equal(normalizeView(""), null);
  assert.equal(normalizeView("foo"), null);
});

// ---------------------------------------------------------------------------
// ISO calendar arithmetic — the date popover's grid and paging
// ---------------------------------------------------------------------------

test("parseISODate should reject anything that is not a whole ISO day", () => {
  // Date.parse takes "2026", an RFC3339 instant and even 2026-02-31 (rolling it
  // into March). Any of those reaching the grid would move the calendar to a
  // day the caller never named.
  assert.ok(Number.isFinite(parseISODate("2026-08-05")));
  assert.ok(Number.isNaN(parseISODate("2026-02-31")));
  assert.ok(Number.isNaN(parseISODate("2026-08-05T12:00:00Z")));
  assert.ok(Number.isNaN(parseISODate("2026-8-5")));
  assert.ok(Number.isNaN(parseISODate("2026")));
  assert.ok(Number.isNaN(parseISODate("")));
  assert.ok(Number.isNaN(parseISODate(null)));
});

// ---------------------------------------------------------------------------
// the plot window: a named LOCAL day, not merely the busy stretch inside it
//
// Written to hold in any TZ the suite happens to run in, so they assert the
// properties (midnight, one calendar day long, live edge honoured) rather than
// baked epoch numbers from the author's zone.
// ---------------------------------------------------------------------------

test("localDayBoundsMs should return local midnight to local midnight", () => {
  const { t0, t1 } = localDayBoundsMs("2026-08-13");
  const a = new Date(t0), b = new Date(t1);
  assert.equal(a.getHours(), 0);
  assert.equal(a.getMinutes(), 0);
  assert.equal(a.getDate(), 13);
  assert.equal(b.getHours(), 0);
  assert.equal(b.getDate(), 14);
});

test("localDayBoundsMs should give a DST day its true 23 or 25 hours", () => {
  // Built by handing day+1 to the Date constructor, not by adding 24h: in a zone
  // that shifts, the two transition days really are 23h and 25h wide, and a
  // window one hour off would clip an hour of work off the end of the day.
  for (const iso of ["2026-03-08", "2026-11-01", "2026-08-13"]) {
    const { t0, t1 } = localDayBoundsMs(iso);
    const hours = (t1 - t0) / 3600e3;
    assert.ok(hours >= 23 && hours <= 25, `${iso} spans ${hours}h`);
    assert.equal(new Date(t1 - 1).getDate(), Number(iso.slice(8)));
  }
});

test("localDayBoundsMs should be NaN for anything that is not a whole ISO day", () => {
  for (const bad of ["2026-02-31", "2026-8-5", "", null, "2026-08-05T12:00:00Z"]) {
    assert.ok(Number.isNaN(localDayBoundsMs(bad).t0));
    assert.ok(Number.isNaN(localDayBoundsMs(bad).t1));
  }
});

test("dayWindowMs should frame a closed day whole, however short the work was", () => {
  const day = localDayBoundsMs("2026-08-13");
  const workFrom = day.t0 + 13 * 3600e3, workTo = day.t0 + 14 * 3600e3;
  const w = dayWindowMs("2026-08-13", workFrom, workTo, day.t1 + 5 * 3600e3);
  assert.equal(w.t0, day.t0, "starts at midnight, not at the first session");
  assert.equal(w.t1, day.t1, "runs to midnight, not to the last session");
});

test("dayWindowMs should stop the day in progress at now", () => {
  const day = localDayBoundsMs("2026-08-13");
  const now = day.t0 + 17 * 3600e3;
  const w = dayWindowMs("2026-08-13", day.t0 + 3600e3, now - 60e3, now);
  assert.equal(w.t0, day.t0);
  assert.equal(w.t1, now, "a day still being written has no future to draw");
});

test("dayWindowMs should let data widen the window but never narrow it", () => {
  const day = localDayBoundsMs("2026-08-13");
  // a session that started before midnight is drawn whole, not clipped
  const before = day.t0 - 2 * 3600e3;
  const closed = dayWindowMs("2026-08-13", before, day.t0 + 3600e3, day.t1 + 1);
  assert.equal(closed.t0, before);
  assert.equal(closed.t1, day.t1);

  // a live tail can run past the sample of `now` the caller passed in
  const now = day.t0 + 17 * 3600e3;
  const tail = now + 90e3;
  const live = dayWindowMs("2026-08-13", day.t0, tail, now);
  assert.equal(live.t1, tail);
});

test("dayWindowMs should ignore a day the data does not touch at all", () => {
  // a payload from another day entirely (a mislabeled window, or the dev stub
  // that answers every day with one fixture): uniting the two would draw weeks
  // of empty canvas around two specks of work.
  const june = localDayBoundsMs("2026-06-26");
  const w = dayWindowMs("2026-08-13", june.t0 + 3600e3, june.t0 + 7200e3, Date.now());
  assert.deepEqual(w, { t0: june.t0 + 3600e3, t1: june.t0 + 7200e3 });
});

test("dayWindowMs should fall back to the data's own bounds with no named day", () => {
  const w = dayWindowMs("", 1000, 5000, 9000);
  assert.deepEqual(w, { t0: 1000, t1: 5000 });
});

test("dayWindowMs should always return a positive span", () => {
  const day = localDayBoundsMs("2026-08-13");
  // the pathological case: an empty live day whose `now` is midnight itself
  const w = dayWindowMs("2026-08-13", day.t0, day.t0, day.t0);
  assert.ok(w.t1 > w.t0);
});

test("stepISODate should move one day in either direction", () => {
  assert.equal(stepISODate("2026-08-05", +1), "2026-08-06");
  assert.equal(stepISODate("2026-08-05", -1), "2026-08-04");
  assert.equal(stepISODate("2026-08-05", 0), "2026-08-05");
});

test("stepISODate should cross month, year and leap-day boundaries", () => {
  assert.equal(stepISODate("2026-08-31", +1), "2026-09-01");
  assert.equal(stepISODate("2026-01-01", -1), "2025-12-31");
  assert.equal(stepISODate("2024-02-28", +1), "2024-02-29"); // leap year
  assert.equal(stepISODate("2026-02-28", +1), "2026-03-01"); // common year
});

test("stepISODate should hold a day across a DST transition", () => {
  // The whole reason the arithmetic runs in UTC: US DST springs forward on
  // 2026-03-08 and falls back on 2026-11-01. Local-midnight math lands on the
  // wrong day in zones whose transition happens AT midnight, and a date string
  // has no hour to absorb the shift.
  assert.equal(stepISODate("2026-03-07", +1), "2026-03-08");
  assert.equal(stepISODate("2026-03-08", +1), "2026-03-09");
  assert.equal(stepISODate("2026-11-01", -1), "2026-10-31");
});

test("stepISODate should return a non-date unchanged", () => {
  // Stepping a blank field must not manufacture a day out of nothing.
  assert.equal(stepISODate("", +1), "");
  assert.equal(stepISODate("nope", +1), "nope");
});

test("clampISODate should hold a day past the ceiling at the ceiling", () => {
  assert.equal(clampISODate("2026-08-06", "2026-08-05"), "2026-08-05");
  assert.equal(clampISODate("2026-09-01", "2026-08-05"), "2026-08-05");
  assert.equal(clampISODate("2027-01-01", "2026-08-05"), "2026-08-05");
});

test("clampISODate should pass through a day at or below the ceiling", () => {
  assert.equal(clampISODate("2026-08-05", "2026-08-05"), "2026-08-05"); // the ceiling itself is reachable
  assert.equal(clampISODate("2026-08-04", "2026-08-05"), "2026-08-04");
  assert.equal(clampISODate("2019-02-28", "2026-08-05"), "2019-02-28");
});

test("clampISODate should compare by day, not by string length or year alone", () => {
  // The comparison rides on fixed-width ISO, so the cases that would break a
  // naive lexical compare in other formats have to hold here.
  assert.equal(clampISODate("2026-12-31", "2026-08-05"), "2026-08-05"); // later month, same year
  assert.equal(clampISODate("2026-08-31", "2026-08-05"), "2026-08-05"); // later day, same month
  assert.equal(clampISODate("2026-01-09", "2026-08-05"), "2026-01-09"); // single-digit day, zero-padded
});

test("clampISODate should return a non-date unchanged on either side", () => {
  // Same contract as stepISODate: clamping a blank field must not manufacture
  // a day, and a broken ceiling must not silently become one.
  assert.equal(clampISODate("", "2026-08-05"), "");
  assert.equal(clampISODate("nope", "2026-08-05"), "nope");
  assert.equal(clampISODate("2026-02-31", "2026-08-05"), "2026-02-31"); // never a real day
  assert.equal(clampISODate("2026-12-31", ""), "2026-12-31");
  assert.equal(clampISODate("2026-12-31", "nope"), "2026-12-31");
  assert.equal(clampISODate(undefined, "2026-08-05"), undefined);
});

test("stepISOMonth should page a month while holding the day of the month", () => {
  assert.equal(stepISOMonth("2026-08-05", +1), "2026-09-05");
  assert.equal(stepISOMonth("2026-08-05", -1), "2026-07-05");
  assert.equal(stepISOMonth("2026-01-15", -1), "2025-12-15");
  assert.equal(stepISOMonth("2026-12-15", +1), "2027-01-15");
});

test("stepISOMonth should clamp to the last day when the target month is shorter", () => {
  // Clamping, not rolling over: 31 Mar back a month is 28 Feb. Rolling into
  // 3 Mar would make paging non-reversible.
  assert.equal(stepISOMonth("2026-03-31", -1), "2026-02-28");
  assert.equal(stepISOMonth("2024-03-31", -1), "2024-02-29"); // leap year
  assert.equal(stepISOMonth("2026-05-31", +1), "2026-06-30");
});

test("monthGrid should return six Sunday-first weeks covering the month", () => {
  const g = monthGrid("2026-08-05");
  assert.equal(g.year, 2026);
  assert.equal(g.month, 7); // 0-based: August
  assert.equal(g.cells.length, 42);
  // August 2026 starts on a Saturday, so the grid opens on Sun 26 Jul
  assert.equal(g.cells[0].iso, "2026-07-26");
  assert.equal(g.cells[0].inMonth, false);
  assert.equal(g.cells[41].iso, "2026-09-05");
  // consecutive days throughout, no gaps or repeats
  for (let i = 1; i < g.cells.length; i++) {
    assert.equal(g.cells[i].iso, stepISODate(g.cells[i - 1].iso, 1), `cell ${i}`);
  }
});

test("monthGrid should mark exactly the days belonging to the month on display", () => {
  const g = monthGrid("2026-08-05");
  const inMonth = g.cells.filter((c) => c.inMonth);
  assert.equal(inMonth.length, 31);
  assert.equal(inMonth[0].iso, "2026-08-01");
  assert.equal(inMonth[30].iso, "2026-08-31");
  assert.equal(g.cells.find((c) => c.iso === "2026-08-05").day, 5);
});

test("monthGrid should open on Sunday for every month of a year", () => {
  // Six rows always, whatever the month's shape — the popover must not change
  // height (or move the day under the cursor) as the user pages through. The
  // weekday of cell 0 is also what the .cal-dow header row claims it is.
  for (let m = 1; m <= 12; m++) {
    const iso = `2026-${String(m).padStart(2, "0")}-15`;
    const g = monthGrid(iso);
    assert.equal(g.cells.length, 42, iso);
    assert.equal(new Date(g.cells[0].iso + "T00:00:00Z").getUTCDay(), 0, `${iso} opens Sunday`);
    assert.ok(g.cells.some((c) => c.iso === iso && c.inMonth), `${iso} is in its own grid`);
  }
});

test("monthGrid should include a whole month that begins on a Sunday", () => {
  // The tight case: a month starting Sunday has no lead at all, and must still
  // not clip its tail.
  const g = monthGrid("2026-02-15"); // February 2026 starts Sunday
  assert.equal(g.cells[0].iso, "2026-02-01");
  assert.equal(g.cells.filter((c) => c.inMonth).length, 28);
  assert.equal(g.cells[41].iso, "2026-03-14");
});

test("monthGrid should return null for a non-date", () => {
  assert.equal(monthGrid(""), null);
  assert.equal(monthGrid("2026-13-01"), null);
  assert.equal(monthGrid(undefined), null);
});

// ---------------------------------------------------------------------------
// stepView — the Tab / Shift+Tab walk across the view switcher
// ---------------------------------------------------------------------------

test("stepView should advance through the views in switcher order when stepping forward", () => {
  assert.equal(stepView("sessions", +1), "line");
  assert.equal(stepView("line", +1), "projects");
});

test("stepView should walk back through the views in switcher order when stepping backward", () => {
  assert.equal(stepView("projects", -1), "line");
  assert.equal(stepView("line", -1), "sessions");
});

test("stepView should wrap at both ends so no keypress is a dead end", () => {
  // Tab off the last view returns to the first, and Shift+Tab off the first
  // reaches the last — the cycle is a ring, not a track with buffers.
  assert.equal(stepView("projects", +1), "sessions");
  assert.equal(stepView("sessions", -1), "projects");
});

test("stepView should fall back to the default view when the current view is unknown", () => {
  // A corrupted sb-view (or a view name from a future release) must still move,
  // and must move as if it were sessions.
  assert.equal(stepView("foo", +1), "line");
  assert.equal(stepView(null, +1), "line");
  assert.equal(stepView(undefined, -1), "projects");
});

test("stepView should accept the legacy 'bars' spelling as the sessions view", () => {
  assert.equal(stepView("bars", +1), "line");
  assert.equal(stepView("bars", -1), "projects");
});

test("stepView should return to the starting view after a full cycle in either direction", () => {
  for (const view of VIEW_ORDER) {
    let forward = view;
    let backward = view;
    for (let i = 0; i < VIEW_ORDER.length; i++) {
      forward = stepView(forward, +1);
      backward = stepView(backward, -1);
    }
    assert.equal(forward, view, `forward cycle from ${view}`);
    assert.equal(backward, view, `backward cycle from ${view}`);
  }
});

// ---------------------------------------------------------------------------
// memory (/api/memory) — byte formatting, the agent-vs-spawned split, the
// per-session accessor, and the pressure lookup behind the interval tooltip.
// ---------------------------------------------------------------------------

const MB = 1024 * 1024;
const GB = 1024 * MB;

test("fmtBytes should read in MB and GB when the figure is process-sized", () => {
  assert.equal(fmtBytes(812 * MB), "812 MB");
  assert.equal(fmtBytes(1 * MB), "1 MB");
  assert.equal(fmtBytes(1024 * MB), "1 GB", "a full 1024 MB rolls over to GB");
  assert.equal(fmtBytes(2 * GB), "2 GB", "a whole GB drops the trailing .0");
  assert.equal(fmtBytes(1.4 * GB), "1.4 GB");
  assert.equal(fmtBytes(11.25 * GB), "11.3 GB", "one decimal at GB scale, no more");
});

test("fmtBytes should distinguish absent from zero at the small end", () => {
  // The whole point of the null/0 split: "—" means nothing was measured, while
  // "0 MB" is a real reading. A sub-MB figure is real too, just not worth
  // decimals — it follows fmtUSD's "<$0.01" rather than printing 0.
  assert.equal(fmtBytes(null), "—");
  assert.equal(fmtBytes(undefined), "—");
  assert.equal(fmtBytes(NaN), "—");
  assert.equal(fmtBytes(0), "0 MB");
  assert.equal(fmtBytes(1), "<1 MB");
  assert.equal(fmtBytes(MB - 1), "<1 MB");
});

test("spawnedBytes should be the tree minus the agent when both were sampled", () => {
  assert.equal(spawnedBytes(1500 * MB, 400 * MB), 1100 * MB);
  assert.equal(spawnedBytes(400 * MB, 400 * MB), 0, "a lone agent spawned nothing");
});

test("spawnedBytes should floor at zero when sampling skew inverts the pair", () => {
  // agent and tree are read a moment apart, so a shrinking tree can sample
  // below its own agent. A raw subtraction would render "-38 MB spawned".
  assert.equal(spawnedBytes(362 * MB, 400 * MB), 0);
});

test("spawnedBytes should return nothing when either side was not measured", () => {
  // A container provider reports a tree total with no agent split. Returning
  // the tree here would credit the whole container to spawned work.
  assert.equal(spawnedBytes(1500 * MB, null), null);
  assert.equal(spawnedBytes(null, 400 * MB), null);
  assert.equal(spawnedBytes(undefined, undefined), null);
});

function memoryPayload() {
  return {
    sessions: {
      ghost: {
        peak_agent_bytes: 400 * MB,
        avg_agent_bytes: 250 * MB,
        peak_tree_bytes: 1500 * MB,
        avg_tree_bytes: 900 * MB,
      },
    },
    pressure: [],
  };
}

test("laneMemory should report the producer's peaks and averages when the lane is trusted", () => {
  const lane = ghostLane();
  lane.suspect = false;
  const mem = laneMemory(lane, memoryPayload());
  assert.equal(mem.peakAgentBytes, 400 * MB);
  assert.equal(mem.avgAgentBytes, 250 * MB);
  assert.equal(mem.peakTreeBytes, 1500 * MB);
  assert.equal(mem.avgTreeBytes, 900 * MB);
  assert.equal(mem.peakSpawnedBytes, 1100 * MB, "spawned is the tree above the agent");
  assert.equal(mem.avgSpawnedBytes, 650 * MB);
  assert.equal(mem.clipped, false);
});

test("laneMemory should return nothing when the session has no memory data", () => {
  // NOTHING, not zero: the UI has to be able to say "not measured" (no memory
  // support, a non-Linux host, a session older than sampling) rather than
  // drawing a confident 0 MB.
  const lane = ghostLane();
  assert.equal(laneMemory(lane, null), null);
  assert.equal(laneMemory(lane, {}), null);
  assert.equal(laneMemory(lane, { sessions: {} }), null);
  assert.equal(laneMemory(lane, { sessions: { other: { peak_tree_bytes: 900 * MB } } }), null);
  assert.equal(laneMemory(lane, { sessions: { ghost: {} } }), null, "an empty record is no data");
  assert.equal(laneMemory(lane, {
    // the endpoint sends the scalars as explicit null rather than omitting them
    sessions: { ghost: { peak_agent_bytes: null, avg_agent_bytes: null, peak_tree_bytes: null, avg_tree_bytes: null } },
  }), null, "a record of explicit nulls is no data");
  assert.equal(laneMemory(null, memoryPayload()), null);
});

test("laneMemory should keep a real zero apart from a missing figure", () => {
  // 0 is a legal reading and must survive as 0 — `!= null`, never truthiness,
  // or a genuinely idle tree renders as "—" (not measured).
  const lane = ghostLane();
  lane.suspect = false;
  const mem = laneMemory(lane, {
    sessions: { ghost: { peak_agent_bytes: 0, avg_agent_bytes: 0, peak_tree_bytes: 0, avg_tree_bytes: 0 } },
  });
  assert.equal(mem.peakTreeBytes, 0, "a zero record is data, not absence");
  assert.equal(mem.peakSpawnedBytes, 0);
  assert.equal(fmtBytes(mem.peakTreeBytes), "0 MB");
});

test("laneMemory should keep the tree alone when the provider reports no agent split", () => {
  // arachne measures a container total, which has no meaningful inner boundary.
  // The endpoint emits the agent side as explicit null, never as an absent key.
  const lane = ghostLane();
  lane.suspect = false;
  const mem = laneMemory(lane, {
    sessions: {
      ghost: {
        peak_agent_bytes: null, avg_agent_bytes: null,
        peak_tree_bytes: 2 * GB, avg_tree_bytes: 1 * GB,
        mem: [{ ts: at(0), agent: null, tree: 2 * GB }],
      },
    },
  });
  assert.equal(mem.peakTreeBytes, 2 * GB);
  assert.equal(mem.peakAgentBytes, null, "absent, not zero");
  assert.equal(mem.peakSpawnedBytes, null, "no split to report");
  assert.equal(fmtBytes(mem.peakAgentBytes), "—");
});

test("laneMemory should re-derive the tree alone when a suspect container lane has no agent side", () => {
  // The clip path has to survive a null agent series too: arachne's samples
  // carry an explicit null agent, so seriesStats finds nothing on that key.
  const mem = laneMemory(ghostLane(), {
    sessions: {
      ghost: {
        peak_agent_bytes: null, avg_agent_bytes: null,
        peak_tree_bytes: 4 * GB, avg_tree_bytes: 3 * GB,
        mem: [
          { ts: at(0), agent: null, tree: 1 * GB },
          { ts: at(60), agent: null, tree: 2 * GB },
          { ts: at(300), agent: null, tree: 4 * GB }, // synthesized tail
        ],
      },
    },
  });
  assert.equal(mem.clipped, true);
  assert.equal(mem.peakTreeBytes, 2 * GB, "the tail's 4 GB is not evidence");
  assert.equal(mem.peakAgentBytes, null);
  assert.equal(mem.peakSpawnedBytes, null);
});

// A suspect lane's samples run past the evidence bound because the sampler
// keeps firing at a session nothing ever closed. Same hazard as laneActiveMs:
// re-deriving over the synthesized tail disagrees with the producer.
function ghostLaneMemory() {
  return {
    sessions: {
      ghost: {
        // the producer's own scalars cover the whole (partly synthesized) lane
        peak_agent_bytes: 900 * MB,
        avg_agent_bytes: 600 * MB,
        peak_tree_bytes: 2000 * MB,
        avg_tree_bytes: 1200 * MB,
        mem: [
          { ts: at(0), agent: 100 * MB, tree: 300 * MB },
          { ts: at(30), agent: 200 * MB, tree: 500 * MB },
          { ts: at(60), agent: 120 * MB, tree: 400 * MB }, // exactly at the bound
          { ts: at(120), agent: 900 * MB, tree: 2000 * MB }, // synthesized tail
          { ts: at(300), agent: 800 * MB, tree: 1900 * MB },
        ],
      },
    },
    pressure: [],
  };
}

test("laneMemory should re-derive at the evidence bound when the lane is suspect", () => {
  const mem = laneMemory(ghostLane(), ghostLaneMemory());
  assert.equal(mem.clipped, true);
  assert.equal(mem.samples.length, 3, "the sample at suspect_since is itself evidence");
  assert.equal(mem.peakAgentBytes, 200 * MB, "the tail's 900 MB spike is not evidence");
  assert.equal(mem.peakTreeBytes, 500 * MB);
  assert.equal(mem.avgAgentBytes, 140 * MB, "time-weighted over the trusted prefix");
  assert.equal(mem.avgTreeBytes, 400 * MB);
  assert.equal(mem.peakSpawnedBytes, 300 * MB);
});

test("laneMemory should keep the producer's scalars when a suspect lane ships no series", () => {
  // Fail open, exactly as suspectSinceMs does on an unusable timestamp: with
  // nothing to clip, dropping the figures would erase a real measurement.
  const mem = laneMemory(ghostLane(), memoryPayload());
  assert.equal(mem.clipped, false);
  assert.equal(mem.peakTreeBytes, 1500 * MB);
});

test("laneMemory should return nothing when every sample lands in the synthesized tail", () => {
  const payload = ghostLaneMemory();
  payload.sessions.ghost.mem = payload.sessions.ghost.mem.filter((s) => Date.parse(s.ts) > ms(60));
  assert.equal(laneMemory(ghostLane(), payload), null, "no evidenced memory is no data");
});

test("laneMemory should join a namespaced lane id and fall back to the bare one", () => {
  const lane = ghostLane();
  lane.provider = "arachne";
  lane.session_id = "arachne:ghost";
  assert.equal(laneMemory(lane, { sessions: { "arachne:ghost": { peak_tree_bytes: 7 * MB } } }).peakTreeBytes, 7 * MB);
  assert.equal(laneMemory(lane, { sessions: { ghost: { peak_tree_bytes: 7 * MB } } }).peakTreeBytes, 7 * MB);
});

test("laneMemory should join an unidentified lane to its pid-keyed memory", () => {
  // A session emits memory samples from discovery but only gets its id at its
  // first agent hook, so the producer keys that stretch "pid:<n>" — and an
  // unidentified lane is keyed the same way. Without the fallback the two
  // halves of one session never meet, which is the state a freshly started or
  // long-idle session sits in, and exactly when its memory is worth seeing.
  const lane = { pid: 4821, start: at(0), end: at(60), intervals: [] };
  const mem = { sessions: { "pid:4821": { peak_agent_bytes: 500 * MB, peak_tree_bytes: 900 * MB } } };
  assert.equal(laneMemory(lane, mem).peakTreeBytes, 900 * MB);
  assert.equal(laneMemory(lane, mem).peakSpawnedBytes, 400 * MB);
});

test("laneMemory should not join an unidentified lane to an unrelated pid", () => {
  const lane = { pid: 4821, start: at(0), end: at(60), intervals: [] };
  assert.equal(laneMemory(lane, { sessions: { "pid:9999": { peak_tree_bytes: 900 * MB } } }), null);
});

// A session that ran across a daemon restart holds BOTH keys: the id it had
// before, and "pid:<n>" for the stretch after, until its next agent hook hands
// the id back. Taking the first match reported one stretch and hid the other —
// observed live as 1 sample under the id against 18 under the pid.
function splitPayload() {
  return {
    sessions: {
      ghost: {
        peak_agent_bytes: 300 * MB,
        avg_agent_bytes: 300 * MB,
        peak_tree_bytes: 400 * MB,
        avg_tree_bytes: 400 * MB,
        mem: [
          { ts: at(0), agent: 300 * MB, tree: 400 * MB },
          { ts: at(10), agent: 300 * MB, tree: 400 * MB },
        ],
      },
      "pid:4821": {
        peak_agent_bytes: 900 * MB,
        avg_agent_bytes: 800 * MB,
        peak_tree_bytes: 1200 * MB,
        avg_tree_bytes: 1000 * MB,
        mem: [
          { ts: at(20), agent: 900 * MB, tree: 1200 * MB },
          { ts: at(50), agent: 700 * MB, tree: 900 * MB },
        ],
      },
    },
    pressure: [],
  };
}

function splitLane() {
  return { session_id: "ghost", pid: 4821, start: at(0), end: at(60), intervals: [] };
}

test("laneMemory should join an identified lane to its pid-keyed memory too", () => {
  const mem = laneMemory(splitLane(), splitPayload());
  assert.equal(mem.peakTreeBytes, 1200 * MB, "the peak is the higher of the two stretches");
  assert.equal(mem.peakAgentBytes, 900 * MB);
  assert.equal(mem.samples.length, 4, "both series, not whichever key matched first");
});

test("laneMemory should weight a blended average by each stretch's own span", () => {
  // 400 MB held over 10 min, then 1000 MB over 30 — the long stretch has to
  // dominate. A plain mean of the two averages would say 700 MB.
  const mem = laneMemory(splitLane(), splitPayload());
  assert.equal(mem.avgTreeBytes, 850 * MB, "(400*10 + 1000*30) / 40");
  assert.equal(mem.avgAgentBytes, 675 * MB, "(300*10 + 800*30) / 40");
});

test("laneMemory should leave a single record's scalars exactly as the producer sent them", () => {
  // The blend must be a no-op on the ordinary one-record case: the producer's
  // figures are computed over the full series before it is thinned, so anything
  // re-derived here would be the less accurate number.
  const lane = ghostLane();
  lane.suspect = false;
  const mem = laneMemory(lane, memoryPayload());
  assert.equal(mem.avgTreeBytes, 900 * MB);
  assert.equal(mem.avgAgentBytes, 250 * MB);
});

test("laneMemory should find the pid bucket under its provider prefix", () => {
  // The merged endpoint namespaces EVERY key by provider, "pid:<n>" included, so
  // in a multi-provider view the bucket is "claude:pid:4821". Looking only for
  // the bare form found nothing — which is how this shipped: verified against the
  // live merged endpoint, where every split session came back with only the half
  // its id named.
  const lane = { session_id: "claude:ghost", provider: "claude", pid: 4821, start: at(0), end: at(60), intervals: [] };
  const mem = {
    sessions: {
      "claude:ghost": { peak_tree_bytes: 400 * MB, mem: [{ ts: at(0), tree: 400 * MB }] },
      "claude:pid:4821": { peak_tree_bytes: 1200 * MB, mem: [{ ts: at(20), tree: 1200 * MB }] },
    },
  };
  const joined = laneMemory(lane, mem);
  assert.equal(joined.samples.length, 2, "both halves, found under the namespaced key");
  assert.equal(joined.peakTreeBytes, 1200 * MB);
});

test("laneMemory should not credit a lane with a pid bucket outside its own span", () => {
  // A pid outlives the session wearing it. Over a long window one bucket can
  // hold the unidentified stretches of two sessions that held that pid in turn,
  // and the later one's 4 GB must not land on this lane's hover. The id-keyed
  // record needs no such bound; only the pid claim is an inference.
  const payload = splitPayload();
  payload.sessions["pid:4821"].mem.push({ ts: at(200), agent: 4000 * MB, tree: 4000 * MB });
  payload.sessions["pid:4821"].peak_tree_bytes = 4000 * MB;
  const mem = laneMemory(splitLane(), payload);
  assert.equal(mem.peakTreeBytes, 1200 * MB, "the out-of-span sample belongs to whoever held the pid next");
  assert.equal(mem.samples.length, 4);
});

test("memoryWindow should re-derive over both stretches of a split session", () => {
  // The interval tooltip reads the same union; a window landing in the pid-keyed
  // stretch must not come back empty because the lane carries an id.
  const win = memoryWindow(splitLane(), splitPayload(), ms(20), ms(50));
  assert.equal(win.samples.length, 2);
  assert.equal(win.peakTreeBytes, 1200 * MB);
});

function pressureSeries() {
  return [
    { ts: at(0), avail_bytes: 8 * GB, psi_avg10: 0.4, psi_stall_us: 1200 },
    { ts: at(30), avail_bytes: 2 * GB, psi_avg10: 12.5, psi_stall_us: 90000 },
    { ts: at(60), avail_bytes: 5 * GB, psi_avg10: 3, psi_stall_us: 400 },
  ];
}

test("memoryWindow should re-derive over only the samples inside the interval", () => {
  const win = memoryWindow(ghostLane(), ghostLaneMemory(), ms(0), ms(30));
  assert.equal(win.samples.length, 2);
  assert.equal(win.peakAgentBytes, 200 * MB);
  assert.equal(win.peakTreeBytes, 500 * MB);
  assert.equal(win.peakSpawnedBytes, 300 * MB);
});

test("memoryWindow should return nothing when no sample falls in the interval", () => {
  // Silence, not the session-wide figure: borrowing it would attribute a later
  // balloon to an earlier interval, which is the misreading this view prevents.
  assert.equal(memoryWindow(ghostLane(), ghostLaneMemory(), ms(200), ms(220)), null);
});

test("memoryWindow should stop at the evidence bound when the interval runs into a synthesized tail", () => {
  const win = memoryWindow(ghostLane(), ghostLaneMemory(), ms(0), ms(300));
  assert.equal(win.clipped, true);
  assert.equal(win.samples.length, 3, "the sample at suspect_since is itself evidence");
  assert.equal(win.peakAgentBytes, 200 * MB, "the tail's 900 MB spike is not evidence");
});

test("memoryWindow should return nothing when the whole interval sits past the evidence bound", () => {
  assert.equal(memoryWindow(ghostLane(), ghostLaneMemory(), ms(120), ms(300)), null);
});

test("pressureWindow should total the stall and report the tightest headroom in the window", () => {
  // psi_stall_us is a per-interval delta, so the deltas SUM into the window's
  // total stall. They are never maxed: raw deltas are only comparable when the
  // sampling intervals are equal, which a restart or a missed tick breaks.
  // avail_bytes is a level, so its MINIMUM is how tight the window got.
  const win = pressureWindow({ pressure: pressureSeries() }, ms(0), ms(60));
  assert.equal(win.totalStallUs, 1200 + 90000 + 400);
  assert.equal(win.minAvailBytes, 2 * GB);
  assert.equal(win.peakPsiAvg10, 12.5);
  assert.equal(win.samples, 3);
  assert.equal(win.windowMs, 60 * MIN, "the window it was measured over travels with it");
});

test("pressureWindow should not let a missed tick masquerade as a stall spike", () => {
  // The regression the sum exists to prevent. Both windows saw the SAME stall
  // rate; the second just sampled once over 60s instead of twice over 30s,
  // which is what a starved or restarted daemon looks like. A peak of raw
  // deltas would rank the sparse window twice as bad. The sum ranks them equal,
  // because the deltas tile the window whatever the spacing did.
  const dense = pressureWindow({
    pressure: [{ ts: at(0.5), psi_stall_us: 15e6 }, { ts: at(1), psi_stall_us: 15e6 }],
  }, ms(0), ms(1));
  const sparse = pressureWindow({
    pressure: [{ ts: at(1), psi_stall_us: 30e6 }],
  }, ms(0), ms(1));
  assert.equal(dense.totalStallUs, sparse.totalStallUs, "same stall, different cadence");
  assert.equal(dense.stallFraction, sparse.stallFraction);
});

test("pressureWindow should report the stalled fraction of the window's wall clock", () => {
  // The intensity figure, comparable across windows of any length: 30s of
  // stall spread over a 60s window is half that window spent stalled.
  const win = pressureWindow({
    pressure: [
      { ts: at(0), psi_stall_us: 10e6 },
      { ts: at(0.5), psi_stall_us: 10e6 },
      { ts: at(1), psi_stall_us: 10e6 },
    ],
  }, ms(0), ms(1));
  assert.equal(win.totalStallUs, 30e6);
  assert.equal(win.stallFraction, 0.5);
});

test("pressureWindow should leave the leading-edge overhang uncorrected", () => {
  // A known, accepted edge: the first sample's delta partially covers time
  // before startMs, so a short window can total more stall than it has wall
  // clock. Left uncorrected deliberately — clamping here would hide the tiling
  // rather than fix it, so a renderer showing a percent caps it at display time.
  const win = pressureWindow({
    pressure: [{ ts: at(0), psi_stall_us: 60e6 }, { ts: at(1), psi_stall_us: 60e6 }],
  }, ms(0), ms(1));
  assert.equal(win.totalStallUs, 120e6);
  assert.equal(win.stallFraction, 2, "reported honestly rather than saturated at 1");
});

test("pressureWindow should keep an absent PSI reading absent rather than reading zero", () => {
  // A missing series and a genuinely unstalled machine are different claims.
  // Coercing to 0 here would render "never stalled" over a window nobody measured.
  const win = pressureWindow({ pressure: [{ ts: at(0), avail_bytes: 8 * GB }] }, ms(0), ms(60));
  assert.equal(win.totalStallUs, null);
  assert.equal(win.stallFraction, null);
  assert.equal(win.peakPsiAvg10, null);
  assert.equal(win.minAvailBytes, 8 * GB, "the reading that IS present still lands");
  // a real zero stall is data and must survive as 0, not collapse to absent.
  const calm = pressureWindow({ pressure: [{ ts: at(0), psi_stall_us: 0 }] }, ms(0), ms(60));
  assert.equal(calm.totalStallUs, 0);
  assert.equal(calm.stallFraction, 0);
});

test("pressureWindow should include only the samples inside the bounds", () => {
  const mem = { pressure: pressureSeries() };
  const late = pressureWindow(mem, ms(45), ms(90));
  assert.equal(late.samples, 1);
  assert.equal(late.totalStallUs, 400, "the earlier spike is outside this interval");
  assert.equal(late.minAvailBytes, 5 * GB);
  // both ends are inclusive, so a zero-width window still lands on its sample —
  // but it has no wall clock to divide by, so the fraction is absent.
  const instant = pressureWindow(mem, ms(30), ms(30));
  assert.equal(instant.samples, 1);
  assert.equal(instant.totalStallUs, 90000);
  assert.equal(instant.windowMs, 0);
  assert.equal(instant.stallFraction, null);
});

test("pressureWindow should return nothing when the series does not cover the window", () => {
  // NOTHING, not a calm zero: sampling starts when it starts and old samples
  // age out, so most of the timeline has no pressure reading behind it.
  const mem = { pressure: pressureSeries() };
  assert.equal(pressureWindow(mem, ms(120), ms(180)), null);
  assert.equal(pressureWindow(mem, ms(-120), ms(-60)), null);
  assert.equal(pressureWindow({ pressure: [] }, ms(0), ms(60)), null);
  assert.equal(pressureWindow({}, ms(0), ms(60)), null);
  assert.equal(pressureWindow(null, ms(0), ms(60)), null);
  assert.equal(pressureWindow(mem, ms(60), ms(0)), null, "an inverted window matches nothing");
});

// ---------------------------------------------------------------------------
// scaleGeometry — the footer's px/hour setting resolved against the window
// ---------------------------------------------------------------------------

const ZMIN = 60, ZMAX = 1200, ZSTEP = 1.25;
const HOUR = 3600e3;
// the shape the bug lived in: a 100-minute window in an 1110px plot fills the
// width at 666 px/h, well above the 240 default.
const SHORT = 100 * 60e3, PLOT = 1110;
const geo = (span, fitPlotW, px) => scaleGeometry(span, fitPlotW, px, ZMIN, ZMAX);

test("scaleGeometry should draw a long window at the requested density", () => {
  // 8h at 240 px/h wants 1920px — wider than the plot, so the setting governs
  // and the chart scrolls.
  const g = geo(8 * HOUR, PLOT, 240);
  assert.equal(g.plotW, 1920);
  assert.equal(Math.round(g.effective), 240);
  assert.equal(g.atFit, false);
  assert.equal(g.canZoomOut, true);
});

test("scaleGeometry should report the fit density, not the setting, when the window already fits", () => {
  // The regression: the setting said 240, the chart was drawn at 666, and the
  // readout showed 240 — so four zoom-in clicks moved the label and nothing else.
  const g = geo(SHORT, PLOT, 240);
  assert.equal(g.plotW, PLOT, "a fitting window draws to the plot width");
  assert.equal(Math.round(g.fit), 666);
  assert.equal(Math.round(g.effective), 666, "the readout must show what is drawn");
  assert.equal(g.atFit, true);
});

test("scaleGeometry should draw every setting under the fit density identically", () => {
  // The dead zone itself: the whole zoom-out half of the range is one chart.
  const widths = [60, 120, 192, 240, 400, 600].map((px) => geo(SHORT, PLOT, px).plotW);
  assert.deepEqual(widths, new Array(6).fill(PLOT));
});

test("scaleGeometry should refuse to zoom out when the window already fits the width", () => {
  // Nothing is left to compress: a step down redraws the same pixels, so the
  // button is spent and must grey out instead of taking dead clicks.
  assert.equal(geo(SHORT, PLOT, 240).canZoomOut, false);
  assert.equal(geo(SHORT, PLOT, ZMIN).canZoomOut, false);
});

test("scaleGeometry should let one zoom-in step off the fit density widen the plot", () => {
  // Stepping the stored 240 would give 300 — still under the 666 floor, so the
  // chart would hold still. Stepping the effective density always moves it.
  const before = geo(SHORT, PLOT, 240);
  const after = geo(SHORT, PLOT, before.effective * ZSTEP);
  assert.ok(after.plotW > before.plotW, "the first click must widen the plot");
  assert.equal(Math.round(after.effective), Math.round(before.effective * ZSTEP));
});

test("scaleGeometry should hand a zoom-out step back to the floor and stop", () => {
  // Down from one step above fit: lands at the floor, and there it's spent.
  const raised = geo(SHORT, PLOT, geo(SHORT, PLOT, 240).effective * ZSTEP);
  const dropped = geo(SHORT, PLOT, raised.effective / ZSTEP);
  assert.equal(dropped.plotW, PLOT);
  assert.equal(dropped.canZoomOut, false);
});

test("scaleGeometry should stay zoomable-out above the floor even below the default", () => {
  // A day-long window at 154 px/h is still wider than the plot: the floor is
  // about the window, not about the default, and must not grey the button early.
  const g = geo(24 * HOUR, PLOT, 154);
  assert.equal(g.canZoomOut, true);
  assert.equal(g.atFit, false);
});

test("scaleGeometry should bound zoom-in at the maximum density", () => {
  assert.equal(geo(8 * HOUR, PLOT, ZMAX).canZoomIn, false);
  assert.equal(geo(8 * HOUR, PLOT, ZMAX / ZSTEP).canZoomIn, true);
});

test("scaleGeometry should freeze both directions when fit alone exceeds the maximum", () => {
  // A 10-minute window fills 1110px at 6660 px/h — past ZMAX and already
  // floored, so neither button can move it and both must say so.
  const g = geo(10 * 60e3, PLOT, 240);
  assert.equal(Math.round(g.fit), 6660);
  assert.equal(g.canZoomIn, false);
  assert.equal(g.canZoomOut, false);
});

test("scaleGeometry should fall back to the plot width for an empty window", () => {
  // A zero-length span has no density: no floor, no divide-by-zero, draw to fit.
  const g = geo(0, PLOT, 240);
  assert.equal(g.plotW, PLOT);
  assert.equal(g.fit, 0);
  assert.equal(g.effective, 240, "with no window, the setting speaks for itself");
  assert.equal(g.atFit, false);
});

// ---------------------------------------------------------------------------
// deflickerIntervals — the sub-5s orange that fragments an unbroken run
// ---------------------------------------------------------------------------

// iv(status, fromSec, toSec) → one interval, RFC3339, offset from a fixed base.
const FLICK_BASE = Date.parse("2026-08-13T12:00:00.000Z");
function iv(status, fromSec, toSec) {
  return {
    status,
    start: new Date(FLICK_BASE + fromSec * 1000).toISOString(),
    end: new Date(FLICK_BASE + toSec * 1000).toISOString(),
  };
}
const spans = (list) => list.map((x) => [x.status, (Date.parse(x.end) - Date.parse(x.start)) / 1000]);

test("deflickerIntervals should absorb a sub-5s idle between two running intervals", () => {
  const out = deflickerIntervals([iv("working", 0, 600), iv("idle", 600, 602), iv("working", 602, 1800)]);
  assert.deepEqual(spans(out), [["working", 1800]],
    "a 2s blip never stopped the agent, so the run is one run");
});

test("deflickerIntervals should keep an idle at or over the 5s floor", () => {
  const out = deflickerIntervals([iv("working", 0, 600), iv("idle", 600, 605), iv("working", 605, 1800)]);
  assert.deepEqual(spans(out), [["working", 600], ["idle", 5], ["working", 1195]],
    "5s is long enough to have read the screen and reprompted, so it stands");
  assert.equal(FLICKER_MS, 5000);
});

test("deflickerIntervals should not absorb a blip that opens or closes a lane", () => {
  const head = deflickerIntervals([iv("idle", 0, 2), iv("working", 2, 600), iv("working", 600, 900)]);
  assert.equal(head[0].status, "idle", "nothing before it to be interrupting");
  const tail = deflickerIntervals([iv("working", 0, 600), iv("working", 600, 900), iv("idle", 900, 902)]);
  assert.equal(tail[tail.length - 1].status, "idle", "nor anything after it");
});

test("deflickerIntervals should leave a blip alone when a neighbour is not running", () => {
  const out = deflickerIntervals([iv("permission", 0, 60), iv("idle", 60, 62), iv("working", 62, 600)]);
  assert.deepEqual(spans(out), [["permission", 60], ["idle", 2], ["working", 538]],
    "an idle beside a permission stop is part of the stop, not a blip in a run");
});

test("deflickerIntervals should not absorb a short permission, however brief", () => {
  const out = deflickerIntervals([iv("working", 0, 600), iv("permission", 600, 601), iv("working", 601, 1200)]);
  assert.deepEqual(spans(out), [["working", 600], ["permission", 1], ["working", 599]],
    "a one-second permission is an event that happened and was answered fast");
});

test("deflickerIntervals should bridge a blip between two DIFFERENT running statuses", () => {
  const out = deflickerIntervals([iv("working", 0, 600), iv("idle", 600, 601), iv("delegating", 601, 1200)]);
  assert.deepEqual(spans(out), [["working", 601], ["delegating", 599]],
    "the gap closes into the run that preceded it; both sides stay running");
});

test("deflickerIntervals should collapse a run broken by several blips into one", () => {
  const out = deflickerIntervals([
    iv("working", 0, 300), iv("idle", 300, 302), iv("working", 302, 600),
    iv("idle", 600, 601), iv("working", 601, 1800),
  ]);
  assert.deepEqual(spans(out), [["working", 1800]],
    "this is the case that was doubling the free-block count");
});

test("deflickerIntervals should pass through unparseable intervals rather than drop them", () => {
  const junk = { status: "idle", start: "not-a-date", end: "also-not" };
  const out = deflickerIntervals([iv("working", 0, 600), junk, iv("working", 600, 1200)]);
  assert.equal(out.length, 3, "a smoothing pass may not delete data it cannot read");
  assert.equal(out[1].start, "not-a-date");
});

test("deflickerIntervals should return short lists untouched", () => {
  assert.deepEqual(deflickerIntervals([]), []);
  assert.deepEqual(spans(deflickerIntervals([iv("idle", 0, 1), iv("working", 1, 60)])),
    [["idle", 1], ["working", 59]], "two intervals cannot sandwich anything");
});

test("deflickerLanes should deflicker every lane and leave the rest of it alone", () => {
  const lanes = [{
    session_id: "s1", project: "p",
    intervals: [iv("working", 0, 600), iv("idle", 600, 602), iv("working", 602, 1800)],
  }];
  const out = deflickerLanes(lanes);
  assert.equal(out[0].session_id, "s1");
  assert.equal(out[0].project, "p");
  assert.deepEqual(spans(out[0].intervals), [["working", 1800]]);
  assert.deepEqual(spans(lanes[0].intervals), [["working", 600], ["idle", 2], ["working", 1198]],
    "the input is not mutated — the raw payload stays raw");
});
