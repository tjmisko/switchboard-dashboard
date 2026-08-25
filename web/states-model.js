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
  ["provider machines", "apply hook edges, timers, and level reconciliation to provider-owned state"],
  ["agent graph", "normalizes explicit parentage and reduces three independent axes"],
  ["pure projections", "reduces one root chip and separately diffs node axes into history edges"],
];

// The daemon does not have one provider-neutral transition table. These are the
// finite control regions that actually carry memory on main. A region is shown
// independently because the complete provider state is their product, plus
// maps keyed by writer, node, request, and hook edge.
//
// Transition tuples are [from, event, to, evidence kind, qualification].
// `from` may be "*" or a list; `to = "="` means this region holds while another
// region changes. Level transitions are reconciliation assignments, not hook
// edges. The charts deliberately do not pretend either provider has a total
// Apply(State, Evidence) table.
const PROVIDER_MACHINES = [
  {
    id: "claude",
    label: "Claude",
    implementation: "internal/provider/claude.Observer · rootState",
    summary: "Hook edges mutate root runtime and one pending-prompt latch per writer; transcript and fanout scans reconcile those beliefs.",
    shape: "rootState = runtime × pending[writer] × overlays[child] × fanout × known/retained × priorSummary",
    regions: [
      {
        id: "root-runtime",
        label: "root runtime",
        initial: "unknown",
        note: "Only the main writer changes this region. Child activity is projected on child nodes.",
        states: [
          ["unknown", "No root runtime edge has been established.", "gray"],
          ["idle", "The root is loaded and not processing a turn.", "orange"],
          ["active", "The root is processing a turn.", "green"],
        ],
        transitions: [
          ["*", "exact session ID changes", "unknown", "reset", "A new rootState replaces the old session."],
          ["*", "SessionStart", "idle", "hook", "Root hook."],
          ["*", "root UserPromptSubmit", "active", "hook", "Also starts a new terminal-child cohort."],
          ["*", "root PostToolUse", "active", "hook", "Runtime advances even when attention cannot yet clear."],
          ["*", "root Stop", "idle", "hook", "Stop does not itself clear a pending prompt."],
          ["idle", "new transcript activity after runtimeAt", "active", "level", "Re-readable tail correction."],
          ["active", "new transcript interrupt after runtimeAt", "idle", "level", "Re-readable tail correction."],
          ["*", "root pending transcript resolves resumed", "active", "level", "Clears the root writer's prompt latch."],
          ["*", "root pending resolves interrupted or stale", "idle", "level", "Interrupt, unreadable-main TTL, or quiescent-writer cap."],
          ["*", "PermissionRequest or child-only hook", "=", "hook", "Mutates attention or a child overlay, not root runtime."],
        ],
      },
      {
        id: "writer-attention",
        label: "per-writer attention",
        initial: "none",
        note: "This is map[writer]PendingPrompt. The writer key is empty for the root and an exact child ID otherwise.",
        states: [
          ["none", "No pending human-owned prompt for this writer.", "gray"],
          ["approval", "PermissionRequest for any non-question tool.", "red"],
          ["user_input", "PermissionRequest for AskUserQuestion.", "red"],
        ],
        transitions: [
          ["*", "PermissionRequest · other tool", "approval", "hook", "Creates or replaces only this writer's latch."],
          ["*", "PermissionRequest · AskUserQuestion", "user_input", "hook", "Creates or replaces only this writer's latch."],
          [["approval", "user_input"], "owned matching PostToolUse", "none", "hook", "Held for the root while fanout still reports in-flight work."],
          [["approval", "user_input"], "writer transcript resumes", "none", "level", "ResolutionResumed."],
          [["approval", "user_input"], "writer transcript interrupts", "none", "level", "ResolutionInterrupted."],
          [["approval", "user_input"], "child becomes terminal", "none", "level", "The fanout snapshot closes only that child's prompt."],
          [["approval", "user_input"], "unreadable main past PermissionDecayTTL", "none", "timer", "Configured bounded backstop."],
          [["approval", "user_input"], "quiescent writer past PendingWriterStaleCap", "none", "timer", "Only when its tail does not still prove an unanswered tool."],
          [["approval", "user_input"], "mismatched result, Stop, or unresolved tail", "=", "hold", "None proves that this exact prompt resolved."],
          ["*", "exact session ID changes", "none", "reset", "The old session's writer map is retired."],
        ],
      },
      {
        id: "child-lifecycle",
        label: "child lifecycle",
        initial: "not_projected",
        note: "Fanout artifacts own identity and lifecycle. Subagent hooks only invalidate the scan; activity hooks may overlay runtime after identity exists.",
        states: [
          ["not_projected", "No retained node in the current graph cohort.", "gray"],
          ["pending", "Child artifact exists; transcript is not loaded yet.", "blue"],
          ["running", "Transcript/workflow evidence says the child is live.", "green"],
          ["completed", "Result or done evidence closed the child.", "gray"],
          ["interrupted", "Quiescence force-closed the child.", "purple"],
        ],
        transitions: [
          ["*", "artifact exists; transcript absent", "pending", "level", "fanout.Snapshot classification."],
          ["*", "live transcript or workflow", "running", "level", "fanout.Snapshot classification."],
          ["not_projected", "child PermissionRequest before artifact", "running", "hook", "A writer-owned prompt creates a bounded placeholder node."],
          ["*", "result or done evidence", "completed", "level", "Terminal lifecycle suppresses stale runtime and attention."],
          ["*", "child transcript stale past cap", "interrupted", "timer", "Conservative force-close."],
          [["completed", "interrupted"], "next root UserPromptSubmit", "not_projected", "reset", "Clears the retained prior-turn terminal cohort."],
          ["*", "SubagentStart or SubagentStop", "=", "hook", "Requests a rescan; never creates or closes topology directly."],
          ["*", "known-child activity hook", "=", "hook", "Changes only the child's runtime overlay."],
        ],
      },
    ],
  },
  {
    id: "codex",
    label: "Codex",
    implementation: "internal/provider/codex graphState + codexHookRootState",
    summary: "A read-only app-server owns topology and base node fields; exact hooks add bounded root latches, approval timers, and child overlays where that feed is insufficient.",
    shape: "state = graphState(nodes[id]{baseRuntime,lifecycle,wait}) × hookRootState{session,retired,pending,approvals,overlays,queue}",
    regions: [
      {
        id: "node-runtime",
        label: "node runtime",
        initial: "unknown",
        note: "A newer hook can publish an immediate root edge. On later app-server samples, remembered hook fields fill only unknown/not_loaded roots and never outlive their original deadline.",
        states: [
          ["unknown", "No usable runtime, or an unclassified mechanical wait.", "gray"],
          ["not_loaded", "Thread exists but this app-server has not loaded it.", "blue"],
          ["idle", "Loaded, no active turn.", "orange"],
          ["active", "Turn or hook activity is in flight.", "green"],
          ["system_error", "Codex reported a runtime failure.", "purple"],
        ],
        transitions: [
          ["*", "thread status · notLoaded", "not_loaded", "level", "Direct enum mapping."],
          ["*", "thread status · idle", "idle", "level", "Direct enum mapping."],
          ["*", "thread status · active or turn/started", "active", "level", "Direct enum mapping."],
          ["*", "thread status · systemError", "system_error", "level", "Direct enum mapping."],
          ["*", "unclassified waiting flag", "unknown", "level", "Raw waiting is neither green nor red without ownership evidence."],
          ["*", "SessionStart · compact", "active", "hook", "Partial root projection."],
          ["*", "SessionStart · non-compact", "idle", "hook", "startup/resume/clear settle for 250 ms before publication."],
          ["*", "UserPromptSubmit, ordinary PreToolUse, or any PostToolUse", "active", "hook", "Partial root projection."],
          ["*", "Stop", "idle", "hook", "Partial root projection."],
          ["*", "request_user_input PreToolUse", "idle", "hook", "The question latch also sets attention=user_input."],
          ["*", "generic PermissionRequest during grace", "active", "hook", "Ownership is unresolved; no red yet."],
          ["*", "human-input PermissionRequest or approval timeout", "idle", "hook", "Attention carries the reason."],
          ["*", "turn/completed", "=", "protocol", "Clears waits; a status update owns runtime."],
        ],
      },
      {
        id: "request-owner",
        label: "per-request ownership",
        initial: "resolved",
        note: "This is requestEvidence.owner. Only human projects attention; automatic and ignored requests remain visible only as provider state/diagnostics.",
        states: [
          ["resolved", "No retained request with this request ID.", "gray"],
          ["pending", "Request exists; human versus automatic owner is unknown.", "orange"],
          ["human", "Confirmed human approval or blocking input.", "red"],
          ["automatic", "Reviewer, guardian, or auto-review owns it.", "blue"],
          ["ignored", "Input is nonblocking or auto-resolving.", "gray"],
        ],
        transitions: [
          ["resolved", "approval request · unknown reviewer", "pending", "protocol", "Starts the 30 s classifier."],
          ["resolved", "approval request · known user reviewer", "human", "protocol", "Publishes approval immediately."],
          ["resolved", "approval request · auto/guardian evidence", "automatic", "protocol", "Suppresses human attention."],
          ["resolved", "blocking requestUserInput or MCP elicitation", "human", "protocol", "Publishes user_input immediately."],
          ["resolved", "nonblocking or auto-resolving input", "ignored", "protocol", "Never asks the operator."],
          ["pending", "reviewer=user", "human", "protocol", "Explicit ownership evidence."],
          ["pending", "reviewer=auto, guardian, or auto-review", "automatic", "protocol", "Explicit automatic ownership evidence."],
          ["pending", "classification timeout", "human", "timer", "Request-backed ambiguity falls back to human."],
          ["human", "late auto-review evidence after timeout", "automatic", "protocol", "Clears a fallback red."],
          [["pending", "human", "automatic", "ignored"], "serverRequest/resolved or thread wait closes", "resolved", "protocol", "Also cleared by turn completion and thread removal."],
        ],
      },
      {
        id: "question-latch",
        label: "hook question latch",
        initial: "closed",
        note: "This latch exists because the standard interactive CLI's question is not reconstructible from the disposable app-server.",
        states: [
          ["closed", "No exact request_user_input hook is outstanding.", "gray"],
          ["open", "At least one exact request_user_input call is outstanding.", "red"],
        ],
        transitions: [
          ["*", "request_user_input PreToolUse", "open", "hook", "Keyed by tool-use ID, otherwise writer/turn/tool/hash."],
          ["open", "matching request_user_input PostToolUse", "closed", "hook", "Clears only matching entries; closes when the map is empty."],
          ["open", "matching Stop", "closed", "hook", "Turn/writer-scoped; closes when the map is empty."],
          ["open", "session rotation or root removal", "closed", "reset", "Retires the old session."],
          ["open", "generic app-server snapshot", "=", "hold", "Cannot clear independently owned hook evidence."],
          ["open", "daemon restart", "closed", "reset", "The latch is not reconstructed; status degrades to unknown."],
        ],
      },
      {
        id: "hook-approval",
        label: "generic hook approval",
        initial: "clear",
        note: "A generic PermissionRequest cannot say whether the user or Auto-review owns the gate, so it receives a separate bounded grace machine.",
        states: [
          ["clear", "No generic hook gate is pending.", "gray"],
          ["grace", "Gate observed; waiting for automatic progress or app-server evidence.", "orange"],
          ["published", "Grace expired without contrary evidence; approval is red.", "red"],
        ],
        transitions: [
          ["*", "generic PermissionRequest", "grace", "hook", "Starts or replaces a 30 s timer for the exact tool call."],
          ["grace", "matching Pre/PostToolUse, Stop, or new turn", "clear", "hook", "Progress resolved the gate before red."],
          ["grace", "newer app-server active with no attention", "clear", "level", "Structured evidence settles it as non-human."],
          ["grace", "another proven human wait already exists", "clear", "level", "Avoids overwriting independently proven attention."],
          ["grace", "30 s unresolved", "published", "timer", "Fallback publishes attention=approval."],
          ["published", "matching progress, Stop, or new turn", "clear", "hook", "Owns the corresponding red-clear transition."],
          [["grace", "published"], "session rotation or root removal", "clear", "reset", "Cancels the timer and retires the gate."],
        ],
      },
      {
        id: "child-hook",
        label: "child hook overlay",
        initial: "provider_owned",
        note: "Hooks never create or reparent a Codex child. They are queued until a fresh app-server graph proves the exact non-root ID.",
        states: [
          ["provider_owned", "App-server fields are the current authority.", "blue"],
          ["queued", "Exact child edge awaits topology proof.", "orange"],
          ["active_overlay", "SubagentStart owns active/running fields temporarily.", "green"],
          ["completed_overlay", "SubagentStop owns idle/completed fields until superseded.", "gray"],
        ],
        transitions: [
          ["*", "SubagentStart or SubagentStop", "queued", "hook", "Root/session and agent ID must be exact; queue is bounded."],
          ["queued", "fresh topology matches · SubagentStart", "active_overlay", "level", "Expires after at most 10 minutes."],
          ["queued", "fresh topology matches · SubagentStop", "completed_overlay", "level", "Retains the completed child."],
          ["queued", "no topology match for 10 minutes", "provider_owned", "timer", "The edge expires without inventing a node."],
          ["active_overlay", "10 minute cap", "provider_owned", "timer", "Restores the last provider fields."],
          [["active_overlay", "completed_overlay"], "provider field at least as new", "provider_owned", "level", "Supersedes only the fields the hook owned."],
          [["active_overlay", "completed_overlay"], "complete snapshot omits child", "provider_owned", "level", "Drops the overlay with the omitted topology."],
          ["completed_overlay", "later SubagentStart", "queued", "hook", "A proved later start can reopen the child."],
        ],
      },
    ],
  },
];

