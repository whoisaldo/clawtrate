// The reading of an action (docs/design/conversation.md, sections 7 and 8):
// from a tool call's name, arguments and result to its kind, the words of its
// line, its outcome and its fold key. Pure functions with no retained state,
// shared by the desktop interface and the iOS app.
//
// Nothing in a tool event names the kind of action, so it is chosen from the
// tool's name by the table in 8.1. A result without an error flag is not, by
// itself, proof that the work was done: every kind goes through one general
// reading of the payload (7.3), and a kind's adapter only makes it more
// exact. Nothing reaches Done by default. Every word comes from
// `action-words.ts`.

import { T3_CODE_TOOLS } from "./cards.ts";
import {
  FORMS,
  LABELS,
  MEDIA,
  NEUTRAL,
  NOUNS,
  OBJECTS,
  OUTCOME_SENTENCES,
  PLURALS,
  PROBLEM_WORDS,
  SCHEDULE,
  SHORT_WORDS,
  STATE_WORDS,
  VERBS,
  count,
  mediaCount,
  mediaGeneration,
  mediaModels,
  nextCheck,
  someonesTask,
  spokenSeconds,
  theGoalStatus,
  tookWords,
  type VerbForms,
} from "./action-words.ts";

type Rec = Record<string, unknown>;

// The call ---------------------------------------------------------------------------

/**
 * What the event stream has established about a call before its result is
 * read: `running` from its start, `waiting` while an approval names it,
 * `review` while the automatic review decides, `returned` once a result came
 * (the reading then decides), `stopped` when its run stopped before a result
 * came, `cut-off` when its run hit its time limit while it ran, and
 * `unreturned` when its run ended otherwise and no result is known.
 */
export type CallStatus =
  "running" | "waiting" | "review" | "returned" | "stopped" | "cut-off" | "unreturned";

export type ActionCall = {
  /** The gateway's tool call id. */
  id: string;
  /** The tool's name exactly as the gateway sent it. */
  name: string;
  /** The arguments, or the engine's projection of them (`projectArgs`). Empty when unknown. */
  args: Rec;
  status: CallStatus;
  /** The result was flagged as an error. */
  isError: boolean;
  /** The result's text as received, possibly cut; null before a result. */
  text: string | null;
  /** The result's `details`, or its projection (`projectDetails`); null when none was kept. */
  details: Rec | null;
  /** The gateway marked the call as a shell command. */
  commandBearing: boolean;
  startedAt: number | null;
  endedAt: number | null;
  /** Rebuilt from history, which keeps `details` for some tools only. */
  fromHistory: boolean;
  /** Output streamed while the call runs. */
  partial?: string | null;
  /**
   * The gateway's own list of built-in and plugin tools, when known: a name
   * with no row of its own folds only when it is listed there (8.3).
   */
  builtin?: boolean;
  /** The run is read on a connection that is not sent approvals (7.10). */
  readOnly?: boolean;
  /** The connection was lost while the call was open. */
  lastSeen?: boolean;
  /** Its run was stopped: an error result that says nothing more is the stop's, not a failure. */
  runStopped?: boolean;
  /** The gateway's own English title for the call (`item.title`), as sent; for the general card. */
  gatewayTitle?: string | null;
  /**
   * The result's text here is not the whole of it: the gateway cut what it
   * stored or sent (`__openclaw.truncated`), or this app kept a prefix. What
   * only the cut part said is not known, so text alone never makes it Done.
   */
  cut?: boolean;
  /**
   * Where this app kept only the start of a long text: its end, where tools
   * write their notices, and its line count, both read from the whole text.
   */
  textTail?: string;
  textLines?: number | null;
  /**
   * The arguments as history's row holds them, where no engine step does:
   * absent when the row had none, or the value as sent (`null` included).
   */
  rowArgs?: { kept: false } | { kept: true; value: unknown };
};

/** What the reading needs to know beyond the call. */
export type ReadingContext = {
  /** The bot's workspace root, when known: an absolute path is memory only inside it (8.2). */
  workspaceRoot?: string | null;
  /** Bot names by id, for "Read Marlow's task". */
  botName?: (agentId: string) => string | null;
  /**
   * The gateway's own map from effective tool names to a tool server and its
   * tool (`tools.effective`): a tool-server call is known from its start.
   * The result's `details.mcpServer` and `mcpTool` overrule it.
   */
  toolServers?: Readonly<Record<string, { server: string; tool: string }>>;
  /**
   * Built-in and plugin tools by effective name, from the same inventory
   * (`tools.effective`): a general card of one of these folds by its name (8.3).
   */
  builtinTools?: readonly string[];
};

// Small helpers ----------------------------------------------------------------------

const rec = (value: unknown): Rec | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null;
const str = (value: unknown): string =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** The last part of a path. */
export function baseName(path: string): string {
  const parts = String(path || "")
    .split(/[\\/]/)
    .filter(Boolean);
  return parts.at(-1) ?? (path || ".");
}

/** A URL's host, without "www."; the text itself when it is not a URL. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return String(url || "");
  }
}

/** A query in straight quotes, shortened to 40 characters (8.2). */
export function quoted(text: unknown): string {
  const t = str(text).trim();
  return `"${t.length > 40 ? `${t.slice(0, 39).trimEnd()}…` : t}"`;
}

function firstWords(text: unknown, n = 6): string {
  const words = str(text)
    .replace(/^#+\s*/, "")
    .split(/\s+/)
    .filter(Boolean);
  return words.length ? quoted(words.slice(0, n).join(" ") + (words.length > n ? "…" : "")) : "";
}

const lower = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const upper = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const firstLine = (text: unknown) => str(text).split("\n")[0] ?? "";

/** Lines of a text, counted as received. */
export function lineCount(text: string | null): number {
  return text ? text.replace(/\n$/, "").split("\n").length : 0;
}

/** The program a command runs: its first word that is not an assignment or a wrapper (8.2). */
export function programOf(command: unknown): string {
  const words = str(command).trim().split(/\s+/);
  const wrappers: Record<string, true> = { sudo: true, env: true, nohup: true, time: true };
  const word = words.find((w) => w && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && !wrappers[w]);
  return word && /^[\w./-]+$/.test(word) ? baseName(word) : "";
}

/**
 * What a read's line says it got: the lines of the file's text when all of it
 * is here, the part its capped notice names, or the count the tool's own
 * sentence gives; never a count of a sentence, of notes, or of a cut text (8.6).
 */
function readCount(
  call: Pick<ActionCall, "text" | "isError" | "cut" | "textTail" | "textLines">,
): string {
  if (!call.text || call.isError) return "";
  const r = readText(call.text, call.textTail);
  if (r.counted) return r.counted;
  if (r.shown) return r.shown;
  if (r.said || r.capped || call.cut || !r.body.trim()) return "";
  // The whole text's lines, counted as it arrived; a page asked for is not counted from a part.
  if (call.textTail !== undefined)
    return r.page || !call.textLines ? "" : PLURALS.lines(call.textLines);
  return PLURALS.lines(lineCount(r.body));
}

/** The general card's words, from a name (8.3): `skills_search` is "skills search". */
export function nameWords(name: string): string {
  return (
    String(name || "")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[_\-.\s]+/)
      .filter(Boolean)
      .map((part) => (/^[A-Z]{2,5}$/.test(part) ? part : part.toLowerCase()))
      .join(" ") || "a tool"
  );
}

/** The gateway's own detail keys, in its order (8.3). */
function generalDetail(args: Rec): string {
  const keys =
    "command path url targetUrl targetId ref element node nodeId id requestId to channelId guildId userId name query pattern messageId";
  for (const key of keys.split(" ")) {
    const value = args[key];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "object") continue;
    const text = String(value);
    if (key === "path") return baseName(text);
    if (/url/i.test(key)) return hostOf(text);
    return text.length > 60 ? `${text.slice(0, 59)}…` : text;
  }
  return "";
}

/** Added and removed lines of a diff; the engine's projection carries the counts of the whole diff. */
export function diffStat(details: Rec | null): { added: number; removed: number } | null {
  if (!details) return null;
  const kept = rec(details.diffStat);
  if (kept && num(kept.added) !== null && num(kept.removed) !== null)
    return { added: num(kept.added)!, removed: num(kept.removed)! };
  if (typeof details.diff !== "string") return null;
  const rows = details.diff.split("\n");
  return {
    added: rows.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length,
    removed: rows.filter((l) => l.startsWith("-") && !l.startsWith("---")).length,
  };
}
const diffText = (d: { added: number; removed: number }) => `+${d.added} −${d.removed}`;

