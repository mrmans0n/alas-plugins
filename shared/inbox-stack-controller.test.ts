import { test } from "node:test";
import assert from "node:assert/strict";
import { definePlugin } from "../sdk/alas/src/index.ts";
import { testHost } from "../sdk/alas/src/test.ts";
import { InboxStackController, parseStackPageMessage, type StackAdapter } from "./inbox-stack-controller.ts";
import type { StackReview } from "./inbox-stacks.ts";
import { buildStacks, individualBlocker, stackScope } from "./inbox-stacks.ts";
import { createStackOperation } from "./stack-operation.ts";

const review = (n: number, fields: Partial<StackReview> = {}): StackReview => ({ identity: { host: "github.com", repo: "o/r", number: n }, sourceRepo: "o/r", branch: `f${n}`, base: n === 1 ? "main" : "f1", sha: String(n).repeat(40), title: `Change ${n}`, url: `https://github.com/o/r/pull/${n}`, author: "nacho", state: "open", ready: true, ...fields });
function fixture(options: { pendingWrite?: boolean; queue?: boolean; retargetLag?: boolean; stored?: unknown; holdRestore?: boolean } = {}) {
  definePlugin({ handle() {} }); testHost.takeSent();
  let data = [review(1), review(2)];
  let settle: ((error?: string) => void) | undefined;
  let submitted = 0;
  let retargeted = 0;
  let refreshError: string | undefined;
  const adapter: StackAdapter = {
    mode: options.queue ? "queue" : "merge",
    refresh(_identities, done) { refreshError ? done(undefined, refreshError) : done({ reviews: data, complete: true }); },
    retarget(member, base, done) { retargeted++; if (!options.retargetLag) data = data.map(r => r.identity.number === member.identity.number ? { ...r, base } : r); done(); },
    submit(_member, done) { submitted++; if (options.pendingWrite) settle = done; else done(); },
  };
  const controller = new InboxStackController(adapter, () => {});
  controller.activate(); controller.updateProvider({ reviews: data, complete: true });
  const held: any[] = [];
  const restores: any[] = [];
  let released = 0;
  function flush(flags: { holdAcquire?: boolean; failSave?: boolean; refuseAcquire?: boolean } = {}) {
    for (let round = 0; round < 30; round++) {
      const sent = testHost.takeSent(); if (!sent.length) return;
      for (const m of sent) {
        if (m.method === "stacks/acquire" && flags.holdAcquire) { held.push(m); continue; }
        if (m.method === "stacks/acquire" && flags.refuseAcquire) { testHost.dispatch({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "Another owner is writing." } }); continue; }
        if (m.method === "storage/set" && flags.failSave) { testHost.dispatch({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "Storage is full." } }); continue; }
        if (m.method === "storage/get" && options.holdRestore) restores.push(m);
        else if (m.method === "storage/get") testHost.reply(m.id, { value: options.stored ?? null });
        else if (m.method === "stacks/list") testHost.reply(m.id, { inventory: { complete: true, busy: false, stacks: [] } });
        else if (m.method === "stacks/acquire") testHost.reply(m.id, { token: "reservation" });
        else if (m.method === "stacks/release") { released++; testHost.reply(m.id, { released: true }); }
        else if (m.method === "storage/set") testHost.reply(m.id, {});
        else assert.fail(`Unexpected request ${m.method}`);
      }
    }
    assert.fail("Controller did not settle");
  }
  flush();
  const start = () => { controller.prepare("github.com|o/r#1", false); controller.confirm(); };
  return { controller, start, flush, held, restores, get submitted() { return submitted; }, get retargeted() { return retargeted; }, get released() { return released; }, failRefresh: () => { refreshError = "Provider unavailable"; }, settle: () => settle?.(), backend: (reviews: StackReview[]) => { data = reviews; }, update: (reviews: StackReview[]) => { data = reviews; controller.updateProvider({ reviews, complete: true }); } };
}

