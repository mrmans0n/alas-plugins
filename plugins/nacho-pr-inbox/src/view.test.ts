import { test } from "node:test";
import assert from "node:assert/strict";
import type { Node } from "@alas/plugin";
import type { Merged, Pull } from "./inbox.ts";
import { inboxView, mergeButtonId, mergeTarget, SHOW_MORE_MERGED, type ViewState } from "./view.ts";

const pull = (number: number, fields: Partial<Pull> = {}): Pull => ({
  number, title: `PR ${number}`, url: `https://github.com/o/r/pull/${number}`, isDraft: false, author: "nacho",
  branch: `nacho/pr-${number}`, updatedAt: `2026-09-${String(number).padStart(2, "0")}T00:00:00Z`, reviewDecision: null,
  mergeable: "MERGEABLE", ci: "SUCCESS", checks: null, codexThumbsUp: true, codexReviewing: false, ...fields,
});
const NOW = 1_000_000_000;
const view = (fields: Partial<ViewState>) => inboxView({ refreshing: false, mergeErrors: {}, ...fields }, NOW);

/** Every node in the tree, by id. */
function nodes(root: Node): Map<string, Node> {
  const out = new Map<string, Node>();
  const visit = (n: Node) => {
    assert.ok(!out.has(n.id), `duplicate id ${n.id}`);
    out.set(n.id, n);
    if ("children" in n) n.children.forEach(visit);
    if (n.kind === "scroll") visit(n.child);
  };
  visit(root);
  return out;
}
const texts = (root: Node) => [...nodes(root).values()].flatMap((n) => ("text" in n && n.text ? [n.text] : []));

test("buckets show in order with their counts, skipping empty ones", () => {
  const tree = view({ inbox: { repo: "o/r", pulls: [pull(1, { isDraft: true }), pull(2, { ci: "FAILURE" }), pull(3), pull(4, { ci: "ERROR" })], merged: [] }, fetchedAt: NOW });
  const all = texts(tree);
  assert.deepEqual(all.filter((t) => /^[A-Z ]+$/.test(t) || / PRs?$/.test(t)), ["READY TO MERGE", "1 PR", "FAILING", "2 PRs", "DRAFTS", "1 PR"]);
  assert.ok(all.includes("PR Inbox — o/r"));
  assert.ok(all.includes("Updated just now"));
  const ids = nodes(tree);
  assert.equal((ids.get("bucket-failing-count") as any).tone, "danger");
  assert.ok(ids.has(mergeButtonId(3)));
  assert.ok(!ids.has(mergeButtonId(1)), "drafts do not merge");
  assert.equal((ids.get("pr-2-open") as any).url, "https://github.com/o/r/pull/2");
});

test("while one pull request merges, every merge button is disabled and it shows progress", () => {
  const tree = nodes(view({ inbox: { repo: "o/r", pulls: [pull(1), pull(2)], merged: [] }, merging: 2, mergeErrors: { 1: "not mergeable" } }));
  assert.equal((tree.get(mergeButtonId(1)) as any).disabled, true);
  assert.equal((tree.get(mergeButtonId(2)) as any).disabled, true);
  assert.ok(tree.has("pr-2-merging") && !tree.has("pr-1-merging"));
  assert.equal((tree.get("pr-1-error") as any).text, "not mergeable");
});

test("placeholders: loading before the first list, clear with nothing open, the error alone when the first list failed", () => {
  assert.ok(texts(view({ refreshing: true })).includes("Loading pull requests…"));
  assert.ok(texts(view({ inbox: { repo: "o/r", pulls: [], merged: [] } })).includes("Inbox is clear."));
  const failed = view({ error: "This repository has no GitHub remote." });
  assert.ok(nodes(failed).has("retry"));
  assert.ok(!texts(failed).includes("Loading pull requests…"));
  const refreshing = nodes(view({ inbox: { repo: "o/r", pulls: [], merged: [] }, refreshing: true }));
  assert.ok(refreshing.has("refreshing") && !refreshing.has("refresh"));
});

test("the Codex badge shows 👍, else 👀 while it reviews, else nothing", () => {
  const codex = (fields: Partial<Pull>) => (nodes(view({ inbox: { repo: "o/r", pulls: [pull(1, fields)], merged: [] } })).get("pr-1-codex") as any)?.text;
  assert.equal(codex({ codexReviewing: true }), "Codex 👍");
  assert.equal(codex({ codexThumbsUp: false, codexReviewing: true }), "Codex 👀");
  assert.equal(codex({ codexThumbsUp: false }), undefined);
});

