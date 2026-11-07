# Inbox stack support validation

The approved design is implemented in the Alas and alas-plugins `nacho/stack-diffs` worktrees. Nothing has been published, installed, landed, or merged.

## Result

PR Inbox and MR Inbox show clickable stack badges, dependency links, and a shared full-chain inspector. Native gg actions open Alas's confirmation/progress workflows; generic chains offer full/prefix Merge or Queue with a frozen head/base/member scope. Individual actions keep one-request scope and cannot skip predecessors. Legacy bulk excludes stack members. Mixed authors, merged/closed/unknown context, explicit GitLab blockers, queue states, partial reads, Stop/Continue, and interrupted storage remain distinct.

Project reservations coordinate native gg, provider actions and CI retries. Queued provider writes cancel on Stop, shutdown, or native inventory invalidation; already-started processes keep ownership until settlement. Uncertain remote startup retains its reservation until terminal evidence. A remote outage can therefore leave the project busy until that evidence arrives. Native land preserves unlimited `--wait` streaming and cancellation forwarding with its client operation ID.

Local gg stacks without an owning worktree obtain unordered saved review membership from the repository-local gg configuration. Missing/malformed mapping remains unknown and cannot fall through to generic writes; a valid explicit empty map means unpublished. Native follow uses explicit native confirmation. Remote-only metadata does not invent order, head, base or ownership.

## Automated evidence

- SDK: 17/17; shared graph/controller/operation: 27/27.
- PR Inbox: 116/116; MR Inbox: 127/127.
- Full plugin repository typecheck and all-workspace build: passed.
- Root script tests: 2/2.
- Bare JavaScriptCore production-main workflow replays: both passed without JIT. They exercise queue acceptance, Stop/Continue, verified retargeting and provider-confirmed completion.
- Bare JavaScriptCore 500-request inventory scenarios: both passed within 250 ms CPU per call and host message limits. Observed final maximum reply CPU: PR68 ms, MR151 ms.
- Native initial affected checks: core60 tests/3 suites and actual app322 tests/7 suites passed.
- Final native repair checks: core17 tests/2 suites and direct streaming47 tests/1 suite passed; actual app62 tests/2 suites passed with `TEST SUCCEEDED` (exit0).

Repository-wide `npm test` was attempted. Its unrelated test-benchmark-explorer Python suite failed three FSEvents checks with `Could not start FSEvents stream`; this is not a green full test run. Affected plugin/shared/SDK tests and the root script phase were executed independently and passed. No unrelated plugin source was changed.

## Visual checks

Alas preview rendered the actual built UI and production controller through a local fixture transport at 1100x850 tab and 380x850 sidebar sizes. Inspected mixed-author chains, dependency navigation, exact two-request prefix confirmation with heads/authors/final-base disclosure, queued MR and merge-train coexistence, native actions, and incomplete/native-head mismatch reasons with disabled writes. Copy links returned the visible Copied state. No authenticated provider mutation or interactive native follow/land dialog was run.

## Review repairs

Independent review approved the implementation with no remaining Important or Critical findings. It found and rechecked stale provider-verification timing, Stop/queued-write startup cancellation, native takeover after provider preflight, historical MR final-base discovery, native streaming overload forwarding, and cold local gg membership. Assertion regressions were observed failing before fixes. Historical branch reuse requires corroborating project/branch/full-head identity. Unordered graphs now show explicit dependency links.

API18 payload validation, foreign tokens, stale fingerprints, project scope, old-plugin compatibility and native action presentation are covered by SDK/native tests. Older Alas hosts refuse API18 plugins through the existing manifest compatibility gate. Both plugin manifests require18.

Final functional commits before the display/validation summary: Alas `79bef44b8`, alas-plugins `18765b0`. After review, the queued status summary was clarified and checked with the final built page; it does not change execution policy.

Final logs: `/private/tmp/stack-final-tests.log`, `/private/tmp/stack-final-shared-tests.log`, `/private/tmp/stack-script-tests.log`, `/private/tmp/stack-repository-build.log`, `/private/tmp/pr-stack-jsc-final.log`, `/private/tmp/mr-stack-jsc-final.log`, `/private/tmp/pr-stack-caps-jsc-final.log`, `/private/tmp/mr-stack-caps-jsc-final.log`, `/private/tmp/alas-stack-repair-core-final-green.log`, `/private/tmp/alas-stack-repair-app-green.log`. Earlier initial native and full npm evidence are separately recorded by their scoped test counts above.

## PR review follow-up

Hosted review found an initial native-discovery failure could enable generic writes, and full-chain readiness could disable a valid ready prefix. The controller now starts with unknown native ownership and blocks provider actions until complete discovery or an explicit host `applicable: false` decision. Failed refreshes never reuse an older not-applicable decision, and known native members remain protected. The optional applicability field is type-checked by the SDK and documented by the native API.

Full and selected-prefix readiness are now evaluated separately from their exact frozen scopes. A failing later descendant cannot disable a ready prefix. Assertion-level regressions failed before the repair; SDK18, shared30, PR116, MR127, combined typecheck/build and both bare JavaScriptCore workflow/capacity replays passed after it. Hosted CI and a fresh current-head review remain the merge gates.
