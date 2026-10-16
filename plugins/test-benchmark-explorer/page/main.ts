import { connect, pageHost } from "@alas/plugin/page";
import { same, type Selection, type State, type Summary } from "../src/model.ts";
import type { PageMessage } from "../src/protocol.ts";
import { css } from "./styles.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node;
}
function button(text: string, click: () => void, className = ""): HTMLButtonElement { const node = el("button", className, text); node.type = "button"; node.addEventListener("click", click); return node; }
function option(value: string, label: string): HTMLOptionElement { const node = el("option", "", label); node.value = value; return node; }
function post(message: PageMessage): void { try { pageHost().post(message); } catch (e) { notice.textContent = String(e); notice.className = "notice danger"; } }
const fmt = (v: unknown): string => typeof v === "number" && Number.isFinite(v) ? new Intl.NumberFormat(undefined, { maximumSignificantDigits: 5 }).format(v) : "unknown";
const date = (v: unknown): string => typeof v === "number" && Number.isFinite(v) ? new Date(v * 1000).toLocaleString() : "unknown";
const json = (v: unknown): string => JSON.stringify(v, null, 2) ?? "unknown";
const tone = (v: string): string => v === "passed" || v === "current" ? "success" : ["failed", "error", "stale", "changed during run", "incomplete"].includes(v) ? "danger" : "dim";
const badge = (value: string, label = value): HTMLElement => el("span", `badge ${tone(value)}`, label);
const style = el("style"); style.textContent = css; document.head.append(style);
const header = el("header"); header.append(el("h1", "", "Test & Benchmark Explorer"), button("Refresh", () => post({ type: "refresh" })), button("Configure", () => { configuration.open = !configuration.open; configuration.scrollIntoView({ block: "nearest" }); }));
const notice = el("div", "notice"); notice.setAttribute("role", "status");
const layout = el("div", "layout"), aside = el("aside"), main = el("main");
const host = el("div", "host"), history = el("div"), metadata = el("section"), toolbar = el("div", "row"), rows = el("section"), pagination = el("div", "row pagination");
aside.append(el("h2", "", "Imported runs"), host, history); main.append(metadata, toolbar, rows, pagination); layout.append(aside, main); document.body.replaceChildren(header, notice, layout);
let state: State = { schema: 1, config: { profiles: [] }, runs: [] };
let worktrees: { id: string; branch: string; current: boolean }[] = [];
let kind: "tests" | "benchmarks" = "tests", offset = 0, next: number | null = null;
let pageRows: any[] = [], currentEvidence: any[] = [];
let selectedTests = new Set<number>();
let selectedBenchmarks = new Set<number>();
let selection: Selection | undefined;
const previousOffsets: number[] = [];
const requestQuery = (): void => post({ type: "query", kind, search: search.value, status: filter.value, offset, compare: compare.checked });
const resetQuery = (): void => { offset = 0; previousOffsets.length = 0; requestQuery(); };
const testsButton = button("Tests", () => { kind = "tests"; resetQuery(); });
const benchmarksButton = button("Benchmarks", () => { kind = "benchmarks"; resetQuery(); });
const search = el("input"); search.type = "search"; search.placeholder = "Search suite or test name"; search.setAttribute("aria-label", "Search results");
let searchTimer: number | undefined;
search.addEventListener("input", () => { if (searchTimer !== undefined) clearTimeout(searchTimer); searchTimer = window.setTimeout(resetQuery, 250); });
const filter = el("select"); filter.setAttribute("aria-label", "Test result filter"); for (const status of ["all", "failed", "error", "passed", "skipped", "unknown"]) filter.append(option(status, status === "all" ? "All results" : status)); filter.addEventListener("change", resetQuery);
const compare = el("input"); compare.type = "checkbox"; compare.addEventListener("change", resetQuery);
const compareLabel = el("label"); compareLabel.append(compare, document.createTextNode("Compare"));
toolbar.append(testsButton, benchmarksButton, search, filter, compareLabel, button("Investigation brief", () => post({ type: "brief", selected: [...selectedTests], selectedBenchmarks: [...selectedBenchmarks] })));

