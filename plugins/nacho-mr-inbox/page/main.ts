// The MR Inbox page, in the tab and the rail: draws the state the plugin posts and sends back what the
// user did. It keeps only view state (the group filter, an unsent question); the plugin runs every action
// and answers with the whole state again. GitLab data only ever goes in as text, never as HTML.

import { connect, pageHost, type PageContext } from "@alas/plugin/page";
import type { DoctorModel, Note, Option, Outcome } from "../src/doctor-view.ts";
import { agoLabel, updatedLabel, type Bucket } from "../src/inbox.ts";
import type { PageMessage, PluginMessage } from "../src/protocol.ts";
import type { CarView, Chip, InboxModel, MergedRow, Row, Section, Tone, TrainView } from "../src/view.ts";

let state: PluginMessage | undefined;
/** Shows only one group; picked from the stat tiles. */
let filter: Bucket | "merged" | undefined;
/** The question being typed, by dispatch token: survives every redraw until it is applied. */
const drafts = new Map<number, string>();
let notice: string | undefined;
/** The folds the user opened, by summary: a redraw keeps them open. */
const openFolds = new Set<string>();
const compact = () => pageHost().context.panel !== undefined;

const app = document.createElement("main");

function post(message: PageMessage): void {
  try {
    pageHost().post(message);
    notice = undefined;
  } catch (error) {
    notice = `Not sent (${(error as Error).message}); try again.`;
    render();
  }
}

type Child = Node | string | undefined | false;

/** Appends the children that are there, skipping `undefined` and `false`. */
function add(parent: HTMLElement, ...children: Child[]): void {
  for (const c of children) if (c !== undefined && c !== false) parent.append(c);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  add(node, ...children);
  return node;
}

function button(label: Child[] | string, onClick: () => void, className = "", disabled = false, title?: string): HTMLButtonElement {
  const b = el("button", `btn ${className}`, ...(typeof label === "string" ? [label] : label));
  b.type = "button";
  b.disabled = disabled;
  if (title) b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

/** A link the user clicks opens in the browser; only `https` ones are drawn as links. */
function link(label: string, url: string, className = "btn ghost", title?: string): HTMLElement {
  if (!url.startsWith("https://")) return el("span", className, label);
  const a = el("a", className, label);
  a.href = url;
  a.rel = "noreferrer";
  if (title) a.title = title;
  return a;
}

const spinner = () => el("span", "spin");

/** CI Doctor's icon: a pulse line, drawn in the text color. */
function pulseIcon(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "icon");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M1 8.5h3l2-5 3.5 9 2-4H15");
  svg.append(path);
  return svg;
}
const tone = (t: Tone | undefined) => `tone-${t ?? "text"}`;
const note = (n: Note) => el("div", `note ${tone(n.tone)}`, n.text);

function fold(summary: string, ...children: Child[]): HTMLDetailsElement {
  const d = el("details", "fold", el("summary", "", summary), ...children);
  d.open = openFolds.has(summary);
  d.addEventListener("toggle", () => (d.open ? openFolds.add(summary) : openFolds.delete(summary)));
  return d;
}

function select(options: Option[], value: string | undefined, placeholder: string | undefined, onChange: (v: string) => void): HTMLSelectElement {
  const s = el("select", "select");
  if (placeholder !== undefined && value === undefined) {
    const o = el("option", "", placeholder);
    o.value = "";
    o.disabled = true;
    s.append(o);
  }
  for (const opt of options) {
    const o = el("option", "", opt.label);
    o.value = opt.id;
    s.append(o);
  }
  s.value = value ?? "";
  s.addEventListener("change", () => onChange(s.value));
  return s;
}

/**
 * The author's GitLab avatar over their initials, which show through while it loads or when it can't, with the account
 * name on hover. `small` is the merged rows' size; `badge` marks the corner.
 */
function avatar(login: string, url: string | undefined, small = false, badge?: string): HTMLElement {
  let hash = 0;
  for (const ch of login) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
  const bot = /\[bot\]$/.test(login);
  const name = login.replace(/\[bot\]$/, "");
  const parts = name.split(/[-_.\s]+/).filter(Boolean);
  const initials = (parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2)).toUpperCase();
  const a = el("div", `avatar${small ? " small" : ""}`, el("span", "initials", initials));
  a.style.setProperty("--hue", String(hash % 360));
  a.dataset.tip = bot ? `${name} (bot)` : `@${login}`;
  a.setAttribute("aria-label", a.dataset.tip);
  if (url) {
    const img = el("img");
    img.alt = "";
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("error", () => img.remove());
    img.src = url;
    a.append(img);
  }
  if (badge) a.append(el("span", "avatar-badge", badge));
  return a;
}

// MARK: - Inbox

