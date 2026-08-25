"use strict";

// Pure field-guide model. It mirrors Switchboard's shipped agentgraph enums,
// normalization, positive-liveness predicate, and reducer.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function () {

const AXES = {
  runtime: [
    ["unknown", "No authoritative runtime evidence."],
    ["not_loaded", "Known thread; runtime unavailable."],
    ["idle", "Loaded, not processing a turn."],
    ["active", "Processing a turn."],
    ["system_error", "Provider-reported runtime failure."],
  ],
  attention: [
    ["none", "No confirmed human-owned request."],
    ["approval", "An unresolved human approval."],
    ["user_input", "An unresolved blocking question."],
  ],
  lifecycle: [
    ["unknown", "No orchestration lifecycle evidence."],
    ["pending", "Initializing or queued."],
    ["running", "Activity interval open."],
    ["completed", "Activity interval completed.", true],
    ["interrupted", "Activity interval interrupted.", true],
    ["errored", "Activity interval failed.", true],
    ["shutdown", "Child shut down.", true],
    ["not_found", "Complete snapshot omitted the prior child.", true],
  ],
};

const TERMINAL = new Set(AXES.lifecycle.filter((v) => v[2]).map((v) => v[0]));

// Session resolution includes two process-owned branches above the reducer.
// The remaining branches are agentgraph.Reduce in priority order.
const RULES = [
  ["process-gone", "root process gone", "hidden", "remove the session"],
  ["process-suspended", "root process stopped", "suspended", "paused by you"],
  ["graph-not-fresh", "graph absent, invalid, future, or expired", "gray", "unknown"],
  ["live-approval", "any live node: attention = approval", "red", "permission"],
  ["live-user-input", "any live node: attention = user_input", "red", "permission"],
  ["root-active", "root runtime = active", "green", "working"],
  ["root-system-error", "root runtime = system_error", "gray", "unknown + error detail"],
  ["working-descendant", "live child active, pending, or running", "green", "delegating"],
  ["root-idle", "root runtime = idle", "orange", "idle"],
  ["fallback-unknown", "otherwise", "gray", "unknown"],
];

const LANES = [
  ["working", "green", "Root work."],
  ["delegating", "green", "Compact summary: a working descendant outranks an inactive root.", "dim"],
  ["dormant", "green", "Derived history: a recorded child overlaps a working parent interval.", "dim"],
  ["idle", "orange", "Root idle; no wait or working child."],
  ["idle (away)", "orange", "Idle while the operator was away.", "dim"],
  ["permission", "red", "Approval or user input; history flattens the reason."],
  ["suspended", "suspended", "Root process paused."],
  ["unknown", "gray", "No decisive compact status; graph detail may still carry an error."],
];

const PIPELINE = [
  ["OS discovery", "creates interactive roots; owns process identity, liveness, suspension, and navigation"],
  ["exact hook binding", "joins a provider session ID to (pid, started_at); never cwd/time/title"],
  ["provider observer", "builds a bounded root/child Observation outside the state lock"],
  ["agent graph", "normalizes explicit parentage and reduces three independent axes"],
  ["state + history", "publishes one root chip, nested detail, and canonical transitions"],
];

const PROVIDER_ROWS = [
  ["Graph authority", "Hooks + root/child transcripts + subagent/workflow artifacts.", "Read-only disposable codex app-server --stdio in auto mode; CLI >= 0.149.0. off leaves hook-only root projection."],
  ["Root state", "Hooks provide edges; transcript reconciliation corrects them.", "Concrete app-server fields win; bounded exact hooks fill unavailable root fields."],
  ["Attention", "PermissionRequest is keyed per writer; matching hooks/transcripts resolve only that writer.", "request_user_input is an exact hook latch; matching PostToolUse/Stop clears it. Request IDs and reviewer evidence classify structured waits; generic permission gets 30 s to resolve automatically."],
  ["Children", "Artifacts own identity and lifecycle; SubagentStart/Stop only request a rescan.", "App-server must first prove exact topology. Matching start → active/running for ≤10 m; stop → retained idle/completed; a later start reopens. Hooks never create or reparent."],
  ["Rotation / restart", "A new exact session replaces the root. Pending writer keys persist; correlators are re-earned.", "/clear advances the exact root and retires old IDs. Topology is resnapshotted; an in-memory question latch is not reconstructed."],
  ["Bounds", "Observations are fresh for 15 s.", "App-server: 15 s fresh, 1 s active / 10 s idle polls. Hook fallback: active 10 m, attention 24 h, idle 7 d; startup settles for 250 ms."],
  ["Degraded mode", "I/O failure retains a partial bounded graph; expiry reduces to unknown.", "The process stays discoverable and exact hooks can color the root; unproved children receive zero liveness."],
];

