import { test } from "node:test";
import assert from "node:assert/strict";
import * as atlas from "./atlas.ts";
import { Canvas, textWidth } from "./canvas.ts";
import { snapshot } from "./fixtures.ts";
import { MAX_H, ROOM_W, layout } from "./layout.ts";
import { Renderer, fillTiles, fit, regions } from "./render.ts";
import { World } from "./sim.ts";
import { FURNITURE, PALETTE } from "./sprites.gen.ts";

const fullRedraw = (world: World, l: ReturnType<typeof layout>) => new Renderer().render(world, l).pixels;

test("branch names cannot forge another layout's background key", () => {
  const two = snapshot([0, 0]);
  two.worktrees[0].branch = "a";
  two.worktrees[1].branch = "b";
  two.worktrees[1].current = true; // both lamps on, like the forged pod below
  const one = snapshot([0]);
  one.worktrees[0].branch = 'a",true,0,false,0],["b';

  const world = new World();
  const [l2, l1] = [layout(two), layout(one)];
  assert.equal(l2.height, l1.height, "same height, so only the key can tell them apart");
  const renderer = new Renderer();
  renderer.render(world, l2);
  assert.ok(Buffer.from(renderer.render(world, l1).pixels).equals(fullRedraw(world, l1)), "a stale background survived the layout change");
});

test("incremental frames match a full redraw", () => {
  const s = snapshot([2, 1, 0, 3, 1]);
  s.worktrees[0].sessions[1].state = "idle";
  s.worktrees[1].sessions[0].state = "awaiting_input";
  s.worktrees[3].sessions[2].state = "permission_request";
  s.worktrees[3].sessions[0].plan = { completed: 2, total: 5 };
  s.worktrees[4].sessions[0].state = "mystery";
  const world = new World();
  world.sync(s, layout(s));
  const incremental = new Renderer();
  for (let step = 0; step < 400; step++) {
    world.step(66);
    if (step === 200) {
      s.worktrees[0].sessions.pop();
      world.sync(s, layout(s));
    }
    const l = layout(s);
    assert.ok(Buffer.from(incremental.render(world, l).pixels).equals(fullRedraw(world, l)), `frame ${step} differs from a full redraw`);
  }
});

test("long branch labels are cut with a tilde", () => {
  assert.equal(fit("main", 72), "main");
  assert.equal(fit("feature/a-really-long", 72), "feature/a-really-~");
  assert.equal(textWidth(fit("feature/a-really-long", 72)), 72);
});

test("regions label characters and desks", () => {
  const s = snapshot([1]);
  const l = layout(s);
  const world = new World();
  world.sync(s, l);
  const r = regions(world, l);
  assert.deepEqual(r.regions.map((x) => [x.id, x.label]), [["r0", "Worktree b0"], ["r1", "claude: T0, working"]]);
  assert.deepEqual(r.targets, [{ worktree: "w0" }, { session: "w0s0" }]);
});

test("tile fill matches per-tile blits in a tall room", () => {
  const height = MAX_H - 5; // not a multiple of 16, so the last row clips
  const fast = new Canvas(ROOM_W, height);
  fillTiles(fast);
  const slow = new Canvas(ROOM_W, height);
  for (let y = 0; y < height; y += 16) {
    for (let x = 0; x < ROOM_W; x += 16) slow.blit(FURNITURE, y < 24 ? atlas.WALL : atlas.FLOOR, x, y, PALETTE);
  }
  assert.ok(Buffer.from(fast.pixels).equals(slow.pixels));
});
