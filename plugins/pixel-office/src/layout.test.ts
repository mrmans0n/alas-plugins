import { test } from "node:test";
import assert from "node:assert/strict";
import { snapshot } from "./fixtures.ts";
import { BASE_H, MAX_H, ROW_H, TOP, BOTTOM_MARGIN, layout, maxPods, papersBucket } from "./layout.ts";

const index = (id: string) => Number(id.slice(1));
const inSnapshotOrder = (ids: string[]) => ids.every((id, i) => i === 0 || index(ids[i - 1]) < index(id));

test("pods fill rows of four and the room grows downward", () => {
  assert.equal(layout(snapshot(Array(5).fill(0))).height, BASE_H);
  const nine = layout(snapshot(Array(9).fill(0)));
  assert.equal(nine.height, TOP + 3 * ROW_H + BOTTOM_MARGIN);
  assert.equal(nine.pods[4].desk.y, TOP + ROW_H + 16);
  assert.ok(nine.pods[0].lampOn && !nine.pods[1].lampOn);
});

test("a pod seats four and counts the rest", () => {
  const pod = layout(snapshot([6])).pods[0];
  assert.equal(pod.seated.length, 4);
  assert.equal(pod.overflow, 2);
});

test("overflowing worktrees are summarised and height is capped", () => {
  const big = layout(snapshot(Array(maxPods() + 4).fill(0)));
  assert.equal(big.pods.length, maxPods());
  assert.equal(big.hiddenWorktrees, 4);
  assert.ok(big.height <= MAX_H);
});

// A cap must never hide the worktrees that matter: active sessions and the current one stay, the
// quiet ones make way, and the order on screen is still the snapshot's.
test("the cap keeps worktrees with sessions and the current one, in snapshot order", () => {
  const counts = Array(maxPods() + 6).fill(0);
  for (const busy of [maxPods() + 2, maxPods() + 4]) counts[busy] = 1;
  const snap = snapshot(counts);
  snap.worktrees[0].current = false;
  snap.worktrees[3].current = true;

  const shown = layout(snap).pods.map((p) => p.worktreeId);
  assert.equal(shown.length, maxPods());
  const position = (id: string) => shown.indexOf(id);
  const [current, firstBusy, secondBusy] = [position("w3"), position(`w${maxPods() + 2}`), position(`w${maxPods() + 4}`)];
  assert.ok(current >= 0 && current < firstBusy && firstBusy < secondBusy, `snapshot order is kept: ${shown}`);
  assert.ok(inSnapshotOrder(shown));
});

test("the current worktree keeps its desk when earlier worktrees fill the cap", () => {
  const snap = snapshot([...Array(maxPods() + 3).fill(1), 0]);
  snap.worktrees[0].current = false;
  const last = snap.worktrees.length - 1;
  snap.worktrees[last].current = true;

  const shown = layout(snap).pods.map((p) => p.worktreeId);
  assert.equal(shown.length, maxPods());
  assert.ok(shown.includes(`w${last}`), `current worktree dropped: ${shown}`);
  assert.ok(inSnapshotOrder(shown), `snapshot order is kept: ${shown}`);
});

test("paper piles step with dirty files", () => {
  const bucket = (files: number) => papersBucket({ files, conflicts: 0 });
  assert.deepEqual([papersBucket(null), bucket(0), bucket(5), bucket(6), bucket(20), bucket(21)], [0, 0, 1, 2, 2, 3]);
});
