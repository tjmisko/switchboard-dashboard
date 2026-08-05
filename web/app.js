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
const SUMMARIES_POLL_MS = 120000; // /api/summaries cadence (grows on session end)
// Memory refreshes faster than summaries (it moves continuously) but far slower
// than the timeline: nothing repaints on it, so the only cost of a refresh is the
// fetch, and the only benefit is how stale a tooltip can be when you open it.
const MEMORY_POLL_MS = 30000;

// Operator lane colors: green marks "free" time (≥1 agent running while you were
// neither attending an agent window nor recovering from a context switch —
// you're a "free agent"); dark red marks "occupied" time. A context switch
// occupies you for OP.switchRecoveryMs going forward — clustered switches merge,
// so thrash extends the cost without double-counting. Occupied is also what the
// topline's net agent hours nets off, so the two always agree.
const OP_FREE_COLOR = "#3fb950";      // green — free time ("free agent")
const OP_OCCUPIED_COLOR = "#8c4a4c";  // muted dusty red — occupied (attending or switching)

// OP: the operator-model tunables. These are judgement calls about how YOU work,
// not facts about the data, so they are served by /api/settings from a file you
// own (see settings.go and the README's Settings section) and merged over these
// fallbacks at boot. The literals here MUST match Go's DefaultSettings(), so a
// dashboard whose settings fetch fails behaves exactly like an unconfigured one.
const OP = {
  awayAfterMs: 5 * 60 * 1000, // focused but untouched this long ⇒ you're away
  switchRecoveryMs: 90000,    // occupied time charged forward from each switch
  switchFlickerMs: 500,       // shorter focus arrivals are flicker, not switches
  minEngageMs: 15000,         // shorter focus spans aren't time spent working
};

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

// STATUS_MEANING: one-line plain-language gloss per status, surfaced in the
// status-key hover descriptors so the legend explains itself.
const STATUS_MEANING = {
  working: "An agent was actively producing work.",
  dormant: "A parent agent was waiting on a subagent.",
  idle: "A session was alive but doing nothing.",
  permission: "Blocked waiting for your approval.",
  suspended: "A session was paused/backgrounded.",
  "": "Status not reported.",
  delegating: "Legacy: parent delegating to a subagent.",
};

function statusLabel(s) { return s === "" ? "unknown" : s; }
function statusColor(s) {
  return STATUS_COLORS[s] !== undefined ? STATUS_COLORS[s] : "#8957e5";
}

// Provider -> accent color. In the merged, multi-provider view every lane carries
// a `provider` tag; the accent (a left-edge spine on each bar + a legend chip)
// lets you tell providers apart at a glance. Known providers get fixed hues;
// anything else derives a stable hue from its name so new providers still get a
// distinct, consistent color without a code change.
const PROVIDER_COLORS = {
  claude: "#c96442",  // terracotta
  arachne: "#a371f7", // purple
  codex: "#3fb0ac",   // teal
};
function provColor(p) {
  if (!p) return "#6e7681";
  if (PROVIDER_COLORS[p]) return PROVIDER_COLORS[p];
  let h = 0;
  for (let i = 0; i < p.length; i++) h = (h * 31 + p.charCodeAt(i)) % 360;
  return `hsl(${h}, 55%, 62%)`;
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
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
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
  dayDisplay: document.getElementById("day-display"),
  dateField: document.getElementById("date-field"),
  prevDay: document.getElementById("prev-day"),
  nextDay: document.getElementById("next-day"),
  liveDot: document.getElementById("live-dot"),
  updated: document.getElementById("updated"),
  error: document.getElementById("error"),
  topline: document.getElementById("topline"),
  statusKey: document.getElementById("status-key"),
  providerKey: document.getElementById("provider-key"),
  svg: document.getElementById("timeline"),
  canvas: document.getElementById("concurrency"),
  projects: document.getElementById("projects"),
  wrap: document.getElementById("timeline-wrap"),
  section: document.getElementById("timeline-section"),
  chartCaption: document.getElementById("chart-caption"),
  chartStats: document.getElementById("chart-stats"),
  empty: document.getElementById("empty"),
  tooltip: document.getElementById("tooltip"),
  popout: document.getElementById("popout"),
  cardAttention: document.getElementById("card-attention"),
  cardCost: document.getElementById("card-cost"),
  optCtxSwitches: document.getElementById("opt-ctx-switches"),
  optFocus: document.getElementById("opt-focus"),
  optSmooth: document.getElementById("opt-smooth"),
  viewSessions: document.getElementById("view-sessions"),
  viewLine: document.getElementById("view-line"),
  viewProjects: document.getElementById("view-projects"),
  viewseg: document.getElementById("viewseg"),
  viewGlider: document.getElementById("viewseg-glider"),
  themeToggle: document.getElementById("theme-toggle"),
  zoomIn: document.getElementById("zoom-in"),
  zoomOut: document.getElementById("zoom-out"),
  zoomReset: document.getElementById("zoom-reset"),
  zoomVal: document.getElementById("zoom-val"),
};