const OLD_MODEL_DIVERGENCES = [
  ["Provenance", "The seven-state table described the running daemon.", "It was executable code in unmerged commit 2040a91; it is not an ancestor of main."],
  ["State shape", "One flat state per writer.", "Provider state is a product of runtime, attention ownership, lifecycle, timers, and keyed maps."],
  ["Blocked", "A writer enters one Blocked state.", "Human attention is orthogonal to runtime. Codex first classifies human versus automatic ownership."],
  ["ToolInFlight", "A shared state distinguished machine waits from human waits.", "No such shared state exists on main. Tool progress remains provider evidence, usually projected as runtime=active."],
  ["Evidence", "Thirteen provider-neutral evidence kinds feed one total table.", "Claude hooks/transcripts/artifacts and Codex hooks/app-server notifications have different authority and recovery rules."],
  ["Fold", "Any active writer makes green; any Blocked writer makes red.", "Only live-node attention makes red. Root activity/error precedes descendant work; a child needs affirmative liveness."],
  ["End / death", "Ended, Interrupted, and Dead are writer states.", "Root idle is runtime; child completion/interruption is lifecycle; root process death removes the session outside the graph."],
  ["Restart", "Blocked must survive every daemon restart.", "Claude restores writer keys. Codex's hook-only question latch is deliberately not reconstructible and degrades to unknown."],
];

