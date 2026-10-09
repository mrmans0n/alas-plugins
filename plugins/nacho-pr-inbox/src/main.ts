import { definePlugin, notify, processRun, render, renderPanel, requestSnapshot, setPanelBadge, setTimer, type Event, type Snapshot } from "@alas/plugin";
import { canMerge, inboxBadge, parseInbox, processError } from "./inbox.ts";
import { inboxView, mergeTarget, type ViewState } from "./view.ts";

const TAB = 0;
const PANEL = "rail";
const REFRESH_SECONDS = 60;
const HIDDEN_REFRESH_SECONDS = 300;

let worktree: string | undefined;
const state: ViewState = { refreshing: false, mergeErrors: {} };
let listing = false;
/** A refresh asked for while one was running, so its data may predate a merge. */
let again = false;
let tabShown = false;
let panelShown = false;

const draw = () => {
  const tree = inboxView(state, Date.now());
  render(TAB, tree);
  renderPanel(PANEL, tree);
  setPanelBadge(PANEL, inboxBadge(state.inbox));
};

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

/** Refreshes every minute while the tab or the panel is shown, and every 5 minutes otherwise to keep the badge current. */
function setShown(tab: boolean, panel: boolean): void {
  const was = tabShown || panelShown;
  tabShown = tab;
  panelShown = panel;
  const shown = tab || panel;
  if (shown === was) return;
  setTimer("refresh", shown ? REFRESH_SECONDS : HIDDEN_REFRESH_SECONDS, true);
  if (shown && !listing && (state.fetchedAt === undefined || Date.now() - state.fetchedAt > REFRESH_SECONDS * 1000)) refresh();
}

function useSnapshot(snapshot: Snapshot): void {
  const first = worktree === undefined;
  worktree = (snapshot.worktrees.find((w) => w.main) ?? snapshot.worktrees[0])?.id;
  if (!first || !worktree) return;
  // Shown already: `setShown` set the minute timer.
  if (!(tabShown || panelShown)) setTimer("refresh", HIDDEN_REFRESH_SECONDS, true);
  refresh();
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
        return event.tab === TAB ? setShown(event.visible, panelShown) : undefined;
      case "panelVisible":
        return event.panel === PANEL ? setShown(tabShown, event.visible) : undefined;
      case "timer":
        return event.id === "refresh" ? refresh() : undefined;
      case "viewEvent":
      case "panelEvent": {
        if ((event.type === "viewEvent" ? event.tab !== TAB : event.panel !== PANEL) || event.kind !== "click") return;
        if (event.id === "refresh" || event.id === "retry") return refresh();
        const number = mergeTarget(event.id);
        if (number !== undefined) merge(number);
        return;
      }
    }
  },
});
