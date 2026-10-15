/**
 * The page side of an API 12 web tab: types and helpers for `ui.js`, which runs in Alas's sandboxed
 * web view (no network, no inline script, nothing kept between loads). Its only link to Alas is the
 * global `alas`, and everything it posts goes to its own plugin, which answers with `webPost`.
 *
 * The page loads when its tab is shown and is thrown away when it is hidden, so post a "ready"
 * message on start (see `connect`) and have the plugin answer with the state to show.
 */

export interface PageContext {
  /** A web tab's index in the manifest's tabs. */
  tab?: number;
  /** API 15: a web panel's id. */
  panel?: string;
  theme: "light" | "dark";
}

/** The global `alas` in a page. */
export interface PageHost {
  /**
   * Sends any JSON value to the plugin, in order. Throws a `TypeError` for a value JSON can't encode, a
   * `RangeError` over 1 MiB, and `Error("busy")` while 32 earlier messages are still waiting for the plugin.
   */
  post(message: unknown): void;
  /** Receives what the plugin sends with `webPost`; replaces the previous handler. */
  onMessage(handler: (message: unknown) => void): void;
  /** Updated when Alas's theme changes. */
  readonly context: PageContext;
  /** Called with the new context; replaces the previous handler. */
  onThemeChange(handler: (context: PageContext) => void): void;
}

/** The CSS variables the page shell sets from the Alas theme, updated when it changes. */
export type ThemeVariable =
  | "--alas-text" | "--alas-dim" | "--alas-accent" | "--alas-background" | "--alas-line"
  | "--alas-tone-danger" | "--alas-tone-success" | "--alas-tone-warning" | "--alas-tone-info";

/**
 * The page's `alas`. Not declared as a global here: plugin sources declare `alas` as the plugin host,
 * and both kinds of source typecheck together.
 */
export function pageHost(): PageHost {
  return (globalThis as any).alas;
}

/** Installs `handler` for the plugin's messages, then posts `ready` so the plugin can answer with the state. */
export function connect(handler: (message: unknown) => void, ready: unknown = { ready: true }): void {
  const host = pageHost();
  host.onMessage(handler);
  host.post(ready);
}

/** A theme variable's current value, e.g. for a canvas or a chart library that can't use `var(...)`. */
export function themeColor(name: ThemeVariable): string {
  const g = globalThis as any;
  return g.getComputedStyle(g.document.documentElement).getPropertyValue(name).trim();
}
