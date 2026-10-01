// Where everything sits. Pure function of the snapshot.

import type { Dirty, Snapshot } from "@alas/plugin";
import { rect, type Rect } from "./canvas.ts";

export const ROOM_W = 320;
export const BASE_H = 180;
/** Desk rows start below the wall (0..24) and the lounge strip (24..64). */
export const TOP = 64;
export const ROW_H = 48;
export const PODS_PER_ROW = 4;
export const SEATS = 4;
export const MAX_H = 1024;
export const BOTTOM_MARGIN = 12;
/** Where characters enter and leave (in front of the door, top-left). */
export const DOOR: Point = [24, 56];
/** The corridor along the left wall joining the lounge and every desk row. */
export const SIDE_X = 4;
/** Standing/sitting spots in the lounge strip: coffee machine, water cooler, window. */
export const LOUNGE: Point[] = [[96, 56], [112, 56], [176, 56], [192, 56], [256, 56], [272, 56]];
/** Couch seats, where sleepers go (top-left of a 16x24 sleeping sprite; the couch is drawn at y=36). */
export const COUCH_SPOTS: Point[] = [[216, 29], [232, 29]];

export type Point = [number, number];

export interface Pod {
  worktreeId: string;
  branch: string;
  desk: Rect;
  /** Top-left of each seated character (16x24). */
  seats: Point[];
  seated: string[];
  overflow: number;
  lampOn: boolean;
  papers: number;
  warning: boolean;
  files?: number;
}

export interface Layout {
  height: number;
  pods: Pod[];
  hiddenWorktrees: number;
}

/** Desk pods drawn at most; the rest go on the "+N more" sign. Twelve fill three rows of the room. */
export const MAX_PODS = 12;

export const maxPods = (): number => Math.min(MAX_PODS, Math.floor((MAX_H - TOP - BOTTOM_MARGIN) / ROW_H) * PODS_PER_ROW);

/**
 * Which worktrees get a desk, as indexes into the snapshot in snapshot order. Past the cap, the
 * current worktree comes first, then those with sessions, then the quiet ones, so a cap never
 * hides what the user is looking at or an active agent. Membership changes only when the set
 * crosses the cap, so desks do not shuffle as sessions start and stop.
 */
function shownWorktrees(snapshot: Snapshot): number[] {
  const worktrees = snapshot.worktrees;
  const rank = (i: number) => (worktrees[i].current ? 0 : worktrees[i].sessions.length > 0 ? 1 : 2);
  // Array.prototype.sort is stable: snapshot order breaks ties.
  return worktrees
    .map((_, i) => i)
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, maxPods())
    .sort((a, b) => a - b);
}

export function papersBucket(dirty?: Dirty | null): number {
  const files = dirty?.files ?? 0;
  return files === 0 ? 0 : files <= 5 ? 1 : files <= 20 ? 2 : 3;
}

/** The walking lane of the row containing `y`: just below its desks, or the lounge strip. */
export const aisleY = (y: number): number => (y < TOP ? DOOR[1] : TOP + Math.floor((y - TOP) / ROW_H) * ROW_H + 40);

export function layout(snapshot: Snapshot): Layout {
  const indexes = shownWorktrees(snapshot);
  const rows = Math.ceil(indexes.length / PODS_PER_ROW);
  const pods = indexes.map((index, i): Pod => {
    const worktree = snapshot.worktrees[index];
    const x = (i % PODS_PER_ROW) * (ROOM_W / PODS_PER_ROW);
    const y = TOP + Math.floor(i / PODS_PER_ROW) * ROW_H;
    const desk = rect(x + 8, y + 16, 64, 16);
    return {
      worktreeId: worktree.id,
      branch: worktree.branch,
      desk,
      seats: [0, 1, 2, 3].map((s): Point => [desk.x + s * 16, y]),
      seated: worktree.sessions.slice(0, SEATS).map((s) => s.id),
      overflow: Math.max(0, worktree.sessions.length - SEATS),
      lampOn: worktree.current,
      papers: papersBucket(worktree.dirty),
      warning: (worktree.dirty?.conflicts ?? 0) > 0,
      files: worktree.dirty?.files,
    };
  });
  return {
    height: Math.min(Math.max(BASE_H, TOP + rows * ROW_H + BOTTOM_MARGIN), MAX_H),
    pods,
    hiddenWorktrees: snapshot.worktrees.length - indexes.length,
  };
}
