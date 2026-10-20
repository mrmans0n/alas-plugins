import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePageMessage } from "./protocol.ts";

test("well-formed page messages pass through with only their fields", () => {
  assert.deepEqual(parsePageMessage({ type: "ready", extra: 1 }), { type: "ready" });
  assert.deepEqual(parsePageMessage({ type: "merge", number: 3 }), { type: "merge", number: 3 });
  assert.deepEqual(parsePageMessage({ type: "attempt", run: 10, attempt: 2 }), { type: "attempt", run: 10, attempt: 2 });
  assert.deepEqual(parsePageMessage({ type: "question", token: 1, text: "Why?" }), { type: "question", token: 1, text: "Why?" });
  assert.deepEqual(parsePageMessage({ type: "session", token: 1, session: "abc_1-2" }), { type: "session", token: 1, session: "abc_1-2" });
});

test("anything malformed is ignored", () => {
  for (const m of [null, [], "merge", { type: "nope" }, { type: "merge" }, { type: "merge", number: "3" }, { type: "merge", number: 0 }, { type: "merge", number: 1.5 },
    { type: "doctor", number: -1 }, { type: "attempt", run: 10 }, { type: "question", token: 1 }, { type: "question", token: 1, text: "x".repeat(8001) },
    { type: "session", token: 1, session: "../x" }, { type: "session", token: 1, session: "a".repeat(49) }]) {
    assert.equal(parsePageMessage(m), undefined, JSON.stringify(m));
  }
});