const configuration = el("details", "config"); const configSummary = el("summary", "", "Configuration and import");
const configBody = el("div"), configText = el("textarea"); configText.setAttribute("aria-label", "Project capture configuration JSON"); configText.spellcheck = false;
configText.value = json({ profiles: [{ id: "swift-tests", script: "repo:tests.sh", target: "macOS", toolchain: "Xcode 27.0", configuration: "Debug", artifacts: [{ path: "Tests.xcresult", format: "xcresult" }] }] });
let configDraft = false;
configText.addEventListener("input", () => { configDraft = true; });
const worktreePicker = el("select"); worktreePicker.setAttribute("aria-label", "Owning worktree for installation or import");
const invocation = el("pre", "dim");
const configActions = el("div", "row"); configActions.append(button("Save configuration", () => { configDraft = false; post({ type: "configure", json: configText.value }); }, "primary"), worktreePicker, button("Install/update wrapper", () => post({ type: "install", worktree: worktreePicker.value })));
const manualPath = el("input"); manualPath.placeholder = "Existing artifact path, relative to worktree"; manualPath.setAttribute("aria-label", "Manual import path");
const manualFormat = el("select"); manualFormat.setAttribute("aria-label", "Artifact format"); for (const [value, label] of [["junit", "JUnit XML"], ["xcresult", "Xcode xcresult"], ["benchmark", "Benchmark JSON"]]) manualFormat.append(option(value, label));
const directory = el("input"); directory.type = "checkbox"; const directoryLabel = el("label"); directoryLabel.append(directory, document.createTextNode("Report directory"));
const importRow = el("div", "row"); importRow.append(manualPath, manualFormat, directoryLabel, button("Import", () => post({ type: "manual", worktree: worktreePicker.value, path: manualPath.value.trim(), format: manualFormat.value as "junit", directory: directory.checked })));
configBody.append(el("p", "dim", "Configure paths relative to each capture's fresh output directory. Install the bundled Python wrapper explicitly in each worktree. Python 3.9+ and Alas API 16 are required on the execution host."), configText, configActions, invocation, el("h3", "", "Import an existing artifact"), el("p", "dim", "Existing reports retain unknown source provenance and no run association. Manual imports never inherit today's HEAD."), importRow);
configuration.append(configSummary, configBody); main.append(configuration);

const dialog = el("dialog"), dialogTitle = el("h2"), dialogText = el("textarea"), dialogActions = el("div", "row"); dialogText.readOnly = true;
dialogText.setAttribute("aria-label", "Copyable investigation or evidence text");
let evidenceRequest: { rowIndex: number; kind: "tests" | "benchmarks"; offset: number } | undefined;
const moreEvidence = button("Load more evidence", () => { if (evidenceRequest) post({ type: "evidence", ...evidenceRequest }); }); moreEvidence.classList.add("hidden");
dialogActions.append(button("Select text", () => { dialogText.focus(); dialogText.select(); }), moreEvidence, button("Close", () => dialog.close())); dialog.append(dialogTitle, dialogText, dialogActions); document.body.append(dialog);
function showText(title: string, text: string): void { dialogTitle.textContent = title; dialogText.value = text; if (!dialog.open) dialog.showModal(); }

function renderState(): void {
  host.textContent = `Execution host ${state.runs.find(r => same(r, state.selected))?.hostKey ?? "selected project's host"}`;
  history.replaceChildren();
  if (!state.runs.length) history.append(el("p", "dim", "No imported results yet."));
  const names = new Map(worktrees.map(w => [w.id, w.branch]));
  for (const run of state.runs) {
    const node = button("", () => { compare.checked = false; offset = 0; post({ type: "select", id: run.id, worktree: run.worktree }); }, `run${same(run, state.selected) ? " selected" : ""}`);
    node.append(el("strong", "", run.script ?? "Manual import"), el("small", "", `${names.get(run.worktree) ?? run.worktree} · ${run.host || run.hostKey}`), el("small", "", date(run.capturedAt)), badge(String(run.counts.state)), badge(run.source.state));
    if (same(run, state.baseline)) node.append(badge("baseline"));
    history.append(node);
  }
  const oldOwner = worktreePicker.value;
  worktreePicker.replaceChildren(...worktrees.map(w => option(w.id, w.branch)));
  worktreePicker.value = worktrees.some(w => w.id === oldOwner) ? oldOwner : state.selected?.worktree ?? worktrees.find(w => w.current)?.id ?? worktrees[0]?.id ?? "";
  if (!configDraft && document.activeElement !== configText && state.config.profiles.length) configText.value = json(state.config);
  invocation.textContent = state.config.profiles.length ? state.config.profiles.map(p => `# ${p.script}\nexec python3 "$ALAS_WORKTREE_ROOT/.alas/test-benchmark-explorer/capture.py" capture --profile ${p.id} -- /bin/sh -c 'exec YOUR_COMMAND_USING_ALAS_RESULTS_DIR'`).join("\n\n") : "Save a capture profile, then install the wrapper. Direct runner output to ALAS_RESULTS_DIR inside the wrapped command.";
  renderMetadata();
}

