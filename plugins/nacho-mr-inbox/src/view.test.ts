import { test } from "node:test";
import assert from "node:assert/strict";
import type { Inbox, MergeRequest, Train } from "./inbox.ts";
import { chips, inboxModel, readyMine, type ViewState } from "./view.ts";

const WEB = "https://gitlab.example.com/acme/shop";
const mr = (iid: number, fields: Partial<MergeRequest> = {}): MergeRequest => ({
  iid, title: `MR ${iid}`, url: `${WEB}/-/merge_requests/${iid}`, draft: false, author: "nacho", branch: `b${iid}`, target: "main", sha: "a".repeat(40),
  updatedAt: `2026-10-${String(10 + iid).padStart(2, "0")}T00:00:00Z`, status: "MERGEABLE", conflicts: false, approvalsLeft: 0, approvalsRequired: 1,
  changesRequestedBy: [], unresolved: 0, pipeline: { id: 100 + iid, status: "SUCCESS", sha: "a".repeat(40), progress: { done: 3, running: 0, total: 3 } }, ...fields,
});
const inbox = (mrs: MergeRequest[], trains: Train[] = []): Inbox => ({ project: "acme/shop", webUrl: WEB, host: "gitlab.example.com", user: "nacho", mrs, trains, merged: [] });
const NOW = Date.parse("2026-10-22T00:00:00Z");
const model = (fields: Partial<ViewState>) => inboxModel({ refreshing: false, errors: {}, ...fields }, NOW);
const texts = (m: MergeRequest) => chips(m).map((c) => `${c.tone}:${c.text}`);

test("sections come in order, skip empty ones, and count", () => {
  const m = model({ inbox: inbox([mr(1, { draft: true }), mr(2, { status: "NOT_APPROVED", approvalsLeft: 1 }), mr(3), mr(4, { pipeline: { id: 4, status: "FAILED", sha: "", progress: null } })]) });
  assert.deepEqual(m.sections.map((s) => [s.key, s.title, s.tone, s.rows.map((r) => r.iid)]), [
    ["ready", "Ready", "success", [3]], ["blocked", "Blocked", "warn", [2]], ["failing", "Failing", "danger", [4]], ["drafts", "Drafts", "dim", [1]],
  ]);
  assert.deepEqual(m.counts, { ready: 1, blocked: 1, failing: 1, drafts: 1 });
});

test("chips say why an MR is blocked", () => {
  assert.deepEqual(texts(mr(1, { status: "REQUESTED_CHANGES", changesRequestedBy: ["ana", "bob"] })), ["success:✓ pipeline", "danger:changes requested · @ana, @bob", "success:✓ approved"]);
  assert.deepEqual(texts(mr(1, { status: "REQUESTED_CHANGES" })), ["success:✓ pipeline", "danger:changes requested", "success:✓ approved"]);
  assert.deepEqual(texts(mr(1, { status: "DISCUSSIONS_NOT_RESOLVED", unresolved: 3 })), ["success:✓ pipeline", "warn:💬 3 unresolved", "success:✓ approved"]);
  assert.deepEqual(texts(mr(1, { status: "NOT_APPROVED", approvalsLeft: 2, approvalsRequired: 2 })), ["success:✓ pipeline", "warn:needs 2 approvals"]);
  assert.deepEqual(texts(mr(1, { status: "CONFLICT", conflicts: true, approvalsRequired: 0 })), ["success:✓ pipeline", "warn:conflicts"]);
  assert.deepEqual(texts(mr(1, { status: "NEED_REBASE", approvalsRequired: 0 })), ["success:✓ pipeline", "warn:needs rebase"]);
  assert.deepEqual(texts(mr(1, { status: "JIRA_ASSOCIATION_MISSING", approvalsRequired: 0 })), ["success:✓ pipeline", "warn:jira association missing"]);
  assert.deepEqual(texts(mr(1, { status: "CHECKING", approvalsRequired: 0 })), ["success:✓ pipeline", "dim:checking…"]);
  assert.deepEqual(texts(mr(1, { status: "CI_MUST_PASS", pipeline: null, approvalsRequired: 0 })), ["warn:no pipeline"]);
  assert.deepEqual(texts(mr(1, { pipeline: { id: 1, status: "FAILED", sha: "", progress: null }, approvalsRequired: 0 })), ["danger:✗ pipeline"]);
  assert.deepEqual(texts(mr(1, { status: "CI_STILL_RUNNING", pipeline: { id: 1, status: "RUNNING", sha: "", progress: { done: 1, running: 1, total: 4 } }, approvalsRequired: 0 })), [], "the progress bar says it");
});

test("a blocked MR is never left unexplained", () => {
  assert.deepEqual(texts(mr(1, { status: "NOT_APPROVED", approvalsLeft: 0, approvalsRequired: 1 })), ["success:✓ pipeline", "warn:not approved"]);
  assert.deepEqual(texts(mr(1, { status: "DISCUSSIONS_NOT_RESOLVED", unresolved: 0, approvalsRequired: 0 })), ["success:✓ pipeline", "warn:discussions not resolved"]);
  assert.deepEqual(texts(mr(1, { status: "CONFLICT", conflicts: false, approvalsRequired: 0 })), ["success:✓ pipeline", "warn:conflict"]);
  assert.deepEqual(texts(mr(1, { status: "CI_MUST_PASS", approvalsRequired: 0, pipeline: { id: 1, status: "PENDING", sha: "", progress: null } })), ["dim:pipeline pending"]);
  assert.deepEqual(texts(mr(1, { status: "CI_MUST_PASS", approvalsRequired: 0, pipeline: { id: 1, status: "SKIPPED", sha: "", progress: null } })), ["warn:ci must pass"]);
  assert.deepEqual(texts(mr(1, { status: "SOMETHING_NEW", approvalsRequired: 0 })), ["success:✓ pipeline", "warn:something new"]);
});

