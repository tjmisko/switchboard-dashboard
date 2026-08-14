// states.js — the field guide's behavior.
//
// Everything on this page is stamped from states-model.js rather than written
// into the markup, for one reason: the model is a 6x11 table, and a table
// transcribed into HTML by hand is a table that will disagree with the daemon
// within a release. The only authored markup is prose.
//
// Three interactive pieces, in the order the page uses them:
//   1. the machine — a ring diagram wired to a reading panel
//   2. the matrix  — the same 66 cells at once, hover for the reason
//   3. the sandbox — the real fold, run against writers you set
//
// No framework, no build step, no network. Same rules as the dashboard.

// ---------------------------------------------------------------------------
// shared vocabulary
// ---------------------------------------------------------------------------

// A state's color IS the fold branch it contributes to — a writer is only ever
// visible to you as the chip its state helps produce.
const STATE_COLOR = {
  Unknown: "#7d8590",
  Working: "#3fb950",
  ToolInFlight: "#3fb950",
  Blocked: "#f85149",
  Ended: "#d29922",
  Interrupted: "#d29922",
  Dead: "#4d5560",
};

const FOLD_COLOR = {
  red: "#f85149",
  green: "#3fb950",
  orange: "#d29922",
  gray: "#7d8590",
  suspended: "#6e7681",
  hidden: "transparent",
};

const PILL_CLASS = {
  red: "pill-red", green: "pill-green", orange: "pill-orange",
  gray: "pill-gray", hidden: "pill-dead", suspended: "pill-gray",
};

function stateInfo(id) { return STATES.find((s) => s.id === id); }
function statePill(id) { return PILL_CLASS[stateInfo(id).folds]; }
function swatchClass(color) {
  return { red: "sw-red", green: "sw-green", orange: "sw-orange",
           gray: "sw-gray", suspended: "sw-susp", hidden: "sw-hidden" }[color];
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ---------------------------------------------------------------------------
// tooltip (the dashboard's, same element and same idiom)
// ---------------------------------------------------------------------------
const tip = document.getElementById("tooltip");

function showTip(html, evt) {
  tip.innerHTML = html;
  tip.hidden = false;
  moveTip(evt);
}
function moveTip(evt) {
  if (tip.hidden) return;
  const pad = 14;
  const r = tip.getBoundingClientRect();
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = evt.clientY - r.height - pad;
  tip.style.left = Math.max(8, x) + "px";
  tip.style.top = Math.max(8, y) + "px";
}
function hideTip() { tip.hidden = true; }

// Attach hover-tooltip behavior to an element. Touch gets nothing, which is
// correct: every tooltip here restates something the page already says.
function tipify(el, html) {
  el.addEventListener("mouseenter", (e) => showTip(html, e));
  el.addEventListener("mousemove", moveTip);
  el.addEventListener("mouseleave", hideTip);
}

// ---------------------------------------------------------------------------
// section rail + scrollspy
// ---------------------------------------------------------------------------
function buildRail() {
  const list = document.getElementById("rail-list");
  const secs = [...document.querySelectorAll(".sec")];
  // the rail carries the page's one structural claim — the operator half ends
  // here — so the separator is stamped before the first data-zone section
  let zoned = false;
  list.innerHTML = secs
    .map((s) => {
      let sep = "";
      if (s.dataset.zone === "reference" && !zoned) {
        zoned = true;
        sep = `<li class="rail-sep">Reference</li>`;
      }
      return `${sep}<li><a href="#${s.id}" data-for="${s.id}"><span class="rn">${s.dataset.num}</span><span>${esc(s.dataset.rail)}</span></a></li>`;
    })
    .join("");

  const links = new Map([...list.querySelectorAll("a")].map((a) => [a.dataset.for, a]));
  // rootMargin pulls the observation band to the upper third, so the entry that
  // lights is the one you are reading rather than the one just entering frame.
  const obs = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        links.forEach((a) => a.classList.remove("on"));
        links.get(en.target.id)?.classList.add("on");
      }
    },
    { rootMargin: "-70px 0px -62% 0px", threshold: 0 }
  );
  secs.forEach((s) => obs.observe(s));
}

