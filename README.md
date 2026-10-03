# Alas plugins

Plugins for [Alas](https://github.com/mrmans0n/alas). Each folder in `plugins/` is one
plugin, and every release is listed in [`index.json`](index.json), the catalog Alas
reads to offer them in **Settings → Plugins**.

The plugin contract (messages, capabilities, limits) is documented in the Alas repo,
under [`docs/plugins`](https://github.com/mrmans0n/alas/tree/main/docs/plugins).
Plugins are experimental, and the API may still change.

| Plugin | API | What it does |
|---|---|---|
| [Kanban](plugins/kanban) | 4 | A ticket board. Starting a ticket starts an agent in a new worktree. |
| [Pixel Office](plugins/pixel-office) | 4 | Your project as a pixel-art office, one character per agent session. |
| [Linear](plugins/linear-bridge) | 5 | Your assigned Linear issues in a panel. Starting one runs an agent and comments back. |
| [Prompt Library](plugins/prompt-library) | 7 | Slash prompts for reviews, explanations, tests, commit messages and fixes, with editable templates. |
| [Notion Context](plugins/notion-context) | 7 | Adds a Notion page's content to every prompt sent to the project's agents. |
| [Nacho's PR Inbox](plugins/nacho-pr-inbox) | 8 | The repository's open pull requests by what they need, with squash-merge for the ready ones, through `gh`. |

## How a plugin runs

A plugin is one `plugin.js`, evaluated once in its own JavaScriptCore context. The only
globals are the ECMAScript built-ins and `alas`: there is no `console`, `setTimeout`,
`fetch`, `TextEncoder`, `require` or `process`. Alas delivers each JSON-RPC message as one
call to the `handle` function the script defines. A call has 250 ms (1 s for activation),
and JavaScriptCore runs without its JIT, so keep per-call work small.

Plugins are written in TypeScript on the SDK in [`sdk/alas`](sdk/alas) (`@alas/plugin`)
and bundled by esbuild into that one file.

```ts
import { definePlugin, log, render, type Event } from "@alas/plugin";

definePlugin({
  handle(event: Event) {
    if (event.type === "activate") render(0, { kind: "text", id: "hello", text: `Hello, ${event.projectName}` });
    if (event.type === "viewEvent") log("info", `clicked ${event.id}`);
  },
});
```

The SDK answers `alas/activate` before the plugin sees it, numbers requests, and decodes
replies: `requestSnapshot()`, `storageGet()` and `getSettings()` replies arrive as `snapshot`,
`stored` and `settings` events; a request sent with a callback (`fetch` always is) hands its
reply to it; every other reply arrives as a `reply` event carrying the id the request returned.

API 7 also has Alas ask the plugin: `promptExpand` (a slash prompt) and `contextProvide`
events carry `respond(text)` and `fail(message)`, which answer with the request's id. A
prompt may be answered in a later call, within 30 s, so it can `fetch` first; context must
be answered during the same `handle` call, from data the plugin already has:

```ts
handle(event: Event) {
  if (event.type === "contextProvide") event.respond(cachedNotes ?? null);
  if (event.type === "promptExpand") {
    fetch({ method: "GET", url: `https://api.example/issues/${event.args}` }, ({ response, error }) =>
      response ? event.respond(`Fix this issue:\n${response.body}`) : event.fail(error.message));
  }
}
```

## Building one locally

Needs Node.js 22.18 or later.

```bash
npm install
plugins/kanban/build.sh
```

`build.sh` installs into `~/Library/Application Support/Alas/Plugins/<folder>`. Set
`ALAS_APP_SUPPORT_DIR` to install into another Alas profile instead.

## Testing

```bash
npm run typecheck   # plugin sources are checked without DOM or Node globals
npm test            # node --test in every workspace
npm run build       # esbuild, one dist/plugin.js per plugin
```

Unit tests run the plugin in Node against `@alas/plugin/test`, a fake host that records
what the plugin sends and presents and enforces the per-call limits:

```ts
import { definePlugin } from "@alas/plugin";
import { testHost } from "@alas/plugin/test";

definePlugin(new MyPlugin());
testHost.dispatch({ jsonrpc: "2.0", method: "tick", params: { dt: 66 } });
const sent = testHost.takeSent(); // parsed messages
const frames = testHost.takeFrames(); // { tab, width, pixels }
testHost.reply(sent[0].id, { status: 200, headers: {}, body: "{}" }); // answer a request
testHost.notify("timer/fired", { id: "refresh" }); // or settings/changed, panel/visible, ...
testHost.secrets.add("apiKey"); // listed in secretsSet; a fetch naming an unset one is refused
testHost.changeSettings({ team: "ENG" }); // settings/changed with secretsSet filled in
```

Node is faster than Alas and has more globals, so on a Mac check a built plugin in
JavaScriptCore too. `scripts/jsc-run` runs it exactly as Alas does (bare context, no JIT,
the same time limit) and prints each call's wall and CPU time:

```bash
node scripts/scenarios/kanban-caps.mjs > /tmp/kanban.jsonl
scripts/jsc-run plugins/kanban/dist/plugin.js /tmp/kanban.jsonl
```

Each line of the scenario is one message. A reply may use `"id": "$<method>"` for the id of
the latest request the plugin sent with that method. `--png <file>` saves the last frame.

## Adding a plugin

1. Copy an existing plugin folder into `plugins/<your-plugin>` and change its `plugin.json`:
   a unique reverse-DNS `id`, `name`, a one-line `summary`, `version`, `"api": 4` (5 for
   commands, panels, settings, network, timers and events; 6 for the Changes, Run and session
   slots, badges, runs, reviews, processes and files; 7 for slash prompts and prompt context;
   8 for commands that open a tab and the `progress` and `link` view nodes),
   `"entry": "plugin.js"`, and only the capabilities it uses. Rename the package in its
   `package.json` and run `npm install` at the root.
2. Open a pull request. CI typechecks, tests and builds every workspace. Review is the
   curation step: a plugin in this repo is one people can install from inside Alas.

## Releasing

Bump `version` in the plugin's `plugin.json`, merge, then push a tag named
`<folder>-v<version>`:

```bash
git tag kanban-v0.3.0 && git push origin kanban-v0.3.0
```

The release workflow builds the plugin, publishes `plugin.json` and `plugin.js` as a
GitHub release, and adds the version to `index.json`:

```json
{
  "version": "0.3.0",
  "api": 4,
  "capabilities": ["workspace.read", "session.focus", "session.read", "tasks.start"],
  "manifest": "https://github.com/mrmans0n/alas-plugins/releases/download/kanban-v0.3.0/plugin.json",
  "entry": "https://github.com/mrmans0n/alas-plugins/releases/download/kanban-v0.3.0/plugin.js",
  "hash": "<scripts/trust-hash plugin.json plugin.js>"
}
```

`entry` is the URL of the release's `plugin.js`. `hash` is what Alas approves the plugin by
(`scripts/trust-hash`, over the manifest and `plugin.js`), so Alas verifies the download
before the user is asked to approve it. Versions released for the WebAssembly runtime stay in
the index with a `wasm` URL and `api` 1 to 3; Alas skips any version without `entry` or with
an `api` it does not support (4 to 8 today).

## License

MIT
