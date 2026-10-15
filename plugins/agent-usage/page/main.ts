// The Agent Usage page: draws the aggregates the plugin posts. It has no network and keeps nothing; on
// start it asks for the last query (`ready`), and the toggles ask for another (`load`).
// Charts are hand-rolled SVG, colored by the Alas theme's CSS variables.

import { connect, pageHost, type PageContext } from "@alas/plugin/page";
import type { Day, LimitRow, PageMessage, PluginMessage, Range, Row, Scope, Summary, Tally, Tokens } from "../src/usage.ts";

/** In the right rail the page is narrow: just the cards and the token chart. */
const rail = pageHost().context.panel !== undefined;

type Metric = keyof Tokens;
type State =
  | { kind: "waiting" }
  | { kind: "loading"; range: Range; scope: Scope }
  | { kind: "error"; range: Range; scope: Scope; message: string }
  | { kind: "usage"; summary: Summary };

let state: State = { kind: "waiting" };
let metric: Metric = "total";

/** Categorical slots, fixed order, stepped for each surface. Agents past the seventh share the last, as "Other". */
const SERIES = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#8a8a85"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#8a8a85"],
};
const OTHER = "Other";

const SVG = "http://www.w3.org/2000/svg";
const app = document.createElement("main");
if (rail) app.classList.add("compact");

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...children);
  return node;
}

function svg(tag: string, attrs: Record<string, string | number>, ...children: (Node | string)[]): SVGElement {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  node.append(...children);
  return node;
}

function tooltip(text: string): SVGElement {
  return svg("title", {}, text);
}

const integer = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 0 });
const dateTime = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const shortDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: amount < 10 ? 2 : 0 }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function costs(costs: Record<string, number>): string {
  const list = Object.entries(costs).sort((a, b) => b[1] - a[1]);
  return list.length ? list.map(([c, a]) => money(a, c)).join(" + ") : "—";
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function average(t: Tally): string {
  return t.turns ? duration(t.durationMs / t.turns) : "—";
}

/** `YYYY-MM-DD` as a local date. */
function dayDate(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function post(message: PageMessage): void {
  try {
    pageHost().post(message);
  } catch {
    // Busy: the plugin is still working through earlier toggles, whose answer will arrive.
  }
}

function toggle<T extends string | number>(options: [T, string][], current: T | undefined, choose: (value: T) => void): HTMLElement {
  const group = el("div", "toggle");
  for (const [value, label] of options) {
    const button = el("button", value === current ? "on" : "", label);
    button.addEventListener("click", () => choose(value));
    group.append(button);
  }
  return group;
}

function query(): { range: Range; scope: Scope } | undefined {
  if (state.kind === "usage") return state.summary;
  return state.kind === "waiting" ? undefined : state;
}

function header(): HTMLElement {
  const q = query();
  const load = (range: Range, scope: Scope) => post({ type: "load", range, scope });
  return el("header", "",
    el("h1", "", "Agent Usage"),
    toggle<Range>([[7, "7 days"], [30, "30 days"], [90, "90 days"]], q?.range, (range) => load(range, q?.scope ?? "project")),
    toggle<Scope>([["project", "This project"], ["all", "All projects"]], q?.scope, (scope) => load(q?.range ?? 30, scope)),
  );
}

function card(label: string, value: string, note = ""): HTMLElement {
  return el("div", "card", el("div", "label", label), el("div", "value", value), el("div", "note", note));
}

function cards(s: Summary): HTMLElement {
  const t = s.totals;
  const costNote = t.costMissing ? `${integer.format(t.costMissing)} turns without a reported cost` : "";
  return el("section", "cards",
    card("Turns", integer.format(t.turns), t.turns ? `${percent.format(t.completed / t.turns)} completed` : ""),
    card("Tokens", compact.format(t.tokens.total), `${compact.format(t.tokens.input)} in · ${compact.format(t.tokens.cached)} cached · ${compact.format(t.tokens.output)} out`),
    card("Cost", costs(t.costs), costNote),
    card("Avg turn time", average(t)),
    card("Limit hits", integer.format(s.limitHits)),
  );
}

/** The agents with their own color, and whether the rest fold into "Other". */
function seriesOf(agents: string[]): { names: string[]; color: (agent: string) => string } {
  const palette = SERIES[pageHost().context.theme];
  const own = [...agents].sort().slice(0, palette.length - 1);
  const names = agents.length > own.length ? [...own, OTHER] : own;
  return { names, color: (agent) => palette[own.includes(agent) ? own.indexOf(agent) : palette.length - 1] };
}

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const step = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 2.5, 5, 10].map((m) => m * step).find((n) => n >= value)!;
}

