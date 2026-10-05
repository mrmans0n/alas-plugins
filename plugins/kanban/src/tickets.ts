// Ticket model: the index, ticket bodies, session following and migration from cards.
// Pure reducers, no SDK calls.

import { takeChars } from "./text.ts";

export const MAX_TITLE_CHARS = 200;
/** The host caps a text field at 4,000 Unicode scalars, so a longer description could not be edited. */
export const MAX_DESCRIPTION_CHARS = 4_000;
export const MAX_LABELS = 8;
export const MAX_LABEL_CHARS = 32;
/** A full body is about 24,000 characters; opening it or adding a comment stays a few ms. */
export const MAX_COMMENTS = 10;
export const MAX_COMMENT_CHARS = 2_000;
/** Bounds the index, posted whole to the page after every change, well inside the 1 MiB message and storage limits. */
export const MAX_INDEX = 300;
/** Closed tickets kept in the index; older ones leave it and their bodies are deleted. */
export const ARCHIVE_KEEP = 15;
export const FORMAT_VERSION = 1;

export const STATUSES = ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"] as const;
export type Status = (typeof STATUSES)[number];
export const STATUS_TITLES: Record<Status, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  cancelled: "Cancelled",
};
export const isStatus = (key: unknown): key is Status => STATUSES.includes(key as Status);
export const closed = (status: Status): boolean => status === "done" || status === "cancelled";

export const PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_TITLES: Record<Priority, string> = {
  none: "No priority",
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};
export const isPriority = (key: unknown): key is Priority => PRIORITIES.includes(key as Priority);

/** One index record, stored with snake_case keys. Empty fields are not written (see `store.compact`). */
export interface Entry {
  number: number;
  title: string;
  status: Status;
  priority: Priority;
  assignee?: string;
  session_id?: string;
  branch?: string;
  agent_state?: string;
  following: boolean;
  seen: boolean;
  /** The last message was already fetched for this session's current idle. */
  fetched: boolean;
  error?: string;
}

export type Author = "you" | "agent";

export interface Comment {
  author: Author;
  text: string;
}

export interface Body {
  description: string;
  labels: string[];
  comments: Comment[];
}

export const emptyBody = (): Body => ({ description: "", labels: [], comments: [] });

export interface Meta {
  version: number;
  next_number: number;
}

/** A session from the snapshot, with its worktree's branch. */
export interface SessionRef {
  id: string;
  state: string;
  branch: string;
}

const clipComment = (text: string): string => takeChars(text.trim(), MAX_COMMENT_CHARS);

/**
 * Adds an agent's reply unless it repeats the last one. The host answers with the
 * transcript's last reply, so a reopened session can report the same reply again.
 * Returns whether it was added.
 */
export function agentReply(body: Body, text: string): boolean {
  const clipped = clipComment(text);
  const last = body.comments.findLast((c) => c.author === "agent");
  if (clipped === "" || last?.text === clipped) return false;
  addComment(body, "agent", text);
  return true;
}

/** Trims and clips the text; past the cap the oldest comments go. Empty text is ignored. */
export function addComment(body: Body, author: Author, text: string): void {
  const clipped = clipComment(text);
  if (clipped === "") return;
  body.comments.push({ author, text: clipped });
  if (body.comments.length > MAX_COMMENTS) body.comments.splice(0, body.comments.length - MAX_COMMENTS);
}

/** The old card board, read only to migrate it. */
export type Column = "Backlog" | "Running" | "NeedsYou" | "Review" | "Done";

export interface Card {
  id: number;
  title: string;
  prompt: string;
  column: Column;
  session_id?: string;
  branch?: string;
  error?: string;
  following: boolean;
  seen: boolean;
  agent_state?: string;
}

const COLUMN_STATUS: Record<Column, Status> = {
  Backlog: "backlog",
  Running: "in_progress",
  NeedsYou: "in_progress",
  Review: "in_review",
  Done: "done",
};

export class Tracker {
  meta: Meta = { version: 0, next_number: 0 };
  /**
   * Board order: the page shows each status's tickets in index order. New tickets go to the end, and
   * a ticket moves to the end when it is closed, so closed tickets are in closing order (unless
   * reordered by hand) and `archive` drops the first of them.
   */
  index: Entry[] = [];

  /** Returns the new ticket number, or `undefined` for an empty title or a full index. */
  create(title: string, priority: Priority, assignee?: string): number | undefined {
    title = title.trim();
    if (title === "" || this.index.length >= MAX_INDEX) return undefined;
    // A stale stored next_number must not reuse a number still in the index.
    let number = Math.max(this.meta.next_number, 1);
    for (const e of this.index) number = Math.max(number, e.number + 1);
    this.meta.next_number = number + 1;
    this.index.push({
      number,
      title: takeChars(title, MAX_TITLE_CHARS),
      status: "backlog",
      priority,
      assignee,
      following: false,
      seen: false,
      fetched: false,
    });
    return number;
  }

  entry(number: number): Entry | undefined {
    return this.index.find((e) => e.number === number);
  }

  /**
   * Done and Cancelled stop following; any other status follows while there is a session.
   * Closing an open ticket moves it to the end of the index (see `index`).
   */
  setStatus(number: number, status: Status): void {
    const i = this.index.findIndex((e) => e.number === number);
    if (i < 0) return;
    const e = this.index[i];
    const closing = closed(status) && !closed(e.status);
    e.status = status;
    e.following = !closed(status) && e.session_id !== undefined;
    if (closing) this.index.push(...this.index.splice(i, 1));
  }

