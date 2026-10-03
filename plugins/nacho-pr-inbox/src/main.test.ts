import { test } from "node:test";
import assert from "node:assert/strict";
import { testHost } from "@alas/plugin/test";
import "./main.ts";

const calls = () => testHost.takeSent().filter((m) => m.method !== "view/render").map((m) => [m.method, m.params]);
const visible = (v: boolean) => testHost.notify("tab/visible", { tab: 0, visible: v });

test("the inbox refreshes in the main worktree, and polls only while its tab is visible", () => {
  testHost.dispatch({ jsonrpc: "2.0", id: 0, method: "alas/activate", params: { api: 9, project: { id: "p", name: "P" }, grants: [] } });
  const snapshot = testHost.takeSent().find((m) => m.method === "workspace/snapshot");
  const worktree = (id: string, main = false) => ({ id, branch: id, current: false, main, sessions: [] });
  testHost.reply(snapshot.id, { snapshot: { worktrees: [worktree("feature"), worktree("trunk", true)] } });
  assert.deepEqual(calls(), [], "nothing runs while the tab is hidden");

  visible(true);
  const sent = testHost.takeSent();
  assert.deepEqual(sent.filter((m) => m.method !== "view/render").map((m) => [m.method, m.params]), [
    ["timer/set", { id: "refresh", seconds: 60, repeat: true }],
    ["process/run", { id: "list", worktree: "trunk" }],
  ]);
  const list = sent.find((m) => m.method === "process/run");
  testHost.reply(list.id, { exit: 0, stdout: JSON.stringify({ data: { repository: { nameWithOwner: "o/r", pullRequests: { nodes: [] } } } }), stderr: "" });
  testHost.takeSent();

  visible(false);
  assert.deepEqual(calls(), [["timer/cancel", { id: "refresh" }]]);
  visible(true);
  assert.deepEqual(calls(), [["timer/set", { id: "refresh", seconds: 60, repeat: true }]], "fresh data is not fetched again");
});
