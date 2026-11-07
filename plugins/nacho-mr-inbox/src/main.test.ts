import { test } from "node:test";
import assert from "node:assert/strict";
import { testHost } from "@alas/plugin/test";
import { node, reply } from "./inbox.test.ts";
import "./main.ts";

const host = "gitlab.example.com", repo = "acme/shop", key = (n: number) => `${host}|${repo}#${n}`;
const page = (message: object) => testHost.notify("web/message", { tab: 0, message });
const done = (value: unknown) => ({ exit: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "", timedOut: false, truncated: false });
let data: any[] = [], trainEnabled = true, failList = false, failProject = false;
let model: any, acquisitions = 0, releases = 0;
let native: any[] = [];
const calls: any[] = [], notices: string[] = [], saves: any[] = [];
const stored = new Map<string, unknown>();
const blockers = (raw: any) => ({ ...raw, blockingMergeRequests: raw.blockingMergeRequests ?? { totalCount: 0, hiddenCount: 0, visibleMergeRequests: [] } });
function flush(): void {
  for (let round = 0; round < 100; round++) {
    const sent = testHost.takeSent(); if (!sent.length) return;
    for (const m of sent) {
      if (m.method === "web/post") { model = m.params.message; continue; }
      if (m.method === "notify") { notices.push(m.params.message); continue; }
      if (m.id === undefined) continue;
      if (m.method === "workspace/snapshot") testHost.reply(m.id, { snapshot: { worktrees: [{ id: "main", main: true, current: false, branch: "main", sessions: [] }] } });
      else if (m.method === "storage/get") testHost.reply(m.id, { value: stored.get(m.params.key) ?? null });
      else if (m.method === "storage/set") { saves.push(m.params); stored.set(m.params.key, m.params.value); testHost.reply(m.id, {}); }
      else if (m.method === "stacks/list") testHost.reply(m.id, { inventory: { complete: true, busy: false, stacks: native } });
      else if (m.method === "stacks/open") { calls.push(m); testHost.reply(m.id, { opened: true }); }
      else if (m.method === "stacks/acquire") { acquisitions++; testHost.reply(m.id, { token: `owner-${acquisitions}` }); }
      else if (m.method === "stacks/release") { releases++; testHost.reply(m.id, { released: true }); }
      else if (m.method === "process/run") {
        calls.push(m);
        const id = m.params.id, args: string[] = m.params.args ?? [];
        if (id === "list") {
          if (failList) testHost.reply(m.id, { exit: 1, stdout: "", stderr: "GitLab unavailable" });
          else testHost.reply(m.id, done(reply(data.filter(r => r.state === "opened"))));
        } else if (id === "project") testHost.reply(m.id, failProject ? { exit: 1, stdout: "", stderr: "Project unavailable" } : done({ merge_trains_enabled: trainEnabled }));
        else if (id === "stack-api") {
          const iid = args.find(a => a.startsWith("iid="));
          const value = iid ? { mergeRequest: data.find(r => r.iid === iid.slice(4)) ? blockers(data.find(r => r.iid === iid.slice(4))) : null } : { mergeRequests: { nodes: data.filter(r => r.state === "opened").map(blockers), pageInfo: { hasNextPage: false, endCursor: null } } };
          testHost.reply(m.id, done({ data: { project: value } }));
        } else if (id === "stack-retarget") {
          const number = /merge_requests\/(\d+)$/.exec(args[0])?.[1];
          data = data.map(r => r.iid === number ? { ...r, targetBranch: args.find(a => a.startsWith("target_branch="))!.slice(14), detailedMergeStatus: "MERGEABLE" } : r);
          testHost.reply(m.id, done({}));
        } else if (id === "add" || id === "automerge") {
          const number = /merge_requests\/(\d+)/.exec(args[0])?.[1];
          data = data.map(r => r.iid === number ? { ...r, autoMergeEnabled: true } : r);
          testHost.reply(m.id, done({}));
        } else if (id === "retry") testHost.reply(m.id, done({}));
        else assert.fail(`Unexpected process ${id}`);
      }
    }
  }
  assert.fail("Plugin did not settle");
}
const refresh = (rows: any[]) => { data = rows; page({ type: "refresh" }); flush(); };
const writes = () => calls.filter(c => ["add", "automerge", "stack-retarget", "retry"].includes(c.params.id));

