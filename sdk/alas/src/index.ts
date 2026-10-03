/**
 * SDK for Alas plugins, API 4 to 7: one `plugin.js` evaluated in a bare JavaScriptCore context.
 * Handles the JSON-RPC framing, the activation handshake and request ids. API 5 helpers
 * (commands, notify, session events, settings, `fetch`, timers, panels) need `"api": 5`; API 6
 * ones (more command slots, decorations, section panels, git/run/review events, runs, review
 * comments, processes, files) `"api": 6`; API 7 ones (message menu, slash prompts, context) `"api": 7`.
 *
 * Inside Alas the only globals are the ECMAScript built-ins and `alas`: no `console`,
 * timers, `fetch`, `TextEncoder` or Node APIs. Every call must return within 250 ms
 * (1 s for activation), and JavaScriptCore runs without its JIT, so keep hot paths lean.
 */

/** The host functions Alas installs as the global `alas`. */
export interface Host {
  /** Queues one JSON-RPC message: at most 1 MiB, and 64 per call. */
  send(json: string): void;
  /** One RGBA8 frame (non-premultiplied, row-major) for canvas tab `tab`. */
  present(tab: number, pixels: Uint8Array, width: number): void;
}

declare global {
  var alas: Host;
  var handle: ((json: string) => void) | undefined;
}

export interface Snapshot {
  worktrees: Worktree[];
}

export interface Worktree {
  id: string;
  branch: string;
  current: boolean;
  dirty?: Dirty | null;
  sessions: Session[];
}

export interface Dirty {
  files: number;
  conflicts: number;
}

export interface Session {
  id: string;
  agent: string;
  title: string;
  state: string;
  plan?: Plan | null;
}

export interface Plan {
  completed: number;
  total: number;
}

export interface Region {
  id: string;
  label: string;
  rect: [number, number, number, number];
}

export interface RpcError {
  code: number;
  message: string;
}

export interface Agent {
  id: string;
  name: string;
}

/**
 * What a command was chosen on. Ids are `workspace/snapshot`'s; `path` is relative to the worktree,
 * `script` a run script key (`repo:dev.sh`), `run` a run id. `file` to `session` need API 6, `message` API 7.
 */
export type CommandTarget =
  | { kind: "project" }
  | { kind: "worktree"; worktree: string }
  | { kind: "file"; worktree: string; path: string }
  | { kind: "commit"; worktree: string; sha: string }
  | { kind: "run"; worktree: string; script: string }
  | { kind: "runReport"; worktree: string; run: string }
  | { kind: "session"; session: string }
  /** `text` is the message's Markdown, cut to 32 KiB. */
  | { kind: "message"; session: string; text: string };

/** The fields each target kind carries, all strings. */
const targetFields: Record<CommandTarget["kind"], string[]> = {
  project: [],
  worktree: ["worktree"],
  file: ["worktree", "path"],
  commit: ["worktree", "sha"],
  run: ["worktree", "script"],
  runReport: ["worktree", "run"],
  session: ["session"],
  message: ["session", "text"],
};

/** API 6: the worktree a `changes.section` panel or the run a `run.report.section` panel is for. */
export type PanelPlace = { worktree: string; run?: undefined } | { run: string; worktree?: undefined };

export interface ReviewChecks {
  passed: number;
  failed: number;
  pending: number;
}

/** A request's decoded outcome: `error` when Alas refused it or it failed, `result` otherwise. */
export type Outcome<T> = { result: T; error?: undefined } | { result?: undefined; error: RpcError };

export interface RunOutput {
  /** The last 64 KiB of the run's output, or `null` when Alas did not keep it. */
  output: string | null;
  truncated: boolean;
}

