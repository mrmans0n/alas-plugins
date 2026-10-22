import { test } from "node:test";
import assert from "node:assert/strict";
import { addMode, agoLabel, bucketOf, classify, NO_GLAB, NO_REMOTE, parseInbox, parseTrainsEnabled, processError, SIGN_IN, updatedLabel, type Inbox } from "./inbox.ts";

const WEB = "https://gitlab.example.com/acme/shop";
const jobs = (total: number, done: number, running: number) => ({ jobs: { count: total }, done: { count: done }, running: { count: running } });
/** One open MR node as the manifest's query returns it. */
export const node = (iid: number, fields: object = {}) => ({
  iid: String(iid), title: `MR ${iid}`, webUrl: `${WEB}/-/merge_requests/${iid}`, draft: false, updatedAt: `2026-10-${String(10 + iid).padStart(2, "0")}T00:00:00Z`,
  author: { username: "nacho", avatarUrl: "https://secure.gravatar.com/avatar/abc?s=80&d=identicon" },
  sourceBranch: `nacho/mr-${iid}`, targetBranch: "main", diffHeadSha: "a".repeat(40), detailedMergeStatus: "MERGEABLE", conflicts: false,
  approvalsLeft: 0, approvalsRequired: 1, reviewers: { nodes: [{ username: "ana", mergeRequestInteraction: { reviewState: "APPROVED" } }] },
  resolvableDiscussionsCount: 2, resolvedDiscussionsCount: 2,
  headPipeline: { id: `gid://gitlab/Ci::Pipeline/${1000 + iid}`, status: "SUCCESS", sha: "a".repeat(40), ...jobs(4, 4, 0) },
  ...fields,
});
export const reply = (nodes: unknown[], extra: { trains?: unknown[]; merged?: unknown[]; user?: string } = {}) => JSON.stringify({ data: {
  currentUser: { username: extra.user ?? "nacho" },
  project: { fullPath: "acme/shop", webUrl: WEB, mergeTrains: { nodes: extra.trains ?? [] }, mergeRequests: { nodes }, merged: { nodes: extra.merged ?? [] } },
} });
const parsed = (nodes: unknown[], extra = {}) => parseInbox(reply(nodes, extra)) as Inbox;

test("parses MRs, skipping malformed, repeated and off-host ones", () => {
  const inbox = parsed([node(1), node(2, { author: null, headPipeline: null, reviewers: null }), node(3, { webUrl: "https://evil.example/x" }), node(4, { iid: "x" }), null, node(1, { title: "again" })]);
  assert.equal(inbox.project, "acme/shop");
  assert.equal(inbox.host, "gitlab.example.com");
  assert.equal(inbox.user, "nacho");
  assert.deepEqual(inbox.mrs.map((m) => m.iid), [1, 2]);
  assert.deepEqual(inbox.mrs[0], {
    iid: 1, title: "MR 1", url: `${WEB}/-/merge_requests/1`, draft: false, author: "nacho", avatar: "https://secure.gravatar.com/avatar/abc?s=80&d=identicon",
    branch: "nacho/mr-1", target: "main", sha: "a".repeat(40), updatedAt: "2026-10-11T00:00:00Z", status: "MERGEABLE", conflicts: false,
    approvalsLeft: 0, approvalsRequired: 1, changesRequestedBy: [], unresolved: 0,
    pipeline: { id: 1001, status: "SUCCESS", sha: "a".repeat(40), progress: { done: 4, running: 0, total: 4 } },
  });
  assert.equal(inbox.mrs[1].author, "ghost");
  assert.equal(inbox.mrs[1].pipeline, null);
});

test("only gitlab.com and Gravatar avatars pass", () => {
  const avatar = (avatarUrl: string) => parsed([node(1, { author: { username: "n", avatarUrl } })]).mrs[0].avatar;
  assert.equal(avatar("https://gitlab.com/uploads/-/system/user/avatar/1/avatar.png"), "https://gitlab.com/uploads/-/system/user/avatar/1/avatar.png");
  assert.equal(avatar("https://gitlab.example.com/uploads/-/system/user/avatar/1/a.png"), undefined);
  assert.equal(avatar("/uploads/-/system/user/avatar/1/a.png"), undefined);
  assert.equal(avatar("https://secure.gravatar.com.evil.example/avatar/x"), undefined);
});

test("reviewers asking for changes and unresolved threads are counted", () => {
  const mr = parsed([node(1, { reviewers: { nodes: [
    { username: "ana", mergeRequestInteraction: { reviewState: "REQUESTED_CHANGES" } },
    { username: "bob", mergeRequestInteraction: { reviewState: "APPROVED" } },
    { username: "eve", mergeRequestInteraction: null },
  ] }, resolvableDiscussionsCount: 5, resolvedDiscussionsCount: 2 })]).mrs[0];
  assert.deepEqual(mr.changesRequestedBy, ["ana"]);
  assert.equal(mr.unresolved, 3);
});

