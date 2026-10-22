# Nacho's PR Inbox

A personal tool for Nacho's merge workflow: a tab listing the repository's open
pull requests, sorted by what they need, with a button that squash-merges the
ones that are ready. Anyone who uses the GitHub CLI can install it; it reuses
your `gh` login and asks for no token. It is shown only in projects with a recognized GitHub remote, never in plain
folders, and needs an Alas with plugin API 17. It uses plugin API 17: the tab and the
sidebar panel are web pages (`ui.js`) the plugin feeds its state, the sidebar
icon carries a badge with the ready count, and `gh` runs through `process.exec`.
On an SSH project it runs `gh` on the host (`remote`, API 11), so `gh` must be
installed and logged in there.

## Build and install

From the repository root:

```bash
npm install
plugins/nacho-pr-inbox/build.sh
```

`build.sh` installs into `~/Library/Application Support/Alas/Plugins/nacho-pr-inbox`.
Set `ALAS_APP_SUPPORT_DIR` to install into an isolated Alas profile instead.
Approve it in **Settings → Plugins**. The approval sheet lists its declared
commands, permission to send a reviewed brief to an agent session, and that it
shows its own web content, with images from `avatars.githubusercontent.com`.
That host is its only `network` entry, so it is also allowed web requests there
(it makes none): it is what lets the page show authors' GitHub avatars. `ui.js` is covered by the
approval, so every rebuild that changes it asks again.

## Use

Choose **PR Inbox** from the project's context menu or the repo selector. The
tab lists up to 50 open pull requests of the repository's GitHub remote, the
most recently updated first within each group:

| Group | When |
|---|---|
| Ready to merge | Checks passed, a 👍 from the Codex bot on the description (Renovate's need none), not a draft, no conflicts. Review state shows as a badge but never blocks |
| Waiting | Every other open pull request |
| Failing | Checks failed or errored |
| Drafts | Drafts |

The header shows a tile per group with its count; click one to show only that
group, and again to show them all. Each row shows the author's GitHub avatar (their initials
while it loads, or when it is not on `avatars.githubusercontent.com`, as on GitHub Enterprise),
with the account name on hover, then the branch and chips for checks, review, Codex (👍 once it
approves, 👀 while it reviews, nothing otherwise) and conflicts, and opens the pull request in the browser. While checks run, a
bar beside the checks badge fills with the finished ones in green (red once
one failed), the running ones in yellow, and the rest gray, captioned
`done/total`. Every row with the Codex 👍 (or by Renovate) that is
not a draft and has no conflicts gets a merge button, which runs
`gh pr merge --squash --delete-branch <number>`: green with a checkmark when
checks passed, plain while they run, and **Merge anyway** in the warning color
when they failed. A failure shows under the title.

With two or more ready, **Merge all** squash-merges each of them, one at a time.
Before each merge it lists the pull requests again and skips one that is no
longer ready; it stops at the first failure, which shows under that row.

Below the open ones, **Recently merged** lists the pull requests merged in the
last 24 hours, or the last 5 when fewer, the most recently merged first, each
with its branch, when it merged and who wrote it, and a link to open it. GitHub cannot sort by merge time, so the query fetches the 50 most
recently updated merged pull requests and the tab sorts those by merge time. The list refreshes when the tab is shown and
its data is over a minute old, after a merge, on **Refresh**, and every minute
while the tab or sidebar is shown, and every five minutes while both are hidden.
Detailed CI logs and history load only when opened.

Without `gh`, or without a login, the tab asks you to run `gh auth login` in a
terminal on the owning host. List and merge run in the project's main worktree;
CI API calls name the repository explicitly. Session checkout verification runs
in the selected session's own worktree, on its local or SSH host.

## CI Doctor

Choose **CI Doctor** on an open PR to inspect Actions workflow runs, separate
rerun attempts, jobs, failed steps, status/conclusion, timestamps and GitHub links.
The tab and compact sidebar share selection. **← Inbox** returns to the existing PR
list. Use the PR Inbox command to open the tab when more space is useful.

