import { test } from "node:test";
import assert from "node:assert/strict";
import { agoLabel, bucketOf, classify, NO_REMOTE, parseInbox, processError, SIGN_IN, updatedLabel, type Pull } from "./inbox.ts";

/** One node as `gh api graphql` returns it for the manifest's query. */
const node = (number: number, fields: object = {}) => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/o/r/pull/${number}`,
  isDraft: false,
  author: { login: "nacho" },
  headRefName: `nacho/pr-${number}`,
  updatedAt: "2026-09-30T21:14:36Z",
  reviewDecision: null,
  mergeable: "MERGEABLE",
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
  reactions: { nodes: [{ user: { login: "chatgpt-codex-connector[bot]" } }] },
  ...fields,
});
const reply = (nodes: unknown[], merged?: unknown[]) =>
  JSON.stringify({ data: { repository: { nameWithOwner: "o/r", pullRequests: { nodes }, ...(merged && { merged: { nodes: merged } }) } } });
const mergedNode = (number: number, mergedAt: string, fields: object = {}) => ({
  number, title: `PR ${number}`, url: `https://github.com/o/r/pull/${number}`, author: { login: "nacho" }, headRefName: `nacho/pr-${number}`, mergedAt, ...fields,
});

test("parses the query's reply, skipping malformed and repeated pull requests and tolerating missing optional parts", () => {
  const inbox = parseInbox(reply([
    node(1),
    node(2, { author: null, commits: { nodes: [] }, reactions: { nodes: [{ user: null }] } }),
    node(3, { url: "javascript:alert(1)" }),
    node(4, { number: "4" }),
    null,
    node(1, { title: "again" }),
  ]));
  assert.equal(inbox?.repo, "o/r");
  assert.deepEqual(inbox?.pulls.map((p) => p.number), [1, 2]);
  assert.deepEqual(inbox?.pulls[0], {
    number: 1, title: "PR 1", url: "https://github.com/o/r/pull/1", isDraft: false, author: "nacho", branch: "nacho/pr-1",
    updatedAt: "2026-09-30T21:14:36Z", reviewDecision: null, mergeable: "MERGEABLE", ci: "SUCCESS", checks: null, codexThumbsUp: true, codexReviewing: false,
  });
  assert.equal(inbox?.pulls[1].author, "ghost");
  assert.equal(inbox?.pulls[1].ci, null);
  assert.equal(inbox?.pulls[1].codexThumbsUp, false);
});

test("check counts split into done, running and waiting", () => {
  const counts = (checkRuns: object[], statuses: object[] = [], totalCount = 10) => parseInbox(reply([node(1, {
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING", contexts: { totalCount, checkRunCountsByState: checkRuns, statusContextCountsByState: statuses } } } }] },
  })]))!.pulls[0].checks;
  assert.deepEqual(
    counts([{ state: "SUCCESS", count: 4 }, { state: "FAILURE", count: 1 }, { state: "IN_PROGRESS", count: 2 }, { state: "QUEUED", count: 1 }], [{ state: "PENDING", count: 1 }, { state: "EXPECTED", count: 1 }]),
    { done: 5, running: 3, total: 10 },
  );
  assert.deepEqual(counts([{ state: "IN_PROGRESS", count: 99 }, { state: "QUEUED", count: -3 }]), { done: 0, running: 10, total: 10 });
  assert.equal(counts([], [], 0), null);
});

test("a reply that is not the query's shape parses to nothing", () => {
  for (const stdout of ["", "{\"data\":{\"repo", "{\"data\":{\"repository\":null}}", "[]", reply("x" as any)]) {
    assert.equal(parseInbox(stdout), undefined, stdout);
  }
});

const pull = (fields: Partial<Pull> = {}): Pull => ({ ...parseInbox(reply([node(1)]))!.pulls[0], ...fields });

const cases: [string, Partial<Pull>, string][] = [
  ["green, approved, Codex 👍", { reviewDecision: "APPROVED" }, "ready"],
  ["green, no review required, Codex 👍", {}, "ready"],
  ["merge state not computed yet", { mergeable: "UNKNOWN" }, "ready"],
  ["without Codex 👍", { codexThumbsUp: false }, "waiting"],
  ["review required does not block", { reviewDecision: "REVIEW_REQUIRED" }, "ready"],
  ["changes requested does not block", { reviewDecision: "CHANGES_REQUESTED" }, "ready"],
  ["conflicting", { mergeable: "CONFLICTING" }, "waiting"],
  ["checks pending", { ci: "PENDING" }, "waiting"],
  ["no checks", { ci: null }, "waiting"],
  ["checks failed", { ci: "FAILURE" }, "failing"],
  ["checks errored", { ci: "ERROR" }, "failing"],
  ["a draft, even if otherwise ready", { isDraft: true }, "drafts"],
  ["a failing draft", { isDraft: true, ci: "FAILURE" }, "drafts"],
];
for (const [name, fields, bucket] of cases) {
  test(`classifies ${name} as ${bucket}`, () => assert.equal(bucketOf(pull(fields)), bucket));
}

