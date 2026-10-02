import { test } from "node:test";
import assert from "node:assert/strict";
import { testHost } from "./test.ts";
import {
  agentList,
  cancelTimer,
  definePlugin,
  fetch,
  getSettings,
  lastMessage,
  notify,
  renderPanel,
  setTimer,
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
    ["command/run", { command: "fix", target: { kind: "worktree", worktree: "w" } }],
    ["command/run", { command: "fix", target: { kind: "project" } }],
    ["session/state", { session: "s", worktree: "w", state: "running" }],
    ["session/finished", { session: "s", worktree: "w" }],
    ["settings/changed", { values: { team: "ENG", on: true, junk: 3 }, secretsSet: ["token", 4] }],
    ["timer/fired", { id: "refresh" }],
    ["view/event", { panel: "issues", id: "b", kind: "click" }],
    ["panel/visible", { panel: "issues", visible: true }],
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
    { type: "command", command: "fix", target: { kind: "worktree", worktree: "w" } },
    { type: "command", command: "fix", target: { kind: "project" } },
    { type: "sessionState", session: "s", worktree: "w", state: "running" },
    { type: "sessionFinished", session: "s", worktree: "w" },
    { type: "settings", values: { team: "ENG", on: true }, secretsSet: ["token"], changed: true },
    { type: "timer", id: "refresh" },
    { type: "panelEvent", panel: "issues", id: "b", kind: "click", value: undefined },
    { type: "panelVisible", panel: "issues", visible: true },
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

test("settings and fetch replies are decoded, and an unset secret is refused without a request", () => {
  const events = recorder();
  testHost.reply(getSettings(), { values: { team: "" } });
  testHost.secrets.add("token");
  testHost.replySettings(getSettings(), { team: "x" });
  testHost.secrets.delete("token");
  assert.deepEqual(events, [
    { type: "settings", values: { team: "" }, secretsSet: [], changed: false },
    { type: "settings", values: { team: "x" }, secretsSet: ["token"], changed: false },
  ]);

  const results: unknown[] = [];
  testHost.secrets.add("token");
  const ok = fetch({ method: "GET", url: "https://a.example/x", headers: { Authorization: "{{secret:token}}" } }, (r) => results.push(r));
  const failed = fetch({ method: "GET", url: "https://a.example/y" }, (r) => results.push(r));
  testHost.replyError(failed, -32003, "request failed: offline");
  testHost.reply(ok, { status: 404, headers: { "content-type": "text/plain" }, body: "nope" });
  testHost.secrets.delete("token");
  testHost.dispatch({ jsonrpc: "2.0", method: "tick", params: { dt: 1 } });
  definePlugin({ handle: () => void fetch({ method: "GET", url: "https://a.example/z", headers: { A: "x {{secret:token}}" } }, (r) => results.push(r)) });
  testHost.notify("timer/fired", { id: "t" });
  assert.deepEqual(results, [
    { error: { code: -32003, message: "request failed: offline" } },
    { response: { status: 404, headers: { "content-type": "text/plain" }, body: "nope" } },
    { error: { code: -32602, message: "secret token is not set" } },
  ]);
  testHost.takeSent();
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
  notify("Done", "body");
  setTimer("r", 300, true);
  cancelTimer("r");
  renderPanel("issues", { kind: "spacer", id: "s" });
  const sent = testHost.takeSent().map((m) => [m.method, m.params]);
  assert.deepEqual(sent, [
    ["task/start", { title: "T", prompt: "do it" }],
    ["storage/get", { key: "k" }],
    ["storage/set", { key: "k", value: [1] }],
    ["session/last_message", { id: "s1" }],
    ["agent/list", {}],
    ["task/start", { title: "t", prompt: "p", branch: "task/kan-3", agent: "claude" }],
    ["notify", { title: "Done", body: "body" }],
    ["timer/set", { id: "r", seconds: 300, repeat: true }],
    ["timer/cancel", { id: "r" }],
    ["view/render", { panel: "issues", root: { kind: "spacer", id: "s" } }],
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
