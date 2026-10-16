# Test & Benchmark Explorer

Design for [issue #34](https://github.com/mrmans0n/alas-plugins/issues/34).

## Intent and scope

Make saved test and benchmark artifacts useful inside Alas. A result must retain
the evidence and source state that produced it, even after the checkout changes.
Implement the issue's three importers, browsing, comparisons, investigation
briefs, run-report integration and bounded persistence in a separate
`plugins/test-benchmark-explorer` plugin.

The issue supplies the product requirements. The implementation choices below
are proposed engineering decisions, not additional user requirements. No runner,
scheduler, automatic retry, coverage browser or cloud synchronization is added.

## Contract findings and chosen mechanism

The checked-out SDK supports web tabs, run events, run-report commands and
sections, project storage and on-host processes. These presentation/import pieces
need API 12. Declare `remote: true` so an SSH worktree always uses its own host.
Reliable run association additionally needs the narrow API 16 companion below.

Relevant verified limits:

- Plugin calls have a 250 ms budget, without Node or DOM globals.
- Project storage is limited to 1 MiB. Web messages are also limited to 1 MiB.
- `process/run` accepts 256 KiB stdin, returns up to 512 KiB combined output and
  stops after ten minutes. An instance has two process slots and four deferred
  requests. Appended arguments are limited to 32 strings of 1 KiB each.
- `file/read` accepts UTF-8 files up to 512 KiB; it cannot import an xcresult bundle.
- `runOutput` is only the last 64 KiB. Run events have no artifact or source state.
- `git.changed` only reports dirty/conflict count changes. It cannot establish freshness.
- Run scripts receive worktree/repository root and branch variables, but no run ID.
- Releases contain the manifest, `plugin.js` and optional `ui.js`, with no helper asset.

### Narrow Alas companion, minimum API 16

Extend `RunScriptCommand.runScriptStartupScript` with an explicit execution
identity supplied by both callers: `AlasCoreContext+Runs.swift` for terminal/local
and SSH scripts, and `RunService.swift` for headless scripts. Export
`ALAS_RUN_ID`, `ALAS_RUN_SCRIPT_KEY`, `ALAS_WORKTREE_ID` and `ALAS_PROJECT_ID`, using
the exact IDs that own the run record and its lifecycle events. Keep the existing
worktree/root variables. Quote values with the existing shell-command builder.
The variables are part of the launch command before the user's script executes;
no plugin callback supplies or retroactively guesses them.

Add API 16 support to the host manifest range and SDK manifest type, and document
the execution identity contract in `alas/docs/plugins/api-v16.md`. The new plugin
declares `api: 16`, so older hosts refuse it clearly. Add focused core launch tests
covering terminal/headless/SSH command construction, quoting, concurrent run IDs
and agreement between launch identity and run events. No new runner, snapshot
service, report transport or source-watching service is added to Alas.

Use a Python 3.9+ standard-library helper embedded as text in `plugin.js`. A fixed
declared `python3` process bootstraps it from JSON stdin; requests are validated
operations, never shell text assembled from artifact values. The helper parses,
fingerprints and pages results on the owning execution host. Python is a documented
runtime prerequisite; a missing interpreter produces an actionable import error.

An explicit Install capture wrapper action writes the bundled helper and a
project/worktree installation identity under `.alas/test-benchmark-explorer/` on
the selected worktree's host. The wrapper can then be called by an ordinary Alas
run script. Installation is not performed during activation and does not rewrite
the user's run scripts. The UI gives the exact invocation for each configured profile.

The release therefore ships the helper inside the existing trusted bundle. Build,
installation and release checks must exercise the extracted helper, not a separate
development-only executable. No network download or extra release asset is needed.

## Configuration and capture

Project-scoped configuration maps a run-script key such as `repo:tests.sh` to a
named profile. A profile declares exact worktree-relative artifact files or report
directories, their formats, target, toolchain/configuration labels and optional
benchmark thresholds. Directories are expanded deterministically with explicit
file/count/byte bounds. Reading is limited to configured roots or a manual path
the user explicitly submits. Reject absolute paths, parent traversal, `.git`,
special files and symlink escapes. Refuse symlink components during reads and writes.

Trusted capture profiles use artifact paths relative to a fresh per-capture output
directory. The wrapper exports its absolute path as `ALAS_RESULTS_DIR`, and project
scripts direct their runner/exporter there, for example xcodebuild's
`-resultBundlePath "$ALAS_RESULTS_DIR/Tests.xcresult"`. Configure the relative path
`Tests.xcresult` in that profile. Supply a Gradle report-output configuration example
using the same variable. The directory is newly created before the child starts,
so two captures cannot accidentally read each other's output or reuse yesterday's
report. Only artifacts created in that isolated directory can inherit the wrapper's
source provenance. Configured fixed worktree paths remain available for manual
and legacy import, with unknown artifact source and no automatic run association.
Do not promote a file merely because its mtime or digest changed during a run.

The invocation is conceptually `python3 .alas/test-benchmark-explorer/capture.py
capture --profile swift-tests -- <command> <args...>`.
Use `exec` at the run script's final command. The wrapper creates a random capture
ID, validates its installed project/worktree/root identity, records the actual
host/directory and command argv, starts the source observer described below,
fingerprints source immediately before starting the child, waits for the child
and fingerprints again before importing reports.
The original command status is preserved even when normalization fails.

Each capture gets its own directory and atomic manifest. The wrapper normalizes
artifacts before publishing that manifest. It records capture start/end, command
start/end, command status, report status, source evidence, exclusion policy,
tool versions and artifact digests. An interrupted capture remains incomplete;
it does not publish a successful completion manifest.

When launched by Alas, the wrapper validates the API 16 environment identity
against its installation and configured script, then publishes the manifest under
that exact run ID with a separate random capture ID. Publishing a second capture
for the same run is refused. On `runFinished`, load only that run's manifest in
that worktree and validate every identity field before association. Missing,
conflicting and unfinished manifests remain unassociated with an explicit reason.
Run output is not an association mechanism or artifact transport. Never infer
association from timestamps, newest files or a shared report path. Concurrent
runs use different capture directories. Late callbacks carry immutable
run/worktree/job IDs and cannot update a newer selection. The trust boundary is
the user's script and installed helper, not protection against a malicious script
deliberately fabricating capture evidence.

A stopped run can retain its command outcome without claiming a completed capture.
A completed report command reuses its run ID to recover a missed import.
Standalone manual imports default to unknown source provenance and no Alas run
association. Supplied capture identity is validated through the same mechanism;
arbitrary commit text is never promoted to trusted source capture.

## Source evidence and freshness

The source fingerprint includes repository/common-directory and canonical
worktree identity, HEAD, index state, tracked file paths/modes/content and relevant
nonignored untracked paths/modes/content. An edit to an already-dirty file changes
the fingerprint. Include binary content and symlink text. Hashing must detect
unstable reads and missing files; failed or inconsistent capture yields unknown.
Submodules require recursive evidence or an explicit unknown state, never a clean
claim from the superproject commit alone.

Two endpoint hashes cannot detect an edit that is reverted while the command is
running. Start a native filesystem observer before the first fingerprint and
keep it active through the second fingerprint and an observer drain/barrier.
Use FSEvents through Python ctypes on macOS and inotify on Linux, both available
without an extra package. Watch the source tree and relevant git HEAD/index/ref
paths, including linked-worktree metadata. Do not treat git's read-side cache or
the wrapper's generated output as source changes. Disable optional git locks.

The observation interval deliberately contains both fingerprints and the child's
entire execution. Establish and drain the observer before capturing the first
fingerprint; drain it after the second fingerprint before publishing evidence.
Relevant write/create/delete/rename events in this enclosing interval make the
capture unstable, even if the final content returns to its initial value. The UI
labels this Changed during run and explains that the recorded capture interval
includes source scanning immediately before and after the command. It does not
claim an exact mutation time that FSEvents cannot provide. Do not classify events
from callback arrival time or assume one callback per filesystem operation.

Overflow, dropped/coalesced events that cannot be classified, root changes,
watch-registration races, unsupported filesystems or failure to establish/drain
the observer make capture unknown. Use an explicit synchronization barrier, not a
fixed sleep, to drain notifications. If a tested platform cannot establish that
barrier, it cannot report current. Observer setup must not delay events until
after the child starts. Test failure modes and initially target local APFS on
macOS and local ext4/XFS on Linux; other or network filesystems produce unknown
unless their observation contract is separately validated. SSH uses the same
observer on the execution host;
there is no local fallback. A host without a trustworthy observer can still import
artifacts, but cannot produce a current result.

Exclude the plugin's generated directory and configured generated report roots.
Store and display that exact exclusion policy with each capture. Do not silently
exclude broad source directories; reject the worktree root as a generated root.
Re-evaluation uses the capture's original exclusion policy. A changed policy is
not substituted into old evidence.

Freshness states:

- **Changed during run:** valid boundary fingerprints differ, or the observer
  recorded relevant source mutation during the enclosing capture interval. Neither endpoint verifies
  the completed result, including an edit subsequently reverted during execution.
- **Current:** boundary fingerprints match, the observer establishes no relevant
  mutation during the enclosing capture interval, and a newly computed fingerprint for the same source
  scope and worktree matches them.
- **Stale:** boundaries match but the current fingerprint or HEAD differs.
- **Unknown:** legacy/manual import, missing/unstable boundary evidence, unsupported
  repository state, unavailable host or failed current verification.

Freshness is recomputed on tab opening, explicit refresh, git-change hints and a
bounded timer while visible. Display its verification time. Persisted current
badges are reset to unknown after restart until checked again. Importing generated
results does not itself invalidate source evidence.

## Versioned normalized model and importers

Use model version 1. Separate command outcome, importer completeness, test summary,
benchmark measurements, source provenance and evidence availability. Missing data
is unknown. A successful command with zero tests is labelled No tests, never passing.
An unreadable or partial import cannot make an aggregate result green.

Every imported artifact retains configured path, content/bundle digest, importer
name/version, capture identity and original evidence selectors. Deduplicate repeated
paths by canonical identity before parsing; deduplicate reimports by capture and
artifact digests. Replaced content at the same path is a different artifact.

### Xcode xcresult

Use `xcrun xcresulttool get test-results summary`, `tests` and `test-details` on the
artifact host, with explicit supported schema versions. Record Xcode and tool
versions. This machine has Xcode 27.0 build 27A266a and xcresulttool 25115,
schema 0.4.0. Test the real tool before documenting other versions as supported.

Keep representative JSON fixtures from real results, including failed, skipped,
parameterized and repeated executions. Preserve identifier URLs, destination and
attempt identities, durations, failures and available locations. Do not invent
locations or durations from display names. Bound tool output, per-test detail
queries and bundle traversal. Unknown schemas, missing Xcode and failed queries
are unsupported/error/partial results, not empty passing reports.

### JUnit XML

Parse `testsuite` and `testsuites` roots with Python's standard XML parser after
rejecting DTD/entity declarations. No external entity resolution. Count leaf test
cases rather than parent summary attributes. Preserve suite ancestry, classname,
full parameterized name, document/file origin, duration, status and failure/error
text. Retain location fields only when the report supplies them.

Duplicate configured files are read once. Repeated identities inside or across
distinct reports remain separate attempts with stable evidence IDs. Do not assume
their order represents retries unless the format explicitly supplies attempt order.
For unordered attempts, any failure remains visible in the logical test's status;
an inferred last passing attempt must not erase it.

### Benchmark JSON

Document `alas-benchmarks` version 1. Each measurement contains benchmark ID,
canonical JSON parameters, metric, finite numeric value, unit and direction
`lower` or `higher`. Optional statistic, samples and summary metadata remain explicit.
Record execution conditions: actual host, toolchain, configuration and target.
Ship example Swift/Rust-usable JSON and a small project-script adapter example.
Do not parse arbitrary console output.

## Browsing and comparison

The web tab has a compact run list and selected-run detail. Show worktree, command,
target, execution host, capture time, commit/source state, process outcome and
separate parsed summary. The detail area provides tests and benchmarks, search,
result filters, suite grouping, attempts, failure text, duration and supplied
source locations. Artifact/evidence status remains visible when a path was deleted
or replaced. Imported text is assigned with DOM text APIs, never HTML insertion.

Select a baseline and a current result from history. Test matching uses the full
logical identity, preserving parameters and separating destinations where present.
Compare added, removed, newly failing and recovered identities, then known duration
changes. Attempts remain inspectable. Incomplete evidence makes the affected
comparison unknown; absence from an incomplete report is not a removed test.

Benchmark deltas require matching ID, parameters, metric, unit, direction and
statistic, with compatible known host/toolchain/configuration/target conditions.
Show incompatible or unknown conditions and raw values without computing a delta.
For compatible measurements show baseline, current, absolute delta, percentage
when baseline is nonzero, direction and samples/statistic metadata. Zero baselines
have no finite percentage. Missing samples establish no statistical significance.
Configured regression thresholds annotate the raw values; they do not replace them.

The investigation brief includes selected failures/measurements, source and command
provenance, compared conditions, evidence references and missing-data warnings.
Expose it in a selectable text area usable with the normal copy shortcut; clipboard
APIs are optional because the web view may deny them. Preserve relative file/line
text even if the host has no supported command to open an arbitrary source location.

Add a `run.report.section` native summary and a `run.report` command with `opens`
targeting the explorer. Reports without validated structured results explain why.

## Persistence, limits and recovery

Project storage contains configuration, a run summary index, selected capture and
baseline. Keep its serialized size at most 512 KiB, with at most 40 summary records
and bounded strings. Persist normalized detail on the execution host under each
capture directory. Do not put whole reports or failure logs in plugin storage.

Retain detail for at most 30 days, 30 captures and 128 MiB per worktree, whichever
limit is reached first. The current selection and baseline can pin at most two
captures, but may not bypass the byte cap; retain their summaries and explicit
detail-pruned references if detail must be removed. A single normalized capture is
limited to 16 MiB and 100,000 test/measurement rows. Oversized reports are partial
with a reason. Preserve original artifacts in place; retention never deletes them.

Detail requests use at most 100 rows and 64 KiB encoded JSON per page. Split long
evidence text into bounded chunks. Filtering, comparison and brief preparation run
in the helper, with cancellation/generation tokens and one queued helper job at a
time so overlapping imports do not exceed host limits. Surface process timeout,
truncation and malformed helper replies distinctly.

Restart loads the bounded index and selection first, then validates evidence on
its recorded host. Web-page recreation sends `ready` and receives the same durable
state. Missing worktrees, removed captures and disconnected SSH hosts retain honest
summary records with unavailable detail. Storage failures remain visible and do
not claim that a baseline or result was saved.

## Verification and remaining decisions

Required automated coverage follows the issue: real importer fixtures, retry and
parameterized identity, zero/partial/error outcomes, compatible/incompatible
benchmarks, zero baselines, real-git clean/dirty/staged/untracked/commit changes,
changing and reverting source during the command, observer gaps/overflow,
immutable concurrent association, late
callbacks, reimport deduplication, restart, retention, path isolation and XML safety.

Run repository typecheck, tests and build; execute the bundled plugin in bare
JavaScriptCore. Exercise extracted packaged helper installation and on-host request
bounds. Manually demonstrate a real xcresult, JUnit import, benchmark comparison,
stale source and web-tab recreation in Alas. Record manual gates that cannot be
performed in the available session rather than claiming them verified.

The builder may choose file/function decomposition, exact table layout, default
thresholds being disabled and pagination internals. The helper, source-observer
mechanism, API 16 companion and retention limits require design review before
implementation.
