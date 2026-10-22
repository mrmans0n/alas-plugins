import { definePlugin, notify, processRun, request, requestSnapshot, sessionSend, setPanelBadge, setTimer, storageGet, storageSet, webPost, type Event, type Snapshot } from "@alas/plugin";
import { canMerge, classify, isReady, parseInbox, processError } from "./inbox.ts";
import { inboxModel, readyCount, type ViewState } from "./view.ts";
import { DoctorController } from "./doctor-controller.ts";
import { GitHub, ProcessQueue } from "./doctor-transport.ts";
import { doctorModel } from "./doctor-view.ts";
import { object } from "./doctor.ts";
import { parsePageMessage, type PageMessage, type PluginMessage } from "./protocol.ts";

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
let doctor: DoctorController | undefined;
let github: GitHub | undefined;
let cached: unknown;
let loadCache: number | undefined;
let snapshot: Snapshot = { worktrees: [] };
/** What Merge all still has to merge, in order. */
let mergeQueue: number[] = [];
/** The ready count the rail badge shows. */
let badge = 0;
const queue = new ProcessQueue((id, wt, args, done) => processRun(id, wt, { args: args.length ? args : undefined }, done));

/** Sends the state to the tab's and the rail's pages; one that is not shown drops it. */
const draw = () => {
  const message: PluginMessage = { type: "state", inbox: inboxModel(state, Date.now()), ...(doctor?.state.target ? { doctor: doctorModel(doctor.state) } : {}) };
  webPost(TAB, message);
  webPost(PANEL, message);
  const ready = readyCount(state);
  if (ready !== badge) setPanelBadge(PANEL, ready > 0 ? { count: ready, tone: "success" } : null);
  badge = ready;
};

function refresh(manual = false): void {
  if (manual) github?.retry();
  if (!worktree) return;
  if (listing) {
    again = true;
    return;
  }
  listing = true;
  state.refreshing = true;
  draw();
  queue.run("list", worktree, [], (outcome) => {
    github?.observe(outcome);
    listing = false;
    state.refreshing = false;
    const failure = processError(outcome);
    const inbox = failure === undefined ? parseInbox(outcome.result!.stdout) : undefined;
    if (inbox) {
      state.inbox = inbox;
      state.fetchedAt = Date.now();
      state.error = undefined;
      doctor?.updateInbox(inbox.repo, inbox.pulls);
    } else {
      state.error = failure ?? (outcome.result?.truncated ? "The pull request list did not fit in gh's output limit." : "gh returned an unexpected reply.");
    }
    if (again) {
      again = false;
      refresh();
    } else if (!continueMergeAll()) draw();
  }, { priority: true });
}

function merge(number: number): void {
  const pull = state.inbox?.pulls.find((p) => p.number === number);
  if (!worktree || state.merging !== undefined || !pull || !canMerge(pull)) return;
  state.merging = number;
  delete state.mergeErrors[number];
  draw();
  queue.run("merge", worktree, [String(number)], (outcome) => {
    github?.observe(outcome);
    state.merging = undefined;
    const failure = processError(outcome);
    if (failure === undefined) notify(`Merged #${number}`);
    else state.mergeErrors[number] = failure;
    if (state.mergeAll) {
      if (failure === undefined) state.mergeAll.done++;
      else stopMergeAll();
    }
    refresh();
  }, { priority: true });
}

/** Merges the ready pull requests one at a time, each after a fresh list, stopping at the first failure. */
function mergeAll(): void {
  if (!state.inbox || state.merging !== undefined || state.mergeAll) return;
  mergeQueue = classify(state.inbox.pulls).ready.map((p) => p.number);
  if (mergeQueue.length === 0) return;
  state.mergeAll = { total: mergeQueue.length, done: 0 };
  continueMergeAll();
}

function stopMergeAll(): void {
  mergeQueue = [];
  state.mergeAll = undefined;
}

/** Starts Merge all's next merge that is still ready on the current list; `false` when there is none to start. */
function continueMergeAll(): boolean {
  if (!state.mergeAll || state.merging !== undefined) return false;
  while (mergeQueue.length > 0) {
    const number = mergeQueue.shift()!;
    const pull = state.inbox?.pulls.find((p) => p.number === number);
    if (pull && isReady(pull)) {
      merge(number);
      return true;
    }
  }
  stopMergeAll();
  return false;
}

