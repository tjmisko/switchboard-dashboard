"use strict";

const COLOR_CLASS = {
  red: "sw-red", green: "sw-green", orange: "sw-orange", gray: "sw-gray",
  suspended: "sw-susp", hidden: "sw-hidden",
};

function esc(value) {
  return String(value).replace(/[&<>"]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  })[c]);
}

function swatch(color, extra = "") {
  return `<span class="sw ${COLOR_CLASS[color] || "sw-gray"} ${extra}" aria-hidden="true"></span>`;
}

function buildRail() {
  const sections = [...document.querySelectorAll(".sec")];
  const host = document.getElementById("rail-list");
  host.innerHTML = sections.map((section) => `
    <li><a href="#${section.id}" data-for="${section.id}">
      <span class="rn">${section.dataset.num}</span><span>${section.dataset.rail}</span>
    </a></li>`).join("");

  const links = new Map([...host.querySelectorAll("a")].map((link) => [link.dataset.for, link]));
  if (!("IntersectionObserver" in window)) return;
  const observer = new IntersectionObserver((entries) => {
    const visible = entries.find((entry) => entry.isIntersecting);
    if (!visible) return;
    links.forEach((link) => link.classList.remove("on"));
    links.get(visible.target.id)?.classList.add("on");
  }, { rootMargin: "-70px 0px -65% 0px" });
  sections.forEach((section) => observer.observe(section));
}

function buildPipeline() {
  document.getElementById("pipeline").innerHTML = PIPELINE.map(([name, detail], index) => `
    <article class="pipe-step">
      <span class="pipe-num">${String(index + 1).padStart(2, "0")}</span>
      <b>${esc(name)}</b><span>${esc(detail)}</span>
    </article>`).join("");
}

const MACHINE_TONES = {
  gray: "#7d8590", green: "#3fb950", orange: "#d29922",
  red: "#f85149", blue: "#58a6ff", purple: "#a371f7",
};
const MACHINE_VIEWBOX = { width: 680, height: 410 };
const MACHINE_NODE = { width: 178, height: 44 };
let selectedMachine = PROVIDER_MACHINES[0]?.id || "";
const selectedRegions = new Map(PROVIDER_MACHINES.map((machine) => [machine.id, machine.regions[0]?.id]));
const selectedMachineStates = new Map();

function machineById(id) {
  return PROVIDER_MACHINES.find((machine) => machine.id === id);
}

function regionById(machine, id) {
  return machine?.regions.find((region) => region.id === id);
}

function stateById(region, id) {
  const state = region?.states.find(([stateId]) => stateId === id);
  return state ? { id: state[0], detail: state[1], tone: state[2] } : null;
}

function transitionFrom(transition) {
  return transition[0];
}

function transitionApplies(transition, state) {
  const from = transitionFrom(transition);
  return from === "*" || from === state || (Array.isArray(from) && from.includes(state));
}

function transitionSources(transition, states) {
  const from = transitionFrom(transition);
  if (from === "*") return states;
  return Array.isArray(from) ? from : [from];
}

function machinePositions(count) {
  const center = { x: MACHINE_VIEWBOX.width / 2, y: 190 };
  if (count === 1) return [center];
  if (count === 2) return [{ x: 205, y: 190 }, { x: 475, y: 190 }];
  if (count === 3) return [
    { x: center.x, y: 72 }, { x: 185, y: 290 }, { x: 495, y: 290 },
  ];
  return Array.from({ length: count }, (_, index) => {
    const angle = (-90 + index * 360 / count) * Math.PI / 180;
    return { x: center.x + 245 * Math.cos(angle), y: center.y + 137 * Math.sin(angle) };
  });
}

function machineBoxExit(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const scale = Math.min(
    Math.abs(dx) > 0.01 ? (MACHINE_NODE.width / 2 + 4) / Math.abs(dx) : Infinity,
    Math.abs(dy) > 0.01 ? (MACHINE_NODE.height / 2 + 4) / Math.abs(dy) : Infinity,
  );
  return { x: from.x + dx * scale, y: from.y + dy * scale };
}

function machineEdgeClass(kinds) {
  if (kinds.has("hook") || kinds.has("protocol")) return "hook";
  if (kinds.has("level")) return "level";
  return "timer";
}

function drawMachine(region, selected) {
  const svg = document.getElementById("machine-svg");
  const stateIds = region.states.map(([id]) => id);
  const layout = machinePositions(stateIds.length);
  const positions = new Map(stateIds.map((id, index) => [id, layout[index]]));
  const pairs = new Map();
  for (const transition of region.transitions) {
    const to = transition[2];
    if (to === "=") continue;
    for (const from of transitionSources(transition, stateIds)) {
      if (from === to || !positions.has(from) || !positions.has(to)) continue;
      const key = `${from}\u0000${to}`;
      if (!pairs.has(key)) pairs.set(key, { from, to, kinds: new Set() });
      pairs.get(key).kinds.add(transition[3]);
    }
  }

  const touching = new Set([selected]);
  for (const pair of pairs.values()) {
    if (pair.from === selected || pair.to === selected) {
      touching.add(pair.from);
      touching.add(pair.to);
    }
  }

  const parts = [`<ellipse class="mring" cx="340" cy="190" rx="245" ry="137" />`];
  for (const pair of pairs.values()) {
    const fromPos = positions.get(pair.from);
    const toPos = positions.get(pair.to);
    const start = machineBoxExit(fromPos, toPos);
    const end = machineBoxExit(toPos, fromPos);
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy) || 1;
    const curve = 0.1;
    const control = {
      x: (start.x + end.x) / 2 - (dy / length) * length * curve,
      y: (start.y + end.y) / 2 + (dx / length) * length * curve,
    };
    const angle = Math.atan2(end.y - control.y, end.x - control.x);
    const headBase = { x: end.x - Math.cos(angle) * 9, y: end.y - Math.sin(angle) * 9 };
    const head = [
      [end.x, end.y],
      [headBase.x + Math.cos(angle + Math.PI / 2) * 4, headBase.y + Math.sin(angle + Math.PI / 2) * 4],
      [headBase.x + Math.cos(angle - Math.PI / 2) * 4, headBase.y + Math.sin(angle - Math.PI / 2) * 4],
    ].map((point) => point.map((value) => value.toFixed(1)).join(",")).join(" ");
    const direction = pair.from === selected ? "out" : pair.to === selected ? "in" : "faded";
    const tone = stateById(region, pair.from === selected ? pair.to : pair.from)?.tone || "gray";
    const color = MACHINE_TONES[tone] || MACHINE_TONES.gray;
    const kind = machineEdgeClass(pair.kinds);
    parts.push(
      `<path class="medge ${kind} ${direction}" style="--me-c:${color}" data-from="${esc(pair.from)}" data-to="${esc(pair.to)}" d="M${start.x.toFixed(1)},${start.y.toFixed(1)} Q${control.x.toFixed(1)},${control.y.toFixed(1)} ${end.x.toFixed(1)},${end.y.toFixed(1)}" />` +
      `<polygon class="mhead ${kind} ${direction}" style="--me-c:${color}" points="${head}" />`,
    );
  }

  for (const [id, detail, tone] of region.states) {
    const position = positions.get(id);
    const x = position.x - MACHINE_NODE.width / 2;
    const y = position.y - MACHINE_NODE.height / 2;
    const color = MACHINE_TONES[tone] || MACHINE_TONES.gray;
    const classes = ["mnode", id === selected ? "sel" : "", touching.has(id) ? "" : "dim"].filter(Boolean).join(" ");
    parts.push(
      `<g class="${classes}" data-machine-state="${esc(id)}" style="--mn-c:${color}" tabindex="0" role="button" aria-label="${esc(id)}: ${esc(detail)}">` +
      `<rect class="mn-box" x="${x}" y="${y}" width="${MACHINE_NODE.width}" height="${MACHINE_NODE.height}" rx="22" />` +
      `<circle class="mn-dot" cx="${x + 18}" cy="${position.y}" r="5" />` +
      `<text class="mn-label" x="${x + 31}" y="${position.y + 4.5}">${esc(id)}</text>` +
      (id === region.initial ? `<text class="mn-start" x="${x + MACHINE_NODE.width - 13}" y="${position.y + 3.5}">◆</text>` : "") +
      `</g>`,
    );
  }
  svg.setAttribute("viewBox", `0 0 ${MACHINE_VIEWBOX.width} ${MACHINE_VIEWBOX.height}`);
  svg.innerHTML = parts.join("");
}

function transitionKindLabel(kind) {
  return { hook: "hook", protocol: "protocol", level: "reconcile", timer: "timer", reset: "reset", hold: "hold" }[kind] || kind;
}

function renderMachinePanel(region, selected) {
  const state = stateById(region, selected);
  const applicable = region.transitions.filter((transition) => transitionApplies(transition, selected));
  const row = (transition) => {
    const target = transition[2] === "=" ? selected : transition[2];
    const holds = target === selected;
    return `<div class="mp-row${holds ? " holds" : ""}">
      <span class="mp-kind ${esc(transition[3])}">${esc(transitionKindLabel(transition[3]))}</span>
      <code>${esc(transition[1])}</code>
      <span class="mp-target">${holds ? "holds" : "→ " + esc(target)}</span>
      <span class="mp-note">${esc(transition[4])}</span>
    </div>`;
  };
  document.getElementById("machine-panel").innerHTML = `
    <div class="mp-head"><span class="machine-state" style="--state-tone:${MACHINE_TONES[state.tone] || MACHINE_TONES.gray}">${esc(state.id)}</span><code>${esc(region.label)}</code></div>
    <p class="mp-detail">${esc(state.detail)}</p>
    <p class="mp-region-note">${esc(region.note)}</p>
    <div class="mp-transitions">
      <p class="cap">Applicable from this state</p>
      ${applicable.map(row).join("") || `<p class="hint">No transition is defined from this control state.</p>`}
    </div>`;
}

function renderMachine() {
  const machine = machineById(selectedMachine) || PROVIDER_MACHINES[0];
  selectedMachine = machine.id;
  let region = regionById(machine, selectedRegions.get(machine.id));
  if (!region) region = machine.regions[0];
  selectedRegions.set(machine.id, region.id);
  const selectionKey = `${machine.id}/${region.id}`;
  let selected = selectedMachineStates.get(selectionKey) || region.initial;
  if (!stateById(region, selected)) selected = region.initial;
  selectedMachineStates.set(selectionKey, selected);

  document.getElementById("machine-tabs").innerHTML = PROVIDER_MACHINES.map((candidate) => `
    <button type="button" role="tab" data-machine="${esc(candidate.id)}" aria-selected="${candidate.id === machine.id}">${esc(candidate.label)}</button>`).join("");
  document.getElementById("machine-intro").innerHTML = `
    <div><p>${esc(machine.summary)}</p><code>${esc(machine.shape)}</code></div>
    <code>${esc(machine.implementation)}</code>`;
  document.getElementById("machine-regions").innerHTML = machine.regions.map((candidate) => `
    <button type="button" role="tab" data-machine-region="${esc(candidate.id)}" aria-selected="${candidate.id === region.id}">${esc(candidate.label)}</button>`).join("");
  drawMachine(region, selected);
  renderMachinePanel(region, selected);
}

function buildMachines() {
  document.getElementById("machine-tabs").addEventListener("click", (event) => {
    const button = event.target.closest("[data-machine]");
    if (!button) return;
    selectedMachine = button.dataset.machine;
    renderMachine();
  });
  document.getElementById("machine-regions").addEventListener("click", (event) => {
    const button = event.target.closest("[data-machine-region]");
    if (!button) return;
    selectedRegions.set(selectedMachine, button.dataset.machineRegion);
    renderMachine();
  });
  const svg = document.getElementById("machine-svg");
  const selectNode = (target) => {
    const node = target.closest("[data-machine-state]");
    if (!node) return false;
    const machine = machineById(selectedMachine);
    const region = regionById(machine, selectedRegions.get(selectedMachine));
    selectedMachineStates.set(`${machine.id}/${region.id}`, node.dataset.machineState);
    renderMachine();
    return true;
  };
  svg.addEventListener("click", (event) => selectNode(event.target));
  svg.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (selectNode(event.target)) event.preventDefault();
  });
  renderMachine();
}