export interface ProcessResult {
  /** The exit code, or 128 plus the signal number. */
  exit: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

export interface FileEntry {
  name: string;
  kind: "file" | "directory" | "symlink";
}

export interface FileList {
  entries: FileEntry[];
  truncated: boolean;
}

/**
 * Answers a request Alas sent the plugin (API 7) with `{text}`, or `fail` with an error. Only the
 * first answer is sent.
 */
export interface Responder<Text> {
  respond(text: Text): void;
  fail(message: string): void;
}

/** `string` and `bool` settings by key, defaults applied. Secrets are never included. */
export type SettingValues = Record<string, string | boolean>;

export interface HttpRequest {
  method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** `https` only, on a host the manifest's `network` lists. */
  url: string;
  /** A value may hold `{{secret:<key>}}`, which Alas substitutes for the secret's hosts. */
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  /** Lowercase names. */
  headers: Record<string, string>;
  body: string;
}

/** A request's outcome: `error` when Alas refused it or it failed, `response` otherwise (any status). */
export type FetchResult = { response: HttpResponse; error?: undefined } | { response?: undefined; error: RpcError };

/** A reply handed to a request's callback: `result` on success, `error` on failure. */
export interface Reply {
  result?: unknown;
  error?: RpcError;
}

export type Event =
  /** `api` is the manifest's. */
  | { type: "activate"; api: number; projectId: string; projectName: string; grants: string[] }
  | { type: "deactivate" }
  | { type: "workspaceChanged"; snapshot: Snapshot }
  /** The reply to `requestSnapshot`. */
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "tick"; dt: number }
  | { type: "click"; tab: number; region: string }
  /** A control in a view tab was used: `kind` is `click` (button, card), `submit` (text field) or `select` (menu). */
  | { type: "viewEvent"; tab: number; id: string; kind: string; value?: string }
  /** A task started with `taskStart` failed to launch in the background. */
  | { type: "taskFailed"; sessionId: string; reason: string }
  /** The reply to `storageGet`: `value` is `null` when the key is unset, `undefined` with `error`. */
  | { type: "stored"; id: number; value?: unknown; error?: RpcError }
  /** API 5: a manifest command was chosen. */
  | { type: "command"; command: string; target: CommandTarget }
  /** API 5, event `session.state`: a session appeared or changed state. */
  | { type: "sessionState"; session: string; worktree: string; state: string }
  /** API 5, event `session.finished`: a session went from `running` to `idle`. */
  | { type: "sessionFinished"; session: string; worktree: string }
  /**
   * API 5: the reply to `getSettings`, or `changed` when the user edited a setting (a secret included).
   * `secretsSet` lists the secret settings that hold a value; their values never reach the plugin.
   */
  | { type: "settings"; values: SettingValues; secretsSet: string[]; changed: boolean }
  /** API 5: a timer set with `setTimer` is due. */
  | { type: "timer"; id: string }
  /** API 5: a control in a panel was used; see `viewEvent`. Section panels (API 6) carry their place. */
  | ({ type: "panelEvent"; panel: string; id: string; kind: string; value?: string } & Partial<PanelPlace>)
  /** API 5: a panel was shown or hidden. Section panels (API 6) carry their place. */
  | ({ type: "panelVisible"; panel: string; visible: boolean } & Partial<PanelPlace>)
  /** API 6, events `worktree.created`, `worktree.removed`, `git.changed` (dirty or conflict counts) and `focus.changed`. */
  | { type: "worktreeCreated" | "worktreeRemoved" | "gitChanged" | "focusChanged"; worktree: string }
  /** API 6, event `run.started`. */
  | { type: "runStarted"; worktree: string; script: string; run: string }
  /** API 6, event `run.finished`: `exitCode` is set for `succeeded` and `failed`. */
  | { type: "runFinished"; worktree: string; script: string; run: string; outcome: "succeeded" | "failed" | "stopped" | "unknown"; exitCode?: number }
  /** API 6, event `review.changed`: `state` is `none` when the branch has no pull request. */
  | { type: "reviewChanged"; worktree: string; state: "open" | "closed" | "merged" | "none"; number?: number; checks?: ReviewChecks }
  /** API 6: a process started with `processStart` exited. */
  | { type: "processExited"; run: string; exit: number }
  /**
   * API 7: the user sent `/name args` in a session. `respond` with the prompt (1 byte to 32 KiB) that
   * replaces the draft, in this call or a later one within 30 s, e.g. after a `fetch`.
   */
  | ({ type: "promptExpand"; name: string; args: string; session: string } & Responder<string>)
  /**
   * API 7, capability `session.context`: a session is about to send a prompt. `respond` within this
   * call, with text (up to 16 KiB) to add to it or `null` for none; a later answer is ignored.
   */
  | ({ type: "contextProvide"; session: string; worktree: string } & Responder<string | null>)
  /** Any other reply without a callback: `result` on success, `error` on failure. */
  | { type: "reply"; id: number; result?: unknown; error?: RpcError };