// focusEnabled: whether the blue focus/attention overlay is shown (toggle in the
// chart footer, default on). Treated as on if the control is somehow absent.
function focusEnabled() {
  return !el.optFocus || el.optFocus.checked;
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
let lastData = null;       // parsed timeline (for resize re-render)
let lastTimelineText = ""; // raw timeline JSON (repaint-on-change guard)
let lastPlan = null;       // parsed /api/plan
let lastPlanText = "";
let lastSummaries = {};    // /api/summaries session_id → {name, description, tasks, summary, tokens}
let lastMemory = null;     // /api/memory {sessions, pressure} — read lazily at hover, never repainted
let lastUpdatedAt = null;  // ms of last successful timeline fetch
let fetchOK = false;
let timelineTimer = null;
let planTimer = null;

// Which chart occupies the plot area: "sessions" (the SVG swimlanes), "line"
// (the "agents aloft" concurrency canvas) or "projects" (the
// agent-time-per-project ranking). Persisted so the choice survives reloads.
const VIEW_KEY = "sb-view";

// Seeded from the PERSISTED choice only — ?view= is applied later, by
// applyUrlParams, and deliberately never written back (the URL wins for the
// load, but does not become sticky). Upgrading a stored legacy "bars" in place
// here is what lets normalizeView's shim be deleted in a later release.
let currentView = (function () {
  try {
    const stored = localStorage.getItem(VIEW_KEY);
    const v = normalizeView(stored);
    if (v) {
      if (v !== stored) localStorage.setItem(VIEW_KEY, v);
      return v;
    }
  } catch (e) {}
  return "sessions";
})();
function smoothEnabled() { return !el.optSmooth || el.optSmooth.checked; }

// syncSmoothLegend collapses the legend's 30-min-average entry in step with its
// toggle; CSS (.smooth-off on the caption) animates the exit and return.
function syncSmoothLegend() {
  el.chartCaption.classList.toggle("smooth-off", !smoothEnabled());
}

// ---------------------------------------------------------------------------
// data loading
// ---------------------------------------------------------------------------

function buildQuery() {
  const params = new URLSearchParams();
  if (el.day.value) params.set("day", el.day.value);
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

// loadSettings pulls the operator-model tunables over OP's fallbacks. Fetched
// once, before the first poll, because every operator figure on the page depends
// on them; a failed or partial fetch leaves the built-in defaults in place, which
// are the same numbers the server serves when unconfigured. Keys are snake_case
// on the wire (they are the file's keys, which a human edits) and camelCase here.
const OP_SETTING_KEYS = {
  away_after_ms: "awayAfterMs",
  switch_recovery_ms: "switchRecoveryMs",
  switch_flicker_ms: "switchFlickerMs",
  min_engage_ms: "minEngageMs",
};

async function loadSettings() {
  try {
    const res = await fetch("/api/settings", { cache: "no-store" });
    if (!res.ok) return;
    const j = await res.json();
    for (const [wire, key] of Object.entries(OP_SETTING_KEYS)) {
      const v = j[wire];
      if (typeof v === "number" && isFinite(v) && v > 0) OP[key] = v;
    }
  } catch (_) { /* keep the built-in defaults */ }
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

// loadSummaries fetches the archival session records (the name / description /
// tasks / narrative generated by session-digest, plus the session's token
// spend). Tooltips and popouts read lastSummaries lazily at hover/click time,
// so no repaint is needed when the map refreshes. Best-effort: an empty or
// failed fetch just leaves hovers unenriched.
//
// An entry may carry tokens with no summary — every session that called the API
// has counts, including the thin ones the condenser never summarizes — so every
// read of a summary field is gated on that field, not on the entry existing.
async function loadSummaries() {
  try {
    const res = await fetch("/api/summaries", { cache: "no-store" });
    if (!res.ok) return;
    const j = await res.json();
    lastSummaries = j.sessions || {};
  } catch (_) { /* keep last known */ }
}

// sessionSummary returns the generated summary record for a lane, or null.
// Summaries are keyed by the bare session UUID, so the merged view's
// "<provider>:" namespace is stripped first (model.js rawSessionId).
function sessionSummary(lane) {
  const id = rawSessionId(lane);
  return id ? lastSummaries[id] || null : null;
}

// loadMemory fetches per-session memory and machine-wide pressure. It rides its
// own endpoint for the same reason summaries do, and the reason is worth stating
// because it is what keeps this feature free: a live sample series changes the
// response bytes on every poll, so carrying it on /api/timeline would defeat the
// unchanged->no-repaint check and force a full re-render every few seconds. Here
// the payload is only ever read inside a tooltip closure at hover time, so a
// refresh costs nothing at all — no repaint, no reflow, no work until someone
// actually looks. Best-effort throughout: a failed fetch leaves hovers
// unenriched rather than breaking them.
async function loadMemory() {
  try {
    const res = await fetch("/api/memory", { cache: "no-store" });
    if (!res.ok) return;
    lastMemory = await res.json();
  } catch (_) { /* keep last known */ }
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

// isLiveWindow: is the day picker sitting on today? Only then can the timeline's
// trailing edge be "now" — every other day is a closed window whose end really
// is the end of the work.
function isLiveWindow() {
  return !el.day.value || el.day.value === todayLocal();
}

// ---------------------------------------------------------------------------
// operator free-time (derived from focus / context switches)
// ---------------------------------------------------------------------------

// computeOperatorTime partitions the running window into the operator's
// "occupied" vs "free" intervals:
//   running   = union over lanes of running-status intervals (≥1 agent working)
//   present   = ⋃ [activity-active start, end + OP.awayAfterMs] — you don't stop
//               being at the machine the instant you stop typing, but an agent
//               window focused and untouched for awayAfterMs means you walked
//               away and left it up
//   attending = focus ∩ present (at an agent window AND actually there)
//   ctxRecov  = ⋃ [switch, switch + OP.switchRecoveryMs] over every context
//               switch (switch arrivals after the first) — clustered switches
//               merge, so a burst costs one recovery, not one apiece
//   occupied  = (attending ∪ ctxRecov) ∩ running
//   free      = running MINUS (attending ∪ ctxRecov)
// "free time" is the headline: time you actually had while the agents ran and
// you were neither attending one nor recovering from a switch. Degrades when
// focus or activity are absent (no activity stream → any focus counts as
// attending, since there is no evidence you left).
//
// A context switch = a focus arrival with dwell ≥ OP.switchFlickerMs (see
// model.switchArrivals). The COUNT, the overlay, and the recovery-time
// subtraction all draw from this ONE set, so every switch shown is charged
// against free time. (Previously the count/overlay used EVERY arrival while
// recovery only charged ≥15s dwells — since ~85% of real switches are sub-15s,
// most shown switches cost nothing and free time was badly overstated.)
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
  // Collect, across all lanes: running intervals, raw focus spans (switch
  // detection applies the flicker floor via model.switchArrivals), and the ≥15s
  // focus pairs used for TYPING only (a ≥15s focus while active is real editing —
  // a separate concept from a switch, hence its own gate).
  // The running window is held to each lane's evidence bound: a ghost lane's
  // synthesized tail is not time an agent was observed running, so painting it
  // green would stretch the free-time lane across phantom hours and inflate
  // freeFrac (runningMs is its denominator).
  const runPairs = [], focusPairs = [], focusSpans = [];
  for (const lane of lanes) {
    const cut = suspectSinceMs(lane);
    for (const iv of lane.intervals || []) {
      if (!RUNNING_STATUSES.has(iv.status)) continue;
      const span = clipSpanMs(Date.parse(iv.start), Date.parse(iv.end), cut);
      if (span) runPairs.push(span);
    }
    for (const f of lane.focus || []) {
      const s = Date.parse(f.start), e = Date.parse(f.end);
      if (!(isFinite(s) && isFinite(e) && e > s)) continue;
      focusSpans.push(f); // raw; switchArrivals() applies OP.switchFlickerMs
      // attending gate is stricter: a sub-15s look-in isn't time spent working
      // in that window (≠ a switch, which only needs the flicker floor).
      if (e - s >= OP.minEngageMs) focusPairs.push([s, e]);
    }
  }
  const running = unionMs(runPairs);
  const engaged = unionMs(focusPairs);

  // Context switches: focus arrivals you actually landed on (dwell ≥ the flicker
  // floor), the SAME set the count and overlay show. Every switch after the first
  // occupies you OP.switchRecoveryMs forward; clustered switches merge via union, so thrash
  // lengthens the interval without ever double-counting — and, crucially, every
  // switch you see is subtracted from free time (no sub-15s escape hatch).
  const switchStarts = switchArrivals(focusSpans, OP.switchFlickerMs);
  const recoveryStarts = switchStarts.slice(1);
  const ctxRecovery = unionMs(recoveryStarts.map((t) => [t, t + OP.switchRecoveryMs]));

  // Attending: focused on an agent window while you were actually there. The
  // activity stream only marks keyboard/mouse activity, and reading a diff is
  // not idleness, so each active span is extended forward by OP.awayAfterMs
  // before the intersection — presence decays rather than blinking off. Past
  // that, a focused-but-untouched window is you having walked away from it.
  // Without an activity stream there is no evidence you left: any (≥15s) focus
  // counts as attending.
  const active = spansToMs((data.activity || []).filter((a) => a.state === "active"));
  const present = unionMs(active.map(([s, e]) => [s, e + OP.awayAfterMs]));
  const attending = present.length ? intersectMs(engaged, present) : engaged;

  const occupiedAll = unionMs([...ctxRecovery, ...attending]);
  const occupied = intersectMs(occupiedAll, running); // drawn only while agents run
  const free = subtractMs(running, occupiedAll);

  const sum = (pairs) => pairs.reduce((a, [s, e]) => a + (e - s), 0);
  const runningMs = sum(running);
  const freeMs = sum(free);

  // COUNT + overlay reuse the recovery set exactly, so the red lines you see are
  // the switches charged against free time — no more, no fewer.
  const switchTimes = recoveryStarts;
  const switches = Math.max(0, switchStarts.length - 1);
  return {
    running, occupied, free,
    runningMs, freeMs,
    occupiedMs: sum(occupied),
    // hasAttention: did we observe the operator at all? Without a focus stream
    // occupied is 0 for lack of evidence, not because you were never at the
    // keyboard, and any figure that subtracts it must fall back instead.
    hasAttention: focusSpans.length > 0,
    switches,
    switchTimes,
    lostMs: sum(intersectMs(ctxRecovery, running)),
    freeFrac: runningMs > 0 ? freeMs / runningMs : null,
  };
}

// ---------------------------------------------------------------------------
// render: top-level
// ---------------------------------------------------------------------------

function render(data) {
  const op = computeOperatorTime(data);
  renderTopline(data.summary || {}, op);
  renderStatusKey(data.summary || {});
  renderProviderKey(data.lanes || []);
  renderChartArea(data);
  renderAttentionCard(data.summary || {}, op);
  renderCostCard(data, lastPlan);
}

// renderChartArea draws whichever chart the view switcher selects into the plot
// area. The sessions and line views share the horizontal scale (zoom) and the
// scroll wrap, so toggling between them keeps the time axis put; the projects
// view is time-less (a ranking, not a timeline). Called from render() and from
// every repaint trigger (zoom, resize, theme, view/toggle change).
//
// The scroll position is deliberately left alone. Zoomed in far enough that the
// plot outgrows its wrap, the trailing edge — and with it the live-tail readout
// — sits off-screen until you scroll to it, exactly like the newest bars in the
// sessions view. Parking the scroll at "now" instead would take the y-axis and
// the lane labels off the other side, which is a worse trade.
function renderChartArea(data) {
  if (currentView === "line") renderConcurrencyChart(data);
  else if (currentView === "projects") renderProjectsChart(data);
  else renderTimeline(data);
  // the fit floor moves with the window, the view and the container, so the
  // scale readout is only true once the render that measured it has run.
  updateZoomReadout();
}

// The projects view's grow-in is a CSS animation gated on .enter being present
// on the container, so this arms its removal. The class must outlive the LAST
// row's run, and style.css staggers each row's animation-delay by --row-i, so
// the timer is sized to the rows on screen rather than a flat guess (a fixed
// ~800ms would cut off row 7 onward, snapping those bars to full width).
// Mirrors the .projects.enter .proj-fill rule in style.css.
const PROJECTS_ANIM_MS = 500;        // CSS animation duration
const PROJECTS_STAGGER_MS = 45;      // CSS per-row animation-delay step
const PROJECTS_SEG_STAGGER_MS = 30;  // CSS per-segment step within a row
let projectsEnterTimer = null;       // re-armed, never stacked, on repeated flips

// startProjectsEnter replays the staggered grow-in. Call ONLY on entry to the
// view — the ~3s live repaints must not restart it.
function startProjectsEnter() {
  el.projects.classList.add("enter");
  if (projectsEnterTimer) clearTimeout(projectsEnterTimer);
  // the last animation to finish is the last segment of the last row
  let maxSegs = 0;
  for (const row of el.projects.children) {
    maxSegs = Math.max(maxSegs, row.querySelectorAll(".proj-seg").length);
  }
  const hold = PROJECTS_ANIM_MS
    + el.projects.children.length * PROJECTS_STAGGER_MS
    + maxSegs * PROJECTS_SEG_STAGGER_MS + 100;
  projectsEnterTimer = setTimeout(() => {
    projectsEnterTimer = null;
    el.projects.classList.remove("enter");
  }, hold);
}

// setView flips the plot between the session swimlanes, the line chart and the
// project ranking. All view-dependent visibility is CSS, keyed off .view-line /
// .view-projects on the section, so this just toggles the classes + the
// segmented control's pressed state, then repaints. Sessions is the only view
// that uses the shared #empty placeholder — the other two draw their own — and
// renderTimeline un-hides it, so both other views re-hide it on entry.
function setView(view) {
  view = normalizeView(view) || "sessions";
  const entering = view === "projects" && currentView !== "projects";
  currentView = view;
  try { localStorage.setItem(VIEW_KEY, view); } catch (e) {}
  el.section.classList.toggle("view-line", view === "line");
  el.section.classList.toggle("view-projects", view === "projects");
  el.viewSessions.setAttribute("aria-pressed", String(view === "sessions"));
  el.viewLine.setAttribute("aria-pressed", String(view === "line"));
  el.viewProjects.setAttribute("aria-pressed", String(view === "projects"));
  positionViewGlider();
  hideTip();
  if (view !== "sessions") el.empty.hidden = true; // line + projects draw their own empty state
  if (lastData) renderChartArea(lastData);
  // Arm the grow-in only when the view is newly ENTERED (live re-renders must
  // not restart it), and only after the render above, so the hold is sized to
  // the rows that just landed. The animation starts when .enter is applied, so
  // stamping it after the rows exist is what makes them all run together.
  if (entering) startProjectsEnter();
}

// positionViewGlider slides the view switcher's green thumb under the active
// segment. The segments differ in width, so geometry is measured, not styled;
// clientLeft corrects for the container border (offsetLeft spans it, the
// absolutely-positioned glider doesn't).
function positionViewGlider() {
  const btn = currentView === "line" ? el.viewLine
    : currentView === "projects" ? el.viewProjects
    : el.viewSessions;
  el.viewGlider.style.width = btn.offsetWidth + "px";
  el.viewGlider.style.transform = "translateX(" + (btn.offsetLeft - el.viewseg.clientLeft) + "px)";
}

// renderTopline: three dominant figures framing AI's payoff, gross → net → rate.
//   agent hours (lead) = fanout — every hour an agent spent working on your
//     behalf, parallelism counted. The gross figure, before any netting.
//   net agent hours = the EXTRA output-time AI bought you, where extra =
//     fanout − YOUR OWN time (op.occupiedMs: prompting ∪ post-switch recovery,
//     intersected with the running window). What delegating costs you is the
//     time it takes you, not every hour an agent happened to be up — you are
//     free for most of the latter, which is the whole point. That subtrahend is
//     a UNION, so a burst of context switches inside one 90s recovery window
//     costs 90s, not 90s each. The subtitle frames the result as an extended
//     day — "as if a 27h day" (24h + extra).
//   force multiplier = fanout ÷ union — the average number of "you"s working
//     during active time (≈3 agents in parallel → 3×). Deliberately still on
//     union: it answers "how many at once while they ran", the same question
//     the aloft chart's average answers, and the two must agree.
function renderTopline(summary, op) {
  const fanout = summary.attention_fanout || 0; // agent-hours, parallelism counted (ns)
  const union = summary.attention_union || 0;   // wall-clock with ≥1 agent active (ns)
  const perSession = summary.attention_per_session || 0; // Σ each session's own active time
  // fanout is per-session time weighted by concurrent subagents (provider
  // contract), so the excess over per-session IS the subagent contribution.
  // Clamped: a provider that reports fanout < per_session would otherwise
  // substitute a negative term into the formula box.
  const subagents = Math.max(0, fanout - perSession);
  // your own time, in ns. Falls back to union when no focus stream was recorded
  // — occupied is 0 there for lack of evidence, and crediting the whole fanout
  // as free gain would be a fabrication.
  const yours = op && op.hasAttention ? op.occupiedMs * 1e6 : union;
  const yoursIsMeasured = !!(op && op.hasAttention);
  const extra = Math.max(0, fanout - yours);
  const DAY = 24 * 3600 * 1e9;                   // ns in a 24h day
  const mult = union > 0 ? fanout / union : null;
  // headline figures read WITHOUT seconds (coarse) — second-level precision is noise here.
  const fanoutStr = humanDurationCoarse(fanout);
  const unionStr = humanDurationCoarse(union);
  const yoursStr = humanDurationCoarse(yours);
  // the key line names what was netted off, so it has to say WHICH quantity that
  // was when the operator stream is missing and it falls back to the window —
  // agents running is not the same claim as you babysitting them.
  const netPhrase = yoursIsMeasured ? `${yoursStr} babysitting` : `${yoursStr} active`;
  const extraStr = humanDurationCoarse(extra);
  const dayStr = humanDurationCoarse(DAY + extra);
  const multStr = mult == null ? "—" : mult.toFixed(1) + "×";
  const hoursTip = formulaTipHTML({
    title: "agent hours worked",
    formula: "Σ session active time + Σ subagent spans",
    substitution: `${humanDurationCoarse(perSession)} + ${humanDurationCoarse(subagents)}`,
    result: fanoutStr,
    why: "Total time agents spent working on your behalf, counting parallel sessions and subagents separately. Gross — the cost of delegating is not netted off yet.",
    color: "var(--c-working)",
  });
  const gainedTip = formulaTipHTML({
    title: "net agent hours",
    formula: yoursIsMeasured ? "agent hours − your own time" : "agent hours − active wall-clock",
    // two lines: the netting itself, then the extended-day framing the key line
    // promises. .t-formula is pre-wrap, so the newline survives.
    substitution: `${fanoutStr} − ${yoursStr}\n24h + ${extraStr} = ${dayStr} day`,
    result: "+" + extraStr,
    why: yoursIsMeasured
      ? `Agent hours net of the ${yoursStr} you actually spent prompting and recovering from context switches while agents ran — overlapping switches merge, so a burst of them costs one recovery, not one each. As if your day ran ${dayStr} long.`
      : `Agent hours net of the wall-clock agents were running — no focus stream for this window, so your own time can't be measured. As if your day ran ${dayStr} long.`,
    color: "var(--c-working)",
  });
  const multTip = formulaTipHTML({
    title: "force multiplier",
    formula: "agent hours ÷ active wall-clock",
    substitution: `${fanoutStr} ÷ ${unionStr}`,
    result: multStr,
    why: "Average number of parallel sessions running during active time — how many 'you's were working at once.",
  });
  el.topline.innerHTML = `
    <div class="th-block has-tip" data-tip="${escapeHTML(hoursTip)}">
      <div class="th-val green">${fanoutStr}</div>
      <div class="th-key">agent hours worked</div>
    </div>
    <div class="th-block has-tip" data-tip="${escapeHTML(gainedTip)}">
      <div class="th-val green">+${extraStr}</div>
      <div class="th-key">agent hours net ${netPhrase}</div>
    </div>
    <div class="th-block has-tip" data-tip="${escapeHTML(multTip)}">
      <div class="th-val">${multStr}</div>
      <div class="th-key">force multiplier · over ${humanDurationCoarse(union)} active</div>
    </div>`;
  attachFormulaTips(el.topline);
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
    const tip = formulaTipHTML({
      title: statusLabel(k),
      formula: `Σ time in '${statusLabel(k)}' across all sessions`,
      result: humanDuration(byStatus[k] || 0),
      why: STATUS_MEANING[k] || "",
      color: statusColor(k),
    });
    return `<span class="sk has-tip" data-tip="${escapeHTML(tip)}">
        <span class="sk-left">
          <span class="swatch" style="${swatchStyle}"></span>
          <span class="sk-name">${statusLabel(k)}</span>
        </span>
        <span class="sk-val">${humanDuration(byStatus[k] || 0)}</span>
      </span>`;
  }).join("");
  attachFormulaTips(el.statusKey);
}

// renderProviderKey: the provider legend, shown ONLY when lanes carry a provider
// tag (i.e. the merged multi-provider view). Each chip shows the provider's
// accent color and its lane count; it stays hidden in the default single-provider
// view where lanes have no provider field.
function renderProviderKey(lanes) {
  if (!el.providerKey) return;
  const counts = new Map();
  for (const lane of lanes || []) {
    if (!lane.provider) continue;
    counts.set(lane.provider, (counts.get(lane.provider) || 0) + 1);
  }
  if (counts.size === 0) {
    el.providerKey.hidden = true;
    el.providerKey.innerHTML = "";
    return;
  }
  const names = [...counts.keys()].sort();
  el.providerKey.hidden = false;
  el.providerKey.innerHTML = names.map((p) =>
    `<span class="pk">
        <span class="pk-dot" style="background:${provColor(p)}"></span>
        <span class="pk-name">${escapeHTML(p)}</span>
        <span class="pk-count">${counts.get(p)}</span>
      </span>`).join("");
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
  PAD_TOP: 2, NAME_H: 17, BAR_H: 24, GAP: 3, PAD_BOTTOM: 2,
  SUB_ROW_H: 5, SUB_GAP: 2,
  GROUP_HEAD_H: 20,
  NAME_MIN_W: 28,   // hide a span's name text below this px width (tooltip still shows it)
  COST_MIN_W: 56,   // show the cost on the identifier line only above this span width
  OP_LANE_H: 52, OP_BAR_H: 20, // operator free-time lane (sits above the groups)
  PX_PER_HOUR: 240, // min horizontal density → long windows scroll (see plotW)
  AXIS_BOTTOM_H: 24,        // bottom axis-scale strip drawn below the plot
  GROUP_COLLAPSED_H: 26,    // height of a folded (too-small) project group summary row
  GROUP_COLLAPSE_MIN_PX: 24,// fold a group when even its widest session is under this px
  SUB_MIN_PX: 4,            // a subagent sub-bar narrower than this reads as a sliver
  SUB_MERGE_GAP_PX: 3,      // adjacent slivers within this px gap merge into one marker
};

// Horizontal scale (time density). GEO.PX_PER_HOUR is the built-in default; the
// footer zoom control overrides it live and persists the choice in localStorage,
// so a chosen scale survives reloads. Bounded so the plot can't collapse to a
// smear or blow up unboundedly.
const ZOOM_KEY = "sb-pxph";
const ZOOM_MIN = 60, ZOOM_MAX = 1200, ZOOM_FACTOR = 1.25;
const clampZoom = (v) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v));
let pxPerHour = (function () {
  let v = NaN;
  try { v = parseFloat(localStorage.getItem(ZOOM_KEY)); } catch (e) {}
  return clampZoom(isFinite(v) && v > 0 ? v : GEO.PX_PER_HOUR);
})();

