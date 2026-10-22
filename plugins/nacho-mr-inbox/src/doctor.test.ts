import { test } from "node:test";
import assert from "node:assert/strict";
import { brief, classifyEvidence, excerpt, outcome, packCache, parseIdentity, parseJobs, parsePipeline, parsePipelines, remoteRepo, restoreCache, validRepo, type Evidence } from "./doctor.ts";

const HOST = "gitlab.example.com";
const WEB = `https://${HOST}/acme/shop`;
const SHA = "b".repeat(40);
export const pipeline = (id: number, fields: object = {}) => ({ id, iid: id, sha: SHA, ref: "refs/merge-requests/12/merge", status: "failed", source: "merge_request_event", created_at: "2026-10-20T10:00:00Z", updated_at: "2026-10-20T10:10:00Z", web_url: `${WEB}/-/pipelines/${id}`, ...fields });
export const job = (id: number, name: string, fields: object = {}) => ({ id, name, stage: "test", status: "failed", failure_reason: "script_failure", started_at: "2026-10-20T10:01:00Z", finished_at: "2026-10-20T10:05:00Z", web_url: `${WEB}/-/jobs/${id}`, pipeline: { id: 500 }, allow_failure: false, ...fields });

test("GitLab full paths, with nested groups", () => {
  assert.equal(validRepo("acme/shop"), true);
  assert.equal(validRepo("acme/team/sub/shop"), true);
  assert.equal(validRepo("shop"), false);
  assert.equal(validRepo("acme/../shop"), false);
});

test("pipeline statuses map to the run status/conclusion the controller expects", () => {
  assert.deepEqual(outcome("success"), { status: "completed", conclusion: "success" });
  assert.deepEqual(outcome("failed"), { status: "completed", conclusion: "failure" });
  assert.deepEqual(outcome("canceled"), { status: "completed", conclusion: "cancelled" });
  assert.deepEqual(outcome("manual"), { status: "completed", conclusion: "manual" });
  assert.deepEqual(outcome("running"), { status: "running", conclusion: null });
});

test("pipelines carry their kind, MR and project; off-host links are refused", () => {
  const run = parsePipeline(pipeline(500), HOST, "acme/shop");
  assert.deepEqual(run, { id: 500, workflow: 1, name: "Merged results pipeline", attempt: 1, sha: SHA, branch: "refs/merge-requests/12/merge", event: "merge_request_event", status: "completed", conclusion: "failure", created: "2026-10-20T10:00:00Z", updated: "2026-10-20T10:10:00Z", url: `${WEB}/-/pipelines/500`, prs: [12], headRepo: "acme/shop" });
  assert.equal(parsePipeline(pipeline(1, { ref: "refs/merge-requests/12/train" }), HOST, "acme/shop").name, "Merge train pipeline");
  assert.equal(parsePipeline(pipeline(1, { ref: "refs/merge-requests/12/head" }), HOST, "acme/shop").name, "Detached MR pipeline");
  assert.deepEqual(parsePipeline(pipeline(1, { ref: "main", source: "push" }), HOST, "acme/shop").prs, []);
  assert.throws(() => parsePipeline(pipeline(1, { web_url: "https://evil.example/x" }), HOST, "acme/shop"));
  assert.equal(parsePipelines([pipeline(1), pipeline(2)], HOST, "acme/shop").length, 2);
  assert.throws(() => parsePipelines({ nope: 1 }, HOST, "acme/shop"));
});

test("retried jobs become attempts by name, oldest first", () => {
  const jobs = parseJobs([job(30, "unit"), job(10, "unit", { status: "success", failure_reason: undefined }), job(20, "lint")], 500, HOST);
  assert.deepEqual(jobs.map((j) => [j.id, j.name, j.attempt, j.conclusion, j.reason]), [[30, "unit", 2, "failure", "script_failure"], [10, "unit", 1, "success", ""], [20, "lint", 1, "failure", "script_failure"]]);
  assert.deepEqual(jobs[0], { id: 30, run: 500, attempt: 2, name: "unit", stage: "test", status: "completed", conclusion: "failure", reason: "script_failure", started: "2026-10-20T10:01:00Z", completed: "2026-10-20T10:05:00Z", url: `${WEB}/-/jobs/30`, steps: [] });
  assert.throws(() => parseJobs([job(1, "x", { pipeline: { id: 9 } })], 500, HOST), /mismatched/);
});

test("MR identity from the REST merge request", () => {
  const mr = { iid: 12, sha: SHA, source_branch: "feature", target_branch: "main", diff_refs: { head_sha: SHA, base_sha: "c".repeat(40) } };
  assert.deepEqual(parseIdentity(mr, "acme/shop"), { sha: SHA, repo: "acme/shop", branch: "feature", baseSha: "c".repeat(40), baseBranch: "main" });
  assert.throws(() => parseIdentity({ ...mr, diff_refs: null }, "acme/shop"));
});

