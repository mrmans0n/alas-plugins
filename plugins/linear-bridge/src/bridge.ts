// Linear issues assigned to the user, in a right-pane panel. Starting one starts an agent in a new
// worktree and comments on the issue; when that agent finishes a turn, its last message is posted
// back as a comment. The API key is a secret: Alas substitutes it into the request header, so this
// script only ever holds the `{{secret:apiKey}}` placeholder.

import {
  fetch,
  getSettings,
  lastMessage,
  notify,
  parseLastMessage,
  renderPanel,
  setTimer,
  storageGet,
  storageSet,
  taskStart,
  type Event,
  type FetchResult,
  type Node,
  type Plugin,
  type Tone,
} from "@alas/plugin";

export const PANEL = "issues";
export const ENDPOINT = "https://api.linear.app/graphql";
export const MISSING_KEY = "Add your Linear API key in Settings → Plugins → Linear.";
const HEADERS = { Authorization: "{{secret:apiKey}}", "Content-Type": "application/json" };
const REFRESH_SECONDS = 300;
export const PROMPT_BYTES = 32 * 1024;
export const COMMENT_CHARS = 4000;
const REMEMBERED_SESSIONS = 50;

const ISSUES = `query Issues($filter: IssueFilter) { viewer { assignedIssues(filter: $filter, first: 50) {
  nodes { id identifier title description url state { name type } team { key } } } } }`;
const COMMENT = `mutation Comment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) { success } }`;

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  state: string;
  stateType: string;
}

/** What a started session works on, stored under `sessions` by session id. */
interface Started {
  issueId: string;
  identifier: string;
  branch: string;
}

export class LinearBridge implements Plugin {
  issues: Issue[] = [];
  /** Shown above the list: loading, a missing key, or the last failure. */
  message: string | undefined = "Loading…";
  sessions: Record<string, Started> = {};
  teamKey = "";
  commentOnFinish = true;
  private loading = false;
  private reloadAfter = false;
  private starting = false;

  handle(event: Event): void {
    switch (event.type) {
      case "activate":
        getSettings();
        storageGet("sessions");
        setTimer("refresh", REFRESH_SECONDS, true);
        return this.render();
      case "settings":
        this.teamKey = typeof event.values.teamKey === "string" ? event.values.teamKey.trim() : "";
        this.commentOnFinish = event.values.commentOnFinish !== false;
        return this.refresh();
      case "stored":
        // Sessions started before the stored ones arrived win.
        if (isObject(event.value)) this.sessions = { ...(event.value as Record<string, Started>), ...this.sessions };
        return this.render();
      case "timer":
        return event.id === "refresh" ? this.refresh() : undefined;
      case "command":
        return event.command === "refresh" ? this.refresh() : undefined;
      case "panelVisible":
        return event.panel === PANEL && event.visible ? this.refresh() : undefined;
      case "panelEvent":
        if (event.panel !== PANEL || event.kind !== "click") return;
        if (event.id === "refresh") return this.refresh();
        if (event.id.startsWith("start-")) return this.start(event.id.slice("start-".length));
        return;
      case "sessionFinished":
        return this.finished(event.session);
      case "taskFailed":
        delete this.sessions[event.sessionId];
        storageSet("sessions", this.sessions);
        notify("Could not start the agent", event.reason);
        return this.render();
    }
  }

  refresh(): void {
    if (this.loading) {
      this.reloadAfter = true;
      return;
    }
    this.loading = true;
    const filter: Record<string, unknown> = { state: { type: { in: ["unstarted", "started"] } } };
    if (this.teamKey) filter.team = { key: { eqIgnoreCase: this.teamKey } };
    graphql(ISSUES, { filter }, (data, error) => {
      this.loading = false;
      if (error) {
        this.message = error;
      } else {
        this.issues = parseIssues(data);
        this.message = undefined;
      }
      if (this.reloadAfter) {
        this.reloadAfter = false;
        return this.refresh();
      }
      this.render();
    });
  }

  private start(issueId: string): void {
    const issue = this.issues.find((i) => i.id === issueId);
    if (!issue || this.starting) return;
    this.starting = true;
    const branch = issue.identifier.toLowerCase();
    const prompt = takeUtf8(`${issue.title}\n\n${issue.url}\n\n${issue.description}`.trim(), PROMPT_BYTES);
    taskStart(`${issue.identifier} ${issue.title}`, prompt, { branch }, ({ result, error }) => {
      this.starting = false;
      const sessionId = isObject(result) ? result.sessionId : undefined;
      if (error || typeof sessionId !== "string") {
        notify(`Could not start ${issue.identifier}`, error?.message);
        return this.render();
      }
      const started = isObject(result) && typeof result.branch === "string" ? result.branch : branch;
      this.sessions[sessionId] = { issueId: issue.id, identifier: issue.identifier, branch: started };
      const ids = Object.keys(this.sessions);
      for (const old of ids.slice(0, Math.max(0, ids.length - REMEMBERED_SESSIONS))) delete this.sessions[old];
      storageSet("sessions", this.sessions);
      this.comment(issue.id, issue.identifier, `Started an agent in Alas on branch ${started}`);
      this.render();
    });
    this.render();
  }

