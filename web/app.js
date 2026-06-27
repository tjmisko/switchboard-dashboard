"use strict";

// ---------------------------------------------------------------------------
// switchboard-dashboard frontend — activity monitor v2.
// Consumes the v2 `switchboard-ctl timeline --json` contract (via /api/timeline)
// and the read-only plan-usage cache (via /api/plan). Vanilla JS + SVG, no deps.
//
// Contract notes that drive this code:
//   - durations (by_status.*, attention_*, *_active) are NANOSECONDS (÷1e9).
//   - token fields are RAW COUNTS; cost_usd is FLOAT DOLLARS.
//   - timestamps are RFC3339 (variable fractional secs / offset); Date.parse OK.
//   - lanes may be null OR []. Every v2 field is additive + optional → degrade.
//   - v2 lane fields: labels[], subagents[], focus[], cost_usd, tok_*.
//   - v2 summary fields: prompt_active, attended_active, delegated_active,
//     delegation_effectiveness. v2 top-level: plan_window, activity[] (optional).
// Live by default: poll, repaint only on change. Status reads "Live" while
// fresh (<15s) and "last Xs ago" once polling stalls (kills per-second thrash).
// ---------------------------------------------------------------------------

const SVGNS = "http://www.w3.org/2000/svg";
const POLL_MS = 3000;       // /api/timeline poll cadence
const PLAN_POLL_MS = 15000; // /api/plan poll cadence (changes slowly)

// Operator lane colors: green marks "free" time (≥1 agent running while you were
// neither typing into an agent nor recovering from a context switch — you're a
// "free agent"); dark red marks "occupied" time. A context switch occupies you
// for OP_SWITCH_RECOVERY_MS going forward — clustered switches merge, so thrash
// extends the cost without double-counting. Mirrors the effective-added-time
// accounting (the topline "effective day" figure).
const OP_FREE_COLOR = "#3fb950";      // green — free time ("free agent")
const OP_OCCUPIED_COLOR = "#8c4a4c";  // muted dusty red — occupied (typing or switching)
const OP_SWITCH_RECOVERY_MS = 90000;  // 90s of occupied time after each switch
const OP_MIN_ENGAGE_MS = 15000;       // ignore focus spans under 15s — brief glances aren't real editing/switches

// Status -> color. working solid green; delegating faded green; idle yellow;
// permission red; suspended grey; "" (unknown) dim. Mirrors style.css vars.
const STATUS_COLORS = {
  working: "#3fb950",
  delegating: "#3fb950", // legacy: same hue, rendered faded (see DELEGATING_OPACITY)
  dormant: "#3fb950",    // parent waiting on a subagent — green hue, rendered low-alpha (dark) so the subagent's solid green dominates
  idle: "#d29922",
  permission: "#f85149",
  suspended: "#6e7681",
  "": "#3a414c",
};
const DELEGATING_OPACITY = 0.4;  // faded green for legacy delegating intervals
const DORMANT_OPACITY = 0.3;     // darkish low-alpha green for parent-dormant intervals
const SUBAGENT_COLOR = "#3fb950"; // green: the subagent is the one doing the work
const FOCUS_STROKE = "#58a6ff";

// Fixed render order for the status key. "" renders last, labelled "unknown".
// delegating is superseded by dormant; if it ever appears it shows via the extra path.
const STATUS_ORDER = ["working", "dormant", "idle", "permission", "suspended", ""];

function statusLabel(s) { return s === "" ? "unknown" : s; }
function statusColor(s) {
  return STATUS_COLORS[s] !== undefined ? STATUS_COLORS[s] : "#8957e5";
}

// ---------------------------------------------------------------------------
// formatters
// ---------------------------------------------------------------------------

function humanDuration(ns) {
  if (ns == null) return "—";
  if (ns <= 0) return "0s";
  const totalSec = ns / 1e9;
  if (totalSec < 1) return Math.round(ns / 1e6) + "ms";
  let s = Math.floor(totalSec);
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const parts = [];
  if (h) parts.push(h + "h");
  if (m) parts.push(m + "m");
  if (s || parts.length === 0) parts.push(s + "s");
  return parts.join(" ");
}
function humanDurationMs(ms) { return humanDuration(ms * 1e6); }

// humanDurationCoarse renders a duration WITHOUT seconds — for the topline and
// other headline figures where second-level precision is just noise. Rounds to
// the nearest minute; sub-minute durations read "<1m".
function humanDurationCoarse(ns) {
  if (ns == null) return "—";
  if (ns <= 0) return "0m";
  const totalMin = Math.round(ns / 60e9);
  if (totalMin < 1) return "<1m";
  const h = Math.floor(totalMin / 60);
  const m = totalMin - h * 60;
  const parts = [];
  if (h) parts.push(h + "h");
  if (m || !h) parts.push(m + "m");
  return parts.join(" ");
}
function humanDurationCoarseMs(ms) { return humanDurationCoarse(ms * 1e6); }

function humanCount(n) {
  if (n == null) return "0";
  const abs = Math.abs(n);
  const fmt = (v, suffix) => v.toFixed(1).replace(/\.0$/, "") + suffix;
  if (abs >= 1e9) return fmt(n / 1e9, "B");
  if (abs >= 1e6) return fmt(n / 1e6, "M");
  if (abs >= 1e3) return fmt(n / 1e3, "K");
  return String(n);
}

function fmtUSD(v) {
  if (v == null) return "—";
  if (v === 0) return "$0.00";
  if (v < 0.01) return "<$0.01";
  return "$" + v.toFixed(2);
}

function fmtClock(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtPct(v) { return v == null ? "—" : Math.round(v) + "%"; }

// agoString renders elapsed wall time as "just now" / "12s ago" / "3m ago".
function agoString(ms) {
  if (ms == null) return "—";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 2) return "just now";
  if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  return h + "h ago";
}

// resetCountdown renders "resets in 2h 14m" from an RFC3339 instant.
function resetCountdown(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!isFinite(t)) return "";
  const ms = t - Date.now();
  if (ms <= 0) return "resetting…";
  return "resets in " + humanDurationMs(ms);
}