export interface Plugin {
  handle(event: Event): void;
}

function send(message: object): void {
  globalThis.alas.send(JSON.stringify(message));
}

/** Sends a JSON-RPC notification (a message without an id). */
export function sendNotification(method: string, params: unknown): void {
  send({ jsonrpc: "2.0", method, params });
}

export function log(level: "debug" | "info" | "warn" | "error", message: string): void {
  sendNotification("log", { level, message });
}

/** API 5, capability `notify`: an in-app notification. At most one every 2 s; others are dropped. */
export function notify(title: string, body?: string): void {
  sendNotification("notify", { title, body });
}

let nextId = 1;
/** Replies decoded into their own event instead of `reply`. */
const typed = new Map<number, "snapshot" | "storage" | "settings">();
/** Replies handed to the callback their request was sent with. */
const callbacks = new Map<number, (reply: Reply) => void>();

/**
 * Sends a request and returns its id. The reply arrives in a later call: to `callback` when one
 * is given, otherwise as a `reply` event.
 */
export function request(method: string, params: unknown = {}, callback?: (reply: Reply) => void): number {
  const id = nextId++;
  send({ jsonrpc: "2.0", id, method, params });
  if (callback) callbacks.set(id, callback);
  return id;
}

/** The reply arrives as a `snapshot` event. */
export function requestSnapshot(): number {
  const id = request("workspace/snapshot");
  typed.set(id, "snapshot");
  return id;
}

export function worktreeSwitch(id: string): number {
  return request("worktree/switch", { id });
}

export function sessionFocus(id: string): number {
  return request("session/focus", { id });
}

/** The reply (a `reply` event, or `callback`'s) decodes with `parseLastMessage`. */
export function lastMessage(sessionId: string, callback?: (reply: Reply) => void): number {
  return request("session/last_message", { id: sessionId }, callback);
}

/** The reply (a `reply` event) decodes with `parseAgents`. */
export function agentList(): number {
  return request("agent/list");
}

/** Starts a task in a new worktree. The reply holds `{sessionId, branch}`. `prompt` is at most 32 KiB of UTF-8. */
export function taskStart(
  title: string,
  prompt: string,
  options: { branch?: string; agent?: string } = {},
  callback?: (reply: Reply) => void,
): number {
  return request("task/start", { title, prompt, branch: options.branch, agent: options.agent }, callback);
}

/** API 5. The reply arrives as a `settings` event. */
export function getSettings(): number {
  const id = request("settings/get");
  typed.set(id, "settings");
  return id;
}

/**
 * API 5, capability `network`: an HTTPS request. Alas answers once it finishes, in a later call,
 * and `callback` gets the response or the reason it failed. Replies to a restarted plugin are dropped.
 */
export function fetch(req: HttpRequest, callback: (result: FetchResult) => void): number {
  return request("http/fetch", req, ({ result, error }) => {
    if (error) return callback({ error });
    const r = isObject(result) ? result : {};
    const ok = typeof r.status === "number" && typeof r.body === "string";
    callback(ok
      ? { response: { status: r.status, headers: isObject(r.headers) ? r.headers : {}, body: r.body } }
      : { error: { code: -32603, message: "malformed http/fetch reply" } });
  });
}

/** API 5, capability `timers`: a `timer` event after `seconds` (60 to 86,400). Replaces a timer with the same id. */
export function setTimer(id: string, seconds: number, repeat = false): number {
  return request("timer/set", { id, seconds, repeat });
}

export function cancelTimer(id: string): number {
  return request("timer/cancel", { id });
}

/** Sends a request whose reply `decode` turns into `T`; a malformed reply is a -32603 error. */
function requestDecoded<T>(method: string, params: unknown, decode: (r: Record<string, any>) => T | undefined, callback: (outcome: Outcome<T>) => void): number {
  return request(method, params, ({ result, error }) => {
    if (error) return callback({ error });
    const value = isObject(result) ? decode(result) : undefined;
    callback(value === undefined ? { error: { code: -32603, message: `malformed ${method} reply` } } : { result: value });
  });
}

