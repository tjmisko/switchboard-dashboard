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
  //
  // Measuring it instantaneously is also why this series and the attention card
  // can disagree. timeline.Merge counts working||delegating toward
  // attention_union, matching the producer's isActive, and workIntervalsMs was
  // deliberately NOT widened to match: crediting a delegating parent alongside
  // the subagent it waits on reads here as two agents aloft, while a union is
  // free to count both because it cannot double-count. The residual is real —
  // for a LEGACY stream carrying delegating time that no subagent span covers,
  // the chart's activeMs reads LOWER than the card's attention_union — but it
  // is legacy-only, since modern producers emit dormant. Revisit only if the
  // two figures visibly disagree on a real day.
  // -------------------------------------------------------------------------

  // aloftSpans collects the aloft spans as {s, e, open}: every 'working' status
  // interval plus every non-phantom subagent span across all lanes, each held to
  // its lane's evidence bound (see clipSpanMs).
  //
  // `open` marks a span its lane has not yet superseded — it runs to the lane's
  // newest sample, so as far as this lane has reported, it is STILL RUNNING. A
  // working interval followed by an idle one is closed; the last working
  // interval of a lane that is still working is open, because the producer ends
  // an in-flight interval at the instant it sampled. Callers that only want the
  // geometry use workIntervalsMs; the live-tail alignment needs the flag.
  //
  // Pure; reads only lane.intervals[].status/start/end, lane.subagents[], and
  // the lane's suspect fields.
  function aloftSpans(lanes) {
    const out = [];
    for (const lane of lanes || []) {
      const cut = suspectSinceMs(lane);
      // the lane's newest observed instant — whatever is still in flight ends
      // exactly here, because that is when the producer last looked.
      let laneLast = -Infinity;
      for (const iv of lane.intervals || []) {
        const e = Date.parse(iv.end);
        if (isFinite(e) && e > laneLast) laneLast = e;
      }
      for (const iv of lane.intervals || []) {
        if (iv.status !== "working") continue;
        const span = clipSpanMs(Date.parse(iv.start), Date.parse(iv.end), cut);
        if (span) out.push({ s: span[0], e: span[1], open: span[1] >= laneLast });
      }
      for (const sa of lane.subagents || []) {
        if (sa.suspect) continue; // a phantom span is drawn, never credited
        const span = clipSpanMs(Date.parse(sa.start), Date.parse(sa.end), cut);
        if (span) out.push({ s: span[0], e: span[1], open: span[1] >= laneLast });
      }
    }
    return out;
  }

  // workIntervalsMs is aloftSpans as plain epoch-ms [start, end] pairs — the
  // input concurrencyProfile takes.
  function workIntervalsMs(lanes) {
    return aloftSpans(lanes).map((x) => [x.s, x.e]);
  }

  // LIVE_TAIL_MS: how recent a lane's newest sample must be for its open spans
  // to count as still running. Providers sample on their own cadence and the
  // frontend re-polls every few seconds, so a live lane's sample is seconds old;
  // a minute of slack absorbs a slow provider without ever calling a stalled
  // feed live.
  const LIVE_TAIL_MS = 60 * 1000;

  // alignLiveTail squares off the trailing edge of a LIVE window's aloft spans.
  //
  // Each provider stamps its open spans with the moment IT last sampled, and
  // those samples are staggered by tens of seconds, so a plain sweep decays
  // step-by-step to zero at the right edge — drawn, it reads as the agents
  // landing one after another when in fact they are all still up. Every span
  // still open as of the newest sample is therefore extended to that sample, so
  // the tail is one flat run at the live level.
  //
  // Returns {intervals, tail}: `intervals` are ms-pairs for concurrencyProfile
  // (the spans untouched when there is no live tail), and `tail` is {t, n} —
  // n agents aloft as of t — or null for a historical window, a stale feed, or
  // nothing running.
  //
  // Pure; `nowMs` and `isLiveWindow` are passed in rather than read from the
  // clock and the day picker.
  function alignLiveTail(spans, nowMs, isLiveWindow) {
    const all = spans || [];
    const plain = all.map((x) => [x.s, x.e]);
    if (!isLiveWindow) return { intervals: plain, tail: null };

    const fresh = (x) => x.open && nowMs - x.e <= LIVE_TAIL_MS;
    let t = -Infinity;
    for (const x of all) if (fresh(x) && x.e > t) t = x.e;
    if (!isFinite(t)) return { intervals: plain, tail: null };

    const intervals = all.map((x) => (fresh(x) ? [x.s, Math.max(x.e, t)] : [x.s, x.e]));
    // the level the step function holds at t — what the tail marker sits on
    let n = 0;
    for (const [s, e] of intervals) if (s <= t && e >= t) n++;
    return n > 0 ? { intervals, tail: { t, n } } : { intervals: plain, tail: null };
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

  // memoryRecords joins a lane to its /api/memory entries. The merged endpoint
  // namespaces session keys by provider exactly as lane.session_id is, so the
  // lane's own id is the primary key; rawSessionId is tried for a single-provider
  // payload that was never namespaced, and laneIdentity's "pid:<n>" for the
  // stretch a session spends unidentified — it emits samples from the moment its
  // process is discovered but receives its id only at its first agent hook, and a
  // lane that has not been identified either is keyed the same way.
  //
  // ALL matching records, not the first — one session can hold two of them at
  // once. The id arrives at an agent hook and does not survive a daemon restart,
  // so a session running across one emits samples under its real id, then under
  // "pid:<n>" until its next hook, then under its id again. Taking the first
  // match reported whichever stretch happened to be looked up first: measured on
  // a live machine after a restart, an idle session had 1 sample under its id and
  // 18 under its pid, and the hover showed the 1.
  //
  // A claim is one record plus the samples of it this lane is entitled to. The
  // id-keyed record names this session and nothing else, so the lane takes it
  // whole. The pid bucket is claimed by inference and is bounded to the lane's
  // own span: a pid outlives the session wearing it, so over a long enough window
  // one bucket can hold the unidentified stretches of two sessions that ran on
  // that pid in turn, and only the overlap is this lane's.
  function memoryRecords(lane, memory) {
    const sessions = memory && memory.sessions;
    if (!lane || !sessions) return [];
    // The pid key is built here rather than taken from laneIdentity, which yields
    // the session id whenever there is one — the very case that has to reach for
    // the pid bucket as well. Both spellings are tried: the merged endpoint
    // namespaces EVERY key by provider, "pid:<n>" included, so a lane in a
    // multi-provider view is looking for "claude:pid:<n>"; a single-provider
    // payload is not namespaced at all and carries the bare form.
    const bare = lane.pid != null ? "pid:" + lane.pid : null;
    const byPid = bare && lane.provider ? lane.provider + ":" + bare : null;
    const out = [];
    const seen = new Set();
    for (const key of [lane.session_id, rawSessionId(lane), byPid, bare]) {
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const record = sessions[key];
      if (!record) continue;
      // A record reached by two keys is one claim, not two: an unidentified
      // lane's identity IS its pid key.
      if (out.some((c) => c.record === record)) continue;
      const inferred = (key === byPid || key === bare) && key !== lane.session_id;
      out.push({ record, samples: claimedSamples(record, lane, inferred), inferred });
    }
    return out;
  }

  // claimedSamples is a record's series as this lane may read it — whole for a
  // record it owns by id, bounded to the lane's span for one it claims by pid.
  // An unusable lane bound fails open rather than dropping the series.
  function claimedSamples(record, lane, inferred) {
    const samples = memSamples(record);
    if (!inferred) return samples;
    const from = Date.parse(lane && lane.start);
    const to = Date.parse(lane && lane.end);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return samples;
    return samples.filter((s) => s.ts >= from && s.ts <= to);
  }

  // mergedSamples is the union of the claims' series in time order.
  function mergedSamples(claims) {
    if (claims.length <= 1) return claims.length ? claims[0].samples : [];
    const all = [];
    for (const claim of claims) all.push(...claim.samples);
    return all.sort((a, b) => a.ts - b.ts);
  }

  // claimStat combines one figure across the claims describing a single session.
  // Peaks take the maximum, which is exact. Averages are re-weighted by each
  // claim's span, which is what time-weighted averages compose to. A claim taken
  // whole reports the producer's scalars, keeping the pre-thinning accuracy that
  // reading them off a bounded series would lose; a claim the span actually cut
  // has to be re-derived from what survived, since the producer's figures then
  // describe more than this lane may count. Where nothing spans any time, a plain
  // mean is the only thing left to say.
  function claimStat(claims, peakKey, avgKey) {
    let peak = null;
    let weighted = 0, span = 0;
    const flat = [];
    for (const claim of claims) {
      const stat = claimFigures(claim, peakKey, avgKey);
      if (stat.peak != null && (peak == null || stat.peak > peak)) peak = stat.peak;
      if (stat.avg == null) continue;
      flat.push(stat.avg);
      if (stat.span > 0) {
        weighted += stat.avg * stat.span;
        span += stat.span;
      }
    }
    let avg = null;
    if (span > 0) avg = Math.round(weighted / span);
    else if (flat.length) avg = Math.round(flat.reduce((x, y) => x + y, 0) / flat.length);
    return { peak, avg };
  }

  // claimFigures is one claim's {peak, avg, span}: the producer's scalars when
  // the claim is whole, re-derived over the surviving samples when it was cut.
  function claimFigures(claim, peakKey, avgKey) {
    const { record, samples } = claim;
    const span = samples.length > 1 ? samples[samples.length - 1].ts - samples[0].ts : 0;
    const cut = samples.length !== memSamples(record).length;
    if (cut) {
      const key = avgKey.startsWith("avg_agent") ? "agent" : "tree";
      const stat = seriesStats(samples, key) || { peak: null, avg: null };
      return { peak: stat.peak, avg: stat.avg, span };
    }
    return { peak: finiteOrNull(record[peakKey]), avg: finiteOrNull(record[avgKey]), span };
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
    const records = memoryRecords(lane, memory);
    if (!records.length) return null;

    let agent = claimStat(records, "peak_agent_bytes", "avg_agent_bytes");
    let tree = claimStat(records, "peak_tree_bytes", "avg_tree_bytes");
    let samples = mergedSamples(records);

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

  // memoryWindow is laneMemory narrowed to [startMs, endMs] — what a lane's
  // memory did during ONE interval, for the interval tooltip. Same result shape
  // minus the scalars' provenance: everything here is re-derived from the
  // samples, because the producer's scalars describe the whole session and
  // there is nothing per-interval to fall back on.
  //
  // NULL when the session has no series covering the window. That is the common
  // case for a short interval and it must stay silent rather than borrowing the
  // session-wide figure, which would quietly attribute a later balloon to an
  // earlier interval — precisely the misreading this view exists to prevent.
  //
  // The window is clipped to the lane's trusted span for the same reason
  // laneMemory clips: samples inside a synthesized tail are not evidence.
  function memoryWindow(lane, memory, startMs, endMs) {
    const records = memoryRecords(lane, memory);
    if (!records.length || !(endMs >= startMs)) return null;
    const cut = suspectSinceMs(lane);
    const bound = cut != null && cut < endMs ? cut : endMs;
    if (!(bound >= startMs)) return null;

    const samples = mergedSamples(records).filter((s) => s.ts >= startMs && s.ts <= bound);
    if (!samples.length) return null;
    const agent = seriesStats(samples, "agent") || { peak: null, avg: null };
    const tree = seriesStats(samples, "tree") || { peak: null, avg: null };
    if (agent.peak == null && tree.peak == null) return null;

    return {
      peakAgentBytes: agent.peak,
      avgAgentBytes: agent.avg,
      peakTreeBytes: tree.peak,
      avgTreeBytes: tree.avg,
      peakSpawnedBytes: spawnedBytes(tree.peak, agent.peak),
      avgSpawnedBytes: spawnedBytes(tree.avg, agent.avg),
      samples,
      clipped: bound !== endMs,
    };
  }

  // pressureWindow summarizes machine-wide memory pressure over [startMs,
  // endMs] (inclusive both ends) for an interval tooltip:
  //
  //   {totalStallUs, stallFraction, minAvailBytes, peakPsiAvg10, samples, windowMs}
  //
  // psi_stall_us is a DELTA over ONE SAMPLE'S INTERVAL — microseconds the
  // machine spent stalled since the previous sample. The deltas TILE the
  // window, so the fold is a SUM, never a peak. A peak of raw deltas is only
  // comparable while every interval is the same length: a 30-second gap's delta
  // dwarfs a 5-second tick's because it covers six times the wall clock, not
  // because the machine was worse. And cadence goes irregular exactly when the
  // daemon is starved, restarted, or the box is thrashing — the OOM
  // neighbourhood this surface exists to explain — so a peak would spike on a
  // MISSED TICK and read as "the machine stalled hard here" when the truth is
  // "we stopped looking here". That is the one lie this surface must not tell.
  //
  // stallFraction (totalStallUs over the window's wall clock) is the share of
  // the window spent stalled, comparable across windows of any length, and the
  // figure to lead with. avail_bytes is a level rather than a delta, hence its
  // MINIMUM: the tightest the headroom got. peakPsiAvg10 is likewise a level —
  // the decaying average at its worst — kept as the human-readable glance.
  //
  // Known, accepted edge: the delta on the window's FIRST sample partially
  // covers time before startMs, so a short window can over-attribute slightly
  // (and stallFraction can exceed 1). Deliberately not corrected for — clamping
  // would hide the tiling rather than fix it, and a renderer showing a percent
  // can cap it at display time.
  //
  // NULL when no sample falls in the window: the series does not cover every
  // interval the timeline can show (it starts when sampling started, and older
  // samples age out). Absent stays absent inside the result too — a window whose
  // samples carry no PSI reports totalStallUs null, never 0, because "not
  // measured" and "never stalled" are different claims and the tooltip trades on
  // the difference. Pressure is machine-wide and never clipped per lane: it
  // belongs to the host, not to any one session.
  function pressureWindow(memory, startMs, endMs) {
    const rows = memory && memory.pressure;
    if (!Array.isArray(rows) || !(endMs >= startMs)) return null;
    let totalStallUs = null, minAvailBytes = null, peakPsiAvg10 = null, samples = 0;
    for (const row of rows) {
      const ts = Date.parse(row && row.ts);
      if (!Number.isFinite(ts) || ts < startMs || ts > endMs) continue;
      samples++;
      const stall = finiteOrNull(row.psi_stall_us);
      if (stall != null) totalStallUs = (totalStallUs == null ? 0 : totalStallUs) + stall;
      const avail = finiteOrNull(row.avail_bytes);
      if (avail != null && (minAvailBytes == null || avail < minAvailBytes)) minAvailBytes = avail;
      const psi = finiteOrNull(row.psi_avg10);
      if (psi != null && (peakPsiAvg10 == null || psi > peakPsiAvg10)) peakPsiAvg10 = psi;
    }
    if (!samples) return null;

    const windowMs = endMs - startMs;
    const stallFraction = totalStallUs != null && windowMs > 0
      ? totalStallUs / (windowMs * 1000)
      : null;
    return { totalStallUs, stallFraction, minAvailBytes, peakPsiAvg10, samples, windowMs };
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

  // summaryCardHasContent gates the pinned card (app.js sessionPopoutHTML): the
  // bar's click is a no-op unless the card would show something the hover did
  // not. That is exactly summaryBodyHTML — the task bullets and the framing
  // prose, both of which the tooltip withholds on purpose so that they stay the
  // reason to click. A lone task counts: it renders a bullet the hover never
  // showed.
  //
  // A record with neither adds only the digest's archival name and the id
  // footer over what the tooltip already printed, so it pins nothing. That does
  // cost something real — the archival name is not shown anywhere else, since
  // the tooltip heads with the /name slug of the span under the cursor — and it
  // is the accepted price. A bar that advertises nothing and then pins a card
  // anyway is the worse failure, and the alternative (advertise the name, so the
  // click is honest) buys a hint on records whose card is one line of text.
  //
  // Deliberately the same predicate as summaryHintText's: hint-empty,
  // body-empty and card-empty are one condition, not three, so nothing is ever
  // clickable with nothing behind it. model.test.js pins that as an invariant
  // across every shape of record.
  function summaryCardHasContent(summary) {
    return Boolean(summary) && summaryBodyHTML(summary) !== "";
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

  // VIEW_ORDER is the left-to-right order of the footer's view switcher, and so
  // the order Tab / Shift+Tab walk. Keep it in step with the buttons in
  // index.html: the keyboard must land where the eye expects the glider to go.
  const VIEW_ORDER = ["sessions", "line", "projects"];

  // stepView returns the view `delta` places along VIEW_ORDER, wrapping at both
  // ends so the cycle has no dead key — Tab past projects lands back on
  // sessions, Shift+Tab off sessions lands on projects. An unrecognized current
  // view is treated as the default (sessions), so a corrupted `sb-view` costs
  // one keypress rather than wedging the cycle.
  function stepView(view, delta) {
    const from = VIEW_ORDER.indexOf(normalizeView(view) || "sessions");
    const n = VIEW_ORDER.length;
    return VIEW_ORDER[(((from + delta) % n) + n) % n];
  }

  // scaleGeometry resolves the footer's px/hour setting against the window on
  // screen. The plot never draws narrower than its container — a short window
  // would otherwise shrink into a corner and leave dead space — so the density
  // actually drawn is the setting FLOORED at "the window exactly fills the
  // width" (fit). The two are not the same number, and the gap is the whole
  // reason this is a shared function: a 100-minute window in a 1100px plot fits
  // at ~670 px/h, so every setting below that draws identically. Reporting or
  // stepping the raw setting there moves a label while the chart holds still.
  // Callers read `effective` for the readout, step off `effective`, and bound
  // the buttons with canZoomIn/canZoomOut.
  function scaleGeometry(spanMs, fitPlotW, pxPerHour, min, max) {
    const hours = spanMs > 0 ? spanMs / 3600e3 : 0;
    // a zero-length window has no density to speak of: no floor, draw to fit
    const fit = hours > 0 ? fitPlotW / hours : 0;
    const effective = Math.max(pxPerHour, fit);
    return {
      plotW: Math.max(fitPlotW, hours * pxPerHour),
      fit,
      effective,
      // a step that lands under the floor redraws the same pixels, so the
      // button that can only do that is spent — floor and ceiling both bound.
      canZoomOut: effective > Math.max(min, fit) + 0.5,
      canZoomIn: effective < max - 0.5,
      // at the floor the chart is showing the whole window with nothing to
      // scroll; the readout is fit's number, not the setting's.
      atFit: fit > 0 && pxPerHour <= fit,
    };
  }

  return {
    scaleGeometry,
    laneIdentity, rawSessionId, leadLabel, nameSegments, buildBar, buildBars,
    spanInefficiency, switchArrivals, packLanes, aloftSpans, workIntervalsMs, concurrencyProfile,
    alignLiveTail,
    projectHoursMs, suspectSinceMs, clipSpanMs, laneActiveMs, suspectTailMs,
    fmtBytes, spawnedBytes, laneMemory, memoryWindow, pressureWindow,
    summaryTasks, summaryBodyHTML, summaryHintText, summaryCardHasContent, normalizeView,
    VIEW_ORDER, stepView,
  };
});
