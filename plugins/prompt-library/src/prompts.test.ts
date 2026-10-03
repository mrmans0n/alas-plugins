import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { expand, PROMPTS, templateFor } from "./prompts.ts";

test("every declared prompt has a template, and every template is declared", () => {
  const manifest = JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8"));
  const declared = manifest.contributes.prompts.map((p: { name: string }) => p.name);
  assert.deepEqual(declared.toSorted(), Object.keys(PROMPTS).toSorted());
  assert.deepEqual(manifest.settings.map((s: { key: string }) => s.key).toSorted(), declared.toSorted());
});

test("arguments fill {args}, and its line is dropped without them", () => {
  const prompt = { template: "Review this.\nFocus on: {args}\nBe brief." };
  assert.deepEqual(expand(prompt, "  error handling "), { text: "Review this.\nFocus on: error handling\nBe brief." });
  assert.deepEqual(expand(prompt, ""), { text: "Review this.\nBe brief." });
});

test("a template without {args} gets the arguments as their own paragraph", () => {
  assert.deepEqual(expand({ template: "Be terse." }, "the parser"), { text: "Be terse.\n\nthe parser" });
  assert.deepEqual(expand({ template: "Be terse." }, ""), { text: "Be terse." });
});

test("replacement patterns in arguments stay literal", () => {
  assert.deepEqual(expand({ template: "Explain {args}" }, "why $& and $1 break"), { text: "Explain why $& and $1 break" });
});

test("a prompt that needs arguments fails with its usage, and a template empty without them fails", () => {
  assert.deepEqual(expand(PROMPTS.explain, " "), { error: PROMPTS.explain.usage });
  assert.ok("error" in expand({ template: "{args}" }, ""));
});

test("a non-blank override replaces the built-in template, with \\n as a line break", () => {
  assert.equal(templateFor("review", { review: "  " }), PROMPTS.review);
  assert.deepEqual(templateFor("review", { review: " Check {args}\\nThen stop. " }), { template: "Check {args}\nThen stop." });
  assert.equal(templateFor("deploy", { deploy: "Ship it" }), undefined);
});