test("Stop during pending acquire releases the eventual token without submitting", () => {
  const f = fixture(); f.start(); f.flush({ holdAcquire: true });
  f.controller.stop();
  assert.equal(f.submitted, 0);
  testHost.reply(f.held[0].id, { token: "reservation" }); f.flush();
  assert.equal(f.controller.model().operation?.phase, "stopped");
  assert.equal(f.released, 1);
  assert.equal(f.submitted, 0);
});

test("Stop during an active write waits for settlement and never starts the descendant", () => {
  const f = fixture({ pendingWrite: true }); f.start(); f.flush();
  assert.equal(f.submitted, 1);
  f.backend([review(1, { state: "merged" }), review(2)]);
  f.controller.stop(); f.flush();
  assert.equal(f.released, 0);
  assert.equal(f.controller.model().operation?.phase, "stopping");
  f.settle(); f.flush();
  assert.equal(f.controller.model().operation?.phase, "stopped");
  assert.equal(f.released, 1);
  assert.equal(f.submitted, 1);
  assert.equal(f.controller.model().operation?.done, 1);
  assert.equal(f.retargeted, 0);
});

test("Stop marks its phase before synchronous queued-write cancellation settles", () => {
  definePlugin({ handle() {} }); testHost.takeSent();
  let cancel: (() => void) | undefined, releases = 0, refreshes = 0;
  const controller = new InboxStackController({ mode: "queue",
    refresh(_ids, done) { refreshes++; done({ reviews: [review(1), review(2)], complete: true }); },
    submit(_member, done) { cancel = () => done("Pending write stopped"); }, retarget() {}, cancelPendingWrites() { const next = cancel; cancel = undefined; next?.(); },
  }, () => {});
  controller.updateProvider({ reviews: [review(1), review(2)], complete: true });
  const flush = () => {
    for (let round = 0; round < 20; round++) { const sent = testHost.takeSent(); if (!sent.length) return;
      for (const m of sent) { if (m.method === "stacks/acquire") testHost.reply(m.id, { token: "owner" });
        else if (m.method === "stacks/release") { releases++; testHost.reply(m.id, { released: true }); }
        else if (m.method === "storage/set") testHost.reply(m.id, {}); else assert.fail(m.method); }
    }
  };
  controller.prepare("github.com|o/r#1", false); controller.confirm(); flush();
  assert.ok(cancel); const before = refreshes;
  controller.stop(); flush();
  assert.equal(controller.model().operation?.phase, "stopped");
  assert.equal(releases, 1); assert.equal(refreshes, before + 1);
});

test("storage failure or foreign ownership prevents the first provider write", () => {
  for (const flag of [{ failSave: true }, { refuseAcquire: true }]) {
    const f = fixture(); f.start(); f.flush(flag);
    assert.equal(f.submitted, 0);
    assert.equal(f.controller.model().operation?.phase, "failed");
    assert.ok(f.controller.model().operation?.error);
  }
});

test("accepted queueing waits for provider merge before retargeting or submitting the next request", () => {
  const f = fixture({ queue: true }); f.start(); f.flush();
  assert.equal(f.submitted, 1);
  assert.equal(f.controller.model().operation?.phase, "waiting");
  assert.equal(f.controller.model().operation?.done, 0);
  f.update([review(1, { state: "merged" }), review(2)]); f.flush();
  assert.equal(f.submitted, 2);
  assert.equal(f.controller.model().operation?.done, 1);
  f.controller.stop(); f.flush();
});

test("an accepted retarget waits for base confirmation instead of repeating the write", () => {
  const f = fixture({ retargetLag: true });
  f.update([review(1, { state: "merged" }), review(2)]); f.start(); f.flush();
  assert.equal(f.retargeted, 1);
  assert.equal(f.submitted, 0);
  assert.equal(f.controller.model().operation?.phase, "waiting");
  assert.match(f.controller.model().operation?.message ?? "", /branch/);
  f.controller.stop(); f.flush();
});

