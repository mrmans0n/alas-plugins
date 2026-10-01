import { test } from "node:test";
import assert from "node:assert/strict";
import { testHost } from "./test.ts";
import {
  agentList,
  definePlugin,
  lastMessage,
  parseAgents,
  parseLastMessage,
  request,
  requestSnapshot,
  storageGet,
  storageSet,
  taskStart,
  type Event,
} from "./index.ts";

/** A plugin that records every event it is handed. */
function recorder(): Event[] {
  const events: Event[] = [];
  definePlugin({ handle: (event) => events.push(event) });
  testHost.takeSent();
  return events;
}

test("activation is answered before the plugin sees it", () => {
  const events = recorder();
  testHost.dispatch({ jsonrpc: "2.0", id: 0, method: "alas/activate", params: { api: 4, project: { id: "p", name: "Proj" }, grants: ["workspace.read"] } });
  assert.deepEqual(testHost.takeSent(), [{ jsonrpc: "2.0", id: 0, result: {} }]);
  assert.deepEqual(events, [{ type: "activate", projectId: "p", projectName: "Proj", grants: ["workspace.read"] }]);
});

test("requests get increasing ids and replies carry them back", () => {
  const events = recorder();
  const first = request("worktree/switch", { id: "w" });
  const second = request("session/focus", { id: "s" });
  assert.ok(second > first);
  assert.equal(testHost.takeSent()[1].id, second);

  testHost.dispatch({ jsonrpc: "2.0", id: second, error: { code: -32003, message: "unknown session s" } });
  testHost.dispatch({ jsonrpc: "2.0", id: first, result: { ok: true } });
  assert.deepEqual(events, [
    { type: "reply", id: second, error: { code: -32003, message: "unknown session s" } },
    { type: "reply", id: first, result: { ok: true } },
  ]);
});

test("notifications decode into events", () => {
  const events = recorder();
  const snapshot = { worktrees: [{ id: "w", branch: "main", current: true, sessions: [{ id: "s", agent: "claude", title: "T", state: "running", plan: { completed: 1, total: 3 } }] }] };
  for (const [method, params] of [
    ["tick", { dt: 66 }],
    ["canvas/click", { tab: 0, region: "r3" }],
    ["workspace/changed", { snapshot }],
    ["view/event", { tab: 1, id: "f", kind: "select", value: "x" }],
    ["view/event", { tab: 1, id: "b", kind: "click" }],
    ["task/failed", { sessionId: "s", reason: "boom" }],
    ["alas/deactivate", {}],
  ] as const) {
    testHost.dispatch({ jsonrpc: "2.0", method, params });
  }
  assert.deepEqual(events, [
    { type: "tick", dt: 66 },
    { type: "click", tab: 0, region: "r3" },
    { type: "workspaceChanged", snapshot },
    { type: "viewEvent", tab: 1, id: "f", kind: "select", value: "x" },
    { type: "viewEvent", tab: 1, id: "b", kind: "click", value: undefined },
    { type: "taskFailed", sessionId: "s", reason: "boom" },
    { type: "deactivate" },
  ]);
});

test("snapshot and storage replies arrive as their own events, other replies stay results", () => {
  const events = recorder();
  const snapshotId = requestSnapshot();
  const [set, unset, failed] = [storageGet("a"), storageGet("b"), storageGet("c")];
  const other = request("worktree/switch", { id: "w" });
  const snapshot = { worktrees: [{ id: "w", branch: "main", current: false, dirty: { files: 2, conflicts: 0 }, sessions: [] }] };
  testHost.dispatch({ jsonrpc: "2.0", id: snapshotId, result: { snapshot } });
  testHost.dispatch({ jsonrpc: "2.0", id: set, result: { value: { n: 1 } } });
  testHost.dispatch({ jsonrpc: "2.0", id: unset, result: { value: null } });
  testHost.dispatch({ jsonrpc: "2.0", id: failed, error: { code: -32003, message: "no" } });
  testHost.dispatch({ jsonrpc: "2.0", id: other, result: {} });
  assert.deepEqual(events, [
    { type: "snapshot", snapshot },
    { type: "stored", id: set, value: { n: 1 } },
    { type: "stored", id: unset, value: null },
    { type: "stored", id: failed, error: { code: -32003, message: "no" } },
    { type: "reply", id: other, result: {} },
  ]);
});

test("malformed messages are ignored", () => {
  const events = recorder();
  testHost.dispatch("{not json");
  testHost.dispatch({ jsonrpc: "2.0", method: "workspace/changed", params: { snapshot: 5 } });
  testHost.dispatch({ jsonrpc: "2.0", method: "tick", params: "x" });
  testHost.dispatch({ jsonrpc: "2.0", id: "x", result: {} });
  assert.deepEqual(events, []);
});

test("helpers send the documented requests", () => {
  recorder();
  taskStart("T", "do it");
  storageGet("k");
  storageSet("k", [1]);
  lastMessage("s1");
  agentList();
  taskStart("t", "p", { branch: "task/kan-3", agent: "claude" });
  const sent = testHost.takeSent().map((m) => [m.method, m.params]);
  assert.deepEqual(sent, [
    ["task/start", { title: "T", prompt: "do it" }],
    ["storage/get", { key: "k" }],
    ["storage/set", { key: "k", value: [1] }],
    ["session/last_message", { id: "s1" }],
    ["agent/list", {}],
    ["task/start", { title: "t", prompt: "p", branch: "task/kan-3", agent: "claude" }],
  ]);

  assert.equal(parseLastMessage({ message: "hi" }), "hi");
  assert.equal(parseLastMessage({ message: null }), undefined);
  assert.deepEqual(parseAgents({ agents: [{ id: "a", name: "A" }] }), [{ id: "a", name: "A" }]);
  assert.deepEqual(parseAgents({ agents: "x" }), []);
  assert.deepEqual(parseAgents(null), []);
});

test("the test host enforces the per-call send cap", () => {
  definePlugin({ handle: () => { for (let i = 0; i < 65; i++) request("log"); } });
  assert.throws(() => testHost.dispatch({ jsonrpc: "2.0", method: "tick", params: { dt: 1 } }), /64 messages/);
  testHost.takeSent();
});
