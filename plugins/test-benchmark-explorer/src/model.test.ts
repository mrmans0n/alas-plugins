import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyState, restoreState, remember, serializeState } from "./model.ts";

const summary = (id: string, worktree = "wt") => ({ schema: 1, id, project: "p", worktree, hostKey: "local",
  host: "machine", capturedAt: 10, complete: true, counts: { tests: 1, attempts: 1, benchmarks: 0, passed: 1, failed: 0, error: 0, skipped: 0, unknown: 0, state: "passed" },
  source: { state: "current", head: "abc" }, command: { outcome: "succeeded", argv: ["test"] }, detail: "available", issues: [] });

test("restart preserves current/baseline but resets source verification and deduplicates captures", () => {
  const state = emptyState();
  const a = summary("a".repeat(32));
  remember(state, a, "p", "wt", "local");
  remember(state, a, "p", "wt", "local");
  state.selected = { id: a.id, worktree: "wt" };
  state.baseline = state.selected;
  const restored = restoreState(JSON.parse(serializeState(state)));
  assert.equal(restored.runs.length, 1);
  assert.deepEqual(restored.selected, state.selected);
  assert.deepEqual(restored.baseline, state.baseline);
  assert.equal(restored.runs[0].source.state, "unknown");
  assert.equal(restored.runs[0].source.head, "abc");
});

test("run identity is checked before persistence and history stays within the byte/count limits", () => {
  const state = emptyState();
  assert.throws(() => remember(state, summary("b".repeat(32), "other"), "p", "wt", "local"));
  for (let i = 0; i < 100; i++) remember(state, { ...summary(i.toString(16).padStart(32, "0")), host: "β".repeat(4096) }, "p", "wt", "local");
  assert.ok(state.runs.length <= 40);
  assert.ok(Buffer.byteLength(serializeState(state)) <= 512 * 1024);
});

test("malformed or inconsistent summary counts cannot become passing results", () => {
  const a = summary("e".repeat(32));
  for (const counts of [
    { ...a.counts, failed: "1" }, { ...a.counts, error: undefined },
    { ...a.counts, unknown: -1 }, { ...a.counts, passed: 0.5 },
    { ...a.counts, benchmarks: Infinity }, { ...a.counts, tests: 2 },
    { ...a.counts, attempts: 0 },
  ]) {
    const state = emptyState();
    assert.throws(() => remember(state, { ...a, counts }, "p", "wt", "local"));
    assert.equal(state.runs.length, 0);
  }
});
