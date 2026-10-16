import { definePlugin, processRun, renderPanel, requestSnapshot, storageGet, storageSet, webPost, setTimer, cancelTimer, type Event, type Node, type Worktree } from "@alas/plugin";
import { HELPER } from "./helper-source.ts";
import { emptyState, object, parseConfig, remember, restoreState, same, serializeState, type Selection, type Summary } from "./model.ts";
import { pageMessage } from "./protocol.ts";

const KEY = "explorer-v1";
let state = emptyState();
let project = "", hostKey = "local", epoch = 0, generation = 0, loaded = false, snapshotReady = false, shown = false;
let pendingFinished: Extract<Event, { type: "runFinished" }>[] = [];
let loadID: number | undefined, saveID: number | undefined, dirtySave = false;
let worktrees: Worktree[] = [];
let error: string | undefined, status: string | undefined;
let query = { kind: "tests", search: "", status: "all", offset: 0, compare: false };
let lastDetail: { selection: Selection; message: Record<string, unknown> } | undefined;
const reports = new Set<string>();
const reportErrors = new Map<string, string>();
type Job = { worktree: string; args: Record<string, unknown>; done: (result: Record<string, any>) => void; fail?: (message: string) => void; generation?: number; epoch: number };
let jobs: Job[] = [], busy = false;

function post(message: unknown): void { webPost(0, message); }
function fail(message: string): void { error = message; post({ type: "error", message }); }
function publish(): void { post({ type: "state", state, worktrees: worktrees.map(w => ({ id: w.id, branch: w.branch, current: w.current })), hostKey, saving: saveID !== undefined, error, status }); drawReports(); }
function save(): void {
  if (saveID !== undefined) { dirtySave = true; return; }
  try { saveID = storageSet(KEY, JSON.parse(serializeState(state))); }
  catch (e) { fail(String(e)); }
}

function enqueue(worktree: string, args: Record<string, unknown>, done: Job["done"], options: { fail?: Job["fail"]; generation?: number } = {}): void {
  if (jobs.length >= 100) return fail("Explorer is busy. Open the completed run report to recover a skipped import.");
  jobs.push({ worktree, args, done, ...options, epoch });
  pump();
}

function pump(): void {
  if (busy || !loaded || !snapshotReady) return;
  const job = jobs.shift();
  if (!job) return;
  if (job.epoch !== epoch || job.generation !== undefined && job.generation !== generation) return pump();
  if (!worktrees.some(w => w.id === job.worktree)) { (job.fail ?? fail)("The owning worktree is unavailable."); return pump(); }
  busy = true;
  const identity = { project, worktree: job.worktree, hostKey };
  processRun("helper", job.worktree, { stdin: JSON.stringify({ program: HELPER, request: { ...job.args, ...identity } }) }, ({ result, error: rpcError }) => {
    if (job.epoch !== epoch) return;
    busy = false;
    if (job.generation !== undefined && job.generation !== generation) return pump();
    try {
      if (rpcError) throw new Error(rpcError.message);
      if (result.timedOut || result.truncated) throw new Error(`Helper output was ${result.timedOut ? "timed out" : "truncated"}; no result was accepted.`);
      if (result.exit !== 0) throw new Error(`Could not run the on-host Python helper: ${result.stderr.slice(0, 2048) || `exit ${result.exit}`}. Install Python 3.9+ on ${hostKey}.`);
      if (result.stdout.length > 128 * 1024) throw new Error("Helper output exceeds the transport limit.");
      const reply = JSON.parse(result.stdout);
      if (!object(reply) || reply.ok !== true || !object(reply.result)) throw new Error(object(reply) && typeof reply.error === "string" ? reply.error : "Malformed helper reply");
      job.done(reply.result);
    } catch (e) { (job.fail ?? fail)(e instanceof Error ? e.message : String(e)); }
    pump();
  });
}

function accept(value: unknown, worktree: string): Summary { return remember(state, value, project, worktree, hostKey); }
function refreshWorktree(worktree: string, offset = 0): void {
  if (!offset) for (const run of state.runs) if (run.worktree === worktree && run.source.state === "current") run.source = { ...run.source, state: "unknown", reason: "Verifying current source…" };
  enqueue(worktree, { operation: "list", offset, pinned: [state.selected, state.baseline].filter(s => s?.worktree === worktree).map(s => s!.id) }, result => {
    if (!Array.isArray(result.summaries)) throw new Error("Malformed history reply");
    for (const summary of result.summaries) accept(summary, worktree);
    save(); publish();
    if (result.next !== undefined && result.next !== null) {
      if (!Number.isInteger(result.next) || result.next <= offset || result.next > 40) throw new Error("History pagination did not advance within its budget");
      refreshWorktree(worktree, result.next);
    }
  });
}
function refresh(): void {
  for (const worktree of worktrees) refreshWorktree(worktree.id);
  publish();
}
function verifySource(): void {
  const selected = state.selected;
  if (!selected) return;
  refreshWorktree(selected.worktree); publish();
}