// ---------------------------------------------------------------------------
// 2 · state cards
// ---------------------------------------------------------------------------
function buildStateCards() {
  const host = document.getElementById("statecards");
  host.innerHTML = STATES.map((s) => {
    const c = STATE_COLOR[s.id];
    const folds = s.folds === "hidden" ? "No chip" : "Folds " + s.folds;
    return `
      <article class="scard${s.id === "Dead" ? " dead" : ""}" style="--sc:${c}">
        <div class="scard-head">
          <span class="sw ${swatchClass(s.folds)}" aria-hidden="true"></span>
          <span class="scard-name">${s.id}</span>
          ${s.twin ? '<span class="scard-twin">twin</span>' : ""}
          <span class="scard-folds">${folds}</span>
        </div>
        <p class="scard-short">${esc(s.short)}</p>
        <p class="scard-body">${esc(s.body)}</p>
        <p class="scard-you"><span class="yk">you</span><span>${esc(s.you)}</span></p>
      </article>`;
  }).join("");
}

// ---------------------------------------------------------------------------
// 3 · evidence
// ---------------------------------------------------------------------------
function buildSources() {
  document.getElementById("sources").innerHTML = SOURCES.map(
    (s) => `
      <div class="source">
        <div class="source-h"><b>${esc(s.label)}</b><span class="source-tag">${esc(s.tag)}</span></div>
        <div class="source-line can"><span class="sl-m">+</span><span>${esc(s.strength)}</span></div>
        <div class="source-line cant"><span class="sl-m">−</span><span>${esc(s.weakness)}</span></div>
        <p class="source-claude"><span class="sc-k">Today</span>${esc(s.claude)}</p>
      </div>`
  ).join("");
}

function buildEvidence() {
  const host = document.getElementById("evgrid");
  // the badge names the SOURCE as the section names it, not by the source's
  // internal id — the cards above say "notification", so a chip reading "hook"
  // would look like a fourth source
  const badge = (id) => SOURCES.find((s) => s.id === id)?.badge || id;
  host.innerHTML = EVIDENCE.map(
    (e) => `
      <div class="ev" data-src="${e.src}" data-key="${e.key ? 1 : 0}" data-id="${e.id}">
        <span>${e.id}</span>
        <span class="ev-src">${e.universal ? "Universal" : badge(e.src)}</span>
      </div>`
  ).join("");

  for (const el of host.querySelectorAll(".ev")) {
    const e = EVIDENCE.find((x) => x.id === el.dataset.id);
    const uni = e.universal
      ? `<div class="t-row">From every state → ${e.universal}</div>`
      : "";
    tipify(
      el,
      `<div class="t-status" style="color:${e.key ? "#e3b341" : "var(--fg)"}">${e.id}</div>` +
        `<div class="t-row">${esc(e.src)}</div>${uni}` +
        `<div class="t-why">${esc(e.gloss)}</div>`
    );
  }
}

// ---------------------------------------------------------------------------
// 4 · the machine
//
// Six live states on a ring. The ring order is not decorative — neighbours are
// the pairs that actually hand off to each other (Working→ToolInFlight→Blocked
// down one side, Interrupted→Ended→Unknown back up the other), so the common
// paths are short chords and only the rarer ones cross the middle.
// ---------------------------------------------------------------------------
const RING = ["Working", "ToolInFlight", "Blocked", "Interrupted", "Ended", "Unknown"];
const VB = { w: 640, h: 470 };
// wide enough for "ToolInFlight" at the label's 13px mono, with the swatch's
// 30px gutter in front of it — the longest name is what sizes every pill
const NODE = { w: 144, h: 38 };

function ringPos(i) {
  const a = (-90 + i * 60) * (Math.PI / 180);
  return { x: VB.w / 2 + 224 * Math.cos(a), y: VB.h / 2 + 170 * Math.sin(a) };
}

