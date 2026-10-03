import { test } from "node:test";
import assert from "node:assert/strict";
import { testHost } from "@alas/plugin/test";
import { expand as expandTemplate, PROMPTS } from "./prompts.ts";
import "./main.ts";

const sent = (method: string) => testHost.takeSent().filter((m) => m.method === method);
const click = (id: string) => testHost.notify("view/event", { panel: "configure", id, kind: "click" });
const submit = (id: string, value: string) => testHost.notify("view/event", { panel: "configure", id, kind: "submit", value });
const expand = (name: string, args = "") => {
  testHost.dispatch({ jsonrpc: "2.0", id: 900, method: "prompt/expand", params: { name, args, session: "s" } });
  return testHost.takeSent().find((m) => m.id === 900);
};

test("a prompt added in the configure sheet is stored app-wide, registered and expanded; old settings carry over", () => {
  testHost.dispatch({ jsonrpc: "2.0", id: 0, method: "alas/activate", params: { api: 9, project: { id: "p", name: "P" }, grants: [] } });
  const messages = testHost.takeSent();
  const settingsId = messages.find((m) => m.method === "settings/get").id;
  const get = messages.find((m) => m.method === "storage/get");
  assert.deepEqual(get.params, { key: "library", scope: "plugin" });
  testHost.replySettings(settingsId, { review: "Old\\nreview" });
  testHost.reply(get.id, { value: null });
  assert.deepEqual(sent("prompts/set")[0].params, { prompts: [] });
  assert.deepEqual(expand("review").result, { text: "Old\nreview" });

  testHost.notify("panel/visible", { panel: "configure", visible: true });
  click("add");
  submit("template-1", "Deploy {args}");
  const refused = sent("view/render").at(-1);
  assert.match(JSON.stringify(refused.params.root), /press Return in the name field/);
  submit("name-1", "deploy");
  submit("description-1", "Ship it");
  submit("template-1", "Deploy {args}");
  const out = testHost.takeSent();
  const set = out.find((m) => m.method === "storage/set");
  assert.deepEqual(set.params, {
    key: "library",
    scope: "plugin",
    value: { custom: [{ name: "deploy", description: "Ship it", template: "Deploy {args}" }], overrides: { review: "Old\nreview" } },
  });
  assert.deepEqual(out.find((m) => m.method === "prompts/set").params, { prompts: [{ name: "deploy", description: "Ship it" }] });
  assert.deepEqual(expand("deploy", "prod").result, { text: "Deploy prod" });

  // Another project changes the library: it is read again and re-registered.
  testHost.notify("storage/changed", { scope: "plugin", key: "library" });
  const reread = sent("storage/get")[0];
  testHost.reply(reread.id, { value: { custom: [], overrides: {} } });
  assert.deepEqual(sent("prompts/set")[0].params, { prompts: [] });
  assert.deepEqual(expand("review").result, expandTemplate(PROMPTS.review, ""));
});
