import { addMode, BUCKETS, classify, inTrain, isFailing, recentMerged, type Bucket, type Car, type Inbox, type MergeRequest, type Progress } from "./inbox.ts";

export interface ViewState {
  inbox?: Inbox;
  fetchedAt?: number;
  refreshing: boolean;
  error?: string;
  /** From the project reply; `undefined` until known, which counts as on. */
  trainsEnabled?: boolean;
  /** The MR being added or merged. */
  busy?: number;
  /** The pipeline being retried. */
  retrying?: number;
  /** The last write failure per MR iid. */
  errors: Record<number, string>;
  addAll?: { total: number; done: number };
}

export type Tone = "accent" | "success" | "warn" | "danger" | "dim";
export interface Chip { text: string; tone: Tone }
export interface AddAction { when: "now" | "whenGreen"; look: "go" | "plain"; label: string; short: string; disabled: boolean; busy: boolean }

export interface Row {
  iid: number; title: string; url: string; branch: string; author: string; avatar?: string; updatedAt: string;
  mine: boolean;
  chips: Chip[];
  /** Pipeline still running: how far along. */
  progress?: Progress & { failed: boolean };
  add?: AddAction;
  retry?: { pipeline: number; busy: boolean; disabled: boolean };
  /** There is a head pipeline to inspect. */
  doctor: boolean;
  error?: string;
}

export interface Section { key: Bucket; title: string; tone: Tone; rows: Row[] }
export interface CarView { iid: number; title: string; url?: string; mine: boolean; label: string; tone: Tone; progress?: Progress }
export interface TrainView { target: string; cars: CarView[] }
export interface MergedRow { iid: number; title: string; url: string; branch: string; author: string; avatar?: string; mergedAt: string }

export interface InboxModel {
  project?: string;
  fetchedAt?: number;
  refreshing: boolean;
  error?: string;
  loading: boolean;
  trainsEnabled: boolean;
  trains: TrainView[];
  counts: Record<Bucket, number>;
  sections: Section[];
  /** The user's MRs outside the train, newest first: the rail's list. */
  mine: Row[];
  merged: MergedRow[];
  addAll?: { count: number; label: string; disabled: boolean; progress?: string };
}

const TITLES: Record<Bucket, string> = { ready: "Ready", blocked: "Blocked", failing: "Failing", drafts: "Drafts" };
const TONES: Record<Bucket, Tone> = { ready: "success", blocked: "warn", failing: "danger", drafts: "dim" };

/** Statuses a dedicated chip already explains, or that need no chip. */
const EXPLAINED = new Set(["MERGEABLE", "CI_STILL_RUNNING", "CI_MUST_PASS", "NOT_APPROVED", "DISCUSSIONS_NOT_RESOLVED", "CONFLICT", "DRAFT_STATUS", "REQUESTED_CHANGES", "NOT_OPEN"]);
const TRANSIENT = new Set(["CHECKING", "UNCHECKED", "PREPARING", "APPROVALS_SYNCING"]);
const NAMED: Record<string, string> = { NEED_REBASE: "needs rebase", BLOCKED_STATUS: "blocked by dependency", MERGE_REQUEST_BLOCKED: "blocked by dependency" };

export function chips(mr: MergeRequest): Chip[] {
  const out: Chip[] = [];
  const p = mr.pipeline;
  if (p?.status === "SUCCESS") out.push({ text: "✓ pipeline", tone: "success" });
  else if (p?.status === "FAILED") out.push({ text: "✗ pipeline", tone: "danger" });
  else if (p?.status === "CANCELED") out.push({ text: "pipeline canceled", tone: "danger" });
  else if (p?.status === "MANUAL") out.push({ text: "pipeline manual", tone: "dim" });
  else if (!p && mr.status === "CI_MUST_PASS") out.push({ text: "no pipeline", tone: "warn" });
  if (mr.changesRequestedBy.length) out.push({ text: `changes requested · ${mr.changesRequestedBy.map((u) => `@${u}`).join(", ")}`, tone: "danger" });
  else if (mr.status === "REQUESTED_CHANGES") out.push({ text: "changes requested", tone: "danger" });
  if (mr.unresolved > 0) out.push({ text: `💬 ${mr.unresolved} unresolved`, tone: "warn" });
  if (mr.approvalsLeft > 0) out.push({ text: `needs ${mr.approvalsLeft} approval${mr.approvalsLeft === 1 ? "" : "s"}`, tone: "warn" });
  else if (mr.approvalsRequired > 0) out.push({ text: "✓ approved", tone: "success" });
  if (mr.conflicts) out.push({ text: "conflicts", tone: "warn" });
  if (TRANSIENT.has(mr.status)) out.push({ text: "checking…", tone: "dim" });
  else if (NAMED[mr.status]) out.push({ text: NAMED[mr.status], tone: "warn" });
  else if (!EXPLAINED.has(mr.status)) out.push({ text: mr.status.toLowerCase().replace(/_/g, " "), tone: "warn" });
  return out;
}

