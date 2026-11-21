// The scenario check: drives every scenario of the scripted model through a
// development gateway instance with the official gateway client, and asserts
// what the gateway emitted. Payloads are checked against the schemas in
// `@openclaw/gateway-protocol` where the protocol defines one (chat, agent,
// question and session approval events); the exec approval event, which has
// no published schema, is checked field by field against the gateway source.
//
// Each check uses a client with only the scopes its scenario needs:
//   plain       operator.read, operator.write                      caps tool-events
//   approvals   + operator.approvals                                caps tool-events, approvals, exec-approvals
//   questions   + operator.questions                                caps tool-events
//
// What the check found that the capability map does not say is recorded in
// docs/decisions.md, "What the scenario check observed".

import {
  AgentEventSchema,
  ChatEventSchema,
  QuestionRequestedEventSchema,
  QuestionResolvedEventSchema,
  SessionApprovalEventSchema,
} from "@openclaw/gateway-protocol/schema";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import {
  CODING_AGENT_SERVER,
  SEND_MESSAGE_TEXT,
  THREAD_URL_BASE,
  TOOLS as CODING_AGENT_TOOLS,
} from "./coding-agent-mcp.ts";
import { TERMINAL_CHAT_STATES, type GatewayEvent, type OperatorSession } from "./operator.ts";
import {
  resolveRound,
  scenarioRounds,
  LARGE_LOG_BYTES,
  LARGE_LOG_PATH,
  largeLogParts,
  SCENARIOS,
  selectScenarios,
  SHELL_COMMANDS,
  type PlanContext,
} from "./scenarios.ts";
import { MESSAGING_PAIR, SHELL_BOT } from "./seed-data.ts";
import { FILES_BOT, PICTURE_PATH, trailMap } from "./seed-files.ts";
import { DENIED_TOOLS, GATEWAY_TOOLS } from "./cli.ts";
import { OFFERED_TOOLS_PATH, QUIET_TURNS_PATH } from "./fake-provider.ts";
import { COMPUTER_CHECKS } from "./computer-checks.ts";
import { IMAGE_CHECKS } from "./image-checks.ts";
import { RULES_CHECKS } from "./rules-checks.ts";

type JsonRecord = Record<string, unknown>;
const rec = (value: unknown): JsonRecord =>
  value !== null && typeof value === "object" ? (value as JsonRecord) : {};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type ClientName = "plain" | "approvals" | "questions";

export const CLIENTS: Record<ClientName, { scopes: string[]; caps: string[] }> = {
  plain: { scopes: ["operator.read", "operator.write"], caps: ["tool-events"] },
  approvals: {
    scopes: ["operator.read", "operator.write", "operator.approvals"],
    caps: ["tool-events", "approvals", "exec-approvals"],
  },
  questions: {
    scopes: ["operator.read", "operator.write", "operator.questions"],
    caps: ["tool-events"],
  },
};

export class CheckFailure extends Error {}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CheckFailure(message);
}

/** JSON with object keys in sorted order, so equal values compare equal whatever their key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as JsonRecord).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );
}

function same(actual: unknown, expected: unknown, what: string): void {
  expect(
    canonical(actual) === canonical(expected),
    `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

/** Everything one run emitted on one connection, with helpers to read it. */
export class RunView {
  readonly op: OperatorSession;
  readonly runId: string;
  readonly sessionKey: string;
  readonly from: number;

  constructor(op: OperatorSession, runId: string, sessionKey: string, from: number) {
    this.op = op;
    this.runId = runId;
    this.sessionKey = sessionKey;
    this.from = from;
    track(this);
  }

  /**
   * Assert every tool call of the run, in order: its name and exact
   * arguments, its result's error flag, content and details, and its item's
   * kind, title and end status. A run whose calls this was never called for
   * fails the check (see `unaccountedRuns`); a run with no calls asserts [].
   */
  expectCalls(expected: CallExpectation[]): void {
    const starts = this.tool("start");
    const items = this.agent("item").filter((e) => this.data(e).kind === "tool");
    same(
      starts.map((e) => this.data(e).name),
      expected.map((c) => c.name),
      `the tool calls of run ${this.runId}`,
    );
    same(
      items.filter((e) => this.data(e).phase === "start").length,
      expected.length,
      `tool items of run ${this.runId}`,
    );
    for (const [i, call] of expected.entries()) {
      const where = `call ${i + 1} (${call.name})`;
      const start = starts[i]!;
      const id = this.data(start).toolCallId;
      same(this.data(start).args, call.args, `${where} arguments`);
      const end = this.tool("result").find((e) => this.data(e).toolCallId === id);
      expect(end, `${where} has no result`);
      same(this.data(end).isError, call.isError, `${where} isError`);
      const result = rec(this.data(end).result);
      const blocks = Array.isArray(result.content) ? (result.content as JsonRecord[]) : [];
      same(
        blocks.map((b) => b.type),
        blocks.map(() => "text"),
        `${where} content block types`,
      );
      const details = Object.hasOwn(result, "details") ? result.details : undefined;
      if (typeof call.details === "function") {
        (call.details as (d: JsonRecord | undefined, w: string) => void)(
          details as JsonRecord | undefined,
          where,
        );
      } else same(details, call.details, `${where} details`);
      const texts = blocks.map((b) => String(b.text ?? ""));
      if (typeof call.content === "function") call.content(texts, where);
      else same(texts, call.content, `${where} content`);
      const itemStart = items.find(
        (e) => this.data(e).toolCallId === id && this.data(e).phase === "start",
      );
      const itemEnd = items.find(
        (e) => this.data(e).toolCallId === id && this.data(e).phase === "end",
      );
      expect(itemStart && itemEnd, `${where} item start and end`);
      // Every item event of the call, start, updates and end, names the call
      // and its action; the end also says how it went.
      const callItems = items.filter((e) => this.data(e).toolCallId === id);
      same(
        callItems.map((e) => [this.data(e).phase, this.data(e).name, this.data(e).title]),
        callItems.map((e) => [this.data(e).phase, call.name, call.title]),
        `${where} item names and titles`,
      );
      same(
        this.data(itemEnd).status,
        call.status ?? (call.isError ? "failed" : "completed"),
        `${where} item end status`,
      );
    }
    TRACKED.get(this.runId)!.calls = true;
  }

  /** Assert how the run ended: its terminal chat state and, unless null, its final text. */
  expectEnd(state: string, text: string | null): void {
    same(this.terminal.state, state, `the end of run ${this.runId}`);
    if (text !== null) same(this.finalText(), text, `the final text of run ${this.runId}`);
    TRACKED.get(this.runId)!.end = true;
  }

  get events(): GatewayEvent[] {
    return this.op.events.filter(
      (e) =>
        e.seq > this.from &&
        rec(e.payload).runId === this.runId &&
        (e.event === "agent" || e.event === "chat"),
    );
  }

  /** The run's tool payloads that reached this client as `session.tool` (sessions.subscribe). */
  sessionTool(phase?: string, name?: string): GatewayEvent[] {
    return this.op.events.filter(
      (e) =>
        e.seq > this.from &&
        e.event === "session.tool" &&
        rec(e.payload).runId === this.runId &&
        (!phase || this.data(e).phase === phase) &&
        (!name || this.data(e).name === name),
    );
  }

  agent(stream?: string): GatewayEvent[] {
    return this.events.filter(
      (e) => e.event === "agent" && (!stream || rec(e.payload).stream === stream),
    );
  }

  data(e: GatewayEvent): JsonRecord {
    return rec(rec(e.payload).data);
  }

  lifecycle(phase: string): GatewayEvent[] {
    return this.agent("lifecycle").filter((e) => this.data(e).phase === phase);
  }

  /** Tool payloads of the run, from `agent` tool events or, for a run another client started, `session.tool`. */
  tool(phase: string, name?: string): GatewayEvent[] {
    const own = this.agent("tool").filter(
      (e) => this.data(e).phase === phase && (!name || this.data(e).name === name),
    );
    return own.length > 0 ? own : this.sessionTool(phase, name);
  }

  get terminal(): JsonRecord {
    const end = this.events.find(
      (e) => e.event === "chat" && TERMINAL_CHAT_STATES.includes(String(rec(e.payload).state)),
    );
    return rec(end?.payload);
  }

  /** The tool result's `result` object, for the first result of the tool. */
  result(name: string): {
    isError: unknown;
    content: JsonRecord[];
    details: JsonRecord;
    text: string;
  } {
    const found = this.tool("result", name)[0];
    expect(found, `no tool result for ${name} in run ${this.runId}`);
    const data = this.data(found);
    const result = rec(data.result);
    const content = Array.isArray(result.content) ? (result.content as JsonRecord[]) : [];
    return {
      isError: data.isError,
      content,
      details: rec(result.details),
      text: content.map((part) => String(part.text ?? "")).join(""),
    };
  }

  finalText(): string {
    const message = rec(this.terminal.message);
    const content = Array.isArray(message.content) ? (message.content as JsonRecord[]) : [];
    return content.map((part) => String(part.text ?? "")).join("");
  }

  /** The order of first appearance of each labelled event; fails if any is missing or out of order. */
  inOrder(steps: [string, (e: GatewayEvent) => boolean][]): void {
    let after = -1;
    for (const [label, match] of steps) {
      const found = this.events.find((e) => e.seq > after && match(e));
      expect(found, `expected ${label} after seq ${after} in run ${this.runId}`);
      after = found.seq;
    }
  }

  /**
   * Every chat and agent event of the run matches the protocol schema, but one:
   * for a turn it ran from its queue the gateway sends an `agent` event on
   * stream `error` with `data.reason: "seq gap"` and no `seq`, its own note of
   * a gap in the run's numbering. The schema requires `seq`. It is set aside,
   * and counted in `SEQ_GAP_NOTES`, only for a run this client saw the gateway
   * pair with an id of its own in this run's own session, since this view
   * began (`sessions.changed` for that session naming the run as `clientRunId`
   * beside another `runId`), and only when the note itself is that session's,
   * under the run or its paired id; for any other frame it fails.
   */
  validate(): void {
    const paired = new Set(
      this.op.events
        .filter((e) => {
          const p = rec(e.payload);
          return (
            e.seq > this.from &&
            e.event === "sessions.changed" &&
            p.sessionKey === this.sessionKey &&
            p.clientRunId === this.runId &&
            typeof p.runId === "string" &&
            p.runId !== this.runId
          );
        })
        .map((e) => String(rec(e.payload).runId)),
    );
    for (const e of this.events) {
      const p = rec(e.payload);
      if (
        paired.size > 0 &&
        p.sessionKey === this.sessionKey &&
        (p.runId === this.runId || paired.has(String(p.runId))) &&
        e.event === "agent" &&
        p.stream === "error" &&
        p.seq === undefined &&
        rec(p.data).reason === "seq gap"
      ) {
        SEQ_GAP_NOTES.add(this.runId);
        continue;
      }
      const kind =
        e.event === "chat"
          ? `chat ${String(rec(e.payload).state)}`
          : `agent ${String(rec(e.payload).stream)}`;
      checkShape(e.event === "chat" ? ChatEventSchema : AgentEventSchema, e.payload, kind);
    }
  }
}

type Schema = TSchema;

/** One expected tool call; see RunView.expectCalls. */
export type CallExpectation = {
  name: string;
  args: unknown;
  isError: boolean;
  /** The result's text blocks exactly, or a check of them. */
  content: string[] | ((texts: string[], where: string) => void);
  /** The result's details exactly (undefined: none), or a check of them. */
  details: unknown;
  /** The item's title. */
  title: string;
  /** The item's end status; completed, or failed for an error. */
  status?: string;
};

/** The reply text a run's `agent` assistant events have shown so far: the longest whole text, or the deltas joined. */
function streamedText(view: RunView): string {
  const events = view.agent("assistant").map((e) => view.data(e));
  const whole = events
    .map((data) => (typeof data.text === "string" ? data.text : ""))
    .reduce((longest, text) => (text.length > longest.length ? text : longest), "");
  const deltas = events.map((data) => (typeof data.delta === "string" ? data.delta : "")).join("");
  return whole.length >= deltas.length ? whole : deltas;
}

/** Runs for which the gateway sent its "seq gap" error event (see RunView.validate). */
export const SEQ_GAP_NOTES = new Set<string>();

/** Every run a check started or watched, and whether its calls and its end were asserted. */
const TRACKED = new Map<string, { calls: boolean; end: boolean; sessionKey: string }>();

function track(view: RunView): void {
  if (view.runId && !TRACKED.has(view.runId)) {
    TRACKED.set(view.runId, { calls: false, end: false, sessionKey: view.sessionKey });
  }
}

/** Runs of the check just finished whose calls or end were never asserted. */
export function unaccountedRuns(): string[] {
  return [...TRACKED.entries()].flatMap(([runId, t]) => [
    ...(t.calls ? [] : [`the tool calls of run ${runId} (${t.sessionKey}) were not asserted`]),
    ...(t.end ? [] : [`the end of run ${runId} (${t.sessionKey}) was not asserted`]),
  ]);
}

/**
 * Every task the running check submitted to or opened, recorded before the
 * request goes out, so a failed check is drained even where no event of its
 * run has arrived yet.
 */
const LEDGER = new Set<string>();

/** Work a failed check left that draining could not stop: the next check does not start on it. */
let leftBusy: { keys: string[]; reason: string } | null = null;

/** The tasks bots message each other in: a failed check's recipient runs may still go on there. */
const SHARED_SESSIONS = MESSAGING_PAIR.map((botId) => `agent:${botId}:main`);

/**
 * Run one check: it fails if it fails, or if any run that appeared on any
 * client while it ran was left with its calls or its end unasserted, whether
 * or not the check made a view of it. On any failure the tasks it used (its
 * ledger, every task that had a run event during it, and the bots' shared main
 * tasks) are drained: their runs stopped and the gateway idle there. If that
 * cannot be established, the next check fails at its start, saying so, rather
 * than run on a busy instance.
 */
export async function runCheck(
  h: Harness,
  check: ScenarioCheck,
  options: { drainTimeoutMs?: number; drainSettleMs?: number } = {},
): Promise<void> {
  if (leftBusy) {
    const busy = leftBusy;
    leftBusy = null;
    if (!(await drain(h, busy.keys, options.drainTimeoutMs, options.drainSettleMs))) {
      leftBusy = busy;
      throw new CheckFailure(`not started: ${busy.reason}`);
    }
  }
  TRACKED.clear();
  LEDGER.clear();
  const clients = (["plain", "approvals", "questions"] as const).map((name) => h.op(name));
  const before = clients.map((op) => op.lastSeq);
  try {
    await check.run(h);
    await sleep(300);
    for (const [i, op] of clients.entries()) {
      for (const e of op.events) {
        const p = rec(e.payload);
        if (e.seq <= before[i]! || typeof p.runId !== "string") continue;
        if (e.event !== "agent" && e.event !== "chat" && e.event !== "session.tool") continue;
        if (!TRACKED.has(p.runId)) {
          TRACKED.set(p.runId, { calls: false, end: false, sessionKey: String(p.sessionKey) });
        }
      }
    }
    const left = unaccountedRuns();
    if (left.length > 0) throw new CheckFailure(left.join("; "));
  } catch (error) {
    const keys = [
      ...new Set([...LEDGER, ...sessionsWithRuns(clients, before), ...SHARED_SESSIONS]),
    ];
    if (!(await drain(h, keys, options.drainTimeoutMs, options.drainSettleMs))) {
      leftBusy = {
        keys,
        reason: `the check before it ("${check.name}") failed and the gateway still had work in ${keys.join(", ")}`,
      };
    }
    throw error;
  }
}

/** The tasks that had any run event on the check's clients since `before`. */
function sessionsWithRuns(clients: OperatorSession[], before: number[]): Set<string> {
  const keys = new Set<string>();
  for (const [i, op] of clients.entries()) {
    for (const e of op.events) {
      const p = rec(e.payload);
      if (e.seq > before[i]! && typeof p.runId === "string" && typeof p.sessionKey === "string")
        keys.add(p.sessionKey);
    }
  }
  return keys;
}

/** How long a drained check's tasks must stay idle, sampled throughout, before the next check. */
export const DRAIN_SETTLE_MS = 1_500;
const DRAIN_SAMPLE_MS = 200;

/**
 * Stop whatever runs in these tasks and wait until the gateway has had nothing
 * in flight or waiting in any of them for `settleMs` without a break, sampled
 * every `DRAIN_SAMPLE_MS`: a send admitted after a first idle sample (its
 * request failed here, the gateway took it later) is seen, stopped, and the
 * quiet period starts again. Whether it got there: false when a task was still
 * busy at the deadline.
 */
