import { test } from "node:test";
import assert from "node:assert/strict";
import type { Agent } from "@alas/plugin";
import { MAX_COMMENTS, MAX_COMMENT_CHARS, MAX_DESCRIPTION_CHARS, MAX_INDEX, MAX_TITLE_CHARS, Tracker, addComment, type Body } from "./tickets.ts";
import { emptyDraft, render, type Screen } from "./view.ts";

/** The tree as the host receives it. */
function tree(tracker: Tracker, screen: Screen, body?: Body, agents: Agent[] = []): any {
  const root = render({ tracker, screen, body, agents, draft: emptyDraft(), form: 0, commentForm: 0, starting: [], bodyUnreadable: false });
  return JSON.parse(JSON.stringify(root));
}

function* nodes(v: any): Generator<any> {
  yield v;
  for (const child of v.children ?? (v.child ? [v.child] : [])) yield* nodes(child);
}

const find = (v: any, id: string) => [...nodes(v)].find((n) => n.id === id);
const columnCards = (v: any, key: string) => find(v, `col-${key}-cards`).children.map((c: any) => c.id);

function assertWithinHostLimits(root: any): void {
  const all = [...nodes(root)];
  const utf8 = (s: string) => Buffer.byteLength(s);
  assert.ok(all.every((n) => utf8(n.id) >= 1 && utf8(n.id) <= 64));
  assert.equal(new Set(all.map((n) => n.id)).size, all.length, "ids must be unique");
  assert.ok(all.length <= 2000, `${all.length} nodes`);
  const depth = (n: any): number => 1 + Math.max(0, ...(n.children ?? (n.child ? [n.child] : [])).map(depth));
  assert.ok(depth(root) <= 16, `depth ${depth(root)}`);
  for (const n of all) {
    assert.ok(!n.items || n.items.length <= 64);
    for (const value of [n.text, n.label, n.value, n.placeholder, ...(n.items ?? []).map((i: any) => i.label)]) {
      if (typeof value === "string") assert.ok([...value].length <= 4000, `a ${[...value].length}-char string`);
    }
  }
}

test("the board has five columns and cards carry index data", () => {
  const t = new Tracker();
  for (const title of ["a", "b", "c", "d", "e"]) t.create(title, "none");
  const first = t.entry(1)!;
  first.priority = "high";
  first.assignee = "claude";
  t.started(2, "s", "task/kan-2");
  t.entry(2)!.agent_state = "running";
  // Closing 4 before 3 leaves them out of number order in the index.
  t.setStatus(4, "done");
  t.setStatus(3, "done");
  t.setStatus(5, "cancelled");

  let board = tree(t, { kind: "board", showCancelled: false });
  assert.deepEqual(find(board, "columns").children.map((c: any) => c.id), ["col-backlog", "col-todo", "col-in_progress", "col-in_review", "col-done"]);
  assert.equal(find(board, "col-done-count").text, "2");
  assert.deepEqual(columnCards(board, "done"), ["ticket-3", "ticket-4"]);
  assert.equal(find(board, "ticket-1").clickable, true);
  assert.equal(find(board, "ticket-1-number").text, "KAN-1");
  assert.equal(find(board, "ticket-1-title").text, "a");
  assert.equal(find(board, "ticket-1-priority").text, "High");
  assert.equal(find(board, "ticket-1-assignee").text, "claude");
  assert.equal(find(board, "ticket-2-state").text, "running");
  assert.equal(find(board, "ticket-5"), undefined);

  board = tree(t, { kind: "board", showCancelled: true });
  assert.deepEqual(columnCards(board, "cancelled"), ["ticket-5"]);
});

test("a full tracker stays within the host limits", () => {
  const t = new Tracker();
  const title = "é".repeat(MAX_TITLE_CHARS);
  for (let i = 0; i < MAX_INDEX; i++) {
    const n = t.create(title, "urgent", "a".repeat(200))!;
    t.started(n, `s${i}`, "b".repeat(300));
    const e = t.entry(n)!;
    e.agent_state = "awaiting_input";
    e.error = "x".repeat(5000);
  }
  const agents = Array.from({ length: 100 }, (_, i) => ({ id: `agent-${i}`, name: "n".repeat(5000) }));
  const board = tree(t, { kind: "board", showCancelled: true }, undefined, agents);
  assertWithinHostLimits(board);
  assert.equal(columnCards(board, "in_progress").length, MAX_INDEX);

  const body: Body = { description: "d".repeat(MAX_DESCRIPTION_CHARS + 1), labels: Array(20).fill("l".repeat(100)), comments: [] };
  for (let i = 0; i < MAX_COMMENTS; i++) addComment(body, "agent", "c".repeat(MAX_COMMENT_CHARS));
  const screen = tree(t, { kind: "ticket", number: MAX_INDEX }, body, agents);
  assertWithinHostLimits(screen);
  assert.equal(find(screen, `description-${MAX_INDEX}-0`).value.length, MAX_DESCRIPTION_CHARS, "an over-long stored description is clipped");
});

test("the ticket screen waits for its body", () => {
  const t = new Tracker();
  t.create("a", "none");
  const hasField = (v: any) => [...nodes(v)].some((n) => n.id.startsWith("description-1-") || n.id.startsWith("comment-1-"));
  const loading = tree(t, { kind: "ticket", number: 1 });
  assert.ok(find(loading, "loading"));
  assert.ok(!hasField(loading));
  assert.ok(find(loading, "status-1"), "index fields are editable at once");

  const loaded = tree(t, { kind: "ticket", number: 1 }, { description: "d", labels: [], comments: [] });
  assert.equal(find(loaded, "loading"), undefined);
  assert.equal(find(loaded, "description-1-0").value, "d");
  assert.ok(find(loaded, "comment-1-0"));
});
