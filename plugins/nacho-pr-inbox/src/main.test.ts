import { test } from "node:test";
import assert from "node:assert/strict";
import { testHost } from "@alas/plugin/test";
import "./main.ts";

const calls = (sent: any[]) => sent.filter((m) => !["web/post", "panel/badge"].includes(m.method)).map((m) => [m.method, m.params]);
const visible = (tab: boolean) => testHost.notify("tab/visible", { tab: 0, visible: tab });
const panel = (shown: boolean) => testHost.notify("panel/visible", { panel: "rail", visible: shown });
const page = (message: object, target: object = { tab: 0 }) => testHost.notify("web/message", { ...target, message });
const posted = (sent: any[]): any => sent.findLast((m) => m.method === "web/post")?.params.message;
const codex = { nodes: [{ user: { login: "chatgpt-codex-connector[bot]" } }] };
const ready = (number: number, fields: object = {}) => ({ number, title: `Change ${number}`, url: `https://github.com/o/r/pull/${number}`, isDraft: false, state: "OPEN", headRefOid: String(number).padStart(40, "0"), baseRefOid: "b".repeat(40), headRepository: {nameWithOwner:"o/r"}, baseRefName:"main", headRefName: `f${number}`, updatedAt: `2026-10-1${number}T00:00:00Z`, mergeable: "MERGEABLE", commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] }, reactions: codex, ...fields });
const by = (login: string) => ({ author: { login } });
const list = (nodes: object[], viewer?: string) => JSON.stringify({ data: { ...(viewer && { viewer: { login: viewer } }), repository: { nameWithOwner: "o/r", url:"https://github.com/o/r", defaultBranchRef:{name:"main"}, pullRequests: { nodes, pageInfo:{hasNextPage:false,endCursor:null} } } } });
const process = (sent: any[], id: string) => sent.find((m) => m.method === "process/run" && m.params.id === id);

// Model the API18 host explicitly; assertions still inspect every provider write.
const pending = new Map<number, any>();
let latestList = list([]);
let preflight = false;
function reply(id: number, result: any): void {
  if (pending.get(id)?.params.id === "list" && result.exit === 0) latestList = result.stdout;
  pending.delete(id);
  testHost.reply(id,result);
}
function take(): any[] {
  const kept:any[]=[];
  for (;;) {
    const batch=testHost.takeSent();
    if(!batch.length) break;
    for(const m of batch) {
      if(m.method==="process/run") pending.set(m.id,m);
      if(m.method==="stacks/list") {testHost.reply(m.id,{inventory:{complete:true,busy:false,stacks:[]}});continue;}
      if(m.method==="stacks/acquire") {preflight=true;testHost.reply(m.id,{token:"reservation"});continue;}
      if(m.method==="stacks/release") {testHost.reply(m.id,{released:true});continue;}
      if(m.method==="storage/get" && m.params.key==="inbox-stack-operation-v1") {testHost.reply(m.id,{value:null});continue;}
      if(m.method==="process/run" && m.params.id==="list" && preflight) {preflight=false;reply(m.id,{exit:0,stdout:latestList,stderr:""});continue;}
      if(m.method==="process/run" && m.params.id==="ci-api" && m.params.args?.includes("graphql")) {
        const number=Number(m.params.args.find((a:string)=>a.startsWith("number="))?.slice(7));
        assert.ok(number,"the target read must pin the missing identity");
        reply(m.id,{exit:0,stdout:JSON.stringify({data:{repository:{pullRequest:ready(number,{state:"MERGED"})}}}),stderr:""});continue;
      }
      kept.push(m);
    }
  }
  return kept;
}