Pick a job to fetch a useful excerpt and bounded comparisons
with the same workflow and exact job name on the PR and base branch. The view
shows both the PR head and GitHub's recorded run SHA. An observed checkout SHA
is labelled separately; when the log does not establish it, it stays unknown.
Synthetic PR merge refs and custom checkouts must not be assumed to equal HEAD.

Suggestions cite their jobs. **Recurring failure** requires the same recognizable
test/error signature. **Possible regression** needs a comparable passing base
job and usable history. Infrastructure/dependency markers remain qualified clues.
Unrelated base failures and a passing rerun alone never establish a flake.
Comparisons show their commits and observation window; unavailable evidence stays
unknown. These suggestions do not change merge eligibility.

**Investigate…** prepares a selectable, copyable brief with the question, identities,
links, excerpts and comparison evidence. Edit the question and use Command-Return
to apply it to the preview. Select a session explicitly. CI Doctor checks the
selected worktree's GitHub remotes and HEAD; branch equality is insufficient.
A repository or checkout mismatch is shown before sending. A verified base
checkout or different SHA needs acknowledgement; an unrelated repository blocks
sending.

**Send investigation** refreshes the snapshot, repository/checkout, PR identity
and run identity, then queues the reviewed brief once with `sessionSend`. Changing
identities stops the send. API 15 does not expose terminal/chat kind, so the host
checks live chat availability and refuses terminal-only, removed or unavailable
sessions. The brief stays copyable after a refusal. There is no automatic retry;
prepare a new investigation to send again. Logs are quoted as untrusted evidence.
Checkout verification is a timestamped observation, not a lock on a worktree.

Cached evidence has timestamps and a versioned schema. Restart refreshes the PR
list, and opening details refreshes live status. A failed refresh retains usable
evidence labelled cached or historical. A push, force-push, rerun or changed
selection cannot receive another request's diagnosis. Authentication failures
need explicit Retry/Refresh; rate limits pause detailed GitHub work until reset.

## Commands it runs

| Id | Command |
|---|---|
| `list` | `gh api graphql -F owner={owner} -F name={repo} -f query=…`, a fixed query for the open pull requests and the recently merged ones |
| `merge` | `gh pr merge --squash --delete-branch`, plus the pull request number |
| `ci-api` | `gh api`, plus an explicit repository REST endpoint, GET, response headers and bounded JSON projection |
| `ci-remotes` | `git remote -v`, in the explicitly selected session worktree |
| `ci-head` | `git rev-parse --verify HEAD`, in that same worktree |

## Limits

- One merge at a time; Merge all queues them.
- At most two processes across list, merge, CI detail and identity work, with
  list/merge priority and shared duplicate requests.
- A 14-day history window, up to 30 run summaries per query in pages of 10.
  Comparisons inspect up to five recent runs per side and five attempts per run.
  When there are more attempts, attempt 1 and the latest four are kept.
  The first failure may fall in omitted attempts and is then unknown.
- Up to 100 jobs per attempt, in pages of 25, and 100 matching comparison jobs.
  Lists show five failed steps per job and link to all steps on GitHub.
- At most four comparison failure logs per selected job. An excerpt contains at
  most 100 lines and 12 KiB, around a recognizable error or test failure where
  captured. The host retains only the first 512 KiB of combined process output,
  sometimes less. Omitted pages, attempts and log content are explicitly labelled.
- At most eight cached detail entries within 256 KiB of project storage. Oldest
  entries are evicted first; session selection and dispatch state are not restored.
- The brief stays below the host's 32 KiB UTF-8 prompt limit. Long previews use
  multiple selectable literal blocks to respect native string limits.
- GitHub Actions only. Missing/expired logs, access/authentication failures,
  truncation and incomplete history cannot prove that a job passed.

See [validation notes](VALIDATION.md) for automated checks and manual verification.