const TILES: { key: Bucket | "merged"; label: string; tone: Tone }[] = [
  { key: "ready", label: "Ready", tone: "success" },
  { key: "blocked", label: "Blocked", tone: "warn" },
  { key: "failing", label: "Failing", tone: "danger" },
  { key: "drafts", label: "Drafts", tone: "dim" },
  { key: "merged", label: "Merged", tone: "accent" },
];

function header(m: InboxModel): HTMLElement {
  const now = Date.now();
  const status = m.refreshing
    ? el("span", "updated", spinner(), "Refreshing…")
    : m.fetchedAt !== undefined && el("span", "updated", el("span", "pulse"), compact() ? (agoLabel(new Date(m.fetchedAt).toISOString(), now) ?? "") : `${updatedLabel(m.fetchedAt, now)} · every minute`);
  const title = el("div", "repo");
  if (m.project && !compact()) {
    const [owner, name] = m.project.split("/");
    title.append(el("span", "owner", `${owner}/`), name ?? "");
  } else title.append("MR Inbox");
  const tiles = el("div", "stats");
  for (const t of TILES) {
    const count = t.key === "merged" ? m.merged.length : m.counts[t.key];
    const tile = el("button", `stat ${tone(t.tone)}${filter === t.key ? " on" : ""}${count === 0 ? " zero" : ""}`, el("b", "", String(count)), el("small", "", t.label));
    tile.type = "button";
    tile.title = filter === t.key ? "Show every group" : `Show only ${t.label.toLowerCase()}`;
    tile.addEventListener("click", () => {
      filter = filter === t.key ? undefined : t.key;
      render();
    });
    tiles.append(tile);
  }
  const scope = el("div", "segmented");
  scope.setAttribute("role", "group");
  scope.setAttribute("aria-label", "Show");
  for (const [label, mine] of [["All", false], ["Mine", true]] as const) {
    const b = button(label, () => post({ type: "scope", mine }), `small${m.scope.mineOnly === mine ? " on" : ""}`);
    b.setAttribute("aria-pressed", String(m.scope.mineOnly === mine));
    scope.append(b);
  }
  return el("header", "hero",
    el("div", "hero-row", el("div", "logo", "⑂"), title, el("span", "grow"), status, !compact() && m.scope.available && scope, button(["⟳", !compact() && " Refresh"], () => post({ type: "refresh" }), "ghost", m.refreshing, "Refresh")),
    m.project !== undefined && !compact() && tiles,
  );
}

function checksBar(c: NonNullable<Row["progress"]>): HTMLElement {
  const bar = el("i", "bar-track");
  const part = (n: number, cls: string) => {
    const s = el("s", cls);
    s.style.width = `${(100 * n) / c.total}%`;
    return s;
  };
  bar.append(part(c.done, c.failed ? "tone-bg-danger" : "tone-bg-success"), part(c.running, "tone-bg-warn"));
  const wrap = el("span", "bar", bar, `${c.done}/${c.total}`);
  wrap.title = `${c.done} done, ${c.running} running, ${c.total - c.done - c.running} queued`;
  return wrap;
}

function carEl(c: CarView, index: number): HTMLElement {
  const title = `${index + 1}. ${c.title}`;
  const body = el(c.url?.startsWith("https://") ? "a" : "span", `car ${tone(c.tone)}${c.mine ? " mine" : ""}`, el("span", "num", `!${c.iid}`), c.mine && el("span", "you", "YOU"), el("span", "car-label", c.label));
  if (body instanceof HTMLAnchorElement) { body.href = c.url!; body.rel = "noreferrer"; }
  body.title = title;
  return body;
}

function trainStrip(t: TrainView): HTMLElement {
  if (compact()) {
    return el("section", "section", el("h4", "section-head tone-accent", el("span", "dot"), `🚂 Train → ${t.target}`, el("span", "count", String(t.cars.length))),
      ...t.cars.map((c, i) => el("div", `stop ${tone(c.tone)}${c.mine ? " mine" : ""}`, el("span", "num", String(i + 1)), c.url ? link(`!${c.iid}`, c.url, "stop-link", c.title) : el("span", "", `!${c.iid}`), c.mine && el("span", "you", "YOU"), el("span", "grow"), el("span", "when", c.label))));
  }
  const cars = el("div", "train-cars");
  t.cars.forEach((c, i) => { if (i > 0) cars.append(el("span", "coupler")); cars.append(carEl(c, i)); });
  return el("section", "train", el("span", "loco", "🚂"), el("span", "branch", t.target), cars);
}

const chip = (c: Chip) => el("span", `chip ${tone(c.tone)}`, c.text);

