"use strict";

// ---------------------------------------------------------------------------
// switchboard-dashboard render model — pure, DOM-free helpers.
//
// Shared by the browser frontend (app.js, via globals) and the node test suite
// (model.test.js, via require). It turns a v2 `switchboard-ctl timeline` lane
// into a render-ready *bar* model:
//   - bars are keyed by STABLE SESSION IDENTITY (session_id, falling back to
//     pid) — never by name, so a /name rename never splits or re-labels a
//     session's existing history.
//   - the session's name is attached to the bar as ordered SPANS drawn along
//     its lifespan: one segment per names[] entry, preceded by a synthesized
//     "lead" segment covering the pre-/name stretch (labeled by project_full,
//     else project, else the first raw labels[] entry, else unlabeled).
//
// Contract reminders (see switchboard docs/history-schema.md):
//   - names[] is slug-only span history: [{label,start,end}, …] in order,
//     empty/absent until the first /name. Spans need not start at lane.start.
//   - labels[] is the full raw name history (incl. the "Claude Code" default
//     and auto-generated titles) — used only as a lead-label fallback.
//   - project_full is an OPTIONAL pretty project name; treat as may-be-absent.
//   - timestamps are RFC3339; segment start/end here are epoch ms.
// ---------------------------------------------------------------------------

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api; // node test
  } else {
    Object.assign(root, api); // browser: expose as globals for app.js
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  // laneIdentity is the stable key for a session's bar: session_id when present,
  // else "pid:<pid>". Renaming a session never changes this, so the bar (and its
  // already-drawn history) is never split or relabeled by a /name.
  function laneIdentity(lane) {
    if (lane && lane.session_id) return lane.session_id;
    if (lane && lane.pid != null) return "pid:" + lane.pid;
    return "?";
  }

  // leadLabel is the name shown for the pre-/name stretch: project_full if the
  // (optional) field is present, else the project abbreviation, else the first
  // raw labels[] entry, else "" (unlabeled).
  function leadLabel(lane) {
    if (!lane) return "";
    if (lane.project_full) return lane.project_full;
    if (lane.project) return lane.project;
    const labels = lane.labels || [];
    if (labels.length && labels[0] && labels[0].label) return labels[0].label;
    return "";
  }

  function parseSpan(s) {
    return { label: s.label, start: Date.parse(s.start), end: Date.parse(s.end) };
  }

  // nameSegments turns a lane's slug-only names[] history into ordered,
  // contiguous label segments (epoch-ms pairs) spanning the session's life:
  //   - a leading {kind:"lead"} segment covers lane.start → first names[].start
  //     when there is a gap (or the whole lane when names[] is empty);
  //   - one {kind:"name"} segment per names[] span, in order;
  //   - the final name extends to lane.end if the session kept running past the
  //     last recorded span, so the bar is fully labeled.
  // A renamed session therefore yields a SINGLE bar with ≥2 name segments.
  function nameSegments(lane) {
    const laneStart = Date.parse(lane.start);
    const laneEnd = Date.parse(lane.end);
    const spans = (lane.names || [])
      .map(parseSpan)
      .filter((s) => isFinite(s.start) && isFinite(s.end) && s.end > s.start)
      .sort((a, b) => a.start - b.start);
    const lead = leadLabel(lane);

    if (!spans.length) {
      if (isFinite(laneStart) && isFinite(laneEnd) && laneEnd > laneStart) {
        return [{ label: lead, start: laneStart, end: laneEnd, kind: "lead" }];
      }
      return [];
    }

    const segs = [];
    if (isFinite(laneStart) && spans[0].start > laneStart) {
      segs.push({ label: lead, start: laneStart, end: spans[0].start, kind: "lead" });
    }
    for (const s of spans) {
      segs.push({ label: s.label, start: s.start, end: s.end, kind: "name" });
    }
    const lastEnd = spans[spans.length - 1].end;
    if (isFinite(laneEnd) && laneEnd > lastEnd) segs[segs.length - 1].end = laneEnd;
    return segs;
  }

  // buildBar projects one lane into a render-ready bar keyed by session identity.
  function buildBar(lane) {
    return {
      key: laneIdentity(lane),
      sessionId: lane.session_id || null,
      pid: lane.pid,
      project: lane.project || null,
      agent: lane.agent || null,
      start: Date.parse(lane.start),
      end: Date.parse(lane.end),
      segments: nameSegments(lane),
      lane: lane,
    };
  }

  // buildBars projects every lane into its own bar. Each session (one lane from
  // ctl) becomes exactly one bar; concurrent sessions are never merged, so
  // parallel work renders as separate bars even when they share a name.
  function buildBars(lanes) {
    return (lanes || []).map(buildBar);
  }

  // spanInefficiency: fraction of [segStartMs, segEndMs] (epoch ms) that was
  // genuinely non-productive — idle or suspended. Time spent DELEGATING is NOT
  // inefficient: dormant/delegating means the parent is waiting on a subagent
  // that is itself actively working, so that time is productive and excluded
  // (this is the whole point of running agents in parallel). The denominator is
  // the FULL span duration. Returns null when the span is non-positive. Pure:
  // reads only lane.intervals (each {status, start, end} with RFC3339 start/end).
  function spanInefficiency(lane, segStartMs, segEndMs) {
    const dur = segEndMs - segStartMs;
    if (!(dur > 0)) return null;
    // dormant/delegating deliberately excluded — a subagent is working then.
    const WAITING = new Set(["idle", "suspended"]);
    let waited = 0;
    for (const iv of (lane.intervals || [])) {
      if (!WAITING.has(iv.status)) continue;
      const s = Math.max(segStartMs, Date.parse(iv.start));
      const e = Math.min(segEndMs, Date.parse(iv.end));
      if (e > s) waited += e - s;
    }
    return waited / dur;
  }

  // packLanes performs greedy interval partitioning on a group's lanes: it
  // returns an array of ROWS, each row an array of lanes sorted by start, with no
  // two lanes on a row overlapping in time. Time-serializable sessions (one ends
  // before the next begins) therefore share a row, so the number of rows equals
  // the group's MAX simultaneous overlap.
  //
  // Algorithm: sort the time-bounded lanes by start (then end, for determinism);
  // for each, assign it to the FIRST row whose last lane ends at or before this
  // lane's start (any non-overlap, nextStart >= prevEnd, is packable); else open a
  // new row. Lanes whose start/end can't be parsed each get their own row,
  // appended at the end — we never drop or merge what we can't measure. Pure and
  // DOM-free; reads only lane.start / lane.end (RFC3339, via Date.parse).
  function packLanes(lanes) {
    const bounded = [], unbounded = [];
    for (const lane of lanes || []) {
      const s = Date.parse(lane.start), e = Date.parse(lane.end);
      if (isFinite(s) && isFinite(e)) bounded.push({ lane, s, e });
      else unbounded.push(lane);
    }
    bounded.sort((a, b) => a.s - b.s || a.e - b.e);

    const rows = [];     // array of arrays of lanes
    const rowEnds = [];  // end ms of each row's last (latest-starting) lane
    for (const { lane, s, e } of bounded) {
      let r = -1;
      for (let i = 0; i < rowEnds.length; i++) {
        if (rowEnds[i] <= s) { r = i; break; }
      }
      if (r === -1) { rows.push([lane]); rowEnds.push(e); }
      else { rows[r].push(lane); rowEnds[r] = e; }
    }
    for (const lane of unbounded) rows.push([lane]);
    return rows;
  }

  return { laneIdentity, leadLabel, nameSegments, buildBar, buildBars, spanInefficiency, packLanes };
});
