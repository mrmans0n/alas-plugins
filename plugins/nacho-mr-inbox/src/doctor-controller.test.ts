import { test } from "node:test";
import assert from "node:assert/strict";
import { DoctorController } from "./doctor-controller.ts";
import { GitLab, ProcessQueue } from "./doctor-transport.ts";
import { doctorModel } from "./doctor-view.ts";
import { job, pipeline } from "./doctor.test.ts";

const HOST = "gitlab.example.com";
const WEB = `https://${HOST}/acme/shop`;
const SHA = "b".repeat(40);
type Call = { id: string; args: string[]; worktree: string; done: (o: any) => void };
const ok = (body: unknown) => ({ result: { exit: 0, stdout: "HTTP/2.0 200 OK\r\n\r\n" + (typeof body === "string" ? body : JSON.stringify(body)), stderr: "", timedOut: false, truncated: false } });
const raw = (text: string) => ({ result: { exit: 0, stdout: text, stderr: "", timedOut: false, truncated: false } });

function setup() {
  const calls: Call[] = [];
  const queue = new ProcessQueue((id, worktree, args, done) => calls.push({ id, worktree, args, done }));
  const gl = new GitLab(queue, "main-wt", "acme/shop", HOST, () => Date.parse("2026-10-22T00:00:00Z"), () => {});
  const sent: string[] = [];
  const doctor = new DoctorController(gl, queue, {
    changed() {}, save() {}, now: () => Date.parse("2026-10-22T00:00:00Z"),
    snapshot: (done) => done({ worktrees: [{ id: "wt2", branch: "f", current: false, main: false, sessions: [{ id: "s1", title: "Chat", agent: "claude", state: "idle" }] }] } as any),
    send: (_s, text, done) => { sent.push(text); done(); },
  });
  /** Answers the oldest pending call whose args match. */
  const answer = (match: RegExp | string, reply: any) => {
    const i = calls.findIndex((c) => (typeof match === "string" ? c.id === match : match.test(c.args.join(" "))));
    assert.ok(i >= 0, `no pending call for ${match}`);
    calls.splice(i, 1)[0].done(reply);
  };
  return { calls, doctor, answer, sent };
}
const mr = { iid: 12, source_branch: "f", target_branch: "main", diff_refs: { head_sha: SHA, base_sha: "c".repeat(40) } };
const p = (id: number, fields: object = {}) => pipeline(id, { web_url: `${WEB}/-/pipelines/${id}`, ...fields });
const j = (id: number, name: string, pipe: number, fields: object = {}) => job(id, name, { web_url: `${WEB}/-/jobs/${id}`, pipeline: { id: pipe }, ...fields });

test("opening an MR loads its pipelines, the newest one's jobs, then a failed job's trace and the target branch history", () => {
  const { doctor, answer } = setup();
  doctor.open("acme/shop", { number: 12, title: "MR", url: `${WEB}/-/merge_requests/12`, branch: "f" });
  answer(/merge_requests\/12$/, ok(mr));
  answer(/merge_requests\/12\/pipelines/, ok([p(500), p(400, { status: "success" })]));
  answer(/pipelines\/500$/, ok(p(500)));
  answer(/pipelines\/500\/jobs/, ok([j(31, "unit", 500), j(30, "unit", 500, { status: "failed" }), j(20, "lint", 500, { status: "success" })]));
  let model = doctorModel(doctor.state);
  assert.deepEqual(model.jobs.map((x) => [x.id, x.name, x.failed, x.canRetry]), [[31, "unit (retry 1)", true, true], [30, "unit", true, true], [20, "lint", false, false]]);
  doctor.selectJob(31);
  answer("ci-trace", raw("section_start:1:step_script\r\nError: expected 2 but got 3 in cart_test.ts\nERROR: Job failed: exit code 1"));
  // PR side: the MR's pipelines (400 is a comparison), target side: main push pipelines.
  answer(/merge_requests\/12\/pipelines/, ok([p(500), p(400, { status: "success" })]));
  answer(/pipelines\?ref=main&source=push/, ok([p(300, { ref: "main", source: "push", status: "success", sha: "c".repeat(40) })]));
  answer(/pipelines\/400$/, ok(p(400, { status: "success" })));
  answer(/pipelines\/400\/jobs/, ok([j(41, "unit", 400, { status: "success" })]));
  answer(/pipelines\/300$/, ok(p(300, { ref: "main", source: "push", status: "success", sha: "c".repeat(40) })));
  answer(/pipelines\/300\/jobs/, ok([j(51, "unit", 300, { status: "success" })]));
  // The earlier failed attempt (job 30) is a comparison failure, so its log is read too; a different error keeps it from being "recurring".
  answer("ci-trace", raw("Error: network unreachable while fetching deps"));
  model = doctorModel(doctor.state);
  assert.deepEqual(model.jobs.find((x) => x.id === 31)?.steps, ["Failed in section step_script"]);
  assert.equal(model.evidence?.suggestion.kind, "possible regression");
  assert.deepEqual(model.evidence?.history, { pr: ["fail", "pass"], base: ["pass"] });
});

