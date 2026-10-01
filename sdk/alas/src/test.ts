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

globalThis.alas = {
  send(json) {
    if (typeof json !== "string") throw new TypeError("alas.send takes a string");
    if (Buffer.byteLength(json) > MAX_MESSAGE_BYTES) {
      throw new RangeError(`message over 1 MiB (${Buffer.byteLength(json)} bytes)`);
    }
    if (++sendsThisCall > MAX_SENDS_PER_CALL) throw new RangeError("more than 64 messages in one call");
    sent.push(json);
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
  },

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
