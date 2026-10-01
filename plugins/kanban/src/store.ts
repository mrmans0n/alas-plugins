// Storage layout: `meta`, `index`, and one `ticket-<n>` key per body. Pure, no SDK calls.
// Stored values are checked field by field: a value that does not decode is reported, never
// replaced, so a bad read cannot lead to saving an empty tracker over recoverable data.

import { MAX_INDEX, Tracker, emptyBody, isPriority, isStatus, type Body, type Card, type Column, type Entry, type Meta } from "./tickets.ts";

export const META = "meta";
export const INDEX = "index";
export const LEGACY = "board";

export const bodyKey = (number: number): string => `ticket-${number}`;

export type Loaded =
  | { kind: "fresh" }
  | { kind: "tracker"; tracker: Tracker }
  | { kind: "migrated"; tracker: Tracker; bodies: [number, Body][] }
  /** Nothing may be saved; the text is for the notice. */
  | { kind: "unreadable"; reason: string };

type Fields = Record<string, unknown>;

function fail(message: string): never {
  throw new Error(message);
}

function object(v: unknown, what: string): Fields {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Fields) : fail(`${what}: expected an object`);
}

function array(v: unknown, what: string): unknown[] {
  return Array.isArray(v) ? v : fail(`${what}: expected an array`);
}

function string(v: unknown, what: string): string {
  return typeof v === "string" ? v : fail(`${what}: expected a string`);
}

function optionalString(v: unknown, what: string): string | undefined {
  return v === undefined || v === null ? undefined : string(v, what);
}

function flag(v: unknown, what: string): boolean {
  return v === undefined || v === null ? false : typeof v === "boolean" ? v : fail(`${what}: expected a boolean`);
}

function count(v: unknown, what: string): number {
  return Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : fail(`${what}: expected a non-negative integer`);
}

function decodeMeta(v: unknown): Meta {
  const o = object(v ?? {}, "meta");
  return {
    version: o.version === undefined ? 0 : count(o.version, "meta.version"),
    next_number: o.next_number === undefined ? 0 : count(o.next_number, "meta.next_number"),
  };
}

function decodeEntry(v: unknown, i: number): Entry {
  const what = `index[${i}]`;
  const o = object(v, what);
  const status = isStatus(o.status) ? o.status : fail(`${what}.status: unknown status`);
  const priority = o.priority === undefined ? "none" : isPriority(o.priority) ? o.priority : fail(`${what}.priority: unknown priority`);
  return {
    number: count(o.number, `${what}.number`),
    title: string(o.title, `${what}.title`),
    status,
    priority,
    assignee: optionalString(o.assignee, `${what}.assignee`),
    session_id: optionalString(o.session_id, `${what}.session_id`),
    branch: optionalString(o.branch, `${what}.branch`),
    agent_state: optionalString(o.agent_state, `${what}.agent_state`),
    following: flag(o.following, `${what}.following`),
    seen: flag(o.seen, `${what}.seen`),
    fetched: flag(o.fetched, `${what}.fetched`),
    error: optionalString(o.error, `${what}.error`),
  };
}

const COLUMNS: Column[] = ["Backlog", "Running", "NeedsYou", "Review", "Done"];

function decodeBoard(v: unknown): Card[] {
  const board = object(v, "board");
  return array(board.cards ?? [], "board.cards").map((c, i) => {
    const what = `board.cards[${i}]`;
    const o = object(c, what);
    return {
      id: count(o.id, `${what}.id`),
      title: string(o.title, `${what}.title`),
      prompt: string(o.prompt, `${what}.prompt`),
      column: COLUMNS.includes(o.column as Column) ? (o.column as Column) : fail(`${what}.column: unknown column`),
      session_id: optionalString(o.session_id, `${what}.session_id`),
      branch: optionalString(o.branch, `${what}.branch`),
      error: optionalString(o.error, `${what}.error`),
      following: flag(o.following, `${what}.following`),
      seen: flag(o.seen, `${what}.seen`),
      agent_state: optionalString(o.agent_state, `${what}.agent_state`),
    };
  });
}

/**
 * A missing body (`null`) is empty. One that is stored but cannot be decoded throws, so the caller
 * leaves it untouched instead of saving an empty body over recoverable data.
 */
