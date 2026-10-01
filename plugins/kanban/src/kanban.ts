// Kanban: a small ticket tracker whose tickets start agents in new worktrees and follow them.

import {
  agentList,
  lastMessage,
  log,
  parseAgents,
  parseLastMessage,
  render,
  requestSnapshot,
  sessionFocus,
  storageGet,
  storageSet,
  taskStart,
  type Agent,
  type Event,
  type Plugin,
  type RpcError,
  type Snapshot,
} from "@alas/plugin";
import * as store from "./store.ts";
import { firstLine, takeChars } from "./text.ts";
import {
  FORMAT_VERSION,
  MAX_DESCRIPTION_CHARS,
  MAX_TITLE_CHARS,
  Tracker,
  addComment,
  agentReply,
  closed,
  emptyBody,
  isPriority,
  isStatus,
  type Body,
  type Entry,
  type SessionRef,
} from "./tickets.ts";
import * as view from "./view.ts";

export const TRACKER_FULL = "The tracker is full: delete some tickets first.";
export const SAVE_FAILED = "Could not save: ";
const DESCRIPTION_CUT = "The description was cut to 4,000 characters.";
/**
 * session/last_message requests in flight at once. Alas stops a plugin that sends more than 64
 * messages in one call, and a snapshot can turn every followed ticket idle together, so the rest
 * wait in `fetchQueue` and go out as replies arrive. Leaves room for the saves and the render.
 */
export const MAX_FETCHES_IN_FLIGHT = 16;

/** What to do with a ticket body once it is read: show it, append an agent's comment, or start the ticket. */
type Then = { kind: "open" } | { kind: "comment"; text: string } | { kind: "start" };

/** A storage/get reply: the stored value (`null` when unset), or the error. */
type Read = { value: unknown } | { error: RpcError };

const isSaveFailure = (notice: string | undefined): boolean => notice?.startsWith(SAVE_FAILED) ?? false;

function sendStart(e: Entry, description: string): number {
  const prompt = `KAN-${e.number}: ${e.title}\n\n${description}`.trimEnd();
  return taskStart(e.title, prompt, { branch: `task/kan-${e.number}`, agent: e.assignee });
}

export class Kanban implements Plugin {
  tracker = new Tracker();
  screen: view.Screen = view.boardScreen();
  /** The open ticket's body, once read. Its description and comments are editable only then, so a body is never saved before it is known. */
  openBody?: { number: number; body: Body };
  agents: Agent[] = [];
  draft = view.emptyDraft();
  /** Generation of the New ticket and description field ids; bumping it resets those fields. */
  form = 0;
  /** Generation of the comment field id, separate so posting keeps unsaved description text. */
  commentForm = 0;
  notice?: string;
  loaded = false;
  /** The store could not be read, so it is never overwritten. */
  loadFailed = false;
  /** storage/get ids for meta, index and the legacy board, and their replies as they arrive. */
  load: number[] = [];
  loadReplies: (Read | undefined)[] = [undefined, undefined, undefined];
  /** storage/get id, ticket, and what to do with the body. */
  bodyLoads: { id: number; number: number; then: Then }[] = [];
  /** task/start id → ticket. */
  pendingStarts = new Map<number, number>();
  /** session/last_message id → ticket. */
  fetches = new Map<number, number>();
  /** Last messages still to fetch: (ticket, session id), oldest first. */
  fetchQueue: [number, string][] = [];
  agentRequest?: number;
  /** The session/focus request of the last Open session click. */
  focusRequest?: number;
  /** storage/set id → the save batch it belongs to. */
  saves = new Map<number, number>();
  /** The last save batch issued, and the latest one with a failed write. A failure notice clears only when a later batch completes with every write accepted. */
  saveBatch = 0;
  lastFailedBatch?: number;
  /** Tickets whose stored body could not be decoded this session: read-only, never written. */
  unreadable = new Set<number>();
  /** The latest sessions, kept so a snapshot that beats the load still applies. `undefined` until the first snapshot, so a tracker loaded first is not synced against no sessions. */
  sessions?: SessionRef[];
  /** The last agent/list reply succeeded, so `agents` is the set Start may use. */
  agentsLoaded = false;

