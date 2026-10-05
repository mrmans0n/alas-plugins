import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePageMessage } from "./protocol.ts";

test("page messages are checked field by field; a null assignee or target means none", () => {
  const ok: [unknown, unknown][] = [
    [{ type: "move", number: 2, status: "done", before: null }, { type: "move", number: 2, status: "done", before: undefined }],
    [{ type: "assign", number: 1, assignee: null }, { type: "assign", number: 1, assignee: undefined }],
    [{ type: "create", title: "t", description: "", priority: "high", assignee: "claude" }, { type: "create", title: "t", description: "", priority: "high", assignee: "claude" }],
  ];
  for (const [input, parsed] of ok) assert.deepEqual(parsePageMessage(input), parsed);
  const bad = [
    null,
    "ready",
    { type: "open", number: -1 },
    { type: "open", number: 1.5 },
    { type: "move", number: 1, status: "archived" },
    { type: "priority", number: 1, priority: "p0" },
    { type: "describe", number: 1, text: 42 },
    { type: "assign", number: 1, assignee: 7 },
    { type: "explode" },
  ];
  for (const input of bad) assert.equal(parsePageMessage(input), undefined, JSON.stringify(input));
});