// Where the segment from `a` to `b` leaves a's box. Rectangle intersection, so
// an arrow lands on the pill's edge rather than under it.
function boxExit(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const hw = NODE.w / 2 + 4;
  const hh = NODE.h / 2 + 4;
  const t = Math.min(
    Math.abs(dx) > 0.01 ? hw / Math.abs(dx) : Infinity,
    Math.abs(dy) > 0.01 ? hh / Math.abs(dy) : Infinity
  );
  return { x: a.x + dx * t, y: a.y + dy * t };
}

let selected = "Blocked"; // the state the page is actually about
const edgeEls = [];

function buildMachine() {
  const svg = document.getElementById("machine-svg");
  svg.setAttribute("viewBox", `0 0 ${VB.w} ${VB.h}`);

  const pos = {};
  RING.forEach((id, i) => (pos[id] = ringPos(i)));

  const parts = [];
  // guide ring, so the six pills read as one board rather than six cards
  parts.push(`<ellipse class="mring" cx="${VB.w / 2}" cy="${VB.h / 2}" rx="224" ry="170" />`);

  // one edge per distinct (from → to) state change; the evidence that drives it
  // lives in the panel, because 24 chords with labels is a hairball
  const pairs = new Map();
  for (const r of ROWS) {
    if (r.hold) continue;
    const k = r.from + "→" + r.to;
    if (!pairs.has(k)) pairs.set(k, { from: r.from, to: r.to, evs: [] });
    pairs.get(k).evs.push(r.ev);
  }

  for (const p of pairs.values()) {
    const a = boxExit(pos[p.from], pos[p.to]);
    const b = boxExit(pos[p.to], pos[p.from]);
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    // Bow every chord to the left of its own direction. A→B and B→A then bow
    // to opposite sides and never overprint, which matters here: 9 of the 24
    // pairs are reciprocal.
    const k = 0.11;
    const cx = mx - (dy / len) * len * k;
    const cy = my + (dx / len) * len * k;
    // arrowhead along the tangent at the far end (end − control)
    const ang = Math.atan2(b.y - cy, b.x - cx);
    const hx = b.x - Math.cos(ang) * 8;
    const hy = b.y - Math.sin(ang) * 8;
    const head = [
      [b.x, b.y],
      [hx + Math.cos(ang + Math.PI / 2) * 4, hy + Math.sin(ang + Math.PI / 2) * 4],
      [hx + Math.cos(ang - Math.PI / 2) * 4, hy + Math.sin(ang - Math.PI / 2) * 4],
    ].map((q) => q.map((n) => n.toFixed(1)).join(",")).join(" ");

    parts.push(
      `<path class="medge" data-from="${p.from}" data-to="${p.to}" d="M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}" />` +
        `<polygon class="mhead" data-from="${p.from}" data-to="${p.to}" points="${head}" />`
    );
  }

  // nodes last so they sit over the wiring
  for (const id of RING) {
    const p = pos[id];
    const c = STATE_COLOR[id];
    const x = p.x - NODE.w / 2;
    const y = p.y - NODE.h / 2;
    // ToolInFlight's swatch is hollow: it folds the same green as Working, but
    // it is the state whose evidence is ambiguous, and the diagram should say so
    // without inventing a seventh color.
    const swatch =
      id === "ToolInFlight"
        ? `<rect class="mn-sw" x="${x + 14}" y="${p.y - 5}" width="10" height="10" rx="2" fill="none" stroke="${c}" stroke-width="1.6" />`
        : `<rect class="mn-sw" x="${x + 14}" y="${p.y - 5}" width="10" height="10" rx="2" fill="${c}" />`;
    parts.push(
      `<g class="mnode" data-id="${id}" style="--mn-c:${c}" tabindex="0" role="button" aria-label="${id}">` +
        `<rect class="mn-box" x="${x}" y="${y}" width="${NODE.w}" height="${NODE.h}" rx="19" />` +
        swatch +
        `<text class="mn-label" x="${x + 32}" y="${p.y + 4.5}">${id}</text>` +
        `</g>`
    );
  }

  svg.innerHTML = parts.join("");

  edgeEls.length = 0;
  svg.querySelectorAll(".medge, .mhead").forEach((el) => edgeEls.push(el));

  svg.querySelectorAll(".mnode").forEach((g) => {
    const id = g.dataset.id;
    g.addEventListener("click", () => selectState(id));
    g.addEventListener("mouseenter", () => selectState(id));
    g.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectState(id); }
    });
  });

  selectState(selected);
}