test("API18 activation loads real stack inventory and project identity", () => {
  data = [node(1), node(2)];
  testHost.dispatch({ jsonrpc: "2.0", id: 0, method: "alas/activate", params: { api: 18, project: { id: "p", name: "P" }, grants: ["process.exec", "workspace.read"] } }); flush();
  assert.equal(model.inbox.project, repo);
  assert.equal(model.inbox.addAll.count, 2);
  assert.equal(model.stacks.busy, false);
});

test("individual train and auto-merge actions pin host and full head under ownership", () => {
  calls.length = 0; const before = acquisitions;
  refresh([node(1, { detailedMergeStatus: "CI_STILL_RUNNING" })]);
  page({ type: "add", iid: 1 }); flush();
  assert.deepEqual(writes()[0].params.args, ["projects/acme%2Fshop/merge_trains/merge_requests/1", "--hostname", host, "-f", `sha=${"a".repeat(40)}`, "-f", "auto_merge=true"]);
  assert.equal(acquisitions, before + 1); assert.equal(releases, acquisitions);
  assert.equal(model.inbox.sections[0].rows[0].add, undefined, "accepted auto-merge is queued, not another add action");
  trainEnabled = false; refresh([node(2)]); calls.length = 0;
  page({ type: "add", iid: 2 }); flush();
  assert.equal(writes()[0].params.id, "automerge");
  assert.ok(writes()[0].params.args.includes("merge_when_pipeline_succeeds=true"));
  trainEnabled = true;
});

test("Add all excludes stack membership, obeys Mine, and stops on failed reads", () => {
  page({ type: "scope", mine: true }); flush();
  refresh([node(1), node(2, { targetBranch: "nacho/mr-1" }), node(3), node(4, { author: { username: "ana" } }), node(5)]);
  assert.equal(model.inbox.addAll.count, 2);
  calls.length = 0; page({ type: "addAll" }); flush();
  assert.deepEqual(writes().map(c => c.params.args[0]), ["projects/acme%2Fshop/merge_trains/merge_requests/5", "projects/acme%2Fshop/merge_trains/merge_requests/3"]);
  assert.equal(model.inbox.addAll, undefined);
  failList = true; page({ type: "refresh" }); flush(); calls.length = 0;
  page({ type: "addAll" }); flush();
  assert.equal(writes().length, 0); assert.ok(model.inbox.error);
  failList = false; page({ type: "scope", mine: false }); flush();
});

test("individual descendants cannot skip predecessors and inspector retains mixed authors", () => {
  refresh([node(1, { author: { username: "ana" } }), node(2, { targetBranch: "nacho/mr-1" })]);
  calls.length = 0; page({ type: "add", iid: 2 }); flush();
  assert.equal(writes().length, 0);
  page({ type: "scope", mine: true }); page({ type: "stack", action: "open", key: key(2) }); flush();
  assert.equal(model.stacks.selected.entries.length, 2);
  assert.ok(model.stacks.selected.outsideFilter.includes(key(1)));
  assert.ok(model.inbox.stackRows.some((r: any) => r.iid === 1));
  page({ type: "scope", mine: false }); page({ type: "stack", action: "close" }); flush();
});

