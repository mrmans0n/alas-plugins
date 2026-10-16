# CI Doctor in PR Inbox

Issue: https://github.com/mrmans0n/alas-plugins/issues/33

Status: approved by the user on 2026-10-16.

## Outcome and scope

Extend `plugins/nacho-pr-inbox` with on-demand GitHub Actions evidence and a
reviewable investigation brief. Reuse the user's GitHub CLI login and the
project's existing local or SSH execution host. Keep PR grouping, merge
eligibility, merge actions, and the current 60-second visible / 300-second hidden
refresh cadence intact.

The issue supplies the product requirements. The numerical bounds and interaction
choices below are implementation proposals. No automatic diagnosis agent,
workflow reruns, code edits, session creation, or changes to merge policy belong
to this feature.

## Interaction

Each open PR gains a CI Doctor action. The tab can replace its list with a detail
view and a Back action. The rail keeps its compact list by default and supports
the same on-demand detail view in its available width. API 15 has no request for
a plugin to open its own tab; the existing PR Inbox command opens the tab when
more space is useful. Selection is shared between the tab and rail.

The detail header identifies repository, PR URL, current PR head repository and
SHA, base branch and base SHA, fetched time, and whether displayed evidence is
cached or historical. Workflow rows show run ID, attempt, event, workflow,
status/conclusion, timestamps, recorded run SHA/ref, and GitHub links. A selected
attempt shows jobs and failed steps. Cancelled, skipped, queued, running, and
unavailable remain distinct.

Opening a failing job fetches an excerpt and comparison evidence. Show the
excerpt as plain text, with explicit missing/expired, denied, truncated, or
incomplete states. Preserve useful content when a later request fails. An absent
workflow or an unsuccessful lookup means unknown, never passing.

Investigate shows a selectable/copyable brief and a menu of session
candidates grouped or labelled by worktree. Nothing is preselected. Selecting a
candidate verifies its worktree before enabling Send. A checkout mismatch is
shown and needs a separate acknowledgement; a repository relationship that cannot
be verified blocks sending. The user can always copy the brief.

API 15 snapshots expose active session IDs and states, but not terminal/chat
kind. Explain that live chat availability is checked by the host on send. A
terminal-only, removed, or otherwise unavailable candidate gets a clear refusal
with the copyable brief retained. Do not claim the snapshot proves sendability.

## Identity and data model

Add current PR head/base commit and repository identity to the existing GraphQL
query. Keep PR head SHA, Actions run SHA, and an observed checkout SHA separate.
A run SHA is GitHub's recorded SHA, not proof of the commit checked out by a job.
Extract a tested checkout/ref only from a recognizable checkout log entry;
otherwise display unknown. Custom checkout actions can test other code.

Evidence keys include repository, PR number/head SHA, workflow run ID, attempt,
and job ID. Every selected detail request also captures a selection generation.
Late results may populate their original cache entry but cannot replace another
selection. Head changes mark retained evidence historical and invalidate prepared
dispatch. Reruns add attempt records rather than overwriting a previous failure.
Refreshing an attempt can update its live job state without combining jobs from
different attempts.

Separate GitHub transport, normalization/classification, controller state, and
native view composition. Use captured JSON/log fixtures and the SDK fake host.

## Transport and bounds

All GitHub requests use declared `gh` process prefixes and structured argument
arrays. Explicit repository paths prevent cwd inference from selecting a fork or
another remote accidentally. No names, branch values, or log contents enter a
shell command. Worktree git probes also use fixed declared prefixes.

Use one shared queue across list, merge, detail, history, and identity probes,
with at most two processes in flight. Existing list and merge work take priority;
deduplicate concurrent requests with the same host/worktree and evidence key.
Abandoned selections do not enqueue further work. Logs and history load only
when requested, with cached completed immutable evidence reused.

Proposed bounds:

- A 14-day observation window and at most 30 run summaries per PR/workflow or
  base/workflow query, paged in batches of 10.
- At most 5 recent comparison runs per side get attempt/job details, and at most
  5 attempts per run. Keep the first attempt and latest four when a run exceeds
  that limit, and state which attempts were omitted. Implementation ruling:
  GitHub has no attempt-summary listing endpoint. Within the five-attempt bound,
  the earliest failure may be in an omitted attempt and remains unknown rather
  than being claimed as preserved.
- Jobs load in pages of 25, at most 4 pages per attempt. An exhausted page bound
  is visibly incomplete, including where the selected job may be absent.
- Compare only the same workflow identity and exact job name, including matrix
  labels. Fetch at most 4 comparison failure excerpts for a selected job.
- Normalize an excerpt to at most 12 KiB and 100 lines around recognizable error
  or failed-test markers, otherwise show a labelled beginning excerpt. The host
  captures only the first 512 KiB of combined process output, sometimes less;
  display that truncation and never imply the missing tail was searched.