test("late native replies cannot erase newer inventory and failed refresh preserves known membership", () => {
  const f = fixture();
  f.controller.refreshNative(true); const old = testHost.takeSent()[0];
  f.controller.refreshNative(true); const fresh = testHost.takeSent()[0];
  const stack = { id: "native", worktree: "wt", name: "feature", base: "main", host: "github.com", repo: "o/r", fingerprint: "v1", complete: true, actions: ["open"], entries: [1, 2].map(n => ({ id: `gg-${n}`, sha: String(n).repeat(40), position: n, number: n, title: `Change ${n}` })) };
  testHost.reply(fresh.id, { inventory: { complete: true, busy: false, stacks: [stack] } });
  testHost.reply(old.id, { inventory: { complete: true, busy: false, stacks: [] } });
  assert.match(f.controller.model().badges["github.com|o/r#1"].label, /gg/);
  f.controller.refreshNative(true); const failed = testHost.takeSent()[0];
  testHost.dispatch({ jsonrpc: "2.0", id: failed.id, error: { code: -32000, message: "Network unavailable" } });
  assert.match(f.controller.model().badges["github.com|o/r#1"].label, /gg/);
  assert.ok(f.controller.graph.blocked["github.com|o/r#1"]);
  assert.match(f.controller.model().nativeError ?? "", /Network unavailable/);
  f.controller.handle({ type: "stack", action: "open", key: "github.com|o/r#1" });
  assert.deepEqual(f.controller.model().selected?.native?.actions, ["open"]);
  f.controller.refreshNative(true); const partial = testHost.takeSent()[0];
  testHost.reply(partial.id, { inventory: { complete: false, busy: false, error: "Owner refresh failed", stacks: [{ ...stack, complete: false, entries: stack.entries.map(({ number, ...entry }) => entry) }] } });
  assert.match(f.controller.model().badges["github.com|o/r#1"].label, /gg/);
});

test("a failed manual refresh stops an active stack instead of continuing from cached state", () => {
  const f = fixture({ queue: true }); f.start(); f.flush();
  f.failRefresh(); f.controller.handle({ type: "stack", action: "refresh" }); f.flush();
  assert.equal(f.controller.model().operation?.phase, "failed");
  assert.equal(f.controller.model().operation?.error, "Provider unavailable");
  assert.equal(f.submitted, 1);
  assert.equal(f.released, 1);
});

test("malformed stack messages are ignored without coercing hostile JSON objects", () => {
  const poison = { toString: "not callable", valueOf: 1 };
  assert.equal(parseStackPageMessage({ type: "stack", action: poison }), undefined);
  assert.equal(parseStackPageMessage({ type: "stack", action: "native", nativeAction: poison }), undefined);
});

