# Nacho's MR Inbox — design

A GitLab counterpart to `nacho-pr-inbox`: a tab and sidebar for the current
repository's open merge requests, its merge train, and where the user's own MRs
stand, with CI Doctor ported to GitLab CI.

## Decisions

- **Scope:** the current project's GitLab remote only (not cross-project).
  "Yours" = MRs authored by the logged-in `glab` user.
- **Actions:** add to merge train (single and "Add all"), retry failed jobs.
  No direct merge, no removing from the train.
- **Ready:** trust GitLab — `detailedMergeStatus == MERGEABLE`. Blocked MRs
  always show why.
- **Layout:** train strip on top, then pr-inbox-style tiles and groups.
  Sidebar is "mine"-focused.
- **CI Doctor:** full parity, mapped to GitLab pipelines/jobs.
- **Implementation:** a new self-contained plugin `plugins/nacho-mr-inbox`,
  starting as a copy of `nacho-pr-inbox` with the data layer rewritten for
  `glab`. `nacho-pr-inbox` is not changed. Extracting shared page code is a
  possible follow-up, not part of this work.

Hosts: `gitlab.com` by default, plus any self-managed GitLab the user is
logged in to with `glab`. Nothing names a specific self-managed host. Merge
trains need GitLab Premium/Ultimate and reviewer `reviewState` needs a recent
GitLab; both degrade gracefully (see below).

## Plugin shape

- `plugin.json`: id `io.nlopez.nacho-mr-inbox`, api 15, `remote: true`,
  capabilities `workspace.read`, `process.exec`, `timers`, `notify`,
  `session.write`, `network`. `network` lists `gitlab.com` and `secure.gravatar.com`, the
  avatar hosts of gitlab.com. The manifest is static, so avatars served by a
  self-managed host fall back to initials.
- Tab `inbox` ("MR Inbox", web) and right panel `rail` (web), commands `open`
  (repo menu + palette) and `rail` (palette). Icon `arrow.triangle.merge`.
- Files mirror pr-inbox: `src/inbox.ts`, `src/view.ts`, `src/protocol.ts`,
  `src/main.ts`, `src/doctor*.ts`, `page/main.ts`, fixtures, tests,
  `README.md`, `VALIDATION.md`, `build.sh`.

## Commands

All run with `glab` on the owning host (SSH projects run it remotely).

| Id | Command | Purpose |
|---|---|---|
| `list` | `glab api graphql` with a fixed query on `project(fullPath)` | Open MRs + recently merged + current username |
| `train` | `glab api projects/:id/merge_trains/:target_branch` (GET) | Active train cars, in order |
| `add` | `glab api -X POST projects/:id/merge_trains/merge_requests/:iid` (+ `when_pipeline_succeeds=true` when the pipeline is running) | Add to train |
| `automerge` | `glab mr merge --auto-merge :iid` | Fallback when trains are disabled |
| `retry` | `glab api -X POST` restricted to `projects/:id/jobs/:job_id/retry` and `projects/:id/pipelines/:id/retry` | Retry a job / all failed jobs of a pipeline |
| `ci-api` | `glab api` GET on an explicit project endpoint | CI Doctor reads |
| `ci-remotes` | `git remote -v` in the selected session worktree | Checkout verification |
| `ci-head` | `git rev-parse --verify HEAD` in that worktree | Checkout verification |

Argument validation in `main.ts` enforces: numeric ids/iids, a project path
matching the remote, and for `retry` exactly one of the two endpoint shapes.
`ci-api` only issues GETs.

### `list` query fields

Per open MR (first 50, `UPDATED_DESC`): `iid title webUrl draft
author{username avatarUrl} sourceBranch targetBranch diffHeadSha
detailedMergeStatus conflicts approvalsLeft approvalsRequired
reviewers{nodes{username mergeRequestInteraction{reviewState}}}
resolvableDiscussionsCount resolvedDiscussionsCount
headPipeline{id iid status jobs{count by status}}`.
Plus merged MRs (first 50 by `MERGED_AT_DESC`: `iid title webUrl sourceBranch
mergedAt author{username avatarUrl}`) and `currentUser{username}`.

Exact field names are confirmed against the server's GraphQL schema while
capturing fixtures. Where a field is missing, the REST equivalent is used.

### Project resolution

The remotes of the main worktree (`origin` first) are parsed for SSH, scp-like
and HTTPS URLs, giving `host` and full path `group/sub/project` (nested groups
allowed, `.git` stripped). `:id` is the URL-encoded full path. A remote counts
as GitLab when its host is:

1. `gitlab.com`, or
2. a host `glab` knows: listed by `glab auth status` / `glab config get host`
   / `GITLAB_HOST`, or
3. a host whose name contains `gitlab` (then `glab` must be logged in to it).

Commands pass `--hostname <host>` so the right login is used. A GitLab-looking
remote with no `glab` login → sign-in message naming that host. A remote that
matches none of these → "no GitLab remote".

### Refresh

Same as pr-inbox: when shown and data > 1 min old, every minute while the tab
or sidebar is visible, every 5 min while hidden, after any write, on Refresh.
`list` and `train` (one call per distinct target branch among open MRs) are
fetched together and published as one snapshot.

## Classification

Order: Ready, Blocked, Failing, Drafts. Within a group, most recently updated
first. MRs present in a train are shown only in the strip.

| Group | Rule (first match) |
|---|---|
| In train | iid is a car in the train for its target branch |
| Drafts | `draft` |
| Failing | head pipeline `failed` or `canceled` |
| Ready | `detailedMergeStatus == MERGEABLE` |
| Blocked | everything else |

