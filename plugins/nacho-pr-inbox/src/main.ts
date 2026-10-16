import { definePlugin, notify, processRun, render, renderPanel, request, requestSnapshot, sessionSend, setTimer, storageGet, storageSet, type Event, type Snapshot } from "@alas/plugin";
import { canMerge, parseInbox, processError } from "./inbox.ts";
import { inboxView, mergeTarget, type ViewState } from "./view.ts";
import { DoctorController } from "./doctor-controller.ts";
import { GitHub, ProcessQueue } from "./doctor-transport.ts";
import { doctorView } from "./doctor-view.ts";
import { object } from "./doctor.ts";

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
const queue = new ProcessQueue((id, wt, args, done) => processRun(id, wt, { args: args.length ? args : undefined }, done));

const draw = () => {
  const detail = doctor?.state.target ? doctor.state : undefined;
  render(TAB, detail ? doctorView(detail) : inboxView(state, Date.now()));
  renderPanel(PANEL, detail ? doctorView(detail, true) : inboxView(state, Date.now(), true));
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
    } else draw();
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
    refresh();
  }, { priority: true });
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
      case "viewEvent":
      case "panelEvent": {
        if (event.type === "viewEvent" ? event.tab !== TAB : event.panel !== PANEL) return;
        if (doctor && doctor.state.target) {
          if (event.kind === "submit" && event.id === `ci-question-${doctor.state.dispatch?.token}` && event.value !== undefined) return doctor.question(event.value);
          if (event.kind === "select" && event.value !== undefined) {
            if (event.id === "ci-runs") { const run = doctor.state.evidence?.runs.find(r => String(r.id) === event.value); if (run) doctor.selectAttempt(run.id, run.attempt); }
            const attempts = /^ci-attempts-(\d+)$/.exec(event.id);
            if (attempts && /^\d+$/.test(event.value)) doctor.selectAttempt(Number(attempts[1]), Number(event.value));
            if (event.id === `ci-sessions-${doctor.state.dispatch?.token}`) doctor.selectSession(event.value);
          }
          if (event.kind !== "click") return;
          if (event.id === "ci-back") return doctor.close();
          if (event.id === "ci-refresh") return doctor.refresh();
          if (event.id === "ci-send") return doctor.send();
          if (event.id === "ci-acknowledge") return doctor.acknowledge();
          const job = /^ci-job-open-(\d+)$/.exec(event.id);
          if (job) return doctor.selectJob(Number(job[1]));
          const prepare = /^ci-prepare-(\d+)$/.exec(event.id);
          if (prepare) return doctor.prepare(Number(prepare[1]));
          return;
        }
        if (event.kind !== "click") return;
        if (event.id === "refresh" || event.id === "retry") return refresh(true);
        const detail = /^pr-(\d+)-doctor$/.exec(event.id);
        if (detail && state.inbox) {
          const pull = state.inbox.pulls.find(p => p.number === Number(detail[1]));
          if (pull) doctor?.open(state.inbox.repo, pull);
          return;
        }
        const number = mergeTarget(event.id);
        if (number !== undefined) merge(number);
        return;
      }
    }
  },
});
