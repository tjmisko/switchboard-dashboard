"use strict";

// ---------------------------------------------------------------------------
// switchboard-dashboard frontend.
// Consumes `switchboard-ctl timeline --json` (proxied via /api/timeline).
// Contract notes that drive this code:
//   - by_status.* and attention_* are NANOSECONDS (divide by 1e9).
//   - token fields are RAW COUNTS (no grand total; sum the four).
//   - timestamps are RFC3339 with variable fractional seconds and may carry a
//     non-Z offset (live "today" lanes); new Date(str) parses all of these.
//   - lanes may be null OR [].
// ---------------------------------------------------------------------------

const SVGNS = "http://www.w3.org/2000/svg";

// Status -> color. working/delegating are "active" (green); idle yellow;
// permission red; suspended and "" (unknown) grey. Mirrors style.css vars.
const STATUS_COLORS = {
  working: "#3fb950",
  delegating: "#2ea043",
  idle: "#d29922",
  permission: "#f85149",
  suspended: "#6e7681",
  "": "#3a414c",
};

// Fixed render order for legend + breakdown. "" renders last, labelled "unknown".
const STATUS_ORDER = ["working", "delegating", "idle", "permission", "suspended", ""];

function statusLabel(s) {
  return s === "" ? "unknown" : s;
}
function statusColor(s) {
  return STATUS_COLORS[s] !== undefined ? STATUS_COLORS[s] : "#8957e5"; // unknown future status -> purple
}

// ---------------------------------------------------------------------------
// formatters
// ---------------------------------------------------------------------------

// humanDuration renders a nanosecond duration like "2h 4m" / "300ms".
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

// humanDurationMs converts a millisecond span to a human duration.
function humanDurationMs(ms) {
  return humanDuration(ms * 1e6);
}

// humanCount renders a raw integer like 1453250 -> "1.5M".
function humanCount(n) {
  if (n == null) return "0";
  const abs = Math.abs(n);
  const fmt = (v, suffix) => (v.toFixed(1).replace(/\.0$/, "")) + suffix;
  if (abs >= 1e9) return fmt(n / 1e9, "B");
  if (abs >= 1e6) return fmt(n / 1e6, "M");
  if (abs >= 1e3) return fmt(n / 1e3, "K");
  return String(n);
}

function fmtClock(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const el = {
  day: document.getElementById("day"),
  since: document.getElementById("since"),
  until: document.getElementById("until"),
  clearRange: document.getElementById("clear-range"),
  refresh: document.getElementById("refresh"),
  autorefresh: document.getElementById("autorefresh"),
  status: document.getElementById("status"),
  error: document.getElementById("error"),
  summary: document.getElementById("summary"),
  windowLabel: document.getElementById("window-label"),
  legend: document.getElementById("legend"),
  svg: document.getElementById("timeline"),
  wrap: document.getElementById("timeline-wrap"),
  empty: document.getElementById("empty"),
  tooltip: document.getElementById("tooltip"),
};

let lastData = null; // cached for resize re-render
let timer = null;

// ---------------------------------------------------------------------------
// data loading
// ---------------------------------------------------------------------------

function buildQuery() {
  const params = new URLSearchParams();
  const since = el.since.value;
  const until = el.until.value;
  if (since || until) {
    // range takes precedence over day (matches ctl behavior)
    if (since) params.set("since", since);
    if (until) params.set("until", until);
  } else if (el.day.value) {
    params.set("day", el.day.value);
  }
  return params.toString();
}

async function load() {
  setStatus("loading…", false);
  try {
    const res = await fetch("/api/timeline?" + buildQuery(), { cache: "no-store" });
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try {
        const j = JSON.parse(text);
        msg = j.error + (j.stderr ? "\n" + j.stderr : "");
      } catch (_) { /* keep raw text */ }
      showError(msg);
      setStatus("error", false);
      return;
    }
    const data = JSON.parse(text);
    hideError();
    lastData = data;
    render(data);
    setStatus("updated " + new Date().toLocaleTimeString(), el.autorefresh.checked);
  } catch (e) {
    showError(String(e));
    setStatus("error", false);
  }
}