/** API 6, capability `session.write`: queues `text` (up to 32 KiB) as a prompt in an agent session. */
export function sessionSend(session: string, text: string, callback?: (reply: Reply) => void): number {
  return request("session/send", { session, text }, callback);
}

/** API 6, capability `runs.start`: starts run script `script`. Its run id comes with `runStarted`. */
export function runStart(worktree: string, script: string, callback?: (reply: Reply) => void): number {
  return request("run/start", { worktree, script }, callback);
}

/** API 6, capability `runs.read`: a finished run's output. */
export function runOutput(run: string, callback: (outcome: Outcome<RunOutput>) => void): number {
  return requestDecoded("run/output", { run }, (r) =>
    (typeof r.output === "string" || r.output === null) && typeof r.truncated === "boolean" ? { output: r.output, truncated: r.truncated } : undefined, callback);
}

/** API 6, capability `review.write`: a draft review comment on `line` (from 1) of `path`. `body` is Markdown. */
export function reviewComment(worktree: string, path: string, line: number, body: string, callback?: (reply: Reply) => void): number {
  return request("review/comment", { worktree, path, line, body }, callback);
}

/** API 6, capability `process.exec`: runs the manifest's process `id` to completion. `args` need `appendArgs`. */
export function processRun(
  id: string,
  worktree: string,
  options: { args?: string[]; stdin?: string },
  callback: (outcome: Outcome<ProcessResult>) => void,
): number {
  return requestDecoded("process/run", { id, worktree, args: options.args, stdin: options.stdin }, (r) =>
    typeof r.exit === "number" && typeof r.stdout === "string" && typeof r.stderr === "string"
      ? { exit: r.exit, stdout: r.stdout, stderr: r.stderr, truncated: r.truncated === true, timedOut: r.timedOut === true }
      : undefined, callback);
}

/** API 6, capability `process.exec`: starts the `longRunning` process `id`; the result is its run id. */
export function processStart(id: string, worktree: string, args: string[] | undefined, callback: (outcome: Outcome<string>) => void): number {
  return requestDecoded("process/start", { id, worktree, args }, (r) => (typeof r.run === "string" ? r.run : undefined), callback);
}

/** API 6: stops a process started with `processStart`. */
export function processStop(run: string, callback?: (reply: Reply) => void): number {
  return request("process/stop", { run }, callback);
}

/** API 6, capability `files.read`: a UTF-8 file of up to 512 KiB, by path relative to the worktree. */
export function fileRead(worktree: string, path: string, callback: (outcome: Outcome<string>) => void): number {
  return requestDecoded("file/read", { worktree, path }, (r) => (typeof r.content === "string" ? r.content : undefined), callback);
}

/** API 6, capability `files.read`: a folder's entries, `""` for the worktree itself. */
export function fileList(worktree: string, dir: string, callback: (outcome: Outcome<FileList>) => void): number {
  return requestDecoded("file/list", { worktree, dir }, (r) =>
    Array.isArray(r.entries) && r.entries.every((e: unknown) => isObject(e) && typeof e.name === "string" && typeof e.kind === "string")
      ? { entries: r.entries.map((e: FileEntry) => ({ name: e.name, kind: e.kind })), truncated: r.truncated === true }
      : undefined, callback);
}

/** API 6, capability `files.write`: replaces a file (up to 512 KiB), creating missing folders. */
export function fileWrite(worktree: string, path: string, content: string, callback?: (reply: Reply) => void): number {
  return request("file/write", { worktree, path, content }, callback);
}

/** The reply arrives as a `stored` event. */
export function storageGet(key: string): number {
  const id = request("storage/get", { key });
  typed.set(id, "storage");
  return id;
}

/** A `null` value deletes the key. */
export function storageSet(key: string, value: unknown): number {
  return request("storage/set", { key, value });
}

/** `{message: "..."}` gives the text; `null` or a missing key gives `undefined`. */
export function parseLastMessage(result: unknown): string | undefined {
  const message = isObject(result) ? result.message : undefined;
  return typeof message === "string" ? message : undefined;
}