function renderMetadata(): void {
  metadata.replaceChildren(); const run = state.runs.find(r => same(r, state.selected));
  toolbar.classList.toggle("hidden", !run);
  if (!run) { metadata.append(el("h2", "", "Keep results tied to their source"), el("p", "empty", "Import an existing JUnit, xcresult or benchmark artifact below, or configure a capture wrapper for an Alas run script. Select a result to inspect failures, measurements and provenance.")); return; }
  metadata.append(el("h2", "", run.script ?? "Manual import"));
  const badges = el("div", "row"); badges.append(badge(String(run.counts.state)), badge(run.command.outcome, `Command ${run.command.outcome}`), badge(run.source.state, `Source ${run.source.state}`)); metadata.append(badges);
  const meta = el("dl", "meta");
  const add = (label: string, value: string): void => { meta.append(el("dt", "", label), el("dd", "", value)); };
  add("Results", `${run.counts.tests} logical tests · ${run.counts.attempts} attempts · ${run.counts.benchmarks} measurements`);
  add("Worktree / host", `${worktrees.find(w => w.id === run.worktree)?.branch ?? run.worktree} / ${run.host || run.hostKey}`);
  add(run.script ? "Captured" : "Imported", date(run.capturedAt)); add("Run identity", run.run ?? "Unassociated manual import");
  add("Source", `${run.source.state}${run.source.head ? ` · ${run.source.head.slice(0, 12)}` : ""}${run.source.checkedAt ? ` · checked ${date(run.source.checkedAt)}` : ""}`);
  if (run.source.reason) add("Source evidence", run.source.reason);
  const command = run.command.argv.join(" ") || "unknown";
  const commandTerm = el("dt", "", run.command.truncated ? "Command preview" : "Command"), commandValue = el("dd");
  if (command.length > 160) { const disclosure = el("details"); disclosure.append(el("summary", "", `${command.slice(0, 90)}…${run.command.exit !== undefined ? ` · exit ${run.command.exit}` : ""}`), el("pre", "", command)); commandValue.append(disclosure); }
  else commandValue.textContent = `${command}${run.command.exit !== undefined ? ` · exit ${run.command.exit}` : ""}`;
  meta.append(commandTerm, commandValue);
  add("Conditions", ["toolchain", "configuration", "target"].map(k => `${k} ${run.conditions?.[k] ?? "unknown"}`).join(" · "));
  if (run.detail !== "available") add("Retained detail", run.detail);
  for (const issue of run.issues) add("Import issue", `${issue.path ? issue.path + ": " : ""}${issue.message}`);
  metadata.append(meta);
  const baselineRow = el("div", "row"), picker = el("select"); picker.setAttribute("aria-label", "Comparison baseline"); picker.append(option("", "Choose a baseline…"));
  for (const r of state.runs) picker.append(option(json({ id: r.id, worktree: r.worktree }), `${r.script ?? "Manual import"} · ${date(r.capturedAt)} · ${worktrees.find(w => w.id === r.worktree)?.branch ?? r.worktree}`));
  picker.value = state.baseline ? json(state.baseline) : "";
  picker.addEventListener("change", () => picker.value ? post({ type: "baseline", ...JSON.parse(picker.value) }) : post({ type: "clearBaseline" }));
  baselineRow.append(el("span", "dim", "Baseline"), picker); metadata.append(baselineRow);
  compare.disabled = !state.baseline; if (!state.baseline) compare.checked = false;
}

