// The Kanban board page: draws the state the plugin posts and sends back what the user did. It keeps
// only view state (selection, filters, unsaved text); every ticket change is made by the plugin, which
// answers with the whole state again.

import { connect, pageHost, type PageContext } from "@alas/plugin/page";
import type { OpenTicket, PageMessage, PluginMessage, TicketView } from "../src/protocol.ts";
import { PRIORITIES, PRIORITY_TITLES, STATUSES, STATUS_TITLES, type Priority, type Status } from "../src/tickets.ts";

const OPEN_STATUSES = STATUSES.filter((s) => s !== "cancelled");
const AGENT_STATES: Record<string, { label: string; tone: string }> = {
  starting: { label: "Starting", tone: "info" },
  running: { label: "Running", tone: "info" },
  awaiting_input: { label: "Needs input", tone: "warning" },
  permission_request: { label: "Needs permission", tone: "warning" },
  idle: { label: "Idle", tone: "success" },
};

let state: PluginMessage | undefined;
/** The ticket keyboard focus is on. */
let selected: number | undefined;
let showCancelled = false;
let creating = false;
let search = "";
let priorityFilter: Priority | "" = "";
let assigneeFilter = "";
/** Unsaved text by field id: survives every redraw until it is sent. */
const drafts = new Map<string, string>();
/** A Delete clicked once, waiting for the confirming click. */
let confirmDelete: number | undefined;
let dragging: number | undefined;
/** Shown when a post was refused (the page posted too much, too fast). */
let localNotice: string | undefined;
/** Set while redrawing: removing a focused field can fire its blur, which must not save. */
let rendering = false;

const app = document.createElement("main");

function post(message: PageMessage): void {
  try {
    pageHost().post(message);
    localNotice = undefined;
  } catch (error) {
    localNotice = `Not sent (${(error as Error).message}); try again.`;
    render();
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...children);
  return node;
}