export async function drain(
  h: Harness,
  keys: Iterable<string>,
  timeoutMs = 60_000,
  settleMs = DRAIN_SETTLE_MS,
): Promise<boolean> {
  return drainSessions(h.op("plain"), keys, timeoutMs, settleMs);
}

/** `drain` through one operator: the computer checks drain their tasks with it too. */
export async function drainSessions(
  op: OperatorSession,
  keys: Iterable<string>,
  timeoutMs = 60_000,
  settleMs = DRAIN_SETTLE_MS,
): Promise<boolean> {
  const all = [...keys];
  const deadline = Date.now() + timeoutMs;
  for (const key of all) await op.request("chat.abort", { sessionKey: key }).catch(() => {});
  let quietSince: number | null = null;
  for (;;) {
    let busy = false;
    for (const key of all) {
      const history = await op
        .request<{ inFlightRun?: unknown; pendingInputs?: { items?: unknown[] } }>("chat.history", {
          sessionKey: key,
          limit: 1,
        })
        .catch(() => null);
      const clear =
        history !== null &&
        !history.inFlightRun &&
        (history.pendingInputs?.items ?? []).length === 0;
      if (!clear) {
        busy = true;
        await op.request("chat.abort", { sessionKey: key }).catch(() => {});
      }
    }
    const now = Date.now();
    if (busy) quietSince = null;
    else quietSince ??= now;
    if (quietSince !== null && now - quietSince >= settleMs) return true;
    if (now >= deadline) return false;
    await sleep(DRAIN_SAMPLE_MS);
  }
}

/**
 * Top-level fields the gateway sent that the published schema does not
 * declare, by event kind. The published event schemas are closed, so these
 * are reported rather than failed: see "What the scenario check observed".
 */
export const UNDECLARED_FIELDS = new Map<string, Set<string>>();

/**
 * Check a payload against a published schema. Fields the schema does not
 * declare at the top level are noted and set aside; everything it declares
 * must match.
 */
export function checkShape(schema: Schema, payload: unknown, kind: string): void {
  const value = rec(payload);
  const variants = ((schema as { anyOf?: Schema[] }).anyOf ?? [schema]) as {
    properties?: Record<string, unknown>;
  }[];
  const matching =
    variants.find((variant) => {
      const state =
        rec(rec(variant.properties).state).const ?? rec(rec(variant.properties).status).const;
      return state === undefined || state === value.state || state === value.status;
    }) ?? variants[0]!;
  const declared = new Set(Object.keys(matching.properties ?? {}));
  const extra = Object.keys(value).filter((key) => !declared.has(key));
  if (extra.length > 0) {
    const seen = UNDECLARED_FIELDS.get(kind) ?? new Set<string>();
    for (const key of extra) seen.add(key);
    UNDECLARED_FIELDS.set(kind, seen);
  }
  const declaredOnly = Object.fromEntries(
    Object.entries(value).filter(([key]) => declared.has(key)),
  );
  expect(
    Value.Check(schema, declaredOnly),
    `${kind} does not match the protocol schema: ${firstError(schema, declaredOnly)}`,
  );
}

function firstError(schema: Schema, value: unknown): string {
  for (const error of Value.Errors(schema, value)) {
    const e = error as { instancePath?: string; path?: string; message?: string };
    return `${e.instancePath ?? e.path ?? ""} ${e.message ?? ""}`.trim();
  }
  return "unknown";
}

const isAgent = (stream: string, phase?: string) => (e: GatewayEvent) =>
  e.event === "agent" &&
  rec(e.payload).stream === stream &&
  (phase === undefined || rec(rec(e.payload).data).phase === phase);
const isTool = (phase: string, name: string) => (e: GatewayEvent) =>
  isAgent("tool", phase)(e) && rec(rec(e.payload).data).name === name;
const isChat = (state: string) => (e: GatewayEvent) =>
  e.event === "chat" && rec(e.payload).state === state;

export type Harness = {
  op(client: ClientName): OperatorSession;
  /** A new session key for a bot, subscribed on every client. */
  session(botId: string, tag: string): Promise<string>;
  /** Send and return the run, without waiting for it. */
  start(client: ClientName, key: string, message: string, extra?: JsonRecord): Promise<RunView>;
  /** Send, wait for the run to end, and validate its events. */
  run(client: ClientName, key: string, message: string, extra?: JsonRecord): Promise<RunView>;
  wait(view: RunView, timeoutMs?: number): Promise<RunView>;
  /** Note an observation for the report. */
  observe(line: string): void;
  /**
   * Run a message as the gateway's owner, through `openclaw agent`, and
   * return the run as the plain client saw it. Owner-only tools such as
   * `automations` are offered only in such runs.
   */
  ownerRun(botId: string, key: string, message: string): Promise<RunView>;
  /** The tool names the scripted model received in the session's latest request. */
  offeredTools(key: string): Promise<string[] | null>;
  /**
   * The turns the gateway started itself in the session that the scripted
   * model answered quietly: for each, the gateway prompt it recognized.
   */
  quietTurns(key: string): Promise<string[]>;
};

/** What one kind of tool call looks like on the wire, for "What the scenario check observed". */
export type FamilyRow = {
  family: string;
  directive: string;
  tool: string;
  args: string;
  result: string;
  historyDetails: boolean;
  kindHints: string;
};

export const FAMILY_ROWS: FamilyRow[] = [];

/** A compact type shape of a JSON value, two levels deep. */
export function shapeOf(value: unknown, depth = 2): string {
  if (Array.isArray(value)) return value.length === 0 ? "[]" : `[${shapeOf(value[0], depth - 1)}…]`;
  if (value !== null && typeof value === "object") {
    if (depth <= 0) return "{…}";
    const entries = Object.entries(value as JsonRecord).map(
      ([k, v]) => `${k}: ${shapeOf(v, depth - 1)}`,
    );
    return `{${entries.join(", ")}}`;
  }
  return value === null ? "null" : typeof value;
}

/** What a family's first call must look like on the wire. */
export type FamilyExpectation = {
  args: unknown;
  title: string;
  /** shapeOf(args), as documented in docs/decisions.md. */
  argsShape: string;
  /** "content <types>; details <shapeOf(details, 1)>", as documented. */
  resultShape: string;
  historyDetails: boolean;
};

/**
 * Assert the first call of a tool in a run against its expectation, and
 * record it for the documented table: the exact arguments, the item's kind,
 * title and completion, the result's shape and whether history keeps its
 * details. A client that did not start the run gets the payloads through
 * `session.tool`.
 */
async function recordFamily(
  h: Harness,
  family: string,
  directive: string,
  view: RunView,
  tool: string,
  expected: FamilyExpectation,
): Promise<void> {
  const start = view.tool("start", tool)[0];
  const end = view.tool("result", tool)[0];
  expect(start && end, `no ${tool} call with its result for ${family}`);
  same(view.data(start).args, expected.args, `${tool} arguments`);
  const toolCallId = view.data(start).toolCallId;
  const items = view.agent("item").filter((e) => view.data(e).toolCallId === toolCallId);
  const itemStart = items.find((e) => view.data(e).phase === "start");
  const itemEnd = items.find((e) => view.data(e).phase === "end");
  expect(itemStart && itemEnd, `${tool} item start and end`);
  same(
    [view.data(itemStart).kind, view.data(itemStart).title, view.data(itemEnd).status],
    ["tool", expected.title, "completed"],
    `${tool} item kind, title and status`,
  );
  const data = view.data(end);
  same(data.isError, false, `${tool} isError`);
  const result = rec(data.result);
  const content = Array.isArray(result.content) ? (result.content as JsonRecord[]) : [];
  const details = rec(result.details);
  const argsShape = shapeOf(view.data(start).args);
  const resultShape = `content ${content.map((p) => String(p.type)).join("+") || "none"}; details ${shapeOf(details, 1)}`;
  same(argsShape, expected.argsShape, `${tool} argument shape`);
  same(resultShape, expected.resultShape, `${tool} result shape`);
  const history = await h
    .op("plain")
    .request<{ messages: JsonRecord[] }>("chat.history", { sessionKey: view.sessionKey });
  const row = history.messages.find((m) => m.role === "toolResult" && m.toolCallId === toolCallId);
  expect(row, `${tool} result in history`);
  same(row.details !== undefined, expected.historyDetails, `${tool} history keeps details`);
  const hints = [
    `item.kind "tool"`,
    `item.title "${expected.title}"`,
    ...(data.commandBearing === true ? ["commandBearing true"] : []),
    ...(typeof details.mcpServer === "string"
      ? [`details.mcpServer "${details.mcpServer}", mcpTool "${String(details.mcpTool)}"`]
      : []),
  ];
  FAMILY_ROWS.push({
    family,
    directive,
    tool,
    args: argsShape,
    result: resultShape,
    historyDetails: expected.historyDetails,
    kindHints: hints.join("; "),
  });
}

/** A file in a bot's workspace, as the gateway reads it (`agents.workspace.get`). */
async function workspaceFile(h: Harness, agentId: string, path: string): Promise<string> {
  const out = await h
    .op("plain")
    .request<{ file?: { content?: unknown } }>("agents.workspace.get", { agentId, path });
  expect(typeof out.file?.content === "string", `${agentId}:${path} could not be read back`);
  return out.file.content;
}

/** A bot's workspace listing as `ls` prints it: one visible entry per line, in name order. */
async function listing(h: Harness, agentId: string): Promise<string> {
  const out = await h
    .op("plain")
    .request<{ entries: { name: string; kind: string }[] }>("agents.workspace.list", { agentId });
  return out.entries
    .filter((e) => !e.name.startsWith("."))
    .map((e) => e.name)
    .sort()
    .join("\n");
}