let foreign: { baseline: Selection; current: Selection; token: string } | undefined;
function withBaseline(current: Selection, gen: number, callback: (args: Record<string, unknown>) => void): void {
  const baseline = state.baseline;
  if (!baseline) return callback({});
  if (baseline.worktree === current.worktree) return callback({ baseline: baseline.id });
  if (foreign && same(foreign.baseline, baseline) && same(foreign.current, current)) return callback({ foreignBaseline: foreign.token });
  const token = `${Date.now().toString(16).padStart(16, "0")}${(++transferID).toString(16).padStart(16, "0")}`;
  const transfer = (offset: number): void => enqueue(baseline.worktree, { operation: "export", capture: baseline.id, offset }, exported => {
    if (typeof exported.chunk !== "string" || exported.offset !== offset) throw new Error("Malformed baseline export");
    enqueue(current.worktree, { operation: "stage", token, chunk: exported.chunk, offset }, () => {
      if (exported.next !== null) { if (!Number.isInteger(exported.next) || exported.next <= offset) throw new Error("Baseline export did not advance"); return transfer(exported.next); }
      foreign = { baseline, current, token };
      callback({ foreignBaseline: token });
    }, { generation: gen });
  }, { generation: gen });
  transfer(0);
}
let transferID = 0;

function loadSelected(): void {
  const selected = state.selected;
  if (!selected) return;
  const gen = ++generation;
  lastDetail = undefined;
  post({ type: "loading", selection: selected });
  const load = (baseline: Record<string, unknown>): void => enqueue(selected.worktree,
    { operation: query.compare ? "compare" : "detail", capture: selected.id, ...query, ...baseline }, result => {
      if (result.summary) { accept(result.summary, selected.worktree); save(); }
      const message = { type: "detail", selection: selected, query, ...result };
      lastDetail = { selection: selected, message };
      post(message);
    }, { generation: gen });
  query.compare ? withBaseline(selected, gen, load) : load({});
}

function imported(worktree: string, run: string, script?: string, outcome?: string, exit?: number, select = false): void {
  enqueue(worktree, { operation: "importRun", run, ...(script ? { script } : {}), ...(outcome ? { outcome } : {}) }, result => {
    if (!object(result.summary) || result.summary.run !== run) throw new Error("Capture belongs to another run.");
    const summary = accept(result.summary, worktree);
    reportErrors.delete(run);
    if (outcome && (outcome === "stopped" || outcome === "unknown")) { summary.command.outcome = outcome; summary.complete = false; summary.counts.state = "incomplete"; }
    if (select) { state.selected = { id: summary.id, worktree }; query.offset = 0; }
    save(); publish();
    if (select) loadSelected();
  }, { fail: message => {
    reportErrors.set(run, message);
    if (outcome && /^[a-f0-9-]{36}$/i.test(run)) accept({ schema: 1, id: run.replace(/-/g, "").toLowerCase(), project, worktree, hostKey, host: hostKey,
      run, script, capturedAt: Date.now() / 1000, complete: false, detail: "unavailable", counts: {}, source: { state: "unknown" },
      command: { outcome, exit, argv: [] }, issues: [{ message }] }, worktree);
    save(); publish(); if (select) fail(message);
  } });
}

function finishRun(event: Extract<Event, { type: "runFinished" }>): void {
  if (!loaded || !snapshotReady) {
    if (pendingFinished.length < 100) pendingFinished.push(event);
    else fail("Too many run completions arrived during restoration. Open a completed report to recover its capture.");
    return;
  }
  if (state.config.profiles.some(p => p.script === event.script)) imported(event.worktree, event.run, event.script, event.outcome, event.exitCode);
}
function drainFinished(): void {
  if (!loaded || !snapshotReady) return;
  const events = pendingFinished; pendingFinished = [];
  for (const event of events) finishRun(event);
}

function drawReports(): void {
  const text = (id: string, value: string): Node => ({ kind: "text", id, text: value });
  for (const run of reports) {
    const summary = state.runs.find(r => r.run === run);
    renderPanel("report", { kind: "vstack", id: "root", spacing: 4, children: summary ? [
      text("counts", `${summary.counts.tests} tests · ${summary.counts.attempts} attempts · ${summary.counts.benchmarks} measurements · ${summary.counts.state}`),
      text("source", `Source ${summary.source.state}. Command ${summary.command.outcome}.`),
      text("open", "Open Test & Benchmark Explorer from this report's menu to inspect evidence.")
    ] : [text("missing", reportErrors.get(run) ?? "No validated capture imported. A configured API 16 capture wrapper is required.")] }, { run });
  }
}

