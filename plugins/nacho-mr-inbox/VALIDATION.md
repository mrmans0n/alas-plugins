# MR Inbox validation

The tab and the rail are web pages (`page/main.ts`) drawn from view models built
in `view.ts` and `doctor-view.ts`. The page has not yet been rendered inside
Alas.

## Automated checks

Run on 2026-10-22 from the repository root with Node 24.13.0.

- `npm run typecheck`: passed.
- `npm test`: passed, 297 tests across the repository workspaces, zero failures
  (81 of them in `nacho-mr-inbox`).
- `npm run build`: passed for every workspace.

## Manual checks (self-managed GitLab with merge trains, and gitlab.com)

Manual checks: not yet run. Tick an item with the date only after running it in
Alas against a real project; write down failures here.

- [ ] Tab lists MRs in Ready / Blocked / Failing / Drafts; blocked MRs say why (approvals, threads, changes requested)
- [ ] Train strip matches GitLab's merge train page, in order; my cars ringed
- [ ] Add to train on a ready MR; it moves into the strip after refresh
- [ ] Add when green on a running MR; GitLab shows it set to add when the pipeline succeeds
- [ ] Add all with two ready MRs; one failure stops it and shows under the row
- [ ] Project without merge trains: banner shows; Merge when green sets auto-merge
- [ ] Retry failed on a failing MR restarts its failed jobs
- [ ] CI Doctor: pipelines with kinds, retries as attempts, failing section, excerpt from the log tail, comparison with the target branch, job Retry
- [ ] Investigate → select session → send once
- [ ] Rail: train + Yours, badge count, 240-point width, light and dark
- [ ] Not signed in (`glab auth logout`): sign-in message; repo with only a GitHub remote: no-remote message
- [ ] SSH project: runs `glab` on the host

## API 17 change

The `requires` visibility change (API 17, panel icon) was verified only by typecheck, tests and build, not yet inside an Alas build with API 17.