function row(r: Row, sectionTone: Tone): HTMLElement {
  const now = Date.now();
  const actions = el("div", "actions",
    r.doctor && button([pulseIcon(), !compact() && "CI Doctor"], () => post({ type: "doctor", iid: r.iid }), sectionTone === "danger" ? "doctor-hot" : "ghost", false, "CI Doctor"),
    link("↗", r.url, "btn ghost", "Open on GitLab"),
  );
  if (r.retry) {
    const t = r.retry;
    actions.append(t.busy
      ? button([spinner(), " Retrying…"], () => {}, "ghost", true)
      : button("↻ Retry failed", () => post({ type: "retryPipeline", pipeline: t.pipeline }), "ghost", t.disabled, "Retry the pipeline's failed jobs"));
  }
  if (r.add) {
    const a = r.add;
    actions.append(a.busy
      ? button([spinner(), " Adding…"], () => {}, "merging", true)
      : button(compact() ? a.short : a.label, () => post({ type: "add", iid: r.iid }), a.look, a.disabled));
  }
  const ago = agoLabel(r.updatedAt, now);
  return el("article", `pr ${tone(sectionTone)}${r.mine ? " mine" : ""}`,
    avatar(r.author, r.avatar),
    el("div", "pr-main",
      el("div", "pr-title", el("span", "num", `!${r.iid}`), r.title, r.mine && el("span", "you", "YOU")),
      el("div", "meta",
        !compact() && el("span", "branch", r.branch),
        r.progress && checksBar(r.progress),
        ...r.chips.map(chip),
        ago !== undefined && el("span", "when", `· ${ago}`),
      ),
      r.error !== undefined && el("div", "row-error", `⚠ ${r.error}`),
    ),
    actions,
  );
}

function section(s: Section, m: InboxModel): HTMLElement {
  const head = el("h4", `section-head ${tone(s.tone)}`, el("span", "dot"), s.title, el("span", "count", String(s.rows.length)), el("span", "grow"));
  if (s.key === "ready" && m.addAll) {
    const all = m.addAll;
    head.append(all.progress
      ? el("span", "updated tone-success", spinner(), all.progress)
      : button(all.label, () => post({ type: "addAll" }), "go small", all.disabled, "Add each ready MR one at a time, stopping at the first failure"));
  }
  return el("section", "section", head, ...s.rows.map((r) => row(r, s.tone)));
}

function mergedRow(r: MergedRow): HTMLElement {
  const ago = agoLabel(r.mergedAt, Date.now());
  return el("article", "pr merged",
    avatar(r.author, r.avatar, true, "✓"),
    el("div", "pr-main",
      el("div", "pr-title", el("span", "num", `!${r.iid}`), r.title),
      compact() && el("div", "meta", el("span", "when", ago === undefined ? `by ${r.author}` : `${ago} by ${r.author}`)),
    ),
    !compact() && el("span", "branch", r.branch),
    !compact() && el("span", "when", ago === undefined ? `by ${r.author}` : `merged ${ago} by ${r.author}`),
    link("↗", r.url, "btn ghost", "Open on GitLab"),
  );
}

function centered(...children: Child[]): HTMLElement {
  return el("div", "centered", ...children);
}

function inbox(m: InboxModel): HTMLElement[] {
  const out: HTMLElement[] = [header(m)];
  if (m.error !== undefined) out.push(el("div", "banner tone-danger", el("span", "grow", m.error), button("Retry", () => post({ type: "refresh" }), "ghost")));
  if (notice) out.push(el("div", "banner tone-warn", notice));
  if (m.loading) {
    out.push(centered(spinner(), el("span", "dim", "Loading merge requests…")));
    return out;
  }
  if (m.project === undefined) return out;
  if (!m.trainsEnabled) out.push(el("div", "banner tone-dim", "Merge trains are off for this project: buttons merge when the pipeline passes."));
  const body = el("div", "body");
  body.append(...m.trains.map(trainStrip));
  if (compact()) {
    body.append(el("section", "section", el("h4", "section-head tone-accent", el("span", "dot"), "Yours", el("span", "count", String(m.mine.length))), ...m.mine.map((r) => row(r, r.add ? "success" : r.retry ? "danger" : "warn"))),
      el("div", "dim clear-line", "Open MR Inbox from the repository menu for every MR."));
    out.push(body);
    return out;
  }
  const sections = m.sections.filter((s) => filter === undefined || filter === s.key);
  const none = m.scope.mineOnly && m.scope.hidden > 0 ? "No open merge requests of yours." : "Inbox is clear.";
  if (m.sections.length === 0 && m.merged.length === 0) body.append(centered(el("div", "clear-icon", "✓"), el("span", "dim", none)));
  else {
    if (m.sections.length === 0 && filter === undefined) body.append(el("div", "dim clear-line", none));
    body.append(...sections.map((s) => section(s, m)));
    if (m.merged.length > 0 && (filter === undefined || filter === "merged")) {
      body.append(el("section", "section", el("h4", "section-head tone-accent", el("span", "dot"), "Recently merged", el("span", "count", String(m.merged.length))), ...m.merged.map(mergedRow)));
    }
    if (filter !== undefined && body.childElementCount === 0) body.append(el("div", "dim clear-line", "Nothing in this group."));
  }
  out.push(body);
  return out;
}

// MARK: - CI Doctor