test("the inbox refreshes on start, every 5 minutes while hidden and every minute while shown", () => {
  testHost.dispatch({ jsonrpc: "2.0", id: 0, method: "alas/activate", params: { api: 18, project: { id: "p", name: "P" }, grants: [] } });
  const snapshot = take().find((m) => m.method === "workspace/snapshot");
  const worktree = (id: string, main = false) => ({ id, branch: id, current: false, main, sessions: [] });
  reply(snapshot.id, { snapshot: { worktrees: [worktree("feature"), worktree("trunk", true)] } });
  const sent = take();
  assert.deepEqual(calls(sent), [
    ["timer/set", { id: "refresh", seconds: 300, repeat: true }],
    ["process/run", { id: "list", worktree: "trunk" }],
  ]);
  reply(process(sent, "list").id, { exit: 0, stdout: list([]), stderr: "" });
  assert.deepEqual(take().filter((m) => m.method === "panel/badge"), [], "the rail icon has no badge");

  panel(true);
  assert.deepEqual(calls(take()), [["timer/set", { id: "refresh", seconds: 60, repeat: true }]], "fresh data is not fetched again");
  visible(true);
  panel(false);
  assert.deepEqual(calls(take()), [], "still shown in the tab");
  visible(false);
  assert.deepEqual(calls(take()), [["timer/set", { id: "refresh", seconds: 300, repeat: true }]]);
});

test("a page that loads gets the state, in the tab and the rail", () => {
  page({ type: "ready" }, { panel: "rail" });
  const sent = take().filter((m) => m.method === "web/post");
  assert.deepEqual(sent.map((m) => Object.keys(m.params)[0]), ["tab", "panel"]);
  assert.equal(sent[0].params.message.type, "state");
  assert.equal(sent[0].params.message.inbox.repo, "o/r");
  page({ type: "ready" }, { panel: "other" });
  page({ type: "merge", number: "3" });
  assert.deepEqual(take(), [], "other panels and malformed messages are ignored");
});

test("merging still uses the main worktree, refreshes the inbox and badges the ready count", () => {
  page({ type: "refresh" });
  reply(process(take(), "list").id, { exit: 0, stdout: list([ready(3)]), stderr: "" });
  const listed = take();
  assert.deepEqual(listed.find((m) => m.method === "panel/badge")?.params, { panel: "rail", count: 1, tone: "success" });
  assert.equal(posted(listed).inbox.sections[0].rows[0].merge.look, "go");
  page({ type: "merge", number: 3 }, { panel: "rail" });
  const merge = process(take(), "merge");
  assert.deepEqual(merge.params, { id: "merge", worktree: "trunk", args: ["https://github.com/o/r/pull/3", "--match-head-commit", String(3).padStart(40,"0"), "--delete-branch"] });
  reply(merge.id, { exit: 0, stdout: "", stderr: "" });
  const sent = take();
  assert.ok(sent.some((m) => m.method === "notify/show" || m.method === "notify"), "successful merge notifies");
  reply(process(sent, "list").id, { exit: 0, stdout: list([]), stderr: "" });
  assert.deepEqual(take().find((m) => m.method === "panel/badge")?.params, { panel: "rail" }, "the badge clears");
});

test("Merge all merges each ready pull request after a fresh list, and stops at the first failure", () => {
  page({ type: "refresh" });
  reply(process(take(), "list").id, { exit: 0, stdout: list([ready(4), ready(5), ready(6)]), stderr: "" });
  take();
  page({ type: "mergeAll" });
  let sent = take();
  assert.deepEqual(process(sent, "merge").params.args, ["https://github.com/o/r/pull/6", "--match-head-commit", String(6).padStart(40,"0"), "--delete-branch"], "the most recently updated first");
  assert.equal(posted(sent).inbox.mergeAll.progress, "Merging 1 of 3…");
  reply(process(sent, "merge").id, { exit: 0, stdout: "", stderr: "" });
  sent = take();
  assert.equal(process(sent, "merge"), undefined, "waits for the list");
  // #5 stopped being ready meanwhile: it is skipped.
  reply(process(sent, "list").id, { exit: 0, stdout: list([{ ...ready(5), mergeable: "CONFLICTING" }, ready(4)]), stderr: "" });
  sent = take();
  assert.deepEqual(process(sent, "merge").params.args, ["https://github.com/o/r/pull/4", "--match-head-commit", String(4).padStart(40,"0"), "--delete-branch"]);
  reply(process(sent, "merge").id, { exit: 1, stdout: "", stderr: "Pull request is not mergeable\n" });
  sent = take();
  reply(process(sent, "list").id, { exit: 0, stdout: list([ready(4), ready(7)]), stderr: "" });
  sent = take();
  assert.equal(process(sent, "merge"), undefined, "stopped");
  const inbox = posted(sent).inbox;
  assert.equal(inbox.sections[0].rows.find((r: any) => r.number === 4).error, "Pull request is not mergeable");
  assert.deepEqual(inbox.mergeAll, { count: 2, disabled: false });
});

