# Stack support in PR Inbox and MR Inbox

Status: approved by the user with `lgtm` on 2026-11-07.

## Intent

Make stacked PRs and MRs identifiable in both inboxes, show their dependency order,
and offer actions for the complete stack alongside each request's existing actions.
Use gg's own workflows for gg stacks.

The user's request establishes those goals. The concrete interaction, supported
stack sources, and action scopes below are recommendations for approval.
Land stack covers the whole stack even when invoked from a middle member,
with a separate Land through this action for a prefix.

## Current code and constraints

- Both plugins live in `alas-plugins/plugins/nacho-{pr,mr}-inbox`. Their models,
  controllers, protocols, and pages are separate TypeScript implementations.
- PR Inbox lists 50 open requests, groups by status, and merges individually
  with `gh pr merge --squash --delete-branch`. Merge all uses update order.
- MR Inbox lists 50 open requests and merge trains. Its writes add to a train,
  or request auto-merge when trains are disabled. Add all uses update order.
- PR data already fetches base branch and head repository for CI Doctor.
  MR data already includes source/target branches, but needs source/target
  project identity to distinguish forks.
- Alas already has gg inventory, mutation coordination, worktree resolution,
  native confirmation, and a landing tab with progress and cancellation.
  The plugin API has no stack endpoint. Do not duplicate this machinery in
  each plugin or put gg mutations through a generic short-lived process call.
- The workspace contains both repositories on `nacho/stack-diffs`. Both were
  clean at inspection. Changes need coordinated host and plugin compatibility.

## Display and navigation

Keep the current status groups and per-request controls. Add a compact clickable
badge to stacked rows, such as `Stack 2/4`, with a gg mark/name when known.
The badge opens an inline stack inspector in the same tab or sidebar.

The inspector shows the full ordered chain, base branch, each request's title,
status, author, and existing actions. A vertical connector makes the root-to-tip
order visible. Highlight the member from which it was opened. The header contains
stack-wide actions and a summary such as `2 ready · 1 waiting · 1 failing`.
Collapsed rows remain compact; the sidebar uses the same information vertically.

Build dependencies before applying Mine or status filters. The normal list still
honors its filters, but an inspector shows dependencies hidden by them, with
`outside this filter` on those members. Counts and badges remain counts of
requests, without double counting an inspector's repeated rows.

Confirmed linear chains get positions. General dependency graphs get explicit
Depends on links and blockers, without an invented total order. Missing,
inaccessible, ambiguous, stale, or partially fetched members have visible states.
A failed metadata read must not turn a formerly known stack into a standalone PR.

## Detecting membership

Use a small shared, UI-free TypeScript module for normalized review identities,
dependency graphs, chain validation, and action scopes. Provider parsing and
existing UI implementations remain in their plugins.

Identity includes provider host, target repository/project, and PR number/MR iid.
Branch links also include source repository/project. A matching branch name alone
must never link two requests from different forks or projects.

Sources, in descending authority:

1. gg's validated stack inventory, with entry identity, order, mapped request
   identity, stack/worktree identity, and completeness/freshness.
2. Explicit GitLab blocking relationships, fetched separately so unsupported or
   unavailable dependency APIs do not break the existing MR list.
3. Exact branch dependencies: a child's target branch in its target repository
   is the parent's source branch in that same repository.

Do not infer dependencies from titles, branch prefixes, arbitrary description
links, commit subjects, or merely sharing a target branch. Do not merge conflicting
sources silently. Show the discrepancy and disable ambiguous stack mutations.
Other stack tools can use the branch relationships for display, but gg commands
are only offered for a positively identified gg stack.

Fetch open-list pages through completion before asserting a complete chain.
Use page sizes of 50 and a ceiling of 500 open requests. At that ceiling, on
truncation, or on a failed page, mark membership incomplete and disable stack
mutations. Keep loaded requests usable individually. Resolve referenced blockers
outside the open list on demand. Cross-project blockers are linked read-only;
they cannot be included in a current-project bulk write.

## Actions and their scope

Every complete stack offers Refresh stack and Copy stack links. A mapped local
gg stack also offers Open stack, Sync stack, Rebase stack, Land stack, and Land
through this. Open stack uses its existing worktree; if none exists, present the
existing native follow/checkout workflow. Never switch an unrelated checkout
implicitly. Restack, reorder, split, and destructive cleanup remain in native gg UI.

Land stack always means every remaining member of the identified chain,
bottom-up, including descendants of the selected member. Land through this
means remaining ancestors plus that member. Both show the exact numbered scope
before execution, including members authored by other people or outside filters.
Already merged members remain context and are excluded from writes.

For gg, route to native stack workflows. Pin the final entry identity from the
refreshed scope. The existing streaming landing command uses
`gg land --until <target> --wait --jsonl --no-clean` with a fresh client operation
ID. Keep the native coordinator's preflight, locking, and confirmation checks.
Wait for CI/reviews in the native landing tab; report queued train/auto-merge
states as queued until the provider confirms merging. Do not infer completion
from a zero exit code or an unrecognized event. No automatic admin bypass,
forced rewrite, branch deletion, or worktree cleanup is part of Land stack.

For a complete chain without a supported tool, offer the provider's stack action:

- GitHub: Merge stack, using the repository's existing squash policy, one
  request at a time. Require all remaining members to meet the inbox's current
  Ready rule at the start. Refresh before every write, pin the expected head
  SHA with the provider's compare-and-merge guard, and wait for confirmed merge
  before advancing. Never skip a blocked ancestor to merge a descendant.
- GitLab: Queue stack, preserving train or auto-merge behavior. Begin only when
  the next member is eligible under current GitLab rules. Queue the next member
  only after its predecessor is confirmed merged and its dependencies have
  cleared. Show queued, waiting, and merged separately.

