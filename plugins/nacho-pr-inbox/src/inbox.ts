import type { Outcome, ProcessResult } from "@alas/plugin";

export interface Pull {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  author: string;
  branch: string;
  /** ISO 8601, so it sorts as text. */
  updatedAt: string;
  /** `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`, or `null` when the repository requires no review. */
  reviewDecision: string | null;
  /** `MERGEABLE`, `CONFLICTING` or `UNKNOWN`. */
  mergeable: string;
  /** The head commit's check rollup: `SUCCESS`, `FAILURE`, `ERROR`, `PENDING`, `EXPECTED`, or `null` without checks. */
  ci: string | null;
  /** The head commit's checks by progress, or `null` without checks. */
  checks: Checks | null;
  codexThumbsUp: boolean;
  /** Codex left 👀 on the description: its review is in progress. */
  codexReviewing: boolean;
}

export interface Checks {
  done: number;
  running: number;
  total: number;
}

export interface Merged {
  number: number;
  title: string;
  url: string;
  author: string;
  branch: string;
  /** ISO 8601, so it sorts as text. */
  mergedAt: string;
}

export interface Inbox {
  /** `owner/name`. */
  repo: string;
  pulls: Pull[];
  /** The most recently merged first. */
  merged: Merged[];
}

/** The tab lists the pull requests merged this long ago at most… */
export const MERGED_RECENT_MS = 24 * 3600_000;
/** …or, when fewer, this many of the most recent. */
export const MERGED_MIN = 5;

/** The part of `merged`, the most recent first, the tab lists: those of the last day, or the last few when fewer. */
export function recentMerged(merged: Merged[], now: number): Merged[] {
  const older = merged.findIndex((m) => !(now - Date.parse(m.mergedAt) <= MERGED_RECENT_MS));
  return merged.slice(0, Math.max(MERGED_MIN, older === -1 ? merged.length : older));
}

export type Bucket = "ready" | "failing" | "waiting" | "drafts";
export const BUCKETS: Bucket[] = ["ready", "failing", "waiting", "drafts"];

export const SIGN_IN = "Sign in with `gh auth login` in a terminal, then Refresh.";
export const NO_REMOTE = "This repository has no GitHub remote.";

const CODEX = new Set(["chatgpt-codex-connector[bot]", "chatgpt-codex-connector"]);

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** The sum of the `{state, count}` entries whose state is in `states`. */
function countOf(entries: unknown, states: string[]): number {
  if (!Array.isArray(entries)) return 0;
  return entries.reduce((sum, e) => sum + (states.includes(e?.state) && Number.isInteger(e.count) && e.count > 0 ? e.count : 0), 0);
}

/** Check runs in progress and pending commit statuses run; queued and expected ones wait; the rest are done. */
function checks(contexts: any): Checks | null {
  const total = contexts?.totalCount;
  if (!Number.isInteger(total) || total <= 0) return null;
  const running = Math.min(total, countOf(contexts.checkRunCountsByState, ["IN_PROGRESS"]) + countOf(contexts.statusContextCountsByState, ["PENDING"]));
  const waiting = countOf(contexts.checkRunCountsByState, ["QUEUED", "PENDING", "WAITING", "REQUESTED"]) + countOf(contexts.statusContextCountsByState, ["EXPECTED"]);
  return { done: Math.max(0, total - running - waiting), running, total };
}

function pull(node: unknown): Pull | undefined {
  if (!isObject(node)) return undefined;
  const { number, title, url, isDraft, headRefName, updatedAt } = node;
  if (!Number.isInteger(number) || number <= 0 || typeof title !== "string" || typeof url !== "string" || !url.startsWith("https://")) return undefined;
  if (typeof isDraft !== "boolean" || typeof headRefName !== "string" || typeof updatedAt !== "string") return undefined;
  const commit = node.commits?.nodes?.[0]?.commit;
  const byCodex = (reactions: any) => Array.isArray(reactions?.nodes) && reactions.nodes.some((r: any) => CODEX.has(r?.user?.login));
  return {
    number,
    title,
    url,
    isDraft,
    author: str(node.author?.login) ?? "ghost",
    branch: headRefName,
    updatedAt,
    reviewDecision: str(node.reviewDecision),
    mergeable: str(node.mergeable) ?? "UNKNOWN",
    ci: isObject(commit) ? str(commit.statusCheckRollup?.state) : null,
    checks: isObject(commit) ? checks(commit.statusCheckRollup?.contexts) : null,
    codexThumbsUp: byCodex(node.reactions),
    codexReviewing: byCodex(node.eyes),
  };
}