/** A path relative to the workspace, or null for a path outside it (8.2). */
function workspacePath(path: unknown, ctx: ReadingContext): string | null {
  let p = str(path).replace(/^\.\//, "");
  if (!p) return null;
  if (p.startsWith("/")) {
    const root = (ctx.workspaceRoot ?? "").replace(/\/+$/, "");
    if (!root || !p.startsWith(`${root}/`)) return null;
    p = p.slice(root.length + 1);
  }
  return p;
}

/** A memory note is `MEMORY.md` or a path under `memory/` in the bot's workspace (8.2). */
export function isMemoryPath(path: unknown, ctx: ReadingContext = {}): boolean {
  const p = workspacePath(path, ctx);
  return p !== null && (p === "MEMORY.md" || p.startsWith("memory/"));
}

/** The files a call acts on: its path, a patch's named files, or its documents and images (8.2). */
export function filesOf(call: Pick<ActionCall, "name" | "args">): string[] {
  const a = call.args;
  if (call.name === "apply_patch") {
    return [
      ...str(a.input).matchAll(
        /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm,
      ),
    ].map((m) => (m[1] ?? m[2] ?? "").trim());
  }
  if (call.name === "pdf")
    return list(a.pdfs).length ? list(a.pdfs).map(str) : a.pdf ? [str(a.pdf)] : [];
  if (call.name === "view_image")
    return list(a.paths).length ? list(a.paths).map(str) : a.path ? [str(a.path)] : [];
  return a.path ? [str(a.path)] : [];
}

/** A routine's schedule in words; its time zone is always said (8.2). */
export function scheduleWords(schedule: unknown): string {
  const s = rec(schedule);
  if (!s) return "";
  const zone = `, ${str(s.tz) || SCHEDULE.gatewayTime}`;
  const everyMs = num(s.everyMs);
  if (s.kind === "every" && everyMs) {
    return SCHEDULE.every(Math.round(everyMs / 3_600_000), Math.round(everyMs / 60_000));
  }
  if (s.kind === "at" && s.at) {
    const at = new Date(str(s.at));
    if (Number.isNaN(at.getTime())) return `${str(s.at)}${zone}`;
    const when = at.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      ...(s.tz ? { timeZone: str(s.tz) } : {}),
    });
    return `${when}${zone}`;
  }
  const expr = str(s.expr);
  const m = /^(\d+) (\d+) \* \* (\d|\*)$/.exec(expr);
  if (!m) return `${expr}${zone}`;
  const minute = Number(m[1]);
  const hour = Number(m[2]);
  if (minute > 59 || hour > 23) return `${expr}${zone}`;
  const time = `${((hour + 11) % 12) + 1}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
  const day =
    m[3] === "*" ? SCHEDULE.everyDay : (SCHEDULE.weekdays[Number(m[3]) % 7] ?? SCHEDULE.everyDay);
  return `${SCHEDULE.at(day, time)}${zone}`;
}

/** The markers the gateway puts around fetched content (8.7, point 6). */
export function unwrapExternal(text: unknown): string {
  return str(text)
    .replace(
      /<<<EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>\s*|\s*<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/g,
      "",
    )
    .trim();
}

// Kinds -------------------------------------------------------------------------------

export type ActionKind =
  | "read"
  | "list"
  | "edit"
  | "memory"
  | "recall"
  | "command"
  | "terminal"
  | "web"
  | "xsearch"
  | "page"
  | "browser"
  | "computer"
  | "phone"
  | "screen"
  | "routine"
  | "message"
  | "tasks"
  | "helper"
  | "question"
  | "plan"
  | "media"
  | "look"
  | "channel"
  | "server"
  | "t3"
  | "tool";

/** The icon each kind's line shows. */
export type ActionIcon =
  | "read"
  | "list"
  | "write"
  | "memory"
  | "recall"
  | "command"
  | "search"
  | "web"
  | "window"
  | "screen"
  | "clock"
  | "tasks"
  | "helpers"
  | "question"
  | "plan"
  | "image"
  | "film"
  | "note"
  | "wave"
  | "message"
  | "plug"
  | "tool";

/** The table: an exact tool name to a kind (8.1). */
const TABLE: Record<string, ActionKind> = {
  read: "read",
  ls: "list",
  write: "edit",
  edit: "edit",
  apply_patch: "edit",
  memory_search: "recall",
  memory_get: "recall",
  exec: "command",
  code_execution: "command",
  terminal: "terminal",
  web_search: "web",
  x_search: "xsearch",
  web_fetch: "page",
  browser: "browser",
  computer: "computer",
  mobile_ui: "phone",
  screen: "screen",
  automations: "routine",
  cron: "routine",
  sessions_send: "message",
  sessions_list: "tasks",
  sessions_history: "tasks",
  sessions_search: "tasks",
  session_status: "tasks",
  agents_list: "tasks",
  sessions_spawn: "helper",
  agents_wait: "helper",
  subagents: "helper",
  ask_user: "question",
  progress_card: "plan",
  create_goal: "plan",
  update_goal: "plan",
  get_goal: "plan",
  image_generate: "media",
  video_generate: "media",
  music_generate: "media",
  tts: "media",
  pdf: "look",
  view_image: "look",
  message: "channel",
  conversations_send: "channel",
  conversations_turn: "channel",
};

/**
 * A tool-server call's server and tool: as its result names them
 * (`details.mcpServer`, `details.mcpTool`), else as the gateway's name map
 * gives them for its effective name. `mapped` says which.
 */
export function toolServerOf(
  call: Pick<ActionCall, "details" | "name">,
  ctx: ReadingContext = {},
): { server: string; tool: string; mapped: boolean } | null {
  const server = str(call.details?.mcpServer);
  const tool = str(call.details?.mcpTool);
  if (server && tool) return { server, tool, mapped: false };
  const known = ctx.toolServers?.[call.name];
  return known && str(known.server) && str(known.tool)
    ? { server: known.server, tool: known.tool, mapped: true }
    : null;
}

export type KindInfo = {
  kind: ActionKind;
  /** The fold key (7.4); `null` never folds. */
  key: string | null;
  /** Its effect leaves the gateway: an open call shows "Call started" (7.3). */
  leaves: boolean;
};

const ROUTINE_LOOKUPS: Record<string, true> = { status: true, list: true, get: true, runs: true };
const LEAVES: Partial<Record<ActionKind, true>> = {
  helper: true,
  media: true,
  channel: true,
  server: true,
  t3: true,
  message: true,
};

/**
 * The kind of a call and its fold key (8.1, 8.2, 7.4). A tool-server call is
 * identified only by its result's `details.mcpServer` and `mcpTool`: until
 * then it is the general card, and it never folds, because its key was not
 * known at its start.
 */
export function kindOf(call: ActionCall, ctx: ReadingContext = {}): KindInfo {
  const info = (kind: ActionKind, key: string | null): KindInfo => ({
    kind,
    key,
    leaves: LEAVES[kind] === true,
  });
  const server = toolServerOf(call, ctx);
  if (server) {
    if (T3_CODE_TOOLS.includes(server.tool)) return info("t3", null);
    // Folds only when the gateway's map named it at its start (7.4), by the server and tool it
    // turned out to be: a result that names another operation keeps it apart.
    const atStart = ctx.toolServers?.[call.name];
    return info("server", atStart ? `server:${server.server}:${server.tool}` : null);
  }
  const a = call.args;
  if ((call.name === "write" || call.name === "edit") && isMemoryPath(a.path, ctx))
    return info("memory", "memory");
  if (call.commandBearing && call.name !== "terminal") return info("command", "command");
  const kind = TABLE[call.name];
  if (!kind) {
    // A general card folds by its name only when the gateway's tool inventory lists it (8.3).
    const listed = call.builtin === true || ctx.builtinTools?.includes(call.name) === true;
    return info("tool", listed ? `tool:${call.name}` : null);
  }
  switch (kind) {
    case "message":
    case "helper":
    case "question":
    case "channel":
      return info(kind, null);
    case "routine":
      // A look-up folds with the same tool's same look-up only; `cron` is another tool.
      return info(kind, ROUTINE_LOOKUPS[str(a.action)] ? `${call.name}:${str(a.action)}` : null);
    case "terminal":
      return info(kind, `${call.name}:${str(a.action) || "?"}`);
    case "screen":
      // Its plural says the display changed, so only the same change folds.
      return info(kind, `screen:${str(a.action) || "?"}`);
    case "media":
      return info(kind, `${call.name}:${str(a.action) || "generate"}`);
    case "recall":
    case "tasks":
    case "plan":
    case "look":
      return info(kind, call.name);
    case "read":
      return info(kind, "read");
    case "edit":
      return info(kind, "files");
    default:
      return info(kind, call.name);
  }
}

/**
 * Kinds whose result text is what the tool read, ran or wrote, never its own
 * payload: a file's content, a command's output, a document's analysis, an
 * edit's sentence, a tool server's output. Every other tool returns its payload as JSON text
 * (`jsonResult`), alone or after a line of words.
 */
const CONTENT_KINDS: Partial<Record<ActionKind, true>> = {
  read: true,
  list: true,
  command: true,
  terminal: true,
  look: true,
  edit: true,
  memory: true,
  // A tool server's text is the server's own output, not the gateway's payload for the call.
  server: true,
  t3: true,
};

/** The JSON object a result's text carries: the whole text, or a block after its words. */
function payloadText(text: string): unknown {
  const t = text.trim();
  // A JSON object cut short, as history stores a long one: its members that are all there.
  if (!t.endsWith("}")) return t.startsWith("{") ? leadingMembers(t) : null;
  // The whole text first, then each later "{" that may open the block (a few at most).
  let at = t.startsWith("{") ? 0 : t.indexOf("{");
  for (let tries = 0; at !== -1 && tries < 16; tries += 1) {
    try {
      const value: unknown = JSON.parse(t.slice(at));
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      // Not the block: try the next brace.
    }
    at = t.indexOf("{", at + 1);
  }
  return null;
}

/**
 * The members of a JSON object's text that are complete before it was cut:
 * each key whose whole value is there, in order; nothing from a value that
 * was cut. Null when none is complete.
 */
function leadingMembers(t: string): Rec | null {
  const out: Rec = {};
  let i = 1;
  const space = () => {
    while (i < t.length && /\s/.test(t[i]!)) i += 1;
  };
  /** The end of the JSON value starting at `i`, or -1 when it is cut. */
  const valueEnd = (): number => {
    let depth = 0;
    let inString = false;
    for (let j = i; j < t.length; j += 1) {
      const ch = t[j]!;
      if (inString) {
        if (ch === "\\") j += 1;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{" || ch === "[") depth += 1;
      else if (ch === "}" || ch === "]") {
        if (depth === 0) return j;
        depth -= 1;
      } else if (ch === "," && depth === 0) return j;
    }
    return -1;
  };
  for (;;) {
    space();
    if (t[i] !== '"') break;
    const key = /^"(?:[^"\\]|\\.)*"/.exec(t.slice(i));
    if (!key) break;
    i += key[0].length;
    space();
    if (t[i] !== ":") break;
    i += 1;
    space();
    const end = valueEnd();
    if (end === -1) break;
    try {
      out[JSON.parse(key[0]) as string] = JSON.parse(t.slice(i, end));
    } catch {
      break;
    }
    i = end;
    if (t[i] === ",") i += 1;
    else break;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The one way a call's payload is read, live and from history alike: the
 * result's own JSON, where its text carries it, under whatever `details` were
 * kept. History keeps only a few detail keys (the gateway's chat display
 * projection: exit code, duration, folder, session, `ok`, `changed`,
 * `created`, diff), so without the text's payload a reloaded call would read
 * less, or more, than the live one. Text that carries no payload adds nothing.
 */
export function withPayload(call: ActionCall, ctx: ReadingContext = {}): ActionCall {
  if (!call.text || CONTENT_KINDS[kindOf(call, ctx).kind]) return call;
  const value = payloadText(call.text);
  // The computer's text is its act's result, which its details carry under `result`.
  const parsed = projectDetails(
    value && kindOf(call, ctx).kind === "computer" ? { result: value } : value,
  );
  if (!parsed) return call;
  return { ...call, details: { ...parsed, ...(call.details ?? {}) } };
}

/** Each call read once: `withPayload` per call object and context. */
const readCache = new WeakMap<ActionCall, WeakMap<ReadingContext, ActionCall>>();
const EMPTY_CTX: ReadingContext = {};
function payloadRead(call: ActionCall, ctx: ReadingContext): ActionCall {
  if ((call as { payloadRead?: true }).payloadRead) return call;
  const byCtx = readCache.get(call) ?? new WeakMap<ReadingContext, ActionCall>();
  readCache.set(call, byCtx);
  const known = byCtx.get(ctx);
  if (known) return known;
  const read = { ...withPayload(call, ctx), payloadRead: true } as ActionCall;
  byCtx.set(ctx, read);
  return read;
}

// Outcomes ----------------------------------------------------------------------------

export type Outcome =
  // Open.
  | "running"
  | "review"
  | "waiting"
  // Settled.
  | "done"
  | "partial"
  | "started"
  | "queued"
  | "made"
  | "unconfirmed"
  | "unchanged"
  | "notfound"
  | "refused"
  | "suppressed"
  | "unavailable"
  | "failed"
  | "blocked"
  | "denied"
  | "stopped"
  | "unknown";

/** An outcome, with the word at the right when it differs from the outcome's own. */
export type OutcomeOf = { outcome: Outcome; word?: string };

export function isOpenOutcome(outcome: Outcome): boolean {
  return outcome === "running" || outcome === "review" || outcome === "waiting";
}

const SUCCESS: Record<string, true> = {
  ok: true,
  completed: true,
  success: true,
  sent: true,
  accepted: true,
  answered: true,
  replied: true,
};

const wordOf = (value: unknown) => upper(nameWords(str(value)));

/** A general reading's outcome, with whether it names a problem or only a word as received. */
type General = OutcomeOf & { signal: "problem" | "word" };

/**
 * The general reading of a payload (7.3). Every kind goes through it; a
 * kind's adapter only adds to it. It looks at `details` and at a nested
 * `details.result` where a tool projects its outcome there, and returns the
 * outcome a "not done" signal gives, or null when it finds none. A signal at
 * either level outranks a value shown only as received at the other: a
 * nested `ok: false` under an unknown top-level `status` is Failed.
 */
export function payloadOutcome(details: Rec | null): OutcomeOf | null {
  const general = generalReading(details);
  return general && { outcome: general.outcome, ...(general.word ? { word: general.word } : {}) };
}

function generalReading(details: Rec | null): General | null {
  if (!details) return null;
  const levels = [details, rec(details.result) ?? {}];
  for (const d of levels) {
    const status = typeof d.status === "string" ? d.status : "";
    const code = typeof d.code === "string" ? d.code : "";
    const problem = (outcome: Outcome, word?: string): General => ({
      outcome,
      ...(word ? { word } : {}),
      signal: "problem",
    });
    if (status === "forbidden") return problem("refused", STATE_WORDS.notRun);
    if (status === "blocked") return problem("blocked", "policy");
    if (code === "confirmation_required") return problem("refused", STATE_WORDS.needsConfirmation);
    if (status === "approval-pending") return problem("waiting");
    if (status === "not_found" || d.removed === false) return problem("notfound");
    if (
      d.ok === false ||
      (d.error !== undefined && d.error !== null && d.error !== "" && d.error !== false) ||
      status === "error" ||
      status === "failed"
    )
      return problem("failed");
    if (status === "queued") return problem("queued");
    if (d.effect === "unverifiable" || d.effect === "suspected_noop") return problem("unconfirmed");
  }
  for (const d of levels) {
    const status = typeof d.status === "string" ? d.status : "";
    const code = typeof d.code === "string" ? d.code : "";
    if (d.outcome !== undefined && d.outcome !== null) {
      const oc = typeof d.outcome === "string" ? d.outcome : str(rec(d.outcome)?.code);
      return { outcome: "made", word: oc ? wordOf(oc) : STATE_WORDS.callMade, signal: "word" };
    }
    if (status && !SUCCESS[status])
      return { outcome: "made", word: wordOf(status), signal: "word" };
    if (code && !SUCCESS[code]) return { outcome: "made", word: wordOf(code), signal: "word" };
  }
  return null;
}

/**
 * A value that says the work was done (7.3): `ok: true`, a success `status`
 * or `code`, `removed: true`, `effect: "confirmed"`, at either level. What a
 * general card needs for Done, since its result has no field of its own.
 */
function saysDone(details: Rec | null): boolean {
  if (!details) return false;
  return [details, rec(details.result) ?? {}].some(
    (d) =>
      d.ok === true ||
      SUCCESS[str(d.status)] === true ||
      SUCCESS[str(d.code)] === true ||
      d.removed === true ||
      d.effect === "confirmed",
  );
}

/** The identity keys a tool-server result carries whatever it did. */
const IDENTITY_KEYS: Record<string, true> = { mcpServer: true, mcpTool: true };

/**
 * A result that carries something: text with more than white space, or
 * details beyond the tool server's own identity. "A result without error"
 * (8.1) needs one; an empty return establishes nothing.
 */
function carries(call: ActionCall): boolean {
  if (str(call.text).trim()) return true;
  return Object.keys(call.details ?? {}).some((key) => !IDENTITY_KEYS[key]);
}

/** How an error result reads, where the gateway says more than "an error" (7.3, 8.4). */
function errorOutcome(call: ActionCall, kind: KindInfo): OutcomeOf {
  const d = call.details ?? {};
  const text = str(call.text).trim();
  // Exec's denials: by the person, by the approval's expiry, by a rule, or by the review.
  if (/^Exec denied by auto-review/.test(text)) return { outcome: "blocked", word: "review" };
  const denied = /^Exec denied \(([^)]*)\)/.exec(text);
  if (denied) {
    const reason = denied[1] ?? "";
    if (/user-denied/.test(reason)) return { outcome: "denied" };
    if (/approval-timeout/.test(reason)) return { outcome: "denied", word: STATE_WORDS.expired };
    if (/run-aborted/.test(reason)) return { outcome: "stopped" };
    if (/policy-denied|security=deny/.test(reason)) return { outcome: "blocked", word: "policy" };
    return { outcome: "refused", word: STATE_WORDS.notRun };
  }
  if (/^exec denied: /i.test(text)) return { outcome: "blocked", word: "policy" };
  // A send the gateway reports as sent is sent, whatever then happened to its reply.
  if (kind.kind === "channel") {
    const s = str(d.status);
    if (s === "sent") return { outcome: "done", word: STATE_WORDS.sent };
    if (s === "replied") return { outcome: "done", word: STATE_WORDS.replied };
    if (s === "timeout") return { outcome: "made", word: STATE_WORDS.sentNoReply };
  }
  // A refusal or an unavailability the kind's own reading names is that, flagged or not.
  const adapter = ADAPTERS[kind.kind];
  if (adapter) {
    const own = adapter(call);
    const o = typeof own === "string" ? { outcome: own } : own;
    if (o.outcome === "refused" || o.outcome === "unavailable" || o.outcome === "notfound")
      return o;
  }
  const status = str(d.status);
  if (status === "forbidden") return { outcome: "refused", word: STATE_WORDS.notRun };
  if (status === "blocked") return { outcome: "blocked", word: "policy" };
  if (
    d.timedOut === true ||
    str(d.failureKind) === "overall-timeout" ||
    /^Command timed out after \d+ seconds/.test(text)
  )
    return { outcome: "failed", word: STATE_WORDS.timedOut };
  // A call cut short by a stop: what it did is unknown when its effect leaves the gateway.
  if (
    status === "aborted" ||
    status === "cancelled" ||
    /^aborted\.?$/i.test(text) ||
    (call.runStopped === true && (text === "" || /abort|cancel/i.test(text)))
  )
    return kind.leaves ? { outcome: "unknown" } : { outcome: "stopped" };
  return { outcome: "failed" };
}

type Adapter = (call: ActionCall) => OutcomeOf | Outcome;

/**
 * The installed tools' own sentences that say what a call established, read
 * the same live and from history, where the gateway keeps the text but not
 * the details (OpenClaw 2026.10.6: exec's
 * pending approval, media generation's result and background admission).
 */
/** The gateway's own words for a call it blocked before launch (its agent loop, 2026.10.6). */
const GATEWAY_BLOCKED =
  /^(Tool execution was blocked before launch\.|OpenClaw stopped this run because tool-loop recovery encountered another critical loop\. No blocked tool action was executed\.)$/;
const EXEC_BACKGROUNDED = /^Command still running \(session /;

/**
 * A `read` result's text as the installed read tool writes it (OpenClaw
 * 2026.10.6): a note that it resolved another filename first; then the
 * file's text, or one of its own sentences for what it did not return; then
 * a notice that its own limit cut the read short, or that the page asked for
 * leaves more lines in the file.
 */
export type ReadText = {
  /** The tool's sentence in place of content, if it wrote one. */
  said: "no-contents" | "image-omitted" | "optional-absent" | "empty" | "blank" | "image" | null;
  /** The file's text, without the tool's notes; empty when it wrote a sentence instead. */
  body: string;
  /** The read stopped at its own limit (`[Read output capped …]`, `[Showing lines a-b of N …]`). */
  capped: boolean;
  /** The page the call asked for, with more lines in the file (`[N more lines in file …]`). */
  page: boolean;
  /** What the capped notice says was shown: "lines 1-1227 of 3300". */
  shown: string | null;
  /** The count the tool's sentence gives: "2 blank lines". */
  counted: string | null;
};

export function readText(text: unknown, tail?: string): ReadText {
  // A long text kept short: its start for the tool's sentences, its end for its notices.
  let lines = (tail !== undefined ? `${str(text)}\n${tail}` : str(text)).split("\n");
  // The note that the tool read another filename than the one asked for.
  while (lines.length && /^\[Resolved filename: .*\]$/.test(lines[0]!.trim()))
    lines = lines.slice(1);
  let all = lines.join("\n");
  let capped = false;
  let page = false;
  let shown: string | null = null;
  const notice =
    /\n*\[(Read output capped at [^\]]*|Showing (lines (\d+)-(\d+) of (\d+)|part of line \d+)[^\]]*|\d+ more lines? in file\. Use offset=\d+ to continue\.)\]\s*$/.exec(
      all,
    );
  if (notice) {
    all = all.slice(0, notice.index);
    if (/^\d+ more lines?/.test(notice[1]!)) page = true;
    else {
      capped = true;
      if (notice[3]) shown = `lines ${notice[3]}-${notice[4]} of ${notice[5]}`;
    }
  }
  const t = all.trim();
  const said: ReadText["said"] =
    /^(Read did not return file contents because|File contains no readable text \(|Offset \d+ is beyond end of file|Cursor \d+ is at or beyond the end of line)/.test(
      t,
    )
      ? "no-contents"
      : /^Read image file \[/.test(t)
        ? /\[Current model does not support images\. The image will be omitted/.test(t)
          ? "image-omitted"
          : "image"
        : /^Optional file not found: /.test(t)
          ? "optional-absent"
          : /^File is empty \(0 bytes\)\.$/.test(t)
            ? "empty"
            : /^File contains \d+ blank lines?\.$/.test(t)
              ? "blank"
              : null;
  const blank = /^File contains (\d+ blank lines?)\.$/.exec(t);
  return { said, body: said ? "" : all, capped, page, shown, counted: blank ? blank[1]! : null };
}

const EXEC_ASKS_APPROVAL = /(^|\n)Approval required \(id /;
const MEDIA_STARTED = /^Background task started for .+ generation \(/;
/** How many items "Generated 2 images with …" says were made; 0 when the text says none. */
function mediaMade(text: unknown): number {
  const m = /^Generated (\d+) (?:image|track|video)s? with /.exec(str(text));
  return m ? Number(m[1]) : 0;
}

const PHONE_REFUSALS: Record<string, true> = {
  target_stale: true,
  target_not_found: true,
  secure_content: true,
  package_changed: true,
};
const OBSERVE: Record<string, true> = {
  screenshot: true,
  wait: true,
  list_windows: true,
  get_window_state: true,
  get_accessibility_tree: true,
};

/** Each kind's own reading of a result without an error flag: its "Done needs" (8.1). */
const ADAPTERS: Partial<Record<ActionKind, Adapter>> = {
  read: (c) => {
    const r = readText(c.text, c.textTail);
    switch (r.said) {
      case "no-contents":
        return { outcome: "unavailable", word: STATE_WORDS.noContents };
      case "image-omitted":
        return { outcome: "unavailable", word: STATE_WORDS.omitted };
      case "optional-absent":
        return "notfound";
      case "empty":
        return { outcome: "made", word: STATE_WORDS.emptyFile };
      default:
        break;
    }
    // The page the call asked for is what it asked for, though the details call it truncated.
    if (r.page && r.body) return "done";
    // Cut short by the read's own limit: its notice, or its details' kind (OpenClaw 2026.10.6).
    if (r.capped || c.details?.kind === "truncated") return "partial";
    if (r.said) return "done";
    if (r.body) return "done";
    // Without the text, the details' kind says the file's content came back whole.
    return c.details?.kind === "file" || c.details?.kind === "text" ? "done" : "made";
  },
  list: (c) => (c.text ? "done" : "made"),
  edit: (c) => {
    const d = c.details;
    if (d?.changed === false) return "unchanged";
    // A patch's result says nothing of its own: one that carries text or details is Done.
    if (c.name === "apply_patch") return carries(c) ? "done" : "made";
    return d?.changed === true || typeof d?.diff === "string" || rec(d?.diffStat) ? "done" : "made";
  },
  memory: (c) => {
    const d = c.details;
    if (d?.changed === false) return "unchanged";
    return d?.changed === true || typeof d?.diff === "string" || rec(d?.diffStat) ? "done" : "made";
  },
  recall: (c) => {
    const d = c.details;
    if (c.name === "memory_get") {
      return d?.status === "ok"
        ? "done"
        : d?.status === "not_found"
          ? "notfound"
          : d?.status === "error"
            ? "failed"
            : "made";
    }
    if (d?.unavailable === true || d?.disabled === true) return "unavailable";
    if (d?.partial === true) return "partial";
    return Array.isArray(d?.results) ? "done" : "made";
  },
  command: (c) => {
    const d = c.details;
    if (d?.status === "approval-pending" || EXEC_ASKS_APPROVAL.test(str(c.text))) return "waiting";
    // Returned to the background: it is still running, as its result says.
    if (d?.status === "running" || EXEC_BACKGROUNDED.test(str(c.text)))
      return { outcome: "made", word: STATE_WORDS.stillRunning };
    if (c.name === "code_execution") return c.text ? "done" : "made";
    // A non-zero exit is the command's answer, not a failure (8.4).
    return num(d?.exitCode) !== null ? "done" : "made";
  },
  terminal: (c) => (carries(c) ? "done" : "made"),
  web: (c) => {
    // The gateway's normalized answer (`kind`: results, answer, error, raw; OpenClaw 2026.10.6).
    const d = c.details;
    // The provider's error, as the gateway normalized it; a thrown error stays Failed.
    if (d?.kind === "error" || (d?.error && d?.status !== "error" && !Array.isArray(d?.results)))
      return "unavailable";
    const answered = d?.kind === "answer" && str(d.content).trim() !== "";
    if (!Array.isArray(d?.results) && !answered) return "made";
    return d?.truncated === true ? "partial" : "done";
  },
  xsearch: (c) => {
    if (c.details?.error) return "unavailable";
    return c.text || c.details?.content ? "done" : "made";
  },
  page: (c) => {
    // The payload's own `text` where it carries one (`jsonResult`), else the result's text; where
    // history cut the text away, the `length` the gateway reported for it.
    const d = c.details ?? {};
    if (d.truncated === true) return "partial";
    const body = "text" in d ? str(d.text) : str(c.text);
    if (body.trim() || (num(d.length) ?? 0) > 0) return "done";
    return "unavailable";
  },
  browser: (c) => (carries(c) ? "done" : "made"),
  computer: (c) => {
    if (OBSERVE[str(c.args.action)]) return carries(c) ? "done" : "made";
    const r = rec(c.details?.result) ?? {};
    if (r.ok === false) return "failed";
    if (r.effect === "confirmed") return "done";
    if (r.effect === "unverifiable" || r.effect === "suspected_noop") return "unconfirmed";
    return "made";
  },
  phone: (c) => {
    if (c.args.action === "observe") return c.details?.snapshotId ? "done" : "made";
    if (c.details?.code === "confirmation_required")
      return { outcome: "refused", word: STATE_WORDS.needsConfirmation };
    const code = str(rec(c.details?.outcome)?.code);
    if (PHONE_REFUSALS[code]) return { outcome: "refused", word: wordOf(code) };
    // The device's code for an act that ran is not fixed by the gateway (8.7, point 7).
    return { outcome: "made", word: code ? wordOf(code) : STATE_WORDS.callMade };
  },
  screen: (c) => (carries(c) ? "done" : "made"),
  routine: (c) => {
    const d = c.details ?? {};
    switch (c.args.action) {
      case "run": {
        // It did not run: the gateway says so and why (`ran: false`, its `reason`).
        if (d.ran === false) return { outcome: "refused", word: STATE_WORDS.notRun };
        const run = rec(d.run);
        if (run) {
          const status = str(run.status);
          if (status === "error" || status === "failed" || run.error) return "failed";
          return status === "ok" || status === "completed" || status === "success"
            ? "done"
            : { outcome: "made", word: wordOf(status) || STATE_WORDS.callMade };
        }
        // Finished, with no record of its run to read: its outcome is not known.
        if (d.finished === true)
          return { outcome: "made", word: STATE_WORDS.finishedOutcomeUnknown };
        return d.enqueued === true ? "queued" : "made";
      }
      case "remove":
        return d.removed === true ? "done" : d.removed === false ? "notfound" : "made";
      case "next_check":
        return d.ok === true && num(d.delayMs) !== null ? "done" : "made";
      case "add":
      case "update":
        return d.id ? "done" : "made";
      default:
        return carries(c) ? "done" : "made";
    }
  },
  tasks: (c) => (carries(c) ? "done" : "made"),
  helper: (c) => {
    if (c.name === "sessions_spawn") {
      const s = c.details?.status;
      return s === "accepted"
        ? "started"
        : s === "forbidden"
          ? { outcome: "refused", word: STATE_WORDS.notRun }
          : s === "error"
            ? "failed"
            : "made";
    }
    // The results of a wait, a kill and a steer were not read for this design (8.7, point 3).
    return c.name === "subagents" && c.args.action === "list" && carries(c) ? "done" : "made";
  },
  question: (c) => {
    const s = c.details?.status;
    if (s === "answered") return { outcome: "done", word: STATE_WORDS.answered };
    return s ? { outcome: "made", word: wordOf(s) } : "made";
  },
  plan: (c) => {
    if (c.name !== "progress_card") return carries(c) ? "done" : "made";
    // The card's revision, or the gateway's answer that it cleared the card.
    return num(c.details?.revision) !== null || clearedPlan(c) ? "done" : "made";
  },
  media: (c) => {
    const d = c.details;
    if (c.args.action === "list" || c.args.action === "status") return carries(c) ? "done" : "made";
    if ((d?.async === true && d.status === "started") || MEDIA_STARTED.test(str(c.text)))
      return "started";
    if (c.name === "tts") return d?.audioPath || /^\(spoken\) /.test(str(c.text)) ? "done" : "made";
    return list(d?.media).length || list(d?.paths).length || mediaMade(c.text) > 0
      ? "done"
      : "made";
  },
  look: (c) => {
    // The refusal's code, or the tool's own sentence for it where only the text was kept.
    const text = str(c.text);
    const e =
      c.details?.error ??
      (/^Too many PDFs: /.test(text)
        ? "too_many_pdfs"
        : /^Too many images: /.test(text)
          ? "too_many_images"
          : /^Unsupported PDF reference: /.test(text)
            ? "unsupported_pdf_reference"
            : /^Unsupported image reference: /.test(text)
              ? "unsupported_image_reference"
              : undefined);
    if (e === "too_many_pdfs" || e === "too_many_images")
      return { outcome: "refused", word: STATE_WORDS.tooMany };
    if (e === "unsupported_pdf_reference" || e === "unsupported_image_reference")
      return { outcome: "refused", word: STATE_WORDS.unsupported };
    return c.text ? "done" : "made";
  },
  channel: (c) => {
    // The `message` tool has no published result (8.7, point 2).
    if (c.name === "message") return "made";
    const s = c.details?.status;
    if (s === "sent") return { outcome: "done", word: STATE_WORDS.sent };
    if (s === "replied") return { outcome: "done", word: STATE_WORDS.replied };
    if (s === "queued") return "queued";
    if (s === "suppressed") return "suppressed";
    if (s === "timeout") return { outcome: "made", word: STATE_WORDS.sentNoReply };
    return "made";
  },
  server: (c) => {
    const s = c.details?.status;
    if (s === "aborted" || s === "cancelled") return "unknown";
    return carries(c) ? "done" : "made";
  },
  // A general card has no field of its own: only a value that says the work was done (7.3).
  tool: (c) => (saysDone(c.details) ? "done" : "made"),
};

/**
 * What establishes each kind's Done, and each outcome short of it: the
 * evidence the adapters below read, field by field, and nothing else. The
 * engine's guide (`packages/core/README.md`, "What establishes Done") holds
 * the same table, and a test keeps the two the same. Text alone is never
 * evidence of content: the tools' own sentences for nothing returned,
 * refused, omitted or cut are read as what they say, and a result whose text
 * is cut is never Done on that text.
 */
export const DONE_EVIDENCE: Readonly<Record<ActionKind, { done: string; lesser: string }>> = {
  read: {
    done: "`read`: the file's text (not one of the tool's own sentences), with no cap notice; or, without text, `details.kind` `file` or `text`; the page asked for (`[N more lines in file \u2026]`)",
    lesser:
      'Partial: `[Read output capped \u2026]`, `[Showing lines a-b of N \u2026]` or `details.kind: "truncated"`. Unavailable: `Read did not return file contents \u2026`, `File contains no readable text`, an offset or cursor past the end, an image omitted for the model. Not found: `Optional file not found:`. Call made: `File is empty (0 bytes).`',
  },
  list: {
    done: "`ls`: its text",
    lesser: "Call made: no text",
  },
  edit: {
    done: "`write`, `edit`: `details.changed: true` or a diff; `apply_patch`: a result that carries text or details",
    lesser: "No change: `details.changed: false`. Call made: neither",
  },
  memory: {
    done: "A memory note's `write` or `edit`: `details.changed: true` or a diff",
    lesser: "No change: `details.changed: false`. Call made: neither",
  },
  recall: {
    done: '`memory_search`: a `results` array; `memory_get`: `status: "ok"`',
    lesser:
      'Partial: `partial: true`. Unavailable: `unavailable` or `disabled`. Not found: `status: "not_found"`. Failed: `status: "error"`. Not run: `status: "forbidden"`',
  },
  command: {
    done: "`exec`: an `exitCode` (any value); `code_execution`: its text",
    lesser:
      'Waiting: `status: "approval-pending"` or `Approval required (id \u2026`. Call made, still running: `status: "running"` or `Command still running (session \u2026`. Timed out, denied, blocked: the gateway\'s own error texts',
  },
  terminal: {
    done: "`terminal`: a result that carries text or details",
    lesser: "Call made: neither",
  },
  web: {
    done: '`web_search`: `kind: "results"` with a `results` array, or `kind: "answer"` with content',
    lesser:
      'Partial: `truncated: true`. Unavailable: `kind: "error"` or a provider `error`. Call made: `kind: "raw"` or nothing it reads',
  },
  xsearch: {
    done: "`x_search`: its text, or `content`, and no `error`",
    lesser: "Unavailable: an `error` such as `missing_xai_api_key`",
  },
  page: {
    done: "`web_fetch`: its `text`, or the `length` it reports when history cut the text, with `truncated` not true",
    lesser: "Partial: `truncated: true`. Unavailable: no text",
  },
  browser: {
    done: "`browser`: a result that carries text or details",
    lesser: "Call made: neither",
  },
  computer: {
    done: "`computer`: an observation's result; an act's `details.result.effect: \"confirmed\"`",
    lesser:
      "Not confirmed: `effect` `unverifiable` or `suspected_noop`. Failed: `details.result.ok: false`. Call made: an act with no effect",
  },
  phone: {
    done: "`mobile_ui`: an observation's `snapshotId`",
    lesser:
      'Not run: `code: "confirmation_required"`, or a refusal `outcome.code`. Call made: any other `outcome.code`',
  },
  screen: {
    done: "`screen`: a result that carries text or details",
    lesser: "Call made: neither",
  },
  routine: {
    done: "`automations`, `cron`: add or update: the job's `id`; remove: `removed: true`; run: a `run` whose `status` is `ok`; next_check: `ok: true` with `delayMs`; look-ups: a result that carries text or details",
    lesser:
      "Queued: `enqueued: true` and no `run`. Not found: `removed: false`. Not run: `ran: false`. Failed: a `run` whose `status` is `error` or that carries an `error`. Call made, finished, outcome not known: `finished: true` and no `run`",
  },
  message: {
    done: "`sessions_send`: the Messaged card (section 10)",
    lesser: "The Messaged card's own states",
  },
  tasks: {
    done: "`sessions_*`, `session_status`, `agents_list`: a result that carries text or details, and no signal of the general reading",
    lesser: 'Not run: `status: "forbidden"`. Failed: `status: "error"`',
  },
  helper: {
    done: '`sessions_spawn`: Started on `status: "accepted"`; `subagents` list: a result that carries text or details',
    lesser:
      'Not run: `status: "forbidden"`. Failed: `status: "error"`. Call made: a wait, kill or steer',
  },
  question: {
    done: '`ask_user`: `status: "answered"`',
    lesser: "Call made, with the status in words: `no_answer`, `dismissed`, `expired`, `cancelled`",
  },
  plan: {
    done: "`progress_card`: a `revision`, or the gateway's answer that it cleared the card; goals: a result that carries text or details",
    lesser: 'Failed: `update_goal` with `status: "error"`. Call made: no revision',
  },
  media: {
    done: "generate: a non-empty `media` or `paths`, or `Generated N \u2026 with \u2026`; `tts`: `audioPath` or `(spoken) \u2026`; list or status: a result that carries text or details",
    lesser:
      'Started: `async` with `status: "started"`, or `Background task started for \u2026`. Call made: an empty list',
  },
  look: {
    done: "`pdf`, `view_image`: their text, and no `details.error`",
    lesser:
      "Not run: `too_many_pdfs`, `too_many_images`, `unsupported_pdf_reference`, `unsupported_image_reference`, or the tool's own sentences for them (`Too many PDFs: \u2026`)",
  },
  channel: {
    done: '`conversations_send`: `status: "sent"`; `conversations_turn`: `status: "replied"` (or `sent`, with or without an error flag)',
    lesser:
      "Queued: `queued`. Suppressed: `suppressed`. Call made, sent, no reply in time: `timeout`. Call made: `unknown`, or the `message` tool's result",
  },
  server: {
    done: "A tool server's result that carries text or details beyond its identity, without an error flag",
    lesser:
      'Not run: `details.status: "blocked"` or the gateway\'s own block sentences. Unknown: `aborted`, `cancelled`. Call made: an empty result',
  },
  t3: {
    done: "T3 Code: the T3 Code card (section 11)",
    lesser: "The T3 Code card's own states",
  },
  tool: {
    done: 'Any other tool: a value that says the work was done (`ok: true`, a `status` or `code` of `ok`, `completed`, `success`, `sent`, `accepted`, `answered`, `replied`, `removed: true`, `effect: "confirmed"`)',
    lesser: "Every signal of the general reading (7.3); Call made: anything else",
  },
};

