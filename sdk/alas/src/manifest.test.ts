import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// JSON imports lose their literal types, so each manifest is pasted into a TypeScript file as an
// object literal `satisfies Manifest` and checked with tsc. A known-bad manifest proves the check bites.
test("every plugin's plugin.json satisfies Manifest", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const sdk = join(root, "sdk/alas/src/index.ts");
  const dir = mkdtempSync(join(tmpdir(), "alas-manifests-"));
  const plugins = readdirSync(join(root, "plugins")).toSorted();
  const check = (name: string, json: string) =>
    writeFileSync(join(dir, `${name}.ts`), `import type { Manifest } from ${JSON.stringify(sdk)};\nexport default (${json.trim()}) satisfies Manifest;\n`);
  for (const p of plugins) check(p, readFileSync(join(root, "plugins", p, "plugin.json"), "utf8"));
  check("known-bad", JSON.stringify({ id: "a.b", name: "x", version: "1", api: 9, entry: "plugin.js", contributes: { panels: [{ id: "c", title: "C", location: "settings" }] } }));
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, module: "preserve", moduleResolution: "bundler", allowImportingTsExtensions: true, types: [], skipLibCheck: true },
    include: ["*.ts"],
  }));
  let output = "";
  try {
    execFileSync(join(root, "node_modules/.bin/tsc"), ["-p", dir], { encoding: "utf8" });
  } catch (e: any) {
    output = `${e.stdout}${e.stderr}`;
  }
  const failing = [...new Set([...output.matchAll(/([\w-]+)\.ts\(\d+/g)].map((m) => m[1]))];
  assert.deepEqual(failing, ["known-bad"], output);
  assert.ok(plugins.length > 0);
});