function merged(node: unknown): Merged | undefined {
  if (!isObject(node)) return undefined;
  const { number, title, url, headRefName, mergedAt } = node;
  if (!Number.isInteger(number) || number <= 0 || typeof title !== "string" || typeof url !== "string" || !url.startsWith("https://")) return undefined;
  if (typeof headRefName !== "string" || typeof mergedAt !== "string") return undefined;
  return { number, title, url, author: str(node.author?.login) ?? "ghost", branch: headRefName, mergedAt };
}

/** The merged pull requests, the most recent first. GitHub cannot order by merge time, so the query fetches the recently updated ones and this sorts them. */
function recentlyMerged(nodes: unknown): Merged[] {
  if (!Array.isArray(nodes)) return [];
  const out = new Map<number, Merged>();
  for (const m of nodes.map(merged)) if (m && !out.has(m.number)) out.set(m.number, m);
  return [...out.values()].sort((a, b) => (a.mergedAt < b.mergedAt ? 1 : a.mergedAt > b.mergedAt ? -1 : 0));
}

/** The list process's stdout, or `undefined` when it is not the reply the query asks for. Malformed and repeated pull requests are skipped, as view ids must be unique. */
export function parseInbox(stdout: string): Inbox | undefined {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const repository = isObject(json) && isObject(json.data) ? json.data.repository : undefined;
  if (!isObject(repository) || typeof repository.nameWithOwner !== "string") return undefined;
  const nodes = repository.pullRequests?.nodes;
  if (!Array.isArray(nodes)) return undefined;
  const pulls = new Map<number, Pull>();
  for (const p of nodes.map(pull)) if (p && !pulls.has(p.number)) pulls.set(p.number, p);
  return { repo: repository.nameWithOwner, pulls: [...pulls.values()], merged: recentlyMerged(repository.merged?.nodes) };
}

/** Codex approved and nothing stops gh from merging; checks may still be running or red. */
export function canMerge(p: Pull): boolean {
  // Review state is shown, never required: the Codex 👍 is the approval that counts.
  return !p.isDraft && p.codexThumbsUp && p.mergeable !== "CONFLICTING";
}

export function isReady(p: Pull): boolean {
  return canMerge(p) && p.ci === "SUCCESS";
}

export function bucketOf(p: Pull): Bucket {
  if (p.isDraft) return "drafts";
  if (isReady(p)) return "ready";
  if (p.ci === "FAILURE" || p.ci === "ERROR") return "failing";
  return "waiting";
}

/** Pull requests by bucket, the most recently updated first. */
export function classify(pulls: Pull[]): Record<Bucket, Pull[]> {
  const out: Record<Bucket, Pull[]> = { ready: [], failing: [], waiting: [], drafts: [] };
  const sorted = pulls.slice().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  for (const p of sorted) out[bucketOf(p)].push(p);
  return out;
}

/** Mirrors Alas's gg inbox: "Updated just now", "Updated 5m ago", "Updated 2h ago". */
export function updatedLabel(fetchedAt: number | undefined, now: number): string | undefined {
  if (fetchedAt === undefined) return undefined;
  const seconds = (now - fetchedAt) / 1000;
  if (seconds < 60) return "Updated just now";
  if (seconds < 3600) return `Updated ${Math.floor(seconds / 60)}m ago`;
  return `Updated ${Math.floor(seconds / 3600)}h ago`;
}

/** How long ago `iso` was: "just now", "5m ago", "2h ago", "3d ago"; `undefined` for an unreadable time. */
export function agoLabel(iso: string, now: number): string | undefined {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return undefined;
  const seconds = Math.max(0, (now - at) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/** The first non-empty line of `text`, cut to 300 characters. */
function firstLine(text: string): string | undefined {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l !== "");
  return line === undefined ? undefined : line.slice(0, 300);
}

/** Why a gh run failed, for the user; `undefined` when it exited 0. */
export function processError(outcome: Outcome<ProcessResult>): string | undefined {
  if (outcome.error) return /command not found/.test(outcome.error.message) ? SIGN_IN : outcome.error.message;
  const { exit, stderr, stdout, timedOut } = outcome.result;
  if (timedOut) return "gh timed out.";
  if (exit === 0) return undefined;
  if (/gh auth login/.test(stderr)) return SIGN_IN;
  if (/known GitHub host|no git remotes/.test(stderr)) return NO_REMOTE;
  return firstLine(stderr) ?? firstLine(stdout) ?? `gh exited with ${exit}.`;
}
