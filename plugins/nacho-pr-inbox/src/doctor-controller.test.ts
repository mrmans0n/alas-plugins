import { test } from "node:test";
import assert from "node:assert/strict";
import { DoctorController } from "./doctor-controller.ts";
import { GitHub, ProcessQueue } from "./doctor-transport.ts";
import type { Outcome, ProcessResult, Snapshot } from "@alas/plugin";

const sha = "a".repeat(40), base = "b".repeat(40);
const pull = (number = 3) => ({ number, title: "Change", url: `https://github.com/o/r/pull/${number}`, branch: "feature", identity: { sha, repo: "o/r", branch: "feature", baseSha: base, baseBranch: "main" } });
const identity = (s = sha) => ({ head: { sha: s, ref: "feature", repo: { full_name: "o/r" } }, base: { sha: base, ref: "main" } });
const run = (attempt = 1) => ({ id: 10, workflow_id: 2, name: "CI", run_attempt: attempt, head_sha: sha, head_branch: "feature", event: "pull_request", status: "completed", conclusion: "failure", created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T01:00:00Z", html_url: "https://github.com/o/r/actions/runs/10", pull_requests: [{ number: 3 }], head_repository: { full_name: "o/r" } });
const jobs = { total_count: 1, jobs: [{ id: 20, run_id: 10, run_attempt: 1, name: "Tests", status: "completed", conclusion: "failure", html_url: "https://github.com/o/r/actions/runs/10/job/20", steps: [{ number: 1, name: "Test", status: "completed", conclusion: "failure" }] }] };
function setup() {
  const pending: { id: string; wt: string; args: string[]; done: (o: Outcome<ProcessResult>) => void }[] = [];
  const snapshots: ((s: Snapshot) => void)[] = [];
  const sends: { id: string; text: string; done: (error?: string) => void }[] = [];
  const queue = new ProcessQueue((id, wt, args, done) => pending.push({ id, wt, args, done }));
  const github = new GitHub(queue, "main", Date.now, () => {});
  const c = new DoctorController(github, queue, { changed() {}, save() {}, snapshot(cb) { snapshots.push(cb); }, send(id, text, done) { sends.push({ id, text, done }); }, now: Date.now });
  const reply = (data: unknown, id?: string) => {
    const index = id ? pending.findIndex(p => p.id === id) : 0;
    assert.ok(index >= 0, `missing request ${id}`);
    const p = pending.splice(index, 1)[0];
    p.done({ result: { exit: 0, stdout: typeof data === "string" ? data : JSON.stringify(data), stderr: "", truncated: false, timedOut: false } });
    return p;
  };
  const load = () => { c.open("o/r", pull()); reply(identity()); reply({ total_count: 1, workflow_runs: [run()] }); reply(run()); reply(jobs); };
  const snap: Snapshot = { worktrees: [{ id: "wt", branch: "feature", current: true, sessions: [{ id: "s", title: "Agent", agent: "codex", state: "idle" }] }] };
  return { c, pending, snapshots, sends, reply, load, snap };
}
test("late responses from another PR cannot replace current details", () => {
  const h = setup();
  h.c.open("o/r", pull(3));
  h.c.open("o/r", pull(4));
  h.reply(identity());
  assert.equal(h.pending.length, 1);
  h.reply(identity());
  assert.equal(h.c.state.evidence?.number, 4);
  assert.equal(h.c.state.evidence?.runs.length, 0);
});
test("new heads make retained evidence historical and invalidate investigation preview", () => {
  const h = setup(); h.load();
  h.c.prepare(20);
  assert.ok(h.c.state.dispatch);
  h.c.updateInbox("o/r", [{ ...pull(), identity: { ...pull().identity, sha: "c".repeat(40) } }]);
  assert.equal(h.c.state.historical, true);
  assert.equal(h.c.state.dispatch, undefined);
  assert.equal(h.c.state.evidence?.head.sha, sha);
});
test("dispatch verifies exact worktree and queues the reviewed brief once", () => {
  const h = setup(); h.load();
  h.c.prepare(20); h.c.selectSession("s");
  h.snapshots.shift()!(h.snap);
  const remote = h.reply("origin\tgit@github.com:o/r.git (fetch)", "ci-remotes");
  assert.equal(remote.wt, "wt");
  h.reply(sha + "\n", "ci-head");
  assert.equal(h.c.state.dispatch?.verification?.sha, sha);
  h.c.send(); h.c.send();
  assert.equal(h.snapshots.length, 1);
  h.snapshots.shift()!(h.snap);
  h.reply("origin\tgit@github.com:o/r.git (fetch)", "ci-remotes");
  h.reply(sha + "\n", "ci-head");
  h.reply(identity()); h.reply(run());
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].id, "s");
  assert.match(h.sends[0].text, /Verified worktree wt/);
  h.sends[0].done();
  h.c.send();
  assert.equal(h.sends.length, 1);
  assert.equal(h.c.state.dispatch?.phase, "sent");
});
test("fork collisions, checkout movement and removed sessions stop dispatch", () => {
  for (const scenario of ["fork", "sha", "removed", "rerun"]) {
    const h = setup(); h.load(); h.c.prepare(20); h.c.selectSession("s");
    h.snapshots.shift()!(h.snap);
    h.reply(`origin\tgit@github.com:${scenario === "fork" ? "stranger/r" : "o/r"}.git (fetch)`, "ci-remotes");
    if (scenario === "fork") { assert.match(h.c.state.dispatch?.error ?? "", /repository/i); continue; }
    h.reply(sha, "ci-head"); h.c.send();
    h.snapshots.shift()!(scenario === "removed" ? { worktrees: [] } : h.snap);
    if (scenario === "removed") { assert.match(h.c.state.dispatch?.error ?? "", /session/i); continue; }
    h.reply("origin\tgit@github.com:o/r.git (fetch)", "ci-remotes");
    h.reply(scenario === "sha" ? base : sha, "ci-head");
    if (scenario === "sha") { assert.match(h.c.state.dispatch?.error ?? "", /changed|checkout/i); continue; }
    h.reply(identity()); h.reply(run(2));
    assert.equal(h.sends.length, 0);
    assert.match(h.c.state.dispatch?.error ?? "", /rerun|attempt/i);
  }
});
test("terminal-only host refusal retains a copyable brief without retrying", () => {
  const h = setup(); h.load(); h.c.prepare(20); h.c.selectSession("s"); h.snapshots.shift()!(h.snap);
  h.reply("origin\tgit@github.com:o/r.git (fetch)", "ci-remotes"); h.reply(sha, "ci-head");
  h.c.send(); h.snapshots.shift()!(h.snap); h.reply("origin\tgit@github.com:o/r.git (fetch)", "ci-remotes"); h.reply(sha, "ci-head"); h.reply(identity()); h.reply(run());
  h.sends[0].done("unknown session s");
  h.c.send();
  assert.equal(h.sends.length, 1);
  assert.match(h.c.state.dispatch?.error ?? "", /terminal|live chat/i);
  assert.ok(h.c.state.dispatch?.text.includes("PR Inbox CI Doctor"));
});
test("late cache restore never overwrites evidence fetched this instance", () => {
  const h = setup(); h.load();
  const e = h.c.state.evidence!;
  h.c.restore({ version: 1, entries: [{ ...e, fetchedAt: 1, runs: [] }] });
  assert.equal(h.c.state.evidence?.runs.length, 1);
});

