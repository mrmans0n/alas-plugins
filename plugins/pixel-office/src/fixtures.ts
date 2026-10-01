import type { Snapshot } from "@alas/plugin";

/** Worktree `w<i>` holds `counts[i]` running sessions `w<i>s<j>`; the first worktree is current. */
export function snapshot(counts: number[]): Snapshot {
  return {
    worktrees: counts.map((n, w) => ({
      id: `w${w}`,
      branch: `b${w}`,
      current: w === 0,
      dirty: null,
      sessions: Array.from({ length: n }, (_, s) => ({ id: `w${w}s${s}`, agent: "claude", title: `T${s}`, state: "running", plan: null })),
    })),
  };
}
