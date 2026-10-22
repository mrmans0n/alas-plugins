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
const ready = (number: number, fields: object = {}) => ({ number, title: `Change ${number}`, url: `https://github.com/o/r/pull/${number}`, isDraft: false, headRefName: `f${number}`, updatedAt: `2026-10-1${number}T00:00:00Z`, mergeable: "MERGEABLE", commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] }, reactions: codex, ...fields });
const by = (login: string) => ({ author: { login } });
const list = (nodes: object[], viewer?: string) => JSON.stringify({ data: { ...(viewer && { viewer: { login: viewer } }), repository: { nameWithOwner: "o/r", pullRequests: { nodes } } } });
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

const stored = (id: number, value: unknown) => testHost.reply(id, { value });
const numbers = (sent: any[]) => posted(sent).inbox.sections.flatMap((s: any) => s.rows.map((r: any) => r.number));
const storageSets = (sent: any[]) => sent.filter((m) => m.method === "storage/set").map((m) => m.params);
const listed = (nodes: object[]) => {
  page({ type: "refresh" });
  testHost.reply(process(testHost.takeSent(), "list").id, { exit: 0, stdout: list(nodes, "Nacho"), stderr: "" });
  return testHost.takeSent();
};
// Each activation asks storage again, with a new request id (a reply answers its request once).
const viewGet = () => {
  testHost.dispatch({ jsonrpc: "2.0", id: 0, method: "alas/activate", params: { api: 15, project: { id: "p", name: "P" }, grants: [] } });
  const gets = testHost.takeSent().filter((m) => m.method === "storage/get");
  assert.deepEqual(gets.map((m) => m.params.key), ["ci-doctor-v1", "view-v1"]);
  return gets[1].id;
};

test("a stored scope is applied once the list is there and redraws; a malformed one is ignored", () => {
  assert.equal(numbers(listed([ready(1, by("nacho")), ready(2, by("ana"))])).length, 2);
  for (const bad of [{ mineOnly: "yes" }, {}, null, "x", [true]]) {
    stored(viewGet(), bad);
    const sent = testHost.takeSent();
    assert.deepEqual(storageSets(sent), []);
    assert.equal(posted(sent), undefined, `${JSON.stringify(bad)}: nothing redrawn`);
  }
  stored(viewGet(), { mineOnly: true });
  const sent = testHost.takeSent();
  assert.deepEqual(numbers(sent), [1], "viewer Nacho, author nacho");
  assert.equal(posted(sent).inbox.scope.mineOnly, true);
  assert.deepEqual(storageSets(sent), [], "applying a stored value does not write it back");
});

test("a stored scope that arrives after the user clicked the toggle is ignored", () => {
  const id = viewGet();
  page({ type: "scope", mine: false });
  testHost.takeSent();
  stored(id, { mineOnly: true });
  assert.deepEqual(testHost.takeSent(), [], "late stored value dropped");
  page({ type: "ready" });
  assert.equal(posted(testHost.takeSent()).inbox.scope.mineOnly, false);
});

test("a scope message persists the choice and redraws; a non-boolean is ignored; a row still merges a pull request that is not yours", () => {
  page({ type: "scope", mine: "yes" });
  assert.deepEqual(testHost.takeSent(), []);
  page({ type: "scope", mine: true });
  const sent = testHost.takeSent();
  assert.deepEqual(storageSets(sent), [{ key: "view-v1", value: { mineOnly: true } }]);
  assert.deepEqual(numbers(sent), [1]);
  page({ type: "merge", number: 2 });
  const merge = process(testHost.takeSent(), "merge");
  assert.deepEqual(merge.params.args, ["2"], "the filter only shapes Merge all");
  testHost.reply(merge.id, { exit: 0, stdout: "", stderr: "" });
  testHost.reply(process(testHost.takeSent(), "list").id, { exit: 0, stdout: list([ready(1, by("nacho"))], "nacho"), stderr: "" });
  testHost.takeSent();
});

test("Merge all with Mine on merges only your pull requests, also when the list changes under it", () => {
  listed([ready(1, by("nacho")), ready(2, by("ana")), ready(3, by("nacho")), ready(4, by("bob"))]);
  page({ type: "mergeAll" });
  let sent = testHost.takeSent();
  assert.equal(posted(sent).inbox.mergeAll.progress, "Merging 1 of 2…");
  assert.deepEqual(process(sent, "merge").params.args, ["3"], "newest of mine first, not ana's 2 or bob's 4");
  testHost.reply(process(sent, "merge").id, { exit: 0, stdout: "", stderr: "" });
  sent = testHost.takeSent();
  // 1 turned out to be ana's: its queued number must be dropped by the re-check.
  testHost.reply(process(sent, "list").id, { exit: 0, stdout: list([ready(1, by("ana")), ready(2, by("ana"))], "nacho"), stderr: "" });
  sent = testHost.takeSent();
  assert.equal(process(sent, "merge"), undefined, "no merge of a pull request that is not yours while Mine is on");
  assert.equal(posted(sent).inbox.mergeAll, undefined);

  page({ type: "scope", mine: false });
  testHost.takeSent();
  page({ type: "mergeAll" });
  sent = testHost.takeSent();
  assert.deepEqual(process(sent, "merge").params.args, ["2"], "with All, ana's ready pull requests are merged too");
  testHost.reply(process(sent, "merge").id, { exit: 0, stdout: "", stderr: "" });
  testHost.reply(process(testHost.takeSent(), "list").id, { exit: 0, stdout: list([], "nacho"), stderr: "" });
  testHost.takeSent();
});