test("partial provider reads preserve missing known dependencies as unknown context", () => {
  const f = fixture();
  f.controller.updateProvider({ reviews: [review(2)], complete: false, error: "Next page unavailable" });
  assert.match(individualBlocker(f.controller.graph, review(2).identity) ?? "", /#1/);
  f.controller.handle({ type: "stack", action: "open", key: "github.com|o/r#2" });
  assert.equal(f.controller.model().selected?.entries.find(r => r.identity.number === 1)?.state, "unknown");
  assert.ok(f.controller.model().badges["github.com|o/r#2"]);
  f.controller.updateProvider({ reviews: [review(2, { base: "main" })], complete: true });
  assert.equal(f.controller.model().badges["github.com|o/r#2"], undefined);
});

test("opening native membership fetches missing context without inferring merged provider facts", () => {
  definePlugin({ handle() {} }); testHost.takeSent();
  let requested: number[] = [];
  const controller = new InboxStackController({ mode: "merge", refresh(ids, done) { requested = ids.map(i => i.number); done({ reviews: [review(1, { state: "merged" }), review(2)], complete: true }); }, retarget() {}, submit() {} }, () => {});
  controller.updateProvider({ reviews: [review(2)], complete: true });
  controller.refreshNative(true);
  const request = testHost.takeSent()[0];
  testHost.reply(request.id, { inventory: { complete: true, busy: false, stacks: [{ id: "gg", name: "feature", base: "main", host: "github.com", repo: "o/r", fingerprint: "v1", complete: true, actions: ["land"], entries: [1, 2].map(n => ({ id: `e${n}`, position: n, number: n, sha: String(n).repeat(40), title: `Change ${n}`, state: n === 1 ? "merged" : "open" })) }] } });
  assert.deepEqual(requested, []);
  controller.handle({ type: "stack", action: "open", key: "github.com|o/r#2" });
  assert.deepEqual(requested, [1, 2]);
  assert.equal(controller.model().selected?.entries.find(r => r.identity.number === 1)?.state, "merged");
});

test("unreadable local native mapping cannot fall through to generic actions", () => {
  const f = fixture();
  f.controller.refreshNative(true); const request = testHost.takeSent()[0];
  const native = { id: "unmapped", name: "feature", base: "main", host: "github.com", repo: "o/r", fingerprint: "v1", complete: false, actions: ["open"], entries: [{ id: "entry", sha: "1".repeat(40), position: 1, title: "Local entry" }] };
  testHost.reply(request.id, { inventory: { complete: false, busy: false, stacks: [native], error: "Local mapping unreadable" } });
  assert.equal(f.controller.graph.complete, false);
  assert.match(individualBlocker(f.controller.graph, review(1).identity) ?? "", /native|mapping/i);
  assert.ok(f.controller.model().error);
  f.controller.refreshNative(true); const fresh = testHost.takeSent()[0];
  testHost.reply(fresh.id, { inventory: { complete: true, busy: false, stacks: [{ ...native, reviewNumbers: [] }] } });
  assert.equal(f.controller.graph.complete, true, "explicitly empty mapping is verified unpublished context");
  assert.equal(individualBlocker(f.controller.graph, review(1).identity), undefined);
});

test("restored work stays interrupted until Continue refreshes and reacquires ownership", () => {
  const stored = createStackOperation(stackScope(buildStacks([review(1), review(2)], { complete: true }).components[0]).scope!, "queue");
  const f = fixture({ queue: true, stored });
  assert.equal(f.controller.model().operation?.phase, "interrupted");
  assert.equal(f.submitted, 0);
  f.controller.continue(); f.flush();
  assert.equal(f.submitted, 1);
  assert.equal(f.controller.model().operation?.phase, "waiting");
  f.controller.stop(); f.flush();
});

test("a late storage reply cannot replace a newer confirmed scope", () => {
  const old = createStackOperation(stackScope(buildStacks([review(1), review(2)], { complete: true }).components[0]).scope!, "merge");
  old.scope.members = old.scope.members.slice(0, 1);
  const f = fixture({ pendingWrite: true, holdRestore: true }); f.start(); f.flush();
  testHost.reply(f.restores[0].id, { value: old });
  assert.equal(f.controller.model().operation?.total, 2);
  assert.equal(f.controller.model().operation?.phase, "running");
  f.controller.stop(); f.settle(); f.flush();
});

test("new native metadata is settled before a generic operation can advance", () => {
  const f = fixture({ queue: true }); f.start(); f.flush();
  f.controller.refreshNative(true); const pending = testHost.takeSent()[0];
  f.update([review(1, { state: "merged" }), review(2, { base: "main" })]); f.flush();
  assert.equal(f.submitted, 1);
  const stack = { id: "native", name: "feature", base: "main", host: "github.com", repo: "o/r", fingerprint: "v1", complete: true, actions: ["open"], entries: [1, 2].map(n => ({ id: `gg-${n}`, sha: String(n).repeat(40), position: n, number: n, title: `Change ${n}` })) };
  testHost.reply(pending.id, { inventory: { complete: true, busy: true, stacks: [stack] } }); f.flush();
  assert.equal(f.submitted, 1);
  assert.equal(f.controller.model().operation?.phase, "failed");
});
