"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  AXES, TERMINAL, RULES, LANES, PROVIDER_ROWS, SOURCES,
  canonicalNode, normalizeGraph, positivelyLive, isFresh, reduceGraph,
} = require("./states-model.js");

const NOW = Date.parse("2026-08-25T12:00:00Z");

function node(id, parentId = "", runtime = "unknown", attention = "none", lifecycle = "unknown", extra = {}) {
  return { id, parentId, runtime, attention, lifecycle, ...extra };
}

function observation(nodes, overrides = {}) {
  return {
    provider: "codex", rootId: "root", nodes, source: "codex_app_server", complete: true,
    observedAt: new Date(NOW - 1000).toISOString(),
    freshUntil: new Date(NOW + 1000).toISOString(),
    ...overrides,
  };
}

function reduce(nodes, overrides = {}, options = {}) {
  return reduceGraph(observation(nodes, overrides), { now: NOW, processState: "running", ...options });
}

test("exports the exact provider-neutral axis vocabulary", () => {
  assert.deepEqual(AXES.runtime.map(([v]) => v), ["unknown", "not_loaded", "idle", "active", "system_error"]);
  assert.deepEqual(AXES.attention.map(([v]) => v), ["none", "approval", "user_input"]);
  assert.deepEqual(AXES.lifecycle.map(([v]) => v), [
    "unknown", "pending", "running", "completed", "interrupted", "errored", "shutdown", "not_found",
  ]);
  assert.deepEqual([...TERMINAL], ["completed", "interrupted", "errored", "shutdown", "not_found"]);
});

test("canonicalizes invalid and empty axis values", () => {
  assert.deepEqual(
    canonicalNode({ id: "x", runtime: "invented", attention: "", lifecycle: null }),
    { id: "x", parentId: "", nickname: "", role: "", runtime: "unknown", attention: "none", lifecycle: "unknown" },
  );
});

test("normalizes to deterministic root-first depth-first order", () => {
  const graph = normalizeGraph(observation([
    node("b", "root", "idle", "none", "running", { nickname: "z" }),
    node("grandchild", "a", "active", "none", "running"),
    node("root"),
    node("a", "root", "idle", "none", "running", { nickname: "a" }),
  ]));
  assert.deepEqual(graph.nodes.map((n) => n.id), ["root", "a", "grandchild", "b"]);
  assert.equal(graph.root.id, "root");
  assert.deepEqual(graph.children.map((n) => n.id), ["a", "grandchild", "b"]);
});

test("sorts Unicode siblings by Go string order rather than host locale", () => {
  const graph = normalizeGraph(observation([
    node("root"),
    node("astral", "root", "idle", "none", "running", { nickname: "𐀀" }),
    node("bmp", "root", "idle", "none", "running", { nickname: "" }),
  ]));
  assert.deepEqual(graph.nodes.map((n) => n.id), ["root", "bmp", "astral"]);
});

test("rejects every structural invalidity", () => {
  const cases = [
    [observation([node("root")], { rootId: "" }), /root is missing/],
    [observation([node("other")]), /root is missing/],
    [observation([node("root"), node("")]), /ID is empty/],
    [observation([node("root"), node("root")]), /duplicated/],
    [observation([node("root", "parent")]), /root has a parent/],
    [observation([node("root"), node("child")]), /orphaned/],
    [observation([node("root"), node("child", "missing")]), /orphaned/],
    [observation([node("root"), node("a", "b"), node("b", "a")]), /cycle/],
  ];
  for (const [graph, pattern] of cases) assert.throws(() => normalizeGraph(graph), pattern);
});

test("uses a half-open freshness interval", () => {
  const graph = observation([node("root")]);
  assert.equal(isFresh(graph, Date.parse(graph.observedAt) - 1), false);
  assert.equal(isFresh(graph, Date.parse(graph.observedAt)), true);
  assert.equal(isFresh(graph, Date.parse(graph.freshUntil) - 1), true);
  assert.equal(isFresh(graph, Date.parse(graph.freshUntil)), false);
  assert.equal(isFresh({}, NOW), false);
});