/**
 * One function decides a call's outcome, for a single card, a fold's members
 * and the status line: what the event stream established first; then the
 * kind's adapter where it names something more exact than Done; then the
 * general reading; Done only when neither finds a signal (7.3).
 */
export function outcomeOf(given: ActionCall, ctx: ReadingContext = EMPTY_CTX): OutcomeOf {
  const call = payloadRead(given, ctx);
  const kind = kindOf(call, ctx);
  switch (call.status) {
    case "running":
      return { outcome: "running" };
    case "review":
      return { outcome: "review" };
    case "waiting":
      return { outcome: "waiting" };
    case "stopped":
      return { outcome: kind.leaves ? "unknown" : "stopped" };
    case "cut-off":
      return { outcome: "failed", word: STATE_WORDS.aborted };
    case "unreturned":
      // Nothing establishes what happened to it.
      return { outcome: "unknown" };
    case "returned":
      break;
  }
  // The gateway's own sentences for a call it blocked before launch, kept in history as text.
  if (GATEWAY_BLOCKED.test(str(call.text).trim())) return { outcome: "blocked", word: "policy" };
  if (call.isError) return errorOutcome(call, kind);
  const read = settledOutcome(call, kind);
  // A result whose text is cut is read only for what its readable part and its kept details
  // establish: Done never rests on text that is not all there.
  if (read.outcome === "done" && call.cut) {
    const without = settledOutcome({ ...call, text: "" }, kind);
    if (without.outcome !== "done") return { outcome: "made", word: STATE_WORDS.storedCut };
  }
  // Nothing established, from a result whose text is cut: say the stored result was cut.
  if (read.outcome === "made" && !read.word && call.cut)
    return { outcome: "made", word: STATE_WORDS.storedCut };
  return read;
}

