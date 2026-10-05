// Kanban: a small ticket tracker whose tickets start agents in new worktrees and follow them. The board
// is a web page (page/main.ts) that draws the state this posts and sends back what the user did.

import {
  agentList,
  lastMessage,
  log,
  parseAgents,
  parseLastMessage,
  requestSnapshot,
  sessionFocus,
  storageGet,
  storageSet,
  taskStart,
  webPost,
  type Agent,
  type Event,
  type Plugin,
  type RpcError,
  type Snapshot,
} from "@alas/plugin";
import { parsePageMessage, type PageMessage, type PluginMessage, type TicketView } from "./protocol.ts";
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
  type Body,
  type Entry,
  type Priority,
  type SessionRef,
} from "./tickets.ts";

/** The board's web tab. */
const TAB = 0;

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
  /** The ticket open in the page's side panel. */
  openNumber?: number;
  /** The open ticket's body, once read. Its description and comments are editable only then, so a body is never saved before it is known. */
  openBody?: { number: number; body: Body };
  agents: Agent[] = [];
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

  /** Posts the whole state to the page; one that is not showing drops it and asks again when it loads. */
  render(): void {
    if (!this.loaded) return;
    const n = this.openNumber;
    const message: PluginMessage = {
      type: "state",
      tickets: this.tracker.index.map((e) => this.ticketView(e)),
      agents: this.agents.map((a) => ({ id: a.id, name: a.name })),
      open: n === undefined ? undefined : { number: n, body: this.openBodyOf(n), unreadable: this.unreadable.has(n) },
      notice: this.notice,
      readOnly: this.loadFailed,
    };
    webPost(TAB, message);
  }

  ticketView(e: Entry): TicketView {
    // A session is running from the accepted start until it is seen idle (or gone).
    const running = e.session_id !== undefined && (!e.seen || (e.agent_state !== undefined && e.agent_state !== "idle"));
    const starting = this.starting(e.number);
    return {
      number: e.number,
      title: e.title,
      status: e.status,
      priority: e.priority,
      assignee: e.assignee,
      branch: e.branch,
      agentState: e.session_id === undefined ? undefined : e.agent_state,
      error: e.error,
      hasSession: e.session_id !== undefined,
      canStart: !running && !starting && !closed(e.status),
      starting,
    };
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
    if (this.openNumber !== undefined && !this.tracker.entry(this.openNumber)) this.openNumber = this.openBody = undefined;
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

  /** Opens ticket `n` in the side panel, or closes the panel (`undefined`). */
  navigate(n: number | undefined): void {
    this.openNumber = n;
    this.openBody = undefined;
    // A failed load or save stays until it no longer holds; other notices go with the panel.
    if (!this.loadFailed && !isSaveFailure(this.notice)) this.notice = undefined;
    this.render();
  }

  open(n: number): void {
    if (!this.tracker.entry(n)) return;
    this.bodyLoads = this.bodyLoads.filter((load) => load.then.kind !== "open");
    // Agents may have been installed since the last ticket was opened.
    this.agentRequest = agentList();
    if (this.unreadable.has(n)) {
      this.openNumber = n;
      this.openBody = undefined;
      return this.unreadableNotice(n, "read earlier");
    }
    this.bodyLoads.push({ id: storageGet(store.bodyKey(n)), number: n, then: { kind: "open" } });
    this.navigate(n);
  }

  /** Without a title, the description's first line is the title. */
  create(rawTitle: string, text: string, priority: Priority, assignee?: string): void {
    const trimmed = text.trim();
    const description = takeChars(trimmed, MAX_DESCRIPTION_CHARS);
    const cut = description.length < trimmed.length;
    const given = takeChars(rawTitle.trim(), MAX_TITLE_CHARS);
    const title = given === "" ? firstLine(description) : given;
    if (title.trim() === "") return;
    const n = this.tracker.create(title, priority, assignee);
    if (n === undefined) {
      if (!this.loadFailed) this.setNotice(TRACKER_FULL);
      return;
    }
    if (this.notice === TRACKER_FULL) this.notice = undefined;
    if (cut) this.note(DESCRIPTION_CUT);
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
        if (this.openNumber === n && !this.openBody) {
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

  pageMessage(m: PageMessage): void {
    if (m.type === "ready") return this.render();
    if (!this.loaded) return;
    switch (m.type) {
      case "create":
        return this.create(m.title, m.description, m.priority, m.assignee);
      case "open":
        return this.open(m.number);
      case "close":
        return this.navigate(undefined);
      case "move":
        if (!this.tracker.entry(m.number)) return;
        this.tracker.move(m.number, m.status, m.before);
        return this.commit(true, false, []);
      case "priority": {
        const e = this.tracker.entry(m.number);
        if (!e || e.priority === m.priority) return;
        e.priority = m.priority;
        return this.commit(true, false, []);
      }
      case "assign": {
        const e = this.tracker.entry(m.number);
        if (!e || e.assignee === m.assignee) return;
        e.assignee = m.assignee;
        return this.commit(true, false, []);
      }
      case "start":
        return this.start(m.number);
      case "focus": {
        const session = this.tracker.entry(m.number)?.session_id;
        if (session !== undefined) this.focusRequest = sessionFocus(session);
        return;
      }
      case "delete":
        if (!this.tracker.entry(m.number)) return;
        this.tracker.delete(m.number);
        return this.commit(true, false, [m.number]);
      case "describe": {
        // Before the body arrives there is nothing to edit, and saving would overwrite it.
        const body = this.openBodyOf(m.number);
        if (!body) return;
        const trimmed = m.text.trim();
        const description = takeChars(trimmed, MAX_DESCRIPTION_CHARS);
        if (body.description === description) return;
        body.description = description;
        if (description.length < trimmed.length) this.note(DESCRIPTION_CUT);
        return this.commit(false, true, []);
      }
      case "comment": {
        const body = this.openBodyOf(m.number);
        if (!body || m.text.trim() === "") return;
        addComment(body, "you", m.text);
        return this.commit(false, true, []);
      }
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
      case "webMessage": {
        const message = parsePageMessage(event.message);
        if (message) this.pageMessage(message);
        return;
      }
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
