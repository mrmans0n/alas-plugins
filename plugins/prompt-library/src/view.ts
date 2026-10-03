// The configure sheet: custom prompts with Edit and Delete, an Add form, and the built-in templates.
// Text fields only report on Return (⌘Return when multiline), so the one-line fields are kept as a
// draft on Return and the template's ⌘Return saves the form.

import type { Node } from "@alas/plugin";
import { MAX_TEMPLATE, PROMPTS, type Library } from "./prompts.ts";

export type Editing = { kind: "custom"; replacing?: string } | { kind: "builtin"; name: string };

export interface ConfigState {
  /** `undefined` until storage answers. */
  library?: Library;
  editing?: Editing;
  draft: { name: string; description: string };
  /** Bumped for each new form, so its fields start from their `value` again. */
  form: number;
  error?: string;
}

const text = (id: string, value: string, style?: "caption" | "title", tone?: "dim" | "danger"): Node =>
  ({ kind: "text", id, text: [...value].slice(0, MAX_TEMPLATE).join(""), style, tone });
const button = (id: string, label: string, style: "normal" | "primary" | "plain" = "normal"): Node => ({ kind: "button", id, label, style });
const hstack = (id: string, children: Node[]): Node => ({ kind: "hstack", id, children, spacing: 8 });
const vstack = (id: string, children: Node[]): Node => ({ kind: "vstack", id, children, spacing: 8 });

function editor(s: ConfigState, library: Library, editing: Editing): Node {
  const f = s.form;
  const children: Node[] = [];
  let template: string;
  if (editing.kind === "builtin") {
    children.push(text("editor-title", `Edit /${editing.name}`, "title"));
    template = library.overrides[editing.name] ?? PROMPTS[editing.name].template;
  } else {
    children.push(text("editor-title", editing.replacing ? `Edit /${editing.replacing}` : "New prompt", "title"));
    children.push({ kind: "textField", id: `name-${f}`, value: s.draft.name, placeholder: "Name, e.g. deploy (Return keeps it)" });
    children.push({ kind: "textField", id: `description-${f}`, value: s.draft.description, placeholder: "Description, optional (Return keeps it)" });
    template = library.custom.find((p) => p.name === editing.replacing)?.template ?? "";
  }
  children.push({
    kind: "textField",
    id: `template-${f}`,
    value: [...template].slice(0, MAX_TEMPLATE).join(""),
    placeholder: "Template — {args} is the text after the command. ⌘Return saves",
    multiline: true,
  });
  if (s.error) children.push(text("error", s.error, undefined, "danger"));
  children.push(hstack("editor-buttons", [text("editor-hint", "⌘Return in the template saves.", "caption", "dim"), button("cancel", "Cancel", "plain")]));
  return { kind: "card", id: "editor", children };
}

export function configureView(s: ConfigState): Node {
  const library = s.library;
  if (!library) return { kind: "progress", id: "loading", text: "Loading prompts…" };
  const children: Node[] = [text("custom-heading", "Custom prompts", "title")];
  if (s.error && !s.editing) children.push(text("error", s.error, undefined, "danger"));
  if (library.custom.length === 0) children.push(text("custom-empty", "None yet. Added prompts work in every project.", "caption", "dim"));
  for (const p of library.custom) {
    children.push(hstack(`row-${p.name}`, [
      vstack(`label-${p.name}`, [text(`title-${p.name}`, `/${p.name}`), ...(p.description ? [text(`desc-${p.name}`, p.description, "caption", "dim")] : [])]),
      { kind: "spacer", id: `space-${p.name}` },
      button(`edit:${p.name}`, "Edit"),
      button(`delete:${p.name}`, "Delete", "plain"),
    ]));
  }
  if (s.editing?.kind === "custom") children.push(editor(s, library, s.editing));
  else children.push(button("add", "Add prompt", "primary"));

  children.push({ kind: "divider", id: "divider" }, text("builtin-heading", "Built-in prompts", "title"));
  for (const name of Object.keys(PROMPTS)) {
    const overridden = Object.hasOwn(library.overrides, name);
    children.push(hstack(`builtin-${name}`, [
      text(`builtin-name-${name}`, `/${name}`),
      ...(overridden ? [{ kind: "badge", id: `custom-${name}`, text: "Edited", tone: "accent" } as Node] : []),
      { kind: "spacer", id: `builtin-space-${name}` },
      button(`edit-builtin:${name}`, "Edit"),
      ...(overridden ? [button(`reset:${name}`, "Reset", "plain")] : []),
    ]));
    if (s.editing?.kind === "builtin" && s.editing.name === name) children.push(editor(s, library, s.editing));
  }
  return { kind: "scroll", id: "root", axis: "vertical", child: vstack("content", children) };
}
