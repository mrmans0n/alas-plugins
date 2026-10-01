// Who is where. Deterministic given the snapshot sequence and tick deltas.

import type { Plan, Snapshot } from "@alas/plugin";
import { COUCH_SPOTS, DOOR, LOUNGE, SIDE_X, aisleY, type Layout, type Point } from "./layout.ts";
import { hash, paletteFor } from "./look.ts";

export const WALK_SPEED = 32;
export const SLEEP_AFTER_MS = 300_000;
const DWELL_MIN_MS = 8_000;
const DWELL_MAX_MS = 20_000;

export type Mood = "working" | "waiting" | "permission" | "idle" | "unknown";

const MOODS: Record<string, Mood> = { running: "working", awaiting_input: "waiting", permission_request: "permission", idle: "idle" };
export const moodOf = (state: string): Mood => (Object.hasOwn(MOODS, state) ? MOODS[state] : "unknown");

export const MOOD_WORDS: Record<Mood, string> = {
  working: "working",
  waiting: "awaiting input",
  permission: "needs permission",
  idle: "idle",
  unknown: "unknown",
};

export type Activity = "walking" | "seated" | "lounging" | "sleeping";

export class Character {
  readonly sessionId: string;
  readonly agent: string;
  /** Skin, hair and shirt, fixed for the session. */
  readonly palette: Uint32Array;
  title: string;
  mood: Mood;
  plan?: Plan | null;
  x: number = DOOR[0];
  y: number = DOOR[1];
  activity: Activity = "walking";
  facingLeft = false;
  /** -1 walking up, 1 walking down, 0 walking sideways; picks the walk row. */
  vertical = 0;
  /** Drives walk and typing frames. */
  walkMs = 0;
  leaving = false;
  seat: Point;
  path: Point[] = [];
  /** What to become on arrival. */
  arriveAs: Activity = "seated";
  idleMs = 0;
  dwellMs = 0;
  rng: number;

  constructor(sessionId: string, agent: string, title: string, mood: Mood, plan: Plan | null | undefined, seat: Point) {
    this.sessionId = sessionId;
    this.agent = agent;
    this.palette = paletteFor(sessionId, agent);
    this.title = title;
    this.mood = mood;
    this.plan = plan;
    this.seat = seat;
    this.rng = (hash(sessionId) | 1) >>> 0;
  }

  /** xorshift32; seeded from the session id so routines are reproducible. */
  nextRandom(): number {
    let x = this.rng;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (this.rng = x >>> 0);
  }

  dwell(): number {
    return DWELL_MIN_MS + (this.nextRandom() % (DWELL_MAX_MS - DWELL_MIN_MS));
  }

  /** Door -> corridor -> row aisle -> target, as straight segments. */
  walkTo([tx, ty]: Point, arriveAs: Activity): void {
    const here = aisleY(Math.trunc(this.y));
    const there = aisleY(ty);
    this.path =
      here === there
        ? [[this.x, here], [tx, there], [tx, ty]]
        : [[this.x, here], [SIDE_X, here], [SIDE_X, there], [tx, there], [tx, ty]];
    this.activity = "walking";
    this.arriveAs = arriveAs;
  }
}

export class World {
  characters: Character[] = [];
  clockMs = 0;

  /** Adds arrivals, sends departures to the door, and re-routes anyone whose mood or seat changed. */
  sync(snapshot: Snapshot, layout: Layout): void {
    const present = new Set<string>();
    for (const pod of layout.pods) {
      const worktree = snapshot.worktrees.find((w) => w.id === pod.worktreeId)!;
      pod.seated.forEach((sessionId, seatIndex) => {
        present.add(sessionId);
        const session = worktree.sessions.find((s) => s.id === sessionId)!;
        const seat = pod.seats[seatIndex];
        const mood = moodOf(session.state);
        const c = this.characters.find((c) => c.sessionId === sessionId && !c.leaving);
        if (!c) {
          const arrival = new Character(sessionId, session.agent, session.title, mood, session.plan, seat);
          arrival.walkTo(seat, "seated");
          this.characters.push(arrival);
          return;
        }
        c.title = session.title;
        c.plan = session.plan;
        if (c.mood !== mood || c.seat[0] !== seat[0] || c.seat[1] !== seat[1]) {
          if (mood !== "idle") c.idleMs = 0;
          c.mood = mood;
          c.seat = seat;
          reroute(c);
        }
      });
    }
    for (const c of this.characters) {
      if (c.leaving || present.has(c.sessionId)) continue;
      c.leaving = true;
      // Any non-walking arrival state works: `step` drops leavers once they stop walking.
      c.walkTo(DOOR, "seated");
    }
  }

