// Agent Usage: pages through the usage history for the window and scope the page asks for, folds it
// into aggregates (src/usage.ts) and posts those to the web tab. `turnFinished` keeps them current.
// The page (page/main.ts) only draws: it has no network and never sees a raw turn.

import { definePlugin, requestSnapshot, setPanelBadge, usageLimits, usageTurns, webPost, type Snapshot, type UsageCursor, type UsageTurn } from "@alas/plugin";
import { addLimit, addTurn, limitsToday, newAggregate, RANGES, summarize, windowStart, type Aggregate, type PageMessage, type PluginMessage, type Range, type Scope } from "./usage.ts";

const TAB = 0;
const PANEL = "rail";
const PAGE = 1000;

let projectId = "";
let branches = new Map<string, string>();
let range: Range = 30;
let scope: Scope = "project";
let agg: Aggregate | undefined;
/** Bumped by each load, so the pages of a superseded one are dropped. */
let generation = 0;
let loading = false;
/** Turns finished while loading: folded in after, unless the pages had them. */
let pending: UsageTurn[] = [];
let visible = false;

function post(message: PluginMessage): void {
  // A surface with no live page drops it.
  webPost(TAB, message);
  webPost(PANEL, message);
}

function where(project?: string, worktree?: string): string {
  if (project === undefined) return "Multi-project workspace";
  if (project !== projectId) return "Other projects";
  return (worktree && branches.get(worktree)) ?? "Removed worktree";
}

function badge(): void {
  const hits = agg ? limitsToday(agg, Date.now()) : 0;
  setPanelBadge(PANEL, hits ? { count: hits, tone: "danger" } : null);
}

function postSummary(): void {
  badge();
  if (agg) post({ type: "usage", ...summarize(agg, Date.now(), where) });
}

function fail(message: string): void {
  loading = false;
  agg = undefined;
  post({ type: "error", range, scope, message });
}

function load(): void {
  const gen = ++generation;
  agg = newAggregate(range, scope, Date.now());
  loading = true;
  pending = [];
  post({ type: "loading", range, scope });
  const current = agg;
  const turns = (cursor?: UsageCursor): void => {
    usageTurns({ since: current.since, limit: PAGE, scope, cursor }, ({ result, error }) => {
      if (gen !== generation) return;
      if (error) return fail(error.message);
      for (const turn of result.items) addTurn(current, turn);
      result.next ? turns(result.next) : limits();
    });
  };
  const limits = (cursor?: UsageCursor): void => {
    usageLimits({ since: current.since, limit: PAGE, scope, cursor }, ({ result, error }) => {
      if (gen !== generation) return;
      if (error) return fail(error.message);
      for (const limit of result.items) addLimit(current, limit);
      if (result.next) return limits(result.next);
      loading = false;
      const loadedMax = current.maxId;
      for (const turn of pending) if (turn.id > loadedMax) addTurn(current, turn);
      pending = [];
      postSummary();
    });
  };
  turns();
}

/**
 * Shows the last query again when it can: this project's numbers stay current through `turnFinished`, but
 * other projects' turns don't arrive, and a new day moves the window.
 */
function show(): void {
  if (agg && !loading && scope === "project" && agg.since === windowStart(Date.now(), range)) return postSummary();
  if (!loading) load();
  else post({ type: "loading", range, scope });
}

function parse(message: unknown): PageMessage | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const m = message as Record<string, unknown>;
  if (m.type === "ready") return { type: "ready" };
  if (m.type === "load" && RANGES.includes(m.range as Range) && (m.scope === "project" || m.scope === "all")) {
    return { type: "load", range: m.range as Range, scope: m.scope };
  }
  return undefined;
}

function learn(snapshot: Snapshot): void {
  for (const w of snapshot.worktrees) branches.set(w.id, w.branch);
}

definePlugin({
  handle(event) {
    switch (event.type) {
      case "activate":
        projectId = event.projectId;
        requestSnapshot();
        load();
        break;
      case "snapshot":
      case "workspaceChanged":
        // Kept after a worktree is removed, so its turns stay named.
        learn(event.snapshot);
        break;
      case "webMessage": {
        const message = parse(event.message);
        if (message?.type === "ready") show();
        if (message?.type === "load") {
          range = message.range;
          scope = message.scope;
          load();
        }
        break;
      }
      case "tabVisible":
        visible = event.visible;
        break;
      case "turnFinished":
        // Limit hits arrive only through `usageLimits`.
        if (event.turn.result === "limited" && !loading) load();
        if (!agg) break;
        if (loading) pending.push(event.turn);
        else if (event.turn.id > agg.maxId) {
          addTurn(agg, event.turn);
          if (visible) postSummary();
        }
        break;
    }
  },
});
