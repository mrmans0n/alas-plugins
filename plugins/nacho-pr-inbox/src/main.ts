import { cancelTimer, definePlugin, notify, processRun, render, requestSnapshot, setTimer, type Event, type Snapshot } from "@alas/plugin";
import { canMerge, MERGED_PAGE, parseInbox, processError } from "./inbox.ts";
import { inboxView, mergeTarget, SHOW_MORE_MERGED, type ViewState } from "./view.ts";

const TAB = 0;
const REFRESH_SECONDS = 60;

let worktree: string | undefined;
const state: ViewState = { refreshing: false, mergeErrors: {} };
let listing = false;
/** A refresh asked for while one was running, so its data may predate a merge. */
let again = false;
let visible = false;

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
  if (!worktree || state.merging !== undefined || !pull || !canMerge(pull)) return;
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

/** The tab refreshes every minute only while it is shown, and at once when shown with stale data. */
function setVisible(shown: boolean): void {
  visible = shown;
  if (!shown) {
    cancelTimer("refresh");
    return;
  }
  setTimer("refresh", REFRESH_SECONDS, true);
  if (!listing && (state.fetchedAt === undefined || Date.now() - state.fetchedAt > REFRESH_SECONDS * 1000)) refresh();
}

function useSnapshot(snapshot: Snapshot): void {
  const first = worktree === undefined;
  worktree = (snapshot.worktrees.find((w) => w.main) ?? snapshot.worktrees[0])?.id;
  if (first && worktree && visible) refresh();
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
      case "tabVisible":
        return event.tab === TAB ? setVisible(event.visible) : undefined;
      case "timer":
        return event.id === "refresh" ? refresh() : undefined;
      case "viewEvent": {
        if (event.tab !== TAB || event.kind !== "click") return;
        if (event.id === "refresh" || event.id === "retry") return refresh();
        if (event.id === SHOW_MORE_MERGED) {
          state.mergedShown = (state.mergedShown ?? MERGED_PAGE) + MERGED_PAGE;
          return draw();
        }
        const number = mergeTarget(event.id);
        if (number !== undefined) merge(number);
        return;
      }
    }
  },
});
