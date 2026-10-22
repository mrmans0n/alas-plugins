import { test } from "node:test";
import assert from "node:assert/strict";
import { testHost } from "@alas/plugin/test";
import { node, reply } from "./inbox.test.ts";
import "./main.ts";

const page = (message: object, target: object = { tab: 0 }) => testHost.notify("web/message", { ...target, message });
const posted = (sent: any[]): any => sent.findLast((m) => m.method === "web/post")?.params.message;
const proc = (sent: any[], id: string) => sent.find((m) => m.method === "process/run" && m.params.id === id);
const done = (stdout: string, exit = 0, stderr = "") => ({ exit, stdout, stderr });

test("start: list and project, then add, add all, auto-merge fallback, retry and the badge", () => {
  testHost.dispatch({ jsonrpc: "2.0", id: 0, method: "alas/activate", params: { api: 15, project: { id: "p", name: "P" }, grants: [] } });
  const snap = testHost.takeSent().find((m) => m.method === "workspace/snapshot");
  testHost.reply(snap.id, { snapshot: { worktrees: [{ id: "trunk", branch: "main", current: false, main: true, sessions: [] }] } });
  let sent = testHost.takeSent();
  assert.ok(proc(sent, "list"), "lists on start");
  assert.ok(proc(sent, "project"), "asks whether trains are on");
  testHost.reply(proc(sent, "project").id, done('{"merge_trains_enabled":true}'));
  testHost.reply(proc(sent, "list").id, done(reply([node(1), node(2), node(3, { detailedMergeStatus: "CI_STILL_RUNNING", headPipeline: { id: "gid://gitlab/Ci::Pipeline/9", status: "RUNNING", sha: "a".repeat(40), jobs: { count: 4 }, done: { count: 1 }, running: { count: 1 } } }), node(4, { headPipeline: { id: "gid://gitlab/Ci::Pipeline/44", status: "FAILED", sha: "a".repeat(40), jobs: { count: 1 }, done: { count: 1 }, running: { count: 0 } } })])));
  sent = testHost.takeSent();
  assert.deepEqual(sent.filter((m) => m.method === "panel/badge").map((m) => m.params), [{ panel: "rail", count: 2, tone: "success" }]);
  assert.deepEqual(posted(sent).inbox.sections.map((s: any) => s.key), ["ready", "blocked", "failing"]);

  page({ type: "add", iid: 3 });
  sent = testHost.takeSent();
  assert.deepEqual(proc(sent, "add").params.args, ["projects/acme%2Fshop/merge_trains/merge_requests/3", "-f", `sha=${"a".repeat(40)}`, "-f", "auto_merge=true"]);
  testHost.reply(proc(sent, "add").id, done("{}"));
  sent = testHost.takeSent();
  assert.ok(proc(sent, "list"), "refreshes after a write");
  testHost.reply(proc(sent, "list").id, done(reply([node(1), node(2)])));
  testHost.takeSent();

  page({ type: "addAll" });
  sent = testHost.takeSent();
  assert.deepEqual(proc(sent, "add").params.args, ["projects/acme%2Fshop/merge_trains/merge_requests/2", "-f", `sha=${"a".repeat(40)}`], "newest first, no auto_merge when ready");
  testHost.reply(proc(sent, "add").id, done("{}"));
  sent = testHost.takeSent();
  testHost.reply(proc(sent, "list").id, done(reply([node(1)])));
  sent = testHost.takeSent();
  assert.deepEqual(proc(sent, "add").params.args[0], "projects/acme%2Fshop/merge_trains/merge_requests/1", "re-lists, then adds the next still-ready one");
  testHost.reply(proc(sent, "add").id, done("", 1, "glab: 400 Bad Request (HTTP 400)"));
  sent = testHost.takeSent();
  testHost.reply(proc(sent, "list").id, done(reply([node(1)])));
  sent = testHost.takeSent();
  assert.equal(posted(sent).inbox.sections[0].rows[0].error, "glab: 400 Bad Request (HTTP 400)");
  assert.equal(posted(sent).inbox.addAll, undefined, "a failure stops Add all");

  page({ type: "refresh" });
  sent = testHost.takeSent();
  testHost.reply(proc(sent, "project").id, done('{"merge_trains_enabled":false}'));
  testHost.reply(proc(sent, "list").id, done(reply([node(1), node(4, { headPipeline: { id: "gid://gitlab/Ci::Pipeline/44", status: "FAILED", sha: "a".repeat(40), jobs: { count: 1 }, done: { count: 1 }, running: { count: 0 } } })])));
  testHost.takeSent();
  page({ type: "add", iid: 1 });
  sent = testHost.takeSent();
  assert.deepEqual(proc(sent, "automerge").params.args, ["projects/acme%2Fshop/merge_requests/1/merge", "-f", `sha=${"a".repeat(40)}`, "-f", "auto_merge=true", "-f", "merge_when_pipeline_succeeds=true"]);
  testHost.reply(proc(sent, "automerge").id, done("{}"));
  sent = testHost.takeSent();
  testHost.reply(proc(sent, "list").id, done(reply([node(4, { headPipeline: { id: "gid://gitlab/Ci::Pipeline/44", status: "FAILED", sha: "a".repeat(40), jobs: { count: 1 }, done: { count: 1 }, running: { count: 0 } } })])));
  testHost.takeSent();

  page({ type: "retryPipeline", pipeline: 44 });
  sent = testHost.takeSent();
  assert.deepEqual(proc(sent, "retry").params.args, ["projects/acme%2Fshop/pipelines/44/retry"]);
  page({ type: "retryPipeline", pipeline: 999 });
  assert.equal(proc(testHost.takeSent(), "retry"), undefined, "only the head pipeline of a listed MR is retried");
});