function selectState(id) {
  selected = id;
  const svg = document.getElementById("machine-svg");

  const touching = new Set([id]);
  for (const el of edgeEls) {
    const { from, to } = el.dataset;
    el.classList.remove("out", "in", "faded");
    if (from === id) {
      el.classList.add("out");
      el.style.setProperty("--me-c", STATE_COLOR[to]);
      touching.add(to);
    } else if (to === id) {
      el.classList.add("in");
      el.style.setProperty("--me-c", STATE_COLOR[from]);
      touching.add(from);
    } else {
      el.classList.add("faded");
    }
  }
  svg.querySelectorAll(".mnode").forEach((g) => {
    g.classList.toggle("sel", g.dataset.id === id);
    g.classList.toggle("dim", !touching.has(g.dataset.id));
  });

  document.querySelectorAll("#matrix tbody tr").forEach((tr) => {
    tr.classList.toggle("sel", tr.dataset.state === id);
  });

  renderPanel(id);
}

function renderPanel(id) {
  const s = stateInfo(id);
  const rows = LIVE_EVIDENCE.map((e) => transitionFor(id, e.id)).filter(Boolean);
  const changes = rows.filter((r) => !r.hold);
  const holds = rows.filter((r) => r.hold);

  // group the changes by destination, in ring order, so the panel reads the
  // same way the diagram does
  const byDest = new Map();
  for (const r of changes) {
    if (!byDest.has(r.to)) byDest.set(r.to, []);
    byDest.get(r.to).push(r);
  }
  const dests = RING.filter((d) => byDest.has(d));

  const group = (title, color, list, cls) => `
    <div class="mp-group">
      <p class="mp-gh" style="--mp-c:${color}"><span class="mp-arrow">${cls === "holds" ? "↺" : "→"}</span>${title}</p>
      ${list
        .map(
          (r) => `<div class="mp-row ${cls || ""}">
            <span class="mr-ev">${r.ev}</span>
            <span class="mr-why">${esc(r.why)}</span>
          </div>`
        )
        .join("")}
    </div>`;

  renderInbound(id);

  document.getElementById("machine-panel").innerHTML =
    `<div class="mp-head"><span class="pill ${statePill(id)}">${id}</span></div>` +
    `<p class="mp-sub">${esc(s.short)}</p>` +
    dests.map((d) => group(d, STATE_COLOR[d], byDest.get(d))).join("") +
    (holds.length
      ? group(`Stays ${id} · ${holds.length} of 11`, "var(--fg-dim)", holds, "holds")
      : "") +
    `<p class="mp-foot">+ Gone → Dead · SessionRotated → Unknown, from every state</p>`;
}

// What lands a writer in this state, keyed by evidence rather than by origin —
// the useful shape is "PermissionRequest, from anywhere", not five near-identical
// rows. Blocked's list is one entry long, which is §2's argument as a fact.
function renderInbound(id) {
  const byEv = new Map();
  for (const r of ROWS) {
    if (r.hold || r.to !== id) continue;
    if (!byEv.has(r.ev)) byEv.set(r.ev, []);
    byEv.get(r.ev).push(r.from);
  }
  const rows = LIVE_EVIDENCE.filter((e) => byEv.has(e.id)).map((e) => {
    const froms = byEv.get(e.id);
    // 5 of 5 live origins reads better as "from anywhere" than as the roster
    const where = froms.length === LIVE_STATES.length - 1 ? "from anywhere" : "from " + froms.join(", ");
    return `<div class="mi-row"><span class="mi-ev">${e.id}</span><span class="mi-from">${where}</span></div>`;
  });

  const universal = EVIDENCE.find((e) => e.universal === id);
  document.getElementById("mach-in").innerHTML =
    `<p class="mi-cap">What puts a writer in <b>${id}</b></p>` +
    (rows.length ? rows.join("") : `<p class="mi-none">Nothing in this table — only the universal rule below</p>`) +
    (universal ? `<div class="mi-row uni"><span class="mi-ev">${universal.id}</span><span class="mi-from">from every state</span></div>` : "");
}

