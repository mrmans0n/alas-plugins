import { definePlugin, notify, processRun, request, requestSnapshot, sessionSend, setPanelBadge, setTimer, storageGet, storageSet, webPost, type Event, type Snapshot } from "@alas/plugin";
import { addMode, parseTrainsEnabled, processError } from "./inbox.ts";
import { InboxStackController } from "../../../shared/inbox-stack-controller.ts";
import { individualBlocker, reviewKey } from "../../../shared/inbox-stacks.ts";
import { MRStackAdapter } from "./stack-adapter.ts";
import { addCandidates, inboxModel, readyMine, type ViewState } from "./view.ts";
import { DoctorController } from "./doctor-controller.ts";
import { endpoint, GitLab, ProcessQueue } from "./doctor-transport.ts";
import { doctorModel } from "./doctor-view.ts";
import { object } from "./doctor.ts";
import { parsePageMessage, type PageMessage, type PluginMessage } from "./protocol.ts";

const TAB = 0;
const PANEL = "rail";
const REFRESH_SECONDS = 60;
const HIDDEN_REFRESH_SECONDS = 300;

let worktree: string | undefined;
const state: ViewState = { refreshing: false, errors: {} };
let listing = false;
/** A refresh asked for while one was running, so its data may predate a merge. */
let again = false;
let tabShown = false;
let panelShown = false;
let doctor: DoctorController | undefined;
let gitlab: GitLab | undefined;
let stacks: InboxStackController | undefined;
let adapter: MRStackAdapter | undefined;
let shuttingDown = false;
let cached: unknown;
let loadCache: number | undefined;
let loadView: number | undefined;
/** The user clicked the toggle: a stored value that arrives later is older than that. */
let scopeTouched = false;
let snapshot: Snapshot = { worktrees: [] };
/** What Add all still has to add, in order. */
let addQueue: number[] = [];
/** The ready count the rail badge shows. */
let badge = 0;
const queue = new ProcessQueue((id, wt, args, done) => processRun(id, wt, { args: args.length ? args : undefined }, done));

/** Sends the state to the tab's and the rail's pages; one that is not shown drops it. */
const draw = () => {
  state.graph = stacks?.graph; state.stackBusy = stacks?.busy;
  const message: PluginMessage = { type: "state", stacks: stacks?.model(state.inbox?.user, state.mineOnly), inbox: inboxModel(state, Date.now()), ...(doctor?.state.target ? { doctor: doctorModel(doctor.state) } : {}) };
  webPost(TAB, message);
  webPost(PANEL, message);
  const ready = readyMine(state);
  if (ready !== badge) setPanelBadge(PANEL, ready > 0 ? { count: ready, tone: "success" } : null);
  badge = ready;
};

function refresh(manual = false): void {
  if (manual) gitlab?.retry();
  if (!worktree || shuttingDown) return;
  if (manual || state.trainsEnabled === undefined) {
    queue.run("project", worktree, [], (outcome) => {
      const enabled = processError(outcome) === undefined ? parseTrainsEnabled(outcome.result!.stdout) : undefined;
      // An error or unreadable reply keeps the old value; undefined counts as on and is asked again on the next refresh.
      if (enabled !== undefined) state.trainsEnabled = enabled;
      draw();
    }, { priority: true });
  }
  if (listing) { again = true; return; }
  listing = true;
  state.refreshing = true;
  draw();
  adapter?.refresh(stacks?.requiredIdentities ?? [], (snapshot, failure) => {
    listing = false; state.refreshing = false;
    if (snapshot) stacks?.updateProvider(snapshot);
    state.error = failure ?? snapshot?.error;
    if (again) { again = false; refresh(); }
    else if (failure || !snapshot?.complete) { stopAddAll(); draw(); }
    else if (!continueAddAll()) draw();
  });
}

/** CI Doctor needs the project and host, which the first list reply gives. */
function ensureDoctor(): void {
  const inbox = state.inbox;
  if (!inbox || !worktree || (gitlab && gitlab.project === inbox.project && gitlab.host === inbox.host)) return;
  gitlab = new GitLab(queue, worktree, inbox.project, inbox.host, Date.now, seconds => setTimer("ci-backoff", seconds));
  doctor = new DoctorController(gitlab, queue, {
    changed: draw,
    now: Date.now,
    save: value => { storageSet("ci-doctor-v1", value); },
    snapshot: done => { request("workspace/snapshot", {}, ({ result, error }) => done(!error && object(result) && result.snapshot && Array.isArray(result.snapshot.worktrees) ? result.snapshot as Snapshot : { worktrees: [] })); },
    send: (session, text, done) => { sessionSend(session, text, ({ error }) => done(error?.message)); },
  });
  doctor.updateSnapshot(snapshot);
  gitlab.setMutationRunner((rest, done) => {
    if (!stacks || !adapter) return done("Stack ownership is unavailable.");
    stacks.runMutation(settle => adapter!.retry(rest, settle), done);
  });
  if (cached) doctor.restore(cached);
}

const SHA = /^[0-9a-f]{40,64}$/;