// scale: what the control REPORTS and steps from, which is not the stored
// setting. scaleGeometry floors the setting at the density that fills the plot
// width, so on a window short enough to fit, a range of settings all draw the
// same chart. The last time-based render leaves its resolved geometry here for
// the readout and the buttons; null means no time axis is on screen (empty
// window, or the projects view), leaving the setting to speak for itself.
let scaleGeo = null;
const scaleNow = () => scaleGeo || scaleGeometry(0, 0, pxPerHour, ZOOM_MIN, ZOOM_MAX);

// plotWidthFor resolves the setting against the window and remembers the result
// for the readout. Both time views call it; they measure slightly different plot
// areas, so the floor is whichever one is currently drawn.
function plotWidthFor(span, fitPlotW) {
  scaleGeo = scaleGeometry(span, fitPlotW, pxPerHour, ZOOM_MIN, ZOOM_MAX);
  return scaleGeo.plotW;
}

// setZoom changes the horizontal density and repaints, holding the time point at
// the viewport center steady so zooming feels anchored instead of snapping to 0.
function setZoom(next) {
  next = Math.round(clampZoom(next));
  if (next === Math.round(pxPerHour)) { updateZoomReadout(); return; }
  const wrap = el.wrap;
  const sw = wrap.scrollWidth, cw = wrap.clientWidth;
  const centerFrac = sw > cw ? (wrap.scrollLeft + cw / 2) / sw : 0.5;
  pxPerHour = next;
  try { localStorage.setItem(ZOOM_KEY, String(next)); } catch (e) {}
  if (lastData) {
    renderChartArea(lastData); // resolves the new geometry — read the readout after
    const nsw = wrap.scrollWidth;
    if (nsw > wrap.clientWidth) wrap.scrollLeft = centerFrac * nsw - wrap.clientWidth / 2;
  }
  updateZoomReadout();
}

// updateZoomReadout syncs the numeric label and greys out a button that would
// not move the chart. Both speak in the EFFECTIVE density: the label reports
// what the plot is actually drawn at, and a window already filling the width
// greys out zoom-out rather than taking clicks that only change a number. The
// grey is otherwise unexplained, so the button says why on hover.
function updateZoomReadout() {
  const geo = scaleNow();
  if (el.zoomVal) el.zoomVal.textContent = String(Math.round(geo.effective));
  if (el.zoomIn) el.zoomIn.disabled = !geo.canZoomIn;
  if (el.zoomOut) {
    el.zoomOut.disabled = !geo.canZoomOut;
    el.zoomOut.title = geo.atFit && !geo.canZoomOut
      ? "already fits the width — nothing left to compress"
      : "zoom out — compress time";
  }
}

// Project groups fold to a one-line summary when they get too small to read; the
// user can click to override either way. Keyed by project name so the choice
// survives the ~3s repaints. undefined = follow the auto (size-based) default.
const groupCollapseOverride = new Map();
function toggleGroupCollapse(project, currentlyCollapsed) {
  groupCollapseOverride.set(project, !currentlyCollapsed);
  if (lastData) renderTimeline(lastData);
}

// laneHeight is the compact vertical footprint of one session bar: name band +
// status bar + paddings, plus a subagent strip sized to the session's ACTUAL max
// concurrency (one row per simultaneous subagent). Sessions without subagents
// pack tighter; a heavily-parallel session grows to fit all its sub-lines.
function laneHeight(lane) {
  let h = GEO.PAD_TOP + GEO.NAME_H + GEO.BAR_H + GEO.PAD_BOTTOM;
  const rows = packSubagents(lane).rows;
  if (rows) h += GEO.GAP + rows * (GEO.SUB_ROW_H + GEO.SUB_GAP);
  return h;
}

// rowHeight is the footprint of a PACKED row (one or more time-serializable
// sessions): the tallest laneHeight over the row's sessions, so the subagent
// strip is reserved exactly when some session on the row delegated.
function rowHeight(laneList) {
  let h = GEO.PAD_TOP + GEO.NAME_H + GEO.BAR_H + GEO.PAD_BOTTOM;
  for (const lane of laneList) h = Math.max(h, laneHeight(lane));
  return h;
}

// windowBounds resolves the [t0, t1] plot window: the summary from/to when
// present and sane, else the min/max over all interval bounds (with a 1ms floor
// so span is always positive). Shared by the bar and line charts so both frame
// the same time window.
function windowBounds(data, lanes) {
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
  return { t0, t1 };
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
    scaleGeo = null; // nothing drawn to fit: the setting stands on its own
    return;
  }
  el.empty.hidden = true;

  const { t0, t1 } = windowBounds(data, lanes);
  const span = t1 - t0;

  // Horizontal scroll: the plot keeps a minimum density (px per hour) so long
  // windows grow WIDER than the viewport and scroll horizontally (the wrap has
  // overflow-x:auto), instead of squishing a whole day into the visible width.
  const containerW = Math.max(620, el.wrap.clientWidth);
  const fitPlotW = Math.max(160, containerW - GEO.GUTTER - GEO.RIGHT);
  const plotW = plotWidthFor(span, fitPlotW);
  const W = GEO.GUTTER + plotW + GEO.RIGHT;
  // unclamped ms→px width, for the collapse decision (needs pixel widths before x()).
  const msToPx = (ms) => (ms / span) * plotW;

  // operator free-time lane occupies the top row, above all project groups.
  const opTop = GEO.PLOT_TOP;
  const op = computeOperatorTime(data);

  // group lanes by project; within each group, PACK time-serializable sessions
  // onto shared rows (greedy interval partitioning). A group that is too small to
  // read (even its widest session is a sliver) folds to a single summary row unless
  // the user overrode that. Otherwise lay out a header per group, then one stacked
  // row per packed row, top-down. Each row reserves the height of its tallest
  // session (subagent strip included only when a session on the row delegated). The
  // idx%2 background alternation runs per ROW across all (expanded) groups.
  const groups = groupByProject(lanes);
  let yCursor = GEO.PLOT_TOP + GEO.OP_LANE_H;
  let rowIdx = 0;
  for (const g of groups) {
    g.collapsed = groupCollapsed(g, msToPx);
    if (g.collapsed) {
      g.headY = yCursor;
      g.rows = [];
      yCursor += GEO.GROUP_COLLAPSED_H;
      continue;
    }
    g.headY = yCursor;
    yCursor += GEO.GROUP_HEAD_H;
    g.rows = packLanes(g.lanes).map((laneList, i) => {
      const row = {
        lanes: laneList,
        top: yCursor,
        height: rowHeight(laneList),
        idx: rowIdx++,
        firstInGroup: i === 0,
      };
      yCursor += row.height;
      return row;
    });
  }
  const plotBottom = yCursor;
  const H = plotBottom + GEO.AXIS_BOTTOM_H;

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

  // axis gridlines + labels (tick density scales with the scrollable plot width).
  // Labels ride BOTH ends: the conventional scale strip along the bottom plus the
  // original top labels, so a tall, scrolled chart stays legible from either edge.
  const { ticks, step } = axisTicks(t0, t1, plotW);
  const showDate = step >= 24 * 3600e3;
  const bottomLabelY = plotBottom + 16;
  const fmtTick = (t) => {
    const d = new Date(t);
    return showDate
      ? d.toLocaleDateString([], { month: "2-digit", day: "2-digit" })
      : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  };
  for (const t of ticks) {
    const px = x(t);
    el.svg.appendChild(svgEl("line", { class: "axis-tick", x1: px, y1: GEO.PLOT_TOP, x2: px, y2: plotBottom }));
    const top = svgEl("text", { class: "axis-label", x: px + 3, y: GEO.AXIS_Y });
    top.textContent = fmtTick(t);
    el.svg.appendChild(top);
    const bot = svgEl("text", { class: "axis-label", x: px + 3, y: bottomLabelY });
    bot.textContent = fmtTick(t);
    el.svg.appendChild(bot);
  }
  // vertical axis (gutter edge) + horizontal baseline under the bottom scale
  el.svg.appendChild(svgEl("line", { class: "axis-line", x1: GEO.GUTTER, y1: GEO.PLOT_TOP, x2: GEO.GUTTER, y2: plotBottom }));
  el.svg.appendChild(svgEl("line", { class: "axis-line", x1: GEO.GUTTER, y1: plotBottom, x2: GEO.GUTTER + plotW, y2: plotBottom }));

  // project group headers: an expanded group gets a rule + caret/label (click to
  // fold); a too-small group gets a single folded summary row instead.
  for (const g of groups) {
    if (g.collapsed) drawCollapsedGroup(g, x, W);
    else drawGroupHeader(g, W);
  }

  drawOperatorLane(op, opTop, x, W);

  for (const g of groups) for (const row of g.rows) {
    drawRow(row, x, W, haveActivity, activeGlobal);
  }
  // context switches (optional, off by default): red verticals at each real
  // (≥0.5s-dwell) switch — toggled via the "show context switches" chart option.
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

// autoCollapseGroup: a group is "too small to read" when even its single widest
// session would render narrower than GROUP_COLLAPSE_MIN_PX at the current scale.
// Pixel-based (not duration-based) so the fold tracks the horizontal axis scale —
// zoom the plot wider and marginal groups unfold on their own.
function autoCollapseGroup(g, msToPx) {
  let maxPx = 0;
  for (const lane of g.lanes) {
    const w = msToPx(Date.parse(lane.end) - Date.parse(lane.start));
    if (isFinite(w) && w > maxPx) maxPx = w;
  }
  return maxPx < GEO.GROUP_COLLAPSE_MIN_PX;
}