test("requires affirmative child liveness and lets terminal lifecycle win", () => {
  for (const runtime of ["unknown", "not_loaded", "system_error"]) {
    assert.equal(positivelyLive(node("c", "root", runtime)), false, runtime);
  }
  for (const runtime of ["active", "idle"]) assert.equal(positivelyLive(node("c", "root", runtime)), true, runtime);
  for (const attention of ["approval", "user_input"]) {
    assert.equal(positivelyLive(node("c", "root", "unknown", attention)), true, attention);
  }
  for (const lifecycle of ["pending", "running"]) {
    assert.equal(positivelyLive(node("c", "root", "unknown", "none", lifecycle)), true, lifecycle);
  }
  for (const lifecycle of TERMINAL) {
    assert.equal(positivelyLive(node("c", "root", "active", "approval", lifecycle)), false, lifecycle);
  }
});

test("ports the reducer priority table", () => {
  const cases = [
    ["unknown root", [node("root")], ["fallback-unknown", "gray", ""]],
    ["not-loaded root", [node("root", "", "not_loaded")], ["fallback-unknown", "gray", ""]],
    ["idle root", [node("root", "", "idle")], ["root-idle", "orange", "idle"]],
    ["active root", [node("root", "", "active")], ["root-active", "green", "working"]],
    ["root error", [node("root", "", "system_error")], ["root-system-error", "gray", ""]],
    ["root approval", [node("root", "", "idle", "approval")], ["live-approval", "red", "permission"]],
    ["root question", [node("root", "", "idle", "user_input")], ["live-user-input", "red", "permission"]],
    ["child active", [node("root"), node("c", "root", "active")], ["working-descendant", "green", "delegating"]],
    ["child pending", [node("root"), node("c", "root", "unknown", "none", "pending")], ["working-descendant", "green", "delegating"]],
    ["child running", [node("root"), node("c", "root", "unknown", "none", "running")], ["working-descendant", "green", "delegating"]],
    ["idle child is live but not work", [node("root"), node("c", "root", "idle")], ["fallback-unknown", "gray", ""]],
    ["root active beats child work", [node("root", "", "active"), node("c", "root", "active")], ["root-active", "green", "working"]],
    ["root error beats child work", [node("root", "", "system_error"), node("c", "root", "active")], ["root-system-error", "gray", ""]],
    ["child work beats root idle", [node("root", "", "idle"), node("c", "root", "active")], ["working-descendant", "green", "delegating"]],
    ["child wait beats root work", [node("root", "", "active"), node("c", "root", "idle", "user_input", "running")], ["live-user-input", "red", "permission"]],
  ];
  for (const [name, nodes, expected] of cases) {
    const got = reduce(nodes);
    assert.deepEqual([got.rule, got.color, got.status], expected, name);
  }
});

test("counts live, waiting, and error nodes exactly", () => {
  const got = reduce([
    node("root", "", "idle", "approval", "running"),
    node("question", "root", "idle", "user_input", "running"),
    node("topology", "root", "not_loaded"),
    node("failed", "root", "system_error", "approval", "errored"),
  ]);
  assert.equal(got.rule, "live-approval");
  assert.equal(got.attention, "approval");
  assert.equal(got.liveChildren, 1);
  assert.equal(got.approvalNodes, 1);
  assert.equal(got.userInputNodes, 1);
  assert.equal(got.waitingNodes, 2);
  assert.equal(got.errorNodes, 1);
});

test("gives retained unknown topology zero liveness", () => {
  const got = reduce([
    node("root", "", "idle", "none", "running"),
    node("child", "root", "not_loaded", "none", "unknown"),
  ]);
  assert.equal(got.status, "idle");
  assert.equal(got.liveChildren, 0);
});

test("ignores stale fields on terminal children while retaining error detail", () => {
  const got = reduce([
    node("root", "", "idle"),
    node("done", "root", "active", "approval", "completed"),
    node("failed", "root", "active", "user_input", "errored"),
  ]);
  assert.equal(got.status, "idle");
  assert.equal(got.liveChildren, 0);
  assert.equal(got.waitingNodes, 0);
  assert.equal(got.errorNodes, 1);
});

test("reduces invalid and non-fresh observations to unknown", () => {
  const expired = reduceGraph(observation([node("root", "", "active")], {
    freshUntil: new Date(NOW).toISOString(),
  }), { now: NOW, processState: "running" });
  const invalid = reduceGraph(observation([node("root"), node("orphan")]), { now: NOW, processState: "running" });
  assert.equal(expired.rule, "graph-not-fresh");
  assert.equal(invalid.rule, "graph-not-fresh");
  assert.equal(expired.status, "");
  assert.equal(invalid.status, "");
});

