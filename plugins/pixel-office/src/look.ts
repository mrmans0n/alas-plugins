import { rgba } from "./canvas.ts";
import { PALETTE } from "./sprites.gen.ts";

/** FNV-1a over UTF-16 code units (bytes, for the ASCII ids Alas uses). */
export function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

type Ramp = [number, number, number];
const ramp = (...colours: [number, number, number][]): Ramp => colours.map(([r, g, b]) => rgba(r, g, b)) as Ramp;

const SKIN: Ramp[] = [
  ramp([138, 90, 60], [198, 138, 94], [234, 178, 140]),
  ramp([92, 58, 38], [140, 92, 60], [182, 128, 90]),
  ramp([168, 120, 88], [222, 170, 132], [246, 208, 176]),
  ramp([60, 38, 26], [100, 66, 44], [140, 98, 68]),
];

const HAIR: Ramp[] = [
  ramp([58, 42, 34], [94, 67, 50], [134, 100, 74]),
  ramp([20, 20, 28], [44, 44, 58], [70, 70, 90]),
  ramp([150, 90, 30], [200, 130, 50], [236, 180, 90]),
  ramp([170, 60, 40], [210, 90, 60], [240, 140, 100]),
  ramp([150, 150, 160], [196, 196, 206], [232, 232, 240]),
  ramp([70, 40, 90], [110, 70, 140], [150, 110, 190]),
];

export const SHIRTS: Ramp[] = [
  ramp([168, 76, 36], [218, 112, 60], [244, 156, 104]), // orange
  ramp([36, 100, 60], [60, 150, 90], [110, 200, 130]), // green
  ramp([42, 58, 110], [62, 86, 160], [106, 134, 204]), // blue
  ramp([90, 50, 130], [130, 80, 180], [176, 130, 220]), // purple
  ramp([70, 70, 80], [110, 110, 124], [160, 160, 176]), // grey
  ramp([30, 110, 120], [50, 160, 170], [110, 210, 214]), // teal
  ramp([150, 50, 90], [210, 80, 130], [240, 140, 180]), // pink
];

const AGENT_SHIRTS: Record<string, number> = { claude: 0, codex: 1, gemini: 2, copilot: 3, cursor: 4, opencode: 5, pi: 6 };

const shirtFor = (agent: string): number => (Object.hasOwn(AGENT_SHIRTS, agent) ? AGENT_SHIRTS[agent] : hash(agent) % SHIRTS.length);

/** Same session, same look: skin and hair from the session id, shirt from the agent. */
export function paletteFor(sessionId: string, agent: string): Uint32Array {
  const h = hash(sessionId);
  const palette = PALETTE.slice();
  const ramps = [SKIN[h % SKIN.length], HAIR[(h >>> 8) % HAIR.length], SHIRTS[shirtFor(agent)]];
  ramps.forEach((r, i) => palette.set(r, 1 + i * 3));
  return palette;
}
