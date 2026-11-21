// The Work pane's Computer tab (docs/design/work-pane.md, Part 3): the bot's
// browser through Clawtrate's computer plugin (plugins/clawtrate-computer),
// watched and taken over by one viewer at a time.
//
// What the engine keeps, and where:
//
// - In the state (`ClawtrateState.computer`, bounded in `state-bounds.ts`):
//   whether the gateway's hello lists the plugin, the latest control event of
//   each bot's tab (every reader receives them), and each viewer's pane: the
//   task it shows, what the plugin answered for that task's bot, its tabs, its
//   view and its control, as codes and plain facts.
// - In this class only, never in the state: a view's ticket (a bearer
//   capability: whoever presents it gets the stream), its stream socket, the
//   newest frame not yet drawn, the lease's generation, input waiting to be
//   sent and an answer waiting behind a release. None of it is logged.
//
// Frames travel from the plugin's stream, which this host opens with the
// ticket, to the viewer by its own request (`frame`): the host keeps only the
// newest frame of each view and answers a viewer's request with it once it is
// newer than the one the viewer drew last. A viewer that draws slowly gets
// fewer frames; nothing queues.

import { toBase64 } from "./bytes.ts";
import {
  MAX_COMPUTER_PANES,
  MAX_COMPUTER_TABS,
  MAX_COMPUTER_TEXT,
  MAX_CONTROL_RECORDS,
  MAX_STOPPED_RUNS,
} from "./computer-limits.ts";
import type { WebSocketLike } from "./host.ts";
import { asRecord, botIdFromSessionKey, type RawRecord } from "./mapping.ts";
import { isTerminal, type QuestionAnswer, type QuestionCard, type Run } from "./runs.ts";

// What the plugin is and what it promises (plugins/clawtrate-computer/README.md) -----------

export const COMPUTER_PREFIX = "clawtrate-computer.";
/** The method whose presence in `hello-ok.features.methods` says the plugin is loaded. */
export const COMPUTER_TABS_METHOD = "clawtrate-computer.tabs";
export const CONTROL_EVENT = "plugin.clawtrate-computer.control";
export const STREAM_PATH = "/clawtrate-computer/stream";

// Bounds ---------------------------------------------------------------------------------------

// The limits the state's schema reads live in `computer-limits.ts`, so `state-bounds.ts` can read
// them while this file is still loading (it imports `runs.ts`, which imports `state-bounds.ts`).
export {
  MAX_COMPUTER_PANES,
  MAX_COMPUTER_TABS,
  MAX_COMPUTER_TEXT,
  MAX_CONTROL_RECORDS,
  MAX_STOPPED_RUNS,
};
/** The largest frame kept for a viewer: a bigger one is dropped and counted. */
export const MAX_FRAME_BYTES = 180_000;
/** Input calls waiting to go out, one at a time; past it new input is dropped. */
export const MAX_QUEUED_INPUTS = 32;
/** Characters of one text input call (the plugin takes 1 to 2000). */
export const MAX_INPUT_TEXT = 2000;
/** How often a view and a held tab are renewed, at most (the plugin asks for well within `renewWithinMs`). */
export const RENEW_EVERY_MS = 5_000;

/** What the conversation's Stop answers for a task (`ComputerContext.stopTask`). */
export type StopAnswer = {
  /** The runs it asked the gateway to stop. */
  runIds: string[];
  /**
   * With no run to name, `chat.abort` for the task: whether it aborted anything, or null when its
   * answer didn't say; null too when runs were named.
   */
  aborted: boolean | null;
};

export type ComputerStop = {
  /** On its way. */
  sending: boolean;
  runIds: string[];
  aborted: boolean | null;
  /** The request itself failed. */
  error: string | null;
};

/**
 * Where a "Stop <Bot> in this task" is, from the runs it named as the task holds them: stopped
 * only once each run's own end says so, not when this client inferred it (`outcomeKnown`). A
 * refused stop puts the run back to running with its error (`revertStop`); an abort that
 * aborted nothing is no stop.
 */
export function stopProgress(
  stop: ComputerStop | null,
  runs: readonly Pick<Run, "id" | "state" | "stopError" | "outcomeKnown">[],
):
  | { kind: "none" }
  | { kind: "sending" | "stopping" | "stopped" | "ended" | "nothing" | "accepted" | "unconfirmed" }
  | { kind: "refused"; error: string } {
  if (!stop) return { kind: "none" };
  if (stop.sending) return { kind: "sending" };
  if (stop.error) return { kind: "refused", error: stop.error };
  if (stop.runIds.length === 0)
    return {
      kind: stop.aborted === true ? "accepted" : stop.aborted === false ? "nothing" : "unconfirmed",
    };
  const named = stop.runIds.map((id) => runs.find((run) => run.id === id));
  const refused = named.find((run) => run && !isTerminal(run.state) && run.stopError);
  if (refused) return { kind: "refused", error: refused.stopError! };
  if (named.some((run) => !run || !isTerminal(run.state))) return { kind: "stopping" };
  return named.every((run) => run!.state === "stopped" && run!.outcomeKnown)
    ? { kind: "stopped" }
    : { kind: "ended" };
}
/**
 * The share of the lease's deadline (`renewWithinMs`) after the last confirmed renewal at which
 * "You have control" stops being said here: shorter than the lease, so it never outlives it.
 */
export const CONFIRM_WITHIN = 0.75;
/** A release with no answer within this is "not confirmed". */
export const RELEASE_DEADLINE_MS = 10_000;
/** A renewal or a check with no answer within this changes nothing. */
export const RENEW_DEADLINE_MS = 5_000;
/** A viewer's frame request waits at most this long, then answers with no frame. */
export const FRAME_WAIT_MS = 15_000;
/** Busy refusals for the same reason in a row before the tab offers to stop the task. */
export const STUCK_AFTER = 3;

// The state ------------------------------------------------------------------------------------

export type ComputerLease = {
  state: "draining" | "granted";
  /** Who holds it as this viewer can tell: this viewer, another window of this app, or another device. */
  holder: "this-viewer" | "this-device" | "elsewhere";
};

export type ComputerTab = {
  targetId: string;
  url: string;
  title: string;
  lease: ComputerLease | null;
};

/**
 * What the plugin answered for the task's bot: `ready` when it listed the
 * bot's browser; `absent` when the hello lists no plugin; `not-configured`
 * (`UNAVAILABLE bot_not_configured`); `not-allowed` (`FORBIDDEN
 * SESSION_RESOURCE_TOOL_POLICY`: the task's policy denies the browser);
 * `read-only` when this connection cannot send, so nothing is asked;
 * `error` for any other refusal, with its reason.
 */
export type ComputerAvailability =
  | "unknown"
  | "checking"
  | "ready"
  | "absent"
  | "not-configured"
  | "not-allowed"
  | "read-only"
  | "error";

export type ViewEnd =
  "stopped" | "tab-closed" | "browser-gone" | "gateway-ended" | "dropped" | "failed";

export type ComputerView = {
  /** This view's number on this device: every answer for it is matched to it. */
  n: number;
  targetId: string;
  status: "connecting" | "live" | "ended";
  end: ViewEnd | null;
  error: string | null;
  /** The page's address and title, from the stream's `ready` and `meta` and the tab list. */
  url: string | null;
  title: string | null;
  /** The newest frame's number; 0 before the first. */
  frame: number;
  /** The page's own size in CSS pixels, from the newest frame's header. */
  width: number | null;
  height: number | null;
  /** Frames dropped for being larger than `MAX_FRAME_BYTES`. */
  framesTooLarge: number;
  /**
   * When the browser captured the newest usable frame, as the plugin sends it (the
   * screencast's own time), in ms; null when it sent none.
   */
  capturedAt: number | null;
  /** When this host received that frame, on this host's clock; null before the first. */
  frameAt: number | null;
};

export type BusyReason =
  | "bot-still-acting"
  | "bot-calls-unconfirmed"
  | "browser-not-quiet"
  | "download-in-progress"
  | "browser-not-watched";

const BUSY_REASONS: readonly BusyReason[] = [
  "bot-still-acting",
  "bot-calls-unconfirmed",
  "browser-not-quiet",
  "download-in-progress",
  "browser-not-watched",
];

/** Why a question closed while an answer or the person's control waited on it. */
export type ClosedCode = "answered" | "dismissed" | "cancelled" | "expired" | "run-ended";

export type ComputerOutcome =
  | "answered"
  | "answer-failed"
  | "already-answered"
  | "already-dismissed"
  | "already-cancelled"
  | "already-expired"
  | "answer-not-sent"
  /** Whether the question was still pending couldn't be read: the answer wasn't sent. */
  | "question-unknown"
  | "dropped-answered"
  | "dropped-dismissed"
  | "dropped-cancelled"
  | "dropped-expired"
  | "dropped-run-ended";

