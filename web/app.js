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
//     delegation_effectiveness. v2 top-level: plan_window, activity[], and the
//     provider-neutral agent_timeline descendant graph (all optional).
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
// A session idle while YOU were away (a lane parked overnight) is signal-free:
// nothing is waiting on anyone. It draws darkened rather than full idle orange,
// and the cumulative-time card excludes it (see awayIdleMs in model.js).
const IDLE_AWAY_OPACITY = 0.35;
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

// displayName renders a wire identifier (a status, a provider) as the dashboard's
// own label. The contract's vocabulary is lowercase and the field guide teaches
// it that way; a legend beside "Working" and "Idle" is the dashboard speaking,
// not the wire, so it gets a capital. Formula strings still quote the raw value.
function displayName(s) {
  return String(s).charAt(0).toUpperCase() + String(s).slice(1);
}
function statusLabel(s) {
  return displayName(s === "" ? "unknown" : s);
}
function statusColor(s) {
  return STATUS_COLORS[s] !== undefined ? STATUS_COLORS[s] : "#8957e5";
}

// Semantic agent provider -> accent color. A merged adapter gives every lane a
// `provider` namespace; Switchboard's own mixed feed instead distinguishes
// Claude from Codex with lane.agent. laneProvider() resolves both forms before
// the accent (a left-edge spine + a legend chip) is chosen.
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

// Every unit but the LEADING one is zero-padded to two digits, so a column of
// these lines up: "1h 03m 09s" sits under "23h 04m 31s" with the h, m and s
// columns in register, where "1h 3m 9s" under "23h 4m 31s" did not. The leading
// unit is never padded — "03m 31s" would assert an hours column that is not
// there, and reads as a number someone forgot to finish.
//
// A zero MIDDLE unit is printed rather than skipped (1h 00m 05s, not 1h 05s):
// dropping it punches a hole straight through the alignment this exists for.
// Trailing zeros are still dropped, so a round duration stays "2h", not
// "2h 00m 00s" — there is no column below it to keep register with.
function humanDuration(ns) {
  if (ns == null) return "—";
  if (ns <= 0) return "0s";
  const totalSec = ns / 1e9;
  if (totalSec < 1) return Math.round(ns / 1e6) + "ms";
  let s = Math.floor(totalSec);
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const parts = [];
  const unit = (v, suffix) => (parts.length ? String(v).padStart(2, "0") : String(v)) + suffix;
  if (h) parts.push(unit(h, "h"));
  if (m || (h && s)) parts.push(unit(m, "m"));
  if (s || parts.length === 0) parts.push(unit(s, "s"));
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

// resetCountdown renders "Resets in 2h 14m" from an RFC3339 instant.
function resetCountdown(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!isFinite(t)) return "";
  const ms = t - Date.now();
  if (ms <= 0) return "Resetting…";
  return "Resets in " + humanDurationMs(ms);
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
  calendar: document.getElementById("calendar"),
  calGrid: document.getElementById("cal-grid"),
  calYm: document.getElementById("cal-ym"),
  calMonthName: document.getElementById("cal-monthname"),
  calPrev: document.getElementById("cal-prev"),
  calNext: document.getElementById("cal-next"),
  calToday: document.getElementById("cal-today"),
  liveDot: document.getElementById("live-dot"),
  updated: document.getElementById("updated"),
  error: document.getElementById("error"),
  topline: document.getElementById("topline"),
  statusKey: document.getElementById("status-key"),
  providerKey: document.getElementById("provider-key"),
  svg: document.getElementById("timeline"),
  gutterSvg: document.getElementById("timeline-gutter"),
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
  cardTokens: document.getElementById("card-tokens"),
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

// ---------------------------------------------------------------------------
// the window state machine
//
// The day used to live only in a hidden <input>, read at fetch time. That left
// no way to tell "the day you asked for" from "the day on screen", so there was
// nothing to paint against while the request was out —
// and a day switch showed NOTHING for the ~1.5s the provider subprocess takes
// (measured; see docs/instant-day-switch.md — the render itself is ~22ms).
//
// So the day is real state now, and it moves in two beats:
//   commit  — synchronous, on the keypress. The day, the label and the SKELETON
//             (the frame the data will land in) are on screen before we yield.
//   settle  — whenever the data for that day arrives, however long that takes.
//
// `seq` is what keeps the two honest. Every request carries the seq it was
// issued under, and a response whose seq is stale is dropped on the floor. That
// is what stops the 3s poll — which races every switch — from painting day A
// over day B and leaving the chart disagreeing with the date label.
// ---------------------------------------------------------------------------

const DAY_FETCH_DEBOUNCE_MS = 120; // held arrows coalesce to one request
const PREFETCH_IDLE_MS = 400;      // let the settled day breathe before warming neighbors
const DAY_CACHE_MAX = 12;          // closed-day payloads retained client-side
const PREFETCH_DEPTH = 3;          // days warmed ahead of a scroll, in its direction

const win = {
  seq: 0,          // monotonic request id; responses below this are superseded
  pending: false,  // committed to a day whose data has not arrived yet
};
let dataDay = null;        // the day lastData actually describes
let dayFetchTimer = null;  // debounce handle for the committed day's fetch
let prefetchTimer = null;
let lastStepDir = -1;      // which way the user is walking; backward is the common case
// Closed days are immutable enough to keep: revisiting one is then free — no
// request at all, not merely a warm server cache. Today is never stored.
const dayCache = new Map(); // ISO day -> raw response text (insertion-ordered LRU)
// Shape of the last real plot, so a pending window can raise a skeleton with
// the same frame instead of collapsing the page to nothing.
let lastPlotShape = null;
let lastAloftW = 0; // width of the last aloft render, for the same reason

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

// cacheableDay: a day that is over cannot change, so its payload is worth
// keeping. Today is excluded — it is the live window the poll exists to watch.
function cacheableDay(day) {
  return !!day && day < todayLocal();
}

function rememberDay(day, text) {
  if (!cacheableDay(day)) return;
  dayCache.delete(day); // re-insert so Map order is true LRU
  dayCache.set(day, text);
  while (dayCache.size > DAY_CACHE_MAX) dayCache.delete(dayCache.keys().next().value);
}

// ---------------------------------------------------------------------------
// the in-flight register
//
// dayCache answers "have we FINISHED fetching this day?", which is the wrong
// question while a request is out — and it was the only question anything asked.
// schedulePrefetch consulted it 400ms after a day settled and cheerfully
// re-issued the very day the user's arrow key had already put in flight 280ms
// earlier, so every cold hop through history cost TWO provider subprocesses,
// which then competed with each other for the machine. The prefetcher built to
// make scrolling fast was doubling the load during a scroll.
//
// So: one register of what is already being asked for, consulted by both paths.
// ---------------------------------------------------------------------------

const daysInFlight = new Map(); // ISO day -> { promise, ctl, speculative }

// fetchDay is the ONE place a timeline request is issued, and it is deduplicated
// by day: a day already in flight is JOINED, never asked for twice. That join is
// what lets the user arrow onto a day the prefetcher is mid-way through and
// ADOPT that work instead of racing it — the request does not restart, it simply
// stops being speculative.
function fetchDay(day, opts) {
  const speculative = !!(opts && opts.speculative);
  const open = daysInFlight.get(day);
  if (open) {
    if (!speculative) open.speculative = false; // adopted: someone is waiting now
    return open.promise;
  }
  const entry = { ctl: new AbortController(), speculative, promise: null };
  daysInFlight.set(day, entry);
  entry.promise = fetch("/api/timeline?day=" + encodeURIComponent(day), {
    cache: "no-store",
    signal: entry.ctl.signal,
  })
    .then(async (res) => {
      const text = await res.text();
      // The body of a failed response carries the provider's stderr, which is
      // the only useful thing to put in front of the user, so it rides along.
      if (!res.ok) throw Object.assign(new Error("timeline " + res.status), { body: text });
      return text;
    })
    .finally(() => { if (daysInFlight.get(day) === entry) daysInFlight.delete(day); });
  return entry.promise;
}

// committedRequestOut reports whether anything someone is ACTUALLY WAITING ON is
// in flight. A speculative request is not such work, so it must not hold the
// live poll off — that is the difference the `speculative` flag exists to draw.
function committedRequestOut() {
  for (const entry of daysInFlight.values()) if (!entry.speculative) return true;
  return false;
}

// abortStaleDays cancels work for every day but `keep`. A day change makes every
// other request worthless — real or speculative — and leaving them running means
// the subprocess the user IS waiting on competes with subprocesses nobody wants.
// Holding the arrow key across five days used to leave an orphan prefetch for a
// day already scrolled past running against the day actually wanted (measured:
// a 450ms orphan alongside the 650ms request that mattered).
//
// `keep` is spared rather than restarted: that is the adoption case above.
function abortStaleDays(keep) {
  for (const [day, entry] of daysInFlight) {
    if (day === keep) continue;
    entry.ctl.abort();
  }
}

// loadTimeline fetches the committed day and, if that day is still the one on
// screen when the bytes land, settles it.
//
// Two guards make it safe to have several of these in flight, which a live poll
// crossing a day switch guarantees:
//   - a day change aborts every day but the one being switched to, so a
//     superseded subprocess is not also competing for the machine — while a
//     request already out for the incoming day is adopted rather than restarted;
//   - the seq check drops any response that is no longer the current request,
//     which is what stops an in-flight poll for the OLD day from repainting the
//     chart under the NEW day's label.
//
// A POLL, though, must never displace anything. Aborting on every issue looks
// symmetrical and is a starvation bug: the fetch is ~1.4s against a 3s cadence
// today, so one slow provider away, each poll would kill its predecessor at the
// 3s mark and none would ever complete — the live view would freeze silently
// with the dot still green. A poll that finds committed work in flight yields.
async function loadTimeline(opts) {
  const reason = (opts && opts.reason) || "poll";
  const day = el.day.value;

  // A day we already hold settles with no network at all. The keypress path
  // checks this in commitWindow, ahead of the debounce; this is the backstop for
  // the manual and initial paths, which do not go through a debounce at all.
  const cached = dayCache.get(day);
  if (cached !== undefined && reason !== "poll") {
    win.seq++;
    settleTimeline(day, cached, { fromCache: true });
    return;
  }

  if (reason === "poll" && committedRequestOut()) return; // yield to live work
  if (reason !== "poll") abortStaleDays(day);

  const seq = ++win.seq;
  try {
    const text = await fetchDay(day);
    if (seq !== win.seq) return; // superseded by a newer request
    hideError();
    fetchOK = true;
    lastUpdatedAt = Date.now();
    rememberDay(day, text);
    settleTimeline(day, text, { fromCache: false });
    schedulePrefetch(day);
  } catch (e) {
    if (e && e.name === "AbortError") return; // a newer request owns the screen
    if (seq !== win.seq) return;
    let msg = e && e.body !== undefined ? e.body : String(e);
    if (e && e.body !== undefined) {
      try { const j = JSON.parse(e.body); msg = j.error + (j.stderr ? "\n" + j.stderr : ""); } catch (_) {}
    }
    showError(msg);
    fetchOK = false;
    failPendingWindow();
  }
}

// settleTimeline puts data on screen for `day`. The repaint-on-change guard is
// keyed on the DAY as well as the bytes: comparing text alone was only
// accidentally correct, since lastTimelineText belonged to whichever day was
// fetched last, not necessarily to this one.
function settleTimeline(day, text, opts) {
  const wasPending = win.pending;
  if (!wasPending && day === dataDay && text === lastTimelineText) { tickLive(); return; }
  lastTimelineText = text;
  dataDay = day;
  lastData = adaptProviderTimeline(JSON.parse(text));
  // Smooth the status stream ONCE, here, before anything reads it. A sub-5s
  // `idle` mid-run is the state machine catching its breath, not the agent
  // waiting on anyone — but `idle` is not a running status, so left in place it
  // splits the running union, and free blocks are carved out of that union. One
  // blip turns an unbroken stretch into two and moves its time out of the ≥15m
  // column into the fringe. Doing it at the payload rather than per-consumer is
  // what keeps the bars, the union, the block count and every tooltip telling
  // the same story. The flicker itself is a provider-side bug — switchboard#74,
  // where half of one day's idle intervals were under 5s and carried 0.09% of
  // its idle time — and this is the dashboard declining to repeat it. If that
  // lands, this pass becomes a no-op rather than a disagreement.
  if (lastData && lastData.lanes) lastData.lanes = deflickerLanes(lastData.lanes);

  // A window the user asked for earns the reveal. That is either because it
  // arrived after a skeleton (wasPending), or because it came straight out of
  // the cache in the same frame as the keypress and so never needed one
  // (opts.entering) — a day switch is a content change either way, and the
  // sweep is bound to content identity, not to having waited.
  if (wasPending || (opts && opts.entering)) {
    // Strike the skeleton and let the chart make its entrance. armChartEnter has
    // to run BEFORE the render for the time views (they read the sweep's
    // progress as they draw), and startProjectsEnter AFTER it (its CSS class
    // needs the rows on the page) — the same order setView uses.
    exitPendingWindow();
    armChartEnter(currentView);
    render(lastData);
    if (currentView === "projects") startProjectsEnter();
  } else {
    render(lastData);
  }
  tickLive();
  if (opts && opts.fromCache) schedulePrefetch(day);
}

// ---------------------------------------------------------------------------
// commit: the synchronous half of a day switch
// ---------------------------------------------------------------------------

// commitWindow is the ONE path that moves the day. Everything it does is
// synchronous and lands in the same frame as the keypress: the value, the
// label, the skeleton. The fetch is deliberately the last thing, and it is
// debounced — holding an arrow key across five days must repaint the shell five
// times but spawn ONE provider subprocess, not five that then fight each other.
function commitWindow(iso) {
  if (!Number.isFinite(parseISODate(iso))) return;
  if (iso > todayLocal()) return;
  if (iso === el.day.value) return;
  el.day.value = iso;
  syncDayDisplay();
  hidePopout();
  hideTip();

  // Everything the old day had queued is worthless now: its debounced fetch, the
  // speculative walk out from it, and every request in flight EXCEPT one for the
  // day we are moving to — that one is adopted, not restarted.
  if (dayFetchTimer) { clearTimeout(dayFetchTimer); dayFetchTimer = null; }
  if (prefetchTimer) { clearTimeout(prefetchTimer); prefetchTimer = null; }
  abortStaleDays(iso);

  // A day we already hold needs no request, so it must not wait behind the
  // debounce — whose entire job is to coalesce requests it is not going to make.
  // The cache read used to sit INSIDE the debounced callback, which meant every
  // hop through already-loaded history paid 120ms to discover it had nothing to
  // fetch: ~150-190ms per hop against a paint that costs 7-13ms. Here it lands
  // in the same frame as the keypress, and the skeleton is skipped entirely —
  // there is nothing to be pending about.
  const held = dayCache.get(iso);
  if (held !== undefined) {
    win.seq++; // no request will answer for this day; supersede anything that would
    schedulePoll();
    settleTimeline(iso, held, { fromCache: true, entering: true });
    return;
  }

  enterPendingWindow();
  schedulePoll(); // the poll only exists for the live window; a past day is closed
  dayFetchTimer = setTimeout(() => {
    dayFetchTimer = null;
    loadTimeline({ reason: "day" });
  }, DAY_FETCH_DEBOUNCE_MS);
}

// enterPendingWindow raises the skeleton: the frame the incoming day will land
// in, with nothing in it that asserts a value. The section carries .pending and
// CSS dims every figure that now belongs to the outgoing day, so the page reads
// as "this is arriving" rather than showing stale numbers under a new date.
function enterPendingWindow() {
  win.pending = true;
  cancelSweep();
  el.section.classList.add("pending");
  document.body.classList.add("window-pending");
  el.empty.hidden = true;
  hideTip(); // a formula tooltip belongs to a figure that no longer exists
  renderSkeleton();
  renderFiguresSkeleton();
}

function exitPendingWindow() {
  win.pending = false;
  el.section.classList.remove("pending");
  document.body.classList.remove("window-pending");
}

// A failed window keeps the skeleton down but stops pretending data is coming:
// the error banner is already up, and leaving a shimmer running under it would
// read as a request still in flight.
function failPendingWindow() {
  if (!win.pending) return;
  exitPendingWindow();
  el.section.classList.add("window-failed");
  setTimeout(() => el.section.classList.remove("window-failed"), 0);
}

// ---------------------------------------------------------------------------
// the skeleton
//
// Rule for everything below: SHOW STRUCTURE, NEVER ASSERT A VALUE. The
// horizontal scale is not knowable before the data lands (summary.from/to are
// the day's first and last ACTIVITY, not calendar bounds), so the skeleton
// draws no axis ticks and no labels — it would only have to take them back.
// Ghost bar widths come from a fixed repeating pattern rather than the outgoing
// day's shapes, so nothing on screen can be mistaken for the day being fetched.
// ---------------------------------------------------------------------------

const GHOST_WIDTHS = [0.92, 0.64, 0.81, 0.47, 0.73, 0.55, 0.88, 0.38];
const GHOST_ROWS_DEFAULT = 6;
const GHOST_ROWS_MAX = 10; // a 171-lane day must not raise a 1700px shimmer wall

// ghostRowCount takes only the ROW COUNT from the outgoing day, not its exact
// geometry. Replaying the real tops would reproduce the group-header gaps of a
// day that is no longer on screen, leaving the skeleton pocked with holes that
// mean nothing; a compact, even set of rows of about the right number keeps the
// page's height in the same neighbourhood without inventing structure.
function ghostRowCount() {
  const prev = lastPlotShape ? lastPlotShape.rows.length : 0;
  if (!prev) return GHOST_ROWS_DEFAULT;
  return Math.min(GHOST_ROWS_MAX, Math.max(3, prev));
}

function renderSkeleton() {
  if (currentView === "line") renderAloftSkeleton();
  else if (currentView === "projects") renderProjectsSkeleton();
  else renderSessionsSkeleton();
}

function renderSessionsSkeleton() {
  while (el.svg.childNodes.length > 1) el.svg.removeChild(el.svg.lastChild);
  clearGutter(); // the frozen column is the outgoing day's, and it lives elsewhere now
  const n = ghostRowCount();
  const rowH = GEO.PAD_TOP + GEO.NAME_H + GEO.BAR_H + GEO.PAD_BOTTOM + GEO.GAP;

  // The skeleton is sized to the VISIBLE band, not to the outgoing day's full
  // plot width. Both time views scroll, and at the default density barely half
  // the plot is on screen — ghost bars laid out across 4500px would all reach
  // past the right edge, so every row would read as full width and the shape
  // would be a solid block. This is the same reasoning sweepX applies.
  const W = Math.max(620, el.wrap.clientWidth);
  const plotW = Math.max(160, W - GEO.GUTTER - GEO.RIGHT);
  const H = GEO.PLOT_TOP + GEO.OP_LANE_H + n * rowH + GEO.AXIS_BOTTOM_H;

  el.svg.setAttribute("width", W);
  el.svg.setAttribute("height", H);
  el.svg.style.width = W + "px";
  el.svg.style.height = H + "px";

  const g = document.createElementNS(SVGNS, "g");
  g.setAttribute("class", "skeleton");

  // the operator lane's slot, held open so the rows below don't jump when it
  // comes back
  g.appendChild(ghostRect(GEO.GUTTER, GEO.PLOT_TOP + 12, plotW * 0.97, GEO.OP_BAR_H, 0));

  for (let i = 0; i < n; i++) {
    const barTop = GEO.PLOT_TOP + GEO.OP_LANE_H + i * rowH + GEO.PAD_TOP + GEO.NAME_H;
    // gutter: a stand-in for where the session's name goes, not the name itself
    g.appendChild(ghostRect(GEO.GUTTER - 148, barTop + GEO.BAR_H / 2 - 5, 120, 10, i));
    g.appendChild(ghostRect(GEO.GUTTER, barTop, plotW * GHOST_WIDTHS[i % GHOST_WIDTHS.length], GEO.BAR_H, i));
  }

  el.svg.appendChild(g);
}

// The figures are the part of the page that must NOT survive a day change: a
// dimmed "30h 11m" is still a readable number, and sitting under the incoming
// day's date it reads as that day's answer. So they are replaced outright by
// blocks of the right shape — the layout holds, and nothing on screen claims
// anything about a window we have not fetched yet.
function renderFiguresSkeleton() {
  const block = (cls, w) => `<div class="${cls} ghost-text" style="width:${w}px"></div>`;
  el.topline.innerHTML = [[150, 128], [176, 190], [86, 210]]
    .map(([vw, kw], i) =>
      `<div class="th-block" style="--ghost-i:${i}">${block("th-val", vw)}${block("th-key", kw)}</div>`)
    .join("");
  el.statusKey.innerHTML = STATUS_ORDER.map((_, i) =>
    `<span class="sk" style="--ghost-i:${i}">`
    + `<span class="sk-left">${block("sk-name", 62)}</span>${block("sk-val", 48)}</span>`).join("");
  if (el.providerKey) el.providerKey.hidden = true;
  for (const card of [el.cardAttention, el.cardCost, el.cardTokens]) {
    card.innerHTML = `<div class="box-label ghost-text" style="width:112px"></div>`
      + [172, 140, 156, 120].map((w, i) => block("card-ghost-line", w)).join("");
  }
}

function ghostRect(x, y, w, h, i) {
  const r = document.createElementNS(SVGNS, "rect");
  r.setAttribute("class", "ghost");
  r.setAttribute("x", x);
  r.setAttribute("y", y);
  r.setAttribute("width", Math.max(0, w));
  r.setAttribute("height", h);
  r.setAttribute("rx", Math.min(3, h / 2));
  r.style.setProperty("--ghost-i", String(i));
  return r;
}

// The aloft view is a canvas, so its skeleton is drawn rather than classed: the
// plot frame and gridlines only — no trace, no axis numbers.
function renderAloftSkeleton() {
  const canvas = el.canvas;
  const containerW = Math.max(620, el.wrap.clientWidth);
  const W = lastAloftW || containerW;
  const H = CGEO.HEIGHT;
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = W + "px";
  canvas.style.height = H + "px";
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const plotTop = CGEO.TOP, plotBottom = H - CGEO.BOTTOM;
  ctx.strokeStyle = cssVar("--border-soft", "#21262d");
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = Math.round(plotTop + ((plotBottom - plotTop) * i) / 4) + 0.5;
    ctx.beginPath();
    ctx.moveTo(CGEO.LEFT, y);
    ctx.lineTo(W - CGEO.RIGHT, y);
    ctx.stroke();
  }
  ctx.strokeStyle = cssVar("--border", "#2b3240");
  ctx.beginPath();
  ctx.moveTo(CGEO.LEFT, plotBottom + 0.5);
  ctx.lineTo(W - CGEO.RIGHT, plotBottom + 0.5);
  ctx.stroke();
  updateChartStats(null);
}