function buildMachineDrift() {
  const rows = OLD_MODEL_DIVERGENCES.map(([topic, oldModel, current]) => `
    <tr><th scope="row">${esc(topic)}</th><td>${esc(oldModel)}</td><td>${esc(current)}</td></tr>`).join("");
  document.getElementById("machine-drift").innerHTML = `
    <thead><tr><th></th><th>Old visual</th><th>Current main</th></tr></thead><tbody>${rows}</tbody>`;
}

function buildLadder() {
  document.getElementById("ladder").innerHTML = RULES.map(([id, condition, color, output], index) => `
    <li data-rule="${id}" data-color="${color}">
      <span class="rung-num">${index + 1}</span>${swatch(color)}
      <code>${esc(condition)}</code><span class="rung-out">${esc(output)}</span>
    </li>`).join("");
}

function buildAxes() {
  for (const [axis, values] of Object.entries(AXES)) {
    document.getElementById(`${axis}-cards`).innerHTML = values.map(([name, detail, terminal]) => `
      <article class="axis-card${terminal ? " terminal" : ""}">
        <code>${esc(name)}</code><span>${esc(detail)}</span>${terminal ? "<em>terminal</em>" : ""}
      </article>`).join("");
  }
}

function buildProviderTable() {
  const rows = PROVIDER_ROWS.map(([field, claude, codex]) => `
    <tr><th scope="row">${esc(field)}</th><td>${esc(claude)}</td><td>${esc(codex)}</td></tr>`).join("");
  document.getElementById("provider-table").innerHTML = `
    <thead><tr><th></th><th>Claude</th><th>Codex</th></tr></thead><tbody>${rows}</tbody>`;
}