/** True when a write was started. */
function add(iid: number): boolean {
  const inbox = state.inbox;
  const mr = inbox?.mrs.find((m) => m.iid === iid);
  const when = mr && addMode(mr);
  if (!worktree || !inbox || !mr || !when || state.busy !== undefined || !SHA.test(mr.sha)) return false;
  const member = inbox.reviews?.find(r => r.identity.number === iid && r.identity.repo === inbox.project);
  if (!stacks || !adapter || !inbox.complete || !member || stacks.busy) return false;
  const blocked = () => individualBlocker(stacks!.graph, member.identity);
  const native = stacks.graph.byReview[reviewKey(member.identity)]?.native;
  if (blocked()) { state.errors[iid] = blocked()!; draw(); return false; }
  if (native) { stacks.handle({ type: "stack", action: "native", key: reviewKey(member.identity), nativeAction: "landThrough" }); return true; }
  state.busy = iid;
  delete state.errors[iid];
  stacks.runMutation(done => {
    adapter!.refresh(stacks!.requiredIdentities, (snapshot, error) => {
      if (snapshot) stacks!.updateProvider(snapshot);
      const fresh = snapshot?.reviews.find(r => reviewKey(r.identity) === reviewKey(member.identity));
      if (shuttingDown || error || !snapshot?.complete || !fresh || fresh.sha !== member.sha || fresh.sourceRepo !== member.sourceRepo || fresh.branch !== member.branch || fresh.base !== member.base || fresh.state !== "open" || !fresh.canQueue || fresh.queued || blocked() || stacks!.graph.byReview[reviewKey(member.identity)]?.native) return done(error ?? blocked() ?? "MR changed before queueing. Refresh and try again.");
      adapter!.submit(fresh, done);
    });
  }, failure => {
    state.busy = undefined;
    if (failure === undefined) notify(state.trainsEnabled !== false ? `Requested !${iid} for the merge train; waiting for GitLab.` : `Requested auto-merge for !${iid}; waiting for GitLab.`);
    else state.errors[iid] = failure;
    if (state.addAll) { if (failure === undefined) state.addAll.done++; else stopAddAll(); }
    refresh();
  });
  draw();
  return true;
}

/** Adds the ready MRs one at a time, each after a fresh list, stopping at the first failure. */
function addAll(): void {
  if (!state.inbox?.complete || stacks?.busy || state.busy !== undefined || state.addAll) return;
  addQueue = addCandidates(state).map((m) => m.iid);
  if (addQueue.length === 0) return;
  state.addAll = { total: addQueue.length, done: 0 };
  continueAddAll();
}

function stopAddAll(): void {
  addQueue = [];
  state.addAll = undefined;
}

function continueAddAll(): boolean {
  if (!state.addAll || state.busy !== undefined) return false;
  while (addQueue.length > 0) {
    const iid = addQueue.shift()!;
    const mr = state.inbox?.mrs.find((m) => m.iid === iid);
    if (mr && addMode(mr) === "now" && addCandidates(state).includes(mr)) {
      if (add(iid)) return true;
    }
  }
  stopAddAll();
  return false;
}

/** Only a listed MR's failing head pipeline. */
function retryPipeline(id: number): void {
  const mr = state.inbox?.mrs.find((m) => m.pipeline?.id === id && (m.pipeline.status === "FAILED" || m.pipeline.status === "CANCELED"));
  if (!mr || !gitlab || state.retrying !== undefined) return;
  state.retrying = id;
  delete state.errors[mr.iid];
  draw();
  gitlab.retryPipeline(id, (error) => {
    state.retrying = undefined;
    if (error) state.errors[mr.iid] = error;
    refresh();
  });
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
  adapter = new MRStackAdapter(queue, worktree, inbox => {
    state.inbox = inbox; state.fetchedAt = Date.now(); state.error = undefined;
    ensureDoctor(); doctor?.updateInbox(inbox.project, inbox.mrs.map(m => ({ number: m.iid, title: m.title, url: m.url, branch: m.branch })));
  }, () => state.trainsEnabled !== false, outcome => gitlab?.observe(outcome));
  stacks = new InboxStackController(adapter, draw); stacks.activate();
  // Shown already: `setShown` set the minute timer.
  if (!(tabShown || panelShown)) setTimer("refresh", HIDDEN_REFRESH_SECONDS, true);
  refresh();
}

function pageMessage(m: PageMessage): void {
  switch (m.type) {
    case "stack":
      if (m.action === "refresh" || m.action === "continue") gitlab?.retry();
      return stacks?.handle(m);
    case "ready": return draw();
    case "refresh": return refresh(true);
    case "add": add(m.iid); return;
    case "addAll": return addAll();
    case "scope":
      scopeTouched = true;
      state.mineOnly = m.mine;
      storageSet("view-v1", { mineOnly: m.mine });
      return draw();
    case "retryPipeline": return retryPipeline(m.pipeline);
    case "doctor": {
      const mr = state.inbox?.mrs.find((x) => x.iid === m.iid);
      if (mr && state.inbox) doctor?.open(state.inbox.project, { number: mr.iid, title: mr.title, url: mr.url, branch: mr.branch });
      return;
    }
  }
  const d = doctor;
  if (!d?.state.target) return;
  const token = d.state.dispatch?.token;
  switch (m.type) {
    case "retryJob": return d.retryJob(m.job);
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
      case "deactivate": shuttingDown = true; stacks?.dispose(); adapter?.dispose(); return;
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