  render(): void {
    if (!this.loaded) return;
    const screen = this.screen;
    const body = screen.kind === "ticket" && this.openBody?.number === screen.number ? this.openBody.body : undefined;
    const starting = [...this.pendingStarts.values()];
    for (const load of this.bodyLoads) if (load.then.kind === "start") starting.push(load.number);
    render(
      0,
      view.render({
        tracker: this.tracker,
        screen,
        body,
        agents: this.agents,
        draft: this.draft,
        form: this.form,
        commentForm: this.commentForm,
        notice: this.notice,
        starting,
        bodyUnreadable: screen.kind === "ticket" && this.unreadable.has(screen.number),
      }),
    );
  }

  /** A load failure's notice stays: it says nothing will be saved. */
  setNotice(notice: string): void {
    if (this.note(notice)) this.render();
  }

  /**
   * Sets the notice without rendering; returns whether it was set. A failed load, or a failed save
   * not yet followed by a good one, is not replaced: either may be the only sign that changes are
   * not stored. A newer save failure does replace one.
   */
  note(notice: string): boolean {
    const held = this.loadFailed || (isSaveFailure(this.notice) && !isSaveFailure(notice));
    if (!held) this.notice = notice;
    return !held;
  }

  /** Sends writes in order, unless the store could not be read. */
  save(writes: [string, unknown][]): void {
    if (this.loadFailed) return;
    this.saveBatch++;
    for (const [key, value] of writes) {
      if (key.startsWith("ticket-") && this.unreadable.has(Number(key.slice("ticket-".length)))) continue;
      this.saves.set(storageSet(key, value), this.saveBatch);
    }
  }

  /** Saves one change (the index, the open body, deleted bodies) and re-renders. */
  commit(indexChanged: boolean, openBody: boolean, deleted: number[]): void {
    if (!this.loaded) return;
    // Nobody can open an archived ticket, so its body goes with it.
    const archived = indexChanged ? this.tracker.archive() : [];
    if (this.screen.kind === "ticket" && !this.tracker.entry(this.screen.number)) {
      this.screen = view.boardScreen();
      this.openBody = undefined;
    }
    const bodies: [number, Body][] = openBody && this.openBody ? [[this.openBody.number, this.openBody.body]] : [];
    this.save(store.writes(this.tracker, bodies, [...deleted, ...archived], indexChanged));
    this.render();
  }

  /** Follows the latest sessions; saves and renders only when a ticket changed. */
  sync(): boolean {
    if (!this.sessions) return false;
    const { changed, fetch } = this.tracker.sync(this.sessions);
    this.fetchQueue.push(...fetch);
    this.drainFetches();
    if (changed) this.commit(true, false, []);
    return changed;
  }

  drainFetches(): void {
    while (this.fetches.size < MAX_FETCHES_IN_FLIGHT && this.fetchQueue.length > 0) {
      const [n, session] = this.fetchQueue.shift()!;
      this.fetches.set(lastMessage(session), n);
    }
  }

  apply(snapshot: Snapshot): void {
    this.sessions = snapshot.worktrees.flatMap((w) => w.sessions.map((s) => ({ id: s.id, state: s.state, branch: w.branch })));
    if (this.loaded) this.sync();
  }

  finishLoad(): void {
    const replies = this.loadReplies as Read[];
    this.loadReplies = [undefined, undefined, undefined];
    const failed = replies.find((r) => "error" in r);
    const loaded: store.Loaded =
      failed && "error" in failed
        ? { kind: "unreadable", reason: `The stored tickets could not be read (${failed.error.message}); nothing will be saved.` }
        : store.load(...(replies.map((r) => ("value" in r ? r.value : null)) as [unknown, unknown, unknown]));
    this.loaded = true;
    switch (loaded.kind) {
      case "fresh":
        this.tracker.meta.version = FORMAT_VERSION;
        break;
      case "tracker":
        this.tracker = loaded.tracker;
        break;
      case "migrated":
        // The old board stays stored, so a downgrade loses nothing.
        this.tracker = loaded.tracker;
        this.save(store.writes(this.tracker, loaded.bodies, [], true));
        break;
      case "unreadable":
        this.loadFailed = true;
        this.notice = loaded.reason;
        break;
    }
    if (!this.sync()) this.render();
  }

  navigate(screen: view.Screen): void {
    this.screen = screen;
    this.openBody = undefined;
    // A failed load or save stays until it no longer holds; other notices go with the screen.
    if (!this.loadFailed && !isSaveFailure(this.notice)) this.notice = undefined;
    this.render();
  }

