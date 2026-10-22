// The messages between the plugin and its page. The page only draws and asks; every action is checked
// and run by the plugin, which answers with the whole state again.

import type { DoctorModel } from "./doctor-view.ts";
import type { InboxModel } from "./view.ts";

/** Plugin → page: the inbox, or CI Doctor while it shows a pull request. */
export type PluginMessage = { type: "state"; inbox: InboxModel; doctor?: DoctorModel };

/** Page → plugin. */
export type PageMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "merge"; number: number }
  | { type: "mergeAll" }
  | { type: "scope"; mine: boolean }
  | { type: "doctor"; number: number }
  | { type: "back" }
  | { type: "doctorRefresh" }
  | { type: "run"; run: number }
  | { type: "attempt"; run: number; attempt: number }
  | { type: "job"; job: number }
  | { type: "prepare"; job: number }
  | { type: "question"; token: number; text: string }
  | { type: "session"; token: number; session: string }
  | { type: "acknowledge" }
  | { type: "send" };

const id = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;

/** Checks what the page sent; anything malformed is `undefined` and ignored. */
export function parsePageMessage(message: unknown): PageMessage | undefined {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return undefined;
  const m = message as Record<string, unknown>;
  switch (m.type) {
    case "ready":
    case "refresh":
    case "mergeAll":
    case "back":
    case "doctorRefresh":
    case "acknowledge":
    case "send":
      return { type: m.type };
    case "merge":
    case "doctor":
      return id(m.number) ? { type: m.type, number: m.number } : undefined;
    case "scope":
      return typeof m.mine === "boolean" ? { type: "scope", mine: m.mine } : undefined;
    case "run":
      return id(m.run) ? { type: "run", run: m.run } : undefined;
    case "attempt":
      return id(m.run) && id(m.attempt) ? { type: "attempt", run: m.run, attempt: m.attempt } : undefined;
    case "job":
    case "prepare":
      return id(m.job) ? { type: m.type, job: m.job } : undefined;
    case "question":
      return id(m.token) && str(m.text, 8000) ? { type: "question", token: m.token, text: m.text } : undefined;
    case "session":
      return id(m.token) && str(m.session, 48) && /^[A-Za-z0-9_-]+$/.test(m.session) ? { type: "session", token: m.token, session: m.session } : undefined;
  }
  return undefined;
}
