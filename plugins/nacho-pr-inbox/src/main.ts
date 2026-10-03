import { definePlugin, notify, processRun, render, requestSnapshot, setTimer, type Event, type Snapshot } from "@alas/plugin";
import { isReady, parseInbox, processError } from "./inbox.ts";
import { inboxView, mergeTarget, type ViewState } from "./view.ts";

const TAB = 0;

let worktree: string | undefined;
const state: ViewState = { refreshing: false, mergeErrors: {} };
let listing = false;
/** A refresh asked for while one was running, so its data may predate a merge. */
let again = false;
let polling = false;

const draw = () => render(TAB, inboxView(state, Date.now()));

function refresh(): void {
  if (!worktree) return;
  if (listing) {
    again = true;
    return;
  }
  listing = true;
  state.refreshing = true;
  draw();
  processRun("list", worktree, {}, (outcome) => {
    listing = false;
    state.refreshing = false;
    const failure = processError(outcome);
    const inbox = failure === undefined ? parseInbox(outcome.result!.stdout) : undefined;
    if (inbox) {
      state.inbox = inbox;
      state.fetchedAt = Date.now();
      state.error = undefined;
    } else {
      state.error = failure ?? (outcome.result?.truncated ? "The pull request list did not fit in gh's output limit." : "gh returned an unexpected reply.");
    }
    if (again) {
      again = false;
      refresh();
    } else draw();
  });
}

function merge(number: number): void {
  const pull = state.inbox?.pulls.find((p) => p.number === number);
  if (!worktree || state.merging !== undefined || !pull || !isReady(pull)) return;
  state.merging = number;
  delete state.mergeErrors[number];
  draw();
  processRun("merge", worktree, { args: [String(number)] }, (outcome) => {
    state.merging = undefined;
    const failure = processError(outcome);
    if (failure === undefined) notify(`Merged #${number}`);
    else state.mergeErrors[number] = failure;
    refresh();
  });
}

/** Someone is looking at the inbox: keep it fresh every minute from now on. */
function startPolling(): void {
  if (polling) return;
  polling = true;
  // ponytail: view tabs report no visibility, so once opened the inbox polls until the plugin restarts.
  setTimer("refresh", 60, true);
}

function useSnapshot(snapshot: Snapshot): void {
  const first = worktree === undefined;
  // Alas lists a project's main worktree first.
  worktree = snapshot.worktrees[0]?.id;
  if (first && worktree) refresh();
}

definePlugin({
  handle(event: Event) {
    switch (event.type) {
      case "activate":
        draw();
        requestSnapshot();
        return;
      case "snapshot":
      case "workspaceChanged":
        return useSnapshot(event.snapshot);
      case "command":
        if (event.command !== "open") return;
        startPolling();
        return refresh();
      case "timer":
        return event.id === "refresh" ? refresh() : undefined;
      case "viewEvent": {
        if (event.tab !== TAB || event.kind !== "click") return;
        startPolling();
        if (event.id === "refresh" || event.id === "retry") return refresh();
        const number = mergeTarget(event.id);
        if (number !== undefined) merge(number);
        return;
      }
    }
  },
});
