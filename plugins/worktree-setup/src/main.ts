// Sets up each new worktree: copies the configured files from the main worktree, then starts the
// setup command as a long-running process, which shows in that worktree's Run tab. The same calls
// work in remote projects (API 11, `remote: true`), where Alas runs them on the SSH host.
// The configuration lives in plugin-scoped storage and is edited in the configure sheet.

import {
  definePlugin, fileList, fileRead, fileWrite, log, notify, processStart, renderPanel, requestSnapshot, storageGet, storageSet,
  type Node, type Snapshot, type Worktree,
} from "@alas/plugin";
import { addFile, checkCommand, CONFIG_KEY, defaultConfig, parseConfig, sourceWorktree, splitPath, summary, type Config, type Report } from "./setup.ts";

const PANEL = "configure";

let config: Config | undefined;
let loadId: number | undefined;
let saveId: number | undefined;
/** New worktrees seen before the configuration loaded. */
let pending: string[] = [];
/** Callbacks for the snapshot being requested; one reply serves them all. */
let snapshotWaiters: ((snapshot: Snapshot) => void)[] = [];
let snapshotId: number | undefined;
let visible = false;
/** Bumped to reset the text fields to their `value`. */
let form = 0;
let error: string | undefined;
let status: string | undefined;

function withSnapshot(callback: (snapshot: Snapshot) => void): void {
  snapshotWaiters.push(callback);
  if (snapshotWaiters.length === 1) snapshotId = requestSnapshot();
}

/**
 * Copies one file at a time, so a setup keeps at most one request in flight, out of the
 * 4 an instance may have, then starts the command and notifies once.
 */
function setUp(target: Worktree, source: Worktree | undefined, cfg: Config): void {
  const report: Report = { branch: target.branch, copied: [], skipped: [] };
  const files = source && source.id !== target.id ? cfg.files : [];
  let i = 0;
  const done = () => {
    const { title, body } = summary(report);
    notify(title, body);
  };
  const next = (): void => {
    if (i < files.length) return void copy(files[i++]);
    if (!cfg.command) return done();
    report.command = cfg.command;
    processStart("setup", target.id, [cfg.command], ({ error }) => {
      if (error) report.commandError = error.message;
      done();
    });
  };
  const copy = (path: string) =>
    fileRead(source!.id, path, (read) => {
      if (read.error) {
        report.skipped.push({ path, reason: read.error.message });
        return next();
      }
      const { dir, name } = splitPath(path);
      // A missing folder fails the listing, which also means the file isn't there.
      fileList(target.id, dir, (list) => {
        if (list.result?.entries.some((e) => e.name === name)) return next();
        fileWrite(target.id, path, read.result, ({ error }) => {
          if (error) report.skipped.push({ path, reason: error.message });
          else report.copied.push(path);
          next();
        });
      });
    });
  next();
}

function onCreated(worktree: string): void {
  if (!config) return void pending.push(worktree);
  const cfg = config;
  if (!cfg.enabled || (cfg.files.length === 0 && !cfg.command)) return;
  withSnapshot((snapshot) => {
    const target = snapshot.worktrees.find((w) => w.id === worktree);
    if (target) setUp(target, sourceWorktree(snapshot.worktrees), cfg);
  });
}

/** The configure sheet's test button: the worktree selected in this project, enabled or not. */
function runNow(): void {
  const cfg = config!;
  withSnapshot((snapshot) => {
    const target = snapshot.worktrees.find((w) => w.current);
    if (!target) status = "No worktree is selected in this project.";
    else {
      status = `Setting up ${target.branch}; a notification reports the result.`;
      setUp(target, sourceWorktree(snapshot.worktrees), cfg);
    }
    draw();
  });
}

function save(next: Config): void {
  config = next;
  saveId = storageSet(CONFIG_KEY, next, "plugin");
  error = undefined;
  form++;
  draw();
}

const text = (id: string, value: string, style?: "caption" | "title" | "monospaced", tone?: "dim" | "danger"): Node => ({ kind: "text", id, text: value, style, tone });
const hstack = (id: string, children: Node[]): Node => ({ kind: "hstack", id, children, spacing: 8 });

