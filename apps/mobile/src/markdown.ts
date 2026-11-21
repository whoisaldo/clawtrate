// The bot's markdown, read by the same parser family the desktop's renderer
// uses (micromark and mdast, with GitHub's extensions: tables, strikethrough,
// autolinks), and reduced to the few blocks and inlines the iOS bubble draws.
// Raw HTML is shown as text and never interpreted. A link opens in the system
// browser, and only when it is an http or https address that parses; any other
// is its text. A link whose visible text is not its own address shows the
// address's host and asks before leaving the app. Pure, so the unit tests cover it.

import type { Nodes, PhrasingContent, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

export type Inline =
  | { t: "text"; text: string }
  | { t: "strong"; children: Inline[] }
  | { t: "em"; children: Inline[] }
  | { t: "del"; children: Inline[] }
  | { t: "code"; text: string }
  | {
      t: "link";
      url: string;
      /** The destination's host, which the screen shows and VoiceOver names. */
      host: string;
      /** The visible text is the address itself: it opens without asking. */
      plain: boolean;
      children: Inline[];
    }
  | { t: "break" };

export type Block =
  | { t: "p"; children: Inline[] }
  | { t: "h"; depth: number; children: Inline[] }
  | { t: "list"; ordered: boolean; start: number; items: Block[][] }
  | { t: "code"; text: string }
  | { t: "quote"; children: Block[] }
  | { t: "rule" }
  | { t: "table"; header: Inline[][]; rows: Inline[][][] };

/** A link's address when it may open: http or https, and it parses with a host. */
export function openableUrl(url: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host !== ""
    ? parsed
    : null;
}

/** Whether a link's visible text is its own address (an autolink, or the address written out). */
function shownAddress(text: string, destination: URL): boolean {
  const label = text.trim();
  const source =
    openableUrl(label) ??
    (/^www\./i.test(label) ? openableUrl(`${destination.protocol}//${label}`) : null);
  return source?.href === destination.href;
}

/** The plain text of inlines. */
export function inlineText(nodes: Inline[]): string {
  return nodes
    .map((node) =>
      node.t === "text" || node.t === "code"
        ? node.text
        : node.t === "break"
          ? " "
          : inlineText(node.children),
    )
    .join("");
}

function textOf(node: Nodes): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  if ("children" in node) return (node.children as Nodes[]).map(textOf).join("");
  return "";
}

function inlines(nodes: PhrasingContent[]): Inline[] {
  return nodes.flatMap((node): Inline[] => {
    switch (node.type) {
      case "text":
        return [{ t: "text", text: node.value }];
      case "strong":
        return [{ t: "strong", children: inlines(node.children) }];
      case "emphasis":
        return [{ t: "em", children: inlines(node.children) }];
      case "delete":
        return [{ t: "del", children: inlines(node.children) }];
      case "inlineCode":
        return [{ t: "code", text: node.value }];
      case "break":
        return [{ t: "break" }];
      case "link": {
        const url = openableUrl(node.url);
        const children = inlines(node.children);
        if (!url) return children;
        return [
          {
            t: "link",
            url: url.href,
            host: url.host,
            plain: shownAddress(inlineText(children), url),
            children,
          },
        ];
      }
      case "image":
        return node.alt ? [{ t: "text", text: node.alt }] : [];
      default:
        // Raw HTML, footnote references and anything else: their text, never markup.
        return [{ t: "text", text: textOf(node) }];
    }
  });
}

function blocks(nodes: RootContent[]): Block[] {
  return nodes.flatMap((node): Block[] => {
    switch (node.type) {
      case "paragraph":
        return [{ t: "p", children: inlines(node.children) }];
      case "heading":
        return [{ t: "h", depth: node.depth, children: inlines(node.children) }];
      case "list":
        return [
          {
            t: "list",
            ordered: node.ordered === true,
            start: node.start ?? 1,
            items: node.children.map((item) => blocks(item.children)),
          },
        ];
      case "code":
        return [{ t: "code", text: node.value }];
      case "blockquote":
        return [{ t: "quote", children: blocks(node.children) }];
      case "thematicBreak":
        return [{ t: "rule" }];
      case "table": {
        const [head, ...body] = node.children;
        const cells = (row: typeof head) =>
          row ? row.children.map((cell) => inlines(cell.children)) : [];
        return [{ t: "table", header: cells(head), rows: body.map(cells) }];
      }
      case "html":
        return node.value.trim() ? [{ t: "p", children: [{ t: "text", text: node.value }] }] : [];
      default: {
        const text = textOf(node);
        return text.trim() ? [{ t: "p", children: [{ t: "text", text }] }] : [];
      }
    }
  });
}

export function parseMarkdown(text: string): Block[] {
  const tree = fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  return blocks(tree.children);
}

/** A table column's width bounds, in points: a narrow column still reads, a wide one wraps. */
export const COLUMN_WIDTH = { min: 72, max: 240 } as const;

/**
 * Each column's width, the same in every row: its longest cell's text at an
 * average glyph width of the font size's 0.55, plus the cell's 16 points of
 * padding, within COLUMN_WIDTH. Every cell of a column gets that width, so
 * the columns line up and nothing is measured against an unbounded width.
 */
export function columnWidths(table: Extract<Block, { t: "table" }>, fontSize: number): number[] {
  const rows = [table.header, ...table.rows];
  const columns = Math.max(0, ...rows.map((row) => row.length));
  return Array.from({ length: columns }, (_, k) => {
    const longest = Math.max(0, ...rows.map((row) => inlineText(row[k] ?? []).length));
    const width = Math.ceil(longest * fontSize * 0.55) + 16;
    return Math.min(COLUMN_WIDTH.max, Math.max(COLUMN_WIDTH.min, width));
  });
}

/** What the app asks before it leaves for a link whose text is not its address. */
export const LINK_WORDS = {
  ask: "Open this link?",
  open: "Open",
  cancel: "Cancel",
  /** VoiceOver's name for a link: its text, then where it goes. */
  spoken: (text: string, host: string) => `${text}, link to ${host}`,
} as const;
