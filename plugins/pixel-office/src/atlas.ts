// Sprite rectangles in the sheets under assets/. Keep in sync with the PNG layouts.
import { rect, type Rect } from "./canvas.ts";

export const CHAR_W = 16;
export const CHAR_H = 24;
export const WALK_DOWN = 0;
export const WALK_UP = 24;
export const WALK_RIGHT = 48;
export const SIT = rect(0, 72, 16, 24);
export const TYPE = [rect(16, 72, 16, 24), rect(32, 72, 16, 24)];
export const HAND = rect(48, 72, 16, 24);
export const SLEEP = rect(64, 72, 16, 24);

export const FLOOR = rect(0, 0, 16, 16);
export const WALL = rect(16, 0, 16, 16);
export const DESK = rect(32, 0, 64, 16);
export const CHAIR = rect(96, 0, 16, 16);
export const PLANT = rect(112, 0, 16, 16);
export const MONITOR_OFF = rect(0, 16, 16, 16);
export const MONITOR_ON = [rect(16, 16, 16, 16), rect(32, 16, 16, 16)];
export const LAMP_OFF = rect(48, 16, 8, 16);
export const LAMP_ON = rect(56, 16, 8, 16);
export const COUCH = rect(64, 16, 32, 16);
export const COFFEE = rect(0, 32, 16, 32);
export const COOLER = rect(16, 32, 16, 32);
export const DOOR = rect(32, 32, 16, 32);
export const SIGN = rect(48, 32, 32, 16);

export const BUBBLE_Q = rect(0, 0, 16, 16);
export const BUBBLE_BANG = [rect(16, 0, 16, 16), rect(32, 0, 16, 16)];
export const ZZ = rect(48, 0, 8, 8);
export const WARNING = rect(56, 0, 8, 8);
export const PAPERS = [rect(0, 16, 16, 16), rect(16, 16, 16, 16), rect(32, 16, 16, 16)];
export const BAR_FRAME = rect(48, 16, 16, 4);

/** Walk frame `n` (0..4) in the row at `rowY`. */
export const walk = (rowY: number, n: number): Rect => rect(n * CHAR_W, rowY, CHAR_W, CHAR_H);