function button(label: string, onClick: () => void, className = ""): HTMLButtonElement {
  const b = el("button", className, label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

function select<T extends string>(id: string, options: [T, string][], value: T, onChange: (v: T) => void): HTMLSelectElement {
  const s = el("select");
  s.id = id;
  for (const [v, label] of options) {
    const o = el("option", "", label);
    o.value = v;
    s.append(o);
  }
  s.value = value;
  s.addEventListener("change", () => onChange(s.value as T));
  return s;
}

/** A text field whose unsaved text lives in `drafts` under its id. */
function field(tag: "input" | "textarea", id: string, saved: string, placeholder: string): HTMLInputElement | HTMLTextAreaElement {
  const f = el(tag);
  f.id = id;
  f.placeholder = placeholder;
  f.value = drafts.get(id) ?? saved;
  f.addEventListener("input", () => drafts.set(id, f.value));
  return f;
}

const isCommandEnter = (e: KeyboardEvent): boolean => e.key === "Enter" && (e.metaKey || e.ctrlKey);

const agentName = (id?: string): string | undefined => (id === undefined ? undefined : (state?.agents.find((a) => a.id === id)?.name ?? id));

function priorityIcon(p: Priority): HTMLElement {
  const icon = el("span", `priority priority-${p}`);
  icon.title = PRIORITY_TITLES[p];
  if (p === "urgent") icon.textContent = "!";
  else if (p === "none") icon.textContent = "—";
  else for (let i = 1; i <= 3; i++) icon.append(el("i", i <= PRIORITIES.indexOf(p) ? "on" : ""));
  return icon;
}

function badge(t: TicketView): HTMLElement | undefined {
  if (t.starting) return el("span", "badge tone-info", "Starting");
  const known = t.agentState === undefined ? undefined : AGENT_STATES[t.agentState];
  if (t.hasSession && t.agentState !== undefined) return el("span", `badge tone-${known?.tone ?? "info"}`, known?.label ?? t.agentState);
  return undefined;
}

function visible(t: TicketView): boolean {
  if (priorityFilter !== "" && t.priority !== priorityFilter) return false;
  if (assigneeFilter !== "" && (t.assignee ?? "-") !== assigneeFilter) return false;
  const q = search.trim().toLowerCase();
  return q === "" || t.title.toLowerCase().includes(q) || `kan-${t.number}`.includes(q);
}

function columns(): Status[] {
  return showCancelled ? [...STATUSES] : OPEN_STATUSES;
}

/** Each column's visible tickets, in board order. */
function board(): Map<Status, TicketView[]> {
  const out = new Map<Status, TicketView[]>(columns().map((s) => [s, []]));
  for (const t of state?.tickets ?? []) if (visible(t)) out.get(t.status)?.push(t);
  return out;
}

function card(t: TicketView): HTMLElement {
  const c = el("article", "card");
  c.dataset.number = String(t.number);
  c.draggable = !(state?.readOnly ?? false);
  if (t.number === selected) c.classList.add("selected");
  if (t.number === state?.open?.number) c.classList.add("open");
  const meta = el("div", "card-meta", priorityIcon(t.priority), el("span", "key", `KAN-${t.number}`));
  const b = badge(t);
  if (b) meta.append(b);
  const name = agentName(t.assignee);
  if (name) meta.append(el("span", "assignee", name));
  c.append(meta, el("div", "card-title", t.title));
  if (t.error) c.append(el("div", "card-error", t.error));
  c.addEventListener("click", () => {
    selected = t.number;
    post({ type: "open", number: t.number });
  });
  c.addEventListener("dragstart", (e) => {
    dragging = t.number;
    e.dataTransfer?.setData("text/plain", `KAN-${t.number}`);
    c.classList.add("dragging");
  });
  c.addEventListener("dragend", () => {
    dragging = undefined;
    clearDropMarks();
  });
  return c;
}

function clearDropMarks(): void {
  for (const n of document.querySelectorAll(".drop-before, .drop-end")) n.classList.remove("drop-before", "drop-end");
}

/** The card the dragged ticket would go before, from the pointer's height; `undefined` for the column's end. */
function dropTarget(list: HTMLElement, y: number): HTMLElement | undefined {
  for (const c of list.querySelectorAll<HTMLElement>(".card")) {
    if (Number(c.dataset.number) === dragging) continue;
    const r = c.getBoundingClientRect();
    if (y < r.top + r.height / 2) return c;
  }
  return undefined;
}

function column(status: Status, tickets: TicketView[]): HTMLElement {
  const list = el("div", "cards");
  for (const t of tickets) list.append(card(t));
  const col = el("section", "column", el("header", "", el("h2", "", STATUS_TITLES[status]), el("span", "count", String(tickets.length))), list);
  col.addEventListener("dragover", (e) => {
    if (dragging === undefined) return;
    e.preventDefault();
    clearDropMarks();
    const target = dropTarget(list, e.clientY);
    (target ?? list).classList.add(target ? "drop-before" : "drop-end");
  });
  col.addEventListener("dragleave", (e) => {
    if (!col.contains(e.relatedTarget as Node)) clearDropMarks();
  });
  col.addEventListener("drop", (e) => {
    e.preventDefault();
    const number = dragging;
    const target = dropTarget(list, e.clientY);
    clearDropMarks();
    if (number === undefined) return;
    post({ type: "move", number, status, before: target ? Number(target.dataset.number) : undefined });
  });
  return col;
}

function toolbar(): HTMLElement {
  const find = el("input");
  find.id = "search";
  find.placeholder = "Search tickets  /";
  find.value = search;
  find.addEventListener("input", () => {
    search = find.value;
    render();
  });
  const agents: [string, string][] = [["", "Any assignee"], ["-", "Unassigned"], ...(state?.agents.map((a): [string, string] => [a.id, a.name]) ?? [])];
  const cancelled = button(showCancelled ? "Hide cancelled" : "Show cancelled", () => {
    showCancelled = !showCancelled;
    render();
  });
  const create = button("New ticket", () => openForm(), "primary");
  create.title = "C";
  return el(
    "header",
    "toolbar",
    el("h1", "", "Board"),
    find,
    select("filter-priority", [["", "Any priority"], ...PRIORITIES.map((p): [Priority, string] => [p, PRIORITY_TITLES[p]])], priorityFilter, (v) => {
      priorityFilter = v;
      render();
    }),
    select("filter-assignee", agents, assigneeFilter, (v) => {
      assigneeFilter = v;
      render();
    }),
    cancelled,
    create,
  );
}

function assigneeOptions(): [string, string][] {
  return [["-", "Unassigned"], ...(state?.agents.map((a): [string, string] => [a.id, a.name]) ?? [])];
}

function openForm(): void {
  creating = true;
  render();
  document.getElementById("new-title")?.focus();
}

function newForm(): HTMLElement {
  const title = field("input", "new-title", "", "Title") as HTMLInputElement;
  const description = field("textarea", "new-description", "", "Description (⌘↩ to create)") as HTMLTextAreaElement;
  const priority = select("new-priority", PRIORITIES.map((p): [Priority, string] => [p, PRIORITY_TITLES[p]]), (drafts.get("new-priority") as Priority) ?? "none", (v) => drafts.set("new-priority", v));
  const assignee = select("new-assignee", assigneeOptions(), drafts.get("new-assignee") ?? "-", (v) => drafts.set("new-assignee", v));
  const submit = (): void => {
    const t = drafts.get("new-title") ?? "";
    const d = drafts.get("new-description") ?? "";
    if (t.trim() === "" && d.trim() === "") return;
    const who = drafts.get("new-assignee");
    post({ type: "create", title: t, description: d, priority: (drafts.get("new-priority") as Priority) ?? "none", assignee: who && who !== "-" ? who : undefined });
    for (const key of ["new-title", "new-description", "new-priority", "new-assignee"]) drafts.delete(key);
    creating = false;
    render();
  };
  const keys = (e: KeyboardEvent): void => {
    if (isCommandEnter(e) || (e.key === "Enter" && e.target === title)) {
      e.preventDefault();
      if (e.target === title && !isCommandEnter(e)) description.focus();
      else submit();
    }
  };
  title.addEventListener("keydown", keys);
  description.addEventListener("keydown", keys);
  const form = el(
    "div",
    "new-ticket",
    title,
    description,
    el("div", "row", priority, assignee, el("span", "spacer"), button("Cancel", () => closeForm()), button("Create", submit, "primary")),
  );
  return form;
}

function closeForm(): void {
  creating = false;
  render();
}

function panel(open: OpenTicket): HTMLElement {
  const t = state?.tickets.find((x) => x.number === open.number);
  const p = el("aside", "panel");
  if (!t) return p;
  const n = t.number;
  const close = button("✕", () => post({ type: "close" }), "plain close");
  close.title = "Close (Esc)";
  p.append(el("header", "panel-head", el("span", "key", `KAN-${n}`), close), el("h2", "panel-title", t.title));

  const status = select(`status-${n}`, STATUSES.map((s): [Status, string] => [s, STATUS_TITLES[s]]), t.status, (v) => post({ type: "move", number: n, status: v }));
  const priority = select(`priority-${n}`, PRIORITIES.map((x): [Priority, string] => [x, PRIORITY_TITLES[x]]), t.priority, (v) => post({ type: "priority", number: n, priority: v }));
  const assignee = select(`assignee-${n}`, assigneeOptions(), t.assignee ?? "-", (v) => post({ type: "assign", number: n, assignee: v === "-" ? undefined : v }));
  p.append(el("div", "props", el("label", "", "Status", status), el("label", "", "Priority", priority), el("label", "", "Assignee", assignee)));

  const actions = el("div", "row");
  if (t.canStart) actions.append(button(t.hasSession ? "Start again" : "Start", () => post({ type: "start", number: n }), "primary"));
  else if (t.starting) actions.append(el("span", "dim", "Starting…"));
  if (t.hasSession) actions.append(button("Open session", () => post({ type: "focus", number: n })));
  const b = badge(t);
  if (b) actions.append(b);
  if (t.branch) actions.append(el("span", "dim mono", t.branch));
  p.append(actions);
  if (t.error) p.append(el("p", "card-error", t.error));

  if (open.unreadable) {
    p.append(el("p", "dim", "This ticket's saved details could not be read, so they are left untouched."));
  } else if (!open.body) {
    p.append(el("p", "dim", "Loading…"));
  } else {
    const body = open.body;
    const id = `description-${n}`;
    const description = field("textarea", id, body.description, "Add a description…") as HTMLTextAreaElement;
    description.classList.add("description");
    const save = (): void => {
      const text = drafts.get(id);
      drafts.delete(id);
      if (text !== undefined && text.trim() !== body.description) post({ type: "describe", number: n, text });
    };
    description.addEventListener("blur", () => {
      if (!rendering) save();
    });
    description.addEventListener("keydown", (e) => {
      if (isCommandEnter(e)) {
        e.preventDefault();
        description.blur();
      }
    });
    p.append(el("h3", "", "Description"), description);

    const comments = el("div", "comments");
    for (const c of body.comments) comments.append(el("div", `comment comment-${c.author}`, el("div", "author", c.author === "agent" ? "Agent" : "You"), el("div", "text", c.text)));
    if (body.comments.length === 0) comments.append(el("p", "dim", "No comments yet."));
    const commentId = `comment-${n}`;
    const reply = field("textarea", commentId, "", "Leave a comment (⌘↩)") as HTMLTextAreaElement;
    reply.addEventListener("keydown", (e) => {
      if (!isCommandEnter(e)) return;
      e.preventDefault();
      const text = drafts.get(commentId) ?? "";
      if (text.trim() === "") return;
      drafts.delete(commentId);
      post({ type: "comment", number: n, text });
    });
    p.append(el("h3", "", "Comments"), comments, reply);
  }

  const danger = el("div", "row danger-row");
  if (t.status !== "cancelled") danger.append(button("Cancel ticket", () => post({ type: "move", number: n, status: "cancelled" })));
  danger.append(
    button(confirmDelete === n ? "Delete? Click again" : "Delete", () => {
      if (confirmDelete !== n) {
        confirmDelete = n;
        return render();
      }
      confirmDelete = undefined;
      post({ type: "delete", number: n });
    }, "danger"),
  );
  p.append(danger);
  return p;
}

/** Redraws everything, keeping the focused field, its caret and scroll positions. */
function render(): void {
  const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  const focus = active?.id ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : undefined;
  const scrolls = [...document.querySelectorAll<HTMLElement>("[data-scroll]")].map((n) => [n.dataset.scroll!, n.scrollTop] as const);

  rendering = true;
  try {
    draw();
  } finally {
    rendering = false;
  }
  restore(focus, scrolls);
}

function draw(): void {
  app.replaceChildren();
  if (!state) {
    app.append(el("p", "dim center", "Loading tickets…"));
    return;
  }
  app.append(toolbar());
  const notice = localNotice ?? state.notice;
  if (notice) app.append(el("p", "notice", notice));
  if (creating) app.append(newForm());

  const cols = el("div", "board");
  for (const [status, tickets] of board()) {
    const col = column(status, tickets);
    col.querySelector(".cards")!.setAttribute("data-scroll", status);
    cols.append(col);
  }
  const layout = el("div", "layout", cols);
  if (state.open) {
    const side = panel(state.open);
    side.dataset.scroll = "panel";
    layout.append(side);
  }
  app.append(layout);
}

function restore(focus: { id: string; start: number | null; end: number | null } | undefined, scrolls: (readonly [string, number])[]): void {
  for (const [key, top] of scrolls) {
    const n = document.querySelector<HTMLElement>(`[data-scroll="${key}"]`);
    if (n) n.scrollTop = top;
  }
  if (focus) {
    const f = document.getElementById(focus.id) as HTMLInputElement | HTMLTextAreaElement | null;
    f?.focus();
    if (f && "setSelectionRange" in f && focus.start !== null && focus.end !== null) {
      try {
        f.setSelectionRange(focus.start, focus.end);
      } catch {
        // Selects and some inputs have no caret.
      }
    }
  }
}

/** j/k and the arrows move within a column, h/l across; the selection follows the visible board. */
function moveSelection(dx: number, dy: number): void {
  const cols = [...board().values()];
  let ci = cols.findIndex((ts) => ts.some((t) => t.number === selected));
  let ri = ci < 0 ? 0 : cols[ci].findIndex((t) => t.number === selected);
  if (ci < 0) {
    ci = cols.findIndex((ts) => ts.length > 0);
    if (ci < 0) return;
  } else if (dx !== 0) {
    let next = ci + dx;
    while (next >= 0 && next < cols.length && cols[next].length === 0) next += dx;
    if (next < 0 || next >= cols.length) return;
    ci = next;
    ri = Math.min(ri, cols[ci].length - 1);
  } else {
    ri = Math.max(0, Math.min(cols[ci].length - 1, ri + dy));
  }
  selected = cols[ci][ri]?.number;
  render();
  document.querySelector(".card.selected")?.scrollIntoView({ block: "nearest" });
}

/** S, P and A open the selected ticket and focus its status, priority or assignee menu. */
function focusProperty(prop: "status" | "priority" | "assignee"): void {
  if (selected === undefined) return;
  const n = selected;
  const focus = (): boolean => {
    const s = document.getElementById(`${prop}-${n}`);
    s?.focus();
    return s !== null;
  };
  if (state?.open?.number === n) return void focus();
  pendingFocus = { number: n, id: `${prop}-${n}` };
  post({ type: "open", number: n });
}

/** A menu to focus once its ticket's panel arrives. */
let pendingFocus: { number: number; id: string } | undefined;

document.addEventListener("keydown", (e) => {
  const target = e.target as HTMLElement;
  const typing = target.matches("input, textarea, select");
  if (e.key === "Escape") {
    if (typing) return void target.blur();
    if (creating) return closeForm();
    if (state?.open) return post({ type: "close" });
    if (search !== "") {
      search = "";
      return render();
    }
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  const keys: Record<string, () => void> = {
    c: () => openForm(),
    "/": () => document.getElementById("search")?.focus(),
    j: () => moveSelection(0, 1),
    ArrowDown: () => moveSelection(0, 1),
    k: () => moveSelection(0, -1),
    ArrowUp: () => moveSelection(0, -1),
    h: () => moveSelection(-1, 0),
    ArrowLeft: () => moveSelection(-1, 0),
    l: () => moveSelection(1, 0),
    ArrowRight: () => moveSelection(1, 0),
    Enter: () => selected !== undefined && post({ type: "open", number: selected }),
    s: () => focusProperty("status"),
    p: () => focusProperty("priority"),
    a: () => focusProperty("assignee"),
  };
  const action = keys[e.key];
  if (!action) return;
  e.preventDefault();
  action();
});

function applyTheme(context: PageContext): void {
  document.documentElement.dataset.theme = context.theme;
}

const style = document.createElement("style");
style.textContent = `
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; background: var(--alas-background); color: var(--alas-text); font-size: 13px; }
main { height: 100%; display: flex; flex-direction: column; gap: 10px; padding: 12px 16px; }
button, select, input, textarea { font: inherit; color: inherit; }
button { border: 1px solid var(--alas-line); background: transparent; border-radius: 6px; padding: 4px 10px; cursor: pointer; }
button:hover { background: color-mix(in srgb, var(--alas-line) 40%, transparent); }
button.primary { background: var(--alas-accent); border-color: var(--alas-accent); color: #fff; }
button.plain { border: 0; }
button.danger { color: var(--alas-tone-danger); }
select, input, textarea { background: transparent; border: 1px solid var(--alas-line); border-radius: 6px; padding: 4px 8px; }
textarea { resize: vertical; width: 100%; min-height: 80px; }
.toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.toolbar h1 { font-size: 16px; margin: 0 8px 0 0; }
#search { flex: 1; min-width: 160px; max-width: 320px; }
.notice { margin: 0; padding: 6px 10px; border-radius: 6px; color: var(--alas-tone-danger); border: 1px solid var(--alas-tone-danger); }
.new-ticket { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--alas-line); border-radius: 8px; }
.new-ticket input { font-size: 14px; }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.spacer { flex: 1; }
.layout { flex: 1; min-height: 0; display: flex; gap: 12px; }
.board { flex: 1; min-width: 0; display: flex; gap: 10px; overflow-x: auto; }
.column { flex: 1 0 200px; max-width: 320px; display: flex; flex-direction: column; min-height: 0; background: color-mix(in srgb, var(--alas-line) 18%, transparent); border-radius: 8px; }
.column header { display: flex; align-items: center; gap: 6px; padding: 8px 10px 4px; }
.column h2 { font-size: 12px; margin: 0; font-weight: 600; }
.count { color: var(--alas-dim); font-size: 11px; }
.cards { flex: 1; overflow-y: auto; padding: 4px 8px 12px; display: flex; flex-direction: column; gap: 6px; min-height: 40px; }
.cards.drop-end::after { content: ""; display: block; border-top: 2px solid var(--alas-accent); }
.card { background: var(--alas-background); border: 1px solid var(--alas-line); border-radius: 6px; padding: 8px; cursor: pointer; display: grid; gap: 4px; }
.card:hover { border-color: var(--alas-dim); }
.card.selected { outline: 2px solid var(--alas-accent); outline-offset: -1px; }
.card.open { border-color: var(--alas-accent); }
.card.dragging { opacity: 0.4; }
.card.drop-before { box-shadow: 0 -3px 0 var(--alas-accent); }
.card-meta { display: flex; align-items: center; gap: 6px; color: var(--alas-dim); font-size: 11px; flex-wrap: wrap; }
.card-title { overflow-wrap: anywhere; }
.card-error { color: var(--alas-tone-danger); font-size: 11px; margin: 0; }
.key { font-variant-numeric: tabular-nums; color: var(--alas-dim); }
.assignee { margin-left: auto; }
.priority { display: inline-flex; align-items: flex-end; gap: 1px; width: 14px; height: 12px; justify-content: center; font-size: 10px; font-weight: 700; }
.priority i { display: block; width: 3px; background: var(--alas-line); }
.priority i:nth-child(1) { height: 5px; } .priority i:nth-child(2) { height: 8px; } .priority i:nth-child(3) { height: 11px; }
.priority i.on { background: var(--alas-text); }
.priority-urgent { background: var(--alas-tone-danger); color: #fff; border-radius: 3px; align-items: center; }
.badge { border-radius: 4px; padding: 0 5px; font-size: 10px; border: 1px solid currentColor; }
.tone-info { color: var(--alas-tone-info); } .tone-warning { color: var(--alas-tone-warning); } .tone-success { color: var(--alas-tone-success); }
.panel { width: 380px; flex-shrink: 0; overflow-y: auto; border-left: 1px solid var(--alas-line); padding: 0 4px 16px 14px; display: flex; flex-direction: column; gap: 10px; }
.panel-head { display: flex; align-items: center; justify-content: space-between; }
.panel-title { font-size: 16px; margin: 0; overflow-wrap: anywhere; }
.panel h3 { font-size: 11px; color: var(--alas-dim); margin: 6px 0 0; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
.props { display: grid; grid-template-columns: auto 1fr; gap: 6px 10px; align-items: center; }
.props label { display: contents; color: var(--alas-dim); }
.description { min-height: 140px; }
.comments { display: grid; gap: 8px; }
.comment { border: 1px solid var(--alas-line); border-radius: 6px; padding: 6px 8px; }
.comment .author { font-size: 11px; color: var(--alas-dim); margin-bottom: 2px; }
.comment-agent { border-color: color-mix(in srgb, var(--alas-accent) 50%, var(--alas-line)); }
.comment .text { white-space: pre-wrap; overflow-wrap: anywhere; }
.danger-row { margin-top: 8px; padding-top: 10px; border-top: 1px solid var(--alas-line); }
.dim { color: var(--alas-dim); }
.mono { font-family: ui-monospace, monospace; font-size: 11px; }
.center { text-align: center; margin-top: 48px; }
`;
document.head.append(style);
document.body.append(app);

pageHost().onThemeChange(applyTheme);
applyTheme(pageHost().context);
render();
connect((message) => {
  const m = message as PluginMessage;
  if (m?.type !== "state") return;
  // A ticket that left the board can't stay selected or half-confirmed.
  if (selected !== undefined && !m.tickets.some((t) => t.number === selected)) selected = undefined;
  if (confirmDelete !== undefined && m.open?.number !== confirmDelete) confirmDelete = undefined;
  state = m;
  render();
  if (pendingFocus && m.open?.number === pendingFocus.number) {
    document.getElementById(pendingFocus.id)?.focus();
    pendingFocus = undefined;
  }
}, { type: "ready" } satisfies PageMessage);