/** The outcome of a call that returned without an error flag (7.3). */
function settledOutcome(call: ActionCall, kind: KindInfo): OutcomeOf {
  const adapter = ADAPTERS[kind.kind];
  const norm = (o: OutcomeOf | Outcome): OutcomeOf => (typeof o === "string" ? { outcome: o } : o);
  const own = adapter ? norm(adapter(call)) : { outcome: "made" as const };
  // An outcome the kind names more exactly than the reading (Started, Partial, No change…).
  if (own.outcome !== "done" && own.outcome !== "made") return own;
  const general = generalReading(call.details);
  const word = (o: OutcomeOf): OutcomeOf => ({
    outcome: o.outcome,
    ...(o.word ? { word: o.word } : {}),
  });
  // A signal of the general reading outranks the kind's Done and its fallback.
  if (general?.signal === "problem") return word(general);
  if (own.outcome === "made" && own.word) return own;
  // Done only where neither the reading finds a value it shows as received nor the kind lacks its evidence.
  if (general) return word(general);
  return own;
}

/** A progress card the gateway cleared: no card, so no revision and no steps. */
function clearedPlan(call: ActionCall): boolean {
  const d = call.details;
  if (d && "revision" in d)
    return d.revision === null && (d.steps === null || d.steps === undefined);
  return /^Progress card cleared/.test(str(call.text));
}

/** What a fold and the run line count an outcome as (7.3, last column). */
export type Problem = keyof typeof PROBLEM_WORDS;
const PROBLEMS: Partial<Record<Outcome, Problem>> = {
  failed: "failed",
  blocked: "notRun",
  denied: "notRun",
  refused: "notRun",
  unavailable: "unavailable",
  notfound: "notFound",
  suppressed: "suppressed",
  stopped: "stopped",
  unknown: "unknown",
};
export const PROBLEM_ORDER: readonly Problem[] = Object.keys(PROBLEM_WORDS) as Problem[];

export type Short = keyof typeof SHORT_WORDS;
const SHORTS: Partial<Record<Outcome, Short>> = {
  started: "started",
  queued: "queued",
  unconfirmed: "notConfirmed",
  made: "callMade",
  unchanged: "noChange",
  partial: "partial",
};
export const SHORT_ORDER: readonly Short[] = Object.keys(SHORT_WORDS) as Short[];

export const problemOf = (outcome: Outcome): Problem | null => PROBLEMS[outcome] ?? null;
export const shortOf = (outcome: Outcome): Short | null => SHORTS[outcome] ?? null;

// Words -------------------------------------------------------------------------------

type Pair = readonly [verb: string, object: string];

/** The words of one call: each form its line can take, before the outcome chooses. */
type Words = {
  run: Pair;
  done: Pair;
  fail: Pair;
  /** A noun form, for a call whose effect leaves the gateway or that proves nothing more. */
  noun?: Pair;
  started?: Pair;
  queued?: Pair;
  notfound?: Pair;
  refused?: Pair;
  suppressed?: Pair;
  unchanged?: Pair;
  detail: string;
  mono?: boolean;
  exit?: string;
  icon?: ActionIcon;
};

const three = (
  forms: VerbForms,
  object: string,
  detail = "",
  more: Partial<Words> = {},
): Words => ({
  run: [forms[0], object],
  done: [forms[1], object],
  fail: [forms[2], object],
  detail,
  ...more,
});

