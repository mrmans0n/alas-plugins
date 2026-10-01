/**
 * A fake Alas for unit tests under `node --test`. Importing this module installs a global
 * `alas` that records what the plugin sends and presents, and enforces the host's per-call
 * limits, so a test fails where Alas would stop the plugin.
 *
 * Node has more globals than Alas (`console`, timers, `process`), so a plugin that passes here
 * can still fail in Alas; the repository's typecheck rejects those globals in plugin sources.
 */

export interface Frame {
  tab: number;
  width: number;
  pixels: Uint8Array;
}

const MAX_MESSAGE_BYTES = 1 << 20;
const MAX_SENDS_PER_CALL = 64;
const MAX_FRAME_BYTES = 4 << 20;

let sent: string[] = [];
let frames: Frame[] = [];
let sendsThisCall = 0;
/** Refusals Alas would answer an `http/fetch` with, delivered after the call that sent it. */
let refusals: object[] = [];
const secrets = new Set<string>();

/** Like Alas, an `http/fetch` naming an unset `{{secret:key}}` is refused without making the request. */
function refuseUnsetSecret(json: string): void {
  const message = JSON.parse(json);
  if (message.method !== "http/fetch") return;
  for (const value of Object.values<string>(message.params?.headers ?? {})) {
    for (const [, key] of String(value).matchAll(/\{\{secret:([^}]*)\}\}/g)) {
      if (!secrets.has(key)) {
        refusals.push({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: `secret ${key} is not set` } });
        return;
      }
    }
  }
}

globalThis.alas = {
  send(json) {
    if (typeof json !== "string") throw new TypeError("alas.send takes a string");
    if (Buffer.byteLength(json) > MAX_MESSAGE_BYTES) {
      throw new RangeError(`message over 1 MiB (${Buffer.byteLength(json)} bytes)`);
    }
    if (++sendsThisCall > MAX_SENDS_PER_CALL) throw new RangeError("more than 64 messages in one call");
    sent.push(json);
    refuseUnsetSecret(json);
  },
  present(tab, pixels, width) {
    if (!(pixels instanceof Uint8Array)) throw new TypeError("alas.present takes a Uint8Array");
    const height = pixels.length / (width * 4);
    if (!Number.isInteger(width) || width < 1 || width > 1024 || !Number.isInteger(height) || height < 1 || height > 1024 || pixels.length > MAX_FRAME_BYTES) {
      throw new RangeError(`invalid frame: ${pixels.length} bytes at width ${width}`);
    }
    frames.push({ tab, width, pixels: pixels.slice() });
  },
};

export const testHost = {
  /** Delivers one message to the plugin's `handle`, as one host call. */
  dispatch(message: string | object): void {
    const handle = globalThis.handle;
    if (!handle) throw new Error("no plugin defined: call definePlugin first");
    sendsThisCall = 0;
    try {
      handle(typeof message === "string" ? message : JSON.stringify(message));
    } finally {
      sendsThisCall = 0;
    }
    const pending = refusals;
    refusals = [];
    for (const refusal of pending) testHost.dispatch(refusal);
  },

  /** Delivers the notification `method`, e.g. `timer/fired`, `settings/changed`, `panel/visible`, `session/finished`. */
  notify(method: string, params: object = {}): void {
    testHost.dispatch({ jsonrpc: "2.0", method, params });
  },

  /** Answers request `id`, e.g. an `http/fetch` with `{status, headers, body}`. */
  reply(id: number, result: unknown): void {
    testHost.dispatch({ jsonrpc: "2.0", id, result });
  },

  replyError(id: number, code: number, message: string): void {
    testHost.dispatch({ jsonrpc: "2.0", id, error: { code, message } });
  },

  /** Secrets the user has set. An `http/fetch` naming any other is refused with -32602, as in Alas. */
  secrets,

  /** Every message sent since the last call, parsed. */
  takeSent(): any[] {
    const out = sent.map((json) => JSON.parse(json));
    sent = [];
    return out;
  },

  /** Every frame presented since the last call, copied. */
  takeFrames(): Frame[] {
    const out = frames;
    frames = [];
    return out;
  },
};
