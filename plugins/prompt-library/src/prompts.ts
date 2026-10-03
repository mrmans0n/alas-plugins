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

/**
 * The template for `name`: the user's override from settings when it is not blank, the built-in
 * one otherwise. Settings are one-line fields, so a literal `\n` in an override is a line break.
 */
export function templateFor(name: string, overrides: Record<string, unknown>): Prompt | undefined {
  const builtIn = PROMPTS[name];
  if (!builtIn) return undefined;
  const override = overrides[name];
  if (typeof override !== "string" || !override.trim()) return builtIn;
  return { template: override.trim().replaceAll("\\n", "\n") };
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