/** Malformed results give an empty list. */
export function parseAgents(result: unknown): Agent[] {
  const agents = isObject(result) ? result.agents : undefined;
  if (!Array.isArray(agents) || !agents.every((a) => isObject(a) && typeof a.id === "string" && typeof a.name === "string")) {
    return [];
  }
  return agents.map((a) => ({ id: a.id, name: a.name }));
}

/** Hands Alas one RGBA8 frame for canvas tab `tab`. Alas copies it during this call. */
export function present(tab: number, pixels: Uint8Array, width: number): void {
  globalThis.alas.present(tab, pixels, width);
}

export function setRegions(tab: number, regions: Region[]): void {
  sendNotification("canvas/regions", { tab, regions });
}

export type Tone = "normal" | "dim" | "accent" | "warn" | "danger";
export type TextStyle = "body" | "caption" | "title" | "monospaced";
export type ButtonStyle = "normal" | "primary" | "plain";

export interface MenuItem {
  id: string;
  label: string;
}

/** A node of a view tab's tree. Ids must be unique within the tree. */
export type Node =
  /** `spacing` is 0 to 32 points, `width` 40 to 1000. */
  | { kind: "vstack"; id: string; children: Node[]; spacing?: number; width?: number }
  | { kind: "hstack"; id: string; children: Node[]; spacing?: number }
  | { kind: "scroll"; id: string; axis: "vertical" | "horizontal"; child: Node }
  | { kind: "text"; id: string; text: string; style?: TextStyle; tone?: Tone }
  | { kind: "badge"; id: string; text: string; tone?: Tone }
  | { kind: "button"; id: string; label: string; icon?: string; style?: ButtonStyle; disabled?: boolean }
  | { kind: "textField"; id: string; value: string; placeholder?: string; multiline?: boolean }
  | { kind: "menu"; id: string; label: string; items: MenuItem[] }
  | { kind: "card"; id: string; children: Node[]; tone?: Tone; clickable?: boolean; width?: number }
  | { kind: "divider"; id: string }
  | { kind: "spacer"; id: string };

/** Replaces the tree shown in view tab `tab`. */
export function render(tab: number, root: Node): void {
  sendNotification("view/render", { tab, root });
}

/** API 5: replaces the tree shown in the manifest's panel `panel`. API 6 section panels need their `place`. */
export function renderPanel(panel: string, root: Node, place?: PanelPlace): void {
  sendNotification("view/render", { panel, ...place, root });
}

export type DecorationSlot = "repo.row" | "worktree.row" | "run.row" | "changes.file";

export interface Decoration {
  /** Cut to 24 characters. */
  text: string;
  tone?: Tone;
  tooltip?: string;
  /** One of the manifest's commands: the badge becomes a button that runs it on the row's target. */
  command?: string;
}

/**
 * API 6: replaces the plugin's badges (at most 2) on one row; `[]` clears them. `target` is the
 * project id for `repo.row`, a worktree id for `worktree.row`, a run script key for `run.row`
 * and a path for `changes.file`; the last two also need `worktree`. Set them again on activation.
 */