function buildSources() {
  document.getElementById("sources").innerHTML = SOURCES.map(([source, provider, rank, detail]) => `
    <article class="source">
      <div><code>${esc(source)}</code><span class="rank">rank ${rank}</span></div>
      <b>${esc(provider)}</b><p>${esc(detail)}</p>
    </article>`).join("");
}

function buildLimits() {
  document.getElementById("limits").innerHTML = LIMITS.map(([name, detail]) => `
    <article><b>${esc(name)}</b><p>${esc(detail)}</p></article>`).join("");
}

function buildLanes() {
  document.getElementById("lanemap").innerHTML = LANES.map(([name, color, detail, dim]) => `
    <div class="lanerow">${swatch(color, dim ? "sw-dim" : "")}
      <code>${esc(name)}</code><span>${esc(detail)}</span>
    </div>`).join("");
}

const sandbox = {
  processState: "running",
  fresh: true,
  childEnabled: true,
  root: { id: "root", parentId: "", runtime: "idle", attention: "none", lifecycle: "running" },
  child: { id: "child", parentId: "root", runtime: "active", attention: "none", lifecycle: "running" },
};

const PRESETS = {
  working: ["Root working", { childEnabled: false, fresh: true, processState: "running", root: ["active", "none", "running"] }],
  delegating: ["Child working", { childEnabled: true, fresh: true, processState: "running", root: ["idle", "none", "running"], child: ["active", "none", "running"] }],
  waiting: ["Child needs approval", { childEnabled: true, fresh: true, processState: "running", root: ["active", "none", "running"], child: ["idle", "approval", "running"] }],
  topology: ["Topology only", { childEnabled: true, fresh: true, processState: "running", root: ["not_loaded", "none", "running"], child: ["not_loaded", "none", "unknown"] }],
  expired: ["Expired", { childEnabled: false, fresh: false, processState: "running", root: ["active", "none", "running"] }],
};

