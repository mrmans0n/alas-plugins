import { test } from "node:test";
import assert from "node:assert/strict";
import { testHost } from "@alas/plugin/test";
import "./main.ts";

const calls = (sent: any[]) => sent.filter((m) => !["web/post", "panel/badge"].includes(m.method)).map((m) => [m.method, m.params]);
const visible = (tab: boolean) => testHost.notify("tab/visible", { tab: 0, visible: tab });
const panel = (shown: boolean) => testHost.notify("panel/visible", { panel: "rail", visible: shown });
const page = (message: object, target: object = { tab: 0 }) => testHost.notify("web/message", { ...target, message });
const posted = (sent: any[]): any => sent.findLast((m) => m.method === "web/post")?.params.message;
const codex = { nodes: [{ user: { login: "chatgpt-codex-connector[bot]" } }] };
const ready = (number: number) => ({ number, title: `Change ${number}`, url: `https://github.com/o/r/pull/${number}`, isDraft: false, headRefName: `f${number}`, updatedAt: `2026-10-1${number}T00:00:00Z`, mergeable: "MERGEABLE", commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] }, reactions: codex });
const list = (nodes: object[]) => JSON.stringify({ data: { repository: { nameWithOwner: "o/r", pullRequests: { nodes } } } });
const process = (sent: any[], id: string) => sent.find((m) => m.method === "process/run" && m.params.id === id);

test("the inbox refreshes on start, every 5 minutes while hidden and every minute while shown", () => {
  testHost.dispatch({ jsonrpc: "2.0", id: 0, method: "alas/activate", params: { api: 15, project: { id: "p", name: "P" }, grants: [] } });
  const snapshot = testHost.takeSent().find((m) => m.method === "workspace/snapshot");
  const worktree = (id: string, main = false) => ({ id, branch: id, current: false, main, sessions: [] });
  testHost.reply(snapshot.id, { snapshot: { worktrees: [worktree("feature"), worktree("trunk", true)] } });
  const sent = testHost.takeSent();
  assert.deepEqual(calls(sent), [
    ["timer/set", { id: "refresh", seconds: 300, repeat: true }],
    ["process/run", { id: "list", worktree: "trunk" }],
  ]);
  testHost.reply(process(sent, "list").id, { exit: 0, stdout: list([]), stderr: "" });
  assert.deepEqual(testHost.takeSent().filter((m) => m.method === "panel/badge"), [], "the rail icon has no badge");

  panel(true);
  assert.deepEqual(calls(testHost.takeSent()), [["timer/set", { id: "refresh", seconds: 60, repeat: true }]], "fresh data is not fetched again");
  visible(true);
  panel(false);
  assert.deepEqual(calls(testHost.takeSent()), [], "still shown in the tab");
  visible(false);
  assert.deepEqual(calls(testHost.takeSent()), [["timer/set", { id: "refresh", seconds: 300, repeat: true }]]);
});

test("a page that loads gets the state, in the tab and the rail", () => {
  page({ type: "ready" }, { panel: "rail" });
  const sent = testHost.takeSent().filter((m) => m.method === "web/post");
  assert.deepEqual(sent.map((m) => Object.keys(m.params)[0]), ["tab", "panel"]);
  assert.equal(sent[0].params.message.type, "state");
  assert.equal(sent[0].params.message.inbox.repo, "o/r");
  page({ type: "ready" }, { panel: "other" });
  page({ type: "merge", number: "3" });
  assert.deepEqual(testHost.takeSent(), [], "other panels and malformed messages are ignored");
});

test("merging still uses the main worktree, refreshes the inbox and badges the ready count", () => {
  page({ type: "refresh" });
  testHost.reply(process(testHost.takeSent(), "list").id, { exit: 0, stdout: list([ready(3)]), stderr: "" });
  const listed = testHost.takeSent();
  assert.deepEqual(listed.find((m) => m.method === "panel/badge")?.params, { panel: "rail", count: 1, tone: "success" });
  assert.equal(posted(listed).inbox.sections[0].rows[0].merge.look, "go");
  page({ type: "merge", number: 3 }, { panel: "rail" });
  const merge = process(testHost.takeSent(), "merge");
  assert.deepEqual(merge.params, { id: "merge", worktree: "trunk", args: ["3"] });
  testHost.reply(merge.id, { exit: 0, stdout: "", stderr: "" });
  const sent = testHost.takeSent();
  assert.ok(sent.some((m) => m.method === "notify/show" || m.method === "notify"), "successful merge notifies");
  testHost.reply(process(sent, "list").id, { exit: 0, stdout: list([]), stderr: "" });
  assert.deepEqual(testHost.takeSent().find((m) => m.method === "panel/badge")?.params, { panel: "rail" }, "the badge clears");
});

test("Merge all merges each ready pull request after a fresh list, and stops at the first failure", () => {
  page({ type: "refresh" });
  testHost.reply(process(testHost.takeSent(), "list").id, { exit: 0, stdout: list([ready(4), ready(5), ready(6)]), stderr: "" });
  testHost.takeSent();
  page({ type: "mergeAll" });
  let sent = testHost.takeSent();
  assert.deepEqual(process(sent, "merge").params.args, ["6"], "the most recently updated first");
  assert.equal(posted(sent).inbox.mergeAll.progress, "Merging 1 of 3…");
  testHost.reply(process(sent, "merge").id, { exit: 0, stdout: "", stderr: "" });
  sent = testHost.takeSent();
  assert.equal(process(sent, "merge"), undefined, "waits for the list");
  // #5 stopped being ready meanwhile: it is skipped.
  testHost.reply(process(sent, "list").id, { exit: 0, stdout: list([{ ...ready(5), mergeable: "CONFLICTING" }, ready(4)]), stderr: "" });
  sent = testHost.takeSent();
  assert.deepEqual(process(sent, "merge").params.args, ["4"]);
  testHost.reply(process(sent, "merge").id, { exit: 1, stdout: "", stderr: "Pull request is not mergeable\n" });
  sent = testHost.takeSent();
  testHost.reply(process(sent, "list").id, { exit: 0, stdout: list([ready(4), ready(7)]), stderr: "" });
  sent = testHost.takeSent();
  assert.equal(process(sent, "merge"), undefined, "stopped");
  const inbox = posted(sent).inbox;
  assert.equal(inbox.sections[0].rows.find((r: any) => r.number === 4).error, "Pull request is not mergeable");
  assert.deepEqual(inbox.mergeAll, { count: 2, disabled: false });
});