test("Retry posts the job retry and refreshes the pipelines", () => {
  const { doctor, answer, calls } = setup();
  doctor.open("acme/shop", { number: 12, title: "MR", url: `${WEB}/-/merge_requests/12`, branch: "f" });
  answer(/merge_requests\/12$/, ok(mr));
  answer(/merge_requests\/12\/pipelines/, ok([p(500)]));
  answer(/pipelines\/500$/, ok(p(500)));
  answer(/pipelines\/500\/jobs/, ok([j(30, "unit", 500)]));
  doctor.retryJob(30);
  assert.equal(doctorModel(doctor.state).jobs[0].retrying, true);
  answer("retry", ok({ id: 32 }));
  assert.equal(doctor.state.retrying, undefined);
  assert.ok(calls.some((c) => /merge_requests\/12$/.test(c.args[0])), "the doctor reloads after a retry");
});

test("a failed retry shows GitLab's message", () => {
  const { doctor, answer } = setup();
  doctor.open("acme/shop", { number: 12, title: "MR", url: `${WEB}/-/merge_requests/12`, branch: "f" });
  answer(/merge_requests\/12$/, ok(mr));
  answer(/merge_requests\/12\/pipelines/, ok([p(500)]));
  answer(/pipelines\/500$/, ok(p(500)));
  answer(/pipelines\/500\/jobs/, ok([j(30, "unit", 500)]));
  doctor.retryJob(30);
  answer("retry", { result: { exit: 1, stdout: "", stderr: "glab: 403 Forbidden (HTTP 403)", timedOut: false, truncated: false } });
  assert.equal(doctorModel(doctor.state).retryError, "glab: 403 Forbidden (HTTP 403)");
});

test("checkout verification matches the session's GitLab remote on the project host", () => {
  const { doctor, answer } = setup();
  doctor.open("acme/shop", { number: 12, title: "MR", url: `${WEB}/-/merge_requests/12`, branch: "f" });
  answer(/merge_requests\/12$/, ok(mr));
  answer(/merge_requests\/12\/pipelines/, ok([p(500)]));
  answer(/pipelines\/500$/, ok(p(500)));
  answer(/pipelines\/500\/jobs/, ok([j(30, "unit", 500)]));
  doctor.selectJob(30);
  answer("ci-trace", raw("Error: something broke badly here"));
  answer(/merge_requests\/12\/pipelines/, ok([p(500)]));
  answer(/pipelines\?ref=main/, ok([]));
  doctor.prepare(30);
  doctor.selectSession("s1");
  answer("ci-remotes", raw(`origin\tgit@${HOST}:acme/shop.git (fetch)\n`));
  answer("ci-head", raw(SHA + "\n"));
  assert.equal(doctor.state.dispatch?.verification?.repo, "acme/shop");
  assert.equal(doctor.state.dispatch?.verification?.mismatch, false);
});
