import { test } from "node:test";
import assert from "node:assert/strict";
import type { Node } from "@alas/plugin";
import type { Pull } from "./inbox.ts";
import { inboxView, mergeButtonId, mergeTarget, type ViewState } from "./view.ts";

const pull = (number: number, fields: Partial<Pull> = {}): Pull => ({
  number, title: `PR ${number}`, url: `https://github.com/o/r/pull/${number}`, isDraft: false, author: "nacho",
  branch: `nacho/pr-${number}`, updatedAt: `2026-09-${String(number).padStart(2, "0")}T00:00:00Z`, reviewDecision: null,
  mergeable: "MERGEABLE", ci: "SUCCESS", codexThumbsUp: true, codexReviewing: false, ...fields,
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
  const tree = view({ inbox: { repo: "o/r", pulls: [pull(1, { isDraft: true }), pull(2, { ci: "FAILURE" }), pull(3), pull(4, { ci: "ERROR" })] }, fetchedAt: NOW });
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
  const tree = nodes(view({ inbox: { repo: "o/r", pulls: [pull(1), pull(2)] }, merging: 2, mergeErrors: { 1: "not mergeable" } }));
  assert.equal((tree.get(mergeButtonId(1)) as any).disabled, true);
  assert.equal((tree.get(mergeButtonId(2)) as any).disabled, true);
  assert.ok(tree.has("pr-2-merging") && !tree.has("pr-1-merging"));
  assert.equal((tree.get("pr-1-error") as any).text, "not mergeable");
});

test("placeholders: loading before the first list, clear with nothing open, the error alone when the first list failed", () => {
  assert.ok(texts(view({ refreshing: true })).includes("Loading pull requests…"));
  assert.ok(texts(view({ inbox: { repo: "o/r", pulls: [] } })).includes("Inbox is clear."));
  const failed = view({ error: "This repository has no GitHub remote." });
  assert.ok(nodes(failed).has("retry"));
  assert.ok(!texts(failed).includes("Loading pull requests…"));
  const refreshing = nodes(view({ inbox: { repo: "o/r", pulls: [] }, refreshing: true }));
  assert.ok(refreshing.has("refreshing") && !refreshing.has("refresh"));
});

test("the Codex badge shows 👍, else 👀 while it reviews, else nothing", () => {
  const codex = (fields: Partial<Pull>) => (nodes(view({ inbox: { repo: "o/r", pulls: [pull(1, fields)] } })).get("pr-1-codex") as any)?.text;
  assert.equal(codex({ codexReviewing: true }), "Codex 👍");
  assert.equal(codex({ codexThumbsUp: false, codexReviewing: true }), "Codex 👀");
  assert.equal(codex({ codexThumbsUp: false }), undefined);
});

test("a Codex 👍 gets a merge button that looks as safe as the checks are", () => {
  const button = (fields: Partial<Pull>) => {
    const b = nodes(view({ inbox: { repo: "o/r", pulls: [pull(1, fields)] } })).get(mergeButtonId(1)) as any;
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

test("merge button ids name a pull request number and nothing else", () => {
  assert.equal(mergeTarget(mergeButtonId(1234)), 1234);
  for (const id of ["pr-12-open", "pr--merge", "pr-1x-merge", "pr-1234567890-merge", "refresh"]) assert.equal(mergeTarget(id), undefined, id);
});