const MARKS: Record<Outcome, string> = { pass: "tone-bg-success", fail: "tone-bg-danger", other: "tone-bg-dim" };

function history(label: string, outcomes: Outcome[]): HTMLElement {
  const strip = el("div", "strip");
  for (const o of outcomes) strip.append(el("span", MARKS[o]));
  if (!outcomes.length) strip.append(el("span", "dim small", "no comparable runs"));
  return el("div", "history", el("span", "dim small", label), strip);
}

/** Dim notes fold away; warnings stay in sight. */
function notes(list: Note[], summary: string): Child[] {
  const loud = list.filter((n) => n.tone === "warn" || n.tone === "danger");
  const quiet = list.filter((n) => !loud.includes(n));
  const details = quiet.length > 0 && fold(summary, ...quiet.map(note));
  return [...loud.map(note), details];
}

function doctor(d: DoctorModel): HTMLElement[] {
  const out: HTMLElement[] = [el("header", "hero slim",
    el("div", "hero-row",
      button("← Inbox", () => post({ type: "back" }), "ghost"),
      el("div", "repo doctor-title", el("span", "num", `!${d.number}`), d.title),
      el("span", "grow"),
      !compact() && d.head !== undefined && el("span", "chip tone-dim mono", d.head.replace(/@([0-9a-f]{7})[0-9a-f]+/i, "@$1")),
      d.url !== undefined && link("↗", d.url, "btn ghost", "Open merge request"),
      button("⟳", () => post({ type: "doctorRefresh" }), "ghost", d.busy, "Refresh evidence"),
    ),
  )];
  if (notice) out.push(el("div", "banner tone-warn", notice));
  if (d.error) out.push(el("div", "banner tone-danger", d.error));
  if (d.retryError) out.push(el("div", "banner tone-danger", d.retryError));
  if (d.loading) out.push(el("div", "updated pad", spinner(), "Loading evidence…"));
  if (d.unavailable) {
    out.push(centered(el("span", "dim", d.unavailable)));
    return out;
  }
  const body = el("div", "body doctor");
  add(body, ...notes([...(d.head ? [{ text: d.head }] : []), ...(d.base ? [{ text: d.base }] : []), ...d.notes], "About this evidence"));

  const runs = el("div", "pane runs");
  if (d.runs.length) {
    add(runs,
      el("div", "label", "Pipeline"),
      select(d.runs, d.run, undefined, (v) => post({ type: "run", run: Number(v) })),
      d.attempts.length > 1 && select(d.attempts, d.attempt, undefined, (v) => post({ type: "attempt", run: Number(d.run), attempt: Number(v) })),
    );
  }
  add(runs, ...notes(d.runNotes, "Run details"));
  if (d.jobs.length) runs.append(el("div", "label", "Jobs"));
  for (const j of d.jobs) {
    const job = button([el("span", j.failed ? "tone-danger" : j.status === "success" ? "tone-success" : "dim", j.failed ? "✗" : j.status === "success" ? "✓" : "•"), el("span", "job-name", j.name), el("span", "when", j.status)],
      () => post({ type: "job", job: j.id }), `job${j.selected ? " selected" : ""}${j.failed ? " failed" : ""}`, d.historyLoading, `${j.time}\nShow failure evidence`);
    runs.append(el("div", "job-row", job,
      j.canRetry || j.retrying ? button(j.retrying ? [spinner(), " Retrying…"] : "↻ Retry", () => post({ type: "retryJob", job: j.id }), "ghost small", !j.canRetry, "Retry this job on GitLab") : undefined,
      link("↗", j.url, "btn ghost small", "Open job on GitLab")));
    if (j.failed || j.selected) for (const s of j.steps) runs.append(el("div", "step tone-danger", s));
    runs.append(...j.notes.map(note));
  }

  const ev = el("div", "pane evidence");
  const e = d.evidence;
  if (!e) ev.append(centered(el("span", "dim", d.jobs.length ? "Pick a job to see its failure evidence." : "No job selected.")));
  else {
    const job = d.jobs.find((j) => j.id === e.job);
    const excerpt = el("pre", "excerpt");
    excerpt.textContent = e.excerpt;
    const verdictTone = /regression/i.test(e.suggestion.kind) ? "warn" : /recurring/i.test(e.suggestion.kind) ? "danger" : "dim";
    add(ev,
      el("div", "evidence-head", el("b", "", e.title), el("span", "grow"), job && link("↗ Open job", job.url)),
      ...notes(e.notes, "Log details"),
      excerpt,
      e.comparing ? el("div", "updated", spinner(), "Comparing bounded MR/target history…") : el("div", "histories", history("MR", e.history.pr), history("target", e.history.base)),
      el("div", `verdict ${tone(verdictTone)}`, el("b", "", e.suggestion.kind), el("span", "", e.suggestion.text),
        e.suggestion.links.length > 0 && el("div", "links", ...e.suggestion.links.map((url, i) => link(`Supporting job ${i + 1}`, url, "btn ghost small")))),
      e.observations.length > 0 && fold(`Comparison jobs (${e.observations.length})`, ...e.observations.map((o) => el("div", "obs", el("span", "mono small", o.text), link("↗", o.url, "btn ghost small")))),
      el("div", "evidence-actions", el("span", "grow"), button("✦ Investigate…", () => post({ type: "prepare", job: e.job }), "accent", !e.canPrepare)),
    );
  }
  body.append(el("div", "split", runs, ev));
  if (d.dispatch) body.append(dispatch(d.dispatch));
  out.push(body);
  return out;
}