function escapeHTML(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------------------
// interval math (millisecond pairs [start, end])
// ---------------------------------------------------------------------------

function spansToMs(spans) {
  return (spans || [])
    .map((s) => [Date.parse(s.start), Date.parse(s.end)])
    .filter(([a, b]) => isFinite(a) && isFinite(b) && b > a);
}
function unionMs(pairs) {
  if (!pairs.length) return [];
  const a = pairs.slice().sort((x, y) => x[0] - y[0]);
  const out = [a[0].slice()];
  for (let i = 1; i < a.length; i++) {
    const last = out[out.length - 1];
    if (a[i][0] > last[1]) out.push(a[i].slice());
    else if (a[i][1] > last[1]) last[1] = a[i][1];
  }
  return out;
}
function intersectMs(A, B) {
  const out = [];
  for (const [as, ae] of A) for (const [bs, be] of B) {
    const s = Math.max(as, bs), e = Math.min(ae, be);
    if (e > s) out.push([s, e]);
  }
  return unionMs(out);
}
// subtractMs returns A minus B. Both are treated as unioned (sorted, disjoint)
// via unionMs; the result is the parts of A not covered by any interval of B.
function subtractMs(A, B) {
  const a = unionMs(A), b = unionMs(B);
  if (!b.length) return a;
  const out = [];
  for (let [s, e] of a) {
    let cur = s;
    for (const [bs, be] of b) {
      if (be <= cur) continue;
      if (bs >= e) break;
      if (bs > cur) out.push([cur, Math.min(bs, e)]);
      cur = Math.max(cur, be);
      if (cur >= e) break;
    }
    if (cur < e) out.push([cur, e]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const el = {
  day: document.getElementById("day"),
  since: document.getElementById("since"),
  until: document.getElementById("until"),
  clearRange: document.getElementById("clear-range"),
  prevDay: document.getElementById("prev-day"),
  nextDay: document.getElementById("next-day"),
  live: document.getElementById("live"),
  liveDot: document.getElementById("live-dot"),
  updated: document.getElementById("updated"),
  windowLabel: document.getElementById("window-label"),
  error: document.getElementById("error"),
  topline: document.getElementById("topline"),
  statusKey: document.getElementById("status-key"),
  svg: document.getElementById("timeline"),
  wrap: document.getElementById("timeline-wrap"),
  empty: document.getElementById("empty"),
  tooltip: document.getElementById("tooltip"),
  popout: document.getElementById("popout"),
  cardAttention: document.getElementById("card-attention"),
  cardCost: document.getElementById("card-cost"),
  optCtxSwitches: document.getElementById("opt-ctx-switches"),
};

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
let lastData = null;       // parsed timeline (for resize re-render)
let lastTimelineText = ""; // raw timeline JSON (repaint-on-change guard)
let lastPlan = null;       // parsed /api/plan
let lastPlanText = "";
let lastUpdatedAt = null;  // ms of last successful timeline fetch
let fetchOK = false;
let timelineTimer = null;
let planTimer = null;

// ---------------------------------------------------------------------------
// data loading
// ---------------------------------------------------------------------------

function buildQuery() {
  const params = new URLSearchParams();
  const since = el.since.value;
  const until = el.until.value;
  if (since || until) {
    if (since) params.set("since", since);
    if (until) params.set("until", until);
  } else if (el.day.value) {
    params.set("day", el.day.value);
  }
  return params.toString();
}

async function loadTimeline() {
  try {
    const res = await fetch("/api/timeline?" + buildQuery(), { cache: "no-store" });
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try { const j = JSON.parse(text); msg = j.error + (j.stderr ? "\n" + j.stderr : ""); } catch (_) {}
      showError(msg);
      fetchOK = false;
      return;
    }
    hideError();
    fetchOK = true;
    lastUpdatedAt = Date.now();
    if (text === lastTimelineText) { tickLive(); return; } // unchanged → no repaint
    lastTimelineText = text;
    lastData = JSON.parse(text);
    render(lastData);
    tickLive();
  } catch (e) {
    showError(String(e));
    fetchOK = false;
  }
}

async function loadPlan() {
  try {
    const res = await fetch("/api/plan", { cache: "no-store" });
    const text = await res.text();
    if (!res.ok) return;
    if (text === lastPlanText) return;
    lastPlanText = text;
    lastPlan = JSON.parse(text);
    if (lastData) renderCostCard(lastData, lastPlan); // cost gauge depends on plan
  } catch (_) { /* plan is best-effort; leave last known */ }
}

function showError(msg) { el.error.textContent = msg; el.error.hidden = false; }
function hideError() { el.error.hidden = true; }

// ---------------------------------------------------------------------------
// live indicator
// ---------------------------------------------------------------------------

function tickLive() {
  if (!fetchOK && lastUpdatedAt == null) {
    el.updated.textContent = "connecting…";
    setDot("err");
    return;
  }
  // Fresh (<15s) → static "Live" (no per-second thrash). Stale → "last Xs ago".
  const ageMs = lastUpdatedAt == null ? null : Date.now() - lastUpdatedAt;
  if (fetchOK && ageMs != null && ageMs < 15000) {
    el.updated.textContent = "Live";
    setDot("live");
  } else {
    el.updated.textContent = "last " + agoString(lastUpdatedAt);
    setDot(ageMs != null && ageMs < 60000 ? "warn" : "err");
  }
}
function setDot(kind) {
  el.liveDot.className = "dot " + kind;
}

// ---------------------------------------------------------------------------
// operator free-time (derived from focus / context switches)
// ---------------------------------------------------------------------------

// computeOperatorTime partitions the running window into the operator's
// "occupied" vs "free" intervals:
//   running   = union over lanes of running-status intervals (≥1 agent working)
//   typing    = focus ∩ activity-active (you were at the keyboard on an agent)
//   ctxRecov  = ⋃ [switch, switch + 90s] over every context switch (focus
//               arrivals after the first) — clustered switches merge
//   occupied  = (typing ∪ ctxRecov) ∩ running
//   free      = running MINUS (typing ∪ ctxRecov)
// "free time" is the headline: time you actually had while the agents ran and
// you were neither typing nor recovering from a switch. Degrades when focus or
// activity are absent (no activity → any focus counts as typing).
const RUNNING_STATUSES = new Set(["working", "delegating", "dormant"]);

// MIN_SESSION_MS: sessions shorter than a minute aren't rendered anywhere.
const MIN_SESSION_MS = 60000;

// renderableLanes drops sub-minute sessions — too brief to be worth a row. Lanes
// with unparseable bounds are kept (don't hide what we can't measure). Applied
// everywhere lanes are rendered (timeline, operator calc, cost list) so a
// sub-minute session is excluded consistently.
function renderableLanes(lanes) {
  return (lanes || []).filter((lane) => {
    const s = Date.parse(lane.start), e = Date.parse(lane.end);
    if (!isFinite(s) || !isFinite(e)) return true;
    return e - s >= MIN_SESSION_MS;
  });
}

function computeOperatorTime(data) {
  const lanes = renderableLanes((data && data.lanes) || []);
  const runPairs = [], focusPairs = [], focusStarts = [];
  for (const lane of lanes) {
    for (const iv of lane.intervals || []) {
      if (!RUNNING_STATUSES.has(iv.status)) continue;
      const s = Date.parse(iv.start), e = Date.parse(iv.end);
      if (isFinite(s) && isFinite(e) && e > s) runPairs.push([s, e]);
    }
    for (const f of lane.focus || []) {
      const s = Date.parse(f.start), e = Date.parse(f.end);
      // ignore "little" context switches: focus spans under OP_MIN_ENGAGE_MS aren't
      // real editing time and don't count as a switch.
      if (isFinite(s) && isFinite(e) && e - s >= OP_MIN_ENGAGE_MS) { focusPairs.push([s, e]); focusStarts.push(s); }
    }
  }
  const running = unionMs(runPairs);
  const engaged = unionMs(focusPairs);

  // Context-switch recovery: every focus arrival after the first (the same set
  // that draws the ctx-switch verticals) occupies you 90s forward; clustered
  // switches merge via union, so thrash lengthens the interval without ever
  // double-counting the cost.
  focusStarts.sort((a, b) => a - b);
  const switches = focusStarts.slice(1);
  const ctxRecovery = unionMs(switches.map((t) => [t, t + OP_SWITCH_RECOVERY_MS]));

  // Active typing: focused on an agent while globally active (at the keyboard).
  // Without an activity stream, treat any focus as typing.
  const active = unionMs(spansToMs((data.activity || []).filter((a) => a.state === "active")));
  const typing = active.length ? intersectMs(engaged, active) : engaged;

  const occupiedAll = unionMs([...ctxRecovery, ...typing]);
  const occupied = intersectMs(occupiedAll, running); // drawn only while agents run
  const free = subtractMs(running, occupiedAll);

  const sum = (pairs) => pairs.reduce((a, [s, e]) => a + (e - s), 0);
  const runningMs = sum(running);
  const freeMs = sum(free);
  return {
    running, occupied, free,
    runningMs, freeMs,
    occupiedMs: sum(occupied),
    switches: switches.length,
    switchTimes: switches,
    lostMs: sum(intersectMs(ctxRecovery, running)),
    freeFrac: runningMs > 0 ? freeMs / runningMs : null,
  };
}

// ---------------------------------------------------------------------------
// render: top-level
// ---------------------------------------------------------------------------

function render(data) {
  el.windowLabel.textContent = data.window || "—";
  renderTopline(data.summary || {});
  renderStatusKey(data.summary || {});
  renderTimeline(data);
  renderAttentionCard(data.summary || {}, computeOperatorTime(data));
  renderCostCard(data, lastPlan);
}

// renderTopline: two dominant figures framing AI's payoff.
//   additional time (headline) = the EXTRA output-time AI bought you, where
//     extra = agent-hours (fanout, parallelism counted) − the wall-clock you
//     actually spent with ≥1 agent active (union). The subtitle frames it as an
//     extended day — "as if a 27h day" (24h + extra).
//   force multiplier = fanout ÷ union — the average number of "you"s working
//     during active time (≈3 agents in parallel → 3×), assuming you're equally
//     effective with or without the AI.
function renderTopline(summary) {
  const fanout = summary.attention_fanout || 0; // agent-hours, parallelism counted (ns)
  const union = summary.attention_union || 0;   // wall-clock with ≥1 agent active (ns)
  const extra = Math.max(0, fanout - union);
  const DAY = 24 * 3600 * 1e9;                   // ns in a 24h day
  const mult = union > 0 ? fanout / union : null;
  el.topline.innerHTML = `
    <div class="th-block">
      <div class="th-val green">+${humanDuration(extra)}</div>
      <div class="th-key">effective time gained ~ ${humanDuration(DAY + extra)} day</div>
    </div>
    <div class="th-block">
      <div class="th-val">${mult == null ? "—" : mult.toFixed(1) + "×"}</div>
      <div class="th-key">force multiplier · over ${humanDuration(union)} active</div>
    </div>`;
}

// renderStatusKey: the time-by-status list doubles as the swimlane legend; show
// every status incl. zeros, in fixed order, then any unknown future statuses.
function renderStatusKey(summary) {
  const byStatus = summary.by_status || {};
  const seen = new Set(STATUS_ORDER);
  const extra = Object.keys(byStatus).filter((k) => !seen.has(k)).sort();
  const keys = STATUS_ORDER.concat(extra);
  el.statusKey.innerHTML = keys.map((k) => {
    const op = k === "delegating" ? DELEGATING_OPACITY : k === "dormant" ? DORMANT_OPACITY : 1;
    const swatchStyle = `background:${statusColor(k)}` + (op !== 1 ? `;opacity:${op}` : "");
    return `<span class="sk" title="${escapeHTML(statusLabel(k))}">
        <span class="sk-left">
          <span class="swatch" style="${swatchStyle}"></span>
          <span class="sk-name">${statusLabel(k)}</span>
        </span>
        <span class="sk-val">${humanDuration(byStatus[k] || 0)}</span>
      </span>`;
  }).join("");
}

// ---------------------------------------------------------------------------
// render: swimlane timeline (SVG)
// ---------------------------------------------------------------------------

function svgEl(name, attrs) {
  const e = document.createElementNS(SVGNS, name);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}

// per-lane vertical layout. Each session is a compact bar: a name-span band
// stacked directly on the status bar, with the subagent strip reserved only
// when the session actually delegated — so parallel sessions pack tightly.
const GEO = {
  GUTTER: 232, RIGHT: 20, AXIS_Y: 17, PLOT_TOP: 28,
  PAD_TOP: 4, NAME_H: 15, BAR_H: 24, GAP: 3, PAD_BOTTOM: 4,
  SUB_ROW_H: 5, SUB_GAP: 2, SUB_ROWS: 2,
  GROUP_HEAD_H: 26,
  NAME_MIN_W: 28, // hide a span's text below this px width (tooltip still shows it)
  OP_LANE_H: 52, OP_BAR_H: 20, // operator free-time lane (sits above the groups)
  PX_PER_HOUR: 240, // min horizontal density → long windows scroll (see plotW)
};

// laneHeight is the compact vertical footprint of one session bar: name band +
// status bar + paddings, plus a small reserved subagent strip ONLY when the
// session delegated. Sessions without subagents pack tighter.
function laneHeight(lane) {
  let h = GEO.PAD_TOP + GEO.NAME_H + GEO.BAR_H + GEO.PAD_BOTTOM;
  if ((lane.subagents || []).length) h += GEO.GAP + GEO.SUB_ROWS * (GEO.SUB_ROW_H + GEO.SUB_GAP);
  return h;
}

function renderTimeline(data) {
  const lanes = renderableLanes(data.lanes);
  // keep <defs> (first child), drop the rest
  while (el.svg.childNodes.length > 1) el.svg.removeChild(el.svg.lastChild);
  hideTip();

  if (lanes.length === 0) {
    el.empty.hidden = false;
    el.svg.setAttribute("height", 0);
    el.svg.style.height = "0px";
    return;
  }
  el.empty.hidden = true;

  const summary = data.summary || {};
  let t0 = Date.parse(summary.from);
  let t1 = Date.parse(summary.to);
  if (!isFinite(t0) || !isFinite(t1) || t1 <= t0) {
    t0 = Infinity; t1 = -Infinity;
    for (const lane of lanes) for (const iv of lane.intervals || []) {
      t0 = Math.min(t0, Date.parse(iv.start));
      t1 = Math.max(t1, Date.parse(iv.end));
    }
    if (!isFinite(t0) || !isFinite(t1) || t1 <= t0) t1 = t0 + 1;
  }
  const span = t1 - t0;

  // Horizontal scroll: the plot keeps a minimum density (px per hour) so long
  // windows grow WIDER than the viewport and scroll horizontally (the wrap has
  // overflow-x:auto), instead of squishing a whole day into the visible width.
  const containerW = Math.max(620, el.wrap.clientWidth);
  const fitPlotW = Math.max(160, containerW - GEO.GUTTER - GEO.RIGHT);
  const minPlotW = (span / 3600e3) * GEO.PX_PER_HOUR;
  const plotW = Math.max(fitPlotW, minPlotW);
  const W = GEO.GUTTER + plotW + GEO.RIGHT;

  // operator free-time lane occupies the top row, above all project groups.
  const opTop = GEO.PLOT_TOP;
  const op = computeOperatorTime(data);

  // group lanes by project; lay out a header per group, then its lanes, top-down
  const groups = groupByProject(lanes);
  let yCursor = GEO.PLOT_TOP + GEO.OP_LANE_H;
  let laneIdx = 0;
  for (const g of groups) {
    g.headY = yCursor;
    yCursor += GEO.GROUP_HEAD_H;
    for (const lane of g.lanes) {
      lane._top = yCursor;
      lane._idx = laneIdx++;
      lane._firstInGroup = lane === g.lanes[0];
      lane._height = laneHeight(lane);
      yCursor += lane._height;
    }
  }
  const plotBottom = yCursor;
  const H = plotBottom + 14;

  el.svg.setAttribute("width", W);
  el.svg.setAttribute("height", H);
  el.svg.style.width = W + "px";
  el.svg.style.height = H + "px";

  const x = (ms) => {
    let px = GEO.GUTTER + ((ms - t0) / span) * plotW;
    if (px < GEO.GUTTER) px = GEO.GUTTER;
    if (px > GEO.GUTTER + plotW) px = GEO.GUTTER + plotW;
    return px;
  };

  // global activity: idle bands (behind everything) + active set for focus∩active
  const activity = data.activity || [];
  const idleBands = unionMs(spansToMs(activity.filter((a) => a.state === "idle")));
  const activeGlobal = unionMs(spansToMs(activity.filter((a) => a.state === "active")));
  const haveActivity = activity.length > 0;
  for (const [s, e] of idleBands) {
    el.svg.appendChild(svgEl("rect", {
      class: "idle-band", x: x(s), y: GEO.PLOT_TOP, width: Math.max(1, x(e) - x(s)),
      height: plotBottom - GEO.PLOT_TOP,
    }));
  }

  // axis gridlines + labels (tick density scales with the scrollable plot width)
  const { ticks, step } = axisTicks(t0, t1, plotW);
  const showDate = step >= 24 * 3600e3;
  for (const t of ticks) {
    const px = x(t);
    el.svg.appendChild(svgEl("line", { class: "axis-tick", x1: px, y1: GEO.PLOT_TOP, x2: px, y2: plotBottom }));
    const label = svgEl("text", { class: "axis-label", x: px + 3, y: GEO.AXIS_Y });
    const d = new Date(t);
    label.textContent = showDate
      ? d.toLocaleDateString([], { month: "2-digit", day: "2-digit" })
      : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    el.svg.appendChild(label);
  }
  el.svg.appendChild(svgEl("line", { class: "axis-line", x1: GEO.GUTTER, y1: GEO.PLOT_TOP, x2: GEO.GUTTER, y2: plotBottom }));

  // project group headers (rule across full width + label in the gutter)
  for (const g of groups) {
    const ry = g.headY + GEO.GROUP_HEAD_H - 7;
    el.svg.appendChild(svgEl("line", { class: "group-rule", x1: 0, y1: ry, x2: W, y2: ry }));
    const gl = svgEl("text", { class: "group-label", x: 10, y: g.headY + 16 });
    gl.textContent = ((g.projectFull || g.project) + " · " + g.lanes.length).toUpperCase();
    el.svg.appendChild(gl);
  }

  drawOperatorLane(op, opTop, x, W);

  for (const g of groups) for (const lane of g.lanes) {
    drawLane(lane, lane._top, lane._idx, x, W, haveActivity, activeGlobal);
  }
  // context switches (optional, off by default): red verticals at each real
  // (≥15s-engaged) switch — toggled via the "show context switches" chart option.
  // The operator lane already carries the switch cost; this is an opt-in overlay.
  if (el.optCtxSwitches && el.optCtxSwitches.checked) {
    for (const t of op.switchTimes) {
      el.svg.appendChild(svgEl("line", {
        class: "ctx-switch", x1: x(t), y1: GEO.PLOT_TOP, x2: x(t), y2: plotBottom,
      }));
    }
  }
}

// groupByProject buckets lanes by lane.project, preserving lane order within a
// group; groups sort alphabetically with "(no project)" pinned last.
function groupByProject(lanes) {
  const map = new Map();
  for (const lane of lanes) {
    const key = lane.project || "(no project)";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(lane);
  }
  const keys = [...map.keys()].sort((a, b) => {
    const an = a === "(no project)", bn = b === "(no project)";
    if (an !== bn) return an ? 1 : -1;
    return a.localeCompare(b);
  });
  return keys.map((k) => {
    const groupLanes = map.get(k);
    // prefer the pretty full project name (project_full) over the abbreviation
    const full = groupLanes.map((l) => l.project_full).find(Boolean);
    return { project: k, projectFull: full || k, lanes: groupLanes };
  });
}

// drawOperatorLane renders the top "operator" swimlane: gold = free time, dark
// red = occupied (you were typing into an agent, or within 90s of a context
// switch). The two partition the running window.
function drawOperatorLane(op, rowTop, x, W) {
  const barY = rowTop + Math.round((GEO.OP_LANE_H - GEO.OP_BAR_H) / 2);

  el.svg.appendChild(svgEl("rect", { class: "lane-bg op-lane-bg", x: 0, y: rowTop, width: W, height: GEO.OP_LANE_H }));
  // rule along the bottom edge, separating the operator lane from the groups
  el.svg.appendChild(svgEl("line", { class: "group-rule", x1: 0, y1: rowTop + GEO.OP_LANE_H, x2: W, y2: rowTop + GEO.OP_LANE_H }));

  // gutter identity + headline free figure
  const gutter = svgEl("g", { class: "lane-gutter" });
  const main = svgEl("text", { class: "lane-label", x: 10, y: rowTop + 19 });
  main.textContent = "operator";
  const pct = op.freeFrac == null ? "" : ` · ${Math.round(op.freeFrac * 100)}% of run`;
  const sub = svgEl("text", { class: "lane-sub", x: 10, y: rowTop + 35 });
  sub.textContent = `free ${humanDurationMs(op.freeMs)}${pct}`;
  gutter.appendChild(main); gutter.appendChild(sub);
  attachTip(gutter, () => operatorTipHTML(op));
  el.svg.appendChild(gutter);

  // free (gold) then occupied (dark red, drawn on top); disjoint within running
  for (const [s, e] of op.free) {
    const bx = x(s), bw = Math.max(1, x(e) - bx);
    const r = svgEl("rect", { class: "op-bar op-free", x: bx, y: barY, width: bw, height: GEO.OP_BAR_H, rx: 2, fill: OP_FREE_COLOR });
    attachTip(r, () => opSegTipHTML("free", s, e));
    el.svg.appendChild(r);
  }
  for (const [s, e] of op.occupied) {
    const bx = x(s), bw = Math.max(1, x(e) - bx);
    const r = svgEl("rect", { class: "op-bar op-occupied", x: bx, y: barY, width: bw, height: GEO.OP_BAR_H, rx: 2, fill: OP_OCCUPIED_COLOR });
    attachTip(r, () => opSegTipHTML("occupied", s, e));
    el.svg.appendChild(r);
  }
}

function drawLane(lane, rowTop, idx, x, W, haveActivity, activeGlobal) {
  const height = lane._height;
  const nameY = rowTop + GEO.PAD_TOP;
  const barY = nameY + GEO.NAME_H;
  const subTop = barY + GEO.BAR_H + GEO.GAP;

  // lane row background (subtle alternation) + separator (group header rules the top edge)
  el.svg.appendChild(svgEl("rect", {
    class: idx % 2 ? "lane-bg odd" : "lane-bg", x: 0, y: rowTop, width: W, height,
  }));
  if (!lane._firstInGroup) el.svg.appendChild(svgEl("line", { class: "lane-sep", x1: 0, y1: rowTop, x2: W, y2: rowTop }));

  // ---- gutter: STABLE session identity (never the name, so a /name rename
  // can't re-label or split the row). The pid is intentionally NOT shown here —
  // it stays in the hover tooltip — so the row reads as agent + short session id
  // with cost beneath. ----
  const shortId = lane.session_id ? lane.session_id.slice(0, 8) : null;
  const idMain = [lane.agent, shortId].filter(Boolean).join(" · ") || `pid ${lane.pid}`;
  const idBits = [];
  if (lane.cost_usd != null) idBits.push(fmtUSD(lane.cost_usd));
  const gutter = svgEl("g", { class: "lane-gutter" });
  gutter.setAttribute("data-session", laneIdentity(lane)); // bars are keyed by identity, not name
  const main = svgEl("text", { class: "lane-label", x: 10, y: rowTop + 16 });
  main.textContent = truncate(idMain, 32);
  const sub = svgEl("text", { class: "lane-sub", x: 10, y: rowTop + 35 });
  sub.textContent = truncate(idBits.join(" · "), 34);
  gutter.appendChild(main); gutter.appendChild(sub);
  attachGutterTip(gutter, lane, currentName(lane));
  el.svg.appendChild(gutter);

  // ---- name-span band: each /name slug labels the stretch it was active; the
  // leading pre-/name stretch falls back to project_full/project (see model.js). ----
  nameSegments(lane).forEach((seg, i) => {
    const sx = x(seg.start), ex = x(seg.end), sw = Math.max(1, ex - sx);
    const isLead = seg.kind === "lead";
    const bg = svgEl("rect", {
      class: "name-seg" + (isLead ? " lead" : ""), x: sx, y: nameY, width: sw, height: GEO.NAME_H, rx: 1,
    });
    attachTip(bg, () => nameSegTipHTML(lane, seg));
    el.svg.appendChild(bg);
    // a dashed divider marks each rename boundary (skip the redundant left edge)
    if (i > 0) el.svg.appendChild(svgEl("line", { class: "name-div", x1: sx, y1: nameY, x2: sx, y2: barY + GEO.BAR_H }));
    if (sw >= GEO.NAME_MIN_W && seg.label) {
      const t = svgEl("text", { class: "name-seg-label" + (isLead ? " lead" : ""), x: sx + 4, y: nameY + 11 });
      t.textContent = truncate(seg.label, Math.max(1, Math.floor((sw - 6) / 6.6)));
      el.svg.appendChild(t);
    }
  });

  // ---- main status bars ----
  for (const iv of lane.intervals || []) {
    const start = Date.parse(iv.start);
    const end = Date.parse(iv.end);
    const bx = x(start);
    const bw = Math.max(1, x(end) - bx);
    const attrs = {
      class: "bar", x: bx, y: barY, width: bw, height: GEO.BAR_H, rx: 2,
      fill: statusColor(iv.status),
    };
    if (iv.status === "delegating") attrs["fill-opacity"] = DELEGATING_OPACITY;
    else if (iv.status === "dormant") attrs["fill-opacity"] = DORMANT_OPACITY;
    const rect = svgEl("rect", attrs);
    attachTip(rect, () => intervalTipHTML(lane, iv));
    el.svg.appendChild(rect);
  }

  // ---- focus / attention overlay (hatch + outline) ----
  const focusMs = spansToMs(lane.focus);
  if (focusMs.length) {
    const attended = haveActivity ? intersectMs(focusMs, activeGlobal) : unionMs(focusMs);
    for (const [s, e] of attended) {
      const ox = x(s), ow = Math.max(1, x(e) - ox);
      el.svg.appendChild(svgEl("rect", {
        class: "focus-overlay", x: ox, y: barY - 1.5, width: ow, height: GEO.BAR_H + 3, rx: 2,
        fill: "url(#hatch)", stroke: FOCUS_STROKE,
      }));
    }
  }

  // ---- subagent sub-bars (packed into rows by overlap) ----
  const subs = (lane.subagents || [])
    .map((sa) => ({ ...sa, s: Date.parse(sa.start), e: Date.parse(sa.end) }))
    .filter((sa) => isFinite(sa.s) && isFinite(sa.e) && sa.e > sa.s)
    .sort((a, b) => a.s - b.s);
  const rowEnds = [];
  for (const sa of subs) {
    let r = rowEnds.findIndex((end) => sa.s >= end);
    if (r === -1) { rowEnds.push(sa.e); r = rowEnds.length - 1; }
    else rowEnds[r] = sa.e;
    const ry = subTop + Math.min(r, GEO.SUB_ROWS - 1) * (GEO.SUB_ROW_H + GEO.SUB_GAP);
    const sx = x(sa.s), sw = Math.max(2, x(sa.e) - sx);
    const bar = svgEl("rect", {
      class: "subagent-bar", x: sx, y: ry, width: sw, height: GEO.SUB_ROW_H, rx: 1.5, fill: SUBAGENT_COLOR,
    });
    attachTip(bar, () => subagentTipHTML(sa));
    bar.addEventListener("click", (ev) => { ev.stopPropagation(); pinPopout(subagentPopoutHTML(sa), ev); });
    el.svg.appendChild(bar);
  }
}

function laneFallback(lane) {
  const parts = [];
  if (lane.project) parts.push(lane.project);
  if (lane.agent) parts.push(lane.agent);
  parts.push("pid " + lane.pid);
  return parts.join(" · ");
}
// currentName is the session's latest name: the canonical `name`, else the last
// /name slug, else the last raw label, else the project/pid fallback.
function currentName(lane) {
  if (lane.name) return lane.name;
  const names = lane.names || [];
  if (names.length) return names[names.length - 1].label;
  const labels = lane.labels || [];
  if (labels.length) return labels[labels.length - 1].label;
  return laneFallback(lane);
}
function truncate(s, n) { return s && s.length > n ? s.slice(0, n - 1) + "…" : s; }

function axisTicks(t0, t1, plotW) {
  const span = t1 - t0;
  const M = 60e3, Hr = 3600e3, D = 24 * Hr;
  const steps = [M, 2 * M, 5 * M, 10 * M, 15 * M, 30 * M, Hr, 2 * Hr, 3 * Hr, 6 * Hr, 12 * Hr, D, 2 * D, 7 * D];
  // aim for a label roughly every ~150px so a wide, scrolled plot stays legible
  const target = Math.max(4, Math.min(24, Math.round((plotW || 600) / 150)));
  let step = steps[steps.length - 1];
  for (const s of steps) { if (span / s <= target) { step = s; break; } }
  const ticks = [];
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) ticks.push(t);
  return { ticks, step };
}

// ---------------------------------------------------------------------------
// tooltip HTML builders
// ---------------------------------------------------------------------------

// formulaTipHTML builds an elegant hover "descriptor" for a derived figure:
//   title   — what the number is
//   formula — how it's computed (mono, e.g. "fanout ÷ union")
//   result  — the computed value (bold)
//   why     — one line on why it matters / what it means
// Reuses the global tooltip styling (.t-status + .t-formula/.t-result/.t-why).
// Any field may be omitted; `color` tints the title. Pass the returned string to
// an element's data-tip attribute (escaped) and wire it with attachFormulaTips.
function formulaTipHTML({ title, formula, result, why, color } = {}) {
  let html = "";
  if (title) html += `<div class="t-status"${color ? ` style="color:${color}"` : ""}>${escapeHTML(title)}</div>`;
  if (formula) html += `<div class="t-formula">${escapeHTML(formula)}</div>`;
  if (result != null && result !== "") html += `<div class="t-result">= <b>${escapeHTML(String(result))}</b></div>`;
  if (why) html += `<div class="t-why">${escapeHTML(why)}</div>`;
  return html;
}

function operatorTipHTML(op) {
  const pct = op.freeFrac == null ? "—" : Math.round(op.freeFrac * 100) + "%";
  return `<div class="t-status" style="color:${OP_FREE_COLOR}">operator free time</div>`
    + `<div class="t-row">free <b>${humanDurationMs(op.freeMs)}</b> · ${pct} of run</div>`
    + `<div class="t-row">occupied ${humanDurationMs(op.occupiedMs)}</div>`
    + `<div class="t-row">agents running ${humanDurationMs(op.runningMs)}</div>`
    + `<div class="t-row">${op.switches} context switch${op.switches === 1 ? "" : "es"}</div>`
    + `<div class="t-hint">occupied = typing, or within 90s of a context switch</div>`;
}

function opSegTipHTML(kind, s, e) {
  const free = kind === "free";
  return `<div class="t-status" style="color:${free ? OP_FREE_COLOR : "#e5534b"}">${free ? "free" : "occupied"}</div>`
    + `<div class="t-row">${fmtClock(new Date(s).toISOString())} – ${fmtClock(new Date(e).toISOString())}</div>`
    + `<div class="t-row">${humanDurationMs(e - s)}</div>`;
}

function intervalTipHTML(lane, iv) {
  const durMs = Date.parse(iv.end) - Date.parse(iv.start);
  const sub = iv.subagents || 0;
  const note = iv.status === "delegating" ? " (delegating — faded)"
    : iv.status === "dormant" ? " (waiting on subagent)" : "";
  return `<div class="t-status" style="color:${statusColor(iv.status)}">${statusLabel(iv.status)}${note}</div>`
    + `<div class="t-row">${fmtClock(iv.start)} – ${fmtClock(iv.end)}</div>`
    + `<div class="t-row">${humanDurationMs(durMs)}</div>`
    + (sub > 0 ? `<div class="t-sub">${sub} subagent${sub === 1 ? "" : "s"} at start</div>` : "");
}

function subagentTipHTML(sa) {
  const durMs = sa.e - sa.s;
  return `<div class="t-status" style="color:${SUBAGENT_COLOR}">${escapeHTML(sa.agent_type || "subagent")}</div>`
    + (sa.description ? `<div class="t-desc">${escapeHTML(sa.description)}</div>` : "")
    + `<div class="t-row">${fmtClock(sa.start)} – ${fmtClock(sa.end)} · ${humanDurationMs(durMs)}</div>`
    + `<div class="t-hint">click to pin</div>`;
}

function subagentPopoutHTML(sa) {
  const durMs = sa.e - sa.s;
  return `<div class="po-head" style="color:${SUBAGENT_COLOR}">${escapeHTML(sa.agent_type || "subagent")}</div>`
    + (sa.description ? `<div class="po-desc">${escapeHTML(sa.description)}</div>` : "")
    + `<div class="po-row">duration <b>${humanDurationMs(durMs)}</b></div>`
    + `<div class="po-row">${fmtClock(sa.start)} – ${fmtClock(sa.end)}</div>`
    + (sa.tool_use_id ? `<div class="po-id">${escapeHTML(sa.tool_use_id)}</div>` : "");
}

function nameSegTipHTML(lane, seg) {
  const durMs = seg.end - seg.start;
  const note = seg.kind === "lead" ? " (before first /name)" : "";
  const ineff = spanInefficiency(lane, seg.start, seg.end);
  return `<div class="t-status">${escapeHTML(seg.label || "(unnamed)")}${note}</div>`
    + `<div class="t-row">${fmtClock(seg.start)} – ${fmtClock(seg.end)}</div>`
    + `<div class="t-row">${humanDurationMs(durMs)}</div>`
    + (ineff != null ? `<div class="t-row">operator inefficiency ${Math.round(ineff * 100)}% <span class="dim">idle/waiting</span></div>` : "");
}

function gutterTipHTML(lane, name) {
  let html = `<div class="t-status">${escapeHTML(name)}</div>`;
  html += `<div class="t-row">${escapeHTML(lane.agent || "?")}`
    + (lane.project ? ` · ${escapeHTML(lane.project)}` : "") + ` · pid ${lane.pid}</div>`;
  if (lane.session_id) html += `<div class="t-id">${escapeHTML(lane.session_id)}</div>`;
  if (lane.cost_usd != null) html += `<div class="t-row">cost ${fmtUSD(lane.cost_usd)}</div>`;
  // name-span history (one row per stretch, incl. the pre-/name lead).
  const segs = nameSegments(lane);
  if (segs.length > 1) {
    html += `<div class="t-hist">name spans</div>`;
    for (const seg of segs) {
      const text = escapeHTML(seg.label || "(unnamed)");
      const labelHTML = seg.kind === "lead" ? `<span class="lead">${text}</span>` : text;
      html += `<div class="t-histrow"><span>${fmtClock(seg.start)}</span> ${labelHTML}</div>`;
    }
  }
  return html;
}

// ---------------------------------------------------------------------------
// render: consolidated attention + delegation card
// ---------------------------------------------------------------------------

function renderAttentionCard(summary, op) {
  const da = summary.delegated_active, aa = summary.attended_active, pa = summary.prompt_active;
  let eff = summary.delegation_effectiveness;
  if (eff == null && (da != null || aa != null)) {
    const d = da || 0, a = aa || 0;
    eff = d + a > 0 ? d / (d + a) : null;
  }
  const haveDeleg = da != null || aa != null || pa != null || summary.delegation_effectiveness != null;
  const effPct = eff == null ? null : Math.round(eff * 100);
  const effColor = effPct == null ? "var(--fg-muted)"
    : effPct >= 66 ? "var(--c-working)" : effPct >= 33 ? "var(--c-idle)" : "var(--c-permission)";

  // tip() → escaped formula-descriptor HTML for a data-tip attribute.
  const tip = (obj) => escapeHTML(formulaTipHTML(obj));
  // row() builds a .kv with a hover descriptor on the whole row (larger hit target).
  const row = (label, valHTML, tipObj, cls = "") =>
    `<div class="kv ${cls} has-tip" data-tip="${tip(tipObj)}"><span class="k">${label}</span><span class="v">${valHTML}</span></div>`;

  const effTip = tip({
    title: "delegation effectiveness",
    formula: "delegated ÷ (delegated + attended)",
    result: effPct == null ? "—" : effPct + "%",
    why: "Share of active agent-time where the agent worked while you were away vs. supervising — higher = more leverage.",
    color: effColor,
  });
  const ctxTip = tip({
    title: "context switches",
    formula: "focus arrivals − 1",
    result: op ? String(op.switches) : "—",
    why: "How many times you moved your attention between sessions.",
    color: "var(--accent)",
  });
  const lostTip = tip({
    title: "operator time lost to AI",
    formula: "Σ 90s recovery per switch (clustered merged) ∩ running",
    result: op ? humanDurationMs(op.lostMs) : "—",
    why: "Time absorbed re-acquiring context after switches while agents ran.",
    color: "var(--c-permission)",
  });

  el.cardAttention.innerHTML = `
    <div class="card-label">attention &amp; delegation</div>
    <div class="headline-row">
      <div class="headline has-tip" data-tip="${effTip}">
        <div class="hv" style="color:${effColor}">${haveDeleg && effPct != null ? effPct + "%" : "—"}</div>
        <div class="hk">delegation effectiveness</div>
      </div>
    </div>

    <div class="kv-head">attention</div>
    <div class="kv-list">
      ${row("union (A) · ≥1 active", humanDuration(summary.attention_union), {
        title: "union (A) · ≥1 active",
        formula: "wall-clock with ≥1 session active",
        result: humanDuration(summary.attention_union),
        why: "Real time elapsed while at least one agent was running.",
      })}
      ${row("per-session (B) · parallelism", humanDuration(summary.attention_per_session), {
        title: "per-session (B)",
        formula: "Σ per-session active time",
        result: humanDuration(summary.attention_per_session),
        why: "Total active time counting parallel sessions separately (parallelism counted).",
      }, "deemph")}
    </div>

    ${haveDeleg ? `
      <div class="kv-sep"></div>
      <div class="kv-head">delegation</div>
      <div class="kv-list">
        ${row("delegated · agent works, you away", humanDuration(da), {
          title: "delegated",
          formula: "agent active while you were away",
          result: humanDuration(da),
          why: "Agent kept working without supervision — pure leverage.",
          color: "var(--c-working)",
        })}
        ${row("attended · you supervising", humanDuration(aa), {
          title: "attended",
          formula: "agent active while you supervised",
          result: humanDuration(aa),
          why: "Agent worked while you watched — useful, but not leverage.",
          color: "var(--c-idle)",
        })}
        ${row("prompt · you driving", humanDuration(pa), {
          title: "prompt",
          formula: "you actively driving (typing)",
          result: humanDuration(pa),
          why: "Hands-on time where you were actively prompting.",
        })}
      </div>
    ` : `<div class="kv-sep"></div><div class="kv muted-note">delegation metrics not recorded for this window</div>`}

    <div class="op-overhead">
      <div class="op-overhead-head">operator overhead</div>
      <div class="op-overhead-row has-tip" data-tip="${ctxTip}">
        <span class="oo-k">context switches</span><span class="oo-v">${op ? op.switches : "—"}</span>
      </div>
      <div class="op-overhead-row has-tip" data-tip="${lostTip}">
        <span class="oo-k">operator time lost to AI</span><span class="oo-v">${op ? humanDurationMs(op.lostMs) : "—"}</span>
      </div>
    </div>`;

  attachFormulaTips(el.cardAttention);
}

// ---------------------------------------------------------------------------
// render: cost card (window total + per-session + 5h plan gauge)
// ---------------------------------------------------------------------------

function gaugeBar(pct) {
  const p = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  // fill color is owned by CSS (warm orange); pct still drives the % figure color.
  return `<div class="gauge"><div class="gauge-fill" style="width:${p}%"></div></div>`;
}
function pctColor(pct) {
  if (pct == null) return "var(--fg-muted)";
  return pct >= 80 ? "var(--c-permission)" : pct >= 50 ? "var(--c-idle)" : "var(--c-working)";
}

function renderCostCard(data, plan) {
  const totals = data.totals || {};
  const lanes = renderableLanes(data.lanes).slice().sort((a, b) => (b.cost_usd || 0) - (a.cost_usd || 0));
  const pw = data.plan_window || null;

  // tip() → escaped formula-descriptor HTML for a data-tip attribute.
  const tip = (obj) => escapeHTML(formulaTipHTML(obj));

  // per-session rows (only those with a cost)
  const costed = lanes.filter((l) => l.cost_usd != null);
  const sessionRows = costed.length ? costed.map((l) => {
    const name = currentName(l);
    const tok = (l.tok_in || 0) + (l.tok_out || 0) + (l.tok_cache_read || 0) + (l.tok_cache_create || 0);
    const rowTip = tip({
      title: name,
      formula: "session cost = Σ tokens × model price",
      result: fmtUSD(l.cost_usd) + " · " + humanCount(tok) + " tok",
      why: "Recomputed spend for this session from its token usage and model prices.",
    });
    return `<div class="kv has-tip" data-tip="${rowTip}"><span class="k" title="${escapeHTML(name)}">${escapeHTML(truncate(name, 30))}</span>
      <span class="v">${fmtUSD(l.cost_usd)} <span class="dim">· ${humanCount(tok)} tok</span></span></div>`;
  }).join("") : `<div class="kv muted-note">no per-session cost in this window</div>`;

  // 5h plan gauge: our $ (plan_window) + official % (plan cache)
  const fh = plan && plan.available ? plan.five_hour : null;
  const wk = plan && plan.available ? plan.seven_day : null;
  const fhPct = fh && fh.utilization != null ? fh.utilization : null;
  const wkPct = wk && wk.utilization != null ? wk.utilization : null;
  const stale = plan && plan.available && plan.stale;
  const freshness = !plan || !plan.available
    ? `<span class="dim">official % unavailable</span>`
    : `<span class="${stale ? "stale" : "dim"}">official % · updated ${agoString(Date.parse(plan.mtime))}${stale ? " (stale)" : ""}</span>`;

  const windowDollars = pw && pw.cost_usd != null ? pw.cost_usd : null;

  el.cardCost.innerHTML = `
    <div class="card-label">cost</div>
    <div class="headline-row">
      <div class="headline has-tip" data-tip="${tip({
        title: "window total",
        formula: "Σ tokens × model price (recomputed)",
        result: fmtUSD(totals.cost_usd),
        why: "Total spend for this window, recomputed from token counts and current model prices.",
      })}">
        <div class="hv">${fmtUSD(totals.cost_usd)}</div>
        <div class="hk">window total · recomputed</div>
      </div>
    </div>

    <div class="gauge-block">
      <div class="gauge-head">
        <span>5h plan window</span>
        <span class="gauge-figs">
          ${windowDollars != null ? `<span class="has-tip" data-tip="${tip({
            title: "5h window — ours",
            formula: "our $ spent this 5h plan window",
            result: fmtUSD(windowDollars),
            why: "Cost we recomputed for sessions in the current 5-hour plan window.",
          })}"><b>${fmtUSD(windowDollars)}</b> <span class="dim">ours</span></span>` : ""}
          ${fhPct != null ? `<b class="has-tip" style="color:${pctColor(fhPct)}" data-tip="${tip({
            title: "5h plan usage — official",
            formula: "from the read-only plan-usage cache",
            result: fmtPct(fhPct),
            why: "Official utilization of your 5-hour plan window, read from the local plan-usage cache.",
          })}">${fmtPct(fhPct)}</b>` : `<span class="dim">—</span>`}
        </span>
      </div>
      ${gaugeBar(fhPct)}
      <div class="gauge-foot">
        <span>${fh && fh.resets_at ? resetCountdown(fh.resets_at) : ""}</span>
        ${freshness}
      </div>
      ${wkPct != null ? `
        <div class="gauge-head week">
          <span>weekly</span>
          <span class="gauge-figs"><b class="has-tip" style="color:${pctColor(wkPct)}" data-tip="${tip({
            title: "weekly plan usage",
            formula: "7-day plan utilization",
            result: fmtPct(wkPct),
            why: "Utilization of your 7-day (weekly) plan allowance.",
          })}">${fmtPct(wkPct)}</b></span>
        </div>
        ${gaugeBar(wkPct)}
      ` : ""}
    </div>

    <div class="kv-list session-costs">
      <div class="kv-head">per session</div>
      ${sessionRows}
    </div>`;

  attachFormulaTips(el.cardCost);
}

// ---------------------------------------------------------------------------
// tooltip + popout
// ---------------------------------------------------------------------------

function attachTip(node, htmlFn) {
  node.addEventListener("mouseenter", (ev) => showTip(htmlFn(), ev));
  node.addEventListener("mousemove", moveTip);
  node.addEventListener("mouseleave", hideTip);
}
function attachGutterTip(node, lane, latest) {
  node.addEventListener("mouseenter", (ev) => showTip(gutterTipHTML(lane, latest), ev));
  node.addEventListener("mousemove", moveTip);
  node.addEventListener("mouseleave", hideTip);
}
// attachFormulaTips wires the hover descriptor box onto every [data-tip] element
// inside `container`. Each element carries data-tip set to a pre-built HTML string
// (use formulaTipHTML, embedded escaped: data-tip="${escapeHTML(formulaTipHTML(...))}").
// The DOM decodes the attribute on read, so showTip renders the box. Reuses the
// global tooltip; call AFTER setting the container's innerHTML.
function attachFormulaTips(container) {
  if (!container) return;
  container.querySelectorAll("[data-tip]").forEach((node) => {
    const html = node.getAttribute("data-tip");
    node.addEventListener("mouseenter", (ev) => showTip(html, ev));
    node.addEventListener("mousemove", moveTip);
    node.addEventListener("mouseleave", hideTip);
  });
}

function showTip(html, ev) { el.tooltip.innerHTML = html; el.tooltip.hidden = false; moveTip(ev); }
function moveTip(ev) {
  const pad = 14, r = el.tooltip.getBoundingClientRect();
  let x = ev.clientX + pad, y = ev.clientY + pad;
  if (x + r.width > window.innerWidth) x = ev.clientX - r.width - pad;
  if (y + r.height > window.innerHeight) y = ev.clientY - r.height - pad;
  el.tooltip.style.left = x + "px"; el.tooltip.style.top = y + "px";
}
function hideTip() { el.tooltip.hidden = true; }

function pinPopout(html, ev) {
  hideTip();
  el.popout.innerHTML = `<button class="po-close" title="close">✕</button>` + html;
  el.popout.hidden = false;
  el.popout.querySelector(".po-close").addEventListener("click", hidePopout);
  const pad = 14, r = el.popout.getBoundingClientRect();
  let x = ev.clientX + pad, y = ev.clientY + pad;
  if (x + r.width > window.innerWidth) x = window.innerWidth - r.width - pad;
  if (y + r.height > window.innerHeight) y = ev.clientY - r.height - pad;
  el.popout.style.left = Math.max(8, x) + "px";
  el.popout.style.top = Math.max(8, y) + "px";
}
function hidePopout() { el.popout.hidden = true; }

// ---------------------------------------------------------------------------
// controls
// ---------------------------------------------------------------------------

function todayLocal() {
  const d = new Date();
  return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function shiftDay(base, delta) {
  const d = new Date((base || todayLocal()) + "T00:00:00");
  d.setDate(d.getDate() + delta);
  return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function reloadNow() { hidePopout(); loadTimeline(); }

function applyUrlParams() {
  const q = new URLSearchParams(window.location.search);
  el.since.value = q.get("since") || "";
  el.until.value = q.get("until") || "";
  el.day.value = q.get("day") || todayLocal();
}

function init() {
  applyUrlParams();

  el.day.addEventListener("change", reloadNow);
  el.since.addEventListener("change", reloadNow);
  el.until.addEventListener("change", reloadNow);
  el.prevDay.addEventListener("click", () => { el.day.value = shiftDay(el.day.value, -1); el.since.value = el.until.value = ""; reloadNow(); });
  el.nextDay.addEventListener("click", () => { el.day.value = shiftDay(el.day.value, +1); el.since.value = el.until.value = ""; reloadNow(); });
  el.live.addEventListener("click", () => { el.day.value = todayLocal(); el.since.value = el.until.value = ""; reloadNow(); });
  el.clearRange.addEventListener("click", () => { el.since.value = el.until.value = ""; reloadNow(); });
  el.optCtxSwitches.addEventListener("change", () => { if (lastData) renderTimeline(lastData); });

  // dismiss popout on outside click / Escape
  document.addEventListener("click", (ev) => {
    if (!el.popout.hidden && !el.popout.contains(ev.target)) hidePopout();
  });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") hidePopout(); });

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (lastData) renderTimeline(lastData); }, 120);
  });

  // live polling — no manual refresh controls
  loadTimeline();
  loadPlan();
  timelineTimer = setInterval(loadTimeline, POLL_MS);
  planTimer = setInterval(loadPlan, PLAN_POLL_MS);
  setInterval(tickLive, 1000);
}

init();