// ---------------------------------------------------------------------------
// 4 · the matrix
// ---------------------------------------------------------------------------
function buildMatrix() {
  const head =
    `<thead><tr><th class="corner">From ╲ Evidence</th>` +
    LIVE_EVIDENCE.map((e) => `<th class="evh" data-src="${e.src}"><span>${e.id}</span></th>`).join("") +
    `</tr></thead>`;

  const body =
    `<tbody>` +
    LIVE_STATES.map((from) => {
      const cells = LIVE_EVIDENCE.map((e) => {
        const r = transitionFor(from, e.id);
        const div = divergenceFor(from, e.id);
        const gap = gapFor(from, e.id);
        const color = r.hold ? STATE_COLOR[from] : STATE_COLOR[r.to];
        const mark = r.hold
          ? `<span class="mring2" style="--mc:${color}"></span>`
          : `<span class="msq" style="--mc:${color}"></span>`;
        const cls = ["mcell", div ? "div" : "", gap ? "gap" : ""].filter(Boolean).join(" ");
        return `<td><span class="${cls}" data-from="${from}" data-ev="${e.id}">${mark}</span></td>`;
      }).join("");
      return `<tr data-state="${from}"><th>${from}</th>${cells}</tr>`;
    }).join("") +
    `</tbody>`;

  const table = document.getElementById("matrix");
  table.innerHTML = head + body;

  for (const el of table.querySelectorAll(".mcell")) {
    const { from, ev } = el.dataset;
    const r = transitionFor(from, ev);
    const div = divergenceFor(from, ev);
    const gap = gapFor(from, ev);
    const dest = r.hold
      ? `<div class="t-row">Stays <b>${from}</b></div>`
      : `<div class="t-row">→ <span style="color:${STATE_COLOR[r.to]}">${r.to}</span></div>`;
    tipify(
      el,
      `<div class="t-head"><span class="t-status">${from}</span><span class="t-dur">${ev}</span></div>` +
        dest +
        `<div class="t-why">${esc(r.why)}</div>` +
        (r.shipped ? `<div class="t-id">Shipped as ${esc(r.shipped)}</div>` : "") +
        (div ? `<div class="t-suspect">⚠ The shipped daemon diverges here — see §8</div>` : "") +
        (gap ? `<div class="t-suspect">⚠ No shipped rule implements this</div>` : "")
    );
    el.addEventListener("mouseenter", () => selectState(from));
  }
}

// ---------------------------------------------------------------------------
// 5 · the fold
//
// `fold` and `delegating` come from states-model.js, which is the transcription
// states.test.js keeps honest. states.js used to declare its own byte-identical
// copies; being a classic script, those declarations shadowed the globals, so
// the sandbox demonstrated a second transcription with no test behind it — the
// exact drift the suite exists to prevent.
// ---------------------------------------------------------------------------
const SB = { writers: { "": "Ended", "sub-1": "Working" }, live: "running" };
const SB_MAX = 4;
const SB_PRESETS = {
  delegating: { "": "Ended", "sub-1": "Working" },
  subblocked: { "": "Working", "sub-1": "Blocked" },
  quiet: { "": "Ended", "sub-1": "Ended" },
  fresh: { "": "Unknown" },
};

function buildLadder() {
  document.getElementById("ladder").innerHTML = LADDER.map(
    (r) => `
      <li data-rule="${r.rule}" style="--rung-c:${r.color === "hidden" ? "var(--border)" : FOLD_COLOR[r.color]}; --rung-bg:${r.color === "hidden" ? "transparent" : FOLD_COLOR[r.color] + "1f"}">
        <span class="sw ${swatchClass(r.color)}" aria-hidden="true"></span>
        <span class="rung-cond">${esc(r.cond)}</span>
        <span class="rung-say">${esc(r.say)}</span>
        <span class="rung-rule">${r.rule}</span>
      </li>`
  ).join("");
}

