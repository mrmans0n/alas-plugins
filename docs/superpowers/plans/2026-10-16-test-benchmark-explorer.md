# Test & Benchmark Explorer implementation plan

> For agentic workers: Use superpowers:executing-plans to implement this plan task by task.

**Goal:** Implement issue #34 as approved in the design, including the narrow Alas companion.

**Architecture:** API 16 supplies exact execution identity to the capture wrapper. A Python standard-library helper, embedded in the plugin bundle and installed explicitly into the owning worktree, captures source evidence, normalizes artifacts and serves bounded queries. The TypeScript plugin owns lifecycle, durable selection and native report sections; its sandboxed web page presents results.

**Tech stack:** Swift, TypeScript, Python 3.9+, JavaScriptCore, WebKit, xcresulttool.

**Spec:** `docs/superpowers/specs/2026-10-16-test-benchmark-explorer-design.md`, approved in conversation.

## Global constraints

- Minimum API 16. Exact project/worktree/script/run binding before user code, including SSH and headless launches.
- Helper ships inside plugin.js. No development-only helper or download dependency.
- Unknown provenance, incomplete imports and zero tests never become passing tests.
- Source content includes staged, unstaged and nonignored untracked content; observer gaps fail closed.
- Read configured paths on their owning host; refuse path traversal and symlink escapes.
- Project storage at most 512 KiB, 40 summaries; detail retention 30 days/30 captures/128 MiB per worktree.
- Normalized capture at most 16 MiB/100,000 rows. Detail messages at most 100 rows/64 KiB.
- Preserve raw benchmark values; compatible known conditions are required for deltas.

## Review focus

- An old artifact or replayed capture cannot acquire a newer run's identity.
- Reverted edits, observer overflow and source/index changes cannot produce current evidence.
- A changed worktree/selection while a helper request is pending cannot receive another request's results.
- Retention and missing artifacts preserve summaries and honest unavailable detail.
- Malformed/oversized XML or helper output cannot become green or exceed host message budgets.

## Task 1: Exact launch identity

**Files:** Alas `RunScriptCommand.swift`, `RunService.swift`, `AlasCoreContext+Runs.swift`, `PluginManifest.swift`, existing run/manifest test suites and API docs; SDK manifest type/tests.

**Interfaces:** Add optional `RunScriptExecutionIdentity` to startup-command construction, containing run/project/worktree IDs. Script key comes from `RunScript.key`. Export four API 16 environment fields. Both real launch callers supply it.

- [x] Extend existing launch tests to execute commands and assert exact identity, quoting and separate runs; run to observe failure.
- [x] Implement identity, thread it through both callers, add API 16 host/SDK support and documentation.
- [x] Run focused AlasCore launch/lifecycle and manifest tests, then commit companion and SDK changes.

## Task 2: Normalization and comparisons

**Files:** Plugin `helper/common.py`, `helper/importers.py`, `helper/query.py`, `tests/test_helper.py`, real fixtures and examples, helper embedding script, package and manifest.

**Interfaces:** Normalized model v1 has `tests`, `benchmarks`, `artifacts`, `issues`, `complete`, plus provenance. `import_artifacts(root, specs)` returns normalized evidence. `compare_results(base, current)` returns test changes and benchmark compatibility/deltas. `query_result` and `brief` return bounded data.

- [x] Write importer/comparison tests for JUnit hierarchy, duplicates, attempts, XML entities, missing durations, benchmark compatibility and zero baseline; observe missing implementation failures.
- [x] Generate a real small Xcode test result, preserve sanitized tool JSON fixtures and implement explicit schema 0.4.0 import including details and repeated runs.
- [x] Implement validation, evidence references, bounded import, comparisons and brief generation; run Python fixture tests.
- [x] Add package/build embedding so shipped helper matches tested source; commit the independently testable importer/model deliverable.

## Task 3: Capture, source observer and durable detail

**Files:** Plugin `helper/source.py`, `helper/observer.py`, `helper/store.py`, `helper/capture.py`, `helper/bridge.py`, helper integration tests.

**Interfaces:** `fingerprint(root)` returns known source digest/identity or unknown reason. Native observers enclose both fingerprints and child execution. `capture(profile, argv)` creates isolated ALAS_RESULTS_DIR and publishes one exact-run manifest atomically. Bridge operations install/capture import/list/detail/compare/brief/freshness/prune use validated immutable identities.

- [x] Write real-git tests for already-dirty edits, staging, untracked content, HEAD switches and generated exclusions; observe failure.
- [x] Write capture tests for concurrent IDs, replay rejection, changed-and-reverted source, observer gaps, missing tools/reports, stopped commands and manual unknown import; observe failure.
- [x] Implement content evidence, macOS FSEvents/Linux inotify observers with barriers and fail-closed unsupported filesystems, atomic capture/publication, safe paths and bounded retention.
- [x] Verify installed extracted helper, pagination/text limits, deleted/replaced artifacts and retention with preserved summaries; commit.

## Task 4: Plugin lifecycle and persistence

**Files:** Plugin `src/main.ts`, `src/model.ts`, `src/protocol.ts` and their tests, `plugin.json`, SDK API16 manifest tests.

**Interfaces:** One queued helper operation at a time. Immutable job/run/worktree IDs in callbacks. Project storage owns config/index/current/baseline; page messages are validated requests and bounded replies. Report commands and sections use exact run IDs.

- [x] Add fake-host tests for exact run association, concurrent/late callbacks, restart, ready handshake, persistence failures and malformed/truncated replies; observe failure.
- [x] Implement explicit wrapper installation, project/profile configuration, imports, bounded summary persistence, current/baseline selection and helper queue.
- [x] Implement report section/command, automatic finished-run import, visibility/refresh freshness and unavailable-host states.
- [x] Run focused Node lifecycle tests and bare-JSC scenario; commit.

## Task 5: Explorer UI and documented setup

**Files:** Plugin `page/main.ts`, `page/styles.ts`, README, benchmark schema/examples, build.sh, root README and package lock.

**Interfaces:** Page renders only DOM text, sends protocol requests and restores state from ready. Tests/measurements are paginated; selected evidence and investigation brief are inspectable/copyable.

- [x] Implement compact run list, provenance/command/import states, test search/filter/grouping and attempt/failure/source details.
- [x] Implement two-run selection, test/benchmark comparisons, raw values/conditions, investigation brief and configuration/import/install controls.
- [x] Document exact runner wrappers and Gradle output configuration, Python/tool versions, benchmark v1, limits/retention and API16 dependency.
- [x] Build and visually inspect the real page with representative data, including empty/error/partial/missing evidence; commit.

## Task 6: Integration and final review

**Files:** Relevant tests/scenarios and documentation evidence only, plus review fixes where needed.

- [ ] Run repository typecheck, tests, build, every JSC activation and affected AlasCore suites.
- [ ] Demonstrate actual Xcode/JUnit imports, benchmark comparison, stale-source transition and page recreation in Alas when access permits. Record any unavailable manual gate explicitly.
- [ ] Request one fresh whole-branch review against issue/design, make one bounded fix pass with regression checks, and report exact results and companion dependency.
- [ ] Offer the PRs for review. Creation/publication waits for user agreement as required by the workspace instructions.