function setStatus(text, live) {
  el.status.textContent = text;
  el.status.classList.toggle("live", !!live);
}
function showError(msg) {
  el.error.textContent = msg;
  el.error.hidden = false;
}
function hideError() {
  el.error.hidden = true;
}

// ---------------------------------------------------------------------------
// render: top-level
// ---------------------------------------------------------------------------

function render(data) {
  el.windowLabel.textContent = data.window || "—";
  renderLegend();
  renderSummary(data.summary || {}, data.totals || {});
  renderTimeline(data);
}

function renderLegend() {
  el.legend.innerHTML = STATUS_ORDER.map((s) =>
    `<span class="li"><span class="swatch" style="background:${statusColor(s)}"></span>${statusLabel(s)}</span>`
  ).join("");
}

// ---------------------------------------------------------------------------
// render: summary panel
// ---------------------------------------------------------------------------

function renderSummary(summary, totals) {
  const byStatus = summary.by_status || {};

  // status breakdown rows in fixed order, then any unknown future statuses.
  const seen = new Set(STATUS_ORDER);
  const extra = Object.keys(byStatus).filter((k) => !seen.has(k));
  const breakdownKeys = STATUS_ORDER.filter((k) => byStatus[k]).concat(extra);
  const breakdownRows = breakdownKeys.map((k) =>
    `<div class="kv">
       <span class="swatch" style="background:${statusColor(k)}"></span>
       <span class="k">${statusLabel(k)}</span>
       <span class="v">${humanDuration(byStatus[k] || 0)}</span>
     </div>`
  ).join("") || `<div class="kv"><span></span><span class="k">no recorded time</span><span></span></div>`;

  // tokens (raw counts) + computed sum.
  const tIn = totals.tok_in || 0;
  const tOut = totals.tok_out || 0;
  const tCacheR = totals.tok_cache_read || 0;
  const tCacheC = totals.tok_cache_create || 0;
  const tSum = tIn + tOut + tCacheR + tCacheC;
  const tokRow = (label, val) =>
    `<div class="kv"><span></span><span class="k">${label}</span><span class="v" title="${val.toLocaleString()}">${humanCount(val)}</span></div>`;

  el.summary.innerHTML = `
    <div class="card headline" title="C: Σ active time × (1 + subagents) — total agent compute (approx)">
      <div class="card-label">attention · fanout (C)</div>
      <div class="card-value">${humanDuration(summary.attention_fanout)}</div>
      <div class="card-sub">total agent compute — Σ active × (1 + subagents)</div>
    </div>

    <div class="card">
      <div class="card-label">attention detail</div>
      <div class="attention-row">
        <div class="mini" title="A: wall-clock time with at least one session active (overlaps counted once)">
          <div class="v">${humanDuration(summary.attention_union)}</div>
          <div class="k">union (A) · ≥1 active</div>
        </div>
        <div class="mini" title="B: Σ over sessions of active time (rewards parallelism)">
          <div class="v">${humanDuration(summary.attention_per_session)}</div>
          <div class="k">per-session (B) · parallelism</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-label">sessions</div>
      <div class="card-value">${summary.sessions != null ? summary.sessions : 0}</div>
      <div class="card-sub">${fmtSpan(summary.from, summary.to)}</div>
    </div>

    <div class="card">
      <div class="card-label">subagents launched</div>
      <div class="card-value">${totals.subagents != null ? totals.subagents : 0}</div>
      <div class="card-sub">subagent_spawn events</div>
    </div>

    <div class="card wide">
      <div class="card-label">time by status</div>
      <div class="kv-list">${breakdownRows}</div>
    </div>

    <div class="card wide">
      <div class="card-label">tokens (raw counts)</div>
      <div class="kv-list">
        ${tokRow("input", tIn)}
        ${tokRow("output", tOut)}
        ${tokRow("cache read", tCacheR)}
        ${tokRow("cache create", tCacheC)}
        <div class="kv total"><span></span><span class="k">total</span><span class="v" title="${tSum.toLocaleString()}">${humanCount(tSum)}</span></div>
      </div>
    </div>
  `;
}

