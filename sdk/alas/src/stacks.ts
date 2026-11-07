import { requestDecoded, type Outcome } from "./index.ts";

export interface ReviewIdentity { host: string; repo: string; number: number }
export type NativeStackAction = "open" | "sync" | "rebase" | "land" | "landThrough";
export interface NativeStackEntry { id: string; sha: string; position: number; number?: number; title: string; state?: string }
export interface NativeStack {
  id: string; name: string; base: string; host: string; repo: string; worktree?: string;
  fingerprint: string; complete: boolean; entries: NativeStackEntry[]; actions: NativeStackAction[];
  unavailableActions?: Partial<Record<NativeStackAction, string>>;
  /** Saved local or remote membership only; never proves order. For unmapped local entries,
   * omitted means unknown; [] confirms no saved published review mapping. */
  reviewNumbers?: number[];
}
export interface StackInventory { complete: boolean; busy: boolean; stacks: NativeStack[]; fetchedAt?: number; error?: string }
export interface StackOpenParams { stack: string; fingerprint: string; action: NativeStackAction; entry?: string }

const actions = ["open", "sync", "rebase", "land", "landThrough"];
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const string = (v: unknown, max = 1024): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
function validEntry(v: unknown): v is NativeStackEntry {
  return object(v) && string(v.id) && string(v.sha, 64) && /^[0-9a-f]{7,64}$/i.test(v.sha) && positive(v.position)
    && (v.number === undefined || positive(v.number)) && typeof v.title === "string" && v.title.length <= 4096
    && (v.state === undefined || string(v.state, 40));
}
function validStack(v: unknown): v is NativeStack {
  return object(v) && string(v.id) && string(v.name) && string(v.host, 256) && string(v.repo, 512)
    && typeof v.base === "string" && v.base.length <= 1024 && (v.base.length > 0 || v.complete === false)
    && (v.worktree === undefined || string(v.worktree)) && string(v.fingerprint, 256) && typeof v.complete === "boolean"
    && Array.isArray(v.entries) && v.entries.length <= 500 && v.entries.every(validEntry)
    && Array.isArray(v.actions) && v.actions.every(a => typeof a === "string" && actions.includes(a))
    && (v.reviewNumbers === undefined || Array.isArray(v.reviewNumbers) && v.reviewNumbers.length <= 500 && v.reviewNumbers.every(positive))
    && (v.unavailableActions === undefined || object(v.unavailableActions) && Object.entries(v.unavailableActions).every(([key, reason]) => actions.includes(key) && string(reason, 4000)));
}
export function parseStackInventory(value: unknown): StackInventory | undefined {
  if (!object(value) || typeof value.complete !== "boolean" || typeof value.busy !== "boolean"
    || !Array.isArray(value.stacks) || value.stacks.length > 500 || !value.stacks.every(validStack)
    || new Set(value.stacks.map(s => s.id)).size !== value.stacks.length
    || value.fetchedAt !== undefined && (typeof value.fetchedAt !== "number" || !Number.isFinite(value.fetchedAt) || value.fetchedAt < 0)
    || value.error !== undefined && !string(value.error, 8000)) return undefined;
  return value as unknown as StackInventory;
}

/** API 18, workspace.read: refresh returns native stack inventory, never permission to mutate. */
export function stackList(refresh: boolean, callback: (outcome: Outcome<StackInventory>) => void): number {
  return requestDecoded("stacks/list", { refresh }, r => parseStackInventory(r.inventory), callback);
}
/** API 18, workspace.read: presents native UI. The native user still confirms any mutation. */
export function stackOpen(params: StackOpenParams, callback: (outcome: Outcome<true>) => void): number {
  return requestDecoded("stacks/open", params, r => r.opened === true ? true : undefined, callback);
}
/** API 18, process.exec: reserve mutations in this plugin's project until settled and released. */
export function stackAcquire(callback: (outcome: Outcome<string>) => void): number {
  return requestDecoded("stacks/acquire", {}, r => string(r.token, 256) ? r.token : undefined, callback);
}
export function stackRelease(token: string, callback: (outcome: Outcome<true>) => void): number {
  return requestDecoded("stacks/release", { token }, r => r.released === true ? true : undefined, callback);
}
