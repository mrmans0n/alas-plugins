// A busy Pixel Office for scripts/jsc-run: more worktrees than desks, every seat taken, every
// mood, and moods and dirty files changing while characters walk.
// Usage: node scripts/scenarios/pixel-office-busy.mjs > /tmp/office.jsonl
//        scripts/jsc-run plugins/pixel-office/dist/plugin.js /tmp/office.jsonl --png /tmp/office.png

const lines = [];
const out = (message) => lines.push(JSON.stringify({ jsonrpc: "2.0", ...message }));
const states = ["running", "awaiting_input", "permission_request", "idle", "running", "mystery"];
const agents = ["claude", "codex", "gemini", "copilot", "cursor", "opencode", "pi"];

const snapshot = (round) => ({
  worktrees: Array.from({ length: 16 }, (_, w) => ({
    id: `/Users/someone/code/.worktrees/project/feature-${w}`,
    branch: `nacho/a-rather-long-feature-branch-${w}`,
    current: w === 3,
    dirty: { files: (w * 7 + round * 5) % 30, conflicts: (w + round) % 5 === 0 ? 1 : 0 },
    sessions: Array.from({ length: 6 }, (_, s) => ({
      id: `00000000-0000-0000-0000-${String(w * 10 + s).padStart(12, "0")}`,
      agent: agents[(w + s) % agents.length],
      title: `Investigate the flaky checkout #${w}-${s}`,
      state: states[(w + s + round) % states.length],
      plan: { completed: (s + round) % 6, total: 5 },
    })),
  })),
});

out({ id: "$workspace/snapshot", result: { snapshot: snapshot(0) } });
for (let tick = 1; tick <= 450; tick++) {
  if (tick === 150 || tick === 300) out({ method: "workspace/changed", params: { snapshot: snapshot(tick / 150) } });
  out({ method: "tick", params: { dt: 66 } });
}
out({ method: "canvas/click", params: { tab: 0, region: "r20" } });
console.log(lines.join("\n"));
