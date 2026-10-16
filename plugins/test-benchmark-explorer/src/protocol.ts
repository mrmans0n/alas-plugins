import { captureID, object, type Selection } from "./model.ts";

export type PageMessage =
  | { type: "ready" | "refresh" }
  | ({ type: "select" | "baseline" } & Selection)
  | { type: "clearBaseline" }
  | { type: "install"; worktree: string }
  | { type: "configure"; json: string }
  | { type: "manual"; worktree: string; path: string; format: "junit" | "benchmark" | "xcresult"; directory: boolean }
  | { type: "query"; kind: "tests" | "benchmarks"; search: string; status: string; offset: number; compare: boolean }
  | { type: "brief"; selected: number[]; selectedBenchmarks?: number[] }
  | { type: "evidence"; rowIndex: number; kind: "tests" | "benchmarks"; offset: number };

export function pageMessage(v: unknown): PageMessage | undefined {
  if (!object(v)) return;
  if (["ready", "refresh", "clearBaseline"].includes(v.type)) return { type: v.type } as PageMessage;
  if (["select", "baseline"].includes(v.type) && captureID(v.id) && typeof v.worktree === "string") return { type: v.type, id: v.id, worktree: v.worktree };
  if (v.type === "install" && typeof v.worktree === "string") return { type: "install", worktree: v.worktree };
  if (v.type === "configure" && typeof v.json === "string" && v.json.length <= 16384) return { type: "configure", json: v.json };
  if (v.type === "manual" && typeof v.worktree === "string" && typeof v.path === "string" && v.path.length <= 4096 && ["junit", "benchmark", "xcresult"].includes(v.format)) return { type: "manual", worktree: v.worktree, path: v.path, format: v.format, directory: v.directory === true };
  if (v.type === "query" && ["tests", "benchmarks"].includes(v.kind) && typeof v.search === "string" && v.search.length <= 1024 && ["all", "passed", "failed", "error", "skipped", "unknown"].includes(v.status) && Number.isInteger(v.offset) && v.offset >= 0 && v.offset <= 100000) return { type: "query", kind: v.kind, search: v.search, status: v.status, offset: v.offset, compare: v.compare === true };
  const indices = (a: unknown): a is number[] => Array.isArray(a) && a.length <= 1000 && a.every((n: unknown) => Number.isInteger(n) && (n as number) >= 0 && (n as number) < 100000);
  if (v.type === "brief" && indices(v.selected) && (v.selectedBenchmarks === undefined || indices(v.selectedBenchmarks))) return { type: "brief", selected: v.selected, selectedBenchmarks: v.selectedBenchmarks };
  if (v.type === "evidence" && Number.isInteger(v.rowIndex) && v.rowIndex >= 0 && v.rowIndex < 100000 && ["tests", "benchmarks"].includes(v.kind) && Number.isInteger(v.offset) && v.offset >= 0 && v.offset <= 16777216) return { type: "evidence", rowIndex: v.rowIndex, kind: v.kind, offset: v.offset };
}
