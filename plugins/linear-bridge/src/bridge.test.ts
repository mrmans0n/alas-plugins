import { test } from "node:test";
import assert from "node:assert/strict";
import { definePlugin } from "@alas/plugin";
import { testHost } from "@alas/plugin/test";
import { COMMENT_CHARS, ENDPOINT, LinearBridge, MISSING_KEY, PANEL, PROMPT_BYTES } from "./bridge.ts";

const issue = (i: number, fields: object = {}) => ({
  id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
  identifier: `ENG-${i}`,
  title: `Fix "thing" ${i}`,
  description: `Steps for ${i}`,
  url: `https://linear.app/acme/issue/ENG-${i}`,
  state: { name: i % 2 ? "In Progress" : "Todo", type: i % 2 ? "started" : "unstarted" },
  team: { key: "ENG" },
  ...fields,
});
const linear = (data: unknown, status = 200) => ({ status, headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
const issuesReply = (nodes: object[]) => linear({ data: { viewer: { assignedIssues: { nodes } } } });

function sentOne(sent: any[], method: string): any {
  const found = sent.filter((m) => m.method === method);
  assert.equal(found.length, 1, `one ${method} in ${JSON.stringify(sent.map((m) => m.method))}`);
  return found[0];
}

/** The last panel tree the plugin rendered, as JSON text. */
function lastPanel(sent: any[]): string {
  const renders = sent.filter((m) => m.method === "view/render");
  assert.ok(renders.length > 0, "rendered the panel");
  assert.equal(renders.at(-1).params.panel, PANEL);
  return JSON.stringify(renders.at(-1).params.root);
}

/** An activated bridge with `settings` and stored `sessions`; returns it and the issues fetch, unanswered. */
function activate(settings: object = {}, sessions: unknown = null, key = true) {
  testHost.takeSent();
  if (key) testHost.secrets.add("apiKey");
  else testHost.secrets.delete("apiKey");
  const bridge = definePlugin(new LinearBridge());
  testHost.dispatch({ jsonrpc: "2.0", id: 0, method: "alas/activate", params: { api: 5, project: { id: "p", name: "P" }, grants: [] } });
  const sent = testHost.takeSent();
  assert.deepEqual(sentOne(sent, "timer/set").params, { id: "refresh", seconds: 300, repeat: true });
  testHost.reply(sentOne(sent, "storage/get").id, { value: sessions });
  testHost.reply(sentOne(sent, "settings/get").id, { values: { teamKey: "", commentOnFinish: true, ...settings } });
  return { bridge, sent: testHost.takeSent() };
}

test("lists the viewer's open issues, filtered by team, and refreshes on the timer", () => {
  const { sent } = activate({ teamKey: " eng " });
  const fetch = sentOne(sent, "http/fetch");
  assert.equal(fetch.params.url, ENDPOINT);
  assert.deepEqual(fetch.params.headers, { Authorization: "{{secret:apiKey}}", "Content-Type": "application/json" });
  assert.deepEqual(JSON.parse(fetch.params.body).variables.filter, {
    state: { type: { in: ["unstarted", "started"] } },
    team: { key: { eqIgnoreCase: "eng" } },
  });

  // 50 issues, the most one query returns, render in one call within the send cap.
  testHost.reply(fetch.id, issuesReply(Array.from({ length: 50 }, (_, i) => issue(i + 1))));
  const reply = testHost.takeSent();
  assert.equal(reply.length, 1);
  const panel = JSON.parse(lastPanel(reply));
  const rows = panel.child.children.filter((n: any) => n.id.startsWith("row-"));
  assert.equal(rows.length, 50);
  assert.deepEqual(rows[0].children.map((n: any) => n.text ?? n.label ?? n.kind), ["ENG-1", 'Fix "thing" 1', "spacer", "In Progress", "Start"]);
  assert.equal(rows[0].children[3].tone, "accent");

  testHost.notify("timer/fired", { id: "refresh" });
  sentOne(testHost.takeSent(), "http/fetch");
});

test("Start starts a task for the issue, remembers its session and comments on the issue", () => {
  const { sent } = activate();
  const long = issue(7, { description: "é".repeat(20_000) });
  testHost.reply(sentOne(sent, "http/fetch").id, issuesReply([long]));
  testHost.takeSent();

  testHost.notify("view/event", { panel: PANEL, id: `start-${long.id}`, kind: "click" });
  const task = sentOne(testHost.takeSent(), "task/start");
  assert.equal(task.params.title, 'ENG-7 Fix "thing" 7');
  assert.equal(task.params.branch, "eng-7");
  assert.ok(task.params.prompt.startsWith(`Fix "thing" 7\n\n${long.url}\n\néé`));
  assert.ok(Buffer.byteLength(task.params.prompt) <= PROMPT_BYTES);

  testHost.reply(task.id, { sessionId: "s1", branch: "eng-7" });
  const after = testHost.takeSent();
  assert.deepEqual(sentOne(after, "storage/set").params, {
    key: "sessions",
    value: { s1: { issueId: long.id, identifier: "ENG-7", branch: "eng-7" } },
  });
  const comment = JSON.parse(sentOne(after, "http/fetch").params.body).variables;
  assert.deepEqual(comment, { issueId: long.id, body: "Started an agent in Alas on branch eng-7" });
  assert.match(lastPanel(after), /"label":"Started","disabled":true/);
});

test("a remembered session that finishes posts the agent's last message as a comment", () => {
  const started = { s1: { issueId: "issue-1", identifier: "ENG-1", branch: "eng-1" } };
  activate({}, started);
  testHost.notify("session/finished", { session: "other", worktree: "w" });
  assert.deepEqual(testHost.takeSent(), []);

  testHost.notify("session/finished", { session: "s1", worktree: "w" });
  const ask = sentOne(testHost.takeSent(), "session/last_message");
  assert.deepEqual(ask.params, { id: "s1" });
  testHost.reply(ask.id, { message: "x".repeat(5000) });
  const fetch = sentOne(testHost.takeSent(), "http/fetch");
  // The key never passes through the plugin: only the placeholder Alas substitutes.
  assert.equal(fetch.params.headers.Authorization, "{{secret:apiKey}}");
  const variables = JSON.parse(fetch.params.body).variables;
  assert.equal(variables.issueId, "issue-1");
  assert.equal(variables.body.length, COMMENT_CHARS);

  testHost.reply(fetch.id, linear({ data: { commentCreate: { success: true } } }));
  assert.deepEqual(sentOne(testHost.takeSent(), "notify").params, { title: "Commented on ENG-1" });

  // With commentOnFinish off nothing is asked.
  testHost.notify("settings/changed", { values: { teamKey: "", commentOnFinish: false } });
  testHost.takeSent();
  testHost.notify("session/finished", { session: "s1", worktree: "w" });
  assert.deepEqual(testHost.takeSent().filter((m) => m.method === "session/last_message"), []);
});

for (const [name, answer, expected] of [
  ["without an API key the panel asks for one", undefined, MISSING_KEY],
  ["a refused key shows Linear's status and message", { result: linear({ errors: [{ message: "Authentication required" }] }, 401) }, "Linear answered 401: Authentication required"],
  ["a network failure shows its reason", { error: "request failed: offline" }, "Linear request failed: request failed: offline"],
  ["a non-JSON body shows its status", { result: { status: 502, headers: {}, body: "Bad gateway" } }, "Linear answered 502: Bad gateway"],
] as const) {
  test(name, () => {
    const { sent } = activate({}, null, answer !== undefined);
    if (answer) {
      const id = sentOne(sent, "http/fetch").id;
      if ("error" in answer) testHost.replyError(id, -32003, answer.error);
      else testHost.reply(id, answer.result);
    }
    // Without a key Alas refuses the request itself, and the refusal already came back.
    const panel = lastPanel(answer ? testHost.takeSent() : sent);
    assert.ok(panel.includes(JSON.stringify(expected)), panel);
  });
}