const W = 720;
const H = 220;
const PAD = { left: 64, right: 8, top: 8, bottom: 22 };

/** The axes: three gridlines labelled with `label`, and a few day labels. */
function frame(days: Day[], max: number, label: (v: number) => string): SVGElement {
  const g = svg("g", {});
  const plotH = H - PAD.top - PAD.bottom;
  for (const f of [0, 0.5, 1]) {
    const y = PAD.top + plotH * (1 - f);
    g.append(svg("line", { x1: PAD.left, x2: W - PAD.right, y1: y, y2: y, class: f ? "grid" : "axis" }));
    g.append(svg("text", { x: PAD.left - 6, y: y + 4, "text-anchor": "end", class: "tick" }, label(max * f)));
  }
  const every = Math.ceil(days.length / 7);
  const step = (W - PAD.left - PAD.right) / days.length;
  days.forEach((d, i) => {
    if ((days.length - 1 - i) % every) return;
    g.append(svg("text", { x: PAD.left + step * (i + 0.5), y: H - 6, "text-anchor": "middle", class: "tick" }, shortDay.format(dayDate(d.day))));
  });
  return g;
}

function legend(names: string[], color: (agent: string) => string): HTMLElement {
  return el("div", "legend", ...names.map((name) => {
    const swatch = el("span", "swatch");
    swatch.style.background = color(name);
    return el("span", "", swatch, name);
  }));
}

function tokenChart(s: Summary): HTMLElement {
  const { names, color } = seriesOf(s.agents);
  const value = (t: Tokens | undefined) => t?.[metric] ?? 0;
  const stacks = s.days.map((d) => {
    const parts = new Map<string, number>();
    for (const [agent, t] of Object.entries(d.byAgent)) {
      const name = names.includes(agent) ? agent : OTHER;
      parts.set(name, (parts.get(name) ?? 0) + value(t));
    }
    return parts;
  });
  const max = niceMax(Math.max(0, ...stacks.map((p) => [...p.values()].reduce((a, b) => a + b, 0))));
  const plotH = H - PAD.top - PAD.bottom;
  const step = (W - PAD.left - PAD.right) / s.days.length;
  const barW = Math.max(2, Math.min(28, step - 2));
  const chart = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Tokens per day by agent" }, frame(s.days, max, (v) => compact.format(v)));
  stacks.forEach((parts, i) => {
    const x = PAD.left + step * i + (step - barW) / 2;
    let y = PAD.top + plotH;
    const total = [...parts.values()].reduce((a, b) => a + b, 0);
    const lines = [shortDay.format(dayDate(s.days[i].day)), ...[...parts].map(([n, v]) => `${n}: ${integer.format(v)}`)];
    const bar = svg("g", {}, tooltip(lines.join("\n")), svg("rect", { x: x - (step - barW) / 2, y: PAD.top, width: step, height: plotH, class: "hit" }));
    for (const name of names) {
      const v = parts.get(name);
      if (!v) continue;
      const h = (v / max) * plotH;
      y -= h;
      // A 1px gap of surface between segments.
      const rect = svg("rect", { x, y, width: barW, height: Math.max(0.5, h - 1), rx: 1.5 });
      rect.style.fill = color(name);
      bar.append(rect);
    }
    if (total) chart.append(bar);
  });
  const metrics = toggle<Metric>([["total", "Total"], ["input", "Input"], ["cached", "Cached"], ["output", "Output"]], metric, (m) => {
    metric = m;
    render();
  });
  return el("section", "panel", el("div", "panel-head", el("h2", "", "Tokens per day"), metrics), chart, legend(names, color));
}