export function setDecorations(slot: DecorationSlot, target: string, items: Decoration[], worktree?: string): void {
  sendNotification("decorations/set", { slot, target, worktree, items });
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rpcError(value: unknown): RpcError | undefined {
  return isObject(value) && typeof value.code === "number" && typeof value.message === "string"
    ? { code: value.code, message: value.message }
    : undefined;
}

function settingValues(payload: unknown): SettingValues | undefined {
  const values = isObject(payload) ? payload.values : undefined;
  if (!isObject(values)) return undefined;
  const out: SettingValues = {};
  for (const key of Object.keys(values)) {
    if (typeof values[key] === "string" || typeof values[key] === "boolean") out[key] = values[key];
  }
  return out;
}

function secretsSet(payload: unknown): string[] {
  const keys = isObject(payload) ? payload.secretsSet : undefined;
  return Array.isArray(keys) ? keys.filter((k: unknown): k is string => typeof k === "string") : [];
}

/** The `worktree` or `run` a section panel's message carries, if any. */
function placeOf(params: Record<string, any>): Partial<PanelPlace> {
  if (typeof params.worktree === "string") return { worktree: params.worktree };
  return typeof params.run === "string" ? { run: params.run } : {};
}

const worktreeEvents = {
  "worktree/created": "worktreeCreated",
  "worktree/removed": "worktreeRemoved",
  "git/changed": "gitChanged",
  "focus/changed": "focusChanged",
} as const;

function commandTarget(target: unknown): CommandTarget | undefined {
  if (!isObject(target) || !Object.hasOwn(targetFields, target.kind)) return undefined;
  const out: Record<string, string> = { kind: target.kind };
  for (const field of targetFields[target.kind as CommandTarget["kind"]]) {
    if (typeof target[field] !== "string") return undefined;
    out[field] = target[field];
  }
  return out as CommandTarget;
}

/** Answers Alas's request `id` once: `{result: {text}}`, or an error. */
function responder<Text extends string | null>(id: unknown): Responder<Text> {
  let answered = false;
  const answer = (reply: object) => {
    if (answered) return;
    answered = true;
    send({ jsonrpc: "2.0", id, ...reply });
  };
  return {
    respond: (text) => answer({ result: { text } }),
    fail: (message) => answer({ error: { code: -32000, message } }),
  };
}

function snapshotOf(payload: unknown): Snapshot | undefined {
  const snapshot = isObject(payload) ? payload.snapshot : undefined;
  return isObject(snapshot) && Array.isArray(snapshot.worktrees) ? (snapshot as Snapshot) : undefined;
}

/**
 * Parses one incoming message and hands it to `plugin`. Activation is answered before the
 * plugin sees it, so a plugin cannot forget the handshake. Malformed messages are dropped.
 */
export function dispatch(plugin: Plugin, json: string): void {
  let message: unknown;
  try {
    message = JSON.parse(json);
  } catch {
    return;
  }
  if (!isObject(message)) return;
  const params = isObject(message.params) ? message.params : undefined;
  switch (message.method) {
    case "alas/activate": {
      send({ jsonrpc: "2.0", id: message.id ?? null, result: {} });
      const project = params?.project;
      if (!isObject(project) || typeof project.id !== "string" || typeof project.name !== "string") return;
      const grants = Array.isArray(params!.grants) ? params!.grants.filter((g: unknown) => typeof g === "string") : [];
      const api = typeof params!.api === "number" ? params!.api : 4;
      return plugin.handle({ type: "activate", api, projectId: project.id, projectName: project.name, grants });
    }
    case "alas/deactivate":
      return plugin.handle({ type: "deactivate" });
    case "workspace/changed": {
      const snapshot = snapshotOf(params);
      return snapshot && plugin.handle({ type: "workspaceChanged", snapshot });
    }
    case "tick":
      return typeof params?.dt === "number" ? plugin.handle({ type: "tick", dt: params.dt }) : undefined;
    case "canvas/click":
      if (typeof params?.tab !== "number" || typeof params.region !== "string") return;
      return plugin.handle({ type: "click", tab: params.tab, region: params.region });
    case "view/event": {
      if (typeof params?.id !== "string" || typeof params.kind !== "string") return;
      const value = typeof params.value === "string" ? params.value : undefined;
      if (typeof params.panel === "string") {
        return plugin.handle({ type: "panelEvent", panel: params.panel, ...placeOf(params), id: params.id, kind: params.kind, value });
      }
      if (typeof params.tab !== "number") return;
      return plugin.handle({ type: "viewEvent", tab: params.tab, id: params.id, kind: params.kind, value });
    }
    case "command/run": {
      const target = commandTarget(params?.target);
      if (typeof params?.command !== "string" || !target) return;
      return plugin.handle({ type: "command", command: params.command, target });
    }
    case "session/state":
      if (typeof params?.session !== "string" || typeof params.worktree !== "string" || typeof params.state !== "string") return;
      return plugin.handle({ type: "sessionState", session: params.session, worktree: params.worktree, state: params.state });
    case "session/finished":
      if (typeof params?.session !== "string" || typeof params.worktree !== "string") return;
      return plugin.handle({ type: "sessionFinished", session: params.session, worktree: params.worktree });
    case "settings/changed": {
      const values = settingValues(params);
      return values && plugin.handle({ type: "settings", values, secretsSet: secretsSet(params), changed: true });
    }
    case "timer/fired":
      return typeof params?.id === "string" ? plugin.handle({ type: "timer", id: params.id }) : undefined;
    case "panel/visible":
      if (typeof params?.panel !== "string" || typeof params.visible !== "boolean") return;
      return plugin.handle({ type: "panelVisible", panel: params.panel, ...placeOf(params), visible: params.visible });
    case "worktree/created":
    case "worktree/removed":
    case "git/changed":
    case "focus/changed": {
      const type = worktreeEvents[message.method as keyof typeof worktreeEvents];
      return typeof params?.worktree === "string" ? plugin.handle({ type, worktree: params.worktree }) : undefined;
    }
    case "run/started":
    case "run/finished": {
      if (typeof params?.worktree !== "string" || typeof params.script !== "string" || typeof params.run !== "string") return;
      const run = { worktree: params.worktree, script: params.script, run: params.run };
      if (message.method === "run/started") return plugin.handle({ type: "runStarted", ...run });
      if (!["succeeded", "failed", "stopped", "unknown"].includes(params.outcome)) return;
      const exitCode = typeof params.exitCode === "number" ? { exitCode: params.exitCode } : {};
      return plugin.handle({ type: "runFinished", ...run, outcome: params.outcome, ...exitCode });
    }
    case "review/changed": {
      if (typeof params?.worktree !== "string" || !["open", "closed", "merged", "none"].includes(params.state)) return;
      const c = params.checks;
      const checks = isObject(c) && typeof c.passed === "number" && typeof c.failed === "number" && typeof c.pending === "number"
        ? { checks: { passed: c.passed, failed: c.failed, pending: c.pending } }
        : {};
      const number = typeof params.number === "number" ? { number: params.number } : {};
      return plugin.handle({ type: "reviewChanged", worktree: params.worktree, state: params.state, ...number, ...checks });
    }
    case "process/exited":
      if (typeof params?.run !== "string" || typeof params.exit !== "number") return;
      return plugin.handle({ type: "processExited", run: params.run, exit: params.exit });
    case "prompt/expand":
      if (typeof params?.name !== "string" || typeof params.args !== "string" || typeof params.session !== "string") return;
      return plugin.handle({ type: "promptExpand", name: params.name, args: params.args, session: params.session, ...responder<string>(message.id) });
    case "context/provide":
      if (typeof params?.session !== "string" || typeof params.worktree !== "string") return;
      return plugin.handle({ type: "contextProvide", session: params.session, worktree: params.worktree, ...responder<string | null>(message.id) });
    case "task/failed":
      if (typeof params?.sessionId !== "string" || typeof params.reason !== "string") return;
      return plugin.handle({ type: "taskFailed", sessionId: params.sessionId, reason: params.reason });
    case undefined:
      break;
    default:
      return;
  }

  const id = message.id;
  if (typeof id !== "number" || !Number.isInteger(id)) return;
  const kind = typed.get(id);
  typed.delete(id);
  const error = rpcError(message.error);
  const callback = callbacks.get(id);
  if (callback) {
    callbacks.delete(id);
    return callback(error ? { error } : { result: message.result ?? null });
  }
  if (kind === "storage") {
    if (error) return plugin.handle({ type: "stored", id, error });
    if (!isObject(message.result)) return;
    return plugin.handle({ type: "stored", id, value: message.result.value ?? null });
  }
  if (error) return plugin.handle({ type: "reply", id, error });
  if (kind === "snapshot") {
    const snapshot = snapshotOf(message.result);
    return snapshot && plugin.handle({ type: "snapshot", snapshot });
  }
  if (kind === "settings") {
    const values = settingValues(message.result);
    return values && plugin.handle({ type: "settings", values, secretsSet: secretsSet(message.result), changed: false });
  }
  plugin.handle({ type: "reply", id, result: message.result ?? null });
}

/** Installs `plugin` as the script's `handle`. Call it once, at the top level of the entry file. */
export function definePlugin<P extends Plugin>(plugin: P): P {
  globalThis.handle = (json) => dispatch(plugin, json);
  return plugin;
}
