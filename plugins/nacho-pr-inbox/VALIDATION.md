# CI Doctor validation

## Web page (0.13.0)

The tab and the rail are web pages since 0.13.0. `view.ts` and
`doctor-view.ts` build plain view models, tested with `node --test`.
`page/main.ts` draws them, and `protocol.ts` checks every page message.
The scenario below now drives the plugin with `web/message` and checks that
each `web/post` stays within the 1 MiB message limit. The page was checked in
a stub host with fixture state, in light and dark, at tab width and at the
rail's 240-point minimum. It has not yet been run inside Alas; the native
verification below is of 0.12.0.

Verified on 2026-10-16 in the `nacho/ci-doctor` linked workspace.

## Automated checks

- `npm run typecheck`: passed for plugin, tests and page configurations.
- `npm test`: 199 tests passed across the repository, zero failures.
- `npm run build`: passed for every workspace.
- The independent whole-change review has no remaining substantive findings.
  Its fixes have regression coverage for session ownership changes during send,
  old snapshot replies, shared rate limits, fixed observation bounds, partial
  cache retention, pending classification and the 100-job cache union bound.
- Public captured run and attempt-job metadata were checked against real GitHub
  responses. Synthetic fixtures exercise failures, reruns and unavailable data.
- `node scripts/scenarios/ci-doctor.mjs` exercises the production controller/SDK
  and view end to end with fixture processes: open PR, select failed attempt 1
  alongside passing attempt 2, load a large/truncated log, compare base, review
  the brief, explicitly select a worktree session, verify its identity, send once,
  and reject a duplicate send. It validates page message bounds.
- That transcript passed `scripts/jsc-run` in bare JavaScriptCore, without JIT.
  The slowest handler used about 77 ms CPU, below the 250 ms host budget.

Reproduce the runtime check:

```bash
node scripts/scenarios/ci-doctor.mjs > /tmp/ci-doctor.jsonl
scripts/jsc-run plugins/nacho-pr-inbox/dist/plugin.js /tmp/ci-doctor.jsonl
```

On a restricted filesystem, set `CLANG_MODULE_CACHE_PATH` and
`SWIFT_MODULECACHE_PATH` to writable temporary directories while compiling the
runner.

## Native verification

A separate Alas 0.21.5 instance was prepared with an isolated profile at
`/private/tmp/ci-doctor-profile`. Its project uses the local Alas checkout.
The reviewed build is installed there and its capability/command disclosure
appears correctly in Settings. The user approved native testing. No
everyday-profile plugin was replaced.

Verified through the real native interface and the user's GitHub CLI login:

- Opened Alas PR #1888, Build run 37993493369, attempt 1, failed
  `Swift tests (shard 4)` job 114042966978 in the rail and full PR Inbox tab.
- Failed step, timestamps, job/run links and useful bounded log content rendered.
  The excerpt included the concrete failing test. The observed checkout SHA
  `a9addf0435b701bc3ffd7361d11ac1373562e151` remained distinct from PR head
  `dfa50aeeaed589d23b64ae05280ad14bec41be87`.
- Base comparisons displayed individual SHAs, cancelled/passing conclusions and
  the explicit 30-summary/five-run bound. Incomplete evidence remained unknown.
- Native testing found that gh 2.102.0 refuses terminal escapes in raw log output.
  The transport now retries that specific refusal once with
  `--allow-escape-sequences`, sanitizes the data, and retains compatibility with
  older gh. The fix passed a regression test, independent review, and the same
  live job log fetched/rendered successfully afterward.
- Restart restored cached evidence with its original timestamp before refreshing
  live status. Detailed selection and dispatch were not restored.
- Investigate displayed the literal selectable brief with repository, PR/head,
  run/job/attempt, tested checkout, comparison commits and coverage limits.
  Editing the question and applying Command-Return updated the preview.
- The isolated profile had no live sessions. The no-session explanation appeared,
  the brief remained copyable, and Send investigation stayed disabled.
- The real Swift log prompted a final pure parser regression: aggregate
  `Test run with ... failed` summaries cannot serve as failure signatures;
  concrete identifiers after Xcode's `Failing tests:` can. Automated tests and
  independent review verified this final adjustment.

Remaining manual gates:

- With a suitable live chat explicitly selected, verify checkout mismatch
  acknowledgement and prompt acceptance. No live prompt has been sent as part
  of the automated scenario; its session boundary is fixture-backed.
- Exercise a real SSH project. Tests verify exact worktree IDs reach the process
  boundary, but a remote host has not been used for this change.

## Implementation rulings

- API 15 has no open-tab request and no terminal/chat-kind field in its snapshot.
  Both surfaces drill down in place, and the host authoritatively accepts/refuses
  live chat sends. Terminal refusal retains the copyable brief.
- GitHub has no attempt-summary listing endpoint. The five-attempt sample keeps
  attempt 1 and the latest four; the first failure can be in an omitted attempt
  and remains unknown. The view identifies the omitted range.
- Session/HEAD verification cannot atomically lock a checkout across external
  git activity and sessionSend. The brief reports its observed SHA/time, and
  newer known ownership/identity changes cancel pending verification.
- To stay below 2,000 native nodes, the list shows five failed steps per job and
  links to all steps on GitHub. Logs and briefs are quoted as literal data in
  bounded selectable blocks, including hostile Markdown fences.
