# Test & Benchmark Explorer

Browse local test and benchmark artifacts in Alas, compare two retained results,
and keep their source evidence after the checkout changes. A compact summary also
appears on completed run reports. Choose **Test & Benchmark Explorer** in the
report's menu to open that run's evidence.

Requires **Alas plugin API 16** and **Python 3.9+ on the execution host**. API 16
needs the companion Alas change that exports exact run identity before scripts
execute. An older Alas refuses this plugin. SSH imports run through the remote
Alas helper on that host; neither artifacts nor Xcode are taken from this Mac.

## Install and configure

Build using the repository's normal workflow:

```sh
npm ci
plugins/test-benchmark-explorer/build.sh
```

Open the tab's **Configure** area. Save a project configuration, choose its owning
worktree and click **Install/update wrapper**. This writes the helper and profile
configuration under `.alas/test-benchmark-explorer/` in that worktree. Repeat for
each worktree, and update it after changing profiles or upgrading the plugin.
The plugin does not rewrite your run scripts. It needs no network access.

The complete Python helper is embedded in the trusted `plugin.js`. Installation
extracts that exact helper; a release needs only `plugin.json`, `plugin.js` and
`ui.js`, as the existing release workflow distributes. There is no unshipped
executable or runtime package download. Python and the runner/importer tools are
project prerequisites.

Each profile maps an exact Alas script key to artifact paths relative to a **fresh
output directory for that invocation**:

```json
{
  "profiles": [{
    "id": "swift-tests",
    "script": "repo:tests.sh",
    "target": "macOS-arm64",
    "toolchain": "Xcode 27.0",
    "configuration": "Debug",
    "artifacts": [{"path": "Tests.xcresult", "format": "xcresult"}]
  }]
}
```

The wrapper exports `ALAS_RESULTS_DIR` to the child command. Expand it **inside
that child**, after the wrapper has created the directory. For example, put this
at the end of `.alas/scripts/tests.sh`:

```sh
exec python3 "$ALAS_WORKTREE_ROOT/.alas/test-benchmark-explorer/capture.py" \
  capture --profile swift-tests -- /bin/sh -c '
    exec xcodebuild -project Alas.xcodeproj -scheme Alas -destination platform=macOS \
      -skipPackagePluginValidation -skipMacroValidation \
      -resultBundlePath "$ALAS_RESULTS_DIR/Tests.xcresult" test
  '
```

The wrapped command keeps the run script's working directory. Artifacts stay
inside its owning worktree. Absolute paths, parent traversal, `.git`, symlink
components and special files are refused. Reports from unrelated shared output
paths cannot inherit this invocation's provenance.

For existing artifacts, enter a worktree-relative path and format under **Import
an existing artifact**. Select **Report directory** for multiple XML/JSON files.
These imports have unknown source provenance and no Alas run association. Their
displayed time is the import time, not a claim about when the original runner ran.
Xcode's original timestamps remain in its evidence summary. Reimporting the same
artifact identity updates the retained entry.

## JUnit and Kotlin/JVM

Use `"format": "junit"`. A report directory expands matching `.xml` files
deterministically. For example:

```json
{"profiles":[{"id":"jvm-tests","script":"repo:jvm-tests.sh","target":"JVM-21","toolchain":"JDK 21 / Gradle 8.14","configuration":"test","artifacts":[{"path":"junit","format":"junit","directory":true}]}]}
```

Configure Gradle's report location in `build.gradle.kts`:

```kotlin
tasks.withType<Test>().configureEach {
    providers.environmentVariable("ALAS_RESULTS_DIR").orNull?.let { output ->
        reports.junitXml.outputLocation.set(file("$output/junit/$name"))
    }
}
```

The corresponding Alas script ends with:

```sh
exec python3 "$ALAS_WORKTREE_ROOT/.alas/test-benchmark-explorer/capture.py" \
  capture --profile jvm-tests -- ./gradlew test
```

The importer supports `testsuite` and `testsuites`, nested suites, failures,
errors, skips, full parameterized names and supplied file/line fields. Counts
come from leaf testcases, not aggregate attributes. A configured path is read
once. Distinct report paths retain separate evidence and repeated testcase
identities become separate attempts. JUnit document order does not establish
retry order, so an unordered later pass does not erase a failure. DTDs and entity
declarations are rejected, and external entities are never resolved.

## Xcode support

Verified against **Xcode 27.0 build 27A266a**, **xcresulttool 25115**, output schema
**0.4.0**, on macOS. The importer uses supported `get test-results summary`,
`tests` and `test-details` queries with an explicit schema version. Other tool
schemas are unsupported until verified. An SSH host must have its own Xcode and
`xcrun`; missing tools produce an import error.

Real JSON fixtures retain XCTest failures/skips/repetitions and parameterized
Swift Testing arguments. Destination/configuration dimensions and repetition
identities are preserved. Human-formatted duration strings are not parsed;
missing numeric duration and missing location remain unknown. The importer works
on a bounded regular-file snapshot of the bundle, and never feeds artifact
symlinks to xcresulttool.

## Benchmark JSON v1

Swift, Rust and other runners can emit the same small format directly. See
[`examples/benchmarks.json`](examples/benchmarks.json) and the runnable
[`examples/benchmark-adapter.py`](examples/benchmark-adapter.py). The latter
demonstrates writing measured samples to `ALAS_RESULTS_DIR/benchmarks.json`.
Use a capture artifact with `"format": "benchmark"`.

