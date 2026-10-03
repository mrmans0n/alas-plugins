import { test } from "node:test";
import assert from "node:assert/strict";
import { testHost } from "@alas/plugin/test";
import "./main.ts";

const PAGE = "1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9";
const item = (id: string, hasChildren = false) =>
  ({ id, type: "bulleted_list_item", has_children: hasChildren, bulleted_list_item: { rich_text: [{ plain_text: id }] } });

/** Answers each `http/fetch` by the block id in its URL, and returns the ids in the order asked. */
function serve(children: Record<string, object>): string[] {
  const asked: string[] = [];
  for (let fetched; (fetched = testHost.takeSent().find((m) => m.method === "http/fetch")); ) {
    const id = /blocks\/([^/]+)\/children/.exec(fetched.params.url)![1];
    asked.push(fetched.params.url.includes("start_cursor") ? `${id}+` : id);
    testHost.reply(fetched.id, { status: 200, headers: {}, body: JSON.stringify(children[asked.at(-1)!] ?? { results: [] }) });
  }
  return asked;
}

test("nested children are fetched in document order, at most 3 levels down, and the page answers context", () => {
  testHost.dispatch({ jsonrpc: "2.0", id: 0, method: "alas/activate", params: { api: 7, project: { id: "p", name: "P" }, grants: [] } });
  testHost.secrets.add("token");
  testHost.changeSettings({ page: PAGE });
  const asked = serve({
    [PAGE]: { results: [item("a", true), item("b", true)], has_more: true, next_cursor: "c2" },
    [`${PAGE}+`]: { results: [item("z")] },
    a: { results: [item("a1", true)] },
    a1: { results: [item("a2", true)] },
    a2: { results: [item("a3", true)] },
    b: { results: [item("b1")] },
  });
  assert.deepEqual(asked, [PAGE, "a", "a1", "a2", "b", `${PAGE}+`]);
  testHost.dispatch({ jsonrpc: "2.0", id: 9, method: "context/provide", params: { session: "s", worktree: "w" } });
  const [answer] = testHost.takeSent();
  assert.equal(answer.result.text, "- a\n  - a1\n    - a2\n      - a3\n- b\n  - b1\n- z");
});
