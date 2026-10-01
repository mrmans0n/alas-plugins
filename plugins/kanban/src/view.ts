// Renders the board and the ticket screen as view trees. Pure: no SDK calls besides the node types.
//
// Ids are built only from fixed words and ticket numbers, so they stay unique and under the
// host's 64 bytes. Board cards carry index data only; a ticket body is read on its screen.

import type { Agent, Node, MenuItem, TextStyle, Tone } from "@alas/plugin";
import { takeChars, utf8Length } from "./text.ts";
import {
  MAX_COMMENTS,
  MAX_COMMENT_CHARS,
  MAX_DESCRIPTION_CHARS,
  MAX_INDEX,
  MAX_LABELS,
  MAX_LABEL_CHARS,
  PRIORITIES,
  PRIORITY_TITLES,
  STATUSES,
  STATUS_TITLES,
  closed,
  type Body,
  type Entry,
  type Priority,
  type Status,
  type Tracker,
} from "./tickets.ts";

const MAX_TEXT = 500;
/** The host's cap on menu items. */
const MAX_MENU_ITEMS = 64;
/** The assignee menu item that clears the assignee. */
export const UNASSIGNED = "-";

export type Screen = { kind: "board"; showCancelled: boolean } | { kind: "ticket"; number: number };

export const boardScreen = (): Screen => ({ kind: "board", showCancelled: false });

/** The New ticket form's choices. The description is not kept: submitting it creates the ticket. */
export interface Draft {
  title: string;
  priority: Priority;
  assignee?: string;
}

export const emptyDraft = (): Draft => ({ title: "", priority: "none" });

export interface ViewState {
  tracker: Tracker;
  screen: Screen;
  /** The open ticket's body; `undefined` while it loads. */
  body?: Body;
  agents: Agent[];
  draft: Draft;
  form: number;
  /** The comment field's own generation, so posting a comment keeps unsaved description text. */
  commentForm: number;
  notice?: string;
  /** Tickets with a Start in flight. */
  starting: number[];
  /** The open ticket's stored body could not be decoded, so it is shown read-only. */
  bodyUnreadable: boolean;
}

function clip(s: string, max: number): string {
  const kept = takeChars(s, max);
  return kept.length < s.length ? kept + "…" : s;
}

function text(id: string, value: string, style?: TextStyle, tone?: Tone): Node {
  return { kind: "text", id, text: clip(value, MAX_TEXT), style, tone };
}

const hstack = (id: string, children: Node[]): Node => ({ kind: "hstack", id, children, spacing: 8 });
const vstack = (id: string, children: Node[]): Node => ({ kind: "vstack", id, children, spacing: 8 });

function button(id: string, label: string, icon: string | undefined, style: "normal" | "primary" | "plain", disabled = false): Node {
  return { kind: "button", id, label, icon, style, disabled: disabled || undefined };
}

export function render(s: ViewState): Node {
  const children: Node[] = s.notice === undefined ? [] : [text("notice", s.notice, undefined, "danger")];
  const entry = s.screen.kind === "ticket" ? s.tracker.entry(s.screen.number) : undefined;
  if (entry) children.push(ticket(s, entry));
  else board(s, s.screen.kind === "board" && s.screen.showCancelled, children);
  return { kind: "vstack", id: "root", spacing: 12, children };
}

function board(s: ViewState, showCancelled: boolean, out: Node[]): void {
  out.push(newTicket(s));
  out.push(button("show-cancelled", showCancelled ? "Hide cancelled" : "Show cancelled", undefined, "plain"));
  const columns = STATUSES.filter((status) => showCancelled || status !== "cancelled").map((status) => column(s.tracker, status));
  out.push({ kind: "scroll", id: "scroll", axis: "horizontal", child: { kind: "hstack", id: "columns", children: columns, spacing: 12 } });
}

