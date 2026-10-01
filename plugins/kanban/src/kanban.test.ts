import { test } from "node:test";
import assert from "node:assert/strict";
import { definePlugin, agentList } from "@alas/plugin";
import { testHost } from "@alas/plugin/test";
import { Kanban, SAVE_FAILED } from "./kanban.ts";

const reply = (id: number, result: unknown) => testHost.dispatch({ jsonrpc: "2.0", id, result });
const fail = (id: number, message: string) => testHost.dispatch({ jsonrpc: "2.0", id, error: { code: -32003, message } });
const event = (id: string, value?: string) => testHost.dispatch({ jsonrpc: "2.0", method: "view/event", params: { tab: 0, id, kind: "click", value } });

function snapshot(state: string): void {
  testHost.dispatch({
    jsonrpc: "2.0",
    method: "workspace/changed",
    params: { snapshot: { worktrees: [{ id: "w", branch: "task/kan-1", current: false, sessions: [{ id: "s", agent: "a", title: "T", state }] }] } },
  });
}

/** An activated plugin whose store held `meta`, `index` and the legacy `board` (`null` = unset). */
function activate(meta: unknown, index: unknown, board: unknown): Kanban {
  testHost.takeSent();
  const k = definePlugin(new Kanban());
  testHost.dispatch({ jsonrpc: "2.0", id: 0, method: "alas/activate", params: { api: 4, project: { id: "p", name: "P" } } });
  const reads = testHost.takeSent().filter((m) => m.method === "storage/get").map((m) => m.params.key);
  assert.deepEqual(reads, ["meta", "index", "board"], "the legacy board is always read");
  [meta, index, board].forEach((value, i) => reply(k.load[i], { value }));
  return k;
}

/** A loaded tracker holding ticket 1 ("Fix it", Todo, plus `fields`), with the sent log cleared. */
function withTicket(fields: object = {}): Kanban {
  const k = activate({ version: 1, next_number: 2 }, [{ number: 1, title: "Fix it", status: "todo", ...fields }], null);
  testHost.takeSent();
  return k;
}

/** [key, value] of every storage/set in `sent`, in order. */
const writes = (sent: any[]): [string, any][] => sent.filter((m) => m.method === "storage/set").map((m) => [m.params.key, m.params.value]);

function sentOne(sent: any[], method: string): any {
  const found = sent.filter((m) => m.method === method);
  assert.equal(found.length, 1, `one ${method} in ${JSON.stringify(sent)}`);
  return found[0];
}

test("a legacy board is migrated once and left in place", () => {
  const board = { cards: [{ id: 7, title: "Fix it", prompt: "do", column: "Review", session_id: "s", following: true, seen: true, agent_state: "idle" }], next_id: 7 };
  let k = activate(null, null, board);
  const saved = writes(testHost.takeSent());
  assert.deepEqual(saved.map(([key]) => key), ["meta", "ticket-1", "index"], "the old board is not touched");
  assert.equal(k.tracker.entry(1)!.status, "in_review");

  k = activate(saved[0][1], saved[2][1], board);
  assert.deepEqual(writes(testHost.takeSent()), [], "a migrated tracker is not migrated again");
  assert.equal(k.tracker.index.length, 1);
});

test("an unreadable store is never overwritten", () => {
  const k = activate({ version: 1, next_number: 2 }, "garbage", null);
  assert.ok(JSON.stringify(sentOne(testHost.takeSent(), "view/render").params.root).includes("could not be read"));
  event("new-description-0", "New ticket");
  snapshot("idle");
  assert.equal(k.tracker.index.length, 1, "the tracker still works in memory");
  assert.deepEqual(writes(testHost.takeSent()), []);
});