test("the Codex 👍 counts from either of its logins", () => {
  for (const login of ["chatgpt-codex-connector", "chatgpt-codex-connector[bot]"]) {
    assert.equal(parseInbox(reply([node(1, { reactions: { nodes: [{ user: { login } }] } })]))!.pulls[0].codexThumbsUp, true);
  }
  assert.equal(parseInbox(reply([node(1, { reactions: { nodes: [{ user: { login: "nacho" } }] } })]))!.pulls[0].codexThumbsUp, false);
});

test("Codex's 👀 marks its review in progress", () => {
  const reviewing = (eyes: unknown) => parseInbox(reply([node(1, { eyes })]))!.pulls[0].codexReviewing;
  assert.equal(reviewing({ nodes: [{ user: { login: "chatgpt-codex-connector[bot]" } }] }), true);
  assert.equal(reviewing({ nodes: [{ user: { login: "nacho" } }] }), false);
  assert.equal(reviewing(undefined), false);
});

test("buckets list the most recently updated pull request first", () => {
  const at = (number: number, updatedAt: string, fields: Partial<Pull> = {}) => pull({ number, updatedAt, ...fields });
  const buckets = classify([at(1, "2026-09-01T00:00:00Z"), at(2, "2026-09-03T00:00:00Z"), at(3, "2026-09-02T00:00:00Z"), at(4, "2026-09-04T00:00:00Z", { isDraft: true })]);
  assert.deepEqual(buckets.ready.map((p) => p.number), [2, 3, 1]);
  assert.deepEqual(buckets.drafts.map((p) => p.number), [4]);
  assert.deepEqual(buckets.failing, []);
});

test("the updated label counts whole minutes, then whole hours", () => {
  const now = 10_000_000;
  assert.equal(updatedLabel(undefined, now), undefined);
  assert.equal(updatedLabel(now - 59_000, now), "Updated just now");
  assert.equal(updatedLabel(now - 60_000, now), "Updated 1m ago");
  assert.equal(updatedLabel(now - 3_599_000, now), "Updated 59m ago");
  assert.equal(updatedLabel(now - 7_300_000, now), "Updated 2h ago");
});

test("gh failures become messages the user can act on", () => {
  const run = (fields: object) => ({ result: { exit: 1, stdout: "", stderr: "", truncated: false, timedOut: false, ...fields } });
  assert.equal(processError(run({ exit: 0, stderr: "warning" })), undefined);
  assert.equal(processError({ error: { code: -32003, message: "command not found: gh" } }), SIGN_IN);
  assert.equal(processError({ error: { code: -32003, message: "too many processes" } }), "too many processes");
  assert.equal(processError(run({ exit: 4, stderr: "To get started with GitHub CLI, please run:  gh auth login\n" })), SIGN_IN);
  assert.equal(processError(run({ stderr: "error parsing \"owner\" value: none of the git remotes configured for this repository point to a known GitHub host." })), NO_REMOTE);
  assert.equal(processError(run({ stderr: "error parsing \"owner\" value: no git remotes found" })), NO_REMOTE);
  assert.equal(processError(run({ stderr: "\n  GraphQL: Pull request is not mergeable  \nmore" })), "GraphQL: Pull request is not mergeable");
  assert.equal(processError(run({ exit: 2 })), "gh exited with 2.");
  assert.equal(processError(run({ exit: 143, timedOut: true })), "gh timed out.");
});

test("recently merged pull requests sort by merge time, skipping malformed and repeated ones", () => {
  const inbox = parseInbox(reply([], [
    mergedNode(1, "2026-09-01T00:00:00Z"),
    mergedNode(2, "2026-09-03T00:00:00Z", { author: null }),
    mergedNode(3, "2026-09-02T00:00:00Z"),
    mergedNode(4, "2026-09-04T00:00:00Z", { url: "javascript:alert(1)" }),
    mergedNode(5, null as any),
    mergedNode(2, "2026-09-05T00:00:00Z"),
  ]));
  assert.deepEqual(inbox?.merged.map((m) => m.number), [2, 3, 1]);
  assert.deepEqual(inbox?.merged[0], { number: 2, title: "PR 2", url: "https://github.com/o/r/pull/2", author: "ghost", branch: "nacho/pr-2", mergedAt: "2026-09-03T00:00:00Z" });
  assert.deepEqual(parseInbox(reply([node(1)]))?.merged, []);
});

test("the ago label counts minutes, hours, then days", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  assert.equal(agoLabel("2026-10-08T11:59:30Z", now), "just now");
  assert.equal(agoLabel("2026-10-08T12:00:30Z", now), "just now");
  assert.equal(agoLabel("2026-10-08T11:55:00Z", now), "5m ago");
  assert.equal(agoLabel("2026-10-08T09:00:00Z", now), "3h ago");
  assert.equal(agoLabel("2026-10-05T11:00:00Z", now), "3d ago");
  assert.equal(agoLabel("yesterday", now), undefined);
});
