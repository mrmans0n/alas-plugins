# Nacho's PR Inbox

A personal tool for Nacho's merge workflow: a tab listing the repository's open
pull requests, sorted by what they need, with a button that squash-merges the
ones that are ready. Anyone who uses the GitHub CLI can install it; it reuses
your `gh` login and asks for no token. It uses plugin API 14 (a command that
opens its tab, progress, progress bar and link view nodes, tab visibility, the main
worktree flag and button tones) and runs `gh` through `process.exec`.

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

Each row shows the branch and badges for checks, review, Codex (👍 once it
approves, 👀 while it reviews, nothing otherwise) and conflicts, and opens the pull request in the browser. While checks run, a
bar beside the checks badge fills with the finished ones in green (red once
one failed), the running ones in yellow, and the rest gray, captioned
`done/total`. Every row with the Codex 👍 that is
not a draft and has no conflicts gets a merge button, which runs
`gh pr merge --squash --delete-branch <number>`: green with a checkmark when
checks passed, plain while they run, and **Merge anyway** in the warning color
when they failed. A failure shows under the title.

Below the open ones, **Recently merged** lists the last 10 merged pull
requests, the most recently merged first, each with its branch, when it
merged and who wrote it, and a link to open it. **Show more** adds 10 more at
a time. GitHub cannot sort by merge time, so the query fetches the 50 most
recently updated merged pull requests and the tab sorts those by merge time. The list refreshes when the tab is shown and
its data is over a minute old, after a merge, on **Refresh**, and every minute
while the tab is shown. Nothing runs while it is hidden.

Without `gh`, or without a login, the tab asks you to run `gh auth login` in a
terminal. Both commands run in the project's main worktree, and `gh` finds the
repository from its git remote.

## Commands it runs

| Id | Command |
|---|---|
| `list` | `gh api graphql -F owner={owner} -F name={repo} -f query=…`, a fixed query for the open pull requests and the recently merged ones |
| `merge` | `gh pr merge --squash --delete-branch`, plus the pull request number |

## Limits

- One merge at a time.