  open(n: number): void {
    if (!this.tracker.entry(n)) return;
    this.bodyLoads = this.bodyLoads.filter((load) => load.then.kind !== "open");
    // Agents may have been installed since the last screen.
    this.agentRequest = agentList();
    if (this.unreadable.has(n)) {
      this.screen = { kind: "ticket", number: n };
      this.openBody = undefined;
      return this.unreadableNotice(n, "read earlier");
    }
    this.bodyLoads.push({ id: storageGet(store.bodyKey(n)), number: n, then: { kind: "open" } });
    this.navigate({ kind: "ticket", number: n });
  }

  create(text: string): void {
    const trimmed = text.trim();
    const description = takeChars(trimmed, MAX_DESCRIPTION_CHARS);
    const cut = description.length < trimmed.length;
    const title = this.draft.title === "" ? firstLine(description) : this.draft.title;
    if (title.trim() === "") return;
    const n = this.tracker.create(title, this.draft.priority, this.draft.assignee);
    if (n === undefined) {
      if (!this.loadFailed) this.setNotice(TRACKER_FULL);
      return;
    }
    if (this.notice === TRACKER_FULL) this.notice = undefined;
    if (cut) this.note(DESCRIPTION_CUT);
    this.draft = view.emptyDraft();
    this.form++;
    const bodies: [number, Body][] = description === "" ? [] : [[n, { ...emptyBody(), description }]];
    this.save(store.writes(this.tracker, bodies, [], true));
    this.render();
  }

  unreadableNotice(n: number, problem: string): void {
    this.setNotice(`KAN-${n}: this ticket's saved details could not be read; they are left untouched (${takeChars(problem, 200)}).`);
  }

  openBodyOf(n: number): Body | undefined {
    return this.openBody?.number === n ? this.openBody.body : undefined;
  }

  starting(n: number): boolean {
    for (const pending of this.pendingStarts.values()) if (pending === n) return true;
    return this.bodyLoads.some((load) => load.number === n && load.then.kind === "start");
  }

  /** The notice for a ticket whose assignee is no longer in a loaded agent list. The host would create a worktree and then fail to launch it, so such a Start is not sent. */
  unavailableAssignee(n: number): string | undefined {
    const assignee = this.tracker.entry(n)?.assignee;
    if (assignee === undefined || !this.agentsLoaded || this.agents.some((a) => a.id === assignee)) return undefined;
    return `${assignee} is no longer available — pick another agent.`;
  }

  /** The prompt needs the description, so a body that is not open is read first. */
  start(n: number): void {
    if (this.starting(n)) return;
    const unavailable = this.unavailableAssignee(n);
    if (unavailable) return this.setNotice(unavailable);
    if (this.unreadable.has(n)) return this.setNotice(`Could not start KAN-${n}: its saved details could not be read.`);
    const e = this.tracker.entry(n);
    if (!e || closed(e.status)) return;
    const body = this.openBodyOf(n);
    if (body) this.pendingStarts.set(sendStart(e, body.description), n);
    else this.bodyLoads.push({ id: storageGet(store.bodyKey(n)), number: n, then: { kind: "start" } });
    this.render();
  }

  /** Appends an agent's message to ticket `n`'s body: the open one, `loaded`, or one read first. */
  agentComment(n: number, text: string, loaded?: Body): void {
    if (!this.tracker.entry(n)) return;
    if (this.unreadable.has(n)) {
      return this.setNotice(`KAN-${n}: the agent's reply was not saved because the ticket's saved details could not be read.`);
    }
    const open = this.openBodyOf(n);
    if (open) {
      if (agentReply(open, text)) this.commit(false, true, []);
    } else if (loaded) {
      if (!agentReply(loaded, text)) return;
      this.save(store.writes(this.tracker, [[n, loaded]], [], false));
      // Reads sent before this write would miss the comment: read again.
      for (const load of this.bodyLoads) {
        if (load.number === n && load.then.kind !== "start") load.id = storageGet(store.bodyKey(n));
      }
    } else {
      this.bodyLoads.push({ id: storageGet(store.bodyKey(n)), number: n, then: { kind: "comment", text } });
    }
  }

