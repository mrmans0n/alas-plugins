import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStacks, individualBlocker, stackScope, type StackReview } from "./inbox-stacks.ts";

const review = (number: number, base = "main", extra: Partial<StackReview> = {}): StackReview => ({
  identity: { host: "github.com", repo: "o/r", number }, sourceRepo: "o/r", branch: `f${number}`, base,
  sha: String(number).repeat(40), title: `Change ${number}`, url: `https://github.com/o/r/pull/${number}`,
  author: "nacho", state: "open", ready: true, ...extra,
});
const graph = (reviews: StackReview[], extra = {}) => buildStacks(reviews, { complete: true, ...extra });

test("branch chains are ordered independently of inbox order and full/prefix scopes differ", () => {
  const result = graph([review(3, "f2"), review(1), review(2, "f1", { author: "ana" })]);
  const stack = result.components[0];
  assert.deepEqual(stack.order?.map(r => r.identity.number), [1, 2, 3]);
  assert.deepEqual(stackScope(stack).scope?.members.map(r => r.identity.number), [1, 2, 3]);
  assert.deepEqual(stackScope(stack, { host: "github.com", repo: "o/r", number: 2 }).scope?.members.map(r => r.identity.number), [1, 2]);
  assert.equal(stack.finalBase, "main");
});

test("a source branch from another fork cannot become a parent in the target repository", () => {
  assert.equal(graph([review(1, "main", { sourceRepo: "a/fork" }), review(2, "f1")]).components.length, 0);
  assert.equal(graph([review(1), review(2, "f1", { identity: { host: "gitlab.example.com", repo: "o/r", number: 2 } })]).components.length, 0);
});

test("cycles and branching dependencies remain navigable without an executable chain", () => {
  for (const reviews of [[review(1, "f2"), review(2, "f1")], [review(1), review(2, "f1"), review(3, "f1")]]) {
    const stack = graph(reviews).components[0];
    assert.equal(stack.order, undefined);
    assert.ok(stackScope(stack).error);
    assert.ok(stack.members.length >= 2);
  }
});

test("closed blockers, inaccessible dependencies, and incomplete pages never become merge candidates", () => {
  const blocker = { host: "github.com", repo: "o/r", number: 1 };
  for (const [reviews, extra] of [
    [[review(1, "main", { state: "closed" }), review(2, "main", { blockers: [blocker] })], {}],
    [[review(2, "main", { blockers: [blocker] })], {}],
    [[review(1), review(2, "f1")], { complete: false }],
  ] as [StackReview[], object][]) assert.ok(stackScope(graph(reviews, extra).components[0]).error);
  const unresolved = graph([review(1, "main", { blockersComplete: false })]);
  assert.ok(unresolved.blocked["github.com|o/r#1"]);
});

test("merged dependencies are context and are excluded from the frozen write scope", () => {
  const stack = graph([review(1, "main", { state: "merged" }), review(2, "f1")]).components[0];
  assert.deepEqual(stackScope(stack).scope?.members.map(r => r.identity.number), [2]);
  assert.equal(stack.members.length, 2);
});

test("native order is authoritative but conflicting heads and missing entries stay incomplete", () => {
  const native = { id: "wt", name: "feature", base: "main", host: "github.com", repo: "o/r", fingerprint: "native", complete: true,
    actions: ["land" as const], entries: [1, 2].map(number => ({ id: `gg-${number}`, sha: String(number).repeat(7), position: number, number, title: "Entry" })) };
  const known = graph([review(2), review(1)], { native: [native] }).components[0];
  assert.deepEqual(known.order?.map(r => r.identity.number), [1, 2]);
  assert.equal(stackScope(known).error, undefined);
  assert.ok(stackScope(graph([review(1), review(2, "main", { sha: "f".repeat(40) })], { native: [native] }).components[0]).error);
  assert.ok(stackScope(graph([review(1, "unrelated-base"), review(2)], { native: [native] }).components[0]).error);
  const remote = { ...native, complete: false, entries: [], reviewNumbers: [2, 1], actions: [] };
  const placeholder = graph([review(1), review(2)], { native: [remote] }).components[0];
  assert.equal(placeholder.order, undefined);
  assert.ok(stackScope(placeholder).error);
  assert.ok(graph([review(1), review(2)], { native: [remote] }).blocked["github.com|o/r#1"]);
});

test("individual actions affect one request and cannot skip an unmerged predecessor", () => {
  const data = graph([review(1), review(2, "f1")]);
  assert.equal(individualBlocker(data, { host: "github.com", repo: "o/r", number: 1 }), undefined);
  assert.match(individualBlocker(data, { host: "github.com", repo: "o/r", number: 2 }) ?? "", /#1/);
  const after = graph([review(1, "main", { state: "merged" }), review(2, "main", { blockers: [{ host: "github.com", repo: "o/r", number: 1 }] })]);
  assert.equal(individualBlocker(after, { host: "github.com", repo: "o/r", number: 2 }), undefined);
});
