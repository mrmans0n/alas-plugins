import { test } from "node:test";
import assert from "node:assert/strict";
import { Canvas, rect, rgba } from "./canvas.ts";
import { paletteFor, SHIRTS } from "./look.ts";
import { CHARACTERS, FONT, FURNITURE, OVERLAYS, PALETTE } from "./sprites.gen.ts";

const at = (c: Canvas, x: number, y: number) => [...c.pixels.subarray((y * c.width + x) * 4, (y * c.width + x) * 4 + 4)];

test("blit skips transparent pixels, flips, dims and clips", () => {
  const sheet = { width: 2, height: 1, pixels: new Uint8Array([1, 0]) };
  const palette = new Uint32Array([0, rgba(9, 9, 9)]);
  const c = new Canvas(3, 1);
  c.fill(rect(0, 0, 3, 1), rgba(1, 1, 1));
  c.blit(sheet, rect(0, 0, 2, 1), 0, 0, palette);
  assert.deepEqual([at(c, 0, 0), at(c, 1, 0)], [[9, 9, 9, 255], [1, 1, 1, 255]]);
  c.blit(sheet, rect(0, 0, 2, 1), 1, 0, palette, true, true);
  assert.deepEqual(at(c, 2, 0), [4, 4, 4, 255]);
  c.blit(sheet, rect(0, 0, 2, 1), -1, 5, palette); // fully off-canvas: nothing drawn, no throw
});

test("copyFrom restores only the rect", () => {
  const background = new Canvas(4, 4);
  const frame = new Canvas(4, 4);
  frame.fill(rect(0, 0, 4, 4), rgba(7, 7, 7));
  frame.copyFrom(background, rect(-2, -2, 3, 3));
  assert.deepEqual(at(frame, 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(at(frame, 1, 1), [7, 7, 7, 255]);
});

test("sheets have the documented sizes and every glyph and character frame is drawn", () => {
  assert.deepEqual([CHARACTERS, FURNITURE, OVERLAYS, FONT].map((s) => [s.width, s.height]), [[80, 96], [128, 64], [64, 32], [64, 36]]);
  const lit = (sheet: typeof FONT, x: number, y: number, w: number, h: number) => {
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) if (sheet.pixels[(y + dy) * sheet.width + x + dx] !== 0) return true;
    return false;
  };
  for (let code = 33; code < 127; code++) {
    assert.ok(lit(FONT, ((code - 32) % 16) * 4, Math.floor((code - 32) / 16) * 6, 4, 6), `glyph ${String.fromCharCode(code)} is empty`);
  }
  const frames = [0, 1, 2, 3].flatMap((n) => [[n * 16, 0], [n * 16, 24], [n * 16, 48]]).concat([0, 1, 2, 3, 4].map((n) => [n * 16, 72]));
  for (const [x, y] of frames) assert.ok(lit(CHARACTERS, x, y, 16, 24), `character frame at (${x}, ${y}) is empty`);
});

test("looks are stable per session and shirts follow the agent", () => {
  assert.deepEqual(paletteFor("s1", "codex"), paletteFor("s1", "codex"));
  assert.deepEqual([...paletteFor("a", "claude").subarray(7, 10)], SHIRTS[0]);
  assert.deepEqual([...paletteFor("b", "claude").subarray(7, 10)], SHIRTS[0]);
  assert.deepEqual(paletteFor("a", "claude").subarray(10), PALETTE.subarray(10), "fixed colours never change");
});
