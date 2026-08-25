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
buildLadder();
buildAxes();
buildProviderTable();
buildSources();
buildLimits();
buildLanes();
renderSandbox();
bindSandbox();
bindTheme();