// groupCollapsed resolves the effective folded state: an explicit user override
// (from clicking the header) wins, else the size-based auto default.
function groupCollapsed(g, msToPx) {
  const ov = groupCollapseOverride.get(g.project);
  return ov === undefined ? autoCollapseGroup(g, msToPx) : ov;
}

// drawGroupHeader draws an EXPANDED group's header: the full-width rule and a
// caret+label in the gutter. The gutter is a click target that folds the group.
function drawGroupHeader(g, W) {
  const ry = g.headY + GEO.GROUP_HEAD_H - 3;
  el.svg.appendChild(svgEl("line", { class: "group-rule", x1: 0, y1: ry, x2: W, y2: ry }));
  const caret = svgEl("text", { class: "group-caret", x: 10, y: g.headY + 13 });
  caret.textContent = "▾";
  el.svg.appendChild(caret);
  const gl = svgEl("text", { class: "group-label", x: 24, y: g.headY + 13 });
  gl.textContent = ((g.projectFull || g.project) + " · " + g.lanes.length).toUpperCase();
  el.svg.appendChild(gl);
  // gutter-wide transparent hit target → click folds the group
  const hit = svgEl("rect", { class: "group-hit", x: 0, y: g.headY, width: GEO.GUTTER, height: GEO.GROUP_HEAD_H });
  attachTip(hit, () => `<div class="t-hint">click to collapse</div>`);
  hit.addEventListener("click", () => toggleGroupCollapse(g.project, false));
  el.svg.appendChild(hit);
}

// drawCollapsedGroup draws a too-small group folded to one line: caret + label, a
// dim active/cost summary, and sparkbars marking WHEN its sessions ran so the fold
// still conveys placement. The whole strip is a click target that expands it, and
// each sparkbar hovers to the session's identity.
function drawCollapsedGroup(g, x, W) {
  const top = g.headY;
  const midY = top + GEO.GROUP_COLLAPSED_H / 2;
  el.svg.appendChild(svgEl("line", { class: "group-rule", x1: 0, y1: top, x2: W, y2: top }));

  // background rect is the primary click target (labels/sparkbars sit on top)
  const bg = svgEl("rect", { class: "group-collapsed-bg", x: 0, y: top, width: W, height: GEO.GROUP_COLLAPSED_H });
  bg.addEventListener("click", () => toggleGroupCollapse(g.project, true));
  attachTip(bg, () => `<div class="t-hint">click to expand · ${g.lanes.length} session${g.lanes.length === 1 ? "" : "s"}</div>`);
  el.svg.appendChild(bg);

  const caret = svgEl("text", { class: "group-caret", x: 10, y: midY + 4 });
  caret.textContent = "▸";
  el.svg.appendChild(caret);
  const gl = svgEl("text", { class: "group-label", x: 24, y: midY + 4 });
  gl.textContent = ((g.projectFull || g.project) + " · " + g.lanes.length).toUpperCase();
  el.svg.appendChild(gl);

  let activeMs = 0, cost = 0;
  for (const lane of g.lanes) {
    activeMs += laneActiveMs(lane); // clipped at the evidence bound, like the summary
    if (lane.cost_usd != null) cost += lane.cost_usd;
  }
  const meta = svgEl("text", { class: "group-collapsed-meta", x: GEO.GUTTER - 10, y: midY + 4, "text-anchor": "end" });
  meta.textContent = `${humanDurationCoarseMs(activeMs)}${cost > 0 ? " · " + fmtUSD(cost) : ""}`;
  el.svg.appendChild(meta);

  // sparkbars: each folded session's lifespan, so "when" survives the fold.
  const sy = midY - 3;
  for (const lane of g.lanes) {
    const sx = x(Date.parse(lane.start));
    const sw = Math.max(2, x(Date.parse(lane.end)) - sx);
    const bar = svgEl("rect", { class: "group-spark", x: sx, y: sy, width: sw, height: 6, rx: 1.5 });
    attachTip(bar, () => gutterTipHTML(lane, currentName(lane)));
    bar.addEventListener("click", () => toggleGroupCollapse(g.project, true));
    el.svg.appendChild(bar);
  }
}

// drawOperatorLane renders the top "operator" swimlane: gold = free time, dark
// red = occupied (you were attending an agent window, or inside a switch's
// recovery window). The two partition the running window.
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

// drawRow draws one PACKED row: a single full-width background + separator, then
// every time-serializable session on the row at its own x-range. The gutter no
// longer carries per-session identity (a packed row can hold several sessions) —
// identity is reachable on hover via each session's name-span tooltip, and only
// the cost is drawn, on the identifier line (see drawSession / nameSegTipHTML).
function drawRow(row, x, W, haveActivity, activeGlobal) {
  const rowTop = row.top;

  // row background (subtle alternation per ROW) + separator (group header rules the top edge)
  el.svg.appendChild(svgEl("rect", {
    class: row.idx % 2 ? "lane-bg odd" : "lane-bg", x: 0, y: rowTop, width: W, height: row.height,
  }));
  if (!row.firstInGroup) el.svg.appendChild(svgEl("line", { class: "lane-sep", x1: 0, y1: rowTop, x2: W, y2: rowTop }));

  for (const lane of row.lanes) drawSession(lane, rowTop, x, haveActivity, activeGlobal);
}