const ICONS: Record<ActionKind, ActionIcon> = {
  read: "read",
  list: "list",
  edit: "write",
  memory: "memory",
  recall: "recall",
  command: "command",
  terminal: "command",
  web: "search",
  xsearch: "search",
  page: "web",
  browser: "window",
  computer: "screen",
  phone: "screen",
  screen: "window",
  routine: "clock",
  message: "message",
  tasks: "tasks",
  helper: "helpers",
  question: "question",
  plan: "plan",
  media: "image",
  look: "read",
  channel: "message",
  server: "plug",
  t3: "plug",
  tool: "tool",
};

function wordsOf(call: ActionCall, kind: ActionKind, ctx: ReadingContext): Words {
  const a = call.args;
  const d = call.details ?? {};
  switch (kind) {
    case "read":
      return three(VERBS.read, a.path ? baseName(str(a.path)) : OBJECTS.aFile, readCount(call));
    case "list":
      return three(VERBS.list, a.path ? baseName(str(a.path)) : OBJECTS.aFolder);
    case "edit": {
      const files = filesOf(call);
      const object =
        files.length === 1
          ? baseName(files[0]!)
          : files.length
            ? PLURALS.files(files.length)
            : call.name === "apply_patch"
              ? OBJECTS.aPatch
              : OBJECTS.aFile;
      const patchOnly = call.name === "apply_patch" && !files.length;
      const stat = diffStat(call.details);
      return {
        run: [patchOnly ? VERBS.patch[0] : VERBS.edit[0], object],
        done: [
          patchOnly ? VERBS.patch[1] : d.created === true ? VERBS.create[1] : VERBS.edit[1],
          object,
        ],
        fail: [VERBS.edit[2], object],
        unchanged: [FORMS.left, FORMS.unchanged(object)],
        detail: stat ? diffText(stat) : "",
      };
    }
    case "memory": {
      const stat = diffStat(call.details);
      return three(
        VERBS.memorySave,
        OBJECTS.memory,
        call.name === "write" ? firstWords(a.content) : stat ? diffText(stat) : "",
        { unchanged: [FORMS.left, FORMS.unchanged(baseName(str(a.path)))] },
      );
    }
    case "recall": {
      if (call.name === "memory_get") {
        const note = baseName(str(a.path));
        return three(VERBS.memoryRead, note, "", {
          notfound: [FORMS.foundNoNote, FORMS.inMemory(note)],
        });
      }
      const results = list(d.results);
      const stale = rec(d.staleness)?.warning;
      return three(
        VERBS.memorySearch,
        quoted(a.query),
        Array.isArray(d.results) && d.unavailable !== true
          ? `${PLURALS.matches(results.length)}${stale ? ` · ${FORMS.mayBeStale}` : ""}`
          : "",
      );
    }
    case "command": {
      if (call.name === "code_execution") return three(VERBS.run, OBJECTS.code, str(a.task));
      const exit = num(d.exitCode);
      return three(VERBS.run, programOf(a.command) || OBJECTS.aCommand, str(a.command), {
        mono: true,
        exit: exit ? FORMS.exit(exit) : "",
      });
    }
    case "terminal": {
      const id = str(a.sessionId);
      switch (a.action) {
        case "list":
          return three(VERBS.lookAt, OBJECTS.sharedTerminals);
        case "read":
          return three(VERBS.readTerminal, OBJECTS.aTerminal, id);
        case "resize":
          return three(VERBS.resize, OBJECTS.aTerminal, id);
        case "close":
          return three(VERBS.close, OBJECTS.aTerminal, id);
        case "input":
          return three(VERBS.typeInto, OBJECTS.aTerminal, id);
        default:
          return three(VERBS.use, OBJECTS.aSharedTerminal, id);
      }
    }
    case "web":
      return three(
        VERBS.webSearch,
        quoted(a.query),
        Array.isArray(d.results) ? PLURALS.results(list(d.results).length) : "",
      );
    case "xsearch":
      return three(
        VERBS.xSearch,
        quoted(a.query),
        Array.isArray(d.citations) ? PLURALS.sources(list(d.citations).length) : "",
      );
    case "page": {
      const status = num(d.status);
      const title = unwrapExternal(d.title);
      return three(
        VERBS.open,
        hostOf(str(a.url)),
        status !== null && status >= 400
          ? `${FORMS.httpStatus(status)}${title ? ` · ${title}` : ""}`
          : title,
      );
    }
    case "browser": {
      const r = rec(a.request) ?? {};
      const where = a.targetUrl ? hostOf(str(a.targetUrl)) : "";
      const t = (forms: VerbForms, object: string): Words => ({
        ...three(forms, object, where),
        fail: [VERBS.use[2], OBJECTS.theBrowser],
      });
      switch (a.action) {
        case "open":
        case "navigate":
          return t(VERBS.open, where || OBJECTS.thePage);
        case "snapshot":
          return t(VERBS.readPage, OBJECTS.thePage);
        case "screenshot":
          return t(VERBS.take, OBJECTS.aScreenshot);
        case "act":
          if (r.kind === "click")
            return t(
              VERBS.click,
              r.element ? quoted(r.element) : r.text ? quoted(r.text) : OBJECTS.anElement,
            );
          if (r.kind === "type" || r.kind === "fill")
            return t(VERBS.typeInto, r.element ? quoted(r.element) : OBJECTS.aField);
          return t(VERBS.use, OBJECTS.theBrowser);
        case "upload":
          return t(VERBS.upload, OBJECTS.aFile);
        case "dialog":
          return t(VERBS.answer, OBJECTS.aDialog);
        default:
          return t(VERBS.use, OBJECTS.theBrowser);
      }
    }
    case "computer": {
      const action = str(a.action);
      const t = (forms: VerbForms, object: string): Words => ({
        ...three(forms, object, str(a.node)),
        fail: [VERBS.use[2], OBJECTS.theComputer],
      });
      if (OBSERVE[action]) return t(VERBS.lookAt, OBJECTS.theScreen);
      if (/^(double|triple)_click$/.test(action)) return t(VERBS.doubleClickOn, OBJECTS.theScreen);
      if (/_click$/.test(action)) return t(VERBS.clickOn, OBJECTS.theScreen);
      if (/drag/.test(action)) return t(VERBS.dragOn, OBJECTS.theScreen);
      if (action === "type") return t(VERBS.type, "");
      if (action === "key" || action === "hold_key")
        return t(VERBS.press, str(a.text) || OBJECTS.aKey);
      if (action === "scroll") return t(VERBS.scroll, "");
      if (action === "take_control") return t(VERBS.hand, OBJECTS.theComputer);
      return t(VERBS.use, OBJECTS.theComputer);
    }
    case "phone": {
      const m = rec(a.mobileAction) ?? {};
      const type = str(m.type);
      const [forms, object]: [VerbForms, string] =
        a.action === "observe"
          ? [VERBS.lookAt, OBJECTS.thePhone]
          : type === "tap" || type === "activate"
            ? [VERBS.tapOn, OBJECTS.thePhone]
            : type === "set_text"
              ? [VERBS.enterTextOn, OBJECTS.thePhone]
              : type === "swipe" || type === "scroll"
                ? [VERBS.swipeOn, OBJECTS.thePhone]
                : type === "global_action"
                  ? [VERBS.press, upper(nameWords(str(m.name) || OBJECTS.aButton))]
                  : type === "wait"
                    ? [VERBS.waitOn, OBJECTS.thePhone]
                    : [VERBS.use, OBJECTS.thePhone];
      // The base form says what was not done: "Didn't tap on the phone".
      const refusedVerb =
        forms === VERBS.use ? FORMS.didntUse : `${FORMS.didnt} ${lower(baseVerbOf(forms))}`;
      return {
        ...three(forms, object, str(a.node)),
        fail: [VERBS.use[2], OBJECTS.thePhone],
        refused: [refusedVerb, object],
      };
    }
    case "screen": {
      const words = nameWords(str(a.action)).replace(
        /^(.+) (show|hide)$/,
        (_m, what: string, how: string) => `${what} ${how === "show" ? FORMS.shown : FORMS.hidden}`,
      );
      return three(VERBS.change, OBJECTS.theControlUi, str(a.action) ? words : "");
    }
    case "routine": {
      const job = rec(a.job) ?? {};
      const name = str(job.name) || str(a.name);
      const when = scheduleWords(job.schedule);
      switch (a.action) {
        case "add":
          return three(VERBS.createRoutine, name, when);
        case "update":
          return name
            ? three(VERBS.changeRoutine, name, when)
            : three(VERBS.change, OBJECTS.aRoutine, when);
        case "remove":
          return {
            ...(name ? three(VERBS.removeRoutine, name) : three(VERBS.remove, OBJECTS.aRoutine)),
            notfound: [FORMS.foundNoRoutine, FORMS.toRemove(name)],
          };
        case "run":
          return {
            ...three(VERBS.runRoutine, name || OBJECTS.aRoutine),
            queued: [FORMS.askedRoutine, FORMS.toRun(name || OBJECTS.aRoutine)],
          };
        case "next_check": {
          const ms = num(d.delayMs);
          const in_ = ms
            ? ms >= 3_600_000
              ? `${Math.round(ms / 3_600_000)}h`
              : `${Math.round(ms / 60_000)}m`
            : str(a.in);
          return three(VERBS.propose, nextCheck(in_));
        }
        case "wake":
          return three(VERBS.wake, OBJECTS.theScheduler);
        default:
          return three(VERBS.lookAt, OBJECTS.routines);
      }
    }
    case "tasks": {
      if (call.name === "sessions_history") {
        const key = str(a.sessionKey);
        const agent = /^agent:([^:]+):/.exec(key)?.[1] ?? null;
        const who = agent ? (ctx.botName?.(agent) ?? null) : null;
        const object = who ? someonesTask(who) : OBJECTS.aTask;
        return { ...three(VERBS.read, object), refused: [FORMS.didntRead, object] };
      }
      if (call.name === "sessions_search")
        return {
          ...three(VERBS.searchTasks, quoted(a.query)),
          refused: [FORMS.didntSearchTasks, quoted(a.query)],
        };
      if (call.name === "agents_list") return three(VERBS.lookThrough, OBJECTS.bots);
      if (call.name === "session_status") return three(VERBS.check, OBJECTS.thisTaskStatus);
      return three(
        VERBS.lookThrough,
        OBJECTS.tasks,
        num(d.count) !== null ? PLURALS.tasks(num(d.count)!) : "",
      );
    }
    case "helper": {
      if (call.name === "agents_wait") {
        const helpers = PLURALS.helpers(list(a.ids).length);
        return { ...three(VERBS.waitFor, helpers), noun: [NOUNS.waitFor, helpers] };
      }
      if (call.name === "subagents") {
        if (a.action === "kill")
          return {
            ...three(VERBS.stopHelper, OBJECTS.aHelper, str(a.target)),
            noun: [NOUNS.stopFor, OBJECTS.aHelper],
          };
        if (a.action === "steer")
          return {
            ...three(VERBS.redirect, OBJECTS.aHelper, str(a.target)),
            noun: [NOUNS.redirectFor, OBJECTS.aHelper],
          };
        return three(VERBS.lookAt, OBJECTS.helpers);
      }
      const label = str(a.label);
      return {
        ...three(VERBS.startHelper, label || OBJECTS.aHelper, firstWords(a.task, 8)),
        run: [VERBS.startHelper[0], label || OBJECTS.aHelper],
        fail: [VERBS.startHelper[2], label || OBJECTS.aHelper],
        noun: [NOUNS.helper, label || NOUNS.forATask],
        started: [FORMS.startedHelper, label || OBJECTS.untitled],
        refused: [FORMS.didntStartHelper, label || OBJECTS.untitled],
      };
    }
    case "question": {
      const first = rec(list(a.questions)[0]);
      return three(VERBS.ask, OBJECTS.aQuestion, str(first?.question));
    }
    case "plan": {
      if (call.name === "create_goal") return three(VERBS.set, OBJECTS.aGoal, str(a.objective));
      if (call.name === "update_goal") return three(VERBS.mark, theGoalStatus(str(a.status)));
      if (call.name === "get_goal") return three(VERBS.check, OBJECTS.theGoal);
      const steps = list(a.plan).map(rec);
      // A call with neither part clears the card; so does the gateway's answer that it did.
      const clearing = !steps.length && !str(a.markdown).trim();
      if (clearedPlan(call) || (clearing && call.status !== "returned"))
        return three(VERBS.clearPlan, OBJECTS.thePlan);
      const card = rec(d.steps);
      const total = num(card?.total) ?? steps.length;
      const done = num(card?.completed) ?? steps.filter((s) => s?.status === "completed").length;
      // The gateway's revision says whether this made the card or saved it again; without it, saved.
      const made = num(d.revision) === 1;
      return three(
        made ? VERBS.makePlan : VERBS.savePlan,
        made ? OBJECTS.aPlan : OBJECTS.thePlan,
        done ? FORMS.ofDone(done, total) : total ? PLURALS.steps(total) : "",
      );
    }
    case "media": {
      if (call.name === "tts")
        return {
          ...three(VERBS.make, OBJECTS.aVoiceClip, firstWords(a.text)),
          noun: [NOUNS.voiceClip, ""],
          icon: "wave",
        };
      const [one, many, noun] = MEDIA[call.name] ?? ["item", "items", "Media"];
      const icon: ActionIcon =
        call.name === "video_generate" ? "film" : call.name === "music_generate" ? "note" : "image";
      if (a.action === "list") return { ...three(VERBS.lookAt, mediaModels(one)), icon };
      if (a.action === "status") return { ...three(VERBS.check, mediaGeneration(one)), icon };
      // The count is the result's, never the request's.
      const made =
        list(d.paths).length || num(d.count) || list(d.media).length || mediaMade(call.text);
      const asked = num(a.count) ?? 1;
      return {
        ...three(VERBS.make, mediaCount(made, one, many), firstWords(a.prompt)),
        run: [VERBS.make[0], mediaCount(1, one, many)],
        noun: [noun, ""],
        started: [FORMS.startedMaking, mediaCount(asked, one, many)],
        icon,
      };
    }
    case "look": {
      const files = filesOf(call);
      const pdf = call.name === "pdf";
      const object =
        files.length > 1
          ? pdf
            ? PLURALS.pdfs(files.length)
            : PLURALS.images(files.length)
          : files.length
            ? baseName(files[0]!)
            : OBJECTS.aFile;
      return pdf
        ? {
            ...three(
              VERBS.read,
              object,
              a.pages ? FORMS.pagesAsked(str(a.pages)) : firstWords(a.prompt),
            ),
            refused: [FORMS.didntRead, object],
          }
        : {
            ...three(VERBS.lookAt, object, firstWords(a.prompt)),
            refused: [FORMS.didntLookAt, object],
          };
    }
    case "channel": {
      const object = str(d.channel) || str(a.channel) || OBJECTS.aConversation;
      const to = str(a.to) || str(a.target);
      return {
        ...three(VERBS.send, object, FORMS.toWhom(to, firstLine(a.message))),
        noun: [NOUNS.messageOn, object],
        suppressed: [FORMS.didntSend, object],
      };
    }
    case "server": {
      const id = toolServerOf(call, ctx)!;
      return {
        ...three(VERBS.use, id.server, nameWords(id.tool)),
        noun: [NOUNS.toolServer, id.server],
      };
    }
    case "message":
    case "t3": {
      // The Messaged cards' own words: the status line says what the card says (sections 5, 10, 11).
      const agent = /^agent:([^:]+):/.exec(str(a.sessionKey))?.[1] ?? null;
      const who =
        kind === "t3"
          ? OBJECTS.t3Code
          : agent
            ? (ctx.botName?.(agent) ?? agent)
            : str(a.label) || OBJECTS.anotherBot;
      return {
        ...three(VERBS.message, who, firstLine(a.message ?? a.prompt)),
        noun: [NOUNS.messaging, who],
      };
    }
    case "tool": {
      const w = nameWords(call.name);
      return {
        ...three(VERBS.use, w, generalDetail(a)),
        noun: [NOUNS.callTo, w],
        refused: [FORMS.didntUse, w],
        notfound: [NOUNS.findNothingWith, w],
      };
    }
  }
}