function setAxes(node, values) {
  [node.runtime, node.attention, node.lifecycle] = values;
}

function applyPreset(id) {
  const values = PRESETS[id]?.[1];
  if (!values) return;
  sandbox.childEnabled = values.childEnabled;
  sandbox.fresh = values.fresh;
  sandbox.processState = values.processState;
  setAxes(sandbox.root, values.root);
  if (values.child) setAxes(sandbox.child, values.child);
  renderSandbox();
}

function axisSelect(nodeName, axis, current) {
  const options = AXES[axis].map(([value]) => `<option value="${value}"${value === current ? " selected" : ""}>${value}</option>`).join("");
  return `<label><span>${axis}</span><select data-node="${nodeName}" data-axis="${axis}">${options}</select></label>`;
}

function renderNode(nodeName, node, optional) {
  return `<fieldset class="sb-node">
    <legend><code>${nodeName}</code>${optional ? `<label class="sb-check"><input type="checkbox" data-child-toggle${sandbox.childEnabled ? " checked" : ""}> include</label>` : ""}</legend>
    <div class="sb-axis-controls${optional && !sandbox.childEnabled ? " disabled" : ""}">
      ${["runtime", "attention", "lifecycle"].map((axis) => axisSelect(nodeName, axis, node[axis])).join("")}
    </div>
  </fieldset>`;
}

