import { definePlugin, notify, processRun, request, requestSnapshot, sessionSend, setPanelBadge, setTimer, storageGet, storageSet, webPost, type Event, type Snapshot } from "@alas/plugin";
import { canMerge, isReady } from "./inbox.ts";
import { InboxStackController } from "../../../shared/inbox-stack-controller.ts";
import { reviewKey, individualBlocker } from "../../../shared/inbox-stacks.ts";
import { PRStackAdapter } from "./stack-adapter.ts";
import { inboxModel, mergeCandidates, readyCount, type ViewState } from "./view.ts";
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
let shuttingDown = false;
/** A refresh asked for while one was running, so its data may predate a merge. */
let again = false;
let tabShown = false;
let panelShown = false;
let doctor: DoctorController | undefined;
let github: GitHub | undefined;
let stacks: InboxStackController | undefined;
let adapter: PRStackAdapter | undefined;
let verifying: number | undefined;
let cached: unknown;
let loadCache: number | undefined;
let loadView: number | undefined;
/** The user clicked the toggle: a stored value that arrives later is older than that. */
let scopeTouched = false;
let snapshot: Snapshot = { worktrees: [] };
/** What Merge all still has to merge, in order. */
let mergeQueue: number[] = [];
/** The ready count the rail badge shows. */
let badge = 0;
const queue = new ProcessQueue((id, wt, args, done) => processRun(id, wt, { args: args.length ? args : undefined }, done));

/** Sends the state to the tab's and the rail's pages; one that is not shown drops it. */
const draw = () => {
  state.graph = stacks?.graph;
  state.stackBusy = stacks?.busy;
  const message: PluginMessage = { type: "state", inbox: inboxModel(state, Date.now()), stacks: stacks?.model(state.inbox?.viewer, state.mineOnly), ...(doctor?.state.target ? { doctor: doctorModel(doctor.state) } : {}) };
  webPost(TAB, message);
  webPost(PANEL, message);
  const ready = readyCount(state);
  if (ready !== badge) setPanelBadge(PANEL, ready > 0 ? { count: ready, tone: "success" } : null);
  badge = ready;
};

function refresh(manual = false): void {
  if (manual) github?.retry();
  if (!worktree || shuttingDown) return;
  if (listing) {
    again = true;
    return;
  }
  // Only the batch requested after command settlement owns its verification.
  const verification = verifying;
  listing = true;
  state.refreshing = true;
  draw();
  adapter?.refresh([...stacks?.requiredIdentities ?? [], ...(verification && state.inbox?.host ? [{host:state.inbox.host,repo:state.inbox.repo,number:verification}] : [])], (snapshot, failure) => {
    listing = false;
    state.refreshing = false;
    if (snapshot) stacks?.updateProvider(snapshot);
    state.error = failure ?? snapshot?.error;
    if (verification !== undefined && verifying === verification) {
      const merged = snapshot?.reviews.find(r=>r.identity.number===verification)?.state === "merged";
      if (merged && state.mergeAll) state.mergeAll.done++;
      else if (state.mergeAll) stopMergeAll();
      if (merged) notify(`Merged #${verification}`);
      verifying = undefined;
    }
    if (again) { again = false; refresh(); }
    else if (!continueMergeAll()) draw();
  });
}

function merge(number: number): void {
  const pull = state.inbox?.pulls.find(p => p.number === number);
  const member = state.inbox?.reviews?.find(r=>r.identity.number===number);
  if (!worktree || !stacks || !adapter || state.merging !== undefined || verifying !== undefined || !pull || !canMerge(pull) || !member || !state.inbox?.complete) return;
  const blocked = () => individualBlocker(stacks!.graph,member.identity);
  if (blocked()) { state.mergeErrors[number] = blocked()!; draw(); return; }
  delete state.mergeErrors[number];
  if (stacks.graph.byReview[reviewKey(member.identity)]?.native) {
    stacks.handle({type:"stack",action:"native",key:reviewKey(member.identity),nativeAction:"landThrough"});
    return;
  }
  state.merging = number;
  stacks.runMutation(done => {
    adapter!.refresh(stacks!.requiredIdentities, (snapshot,error) => {
      if (snapshot) stacks!.updateProvider(snapshot);
      const fresh = snapshot?.reviews.find(r=>reviewKey(r.identity)===reviewKey(member.identity));
      if (shuttingDown || error || !snapshot?.complete || !fresh || fresh.state!=="open" || fresh.sha!==member.sha || fresh.base!==member.base || !canMerge(state.inbox!.pulls.find(p=>p.number===number) ?? pull) || blocked()) return done(error ?? blocked() ?? "Request changed before merging. Refresh and try again.");
      adapter!.mergeIndividual(fresh, !stacks!.graph.byReview[reviewKey(fresh.identity)], done);
    });
  }, failure => {
    state.merging = undefined;
    if (failure) { state.mergeErrors[number] = failure; if (state.mergeAll) stopMergeAll(); }
    else { verifying=number; notify(`Merge requested for #${number}; waiting for GitHub confirmation.`); }
    refresh();
  });
  draw();
}

/** Merges the ready pull requests one at a time, each after a fresh list, stopping at the first failure. */
function mergeAll(): void {
  if (!state.inbox?.complete || stacks?.busy || state.merging !== undefined || state.mergeAll) return;
  mergeQueue = mergeCandidates(state).map((p) => p.number);
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
    if (pull && isReady(pull) && mergeCandidates(state).includes(pull)) {
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
  adapter = new PRStackAdapter(queue, worktree, inbox => {
    state.inbox=inbox; state.fetchedAt=Date.now(); doctor?.updateInbox(inbox.repo,inbox.pulls);
  }, outcome=>github?.observe(outcome));
  stacks = new InboxStackController(adapter, draw);
  stacks.activate();
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
    case "stack":
      if (m.action === "refresh" || m.action === "continue") github?.retry();
      return stacks?.handle(m);
    case "ready": return draw();
    case "refresh": return refresh(true);
    case "merge": return merge(m.number);
    case "mergeAll": return mergeAll();
    case "scope":
      scopeTouched = true;
      state.mineOnly = m.mine;
      storageSet("view-v1", { mineOnly: m.mine });
      return draw();
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
        loadView = storageGet("view-v1");
        scopeTouched = false;
        return;
      case "deactivate": shuttingDown=true; stopMergeAll(); adapter?.dispose(); stacks?.dispose(); return;
      case "stacksChanged": stacks?.refreshNative(false); return;
      case "stored":
        if (event.id === loadCache && !event.error) { cached = event.value; doctor?.restore(cached); }
        if (event.id === loadView && !event.error && !scopeTouched && object(event.value) && typeof event.value.mineOnly === "boolean") { state.mineOnly = event.value.mineOnly; draw(); }
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
