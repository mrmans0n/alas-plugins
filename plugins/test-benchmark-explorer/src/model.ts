export interface Selection { id: string; worktree: string }
export interface Profile {
  id: string; script: string; target?: string; toolchain?: string; configuration?: string;
  artifacts: { path: string; format: "junit" | "benchmark" | "xcresult"; directory?: boolean }[];
  thresholds?: Record<string, number>;
}
export interface Config { profiles: Profile[] }
export interface Summary {
  schema: 1; id: string; project: string; worktree: string; hostKey: string; host: string;
  run?: string; script?: string; capturedAt: number; complete: boolean; detail: string;
  counts: Record<string, number | string>;
  source: { state: string; head?: string; reason?: string; checkedAt?: number };
  command: { outcome: string; argv: string[]; exit?: number; startedAt?: number; endedAt?: number };
  conditions?: Record<string, unknown>; issues: { message: string; path?: string }[];
  artifacts?: Record<string, unknown>[]; artifactCount?: number;
}
export interface State { schema: 1; config: Config; runs: Summary[]; selected?: Selection; baseline?: Selection }
export const object = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
export const captureID = (v: unknown): v is string => typeof v === "string" && /^(?:[a-f0-9]{32}|[a-f0-9]{64})$/.test(v);
export const same = (a?: Selection, b?: Selection): boolean => !!a && !!b && a.id === b.id && a.worktree === b.worktree;
const text = (v: unknown, length = 512): string => typeof v === "string" ? v.slice(0, length) : "";
export const emptyState = (): State => ({ schema: 1, config: { profiles: [] }, runs: [] });

export function parseConfig(value: unknown): Config {
  if (!object(value) || !Array.isArray(value.profiles) || value.profiles.length > 16 || JSON.stringify(value).length * 3 > 16384) throw new Error("Configuration needs profiles and must fit within 16 KiB.");
  const ids = new Set<string>();
  for (const p of value.profiles) {
    if (!object(p) || typeof p.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(p.id) || ids.has(p.id) || typeof p.script !== "string" || !p.script || p.script.length > 1024) throw new Error("Each profile needs a unique ID and a run-script key.");
    ids.add(p.id);
    if (!Array.isArray(p.artifacts) || p.artifacts.length < 1 || p.artifacts.length > 16 || p.artifacts.some((a: unknown) => !object(a) || typeof a.path !== "string" || !a.path || a.path.length > 4096 || /\\|\0/.test(a.path) || a.path.split("/").some((s: string) => !s || s === "." || s === ".." || s.toLowerCase() === ".git") || !["junit", "benchmark", "xcresult"].includes(a.format))) throw new Error("Artifact paths must stay inside the output/worktree and use a supported format.");
    for (const field of ["target", "toolchain", "configuration"]) if (p[field] !== undefined && (typeof p[field] !== "string" || p[field].length > 512)) throw new Error("Condition labels must be strings up to 512 characters.");
  }
  return value as Config;
}

export function parseSummary(v: unknown, project: string, worktree: string, hostKey: string): Summary {
  if (!object(v) || v.schema !== 1 || !captureID(v.id) || v.project !== project || v.worktree !== worktree || v.hostKey !== hostKey || !object(v.counts) || !object(v.source) || !object(v.command) || typeof v.capturedAt !== "number" || !Number.isFinite(v.capturedAt)) throw new Error("Structured result identity or model did not validate.");
  const counts: Record<string, number | string> = {};
  for (const key of ["tests", "attempts", "benchmarks", "passed", "failed", "error", "skipped", "unknown"]) counts[key] = typeof v.counts[key] === "number" && Number.isFinite(v.counts[key]) && v.counts[key] >= 0 ? v.counts[key] : 0;
  counts.state = v.complete !== true ? "incomplete" : (counts.failed as number) + (counts.error as number) > 0 ? "failed" : (counts.unknown as number) > 0 ? "unknown" : (counts.passed as number) > 0 ? "passed" : "no tests";
  const states = ["current", "stale", "changed during run", "unknown"];
  const source = { state: states.includes(v.source.state) ? v.source.state : "unknown", head: text(v.source.head, 128) || undefined,
    reason: text(v.source.reason, 1024) || undefined, checkedAt: typeof v.source.checkedAt === "number" ? v.source.checkedAt : undefined };
  const command = { outcome: ["succeeded", "failed", "stopped", "unknown"].includes(v.command.outcome) ? v.command.outcome : "unknown",
    argv: Array.isArray(v.command.argv) ? v.command.argv.slice(0, 16).map((a: unknown) => text(a, 512)) : [],
    exit: typeof v.command.exit === "number" ? v.command.exit : undefined, startedAt: v.command.startedAt, endedAt: v.command.endedAt };
  return { schema: 1, id: v.id, project, worktree, hostKey, host: text(v.host, 256), run: text(v.run, 128) || undefined,
    script: text(v.script, 1024) || undefined, capturedAt: v.capturedAt, complete: v.complete === true, detail: text(v.detail, 32), counts, source, command,
    conditions: object(v.conditions) ? Object.fromEntries(["host", "toolchain", "configuration", "target"].map(k => [k, text(v.conditions[k], 512) || null])) : {},
    issues: Array.isArray(v.issues) ? v.issues.slice(0, 8).filter(object).map(i => ({ message: text(i.message), path: text(i.path) })) : [],
    artifacts: Array.isArray(v.artifacts) ? v.artifacts.slice(0, 16).filter(object).map(a => Object.fromEntries(["id", "path", "digest", "format"].map(k => [k, text(a[k], 1024)]))) : [], artifactCount: v.artifactCount };
}

export function remember(state: State, value: unknown, project: string, worktree: string, hostKey: string): Summary {
  const summary = parseSummary(value, project, worktree, hostKey);
  state.runs = [summary, ...state.runs.filter(r => !same(r, summary) && !(summary.run && r.run === summary.run && r.worktree === summary.worktree))]
    .sort((a, b) => b.capturedAt - a.capturedAt);
  serializeState(state);
  return summary;
}

export function serializeState(state: State): string {
  const trim = (): boolean => {
    for (let i = state.runs.length - 1; i >= 0; i--) if (!same(state.runs[i], state.selected) && !same(state.runs[i], state.baseline)) { state.runs.splice(i, 1); return true; }
    return false;
  };
  while (state.runs.length > 40 && trim()) { /* retain the current result and baseline */ }
  let json = JSON.stringify(state);
  while (json.length * 3 > 512 * 1024 && trim()) json = JSON.stringify(state);
  if (json.length * 3 > 512 * 1024) throw new Error("Explorer state exceeds its storage budget.");
  return json;
}

export function restoreState(value: unknown): State {
  const state = emptyState();
  if (!object(value) || value.schema !== 1) return state;
  state.config = parseConfig(value.config);
  for (const field of ["selected", "baseline"] as const) if (object(value[field]) && captureID(value[field].id) && typeof value[field].worktree === "string") state[field] = { id: value[field].id, worktree: value[field].worktree };
  if (Array.isArray(value.runs)) for (const run of value.runs.slice(0, 40).reverse()) {
    if (!object(run)) continue;
    try { remember(state, { ...run, source: { ...run.source, state: "unknown", checkedAt: undefined, reason: "Refresh source verification after restart" } }, run.project, run.worktree, run.hostKey); } catch { /* one damaged record does not erase the rest */ }
  }
  return state;
}