// drawSession draws ONE session at its own x-range (its lifespan) on a packed
// row: the name-span band (with the cost on its right edge), the status bars, the
// focus overlay, and the subagent sub-bars. Multiple non-overlapping sessions can
// share a row, so this never paints a full-width background (drawRow owns that).
function drawSession(lane, rowTop, x, haveActivity, activeGlobal) {
  const nameY = rowTop + GEO.PAD_TOP;
  const barY = nameY + GEO.NAME_H;
  const subTop = barY + GEO.BAR_H + GEO.GAP;

  // ---- name-span band: each /name slug labels the stretch it was active; the
  // leading pre-/name stretch falls back to project_full/project (see model.js). ----
  // cost rides the right end of the identifier (name-span) line above the bar;
  // the last name segment reserves room for it so label and cost never collide.
  const segs = nameSegments(lane);
  const costText = lane.cost_usd != null ? fmtUSD(lane.cost_usd) : "";
  const sessEnd = x(Date.parse(lane.end));
  const sessW = Math.max(1, sessEnd - x(Date.parse(lane.start)));
  const showCost = costText && sessW >= GEO.COST_MIN_W;
  const costW = showCost ? costText.length * 6.6 + 8 : 0;
  segs.forEach((seg, i) => {
    const sx = x(seg.start), ex = x(seg.end), sw = Math.max(1, ex - sx);
    const isLead = seg.kind === "lead";
    const bg = svgEl("rect", {
      class: "name-seg" + (isLead ? " lead" : ""), x: sx, y: nameY, width: sw, height: GEO.NAME_H, rx: 1,
    });
    bg.setAttribute("data-session", laneIdentity(lane)); // bars are keyed by identity, not name
    attachTip(bg, () => nameSegTipHTML(lane, seg));
    // click pins the archival summary card when session-digest has one WITH
    // something in it; the empty string is sessionPopoutHTML's way of saying the
    // click buys nothing, and swallowing it here leaves the event to the
    // background handler rather than pinning a card of footers. The handler
    // reads lastSummaries at click time, so summaries arriving after render are
    // picked up without a repaint — which is also why the pointer cursor on
    // .name-seg cannot be conditioned on having a card: at draw time we do not
    // yet know. The tooltip's hint is the affordance that is accurate on hover.
    bg.addEventListener("click", (ev) => {
      const html = sessionPopoutHTML(lane);
      if (html) { ev.stopPropagation(); pinPopout(html, ev); }
    });
    el.svg.appendChild(bg);
    // a dashed divider marks each rename boundary (skip the redundant left edge)
    if (i > 0) el.svg.appendChild(svgEl("line", { class: "name-div", x1: sx, y1: nameY, x2: sx, y2: barY + GEO.BAR_H }));
    if (sw >= GEO.NAME_MIN_W && seg.label) {
      const reserve = i === segs.length - 1 ? costW : 0; // keep the label clear of the cost
      const t = svgEl("text", { class: "name-seg-label" + (isLead ? " lead" : ""), x: sx + 4, y: nameY + 12.5 });
      t.textContent = truncate(seg.label, Math.max(1, Math.floor((sw - 6 - reserve) / 7.5)));
      el.svg.appendChild(t);
    }
  });
  if (showCost) {
    const t = svgEl("text", { class: "name-cost", x: sessEnd - 4, y: nameY + 12.5, "text-anchor": "end" });
    t.textContent = costText;
    attachTip(t, () => gutterTipHTML(lane, currentName(lane)));
    el.svg.appendChild(t);
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

  // ---- suspect tail: the stretch a producer synthesized because nothing ever
  // closed the session. Drawn OVER the status bars rather than instead of them —
  // the bar keeps its real geometry, and the hatch says "inferred, not observed".
  // The "?" badge is what makes it legible at a glance on a crowded day. ----
  const tail = suspectTailMs(lane);
  if (tail) {
    const [ts, te] = tail;
    // clamped to the bar's left edge: the contract puts suspect_since inside the
    // lane, but a producer that ever dated it earlier must not hatch open canvas.
    const tx = Math.max(x(Date.parse(lane.start)), x(ts));
    const tw = Math.max(2, x(te) - tx);
    const overlay = svgEl("rect", {
      class: "suspect-overlay", x: tx, y: barY - 1.5, width: tw, height: GEO.BAR_H + 3, rx: 2,
      fill: "url(#suspecthatch)",
    });
    attachTip(overlay, () => suspectTipHTML(lane));
    el.svg.appendChild(overlay);
    if (tw >= 14) {
      // no tip on the badge: it is pointer-events:none (style.css .suspect-badge),
      // so the overlay underneath is what carries the hover.
      const badge = svgEl("text", { class: "suspect-badge", x: tx + 5, y: barY + GEO.BAR_H - 2 });
      badge.textContent = "?";
      el.svg.appendChild(badge);
    }
  }

  // ---- provider accent spine: a colored left-edge marker keying the session to
  // its data provider in the merged view (absent in single-provider mode). ----
  if (lane.provider) {
    const spineX = x(Date.parse(lane.start));
    const spine = svgEl("rect", {
      class: "provider-spine", x: spineX, y: nameY, width: 3,
      height: barY + GEO.BAR_H - nameY, rx: 1, fill: provColor(lane.provider),
    });
    attachTip(spine, () => `<div class="t-status" style="color:${provColor(lane.provider)}">${escapeHTML(lane.provider)}</div><div class="t-hint">data provider</div>`);
    el.svg.appendChild(spine);
  }

  // ---- focus / attention overlay (hatch + outline) — gated by the "show focus" toggle ----
  if (focusEnabled()) {
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
  }

  // ---- subagent sub-bars: one stacked sub-line per concurrent subagent, so N
  // simultaneous subagents render as N parallel lines below the main bar. On each
  // sub-line, a run of too-thin adjacent slivers collapses to a single "×N" marker
  // rather than a smear of unreadable 1px bars (hover/click for the full list). ----
  const { subs, rows } = packSubagents(lane);
  for (let r = 0; r < rows; r++) {
    const rowSubs = subs.filter((sa) => sa.row === r); // globally start-sorted → row order preserved
    const ry = subTop + r * (GEO.SUB_ROW_H + GEO.SUB_GAP);
    for (const cell of clusterSubagents(rowSubs, x)) {
      if (cell.merged) {
        const cx = x(cell.s), cw = Math.max(6, x(cell.e) - cx);
        const bar = svgEl("rect", {
          class: "subagent-cluster", x: cx, y: ry, width: cw, height: GEO.SUB_ROW_H, rx: 1.5, fill: SUBAGENT_COLOR,
        });
        attachTip(bar, () => subagentClusterTipHTML(cell));
        bar.addEventListener("click", (ev) => { ev.stopPropagation(); pinPopout(subagentClusterPopoutHTML(cell), ev); });
        el.svg.appendChild(bar);
        if (cw >= 15) {
          const t = svgEl("text", { class: "subagent-count", x: cx + cw / 2, y: ry + GEO.SUB_ROW_H - 0.6, "text-anchor": "middle" });
          t.textContent = "×" + cell.members.length;
          el.svg.appendChild(t);
        }
      } else {
        const sa = cell.sa;
        const sx = x(sa.s), sw = Math.max(2, x(sa.e) - sx);
        // A span whose stop event never arrived and that ran too long to be real
        // work is drawn as a phantom — visible, but never mistaken for compute.
        const bar = svgEl("rect", {
          class: sa.suspect ? "subagent-bar subagent-phantom" : "subagent-bar",
          x: sx, y: ry, width: sw, height: GEO.SUB_ROW_H, rx: 1.5,
          fill: sa.suspect ? "url(#suspecthatch)" : SUBAGENT_COLOR,
        });
        attachTip(bar, () => subagentTipHTML(sa));
        bar.addEventListener("click", (ev) => { ev.stopPropagation(); pinPopout(subagentPopoutHTML(sa), ev); });
        el.svg.appendChild(bar);
      }
    }
  }
}

// clusterSubagents folds runs of adjacent slivers on a single sub-row into one
// marker. Input is one row's subs, start-sorted and non-overlapping. A sub wide
// enough (≥ SUB_MIN_PX) always stands alone; a lone sliver also stands alone —
// only a run of ≥2 thin, near (≤ SUB_MERGE_GAP_PX gap) slivers merges. Returns a
// list of { merged:false, sa } | { merged:true, s, e, members[] }.
function clusterSubagents(rowSubs, x) {
  const out = [];
  let i = 0;
  while (i < rowSubs.length) {
    const first = rowSubs[i];
    if (x(first.e) - x(first.s) >= GEO.SUB_MIN_PX) { out.push({ merged: false, sa: first }); i++; continue; }
    const members = [first];
    let lastE = first.e, j = i;
    while (j + 1 < rowSubs.length) {
      const next = rowSubs[j + 1];
      const thin = x(next.e) - x(next.s) < GEO.SUB_MIN_PX;
      const near = x(next.s) - x(lastE) <= GEO.SUB_MERGE_GAP_PX;
      if (thin && near) { members.push(next); if (next.e > lastE) lastE = next.e; j++; }
      else break;
    }
    out.push(members.length === 1 ? { merged: false, sa: first } : { merged: true, s: first.s, e: lastE, members });
    i = j + 1;
  }
  return out;
}

// packSubagents greedily first-fits a lane's subagents (sorted by start) into
// non-overlapping rows; row count equals the max simultaneous subagents, so true
// parallelism is preserved (no fixed cap). Each returned sub carries its `row`.
// Shared by laneHeight (height reservation) and drawSession so they stay in sync.
function packSubagents(lane) {
  const subs = (lane.subagents || [])
    .map((sa) => ({ ...sa, s: Date.parse(sa.start), e: Date.parse(sa.end) }))
    .filter((sa) => isFinite(sa.s) && isFinite(sa.e) && sa.e > sa.s)
    .sort((a, b) => a.s - b.s);
  const rowEnds = [];
  for (const sa of subs) {
    let r = rowEnds.findIndex((end) => sa.s >= end);
    if (r === -1) { rowEnds.push(sa.e); r = rowEnds.length - 1; }
    else rowEnds[r] = sa.e;
    sa.row = r;
  }
  return { subs, rows: rowEnds.length };
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
// render: "agents aloft" line chart (canvas)
//
// The instantaneous number of agents working at each moment (model.js
// concurrencyProfile: sessions in 'working' status + running subagents) drawn as
// a step line, with the day's average OVER ACTIVE TIME as a dashed horizontal
// line (the force-multiplier figure) and an optional centered 30-min rolling
// average. Shares the horizontal scale (zoom) + scroll wrap with the sessions
// view; a crosshair reads out the exact figures on hover.
// ---------------------------------------------------------------------------

const MONO = 'ui-monospace, "SFMono-Regular", "JetBrains Mono", "Cascadia Code", Menlo, Consolas, monospace';
const SMOOTH_WINDOW_MS = 30 * 60 * 1000; // centered rolling-average window
// RIGHT_LIVE is the wider right gutter a live window reserves for the live-tail
// readout — the count over a stacked "agents / aloft", hanging off the end of
// the line rather than sitting on top of it. Sized to the widest line at its
// font ("agents" at 9px mono), and reserved for the whole live day rather than
// only while a tail exists, so the plot doesn't jump width when the last agent
// lands.
const CGEO = { LEFT: 54, RIGHT: 18, RIGHT_LIVE: 56, TOP: 18, BOTTOM: 30, HEIGHT: 340 };

// chartHover carries the just-rendered chart's paint closure + scales so the
// canvas mousemove handler (wired once) can redraw the crosshair and read out
// values without recomputing the profile. Refreshed on every chart render.
let chartHover = null;

// niceIntStep picks a y-axis label step so an axis of 0..maxN stays readable
// (every 1 up to 10, then 2 / 5 / a rounded tenth as it grows).
function niceIntStep(maxN) {
  if (maxN <= 10) return 1;
  if (maxN <= 20) return 2;
  if (maxN <= 50) return 5;
  return Math.ceil(maxN / 10);
}

// cssVar reads a themed custom property off :root (canvas bakes colors in at draw
// time, so these are re-read on every render and on theme change).
function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function renderConcurrencyChart(data) {
  const canvas = el.canvas;
  el.empty.hidden = true; // the canvas draws its own empty state
  const lanes = renderableLanes(data.lanes);
  const spans = aloftSpans(lanes);
  // prof is the window's true accounting (peak / average / active time). The
  // DRAWN profile may differ at the trailing edge: on a live window the spans
  // still in flight are squared off to the newest sample (alignLiveTail), so the
  // staggered per-provider sample times don't paint a landing that never
  // happened. Stats stay on the unaligned figures.
  const prof = concurrencyProfile(spans.map((x) => [x.s, x.e]));
  const aligned = alignLiveTail(spans, Date.now(), isLiveWindow());
  const live = aligned.tail;
  const drawProf = live ? concurrencyProfile(aligned.intervals) : prof;
  const pts = drawProf.points;

  const C = {
    inst: cssVar("--c-working", "#3fb950"),
    smooth: cssVar("--accent", "#58a6ff"),
    avg: cssVar("--fg-muted", "#9da7b3"),
    grid: cssVar("--border-soft", "#21262d"),
    axis: cssVar("--border", "#2b3240"),
    text: cssVar("--fg-dim", "#6e7681"),
    bg: cssVar("--bg", "#0d1117"),
  };

  // window + horizontal scale (reuse the zoom density + scroll like the bars)
  const { t0, t1 } = windowBounds(data, lanes);
  const span = t1 - t0;
  const rightPad = isLiveWindow() ? CGEO.RIGHT_LIVE : CGEO.RIGHT;
  const containerW = Math.max(620, el.wrap.clientWidth);
  const fitPlotW = Math.max(160, containerW - CGEO.LEFT - rightPad);
  const plotW = plotWidthFor(span, fitPlotW);
  const W = CGEO.LEFT + plotW + rightPad;
  const H = CGEO.HEIGHT;
  const plotTop = CGEO.TOP, plotBottom = H - CGEO.BOTTOM, plotH = plotBottom - plotTop;
  // the axis has to hold whichever profile peaks higher: squaring off the tail
  // can overlap spans that the raw samples showed one after another.
  const yTop = Math.max(1, prof.maxN, drawProf.maxN);

  const X = (t) => CGEO.LEFT + ((t - t0) / span) * plotW;
  const Y = (n) => plotBottom - (n / yTop) * plotH;

  // DPR-crisp sizing (set once per render, not per crosshair repaint — resizing
  // the canvas clears it and resets the transform, so we do it here only).
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = W + "px";
  canvas.style.height = H + "px";
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  updateChartStats(prof);

  // cumulative integral over the step function -> O(log n) windowed averages and
  // level lookups for the rolling mean and hover readout.
  const cum = new Array(pts.length);
  if (pts.length) {
    cum[0] = 0;
    for (let k = 1; k < pts.length; k++) cum[k] = cum[k - 1] + pts[k - 1].n * (pts[k].t - pts[k - 1].t);
  }
  const firstT = pts.length ? pts[0].t : t0;
  const lastT = pts.length ? pts[pts.length - 1].t : t0;
  // largest index k with pts[k].t <= t (or -1 before the first breakpoint)
  function segAt(t) {
    if (!pts.length || t < pts[0].t) return -1;
    let lo = 0, hi = pts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (pts[mid].t <= t) lo = mid; else hi = mid - 1; }
    return lo;
  }
  function levelAt(t) {
    // past the final breakpoint: 0, unless that breakpoint is a live tail — then
    // those agents are still up, and the readout should say so.
    if (t >= lastT) return live ? live.n : 0;
    const k = segAt(t);
    return k < 0 ? 0 : pts[k].n;
  }
  function integralAt(t) {
    if (!pts.length || t <= firstT) return 0;
    if (t >= lastT) return cum[pts.length - 1];
    const k = segAt(t);
    return cum[k] + pts[k].n * (t - pts[k].t);
  }
  // centered 30-min rolling average, clamped to the plot window at the edges so
  // the smoothed line doesn't dip toward 0 against the empty out-of-window space.
  function windowedAvg(t) {
    let a = t - SMOOTH_WINDOW_MS / 2, b = t + SMOOTH_WINDOW_MS / 2;
    if (a < t0) a = t0;
    if (b > t1) b = t1;
    const w = b - a;
    return w > 0 ? (integralAt(b) - integralAt(a)) / w : 0;
  }

  const smoothOn = smoothEnabled();

  // paint draws the whole chart; hoverT (or null) overlays the crosshair. Kept as
  // a closure so the mousemove handler can repaint cheaply (no profile recompute).
  function paint(hoverT) {
    ctx.clearRect(0, 0, W, H);

    if (!pts.length) {
      ctx.fillStyle = C.text;
      ctx.font = "12px " + MONO;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("No agent activity for this window.", CGEO.LEFT + plotW / 2, H / 2);
      return;
    }

    // y gridlines + integer labels
    const yStep = niceIntStep(yTop);
    ctx.font = "11px " + MONO;
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (let n = 0; n <= yTop; n += yStep) {
      const yy = Math.round(Y(n)) + 0.5;
      ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(CGEO.LEFT, yy); ctx.lineTo(CGEO.LEFT + plotW, yy); ctx.stroke();
      ctx.fillStyle = C.text;
      ctx.fillText(String(n), CGEO.LEFT - 8, Y(n));
    }

    // x gridlines + time labels (reuse the bar axis tick chooser)
    const { ticks, step } = axisTicks(t0, t1, plotW);
    const showDate = step >= 24 * 3600e3;
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (const t of ticks) {
      const xx = Math.round(X(t)) + 0.5;
      ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(xx, plotTop); ctx.lineTo(xx, plotBottom); ctx.stroke();
      const d = new Date(t);
      ctx.fillStyle = C.text;
      ctx.fillText(showDate
        ? d.toLocaleDateString([], { month: "2-digit", day: "2-digit" })
        : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }), X(t), plotBottom + 6);
    }

    // left + bottom axis rules
    ctx.strokeStyle = C.axis; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(CGEO.LEFT + 0.5, plotTop); ctx.lineTo(CGEO.LEFT + 0.5, plotBottom);
    ctx.moveTo(CGEO.LEFT, plotBottom + 0.5); ctx.lineTo(CGEO.LEFT + plotW, plotBottom + 0.5);
    ctx.stroke();

    // instantaneous step: faint filled area, then the step line on top.
    // continueSubpath joins the steps onto an in-progress path with lineTo (a
    // moveTo would orphan the fill's baseline anchor into its own subpath and
    // closePath would then cut a diagonal back to the first level).
    const stepPath = (continueSubpath) => {
      const x0 = X(pts[0].t), y0 = Y(pts[0].n);
      if (continueSubpath) ctx.lineTo(x0, y0); else ctx.moveTo(x0, y0);
      for (let k = 1; k < pts.length; k++) {
        const xx = X(pts[k].t);
        ctx.lineTo(xx, Y(pts[k - 1].n)); // hold previous level across the segment
        // a live tail's final "step" is the sample ending, not a landing — the
        // line runs out at its current level and the marker below caps it.
        if (live && k === pts.length - 1) break;
        ctx.lineTo(xx, Y(pts[k].n));     // step to the new level
      }
    };
    ctx.beginPath();
    ctx.moveTo(X(pts[0].t), Y(0));
    stepPath(true);
    ctx.lineTo(X(pts[pts.length - 1].t), Y(0));
    ctx.closePath();
    ctx.globalAlpha = 0.12; ctx.fillStyle = C.inst; ctx.fill(); ctx.globalAlpha = 1;

    ctx.beginPath();
    stepPath();
    ctx.strokeStyle = C.inst; ctx.lineWidth = 1.4; ctx.lineJoin = "round"; ctx.stroke();

    // live tail cap: a dot terminating the line, with the count hanging off to
    // its right in the reserved gutter — out over the margin rather than on top
    // of the plot, so it never sits on the data. The dot carries a
    // background-colored ring so it reads as a terminator, not a kink.
    if (live) {
      const lx = X(live.t), ly = Y(live.n);
      ctx.beginPath();
      ctx.arc(lx, ly, 4, 0, 2 * Math.PI);
      ctx.fillStyle = C.inst; ctx.fill();
      ctx.strokeStyle = C.bg; ctx.lineWidth = 1.5; ctx.stroke();

      // count, then its label stacked under it in the same green — two short
      // lines keep the gutter narrow. Held clear of the plot edges so a tail at
      // 0 or at the peak still reads.
      const labelX = CGEO.LEFT + plotW + 8;
      const labelY = Math.min(Math.max(ly, plotTop + 10), plotBottom - 22);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = C.inst;
      ctx.font = "700 13px " + MONO;
      ctx.fillText(String(live.n), labelX, labelY);
      ctx.globalAlpha = 0.75; // the label qualifies the number, it doesn't compete
      ctx.font = "9px " + MONO;
      ctx.fillText(live.n === 1 ? "agent" : "agents", labelX, labelY + 10);
      ctx.fillText("aloft", labelX, labelY + 19);
      ctx.globalAlpha = 1;
    }

    // smoothed 30-min rolling average (sampled per pixel)
    if (smoothOn) {
      ctx.beginPath();
      for (let px = 0; px <= plotW; px++) {
        const t = t0 + (px / plotW) * span;
        const yy = Y(windowedAvg(t)), xx = CGEO.LEFT + px;
        if (px === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
      }
      ctx.strokeStyle = C.smooth; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.stroke();
    }

    // day average over active time — dashed horizontal + label
    if (prof.avgActive != null) {
      const yy = Y(prof.avgActive);
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = C.avg; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(CGEO.LEFT, yy); ctx.lineTo(CGEO.LEFT + plotW, yy); ctx.stroke();
      ctx.restore();
      ctx.fillStyle = C.avg; ctx.font = "11px " + MONO;
      ctx.textAlign = "left"; ctx.textBaseline = "bottom";
      ctx.fillText("avg " + prof.avgActive.toFixed(1) + "×", CGEO.LEFT + 6, yy - 3);
    }

    // crosshair + value dots on hover
    if (hoverT != null && hoverT >= t0 && hoverT <= t1) {
      const hx = Math.round(X(hoverT)) + 0.5;
      ctx.save();
      ctx.strokeStyle = C.text; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(hx, plotTop); ctx.lineTo(hx, plotBottom); ctx.stroke();
      ctx.restore();
      ctx.fillStyle = C.inst;
      ctx.beginPath(); ctx.arc(X(hoverT), Y(levelAt(hoverT)), 3, 0, 2 * Math.PI); ctx.fill();
      if (smoothOn) {
        ctx.fillStyle = C.smooth;
        ctx.beginPath(); ctx.arc(X(hoverT), Y(windowedAvg(hoverT)), 3, 0, 2 * Math.PI); ctx.fill();
      }
    }
  }

  paint(null);
  chartHover = { paint, t0, t1, span, plotW, plotLeft: CGEO.LEFT, prof, levelAt, windowedAvg, smoothOn };
}

