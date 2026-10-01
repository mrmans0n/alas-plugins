// Host limits count Unicode scalars (and ids count UTF-8 bytes), not UTF-16 units.

const SURROGATES = /[\uD800-\uDFFF]/;

/** The first `max` Unicode scalars of `s`; `s` itself when it is not longer. */
export function takeChars(s: string, max: number): string {
  if (s.length <= max) return s;
  // Without surrogate pairs, units are scalars, and the regex runs natively.
  if (!SURROGATES.test(s)) return s.slice(0, max);
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    if (count === max) return s.slice(0, i);
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    count++;
  }
  return s;
}

export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // A surrogate pair is 4 bytes: 2 per unit.
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdfff ? 2 : 3;
  }
  return n;
}

/** The text before the first line break (`\n` or `\r\n`). */
export function firstLine(s: string): string {
  const line = s.split("\n", 1)[0] ?? "";
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
