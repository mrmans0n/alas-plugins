# Prompt Library

Slash prompts for everyday requests to an agent. Type `/review`, `/explain`,
`/tests`, `/commit` or `/fix` in an agent session's composer, optionally
followed by more text, and send it: the plugin expands it into a full prompt
that replaces your draft, so you can read and edit it before sending it to the
agent. You can add your own prompts and rewrite the built-in ones in its
**Configure…** sheet. It uses plugin API 9 (slash prompts, runtime prompts, a
configure panel and plugin-scoped storage), and is the reference plugin for
slash prompts. It is written in TypeScript on `@alas/plugin`.

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

## Configure

**Settings → Plugins → Prompt Library → Configure…** opens a sheet with two
lists:

- **Custom prompts**: **Add prompt** opens a form with a name, an optional
  description for the slash picker, and a multiline template. Press Return in
  the name and description fields to keep them, and ⌘Return in the template to
  save; a problem (a taken or invalid name, an empty template) shows under the
  form. Each prompt has **Edit** and **Delete**.
- **Built-in prompts**: **Edit** rewrites a built-in template, **Reset** brings
  the original back. Saving the original text, or nothing, also resets it.

Names are up to 32 lowercase letters, digits and dashes, and cannot be one of
the five built-ins; descriptions are up to 200 characters and templates up to
4,000. There can be 32 custom prompts.

Templates work the same way for every prompt:

- `{args}` is replaced by the text after the command. A line holding `{args}`
  is left out when there is no text, so `Focus on: {args}` only appears when
  you give a focus.
- A template without `{args}` gets the text appended as its own paragraph.

Everything is stored once for the plugin, not per project, so a prompt added in
one project is there in all of them; open projects pick up a change right away.

The old **/review template (legacy)** settings and the like, one-line fields
with `\n` for a line break, still apply until you save anything in the sheet,
which copies them in. After that they are ignored, and will go away in a later
version.

## Capabilities

None. Slash prompts need no capability: the plugin only runs when you send one
of its prompts, and its answer goes into your composer, not to the agent.

## Limitations

- A name Alas or an earlier plugin already uses is skipped by Alas, and a
  plugin prompt hides an agent command with the same name (for example an
  agent's own `/review`).
- Custom prompts are registered when the plugin starts in a project, so they
  are only offered in projects where it is running.
- There is no "…" menu command for messages: there is no way to put text in
  the composer, and sending a follow-up straight to the agent with
  `session/send` would skip the question you want to ask.