function fmtSpan(from, to) {
  if (!from || !to) return "";
  return fmtClock(from) + " → " + fmtClock(to);
}

// ---------------------------------------------------------------------------
// render: swimlane timeline (SVG)
// ---------------------------------------------------------------------------

function svgEl(name, attrs) {
  const e = document.createElementNS(SVGNS, name);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}

function renderTimeline(data) {
  const lanes = data.lanes || [];
  el.svg.replaceChildren();

  if (lanes.length === 0) {
    el.empty.hidden = false;
    el.svg.style.height = "0px";
    return;
  }
  el.empty.hidden = true;

  const summary = data.summary || {};
  let t0 = Date.parse(summary.from);
  let t1 = Date.parse(summary.to);
  if (!isFinite(t0) || !isFinite(t1) || t1 <= t0) {
    // fall back to min/max across all intervals
    t0 = Infinity; t1 = -Infinity;
    for (const lane of lanes) {
      for (const iv of lane.intervals || []) {
        t0 = Math.min(t0, Date.parse(iv.start));
        t1 = Math.max(t1, Date.parse(iv.end));
      }
    }
    if (!isFinite(t0) || !isFinite(t1) || t1 <= t0) t1 = t0 + 1;
  }
  const span = t1 - t0;

  const GUTTER = 248;
  const RIGHT = 18;
  const AXIS_Y = 18;
  const PLOT_TOP = 28;
  const LANE_H = 26;
  const BAR_H = 15;

  const W = Math.max(560, el.wrap.clientWidth);
  const plotW = Math.max(120, W - GUTTER - RIGHT);
  const plotBottom = PLOT_TOP + lanes.length * LANE_H;
  const H = plotBottom + 12;

  el.svg.setAttribute("width", W);
  el.svg.setAttribute("height", H);
  el.svg.style.width = W + "px";
  el.svg.style.height = H + "px";

  const x = (ms) => {
    let px = GUTTER + ((ms - t0) / span) * plotW;
    if (px < GUTTER) px = GUTTER;
    if (px > GUTTER + plotW) px = GUTTER + plotW;
    return px;
  };

  // axis: gridlines + labels
  const { ticks, step } = axisTicks(t0, t1);
  const showDate = step >= 24 * 3600e3;
  for (const t of ticks) {
    const px = x(t);
    el.svg.appendChild(svgEl("line", {
      class: "axis-tick", x1: px, y1: PLOT_TOP, x2: px, y2: plotBottom,
    }));
    const label = svgEl("text", { class: "axis-label", x: px + 3, y: AXIS_Y });
    const d = new Date(t);
    label.textContent = showDate
      ? d.toLocaleDateString([], { month: "2-digit", day: "2-digit" })
      : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    el.svg.appendChild(label);
  }
  // left edge of plot
  el.svg.appendChild(svgEl("line", {
    class: "axis-line", x1: GUTTER, y1: PLOT_TOP, x2: GUTTER, y2: plotBottom,
  }));

  // lanes
  lanes.forEach((lane, i) => {
    const rowTop = PLOT_TOP + i * LANE_H;
    const barY = rowTop + (LANE_H - BAR_H) / 2;

    // lane separator
    if (i > 0) {
      el.svg.appendChild(svgEl("line", {
        class: "lane-sep", x1: 0, y1: rowTop, x2: W, y2: rowTop,
      }));
    }

    // label
    const labelParts = laneLabelParts(lane);
    const labelText = svgEl("text", { class: "lane-label", x: 8, y: rowTop + LANE_H / 2 + 4 });
    labelText.textContent = truncate(labelParts.join(" · "), 34);
    const title = svgEl("title", {});
    title.textContent = labelParts.join(" · ");
    labelText.appendChild(title);
    el.svg.appendChild(labelText);

    // bars
    for (const iv of lane.intervals || []) {
      const start = Date.parse(iv.start);
      const end = Date.parse(iv.end);
      const bx = x(start);
      const bw = Math.max(1, x(end) - bx);
      const rect = svgEl("rect", {
        class: "bar",
        x: bx, y: barY, width: bw, height: BAR_H,
        rx: 2, fill: statusColor(iv.status),
      });
      attachTooltip(rect, lane, iv);
      el.svg.appendChild(rect);
    }
  });
}