const SOURCES = [
  ["codex_app_server", "Codex", 4, "complete structural authority; exact field ownership still applies"],
  ["hook", "both", 3, "exact immediate edge; partial and bounded"],
  ["claude_transcript", "Claude", 4, "re-readable transcript and artifact authority"],
  ["codex_rollout", "Codex", 2, "reserved source; ordinary observation does not emit it"],
  ["restored_last_known", "Claude", 1, "bounded startup continuity"],
];

const LIMITS = [
  ["Codex ambiguous approval", "After a 30 s ownership grace, an unresolved generic gate may fall back to approval-red without semantic human evidence."],
  ["Codex question restart", "The hook-only request_user_input latch is in memory; restart degrades it to unknown."],
  ["Codex structural children", "not_loaded/unknown topology is visible but contributes no liveness without concrete state or an exact matched child hook."],
  ["Claude evidence fusion", "No single graph stream exists; hooks, transcripts, artifacts, workflows, and bounded stale caps are composed."],
  ["Errors", "system_error/errored remain explicit, but root system_error currently uses gray rather than a dedicated chip color."],
  ["History", "delegating is a compact summary edge; dormant is separately derived by slicing working intervals against child spans. Both attention kinds flatten to permission."],
];

const VALID = {
  runtime: new Set(AXES.runtime.map((v) => v[0])),
  attention: new Set(AXES.attention.map((v) => v[0])),
  lifecycle: new Set(AXES.lifecycle.map((v) => v[0])),
};

function canonicalNode(node) {
  node = node || {};
  return {
    ...node,
    id: String(node.id || ""),
    parentId: String(node.parentId || ""),
    nickname: String(node.nickname || ""),
    role: String(node.role || ""),
    runtime: VALID.runtime.has(node.runtime) ? node.runtime : "unknown",
    attention: VALID.attention.has(node.attention) ? node.attention : "none",
    lifecycle: VALID.lifecycle.has(node.lifecycle) ? node.lifecycle : "unknown",
  };
}

// Exact root, unique IDs, explicit parent chains, no cycles, deterministic
// root-first depth-first order: the same invariants as agentgraph.Normalize.
function normalizeGraph(graph) {
  graph = graph || {};
  const rootId = String(graph.rootId || "");
  const raw = Array.isArray(graph.nodes) ? graph.nodes : [];
  const nodes = raw.map(canonicalNode);
  if (!rootId) throw new Error("agent graph root is missing");
  const byId = new Map();
  for (const node of nodes) {
    if (!node.id) throw new Error("agent graph node ID is empty");
    if (byId.has(node.id)) throw new Error("agent graph node ID is duplicated");
    byId.set(node.id, node);
  }
  const root = byId.get(rootId);
  if (!root) throw new Error("agent graph root is missing");
  if (root.parentId) throw new Error("agent graph root has a parent");
  for (const node of nodes) {
    if (node.id === rootId) continue;
    if (!node.parentId) throw new Error("agent graph node is orphaned");
    const seen = new Set([node.id]);
    let parent = node.parentId;
    while (parent !== rootId) {
      if (seen.has(parent)) throw new Error("agent graph contains a cycle");
      seen.add(parent);
      const next = byId.get(parent);
      if (!next) throw new Error("agent graph node is orphaned");
      parent = next.parentId;
    }
  }
  const children = new Map();
  for (const node of nodes) {
    if (node.id === rootId) continue;
    if (!children.has(node.parentId)) children.set(node.parentId, []);
    children.get(node.parentId).push(node);
  }
  const lexical = (a, b) => {
    const left = Array.from(a), right = Array.from(b);
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
      const delta = left[i].codePointAt(0) - right[i].codePointAt(0);
      if (delta) return delta;
    }
    return left.length - right.length;
  };
  const compare = (a, b) => lexical(a.nickname, b.nickname) || lexical(a.role, b.role) || lexical(a.id, b.id);
  for (const list of children.values()) list.sort(compare);
  const ordered = [root];
  const append = (id) => { for (const child of children.get(id) || []) { ordered.push(child); append(child.id); } };
  append(rootId);
  return { ...graph, rootId, root, children: ordered.slice(1), nodes: ordered };
}

