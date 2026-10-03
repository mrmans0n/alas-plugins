# Prompt Library

Slash prompts for everyday requests to an agent. Type `/review`, `/explain`,
`/tests`, `/commit` or `/fix` in an agent session's composer, optionally
followed by more text, and send it: the plugin expands it into a full prompt
that replaces your draft, so you can read and edit it before sending it to the
agent. It uses plugin API 7 (slash prompts) and settings, and is the reference
plugin for slash prompts. It is written in TypeScript on `@alas/plugin`.

## Build and install

From the repository root:

```bash
npm install
plugins/prompt-library/build.sh
```

`build.sh` installs into `~/Library/Application Support/Alas/Plugins/prompt-library`.
Set `ALAS_APP_SUPPORT_DIR` to install into an isolated Alas profile instead.
Approve it in **Settings → Plugins**.

## Prompts

| Prompt | Expands to |
|---|---|
| `/review [focus]` | Review the uncommitted changes for bugs, edge cases, naming and missing tests, findings by severity, without editing files. The text after it becomes "Focus especially on: …". |
| `/explain <what>` | Explain the code, file or topic, with a summary and pointers into the repository. |
| `/tests <what>` | Write tests for it in the style of the existing suite, edge cases included, and run them. |
| `/commit [notes]` | Draft a commit message for the staged changes in the repository's style, without committing. The text after it becomes "Keep in mind: …". |
| `/fix <problem>` | Find the root cause of the problem, explain it, and fix it minimally with a regression test. |

`/explain`, `/tests` and `/fix` need text after the command; without it Alas
shows the usage and keeps your draft.

## Settings

Each prompt has a template setting (**/review template** and so on). Empty, the
built-in template is used. Otherwise:

- `{args}` is replaced by the text after the command. A line holding `{args}`
  is left out when there is no text, so `Focus on: {args}` only appears when
  you give a focus.
- A template without `{args}` gets the text appended as its own paragraph.
- Settings are one-line fields, so write `\n` for a line break.

For example, **/review template** set to
`Review the diff against main.\nOnly report bugs.\nFocus on: {args}`.

## Capabilities

None. Slash prompts need no capability: the plugin only runs when you send one
of its prompts, and its answer goes into your composer, not to the agent.

## Limitations

- The prompt names are fixed in the manifest, so settings can change what the
  five prompts say but cannot add new ones. Fork the plugin to add a prompt:
  declare it in `plugin.json` (`contributes.prompts` and a template setting)
  and add its template to `src/prompts.ts`.
- A name Alas or an earlier plugin already uses is skipped by Alas, and a
  plugin prompt hides an agent command with the same name (for example an
  agent's own `/review`).
- There is no "…" menu command for messages: API 7 has no way to put text in
  the composer, and sending a follow-up straight to the agent with
  `session/send` would skip the question you want to ask.