export type ControlStatus =
  /** Nothing asked or held. */
  | "none"
  /** A take is waiting for the bot's call and the tab to be quiet. */
  | "draining"
  /** The gateway granted control, and each renewal confirms it. */
  | "granted"
  /**
   * A renewal was refused or not answered, or none confirmed the lease within
   * `CONFIRM_WITHIN`: input has stopped, and whether control is still held is not
   * known until a renewal or Check reads it.
   */
  | "unverified"
  /** Refused: the bot is still acting (a call of its own was running at the drain deadline). */
  | "busy"
  /** Refused for any other reason: something has not settled, or could not be confirmed. */
  | "unsettled"
  /** Refused: someone has, or is taking, control of the tab. */
  | "conflict"
  /** A control event for this lease, or a renewal, says it ended. */
  | "ended"
  /** `control.release` is on its way: input has stopped. */
  | "releasing"
  /** The release was refused or not answered: ownership is not confirmed. */
  | "unconfirmed"
  /** The connection dropped while control was held or being given back. */
  | "maybe-held"
  /** Reconnected after that: the question and the browser's leases are being read again. */
  | "checking"
  /** The release was confirmed and the queued answer is on its way. */
  | "answering";

export type ComputerControl = {
  status: ControlStatus;
  /** The task and tab the control is about; it can outlive the pane's task (`outOfSight`). */
  key: string | null;
  botId: string | null;
  targetId: string | null;
  endCause: "expired" | "revoked" | null;
  busyReason: BusyReason | null;
  /** Busy refusals for `busyReason` in a row. */
  busyCount: number;
  renewWithinMs: number | null;
  /** The viewer left while ownership was not confirmed: renewals have stopped. */
  outOfSight: boolean;
  /** A check found the lease renewed: "You still have control." */
  stillHeld: boolean;
  /** How the answer that followed the release ended, or why it was not sent. */
  outcome: ComputerOutcome | null;
  /** The question closed while the person held control. */
  questionGone: ClosedCode | null;
  /** An answer waits behind the release. */
  answerQueued: boolean;
  /** Control was given back, confirmed, with no answer behind it: a pending question still waits. */
  released: boolean;
  /** A refusal the plugin gave that has no sentence of its own, with its reason. */
  refusal: string | null;
};

export type ComputerPane = {
  viewer: string;
  key: string;
  botId: string;
  availability: ComputerAvailability;
  /** The plugin's refusal, for `error`. */
  error: string | null;
  /**
   * `unknown` when the plugin couldn't look (its list timed out or failed): not the same as a
   * browser with no tabs.
   */
  browser: "running" | "not-running" | "unknown" | null;
  tabs: ComputerTab[];
  tabsOmitted: number;
  /** When the tab list was read. */
  checkedAt: number | null;
  /** The tab shown in the tile. */
  shown: string | null;
  view: ComputerView | null;
  control: ComputerControl;
  /** "Stop <Bot> in this task": what was asked and what the gateway answered (`stopProgress`). */
  stop: ComputerStop | null;
};

export type ControlRecord = {
  agentId: string;
  profile: string;
  targetId: string;
  holder: "user" | "bot";
  state: string;
  generation: string;
  reason: string | null;
  at: number;
};

export type ComputerState = {
  /** Whether the hello lists the plugin's methods; null before a hello. */
  plugin: boolean | null;
  /** The latest control event of each bot's tab, newest last. */
  control: ControlRecord[];
  /** Each viewer's pane, by viewer id; a viewer's snapshot carries only its own. */
  panes: Record<string, ComputerPane>;
};

export const initialComputerState: ComputerState = { plugin: null, control: [], panes: {} };

const noControl: ComputerControl = {
  status: "none",
  key: null,
  botId: null,
  targetId: null,
  endCause: null,
  busyReason: null,
  busyCount: 0,
  renewWithinMs: null,
  outOfSight: false,
  stillHeld: false,
  outcome: null,
  questionGone: null,
  answerQueued: false,
  released: false,
  refusal: null,
};

// Reading the plugin's answers ------------------------------------------------------------------

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const cut = (value: string) =>
  value.length > MAX_COMPUTER_TEXT ? value.slice(0, MAX_COMPUTER_TEXT - 1) + "…" : value;
const GENERATION = /^[0-9a-f]{32}$/;
const TARGET = /^[A-Za-z0-9._-]{1,128}$/;

/** The gateway's code and the plugin's reason of a refused call. */
export function refusal(error: unknown): {
  code: string | null;
  reason: string | null;
  message: string;
} {
  const record = asRecord(error);
  const details = asRecord(record?.details);
  return {
    code: str(record?.gatewayCode) ?? str(record?.code),
    reason: str(details?.reason) ?? str(details?.code),
    message: cut(error instanceof Error ? error.message : (str(record?.message) ?? String(error))),
  };
}

/** The plugin's control event, or null for anything else. */
export function parseControlEvent(payload: unknown, at: number): ControlRecord | null {
  const p = asRecord(payload);
  const agentId = str(p?.agentId);
  const targetId = str(p?.targetId);
  const state = str(p?.state);
  const generation = str(p?.generation);
  if (!p || !agentId || !targetId || !TARGET.test(targetId) || !state || !generation) return null;
  if (!GENERATION.test(generation)) return null;
  return {
    agentId: cut(agentId),
    profile: cut(str(p.profile) ?? ""),
    targetId,
    holder: p.holder === "bot" ? "bot" : "user",
    state: cut(state),
    generation,
    reason: str(p.reason) ? cut(str(p.reason)!) : null,
    at,
  };
}

/** A stream frame: the 4-byte length, the JSON header, the JPEG. */
export function parseFrame(data: Uint8Array): {
  header: { url: string | null; cssWidth: number; cssHeight: number; capturedAt: number | null };
  jpeg: Uint8Array;
} | null {
  if (data.byteLength < 6) return null;
  const length = ((data[0]! << 24) | (data[1]! << 16) | (data[2]! << 8) | data[3]!) >>> 0;
  if (length === 0 || 4 + length >= data.byteLength) return null;
  let header: RawRecord | null;
  try {
    header = asRecord(JSON.parse(utf8Decode(data.subarray(4, 4 + length))));
  } catch {
    return null;
  }
  const width = header?.cssWidth;
  const height = header?.cssHeight;
  if (typeof width !== "number" || typeof height !== "number" || width <= 0 || height <= 0)
    return null;
  const jpeg = data.subarray(4 + length);
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
  // The screencast's time is seconds since the epoch; anything else is no capture time.
  const ts = header?.ts;
  const capturedAt =
    typeof ts === "number" && Number.isFinite(ts) && ts > 1e9 && ts < 1e11
      ? Math.round(ts * 1000)
      : null;
  return {
    header: { url: str(header?.url), cssWidth: width, cssHeight: height, capturedAt },
    jpeg,
  };
}

function utf8Decode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length;) {
    const a = bytes[i++]!;
    let code = a;
    if (a >= 0xf0)
      code =
        ((a & 7) << 18) |
        ((bytes[i++]! & 63) << 12) |
        ((bytes[i++]! & 63) << 6) |
        (bytes[i++]! & 63);
    else if (a >= 0xe0) code = ((a & 15) << 12) | ((bytes[i++]! & 63) << 6) | (bytes[i++]! & 63);
    else if (a >= 0xc0) code = ((a & 31) << 6) | (bytes[i++]! & 63);
    out += String.fromCodePoint(code);
  }
  return out;
}