function evidenceButton(row: any): HTMLButtonElement {
  return button("Full evidence", () => { evidenceRequest = { rowIndex: row.rowIndex, kind, offset: 0 }; moreEvidence.classList.add("hidden"); showText("Original normalized evidence", "Loading…"); post({ type: "evidence", ...evidenceRequest }); });
}

function renderTests(comparing: boolean): void {
  let suite = "";
  for (const row of pageRows) {
    if (comparing) {
      const node = el("details", "test"), summary = el("summary"); summary.append(el("span", "name", row.name ?? row.id), badge(row.change));
      if (typeof row.durationDelta === "number") summary.append(el("span", "dim", `${row.durationDelta >= 0 ? "+" : ""}${fmt(row.durationDelta)} s`));
      node.append(summary, el("pre", "dim", `Baseline ${row.baseline?.status ?? "absent/unknown"}, current ${row.current?.status ?? "absent/unknown"}\n${json(row)}`)); rows.append(node); continue;
    }
    const group = (row.suite ?? []).join(" / "); if (group !== suite) { suite = group; rows.append(el("div", "suite", suite || "Tests")); }
    const node = el("details", "test"), summary = el("summary"); summary.append(el("span", "name", row.name ?? row.id), badge(row.status ?? "unknown"));
    summary.append(el("span", "dim", typeof row.duration === "number" ? `${fmt(row.duration)} s` : "duration unknown"));
    const body = el("div", "test-body");
    if (row.attempt) body.append(el("div", "dim", row.attempt.ordered ? `Attempt ${Number(row.attempt.order) + 1}` : "Attempt order unknown; failures are preserved"));
    if (row.source) body.append(el("pre", "", `${row.source.path}${row.source.line ? ":" + row.source.line : ""}`));
    if (row.failure) body.append(el("pre", "", row.failure));
    if (row.textTruncated || row.evidenceTooLarge) body.append(el("p", "warning", "This preview is truncated. Open full evidence for retained text."));
    const actions = el("div", "row"), include = el("input"); include.type = "checkbox"; include.checked = selectedTests.has(row.rowIndex);
    include.addEventListener("change", () => include.checked ? selectedTests.add(row.rowIndex) : selectedTests.delete(row.rowIndex));
    const label = el("label"); label.append(include, document.createTextNode("Include in brief")); actions.append(label, evidenceButton(row)); body.append(actions, el("pre", "dim", json(row.evidence)));
    node.append(summary, body); rows.append(node);
  }
}

function renderBenchmarks(comparing: boolean): void {
  const table = el("table"), head = el("tr");
  for (const label of comparing ? ["Benchmark / metric", "Baseline", "Current", "Absolute Δ", "% Δ", "Conditions / samples"] : ["Benchmark / metric", "Value", "Unit / direction", "Statistic / samples", "Evidence"]) head.append(el("th", "", label));
  table.append(head);
  for (const row of pageRows) {
    const tr = el("tr"), identity = el("td"); identity.append(el("strong", "", row.id), el("pre", "dim", `${row.metric}\n${json(row.parameters ?? {})}`)); tr.append(identity);
    const cell = (text: string, className = ""): void => { tr.append(el("td", className, text)); };
    if (comparing) {
      cell(`${fmt(row.baseline)} ${row.unit}`, "number"); cell(`${fmt(row.current)} ${row.unit}`, "number");
      cell(row.compatible ? `${fmt(row.absolute)} ${row.unit}` : "incompatible", "number"); cell(row.compatible && row.percent !== null ? `${fmt(row.percent)}%` : "unavailable", "number");
      const detail = el("td"); detail.append(el("div", row.compatible ? "dim" : "warning", row.reason ?? `${row.direction} is better · ${row.statistic ?? "statistic unknown"}`), el("div", "dim", `Samples ${row.baselineSampleCount ?? row.baselineSamples?.length ?? "unknown"} / ${row.currentSampleCount ?? row.currentSamples?.length ?? "unknown"}. Significance not assessed.`));
      if (row.threshold !== undefined) detail.append(el("div", row.regression ? "danger" : "dim", `Threshold ${row.threshold}% · ${row.regression ? "regression" : "within threshold"}`));
      const more = el("details"); more.append(el("summary", "dim", "Execution conditions"), el("pre", "", json(row.conditions))); detail.append(more); tr.append(detail);
    } else {
      cell(fmt(row.value), "number"); cell(`${row.unit} · ${row.direction} is better`); cell(`${row.statistic ?? "unknown"} · ${row.sampleCount ?? row.samples?.length ?? "unknown"} samples`);
      const evidence = el("td"), include = el("input"); include.type = "checkbox"; include.checked = selectedBenchmarks.has(row.rowIndex); include.setAttribute("aria-label", `Include ${row.id} in brief`);
      include.addEventListener("change", () => include.checked ? selectedBenchmarks.add(row.rowIndex) : selectedBenchmarks.delete(row.rowIndex)); evidence.append(include, evidenceButton(row)); tr.append(evidence);
    }
    table.append(tr);
  }
  rows.append(table);
}

