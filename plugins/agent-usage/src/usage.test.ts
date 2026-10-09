import { test } from "node:test";
import assert from "node:assert/strict";
import type { UsageTurn } from "@alas/plugin";
import { addLimit, addTurn, badgeFor, limitsToday, newAggregate, summarize } from "./usage.ts";

/** Local time, so bucketing is checked in whatever zone the tests run in. */
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();
const NOW = at(4, 12);

let nextId = 1;
function turn(endedAt: number, extra: Partial<UsageTurn> = {}): UsageTurn {
  return {
    id: nextId++, session: "s", project: "p", worktree: "w1", agent: "claude", model: "opus",
    startedAt: endedAt - 10_000, endedAt, result: "completed",
    tokens: { total: 100, input: 10, cachedInput: 60, cachedWrite: 5, output: 20, reasoningOutput: 5 },
    ...extra,
  };
}

const where = (project?: string, worktree?: string) => (project === "p" ? (worktree === "w1" ? "main" : "feature") : "Other project");

test("turns are bucketed by the local day they ended on, and every day of the window is listed", () => {
  const agg = newAggregate(7, "project", NOW);
  addTurn(agg, turn(at(3, 23, 59)));
  addTurn(agg, turn(at(4, 0, 1), { agent: "codex" }));
  addTurn(agg, turn(at(4, 9)));
  addTurn(agg, turn(at(27 - 30, 12))); // September 27: before the window
  const s = summarize(agg, NOW, where);
  assert.deepEqual(s.days.map((d) => d.day), ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
  assert.deepEqual(s.days.at(-2)!.byAgent, { claude: { input: 10, cached: 65, output: 25, total: 100 } });
  assert.deepEqual(Object.keys(s.days.at(-1)!.byAgent), ["codex", "claude"]);
  assert.equal(s.totals.turns, 3);
});

test("costs sum per currency, and turns without one are counted instead", () => {
  const agg = newAggregate(30, "project", NOW);
  addTurn(agg, turn(at(2, 10), { cost: { amount: 0.25, currency: "USD" } }));
  addTurn(agg, turn(at(2, 11), { cost: { amount: 0.5, currency: "USD" } }));
  addTurn(agg, turn(at(3, 11), { cost: { amount: 2, currency: "EUR" } }));
  addTurn(agg, turn(at(3, 12)));
  const s = summarize(agg, NOW, where);
  assert.deepEqual(s.totals.costs, { USD: 0.75, EUR: 2 });
  assert.equal(s.totals.costMissing, 1);
  assert.deepEqual(s.days.find((d) => d.day === "2026-10-02")!.costs, { USD: 0.75 });
});

test("agent and model rows carry turns, tokens, success and duration, most tokens first", () => {
  const agg = newAggregate(30, "project", NOW);
  addTurn(agg, turn(at(2, 10), { startedAt: at(2, 9, 58) }));
  addTurn(agg, turn(at(2, 11), { result: "failed", tokens: undefined, startedAt: at(2, 11) }));
  addTurn(agg, turn(at(2, 12), { agent: "codex", model: undefined, tokens: { total: 900, input: 900, cachedInput: 0, cachedWrite: 0, output: 0, reasoningOutput: 0 } }));
  const [codex, claude] = summarize(agg, NOW, where).models;
  assert.deepEqual([codex.label, codex.model, codex.tokens.total], ["codex", undefined, 900]);
  assert.deepEqual([claude.label, claude.model, claude.turns, claude.completed, claude.tokens.total, claude.durationMs], ["claude", "opus", 2, 1, 100, 120_000]);
});

test("worktrees named alike share a row, and limits are newest first with their place", () => {
  const agg = newAggregate(30, "all", NOW);
  addTurn(agg, turn(at(2, 10)));
  addTurn(agg, turn(at(2, 10), { project: "q", worktree: "x" }));
  addTurn(agg, turn(at(2, 10), { project: "r", worktree: "y" }));
  addLimit(agg, { session: "s", agent: "claude", project: "p", worktree: "w2", detectedAt: at(1, 9), resetSource: "unknown" });
  addLimit(agg, { session: "s", agent: "codex", project: "q", detectedAt: at(3, 9), resetsAt: at(3, 14), resetSource: "parsed" });
  const s = summarize(agg, NOW, where);
  assert.deepEqual(s.worktrees.map((w) => [w.label, w.turns]), [["Other project", 2], ["main", 1]]);
  assert.deepEqual(s.limits, [
    { agent: "codex", where: "Other project", detectedAt: at(3, 9), resetsAt: at(3, 14) },
    { agent: "claude", where: "feature", detectedAt: at(1, 9) },
  ]);
  assert.equal(s.limitHits, 2);
});

test("limit hits today count from local midnight", () => {
  const agg = newAggregate(7, "project", NOW);
  const limit = (detectedAt: number) => ({ session: "s", agent: "claude", detectedAt, resetSource: "unknown" as const });
  addLimit(agg, limit(at(3, 23, 59)));
  addLimit(agg, limit(at(4, 0, 0)));
  addLimit(agg, limit(at(4, 11)));
  assert.equal(limitsToday(agg, NOW), 2);
});

test("the badge counts project hits today, clears at none, and is left alone for other scopes", () => {
  const limit = { session: "s", agent: "claude", detectedAt: at(4, 11), resetSource: "unknown" as const };
  const project = newAggregate(7, "project", NOW);
  assert.equal(badgeFor(project, NOW), null);
  addLimit(project, limit);
  assert.deepEqual(badgeFor(project, NOW), { count: 1, tone: "danger" });
  const all = newAggregate(7, "all", NOW);
  addLimit(all, limit);
  assert.equal(badgeFor(all, NOW), undefined);
});