/** Binary stream data as bytes, whatever the socket gives. */
function bytesOf(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

/**
 * The stream's address: the gateway's own origin and the plugin's path,
 * nothing else. A path that would leave the gateway's origin is refused, so
 * the ticket goes nowhere but the gateway that issued it.
 */
export function streamUrl(gatewayUrl: string, wsPath: string): string | null {
  if (!wsPath.startsWith(`${STREAM_PATH}?ticket=`) || wsPath.includes("#")) return null;
  const base = new URL(gatewayUrl);
  if (base.protocol !== "ws:" && base.protocol !== "wss:") return null;
  const url = new URL(wsPath, gatewayUrl);
  return url.host === base.host && url.protocol === base.protocol ? url.toString() : null;
}

/** Whether a question can be answered from the control bar: one question, one answer, two to four options. */
export function barAnswerable(question: QuestionCard | null): boolean {
  if (!question || question.status !== "pending" || !question.ordinary) return false;
  if (question.questions.length !== 1) return false;
  const item = question.questions[0]!;
  return (
    !item.multiSelect &&
    item.optionsOmitted === 0 &&
    item.options.length >= 2 &&
    item.options.length <= 4
  );
}

// The engine ----------------------------------------------------------------------------------

export type ComputerContext = {
  request(method: string, params: unknown): Promise<unknown>;
  /** A socket to the gateway's stream: binary frames as bytes. */
  openStream(url: string): WebSocketLike;
  gatewayUrl(): string | null;
  /** The connection is up and holds `operator.write`. */
  canWrite(): boolean;
  online(): boolean;
  now(): number;
  get(): ComputerState;
  set(next: ComputerState): void;
  /** The open task's pending question, if any. */
  pendingQuestion(key: string): QuestionCard | null;
  /** How a question of the task ended, if it did. */
  questionStatus(key: string, questionId: string): QuestionCard["status"] | null;
  answer(key: string, questionId: string, answers: Record<string, QuestionAnswer[]>): Promise<void>;
  /**
   * The conversation's Stop for the task's runs; which runs it asked to stop, or the abort's
   * answer. Asked for `owner`: withdrawn with it while it waits for write access.
   */
  stopTask(key: string, owner: object | null): Promise<StopAnswer>;
  log(level: "debug" | "info" | "warn" | "error", message: string): void;
};

type Timer = ReturnType<typeof setTimeout>;
type Input =
  | { kind: "click"; x: number; y: number }
  | { kind: "scroll"; x: number | null; y: number | null; deltaX: number; deltaY: number }
  | { kind: "text"; text: string };

/** A view as the host keeps it: its ticket, its socket and its newest frame stay here. */
type LiveView = {
  n: number;
  targetId: string;
  streamId: string | null;
  /** The bearer ticket, from `view.open` until the stream opens with it; never in the state. */
  ticket: string | null;
  socket: WebSocketLike | null;
  latest: {
    seq: number;
    width: number;
    height: number;
    capturedAt: number | null;
    jpeg: Uint8Array;
  } | null;
  waiter: { after: number; resolve: (frame: ComputerFrame | null) => void; timer: Timer } | null;
  ended: boolean;
  /** The view's own deadline, from `view.open` and every renewal's answer. */
  renewWithinMs: number;
};

/** A lease this viewer holds or is giving back; its generation stays here. */
type LiveLease = {
  key: string;
  botId: string;
  targetId: string;
  generation: string;
  renewWithinMs: number;
  /** The hand-back's number: a lost connection retires it as a whole. */
  sequence: number;
  inputs: Input[];
  sending: boolean;
  answer: { questionId: string; itemId: string; option: number } | null;
  /** Ends "You have control" when no renewal has confirmed the lease for a while (`armCutoff`). */
  cutoff: Timer | null;
  /**
   * When the request that last confirmed the lease was sent (this host's clock): a confirmation
   * from an earlier request is superseded, and changes nothing.
   */
  confirmedFrom: number;
};

type LiveTake = {
  n: number;
  key: string;
  botId: string;
  targetId: string;
  /**
   * What a withdrawal releases: a `draining` event's generation, once a tab read made after it
   * says this connection's request is the tab's (`mine`) and no other take of this app waits
   * for the same tab. The event goes to every reader, so alone it proves nothing.
   */
  generation: string | null;
  /** A `draining` event's generation not yet tied to this take. */
  candidate: string | null;
  /** The first tab read made after that event: only it, or a later one, can tie it. */
  candidateAfter: number;
  /** When the take was sent: a grant is confirmed from then on, at most (`confirm`). */
  sentAt: number;
  abandoned: boolean;
};

type Live = {
  viewer: string;
  view: LiveView | null;
  lease: LiveLease | null;
  take: LiveTake | null;
  renewTimer: Timer | null;
  /** The tab list read this pane asked for last; an older answer changes nothing. */
  tabsAsked: number;
  /** The Computer tab is in front of the person: false from `leave` until the next `show`. */
  shown: boolean;
  /** The answer on its way after a confirmed release, by its number; its result is its own. */
  answering: number | null;
  /**
   * After a take was refused as held (`conflict`): the first tab read that tells who holds the
   * tab now. Earlier reads say nothing of it.
   */
  conflictAfter: number;
  /** Counts each time this viewer was done with a tab (`closeTarget`): a Check sent before is retired. */
  closed: number;
  /** The latest read of the old lease's own task after a drop (`recoverLease`); older ones settle nothing. */
  recoverAsked: number;
};

export type ComputerFrame = {
  n: number;
  seq: number;
  width: number;
  height: number;
  /** When the browser captured it (ms), or null when the plugin sent no time. */
  capturedAt: number | null;
  jpeg: string;
};

/**
 * How long a picture is "Live" after the newest usable frame was drawn (and, when the plugin
 * sent one, after it was captured). The screencast sends a frame only when the page changes, so
 * a quiet page also becomes "Last picture" after this: Live is never said of a picture older.
 */
export const LIVE_FOR_MS = 10_000;

/**
 * What the shown picture is: Live while a usable frame was drawn within `LIVE_FOR_MS`, else the
 * last picture and its age, from the older of when it was captured and when it was drawn.
 * Frames too large or that could not be decoded are never drawn, so they count as none.
 */
export function pictureAge(
  drawn: { at: number; capturedAt: number | null } | null,
  now: number,
): { kind: "none" } | { kind: "live" } | { kind: "last"; ageMs: number } {
  if (!drawn) return { kind: "none" };
  const since = drawn.capturedAt === null ? drawn.at : Math.min(drawn.at, drawn.capturedAt);
  const ageMs = Math.max(0, now - since);
  return ageMs <= LIVE_FOR_MS ? { kind: "live" } : { kind: "last", ageMs };
}

/** The engine of every viewer's Computer tab. One per client. */
export class ComputerViews {
  /** Each viewer's live part, by viewer id (`MAX_COMPUTER_PANES`). */
  private readonly lives = new Map<string, Live>();
  private nextView = 0;
  private nextTake = 0;
  private nextSequence = 0;
  private nextViewer = 0;
  private readonly ctx: ComputerContext;

  constructor(ctx: ComputerContext) {
    this.ctx = ctx;
  }

  /** A new viewer id, for a bridge session. */
  newViewer(): string {
    this.nextViewer += 1;
    return `v${this.nextViewer}`;
  }

  // The shared part ---------------------------------------------------------------------------

  private write(change: (state: ComputerState) => ComputerState): void {
    this.ctx.set(change(this.ctx.get()));
  }

  private pane(viewer: string): ComputerPane | null {
    return this.ctx.get().panes[viewer] ?? null;
  }

  private patch(viewer: string, change: (pane: ComputerPane) => ComputerPane): void {
    this.write((state) => {
      const pane = state.panes[viewer];
      return pane ? { ...state, panes: { ...state.panes, [viewer]: change(pane) } } : state;
    });
  }

  private patchControl(viewer: string, change: Partial<ComputerControl>): void {
    this.patch(viewer, (pane) => ({ ...pane, control: { ...pane.control, ...change } }));
  }

  private patchView(viewer: string, n: number, change: Partial<ComputerView>): void {
    this.patch(viewer, (pane) =>
      pane.view && pane.view.n === n ? { ...pane, view: { ...pane.view, ...change } } : pane,
    );
  }

  /** The hello's methods: whether the plugin is loaded on this gateway. */
  hello(methods: readonly string[] | null): void {
    const plugin = methods === null ? null : methods.includes(COMPUTER_TABS_METHOD);
    this.write((state) => ({ ...state, plugin }));
    for (const live of this.lives.values()) void this.readTabs(live.viewer);
  }

  /** A control event, which every reader receives. */
  controlEvent(payload: unknown): void {
    const record = parseControlEvent(payload, this.ctx.now());
    if (!record) return;
    this.write((state) => {
      const rest = state.control.filter(
        (each) => !(each.agentId === record.agentId && each.targetId === record.targetId),
      );
      return { ...state, control: [...rest, record].slice(-MAX_CONTROL_RECORDS) };
    });
    for (const live of this.lives.values()) this.applyControl(live, record);
  }

  private applyControl(live: Live, record: ControlRecord): void {
    const pane = this.pane(live.viewer);
    if (!pane) return;
    const take = live.take;
    if (
      take &&
      take.generation === null &&
      record.state === "draining" &&
      record.agentId === take.botId &&
      record.targetId === take.targetId
    ) {
      // Every reader gets the event, another device's take as much as this one's: the
      // generation is this take's only once a read made after it says so (`readTabs`).
      take.candidate = record.generation;
      take.candidateAfter = live.tabsAsked + 1;
    }
    const lease = live.lease;
    if (lease && record.generation === lease.generation) {
      if (record.state === "released") {
        // A released event with this lease's generation confirms the hand-back.
        if (pane.control.status === "releasing" || pane.control.status === "unconfirmed")
          this.confirmed(live, lease.sequence);
        else if (pane.control.status !== "answering") this.leaseEnded(live, null);
      } else if (
        record.state === "expired" ||
        record.state === "revoked" ||
        record.state === "tab-closed"
      ) {
        this.leaseEnded(
          live,
          record.state === "expired" ? "expired" : record.state === "revoked" ? "revoked" : null,
        );
      }
    }
    // Tabs' leases change with every event: the pane's tab list follows.
    if (pane.botId === record.agentId) void this.readTabs(live.viewer);
  }

  // A viewer's pane ----------------------------------------------------------------------------

  /** The viewer shows the Computer tab for a task. Leaving another task first gives control back. */
  show(viewer: string, key: string): void {
    const botId = botIdFromSessionKey(key);
    if (!botId) throw new Error("This task's bot is not known.");
    const current = this.pane(viewer);
    if (current && current.key === key) {
      const again = this.lives.get(viewer);
      if (again) again.shown = true;
      void this.readTabs(viewer);
      return;
    }
    if (!this.lives.has(viewer) && this.lives.size >= MAX_COMPUTER_PANES)
      throw new Error(`At most ${MAX_COMPUTER_PANES} views can show a computer at once.`);
    if (current) this.leave(viewer);
    const live = this.lives.get(viewer) ?? {
      viewer,
      view: null,
      lease: null,
      take: null,
      renewTimer: null,
      tabsAsked: 0,
      shown: true,
      answering: null,
      conflictAfter: 0,
      closed: 0,
      recoverAsked: 0,
    };
    live.shown = true;
    this.lives.set(viewer, live);
    // Read after leaving: the hand-back leaving started is the one kept, and so is a lease a
    // drop left unknown: it stays this viewer's until a read of its own task settles it.
    const left = this.pane(viewer);
    const recovering =
      live.lease !== null &&
      (left?.control.status === "maybe-held" || left?.control.status === "checking");
    const kept = left?.control.outOfSight || recovering ? left!.control : noControl;
    this.write((state) => ({
      ...state,
      panes: {
        ...state.panes,
        [viewer]: {
          viewer,
          key,
          botId,
          availability: "unknown",
          error: null,
          browser: null,
          tabs: [],
          tabsOmitted: 0,
          checkedAt: null,
          shown: null,
          view: null,
          control: kept,
          stop: null,
        },
      },
    }));
    void this.readTabs(viewer);
  }

  /**
   * The viewer left the Computer tab, closed the pane, switched task or bot,
   * or its window was hidden: control is given back first, a waiting take is
   * withdrawn, and the view ends at once. A hand-back that is not confirmed
   * stays on the tab (`outOfSight`).
   */
  leave(viewer: string): void {
    const live = this.lives.get(viewer);
    if (!live) return;
    // Nothing starts a view or a take again until the tab is shown again.
    live.shown = false;
    this.closeTarget(live);
  }

  /**
   * Done with the tab this viewer was on: a waiting take is withdrawn, control is given back
   * first, and its view ends. A hand-back that is not confirmed stays on that tab (`outOfSight`).
   */
  private closeTarget(live: Live): void {
    const viewer = live.viewer;
    live.closed += 1;
    this.abandonTake(live);
    const pane = this.pane(viewer);
    if (live.lease && (pane?.control.status === "granted" || pane?.control.status === "unverified"))
      this.release(viewer, { leaving: true });
    else if (
      live.lease &&
      (pane?.control.status === "releasing" || pane?.control.status === "unconfirmed")
    )
      this.patchControl(viewer, { outOfSight: true });
    this.endView(live, "stopped", null);
    this.reschedule(live);
  }

  /** The viewer went away: everything it held goes, control given back as on leaving. */
  dispose(viewer: string): void {
    const live = this.lives.get(viewer);
    if (!live) return;
    this.leave(viewer);
    if (live.renewTimer) clearTimeout(live.renewTimer);
    live.renewTimer = null;
    this.lives.delete(viewer);
    this.write((state) => {
      const panes = { ...state.panes };
      delete panes[viewer];
      return { ...state, panes };
    });
  }

  /** Read the bot's tabs again (`clawtrate-computer.tabs`). */
  async readTabs(viewer: string): Promise<void> {
    const live = this.lives.get(viewer);
    const pane = this.pane(viewer);
    if (!live || !pane) return;
    const state = this.ctx.get();
    if (state.plugin === false) {
      this.patch(viewer, (p) => ({ ...p, availability: "absent" }));
      return;
    }
    if (!this.ctx.online()) return;
    if (!this.ctx.canWrite()) {
      // A read-only connection asks for none of the plugin's methods.
      this.patch(viewer, (p) => ({ ...p, availability: "read-only", tabs: [], shown: null }));
      return;
    }
    if (state.plugin === null) return;
    const asked = ++live.tabsAsked;
    const key = pane.key;
    if (pane.availability === "unknown")
      this.patch(viewer, (p) => ({ ...p, availability: "checking" }));
    let answer: RawRecord | null;
    try {
      answer = asRecord(await this.ctx.request("clawtrate-computer.tabs", { sessionKey: key }));
    } catch (error) {
      if (asked !== live.tabsAsked || this.pane(viewer)?.key !== key) return;
      const why = refusal(error);
      const availability: ComputerAvailability =
        why.code === "UNAVAILABLE" && why.reason === "bot_not_configured"
          ? "not-configured"
          : why.code === "FORBIDDEN" && why.reason === "SESSION_RESOURCE_TOOL_POLICY"
            ? "not-allowed"
            : why.reason === "MISSING_SCOPE"
              ? "read-only"
              : "error";
      this.patch(viewer, (p) => ({
        ...p,
        availability,
        error: availability === "error" ? why.message : null,
        checkedAt: this.ctx.now(),
      }));
      return;
    }
    if (asked !== live.tabsAsked || this.pane(viewer)?.key !== key) return;
    const raw = Array.isArray(answer?.tabs) ? answer.tabs : [];
    // `not-running` with a reason other than the browser not running: the plugin couldn't look.
    const reason = str(answer?.reason);
    const browser =
      answer?.browser === "running"
        ? ("running" as const)
        : reason && reason !== "browser_unavailable"
          ? ("unknown" as const)
          : ("not-running" as const);
    const tabs: ComputerTab[] = [];
    for (const each of raw) {
      const t = asRecord(each);
      const targetId = str(t?.targetId);
      if (!t || !targetId || !TARGET.test(targetId)) continue;
      const lease = asRecord(t.lease);
      tabs.push({
        targetId,
        url: cut(str(t.url) ?? ""),
        title: cut(str(t.title) ?? ""),
        lease:
          lease && (lease.state === "draining" || lease.state === "granted")
            ? {
                state: lease.state,
                holder:
                  lease.mine !== true
                    ? "elsewhere"
                    : live.lease?.targetId === targetId || live.take?.targetId === targetId
                      ? "this-viewer"
                      : "this-device",
              }
            : null,
      });
    }
    const kept = tabs.slice(0, MAX_COMPUTER_TABS);
    const before = this.pane(viewer)?.control;
    // After a refused take, only a read made since tells who holds the tab and how far.
    if (before?.status === "conflict" && asked < live.conflictAfter) {
      for (const tab of kept) if (tab.targetId === before.targetId) tab.lease = null;
    }
    this.patch(viewer, (p) => {
      const listed = (targetId: string | null | undefined) =>
        !!targetId && kept.some((tab) => tab.targetId === targetId);
      const watched = p.view && p.view.status !== "ended" ? p.view.targetId : null;
      // The tab Take asks for is the one in the picture: while a view is open its tab is the one
      // shown, even when a list leaves it out (a closed tab ends the view, then the list decides).
      const shown =
        watched ??
        (listed(p.shown)
          ? p.shown
          : (kept.find((tab) => !tab.url.startsWith("chrome://"))?.targetId ??
            kept[0]?.targetId ??
            null));
      const view = p.view;
      const tab = view ? kept.find((each) => each.targetId === view.targetId) : undefined;
      return {
        ...p,
        availability: "ready",
        error: null,
        browser,
        tabs: kept,
        tabsOmitted: tabs.length - kept.length,
        checkedAt: this.ctx.now(),
        shown,
        view: view && tab ? { ...view, title: tab.title || view.title } : view,
      };
    });
    this.afterTabs(live);
    // The tab's request or control ended since the take was refused: nothing holds it now.
    const now = this.pane(viewer)?.control;
    if (now?.status === "conflict" && asked >= live.conflictAfter) {
      if (!kept.find((tab) => tab.targetId === now.targetId)?.lease)
        this.patchControl(viewer, { status: "none" });
    }
    this.tieTake(live, asked, kept);
  }

  /**
   * A take's `draining` generation is its own once a read made after the event lists this
   * connection's request on the tab and no other viewer of this app waits for the same tab;
   * another device's request on the tab drops it. Only then can a withdrawal use it.
   */
  private tieTake(live: Live, asked: number, tabs: ComputerTab[]): void {
    const take = live.take;
    if (!take || !take.candidate || asked < take.candidateAfter) return;
    const lease = tabs.find((tab) => tab.targetId === take.targetId)?.lease;
    if (!lease) return;
    if (lease.holder === "elsewhere") {
      take.candidate = null;
      return;
    }
    const shared = [...this.lives.values()].some(
      (other) =>
        other !== live &&
        other.take !== null &&
        !other.take.abandoned &&
        other.take.botId === take.botId &&
        other.take.targetId === take.targetId,
    );
    if (lease.state !== "draining" || shared) return;
    take.generation = take.candidate;
    take.candidate = null;
    if (take.abandoned) this.withdraw(take);
  }

  /** After a reconnect, leases are read before anything is offered again. */
  private afterTabs(live: Live): void {
    const pane = this.pane(live.viewer);
    // Read while connected: what the list says of the old lease settles a drop's "maybe held".
    if (!pane || (pane.control.status !== "checking" && pane.control.status !== "maybe-held"))
      return;
    // The pane shows another task now: only a read of the lease's own task says anything of it.
    if (live.lease && live.lease.key !== pane.key) {
      void this.recoverLease(live);
      return;
    }
    // A lookup that couldn't see the browser lists nothing, which says nothing of the lease.
    if (pane.browser === "unknown") return;
    const tab = pane.tabs.find((each) => each.targetId === pane.control.targetId);
    // A new connection never holds the old one's lease: none listed, or one this connection
    // holds (another viewer of this app took the tab), means it ended.
    if (!tab?.lease || tab.lease.holder !== "elsewhere") {
      live.lease = null;
      this.patchControl(live.viewer, { ...noControl, status: "ended" });
      // The tab's holder, read while the old lease was still counted as this viewer's.
      if (tab?.lease?.holder === "this-viewer")
        this.patch(live.viewer, (p) => ({
          ...p,
          tabs: p.tabs.map((each) =>
            each === tab ? { ...each, lease: { ...tab.lease!, holder: "this-device" } } : each,
          ),
        }));
    } else this.patchControl(live.viewer, { status: "maybe-held" });
  }

  /**
   * After a drop, with the pane on another task since: the old lease's own task is read and
   * settles it as `afterTabs` would. A refusal, or a lookup that couldn't see the browser,
   * settles nothing; the next tab read asks again.
   */
  private async recoverLease(live: Live): Promise<void> {
    const lease = live.lease;
    if (!lease || !this.ctx.online() || !this.ctx.canWrite()) return;
    const asked = ++live.recoverAsked;
    let answer: RawRecord | null;
    try {
      answer = asRecord(
        await this.ctx.request("clawtrate-computer.tabs", { sessionKey: lease.key }),
      );
    } catch {
      return;
    }
    const now = this.pane(live.viewer)?.control;
    if (asked !== live.recoverAsked || live.lease !== lease) return;
    if (!now || (now.status !== "checking" && now.status !== "maybe-held")) return;
    const reason = str(answer?.reason);
    if (answer?.browser !== "running" && reason && reason !== "browser_unavailable") return;
    const raw = Array.isArray(answer?.tabs) ? answer.tabs : [];
    const tab = raw.map(asRecord).find((each) => str(each?.targetId) === lease.targetId);
    const held = asRecord(tab?.lease);
    // A new connection never holds the old one's lease: only another holder keeps it unknown.
    if (held && (held.state === "draining" || held.state === "granted") && held.mine !== true)
      this.patchControl(live.viewer, { status: "maybe-held" });
    else {
      live.lease = null;
      this.patchControl(live.viewer, { ...noControl, status: "ended" });
    }
  }

  /** Show another tab of the bot's browser in the tile: the view of the old one ends first. */
  choose(viewer: string, targetId: string): void {
    const live = this.lives.get(viewer);
    const pane = this.pane(viewer);
    if (!live || !pane || !pane.tabs.some((tab) => tab.targetId === targetId)) return;
    const watching = pane.view && pane.view.status !== "ended";
    // The old tab's view, take and control end; the Computer tab stays shown, so the new tab
    // can be watched and taken at once.
    if (
      (pane.view && pane.view.targetId !== targetId) ||
      (live.lease && live.lease.targetId !== targetId) ||
      (live.take && live.take.targetId !== targetId)
    )
      this.closeTarget(live);
    // An ended view of the old tab says nothing of the new one: no view is open there.
    if (live.view && live.view.targetId !== targetId) live.view = null;
    this.patch(viewer, (p) => ({
      ...p,
      shown: targetId,
      view: p.view && p.view.targetId !== targetId ? null : p.view,
    }));
    if (watching) void this.watch(viewer);
  }

  // Watching ----------------------------------------------------------------------------------

  /** Watch: a new view with its own number. */
  async watch(viewer: string): Promise<void> {
    const live = this.lives.get(viewer);
    const pane = this.pane(viewer);
    if (!live || !live.shown || !pane || pane.availability !== "ready" || !pane.shown) return;
    if (!this.ctx.canWrite()) return;
    if (live.view && !live.view.ended && live.view.targetId === pane.shown) return;
    this.endView(live, "stopped", null);
    const n = ++this.nextView;
    const view: LiveView = {
      n,
      targetId: pane.shown,
      streamId: null,
      ticket: null,
      socket: null,
      latest: null,
      waiter: null,
      ended: false,
      renewWithinMs: 20_000,
    };
    live.view = view;
    const tab = pane.tabs.find((each) => each.targetId === view.targetId);
    this.patch(viewer, (p) => ({
      ...p,
      view: {
        n,
        targetId: view.targetId,
        status: "connecting",
        end: null,
        error: null,
        url: tab?.url ?? null,
        title: tab?.title ?? null,
        frame: 0,
        width: null,
        height: null,
        framesTooLarge: 0,
        capturedAt: null,
        frameAt: null,
      },
    }));
    let answer: RawRecord | null;
    try {
      answer = asRecord(
        await this.ctx.request("clawtrate-computer.view.open", {
          sessionKey: pane.key,
          targetId: view.targetId,
        }),
      );
    } catch (error) {
      if (live.view !== view || view.ended) return;
      const why = refusal(error);
      this.endView(
        live,
        why.reason === "tab_not_in_bots_browser" ? "tab-closed" : "failed",
        why.reason === "tab_not_in_bots_browser" ? null : why.message,
      );
      if (why.reason === "tab_not_in_bots_browser") void this.readTabs(viewer);
      return;
    }
    const wsPath = str(answer?.wsPath);
    const streamId = str(answer?.streamId);
    // An answer for a view that has ended is disposed of: its ticket is never used.
    if (live.view !== view || view.ended) return;
    const gateway = this.ctx.gatewayUrl();
    const url = wsPath && gateway ? streamUrl(gateway, wsPath) : null;
    if (!url || !streamId) {
      this.endView(live, "failed", "The plugin's answer gave no stream on this gateway.");
      return;
    }
    view.streamId = streamId;
    view.ticket = wsPath!.slice(wsPath!.indexOf("=") + 1);
    const renew = Number(answer?.renewWithinMs);
    if (Number.isFinite(renew) && renew > 0) view.renewWithinMs = renew;
    this.openSocket(live, view, url);
    this.reschedule(live);
  }

  private openSocket(live: Live, view: LiveView, url: string): void {
    let socket: WebSocketLike;
    try {
      socket = this.ctx.openStream(url);
    } catch {
      this.endView(live, "failed", "The stream could not be opened.");
      return;
    }
    view.socket = socket;
    // The ticket opens one stream once: it is dropped as soon as it has been presented.
    view.ticket = null;
    socket.onmessage = (event) => {
      if (live.view !== view || view.ended) return;
      const data = event.data;
      if (typeof data === "string") {
        let message: RawRecord | null;
        try {
          message = asRecord(JSON.parse(data));
        } catch {
          return;
        }
        if (message?.type === "ready" || message?.type === "meta") {
          const url = str(message.url);
          const title = str(message.title);
          this.patchView(live.viewer, view.n, {
            ...(url !== null ? { url: cut(url) } : {}),
            ...(title !== null ? { title: cut(title) } : {}),
          });
          // `meta` carries the address only: the title comes from the tab list.
          if (message.type === "meta") void this.readTabs(live.viewer);
        }
        return;
      }
      const bytes = bytesOf(data);
      const frame = bytes ? parseFrame(bytes) : null;
      if (!frame) return;
      const pane = this.pane(live.viewer);
      const current = pane?.view?.n === view.n ? pane.view : null;
      if (!current) return;
      if (frame.jpeg.byteLength > MAX_FRAME_BYTES) {
        this.patchView(live.viewer, view.n, { framesTooLarge: current.framesTooLarge + 1 });
        return;
      }
      const seq = current.frame + 1;
      // Only the newest frame is kept; one not yet drawn gives way to it.
      view.latest = {
        seq,
        width: frame.header.cssWidth,
        height: frame.header.cssHeight,
        capturedAt: frame.header.capturedAt,
        jpeg: frame.jpeg.slice(),
      };
      this.patchView(live.viewer, view.n, {
        status: "live",
        frame: seq,
        width: frame.header.cssWidth,
        height: frame.header.cssHeight,
        capturedAt: frame.header.capturedAt,
        frameAt: this.ctx.now(),
        ...(frame.header.url ? { url: cut(frame.header.url) } : {}),
      });
      this.giveFrame(view);
    };
    socket.onclose = (event) => {
      if (live.view !== view || view.ended) return;
      const end: ViewEnd =
        event.code === 4004 ? "tab-closed" : event.code === 1011 ? "browser-gone" : "gateway-ended";
      this.endView(live, end, null);
      if (end === "tab-closed") void this.readTabs(live.viewer);
    };
    socket.onerror = () => {};
  }

  /** Stop watching: the view ends, and nothing of the picture remains. */
  stopWatching(viewer: string): void {
    const live = this.lives.get(viewer);
    if (!live) return;
    const pane = this.pane(viewer);
    const status = pane?.control.status;
    if (status === "draining") this.abandonTake(live);
    // Anything this viewer may hold goes back, and nothing renews it any more.
    if (live.lease && (status === "granted" || status === "unverified" || status === "unconfirmed"))
      this.release(viewer, { leaving: true });
    this.endView(live, "stopped", null);
    this.reschedule(live);
  }

  private endView(live: Live, end: ViewEnd, error: string | null): void {
    const view = live.view;
    if (!view || view.ended) return;
    view.ended = true;
    view.ticket = null;
    view.latest = null;
    if (view.waiter) {
      clearTimeout(view.waiter.timer);
      view.waiter.resolve(null);
      view.waiter = null;
    }
    if (view.socket) {
      const socket = view.socket;
      view.socket = null;
      socket.onmessage = null;
      socket.onclose = null;
      try {
        socket.close(1000);
      } catch {
        // Already closed.
      }
    }
    this.patch(live.viewer, (p) =>
      p.view && p.view.n === view.n
        ? end === "stopped"
          ? { ...p, view: null }
          : { ...p, view: { ...p.view, status: "ended", end, error, frame: 0 } }
        : p,
    );
  }

  /**
   * The newest frame of a view, once newer than `after`; null when the view
   * has ended, is not this viewer's, or nothing newer came within `FRAME_WAIT_MS`.
   */
  frame(viewer: string, n: number, after: number): Promise<ComputerFrame | null> {
    const view = this.lives.get(viewer)?.view;
    if (!view || view.n !== n || view.ended) return Promise.resolve(null);
    if (view.latest && view.latest.seq > after) return Promise.resolve(this.frameOf(view));
    if (view.waiter) {
      clearTimeout(view.waiter.timer);
      view.waiter.resolve(null);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (view.waiter?.resolve === resolve) view.waiter = null;
        resolve(null);
      }, FRAME_WAIT_MS);
      view.waiter = { after, resolve, timer };
    });
  }

  private frameOf(view: LiveView): ComputerFrame | null {
    const latest = view.latest;
    if (!latest) return null;
    // Handed over once: the host keeps no frame that has been drawn.
    view.latest = null;
    return {
      n: view.n,
      seq: latest.seq,
      width: latest.width,
      height: latest.height,
      capturedAt: latest.capturedAt,
      jpeg: toBase64(latest.jpeg),
    };
  }

  private giveFrame(view: LiveView): void {
    const waiter = view.waiter;
    if (!waiter || !view.latest || view.latest.seq <= waiter.after) return;
    view.waiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve(this.frameOf(view));
  }

  // Renewing ----------------------------------------------------------------------------------

  /** One timer per viewer renews its view and its lease together, while either is held. */
  private reschedule(live: Live): void {
    if (live.renewTimer) clearTimeout(live.renewTimer);
    live.renewTimer = null;
    const pane = this.pane(live.viewer);
    const viewing = live.view && !live.view.ended && live.view.streamId;
    const holding =
      live.lease && (pane?.control.status === "granted" || pane?.control.status === "unverified");
    if (!viewing && !holding) return;
    // Well within the shorter of the two deadlines: the view's and the held tab's.
    const within = Math.min(
      viewing ? live.view!.renewWithinMs : Infinity,
      holding ? live.lease!.renewWithinMs : Infinity,
    );
    const every = Math.max(1000, Math.min(RENEW_EVERY_MS, Math.floor(within / 4)));
    live.renewTimer = setTimeout(() => void this.renew(live), every);
  }

  private async renew(live: Live): Promise<void> {
    live.renewTimer = null;
    const pane = this.pane(live.viewer);
    if (!pane || !this.ctx.online()) return;
    const view = live.view && !live.view.ended && live.view.streamId ? live.view : null;
    const lease =
      live.lease && (pane.control.status === "granted" || pane.control.status === "unverified")
        ? live.lease
        : null;
    if (!view && !lease) return;
    const targetId = lease?.targetId ?? view!.targetId;
    const key = lease?.key ?? pane.key;
    const useView = view && view.targetId === targetId ? view : null;
    // The next renewal is timed from this one's start, so a slow answer never stretches the cadence.
    this.reschedule(live);
    const sentAt = this.ctx.now();
    try {
      const answer = asRecord(
        await deadline(
          this.ctx.request("clawtrate-computer.view.renew", {
            sessionKey: key,
            targetId,
            ...(useView ? { streamId: useView.streamId } : {}),
            ...(lease ? { generation: lease.generation } : {}),
          }),
          RENEW_DEADLINE_MS,
        ),
      );
      const within = Number(answer?.renewWithinMs);
      if (Number.isFinite(within) && within > 0) {
        if (useView) useView.renewWithinMs = within;
        if (lease) lease.renewWithinMs = within;
      }
      if (useView && live.view === useView && !useView.ended && answer?.streamRenewed !== true)
        this.endView(live, "gateway-ended", null);
      // "You have control" holds only while each renewal confirms the lease.
      const status = this.pane(live.viewer)?.control.status;
      if (lease && live.lease === lease && (status === "granted" || status === "unverified")) {
        const held = lease.confirmedFrom > 0;
        if (answer?.leaseRenewed !== true) this.leaseEnded(live, null);
        else if (this.confirm(live, lease, sentAt) && status === "unverified") {
          this.patchControl(live.viewer, { status: "granted", stillHeld: held });
          this.reschedule(live);
        }
        // A confirmation that came too late, or that a later one already gave, changes nothing.
      }
    } catch (error) {
      const why = refusal(error);
      if (why.reason === "tab_not_in_bots_browser") {
        if (useView && live.view === useView) this.endView(live, "tab-closed", null);
        if (lease && live.lease === lease) this.leaseEnded(live, null);
        void this.readTabs(live.viewer);
        return;
      }
      // Refused for another reason, or not answered: nothing confirms the lease now, unless a
      // request sent after this one already confirmed it.
      if (lease && live.lease === lease && sentAt >= lease.confirmedFrom)
        this.unverified(live, lease);
    }
  }

  /**
   * A confirmation of the lease (a grant, a renewal or a check) by a request sent at `sentAt`.
   * The gateway's deadline runs from when it handled that request, which is no earlier than when
   * it was sent: so here control counts as confirmed until `CONFIRM_WITHIN` of the deadline after
   * the request was sent. Then input stops and the bar says control isn't confirmed, before the
   * gateway's own expiry (or its event) could arrive. A confirmation that arrives after that,
   * or from a request older than one that already confirmed it, changes nothing: false.
   */
  private confirm(live: Live, lease: LiveLease, sentAt: number): boolean {
    if (sentAt < lease.confirmedFrom) return false;
    const left = sentAt + Math.floor(lease.renewWithinMs * CONFIRM_WITHIN) - this.ctx.now();
    if (left <= 0) return false;
    lease.confirmedFrom = sentAt;
    if (lease.cutoff) clearTimeout(lease.cutoff);
    lease.cutoff = setTimeout(() => {
      lease.cutoff = null;
      if (live.lease === lease) this.unverified(live, lease);
    }, left);
    return true;
  }

  /** Control is not confirmed: input stops now; renewals go on, and Check reads it. */
  private unverified(live: Live, lease: LiveLease): void {
    if (this.pane(live.viewer)?.control.status !== "granted") return;
    lease.inputs.length = 0;
    this.patchControl(live.viewer, { status: "unverified", stillHeld: false });
    this.reschedule(live);
  }

  // Taking control ----------------------------------------------------------------------------

  /** Take control of the shown tab; the view opens first if it was not open. */
  async take(viewer: string): Promise<void> {
    const live = this.lives.get(viewer);
    const pane = this.pane(viewer);
    if (!live || !live.shown || !pane || !pane.shown || !this.ctx.canWrite()) return;
    if (live.lease || live.take) return;
    if (!live.view || live.view.ended) void this.watch(viewer);
    const n = ++this.nextTake;
    const take: LiveTake = {
      n,
      key: pane.key,
      botId: pane.botId,
      targetId: pane.shown,
      generation: null,
      candidate: null,
      candidateAfter: 0,
      sentAt: this.ctx.now(),
      abandoned: false,
    };
    live.take = take;
    const before = pane.control;
    this.patchControl(viewer, {
      ...noControl,
      status: "draining",
      key: pane.key,
      botId: pane.botId,
      targetId: pane.shown,
      busyReason: before.busyReason,
      busyCount: before.busyCount,
    });
    let answer: RawRecord | null;
    try {
      answer = asRecord(
        await this.ctx.request("clawtrate-computer.control.take", {
          sessionKey: take.key,
          targetId: take.targetId,
        }),
      );
    } catch (error) {
      if (live.take === take) live.take = null;
      if (take.abandoned || this.pane(viewer)?.control.status !== "draining") return;
      const why = refusal(error);
      if (why.reason === "control_held") {
        // Someone has, or is asking for, control of the tab: who, and how far, only a read
        // made from now on can tell. Until then the bar says the tab has a request.
        live.conflictAfter = live.tabsAsked + 1;
        this.patch(viewer, (p) => ({
          ...p,
          control: { ...p.control, status: "conflict" },
          tabs: p.tabs.map((tab) =>
            tab.targetId === take.targetId ? { ...tab, lease: null } : tab,
          ),
        }));
        void this.readTabs(viewer);
      } else if (why.reason === "control_request_ended")
        this.patchControl(viewer, { status: "none" });
      else if (why.reason === "tab_not_in_bots_browser") {
        this.patchControl(viewer, { status: "none" });
        if (live.view) this.endView(live, "tab-closed", null);
        void this.readTabs(viewer);
      } else this.patchControl(viewer, { status: "none", refusal: why.message });
      return;
    }
    if (live.take === take) live.take = null;
    const generation = str(answer?.generation);
    if (answer?.state === "granted" && generation && GENERATION.test(generation)) {
      const renewWithinMs = Number(answer.renewWithinMs);
      if (take.abandoned || this.pane(viewer)?.control.status !== "draining") {
        // The grant won the race against a withdrawal: given back at once, no input, nothing shown.
        void this.ctx
          .request("clawtrate-computer.control.release", {
            sessionKey: take.key,
            targetId: take.targetId,
            generation,
          })
          .catch(() => {});
        return;
      }
      live.lease = {
        key: take.key,
        botId: take.botId,
        targetId: take.targetId,
        generation,
        renewWithinMs: Number.isFinite(renewWithinMs) && renewWithinMs > 0 ? renewWithinMs : 20_000,
        sequence: 0,
        inputs: [],
        sending: false,
        answer: null,
        cutoff: null,
        confirmedFrom: 0,
      };
      // Counted from when the take was sent: a grant that took longer than that allows is not
      // control yet; a renewal sent now confirms it, or doesn't.
      const counted = this.confirm(live, live.lease, take.sentAt);
      this.patchControl(viewer, {
        status: counted ? "granted" : "unverified",
        busyReason: null,
        busyCount: 0,
        renewWithinMs: live.lease.renewWithinMs,
      });
      if (counted) this.reschedule(live);
      else void this.renew(live);
      void this.readTabs(viewer);
      return;
    }
    if (take.abandoned || this.pane(viewer)?.control.status !== "draining") return;
    // The plugin's code is `cause`; its `reason` is the sentence. A code this
    // app does not know is kept as none, never as "still acting".
    const code = str(answer?.cause) ?? str(answer?.reason);
    const known = BUSY_REASONS.find((each) => each === code) ?? null;
    const previous = this.pane(viewer)?.control;
    // Only known causes count, and only the same one in a row.
    const count = known === null ? 0 : previous?.busyReason === known ? previous.busyCount + 1 : 1;
    this.patchControl(viewer, {
      status: known === "bot-still-acting" ? "busy" : "unsettled",
      busyReason: known,
      busyCount: count,
    });
  }

  /** Cancel a waiting take: withdrawn with the `draining` generation. */
  cancelTake(viewer: string): void {
    const live = this.lives.get(viewer);
    if (!live) return;
    this.abandonTake(live);
  }

  private abandonTake(live: Live): void {
    const take = live.take;
    if (!take || take.abandoned) return;
    take.abandoned = true;
    if (this.pane(live.viewer)?.control.status === "draining")
      this.patchControl(live.viewer, { status: "none" });
    this.withdraw(take);
  }

  private withdraw(take: LiveTake): void {
    if (!take.generation) return;
    void this.ctx
      .request("clawtrate-computer.control.release", {
        sessionKey: take.key,
        targetId: take.targetId,
        generation: take.generation,
      })
      .catch(() => {});
  }

  // Input --------------------------------------------------------------------------------------

  /**
   * Input from the person, for the held tab only, while this viewer holds the
   * lease. Sent one call at a time, in order; dropped, never sent, once
   * control is being given back or is not confirmed. Nothing of it is logged.
   */
  input(viewer: string, input: Input): boolean {
    const live = this.lives.get(viewer);
    const pane = this.pane(viewer);
    const lease = live?.lease;
    if (!live || !lease || pane?.control.status !== "granted") return false;
    // Only into the tab in the picture: a view of another tab than the one held takes nothing.
    if (live.view && !live.view.ended && live.view.targetId !== lease.targetId) return false;
    const last = lease.inputs.at(-1);
    if (
      input.kind === "text" &&
      last?.kind === "text" &&
      last.text.length + input.text.length <= MAX_INPUT_TEXT
    ) {
      last.text += input.text;
    } else {
      if (lease.inputs.length >= MAX_QUEUED_INPUTS) return false;
      // A copy: text typed next is added to it, never to the caller's own object.
      lease.inputs.push({ ...input });
    }
    void this.pump(live, lease);
    return true;
  }

  private async pump(live: Live, lease: LiveLease): Promise<void> {
    if (lease.sending) return;
    lease.sending = true;
    try {
      while (
        lease.inputs.length > 0 &&
        live.lease === lease &&
        this.pane(live.viewer)?.control.status === "granted"
      ) {
        const next = lease.inputs.shift()!;
        try {
          await this.ctx.request("clawtrate-computer.input", {
            sessionKey: lease.key,
            targetId: lease.targetId,
            generation: lease.generation,
            ...inputParams(next),
          });
        } catch (error) {
          lease.inputs.length = 0;
          if (refusal(error).reason === "not_holder" && live.lease === lease)
            this.leaseEnded(live, null);
          return;
        }
      }
    } finally {
      lease.sending = false;
    }
  }

  // Handing back ------------------------------------------------------------------------------

  /**
   * Give control back (`control.release` with the generation). With `answer`,
   * the question's option goes only once the release is confirmed.
   */
  release(
    viewer: string,
    options: {
      leaving?: boolean;
      answer?: { questionId: string; itemId: string; option: number };
    } = {},
  ): void {
    const live = this.lives.get(viewer);
    const pane = this.pane(viewer);
    const lease = live?.lease;
    if (!live || !lease || !pane) return;
    const status = pane.control.status;
    if (
      status !== "granted" &&
      status !== "unverified" &&
      status !== "unconfirmed" &&
      !(status === "releasing" && pane.control.outOfSight)
    )
      return;
    // Input stops at once and stays stopped until control is confirmed either way.
    lease.inputs.length = 0;
    lease.sequence = ++this.nextSequence;
    lease.answer = options.answer ?? null;
    const sequence = lease.sequence;
    this.patchControl(viewer, {
      status: "releasing",
      stillHeld: false,
      outcome: null,
      answerQueued: lease.answer !== null,
      outOfSight: options.leaving === true || pane.control.outOfSight,
    });
    // The lease is no longer renewed; a view still open is, while the release is on its way.
    this.reschedule(live);
    const notConfirmed = () => {
      if (live.lease !== lease || lease.sequence !== sequence) return;
      // A refusal does not prove the device still holds control: ownership is not confirmed.
      const queued = lease.answer !== null;
      lease.answer = null;
      this.patchControl(viewer, {
        status: "unconfirmed",
        answerQueued: false,
        outcome: queued ? "answer-not-sent" : (this.pane(viewer)?.control.outcome ?? null),
      });
      this.reschedule(live);
    };
    void (async () => {
      let reply: RawRecord | null;
      try {
        reply = asRecord(
          await deadline(
            this.ctx.request("clawtrate-computer.control.release", {
              sessionKey: lease.key,
              targetId: lease.targetId,
              generation: lease.generation,
            }),
            RELEASE_DEADLINE_MS,
          ),
        );
      } catch {
        notConfirmed();
        return;
      }
      // Only the plugin's answer for this very lease confirms it.
      if (
        reply?.state !== "released" ||
        reply.generation !== lease.generation ||
        reply.targetId !== lease.targetId
      ) {
        notConfirmed();
        return;
      }
      this.confirmed(live, sequence);
    })();
  }

  /** The release was confirmed: by the call's success or a `released` event with this generation. */
  private confirmed(live: Live, sequence: number): void {
    const lease = live.lease;
    if (!lease || lease.sequence !== sequence) return;
    live.lease = null;
    const answer = lease.answer;
    const pane = this.pane(live.viewer);
    const outcome = pane?.control.outcome ?? null;
    if (!answer) {
      this.patchControl(live.viewer, {
        ...noControl,
        released: true,
        outcome: outcome && outcome.startsWith("dropped-") ? outcome : null,
      });
      this.reschedule(live);
      void this.readTabs(live.viewer);
      return;
    }
    const status = this.ctx.questionStatus(lease.key, answer.questionId);
    if (status !== "pending") {
      this.patchControl(live.viewer, {
        ...noControl,
        outcome: status === null ? "question-unknown" : alreadyOutcome(status),
      });
      // The release cleared the renewals: the view goes on being renewed.
      this.reschedule(live);
      return;
    }
    this.patchControl(live.viewer, { ...noControl, status: "answering" });
    const token = ++this.nextSequence;
    live.answering = token;
    // The answer's result belongs to this pane's task and this hand-back only: a pane shown for
    // another task since, or a take or release since, is never changed by it.
    const mine = () => {
      const pane = this.pane(live.viewer);
      return (
        live.answering === token &&
        pane?.key === lease.key &&
        pane.control.status === "answering" &&
        live.lease === null
      );
    };
    void this.ctx
      .answer(lease.key, answer.questionId, { [answer.itemId]: [{ option: answer.option }] })
      .then(
        () => {
          if (!mine()) return;
          live.answering = null;
          this.patchControl(live.viewer, { ...noControl, outcome: "answered" });
        },
        () => {
          if (!mine()) return;
          live.answering = null;
          const now = this.ctx.questionStatus(lease.key, answer.questionId);
          this.patchControl(live.viewer, {
            ...noControl,
            outcome: now && now !== "pending" ? alreadyOutcome(now) : "answer-failed",
          });
        },
      );
    this.reschedule(live);
  }

  /** "Check": renew with the generation. Renewed: still held. Not renewed: ended. */
  async check(viewer: string): Promise<void> {
    const live = this.lives.get(viewer);
    const lease = live?.lease;
    const control = this.pane(viewer)?.control;
    const checked = control?.status;
    if (!live || !lease || (checked !== "unconfirmed" && checked !== "unverified")) return;
    // Leaving the tab since retires the Check: a tab out of sight is not renewed again.
    const closed = live.closed;
    const sentAt = this.ctx.now();
    try {
      const answer = asRecord(
        await deadline(
          this.ctx.request("clawtrate-computer.view.renew", {
            sessionKey: lease.key,
            targetId: lease.targetId,
            generation: lease.generation,
          }),
          RENEW_DEADLINE_MS,
        ),
      );
      const now = this.pane(viewer)?.control;
      if (live.lease !== lease || now?.status !== checked || live.closed !== closed) return;
      if (answer?.leaseRenewed === true) {
        // Too late to count, or already confirmed by a later request: the line stays as it is.
        if (!this.confirm(live, lease, sentAt)) return;
        this.patchControl(viewer, { status: "granted", stillHeld: true, outOfSight: false });
        this.reschedule(live);
      } else this.leaseEnded(live, null);
    } catch (error) {
      // Retired as a reply is: a Check from before the viewer left, or from a state since
      // replaced (a later hand-back), ends nothing.
      const now = this.pane(viewer)?.control;
      if (live.lease !== lease || now?.status !== checked || live.closed !== closed) return;
      if (refusal(error).reason === "tab_not_in_bots_browser") this.leaseEnded(live, null);
      // Otherwise nothing is established: the line stays as it is.
    }
  }

  /** The lease ended, by an event for it or a renewal that did not renew it. */
  private leaseEnded(live: Live, cause: "expired" | "revoked" | null): void {
    const lease = live.lease;
    live.lease = null;
    if (lease) {
      lease.inputs.length = 0;
      lease.answer = null;
      if (lease.cutoff) clearTimeout(lease.cutoff);
      lease.cutoff = null;
    }
    const pane = this.pane(live.viewer);
    if (!pane) return;
    this.patchControl(live.viewer, {
      ...noControl,
      status: "ended",
      key: lease?.key ?? pane.control.key,
      botId: lease?.botId ?? pane.control.botId,
      targetId: lease?.targetId ?? pane.control.targetId,
      endCause: cause,
      outcome: pane.control.answerQueued ? "answer-not-sent" : null,
    });
    this.reschedule(live);
  }

  /** Clear an ended control's line, or an outcome, once the person has seen it. */
  dismiss(viewer: string): void {
    const pane = this.pane(viewer);
    if (!pane) return;
    const s = pane.control.status;
    if (s === "ended" || s === "busy" || s === "unsettled" || s === "conflict" || s === "none")
      this.patchControl(viewer, {
        ...noControl,
        busyReason: pane.control.busyReason,
        busyCount: pane.control.busyCount,
      });
  }

  // The question behind the control ---------------------------------------------------------

  /**
   * A question of a task closed, or its run ended: an answer queued for that very question is
   * removed, and the release goes on. Another question closing changes nothing of it.
   */
  questionClosed(key: string, questionId: string, code: ClosedCode): void {
    for (const live of this.lives.values()) {
      const pane = this.pane(live.viewer);
      const lease = live.lease;
      if (!pane || !lease || lease.key !== key) continue;
      if (lease.answer) {
        if (lease.answer.questionId !== questionId) continue;
        lease.answer = null;
        this.patchControl(live.viewer, {
          answerQueued: false,
          outcome: `dropped-${code}` as ComputerOutcome,
        });
      } else if (pane.control.status === "granted" && !this.ctx.pendingQuestion(key)) {
        // The bar shows the task's pending question: gone only once no question waits.
        this.patchControl(live.viewer, { questionGone: code });
      }
    }
  }

  // Recovery ----------------------------------------------------------------------------------

  /**
   * The connection dropped: every view ends, input stops, every queued step of
   * a hand-back is retired, and control held or being given back is "maybe held".
   */
  connectionLost(): void {
    for (const live of this.lives.values()) {
      if (live.take) live.take.abandoned = true;
      live.take = null;
      const pane = this.pane(live.viewer);
      const lease = live.lease;
      if (lease) {
        lease.inputs.length = 0;
        lease.answer = null;
        lease.sequence = ++this.nextSequence;
      }
      if (pane) {
        const s = pane.control.status;
        if (
          lease &&
          (s === "granted" ||
            s === "unverified" ||
            s === "releasing" ||
            s === "unconfirmed" ||
            s === "answering")
        )
          this.patchControl(live.viewer, {
            status: "maybe-held",
            outOfSight: false,
            answerQueued: false,
          });
        else if (s === "draining") this.patchControl(live.viewer, { status: "none" });
      }
      if (live.view && !live.view.ended) this.endView(live, "dropped", null);
      if (live.renewTimer) clearTimeout(live.renewTimer);
      live.renewTimer = null;
    }
  }

  /** Connected again: before offering anything, read the browser's leases again. */
  reconnected(): void {
    for (const live of this.lives.values()) {
      if (this.pane(live.viewer)?.control.status === "maybe-held")
        this.patchControl(live.viewer, { status: "checking" });
    }
  }

  /** Switching gateways: nothing of the old one carries over. */
  reset(): void {
    for (const live of this.lives.values()) {
      if (live.take) live.take.abandoned = true;
      live.take = null;
      live.lease = null;
      this.endView(live, "stopped", null);
      if (live.renewTimer) clearTimeout(live.renewTimer);
      live.renewTimer = null;
    }
    this.write((state) => ({
      plugin: null,
      control: [],
      panes: Object.fromEntries(
        Object.entries(state.panes).map(([id, pane]) => [
          id,
          {
            ...pane,
            availability: "unknown" as const,
            tabs: [],
            view: null,
            control: noControl,
            shown: null,
            // A Stop on the old gateway says nothing here; one still out changes nothing.
            stop: null,
          },
        ]),
      ),
    }));
  }

  // Stuck ---------------------------------------------------------------------------------------

  /**
   * "Stop <Bot> in this task", after its confirmation: the conversation's Stop. Only what the
   * gateway answers is kept; whether the runs stopped is read from the runs themselves.
   */
  async stopTask(viewer: string, owner: object | null = null): Promise<void> {
    const pane = this.pane(viewer);
    if (!pane) return;
    const key = pane.key;
    const sent: ComputerStop = { sending: true, runIds: [], aborted: null, error: null };
    this.patch(viewer, (p) => ({ ...p, stop: sent }));
    let stop: ComputerStop;
    try {
      const answer = await this.ctx.stopTask(key, owner);
      stop = {
        sending: false,
        runIds: answer.runIds.slice(0, MAX_STOPPED_RUNS),
        aborted: answer.aborted,
        error: null,
      };
    } catch (error) {
      stop = { sending: false, runIds: [], aborted: null, error: refusal(error).message };
    }
    // Its own pane's task only: a pane shown for another task since is not changed.
    this.patch(viewer, (p) => (p.key === key && p.stop === sent ? { ...p, stop } : p));
  }
}