/** An object with its keys in sorted order, as the gateway renders structured content. */
function sortedKeys(value: JsonRecord): JsonRecord {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

/** The tool calls a directive's scenario makes, as the scripted model builds them. */
export function scriptedCalls(directive: string, agentId = "main") {
  const ctx: PlanContext = { agentId, sessionKey: null, results: [] };
  return scenarioRounds(selectScenarios(directive)).flatMap((round) =>
    resolveRound(round, ctx, "check").flatMap((step) =>
      step.kind === "tool" ? [{ name: step.name, arguments: step.arguments }] : [],
    ),
  );
}

/** The arguments of a directive's first call of a tool. */
export function scriptedArgs(directive: string, tool: string, agentId = "main"): unknown {
  const call = scriptedCalls(directive, agentId).find((c) => c.name === tool);
  expect(call, `${directive} makes no ${tool} call`);
  return call.arguments;
}

// ---------------------------------------------------------------------------
// Expected calls. Each builder gives one call's exact expectation; a field
// that varies from run to run (a duration, a run id, the home folder) is a
// check of its own instead of a value.

type Check = (value: unknown, where: string) => void;
const isNumberAtLeast =
  (min: number): Check =>
  (value, where) =>
    expect(
      typeof value === "number" && value >= min,
      `${where} must be a number of at least ${min}, found ${JSON.stringify(value)}`,
    );
const matchesPattern =
  (pattern: RegExp): Check =>
  (value, where) =>
    expect(
      typeof value === "string" && pattern.test(value),
      `${where} must match ${String(pattern)}, found ${JSON.stringify(value)}`,
    );
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Details with exactly these keys; a function value checks that key's value. */
function detailsLike(expected: Record<string, unknown>) {
  return (details: JsonRecord | undefined, where: string) => {
    expect(details !== undefined, `${where} has no details`);
    same(Object.keys(details!).sort(), Object.keys(expected).sort(), `${where} details keys`);
    for (const [key, value] of Object.entries(expected)) {
      if (typeof value === "function") (value as Check)(details![key], `${where} details.${key}`);
      else same(details![key], value, `${where} details.${key}`);
    }
  };
}

/** Text blocks exactly as given; a function checks that block. */
function textsLike(expected: (string | Check)[]) {
  return (texts: string[], where: string) => {
    same(texts.length, expected.length, `${where} content blocks`);
    for (const [i, value] of expected.entries()) {
      if (typeof value === "function") value(texts[i], `${where} content[${i}]`);
      else same(texts[i], value, `${where} content[${i}]`);
    }
  };
}

/** A tool result whose text is its details as indented JSON. */
const jsonText =
  (where: string, details: () => unknown): Check =>
  (value) =>
    same(value, JSON.stringify(details(), null, 2), `${where} text is its details as JSON`);

async function fileCall(
  h: Harness,
  agentId: string,
  path: string,
  offset?: number,
): Promise<CallExpectation> {
  const file = await workspaceFile(h, agentId, path);
  const text = offset
    ? file
        .split("\n")
        .slice(offset - 1)
        .join("\n")
    : file;
  return {
    name: "read",
    args: offset ? { path, offset } : { path },
    isError: false,
    content: [text],
    details: { kind: "text", content: text },
    title: offset ? `Read from line ${offset} in ${path}` : `Read from ${path}`,
  };
}

/** `ls` as the bot sees its workspace: every entry quoted, folders with a slash, in name order. */
async function lsCall(h: Harness, agentId: string): Promise<CallExpectation> {
  const out = await h
    .op("plain")
    .request<{ entries: { name: string; kind: string }[] }>("agents.workspace.list", { agentId });
  const text = out.entries
    .map((e) => (e.kind === "directory" ? `${e.name}/` : e.name))
    .sort()
    .map((name) => JSON.stringify(name))
    .join("\n");
  return {
    name: "ls",
    args: { path: "." },
    isError: false,
    content: [text],
    details: { content: text },
    title: "Ls .",
  };
}

/** A write or edit of a workspace file: the absolute path is the only varying part. */
function fileChangeCall(
  name: "write" | "edit",
  args: { path: string; content?: string; edits?: unknown },
  text: string,
  change: { created?: boolean; diff: string; hunk: string },
  title: string,
): CallExpectation {
  const tail = `/workspace/${args.path}`;
  return {
    name,
    args,
    isError: false,
    content: textsLike([
      matchesPattern(new RegExp(`^${escapeRe(text).replace("<path>", `\\S+${escapeRe(tail)}`)}$`)),
    ]),
    details: detailsLike({
      changed: true,
      ...(change.created === undefined ? {} : { created: change.created }),
      diff: change.diff,
      firstChangedLine: 1,
      patch: matchesPattern(
        new RegExp(`^--- (\\S+${escapeRe(tail)})\\n\\+\\+\\+ \\1\\n${escapeRe(change.hunk)}$`),
      ),
    }),
    title,
  };
}

/** An exec of one of the shell bot's commands, with the parts of its details that vary checked. */
function execCall(
  args: Record<string, unknown>,
  result: {
    isError: boolean;
    content: (string | Check)[];
    details: Record<string, unknown>;
    title: string;
    status?: string;
  },
): CallExpectation {
  return {
    name: "exec",
    args,
    isError: result.isError,
    content: textsLike(result.content),
    details: detailsLike({ ...result.details, cwd: matchesPattern(/\/workspaces\/otto$/) }),
    title: result.title,
    ...(result.status ? { status: result.status } : {}),
  };
}

function askCall(
  directive: string,
  agentId: string,
  answers: Record<string, string[]>,
): CallExpectation {
  const args = scriptedArgs(directive, "ask_user", agentId) as {
    questions: { id: string; header: string; question: string }[];
  };
  const details = { status: "answered", answers: { answers } };
  const lines = args.questions.map((q) => `${q.header}: ${(answers[q.id] ?? []).join(", ")}`);
  return {
    name: "ask_user",
    args,
    isError: false,
    content: [`${lines.join("\n")}\n\n${JSON.stringify(details, null, 2)}`],
    details,
    title: `Ask User ${args.questions[0]!.question}`,
  };
}

/** A sessions_send result: indented JSON of its details, whose run id varies. */
function sendCall(
  directive: string,
  sender: string,
  details: Record<string, unknown>,
  isError: boolean,
  title: string,
): CallExpectation {
  let seen: JsonRecord | undefined;
  return {
    name: "sessions_send",
    args: scriptedArgs(directive, "sessions_send", sender),
    isError,
    details: (d: JsonRecord | undefined, where: string) => {
      seen = d;
      detailsLike({ runId: matchesPattern(UUID), ...details })(d, where);
    },
    content: (texts: string[], where: string) =>
      textsLike([jsonText(where, () => seen)])(texts, where),
    title,
  };
}

/** A call to the stand-in coding agent's send_message: its rendering, then its own text. */
function sendMessageCall(directive: string, message: string): CallExpectation {
  const name = `${CODING_AGENT_SERVER}__send_message`;
  let structured: JsonRecord = {};
  return {
    name,
    args: scriptedArgs(directive, name),
    isError: false,
    details: (d: JsonRecord | undefined, where: string) => {
      structured = rec(rec(d).structuredContent);
      const thread = String(structured.threadId);
      expect(/^thread-\d+$/.test(thread), `${where} thread id ${thread}`);
      same(
        d,
        {
          mcpServer: CODING_AGENT_SERVER,
          mcpTool: "send_message",
          structuredContent: {
            threadId: thread,
            reply: `Opened a branch and drafted the change for: ${message}`,
            url: `${THREAD_URL_BASE}${thread}`,
          },
        },
        `${where} details`,
      );
    },
    content: (texts: string[], where: string) =>
      same(
        texts,
        [
          `structuredContent:\n${JSON.stringify(sortedKeys(structured), null, 2)}`,
          SEND_MESSAGE_TEXT,
        ],
        `${where} content`,
      ),
    title: "Coder Send Message",
  };
}

const slowTaskCall = (seconds: number): CallExpectation => ({
  name: `${CODING_AGENT_SERVER}__slow_task`,
  args: { seconds },
  isError: false,
  content: [`structuredContent:\n${JSON.stringify({ seconds, status: "done" }, null, 2)}`],
  details: {
    mcpServer: CODING_AGENT_SERVER,
    mcpTool: "slow_task",
    structuredContent: { status: "done", seconds },
  },
  title: "Coder Slow Task",
});

/** The routine the #schedule scenario creates, as the gateway returns it. */
function routineDetails(sessionKey: string): Record<string, unknown> {
  return {
    id: matchesPattern(UUID),
    owner: { agentId: "main", sessionKey, accountId: "default" },
    agentId: "main",
    sessionKey,
    name: "Scripted reminder",
    enabled: true,
    deleteAfterRun: true,
    createdAtMs: isNumberAtLeast(1),
    schedule: { kind: "at", at: "2035-01-01T09:00:00.000Z" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "Reminder: check the trail conditions." },
    state: { nextRunAtMs: Date.parse("2035-01-01T09:00:00.000Z") },
    updatedAtMs: isNumberAtLeast(1),
    configRevision: matchesPattern(/^sha256:\S+$/),
    nextRunAtMs: Date.parse("2035-01-01T09:00:00.000Z"),
    deliveryPreview: { label: "not requested", detail: "not requested" },
  };
}

/** A tool the gateway refused to a non-owner. */
const refusedCall = (name: string, args: unknown): CallExpectation => ({
  name,
  args,
  isError: true,
  content: [`Tool ${name} not found`],
  details: {},
  title: "Automations",
  status: "blocked",
});

/** The text a directive's scenario ends with when its tools return nothing it reads. */
export function scriptedFinalText(directive: string, agentId = "main"): string {
  const ctx: PlanContext = { agentId, sessionKey: null, results: [] };
  const rounds = scenarioRounds(selectScenarios(directive));
  return resolveRound(rounds.at(-1) ?? [], ctx, "check")
    .flatMap((step) => (step.kind === "text" ? [step.text] : []))
    .join("");
}

/** What the recipient answers a #message with. */
const RECIPIENT_REPLY = scriptedFinalText("#reply");

/** The tools a bot's model is offered in a paired client's run: the allowlist, expanded. */
export const EXPECTED_OFFERED_TOOLS = [
  "apply_patch",
  "ask_user",
  ...CODING_AGENT_TOOLS.map((tool) => `${CODING_AGENT_SERVER}__${tool.name}`),
  "edit",
  "exec",
  "ls",
  "progress_card",
  "read",
  "sessions_list",
  "sessions_send",
  "web_search",
  "write",
].sort();

/** What `tools.effective` reports available; it lists owner-only tools whoever asks. */
export const EXPECTED_EFFECTIVE_TOOLS = [
  "apply_patch",
  "ask_user",
  "automations",
  "edit",
  "exec",
  "ls",
  "progress_card",
  "read",
  "sessions_list",
  "sessions_send",
  "web_search",
  "write",
].sort();

const SCHEDULE_RESULT_SHAPE =
  "content text; details {id: string, owner: {…}, agentId: string, sessionKey: string, name: string, enabled: boolean, deleteAfterRun: boolean, createdAtMs: number, schedule: {…}, sessionTarget: string, wakeMode: string, payload: {…}, state: {…}, updatedAtMs: number, configRevision: string, nextRunAtMs: number, deliveryPreview: {…}}";
const SCHEDULE_HISTORY_DETAILS = true;

export type ScenarioCheck = {
  name: string;
  /** The directives it exercises. */
  covers: string[];
  run: (h: Harness) => Promise<void>;
};

async function approvalFor(h: Harness, view: RunView): Promise<JsonRecord> {
  const event = await h
    .op("approvals")
    .waitFor(
      `an exec approval for run ${view.runId}`,
      (e) =>
        e.event === "exec.approval.requested" && rec(rec(e.payload).request).runId === view.runId,
      30_000,
    );
  return rec(event.payload);
}

/** Check an exec approval request against the gateway source's shape. */
function checkApprovalRequest(
  approval: JsonRecord,
  view: RunView,
  command: string,
  decisions: string[],
): void {
  const request = rec(approval.request);
  same(approval.approvalKind, "exec", "approvalKind");
  expect(typeof approval.id === "string" && approval.id, "the approval has an id");
  expect(
    typeof approval.createdAtMs === "number" && typeof approval.expiresAtMs === "number",
    "approval times",
  );
  same(request.command, command, "the approval's command");
  same(request.agentId, SHELL_BOT, "the approval's agent");
  same(request.sessionKey, view.sessionKey, "the approval's session");
  same(request.host, "gateway", "the approval's host");
  same(request.security, "allowlist", "the approval's security");
  same(request.allowedDecisions, decisions, "the decisions the approval offers");
  const toolStart = view.tool("start", "exec")[0];
  same(
    request.toolCallId,
    toolStart ? view.data(toolStart).toolCallId : undefined,
    "the approval's tool call",
  );
  const analysis = rec(request.commandAnalysis);
  expect(typeof analysis.commandCount === "number", "the approval carries a command analysis");
}

async function sessionApproval(h: Harness, approvalId: string, phase: string): Promise<JsonRecord> {
  const event = await h
    .op("approvals")
    .waitFor(
      `session.approval ${phase} for ${approvalId}`,
      (e) =>
        e.event === "session.approval" &&
        rec(e.payload).phase === phase &&
        rec(rec(e.payload).approval).id === approvalId,
      30_000,
    );
  checkShape(SessionApprovalEventSchema, event.payload, "session.approval");
  return rec(event.payload);
}

async function question(h: Harness, sessionKey: string): Promise<JsonRecord> {
  const event = await h
    .op("questions")
    .waitFor(
      `a question in ${sessionKey}`,
      (e) => e.event === "question.requested" && rec(e.payload).sessionKey === sessionKey,
      30_000,
    );
  checkShape(QuestionRequestedEventSchema, event.payload, "question.requested");
  return rec(event.payload);
}

async function answer(
  h: Harness,
  asked: JsonRecord,
  answers: Record<string, string[]>,
): Promise<void> {
  const id = String(asked.id);
  const out = await h.op("questions").request("question.resolve", { id, answers: { answers } });
  same(out.status, "answered", "question.resolve status");
  const resolved = await h
    .op("questions")
    .waitFor(
      `question.resolved ${id}`,
      (e) => e.event === "question.resolved" && rec(e.payload).id === id,
    );
  checkShape(QuestionResolvedEventSchema, resolved.payload, "question.resolved");
  same(rec(resolved.payload).status, "answered", "question.resolved status");
  same(rec(rec(resolved.payload).answers).answers, answers, "question.resolved answers");
}

/** A question run: the card, its answer, the tool result and the reply. */
async function questionCheck(
  h: Harness,
  directive: string,
  shape: (questions: JsonRecord[]) => void,
  answers: Record<string, string[]>,
): Promise<void> {
  const key = await h.session("pip", directive.slice(1));
  const seenBefore = h.op("plain").lastSeq;
  const view = await h.start("questions", key, directive);
  const asked = await question(h, key);
  same(asked.agentId, "pip", "question.requested agentId");
  same(asked.runId, view.runId, "question.requested runId");
  same(asked.status, "pending", "question.requested status");
  const questions = (asked.questions as JsonRecord[]) ?? [];
  expect(
    questions.every((q) => q.isOther === true),
    "every question accepts typed text (isOther)",
  );
  shape(questions);
  await answer(h, asked, answers);
  await h.wait(view);
  view.expectCalls([askCall(directive, "pip", answers)]);
  view.expectEnd(
    "final",
    `Thanks. You answered:\n\n${Object.entries(answers)
      .map(([id, value]) => `- ${id}: ${value.join(", ")}`)
      .join("\n")}`,
  );
  same(view.terminal.state, "final", "the run's end");
  const result = view.result("ask_user");
  same(result.isError, false, "ask_user isError");
  same(result.details.status, "answered", "ask_user result status");
  same(rec(result.details.answers).answers, answers, "ask_user result answers");
  const lines = Object.entries(answers).map(([id, value]) => `- ${id}: ${value.join(", ")}`);
  same(
    view.finalText(),
    `Thanks. You answered:\n\n${lines.join("\n")}`,
    "the reply after the answer",
  );
  if (directive === "#ask") {
    await recordFamily(h, "questions", "#ask", view, "ask_user", {
      args: scriptedArgs("#ask", "ask_user", "pip"),
      title: "Ask User Which route should I plan for Saturday?",
      argsShape: "{questions: [{…}…], timeoutSeconds: number}",
      resultShape: "content text; details {status: string, answers: {…}}",
      historyDetails: false,
    });
  }
  // A connection without operator.questions is not sent question events.
  expect(
    !h.op("plain").events.some((e) => e.seq > seenBefore && e.event.startsWith("question.")),
    "a client without operator.questions received a question event",
  );
}

/** A message from Pip to Marlow; returns the sender's run and the send's result. */
async function messageCheck(h: Harness, directive: string) {
  const key = await h.session("pip", directive.slice(1));
  const view = await h.start("plain", key, directive);
  return { key, view };
}

const RECIPIENT = MESSAGING_PAIR[0];
const RECIPIENT_SESSION = `agent:${RECIPIENT}:main`;

export const SCENARIO_CHECKS: ScenarioCheck[] = [
  {
    name: "plain streamed text",
    covers: ["#text"],
    run: async (h) => {
      const view = await h.run("plain", await h.session("main", "text"), "#text");
      view.inOrder([
        ["lifecycle start", isAgent("lifecycle", "start")],
        ["lifecycle model", isAgent("lifecycle", "model")],
        ["assistant text", isAgent("assistant")],
        ["lifecycle end", isAgent("lifecycle", "end")],
        ["chat final", isChat("final")],
      ]);
      same(view.agent("thinking").length, 0, "thinking events");
      const text = "Here is a plain reply, streamed in small pieces with no reasoning first.";
      same(view.finalText(), text, "text");
      const pieces = view.agent("assistant").map((e) => view.data(e));
      same(pieces.map((d) => d.delta).join(""), text, "the assistant deltas add up to the text");
      // A client rebuilds the text as the gateway sends it: an event with
      // `text` is a snapshot (the first one, a replacement, an empty delta or
      // media), any other appends its `delta`. Here, an append-only stream,
      // only the first event carried a snapshot; the rule does not rely on it.
      let rebuilt = "";
      for (const d of pieces)
        rebuilt = typeof d.text === "string" ? d.text : rebuilt + String(d.delta ?? "");
      same(rebuilt, text, "the text rebuilt from snapshots and deltas");
      same(pieces[0]!.text, pieces[0]!.delta, "the first assistant event is a snapshot");
      view.expectCalls([]);
      view.expectEnd("final", text);
    },
  },
  {
    name: "reasoning then text",
    covers: ["#think"],
    run: async (h) => {
      const view = await h.run("plain", await h.session("main", "think"), "#think");
      view.inOrder([
        ["lifecycle start", isAgent("lifecycle", "start")],
        ["thinking", isAgent("thinking")],
        ["assistant", isAgent("assistant")],
        ["chat final", isChat("final")],
      ]);
      const last = view.agent("thinking").at(-1)!;
      same(
        view.data(last).text,
        "The user wants to see reasoning first. I will reason briefly, then answer.",
        "cumulative reasoning",
      );
      const history = await h
        .op("plain")
        .request<{ messages: JsonRecord[] }>("chat.history", { sessionKey: view.sessionKey });
      const row = history.messages.find((m) => m.role === "assistant");
      same(
        (row?.content as JsonRecord[]).map((part) => part.type),
        ["thinking", "text"],
        "the history row's blocks",
      );
      same(
        [view.terminal.state, view.finalText()],
        ["final", "I thought it over first. This is the answer that follows the reasoning."],
        "the visible answer",
      );
      view.expectCalls([]);
      view.expectEnd(
        "final",
        "I thought it over first. This is the answer that follows the reasoning.",
      );
    },
  },
  {
    name: "reasoning only, no text and no tool",
    covers: ["#think-only"],
    run: async (h) => {
      const view = await h.run("plain", await h.session("main", "think-only"), "#think-only");
      // Observed: the gateway asks the model twice more for a visible answer,
      // within the same run, then ends the run in an error.
      same(view.lifecycle("start").length, 3, "model attempts in the run");
      same(view.agent("assistant").length, 0, "assistant events");
      expect(view.agent("thinking").length > 0, "reasoning was streamed");
      same(view.terminal.state, "error", "the run's end");
      const error = view.lifecycle("error")[0];
      expect(error, "lifecycle error");
      same(rec(view.data(error).terminalReply).disposition, "empty", "terminalReply disposition");
      view.expectCalls([]);
      view.expectEnd("error", null);
      same(
        view.terminal.errorMessage,
        "⚠️ Agent couldn't generate a response. Please try again.",
        "the error message",
      );
    },
  },
  {
    name: "reasoning, tool, reasoning, tool, text",
    covers: ["#steps"],
    run: async (h) => {
      const view = await h.run("plain", await h.session("main", "steps"), "#steps");
      view.inOrder([
        ["lifecycle start", isAgent("lifecycle", "start")],
        ["thinking 1", isAgent("thinking")],
        [
          "item start ls",
          (e) => isAgent("item", "start")(e) && rec(rec(e.payload).data).name === "ls",
        ],
        ["tool start ls", isTool("start", "ls")],
        ["tool result ls", isTool("result", "ls")],
        ["item end ls", (e) => isAgent("item", "end")(e) && rec(rec(e.payload).data).name === "ls"],
        ["lifecycle model", isAgent("lifecycle", "model")],
        ["thinking 2", isAgent("thinking")],
        ["tool start read", isTool("start", "read")],
        ["tool result read", isTool("result", "read")],
        ["assistant", isAgent("assistant")],
        ["lifecycle end", isAgent("lifecycle", "end")],
        ["chat final", isChat("final")],
      ]);
      const start = view.tool("start", "ls")[0]!;
      same(view.data(start).args, { path: "." }, "ls args");
      const item = view.agent("item")[0]!;
      same(view.data(item).itemId, `tool:${String(view.data(start).toolCallId)}`, "item id");
      same(view.result("read").isError, false, "read isError");
      view.expectCalls([await lsCall(h, "main"), await fileCall(h, "main", "AGENTS.md")]);
      view.expectEnd("final", scriptedFinalText("#steps"));
    },
  },
  {
    name: "a phrase sent the way the app sends it plays its scenario",
    covers: [],
    run: async (h) => {
      // chat.send with exactly the app's parameters (packages/core client.ts
      // sendParams): the key, the text, an idempotency key and the queue mode,
      // from an operator client in ui mode. The gateway puts a "Conversation
      // info" block before the text the model receives.
      const key = await h.session("main", "app-phrase");
      const phrase = "Could you please show your work?";
      const view = await h.run("plain", key, phrase, { queueMode: "followup" });
      view.expectCalls([await lsCall(h, "main"), await fileCall(h, "main", "AGENTS.md")]);
      view.expectEnd("final", scriptedFinalText("#steps"));
      const history = await h
        .op("plain")
        .request<{ messages?: JsonRecord[] }>("chat.history", { sessionKey: key });
      same(
        (history.messages ?? []).filter((row) => row.role === "user").map((row) => row.content),
        [phrase],
        "the user's message as the task shows it",
      );
    },
  },
  {
    name: "a slow stream with no reasoning first",
    covers: ["#stream"],
    run: async (h) => {
      const key = await h.session("main", "stream");
      const started = Date.now();
      const view = await h.run("plain", key, "#stream 2");
      // Text only, streamed for about the time asked.
      same(view.agent("thinking").length, 0, "reasoning events");
      expect(view.agent("assistant").length > 1, "the text came in several pieces");
      expect(Date.now() - started >= 1_500, "the stream took about two seconds");
      view.expectCalls([]);
      view.expectEnd("final", scriptedFinalText("#stream 2"));
    },
  },
  {
    name: "a streamed reply, stopped mid-run",
    covers: ["#stream"],
    run: async (h) => {
      const key = await h.session("main", "stream-abort");
      const view = await h.start("plain", key, "#stream 20");
      // Stopped once this run's own text has been seen: `#stream` sends its reply in pieces
      // for twenty seconds (a reply that follows reasoning, as `#slow`'s, the gateway passes on
      // only in one piece as the turn settles, so no point mid-reply can be observed there).
      await h
        .op("plain")
        .waitFor(
          "the run's streamed text",
          (e) => isAgent("assistant")(e) && rec(e.payload).runId === view.runId,
        );
      const observed = streamedText(view);
      expect(observed !== "", "text was seen before the stop");
      const out = await h.op("plain").request("chat.abort", { sessionKey: key });
      same(out, { ok: true, aborted: true, runIds: [view.runId] }, "chat.abort result");
      await h.wait(view, 30_000);
      same(view.terminal.state, "aborted", "the run's end");
      same(view.terminal.stopReason, "rpc", "aborted stopReason");
      const end = view.lifecycle("end")[0];
      expect(end, "lifecycle end");
      same(
        [view.data(end).status, view.data(end).aborted],
        ["cancelled", true],
        "lifecycle end status",
      );
      // The aborted event carries the reply as far as the model had got: at least all that was
      // seen before the stop, and a start of the scripted reply.
      const partial = view.finalText();
      expect(
        partial.startsWith(observed),
        `the aborted event carries the text seen before the stop (${JSON.stringify(observed)}), got ${JSON.stringify(partial)}`,
      );
      expect(
        scriptedFinalText("#stream 20").startsWith(partial),
        "the partial text is a start of the reply",
      );
      view.expectCalls([]);
      view.expectEnd("aborted", null);
    },
  },
  {
    name: "a message queued behind a slow stream",
    covers: ["#slow"],
    run: async (h) => {
      const key = await h.session("main", "slow-queue");
      const first = await h.start("plain", key, "#slow 12");
      // Queued while the first turn is surely under way: after its own reasoning, with twelve
      // seconds of text to come. Queueing as the turn settles meets a race in the gateway
      // itself ("placement authority changed", from its retained placement read refusing a
      // revoked reader); this check proves the queue, not that boundary.
      await h
        .op("plain")
        .waitFor(
          "the first run's reasoning",
          (e) => isAgent("thinking")(e) && rec(e.payload).runId === first.runId,
        );
      const second = await h.start("plain", key, "#text", { queueMode: "followup" });
      expect(second.runId !== first.runId, "the queued message has its own run");
      await h.wait(first, 90_000);
      await h.wait(second, 90_000);
      same([first.terminal.state, second.terminal.state], ["final", "final"], "both runs' ends");
      // The gateway runs the queued turn under an id of its own, which it names beside the
      // send's in sessions.changed (`clientRunId`): under it come only run_status events, and
      // the turn's lifecycle, text and end come under the send's id. It is the same turn.
      const own = h
        .op("plain")
        .events.map((e) => rec(e.payload))
        .find(
          (p) =>
            p.clientRunId === second.runId &&
            typeof p.runId === "string" &&
            p.runId !== second.runId,
        );
      if (own) {
        const ownId = String(own.runId);
        const streams = new Set(
          h
            .op("plain")
            .runEvents(ownId)
            .filter((e) => e.event === "agent" || e.event === "chat")
            .map((e) => `${e.event} ${String(rec(e.payload).stream ?? rec(e.payload).state)}`),
        );
        same(
          [...streams].filter((each) => each !== "agent run_status"),
          [],
          "the queued turn's own id carries only run_status",
        );
        TRACKED.set(ownId, { calls: true, end: true, sessionKey: key });
      }
      const firstEnd = first.events.find(isChat("final"))!;
      // Observed: a turn the gateway runs from its queue reports no lifecycle start under the
      // send's run id (its run_status goes under an id of the gateway's own), so the order is
      // read from the run's first event of any kind.
      const secondFirst = second.events[0];
      expect(
        secondFirst !== undefined && secondFirst.seq > firstEnd.seq,
        "the queued run starts after the first one ends",
      );
      first.expectCalls([]);
      first.expectEnd("final", scriptedFinalText("#slow 12"));
      second.expectCalls([]);
      second.expectEnd("final", scriptedFinalText("#text"));
    },
  },
  {
    name: "a steer into a slow tool",
    covers: ["#slow-tool"],
    run: async (h) => {
      const key = await h.session("main", "slow-tool-steer");
      // The steer is sent once the tool of this exact run has started, with fifteen seconds of
      // the tool still to go: wide enough that its acceptance lands inside the tool on a loaded
      // machine. The scripted tool has no release of its own to hold it at a barrier.
      const first = await h.start("plain", key, "#slow-tool 15");
      await h
        .op("plain")
        .waitFor(
          "the slow tool",
          (e) =>
            isTool("start", `${CODING_AGENT_SERVER}__slow_task`)(e) &&
            rec(e.payload).runId === first.runId,
        );
      const steer = await h.start("plain", key, "#think", { queueMode: "steer" });
      await h.wait(steer, 60_000);
      await h.wait(first, 90_000);
      // Observed: the steer's own run settles at once with an empty final; the
      // tool finishes and the steered message is answered inside the first run.
      same(steer.terminal.state, "final", "the steer run's end");
      same(steer.terminal.message, undefined, "the steer run's final message");
      const slow = first.result(`${CODING_AGENT_SERVER}__slow_task`);
      same(slow.isError, false, "the slow tool still finished");
      // A server text that only repeats the structured content is dropped:
      // one block, the rendering of the structured content.
      same(
        slow.content.map((p) => p.text),
        [`structuredContent:\n${JSON.stringify({ seconds: 15, status: "done" }, null, 2)}`],
        "a duplicate server text is dropped",
      );
      same(
        slow.details.structuredContent,
        { status: "done", seconds: 15 },
        "the slow tool's structured result",
      );
      same(
        first.finalText(),
        "I thought it over first. This is the answer that follows the reasoning.",
        "the active run answered the steer",
      );
      first.expectCalls([slowTaskCall(15)]);
      first.expectEnd("final", scriptedFinalText("#think"));
      steer.expectCalls([]);
      steer.expectEnd("final", "");
    },
  },
  {
    name: "a tool that fails",
    covers: ["#tool-fail"],
    run: async (h) => {
      const view = await h.run("plain", await h.session("main", "tool-fail"), "#tool-fail");
      same(view.terminal.state, "final", "the run's end");
      const result = view.result("read");
      same(result.isError, true, "read isError");
      same(result.details.status, "error", "result details status");
      const end = view.agent("item").find((e) => view.data(e).phase === "end")!;
      same(view.data(end).status, "failed", "item end status");
      let failed: JsonRecord | undefined;
      view.expectCalls([
        {
          name: "read",
          args: scriptedArgs("#tool-fail", "read"),
          isError: true,
          details: (d: JsonRecord | undefined, where: string) => {
            failed = d;
            detailsLike({
              status: "error",
              tool: "read",
              error: matchesPattern(/^File not found: \S+\/workspace\/missing\/old-notes\.md\.$/),
            })(d, where);
          },
          content: (texts: string[], where: string) =>
            textsLike([jsonText(where, () => failed)])(texts, where),
          title: "Read from missing/old-notes.md",
        },
      ]);
      view.expectEnd("final", scriptedFinalText("#tool-fail"));
    },
  },
  {
    name: "tool output cut by the gateway",
    covers: ["#long-output"],
    run: async (h) => {
      const view = await h.run("plain", await h.session("main", "long-output"), "#long-output");
      const result = view.result(`${CODING_AGENT_SERVER}__long_output`);
      expect(
        result.text.length < 9_000,
        `event text is cut (got ${result.text.length} characters)`,
      );
      expect(result.text.endsWith("…(truncated)…"), "event text ends with the truncation marker");
      const history = await h
        .op("plain")
        .request<{ messages: JsonRecord[] }>("chat.history", { sessionKey: view.sessionKey });
      const row = history.messages.find((m) => m.role === "toolResult")!;
      same(
        [rec(row.__openclaw).truncated, rec(row.__openclaw).reason],
        [true, "display-cap"],
        "history truncation marker",
      );
      const more = await h.op("plain").request<{ messages: JsonRecord[] }>("chat.history", {
        sessionKey: view.sessionKey,
        maxChars: 500_000,
      });
      const longer = more.messages.find((m) => m.role === "toolResult")!;
      const text = (longer.content as JsonRecord[]).map((p) => String(p.text ?? "")).join("");
      expect(text.length > 8_000, "chat.history maxChars returns more of the output");
      const full = Array.from({ length: 20_000 }, (_, i) => `line ${i + 1} of 20000`).join("\n");
      const marker = "\n…(truncated)…";
      view.expectCalls([
        {
          name: `${CODING_AGENT_SERVER}__long_output`,
          args: { lines: 20_000 },
          isError: false,
          content: textsLike([
            (value, where) =>
              expect(
                typeof value === "string" &&
                  value.endsWith(marker) &&
                  value.length > 8_000 &&
                  value.length < 8_100 &&
                  full.startsWith(value.slice(0, -marker.length)),
                `${where} must be the start of the output, cut, then the marker`,
              ),
          ]),
          details: { mcpServer: CODING_AGENT_SERVER, mcpTool: "long_output" },
          title: "Coder Long Output",
        },
      ]);
      view.expectEnd("final", scriptedFinalText("#long-output"));
    },
  },
  {
    name: "a shell command that needs approval, with a reusable rule",
    covers: ["#approve"],
    run: async (h) => {
      const key = await h.session(SHELL_BOT, "approve");
      const view = await h.start("approvals", key, "#approve");
      const approval = await approvalFor(h, view);
      checkApprovalRequest(approval, view, SHELL_COMMANDS.list, [
        "allow-once",
        "allow-always",
        "deny",
      ]);
      same(rec(approval.request).ask, "on-miss", "the approval's ask");
      const id = String(approval.id);
      const pending = await sessionApproval(h, id, "pending");
      same(
        rec(rec(pending.approval).presentation).allowedDecisions,
        ["allow-once", "allow-always", "deny"],
        "session.approval decisions",
      );
      await h
        .op("approvals")
        .waitFor(
          "waiting-approval",
          (e) => isAgent("lifecycle", "waiting-approval")(e) && rec(e.payload).runId === view.runId,
        );
      same(
        await h.op("approvals").request("exec.approval.resolve", { id, decision: "allow-always" }),
        { ok: true },
        "exec.approval.resolve",
      );
      const resolved = await h
        .op("approvals")
        .waitFor(
          "exec.approval.resolved",
          (e) => e.event === "exec.approval.resolved" && rec(e.payload).id === id,
        );
      same(rec(resolved.payload).decision, "allow-always", "resolved decision");
      const terminal = await sessionApproval(h, id, "terminal");
      same(
        [rec(terminal.approval).status, rec(terminal.approval).decision],
        ["allowed", "allow-always"],
        "session.approval terminal",
      );
      await h.wait(view);
      view.inOrder([
        ["tool start exec", isTool("start", "exec")],
        ["waiting-approval", isAgent("lifecycle", "waiting-approval")],
        ["approval-resolved", isAgent("lifecycle", "approval-resolved")],
        ["tool result exec", isTool("result", "exec")],
        ["chat final", isChat("final")],
      ]);
      const result = view.result("exec");
      same(
        [result.isError, result.details.status, result.details.exitCode],
        [false, "completed", 0],
        "exec result",
      );
      await recordFamily(h, "shell", "#approve", view, "exec", {
        args: scriptedArgs("#approve", "exec", SHELL_BOT),
        title: "Exec list files (in .)",
        argsShape: "{command: string, workdir: string}",
        resultShape:
          "content text; details {status: string, exitCode: number, exitSignal: null, exitReason: string, durationMs: number, aggregated: string, noOutputTimedOut: boolean, cwd: string}",
        historyDetails: true,
      });
      same(
        [result.text, result.details.aggregated],
        [await listing(h, SHELL_BOT), await listing(h, SHELL_BOT)],
        "the command's output is the workspace listing",
      );
      // The rule is reused: the same command in the same folder runs without asking.
      const again = await h.run("approvals", key, "#approve");
      same(again.result("exec").details.exitCode, 0, "the second run's exec");
      expect(
        !h
          .op("approvals")
          .events.some(
            (e) =>
              e.event === "exec.approval.requested" &&
              rec(rec(e.payload).request).runId === again.runId,
          ),
        "the reusable rule was not applied: the same command asked again",
      );
      // The rule is the bot's, not the session's: a new task reuses it too.
      const elsewhere = await h.run(
        "approvals",
        await h.session(SHELL_BOT, "approve-reuse"),
        "#approve",
      );
      same(elsewhere.result("exec").details.exitCode, 0, "the exec in a new task");
      expect(
        !h
          .op("approvals")
          .events.some(
            (e) =>
              e.event === "exec.approval.requested" &&
              rec(rec(e.payload).request).runId === elsewhere.runId,
          ),
        "the reusable rule was not applied in a new task",
      );
      const lsOutput = await listing(h, SHELL_BOT);
      const approvedLs = execCall(
        { command: "ls", workdir: "." },
        {
          isError: false,
          content: [lsOutput],
          details: {
            status: "completed",
            exitCode: 0,
            exitSignal: null,
            exitReason: "exit",
            durationMs: isNumberAtLeast(0),
            aggregated: lsOutput,
            noOutputTimedOut: false,
          },
          title: "Exec list files (in .)",
        },
      );
      for (const run of [view, again, elsewhere]) {
        run.expectCalls([approvedLs]);
        run.expectEnd("final", scriptedFinalText("#approve"));
      }
    },
  },
  {
    name: "a shell command that needs approval, with no reusable rule",
    covers: ["#approve-once"],
    run: async (h) => {
      const key = await h.session(SHELL_BOT, "approve-once");
      const view = await h.start("approvals", key, "#approve-once");
      const approval = await approvalFor(h, view);
      checkApprovalRequest(approval, view, SHELL_COMMANDS.print, ["allow-once", "deny"]);
      same(rec(approval.request).ask, "always", "the approval's ask");
      same(rec(approval.request).unavailableDecisions, ["allow-always"], "unavailableDecisions");
      const id = String(approval.id);
      const refused = await h
        .op("approvals")
        .request("exec.approval.resolve", { id, decision: "allow-always" })
        .then(
          () => null,
          (error: unknown) => error as { message?: string; details?: unknown },
        );
      expect(refused, "allow-always was accepted for a command that offers no reusable rule");
      same(
        rec(refused.details).reason,
        "APPROVAL_ALLOW_ALWAYS_UNAVAILABLE",
        "the refusal's reason",
      );
      same(
        await h.op("approvals").request("exec.approval.resolve", { id, decision: "deny" }),
        { ok: true },
        "deny",
      );
      await h.wait(view);
      same(view.terminal.state, "final", "the run's end");
      same(view.result("exec").isError, true, "a denied exec's isError");
      same(
        view.finalText(),
        "The gateway did not let the command run.",
        "the reply after a denial",
      );
      const deniedText = `Exec denied (gateway id=${id}, user-denied): echo 'Hello from Otto.'`;
      view.expectCalls([
        execCall(scriptedArgs("#approve-once", "exec", SHELL_BOT) as JsonRecord, {
          isError: true,
          content: [deniedText],
          details: {
            status: "failed",
            exitCode: null,
            durationMs: 0,
            aggregated: deniedText,
            timedOut: false,
          },
          title: "Exec print text (in .)",
        }),
      ]);
      view.expectEnd("final", "The gateway did not let the command run.");
    },
  },
  {
    name: "a command that exits non-zero",
    covers: ["#exit-code"],
    run: async (h) => {
      const key = await h.session(SHELL_BOT, "exit-code");
      const view = await h.start("approvals", key, "#exit-code");
      const approval = await approvalFor(h, view);
      checkApprovalRequest(approval, view, SHELL_COMMANDS.missing, [
        "allow-once",
        "allow-always",
        "deny",
      ]);
      await h
        .op("approvals")
        .request("exec.approval.resolve", { id: approval.id, decision: "allow-once" });
      await h.wait(view);
      const result = view.result("exec");
      same([result.isError, result.details.status], [false, "completed"], "exec result");
      // `ls` of a missing folder exits 1 on BSD and 2 on GNU, and words its message differently.
      const code = Number(result.details.exitCode);
      expect(
        code === 1 || code === 2,
        `ls of a missing folder exits 1 or 2 (got ${String(result.details.exitCode)})`,
      );
      const exited = result.text;
      expect(
        /^ls: .*missing-folder.*No such file or directory\n\n\(Command exited with code (\d+)\)$/.exec(
          exited,
        )?.[1] === String(code),
        `the result text is ls's own message and names the exit code (${JSON.stringify(exited)})`,
      );
      const end = view.agent("command_output").find((e) => view.data(e).phase === "end");
      expect(end, "command_output end");
      same(view.data(end).exitCode, code, "command_output exitCode");
      view.expectCalls([
        execCall(scriptedArgs("#exit-code", "exec", SHELL_BOT) as JsonRecord, {
          isError: false,
          content: [exited],
          details: {
            status: "completed",
            exitCode: code,
            exitSignal: null,
            exitReason: "exit",
            durationMs: isNumberAtLeast(0),
            aggregated: exited,
            noOutputTimedOut: false,
          },
          title: "Exec list files in missing-folder (in .)",
          // Observed: the item ends "failed" although the result is not an error.
          status: "failed",
        }),
      ]);
      view.expectEnd("final", scriptedFinalText("#exit-code"));
    },
  },
  {
    name: "a command that runs past its time limit",
    covers: ["#exec-timeout"],
    run: async (h) => {
      const key = await h.session(SHELL_BOT, "exec-timeout");
      const view = await h.start("approvals", key, "#exec-timeout");
      const approval = await approvalFor(h, view);
      await h
        .op("approvals")
        .request("exec.approval.resolve", { id: approval.id, decision: "allow-once" });
      await h.wait(view);
      const result = view.result("exec");
      same(result.isError, true, "exec isError");
      same(
        [result.details.status, result.details.timedOut, result.details.failureKind],
        ["failed", true, "overall-timeout"],
        "exec timeout details",
      );
      same(view.terminal.state, "final", "the run's end");
      view.expectCalls([
        execCall(scriptedArgs("#exec-timeout", "exec", SHELL_BOT) as JsonRecord, {
          isError: true,
          content: [
            "Command timed out after 1 seconds.\n\nThe command was terminated, but external side effects may already have completed. Verify the resulting state before retrying. Do not automatically rerun non-idempotent commands. Use a higher timeout only when the command is known to be safe to retry.",
          ],
          details: {
            status: "failed",
            exitCode: null,
            exitSignal: "SIGTERM",
            failureKind: "overall-timeout",
            exitReason: "overall-timeout",
            durationMs: isNumberAtLeast(900),
            aggregated: "",
            timedOut: true,
            noOutputTimedOut: false,
          },
          title: "Exec sleep 5 (in .)",
        }),
      ]);
      view.expectEnd("final", scriptedFinalText("#exec-timeout"));
    },
  },
  {
    name: "exec stays denied for a bot without the shell",
    covers: ["#approve"],
    run: async (h) => {
      const view = await h.run("approvals", await h.session("pip", "exec-denied"), "#approve");
      const result = view.result("exec");
      same(result.isError, true, "exec isError");
      expect(
        result.text.includes("exec denied: host=gateway security=deny"),
        "the denial names the policy",
      );
      expect(
        !h
          .op("approvals")
          .events.some(
            (e) =>
              e.event === "exec.approval.requested" &&
              rec(rec(e.payload).request).runId === view.runId,
          ),
        "a denied bot raised an approval",
      );
      const refusal = {
        status: "error",
        tool: "exec",
        error: "exec denied: host=gateway security=deny",
      };
      view.expectCalls([
        {
          name: "exec",
          args: scriptedArgs("#approve", "exec", "pip"),
          isError: true,
          content: [JSON.stringify(refusal, null, 2)],
          details: refusal,
          title: "Exec list files (in .)",
        },
      ]);
      view.expectEnd("final", "The gateway did not let the command run.");
    },
  },
  {
    name: "one question with options",
    covers: ["#ask"],
    run: (h) =>
      questionCheck(
        h,
        "#ask",
        (questions) => {
          same(questions.length, 1, "questions");
          same(questions[0]!.questionId, "route", "questionId");
          same(
            (questions[0]!.options as JsonRecord[]).map((o) => o.label),
            ["Lake loop", "Ridge trail", "Town walk"],
            "options",
          );
        },
        { route: ["Ridge trail"] },
      ),
  },
  {
    name: "several questions in one card",
    covers: ["#ask-many"],
    run: (h) =>
      questionCheck(
        h,
        "#ask-many",
        (questions) =>
          same(
            questions.map((q) => q.questionId),
            ["route", "start_time", "lunch"],
            "question ids",
          ),
        { route: ["Lake loop"], start_time: ["9:30"], lunch: ["No"] },
      ),
  },
  {
    name: "a multi-select question",
    covers: ["#ask-multi"],
    run: (h) =>
      questionCheck(
        h,
        "#ask-multi",
        (questions) => same(questions[0]!.multiSelect, true, "multiSelect"),
        { packing: ["Headlamp", "Snacks"] },
      ),
  },
  {
    name: "a question answered in free text",
    covers: ["#ask-text"],
    run: (h) =>
      questionCheck(
        h,
        "#ask-text",
        (questions) => same(questions[0]!.questionId, "trip_name", "questionId"),
        { trip_name: ["Autumn ramble"] },
      ),
  },
  {
    name: "a message to another bot, answered in the same call",
    covers: ["#message", "#reply"],
    run: async (h) => {
      const { view } = await messageCheck(h, "#message");
      await h.wait(view, 60_000);
      const start = view.tool("start", "sessions_send")[0]!;
      same(
        view.data(start).args,
        { agentId: RECIPIENT, message: "#reply Could you look over the plan?", timeoutSeconds: 30 },
        "sessions_send args",
      );
      const result = view.result("sessions_send");
      same(
        [result.isError, result.details.status, result.details.sessionKey],
        [false, "ok", RECIPIENT_SESSION],
        "sessions_send result",
      );
      same(rec(result.details.delivery).status, "skipped", "delivery status");
      const recipientRun = String(result.details.runId);
      const recipient = new RunView(h.op("plain"), recipientRun, RECIPIENT_SESSION, view.from);
      same(
        [recipient.terminal.state, recipient.terminal.sessionKey],
        ["final", RECIPIENT_SESSION],
        "the recipient's run",
      );
      recipient.validate();
      same(result.details.reply, recipient.finalText(), "the reply is the recipient's final text");
      same(view.finalText(), `Marlow replied:\n\n> ${recipient.finalText()}`, "the sender's reply");
      // The recipient's history records the message as an assistant row with
      // inter-session provenance naming the sender's task.
      const recipientHistory = await h
        .op("plain")
        .request<{ messages: JsonRecord[] }>("chat.history", {
          sessionKey: RECIPIENT_SESSION,
          limit: 200,
        });
      const incoming = recipientHistory.messages.filter(
        (m) => rec(m.provenance).sourceSessionKey === view.sessionKey,
      );
      same(
        incoming.map((m) => [
          m.role,
          rec(m.provenance).kind,
          rec(m.provenance).sourceTool,
          m.content,
        ]),
        [["assistant", "inter_session", "sessions_send", "#reply Could you look over the plan?"]],
        "the message in the recipient's history",
      );
      await recordFamily(h, "messaging between bots", "#message", view, "sessions_send", {
        args: scriptedArgs("#message", "sessions_send", "pip"),
        title: "Session Send agent marlow, timeout 30",
        argsShape: "{agentId: string, message: string, timeoutSeconds: number}",
        resultShape:
          "content text; details {runId: string, sessionKey: string, status: string, delivery: {…}, reply: string}",
        historyDetails: true,
      });
      // The recipient's run ends before the sender's tool result arrives.
      expect(
        recipient.events.find(isChat("final"))!.seq < view.tool("result", "sessions_send")[0]!.seq,
        "order of recipient end and tool result",
      );
      view.expectCalls([
        sendCall(
          "#message",
          "pip",
          {
            sessionKey: RECIPIENT_SESSION,
            status: "ok",
            delivery: { status: "skipped" },
            reply: RECIPIENT_REPLY,
          },
          false,
          "Session Send agent marlow, timeout 30",
        ),
      ]);
      view.expectEnd("final", `Marlow replied:\n\n> ${RECIPIENT_REPLY}`);
      recipient.expectCalls([]);
      recipient.expectEnd("final", RECIPIENT_REPLY);
    },
  },
  {
    name: "a bot outside the pair cannot message",
    covers: ["#message"],
    run: async (h) => {
      const view = await h.run("plain", await h.session("main", "message-outside"), "#message");
      const result = view.result("sessions_send");
      same([result.isError, result.details.status], [true, "forbidden"], "sessions_send result");
      h.observe(`a send from outside the pair: ${String(result.details.error)}`);
      same(
        view.finalText(),
        "The message to Marlow did not get through (forbidden).",
        "the sender's reply",
      );
      view.expectCalls([
        sendCall(
          "#message",
          "main",
          {
            status: "forbidden",
            error:
              "Agent-to-agent messaging denied by the requester agent tools.agentToAgent.send allowlist. Ask the operator to add this destination if intended.",
            sessionKey: RECIPIENT_SESSION,
          },
          true,
          "Session Send agent marlow, timeout 30",
        ),
      ]);
      view.expectEnd("final", "The message to Marlow did not get through (forbidden).");
    },
  },
  {
    name: "a message to a slow bot",
    covers: ["#message-slow"],
    run: async (h) => {
      const { key, view } = await messageCheck(h, "#message-slow");
      await h.wait(view, 30_000);
      const result = view.result("sessions_send");
      same(
        [result.isError, result.details.status, result.details.targetDisposition],
        [false, "accepted", "queued"],
        "sessions_send result",
      );
      same(rec(result.details.delivery).status, "pending", "delivery status");
      same(
        view.finalText(),
        "Marlow is still working on it. Their reply will arrive in this task.",
        "the sender's reply",
      );
      const recipient = new RunView(
        h.op("plain"),
        String(result.details.runId),
        RECIPIENT_SESSION,
        view.from,
      );
      await h.wait(recipient, 60_000);
      // The sender's run ended before the recipient's did.
      expect(
        view.events.find(isChat("final"))!.seq < recipient.events.find(isChat("final"))!.seq,
        "the recipient was still running when the sender finished",
      );
      same(recipient.terminal.state, "final", "the recipient's run");
      // The late reply starts a new run in the sender's task.
      const late = await h
        .op("plain")
        .waitFor(
          "the late reply's run in the sender's task",
          (e) =>
            isChat("final")(e) &&
            rec(e.payload).sessionKey === key &&
            rec(e.payload).runId !== view.runId,
          30_000,
          recipient.events.find(isChat("final"))!.seq,
        );
      const lateRun = new RunView(h.op("plain"), String(rec(late.payload).runId), key, view.from);
      same(
        lateRun.finalText(),
        "Marlow's reply arrived. It is shown above.",
        "the sender's answer to the late reply",
      );
      const history = await h
        .op("plain")
        .request<{ messages: JsonRecord[] }>("chat.history", { sessionKey: key });
      const forwarded = history.messages.find((m) => rec(m.provenance).kind === "inter_session");
      expect(forwarded, "the late reply is in the sender's history with inter-session provenance");
      h.observe(
        `late reply row: role ${String(forwarded.role)}, sourceTool ${String(rec(forwarded.provenance).sourceTool)}, sourceSessionKey ${String(rec(forwarded.provenance).sourceSessionKey)}`,
      );
      view.expectCalls([
        sendCall(
          "#message-slow",
          "pip",
          {
            status: "accepted",
            sessionKey: RECIPIENT_SESSION,
            targetDisposition: "queued",
            delivery: { status: "pending" },
          },
          false,
          "Session Send agent marlow, timeout 3",
        ),
      ]);
      view.expectEnd(
        "final",
        "Marlow is still working on it. Their reply will arrive in this task.",
      );
      recipient.expectCalls([]);
      recipient.expectEnd("final", scriptedFinalText("#slow 15"));
      lateRun.expectCalls([]);
      lateRun.expectEnd("final", "Marlow's reply arrived. It is shown above.");
    },
  },
  {
    name: "a message to a bot whose run fails",
    covers: ["#message-fail"],
    run: async (h) => {
      const { view } = await messageCheck(h, "#message-fail");
      await h.wait(view, 60_000);
      const result = view.result("sessions_send");
      same(
        [result.isError, result.details.status, result.details.sentBeforeError],
        [true, "error", true],
        "sessions_send result",
      );
      const recipient = new RunView(
        h.op("plain"),
        String(result.details.runId),
        RECIPIENT_SESSION,
        view.from,
      );
      same(recipient.terminal.state, "error", "the recipient's run");
      same(view.finalText(), "Marlow got the message, but their run failed.", "the sender's reply");
      view.expectCalls([
        sendCall(
          "#message-fail",
          "pip",
          {
            status: "error",
            error:
              "LLM request rejected: The scripted model was asked to fail\\. | scripted_failure",
            sentBeforeError: true,
            sessionKey: RECIPIENT_SESSION,
          },
          true,
          "Session Send agent marlow, timeout 30",
        ),
      ]);
      view.expectEnd("final", "Marlow got the message, but their run failed.");
      recipient.expectCalls([]);
      recipient.expectEnd("error", null);
    },
  },
  {
    name: "a message to a bot that asks its own user",
    covers: ["#message-ask"],
    run: async (h) => {
      const { key, view } = await messageCheck(h, "#message-ask");
      const asked = await question(h, RECIPIENT_SESSION);
      same(asked.agentId, RECIPIENT, "the question's agent");
      // The sender's call returns while the question is pending.
      await h.wait(view, 30_000);
      const result = view.result("sessions_send");
      same(result.details.status, "accepted", "sessions_send status while the recipient asks");
      same(asked.runId, result.details.runId, "the question belongs to the recipient's run");
      await answer(h, asked, { route: ["Town walk"] });
      const recipient = new RunView(
        h.op("plain"),
        String(result.details.runId),
        RECIPIENT_SESSION,
        view.from,
      );
      await h.wait(recipient, 30_000);
      same(
        recipient.finalText(),
        "Thanks. You answered:\n\n- route: Town walk",
        "the recipient's reply",
      );
      const late = await h
        .op("plain")
        .waitFor(
          "the late reply's run in the sender's task",
          (e) =>
            isChat("final")(e) &&
            rec(e.payload).sessionKey === key &&
            rec(e.payload).runId !== view.runId,
          30_000,
          recipient.events.find(isChat("final"))!.seq,
        );
      view.expectCalls([
        sendCall(
          "#message-ask",
          "pip",
          {
            status: "accepted",
            sessionKey: RECIPIENT_SESSION,
            targetDisposition: "queued",
            delivery: { status: "pending" },
          },
          false,
          "Session Send agent marlow, timeout 5",
        ),
      ]);
      view.expectEnd(
        "final",
        "Marlow is still working on it. Their reply will arrive in this task.",
      );
      recipient.expectCalls([askCall("#ask", RECIPIENT, { route: ["Town walk"] })]);
      recipient.expectEnd("final", "Thanks. You answered:\n\n- route: Town walk");
      const lateRun = new RunView(h.op("plain"), String(rec(late.payload).runId), key, view.from);
      lateRun.expectCalls([]);
      lateRun.expectEnd("final", "Marlow's reply arrived. It is shown above.");
    },
  },
  {
    name: "an MCP call to the coding agent, with a link",
    covers: ["#mcp"],
    run: async (h) => {
      const view = await h.run("plain", await h.session("main", "mcp"), "#mcp");
      const name = `${CODING_AGENT_SERVER}__send_message`;
      const result = view.result(name);
      same(
        [result.isError, result.details.mcpServer, result.details.mcpTool],
        [false, CODING_AGENT_SERVER, "send_message"],
        "MCP result",
      );
      const structured = rec(result.details.structuredContent);
      expect(
        String(structured.url).startsWith(THREAD_URL_BASE),
        "the result carries the thread link",
      );
      same(
        view.finalText(),
        `The coding agent picked it up: ${String(structured.url)}`,
        "the reply",
      );
      await recordFamily(h, "tool servers (MCP)", "#mcp", view, name, {
        args: scriptedArgs("#mcp", name),
        title: "Coder Send Message",
        argsShape: "{message: string}",
        resultShape:
          "content text+text; details {mcpServer: string, mcpTool: string, structuredContent: {…}}",
        historyDetails: false,
      });
      // The server's own text is kept beside the rendering of its structured
      // content, which comes first.
      same(
        result.content.map((p) => p.type),
        ["text", "text"],
        "the MCP result's content blocks",
      );
      same(
        result.content[0]!.text,
        `structuredContent:\n${JSON.stringify(sortedKeys(structured), null, 2)}`,
        "the structured content rendered as text",
      );
      same(result.content[1]!.text, SEND_MESSAGE_TEXT, "the server's own text");
      expect(/^thread-\d+$/.test(String(structured.threadId)), "the thread id");
      same(
        [structured.reply, structured.url],
        [
          "Opened a branch and drafted the change for: Add a dark mode toggle to the settings page.",
          `${THREAD_URL_BASE}${String(structured.threadId)}`,
        ],
        "the structured reply",
      );
      view.expectCalls([sendMessageCall("#mcp", "Add a dark mode toggle to the settings page.")]);
      view.expectEnd("final", `The coding agent picked it up: ${String(structured.url)}`);
    },
  },
  {
    name: "a slow MCP call",
    covers: ["#mcp-slow"],
    run: async (h) => {
      const view = await h.run("plain", await h.session("main", "mcp-slow"), "#mcp-slow 3");
      const name = `${CODING_AGENT_SERVER}__send_message`;
      const start = view.tool("start", name)[0]!;
      const end = view.tool("result", name)[0]!;
      expect(end.at - start.at >= 2_500, "the call took its delay");
      // No progress is forwarded between the start and the result.
      same(view.tool("update", name).length, 0, "tool update events");
      const result = view.result(name);
      same(result.isError, false, "MCP isError");
      same(view.data(start).args, scriptedArgs("#mcp-slow 3", name), "the slow call's arguments");
      const structured = rec(result.details.structuredContent);
      same(
        [structured.reply, structured.url, result.content.map((p) => p.text)[1]],
        [
          "Opened a branch and drafted the change for: Refactor the settings page into sections.",
          `${THREAD_URL_BASE}${String(structured.threadId)}`,
          SEND_MESSAGE_TEXT,
        ],
        "the slow call's result",
      );
      same(view.finalText(), `The coding agent finished: ${String(structured.url)}`, "the reply");
      view.expectCalls([
        sendMessageCall("#mcp-slow 3", "Refactor the settings page into sections."),
      ]);
      view.expectEnd("final", `The coding agent finished: ${String(structured.url)}`);
    },
  },
  {
    name: "an MCP call that returns an error",
    covers: ["#mcp-error"],
    run: async (h) => {
      const view = await h.run("plain", await h.session("main", "mcp-error"), "#mcp-error");
      const result = view.result(`${CODING_AGENT_SERVER}__run_checks`);
      same([result.isError, result.details.status], [true, "error"], "MCP error result");
      same(view.terminal.state, "final", "the run's end");
      view.expectCalls([
        {
          name: `${CODING_AGENT_SERVER}__run_checks`,
          args: {},
          isError: true,
          content: ["Checks failed: 2 of 14 tests failed in the stand-in suite."],
          details: { mcpServer: CODING_AGENT_SERVER, mcpTool: "run_checks", status: "error" },
          title: "Coder Run Checks",
        },
      ]);
      view.expectEnd("final", scriptedFinalText("#mcp-error"));
    },
  },
  {
    name: "an MCP call stopped mid-call",
    covers: ["#mcp-stop"],
    run: async (h) => {
      const key = await h.session("main", "mcp-stop");
      const view = await h.start("plain", key, "#mcp-stop");
      const name = `${CODING_AGENT_SERVER}__slow_task`;
      await h
        .op("plain")
        .waitFor(
          "the long call",
          (e) => isTool("start", name)(e) && rec(e.payload).runId === view.runId,
        );
      await sleep(500);
      same(
        await h.op("plain").request("chat.abort", { sessionKey: key }),
        { ok: true, aborted: true, runIds: [view.runId] },
        "chat.abort",
      );
      await h.wait(view, 30_000);
      same([view.terminal.state, view.terminal.stopReason], ["aborted", "rpc"], "the run's end");
      // Observed: the call's result arrives after the run's terminal events.
      const result = await h
        .op("plain")
        .waitFor(
          "the stopped call's result",
          (e) => isTool("result", name)(e) && rec(e.payload).runId === view.runId,
          30_000,
        );
      same(
        [rec(rec(result.payload).data).isError, view.result(name).text],
        [true, "Aborted"],
        "the stopped call's result",
      );
      expect(
        result.seq > view.events.find(isChat("aborted"))!.seq,
        "order of the aborted event and the tool result",
      );
      view.expectCalls([
        {
          name: `${CODING_AGENT_SERVER}__slow_task`,
          args: { seconds: 3600 },
          isError: true,
          content: ["Aborted"],
          details: {},
          title: "Coder Slow Task",
        },
      ]);
      view.expectEnd("aborted", "");
    },
  },
  {
    name: "a run that ends in a model error",
    covers: ["#model-error"],
    run: async (h) => {
      const view = await h.run("plain", await h.session("main", "model-error"), "#model-error");
      same(view.terminal.state, "error", "the run's end");
      expect(
        String(view.terminal.errorMessage).includes("The scripted model was asked to fail"),
        "errorMessage",
      );
      same(rec(view.terminal.errorDetail).failoverReason, "format", "errorDetail.failoverReason");
      expect(view.lifecycle("error").length === 1, "lifecycle error");
      same(view.agent("assistant").length, 0, "assistant events");
      view.expectCalls([]);
      view.expectEnd("error", null);
    },
  },
  {
    name: "one file read",
    covers: ["#read"],
    run: async (h) => {
      const view = await h.run("plain", await h.session("main", "read"), "#read");
      await recordFamily(h, "files: read", "#read", view, "read", {
        args: scriptedArgs("#read", "read"),
        title: "Read from AGENTS.md",
        argsShape: "{path: string}",
        resultShape: "content text; details {kind: string, content: string}",
        historyDetails: false,
      });
      const file = await workspaceFile(h, "main", "AGENTS.md");
      const result = view.result("read");
      same(
        [result.text, result.details.kind, result.details.content],
        [file, "text", file],
        "the file read",
      );
      same(
        [view.terminal.state, view.finalText()],
        ["final", "I read my instructions file."],
        "the run's end",
      );
      view.expectCalls([await fileCall(h, "main", "AGENTS.md")]);
      view.expectEnd("final", scriptedFinalText("#read"));
    },
  },
  {
    name: "an answer the gateway keeps as a reply, after text beside a call that it keeps as none",
    covers: ["#reply-to"],
    run: async (h) => {
      const key = await h.session("main", "reply-to");
      const root = await h.run("plain", key, "#text");
      root.expectCalls([]);
      root.expectEnd("final", scriptedFinalText("#text"));
      const history = async () =>
        (
          await h
            .op("plain")
            .request<{ messages: JsonRecord[] }>("chat.history", { sessionKey: key })
        ).messages;
      const parent = String(rec((await history()).find((m) => m.role === "user")?.__openclaw).id);
      const view = await h.run("plain", key, `#reply-to ${parent}`);
      view.expectCalls([await lsCall(h, "main")]);
      const answer = `This answers ${parent}.`;
      view.expectEnd("final", answer);
      const text = (row: JsonRecord) =>
        (Array.isArray(row.content) ? (row.content as JsonRecord[]) : [])
          .map((part) => (part.type === "text" ? String(part.text) : ""))
          .join("");
      const rows = (await history()).filter(
        (m) => m.role === "assistant" && rec(m.__openclaw).runId === view.runId && text(m),
      );
      // The tag is read on the answer's row alone, the one with no tool call.
      same(
        rows.map((row) => [text(row), rec(row.openclawDelivery).replyToId ?? null]),
        [
          ["I will look first, then answer that message.", null],
          [answer, parent],
        ],
        "each text row's reply reference",
      );
      same(
        rec(rec(rec(rows[1]!.__openclaw).replyToMessage).message).content,
        "#text",
        "the message history attaches to the answer's reference",
      );
    },
  },
  {
    name: "six file reads in a row",
    covers: ["#read-six"],
    run: async (h) => {
      const view = await h.run("plain", await h.session("main", "read-six"), "#read-six");
      const starts = view.tool("start");
      same(
        starts.map((e) => [view.data(e).name, view.data(e).args]),
        scriptedCalls("#read-six").map((call) => [call.name, call.arguments]),
        "the six calls and their arguments",
      );
      const first = starts[0]!.seq;
      const last = view.tool("result", "read").at(-1)!.seq;
      same(
        view.agent("assistant").filter((e) => e.seq > first && e.seq < last).length,
        0,
        "text between the reads",
      );
      const results = view.tool("result", "read").map((e) => rec(view.data(e).result));
      for (const [i, call] of scriptedCalls("#read-six").entries()) {
        const args = call.arguments as { path: string; offset?: number };
        const file = await workspaceFile(h, "main", args.path);
        const expected = args.offset
          ? file
              .split("\n")
              .slice(args.offset - 1)
              .join("\n")
          : file;
        const text = (results[i]!.content as JsonRecord[]).map((p) => String(p.text)).join("");
        same(
          text,
          expected,
          `read ${i + 1} (${args.path}${args.offset ? ` from line ${args.offset}` : ""})`,
        );
      }
      same(
        [view.terminal.state, view.finalText()],
        ["final", "I read six files in my workspace."],
        "the run's end",
      );
      const reads: CallExpectation[] = [];
      for (const call of scriptedCalls("#read-six")) {
        const args = call.arguments as { path: string; offset?: number };
        reads.push(await fileCall(h, "main", args.path, args.offset));
      }
      view.expectCalls(reads);
      view.expectEnd("final", scriptedFinalText("#read-six"));
    },
  },
  {
    name: "a folder listing",
    covers: ["#list"],
    run: async (h) => {
      const view = await h.run("plain", await h.session("main", "list"), "#list");
      await recordFamily(h, "files: list", "#list", view, "ls", {
        args: scriptedArgs("#list", "ls"),
        title: "Ls .",
        argsShape: "{path: string}",
        resultShape: "content text; details {content: string}",
        historyDetails: false,
      });
      const result = view.result("ls");
      same(result.details.content, result.text, "the listing in details");
      const listed = result.text.split("\n").map((line) => JSON.parse(line) as string);
      const workspace = await h
        .op("plain")
        .request<{ entries: { name: string; kind: string }[] }>("agents.workspace.list", {
          agentId: "main",
        });
      same(
        listed.filter((name) => !name.endsWith("/")).sort(),
        workspace.entries
          .filter((e) => e.kind === "file")
          .map((e) => e.name)
          .sort(),
        "the listed files are the workspace's",
      );
      same(
        [view.terminal.state, view.finalText()],
        ["final", "Those are the files in my workspace."],
        "the run's end",
      );
      view.expectCalls([await lsCall(h, "main")]);
      view.expectEnd("final", scriptedFinalText("#list"));
    },
  },
  {
    name: "a file write",
    covers: ["#write"],
    run: async (h) => {
      const view = await h.run("plain", await h.session("main", "write"), "#write");
      const args = scriptedArgs("#write", "write") as { path: string; content: string };
      await recordFamily(h, "files: write", "#write", view, "write", {
        args,
        title: "Write to notes/scratch.md (34 chars)",
        argsShape: "{path: string, content: string}",
        resultShape:
          "content text; details {changed: boolean, created: boolean, diff: string, firstChangedLine: number, patch: string}",
        historyDetails: true,
      });
      const result = view.result("write");
      expect(
        /^Successfully wrote 34 bytes to \S+\/notes\/scratch\.md$/.test(result.text),
        `write text: ${result.text}`,
      );
      same(
        [result.details.changed, result.details.created, result.details.diff],
        [true, true, "+1 # Scratch\n+2 \n+3 - Check the trail map."],
        "write details",
      );
      same(await workspaceFile(h, "main", args.path), args.content, "the file on disk");
      same(
        [view.terminal.state, view.finalText()],
        ["final", "I wrote notes/scratch.md."],
        "the run's end",
      );
      view.expectCalls([
        fileChangeCall(
          "write",
          scriptedArgs("#write", "write") as { path: string; content: string },
          "Successfully wrote 34 bytes to <path>",
          {
            created: true,
            diff: "+1 # Scratch\n+2 \n+3 - Check the trail map.",
            hunk: "@@ -0,0 +1,3 @@\n+# Scratch\n+\n+- Check the trail map.\n",
          },
          "Write to notes/scratch.md (34 chars)",
        ),
      ]);
      view.expectEnd("final", scriptedFinalText("#write"));
    },
  },
  {
    name: "a file edit",
    covers: ["#edit"],
    run: async (h) => {
      const view = await h.run("plain", await h.session("main", "edit"), "#edit");
      await recordFamily(h, "files: edit", "#edit", view, "edit", {
        args: scriptedArgs("#edit", "edit"),
        title: "Edit in notes/edit-me.md",
        argsShape: "{path: string, edits: [{…}…]}",
        resultShape:
          "content text; details {changed: boolean, diff: string, firstChangedLine: number, patch: string}",
        historyDetails: true,
      });
      const result = view.result("edit");
      expect(
        /^Successfully replaced 1 block\(s\) in \S+\/notes\/edit-me\.md\.$/.test(result.text),
        `edit text: ${result.text}`,
      );
      same(
        [result.details.changed, result.details.diff],
        [true, "-1 Leave at 9:00.\n+1 Leave at 8:30."],
        "edit details",
      );
      same(
        await workspaceFile(h, "main", "notes/edit-me.md"),
        "Leave at 8:30.\n",
        "the file on disk",
      );
      same(
        [view.terminal.state, view.finalText()],
        ["final", "I changed the departure time in notes/edit-me.md."],
        "the run's end",
      );
      view.expectCalls([
        fileChangeCall(
          "write",
          scriptedArgs("#edit", "write") as { path: string; content: string },
          "Successfully wrote 15 bytes to <path>",
          { created: true, diff: "+1 Leave at 9:00.", hunk: "@@ -0,0 +1,1 @@\n+Leave at 9:00.\n" },
          "Write to notes/edit-me.md (15 chars)",
        ),
        fileChangeCall(
          "edit",
          scriptedArgs("#edit", "edit") as { path: string; edits: unknown },
          "Successfully replaced 1 block(s) in <path>.",
          {
            diff: "-1 Leave at 9:00.\n+1 Leave at 8:30.",
            hunk: "@@ -1,1 +1,1 @@\n-Leave at 9:00.\n+Leave at 8:30.\n",
          },
          "Edit in notes/edit-me.md",
        ),
      ]);
      view.expectEnd("final", scriptedFinalText("#edit"));
    },
  },
  {
    name: "a note saved to memory",
    covers: ["#remember"],
    run: async (h) => {
      const view = await h.run("plain", await h.session("main", "remember"), "#remember");
      const args = scriptedArgs("#remember", "write") as { path: string; content: string };
      same(
        args,
        { path: "memory/2026-11-17.md", content: "- Prefers the lake loop on relaxed weekends.\n" },
        "the scripted note",
      );
      await recordFamily(h, "memory", "#remember", view, "write", {
        args,
        title: "Write to memory/2026-11-17.md (45 chars)",
        argsShape: "{path: string, content: string}",
        resultShape:
          "content text; details {changed: boolean, created: boolean, diff: string, firstChangedLine: number, patch: string}",
        historyDetails: true,
      });
      same(
        view.result("write").details.diff,
        "+1 - Prefers the lake loop on relaxed weekends.",
        "the note's diff",
      );
      same(await workspaceFile(h, "main", args.path), args.content, "the note on disk");
      same(
        [view.terminal.state, view.finalText()],
        ["final", "Saved to memory: you prefer the lake loop on relaxed weekends."],
        "the run's end",
      );
      view.expectCalls([
        fileChangeCall(
          "write",
          args,
          "Successfully wrote 45 bytes to <path>",
          {
            created: true,
            diff: "+1 - Prefers the lake loop on relaxed weekends.",
            hunk: "@@ -0,0 +1,1 @@\n+- Prefers the lake loop on relaxed weekends.\n",
          },
          "Write to memory/2026-11-17.md (45 chars)",
        ),
      ]);
      view.expectEnd("final", scriptedFinalText("#remember"));
    },
  },
  {
    name: "a web search answered on loopback",
    covers: ["#search"],
    run: async (h) => {
      const view = await h.run("plain", await h.session("main", "search"), "#search");
      const args = scriptedArgs("#search", "web_search") as { query: string; count: number };
      await recordFamily(h, "web search", "#search", view, "web_search", {
        args,
        title: `Web Search for "${args.query}" (top 3)`,
        argsShape: "{query: string, count: number}",
        resultShape:
          "content text; details {kind: string, provider: string, query: string, count: number, tookMs: number, results: [{…}…], externalContent: {…}}",
        historyDetails: false,
      });
      const result = view.result("web_search");
      const parsed = rec(JSON.parse(result.text) as unknown);
      for (const source of [parsed, result.details]) {
        same(
          [source.kind, source.provider, source.query, source.count],
          ["results", "ollama", args.query, 3],
          "the search result",
        );
        same(
          (source.results as JsonRecord[]).map((r) => r.url),
          [1, 2, 3].map((n) => `https://search.example/results/${n}`),
          "results come from the scripted server",
        );
      }
      same(
        [view.terminal.state, view.finalText()],
        ["final", "I found three results; they are shown above."],
        "the run's end",
      );
      const wrapped = (inner: string): Check =>
        matchesPattern(
          new RegExp(
            `^\\n<<<EXTERNAL_UNTRUSTED_CONTENT id="([0-9a-f]+)">>>\\nSource: Web Search\\n---\\n${escapeRe(inner)}\\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="\\1">>>$`,
          ),
        );
      let found: JsonRecord | undefined;
      view.expectCalls([
        {
          name: "web_search",
          args,
          isError: false,
          details: (d: JsonRecord | undefined, where: string) => {
            found = d;
            detailsLike({
              kind: "results",
              provider: "ollama",
              query: args.query,
              count: 3,
              tookMs: isNumberAtLeast(0),
              results: (value: unknown, at: string) => {
                const rows = value as JsonRecord[];
                same(rows.length, 3, `${at} length`);
                for (const [i, row] of rows.entries()) {
                  detailsLike({
                    title: wrapped(`Result ${i + 1} for ${args.query}`),
                    url: `https://search.example/results/${i + 1}`,
                    snippet: wrapped(
                      `A scripted search result (${i + 1} of 3) about ${args.query}.`,
                    ),
                    siteName: wrapped("search.example"),
                  })(row, `${at}[${i}]`);
                }
              },
              externalContent: {
                untrusted: true,
                source: "web_search",
                provider: "ollama",
                wrapped: true,
              },
            })(d, where);
          },
          content: (texts: string[], where: string) =>
            textsLike([jsonText(where, () => found)])(texts, where),
          title: `Web Search for "${args.query}" (top 3)`,
        },
      ]);
      view.expectEnd("final", scriptedFinalText("#search"));
    },
  },
  {
    name: "a look at the bot's sessions",
    covers: ["#sessions"],
    run: async (h) => {
      const view = await h.run("plain", await h.session("main", "sessions"), "#sessions");
      await recordFamily(h, "sessions", "#sessions", view, "sessions_list", {
        args: scriptedArgs("#sessions", "sessions_list"),
        title: "Sessions 5",
        argsShape: "{limit: number}",
        resultShape:
          "content text; details {count: number, sessions: [{…}…], hasMore: boolean, nextOffset: number, limitApplied: number}",
        historyDetails: false,
      });
      const result = view.result("sessions_list");
      const sessions = (result.details.sessions ?? []) as JsonRecord[];
      same(
        [
          result.details.count,
          sessions.length,
          result.details.limitApplied,
          result.details.hasMore,
        ],
        [5, 5, 5, true],
        "the page",
      );
      expect(
        sessions.every((row) => row.agentId === "main"),
        "every session is the bot's own",
      );
      // The details shorten each key for display; the text keeps it whole.
      const listed = (rec(JSON.parse(result.text) as unknown).sessions ?? []) as JsonRecord[];
      expect(
        listed.length === 5 && listed.every((row) => String(row.key).startsWith("agent:main:")),
        "every key is one of the bot's tasks",
      );
      same(rec(JSON.parse(result.text) as unknown).count, 5, "the text carries the same list");
      same(
        [view.terminal.state, view.finalText()],
        ["final", "Those are my recent tasks."],
        "the run's end",
      );
      let page: JsonRecord | undefined;
      view.expectCalls([
        {
          name: "sessions_list",
          args: scriptedArgs("#sessions", "sessions_list"),
          isError: false,
          details: (d: JsonRecord | undefined, where: string) => {
            page = d;
            detailsLike({
              count: 5,
              sessions: (value: unknown, at: string) => {
                const rows = value as JsonRecord[];
                same(rows.length, 5, `${at} length`);
                for (const [i, row] of rows.entries()) {
                  same(
                    [row.agentId, row.kind, row.archived],
                    ["main", "other", false],
                    `${at}[${i}]`,
                  );
                  matchesPattern(/^agent:…\S+$/)(row.key, `${at}[${i}].key`);
                  matchesPattern(UUID)(row.sessionId, `${at}[${i}].sessionId`);
                }
              },
              hasMore: true,
              nextOffset: 5,
              limitApplied: 5,
            })(d, where);
          },
          // The text keeps each key whole and lists the same sessions.
          content: (texts: string[], where: string) => {
            same(texts.length, 1, `${where} content blocks`);
            const listed = rec(JSON.parse(texts[0]!) as unknown);
            same(listed.count, 5, `${where} text count`);
            const rows = (listed.sessions ?? []) as JsonRecord[];
            same(
              rows.map((row) => row.sessionId),
              ((page?.sessions ?? []) as JsonRecord[]).map((row) => row.sessionId),
              `${where} text sessions`,
            );
            expect(
              rows.every((row) => String(row.key).startsWith("agent:main:")),
              `${where} text keys`,
            );
          },
          title: "Sessions 5",
        },
      ]);
      view.expectEnd("final", scriptedFinalText("#sessions"));
    },
  },
  {
    name: "a routine created and removed by the owner",
    covers: ["#schedule"],
    run: async (h) => {
      const key = await h.session("main", "schedule");
      const view = await h.ownerRun("main", key, "#schedule");
      // A run the CLI started reaches this client through session.tool (sessions.subscribe).
      same(view.agent("tool").length, 0, "agent tool events for a run another client started");
      const calls = view
        .sessionTool("start", "automations")
        .map((e) => view.data(e).args as JsonRecord);
      const results = view.sessionTool("result", "automations").map((e) => view.data(e));
      same(calls.length, 2, "the two automations calls");
      same(calls[0], scriptedArgs("#schedule", "automations"), "the add call");
      const added = rec(
        JSON.parse((rec(results[0]!.result).content as JsonRecord[])[0]!.text as string) as unknown,
      );
      same(
        [added.name, rec(added.schedule).at, rec(added.payload).kind, added.enabled],
        ["Scripted reminder", "2035-01-01T09:00:00.000Z", "systemEvent", true],
        "the routine created",
      );
      same(
        calls[1],
        { action: "remove", jobId: added.id },
        "the remove call names the created routine",
      );
      same(rec(results[1]!.result).details, { ok: true, removed: true }, "the remove result");
      same(
        results.map((r) => r.isError),
        [false, false],
        "the calls' isError",
      );
      await recordFamily(h, "scheduling", "#schedule", view, "automations", {
        args: calls[0],
        title: "Automations",
        argsShape:
          "{action: string, job: {name: string, schedule: {…}, sessionTarget: string, wakeMode: string, payload: {…}}}",
        resultShape: SCHEDULE_RESULT_SHAPE,
        historyDetails: SCHEDULE_HISTORY_DETAILS,
      });
      same(
        [view.terminal.state, view.finalText()],
        ["final", "I created the routine and removed it again."],
        "the run's end",
      );
      // The same message from a paired client: the gateway does not offer the tool.
      const asUser = await h.run("plain", await h.session("main", "schedule-user"), "#schedule");
      const refused = asUser.tool("result", "automations").map((e) => rec(asUser.data(e).result));
      expect(refused.length > 0, "the paired client's run called automations");
      for (const r of refused) {
        same((r.content as JsonRecord[])[0]?.text, "Tool automations not found", "the refusal");
      }
      let routine: JsonRecord | undefined;
      const addArgs = scriptedArgs("#schedule", "automations");
      view.expectCalls([
        {
          name: "automations",
          args: addArgs,
          isError: false,
          details: (d: JsonRecord | undefined, where: string) => {
            routine = d;
            detailsLike(routineDetails(key))(d, where);
          },
          content: (texts: string[], where: string) =>
            textsLike([jsonText(where, () => routine)])(texts, where),
          title: "Automations",
        },
        {
          name: "automations",
          args: { action: "remove", jobId: added.id },
          isError: false,
          content: [JSON.stringify({ ok: true, removed: true }, null, 2)],
          details: { ok: true, removed: true },
          title: "Automations",
        },
      ]);
      view.expectEnd("final", "I created the routine and removed it again.");
      asUser.expectCalls([
        refusedCall("automations", addArgs),
        refusedCall("automations", { action: "remove", jobId: "unknown" }),
      ]);
      asUser.expectEnd(
        "final",
        "The routine could not be set up here; the gateway offers routines only to its owner.",
      );
    },
  },
  {
    name: "a tool with no kind of its own",
    covers: ["#plan"],
    run: async (h) => {
      const view = await h.run("plain", await h.session("main", "plan"), "#plan");
      await recordFamily(h, "other (progress card)", "#plan", view, "progress_card", {
        args: scriptedArgs("#plan", "progress_card"),
        title: "Progress Card",
        argsShape: "{plan: [{…}…]}",
        resultShape: "content text+text; details {revision: number, steps: {…}}",
        historyDetails: false,
      });
      const result = view.result("progress_card");
      same(
        result.content.map((p) => p.text),
        [
          "Progress card updated (rev 1, 3/3 done)",
          JSON.stringify({ revision: 1, steps: { completed: 3, total: 3 } }, null, 2),
        ],
        "the progress card result",
      );
      same(result.details, { revision: 1, steps: { completed: 3, total: 3 } }, "the saved plan");
      same(
        [view.terminal.state, view.finalText()],
        ["final", "The plan is on the card above."],
        "the run's end",
      );
      view.expectCalls([
        {
          name: "progress_card",
          args: scriptedArgs("#plan", "progress_card"),
          isError: false,
          content: [
            "Progress card updated (rev 1, 3/3 done)",
            JSON.stringify({ revision: 1, steps: { completed: 3, total: 3 } }, null, 2),
          ],
          details: { revision: 1, steps: { completed: 3, total: 3 } },
          title: "Progress Card",
        },
      ]);
      view.expectEnd("final", scriptedFinalText("#plan"));
    },
  },
  {
    name: "the tools in effect are exactly the allowed ones",
    covers: [],
    run: async (h) => {
      // What the model was really offered, as the scripted server received it.
      const paired = await h.session("main", "offered");
      const pairedRun = await h.run("plain", paired, "#text");
      pairedRun.expectCalls([]);
      pairedRun.expectEnd("final", scriptedFinalText("#text"));
      same(
        await h.offeredTools(paired),
        EXPECTED_OFFERED_TOOLS,
        "tools offered in a paired client's run",
      );
      const ownerKey = await h.session("main", "offered-owner");
      const ownerRun = await h.ownerRun("main", ownerKey, "#text");
      ownerRun.expectCalls([]);
      ownerRun.expectEnd("final", scriptedFinalText("#text"));
      same(
        await h.offeredTools(ownerKey),
        [...EXPECTED_OFFERED_TOOLS, "automations"].sort(),
        "tools offered in an owner's run",
      );
      // What the gateway reports as available, which does not know the sender.
      const effective = await h
        .op("plain")
        .request<{ toolAccess?: { tools?: JsonRecord[] } }>("tools.effective", {
          sessionKey: paired,
        });
      const tools = effective.toolAccess?.tools;
      expect(Array.isArray(tools) && tools.length > 0, "tools.effective reported no tools");
      same(
        tools
          .filter((t) => t.status === "available")
          .map((t) => String(t.id))
          .sort(),
        EXPECTED_EFFECTIVE_TOOLS,
        "tools.effective available tools",
      );
      for (const tool of DENIED_TOOLS) {
        const row = tools.find((t) => t.id === tool);
        expect(!row || row.status !== "available", `${tool} is denied but reported available`);
      }
      // The gateway's own tools, which no plugin may turn on, are its whole catalog.
      const catalog = await h
        .op("plain")
        .request<{ groups?: { tools?: JsonRecord[] }[] }>("tools.catalog", { agentId: "main" });
      same(
        (catalog.groups ?? []).flatMap((g) => (g.tools ?? []).map((t) => String(t.id))).sort(),
        [...GATEWAY_TOOLS].sort(),
        "tools.catalog tool ids",
      );
    },
  },
  {
    name: "a turn the gateway starts itself is answered quietly",
    covers: [],
    run: async (h) => {
      // What the gateway does on its own, started deliberately: a wake with a
      // system event for a task. An ordinary event gets the heartbeat prompt;
      // a command's completion event gets the completion prompt, as when a
      // command finishes after its turn ended, its output naming a scenario's
      // phrase or not.
      const wakes = [
        {
          slug: "woken",
          text: "A system event from the scenario check",
          prompt: "Follow the heartbeat monitor scratch context when provided.",
        },
        {
          slug: "woken-exec",
          text: "Exec completed (scenario-check, code 0) :: synthetic result",
          prompt: "An async command you ran earlier has completed.",
        },
        {
          slug: "woken-exec-phrase",
          text: "Exec failed (scenario-check, code 1) :: please show your work",
          prompt: "An async command you ran earlier has completed.",
        },
      ];
      for (const wake of wakes) {
        const where = `the wake "${wake.text}"`;
        const key = await h.session("main", wake.slug);
        const first = await h.run("plain", key, "#text");
        first.expectCalls([]);
        first.expectEnd("final", scriptedFinalText("#text"));
        const op = h.op("plain");
        // Each row of the task's history, by role, content and id (the
        // transcript's generation hash changes when a turn is recorded).
        const history = async () =>
          (
            (await op.request<{ messages?: JsonRecord[] }>("chat.history", { sessionKey: key }))
              .messages ?? []
          ).map((row) => [row.role, row.content, rec(row.__openclaw).id]);
        const before = await history();
        same(await h.quietTurns(key), [], `quiet turns before ${where}`);
        const from = op.lastSeq;
        same(
          await op.request("wake", { mode: "now", text: wake.text, sessionKey: key }),
          { ok: true },
          `the response to ${where}`,
        );
        // The gateway's turn: a run marked as a heartbeat.
        const began = await op.waitFor(
          `the gateway's own turn after ${where}`,
          (e) =>
            e.event === "agent" &&
            rec(e.payload).sessionKey === key &&
            rec(e.payload).isHeartbeat === true,
          30_000,
          from,
        );
        const woken = new RunView(op, String(rec(began.payload).runId), key, from);
        await op.terminal(woken.runId);
        await sleep(300);
        // The scripted model saw the prompt this kind of wake gets, and answered it quietly.
        same(await h.quietTurns(key), [wake.prompt], `the prompt of the turn after ${where}`);
        // Answered with the gateway's "nothing to say": a run with lifecycle
        // events only, ended silent, a final with no message, and nothing
        // added to the task's history.
        woken.expectCalls([]);
        woken.expectEnd("final", null);
        same(rec(woken.terminal).message, undefined, `the final message after ${where}`);
        same(
          woken.agent().map((e) => [rec(e.payload).stream, rec(e.payload).isHeartbeat]),
          woken.agent().map(() => ["lifecycle", true]),
          `the agent events after ${where}`,
        );
        const ended = woken.agent("lifecycle").find((e) => woken.data(e).phase === "end");
        expect(ended, `the turn after ${where} has no lifecycle end`);
        same(woken.data(ended).terminalReply, { disposition: "silent" }, `how ${where} ended`);
        same(
          op.events
            .filter(
              (e) =>
                e.seq > from && e.event === "session.message" && rec(e.payload).sessionKey === key,
            )
            .map((e) => e.event),
          [],
          `messages in the task after ${where}`,
        );
        same(await history(), before, `the task's history after ${where}`);
      }
      h.observe(
        "A wake with a system event runs a turn the gateway writes itself: the heartbeat prompt, then the event as a runtime context block; a command's completion event gets the completion prompt instead. Its agent events are lifecycle only and marked isHeartbeat. Answered with NO_REPLY, it ends with terminalReply.disposition silent and a chat final without a message, and adds nothing to the task's history.",
      );
    },
  },
  {
    name: "who receives a run's tool payloads",
    covers: ["#read"],
    run: async (h) => {
      const key = await h.session("main", "watcher");
      const view = await h.run("approvals", key, "#read");
      // The client that sent the message: agent tool events.
      same(
        view.agent("tool").map((e) => view.data(e).phase),
        ["start", "result"],
        "agent tool events for the sender",
      );
      same(view.sessionTool().length, 0, "session.tool for the sender");
      // A client that called sessions.subscribe: the same payloads as session.tool.
      const watcher = new RunView(h.op("plain"), view.runId, key, 0);
      same(watcher.agent("tool").length, 0, "agent tool events for a session subscriber");
      const viaSession = watcher.sessionTool();
      same(
        viaSession.map((e) => watcher.data(e).phase),
        ["start", "result"],
        "session.tool for a session subscriber",
      );
      same(
        viaSession.map((e) => [watcher.data(e).args, watcher.data(e).result]),
        view.agent("tool").map((e) => [view.data(e).args, view.data(e).result]),
        "session.tool carries the same arguments and result",
      );
      // A client subscribed only to the session's messages: items, no tool payloads.
      const messagesOnly = new RunView(h.op("questions"), view.runId, key, 0);
      same(
        [messagesOnly.agent("tool").length, messagesOnly.sessionTool().length],
        [0, 0],
        "tool payloads for a messages-only subscriber",
      );
      same(
        messagesOnly.agent("item").length,
        view.agent("item").length,
        "item events reach every subscriber",
      );
      view.expectCalls([await fileCall(h, "main", "AGENTS.md")]);
      view.expectEnd("final", scriptedFinalText("#read"));
    },
  },
  {
    name: "a slow shell command, approved",
    covers: ["#sleep"],
    run: async (h) => {
      const key = await h.session(SHELL_BOT, "sleep");
      const view = await h.start("approvals", key, "#sleep 1");
      const approval = await approvalFor(h, view);
      checkApprovalRequest(approval, view, SHELL_COMMANDS.sleep(1), [
        "allow-once",
        "allow-always",
        "deny",
      ]);
      await h
        .op("approvals")
        .request("exec.approval.resolve", { id: approval.id, decision: "allow-once" });
      await h.wait(view);
      same(
        view.data(view.tool("start", "exec")[0]!).args,
        { command: "sleep 1", workdir: "." },
        "the exec arguments",
      );
      const result = view.result("exec");
      same(
        [result.isError, result.details.status, result.details.exitCode, result.details.exitReason],
        [false, "completed", 0, "exit"],
        "the exec result",
      );
      expect(
        Number(result.details.durationMs) >= 900,
        `the command slept (${String(result.details.durationMs)} ms)`,
      );
      const started = view.tool("start", "exec")[0]!.at;
      const ended = view.tool("result", "exec")[0]!.at;
      expect(ended - started >= 900, "the call took the command's time");
      same(
        [view.terminal.state, view.finalText()],
        ["final", "The slow command finished."],
        "the run's end",
      );
      view.expectCalls([
        execCall(scriptedArgs("#sleep 1", "exec", SHELL_BOT) as JsonRecord, {
          isError: false,
          content: ["(no output)"],
          details: {
            status: "completed",
            exitCode: 0,
            exitSignal: null,
            exitReason: "exit",
            durationMs: isNumberAtLeast(900),
            aggregated: "",
            noOutputTimedOut: false,
          },
          title: "Exec sleep 1 (in .)",
        }),
      ]);
      view.expectEnd("final", scriptedFinalText("#sleep 1"));
    },
  },
  {
    name: "the list of scenarios",
    covers: ["#help"],
    run: async (h) => {
      const view = await h.run("plain", await h.session("main", "help"), "#help");
      same(view.terminal.state, "final", "the run's end");
      const text = view.finalText();
      for (const scenario of SCENARIOS.filter((s) => s.name !== "help")) {
        expect(text.includes(`\`#${scenario.name}`), `#help does not list #${scenario.name}`);
        if (scenario.phrase !== undefined) {
          expect(
            text.includes(`"${scenario.phrase}"`),
            `#help does not give the phrase for #${scenario.name}`,
          );
        }
      }
      view.expectCalls([]);
      view.expectEnd("final", scriptedFinalText("#help"));
    },
  },
  {
    name: "directives compose",
    covers: ["#think", "#mcp", "#ask"],
    run: async (h) => {
      const key = await h.session("pip", "compose");
      const view = await h.start("questions", key, "#think #mcp #ask");
      const asked = await question(h, key);
      await answer(h, asked, { route: ["Lake loop"] });
      await h.wait(view);
      // Observed: text in the same model message as a tool call is not on the
      // assistant stream; it arrives as an item of kind "preamble".
      const preamble = (e: GatewayEvent) =>
        isAgent("item", "end")(e) && rec(rec(e.payload).data).kind === "preamble";
      view.inOrder([
        ["thinking", isAgent("thinking")],
        ["preamble item", preamble],
        ["MCP call", isTool("result", `${CODING_AGENT_SERVER}__send_message`)],
        ["ask_user", isTool("result", "ask_user")],
        ["chat final", isChat("final")],
      ]);
      const first = view.agent("item").find(preamble)!;
      same(
        view.data(first).progressText,
        "I thought it over first. This is the answer that follows the reasoning.",
        "preamble text",
      );
      const reasoning = view
        .agent("thinking")
        .filter((e) => view.events.indexOf(e) < view.events.indexOf(first))
        .at(-1)!;
      same(
        view.data(reasoning).text,
        "The user wants to see reasoning first. I will reason briefly, then answer.\nThis is a coding change. I will hand it to the coding agent.",
        "two reasoning steps in one message join with a newline",
      );
      same(view.finalText(), "Thanks. You answered:\n\n- route: Lake loop", "the reply");
      view.expectCalls([
        sendMessageCall("#think #mcp #ask", "Add a dark mode toggle to the settings page."),
        askCall("#ask", "pip", { route: ["Lake loop"] }),
      ]);
      view.expectEnd("final", "Thanks. You answered:\n\n- route: Lake loop");
    },
  },
  {
    name: "every directive has a check",
    covers: [],
    run: () => {
      same(uncoveredDirectives(), [], "directives no check sends");
      return Promise.resolve();
    },
  },
  // The Work pane's files. Last, so their tasks are not among the ones the sessions check pages through.
  {
    name: "a file write over the readers' limit",
    covers: ["#write-large"],
    run: async (h) => {
      const key = await h.session("main", "write-large");
      const view = await h.run("plain", key, "#write-large");
      const { first, lastLine, rest } = largeLogParts();
      same(
        [first.length + rest.length, first.endsWith(lastLine)],
        [LARGE_LOG_BYTES, true],
        "the two calls' parts",
      );
      const changed = (where: string, details: JsonRecord | undefined, created: boolean | null) =>
        same(
          [details?.changed, created === null ? undefined : details?.created],
          [true, created === null ? undefined : created],
          `${where} details changed and created`,
        );
      view.expectCalls([
        {
          name: "write",
          args: scriptedArgs("#write-large", "write"),
          isError: false,
          content: textsLike([
            matchesPattern(
              new RegExp(`^Successfully wrote ${first.length} bytes to \\S+/logs/transcode\\.log$`),
            ),
          ]),
          details: (details: JsonRecord | undefined, where: string) =>
            changed(where, details, true),
          title: `Write to ${LARGE_LOG_PATH} (${first.length} chars)`,
        },
        {
          name: "edit",
          args: scriptedArgs("#write-large", "edit"),
          isError: false,
          content: textsLike([
            matchesPattern(/^Successfully replaced 1 block\(s\) in \S+\/logs\/transcode\.log\.$/),
          ]),
          details: (details: JsonRecord | undefined, where: string) =>
            changed(where, details, null),
          title: `Edit in ${LARGE_LOG_PATH}`,
        },
      ]);
      view.expectEnd("final", scriptedFinalText("#write-large"));
      // The task lists it as changed, with its size; neither get reader sends it, and each
      // says so with the size and its limit (262,144 bytes).
      const list = await h
        .op("plain")
        .request<{ files: JsonRecord[] }>("sessions.files.list", { sessionKey: key });
      same(
        list.files.map((file) => [file.path, file.kind, file.size]),
        [[LARGE_LOG_PATH, "modified", LARGE_LOG_BYTES]],
        "the task's file list",
      );
      const refusal = async (method: string, params: JsonRecord) => {
        try {
          await h.op("plain").request(method, params);
        } catch (error) {
          return rec((error as { details?: unknown }).details);
        }
        throw new CheckFailure(`${method} sent a file over its limit`);
      };
      const task = await refusal("sessions.files.get", { sessionKey: key, path: LARGE_LOG_PATH });
      same(
        [task.type, task.size, task.maxPreviewBytes],
        ["session_file_too_large", LARGE_LOG_BYTES, 262_144],
        "sessions.files.get refusal",
      );
      const workspace = await refusal("agents.workspace.get", {
        agentId: "main",
        path: LARGE_LOG_PATH,
      });
      same(
        [workspace.type, workspace.size, workspace.maxBytes],
        ["workspace_file_too_large", LARGE_LOG_BYTES, 262_144],
        "agents.workspace.get refusal",
      );
    },
  },
  {
    name: "a picture read from the workspace",
    covers: ["#picture"],
    run: async (h) => {
      const key = await h.session(FILES_BOT, "picture");
      const view = await h.run("plain", key, "#picture");
      // The scripted model takes no images: the read tool says so instead of sending the picture.
      const text =
        "Read image file [image/png]\n[Current model does not support images. The image will be omitted from this request.]";
      view.expectCalls([
        {
          name: "read",
          args: { path: PICTURE_PATH },
          isError: false,
          content: [text],
          details: { kind: "text", content: text },
          title: `Read from ${PICTURE_PATH}`,
        },
      ]);
      view.expectEnd("final", scriptedFinalText("#picture", FILES_BOT));
      // The task's own reader sends the picture as it is on disk.
      const got = await h.op("plain").request<{ file: JsonRecord }>("sessions.files.get", {
        sessionKey: key,
        path: PICTURE_PATH,
      });
      const picture = trailMap();
      same(
        [
          got.file.kind,
          got.file.previewKind,
          got.file.mimeType,
          got.file.contentEncoding,
          got.file.size,
        ],
        ["read", "image", "image/png", "base64", picture.length],
        "sessions.files.get of the picture",
      );
      same(got.file.content, picture.toString("base64"), "the picture's bytes");
    },
  },
];

/** Directives of the scripted model that no scenario check claims to send. */
export function uncoveredDirectives(): string[] {
  // The browser directives are sent by the computer checks, #message-read by
  // the rules checks and the image directives by the image checks, each on an
  // instance of their own.
  const covered = new Set(
    [...SCENARIO_CHECKS, ...COMPUTER_CHECKS, ...RULES_CHECKS, ...IMAGE_CHECKS].flatMap(
      (check) => check.covers,
    ),
  );
  return SCENARIOS.map((s) => `#${s.name}`).filter((directive) => !covered.has(directive));
}

/** Run the checks on open clients. Returns one line per check, and whether all passed. */
export async function runScenarioChecks(
  clients: Record<ClientName, OperatorSession>,
  options: {
    log?: (line: string) => void;
    only?: (check: ScenarioCheck) => boolean;
    ownerAgent?: (botId: string, key: string, message: string) => Promise<void>;
    providerUrl?: string;
  } = {},
): Promise<{ passed: number; failed: number; notes: string[] }> {
  const log = options.log ?? console.log;
  const harness = createHarness(clients, options.ownerAgent, options.providerUrl);
  await prepareRecipient(harness);
  let passed = 0;
  let failed = 0;
  for (const check of SCENARIO_CHECKS.filter(options.only ?? (() => true))) {
    try {
      await runCheck(harness, check);
      passed += 1;
      log(`ok    ${check.name}`);
    } catch (error) {
      failed += 1;
      log(`FAIL  ${check.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { passed, failed, notes: harness.notes };
}

/**
 * A bot may ask a question only in a session a person owns, so the
 * recipient's main session is opened with a message from a person first.
 */
export async function prepareRecipient(h: Harness): Promise<void> {
  // The plain client also follows every session, so it receives session.tool
  // for runs it did not start; the questions client deliberately does not.
  await h.op("plain").request("sessions.subscribe", {});
  const opened = await h.run("plain", RECIPIENT_SESSION, "#reply");
  opened.expectCalls([]);
  opened.expectEnd("final", RECIPIENT_REPLY);
}

export function createHarness(
  clients: Record<ClientName, OperatorSession>,
  ownerAgent?: (botId: string, key: string, message: string) => Promise<void>,
  providerUrl?: string,
): Harness & { notes: string[] } {
  let counter = 0;
  const notes: string[] = [];
  const stamp = Date.now().toString(36);
  const harness = {
    notes,
    op: (client: ClientName) => clients[client],
    async session(botId: string, tag: string) {
      counter += 1;
      const key = `agent:${botId}:check-${tag}-${stamp}-${counter}`;
      LEDGER.add(key);
      for (const [name, op] of Object.entries(clients)) {
        // Approval rows in the subscription need operator.approvals.
        await op.request("sessions.messages.subscribe", {
          key,
          ...(name === "approvals" ? { includeApprovals: true } : {}),
        });
      }
      return key;
    },
    async start(client: ClientName, key: string, message: string, extra: JsonRecord = {}) {
      const op = clients[client];
      const from = op.lastSeq;
      LEDGER.add(key);
      const sent = await op.send(key, message, extra);
      expect(
        typeof sent.runId === "string" && sent.runId,
        `chat.send returned no run id: ${JSON.stringify(sent)}`,
      );
      return new RunView(op, sent.runId, key, from);
    },
    async wait(view: RunView, timeoutMs = 60_000) {
      await view.op.terminal(view.runId, timeoutMs);
      // Late events of the same run (a stopped tool's result) arrive just after.
      await sleep(300);
      view.validate();
      return view;
    },
    async run(client: ClientName, key: string, message: string, extra: JsonRecord = {}) {
      return harness.wait(await harness.start(client, key, message, extra));
    },
    observe: (line: string) => notes.push(line),
    async offeredTools(key: string) {
      expect(providerUrl, "this harness does not know the scripted server");
      const response = await fetch(
        `${providerUrl}${OFFERED_TOOLS_PATH}?session=${encodeURIComponent(key)}`,
      );
      return ((await response.json()) as { tools: string[] | null }).tools;
    },
    async quietTurns(key: string) {
      expect(providerUrl, "this harness does not know the scripted server");
      const response = await fetch(
        `${providerUrl}${QUIET_TURNS_PATH}?session=${encodeURIComponent(key)}`,
      );
      return ((await response.json()) as { prompts: string[] }).prompts;
    },
    async ownerRun(botId: string, key: string, message: string) {
      expect(ownerAgent, "this harness cannot start a run as the owner");
      const op = clients.plain;
      const from = op.lastSeq;
      LEDGER.add(key);
      const done = ownerAgent(botId, key, message);
      const first = await op.waitFor(
        `the owner's run in ${key}`,
        (e) => e.event === "chat" && rec(e.payload).sessionKey === key,
        60_000,
        from,
      );
      await done;
      return harness.wait(new RunView(op, String(rec(first.payload).runId), key, from));
    },
  };
  return harness;
}

/** Open the three clients of the check on an instance, each paired with its own device. */
export async function openCheckClients(
  open: (name: string, scopes: string[], caps: string[]) => Promise<OperatorSession>,
): Promise<Record<ClientName, OperatorSession>> {
  const clients: Partial<Record<ClientName, OperatorSession>> = {};
  for (const name of Object.keys(CLIENTS) as ClientName[]) {
    clients[name] = await open(
      `Clawtrate scenario check (${name})`,
      CLIENTS[name].scopes,
      CLIENTS[name].caps,
    );
  }
  return clients as Record<ClientName, OperatorSession>;
}

/** Run one message as the gateway's owner, with `openclaw agent` through the guarded runner. */
export async function ownerAgent(
  inst: { runner: { run(args: string[]): Promise<{ status: number | null; stderr: string }> } },
  botId: string,
  key: string,
  message: string,
): Promise<void> {
  const out = await inst.runner.run([
    "agent",
    "--agent",
    botId,
    "--session-key",
    key,
    "--message",
    message,
    "--thinking",
    "low",
    "--json",
  ]);
  expect(out.status === 0, `openclaw agent failed: ${out.stderr.slice(0, 300)}`);
}
