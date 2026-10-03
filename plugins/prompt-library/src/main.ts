// Slash prompts from a small library. Alas sends `prompt/expand` when the user sends `/name args`;
// the expansion replaces the draft in the composer, so the user reads it before sending it.

import { definePlugin, getSettings, type SettingValues } from "@alas/plugin";
import { expand, templateFor } from "./prompts.ts";

let overrides: SettingValues = {};

definePlugin({
  handle(event) {
    if (event.type === "activate") getSettings();
    if (event.type === "settings") overrides = event.values;
    if (event.type === "promptExpand") {
      const prompt = templateFor(event.name, overrides);
      if (!prompt) return event.fail(`Unknown prompt /${event.name}.`);
      const result = expand(prompt, event.args);
      "text" in result ? event.respond(result.text) : event.fail(result.error);
    }
  },
});