function addAction(mr: MergeRequest, state: ViewState): AddAction | undefined {
  const when = addMode(mr);
  if (!when) return undefined;
  const trains = state.trainsEnabled !== false;
  const label = !trains ? "Merge when green" : when === "now" ? "🚂 Add to train" : "🚂 Add when green";
  const short = !trains ? "Merge" : when === "now" ? "Add" : "When green";
  return { when, look: when === "now" ? "go" : "plain", label, short, disabled: state.busy !== undefined, busy: state.busy === mr.iid };
}

function row(mr: MergeRequest, state: ViewState): Row {
  const p = mr.pipeline;
  const add = addAction(mr, state);
  const running = p?.progress && p.progress.done < p.progress.total && !isFailing(mr);
  return {
    iid: mr.iid, title: mr.title, url: mr.url, branch: mr.branch, author: mr.author, ...(mr.avatar ? { avatar: mr.avatar } : {}), updatedAt: mr.updatedAt,
    mine: mr.author === state.inbox?.user,
    chips: chips(mr),
    ...(running ? { progress: { ...p!.progress!, failed: false } } : {}),
    ...(add ? { add } : {}),
    ...(p && isFailing(mr) ? { retry: { pipeline: p.id, busy: state.retrying === p.id, disabled: state.retrying !== undefined } } : {}),
    doctor: p !== null,
    ...(state.errors[mr.iid] === undefined ? {} : { error: state.errors[mr.iid] }),
  };
}

function car(c: Car, inbox: Inbox): CarView {
  const mr = inbox.mrs.find((m) => m.iid === c.iid);
  const status = c.pipeline?.status;
  const [label, tone]: [string, Tone] =
    status === "FAILED" || status === "CANCELED" ? ["failed", "danger"]
    : c.status === "MERGING" || c.status === "MERGED" ? ["merging ✓", "success"]
    : c.status === "STALE" ? ["restarting", "dim"]
    : (status === "RUNNING" || status === "PENDING") && c.pipeline?.progress ? [`⏳ ${c.pipeline.progress.done}/${c.pipeline.progress.total}`, "warn"]
    : status === "RUNNING" || status === "PENDING" ? ["⏳ running", "warn"]
    : ["queued", "dim"];
  return { iid: c.iid, title: mr?.title ?? `!${c.iid}`, ...(mr ? { url: mr.url } : {}), mine: mr?.author === inbox.user, label, tone, ...(c.pipeline?.progress ? { progress: c.pipeline.progress } : {}) };
}

export function inboxModel(state: ViewState, now: number): InboxModel {
  const inbox = state.inbox;
  const groups = inbox ? classify(inbox) : { ready: [], blocked: [], failing: [], drafts: [] };
  const counts = Object.fromEntries(BUCKETS.map((b) => [b, groups[b].length])) as Record<Bucket, number>;
  const trains = state.trainsEnabled !== false;
  const all = state.addAll;
  const ready = groups.ready.length;
  const mine = inbox ? inbox.mrs.filter((m) => m.author === inbox.user && !inTrain(inbox, m)).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).map((m) => row(m, state)) : [];
  return {
    project: inbox?.project, fetchedAt: state.fetchedAt, refreshing: state.refreshing, error: state.error,
    loading: !inbox && state.error === undefined,
    trainsEnabled: trains,
    trains: inbox ? inbox.trains.map((t) => ({ target: t.target, cars: t.cars.map((c) => car(c, inbox)) })) : [],
    counts,
    sections: BUCKETS.filter((b) => groups[b].length > 0).map((b) => ({ key: b, title: TITLES[b], tone: TONES[b], rows: groups[b].map((m) => row(m, state)) })),
    mine,
    merged: inbox ? recentMerged(inbox.merged, now).map(({ iid, title, url, branch, author, avatar, mergedAt }) => ({ iid, title, url, branch, author, ...(avatar ? { avatar } : {}), mergedAt })) : [],
    ...(ready >= 2 || all ? { addAll: {
      count: ready, label: trains ? `🚂 Add all ${ready} to train` : `Merge all ${ready} when green`, disabled: state.busy !== undefined,
      ...(all ? { progress: `Adding ${Math.min(all.done + 1, all.total)} of ${all.total}…` } : {}),
    } } : {}),
  };
}

/** The rail badge: your MRs ready to add. */
export function readyMine(state: ViewState): number {
  const inbox = state.inbox;
  return inbox ? classify(inbox).ready.filter((m) => m.author === inbox.user).length : 0;
}
