# Agent Usage

A dashboard of what your agents used, in a tab: turns, tokens, cost, turn time and usage-limit
hits over the last 7, 30 or 90 days, for this project or all of them.

- **Summary:** turns (and how many completed), tokens (input, cached, output), cost per currency,
  average turn time and usage-limit hits.
- **Tokens per day,** stacked by agent, as totals or just input, cached or output tokens.
- **Cost per day,** when the agents report one. Turns without a cost are counted, not guessed.
- **By agent and model** and **by worktree:** turns, tokens, cost, average time and success rate.
- **Usage-limit hits,** newest first, with when each limit resets when Alas knows it.

Open it from the command palette (**Agent Usage**). It needs plugin API 12.

## Your data stays on this Mac

The numbers come from the usage history Alas keeps locally. The plugin reads it with the
`usage.read` capability and sends the page totals, never prompts, replies or code (the history
holds none). The page runs in Alas's sandboxed web view with no network access at all, so
nothing it shows can leave your Mac.

`usage.read` covers every project: **All projects** reads turns from the other projects too, and
the approval sheet says so. Other projects' turns are grouped as "Other projects", since the
plugin only knows the names of this project's worktrees (`workspace.read`).

## History starts at API 12

Alas records turns from the version that added plugin API 12 on, and keeps 400 days of them.
Earlier turns were never recorded, so a new install starts empty.