  bodyLoaded(id: number, read: Read): void {
    const i = this.bodyLoads.findIndex((load) => load.id === id);
    if (i < 0) return;
    const [{ number: n, then }] = this.bodyLoads.splice(i, 1);
    // Nothing is written without the body, so a failed read loses nothing.
    if ("error" in read) return this.setNotice(`Could not read KAN-${n}: ${read.error.message}`);
    let body: Body;
    try {
      body = store.parseBody(read.value);
    } catch (error) {
      this.unreadable.add(n);
      if (then.kind === "open") return this.unreadableNotice(n, (error as Error).message);
      if (then.kind === "comment") return this.agentComment(n, then.text);
      return this.start(n);
    }
    switch (then.kind) {
      case "open":
        if (this.screen.kind === "ticket" && this.screen.number === n && !this.openBody) {
          this.openBody = { number: n, body };
          this.render();
        }
        return;
      case "comment":
        return this.agentComment(n, then.text, body);
      case "start": {
        const unavailable = this.unavailableAssignee(n);
        if (unavailable) return this.setNotice(unavailable);
        const e = this.tracker.entry(n);
        if (e && !closed(e.status)) {
          // The open body may hold a newer description than the one just read.
          this.pendingStarts.set(sendStart(e, (this.openBodyOf(n) ?? body).description), n);
        }
        return this.render();
      }
    }
  }

  startReplied(n: number, result: unknown, error?: RpcError): void {
    // A deleted or closed ticket is not resurrected; its agent keeps running.
    const e = this.tracker.entry(n);
    if (!e || closed(e.status)) return this.render();
    if (error) this.tracker.startFailed(n, error.message);
    else {
      const r = (result ?? {}) as { sessionId?: unknown; branch?: unknown };
      this.tracker.started(n, typeof r.sessionId === "string" ? r.sessionId : "", typeof r.branch === "string" ? r.branch : "");
    }
    this.commit(true, false, []);
  }

  fetched(n: number, result: unknown, error?: RpcError): void {
    if (error) return this.setNotice(`Could not read the agent's last message for KAN-${n}: ${error.message}`);
    const text = parseLastMessage(result);
    if (text !== undefined && text.trim() !== "") this.agentComment(n, text);
    else this.setNotice(`KAN-${n}: the agent finished without a message.`);
  }

  viewEvent(id: string, value = ""): void {
    if (!this.loaded) return;
    // `<prefix><n>`, and for fields `<prefix><n>-<form>`: the form generation ends a field id.
    const number = (prefix: string): number | undefined => (id.startsWith(prefix) ? digits(id.slice(prefix.length)) : undefined);
    const field = (prefix: string): number | undefined => {
      if (!id.startsWith(prefix)) return undefined;
      const rest = id.slice(prefix.length);
      const dash = rest.indexOf("-");
      return dash < 0 ? undefined : digits(rest.slice(0, dash));
    };
    let n: number | undefined;

    if (id === "back") {
      this.navigate(view.boardScreen());
    } else if (id === "show-cancelled") {
      if (this.screen.kind === "board") this.screen = { kind: "board", showCancelled: !this.screen.showCancelled };
      this.render();
    } else if (id.startsWith("new-title-")) {
      // Kept for Create; the field keeps showing what was typed.
      this.draft.title = takeChars(value.trim(), MAX_TITLE_CHARS);
    } else if (id.startsWith("new-description-")) {
      this.create(value);
    } else if (id.startsWith("new-priority-")) {
      if (isPriority(value)) {
        this.draft.priority = value;
        this.render();
      }
    } else if (id.startsWith("new-assignee-")) {
      this.draft.assignee = value === view.UNASSIGNED ? undefined : value;
      this.render();
    } else if ((n = number("ticket-")) !== undefined) {
      this.open(n);
    } else if ((n = number("status-")) !== undefined) {
      if (!isStatus(value)) return;
      this.tracker.setStatus(n, value);
      this.commit(true, false, []);
    } else if ((n = number("cancel-")) !== undefined) {
      this.tracker.setStatus(n, "cancelled");
      this.commit(true, false, []);
    } else if ((n = number("priority-")) !== undefined) {
      const e = this.tracker.entry(n);
      if (!isPriority(value) || !e) return;
      e.priority = value;
      this.commit(true, false, []);
    } else if ((n = number("assign-")) !== undefined) {
      const e = this.tracker.entry(n);
      if (!e) return;
      e.assignee = value === view.UNASSIGNED ? undefined : value;
      this.commit(true, false, []);
    } else if ((n = number("start-")) !== undefined) {
      this.start(n);
    } else if ((n = number("open-")) !== undefined) {
      const session = this.tracker.entry(n)?.session_id;
      if (session !== undefined) this.focusRequest = sessionFocus(session);
    } else if ((n = number("delete-")) !== undefined) {
      if (this.tracker.entry(n)) {
        this.tracker.delete(n);
        this.commit(true, false, [n]);
      }
    } else if ((n = field("description-")) !== undefined) {
      // Before the body arrives there is nothing to edit, and saving would overwrite it.
      const body = this.openBodyOf(n);
      if (!body) return;
      const trimmed = value.trim();
      const description = takeChars(trimmed, MAX_DESCRIPTION_CHARS);
      if (body.description !== description) {
        body.description = description;
        if (description.length < trimmed.length) this.note(DESCRIPTION_CUT);
        this.commit(false, true, []);
      }
    } else if ((n = field("comment-")) !== undefined) {
      const body = this.openBodyOf(n);
      if (!body || value.trim() === "") return;
      addComment(body, "you", value);
      this.commentForm++;
      this.commit(false, true, []);
    }
  }

