import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePageMessage } from "./protocol.ts";

test("well-formed page messages pass through with only their fields", () => {
  assert.deepEqual(parsePageMessage({ type: "ready", extra: 1 }), { type: "ready" });
  assert.deepEqual(parsePageMessage({ type: "add", iid: 3 }), { type: "add", iid: 3 });
  assert.deepEqual(parsePageMessage({ type: "retryJob", job: 9 }), { type: "retryJob", job: 9 });
  assert.deepEqual(parsePageMessage({ type: "retryPipeline", pipeline: 9 }), { type: "retryPipeline", pipeline: 9 });
  assert.deepEqual(parsePageMessage({ type: "attempt", run: 10, attempt: 2 }), { type: "attempt", run: 10, attempt: 2 });
  assert.deepEqual(parsePageMessage({ type: "question", token: 1, text: "Why?" }), { type: "question", token: 1, text: "Why?" });
  assert.deepEqual(parsePageMessage({ type: "session", token: 1, session: "abc_1-2" }), { type: "session", token: 1, session: "abc_1-2" });
  assert.deepEqual(parsePageMessage({ type: "scope", mine: true, extra: 1 }), { type: "scope", mine: true });
  assert.deepEqual(parsePageMessage({ type: "scope", mine: false }), { type: "scope", mine: false });
});

test("anything malformed is ignored", () => {
  for (const m of [null, [], "add", { type: "nope" }, { type: "add" }, { type: "add", iid: "3" }, { type: "add", iid: 0 }, { type: "add", iid: 1.5 }, { type: "merge", number: 3 }, { type: "retryJob", job: "9" },
    { type: "doctor", iid: -1 }, { type: "attempt", run: 10 }, { type: "question", token: 1 }, { type: "question", token: 1, text: "x".repeat(8001) },
    { type: "scope" }, { type: "scope", mine: "true" }, { type: "scope", mine: 1 }, { type: "scope", mine: null },
    { type: "session", token: 1, session: "../x" }, { type: "session", token: 1, session: "a".repeat(49) }]) {
    assert.equal(parsePageMessage(m), undefined, JSON.stringify(m));
  }
});