function dispatch(x: NonNullable<DoctorModel["dispatch"]>): HTMLElement {
  const brief = el("pre", "excerpt brief");
  brief.textContent = x.brief;
  const question = el("textarea", "question");
  question.id = `question-${x.token}`;
  question.placeholder = "Investigation question";
  question.value = drafts.get(x.token) ?? x.question;
  question.addEventListener("input", () => drafts.set(x.token, question.value));
  const apply = () => {
    post({ type: "question", token: x.token, text: question.value });
    drafts.delete(x.token);
  };
  question.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      apply();
    }
  });
  return el("section", "card dispatch",
    el("div", "evidence-head", el("b", "", "Review investigation brief"), el("span", "grow"), el("span", "dim small", "Select the text to copy it")),
    brief,
    question,
    el("div", "row-end", el("span", "dim small grow", "⌘↩ applies the question to the brief"), button("Apply question", apply, "ghost small")),
    x.sessions.length > 0 && select(x.sessions, x.session, "Select a session…", (v) => post({ type: "session", token: x.token, session: v })),
    ...x.notes.map(note),
    x.verification !== undefined && note({ text: x.verification, tone: "dim" }),
    x.mismatch && note({ text: "This checkout/repository differs from the MR head. The agent must investigate the identified commits.", tone: "warn" }),
    x.mismatch && button(x.acknowledged ? "Mismatch acknowledged" : "Acknowledge checkout mismatch", () => post({ type: "acknowledge" }), "risk", !x.canAcknowledge),
    x.progress !== undefined && el("div", "updated", spinner(), x.progress),
    x.sent && note({ text: "Sent once to the selected session.", tone: "success" }),
    el("div", "row-end", el("span", "grow"), button("✦ Send investigation", () => post({ type: "send" }), "accent", !x.canSend)),
  );
}

// MARK: - Drawing

function render(): void {
  // Keep the caret where it was in a field the redraw replaces.
  const active = document.activeElement as HTMLTextAreaElement | null;
  const focus = active?.id ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : undefined;
  const scroller = app.querySelector(".body");
  const scroll = scroller?.scrollTop ?? 0;
  const inner = [...app.querySelectorAll<HTMLElement>(".excerpt")].map((x) => x.scrollTop);
  document.body.classList.toggle("compact", compact());
  if (!state) app.replaceChildren(centered(spinner(), el("span", "dim", "Loading merge requests…")));
  else app.replaceChildren(...(state.doctor ? doctor(state.doctor) : inbox(state.inbox)));
  const next = app.querySelector(".body");
  if (next && scroller) next.scrollTop = scroll;
  app.querySelectorAll<HTMLElement>(".excerpt").forEach((x, i) => (x.scrollTop = inner[i] ?? 0));
  if (focus) {
    const field = document.getElementById(focus.id) as HTMLTextAreaElement | null;
    field?.focus();
    if (field && focus.start !== null) field.setSelectionRange(focus.start, focus.end);
  }
}

function applyTheme(context: PageContext): void {
  document.documentElement.dataset.theme = context.theme;
}