test("keeps source, completeness, metadata, and usage out of reduction", () => {
  const nodes = [node("root", "", "active", "none", "running", {
    nickname: "name", role: "reviewer", description: "content", usage: { totalTokens: 42 },
  })];
  const variants = [
    { source: "hook", complete: false },
    { source: "restored_last_known", complete: true },
    { source: "unknown", complete: false },
  ];
  const summaries = variants.map((variant) => reduce(nodes, variant));
  assert.ok(summaries.every((summary) => summary.status === "working" && summary.rule === "root-active"));
});

test("carries Summary.Since only while every derived field is unchanged", () => {
  const bounds = { freshUntil: new Date(NOW + 20000).toISOString() };
  const first = reduce([node("root", "", "idle")], bounds);
  const unchanged = reduce([node("root", "", "idle")], bounds, { now: NOW + 5000, prior: first });
  const countChanged = reduce([
    node("root", "", "idle"), node("child", "root", "idle"),
  ], bounds, { now: NOW + 10000, prior: unchanged });
  assert.equal(unchanged.since, first.since);
  assert.equal(countChanged.status, first.status);
  assert.notEqual(countChanged.since, first.since);
  assert.equal(countChanged.since, new Date(NOW + 10000).toISOString());
});

test("process state overlays the graph", () => {
  const graph = observation([node("root", "", "active", "approval", "running")]);
  assert.deepEqual(
    [reduceGraph(graph, { now: NOW, processState: "gone" }).rule, reduceGraph(graph, { now: NOW, processState: "gone" }).color],
    ["process-gone", "hidden"],
  );
  assert.deepEqual(
    [reduceGraph(graph, { now: NOW, processState: "suspended" }).rule, reduceGraph(graph, { now: NOW, processState: "suspended" }).color],
    ["process-suspended", "suspended"],
  );
});

test("makes every documented resolution rule reachable", () => {
  const graphs = [
    reduceGraph(observation([node("root")]), { now: NOW, processState: "gone" }),
    reduceGraph(observation([node("root")]), { now: NOW, processState: "suspended" }),
    reduce([node("root")], { freshUntil: new Date(NOW).toISOString() }),
    reduce([node("root", "", "idle", "approval")]),
    reduce([node("root", "", "idle", "user_input")]),
    reduce([node("root", "", "active")]),
    reduce([node("root", "", "system_error")]),
    reduce([node("root"), node("c", "root", "active")]),
    reduce([node("root", "", "idle")]),
    reduce([node("root")]),
  ];
  assert.deepEqual(new Set(graphs.map((v) => v.rule)), new Set(RULES.map(([id]) => id)));
});

test("documents the exact source enum and coordinator ranks", () => {
  assert.deepEqual(SOURCES.map(([source]) => source), [
    "codex_app_server", "hook", "claude_transcript", "codex_rollout", "restored_last_known",
  ]);
  assert.deepEqual(SOURCES.map(([, , rank]) => rank), [4, 3, 4, 2, 1]);
  assert.ok(PROVIDER_ROWS.some(([field]) => field === "Rotation / restart"));
  assert.ok(PROVIDER_ROWS.some(([field]) => field === "Bounds"));
});

test("maps every timeline lane to a documented display color", () => {
  const colors = new Set(RULES.map(([, , color]) => color));
  for (const [lane, color] of LANES) assert.ok(colors.has(color), `${lane}: ${color}`);
});

test("contains no obsolete writer-state architecture claims", () => {
  const root = path.join(__dirname, "..");
  const text = [
    "states.html", "states.js", "states.css", "states-model.js",
  ].map((file) => fs.readFileSync(path.join(__dirname, file), "utf8"))
    .concat(fs.readFileSync(path.join(root, "README.md"), "utf8"))
    .join("\n");
  for (const obsolete of [
    "internal/writerstate", "docs/writer-state-model.md", "ToolInFlight", "6 × 11", "66 cells",
    "seven states", "thirteen kinds", "Two Divergent Cells", "Four Unimplemented Transitions",
  ]) assert.equal(text.includes(obsolete), false, obsolete);
  for (const current of [
    "internal/agentgraph", "internal/provider/claude", "internal/provider/codex",
  ]) assert.equal(text.includes(current), true, current);
});

test("gives every DOM lookup a rendered host", () => {
  const html = fs.readFileSync(path.join(__dirname, "states.html"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "states.js"), "utf8");
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const lookups = [...script.matchAll(/getElementById\("([^"]+)"\)/g)].map((match) => match[1]);
  for (const id of lookups) assert.ok(ids.has(id), `missing #${id}`);
  assert.ok(html.indexOf('src="states-model.js"') < html.indexOf('src="states.js"'));
});
