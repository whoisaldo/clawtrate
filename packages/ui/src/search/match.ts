// What the device matches itself (search.md §5): names anywhere in them,
// ignoring case and accents, and the links in the conversations it holds.

import type { Transcript } from "@clawtrate/core";

const foldChar = (char: string) => char.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** A name folded for matching, with each folded character's place in the name. */
function folded(text: string): { text: string; from: number[] } {
  let out = "";
  const from: number[] = [];
  let at = 0;
  for (const char of text) {
    const piece = foldChar(char);
    out += piece;
    // One place per UTF-16 unit, as indexOf and length count them.
    for (let unit = 0; unit < piece.length; unit += 1) from.push(at);
    at += char.length;
  }
  return { text: out, from };
}

/** Where the query appears in a name, as [start, end) in the name, or null. */
export function findIn(text: string, query: string): [number, number] | null {
  const q = folded(query).text;
  if (!q) return null;
  const name = folded(text);
  const index = name.text.indexOf(q);
  if (index < 0) return null;
  const start = name.from[index]!;
  const lastFrom = name.from[index + q.length - 1]!;
  const last = text.codePointAt(lastFrom)!;
  return [start, lastFrom + (last > 0xffff ? 2 : 1)];
}

export type IndexedLink = {
  /** The canonical serialization when it parses as an absolute address; else the text as written. */
  address: string;
  host: string | null;
  /** Why it can't be handed over, when it can't. */
  refused: string | null;
  sessionKey: string;
  messageId: string;
  role: "user" | "assistant";
};

// shortcut: a pattern for markdown links and GFM's bare web addresses, not the parsed tree the
// conversation draws; upgrade with the link confirmation of #71, which brings one parser for both.
const LINK =
  /\[[^\]]*\]\(\s*<?([^\s)>]+)>?[^)]*\)|\b((?:https?:\/\/|www\.)[^\s<>()]+[^\s<>().,;:!?'"])/gi;

function canonical(raw: string): Pick<IndexedLink, "address" | "host" | "refused"> {
  let url: URL;
  try {
    url = new URL(/^www\./i.test(raw) ? `http://${raw}` : raw);
  } catch {
    return { address: raw, host: null, refused: "it isn't a web address" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { address: url.href, host: null, refused: "it isn't a web address" };
  if (url.username || url.password)
    return { address: raw, host: null, refused: "it carries a user name or password" };
  return { address: url.href, host: url.host, refused: null };
}

/** Links in the user and assistant messages of the transcripts this view holds, each with its message. */
export function indexLinks(transcripts: Record<string, Transcript>): IndexedLink[] {
  const out: IndexedLink[] = [];
  const seen = new Set<string>();
  for (const [sessionKey, transcript] of Object.entries(transcripts)) {
    if (transcript.status !== "ready") continue;
    for (const item of transcript.items) {
      if (item.role === "system") continue;
      for (const block of item.blocks) {
        if (block.kind !== "text") continue;
        const messageId = item.role === "user" ? item.messageId : block.messageId;
        if (!messageId) continue;
        for (const match of block.text.matchAll(LINK)) {
          const raw = match[1] ?? match[2];
          if (!raw) continue;
          const link = canonical(raw);
          // An address a message repeats is one result.
          const key = `${sessionKey}\n${messageId}\n${link.address}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ ...link, sessionKey, messageId, role: item.role });
        }
      }
    }
  }
  return out;
}

/** "Juniper", "Juniper and Otto", "Juniper, Otto and Pip". */
export function listed(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