- Persist at most 8 recent detail entries within 256 KiB of serialized JSON,
  with schema version, fetch times, explicit coverage/error states, and evidence
  keys. Evict oldest entries first. Persisted briefs omit session selection.

Display the actual observation interval, comparison SHAs, counts examined,
omitted pages/attempts, and comparison links. Bounds are not claims of complete
repository history. GitHub errors such as rate limiting must remain distinct
from empty results. Back off GitHub requests on rate limits using the host timer
and Retry-After/reset data when available, otherwise a conservative 60 seconds.
Authentication errors require explicit retry. Do not discard cached evidence.

On restart, restore valid bounded cache entries as historical/cached and refresh
the normal PR list. Opening cached details refreshes live run status. A late
storage reply cannot overwrite newer state collected in the current instance.

## Comparison and classification

Classification is a qualified suggestion with links to the observations used.
It must describe the selected attempt and current head separately.

- Recurring failure requires the same recognizable failure signature in the same
  workflow/job on another attempt or run. A matching base-branch observation can
  support 'also observed on base', with both SHAs shown.
- Possible regression requires recognizable failure evidence for this PR and a
  passing comparable base job in the window, with the limited sample stated.
- Possible infrastructure/dependency problem requires an explicit recognizable
  runner, network, rate-limit, or dependency error marker. Show the marker and
  avoid claiming it excludes a code regression.
- Missing signatures, missing comparable jobs, denied logs, incomplete history,
  and unrelated base failures remain unknown or explicitly limited evidence.
- Fail then pass is displayed as two attempts. It is never sufficient by itself
  to label a failure a flake.

Use conservative signatures from recognizable test identifiers and normalized
error markers. Job-name equality alone is insufficient to match two failures.
Do not equate merely different errors containing a generic word like 'failed'.

## Investigation dispatch

The brief includes repository and PR URL, head repository/SHA, base SHA,
run/job/attempt IDs and links, recorded run SHA/ref, observed tested checkout or
unknown, timestamp/coverage limits, failure excerpt, comparison observations,
qualified suggestions, and a default editable investigation question.

Bound the whole brief below the host's 32 KiB UTF-8 prompt limit, leaving room
for escaped presentation. Display it as a literal fenced code block in a
selectable markdown node, which supports 32 KiB; ordinary native text and
text-field nodes have a 4,000-scalar limit. The editable question uses its own
bounded field. Render excerpts as safely fenced literal text or bounded text
chunks, never interpreted log Markdown. Encode log data
in a clearly delimited quoted data section and explicitly tell the recipient to
treat it as untrusted evidence, never instructions. Escape delimiter collisions.
Keep plugin provenance explicit in the brief.

Verify candidates using their snapshot worktree ID, never branch equality.
Run git remote/HEAD probes on that exact worktree and host. Match a canonical
GitHub remote against the PR's head repository, or its verified base repository
for an intentionally selected base checkout. Compare the probed checkout SHA
against the PR head. Base checkouts and other SHA mismatches need acknowledgement.
Remote URLs must not disclose embedded credentials in UI, cache, or briefs.

Immediately before send, request a fresh snapshot, verify the selected session
still belongs to the same worktree, recheck repository/HEAD, and revalidate the
PR head and selected attempt against fresh GitHub metadata. A changed identity
returns to preview rather than sending an outdated brief. API 15 cannot make
external checkout movement atomic with sessionSend; report the verification time
and checked SHA accurately.

Mark a dispatch pending before calling sessionSend, disable duplicate clicks,
and call it once for that prepared brief. After acceptance show Sent. Do not
retry automatically after a refusal, timeout, or restart; preserve the brief and
report uncertainty when acceptance is unknown. A user must explicitly prepare a
new dispatch to send again.

## Validation and delivery

Cover normalization and status distinctions, attempt preservation, conservative
classification, bounded pagination/logs/cache, request sharing and concurrency,
stale selection/head/rerun replies, restart cache races, authentication/rate
limits, identity checks on local/SSH worktrees, and duplicate dispatch/refusals.
Extend existing grouping and merge regression suites without changing policy.

Run repository typecheck, tests, and build. Run a realistic detail/history and
large-output scenario in bare JavaScriptCore against the 250 ms handler budget.
Manually verify detail navigation and dispatch in Alas if an approved plugin
installation and suitable session are available. Report unavailable manual or
SSH checks as unverified, with an explicit checklist, rather than claiming them
complete.

Update the plugin README and bump its manifest minor version to 0.12.0. The
catalog is generated by release automation and is not manually advanced. Work
stays in the current linked workspace branch; publishing a PR follows the user's
approval of the completed change. No host API change is planned.
