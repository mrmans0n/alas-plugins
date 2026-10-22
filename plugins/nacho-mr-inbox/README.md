# Nacho's MR Inbox

The GitLab counterpart of Nacho's PR Inbox: a tab listing the project's open
merge requests by what they need, with its merge train on top and buttons to add
the ready ones to the train. Anyone who uses the GitLab CLI can install it; it
reuses your `glab` login and asks for no token. It is shown only in projects with a recognized GitLab remote (gitlab.com or a
host named gitlab.*, as Alas detects it), never in plain folders, and needs an
Alas with plugin API 17. It uses plugin API 17: the tab
and the sidebar panel are web pages (`ui.js`) the plugin feeds its state, the
sidebar icon carries a badge, and `glab` runs through `process.exec`. On an SSH
project it runs `glab` on the host (`remote`), so `glab` must be installed and
logged in there.

## Build and install

From the repository root:

```bash
npm install
plugins/nacho-mr-inbox/build.sh
```

`build.sh` installs into `~/Library/Application Support/Alas/Plugins/nacho-mr-inbox`.
Set `ALAS_APP_SUPPORT_DIR` to install into an isolated Alas profile instead.
Approve it in **Settings → Plugins**. The approval sheet lists its declared
commands, permission to send a reviewed brief to an agent session, and that it
shows its own web content, with images from `gitlab.com` and
`secure.gravatar.com`. Those are its only `network` entries, so it is also
allowed web requests there (it makes none): they let the page show authors'
avatars. Avatars from a self-managed host are not loaded; those authors show
their initials. `ui.js` is covered by the approval, so every rebuild that
changes it asks again.

## Sign in

The plugin uses `glab`'s login and its remote detection; it never parses your
remotes to list or write. For gitlab.com, run `glab auth login`. For
self-managed GitLab, run `glab auth login --hostname <your host>` (for example
`gitlab.example.com`) in a terminal on the host that owns the project. Without
`glab` or a login the tab says so and asks for a Refresh afterwards. A
repository with no GitLab remote `glab` knows shows a no-remote message.

## Use

Choose **MR Inbox** from the project's context menu or the repo selector. The
tab lists up to 50 open merge requests of the repository's GitLab project, the
most recently updated first within each group. GitLab decides readiness.

| Group | When |
|---|---|
| Ready | GitLab's `detailedMergeStatus` is `MERGEABLE`, not a draft, head pipeline not failed or canceled |
| Blocked | Every other open MR, with chips saying why |
| Failing | The head pipeline failed or was canceled |
| Drafts | Drafts |

A merge request already in a train is shown only in the train strip. The header
shows a tile per group with its count; click one to show only that group, and
again to show them all.

**All | Mine.** A toggle in the tab's header (not in the sidebar rail) switches
between every MR and only yours (authored by the `glab` user). With **Mine** on,
the groups, their counts and **Recently merged** show only your MRs (your merges are picked first, then the usual last-24-hours-or-5 trim applies), and an
empty result says "No open merge requests of yours." **Add all** follows it: it
covers only your ready MRs, in its count and label and in the re-check before
each add, so an MR that is not yours is never added while **Mine** is on. The
train strip stays complete, since your place in the train depends on the other
cars. The choice is remembered per project; it starts on **All**. The toggle is
hidden while `glab` has not told the plugin who you are.

**Train strip.** One strip per target branch with an active merge train, the
cars in merge order, each with its `!iid` and a status: `merging ✓`, `⏳ done/total`
while its pipeline runs, `queued`, `restarting`, or `failed`. Your cars carry a
`YOU` tag and are ringed in the accent color. A car opens its MR. A failed car
stays until GitLab drops it.

**Chips** on each row explain it: pipeline state (`✓ pipeline`, `✗ pipeline`,
`pipeline canceled`, `no pipeline`, or a progress bar captioned `done/total`
while it runs), `changes requested · @ana, @bob`, `💬 N unresolved`,
`needs N approval(s)` or `✓ approved`, `conflicts`, `needs rebase`, `blocked by
dependency`, `checking…`, and for any other status its lowercased name, so a
blocked MR is never unexplained. Your rows get an accent tint and a `YOU` tag.

**Buttons.**

- Ready: **🚂 Add to train**.
- Mergeable except that its pipeline is still running: **🚂 Add when green**
  (GitLab adds it when the pipeline succeeds).
- Two or more ready: **🚂 Add all N to train** adds them one at a time. Before
  each add it lists the MRs again and skips one that is no longer ready; it stops
  at the first failure, which shows under that row.
- Failing: **↻ Retry failed** restarts the head pipeline's failed jobs, and
  **CI Doctor** opens the investigation.
- Merge trains off for the project: a banner says so and the buttons become
  **Merge when green** (and **Merge all N when green**), which set auto-merge
  when the pipeline passes. Whether trains are on is read when the plugin starts
  and on **Refresh**. The buttons fall back to this only when GitLab reports trains
  off; if that call fails or is unreadable, the previous answer stays (unknown counts
  as on) and it is asked again on the next refresh.

A failed write shows GitLab's message under the row. There is no removing a car
from the train. With trains on there is no direct merge; with trains off, **Merge
when green** on an MR whose pipeline already passed merges immediately.