```json
{
  "format": "alas-benchmarks",
  "version": 1,
  "measurements": [{
    "id": "sort",
    "parameters": {"size": 1000},
    "metric": "wall-time",
    "value": 1.2,
    "unit": "ms",
    "direction": "lower",
    "statistic": "median",
    "samples": [1.1, 1.2, 1.3]
  }]
}
```

`id`, `metric`, `value`, `unit` and `direction` are required. Parameters default
to an empty object. Values and samples must be finite; direction is `lower` or
`higher`. Statistic, samples and summary metadata are optional and stay unknown
when missing. Duplicate measurement identities in one file are refused; combine
samples explicitly or distinguish parameters/statistics. Arbitrary console output
is outside v1. Existing JSON can supply a top-level `conditions` object with
`host`, `toolchain`, `configuration` and `target`; those are artifact-declared
conditions, not newly verified source provenance.

Choose a baseline in the selected run, then enable **Compare**. Matching requires
the same ID, canonical parameters, metric, unit, direction and statistic, plus
compatible known host/toolchain/configuration/target conditions. Differences and
unknown conditions remain visible beside raw values. A zero baseline has no
finite percentage. Numeric overflow has no finite delta. Samples do not establish
statistical significance. A profile can add `"thresholds": {"sort": 5}` to mark
direction-aware percentage regressions without replacing measurements.

Test comparison preserves parameterized identities and attempts. It shows added,
removed, newly failing and recovered tests, plus known duration changes. Absence
from an incomplete import is unknown, not an asserted removal. Cross-worktree
comparisons transfer bounded normalized chunks between their owning hosts; raw
artifact paths are never read on another host.

## Source provenance

The API 16 launcher supplies exact run/project/worktree/script IDs before the
wrapper starts. Completed captures are published once under that run ID, with
isolated artifact directories. The plugin does not infer identity from the newest
file, timestamps or console markers. A late callback retains its original owner.

Source fingerprints include HEAD, index entries and tracked/nonignored untracked
file content and modes. Binary content and symlink text are included. An edit to
an already-dirty file changes the fingerprint. The plugin's generated directory
and nontracked gitignored outputs are excluded. Submodules and nested project
roots currently produce explicit unknown provenance rather than a partial clean
claim. Runner inputs outside the captured worktree are not verified.

Two endpoint hashes are insufficient for edits that are reverted during a run.
The wrapper observes source/git metadata changes across the enclosing interval
with FSEvents on local APFS/macOS, or inotify on local ext-family/XFS/Linux.
It brackets both source scans and the child command with observation barriers.
**Changed during run** includes changes during those immediately adjacent scans;
it does not claim an exact mutation timestamp from a delayed callback. Dropped
events, registration/drain failures, unverified/network filesystems, submodule
states and unavailable hosts produce **unknown**, never current.

**Current** requires matching boundary fingerprints, uninterrupted observation
without relevant mutation, and a fresh matching checkout fingerprint. **Stale**
means trustworthy captured source differs from the current checkout. Verification
shows its time, resets after restart and refreshes on opening, explicit refresh,
git-change hints and once a minute while visible. Dirty-count events alone never
establish freshness. This evidence trusts the user's installed helper/run script;
it is not an attestation against a malicious script fabricating reports.

Command outcome, parsed tests, importer completeness and source freshness are
separate. Exit zero with zero tests displays **no tests**. Stops, unknown outcomes,
missing tools, malformed/unreadable/partial reports and deleted evidence remain
visible. **Investigation brief** produces selectable text with evidence references
and provenance; use the normal copy shortcut. Full normalized evidence is paged
separately when previews are truncated.

## Limits and retention

- Project plugin storage is capped at 512 KiB and 40 summaries, including current
  selection and baseline. Normalized details stay on their execution host.
- Normalized details retain at most 30 captures, 30 days and 128 MiB per worktree.
  Current selection/baseline can pin two captures against age/count preference,
  but cannot bypass the byte cap. Pruned/missing detail keeps an explicit summary.
- Original artifacts, including capture output directories, are never deleted by
  normalized-detail retention. Their disk use follows your project's artifact
  cleanup policy and is not included in the 128 MiB normalized-detail budget.
- Each normalized capture is limited to 16 MiB and 100,000 rows. XML/JSON inputs
  are at most 16 MiB each, xcresult snapshots 128 MiB and 2,000 regular files.
  At most 100 xcresult detail queries run per bundle. Oversized inputs are
  incomplete/error states.
- Detail pages contain at most 100 rows and 64 KiB; full evidence is chunked.
  Benchmark rows accept at most 10,000 explicit samples. Profile configuration is
  limited to 16 profiles, 16 artifact declarations each, and 16 KiB.
- Helper requests are serialized. Host timeout/truncated output is rejected, and
  unavailable hosts/worktrees preserve retained provenance instead of substituting
  unrelated local files.

## Development checks

```sh
npm run typecheck
npm test
npm run build
scripts/jsc-run plugins/test-benchmark-explorer/dist/plugin.js
```

Native macOS capture tests need FSEvents access. A command sandbox that refuses
FSEvents startup must be distinguished from a native observer failure. The
helper is generated from the small files in `helper/`; tests execute the same
concatenated program that is embedded in `plugin.js` and installed as `capture.py`.