  handle(event: Event): void {
    switch (event.type) {
      case "activate":
        // The legacy board is read every time: loading needs it whenever meta or index is absent.
        this.load = [storageGet(store.META), storageGet(store.INDEX), storageGet(store.LEGACY)];
        requestSnapshot();
        this.agentRequest = agentList();
        return;
      case "stored": {
        const read: Read = event.error ? { error: event.error } : { value: event.value };
        const i = this.loaded ? -1 : this.load.indexOf(event.id);
        if (i < 0) return this.bodyLoaded(event.id, read);
        this.loadReplies[i] = read;
        if (this.loadReplies.every((r) => r !== undefined)) this.finishLoad();
        return;
      }
      case "snapshot":
      case "workspaceChanged":
        return this.apply(event.snapshot);
      case "viewEvent":
        return this.viewEvent(event.id, event.value);
      case "taskFailed":
        if (this.tracker.taskFailed(event.sessionId, event.reason)) this.commit(true, false, []);
        return;
      case "reply":
        return this.reply(event.id, event.result, event.error);
    }
  }

  reply(id: number, result: unknown, error?: RpcError): void {
    const batch = this.saves.get(id);
    if (batch !== undefined) {
      this.saves.delete(id);
      if (error) {
        this.lastFailedBatch = batch;
        return this.setNotice(`${SAVE_FAILED}${error.message}`);
      }
      // A batch's own later writes never clear its failure; a newer batch that fully succeeded does.
      const batchDone = ![...this.saves.values()].includes(batch);
      const afterFailure = this.lastFailedBatch === undefined || batch > this.lastFailedBatch;
      if (batchDone && afterFailure && isSaveFailure(this.notice)) {
        this.notice = undefined;
        this.render();
      }
      return;
    }
    const start = this.pendingStarts.get(id);
    if (start !== undefined) {
      this.pendingStarts.delete(id);
      return this.startReplied(start, result, error);
    }
    const fetch = this.fetches.get(id);
    if (fetch !== undefined) {
      this.fetches.delete(id);
      this.drainFetches();
      return this.fetched(fetch, result, error);
    }
    if (id === this.focusRequest) {
      this.focusRequest = undefined;
      if (error) this.setNotice("That session is not open any more.");
      return;
    }
    if (id === this.agentRequest) {
      this.agentRequest = undefined;
      if (error) {
        this.agentsLoaded = false;
        return this.setNotice(`Could not list the agents: ${error.message}`);
      }
      // Duplicate menu item ids would stop the plugin.
      const seen = new Set<string>();
      this.agents = parseAgents(result).filter((a) => !seen.has(a.id) && seen.add(a.id));
      this.agentsLoaded = true;
      return this.render();
    }
    if (error) log("warn", `request failed: ${error.code} ${error.message}`);
  }
}

/** A ticket number in an id: ASCII digits only, so `ticket-1-title` is not ticket 1. */
function digits(s: string): number | undefined {
  return /^\d+$/.test(s) ? Number(s) : undefined;
}
