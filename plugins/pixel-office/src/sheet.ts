/** A sprite sheet decoded at build time. Pixels are palette indices; 0 is transparent. */
export interface Sheet {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/** Each character of `indices` is one pixel's palette index plus 48 (see scripts/sprites.mjs). */
export function sheet(width: number, height: number, indices: string): Sheet {
  const pixels = new Uint8Array(width * height);
  for (let i = 0; i < pixels.length; i++) pixels[i] = indices.charCodeAt(i) - 48;
  return { width, height, pixels };
}
