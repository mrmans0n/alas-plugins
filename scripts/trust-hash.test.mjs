import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("trust-hash", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "alas-trust-"));

function hash(...files) {
  const paths = files.map((bytes, i) => {
    const path = join(dir, `f${i}`);
    writeFileSync(path, bytes);
    return path;
  });
  return execFileSync(script, paths, { encoding: "utf8" }).trim();
}

// Digests computed with PluginTrust.hash from mrmans0n/alas (Swift, CryptoKit) on the same bytes.
test("without a page the hash stays v1", () => {
  assert.equal(hash("{}", "a"), "6e8248f7fc18935c12f797ac29956a8a81849156081446a447d560bcad2ad57e");
});

test("with a page the hash is framed v2, counting bytes not characters", () => {
  assert.equal(hash("{}", "a", "bc"), "7733fb773369110d58fbb3a557793481ee9e985bc2d0af683a9d1cebd962c982");
  assert.equal(hash('{"name":"é"}', Buffer.from([0, 1, 2]), "ü\0x"), "a8a73c9fbbf86a2b8022e6e522776668bc826d04963d584830021faabc763026");
  assert.equal(hash("{}", "a", ""), "ef01884551adf7b9d95bd070fccc15344e645d6b1091d13026fae3f2f4b10b8a");
});