function handlePage(value: unknown): void {
  const message = pageMessage(value);
  if (!message) return;
  if (message.type === "ready") { publish(); if (lastDetail && same(lastDetail.selection, state.selected)) post(lastDetail.message); else if (state.selected) loadSelected(); return; }
  if (message.type === "refresh") { error = undefined; refresh(); return; }
  if (message.type === "select" || message.type === "baseline") {
    if (!state.runs.some(r => same(r, message))) return fail("That capture is no longer in the retained index.");
    if (message.type === "select") { state.selected = { id: message.id, worktree: message.worktree }; query.offset = 0; }
    else { state.baseline = { id: message.id, worktree: message.worktree }; foreign = undefined; }
    save(); publish(); loadSelected(); return;
  }
  if (message.type === "clearBaseline") { state.baseline = undefined; query.compare = false; foreign = undefined; save(); publish(); loadSelected(); return; }
  if (message.type === "configure") {
    try { state.config = parseConfig(JSON.parse(message.json)); error = undefined; save(); publish(); status = "Configuration saved. Install/update the wrapper in each worktree to apply it."; publish(); }
    catch (e) { fail(String(e)); }
    return;
  }
  if (message.type === "install") return enqueue(message.worktree, { operation: "install", config: state.config }, () => { status = "Capture wrapper installed on the owning host. Add the shown invocation to your run script."; publish(); });
  if (message.type === "manual") return enqueue(message.worktree, { operation: "manual", specs: [{ path: message.path, format: message.format, directory: message.directory }] }, result => {
    const summary = accept(result.summary, message.worktree); state.selected = { id: summary.id, worktree: message.worktree }; save(); publish(); loadSelected();
  });
  if (message.type === "query") { query = { kind: message.kind, search: message.search, status: message.status, offset: message.offset, compare: message.compare }; if (query.compare && !state.baseline) return fail("Choose a baseline first."); loadSelected(); return; }
  if (message.type === "evidence" && state.selected) {
    const selected = state.selected, gen = generation;
    return enqueue(selected.worktree, { operation: "evidence", capture: selected.id, rowIndex: message.rowIndex, kind: message.kind, offset: message.offset }, result => post({ type: "evidence", selection: selected, rowIndex: message.rowIndex, ...result }), { generation: gen });
  }
  if (message.type === "brief" && state.selected) {
    const selected = state.selected, gen = generation;
    return withBaseline(selected, gen, baseline => enqueue(selected.worktree, { operation: "brief", capture: selected.id, selected: message.selected, selectedBenchmarks: message.selectedBenchmarks, ...baseline }, result => post({ type: "brief", selection: selected, ...result }), { generation: gen }));
  }
}

definePlugin({ handle(event: Event) {
  switch (event.type) {
    case "activate": epoch++; generation++; jobs = []; busy = false; loaded = snapshotReady = false; pendingFinished = []; saveID = undefined; dirtySave = false; foreign = undefined; lastDetail = undefined; error = status = undefined; reports.clear(); reportErrors.clear(); project = event.projectId; hostKey = event.host ?? "local"; state = emptyState(); worktrees = []; loadID = storageGet(KEY); requestSnapshot(); return;
    case "deactivate": epoch++; jobs = []; return;
    case "stored":
      if (event.id !== loadID) return;
      try { if (event.error) throw new Error(event.error.message); state = restoreState(event.value); } catch (e) { fail(`Could not restore explorer state: ${String(e)}`); }
      loaded = true; publish(); drainFinished(); pump(); if (snapshotReady) refresh(); return;
    case "snapshot": case "workspaceChanged": worktrees = event.snapshot.worktrees; snapshotReady = true; publish(); drainFinished(); pump(); if (loaded) refresh(); return;
    case "reply": if (event.id === saveID) { saveID = undefined; if (event.error) { dirtySave = false; fail(`Could not save explorer state: ${event.error.message}`); } else if (dirtySave) { dirtySave = false; save(); } } return;
    case "webMessage": if (event.tab === 0) handlePage(event.message); return;
    case "tabVisible": if (event.tab === 0) { shown = event.visible; shown ? setTimer("source", 60, true) : cancelTimer("source"); if (shown && loaded) { verifySource(); publish(); } } return;
    case "timer": if (event.id === "source" && shown) verifySource(); return;
    case "gitChanged": if (shown && state.selected?.worktree === event.worktree) verifySource(); return;
    case "runFinished": return finishRun(event);
    case "command": if (event.target.kind === "runReport") imported(event.target.worktree, event.target.run, undefined, undefined, undefined, true); else publish(); return;
    case "panelVisible": if (event.panel === "report" && event.run) { event.visible ? reports.add(event.run) : reports.delete(event.run); drawReports(); } return;
  }
} });
