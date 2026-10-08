import type { ButtonStyle, Node, Tone } from "@alas/plugin";
import { agoLabel, BUCKETS, MERGED_PAGE, canMerge, classify, isReady, updatedLabel, type Bucket, type Inbox, type Merged, type Pull } from "./inbox.ts";

export interface ViewState {
  inbox?: Inbox;
  /** When `inbox` was fetched, in ms since the epoch. */
  fetchedAt?: number;
  refreshing: boolean;
  error?: string;
  /** The pull request being merged, if any. */
  merging?: number;
  /** The last merge failure per pull request number. */
  mergeErrors: Record<number, string>;
  /** How many recently merged pull requests to list; `MERGED_PAGE` when unset. */
  mergedShown?: number;
}

export const SHOW_MORE_MERGED = "merged-more";

const TITLES: Record<Bucket, string> = { ready: "Ready to merge", failing: "Failing", waiting: "Waiting", drafts: "Drafts" };
const TONES: Record<Bucket, Tone> = { ready: "accent", failing: "danger", waiting: "warn", drafts: "dim" };

const text = (id: string, value: string, style: "body" | "caption" | "title" | "monospaced", tone?: Tone): Node =>
  ({ kind: "text", id, text: value, style, ...(tone && { tone }) });

/** Centers `child` in the remaining space. */
const centered = (id: string, child: Node): Node => ({
  kind: "vstack", id, children: [
    { kind: "spacer", id: `${id}-top` },
    { kind: "hstack", id: `${id}-row`, children: [{ kind: "spacer", id: `${id}-left` }, child, { kind: "spacer", id: `${id}-right` }] },
    { kind: "spacer", id: `${id}-bottom` },
  ],
});

function header(state: ViewState, now: number): Node {
  const title = state.inbox ? `PR Inbox — ${state.inbox.repo}` : "PR Inbox";
  const status: Node[] = state.refreshing
    ? [{ kind: "progress", id: "refreshing", text: "Refreshing…" }]
    : [
        ...(state.fetchedAt === undefined ? [] : [text("updated", updatedLabel(state.fetchedAt, now)!, "caption", "dim")]),
        { kind: "button", id: "refresh", label: "Refresh", icon: "arrow.clockwise", style: "plain" },
      ];
  return { kind: "hstack", id: "header", spacing: 8, children: [text("title", title, "title"), { kind: "spacer", id: "header-spacer" }, ...status] };
}

function badges(p: Pull): Node[] {
  const id = (name: string) => `pr-${p.number}-${name}`;
  const out: Node[] = [];
  if (p.ci === "SUCCESS") out.push({ kind: "badge", id: id("ci"), text: "CI ✓", tone: "accent" });
  else if (p.ci === "FAILURE" || p.ci === "ERROR") out.push({ kind: "badge", id: id("ci"), text: "CI ✗", tone: "danger" });
  else if (p.ci !== null) out.push({ kind: "badge", id: id("ci"), text: "CI …", tone: "dim" });
  // Checks still to finish: how far along they are, red once one failed.
  const c = p.checks;
  if (c && c.done < c.total) {
    const tone: Tone = p.ci === "FAILURE" || p.ci === "ERROR" ? "danger" : "success";
    out.push({ kind: "progressBar", id: id("checks"), done: c.done, running: c.running, total: c.total, text: `${c.done}/${c.total}`, tone });
  }
  if (p.reviewDecision === "APPROVED") out.push({ kind: "badge", id: id("review"), text: "✓ Approved", tone: "accent" });
  else if (p.reviewDecision === "CHANGES_REQUESTED") out.push({ kind: "badge", id: id("review"), text: "Changes requested", tone: "warn" });
  else if (p.reviewDecision === "REVIEW_REQUIRED") out.push({ kind: "badge", id: id("review"), text: "Review needed", tone: "dim" });
  if (p.codexThumbsUp) out.push({ kind: "badge", id: id("codex"), text: "Codex 👍", tone: "accent" });
  else if (p.codexReviewing) out.push({ kind: "badge", id: id("codex"), text: "Codex 👀", tone: "dim" });
  if (p.mergeable === "CONFLICTING") out.push({ kind: "badge", id: id("conflicts"), text: "Conflicts", tone: "warn" });
  return out;
}

/** Green checks make merging the obvious action, running ones a neutral one, red ones a warning. */
function mergeLook(p: Pull): { label: string; icon?: string; style: ButtonStyle; tone?: Tone } {
  if (isReady(p)) return { label: "Squash & merge", icon: "checkmark", style: "primary", tone: "success" };
  if (p.ci === "FAILURE" || p.ci === "ERROR") return { label: "Merge anyway", icon: "exclamationmark.triangle", style: "normal", tone: "warn" };
  return { label: "Squash & merge", style: "normal" };
}

