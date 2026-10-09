import { test } from "node:test";
import assert from "node:assert/strict";
import { testHost } from "@alas/plugin/test";
import "./main.ts";

test("a finished turn updates the rail panel while only the panel is shown", () => {
  testHost.dispatch({ jsonrpc: "2.0", id: 0, method: "alas/activate", params: { api: 15, project: { id: "p", name: "P" }, grants: [] } });
  const reply = (method: string, result: unknown) => testHost.reply(testHost.takeSent().find((m) => m.method === method).id, result);
  reply("usage/turns", { turns: [] });
  reply("usage/limits", { limits: [] });
  testHost.takeSent();

  const finish = (id: number) => testHost.notify("turn/finished", {
    session: "s", worktree: "w", turn: { id, session: "s", project: "p", worktree: "w", agent: "claude", startedAt: Date.now() - 1000, endedAt: Date.now(), result: "completed" },
  });
  const posts = () => testHost.takeSent().filter((m) => m.method === "web/post" && m.params.message.type === "usage");

  finish(1);
  assert.equal(posts().length, 0, "nothing shown");
  testHost.notify("panel/visible", { panel: "rail", visible: true });
  finish(2);
  assert.ok(posts().some((m) => m.params.panel === "rail"));
});
