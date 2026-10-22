import type { Outcome, ProcessResult } from "@alas/plugin";
import { validRepo } from "./doctor.ts";

export interface Progress { done: number; running: number; total: number }
export interface Pipeline { id: number; status: string; sha: string; progress: Progress | null }

export interface MergeRequest {
  iid: number;
  title: string;
  url: string;
  draft: boolean;
  author: string;
  /** Only from the manifest's `network` hosts; others fall back to initials. */
  avatar?: string;
  branch: string;
  target: string;
  /** `diffHeadSha`. */
  sha: string;
  /** ISO 8601, so it sorts as text. */
  updatedAt: string;
  /** GitLab's `detailedMergeStatus`, such as `MERGEABLE`, `NOT_APPROVED` or `CI_STILL_RUNNING`. */
  status: string;
  conflicts: boolean;
  approvalsLeft: number;
  approvalsRequired: number;
  /** Reviewers whose review state is `REQUESTED_CHANGES`. */
  changesRequestedBy: string[];
  /** Resolvable threads not yet resolved. */
  unresolved: number;
  pipeline: Pipeline | null;
}

export interface Car { iid: number; status: string; pipeline: { status: string; progress: Progress | null } | null }
export interface Train { target: string; cars: Car[] }

export interface Merged { iid: number; title: string; url: string; author: string; avatar?: string; branch: string; mergedAt: string }

export interface Inbox {
  /** `group/sub/project`. */
  project: string;
  webUrl: string;
  /** From `webUrl`: every link must be on it. */
  host: string;
  /** The `glab` user. "Yours" means authored by them. */
  user: string;
  mrs: MergeRequest[];
  /** Non-empty trains, cars in merge order. */
  trains: Train[];
  /** The most recently merged first. */
  merged: Merged[];
}

export const MERGED_RECENT_MS = 24 * 3600_000;
export const MERGED_MIN = 5;

export function recentMerged(merged: Merged[], now: number): Merged[] {
  const older = merged.findIndex((m) => !(now - Date.parse(m.mergedAt) <= MERGED_RECENT_MS));
  return merged.slice(0, Math.max(MERGED_MIN, older === -1 ? merged.length : older));
}

export type Bucket = "ready" | "blocked" | "failing" | "drafts";
export const BUCKETS: Bucket[] = ["ready", "blocked", "failing", "drafts"];

export const SIGN_IN = "Sign in with `glab auth login --hostname <host>` in a terminal, then Refresh.";
export const NO_REMOTE = "This repository has no GitLab remote glab knows. For self-managed GitLab, run `glab auth login --hostname <host>` first.";
export const NO_GLAB = "glab is not installed on this host. Install it, sign in with `glab auth login`, then Refresh.";

const isObject = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const count = (v: any): number => (Number.isInteger(v?.count) && v.count > 0 ? v.count : 0);
const nat = (v: unknown): number => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : 0);
/** GraphQL iids are strings. */
const iidOf = (v: unknown): number | undefined => (typeof v === "string" && /^[1-9]\d{0,9}$/.test(v) ? Number(v) : undefined);

/** `gid://gitlab/Ci::Pipeline/235387` → 235387. */
export function pipelineId(gid: unknown): number | undefined {
  const m = typeof gid === "string" ? /^gid:\/\/gitlab\/Ci::Pipeline\/([1-9]\d{0,15})$/.exec(gid) : null;
  return m ? Number(m[1]) : undefined;
}

// No `URL` in the plugin runtime: strict patterns, so no userinfo, port or other host slips in.
const AVATAR = /^https:\/\/(?:secure\.gravatar\.com\/avatar\/|gitlab\.com\/uploads\/)[A-Za-z0-9/?=&%._-]*$/;
function avatar(author: any): { avatar?: string } {
  const url = str(author?.avatarUrl);
  return url !== null && url.length <= 512 && AVATAR.test(url) ? { avatar: url } : {};
}

