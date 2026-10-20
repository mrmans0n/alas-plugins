import { test } from "node:test";
import assert from "node:assert/strict";
import type { Merged, Pull } from "./inbox.ts";
import { inboxModel, readyCount, type ViewState } from "./view.ts";

const pull = (number: number, fields: Partial<Pull> = {}): Pull => ({
  number, title: `PR ${number}`, url: `https://github.com/o/r/pull/${number}`, isDraft: false, author: "nacho",
  branch: `nacho/pr-${number}`, updatedAt: `2026-09-${String(number).padStart(2, "0")}T00:00:00Z`, reviewDecision: null,
  mergeable: "MERGEABLE", ci: "SUCCESS", checks: null, codexThumbsUp: true, codexReviewing: false, ...fields,
});
const NOW = 1_000_000_000;
const model = (fields: Partial<ViewState>) => inboxModel({ refreshing: false, mergeErrors: {}, ...fields }, NOW);
const inbox = (pulls: Pull[], merged: Merged[] = []) => ({ repo: "o/r", pulls, merged });
const rowOf = (fields: Partial<Pull>) => model({ inbox: inbox([pull(1, fields)]) }).sections[0].rows[0];

test("buckets come in order with their counts, skipping empty ones", () => {
  const m = model({ inbox: inbox([pull(1, { isDraft: true }), pull(2, { ci: "FAILURE" }), pull(3), pull(4, { ci: "ERROR" }), pull(5, { ci: "PENDING" })]), fetchedAt: NOW });
  assert.deepEqual(m.sections.map((s) => [s.title, s.tone, s.rows.map((r) => r.number)]), [
    ["Ready to merge", "success", [3]], ["Waiting", "warn", [5]], ["Failing", "danger", [4, 2]], ["Drafts", "dim", [1]],
  ]);
  assert.deepEqual(m.counts, { ready: 1, waiting: 1, failing: 2, drafts: 1 });
  assert.equal(m.repo, "o/r");
  assert.equal(m.fetchedAt, NOW);
  assert.equal(m.sections[3].rows[0].merge, undefined, "drafts do not merge");
  assert.equal(m.sections[2].rows[0].url, "https://github.com/o/r/pull/4");
});

test("while one pull request merges, every merge button is disabled and it shows progress", () => {
  const rows = model({ inbox: inbox([pull(1), pull(2)]), merging: 2, mergeErrors: { 1: "not mergeable" } }).sections[0].rows;
  const byNumber = Object.fromEntries(rows.map((r) => [r.number, r]));
  assert.equal(byNumber[1].merge!.disabled, true);
  assert.equal(byNumber[2].merge!.disabled, true);
  assert.ok(byNumber[2].merge!.busy && !byNumber[1].merge!.busy);
  assert.equal(byNumber[1].error, "not mergeable");
});

test("placeholders: loading before the first list, nothing more once the first list failed", () => {
  assert.equal(model({ refreshing: true }).loading, true);
  const failed = model({ error: "This repository has no GitHub remote." });
  assert.equal(failed.loading, false);
  assert.equal(failed.error, "This repository has no GitHub remote.");
  const clear = model({ inbox: inbox([]) });
  assert.deepEqual([clear.sections, clear.merged, clear.loading], [[], [], false]);
});

test("the Codex chip shows 👍, else 👀 while it reviews, else nothing", () => {
  const codex = (fields: Partial<Pull>) => rowOf(fields).chips.find((c) => c.text.startsWith("Codex"))?.text;
  assert.equal(codex({ codexReviewing: true }), "Codex 👍");
  assert.equal(codex({ codexThumbsUp: false, codexReviewing: true }), "Codex 👀");
  assert.equal(codex({ codexThumbsUp: false }), undefined);
});

test("chips name checks, review and conflicts", () => {
  const texts = (fields: Partial<Pull>) => rowOf(fields).chips.map((c) => `${c.text}:${c.tone}`);
  assert.deepEqual(texts({ checks: { done: 9, running: 0, total: 9 }, reviewDecision: "APPROVED" }), ["✓ CI 9/9:success", "✓ Approved:success", "Codex 👍:success"]);
  assert.deepEqual(texts({ ci: "FAILURE", reviewDecision: "CHANGES_REQUESTED", mergeable: "CONFLICTING", codexThumbsUp: false }), ["✗ CI:danger", "Changes requested:warn", "Conflicts:warn"]);
  assert.deepEqual(texts({ ci: "PENDING", checks: { done: 1, running: 1, total: 4 }, reviewDecision: "REVIEW_REQUIRED" }), ["Review needed:dim", "Codex 👍:success"], "the bar stands for running checks");
  assert.deepEqual(texts({ ci: null }), ["Codex 👍:success"]);
});

