// Slash prompts from a small library. Alas sends `prompt/expand` when the user sends `/name args`;
// the expansion replaces the draft in the composer, so the user reads it before sending it.
// Custom prompts and edited built-ins live in plugin-scoped storage, shared by every project, and
// are managed in the configure sheet (Settings → Plugins → Configure…).

import { definePlugin, getSettings, log, promptsSet, renderPanel, storageGet, storageSet, type SettingValues } from "@alas/plugin";
import { expand, LIBRARY_KEY, legacyOverrides, MAX_TEMPLATE, parseLibrary, PROMPTS, promptFor, validateCustom, type Library } from "./prompts.ts";
import { configureView, type ConfigState, type Editing } from "./view.ts";

const PANEL = "configure";

let settings: SettingValues = {};
/** The saved library, or `null` when it was never saved and the old settings still count. */
let saved: Library | null = null;
let loaded = false;
let loadId: number | undefined;
let saveId: number | undefined;
let visible = false;
const state: ConfigState = { draft: { name: "", description: "" }, form: 0 };

const library = (): Library => saved ?? { custom: [], overrides: legacyOverrides(settings) };

function draw(): void {
  if (!visible) return;
  state.library = loaded ? library() : undefined;
  renderPanel(PANEL, configureView(state));
}

/** Runtime prompts end with the instance, so this runs on every load. */
function publish(): void {
  const prompts = library().custom.map(({ name, description }) => ({ name, description: description || undefined }));
  promptsSet(prompts, ({ error }) => {
    if (error) log("warn", `Could not register the custom prompts: ${error.message}`);
  });
}

function save(next: Library): void {
  saved = next;
  saveId = storageSet(LIBRARY_KEY, next, "plugin");
  state.editing = undefined;
  state.error = undefined;
  publish();
  draw();
}

function startEditing(editing: Editing | undefined, draft = { name: "", description: "" }): void {
  state.editing = editing;
  state.draft = draft;
  state.error = undefined;
  state.form++;
  draw();
}

function submitTemplate(editing: Editing, template: string): void {
  const lib = library();
  if (editing.kind === "builtin") {
    if ([...template].length > MAX_TEMPLATE) {
      state.error = "The template is over 4,000 characters.";
      return draw();
    }
    const overrides = { ...lib.overrides };
    // Saving the built-in text unchanged, or nothing, is the same as Reset.
    if (!template.trim() || template.trim() === PROMPTS[editing.name].template) delete overrides[editing.name];
    else overrides[editing.name] = template.trim();
    return save({ ...lib, overrides });
  }
  const prompt = { name: state.draft.name, description: state.draft.description, template: template.trim() };
  state.error = validateCustom(prompt, lib, editing.replacing);
  if (state.error) return draw();
  // An edit keeps its place in the list; a new prompt goes last.
  const at = lib.custom.findIndex((p) => p.name === editing.replacing);
  const custom = lib.custom.slice();
  custom.splice(at < 0 ? custom.length : at, at < 0 ? 0 : 1, prompt);
  save({ ...lib, custom });
}

function onClick(id: string): void {
  const lib = library();
  const colon = id.indexOf(":");
  const [action, name] = colon < 0 ? [id, ""] : [id.slice(0, colon), id.slice(colon + 1)];
  switch (action) {
    case "add":
      return startEditing({ kind: "custom" });
    case "cancel":
      return startEditing(undefined);
    case "edit": {
      const p = lib.custom.find((c) => c.name === name);
      return p && startEditing({ kind: "custom", replacing: p.name }, { name: p.name, description: p.description });
    }
    case "delete":
      return save({ ...lib, custom: lib.custom.filter((p) => p.name !== name) });
    case "edit-builtin":
      return Object.hasOwn(PROMPTS, name) ? startEditing({ kind: "builtin", name }) : undefined;
    case "reset": {
      const overrides = { ...lib.overrides };
      delete overrides[name];
      return save({ ...lib, overrides });
    }
  }
}

function onSubmit(id: string, value: string): void {
  // Field ids end in `-<form>`, so a submit from a form that is gone is ignored.
  if (!loaded || !state.editing || !id.endsWith(`-${state.form}`)) return;
  const field = id.slice(0, id.lastIndexOf("-"));
  if (field === "template") return submitTemplate(state.editing, value);
  if (field === "name") state.draft.name = value.trim();
  if (field === "description") state.draft.description = value.trim();
  draw();
}

definePlugin({
  handle(event) {
    switch (event.type) {
      case "activate":
        getSettings();
        loadId = storageGet(LIBRARY_KEY, "plugin");
        return;
      case "settings":
        settings = event.values;
        return draw();
      case "stored":
        if (event.id !== loadId) return;
        loadId = undefined;
        if (event.error) log("warn", `Could not read the custom prompts: ${event.error.message}`);
        else saved = parseLibrary(event.value) ?? null;
        loaded = true;
        publish();
        return draw();
      case "storageChanged":
        // Another project saved the library: read it again.
        if (event.key === LIBRARY_KEY) loadId = storageGet(LIBRARY_KEY, "plugin");
        return;
      case "reply":
        if (event.id !== saveId || !event.error) return;
        state.error = `Could not save: ${event.error.message}`;
        return draw();
      case "panelVisible":
        if (event.panel !== PANEL) return;
        visible = event.visible;
        return draw();
      case "panelEvent":
        if (event.panel !== PANEL || !loaded) return;
        if (event.kind === "click") return onClick(event.id);
        if (event.kind === "submit" && event.value !== undefined) onSubmit(event.id, event.value);
        return;
      case "promptExpand": {
        const prompt = promptFor(event.name, library());
        if (!prompt) return event.fail(`Unknown prompt /${event.name}.`);
        const result = expand(prompt, event.args);
        return "text" in result ? event.respond(result.text) : event.fail(result.error);
      }
    }
  },
});
