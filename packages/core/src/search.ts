// The gateway's part of the Cmd/Ctrl+K palette (docs/design/search.md): one
// request shape per source, all at `operator.read`. Each answer goes to the
// viewer that asked and nothing is kept here; the query is never logged.
//
// What each method matches, returns and leaves out is in
// docs/research/search.md.

import { cutText } from "./bounds.ts";
import { establishFolder } from "./files.ts";
import { asRecord, botIdFromSessionKey, type RawRecord } from "./mapping.ts";
import { MAX_ID_CHARS } from "./state-bounds.ts";
import { MAX_TASK_LABEL_CHARS } from "./task-actions.ts";

/** The gateway's limit on a query (`sessions.search`); the palette's field stops there. */
export const MAX_SEARCH_QUERY_CHARS = 4_096;
/** Matches one message search asks for: the gateway's most (research §5). */
export const MESSAGE_SEARCH_LIMIT = 25;
/** Routines asked for a page at a time (search.md §5). */
export const ROUTINE_SEARCH_PAGE = 50;
/**
 * File names kept from one bot's reply, so the largest answer fits a web
 * viewer's result frame; the gateway itself stops at 500. Past it the answer
 * says how many it returned.
 */
export const MAX_FILE_HITS = 100;
/** A snippet as shown: the gateway sends at most 500 characters (research §4). */
export const MAX_SNIPPET_CHARS = 500;
/** A routine's description as shown in a result. */
export const MAX_ROUTINE_DESCRIPTION_CHARS = 512;
/** A path as shown in a result. */
export const MAX_FILE_HIT_CHARS = 1_024;
/** Search requests the host sends at once: a message search, a routine page and two lanes of four. */
export const MAX_SEARCHES_IN_FLIGHT = 10;

type Request = (method: string, params: unknown) => Promise<unknown>;

export type MessageHit = {
  sessionKey: string;
  sessionId: string | null;
  messageId: string;
  botId: string;
  role: "user" | "assistant";
  timestamp: number | null;
  /** As the gateway sent it, with no marks: the reply gives no matching ranges. */
  snippet: string;
};

export type MessageSearch = {
  hits: MessageHit[];
  /** The matched tasks' titles from the reply's `sessions` rows, by key. */
  titles: Record<string, string>;
  /** The searched index holds more matches than were returned. */
  truncated: boolean;
  /** Part of the index was still catching up. */
  indexing: boolean;
  /** Tasks whose archived transcript content was not searched. */
  archivedExcluded: number;
};

export type RoutineHit = {
  id: string;
  name: string;
  description: string;
  botId: string;
  enabled: boolean;
};

export type RoutineSearch = {
  offset: number;
  routines: RoutineHit[];
  total: number | null;
  hasMore: boolean;
  nextOffset: number | null;
  /** The revision of the list this page was cut from, when the gateway gives one. */
  revision: string | null;
};

export type FileSearch =
  | {
      status: "searched";
      botId: string;
      /** File paths only: a matching folder is not a result. At most `MAX_FILE_HITS`. */
      paths: string[];
      /** File names the gateway returned, before `MAX_FILE_HITS`. */
      returned: number;
      /** The walk stopped at its limit of 500 names or 5,000 entries. */
      truncated: boolean;
    }
  /** The bot has no listed task whose root is established as its workspace. */
  | { status: "unverified"; botId: string }
  /** The gateway returned no root for the task, so nothing was searched. */
  | { status: "no-root"; botId: string };

const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
/** An id is used whole to open its result: one past the cap is dropped, never cut. */
const exactId = (value: unknown): string | null => {
  const id = str(value);
  return id !== null && id.length <= MAX_ID_CHARS ? id : null;
};

/** `sessions.search` across bots, or one bot's, with the task list's own filters (search.md §5). */
export async function searchMessages(
  request: Request,
  query: string,
  botId: string | null,
): Promise<MessageSearch> {
  const reply = asRecord(
    await request("sessions.search", {
      query,
      scope: {
        excludeCron: true,
        excludeSubagents: true,
        ...(botId !== null ? { agentId: botId } : {}),
      },
      limit: MESSAGE_SEARCH_LIMIT,
    }),
  );
  return readMessageSearch(reply);
}