test("excerpts strip ANSI and section markers and name the failing section", () => {
  const raw = [
    "\x1b[0Ksection_start:1:prepare_executor\r\x1b[0KPreparing", "\x1b[0Ksection_end:2:prepare_executor\r\x1b[0K",
    "\x1b[0Ksection_start:3:step_script\r\x1b[0KRunning script", "\x1b[31;1mError: expected 2 but got 3 in cart_test.ts\x1b[0m",
    "\x1b[0Ksection_end:4:step_script\r\x1b[0K", "\x1b[31;1mERROR: Job failed: exit code 1\x1b[0m",
  ].join("\n");
  const e = excerpt(raw, false);
  assert.equal(e.section, "step_script");
  assert.match(e.text, /^Preparing\n\nRunning script\nError: expected 2/);
  assert.doesNotMatch(e.text, /section_|\x1b/);
  assert.equal(e.signature, "error:Error: expected 2 but got 3 in cart_test.ts");
  assert.equal(excerpt(raw, true).truncated, true, "a cut head is truncation");
  assert.equal(excerpt("section_start:1:build\r\nboom", false).section, "build", "an unclosed section is the failing one");
});

test("remotes match host and full path, any form, credentials dropped", () => {
  assert.equal(remoteRepo(`origin\tgit@${HOST}:acme/team/shop.git (fetch)`, HOST), "acme/team/shop");
  assert.equal(remoteRepo(`origin\thttps://user:tok@${HOST}/acme/shop (push)`, HOST), "acme/shop");
  assert.equal(remoteRepo(`origin\tssh://git@${HOST}:2222/acme/shop.git (fetch)`, HOST), "acme/shop");
  assert.equal(remoteRepo("origin\tgit@gitlab.com:acme/shop.git (fetch)", HOST), undefined);
});

const evidence = (): Evidence => {
  const run = parsePipeline(pipeline(500), HOST, "acme/shop");
  const [unit] = parseJobs([job(30, "unit")], 500, HOST);
  return { key: `acme/shop:12:${SHA}`, repo: "acme/shop", number: 12, title: "MR", url: `${WEB}/-/merge_requests/12`, head: { sha: SHA, repo: "acme/shop", branch: "f", baseSha: "c".repeat(40), baseBranch: "main" },
    fetchedAt: 1, runs: [run], attempts: [{ run, jobs: [unit], complete: true }], logs: { "30": { text: "x", truncated: false } }, observations: [], coverage: [], since: "a", until: "b" };
};

test("an infrastructure failure_reason is an infrastructure clue", () => {
  const e = evidence();
  e.attempts[0].jobs[0].reason = "runner_system_failure";
  assert.equal(classifyEvidence(e, e.attempts[0].jobs[0]).kind, "possible infrastructure/dependency problem");
});

test("the brief names the MR and pipeline; the cache round-trips only on its host", () => {
  const e = evidence();
  const text = brief(e, e.attempts[0].jobs[0], "Why?");
  assert.match(text, /^MR Inbox CI Doctor investigation brief/);
  assert.match(text, /MR: https:\/\/gitlab\.example\.com\/acme\/shop\/-\/merge_requests\/12/);
  assert.match(text, /Pipeline: Merged results pipeline\nPipeline 500, job 30 \(attempt 1\): unit/);
  const packed = packCache([e]);
  assert.equal(restoreCache(packed, HOST).length, 1);
  assert.equal(restoreCache(packed, "gitlab.com").length, 0);
});

test("a retried job (attempt 2) still resolves its pipeline in brief and classification", () => {
  const e = evidence();
  const retry = { ...e.attempts[0].jobs[0], attempt: 2 };
  e.attempts[0].jobs = [retry];
  const text = brief(e, retry, "Why?");
  assert.match(text, /Pipeline: Merged results pipeline\nPipeline 500, job 30 \(attempt 2\): unit/);
  assert.match(text, new RegExp(`Recorded pipeline SHA/ref: ${SHA} / refs/merge-requests/12/merge`));
  assert.doesNotMatch(text, /Unknown|unknown \/ unknown/);
  const run = e.runs[0];
  e.logs["30"] = { text: "x", truncated: false, signature: "error:boom happened" };
  e.observations = [{ side: "base", run: { ...run, id: 400, sha: "d".repeat(40) }, job: { ...retry, id: 31, run: 400, attempt: 1 }, excerpt: { text: "x", truncated: false, signature: "error:boom happened" } }];
  assert.equal(classifyEvidence(e, retry).kind, "recurring failure");
  const failedFirst = { ...retry, id: 29, attempt: 1 };
  e.attempts[0].jobs = [failedFirst, retry];
  e.logs["29"] = { text: "x", truncated: false };
  e.observations = [{ side: "pr", run, job: { ...retry, conclusion: "success", status: "completed" } }];
  assert.match(classifyEvidence(e, failedFirst).text, /later attempt passed/i);
});