const stored = (id: number, value: unknown) => reply(id, { value });
const numbers = (sent: any[]) => posted(sent).inbox.sections.flatMap((s: any) => s.rows.map((r: any) => r.number));
const storageSets = (sent: any[]) => sent.filter((m) => m.method === "storage/set").map((m) => m.params);
const listed = (nodes: object[]) => {
  page({ type: "refresh" });
  reply(process(take(), "list").id, { exit: 0, stdout: list(nodes, "Nacho"), stderr: "" });
  return take();
};
// Each activation asks storage again, with a new request id (a reply answers its request once).
const viewGet = () => {
  testHost.dispatch({ jsonrpc: "2.0", id: 0, method: "alas/activate", params: { api: 18, project: { id: "p", name: "P" }, grants: [] } });
  const gets = take().filter((m) => m.method === "storage/get");
  assert.deepEqual(gets.map((m) => m.params.key), ["ci-doctor-v1", "view-v1"]);
  return gets[1].id;
};

test("a stored scope is applied once the list is there and redraws; a malformed one is ignored", () => {
  assert.equal(numbers(listed([ready(1, by("nacho")), ready(2, by("ana"))])).length, 2);
  for (const bad of [{ mineOnly: "yes" }, {}, null, "x", [true]]) {
    stored(viewGet(), bad);
    const sent = take();
    assert.deepEqual(storageSets(sent), []);
    assert.equal(posted(sent), undefined, `${JSON.stringify(bad)}: nothing redrawn`);
  }
  stored(viewGet(), { mineOnly: true });
  const sent = take();
  assert.deepEqual(numbers(sent), [1], "viewer Nacho, author nacho");
  assert.equal(posted(sent).inbox.scope.mineOnly, true);
  assert.deepEqual(storageSets(sent), [], "applying a stored value does not write it back");
});

test("a stored scope that arrives after the user clicked the toggle is ignored", () => {
  const id = viewGet();
  page({ type: "scope", mine: false });
  take();
  stored(id, { mineOnly: true });
  assert.deepEqual(take(), [], "late stored value dropped");
  page({ type: "ready" });
  assert.equal(posted(take()).inbox.scope.mineOnly, false);
});

test("a scope message persists the choice and redraws; a non-boolean is ignored; a row still merges a pull request that is not yours", () => {
  page({ type: "scope", mine: "yes" });
  assert.deepEqual(take(), []);
  page({ type: "scope", mine: true });
  const sent = take();
  assert.deepEqual(storageSets(sent), [{ key: "view-v1", value: { mineOnly: true } }]);
  assert.deepEqual(numbers(sent), [1]);
  page({ type: "merge", number: 2 });
  const merge = process(take(), "merge");
  assert.deepEqual(merge.params.args, ["https://github.com/o/r/pull/2", "--match-head-commit", String(2).padStart(40,"0"), "--delete-branch"], "the filter only shapes Merge all");
  reply(merge.id, { exit: 0, stdout: "", stderr: "" });
  reply(process(take(), "list").id, { exit: 0, stdout: list([ready(1, by("nacho"))], "nacho"), stderr: "" });
  take();
});

