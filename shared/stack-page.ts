import type { NativeStackAction, ReviewIdentity } from "../sdk/alas/src/stacks.ts";
import { reviewKey, type StackReview } from "./inbox-stacks.ts";
import type { InboxStackModel, StackPageMessage } from "./inbox-stack-controller.ts";

type Post = (message: StackPageMessage) => void;
let styled = false;
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag); result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}
function button(text: string, run: () => void, disabled = false, title?: string): HTMLButtonElement {
  const result = element("button", "btn stack-control", text); result.type = "button"; result.disabled = disabled;
  if (title) result.title = title;
  result.addEventListener("click", run); return result;
}
function installStyle(): void {
  if (styled) return; styled = true;
  const style = document.createElement("style");
  style.textContent = `
    .stack-badge{font:inherit;font-size:11px;border:1px solid var(--alas-accent);color:var(--alas-accent);background:color-mix(in srgb,var(--alas-accent) 10%,var(--alas-background));border-radius:5px;padding:2px 6px;cursor:pointer;white-space:nowrap}
    .stack-panel{border:1px solid var(--alas-line);border-radius:8px;margin:12px 0;padding:12px;min-width:0;overflow-wrap:anywhere}
    .stack-panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.stack-panel-title{font-weight:650}.stack-detail{color:var(--alas-dim);font-size:11px;margin-top:4px}
    .stack-controls{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}.stack-control{font-size:11px!important}.stack-chain{list-style:none;padding:0 0 0 13px;margin:12px 0 0 5px;border-left:2px solid var(--alas-line)}
    .stack-member{position:relative;list-style:none;margin:0 0 10px;padding:0 0 0 6px}.stack-member:before{content:'';position:absolute;left:-20px;top:10px;width:7px;height:7px;border:2px solid var(--alas-dim);border-radius:50%;background:var(--alas-background)}
    .stack-member[aria-current=step]:before{border-color:var(--alas-accent);background:var(--alas-accent)}.stack-member .pr{margin:0;min-width:0}.stack-member .pr .actions{flex-wrap:wrap}
    .stack-unordered{list-style:none;padding:0;margin:12px 0}.stack-fallback{padding:8px 0}.stack-fallback a{color:var(--alas-text);text-decoration:none}.stack-fallback a:hover{text-decoration:underline}
    .stack-issue{color:var(--alas-tone-warning);font-size:11px;line-height:1.5;margin:6px 0}.stack-progress{font-size:12px}.stack-confirm{border-color:var(--alas-accent)}.stack-confirm ul{padding-left:18px;font-size:12px;line-height:1.7}
    .stack-copy-fallback{width:100%;font:inherit;color:var(--alas-text);background:var(--alas-background);border:1px solid var(--alas-line);padding:8px}.stack-panel .stack-controls .btn{margin:0}
    body.compact .stack-panel{padding:10px}body.compact .stack-chain{padding-left:10px;margin-left:3px}body.compact .stack-member:before{left:-17px}body.compact .stack-controls{gap:5px}
  `;
  document.head.append(style);
}
export function stackBadge(model: InboxStackModel | undefined, identity: ReviewIdentity, post: Post): HTMLButtonElement | undefined {
  const badge = model?.badges[reviewKey(identity)]; if (!badge) return undefined;
  installStyle();
  const result = element("button", "stack-badge", badge.label); result.type = "button";
  result.setAttribute("aria-label", `${badge.label}. Show stack`);
  result.addEventListener("click", () => post({ type: "stack", action: "open", key: badge.key }));
  return result;
}
function fallback(review: StackReview, marker: string): HTMLElement {
  const row = element("div", "stack-fallback");
  const title = `${marker}${review.identity.number} · ${review.title}`;
  if (review.url.startsWith("https://")) { const link = element("a", "", title); link.href = review.url; link.rel = "noreferrer"; row.append(link); }
  else row.append(element("div", "", title));
  row.append(element("div", "stack-detail", review.state === "merged" ? "Merged" : review.state === "closed" ? "Closed without merging" : review.queued ? "Queued" : review.status ?? (review.ready ? "Ready" : "State unavailable")));
  return row;
}
function copyLinks(panel: HTMLElement, reviews: StackReview[], trigger: HTMLButtonElement): void {
  const text = reviews.map(r => r.url).filter(url => url.startsWith("https://")).join("\n");
  const manual = () => { const area = element("textarea", "stack-copy-fallback"); area.value = text; area.readOnly = true; area.setAttribute("aria-label", "Stack links to copy"); panel.append(area); area.focus(); area.select(); };
  if (!navigator.clipboard?.writeText) { manual(); return; }
  navigator.clipboard.writeText(text).then(() => { trigger.textContent = "Copied"; }, manual);
}

