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
  codexThumbsUp: boolean;
}

export interface Inbox {
  /** `owner/name`. */
  repo: string;
  pulls: Pull[];
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

function pull(node: unknown): Pull | undefined {
  if (!isObject(node)) return undefined;
  const { number, title, url, isDraft, headRefName, updatedAt } = node;
  if (!Number.isInteger(number) || number <= 0 || typeof title !== "string" || typeof url !== "string" || !url.startsWith("https://")) return undefined;
  if (typeof isDraft !== "boolean" || typeof headRefName !== "string" || typeof updatedAt !== "string") return undefined;
  const commit = node.commits?.nodes?.[0]?.commit;
  const reactions = Array.isArray(node.reactions?.nodes) ? node.reactions.nodes : [];
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
    codexThumbsUp: reactions.some((r: any) => CODEX.has(r?.user?.login)),
  };
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
  return { repo: repository.nameWithOwner, pulls: [...pulls.values()] };
}

export function isReady(p: Pull): boolean {
  // A null decision means the repository requires no review (a solo maintainer cannot approve their own PR),
  // so the Codex 👍 is the approval there.
  const reviewed = p.reviewDecision === "APPROVED" || p.reviewDecision === null;
  return !p.isDraft && p.ci === "SUCCESS" && reviewed && p.codexThumbsUp && p.mergeable !== "CONFLICTING";
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