  private finished(sessionId: string): void {
    const started = this.sessions[sessionId];
    if (!started || !this.commentOnFinish) return;
    lastMessage(sessionId, ({ result }) => {
      const text = parseLastMessage(result)?.trim();
      if (!text) return;
      this.comment(started.issueId, started.identifier, cut(text, COMMENT_CHARS), () => notify(`Commented on ${started.identifier}`));
    });
  }

  private comment(issueId: string, identifier: string, body: string, done?: () => void): void {
    graphql(COMMENT, { issueId, body }, (data, error) => {
      if (error || !isObject(data) || !isObject(data.commentCreate) || data.commentCreate.success !== true) {
        return notify(`Could not comment on ${identifier}`, error ?? "Linear did not create the comment.");
      }
      done?.();
    });
  }

  render(): void {
    renderPanel(PANEL, view(this.issues, this.message, this.startedIssues(), this.starting));
  }

  private startedIssues(): Set<string> {
    return new Set(Object.values(this.sessions).map((s) => s.issueId));
  }
}

/** Posts one GraphQL operation; `done` gets `data`, or a message fit for the panel. Never throws on bad replies. */
function graphql(query: string, variables: object, done: (data: any, error?: string) => void): void {
  fetch({ method: "POST", url: ENDPOINT, headers: HEADERS, body: JSON.stringify({ query, variables }) }, (result: FetchResult) => {
    if (result.error) {
      const missing = result.error.code === -32602 && /secret apiKey is not set/.test(result.error.message);
      return done(undefined, missing ? MISSING_KEY : cut(`Linear request failed: ${result.error.message}`, 500));
    }
    const { status, body } = result.response;
    let json: any;
    try {
      json = JSON.parse(body);
    } catch {
      json = undefined;
    }
    const reason = Array.isArray(json?.errors) && typeof json.errors[0]?.message === "string" ? json.errors[0].message : undefined;
    if (status !== 200 || reason || !isObject(json?.data)) {
      return done(undefined, cut(`Linear answered ${status}: ${reason ?? (body.trim() || "no body")}`, 500));
    }
    done(json.data);
  });
}

function parseIssues(data: any): Issue[] {
  const nodes = data?.viewer?.assignedIssues?.nodes;
  if (!Array.isArray(nodes)) return [];
  const issues: Issue[] = [];
  for (const n of nodes) {
    // Node ids are at most 64 bytes; Linear's are 36-character UUIDs.
    if (!isObject(n) || typeof n.id !== "string" || n.id.length > 48 || typeof n.identifier !== "string" || typeof n.title !== "string") continue;
    issues.push({
      id: n.id,
      identifier: n.identifier,
      title: n.title,
      description: typeof n.description === "string" ? n.description : "",
      url: typeof n.url === "string" ? n.url : "",
      state: isObject(n.state) && typeof n.state.name === "string" ? n.state.name : "",
      stateType: isObject(n.state) && typeof n.state.type === "string" ? n.state.type : "",
    });
  }
  return issues;
}

export function view(issues: Issue[], message: string | undefined, started: Set<string>, starting: boolean): Node {
  const rows: Node[] = issues.map((issue) => ({
    kind: "hstack",
    id: `row-${issue.id}`,
    spacing: 8,
    children: [
      { kind: "text", id: `key-${issue.id}`, text: issue.identifier, style: "monospaced", tone: "dim" },
      { kind: "text", id: `title-${issue.id}`, text: cut(issue.title, 300) },
      { kind: "spacer", id: `gap-${issue.id}` },
      { kind: "badge", id: `state-${issue.id}`, text: cut(issue.state || issue.stateType, 40), tone: stateTone(issue.stateType) },
      started.has(issue.id)
        ? { kind: "button", id: `start-${issue.id}`, label: "Started", disabled: true }
        : { kind: "button", id: `start-${issue.id}`, label: "Start", style: "primary", disabled: starting },
    ],
  }));
  const header: Node = {
    kind: "hstack",
    id: "header",
    children: [
      { kind: "text", id: "heading", text: "Assigned to you", style: "title" },
      { kind: "spacer", id: "header-gap" },
      { kind: "button", id: "refresh", label: "Refresh", icon: "arrow.clockwise", style: "plain" },
    ],
  };
  const body: Node[] = [];
  if (message) body.push({ kind: "text", id: "message", text: message, tone: message === "Loading…" ? "dim" : "warn" });
  if (!message && issues.length === 0) body.push({ kind: "text", id: "empty", text: "No open issues assigned to you.", tone: "dim" });
  return {
    kind: "scroll",
    id: "scroll",
    axis: "vertical",
    child: { kind: "vstack", id: "list", spacing: 6, children: [header, ...body, ...rows] },
  };
}

function stateTone(type: string): Tone {
  return type === "started" ? "accent" : "normal";
}

/** At most `max` UTF-16 units, without splitting a surrogate pair. */
export function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const c = s.charCodeAt(max - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? max - 1 : max);
}

/** At most `max` bytes of UTF-8, without splitting a character. */
export function takeUtf8(s: string, max: number): string {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdfff ? 2 : 3;
    if (n > max) return cut(s, i);
  }
  return s;
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
