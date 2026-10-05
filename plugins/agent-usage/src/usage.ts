// Turns and usage-limit episodes folded into the aggregates the page draws. Pure: the plugin feeds
// it pages of `usage/turns` and `usage/limits` and posts `summarize`'s result, never raw turns.

import type { UsageLimit, UsageTurn } from "@alas/plugin";

export type Range = 7 | 30 | 90;
export type Scope = "project" | "all";
export const RANGES: Range[] = [7, 30, 90];

/** Page → plugin. `ready` when the page starts (show the last query), `load` when a toggle changes. */
export type PageMessage = { type: "ready" } | { type: "load"; range: Range; scope: Scope };

/** Plugin → page. */
export type PluginMessage =
  | { type: "loading"; range: Range; scope: Scope }
  | { type: "error"; range: Range; scope: Scope; message: string }
  | ({ type: "usage" } & Summary);

export interface Tokens {
  input: number;
  /** Cached input, read and written. */
  cached: number;
  /** Output, reasoning included. */
  output: number;
  total: number;
}

export interface Tally {
  turns: number;
  tokens: Tokens;
  /** By currency, over the turns that reported a cost. */
  costs: Record<string, number>;
  /** Turns without a cost, left out of `costs`. */
  costMissing: number;
  durationMs: number;
  completed: number;
}

export interface Day {
  /** Local `YYYY-MM-DD`. */
  day: string;
  byAgent: Record<string, Tokens>;
  costs: Record<string, number>;
}

export interface Row extends Tally {
  label: string;
  /** `agent` rows only. */
  model?: string;
}

export interface LimitRow {
  agent: string;
  where: string;
  detectedAt: number;
  resetsAt?: number;
}

export interface Summary {
  range: Range;
  scope: Scope;
  since: number;
  totals: Tally;
  limitHits: number;
  /** Every local day of the window, oldest first. */
  days: Day[];
  /** Agents with tokens in `days`, most tokens first. */
  agents: string[];
  /** By agent and model, then by worktree: most tokens first, at most `MAX_ROWS`. */
  models: Row[];
  worktrees: Row[];
  /** Newest first, at most `MAX_LIMITS`. */
  limits: LimitRow[];
  /** Rows left out of `models`, `worktrees` or `limits`. */
  omitted: number;
}

export const MAX_ROWS = 50;
export const MAX_LIMITS = 20;

export interface Aggregate {
  range: Range;
  scope: Scope;
  since: number;
  totals: Tally;
  days: Map<string, { byAgent: Map<string, Tokens>; costs: Record<string, number> }>;
  models: Map<string, Tally & { agent: string; model?: string }>;
  /** By `project\0worktree`; labelled when summarized, so names learned later still apply. */
  worktrees: Map<string, Tally & { project?: string; worktree?: string }>;
  limits: UsageLimit[];
  /** The highest turn id folded in, to skip a `turnFinished` the pages already had. */
  maxId: number;
}

function tokens(): Tokens {
  return { input: 0, cached: 0, output: 0, total: 0 };
}

function tally(): Tally {
  return { turns: 0, tokens: tokens(), costs: {}, costMissing: 0, durationMs: 0, completed: 0 };
}

/** Local `YYYY-MM-DD` of epoch ms `ms`. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Local midnight `range - 1` days before `now`'s day: the window is `range` whole days, today included. */
export function windowStart(now: number, range: Range): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - (range - 1)).getTime();
}

export function newAggregate(range: Range, scope: Scope, now: number): Aggregate {
  return { range, scope, since: windowStart(now, range), totals: tally(), days: new Map(), models: new Map(), worktrees: new Map(), limits: [], maxId: -1 };
}

function addTokens(into: Tokens, turn: UsageTurn): void {
  const t = turn.tokens;
  if (!t) return;
  into.input += t.input;
  into.cached += t.cachedInput + t.cachedWrite;
  into.output += t.output + t.reasoningOutput;
  into.total += t.total;
}

function addCost(costs: Record<string, number>, turn: UsageTurn): void {
  if (turn.cost) costs[turn.cost.currency] = (costs[turn.cost.currency] ?? 0) + turn.cost.amount;
}