function renderProjectsSkeleton() {
  lastProjectKeys = null; // the ghost rows are not a ranking; force a real rebuild
  const n = Math.min(GHOST_WIDTHS.length, Math.max(3, (lastPlotShape && lastPlotShape.rows.length) || GHOST_ROWS_DEFAULT));
  let html = "";
  for (let i = 0; i < n; i++) {
    html += `<div class="proj-row ghost-row" style="--ghost-i:${i}">`
      + `<span class="proj-name ghost-text"></span>`
      + `<span class="proj-track"><span class="ghost-fill" style="width:${(GHOST_WIDTHS[i] * 100).toFixed(0)}%"></span></span>`
      + `<span class="proj-hours ghost-text"></span>`
      + `<span class="proj-cost ghost-text"></span>`
      + `</div>`;
  }
  el.projects.innerHTML = html;
}

// ---------------------------------------------------------------------------
// polling + prefetch
// ---------------------------------------------------------------------------

// schedulePoll runs the timeline poll ONLY for the live window. A closed day
// cannot change, so polling one re-spawned a ~1.5s provider subprocess every 3
// seconds forever — a ~50% duty cycle of pure waste that competed with the very
// request a day switch was waiting on. A hidden tab is idle for the same reason.
//
// The cadence is measured from COMPLETION, not on a fixed interval: POLL_MS is
// the gap BETWEEN polls, so a provider that slows down stretches the cadence
// instead of queueing spawns behind each other. With setInterval, a fetch
// slower than POLL_MS would have the machine permanently busy re-deriving a day
// it had not finished deriving. See docs/incremental-poll.md — the poll re-sends
// ~92% unchanged bytes, and that is the thing actually worth fixing.
function schedulePoll() {
  if (timelineTimer) clearTimeout(timelineTimer);
  timelineTimer = null;
  if (!isLiveWindow() || document.hidden) return;
  timelineTimer = setTimeout(pollTick, POLL_MS);
}

async function pollTick() {
  timelineTimer = null;
  if (!isLiveWindow() || document.hidden) return;
  try { await loadTimeline({ reason: "poll" }); } finally { schedulePoll(); }
}

// schedulePrefetch warms the days an arrow press would reach next. It runs only
// once the current day has settled and gone quiet, because a prefetch costs the
// server the same ~1.5s subprocess as a real request — issued eagerly it would
// slow down the switch it is supposed to accelerate.
function schedulePrefetch(day) {
  if (prefetchTimer) clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(() => {
    prefetchTimer = null;
    prefetchFrom(day);
  }, PREFETCH_IDLE_MS);
}

// prefetchFrom warms ONE day, then chains to the next as soon as that one lands.
//
// Depth is what makes a scroll survive past its first hop. Warming a single
// neighbour put the free cadence at PREFETCH_IDLE_MS + one subprocess — call it
// 1.5-2s per day — against a keyboard repeat of ~30ms, so the first press was
// instant and every press after it was cold. Walking ahead means the same total
// work happens off the critical path, while the user is reading the day they
// just landed on.
//
// The chain stays deliberately SERIAL. The point is to start earlier, not to fan
// out: three speculative subprocesses running at once would be three things
// fighting the one request the user is actually waiting on, which is the failure
// this whole file is organised against.
function prefetchFrom(origin) {
  const day = nextPrefetchDay(origin);
  if (!day) return;
  fetchDay(day, { speculative: true })
    .then((text) => { rememberDay(day, text); })
    .catch(() => { /* best-effort: a cold day just costs the usual wait */ })
    .then(() => {
      // Keep walking only while the user is still parked where we set out from.
      // If they have moved, commitWindow has already aborted this walk and
      // scheduled the one that belongs to the new day.
      if (el.day.value === origin) prefetchFrom(origin);
    });
}

// nextPrefetchDay picks the nearest day we do not already hold, looking in the
// direction the user is walking and then one day back the way they came — the
// hop they are most likely to want after a wrong turn.
//
// Only CLOSED days are warmed: today is never cached, so prefetching it would
// burn a spawn for nothing. Days already in flight are skipped, which is what
// stops this from re-issuing the request the user's own keypress just made.
function nextPrefetchDay(origin) {
  const dir = lastStepDir < 0 ? -1 : 1;
  const candidates = [];
  for (let i = 1; i <= PREFETCH_DEPTH; i++) candidates.push(shiftDay(origin, i * dir));
  candidates.push(shiftDay(origin, -dir));
  for (const d of candidates) {
    if (d === origin || !cacheableDay(d) || dayCache.has(d) || daysInFlight.has(d)) continue;
    return d;
  }
  return null;
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
    el.updated.textContent = "Last " + agoString(lastUpdatedAt);
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
//   present   = ⋃ [activity-active start, end + OP.awayAfterMs]
//               ∪ [focus arrival, arrival + OP.awayAfterMs] — you don't stop
//               being at the machine the instant you stop typing, but an agent
//               window focused and untouched for awayAfterMs means you walked
//               away and left it up; a focus ARRIVAL is itself input, so it
//               counts as presence even when the activity watcher missed it
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
  //
  // Presence is evidenced two ways, unioned: the watcher's active spans, and
  // every real focus ARRIVAL (the dwell-filtered set the switch counter uses)
  // — a window switch is operator input, so it proves presence even where the
  // watcher's edges went missing (2026-07-30 logged five activity edges all
  // day while hundreds of focus events told the true story). Each piece of
  // evidence decays by the same awayAfterMs. Arrival evidence is gated on the
  // activity stream existing at all, so a window with no stream keeps the
  // established degradation above instead of a subtly different one.
  const active = spansToMs((data.activity || []).filter((a) => a.state === "active"));
  const haveActivityStream = (data.activity || []).length > 0;
  const present = unionMs([
    ...active.map(([s, e]) => [s, e + OP.awayAfterMs]),
    ...(haveActivityStream ? switchStarts.map((t) => [t, t + OP.awayAfterMs]) : []),
  ]);
  const attending = present.length ? intersectMs(engaged, present) : engaged;

  const occupiedAll = unionMs([...ctxRecovery, ...attending]);
  const occupied = intersectMs(occupiedAll, running); // drawn only while agents run
  const free = subtractMs(running, occupiedAll);

  const sum = (pairs) => pairs.reduce((a, [s, e]) => a + (e - s), 0);
  const runningMs = sum(running);
  const freeMs = sum(free);

  // The four-way partition of the running wall clock, for the attention card's
  // proportion bar. DISJOINT by construction and summing to runningMs exactly,
  // which is the whole point — a bar whose parts overlap is not a proportion.
  //
  //   prompt    = attending ∩ running ∩ raw activity  — at a window, typing
  //   supervise = attending ∩ running − raw activity  — at a window, hands off
  //   refocus   = ctxRecovery ∩ running − attending   — the switch tax, elsewhere
  //   free      = running − attending − ctxRecovery   — the work blocks
  //
  // ATTENDING WINS THE OVERLAP, and the choice is not cosmetic. Every recovery
  // window opens at a focus arrival, which is also where a focus span starts, so
  // charging the overlap to recovery buries every visit shorter than the 90s
  // recovery inside "re-focusing": on a real day that read as 11m of prompting
  // against 3h53m of recovery, when 1h55m of it was measured typing. Observed
  // input beats a modelled penalty; the penalty keeps whatever is left over.
  //
  // Consequence to keep in mind: refocusMs is therefore SMALLER than lostMs (the
  // whole recovery ∩ running, which the switching-cost box quotes). Both are
  // real, they answer different questions, and the row's label and descriptor
  // say which one this is.
  //
  // prompt vs supervise is the raw activity stream (keyboard/mouse), not the
  // decayed presence union: reading a diff with your hands off the keys is
  // supervision, and presence deliberately outlives input by awayAfterMs.
  const activeRaw = unionMs(active);
  const attendSpans = intersectMs(attending, running);
  const promptSpans = intersectMs(attendSpans, activeRaw);
  const superviseSpans = subtractMs(attendSpans, activeRaw);
  const recoverSpans = subtractMs(intersectMs(ctxRecovery, running), attending);

  // COUNT + overlay reuse the recovery set exactly, so the red lines you see are
  // the switches charged against free time — no more, no fewer.
  const switchTimes = recoveryStarts;
  const switches = Math.max(0, switchStarts.length - 1);
  return {
    running, occupied, free,
    runningMs, freeMs,
    occupiedMs: sum(occupied),
    // present/hasActivity: the presence union (active spans + the away decay)
    // and whether an activity stream backed it at all. The idle-while-away fade
    // reads presence through these — hasActivity false means "no evidence you
    // ever left", which every consumer must fail open on, NOT "away all day".
    present,
    hasActivity: ((data && data.activity) || []).length > 0,
    // hasAttention: did we observe the operator at all? Without a focus stream
    // occupied is 0 for lack of evidence, not because you were never at the
    // keyboard, and any figure that subtracts it must fall back instead.
    hasAttention: focusSpans.length > 0,
    switches,
    switchTimes,
    // lostMs is the whole switch tax (the box); refocusMs is the disjoint part
    // of it that the proportion bar can carry without double-counting.
    lostMs: sum(intersectMs(ctxRecovery, running)),
    promptMs: sum(promptSpans),
    superviseMs: sum(superviseSpans),
    refocusMs: sum(recoverSpans),
    freeFrac: runningMs > 0 ? freeMs / runningMs : null,
  };
}

// ---------------------------------------------------------------------------
// render: top-level
// ---------------------------------------------------------------------------

