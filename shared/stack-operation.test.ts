import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStacks, stackScope, type StackReview } from "./inbox-stacks.ts";
import { createStackOperation, nextStackStep, restoreStackOperation } from "./stack-operation.ts";

const review = (n: number, fields: Partial<StackReview> = {}): StackReview => ({ identity: { host: "github.com", repo: "o/r", number: n },
  sourceRepo: "o/r", branch: `f${n}`, base: n === 1 ? "main" : `f${n - 1}`, sha: String(n).repeat(40),
  title: `Change ${n}`, url: `https://github.com/o/r/pull/${n}`, author: "nacho", state: "open", ready: true, ...fields });
const original = [review(1), review(2), review(3)];
const snapshot = (reviews = original, complete = true) => ({ reviews, graph: buildStacks(reviews, { complete }) });
const operation = (mode: "merge" | "queue" = "merge") => createStackOperation(stackScope(snapshot().graph.components[0]).scope!, mode);

test("execution merges root first and retargets the next branch only after confirmed merge", () => {
  const op = operation();
  assert.equal(nextStackStep(op, snapshot()).kind, "submit");
  const step = nextStackStep(op, snapshot([review(1, { state: "merged" }), review(2), review(3)]));
  assert.equal(step.kind, "retarget");
  if (step.kind === "retarget") assert.equal(step.member.identity.number, 2);
  const after = nextStackStep(op, snapshot([review(1, { state: "merged" }), review(2, { base: "main" }), review(3)]));
  assert.equal(after.kind, "submit");
  if (after.kind === "submit") assert.equal(after.member.identity.number, 2);
});

test("a queued ancestor is waiting even when every command exited successfully", () => {
  const op = { ...operation("queue"), submitted: "github.com|o/r#1" };
  const step = nextStackStep(op, snapshot([review(1, { queued: true }), review(2), review(3)]));
  assert.equal(step.kind, "wait");
  assert.equal(nextStackStep(op, snapshot([review(1), review(2), review(3)])).kind, "wait");
});

test("rewritten heads, new members, changed dependencies, and partial lists stop the frozen scope", () => {
  const changed = [
    snapshot([review(1), review(2, { sha: "a".repeat(40) }), review(3)]),
    snapshot([...original, review(4)]),
    snapshot([review(1), review(2, { base: "another-base" }), review(3)]),
    snapshot(original, false),
  ];
  for (const data of changed) assert.equal(nextStackStep(operation(), data).kind, "blocked");
  assert.equal(nextStackStep(operation(), snapshot([review(1, { state: "closed" }), review(2), review(3)])).kind, "blocked");
});

test("restored operation is interrupted and corrupted or oversized scope is refused", () => {
  const restored = restoreStackOperation({ ...operation(), phase: "running" });
  assert.equal(restored?.phase, "interrupted");
  assert.equal(restored?.scope.members.length, 3);
  assert.equal(restoreStackOperation({ ...operation(), submitted: "foreign" }), undefined);
  assert.equal(restoreStackOperation({ ...operation(), scope: { ...operation().scope, finalBase: "" } }), undefined);
  assert.equal(restoreStackOperation({ ...operation(), error: "x".repeat(900_000) }), undefined);
  assert.equal(restoreStackOperation({ ...operation(), mode: { toString: "not callable", valueOf: 1 } }), undefined);
});

test("a later scope failure preserves merges already confirmed by the provider", () => {
  const step = nextStackStep(operation(), snapshot([review(1, { state: "merged" }), review(2, { sha: "f".repeat(40) }), review(3)]));
  assert.equal(step.kind, "blocked");
  if (step.kind === "blocked") assert.deepEqual(step.completed, ["github.com|o/r#1"]);
});
