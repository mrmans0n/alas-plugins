# Inbox stack support implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Identify stacked PRs/MRs in both inboxes and offer scoped native gg or dependency-ordered provider actions.

**Architecture:** A shared TypeScript graph and operation controller supplies both plugins. Plugin API 18 exposes project-scoped gg inventory and native action presentation, plus a project mutation reservation shared with native gg. Provider adapters own pagination, identity, readiness, compare-and-merge, and retargeting.

**Tech stack:** Swift/SwiftUI, Swift Testing, TypeScript, Node test runner, JavaScriptCore, existing gh/glab and gg integration.

**Spec:** `docs/superpowers/specs/2026-11-07-inbox-stack-diffs-design.md`, approved with `lgtm`.

## Global constraints

- Keep per-request actions and existing status groups. Do not silently merge ancestors through an individual action.
- Land stack includes the entire chain. Land through this includes the selected prefix.
- Identity includes host, repository/project, request number, and source repository for branch matching.
- Page size 50, ceiling 500 open requests. Unknown, partial, stale, and inaccessible are explicit states.
- Never skip a blocked ancestor. Freeze and revalidate membership, order, head SHAs, and final base.
- Native gg owns gg mutations and confirmation. No automatic history rewriting, cleanup, or bypass.
- One project mutation reservation includes native gg, individual, legacy bulk, and generic stack actions.
- Generic queued states are not merged states. Interrupted operations require explicit Continue.
- Changes stay in the existing linked worktrees. No publication or merge is authorized.

## Review focus

- Forks with identical source branch names must not become the same dependency.
- A refresh that fails halfway through pagination must not enable bulk writes from partial data.
- Provider queue acceptance followed by a successful process exit must not advance to a descendant.
- Stack mutation ownership must survive asynchronous replies and release after plugin shutdown.
- A rewritten head or newly inserted ancestor must stop a previously confirmed operation.

## File structure and contracts

In `alas`, add `PluginStacks.swift` in AlasACP for Codable wire types, API handlers in `PluginHost`, and `AppState+PluginStacks.swift` for inventory/presentation. Add a small `GGProjectMutationGate` in AlasIntegrations and inject it into native coordinators. Extend current plugin and gg test suites.

In `alas-plugins`, add `sdk/alas/src/stacks.ts` exported as `@alas/plugin/stacks`; shared pure graph/model in `shared/inbox-stacks.ts`, operation state machine in `shared/stack-operation.ts`, shared runtime controller in `shared/inbox-stack-controller.ts`, and shared page rendering in `shared/stack-page.ts`. Add precise tests beside shared modules and include their tests/typechecks in root scripts. Existing plugin adapters and pages consume these pieces.

Wire contract, JSON camelCase:

- `ReviewIdentity = { host: string; repo: string; number: number }`.
- `NativeStackEntry = { id: string; sha: string; position: number; number?: number; title: string; state?: string }`.
- `NativeStack = { id: string; name: string; base: string; host: string; repo: string; worktree?: string; fingerprint: string; complete: boolean; entries: NativeStackEntry[]; actions: NativeStackAction[]; unavailableActions?: Partial<Record<NativeStackAction, string>> }`.
- `NativeStackAction = "open" | "sync" | "rebase" | "land" | "landThrough"`.
- `StackInventory = { complete: boolean; busy: boolean; stacks: NativeStack[]; fetchedAt?: number; error?: string }`.
- `stacks/list { refresh: boolean } -> { inventory: StackInventory }`, `workspace.read`, API 18.
- `stacks/open { stack: string; fingerprint: string; action: NativeStackAction; entry?: string } -> { opened: true }`, `workspace.read`, API 18. Only opens UI, never accepts confirmation.
- `stacks/acquire {} -> { token: string }`, `process.exec`, API 18; `stacks/release { token: string } -> { released: true }`. Tokens are opaque and scoped to the plugin instance/project. Shutdown releases ownership after any active process settles.
- `stacks/changed` invalidates inventory. SDK Event is `stacksChanged`.

Shared normalized review:

`StackReview = { identity: ReviewIdentity; sourceRepo?: string; branch: string; base: string; sha?: string; title: string; url: string; author: string; state: "open" | "merged" | "closed" | "unknown"; ready: boolean; queued?: boolean; blockers?: ReviewIdentity[]; blockersComplete?: boolean }`.

`buildStacks(reviews, { complete, native, error? }) -> StackGraph` returns validated components and member lookup. Each component supplies an ordered chain when linear, issues, native mapping, fixed final base, fingerprint, and individual mutation blockers. `stackScope(component, selectedIdentity?, through?)` returns a frozen complete chain/prefix or a reason it cannot mutate.

The shared controller exposes view state, selected member, open/close/refresh/native actions, prepare/confirm/run/stop/continue, and provider adapter callbacks. Exact callback type names remain local to these files, but provider operations must pass expected identity/head/base and return a typed merged/queued/open outcome. Store normalized frozen operation state under `inbox-stack-operation-v1`.

### Task 1: Native stack bridge and mutation ownership

**Files:** `alas/Packages/AlasCore/Sources/AlasACP/Plugins/PluginStacks.swift`, existing PluginManifest/PluginHost, `AlasIntegrations/Integrations/GG/GGProjectMutationGate.swift`, existing GGMutationCoordinator and RightPaneState coordinator setup, `Alas/Sources/Plugins/AppState+PluginStacks.swift`, `AppState+Plugins.swift`, plugin API docs, existing tests.

**Produces:** API 18 wire contract above, native inventory/presentation, shared project reservation.

