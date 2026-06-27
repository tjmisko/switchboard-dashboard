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

// Operator lane colors: gold marks "free" time (≥1 agent running while you were
// neither typing into an agent nor recovering from a context switch); dark red
// marks "occupied" time. A context switch occupies you for OP_SWITCH_RECOVERY_MS
// going forward — clustered switches merge, so thrash extends the cost without
// double-counting. Mirrors the effective-added-time accounting.
const OP_FREE_COLOR = "#d4af37";      // gold — free time
const OP_OCCUPIED_COLOR = "#8c4a4c";  // muted dusty red — occupied (typing or switching)
const OP_SWITCH_RECOVERY_MS = 90000;  // 90s of occupied time after each switch

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

function computeOperatorTime(data) {
  const lanes = (data && data.lanes) || [];
  const runPairs = [], focusPairs = [], focusStarts = [];
  for (const lane of lanes) {
    for (const iv of lane.intervals || []) {
      if (!RUNNING_STATUSES.has(iv.status)) continue;
      const s = Date.parse(iv.start), e = Date.parse(iv.end);
      if (isFinite(s) && isFinite(e) && e > s) runPairs.push([s, e]);
    }
    for (const f of lane.focus || []) {
      const s = Date.parse(f.start), e = Date.parse(f.end);
      if (isFinite(s) && isFinite(e) && e > s) { focusPairs.push([s, e]); focusStarts.push(s); }
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
  renderAttentionCard(data.summary || {});
  renderCostCard(data, lastPlan);
}

// renderTopline: the dominant hours figure, top-left. Uses fanout (C) — total
// agent compute, parallelism counted. (Free time lives in the operator lane.)
function renderTopline(summary) {
  el.topline.innerHTML = `
    <div class="th-block">
      <div class="th-val green">${humanDuration(summary.attention_fanout)}</div>
      <div class="th-key">agent hours · fanout (C)</div>
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

// per-lane vertical layout (fixed so axis gridlines align across lanes)
const GEO = {
  GUTTER: 232, RIGHT: 20, AXIS_Y: 16, PLOT_TOP: 26,
  LANE_H: 58, PAD_TOP: 6, RIBBON_H: 5, BAR_H: 18, GAP: 4,
  SUB_ROW_H: 5, SUB_GAP: 2, SUB_ROWS: 3,
  GROUP_HEAD_H: 26,
  OP_LANE_H: 46, OP_BAR_H: 16, // operator free-time lane (sits above the groups)
};

function renderTimeline(data) {
  const lanes = data.lanes || [];
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

  const W = Math.max(620, el.wrap.clientWidth);
  const plotW = Math.max(160, W - GEO.GUTTER - GEO.RIGHT);

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
      yCursor += GEO.LANE_H;
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

  // axis gridlines + labels
  const { ticks, step } = axisTicks(t0, t1);
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
    gl.textContent = (g.project + " · " + g.lanes.length).toUpperCase();
    el.svg.appendChild(gl);
  }

  drawOperatorLane(op, opTop, x, W);

  for (const g of groups) for (const lane of g.lanes) {
    drawLane(lane, lane._top, lane._idx, lane._firstInGroup, x, W, haveActivity, activeGlobal);
  }

  // context switches: each time window focus arrives at a different agent session
  // (the start of every focus span after the first). Drawn as dark-red verticals
  // across the whole plot — dense bands read as thrash.
  const focusStarts = [];
  for (const lane of lanes) for (const f of (lane.focus || [])) {
    const s = Date.parse(f.start);
    if (isFinite(s)) focusStarts.push(s);
  }
  focusStarts.sort((a, b) => a - b);
  const switches = focusStarts.slice(1); // the first arrival is not a switch
  for (const t of switches) {
    el.svg.appendChild(svgEl("line", {
      class: "ctx-switch", x1: x(t), y1: GEO.PLOT_TOP, x2: x(t), y2: plotBottom,
    }));
  }
  if (switches.length) {
    const lbl = svgEl("text", { class: "ctx-switch-count", x: W - GEO.RIGHT, y: GEO.AXIS_Y, "text-anchor": "end" });
    lbl.textContent = switches.length + " context switches";
    el.svg.appendChild(lbl);
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
  return keys.map((k) => ({ project: k, lanes: map.get(k) }));
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

function drawLane(lane, rowTop, idx, firstInGroup, x, W, haveActivity, activeGlobal) {
  const barY = rowTop + GEO.PAD_TOP + GEO.RIBBON_H;
  const subTop = barY + GEO.BAR_H + GEO.GAP;

  // lane row background (subtle alternation) + separator (group header rules the top edge)
  el.svg.appendChild(svgEl("rect", {
    class: idx % 2 ? "lane-bg odd" : "lane-bg", x: 0, y: rowTop, width: W, height: GEO.LANE_H,
  }));
  if (!firstInGroup) el.svg.appendChild(svgEl("line", { class: "lane-sep", x1: 0, y1: rowTop, x2: W, y2: rowTop }));

  // ---- gutter identity + latest label ----
  const labels = lane.labels || [];
  const latest = labels.length ? labels[labels.length - 1].label : laneFallback(lane);
  const idLine = `pid ${lane.pid}` + (lane.agent ? " · " + lane.agent : "")
    + (lane.cost_usd != null ? " · " + fmtUSD(lane.cost_usd) : "");

  const gutter = svgEl("g", { class: "lane-gutter" });
  const main = svgEl("text", { class: "lane-label", x: 10, y: rowTop + 20 });
  const multi = labels.length > 1;
  main.textContent = truncate(latest, multi ? 26 : 30); // leave room for the badge
  if (multi) {
    const badge = svgEl("tspan", { class: "lane-badge", dx: 6 });
    badge.textContent = "•" + labels.length;
    main.appendChild(badge);
  }
  const sub = svgEl("text", { class: "lane-sub", x: 10, y: rowTop + 36 });
  sub.textContent = truncate(idLine, 34);
  gutter.appendChild(main); gutter.appendChild(sub);
  attachGutterTip(gutter, lane, latest);
  el.svg.appendChild(gutter);

  // ---- label-change ribbon (only when the name changed in-window) ----
  if (labels.length > 1) {
    const ribbonY = rowTop + GEO.PAD_TOP;
    for (const ls of labels) {
      const sx = x(Date.parse(ls.start));
      const ex = x(Date.parse(ls.end));
      const seg = svgEl("rect", {
        class: "label-seg", x: sx, y: ribbonY, width: Math.max(2, ex - sx), height: GEO.RIBBON_H, rx: 1,
      });
      attachTip(seg, () => labelTipHTML(ls));
      el.svg.appendChild(seg);
      el.svg.appendChild(svgEl("line", { class: "label-div", x1: sx, y1: ribbonY, x2: sx, y2: barY + GEO.BAR_H }));
    }
  }

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
function truncate(s, n) { return s && s.length > n ? s.slice(0, n - 1) + "…" : s; }

function axisTicks(t0, t1) {
  const span = t1 - t0;
  const M = 60e3, Hr = 3600e3, D = 24 * Hr;
  const steps = [M, 2 * M, 5 * M, 10 * M, 15 * M, 30 * M, Hr, 2 * Hr, 3 * Hr, 6 * Hr, 12 * Hr, D, 2 * D, 7 * D];
  let step = steps[steps.length - 1];
  for (const s of steps) { if (span / s <= 8) { step = s; break; } }
  const ticks = [];
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) ticks.push(t);
  return { ticks, step };
}

// ---------------------------------------------------------------------------
// tooltip HTML builders
// ---------------------------------------------------------------------------

function operatorTipHTML(op) {
  const pct = op.freeFrac == null ? "—" : Math.round(op.freeFrac * 100) + "%";
  return `<div class="t-status" style="color:${OP_FREE_COLOR}">operator free time</div>`
    + `<div class="t-row">free <b>${humanDurationMs(op.freeMs)}</b> · ${pct} of run</div>`
    + `<div class="t-row">occupied ${humanDurationMs(op.occupiedMs)}</div>`
    + `<div class="t-row">agents running ${humanDurationMs(op.runningMs)}</div>`
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

function labelTipHTML(ls) {
  return `<div class="t-status">${escapeHTML(ls.label)}</div>`
    + `<div class="t-row">${fmtClock(ls.start)} – ${fmtClock(ls.end)}</div>`;
}

function gutterTipHTML(lane, latest) {
  const labels = lane.labels || [];
  let html = `<div class="t-status">${escapeHTML(latest)}</div>`;
  html += `<div class="t-row">${escapeHTML(lane.agent || "?")}`
    + (lane.project ? ` · ${escapeHTML(lane.project)}` : "") + ` · pid ${lane.pid}</div>`;
  if (lane.session_id) html += `<div class="t-id">${escapeHTML(lane.session_id)}</div>`;
  if (lane.cost_usd != null) html += `<div class="t-row">cost ${fmtUSD(lane.cost_usd)}</div>`;
  if (labels.length > 1) {
    html += `<div class="t-hist">name history</div>`;
    for (const ls of labels) {
      html += `<div class="t-histrow"><span>${fmtClock(ls.start)}</span> ${escapeHTML(ls.label)}</div>`;
    }
  }
  return html;
}

// ---------------------------------------------------------------------------
// render: consolidated attention + delegation card
// ---------------------------------------------------------------------------

function renderAttentionCard(summary) {
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

  const detail = (label, val, hint) =>
    `<div class="kv"><span class="k">${label}</span><span class="v" title="${hint || ""}">${humanDuration(val)}</span></div>`;

  el.cardAttention.innerHTML = `
    <div class="card-label">attention &amp; delegation</div>
    <div class="headline-row">
      <div class="headline">
        <div class="hv" style="color:${effColor}">${haveDeleg && effPct != null ? effPct + "%" : "—"}</div>
        <div class="hk">delegation effectiveness</div>
      </div>
    </div>
    <div class="kv-list">
      ${detail("union (A) · ≥1 active", summary.attention_union, "wall-clock with ≥1 session active")}
      <div class="kv deemph"><span class="k">per-session (B) · parallelism</span><span class="v">${humanDuration(summary.attention_per_session)}</span></div>
      ${haveDeleg ? `
        <div class="kv-sep"></div>
        ${detail("delegated · agent works, you away", da)}
        ${detail("attended · you supervising", aa)}
        ${detail("prompt · you driving", pa)}
      ` : `<div class="kv muted-note">delegation metrics not recorded for this window</div>`}
    </div>`;
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
  const lanes = (data.lanes || []).slice().sort((a, b) => (b.cost_usd || 0) - (a.cost_usd || 0));
  const pw = data.plan_window || null;

  // per-session rows (only those with a cost)
  const costed = lanes.filter((l) => l.cost_usd != null);
  const sessionRows = costed.length ? costed.map((l) => {
    const name = (l.labels && l.labels.length) ? l.labels[l.labels.length - 1].label : laneFallback(l);
    const tok = (l.tok_in || 0) + (l.tok_out || 0) + (l.tok_cache_read || 0) + (l.tok_cache_create || 0);
    return `<div class="kv"><span class="k" title="${escapeHTML(name)}">${escapeHTML(truncate(name, 30))}</span>
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
      <div class="headline">
        <div class="hv">${fmtUSD(totals.cost_usd)}</div>
        <div class="hk">window total · recomputed</div>
      </div>
    </div>

    <div class="gauge-block">
      <div class="gauge-head">
        <span>5h plan window</span>
        <span class="gauge-figs">
          ${windowDollars != null ? `<b>${fmtUSD(windowDollars)}</b> <span class="dim">ours</span>` : ""}
          ${fhPct != null ? `<b style="color:${pctColor(fhPct)}">${fmtPct(fhPct)}</b>` : `<span class="dim">—</span>`}
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
          <span class="gauge-figs"><b style="color:${pctColor(wkPct)}">${fmtPct(wkPct)}</b></span>
        </div>
        ${gaugeBar(wkPct)}
      ` : ""}
    </div>

    <div class="kv-list session-costs">
      <div class="kv-head">per session</div>
      ${sessionRows}
    </div>`;
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