test("an idle session adds its last message as one comment", () => {
  withTicket({ status: "in_progress", session_id: "s", branch: "task/kan-1", agent_state: "running", following: true, seen: true });
  snapshot("idle");
  const fetch = sentOne(testHost.takeSent(), "session/last_message");
  assert.deepEqual(fetch.params, { id: "s" });

  reply(fetch.id, { message: "Fixed it." });
  const read = sentOne(testHost.takeSent(), "storage/get");
  assert.equal(read.params.key, "ticket-1");
  reply(read.id, { value: { description: "d" } });
  const body = writes(testHost.takeSent()).find(([key]) => key === "ticket-1")![1];
  assert.equal(body.description, "d");
  assert.deepEqual(body.comments, [{ author: "agent", text: "Fixed it." }]);

  snapshot("idle");
  assert.deepEqual(testHost.takeSent(), []);

  // Reopening the session reports `running` again; the next idle fetches the transcript's
  // last reply, which is still the same one.
  const idleAgain = (message: string) => {
    snapshot("running");
    snapshot("idle");
    reply(sentOne(testHost.takeSent(), "session/last_message").id, { message });
    reply(sentOne(testHost.takeSent(), "storage/get").id, { value: body });
    return writes(testHost.takeSent());
  };
  assert.deepEqual(idleAgain("Fixed it."), [], "the same reply is not added twice");
  const comments = idleAgain("Fixed more.").find(([key]) => key === "ticket-1")![1].comments;
  assert.equal(comments.length, 2);
});

test("edits before the body loads write nothing", () => {
  const k = withTicket();
  event("ticket-1");
  sentOne(testHost.takeSent(), "storage/get");
  event(`description-1-${k.form}`, "new description");
  event(`comment-1-${k.commentForm}`, "a comment");
  assert.deepEqual(testHost.takeSent(), []);
});

test("a start reply for a deleted ticket is ignored", () => {
  const k = withTicket();
  event("start-1");
  reply(sentOne(testHost.takeSent(), "storage/get").id, { value: null });
  const start = sentOne(testHost.takeSent(), "task/start");
  event("delete-1");
  assert.deepEqual(writes(testHost.takeSent()).find(([key]) => key === "ticket-1"), ["ticket-1", null]);

  reply(start.id, { sessionId: "s", branch: "task/kan-1" });
  assert.deepEqual(writes(testHost.takeSent()), []);
  assert.equal(k.tracker.index.length, 0);
});

test("a start for an assignee no longer listed is not sent", () => {
  const k = withTicket({ assignee: "gone" });
  k.agentRequest = agentList();
  testHost.takeSent();
  reply(k.agentRequest, { agents: [{ id: "claude", name: "Claude" }] });
  event("start-1");
  assert.ok(!testHost.takeSent().some((m) => m.method === "task/start" || m.method === "storage/get"));
  assert.equal(k.notice, "gone is no longer available — pick another agent.");
});

test("start sends the ticket and assignee", () => {
  withTicket({ assignee: "claude" });
  event("start-1");
  const read = sentOne(testHost.takeSent(), "storage/get");
  event("start-1");
  assert.ok(!testHost.takeSent().some((m) => m.method === "storage/get"), "a second Start waits for the first");

  reply(read.id, { value: { description: "Make it work." } });
  assert.deepEqual(sentOne(testHost.takeSent(), "task/start").params, {
    title: "Fix it",
    prompt: "KAN-1: Fix it\n\nMake it work.",
    branch: "task/kan-1",
    agent: "claude",
  });
});

test("a failed write stays visible until a later save fully succeeds", () => {
  const k = withTicket();
  event("new-description-0", "New ticket\nwith a body");
  const sets = testHost.takeSent().filter((m) => m.method === "storage/set").map((m) => m.id);
  assert.equal(sets.length, 3, "meta, body, index");
  reply(sets[0], {});
  fail(sets[1], "storage is full");
  reply(sets[2], {});
  assert.ok(k.notice?.startsWith(SAVE_FAILED), "its own later writes do not hide it");
  event("ticket-1");
  event("back");
  const render = testHost.takeSent().findLast((m) => m.method === "view/render");
  assert.ok(JSON.stringify(render.params.root).includes(SAVE_FAILED), "navigating keeps it");
  fail(k.agentRequest!, "agents unavailable");
  assert.ok(k.notice?.startsWith(SAVE_FAILED), "another notice does not replace it");

  event("status-1", "done");
  for (const set of testHost.takeSent().filter((m) => m.method === "storage/set")) reply(set.id, {});
  assert.equal(k.notice, undefined);
});

test("an undecodable body is shown read-only and never written", () => {
  withTicket();
  event("ticket-1");
  reply(sentOne(testHost.takeSent(), "storage/get").id, { value: "not a body" });
  const root = JSON.stringify(sentOne(testHost.takeSent(), "view/render").params.root);
  assert.ok(root.includes("could not be read") && !root.includes("description-1-") && !root.includes("comment-1-"));

  event("comment-1-0", "hi");
  event("delete-1");
  assert.ok(writes(testHost.takeSent()).every(([key]) => key !== "ticket-1"));
});