function progress(p: any): Progress | null {
  const total = count(p?.jobs);
  if (total === 0) return null;
  const running = Math.min(total, count(p.running));
  return { done: Math.min(total - running, count(p.done)), running, total };
}

function mergeRequest(node: unknown, base: string): MergeRequest | undefined {
  if (!isObject(node)) return undefined;
  const iid = iidOf(node.iid);
  const { title, webUrl, draft, updatedAt, sourceBranch, targetBranch } = node;
  if (iid === undefined || typeof title !== "string" || typeof webUrl !== "string" || !webUrl.startsWith(base)) return undefined;
  if (typeof draft !== "boolean" || typeof updatedAt !== "string" || typeof sourceBranch !== "string" || typeof targetBranch !== "string") return undefined;
  const p = node.headPipeline;
  const id = pipelineId(p?.id);
  const reviewers = Array.isArray(node.reviewers?.nodes) ? node.reviewers.nodes : [];
  return {
    iid, title, url: webUrl, draft,
    author: str(node.author?.username) ?? "ghost", ...avatar(node.author),
    branch: sourceBranch, target: targetBranch, sha: str(node.diffHeadSha) ?? "", updatedAt,
    status: str(node.detailedMergeStatus) ?? "UNCHECKED",
    conflicts: node.conflicts === true,
    approvalsLeft: nat(node.approvalsLeft), approvalsRequired: nat(node.approvalsRequired),
    changesRequestedBy: reviewers.filter((r: any) => r?.mergeRequestInteraction?.reviewState === "REQUESTED_CHANGES" && typeof r.username === "string").map((r: any) => r.username),
    unresolved: Math.max(0, nat(node.resolvableDiscussionsCount) - nat(node.resolvedDiscussionsCount)),
    pipeline: id !== undefined && typeof p.status === "string" ? { id, status: p.status, sha: str(p.sha) ?? "", progress: progress(p) } : null,
  };
}

function trains(nodes: unknown): Train[] {
  if (!Array.isArray(nodes)) return [];
  return nodes.flatMap((t: any) => {
    if (typeof t?.targetBranch !== "string" || !Array.isArray(t.cars?.nodes)) return [];
    const cars: Car[] = t.cars.nodes.flatMap((c: any) => {
      const iid = iidOf(c?.mergeRequest?.iid);
      if (iid === undefined || typeof c.status !== "string") return [];
      return [{ iid, status: c.status, pipeline: typeof c.pipeline?.status === "string" ? { status: c.pipeline.status, progress: progress(c.pipeline) } : null }];
    });
    return cars.length ? [{ target: t.targetBranch, cars }] : [];
  });
}

function merged(nodes: unknown, base: string): Merged[] {
  if (!Array.isArray(nodes)) return [];
  const out = new Map<number, Merged>();
  for (const n of nodes) {
    const iid = iidOf(n?.iid);
    if (iid === undefined || out.has(iid) || typeof n.title !== "string" || typeof n.webUrl !== "string" || !n.webUrl.startsWith(base) || typeof n.sourceBranch !== "string" || typeof n.mergedAt !== "string") continue;
    out.set(iid, { iid, title: n.title, url: n.webUrl, author: str(n.author?.username) ?? "ghost", ...avatar(n.author), branch: n.sourceBranch, mergedAt: n.mergedAt });
  }
  return [...out.values()];
}

