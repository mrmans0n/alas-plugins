# Nacho's PR Inbox

A personal tool for Nacho's merge workflow: a tab listing the repository's open
pull requests, sorted by what they need, with a button that squash-merges the
ones that are ready. Anyone who uses the GitHub CLI can install it; it reuses
your `gh` login and asks for no token. It uses plugin API 8 (a command that
opens its tab, progress and link view nodes) and runs `gh` through
`process.exec`.

## Build and install

From the repository root:

```bash
npm install
plugins/nacho-pr-inbox/build.sh
```

`build.sh` installs into `~/Library/Application Support/Alas/Plugins/nacho-pr-inbox`.
Set `ALAS_APP_SUPPORT_DIR` to install into an isolated Alas profile instead.
Approve it in **Settings → Plugins**; it runs commands, so the approval sheet
lists both of them.

## Use

Choose **PR Inbox** from the project's context menu or the repo selector. The
tab lists up to 50 open pull requests of the repository's GitHub remote, the
most recently updated first within each group:

| Group | When |
|---|---|
| Ready to merge | Checks passed, a 👍 from the Codex bot on the description, not a draft, no conflicts. Review state shows as a badge but never blocks |
| Failing | Checks failed or errored |
| Waiting | Every other open pull request |
| Drafts | Drafts |

Each row shows the branch and badges for checks, review, the Codex 👍 and
conflicts, and opens the pull request in the browser. Ready rows get
**Squash & merge**, which runs `gh pr merge --squash --delete-branch <number>`;
a failure shows under the title. The list refreshes when the tab opens, after a
merge, on **Refresh**, and every minute once you have opened or used it.

Without `gh`, or without a login, the tab asks you to run `gh auth login` in a
terminal. Both commands run in the project's main worktree, and `gh` finds the
repository from its git remote.

## Commands it runs

| Id | Command |
|---|---|
| `list` | `gh api graphql -F owner={owner} -F name={repo} -f query=…`, a fixed query for the open pull requests |
| `merge` | `gh pr merge --squash --delete-branch`, plus the pull request number |

## Limits

- View tabs do not report whether they are shown, so once the tab has been
  opened the plugin refreshes every minute until it restarts.
- One merge at a time.
