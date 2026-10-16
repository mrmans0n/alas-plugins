import { test } from "node:test";
import assert from "node:assert/strict";
import { testHost } from "@alas/plugin/test";
import "./main.ts";

const page = (message: object) => testHost.notify("web/message", { tab: 0, message });
const request = (sent: any[], operation: string) => sent.find(m => m.method === "process/run" && JSON.parse(m.params.stdin).request.operation === operation);
const answer = (call: any, result: unknown, extra = {}) => testHost.reply(call.id, { exit: 0, stdout: JSON.stringify({ ok: true, result }), stderr: "", ...extra });
const capture = (id: string, worktree: string, run?: string) => ({ schema: 1, id, project: "p", worktree, hostKey: "remote-host", host: "actual-host", run,
  capturedAt: 10, complete: true, counts: { tests: 1, attempts: 1, benchmarks: 0, passed: 1, failed: 0, error: 0, skipped: 0, unknown: 0, state: "passed" },
  source: { state: "unknown" }, command: { outcome: "succeeded", argv: [] }, detail: "available", issues: [] });
let firstSave: any;

test("finished runs use exact remote worktree/run IDs; late detail cannot replace a newer selection", () => {
  testHost.dispatch({ jsonrpc: "2.0", id: 0, method: "alas/activate", params: { api: 16, project: { id: "p", name: "P", host: "remote-host" }, grants: [] } });
  const initial = testHost.takeSent();
  testHost.reply(initial.find(m => m.method === "storage/get").id, { value: { schema: 1, config: { profiles: [{ id: "tests", script: "repo:test.sh", artifacts: [{ path: "report.xml", format: "junit" }] }] }, runs: [] } });
  testHost.takeSent();
  testHost.reply(initial.find(m => m.method === "workspace/snapshot").id, { snapshot: { worktrees: [
    { id: "one", branch: "one", current: true, sessions: [] }, { id: "two", branch: "two", current: false, sessions: [] }
  ] } });
  let sent = testHost.takeSent();
  answer(request(sent, "list"), { summaries: [] });
  sent = testHost.takeSent();
  firstSave = sent.find(m => m.method === "storage/set");
  answer(request(sent, "list"), { summaries: [] });
  testHost.takeSent();
  for (const [worktree, run] of [["one", "run-one"], ["two", "run-two"]]) testHost.notify("run/finished", { worktree, script: "repo:test.sh", run, outcome: "succeeded", exitCode: 0 });
  sent = testHost.takeSent();
  const first = request(sent, "importRun");
  assert.equal(first.params.worktree, "one");
  assert.equal(JSON.parse(first.params.stdin).request.run, "run-one");
  answer(first, { summary: capture("a".repeat(32), "one", "run-one") });
  sent = testHost.takeSent();
  const second = request(sent, "importRun");
  assert.equal(second.params.worktree, "two");
  answer(second, { summary: capture("b".repeat(32), "two", "run-two") });
  testHost.takeSent();
  testHost.notify("run/finished", { worktree: "one", script: "repo:test.sh", run: "run-three", outcome: "succeeded", exitCode: 0 });
  const wrong = request(testHost.takeSent(), "importRun");
  answer(wrong, { summary: capture("c".repeat(32), "one", "another-run") });
  const rejected = testHost.takeSent().filter(m => m.method === "web/post" && m.params.message.type === "state");
  assert.ok(rejected.every(m => !m.params.message.state.runs.some((r: any) => r.id === "c".repeat(32))), "wrong run is rejected before state mutation");
  page({ type: "select", id: "a".repeat(32), worktree: "one" });
  sent = testHost.takeSent();
  const detailOne = request(sent, "detail");
  page({ type: "select", id: "b".repeat(32), worktree: "two" });
  testHost.takeSent();
  answer(detailOne, { summary: capture("a".repeat(32), "one"), page: { rows: [], total: 0, next: null }, evidence: [] });
  sent = testHost.takeSent();
  assert.equal(sent.some(m => m.method === "web/post" && m.params.message.type === "detail"), false);
  answer(request(sent, "detail"), { summary: capture("b".repeat(32), "two"), page: { rows: [], total: 0, next: null }, evidence: [] });
  sent = testHost.takeSent();
  assert.ok(sent.some(m => m.method === "web/post" && m.params.message.type === "detail" && m.params.message.selection.id === "b".repeat(32)));
  page({ type: "ready" });
  const state = testHost.takeSent().find(m => m.method === "web/post" && m.params.message.type === "state");
  assert.equal(state.params.message.state.selected.id, "b".repeat(32));
});

test("truncated helper output and failed storage are visible errors", () => {
  testHost.takeSent();
  page({ type: "refresh" });
  const sent = testHost.takeSent();
  const call = sent.find(m => m.method === "process/run");
  answer(call, {}, { truncated: true });
  const error = testHost.takeSent().find(m => m.method === "web/post" && m.params.message.type === "error");
  assert.match(error.params.message.message, /truncated/i);
  testHost.replyError(firstSave.id, -32003, "storage full");
  const saveError = testHost.takeSent().find(m => m.method === "web/post" && m.params.message.type === "error");
  assert.match(saveError.params.message.message, /Could not save.*storage full/);
});

test("restart restores baseline and selection without carrying a verified-current badge", () => {
  const a = capture("c".repeat(32), "one", "restored-run");
  const ref = { id: a.id, worktree: "one" };
  testHost.dispatch({ jsonrpc: "2.0", id: 0, method: "alas/activate", params: { api: 16, project: { id: "p", name: "P", host: "remote-host" }, grants: [] } });
  const sent = testHost.takeSent();
  testHost.reply(sent.find(m => m.method === "storage/get").id, { value: { schema: 1, config: { profiles: [] }, runs: [{ ...a, source: { state: "current", head: "abc" } }], selected: ref, baseline: ref } });
  const posted = testHost.takeSent().find(m => m.method === "web/post" && m.params.message.type === "state");
  assert.deepEqual(posted.params.message.state.selected, ref);
  assert.deepEqual(posted.params.message.state.baseline, ref);
  assert.equal(posted.params.message.state.runs[0].source.state, "unknown");
});
