/**
 * SDK for Alas plugins, API 4 and 5: one `plugin.js` evaluated in a bare JavaScriptCore context.
 * Handles the JSON-RPC framing, the activation handshake and request ids. API 5 helpers
 * (commands, notify, session events, settings, `fetch`, timers, panels) need `"api": 5`.
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

/** Where a command was chosen: the current project, or a worktree by its `workspace/snapshot` id. */
export type CommandTarget = { kind: "project" } | { kind: "worktree"; worktree: string };

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
  | { type: "activate"; projectId: string; projectName: string; grants: string[] }
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
  /** API 5: a control in a panel was used; see `viewEvent`. */
  | { type: "panelEvent"; panel: string; id: string; kind: string; value?: string }
  /** API 5: a panel was shown or hidden. */
  | { type: "panelVisible"; panel: string; visible: boolean }
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

/** API 5: replaces the tree shown in the manifest's panel `panel`. */
export function renderPanel(panel: string, root: Node): void {
  sendNotification("view/render", { panel, root });
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
      return plugin.handle({ type: "activate", projectId: project.id, projectName: project.name, grants });
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
        return plugin.handle({ type: "panelEvent", panel: params.panel, id: params.id, kind: params.kind, value });
      }
      if (typeof params.tab !== "number") return;
      return plugin.handle({ type: "viewEvent", tab: params.tab, id: params.id, kind: params.kind, value });
    }
    case "command/run": {
      const target = params?.target;
      if (typeof params?.command !== "string" || !isObject(target)) return;
      if (target.kind === "project") return plugin.handle({ type: "command", command: params.command, target: { kind: "project" } });
      if (target.kind !== "worktree" || typeof target.worktree !== "string") return;
      return plugin.handle({ type: "command", command: params.command, target: { kind: "worktree", worktree: target.worktree } });
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
      return plugin.handle({ type: "panelVisible", panel: params.panel, visible: params.visible });
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