function costChart(s: Summary): HTMLElement {
  const head = el("h2", "", "Cost per day");
  const totals = s.totals.costs;
  const currency = Object.keys(totals).sort((a, b) => totals[b] - totals[a])[0];
  if (!currency) return el("section", "panel", head, el("p", "dim", "Cost not reported by these agents."));
  const values = s.days.map((d) => d.costs[currency] ?? 0);
  const max = niceMax(Math.max(...values));
  const plotH = H - PAD.top - PAD.bottom;
  const step = (W - PAD.left - PAD.right) / s.days.length;
  const at = (i: number) => [PAD.left + step * (i + 0.5), PAD.top + plotH * (1 - values[i] / max)];
  const chart = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `Cost per day in ${currency}` }, frame(s.days, max, (v) => money(v, currency)));
  chart.append(svg("polyline", { points: values.map((_, i) => at(i).join(",")).join(" "), class: "line" }));
  values.forEach((v, i) => {
    const [x, y] = at(i);
    chart.append(svg("g", {},
      tooltip(`${shortDay.format(dayDate(s.days[i].day))}: ${money(v, currency)}`),
      svg("rect", { x: x - step / 2, y: PAD.top, width: step, height: plotH, class: "hit" }),
      ...(v ? [svg("circle", { cx: x, cy: y, r: 3, class: "dot" })] : []),
    ));
  });
  const others = Object.keys(totals).filter((c) => c !== currency);
  const note = [
    others.length ? `Also ${costs(Object.fromEntries(others.map((c) => [c, totals[c]])))}, not drawn.` : "",
    s.totals.costMissing ? `${integer.format(s.totals.costMissing)} turns reported no cost.` : "",
  ].filter(Boolean).join(" ");
  return el("section", "panel", el("div", "panel-head", head, el("span", "dim", currency)), chart, ...(note ? [el("p", "dim", note)] : []));
}

function table(title: string, first: string[], rows: Row[], cells: (r: Row) => string[]): HTMLElement {
  const head = el("tr", "", ...first.map((h) => el("th", "", h)), ...["Turns", "Tokens", "Cost", "Avg time", "Success"].map((h) => el("th", "num", h)));
  const numbers = (r: Row) => [integer.format(r.turns), compact.format(r.tokens.total), costs(r.costs), average(r), r.turns ? percent.format(r.completed / r.turns) : "—"];
  const body = rows.map((r) => el("tr", "", ...cells(r).map((c) => el("td", "", c)), ...numbers(r).map((c) => el("td", "num", c))));
  return el("section", "panel", el("h2", "", title), el("table", "", el("thead", "", head), el("tbody", "", ...body)));
}

function limits(list: LimitRow[]): HTMLElement {
  const head = el("h2", "", "Usage-limit hits");
  if (!list.length) return el("section", "panel", head, el("p", "dim", "No usage limits hit in this window."));
  const rows = list.map((l) => el("tr", "", ...[
    dateTime.format(l.detectedAt), l.agent, l.where, l.resetsAt === undefined ? "Unknown" : dateTime.format(l.resetsAt),
  ].map((c) => el("td", "", c))));
  return el("section", "panel", head, el("table", "",
    el("thead", "", el("tr", "", ...["Hit", "Agent", "Where", "Resets"].map((h) => el("th", "", h)))),
    el("tbody", "", ...rows)));
}