test("a host refusal requires a new prepared brief before another session can be sent", () => {
  const h = setup(); h.load(); h.c.prepare(20); h.c.selectSession("s"); h.snapshots.shift()!(h.snap);
  h.reply("origin\tgit@github.com:o/r.git (fetch)", "ci-remotes"); h.reply(sha, "ci-head");
  h.c.send(); h.snapshots.shift()!(h.snap); h.reply("origin\tgit@github.com:o/r.git (fetch)", "ci-remotes"); h.reply(sha, "ci-head"); h.reply(identity()); h.reply(run());
  h.sends[0].done("unknown session s");
  h.c.selectSession("s");
  assert.equal(h.snapshots.length, 0, "a failed dispatch cannot be retried by changing selection");
  assert.equal(h.c.state.dispatch?.phase, "failed");
});

test("newer session ownership during GitHub verification cancels the prepared send", () => {
  for (const removed of [false, true]) {
    const h = setup(); h.load(); h.c.updateSnapshot(h.snap); h.c.prepare(20); h.c.selectSession("s"); h.snapshots.shift()!(h.snap);
    h.reply("origin\tgit@github.com:o/r.git (fetch)", "ci-remotes"); h.reply(sha, "ci-head");
    h.c.send(); h.snapshots.shift()!(h.snap); h.reply("origin\tgit@github.com:o/r.git (fetch)", "ci-remotes"); h.reply(sha, "ci-head");
    h.c.updateSnapshot(removed ? { worktrees: [] } : { worktrees: [{ ...h.snap.worktrees[0], id: "another-worktree" }] });
    h.reply(identity());
    // Cancelled verification must not enqueue its follow-up run lookup or a send.
    assert.equal(h.pending.length, 0);
    assert.equal(h.sends.length, 0);
    assert.match(h.c.state.dispatch?.error ?? "", /ownership|worktree|session/i);
  }
});

test("an old snapshot response cannot restore a session whose newer snapshot removed it", () => {
  const h = setup(); h.load(); h.c.updateSnapshot(h.snap); h.c.prepare(20); h.c.selectSession("s");
  h.c.updateSnapshot({ worktrees: [] });
  h.snapshots.shift()!(h.snap);
  assert.equal(h.pending.length, 0);
  assert.equal(h.c.state.dispatch?.verification, undefined);
  assert.match(h.c.state.dispatch?.error ?? "", /session|workspace/i);
});

test("failed live job refresh preserves accessible cached jobs with explicit stale identity", () => {
  const h = setup(); h.load();
  assert.equal(h.c.currentAttempt()?.jobs.length, 1);
  h.c.refresh(); h.reply(identity());
  const reject = () => h.pending.shift()!.done({ result: { exit: 1, stdout: "", stderr: "network unavailable", truncated: false, timedOut: false } });
  reject(); // run summaries fall back to cache
  h.reply(run()); // attempt metadata is available
  reject(); // attempt jobs unavailable
  assert.equal(h.c.currentAttempt()?.jobs.length, 1);
  assert.equal(h.c.currentAttempt()?.complete, false);
  assert.deepEqual(h.c.currentAttempt()?.cachedJobs, [20]);
  assert.match(h.c.currentAttempt()?.error ?? "", /network|cached/i);
});

test("partial live and cached job union stays within one hundred jobs", () => {
  const h = setup(); h.load(); h.c.refresh(); h.reply(identity());
  h.pending.shift()!.done({ result: { exit: 1, stdout: "", stderr: "network unavailable", truncated: false, timedOut: false } });
  h.reply(run());
  for (let page = 0; page < 4; page++) h.reply({ total_count: 101, jobs: Array.from({ length: 25 }, (_, i) => ({ ...jobs.jobs[0], id: 21 + page * 25 + i })) });
  assert.equal(h.c.currentAttempt()?.jobs.length, 100);
  assert.match(h.c.currentAttempt()?.error ?? "", /cached jobs omitted/i);
});