test("ready rows add to the train; running ones add when green; trains off means merge when green", () => {
  const ready = model({ inbox: inbox([mr(1)]) }).sections[0].rows[0];
  assert.deepEqual(ready.add, { when: "now", look: "go", label: "🚂 Add to train", short: "Add", disabled: false, busy: false });
  const running = model({ inbox: inbox([mr(2, { status: "CI_STILL_RUNNING", pipeline: { id: 2, status: "RUNNING", sha: "", progress: { done: 1, running: 1, total: 4 } } })]) }).sections[0].rows[0];
  assert.deepEqual(running.add, { when: "whenGreen", look: "plain", label: "🚂 Add when green", short: "When green", disabled: false, busy: false });
  assert.deepEqual(running.progress, { done: 1, running: 1, total: 4, failed: false });
  const off = model({ inbox: inbox([mr(1)]), trainsEnabled: false }).sections[0].rows[0];
  assert.equal(off.add?.label, "Merge when green");
  assert.equal(model({ inbox: inbox([mr(1, { status: "NOT_APPROVED" })]) }).sections[0].rows[0].add, undefined);
});

test("while one write runs, every add is disabled and the busy one shows it", () => {
  const rows = model({ inbox: inbox([mr(1), mr(2)]), busy: 2, errors: { 1: "Not mergeable" } }).sections[0].rows;
  const by = Object.fromEntries(rows.map((r) => [r.iid, r]));
  assert.equal(by[2].add?.busy, true);
  assert.equal(by[1].add?.disabled, true);
  assert.equal(by[1].error, "Not mergeable");
});

test("failing rows offer retry of the head pipeline and CI Doctor", () => {
  const row = model({ inbox: inbox([mr(1, { pipeline: { id: 77, status: "FAILED", sha: "", progress: null } })]), retrying: 77 }).sections[0].rows[0];
  assert.deepEqual(row.retry, { pipeline: 77, busy: true, disabled: true });
  assert.equal(row.doctor, true);
  assert.equal(model({ inbox: inbox([mr(1, { pipeline: null })]) }).sections[0].rows[0].doctor, false);
});

test("train strip: cars in order with status, yours marked, MRs in a train leave the groups", () => {
  const trains: Train[] = [{ target: "main", cars: [
    { iid: 7, status: "MERGING", pipeline: { status: "SUCCESS", progress: null } },
    { iid: 8, status: "FRESH", pipeline: { status: "RUNNING", progress: { done: 14, running: 2, total: 22 } } },
    { iid: 9, status: "FRESH", pipeline: { status: "FAILED", progress: null } },
    { iid: 10, status: "STALE", pipeline: { status: "RUNNING", progress: null } },
    { iid: 11, status: "IDLE", pipeline: null },
  ] }];
  const m = model({ inbox: inbox([mr(7, { author: "ana" }), mr(8), mr(9, { author: "bob" }), mr(10, { author: "bob" }), mr(3)], trains) });
  assert.deepEqual(m.trains[0].cars.map((c) => [c.iid, c.label, c.tone, c.mine]), [
    [7, "merging ✓", "success", false], [8, "⏳ 14/22", "warn", true], [9, "failed", "danger", false], [10, "restarting", "dim", false], [11, "queued", "dim", false],
  ]);
  assert.equal(m.trains[0].cars[4].url, undefined, "a car whose MR is not in the list has no link");
  assert.deepEqual(m.sections.flatMap((s) => s.rows.map((r) => r.iid)), [3]);
  assert.equal(m.trainsEnabled, true);
});

test("Yours lists your MRs outside the train, newest first, and the badge counts your ready ones", () => {
  const state: Partial<ViewState> = { inbox: inbox([mr(1), mr(2, { author: "ana" }), mr(3, { status: "NOT_APPROVED" }), mr(4)], [{ target: "main", cars: [{ iid: 4, status: "IDLE", pipeline: null }] }]) };
  assert.deepEqual(model(state).mine.map((r) => [r.iid, r.mine]), [[3, true], [1, true]]);
  assert.equal(readyMine({ refreshing: false, errors: {}, ...state }), 1);
});

test("Add all: offered from two ready, with progress while it runs", () => {
  assert.equal(model({ inbox: inbox([mr(1)]) }).addAll, undefined);
  assert.deepEqual(model({ inbox: inbox([mr(1), mr(2)]) }).addAll, { count: 2, label: "🚂 Add all 2 to train", disabled: false });
  assert.deepEqual(model({ inbox: inbox([mr(1), mr(2)]), busy: 1, addAll: { total: 2, done: 0 } }).addAll, { count: 2, label: "🚂 Add all 2 to train", disabled: true, progress: "Adding 1 of 2…" });
  assert.equal(model({ inbox: inbox([mr(1), mr(2)]), trainsEnabled: false }).addAll?.label, "Merge all 2 when green");
});

test("loading, errors and merged rows", () => {
  assert.equal(model({}).loading, true);
  assert.equal(model({ error: "x" }).loading, false);
  const merged = model({ inbox: { ...inbox([]), merged: [{ iid: 5, title: "M", url: `${WEB}/-/merge_requests/5`, author: "bob", branch: "b", mergedAt: "2026-10-21T12:00:00Z" }] } }).merged;
  assert.deepEqual(merged.map((m) => m.iid), [5]);
});