function buildSandbox() {
  const host = document.getElementById("sb-writers");
  const keys = Object.keys(SB.writers).sort();

  host.innerHTML =
    keys
      .map((k) => {
        const label = k === "" ? `<span class="sb-main">main</span>` : k;
        const btns = STATES.map(
          (s) => `<button type="button" data-w="${k}" data-s="${s.id}"
             aria-pressed="${SB.writers[k] === s.id}"
             style="--sw-c:${STATE_COLOR[s.id]}; --sw-bg:${STATE_COLOR[s.id]}1c">${s.id}</button>`
        ).join("");
        const drop = k === ""
          ? "<span></span>"
          : `<button type="button" class="sb-drop" data-drop="${k}" title="Remove this writer" aria-label="Remove ${k}">×</button>`;
        return `<div class="sb-w"><span class="sb-wk">${label}</span><div class="sb-seg">${btns}</div>${drop}</div>`;
      })
      .join("") +
    `<button type="button" class="sb-add" id="sb-add" ${keys.length >= SB_MAX ? "disabled" : ""}>+ Subagent</button>`;

  // the value is the fold's liveness token; only the label is title-cased
  const LIVE_LABEL = { running: "Running", suspended: "Suspended", gone: "Gone" };
  document.getElementById("sb-live").innerHTML = Object.keys(LIVE_LABEL)
    .map(
      (l) => `<button type="button" data-live="${l}" aria-pressed="${SB.live === l}"
         style="--sw-c:var(--fg-muted); --sw-bg:var(--bg-elev-2)">${LIVE_LABEL[l]}</button>`
    )
    .join("");

  renderVerdict();
}

function renderVerdict() {
  const v = fold(SB.writers, SB.live);
  const c = FOLD_COLOR[v.color];
  const label = v.color === "hidden" ? "NO CHIP" : v.color.toUpperCase();
  const named = v.writer === "" ? "main" : v.writer;

  let why;
  if (v.color === "red") why = `<b>${named}</b> needs a decision from you`;
  else if (v.color === "green") why = `<b>${named}</b> is doing work`;
  else if (v.color === "orange") why = "Nothing is running; the session wants a prompt";
  else if (v.color === "gray") why = "Nothing has been observed about any writer";
  else if (v.color === "suspended") why = "The process is stopped; writer states are moot";
  else why = "The process is gone";

  document.getElementById("sb-out").innerHTML =
    `<span class="sw ${swatchClass(v.color)} sw-lg" aria-hidden="true"></span>` +
    `<span class="sb-color" style="color:${v.color === "hidden" ? "var(--fg-dim)" : c}">${label}</span>` +
    `<span class="sb-why">${why}</span>` +
    (v.delegating ? `<span class="sb-badge">delegating</span>` : "") +
    `<span class="sb-rule">${v.rule}</span>`;

  // walk the ladder: everything above the firing rung was checked and missed
  const fired = LADDER.findIndex((r) => r.rule === v.rule);
  document.querySelectorAll("#ladder li").forEach((li, i) => {
    li.classList.toggle("fired", i === fired);
    li.classList.toggle("passed", i < fired);
    li.classList.toggle("unreached", i > fired);
  });
}

function wireSandbox() {
  document.getElementById("sandbox").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;

    if (btn.dataset.s !== undefined) {
      SB.writers[btn.dataset.w] = btn.dataset.s;
    } else if (btn.dataset.live) {
      SB.live = btn.dataset.live;
    } else if (btn.dataset.drop) {
      delete SB.writers[btn.dataset.drop];
    } else if (btn.dataset.preset) {
      SB.writers = { ...SB_PRESETS[btn.dataset.preset] };
      SB.live = "running";
    } else if (btn.id === "sb-add") {
      // next free sub-N, so removing sub-1 and adding again doesn't collide
      for (let i = 1; i <= SB_MAX; i++) {
        if (!(`sub-${i}` in SB.writers)) { SB.writers[`sub-${i}`] = "Working"; break; }
      }
    } else {
      return;
    }
    buildSandbox();
  });
}

