// The messages between the plugin and its board page. The page only draws and asks; every change is
// made, checked and saved by the plugin, which answers each one with the whole state.

import { isPriority, isStatus, type Body, type Priority, type Status } from "./tickets.ts";

/** A ticket as the board shows it: index fields only, a body is sent just for the open ticket. */
export interface TicketView {
  number: number;
  title: string;
  status: Status;
  priority: Priority;
  assignee?: string;
  branch?: string;
  /** The followed session's state, while the ticket has one. */
  agentState?: string;
  /** Why the last Start failed. */
  error?: string;
  hasSession: boolean;
  /** A Start would be offered: open, and no session running or starting. */
  canStart: boolean;
  starting: boolean;
}

export interface OpenTicket {
  number: number;
  /** Absent while it loads. */
  body?: Body;
  /** The stored body could not be decoded: shown read-only, never written. */
  unreadable: boolean;
}

/** Plugin → page. */
export type PluginMessage = {
  type: "state";
  /** Board order: each status's tickets in this order. */
  tickets: TicketView[];
  agents: { id: string; name: string }[];
  open?: OpenTicket;
  notice?: string;
  /** Nothing will be saved: the store could not be read. */
  readOnly: boolean;
};

/** Page → plugin. */
export type PageMessage =
  | { type: "ready" }
  | { type: "create"; title: string; description: string; priority: Priority; assignee?: string }
  | { type: "open"; number: number }
  | { type: "close" }
  | { type: "move"; number: number; status: Status; before?: number }
  | { type: "priority"; number: number; priority: Priority }
  | { type: "assign"; number: number; assignee?: string }
  | { type: "describe"; number: number; text: string }
  | { type: "comment"; number: number; text: string }
  | { type: "start"; number: number }
  | { type: "focus"; number: number }
  | { type: "delete"; number: number };

const num = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const str = (v: unknown): v is string => typeof v === "string";
/** An absent assignee clears it; a present one must be a string. */
const assignee = (v: unknown): v is string | undefined => v === undefined || v === null || str(v);

/** Checks what the page sent; anything malformed is `undefined` and ignored. */
export function parsePageMessage(message: unknown): PageMessage | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const m = message as Record<string, unknown>;
  const n = m.number;
  switch (m.type) {
    case "ready":
    case "close":
      return { type: m.type };
    case "create":
      if (!str(m.title) || !str(m.description) || !isPriority(m.priority) || !assignee(m.assignee)) return undefined;
      return { type: "create", title: m.title, description: m.description, priority: m.priority, assignee: m.assignee ?? undefined };
    case "open":
    case "start":
    case "focus":
    case "delete":
      return num(n) ? { type: m.type, number: n } : undefined;
    case "move":
      if (!num(n) || !isStatus(m.status) || !(m.before === undefined || m.before === null || num(m.before))) return undefined;
      return { type: "move", number: n, status: m.status, before: m.before ?? undefined };
    case "priority":
      return num(n) && isPriority(m.priority) ? { type: "priority", number: n, priority: m.priority } : undefined;
    case "assign":
      return num(n) && assignee(m.assignee) ? { type: "assign", number: n, assignee: m.assignee ?? undefined } : undefined;
    case "describe":
    case "comment":
      return num(n) && str(m.text) ? { type: m.type, number: n, text: m.text } : undefined;
  }
  return undefined;
}
