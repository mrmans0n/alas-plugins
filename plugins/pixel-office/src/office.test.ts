import { test } from "node:test";
import assert from "node:assert/strict";
import { definePlugin } from "@alas/plugin";
import { testHost } from "@alas/plugin/test";
import { ROOM_W } from "./layout.ts";
import { Office } from "./office.ts";

test("ticks present a frame and clicks focus the session", () => {
  definePlugin(new Office());
  testHost.takeSent();
  testHost.dispatch({
    jsonrpc: "2.0",
    method: "workspace/changed",
    params: { snapshot: { worktrees: [{ id: "w", branch: "main", current: true, sessions: [{ id: "s", agent: "claude", title: "T", state: "running" }] }] } },
  });
  testHost.dispatch({ jsonrpc: "2.0", method: "tick", params: { dt: 66 } });
  const frames = testHost.takeFrames();
  assert.equal(frames.length, 1);
  assert.equal(frames[0].width, ROOM_W);
  // r0 is the desk; the character follows it.
  testHost.dispatch({ jsonrpc: "2.0", method: "canvas/click", params: { tab: 0, region: "r1" } });
  const sent = testHost.takeSent();
  assert.ok(sent.some((m) => m.method === "canvas/regions"));
  assert.ok(sent.some((m) => m.method === "session/focus" && m.params.id === "s"));
});

test("an error reply is logged and ignored", () => {
  definePlugin(new Office());
  testHost.takeSent();
  testHost.dispatch({ jsonrpc: "2.0", id: 7, error: { code: -32003, message: "unknown session s" } });
  assert.equal(testHost.takeSent()[0].params.level, "warn");
});