export function parseBody(v: unknown): Body {
  if (v === null || v === undefined) return emptyBody();
  const o = object(v, "body");
  return {
    description: o.description === undefined ? "" : string(o.description, "body.description"),
    labels: array(o.labels ?? [], "body.labels").map((l, i) => string(l, `body.labels[${i}]`)),
    comments: array(o.comments ?? [], "body.comments").map((c, i) => {
      const comment = object(c, `body.comments[${i}]`);
      const author = comment.author === "you" || comment.author === "agent" ? comment.author : fail(`body.comments[${i}].author: unknown author`);
      return { author, text: string(comment.text, `body.comments[${i}].text`) };
    }),
  };
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Loads the stored values (`null` = unset). The index is the source of truth: when it is present
 * it is loaded, with default meta if that is missing. Without one, a decodable old `board` means a
 * first or interrupted migration (numbering is deterministic, so migrating again is idempotent),
 * so `legacy` must be supplied whenever the index is absent.
 */
export function load(meta: unknown, index: unknown, legacy: unknown): Loaded {
  const unreadable = (what: string, error: unknown, tail: string): Loaded => ({
    kind: "unreadable",
    reason: `The ${what} could not be read (${describe(error)}); ${tail}`,
  });
  if (index === null) {
    if (legacy !== null) {
      try {
        const { tracker, bodies } = Tracker.migrate(decodeBoard(legacy));
        relaunched(tracker);
        return { kind: "migrated", tracker, bodies };
      } catch (error) {
        // Meta without an index or a usable board: an empty tracker that keeps its numbering.
        if (meta === null) return unreadable("old board", error, "it was left untouched and nothing will be saved.");
      }
    } else if (meta === null) {
      return { kind: "fresh" };
    }
    index = [];
  }
  const tracker = new Tracker();
  try {
    tracker.meta = decodeMeta(meta);
    tracker.index = array(index, "index").map(decodeEntry);
  } catch (error) {
    return unreadable("stored tickets", error, "nothing will be saved.");
  }
  // The floor counts every stored number, so one dropped below is never reused.
  for (const e of tracker.index) tracker.meta.next_number = Math.max(tracker.meta.next_number, e.number + 1);
  tracker.meta.next_number = Math.max(tracker.meta.next_number, 1);
  // Tampered storage must not break the view's unique ids or size limits on every start.
  const seen = new Set<number>();
  tracker.index = tracker.index.filter((e) => !seen.has(e.number) && seen.add(e.number)).slice(0, MAX_INDEX);
  relaunched(tracker);
  return { kind: "tracker", tracker };
}

/**
 * A relaunch ends any start in flight, so every linked session counts as seen: one missing from
 * the next snapshot then moves its ticket to In review, and Start is offered again. A followed
 * session never seen gets the state `starting`, so that move counts as a change.
 */
function relaunched(tracker: Tracker): void {
  for (const e of tracker.index) {
    if (e.session_id === undefined || e.seen) continue;
    e.seen = true;
    if (e.following && e.agent_state === undefined) e.agent_state = "starting";
  }
}

/** An index record without its empty fields: the index is saved after every change. */
function compact(e: Entry): object {
  return {
    number: e.number,
    title: e.title,
    status: e.status,
    priority: e.priority,
    assignee: e.assignee,
    session_id: e.session_id,
    branch: e.branch,
    agent_state: e.agent_state,
    following: e.following || undefined,
    seen: e.seen || undefined,
    fetched: e.fetched || undefined,
    error: e.error,
  };
}

/**
 * The writes for one change, in order: meta, bodies, the index (only if `indexChanged`), then
 * deletes. Each item is (key, value, or `null` to delete). `deleted` is only for tickets removed
 * by `Tracker.delete` or `Tracker.archive`.
 */
export function writes(tracker: Tracker, bodies: [number, Body][], deleted: number[], indexChanged: boolean): [string, unknown][] {
  const out: [string, unknown][] = [[META, { ...tracker.meta }]];
  for (const [n, body] of bodies) out.push([bodyKey(n), body]);
  if (indexChanged) out.push([INDEX, tracker.index.map(compact)]);
  for (const n of deleted) out.push([bodyKey(n), null]);
  return out;
}