### Chips

- `changes requested · @a, @b`: reviewers with `reviewState == REQUESTED_CHANGES` (danger)
- `💬 N unresolved`: `resolvable - resolved > 0` (warn)
- `needs N approval(s)` (warn) / `N/N approvals ✓` (success)
- `conflicts`, `needs rebase`, `blocked by dependency` (from `detailedMergeStatus`)
- Pipeline: `pipeline ✓` / `pipeline failed` / running bar with done/running/pending
  segments and `done/total`
- Any other non-`MERGEABLE` status: its humanized name (e.g. `jira association missing`),
  so a blocked MR is never unexplained.

Your rows: accent tint, `YOU` tag, accent avatar.

### Buttons

- Ready → **🚂 Add to train** (go style).
- Mergeable except pipeline still running (`CI_STILL_RUNNING`) → **🚂 Add when green**
  (plain style, `when_pipeline_succeeds=true`).
- Ready header with ≥ 2 ready → **Add all to train**: sequential, re-lists before each
  add and skips MRs no longer ready, stops at the first failure (shown on that row).
- Failing row → **Retry failed jobs** (pipeline retry) and **CI Doctor**.
- Trains disabled → add buttons become **Merge when green** (`automerge`).

## Train strip (tab)

One strip per target branch with an active train. Cars in order, left to right:
iid, then status (`merging ✓`, `⏳ done/total`, `queued`, `failed` in danger).
Your cars are ringed in the accent color. Clicking a car opens the MR. A failed car
stays until GitLab drops it. An empty train shows "Train empty".
If the train endpoint returns 403/404 for the project, the strip is replaced by
"Merge trains are off for this project" and the fallback buttons apply.

## Recently merged

Same as pr-inbox: merged in the last 24 h, or the last 5 if fewer; branch, time,
author, link.

## Sidebar

Vertical train list (all cars, yours in accent), then "Yours": your MRs not in
the train with chips and buttons, then "Open full inbox →". Failing rows
link to CI Doctor in the sidebar, as in pr-inbox.

Badge: number of your MRs in Ready. Hidden at 0. No notifications in v1.

## CI Doctor (GitLab)

Behavior and guarantees as in pr-inbox (see `2026-10-16-ci-doctor-design.md`),
with this mapping:

| Actions | GitLab |
|---|---|
| Workflow run | Pipeline from `merge_requests/:iid/pipelines`, labelled by source: branch, detached MR, merged results, merge train |
| Run attempt | Retries: `pipelines/:id/jobs?include_retried=true` grouped by job name, each retry one attempt |
| Job | Job: name, stage, status, `failure_reason`, timestamps, `web_url` |
| Steps | Trace sections (`section_start:<ts>:<name>` markers). Failing section = last opened before failure. No sections → "steps unavailable" |
| Log excerpt | `jobs/:id/trace`, ANSI stripped, same 100-line / 12 KiB excerpt rules |
| Run SHA vs head | Pipeline `sha` vs MR `diffHeadSha`. Merged-results and train pipelines run on a synthetic merge commit, labelled as such and never assumed equal to HEAD |
| Base comparison | Same job name in recent pipelines with `ref=<target branch>` |
| Infrastructure clue | `failure_reason` in {`runner_system_failure`, `stuck_or_timeout_failure`, `scheduler_failure`, `api_failure`} plus existing log markers |

Each failed job in the doctor gets **Retry** (job retry). After a retry the
previous run stays listed as an earlier attempt, and a pass after retry alone
still does not establish a flake.

Unchanged: 14-day window; ≤ 30 pipelines per query in pages of 10; ≤ 5
comparison pipelines per side; ≤ 100 jobs per pipeline in pages of 25; ≤ 4
comparison logs per job; ≤ 8 cached entries in 256 KiB of project storage;
brief < 32 KiB; explicit session selection; remote + HEAD verification;
identity re-check before `sessionSend`; no automatic retry of sends. Links
are accepted only for `https://<project host>/`. Remote verification matches
the project's host and full path.

## Errors and limits

- `glab` missing / not logged in to the host → "Sign in with
  `glab auth login --hostname <host>` in a terminal, then Refresh."
- No GitLab remote → "This repository has no GitLab remote."
- Server without `reviewState` in its schema → the query omits it and the
  `changes requested` chip is not shown; everything else works.
- Write failure (add, retry, automerge) → GitLab's message under that row.
- Auth failures and rate limits pause CI Doctor until explicit Retry/Refresh.
- One write at a time (queued). At most two processes total, list and writes first.
- 50 open MRs, 50 merged candidates.

## Testing

- Fixtures: `list`, `train`, pipelines, jobs, and a trace, captured from a
  real GitLab and scrubbed: host rewritten to `gitlab.example.com`, project,
  user and branch names replaced. No real host or name stays in the repo.
- Remote parsing tests: gitlab.com SSH/HTTPS, nested groups, self-managed host
  known to `glab`, host containing `gitlab`, non-GitLab host.
- Unit tests: list/train parsing, classification, chips, buttons, strip and
  sidebar models, badge count, argument validation for each command, CI Doctor
  parsing (pipelines, retries → attempts, trace sections, excerpts,
  classification), brief, cache.
- `VALIDATION.md` manual checklist: real train view, add one, add all, add when
  green, retry job and pipeline, trains-disabled fallback, sign-in message, SSH
  project, CI Doctor investigate → send.