export function readMessageSearch(reply: RawRecord | null): MessageSearch {
  const hits: MessageHit[] = [];
  for (const raw of Array.isArray(reply?.results) ? reply.results : []) {
    const row = asRecord(raw);
    const sessionKey = exactId(row?.sessionKey);
    const messageId = exactId(row?.messageId);
    const botId = sessionKey ? botIdFromSessionKey(sessionKey) : null;
    const role = row?.role === "user" || row?.role === "assistant" ? row.role : null;
    if (!row || !sessionKey || !messageId || !botId || !role) continue;
    hits.push({
      sessionKey,
      sessionId: exactId(row.sessionId),
      messageId,
      botId,
      role,
      timestamp: num(row.timestamp),
      snippet: cutText(typeof row.snippet === "string" ? row.snippet : "", MAX_SNIPPET_CHARS),
    });
    if (hits.length === MESSAGE_SEARCH_LIMIT) break;
  }
  const titles: Record<string, string> = {};
  for (const raw of Array.isArray(reply?.sessions) ? reply.sessions : []) {
    const row = asRecord(raw);
    const key = exactId(row?.key);
    const title = str(row?.label) ?? str(row?.displayName);
    if (key && title && hits.some((hit) => hit.sessionKey === key))
      titles[key] = cutText(title, MAX_TASK_LABEL_CHARS);
  }
  const archived = num(reply?.archivedTranscriptsExcluded);
  return {
    hits,
    titles,
    truncated: reply?.truncated === true,
    indexing: reply?.indexing === true,
    archivedExcluded: archived !== null && archived > 0 ? Math.floor(archived) : 0,
  };
}

/** One page of `cron.list`, on or off, matching the query (search.md §5). */
export async function searchRoutines(
  request: Request,
  query: string,
  offset: number,
): Promise<RoutineSearch> {
  const reply = asRecord(
    await request("cron.list", { query, enabled: "all", limit: ROUTINE_SEARCH_PAGE, offset }),
  );
  return readRoutineSearch(reply, offset);
}

export function readRoutineSearch(reply: RawRecord | null, offset: number): RoutineSearch {
  const routines: RoutineHit[] = [];
  for (const raw of Array.isArray(reply?.jobs) ? reply.jobs : []) {
    const job = asRecord(raw);
    const id = exactId(job?.id);
    // The bot as the Routines view resolves it (routines.ts), so both list the same routines.
    const botId = exactId(job?.agentId) ?? exactId(job?.effectiveAgentId) ?? "main";
    if (!job || !id) continue;
    routines.push({
      id,
      name: cutText(str(job.name) ?? id, MAX_TASK_LABEL_CHARS),
      description: cutText(str(job.description) ?? "", MAX_ROUTINE_DESCRIPTION_CHARS),
      botId,
      enabled: job.enabled !== false,
    });
    if (routines.length === ROUTINE_SEARCH_PAGE) break;
  }
  const next = num(reply?.nextOffset);
  const revision = reply?.snapshotRevision;
  return {
    offset,
    routines,
    total: num(reply?.total),
    hasMore: reply?.hasMore === true,
    nextOffset: next !== null && Number.isInteger(next) && next > offset ? next : null,
    revision:
      typeof revision === "string" || typeof revision === "number"
        ? cutText(String(revision), 128)
        : null,
  };
}

/**
 * One bot's file names (`sessions.files.list {sessionKey, search}`), through
 * `sessionKey`, the bot's newest listed task. The names are used only when that
 * task's row (`sessions.describe`) carries no folder of its own and the list
 * returned a root: then the root is the bot's workspace (search.md §5).
 */
export async function searchFiles(
  request: Request,
  query: string,
  botId: string,
  sessionKey: string | null,
): Promise<FileSearch> {
  if (sessionKey === null) return { status: "unverified", botId };
  const [listed, described] = await Promise.all([
    request("sessions.files.list", { sessionKey, search: query }),
    request("sessions.describe", { key: sessionKey }).catch(() => null),
  ]);
  const list = asRecord(listed);
  const root = str(list?.root);
  const folder = establishFolder(asRecord(asRecord(described)?.session), root);
  if (folder.kind !== "workspace") return { status: "unverified", botId };
  if (!folder.sameAsWorkspace) return { status: "no-root", botId };
  const browser = asRecord(list?.browser);
  const files: string[] = [];
  for (const raw of Array.isArray(browser?.entries) ? browser.entries : []) {
    const entry = asRecord(raw);
    const path = str(entry?.path);
    if (entry?.kind === "file" && path) files.push(cutText(path, MAX_FILE_HIT_CHARS));
  }
  return {
    status: "searched",
    botId,
    paths: files.slice(0, MAX_FILE_HITS),
    returned: files.length,
    truncated: browser?.truncated === true,
  };
}
