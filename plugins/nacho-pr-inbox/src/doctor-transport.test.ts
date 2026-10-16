import { test } from "node:test";
import assert from "node:assert/strict";
import type { Outcome, ProcessResult } from "@alas/plugin";
import { ProcessQueue, GitHub } from "./doctor-transport.ts";

const ok = (stdout: string): Outcome<ProcessResult> => ({ result: { exit: 0, stdout, stderr: "", truncated: false, timedOut: false } });
function harness() {
  const started: { id: string; worktree: string; args: string[]; done: (o: Outcome<ProcessResult>) => void }[] = [];
  const queue = new ProcessQueue((id, worktree, args, done) => { started.push({ id, worktree, args, done }); });
  return { queue, started };
}
test("shared process queue caps concurrency, shares requests and prioritizes inbox work", () => {
  const { queue, started } = harness();
  const values: string[] = [];
  queue.run("api", "remote-wt", ["a"], o => values.push(o.result!.stdout));
  queue.run("api", "remote-wt", ["a"], o => values.push(o.result!.stdout));
  queue.run("api", "w", ["b"], () => {});
  let active = true;
  queue.run("api", "w", ["abandoned"], () => assert.fail("abandoned callback"), { alive: () => active });
  queue.run("api", "w", ["detail"], () => {});
  queue.run("list", "w", [], () => {}, { priority: true });
  assert.equal(started.length, 2);
  active = false;
  started[0].done(ok("shared"));
  assert.deepEqual(values, ["shared", "shared"]);
  assert.equal(started[2].id, "list");
  started[1].done(ok("b"));
  assert.deepEqual(started[3].args, ["detail"]);
  assert.equal(started[0].worktree, "remote-wt");
});
test("rate limits pause new GitHub processes while preserving queued git verification", () => {
  let now = 1000;
  const { queue, started } = harness();
  const github = new GitHub(queue, "ssh", () => now, () => {});
  let message = "";
  github.json("repos/o/r/actions/runs", x => { message = x.error ?? ""; });
  started[0].done({ result: { exit: 1, stdout: "HTTP/2.0 403 Forbidden\r\nRetry-After: 120\r\n\r\n{\"message\":\"API rate limit exceeded\"}", stderr: "gh: API rate limit exceeded", truncated: false, timedOut: false } });
  assert.match(message, /rate limit/i);
  github.json("repos/o/r/actions/runs", () => {});
  assert.equal(started.length, 1);
  queue.run("head", "ssh", [], () => {});
  assert.equal(started.length, 2);
  now += 120001;
  github.json("repos/o/r/actions/runs", () => {});
  assert.equal(started.length, 3);
});
test("job pagination stops at its documented bound and flags incomplete output", () => {
  const { queue, started } = harness();
  const github = new GitHub(queue, "w", Date.now, () => {});
  let result: any;
  github.jobs("o/r", 10, 1, x => { result = x; });
  for (let page = 0; page < 4; page++) {
    assert.ok(started[page].args[0].includes(`/attempts/1/jobs?per_page=25&page=${page + 1}`));
    started[page].done(ok(JSON.stringify({ total_count: 101, jobs: Array.from({ length: 25 }, (_, i) => ({ id: page * 25 + i + 1, run_id: 10, run_attempt: 1, name: "test", status: "completed", conclusion: "failure", html_url: "https://github.com/o/r/actions/runs/10/job/1", steps: [] })) })));
  }
  assert.equal(result.value.length, 100);
  assert.equal(result.complete, false);
  assert.match(result.warning, /100|incomplete/i);
  assert.equal(started.length, 4);
});
test("truncated and malformed JSON cannot become empty successful history", () => {
  const { queue, started } = harness();
  const github = new GitHub(queue, "w", Date.now, () => {});
  let result: any;
  github.runs("o/r", {}, x => { result = x; });
  started[0].done({ result: { ...ok("{}").result!, truncated: true } });
  assert.match(result.error, /truncat/i);
  assert.equal(result.complete, false);
});

test("GitHub backoff also suspends requests already waiting in the shared queue", () => {
  let now = 1000;
  const { queue, started } = harness();
  const github = new GitHub(queue, "w", () => now, () => {});
  for (const path of ["a", "b", "c"]) github.json(path, () => {});
  assert.equal(started.length, 2);
  started[0].done({ result: { exit: 1, stdout: "HTTP/2.0 429 Too Many Requests\r\nRetry-After: 60\r\n\r\n{}", stderr: "rate limit exceeded", truncated: false, timedOut: false } });
  assert.equal(started.length, 2, "queued request must not start during backoff");
  now = 62000;
  queue.resume();
  assert.equal(started.length, 3);
});

test("CI rate and auth gates apply to original list and merge work too", () => {
  const { queue, started } = harness();
  const github = new GitHub(queue, "w", () => 1000, () => {});
  github.json("a", () => {});
  started[0].done({ result: { exit: 1, stdout: "", stderr: "rate limit exceeded", truncated: false, timedOut: false } });
  queue.run("list", "w", [], () => {}, { priority: true });
  queue.run("merge", "w", ["3"], () => {}, { priority: true });
  assert.equal(started.length, 1);
});

test("history query bounds both ends of the displayed observation window", () => {
  const { queue, started } = harness();
  const github = new GitHub(queue, "w", Date.now, () => {});
  github.runs("o/r", { since: "2026-10-02T00:00:00Z", until: "2026-10-16T00:00:00Z" }, () => {});
  assert.match(started[0].args[0], /created=2026-10-02T00%3A00%3A00Z\.\.2026-10-16T00%3A00%3A00Z/);
});

test("gh escape-sequence refusal retries raw logs once and sanitizes their content", () => {
  const { queue, started } = harness();
  const github = new GitHub(queue, "ssh-worktree", Date.now, () => {});
  let result: any;
  github.log("o/r", 20, r => { result = r; });
  started[0].done({ result: { exit: 1, stdout: "", stderr: "the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway", truncated: false, timedOut: false } });
  assert.equal(started.length, 2);
  assert.equal(started[1].worktree, "ssh-worktree");
  assert.equal(started[1].args[0], "repos/o/r/actions/jobs/20/logs");
  assert.ok(started[1].args.includes("--allow-escape-sequences"));
  started[1].done(ok("\x1b[31mTest Case '-[Core.testOrdering]' failed (0.1 seconds).\x1b[0m"));
  assert.match(result.value.text, /testOrdering/);
  assert.doesNotMatch(result.value.text, /\x1b/);
  assert.equal(started.length, 2);
});
