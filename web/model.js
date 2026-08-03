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
// Contract reminders (see Switchboard docs/history-schema.md):
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

  // rawSessionId is the provider-agnostic session id, for joining a lane to
  // stores keyed by the bare Claude session UUID (e.g. /api/summaries). The
  // merged multi-provider view namespaces lane.session_id as
  // "<provider>:<id>", so the lane's own provider prefix is stripped; a
  // single-provider id passes through unchanged. Null when the lane has none.
  function rawSessionId(lane) {
    if (!lane || !lane.session_id) return null;
    const id = lane.session_id;
    if (lane.provider && id.startsWith(lane.provider + ":")) {
      return id.slice(lane.provider.length + 1);
    }
    return id;
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

  // switchArrivals identifies the operator's real context switches from focus
  // spans. A context switch is a focus ARRIVAL you actually landed on — the span's
  // dwell (end − start) ≥ flickerMs — which filters ONLY sub-flicker focus noise
  // (a notification or focus-follows-mouse stealing focus for a few hundred ms is
  // not a switch). It deliberately does NOT gate on long dwell: rapid thrash
  // (many short-but-real spans) is the most disruptive pattern and must count.
  //
  // Returns the qualifying arrival start times (epoch ms), sorted. This is the
  // SINGLE source of truth for switches: the displayed COUNT, the overlay, and the
  // recovery-time subtraction all derive from it, so what you see is exactly what
  // is charged against free time. (The prior split — count every arrival but
  // charge recovery only for ≥15s dwells — is what made free time overcounted.)
  // Pure; reads raw focus spans ({start,end} RFC3339) and Date.parses internally.
  function switchArrivals(focusSpans, flickerMs) {
    return (focusSpans || [])
      .map((f) => [Date.parse(f.start), Date.parse(f.end)])
      .filter(([s, e]) => isFinite(s) && isFinite(e) && e - s >= flickerMs)
      .map(([s]) => s)
      .sort((a, b) => a - b);
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

  // -------------------------------------------------------------------------
  // concurrency ("agents aloft") — the instantaneous fanout series.
  //
  // "aloft" at instant t = # sessions actively WORKING at t + # subagents
  // running at t. A delegating/dormant parent is deliberately NOT counted: while
  // it waits, its subagent is the one doing the work, so parent+subagent are
  // never double-counted. A parent that keeps working WHILE a background subagent
  // runs counts as BOTH — correctly, since they are two independent work streams.
  // This is the force-multiplier numerator, measured instantaneously.
  // -------------------------------------------------------------------------

  // workIntervalsMs collects the aloft spans as epoch-ms [start, end] pairs:
  // every 'working' status interval plus every non-phantom subagent span across
  // all lanes, each held to its lane's evidence bound (see clipSpanMs). Pure;
  // reads only lane.intervals[].status/start/end, lane.subagents[], and the
  // lane's suspect fields.
  function workIntervalsMs(lanes) {
    const out = [];
    for (const lane of lanes || []) {
      const cut = suspectSinceMs(lane);
      for (const iv of lane.intervals || []) {
        if (iv.status !== "working") continue;
        const span = clipSpanMs(Date.parse(iv.start), Date.parse(iv.end), cut);
        if (span) out.push(span);
      }
      for (const sa of lane.subagents || []) {
        if (sa.suspect) continue; // a phantom span is drawn, never credited
        const span = clipSpanMs(Date.parse(sa.start), Date.parse(sa.end), cut);
        if (span) out.push(span);
      }
    }
    return out;
  }

  // concurrencyProfile sweeps aloft intervals into the instantaneous step
  // function and its summary stats:
  //   points     — breakpoints [{t, n}]: the level is n on [t, nextT); the final
  //                point is the drop back to 0. Empty when there are no intervals.
  //   maxN       — peak simultaneous agents aloft.
  //   integralMs — ∫ n dt over all time (= Σ interval durations = agent-ms).
  //   activeMs   — |{t : n ≥ 1}| (union length of the intervals).
  //   avgActive  — integralMs / activeMs: the mean number aloft over ACTIVE time
  //                (the force-multiplier figure), or null when activeMs = 0.
  // Pure; input is the ms-pair array from workIntervalsMs.
  function concurrencyProfile(intervals) {
    const events = [];
    for (const [s, e] of (intervals || [])) { events.push([s, 1]); events.push([e, -1]); }
    events.sort((a, b) => a[0] - b[0]);

    const points = [];
    let level = 0, i = 0, maxN = 0;
    while (i < events.length) {
      const t = events[i][0];
      let delta = 0;
      while (i < events.length && events[i][0] === t) { delta += events[i][1]; i++; }
      level += delta;
      if (level > maxN) maxN = level;
      points.push({ t, n: level });
    }

    let integralMs = 0, activeMs = 0;
    for (let k = 0; k < points.length - 1; k++) {
      const dt = points[k + 1].t - points[k].t;
      integralMs += points[k].n * dt;
      if (points[k].n >= 1) activeMs += dt;
    }
    return {
      points, maxN, integralMs, activeMs,
      avgActive: activeMs > 0 ? integralMs / activeMs : null,
    };
  }

  // sessionPartLabel names one session inside a project's stacked bar: the most
  // recent names[] slug (what the session is called NOW), else leadLabel's
  // fallbacks, else "session". Private to projectHoursMs.
  function sessionPartLabel(lane) {
    const names = (lane && lane.names) || [];
    for (let i = names.length - 1; i >= 0; i--) {
      if (names[i] && names[i].label) return names[i].label;
    }
    return leadLabel(lane) || "session";
  }

  // projectHoursMs totals AGENT-TIME per project:
  //   [{project, ms, sessions, parts}] sorted by ms descending, ties broken by
  //   project name ascending.
  //
  // A lane's contribution is the sum of its 'working' interval durations plus the
  // sum of its subagent span durations — the same aloft spans workIntervalsMs
  // collects, and with the same hygiene (unparseable or end <= start is dropped,
  // phantom subagents are skipped, and a suspect lane is held to its evidence
  // bound so this view agrees with the producer's fanout).
  // Overlapping spans within a project SUM rather than union: two agents working
  // the same wall-clock minute is two agent-minutes, which is exactly the fanout
  // this chart is meant to show.
  //
  // parts breaks the total down per contributing SESSION for stacked rendering:
  // [{label, ms, startMs}] ordered by lane start (roughly temporal; unparseable
  // starts carry startMs null and sort last, ties by label). label comes from
  // sessionPartLabel above; sessions === parts.length.
  //
  // Grouping is by project_full (the pretty name) else project else "(no
  // project)" — deliberately NOT leadLabel, whose labels[] fallback would leak
  // per-session titles in as if they were projects. A lane that did no work
  // contributes no part, and a project with no work at all is dropped. Pure and
  // DOM-free; tolerant of an absent lanes array.
  function projectHoursMs(lanes) {
    const totals = new Map(); // project -> {ms, parts}
    for (const lane of lanes || []) {
      const cut = suspectSinceMs(lane);
      let laneMs = 0;
      for (const iv of lane.intervals || []) {
        if (iv.status !== "working") continue;
        const span = clipSpanMs(Date.parse(iv.start), Date.parse(iv.end), cut);
        if (span) laneMs += span[1] - span[0];
      }
      for (const sa of lane.subagents || []) {
        if (sa.suspect) continue; // a phantom span is drawn, never credited
        const span = clipSpanMs(Date.parse(sa.start), Date.parse(sa.end), cut);
        if (span) laneMs += span[1] - span[0];
      }
      if (laneMs <= 0) continue;
      const project = lane.project_full || lane.project || "(no project)";
      const start = Date.parse(lane.start);
      const acc = totals.get(project) || { ms: 0, parts: [] };
      acc.ms += laneMs;
      acc.parts.push({ label: sessionPartLabel(lane), ms: laneMs, startMs: isFinite(start) ? start : null });
      totals.set(project, acc);
    }
    return [...totals]
      .map(([project, acc]) => ({
        project, ms: acc.ms, sessions: acc.parts.length,
        parts: acc.parts.sort((a, b) => {
          const as = a.startMs == null ? Infinity : a.startMs;
          const bs = b.startMs == null ? Infinity : b.startMs;
          return as - bs || a.label.localeCompare(b.label);
        }),
      }))
      .sort((a, b) => b.ms - a.ms || a.project.localeCompare(b.project));
  }

  // ---- plausibility post-check (producer side: internal/history/suspect.go) --
  // A lane nothing ever closed is drawn out to the window bound, so its tail is
  // synthesized rather than observed. The producer flags it instead of truncating
  // it — the operator has to be able to see that something was flagged — and
  // excludes the tail from every figure in `summary`.

  // suspectSinceMs is the last instant of a lane there is evidence for, or null
  // when the lane is unflagged or its timestamp is unusable. Null means "trust
  // the whole lane": a producer that does not run the check must never have its
  // lanes silently clipped, and a malformed timestamp must not erase real time.
  function suspectSinceMs(lane) {
    if (!lane || !lane.suspect || !lane.suspect_since) return null;
    const ms = Date.parse(lane.suspect_since);
    return Number.isFinite(ms) ? ms : null;
  }

  // clipSpanMs trims one [startMs, endMs] span to the part backed by evidence and
  // returns it as a fresh pair, or null when nothing survives. cutMs is a
  // suspectSinceMs() result: null means "trust the whole span".
  //
  // This is the SINGLE clip used by every client-side re-derivation of agent time
  // (laneActiveMs, workIntervalsMs, projectHoursMs, and app.js's operator lane),
  // so they cannot drift apart from each other or from the producer. It is the
  // twin of clipToTrusted in internal/timeline/suspect.go and agrees with it on
  // every boundary: a span starting exactly at the cut yields nothing, one ending
  // exactly at the cut is kept whole, and a zero-length or inverted span yields
  // nothing whether or not a cut applies.
  function clipSpanMs(startMs, endMs, cutMs) {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
    let end = endMs;
    if (cutMs != null) {
      if (startMs >= cutMs) return null;
      if (end > cutMs) end = cutMs;
    }
    if (!(end > startMs)) return null;
    return [startMs, end];
  }

  // laneActiveMs sums a lane's status intervals, held to the evidence bound so a
  // client-side "active" figure agrees with the producer's summary rather than
  // re-crediting the phantom tail the summary already subtracted.
  function laneActiveMs(lane) {
    const cut = suspectSinceMs(lane);
    let total = 0;
    for (const iv of (lane && lane.intervals) || []) {
      const span = clipSpanMs(Date.parse(iv.start), Date.parse(iv.end), cut);
      if (span) total += span[1] - span[0];
    }
    return total;
  }

  // suspectTailMs is the [start, end] of the synthesized stretch to draw as
  // untrusted, or null when there is nothing to mark.
  function suspectTailMs(lane) {
    const cut = suspectSinceMs(lane);
    if (cut == null) return null;
    const end = Date.parse(lane.end);
    if (!Number.isFinite(end) || end <= cut) return null;
    return [cut, end];
  }

  // -------------------------------------------------------------------------
  // memory (/api/memory — its own surface, deliberately NOT the timeline
  // envelope; see README "Memory"). Shape:
  //
  //   {sessions: {"<session_id>": {peak_agent_bytes, avg_agent_bytes,
  //                                peak_tree_bytes, avg_tree_bytes,
  //                                mem: [{ts, agent, tree}]}},
  //    pressure: [{ts, avail_bytes, psi_avg10, psi_stall_us}]}
  //
  // Bytes are Pss + SwapPss; averages are TIME-WEIGHTED by the producer. The
  // agent/tree split is what matters: subagents have no PIDs, so `tree − agent`
  // is the only figure that captures what spawned work cost. Container
  // providers (arachne) report the tree only — no agent split, because a
  // container total has no meaningful inner boundary — so the agent-side
  // figures are ABSENT there rather than zero, and every accessor below keeps
  // absent distinguishable from zero all the way to the caller.
  // -------------------------------------------------------------------------

  // finiteOrNull normalizes a maybe-missing numeric field. Absent, null, and
  // non-numeric all collapse to null, which reads as "no data" downstream;
  // a real 0 survives as 0.
  function finiteOrNull(v) {
    return Number.isFinite(v) ? v : null;
  }

  // fmtBytes renders a memory figure at the scale an operator reads memory in.
  // Terse like fmtUSD: null/absent is "—" (no data), a real zero is "0 MB", and
  // anything under a megabyte is "<1 MB" rather than a run of decimal noise.
  // Units are binary (MiB/GiB) with the customary MB/GB labels, matching what
  // `free -h` and htop show for the same process on the same machine.
  const BYTES_MB = 1024 * 1024;
  const BYTES_GB = 1024 * BYTES_MB;
  function fmtBytes(bytes) {
    if (!Number.isFinite(bytes)) return "—";
    if (bytes <= 0) return "0 MB";
    if (bytes >= BYTES_GB) return (bytes / BYTES_GB).toFixed(1).replace(/\.0$/, "") + " GB";
    if (bytes >= BYTES_MB) return Math.round(bytes / BYTES_MB) + " MB";
    return "<1 MB";
  }

  // spawnedBytes is what the spawned work cost: the process tree minus the agent
  // process itself. FLOORED AT 0 — agent and tree are read a moment apart, so a
  // shrinking tree can sample below its own agent and a raw subtraction would
  // render a negative "spawned" figure that is pure sampling skew. Null when
  // either side is missing, so a tree-only (container) provider reads as "no
  // split available" rather than falsely attributing the whole tree to subagents.
  function spawnedBytes(treeBytes, agentBytes) {
    if (!Number.isFinite(treeBytes) || !Number.isFinite(agentBytes)) return null;
    return Math.max(0, treeBytes - agentBytes);
  }

  // memoryRecord joins a lane to its /api/memory entry. The merged endpoint
  // namespaces session keys by provider exactly as lane.session_id is, so the
  // lane's own id is the primary key; rawSessionId is tried as a fallback for a
  // single-provider payload that was never namespaced. Null when there is none.
  function memoryRecord(lane, memory) {
    const sessions = memory && memory.sessions;
    if (!lane || !sessions) return null;
    if (lane.session_id && sessions[lane.session_id]) return sessions[lane.session_id];
    const raw = rawSessionId(lane);
    if (raw && sessions[raw]) return sessions[raw];
    return null;
  }

  // memSamples parses a record's mem[] series into sorted epoch-ms samples,
  // dropping any whose timestamp is unusable. Missing agent/tree values survive
  // as null (a container sample has no agent side) rather than as 0.
  function memSamples(record) {
    const raw = record && record.mem;
    if (!Array.isArray(raw)) return [];
    return raw
      .map((s) => ({
        ts: Date.parse(s && s.ts),
        agent: finiteOrNull(s && s.agent),
        tree: finiteOrNull(s && s.tree),
      }))
      .filter((s) => Number.isFinite(s.ts))
      .sort((a, b) => a.ts - b.ts);
  }

  // seriesStats re-derives {peak, avg} for one key over an already-clipped
  // sample series, or null when no sample carries that key. The average is
  // TIME-WEIGHTED to match how the producer computes its avg_* scalars: each
  // sample is weighted by the gap to the next one, and the last sample inherits
  // the preceding gap so a single-sample series still averages to its own value.
  function seriesStats(samples, key) {
    let peak = null, weighted = 0, weight = 0, sum = 0, count = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i][key];
      if (v == null) continue;
      if (peak == null || v > peak) peak = v;
      sum += v; count++;
      const gap = i + 1 < samples.length ? samples[i + 1].ts - samples[i].ts
        : i > 0 ? samples[i].ts - samples[i - 1].ts : 0;
      if (gap > 0) { weighted += v * gap; weight += gap; }
    }
    if (!count) return null;
    return { peak, avg: weight > 0 ? weighted / weight : sum / count };
  }

  // laneMemory is the per-session memory readout for a lane, or NULL when that
  // session has no memory data at all. Null is the whole point: it lets the UI
  // say "not measured" (a provider without memory support, a non-Linux host, a
  // session that predates sampling) instead of drawing a confident 0 MB.
  //
  //   {peakAgentBytes, avgAgentBytes, peakTreeBytes, avgTreeBytes,
  //    peakSpawnedBytes, avgSpawnedBytes, samples, clipped}
  //
  // The producer's scalars are used as-is — they are the authority, and their
  // averages are time-weighted over the real sample cadence. The ONE exception
  // is the laneActiveMs precedent: a SUSPECT lane's tail is synthesized, so any
  // figure re-derived client-side has to stop at suspect_since or it disagrees
  // with the producer. When such a lane ships its mem[] series we recompute
  // peak/avg over the trusted prefix and flag `clipped`; with no series to clip
  // we fail open and keep the scalars, exactly as suspectSinceMs fails open on
  // an unusable timestamp. A lane whose every sample lands in the synthesized
  // tail has nothing evidenced left and returns null.
  function laneMemory(lane, memory) {
    const record = memoryRecord(lane, memory);
    if (!record) return null;

    let agent = { peak: finiteOrNull(record.peak_agent_bytes), avg: finiteOrNull(record.avg_agent_bytes) };
    let tree = { peak: finiteOrNull(record.peak_tree_bytes), avg: finiteOrNull(record.avg_tree_bytes) };
    let samples = memSamples(record);

    const cut = suspectSinceMs(lane);
    const clipped = cut != null && samples.length > 0;
    if (clipped) {
      samples = samples.filter((s) => s.ts <= cut); // the bound is itself evidence
      agent = seriesStats(samples, "agent") || { peak: null, avg: null };
      tree = seriesStats(samples, "tree") || { peak: null, avg: null };
    }
    if (agent.peak == null && agent.avg == null && tree.peak == null && tree.avg == null) return null;

    return {
      peakAgentBytes: agent.peak,
      avgAgentBytes: agent.avg,
      peakTreeBytes: tree.peak,
      avgTreeBytes: tree.avg,
      peakSpawnedBytes: spawnedBytes(tree.peak, agent.peak),
      avgSpawnedBytes: spawnedBytes(tree.avg, agent.avg),
      samples,
      clipped,
    };
  }

  // pressureWindow summarizes machine-wide memory pressure over [startMs,
  // endMs] (inclusive both ends) for an interval tooltip:
  //
  //   {peakStallUs, minAvailBytes, peakPsiAvg10, samples}
  //
  // NULL when no sample falls in the window — the series does not cover every
  // interval the timeline can show (it starts when sampling started, and older
  // samples age out), and "no pressure recorded here" must not render as a
  // reassuring 0. Peak, not sum: psi_stall_us is the stall attributable to a
  // single sample's interval — the producer's delta of the monotonic
  // /proc/pressure/memory total — so the worst tick is the meaningful figure,
  // while avail_bytes is a level, hence its MINIMUM. Pressure is machine-wide
  // and never clipped per lane: it belongs to the host, not to any session.
  function pressureWindow(memory, startMs, endMs) {
    const rows = memory && memory.pressure;
    if (!Array.isArray(rows) || !(endMs >= startMs)) return null;
    let peakStallUs = null, minAvailBytes = null, peakPsiAvg10 = null, samples = 0;
    for (const row of rows) {
      const ts = Date.parse(row && row.ts);
      if (!Number.isFinite(ts) || ts < startMs || ts > endMs) continue;
      samples++;
      const stall = finiteOrNull(row.psi_stall_us);
      if (stall != null && (peakStallUs == null || stall > peakStallUs)) peakStallUs = stall;
      const avail = finiteOrNull(row.avail_bytes);
      if (avail != null && (minAvailBytes == null || avail < minAvailBytes)) minAvailBytes = avail;
      const psi = finiteOrNull(row.psi_avg10);
      if (psi != null && (peakPsiAvg10 == null || psi > peakPsiAvg10)) peakPsiAvg10 = psi;
    }
    if (!samples) return null;
    return { peakStallUs, minAvailBytes, peakPsiAvg10, samples };
  }

  // -------------------------------------------------------------------------
  // session summary rendering (session-digest records from /api/summaries)
  //
  // A record is {name, description, tasks?, summary}: tasks carries the
  // session's DISTINCT work items and summary the framing prose. Pre-v2 records
  // (and genuinely single-task sessions) have no tasks and must keep rendering
  // exactly as prose alone. These helpers return HTML STRINGS — no DOM — so the
  // node suite can assert on them.
  // -------------------------------------------------------------------------

  // escapeHTML is private to this module: summary text is model-written and is
  // interpolated into innerHTML, so every field is escaped on the way out.
  // (app.js keeps its own copy for the rest of the UI.)
  function escapeHTML(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // summaryTasks is a record's task bullets, trimmed and with empties dropped.
  // A tasks field that is not an array yields none: the shipped endpoint always
  // sends an array, but the helper must not throw on a record it did not write.
  function summaryTasks(summary) {
    const tasks = summary && summary.tasks;
    if (!Array.isArray(tasks)) return [];
    return tasks
      .map((task) => String(task == null ? "" : task).trim())
      .filter((task) => task !== "");
  }

  // summaryBodyHTML renders the body of the pinned session card: the task
  // bullets first, then the framing prose beneath them. With no tasks it is the
  // prose-only body the card has always shown.
  function summaryBodyHTML(summary) {
    if (!summary) return "";
    const tasks = summaryTasks(summary);
    let html = "";
    if (tasks.length) {
      html += `<ul class="po-tasks">`
        + tasks.map((task) => `<li>${escapeHTML(task)}</li>`).join("")
        + `</ul>`;
    }
    if (summary.summary) html += `<div class="po-summary">${escapeHTML(summary.summary)}</div>`;
    return html;
  }

  // summaryHintText is the hover tooltip's click affordance. The tooltip keeps
  // the one-line description — bullets are the reason to CLICK, not a second
  // tooltip — so a multi-task session only advertises how much the card holds.
  // Empty when nothing extra sits behind the click, which is exactly when
  // summaryBodyHTML is empty: a lone task still renders a bullet the tooltip
  // never showed, so it has to advertise the click too.
  function summaryHintText(summary) {
    const count = summaryTasks(summary).length;
    if (count > 1) return `click for ${count} steps`;
    if (count === 1 || (summary && summary.summary)) return "click for the session summary";
    return "";
  }

  // normalizeView validates a chart-view name, resolving "bars" — the sessions
  // view's pre-rename spelling — so persisted `sb-view` choices and old ?view=
  // links keep working. Returns null for anything that isn't a view, which both
  // call sites treat as "fall back to the default".
  function normalizeView(view) {
    if (view === "bars") return "sessions";
    if (view === "sessions" || view === "line" || view === "projects") return view;
    return null;
  }

  return {
    laneIdentity, rawSessionId, leadLabel, nameSegments, buildBar, buildBars,
    spanInefficiency, switchArrivals, packLanes, workIntervalsMs, concurrencyProfile,
    projectHoursMs, suspectSinceMs, clipSpanMs, laneActiveMs, suspectTailMs,
    fmtBytes, spawnedBytes, laneMemory, pressureWindow,
    summaryTasks, summaryBodyHTML, summaryHintText, normalizeView,
  };
});
