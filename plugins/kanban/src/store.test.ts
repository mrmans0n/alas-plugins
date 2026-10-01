import { test } from "node:test";
import assert from "node:assert/strict";
import { load, parseBody, writes } from "./store.ts";
import { FORMAT_VERSION, Tracker, emptyBody } from "./tickets.ts";

const meta = { version: 1, next_number: 3 };
const index = [{ number: 2, title: "t", status: "todo" }];
const legacy = { cards: [{ id: 1, title: "c", prompt: "p", column: "Backlog" }], next_id: 2 };

test("loading picks the stored format", async (s) => {
  for (const [m, i, l, want] of [
    [null, null, null, "fresh"],
    [meta, index, null, "tracker"],
    [meta, null, null, "tracker"],
    [null, null, legacy, "migrated"],
    [null, null, "garbage", "unreadable"],
    ["garbage", index, null, "unreadable"],
    [meta, "garbage", null, "unreadable"],
    [meta, index, legacy, "tracker"],
    [meta, null, legacy, "migrated"],
    [null, index, null, "tracker"],
    [null, index, legacy, "tracker"],
    [meta, [{ number: 1, title: "t", status: "nope" }], null, "unreadable"],
  ] as const) {
    await s.test(`${JSON.stringify([m, i, l])} is ${want}`, () => assert.equal(load(m, i, l).kind, want));
  }

  const loaded = load(meta, null, "garbage");
  assert.ok(loaded.kind === "tracker" && loaded.tracker.index.length === 0);
});

test("a relaunch ends any start in flight, so a missing session moves its ticket to In review", () => {
  const loaded = load(meta, [{ number: 2, title: "t", status: "in_progress", session_id: "s", following: true }], null);
  assert.ok(loaded.kind === "tracker");
  const t = loaded.tracker;
  assert.ok(t.sync([]).changed);
  assert.equal(t.index[0].status, "in_review");
  assert.equal(t.index[0].agent_state, undefined);
});

test("a stale next number is raised and duplicate numbers are dropped", () => {
  const loaded = load({ version: 1, next_number: 2 }, [
    { number: 5, title: "a", status: "done" },
    { number: 2, title: "b", status: "todo" },
    { number: 5, title: "c", status: "todo" },
  ], null);
  assert.ok(loaded.kind === "tracker");
  assert.equal(loaded.tracker.meta.next_number, 6);
  assert.deepEqual(loaded.tracker.index.map((e) => e.title), ["a", "b"]);
});

test("writes put meta first, then bodies, then the index, and deletes last", () => {
  const t = new Tracker();
  t.meta.version = FORMAT_VERSION;
  t.create("a", "none");
  const body = { ...emptyBody(), description: "d" };
  const keys = (w: [string, unknown][]) => w.map(([k, v]) => [k, v !== null]);
  assert.deepEqual(keys(writes(t, [[1, body]], [7], true)), [["meta", true], ["ticket-1", true], ["index", true], ["ticket-7", false]]);
  assert.deepEqual(keys(writes(t, [], [], false)), [["meta", true]]);
  // Empty fields stay out of the stored index.
  assert.deepEqual(JSON.parse(JSON.stringify(writes(t, [], [], true)[1][1])), [{ number: 1, title: "a", status: "backlog", priority: "none" }]);

  assert.deepEqual(parseBody({ description: "d" }), body);
  assert.throws(() => parseBody("x"));
  assert.deepEqual(parseBody(null), emptyBody());
});
