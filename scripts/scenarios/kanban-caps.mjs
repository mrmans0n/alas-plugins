// Kanban at its caps, for scripts/jsc-run: a full index of long, escape-heavy titles posted whole to the
// page after every change, a snapshot that moves every ticket, 64 agents, and a ticket with a full body.
// Usage: node scripts/scenarios/kanban-caps.mjs > /tmp/kanban.jsonl
//        scripts/jsc-run plugins/kanban/dist/plugin.js /tmp/kanban.jsonl

const lines = [];
const out = (message) => lines.push(JSON.stringify({ jsonrpc: "2.0", ...message }));
const reply = (id, result) => out({ id, result });
const page = (message) => out({ method: "web/message", params: { tab: 0, message } });

// 200 characters, mixing accents, quotes, backslashes and line breaks.
const long = (n, seed) => `é"\\\n${seed} `.repeat(Math.ceil(n / 8)).slice(0, n);
const statuses = ["backlog", "todo", "in_progress", "in_review"];
const index = Array.from({ length: 300 }, (_, i) => ({
  number: i + 1,
  title: long(200, `KAN-${i + 1}`),
  status: i < 15 ? "done" : statuses[i % 4],
  priority: ["none", "low", "medium", "high", "urgent"][i % 5],
  assignee: `agent-${i % 64}`,
  session_id: `session-${i + 1}`,
  branch: `task/kan-${i + 1}-${"x".repeat(80)}`,
  agent_state: "running",
  following: i >= 15,
  seen: true,
  error: i % 7 === 0 ? long(500, "error") : undefined,
}));
const snapshot = (round) => ({
  worktrees: index.map((e, i) => ({
    id: `/Users/someone/code/.worktrees/project/kan-${i + 1}`,
    branch: e.branch,
    current: i === 0,
    dirty: { files: i, conflicts: 0 },
    // 30 go idle (and fetch their last message), the rest alternate between busy states.
    sessions: [{ id: e.session_id, agent: "claude", title: e.title, state: i % 2 === 0 && i < 60 ? (round % 2 ? "running" : "idle") : ["awaiting_input", "running"][round % 2] }],
  })),
});
const body = {
  description: long(4000, "description"),
  labels: Array.from({ length: 8 }, (_, i) => `label-${i}`),
  comments: Array.from({ length: 10 }, (_, i) => ({ author: i % 2 ? "you" : "agent", text: long(2000, `comment ${i}`) })),
};

// alas/activate asked for meta, index and board (ids 1-3), the snapshot (4) and the agents (5).
reply(1, { value: { version: 1, next_number: 301 } });
reply(2, { value: index });
reply(3, { value: null });
reply(4, { snapshot: snapshot(0) });
reply(5, { agents: Array.from({ length: 64 }, (_, i) => ({ id: `agent-${i}`, name: long(100, `Agent ${i}`) })) });
for (let i = 0; i < 20; i++) page({ type: "ready" });
for (let round = 1; round <= 10; round++) out({ method: "workspace/changed", params: { snapshot: snapshot(round) } });
reply("$session/last_message", { message: long(4000, "reply") });
reply("$storage/get", { value: body });
page({ type: "open", number: 20 });
reply("$storage/get", { value: body });
for (let i = 0; i < 10; i++) page({ type: "comment", number: 20, text: long(2000, `new comment ${i}`) });
page({ type: "describe", number: 20, text: long(4000, "edited") });
for (let i = 0; i < 20; i++) page({ type: "move", number: 40 + i, status: "todo", before: 100 });
page({ type: "close" });
page({ type: "move", number: 30, status: "done" });
page({ type: "delete", number: 31 });
page({ type: "create", title: "", description: long(4000, "A new ticket"), priority: "urgent", assignee: "agent-1" });
console.log(lines.join("\n"));
