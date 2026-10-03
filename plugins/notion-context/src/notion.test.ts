import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTEXT_BYTES, parsePageId, renderBlocks, TRUNCATED, truncate } from "./notion.ts";

const ID = "1a2b3c4d5e6f40718293a4b5c6d7e8f9";
const DASHED = "1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9";

test("a page id comes from a bare id or a page URL", () => {
  for (const input of [
    ID,
    ` ${DASHED.toUpperCase()} `,
    `https://www.notion.so/acme/Roadmap-${ID}`,
    `https://www.notion.so/acme/Roadmap-${ID}?pvs=4#${"f".repeat(32)}`,
    // Slug words made only of hex letters run straight into the id once dashes go.
    `https://acme.notion.site/Bad-Cafe-${ID}/`,
  ]) {
    assert.equal(parsePageId(input), DASHED, input);
  }
  assert.equal(parsePageId(""), undefined);
  assert.equal(parsePageId("https://www.notion.so/acme/Roadmap"), undefined);
});

const rich = (text: string) => [{ plain_text: text.slice(0, 3) }, { plain_text: text.slice(3) }];
const block = (type: string, text: string, extra: object = {}) => ({ type, [type]: { rich_text: rich(text), ...extra } });

test("blocks render as Markdown-ish text, list items grouped and unknown types skipped", () => {
  const text = renderBlocks([
    block("heading_1", "Roadmap"),
    block("paragraph", "Ship it."),
    block("paragraph", ""),
    block("bulleted_list_item", "first"),
    block("to_do", "done", { checked: true }),
    block("to_do", "open", { checked: false }),
    block("numbered_list_item", "step"),
    { type: "image", image: { type: "external" } },
    block("heading_3", "Notes"),
    block("code", "let x = 1", { language: "swift" }),
    block("code", "raw", { language: "plain text" }),
    block("quote", "one\ntwo"),
    block("callout", "Careful", { icon: { type: "emoji", emoji: "⚠️" } }),
    { type: "divider", divider: {} },
  ]);
  assert.equal(
    text,
    [
      "# Roadmap",
      "Ship it.",
      "- first\n- [x] done\n- [ ] open\n1. step",
      "### Notes",
      "```swift\nlet x = 1\n```",
      "```\nraw\n```",
      "> one\n> two",
      "> ⚠️ Careful",
    ].join("\n\n"),
  );
});

test("text within the limit is kept whole", () => {
  const text = "é".repeat(CONTEXT_BYTES / 2);
  assert.equal(truncate(text), text);
});

test("text over the limit is cut under it, at a line break, without splitting a character", () => {
  const line = "😀 ".repeat(20) + "\n";
  const cut = truncate(line.repeat(500));
  assert.ok(Buffer.byteLength(cut) <= CONTEXT_BYTES);
  assert.ok(cut.endsWith(TRUNCATED));
  assert.ok(cut.slice(0, -TRUNCATED.length).endsWith("😀"), "ends on a whole line");

  // One long line: cut mid-line, but never between a surrogate pair.
  const long = truncate("😀".repeat(CONTEXT_BYTES));
  assert.ok(Buffer.byteLength(long) <= CONTEXT_BYTES);
  assert.ok(!long.includes("�") && !/[\ud800-\udbff](?![\udc00-\udfff])/.test(long));
});
