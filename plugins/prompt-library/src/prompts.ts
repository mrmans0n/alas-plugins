// The prompt templates and how they expand. `{args}` stands for the text after `/name`; a line
// holding `{args}` is dropped when there is none, so one template reads well both ways. A template
// without `{args}` gets the arguments appended as their own paragraph.

export interface Prompt {
  template: string;
  /** Shown when the prompt needs arguments and got none. */
  usage?: string;
}

export const PROMPTS: Record<string, Prompt> = {
  review: {
    template: [
      "Review the uncommitted changes in this worktree (`git diff` and `git diff --staged`).",
      "Look for bugs, missed edge cases, unclear names and missing tests. List the findings by severity, each with its file and line and a concrete fix. Do not edit any files.",
      "Focus especially on: {args}",
    ].join("\n"),
  },
  explain: {
    template: [
      "Explain {args}",
      "",
      "Start with a short summary, then walk through how it works, pointing at the files and functions in this repository that matter. Call out anything surprising or risky.",
    ].join("\n"),
    usage: "Usage: /explain <code, file or topic>",
  },
  tests: {
    template: [
      "Write tests for {args}",
      "",
      "Follow the conventions of the existing test suite. Cover edge cases and failure paths, not only the happy path, and skip tests that only restate the implementation. Run them and make sure they pass.",
    ].join("\n"),
    usage: "Usage: /tests <code or behavior to test>",
  },
  commit: {
    template: [
      "Draft a commit message for the staged changes (`git diff --staged`; if nothing is staged, the uncommitted changes).",
      "Match the style of this repository's recent commits (`git log`). Show the message only; do not commit.",
      "Keep in mind: {args}",
    ].join("\n"),
  },
  fix: {
    template: [
      "Find the root cause of this problem and fix it: {args}",
      "",
      "Reproduce it first if you can, explain the cause before changing code, and keep the fix minimal. Add a regression test if the project has tests.",
    ].join("\n"),
    usage: "Usage: /fix <what goes wrong>",
  },
};

/** A prompt the user added in the configure screen. */
export interface CustomPrompt {
  name: string;
  description: string;
  template: string;
}

/** What the configure screen stores, as the plugin-scoped key `LIBRARY_KEY`, shared by every project. */
export interface Library {
  custom: CustomPrompt[];
  /** Built-in templates the user replaced, by prompt name. */
  overrides: Record<string, string>;
}

export const LIBRARY_KEY = "library";
/** Alas takes at most 32 runtime prompts. */
export const MAX_CUSTOM = 32;
/** A view tree string holds at most 4,000 characters, and the template is edited in one. */
export const MAX_TEMPLATE = 4000;
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

const chars = (s: string) => [...s].length;

/** The stored library; anything malformed is dropped item by item rather than losing the rest. */
export function parseLibrary(value: unknown): Library | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const custom: CustomPrompt[] = [];
  for (const p of Array.isArray(v.custom) ? v.custom : []) {
    if (typeof p?.description !== "string" || typeof p.template !== "string" || chars(p.description) > 200) continue;
    // Names must stay unique: they become view ids and runtime prompts.
    if (typeof p.name !== "string" || !NAME.test(p.name) || Object.hasOwn(PROMPTS, p.name) || custom.some((c) => c.name === p.name)) continue;
    custom.push({ name: p.name, description: p.description, template: p.template });
  }
  const overrides: Record<string, string> = {};
  if (typeof v.overrides === "object" && v.overrides !== null) {
    for (const [name, template] of Object.entries(v.overrides)) {
      if (Object.hasOwn(PROMPTS, name) && typeof template === "string" && template.trim()) overrides[name] = template;
    }
  }
  return { custom: custom.slice(0, MAX_CUSTOM), overrides };
}

/**
 * Before the configure screen, overrides were one-line settings with `\n` for a line break. They
 * count until the library is first saved, which copies them in.
 */
export function legacyOverrides(settings: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(PROMPTS)) {
    const value = settings[name];
    if (typeof value === "string" && value.trim()) out[name] = value.trim().replaceAll("\\n", "\n");
  }
  return out;
}

/** The prompt `name` expands with: a built-in (or its override) or a custom one. */
export function promptFor(name: string, library: Library): Prompt | undefined {
  if (Object.hasOwn(PROMPTS, name)) {
    const override = library.overrides[name];
    return override?.trim() ? { template: override.trim() } : PROMPTS[name];
  }
  const custom = library.custom.find((p) => p.name === name);
  return custom && { template: custom.template };
}

/**
 * Why `prompt` cannot be saved into `library`, replacing the custom prompt `replacing` when it is
 * an edit, or `undefined` when it can.
 */
export function validateCustom(prompt: CustomPrompt, library: Library, replacing?: string): string | undefined {
  if (!prompt.name) return "Give the prompt a name, and press Return in the name field to keep it.";
  if (!NAME.test(prompt.name)) return "Names are up to 32 lowercase letters, digits and dashes, starting with a letter or digit.";
  if (Object.hasOwn(PROMPTS, prompt.name)) return `/${prompt.name} is a built-in prompt; edit it under Built-in prompts.`;
  if (prompt.name !== replacing && library.custom.some((p) => p.name === prompt.name)) return `There is already a /${prompt.name}.`;
  if (replacing === undefined && library.custom.length >= MAX_CUSTOM) return `At most ${MAX_CUSTOM} custom prompts.`;
  if (chars(prompt.description) > 200) return "The description is over 200 characters.";
  if (!prompt.template.trim()) return "The template is empty.";
  if (chars(prompt.template) > MAX_TEMPLATE) return "The template is over 4,000 characters.";
  return undefined;
}

/** `prompt` with `args` filled in, or an error to show when it needs arguments and has none. */
export function expand(prompt: Prompt, args: string): { text: string } | { error: string } {
  const value = args.trim();
  if (!value && prompt.usage) return { error: prompt.usage };
  const template = prompt.template.includes("{args}") ? prompt.template : `${prompt.template}\n\n{args}`;
  const lines = template.split("\n");
  const text = (value ? lines : lines.filter((line) => !line.includes("{args}")))
    .join("\n")
    // A function replacement, so `$&` in the user's text stays literal.
    .replaceAll("{args}", () => value)
    .trim();
  return text ? { text } : { error: "The template is empty without arguments." };
}