function positivelyLive(node) {
  node = canonicalNode(node);
  if (TERMINAL.has(node.lifecycle)) return false;
  if (node.attention === "approval" || node.attention === "user_input") return true;
  if (node.runtime === "active" || node.runtime === "idle") return true;
  return node.lifecycle === "pending" || node.lifecycle === "running";
}

function isFresh(graph, now) {
  const observed = Date.parse(graph?.observedAt || graph?.observed_at || "");
  const until = Date.parse(graph?.freshUntil || graph?.fresh_until || "");
  now = now instanceof Date ? now.getTime() : Number.isFinite(now) ? now : Date.now();
  return Number.isFinite(observed) && Number.isFinite(until) && now >= observed && now < until;
}

function verdict(rule, color, status, extra) {
  return {
    rule, color, status, runtime: "unknown", attention: "none",
    liveChildren: 0, waitingNodes: 0, approvalNodes: 0, userInputNodes: 0, errorNodes: 0,
    ...(extra || {}),
  };
}

const DERIVED_KEYS = [
  "runtime", "attention", "status", "liveChildren", "waitingNodes",
  "approvalNodes", "userInputNodes", "errorNodes",
];

function stampSince(next, prior, now) {
  const unchanged = prior?.since && DERIVED_KEYS.every((key) => next[key] === prior[key]);
  const at = now instanceof Date ? now.getTime() : Number.isFinite(now) ? now : Date.now();
  next.since = unchanged ? prior.since : new Date(at).toISOString();
  return next;
}

function reduceGraph(graph, options) {
  options = options || {};
  if (options.processState === "gone") return verdict("process-gone", "hidden", "");
  if (options.processState === "suspended") return verdict("process-suspended", "suspended", "suspended");
  const finish = (next) => stampSince(next, options.prior, options.now);
  if (!isFresh(graph, options.now)) return finish(verdict("graph-not-fresh", "gray", ""));
  let normalized;
  try {
    normalized = normalizeGraph(graph);
  } catch (_) {
    return finish(verdict("graph-not-fresh", "gray", ""));
  }
  const root = normalized.root;
  let liveChildren = 0, approvalNodes = 0, userInputNodes = 0, errorNodes = 0;
  let workingChild = false;
  for (const node of normalized.nodes) {
    const isRoot = node.id === normalized.rootId;
    const live = isRoot || positivelyLive(node);
    if (!isRoot && live) {
      liveChildren++;
      if (node.runtime === "active" || node.lifecycle === "pending" || node.lifecycle === "running") workingChild = true;
    }
    if (live && node.attention === "approval") approvalNodes++;
    if (live && node.attention === "user_input") userInputNodes++;
    if (node.runtime === "system_error" || node.lifecycle === "errored") errorNodes++;
  }
  const summary = {
    runtime: root.runtime, liveChildren, approvalNodes, userInputNodes, errorNodes,
    waitingNodes: approvalNodes + userInputNodes,
  };
  if (approvalNodes) return finish(verdict("live-approval", "red", "permission", { ...summary, attention: "approval" }));
  if (userInputNodes) return finish(verdict("live-user-input", "red", "permission", { ...summary, attention: "user_input" }));
  if (root.runtime === "active") return finish(verdict("root-active", "green", "working", summary));
  if (root.runtime === "system_error") return finish(verdict("root-system-error", "gray", "", summary));
  if (workingChild) return finish(verdict("working-descendant", "green", "delegating", summary));
  if (root.runtime === "idle") return finish(verdict("root-idle", "orange", "idle", summary));
  return finish(verdict("fallback-unknown", "gray", "", summary));
}

return { AXES, TERMINAL, RULES, LANES, PIPELINE, PROVIDER_ROWS, SOURCES, LIMITS, canonicalNode, normalizeGraph, positivelyLive, isFresh, stampSince, reduceGraph };
});