/** The bare verb of a phone action, for "Didn't tap on the phone". */
function baseVerbOf(forms: VerbForms): string {
  // The running form without its -ing: Tapping on → Tap on, Entering text on → Enter text on.
  const map: Record<string, string> = {
    "Looking at": "Look at",
    "Tapping on": "Tap on",
    "Entering text on": "Enter text on",
    "Swiping on": "Swipe on",
    Pressing: "Press",
    "Waiting on": "Wait on",
  };
  return map[forms[0]] ?? forms[0];
}

/** A failure's or refusal's reason: the received text when the payload's error is only a code. */
function reasonOf(call: ActionCall): string {
  const e = call.details?.error;
  const text = str(call.text).trim();
  if (e && /^[a-z0-9_]+$/.test(str(e)) && text && !text.startsWith("{")) return firstLine(text);
  return e && typeof e !== "object" ? firstLine(str(e)) : "";
}

/**
 * What went wrong, from a result's text: a tool that answers with a JSON body
 * (its `error`, else its `message`) when history kept no `details`, else the
 * text's first line.
 */
function textReason(text: string | null): string {
  const t = str(text).trim();
  if (t.startsWith("{")) {
    try {
      const body = rec(JSON.parse(t));
      const said = str(body?.error) || str(body?.message);
      if (said) return firstLine(said);
    } catch {
      // Not whole JSON: the gateway may have cut it. Its first line says nothing.
      return "";
    }
    return "";
  }
  return firstLine(t);
}

// The line ----------------------------------------------------------------------------

/** The mark at the right of a line, or the time. */
export type StateMark =
  | { type: "time" }
  | { type: "elapsed" }
  | {
      type: "word";
      glyph:
        "working" | "sending" | "waiting" | "check" | "queued" | "stopped" | "blocked" | "failed";
      word: string;
      tone?: "danger" | "warn" | "accent";
    };

export type ActionLine = {
  id: string;
  kind: ActionKind;
  icon: ActionIcon;
  key: string | null;
  leaves: boolean;
  outcome: Outcome;
  verb: string;
  object: string;
  detail: string;
  /** The detail is a command line. */
  mono: boolean;
  /** "exit 1": the command's answer, in plain text after the detail. */
  exit: string;
  /** What shows at the right. */
  state: StateMark;
  /** The words a fold row, the status line and an accessible name use while it runs. */
  running: string;
  problem: Problem | null;
  short: Short | null;
  /** The accessible name: verb and object, the detail, and the state. */
  spoken: string;
  /** The tooltip: the whole line. */
  title: string;
};

/** The duration of a call, when the gateway reported both ends. */
export function tookOf(call: Pick<ActionCall, "startedAt" | "endedAt">): number | null {
  return call.startedAt !== null && call.endedAt !== null && call.endedAt >= call.startedAt
    ? call.endedAt - call.startedAt
    : null;
}

function stateMark(call: ActionCall, info: KindInfo, o: OutcomeOf): StateMark {
  const word = (
    glyph: Extract<StateMark, { type: "word" }>["glyph"],
    text: string,
    tone?: "danger" | "warn" | "accent",
  ): StateMark =>
    tone ? { type: "word", glyph, word: text, tone } : { type: "word", glyph, word: text };
  if (call.lastSeen && isOpenOutcome(o.outcome) && o.outcome !== "waiting") {
    return info.leaves
      ? word("sending", STATE_WORDS.lastSeenCallStarted)
      : word("working", STATE_WORDS.lastSeenRunning);
  }
  switch (o.outcome) {
    case "running":
      return info.leaves ? word("sending", STATE_WORDS.callStarted) : { type: "elapsed" };
    case "review":
      return { type: "elapsed" };
    case "waiting":
      return call.readOnly
        ? word("waiting", STATE_WORDS.waitingForApproval, "warn")
        : word("waiting", STATE_WORDS.waitingForYou, "warn");
    case "partial":
      return word("queued", STATE_WORDS.partial);
    case "started":
      return word("check", STATE_WORDS.started);
    case "queued":
      return word("queued", STATE_WORDS.queued);
    case "made":
      return word(o.word ? "queued" : "check", o.word ?? STATE_WORDS.callMade);
    case "unconfirmed":
      return word("queued", STATE_WORDS.notConfirmed);
    case "unchanged":
      return word("queued", STATE_WORDS.noChange);
    case "notfound":
      return word("queued", STATE_WORDS.notFound);
    case "refused":
      return word("stopped", o.word ?? STATE_WORDS.notRun);
    case "suppressed":
      return word("stopped", STATE_WORDS.suppressed);
    case "unavailable":
      return word("blocked", STATE_WORDS.unavailable, "warn");
    case "failed":
      return word("failed", o.word ?? STATE_WORDS.failed, "danger");
    case "blocked":
      return word("failed", STATE_WORDS.notRun, "danger");
    case "denied":
      return word("stopped", o.word ?? STATE_WORDS.denied);
    case "stopped":
      return word("stopped", STATE_WORDS.stopped);
    case "unknown":
      return word("queued", STATE_WORDS.unknown);
    case "done":
      return o.word ? word("check", o.word, "accent") : { type: "time" };
  }
}

/** The state words an accessible name ends with. */
function spokenState(call: ActionCall, mark: StateMark, o: OutcomeOf): string {
  if (mark.type === "word") return mark.word.toLowerCase();
  if (o.outcome === "running" || o.outcome === "review") return "running";
  const took = tookOf(call);
  return took !== null ? spokenSeconds(took) : "done";
}

/** The line of one call in its state (7.2, 7.3, 8.2 to 8.4). */
export function lineOf(given: ActionCall, ctx: ReadingContext = EMPTY_CTX): ActionLine {
  const call = payloadRead(given, ctx);
  const info = kindOf(call, ctx);
  const w = wordsOf(call, info.kind, ctx);
  const o = outcomeOf(call, ctx);
  const runningPair: Pair = info.leaves ? (w.noun ?? w.run) : w.run;
  const runPhrase = (p: Pair) => lower(`${p[0]} ${p[1]}`.trim());
  let pair: Pair;
  switch (o.outcome) {
    case "running":
      pair = runningPair;
      break;
    case "review":
      pair = [FORMS.reviewing, w.run[1]];
      break;
    case "waiting":
      pair = info.kind === "command" ? [FORMS.wantsToRun, w.run[1]] : (w.noun ?? w.run);
      break;
    case "done":
    case "partial":
    case "unconfirmed":
      pair = w.done;
      break;
    case "started":
      pair = w.started ?? [FORMS.started, runPhrase(w.run)];
      break;
    case "queued":
      pair = w.queued ?? w.noun ?? w.done;
      break;
    case "made":
      pair = w.noun ?? w.done;
      break;
    case "unchanged":
      pair = w.unchanged ?? [FORMS.left, FORMS.unchanged(w.done[1])];
      break;
    case "notfound":
      pair = w.notfound ?? [FORMS.foundNo, w.done[1] || OBJECTS.result];
      break;
    case "refused":
      pair =
        w.refused ??
        (info.kind === "command" ? [FORMS.didntRun, w.run[1]] : [FORMS.notRun, runPhrase(w.run)]);
      break;
    case "suppressed":
      pair = w.suppressed ?? [FORMS.didnt, runPhrase(w.run)];
      break;
    case "unavailable":
    case "failed":
      pair = w.fail;
      break;
    case "blocked":
      pair = [o.word === "review" ? FORMS.blockedByReview : FORMS.blockedByPolicy, ""];
      break;
    case "denied":
      pair =
        info.kind === "command"
          ? [FORMS.didntRun, w.run[1]]
          : (w.refused ?? [FORMS.notRun, runPhrase(w.run)]);
      break;
    case "stopped":
      pair = [FORMS.stopped, runPhrase(w.run)];
      break;
    case "unknown":
      pair =
        call.status === "unreturned"
          ? (w.noun ?? [FORMS.noResult, runPhrase(w.run)])
          : (w.noun ?? [FORMS.stopped, runPhrase(w.run)]);
      break;
  }
  let [verb, object] = pair;
  let detail = w.detail;
  let mono = Boolean(w.mono);
  // A blocked command keeps its command line as the detail (8.4).
  if (o.outcome === "blocked" && info.kind === "command") detail = str(call.args.command);
  // A command past its own limit, or cut off by the run's (8.4).
  const timedOut =
    o.outcome === "failed" && o.word === STATE_WORDS.timedOut && info.kind === "command";
  const cutOff = call.status === "cut-off" && info.kind === "command";
  if (timedOut || cutOff) {
    verb = timedOut ? FORMS.timedOut : FORMS.cutOff;
    object = programOf(call.args.command) || OBJECTS.aCommand;
    detail = timedOut
      ? FORMS.itsLimit(num(call.args.timeoutSeconds) ?? num(call.args.timeout))
      : FORMS.runLimit;
    mono = false;
  } else if (o.outcome === "failed") {
    // A failure's detail is what went wrong, never a count from a result it did not give.
    const reason = (reasonOf(call) || textReason(call.text)).slice(0, 120);
    detail = reason || (info.kind === "command" ? detail : "");
    mono = info.kind === "command" && !reason;
  }
  const proposed = str(call.details?.proposedEffect);
  if (o.outcome === "refused" && proposed) detail = FORMS.wouldDo(proposed);
  // A refusal's or an unavailable result's reason: from its details where they were kept, else
  // from its text, which history keeps, so the line reads the same live and reloaded.
  if (o.outcome === "refused" && !proposed) {
    const reason = reasonOf(call) || textReason(call.text);
    if (reason) detail = reason;
  }
  if (o.outcome === "unavailable") {
    const d = call.details ?? {};
    if (d.warning) detail = str(d.warning);
    else if (d.error) detail = (str(d.message) || str(d.error)).split(/[.\n]/)[0] ?? "";
    else detail = (textReason(call.text).split(/\. /)[0] ?? "").replace(/\.$/, "");
  }
  const exit = o.outcome === "done" ? (w.exit ?? "") : "";
  const mark = stateMark(call, info, o);
  const words = [verb, object].filter(Boolean).join(" ");
  const running = [runningPair[0], runningPair[1]].filter(Boolean).join(" ");
  return {
    id: call.id,
    kind: info.kind,
    icon: w.icon ?? ICONS[info.kind],
    key: info.key,
    leaves: info.leaves,
    outcome: o.outcome,
    verb,
    object,
    detail,
    mono,
    exit,
    state: mark,
    running,
    problem: problemOf(o.outcome),
    short: shortOf(o.outcome),
    spoken: `${words}${detail ? `, ${detail}` : ""}${exit ? `, ${exit}` : ""}, ${spokenState(call, mark, o)}`,
    title: `${words}${detail ? ` · ${detail}` : ""}${exit ? ` · ${exit}` : ""}`,
  };
}

/** What an opened card says about an outcome short of Done, if anything (8.1, "Opened"). */
export function outcomeSentence(outcome: Outcome): string | null {
  return (OUTCOME_SENTENCES as Record<string, string>)[outcome] ?? null;
}

