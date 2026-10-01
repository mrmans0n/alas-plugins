import { test } from "node:test";
import assert from "node:assert/strict";
import type { Snapshot } from "@alas/plugin";
import { snapshot } from "./fixtures.ts";
import { COUCH_SPOTS, DOOR, layout } from "./layout.ts";
import { SLEEP_AFTER_MS, World, type Activity } from "./sim.ts";

function settle(world: World, ms: number): void {
  for (let t = 0; t < ms; t += 100) world.step(100);
}

function withState(s: Snapshot, state: string): Snapshot {
  s.worktrees[0].sessions[0].state = state;
  return s;
}

function arrived(s: Snapshot): World {
  const world = new World();
  world.sync(s, layout(s));
  settle(world, 20_000); // walk in from the door
  return world;
}

test("a new session walks in from the door and sits down", () => {
  const s = snapshot([1]);
  const world = new World();
  world.sync(s, layout(s));
  const c = world.characters[0];
  assert.deepEqual([c.x, c.y, c.activity], [DOOR[0], DOOR[1], "walking"]);
  settle(world, 20_000);
  assert.equal(c.activity, "seated");
  assert.deepEqual([c.x, c.y], layout(s).pods[0].seats[0]);
});

test("busy moods stay seated and idle wanders to the lounge", async (t) => {
  for (const [state, busy] of [["running", true], ["awaiting_input", true], ["permission_request", true], ["unknown", true], ["idle", false]] as const) {
    await t.test(state, () => {
      const world = arrived(withState(snapshot([1]), state));
      const seen = new Set<Activity>();
      for (let i = 0; i < 600; i++) {
        world.step(100); // one more minute
        seen.add(world.characters[0].activity);
      }
      if (busy) assert.deepEqual([...seen], ["seated"], `${state} left its seat`);
      else {
        assert.ok(seen.has("lounging"), "idle never reached the lounge");
        assert.ok(!seen.has("sleeping"), "idle for a minute should not sleep yet");
      }
    });
  }
});

test("five idle minutes end asleep on the couch, and a busy state wakes it", () => {
  const s = withState(snapshot([1]), "idle");
  const world = new World();
  world.sync(s, layout(s));
  settle(world, SLEEP_AFTER_MS + 30_000);
  const c = world.characters[0];
  assert.equal(c.activity, "sleeping");
  assert.ok(COUCH_SPOTS.some(([x, y]) => x === Math.trunc(c.x) && y === Math.trunc(c.y)));
  world.sync(snapshot([1]), layout(s));
  settle(world, 30_000);
  assert.equal(world.characters[0].activity, "seated");
});

test("an ended session walks out and disappears", () => {
  const world = arrived(snapshot([1]));
  const empty = snapshot([0]);
  world.sync(empty, layout(empty));
  assert.ok(world.characters[0].leaving);
  settle(world, 30_000);
  assert.equal(world.characters.length, 0);
});

test("a seated agent stays put when its busy mood changes", () => {
  const world = arrived(snapshot([1]));
  const l = layout(snapshot([1]));
  for (const state of ["awaiting_input", "permission_request", "running", "unknown"]) {
    world.sync(withState(snapshot([1]), state), l);
    for (let i = 0; i < 50; i++) {
      world.step(100);
      assert.equal(world.characters[0].activity, "seated", state);
    }
  }
});

test("idlers never share a lounge spot", () => {
  const s = snapshot([2]); // the couch has two spots
  for (const session of s.worktrees[0].sessions) session.state = "idle";
  const world = new World();
  world.sync(s, layout(s));
  for (let i = 0; i < 4_000; i++) {
    world.step(100);
    const spots = world.characters.filter((c) => c.activity === "lounging" || c.activity === "sleeping").map((c) => `${Math.trunc(c.x)},${Math.trunc(c.y)}`);
    assert.equal(new Set(spots).size, spots.length, "two characters share a spot");
  }
});