/** Provider pages supply their existing row renderer, preserving every individual action. */
export function stackPanel(model: InboxStackModel | undefined, post: Post, renderEntry?: (review: StackReview) => HTMLElement | undefined): HTMLElement | undefined {
  if (!model || !model.selected && !model.confirmation && !model.operation && !model.error && !model.nativeError) return undefined;
  installStyle();
  const root = element("section", "stack-region"); root.setAttribute("aria-label", "Stack details");
  if (model.error) root.append(element("p", "stack-issue", model.error));
  if (model.nativeError && (model.selected || Object.values(model.badges).some(b => b.label.startsWith("gg")))) root.append(element("p", "stack-detail", `gg actions unavailable: ${model.nativeError}`));
  const selected = model.selected;
  if (selected) {
    const marker = selected.mode === "queue" ? "!" : "#";
    const panel = element("section", "stack-panel");
    const header = element("div", "stack-panel-head"); const title = element("div", "");
    title.append(element("div", "stack-panel-title", selected.name));
    const counts = new Map<string, number>();
    for (const entry of selected.entries) { const status = entry.state !== "open" ? entry.state : entry.status ?? (entry.ready ? "ready" : "waiting"); counts.set(status, (counts.get(status) ?? 0) + 1); }
    title.append(element("div", "stack-detail", `${selected.native ? "gg · " : ""}${selected.base ? `Base: ${selected.base}` : "Base unknown"} · ${[...counts].map(([status, count]) => `${count} ${status}`).join(" · ")}`));
    header.append(title, button("Close", () => post({ type: "stack", action: "close" }))); panel.append(header);
    const controls = element("div", "stack-controls");
    controls.append(button("Refresh stack", () => post({ type: "stack", action: "refresh" })));
    const copy = button(selected.issues.length ? "Copy available links" : "Copy stack links", () => copyLinks(panel, selected.entries, copy), !selected.entries.some(r => r.url.startsWith("https://")));
    controls.append(copy);
    if (selected.native) {
      const labels: [NativeStackAction, string][] = [["open", "Open stack"], ["sync", "Sync stack…"], ["rebase", "Rebase stack…"], ["land", "Land stack…"], ["landThrough", "Land through this…"]];
      for (const [action, label] of labels) {
        const unavailable = selected.native.unavailableActions?.[action];
        const enabled = selected.native.actions.includes(action) && (action === "open" || !model.busy) && (!["land", "landThrough"].includes(action) || !selected.issues.length);
        controls.append(button(label, () => post({ type: "stack", action: "native", key: selected.key, nativeAction: action }), !enabled, unavailable ?? selected.issues[0]));
      }
    } else {
      const prefix = selected.mode === "queue" ? "Queue" : "Merge";
      controls.append(button(`${prefix} stack…`, () => post({ type: "stack", action: "prepare", key: selected.key }), !selected.canPrepare, selected.issues[0] ?? "All remaining requests must be ready."));
      const member = selected.entries.find(r => reviewKey(r.identity) === selected.key);
      controls.append(button(`${prefix} through this…`, () => post({ type: "stack", action: "prepare", key: selected.key, through: true }), !selected.canPrepare || member?.state !== "open", selected.issues[0]));
    }
    panel.append(controls);
    const visibleIssues = new Set(selected.issues);
    const unavailable = Object.values(selected.native?.unavailableActions ?? {})[0];
    if (unavailable) visibleIssues.add(unavailable);
    for (const issue of visibleIssues) panel.append(element("div", "stack-issue", issue));
    const list = element("ol", selected.ordered ? "stack-chain" : "stack-unordered");
    const appendEntry = (review: StackReview, target: HTMLElement = list, ordered = selected.ordered) => {
      const item = element("li", ordered ? "stack-member" : "stack-fallback");
      const key = reviewKey(review.identity);
      if (key === selected.key) item.setAttribute("aria-current", "step");
      if (selected.outsideFilter.includes(key)) item.append(element("div", "stack-detail", "Outside this filter"));
      item.append(renderEntry?.(review) ?? fallback(review, marker)); target.append(item);
    };
    const numbered = new Map(selected.entries.map(r => [reviewKey(r.identity), r]));
    const otherDependencies: StackReview[] = [];
    if (selected.ordered && selected.native?.entries.length) {
      const shown = new Set<string>();
      for (const entry of [...selected.native.entries].sort((a, b) => a.position - b.position)) {
        const review = entry.number ? numbered.get(reviewKey({ host: selected.native.host, repo: selected.native.repo, number: entry.number })) : undefined;
        if (review) { shown.add(reviewKey(review.identity)); appendEntry(review); }
        else { const row = element("li", "stack-member"); row.append(element("div", "", entry.title), element("div", "stack-detail", entry.number ? `Request ${marker}${entry.number} unavailable` : "Unpublished entry")); list.append(row); }
      }
      for (const review of selected.entries) if (!shown.has(reviewKey(review.identity))) otherDependencies.push(review);
    } else selected.entries.forEach(review => appendEntry(review));
    panel.append(list);
    if (otherDependencies.length) {
      panel.append(element("div", "stack-detail", "Other dependencies"));
      const extras = element("ul", "stack-unordered"); otherDependencies.forEach(review => appendEntry(review, extras, false)); panel.append(extras);
    }
    root.append(panel);
  }
  if (model.confirmation) {
    const confirmation = model.confirmation, marker = confirmation.mode === "queue" ? "!" : "#";
    const panel = element("section", "stack-panel stack-confirm");
    panel.append(element("div", "stack-panel-title", `${confirmation.mode === "queue" ? "Queue" : "Merge"} ${confirmation.members.length} requests${confirmation.through ? " through the selected member" : " in this stack"}?`));
    const list = element("ul", "");
    for (const member of confirmation.members) list.append(element("li", "", `${marker}${member.identity.number} · ${member.title} · @${member.author} · ${member.sha?.slice(0, 10) ?? "head unknown"}`));
    panel.append(list);
    if (confirmation.members.some(r => r.base !== confirmation.finalBase)) panel.append(element("p", "stack-detail", `Retarget descendants to ${confirmation.finalBase} after their predecessors merge. Execution stops if they need restacking.`));
    const controls = element("div", "stack-controls"); controls.append(button("Confirm", () => post({ type: "stack", action: "confirm" }), model.busy), button("Cancel", () => post({ type: "stack", action: "cancel" }))); panel.append(controls); root.append(panel);
  }
  if (model.operation) {
    const operation = model.operation, panel = element("section", "stack-panel stack-progress");
    panel.setAttribute("aria-live", "polite");
    panel.append(element("div", "stack-panel-title", `${operation.done}/${operation.total} merged · ${operation.phase}`));
    if (operation.message) panel.append(element("div", "stack-detail", operation.message));
    if (operation.error) panel.append(element("div", "stack-issue", operation.error));
    const controls = element("div", "stack-controls");
    if (["running", "waiting", "stopping"].includes(operation.phase)) controls.append(button(operation.phase === "stopping" ? "Stopping…" : "Stop", () => post({ type: "stack", action: "stop" }), operation.phase === "stopping"));
    else if (operation.phase !== "complete") controls.append(button("Continue", () => post({ type: "stack", action: "continue" }), model.busy));
    panel.append(controls); root.append(panel);
  }
  return root;
}