// Folds -------------------------------------------------------------------------------

/** One fold's plural, its done form and its neutral form (7.4). */
function pluralOf(kind: ActionKind, calls: ActionCall[], ctx: ReadingContext): Pair {
  const n = calls.length;
  const first = calls[0]!;
  const lineDone = (c: ActionCall) =>
    lineOf({ ...c, status: "returned", isError: false, details: { ...(c.details ?? {}) } }, ctx);
  switch (kind) {
    case "read":
    case "edit": {
      const files = calls.map(filesOf);
      const verb = kind === "read" ? VERBS.read[1] : VERBS.edit[1];
      const unit = kind === "read" ? PLURALS.reads : PLURALS.edits;
      // A count of objects never silently counts calls (7.4).
      if (files.some((f) => !f.length))
        return kind === "edit" ? [PLURALS.made, PLURALS.edits(n)] : [verb, PLURALS.times(n)];
      const distinct = new Set(files.flat()).size;
      const label = PLURALS.files(distinct);
      return n > distinct ? [verb, `${label} · ${unit(n)}`] : [verb, label];
    }
    case "list":
      return [VERBS.list[1], PLURALS.folders(n)];
    case "memory": {
      const notes = new Set(calls.map((c) => workspacePath(c.args.path, ctx) ?? str(c.args.path)))
        .size;
      return [
        PLURALS.saved,
        `${PLURALS.toMemory(PLURALS.notes(notes))}${n > notes ? ` · ${PLURALS.times(n)}` : ""}`,
      ];
    }
    case "recall":
      return [
        first.name === "memory_get" ? PLURALS.readFromMemory : PLURALS.searchedMemory,
        PLURALS.times(n),
      ];
    case "command":
      return [VERBS.run[1], PLURALS.commands(n)];
    case "web":
      return [PLURALS.searchedTheWeb, PLURALS.times(n)];
    case "xsearch":
      return [PLURALS.searchedX, PLURALS.times(n)];
    case "page":
      return [VERBS.open[1], PLURALS.pages(n)];
    case "browser":
      return [PLURALS.usedTheBrowser, `· ${PLURALS.actions(n)}`];
    case "computer":
      return [PLURALS.usedTheComputer, `· ${PLURALS.actions(n)}`];
    case "phone":
      return [PLURALS.usedThePhone, `· ${PLURALS.actions(n)}`];
    case "screen":
      return [PLURALS.changedTheControlUi, PLURALS.times(n)];
    case "routine":
      return [PLURALS.lookedAtRoutines, PLURALS.times(n)];
    case "plan":
      if (first.name === "progress_card") return [PLURALS.savedThePlan, PLURALS.times(n)];
      return [`${lineDone(first).verb} ${lineDone(first).object}`, PLURALS.times(n)];
    case "media": {
      if (first.name === "tts") return [PLURALS.made, PLURALS.voiceClips(n)];
      const [one, many] = MEDIA[first.name] ?? ["item", "items"];
      if (first.args.action === "list")
        return [VERBS.lookAt[1], `${mediaModels(one)} · ${PLURALS.times(n)}`];
      if (first.args.action === "status")
        return [VERBS.check[1], `${mediaGeneration(one)} · ${PLURALS.times(n)}`];
      const made = calls.reduce(
        (t, c) =>
          t +
          (list(c.details?.paths).length ||
            num(c.details?.count) ||
            list(c.details?.media).length ||
            mediaMade(c.text)),
        0,
      );
      return [PLURALS.made, made ? count(made, one, many) : `${many} · ${PLURALS.times(n)}`];
    }
    case "look": {
      const pdf = first.name === "pdf";
      const objects = calls.map(filesOf);
      if (objects.some((f) => !f.length))
        return [pdf ? PLURALS.readPdfs : PLURALS.lookedAtImages, PLURALS.times(n)];
      const k = new Set(objects.flat()).size;
      const label = pdf ? PLURALS.pdfs(k) : PLURALS.images(k);
      return [
        pdf ? VERBS.read[1] : VERBS.lookAt[1],
        n > 1 && objects.flat().length > k ? `${label} · ${PLURALS.times(n)}` : label,
      ];
    }
    default: {
      // Terminal look-ups, task look-ups and a listed general tool: the singular, so many times.
      const l = lineDone(first);
      return [`${l.verb} ${l.object}`.trim(), PLURALS.times(n)];
    }
  }
}

function startedPluralOf(kind: ActionKind, calls: ActionCall[]): Pair | null {
  if (kind !== "media") return null;
  const many = MEDIA[calls[0]!.name]?.[1] ?? "voice clips";
  return [FORMS.startedMaking, `${many} · ${PLURALS.times(calls.length)}`];
}

function neutralOf(kind: ActionKind, calls: ActionCall[], ctx: ReadingContext): string {
  const first = calls[0]!;
  switch (kind) {
    case "recall":
      return first.name === "memory_get" ? NEUTRAL.memoryRead : NEUTRAL.memorySearch;
    case "media": {
      if (first.name === "tts") return NEUTRAL.speech;
      const noun = MEDIA[first.name]?.[2] ?? "Media";
      return first.args.action === "list"
        ? NEUTRAL.mediaModels(noun)
        : first.args.action === "status"
          ? NEUTRAL.mediaStatus(noun)
          : NEUTRAL.mediaGeneration(noun);
    }
    case "look":
      return first.name === "pdf" ? NEUTRAL.pdf : NEUTRAL.image;
    case "tool":
    case "t3":
    case "message":
      return upper(nameWords(first.name));
    case "server":
      return NEUTRAL.toolServer(toolServerOf(first, ctx)?.server ?? "");
    default:
      return (NEUTRAL as unknown as Record<string, string>)[kind] ?? upper(nameWords(first.name));
  }
}

/** The members' objects, distinct and in order; for edits the summed change (7.4). */
function foldObjects(kind: ActionKind, calls: ActionCall[], lines: ActionLine[]): string {
  if (kind === "edit") {
    const stats = calls.map((c) => diffStat(c.details));
    if (stats.every((s) => s !== null))
      return diffText(
        stats.reduce((t, s) => ({ added: t.added + s!.added, removed: t.removed + s!.removed }), {
          added: 0,
          removed: 0,
        }),
      );
  }
  if (kind === "command") {
    const programs = [...new Set(calls.map((c) => programOf(c.args.command) || OBJECTS.aCommand))];
    return programs.length === 1 ? str(calls.at(-1)!.args.command) : programs.join(", ");
  }
  if (kind === "memory")
    return [...new Set(calls.map((c) => baseName(str(c.args.path))))].join(", ");
  if (kind === "look") return [...new Set(calls.flatMap(filesOf).map(baseName))].join(", ");
  if (kind === "plan") return lines.at(-1)!.detail;
  if (kind === "media") {
    const first = calls[0]!;
    if (first.args.action === "list" || first.args.action === "status") return "";
    return [
      ...new Set(calls.map((c) => firstWords(c.args.prompt ?? c.args.text, 4)).filter(Boolean)),
    ].join(", ");
  }
  if (kind === "browser")
    return [
      ...new Set(
        calls.map((c) => (c.args.targetUrl ? hostOf(str(c.args.targetUrl)) : "")).filter(Boolean),
      ),
    ].join(", ");
  return [...new Set(lines.map((l) => l.object).filter(Boolean))].join(", ");
}

export type FoldLine = {
  /** The first member's tool call id: the fold's key. */
  id: string;
  kind: ActionKind;
  icon: ActionIcon;
  count: number;
  verb: string;
  object: string;
  detail: string;
  /** The detail names a problem: danger when a failure or a block is among them. */
  tone: "danger" | "muted" | null;
  /** The fold's state: waiting, running, a settled count, or done with an optional summed time. */
  status: "waiting" | "running" | "failed" | "problem" | "short" | "done";
  state:
    | { type: "waiting"; readOnly: boolean }
    | { type: "running"; since: number | null; lastSeen: boolean; leaves: boolean }
    | {
        type: "counts";
        glyph: "failed" | "stopped" | "check" | "queued";
        words: string;
        danger: boolean;
      }
    | { type: "time"; ms: number | null };
  /** The running member, the latest to start. */
  running: ActionLine | null;
  lines: ActionLine[];
  spoken: string;
  title: string;
};

/**
 * A fold's line (7.4). Every member's outcome comes from the function a
 * single card uses, so a member that a single card shows waiting makes the
 * fold waiting. The plural is never more complete than its least-established
 * member; problems and outcomes short of Done are counted in their fixed order.
 */
export function foldLineOf(calls: ActionCall[], ctx: ReadingContext = {}): FoldLine {
  const lines = calls.map((c) => lineOf(c, ctx));
  const first = lines[0]!;
  const kind = first.kind;
  const open = (l: ActionLine) => isOpenOutcome(l.outcome);
  const settled = lines.filter((l) => !open(l));
  const asks = lines.some((l) => l.outcome === "waiting");
  const outcomes = settled.map((l) => l.outcome);
  const allDone = !asks && outcomes.every((o) => o === "done" || o === "partial");
  const allStarted = !asks && outcomes.length > 0 && outcomes.every((o) => o === "started");
  const problems = lines.filter((l) => l.problem !== null && !open(l));
  const doneOrProblem =
    !asks && outcomes.every((o) => o === "done" || o === "partial" || problemOf(o) !== null);
  const neutral: Pair = [neutralOf(kind, calls, ctx), `· ${PLURALS.calls(calls.length)}`];
  const started = allStarted ? startedPluralOf(kind, calls) : null;
  // The done plural counts the Done members only: "Read 1 file · 1 failed", "Searched memory
  // 1 time · 1 partial". A partial member is counted as partial, never as done (7.4).
  const doneCalls = calls.filter((_, i) => lines[i]!.outcome === "done");
  const [verb, object] =
    doneCalls.length > 0 && (allDone || (problems.length > 0 && doneOrProblem))
      ? pluralOf(kind, doneCalls, ctx)
      : (started ?? neutral);

  const live =
    [...lines].reverse().find((l) => l.outcome === "running" || l.outcome === "review") ?? null;
  const liveCall = live ? calls[lines.indexOf(live)]! : null;
  const waiting = lines.find((l) => l.outcome === "waiting") ?? null;
  const counts = PROBLEM_ORDER.map(
    (p) => [p, problems.filter((l) => l.problem === p).length] as const,
  ).filter(([, n]) => n);
  const shorts = SHORT_ORDER.map(
    (s) => [s, settled.filter((l) => l.short === s).length] as const,
  ).filter(([, n]) => n);
  const countWords = counts.map(([p, n]) => `${n} ${PROBLEM_WORDS[p]}`).join(" · ");
  const allWords = [
    ...counts.map(([p, n]) => `${n} ${PROBLEM_WORDS[p]}`),
    ...shorts.map(([s, n]) => `${n} ${SHORT_WORDS[s]}`),
  ].join(" · ");
  const danger = counts.some(([p]) => p === "failed" || p === "notRun");
  const busy = waiting !== null || live !== null;
  const phrase = (l: ActionLine) => `${lower(l.verb)}${l.object ? ` ${l.object}` : ""}`;

  let detail: string;
  let tone: FoldLine["tone"] = null;
  if (problems.length) {
    detail = `${busy ? `${countWords}: ` : ""}${phrase(problems[0]!)}`;
    tone = danger ? "danger" : "muted";
  } else if (live) {
    detail = lower(live.running);
  } else {
    detail = foldObjects(kind, calls, lines);
  }

  let state: FoldLine["state"];
  let status: FoldLine["status"];
  if (waiting) {
    state = { type: "waiting", readOnly: calls.some((c) => c.readOnly === true) };
    status = "waiting";
  } else if (live && liveCall) {
    state = {
      type: "running",
      since: liveCall.startedAt,
      lastSeen: liveCall.lastSeen === true,
      leaves: live.leaves,
    };
    status = "running";
  } else if (counts.length || shorts.length) {
    const glyph = danger
      ? "failed"
      : counts.length
        ? "stopped"
        : shorts[0]![0] === "started"
          ? "check"
          : "queued";
    state = { type: "counts", glyph, words: allWords, danger };
    status = danger ? "failed" : counts.length ? "problem" : "short";
  } else {
    // A duration is never a partial sum (7.4).
    const tooks = calls.map(tookOf);
    state = {
      type: "time",
      ms: tooks.every((t) => t !== null) ? tooks.reduce<number>((t, x) => t + x!, 0) : null,
    };
    status = "done";
  }
  const label = `${verb} ${object}`.trim();
  const stateSpoken =
    state.type === "waiting"
      ? STATE_WORDS.waitingForYou.toLowerCase()
      : state.type === "running"
        ? "running"
        : state.type === "counts"
          ? allWords.replace(/ · /g, ", ")
          : "done";
  return {
    id: calls[0]!.id,
    kind,
    icon: first.icon,
    count: calls.length,
    verb,
    object,
    detail,
    tone,
    status,
    state,
    running: live,
    lines,
    spoken: `${label}${detail ? `, ${detail}` : ""}, ${stateSpoken}`,
    title: `${label}${detail ? ` · ${detail}` : ""}`,
  };
}

/** "0.6s" for a time state, or null when it is not reported. */
export function foldTime(state: FoldLine["state"]): string | null {
  return state.type === "time" && state.ms !== null ? tookWords(state.ms) : null;
}

// Projections the engine keeps ---------------------------------------------------------