function row(p: Pull, state: ViewState): Node {
  const id = (name: string) => `pr-${p.number}-${name}`;
  const mergeError = state.mergeErrors[p.number];
  const actions: Node[] = [{ kind: "link", id: id("open"), label: "Open", url: p.url }];
  if (canMerge(p)) {
    if (state.merging === p.number) actions.push({ kind: "progress", id: id("merging"), text: "Merging…" });
    actions.push({ kind: "button", id: mergeButtonId(p.number), ...mergeLook(p), disabled: state.merging !== undefined });
  }
  // The number sits level with the title; the actions center on the whole row.
  return {
    kind: "hstack", id: id("row"), spacing: 10, align: "center", children: [
      {
        kind: "hstack", id: id("info"), spacing: 10, children: [
          text(id("number"), `#${p.number}`, "monospaced", "dim"),
          {
            kind: "vstack", id: id("main"), spacing: 4, children: [
              text(id("title"), p.title, "body"),
              { kind: "hstack", id: id("meta"), spacing: 6, children: [text(id("branch"), p.branch, "monospaced", "dim"), ...badges(p)] },
              ...(mergeError === undefined ? [] : [text(id("error"), mergeError, "caption", "warn")]),
            ],
          },
        ],
      },
      { kind: "spacer", id: id("spacer") },
      ...actions,
    ],
  };
}

export const mergeButtonId = (number: number) => `pr-${number}-merge`;

/** The pull request number a `Squash & merge` button id names, or `undefined`. */
export function mergeTarget(id: string): number | undefined {
  const match = /^pr-(\d{1,9})-merge$/.exec(id);
  return match ? Number(match[1]) : undefined;
}

/** A merged pull request: no badges or actions beyond opening it, and when it merged. */
function mergedRow(m: Merged, now: number): Node {
  const id = (name: string) => `merged-${m.number}-${name}`;
  const ago = agoLabel(m.mergedAt, now);
  return {
    kind: "hstack", id: id("row"), spacing: 10, align: "center", children: [
      {
        kind: "hstack", id: id("info"), spacing: 10, children: [
          text(id("number"), `#${m.number}`, "monospaced", "dim"),
          {
            kind: "vstack", id: id("main"), spacing: 4, children: [
              text(id("title"), m.title, "body"),
              {
                kind: "hstack", id: id("meta"), spacing: 6, children: [
                  text(id("branch"), m.branch, "monospaced", "dim"),
                  text(id("by"), ago === undefined ? `by ${m.author}` : `merged ${ago} by ${m.author}`, "caption", "dim"),
                ],
              },
            ],
          },
        ],
      },
      { kind: "spacer", id: id("spacer") },
      { kind: "link", id: id("open"), label: "Open", url: m.url },
    ],
  };
}

function section(key: string, title: string, count: number, tone: Tone, rows: Node[]): Node {
  return {
    kind: "vstack", id: `bucket-${key}`, spacing: 7, children: [
      {
        kind: "hstack", id: `bucket-${key}-header`, spacing: 6, children: [
          text(`bucket-${key}-title`, title.toUpperCase(), "caption", "dim"),
          text(`bucket-${key}-count`, `${count} PR${count === 1 ? "" : "s"}`, "caption", tone),
        ],
      },
      ...rows,
    ],
  };
}

function content(state: ViewState, now: number): Node[] {
  if (!state.inbox) return state.error !== undefined ? [] : [centered("loading", { kind: "progress", id: "loading-progress", text: "Loading pull requests…" })];
  const { pulls, merged } = state.inbox;
  if (pulls.length === 0 && merged.length === 0) return [centered("clear", text("clear-text", "Inbox is clear.", "body", "dim"))];
  const buckets = classify(pulls);
  const sections: Node[] = pulls.length === 0
    ? [text("clear-text", "Inbox is clear.", "body", "dim")]
    : BUCKETS.filter((b) => buckets[b].length > 0).map((b) => section(b, TITLES[b], buckets[b].length, TONES[b], buckets[b].map((p) => row(p, state))));
  if (merged.length > 0) {
    const shown = merged.slice(0, state.mergedShown ?? MERGED_PAGE);
    const more: Node[] = shown.length < merged.length
      ? [{ kind: "button", id: SHOW_MORE_MERGED, label: `Show ${Math.min(MERGED_PAGE, merged.length - shown.length)} more`, icon: "chevron.down", style: "plain" }]
      : [];
    sections.push(section("merged", "Recently merged", shown.length, "success", [...shown.map((m) => mergedRow(m, now)), ...more]));
  }
  return [{ kind: "scroll", id: "scroll", axis: "vertical", child: { kind: "vstack", id: "buckets", spacing: 16, children: sections } }];
}

/** The whole tab: header, error banner, then the buckets and the recently merged, or a placeholder. */
export function inboxView(state: ViewState, now: number): Node {
  const banner: Node[] = state.error === undefined ? [] : [{
    kind: "hstack", id: "error", spacing: 8, children: [
      text("error-text", state.error, "caption", "danger"),
      { kind: "spacer", id: "error-spacer" },
      { kind: "button", id: "retry", label: "Retry", style: "plain" },
    ],
  }];
  return { kind: "vstack", id: "root", spacing: 10, children: [header(state, now), { kind: "divider", id: "header-divider" }, ...banner, ...content(state, now)] };
}