const style = document.createElement("style");
style.textContent = `
:root {
  --bg: var(--alas-background); --text: var(--alas-text); --dim: var(--alas-dim); --line: var(--alas-line);
  --accent: var(--alas-accent); --ok: var(--alas-tone-success); --warn: var(--alas-tone-warning);
  --bad: var(--alas-tone-danger); --info: var(--alas-tone-info);
  --card: color-mix(in srgb, var(--text) 4%, var(--bg));
  --card-hi: color-mix(in srgb, var(--text) 7%, var(--bg));
  --muted: color-mix(in srgb, var(--dim) 70%, var(--bg));
  --mono: ui-monospace, "SF Mono", Menlo, monospace;
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font-size: 13px; line-height: 1.4; }
main { height: 100%; display: flex; flex-direction: column; }
button, select, textarea { font: inherit; color: inherit; }
.grow { flex: 1; }
.dim { color: var(--dim); }
.icon { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
[data-theme="dark"] .excerpt { background: color-mix(in srgb, #000 30%, var(--bg)); } .small { font-size: 11px; } .mono { font-family: var(--mono); }
.tone-success { --c: var(--ok); } .tone-warn { --c: var(--warn); } .tone-danger { --c: var(--bad); }
.tone-accent { --c: var(--accent); } .tone-dim { --c: var(--muted); } .tone-text { --c: var(--text); }
.tone-bg-success { background: var(--ok); } .tone-bg-warn { background: var(--warn); }
.tone-bg-danger { background: var(--bad); } .tone-bg-dim { background: var(--muted); }

.hero { flex: none; padding: 16px 18px 14px; border-bottom: 1px solid var(--line);
  background: radial-gradient(600px 120px at 0% 0%, color-mix(in srgb, var(--accent) 20%, transparent), transparent),
    radial-gradient(400px 120px at 100% 0%, color-mix(in srgb, var(--ok) 12%, transparent), transparent); }
.hero.slim { padding: 10px 14px; }
.hero-row { display: flex; align-items: center; gap: 10px; min-width: 0; }
.logo { flex: none; width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; font-weight: 700; color: #fff;
  background: linear-gradient(135deg, var(--accent), var(--ok)); box-shadow: 0 4px 14px color-mix(in srgb, var(--accent) 35%, transparent); }
.repo { font-weight: 650; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.repo .owner { color: var(--dim); font-weight: 500; }
.doctor-title { font-size: 14px; }
.updated { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 11.5px; white-space: nowrap; }
.updated.pad { padding: 8px 18px; }
.pulse { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); animation: pulse 2s infinite; }
@keyframes pulse { from { box-shadow: 0 0 0 0 color-mix(in srgb, var(--ok) 60%, transparent); } to { box-shadow: 0 0 0 7px transparent; } }
.spin { display: inline-block; width: 12px; height: 12px; border-radius: 50%; border: 2px solid color-mix(in srgb, currentColor 25%, transparent);
  border-top-color: currentColor; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.btn { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; border: 1px solid var(--line); background: var(--card);
  border-radius: 8px; padding: 5px 10px; font-size: 12px; cursor: pointer; text-decoration: none; color: var(--text); transition: filter .12s, background .12s; }
.btn:hover:not(:disabled) { background: var(--card-hi); }
.btn:disabled { opacity: .45; cursor: default; }
.btn.ghost { background: transparent; }
.segmented { display: inline-flex; }
.segmented .btn { border-radius: 0; }
.segmented .btn:first-child { border-radius: 8px 0 0 8px; }
.segmented .btn:last-child { border-radius: 0 8px 8px 0; margin-left: -1px; }
.segmented .btn.on { background: var(--accent); color: #fff; border-color: var(--accent); font-weight: 600; position: relative; }
.btn.small { padding: 3px 8px; font-size: 11px; }
.btn.go { background: linear-gradient(180deg, color-mix(in srgb, var(--ok) 88%, #fff), var(--ok)); color: #06210f; border-color: transparent;
  font-weight: 650; box-shadow: 0 4px 14px color-mix(in srgb, var(--ok) 30%, transparent); }
.btn.go:hover:not(:disabled) { filter: brightness(1.06); background: linear-gradient(180deg, color-mix(in srgb, var(--ok) 88%, #fff), var(--ok)); }
.btn.risk { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, transparent); background: color-mix(in srgb, var(--warn) 9%, transparent); }
.btn.accent { background: var(--accent); color: #fff; border-color: transparent; font-weight: 600; }
.btn.accent:hover:not(:disabled) { background: var(--accent); filter: brightness(1.08); }
.btn.merging { color: var(--ok); }
.btn.doctor-hot { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, transparent); background: transparent; }

.stats { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; margin-top: 14px; }
.stat { position: relative; overflow: hidden; text-align: left; border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px;
  background: color-mix(in srgb, var(--card) 85%, transparent); cursor: pointer; transition: border-color .12s, background .12s; }
.stat b { display: block; font-size: 20px; line-height: 1.1; font-weight: 700; font-variant-numeric: tabular-nums; }
.stat small { color: var(--dim); font-size: 11px; }
.stat::after { content: ""; position: absolute; inset: auto 0 0 0; height: 2px; background: var(--c); }
.stat.zero b { color: var(--muted); }
.stat.on { border-color: color-mix(in srgb, var(--c) 60%, transparent); background: color-mix(in srgb, var(--c) 10%, var(--card)); }

.banner { display: flex; align-items: center; gap: 8px; margin: 10px 18px 0; padding: 8px 12px; border-radius: 8px; font-size: 12px;
  color: var(--c); background: color-mix(in srgb, var(--c) 10%, transparent); border: 1px solid color-mix(in srgb, var(--c) 35%, transparent); }
.body { flex: 1; overflow-y: auto; padding: 14px 18px 18px; display: flex; flex-direction: column; gap: 18px; }
.centered { flex: 1; display: flex; flex-direction: column; gap: 8px; align-items: center; justify-content: center; padding: 30px; color: var(--dim); }
.clear-icon { width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; font-size: 20px; color: var(--ok);
  background: color-mix(in srgb, var(--ok) 12%, transparent); }
.clear-line { padding: 2px; }

.section { display: flex; flex-direction: column; gap: 6px; }
.section-head { margin: 0 0 2px; display: flex; align-items: center; gap: 8px; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); }
.section-head .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--c); box-shadow: 0 0 8px color-mix(in srgb, var(--c) 60%, transparent); }
.section-head .count { color: var(--c); font-weight: 650; }
.section-head .btn, .section-head .updated { flex: none; text-transform: none; letter-spacing: 0; }

.pr { position: relative; display: flex; align-items: center; gap: 12px; padding: 11px 12px; background: var(--card); border: 1px solid var(--line);
  border-radius: 10px; transition: transform .12s, border-color .12s; }
.pr:hover { z-index: 1; transform: translateY(-1px); border-color: color-mix(in srgb, var(--c) 50%, var(--line)); }
.pr::before { content: ""; position: absolute; left: -1px; top: 10px; bottom: 10px; width: 3px; border-radius: 3px; background: var(--c); }
.avatar { position: relative; flex: none; width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; font-size: 10.5px; font-weight: 700; color: #fff;
  background: linear-gradient(135deg, hsl(var(--hue) 65% 52%), hsl(calc(var(--hue) + 40) 65% 42%));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--text) 10%, transparent); cursor: default; }
.avatar img { position: absolute; inset: 0; width: 100%; height: 100%; border-radius: 50%; object-fit: cover; }
.avatar.small { width: 22px; height: 22px; font-size: 9px; }
.avatar-badge { position: absolute; right: -3px; bottom: -3px; width: 12px; height: 12px; border-radius: 50%; display: grid; place-items: center;
  font-size: 8px; font-weight: 800; color: #06210f; background: var(--ok); box-shadow: 0 0 0 2px var(--bg); }
.avatar[data-tip]::after { content: attr(data-tip); position: absolute; left: -4px; top: calc(100% + 6px); z-index: 10; white-space: nowrap;
  padding: 3px 8px; border-radius: 6px; font-size: 11px; font-weight: 600; color: var(--text); background: var(--bg);
  border: 1px solid var(--line); box-shadow: 0 6px 18px rgba(0, 0, 0, .25); opacity: 0; transform: translateY(-2px);
  transition: opacity .12s, transform .12s; pointer-events: none; }
.avatar[data-tip]:hover::after { opacity: 1; transform: none; }
.pr-main { flex: 1; min-width: 0; }
.pr-title { font-weight: 560; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.num { font-family: var(--mono); color: var(--muted); font-weight: 400; margin-right: 6px; }
.meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 5px; }
.branch { font-family: var(--mono); font-size: 11px; color: var(--dim); background: color-mix(in srgb, var(--line) 55%, transparent);
  padding: 1px 6px; border-radius: 5px; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip { font-size: 11px; padding: 1px 7px; border-radius: 999px; white-space: nowrap; color: var(--c);
  border: 1px solid color-mix(in srgb, var(--c) 40%, transparent); background: color-mix(in srgb, var(--c) 10%, transparent); }
.chip.tone-dim { color: var(--dim); }
.when { font-size: 11px; color: var(--muted); white-space: nowrap; }
.bar { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--dim); font-variant-numeric: tabular-nums; }
.bar-track { display: flex; width: 90px; height: 6px; border-radius: 4px; overflow: hidden; background: color-mix(in srgb, var(--line) 80%, transparent); }
.bar-track s { display: block; height: 100%; transition: width .4s; }
.row-error { margin-top: 6px; font-size: 11.5px; color: var(--warn); background: color-mix(in srgb, var(--warn) 9%, transparent); border-radius: 6px; padding: 4px 8px; }
.actions { flex: none; display: flex; align-items: center; gap: 6px; }
.pr.merged { background: transparent; border-style: dashed; padding: 8px 12px; }
.pr.merged::before { display: none; }

.label { font-size: 10.5px; letter-spacing: .09em; text-transform: uppercase; color: var(--muted); margin: 8px 0 2px; }
.note { font-size: 11.5px; color: var(--c); }
.note.tone-dim { color: var(--dim); }
.fold summary { cursor: pointer; font-size: 11.5px; color: var(--dim); }
.fold[open] { display: flex; flex-direction: column; gap: 4px; }
.split { display: grid; grid-template-columns: minmax(220px, 280px) 1fr; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
.pane { padding: 12px; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.runs { border-right: 1px solid var(--line); background: var(--card); }
.select { width: 100%; padding: 5px 8px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); font-size: 12px; }
.job { width: 100%; justify-content: flex-start; background: transparent; border-color: transparent; }
.job-row { display: flex; align-items: center; gap: 4px; }
.job-row .btn.ghost { border-color: transparent; }
.job .job-name { flex: 1; text-align: left; overflow: hidden; text-overflow: ellipsis; }
.job .tone-danger { color: var(--bad); } .job .tone-success { color: var(--ok); }
.job.selected { background: color-mix(in srgb, var(--accent) 12%, transparent); border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
.job.selected.failed { background: color-mix(in srgb, var(--bad) 12%, transparent); border-color: color-mix(in srgb, var(--bad) 40%, transparent); }
.step { font-size: 11px; padding-left: 26px; color: var(--bad); }
.evidence-head, .row-end, .evidence-actions { display: flex; align-items: center; gap: 8px; }
.excerpt { margin: 4px 0; max-height: 320px; overflow: auto; white-space: pre-wrap; word-break: break-word; user-select: text;
  background: color-mix(in srgb, var(--text) 6%, var(--bg)); border: 1px solid var(--line); border-radius: 8px; padding: 10px;
  font: 11px/1.5 var(--mono); color: var(--text); }
.histories { display: flex; gap: 18px; flex-wrap: wrap; }
.history { display: flex; align-items: center; gap: 8px; }
.strip { display: flex; gap: 3px; } .strip > span:not(.dim) { width: 14px; height: 14px; border-radius: 3px; }
.verdict { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border-radius: 8px; font-size: 12px;
  background: color-mix(in srgb, var(--c) 10%, transparent); border: 1px solid color-mix(in srgb, var(--c) 35%, transparent); }
.verdict b { color: var(--c); text-transform: capitalize; }
.verdict.tone-dim b { color: var(--text); }
.links { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
.obs { display: flex; align-items: center; gap: 8px; justify-content: space-between; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.brief { max-height: 260px; }
.question { width: 100%; min-height: 64px; resize: vertical; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); padding: 8px; }

.train { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: var(--card); border: 1px solid var(--line); border-radius: 10px; overflow-x: auto; flex: none; }
.train .loco { font-size: 18px; }
.train-cars { display: flex; align-items: center; }
.coupler { width: 14px; height: 2px; background: var(--line); flex: none; }
.car { display: inline-flex; align-items: center; gap: 6px; padding: 4px 9px; border-radius: 8px; white-space: nowrap; font-size: 11.5px;
  color: var(--c); border: 1px solid color-mix(in srgb, var(--c) 45%, transparent); background: color-mix(in srgb, var(--c) 10%, transparent); }
.car.mine { box-shadow: 0 0 0 2px var(--accent); }
a.car { text-decoration: none; }
.you { font-size: 9px; font-weight: 750; letter-spacing: .04em; padding: 0 5px; border-radius: 4px; background: var(--accent); color: #fff; }
.pr-title .you { margin-left: 6px; }
.pr.mine { background: color-mix(in srgb, var(--accent) 8%, var(--card)); }
.stop { display: flex; align-items: center; gap: 8px; padding: 5px 4px 5px 10px; border-left: 2px solid color-mix(in srgb, var(--c) 60%, var(--line)); margin-left: 4px; font-size: 12px; }
.stop.mine .stop-link, .stop.mine > span:nth-child(2) { color: var(--accent); font-weight: 650; }
.stop-link { color: var(--text); text-decoration: none; font-family: var(--mono); }

body.compact .hero { padding: 12px 12px 10px; }
body.compact .hero.slim { padding: 8px 10px; }
body.compact .logo { width: 22px; height: 22px; font-size: 11px; border-radius: 6px; }
body.compact .repo { font-size: 13px; }
body.compact .body { padding: 10px; gap: 12px; }
body.compact .banner { margin: 8px 10px 0; }
body.compact .pr { flex-wrap: wrap; align-items: flex-start; gap: 8px; padding: 9px 10px; }
body.compact .pr.merged { align-items: center; }
body.compact .section-head { letter-spacing: .05em; white-space: nowrap; }
body.compact .avatar { width: 22px; height: 22px; font-size: 9px; }
body.compact .avatar.small { width: 18px; height: 18px; font-size: 8px; }
body.compact .pr-title { white-space: normal; font-size: 12.5px; }
body.compact .actions { width: 100%; justify-content: flex-end; }
body.compact .pr.merged .btn { margin-left: auto; }
body.compact .bar-track { width: 60px; }
body.compact .split { grid-template-columns: 1fr; }
body.compact .runs { border-right: none; border-bottom: 1px solid var(--line); }
`;
document.head.append(style);
document.body.append(app);

pageHost().onThemeChange((context) => {
  applyTheme(context);
  render();
});
applyTheme(pageHost().context);
render();
// Relative times ("2m ago") move on without a new state.
setInterval(() => {
  if (!state?.doctor) render();
}, 15_000);
connect((message) => {
  const m = message as PluginMessage;
  if (m?.type !== "state") return;
  // A dispatch that went away can't keep its unsent question.
  const token = m.doctor?.dispatch?.token;
  for (const key of drafts.keys()) if (key !== token) drafts.delete(key);
  state = m;
  render();
}, { type: "ready" } satisfies PageMessage);