function render(data) {
  const op = computeOperatorTime(data);
  renderTopline(data, op);
  renderStatusKey(data.summary || {}, awayIdleTotalNs(data, op));
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
// The scroll position used to be left alone on the argument that parking at
// "now" would take the y-axis and the lane labels off the other side. Both are
// frozen columns now, so that trade is gone: a window newly framed anchors
// itself (anchorWindowScroll), and a viewport already parked on the live edge
// STAYS there as the day grows under it — measured here, before the repaint
// widens the plot, because afterwards there is no way to tell "was following"
// from "happens to be near the end".
const LIVE_FOLLOW_SLOP_PX = 4;
function renderChartArea(data) {
  const wrap = el.wrap;
  const wasFollowingLive = isLiveWindow()
    && wrap.scrollWidth - wrap.clientWidth > 0
    && wrap.scrollLeft >= wrap.scrollWidth - wrap.clientWidth - LIVE_FOLLOW_SLOP_PX;

  if (currentView === "line") renderConcurrencyChart(data);
  else if (currentView === "projects") renderProjectsChart(data);
  else renderTimeline(data);

  if (wasFollowingLive) {
    wrap.scrollLeft = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
    syncGutterFreeze();
  }
  // the fit floor moves with the window, the view and the container, so the
  // scale readout is only true once the render that measured it has run.
  updateZoomReadout();
}

// ---------------------------------------------------------------------------
// chart entry: the sweep
//
// All three views reveal left→right along the axis they measure. The projects
// bars already grow that way in CSS (proj-grow, below); the two TIME views
// replay the day from t0 under this ticker rather than a keyframe each, because
// the aloft chart is a canvas with no DOM to hang a keyframe on — one driver
// keeps the easing, the durations and the "on view ENTRY only" rule in a single
// place.
//
// The ticker owns one number: how much of the plot is revealed. Both time views
// read sweepProgress() as they draw, so a repaint that lands mid-sweep (the 3s
// poll, a theme flip) redraws at the reveal already on screen instead of
// snapping to the finished chart. Per frame the ticker then re-runs only the
// cheap part — four attributes on the sessions curtain, one repaint of the
// canvas.
// ---------------------------------------------------------------------------

const SWEEP_MS = { sessions: 380, line: 560 };
// fast off the mark, gently arriving — a plotter head that knows where it stops
const sweepEase = (p) => 1 - Math.pow(1 - p, 3);
// ramp re-maps progress through [a,b] onto 0..1. The sweep's internal beats —
// the average line settling in behind the trace, the leading hairline running
// out before the end — are all expressed with it, and nothing else.
const ramp = (p, a, b) => Math.min(1, Math.max(0, (p - a) / (b - a)));
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

let sweepP = 1;   // revealed fraction of the plot; 1 = settled
let sweepRaf = 0; // rAF handle, 0 when no sweep is in flight

function sweepProgress() { return sweepP; }
function sweeping() { return sweepRaf !== 0; }

// sweepX is the reveal's leading edge, in plot coordinates, right now. It runs
// across the VISIBLE band rather than the full plot: both time views scroll, and
// at the default density barely half the plot is on screen (zoomed in, a tenth),
// so pacing the reveal by total width would run the part you can actually see
// off in a fraction of the duration — a flicker instead of a sweep. Whatever
// lies beyond the wrap is simply there when the sweep lands.
function sweepX(W) {
  const left = el.wrap.scrollLeft;
  const band = Math.max(1, Math.min(W, left + el.wrap.clientWidth) - left);
  return left + sweepProgress() * band;
}

// startSweep runs the reveal over `ms`, calling repaint() every frame — the last
// of them with sweeping() already false, which is the renderers' cue to strike
// whatever scaffolding the sweep put up.
function startSweep(ms, repaint) {
  const started = performance.now();
  sweepP = 0;
  const frame = (now) => {
    const linear = Math.min(1, (now - started) / ms);
    sweepP = sweepEase(linear);
    sweepRaf = linear < 1 ? requestAnimationFrame(frame) : 0;
    repaint();
  };
  sweepRaf = requestAnimationFrame(frame);
}

// cancelSweep drops a sweep in flight and settles the progress, so a fast
// double-flip of the view switcher never leaves two tickers painting one chart.
function cancelSweep() {
  if (sweepRaf) cancelAnimationFrame(sweepRaf);
  sweepRaf = 0;
  sweepP = 1;
  moveSweepCurtain(); // settled: strike the sessions curtain if one is still up
}

// armChartEnter starts the entry animation for the view being ENTERED. Call it
// BEFORE the render that draws that view: the time views read the progress while
// drawing, and arming first is what keeps the first frame from flashing the
// finished chart. The projects grow-in is the exception — its CSS class needs
// the rows on the page, so setView stamps that one after the render.
function armChartEnter(view) {
  cancelSweep();
  if (view === "projects" || reduceMotion.matches) return;
  startSweep(SWEEP_MS[view], view === "line" ? repaintAloft : moveSweepCurtain);
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
  const entering = view !== currentView;
  currentView = view;
  try { localStorage.setItem(VIEW_KEY, view); } catch (e) {}
  applyViewClasses(view);
  el.viewSessions.setAttribute("aria-pressed", String(view === "sessions"));
  el.viewLine.setAttribute("aria-pressed", String(view === "line"));
  el.viewProjects.setAttribute("aria-pressed", String(view === "projects"));
  positionViewGlider();
  hideTip();
  if (view !== "sessions") el.empty.hidden = true; // line + projects draw their own empty state
  // Entry animations run only when the view is newly ENTERED — the 3s poll, the
  // zoom, a resize and a theme flip all repaint silently. The time views arm
  // BEFORE the render so it draws at the sweep's opening reveal...
  // While a window is pending, lastData still describes the day we just left,
  // so drawing it here would paint the OUTGOING day under the INCOMING day's
  // label. The skeleton just changes shape to match the new view instead.
  if (win.pending) { renderSkeleton(); return; }
  if (entering) armChartEnter(view);
  if (lastData) renderChartArea(lastData);
  // ...while the projects grow-in arms AFTER it, so the hold is sized to the
  // rows that just landed. Its animation starts when .enter is applied, so
  // stamping it once the rows exist is what makes them all run together.
  if (entering && view === "projects") startProjectsEnter();
}

// applyViewClasses stamps the view on the section AND on the body.
//
// The section class drives everything inside the plot. The body class exists
// because the summary strip is a SIBLING of the plot section rather than a child
// of it, and one thing down there is view-dependent: the cumulative-time box is
// the swimlane KEY — its swatches are the bar colours — so it belongs to the
// sessions view alone. The line chart and the project ranking carry their own
// legends and would otherwise sit beside a key to marks they do not draw.
function applyViewClasses(view) {
  el.section.classList.toggle("view-line", view === "line");
  el.section.classList.toggle("view-projects", view === "projects");
  document.body.classList.toggle("view-line", view === "line");
  document.body.classList.toggle("view-projects", view === "projects");
}

// activeViewButton is the segment standing for the view on screen — the glider's
// target, and where focus follows to when the keyboard drives the switcher.
function activeViewButton() {
  return currentView === "line" ? el.viewLine
    : currentView === "projects" ? el.viewProjects
    : el.viewSessions;
}

// positionViewGlider slides the view switcher's green thumb under the active
// segment. The segments differ in width, so geometry is measured, not styled;
// clientLeft corrects for the container border (offsetLeft spans it, the
// absolutely-positioned glider doesn't).
function positionViewGlider() {
  const btn = activeViewButton();
  el.viewGlider.style.width = btn.offsetWidth + "px";
  el.viewGlider.style.transform = "translateX(" + (btn.offsetLeft - el.viewseg.clientLeft) + "px)";
}

// isTypingTarget reports whether a keystroke belongs to a field the user is
// editing. The BARE keys below are claimed page-wide, but claiming them inside
// a text field or the date input would eat the user's typing (c) or trap focus
// with no way out (Tab), so a field in hand keeps the browser's behavior. Ctrl
// chords are exempt — see handleShortcutKey.
function isTypingTarget(node) {
  if (!node || node.nodeType !== 1) return false;
  if (node.isContentEditable) return true;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

// toggleControl flips a footer checkbox from the keyboard and then lets the
// control's own change listener do the rest — the keymap must not become a
// second place where "what this toggle does" is written down.
//
// Each of these toggles belongs to one view (the 30-min average to the aloft
// chart; focus and context switches to the swimlanes), and a key that silently
// changed something invisible would read as a dead key. So the shortcut takes
// you to the view that owns the toggle, which is what asking to see the thing
// meant in the first place.
function toggleControl(input, owningView) {
  if (currentView !== owningView) setView(owningView);
  input.checked = !input.checked;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

// handleShortcutKey is the page's whole keymap:
//
//   Tab / Shift+Tab   cycle the plot forward / back through the three views
//   Ctrl+← / Ctrl+→   step the window one day back / forward (stops at today)
//   c                 open the date popover
//   3                 toggle the 30-minute average (aloft chart)
//   Shift+C           toggle context switches (swimlanes)
//   Shift+F           toggle the focus overlay (swimlanes)
//   + / -             step the horizontal scale (the views with a time axis)
//   ← / →             pan the time window when the plot scrolls horizontally
//   Shift+T           jump the window back to today
//
// Tab's focus walk is overridden because the three views ARE this page's
// windows. Alt and Meta chords are left alone wholesale — those are the window
// manager's and the OS's — and so is Ctrl+Shift, which is where browsers keep
// their own second tier.
//
// The Ctrl chords fire even from inside a field: they are never text input, so
// nothing is lost by letting them through, and the day arrows stay live
// wherever focus happens to be. Bare keys yield to a field being edited.
function handleShortcutKey(ev) {
  if (ev.defaultPrevented || ev.altKey || ev.metaKey) return;
  const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;

  if (ev.ctrlKey) {
    if (ev.shiftKey) return;
    if (key === "ArrowLeft") { ev.preventDefault(); stepDay(-1); return; }
    if (key === "ArrowRight") { ev.preventDefault(); stepDay(+1); return; }
    return;
  }

  if (isTypingTarget(ev.target)) return;

  // Focus follows the view only when it was already inside the switcher —
  // moving it there from anywhere else would yank the ring across the page on
  // every press.
  if (key === "Tab") {
    ev.preventDefault();
    const focusFollows = el.viewseg.contains(document.activeElement);
    setView(stepView(currentView, ev.shiftKey ? -1 : +1));
    if (focusFollows) activeViewButton().focus();
    return;
  }

  // c opens the calendar; Shift+C is a different key entirely (the swimlanes'
  // context switches), which is why the shift state is read, not ignored.
  if (key === "c") {
    ev.preventDefault();
    if (ev.shiftKey) toggleControl(el.optCtxSwitches, "sessions"); else toggleCalendar();
    return;
  }
  if (key === "f" && ev.shiftKey) { ev.preventDefault(); toggleControl(el.optFocus, "sessions"); return; }
  // Shift+T jumps the window back to today — the live view an operator bails
  // back to after wandering the archive. commitWindow already no-ops when the
  // picker is on today, so the key is idempotent. (Bare t belongs to the
  // calendar popover's own keymap, where it moves the cursor to today.)
  if (key === "t" && ev.shiftKey) { ev.preventDefault(); commitWindow(todayLocal()); return; }
  if (key === "3") { ev.preventDefault(); toggleControl(el.optSmooth, "line"); return; }

  // + / − step the horizontal scale exactly like the footer buttons ("=" is the
  // unshifted + on most layouts). Only the charts that HAVE that option: the
  // projects ranking is time-less and hides the scale pill, so the keys stay
  // inert there rather than silently changing a number nothing is drawn at.
  // The canZoom gates mirror the buttons' disabled state, so a key never does
  // less than the click it stands for appears to.
  if (key === "+" || key === "=" || key === "-") {
    if (currentView === "projects") return;
    ev.preventDefault();
    const geo = scaleNow();
    if (key === "-") {
      if (geo.canZoomOut) setZoom(geo.effective / ZOOM_FACTOR);
    } else if (geo.canZoomIn) {
      setZoom(geo.effective * ZOOM_FACTOR);
    }
    return;
  }

  // ← / → pan the time window when the plot has outgrown its viewport — the
  // zoomed-in state of the two time views. A fifth of the visible band per
  // press: shallow enough to stay oriented, and key repeat makes a held arrow
  // traverse the day quickly. With nothing to scroll (the window fits, or the
  // time-less projects ranking) the keys are left to the browser, so this
  // never shadows a scroll the page itself could want.
  if (key === "ArrowLeft" || key === "ArrowRight") {
    if (currentView === "projects") return;
    const wrap = el.wrap;
    if (wrap.scrollWidth <= wrap.clientWidth) return;
    ev.preventDefault();
    const dx = Math.max(40, wrap.clientWidth * 0.2);
    wrap.scrollLeft += key === "ArrowLeft" ? -dx : dx;
  }
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
function renderTopline(data, op) {
  const attention = graphAwareAttention(data.summary || {}, data.lanes || []);
  const fanout = attention.attention_fanout; // agent-hours, parallelism counted (ns)
  const union = attention.attention_union;   // wall-clock with ≥1 agent active (ns)
  const perSession = attention.attention_per_session; // Σ each session's own active time
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
    title: "Agent hours worked",
    formula: "Σ session active time + Σ subagent spans",
    substitution: `${humanDurationCoarse(perSession)} + ${humanDurationCoarse(subagents)}`,
    result: fanoutStr,
    why: "Total time agents spent working on your behalf, counting parallel sessions and subagents separately. Gross — the cost of delegating is not netted off yet.",
    color: "var(--c-working)",
  });
  const gainedTip = formulaTipHTML({
    title: "Net agent hours",
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
    title: "Force multiplier",
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

// awayIdleTotalNs: Σ idle-while-away across ALL lanes (not just renderable
// ones), because it is subtracted from summary.by_status.idle, which counts
// every lane. 0 without an activity stream — no evidence the operator ever
// left means nothing may be written off as unattended.
function awayIdleTotalNs(data, op) {
  if (!op || !op.hasActivity) return 0;
  let totalMs = 0;
  for (const lane of (data && data.lanes) || []) totalMs += awayIdleMs(lane, op.present);
  return totalMs * 1e6;
}

// renderStatusKey: the time-by-status list doubles as the swimlane legend; show
// every status incl. zeros, in fixed order, then any unknown future statuses.
// Idle is the one status with a carve-out: the share of it during which the
// operator was away (awayIdleNs) is a session parked with nobody waiting on
// anyone, so the idle clock excludes it and a dim "idle (away)" row carries it
// instead, keyed by swatch to the darkened bars on the timeline.
function renderStatusKey(summary, awayIdleNs) {
  const byStatus = summary.by_status || {};
  const seen = new Set(STATUS_ORDER);
  const extra = Object.keys(byStatus).filter((k) => !seen.has(k)).sort();
  const keys = STATUS_ORDER.concat(extra);
  // clamped both ways: the client-side away figure must never drive the idle
  // row negative if a provider's summary and its lanes ever disagree.
  const away = Math.min(Math.max(0, awayIdleNs || 0), byStatus.idle || 0);
  el.statusKey.innerHTML = keys.map((k) => {
    const op = k === "delegating" ? DELEGATING_OPACITY : k === "dormant" ? DORMANT_OPACITY : 1;
    const swatchStyle = `background:${statusColor(k)}` + (op !== 1 ? `;opacity:${op}` : "");
    const splitIdle = k === "idle" && away > 0;
    const shown = splitIdle ? (byStatus[k] || 0) - away : byStatus[k] || 0;
    const tip = formulaTipHTML({
      title: statusLabel(k),
      formula: splitIdle
        ? `Σ time in 'idle' across all sessions − idle while you were away`
        : `Σ time in '${k || "unknown"}' across all sessions`,
      substitution: splitIdle
        ? `${humanDuration(byStatus[k] || 0)} − ${humanDuration(away)}`
        : undefined,
      result: humanDuration(shown),
      why: STATUS_MEANING[k] || "",
      color: statusColor(k),
    });
    const row = `<span class="sk has-tip" data-tip="${escapeHTML(tip)}">
        <span class="sk-left">
          <span class="swatch" style="${swatchStyle}"></span>
          <span class="sk-name">${statusLabel(k)}</span>
        </span>
        <span class="sk-val">${humanDuration(shown)}</span>
      </span>`;
    if (!splitIdle) return row;
    const awayTip = formulaTipHTML({
      title: "Idle (away)",
      formula: "Σ idle time while you were inferred away",
      result: humanDuration(away),
      why: "Sessions parked while you were away from the machine (overnight, typically). Drawn darkened on the timeline and excluded from the idle clock above — nothing was waiting on anyone.",
      color: statusColor("idle"),
    });
    return row + `<span class="sk sk-away has-tip" data-tip="${escapeHTML(awayTip)}">
        <span class="sk-left">
          <span class="swatch" style="background:${statusColor("idle")};opacity:${IDLE_AWAY_OPACITY}"></span>
          <span class="sk-name">Idle (away)</span>
        </span>
        <span class="sk-val">${humanDuration(away)}</span>
      </span>`;
  }).join("");
  attachFormulaTips(el.statusKey);
}

// renderProviderKey: the provider legend, shown for a merged adapter response or
// a semantically mixed Switchboard feed. Each chip shows the provider's accent
// and lane count; a single untagged provider keeps the historical clean header.
function renderProviderKey(lanes) {
  if (!el.providerKey) return;
  const counts = new Map();
  for (const lane of lanes || []) {
    const provider = laneProvider(lane);
    if (!provider) continue;
    counts.set(provider, (counts.get(provider) || 0) + 1);
  }
  // An untagged, single-provider payload keeps the historical clean legend;
  // mixed Claude/Codex data is the new case that needs an explicit key.
  const explicitlyMerged = (lanes || []).some((lane) => !!lane.provider);
  if (counts.size === 0 || (counts.size === 1 && !explicitlyMerged)) {
    el.providerKey.hidden = true;
    el.providerKey.innerHTML = "";
    return;
  }
  const names = [...counts.keys()].sort();
  el.providerKey.hidden = false;
  el.providerKey.innerHTML = names.map((p) =>
    `<span class="pk">
        <span class="pk-dot" style="background:${provColor(p)}"></span>
        <span class="pk-name">${escapeHTML(displayName(p))}</span>
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

// ---- measured text -------------------------------------------------------
// The gutter is a fixed 232px shared by a label on the left and a figure on the
// right, so "how wide is this string" is a layout question, not a guess: a
// per-character estimate that runs one character long puts a project name
// through its own duration. getComputedTextLength is exact but only answers for
// an element already in the document, and these strings are re-measured on
// every ~3s repaint — so measure against an offscreen 2D context using the same
// font stack instead, and memoize. Canvas has no letter-spacing, so the styles
// that set one add it back per character.
const textMeasureCtx = document.createElement("canvas").getContext("2d");
const textWidthCache = new Map();
function textWidth(str, style) {
  if (!str) return 0;
  const { size = 12, weight = 400, spacing = 0 } = style || {};
  const key = size + "/" + weight + "/" + spacing + "/" + str;
  let w = textWidthCache.get(key);
  if (w === undefined) {
    textMeasureCtx.font = `${weight} ${size}px ${MONO}`;
    w = textMeasureCtx.measureText(str).width + spacing * str.length;
    if (textWidthCache.size > 4000) textWidthCache.clear(); // a day's worth of labels, then start over
    textWidthCache.set(key, w);
  }
  return w;
}

// fitText ellipsizes to a PIXEL budget (binary search over the measured width).
// Returns "" when not even one character plus the ellipsis fits, which callers
// read as "there is no room for this at all".
function fitText(str, maxPx, style) {
  if (!str || maxPx <= 0) return "";
  if (textWidth(str, style) <= maxPx) return str;
  let lo = 0, hi = str.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (textWidth(str.slice(0, mid) + "…", style) <= maxPx) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? str.slice(0, lo) + "…" : "";
}

// the SVG type styles these two are asked about, kept next to the CSS rules
// they mirror (.group-label, .name-seg-label).
const GROUP_LABEL_STYLE = { size: 12, weight: 700, spacing: 0.6 };
const NAME_LABEL_STYLE = { size: 12.5, weight: 600, spacing: 0 };

// ---- the frozen gutter ---------------------------------------------------
// The plot scrolls horizontally, and the identity of every row lives in the
// gutter — so scrolling to the afternoon would take the answer to "which
// project is this?" off the left edge with it. Every element left of
// GEO.GUTTER is therefore collected into a SEPARATE svg (#timeline-gutter),
// which a zero-size position:sticky wrapper holds against the scrollport's left
// edge. Same coordinate system as the plot (gutter geometry is already
// 0..GEO.GUTTER), so nothing here had to move but the parent.
//
// It used to be a <g> inside #timeline that this file re-translated from the
// scroll handler. That is one attribute write, but it is an attribute write on
// the parent of a few hundred SVG nodes, and Chrome answers it by
// re-rasterizing all of them — on every wheel tick, ahead of the frame. A
// hundred-lane day stuttered. Sticky is the same picture, computed by the
// compositor, for no script at all.
//
// Nothing else lives there to fight over: the plot's x() clamps every bar to
// x ≥ GEO.GUTTER, so the gutter's opaque backing hides only what scrolled
// behind it.
const GUTTER_SHADOW_W = 10; // the cast edge, drawn past GEO.GUTTER

let gutterLayer = null;
function addGutter(node) { (gutterLayer || el.svg).appendChild(node); }

// openGutter empties the gutter svg (its <defs> stays), sizes it to the plot,
// and returns the layer every addGutter() call posts into.
function openGutter(H) {
  const svg = el.gutterSvg;
  while (svg.childNodes.length > 1) svg.removeChild(svg.lastChild);
  const W = GEO.GUTTER + GUTTER_SHADOW_W;
  svg.setAttribute("width", W);
  svg.setAttribute("height", H);
  svg.style.width = W + "px";
  svg.style.height = H + "px";
  const layer = svgEl("g", { class: "tl-gutter" });
  layer.appendChild(svgEl("rect", { class: "tl-gutter-bg", x: 0, y: 0, width: GEO.GUTTER, height: H }));
  svg.appendChild(layer);
  return layer;
}

// closeGutter caps the column with its cast edge. Called once the plot is drawn
// (the shadow has to be the last thing painted, over the labels as well as the
// bars) — the layer itself needs no re-parenting, since its svg already sits
// above the plot's.
function closeGutter(H) {
  if (!gutterLayer) return;
  gutterLayer.appendChild(svgEl("rect", {
    class: "tl-gutter-shadow", x: GEO.GUTTER, y: 0, width: GUTTER_SHADOW_W, height: H,
    fill: "url(#gutterShadow)",
  }));
}

// clearGutter takes the column off the page (a skeleton, or a window with
// nothing in it) so a stale one cannot sit over the incoming day's rows.
function clearGutter() {
  gutterLayer = null;
  const svg = el.gutterSvg;
  while (svg.childNodes.length > 1) svg.removeChild(svg.lastChild);
  svg.setAttribute("height", 0);
  svg.style.height = "0px";
  syncGutterFreeze();
}

// syncGutterFreeze keeps the cast edge honest: it is what says "this column is
// floating over the plot", so it is only painted once something is actually
// behind it. Called from the scroll handler, and the state is cached — a wheel
// tick that does not cross the 0 boundary touches no DOM at all. The column's
// POSITION is CSS's business now (see .gutter-stick); this no longer moves it.
let gutterScrolled = false;
function syncGutterFreeze() {
  const scrolled = el.wrap.scrollLeft > 0;
  if (scrolled === gutterScrolled) return;
  gutterScrolled = scrolled;
  el.gutterSvg.classList.toggle("scrolled", scrolled);
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
  GUTTER_PAD: 10,   // gutter's own left/right margin
  GROUP_LABEL_X: 24,// group label's left edge (clear of the caret at GUTTER_PAD)
  OP_LANE_H: 52, OP_BAR_H: 20, // operator free-time lane (sits above the groups)
  PX_PER_HOUR: 240, // min horizontal density → long windows scroll (see plotW)
  AXIS_BOTTOM_H: 24,        // bottom axis-scale strip drawn below the plot
  GROUP_COLLAPSED_H: 32,    // height of a folded (too-small) project group summary row
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
  if (win.pending) { renderSkeleton(); updateZoomReadout(); return; }
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
      ? "Already fits the width — nothing left to compress"
      : "Zoom out — compress time (-)";
  }
}

// Project groups fold to a one-line summary when they get too small to read; the
// user can click to override either way. Keyed by project name so the choice
// survives the ~3s repaints. undefined = follow the auto (size-based) default.
const groupCollapseOverride = new Map();
function toggleGroupCollapse(project, currentlyCollapsed) {
  groupCollapseOverride.set(project, !currentlyCollapsed);
  if (lastData && !win.pending) renderTimeline(lastData);
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

// windowBounds resolves the [t0, t1] plot window. The DATA's own extent is the
// summary from/to when present and sane, else the min/max over all interval
// bounds (with a 1ms floor so span is always positive) — and that extent is then
// widened to the whole calendar day on screen (model.js dayWindowMs), so an
// empty morning is drawn as the empty morning it was instead of being cropped
// out of the window. Shared by the bar and line charts so both frame the same
// time window.
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
  // dataT0/dataT1 ride along: the widened window is what gets drawn, but where
  // the work actually starts is what the initial scroll is anchored on.
  return { ...dayWindowMs(dataDay, t0, t1, Date.now()), dataT0: t0, dataT1: t1 };
}

// Initial scroll for a newly framed window. A whole-day window is mostly empty
// canvas at any useful density, so landing at scrollLeft 0 would greet every day
// switch with the small hours. The day in progress parks its live edge at the
// right — that is what you opened the dashboard to look at — and a closed day
// parks the first thing that happened just inside the left edge.
//
// Once per day+view, and never again: a poll repainting under the user must not
// move the viewport, and neither must the user's own scrolling be undone.
const SCROLL_LEAD_PX = 36;
let scrollAnchorKey = null;
function anchorWindowScroll(xOf, firstActivityMs) {
  const key = dataDay + "/" + currentView;
  if (key === scrollAnchorKey) return;
  scrollAnchorKey = key;
  const wrap = el.wrap;
  const max = wrap.scrollWidth - wrap.clientWidth;
  if (max <= 0) return; // the whole window fits: there is nothing to anchor
  wrap.scrollLeft = isLiveWindow()
    ? max
    : Math.min(max, Math.max(0, xOf(firstActivityMs) - SCROLL_LEAD_PX));
  syncGutterFreeze(); // the scroll event is async; the column must not lag a frame
}

// a rule (or background) that spans the whole width is drawn in two halves — the
// gutter's half rides the frozen column, the plot's half scrolls with the bars.
// Splitting beats drawing one wide element under an opaque backing: the backing
// would have to repaint the row striping the element carried.
function addSplitRule(cls, y, W) {
  addGutter(svgEl("line", { class: cls, x1: 0, y1: y, x2: GEO.GUTTER, y2: y }));
  el.svg.appendChild(svgEl("line", { class: cls, x1: GEO.GUTTER, y1: y, x2: W, y2: y }));
}
function addSplitBand(cls, y, height, W, bind) {
  const left = svgEl("rect", { class: cls, x: 0, y, width: GEO.GUTTER, height });
  const right = svgEl("rect", { class: cls, x: GEO.GUTTER, y, width: Math.max(0, W - GEO.GUTTER), height });
  if (bind) { bind(left); bind(right); }
  addGutter(left);
  el.svg.appendChild(right);
}

function renderTimeline(data) {
  const lanes = renderableLanes(data.lanes);
  // keep <defs> (first child), drop the rest
  while (el.svg.childNodes.length > 1) el.svg.removeChild(el.svg.lastChild);
  gutterLayer = null;
  hideTip();

  if (lanes.length === 0) {
    el.empty.hidden = false;
    el.svg.setAttribute("height", 0);
    el.svg.style.height = "0px";
    clearGutter(); // an empty window has no rows to label
    scaleGeo = null; // nothing drawn to fit: the setting stands on its own
    return;
  }
  el.empty.hidden = true;

  const { t0, t1, dataT0 } = windowBounds(data, lanes);
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

  // the frozen column: opened here so every draw below can post its gutter-side
  // half into it, capped with its cast edge once the plot is drawn.
  gutterLayer = openGutter(H);

  // Remember the frame so the NEXT day's skeleton can hold the same shape. A
  // switch then keeps the page's geometry put and only swaps its contents,
  // rather than collapsing to nothing and shoving the footer up the screen.
  lastPlotShape = {
    W, H,
    rows: groups.reduce((acc, g) => acc.concat(g.rows.map((r) => ({ top: r.top, height: r.height }))), []),
  };

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
  // presence for the idle-while-away fade: null (fail open, nothing fades)
  // whenever there is no activity stream to infer absence from.
  const presentGlobal = haveActivity ? op.present : null;
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
  // vertical axis (the gutter's own edge, so it freezes with it) + horizontal
  // baseline under the bottom scale
  addGutter(svgEl("line", { class: "axis-line", x1: GEO.GUTTER, y1: GEO.PLOT_TOP, x2: GEO.GUTTER, y2: plotBottom }));
  el.svg.appendChild(svgEl("line", { class: "axis-line", x1: GEO.GUTTER, y1: plotBottom, x2: GEO.GUTTER + plotW, y2: plotBottom }));

  // context switches (optional, off by default): red verticals at each real
  // (≥0.5s-dwell) switch — toggled via the "show context switches" chart option.
  // Drawn HERE, before the lanes, so the markers sit behind the bars: a burst of
  // switches is exactly when the timeline is busiest, and painting the cluster
  // over the bars made the very stretch it explains unreadable. The row
  // backgrounds above are translucent, so the verticals still read in the open
  // canvas between sessions. The operator lane already carries the switch cost;
  // this is an opt-in overlay.
  if (el.optCtxSwitches && el.optCtxSwitches.checked) {
    for (const t of op.switchTimes) {
      el.svg.appendChild(svgEl("line", {
        class: "ctx-switch", x1: x(t), y1: GEO.PLOT_TOP, x2: x(t), y2: plotBottom,
      }));
    }
  }

  // project group headers: an expanded group gets a rule + caret/label (click to
  // fold); a too-small group gets a single folded summary row instead.
  for (const g of groups) {
    if (g.collapsed) drawCollapsedGroup(g, x, W);
    else drawGroupHeader(g, W);
  }

  drawOperatorLane(op, opTop, x, W);

  for (const g of groups) for (const row of g.rows) {
    drawRow(row, x, W, haveActivity, activeGlobal, presentGlobal);
  }

  closeGutter(H);
  syncGutterFreeze();

  // on view entry, the sweep's curtain rides on top of everything drawn above
  drawSweepCurtain(W, H, GEO.PLOT_TOP, plotBottom);

  anchorWindowScroll(x, dataT0);
}

// The sessions reveal is a CURTAIN, not a clip: one rect in the wrap's own
// background parked over the stretch the sweep hasn't reached, with a hairline
// at its leading edge. Painting over the top costs a single element and leaves
// every draw function above untouched — no clip-path threaded through the whole
// SVG. renderTimeline re-appends it while a sweep is in flight, so a live
// repaint landing mid-reveal doesn't tear it off; the settling frame strikes it.
let sweepCurtain = null;                          // <g>: cover rect + hairline
let sweepGeo = { W: 0, H: 0, top: 0, bottom: 0 }; // from the render being revealed

function drawSweepCurtain(W, H, top, bottom) {
  if (!sweeping()) return;
  if (!sweepCurtain) {
    sweepCurtain = svgEl("g", { class: "tl-sweep", "aria-hidden": "true" });
    sweepCurtain.appendChild(svgEl("rect", { class: "tl-sweep-cover", y: 0 }));
    sweepCurtain.appendChild(svgEl("line", { class: "tl-sweep-edge" }));
  }
  sweepGeo = { W, H, top, bottom };
  el.svg.appendChild(sweepCurtain); // last child, so it covers everything drawn
  moveSweepCurtain();
}

// moveSweepCurtain parks the curtain at the current progress — the sessions
// view's whole per-frame cost — and takes it off the page once the sweep rests.
function moveSweepCurtain() {
  if (!sweepCurtain) return;
  if (!sweeping()) { sweepCurtain.remove(); return; }
  const p = sweepProgress();
  const x = sweepX(sweepGeo.W);
  const cover = sweepCurtain.firstElementChild;
  const edge = sweepCurtain.lastElementChild;
  cover.setAttribute("x", x);
  cover.setAttribute("width", Math.max(0, sweepGeo.W - x));
  cover.setAttribute("height", sweepGeo.H);
  edge.setAttribute("x1", x);
  edge.setAttribute("x2", x);
  edge.setAttribute("y1", sweepGeo.top);
  edge.setAttribute("y2", sweepGeo.bottom);
  edge.setAttribute("opacity", 1 - ramp(p, 0.8, 1)); // out before it runs off the end
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

// groupLabelEl builds a group's gutter label: the project name in the label
// voice, ellipsized to `maxPx`, with the session count trailing it dimmed. The
// count is a tspan of the same <text> so it flows straight off the name however
// short the name was cut — two positioned elements would have to re-measure the
// truncated name to know where the second one starts.
function groupLabelEl(g, y, maxPx) {
  const count = " · " + g.lanes.length;
  const countW = textWidth(count, GROUP_LABEL_STYLE);
  const name = fitText((g.projectFull || g.project).toUpperCase(), maxPx - countW, GROUP_LABEL_STYLE);
  const gl = svgEl("text", { class: "group-label", x: GEO.GROUP_LABEL_X, y });
  gl.textContent = name;
  const c = svgEl("tspan", { class: "group-count" });
  c.textContent = count;
  gl.appendChild(c);
  return gl;
}

// drawGroupHeader draws an EXPANDED group's header: the full-width rule and a
// caret+label in the gutter. The gutter is a click target that folds the group.
function drawGroupHeader(g, W) {
  addSplitRule("group-rule", g.headY + GEO.GROUP_HEAD_H - 3, W);
  const caret = svgEl("text", { class: "group-caret", x: GEO.GUTTER_PAD, y: g.headY + 13 });
  caret.textContent = "▾";
  addGutter(caret);
  // no figure on this row, so the label owns the gutter out to its right margin
  addGutter(groupLabelEl(g, g.headY + 13, GEO.GUTTER - GEO.GUTTER_PAD - GEO.GROUP_LABEL_X));
  // gutter-wide transparent hit target → click folds the group
  const hit = svgEl("rect", { class: "group-hit", x: 0, y: g.headY, width: GEO.GUTTER, height: GEO.GROUP_HEAD_H });
  attachTip(hit, () => `<div class="t-status">${escapeHTML(g.projectFull || g.project)}</div>`
    + `<div class="t-hint">Click to collapse</div>`);
  hit.addEventListener("click", () => toggleGroupCollapse(g.project, false));
  addGutter(hit);
}

// drawCollapsedGroup draws a too-small group folded to one line: caret + label, a
// dim active/cost summary, and sparkbars marking WHEN its sessions ran so the fold
// still conveys placement. The whole strip is a click target that expands it, and
// each sparkbar hovers to the session's identity.
function drawCollapsedGroup(g, x, W) {
  const top = g.headY;
  const midY = top + GEO.GROUP_COLLAPSED_H / 2;
  addSplitRule("group-rule", top, W);

  // background band is the primary click target (labels/sparkbars sit on top)
  addSplitBand("group-collapsed-bg", top, GEO.GROUP_COLLAPSED_H, W, (bg) => {
    bg.addEventListener("click", () => toggleGroupCollapse(g.project, true));
    // the name is the thing this row truncates, so the hover carries it in full
    attachTip(bg, () => `<div class="t-status">${escapeHTML(g.projectFull || g.project)}</div>`
      + `<div class="t-hint">click to expand · ${g.lanes.length} session${g.lanes.length === 1 ? "" : "s"}</div>`);
  });

  const caret = svgEl("text", { class: "group-caret", x: GEO.GUTTER_PAD, y: top + 14 });
  caret.textContent = "▸";
  addGutter(caret);

  let activeMs = 0, cost = 0;
  for (const lane of g.lanes) {
    activeMs += laneActiveMs(lane); // clipped at the evidence bound, like the summary
    if (lane.cost_usd != null) cost += lane.cost_usd;
  }

  // Name over figure, on two lines — the same shape the operator lane's gutter
  // uses, and for the same reason. Side by side in a 232px gutter they fought:
  // "1h 40m · $2.18" is 92px of it, which cut every real project name down to
  // about eight characters (and, before that, simply ran the two strings
  // through each other). Stacked, the name gets the whole width.
  addGutter(groupLabelEl(g, top + 14, GEO.GUTTER - GEO.GUTTER_PAD - GEO.GROUP_LABEL_X));
  const meta = svgEl("text", { class: "group-collapsed-meta", x: GEO.GROUP_LABEL_X, y: top + 26 });
  meta.textContent = `${humanDurationCoarseMs(activeMs)}${cost > 0 ? " · " + fmtUSD(cost) : ""}`;
  addGutter(meta);

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

  addSplitBand("lane-bg op-lane-bg", rowTop, GEO.OP_LANE_H, W);
  // rule along the bottom edge, separating the operator lane from the groups
  addSplitRule("group-rule", rowTop + GEO.OP_LANE_H, W);

  // gutter identity + headline free figure
  const gutter = svgEl("g", { class: "lane-gutter" });
  const main = svgEl("text", { class: "lane-label", x: 10, y: rowTop + 19 });
  main.textContent = "Operator";
  const pct = op.freeFrac == null ? "" : ` · ${Math.round(op.freeFrac * 100)}% of run`;
  const sub = svgEl("text", { class: "lane-sub", x: 10, y: rowTop + 35 });
  sub.textContent = `Free ${humanDurationMs(op.freeMs)}${pct}`;
  gutter.appendChild(main); gutter.appendChild(sub);
  attachTip(gutter, () => operatorTipHTML(op));
  addGutter(gutter);

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
function drawRow(row, x, W, haveActivity, activeGlobal, presentGlobal) {
  const rowTop = row.top;

  // row background (subtle alternation per ROW) + separator (group header rules the top edge)
  addSplitBand(row.idx % 2 ? "lane-bg odd" : "lane-bg", rowTop, row.height, W);
  if (!row.firstInGroup) addSplitRule("lane-sep", rowTop, W);

  for (const lane of row.lanes) drawSession(lane, rowTop, x, haveActivity, activeGlobal, presentGlobal);
}

// drawSession draws ONE session at its own x-range (its lifespan) on a packed
// row: the name-span band (with the cost on its right edge), the status bars, the
// focus overlay, and the subagent sub-bars. Multiple non-overlapping sessions can
// share a row, so this never paints a full-width background (drawRow owns that).
function drawSession(lane, rowTop, x, haveActivity, activeGlobal, presentGlobal) {
  const nameY = rowTop + GEO.PAD_TOP;
  const barY = nameY + GEO.NAME_H;
  const subTop = barY + GEO.BAR_H + GEO.GAP;

  // ---- name-span band: each /name slug labels the stretch it was active; the
  // leading pre-/name stretch falls back to project_full/project (see model.js).
  // The band carries the NAME and nothing else: the session's cost used to ride
  // its right end, which put a column of dollar figures across a view whose
  // subject is time. Cost is one hover (or one click) away instead. ----
  const segs = nameSegments(lane);
  segs.forEach((seg, i) => {
    const sx = x(seg.start), ex = x(seg.end), sw = Math.max(1, ex - sx);
    const isLead = seg.kind === "lead";
    const bg = svgEl("rect", {
      class: "name-seg" + (isLead ? " lead" : ""), x: sx, y: nameY, width: sw, height: GEO.NAME_H, rx: 1,
    });
    bg.setAttribute("data-session", laneIdentity(lane)); // bars are keyed by identity, not name
    attachTip(bg, () => nameSegTipHTML(lane, seg));
    // click pins the session's card. Unconditional: the card always holds the
    // identity and the figures the hover deliberately leaves out, so the pointer
    // cursor on .name-seg is honest for every bar — which it could not be while
    // the card was gated on a digest record that may not exist yet. The handler
    // builds the HTML at click time, so a summary that arrives after the render
    // is picked up without a repaint.
    bg.addEventListener("click", (ev) => {
      ev.stopPropagation();
      pinPopout(sessionPopoutHTML(lane), ev);
    });
    el.svg.appendChild(bg);
    // a dashed divider marks each rename boundary (skip the redundant left edge)
    if (i > 0) el.svg.appendChild(svgEl("line", { class: "name-div", x1: sx, y1: nameY, x2: sx, y2: barY + GEO.BAR_H }));
    if (sw >= GEO.NAME_MIN_W && seg.label) {
      const t = svgEl("text", { class: "name-seg-label" + (isLead ? " lead" : ""), x: sx + 4, y: nameY + 12.5 });
      t.textContent = fitText(seg.label, sw - 8, NAME_LABEL_STYLE);
      el.svg.appendChild(t);
    }
  });

  // ---- main status bars ----
  for (const iv of lane.intervals || []) {
    const start = Date.parse(iv.start);
    const end = Date.parse(iv.end);
    // idle is the one status that splits on operator presence: the stretch you
    // were away for (a session parked overnight) draws darkened, because bright
    // idle orange is a request for attention and nobody was there to ask. With
    // no activity stream, presentGlobal is null and nothing fades — no evidence
    // you ever left. Each piece carries its own tooltip so the away stretch
    // reads with its own bounds and the not-counted note.
    const pieces = iv.status === "idle" && presentGlobal
      ? presenceSplitMs(start, end, presentGlobal) : null;
    if (pieces && pieces.length) {
      for (const p of pieces) {
        const px = x(p.s);
        const attrs = {
          class: "bar", x: px, y: barY, width: Math.max(1, x(p.e) - px),
          height: GEO.BAR_H, rx: 2, fill: statusColor(iv.status),
        };
        if (p.away) attrs["fill-opacity"] = IDLE_AWAY_OPACITY;
        const rect = svgEl("rect", attrs);
        attachTip(rect, () => intervalTipHTML(lane, iv, p));
        el.svg.appendChild(rect);
      }
      continue;
    }
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
  // its semantic data provider in merged or mixed-provider mode. ----
  const dataProvider = laneProvider(lane);
  if (lane.provider || lane.data_provider) {
    const spineX = x(Date.parse(lane.start));
    const spine = svgEl("rect", {
      class: "provider-spine", x: spineX, y: nameY, width: 3,
      height: barY + GEO.BAR_H - nameY, rx: 1, fill: provColor(dataProvider),
    });
    attachTip(spine, () => `<div class="t-status" style="color:${provColor(dataProvider)}">${escapeHTML(displayName(dataProvider))}</div><div class="t-hint">Data provider</div>`);
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

        // Codex child threads carry approval/user-input waits independently of
        // their activity span. Draw those waits on the child bar itself: a red
        // interruption on the main lane cannot say which background thread is
        // asking, while this one can.
        for (const wait of sa.attention || []) {
          if (wait.suspect) continue;
          const ws = Math.max(sa.s, Date.parse(wait.start));
          const we = Math.min(sa.e, Date.parse(wait.end));
          if (!(isFinite(ws) && isFinite(we) && we > ws)) continue;
          const wx = x(ws), ww = Math.max(2, x(we) - wx);
          const overlay = svgEl("rect", {
            class: "subagent-attention " + (wait.reason === "user_input" ? "user-input" : "approval"),
            x: wx, y: ry, width: ww, height: GEO.SUB_ROW_H, rx: 1.5,
          });
          attachTip(overlay, () => subagentAttentionTipHTML(sa, wait));
          overlay.addEventListener("click", (ev) => { ev.stopPropagation(); pinPopout(subagentPopoutHTML(sa), ev); });
          el.svg.appendChild(overlay);
        }
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
    // the wrap's own ground (what the canvas sits on) and the frozen axis's cast
    // edge — both only used by the frozen strip at the end of paint()
    elev: cssVar("--bg-elev", "#111720"),
    shadow: cssVar("--gutter-shadow", "#000000"),
  };

  // window + horizontal scale (reuse the zoom density + scroll like the bars)
  const { t0, t1, dataT0 } = windowBounds(data, lanes);
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
  lastAloftW = W; // so a pending window's skeleton keeps this width

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
  // lastHoverT is remembered so a repaint the USER didn't ask for — a scroll
  // moving the frozen axis — doesn't drop the crosshair they are reading.
  let lastHoverT = null;
  function paint(hoverT) {
    lastHoverT = hoverT;
    ctx.clearRect(0, 0, W, H);

    if (!pts.length) {
      ctx.fillStyle = C.text;
      ctx.font = "12px " + MONO;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("No agent activity for this window.", CGEO.LEFT + plotW / 2, H / 2);
      return;
    }

    // Entry sweep: everything below is drawn clipped to the revealed band, so an
    // unrevealed mark costs nothing to rasterize and the per-pixel smoothing
    // loop can stop at the reveal instead of walking the full width every frame.
    // Settled (reveal 1) the clip is skipped entirely and every path below draws
    // exactly as it always has.
    const reveal = sweepProgress();
    const revealX = reveal < 1 ? sweepX(W) : W; // settled, the whole plot is in
    if (reveal < 1) {
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, revealX, H); ctx.clip();
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
      // sampled only as far as the sweep has come — past the reveal the clip
      // would throw the work away (pxMax is plotW once settled)
      const pxMax = Math.min(plotW, Math.ceil(revealX - CGEO.LEFT));
      ctx.beginPath();
      for (let px = 0; px <= pxMax; px++) {
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
      // the reference settles in behind the trace rather than racing alongside it
      ctx.globalAlpha = ramp(reveal, 0.55, 1);
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = C.avg; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(CGEO.LEFT, yy); ctx.lineTo(CGEO.LEFT + plotW, yy); ctx.stroke();
      ctx.fillStyle = C.avg; ctx.font = "11px " + MONO;
      ctx.textAlign = "left"; ctx.textBaseline = "bottom";
      ctx.fillText("Avg " + prof.avgActive.toFixed(1) + "×", CGEO.LEFT + 6, yy - 3);
      ctx.restore();
    }

    // the sweep's leading hairline — the plotter head, drawn over the unclipped
    // canvas and run out before it reaches the end (mirrors .tl-sweep-edge in
    // the sessions view, which fades on the same ramp)
    if (reveal < 1) {
      ctx.restore(); // reveal clip
      ctx.globalAlpha = 1 - ramp(reveal, 0.8, 1);
      ctx.strokeStyle = C.inst; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(revealX) + 0.5, plotTop);
      ctx.lineTo(Math.round(revealX) + 0.5, plotBottom);
      ctx.stroke();
      ctx.globalAlpha = 1;
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

    // ---- the frozen y-axis ----
    // Same promise the sessions gutter makes: the scale a mark is measured
    // against stays on screen however far into the day you scroll. A canvas has
    // no layer to translate, so the strip is simply painted again — over the top,
    // at the scroll offset — which is why this is the last thing paint() does.
    const dx = Math.max(0, el.wrap.scrollLeft);
    if (dx > 0) {
      const axisX = dx + CGEO.LEFT;
      ctx.save();
      ctx.fillStyle = C.elev;
      ctx.fillRect(dx, 0, CGEO.LEFT, H);
      // cast edge, so the strip reads as floating over the trace behind it
      const grad = ctx.createLinearGradient(axisX, 0, axisX + 10, 0);
      grad.addColorStop(0, C.shadow);
      grad.addColorStop(1, "transparent");
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = grad;
      ctx.fillRect(axisX, 0, 10, H);
      ctx.globalAlpha = 1;

      ctx.font = "11px " + MONO;
      ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillStyle = C.text;
      for (let n = 0; n <= yTop; n += niceIntStep(yTop)) ctx.fillText(String(n), axisX - 8, Y(n));
      ctx.strokeStyle = C.axis; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(axisX + 0.5, plotTop); ctx.lineTo(axisX + 0.5, plotBottom);
      ctx.stroke();
      // the day-average label rides just inside the axis, so it moves with it
      if (prof.avgActive != null) {
        const yy = Math.round(Y(prof.avgActive)) + 0.5;
        ctx.fillStyle = C.avg; ctx.textAlign = "left"; ctx.textBaseline = "bottom";
        ctx.fillText("Avg " + prof.avgActive.toFixed(1) + "×", axisX + 6, yy - 3);
      }
      ctx.restore();
    }
  }

  paint(null);
  chartHover = {
    paint, t0, t1, span, plotW, plotLeft: CGEO.LEFT, prof, levelAt, windowedAvg, smoothOn,
    repaint: () => paint(lastHoverT),
  };
  anchorWindowScroll(X, dataT0);
}

// scheduleAloftFreeze coalesces the scroll-driven repaints that move the frozen
// y-axis to one per frame. The canvas repaint is the same one the crosshair runs
// on every mousemove, so it is cheap — but a scroll fires far denser than a
// frame, and there is no point rasterizing a chart nobody will see.
let aloftFreezeRaf = 0;
function scheduleAloftFreeze() {
  if (aloftFreezeRaf || !chartHover) return;
  aloftFreezeRaf = requestAnimationFrame(() => {
    aloftFreezeRaf = 0;
    if (chartHover && !sweeping()) chartHover.repaint();
  });
}

// repaintAloft re-runs the last render's paint closure, which reads the sweep
// progress on its own — the aloft view's whole per-frame cost during a reveal.
function repaintAloft() { if (chartHover) chartHover.paint(null); }

// updateChartStats fills the line-view caption readout (peak / average / active).
// A null profile is the pending window: the caption keeps its shape (so the
// footer doesn't jump when the numbers arrive) but states nothing.
function updateChartStats(prof) {
  if (!prof) {
    el.chartStats.innerHTML =
        `<span class="cs-item"><span class="cs-k">peak</span><span class="cs-v">—</span></span>`
      + `<span class="cs-item"><span class="cs-k">avg over active</span><span class="cs-v">—</span></span>`
      + `<span class="cs-item"><span class="cs-k">active</span><span class="cs-v">—</span></span>`;
    return;
  }
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
      row.querySelector(".proj-cost").textContent = entry.costUsd == null ? "—" : fmtUSD(entry.costUsd);
    });
    return;
  }

  el.projects.innerHTML = "";
  rows.forEach((entry, i) => {
    const row = document.createElement("div");
    row.className = "proj-row";
    row.style.setProperty("--row-i", String(i)); // stagger key for the grow-in
    // two figures close the row: what it took (time) and what it cost (dollars),
    // in their own columns so each reads down the list as a column of like
    // things. A project whose provider reports no cost holds the column with a
    // dash rather than collapsing it — the ranking must stay a grid.
    row.innerHTML =
        `<span class="proj-name">${escapeHTML(entry.project)}</span>`
      + `<span class="proj-track"></span>`
      + `<span class="proj-hours">${escapeHTML(humanDurationCoarseMs(entry.ms))}</span>`
      + `<span class="proj-cost">${entry.costUsd == null ? "—" : escapeHTML(fmtUSD(entry.costUsd))}</span>`;
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
      // a segment IS a session, so it pins the same card its bar does in the
      // sessions view — the ranking is a way into the day's work, not a dead
      // end you have to go back and find the session for. Built at click time
      // so a summary that lands later needs no repaint.
      seg.addEventListener("click", (ev) => {
        const lane = laneBySessionId(seg._part && seg._part.sessionId);
        if (!lane) return;
        ev.stopPropagation();
        pinPopout(sessionPopoutHTML(lane), ev);
      });
      track.appendChild(seg);
    });
    row._entry = entry;
    row.addEventListener("mousemove", (ev) => showTip(projectTipHTML(row._entry), ev));
    row.addEventListener("mouseleave", hideTip);
    el.projects.appendChild(row);
  });
  lastProjectKeys = keys;
}

// laneBySessionId finds the lane behind a project segment. The ranking carries
// only the bare session id (model.js keeps lane objects out of it), and the
// popout wants the whole lane, so the lookup happens here against the data the
// view was drawn from. Null when the lane is gone — a click on a stale segment
// does nothing rather than pinning an empty card.
function laneBySessionId(id) {
  if (!id || !lastData) return null;
  return (lastData.lanes || []).find((lane) => rawSessionId(lane) === id) || null;
}

// projectTipHTML: hover readout for one project row — the exact (to-the-second)
// duration the coarse row label rounds away, the spend, and then WHAT THE DAY
// ACTUALLY WAS: each contributing session named, with the digest's one-line
// description of what it did. A ranking that can only say "sspi: 2h 24m" makes
// you go and look the day up somewhere else; this row already knows.
const PROJECT_TIP_SESSIONS = 4; // beyond this the hover is a table, not a glance

function projectTipHTML(entry) {
  const n = entry.sessions || 0;
  const cells = [["agent time", humanDurationCoarseMs(entry.ms)], ["sessions", String(n)]];
  if (entry.costUsd != null) cells.push(["cost", fmtUSD(entry.costUsd)]);

  // longest first: on a hover you want the sessions that made the bar, and the
  // parts are stored in temporal order for the STACK, not for reading.
  const byLength = entry.parts.slice().sort((a, b) => b.ms - a.ms);
  const shown = byLength.slice(0, PROJECT_TIP_SESSIONS);
  const rest = byLength.slice(PROJECT_TIP_SESSIONS);
  let list = "";
  for (const part of shown) {
    const sum = part.sessionId ? lastSummaries[part.sessionId] : null;
    list += `<div class="t-histrow"><span>${escapeHTML(humanDurationCoarseMs(part.ms))}</span> `
      + `${escapeHTML(part.label)}</div>`;
    if (sum && sum.description) {
      list += `<div class="t-subdesc">${escapeHTML(sum.description)}</div>`;
    }
  }
  if (rest.length) {
    const restMs = rest.reduce((a, p) => a + p.ms, 0);
    list += `<div class="t-histrow dim"><span>${escapeHTML(humanDurationCoarseMs(restMs))}</span> `
      + `+${rest.length} more session${rest.length === 1 ? "" : "s"}</div>`;
  }

  return `<div class="t-status" style="color:var(--c-working)">${escapeHTML(entry.project)}</div>`
    + `<div class="t-row">${humanDurationMs(entry.ms)} of agent time</div>`
    + railHTML(cells)
    + (list ? `<div class="t-hist">sessions</div>` + list : "");
}

// projectSegTipHTML: hover readout for one session's segment of the stack. Same
// four blocks as the sessions view's glance — name, span, what it did, figures
// — because a segment IS a session, and the two surfaces answering the same
// question differently is how a dashboard stops being trusted. The click
// affordance is honest: pinning needs the lane, which is only there while the
// window that drew the segment is still loaded.
function projectSegTipHTML(entry, part) {
  const sum = part.sessionId ? lastSummaries[part.sessionId] : null;
  const tokens = tokenTotals(sum && sum.tokens);

  const cells = [["agent time", humanDurationCoarseMs(part.ms)]];
  if (part.costUsd != null) cells.push(["cost", fmtUSD(part.costUsd)]);
  if (tokens) cells.push(["tokens out", fmtTokens(tokens.output)]);

  return `<div class="t-name">${escapeHTML((sum && sum.name) || part.label)}</div>`
    + `<div class="t-headline"><span class="t-dur">${humanDurationMs(part.ms)}</span>`
    + `<span class="t-span">${escapeHTML(entry.project)} · ${humanDurationCoarseMs(entry.ms)} total</span></div>`
    + (sum && sum.description ? `<div class="t-desc">${escapeHTML(sum.description)}</div>` : "")
    + railHTML(cells)
    + (laneBySessionId(part.sessionId)
        ? `<div class="t-more">${escapeHTML(summaryHintText(sum))}</div>` : "");
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
  return `<div class="t-status" style="color:${OP_FREE_COLOR}">Operator free time</div>`
    + `<div class="t-row">Free <b>${humanDurationMs(op.freeMs)}</b> · ${pct} of run</div>`
    + `<div class="t-row">Occupied ${humanDurationMs(op.occupiedMs)}</div>`
    + `<div class="t-row">Agents running ${humanDurationMs(op.runningMs)}</div>`
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
  return tipHead(free ? "Free" : "Occupied", free ? OP_FREE_COLOR : "#e5534b",
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
  let html = `<div class="t-row">Memory <b>${fmtBytes(tree)}</b> peak`
    + (mem.avgTreeBytes != null ? ` <span class="dim">${fmtBytes(mem.avgTreeBytes)} avg</span>` : "")
    + `</div>`;
  if (mem.peakSpawnedBytes != null && mem.peakAgentBytes != null) {
    html += `<div class="t-row"><span class="dim">Agent</span> ${fmtBytes(mem.peakAgentBytes)}`
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
  return `<div class="t-row">Machine stalled <b>${humanDurationMs(p.totalStallUs / 1000)}</b>${pct}${head}</div>`;
}

// intervalTipHTML describes one status interval. `piece` (optional) narrows it
// to one presence piece of a split idle interval ({s, e, away} from
// presenceSplitMs): the tooltip then reads with the piece's own bounds, and an
// away piece names itself and says it is off the clock.
function intervalTipHTML(lane, iv, piece) {
  const startMs = piece ? piece.s : Date.parse(iv.start);
  const endMs = piece ? piece.e : Date.parse(iv.end);
  const durMs = endMs - startMs;
  const sub = iv.subagents || 0;
  const away = !!(piece && piece.away);
  const note = iv.status === "delegating" ? " (drawn faded)"
    : iv.status === "dormant" ? " (waiting on subagent)"
    : away ? " (you were away)" : "";
  return tipHead(`${statusLabel(iv.status)}${note}`, statusColor(iv.status),
      `${fmtClock(new Date(startMs).toISOString())} – ${fmtClock(new Date(endMs).toISOString())}`, durMs,
      intervalTaskHTML(lane, startMs, endMs))
    + (sub > 0 ? `<div class="t-sub">${sub} subagent${sub === 1 ? "" : "s"} at start</div>` : "")
    + (away ? `<div class="t-hint">Parked while you were away — not counted as idle clock time</div>` : "")
    + memoryRowsHTML(memoryWindow(lane, lastMemory, startMs, endMs))
    + pressureRowHTML(pressureWindow(lastMemory, startMs, endMs));
}

function subagentTipHTML(sa) {
  const durMs = sa.e - sa.s;
  return `<div class="t-status" style="color:${SUBAGENT_COLOR}">${escapeHTML(sa.agent_type || "subagent")}</div>`
    + (sa.description ? `<div class="t-desc">${escapeHTML(sa.description)}</div>` : "")
    + `<div class="t-row">${fmtClock(sa.start)} – ${fmtClock(sa.end)} · ${humanDurationMs(durMs)}</div>`
    + canonicalAgentStateHTML(sa)
    + subagentWaitSummaryHTML(sa)
    + (sa.suspect ? `<div class="t-suspect">Phantom span — not counted as work<div class="t-suspect-why">${escapeHTML(sa.suspect_reason || "")}</div></div>` : "")
    + `<div class="t-hint">Click to pin</div>`;
}

function canonicalAgentStateHTML(sa, rowClass = "t-row", hintClass = "t-hint") {
  if (!sa || !sa.canonical_agent) return "";
  const state = [sa.runtime || "unknown", sa.attention_state && sa.attention_state !== "none" ? sa.attention_state.replace("_", " ") : "", sa.lifecycle || "unknown"]
    .filter(Boolean).join(" · ");
  const identity = [sa.role, sa.depth > 1 ? `depth ${sa.depth}` : ""].filter(Boolean).join(" · ");
  return `<div class="${rowClass}">${escapeHTML(state)}</div>`
    + (identity ? `<div class="${hintClass}">${escapeHTML(identity)}</div>` : "");
}

function subagentWaitSummaryHTML(sa, rowClass = "t-sub t-sub-wait") {
  const waits = (sa && sa.attention || []).filter((wait) => !wait.suspect);
  if (!waits.length) return "";
  const totals = new Map();
  for (const wait of waits) {
    const start = Date.parse(wait.start), end = Date.parse(wait.end);
    if (!(isFinite(start) && isFinite(end) && end > start)) continue;
    totals.set(wait.reason, (totals.get(wait.reason) || 0) + end - start);
  }
  if (!totals.size) return "";
  const text = [...totals].map(([reason, ms]) => `${String(reason || "attention").replace("_", " ")} ${humanDurationMs(ms)}`).join(" · ");
  return `<div class="${rowClass}">${escapeHTML(text)}</div>`;
}

function subagentAttentionTipHTML(sa, wait) {
  const start = Date.parse(wait.start), end = Date.parse(wait.end);
  const reason = wait.reason === "user_input" ? "User input needed" : "Approval needed";
  return `<div class="t-status" style="color:${statusColor("permission")}">${reason}</div>`
    + `<div class="t-desc">${escapeHTML(sa.agent_type || "Codex agent")}</div>`
    + `<div class="t-row">${fmtClock(wait.start)} – ${fmtClock(wait.end)} · ${humanDurationMs(end - start)}</div>`
    + `<div class="t-hint">Click to pin the child thread record</div>`;
}

// suspectTipHTML explains the hatched tail. The producer's reason string is
// shown verbatim: it distinguishes a live-day ghost ("stretched to now") from a
// session that merely ran across the window bound, and the operator needs to
// tell those apart before trusting or discarding the bar.
function suspectTipHTML(lane) {
  const tail = suspectTailMs(lane);
  const durMs = tail ? tail[1] - tail[0] : 0;
  return `<div class="t-head"><span class="t-status t-status-suspect">Unverified stretch</span>`
    + `<span class="t-dur">${humanDurationMs(durMs)}</span></div>`
    + `<div class="t-suspect-why">${escapeHTML(lane.suspect_reason || "No session end was ever observed")}</div>`
    + `<div class="t-row">Last evidence ${fmtClock(lane.suspect_since)}</div>`
    + `<div class="t-hint">Drawn, but excluded from every total</div>`;
}

function subagentPopoutHTML(sa) {
  const durMs = sa.e - sa.s;
  return `<div class="po-head" style="color:${SUBAGENT_COLOR}">${escapeHTML(sa.agent_type || "subagent")}</div>`
    + (sa.description ? `<div class="po-desc">${escapeHTML(sa.description)}</div>` : "")
    + `<div class="po-row">Duration <b>${humanDurationMs(durMs)}</b></div>`
    + `<div class="po-row">${fmtClock(sa.start)} – ${fmtClock(sa.end)}</div>`
    + canonicalAgentStateHTML(sa, "po-row", "po-row dim")
    + subagentWaitSummaryHTML(sa, "po-row")
    + (sa.canonical_agent && sa.parent_thread_id ? `<div class="po-row dim">Parent ${escapeHTML(sa.parent_thread_id)}</div>` : "")
    + (sa.tool_use_id ? `<div class="po-id">${escapeHTML(sa.tool_use_id)}</div>` : "");
}

// tooltip / popout for a merged sliver cluster ("N subagents" marker).
function subagentClusterTipHTML(cell) {
  const n = cell.members.length;
  let total = 0;
  for (const m of cell.members) total += m.e - m.s;
  const noun = cell.members.every((m) => m.canonical_agent) ? "Codex agents" : "subagents";
  return `<div class="t-status" style="color:${SUBAGENT_COLOR}">${n} ${noun}</div>`
    + `<div class="t-row">${fmtClock(cell.s)} – ${fmtClock(cell.e)} · ${humanDurationMs(total)} total</div>`
    + `<div class="t-hint">Too thin to separate — click to list</div>`;
}

function subagentClusterPopoutHTML(cell) {
  const n = cell.members.length, cap = 12;
  const rows = cell.members.slice(0, cap).map((m) =>
    `<div class="po-row">${escapeHTML(m.agent_type || "subagent")} <b>${humanDurationMs(m.e - m.s)}</b> <span class="dim">${fmtClock(m.s)}</span></div>`
  ).join("");
  const more = n > cap ? `<div class="po-row dim">+${n - cap} more</div>` : "";
  const noun = cell.members.every((m) => m.canonical_agent) ? "Codex agents" : "subagents";
  return `<div class="po-head" style="color:${SUBAGENT_COLOR}">${n} ${noun}</div>`
    + `<div class="po-desc">Merged — each too thin to draw separately at this scale</div>`
    + rows + more;
}

// railHTML lays a few one-figure cells across the foot of a hover: the topline's
// value-over-key block at tooltip scale, so a glance at a bar reads in the same
// voice as a glance at the day. Three at most — a fourth wraps, and a wrapped
// rail is a table again, which is the thing this replaced.
function railHTML(cells) {
  if (!cells.length) return "";
  return `<div class="t-rail">` + cells.slice(0, 3).map(([k, v]) =>
    `<div class="t-cell"><span class="t-cell-v">${escapeHTML(v)}</span>`
    + `<span class="t-cell-k">${escapeHTML(k)}</span></div>`).join("") + `</div>`;
}

// nameSegTipHTML is the session GLANCE: what this bar is, how long it ran, what
// it was doing, and three figures. It answers the question a pointer asks —
// "what am I looking at?" — and stops there.
//
// It used to answer every question at once: the operator-inefficiency line, four
// rows of token accounting, two of memory, the provider/agent/pid footer and a
// raw session UUID, stacked under the description. Those are things you go and
// ASK, not things you should have to read past, so they moved behind the click,
// where a card has the room to lay them out (sessionPopoutHTML). What stays here
// is what a cursor sweeping the day can actually absorb.
function nameSegTipHTML(lane, seg) {
  const sum = sessionSummary(lane);
  const durMs = seg.end - seg.start;
  const ineff = spanInefficiency(lane, seg.start, seg.end);
  const tokens = tokenTotals(sum && sum.tokens);

  const cells = [];
  if (lane.cost_usd != null) cells.push(["cost", fmtUSD(lane.cost_usd)]);
  if (tokens) cells.push(["tokens out", fmtTokens(tokens.output)]);
  if (ineff != null) cells.push(["idle", Math.round(ineff * 100) + "%"]);

  return `<div class="t-name">${escapeHTML(seg.label || "(unnamed)")}`
    + (seg.kind === "lead" ? `<span class="t-note">pre-/name</span>` : "")
    + `</div>`
    + `<div class="t-headline"><span class="t-dur">${humanDurationMs(durMs)}</span>`
    + `<span class="t-span">${fmtClock(seg.start)} → ${fmtClock(seg.end)}</span></div>`
    // a record may carry token counts and no summary, so the description is
    // gated on itself rather than on the record existing
    + (sum && sum.description ? `<div class="t-desc">${escapeHTML(sum.description)}</div>` : "")
    + railHTML(cells)
    + (lane.suspect ? `<div class="t-suspect">Unverified stretch — excluded from every total</div>` : "")
    + `<div class="t-more">${escapeHTML(summaryHintText(sum))}</div>`;
}

// figGridHTML renders [key, value] pairs as the card's reading table: dim key
// left, mono figure right, one fact per row. A grid rather than the tooltip's
// prose rows because a card is READ rather than glanced at — the values line up
// in a column, so "what did this cost / how big did it get" is a scan down one
// edge instead of a hunt through sentences.
function figGridHTML(figs) {
  if (!figs.length) return "";
  // a key prefixed with "·" is a breakdown of the row above it (the memory
  // split), and indents rather than reading as a figure of its own
  return `<div class="po-figs">` + figs.map(([k, v]) => {
    const sub = k.startsWith("· ");
    return `<div class="po-fig-k${sub ? " sub" : ""}">${escapeHTML(sub ? k.slice(2) : k)}</div>`
      + `<div class="po-fig-v${sub ? " sub" : ""}">${v}</div>`;
  }).join("") + `</div>`;
}

const poSection = (label) => `<div class="po-sec">${escapeHTML(label)}</div>`;

// sessionPopoutHTML is the pinned card for a session bar — the dossier the
// glance points at. Every bar pins one: the identity (provider, agent, pid, the
// session UUID), the full token accounting, the memory high-water marks, what
// the machine was doing underneath, and — when session-digest has reached this
// session — its archival name, its steps and its narrative.
//
// It is deliberately unconditional. The old card was gated on the digest having
// written prose, which left a just-started session's pid and token spend
// reachable nowhere at all once the hover stopped carrying them; and the gate
// bought a hover that had to advertise the click honestly, which is now simply
// always true.
function sessionPopoutHTML(lane) {
  const sum = sessionSummary(lane);
  const startMs = Date.parse(lane.start), endMs = Date.parse(lane.end);
  const tokens = tokenTotals(sum && sum.tokens);
  const mem = laneMemory(lane, lastMemory);
  const press = pressureWindow(lastMemory, startMs, endMs);
  const ineff = spanInefficiency(lane, startMs, endMs);

  const figs = [];
  if (lane.cost_usd != null) figs.push(["Cost", `<b>${fmtUSD(lane.cost_usd)}</b>`]);
  if (ineff != null) figs.push(["Operator idle", `${Math.round(ineff * 100)}% <span class="dim">idle / waiting</span>`]);
  if (tokens) {
    figs.push(["Tokens", `<b>${fmtTokens(tokens.output)}</b> out · <b>${fmtTokens(tokens.billedInput)}</b> in`]);
    figs.push(["Cache", `${fmtTokens(tokens.cacheRead)} read · ${fmtTokens(tokens.cacheCreation)} written`]);
    figs.push(["Peak context", `${fmtTokens(tokens.peakContext)} <span class="dim">over ${tokens.responses} turn${tokens.responses === 1 ? "" : "s"}</span>`]);
    if (tokens.delegatedOutput > 0) {
      figs.push(["Delegated", `${fmtTokens(tokens.delegatedOutput)} out <span class="dim">over ${tokens.delegatedResponses} turn${tokens.delegatedResponses === 1 ? "" : "s"}</span>`]);
    }
    if (tokens.models.length > 1) {
      figs.push(["Models", tokens.models.map((m) => `${escapeHTML(m.label)} ${fmtTokens(m.output)}`).join(" · ")]);
    }
  }
  if (mem) {
    const tree = mem.peakTreeBytes != null ? mem.peakTreeBytes : mem.peakAgentBytes;
    if (tree != null) {
      figs.push(["Memory", `<b>${fmtBytes(tree)}</b> peak`
        + (mem.avgTreeBytes != null ? ` <span class="dim">${fmtBytes(mem.avgTreeBytes)} avg</span>` : "")]);
    }
    // only when the provider reports the split — a container total has no inner
    // boundary, and a fabricated 0 for subagents would read as "delegated nothing"
    if (mem.peakSpawnedBytes != null && mem.peakAgentBytes != null) {
      figs.push(["· Agent / spawned", `${fmtBytes(mem.peakAgentBytes)} · ${fmtBytes(mem.peakSpawnedBytes)}`]);
    }
  }
  if (press && press.totalStallUs > 0) {
    const pct = press.stallFraction != null
      ? ` <span class="dim">${(Math.min(1, press.stallFraction) * 100).toFixed(1)}% of the session</span>` : "";
    figs.push(["Machine stalled", humanDurationMs(press.totalStallUs / 1000) + pct]);
  }

  const idBits = [];
  const dataProvider = laneProvider(lane);
  if (dataProvider) idBits.push(dataProvider);
  if (lane.agent && lane.agent !== dataProvider) idBits.push(lane.agent);
  if (lane.pid != null) idBits.push("pid " + lane.pid);

  const body = summaryBodyHTML(sum);
  return `<div class="po-head">${escapeHTML((sum && sum.name) || currentName(lane) || "(unnamed)")}</div>`
    + `<div class="po-headline"><span class="po-dur">${humanDurationMs(endMs - startMs)}</span>`
    + `<span class="po-span">${fmtClock(lane.start)} → ${fmtClock(lane.end)}</span></div>`
    + (sum && sum.description ? `<div class="po-desc">${escapeHTML(sum.description)}</div>` : "")
    + (lane.suspect
        ? `<div class="po-suspect">Unverified stretch to ${fmtClock(lane.end)} — drawn, but excluded from every total`
          + `<div class="po-suspect-why">${escapeHTML(lane.suspect_reason || "No session end was ever observed")}</div></div>`
        : "")
    + (body ? poSection(summaryTasks(sum).length ? "what it did" : "narrative") + body : "")
    + (figs.length ? poSection("figures") + figGridHTML(figs) : "")
    + poSection("identity")
    + `<div class="po-id">${escapeHTML(idBits.join(" · "))}</div>`
    + (lane.session_id ? `<div class="po-id">${escapeHTML(lane.session_id)}</div>` : "");
}

// gutterTipHTML identifies a session from a folded group's sparkbar — the one
// surface with no card behind it (a click there expands the group instead), so
// it carries the name-span history the session bar's hover leaves out. Same four
// blocks as the glance otherwise: a folded row is still a hover, not a table.
function gutterTipHTML(lane, name) {
  const sum = sessionSummary(lane);
  const startMs = Date.parse(lane.start), endMs = Date.parse(lane.end);
  const tokens = tokenTotals(sum && sum.tokens);

  const cells = [];
  if (lane.cost_usd != null) cells.push(["cost", fmtUSD(lane.cost_usd)]);
  if (tokens) cells.push(["tokens out", fmtTokens(tokens.output)]);

  let html = `<div class="t-name">${escapeHTML(name)}</div>`
    + `<div class="t-headline"><span class="t-dur">${humanDurationMs(endMs - startMs)}</span>`
    + `<span class="t-span">${fmtClock(lane.start)} → ${fmtClock(lane.end)}</span></div>`
    + (sum && sum.description ? `<div class="t-desc">${escapeHTML(sum.description)}</div>` : "")
    + railHTML(cells);
  if (lane.suspect) {
    html += `<div class="t-suspect">Unverified stretch to ${fmtClock(lane.end)}`
      + `<div class="t-suspect-why">${escapeHTML(lane.suspect_reason || "")}</div></div>`;
  }
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

  const effTip = tip({
    title: "Delegation effectiveness",
    formula: "delegated ÷ (delegated + attended + prompt)",
    substitution: da == null && aa == null && pa == null ? null
      : `${humanDuration(da || 0)} ÷ (${humanDuration(da || 0)} + ${humanDuration(aa || 0)} + ${humanDuration(pa || 0)})`,
    result: effPct == null ? "—" : effPct + "%",
    why: "Share of your agent engagement that ran hands-off rather than with you at the window — higher = more leverage. AGENT-HOURS, summed per session: two agents working unattended for an hour count two hours. That is why it is not the green share of the wall-clock bar below, which counts that same hour once.",
    color: effColor,
  });
  const ctxTip = tip({
    title: "Context switches",
    formula: "focus arrivals − 1",
    substitution: op ? `${op.switches + 1} − 1` : null,
    result: op ? String(op.switches) : "—",
    why: "How many times you moved your attention between sessions.",
    color: "var(--c-permission)",
  });
  const recovStr = humanDurationMs(OP.switchRecoveryMs);
  const lostTip = tip({
    title: "Operator time lost to AI",
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

  const wallBlock = wallSplitHTML(op);
  const shapeBlock = freeShapeHTML(op);

  // The switching cost rides in the headline's right half rather than under it.
  // It is the counterweight to the big percentage — what the leverage cost you —
  // and the headline row was empty air anyway. Coarse durations: this is 90s ×
  // switches with the overlaps merged out, an estimate, and quoting it to the
  // second would dress an estimate up as a measurement.
  const opBox = `
    <div class="switch-cost">
      <div class="sc-head">switching cost</div>
      <div class="sc-row has-tip" data-tip="${ctxTip}">
        <span class="sc-v">${op ? op.switches : "—"}</span>
        <span class="sc-k">Context switches</span>
      </div>
      <div class="sc-row has-tip" data-tip="${lostTip}">
        <span class="sc-v">${op ? humanDurationCoarseMs(op.lostMs) : "—"}</span>
        <span class="sc-k">Lost re-focusing</span>
      </div>
    </div>`;

  el.cardAttention.innerHTML = `
    <div class="card-label">attention &amp; delegation</div>
    <div class="attn-top">
      <div class="headline has-tip" data-tip="${effTip}">
        <div class="hv" style="color:${effColor}">${haveDeleg && effPct != null ? effPct + "%" : "—"}</div>
        <div class="hk">Delegation effectiveness</div>
        <div class="hsub">Share of agent-hours that ran without you</div>
      </div>
      ${opBox}
    </div>

    ${wallBlock}

    ${shapeBlock}
    ${suspectNoteHTML(summary)}`;

  attachFormulaTips(el.cardAttention);
  layoutFreeBlocks(el.cardAttention); // percentages cannot land on whole pixels; this can
}

// ---------------------------------------------------------------------------
// the wall clock while the agents ran
//
// This used to be the provider's engagement split — delegated / attended /
// prompt — and those are AGENT-HOURS: summed per session, so on a day with two
// agents running in parallel they add to more hours than the day has. As a
// proportion bar that is a category error. You cannot look at "21h delegated"
// and learn anything about your afternoon.
//
// So the bar is the operator's own wall clock now: the running window (≥1 agent
// working) partitioned four ways, disjoint, summing to exactly the hours that
// elapsed. What you were doing in each of them is the reading:
//
//   work blocks  agents running, nobody waiting on you — the hours the plot
//                below chops into sizes
//   prompting    at an agent window, typing
//   supervising  at an agent window, hands off the keys
//   re-focusing  inside a switch's recovery window and NOT at a window — the
//                part of the switch tax the other three don't already account
//                for (the box above quotes the whole of it)
//
// The delegation-effectiveness headline above is still agent-hours, and says so:
// the two answer different questions and would otherwise look like the same
// question answered twice with different numbers.
// ---------------------------------------------------------------------------
function wallSplitHTML(op) {
  const head = (right) =>
    `<div class="kv-head fs-head"><span class="fs-head-l">while the agents ran`
    + `<span class="fs-head-gloss"> · your wall clock</span></span>`
    + `<span class="fs-head-r">${right}</span></div>`;

  // No focus stream ⇒ attending and recovery are 0 for lack of evidence, and the
  // bar would report a day spent entirely in work blocks. Refused, not drawn.
  if (!op || !op.hasAttention || !(op.runningMs > 0)) {
    return `<div class="wall">${head("")}`
      + `<div class="kv muted-note">No focus stream for this window — your wall clock can't be split</div></div>`;
  }

  const tip = (obj) => escapeHTML(formulaTipHTML(obj));
  const total = op.runningMs;
  // Without an activity stream there is no evidence of typing, so prompting
  // would read as a flat zero and supervising would absorb it. Merged instead,
  // and the descriptor says why.
  const split = op.hasActivity
    ? [
        { k: "Prompting", g: "you typing", ms: op.promptMs, c: "var(--accent)",
          f: "at an agent window ∩ keyboard/mouse activity",
          w: "Hands-on time: you were at the window and typing." },
        { k: "Supervising", g: "watching a window", ms: op.superviseMs, c: "var(--c-idle)",
          f: "at an agent window, minus typing",
          w: "You were at an agent window with your hands off the keys — reading a diff, watching it work. Useful, but it is not leverage." },
      ]
    : [
        { k: "At a window", g: "supervising or prompting", ms: op.promptMs + op.superviseMs, c: "var(--c-idle)",
          f: "focused on an agent window while present",
          w: "No activity stream for this window, so watching and typing can't be told apart — they are reported together." },
      ];
  const atWindow = Math.max(0, op.lostMs - op.refocusMs); // recovery spent at a window
  const parts = [
    { k: "Work blocks", g: "you elsewhere", ms: op.freeMs, c: "var(--c-working)",
      f: "running − attending − re-focusing",
      w: "Agents running and nobody waiting on you: the hours you could spend on your own work. The plot below is this slice, chopped into the sizes it actually arrived in." },
    ...split,
    { k: "Re-focusing", g: "away from a window", ms: op.refocusMs, c: "var(--c-refocus)",
      f: `⋃ ${humanDurationMs(OP.switchRecoveryMs)} recovery per switch, merged, ∩ running − attending`,
      w: `Still paying for a context switch, and not at an agent window while paying. The switching-cost box counts the whole recovery window (${humanDurationMs(op.lostMs)}); the other ${humanDurationMs(atWindow)} of it you spent at a window, and it is counted there rather than twice.` },
  ];

  const pctOf = (ms) => Math.round((ms / total) * 100);
  const seg = (p) => (p.ms > 0
    ? `<span class="sb-seg" style="width:${((p.ms / total) * 100).toFixed(3)}%;background:${p.c}"></span>` : "");
  const rowTip = (p) => tip({
    title: p.k,
    formula: p.f,
    substitution: `${humanDurationMs(p.ms)} ÷ ${humanDurationMs(total)}`,
    result: `${pctOf(p.ms)}% · ${humanDurationMs(p.ms)}`,
    why: p.w,
    color: p.c,
  });
  const rows = parts.map((p) =>
    `<div class="kv has-tip" data-tip="${rowTip(p)}">`
    + `<span class="k"><span class="dot-k" style="background:${p.c}"></span>${p.k}`
    + `<span class="dim"> · ${p.g}</span></span>`
    + `<span class="v">${humanDurationMs(p.ms)} <span class="dim">${pctOf(p.ms)}%</span></span></div>`).join("");

  const aria = "your wall clock while the agents ran: "
    + parts.map((p) => `${p.k} ${pctOf(p.ms)}%`).join(", ");
  return `<div class="wall">`
    + head(humanDurationMs(total))
    + `<div class="split-bar" role="img" aria-label="${escapeHTML(aria)}">${parts.map(seg).join("")}</div>`
    + `<div class="kv-list">${rows}</div>`
    + `</div>`;
}

// ---------------------------------------------------------------------------
// WORK BLOCKS: the bar above says how much of the wall clock you got back while
// the agents ran; this says what shape it arrived in — every uninterrupted block
// ranked longest to shortest, coloured by how usable its length made it.
//
// It is the same slice of time, twice: the green segment of the proportion bar
// is this plot's whole width. Sixty one-minute gaps and four fifteen-minute
// blocks are the same hour on every total in this dashboard, and they are not
// the same hour — only one of them is time you could have started something in.
//
// One bar per block, ranked longest first, widths carrying TIME — so the row
// laid end to end is the whole of the block time, and any run of it is a share
// of that total. Rank order is what makes the four length buckets CONTIGUOUS:
// each is a single stretch of the track, which is what lets a BRACKET under it
// carry that bucket's percentage — the number is attached to the bars it is
// about rather than parked in a legend you have to match colours against.
//
// AREA IS TIME, and only width is allowed to carry it. Height is constant, which
// looks like a missed opportunity for a decay curve and is not: scaling height by
// length too would make every area ∝ time², drawing the longest block at forty
// times the ink of one a sixth its length. The eye reads area whether or not you
// meant it to, so the one quantity this plot is about gets exactly one channel.
//
// COLOUR carries usability, and it is one hue in four steps, not a ramp across
// hues. Red and amber are spoken for on this page — they mean permission-blocked
// and idle everywhere else you look — so a red→green fragmentation ramp said
// "your short blocks are permission-blocked", which is not a thing. Every block
// here is a work block and work blocks are green; the question is only how much
// of one you could spend, and that is brightness: an hour-plus block is the
// brightest green on the page and a sub-five-minute gap is a dark, half-dissolved
// one.
// ---------------------------------------------------------------------------

// A bucket stops drawing one bar per block and becomes one combed segment when
// it has more blocks than FREE_BUCKET_MAX_BARS, or when it has at least
// FREE_COMB_MIN_BLOCKS of them AND its smallest would come out under
// FREE_MIN_BAR_SHARE of the track. Sixty sub-pixel bars against a pixel grid is
// a moiré rather than a reading — the browser renders that shimmer identically
// whether the day had forty gaps or eighty — so the comb says "many small
// things" at a fixed pitch and the legend underneath carries the count the
// texture deliberately does not encode.
//
// The count floor is what keeps that honest, and it is not a nicety: the comb's
// pitch is fixed, so a two-block bucket drawn as a comb showed a picket fence of
// twenty teeth and read as a shredded day. A comb may only be reached for when
// "many" is TRUE. Below the floor the blocks are drawn as bars however thin they
// are — layoutFreeBlocks holds them at a hoverable minimum, and the couple of
// pixels that costs is borrowed from the widest bar, where it does not show.
const FREE_BUCKET_MAX_BARS = 14;
const FREE_COMB_MIN_BLOCKS = 6;
const FREE_MIN_BAR_SHARE = 0.9; // % of the track; ≈5px on a typical card

function freeShapeHTML(op) {
  const head = (right) =>
    `<div class="kv-head fs-head"><span class="fs-head-l">work blocks`
    + `<span class="fs-head-gloss"> · that slice, by size</span></span>`
    + `<span class="fs-head-r">${right}</span></div>`;

  // No focus stream ⇒ "occupied" is 0 for lack of evidence, so every running
  // stretch would read as one long uninterrupted block. That is a fabrication
  // with a flattering shape, so it is refused rather than drawn.
  if (!op || !op.hasAttention) {
    return `<div class="freeshape">${head("")}`
      + `<div class="kv muted-note">No focus stream for this window — the blocks can't be sized</div></div>`;
  }
  const s = freeBlockStats(op.free);
  if (!s.count) {
    return `<div class="freeshape">${head("")}`
      + `<div class="kv muted-note">No work blocks — you were with the agents the whole time they ran</div></div>`;
  }

  const tip = (obj) => escapeHTML(formulaTipHTML(obj));

  // Widths are computed from durations rounded to the NEAREST MINUTE, not from
  // raw milliseconds. A minute is the resolution this plot can actually express
  // — at a typical track a minute is a couple of pixels — so seconds below it
  // only ever showed up as two bars differing by a hair for no reason the eye
  // could use. Rounding first means bars that LOOK equal ARE equal, in the unit
  // the figures beside them are quoted in.
  //
  // The tooltips still carry the exact duration: this is the drawing's
  // resolution, not a loss of the underlying number.
  const MINUTE_MS = 60e3;
  const drawMs = (ms) => Math.max(MINUTE_MS, Math.round(ms / MINUTE_MS) * MINUTE_MS);
  // Shares are relative, and layoutFreeBlocks renormalises by their sum, so
  // rounding the parts without rounding the whole cannot drift the row off the
  // track — it just moves a pixel or two between neighbours.
  const pctOfTime = (ms) => (s.totalMs > 0 ? (drawMs(ms) / s.totalMs) * 100 : 0);

  const { buckets } = freeBucketStats(s.blocksMs);
  const pctOf = (frac) => (frac == null ? null : Math.round(frac * 100));

  // Fold decision is per BUCKET, not across the whole row: the buckets are what
  // the reader is counting up, so a fold must never move time from one into
  // another. Inside a bucket it is bars or a comb, never both.
  const segs = [];
  let slackKey = null, slackMs = -1;
  for (const b of buckets) {
    if (!b.count) continue;
    const thinnest = pctOfTime(b.blocksMs[b.blocksMs.length - 1]);
    const fold = b.count > FREE_BUCKET_MAX_BARS
      || (b.count >= FREE_COMB_MIN_BLOCKS && thinnest < FREE_MIN_BAR_SHARE);
    const first = segs.length === 0 ? "" : " bstart";
    if (fold) {
      if (b.ms > slackMs) { slackMs = b.ms; slackKey = b.key; }
      segs.push(`<span class="fb-b fb-${b.key} comb${first} has-tip"`
        + ` data-tip="${tip(bucketTip(b, s))}" data-bucket="${b.key}"`
        + ` data-share="${pctOfTime(b.ms).toFixed(4)}"></span>`);
      continue;
    }
    b.blocksMs.forEach((ms, i) => {
      const t = tip({
        title: `${humanDurationMs(ms)} · ${b.label}`,
        formula: "One uninterrupted stretch with no agent waiting on you",
        substitution: `block ${i + 1} of ${b.count} in this bucket · ${s.count} in the day`,
        result: humanDurationMs(ms),
        why: b.gloss.charAt(0).toUpperCase() + b.gloss.slice(1) + " — " + b.note + ".",
        color: `var(--fb-${b.key})`,
      });
      segs.push(`<span class="fb-b fb-${b.key}${i === 0 ? first : ""} has-tip" data-tip="${t}"`
        + ` data-bucket="${b.key}" data-share="${pctOfTime(ms).toFixed(4)}"></span>`);
    });
  }
  // data-slack: one segment absorbs the whole-pixel rounding, so every other bar
  // can round independently and equal minutes stay equal on screen. The widest
  // combed bucket is where a pixel means least; with no comb, layoutFreeBlocks
  // shaves the widest bars instead.
  if (slackKey) {
    const i = segs.findIndex((h) => h.includes(`data-bucket="${slackKey}"`));
    if (i >= 0) segs[i] = segs[i].replace(" data-share=", ' data-slack="1" data-share=');
  }

  // The key is the point of the plot, and every proportion in it is ATTACHED to
  // the stretch of track it describes: one bracket per bucket, spanning exactly
  // that bucket's bars (layoutFreeBlocks sets the pixels), with the percentage
  // underneath it. A four-cell legend in even columns would have made the reader
  // match colours to find which run of bars a number was about; a bracket points
  // at it. Empty buckets get no bracket — there is nothing to point at.
  const key = buckets.filter((b) => b.count).map((b) => {
    return `<span class="fbk has-tip" data-bucket="${b.key}" data-tip="${tip(bucketTip(b, s))}">`
      + `<span class="fbk-rule"></span>`
      + `<span class="fbk-lab"><span class="fbk-inner">`
      + `<span class="fbk-line"><span class="fbk-sw fb-${b.key}"></span>`
      + `<b>${pctOf(b.frac)}%</b><span class="fbk-w"> in</span>`
      + ` <span class="fbk-range">${b.label}</span><span class="fbk-w"> blocks</span></span>`
      + `<span class="fbk-sub">${humanDurationCoarseMs(b.ms)} · ${b.count} block${b.count === 1 ? "" : "s"}</span>`
      + `</span></span></span>`;
  }).join("");

  // The usable share is the one figure here that survives being quoted on its
  // own — it is the top two buckets added up, which is exactly the reading the
  // legend invites — so it leads the footer and carries the colour.
  const deepStr = humanDurationCoarseMs(FREE_BLOCK_DEEP_MS);
  const deepPct = s.deepFrac == null ? null : Math.round(s.deepFrac * 100);
  const deepColor = deepPct == null ? "var(--fg-muted)"
    : deepPct >= 66 ? "var(--c-working)" : deepPct >= 33 ? "var(--c-idle)" : "var(--c-permission)";

  const foot = (label, valHTML, tipObj) =>
    `<span class="fs-foot-i has-tip" data-tip="${tip(tipObj)}">${valHTML}`
    + `<span class="fs-foot-k">${label}</span></span>`;
  const footer =
      foot("usable", `<b style="color:${deepColor}">${deepPct == null ? "—" : deepPct + "%"}</b>`, {
        title: `Usable · blocks ≥ ${deepStr}`,
        formula: `Σ blocks ≥ ${deepStr} ÷ all block time`,
        substitution: `${humanDurationCoarseMs(s.deepMs)} ÷ ${humanDurationCoarseMs(s.totalMs)}`,
        result: (deepPct == null ? "—" : deepPct + "%")
          + ` · ${s.deepCount} block${s.deepCount === 1 ? "" : "s"}`,
        why: `The top two buckets added up: the share that arrived in stretches long enough to start something in. This is the figure a bare total hides — the same ${humanDurationCoarseMs(s.totalMs)} can be 90% usable or 9%.`,
        color: deepColor,
      })
    + foot("longest", `<b>${humanDurationCoarseMs(s.longestMs)}</b>`, {
        title: "Longest block",
        formula: "max uninterrupted stretch",
        result: humanDurationMs(s.longestMs),
        why: "The best single run the day gave you.",
      })
    + foot("median", `<b>${humanDurationCoarseMs(s.medianMs)}</b>`, {
        title: "Median block",
        formula: "middle block by length",
        substitution: `${s.count} blocks · mean ${humanDurationCoarseMs(s.meanMs)}`,
        result: humanDurationMs(s.medianMs),
        why: "The typical block. Median, not mean — one three-hour stretch would otherwise speak for a day of one-minute gaps.",
      });

  const aria = `work blocks by length: `
    + buckets.map((b) => `${b.label} ${b.count ? pctOf(b.frac) + "%" : "none"}`).join(", ");
  return `<div class="freeshape">`
    + head(`${s.count} block${s.count === 1 ? "" : "s"} · ${humanDurationCoarseMs(s.totalMs)}`)
    + `<div class="fb" role="img" aria-label="${escapeHTML(aria)}">`
    + `<div class="fb-bars">${segs.join("")}</div>`
    + `</div>`
    + `<div class="fb-key">${key}</div>`
    + `<div class="fs-foot">${footer}</div>`
    + `</div>`;
}

// bucketTip: the descriptor behind both a bucket's bracket and its combed
// segment — one definition, so the two can never say different things.
function bucketTip(b, s) {
  const pct = b.frac == null ? null : Math.round(b.frac * 100);
  const range = b.maxMs === Infinity ? `≥ ${humanDurationCoarseMs(b.minMs)}`
    : b.minMs === 0 ? `< ${humanDurationCoarseMs(b.maxMs)}`
    : `${humanDurationCoarseMs(b.minMs)} – ${humanDurationCoarseMs(b.maxMs)}`;
  return {
    title: `${b.label} blocks · ${b.gloss}`,
    formula: `Σ blocks ${range} ÷ all block time`,
    substitution: b.count
      ? `${humanDurationCoarseMs(b.ms)} ÷ ${humanDurationCoarseMs(s.totalMs)}`
      : null,
    result: b.count
      ? `${pct}% · ${b.count} block${b.count === 1 ? "" : "s"} · ${humanDurationCoarseMs(b.ms)}`
      : "none",
    why: b.key === "gap"
      ? "Work blocks by the arithmetic and by nothing else: the gaps between interruptions, long enough to notice and too short to start anything in."
      : `Blocks of ${b.label} — ${b.note}.`,
    color: `var(--fb-${b.key})`,
  };
}

// layoutFreeBlocks assigns the block segments their WHOLE-PIXEL widths, then
// spans each bucket's bracket across the segments it owns.
//
// It cannot be done in the HTML, because percentages are resolved by the browser
// against a track width the markup does not know, and the result is fractional
// edges — the thing that makes a row of bars shimmer and their separators come
// out grey instead of crisp. So the shares ride along in data-share and the
// pixels are handed out here, once the track has a width to measure.
//
// The brackets are the same story one level up: a bracket has to START and END
// on a real segment boundary, which is only knowable after the rounding, so it
// is measured from the segment edges rather than re-derived from percentages.
function layoutFreeBlocks(root) {
  const bars = (root || document).querySelector(".fb-bars");
  if (!bars) return;
  const segs = [...bars.querySelectorAll(".fb-b")];
  if (!segs.length) return;
  const total = Math.floor(bars.clientWidth);
  if (total <= 0) return; // not laid out yet (hidden card, pending window)

  const MIN_PX = 5; // narrower than this is not a bar, and cannot be hovered
  const shares = segs.map((el) => parseFloat(el.dataset.share) || 0);
  const sum = shares.reduce((a, b) => a + b, 0) || 1;
  const ideal = shares.map((v) => (v / sum) * total);

  // ROUND each bar on its own, rather than flooring and handing out the leftover
  // by largest remainder. Largest-remainder fills the track exactly but decides
  // ties by position: two blocks the width computation has already agreed are
  // both fourteen minutes came out 40px and 39px, because only one spare pixel
  // was going and one of them had to have it. Independent rounding cannot do
  // that — equal shares round to equal widths, always — which is the property
  // that makes the minute rounding upstream mean anything on screen.
  const px = ideal.map((v) => Math.max(MIN_PX, Math.round(v)));
  let used = px.reduce((a, b) => a + b, 0);

  // Independent rounding does not sum to the track, so the difference goes to
  // ONE designated slack segment — a combed bucket, which is a batch of many
  // blocks and the one place a pixel means least. A gap at the right edge or an
  // overflow would both read as a bug rather than as rounding.
  const slack = segs.findIndex((el) => el.dataset.slack === "1");
  if (slack >= 0 && px[slack] + (total - used) >= MIN_PX) {
    px[slack] += total - used;
    used = total;
  }
  // No comb (or it would go under MIN_PX): fall back to shaving the widest,
  // which are the bars least changed by a pixel.
  const byWidth = px.map((v, i) => i).sort((a, b) => px[b] - px[a]);
  for (let k = 0; used !== total && k < byWidth.length * 64; k++) {
    const i = byWidth[k % byWidth.length];
    if (used > total && px[i] > MIN_PX) { px[i]--; used--; }
    else if (used < total) { px[i]++; used++; }
  }

  const edges = [0];
  segs.forEach((el, i) => { el.style.width = px[i] + "px"; edges.push(edges[i] + px[i]); });

  // Each bucket's bracket spans its own run of segments, inset a pixel either
  // side so two adjacent brackets read as two.
  const span = {};
  segs.forEach((el, i) => {
    const k = el.dataset.bucket;
    if (!k) return;
    if (!span[k]) span[k] = [edges[i], edges[i + 1]];
    else span[k][1] = edges[i + 1];
  });
  const keys = [...(root || document).querySelectorAll(".fbk[data-bucket]")];
  const placed = [];
  for (const el of keys) {
    const s = span[el.dataset.bucket];
    if (!s) { el.hidden = true; continue; }
    el.hidden = false;
    const w = Math.max(2, s[1] - s[0] - 2);
    el.style.left = (s[0] + 1) + "px";
    el.style.width = w + "px";
    placed.push([el, s[0] + 1, w]);
  }
  layoutBracketLabels(placed);
}

// layoutBracketLabels fits each bracket's label to the bracket, then keeps two
// labels from landing on top of each other.
//
// Both halves matter. A label wider than its bracket slides under the NEXT
// bucket's bars and starts pointing at the wrong ones, which is the one thing a
// bracket exists to prevent; and two neighbouring slivers both wanting a label
// collide however narrow you make them. So: shed the label's least important
// parts first — prose ("in", "blocks"), then the second line, then the range,
// then the colour dot, leaving the PERCENTAGE, which is the number the reader
// came for. Then, if it still overlaps its left-hand neighbour, drop it to a
// second row rather than dropping it: a 2% bucket that shows no number is a
// bucket the reader has to hover to read, and four readable numbers is the
// whole point of the key.
const BRACKET_LABEL_SLOP = 8; // px a label may overhang its bracket
function layoutBracketLabels(placed) {
  const rowRight = [-Infinity, -Infinity];
  let twoRow = false;
  for (const [el, left, w] of placed) {
    const lab = el.querySelector(".fbk-inner");
    if (!lab) continue;
    el.classList.remove("tight", "nosub", "mini", "nodot", "hide", "row2");
    // Shedding decides how MUCH label there is, never whether there is one: a
    // 4px bucket cannot hold even "1%", and hiding it here would throw away a
    // number that the second row can carry perfectly well. Only a real overlap
    // (below) hides anything.
    for (const step of ["tight", "nosub", "mini", "nodot"]) {
      if (lab.offsetWidth <= w + BRACKET_LABEL_SLOP) break;
      el.classList.add(step);
    }
    // .fbk-inner is an inline-block around nowrap lines, so its offsetWidth is
    // the TEXT's width — not the bracket's. Measuring the bracket instead would
    // have every label collide with its neighbour, since adjacent buckets share
    // an edge by construction.
    const half = lab.offsetWidth / 2;
    const mid = left + w / 2;
    const row = mid - half >= rowRight[0] + 6 ? 0 : mid - half >= rowRight[1] + 6 ? 1 : -1;
    if (row < 0) { el.classList.add("hide"); continue; }
    if (row === 1) { el.classList.add("row2"); twoRow = true; }
    rowRight[row] = mid + half;
  }
  const key = placed.length ? placed[0][0].parentElement : null;
  if (key) key.classList.toggle("two-row", twoRow);
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
    ? `<span class="dim">Official % unavailable</span>`
    : `<span class="${stale ? "stale" : "dim"}">Official % · updated ${agoString(Date.parse(plan.mtime))}${stale ? " (stale)" : ""}</span>`;

  const windowDollars = pw && pw.cost_usd != null ? pw.cost_usd : null;

  el.cardCost.innerHTML = `
    <div class="card-label">cost</div>
    <div class="headline-row">
      <div class="headline has-tip" data-tip="${tip({
        title: "Window total",
        formula: "Σ tokens × model price (recomputed)",
        result: fmtUSD(totals.cost_usd),
        why: "Total spend for this window, recomputed from token counts and current model prices.",
      })}">
        <div class="hv">${fmtUSD(totals.cost_usd)}</div>
        <div class="hk">Window total · recomputed</div>
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
          <span>Weekly</span>
          <span class="gauge-figs"><b class="has-tip" style="color:${pctColor(wkPct)}" data-tip="${tip({
            title: "Weekly plan usage",
            formula: "7-day plan utilization",
            result: fmtPct(wkPct),
            why: "Utilization of your 7-day (weekly) plan allowance.",
          })}">${fmtPct(wkPct)}</b></span>
        </div>
        ${gaugeBar(wkPct)}
      ` : ""}
    </div>`;

  el.cardTokens.innerHTML = tokensBlockHTML(totals);

  attachFormulaTips(el.cardCost);
  attachFormulaTips(el.cardTokens);
}

// ---------------------------------------------------------------------------
// the token card
//
// The dollars above are DERIVED (tokens × model price); this is what they were
// derived from, which is why it sits directly under them — its own card in the
// same column, not a ruled-off tail of the cost card, so the two read as two
// facts rather than one long one.
//
// TWO blocks, not four peers. "Input · billed" was one number standing for three
// quantities that differ by orders of magnitude in size AND by an order of
// magnitude in unit price — cache reads at roughly a tenth of fresh, cache
// writes at rather more than fresh — so the single figure was both the largest
// number on the page and the least informative one. Broken out, the same numbers
// say what the bill is actually made of: a little output, a mountain of re-read
// context, the writes that put it there, and the sliver that was genuinely new.
//
// But those three are not siblings of output — they are the PARTS of it, and a
// 2×2 grid of four equal cells said otherwise. So output leads alone, and the
// three input components sit under one head that carries the billed total on its
// right, in the same idiom as the attention card's section heads. The head is the
// row the total used to need underneath, so the reading is shorter by a line.
//
// No colour on the figures. Four differently tinted numbers read as four
// categories to decode; they are one quantity in three parts and a total, and the
// proportion bar already shows the split. The bar is one hue in three steps
// (position, not category, maps a segment to its figure below), so the two
// slivers stay visible against a read share that is nearly the whole track.
// ---------------------------------------------------------------------------
function tokensBlockHTML(totals) {
  const out = totals.tok_out || 0;
  const fresh = totals.tok_in || 0;
  const read = totals.tok_cache_read || 0;
  const written = totals.tok_cache_create || 0;
  const billedIn = fresh + read + written; // model.js tokenBilled, at window scale
  if (!(out || billedIn)) {
    return `<div class="card-label">tokens</div>`
      + `<div class="kv muted-note">No token counts for this window</div>`;
  }
  const tip = (obj) => escapeHTML(formulaTipHTML(obj));
  const cachedFrac = billedIn > 0 ? read / billedIn : null;
  const cachedPct = cachedFrac == null ? null : Math.round(cachedFrac * 100);

  // the input split, at the same scale as the engagement split on the attention
  // card: cache reads, then the writes that put them there, then the sliver the
  // conversation had never paid to cache. One hue, three steps — reads are the
  // faintest because they are nearly the whole track, which is what leaves the
  // other two visible at all.
  const pct = (v) => ((v / billedIn) * 100).toFixed(3);
  const cacheBar = billedIn > 0
    ? `<div class="split-bar tok-bar" role="img" aria-label="Cache read, cache written and fresh input">`
      + `<span class="sb-seg" style="width:${pct(read)}%;background:var(--tok-read)"></span>`
      + `<span class="sb-seg" style="width:${pct(written)}%;background:var(--tok-written)"></span>`
      + `<span class="sb-seg" style="width:${pct(fresh)}%;background:var(--tok-fresh)"></span>`
      + `</div>`
    : "";

  // value over key, the topline's voice at card scale.
  const bigFig = (value, key, tipObj) =>
    `<div class="tk-fig has-tip" data-tip="${tip(tipObj)}">`
    + `<span class="tk-v">${value}</span>`
    + `<span class="tk-k">${key}</span></div>`;
  const shareOf = (v) => (billedIn > 0 ? Math.round((v / billedIn) * 100) : null);

  const inputHead = `<div class="kv-head fs-head">`
    + `<span class="fs-head-l">Input<span class="fs-head-gloss"> · read + written + fresh</span></span>`
    + `<span class="fs-head-r has-tip" data-tip="${tip({
        title: "Billed input tokens",
        formula: "cache read + cache written + fresh",
        substitution: `${fmtTokens(read)} + ${fmtTokens(written)} + ${fmtTokens(fresh)}`,
        result: fmtTokens(billedIn) + ` (${billedIn.toLocaleString()})`,
        why: "What the dollars above are computed from. Every turn resends the whole conversation, so billed input counts the cache reads too — the uncached remainder alone would understate it by orders of magnitude.",
      })}">${fmtTokens(billedIn)}</span></div>`;

  return `<div class="card-label">tokens</div>
    <div class="tk-figs tk-out">
      ${bigFig(fmtTokens(out), "output · generated", {
        title: "Output tokens",
        formula: "Σ output over every session in the window",
        result: fmtTokens(out) + ` (${out.toLocaleString()})`,
        why: "Everything the agents actually wrote this window — the expensive half of the bill, per token.",
      })}
    </div>
    <div class="tk-input">
      ${inputHead}
      ${cacheBar}
      <div class="tk-figs tk-parts">
        ${bigFig(fmtTokens(read), `cache read${cachedPct != null ? ` · ${cachedPct}%` : ""}`, {
          title: "Cache reads",
          formula: "cache read ÷ billed input",
          substitution: `${fmtTokens(read)} ÷ ${fmtTokens(billedIn)}`,
          result: `${fmtTokens(read)} · ${cachedPct == null ? "—" : cachedPct + "%"} of input`,
          why: "Every turn resends the whole conversation, and this is the part of it the cache already held — billed at roughly a tenth of fresh. High is good: it is the same context re-sent cheaply.",
        })}
        ${bigFig(fmtTokens(written), "cache written", {
          title: "Cache writes",
          formula: "cache creation ÷ billed input",
          substitution: `${fmtTokens(written)} ÷ ${fmtTokens(billedIn)}`,
          result: `${fmtTokens(written)} · ${shareOf(written) == null ? "—" : shareOf(written) + "%"} of input`,
          why: "What it cost to put context INTO the cache — priced above fresh input, and the reason a cache only pays for itself once it is read back.",
        })}
        ${bigFig(fmtTokens(fresh), "fresh · uncached", {
          title: "Fresh input",
          formula: "uncached input ÷ billed input",
          substitution: `${fmtTokens(fresh)} ÷ ${fmtTokens(billedIn)}`,
          result: `${fmtTokens(fresh)} · ${shareOf(fresh) == null ? "—" : shareOf(fresh) + "%"} of input`,
          why: "Genuinely new tokens, never cached at all. On this workload it is a sliver — which is why quoting billed input as one number said almost nothing about what was actually new.",
        })}
      </div>
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

// Overlays below place themselves straight from what they measure. That only
// works while the page has no root scale: a `:root { zoom }` would split
// measurement (clientX, getBoundingClientRect — visual pixels) from assignment
// (style.left — layout pixels), and every one of these would land 1/zoom too far
// out. style.css says why it doesn't set one.

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
  el.popout.innerHTML = `<button class="po-close" title="Close">✕</button>` + html;
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
// The day arithmetic itself is model.js's, in UTC — see stepISODate. A blank
// field means "today", which is the one thing the pure helper won't invent.
//
// Today is the far end: this dashboard renders sessions that have run, and a
// day that hasn't happened yet can only ever draw an empty grid. So the step is
// clamped rather than left free — the ceiling is enforced here, on the one
// helper every day-changing path funnels through.
function shiftDay(base, delta) {
  return clampISODate(stepISODate(base || todayLocal(), delta), todayLocal());
}

function reloadNow() { hidePopout(); loadTimeline({ reason: "manual" }); }

// stepDay walks the window a day in either direction. The move itself is
// synchronous — commitWindow has the new day, its label and its skeleton on
// screen before this returns — and the fetch it schedules is debounced, so
// holding the arrow down scrolls the shell through the days at keyboard speed
// while only the day you land on is ever requested.
//
// A step the clamp swallowed changes nothing, so it does nothing: refetching
// the day already on screen would flash the grid for a keypress that didn't
// move it.
function stepDay(delta) {
  const next = shiftDay(el.day.value, delta);
  if (next === el.day.value) return;
  // A scroll has a direction, and it is knowable here — this is the only place
  // it is expressed. The prefetcher walks the way the user is already walking.
  lastStepDir = delta < 0 ? -1 : 1;
  commitWindow(next);
  if (calendarOpen()) { calCursor = el.day.value; renderCalendar(); focusCursorCell(); }
}

// ---------------------------------------------------------------------------
// date popover
//
// Our own calendar rather than the native <input type="date"> picker: that one
// cannot be themed to match anything, renders the date in the browser locale
// where this page speaks ISO throughout, and — the reason it had to go — takes
// the keyboard away from the page entirely while it is up, so every shortcut
// below died the moment it opened.
//
// The grid comes from model.js's monthGrid (pure, six fixed weeks). The
// keyboard cursor IS the browser's focus, moved from cell to cell over a
// roving tabindex, so the focus ring, screen-reader announcement and our own
// idea of "where the keyboard is" can never disagree.
// ---------------------------------------------------------------------------

const MONTH_NAMES = ["january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december"];

let calCursor = null; // ISO day under the keyboard; null while closed

function calendarOpen() { return !el.calendar.hidden; }

function openCalendar() {
  if (calendarOpen()) return;
  calCursor = Number.isFinite(parseISODate(el.day.value)) ? el.day.value : todayLocal();
  // The topbar doesn't stick, so `c` pressed from halfway down the page would
  // anchor the panel to a trigger that isn't on screen. Bring the trigger back
  // first — the popover belongs to it, and a floating panel with no visible
  // anchor is worse than a small scroll.
  const a = el.dateField.getBoundingClientRect();
  if (a.top < 0 || a.bottom > window.innerHeight) {
    el.dateField.scrollIntoView({ block: "nearest" });
  }
  el.calendar.hidden = false;
  el.dateField.setAttribute("aria-expanded", "true");
  renderCalendar();
  placeCalendar();
  focusCursorCell();
}

// closeCalendar hands focus back to the trigger, which is where the keyboard
// came from — dropping it on <body> instead would cost a keyboard user their
// place on the page. Skipped for an outside click, where focus is already
// wherever the user just clicked.
function closeCalendar(restoreFocus) {
  if (!calendarOpen()) return;
  el.calendar.hidden = true;
  el.dateField.setAttribute("aria-expanded", "false");
  calCursor = null;
  if (restoreFocus) el.dateField.focus();
}

function toggleCalendar() {
  if (calendarOpen()) closeCalendar(true); else openCalendar();
}

// placeCalendar centers the panel under the field, flipping above it when there
// is no room below. Both axes are clamped to the viewport as the last step, so
// the panel is on screen whatever the anchor is doing — a fixed-position panel
// hung off a scrolled-away trigger would otherwise render half out of frame.
function placeCalendar() {
  const pad = 8, anchor = el.dateField.getBoundingClientRect();
  const r = el.calendar.getBoundingClientRect();
  let top = anchor.bottom + 6;
  if (top + r.height > window.innerHeight - pad) top = anchor.top - r.height - 6;
  const clamp = (v, max) => Math.max(pad, Math.min(v, Math.max(pad, max)));
  el.calendar.style.left = clamp(anchor.left + anchor.width / 2 - r.width / 2,
    window.innerWidth - r.width - pad) + "px";
  el.calendar.style.top = clamp(top, window.innerHeight - r.height - pad) + "px";
}

// renderCalendar stamps the month the cursor is in. Every arrow press re-stamps
// rather than patching classes: 42 buttons is nothing, and one code path for
// "what the grid looks like" is worth more than the diff it saves.
function renderCalendar() {
  const grid = monthGrid(calCursor) || monthGrid(todayLocal());
  const today = todayLocal();
  el.calYm.textContent = grid.year + "-" + String(grid.month + 1).padStart(2, "0");
  el.calMonthName.textContent = MONTH_NAMES[grid.month];
  // The forward pager is spent once the grid is showing the month today falls
  // in: there is no later month with anything in it. Compared as YYYY-MM
  // strings, same as everywhere else on this page.
  el.calNext.disabled = el.calYm.textContent >= today.slice(0, 7);
  const frag = document.createDocumentFragment();
  for (const cell of grid.cells) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cal-day";
    b.textContent = String(cell.day);
    b.dataset.iso = cell.iso;
    b.setAttribute("role", "gridcell");
    b.setAttribute("aria-label", cell.iso);
    if (!cell.inMonth) b.classList.add("out");
    // ISO days sort as strings, so this is just "hasn't happened yet" — and a
    // day that hasn't happened has nothing to show, so the cell is dead rather
    // than merely dim. `disabled` is what says so to the pointer, the keyboard
    // and a screen reader at once; the .future class is only the paint.
    if (cell.iso > today) { b.classList.add("future"); b.disabled = true; }
    if (cell.iso === today) b.classList.add("today");
    if (cell.iso === el.day.value) { b.classList.add("sel"); b.setAttribute("aria-selected", "true"); }
    // roving tabindex: exactly one cell is in the tab order at a time
    b.tabIndex = cell.iso === calCursor ? 0 : -1;
    frag.appendChild(b);
  }
  el.calGrid.replaceChildren(frag);
}

function focusCursorCell() {
  const cell = el.calGrid.querySelector('[data-iso="' + calCursor + '"]');
  if (cell) cell.focus();
}

// moveCursor walks the keyboard cursor without committing anything. Landing
// outside the month on display pages the grid to follow it.
//
// The cursor stops at today rather than refusing the move: a week-down press
// from three days ago lands ON today, which is where the user was heading, and
// paging into a future month lands there too. Keeping the cursor at or below
// today is also what lets future cells be `disabled` — the roving tabindex has
// to land on a focusable cell, and a disabled one takes no focus.
function moveCursor(iso) {
  if (!Number.isFinite(parseISODate(iso))) return;
  calCursor = clampISODate(iso, todayLocal());
  renderCalendar();
  focusCursorCell();
}

// commitDay is the calendar's way in; commitWindow does the work and owns the
// validity checks, so the popover and the arrows cannot drift apart.
function commitDay(iso) {
  closeCalendar(true);
  commitWindow(iso);
}

// handleCalendarKey: while the popover is up it owns the keyboard, the way the
// native picker did — minus the dead end. Ctrl chords pass through (Ctrl+←/→
// keeps stepping the day underneath, grid and all), function keys are left to
// the browser, and every remaining printable key is swallowed so the page's
// shortcuts can't fire from behind a modal dialog.
function handleCalendarKey(ev) {
  if (ev.altKey || ev.metaKey || ev.ctrlKey) return;
  const k = ev.key;
  if (k === "Escape") { ev.preventDefault(); closeCalendar(true); return; }
  if (k === "Enter" || k === " ") { ev.preventDefault(); commitDay(calCursor); return; }
  const days = k === "ArrowLeft" ? -1 : k === "ArrowRight" ? 1
    : k === "ArrowUp" ? -7 : k === "ArrowDown" ? 7 : 0;
  if (days) { ev.preventDefault(); moveCursor(stepISODate(calCursor, days)); return; }
  if (k === "PageUp") { ev.preventDefault(); moveCursor(stepISOMonth(calCursor, -1)); return; }
  if (k === "PageDown") { ev.preventDefault(); moveCursor(stepISOMonth(calCursor, +1)); return; }
  if (k === "t") { ev.preventDefault(); moveCursor(todayLocal()); return; }
  if (k === "Tab") { ev.preventDefault(); return; } // focus stays in the dialog
  if (k.length === 1) ev.preventDefault();
}

function applyUrlParams() {
  const q = new URLSearchParams(window.location.search);
  // ?day is clamped like every other way in: a hand-typed future day would
  // otherwise open on an empty grid with the forward arrow already spent.
  el.day.value = clampISODate(q.get("day") || todayLocal(), todayLocal());
  // ?view=sessions|line|projects deep-links the chart view (URL wins over the
  // persisted choice for this load, mirroring how ?day overrides the default day).
  const v = normalizeView(q.get("view"));
  if (v) currentView = v;
  syncDayDisplay();
}

// syncDayDisplay mirrors the held ISO value (YYYY-MM-DD) into the visible
// label on the trigger. The value lives in a hidden input so every reader can
// still ask for el.day.value; this is the only thing that renders it.
function syncDayDisplay() {
  el.dayDisplay.textContent = el.day.value || "—";
  syncDayBounds();
}

// syncDayBounds spends the forward arrow once the window is sitting on today,
// so the ceiling is visible before it is hit rather than felt as a dead button.
// A blank field is today (see isLiveWindow), so it counts as the far end too.
//
// Re-run on the live tick as well as on every day change: a dashboard left open
// across midnight gets a new today, and the arrow has to come back to life
// there without a reload.
function syncDayBounds() {
  el.nextDay.disabled = !el.day.value || el.day.value >= todayLocal();
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
    el.themeToggle.title = "Switch to " + next + " theme";
    el.themeToggle.setAttribute("aria-label", "Switch to " + next + " theme");
  }
  // The SVG restyles itself via CSS vars; the canvas bakes colors in at draw
  // time, so it must be repainted to pick up the new theme — including when
  // what it is holding is the pending window's skeleton.
  if (currentView !== "line") return;
  if (win.pending) renderAloftSkeleton();
  else if (lastData) renderConcurrencyChart(lastData);
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

  el.prevDay.addEventListener("click", () => stepDay(-1));
  el.nextDay.addEventListener("click", () => stepDay(+1));

  // date popover: the field is its trigger, the grid commits on click, and the
  // panel's own keydown owns the keyboard while it is up.
  el.dateField.addEventListener("click", toggleCalendar);
  el.calendar.addEventListener("keydown", handleCalendarKey);
  el.calGrid.addEventListener("click", (ev) => {
    const cell = ev.target.closest(".cal-day");
    if (cell) commitDay(cell.dataset.iso);
  });
  // Paging keeps the panel open and commits nothing — it moves the cursor, and
  // the cursor is what the grid is drawn around.
  el.calPrev.addEventListener("click", () => moveCursor(stepISOMonth(calCursor, -1)));
  el.calNext.addEventListener("click", () => moveCursor(stepISOMonth(calCursor, +1)));
  el.calToday.addEventListener("click", () => commitDay(todayLocal()));
  el.optCtxSwitches.addEventListener("change", () => { if (lastData && !win.pending) renderTimeline(lastData); });
  el.optFocus.addEventListener("change", () => { if (lastData && !win.pending) renderTimeline(lastData); });
  el.optSmooth.addEventListener("change", () => {
    syncSmoothLegend();
    if (lastData && currentView === "line") renderConcurrencyChart(lastData);
  });
  syncSmoothLegend(); // seat the legend to the toggle's initial state

  // view switcher: sessions ↔ agents-aloft line chart ↔ project ranking
  el.viewSessions.addEventListener("click", () => setView("sessions"));
  el.viewLine.addEventListener("click", () => setView("line"));
  el.viewProjects.addEventListener("click", () => setView("projects"));
  // …and the same walk from the keyboard, alongside the day and calendar keys.
  document.addEventListener("keydown", handleShortcutKey);
  applyViewClasses(currentView);
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
  // readout. Cheap — reuses the last render's paint closure, no profile
  // recompute. The entry sweep owns the canvas until it settles, so a cursor
  // already sitting over the plot waits it out rather than fighting the reveal
  // for the paint; the next move after it lands picks the crosshair back up.
  el.canvas.addEventListener("mousemove", (ev) => {
    const h = chartHover;
    if (!h || sweeping()) return;
    // The cursor's offset into the canvas IS a plot coordinate — the canvas
    // draws in the same pixels its box is laid out in, and nothing scales the
    // page between the two. (It did once, and the crosshair sat a fifth of the
    // way back toward the axis; see the note on :root in style.css.)
    const rect = el.canvas.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    // the frozen axis strip is painted over the plot, so the stretch of chart
    // hiding behind it is not hoverable either
    const overFrozenAxis = ev.clientX - el.wrap.getBoundingClientRect().left < h.plotLeft;
    if (overFrozenAxis || px < h.plotLeft || px > h.plotLeft + h.plotW) { h.paint(null); hideTip(); return; }
    const t = h.t0 + ((px - h.plotLeft) / h.plotW) * h.span;
    h.paint(t);
    showTip(concurrencyTipHTML(h, t), ev);
  });
  el.canvas.addEventListener("mouseleave", () => { if (chartHover && !sweeping()) chartHover.paint(null); hideTip(); });

  // dismiss popout and calendar on outside click / Escape. The trigger is
  // excluded from the calendar's outside test: its own click already toggles,
  // and closing here too would make opening by click impossible.
  document.addEventListener("click", (ev) => {
    if (!el.popout.hidden && !el.popout.contains(ev.target)) hidePopout();
    if (calendarOpen() && !el.calendar.contains(ev.target) && !el.dateField.contains(ev.target)) {
      closeCalendar(false);
    }
  });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") hidePopout(); });

  // The panel is anchored to the topbar, which scrolls away with the page: keep
  // it seated while the trigger is still in frame, and let it go once it isn't.
  window.addEventListener("scroll", () => {
    if (!calendarOpen()) return;
    const a = el.dateField.getBoundingClientRect();
    if (a.bottom < 0 || a.top > window.innerHeight) closeCalendar(false); else placeCalendar();
  }, { passive: true });

  let resizeTimer = null;
  // Horizontal scroll drives the two frozen columns: the sessions gutter is a
  // transform on a layer (no repaint), the aloft y-axis is part of a canvas and
  // has to be redrawn, so that one is coalesced to a frame.
  el.wrap.addEventListener("scroll", () => {
    syncGutterFreeze();
    if (currentView === "line") scheduleAloftFreeze();
  }, { passive: true });

  window.addEventListener("resize", () => {
    if (calendarOpen()) placeCalendar(); // the panel is anchored to a field that just moved
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (win.pending) renderSkeleton();     // the frame has to follow the window too
      else if (lastData) renderChartArea(lastData);
      // the free-block widths are pixels, so they are wrong the moment the track
      // changes width — and re-running the whole card to fix a row of widths
      // would throw away its tooltips for nothing
      layoutFreeBlocks(el.cardAttention);
    }, 120);
  });

  // A backgrounded tab has no reason to keep a 1.5s subprocess running every 3
  // seconds; coming back should show the current state at once rather than
  // waiting out the rest of an interval.
  document.addEventListener("visibilitychange", () => {
    schedulePoll();
    if (!document.hidden && isLiveWindow()) loadTimeline({ reason: "manual" });
  });

  // The first paint is a day commit like any other: the skeleton goes up
  // immediately, so the page has its frame on screen while the first fetch (and
  // the settings it waits on) are still out.
  enterPendingWindow();

  // live polling — no manual refresh controls. Settings land first: every
  // operator figure depends on them, and re-rendering the page a beat later with
  // different thresholds would be a visible flicker of the numbers.
  loadSettings().then(() => loadTimeline({ reason: "day" }));
  loadPlan();
  loadSummaries();
  loadMemory();
  schedulePoll(); // live window only; a closed day polls zero times
  planTimer = setInterval(loadPlan, PLAN_POLL_MS);
  setInterval(loadSummaries, SUMMARIES_POLL_MS);
  setInterval(loadMemory, MEMORY_POLL_MS);
  // the same tick reseats the day's forward bound, so midnight rolling over
  // under an open dashboard hands the next day back rather than staying locked
  setInterval(() => { tickLive(); syncDayBounds(); }, 1000);
}

init();
