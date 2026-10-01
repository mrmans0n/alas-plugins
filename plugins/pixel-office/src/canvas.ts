import type { Sheet } from "./sheet.ts";
import { FONT } from "./sprites.gen.ts";

/** A colour as a little-endian u32: the bytes are R, G, B, A in memory. */
export type Rgba = number;

export const rgba = (r: number, g: number, b: number, a = 255): Rgba => (r | (g << 8) | (b << 16) | (a << 24)) >>> 0;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

/** Glyphs are 4x6 cells (3 px wide plus 1 px spacing), ASCII 32..=126, 16 per row. */
export const GLYPH_W = 4;
export const GLYPH_H = 6;

export class Canvas {
  readonly width: number;
  readonly height: number;
  /** RGBA8, row-major: what `alas.present` takes. */
  readonly pixels: Uint8Array;
  /** The same memory, one element per pixel. */
  readonly words: Uint32Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.words = new Uint32Array(width * height);
    this.pixels = new Uint8Array(this.words.buffer);
  }

  /** `r` clipped to the canvas, or `undefined` when nothing is left. */
  private clip(r: Rect): [number, number, number, number] | undefined {
    const x0 = Math.max(r.x, 0), y0 = Math.max(r.y, 0);
    const x1 = Math.min(r.x + r.w, this.width), y1 = Math.min(r.y + r.h, this.height);
    return x0 < x1 && y0 < y1 ? [x0, y0, x1, y1] : undefined;
  }

  fill(r: Rect, color: Rgba): void {
    const c = this.clip(r);
    if (!c) return;
    for (let y = c[1]; y < c[3]; y++) this.words.fill(color, y * this.width + c[0], y * this.width + c[2]);
  }

  /** Copies `r` from `src`, which must be the same size as this canvas. */
  copyFrom(src: Canvas, r: Rect): void {
    const c = this.clip(r);
    if (!c) return;
    for (let y = c[1]; y < c[3]; y++) {
      const a = y * this.width + c[0], b = y * this.width + c[2];
      this.words.set(src.words.subarray(a, b), a);
    }
  }

  /** Draws `src` from `sheet` at (dx, dy). `palette[index]` gives each colour; index 0 is skipped. `dim` halves brightness. */
  blit(sheet: Sheet, src: Rect, dx: number, dy: number, palette: Uint32Array, flip = false, dim = false): void {
    const { width, height, words } = this;
    for (let sy = 0; sy < src.h; sy++) {
      const py = src.y + sy, y = dy + sy;
      if (py >= sheet.height || y < 0 || y >= height) continue;
      const from = py * sheet.width, to = y * width;
      for (let sx = 0; sx < src.w; sx++) {
        const px = src.x + sx;
        if (px >= sheet.width) continue;
        const index = sheet.pixels[from + px];
        if (index === 0) continue;
        const x = flip ? dx + src.w - 1 - sx : dx + sx;
        if (x < 0 || x >= width) continue;
        const color = palette[index];
        words[to + x] = dim ? ((color >>> 1) & 0x7f7f7f) | 0xff000000 : color;
      }
    }
  }

  text(x: number, y: number, text: string, color: Rgba): void {
    let n = 0;
    for (const ch of text) {
      const c = ch.codePointAt(0)!;
      const code = c >= 32 && c <= 126 ? c - 32 : 63 - 32; // '?'
      const gx = (code % 16) * GLYPH_W, gy = Math.floor(code / 16) * GLYPH_H;
      for (let sy = 0; sy < GLYPH_H; sy++) {
        const py = y + sy;
        if (py < 0 || py >= this.height) continue;
        for (let sx = 0; sx < GLYPH_W; sx++) {
          const px = x + n * GLYPH_W + sx;
          // Any non-transparent font pixel is "on".
          if (px >= 0 && px < this.width && FONT.pixels[(gy + sy) * FONT.width + gx + sx] !== 0) this.words[py * this.width + px] = color;
        }
      }
      n++;
    }
  }
}

export const textWidth = (text: string): number => [...text].length * GLYPH_W;
