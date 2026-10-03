import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { expand, legacyOverrides, parseLibrary, PROMPTS, promptFor, validateCustom, type Library } from "./prompts.ts";

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

test("old one-line settings become overrides, with \\n as a line break", () => {
  assert.deepEqual(legacyOverrides({ review: " Check {args}\\nThen stop. ", fix: "  ", deploy: "Ship it" }), { review: "Check {args}\nThen stop." });
});

test("built-ins resolve to their override when set, custom prompts to their template", () => {
  const library: Library = { custom: [{ name: "deploy", description: "", template: "Ship {args}" }], overrides: { review: "Only bugs." } };
  assert.deepEqual(promptFor("review", library), { template: "Only bugs." });
  assert.equal(promptFor("fix", library), PROMPTS.fix);
  assert.deepEqual(promptFor("deploy", library), { template: "Ship {args}" });
  assert.equal(promptFor("constructor", library), undefined);
});

test("a stored library round-trips, dropping malformed, clashing and repeated prompts", () => {
  const library: Library = { custom: [{ name: "deploy", description: "Ship it", template: "Ship {args}" }], overrides: { review: "Only bugs." } };
  assert.deepEqual(parseLibrary(JSON.parse(JSON.stringify(library))), library);
  const parsed = parseLibrary({
    custom: [
      { name: "a", description: "", template: "x" },
      { name: "a", description: "", template: "again" },
      { name: "review", description: "", template: "x" },
      { name: "Bad", description: "", template: "x" },
      { name: "b", description: "d".repeat(201), template: "x" },
      { name: "c", template: "x" },
      null,
    ],
    overrides: { fix: 3, deploy: "x", explain: " " },
  });
  assert.deepEqual(parsed, { custom: [{ name: "a", description: "", template: "x" }], overrides: {} });
  assert.equal(parseLibrary(null), undefined);
});

test("a custom prompt is refused with a reason the configure screen shows", () => {
  const library: Library = { custom: [{ name: "deploy", description: "", template: "x" }], overrides: {} };
  const ok = { name: "ship", description: "", template: "Ship it" };
  assert.equal(validateCustom(ok, library), undefined);
  assert.equal(validateCustom({ ...ok, name: "deploy" }, library, "deploy"), undefined, "an edit may keep its name");
  for (const [prompt, reason] of [
    [{ ...ok, name: "" }, /press Return/],
    [{ ...ok, name: "Ship" }, /lowercase/],
    [{ ...ok, name: "a".repeat(33) }, /up to 32/],
    [{ ...ok, name: "review" }, /built-in/],
    [{ ...ok, name: "deploy" }, /already/],
    [{ ...ok, description: "d".repeat(201) }, /200/],
    [{ ...ok, template: " \n" }, /empty/],
    [{ ...ok, template: "😀".repeat(4001) }, /4,000/],
  ] as const) {
    assert.match(validateCustom(prompt, library) ?? "", reason, prompt.name);
  }
  const full: Library = { custom: Array.from({ length: 32 }, (_, i) => ({ name: `p${i}`, description: "", template: "x" })), overrides: {} };
  assert.match(validateCustom(ok, full) ?? "", /At most 32/);
});
