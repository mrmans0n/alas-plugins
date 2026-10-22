import { test } from "node:test";
import assert from "node:assert/strict";
import { endpoint, GitLab, ProcessQueue } from "./doctor-transport.ts";
import { job, pipeline } from "./doctor.test.ts";

type Call = { id: string; args: string[]; done: (o: any) => void };
const setup = (now = 0) => {
  const calls: Call[] = [];
  const queue = new ProcessQueue((id, _wt, args, done) => calls.push({ id, args, done }));
  const backoffs: number[] = [];
  const gl = new GitLab(queue, "wt", "acme/team/shop", "gitlab.example.com", () => now, (s) => backoffs.push(s));
  return { calls, gl, backoffs };
};
const ok = (body: unknown, headers = "HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n") => ({ result: { exit: 0, stdout: headers + JSON.stringify(body), stderr: "", timedOut: false, truncated: false } });
const WEB = "https://gitlab.example.com/acme/team/shop";

test("endpoints use the encoded full path", () => {
  assert.equal(endpoint("acme/team/shop", "pipelines/5"), "projects/acme%2Fteam%2Fshop/pipelines/5");
});

test("MR pipelines page by 10 and stop at 30, filtering by the window", () => {
  const { calls, gl } = setup();
  let result: any;
  gl.runs({ mr: 12, since: "2026-10-10T00:00:00Z" }, (r) => { result = r; });
  assert.deepEqual(calls[0].args, ["projects/acme%2Fteam%2Fshop/merge_requests/12/pipelines?per_page=10&page=1"]);
  const page = (n: number) => Array.from({ length: 10 }, (_, i) => pipeline(n * 100 + i, { web_url: `${WEB}/-/pipelines/${n * 100 + i}` }));
  calls[0].done(ok(page(1)));
  calls[1].done(ok(page(2)));
  calls[2].done(ok([...page(3).slice(0, 9), pipeline(999, { created_at: "2026-10-01T00:00:00Z", web_url: `${WEB}/-/pipelines/999` })]));
  assert.equal(result.value.length, 29, "the out-of-window pipeline is dropped");
  assert.equal(result.complete, false);
  assert.match(result.warning, /30 summaries/);
});

test("target branch pipelines ask for push pipelines updated since the window start", () => {
  const { calls, gl } = setup();
  gl.runs({ ref: "main", since: "2026-10-10T00:00:00Z" }, () => {});
  assert.deepEqual(calls[0].args, ["projects/acme%2Fteam%2Fshop/pipelines?ref=main&source=push&updated_after=2026-10-10T00%3A00%3A00Z&per_page=10&page=1"]);
});

test("jobs include retries and page by 25", () => {
  const { calls, gl } = setup();
  let result: any;
  gl.jobs(500, (r) => { result = r; });
  assert.deepEqual(calls[0].args, ["projects/acme%2Fteam%2Fshop/pipelines/500/jobs?include_retried=true&per_page=25&page=1"]);
  calls[0].done(ok([job(1, "unit", { web_url: `${WEB}/-/jobs/1` })]));
  assert.equal(result.value.length, 1);
  assert.equal(result.complete, true);
});

test("traces come from ci-trace; a full tail means the head was cut", () => {
  const { calls, gl } = setup();
  let result: any;
  gl.log(42, (r) => { result = r; });
  assert.deepEqual([calls[0].id, calls[0].args], ["ci-trace", ["42"]]);
  calls[0].done({ result: { exit: 0, stdout: "x".repeat(262144), stderr: "", timedOut: false, truncated: false } });
  assert.equal(result.value.truncated, true);
  let missing: any;
  gl.log(43, (r) => { missing = r; });
  calls[1].done({ result: { exit: 1, stdout: "", stderr: "glab: 404 Not found (HTTP 404)", timedOut: false, truncated: false } });
  assert.equal(missing.error, "Logs unavailable or expired (GitLab 404).");
});

test("rate limits pause GitLab work until reset; 401 blocks until retry", () => {
  const { calls, gl, backoffs } = setup(1_000_000);
  gl.run(5, () => {});
  calls[0].done({ result: { exit: 1, stdout: "HTTP/2.0 429 Too Many Requests\r\nRetry-After: 30\r\n\r\n{}", stderr: "glab: 429 Too Many Requests", timedOut: false, truncated: false } });
  assert.equal(gl.blockedUntil, 1_030_000);
  assert.deepEqual(backoffs, [30]);
  let blocked: any;
  gl.run(6, (r) => { blocked = r; });
  assert.match(blocked.error, /rate limited/);
  gl.observe({ result: { exit: 1, stdout: "", stderr: "GET …: 401 {message: 401 Unauthorized}", timedOut: false, truncated: false } } as any);
  assert.equal(gl.authBlocked, true);
  gl.retry();
  assert.equal(gl.authBlocked, false);
});

test("retries post to the job or pipeline endpoint", () => {
  const { calls, gl } = setup();
  const errors: (string | undefined)[] = [];
  gl.retryJob(42, (e) => errors.push(e));
  gl.retryPipeline(500, (e) => errors.push(e));
  assert.deepEqual(calls.map((c) => [c.id, c.args]), [["retry", ["projects/acme%2Fteam%2Fshop/jobs/42/retry"]], ["retry", ["projects/acme%2Fteam%2Fshop/pipelines/500/retry"]]]);
  calls[0].done(ok({ id: 43 }));
  calls[1].done({ result: { exit: 1, stdout: "", stderr: "glab: 403 Forbidden (HTTP 403)", timedOut: false, truncated: false } });
  assert.deepEqual(errors, [undefined, "glab: 403 Forbidden (HTTP 403)"]);
});

test("an id of 429 in a failing URL is not a rate limit; a 429 status is", () => {
  const { calls, gl, backoffs } = setup(1_000_000);
  gl.retryJob(429, () => {});
  calls[0].done({ result: { exit: 1, stdout: "", stderr: "POST https://gitlab.example.com/api/v4/projects/acme%2Fshop/jobs/429/retry: 403 {message: 403 Forbidden}", timedOut: false, truncated: false } });
  assert.equal(gl.blockedUntil, 0);
  assert.deepEqual(backoffs, []);
  gl.run(7, () => {});
  calls[1].done({ result: { exit: 1, stdout: "", stderr: "glab: 429 Too Many Requests", timedOut: false, truncated: false } });
  assert.ok(gl.blockedUntil > 1_000_000);
  assert.equal(backoffs.length, 1);
});