test("generic stack queue waits for actual merge, stops explicitly, and continues with retarget confirmation", () => {
  refresh([node(1), node(2, { targetBranch: "nacho/mr-1" })]);
  calls.length = 0;
  page({ type: "stack", action: "prepare", key: key(2) }); flush();
  assert.equal(model.stacks.confirmation.members.length, 2);
  page({ type: "stack", action: "confirm" }); flush();
  assert.equal(writes().filter(c => c.params.id === "add").length, 1);
  assert.equal(model.stacks.operation.phase, "waiting"); assert.equal(model.stacks.operation.done, 0);
  testHost.notify("timer/fired", { id: "refresh" }); flush();
  assert.equal(writes().length, 1, "queued predecessor cannot start a child");
  page({ type: "stack", action: "stop" }); flush();
  assert.equal(model.stacks.operation.phase, "stopped"); assert.equal(releases, acquisitions);
  data = data.map(r => r.iid === "1" ? { ...r, state: "merged" } : r);
  page({ type: "stack", action: "continue" }); flush();
  assert.equal(model.stacks.operation.done, 1);
  assert.deepEqual(writes().map(c => c.params.id), ["add", "stack-retarget", "add"]);
  assert.equal(data.find(r => r.iid === "2").targetBranch, "main");
  data = data.map(r => ({ ...r, state: "merged" }));
  testHost.notify("timer/fired", { id: "refresh" }); flush();
  assert.equal(model.stacks.operation.phase, "complete"); assert.equal(model.stacks.operation.done, 2);
  assert.equal(releases, acquisitions);
  assert.ok(saves.some(s => s.key === "inbox-stack-operation-v1" && s.scope === "project"));
  page({ type: "stack", action: "close" }); flush();
});

test("native gg members route to native presentation and never raw glab", () => {
  native = [{ id: "gg", name: "feature", base: "main", host, repo, worktree: "feature", complete: true, fingerprint: "one", actions: ["open", "land", "landThrough"], entries: [1, 2].map(n => ({ id: `entry-${n}`, position: n, number: n, title: `MR ${n}`, sha: "a".repeat(40) })) }];
  refresh([node(1), node(2, { targetBranch: "nacho/mr-1" })]);
  testHost.notify("stacks/changed"); flush(); calls.length = 0;
  page({ type: "add", iid: 2 }); flush(); assert.equal(writes().length, 0);
  page({ type: "add", iid: 1 }); flush();
  assert.equal(writes().length, 0);
  assert.ok(calls.some(c => c.method === "stacks/open" && c.params.action === "landThrough" && c.params.entry === "entry-1"));
  native = []; testHost.notify("stacks/changed"); flush();
});

test("pipeline retry and CI Doctor share project ownership; failed project read preserves mode", () => {
  refresh([node(4, { headPipeline: { id: "gid://gitlab/Ci::Pipeline/44", status: "FAILED", sha: "a".repeat(40) } })]);
  calls.length = 0; const before = acquisitions;
  page({ type: "retryPipeline", pipeline: 999 }); flush(); assert.equal(writes().length, 0);
  page({ type: "retryPipeline", pipeline: 44 }); flush();
  assert.deepEqual(writes()[0].params.args, ["projects/acme%2Fshop/pipelines/44/retry", "--hostname", host]);
  assert.equal(acquisitions, before + 1); assert.equal(releases, acquisitions);
  failProject = true; refresh([node(1)]); assert.equal(model.inbox.trainsEnabled, true); failProject = false;
});

test("scope storage ignores malformed and late stored values after the user chooses", () => {
  const activate = () => {
    testHost.dispatch({ jsonrpc: "2.0", id: 0, method: "alas/activate", params: { api: 18, project: { id: "p", name: "P" }, grants: [] } });
    const sent = testHost.takeSent();
    return sent.find(m => m.method === "storage/get" && m.params.key === "view-v1").id;
  };
  let id = activate(); testHost.reply(id, { value: { mineOnly: "yes" } }); flush();
  page({ type: "ready" }); flush(); assert.equal(model.inbox.scope.mineOnly, false);
  id = activate(); page({ type: "scope", mine: true }); flush();
  testHost.reply(id, { value: { mineOnly: false } }); flush();
  assert.equal(model.inbox.scope.mineOnly, true);
  page({ type: "scope", mine: false }); flush();
});