function count(into: Tally, turn: UsageTurn): void {
  into.turns++;
  addTokens(into.tokens, turn);
  if (turn.cost) addCost(into.costs, turn);
  else into.costMissing++;
  into.durationMs += turn.endedAt - turn.startedAt;
  if (turn.result === "completed") into.completed++;
}

function entry<V>(map: Map<string, V>, key: string, make: () => V): V {
  let value = map.get(key);
  if (!value) map.set(key, (value = make()));
  return value;
}

/** Folds one turn in. Turns that ended before the window are ignored. */
export function addTurn(agg: Aggregate, turn: UsageTurn): void {
  if (turn.endedAt < agg.since) return;
  agg.maxId = Math.max(agg.maxId, turn.id);
  count(agg.totals, turn);
  const day = entry(agg.days, dayKey(turn.endedAt), () => ({ byAgent: new Map<string, Tokens>(), costs: {} }));
  addTokens(entry(day.byAgent, turn.agent, tokens), turn);
  addCost(day.costs, turn);
  count(entry(agg.models, `${turn.agent}\0${turn.model ?? ""}`, () => ({ ...tally(), agent: turn.agent, model: turn.model })), turn);
  count(entry(agg.worktrees, `${turn.project ?? ""}\0${turn.worktree ?? ""}`, () => ({ ...tally(), project: turn.project, worktree: turn.worktree })), turn);
}

export function addLimit(agg: Aggregate, limit: UsageLimit): void {
  agg.limits.push(limit);
}

function merge(into: Tally, from: Tally): void {
  into.turns += from.turns;
  for (const k of ["input", "cached", "output", "total"] as const) into.tokens[k] += from.tokens[k];
  for (const [currency, amount] of Object.entries(from.costs)) into.costs[currency] = (into.costs[currency] ?? 0) + amount;
  into.costMissing += from.costMissing;
  into.durationMs += from.durationMs;
  into.completed += from.completed;
}

function rows(list: Row[]): Row[] {
  return list.sort((a, b) => b.tokens.total - a.tokens.total || b.turns - a.turns).slice(0, MAX_ROWS);
}

/**
 * What the page shows. `where` names a turn's or limit's worktree; worktrees it names alike (say, every one
 * of another project) share a row.
 */
export function summarize(agg: Aggregate, now: number, where: (project?: string, worktree?: string) => string): Summary {
  const days: Day[] = [];
  const agentTotals = new Map<string, number>();
  const start = new Date(agg.since);
  for (let i = 0, end = dayKey(now); ; i++) {
    const day = dayKey(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i).getTime());
    const d = agg.days.get(day);
    const byAgent: Record<string, Tokens> = {};
    for (const [agent, t] of d?.byAgent ?? []) {
      byAgent[agent] = { ...t };
      agentTotals.set(agent, (agentTotals.get(agent) ?? 0) + t.total);
    }
    days.push({ day, byAgent, costs: { ...d?.costs } });
    if (day >= end) break;
  }
  const models: Row[] = [...agg.models.values()].map(({ agent, model, ...t }) => ({ ...t, label: agent, ...(model ? { model } : {}) }));
  const byPlace = new Map<string, Row>();
  for (const { project, worktree, ...t } of agg.worktrees.values()) merge(entry(byPlace, where(project, worktree), () => ({ ...tally(), label: where(project, worktree) })), t);
  const limits = agg.limits.toSorted((a, b) => b.detectedAt - a.detectedAt).slice(0, MAX_LIMITS).map((l) => ({
    agent: l.agent, where: where(l.project, l.worktree), detectedAt: l.detectedAt, ...(l.resetsAt === undefined ? {} : { resetsAt: l.resetsAt }),
  }));
  const omitted = Math.max(0, models.length - MAX_ROWS) + Math.max(0, byPlace.size - MAX_ROWS) + Math.max(0, agg.limits.length - MAX_LIMITS);
  return {
    range: agg.range,
    scope: agg.scope,
    since: agg.since,
    totals: agg.totals,
    limitHits: agg.limits.length,
    days,
    agents: [...agentTotals.keys()].sort((a, b) => agentTotals.get(b)! - agentTotals.get(a)!),
    models: rows(models),
    worktrees: rows([...byPlace.values()]),
    limits,
    omitted,
  };
}
