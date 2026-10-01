// Background layer (room, desks, labels) cached and rebuilt only when the layout's look changes;
// each frame restores the background under last frame's sprites and draws them again. Must be
// pixel-identical to a full redraw.

import type { Region } from "@alas/plugin";
import * as atlas from "./atlas.ts";
import { Canvas, GLYPH_W, rect, rgba, textWidth, type Rect } from "./canvas.ts";
import { COUCH_SPOTS, DOOR, LOUNGE, ROOM_W, type Layout } from "./layout.ts";
import { MOOD_WORDS, type World } from "./sim.ts";
import type { Sheet } from "./sheet.ts";
import { CHARACTERS, FURNITURE, OVERLAYS, PALETTE } from "./sprites.gen.ts";

const LABEL = rgba(232, 232, 240);
const BAR_FILL = 20;
/** Monitors sit above the seated character so the screen shows over its head. */
const MONITOR_RISE = 8;

function draw(canvas: Canvas, sheet: Sheet, src: Rect, x: number, y: number): Rect {
  canvas.blit(sheet, src, x, y, PALETTE);
  return rect(x, y, src.w, src.h);
}

/** Everything the background depends on, so any change rebuilds it. JSON quotes the branch names, so none can forge another layout's key. */
const backgroundKey = (layout: Layout): string =>
  JSON.stringify([layout.height, layout.hiddenWorktrees, layout.pods.map((p) => [p.branch, p.lampOn, p.papers, p.warning, p.overflow])]);

/** One 16 px row of `tile` repeated across the room. */
function tileStrip(tile: Rect): Canvas {
  const strip = new Canvas(ROOM_W, 16);
  for (let x = 0; x < ROOM_W; x += 16) draw(strip, FURNITURE, tile, x, 0);
  return strip;
}

/** Wall and floor tiles, copied a row at a time rather than blitted tile by tile. */
export function fillTiles(c: Canvas): void {
  const wall = tileStrip(atlas.WALL), floor = tileStrip(atlas.FLOOR);
  const row = c.width;
  for (let y = 0; y < c.height; y++) {
    const strip = Math.floor(y / 16) * 16 < 24 ? wall : floor;
    c.words.set(strip.words.subarray((y % 16) * row, (y % 16 + 1) * row), y * row);
  }
}

function drawBackground(layout: Layout): Canvas {
  const c = new Canvas(ROOM_W, layout.height);
  fillTiles(c);
  draw(c, FURNITURE, atlas.DOOR, DOOR[0] - 8, 8);
  draw(c, FURNITURE, atlas.COFFEE, LOUNGE[0][0] - 16, 16);
  draw(c, FURNITURE, atlas.COOLER, LOUNGE[2][0] - 16, 16);
  draw(c, FURNITURE, atlas.COUCH, COUCH_SPOTS[0][0], 36);
  draw(c, FURNITURE, atlas.PLANT, ROOM_W - 20, 8);
  for (const pod of layout.pods) {
    for (const [sx, sy] of pod.seats) draw(c, FURNITURE, atlas.CHAIR, sx, sy + 10);
    const desk = pod.desk;
    draw(c, FURNITURE, atlas.DESK, desk.x, desk.y);
    draw(c, FURNITURE, pod.lampOn ? atlas.LAMP_ON : atlas.LAMP_OFF, desk.x + desk.w, desk.y - 4);
    if (pod.papers > 0) draw(c, OVERLAYS, atlas.PAPERS[pod.papers - 1], desk.x + desk.w - 16, desk.y);
    if (pod.warning) draw(c, OVERLAYS, atlas.WARNING, desk.x - 6, desk.y);
    c.text(desk.x - 4, desk.y + 17, fit(pod.branch, desk.w + 8), LABEL);
    if (pod.overflow > 0) c.text(desk.x + 2, desk.y + 9, `+${pod.overflow}`, LABEL);
  }
  if (layout.hiddenWorktrees > 0) {
    draw(c, FURNITURE, atlas.SIGN, DOOR[0] + 12, 4);
    c.text(DOOR[0] + 14, 9, `+${layout.hiddenWorktrees} more`, LABEL);
  }
  return c;
}

/** Cuts `text` to `max` pixels; the 4x6 font has no ellipsis, so '~' marks truncation. */
export function fit(text: string, max: number): string {
  if (textWidth(text) <= max) return text;
  const keep = Math.max(Math.floor(max / GLYPH_W) - 1, 0);
  return [...text].slice(0, keep).join("") + "~";
}

export class Renderer {
  background = new Canvas(0, 0);
  frame = new Canvas(0, 0);
  backgroundKey?: string;
  previous: Rect[] = [];

