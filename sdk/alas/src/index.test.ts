import { test } from "node:test";
import assert from "node:assert/strict";
import { testHost } from "./test.ts";
import {
  agentList,
  cancelTimer,
  definePlugin,
  fetch,
  fileList,
  fileRead,
  fileWrite,
  getSettings,
  lastMessage,
  notify,
  processRun,
  processStart,
  processStop,
  promptsSet,
  renderPanel,
  reviewComment,
  runOutput,
  runStart,
  sessionSend,
  setDecorations,
  setTimer,
  parseAgents,
  parseLastMessage,
  request,
  requestSnapshot,
  storageGet,
  storageKeys,
  storageSet,
  taskStart,
  usageLimits,
  usageTurns,
  webPost,
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
  assert.deepEqual(events, [{ type: "activate", api: 4, projectId: "p", projectName: "Proj", grants: ["workspace.read"] }]);
});

test("activation names the SSH host of a remote project", () => {
  const events = recorder();
  testHost.dispatch({ jsonrpc: "2.0", id: 0, method: "alas/activate", params: { api: 10, project: { id: "p", name: "Proj", host: "devbox" }, grants: [] } });
  assert.deepEqual(events, [{ type: "activate", api: 10, projectId: "p", projectName: "Proj", host: "devbox", grants: [] }]);
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
    ["command/run", { command: "x", target: { kind: "file", worktree: "w", path: "a.ts", extra: 1 } }],
    ["command/run", { command: "x", target: { kind: "runReport", worktree: "w", run: "r" } }],
    ["command/run", { command: "x", target: { kind: "message", session: "s", text: "hi" } }],
    ["command/run", { command: "x", target: { kind: "commit", worktree: "w" } }],
    ["command/run", { command: "x", target: { kind: "toString" } }],
    ["session/state", { session: "s", worktree: "w", state: "running" }],
    ["session/finished", { session: "s", worktree: "w" }],
    ["settings/changed", { values: { team: "ENG", on: true, junk: 3 }, secretsSet: ["token", 4] }],
    ["timer/fired", { id: "refresh" }],
    ["view/event", { panel: "issues", id: "b", kind: "click" }],
    ["panel/visible", { panel: "issues", visible: true }],
    ["panel/visible", { panel: "explain", run: "r", visible: true }],
    ["view/event", { panel: "checks", worktree: "w", id: "b", kind: "click" }],
    ["git/changed", { worktree: "w" }],
    ["worktree/removed", { worktree: "w" }],
    ["run/started", { worktree: "w", script: "repo:dev.sh", run: "r" }],
    ["run/finished", { worktree: "w", script: "repo:dev.sh", run: "r", outcome: "failed", exitCode: 2 }],
    ["run/finished", { worktree: "w", script: "repo:dev.sh", run: "r", outcome: "stopped" }],
    ["run/finished", { worktree: "w", script: "repo:dev.sh", run: "r", outcome: "exploded" }],
    ["review/changed", { worktree: "w", state: "open", number: 7, checks: { passed: 3, failed: 1, pending: 0 } }],
    ["review/changed", { worktree: "w", state: "none" }],
    ["process/exited", { run: "p1", exit: 143 }],
    ["storage/changed", { scope: "plugin", key: "library" }],
    ["storage/changed", { scope: "project", key: "x" }],
    ["tab/visible", { tab: 0, visible: false }],
    ["tab/visible", { tab: "0", visible: true }],
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
    { type: "command", command: "x", target: { kind: "file", worktree: "w", path: "a.ts" } },
    { type: "command", command: "x", target: { kind: "runReport", worktree: "w", run: "r" } },
    { type: "command", command: "x", target: { kind: "message", session: "s", text: "hi" } },
    { type: "sessionState", session: "s", worktree: "w", state: "running" },
    { type: "sessionFinished", session: "s", worktree: "w" },
    { type: "settings", values: { team: "ENG", on: true }, secretsSet: ["token"], changed: true },
    { type: "timer", id: "refresh" },
    { type: "panelEvent", panel: "issues", id: "b", kind: "click", value: undefined },
    { type: "panelVisible", panel: "issues", visible: true },
    { type: "panelVisible", panel: "explain", run: "r", visible: true },
    { type: "panelEvent", panel: "checks", worktree: "w", id: "b", kind: "click", value: undefined },
    { type: "gitChanged", worktree: "w" },
    { type: "worktreeRemoved", worktree: "w" },
    { type: "runStarted", worktree: "w", script: "repo:dev.sh", run: "r" },
    { type: "runFinished", worktree: "w", script: "repo:dev.sh", run: "r", outcome: "failed", exitCode: 2 },
    { type: "runFinished", worktree: "w", script: "repo:dev.sh", run: "r", outcome: "stopped" },
    { type: "reviewChanged", worktree: "w", state: "open", number: 7, checks: { passed: 3, failed: 1, pending: 0 } },
    { type: "reviewChanged", worktree: "w", state: "none" },
    { type: "processExited", run: "p1", exit: 143 },
    { type: "storageChanged", scope: "plugin", key: "library" },
    { type: "tabVisible", tab: 0, visible: false },
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

test("API 6 requests decode their replies, and a malformed one is an error", () => {
  recorder();
  const outcomes: unknown[] = [];
  const push = (o: unknown) => outcomes.push(o);
  const output = runOutput("r", push);
  const kept = runOutput("r2", push);
  const ran = processRun("lint", "w", { args: ["--fix"], stdin: "x" }, push);
  const started = processStart("dev", "w", undefined, push);
  const read = fileRead("w", "a.ts", push);
  const listed = fileList("w", "", push);
  const refused = fileRead("w", ".git/config", push);
  const keys = storageKeys(push, "plugin");
  assert.deepEqual(testHost.takeSent().map((m) => [m.method, m.params]), [
    ["run/output", { run: "r" }],
    ["run/output", { run: "r2" }],
    ["process/run", { id: "lint", worktree: "w", args: ["--fix"], stdin: "x" }],
    ["process/start", { id: "dev", worktree: "w" }],
    ["file/read", { worktree: "w", path: "a.ts" }],
    ["file/list", { worktree: "w", dir: "" }],
    ["file/read", { worktree: "w", path: ".git/config" }],
    ["storage/keys", { scope: "plugin" }],
  ]);
  testHost.reply(listed, { entries: [{ name: "src", kind: "directory" }], truncated: false });
  testHost.reply(output, { output: null, truncated: false });
  testHost.reply(kept, { output: "ok\n", truncated: true });
  testHost.reply(ran, { exit: 1, stdout: "", stderr: "bad", truncated: false, timedOut: false });
  testHost.reply(started, { run: "p1" });
  testHost.reply(read, { content: 5 });
  testHost.replyError(refused, -32003, ".git is refused");
  testHost.reply(keys, { keys: ["a", "b"] });
  assert.deepEqual(outcomes, [
    { result: { entries: [{ name: "src", kind: "directory" }], truncated: false } },
    { result: { output: null, truncated: false } },
    { result: { output: "ok\n", truncated: true } },
    { result: { exit: 1, stdout: "", stderr: "bad", truncated: false, timedOut: false } },
    { result: "p1" },
    { error: { code: -32603, message: "malformed file/read reply" } },
    { error: { code: -32003, message: ".git is refused" } },
    { result: ["a", "b"] },
  ]);
});

test("requests from Alas are answered with their id, now or in a later call, once", () => {
  definePlugin({
    handle(event) {
      if (event.type === "contextProvide") event.respond(event.worktree === "w" ? "Design doc" : null);
      if (event.type === "promptExpand" && event.name === "bad") event.fail("no such issue");
      if (event.type === "promptExpand" && event.name === "linear") {
        fetch({ method: "GET", url: `https://a.example/${event.args}` }, ({ response }) => {
          event.respond(`Fix ${event.args}: ${response?.body}`);
          event.respond("ignored");
        });
      }
    },
  });
  testHost.takeSent();
  testHost.dispatch({ jsonrpc: "2.0", id: 4, method: "context/provide", params: { session: "s", worktree: "w" } });
  testHost.dispatch({ jsonrpc: "2.0", id: 5, method: "context/provide", params: { session: "s", worktree: "x" } });
  testHost.dispatch({ jsonrpc: "2.0", id: 6, method: "prompt/expand", params: { name: "bad", args: "", session: "s" } });
  assert.deepEqual(testHost.takeSent(), [
    { jsonrpc: "2.0", id: 4, result: { text: "Design doc" } },
    { jsonrpc: "2.0", id: 5, result: { text: null } },
    { jsonrpc: "2.0", id: 6, error: { code: -32000, message: "no such issue" } },
  ]);

  // Answered in a later call, after the plugin's own request.
  testHost.dispatch({ jsonrpc: "2.0", id: 1, method: "prompt/expand", params: { name: "linear", args: "ENG-1", session: "s" } });
  const [fetched] = testHost.takeSent();
  assert.equal(fetched.method, "http/fetch");
  testHost.reply(fetched.id, { status: 200, headers: {}, body: "login" });
  assert.deepEqual(testHost.takeSent(), [{ jsonrpc: "2.0", id: 1, result: { text: "Fix ENG-1: login" } }]);
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
  renderPanel("checks", { kind: "spacer", id: "s" }, { worktree: "w" });
  setDecorations("changes.file", "a.ts", [{ text: "lint", tone: "warn", command: "fix" }], "w");
  sessionSend("s", "hi");
  runStart("w", "repo:dev.sh");
  reviewComment("w", "a.ts", 3, "why?");
  processStop("p1");
  fileWrite("w", "a.ts", "x");
  storageGet("lib", "plugin");
  storageSet("lib", null, "plugin");
  promptsSet([{ name: "deploy", description: "Ship it" }, { name: "x" }]);
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
    ["view/render", { panel: "checks", worktree: "w", root: { kind: "spacer", id: "s" } }],
    ["decorations/set", { slot: "changes.file", target: "a.ts", worktree: "w", items: [{ text: "lint", tone: "warn", command: "fix" }] }],
    ["session/send", { session: "s", text: "hi" }],
    ["run/start", { worktree: "w", script: "repo:dev.sh" }],
    ["review/comment", { worktree: "w", path: "a.ts", line: 3, body: "why?" }],
    ["process/stop", { run: "p1" }],
    ["file/write", { worktree: "w", path: "a.ts", content: "x" }],
    ["storage/get", { key: "lib", scope: "plugin" }],
    ["storage/set", { key: "lib", value: null, scope: "plugin" }],
    ["prompts/set", { prompts: [{ name: "deploy", description: "Ship it" }, { name: "x" }] }],
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

test("web pages and recorded turns arrive as events, and posts go to the tab", () => {
  const events = recorder();
  const turn = { id: 7, session: "s", worktree: "w", agent: "claude", startedAt: 1, endedAt: 9, result: "completed", tokens: { total: 5, input: 5 } };
  testHost.notify("web/message", { tab: 0, message: { ready: true } });
  testHost.notify("web/message", { tab: 0, message: null });
  testHost.notify("web/message", { tab: 0 });
  testHost.notify("turn/finished", { session: "s", worktree: "w", turn });
  testHost.notify("turn/finished", { session: "s", worktree: "w", turn: { ...turn, result: "exploded" } });
  webPost(0, { points: [3] });
  assert.deepEqual(events, [
    { type: "webMessage", tab: 0, message: { ready: true } },
    { type: "webMessage", tab: 0, message: null },
    {
      type: "turnFinished", session: "s", worktree: "w",
      turn: { ...turn, tokens: { total: 5, input: 5, cachedInput: 0, cachedWrite: 0, output: 0, reasoningOutput: 0 } },
    },
  ]);
  assert.deepEqual(testHost.takeSent(), [{ jsonrpc: "2.0", method: "web/post", params: { tab: 0, message: { points: [3] } } }]);
});

test("usage pages decode their entries and cursor, skipping malformed entries", () => {
  recorder();
  const outcomes: unknown[] = [];
  const push = (o: unknown) => outcomes.push(o);
  const cursor = { before: 100, beforeId: 40 };
  const turns = usageTurns({ since: 0, limit: 1000, scope: "all", cursor }, push);
  const limits = usageLimits({ since: 0 }, push);
  const broken = usageTurns({ since: 0 }, push);
  assert.deepEqual(testHost.takeSent().map((m) => [m.method, m.params]), [
    ["usage/turns", { since: 0, limit: 1000, scope: "all", cursor }],
    ["usage/limits", { since: 0 }],
    ["usage/turns", { since: 0 }],
  ]);
  const cost = { amount: 0.5, currency: "USD" };
  testHost.reply(turns, {
    turns: [{ id: 2, session: "s", agent: "a", model: "m", startedAt: 1, endedAt: 2, result: "limited", cost }, { id: "x" }],
    truncated: true,
    next: { before: 2, beforeId: 2 },
  });
  testHost.reply(limits, { limits: [{ session: "s", agent: "a", detectedAt: 5, resetsAt: 9, resetSource: "parsed" }, { session: "s", agent: "a", detectedAt: 6 }], truncated: false });
  testHost.reply(broken, { truncated: false });
  assert.deepEqual(outcomes, [
    { result: { items: [{ id: 2, session: "s", model: "m", agent: "a", startedAt: 1, endedAt: 2, result: "limited", cost }], next: { before: 2, beforeId: 2 } } },
    { result: { items: [
      { session: "s", agent: "a", detectedAt: 5, resetsAt: 9, resetSource: "parsed" },
      { session: "s", agent: "a", detectedAt: 6, resetSource: "unknown" },
    ] } },
    { error: { code: -32603, message: "malformed usage/turns reply" } },
  ]);
});
