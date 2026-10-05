// Agent Usage over a busy 90 days, for scripts/jsc-run: the page asks for every project, the plugin
// pages through 12,000 turns (1,000 per reply, the most `usage/turns` sends) and 50 limit episodes,
// then folds in finished turns while the tab is visible. Each page must fold within the call limit.
// Usage: node scripts/scenarios/agent-usage-90d.mjs > /tmp/agent-usage.jsonl
//        scripts/jsc-run plugins/agent-usage/dist/plugin.js /tmp/agent-usage.jsonl

const lines = [];
const out = (message) => lines.push(JSON.stringify({ jsonrpc: "2.0", ...message }));
const now = Date.now();
const agents = ["claude", "codex", "gemini", "opencode", "amp", "cursor", "goose", "qwen", "kimi"];
const turn = (id, endedAt) => ({
  id, session: `session-${id % 300}`, project: `project-${id % 9}`, worktree: `worktree-${id % 80}`,
  agent: agents[id % agents.length], model: `model-${id % 23}`,
  startedAt: endedAt - 30_000 - (id % 600) * 1000, endedAt,
  result: ["completed", "completed", "completed", "failed", "cancelled", "limited"][id % 6],
  tokens: { total: 50_000 + id, input: 4_000, cachedInput: 40_000, cachedWrite: 1_000, output: 4_000 + id, reasoningOutput: 1_000 },
  ...(id % 4 ? { cost: { amount: 0.01 * (id % 50), currency: id % 10 ? "USD" : "EUR" } } : {}),
});

const total = 12_000;
const span = 89 * 86_400_000;
out({ method: "workspace/changed", params: { snapshot: { worktrees: Array.from({ length: 80 }, (_, i) => ({ id: `worktree-${i}`, branch: `feature/${"x".repeat(60)}-${i}`, current: i === 0, sessions: [] })) } } });
out({ method: "tab/visible", params: { tab: 0, visible: true } });
out({ method: "web/message", params: { tab: 0, message: { type: "load", range: 90, scope: "all" } } });
for (let page = 0; page < total / 1000; page++) {
  const turns = Array.from({ length: 1000 }, (_, i) => {
    const id = total - (page * 1000 + i);
    return turn(id, now - span + Math.floor((id / total) * span));
  });
  const last = turns.at(-1);
  const more = page < total / 1000 - 1;
  out({ id: "$usage/turns", result: { turns, truncated: more, ...(more ? { next: { before: last.endedAt, beforeId: last.id } } : {}) } });
}
out({ id: "$usage/limits", result: { truncated: false, limits: Array.from({ length: 50 }, (_, i) => ({
  session: `session-${i}`, project: `project-${i % 9}`, worktree: `worktree-${i}`, agent: agents[i % agents.length],
  detectedAt: now - i * 3_600_000, resetsAt: now + i * 60_000, resetSource: "parsed",
})) } });
for (let i = 1; i <= 20; i++) out({ method: "turn/finished", params: { session: "s", worktree: "worktree-0", turn: turn(total + i, now) } });
console.log(lines.join("\n"));
