import { test } from "node:test";
import assert from "node:assert/strict";
import { testHost } from "./test.ts";
import { definePlugin } from "./index.ts";
import { parseStackInventory, stackList, stackOpen, stackAcquire, stackRelease } from "./stacks.ts";

test("stack SDK helpers decode scoped inventory and reject malformed successful replies", () => {
  const events: string[] = [];
  definePlugin({ handle: event => { events.push(event.type); } });
  const inventory = { complete: false, busy: false, stacks: [{ id: "remote", name: "feature", host: "github.com", repo: "o/r", base: "", fingerprint: "v1", complete: false, entries: [], actions: [], reviewNumbers: [1, 2] }] };
  let result: unknown;
  let error: unknown;
  const request = stackList(true, outcome => { result = outcome.result; error = outcome.error; });
  assert.deepEqual(testHost.takeSent().at(-1)?.params, { refresh: true });
  testHost.reply(request, { inventory });
  assert.deepEqual(result, inventory);
  assert.equal(error, undefined);
  const malformed = stackList(false, outcome => { error = outcome.error; });
  testHost.takeSent();
  testHost.reply(malformed, { inventory: { complete: true, busy: false, stacks: [{ ...inventory.stacks[0], reviewNumbers: [0] }] } });
  assert.ok(error);
  testHost.notify("stacks/changed", {});
  assert.equal(events.at(-1), "stacksChanged");
});

test("native open only acknowledges presentation and reservation tokens remain opaque", () => {
  let token: string | undefined;
  const acquire = stackAcquire(outcome => { token = outcome.result; });
  testHost.takeSent();
  testHost.reply(acquire, { token: "opaque-project-reservation" });
  assert.equal(token, "opaque-project-reservation");
  let opened = false;
  const open = stackOpen({ stack: "wt", fingerprint: "frozen", action: "landThrough", entry: "gg-2" }, outcome => { opened = outcome.result === true; });
  assert.deepEqual(testHost.takeSent().at(-1)?.params, { stack: "wt", fingerprint: "frozen", action: "landThrough", entry: "gg-2" });
  testHost.reply(open, { opened: true });
  assert.equal(opened, true);
  let released = false;
  const release = stackRelease(token!, outcome => { released = outcome.result === true; });
  assert.deepEqual(testHost.takeSent().at(-1)?.params, { token: "opaque-project-reservation" });
  testHost.reply(release, { released: true });
  assert.equal(released, true);
});

test("native applicability is an explicit boolean and is never inferred from failure", () => {
  const base = { complete: false, busy: false, stacks: [] };
  assert.equal(parseStackInventory(base)?.applicable, undefined);
  assert.equal(parseStackInventory({ ...base, applicable: false })?.applicable, false);
  assert.equal(parseStackInventory({ ...base, applicable: "false" }), undefined);
});

test("native diagnostics and commit titles do not invalidate stack ownership", () => {
  definePlugin({ handle() {} });
  const inventory = {
    complete: false, busy: false, applicable: true,
    stacks: [{
      id: "native", name: "feature", host: "gitlab.example.com", repo: "o/r", base: "main",
      fingerprint: "v1", complete: false, entries: [{ id: "entry", sha: "a".repeat(40), position: 1, number: 7, title: "Change" }],
      actions: ["open"],
    }],
  };
  const stack = inventory.stacks[0];
  const replies = [
    { ...inventory, error: "Worktree refresh failed.\n".repeat(400) },
    { ...inventory, stacks: [{ ...stack, unavailableActions: { land: "Unintegrated work.\n".repeat(300) } }] },
    { ...inventory, stacks: [{ ...stack, entries: [{ ...stack.entries[0], title: "Long commit subject ".repeat(300) }] }] },
  ];
  for (const reply of replies) {
    let result: unknown;
    let error: unknown;
    const id = stackList(true, outcome => { result = outcome.result; error = outcome.error; });
    testHost.takeSent();
    testHost.reply(id, { inventory: reply });
    assert.equal(error, undefined, "host presentation text must not become a malformed stacks/list reply");
    assert.deepEqual(result, reply);
  }
  assert.equal(parseStackInventory({ ...inventory, error: 123 }), undefined);
  assert.equal(parseStackInventory({ ...inventory, stacks: [{ ...stack, unavailableActions: { land: false } }] }), undefined);
});
