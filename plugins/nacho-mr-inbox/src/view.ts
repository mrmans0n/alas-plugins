import { BUCKETS, canMerge, classify, isReady, recentMerged, type Bucket, type Inbox, type Pull } from "./inbox.ts";

export interface ViewState {
  inbox?: Inbox;
  /** When `inbox` was fetched, in ms since the epoch. */
  fetchedAt?: number;
  refreshing: boolean;
  error?: string;
  /** The pull request being merged, if any. */
  merging?: number;
  /** The last merge failure per pull request number. */
  mergeErrors: Record<number, string>;
  /** A Merge all in progress: how many it started with and how many merged so far. */
  mergeAll?: { total: number; done: number };
}

export type Tone = "accent" | "success" | "warn" | "danger" | "dim";

export interface Chip { text: string; tone: Tone }

/** How a merge button looks: `go` once checks passed, `plain` while they run, `risk` when they failed. */
export interface MergeAction { look: "go" | "plain" | "risk"; label: string; short: string; disabled: boolean; busy: boolean }

export interface Row {
  number: number;
  title: string;
  url: string;
  branch: string;
  author: string;
  avatar?: string;
  /** ISO 8601; the page words it relative to its own clock. */
  updatedAt: string;
  chips: Chip[];
  /** Checks still to finish: how far along they are, `failed` once one failed. */
  checks?: { done: number; running: number; total: number; failed: boolean };
  merge?: MergeAction;
  error?: string;
}

export interface Section { key: Bucket; title: string; tone: Tone; rows: Row[] }

export interface MergedRow { number: number; title: string; url: string; branch: string; author: string; avatar?: string; mergedAt: string }

export interface InboxModel {
  repo?: string;
  fetchedAt?: number;
  refreshing: boolean;
  error?: string;
  /** Nothing to show yet: no list and no error. */
  loading: boolean;
  counts: Record<Bucket, number>;
  sections: Section[];
  merged: MergedRow[];
  /** Merges every ready pull request, one at a time; offered from two. */
  mergeAll?: { count: number; disabled: boolean; progress?: string };
}

export const TITLES: Record<Bucket, string> = { ready: "Ready to merge", failing: "Failing", waiting: "Waiting", drafts: "Drafts" };
export const TONES: Record<Bucket, Tone> = { ready: "success", failing: "danger", waiting: "warn", drafts: "dim" };

const failing = (p: Pull) => p.ci === "FAILURE" || p.ci === "ERROR";

export function chips(p: Pull): Chip[] {
  const out: Chip[] = [];
  const c = p.checks;
  if (p.ci === "SUCCESS") out.push({ text: c ? `✓ CI ${c.total}/${c.total}` : "✓ CI", tone: "success" });
  else if (failing(p)) out.push({ text: "✗ CI", tone: "danger" });
  else if (p.ci !== null && !(c && c.done < c.total)) out.push({ text: "CI …", tone: "dim" });
  if (p.reviewDecision === "APPROVED") out.push({ text: "✓ Approved", tone: "success" });
  else if (p.reviewDecision === "CHANGES_REQUESTED") out.push({ text: "Changes requested", tone: "warn" });
  else if (p.reviewDecision === "REVIEW_REQUIRED") out.push({ text: "Review needed", tone: "dim" });
  if (p.codexThumbsUp) out.push({ text: "Codex 👍", tone: "success" });
  else if (p.codexReviewing) out.push({ text: "Codex 👀", tone: "accent" });
  if (p.mergeable === "CONFLICTING") out.push({ text: "Conflicts", tone: "warn" });
  return out;
}

/** Green checks make merging the obvious action, running ones a neutral one, red ones a warning. */
function mergeAction(p: Pull, state: ViewState): MergeAction | undefined {
  if (!canMerge(p)) return undefined;
  const look = isReady(p) ? "go" : failing(p) ? "risk" : "plain";
  const label = look === "risk" ? "Merge anyway" : "Squash & merge";
  return { look, label, short: look === "risk" ? "Anyway" : "Merge", disabled: state.merging !== undefined, busy: state.merging === p.number };
}

function row(p: Pull, state: ViewState): Row {
  const c = p.checks;
  return {
    number: p.number, title: p.title, url: p.url, branch: p.branch, author: p.author, ...(p.avatar ? { avatar: p.avatar } : {}), updatedAt: p.updatedAt, chips: chips(p),
    ...(c && c.done < c.total ? { checks: { ...c, failed: failing(p) } } : {}),
    ...(canMerge(p) ? { merge: mergeAction(p, state) } : {}),
    ...(state.mergeErrors[p.number] === undefined ? {} : { error: state.mergeErrors[p.number] }),
  };
}

/** What the page draws: the buckets in order without empty ones, then the recently merged. */
export function inboxModel(state: ViewState, now: number): InboxModel {
  const buckets = classify(state.inbox?.pulls ?? []);
  const counts = Object.fromEntries(BUCKETS.map((b) => [b, buckets[b].length])) as Record<Bucket, number>;
  const ready = buckets.ready.length;
  const all = state.mergeAll;
  return {
    repo: state.inbox?.repo,
    fetchedAt: state.fetchedAt,
    refreshing: state.refreshing,
    error: state.error,
    loading: !state.inbox && state.error === undefined,
    counts,
    sections: BUCKETS.filter((b) => buckets[b].length > 0).map((b) => ({ key: b, title: TITLES[b], tone: TONES[b], rows: buckets[b].map((p) => row(p, state)) })),
    merged: state.inbox ? recentMerged(state.inbox.merged, now).map(({ number, title, url, branch, author, avatar, mergedAt }) => ({ number, title, url, branch, author, ...(avatar ? { avatar } : {}), mergedAt })) : [],
    ...(ready >= 2 || all ? { mergeAll: { count: ready, disabled: state.merging !== undefined, ...(all ? { progress: `Merging ${Math.min(all.done + 1, all.total)} of ${all.total}…` } : {}) } } : {}),
  };
}

/** The rail badge: the ready count, or none. */
export function readyCount(state: ViewState): number {
  return state.inbox ? classify(state.inbox.pulls).ready.length : 0;
}