test("a failed re-list stops Add all instead of adding from stale data", () => {
  // Same plugin instance as the test above, whose last retry is still running and holds one process slot.
  page({ type: "refresh" });
  let sent = testHost.takeSent();
  testHost.reply(proc(sent, "project").id, done('{"merge_trains_enabled":true}'));
  sent = testHost.takeSent();
  testHost.reply(proc(sent, "list").id, done(reply([node(1), node(2)])));
  testHost.takeSent();
  page({ type: "addAll" });
  sent = testHost.takeSent();
  testHost.reply(proc(sent, "add").id, done("{}"));
  sent = testHost.takeSent();
  testHost.reply(proc(sent, "list").id, done("", 1, "glab: 500 Server Error (HTTP 500)"));
  sent = testHost.takeSent();
  assert.equal(proc(sent, "add"), undefined, "no add from a stale list");
  assert.equal(posted(sent).inbox.addAll?.progress, undefined, "Add all is no longer running");
  assert.ok(posted(sent).inbox.error);
});

test("a failed project call keeps the buttons on the train endpoint; a later trains-off reply flips them", () => {
  page({ type: "refresh" });
  let sent = testHost.takeSent();
  testHost.reply(proc(sent, "project").id, done("", 1, "glab: 503 Service Unavailable (HTTP 503)"));
  sent = testHost.takeSent();
  testHost.reply(proc(sent, "list").id, done(reply([node(1)])));
  sent = testHost.takeSent();
  assert.equal(posted(sent).inbox.trainsEnabled, true);
  page({ type: "add", iid: 1 });
  sent = testHost.takeSent();
  assert.equal(proc(sent, "automerge"), undefined, "no auto-merge after a failed project call");
  assert.ok(proc(sent, "add"), "still the train endpoint");
  testHost.reply(proc(sent, "add").id, done("{}"));
  sent = testHost.takeSent();
  testHost.reply(proc(sent, "list").id, done(reply([node(1)])));
  testHost.takeSent();

  page({ type: "refresh" });
  sent = testHost.takeSent();
  testHost.reply(proc(sent, "project").id, done('{"merge_trains_enabled":false}'));
  sent = testHost.takeSent();
  testHost.reply(proc(sent, "list").id, done(reply([node(1)])));
  testHost.takeSent();
  page({ type: "add", iid: 1 });
  sent = testHost.takeSent();
  assert.ok(proc(sent, "automerge"), "trains reported off: Merge when green");
  testHost.reply(proc(sent, "automerge").id, done("{}"));
  sent = testHost.takeSent();
  testHost.reply(proc(sent, "list").id, done(reply([node(1)])));
  testHost.takeSent();
});

test("Add all does not wedge when a queued MR has an unusable sha", () => {
  page({ type: "refresh" });
  let sent = testHost.takeSent();
  testHost.reply(proc(sent, "project").id, done('{"merge_trains_enabled":true}'));
  sent = testHost.takeSent();
  testHost.reply(proc(sent, "list").id, done(reply([node(1), node(2, { diffHeadSha: "" })])));
  sent = testHost.takeSent();
  page({ type: "addAll" });
  sent = testHost.takeSent();
  assert.deepEqual(proc(sent, "add").params.args[0], "projects/acme%2Fshop/merge_trains/merge_requests/1", "skips the unusable newest MR");
  testHost.reply(proc(sent, "add").id, done("{}"));
  sent = testHost.takeSent();
  testHost.reply(proc(sent, "list").id, done(reply([node(2, { diffHeadSha: "" })])));
  sent = testHost.takeSent();
  assert.equal(posted(sent).inbox.addAll, undefined, "Add all ended");
  page({ type: "refresh" });
  sent = testHost.takeSent();
  testHost.reply(proc(sent, "project").id, done('{"merge_trains_enabled":true}'));
  sent = testHost.takeSent();
  testHost.reply(proc(sent, "list").id, done(reply([node(1), node(3)])));
  testHost.takeSent();
  page({ type: "addAll" });
  assert.ok(proc(testHost.takeSent(), "add"), "Add all can start again");
});
