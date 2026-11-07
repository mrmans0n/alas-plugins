import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInbox, type Inbox } from "./inbox.ts";
import { node, reply } from "./inbox.test.ts";
import { MRStackAdapter } from "./stack-adapter.ts";
import { buildStacks, reviewKey } from "../../../shared/inbox-stacks.ts";
import { ProcessQueue } from "./doctor-transport.ts";

const host = "gitlab.example.com", repo = "acme/shop";
const outcome = (value: unknown) => ({ result: { exit: 0, stdout: JSON.stringify(value), stderr: "", truncated: false, timedOut: false } });
const metadata = (nodes: any[], more = false, cursor: string | null = null) => ({ data: { project: { fullPath: repo, mergeRequests: { nodes: nodes.map(n => ({ iid: n.iid, blockingMergeRequests: { totalCount: 0, hiddenCount: 0, visibleMergeRequests: [] } })), pageInfo: { hasNextPage: more, endCursor: cursor } } } } });
function fixture() {
  const calls: any[] = [], pending: any[] = [];
  let inbox: Inbox | undefined;
  const adapter = new MRStackAdapter({ run(id, wt, args, done) { const c = { id, wt, args, done }; calls.push(c); pending.push(c); } }, "main", i => { inbox = i; }, () => true);
  const answer = (value: any) => { const c = pending.shift(); assert.ok(c); c.done(outcome(value)); return c; };
  return { adapter, calls, pending, answer, get inbox() { return inbox; } };
}
test("MR inventory pins source and target project, explicit state and cursor completeness", () => {
  const raw = JSON.parse(reply([node(1, { sourceProject: { fullPath: "fork/shop" }, autoMergeEnabled: true })]));
  const inbox = parseInbox(JSON.stringify(raw)) as Inbox;
  assert.equal(inbox.complete, true);
  assert.equal(inbox.reviews?.[0].sourceRepo, "fork/shop");
  assert.equal(inbox.reviews?.[0].identity.repo, repo);
  assert.equal(inbox.reviews?.[0].queued, true);
  raw.data.project.mergeRequests.pageInfo = { hasNextPage: true, endCursor: "next" };
  assert.equal((parseInbox(JSON.stringify(raw)) as Inbox).cursor, "next");
});
test("unsupported or hidden dependency data preserves the inbox and marks uncertainty", () => {
  const f = fixture(); let snapshot: any;
  f.adapter.refresh([], s => { snapshot = s; });
  f.answer(JSON.parse(reply([node(1), node(2, { targetBranch: "nacho/mr-1" })])));
  f.answer({ errors: [{ message: "Unknown field blockingMergeRequests" }] });
  assert.equal(f.inbox?.mrs.length, 2);
  assert.equal(snapshot.complete, true, "primary inventory remains usable");
  assert.equal(snapshot.reviews[0].blockersComplete, false);
  assert.equal(buildStacks(snapshot.reviews, snapshot).components[0].complete, false);
  assert.match(snapshot.error, /dependenc/i);
});
test("closed and cross-project blockers remain explicit read-only context", () => {
  const f = fixture(); let snapshot: any;
  f.adapter.refresh([], s => { snapshot = s; }); f.answer(JSON.parse(reply([node(2)])));
  const blocker = node(1, { state: "closed", targetProject: { fullPath: "other/shop" }, sourceProject: { fullPath: "other/shop" }, webUrl: `https://${host}/other/shop/-/merge_requests/1` });
  const m: any = metadata([node(2)]); m.data.project.mergeRequests.nodes[0].blockingMergeRequests = { totalCount: 1, hiddenCount: 0, visibleMergeRequests: [blocker] };
  f.answer(m);
  // Resolve the explicit blocker itself, including its own dependencies.
  f.answer({ data: { project: { mergeRequest: { ...blocker, blockingMergeRequests: { totalCount: 0, hiddenCount: 0, visibleMergeRequests: [] } } } } });
  const graph = buildStacks(snapshot.reviews, snapshot);
  assert.equal(graph.components[0].complete, false);
  assert.ok(graph.components[0].members.some((r: any) => r.state === "closed"));
  assert.match(graph.components[0].issues.join(" "), /another project/);
});
test("queued train acceptance is not a merged state and every write pins host and head", () => {
  const f = fixture(); let snapshot: any;
  f.adapter.refresh([], s => { snapshot = s; });
  const nodes = [node(1), node(2, { targetBranch: "nacho/mr-1" })];
  f.answer(JSON.parse(reply(nodes, { trains: [{ targetBranch: "main", cars: { nodes: [{ status: "IDLE", mergeRequest: { iid: "1" }, pipeline: null }] } }] })));
  f.answer(metadata(nodes));
  const root = snapshot.reviews.find((r: any) => r.identity.number === 1);
  assert.equal(root.state, "open"); assert.equal(root.queued, true);
  f.adapter.submit(snapshot.reviews[1], () => {});
  assert.deepEqual(f.pending[0].args, ["projects/acme%2Fshop/merge_trains/merge_requests/2", "--hostname", host, "-f", `sha=${"a".repeat(40)}`]);
});
test("late refresh requests receive a batch begun after they arrive", () => {
  const f = fixture(); let first = false, second = false;
  f.adapter.refresh([], () => { first = true; }); f.adapter.refresh([], () => { second = true; });
  f.answer(JSON.parse(reply([node(1)]))); f.answer(metadata([node(1)]));
  assert.equal(first, true); assert.equal(second, false);
  assert.equal(f.pending[0].id, "list");
  f.answer(JSON.parse(reply([node(1)]))); f.answer(metadata([node(1)]));
  assert.equal(second, true);
});
test("missing required native or frozen members are fetched by qualified identity", () => {
  const f = fixture(); let snapshot: any;
  f.adapter.refresh([{ host, repo, number: 1 }], s => { snapshot = s; });
  f.answer(JSON.parse(reply([node(2)]))); f.answer(metadata([node(2)]));
  assert.ok(f.pending[0].args.includes("iid=1"));
  f.answer({ data: { project: { mergeRequest: { ...node(1), state: "merged", blockingMergeRequests: { totalCount: 0, hiddenCount: 0, visibleMergeRequests: [] } } } } });
  assert.equal(snapshot.reviews.find((r: any) => reviewKey(r.identity) === `${host}|${repo}#1`).state, "merged");
});

