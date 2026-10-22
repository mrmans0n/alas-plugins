import { test } from "node:test";
import assert from "node:assert/strict";
import { doctorModel } from "./doctor-view.ts";
import type { DoctorState } from "./doctor-controller.ts";

const sha = "a".repeat(40);
function state(): DoctorState {
  const run = { id: 10, workflow: 2, name: "CI", attempt: 2, sha, branch: "feature", event: "pull_request", status: "completed", conclusion: "success", created: "2026-10-16T00:00:00Z", updated: "2026-10-16T01:00:00Z", url: "https://github.com/o/r/actions/runs/10", prs: [3], headRepo: "o/r" };
  const job = { id: 20, run: 10, attempt: 1, name: "Test", status: "completed", conclusion: "failure", started: run.created, completed: run.updated, url: run.url + "/job/20", steps: [{ name: "Run tests", number: 3, status: "completed", conclusion: "failure" }] };
  return { target: { repo: "o/r", pull: { number: 3, title: "Change", branch: "feature", url: "https://github.com/o/r/pull/3" } }, evidence: { key: "o/r:3:" + sha, repo: "o/r", number: 3, title: "Change", url: "https://github.com/o/r/pull/3", head: { repo: "o/r", sha, branch: "feature", baseBranch: "main", baseSha: "b".repeat(40) }, fetchedAt: 100, since: "2026-10-02T00:00:00Z", until: run.created, runs: [run], attempts: [{ run: { ...run, attempt: 1, conclusion: "failure" }, jobs: [job], complete: false, error: "More jobs omitted" }], logs: { "20": { text: "```\n[click](https://evil.com)\nerror: failed", truncated: true } }, observations: [], coverage: ["Base history unavailable"] }, loading: false, historyLoading: false, cached: true, historical: true, selectedAttempt: "10:1", selectedJob: 20, snapshot: { worktrees: [] } };
}

test("details expose actual attempt, failed steps, bounded evidence and historical limitations", () => {
  const m = doctorModel(state());
  const content = JSON.stringify(m);
  assert.match(content, /historical/i);
  assert.match(content, /Cached/);
  assert.match(content, /Base history unavailable/);
  assert.match(content, /Bounded excerpt/);
  assert.deepEqual(m.jobs.map((j) => [j.id, j.failed, j.selected, j.steps]), [[20, true, true, ["Step 3: Run tests · failure"]]]);
  assert.equal(m.jobs[0].url, "https://github.com/o/r/actions/runs/10/job/20");
  assert.equal(m.attempt, "1");
  assert.deepEqual(m.attempts.map((a) => a.id), ["1", "2"]);
  assert.equal(m.evidence!.canPrepare, false, "historical evidence is not investigated");
});

test("logs stay literal text for the page", () => {
  assert.equal(doctorModel(state()).evidence!.excerpt, "```\n[click](https://evil.com)\nerror: failed");
});

test("without evidence there is only the reason", () => {
  const s = state();
  s.evidence = undefined;
  s.loading = true;
  assert.equal(doctorModel(s).unavailable, "Fetching PR identity…");
  s.loading = false;
  assert.match(doctorModel(s).unavailable!, /Evidence unavailable/);
});

test("a job with many failed steps lists five and says how many it left out", () => {
  const s = state();
  s.evidence!.attempts[0].jobs[0].steps = Array.from({ length: 40 }, (_, n) => ({ number: n + 1, name: `Failed step ${n}`, status: "completed", conclusion: "failure" }));
  const steps = doctorModel(s).jobs[0].steps;
  assert.equal(steps.length, 6);
  assert.match(steps[5], /35 failed steps omitted/);
});

test("classification stays pending until comparison failure logs finish", () => {
  const s = state(); s.historyLoading = true; s.evidence!.coverage = [];
  s.evidence!.logs["20"].signature = "test:Core.testOrdering";
  const attempt = s.evidence!.attempts[0];
  s.evidence!.observations = [{ side: "base", run: { ...attempt.run, id: 11 }, job: { ...attempt.jobs[0], id: 30, conclusion: "success" } }];
  const output = JSON.stringify(doctorModel(s));
  assert.doesNotMatch(output, /possible regression/);
  assert.match(output, /comparison.*pending|comparison.*progress/i);
});

test("the history strip shows the selected job's comparison runs per side, oldest first", () => {
  const s = state();
  s.historical = false;
  const attempt = s.evidence!.attempts[0];
  const at = (id: number, created: string, side: "pr" | "base", conclusion: string) => ({ side, run: { ...attempt.run, id, created }, job: { ...attempt.jobs[0], id: id * 10, conclusion } });
  s.evidence!.observations = [at(13, "2026-10-03", "pr", "failure"), at(12, "2026-10-02", "pr", "success"), at(14, "2026-10-01", "base", "success"), at(15, "2026-10-02", "base", "cancelled")];
  assert.deepEqual(doctorModel(s).evidence!.history, { pr: ["pass", "fail"], base: ["pass", "other"] });
});

test("sending needs a chosen, verified session and an acknowledged mismatch", () => {
  const s = state();
  s.historical = false;
  s.snapshot = { worktrees: [{ id: "w", branch: "feature", current: true, main: false, sessions: [{ id: "s1", title: "Chat", agent: "claude", state: "idle" }, { id: "s2", title: "Gone", agent: "claude", state: "detached" }] }] } as any;
  s.dispatch = { token: 1, job: 20, phase: "preview", text: "brief", question: "Why?", acknowledged: false };
  let d = doctorModel(s).dispatch!;
  assert.deepEqual(d.sessions.map((x) => x.id), ["s1"]);
  assert.equal(d.canSend, false);
  s.dispatch.session = "s1";
  s.dispatch.verification = { worktree: "w", sha, repo: "o/r", at: 0, mismatch: true };
  d = doctorModel(s).dispatch!;
  assert.deepEqual([d.canSend, d.canAcknowledge, d.mismatch], [false, true, true]);
  s.dispatch.acknowledged = true;
  d = doctorModel(s).dispatch!;
  assert.deepEqual([d.canSend, d.canAcknowledge], [true, false]);
});
