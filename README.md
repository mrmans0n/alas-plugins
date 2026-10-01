# Alas plugins

Plugins for [Alas](https://github.com/mrmans0n/alas). Each folder in `plugins/` is one
plugin, and every release is listed in [`index.json`](index.json), the catalog Alas
reads to offer them in **Settings → Plugins**.

The plugin contract (messages, capabilities, limits) is documented in the Alas repo,
under [`docs/plugins`](https://github.com/mrmans0n/alas/tree/main/docs/plugins).
Plugins are experimental, and the API may still change.

| Plugin | API | What it does |
|---|---|---|
| [Kanban](plugins/kanban) | 3 | A ticket board. Starting a ticket starts an agent in a new worktree. |
| [Pixel Office](plugins/pixel-office) | 2 | Your project as a pixel-art office, one character per agent session. |

## Building one locally

```bash
rustup target add wasm32-unknown-unknown
plugins/kanban/build.sh
```

`build.sh` installs into `~/Library/Application Support/Alas/Plugins/<folder>`. Set
`ALAS_APP_SUPPORT_DIR` to install into another Alas profile instead.

## Adding a plugin

1. Copy an existing plugin folder into `plugins/<your-plugin>` and change its `plugin.json`:
   a unique reverse-DNS `id`, `name`, a one-line `summary`, `version`, `api`, and only the
   capabilities it uses. Depend on the SDK with `alas-plugin = { path = "../../sdk/alas-plugin" }`.
2. Add the folder to the matrix in `.github/workflows/ci.yml`.
3. Open a pull request. Review is the curation step: a plugin in this repo is one people
   can install from inside Alas.

## Releasing

Bump `version` in the plugin's `plugin.json` and `Cargo.toml`, merge, then push a tag
named `<folder>-v<version>`:

```bash
git tag kanban-v0.3.0 && git push origin kanban-v0.3.0
```

The release workflow builds the plugin, publishes `plugin.json` and `plugin.wasm` as a
GitHub release, and adds the version to `index.json`. The index entry carries the hash Alas
approves the plugin by (`scripts/trust-hash`), so Alas verifies the download before the
user is asked to approve it.

## License

MIT
