import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ARCHIVE_KEEP,
  FORMAT_VERSION,
  MAX_COMMENTS,
  MAX_COMMENT_CHARS,
  MAX_DESCRIPTION_CHARS,
  MAX_INDEX,
  Tracker,
  addComment,
  emptyBody,
  type Card,
  type Column,
  type SessionRef,
  type Status,
} from "./tickets.ts";

function started(): Tracker {
  const t = new Tracker();
  const n = t.create("t", "none")!;
  t.started(n, "s1", "br");
  return t;
}

const sess = (state: string, branch = "br"): SessionRef[] => [{ id: "s1", state, branch }];

test("numbers are never reused", () => {
  const t = new Tracker();
  assert.equal(t.create("a", "none"), 1);
  assert.equal(t.create("b", "high", "claude"), 2);
  t.delete(2);
  assert.equal(t.create("c", "none"), 3);
  assert.equal(t.create("  ", "none"), undefined);
  while (t.index.length < MAX_INDEX) t.create("x", "none");
  assert.equal(t.create("full", "none"), undefined);
});

test("session states move following tickets", async (s) => {
  for (const [state, want] of [
    ["running", "in_progress"],
    ["awaiting_input", "in_progress"],
    ["permission_request", "in_progress"],
    ["idle", "in_review"],
  ] as const) {
    await s.test(state, () => {
      const t = started();
      t.setStatus(1, "todo");
      assert.ok(t.sync(sess(state)).changed);
      assert.equal(t.index[0].status, want);
      assert.equal(t.index[0].agent_state, state);
    });
  }

  await s.test("an unknown state is seen but moves nothing", () => {
    const t = started();
    t.setStatus(1, "todo");
    t.sync(sess("unknown"));
    assert.equal(t.index[0].status, "todo");
    assert.ok(t.index[0].seen);
  });

  await s.test("absent: unchanged until seen, then In review", () => {
    const t = started();
    assert.ok(!t.sync([]).changed);
    assert.equal(t.index[0].status, "in_progress");
    t.sync(sess("running"));
    t.sync([]);
    assert.equal(t.index[0].status, "in_review");
  });

  await s.test("gone after it was reported idle: a manual status holds", () => {
    const t = started();
    t.sync(sess("idle"));
    t.setStatus(1, "todo");
    assert.ok(!t.sync([]).changed);
    assert.deepEqual([t.index[0].status, t.index[0].agent_state], ["todo", "idle"]);
  });

  await s.test("a manual status holds until the state changes", () => {
    const t = started();
    t.sync(sess("running"));
    t.setStatus(1, "in_review");
    assert.ok(!t.sync(sess("running")).changed);
    assert.equal(t.index[0].status, "in_review");
    assert.ok(t.sync(sess("awaiting_input")).changed);
    assert.equal(t.index[0].status, "in_progress");
  });

  for (const status of ["done", "cancelled"] as Status[]) {
    await s.test(`${status} tickets never move, but still take the real branch`, () => {
      const t = started();
      t.setStatus(1, status);
      assert.ok(!t.sync(sess("idle")).changed);
      assert.equal(t.index[0].status, status);
      assert.ok(t.sync(sess("idle", "br-2")).changed);
      assert.equal(t.index[0].branch, "br-2");
    });
  }
});

test("idle fetches the last message once", () => {
  const t = started();
  t.sync(sess("running"));
  assert.deepEqual(t.sync(sess("idle")).fetch, [[1, "s1"]]);
  assert.deepEqual(t.sync(sess("idle")).fetch, []);
  t.sync(sess("running"));
  assert.equal(t.sync(sess("idle")).fetch.length, 1);
});

test("a rejected start keeps the session and a failed task clears it", () => {
  const t = started();
  t.sync(sess("idle"));
  t.setStatus(1, "todo");
  t.startFailed(1, "a task is already starting");
  let e = t.index[0];
  assert.deepEqual([e.status, e.error, e.session_id, e.branch], ["todo", "a task is already starting", "s1", "br"]);

  t.started(1, "s2", "br-2");
  assert.equal(t.index[0].error, undefined);
  t.taskFailed("s2", "later");
  e = t.index[0];
  assert.deepEqual([e.status, e.error, e.session_id, e.following], ["todo", "later", undefined, false]);
});

test("a failed task does not reopen a closed ticket", () => {
  const t = started();
  t.setStatus(1, "cancelled");
  assert.ok(t.taskFailed("s1", "boom"));
  assert.deepEqual([t.index[0].status, t.index[0].session_id], ["cancelled", undefined]);
  assert.ok(!t.taskFailed("s1", "again"));
});

test("comments are capped and clipped", () => {
  const b = emptyBody();
  addComment(b, "you", "  \n ");
  assert.equal(b.comments.length, 0);
  for (let i = 0; i <= MAX_COMMENTS; i++) addComment(b, "you", `c${i}`);
  assert.equal(b.comments.length, MAX_COMMENTS);
  assert.equal(b.comments[0].text, "c1");
  // Scalars, not UTF-16 units: each of these is a surrogate pair.
  addComment(b, "agent", "😀".repeat(MAX_COMMENT_CHARS + 1));
  assert.equal([...b.comments.at(-1)!.text].length, MAX_COMMENT_CHARS);
});

test("migration maps columns and keeps sessions", () => {
  const card = (id: number, column: Column, prompt: string, state?: string): Card => ({
    id,
    title: `t${id}`,
    prompt,
    column,
    session_id: state && `s${id}`,
    branch: state && "br",
    following: state !== undefined,
    seen: state !== undefined,
    agent_state: state,
  });
  const { tracker: t, bodies } = Tracker.migrate([
    card(7, "Backlog", "do it\nmore"),
    card(3, "Running", "", "running"),
    card(9, "NeedsYou", "x".repeat(MAX_DESCRIPTION_CHARS + 1), "awaiting_input"),
    card(4, "Review", "p", "idle"),
    card(5, "Done", "p"),
  ]);
  assert.deepEqual(
    t.index.map((e) => [e.number, e.title, e.status]),
    [
      [1, "t7", "backlog"],
      [2, "t3", "in_progress"],
      [3, "t9", "in_progress"],
      [4, "t4", "in_review"],
      [5, "t5", "done"],
    ],
  );
  assert.deepEqual(t.meta, { version: FORMAT_VERSION, next_number: 6 });
  assert.deepEqual(bodies[0], [1, { ...emptyBody(), description: "do it\nmore" }]);
  assert.ok(bodies.every(([n]) => n !== 2), "an empty prompt has no body");
  assert.equal(bodies[1][1].description.length, MAX_DESCRIPTION_CHARS, "a long prompt is clipped");
  const review = t.index[3];
  assert.deepEqual([review.session_id, review.branch, review.following, review.seen, review.fetched], ["s4", "br", true, true, true]);
  assert.ok(!t.index[1].fetched);
});

test("archive keeps the newest closed tickets", () => {
  const t = new Tracker();
  t.create("open", "none");
  for (let i = 0; i < ARCHIVE_KEEP + 2; i++) {
    const n = t.create("closed", "none")!;
    t.setStatus(n, i % 2 === 0 ? "done" : "cancelled");
  }
  assert.deepEqual(t.archive(), [2, 3]);
  assert.equal(t.index.length, ARCHIVE_KEEP + 1);
  assert.deepEqual(t.archive(), []);
  // Closing the old open ticket keeps it; the oldest-closed goes instead.
  t.setStatus(1, "done");
  assert.deepEqual(t.archive(), [4]);
  assert.ok(t.entry(1));
});