function renderDetail(message: any): void {
  if (!same(message.selection, state.selected)) return;
  rows.replaceChildren(); pagination.replaceChildren(); pageRows = message.page?.rows ?? []; currentEvidence = message.evidence ?? [];
  const comparing = message.query?.compare === true;
  kind = message.query?.kind ?? kind; compare.checked = comparing; filter.disabled = kind === "benchmarks" || comparing;
  offset = message.page?.offset ?? 0;
  if (document.activeElement !== search) search.value = message.query?.search ?? search.value;
  filter.value = message.query?.status ?? "all";
  testsButton.className = kind === "tests" ? "primary" : ""; benchmarksButton.className = kind === "benchmarks" ? "primary" : "";
  if (!pageRows.length) rows.append(el("p", "empty", "No matching results. A successful command with zero tests does not establish passing tests."));
  else kind === "tests" ? renderTests(comparing) : renderBenchmarks(comparing);
  for (const artifact of currentEvidence) if (artifact.state !== "available") rows.append(el("p", "warning", `Evidence ${artifact.state}: ${artifact.path}${artifact.reason ? " · " + artifact.reason : ""}`));
  next = message.page?.next ?? null;
  const previous = button("Previous", () => { offset = previousOffsets.pop() ?? 0; requestQuery(); }); previous.disabled = offset === 0;
  const following = button("Next", () => { if (next !== null) { previousOffsets.push(offset); offset = next; requestQuery(); } }); following.disabled = next === null;
  pagination.append(previous, el("span", "dim", `${pageRows.length ? offset + 1 : 0}–${offset + pageRows.length} of ${message.page?.total ?? 0}`), following);
}

connect((message: any) => {
  if (message?.type === "state") {
    const changed = !same(selection, message.state.selected);
    state = message.state; worktrees = message.worktrees ?? [];
    if (changed) { selectedTests = new Set(); selectedBenchmarks = new Set(); offset = 0; previousOffsets.length = 0; selection = state.selected; }
    notice.textContent = message.error ?? message.status ?? (message.saving ? "Saving…" : ""); notice.className = message.error ? "notice danger" : "notice dim";
    renderState();
  } else if (message?.type === "loading" && same(message.selection, state.selected)) { rows.replaceChildren(el("p", "empty", "Loading structured results…")); pagination.replaceChildren(); }
  else if (message?.type === "detail") renderDetail(message);
  else if (message?.type === "error") { notice.textContent = message.message; notice.className = "notice danger"; rows.replaceChildren(el("p", "empty", "Result detail is unavailable. The retained summary and its provenance remain in history.")); }
  else if (message?.type === "brief" && same(message.selection, state.selected)) { evidenceRequest = undefined; moreEvidence.classList.add("hidden"); showText("Investigation brief · use ⌘C to copy", message.text); }
  else if (message?.type === "evidence" && same(message.selection, state.selected) && evidenceRequest && evidenceRequest.rowIndex === message.rowIndex) {
    showText("Original normalized evidence", evidenceRequest.offset === 0 ? message.text : dialogText.value + message.text);
    if (message.next !== null) { evidenceRequest.offset = message.next; moreEvidence.classList.remove("hidden"); } else moreEvidence.classList.add("hidden");
  }
}, { type: "ready" });
