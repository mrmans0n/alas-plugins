// Deterministic full detail/history/dispatch transcript. The process boundary is
// fixture-backed; the production controller, SDK and view code run unchanged.
// node scripts/scenarios/ci-doctor.mjs > /tmp/ci-doctor.jsonl
// scripts/jsc-run plugins/nacho-pr-inbox/dist/plugin.js /tmp/ci-doctor.jsonl
import assert from "node:assert/strict";
import { testHost } from "../../sdk/alas/src/test.ts";
import "../../plugins/nacho-pr-inbox/src/main.ts";

const transcript = [];
const sha = "a".repeat(40), base = "b".repeat(40), session = "11111111-1111-1111-1111-111111111111";
const snapshot = { worktrees: [{ id: "main", branch: "main", main: true, current: false, sessions: [] }, { id: "feature-wt", branch: "feature", current: true, sessions: [{ id: session, title: "CI investigator", agent: "codex", state: "idle" }] }] };
const identity = { head: { sha, ref: "feature", repo: { full_name: "o/r" } }, base: { sha: base, ref: "main" } };
const pull = { number: 3, title: "CI failure example", url: "https://github.com/o/r/pull/3", isDraft: false, author: { login: "nacho" }, headRefName: "feature", headRefOid: sha, headRepository: { nameWithOwner: "o/r" }, baseRefName: "main", baseRefOid: base, updatedAt: "2026-10-16T00:00:00Z", reviewDecision: null, mergeable: "MERGEABLE", commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] }, reactions: { nodes: [] } };
const run = (id = 10, attempt = 2) => ({ id, workflow_id: 2, name: "Swift CI", run_attempt: attempt, head_sha: id === 10 ? sha : base, head_branch: id === 10 ? "feature" : "main", event: id === 10 ? "pull_request" : "push", status: "completed", conclusion: attempt === 1 && id === 10 ? "failure" : "success", created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T01:00:00Z", html_url: `https://github.com/o/r/actions/runs/${id}`, pull_requests: id === 10 ? [{ number: 3 }] : [], head_repository: { full_name: "o/r" } });
const jobs = (id, attempt) => ({ total_count: 1, jobs: [{ id: id * 10 + attempt, run_id: id, run_attempt: attempt, name: "Tests (Swift)", status: "completed", conclusion: run(id, attempt).conclusion, started_at: "2026-10-16T00:00:00Z", completed_at: "2026-10-16T01:00:00Z", html_url: `https://github.com/o/r/actions/runs/${id}/job/${id * 10 + attempt}`, steps: [{ number: 3, name: "Swift tests", status: "completed", conclusion: run(id, attempt).conclusion }] }] });
const log = "2026-10-16T00:00:00Z setup output\n".repeat(7000) + "Test Case '-[Core.testOrdering]' failed (0.1 seconds).\n" + "🚀 detail output\n".repeat(8000);
let sends = 0, lastTrees = [];
function deliver(message) { const value = { jsonrpc: "2.0", ...message }; transcript.push(value); testHost.dispatch(value); }
function click(id) { deliver({ method: "view/event", params: { tab: 0, id, kind: "click" } }); settle(); }
function select(id, value) { deliver({ method: "view/event", params: { tab: 0, id, kind: "select", value } }); settle(); }
function checkTree(root) {
  let count = 0; const ids = new Set();
  function visit(n, depth = 1) {
    assert.ok(depth <= 16); assert.ok(!ids.has(n.id)); ids.add(n.id); count++;
    assert.ok(Buffer.byteLength(n.id) <= 64);
    for (const [key, value] of Object.entries(n)) if (typeof value === "string" && !["id", "kind"].includes(key)) assert.ok(n.kind === "markdown" && key === "text" ? Buffer.byteLength(value) <= 32768 : [...value].length <= 4000);
    if (n.children) n.children.forEach(child => visit(child, depth + 1));
    if (n.child) visit(n.child, depth + 1);
  }
  visit(root); assert.ok(count <= 2000);
}
function settle() {
  for (let round = 0; round < 300; round++) {
    const sent = testHost.takeSent(); if (!sent.length) return;
    for (const m of sent) {
      if (m.method === "view/render") { checkTree(m.params.root); lastTrees.push(m.params.root); continue; }
      if (m.id === undefined) continue;
      let result = {};
      if (m.method === "workspace/snapshot") result = { snapshot };
      else if (m.method === "storage/get") result = { value: null };
      else if (m.method === "session/send") { sends++; assert.equal(m.params.session, session); assert.match(m.params.text, /attempt 1/); result = {}; }
      else if (m.method === "process/run") {
        let stdout;
        const { id, args = [], worktree } = m.params;
        if (id === "list") stdout = JSON.stringify({ data: { repository: { nameWithOwner: "o/r", pullRequests: { nodes: [pull] }, merged: { nodes: [] } } } });
        else if (id === "ci-remotes") { assert.equal(worktree, "feature-wt"); stdout = "origin\tgit@github.com:o/r.git (fetch)"; }
        else if (id === "ci-head") { assert.equal(worktree, "feature-wt"); stdout = sha + "\n"; }
        else if (id === "ci-api") {
          assert.equal(worktree, "main");
          const path = args[0];
          const attempt = /runs\/(\d+)\/attempts\/(\d+)/.exec(path);
          if (path.endsWith("/pulls/3")) stdout = JSON.stringify(identity);
          else if (path.endsWith("/logs")) stdout = log;
          else if (attempt && path.includes("/jobs?")) stdout = JSON.stringify(jobs(Number(attempt[1]), Number(attempt[2])));
          else if (attempt) stdout = JSON.stringify(run(Number(attempt[1]), Number(attempt[2])));
          else if (path.endsWith("/runs/10")) stdout = JSON.stringify(run());
          else if (path.includes("/runs?")) stdout = JSON.stringify({ total_count: 1, workflow_runs: [path.includes("branch=main") ? run(11, 1) : run()] });
          else assert.fail(`Unhandled path ${path}`);
        } else assert.fail(`Unhandled process ${id}`);
        result = { exit: 0, stdout, stderr: "", truncated: id === "ci-api" && args[0].endsWith("/logs"), timedOut: false };
      }
      deliver({ id: m.id, result });
    }
  }
  assert.fail("request loop exceeded scenario bound");
}
testHost.dispatch({ jsonrpc: "2.0", id: 0, method: "alas/activate", params: { api: 15, project: { id: "p", name: "Fixture project" }, grants: [] } });
settle();
click("pr-3-doctor");
select("ci-attempts-10", "1");
click("ci-job-open-101");
assert.match(JSON.stringify(lastTrees.at(-1)), /possible regression/);
click("ci-prepare-101");
select("ci-sessions-1", session);
click("ci-send");
click("ci-send");
assert.equal(sends, 1);
assert.match(JSON.stringify(lastTrees.at(-1)), /Sent once/);
console.log(transcript.map(m => JSON.stringify(m)).join("\n"));