function view(cfg: Config): Node {
  const children: Node[] = [
    hstack("enabled-row", [
      text("enabled-label", cfg.enabled ? "Runs when a worktree is created." : "Off: new worktrees are left alone."),
      { kind: "spacer", id: "enabled-space" },
      { kind: "button", id: "toggle", label: cfg.enabled ? "Turn off" : "Turn on", style: cfg.enabled ? "normal" : "primary" },
    ]),
    { kind: "divider", id: "d1" },
    text("files-heading", "Files to copy from the main worktree", "title"),
    text("files-hint", "UTF-8 text up to 512 KiB, copied only when the new worktree doesn't have it.", "caption", "dim"),
  ];
  if (cfg.files.length === 0) children.push(text("files-empty", "None.", "caption", "dim"));
  cfg.files.forEach((path, i) =>
    children.push(hstack(`file-${i}`, [text(`path-${i}`, path, "monospaced"), { kind: "spacer", id: `space-${i}` }, { kind: "button", id: `remove:${i}`, label: "Remove", style: "plain" }])));
  children.push(
    { kind: "textField", id: `add-${form}`, value: "", placeholder: "Add a file, e.g. .env.local (Return adds)" },
    { kind: "divider", id: "d2" },
    text("command-heading", "Setup command", "title"),
    text("command-hint", "Runs with /bin/sh -c in the new worktree and shows in its Run tab. Empty runs nothing.", "caption", "dim"),
    { kind: "textField", id: `command-${form}`, value: cfg.command, placeholder: "e.g. pnpm install (Return saves)" },
  );
  if (error) children.push(text("error", error, undefined, "danger"));
  children.push(
    { kind: "divider", id: "d3" },
    hstack("run-row", [
      { kind: "button", id: "run", label: "Run on current worktree now" },
      ...(status ? [text("status", status, "caption", "dim")] : []),
    ]),
  );
  return { kind: "scroll", id: "root", axis: "vertical", child: { kind: "vstack", id: "content", children, spacing: 8 } };
}

function draw(): void {
  if (visible) renderPanel(PANEL, config ? view(config) : { kind: "progress", id: "loading", text: "Loading…" });
}

function onPanelEvent(id: string, kind: string, value: string | undefined): void {
  const cfg = config!;
  if (kind === "click") {
    if (id === "toggle") return save({ ...cfg, enabled: !cfg.enabled });
    if (id === "run") return runNow();
    if (id.startsWith("remove:")) return save({ ...cfg, files: cfg.files.filter((_, i) => `remove:${i}` !== id) });
    return;
  }
  if (kind !== "submit" || value === undefined) return;
  if (id === `add-${form}`) {
    const added = addFile(cfg, value);
    if ("config" in added) return save(added.config);
    error = added.error;
  } else if (id === `command-${form}`) {
    const command = value.trim();
    error = checkCommand(command);
    if (!error) return save({ ...cfg, command });
  }
  draw();
}

definePlugin({
  handle(event) {
    switch (event.type) {
      case "activate":
        loadId = storageGet(CONFIG_KEY, "plugin");
        return;
      case "stored": {
        if (event.id !== loadId) return;
        loadId = undefined;
        if (event.error) log("warn", `Could not read the configuration: ${event.error.message}`);
        config = event.error ? (config ?? defaultConfig()) : parseConfig(event.value);
        const created = pending;
        pending = [];
        created.forEach(onCreated);
        return draw();
      }
      case "storageChanged":
        // Another project saved the configuration: read it again.
        if (event.key === CONFIG_KEY) loadId = storageGet(CONFIG_KEY, "plugin");
        return;
      case "reply":
        if (event.id === snapshotId && event.error) {
          log("warn", `Could not read the worktrees: ${event.error.message}`);
          snapshotWaiters = [];
          return;
        }
        if (event.id !== saveId || !event.error) return;
        error = `Could not save: ${event.error.message}`;
        return draw();
      case "snapshot": {
        const waiters = snapshotWaiters;
        snapshotWaiters = [];
        waiters.forEach((w) => w(event.snapshot));
        return;
      }
      case "worktreeCreated":
        return onCreated(event.worktree);
      case "panelVisible":
        if (event.panel !== PANEL) return;
        visible = event.visible;
        if (!visible) status = undefined;
        return draw();
      case "panelEvent":
        if (event.panel === PANEL && config) onPanelEvent(event.id, event.kind, event.value);
        return;
    }
  },
});