test("failed dependency refresh retains previously known explicit stack membership", () => {
  const f = fixture(); let snapshot: any;
  const nodes = [node(1), node(2)];
  const m: any = metadata(nodes); m.data.project.mergeRequests.nodes[1].blockingMergeRequests = { totalCount: 1, hiddenCount: 0, visibleMergeRequests: [{ iid: "1", targetProject: { fullPath: repo } }] };
  f.adapter.refresh([], () => {}); f.answer(JSON.parse(reply(nodes))); f.answer(m);
  f.adapter.refresh([], s => { snapshot = s; }); f.answer(JSON.parse(reply(nodes))); f.answer({ errors: [{ message: "unavailable" }] });
  const graph = buildStacks(snapshot.reviews, snapshot);
  assert.ok(graph.byReview[`${host}|${repo}#2`]);
  assert.equal(graph.components[0].complete, false);
});

test("hidden blockers remain incomplete without inventing identities", () => {
  const f = fixture(); let snapshot: any;
  f.adapter.refresh([], s => { snapshot = s; }); f.answer(JSON.parse(reply([node(1)])));
  const m: any = metadata([node(1)]); m.data.project.mergeRequests.nodes[0].blockingMergeRequests = { totalCount: 1, hiddenCount: 1, visibleMergeRequests: [] }; f.answer(m);
  assert.equal(snapshot.reviews[0].blockersComplete, false);
  assert.deepEqual(snapshot.reviews[0].blockers, []);
  assert.match(snapshot.error, /hidden/);
});

test("inventory and metadata pagination reach 500 and explicitly refuse a 501st page", () => {
  for (const more of [false, true]) {
    const f = fixture(); let snapshot: any;
    f.adapter.refresh([], s => { snapshot = s; });
    const pages = Array.from({ length: 10 }, (_, i) => Array.from({ length: 50 }, (_, j) => node(i * 50 + j + 1)));
    for (let i = 0; i < 10; i++) {
      const raw = JSON.parse(reply(pages[i])); raw.data.project.mergeRequests.pageInfo = { hasNextPage: i < 9 || more, endCursor: `c${i}` }; f.answer(raw);
    }
    if (!more) for (let i = 0; i < 10; i++) f.answer(metadata(pages[i], i < 9, `d${i}`));
    assert.equal(snapshot.reviews.length, 500);
    assert.equal(snapshot.complete, !more);
    assert.equal(f.pending.length, 0);
    if (more) assert.match(snapshot.error, /500/);
  }
});

test("a failed later page retains known data with complete false", () => {
  const f = fixture(); let snapshot: any;
  f.adapter.refresh([], s => { snapshot = s; });
  const raw = JSON.parse(reply([node(1)])); raw.data.project.mergeRequests.pageInfo = { hasNextPage: true, endCursor: "next" }; f.answer(raw);
  f.pending.shift().done({ result: { exit: 1, stdout: "", stderr: "Network unavailable" } });
  assert.equal(snapshot.complete, false); assert.equal(snapshot.reviews.length, 1);
});

test("Stop during retarget preflight starts no edit and queued cancellation settles once", () => {
  const f = fixture(); let snapshot: any, settled = 0;
  f.adapter.refresh([], s => { snapshot = s; }); f.answer(JSON.parse(reply([node(1)]))); f.answer(metadata([node(1)]));
  f.adapter.retarget(snapshot.reviews[0], "main", () => { settled++; });
  f.adapter.cancelPendingWrites(); f.answer(JSON.parse(reply([node(1)]))); f.answer(metadata([node(1)]));
  assert.equal(settled, 1); assert.equal(f.pending.length, 0);
  const spawned: any[] = [], queue = new ProcessQueue((id, wt, args, done) => { spawned.push({ id, done }); });
  queue.run("ci-api", "main", ["one"], () => {}); queue.run("ci-api", "main", ["two"], () => {});
  const adapter = new MRStackAdapter(queue, "main", () => {}, () => true);
  settled = 0; adapter.submit(snapshot.reviews[0], () => { settled++; });
  adapter.cancelPendingWrites(); assert.equal(settled, 1);
  spawned[0].done(outcome({})); assert.equal(spawned.length, 2); assert.equal(settled, 1);
  adapter.submit(snapshot.reviews[0], () => { settled++; });
  assert.equal(spawned.at(-1).id, "add"); adapter.dispose(); assert.equal(settled, 1, "started process keeps ownership until settlement");
  spawned.at(-1).done(outcome({})); assert.equal(settled, 2);
});
