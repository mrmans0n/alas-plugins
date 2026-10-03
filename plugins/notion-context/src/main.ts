// A Notion page as context for every agent prompt. `context/provide` must be answered within the
// same call, so the page is fetched ahead of time (on activation, when a setting changes, and every
// 10 minutes) and the prompt is answered from that copy. The token is a secret: Alas substitutes it
// into the Authorization header, so this script only holds the `{{secret:token}}` placeholder.

import { definePlugin, fetch, getSettings, log, setTimer, type Event, type Plugin } from "@alas/plugin";
import { CONTEXT_BYTES, parsePageId, renderBlocks, truncate, type Block } from "./notion.ts";

const REFRESH_SECONDS = 600;
/** Requests per refresh, top-level pages and nested children together. */
const MAX_REQUESTS = 30;
/** How far below the page's own blocks nested children are fetched. */
const MAX_DEPTH = 3;
const HEADERS = { Authorization: "Bearer {{secret:token}}", "Notion-Version": "2022-06-28" };

/** A block list still to read: `id`'s children, appended to `into`. */
interface Work {
  id: string;
  into: Block[];
  depth: number;
  cursor?: string;
}

class NotionContext implements Plugin {
  private pageId: string | undefined;
  private tokenSet = false;
  /** The rendered page, or null when there is nothing to add. */
  private cached: string | null = null;
  private loading = false;
  private reloadAfter = false;

  handle(event: Event): void {
    switch (event.type) {
      case "activate":
        getSettings();
        setTimer("refresh", REFRESH_SECONDS, true);
        return;
      case "settings": {
        const page = typeof event.values.page === "string" ? event.values.page.trim() : "";
        this.pageId = parsePageId(page);
        if (page && !this.pageId) log("warn", "The page setting is not a Notion page URL or ID.");
        this.tokenSet = event.secretsSet.includes("token");
        this.cached = null;
        return this.refresh();
      }
      case "timer":
        return event.id === "refresh" ? this.refresh() : undefined;
      case "contextProvide":
        return event.respond(this.cached);
    }
  }

  private refresh(): void {
    if (!this.tokenSet || !this.pageId) {
      this.cached = null;
      return;
    }
    if (this.loading) {
      this.reloadAfter = true;
      return;
    }
    this.loading = true;
    const page: Block[] = [];
    this.fetchTree(page, [{ id: this.pageId, into: page, depth: 0 }], 0);
  }

  /**
   * Fetches block lists one request at a time, in document order: `work` is a stack whose top is
   * the next list (or page of a list) to read. Stops at `MAX_REQUESTS`, or once the page renders
   * past the context limit, and keeps what it has.
   */
  private fetchTree(page: Block[], work: Work[], requests: number): void {
    const text = renderBlocks(page);
    const next = work.pop();
    // Characters never outnumber UTF-8 bytes, so past the limit in characters is past it in bytes.
    if (!next || requests >= MAX_REQUESTS || text.length >= CONTEXT_BYTES) {
      this.loading = false;
      this.cached = text ? truncate(text) : null;
      return;
    }
    const { id, into, depth, cursor } = next;
    const query = cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : "";
    const url = `https://api.notion.com/v1/blocks/${encodeURIComponent(id)}/children?page_size=100${query}`;
    fetch({ method: "GET", url, headers: HEADERS }, ({ response, error }) => {
      if (this.reloadAfter) return this.restart();
      let body: any;
      let failure = error?.message;
      if (response) {
        try {
          body = JSON.parse(response.body);
        } catch {
          failure = `HTTP ${response.status}, not JSON`;
        }
        if (!failure && response.status !== 200) failure = `HTTP ${response.status}${typeof body?.message === "string" ? `: ${body.message}` : ""}`;
      }
      if (failure) {
        if (depth === 0) return this.failed(failure);
        // A nested block that cannot be read (a synced block from an unshared page) is left out.
        log("debug", `Skipped the children of block ${id}: ${failure}`);
        return this.fetchTree(page, work, requests + 1);
      }
      const blocks: Block[] = Array.isArray(body?.results) ? body.results.filter((b: unknown) => typeof b === "object" && b !== null) : [];
      into.push(...blocks);
      // Pushed in reverse so the next page of this list comes after the children of this page.
      if (body?.has_more && typeof body.next_cursor === "string") work.push({ id, into, depth, cursor: body.next_cursor });
      if (depth < MAX_DEPTH) {
        for (const block of blocks.toReversed()) {
          // A child page's or database's children are another page, not this one's content.
          if (block.has_children !== true || typeof block.id !== "string" || block.type === "child_page" || block.type === "child_database") continue;
          block.children = [];
          work.push({ id: block.id, into: block.children, depth: depth + 1 });
        }
      }
      this.fetchTree(page, work, requests + 1);
    });
  }

  /** The last good copy stays until the next fetch works; a settings change already cleared it. */
  private failed(reason: string): void {
    this.loading = false;
    log("warn", `Could not fetch the Notion page: ${reason}`);
  }

  private restart(): void {
    this.loading = false;
    this.reloadAfter = false;
    this.refresh();
  }
}

definePlugin(new NotionContext());