function laneLabelParts(lane) {
  const parts = [];
  if (lane.project) parts.push(lane.project);
  if (lane.agent) parts.push(lane.agent);
  if (lane.session_id) parts.push(lane.session_id.slice(0, 8));
  parts.push("pid " + lane.pid);
  return parts;
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// axisTicks returns aligned gridline timestamps and the chosen step (ms).
function axisTicks(t0, t1) {
  const span = t1 - t0;
  const M = 60e3, Hr = 3600e3, D = 24 * Hr;
  const steps = [M, 2 * M, 5 * M, 10 * M, 15 * M, 30 * M, Hr, 2 * Hr, 3 * Hr, 6 * Hr, 12 * Hr, D, 2 * D, 7 * D];
  let step = steps[steps.length - 1];
  for (const s of steps) {
    if (span / s <= 8) { step = s; break; }
  }
  const ticks = [];
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) ticks.push(t);
  return { ticks, step };
}

// ---------------------------------------------------------------------------
// tooltip
// ---------------------------------------------------------------------------

function attachTooltip(rect, lane, iv) {
  const durMs = Date.parse(iv.end) - Date.parse(iv.start);
  const sub = iv.subagents || 0;
  const html =
    `<div class="t-status" style="color:${statusColor(iv.status)}">${statusLabel(iv.status)}</div>` +
    `<div class="t-row">${fmtClock(iv.start)} – ${fmtClock(iv.end)}</div>` +
    `<div class="t-row">${humanDurationMs(durMs)}</div>` +
    (sub > 0 ? `<div class="t-sub">${sub} subagent${sub === 1 ? "" : "s"}</div>` : "");
  rect.addEventListener("mouseenter", (ev) => showTip(html, ev));
  rect.addEventListener("mousemove", (ev) => moveTip(ev));
  rect.addEventListener("mouseleave", hideTip);
}

function showTip(html, ev) {
  el.tooltip.innerHTML = html;
  el.tooltip.hidden = false;
  moveTip(ev);
}
function moveTip(ev) {
  const pad = 14;
  const r = el.tooltip.getBoundingClientRect();
  let x = ev.clientX + pad;
  let y = ev.clientY + pad;
  if (x + r.width > window.innerWidth) x = ev.clientX - r.width - pad;
  if (y + r.height > window.innerHeight) y = ev.clientY - r.height - pad;
  el.tooltip.style.left = x + "px";
  el.tooltip.style.top = y + "px";
}
function hideTip() {
  el.tooltip.hidden = true;
}

// ---------------------------------------------------------------------------
// controls
// ---------------------------------------------------------------------------

function todayLocal() {
  const d = new Date();
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d - off).toISOString().slice(0, 10);
}

function setAutoRefresh(on) {
  if (timer) { clearInterval(timer); timer = null; }
  if (on) timer = setInterval(load, 5000);
}

// applyUrlParams prefills the controls from ?day=/?since=/?until= so a window
// is shareable/bookmarkable. Falls back to today when no day param is present.
function applyUrlParams() {
  const q = new URLSearchParams(window.location.search);
  el.since.value = q.get("since") || "";
  el.until.value = q.get("until") || "";
  el.day.value = q.get("day") || todayLocal();
}

function init() {
  applyUrlParams();

  el.refresh.addEventListener("click", load);
  el.day.addEventListener("change", load);
  el.since.addEventListener("change", load);
  el.until.addEventListener("change", load);
  el.clearRange.addEventListener("click", () => {
    el.since.value = "";
    el.until.value = "";
    load();
  });
  el.autorefresh.addEventListener("change", () => setAutoRefresh(el.autorefresh.checked));

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (lastData) renderTimeline(lastData); }, 120);
  });

  load();
}

init();