// updateChartStats fills the line-view caption readout (peak / average / active).
function updateChartStats(prof) {
  const avg = prof.avgActive == null ? "—" : prof.avgActive.toFixed(1) + "×";
  el.chartStats.innerHTML =
      `<span class="cs-item"><span class="cs-k">peak</span><span class="cs-v">${prof.maxN}</span></span>`
    + `<span class="cs-item"><span class="cs-k">avg over active</span><span class="cs-v">${avg}</span></span>`
    + `<span class="cs-item"><span class="cs-k">active</span><span class="cs-v">${humanDurationCoarseMs(prof.activeMs)}</span></span>`;
}

// concurrencyTipHTML: hover readout for the line chart at time t.
function concurrencyTipHTML(h, t) {
  const n = h.levelAt(t);
  const avg = h.prof.avgActive;
  let html = `<div class="t-status" style="color:var(--c-working)">${n} agent${n === 1 ? "" : "s"} aloft</div>`
    + `<div class="t-row">${fmtClock(new Date(t).toISOString())}</div>`;
  if (h.smoothOn) html += `<div class="t-row" style="color:var(--accent)">30-min avg ${h.windowedAvg(t).toFixed(1)}</div>`;
  if (avg != null) html += `<div class="t-row">day avg ${avg.toFixed(1)}×</div>`;
  return html;
}

// ---------------------------------------------------------------------------
// render: project ranking (HTML bars)
//
// Where the day's agent time actually went, by project: model.js projectHoursMs
// sums each project's agent-time (working intervals + subagent spans, already
// sorted longest-first with zero-work projects dropped) and each row's bar is
// scaled against the top project. Unlike the other two views this one is
// time-less — a ranking, not a timeline — so it ignores the zoom/scroll scale.
// Plain HTML + CSS vars (no canvas), so it restyles itself on a theme flip.
// ---------------------------------------------------------------------------

// lastProjectKeys: one structural key per drawn row (project + its parts'
// labels in order). It decides the in-place update path below; null means "no
// comparable rows" (nothing drawn yet, or the empty state is showing).
let lastProjectKeys = null;

// projectRowKey captures everything the in-place path can NOT change: the
// project and its stack's membership/order. Part widths and totals move freely.
function projectRowKey(entry) {
  return [entry.project].concat(entry.parts.map((p) => p.label)).join("");
}

// sameProjectRows reports whether the freshly computed ranking has the same
// rows AND the same per-row session stacks as what's drawn. The child count is
// checked too, so any DOM desync (e.g. the empty state took over) falls back to
// a rebuild.
function sameProjectRows(keys) {
  if (!lastProjectKeys || lastProjectKeys.length !== keys.length) return false;
  if (el.projects.children.length !== keys.length) return false;
  return keys.every((k, i) => lastProjectKeys[i] === k);
}

function renderProjectsChart(data) {
  const rows = projectHoursMs(renderableLanes(data.lanes));
  el.empty.hidden = true; // this view draws its own empty state
  scaleGeo = null; // no time axis here, so no fit floor to carry out of the view

  if (!rows.length) {
    lastProjectKeys = null;
    el.projects.innerHTML = `<div class="projects-empty">No agent work for this window.</div>`;
    return;
  }

  // rows are sorted ms-descending, so the leader sets the 100% width; each
  // session segment takes its share of the row's stack at the same scale.
  const maxMs = rows[0].ms || 0;
  const widthPct = (ms) => (maxMs > 0 ? (ms / maxMs) * 100 : 0).toFixed(2) + "%";
  const keys = rows.map(projectRowKey);

  // In-place update when the ranking's membership, order, and stacks are all
  // unchanged: only segment widths and the duration text move, so the CSS width
  // transition glides the ~3s live refreshes instead of the rows being torn
  // down and rebuilt (a rebuild would snap the bars and re-run the grow-in
  // every poll). A session joining/leaving/renaming changes a row's key and
  // falls through to the rebuild.
  if (sameProjectRows(keys)) {
    rows.forEach((entry, i) => {
      const row = el.projects.children[i];
      row._entry = entry; // the retained hover listeners read this, so keep it live
      const segs = row.querySelectorAll(".proj-seg");
      entry.parts.forEach((part, j) => {
        segs[j]._part = part;
        segs[j].style.width = widthPct(part.ms);
      });
      row.querySelector(".proj-hours").textContent = humanDurationCoarseMs(entry.ms);
    });
    return;
  }

  el.projects.innerHTML = "";
  rows.forEach((entry, i) => {
    const row = document.createElement("div");
    row.className = "proj-row";
    row.style.setProperty("--row-i", String(i)); // stagger key for the grow-in
    row.innerHTML =
        `<span class="proj-name">${escapeHTML(entry.project)}</span>`
      + `<span class="proj-track"></span>`
      + `<span class="proj-hours">${escapeHTML(humanDurationCoarseMs(entry.ms))}</span>`;
    // one segment per session, in the model's lane-start (temporal) order; the
    // hover readouts read seg._part / row._entry (not closed-over values) so an
    // in-place update shows refreshed figures without re-wiring listeners.
    const track = row.querySelector(".proj-track");
    entry.parts.forEach((part, j) => {
      const seg = document.createElement("span");
      seg.className = "proj-seg";
      seg.style.width = widthPct(part.ms);
      seg.style.setProperty("--seg-i", String(j)); // stagger key within the row
      seg._part = part;
      seg.addEventListener("mousemove", (ev) => {
        ev.stopPropagation(); // the segment's readout wins over the row's
        showTip(projectSegTipHTML(row._entry, seg._part), ev);
      });
      seg.addEventListener("mouseleave", hideTip);
      track.appendChild(seg);
    });
    row._entry = entry;
    row.addEventListener("mousemove", (ev) => showTip(projectTipHTML(row._entry), ev));
    row.addEventListener("mouseleave", hideTip);
    el.projects.appendChild(row);
  });
  lastProjectKeys = keys;
}

// projectTipHTML: hover readout for one project row — the exact (to-the-second)
// duration the coarse row label rounds away, plus the session count behind it.
function projectTipHTML(entry) {
  const n = entry.sessions || 0;
  return `<div class="t-status" style="color:var(--c-working)">${escapeHTML(entry.project)}</div>`
    + `<div class="t-row">${humanDurationMs(entry.ms)} of agent time</div>`
    + `<div class="t-row">${n} session${n === 1 ? "" : "s"}</div>`;
}

