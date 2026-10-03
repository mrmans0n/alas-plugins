# Notion Context

Adds a Notion page to every prompt sent to the agents of a project: a design
doc, team conventions, a roadmap. Alas adds the page's text to each prompt as a
separate block, "Context from the Alas plugin Notion Context", which the agent
sees and the transcript does not; the composer shows a chip while the plugin
provides context. It uses plugin API 7 (context providers), settings and
secrets, web requests and timers, and is the reference plugin for context
providers. It is written in TypeScript on `@alas/plugin`.

## Build and install

From the repository root:

```bash
npm install
plugins/notion-context/build.sh
```

`build.sh` installs into `~/Library/Application Support/Alas/Plugins/notion-context`.
Set `ALAS_APP_SUPPORT_DIR` to install into an isolated Alas profile instead.
Approve it in **Settings → Plugins**, then fill in its settings there.

## Settings

| Setting | What it does |
|---|---|
| **Notion integration token** | An internal integration's secret from [notion.so/profile/integrations](https://www.notion.so/profile/integrations), with **Read content**. Share the page with the integration (the page's **…** menu → **Connections**). Stored in the Keychain; see below. |
| **Page URL or ID** | The page's link (`https://www.notion.so/acme/Roadmap-1a2b…`) or its 32-character id, with or without dashes. |

Settings belong to the plugin, not to a project, so every project it runs in
gets the same page.

## What it does

Alas asks for context before every prompt and needs the answer right away,
without waiting on the network. So the plugin fetches the page ahead of time,
when it starts, when a setting changes and every 10 minutes, and answers each
prompt from that copy. Until the first fetch finishes, or without a token or a
valid page, it adds nothing.

The page's top-level blocks become Markdown-ish text: paragraphs, headings
(`#`, `##`, `###`), bulleted and numbered list items, to-dos (`- [ ]`,
`- [x]`), code blocks with their language, quotes and callouts (as `>`
quotes). Other blocks (images, tables, embeds, databases, toggles' contents)
are left out.

Alas accepts up to 16 KiB of context per plugin, so a longer page is cut at a
line break under that and ends with "[… the rest of the page was cut]". The
plugin reads at most 10 batches of 100 blocks, and stops as soon as it has
more than fits.

When a fetch fails (a bad token, a page not shared with the integration,
Notion being down), the plugin's log in **Settings → Plugins** says why, with
the HTTP status and Notion's message, and the last good copy is kept until a
fetch works again.

## Capabilities

| Capability | Why |
|---|---|
| `session.context` | Add the page to every prompt sent to agents in the project. |
| `network` (`api.notion.com` only) | Read the page through Notion's API. |
| `timers` | Fetch the page again every 10 minutes. |

The token never reaches the plugin. It sends the header
`Authorization: Bearer {{secret:token}}`, and Alas fills the token in only for
requests to `api.notion.com`. It is never logged.

## Limitations

- One page, and only its top-level blocks: nested blocks (the inside of a
  toggle, sub-bullets, a child page) are not fetched.
- Mentions and links come through as their plain text; formatting is dropped.
- Edits in Notion show up within 10 minutes, or right away after changing a
  setting.
- Every prompt carries the page, which costs tokens on every turn. Keep the
  page short and to the point.