// ---------------------------------------------------------------------------
// 6 · lane map
// ---------------------------------------------------------------------------
function buildLaneMap() {
  document.getElementById("lanemap").innerHTML = LANE_MAP.map(
    (l) => `
      <div class="lanerow">
        <span class="sw ${swatchClass(l.color)}${l.dim ? " sw-dim" : ""}" aria-hidden="true"></span>
        <span class="ln-name">${l.lane}${l.badge ? `<span class="ln-badge">${l.badge}</span>` : ""}</span>
        <span class="ln-note">${esc(l.note)}</span>
      </div>`
  ).join("");
}

// ---------------------------------------------------------------------------
// 7 · divergences and gaps
// ---------------------------------------------------------------------------
function buildDrift() {
  document.getElementById("drifts").innerHTML = DIVERGENCES.map(
    (d) => `
      <div class="drift">
        <p class="drift-h">
          <span class="pill ${statePill(d.from)} pill-sm">${d.from}</span>
          <span class="dh-ev">${d.ev}</span>
          <span>→</span>
          <span class="pill ${statePill(d.to)} pill-sm">${d.to}</span>
          <span class="dh-rule">${esc(d.shipped)}</span>
        </p>
        <p>${esc(d.note)}</p>
      </div>`
  ).join("");

  document.getElementById("gaps").innerHTML = GAPS.map(
    (g) => `
      <div class="gapcard">
        <p class="gc-h"><b>${g.from}</b> · ${g.ev} → <b>${g.to}</b></p>
        <p class="gc-w">${esc(g.why)}</p>
      </div>`
  ).join("");
}

// ---------------------------------------------------------------------------
// theme — the dashboard's exact contract, so the toggle carries across pages
// ---------------------------------------------------------------------------
const THEME_KEY = "sb-theme";
const themeMql = window.matchMedia("(prefers-color-scheme: dark)");

function resolvedTheme() {
  const v = localStorage.getItem(THEME_KEY);
  return v === "light" || v === "dark" ? v : themeMql.matches ? "dark" : "light";
}
function applyTheme() {
  const theme = resolvedTheme();
  document.documentElement.setAttribute("data-theme", theme);
  let m = document.querySelector('meta[name="darkreader-lock"]');
  if (theme === "dark" && !m) {
    m = document.createElement("meta");
    m.name = "darkreader-lock";
    document.head.appendChild(m);
  } else if (theme !== "dark" && m) {
    m.remove();
  }
  const btn = document.getElementById("theme-toggle");
  const next = theme === "dark" ? "light" : "dark";
  btn.title = "switch to " + next + " theme";
  btn.setAttribute("aria-label", "switch to " + next + " theme");
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
buildRail();
buildStateCards();
buildSources();
buildEvidence();
buildMatrix();
buildMachine();
buildLadder();
buildSandbox();
wireSandbox();
buildLaneMap();
buildDrift();
applyTheme();

document.getElementById("theme-toggle").addEventListener("click", () => {
  localStorage.setItem(THEME_KEY, resolvedTheme() === "dark" ? "light" : "dark");
  applyTheme();
});
themeMql.addEventListener("change", applyTheme);

// The hero swatches jump to the fold. Set the sandbox to the case that produces
// the color you clicked, so the answer is already on screen when you land.
document.querySelectorAll(".keyrow").forEach((a) => {
  a.addEventListener("click", () => {
    const preset = { red: "subblocked", green: "delegating", orange: "quiet", gray: "fresh" }[a.dataset.color];
    if (preset) {
      SB.writers = { ...SB_PRESETS[preset] };
      SB.live = "running";
    } else {
      SB.live = "suspended";
    }
    buildSandbox();
  });
});