test("a Codex 👍 gets a merge button that looks as safe as the checks are", () => {
  const look = (fields: Partial<Pull>) => {
    const m = rowOf(fields).merge;
    return m && `${m.look} ${m.label} ${m.short}`;
  };
  assert.equal(look({}), "go Squash & merge Merge");
  assert.equal(look({ ci: "PENDING" }), "plain Squash & merge Merge");
  assert.equal(look({ ci: null }), "plain Squash & merge Merge");
  assert.equal(look({ ci: "FAILURE" }), "risk Merge anyway Anyway");
  assert.equal(look({ ci: "ERROR" }), "risk Merge anyway Anyway");
  assert.equal(look({ codexThumbsUp: false }), undefined);
  assert.equal(look({ codexThumbsUp: false, author: "renovate" }), "go Squash & merge Merge");
  assert.equal(look({ mergeable: "CONFLICTING" }), undefined);
});

test("checks still running give a bar of done, running and left, failed once one failed", () => {
  assert.deepEqual(rowOf({ ci: "PENDING", checks: { done: 3, running: 2, total: 10 } }).checks, { done: 3, running: 2, total: 10, failed: false });
  assert.equal(rowOf({ ci: "FAILURE", checks: { done: 3, running: 2, total: 10 } }).checks!.failed, true);
  assert.equal(rowOf({ checks: { done: 10, running: 0, total: 10 } }).checks, undefined);
  assert.equal(rowOf({ ci: null }).checks, undefined);
});

test("Merge all is offered from two ready pull requests and shows its progress", () => {
  assert.equal(model({ inbox: inbox([pull(1), pull(2, { ci: "PENDING" })]) }).mergeAll, undefined);
  assert.deepEqual(model({ inbox: inbox([pull(1), pull(2)]) }).mergeAll, { count: 2, disabled: false });
  assert.deepEqual(model({ inbox: inbox([pull(2)]), merging: 2, mergeAll: { total: 3, done: 1 } }).mergeAll, { count: 1, disabled: true, progress: "Merging 2 of 3…" });
  assert.equal(readyCount({ refreshing: false, mergeErrors: {}, inbox: inbox([pull(1), pull(2), pull(3, { isDraft: true })]) }), 2);
  assert.equal(readyCount({ refreshing: false, mergeErrors: {} }), 0);
});

const merged = (number: number, mergedAt: string): Merged => ({
  number, title: `Merged ${number}`, url: `https://github.com/o/r/pull/${number}`, author: "nacho", branch: `nacho/m-${number}`, mergedAt,
});

test("recently merged pull requests come in the order given, with when and who", () => {
  const m = model({ inbox: inbox([pull(1)], [merged(9, new Date(NOW - 2 * 3600_000).toISOString()), merged(8, new Date(NOW - 3 * 24 * 3600_000).toISOString())]) });
  assert.deepEqual(m.merged.map((r) => [r.number, r.author, r.url]), [[9, "nacho", "https://github.com/o/r/pull/9"], [8, "nacho", "https://github.com/o/r/pull/8"]]);
});

test("rows carry the author's avatar when there is one", () => {
  const avatar = "https://avatars.githubusercontent.com/u/1?v=4";
  const m = model({ inbox: inbox([pull(1, { avatar }), pull(2)], [{ ...merged(9, new Date(NOW).toISOString()), avatar }]) });
  assert.deepEqual(m.sections[0].rows.map((r) => r.avatar), [undefined, avatar]);
  assert.equal(m.merged[0].avatar, avatar);
  assert.ok(!("avatar" in m.sections[0].rows[0]));
});

test("recently merged lists the last day's, or the last 5 when fewer", () => {
  const hour = 3600_000;
  const numbers = (list: Merged[]) => model({ inbox: inbox([], list) }).merged.map((r) => r.number);
  // One every 2 hours: 12 within the day (2h … 24h), the rest older.
  const busy = numbers(Array.from({ length: 20 }, (_, i) => merged(100 - i, new Date(NOW - (i + 1) * 2 * hour).toISOString())));
  assert.equal(busy.length, 12);
  assert.equal(busy.at(-1), 89);
  // One every 10 hours: 2 within the day, filled up to 5 with older ones.
  const quiet = numbers(Array.from({ length: 8 }, (_, i) => merged(50 - i, new Date(NOW - (i + 1) * 10 * hour).toISOString())));
  assert.deepEqual(quiet, [50, 49, 48, 47, 46]);
  assert.deepEqual(numbers([merged(9, new Date(NOW - 100 * hour).toISOString())]), [9]);
});