test("trains keep car order; cars without an iid are dropped", () => {
  const inbox = parsed([], { trains: [{ targetBranch: "main", cars: { nodes: [
    { status: "MERGING", mergeRequest: { iid: "7" }, pipeline: { status: "SUCCESS", ...jobs(3, 3, 0) } },
    { status: "FRESH", mergeRequest: { iid: "8" }, pipeline: { status: "RUNNING", ...jobs(10, 4, 2) } },
    { status: "IDLE", mergeRequest: null, pipeline: null },
    { status: "IDLE", mergeRequest: { iid: "9" }, pipeline: null },
  ] } }, { targetBranch: "release", cars: { nodes: [] } }] });
  assert.deepEqual(inbox.trains, [{ target: "main", cars: [
    { iid: 7, status: "MERGING", pipeline: { status: "SUCCESS", progress: { done: 3, running: 0, total: 3 } } },
    { iid: 8, status: "FRESH", pipeline: { status: "RUNNING", progress: { done: 4, running: 2, total: 10 } } },
    { iid: 9, status: "IDLE", pipeline: null },
  ] }], "an empty train is not kept");
});

test("merged MRs keep the query's merge order and drop repeats", () => {
  const m = (iid: number, mergedAt: string) => ({ iid: String(iid), title: `M${iid}`, webUrl: `${WEB}/-/merge_requests/${iid}`, sourceBranch: "b", mergedAt, author: { username: "bob" } });
  assert.deepEqual(parsed([], { merged: [m(5, "2026-10-21T10:00:00Z"), m(4, "2026-10-20T10:00:00Z"), m(5, "x")] }).merged.map((x) => x.iid), [5, 4]);
});

test("GraphQL errors and malformed replies become messages", () => {
  assert.equal(parseInbox(JSON.stringify({ errors: [{ message: "Field 'mergeTrains' doesn't exist on type 'Project'" }] })), "GitLab: Field 'mergeTrains' doesn't exist on type 'Project'");
  assert.equal(parseInbox(JSON.stringify({ data: { project: null } })), "GitLab returned no project. Check that glab can read it.");
  assert.equal(parseInbox("nope"), "glab returned an unexpected reply.");
});

test("buckets: drafts, failing, ready, blocked; train MRs are left out", () => {
  const inbox = parsed([node(1, { draft: true }), node(2, { headPipeline: { id: "gid://gitlab/Ci::Pipeline/2", status: "FAILED", sha: "a".repeat(40), ...jobs(2, 2, 0) } }), node(3), node(4, { detailedMergeStatus: "NOT_APPROVED" }), node(5)], { trains: [{ targetBranch: "main", cars: { nodes: [{ status: "IDLE", mergeRequest: { iid: "5" }, pipeline: null }] } }] });
  assert.deepEqual(inbox.mrs.map(bucketOf), ["drafts", "failing", "ready", "blocked", "ready"]);
  const groups = classify(inbox);
  assert.deepEqual(Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.map((m) => m.iid)])), { ready: [3], blocked: [4], failing: [2], drafts: [1] });
});

test("add mode: now when mergeable, when green while CI runs, never for drafts or failures", () => {
  const mr = (fields: object) => parsed([node(1, fields)]).mrs[0];
  assert.equal(addMode(mr({})), "now");
  assert.equal(addMode(mr({ detailedMergeStatus: "CI_STILL_RUNNING" })), "whenGreen");
  assert.equal(addMode(mr({ detailedMergeStatus: "NOT_APPROVED" })), undefined);
  assert.equal(addMode(mr({ draft: true })), undefined);
  assert.equal(addMode(mr({ detailedMergeStatus: "CI_STILL_RUNNING", headPipeline: { id: "gid://gitlab/Ci::Pipeline/2", status: "FAILED", sha: "a", ...jobs(1, 1, 0) } })), undefined);
});

test("merge_trains_enabled comes from the project reply", () => {
  assert.equal(parseTrainsEnabled('{"merge_trains_enabled":true}'), true);
  assert.equal(parseTrainsEnabled('{"merge_trains_enabled":false}'), false);
  assert.equal(parseTrainsEnabled("{}"), false, "a GitLab without the field has no trains");
  assert.equal(parseTrainsEnabled("x"), undefined);
});

test("glab failures become user messages", () => {
  const run = (stderr: string, exit = 1) => processError({ result: { exit, stdout: "", stderr, timedOut: false, truncated: false } } as any);
  assert.equal(run("", 0), undefined);
  assert.equal(run("\n   ERROR  \n\n  Unable to expand placeholder in path: none of the git remotes configured for this repository point to a known GitLab host. Please use `glab auth login`"), NO_REMOTE);
  assert.equal(run("fatal: not a git repository (or any of the parent directories): .git"), NO_REMOTE);
  assert.equal(run("\n ERROR \n GET https://gitlab.example.com/api/v4/projects/acme%2Fshop: 401 {message: 401 Unauthorized}"), SIGN_IN);
  assert.equal(run("\n   ERROR  \n\n  glab: 404 Not found (HTTP 404)"), "glab: 404 Not found (HTTP 404)");
  assert.equal(processError({ error: { code: 1, message: "sh: glab: command not found" } } as any), NO_GLAB);
  assert.equal(processError({ result: { exit: 0, stdout: "", stderr: "", timedOut: true, truncated: false } } as any), "glab timed out.");
});

test("time labels are unchanged from pr-inbox", () => {
  assert.equal(updatedLabel(0, 30_000), "Updated just now");
  assert.equal(agoLabel("1970-01-01T00:00:00Z", 7_200_000), "2h ago");
});