function newTicket(s: ViewState): Node {
  const f = s.form;
  const row: Node[] = [
    { kind: "textField", id: `new-title-${f}`, value: s.draft.title, placeholder: "Title (Return keeps it)" },
    priorityMenu(`new-priority-${f}`, s.draft.priority),
    assigneeMenu(`new-assignee-${f}`, s.draft.assignee, s.agents),
  ];
  const children: Node[] = [
    text("new-heading", "New ticket", "title"),
    hstack("new-row", row),
    {
      kind: "textField",
      id: `new-description-${f}`,
      value: "",
      placeholder: "Description — ⌘Return to create; without a title, its first line is the title",
      multiline: true,
    },
  ];
  return { kind: "card", id: "new", children };
}

function priorityMenu(id: string, current: Priority): Node {
  const items = PRIORITIES.filter((p) => p !== current).map((p) => ({ id: p, label: PRIORITY_TITLES[p] }));
  return { kind: "menu", id, label: PRIORITY_TITLES[current], items };
}

/** With no agents there is nothing to pick, so a label says so instead of an empty menu. */
function assigneeMenu(id: string, current: string | undefined, agents: Agent[]): Node {
  const name = current === undefined ? undefined : (agents.find((a) => a.id === current)?.name ?? current);
  if (agents.length === 0) {
    const label = name === undefined ? "No agents available" : `Assignee: ${name} (no agents available)`;
    return text(id, label, "caption", "dim");
  }
  const items: MenuItem[] = [{ id: UNASSIGNED, label: "Unassigned" }];
  for (const a of agents) {
    if (items.length === MAX_MENU_ITEMS) break;
    // Item ids must be 1 to 64 bytes; an agent whose id is not cannot be offered.
    const bytes = utf8Length(a.id);
    if (bytes >= 1 && bytes <= 64 && a.id !== UNASSIGNED) items.push({ id: a.id, label: clip(a.name, 100) });
  }
  return { kind: "menu", id, label: clip(`Assignee: ${name ?? "none"}`, MAX_TEXT), items };
}

function stateBadge(id: string, state: string): Node {
  const tone: Tone | undefined = state === "awaiting_input" || state === "permission_request" ? "warn" : state === "running" ? "accent" : undefined;
  return { kind: "badge", id, text: clip(state, 40), tone };
}

function priorityBadge(id: string, priority: Priority): Node {
  const tone: Tone | undefined = priority === "urgent" ? "danger" : priority === "high" ? "warn" : undefined;
  return { kind: "badge", id, text: PRIORITY_TITLES[priority], tone };
}

function column(tracker: Tracker, status: Status): Node {
  // The index is not in number order: closed tickets sit at its end in closing order.
  // Loading caps the index; the slice keeps the tree within the host's node limit regardless.
  const entries = tracker
    .inStatus(status)
    .sort((a, b) => a.number - b.number)
    .slice(0, MAX_INDEX);
  const header = hstack(`col-${status}-header`, [
    text(`col-${status}-title`, STATUS_TITLES[status], "title"),
    { kind: "badge", id: `col-${status}-count`, text: String(entries.length) },
  ]);
  // Cards scroll on their own, under the header, so every card stays reachable.
  const cards: Node = { kind: "scroll", id: `col-${status}-scroll`, axis: "vertical", child: vstack(`col-${status}-cards`, entries.map(card)) };
  return { kind: "vstack", id: `col-${status}`, children: [header, cards], spacing: 8, width: 280 };
}

function card(e: Entry): Node {
  const n = e.number;
  const meta: Node[] = [text(`ticket-${n}-number`, `KAN-${n}`, "caption", "dim")];
  if (e.priority !== "none") meta.push(priorityBadge(`ticket-${n}-priority`, e.priority));
  if (e.assignee !== undefined) meta.push(text(`ticket-${n}-assignee`, e.assignee, "caption"));
  if (e.session_id !== undefined && e.agent_state !== undefined) meta.push(stateBadge(`ticket-${n}-state`, e.agent_state));
  const children = [hstack(`ticket-${n}-meta`, meta), text(`ticket-${n}-title`, e.title)];
  if (e.error !== undefined) children.push(text(`ticket-${n}-error`, `Start failed: ${e.error}`, undefined, "danger"));
  return { kind: "card", id: `ticket-${n}`, children, clickable: true };
}

