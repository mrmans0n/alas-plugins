# Linear

Your Linear issues next to your worktrees. A **Linear** panel in the right pane
lists the issues assigned to you that are not started or in progress. **Start**
on an issue starts an agent on it in a new worktree and says so on the issue;
when that agent finishes, its last message is posted on the issue as a comment.
It uses plugin API 5 (panels, commands, settings and secrets, web requests,
timers, session events and notifications) and is the reference plugin for it.
It is written in TypeScript on `@alas/plugin`.

## Build and install

From the repository root:

```bash
npm install
plugins/linear-bridge/build.sh
```

`build.sh` installs into `~/Library/Application Support/Alas/Plugins/linear-bridge`.
Set `ALAS_APP_SUPPORT_DIR` to install into an isolated Alas profile instead.
Approve it in **Settings → Plugins**, then fill in its settings there.

## Settings

| Setting | What it does |
|---|---|
| **Linear API key** | A personal API key from Linear's **Settings → Security & access**. Stored in the Keychain; see below. |
| **Team key (optional)** | Only list issues of this team, e.g. `ENG`. Empty lists every team. |
| **Comment when the agent finishes** | On by default. Off, finished agents leave the issue alone. |

Changing a setting reloads the list.

## What it does

- **The list** shows up to 50 issues: identifier, title, state and a **Start**
  button. It reloads when the panel is shown, every 5 minutes, on
  **Refresh Linear issues** (the repo selector and **View → Plugins**), and
  when a setting changes. Without a key, or when Linear answers with an error,
  the panel says why (the status code and Linear's message) instead of a list.
- **Start** starts an agent in a new worktree on branch `<identifier>` in lower
  case (`eng-123`), titled `<IDENTIFIER> <title>`, with the issue's title, URL and
  description as the prompt (cut to Alas's 32 KiB prompt limit). It comments
  "Started an agent in Alas on branch `<branch>`" on the issue, and remembers
  which issue the session works on in the plugin's storage, so this survives a
  restart (the last 50 sessions).
- **When the agent finishes a turn** in one of those sessions, its last message
  (up to 4,000 characters) is posted on the issue, and Alas shows
  "Commented on `<IDENTIFIER>`".

## Capabilities

| Capability | Why |
|---|---|
| `network` (`api.linear.app` only) | Read your issues and post comments through Linear's GraphQL API. |
| `session.read` | Know when a started agent finishes, and read its last message for the comment. |
| `tasks.start` | Start an agent in a new worktree from an issue. |
| `timers` | Reload the list every 5 minutes. |
| `notify` | Say when a comment was posted, or why a start or a comment failed. |

The API key never reaches the plugin. It sends the header
`Authorization: {{secret:apiKey}}`, and Alas fills the key in only for requests
to `api.linear.app`.
