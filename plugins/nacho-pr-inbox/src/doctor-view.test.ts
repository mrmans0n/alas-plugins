import { test } from "node:test";
import assert from "node:assert/strict";
import type { Node } from "@alas/plugin";
import { doctorView } from "./doctor-view.ts";
import type { DoctorState } from "./doctor-controller.ts";

const sha = "a".repeat(40);
function state(): DoctorState {
  const run = { id: 10, workflow: 2, name: "CI", attempt: 2, sha, branch: "feature", event: "pull_request", status: "completed", conclusion: "success", created: "2026-10-16T00:00:00Z", updated: "2026-10-16T01:00:00Z", url: "https://github.com/o/r/actions/runs/10", prs: [3], headRepo: "o/r" };
  const job = { id: 20, run: 10, attempt: 1, name: "Test", status: "completed", conclusion: "failure", started: run.created, completed: run.updated, url: run.url + "/job/20", steps: [{ name: "Run tests", number: 3, status: "completed", conclusion: "failure" }] };
  return { target: { repo: "o/r", pull: { number: 3, title: "Change", branch: "feature", url: "https://github.com/o/r/pull/3" } }, evidence: { key: "o/r:3:" + sha, repo: "o/r", number: 3, title: "Change", url: "https://github.com/o/r/pull/3", head: { repo: "o/r", sha, branch: "feature", baseBranch: "main", baseSha: "b".repeat(40) }, fetchedAt: 100, since: "2026-10-02T00:00:00Z", until: run.created, runs: [run], attempts: [{ run: { ...run, attempt: 1, conclusion: "failure" }, jobs: [job], complete: false, error: "More jobs omitted" }], logs: { "20": { text: "```\n[click](https://evil.com)\nerror: failed", truncated: true } }, observations: [], coverage: ["Base history unavailable"] }, loading: false, historyLoading: false, cached: true, historical: true, selectedAttempt: "10:1", selectedJob: 20, snapshot: { worktrees: [] } };
}
const flatten = (n: Node): Node[] => [n, ...("children" in n ? n.children.flatMap(flatten) : n.kind === "scroll" ? flatten(n.child) : [])];
test("details expose actual attempt, failed steps, bounded evidence and historical limitations", () => {
  const nodes = flatten(doctorView(state()));
  const content = JSON.stringify(nodes);
  assert.match(content, /historical/i);
  assert.match(content, /Cached/);
  assert.match(content, /Run tests/);
  assert.match(content, /Base history unavailable/);
  assert.match(content, /truncated|excerpt/i);
  assert.ok(nodes.some(n => n.kind === "link" && n.url.endsWith("/job/20")));
  assert.ok(!nodes.some(n => n.kind === "button" && n.id.startsWith("ci-prepare") && !n.disabled));
});
test("native rendering keeps hostile data literal and enforces view limits", () => {
  const s = state();
  s.historical = false;
  s.evidence!.title = "🚀".repeat(5000);
  s.dispatch = { token: 1, job: 20, phase: "preview", text: "```\ntext".repeat(1500), question: "Why?", acknowledged: false };
  const nodes = flatten(doctorView(s, true));
  assert.equal(new Set(nodes.map(n => n.id)).size, nodes.length);
  assert.ok(nodes.length < 2000);
  for (const n of nodes) {
    assert.ok(Buffer.byteLength(n.id) <= 64);
    if (n.kind === "markdown") assert.ok(Buffer.byteLength(n.text) <= 32 * 1024);
    else if ("text" in n && typeof n.text === "string") assert.ok([...n.text].length <= 4000);
  }
  const send = nodes.find(n => n.id === "ci-send");
  assert.ok(send?.kind === "button" && send.disabled);
  assert.match(JSON.stringify(nodes), /No live session|No sessions|session selected/i);
});

test("a full job page with many failed steps fits the native node budget", () => {
  const s = state();
  const template = s.evidence!.attempts[0].jobs[0];
  s.evidence!.attempts[0].jobs = Array.from({ length: 100 }, (_, i) => ({ ...template, id: 20 + i, steps: Array.from({ length: 40 }, (_, n) => ({ number: n + 1, name: `Failed step ${n}`, status: "completed", conclusion: "failure" })) }));
  const nodes = flatten(doctorView(s));
  assert.ok(nodes.length <= 2000, `${nodes.length} exceeds host node limit`);
  assert.match(JSON.stringify(nodes), /steps omitted/i);
});

test("classification stays pending until comparison failure logs finish", () => {
  const s = state(); s.historyLoading = true; s.evidence!.coverage = [];
  s.evidence!.logs["20"].signature = "test:Core.testOrdering";
  const attempt = s.evidence!.attempts[0];
  s.evidence!.observations = [{ side: "base", run: { ...attempt.run, id: 11 }, job: { ...attempt.jobs[0], id: 30, conclusion: "success" } }];
  const output = JSON.stringify(doctorView(s));
  assert.doesNotMatch(output, /possible regression/);
  assert.match(output, /comparison.*pending|comparison.*progress/i);
});