/** Refreshes every minute while the tab or the panel is shown, and every 5 minutes otherwise to keep the data current. */
function setShown(tab: boolean, panel: boolean): void {
  const was = tabShown || panelShown;
  tabShown = tab;
  panelShown = panel;
  const shown = tab || panel;
  if (shown === was) return;
  setTimer("refresh", shown ? REFRESH_SECONDS : HIDDEN_REFRESH_SECONDS, true);
  if (shown && !listing && (state.fetchedAt === undefined || Date.now() - state.fetchedAt > REFRESH_SECONDS * 1000)) refresh();
}

function useSnapshot(next: Snapshot): void {
  snapshot = next;
  doctor?.updateSnapshot(snapshot);
  const first = worktree === undefined;
  worktree = (snapshot.worktrees.find((w) => w.main) ?? snapshot.worktrees[0])?.id;
  if (!first || !worktree) return;
  github = new GitHub(queue, worktree, Date.now, seconds => setTimer("ci-backoff", seconds));
  doctor = new DoctorController(github, queue, {
    changed: draw,
    now: Date.now,
    save: value => { storageSet("ci-doctor-v1", value); },
    snapshot: done => { request("workspace/snapshot", {}, ({ result, error }) => done(!error && object(result) && result.snapshot && Array.isArray(result.snapshot.worktrees) ? result.snapshot as Snapshot : { worktrees: [] })); },
    send: (session, text, done) => { sessionSend(session, text, ({ error }) => done(error?.message)); },
  });
  doctor.updateSnapshot(snapshot);
  if (cached) doctor.restore(cached);
  // Shown already: `setShown` set the minute timer.
  if (!(tabShown || panelShown)) setTimer("refresh", HIDDEN_REFRESH_SECONDS, true);
  refresh();
}

function pageMessage(m: PageMessage): void {
  switch (m.type) {
    case "ready": return draw();
    case "refresh": return refresh(true);
    case "merge": return merge(m.number);
    case "mergeAll": return mergeAll();
    case "doctor": {
      const pull = state.inbox?.pulls.find((p) => p.number === m.number);
      if (pull && state.inbox) doctor?.open(state.inbox.repo, pull);
      return;
    }
  }
  const d = doctor;
  if (!d?.state.target) return;
  const token = d.state.dispatch?.token;
  switch (m.type) {
    case "back": return d.close();
    case "doctorRefresh": return d.refresh();
    case "run": {
      const run = d.state.evidence?.runs.find((r) => r.id === m.run);
      if (run) d.selectAttempt(run.id, run.attempt);
      return;
    }
    case "attempt": return d.selectAttempt(m.run, m.attempt);
    case "job": return d.selectJob(m.job);
    case "prepare": return d.prepare(m.job);
    case "question": return m.token === token ? d.question(m.text) : undefined;
    case "session": return m.token === token ? d.selectSession(m.session) : undefined;
    case "acknowledge": return d.acknowledge();
    case "send": return d.send();
  }
}

definePlugin({
  handle(event: Event) {
    switch (event.type) {
      case "activate":
        draw();
        requestSnapshot();
        loadCache = storageGet("ci-doctor-v1");
        return;
      case "stored":
        if (event.id === loadCache && !event.error) { cached = event.value; doctor?.restore(cached); }
        return;
      case "snapshot":
      case "workspaceChanged":
        return useSnapshot(event.snapshot);
      case "tabVisible":
        return event.tab === TAB ? setShown(event.visible, panelShown) : undefined;
      case "panelVisible":
        return event.panel === PANEL ? setShown(tabShown, event.visible) : undefined;
      case "timer":
        if (event.id === "ci-backoff") { queue.resume(); draw(); return; }
        return event.id === "refresh" ? refresh() : undefined;
      case "webMessage": {
        if (event.tab === undefined ? event.panel !== PANEL : event.tab !== TAB) return;
        const message = parsePageMessage(event.message);
        if (message) pageMessage(message);
        return;
      }
    }
  },
});