  /**
   * Drag and drop: gives the ticket `status` (as `setStatus` does) and places it just before ticket
   * `before`, or last among `status`'s tickets when `before` is absent or not in that status.
   */
  move(number: number, status: Status, before?: number): void {
    if (!this.entry(number) || number === before) return;
    this.setStatus(number, status);
    const i = this.index.findIndex((e) => e.number === number);
    const [e] = this.index.splice(i, 1);
    const target = this.index.findIndex((t) => t.number === before && t.status === status);
    if (target >= 0) return void this.index.splice(target, 0, e);
    const last = this.index.findLastIndex((t) => t.status === status);
    this.index.splice(last >= 0 ? last + 1 : this.index.length, 0, e);
  }

  delete(number: number): void {
    this.index = this.index.filter((e) => e.number !== number);
  }

  started(number: number, sessionId: string, branch: string): void {
    const e = this.entry(number);
    if (!e) return;
    e.status = "in_progress";
    e.session_id = sessionId;
    e.branch = branch;
    e.following = true;
    e.seen = e.fetched = false;
    e.agent_state = e.error = undefined;
  }

  /** The host refused a Start, so no new session exists: the ticket keeps any session it had and only shows the reason. */
  startFailed(number: number, reason: string): void {
    const e = this.entry(number);
    if (e) e.error = reason;
  }

  /**
   * An accepted start failed in the background: its session never came up. A closed ticket
   * stays closed. Returns whether a ticket had that session.
   */
  taskFailed(sessionId: string, reason: string): boolean {
    const e = this.index.find((e) => e.session_id === sessionId);
    if (!e) return false;
    if (!closed(e.status)) e.status = "todo";
    e.error = reason;
    e.session_id = e.agent_state = undefined;
    e.following = e.seen = e.fetched = false;
    return true;
  }

  /**
   * Follows the snapshot's sessions. Returns whether any entry changed and the (number, session id)
   * pairs whose last message should be fetched. A following ticket moves only when its session's
   * state changes, so a manual status change holds until the agent does something new. A session
   * not seen yet leaves the ticket alone.
   */
  sync(sessions: SessionRef[]): { changed: boolean; fetch: [number, string][] } {
    let changed = false;
    const fetch: [number, string][] = [];
    for (const e of this.index) {
      const sid = e.session_id;
      if (sid === undefined) continue;
      const session = sessions.find((s) => s.id === sid);
      // task/start answers with the requested branch; the worktree may have a suffixed one.
      if (session && e.branch !== session.branch) {
        e.branch = session.branch;
        changed = true;
      }
      if (!e.following) continue;
      const state = session?.state;
      // A session gone after it was reported idle (e.g. after a relaunch) changes nothing, so a manual status holds.
      const goneAfterIdle = state === undefined && e.agent_state === "idle";
      if ((state === undefined && !e.seen) || (e.seen && e.agent_state === state) || goneAfterIdle) continue;
      if (state === "running" || state === "awaiting_input" || state === "permission_request") e.status = "in_progress";
      else if (state === "idle" || state === undefined) e.status = "in_review";
      if (state === "running") e.fetched = false;
      else if (state === "idle" && !e.fetched) {
        e.fetched = true;
        fetch.push([e.number, sid]);
      }
      e.seen = true;
      e.agent_state = state;
      changed = true;
    }
    return { changed, fetch };
  }

  /** Drops the oldest Done and Cancelled tickets past `ARCHIVE_KEEP` and returns their numbers, whose bodies the caller deletes. */
  archive(): number[] {
    let excess = this.index.filter((e) => closed(e.status)).length - ARCHIVE_KEEP;
    const dropped: number[] = [];
    if (excess <= 0) return dropped;
    this.index = this.index.filter((e) => {
      if (excess > 0 && closed(e.status)) {
        excess--;
        dropped.push(e.number);
        return false;
      }
      return true;
    });
    return dropped;
  }

  inStatus(status: Status): Entry[] {
    return this.index.filter((e) => e.status === status);
  }

  /**
   * Each card becomes a ticket numbered in card order, its prompt the description. Idle
   * sessions count as fetched, so nothing is fetched retroactively. Empty bodies are omitted.
   */
  static migrate(cards: Card[]): { tracker: Tracker; bodies: [number, Body][] } {
    const tracker = new Tracker();
    const bodies: [number, Body][] = [];
    cards.forEach((c, i) => {
      const number = i + 1;
      tracker.index.push({
        number,
        title: c.title,
        status: COLUMN_STATUS[c.column],
        priority: "none",
        session_id: c.session_id,
        branch: c.branch,
        agent_state: c.agent_state,
        following: c.following,
        seen: c.seen,
        fetched: c.agent_state === "idle",
        error: c.error,
      });
      // The old board stays stored, so a longer prompt is not lost.
      if (c.prompt !== "") bodies.push([number, { ...emptyBody(), description: takeChars(c.prompt, MAX_DESCRIPTION_CHARS) }]);
    });
    tracker.meta = { version: FORMAT_VERSION, next_number: cards.length + 1 };
    return { tracker, bodies };
  }
}
