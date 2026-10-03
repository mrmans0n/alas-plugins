// Pure helpers: a page id from what the user pasted, Notion blocks as Markdown-ish text, and a
// cut that keeps the text under Alas's 16 KiB context limit.

/** Alas skips context over 16 KiB. */
export const CONTEXT_BYTES = 16 * 1024;
export const TRUNCATED = "\n\n[… the rest of the page was cut]";

/**
 * The page id, dashed and lowercase, from a bare id (dashed or not) or a page URL such as
 * `https://www.notion.so/acme/Roadmap-1a2b…?pvs=4`. Undefined when there is none.
 */
export function parsePageId(input: string): string | undefined {
  const path = input.trim().split(/[?#]/)[0].replaceAll("-", "");
  // The id ends the path's last hex run; a slug word made of hex letters may sit right before it.
  const run = [...path.matchAll(/[0-9a-f]{32,}/gi)].at(-1)?.[0];
  if (!run) return undefined;
  const id = run.slice(-32).toLowerCase();
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

/** One block from `GET /v1/blocks/{id}/children`, as far as it is rendered. */
export interface Block {
  type: string;
  [type: string]: any;
}

const LIST_TYPES = new Set(["bulleted_list_item", "numbered_list_item", "to_do"]);

function plain(richText: unknown): string {
  return Array.isArray(richText) ? richText.map((t) => (typeof t?.plain_text === "string" ? t.plain_text : "")).join("") : "";
}

function renderBlock(block: Block): string | undefined {
  const data = block[block.type];
  if (typeof data !== "object" || data === null) return undefined;
  const text = plain(data.rich_text);
  switch (block.type) {
    case "paragraph":
      return text;
    case "heading_1":
      return `# ${text}`;
    case "heading_2":
      return `## ${text}`;
    case "heading_3":
      return `### ${text}`;
    case "bulleted_list_item":
      return `- ${text}`;
    case "numbered_list_item":
      return `1. ${text}`;
    case "to_do":
      return `- [${data.checked ? "x" : " "}] ${text}`;
    case "code":
      return "```" + (typeof data.language === "string" && data.language !== "plain text" ? data.language : "") + `\n${text}\n` + "```";
    case "quote":
      return `> ${text.replaceAll("\n", "\n> ")}`;
    case "callout": {
      const emoji = data.icon?.type === "emoji" && typeof data.icon.emoji === "string" ? `${data.icon.emoji} ` : "";
      return `> ${emoji}${text.replaceAll("\n", "\n> ")}`;
    }
    default:
      return undefined;
  }
}

/**
 * Blocks as Markdown-ish text: consecutive list items one per line, everything else a paragraph.
 * Empty paragraphs and block types not listed above are skipped; nested children are not fetched.
 */
export function renderBlocks(blocks: Block[]): string {
  let out = "";
  let lastWasList = false;
  for (const block of blocks) {
    const text = renderBlock(block);
    if (text === undefined || !text.trim()) continue;
    const isList = LIST_TYPES.has(block.type);
    if (out) out += isList && lastWasList ? "\n" : "\n\n";
    out += text;
    lastWasList = isList;
  }
  return out;
}

function utf8Length(c: number): number {
  // A surrogate half counts 2, so a pair counts the 4 bytes it encodes to.
  return c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdfff ? 2 : 3;
}

/** `text` when it fits in `max` UTF-8 bytes; otherwise cut at a line break where one is near, and marked. */
export function truncate(text: string, max = CONTEXT_BYTES): string {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) bytes += utf8Length(text.charCodeAt(i));
  if (bytes <= max) return text;
  const budget = max - TRUNCATED.length * 3;
  let end = 0;
  for (bytes = 0; end < text.length; end++) {
    bytes += utf8Length(text.charCodeAt(end));
    if (bytes > budget) break;
  }
  // Never split a surrogate pair.
  if (end > 0 && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--;
  const lineBreak = text.lastIndexOf("\n", end);
  if (lineBreak > end / 2) end = lineBreak;
  return text.slice(0, end).trimEnd() + TRUNCATED;
}