test("Merge all with Mine on merges only your pull requests, also when the list changes under it", () => {
  listed([ready(1, by("nacho")), ready(2, by("ana")), ready(3, by("nacho")), ready(4, by("bob"))]);
  page({ type: "mergeAll" });
  let sent = take();
  assert.equal(posted(sent).inbox.mergeAll.progress, "Merging 1 of 2…");
  assert.deepEqual(process(sent, "merge").params.args, ["https://github.com/o/r/pull/3", "--match-head-commit", String(3).padStart(40,"0"), "--delete-branch"], "newest of mine first, not ana's 2 or bob's 4");
  reply(process(sent, "merge").id, { exit: 0, stdout: "", stderr: "" });
  sent = take();
  // 1 turned out to be ana's: its queued number must be dropped by the re-check.
  reply(process(sent, "list").id, { exit: 0, stdout: list([ready(1, by("ana")), ready(2, by("ana"))], "nacho"), stderr: "" });
  sent = take();
  assert.equal(process(sent, "merge"), undefined, "no merge of a pull request that is not yours while Mine is on");
  assert.equal(posted(sent).inbox.mergeAll, undefined);

  page({ type: "scope", mine: false });
  take();
  page({ type: "mergeAll" });
  sent = take();
  assert.deepEqual(process(sent, "merge").params.args, ["https://github.com/o/r/pull/2", "--match-head-commit", String(2).padStart(40,"0"), "--delete-branch"], "with All, ana's ready pull requests are merged too");
  reply(process(sent, "merge").id, { exit: 0, stdout: "", stderr: "" });
  reply(process(take(), "list").id, { exit: 0, stdout: list([], "nacho"), stderr: "" });
  take();
});

test('stack badges and unfiltered inspector rows survive Mine, and Merge all excludes the whole chain', () => {
  page({type:'scope',mine:true});take();
  const sent=listed([ready(10,by('ana')),ready(11,{...by('nacho'),baseRefName:'f10'}),ready(12,by('nacho')),ready(13,by('nacho'))]);
  const model=posted(sent);
  assert.equal(Object.keys(model.stacks.badges).length,2);
  assert.equal(model.inbox.mergeAll.count,2);
  assert.equal(model.inbox.stackRows.some((r:any)=>r.number===10),true);
  const key=Object.keys(model.stacks.badges).find(k=>k.endsWith('#11'));
  page({type:'stack',action:'open',key});
  const selected=posted(take()).stacks.selected;
  assert.deepEqual(selected.entries.map((r:any)=>r.identity.number),[10,11]);
  assert.ok(selected.outsideFilter.some((k:string)=>k.endsWith('#10')));
  page({type:'merge',number:11});
  const blocked=take();
  assert.equal(process(blocked,'merge'),undefined,'individual merge never silently includes an ancestor');
});

test('native inventory invalidates through API18 and native members never use raw gh merge', () => {
  listed([ready(20),ready(21,{baseRefName:'f20'})]);
  testHost.notify('stacks/changed',{});
  const sent=testHost.takeSent();
  const inventory=sent.find(m=>m.method==='stacks/list');assert.ok(inventory);
  testHost.reply(inventory.id,{inventory:{complete:true,busy:false,stacks:[{id:'gg',name:'Native',base:'main',host:'github.com',repo:'o/r',worktree:'trunk',fingerprint:'native',complete:true,entries:[20,21].map((number,i)=>({id:`e${number}`,number,sha:String(number).padStart(40,'0'),position:i+1,title:`Change ${number}`})),actions:['open','land','landThrough']}]}});
  take();
  page({type:'merge',number:20});
  assert.equal(process(take(),'merge'),undefined);
  page({type:'stack',action:'native',key:'github.com|o/r#20',nativeAction:'land'});
  const opened=testHost.takeSent();
  assert.deepEqual(opened.find(m=>m.method==='stacks/open')?.params,{stack:'gg',fingerprint:'native',action:'land'});
  assert.equal(process(opened,'merge'),undefined);
  testHost.reply(opened.find(m=>m.method==='stacks/open').id,{opened:true});take();
});

test('a generic root keeps its individual merge while its descendant stays blocked', () => {
  const sent=listed([ready(30),ready(31,{baseRefName:'f30'})]);
  const rows=posted(sent).inbox.stackRows;
  assert.equal(rows.find((r:any)=>r.number===30).merge.disabled,false);
  assert.equal(rows.find((r:any)=>r.number===31).merge.disabled,true);
});