function alreadyOutcome(status: QuestionCard["status"] | null): ComputerOutcome {
  return status === "dismissed"
    ? "already-dismissed"
    : status === "cancelled"
      ? "already-cancelled"
      : status === "expired"
        ? "already-expired"
        : "already-answered";
}

/** A request that gives up locally after `ms`; the gateway may still act on it. */
function deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no answer")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** An input as the plugin takes it: coordinates it was not given are left out. */
function inputParams(input: Input): RawRecord {
  if (input.kind !== "scroll") return input;
  return {
    kind: "scroll",
    ...(input.x !== null ? { x: input.x } : {}),
    ...(input.y !== null ? { y: input.y } : {}),
    deltaX: input.deltaX,
    deltaY: input.deltaY,
  };
}

/** Bounds for an input command from a viewer. */
export function parseInput(value: unknown): Input {
  const v = asRecord(value);
  const num = (x: unknown, min: number, max: number) => {
    if (typeof x !== "number" || !Number.isFinite(x) || x < min || x > max)
      throw new Error("invalid input");
    return Math.round(x * 100) / 100;
  };
  switch (v?.kind) {
    case "click":
      return { kind: "click", x: num(v.x, 0, 100_000), y: num(v.y, 0, 100_000) };
    case "scroll":
      return {
        kind: "scroll",
        x: v.x === null || v.x === undefined ? null : num(v.x, 0, 100_000),
        y: v.y === null || v.y === undefined ? null : num(v.y, 0, 100_000),
        deltaX: v.deltaX === undefined ? 0 : num(v.deltaX, -100_000, 100_000),
        deltaY: num(v.deltaY, -100_000, 100_000),
      };
    case "text":
      if (typeof v.text !== "string" || v.text.length === 0 || v.text.length > MAX_INPUT_TEXT)
        throw new Error("invalid input");
      return { kind: "text", text: v.text };
    default:
      throw new Error("invalid input");
  }
}

export type ComputerInput = Input;