function ticket(s: ViewState, e: Entry): Node {
  const n = e.number;
  const out: Node[] = [
    hstack("header", [
      button("back", "Back", "chevron.left", "plain"),
      text(`ticket-${n}-number`, `KAN-${n}`, "title", "dim"),
      text(`ticket-${n}-title`, e.title, "title"),
    ]),
  ];

  const statuses = STATUSES.filter((st) => st !== e.status).map((st) => ({ id: st, label: STATUS_TITLES[st] }));
  const controls: Node[] = [
    { kind: "menu", id: `status-${n}`, label: STATUS_TITLES[e.status], items: statuses },
    priorityMenu(`priority-${n}`, e.priority),
    assigneeMenu(`assign-${n}`, e.assignee, s.agents),
  ];
  // A session is running from the accepted start until it is seen idle (or gone).
  const running = e.session_id !== undefined && (!e.seen || (e.agent_state !== undefined && e.agent_state !== "idle"));
  if (!running && !closed(e.status)) {
    const starting = s.starting.includes(n);
    const label = starting ? "Starting…" : e.session_id !== undefined ? "Start again" : "Start";
    controls.push(button(`start-${n}`, label, "play.fill", "primary", starting));
  }
  out.push(hstack(`ticket-${n}-controls`, controls));

  if (e.branch !== undefined) {
    const row = [text(`ticket-${n}-branch`, e.branch, "monospaced")];
    if (e.agent_state !== undefined) row.push(stateBadge(`ticket-${n}-state`, e.agent_state));
    if (e.session_id !== undefined) row.push(button(`open-${n}`, "Open session", undefined, "normal"));
    out.push(hstack(`ticket-${n}-session`, row));
  }
  if (e.error !== undefined) out.push(text(`ticket-${n}-error`, `Start failed: ${e.error}`, undefined, "danger"));

  if (s.body) bodyNodes(n, s.form, s.commentForm, s.body, out);
  else if (s.bodyUnreadable) out.push(text("unreadable", "Details unavailable", undefined, "dim"));
  else out.push(text("loading", "Loading…", undefined, "dim"));

  const footer: Node[] = [];
  if (e.status !== "cancelled") footer.push(button(`cancel-${n}`, "Cancel ticket", undefined, "normal"));
  footer.push(button(`delete-${n}`, "Delete", "trash", "plain"));
  out.push(hstack("footer", footer));

  return { kind: "scroll", id: "ticket", axis: "vertical", child: vstack("ticket-content", out) };
}

function bodyNodes(n: number, form: number, commentForm: number, body: Body, out: Node[]): void {
  out.push(text("description-heading", "Description", "caption", "dim"));
  out.push({
    kind: "textField",
    id: `description-${n}-${form}`,
    // Edits are capped; the clip only guards against tampered storage over the host's limit.
    value: takeChars(body.description, MAX_DESCRIPTION_CHARS),
    placeholder: "Describe the ticket — ⌘Return saves",
    multiline: true,
  });
  if (body.labels.length > 0) {
    const badges = body.labels.slice(0, MAX_LABELS).map((l, i): Node => ({ kind: "badge", id: `label-${i}`, text: clip(l, MAX_LABEL_CHARS) }));
    out.push(hstack("labels", badges));
  }

  out.push(text("comments-heading", "Comments", "caption", "dim"));
  const hidden = Math.max(0, body.comments.length - MAX_COMMENTS);
  body.comments.forEach((c, i) => {
    if (i < hidden) return;
    out.push({
      kind: "card",
      id: `said-${i}`,
      children: [
        text(`said-${i}-author`, c.author === "you" ? "You" : "Agent", "caption", "dim"),
        { kind: "text", id: `said-${i}-text`, text: clip(c.text, MAX_COMMENT_CHARS) },
      ],
    });
  });
  out.push({ kind: "textField", id: `comment-${n}-${commentForm}`, value: "", placeholder: "Add a comment — ⌘Return posts it", multiline: true });
}