test("a Codex 👍 gets a merge button that looks as safe as the checks are", () => {
  const button = (fields: Partial<Pull>) => {
    const b = nodes(view({ inbox: { repo: "o/r", pulls: [pull(1, fields)], merged: [] } })).get(mergeButtonId(1)) as any;
    return b && `${b.style} ${b.tone ?? "-"} ${b.icon ?? "-"} ${b.label}`;
  };
  assert.equal(button({}), "primary success checkmark Squash & merge");
  assert.equal(button({ ci: "PENDING" }), "normal - - Squash & merge");
  assert.equal(button({ ci: null }), "normal - - Squash & merge");
  assert.equal(button({ ci: "FAILURE" }), "normal warn exclamationmark.triangle Merge anyway");
  assert.equal(button({ ci: "ERROR" }), "normal warn exclamationmark.triangle Merge anyway");
  assert.equal(button({ codexThumbsUp: false }), undefined);
  assert.equal(button({ mergeable: "CONFLICTING" }), undefined);
  assert.equal(button({ isDraft: true }), undefined);
});

test("checks still running show a bar of done, running and left, red once one failed", () => {
  const bar = (fields: Partial<Pull>) => nodes(view({ inbox: { repo: "o/r", pulls: [pull(1, fields)], merged: [] } })).get("pr-1-checks") as any;
  assert.deepEqual(bar({ ci: "PENDING", checks: { done: 3, running: 2, total: 10 } }),
    { kind: "progressBar", id: "pr-1-checks", done: 3, running: 2, total: 10, text: "3/10", tone: "success" });
  assert.equal(bar({ ci: "FAILURE", checks: { done: 3, running: 2, total: 10 } }).tone, "danger");
  assert.equal(bar({ checks: { done: 10, running: 0, total: 10 } }), undefined);
  assert.equal(bar({ ci: null }), undefined);
});

test("merge button ids name a pull request number and nothing else", () => {
  assert.equal(mergeTarget(mergeButtonId(1234)), 1234);
  for (const id of ["pr-12-open", "pr--merge", "pr-1x-merge", "pr-1234567890-merge", "refresh"]) assert.equal(mergeTarget(id), undefined, id);
});

const merged = (number: number, mergedAt: string): Merged => ({
  number, title: `Merged ${number}`, url: `https://github.com/o/r/pull/${number}`, author: "nacho", branch: `nacho/m-${number}`, mergedAt,
});

test("recently merged pull requests follow the open ones, in the order given, with when and who", () => {
  const at = new Date(NOW - 2 * 3600_000).toISOString();
  const tree = view({ inbox: { repo: "o/r", pulls: [pull(1)], merged: [merged(9, at), merged(8, new Date(NOW - 3 * 24 * 3600_000).toISOString())] } });
  const all = texts(tree);
  assert.ok(all.indexOf("RECENTLY MERGED") > all.indexOf("READY TO MERGE"));
  assert.ok(all.includes("2 PRs"));
  assert.ok(all.indexOf("Merged 9") < all.indexOf("Merged 8"));
  assert.ok(all.includes("merged 2h ago by nacho"));
  const ids = nodes(tree);
  assert.equal((ids.get("merged-9-open") as any).url, "https://github.com/o/r/pull/9");
  assert.ok(!ids.has(mergeButtonId(9)));
});

test("with nothing open, the inbox is clear above the recently merged", () => {
  const all = texts(view({ inbox: { repo: "o/r", pulls: [], merged: [merged(9, new Date(NOW - 3600_000).toISOString())] } }));
  assert.ok(all.indexOf("Inbox is clear.") < all.indexOf("RECENTLY MERGED"));
  assert.ok(all.includes("Merged 9"));
});

test("recently merged lists the last week's, up to 10, and Show more adds up to 10 until all show", () => {
  const day = 24 * 3600_000;
  const all = Array.from({ length: 23 }, (_, i) => merged(100 - i, new Date(NOW - (i + 1) * day / 2).toISOString()));
  const at = (mergedShown?: number, list = all) => nodes(view({ inbox: { repo: "o/r", pulls: [], merged: list }, mergedShown }));
  const first = at(undefined);
  assert.ok(first.has("merged-91-row") && !first.has("merged-90-row"));
  assert.equal((first.get("bucket-merged-count") as any).text, "10 PRs");
  assert.equal((first.get(SHOW_MORE_MERGED) as any).label, "Show 10 more");
  assert.equal((at(20).get(SHOW_MORE_MERGED) as any).label, "Show 3 more");
  const everything = at(30);
  assert.ok(everything.has("merged-78-row"));
  assert.equal((everything.get("bucket-merged-count") as any).text, "23 PRs");
  assert.ok(!everything.has(SHOW_MORE_MERGED));

  // Merged every other day: 3 within the week (days 2, 4, 6), the rest older.
  const sparse = Array.from({ length: 6 }, (_, i) => merged(50 - i, new Date(NOW - (i + 1) * 2 * day).toISOString()));
  const week = at(undefined, sparse);
  assert.ok(week.has("merged-48-row") && !week.has("merged-47-row"));
  assert.equal((week.get(SHOW_MORE_MERGED) as any).label, "Show 3 more");
  const stale = at(undefined, [merged(9, new Date(NOW - 8 * day).toISOString())]);
  assert.equal((stale.get("merged-none") as any).text, "Nothing merged in the last week.");
  assert.equal((stale.get(SHOW_MORE_MERGED) as any).label, "Show 1 more");
});