Below the open ones, **Recently merged** lists the MRs merged in the last 24
hours, or the last 5 when fewer, with branch, when it merged and who wrote it.

The sidebar rail shows the train as a vertical list of cars (yours marked), then
**Yours**: your MRs that are not in the train, with the same chips and buttons,
and a link to the full inbox. The rail icon's badge is the number of your MRs
that are ready; it is hidden at zero. "Yours" means authored by the `glab` user.

The list refreshes when the tab is shown and its data is over a minute old, after
an add or retry, on **Refresh**, every minute while the tab or sidebar is shown,
and every five minutes while both are hidden. One `list` call returns the MRs
and the trains together, so they never disagree.

## CI Doctor

Choose **CI Doctor** on a row with a head pipeline. It maps GitHub concepts in
the PR Inbox's CI Doctor to GitLab, with the same guarantees (cited suggestions,
no inferring a flake from a passing retry, cached evidence labelled as such,
explicit session selection, identity re-check, a single send):

| Actions | GitLab |
|---|---|
| Workflow run | A pipeline of the MR, labelled by source: branch, detached MR, merged results, merge train |
| Run attempt | A retry of a job: jobs grouped by name, each retry one attempt |
| Job | Job name, stage, status, `failure_reason`, timestamps, link |
| Steps | Log sections (`section_start:` markers); the failing section is the last one opened before the failure, or "steps unavailable" |
| Log excerpt | The last 256 KiB of the job log, ANSI and section markers stripped, at most 100 lines and 12 KiB |
| Run SHA vs head | The pipeline's SHA against the MR's head SHA; merged-results and train pipelines run on a synthetic commit and are labelled, never assumed equal to HEAD |
| Base comparison | The same job name in recent pipelines on the target branch |
| Infrastructure clue | `failure_reason` of `runner_system_failure`, `stuck_or_timeout_failure`, `scheduler_failure` or `api_failure`, plus log markers |

Each failed job has a **↻ Retry** button (job retry); the earlier run stays
listed as an earlier attempt. **✦ Investigate…** prepares a copyable brief;
select a session explicitly, and **Send investigation** queues it once after
re-checking the checkout (the selected worktree's remotes and HEAD) and the MR
and pipeline identity. GitLab logs are only the last 256 KiB, because GitLab
ignores range requests and failures are at the end; a cut head is labelled
truncated. Expired logs show as unavailable. A rate limit pauses every `glab` call except
the git ones until GitLab's retry time (60 seconds when it gives none), then they
resume by themselves; an authentication failure pauses them until Retry or Refresh.

## Commands it runs

All run through `glab` in the project's main worktree, on the owning host. `glab`
fills `:fullpath` and `:id` from the repository's remotes. The plugin builds every
appended argument itself and checks it against a strict pattern first.

| Id | Command |
|---|---|
| `list` | `glab api graphql -F fullPath=:fullpath -f query=…`, a fixed query for the open MRs, the merge trains with their cars, the recently merged MRs, the current user and the project URL |
| `project` | `glab api projects/:id`, read for `merge_trains_enabled` |
| `add` | `glab api --method POST`, plus `projects/:id/merge_trains/merge_requests/<iid>`, `-f sha=<head>` and, for add when green, `-f auto_merge=true` |
| `automerge` | `glab api --method PUT`, plus `projects/:id/merge_requests/<iid>/merge`, `-f sha=<head>`, `-f auto_merge=true`, `-f merge_when_pipeline_succeeds=true` (when trains are off) |
| `retry` | `glab api --method POST`, plus `projects/:id/jobs/<id>/retry` or `projects/:id/pipelines/<id>/retry` |
| `ci-api` | `glab api --method GET --include`, plus an explicit `projects/:id/…` read endpoint |
| `ci-trace` | `sh -c` running `glab api projects/:id/jobs/$1/trace`, keeping the last 256 KiB with `tail -c`, plus the job id |
| `ci-remotes` | `git remote -v`, in the explicitly selected session worktree |
| `ci-head` | `git rev-parse --verify HEAD`, in that same worktree |

## Limits

- One add (or merge when green) at a time, and one pipeline retry at a time; a
  CI Doctor job retry is limited to one at a time on its own. At most two
  processes across all commands, list and writes first, with shared duplicate
  requests.
- 50 open MRs and 50 merged candidates per list; at most 20 cars per train.
- Avatars load only from gitlab.com and Gravatar; elsewhere, initials.
- The list query was verified against GitLab 19.4 (gitlab.com is always current). A GitLab
  too old for a field of the fixed query fails the list, and the tab shows
  GitLab's error. Merge trains need GitLab Premium or Ultimate.
- A 14-day history window, up to 30 pipelines per query in pages of 10, up to five
  comparison pipelines per side, up to 100 jobs per pipeline in pages of 25, and
  at most four comparison logs per selected job. Omitted pages and log content
  are labelled.
- At most eight cached detail entries within 256 KiB of project storage; session
  selection and dispatch state are not restored. The brief stays below the host's
  32 KiB prompt limit. Links are accepted only under the project's own host.
- GitLab CI only. Missing or expired logs, authentication failures, truncation and
  incomplete history cannot prove that a job passed.

See [validation notes](VALIDATION.md) for automated checks and the manual checklist.