const PROVIDER_ROWS = [
  ["Graph authority", "Hooks + root/child transcripts + subagent/workflow artifacts.", "Read-only disposable codex app-server --stdio in auto mode; CLI >= 0.149.0. off leaves hook-only root projection."],
  ["Root state", "Hooks provide edges; transcript reconciliation corrects them.", "Concrete app-server fields win; bounded exact hooks fill unavailable root fields."],
  ["Attention", "PermissionRequest is keyed per writer; matching hooks/transcripts resolve only that writer.", "request_user_input is an exact hook latch; matching PostToolUse/Stop clears it. Request IDs and reviewer evidence classify structured waits; generic permission gets 30 s to resolve automatically."],
  ["Children", "Artifacts own identity and lifecycle; SubagentStart/Stop only request a rescan.", "App-server must first prove exact topology. Matching start → active/running for ≤10 m; stop → retained idle/completed; a later start reopens. Hooks never create or reparent."],
  ["Rotation / restart", "A new exact session drops the old root state. On daemon restart of the same session, persisted pending writer keys restore; correlators are re-earned.", "/clear advances the exact root and retires old IDs. Topology is resnapshotted; an in-memory question latch is not reconstructed."],
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

return {
  AXES, TERMINAL, RULES, LANES, PIPELINE, PROVIDER_MACHINES,
  OLD_MODEL_DIVERGENCES, PROVIDER_ROWS, SOURCES, LIMITS,
  canonicalNode, normalizeGraph, positivelyLive, isFresh, stampSince, reduceGraph,
};
});