function observation() {
  const now = Date.now();
  return {
    provider: "demo",
    rootId: "root",
    source: "hook",
    complete: false,
    observedAt: new Date(now - (sandbox.fresh ? 1000 : 20000)).toISOString(),
    freshUntil: new Date(now + (sandbox.fresh ? 10000 : -10000)).toISOString(),
    nodes: [sandbox.root, ...(sandbox.childEnabled ? [sandbox.child] : [])],
  };
}

function renderSandbox() {
  document.getElementById("sb-presets").innerHTML = `
    <span class="sb-cap">Presets</span>${Object.entries(PRESETS).map(([id, [label]]) => `<button type="button" data-preset="${id}">${esc(label)}</button>`).join("")}`;
  document.getElementById("sb-nodes").innerHTML = renderNode("root", sandbox.root, false) + renderNode("child", sandbox.child, true);
  document.getElementById("sb-system").innerHTML = `
    <label><span>process</span><select data-system="processState">
      ${["running", "suspended", "gone"].map((value) => `<option${value === sandbox.processState ? " selected" : ""}>${value}</option>`).join("")}
    </select></label>
    <label><span>observation</span><select data-system="fresh">
      <option value="true"${sandbox.fresh ? " selected" : ""}>fresh</option>
      <option value="false"${sandbox.fresh ? "" : " selected"}>expired</option>
    </select></label>`;

  const verdict = reduceGraph(observation(), { processState: sandbox.processState });
  const label = verdict.status || (verdict.color === "hidden" ? "no chip" : "unknown");
  const rule = RULES.find(([id]) => id === verdict.rule);
  document.getElementById("sb-out").innerHTML = `
    ${swatch(verdict.color, "sw-lg")}
    <strong data-color="${verdict.color}">${esc(label)}</strong>
    <code>${esc(verdict.rule)}</code>
    <p>${esc(rule?.[1] || "")}</p>
    <div class="sb-counts"><span>${verdict.liveChildren} live children</span><span>${verdict.waitingNodes} waits</span><span>${verdict.errorNodes} errors</span></div>`;

  for (const row of document.querySelectorAll("#ladder li")) {
    row.classList.toggle("fired", row.dataset.rule === verdict.rule);
  }
}

function bindSandbox() {
  document.getElementById("sandbox").addEventListener("click", (event) => {
    const button = event.target.closest("[data-preset]");
    if (button) applyPreset(button.dataset.preset);
  });
  document.getElementById("sandbox").addEventListener("change", (event) => {
    const target = event.target;
    if (target.matches("[data-child-toggle]")) sandbox.childEnabled = target.checked;
    if (target.matches("[data-node][data-axis]")) sandbox[target.dataset.node][target.dataset.axis] = target.value;
    if (target.dataset.system === "processState") sandbox.processState = target.value;
    if (target.dataset.system === "fresh") sandbox.fresh = target.value === "true";
    renderSandbox();
  });
}

function bindTheme() {
  document.getElementById("theme-toggle").addEventListener("click", () => {
    const root = document.documentElement;
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    try { localStorage.setItem("sb-theme", next); } catch (_) {}
    const lock = document.head.querySelector('meta[name="darkreader-lock"]');
    if (next === "dark" && !lock) {
      const meta = document.createElement("meta");
      meta.name = "darkreader-lock";
      document.head.appendChild(meta);
    } else if (next === "light") {
      lock?.remove();
    }
  });
}

buildRail();
buildPipeline();
buildMachines();
buildMachineDrift();
buildLadder();
buildAxes();
buildProviderTable();
buildSources();
buildLimits();
buildLanes();
renderSandbox();
bindSandbox();
bindTheme();