  render(world: World, layout: Layout): Canvas {
    const key = backgroundKey(layout);
    if (this.backgroundKey !== key) {
      this.background = drawBackground(layout);
      this.frame = new Canvas(this.background.width, this.background.height);
      this.frame.words.set(this.background.words);
      this.backgroundKey = key;
    } else {
      for (const r of this.previous) this.frame.copyFrom(this.background, r);
    }
    this.previous = drawSprites(this.frame, world, layout);
    return this.frame;
  }
}

/** Draws the dynamic layer and returns every rect it touched. */
function drawSprites(c: Canvas, world: World, layout: Layout): Rect[] {
  const touched: Rect[] = [];
  const flicker = Math.floor(world.clockMs / 250) % 2;
  const working = new Set(world.characters.filter((ch) => ch.mood === "working" && ch.activity === "seated").map((ch) => ch.sessionId));
  for (const pod of layout.pods) {
    pod.seated.forEach((id, i) => {
      const [sx, sy] = pod.seats[i];
      touched.push(draw(c, FURNITURE, working.has(id) ? atlas.MONITOR_ON[flicker] : atlas.MONITOR_OFF, sx, sy - MONITOR_RISE));
    });
  }
  const order = world.characters
    .slice()
    .sort((a, b) => Math.trunc(a.y) - Math.trunc(b.y) || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
  const bob = Math.floor(world.clockMs / 400) % 2;
  for (const ch of order) {
    const x = Math.round(ch.x), y = Math.round(ch.y);
    const frame = Math.floor(ch.walkMs / 150) % 4;
    let src = atlas.SIT;
    if (ch.activity === "walking") src = atlas.walk([atlas.WALK_UP, atlas.WALK_RIGHT, atlas.WALK_DOWN][ch.vertical + 1], frame);
    else if (ch.activity === "sleeping") src = atlas.SLEEP;
    else if (ch.activity === "seated" && ch.mood === "working") src = atlas.TYPE[Math.floor(ch.walkMs / 200) % 2];
    else if (ch.activity === "seated" && (ch.mood === "waiting" || ch.mood === "permission")) src = atlas.HAND;
    c.blit(CHARACTERS, src, x, y, ch.palette, ch.facingLeft, ch.mood === "unknown");
    touched.push(rect(x, y, atlas.CHAR_W, atlas.CHAR_H));

    let overlay: Rect | undefined;
    if (ch.activity === "seated" && ch.mood === "waiting") overlay = atlas.BUBBLE_Q;
    else if (ch.activity === "seated" && ch.mood === "permission") overlay = atlas.BUBBLE_BANG[Math.floor(world.clockMs / 300) % 2];
    else if (ch.activity === "sleeping") overlay = atlas.ZZ;
    // Sleepers lie low in their 16x24 cell, so their Zs start just above the body.
    const lift = ch.activity === "sleeping" ? 2 : 14;
    if (overlay) touched.push(draw(c, OVERLAYS, overlay, x + 8, y - lift - bob));

    const plan = ch.plan;
    if (ch.activity === "seated" && ch.mood === "working" && plan && plan.total > 0) {
      const filled = Math.floor((14 * Math.min(plan.completed, plan.total)) / plan.total);
      touched.push(draw(c, OVERLAYS, atlas.BAR_FRAME, x, y - 12));
      c.fill(rect(x + 1, y - 11, filled, 2), PALETTE[BAR_FILL]);
    }
  }
  return touched;
}

/** What a click on the region at the same index means. */
export type Target = { session: string } | { worktree: string };

/**
 * Region ids are short indexes ("r0", "r1", …) because Alas bounds ids to 64 bytes and worktree
 * ids can be long; the `Target` at the same index says what a click means. Desks come first
 * because Alas keeps only the first 256 regions of a tab.
 */
export function regions(world: World, layout: Layout): { regions: Region[]; targets: Target[] } {
  const regions: Region[] = [];
  const targets: Target[] = [];
  for (const pod of layout.pods) {
    let label = `Worktree ${pod.branch}`;
    if (pod.files !== undefined) label += `, ${pod.files} changed files`;
    if (pod.warning) label += ", conflicts";
    regions.push({ id: `r${regions.length}`, label, rect: [pod.desk.x, pod.desk.y, pod.desk.w, pod.desk.h] });
    targets.push({ worktree: pod.worktreeId });
  }
  for (const ch of world.characters) {
    if (ch.leaving) continue;
    regions.push({
      id: `r${regions.length}`,
      label: `${ch.agent}: ${ch.title}, ${MOOD_WORDS[ch.mood]}`,
      rect: [Math.round(ch.x), Math.round(ch.y), atlas.CHAR_W, atlas.CHAR_H],
    });
    targets.push({ session: ch.sessionId });
  }
  return { regions, targets };
}