// projectSegTipHTML: hover readout for one session's segment of the stack —
// the session's name and share, framed against its project's total.
function projectSegTipHTML(entry, part) {
  return `<div class="t-status" style="color:var(--c-working)">${escapeHTML(part.label)}</div>`
    + `<div class="t-row">${humanDurationMs(part.ms)} of agent time</div>`
    + `<div class="t-row">${escapeHTML(entry.project)} · ${humanDurationCoarseMs(entry.ms)} total</div>`;
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
// `substitution` is the same formula with this window's numbers already plugged
// in ("7h 37m − 1h 40m"). It rides inside the formula box, under the symbolic
// form, so a reader can see the arithmetic instead of reconstructing it.
function formulaTipHTML({ title, formula, substitution, result, why, color } = {}) {
  let html = "";
  if (title) html += `<div class="t-status"${color ? ` style="color:${color}"` : ""}>${escapeHTML(title)}</div>`;
  if (formula) {
    html += `<div class="t-formula">${escapeHTML(formula)}`
      + (substitution ? `<span class="t-subst">${escapeHTML(substitution)}</span>` : "")
      + `</div>`;
  }
  if (result != null && result !== "") html += `<div class="t-result">= <b>${escapeHTML(String(result))}</b></div>`;
  if (why) html += `<div class="t-why">${escapeHTML(why)}</div>`;
  return html;
}

// operatorTipHTML: a proper descriptor for the operator lane — the numeric rows,
// then a formula box explaining how "free" is derived, then a why-it-matters line.
function operatorTipHTML(op) {
  const pct = op.freeFrac == null ? "—" : Math.round(op.freeFrac * 100) + "%";
  return `<div class="t-status" style="color:${OP_FREE_COLOR}">operator free time</div>`
    + `<div class="t-row">free <b>${humanDurationMs(op.freeMs)}</b> · ${pct} of run</div>`
    + `<div class="t-row">occupied ${humanDurationMs(op.occupiedMs)}</div>`
    + `<div class="t-row">agents running ${humanDurationMs(op.runningMs)}</div>`
    + `<div class="t-row">${op.switches} context switch${op.switches === 1 ? "" : "es"}</div>`
    + `<div class="t-formula">free = running − (attending ∪ recovery)`
    + `<span class="t-subst">${humanDurationMs(op.runningMs)} − ${humanDurationMs(op.occupiedMs)}</span></div>`
    + `<div class="t-why">Time you had free while agents ran and you were neither attending an agent window nor recovering from a context switch. Attending needs activity within ${humanDurationMs(OP.awayAfterMs)} — a focused window you haven't touched since then reads as you having walked away.</div>`;
}

// tipHead renders a segment tooltip's headline: the status label on the left with
// the DURATION promoted (bold, right-aligned) as the primary figure, over a
// dimmed wall-clock line. The elapsed span matters more than the clock times, so
// it leads; the clock is kept dull and secondary.
function tipHead(statusHTML, color, clockHTML, durMs, body) {
  return `<div class="t-head">`
    + `<span class="t-status"${color ? ` style="color:${color}"` : ""}>${statusHTML}</span>`
    + `<span class="t-dur">${humanDurationMs(durMs)}</span>`
    + `</div>`
    + (body || "")
    + `<div class="t-clock">${clockHTML}</div>`;
}

// intervalTaskHTML surfaces the /name (or pre-/name project lead) active during a
// working span — the closest analog we have to the subagent task description,
// derived from data already in the payload (names[]/labels[]). A normal-agent
// interval carries no task text of its own, so we borrow the session's active
// name span as its context.
function intervalTaskHTML(lane, startMs, endMs) {
  const segs = nameSegments(lane);
  const mid = (startMs + endMs) / 2;
  const seg = segs.find((s) => mid >= s.start && mid < s.end) || segs[segs.length - 1];
  const label = seg && seg.label ? seg.label.trim() : "";
  return label ? `<div class="t-task">${escapeHTML(label)}</div>` : "";
}

function opSegTipHTML(kind, s, e) {
  const free = kind === "free";
  return tipHead(free ? "free" : "occupied", free ? OP_FREE_COLOR : "#e5534b",
      `${fmtClock(new Date(s).toISOString())} – ${fmtClock(new Date(e).toISOString())}`, e - s)
    + `<div class="t-why">${free
        ? "Agents were running but you weren't attending one or recovering from a switch."
        : `You were attending an agent window, or within ${humanDurationMs(OP.switchRecoveryMs)} of a context switch, while agents ran.`}</div>`;
}

// memoryRowsHTML renders a memory readout as tooltip rows. Peak leads because
// it is the figure that decides whether a machine survives; the average follows
// as the dim qualifier. The spawned split only appears when the provider
// actually reports one — a container total has no inner boundary, so an Arachne
// lane shows a single tree figure rather than a fabricated 0 for subagents.
// Returns "" for no data, so a lane without sampling renders exactly as before.
function memoryRowsHTML(mem) {
  if (!mem) return "";
  const tree = mem.peakTreeBytes != null ? mem.peakTreeBytes : mem.peakAgentBytes;
  if (tree == null) return "";
  let html = `<div class="t-row">memory <b>${fmtBytes(tree)}</b> peak`
    + (mem.avgTreeBytes != null ? ` <span class="dim">${fmtBytes(mem.avgTreeBytes)} avg</span>` : "")
    + `</div>`;
  if (mem.peakSpawnedBytes != null && mem.peakAgentBytes != null) {
    html += `<div class="t-row"><span class="dim">agent</span> ${fmtBytes(mem.peakAgentBytes)}`
      + ` · <span class="dim">spawned</span> ${fmtBytes(mem.peakSpawnedBytes)}</div>`;
  }
  return html;
}

// pressureRowHTML reports what the MACHINE was doing, not this session — the
// question a fat interval actually raises. Shown only when there was measurable
// stall: a healthy stretch says nothing rather than printing a reassuring zero,
// and an absent reading (no PSI on this kernel) says nothing either, because
// "not measured" must never render as "fine".
function pressureRowHTML(p) {
  if (!p || p.totalStallUs == null || p.totalStallUs <= 0) return "";
  // stallFraction is uncorrected at the leading edge (the window's first delta
  // reaches back before it started), so it can exceed 1 on a short interval.
  // The model reports that honestly; capping belongs here, at display time.
  const pct = p.stallFraction != null
    ? ` <span class="dim">${(Math.min(1, p.stallFraction) * 100).toFixed(1)}% of the interval</span>`
    : "";
  const head = p.minAvailBytes != null ? ` <span class="dim">· ${fmtBytes(p.minAvailBytes)} free at worst</span>` : "";
  return `<div class="t-row">machine stalled <b>${humanDurationMs(p.totalStallUs / 1000)}</b>${pct}${head}</div>`;
}

function intervalTipHTML(lane, iv) {
  const startMs = Date.parse(iv.start), endMs = Date.parse(iv.end);
  const durMs = endMs - startMs;
  const sub = iv.subagents || 0;
  const note = iv.status === "delegating" ? " (delegating — faded)"
    : iv.status === "dormant" ? " (waiting on subagent)" : "";
  return tipHead(`${statusLabel(iv.status)}${note}`, statusColor(iv.status),
      `${fmtClock(iv.start)} – ${fmtClock(iv.end)}`, durMs,
      intervalTaskHTML(lane, startMs, endMs))
    + (sub > 0 ? `<div class="t-sub">${sub} subagent${sub === 1 ? "" : "s"} at start</div>` : "")
    + memoryRowsHTML(memoryWindow(lane, lastMemory, startMs, endMs))
    + pressureRowHTML(pressureWindow(lastMemory, startMs, endMs));
}

function subagentTipHTML(sa) {
  const durMs = sa.e - sa.s;
  return `<div class="t-status" style="color:${SUBAGENT_COLOR}">${escapeHTML(sa.agent_type || "subagent")}</div>`
    + (sa.description ? `<div class="t-desc">${escapeHTML(sa.description)}</div>` : "")
    + `<div class="t-row">${fmtClock(sa.start)} – ${fmtClock(sa.end)} · ${humanDurationMs(durMs)}</div>`
    + (sa.suspect ? `<div class="t-suspect">phantom span — not counted as work<div class="t-suspect-why">${escapeHTML(sa.suspect_reason || "")}</div></div>` : "")
    + `<div class="t-hint">click to pin</div>`;
}

// suspectTipHTML explains the hatched tail. The producer's reason string is
// shown verbatim: it distinguishes a live-day ghost ("stretched to now") from a
// session that merely ran across the window bound, and the operator needs to
// tell those apart before trusting or discarding the bar.
function suspectTipHTML(lane) {
  const tail = suspectTailMs(lane);
  const durMs = tail ? tail[1] - tail[0] : 0;
  return `<div class="t-head"><span class="t-status t-status-suspect">unverified stretch</span>`
    + `<span class="t-dur">${humanDurationMs(durMs)}</span></div>`
    + `<div class="t-suspect-why">${escapeHTML(lane.suspect_reason || "no session end was ever observed")}</div>`
    + `<div class="t-row">last evidence ${fmtClock(lane.suspect_since)}</div>`
    + `<div class="t-hint">drawn, but excluded from every total</div>`;
}

function subagentPopoutHTML(sa) {
  const durMs = sa.e - sa.s;
  return `<div class="po-head" style="color:${SUBAGENT_COLOR}">${escapeHTML(sa.agent_type || "subagent")}</div>`
    + (sa.description ? `<div class="po-desc">${escapeHTML(sa.description)}</div>` : "")
    + `<div class="po-row">duration <b>${humanDurationMs(durMs)}</b></div>`
    + `<div class="po-row">${fmtClock(sa.start)} – ${fmtClock(sa.end)}</div>`
    + (sa.tool_use_id ? `<div class="po-id">${escapeHTML(sa.tool_use_id)}</div>` : "");
}

// tooltip / popout for a merged sliver cluster ("N subagents" marker).
function subagentClusterTipHTML(cell) {
  const n = cell.members.length;
  let total = 0;
  for (const m of cell.members) total += m.e - m.s;
  return `<div class="t-status" style="color:${SUBAGENT_COLOR}">${n} subagents</div>`
    + `<div class="t-row">${fmtClock(cell.s)} – ${fmtClock(cell.e)} · ${humanDurationMs(total)} total</div>`
    + `<div class="t-hint">too thin to separate — click to list</div>`;
}

function subagentClusterPopoutHTML(cell) {
  const n = cell.members.length, cap = 12;
  const rows = cell.members.slice(0, cap).map((m) =>
    `<div class="po-row">${escapeHTML(m.agent_type || "subagent")} <b>${humanDurationMs(m.e - m.s)}</b> <span class="dim">${fmtClock(m.s)}</span></div>`
  ).join("");
  const more = n > cap ? `<div class="po-row dim">+${n - cap} more</div>` : "";
  return `<div class="po-head" style="color:${SUBAGENT_COLOR}">${n} subagents</div>`
    + `<div class="po-desc">merged — each too thin to draw separately at this scale</div>`
    + rows + more;
}

function nameSegTipHTML(lane, seg) {
  const durMs = seg.end - seg.start;
  const note = seg.kind === "lead" ? " (before first /name)" : "";
  const ineff = spanInefficiency(lane, seg.start, seg.end);
  // identity footer: the name band spans the whole session, so this keeps the
  // FULL identity reachable on hover even when the in-span identity text is hidden
  // on a narrow span (the gutter no longer carries it).
  const idBits = [];
  if (lane.provider) idBits.push(lane.provider);
  idBits.push(lane.agent || "?");
  if (lane.pid != null) idBits.push("pid " + lane.pid);
  if (lane.cost_usd != null) idBits.push(fmtUSD(lane.cost_usd));
  const sum = sessionSummary(lane);
  // the hover stays the one-liner; the hint says what the pinned card adds
  // (how many task bullets, when the session had more than one).
  const hint = summaryHintText(sum);
  return tipHead(`${escapeHTML(seg.label || "(unnamed)")}${note}`, null,
      `${fmtClock(seg.start)} – ${fmtClock(seg.end)}`, durMs)
    // a record may now carry token counts and no summary, so the description
    // is gated on itself rather than on the record existing
    + (sum && sum.description ? `<div class="t-desc">${escapeHTML(sum.description)}</div>` : "")
    + (ineff != null ? `<div class="t-row">operator inefficiency ${Math.round(ineff * 100)}% <span class="dim">idle/waiting</span></div>` : "")
    + tokenRowsHTML(sum && sum.tokens)
    + memoryRowsHTML(laneMemory(lane, lastMemory))
    + `<div class="t-id">${escapeHTML(idBits.join(" · "))}</div>`
    + (lane.session_id ? `<div class="t-id">${escapeHTML(lane.session_id)}</div>` : "")
    + (hint ? `<div class="t-hint">${escapeHTML(hint)}</div>` : "");
}

// sessionPopoutHTML is the pinned card for a session bar: the generated
// archival identity (name, one-liner, task bullets, narrative) from
// session-digest, plus the lane's own identity footer. The body — bullets over
// prose, or prose alone — comes from model.js so the node suite can cover it.
// Empty when there is no summary, and equally empty for a summary with no body
// (summaryCardHasContent, also in model.js): a record with no tasks and no prose
// would put only the archival name and the id footer on screen over what the
// tooltip already showed, so the caller drops the click instead of pinning it.
//
// Token counts ride along but deliberately do NOT enter that gate: the tooltip
// already shows them on every hover, so they are never the thing behind an
// unadvertised click, and letting them make a prose-less record pinnable would
// break the hint-empty ⇔ card-empty invariant model.test.js pins.
function sessionPopoutHTML(lane) {
  const sum = sessionSummary(lane);
  if (!summaryCardHasContent(sum)) return "";
  const idBits = [];
  if (lane.provider) idBits.push(lane.provider);
  idBits.push(lane.agent || "?");
  if (lane.pid != null) idBits.push("pid " + lane.pid);
  if (lane.cost_usd != null) idBits.push(fmtUSD(lane.cost_usd));
  return `<div class="po-head">${escapeHTML(sum.name || currentName(lane) || "(unnamed)")}</div>`
    + `<div class="po-desc">${escapeHTML(sum.description)}</div>`
    + summaryBodyHTML(sum)
    + tokenRowsHTML(sum.tokens, "po-row")
    + `<div class="po-id">${escapeHTML(idBits.join(" · "))}</div>`
    + (lane.session_id ? `<div class="po-id">${escapeHTML(lane.session_id)}</div>` : "");
}

function gutterTipHTML(lane, name) {
  let html = `<div class="t-status">${escapeHTML(name)}</div>`;
  if (lane.suspect) {
    html += `<div class="t-suspect">unverified stretch to ${fmtClock(lane.end)}`
      + `<div class="t-suspect-why">${escapeHTML(lane.suspect_reason || "")}</div></div>`;
  }
  const sum = sessionSummary(lane);
  if (sum && sum.description) html += `<div class="t-desc">${escapeHTML(sum.description)}</div>`;
  html += `<div class="t-row">${escapeHTML(lane.agent || "?")}`
    + (lane.project ? ` · ${escapeHTML(lane.project)}` : "") + ` · pid ${lane.pid}</div>`;
  if (lane.session_id) html += `<div class="t-id">${escapeHTML(lane.session_id)}</div>`;
  if (lane.cost_usd != null) html += `<div class="t-row">cost ${fmtUSD(lane.cost_usd)}</div>`;
  html += tokenRowsHTML(sum && sum.tokens);
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
  // Delegation effectiveness = share of your total agent engagement that ran
  // hands-off (delegated) vs. hands-on (attended supervising + prompt driving).
  // We recompute it here to INCLUDE prompt time — the upstream
  // summary.delegation_effectiveness is delegated/(delegated+attended), which
  // ignores prompting so heavy hands-on driving never lowers the score. Fall
  // back to the upstream scalar only when the components aren't recorded.
  let eff;
  if (da != null || aa != null || pa != null) {
    const d = da || 0, a = aa || 0, p = pa || 0;
    eff = d + a + p > 0 ? d / (d + a + p) : null;
  } else {
    eff = summary.delegation_effectiveness != null ? summary.delegation_effectiveness : null;
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
    formula: "delegated ÷ (delegated + attended + prompt)",
    substitution: da == null && aa == null && pa == null ? null
      : `${humanDuration(da || 0)} ÷ (${humanDuration(da || 0)} + ${humanDuration(aa || 0)} + ${humanDuration(pa || 0)})`,
    result: effPct == null ? "—" : effPct + "%",
    why: "Share of your agent engagement that ran hands-off (delegated) vs. hands-on (supervising + prompting) — higher = more leverage.",
    color: effColor,
  });
  const ctxTip = tip({
    title: "context switches",
    formula: "focus arrivals − 1",
    substitution: op ? `${op.switches + 1} − 1` : null,
    result: op ? String(op.switches) : "—",
    why: "How many times you moved your attention between sessions.",
    color: "var(--c-permission)",
  });
  const recovStr = humanDurationMs(OP.switchRecoveryMs);
  const lostTip = tip({
    title: "operator time lost to AI",
    formula: `⋃ ${recovStr} recovery per switch, merged, ∩ running`,
    // recovery × switches is the naive charge; the union and the ∩ are what cut
    // it down. Both numbers are shown because the gap between them IS the point
    // — a burst of switches inside one recovery window costs one recovery.
    substitution: !op ? null : (() => {
      const raw = op.switches * OP.switchRecoveryMs;
      const naive = `${recovStr} × ${op.switches} = ${humanDurationMs(raw)}`;
      return op.lostMs < raw ? `${naive}\n− overlap → ${humanDurationMs(op.lostMs)}` : naive;
    })(),
    result: op ? humanDurationMs(op.lostMs) : "—",
    why: `Time absorbed re-acquiring context after switches while agents ran. Switch bursts merge into one recovery window rather than costing ${recovStr} apiece.`,
    color: "var(--c-permission)",
  });

  // engagement split: delegated (you away) / attended (you watching) / prompt (you driving)
  const del = da || 0, att = aa || 0, prm = pa || 0;
  const engage = del + att + prm;
  const pctOf = (v) => (engage > 0 ? Math.round((v / engage) * 100) : 0);
  const seg = (w, color) => (w > 0 ? `<span class="sb-seg" style="width:${((w / engage) * 100).toFixed(3)}%;background:${color}"></span>` : "");
  const splitBar = engage > 0
    ? `<div class="split-bar" role="img" aria-label="engagement split">${seg(del, "var(--c-working)")}${seg(att, "var(--c-idle)")}${seg(prm, "var(--accent)")}</div>`
    : "";
  const dotK = (color, text) => `<span class="dot-k" style="background:${color}"></span>${text}`;
  const timePct = (t, pct) => `${humanDuration(t)} <span class="dim">${pct}%</span>`;

  // parallelism factor: agent-hours ÷ wall-clock-active ≈ average simultaneous agents
  const union = summary.attention_union, perSession = summary.attention_per_session;
  const parallel = union && perSession && union > 0 ? perSession / union : null;

  // operator-overhead callout — the cost of context switching. Prioritized near the
  // top and styled dark red (this is waste, not leverage).
  const opBox = `
    <div class="op-overhead danger">
      <div class="op-overhead-head">operator overhead</div>
      <div class="op-overhead-row has-tip" data-tip="${ctxTip}">
        <span class="oo-k">context switches</span><span class="oo-v">${op ? op.switches : "—"}</span>
      </div>
      <div class="op-overhead-row has-tip" data-tip="${lostTip}">
        <span class="oo-k">operator time lost to AI</span><span class="oo-v">${op ? humanDurationMs(op.lostMs) : "—"}</span>
      </div>
    </div>`;

  el.cardAttention.innerHTML = `
    <div class="card-label">attention &amp; delegation</div>
    <div class="headline-row">
      <div class="headline has-tip" data-tip="${effTip}">
        <div class="hv" style="color:${effColor}">${haveDeleg && effPct != null ? effPct + "%" : "—"}</div>
        <div class="hk">delegation effectiveness · hands-off share of your engagement</div>
      </div>
    </div>

    ${opBox}

    ${haveDeleg ? `
      <div class="kv-head">where your time went</div>
      ${splitBar}
      <div class="kv-list">
        ${row(dotK("var(--c-working)", "delegated · you away"), timePct(del, pctOf(del)), {
          title: "delegated",
          formula: "agent active while you were away",
          result: humanDuration(da),
          why: "Agent kept working without supervision — pure leverage.",
          color: "var(--c-working)",
        })}
        ${row(dotK("var(--c-idle)", "attended · you watching"), timePct(att, pctOf(att)), {
          title: "attended",
          formula: "agent active while you supervised",
          result: humanDuration(aa),
          why: "Agent worked while you watched — useful, but not leverage.",
          color: "var(--c-idle)",
        })}
        ${row(dotK("var(--accent)", "prompt · you driving"), timePct(prm, pctOf(prm)), {
          title: "prompt",
          formula: "you actively driving (typing)",
          result: humanDuration(pa),
          why: "Hands-on time where you were actively prompting.",
          color: "var(--accent)",
        })}
      </div>
    ` : `<div class="kv muted-note">delegation metrics not recorded for this window</div>`}

    <div class="kv-sep"></div>
    <div class="kv-list">
      ${row("active · ≥1 agent running", humanDuration(union), {
        title: "active",
        formula: "wall-clock with ≥1 session active",
        result: humanDuration(union),
        why: "Real time elapsed while at least one agent was running.",
      })}
      ${row("agent-hours · parallel work", `${humanDuration(perSession)}${parallel ? ` <span class="dim">${parallel.toFixed(1)}×</span>` : ""}`, {
        title: "agent-hours",
        formula: "Σ per-session active time · ×N = agent-hours ÷ active",
        substitution: parallel ? `${humanDuration(perSession)} ÷ ${humanDuration(union)} = ${parallel.toFixed(1)}×` : null,
        result: humanDuration(perSession),
        why: "Total active agent-time counting parallel sessions separately; ×N is average parallelism (agent-hours ÷ active).",
      }, "deemph")}
    </div>
    ${suspectNoteHTML(summary)}`;

  attachFormulaTips(el.cardAttention);
}