/** The list reply, or the message to show when it is not one. */
export function parseInbox(stdout: string): Inbox | string {
  let json: any;
  try { json = JSON.parse(stdout); } catch { return "glab returned an unexpected reply."; }
  const project = json?.data?.project;
  // Partial errors beside data (e.g. the EE-only mergeTrains field) are tolerated.
  const firstError = Array.isArray(json?.errors) ? str(json.errors[0]?.message) : null;
  if (firstError && !isObject(project)) return `GitLab: ${firstError.slice(0, 300)}`;
  if (!isObject(project)) return "GitLab returned no project. Check that glab can read it.";
  const host = /^https:\/\/([a-z0-9.-]+(?::\d{1,5})?)\/[^\s]+$/i.exec(str(project.webUrl) ?? "")?.[1]?.toLowerCase();
  if (!host || !validRepo(project.fullPath) || !Array.isArray(project.mergeRequests?.nodes)) return "glab returned an unexpected reply.";
  const base = `https://${host}/`;
  const mrs = new Map<number, MergeRequest>();
  for (const n of project.mergeRequests.nodes) {
    const mr = mergeRequest(n, base);
    if (mr && !mrs.has(mr.iid)) mrs.set(mr.iid, mr);
  }
  return {
    project: project.fullPath, webUrl: project.webUrl, host, user: str(json.data.currentUser?.username) ?? "",
    mrs: [...mrs.values()], trains: trains(project.mergeTrains?.nodes), merged: merged(project.merged?.nodes, base),
  };
}

/** `glab api projects/:id`'s `merge_trains_enabled`; `undefined` for an unreadable reply. */
export function parseTrainsEnabled(stdout: string): boolean | undefined {
  try {
    const json = JSON.parse(stdout);
    return isObject(json) ? json.merge_trains_enabled === true : undefined;
  } catch { return undefined; }
}

export function inTrain(inbox: Inbox, mr: MergeRequest): boolean {
  return inbox.trains.some((t) => t.target === mr.target && t.cars.some((c) => c.iid === mr.iid));
}

export const isFailing = (mr: MergeRequest) => mr.pipeline?.status === "FAILED" || mr.pipeline?.status === "CANCELED";

/** GitLab already decided: mergeable now, or mergeable once the running pipeline passes. */
export function addMode(mr: MergeRequest): "now" | "whenGreen" | undefined {
  if (mr.draft || isFailing(mr)) return undefined;
  if (mr.status === "MERGEABLE") return "now";
  if (mr.status === "CI_STILL_RUNNING") return "whenGreen";
  return undefined;
}

export function bucketOf(mr: MergeRequest): Bucket {
  if (mr.draft) return "drafts";
  if (isFailing(mr)) return "failing";
  if (mr.status === "MERGEABLE") return "ready";
  return "blocked";
}

/** MRs by bucket, newest-updated first, without the ones already in a train. */
export function classify(inbox: Inbox): Record<Bucket, MergeRequest[]> {
  const out: Record<Bucket, MergeRequest[]> = { ready: [], blocked: [], failing: [], drafts: [] };
  const sorted = inbox.mrs.filter((m) => !inTrain(inbox, m)).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  for (const m of sorted) out[bucketOf(m)].push(m);
  return out;
}

export function updatedLabel(fetchedAt: number | undefined, now: number): string | undefined {
  if (fetchedAt === undefined) return undefined;
  const seconds = (now - fetchedAt) / 1000;
  if (seconds < 60) return "Updated just now";
  if (seconds < 3600) return `Updated ${Math.floor(seconds / 60)}m ago`;
  return `Updated ${Math.floor(seconds / 3600)}h ago`;
}

export function agoLabel(iso: string, now: number): string | undefined {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return undefined;
  const seconds = Math.max(0, (now - at) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/** glab boxes errors in an `ERROR` banner: skip it and blank lines. */
function firstLine(text: string): string | undefined {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l !== "" && l !== "ERROR");
  return line === undefined ? undefined : line.slice(0, 300);
}

export function processError(outcome: Outcome<ProcessResult>): string | undefined {
  if (outcome.error) return /command not found|No such file/i.test(outcome.error.message) ? NO_GLAB : outcome.error.message;
  const { exit, stderr, stdout, timedOut } = outcome.result;
  if (timedOut) return "glab timed out.";
  if (exit === 0) return undefined;
  if (/glab: (?:command )?not found/.test(stderr)) return NO_GLAB;
  if (/none of the git remotes configured|not a git repository/.test(stderr)) return NO_REMOTE;
  if (/401 Unauthorized|glab auth login|no token found/i.test(stderr)) return SIGN_IN;
  return firstLine(stderr) ?? firstLine(stdout) ?? `glab exited with ${exit}.`;
}
