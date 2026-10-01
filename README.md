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
replies: `requestSnapshot()` and `storageGet()` replies arrive as `snapshot` and `stored`
events, every other reply as a `reply` event carrying the id the request returned.

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
   a unique reverse-DNS `id`, `name`, a one-line `summary`, `version`, `"api": 4`,
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
GitHub release, and adds the version to `index.json`. The index entry carries the hash Alas
approves the plugin by (`scripts/trust-hash`, over the manifest and `plugin.js`), so Alas
verifies the download before the user is asked to approve it.

## License

MIT