// suspectNoteHTML footnotes the figures above with what the producer refused to
// count. Without it the numbers silently disagree with the bars on screen — a
// hatched tail is visible in the plot but absent from every total here.
function suspectNoteHTML(summary) {
  const lanes = summary.suspect_lanes || 0;
  if (lanes <= 0) return "";
  const dur = summary.suspect_duration || 0;
  return `<div class="kv muted-note suspect-note">`
    + `${lanes} lane${lanes === 1 ? "" : "s"} flagged as unverified — `
    + `${humanDuration(dur)} of synthesized time excluded from these figures`
    + `</div>`;
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
  const pw = data.plan_window || null;

  // tip() → escaped formula-descriptor HTML for a data-tip attribute.
  const tip = (obj) => escapeHTML(formulaTipHTML(obj));

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
  el.day.value = q.get("day") || todayLocal();
  // ?view=sessions|line|projects deep-links the chart view (URL wins over the
  // persisted choice for this load, mirroring how ?day overrides the default day).
  const v = normalizeView(q.get("view"));
  if (v) currentView = v;
  syncDayDisplay();
}

// syncDayDisplay mirrors the picker's ISO value (YYYY-MM-DD) into the visible
// label. The native <input type="date"> renders in the browser locale, so we
// hide it behind this label to keep the date reading as ISO everywhere.
function syncDayDisplay() {
  el.dayDisplay.textContent = el.day.value || "—";
}

// ---------------------------------------------------------------------------
// theme (light / dark)
// Follows the system by default; the topbar toggle sets an explicit choice that
// is persisted and wins over the system preference. When the resolved theme is
// dark we add <meta name="darkreader-lock"> so the DarkReader extension leaves
// our first-class dark theme alone rather than double-inverting it; in light
// mode we remove the lock so DarkReader may darken the page if the user runs it.
// The <head> inline script applies the same before first paint (no flash); this
// keeps everything in sync when the toggle is used or the system flips.
// ---------------------------------------------------------------------------
const THEME_KEY = "sb-theme";
const themeMql = window.matchMedia("(prefers-color-scheme: dark)");

function storedTheme() {
  const v = localStorage.getItem(THEME_KEY);
  return v === "light" || v === "dark" ? v : null; // null → follow the system
}
function resolvedTheme() {
  return storedTheme() || (themeMql.matches ? "dark" : "light");
}
function setDarkReaderLock(locked) {
  let m = document.querySelector('meta[name="darkreader-lock"]');
  if (locked && !m) {
    m = document.createElement("meta");
    m.name = "darkreader-lock";
    document.head.appendChild(m);
  } else if (!locked && m) {
    m.remove();
  }
}
function applyTheme() {
  const theme = resolvedTheme();
  document.documentElement.setAttribute("data-theme", theme);
  setDarkReaderLock(theme === "dark");
  if (el.themeToggle) {
    const next = theme === "dark" ? "light" : "dark";
    el.themeToggle.title = "switch to " + next + " theme";
    el.themeToggle.setAttribute("aria-label", "switch to " + next + " theme");
  }
  // The SVG restyles itself via CSS vars; the canvas bakes colors in at draw
  // time, so it must be repainted to pick up the new theme.
  if (currentView === "line" && lastData) renderConcurrencyChart(lastData);
}
function toggleTheme() {
  localStorage.setItem(THEME_KEY, resolvedTheme() === "dark" ? "light" : "dark");
  applyTheme();
}

function init() {
  applyUrlParams();
  applyTheme();
  el.themeToggle.addEventListener("click", toggleTheme);
  themeMql.addEventListener("change", () => { if (!storedTheme()) applyTheme(); });

  el.day.addEventListener("change", () => { syncDayDisplay(); reloadNow(); });
  el.prevDay.addEventListener("click", () => { el.day.value = shiftDay(el.day.value, -1); syncDayDisplay(); reloadNow(); });
  el.nextDay.addEventListener("click", () => { el.day.value = shiftDay(el.day.value, +1); syncDayDisplay(); reloadNow(); });
  // open the native calendar on click (the transparent picker overlays the field)
  el.dateField.addEventListener("click", () => { try { el.day.showPicker(); } catch (_) {} });
  el.optCtxSwitches.addEventListener("change", () => { if (lastData) renderTimeline(lastData); });
  el.optFocus.addEventListener("change", () => { if (lastData) renderTimeline(lastData); });
  el.optSmooth.addEventListener("change", () => {
    syncSmoothLegend();
    if (lastData && currentView === "line") renderConcurrencyChart(lastData);
  });
  syncSmoothLegend(); // seat the legend to the toggle's initial state

  // view switcher: sessions ↔ agents-aloft line chart ↔ project ranking
  el.viewSessions.addEventListener("click", () => setView("sessions"));
  el.viewLine.addEventListener("click", () => setView("line"));
  el.viewProjects.addEventListener("click", () => setView("projects"));
  el.section.classList.toggle("view-line", currentView === "line");
  el.section.classList.toggle("view-projects", currentView === "projects");
  el.viewSessions.setAttribute("aria-pressed", String(currentView === "sessions"));
  el.viewLine.setAttribute("aria-pressed", String(currentView === "line"));
  el.viewProjects.setAttribute("aria-pressed", String(currentView === "projects"));
  // seat the glider without motion, then arm its transitions for real flips
  positionViewGlider();
  requestAnimationFrame(() => el.viewseg.classList.add("glider-ready"));

  // horizontal-scale zoom: step the px/hour density, reset to the built-in
  // default. Steps run off the EFFECTIVE density so the first click always
  // moves the chart — stepping the stored value would spend several clicks
  // climbing back to a floor the plot is already drawn at.
  el.zoomIn.addEventListener("click", () => setZoom(scaleNow().effective * ZOOM_FACTOR));
  el.zoomOut.addEventListener("click", () => setZoom(scaleNow().effective / ZOOM_FACTOR));
  el.zoomReset.addEventListener("click", () => setZoom(GEO.PX_PER_HOUR));
  updateZoomReadout();

  // line-chart crosshair: repaint the hovered vertical + value dots and show a
  // readout. Cheap — reuses the last render's paint closure, no profile recompute.
  el.canvas.addEventListener("mousemove", (ev) => {
    const h = chartHover;
    if (!h) return;
    const rect = el.canvas.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    if (px < h.plotLeft || px > h.plotLeft + h.plotW) { h.paint(null); hideTip(); return; }
    const t = h.t0 + ((px - h.plotLeft) / h.plotW) * h.span;
    h.paint(t);
    showTip(concurrencyTipHTML(h, t), ev);
  });
  el.canvas.addEventListener("mouseleave", () => { if (chartHover) chartHover.paint(null); hideTip(); });

  // dismiss popout on outside click / Escape
  document.addEventListener("click", (ev) => {
    if (!el.popout.hidden && !el.popout.contains(ev.target)) hidePopout();
  });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") hidePopout(); });

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (lastData) renderChartArea(lastData); }, 120);
  });

  // live polling — no manual refresh controls. Settings land first: every
  // operator figure depends on them, and re-rendering the page a beat later with
  // different thresholds would be a visible flicker of the numbers.
  loadSettings().then(loadTimeline);
  loadPlan();
  loadSummaries();
  loadMemory();
  timelineTimer = setInterval(loadTimeline, POLL_MS);
  planTimer = setInterval(loadPlan, PLAN_POLL_MS);
  setInterval(loadSummaries, SUMMARIES_POLL_MS);
  setInterval(loadMemory, MEMORY_POLL_MS);
  setInterval(tickLive, 1000);
}

init();