- [ ] Add tests for request validation, cross-project/foreign token rejection, stale fingerprint, open without mutation, and automatic owner cleanup. Add a gate test that a native action and a plugin reservation cannot overlap across worktrees of one project.
- [ ] Run the focused tests and capture failure before implementation.
- [ ] Implement Codable payloads, bounded API validation, API 18 gate, and SDK-independent host closures. Resolve inventory from refreshed gg and configured project identity, including partial/unavailable cases. Never execute local gg for SSH projects.
- [ ] Present the correct worktree's native action UI. Land resolves the frozen last member, landThrough resolves the selected entry, and both use existing confirmation/progress logic. Validate fingerprint after refresh before presenting. Unsupported actions carry a reason.
- [ ] Integrate the gate into native coordinator reserve/release and plugin instance lifecycle. Invalidate inventory on native operation/worktree changes.
- [ ] Run affected AlasCore tests first, then focused app PluginHost/Manifest and gg tests with isolated DerivedData. Record actual test counts and infrastructure blockers.

### Task 2: SDK, graph, operation engine, and shared controls

**Files:** SDK stacks module/exports/tests, `shared/inbox-stacks.ts`, `shared/stack-operation.ts`, `shared/inbox-stack-controller.ts`, `shared/stack-page.ts`, their tests, root scripts/tsconfig.

**Consumes:** API 18 wire contract. **Produces:** normalized graph, operation/runtime controller, shared inspector renderer for both plugin adapters.

- [ ] Write graph tests covering root-to-tip ordering, middle-member full versus prefix scope, fork branch collisions, cycles/branching, conflicting gg metadata, merged versus closed dependencies, hidden members, and incomplete pagination.
- [ ] Run `node --test shared/*.test.ts`, confirm missing implementation fails, then implement graph construction with no Node/DOM globals.
- [ ] Write state machine tests for refreshed scope changes, queued-not-merged, retarget transitions, failed writes with possible effects, cancellation during an active request, restart with no automatic replay, and foreign lock ownership. Run red before implementing.
- [ ] Implement the generic engine and SDK callback transport. Reconcile by provider state, not process exit. Persist only validated bounded operation data. The controller freezes confirmation scope and refreshes before acquiring/advancing writes.
- [ ] Implement page controls with existing theme variables, text-only provider data, keyboard-accessible badges, full/prefix confirmation, progress/Stop/Continue, and clipboard links. Existing provider row actions are supplied by each page.
- [ ] Run shared/SDK tests and typecheck. Keep callbacks cancellable through generation/ownership checks.

### Task 3: PR Inbox adapter and UI

**Files:** PR inbox `inbox.ts`, `main.ts`, `view.ts`, `protocol.ts`, `page/main.ts`, `plugin.json`, existing tests/README/VALIDATION.

**Consumes:** Task 2 shared controller and renderer. **Produces:** complete GitHub identity/pagination adapter and stack UI/actions.

- [ ] Extend parser/controller tests for page completion up to 500, partial-page failures, missing source/base/head identity, guarded merges, and exclusion of stack members from Merge all. Existing standalone behaviors remain pinned.
- [ ] Run focused PR suites red, then add GraphQL cursors/pageInfo, repository host/default identity, source repository, base, head, and state to parsing. Resolve referenced non-open members through bounded targeted reads.
- [ ] Implement provider snapshot/merge/retarget callbacks. Use `--match-head-commit`, no intermediate branch deletion in stack actions, verify retargeted base and unchanged head, then re-evaluate readiness. Distinguish merge queue acceptance from confirmed merge.
- [ ] Integrate graph/controller, API 18 inventory invalidation, project lock for individual/bulk actions, stack-aware blocking, stored interrupted scope, protocol validation, and shared inspector. Native gg actions must not invoke gh merge.
- [ ] Verify individual row actions, Mine/status filters, tab/sidebar inspector, and clipboard behavior. Run PR suites, typecheck, and build.

### Task 4: MR Inbox adapter and UI

**Files:** MR inbox `inbox.ts`, `main.ts`, `view.ts`, `protocol.ts`, `page/main.ts`, `plugin.json`, existing tests/README/VALIDATION.

**Consumes:** Task 2 shared controller/renderer and Task 3 integration conventions. **Produces:** complete GitLab dependency/pagination adapter and stack UI/actions.

- [ ] Extend tests for source/target project identity, dependency API unsupported/inaccessible, pagination, closed blockers, queued train members, and Add all exclusions. Prove a queued ancestor never advances a child.
- [ ] Run MR tests red, then implement cursor paging and separate bounded dependency reads, retaining existing list operation if the dependency endpoint is unavailable. Resolve explicitly referenced non-open members without treating closed as merged.
- [ ] Implement snapshot/queue/retarget callbacks preserving train versus auto-merge semantics and expected-head guards. Advance only after predecessor is confirmed merged. Show incomplete graphs as read-only with reasons.
- [ ] Integrate shared stack UI, native actions, project mutation ownership, Stop/Continue, and per-item actions. Keep rail Mine behavior and full inspector dependencies.
- [ ] Run MR suites, shared regression suites, typecheck, and build. Inspect train/inspector coexistence at full and narrow widths.

### Task 5: Integration and final review

- [ ] Exercise host/SDK payload compatibility and older-plugin behavior. API 18 plugins must be refused by older hosts normally, not fail after loading.
- [ ] Run plugin focused tests, full repository typecheck/build, and JavaScriptCore validation for the changed bundles. Run the native affected package/app checks from Task 1 after final integration changes.
- [ ] Render both pages with realistic fixtures at tab/sidebar widths and inspect screenshots. Include a mixed-author stack, incomplete graph, and queued MR.
- [ ] Review the final two-repository diff against every acceptance item. Fix findings and rerun only affected checks.
- [ ] Report implemented behavior and exact verification, retaining infrastructure-inconclusive results as such. Offer the corresponding PRs only after local work is reviewable; do not publish or merge without authorization.