  step(dtMs: number): void {
    this.clockMs += dtMs;
    for (const c of this.characters) {
      const taken = takenSpots(this.characters);
      c.walkMs = (c.walkMs + dtMs) >>> 0;
      const idle = c.mood === "idle" && !c.leaving;
      if (idle) c.idleMs += dtMs;
      advance(c, dtMs);
      if (c.activity === "walking" || !idle) continue;
      if (c.idleMs >= SLEEP_AFTER_MS && c.activity !== "sleeping") {
        c.walkTo(pickSpot(c, COUCH_SPOTS, taken), "sleeping");
        continue;
      }
      if (c.activity === "sleeping") continue;
      c.dwellMs = Math.max(0, c.dwellMs - dtMs);
      if (c.dwellMs === 0) {
        if (c.activity === "lounging" && c.nextRandom() % 2 === 0) c.walkTo(c.seat, "seated");
        else c.walkTo(pickSpot(c, LOUNGE, taken), "lounging");
      }
    }
    this.characters = this.characters.filter((c) => !(c.leaving && c.activity !== "walking"));
  }
}

/** Where every non-leaving character is, or is heading to. */
function takenSpots(characters: Character[]): Point[] {
  const taken: Point[] = [];
  for (const c of characters) {
    if (c.leaving) continue;
    const target = c.activity === "walking" ? c.path.at(-1) : undefined;
    taken.push(target ? [Math.trunc(target[0]), Math.trunc(target[1])] : [Math.trunc(c.x), Math.trunc(c.y)]);
  }
  return taken;
}

/** A random spot nobody occupies or is heading to; any spot if all are taken. */
function pickSpot(c: Character, spots: Point[], taken: Point[]): Point {
  const free = spots.filter(([x, y]) => !taken.some((t) => t[0] === x && t[1] === y));
  const pool = free.length > 0 ? free : spots;
  return pool[c.nextRandom() % pool.length];
}

function reroute(c: Character): void {
  if (c.mood !== "idle") {
    // Already at the desk: busy moods just change the pose.
    if (c.activity === "seated" && c.x === c.seat[0] && c.y === c.seat[1]) return;
    c.walkTo(c.seat, "seated");
  } else {
    // Newly idle: stay put for one dwell, then start wandering.
    c.dwellMs = c.dwell();
    if (c.activity === "walking") c.walkTo(c.seat, "seated");
  }
}

function advance(c: Character, dtMs: number): void {
  let budget = (WALK_SPEED * dtMs) / 1000;
  while (budget > 0 && c.path.length > 0) {
    const [tx, ty] = c.path[0];
    const dx = tx - c.x, dy = ty - c.y;
    const distance = Math.hypot(dx, dy);
    if (dx !== 0) c.facingLeft = dx < 0;
    c.vertical = Math.abs(dx) >= Math.abs(dy) ? 0 : dy < 0 ? -1 : 1;
    if (distance <= budget) {
      c.x = tx;
      c.y = ty;
      budget -= distance;
      c.path.shift();
    } else {
      c.x += (dx / distance) * budget;
      c.y += (dy / distance) * budget;
      budget = 0;
    }
  }
  if (c.path.length === 0 && c.activity === "walking") {
    c.activity = c.arriveAs;
    if (c.activity === "lounging" || (c.activity === "seated" && c.mood === "idle")) c.dwellMs = c.dwell();
  }
}
