import { test } from "node:test";
import assert from "node:assert/strict";
import { addFile, checkCommand, checkPath, defaultConfig, MAX_FILES, parseConfig, sourceWorktree, splitPath, summary } from "./setup.ts";

test("paths must stay inside the worktree and away from .git", () => {
  for (const ok of [".env", ".env.local", "config/local.json", "a/.gitignore"]) assert.equal(checkPath(ok), undefined, ok);
  for (const bad of ["", "/etc/passwd", "~/.env", "../.env", "a/../../b", "./.env", "a//b", "config/", ".git/config", "sub/.GIT/hooks"]) {
    assert.ok(checkPath(bad), bad);
  }
});

test("a stored configuration round-trips, and malformed parts fall back without losing the rest", () => {
  const config = { enabled: false, files: [".env", "config/local.json"], command: "pnpm install" };
  assert.deepEqual(parseConfig(JSON.parse(JSON.stringify(config))), config);
  assert.deepEqual(parseConfig(null), defaultConfig());
  assert.deepEqual(parseConfig({ enabled: "yes", files: [".env", "../x", 3, ".env"], command: "a\nb" }), { enabled: true, files: [".env"], command: "" });
});

test("commands are one line of at most 1 KiB of UTF-8", () => {
  assert.equal(checkCommand("pnpm install && cp .env.example .env"), undefined);
  assert.equal(checkCommand("é".repeat(512)), undefined);
  assert.ok(checkCommand("é".repeat(513)));
  assert.ok(checkCommand("a\nb"));
});

test("adding a file trims it and refuses invalid, duplicate and excess paths", () => {
  const added = addFile(defaultConfig(), "  .env ");
  assert.deepEqual(added, { config: { ...defaultConfig(), files: [".env"] } });
  assert.ok("error" in addFile({ ...defaultConfig(), files: [".env"] }, ".env"));
  assert.ok("error" in addFile(defaultConfig(), "../.env"));
  const full = { ...defaultConfig(), files: Array.from({ length: MAX_FILES }, (_, i) => `f${i}`) };
  assert.ok("error" in addFile(full, "one-more"));
});

test("files come from the main worktree, else the first", () => {
  const wt = (id: string, main?: boolean) => ({ id, branch: id, current: false, main, sessions: [] });
  assert.equal(sourceWorktree([wt("a"), wt("b", true)])?.id, "b");
  assert.equal(sourceWorktree([wt("a"), wt("b")])?.id, "a");
  assert.equal(sourceWorktree([]), undefined);
});

test("a path splits into the folder to list and the name to find", () => {
  assert.deepEqual(splitPath(".env"), { dir: "", name: ".env" });
  assert.deepEqual(splitPath("config/dev/local.json"), { dir: "config/dev", name: "local.json" });
});

test("the notification sums up copies and the command, with skips and refusals in the body", () => {
  assert.deepEqual(summary({ branch: "feature-x", copied: [".env", ".env.local"], skipped: [], command: "pnpm install" }), {
    title: "Set up feature-x: copied 2 files, running `pnpm install`",
    body: undefined,
  });
  const refused = "plugin commands can't run on macOS SSH hosts: macOS can't guarantee that everything a command starts is stopped";
  assert.deepEqual(
    summary({ branch: "b", copied: ["a"], skipped: [{ path: "big.bin", reason: "not UTF-8" }], command: "make", commandError: refused }),
    { title: "Set up b: copied 1 file, could not run `make`", body: `${refused}\nSkipped big.bin: not UTF-8` },
  );
  assert.equal(summary({ branch: "b", copied: [], skipped: [] }).title, "Set up b: nothing to do");
  assert.ok(summary({ branch: "b", copied: [], skipped: [{ path: "x", reason: "r".repeat(2000) }] }).body!.length <= 600);
});
