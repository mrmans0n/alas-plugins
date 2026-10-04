// The pure half of the plugin: the stored configuration, path rules, which worktree is the
// source, and the notification a setup ends with.

import type { Worktree } from "@alas/plugin";

/** Plugin-scoped storage key, so every project shares one configuration. */
export const CONFIG_KEY = "config";
export const MAX_FILES = 32;
/** A process argument is at most 1 KiB, and the command is passed as one. */
export const MAX_COMMAND_BYTES = 1024;

export interface Config {
  enabled: boolean;
  /** Paths relative to the worktree, checked with `checkPath`. */
  files: string[];
  /** A `/bin/sh -c` script; empty runs nothing. */
  command: string;
}

export const defaultConfig = (): Config => ({ enabled: true, files: [], command: "" });

/** Reads a stored value; anything malformed falls back to the defaults, an invalid path is dropped. */
export function parseConfig(value: unknown): Config {
  const config = defaultConfig();
  if (typeof value !== "object" || value === null) return config;
  const v = value as Record<string, unknown>;
  if (typeof v.enabled === "boolean") config.enabled = v.enabled;
  if (Array.isArray(v.files)) {
    const files = v.files.filter((f): f is string => typeof f === "string" && checkPath(f) === undefined);
    config.files = [...new Set(files)].slice(0, MAX_FILES);
  }
  if (typeof v.command === "string" && checkCommand(v.command.trim()) === undefined) config.command = v.command.trim();
  return config;
}

/** Why `path` can't be copied, or `undefined`. Alas refuses the same things; this says so up front. */
export function checkPath(path: string): string | undefined {
  if (!path) return "Enter a path.";
  if (path.length > 1024) return "The path is too long.";
  if (path.startsWith("/") || path.startsWith("~")) return "Use a path relative to the worktree, like .env or config/local.json.";
  for (const part of path.split("/")) {
    if (part === "" || part === ".") return "The path has an empty or `.` component.";
    if (part === "..") return "The path can't contain `..`.";
    if (part.toLowerCase() === ".git") return "Alas never lets plugins touch `.git`.";
  }
  return undefined;
}

export function checkCommand(command: string): string | undefined {
  let bytes = 0;
  for (const ch of command) {
    const c = ch.codePointAt(0)!;
    bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  if (/[\r\n]/.test(command)) return "Use one line; join commands with && or ;.";
  return bytes > MAX_COMMAND_BYTES ? "The command is over 1 KiB." : undefined;
}

/** Adds a path typed in the configure sheet, or says why it can't. */
export function addFile(config: Config, input: string): { config: Config } | { error: string } {
  const path = input.trim();
  const error = checkPath(path);
  if (error) return { error };
  if (config.files.includes(path)) return { error: `${path} is already in the list.` };
  if (config.files.length >= MAX_FILES) return { error: `At most ${MAX_FILES} files.` };
  return { config: { ...config, files: [...config.files, path] } };
}

/** Where files are copied from: the main worktree, else the first. */
export const sourceWorktree = (worktrees: Worktree[]): Worktree | undefined => worktrees.find((w) => w.main) ?? worktrees[0];

/** The folder `file/list` takes (`""` for the worktree itself) and the entry name to look for. */
export function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf("/");
  return { dir: path.slice(0, slash < 0 ? 0 : slash), name: path.slice(slash + 1) };
}

export interface Report {
  /** The new worktree's branch. */
  branch: string;
  copied: string[];
  /** Files left alone and why; existing ones are not reported. */
  skipped: { path: string; reason: string }[];
  command?: string;
  /** Why the command didn't start. */
  commandError?: string;
}

const MAX_BODY = 600;

export function summary(r: Report): { title: string; body?: string } {
  const parts: string[] = [];
  if (r.copied.length > 0) parts.push(`copied ${r.copied.length} file${r.copied.length === 1 ? "" : "s"}`);
  if (r.command) parts.push(`${r.commandError ? "could not run" : "running"} \`${r.command}\``);
  if (parts.length === 0) parts.push("nothing to do");
  const lines = r.skipped.map((s) => `Skipped ${s.path}: ${s.reason}`);
  if (r.commandError) lines.unshift(r.commandError);
  const body = lines.join("\n");
  return { title: `Set up ${r.branch}: ${parts.join(", ")}`, body: body ? (body.length > MAX_BODY ? `${body.slice(0, MAX_BODY - 1)}…` : body) : undefined };
}