function body(): Node[] {
  switch (state.kind) {
    case "waiting":
    case "loading":
      return [el("p", "dim center", "Loading usage history…")];
    case "error":
      return [el("p", "center", `Could not read the usage history: ${state.message}`)];
    case "usage": {
      const s = state.summary;
      if (!s.totals.turns && !s.limitHits) {
        return [el("p", "dim center", "No turns recorded yet — usage history starts from the Alas version with plugin API 12.")];
      }
      if (rail) return [cards(s), tokenChart(s)];
      return [
        cards(s),
        tokenChart(s),
        costChart(s),
        table("By agent and model", ["Agent", "Model"], s.models, (r) => [r.label, r.model ?? "—"]),
        table(s.scope === "all" ? "By worktree and project" : "By worktree", ["Worktree"], s.worktrees, (r) => [r.label]),
        limits(s.limits),
        ...(s.omitted ? [el("p", "dim", `${integer.format(s.omitted)} smaller rows not shown.`)] : []),
      ];
    }
  }
}

function render(): void {
  app.replaceChildren(...(rail ? [] : [header()]), ...body());
}

function applyTheme(context: PageContext): void {
  document.documentElement.dataset.theme = context.theme;
  render();
}

const style = document.createElement("style");
style.textContent = `
body { margin: 0; background: var(--alas-background); color: var(--alas-text); font-size: 13px; }
main { padding: 16px 20px 32px; max-width: 1100px; margin: 0 auto; display: grid; gap: 16px; }
header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
h1 { font-size: 18px; margin: 0 auto 0 0; }
h2 { font-size: 13px; margin: 0; }
.dim { color: var(--alas-dim); }
.center { text-align: center; margin-top: 48px; }
.toggle { display: inline-flex; border: 1px solid var(--alas-line); border-radius: 6px; overflow: hidden; }
.toggle button { font: inherit; border: 0; padding: 4px 10px; background: transparent; color: var(--alas-text); cursor: pointer; }
.toggle button + button { border-left: 1px solid var(--alas-line); }
.toggle button.on { background: var(--alas-accent); color: #fff; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
.card, .panel { border: 1px solid var(--alas-line); border-radius: 8px; padding: 12px; }
.panel { display: grid; gap: 10px; }
.panel-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.label, .note { color: var(--alas-dim); font-size: 11px; }
.value { font-size: 20px; font-weight: 600; margin: 4px 0; font-variant-numeric: tabular-nums; }
svg { width: 100%; height: auto; display: block; }
.grid { stroke: var(--alas-line); stroke-dasharray: 2 3; }
.axis { stroke: var(--alas-line); }
.tick { fill: var(--alas-dim); font-size: 10px; }
.hit { fill: transparent; }
g:hover > .hit { fill: var(--alas-line); opacity: 0.35; }
.line { fill: none; stroke: var(--alas-accent); stroke-width: 2; stroke-linejoin: round; }
.dot { fill: var(--alas-accent); stroke: var(--alas-background); stroke-width: 2; }
.legend { display: flex; flex-wrap: wrap; gap: 12px; color: var(--alas-dim); }
.swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th { text-align: left; color: var(--alas-dim); font-weight: 500; font-size: 11px; }
th, td { padding: 5px 8px; border-bottom: 1px solid var(--alas-line); }
.num { text-align: right; white-space: nowrap; }
td { overflow-wrap: anywhere; }
main.compact { padding: 10px; gap: 10px; }
main.compact .cards { grid-template-columns: 1fr 1fr; }
main.compact .value { font-size: 15px; }
`;
document.head.append(style);
document.body.append(app);

pageHost().onThemeChange(applyTheme);
applyTheme(pageHost().context);
connect((message) => {
  const m = message as PluginMessage;
  if (m?.type === "usage") state = { kind: "usage", summary: m };
  else if (m?.type === "loading") state = { kind: "loading", range: m.range, scope: m.scope };
  else if (m?.type === "error") state = { kind: "error", range: m.range, scope: m.scope, message: m.message };
  else return;
  render();
}, { type: "ready" } satisfies PageMessage);
