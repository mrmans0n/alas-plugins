// A Notion page as context for every agent prompt. `context/provide` must be answered within the
// same call, so the page is fetched ahead of time (on activation, when a setting changes, and every
// 10 minutes) and the prompt is answered from that copy. The token is a secret: Alas substitutes it
// into the Authorization header, so this script only holds the `{{secret:token}}` placeholder.

import { definePlugin, fetch, getSettings, log, setTimer, type Event, type Plugin } from "@alas/plugin";
import { CONTEXT_BYTES, parsePageId, renderBlocks, truncate, type Block } from "./notion.ts";

const REFRESH_SECONDS = 600;
/** 100 blocks a page; stop after this many pages, well past the context limit for real pages. */
const MAX_PAGES = 10;
const HEADERS = { Authorization: "Bearer {{secret:token}}", "Notion-Version": "2022-06-28" };

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
    this.fetchBlocks(this.pageId, undefined, [], 1);
  }

  private fetchBlocks(pageId: string, cursor: string | undefined, blocks: Block[], page: number): void {
    const query = cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : "";
    const url = `https://api.notion.com/v1/blocks/${pageId}/children?page_size=100${query}`;
    fetch({ method: "GET", url, headers: HEADERS }, ({ response, error }) => {
      if (this.reloadAfter) return this.restart();
      if (error) return this.failed(error.message);
      let body: any;
      try {
        body = JSON.parse(response.body);
      } catch {
        return this.failed(`HTTP ${response.status}, not JSON`);
      }
      if (response.status !== 200) {
        return this.failed(`HTTP ${response.status}${typeof body?.message === "string" ? `: ${body.message}` : ""}`);
      }
      if (Array.isArray(body?.results)) blocks.push(...body.results);
      const text = renderBlocks(blocks);
      // Characters never outnumber UTF-8 bytes, so past the limit in characters is past it in bytes.
      if (body?.has_more && typeof body.next_cursor === "string" && page < MAX_PAGES && text.length < CONTEXT_BYTES) {
        return this.fetchBlocks(pageId, body.next_cursor, blocks, page + 1);
      }
      this.loading = false;
      this.cached = text ? truncate(text) : null;
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
