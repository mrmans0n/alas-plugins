// Linear bridge at its caps, for scripts/jsc-run: 50 assigned issues with long, escape-heavy
// titles and descriptions, rendered on every refresh, then a start and a finish comment.
// Usage: node scripts/scenarios/linear-bridge-50.mjs > /tmp/linear.jsonl
//        scripts/jsc-run plugins/linear-bridge/dist/plugin.js /tmp/linear.jsonl

const lines = [];
const out = (message) => lines.push(JSON.stringify({ jsonrpc: "2.0", ...message }));
const reply = (id, result) => out({ id, result });
const linear = (data) => ({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ data }) });

const long = (n, seed) => `é"\\\n${seed} `.repeat(Math.ceil(n / 8)).slice(0, n);
const nodes = Array.from({ length: 50 }, (_, i) => ({
  id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
  identifier: `ENG-${i + 1}`,
  title: long(250, `ENG-${i + 1}`),
  description: long(8000, "description"),
  url: `https://linear.app/acme/issue/ENG-${i + 1}`,
  state: { name: i % 2 ? "In Progress" : "Todo", type: i % 2 ? "started" : "unstarted" },
  team: { key: "ENG" },
}));
const issues = linear({ viewer: { assignedIssues: { nodes } } });

reply("$storage/get", { value: null });
reply("$timer/set", {});
reply("$settings/get", { values: { teamKey: "", commentOnFinish: true } });
reply("$http/fetch", issues);
for (let i = 0; i < 10; i++) {
  out({ method: i % 2 ? "timer/fired" : "panel/visible", params: i % 2 ? { id: "refresh" } : { panel: "issues", visible: true } });
  reply("$http/fetch", issues);
}
out({ method: "view/event", params: { panel: "issues", id: `start-${nodes[3].id}`, kind: "click" } });
reply("$task/start", { sessionId: "s1", branch: "eng-4" });
reply("$http/fetch", linear({ commentCreate: { success: true } }));
out({ method: "session/finished", params: { session: "s1", worktree: "w" } });
reply("$session/last_message", { message: long(20000, "reply") });
reply("$http/fetch", linear({ commentCreate: { success: true } }));
console.log(lines.join("\n"));