/** The most a step's projected arguments or details take, in JSON characters. */
export const MAX_ACTION_FACTS_CHARS = 2_048;

/** Keys of `details` the reading reads; everything else is left to the raw payload. */
const DETAIL_KEYS: Record<string, true> = {
  status: true,
  ok: true,
  error: true,
  code: true,
  message: true,
  warning: true,
  effect: true,
  outcome: true,
  result: true,
  removed: true,
  changed: true,
  created: true,
  partial: true,
  unavailable: true,
  disabled: true,
  async: true,
  enqueued: true,
  run: true,
  exitCode: true,
  durationMs: true,
  nodeId: true,
  exitReason: true,
  timedOut: true,
  failureKind: true,
  results: true,
  citations: true,
  content: true,
  count: true,
  title: true,
  text: true,
  truncated: true,
  mcpServer: true,
  mcpTool: true,
  paths: true,
  media: true,
  audioPath: true,
  delayMs: true,
  id: true,
  name: true,
  target: true,
  proposedEffect: true,
  package: true,
  snapshotId: true,
  channel: true,
  reply: true,
  nextAction: true,
  staleness: true,
  approvalId: true,
  answers: true,
  sessionKey: true,
  runId: true,
  diff: true,
  revision: true,
  steps: true,
  // The kind of result a tool says it returned: a file's content, a capped read, an answer.
  kind: true,
  continuation: true,
  length: true,
  ran: true,
  reason: true,
  finished: true,
};

/**
 * A value cut to fit: strings to `chars`, lists to `items`, objects to
 * `depth`. The reading only tests these values' presence and their first
 * characters, so a cut value reads the same.
 */
function prune(value: unknown, chars: number, items: number, depth: number): unknown {
  if (typeof value === "string") return value.length > chars ? value.slice(0, chars) : value;
  if (value === null || typeof value !== "object") return value;
  if (depth <= 0) return Array.isArray(value) ? [] : {};
  if (Array.isArray(value))
    return value.slice(0, items).map((each) => prune(each, chars, items, depth - 1));
  const out: Rec = {};
  for (const [key, each] of Object.entries(value as Rec))
    out[key] = prune(each, chars, items, depth - 1);
  return out;
}

function fit(value: Rec, attempts: Array<[number, number, number]>): Rec | null {
  for (const [chars, items, depth] of attempts) {
    const pruned = prune(value, chars, items, depth) as Rec;
    if (JSON.stringify(pruned).length <= MAX_ACTION_FACTS_CHARS) return pruned;
  }
  return null;
}

/** What the reading needs of a call's arguments, within `MAX_ACTION_FACTS_CHARS`. */
export function projectArgs(args: unknown): Rec | null {
  let value = args;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const r = rec(value);
  if (!r) return null;
  // A patch's input is read for its file lines only.
  const input = typeof r.input === "string" ? patchHeads(r.input) : undefined;
  const base = input !== undefined ? { ...r, input } : r;
  const attempts: Array<[number, number, number]> = [
    [512, 32, 4],
    [160, 16, 3],
    [64, 8, 3],
    [32, 4, 2],
  ];
  // Keys the reading reads come first: when all of them do not fit, the others go.
  const read: Rec = {};
  for (const [key, value] of Object.entries(base)) if (ARG_KEYS[key]) read[key] = value;
  return fit(base, attempts.slice(0, 2)) ?? fit(read, attempts);
}

/** Argument keys the reading reads, in any kind's words, detail or readable view. */
const ARG_KEYS: Record<string, true> = Object.fromEntries(
  (
    "path paths pdf pdfs input command workdir host url targetUrl targetId ref element node nodeId " +
    "id requestId to channelId guildId userId name query pattern messageId action request " +
    "mobileAction confirmed job jobId plan markdown objective status label task agentId ids " +
    "target sessionKey sessionId message channel conversationRef questions prompt text count " +
    "maxResults from lines limit timeoutSeconds pages extractMode maxChars coordinate edits content"
  )
    .split(" ")
    .map((key) => [key, true]),
);

/** The file lines of a patch, which are all the reading takes from it. */
function patchHeads(input: string): string {
  return input
    .split("\n")
    .filter((line) => /^\*\*\* (Add File|Update File|Delete File|Move to): /.test(line))
    .join("\n");
}

/** What the reading needs of a result's `details`, within `MAX_ACTION_FACTS_CHARS`. */
export function projectDetails(details: unknown): Rec | null {
  const d = rec(details);
  if (!d) return null;
  const kept: Rec = {};
  for (const [key, value] of Object.entries(d)) if (DETAIL_KEYS[key]) kept[key] = value;
  // A diff is kept as its counts, which the line shows, and its first lines.
  if (typeof d.diff === "string") {
    kept.diffStat = diffStat(d);
    kept.diff = d.diff.slice(0, 600);
  }
  if (Array.isArray(d.results))
    kept.results = d.results.map((r) => {
      const each = rec(r);
      return each
        ? { title: each.title, url: each.url, path: each.path, snippet: each.snippet }
        : r;
    });
  return fit(kept, [
    [256, 24, 4],
    [96, 12, 3],
    [48, 8, 2],
    [24, 4, 2],
  ]);
}

// The readable view ---------------------------------------------------------------------

/** A label and value row of an opened card. */
export type ReadableRow = { label: string; value: string; mono?: boolean };

/** An opened card's readable view, as data (8.1, "Opened"; 8.6). */
export type Readable = {
  rows: ReadableRow[];
  /** The sentence an outcome short of Done adds. */
  sentence: string | null;
  /** A note the kind adds: why a search was unavailable. */
  note: string | null;
  /** Search results, each a title and an address. */
  links: Array<{ title: string; url: string; host: string }>;
  /** A plan, as a checklist. */
  plan: Array<{ step: string; status: string }>;
  /** Files the action made. */
  files: string[];
  /** The block of text the view shows, with its label; null when there is none. */
  block: { label: string; text: string; error: boolean; live: boolean } | null;
  /** One line when there is nothing to add, so the view is never an empty box. */
  empty: string | null;
  /** The exit code, under a command's output. */
  exitCode: number | null;
};

/** What an opened card shows of one call. */
export function readableOf(given: ActionCall, ctx: ReadingContext = EMPTY_CTX): Readable {
  const call = payloadRead(given, ctx);
  const { kind } = kindOf(call, ctx);
  const o = outcomeOf(call, ctx);
  const open = isOpenOutcome(o.outcome);
  const a = call.args;
  const d = call.details ?? {};
  const rows: ReadableRow[] = [];
  const add = (label: string, value: unknown, mono = false) => {
    if (value === undefined || value === null || value === "") return;
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    rows.push(mono ? { label, value: text, mono: true } : { label, value: text });
  };
  const view: Readable = {
    rows,
    sentence: outcomeSentence(o.outcome),
    note: null,
    links: [],
    plan: [],
    files: [],
    block: null,
    empty: null,
    exitCode: null,
  };
  let label: string = LABELS.result;
  let result = "";
  switch (kind) {
    case "read":
      add(LABELS.file, a.path, true);
      break;
    case "list":
      add(LABELS.folder, a.path, true);
      label = LABELS.entries;
      break;
    case "edit":
    case "memory": {
      const files = filesOf(call);
      files.forEach((f, i) =>
        add(
          i ? " " : files.length > 1 ? LABELS.files : kind === "memory" ? LABELS.note : LABELS.file,
          f,
          true,
        ),
      );
      const stat = diffStat(call.details);
      if (stat) add(LABELS.change, LABELS.changeLines(stat.added, stat.removed));
      if (kind === "memory" && call.name === "write") {
        label = LABELS.saved;
        result = str(a.content);
      } else if (typeof d.diff === "string") {
        label = LABELS.added;
        result = d.diff
          .split("\n")
          .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
          .map((l) => l.slice(1))
          .join("\n");
      }
      break;
    }
    case "recall": {
      if (call.name === "memory_get") add(LABELS.note, a.path, true);
      else add(LABELS.query, a.query);
      const stale = rec(d.staleness)?.warning;
      if (stale) add(LABELS.note, stale);
      if (o.outcome === "unavailable")
        view.note = LABELS.memoryUnavailable(str(d.warning) || str(d.error) || LABELS.noReason);
      label = call.name === "memory_get" ? LABELS.theNote : LABELS.matches;
      if (Array.isArray(d.results))
        result = d.results
          .map((r) => {
            const each = rec(r) ?? {};
            return `${str(each.path)}: ${str(each.snippet)}`;
          })
          .join("\n");
      break;
    }
    case "command":
      add(LABELS.command, a.command ?? a.task, true);
      if (call.name !== "code_execution") add(LABELS.runsOn, str(a.host) || LABELS.gatewayHost);
      add(LABELS.folder, a.workdir ?? a.cwd, true);
      label = LABELS.output;
      if (!open && num(d.exitCode) !== null) view.exitCode = num(d.exitCode);
      break;
    case "terminal":
      add(LABELS.action, a.action);
      add(LABELS.terminal, a.sessionId);
      break;
    case "web":
    case "xsearch":
      add(LABELS.query, a.query);
      if (o.outcome === "unavailable") view.note = str(d.message) || str(d.error) || null;
      if (Array.isArray(d.results) && !open)
        view.links = d.results.flatMap((r) => {
          const each = rec(r);
          const url = str(each?.url);
          return each && url ? [{ title: str(each.title) || url, url, host: hostOf(url) }] : [];
        });
      break;
    case "page":
      add(LABELS.address, a.url, true);
      add(LABELS.title, unwrapExternal(d.title));
      add(LABELS.status, d.status);
      label = LABELS.text;
      break;
    case "browser":
    case "computer":
    case "phone": {
      const r = rec(a.request) ?? {};
      const m = rec(a.mobileAction) ?? {};
      add(LABELS.action, [a.action, r.kind, m.type].filter(Boolean).map(str).join(", "));
      add(
        LABELS.target,
        str(a.targetUrl) ||
          str(r.element) ||
          str(r.text) ||
          (Array.isArray(a.coordinate) ? a.coordinate.map(str).join(", ") : ""),
      );
      add(
        LABELS.typed,
        r.kind === "type"
          ? r.text
          : a.action === "type"
            ? a.text
            : m.type === "set_text"
              ? m.text
              : "",
      );
      const effect = str(rec(d.result)?.effect);
      if (effect) add(LABELS.effect, LABELS.effects[effect] ?? effect);
      if (d.code === "confirmation_required")
        add(
          LABELS.needsConfirmation,
          [str(d.proposedEffect), [str(d.target), str(d.package)].filter(Boolean).join(", ")]
            .filter(Boolean)
            .join(" · "),
        );
      const oc = rec(d.outcome);
      if (oc?.code)
        add(LABELS.deviceSaid, `${str(oc.code)}${oc.message ? `: ${str(oc.message)}` : ""}`);
      break;
    }
    case "screen":
      add(LABELS.action, a.action);
      break;
    case "routine": {
      const job = rec(a.job) ?? {};
      const schedule = rec(job.schedule);
      add(LABELS.routine, str(job.name) || str(a.name));
      if (schedule)
        add(
          LABELS.schedule,
          `${scheduleWords(schedule)} (${str(schedule.kind)}${schedule.expr ? ` ${str(schedule.expr)}` : ""})`,
        );
      add(LABELS.does, rec(job.payload)?.message);
      break;
    }
    case "plan":
      if (Array.isArray(a.plan)) {
        view.plan = a.plan.flatMap((s) => {
          const each = rec(s);
          return each ? [{ step: str(each.step), status: str(each.status) }] : [];
        });
        break;
      }
      add(LABELS.objective, a.objective);
      add(LABELS.status, a.status);
      add(LABELS.gatewaySaid, d.error);
      add(LABELS.next, d.nextAction);
      break;
    case "media":
    case "look":
      add(LABELS.prompt, a.prompt ?? a.text);
      add(LABELS.pages, a.pages);
      filesOf(call).forEach((f, i) => add(i ? " " : LABELS.input, f, true));
      if (o.outcome === "done")
        view.files = [...list(d.paths).map(str), ...(d.audioPath ? [str(d.audioPath)] : [])];
      break;
    case "question": {
      const first = rec(list(a.questions)[0]);
      add(LABELS.question, first?.question);
      break;
    }
    case "channel":
      add(LABELS.channel, str(d.channel) || str(a.channel));
      add(LABELS.to, str(a.to) || str(a.target));
      add(LABELS.status, d.status);
      add(LABELS.text, a.message);
      break;
    case "server": {
      const id = toolServerOf(call, ctx)!;
      add(LABELS.server, id.server);
      add(LABELS.tool, nameWords(id.tool));
      for (const [k, value] of Object.entries(a)) add(k, value, typeof value !== "string");
      break;
    }
    default:
      for (const [k, value] of Object.entries(a)) add(k, value, typeof value !== "string");
      // The gateway's own English title for the call, shown as sent (8.3, point 5).
      if (kind === "tool") add(LABELS.gatewayCallsIt, call.gatewayTitle);
  }
  const text = result || (open ? (call.partial ?? "") : (call.text ?? ""));
  if (text) {
    view.block = {
      label: open ? LABELS.outputSoFar : call.isError ? LABELS.error : label,
      text,
      error: call.isError && !open,
      live: open,
    };
  } else if (open) {
    view.empty = kindOf(call, ctx).leaves ? LABELS.nothingUntilReturn : LABELS.noOutputYet;
  } else if (!view.links.length && !view.plan.length && !view.files.length) {
    view.empty = LABELS.noResult;
  }
  return view;
}