For branch-based chains, a descendant must target the stack's final base before
it is submitted for merge/train. After the predecessor is confirmed merged,
refresh the descendant. If the provider has not retargeted it, explicitly retarget
from the expected predecessor branch to the fixed final base, then refresh and
re-evaluate readiness. This retargeting is included in the displayed action scope.
Do not delete intermediate branches during the run. If retargeting changes the
head, reveals conflicts, requires restacking, or cannot be verified, stop and
show the precise blocker. No automatic history rewriting for generic stacks.
Use existing per-item actions for standalone requests.

Cycles, branching graphs without a unique selected chain, cross-project members, unreadable
blockers, or incomplete identity disable whole-stack mutation with an explanation.
Navigation, links, and the underlying individual controls remain available.

## Execution and existing bulk actions

Freeze membership, order, identities, head SHAs, and final base at confirmation.
Refresh before the first write and between writes. A new member, changed head,
changed dependency, or changed base stops execution and requires a new scope.
Expected provider retargeting and confirmed merges are the only accepted scope
transitions. Do not add newly discovered members to a running operation.

Keep one mutation in flight per project, including individual, old bulk, native
gg, and stack actions. Generic stack operations expose Stop: it prevents new
writes, lets an in-flight request settle, then refreshes actual provider state.
gg uses its existing native cancellation and reconciliation path.

Persist confirmed scopes and completed members in project storage for generic
operations. After restart, reconcile provider state and show Interrupted with
explicit Continue; never replay a write automatically or claim rollback of merges.
Show partial completion and preserve the first failure. Recheck readiness on
Continue. Native gg retains ownership of its own operation lifecycle.

Existing Merge all/Add all must exclude confirmed and unresolved stack members
from independent bulk writes, with a note that stacks have their own action.
They continue to handle standalone requests. Preserve existing individual actions
on stack members and display their dependency context. An individual merge must
affect only that request: if an unmerged ancestor makes that unsafe, disable the
merge with its dependency reason and offer the separately named Land through this
action. For a gg member whose predecessors are already merged, native landing
through that member affects only that remaining request. Never silently turn an
individual merge into a multi-request prefix operation.

## Host and SDK integration

Add a narrowly scoped plugin API revision, next after the currently supported
API 17, and matching TypeScript helpers. The required contracts are:

- A project-scoped stack inventory read under `workspace.read`. Return opaque
  stack/worktree identities, provider identity, ordered entries, completeness,
  freshness, and supported actions. Refresh remote data before mutation decisions.
- An open-action request that validates those identities and presents the
  existing native stack view or action confirmation. Plugins cannot execute
  arbitrary commands through this endpoint. Opening a confirmation is not
  confirmation, and a plugin message cannot approve it.
- Native state changes cause inventory invalidation so the inbox refreshes.
  A native-operation reservation and generic-operation reservation must share
  the project mutation lock, released on cancellation, plugin loss, or completion.

Keep UI types out of AlasCore and inject app presentation using PluginHostActions.
Reuse the existing gg coordinator; extract the smallest callable action entry
point if needed. Do not bind mutations to whichever worktree happens to be selected.
Resolve the owning SSH host for remote projects; unsupported native gg contexts
show their limitation rather than executing locally.

New plugins declare the new minimum API. Existing plugin versions remain usable
on upgraded hosts. The API docs and SDK must describe validation, unavailable
actions, stale identity, and operation ownership. Exact endpoint/type names,
visual spacing, cache details, and internal factoring are builder decisions.

## Acceptance and validation

- Both inboxes identify the same branch-chain examples, gg mappings, and
  GitLab explicit dependencies with correct host/project/fork identity.
- The inspector preserves order, status, individual actions, hidden dependency
  context, and incomplete states in both full tab and narrow sidebar.
- A middle-member Land stack targets the full stack; Land through this targets
  only its prefix. The shown and executed scopes must match.
- gg actions open the correct worktree's native workflow, pass through native
  confirmation and mutation coordination, and surface live completion/failure.
- Generic writes proceed in dependency order, pin heads, verify retargeting,
  respect GitLab train behavior, and stop on stale scope or a blocked ancestor.
- Old bulk actions cannot accidentally land stack members out of order.
- Pure logic tests pin cycles, branching graphs, forks, filtered/missing members,
  conflicting metadata, partial pagination, and merged versus closed blockers.
  Controller tests pin stale responses, partial execution, cancellation, restart,
  shared mutation ownership, and successful queueing without a completed merge.
- Run plugin typecheck, focused inbox tests, builds, and JavaScriptCore checks.
  For changed native core run affected AlasCore tests first; for app integration
  run focused plugin/gg suites. Inspect the tab and sidebar visually. Documentation
  alone needs no builds or tests.

## References

- Local implementation: `GGService`, `GGLandingStore`, `GGMutationCoordinator`,
  `RightPaneState+GGStack`, `PluginHost`, and the two inbox implementations.
- [gg command reference](https://github.com/mrmans0n/git-gud/blob/main/README.md).
  Installed `gg land --help` confirms wait, until, JSONL, and no-clean flags.
- [GitHub merge](https://cli.github.com/manual/gh_pr_merge) and
  [edit](https://cli.github.com/manual/gh_pr_edit) document head guards and
  changing a request's base branch.
- [GitLab dependencies](https://docs.gitlab.com/user/project/merge_requests/dependencies/)
  distinguish closed from merged blockers and allow dependency graphs.
- [GitLab merge requests API](https://docs.gitlab.com/api/merge_requests/)
  documents explicit blocking relationships.
