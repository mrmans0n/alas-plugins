import { test } from "node:test";
import assert from "node:assert/strict";
import { testHost } from "@alas/plugin/test";
import "./main.ts";

const calls = (sent: any[]) => sent.filter((m) => !["view/render", "panel/badge"].includes(m.method)).map((m) => [m.method, m.params]);
const visible = (tab: boolean) => testHost.notify("tab/visible", { tab: 0, visible: tab });
const panel = (shown: boolean) => testHost.notify("panel/visible", { panel: "rail", visible: shown });

test("the inbox refreshes on start for the badge, every 5 minutes while hidden and every minute while shown", () => {
  testHost.dispatch({ jsonrpc: "2.0", id: 0, method: "alas/activate", params: { api: 15, project: { id: "p", name: "P" }, grants: [] } });
  const snapshot = testHost.takeSent().find((m) => m.method === "workspace/snapshot");
  const worktree = (id: string, main = false) => ({ id, branch: id, current: false, main, sessions: [] });
  testHost.reply(snapshot.id, { snapshot: { worktrees: [worktree("feature"), worktree("trunk", true)] } });
  const sent = testHost.takeSent();
  assert.deepEqual(calls(sent), [
    ["timer/set", { id: "refresh", seconds: 300, repeat: true }],
    ["process/run", { id: "list", worktree: "trunk" }],
  ]);
  const list = sent.find((m) => m.method === "process/run");
  testHost.reply(list.id, { exit: 0, stdout: JSON.stringify({ data: { repository: { nameWithOwner: "o/r", pullRequests: { nodes: [] } } } }), stderr: "" });
  assert.deepEqual(testHost.takeSent().filter((m) => m.method === "panel/badge").map((m) => m.params), [{ panel: "rail" }]);

  panel(true);
  assert.deepEqual(calls(testHost.takeSent()), [["timer/set", { id: "refresh", seconds: 60, repeat: true }]], "fresh data is not fetched again");
  visible(true);
  panel(false);
  assert.deepEqual(calls(testHost.takeSent()), [], "still shown in the tab");
  visible(false);
  assert.deepEqual(calls(testHost.takeSent()), [["timer/set", { id: "refresh", seconds: 300, repeat: true }]]);
});
