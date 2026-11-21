// The gateway connection and the state it projects. Built on the official
// browser-safe protocol client, with transport, storage and signing injected.

import { listMemory, readMemory, writeMemory } from "./memory.ts";
import {
  DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS,
  GatewayBrowserDeviceAuthLifecycle,
  GatewayProtocolClient,
  GatewayProtocolRequestError,
  PROTOCOL_VERSION,
  shouldPauseGatewayReconnect,
  type EventFrame,
  type GatewayBrowserDeviceAuthPlan,
  type GatewayBrowserDeviceTokenStore,
  type HelloOk,
} from "@openclaw/gateway-client/browser";
import { isRefusedDecision } from "./approval-refusals.ts";
import { chatSendParams, sendRefusal } from "./send-size.ts";
import { GatewayScopeUpgrade } from "@openclaw/gateway-client/scope-upgrade";
import {
  AccountsEngine,
  AdminNeededError,
  type CreateBotInput,
  type CreatedBot,
} from "./accounts-engine.ts";
import {
  dismissCheckInSave,
  loadCheckIns,
  saveCheckIn,
  type CheckInDraft,
  type CheckInsContext,
  type CheckInRead,
} from "./check-ins.ts";
import {
  RoutinesEngine,
  type BotRoutines,
  type CalendarRuns,
  type GatewayHooks,
  type NewRoutine,
  type Routine,
  type RoutineFields,
  type RoutineRevision,
  type RoutineRemove,
  type RoutineRun,
  type RoutineRunNow,
  type RoutineSaveCheck,
  type RoutineWrite,
  type RunConversation,
  type RunSelector,
} from "./routines.ts";
import {
  MachinesEngine,
  type ApprovalsFile,
  type BotPlacement,
  type ConfigSave,
  type DefaultsChoice,
  type MachinesView,
} from "./machines.ts";
import {
  admitApproval,
  applyApprovalRequested,
  applyApprovalResolved,
  APPROVAL_KINDS,
  decisionText,
  expireApprovals,
  attemptsOf,
  attemptsSettled,
  decisionRefusal,
  finishDecision,
  finishReadback,
  NO_ATTEMPTS,
  noteSent,
  patchError,
  readbackStillPending,
  reopenAttempts,
  sameAttempts,
  startDecision,
  startReadback,
  type ApprovalAttempts,
  mergeResolution,
  normalizeApprovals,
  parseApprovalResolved,
  parseExecApproval,
  parsePluginApproval,
  parseSystemAgentApproval,
  resolutionFromSnapshot,
  resolveRequest,
  settleUnlistedApprovals,
  type ApprovalAccess,
  type ApprovalCard,
  type ApprovalDecision,
  type ApprovalKind,
  type ApprovalResolution,
  type ApprovalSourceAccess,
} from "./approvals.ts";
import {
  interSessionMessages,
  linkedRunOf,
  builtinToolNames,
  mcpToolMap,
  recipientLinks,
  recipientRunIds,
  type LinkedRun,
} from "./cards.ts";
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  validateAttachmentMeta,
} from "./attachments.ts";
import { ChatTextBaselines } from "./chat-text.ts";
import {
  FileTransfers,
  listTaskFiles,
  listWorkspace,
  readCheckoutDiff,
  readTaskFile,
  readWorkspaceFile,
  type CheckoutDiff,
  type FileRead,
  type FileReaderContext,
  type TaskFileList,
  type WorkspacePage,
} from "./files.ts";
import type { ApprovalInstructions, ClawtrateHost } from "./host.ts";
import {
  asRecord,
  botIdFromSessionKey,
  groupTasks,
  isExcludedSessionKey,
  isSessionRemoval,
  isTaskSession,
  mapAgents,
  mapHistory,
  mergeSessionRow,
  sessionChangeRow,
  sessionRowKey,
  sessionRowsFromList,
  type RawRecord,
} from "./mapping.ts";
import {
  PAIRING_ENDED,
  pairingEnded,
  protocolMessage,
  protocolMismatch,
} from "./connect-errors.ts";
import {
  activeRun,
  activitySize,
  applyAgentEvent,
  applyChatEvent,
  applyQuestionRequested,
  applyQuestionResolved,
  foreignQuestionRequested,
  foreignQuestionResolved,
  questionMarkers,
  runsWithQuestionMarkers,
  bindRun,
  markStoppedForTimeouts,
  noteRunRequest,
  timeoutsInARow,
  TIMEOUTS_IN_A_ROW,
  markStopAsked,
  MAX_RAW_ENTRY_CHARS,
  runErrorRawId,
  markTurnLimit,
  runningRunId,
  noteStoppedWith,
  cancelQueuedRun,
  dropUnboundRun,
  dropUnboundRunUnlessStopping,
  emptyActivity,
  failRunStart,
  findRun,
  finishRun,
  isActive,
  cachedSize,
  isTerminal,
  markUnconfirmed,
  parkAfterStop,
  markQuestion,
  mergeHistoryRuns,
  queueLocalRun,
  RawTable,
  reconcileOutbox,
  historyQueuePairs,
  MAX_QUEUE_ALIASES,
  registerRunAlias,
  registerSteerAlias,
  settleRunFromSendAnswer,
  settleRunFromWait,
  settleUnboundStops,
  throughRunAliases,
  removeMessage,
  requestStop,
  revertStop,
  runsFromHistory,
  settleMissingQuestions,
  settleQuestionsOfEndedRuns,
  settleVanishedRuns,
  retainActivity,
  startLocalRun,
  questionPending,
  startQueuedRun,
  updateMessage,
  type CaughtUp,
  type EngineContext,
  type OutgoingMessage,
  type QuestionAnswer,
  type QuestionCard,
  type QuestionOption,
  type Run,
  type StepRaw,
  type RunRawRead,
  type StepRead,
  type TaskActivity,
} from "./runs.ts";
import {
  APPROVALS_SCOPE,
  ADMIN_SCOPE,
  ADMIN_SCOPES,
  PAIRING_SCOPE,
  heldFromGrant,
  INTERACTIVE_SCOPES,
  normalizeHeldScopes,
  QUESTIONS_SCOPE,
  READ_SCOPES,
  scopeSatisfied,
  WRITE_SCOPE,
} from "./scopes.ts";
import { capId, enforce, jsonLength, jsonTextLength } from "./bounds.ts";
import { validateGatewayUrl } from "./gateway-url.ts";
import {
  APPROVAL_ATTEMPTS,
  APPROVAL_OUTCOME,
  CREATION,
  enforceState,
  MAX_CREATIONS,
  MAX_ID_CHARS,
  MAX_LINKED_RUNS,
  MAX_MCP_TOOLS,
  MAX_BUILTIN_TOOLS,
  MAX_LISTED_TASKS,
  MAX_MESSAGE_JSON_CHARS,
  MAX_OUTBOX,
  MAX_PENDING_APPROVAL_COUNT,
  MAX_REACTIONS_PER_MESSAGE,
  MAX_RUN_TEXT_CHARS,
  MAX_STEPS_PER_TASK,
  MAX_TASK_LINE_CHARS,
  MAX_TRACKED_TASKS as TRACKED_TASKS,
  MAX_UNROUTED,
  RUN,
  SESSION_ROW,
  WORST_STATE_CHARS,
} from "./state-bounds.ts";
import { createStore, type Store } from "./store.ts";
import {
  changeSidebar,
  initialSidebar,
  readSidebar,
  sidebarRev,
  SIDEBAR_PREF_KEY,
  type SidebarChange,
  type SidebarContext,
  type SidebarPrefs,
  type SidebarState,
} from "./sidebar.ts";
import {
  UsageEngine,
  type UsageBusy,
  type UsageReport,
  type UsageReportRequest,
} from "./usage-engine.ts";
import { initialUsage, type BudgetChange, type BudgetRoutine } from "./usage.ts";
import {
  archiveTask,
  deleteTask,
  listArchived,
  markTask,
  newMainTask,
  newTask,
  pinTask,
  renameTask,
  restoreTask,
  type ArchivedList,
  type ArchiveResult,
  type CreatedTask,
  type TaskActionContext,
} from "./task-actions.ts";
import { fromActivity, WaitingIndex } from "./waiting.ts";
import { mentionRows, slashRows, type MenuRow } from "./composer-menus.ts";
import {
  CONTROL_EVENT,
  ComputerViews,
  initialComputerState,
  type ClosedCode,
  type ComputerFrame,
  type ComputerInput,
  type StopAnswer,
} from "./computer.ts";
import { readMachine, type MachineFacts } from "./machine.ts";
import {
  initialConnectionState,
  initialScopeUpgrade,
  initialState,
  type ClawtrateState,
  type ConnectionState,
  type DiscoveryState,
  type MessageReaction,
  type ScopeUpgradeState,
  type SendLimits,
  type TaskCreation,
  type TranscriptItem,
  type Transcript,
} from "./types.ts";

/** A read-only connection's scopes. Every connect asks for these until write access is approved. */
export const REQUESTED_SCOPES = ["operator.read"] as const;
/** Why forgetting a gateway was refused: another viewer chose a different one meanwhile. */
export const GATEWAY_CHANGED_MESSAGE = "The selected gateway changed. Choose again.";
/**
 * Client capabilities advertised in `connect`. `tool-events` is the only one
 * the live run view needs: without it the gateway sends no tool lifecycle
 * events. Approval caps are not claimed, because this client does not show or
 * resolve approvals.
 */
export const CLIENT_CAPS: readonly string[] = ["tool-events"];
/**
 * Added when the connect asks for `operator.approvals`: without `approvals` and
 * `exec-approvals` the gateway auto-denies exec approvals as `no-route`, and
 * `plugin-approvals` routes plugin approvals. A read-only connect does not claim
 * them, so the gateway never waits on a connection that cannot see approvals.
 */
export const APPROVAL_CAPS: readonly string[] = ["approvals", "exec-approvals", "plugin-approvals"];

/** The caps a connect requesting these scopes advertises. */
export function capsFor(scopes: readonly string[]): string[] {
  return scopes.includes(APPROVALS_SCOPE) ? [...CLIENT_CAPS, ...APPROVAL_CAPS] : [...CLIENT_CAPS];
}

/** Longest standing allow the gateway accepts (`grantExpiresInDays`). */
export const MAX_GRANT_DAYS = 3650;
/** A registered client id for third-party operator UIs; we do not claim an OpenClaw product id. */
export const CLIENT_ID = "gateway-client";
export const CLIENT_MODE = "ui";

/** One page of the task list. Pages are read until the gateway reports no more. */
export const SESSION_PAGE_SIZE = 200;
/** A ceiling so a huge gateway cannot make one reconnect read forever. */
export const MAX_SESSION_PAGES = 50;
/** Clawtrate's turn limit (F-100): a run this client started fails after it. */
export const DEFAULT_TURN_LIMIT_MS = 50 * 60_000;
/** The "Turn time limit" a person may choose, in minutes (F-100). */
export const MIN_TURN_LIMIT_MINUTES = 1;
export const MAX_TURN_LIMIT_MINUTES = 24 * 60;
/** Where the host keeps the chosen turn limit. */
/** Reads of a task's reactions, the first and again each time a newer change overtook one. */
const REACTION_LIST_ATTEMPTS = 3;
const TURN_LIMIT_KEY = "turn-limit-minutes";
/** Tasks the client follows at once: open in some viewer, kept for their unsent work, or being created. */
export const MAX_TRACKED_TASKS = TRACKED_TASKS;
/**
 * Messages one task's outbox may hold, whatever their state: waiting, being
 * sent, accepted but not yet in history, unconfirmed, failed or cancelled. A
 * new message past it is refused before anything is kept; nothing accepted is
 * dropped to make room.
 */
export const MAX_OUTBOX_PER_TASK = MAX_OUTBOX;
/**
 * Decoded bytes of files the client keeps for messages in outboxes, across
 * every task, until history confirms them or the user deletes them. With the
 * waiting uploads (`MAX_PENDING_ATTACHMENT_BYTES`) this is all the file
 * content the host keeps.
 */
export const MAX_RETAINED_ATTACHMENT_BYTES = 32 * 1024 * 1024;
/** Operations waiting for access at once; past it a new one is refused. */
export const MAX_ACCESS_WAITERS = 128;
/** Reads on opening a task on their way at once; past it, one more waits for the next opening. */
export const MAX_OPENED_READS = 16;
/**
 * Approval outcomes the gateway reported, kept by id apart from the visible
 * cards so a request or list entry that arrives after its resolution can never
 * make it actionable again. The oldest give way; switching gateways clears them.
 */
export const MAX_APPROVAL_OUTCOMES = 512;
/**
 * Approvals whose attempts are kept apart from any task: those with a decision
 * on its way, an unknown outcome or a read-back on its way. Past it, a
 * decision on another approval is refused until one settles.
 */
export const MAX_APPROVAL_ATTEMPTS = 256;
/**
 * Pending approvals kept while no followed task can show them, or while the
 * task they belong to already shows `MAX_PENDING_APPROVALS_PER_TASK`
 * (`unroutedApprovals`). Past it a new one is not kept and is counted in
 * `unroutedApprovalsOmitted`; the next list read brings it back.
 */
export const MAX_UNROUTED_APPROVALS = MAX_UNROUTED;
/** `approval.get` lookups of ambiguous legacy outcomes in flight at once; past it the outcome stays unknown. */
export const MAX_OUTCOME_LOOKUPS = 16;
/** Pending approvals one task shows; more wait in `unroutedApprovals` until one settles. */
export const MAX_PENDING_APPROVALS_PER_TASK = MAX_PENDING_APPROVAL_COUNT;

/**
 * How long a request may go unanswered on a live connection before it fails
 * locally. Nothing the client sent waits for ever: a send that times out is
 * failed with its outcome unknown, to retry with the same idempotency key.
 * Waits the gateway answers late by design (`device.scopes.waitUpgrade`) opt out.
 */
export const REQUEST_TIMEOUT_MS = 60_000;

/** Longest message text the client sends. */
export const MAX_MESSAGE_CHARS = 32_000;
/** The gateway's frame ceiling after `connect` when `hello-ok.policy.maxPayload` is absent (25 MiB). */
export const DEFAULT_MAX_PAYLOAD_BYTES = 26_214_400;
const SESSION_LIST_PARAMS = {
  limit: SESSION_PAGE_SIZE,
  includeDerivedTitles: true,
  includeLastMessage: true,
  excludeCron: true,
  excludeSubagents: true,
};
const HISTORY_LIMIT = 200;

/** Whether a history read lists a turn the gateway holds to run. One it withdrew stays listed as `cancelled`. */
function holdsInput(history: RawRecord | null): boolean {
  const items = asRecord(history?.pendingInputs)?.items;
  return Array.isArray(items) && items.some((item) => asRecord(item)?.state !== "cancelled");
}

/** The newest `MAX_LISTED_TASKS` task rows, each only the fields the list reads, cut to their bound, keyed under the id cap. */
function newestRows(rows: RawRecord[]): Map<string, RawRecord> {
  const kept = new Map<string, RawRecord>();
  for (const row of rows) {
    if (!isTaskSession(row)) continue;
    const bounded = SESSION_ROW(row);
    const key = sessionRowKey(bounded);
    if (key !== null) kept.set(key, bounded);
  }
  return new Map(
    [...kept]
      .sort(([, a], [, b]) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))
      .slice(0, MAX_LISTED_TASKS),
  );
}
/** How many sessions nobody has open, and how many runs of each, are followed for bot-to-bot cards. */
/** Sessions nobody has open whose runs are followed for bot-to-bot cards, and runs of each. */
export const FOREIGN_SESSIONS = 16;
export const FOREIGN_RUNS_PER_SESSION = 4;
/** Recipient sessions with a read on their way at once, and reads of one session at once. */
export const MAX_FOREIGN_READ_SESSIONS = MAX_TRACKED_TASKS * MAX_STEPS_PER_TASK;
/** Reads of one session on their way at once: at most the runs a task's steps name. */
export const MAX_FOREIGN_READS_PER_SESSION = MAX_STEPS_PER_TASK;
const MAX_TIMER_MS = 2_147_483_647;
/** Whole reads (`readStepRaw`, `readHistoryItem`, `readApprovalText`) in flight at once; past it one is refused. */
export const MAX_FULL_READS = 4;
/** File lists and reads in flight at once, across viewers; past it, refused. */
export const MAX_FILE_READS = 4;
/** Who reads a file, and how long an answer the reader's channel takes. */
export type FileReadOptions = { owner?: object; maxChars?: number };
/** The text length `chat.history` gives when not asked for more (OpenClaw 2026.10.6). */
export const GATEWAY_HISTORY_TEXT_CHARS = 8_000;
/** The most text per row a whole read asks `chat.history` for: the protocol's `maxChars` maximum. */
export const MAX_HISTORY_READ_CHARS = 500_000;
/** Runs of one task whose streaming `chat` text is kept to build on the next delta. */
export const MAX_STREAMS_PER_TASK = 2;
/** Spawn links kept (`spawnedBy`), newest. */
export const MAX_SPAWN_LINKS = 200;
const PAIRING_RETRY_MS = 3000;

const SETTINGS_KEY = "connection";

export type ConnectionSettings = {
  url: string;
  token: string | null;
  /** The user chose Disconnect: stay disconnected, across restarts, until Reconnect. */
  suspended?: boolean;
};

export type ConnectOptions = { url: string; token?: string | null };

/**
 * How to deliver a message while the task has an active run. Either way a
 * message to an idle task starts a new run, and a message sent while the run is
 * stopping is queued (§5.6). `auto` is the composer's Enter: a steer while the
 * run is running or waiting. `queue` is "Queue after this turn".
 */
export type SendMode = "auto" | "queue";

export type ClientOptions = {
  /**
   * Gateways this client may open. Checked before every connection, including
   * a saved one resumed at start and every retry.
   */
  allowGatewayUrl?: (url: string) => boolean;
  /** Reconnect backoff. Tests shorten it. */
  reconnect?: { initialMs: number; maxMs: number };
  /** Turn limit for runs this client starts. */
  turnLimitMs?: number;
  /** `REQUEST_TIMEOUT_MS` unless a test shortens it. */
  requestTimeoutMs?: number;
  /** First wait before a creation without an answer is asked again; `CREATION_CHECK_MS` unless a test shortens it. */
  creationCheckMs?: number;
  /**
   * Counts the host sets for its device. Each defaults to the bound the
   * retention arithmetic assumes and may only be lower: `trackedTasks`, the
   * tasks followed at once (`MAX_TRACKED_TASKS`).
   */
  limits?: { trackedTasks?: number };
  /**
   * Pin the connection to the read tier: every connect asks for
   * `operator.read` alone, whatever the stored token holds, and access is
   * never requested, so every write fails at once.
   */
  readOnly?: boolean;
};

/** A file sent with a message, as `chat.send` takes it: base64 content. */
export type OutgoingAttachment = {
  type: string;
  mimeType: string;
  fileName: string;
  content: string;
};

export type SendOptions = {
  mode?: SendMode;
  attachments?: OutgoingAttachment[];
  /** The gateway's id of the message this one replies to (F-067). */
  replyToId?: string;
};

/**
 * A send that would break a gateway ceiling. Checked before anything reaches
 * the socket: an oversized frame would close the connection with code 1009 and
 * no answer, and an oversized image or file would be refused anyway.
 */
export class SendTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SendTooLargeError";
  }
}

function decodedBytes(base64: string): number {
  const clean = base64.replace(/\s+/g, "");
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

type Plan = GatewayBrowserDeviceAuthPlan;

/**
 * A device token record. `grantedScopes` is what the gateway granted and is
 * kept for reference only. `heldScopes` is what this client means to hold and
 * is the only thing a connect ever requests.
 */
type StoredDeviceToken = {
  token: string;
  grantedScopes: string[];
  heldScopes: string[];
  /** This client asked for admin itself and the gateway granted it: connect asks for it again. */
  adminHeld?: boolean;
  /** The same for device access (`operator.pairing`), asked for by name. */
  pairingHeld?: boolean;
};

type Waiter = {
  scope: string;
  resolve: () => void;
  reject: (error: Error) => void;
  /** Who asked: a viewer's operations are withdrawn with `withdraw` when it goes away. */
  owner: object | null;
};

/** The approval kinds' list methods and readers. */
const APPROVAL_SOURCES: ReadonlyArray<{
  kind: ApprovalKind;
  method: string;
  parse: (value: unknown) => ApprovalCard | null;
}> = [
  { kind: "exec", method: "exec.approval.list", parse: parseExecApproval },
  { kind: "plugin", method: "plugin.approval.list", parse: parsePluginApproval },
  { kind: "system-agent", method: "openclaw.approval.list", parse: parseSystemAgentApproval },
];

function approvalAccessOf(sources: Record<ApprovalKind, ApprovalSourceAccess>): ApprovalAccess {
  const values = APPROVAL_KINDS.map((kind) => sources[kind]);
  if (values.every((each) => each === "ready")) return "ready";
  if (values.every((each) => each === "unavailable")) return "unavailable";
  if (values.some((each) => each === "loading")) return "loading";
  if (values.some((each) => each === "ready")) return "partial";
  return "error";
}

/** A request that never left this client: nothing happened. */
export class NotSentError extends Error {
  constructor() {
    super("not connected");
    this.name = "NotSentError";
  }
}

/** The gateway's answer did not come: what happened is not known yet, and is being checked. */
export class OutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutcomeUnknownError";
  }
}

/** The parameters of a creation, identical on every ask, as the gateway's idempotency requires. */
function creationParams(creation: TaskCreation) {
  return {
    agentId: creation.botId,
    message: creation.text,
    idempotencyKey: creation.id,
    ...(creation.label ? { label: creation.label } : {}),
  };
}

/** What a creation whose outcome could not be established says: retrying is the user's call, and may duplicate. */
export const CREATION_UNKNOWN_WARNING =
  "Whether the task was created could not be established. Check the task list: retrying may create a second task.";

/** How long a creation's key is asked again: within the 300 s the gateway remembers it, with a margin. */
export const CREATION_KEY_WINDOW_MS = 240_000;
const CREATION_CHECK_MS = 2_000;
const CREATION_CHECK_MAX_MS = 30_000;

/** A withdrawn operation: its viewer went away before the gateway was asked. */
export class WithdrawnError extends Error {
  constructor() {
    super("The request was withdrawn.");
    this.name = "WithdrawnError";
  }
}

/** The interactive scopes were asked for and not granted. */
export class AccessRequestError extends Error {
  readonly status: "rejected" | "expired" | "error";
  constructor(status: "rejected" | "expired" | "error", detail?: string) {
    super(
      status === "rejected"
        ? "The gateway's owner did not approve sending and answering from this device."
        : status === "expired"
          ? "The request to send and answer from this device expired before it was approved."
          : `Access could not be requested${detail ? `: ${detail}` : "."}`,
    );
    this.name = "AccessRequestError";
    this.status = status;
  }
}

function isRetryableNetworkFailure(error: Error): boolean {
  return !(error instanceof GatewayProtocolRequestError);
}

function isMissingScope(error: unknown): boolean {
  return (
    error instanceof GatewayProtocolRequestError &&
    asRecord(error.details)?.code === "MISSING_SCOPE"
  );
}

export { validateGatewayUrl };

export function defaultApprovalInstructions(_url: string, requestId: string): ApprovalInstructions {
  return {
    command: `openclaw devices approve ${requestId}`,
    note: "The gateway's owner runs this on the machine where the gateway runs.",
  };
}

export class GatewayNotAllowedError extends Error {
  constructor(url: string) {
    super(`This host is not allowed to connect to ${url}.`);
    this.name = "GatewayNotAllowedError";
  }
}

/**
 * A task holds work that must outlive its viewers: unsent or failed words,
 * words the gateway accepted that history has not confirmed, or a run this
 * client started. Cancelled messages are not work.
 */
function hasUnsettledWork(activity: TaskActivity): boolean {
  return (
    activity.outbox.some(
      (message) => message.status !== "cancelled" && message.status !== "handled",
    ) || activity.runs.some((run) => run.origin === "local" && !isTerminal(run.state))
  );
}

/** Who asks when the client is called directly rather than through a viewer's bridge session. */
const DIRECT_CALLER = {};
/** Viewers whose whole read of one approval's text is remembered at once; the oldest give way. */
export const MAX_APPROVAL_READERS = 8;

/** The secondary alarm: roughly what the state holds against its arithmetic bound. Never the bound itself. */
function withAlarm(state: ClawtrateState): ClawtrateState {
  let estimated = 0;
  for (const transcript of Object.values(state.transcripts)) {
    estimated +=
      activitySize(transcript) +
      cachedSize(transcript.items, jsonLength) +
      cachedSize(transcript.interSession, jsonLength);
  }
  const near = estimated > ALARM_FRACTION * WORST_STATE_CHARS;
  const shown = state.retention;
  if (
    shown.near === near &&
    shown.bound === WORST_STATE_CHARS &&
    Math.abs(shown.estimated - estimated) < WORST_STATE_CHARS / 100
  ) {
    return state;
  }
  return { ...state, retention: { estimated, bound: WORST_STATE_CHARS, near } };
}

/** The share of the arithmetic bound past which the alarm says it is near. */
export const ALARM_FRACTION = 0.8;

function withLive(transcript: Transcript): Transcript {
  const active = transcript.runs.find((run) => isActive(run.state));
  const live = active ? { runId: active.id, text: active.text } : null;
  const same =
    live === transcript.live ||
    (live !== null &&
      transcript.live !== null &&
      live.runId === transcript.live.runId &&
      live.text === transcript.live.text);
  return same ? transcript : { ...transcript, live };
}

export class ClawtrateClient {
  /**
   * The state, brought within its bounds (`state-bounds.ts`) every time it is
   * written, so nothing the host keeps can exceed its arithmetic worst case.
   */
  readonly store: Store<ClawtrateState> = createStore(initialState, (next) =>
    withAlarm(enforceState(next)),
  );

  private readonly host: ClawtrateHost;
  private readonly options: ClientOptions;
  /**
   * The credential store and device-auth lifecycle of the current connection,
   * bound to its gateway URL and generation. A new connection gets new ones,
   * so nothing an older connection finishes can write another gateway's token.
   */
  private auth: {
    url: string;
    generation: number;
    tokenStore: GatewayBrowserDeviceTokenStore;
    lifecycle: GatewayBrowserDeviceAuthLifecycle;
  } | null = null;
  private protocol: GatewayProtocolClient<Plan> | null = null;
  private settings: ConnectionSettings | null = null;
  private identity: { deviceId: string; publicKey: string } | null = null;
  /** Bumped for every new connection so late responses from an old one are dropped. */
  private generation = 0;
  /** True once the current connection has reached hello at least once. */
  private everConnected = false;
  /**
   * The gateway's `hello-ok.server.bootId`: a random id per gateway start, the
   * lifetime of its in-memory `sessions.create` idempotency cache. Null when
   * the hello does not carry one.
   */
  private gatewayBootId: string | null = null;
  /** The turn limit in force (F-100): the host's option, else the person's choice, else 50 minutes. */
  private turnLimitMs = DEFAULT_TURN_LIMIT_MS;
  /**
   * The person this connection acts for, as the gateway names them (`users.self` profile id):
   * which reactions are this person's own. Read once per connection; null until then, or when
   * the gateway names nobody.
   */
  private selfId: string | null = null;
  private rows = new Map<string, RawRecord>();
  /** Which tasks wait for the person, across every bot (`waiting.ts`), for the rail. */
  private readonly waiting = new WaitingIndex();
  /** Tasks whose read on opening is on its way: one per task at a time, however often it is asked. */
  private readonly openedReads = new Set<string>();
  /** Reads and writes of the rail's arrangement in the order they were asked, and the latest shown. */
  private sidebarIssued = 0;
  private sidebarShown = 0;
  /** Reads of the bot list in the order they were asked, and the latest shown. */
  private botsIssued = 0;
  private botsShown = 0;
  /** Open transcripts, counted, so several viewers can share one. */
  private readonly openSessions = new Map<string, number>();
  /** The streaming reply text of each task's newest `MAX_STREAMS_PER_TASK` runs, only while they stream. */
  private readonly streams = new ChatTextBaselines(MAX_STREAMS_PER_TASK, MAX_RUN_TEXT_CHARS);
  private readonly historyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Why a pending history reload runs, when it is a resync. */
  private readonly resyncReasons = new Map<string, CaughtUp["reason"]>();
  private readonly raw = new RawTable();
  private readonly turnTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Tasks no viewer has open that still hold unsent words or a run this client started. */
  private readonly retained = new Set<string>();
  private readonly deliveries = new Map<string, Promise<void>>();
  /** History reads per task, one at a time with at most one more waiting. */
  private readonly loads = new Map<
    string,
    { done: Promise<void>; again: { subscribe: boolean; resync: CaughtUp["reason"] | null } | null }
  >();
  /** Bumped each time a task is opened afresh, so a read from an earlier opening is dropped. */
  private readonly incarnations = new Map<string, number>();
  private nextIncarnation = 0;
  private readonly afterRunning = new Set<string>();
  private readonly afterAgain = new Set<string>();
  /** Tasks whose runs' `agent.wait` check is on its way, and the runs each last checked. */
  private readonly endChecking = new Set<string>();
  private readonly endChecked = new Map<string, string>();
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Runs of sessions no viewer has open, kept small, so a bot-to-bot card can
   * follow the recipient's run when this connection receives its events.
   */
  private readonly foreign = new Map<string, TaskActivity>();
  /** Steps of foreign runs are not kept, so neither are their payloads: this table keeps nothing. */
  private readonly foreignRaw = new RawTable(0, 0);
  /**
   * Recipient reads on their way, by session, at most
   * `MAX_FOREIGN_READ_SESSIONS` sessions and `MAX_FOREIGN_READS_PER_SESSION`
   * reads of one: each read carries a token, and a deletion of the session
   * cancels its reads' tokens, so an answer that predates the deletion is
   * dropped whatever happened to other sessions meanwhile.
   */
  private readonly foreignReads = new Map<string, Set<{ cancelled: boolean }>>();
  /** Which session spawned which (`spawnedBy` on events), newest kept, at most `MAX_SPAWN_LINKS`. */
  private readonly spawnedBy = new Map<string, string>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private bootstrapping = false;
  private changedDuringBootstrap = false;
  /** The pairing request this client last saw pending, and when. */
  private pairingSeen: string | null = null;
  /** The last change to the selected gateway; the next one starts once it has settled. */
  private connectionChanges: Promise<void> = Promise.resolve();
  /** A host stop cancels socket opens requested before it, including ones still saving settings. */
  private stops = 0;
  /** The current attempt reached hello. */
  private attemptGreeted = false;
  /** Set by the protocol client's gap callback; the reconnect it forces reloads with this reason. */
  private pendingResync: CaughtUp["reason"] | null = null;
  /** The next hello follows a reconnect this client made on purpose, so it is not a resync. */
  private quietReconnect = false;
  /** The user asked for write access and it is not settled yet. */
  private upgradeWanted = false;
  /**
   * What the request under way asks for: the interactive tier, admin with it, or
   * (`held`) the scopes the connection held when device access was asked for.
   */
  private upgradeTier: "interactive" | "admin" | "held" = "interactive";
  /** The scopes a `held` request keeps, as the connection held them when it was made. */
  private heldBase: readonly string[] = [];
  /** The access request under way also asks for device access (`operator.pairing`). */
  private pairingWanted = false;
  private scopeUpgrade: GatewayScopeUpgrade | null = null;
  private accessWaiters: Waiter[] = [];
  /** The frame, image and file ceilings from `hello-ok.policy`; nothing else of it is kept. */
  private payloadLimits: {
    maxPayload: number | null;
    maxImageBytes: number | null;
    maxFileBytes: number | null;
  } = {
    maxPayload: null,
    maxImageBytes: null,
    maxFileBytes: null,
  };
  /** Attachment content for outgoing messages, kept off the state snapshots, with its decoded size and the characters it holds. */
  private readonly attachmentContent = new Map<
    string,
    { task: string; files: OutgoingAttachment[]; bytes: number }
  >();
  private attachmentBytes = 0;
  /** Viewers that went away: anything they asked for is checked against this just before the gateway is asked. */
  private readonly withdrawnOwners = new WeakSet<object>();
  /** Task creations not yet settled, oldest first (`MAX_CREATIONS`). */
  private readonly creations = new Map<string, TaskCreation>();
  private readonly creationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly creationWaiters = new Map<
    string,
    Array<{ resolve: (key: string) => void; reject: (error: Error) => void }>
  >();
  /** Task slots held for tasks being created, so a creation never exceeds `MAX_TRACKED_TASKS`. */
  private reservedTasks = 0;
  /** Creations being checked, each still holding its task slot until it settles. */
  private readonly checkingSlots = new Set<string>();
  /** What the gateway reported about approvals, by id, newest last (`MAX_APPROVAL_OUTCOMES`). */
  private readonly approvalOutcomes = new Map<string, ApprovalResolution>();
  /**
   * Each unsettled approval's attempts, by id, kept for as long as anything is
   * outstanding whether or not a task shows it (`MAX_APPROVAL_ATTEMPTS`). Every
   * card of a pending approval is drawn from it.
   */
  private readonly approvalAttempts = new Map<string, ApprovalAttempts>();
  /** The last attempt number given, to any approval: numbers never repeat in this client. */
  private attemptSeq = 0;
  /** Pending approvals no followed task can show yet, oldest first (`MAX_UNROUTED_APPROVALS`). */
  private readonly unrouted = new Map<string, ApprovalCard>();
  private unroutedOmitted = 0;
  /** Approvals whose outcome is being looked up (`approval.get`). */
  private readonly lookingUp = new Set<string>();
  /** Recipient runs and sessions each task's `sessions_send` results name. */
  private readonly recipients = new Map<string, { runs: Set<string>; sessions: Set<string> }>();
  /**
   * Whole reads of a cut approval's text, per approval (`<key>\0<id>`) and per
   * viewer: the digest of what that viewer was given. Only approvals pending
   * in a followed task are kept, at most `MAX_APPROVAL_READERS` viewers each.
   */
  private readonly approvalReads = new Map<string, Map<object, string>>();
  /** Per task and list (`<key>\0<kind>`): the last list requested, and the newest applied. */
  private readonly listRequested = new Map<string, number>();
  private readonly listApplied = new Map<string, number>();
  /** Per task: its `tools.effective` read in flight, and whether another was asked for meanwhile. */
  private readonly toolReads = new Map<string, { again: boolean }>();
  /** Whole reads from history in flight (`MAX_FULL_READS`). */
  private fullReads = 0;
  /** File content on its way to viewers, in chunks (`files.ts`): nothing else of a file is kept. */
  private readonly fileTransfers = new FileTransfers(() => this.now());
  /** File lists and reads in flight (`MAX_FILE_READS`). */
  private fileReads = 0;
  /** Changes with every hello and every close, so work started on one connection never runs on the next. */
  private epoch = 0;
  /** The gateway's identity as read on the connection of `epoch`, once asked. */
  private gatewayIdentity: { epoch: number; id: Promise<string | null> } | null = null;
  /** Check-in reads begun; only the latest one's answer is shown. */
  private checkInReads = 0;
  /** Provider accounts per bot (`accounts-engine.ts`); its state is `accounts`. */
  private readonly accounts = new AccountsEngine({
    request: (method, params, options) => {
      if (!this.protocol) return Promise.reject(new NotSentError());
      return this.protocol.request(method, params, options);
    },
    get: () => this.state.accounts,
    update: (change) =>
      this.store.update((state) => ({ ...state, accounts: change(state.accounts) })),
    bots: () =>
      this.state.bots.map((bot) => ({ id: bot.id, name: bot.name, isDefault: bot.isDefault })),
    connected: () => this.state.connection.status === "connected",
    admin: () => this.holds(ADMIN_SCOPE) && this.state.connection.scopes.includes(ADMIN_SCOPE),
    refreshBots: () => this.refreshBots(),
    createMainTask: async (botId) => {
      const generation = this.generation;
      await this.request("sessions.create", {
        key: `agent:${botId}:main`,
        agentId: botId,
        label: "Main",
      });
      if (generation === this.generation) await this.refreshSessions(generation);
    },
    now: () => this.now(),
    randomId: () => this.randomId(),
    log: (message) => this.log("warn", message),
  });
  /** The gateway's scheduled jobs (`routines.ts`); its state is `routines`. */
  private readonly routines = new RoutinesEngine({
    request: (method, params) => {
      if (!this.protocol) return Promise.reject(new NotSentError());
      return this.protocol.request(method, params);
    },
    get: () => this.state.routines,
    update: (change) =>
      this.store.update((state) => ({ ...state, routines: change(state.routines) })),
    connected: () => this.state.connection.status === "connected",
    admin: () => this.holds(ADMIN_SCOPE) && this.state.connection.scopes.includes(ADMIN_SCOPE),
    identity: () => this.state.connection.gatewayId,
    withdrawn: (owner) => this.withdrawnOwners.has(owner),
  });
  /** Usage reports, warning budgets and providers' limits (`usage-engine.ts`); its state is `usage`. */
  private readonly usage = new UsageEngine({
    request: (method, params) => this.request(method, params),
    get: () => this.state.usage ?? initialUsage,
    update: (change) =>
      this.store.update((state) => ({ ...state, usage: change(state.usage ?? initialUsage) })),
    connected: () => this.state.connection.status === "connected",
    now: () => this.now(),
    log: (message) => this.log("warn", message),
  });
  /**
   * Where a bot runs and the gateway's machines (`machines.ts`): read when a page
   * asks and answered, never kept; writes read back before they answer.
   */
  private readonly machines = new MachinesEngine({
    request: (method, params) => this.request(method, params),
    connected: () => this.state.connection.status === "connected",
    admin: () => this.holds(ADMIN_SCOPE) && this.state.connection.scopes.includes(ADMIN_SCOPE),
    pairing: () => this.holds(PAIRING_SCOPE),
    readOnly: () => this.options.readOnly === true,
    bots: () => this.state.bots.map((bot) => ({ id: bot.id, name: bot.name })),
    latestTask: (botId) => {
      const tasks = this.state.tasksByBot[botId] ?? [];
      let latest: { key: string; at: number } | null = null;
      for (const task of tasks) {
        const at = task.updatedAt ?? 0;
        if (!latest || at > latest.at) latest = { key: task.key, at };
      }
      return latest?.key ?? null;
    },
    deviceId: () => this.state.connection.deviceId,
    now: () => this.now(),
  });
  /**
   * Task lists being read, each its rows so far, already bounded: at most two,
   * a hello's and one refresh (refreshes run one at a time; a changed
   * connection's read ends when its requests are flushed).
   */
  private readonly listings = new Set<Map<string, RawRecord>>();
  private refreshing = false;
  private refreshAgain = false;

  /** Tasks followed at once: the host's count, at most `MAX_TRACKED_TASKS`. */
  private readonly trackedLimit: number;

  /**
   * Every viewer's Computer tab (`computer.ts`): what the plugin answered, the
   * views and the control. Tickets, streams, frames, generations and queued
   * input stay in it; only codes and plain facts reach the state.
   */
  private readonly computer: ComputerViews = new ComputerViews({
    request: (method, params) => this.request(method, params),
    openStream: (url) => {
      const socket = this.host.createWebSocket(url);
      // Frames arrive as bytes; a socket without the setting gives bytes of its own kind.
      socket.binaryType = "arraybuffer";
      return socket;
    },
    gatewayUrl: () => this.state.connection.gatewayUrl,
    canWrite: () =>
      this.state.connection.status === "connected" &&
      this.state.connection.canWrite &&
      !this.options.readOnly,
    online: () => this.state.connection.status === "connected",
    now: () => this.now(),
    get: () => this.state.computer ?? initialComputerState,
    set: (computer) => this.store.update((state) => ({ ...state, computer })),
    pendingQuestion: (key) =>
      this.state.transcripts[key]?.questions.find((q) => q.status === "pending") ?? null,
    questionStatus: (key, id) =>
      this.state.transcripts[key]?.questions.find((q) => q.id === id)?.status ?? null,
    answer: (key, id, answers) => this.answerQuestion(key, id, answers),
    stopTask: (key, owner) => this.stopTask(key, owner),
    log: (level, message) => this.log(level, message),
  });

  constructor(host: ClawtrateHost, options: ClientOptions = {}) {
    this.host = host;
    this.options = options;
    this.turnLimitMs = options.turnLimitMs ?? DEFAULT_TURN_LIMIT_MS;
    this.trackedLimit = hostLimit(options.limits?.trackedTasks, MAX_TRACKED_TASKS, "trackedTasks");
  }

  get state(): ClawtrateState {
    return this.store.get();
  }

  /** The gateway saved from an earlier run, if any. */
  async savedSettings(): Promise<ConnectionSettings | null> {
    const raw = await this.host.storage.get(SETTINGS_KEY);
    return raw ? (JSON.parse(raw) as ConnectionSettings) : null;
  }

  /** Written first: settings the host could not save are never the ones in use. */
  private async saveSettings(settings: ConnectionSettings): Promise<void> {
    await this.host.storage.set(SETTINGS_KEY, JSON.stringify(settings));
    this.settings = settings;
  }

  /**
   * Run one change to the selected gateway and its saved settings after the
   * previous one has settled, so each reads and writes what the last one left.
   */
  private changeConnection<T>(change: () => Promise<T>): Promise<T> {
    const run = this.connectionChanges.then(change);
    this.connectionChanges = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /** Resume the saved gateway, if any and if allowed, unless the user disconnected from it. */
  async start(): Promise<void> {
    const stops = this.stops;
    const identity = await this.loadIdentity();
    this.setConnection({ deviceId: identity.deviceId });
    // A turn limit the person chose earlier, unless the host was given one.
    if (this.options.turnLimitMs === undefined) {
      const saved = Number(await this.host.storage.get(TURN_LIMIT_KEY).catch(() => null));
      if (validTurnLimit(saved)) this.turnLimitMs = saved * 60_000;
    }
    this.store.update((state) => ({ ...state, turnLimitMinutes: this.turnLimitMs / 60_000 }));
    const settings = await this.savedSettings();
    if (stops !== this.stops) return;
    this.settings = settings;
    if (this.settings?.suspended) {
      this.setConnection({ status: "disconnected", gatewayUrl: this.settings.url });
      return;
    }
    if (this.settings) await this.open();
  }

  /** Connect to a gateway. A token is only needed until this device is paired. */
  async connect(options: ConnectOptions): Promise<void> {
    const stops = this.stops;
    return this.changeConnection(async () => {
      const url = validateGatewayUrl(options.url);
      if (!this.isAllowed(url)) throw new GatewayNotAllowedError(url);
      const token = options.token?.trim() || null;
      const switched = this.settings?.url !== url;
      await this.saveSettings({ url, token });
      if (switched) this.abandonAccessRequest("Switched to another gateway.");
      this.pairingSeen = null;
      if (stops === this.stops) await this.open();
    });
  }

  /**
   * Close the connection and forget the gateway. The device key and any device
   * token remain. With `gatewayUrl`, only that gateway is forgotten: the address
   * the person saw, which another viewer may have changed since.
   */
  async disconnect(gatewayUrl?: string): Promise<void> {
    return this.changeConnection(async () => {
      if (!this.settings) return;
      if (gatewayUrl !== undefined && this.settings.url !== gatewayUrl) {
        throw new Error(GATEWAY_CHANGED_MESSAGE);
      }
      // Forgotten first: a gateway the host could not forget stays connected, as it stays saved.
      await this.host.storage.delete(SETTINGS_KEY);
      this.abandonAccessRequest("Disconnected from the gateway.");
      this.close();
      this.settings = null;
      this.pairingSeen = null;
      this.rows = new Map();
      this.raw.clear();
      this.retained.clear();
      this.forgetGatewayState();
      this.store.set({
        ...initialState,
        turnLimitMinutes: this.turnLimitMs / 60_000,
        connection: { ...initialConnectionState, deviceId: this.identity?.deviceId ?? null },
      });
    });
  }

  /**
   * The user's retry. While connected it reloads bots and tasks; otherwise it
   * reconnects at once, keeping what is already on screen.
   */
  async retryNow(): Promise<void> {
    const stops = this.stops;
    // The reload runs outside the queue: it changes nothing saved.
    const reload = await this.changeConnection(async () => {
      if (!this.settings || stops !== this.stops) return null;
      if (this.protocol?.connected && this.state.connection.status === "connected") {
        return this.generation;
      }
      if (this.settings.suspended) await this.saveSettings({ ...this.settings, suspended: false });
      if (stops === this.stops) await this.open();
      return null;
    });
    if (reload !== null && reload === this.generation) await this.bootstrap(reload, null);
  }

  /**
   * Close the connection and keep everything else: the gateway, the device's
   * pairing and what is on screen. `retryNow` reconnects.
   */
  async suspend(): Promise<void> {
    return this.changeConnection(async () => {
      if (!this.settings) return;
      // Saved, so a restart does not reconnect by itself.
      await this.saveSettings({ ...this.settings, suspended: true });
      // The connection stops: writes waiting for access fail, as on any lost connection.
      // Runs are kept as they are and reconciled with history after Reconnect.
      this.abandonAccessRequest("Disconnected from the gateway.");
      this.close();
      this.setConnection({ status: "disconnected", retryAt: null, error: null, pairing: null });
    });
  }

  /** Stop without forgetting anything. Used when the host process exits. */
  stop(): void {
    this.stops += 1;
    this.close();
  }

  /** Open a transcript. Calls are counted; the last matching close releases it. */
  openSession(key: string, reservation = false): void {
    // A task's key is kept, and keys every map of the task, only within the id cap.
    if (jsonTextLength(key) > MAX_ID_CHARS) throw new Error("That task key is too long.");
    const taken = this.openSessions.size + this.retained.size + this.reservedTasks;
    if (!this.tracked(key) && !reservation && taken >= this.trackedLimit) {
      throw new Error(`At most ${this.trackedLimit} tasks can be open at once.`);
    }
    const count = this.openSessions.get(key) ?? 0;
    this.openSessions.set(key, count + 1);
    if (count > 0) return;
    // A task closed with unsent work was kept: reopening shows the same queue.
    const kept = this.retained.delete(key);
    if (!kept || !this.incarnations.has(key))
      this.incarnations.set(key, (this.nextIncarnation += 1));
    this.setTranscript(key, (current) => current ?? this.openedTranscript(key));
    // An approval waiting for a task that can show it may belong here now.
    this.routeUnrouted();
    if (this.state.connection.status === "connected") void this.loadTranscript(key, !kept, null);
  }

  /** Keep only Raw entries that still belong to this task's retained state. */
  private retainTaskRaw(key: string, after: TaskActivity): void {
    this.raw.retainTask(
      key,
      after.runs.flatMap((run) => [
        ...run.steps.map((step) => step.id),
        ...(run.error?.raw ? [runErrorRawId(run.id)] : []),
      ]),
    );
  }

  /**
   * Release a viewer's interest. When the last one goes, a task that still holds
   * unsent, unconfirmed or failed words, or a run this client started, is kept
   * and followed until that work is done or the user cancels it; otherwise it
   * is released.
   */
  closeSession(key: string): void {
    const count = this.openSessions.get(key);
    if (!count) return;
    if (count > 1) {
      this.openSessions.set(key, count - 1);
      return;
    }
    this.openSessions.delete(key);
    const transcript = this.state.transcripts[key];
    if (transcript && hasUnsettledWork(transcript)) {
      this.retained.add(key);
      return;
    }
    this.releaseTask(key);
  }

  /** Whether events and reloads for this task are followed: a viewer has it open, or it is kept for its work. */
  private tracked(key: string): boolean {
    return this.openSessions.has(key) || this.retained.has(key);
  }

  private releaseTask(key: string): void {
    this.retained.delete(key);
    this.incarnations.delete(key);
    this.endChecked.delete(key);
    this.loads.delete(key);
    // Drop the chat stream baselines this task held.
    this.streams.retire(key);
    const timer = this.historyTimers.get(key);
    if (timer) clearTimeout(timer);
    this.historyTimers.delete(key);
    this.resyncReasons.delete(key);
    this.raw.clearTask(key);
    this.clearTurnTimers(key);
    const expiry = this.expiryTimers.get(key);
    if (expiry) clearTimeout(expiry);
    this.expiryTimers.delete(key);
    for (const message of this.state.transcripts[key]?.outbox ?? []) {
      this.dropAttachments(message.id);
    }
    this.recipients.delete(key);
    for (const readKey of [...this.approvalReads.keys()])
      if (readKey.startsWith(`${key}\u0000`)) this.approvalReads.delete(readKey);
    for (const map of [this.listRequested, this.listApplied]) {
      for (const listKey of [...map.keys()])
        if (listKey.startsWith(`${key}\u0000`)) map.delete(listKey);
    }
    this.toolReads.delete(key);
    if (this.state.connection.status === "connected") {
      this.request("sessions.messages.unsubscribe", { key }).catch(() => {});
    }
    this.keepLinkedRuns(key);
    this.store.update((state) => {
      const transcripts = { ...state.transcripts };
      delete transcripts[key];
      return { ...state, transcripts };
    });
    if (this.waiting.unhold(key)) this.publishTasks();
  }

  /**
   * A task let go that holds a run another followed task's send names (a
   * recipient's run, while its sender's task is open): that run goes on being
   * followed as a session nobody has open, so the sender's card keeps it and
   * sees how it ends, rather than forgetting it and reading Sent again.
   */
  private keepLinkedRuns(key: string): void {
    const leaving = this.state.transcripts[key];
    if (!leaving) return;
    const linked = new Set(
      Object.values(this.state.transcripts)
        .filter((transcript) => transcript.sessionKey !== key)
        .flatMap((transcript) => Object.keys(transcript.linkedRuns)),
    );
    const kept = leaving.runs.filter((run) => linked.has(run.id));
    if (kept.length === 0) return;
    this.updateForeign(key, (activity) => ({
      ...activity,
      runs: [...activity.runs.filter((run) => !linked.has(run.id)), ...kept],
    }));
  }

  /** How many viewers hold a transcript open. */
  sessionInterest(key: string): number {
    return this.openSessions.get(key) ?? 0;
  }

  // Write access ----------------------------------------------------------------

  /**
   * Ask the gateway's owner, in one request, for the interactive scopes
   * (`operator.write`, `operator.approvals`, `operator.questions`) through
   * `device.scopes.requestUpgrade`. Returns once the request is under way; the
   * pending request id and approve command appear in `connection.upgrade`.
   * When it is approved the client stores the rotated device token and
   * reconnects asking for exactly what was granted of that set.
   */
  async requestAccess(tier: "interactive" | "admin" | "pairing" = "interactive"): Promise<void> {
    if (this.options.readOnly)
      throw new Error("This host only reads; it does not ask for more access.");
    // A request for admin is never narrowed by a later one for less, and device access
    // (`operator.pairing`) is asked for only by name, added to the scopes the connection
    // holds and nothing else: from a read connection it asks for no power to send or answer.
    const pairing = tier === "pairing" || (this.upgradeWanted && this.pairingWanted);
    const waiting = this.upgradeWanted ? this.upgradeTier : null;
    const wanted =
      tier === "admin" || waiting === "admin"
        ? "admin"
        : tier === "interactive" || waiting === "interactive"
          ? "interactive"
          : "held";
    if (wanted === "held" && waiting !== "held")
      this.heldBase = ADMIN_SCOPES.filter((scope) => this.state.connection.scopes.includes(scope));
    const target = [...this.tierScopes(wanted), ...(pairing ? [PAIRING_SCOPE] : [])];
    if (target.every((scope) => this.holdsExactly(scope))) return;
    if (!this.settings) throw new Error("Connect to a gateway first.");
    if (this.scopeUpgrade && (wanted !== this.upgradeTier || (pairing && !this.pairingWanted))) {
      // A narrower request is waiting; ask again, for this with it.
      this.scopeUpgrade.cancelScopeUpgrade();
      this.scopeUpgrade = null;
    }
    this.upgradeTier = wanted;
    this.pairingWanted = pairing;
    this.upgradeWanted = true;
    if (this.state.connection.status === "connected") this.startUpgrade();
  }

  private tierScopes(tier: "interactive" | "admin" | "held"): readonly string[] {
    return tier === "admin" ? ADMIN_SCOPES : tier === "held" ? this.heldBase : INTERACTIVE_SCOPES;
  }

  /** What an access request asks for: its tier, device access when asked for or held. */
  private upgradeTarget(): string[] {
    const keepPairing = this.pairingWanted || this.state.connection.scopes.includes(PAIRING_SCOPE);
    return [...this.tierScopes(this.upgradeTier), ...(keepPairing ? [PAIRING_SCOPE] : [])];
  }

  /** Device access counts only when granted by name: admin implies it, but was not asked for it. */
  private holdsExactly(scope: string): boolean {
    return scope === PAIRING_SCOPE
      ? this.state.connection.status === "connected" &&
          this.state.connection.scopes.includes(PAIRING_SCOPE)
      : this.holds(scope);
  }

  private holds(scope: string): boolean {
    const connection = this.state.connection;
    return connection.status === "connected" && scopeSatisfied(connection.scopes, scope);
  }

  private setUpgrade(patch: Partial<ScopeUpgradeState>): void {
    this.store.update((state) => ({
      ...state,
      connection: { ...state.connection, upgrade: { ...state.connection.upgrade, ...patch } },
    }));
  }

  private startUpgrade(): void {
    const protocol = this.protocol;
    const identity = this.identity;
    const url = this.settings?.url;
    const auth = this.auth;
    if (this.scopeUpgrade || !protocol || !identity || !url || !auth || auth.url !== url) return;
    const generation = this.generation;
    const tier = this.upgradeTier;
    const target = this.upgradeTarget();
    const askedPairing = target.includes(PAIRING_SCOPE);
    const upgrade = new GatewayScopeUpgrade({
      request: (method, params, options) => protocol.request(method, params, options),
      tokenStore: {
        load: auth.tokenStore.load,
        clear: auth.tokenStore.clear,
        // The rotated token carries the new grant; from now on connect asks for exactly what it covers.
        // It belongs to this gateway and this connection only.
        store: async ({ deviceId, role, token, scopes }) => {
          if (
            generation !== this.generation ||
            this.settings?.url !== url ||
            this.scopeUpgrade !== upgrade
          ) {
            throw new Error("The gateway changed while access was being approved.");
          }
          const admin = target.includes(ADMIN_SCOPE) && scopeSatisfied(scopes, ADMIN_SCOPE);
          const pairing = askedPairing && scopes.includes(PAIRING_SCOPE);
          await this.writeToken(url, deviceId, role, {
            token,
            grantedScopes: scopes,
            heldScopes: [
              ...heldFromGrant(scopes),
              ...(admin ? [ADMIN_SCOPE] : []),
              ...(pairing ? [PAIRING_SCOPE] : []),
            ],
            ...(admin ? { adminHeld: true } : {}),
            ...(pairing ? { pairingHeld: true } : {}),
          });
        },
      },
      reconnect: () => {
        if (generation !== this.generation || this.settings?.url !== url) return;
        this.quietReconnect = true;
        void this.open();
      },
    });
    this.scopeUpgrade = upgrade;
    this.setUpgrade({
      ...initialScopeUpgrade,
      status: "requesting",
      scopes: target,
    });
    upgrade
      .requestScopeUpgrade({
        binding: { clientId: CLIENT_ID, deviceId: identity.deviceId, role: "operator" },
        scopes: target,
        onPending: (requestId) => {
          const instructions = (this.host.approvalInstructions ?? defaultApprovalInstructions)(
            url,
            requestId,
          );
          this.setUpgrade({
            status: "pending",
            requestId,
            approveCommand: instructions.command,
            approveNote: instructions.note,
          });
        },
      })
      .then(
        (outcome) => {
          if (this.scopeUpgrade !== upgrade) return;
          this.scopeUpgrade = null;
          if (outcome.status === "approved") {
            if (
              (tier !== "held" &&
                !scopeSatisfied(outcome.scopes, tier === "admin" ? ADMIN_SCOPE : WRITE_SCOPE)) ||
              (askedPairing && !outcome.scopes.includes(PAIRING_SCOPE))
            ) {
              this.failAccess(
                new AccessRequestError(
                  "error",
                  `the gateway granted only ${outcome.scopes.join(", ")}`,
                ),
              );
              return;
            }
            // Settled. The reconnect is under way; its hello settles the waiters.
            this.upgradeWanted = false;
            this.pairingWanted = false;
            this.setUpgrade({ status: "approved", error: null });
            return;
          }
          this.failAccess(new AccessRequestError(outcome.status));
        },
        (error: unknown) => {
          if (this.scopeUpgrade !== upgrade) return;
          this.scopeUpgrade = null;
          if (!this.upgradeWanted) return;
          if (!(error instanceof GatewayProtocolRequestError) && !this.protocol?.connected) {
            // The connection dropped while waiting. Ask again after the next hello.
            return;
          }
          this.failAccess(new AccessRequestError("error", errorMessage(error)));
        },
      );
  }

  private failAccess(error: AccessRequestError): void {
    this.upgradeWanted = false;
    this.pairingWanted = false;
    this.setUpgrade({ status: error.status, error: error.message });
    const waiters = this.accessWaiters;
    this.accessWaiters = [];
    for (const waiter of waiters) waiter.reject(error);
  }

  private abandonAccessRequest(reason: string): void {
    this.scopeUpgrade?.cancelScopeUpgrade();
    this.scopeUpgrade = null;
    this.upgradeWanted = false;
    this.pairingWanted = false;
    const waiters = this.accessWaiters;
    this.accessWaiters = [];
    for (const waiter of waiters) waiter.reject(new Error(reason));
  }

  /** After a hello: resolve waiters the grant covers; once nothing is being asked for, refuse the rest. */
  private settleAccessWaiters(): void {
    const waiters = this.accessWaiters;
    this.accessWaiters = [];
    for (const waiter of waiters) {
      if (this.holds(waiter.scope)) waiter.resolve();
      else if (this.upgradeWanted) this.accessWaiters.push(waiter);
      else waiter.reject(new Error(`The gateway did not grant ${waiter.scope}.`));
    }
  }

  /**
   * Resolves once the connection holds `scope`. When the client does not mean
   * to hold it yet, this asks for the interactive scopes; when it already does
   * (the connection is only down), it waits for the next hello. A connection
   * that has stopped (the gateway refused the device, or reconnecting gave up)
   * will not bring one, so the operation fails at once and stays retryable.
   * `owner` names the viewer that asked, so its operations can be withdrawn.
   */
  private ensureScope(scope: string, owner: object | null = null): Promise<void> {
    if (this.holds(scope)) return Promise.resolve();
    const connection = this.state.connection;
    if (connection.status === "error" || connection.status === "idle" || !this.protocol) {
      return Promise.reject(
        new Error(
          `Not connected to the gateway${connection.error ? `: ${connection.error.message}` : "."}`,
        ),
      );
    }
    if (this.accessWaiters.length >= MAX_ACCESS_WAITERS) {
      return Promise.reject(
        new Error("Too many operations are waiting for access; try again when they finish."),
      );
    }
    const waiting = new Promise<void>((resolve, reject) => {
      this.accessWaiters.push({ scope, resolve, reject, owner });
    });
    // Not meant to be held yet, or held and then lost (capped or revoked) on a
    // live connection: ask the gateway's owner. Otherwise the connection is
    // only down, and the next hello settles it.
    if (
      !this.state.connection.requestedScopes.includes(scope) ||
      this.state.connection.status === "connected"
    ) {
      this.requestAccess().catch((error: unknown) => {
        this.failAccess(new AccessRequestError("error", errorMessage(error)));
      });
    }
    return waiting;
  }

  /**
   * A viewer went away: everything it asked for that is still waiting for
   * access is withdrawn now, before the gateway is asked, and nothing of it is
   * kept. Work the client owns (outgoing messages) is not a viewer's.
   */
  withdraw(owner: object): void {
    this.withdrawnOwners.add(owner);
    this.fileTransfers.release(owner);
    for (const readers of this.approvalReads.values()) readers.delete(owner);
    const withdrawn = this.accessWaiters.filter((waiter) => waiter.owner === owner);
    if (withdrawn.length === 0) return;
    this.accessWaiters = this.accessWaiters.filter((waiter) => waiter.owner !== owner);
    for (const waiter of withdrawn) waiter.reject(new WithdrawnError());
  }

  /**
   * The last check before an operation asks the gateway: its viewer has not
   * gone away. Waiter withdrawal covers an operation still waiting for access;
   * this covers one whose access was already held or just settled.
   */
  private checkNotWithdrawn(owner: object | null | undefined): void {
    if (owner && this.withdrawnOwners.has(owner)) throw new WithdrawnError();
  }

  /** Operations waiting for access, for tests and diagnostics. */
  get pendingAccessWaiters(): number {
    return this.accessWaiters.length;
  }

  /** Reject every operation waiting for access, without changing what is being asked for. */
  private rejectAccessWaiters(error: Error): void {
    this.upgradeWanted = false;
    const waiters = this.accessWaiters;
    this.accessWaiters = [];
    for (const waiter of waiters) waiter.reject(error);
  }

  /**
   * The gateway refused a call for a missing scope: this connection does not
   * hold it, whatever the last hello said. Drop it from the effective scopes,
   * so the next use asks for it again instead of repeating the refused call.
   */
  private noteMissingScope(error: unknown): void {
    if (!isMissingScope(error)) return;
    const details = asRecord((error as GatewayProtocolRequestError).details);
    const missing = typeof details?.missingScope === "string" ? details.missingScope : null;
    if (!missing) return;
    this.setEffectiveScopes(
      this.state.connection.scopes.filter(
        (scope) => scope !== missing && scope !== "operator.admin",
      ),
    );
    // Without the scope no list can be read: say so, rather than show what was read before as current.
    if (!this.holds(APPROVALS_SCOPE)) {
      for (const key of Object.keys(this.state.transcripts)) {
        for (const kind of APPROVAL_KINDS) this.setApprovalSource(key, kind, "unavailable");
      }
    }
  }

  /** The scopes this connection holds, and every flag derived from them, set together. */
  private setEffectiveScopes(scopes: string[]): void {
    this.setConnection({
      scopes,
      canWrite: scopeSatisfied(scopes, WRITE_SCOPE),
      canAnswer: scopeSatisfied(scopes, QUESTIONS_SCOPE),
      canApprove: scopeSatisfied(scopes, APPROVALS_SCOPE),
      canAdmin: scopes.includes(ADMIN_SCOPE),
    });
  }

  // Sending ---------------------------------------------------------------------

  /**
   * Send a message to an open task. It shows at once in the task's outbox and
   * leaves it when history holds it. The idempotency key is the message id,
   * so a retry is never delivered twice. Returns the message id. Throws
   * `SendTooLargeError` before anything is sent when it would break a ceiling.
   */
  sendMessage(key: string, text: string, options: SendOptions = {}): string {
    const transcript = this.state.transcripts[key];
    if (!transcript) throw new Error("Open the task before sending to it.");
    const body = text.trim();
    const attachments = options.attachments ?? [];
    this.checkOutboxRoom(key);
    if (!body && attachments.length === 0) throw new Error("The message is empty.");
    // Never cut: a message whose escaped form would pass its bound is refused instead.
    if (body.length > MAX_MESSAGE_CHARS || jsonTextLength(body) > MAX_MESSAGE_JSON_CHARS)
      throw new Error("The message is too long.");
    // A file's name and type are kept beside its content: only valid ones, never cut.
    for (const each of attachments) {
      validateAttachmentMeta(each.fileName, each.mimeType);
      if (typeof each.type !== "string" || each.type.length > 32)
        throw new Error("invalid file type");
    }
    if (attachments.length > MAX_ATTACHMENTS_PER_MESSAGE)
      throw new SendTooLargeError(
        `${attachments.length} files; one message can carry at most ${MAX_ATTACHMENTS_PER_MESSAGE}.`,
      );
    // As it will be sent, its reply reference included; checked again at delivery.
    this.checkSize(
      this.sendParams(key, body, "x".repeat(36), "followup", attachments, options.replyToId),
    );
    const bytes = attachments.reduce((sum, each) => sum + decodedBytes(each.content), 0);
    if (this.attachmentBytes + bytes > MAX_RETAINED_ATTACHMENT_BYTES) {
      throw new Error(
        "Files of earlier messages are still waiting to go out; send or delete some of them first.",
      );
    }
    const active = activeRun(transcript);
    const resolved = !active
      ? "new"
      : active.state === "stopping" || options.mode === "queue"
        ? "queue"
        : "steer";
    // A pending question holds every outgoing message in the task, however it
    // was sent; it is released when the last pending question settles.
    const held = active?.state !== "stopping" && questionPending(transcript, active);
    const replyToId = options.replyToId;
    if (
      replyToId !== undefined &&
      (typeof replyToId !== "string" || !replyToId || replyToId.length > MAX_ID_CHARS)
    )
      throw new Error("That message can't be replied to.");
    const message: OutgoingMessage = {
      id: this.randomId(),
      text: body,
      mode: resolved,
      status: held ? "held" : resolved === "queue" ? "queued" : "sending",
      runId: resolved === "steer" ? active!.id : null,
      messageSeq: null,
      leftAt: null,
      createdAt: this.now(),
      error: null,
      attachments: attachments.map((attachment) => ({
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        sizeBytes: decodedBytes(attachment.content),
      })),
      ...(replyToId ? { replyToId } : {}),
    };
    if (attachments.length > 0) {
      this.attachmentContent.set(message.id, { task: key, files: attachments, bytes });
      this.attachmentBytes += bytes;
    }
    this.updateActivity(key, (activity) => {
      const withMessage = { ...activity, outbox: [...activity.outbox, message] };
      // A held message starts nothing: once the question settles it is queued, as a turn of its own.
      if (resolved === "new" && !held) return startLocalRun(withMessage, message, this.now());
      if (resolved === "queue" && !held) return queueLocalRun(withMessage, message, this.now());
      return withMessage;
    });
    if (message.status === "sending") this.enqueueDelivery(key, message.id);
    return message.id;
  }

  /**
   * Refuse a new outgoing message beyond the per-task and per-client bounds,
   * before keeping anything. Every message the outbox holds counts, failed and
   * unconfirmed ones included, so retrying and deleting are always possible
   * and nothing accepted is dropped to make room.
   */
  private checkOutboxRoom(key: string): void {
    const here = (this.state.transcripts[key] ?? emptyActivity).outbox.length;
    if (here >= MAX_OUTBOX_PER_TASK) {
      throw new Error(
        `This task already holds ${MAX_OUTBOX_PER_TASK} messages waiting to be sent, confirmed, retried or deleted.`,
      );
    }
  }

  /** Forget a message's file content and give its bytes back. */
  private dropAttachments(messageId: string): void {
    const kept = this.attachmentContent.get(messageId);
    if (!kept) return;
    this.attachmentContent.delete(messageId);
    this.attachmentBytes -= kept.bytes;
  }

  /** Decoded bytes of files held for outgoing messages, for tests and diagnostics. */
  get retainedAttachmentBytes(): number {
    return this.attachmentBytes;
  }

  private sendParams(
    key: string,
    text: string,
    idempotencyKey: string,
    queueMode: "steer" | "followup",
    attachments: OutgoingAttachment[],
    replyToId?: string,
  ) {
    return chatSendParams(
      { sessionKey: key, text, idempotencyKey, queueMode, replyToId: replyToId ?? null },
      attachments,
    );
  }

  /** What one message may carry: the smaller of Clawtrate's own ceilings and the gateway's. */
  private sendLimits(): SendLimits {
    const { maxPayload, maxImageBytes, maxFileBytes } = this.payloadLimits;
    return {
      imageBytes:
        maxImageBytes !== null ? Math.min(maxImageBytes, MAX_IMAGE_BYTES) : MAX_IMAGE_BYTES,
      fileBytes: maxFileBytes !== null ? Math.min(maxFileBytes, MAX_FILE_BYTES) : MAX_FILE_BYTES,
      payloadBytes: maxPayload ?? DEFAULT_MAX_PAYLOAD_BYTES,
      files: MAX_ATTACHMENTS_PER_MESSAGE,
    };
  }

  /**
   * Refuse a send past the file count, an image or file ceiling or the frame ceiling, before it
   * reaches the socket: `sendRefusal`, the function the composer checks a draft with, over the
   * request as built and the gateway's current policy.
   */
  private checkSize(params: ReturnType<typeof chatSendParams<OutgoingAttachment>>): void {
    const files = (params.attachments ?? []).map((each) => ({
      fileName: each.fileName,
      mimeType: each.mimeType,
      bytes: decodedBytes(each.content),
    }));
    const refused = sendRefusal(
      {
        sessionKey: params.sessionKey,
        text: params.message,
        idempotencyKey: params.idempotencyKey,
        queueMode: params.queueMode,
        replyToId: params.replyToId ?? null,
        files,
      },
      this.sendLimits(),
    );
    if (!refused) return;
    throw new SendTooLargeError(
      refused.kind === "count"
        ? `${refused.count} files; one message can carry at most ${refused.limit}.`
        : refused.kind === "frame"
          ? `The message and its files come to ${refused.bytes} bytes; one message can carry at most ${refused.limit}.`
          : `${files[refused.index]!.fileName} is ${refused.bytes} bytes; the gateway accepts ${refused.kind === "image" ? "images" : "files"} up to ${refused.limit} bytes.`,
    );
  }

  /**
   * Send a failed, unconfirmed or unknown message again, with the same idempotency key,
   * so the gateway delivers it at most once. It already counts against the
   * outbox bounds, so a retry is never refused for room.
   */
  retryMessage(key: string, messageId: string): void {
    const message = this.outgoing(key, messageId);
    if (
      !message ||
      (message.status !== "failed" &&
        message.status !== "unconfirmed" &&
        message.status !== "unknown" &&
        message.status !== "not-sent")
    )
      return;
    const transcript = this.state.transcripts[key]!;
    const active = activeRun(transcript);
    // A message that came from the queue keeps that origin through every attempt, until
    // it starts or is removed: it starts now with no run active, and otherwise waits
    // behind the active run, so a refusal still reads "Couldn't start" on the shelf.
    // "Send" on one left Not sent after a Stop follows the normal send rules instead: it goes
    // as a message sent at that moment would, a steer into a run the person has since started.
    const fromQueue = message.mode === "queue" && message.status !== "not-sent";
    const mode = fromQueue
      ? "queue"
      : !active
        ? "new"
        : active.state === "stopping"
          ? "queue"
          : "steer";
    const held = active?.state !== "stopping" && questionPending(transcript, active);
    const status = held ? "held" : mode === "queue" && active ? "queued" : "sending";
    this.updateActivity(key, (activity) => {
      // A run the gateway refused never started; the retry is a new attempt.
      const cleared = {
        ...activity,
        runs: activity.runs.filter(
          (run) => !(run.id === messageId && run.origin === "local" && !run.bound),
        ),
      };
      const next = updateMessage(cleared, messageId, {
        mode,
        status,
        error: null,
        runId: mode === "steer" ? active!.id : null,
      });
      const updated = next.outbox.find((each) => each.id === messageId)!;
      if (status === "sending" && !active) return startLocalRun(next, updated, this.now());
      if (status === "queued") return queueLocalRun(next, updated, this.now());
      return next;
    });
    if (status === "sending") this.enqueueDelivery(key, messageId);
  }

  /** Remove a failed, cancelled or unconfirmed message, and the run that never started with it. */
  deleteMessage(key: string, messageId: string): void {
    const message = this.outgoing(key, messageId);
    if (
      !message ||
      (message.status !== "failed" &&
        message.status !== "cancelled" &&
        message.status !== "unconfirmed" &&
        message.status !== "unknown" &&
        message.status !== "not-sent" &&
        message.status !== "handled")
    )
      return;
    this.dropAttachments(messageId);
    this.updateActivity(key, (activity) => ({
      ...removeMessage(activity, messageId),
      runs: activity.runs.filter(
        (run) => !(run.id === messageId && run.origin === "local" && !run.bound),
      ),
    }));
  }

  /** "Cancel" on a queued or held message's row: it is never sent. */
  cancelQueued(key: string, messageId: string): void {
    const message = this.outgoing(key, messageId);
    if (!message || (message.status !== "queued" && message.status !== "held")) return;
    // A cancelled message is never sent: its files are not kept.
    this.dropAttachments(messageId);
    this.updateActivity(key, (activity) =>
      updateMessage(cancelQueuedRun(activity, messageId, this.now()), messageId, {
        status: "cancelled",
      }),
    );
  }

  /**
   * "Edit" on a held or queued message's row: the message is taken back,
   * never sent, and its words and files are handed to the caller as one
   * record, to go back into the composer. The files leave this client's
   * keeping at once.
   */
  /**
   * What `takeBack` would give back, changing nothing: a host checks there is
   * room for the files before any of it happens. Throws as `takeBack` does.
   */
  peekTakeBack(
    key: string,
    messageId: string,
  ): { text: string; attachments: OutgoingAttachment[] } {
    const message = this.outgoing(key, messageId);
    if (!message || (message.status !== "queued" && message.status !== "held"))
      throw new Error("That message can no longer be edited.");
    const files = this.attachmentContent.get(messageId)?.files ?? [];
    if (message.attachments.length > 0 && files.length === 0)
      throw new Error("Its files are no longer held; attach them again.");
    return { text: message.text, attachments: [...files] };
  }

  takeBack(key: string, messageId: string): { text: string; attachments: OutgoingAttachment[] } {
    const { text, attachments: files } = this.peekTakeBack(key, messageId);
    this.dropAttachments(messageId);
    this.updateActivity(key, (activity) =>
      updateMessage(cancelQueuedRun(activity, messageId, this.now()), messageId, {
        status: "cancelled",
      }),
    );
    return { text, attachments: files };
  }

  /**
   * "Try again" on a turn that failed: the same words and files, sent now as
   * a new message with its own key, a reply to the same message when it was
   * one. The files must still be held for the message (until history holds
   * it); otherwise it is refused, never sent without them.
   */
  sendAgain(key: string, messageId: string): string {
    const message = this.outgoing(key, messageId);
    if (!message) throw new Error("That message is no longer held here.");
    const files = this.attachmentContent.get(messageId)?.files ?? [];
    if (message.attachments.length > 0 && files.length === 0)
      throw new Error("Its files are no longer held; attach them again.");
    return this.sendMessage(key, message.text, {
      attachments: [...files],
      ...(message.replyToId ? { replyToId: message.replyToId } : {}),
    });
  }

  /** "Send now" on a queued message's chip: a steer into the running or waiting run. */
  sendQueuedNow(key: string, messageId: string): void {
    const message = this.outgoing(key, messageId);
    if (!message || message.status !== "queued") return;
    const transcript = this.state.transcripts[key]!;
    const active = activeRun(transcript);
    if (questionPending(transcript, active))
      throw new Error("Send now is unavailable while a question is pending.");
    if (active?.state === "stopping")
      throw new Error("Send now is unavailable while the run stops.");
    this.updateActivity(key, (activity) => {
      if (!active)
        return startQueuedRun(
          updateMessage(activity, messageId, { status: "sending" }),
          messageId,
          this.now(),
        );
      const withoutQueued = {
        ...activity,
        runs: activity.runs.filter((run) => run.id !== messageId),
      };
      const held = questionPending(activity, active);
      return updateMessage(withoutQueued, messageId, {
        mode: "steer",
        status: held ? "held" : "sending",
        runId: active.id,
      });
    });
    if (this.outgoing(key, messageId)?.status === "sending") this.enqueueDelivery(key, messageId);
  }

  /**
   * Create a task under a bot with its first message. `sessions.create`
   * carries only `agentId`, `message`, `idempotencyKey` and `label`, which keep
   * it at `operator.write`. The caller holds one interest in the new task, as
   * if it had called `openSession`, and releases it with `closeSession`.
   */
  async createTask(
    botId: string,
    text: string,
    options: { label?: string; owner?: object; retryUnknown?: boolean } = {},
  ): Promise<string> {
    const body = text.trim();
    if (!body) throw new Error("The message is empty.");
    if (body.length > MAX_MESSAGE_CHARS || jsonTextLength(body) > MAX_MESSAGE_JSON_CHARS)
      throw new Error("The message is too long.");
    const label = options.label?.trim() || null;
    // Kept as asked, never cut: a cut field would ask the gateway something else on a later ask.
    if (
      jsonTextLength(botId) > MAX_ID_CHARS ||
      (label && jsonTextLength(label) > MAX_TASK_LINE_CHARS)
    )
      throw new Error("The bot id or label is too long.");
    // The same request whose earlier attempt the gateway refused is asked again with its own key;
    // one still being checked is not asked twice.
    const earlier = [...this.creations.values()].find(
      (each) => each.botId === botId && each.text === body && each.label === label,
    );
    if (earlier && (earlier.status === "creating" || earlier.status === "checking")) {
      // Asked again while the first is out or being checked: the same request, so the same outcome.
      return this.awaitCreation(earlier.id);
    }
    if (earlier?.status === "created" && earlier.key) {
      // Found created after its answer was lost: asking again is the same request, not a second task.
      this.openSession(earlier.key);
      return earlier.key;
    }
    if (earlier?.status === "unknown" && !options.retryUnknown) {
      // It may exist: only the user's own retry (`retryCreation`), warned, asks again.
      throw new Error(CREATION_UNKNOWN_WARNING);
    }
    if (!earlier && this.creations.size >= MAX_CREATIONS) {
      throw new Error("Too many task creations are still unsettled; dismiss some first.");
    }
    // The new task's slot is held before anything is asked of the gateway, and given back on failure.
    if (this.openSessions.size + this.retained.size + this.reservedTasks >= this.trackedLimit) {
      throw new Error(`At most ${this.trackedLimit} tasks can be open at once.`);
    }
    // Owned before anything is awaited: its key, its task slot and its place in the count are
    // taken now, so the same request asked meanwhile joins it rather than sending a second key.
    this.reservedTasks += 1;
    let reserved = true;
    const release = () => {
      if (reserved) this.reservedTasks -= 1;
      reserved = false;
    };
    // Kept from before it is sent: the request and its key survive a timeout.
    const creation: TaskCreation =
      earlier && (earlier.status === "failed" || earlier.status === "unknown")
        ? // The same key: a refusal freed it, and a gateway that still has it answers the original.
          { ...earlier, status: "creating", error: null, createdAt: this.now() }
        : {
            id: this.randomId(),
            botId,
            text: body,
            label,
            status: "creating",
            createdAt: this.now(),
            error: null,
            key: null,
            gatewayBootId: null,
          };
    this.putCreation(creation);
    let sent = false;
    try {
      // A viewer that goes away while access is approved takes its request with it (`withdraw`).
      await this.ensureScope(WRITE_SCOPE, options.owner ?? null);
      // The viewer went away while access settled: nothing is asked of the gateway.
      this.checkNotWithdrawn(options.owner);
      // Switching gateways while access settled dropped it: it is never asked of another gateway.
      if (this.creations.get(creation.id)?.status !== "creating")
        throw new Error("Switched to another gateway.");
      creation.gatewayBootId = this.gatewayBootId;
      this.putCreation(creation);
      sent = true;
      const result = asRecord(await this.request("sessions.create", creationParams(creation)));
      release();
      return this.completeCreation(creation, result, true);
    } catch (error) {
      if (!sent) {
        // Nothing was asked of the gateway: an earlier refused attempt goes back to how it was,
        // a new one is dropped, and whoever joined it learns why.
        if (this.creations.has(creation.id)) {
          if (earlier) this.putCreation(earlier, error as Error);
          else this.dropCreation(creation.id, error as Error);
        }
        throw error;
      }
      // Settled as unknown already (an answer that names no task).
      if (error instanceof OutcomeUnknownError) throw error;
      if (error instanceof GatewayProtocolRequestError || error instanceof NotSentError) {
        // The gateway refused it, or it never left: it did not happen. It can be asked again with its key.
        this.putCreation({ ...creation, status: "failed", error: errorMessage(error) });
        throw error;
      }
      // No answer: the outcome is unknown. Ask again with the same key, which the gateway
      // answers with the original outcome; nothing is created twice. The task's slot stays
      // held until it settles, so the task it may bring has room.
      if (reserved) {
        reserved = false;
        this.checkingSlots.add(creation.id);
      }
      this.putCreation({ ...creation, status: "checking", error: errorMessage(error) });
      this.scheduleCreationCheck(creation.id);
      throw new OutcomeUnknownError(
        "The gateway did not answer in time; whether the task was created is being checked.",
      );
    } finally {
      release();
    }
  }

  /** The new task from a `sessions.create` answer: opened, its first message in its outbox. */
  private completeCreation(
    creation: TaskCreation,
    result: RawRecord | null,
    byCaller: boolean,
  ): string {
    const key = typeof result?.key === "string" ? result.key : null;
    if (!key) {
      // The gateway answered, so something may exist; without its key it cannot be found.
      this.putCreation({ ...creation, status: "unknown", error: CREATION_UNKNOWN_WARNING });
      throw new OutcomeUnknownError(CREATION_UNKNOWN_WARNING);
    }
    const id = creation.id;
    const runId = typeof result?.runId === "string" ? result.runId : null;
    const runError = asRecord(result?.runError);
    const now = this.now();
    const message: OutgoingMessage = {
      id,
      text: creation.text,
      mode: "new",
      status: runError ? "failed" : "sent",
      runId,
      messageSeq: typeof result?.messageSeq === "number" ? result.messageSeq : null,
      // It went out with the task's creation.
      leftAt: now,
      createdAt: now,
      error: runError ? String(runError.message ?? "The run did not start.") : null,
      attachments: [],
    };
    // A caller holds one interest in the new task; one settled later is kept for its message.
    this.openSession(key, true);
    this.updateActivity(key, (activity, ctx) => {
      if (activity.outbox.some((each) => each.id === id)) return activity;
      let next = startLocalRun(
        { ...activity, outbox: [...activity.outbox, message] },
        message,
        now,
      );
      if (runId) next = bindRun(next, id, runId);
      if (runError) {
        next = failRunStart(
          next,
          runId ?? id,
          {
            message: message.error!,
            kind: typeof runError.code === "string" ? runError.code : "not-started",
          },
          ctx,
        );
      } else if (!runId) {
        next = dropUnboundRun(next, id);
      }
      return next;
    });
    if (byCaller) {
      this.creations.delete(id);
      this.releaseCheckingSlot(id);
      this.publishCreations();
      this.settleCreationWaiters(id, key);
    } else {
      this.closeSession(key);
      this.putCreation({ ...creation, status: "created", error: null, key });
    }
    return key;
  }

  /** Keep a creation as it now is; once it is settled, callers waiting on it learn how (or `reason`). */
  private putCreation(asked: TaskCreation, reason?: Error): void {
    // The bounded record is the one kept; the state publishes the same object.
    const creation = enforce(CREATION, asked);
    this.creations.delete(creation.id);
    this.creations.set(creation.id, creation);
    this.publishCreations();
    // Callers waiting on its outcome learn it once it is settled one way or the other.
    if (creation.status === "creating" || creation.status === "checking") return;
    this.releaseCheckingSlot(creation.id);
    if (creation.status === "created" && creation.key)
      this.settleCreationWaiters(creation.id, creation.key);
    else
      this.settleCreationWaiters(
        creation.id,
        reason ?? new Error(creation.error ?? "The task was not created."),
      );
  }

  /** Forget a creation that was never asked of the gateway; whoever joined it learns why. */
  private dropCreation(id: string, reason: Error): void {
    this.creations.delete(id);
    this.publishCreations();
    this.settleCreationWaiters(id, reason);
  }

  private settleCreationWaiters(id: string, outcome: string | Error): void {
    const waiting = this.creationWaiters.get(id) ?? [];
    this.creationWaiters.delete(id);
    for (const waiter of waiting) {
      if (typeof outcome === "string") waiter.resolve(outcome);
      else waiter.reject(outcome);
    }
  }

  private releaseCheckingSlot(id: string): void {
    if (this.checkingSlots.delete(id)) this.reservedTasks -= 1;
  }

  /** The outcome of a creation already under way, once known. */
  private awaitCreation(id: string): Promise<string> {
    if ((this.creationWaiters.get(id)?.length ?? 0) >= MAX_ACCESS_WAITERS)
      return Promise.reject(new Error("Too many requests are waiting for this task; try again."));
    return new Promise((resolve, reject) => {
      // Like any caller of `createTask`, one that joins holds an interest in the new task.
      const settle = (key: string) => {
        this.openSession(key, true);
        resolve(key);
      };
      this.creationWaiters.set(id, [
        ...(this.creationWaiters.get(id) ?? []),
        { resolve: settle, reject },
      ]);
    });
  }

  private publishCreations(): void {
    this.store.update((state) => ({ ...state, creations: [...this.creations.values()] }));
  }

  private scheduleCreationCheck(id: string, attempt = 0): void {
    const earlier = this.creationTimers.get(id);
    if (earlier) clearTimeout(earlier);
    const timer = setTimeout(
      () => {
        this.creationTimers.delete(id);
        void this.checkCreation(id, attempt);
      },
      Math.min(
        CREATION_CHECK_MAX_MS,
        (this.options.creationCheckMs ?? CREATION_CHECK_MS) * 2 ** attempt,
      ),
    );
    this.creationTimers.set(id, timer);
  }

  /**
   * Find out how a creation whose answer did not come ended. It is asked
   * again, with the same key and parameters, only of the gateway start that
   * holds that key: the hello's `server.bootId` names it, and the gateway
   * keeps a key for 300 s (OpenClaw 2026.10.6), so within
   * `CREATION_KEY_WINDOW_MS` it answers with the original outcome or waits
   * for work still in flight. Without that identity nothing establishes what
   * happened: the creation is `unknown`, and only the user's own retry, with
   * its warning, asks again.
   */
  private async checkCreation(id: string, attempt: number): Promise<void> {
    const creation = this.creations.get(id);
    if (!creation || creation.status !== "checking") return;
    if (this.state.connection.status !== "connected" || !this.holds(WRITE_SCOPE)) {
      if (this.now() - creation.createdAt <= CREATION_KEY_WINDOW_MS) return; // After the next hello.
    }
    if (
      this.now() - creation.createdAt > CREATION_KEY_WINDOW_MS ||
      creation.gatewayBootId === null ||
      creation.gatewayBootId !== this.gatewayBootId
    ) {
      this.putCreation({ ...creation, status: "unknown", error: CREATION_UNKNOWN_WARNING });
      return;
    }
    try {
      const result = asRecord(await this.request("sessions.create", creationParams(creation)));
      if (this.creations.get(id)?.status !== "checking") return;
      this.completeCreation(creation, result, false);
    } catch (error) {
      if (this.creations.get(id)?.status !== "checking") return;
      if (error instanceof GatewayProtocolRequestError) {
        this.putCreation({ ...creation, status: "failed", error: errorMessage(error) });
        return;
      }
      this.scheduleCreationCheck(id, attempt + 1);
    }
  }

  /** Check every creation still waiting for its outcome, at once; after a hello. */
  private checkCreations(): void {
    for (const creation of this.creations.values()) {
      if (creation.status !== "checking") continue;
      const timer = this.creationTimers.get(creation.id);
      if (timer) clearTimeout(timer);
      this.creationTimers.delete(creation.id);
      void this.checkCreation(creation.id, 0);
    }
  }

  /**
   * The user's retry of a creation the gateway refused, or whose outcome could
   * not be established (`CREATION_UNKNOWN_WARNING`: it may create a second
   * task), with its own key.
   */
  async retryCreation(id: string, options: { owner?: object } = {}): Promise<string> {
    const creation = this.creations.get(id);
    if (!creation || (creation.status !== "failed" && creation.status !== "unknown"))
      throw new Error("That creation cannot be retried.");
    return this.createTask(creation.botId, creation.text, {
      ...(creation.label ? { label: creation.label } : {}),
      ...(options.owner ? { owner: options.owner } : {}),
      retryUnknown: true,
    });
  }

  /** Forget a creation that failed, settled or cannot be established. */
  dismissCreation(id: string): void {
    const creation = this.creations.get(id);
    if (!creation || creation.status === "creating" || creation.status === "checking") return;
    this.creations.delete(id);
    this.publishCreations();
  }

  private outgoing(key: string, messageId: string): OutgoingMessage | undefined {
    return this.state.transcripts[key]?.outbox.find((message) => message.id === messageId);
  }

  /** Deliver one outgoing message with `chat.send`, once write access is held. */
  private async deliver(key: string, messageId: string): Promise<void> {
    if (!this.state.connection.canWrite) {
      this.updateActivity(key, (activity) =>
        updateMessage(activity, messageId, { status: "awaiting-access" }),
      );
    }
    try {
      await this.ensureScope(WRITE_SCOPE);
    } catch (error) {
      this.failDelivery(key, messageId, error, true);
      return;
    }
    let message = this.outgoing(key, messageId);
    if (!message || (message.status !== "sending" && message.status !== "awaiting-access")) return;

    // A pending question holds every send, whatever run it was meant for and whether or not
    // a run is still shown as active: the question's own state is the guard.
    {
      const current = this.state.transcripts[key];
      const currentRun = current ? activeRun(current) : undefined;
      if (current && questionPending(current, currentRun)) {
        this.updateActivity(key, (activity) =>
          updateMessage(activity, messageId, { status: "held", runId: currentRun?.id ?? null }),
        );
        return;
      }
    }

    // The active run may have changed while access was pending.
    if (message.mode === "steer") {
      const active = activeRun(this.state.transcripts[key]!);
      if (!active) {
        this.updateActivity(key, (activity) => {
          const next = updateMessage(activity, messageId, { mode: "new", runId: null });
          return startLocalRun(
            next,
            next.outbox.find((each) => each.id === messageId)!,
            this.now(),
          );
        });
      } else if (active.state === "stopping") {
        this.updateActivity(key, (activity) => {
          const next = updateMessage(activity, messageId, {
            mode: "queue",
            status: "queued",
            runId: null,
          });
          return queueLocalRun(
            next,
            next.outbox.find((each) => each.id === messageId)!,
            this.now(),
          );
        });
        return;
      } else if (active.id !== message.runId) {
        this.updateActivity(key, (activity) =>
          updateMessage(activity, messageId, { runId: active.id }),
        );
      }
    }
    this.updateActivity(key, (activity) =>
      updateMessage(activity, messageId, { status: "sending" }),
    );
    message = this.outgoing(key, messageId)!;

    let result: RawRecord | null;
    try {
      const params = this.sendParams(
        key,
        message.text,
        message.id,
        message.mode === "steer" ? "steer" : "followup",
        this.attachmentContent.get(messageId)?.files ?? [],
        message.replyToId,
      );
      this.checkSize(params);
      // A send that starts its own run names that run's request: what a failed turn's
      // "Copy request ID" gives (F-301). A steer joins a run another frame started.
      const starts = message.mode !== "steer";
      const sent = this.request("chat.send", params, {
        onSent: (requestId) => {
          if (!starts) return;
          this.updateActivity(key, (activity) => noteRunRequest(activity, messageId, requestId));
        },
      });
      // The frame has left: from here a Stop no longer parks it.
      this.updateActivity(key, (activity) =>
        updateMessage(activity, messageId, { leftAt: this.now() }),
      );
      result = asRecord(await sent);
    } catch (error) {
      this.noteMissingScope(error);
      if (
        error instanceof GatewayProtocolRequestError ||
        error instanceof SendTooLargeError ||
        error instanceof NotSentError
      ) {
        // Refused by the gateway, or never sent: it did not happen.
        this.failDelivery(key, messageId, error, !(error instanceof NotSentError));
        return;
      }
      // No answer: whether it was delivered is unknown. History is read to find
      // it by its key; it becomes unconfirmed, with retry and delete, only if
      // history does not hold it. Nothing is sent again on an assumption.
      // A run the person asked to stop stays, stopping, until history names or settles it.
      this.updateActivity(key, (activity) =>
        dropUnboundRunUnlessStopping(
          updateMessage(activity, messageId, {
            status: "checking",
            runId: null,
            error: errorMessage(error),
          }),
          messageId,
        ),
      );
      this.scheduleHistory(key);
      return;
    }
    const runId = typeof result?.runId === "string" ? result.runId : null;
    const messageSeq = typeof result?.messageSeq === "number" ? result.messageSeq : null;
    const steeredInto = message.mode === "steer" ? message.runId : null;
    // A stop command (`/stop`) is answered `{ok, aborted, runIds}` before any
    // run or turn is recorded: the gateway handled it, and no run or history
    // row will follow.
    const command = runId === null && typeof result?.aborted === "boolean";
    this.updateActivity(key, (activity, ctx) => {
      if (command) {
        // A stop command of this task's stopped the runs its answer names: as this client's Stop.
        const stopped =
          result?.aborted === true && Array.isArray(result.runIds)
            ? result.runIds.filter((id): id is string => typeof id === "string")
            : [];
        return markStopAsked(
          dropUnboundRun(
            updateMessage(activity, messageId, {
              status: "handled",
              messageSeq: null,
              runId: null,
              error: null,
            }),
            messageId,
          ),
          stopped,
          this.now(),
        );
      }
      if (runId === null && message.mode !== "steer") {
        // Accepted, but no run named: none is assumed, unless the person asked to stop it.
        // History confirms the message, or the next read finds it unconfirmed, to retry or delete.
        return dropUnboundRunUnlessStopping(
          updateMessage(activity, messageId, { status: "sent", messageSeq, runId: null }),
          messageId,
        );
      }
      let next = updateMessage(activity, messageId, {
        status: "sent",
        messageSeq,
        runId: steeredInto ?? runId ?? messageId,
      });
      if (message.mode === "steer") {
        // The steer's own run id settles at once; the reply streams under the run it joined.
        if (steeredInto && runId) next = registerSteerAlias(next, runId, steeredInto);
      } else if (runId) {
        next = settleRunFromSendAnswer(bindRun(next, messageId, runId), runId, result!, ctx);
      }
      return next;
    });
    // Stop was pressed before the gateway had taken the send: abort the run it named now.
    if (runId && !command && message.mode !== "steer") {
      const run = findRun(this.state.transcripts[key] ?? emptyActivity, runId);
      if (run?.state === "stopping") void this.abortRun(key, runId);
    }
    // Accepted is not confirmed: the files stay until history holds the message or the user deletes it.
    if (command) this.dropAttachments(messageId);
    this.scheduleHistory(key);
  }

  /**
   * A send failed. A gateway refusal is definitive: the run "Couldn't start".
   * Anything else leaves the outcome unknown, so the optimistic run is dropped;
   * the message can be retried with the same idempotency key either way.
   */
  private failDelivery(key: string, messageId: string, error: unknown, definitive: boolean): void {
    const message = this.outgoing(key, messageId);
    if (!message) return;
    this.updateActivity(key, (activity, ctx) => {
      let next = updateMessage(activity, messageId, {
        status: "failed",
        error: errorMessage(error),
      });
      if (message.mode !== "steer" && findRun(next, messageId)) {
        next = definitive
          ? failRunStart(
              next,
              messageId,
              { message: errorMessage(error), kind: "not-started" },
              ctx,
            )
          : dropUnboundRun(next, messageId);
      }
      return next;
    });
  }

  // Stopping --------------------------------------------------------------------

  /**
   * Stop a running or waiting run with `chat.abort`. The run is `stopping`
   * until the gateway reports how it ended: `stopped` when the abort took,
   * `completed` with `finishedBeforeStop` when the run finished first.
   */
  async stopRun(
    key: string,
    asked: string,
    options: { owner?: object; everyRun?: boolean } = {},
  ): Promise<void> {
    const transcript = this.state.transcripts[key];
    const runId = transcript
      ? (runningRunId(transcript, asked) ??
        // Archive and delete stop every active run of the task, so each is aborted by its own
        // id even when none of them is established as the current one.
        (options.everyRun
          ? (transcript.steerAliases[asked] ?? transcript.queueAliases[asked] ?? asked)
          : null))
      : asked;
    // No one current run is established: Stop is withheld until the gateway identifies it.
    if (runId === null) return;
    const run = transcript && findRun(transcript, runId);
    if (!run || (run.state !== "running" && run.state !== "waiting")) return;
    this.updateActivity(key, (activity) => requestStop(activity, runId, this.now()));
    try {
      await this.ensureScope(WRITE_SCOPE, options.owner ?? null);
      this.checkNotWithdrawn(options.owner);
      const current = findRun(this.state.transcripts[key] ?? emptyActivity, runId);
      if (!current || current.state !== "stopping") return;
      // The gateway cancels only a run it has registered: an abort that reaches it before it
      // has taken the send stops nothing, with or without the run's id, and the turn then runs
      // in full. So a run the gateway has not named yet is aborted once the send's answer
      // names it (`deliver`); an answer that says it is over already needs no abort.
      if (!current.bound) return;
      await this.abortRun(key, current.id);
    } catch (error) {
      this.noteMissingScope(error);
      this.updateActivity(key, (activity) => revertStop(activity, runId, errorMessage(error)));
    }
  }

  /**
   * `chat.abort` for one run the gateway has named, its exact id. Only the gateway's refusal
   * gives the Stop up. An abort that was not sent, or whose answer the connection lost, leaves
   * the run stopping: once the connection is back, the run is aborted again if it still is, as
   * many times as the connection drops, until the gateway answers or the run's end arrives.
   */
  private async abortRun(key: string, runId: string): Promise<void> {
    try {
      const result = asRecord(await this.request("chat.abort", { sessionKey: key, runId }));
      // Nothing was aborted: the run ended already. Its terminal event or history settles it.
      if (result?.aborted === false) this.scheduleHistory(key);
      else if (result?.aborted === true) this.noteHelpers(key, runId, result);
    } catch (error) {
      this.noteMissingScope(error);
      if (error instanceof GatewayProtocolRequestError) {
        this.updateActivity(key, (activity) => revertStop(activity, runId, errorMessage(error)));
        return;
      }
      // Let the connection's own handling of a drop run first, so a lost connection is seen as one.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      // A client that was stopped sends nothing more.
      if (!this.protocol) return;
      try {
        await this.ensureScope(WRITE_SCOPE);
      } catch (waiting) {
        this.updateActivity(key, (activity) => revertStop(activity, runId, errorMessage(waiting)));
        return;
      }
      const run = this.state.transcripts[key] && findRun(this.state.transcripts[key], runId);
      if (run?.state === "stopping" && run.bound) await this.abortRun(key, runId);
    }
  }

  /** The helper runs the gateway's confirmation of a Stop names besides the run (F-098). */
  private noteHelpers(key: string, runId: string, answer: RawRecord): void {
    const helpers = (Array.isArray(answer.runIds) ? answer.runIds : []).filter(
      (id) => typeof id === "string" && id !== runId,
    ).length;
    if (helpers > 0)
      this.updateActivity(key, (activity) =>
        noteStoppedWith(activity, runId, (now) => ({ ...now, helpers: now.helpers + helpers })),
      );
  }

  /**
   * A run this client stopped (Stop, a typed `/stop`, the timeouts' own stop) has ended as
   * stopped, however that reached it: the abort's answer, the run's end event after a lost
   * answer, or history after a reconnect. The runs of other bots its messages started are then
   * stopped too (F-296), each recipient taken from the run's own record (its `sessions_send`
   * results), every one of them asked, not only the first `MAX_STOPPED_NAMED`. Each is recorded
   * as the gateway answered: stopped, refused, unanswered, or, with no run named, uncertain. A
   * recipient whose run had ended already is not named.
   */
  private async stopRecipients(key: string, runId: string): Promise<void> {
    const transcript = this.state.transcripts[key];
    const run = transcript && findRun(transcript, runId);
    if (!transcript || !run) return;
    this.updateActivity(key, (activity) =>
      noteStoppedWith(activity, runId, (now) => ({ ...now, recipientsAsked: true })),
    );
    const note = (kind: "bots" | "uncertain" | "refused" | "unanswered", sessionKey: string) =>
      this.updateActivity(key, (activity) =>
        noteStoppedWith(activity, runId, (now) => ({ ...now, [kind]: [...now[kind], sessionKey] })),
      );
    const rawOf = (step: Run["steps"][number]) => step.raw ?? this.raw.get(key, step.id);
    const recipients = recipientLinks([run], rawOf).map(async (link) => {
      if (!link.sessionKey) return;
      const known = link.runId ? transcript.linkedRuns[link.runId] : undefined;
      if (known && isTerminal(known.state)) return;
      if (!link.runId) return note("uncertain", link.sessionKey);
      const params = { sessionKey: link.sessionKey, runId: link.runId };
      for (let attempt = 0; ; attempt += 1) {
        try {
          const stopped = asRecord(await this.request("chat.abort", params));
          // `aborted: false`: nothing of it was running any more.
          if (stopped?.aborted === true) note("bots", link.sessionKey);
          return;
        } catch (error) {
          this.log("warn", `chat.abort of a recipient failed: ${errorMessage(error)}`);
          if (error instanceof GatewayProtocolRequestError) return note("refused", link.sessionKey);
          // No answer: once the connection is back, asked once more.
          if (attempt > 0) return note("unanswered", link.sessionKey);
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          if (!this.protocol) return note("unanswered", link.sessionKey);
          try {
            await this.ensureScope(WRITE_SCOPE);
          } catch {
            return note("unanswered", link.sessionKey);
          }
        }
      }
    });
    await Promise.all(recipients);
  }

  // Approvals -------------------------------------------------------------------

  /**
   * Resolve an approval with the method for its kind: allow once, deny, or a
   * standing allow (`allow-always`), optionally limited to `expiresInDays`
   * days where the gateway takes a duration (exec and the generic kind). Deny
   * is always possible. The gateway offers no field for which bots a standing
   * allow covers. The generic method answers with the approval's actual
   * outcome, which is what the card then shows, even when another reviewer
   * settled it first.
   */
  async resolveApproval(
    key: string,
    approvalId: string,
    decision: ApprovalDecision,
    options: { expiresInDays?: number | null; owner?: object; shownDigest?: string | null } = {},
  ): Promise<void> {
    const approval = this.state.transcripts[key]?.approvals.find((each) => each.id === approvalId);
    if (!approval || approval.status !== "pending")
      throw new Error("That approval is no longer open.");
    // One decision on its way at a time, but a Deny may follow an allow; no allow while
    // an outcome is unknown, and no Deny again while an earlier Deny's is (`decisionRefusal`).
    const refusal = decisionRefusal({ ...approval, ...this.attemptsFor(approvalId) }, decision);
    if (refusal) throw new Error(refusal);
    if (this.attemptsFull(approvalId)) {
      throw new Error(
        "Too many decisions are waiting for an outcome; check them again before deciding another.",
      );
    }
    // Text cut to its bound is allowed only by a viewer this host gave the whole text to, naming
    // the digest of what it was given. A digest the state already carries proves nothing.
    const owner = options.owner ?? DIRECT_CALLER;
    if (
      decision !== "deny" &&
      approval.decisionCut &&
      !this.readWhole(key, approval, owner, options)
    ) {
      throw new Error(
        "This approval's command is too long to show in full; read it whole (readApprovalText) before allowing it, or deny it.",
      );
    }
    if (decision !== "deny" && !approval.allowedDecisions.includes(decision)) {
      throw new Error(`The gateway does not offer ${decision} for this approval.`);
    }
    const days = options.expiresInDays ?? null;
    if (days !== null) {
      if (decision !== "allow-always") throw new Error("Only a standing allow takes a duration.");
      if (approval.kind === "plugin") throw new Error("Plugin approvals take no duration.");
      if (!Number.isInteger(days) || days < 1 || days > MAX_GRANT_DAYS) {
        throw new Error(`A standing allow lasts 1 to ${MAX_GRANT_DAYS} days.`);
      }
    }
    const { method, params } = resolveRequest(approval, decision, days);
    // This decision's attempt: its response settles only it.
    const attempt = this.nextAttempt();
    this.changeAttempts(approvalId, (each) => startDecision(each, decision, attempt), null);
    // Whether the decision left this client: before that, a failure means nothing was sent.
    let sent = false;
    try {
      await this.ensureScope(APPROVALS_SCOPE, options.owner ?? null);
      this.checkNotWithdrawn(options.owner);
      // Access may have taken a while: what is decided must still be the approval that was checked.
      const now = this.state.transcripts[key]?.approvals.find((each) => each.id === approvalId);
      if (
        !now ||
        now.status !== "pending" ||
        now.decisionDigest !== approval.decisionDigest ||
        (decision !== "deny" && now.decisionCut && !this.readWhole(key, now, owner, options))
      ) {
        throw new Error("The approval changed or was settled while access was being approved.");
      }
      sent = true;
      this.updateActivity(key, (activity) => noteSent(activity, approvalId, { method, params }));
      const result = asRecord(await this.request(method, params));
      let resolution: ApprovalResolution | null;
      let applied = true;
      if (method === "approval.resolve") {
        // `{applied, approval}`: the approval as it actually ended.
        resolution = resolutionFromSnapshot(result?.approval, { via: method, record: result });
        applied = result?.applied === true;
        if (!resolution) throw new Error("The gateway did not say how the approval ended.");
      } else {
        // The legacy methods answer `{ok: true}` once the decision is applied.
        resolution = {
          id: approvalId,
          status: decision === "deny" ? "denied" : "allowed",
          decision,
          reason: "user",
          resolvedAt: this.now(),
          resolvedBy: this.host.client.displayName,
          resolver: null,
          applicationStatus: null,
          authoritative: true,
          lossy: false,
          sessionKey: approval.sessionKey,
          runId: approval.runId,
          // The reply as the gateway sent it (`{ok: true}`); its resolved event follows.
          records: [{ via: method, record: result }],
        };
      }
      this.noteApprovalOutcome(resolution);
      this.changeAttempts(approvalId, (each) => finishDecision(each, attempt, "answered"));
      if (!applied) {
        this.updateActivity(key, (activity) =>
          patchError(activity, approvalId, "It had already been settled; this is how it ended."),
        );
      }
    } catch (error) {
      // A gateway error is a refusal of this decision; anything else after sending leaves it unknown.
      // Refused only when the answer establishes the decision was not applied
      // (`approval-refusals.ts`); every other answer after sending is unknown.
      const outcome =
        !sent || error instanceof NotSentError
          ? "not-sent"
          : isRefusedDecision(method, error)
            ? "refused"
            : "unknown";
      // Only this attempt is settled; a decision that lost to one already settled changes nothing.
      // Kept with the approval, so it holds even when no task shows it any more.
      this.changeAttempts(
        approvalId,
        (each) => finishDecision(each, attempt, outcome),
        errorMessage(error),
      );
      this.noteMissingScope(error);
      // Neither answer says whether the request is still open: read it back.
      if (outcome !== "not-sent") void this.checkApproval(key, approvalId).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Read back an approval whose last decision from this client was refused or
   * got no answer (`approval.get`). Settled: the card shows how it ended.
   * Still pending: an unanswered decision was not applied, so the card offers
   * its choices again; a refused one is marked still open. Anything else
   * leaves the card as it is.
   */
  async checkApproval(key: string, approvalId: string): Promise<void> {
    const card = this.state.transcripts[key]?.approvals.find((each) => each.id === approvalId);
    if (card && card.status !== "pending") return;
    if (this.approvalOutcomes.get(capId(approvalId, MAX_ID_CHARS))?.status) return;
    // The approval's own attempts: they hold whether or not a task shows it now.
    const before = this.attemptsFor(approvalId);
    if (before.decisionError === null) return;
    if (!this.holds(APPROVALS_SCOPE)) throw new NotSentError();
    if (this.attemptsFull(approvalId)) throw new NotSentError();
    const generation = this.generation;
    // The read-back's attempt: its pending answer counts only if nothing newer began.
    const attempt = this.nextAttempt();
    this.changeAttempts(approvalId, (each) => startReadback(each, attempt));
    let result: Record<string, unknown> | null;
    try {
      result = asRecord(await this.request("approval.get", { id: approvalId }));
    } finally {
      this.changeAttempts(approvalId, (each) => finishReadback(each, attempt));
    }
    if (generation !== this.generation) return;
    const snapshot = asRecord(result?.approval);
    const resolution = resolutionFromSnapshot(snapshot, {
      via: "approval.get",
      record: result,
    });
    if (resolution && resolution.id === approvalId) {
      // A settled request is evidence of the winner whenever it was read.
      this.noteApprovalOutcome(resolution);
      if (before.decisionError === "refused") {
        this.forEachCard(approvalId, (key) =>
          this.updateActivity(key, (activity) =>
            patchError(activity, approvalId, "It had already been settled; this is how it ended."),
          ),
        );
      }
      return;
    }
    if (snapshot?.id !== approvalId || snapshot.status !== "pending") {
      throw new Error("The gateway did not say whether the request is still open.");
    }
    let stale = false;
    let cleared = false;
    this.changeAttempts(approvalId, (each) => {
      const read = readbackStillPending(each, attempt);
      stale = read.stale;
      cleared = read.cleared;
      return read.card;
    });
    if (cleared) {
      this.forEachCard(approvalId, (key) =>
        this.updateActivity(key, (activity) => patchError(activity, approvalId, null)),
      );
    }
    // A newer attempt began while this was read: its answer proves nothing now. Read again,
    // unless a newer read-back is already on its way to decide it.
    const now = this.attemptsFor(approvalId);
    if (stale && now.decisionError === "unknown" && now.readingAt === null) {
      void this.checkApproval(key, approvalId).catch(() => undefined);
    }
  }

  // Attempts kept with the approval --------------------------------------------

  private nextAttempt(): number {
    this.attemptSeq += 1;
    return this.attemptSeq;
  }

  /** An approval's attempts: those kept for it, else those its card shows, else none. */
  private attemptsFor(approvalId: string): ApprovalAttempts {
    const kept = this.approvalAttempts.get(capId(approvalId, MAX_ID_CHARS));
    if (kept) return kept;
    for (const transcript of Object.values(this.state.transcripts)) {
      const card = transcript.approvals.find((each) => each.id === approvalId);
      if (card && card.status === "pending") return attemptsOf(card);
    }
    return NO_ATTEMPTS;
  }

  /** Whether keeping one more approval's attempts would pass the bound. */
  private attemptsFull(approvalId: string): boolean {
    return (
      !this.approvalAttempts.has(capId(approvalId, MAX_ID_CHARS)) &&
      this.approvalAttempts.size >= MAX_APPROVAL_ATTEMPTS
    );
  }

  /** Every followed task that shows this approval. */
  private forEachCard(approvalId: string, fn: (key: string) => void): void {
    for (const transcript of Object.values(this.state.transcripts)) {
      if (transcript.approvals.some((each) => each.id === approvalId)) fn(transcript.sessionKey);
    }
  }

  /**
   * Change an approval's attempts where they are kept, then on every card
   * that shows it. Kept while anything is outstanding and the approval is not
   * settled; `error`, when given, is what its cards say.
   */
  private changeAttempts(
    approvalId: string,
    change: (attempts: ApprovalAttempts) => ApprovalAttempts,
    error?: string | null,
  ): void {
    const id = capId(approvalId, MAX_ID_CHARS);
    const next = enforce(APPROVAL_ATTEMPTS, attemptsOf(change(this.attemptsFor(approvalId))));
    this.approvalAttempts.delete(id);
    const settled = this.approvalOutcomes.get(id) !== undefined;
    if (!settled && !attemptsSettled(next) && this.approvalAttempts.size < MAX_APPROVAL_ATTEMPTS) {
      this.approvalAttempts.set(id, next);
    }
    this.forEachCard(approvalId, (key) =>
      this.updateActivity(key, (activity) => ({
        ...activity,
        approvals: activity.approvals.map((card) => {
          // A settled card shows how it ended: a late answer changes nothing on it.
          if (card.id !== approvalId || card.status !== "pending") return card;
          const shown = { ...card, ...next };
          return error === undefined ? shown : { ...shown, error };
        }),
      })),
    );
  }

  /**
   * Draw every pending card from its approval's kept attempts. A card that a
   * task admits while something is outstanding (the task opened again, or the
   * approval came back in a list) starts a new attempt: its outcome is unknown
   * until a read-back sent after this answers.
   */
  private withKeptAttempts(before: TaskActivity | undefined, activity: TaskActivity): TaskActivity {
    if (this.approvalAttempts.size === 0) return activity;
    let changed = false;
    const approvals = activity.approvals.map((card) => {
      if (card.status !== "pending") return card;
      const id = capId(card.id, MAX_ID_CHARS);
      let kept = this.approvalAttempts.get(id);
      if (!kept) return card;
      if (!before?.approvals.some((each) => each.id === card.id)) {
        kept = reopenAttempts(kept, this.nextAttempt());
        this.approvalAttempts.set(id, kept);
        // Read back after this, outside the change being made.
        const approvalId = card.id;
        void Promise.resolve().then(() =>
          this.checkApproval(this.keyShowing(approvalId), approvalId).catch(() => undefined),
        );
      }
      if (sameAttempts(card, kept)) return card;
      changed = true;
      return { ...card, ...kept };
    });
    return changed ? { ...activity, approvals } : activity;
  }

  /** A followed task that shows this approval, or "" when none does. */
  private keyShowing(approvalId: string): string {
    for (const transcript of Object.values(this.state.transcripts)) {
      if (transcript.approvals.some((each) => each.id === approvalId)) return transcript.sessionKey;
    }
    return "";
  }

  /**
   * Remember what the gateway reported about an approval and apply it to every
   * task showing it. Kept apart from the cards, so a request or list entry that
   * arrives later can never make it actionable again.
   */
  private noteApprovalOutcome(resolution: ApprovalResolution): void {
    // Kept, and keyed, as bounded: the id under its cap, like the cards' ids.
    const known = enforce(
      APPROVAL_OUTCOME,
      mergeResolution(this.approvalOutcomes.get(capId(resolution.id, MAX_ID_CHARS)), resolution),
    );
    if (known.lossy) void this.lookUpOutcome(known.id);
    this.approvalOutcomes.delete(known.id);
    this.approvalOutcomes.set(known.id, known);
    // Settled: nothing about it is outstanding any more.
    this.approvalAttempts.delete(known.id);
    while (this.approvalOutcomes.size > MAX_APPROVAL_OUTCOMES) {
      this.approvalOutcomes.delete(this.approvalOutcomes.keys().next().value as string);
    }
    if (this.unrouted.delete(known.id)) this.publishUnrouted();
    for (const transcript of Object.values(this.state.transcripts)) {
      if (transcript.approvals.some((approval) => approval.id === known.id)) {
        this.updateActivity(transcript.sessionKey, (activity) =>
          applyApprovalResolved(activity, known),
        );
      }
    }
    // A settled approval makes room for one that was waiting.
    this.routeUnrouted();
  }

  /** Whether this viewer was given this approval's whole text, and names the digest of what it was given. */
  private readWhole(
    key: string,
    approval: ApprovalCard,
    owner: object,
    options: { shownDigest?: string | null },
  ): boolean {
    const read = this.approvalReads.get(`${key}\u0000${approval.id}`)?.get(owner);
    return read !== undefined && read === approval.decisionDigest && options.shownDigest === read;
  }

  /** Remember that a viewer was given an approval's whole text, keeping only reads of pending approvals. */
  private noteApprovalRead(key: string, approvalId: string, owner: object, digest: string): void {
    for (const readKey of [...this.approvalReads.keys()]) {
      const [task, id] = readKey.split("\u0000") as [string, string];
      const pending = this.state.transcripts[task]?.approvals.some(
        (each) => each.id === id && each.status === "pending",
      );
      if (!pending || !this.tracked(task)) this.approvalReads.delete(readKey);
    }
    const readKey = `${key}\u0000${approvalId}`;
    const readers = this.approvalReads.get(readKey) ?? new Map<object, string>();
    readers.delete(owner);
    readers.set(owner, digest);
    while (readers.size > MAX_APPROVAL_READERS)
      readers.delete(readers.keys().next().value as object);
    this.approvalReads.set(readKey, readers);
  }

  /**
   * A legacy exec or plugin resolution said `deny`, which the gateway also
   * sends when it cancelled the approval or it expired: read the approval's
   * own snapshot (`approval.get`, under the `operator.approvals` the client
   * already holds) for how it ended. Until it answers, or if it cannot, the
   * approval shows closed with its cause unknown, never as a denial.
   */
  private async lookUpOutcome(id: string): Promise<void> {
    if (this.lookingUp.has(id) || this.lookingUp.size >= MAX_OUTCOME_LOOKUPS) return;
    if (!this.holds(APPROVALS_SCOPE)) return;
    const generation = this.generation;
    this.lookingUp.add(id);
    try {
      const result = asRecord(await this.request("approval.get", { id }));
      if (generation !== this.generation) return;
      const resolution = resolutionFromSnapshot(result?.approval, {
        via: "approval.get",
        record: result,
      });
      if (resolution && resolution.id === id) this.noteApprovalOutcome(resolution);
    } catch (error) {
      if (generation === this.generation) this.noteMissingScope(error);
      this.log("warn", `approval.get failed: ${errorMessage(error)}`);
    } finally {
      this.lookingUp.delete(id);
    }
  }

  /**
   * The followed task an approval belongs in, and how it got there: where it
   * already is; its own session; the task holding its run; the task that
   * spawned its session (a helper); or the task whose `sessions_send` result
   * named its run, or, for an approval naming no run, its session (a messaged
   * bot). Null when no followed task is known to be its origin.
   */
  private approvalTarget(
    card: ApprovalCard,
  ): { key: string; parent: string | null; relation: ApprovalCard["relation"] } | null {
    const transcripts = Object.values(this.state.transcripts).filter((each) =>
      this.tracked(each.sessionKey),
    );
    for (const transcript of transcripts) {
      const existing = transcript.approvals.find((approval) => approval.id === card.id);
      if (existing) {
        return {
          key: transcript.sessionKey,
          parent: existing.parentSessionKey,
          relation: existing.relation,
        };
      }
    }
    if (card.sessionKey && this.tracked(card.sessionKey)) {
      return { key: card.sessionKey, parent: null, relation: null };
    }
    if (card.runId) {
      const holder = transcripts.find((each) => findRun(each, card.runId!) !== undefined);
      if (holder) return { key: holder.sessionKey, parent: null, relation: null };
    }
    const spawner = card.sessionKey ? this.spawnedBy.get(card.sessionKey) : undefined;
    if (spawner && this.tracked(spawner)) {
      return { key: spawner, parent: spawner, relation: "helper" };
    }
    for (const [key, links] of this.recipients) {
      if (!this.tracked(key)) continue;
      if (
        (card.runId !== null && links.runs.has(card.runId)) ||
        (card.runId === null && card.sessionKey !== null && links.sessions.has(card.sessionKey))
      ) {
        return { key, parent: key, relation: "messaged" };
      }
    }
    return null;
  }

  /**
   * Put a pending approval in the one task it belongs to, with where it came
   * from. One no followed task can show yet is kept in `unroutedApprovals`
   * until its origin is known. What the gateway already reported about it is
   * applied at once, so it never shows as actionable after its resolution.
   */
  private routeApproval(card: ApprovalCard): void {
    const outcome = this.approvalOutcomes.get(card.id);
    const target = this.approvalTarget(card);
    if (!target) {
      if (!outcome && card.status === "pending") this.keepUnrouted(card);
      return;
    }
    const shown = this.state.transcripts[target.key]?.approvals.some((each) => each.id === card.id);
    if (!shown && !outcome && !this.hasPendingRoom(target.key)) {
      // The task shows as many pending approvals as it may: this one waits, kept and visible.
      this.keepUnrouted({ ...card, parentSessionKey: target.parent, relation: target.relation });
      return;
    }
    if (this.unrouted.delete(card.id)) this.publishUnrouted();
    this.updateActivity(target.key, (activity) => {
      let next = applyApprovalRequested(activity, {
        ...card,
        parentSessionKey: target.parent,
        relation: target.relation,
      });
      if (outcome) next = applyApprovalResolved(next, outcome);
      return next;
    });
  }

  /** Keep an approval no task shows yet; past the bound it is not kept and is counted instead. */
  private keepUnrouted(received: ApprovalCard): void {
    // Only the bounded card is kept, never the one received beside it.
    const card = admitApproval(received);
    if (!this.unrouted.has(card.id) && this.unrouted.size >= MAX_UNROUTED_APPROVALS) {
      this.unroutedOmitted += 1;
      this.publishUnrouted();
      return;
    }
    this.unrouted.set(card.id, card);
    this.publishUnrouted();
  }

  private publishUnrouted(): void {
    this.store.update((state) => ({
      ...state,
      unroutedApprovals: [...this.unrouted.values()],
      unroutedApprovalsOmitted: this.unroutedOmitted,
    }));
  }

  /** Whether a task can show one more pending approval. */
  private hasPendingRoom(key: string, extra = 0): boolean {
    const pending = (this.state.transcripts[key]?.approvals ?? []).filter(
      (approval) => approval.status === "pending",
    ).length;
    return pending + extra < MAX_PENDING_APPROVALS_PER_TASK;
  }

  /** Approvals kept without a task: route the ones whose origin is now known. */
  private routeUnrouted(): void {
    if (this.unrouted.size === 0) return;
    for (const card of [...this.unrouted.values()]) {
      if (this.approvalTarget(card)) this.routeApproval(card);
    }
  }

  /**
   * Pending approvals for one task, from `exec.approval.list`,
   * `plugin.approval.list` and `openclaw.approval.list`, when it opens and
   * after every reconnect. Each list is read against a revision and the
   * task's opening: a response older than one already applied, or from an
   * earlier opening or connection, changes nothing. Each kind's access is kept
   * apart, and a list refused for a missing scope drops that scope. On a
   * connection without `operator.approvals` the task says approvals are
   * unavailable.
   */
  private async backfillApprovals(key: string, generation: number): Promise<void> {
    if (!this.holds(APPROVALS_SCOPE)) {
      for (const kind of APPROVAL_KINDS) this.setApprovalSource(key, kind, "unavailable");
      return;
    }
    await Promise.all(
      APPROVAL_SOURCES.map((source) => this.backfillApprovalKind(key, source, generation)),
    );
  }

  private async backfillApprovalKind(
    key: string,
    source: (typeof APPROVAL_SOURCES)[number],
    generation: number,
  ): Promise<void> {
    const incarnation = this.incarnations.get(key);
    const listKey = `${key}\u0000${source.kind}`;
    const revision = (this.listRequested.get(listKey) ?? 0) + 1;
    this.listRequested.set(listKey, revision);
    const stale = () =>
      generation !== this.generation ||
      !this.tracked(key) ||
      this.incarnations.get(key) !== incarnation ||
      (this.listApplied.get(listKey) ?? 0) > revision;
    if (this.state.transcripts[key]?.approvalSources[source.kind] !== "ready")
      this.setApprovalSource(key, source.kind, "loading");
    // Only approvals pending now can be found settled by this list; later arrivals are newer than it.
    const pendingBefore = new Set(
      (this.state.transcripts[key]?.approvals ?? [])
        .filter((approval) => approval.status === "pending" && approval.kind === source.kind)
        .map((approval) => approval.id),
    );
    let value: unknown;
    try {
      value = await this.request(source.method, {});
    } catch (error) {
      if (stale()) return;
      // A failure is this revision's answer too: an older list arriving later changes nothing.
      this.listApplied.set(listKey, revision);
      this.noteMissingScope(error);
      this.setApprovalSource(key, source.kind, isMissingScope(error) ? "unavailable" : "error");
      this.log("warn", `${source.method} failed: ${errorMessage(error)}`);
      return;
    }
    if (stale()) return;
    this.listApplied.set(listKey, revision);
    const record = asRecord(value);
    const items = Array.isArray(value)
      ? value
      : Array.isArray(record?.approvals)
        ? record.approvals
        : Array.isArray(record?.items)
          ? record.items
          : [];
    const mine: ApprovalCard[] = [];
    const shownIds = new Set((this.state.transcripts[key]?.approvals ?? []).map((each) => each.id));
    let added = 0;
    for (const card of items
      .map((item) => source.parse(item))
      .filter((each): each is ApprovalCard => each !== null && each.status === "pending")
      .map(admitApproval)) {
      const target = this.approvalTarget(card);
      if (target?.key !== key) {
        if (!target && !this.approvalOutcomes.has(card.id)) this.keepUnrouted(card);
        continue;
      }
      const placed = { ...card, parentSessionKey: target.parent, relation: target.relation };
      const settled = this.approvalOutcomes.has(card.id);
      if (shownIds.has(card.id) || settled || this.hasPendingRoom(key, added)) {
        if (!shownIds.has(card.id) && !settled) added += 1;
        mine.push(placed);
        if (this.unrouted.delete(card.id)) this.publishUnrouted();
      } else {
        // The task shows as many pending approvals as it may: this one waits, kept and visible.
        this.keepUnrouted(placed);
      }
    }
    const pendingNow = this.pendingApprovalIds(key);
    this.updateActivity(key, (activity) => {
      let next = activity;
      for (const card of mine) {
        next = applyApprovalRequested(next, card);
        const outcome = this.approvalOutcomes.get(card.id);
        if (outcome) next = applyApprovalResolved(next, outcome);
      }
      return settleUnlistedApprovals(
        next,
        [source.kind],
        new Set(mine.map((card) => card.id)),
        pendingBefore,
      );
    });
    this.lookUpInferred(key, pendingNow);
    // Another list may have been refused for the scope meanwhile: this one cannot be kept current then.
    this.setApprovalSource(key, source.kind, this.holds(APPROVALS_SCOPE) ? "ready" : "unavailable");
  }

  private setApprovalSource(key: string, kind: ApprovalKind, access: ApprovalSourceAccess): void {
    const transcript = this.state.transcripts[key];
    if (!transcript || transcript.approvalSources[kind] === access) return;
    const approvalSources = { ...transcript.approvalSources, [kind]: access };
    this.setTranscript(key, () => ({
      ...transcript,
      approvalSources,
      approvalAccess: approvalAccessOf(approvalSources),
    }));
  }

  private pendingApprovalIds(key: string): Set<string> {
    return new Set(
      (this.state.transcripts[key]?.approvals ?? [])
        .filter((approval) => approval.status === "pending")
        .map((approval) => approval.id),
    );
  }

  /**
   * Approvals this client has just closed by inference (past their expiry, or
   * no longer listed) are read back one by one (`approval.get`): the gateway's
   * snapshot of a settled request says how it ended, its decision and its
   * terminal reason, which then replace the inference. Each is asked once, when
   * the inference is made; one that cannot be read stays inferred.
   */
  private lookUpInferred(key: string, pendingBefore: ReadonlySet<string>): void {
    for (const approval of this.state.transcripts[key]?.approvals ?? []) {
      if (approval.inferred && approval.status !== "pending" && pendingBefore.has(approval.id))
        void this.lookUpOutcome(approval.id);
    }
  }

  /** Expire pending approvals at their `expiresAt`, then re-read the lists to confirm. */
  private scheduleApprovalExpiry(key: string): void {
    const transcript = this.state.transcripts[key];
    const existing = this.expiryTimers.get(key);
    if (existing) clearTimeout(existing);
    this.expiryTimers.delete(key);
    const next = Math.min(
      ...(transcript?.approvals ?? [])
        .filter((approval) => approval.status === "pending" && approval.expiresAt !== null)
        .map((approval) => approval.expiresAt!),
    );
    if (!Number.isFinite(next)) return;
    this.expiryTimers.set(
      key,
      setTimeout(
        () => {
          this.expiryTimers.delete(key);
          const pendingNow = this.pendingApprovalIds(key);
          this.updateActivity(key, (activity) => expireApprovals(activity, this.now()));
          this.lookUpInferred(key, pendingNow);
          void this.backfillApprovals(key, this.generation);
        },
        // setTimeout fires at once past 2^31-1 ms; re-check at that horizon instead.
        Math.min(MAX_TIMER_MS, Math.max(0, next - this.now())),
      ),
    );
  }

  // Linked runs -------------------------------------------------------------------

  /** Apply an event to a session nobody has open, keeping a few recent runs of a few sessions. */
  private updateForeign(
    rawKey: string,
    fn: (activity: TaskActivity, ctx: EngineContext) => TaskActivity,
  ): void {
    // Kept under the id cap, as the state keeps ids.
    const sessionKey = capId(rawKey, MAX_ID_CHARS);
    const before = this.foreign.get(sessionKey) ?? emptyActivity;
    let next = fn(before, { sessionKey, now: this.now(), raw: this.foreignRaw });
    if (next === before) return;
    if (next.runs.length > FOREIGN_RUNS_PER_SESSION) {
      next = { ...next, runs: next.runs.slice(-FOREIGN_RUNS_PER_SESSION) };
    }
    // Steps of foreign runs are not shown; keep only the run states, within the run bound.
    next = {
      ...next,
      runs: next.runs.map((run) => enforce(RUN, run.steps.length ? { ...run, steps: [] } : run)),
    };
    // The id pairs the session's turns were named by, newest kept, as a task's own are.
    const aliasKeys = Object.keys(next.queueAliases);
    if (aliasKeys.length > MAX_QUEUE_ALIASES)
      next = {
        ...next,
        queueAliases: Object.fromEntries(
          aliasKeys.slice(-MAX_QUEUE_ALIASES).map((key) => [key, next.queueAliases[key]!]),
        ),
      };
    this.foreign.delete(sessionKey);
    this.foreign.set(sessionKey, next);
    while (this.foreign.size > FOREIGN_SESSIONS) {
      const oldest = this.foreign.keys().next().value as string;
      this.foreign.delete(oldest);
    }
    const changed = next.runs.some((run) => findRun(before, run.id)?.state !== run.state);
    if (!changed) return;
    for (const key of Object.keys(this.state.transcripts)) {
      this.refreshLinkedRuns(key);
      // An approval from a helper or a messaged bot follows that run's end.
      if (this.state.transcripts[key]?.approvals.some((approval) => approval.relation !== null))
        this.updateActivity(key, (activity) => activity);
    }
  }

  /**
   * A session the gateway deleted while nobody had it open: its runs this client
   * followed are over, however they stood, and a question they waited on is no
   * longer asked. They settle as ended with no known outcome, so a card that
   * follows them stops showing them working or waiting, and the entry goes.
   */
  private retireForeign(rawKey: string): void {
    const sessionKey = capId(rawKey, MAX_ID_CHARS);
    if (this.foreign.has(sessionKey)) {
      this.updateForeign(sessionKey, (activity, ctx) =>
        activity.runs.some((run) => !isTerminal(run.state))
          ? {
              ...activity,
              runs: activity.runs.map((run) =>
                isTerminal(run.state)
                  ? run
                  : { ...finishRun(run, "cancelled", ctx), outcomeKnown: false },
              ),
            }
          : activity,
      );
      this.foreign.delete(sessionKey);
    }
    // A deletion supersedes every read of this session on its way.
    for (const token of this.foreignReads.get(sessionKey) ?? []) token.cancelled = true;
    this.foreignReads.delete(sessionKey);
  }

  /** A run this task does not hold: a followed foreign session's, or another task's. */
  private otherRun(runId: string): Run | undefined {
    for (const activity of this.foreign.values()) {
      const run = findRun(activity, runId);
      if (run) return run;
    }
    for (const transcript of Object.values(this.state.transcripts)) {
      const run = findRun(transcript, runId);
      if (run) return run;
    }
    return undefined;
  }

  /**
   * Read the gateway's current map from tool-server tools' effective names to
   * their servers and tools for a task (`tools.effective`, `operator.read`),
   * after its history loads and whenever the gateway reports its plugins
   * changed. Evidence for a call before its result only; a failed read keeps
   * the map there was. One read of a task at a time: one asked for while it
   * is in flight is made once it has answered, so a newer answer is always the
   * one applied last.
   */
  private async readToolMap(key: string, generation: number): Promise<void> {
    const running = this.toolReads.get(key);
    if (running) {
      running.again = true;
      return;
    }
    const read = { again: false };
    this.toolReads.set(key, read);
    try {
      do {
        read.again = false;
        await this.readToolMapOnce(key, generation);
      } while (read.again && generation === this.generation && this.tracked(key));
    } finally {
      if (this.toolReads.get(key) === read) this.toolReads.delete(key);
    }
  }

  private async readToolMapOnce(key: string, generation: number): Promise<void> {
    const incarnation = this.incarnations.get(key);
    let answer: unknown;
    try {
      answer = await this.request("tools.effective", { sessionKey: key });
    } catch (error) {
      if (generation === this.generation)
        this.log("warn", `tools.effective failed: ${errorMessage(error)}`);
      return;
    }
    if (
      generation !== this.generation ||
      !this.tracked(key) ||
      this.incarnations.get(key) !== incarnation
    ) {
      return;
    }
    const map = mcpToolMap(answer, MAX_MCP_TOOLS);
    const builtin = builtinToolNames(answer, MAX_BUILTIN_TOOLS);
    const current = this.state.transcripts[key];
    if (
      !current ||
      (JSON.stringify(current.mcpTools) === JSON.stringify(map) &&
        JSON.stringify(current.builtinTools) === JSON.stringify(builtin))
    )
      return;
    this.setTranscript(key, () => ({
      ...this.state.transcripts[key]!,
      mcpTools: map,
      builtinTools: builtin,
    }));
  }

  /**
   * Read the reactions on a task's messages (`session.reactions.list`, `operator.read`) once its
   * history loads, keeping those of the messages it shows. Later changes come as
   * `session.reaction` events. A failed read leaves what was shown before (F-283).
   */
  private async readReactions(key: string, generation: number, attempt = 0): Promise<void> {
    const incarnation = this.incarnations.get(key);
    const epoch = this.epoch;
    const currentConnection = () => generation === this.generation && epoch === this.epoch;
    let answer: unknown;
    let before: Transcript["reactions"];
    try {
      if (this.selfId === null) await this.readSelf(currentConnection);
      if (!currentConnection()) return;
      // What the list will replace: an event, a change of this person's or a new history page
      // after it was asked for is newer than the list, and the list then gives way to it.
      before = this.state.transcripts[key]?.reactions;
      answer = await this.request("session.reactions.list", { sessionKey: key });
    } catch (error) {
      if (currentConnection())
        this.log("warn", `session.reactions.list failed: ${errorMessage(error)}`);
      return;
    }
    if (!currentConnection() || !this.tracked(key) || this.incarnations.get(key) !== incarnation)
      return;
    if (this.state.transcripts[key]!.reactions !== before) {
      // Changed while the list was on its way: ask again, a few times, rather than go back.
      if (attempt < REACTION_LIST_ATTEMPTS - 1)
        void this.readReactions(key, generation, attempt + 1);
      return;
    }
    const listed = asRecord(asRecord(answer)?.reactions) ?? {};
    this.setTranscript(key, () => {
      const current = this.state.transcripts[key]!;
      const shown = shownMessageIds(current);
      const reactions: Record<string, MessageReaction[]> = {};
      for (const [messageId, summary] of Object.entries(listed)) {
        if (!shown.has(messageId)) continue;
        const kept = reactionsOf(summary, this.selfId);
        if (kept.length > 0) reactions[messageId] = kept;
      }
      return { ...current, reactions };
    });
  }

  /**
   * What the composer's "/" or "@" menu lists for a task (`composer-menus.ts`), read now and
   * kept nowhere (F-071, F-070). Each read is `operator.read`.
   */
  async readComposerMenu(key: string, trigger: "/" | "@"): Promise<MenuRow[]> {
    if (this.state.connection.status !== "connected")
      throw new Error("Not connected to the gateway.");
    if (trigger === "@") {
      const generation = this.generation;
      const routines = await this.request("cron.list", {}).catch(() => null);
      // The bots are read now: from the gateway the routines came from, or not at all.
      if (generation !== this.generation)
        throw new Error("The gateway changed while the list was read.");
      return mentionRows(this.state.bots, routines);
    }
    const agentId = botIdFromSessionKey(key);
    const [skills, metadata] = await Promise.all([
      agentId ? this.request("skills.status", { agentId }).catch(() => null) : null,
      this.request("chat.metadata", { sessionKey: key }).catch(() => null),
    ]);
    if (skills === null && metadata === null) throw new Error("The gateway did not list them.");
    return slashRows(skills, metadata);
  }

  /**
   * Who this connection acts for (`users.self`), for which reactions are the person's own.
   * `current` says whether the answer still applies when it arrives.
   */
  private async readSelf(current: () => boolean): Promise<void> {
    try {
      const answer = asRecord(await this.request("users.self", {}));
      if (!current()) return;
      const id = asRecord(answer?.profile)?.id;
      this.selfId = typeof id === "string" && id.length <= MAX_ID_CHARS ? id : null;
    } catch {
      // A refusal on an earlier connection says nothing of a later one's identity.
      if (current()) this.selfId = null;
    }
  }

  /**
   * Add or remove this person's reaction on a message (`session.reactions.set`,
   * `operator.write`). The gateway's answer is the message's reactions now (F-283).
   */
  async setReaction(
    key: string,
    messageId: string,
    emoji: string,
    remove: boolean,
    options: { owner?: object } = {},
  ): Promise<void> {
    const transcript = this.state.transcripts[key];
    if (!transcript) throw new Error("Open the task before reacting in it.");
    if (!shownMessageIds(transcript).has(messageId))
      throw new Error("That message is no longer shown here.");
    if (typeof emoji !== "string" || !emoji || emoji.length > 64)
      throw new Error("Choose one emoji.");
    if (this.options.readOnly) throw new Error("This host only reads; it does not react.");
    // A scope upgrade reconnects to the same address and keeps the opening of the task.
    const url = this.settings?.url;
    const incarnation = this.incarnations.get(key);
    await this.ensureScope(WRITE_SCOPE, options.owner ?? null);
    if (this.settings?.url !== url) throw new Error("That message is no longer shown here.");
    // From the identity read through the write, a new connection can act for a different person.
    const generation = this.generation;
    const epoch = this.epoch;
    const sameConnection = () => generation === this.generation && epoch === this.epoch;
    if (this.selfId === null) await this.readSelf(sameConnection);
    // After every wait, immediately before the write: its viewer is still here, and the same
    // opening of the task still shows the message.
    this.checkNotWithdrawn(options.owner);
    const now = this.state.transcripts[key];
    if (
      !sameConnection() ||
      this.incarnations.get(key) !== incarnation ||
      !now ||
      !shownMessageIds(now).has(messageId)
    )
      throw new Error("That message is no longer shown here.");
    // Any change of the task's reactions after the request is newer than its answer.
    const before = this.state.transcripts[key]?.reactions;
    let answer: RawRecord | null;
    try {
      answer = asRecord(
        await this.request("session.reactions.set", {
          sessionKey: key,
          messageId,
          emoji,
          ...(remove ? { remove: true } : {}),
        }),
      );
    } catch (error) {
      if (sameConnection()) this.noteMissingScope(error);
      throw error;
    }
    if (!sameConnection() || !this.tracked(key) || this.incarnations.get(key) !== incarnation)
      return;
    if (this.state.transcripts[key]?.reactions !== before) {
      // Something newer changed them: the gateway's list says what is true now.
      void this.readReactions(key, this.generation);
      return;
    }
    this.applyReactions(key, messageId, answer?.reactions);
  }

  /** A message's reactions as the gateway now counts them, kept if the task shows the message. */
  private applyReactions(key: string, messageId: string, summary: unknown): void {
    const current = this.state.transcripts[key];
    if (!current || !shownMessageIds(current).has(messageId)) return;
    const kept = reactionsOf(summary, this.selfId);
    this.setTranscript(key, () => {
      const latest = this.state.transcripts[key]!;
      const reactions = { ...latest.reactions };
      if (kept.length > 0) reactions[messageId] = kept;
      else delete reactions[messageId];
      return { ...latest, reactions };
    });
  }

  /**
   * Two runs of the task still look active, after a history read or from live events alone: one
   * whose end this client missed, beside the one the gateway runs now. Stop names neither until
   * one is current, so each is asked of the gateway's own run record (`agent.wait` with no wait,
   * `operator.write`). A run it reports over settles as it reports; one it reports still going,
   * or does not know, stays as it is. One check at a time per task, and one per set of runs
   * until the next history read, so answers that change nothing ask nothing more.
   */
  private async settleEndedRuns(key: string): Promise<void> {
    const transcript = this.state.transcripts[key];
    const first = transcript && activeRun(transcript);
    if (!first || runningRunId(transcript, first.id) !== null) return;
    if (!this.state.connection.canWrite || this.options.readOnly) return;
    const asked = transcript.runs.filter((run) => run.bound && isActive(run.state));
    const runIds = asked.map((run) => run.id).join("\u0000");
    if (this.endChecking.has(key) || this.endChecked.get(key) === runIds) return;
    this.endChecking.add(key);
    this.endChecked.set(key, runIds);
    const generation = this.generation;
    const incarnation = this.incarnations.get(key);
    try {
      await Promise.all(
        asked.map(async (run) => {
          let answer: RawRecord | null;
          try {
            answer = asRecord(await this.request("agent.wait", { runId: run.id, timeoutMs: 0 }));
          } catch (error) {
            if (generation === this.generation)
              this.log("warn", `agent.wait failed: ${errorMessage(error)}`);
            return;
          }
          if (
            !answer ||
            generation !== this.generation ||
            this.incarnations.get(key) !== incarnation
          )
            return;
          this.updateActivity(key, (activity, ctx) =>
            settleRunFromWait(activity, run.id, answer, ctx),
          );
        }),
      );
    } finally {
      this.endChecking.delete(key);
    }
    // Runs that started while this check was on its way are asked now, unless they are the same set.
    void this.settleEndedRuns(key);
  }

  /**
   * Read the bot's workspace root, as the gateway names it
   * (`agents.files.list`, `operator.read`, its `workspace`), once a task's
   * history loads. A failed read leaves it unknown: an absolute path is then
   * never read as a memory note (8.2).
   */
  private async readWorkspaceRoot(key: string, generation: number): Promise<void> {
    const botId = botIdFromSessionKey(key);
    if (!botId) return;
    const incarnation = this.incarnations.get(key);
    let answer: unknown;
    try {
      answer = await this.request("agents.files.list", { agentId: botId });
    } catch (error) {
      if (generation === this.generation)
        this.log("warn", `agents.files.list failed: ${errorMessage(error)}`);
      return;
    }
    if (
      generation !== this.generation ||
      !this.tracked(key) ||
      this.incarnations.get(key) !== incarnation
    )
      return;
    const root = asRecord(answer)?.workspace;
    const workspaceRoot = typeof root === "string" && root.startsWith("/") ? root : null;
    const current = this.state.transcripts[key];
    if (!current || current.workspaceRoot === workspaceRoot) return;
    this.setTranscript(key, () => ({ ...this.state.transcripts[key]!, workspaceRoot }));
  }

  /**
   * A recipient run a task's sends name that this client follows nowhere: its task was let go
   * while the sender's was not open, or it was never seen. The recipient's own history says
   * where it stands (in flight, or ended as its rows show), and from then on it is followed as
   * a session nobody has open, so the sender's card shows what the gateway established and
   * keeps up with it, rather than reading Sent. One read per recipient session, after each of
   * the sender's history reads, for the newest `MAX_LINKED_RUNS` recipients.
   */
  private async readRecipients(key: string, generation: number): Promise<void> {
    const transcript = this.state.transcripts[key];
    if (!transcript) return;
    const rawOf = (step: Run["steps"][number]) => step.raw ?? this.raw.get(key, step.id);
    const missing = new Map<string, Set<string>>();
    for (const link of recipientLinks(transcript.runs, rawOf).slice(-MAX_LINKED_RUNS)) {
      if (!link.runId || !link.sessionKey) continue;
      const runId = capId(link.runId, MAX_ID_CHARS);
      const sessionKey = capId(link.sessionKey, MAX_ID_CHARS);
      if (transcript.linkedRuns[runId] || this.tracked(sessionKey)) continue;
      if (this.foreign.get(sessionKey)?.runs.some((run) => run.id === runId)) continue;
      missing.set(sessionKey, (missing.get(sessionKey) ?? new Set()).add(runId));
    }
    for (const [sessionKey, ids] of missing) {
      if (generation !== this.generation || !this.tracked(key)) return;
      await this.readRecipientRuns(sessionKey, ids, generation, key);
    }
  }

  private async readRecipientRuns(
    sessionKey: string,
    ids: Set<string>,
    generation: number,
    senderKey?: string,
    terminal: {
      phase: "end" | "error";
      pairs: ReadonlyArray<readonly [string, string]>;
    } | null = null,
  ): Promise<void> {
    // The read carries its own invalidation token: a deletion of this session
    // cancels it, however many deletions of other sessions follow, and nothing
    // else does. Admission stays within the map and per-session caps.
    const token = { cancelled: false };
    let tokens = this.foreignReads.get(sessionKey);
    if (!tokens) {
      if (this.foreignReads.size >= MAX_FOREIGN_READ_SESSIONS) return;
      tokens = new Set();
      this.foreignReads.set(sessionKey, tokens);
    }
    if (tokens.size >= MAX_FOREIGN_READS_PER_SESSION) return;
    tokens.add(token);
    try {
      // What this read may settle was active before it was asked, so a run whose
      // live start arrives while the request is pending outlives a stale answer.
      const activeBefore = new Set(
        (this.foreign.get(sessionKey)?.runs ?? [])
          .filter((run) => ids.has(run.id) && !isTerminal(run.state))
          .map((run) => run.id),
      );
      let history: RawRecord | null;
      try {
        history = asRecord(await this.request("chat.history", { sessionKey, limit: 40 }));
      } catch {
        return;
      }
      if (
        generation !== this.generation ||
        this.tracked(sessionKey) ||
        (senderKey !== undefined && !this.tracked(senderKey)) ||
        // A deletion of this session while the read was on its way supersedes it.
        token.cancelled
      )
        return;
      const aliases = Object.fromEntries([
        ...(terminal?.pairs ?? []),
        ...historyQueuePairs(history?.messages),
      ]);
      const { messages, inFlight } = throughRunAliases(
        history?.messages,
        asRecord(history?.inFlightRun),
        aliases,
      );
      const ctx = { sessionKey, now: this.now(), raw: this.foreignRaw };
      const busy = inFlight !== null || holdsInput(history);
      const found = runsFromHistory(messages, inFlight, ctx, { busy }).filter((run) =>
        ids.has(run.id),
      );
      const historyIds = new Set(found.map((run) => run.id));
      // Ends history does not establish: a busy read leaves the newest rows' run
      // open, and an end history holds only in its rows' shape is never a reply.
      // A terminal row naming such a run must still settle it.
      const inferred = new Set(
        found
          .filter((run) => !run.outcomeKnown || (busy && !isTerminal(run.state)))
          .map((run) => run.id),
      );
      const inFlightId = typeof inFlight?.runId === "string" ? inFlight.runId : null;
      const ended = terminal
        ? new Map([...ids].map((id) => [id, terminal.phase] as const))
        : undefined;
      this.updateForeign(sessionKey, (activity) => {
        // A pair is one run: history under the gateway's id is the run the sender
        // follows under the send's id. Renamed, never dropped: a foreign run keeps
        // no steps, so nothing of a run still under way is lost with it.
        const aliased = (terminal?.pairs ?? []).reduce((next, [gateway, client]) => {
          if (gateway === client || next.queueAliases[gateway] === client) return next;
          const shown = findRun(next, gateway);
          const runs =
            shown && !findRun(next, client)
              ? next.runs.map((run) => (run === shown ? { ...run, id: client } : run))
              : next.runs;
          return { ...next, runs, queueAliases: { ...next.queueAliases, [gateway]: client } };
        }, activity);
        const followed = aliased.runs.filter((run) => ids.has(run.id));
        const merged = mergeHistoryRuns(followed, found, ctx, busy).runs;
        // A row said the run ended, but idle history cannot say how: settle it as
        // vanished rather than leave the card working, unless a turn is in flight.
        const runs = settleVanishedRuns(
          merged,
          activeBefore,
          historyIds,
          inFlightId,
          ctx,
          busy,
          ended,
          inferred,
        );
        const settled =
          runs.length === merged.length && runs.every((run, i) => run === merged[i])
            ? merged
            : runs;
        return {
          ...aliased,
          runs: [...aliased.runs.filter((run) => !ids.has(run.id)), ...settled],
        };
      });
    } finally {
      tokens.delete(token);
      if (tokens.size === 0 && this.foreignReads.get(sessionKey) === tokens)
        this.foreignReads.delete(sessionKey);
    }
  }

  /** Copy the state of every recipient run a task's `sessions_send` results name, where it is known. */
  private refreshLinkedRuns(key: string): void {
    const transcript = this.state.transcripts[key];
    if (!transcript) return;
    const rawOf = (step: Run["steps"][number]) => step.raw ?? this.raw.get(key, step.id);
    const links = recipientLinks(transcript.runs, rawOf);
    const known = this.recipients.get(key);
    const cap = (value: string) => capId(value, MAX_ID_CHARS);
    const runs = new Set(links.flatMap((link) => (link.runId ? [cap(link.runId)] : [])));
    const sessions = new Set(
      links.flatMap((link) => (link.sessionKey ? [cap(link.sessionKey)] : [])),
    );
    const grew =
      [...runs].some((id) => !known?.runs.has(id)) ||
      [...sessions].some((id) => !known?.sessions.has(id));
    this.recipients.set(key, { runs, sessions });
    // A send result naming a recipient can place an approval that arrived before it.
    if (grew) this.routeUnrouted();
    // The newest `MAX_LINKED_RUNS` recipients a task's sends name.
    const ids = recipientRunIds(transcript.runs, rawOf).slice(-MAX_LINKED_RUNS);
    const linked: Record<string, LinkedRun> = {};
    for (const id of ids) {
      for (const [sessionKey, activity] of [
        ...this.foreign.entries(),
        ...Object.entries(this.state.transcripts),
      ] as Array<[string, TaskActivity]>) {
        const run = findRun(activity, id);
        if (run) linked[id] = linkedRunOf(run, sessionKey);
      }
    }
    const current = transcript.linkedRuns;
    const same =
      Object.keys(current).length === Object.keys(linked).length &&
      Object.entries(linked).every(
        ([id, run]) =>
          current[id]?.state === run.state &&
          current[id]?.endedAt === run.endedAt &&
          current[id]?.outcomeKnown === run.outcomeKnown,
      );
    if (!same)
      this.setTranscript(key, () => ({ ...this.state.transcripts[key]!, linkedRuns: linked }));
  }

  // Questions -------------------------------------------------------------------

  /**
   * Answer a pending question card with `question.resolve`. `answers` maps
   * each question id to its answers: text as typed, sent as it is, or a shown
   * option named by its original place (`{option: index}`). An option is sent
   * by its identity, the gateway's value for it or else its label, read whole
   * from `question.list` at that place, never matched by the text shown.
   */
  async answerQuestion(
    key: string,
    questionId: string,
    answers: Record<string, QuestionAnswer[]>,
    options: { owner?: object } = {},
  ): Promise<void> {
    const question = this.pendingQuestion(key, questionId);
    const entries = Object.entries(answers);
    if (entries.length === 0) throw new Error("Choose or type an answer.");
    const chosen: Record<string, Array<string | QuestionOption>> = {};
    for (const [id, values] of entries) {
      const item = question.questions.find((each) => each.id === id);
      if (!item) throw new Error(`The card has no question ${id}.`);
      if (!Array.isArray(values) || values.length === 0) {
        throw new Error(`The answer to ${id} is empty.`);
      }
      chosen[id] = values.map((value) => {
        if (typeof value === "string") return value;
        const option = item.options.find((each) => each.index === value?.option);
        if (!option) throw new Error(`The card shows no such option for ${id}.`);
        return option;
      });
    }
    await this.resolveQuestion(key, questionId, options.owner ?? null, async () => ({
      id: questionId,
      answers: { answers: await this.optionAnswers(question, chosen) },
    }));
  }

  /**
   * The strings sent for the chosen answers. Each chosen option is read from
   * `question.list` at its original place and sent as `value ?? label`, as
   * the gateway identifies options; the option there must still be the one
   * shown, or nothing is sent.
   */
  private async optionAnswers(
    question: QuestionCard,
    chosen: Record<string, Array<string | QuestionOption>>,
  ): Promise<Record<string, string[]>> {
    const named = Object.values(chosen).some((values) =>
      values.some((each) => typeof each !== "string"),
    );
    let items: unknown[] = [];
    if (named) {
      const listed = asRecord(await this.request("question.list", {}));
      const record = (Array.isArray(listed?.questions) ? listed.questions : [])
        .map((entry) => asRecord(entry))
        .find(
          (entry) => typeof entry?.id === "string" && capId(entry.id, MAX_ID_CHARS) === question.id,
        );
      if (!record) throw new Error("That question is no longer open.");
      items = Array.isArray(record.questions) ? record.questions : [];
    }
    const out: Record<string, string[]> = {};
    for (const [id, values] of Object.entries(chosen)) {
      out[id] = values.map((each) => {
        if (typeof each === "string") return each;
        const item = asRecord(items.find((entry) => asRecord(entry)?.questionId === id));
        const listed = asRecord((Array.isArray(item?.options) ? item.options : [])[each.index]);
        const label = listed?.label;
        const value = typeof listed?.value === "string" && listed.value ? listed.value : null;
        // The option at that place must still be the one shown, its kept text a prefix of its whole text.
        if (
          typeof label !== "string" ||
          !label.startsWith(each.label) ||
          (value === null) !== (each.value === null) ||
          (value !== null && !value.startsWith(each.value!))
        ) {
          throw new Error("The question changed since it was shown.");
        }
        return value ?? label;
      });
    }
    return out;
  }

  /** Close a question card with its X: the bot is told there is no answer and carries on. */
  async dismissQuestion(
    key: string,
    questionId: string,
    options: { owner?: object } = {},
  ): Promise<void> {
    this.pendingQuestion(key, questionId);
    await this.resolveQuestion(key, questionId, options.owner ?? null, () => ({
      id: questionId,
      cancel: true,
    }));
  }

  private pendingQuestion(key: string, questionId: string) {
    const question = this.state.transcripts[key]?.questions.find((each) => each.id === questionId);
    if (!question || question.status !== "pending")
      throw new Error("That question is no longer open.");
    if (question.submitting) throw new Error("An answer to that question is already on its way.");
    return question;
  }

  /**
   * Send an answer or dismissal. The card is marked as being answered before
   * anything is awaited, so a second answer is refused at once; what is sent
   * is built after access is held, and the card is checked again just before.
   */
  private async resolveQuestion(
    key: string,
    questionId: string,
    owner: object | null,
    build: () => RawRecord | Promise<RawRecord>,
  ): Promise<void> {
    this.updateActivity(key, (activity) =>
      markQuestion(activity, questionId, { submitting: true, error: null }),
    );
    try {
      await this.ensureScope(QUESTIONS_SCOPE, owner);
      const params = await build();
      this.checkNotWithdrawn(owner);
      const now = this.state.transcripts[key]?.questions.find((each) => each.id === questionId);
      if (!now || now.status !== "pending") throw new Error("That question is no longer open.");
      this.updateActivity(key, (activity) =>
        markQuestion(activity, questionId, {
          submitting: true,
          error: null,
          sent: { method: "question.resolve", params },
        }),
      );
      const reply = await this.request("question.resolve", params);
      const result = asRecord(reply);
      // Apply the answer at once; `question.resolved` repeats it. The reply is kept as sent.
      this.updateActivity(key, (activity) =>
        applyQuestionResolved(
          activity,
          {
            id: questionId,
            status: result?.status ?? ("cancel" in params ? "cancelled" : "answered"),
            ...(result?.answers ? { answers: result.answers } : {}),
          },
          { via: "question.resolve", record: reply },
        ),
      );
    } catch (error) {
      this.updateActivity(key, (activity) =>
        markQuestion(activity, questionId, { submitting: false, error: errorMessage(error) }),
      );
      this.noteMissingScope(error);
      throw error;
    }
  }

  /**
   * Pending questions for one task, from `question.list`, after it reloads.
   * Fenced like the approval lists: a response older than one applied, or
   * from an earlier opening or connection, changes nothing.
   */
  private async backfillQuestions(key: string, generation: number): Promise<void> {
    if (!this.holds(QUESTIONS_SCOPE)) return;
    const incarnation = this.incarnations.get(key);
    const listKey = `${key}\u0000question`;
    const revision = (this.listRequested.get(listKey) ?? 0) + 1;
    this.listRequested.set(listKey, revision);
    const stale = () =>
      generation !== this.generation ||
      !this.tracked(key) ||
      this.incarnations.get(key) !== incarnation ||
      (this.listApplied.get(listKey) ?? 0) > revision;
    const before = this.state.transcripts[key];
    const pendingBefore = new Set([
      ...(before?.questions ?? [])
        .filter((question) => question.status === "pending")
        .map((question) => question.id),
      ...(before ? questionMarkers(before) : []),
    ]);
    try {
      const result = asRecord(await this.request("question.list", {}));
      if (stale()) return;
      this.listApplied.set(listKey, revision);
      const records = (Array.isArray(result?.questions) ? result.questions : [])
        .map((entry) => asRecord(entry))
        .filter(
          (record): record is RawRecord =>
            record?.sessionKey === key && record.status === "pending",
        );
      this.updateActivity(key, (activity, ctx) => {
        let next = activity;
        for (const record of records) next = applyQuestionRequested(next, record, ctx);
        return settleMissingQuestions(
          next,
          new Set(records.map((record) => String(record.id))),
          pendingBefore,
        );
      });
    } catch (error) {
      if (!stale()) {
        this.listApplied.set(listKey, revision);
        this.noteMissingScope(error);
      }
      this.log("warn", `question.list failed: ${errorMessage(error)}`);
    }
  }

  /**
   * The whole text an approval asks the reviewer to decide on, read again from
   * the gateway's list and returned without being kept, with the digest an
   * allow of a cut approval must name (`resolveApproval`'s `shownDigest`).
   */
  async readApprovalText(
    key: string,
    approvalId: string,
    options: { owner?: object; maxChars?: number } = {},
  ): Promise<{ text: Record<string, string | string[] | null>; digest: string }> {
    const approval = this.state.transcripts[key]?.approvals.find((each) => each.id === approvalId);
    if (!approval) throw new Error("That approval is not in this task.");
    const source = APPROVAL_SOURCES.find((each) => each.kind === approval.kind)!;
    // A whole read like the others: it shares their gate, so viewers cannot hold many lists at once.
    const value = await this.wholeRead(() => this.request(source.method, {}));
    const record = asRecord(value);
    const items = Array.isArray(value)
      ? value
      : Array.isArray(record?.approvals)
        ? record.approvals
        : Array.isArray(record?.items)
          ? record.items
          : [];
    const whole = items
      .map((item) => source.parse(item))
      .find((card) => card !== null && capId(card.id, MAX_ID_CHARS) === approvalId);
    if (!whole) throw new Error("The gateway no longer lists that approval.");
    const shown = this.state.transcripts[key]?.approvals.find((each) => each.id === approvalId);
    if (!shown || whole.decisionDigest !== shown.decisionDigest) {
      throw new Error("The approval changed since it was shown; reopen the task.");
    }
    const read = { text: decisionText(whole), digest: whole.decisionDigest };
    // Recorded only once it can be given to the viewer whole: a read its channel cannot carry
    // leaves the approval deny-only for that viewer.
    if (options.maxChars !== undefined && jsonLength(read) > options.maxChars) {
      throw new Error(
        "This approval's whole text is too long to show here; deny it, or read it in the desktop app.",
      );
    }
    this.noteApprovalRead(key, approvalId, options.owner ?? DIRECT_CALLER, read.digest);
    return read;
  }

  /**
   * A history item whole, as the gateway has it now, returned without being
   * kept: the way to read text cut to its bound (`TranscriptItem.cut`).
   */
  async readHistoryItem(key: string, itemId: string): Promise<TranscriptItem | null> {
    if (!this.state.transcripts[key]) return null;
    // The length needed is not known here: the most the gateway gives. An item it still cut says so.
    const history = await this.readHistoryWhole(key, MAX_HISTORY_READ_CHARS);
    return mapHistory(history?.messages).find((item) => item.id === itemId) ?? null;
  }

  /**
   * A history page read for a whole value, at most `MAX_FULL_READS` at once,
   * asking the gateway for text up to `maxChars` (it cuts to 8,000 otherwise).
   */
  private async readHistoryWhole(key: string, maxChars: number): Promise<RawRecord | null> {
    return asRecord(
      await this.wholeRead(() =>
        this.request("chat.history", { sessionKey: key, limit: HISTORY_LIMIT, maxChars }),
      ),
    );
  }

  /** One whole read (history or an approval list), at most `MAX_FULL_READS` at once; past it, refused. */
  private async wholeRead<T>(read: () => Promise<T>): Promise<T> {
    if (this.fullReads >= MAX_FULL_READS)
      throw new Error("Other whole texts are being read; try again in a moment.");
    this.fullReads += 1;
    try {
      return await read();
    } finally {
      this.fullReads -= 1;
    }
  }

  // Routines (`routines.ts`; automation.md sections 3 to 8), all at the read tier ----------

  /** Read the routine list and the scheduler's state again. */
  refreshRoutines(): Promise<void> {
    if (this.state.connection.status !== "connected") return Promise.resolve();
    return this.routines.load();
  }

  /** One bot's routines, for a list that keeps fewer than the gateway has; returned, not kept. */
  readBotRoutines(botId: string): Promise<BotRoutines> {
    return this.routines.botRoutines(botId);
  }

  /** A routine's runs, newest finished first, at most `MAX_ROUTINE_RUNS`; returned, not kept. */
  readRoutineRuns(id: string): Promise<RoutineRun[]> {
    return this.routines.runs(id);
  }

  /** Every routine's runs that started from `from` to `to`, for the calendar; returned, not kept. */
  readCalendarRuns(from: number, to: number): Promise<CalendarRuns> {
    return this.routines.calendarRuns(from, to);
  }

  /** One run's conversation, when the gateway keeps it; returned, not kept. */
  readRunConversation(id: string, run: RunSelector): Promise<RunConversation> {
    return this.routines.conversation(id, run);
  }

  // Changing routines (automation.md sections 9 and 10): `operator.admin`, checked by the engine.

  /** A new routine; `key` is its draft's, the same for every try of that draft. */
  createRoutine(
    input: NewRoutine,
    key: string,
    owner: object | null = null,
    gateway?: string | null,
  ): Promise<RoutineWrite> {
    return this.routines.create(input, key, owner, gateway);
  }

  /** One routine as the gateway has it now. */
  readRoutine(id: string, gateway?: string | null): Promise<Routine | null> {
    return this.routines.readOne(id, gateway);
  }

  /** What the gateway shows of a create whose answer never came, by its draft's key. */
  checkRoutineCreate(
    key: string,
    input: RoutineFields,
    gateway: string | null,
  ): Promise<RoutineSaveCheck> {
    return this.routines.checkCreate(key, input, gateway);
  }

  /** What the gateway shows of an edit whose answer never came. */
  checkRoutineUpdate(
    id: string,
    sent: { original: RoutineFields; edit: RoutineFields; expected: RoutineFields },
    gateway: string | null,
  ): Promise<RoutineSaveCheck> {
    return this.routines.checkUpdate(id, sent, gateway);
  }

  updateRoutine(
    id: string,
    original: RoutineFields,
    edit: RoutineFields,
    expected: RoutineRevision,
    owner: object | null = null,
    gateway?: string | null,
  ): Promise<RoutineWrite> {
    if (jsonTextLength(id) > MAX_ID_CHARS)
      return Promise.resolve({ status: "refused", error: "That routine id is too long." });
    return this.routines.update(id, original, edit, expected, owner, gateway);
  }

  setRoutineEnabled(
    id: string,
    enabled: boolean,
    owner: object | null = null,
    listedOn?: number,
  ): Promise<RoutineWrite> {
    return this.routines.setEnabled(id, enabled, owner, listedOn);
  }

  runRoutineNow(
    id: string,
    owner: object | null = null,
    listedOn?: number,
  ): Promise<RoutineRunNow> {
    return this.routines.runNow(id, owner, listedOn);
  }

  removeRoutine(
    id: string,
    owner: object | null = null,
    listedOn?: number,
  ): Promise<RoutineRemove> {
    return this.routines.remove(id, owner, listedOn);
  }

  /** The gateway's inbound hooks, read with admin; null below it. */
  readGatewayHooks(): Promise<GatewayHooks | null> {
    return this.routines.hooks();
  }

  // Provider accounts (`accounts.ts`, `accounts-engine.ts`; bots.md sections 3 to 11) ----------

  /** Read the accounts, sign-ins, bindings and catalogue the account screens show. */
  refreshAccounts(): Promise<void> {
    if (this.state.connection.status !== "connected") return Promise.resolve();
    return this.accounts.load();
  }

  /** Read one bot's stored order and model again: the lock's evidence. */
  checkLock(botId: string): Promise<void> {
    if (this.state.connection.status !== "connected") return Promise.resolve();
    return this.accounts.checkLock(botId);
  }

  startSignIn(methodId: string, botId: string | null): Promise<void> {
    return this.accounts.startSignIn(methodId, botId);
  }

  /** A code or address pasted back, or a company address: sent once, kept nowhere. */
  answerSignIn(value: string): Promise<void> {
    return this.accounts.answerSignIn(value);
  }

  /** Cancel the sign-in under way; `cancelled` only when the gateway confirmed it. */
  cancelSignIn(): Promise<{ cancelled: boolean }> {
    return this.accounts.cancelSignIn();
  }

  /** Let go of a sign-in that has ended; one under way is kept unless the gateway confirms its cancel. */
  dismissSignIn(): Promise<{ dismissed: boolean }> {
    return this.accounts.dismissSignIn();
  }

  /** Read again where a finished sign-in's account landed, after that read failed. */
  recheckSignIn(): Promise<void> {
    return this.accounts.recheckSignIn();
  }

  /** Which of several new accounts is the sign-in's, as the person chose. */
  chooseSignInAccount(profileId: string): Promise<void> {
    return this.accounts.chooseSignInAccount(profileId);
  }

  /** An API key the person typed: sent once to the gateway, kept nowhere. */
  saveApiKey(
    provider: string,
    key: string,
    botId: string | null,
  ): Promise<{ profileId: string | null }> {
    return this.accounts.saveKey(provider, key, botId);
  }

  setAccountLabel(profileId: string, label: string): Promise<void> {
    return this.accounts.setLabel(profileId, label);
  }

  disconnectAccount(profileId: string): Promise<void> {
    return this.accounts.disconnect(profileId);
  }

  createBot(input: CreateBotInput): Promise<CreatedBot> {
    return this.accounts.createBot(input);
  }

  /** Finish a bot whose creation is partial, by its id: what is missing, never a second bot. */
  finishBot(botId: string): Promise<CreatedBot> {
    return this.accounts.finishBot(botId);
  }

  dismissBotCreation(): void {
    this.accounts.dismissCreation();
  }

  changeBotAccount(
    botId: string,
    account: string | null,
    provider: string,
    model: string,
    effort: string | null,
  ): Promise<void> {
    return this.accounts.changeAccount(botId, account, provider, model, effort);
  }

  setBotModel(botId: string, model: string, effort: string | null): Promise<void> {
    return this.accounts.setModel(botId, model, effort);
  }

  removeBotFallbacks(botId: string): Promise<void> {
    return this.accounts.removeFallbacks(botId);
  }

  // Check-ins (`check-ins.ts`; automation.md section 13) ---------------------------------------

  private checkInsContext(owner?: object | null): CheckInsContext {
    return {
      link: () => {
        const protocol = this.protocol;
        const epoch = this.epoch;
        const alive = () =>
          protocol !== null &&
          this.protocol === protocol &&
          this.epoch === epoch &&
          this.state.connection.status === "connected";
        return {
          alive,
          request: (method, params, options) =>
            protocol && alive()
              ? protocol.request(method, params, options)
              : Promise.reject(new NotSentError()),
        };
      },
      gateway: () => this.readGatewayIdentity(),
      begin: () => {
        const mine = (this.checkInReads += 1);
        return () => mine === this.checkInReads;
      },
      get: () => this.state.checkIns,
      set: (checkIns) => this.store.update((state) => ({ ...state, checkIns })),
      botIds: () => this.state.bots.map((bot) => bot.id),
      admin: () => this.holds(ADMIN_SCOPE) && this.state.connection.scopes.includes(ADMIN_SCOPE),
      checkNotWithdrawn: () => this.checkNotWithdrawn(owner),
      now: () => this.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    };
  }

  /** Read the bots' check-ins: their heartbeat jobs, the scheduler and their own settings. */
  refreshCheckIns(botId?: string): Promise<CheckInRead | null> {
    if (this.state.connection.status !== "connected") return Promise.resolve(null);
    return loadCheckIns(this.checkInsContext(), botId);
  }

  /** Save one bot's check-ins; the outcome is `checkIns.save` with this `saveId`. */
  saveCheckIn(
    saveId: string,
    botId: string,
    draft: CheckInDraft,
    owner?: object | null,
  ): Promise<void> {
    if (!this.state.connection.canAdmin)
      return Promise.reject(new AdminNeededError("Changing check-ins"));
    return saveCheckIn(this.checkInsContext(owner), saveId, botId, draft);
  }

  dismissCheckInSave(saveId: string): void {
    dismissCheckInSave(this.checkInsContext(), saveId);
  }

  // Where a bot runs and Machines (`machines.ts`; controls.md sections 14 and 15) ----------

  /** A bot's command machine, workspace, browser and inventory, read now. */
  readPlacement(botId: string): Promise<BotPlacement> {
    return this.machines.readPlacement(botId);
  }

  /** The gateway's machines, their approvals files (admin) and paired devices (pairing), read now. */
  readMachines(): Promise<MachinesView> {
    return this.machines.readMachines();
  }

  setCommandMachine(
    botId: string,
    target: { host: "gateway" } | { host: "node"; nodeId: string },
    baseHash: string | null,
  ): Promise<ConfigSave> {
    return this.machines.setCommandMachine(botId, target, baseHash);
  }

  async setBotWorkspace(
    botId: string,
    path: string,
  ): Promise<{ workspace: string | null; asTyped: boolean }> {
    // The bot list carries no workspace: nothing else is read, so no late list can replace a newer one.
    return this.machines.setWorkspace(botId, path);
  }

  /** `owner` names the viewer that asked: once it is withdrawn, the write read first is not sent. */
  setMachineDefaults(
    machineId: string,
    choice: DefaultsChoice,
    expectedHash: string | null,
    options: { owner?: object } = {},
  ): Promise<ApprovalsFile> {
    return this.machines.setMachineDefaults(machineId, choice, expectedHash, () =>
      this.checkNotWithdrawn(options.owner),
    );
  }

  renameMachine(nodeId: string, name: string): Promise<void> {
    return this.machines.renameMachine(nodeId, name);
  }

  removeMachine(nodeId: string): Promise<void> {
    return this.machines.removeMachine(nodeId);
  }

  renameDevice(deviceId: string, name: string, options: { owner?: object } = {}): Promise<void> {
    return this.machines.renameDevice(deviceId, name, () => this.checkNotWithdrawn(options.owner));
  }

  removeDevice(deviceId: string): Promise<void> {
    return this.machines.removeDevice(deviceId);
  }

  /** Read the bot list again, after a bot was created. */
  private async refreshBots(): Promise<void> {
    const generation = this.generation;
    const issued = ++this.botsIssued;
    const result = await this.request("agents.list", {});
    if (generation !== this.generation || !this.newestBots(issued)) return;
    this.store.update((state) => ({ ...state, bots: mapAgents(result) }));
  }

  /**
   * Whether a read of the bot list may be shown, marking it shown: answers are ordered by when
   * they were asked, never by when they arrive, so a late answer never hides a bot a later read
   * showed.
   */
  private newestBots(issued: number): boolean {
    if (issued < this.botsShown) return false;
    this.botsShown = issued;
    return true;
  }

  // The Work pane's files (`files.ts`). All `operator.read`; nothing is kept in the state.

  /** One file list or read, at most `MAX_FILE_READS` at once; past it, refused. */
  private async fileRead<T>(
    read: (ctx: FileReaderContext) => Promise<T>,
    options: FileReadOptions,
  ): Promise<T> {
    if (this.state.connection.status !== "connected")
      throw new Error("Not connected to the gateway.");
    if (this.fileReads >= MAX_FILE_READS)
      throw new Error("Other files are being read; try again in a moment.");
    this.fileReads += 1;
    try {
      return await read({
        request: (method, params) => this.request(method, params),
        transfers: this.fileTransfers,
        owner: options.owner ?? DIRECT_CALLER,
        ...(options.maxChars !== undefined ? { maxChars: options.maxChars } : {}),
        now: () => this.now(),
      });
    } finally {
      this.fileReads -= 1;
    }
  }

  listMemory(botId: string) {
    return this.wholeRead(() =>
      listMemory((method, params) => this.request(method, params), botId),
    );
  }

  readMemory(botId: string, path: string) {
    return this.wholeRead(() =>
      readMemory((method, params) => this.request(method, params), botId, path),
    );
  }

  async writeMemory(
    botId: string,
    path: string,
    gatewayId: string | null,
    expectedHash: string | null,
    content: string | null,
  ) {
    if (this.options.readOnly || !this.state.connection.canAdmin)
      throw new Error("Changing memory requires admin access.");
    await writeMemory(
      (method, params) => this.request(method, params),
      botId,
      path,
      gatewayId,
      expectedHash,
      content,
    );
  }

  /** A task's files and the folder it works in, read now (`sessions.files.list`, `sessions.describe`). */
  listTaskFiles(key: string, options: FileReadOptions = {}): Promise<TaskFileList> {
    return this.fileRead((ctx) => listTaskFiles(ctx, key), options);
  }

  /** One of a task's files, from the reader its place allows (work-pane.md, section 8). */
  readTaskFile(key: string, path: string, options: FileReadOptions = {}): Promise<FileRead> {
    const botId = botIdFromSessionKey(key);
    if (!botId) return Promise.reject(new Error("This task's bot is not known."));
    return this.fileRead((ctx) => readTaskFile(ctx, key, botId, path), options);
  }

  /** One page of a folder of a bot's workspace (`agents.workspace.list`). */
  listWorkspace(
    botId: string,
    path: string,
    offset: number,
    options: FileReadOptions = {},
  ): Promise<WorkspacePage> {
    return this.fileRead((ctx) => listWorkspace(ctx, botId, path, offset), options);
  }

  /** A file of a bot's workspace; `key` names the open task whose asset reader may send media. */
  readWorkspaceFile(
    botId: string,
    path: string,
    size: number | null,
    key: string | null,
    options: FileReadOptions = {},
  ): Promise<FileRead> {
    return this.fileRead((ctx) => readWorkspaceFile(ctx, botId, path, size, key), options);
  }

  /** The checkout's patch for one of a task's files (`sessions.diff`). */
  readCheckoutDiff(
    key: string,
    path: string,
    options: FileReadOptions = {},
  ): Promise<CheckoutDiff> {
    return this.fileRead((ctx) => readCheckoutDiff(ctx, key, path), options);
  }

  /** The next part of a file on its way to this viewer. */
  readFileChunk(id: string, index: number, owner: object = DIRECT_CALLER): { data: string } {
    return this.fileTransfers.chunk(owner, id, index);
  }

  /** Drop a file's transfer before its last part was read. */
  releaseFile(id: string, owner: object = DIRECT_CALLER): void {
    this.fileTransfers.release(owner, id);
  }

  /** The raw call and result of a step as the raw table keeps it now; null when it is not kept. */
  stepRaw(key: string, stepId: string): StepRaw | null {
    if (!this.state.transcripts[key]) return null;
    return this.raw.get(key, stepId);
  }

  /**
   * A failed run's Raw (F-301), read only when it is opened and returned without being kept in
   * the state. Null when the task has no such run.
   */
  readRunRaw(key: string, runId: string): RunRawRead | null {
    const transcript = this.state.transcripts[key];
    const run = transcript && findRun(transcript, runId);
    if (!run) return null;
    const described = run.error?.raw;
    if (!described) return { status: "not-kept", holds: null };
    const kept = this.raw.get(key, runErrorRawId(run.id));
    if (kept) return { status: "available", holds: described.holds, payload: kept.call };
    if (described.chars > MAX_RAW_ENTRY_CHARS)
      return {
        status: "too-large",
        holds: described.holds,
        chars: described.chars,
        limit: MAX_RAW_ENTRY_CHARS,
      };
    return { status: "not-kept", holds: described.holds };
  }

  /**
   * A step's whole raw call and result, returned without being kept: from the
   * raw table while it fits there, otherwise from the gateway's history once
   * that step is in history. Until then the answer is `not-available-yet`.
   * Null only when the task has no such step.
   */
  async readStepRaw(key: string, stepId: string): Promise<StepRead | null> {
    const find = () =>
      this.state.transcripts[key]?.runs
        .flatMap((run) => run.steps)
        .find((step) => step.id === stepId);
    const step = find();
    if (!step) return null;
    // What the raw table keeps is whole unless a history row it came from was cut.
    const kept = this.raw.get(key, stepId);
    if (kept && !step.truncated) return { status: "available", raw: kept };
    // Ask for the length the step needs; one the gateway cut gives no length, so the most it gives.
    const known = Math.max(
      ...[step.argsText, step.output, step.result].map((text) => text?.totalChars ?? 0),
    );
    const maxChars = step.truncated
      ? MAX_HISTORY_READ_CHARS
      : Math.min(MAX_HISTORY_READ_CHARS, Math.max(GATEWAY_HISTORY_TEXT_CHARS, known + 64));
    const history = await this.readHistoryWhole(key, maxChars);
    const current = this.state.transcripts[key];
    const shown = find();
    const run = current?.runs.find((each) => each.steps.some((one) => one.id === stepId));
    if (!current || !shown || !run) return null;
    // Rebuilt aside, as a resync would, into a table dropped after this read.
    const scratch = new RawTable(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
    const ctx = { ...this.context(key), raw: scratch };
    const windowCut = history?.hasMore === true;
    const aliased = throughRunAliases(
      history?.messages,
      asRecord(history?.inFlightRun),
      current.queueAliases,
    );
    const fromHistory = runsFromHistory(aliased.messages, aliased.inFlight, ctx, { windowCut });
    const whole = scratch.get(key, stepId);
    const read = fromHistory.flatMap((each) => each.steps).find((each) => each.id === stepId);
    // A step's id is its place, which history can give another block: what was fetched is
    // this step only when it shows so. This check only ever withholds `available`.
    const same = whole !== null && read !== undefined && sameStep(shown, read, whole);
    // Its message replaced by the gateway's placeholder: not a cut text, and asking again does not help.
    if ((!same || read.truncated) && oversizedWhere(aliased.messages, run.id, shown, windowCut)) {
      return {
        status: "too-large-for-gateway",
        reason:
          "The gateway replaces a message this large with a placeholder in its history and will not return its text in full.",
      };
    }
    if (!same) {
      if (whole && read) {
        return {
          status: "not-established",
          reason:
            "What the gateway's history returned at this step's place could not be shown to be this step, so it is not offered as its text.",
        };
      }
      return {
        status: "not-available-yet",
        reason:
          "This step's whole text was too long to keep here, and the gateway's history did not return it: it may not hold it yet, or its page was too large to include it. Trying again later may help.",
      };
    }
    if (read.truncated) {
      return {
        status: "cut-by-gateway",
        raw: whole,
        receivedChars: Math.max(
          ...[read.argsText, read.output, read.result].map((text) => text?.totalChars ?? 0),
        ),
        reason: "The gateway's history holds this step's text only cut to a shorter length.",
      };
    }
    return { status: "available", raw: whole };
  }

  // Activity ------------------------------------------------------------------------

  private context(key: string): EngineContext {
    return { sessionKey: key, now: this.now(), raw: this.raw };
  }

  private updateActivity(
    key: string,
    fn: (activity: TaskActivity, ctx: EngineContext) => TaskActivity,
  ): void {
    const current = this.state.transcripts[key];
    if (!current) return;
    // After a confirmed Stop nothing starts by itself: what was held or queued stays, not sent.
    const next = retainActivity(
      settleQuestionsOfEndedRuns(
        normalizeApprovals(
          this.withKeptAttempts(
            current,
            parkAfterStop(current, fn(current, this.context(key)), this.now()),
          ),
          (runId) => this.otherRun(runId),
        ),
      ),
    );
    if (next === current) return;
    // Only a change of runs can take a payload out of what the task retains.
    if (next.runs !== current.runs) this.retainTaskRaw(key, next);
    this.setTranscript(key, () => withLive({ ...current, ...next }));
    this.afterActivity(key);
    this.refreshLinkersOf(key, current.runs, next.runs);
  }

  /**
   * A run in this task changed state, and another task's send names it (a
   * recipient whose task is open beside its sender's): that task's card
   * follows it now, not at its own next change.
   */
  private refreshLinkersOf(key: string, before: Run[], after: Run[]): void {
    const changed = after.filter(
      (run) => findRun({ ...emptyActivity, runs: before }, run.id)?.state !== run.state,
    );
    if (changed.length === 0) return;
    for (const transcript of Object.values(this.state.transcripts)) {
      if (transcript.sessionKey === key) continue;
      if (changed.some((run) => transcript.linkedRuns[run.id]))
        this.refreshLinkedRuns(transcript.sessionKey);
    }
  }

  /**
   * After any change: keep turn timers, release held messages once their
   * question is settled, start the oldest queued run once nothing is active,
   * and let go of a closed task whose work is done. Not re-entrant: a change
   * made while it runs makes it run once more instead of nesting, so no
   * message is claimed twice.
   */
  private afterActivity(key: string): void {
    if (this.afterRunning.has(key)) {
      this.afterAgain.add(key);
      return;
    }
    this.afterRunning.add(key);
    try {
      do {
        this.afterAgain.delete(key);
        this.afterActivityOnce(key);
      } while (this.afterAgain.has(key));
    } finally {
      this.afterRunning.delete(key);
    }
  }

  private afterActivityOnce(key: string): void {
    const transcript = this.state.transcripts[key];
    if (!transcript) return;
    // A run that ended or left the transcript keeps no stream baseline.
    this.streams.retire(key, (runId) => {
      const run = findRun(transcript, runId);
      return run !== undefined && !isTerminal(run.state);
    });
    this.refreshLinkedRuns(key);
    this.scheduleApprovalExpiry(key);
    void this.settleEndedRuns(key);
    for (const run of transcript.runs) {
      // A run this client stopped has ended as stopped: stop what its messages started (F-296).
      if (
        run.state === "stopped" &&
        run.outcomeKnown &&
        run.stopRequestedAt !== null &&
        !run.stoppedWith?.recipientsAsked &&
        this.state.connection.canWrite &&
        !this.options.readOnly
      )
        void this.stopRecipients(key, run.id);
      // Tool calls that keep timing out: the machine may not be responding. Stop the run (F-101).
      if (
        (run.state === "running" || run.state === "waiting") &&
        run.stoppedForTimeouts === undefined &&
        this.state.connection.canWrite &&
        !this.options.readOnly
      ) {
        const count = timeoutsInARow(run);
        if (count >= TIMEOUTS_IN_A_ROW && runningRunId(transcript, run.id) === run.id) {
          this.updateActivity(key, (activity) => markStoppedForTimeouts(activity, run.id, count));
          void this.stopRun(key, run.id).then(() => {
            // The stop was refused or could not be asked: the run goes on, not as stopped for this.
            const now = this.state.transcripts[key] && findRun(this.state.transcripts[key], run.id);
            if (now && (now.state === "running" || now.state === "waiting"))
              this.updateActivity(key, (activity) => markStoppedForTimeouts(activity, run.id, 0));
          });
        }
      }
      const timerKey = `${key}\u0000${run.id}`;
      const timer = this.turnTimers.get(timerKey);
      if (isTerminal(run.state)) {
        if (timer) clearTimeout(timer);
        this.turnTimers.delete(timerKey);
      } else if (
        !timer &&
        run.origin === "local" &&
        run.bound &&
        run.turnLimit === undefined &&
        isActive(run.state)
      ) {
        const limit = this.turnLimitMs;
        const elapsed = this.now() - (run.startedAt ?? this.now());
        this.turnTimers.set(
          timerKey,
          setTimeout(
            () => this.turnLimitReached(key, run.id),
            Math.min(MAX_TIMER_MS, Math.max(0, limit - elapsed)),
          ),
        );
      }
    }
    const active = activeRun(transcript);
    const held = transcript.outbox
      .filter((message) => message.status === "held")
      .map((message) => message.id);
    if (held.length > 0 && !questionPending(transcript, active)) {
      // The question is settled: release every held message at once, in the
      // order sent, each as a message sent now would go. Into a running run
      // as a steer, unless it was queued; queued while the run stops; and
      // once the run has ended, queued, so each starts a run of its own.
      const steered: string[] = [];
      this.updateActivity(key, (activity) => {
        let next = activity;
        const now = activeRun(activity);
        for (const id of held) {
          const message = next.outbox.find((each) => each.id === id);
          if (!message || message.status !== "held") continue;
          if (now && now.state !== "stopping" && message.mode !== "queue") {
            next = updateMessage(next, id, { status: "sending", mode: "steer", runId: now.id });
            steered.push(id);
          } else {
            next = updateMessage(next, id, { status: "queued", mode: "queue", runId: null });
            next = queueLocalRun(
              next,
              next.outbox.find((each) => each.id === id)!,
              this.now(),
            );
          }
        }
        return next;
      });
      for (const id of steered) this.enqueueDelivery(key, id);
    }
    const current = this.state.transcripts[key];
    if (!current) return;
    const next =
      activeRun(current) || questionPending(current)
        ? undefined
        : current.runs.find((run) => run.state === "queued");
    if (next) {
      this.updateActivity(key, (activity) =>
        // It keeps `mode: "queue"`: if the gateway refuses to start it, the
        // shelf says "Couldn't start" rather than a send failing.
        updateMessage(startQueuedRun(activity, next.id, this.now()), next.id, {
          status: "sending",
        }),
      );
      this.enqueueDelivery(key, next.id);
    }
    if (this.retained.has(key) && !hasUnsettledWork(this.state.transcripts[key] ?? emptyActivity)) {
      this.releaseTask(key);
    }
  }

  /**
   * Deliveries for one task run one at a time, in the order they were made,
   * so messages reach the gateway in the order the user sent them.
   */
  private enqueueDelivery(key: string, messageId: string): void {
    // A new attempt: until its frame leaves, a confirmed Stop parks it.
    if (this.outgoing(key, messageId)?.leftAt != null) {
      this.updateActivity(key, (activity) => updateMessage(activity, messageId, { leftAt: null }));
    }
    if (!this.state.connection.canWrite && this.outgoing(key, messageId)?.status === "sending") {
      this.updateActivity(key, (activity) =>
        updateMessage(activity, messageId, { status: "awaiting-access" }),
      );
    }
    const previous = this.deliveries.get(key) ?? Promise.resolve();
    const next = previous
      .then(() => this.deliver(key, messageId))
      .catch((error: unknown) => this.log("error", `delivery failed: ${errorMessage(error)}`));
    this.deliveries.set(key, next);
    void next.then(() => {
      if (this.deliveries.get(key) === next) this.deliveries.delete(key);
    });
  }

  /**
   * Set the "Turn time limit" (F-100), in whole minutes, and keep it for the next start. Runs
   * already going are timed against the new limit from when they started.
   */
  async setTurnLimit(minutes: number): Promise<void> {
    if (!validTurnLimit(minutes))
      throw new Error(
        `A turn limit is a whole number of minutes from ${MIN_TURN_LIMIT_MINUTES} to ${MAX_TURN_LIMIT_MINUTES}.`,
      );
    // Kept first: a limit the host could not keep is not taken, and the old one and its timers stay.
    await this.host.storage.set(TURN_LIMIT_KEY, String(minutes));
    this.turnLimitMs = minutes * 60_000;
    this.store.update((state) => ({ ...state, turnLimitMinutes: minutes }));
    for (const [timerKey, timer] of this.turnTimers) {
      clearTimeout(timer);
      this.turnTimers.delete(timerKey);
    }
    for (const key of Object.keys(this.state.transcripts)) this.afterActivity(key);
  }

  private turnLimitReached(key: string, runId: string): void {
    this.turnTimers.delete(`${key}\u0000${runId}`);
    const run = this.state.transcripts[key] && findRun(this.state.transcripts[key], runId);
    if (!run || (run.state !== "running" && run.state !== "waiting")) return;
    const limit = this.turnLimitMs;
    if (this.now() - (run.startedAt ?? this.now()) < limit) {
      // Woken early by the timer ceiling: arm again.
      this.afterActivity(key);
      return;
    }
    // Stopped as any Stop is: "Stopping…" until the gateway confirms, put back if it refuses,
    // and asked again after a reconnect if unanswered. Nothing fails and nothing queued is
    // released on the limit alone; the limit is reached once per run.
    const minutes = Math.round(this.turnLimitMs / 60_000);
    if (
      !this.state.connection.canWrite ||
      this.options.readOnly ||
      runningRunId(this.state.transcripts[key]!, runId) !== runId
    ) {
      // Not stopped by the limit: it is not asked again, and no later stop is put down to it.
      this.updateActivity(key, (activity) => markTurnLimit(activity, runId, 0));
      return;
    }
    this.updateActivity(key, (activity) => markTurnLimit(activity, runId, minutes));
    void this.stopRun(key, runId);
  }

  private clearTurnTimers(key: string): void {
    const prefix = `${key}\u0000`;
    for (const [timerKey, timer] of this.turnTimers) {
      if (!timerKey.startsWith(prefix)) continue;
      clearTimeout(timer);
      this.turnTimers.delete(timerKey);
    }
  }

  /** The task was archived or deleted: its queued messages never run (F-420). */
  private cancelAllQueued(key: string): void {
    this.updateActivity(key, (activity) => {
      let next = activity;
      for (const run of activity.runs) {
        if (run.state !== "queued") continue;
        this.dropAttachments(run.id);
        next = updateMessage(cancelQueuedRun(next, run.id, this.now()), run.id, {
          status: "cancelled",
        });
      }
      return next;
    });
  }

  // Connection lifecycle -------------------------------------------------------

  private isAllowed(url: string): boolean {
    return this.options.allowGatewayUrl ? this.options.allowGatewayUrl(url) : true;
  }

  private async open(): Promise<void> {
    this.close();
    const settings = this.settings;
    if (!settings) return;
    const generation = ++this.generation;
    const identity = await this.loadIdentity();
    if (generation !== this.generation) return;

    if (!this.isAllowed(settings.url)) {
      this.rows = new Map();
      this.store.set({
        ...initialState,
        turnLimitMinutes: this.turnLimitMs / 60_000,
        connection: {
          ...initialConnectionState,
          status: "error",
          gatewayUrl: settings.url,
          deviceId: identity.deviceId,
          error: {
            code: "GATEWAY_NOT_ALLOWED",
            message: new GatewayNotAllowedError(settings.url).message,
            hint: null,
          },
        },
      });
      return;
    }

    const stored = await this.loadToken(settings.url, identity.deviceId, "operator");
    if (generation !== this.generation) return;
    // Reopening the same gateway keeps what is on screen until fresh data arrives.
    const sameGateway = this.state.connection.gatewayUrl === settings.url;
    const hasData = sameGateway && this.state.bots.length > 0;
    if (!sameGateway) {
      this.computer.reset();
      this.rows = new Map();
      this.raw.clear();
      // Work kept for another gateway's tasks is never carried to this one.
      this.retained.clear();
      this.forgetGatewayState();
    }
    this.everConnected = hasData;
    this.store.update((state) => ({
      ...(sameGateway ? state : { ...initialState, turnLimitMinutes: this.turnLimitMs / 60_000 }),
      connection: {
        ...initialConnectionState,
        status: hasData ? "reconnecting" : "connecting",
        gatewayUrl: settings.url,
        deviceId: identity.deviceId,
        // Not paired yet: only a hello says so, since a saved token may be one the gateway refuses.
        requestedScopes:
          stored && !this.options.readOnly ? [...stored.heldScopes] : [...READ_SCOPES],
        upgrade: sameGateway ? state.connection.upgrade : initialScopeUpgrade,
        serverVersion: sameGateway ? state.connection.serverVersion : null,
        gatewayId: sameGateway ? state.connection.gatewayId : null,
      },
      transcripts: sameGateway
        ? state.transcripts
        : Object.fromEntries(
            [...this.openSessions.keys()].map((key) => [key, this.emptyTranscript(key)]),
          ),
    }));

    const tokenStore = this.connectionTokenStore(settings.url, generation);
    const lifecycle = new GatewayBrowserDeviceAuthLifecycle({
      loadIdentity: async () => {
        const loaded = await this.loadIdentity();
        return { ...loaded, sign: (payload) => this.host.signer.sign(payload) };
      },
      tokenStore,
      nowMs: () => this.now(),
    });
    this.auth = { url: settings.url, generation, tokenStore, lifecycle };

    const client = {
      id: CLIENT_ID,
      displayName: this.host.client.displayName,
      version: this.host.client.version,
      platform: this.host.client.platform,
      mode: CLIENT_MODE,
    } as const;
    const reconnect = this.options.reconnect ?? { initialMs: 1000, maxMs: 30_000 };

    this.protocol = new GatewayProtocolClient<Plan>({
      createSocket: (handlers) => {
        // Asked again before every attempt, including the protocol's own
        // retries: a gateway that stops being allowed is never reopened, and
        // throwing here ends the retries.
        if (!this.isAllowed(settings.url)) {
          if (generation === this.generation) {
            this.setConnection({
              status: "error",
              retryAt: null,
              error: {
                code: "GATEWAY_NOT_ALLOWED",
                message: new GatewayNotAllowedError(settings.url).message,
                hint: null,
              },
            });
          }
          throw new GatewayNotAllowedError(settings.url);
        }
        this.attemptGreeted = false;
        // An attempt is under way: no retry is waiting any more.
        if (this.state.connection.retryAt !== null) this.setConnection({ retryAt: null });
        const socket = this.host.createWebSocket(settings.url);
        socket.onopen = () => handlers.open();
        socket.onmessage = (event) => handlers.message(String(event.data));
        socket.onclose = (event) => handlers.close(event.code, event.reason);
        socket.onerror = () => handlers.error(new Error("WebSocket error"));
        return {
          isOpen: () => socket.readyState === 1,
          send: (data) => socket.send(data),
          close: (code, reason) => socket.close(code, reason),
        };
      },
      createRequestId: () => this.randomId(),
      buildConnectPlan: async ({ nonce, challengeTs }) => {
        const token = await this.loadToken(settings.url, identity.deviceId, "operator");
        // Once paired, the device token is the credential; the bootstrap token is no longer sent.
        const bootstrap = token ? null : settings.token;
        // Exactly the scopes this client means to hold, never what the token happens to allow.
        const requested = token && !this.options.readOnly ? token.heldScopes : [...READ_SCOPES];
        const plan = await lifecycle.buildPlan({
          client,
          role: "operator",
          defaultScopes: requested,
          ...(bootstrap ? { token: bootstrap } : {}),
          nonce,
          challengeTs: challengeTs ?? null,
        });
        // The signed payload covers these scopes, so check them before sending.
        if (plan.scopes.join(",") !== requested.join(",")) {
          throw new Error(`refusing to request scopes ${plan.scopes.join(", ")}`);
        }
        if (generation === this.generation) this.setConnection({ requestedScopes: [...requested] });
        return plan;
      },
      buildConnectParams: (plan) => ({
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client,
        role: plan.role,
        scopes: plan.scopes,
        caps: capsFor(plan.scopes),
        ...(plan.auth ? { auth: plan.auth } : {}),
        ...(plan.device ? { device: plan.device } : {}),
        locale: "en-US",
        userAgent: `clawtrate/${this.host.client.version}`,
      }),
      onConnectHello: async (hello, context) => {
        await lifecycle.acceptHello(hello, context.plan);
        // Queued with Connect and Disconnect, so it never writes back a gateway forgotten meanwhile.
        await this.changeConnection(async () => {
          // Only this connection may drop this gateway's bootstrap secret.
          const current = this.settings;
          if (generation !== this.generation || current?.url !== settings.url) return;
          if (!current.token) return;
          // Paired, by this hello or an earlier one: the device token replaces the bootstrap secret.
          const paired =
            Boolean(hello.auth.deviceToken) ||
            (await this.loadToken(settings.url, identity.deviceId, "operator")) !== null;
          if (!paired) return;
          try {
            await this.saveSettings({ ...current, token: null });
          } catch {
            // The settings keep the secret, so the next hello tries again; this one goes on.
            this.log("warn", "Could not remove the shared gateway token from this device.");
          }
        });
      },
      onHello: (hello) => {
        if (generation !== this.generation) return;
        this.epoch += 1;
        this.attemptGreeted = true;
        if (hello.protocol !== PROTOCOL_VERSION) {
          // Outside this client's range: nothing else is asked of this gateway.
          const protocol = { gateway: hello.protocol, client: PROTOCOL_VERSION };
          this.close();
          this.setConnection({
            status: "error",
            retryAt: null,
            protocol: hello.protocol,
            serverVersion: hello.server.version,
            error: {
              code: "PROTOCOL_MISMATCH",
              message: protocolMessage(protocol),
              hint: null,
              protocol,
            },
          });
          return;
        }
        this.handleHello(hello, generation);
      },
      onConnectFailure: async (error) =>
        this.handleConnectFailure(error, identity.deviceId, settings.url, tokenStore),
      resolveClose: (context) => ({
        retry: true,
        notify: true,
        ...(context.connectFailure?.reconnectDelayMs !== undefined
          ? { reconnectDelayMs: context.connectFailure.reconnectDelayMs }
          : {}),
      }),
      onClose: () => {
        if (generation !== this.generation) return;
        this.epoch += 1;
        this.streams.clear();
        this.computer.connectionLost();
        this.accounts.onClose();
        this.invalidateCheckIns();
        this.routines.onClose();
        this.usage.onClose();
        const status = this.state.connection.status;
        if (status !== "pairing" && status !== "error") {
          // Once this gateway has answered, every later drop is a reconnect, not a first connect.
          // An attempt that never got an answer says so, unless the gateway gave a reason.
          const unanswered =
            !this.attemptGreeted && !this.state.connection.error
              ? {
                  error: {
                    code: "UNREACHABLE",
                    message: `Nothing answered at ${hostOf(settings.url)}.`,
                    hint: "Check that the gateway is running and that the address is right.",
                  },
                }
              : {};
          this.setConnection({
            status: this.everConnected ? "reconnecting" : "connecting",
            ...unanswered,
            // No connection, no effective access; the next hello says what is granted.
            canWrite: false,
            canAnswer: false,
            canApprove: false,
            canAdmin: false,
          });
        }
      },
      onReconnectScheduled: (delayMs) => {
        if (generation !== this.generation) return;
        this.setConnection({ retryAt: this.now() + delayMs });
      },
      onReconnectStopped: (error) => {
        if (generation !== this.generation) return;
        this.rejectAccessWaiters(new Error(`The connection stopped: ${error.message}`));
        if (this.state.connection.status !== "error") {
          this.setConnection({
            status: "error",
            retryAt: null,
            error: { code: "STOPPED", message: error.message, hint: null },
          });
        }
      },
      onConnectError: (error) => {
        if (generation !== this.generation || !isRetryableNetworkFailure(error)) return;
        this.log("warn", `connection attempt failed: ${error.message}`);
      },
      // The protocol client closes the socket after a gap; the reconnect reloads open tasks.
      onGap: ({ expected, received }) => {
        if (generation !== this.generation) return;
        this.log("warn", `event gap: expected ${expected}, received ${received}`);
        this.pendingResync = "gap";
      },
      onEvent: (event) => {
        if (generation === this.generation) this.handleEvent(event, generation);
      },
      onCallbackError: (label, error) => this.log("error", `${label}: ${String(error)}`),
      handshake: { mode: "require-challenge", timeoutMs: DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS },
      requestTimeoutMs: this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
      reconnect: { initialMs: reconnect.initialMs, multiplier: 2, maxMs: reconnect.maxMs },
    });
    this.protocol.start();
  }

  /** What one gateway reported that must never be read against another. */
  private forgetGatewayState(): void {
    this.accounts.reset();
    if (this.state.checkIns) this.store.update(({ checkIns: _, ...state }) => state);
    this.routines.reset();
    this.store.update((state) => ({ ...state, usage: initialUsage }));
    // A creation belongs to the gateway it was asked of; it is never asked of another.
    for (const timer of this.creationTimers.values()) clearTimeout(timer);
    this.creationTimers.clear();
    for (const id of [...this.checkingSlots]) this.releaseCheckingSlot(id);
    this.creations.clear();
    for (const waiters of this.creationWaiters.values()) {
      for (const waiter of waiters) waiter.reject(new Error("Switched to another gateway."));
    }
    this.creationWaiters.clear();
    this.approvalOutcomes.clear();
    this.waiting.clear();
    this.unrouted.clear();
    this.recipients.clear();
    this.spawnedBy.clear();
    this.foreign.clear();
    this.foreignReads.clear();
    this.endChecked.clear();
    this.listRequested.clear();
    this.listApplied.clear();
    this.toolReads.clear();
    this.approvalReads.clear();
    for (const { bytes } of this.attachmentContent.values()) this.attachmentBytes -= bytes;
    this.attachmentContent.clear();
  }

  private invalidateCheckIns(): void {
    const checkIns = this.state.checkIns;
    if (checkIns?.gatewayId)
      this.store.update((state) => ({ ...state, checkIns: { ...checkIns, gatewayId: null } }));
  }

  private close(): void {
    this.generation += 1;
    this.invalidateCheckIns();
    this.accounts.onClose();
    this.routines.onClose();
    this.usage.onClose();
    this.protocol?.stop();
    this.protocol = null;
    this.computer.connectionLost();
    this.streams.clear();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    for (const timer of this.historyTimers.values()) clearTimeout(timer);
    this.historyTimers.clear();
    for (const timer of this.turnTimers.values()) clearTimeout(timer);
    this.turnTimers.clear();
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
    // Creations being checked are kept, and checked again after the next hello.
    for (const timer of this.creationTimers.values()) clearTimeout(timer);
    this.creationTimers.clear();
  }

  private handleConnectFailure(
    error: GatewayProtocolRequestError,
    deviceId: string,
    url: string,
    tokenStore: GatewayBrowserDeviceTokenStore,
  ) {
    const details = asRecord(error.details) ?? {};
    const code = typeof details.code === "string" ? details.code : error.gatewayCode;
    const hint = typeof details.remediationHint === "string" ? details.remediationHint : null;

    const mismatch = protocolMismatch(details);
    if (mismatch) {
      this.setConnection({
        status: "error",
        pairing: null,
        retryAt: null,
        error: {
          code: "PROTOCOL_MISMATCH",
          message: protocolMessage(mismatch),
          hint,
          protocol: mismatch,
        },
      });
      return { closeCode: 1000, closeReason: "protocol mismatch", stop: true };
    }

    if (code === "PAIRING_REQUIRED") {
      const requestId = typeof details.requestId === "string" ? details.requestId : "";
      // The request this client was waiting on is gone: the gateway's owner
      // rejected it, or it expired. Stop, and let the user ask again.
      if (pairingEnded(this.pairingSeen, requestId)) {
        this.pairingSeen = null;
        this.setConnection({
          status: "error",
          pairing: null,
          retryAt: null,
          error: { ...PAIRING_ENDED, hint: null },
        });
        return { closeCode: 1000, closeReason: "pairing request ended", stop: true };
      }
      if (requestId) this.pairingSeen = requestId;
      const scopes = Array.isArray(details.requestedScopes)
        ? details.requestedScopes.filter((s): s is string => typeof s === "string")
        : [...REQUESTED_SCOPES];
      const instructions = (this.host.approvalInstructions ?? defaultApprovalInstructions)(
        url,
        requestId,
      );
      this.setConnection({
        status: "pairing",
        error: null,
        pairing: {
          requestId,
          deviceId: typeof details.deviceId === "string" ? details.deviceId : deviceId,
          message: hint ?? "Approve this device from the gateway's pending pairing requests.",
          approveCommand: instructions.command,
          approveNote: instructions.note,
          requestedScopes: scopes,
        },
      });
      // The request id stays the same while we retry, so keep trying quietly
      // and connect as soon as an operator approves it.
      const nextStep = details.recommendedNextStep;
      const terminal = nextStep !== undefined && nextStep !== "wait_then_retry";
      return {
        closeCode: 1000,
        closeReason: "awaiting pairing approval",
        reconnectDelayMs: PAIRING_RETRY_MS,
        ...(terminal ? { stop: true } : {}),
      };
    }

    const refused = code === "AUTH_TOKEN_MISMATCH" || code === "AUTH_DEVICE_TOKEN_MISMATCH";
    if (refused) {
      // A stored device token was revoked or rotated elsewhere. Forget it so the
      // next attempt can pair again with a bootstrap token. The gateway's refusal
      // stays on screen whether or not the host could remove it.
      void (async () => tokenStore.clear(this.tokenParams(deviceId)))().catch(() =>
        this.log("warn", "Could not remove the rejected device token from this device."),
      );
    }

    const pause = shouldPauseGatewayReconnect({ details: error.details });
    this.setConnection({
      status: pause ? "error" : this.everConnected ? "reconnecting" : "connecting",
      pairing: null,
      error: { code, message: error.message, hint },
      ...(refused ? { paired: false } : {}),
    });
    // The gateway stopped accepting this device: work waiting for access will not get it on this connection.
    if (pause)
      this.rejectAccessWaiters(new Error(`The gateway refused this device: ${error.message}`));
    return {
      closeCode: 1000,
      closeReason: "connect rejected",
      ...(pause ? { stop: true } : {}),
    };
  }

  private handleHello(hello: HelloOk, generation: number): void {
    const wasConnected = this.everConnected;
    this.everConnected = true;
    this.pairingSeen = null;
    // Each connection may act for another person: read who again before marking reactions.
    this.selfId = null;
    // The protocol gives a boot id at most 96 characters; anything else names no start.
    const bootId = asRecord(hello.server)?.bootId;
    this.gatewayBootId =
      typeof bootId === "string" && bootId.length > 0 && bootId.length <= 96 ? bootId : null;
    const scopes = [...(hello.auth.scopes ?? [])];
    const canWrite = scopeSatisfied(scopes, WRITE_SCOPE);
    const policy = asRecord(hello.policy);
    const number = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) ? value : null;
    this.payloadLimits = {
      maxPayload: number(policy?.maxPayload),
      maxImageBytes: number(asRecord(policy?.attachments)?.maxImageBytes),
      maxFileBytes: number(asRecord(policy?.attachments)?.maxBytes),
    };
    this.setConnection({
      status: "connected",
      serverVersion: hello.server.version,
      protocol: hello.protocol,
      scopes,
      canWrite,
      canAnswer: scopeSatisfied(scopes, QUESTIONS_SCOPE),
      canApprove: scopeSatisfied(scopes, APPROVALS_SCOPE),
      canAdmin: scopes.includes(ADMIN_SCOPE),
      pairing: null,
      error: null,
      retryAt: null,
      connectedAt: this.now(),
      paired: true,
      sendLimits: this.sendLimits(),
    });
    // Device access asked for before this hello asks with what this connection holds, and no more.
    if (this.upgradeWanted && this.upgradeTier === "held" && !this.scopeUpgrade)
      this.heldBase = ADMIN_SCOPES.filter((scope) => scopes.includes(scope));
    if (
      this.tierScopes(this.upgradeTier).every((scope) => scopeSatisfied(scopes, scope)) &&
      (!this.pairingWanted || scopes.includes(PAIRING_SCOPE))
    ) {
      this.upgradeWanted = false;
      this.upgradeTier = "interactive";
      this.pairingWanted = false;
    } else if (this.upgradeWanted) {
      this.startUpgrade();
    }
    this.settleAccessWaiters();
    this.checkCreations();
    this.checkUnknownDecisions();
    // Whether the computer plugin is loaded comes from the hello's methods; panes that lost a
    // connection while control was held read the browser's leases again before offering anything.
    this.computer.reconnected();
    const methods = asRecord(hello.features)?.methods;
    this.computer.hello(
      Array.isArray(methods) ? methods.filter((m): m is string => typeof m === "string") : [],
    );
    const reason =
      this.pendingResync ?? (wasConnected && !this.quietReconnect ? "reconnect" : null);
    this.pendingResync = null;
    this.quietReconnect = false;
    void this.bootstrap(generation, reason).then(() => {
      if (generation !== this.generation) return;
      this.accounts.onHello();
      // Every connect reads the list again: runs that started or ended while away are in it.
      if (this.state.connection.status === "connected") void this.routines.load();
      this.usage.onHello();
    });
  }

  /** After a connect, read back every approval whose last decision got no answer. */
  private checkUnknownDecisions(): void {
    const ids = new Set<string>();
    for (const transcript of Object.values(this.state.transcripts)) {
      for (const approval of transcript.approvals) {
        if (approval.status === "pending" && approval.decisionError === "unknown")
          ids.add(approval.id);
      }
    }
    // And those no task shows now: their outcome is the approval's, not a task's.
    for (const [id, attempts] of this.approvalAttempts) {
      if (attempts.decisionError === "unknown") ids.add(id);
    }
    for (const id of ids) void this.checkApproval(this.keyShowing(id), id).catch(() => undefined);
  }

  private setDiscovery(patch: Partial<DiscoveryState>): void {
    this.store.update((state) => ({ ...state, discovery: { ...state.discovery, ...patch } }));
  }

  private readGatewayIdentity(): Promise<string | null> {
    const known = this.gatewayIdentity;
    if (known?.epoch === this.epoch) return known.id;
    const gatewayId = this.request("gateway.identity.get", {}).then(
      (result) => {
        const id = asRecord(result)?.deviceId;
        return typeof id === "string" && id ? id : null;
      },
      () => null,
    );
    void gatewayId.then((id) => {
      if (id === null && this.gatewayIdentity?.id === gatewayId) this.gatewayIdentity = null;
    });
    this.gatewayIdentity = { epoch: this.epoch, id: gatewayId };
    return gatewayId;
  }

  /**
   * Every successful connect is a fresh projection: re-list, re-subscribe, reload
   * open transcripts. Bots and tasks load independently, so one failing read
   * keeps the other's result and any data shown before it.
   */
  private async bootstrap(generation: number, resync: CaughtUp["reason"] | null): Promise<void> {
    this.bootstrapping = true;
    this.changedDuringBootstrap = false;
    this.setDiscovery({ status: "loading", error: null });
    // The last gateway's identity goes with the connection it came from, so a
    // write waits for this one's read (routines.ts `blocked`).
    this.setConnection({ gatewayId: null });
    // The gateway's identity comes with its bots, so what this device keeps
    // per gateway (pins, hidden bots, order) is known when the bots appear.
    const gatewayId = this.readGatewayIdentity();
    // Applied here too, so a bot list that fails or is slow to read does not
    // keep the identity back.
    void gatewayId.then((id) => {
      if (id !== null && generation === this.generation) this.setConnection({ gatewayId: id });
    });
    // Bots are published as soon as they arrive, so the app can open on them
    // while tasks are still loading.
    const botsIssued = ++this.botsIssued;
    const [agents, sessions] = await Promise.allSettled([
      this.request("agents.list", {}).then(async (result) => {
        const id = await gatewayId;
        if (generation === this.generation) {
          // A read asked later, after a bot was created, may have answered first.
          const newest = this.newestBots(botsIssued);
          // Only a read that found the identity writes it: an older refresh whose
          // read failed must not clear what a newer one on this connection confirmed.
          this.store.update((state) => ({
            ...state,
            ...(id === null ? {} : { connection: { ...state.connection, gatewayId: id } }),
            ...(newest ? { bots: mapAgents(result) } : {}),
          }));
        }
        return result;
      }),
      this.loadAllSessions(generation, "sessions.subscribe"),
    ]);
    this.bootstrapping = false;
    if (generation !== this.generation) return;

    const failures: string[] = [];
    if (agents.status !== "fulfilled") {
      failures.push(`bots: ${errorMessage(agents.reason)}`);
    }
    if (sessions.status === "fulfilled") {
      this.replaceRows(sessions.value.rows);
      if (this.changedDuringBootstrap) await this.refreshSessions(generation);
    } else {
      failures.push(`tasks: ${errorMessage(sessions.reason)}`);
    }
    if (generation !== this.generation) return;
    for (const key of Object.keys(this.state.transcripts)) {
      if (this.tracked(key)) void this.loadTranscript(key, true, resync);
    }
    void this.loadSidebar(generation);
    void this.loadWaitingQuestions(generation);
    void this.loadWaitingApprovals(generation);

    if (failures.length > 0) {
      this.log("error", `discovery failed: ${failures.join("; ")}`);
      this.setDiscovery({ status: "error", error: `Could not load ${failures.join("; ")}` });
    } else {
      this.setDiscovery({
        status: "ready",
        error: null,
        partial: sessions.status === "fulfilled" && sessions.value.partial,
      });
    }
  }

  // Sessions -------------------------------------------------------------------

  /**
   * Read the whole filtered task list, one page at a time. The first page comes
   * from `sessions.subscribe` at bootstrap and from `sessions.list` on refresh.
   */
  private async loadAllSessions(
    generation: number,
    firstMethod: "sessions.subscribe" | "sessions.list",
  ): Promise<{ rows: Map<string, RawRecord>; partial: boolean }> {
    const first = asRecord(await this.request(firstMethod, SESSION_LIST_PARAMS));
    let page = firstMethod === "sessions.subscribe" ? asRecord(first?.list) : first;
    // Each page is bounded as it arrives: only task rows, only the fields read, the newest
    // `MAX_LISTED_TASKS` of them, so nothing accumulates across pages. The rows so far are
    // kept where the retention registry sees them (`listings`) until the read ends.
    const rows = new Map<string, RawRecord>();
    this.listings.add(rows);
    try {
      for (let pages = 1; ; pages += 1) {
        const next = newestRows([...rows.values(), ...sessionRowsFromList(page)]);
        rows.clear();
        for (const [key, row] of next) rows.set(key, row);
        const nextOffset = page?.nextOffset;
        const more = page?.hasMore === true && typeof nextOffset === "number";
        if (!more) return { rows, partial: false };
        if (pages >= MAX_SESSION_PAGES || generation !== this.generation) {
          return { rows, partial: true };
        }
        page = asRecord(
          await this.request("sessions.list", { ...SESSION_LIST_PARAMS, offset: nextOffset }),
        );
      }
    } finally {
      this.listings.delete(rows);
    }
  }

  private replaceRows(rows: Map<string, RawRecord>): void {
    this.rows = rows;
    this.publishTasks();
  }

  private publishTasks(): void {
    const tasksByBot = groupTasks(this.rows.values());
    // What waits for the person, and whose latest run was stopped (`waiting.ts`): a task the
    // engine follows by its runs, any other by the gateway's events.
    for (const tasks of Object.values(tasksByBot)) {
      for (const [index, task] of tasks.entries()) {
        // A row with no active run ends what waited before it; a newer marker stays.
        if (task.status !== "running") this.waiting.settle(task.key, task.updatedAt);
        const waiting = this.waiting.waitingFor(task.key);
        if (waiting) {
          tasks[index] = {
            ...task,
            status: "waiting",
            waitingFor: waiting.kind,
            waitingSince: waiting.since,
          };
        } else if (
          (task.status === "idle" || task.status === "done") &&
          this.waiting.stoppedAt(task.key) !== null
        ) {
          // A run stopped with `chat.abort` leaves the row no status: its runs or its end said so.
          tasks[index] = { ...task, status: "stopped" };
        }
      }
    }
    this.store.update((state) => ({ ...state, tasksByBot }));
  }

  /** One refresh at a time; one asked for meanwhile runs once after it. */
  private async refreshSessions(generation: number): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    try {
      do {
        this.refreshAgain = false;
        try {
          const { rows, partial } = await this.loadAllSessions(generation, "sessions.list");
          if (generation !== this.generation) return;
          this.replaceRows(rows);
          this.setDiscovery({ partial });
        } catch (error) {
          this.log("warn", `sessions.list failed: ${String(error)}`);
        }
      } while (this.refreshAgain && generation === this.generation);
    } finally {
      this.refreshing = false;
    }
  }

  private scheduleRefresh(generation: number): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshSessions(generation);
    }, 250);
  }

  /**
   * Apply a `sessions.changed` event with the same membership rules as the list.
   * A known row is merged and re-checked. An unknown row whose key is not ruled
   * out cannot prove membership from the payload, so the filtered list is
   * re-read instead of inserting it.
   */
  private handleSessionsChanged(payload: unknown, generation: number): void {
    if (this.bootstrapping) this.changedDuringBootstrap = true;
    this.noteRunChange(payload);
    const row = sessionChangeRow(payload);
    const rowKey = row ? sessionRowKey(row) : null;
    // Rows are kept under the id cap.
    const key = rowKey === null ? null : capId(rowKey, MAX_ID_CHARS);
    if (!row || !key) {
      this.scheduleRefresh(generation);
      return;
    }
    if (isSessionRemoval(payload)) {
      this.cancelAllQueued(key);
      this.retireForeign(key);
      if (this.rows.delete(key)) this.publishTasks();
      return;
    }
    if (row.archived === true) this.cancelAllQueued(key);
    const cached = this.rows.get(key);
    if (!cached) {
      if (!isExcludedSessionKey(key)) this.scheduleRefresh(generation);
      return;
    }
    const merged = mergeSessionRow(cached, row);
    if (isTaskSession(merged)) this.rows.set(key, SESSION_ROW(merged));
    else this.rows.delete(key);
    this.publishTasks();
  }

  /**
   * A `sessions.changed` row for a run's phase. It names the gateway's run id
   * (`runId`) and, for a turn the gateway ran from its queue, the send's id the
   * turn's lifecycle and end carry (`clientRunId`): the first becomes an alias of
   * the second. Its `end` or `error` for a run the task still shows as active,
   * under either id, reads history again, so a run whose own end did not reach
   * this client under the id it knows is settled rather than shown working.
   */
  private noteRunChange(payload: unknown): void {
    const row = asRecord(payload);
    const key = typeof row?.sessionKey === "string" ? row.sessionKey : null;
    const runId = typeof row?.runId === "string" ? capId(row.runId, MAX_ID_CHARS) : null;
    if (!row || !key || !runId) return;
    const clientRunId =
      typeof row.clientRunId === "string" ? capId(row.clientRunId, MAX_ID_CHARS) : null;
    if (!this.tracked(key)) {
      if (row.phase !== "end" && row.phase !== "error") return;
      const sessionKey = capId(key, MAX_ID_CHARS);
      const activity = this.foreign.get(sessionKey);
      // A row naming a run id pair names one run: both ids are kept, so the
      // read and the merge see the run whatever id it or history holds it under.
      const pairs: Array<[string, string]> =
        clientRunId && clientRunId !== runId ? [[runId, clientRunId]] : [];
      const named = [runId, ...pairs.map(([, client]) => client)];
      const ids = new Set(
        named.filter((id) => {
          const run = activity && findRun(activity, id);
          return run
            ? !isTerminal(run.state)
            : [...this.recipients.values()].some((link) => link.runs.has(id));
        }),
      );
      if (ids.size === 0) return;
      for (const id of named) ids.add(id);
      void this.readRecipientRuns(sessionKey, ids, this.generation, undefined, {
        phase: row.phase === "error" ? "error" : "end",
        pairs,
      });
      return;
    }
    if (clientRunId && clientRunId !== runId) {
      this.updateActivity(key, (activity) => registerRunAlias(activity, runId, clientRunId));
    }
    if (row.phase !== "end" && row.phase !== "error") return;
    const transcript = this.state.transcripts[key];
    const named = [runId, clientRunId].flatMap((id) => {
      const run = id && transcript ? findRun(transcript, id) : undefined;
      return run ? [run] : [];
    });
    if (named.some((run) => !isTerminal(run.state) && run.state !== "queued")) {
      this.scheduleHistory(key);
    }
  }

  // Transcripts ----------------------------------------------------------------

  /**
   * A task opened now. What the engine already knows of its runs, from
   * following them while nobody had the task open (a recipient's run, and the
   * question it waits on, by id), is its from the first moment: an outgoing
   * message is held behind that question at once, and the history read and the
   * question list settle it by the same rules as any other.
   */
  private openedTranscript(key: string): Transcript {
    const sessionKey = capId(key, MAX_ID_CHARS);
    const known = this.foreign.get(sessionKey);
    const empty = this.emptyTranscript(key);
    // Only a run known to wait on a question is carried; history rebuilds every other run.
    const waiting = known ? runsWithQuestionMarkers(known) : [];
    // The task holds them now: none is kept twice, and no copy left here goes stale while the
    // task's own events update the task. Letting the task go keeps what another task links to.
    this.foreign.delete(sessionKey);
    if (waiting.length === 0) return empty;
    return { ...empty, runs: waiting };
  }

  private emptyTranscript(key: string): Transcript {
    return {
      ...emptyActivity,
      sessionKey: key,
      status: "loading",
      items: [],
      error: null,
      hasMore: false,
      live: null,
      linkedRuns: {},
      interSession: [],
      mcpTools: {},
      loadedAt: null,
    };
  }

  private setTranscript(key: string, fn: (current: Transcript | undefined) => Transcript): void {
    this.store.update((state) => ({
      ...state,
      transcripts: { ...state.transcripts, [key]: fn(state.transcripts[key]) },
    }));
    // The rail describes a task the engine follows by the same runs the conversation shows.
    const transcript = this.state.transcripts[key];
    if (transcript && this.waiting.hold(key, fromActivity(transcript))) this.publishTasks();
  }

  /**
   * Read a task's history and rebuild its runs from it. Runs already on screen
   * are merged by id and steps by id, and outgoing messages leave the outbox
   * once history holds them, so a reload never duplicates anything.
   */
  /**
   * Reads of one task run one at a time: a read asked for while one is in
   * flight runs once after it, with the strongest resync reason asked for.
   * A response is applied only to the same connection and the same opening of
   * the task, so a slow read never overwrites newer state.
   */
  private loadTranscript(
    key: string,
    subscribe: boolean,
    resync: CaughtUp["reason"] | null,
  ): Promise<void> {
    const load = this.loads.get(key);
    if (load) {
      load.again = {
        subscribe: (load.again?.subscribe ?? false) || subscribe,
        resync: strongerResync(load.again?.resync ?? null, resync),
      };
      return load.done;
    }
    const entry: {
      done: Promise<void>;
      again: { subscribe: boolean; resync: CaughtUp["reason"] | null } | null;
    } = {
      done: Promise.resolve(),
      again: null,
    };
    this.loads.set(key, entry);
    entry.done = (async () => {
      let next: { subscribe: boolean; resync: CaughtUp["reason"] | null } | null = {
        subscribe,
        resync,
      };
      while (next) {
        await this.readTranscript(key, next.subscribe, next.resync);
        next = entry.again;
        entry.again = null;
      }
      if (this.loads.get(key) === entry) this.loads.delete(key);
    })();
    return entry.done;
  }

  /**
   * Read a task's history and rebuild its runs from it. Runs already on screen
   * are merged by id and steps by id, and outgoing messages leave the outbox
   * once history holds them, so a reload never duplicates anything.
   */
  private async readTranscript(
    key: string,
    subscribe: boolean,
    resync: CaughtUp["reason"] | null,
  ): Promise<void> {
    const generation = this.generation;
    const incarnation = this.incarnations.get(key);
    const stale = () =>
      generation !== this.generation ||
      !this.tracked(key) ||
      this.incarnations.get(key) !== incarnation;
    // Runs active when the read starts; one the gateway then no longer has has ended.
    const activeBefore = new Set(
      (this.state.transcripts[key]?.runs ?? [])
        .filter((run) => run.bound && !isTerminal(run.state) && run.state !== "queued")
        .map((run) => run.id),
    );
    try {
      if (subscribe) {
        await this.request("sessions.messages.subscribe", { key }).catch((error: unknown) => {
          this.log("warn", `sessions.messages.subscribe failed: ${String(error)}`);
        });
      }
      const history = asRecord(
        await this.request("chat.history", { sessionKey: key, limit: HISTORY_LIMIT }),
      );
      if (stale()) return;
      // A resync starts every stream of this task again from what the gateway sends next.
      if (resync) this.streams.retire(key);
      // A queued turn's two ids, as history pairs them, whatever this client holds: kept, so a
      // pairing frame missed in a gap, or a transcript built from history alone, still makes
      // one run, and later frames under either id update that run.
      const pairs = historyQueuePairs(history?.messages);
      if (pairs.length > 0) {
        this.updateActivity(key, (activity) =>
          pairs.reduce(
            (next, [gateway, client]) => registerRunAlias(next, gateway, client),
            activity,
          ),
        );
      }
      const { messages, inFlight } = throughRunAliases(
        history?.messages,
        asRecord(history?.inFlightRun),
        this.state.transcripts[key]?.queueAliases ?? {},
      );
      const inFlightId = typeof inFlight?.runId === "string" ? inFlight.runId : null;
      const ctx = this.context(key);
      // History is built aside; only the steps the merge takes from it bring their raw payloads.
      const scratch = new RawTable();
      // The gateway has a turn of this task in flight or queued: a run history only infers to
      // have ended is not ended by this read.
      const busy = inFlightId !== null || holdsInput(history);
      const fromHistory = runsFromHistory(
        messages,
        inFlight,
        { ...ctx, raw: scratch },
        { windowCut: history?.hasMore === true, busy },
      );
      const current = this.state.transcripts[key] ?? this.emptyTranscript(key);
      const merge = mergeHistoryRuns(current.runs, fromHistory, ctx, busy);
      for (const stepId of merge.fromHistory) {
        const payload = scratch.get(key, stepId);
        if (payload) this.raw.set(key, stepId, payload);
      }
      const historyIds = new Set(fromHistory.map((run) => run.id));
      const awaitingAnswer = new Set(
        current.outbox
          .filter((message) => message.status === "sending" || message.status === "awaiting-access")
          .map((message) => message.id),
      );
      const runs = settleUnboundStops(
        settleVanishedRuns(merge.runs, activeBefore, historyIds, inFlightId, ctx, busy),
        inFlightId,
        historyIds,
        awaitingAnswer,
        ctx,
      );
      // A Stop asked before the gateway named its run: the run in flight under the send's id
      // is that run, named now, and is stopped; so is one settled earlier with no known outcome.
      const toStop = runs.filter(
        (run) =>
          run.id === inFlightId &&
          run.stopRequestedAt !== null &&
          ((run.state === "stopping" && !findRun(current, run.id)?.bound) ||
            (run.state === "stopped" && !run.outcomeKnown)),
      );
      const reconciled = reconcileOutbox(
        parkAfterStop(current, { ...current, runs }, this.now()),
        messages,
      );
      // History holds these now: their files are no longer needed.
      for (const message of current.outbox) {
        if (!reconciled.outbox.some((each) => each.id === message.id))
          this.dropAttachments(message.id);
      }
      const activity = markUnconfirmed(reconciled);
      const items = mapHistory(messages);
      const rebuilt: Transcript = {
        ...current,
        ...retainActivity(
          settleQuestionsOfEndedRuns(normalizeApprovals(activity, (runId) => this.otherRun(runId))),
        ),
        sessionKey: key,
        status: "ready",
        items,
        interSession: interSessionMessages(messages),
        // Reactions leave with the history they belonged to (F-283).
        ...(current.reactions ? { reactions: reactionsShown(current.reactions, items) } : {}),
        error: null,
        hasMore: history?.hasMore === true,
        caughtUp: resync ? { reason: resync, at: this.now() } : current.caughtUp,
        loadedAt: this.now(),
      };
      this.retainTaskRaw(key, rebuilt);
      this.setTranscript(key, () => withLive(rebuilt));
      // A read is news of its own: the runs it leaves active are asked again.
      this.endChecked.delete(key);
      this.afterActivity(key);
      // A run settled from history may be a recipient another open task's card follows.
      this.refreshLinkersOf(key, current.runs, rebuilt.runs);
      for (const run of toStop) void this.abortRun(key, run.id);
      void this.readRecipients(key, generation);
      void this.backfillQuestions(key, generation);
      void this.backfillApprovals(key, generation);
      void this.readToolMap(key, generation);
      void this.readReactions(key, generation);
      if (current.workspaceRoot === undefined) void this.readWorkspaceRoot(key, generation);
    } catch (error) {
      if (stale()) return;
      this.setTranscript(key, (current) => ({
        ...(current ?? this.emptyTranscript(key)),
        status: "error",
        error: errorMessage(error),
      }));
    }
  }

  private scheduleHistory(key: string, resync: CaughtUp["reason"] | null = null): void {
    if (resync) this.resyncReasons.set(key, resync);
    if (this.historyTimers.has(key)) return;
    this.historyTimers.set(
      key,
      setTimeout(() => {
        this.historyTimers.delete(key);
        const reason = this.resyncReasons.get(key) ?? null;
        this.resyncReasons.delete(key);
        void this.loadTranscript(key, false, reason);
      }, 150),
    );
  }

  private handleChat(event: EventFrame): void {
    const payload = asRecord(event.payload);
    const key = typeof payload?.sessionKey === "string" ? payload.sessionKey : null;
    const runId = typeof payload?.runId === "string" ? payload.runId : null;
    if (!payload || !key || !runId) return;
    this.noteSpawnedBy(payload);
    if (payload.state === "final" || payload.state === "error" || payload.state === "aborted") {
      const botId = botIdFromSessionKey(key);
      if (botId) this.usage.onRunEnded(botId);
    }
    if (!this.tracked(key)) {
      this.updateForeign(key, (activity, ctx) => applyChatEvent(activity, payload, null, ctx));
      return;
    }
    // Only tasks this client follows keep a stream baseline: the text, never the message.
    const projected = this.streams.project(payload);
    const text = payload.state === "delta" ? projected : null;
    this.updateActivity(key, (activity, ctx) => applyChatEvent(activity, payload, text, ctx));
    // final, aborted or error: the durable transcript now owns the text.
    if (payload.state !== "delta" && payload.state !== "status") this.scheduleHistory(key);
  }

  /** Agent events carry the session key on the wire; fall back to the open task that knows the run. */
  /** Remember which session spawned which, so a helper's approval reaches its parent task. */
  private noteSpawnedBy(payload: RawRecord): void {
    if (typeof payload.sessionKey !== "string" || typeof payload.spawnedBy !== "string") return;
    const child = capId(payload.sessionKey, MAX_ID_CHARS);
    const parent = capId(payload.spawnedBy, MAX_ID_CHARS);
    if (child === parent) return;
    const known = this.spawnedBy.get(child) === parent;
    this.spawnedBy.delete(child);
    this.spawnedBy.set(child, parent);
    while (this.spawnedBy.size > MAX_SPAWN_LINKS)
      this.spawnedBy.delete(this.spawnedBy.keys().next().value as string);
    // A helper's approval that arrived before its spawn was known can be placed now.
    if (!known) this.routeUnrouted();
  }

  private handleAgent(event: EventFrame): void {
    const payload = asRecord(event.payload);
    if (!payload || typeof payload.runId !== "string") return;
    this.noteSpawnedBy(payload);
    let key = typeof payload.sessionKey === "string" ? payload.sessionKey : null;
    if (!key) {
      const runId = payload.runId;
      key =
        Object.values(this.state.transcripts).find((transcript) => findRun(transcript, runId))
          ?.sessionKey ?? null;
    }
    if (!key) return;
    if (!this.tracked(key)) {
      this.updateForeign(key, (activity, ctx) => applyAgentEvent(activity, payload, ctx).activity);
      return;
    }
    this.updateActivity(key, (activity, ctx) => applyAgentEvent(activity, payload, ctx).activity);
    const phase = asRecord(payload.data)?.phase;
    if (payload.stream === "lifecycle" && (phase === "end" || phase === "error")) {
      this.scheduleHistory(key);
    }
  }

  private handleEvent(event: EventFrame, generation: number): void {
    switch (event.event) {
      case "sessions.changed":
        this.handleSessionsChanged(event.payload, generation);
        return;
      case "plugins.changed":
        // Tool-server tools come from the gateway's bundle-mcp plugin: read each task's map again.
        for (const key of Object.keys(this.state.transcripts)) {
          if (this.tracked(key)) void this.readToolMap(key, generation);
        }
        return;
      case "session.message": {
        const key = asRecord(event.payload)?.sessionKey;
        if (typeof key === "string" && this.tracked(key)) this.scheduleHistory(key);
        return;
      }
      case "chat":
        this.handleChat(event);
        return;
      case "agent": {
        const payload = asRecord(event.payload);
        if (payload && this.waiting.onAgent(payload, this.now())) this.publishTasks();
        this.handleAgent(event);
        return;
      }
      case "cron":
        this.routines.onEvent(event.payload);
        return;
      case "session.reaction": {
        // Someone, here or elsewhere, added or removed a reaction: the message's reactions now.
        const payload = asRecord(event.payload);
        const key = typeof payload?.sessionKey === "string" ? payload.sessionKey : null;
        const messageId = typeof payload?.messageId === "string" ? payload.messageId : null;
        if (key && messageId && this.tracked(key))
          this.applyReactions(key, messageId, payload?.reactions);
        return;
      }
      case "users.prefs.changed": {
        const keys = asRecord(event.payload)?.keys;
        if (Array.isArray(keys) && keys.includes(SIDEBAR_PREF_KEY))
          void this.loadSidebar(this.generation);
        this.usage.onPrefsChanged(keys);
        return;
      }
      case "question.requested": {
        const record = asRecord(event.payload);
        if (record && this.waiting.onQuestionRequested(record, this.now())) this.publishTasks();
        const key = typeof record?.sessionKey === "string" ? record.sessionKey : null;
        if (record && key && this.tracked(key)) {
          this.updateActivity(key, (activity, ctx) =>
            applyQuestionRequested(activity, record, ctx),
          );
        } else if (
          record &&
          key &&
          typeof record.runId === "string" &&
          this.foreign.get(capId(key, MAX_ID_CHARS))?.runs.some((run) => run.id === record.runId)
        ) {
          // A recipient's run this client follows asks its own user: it waits.
          this.updateForeign(key, (activity, ctx) =>
            foreignQuestionRequested(activity, record, ctx),
          );
        }
        return;
      }
      case "exec.approval.requested":
      case "plugin.approval.requested":
      case "openclaw.approval.requested": {
        const card =
          event.event === "exec.approval.requested"
            ? parseExecApproval(event.payload)
            : event.event === "plugin.approval.requested"
              ? parsePluginApproval(event.payload)
              : parseSystemAgentApproval(event.payload);
        if (card) this.routeApproval(admitApproval(card));
        return;
      }
      case "exec.approval.resolved":
      case "plugin.approval.resolved":
      case "openclaw.approval.resolved": {
        const kind: ApprovalKind =
          event.event === "exec.approval.resolved"
            ? "exec"
            : event.event === "plugin.approval.resolved"
              ? "plugin"
              : "system-agent";
        const resolution = parseApprovalResolved(event.payload, kind);
        if (resolution && this.waiting.onApprovalResolved(resolution.id)) this.publishTasks();
        // Kept even when no card has arrived yet: its request or list entry may come later.
        if (resolution) this.noteApprovalOutcome(resolution);
        return;
      }
      case CONTROL_EVENT:
        this.computer.controlEvent(event.payload);
        return;
      case "question.resolved": {
        const payload = asRecord(event.payload);
        const id = payload?.id;
        if (!payload || typeof id !== "string") return;
        // Read from the runs as they were, told once the transcript records the closure.
        const closed = this.questionClosures(id, payload.status);
        if (this.waiting.onQuestionResolved(id)) this.publishTasks();
        for (const [key, activity] of [...this.foreign.entries()]) {
          if (activity.runs.some((run) => run.pendingCards.some((card) => card.id === id)))
            this.updateForeign(key, (each) => foreignQuestionResolved(each, payload));
        }
        for (const transcript of Object.values(this.state.transcripts)) {
          if (transcript.questions.some((question) => question.id === id)) {
            this.updateActivity(transcript.sessionKey, (activity) =>
              applyQuestionResolved(activity, payload, {
                via: "question.resolved",
                record: event.payload,
              }),
            );
          } else if (questionMarkers(transcript).includes(id)) {
            // Known only by its id, from before the task was opened: its run goes on.
            this.updateActivity(transcript.sessionKey, (activity) =>
              foreignQuestionResolved(activity, payload),
            );
          }
        }
        for (const [key, code] of closed) this.computer.questionClosed(key, id, code);
        return;
      }
      default:
        return;
    }
  }

  // The Computer tab (`computer.ts`, `machine.ts`) ---------------------------------------

  /**
   * How a question closed, for each task that holds it, read from its run before the
   * resolution is applied: an answer queued behind a release of that task's browser is removed,
   * and the control bar learns the question went, once the transcript records it.
   */
  private questionClosures(id: string, status: unknown): Array<[string, ClosedCode]> {
    const out: Array<[string, ClosedCode]> = [];
    for (const transcript of Object.values(this.state.transcripts)) {
      const question = transcript.questions.find((q) => q.id === id);
      if (!question) continue;
      const run = question.runId ? findRun(transcript, question.runId) : undefined;
      // Only a run that has ended ended it; one still stopping has a Stop the gateway hasn't
      // confirmed, and the question it cancels was cancelled.
      const runOver = run !== undefined && isTerminal(run.state);
      const code: ClosedCode =
        status === "answered"
          ? "answered"
          : status === "expired"
            ? "expired"
            : runOver
              ? "run-ended"
              : status === "cancelled"
                ? run?.state === "stopping"
                  ? "cancelled"
                  : "dismissed"
                : "cancelled";
      out.push([transcript.sessionKey, code]);
    }
    return out;
  }

  /**
   * "Stop <Bot> in this task": the conversation's Stop, for every run of the task still going,
   * each by its own id as archive and delete stop them, even when none is established as the
   * current one. Asked for `owner`, it is withdrawn with it while it waits for write access.
   */
  private async stopTask(key: string, owner: object | null): Promise<StopAnswer> {
    const runs = (this.state.transcripts[key]?.runs ?? []).filter(
      (run) => run.state === "running" || run.state === "waiting",
    );
    if (runs.length === 0) {
      await this.ensureScope(WRITE_SCOPE, owner);
      this.checkNotWithdrawn(owner);
      const result = asRecord(await this.request("chat.abort", { sessionKey: key }));
      // As the gateway said it: `aborted` true or false, or null when its answer didn't say.
      return { runIds: [], aborted: typeof result?.aborted === "boolean" ? result.aborted : null };
    }
    // Each as the conversation's Stop: stopping until the run's end, back to running with the
    // gateway's refusal (`revertStop`).
    // All at once: one run's slow answer never holds another's Stop back.
    await Promise.all(
      runs.map((run) =>
        this.stopRun(key, run.id, owner ? { owner, everyRun: true } : { everyRun: true }),
      ),
    );
    return { runIds: runs.map((run) => run.id), aborted: null };
  }

  /** A viewer id for a bridge session: its pane in `state.computer.panes`. */
  computerViewer(): string {
    return this.computer.newViewer();
  }
  computerShow(viewer: string, key: string): void {
    this.computer.show(viewer, key);
  }
  computerLeave(viewer: string): void {
    this.computer.leave(viewer);
  }
  computerDispose(viewer: string): void {
    this.computer.dispose(viewer);
  }
  computerTabs(viewer: string): Promise<void> {
    return this.computer.readTabs(viewer);
  }
  computerChoose(viewer: string, targetId: string): void {
    this.computer.choose(viewer, targetId);
  }
  computerWatch(viewer: string): Promise<void> {
    return this.computer.watch(viewer);
  }
  computerStopWatching(viewer: string): void {
    this.computer.stopWatching(viewer);
  }
  computerFrame(viewer: string, n: number, after: number): Promise<ComputerFrame | null> {
    return this.computer.frame(viewer, n, after);
  }
  computerTake(viewer: string): Promise<void> {
    return this.computer.take(viewer);
  }
  computerCancelTake(viewer: string): void {
    this.computer.cancelTake(viewer);
  }
  computerInput(viewer: string, input: ComputerInput): boolean {
    return this.computer.input(viewer, input);
  }
  computerRelease(
    viewer: string,
    answer: { questionId: string; itemId: string; option: number } | null,
  ): void {
    this.computer.release(viewer, answer ? { answer } : {});
  }
  computerCheck(viewer: string): Promise<void> {
    return this.computer.check(viewer);
  }
  computerDismiss(viewer: string): void {
    this.computer.dismiss(viewer);
  }
  computerStopTask(viewer: string, options: { owner?: object } = {}): Promise<void> {
    return this.computer.stopTask(viewer, options.owner ?? null);
  }

  /** Where the task's bot runs its commands, and the named nodes' records, read now. */
  async readMachine(key: string, nodes: string[], probe = false): Promise<MachineFacts> {
    if (this.state.connection.status !== "connected")
      throw new Error("Not connected to the gateway.");
    const botId = botIdFromSessionKey(key);
    if (!botId) throw new Error("This task's bot is not known.");
    // Read on the gateway it started on, all of it: one chosen since answers nothing for it.
    const generation = this.generation;
    const same = () => {
      if (generation !== this.generation) throw new Error("Switched to another gateway.");
    };
    const request = async (method: string, params: unknown) => {
      same();
      const result = await this.request(method, params);
      same();
      return result;
    };
    // "Prepare it again" asks the gateway to prepare its own desktop; everything else only reads.
    if (probe) await request("computer.status", { probe: true }).catch(() => null);
    same();
    const facts = await readMachine(request, botId, nodes, this.now());
    same();
    return facts;
  }

  // Managing tasks and the rail's arrangement (`task-actions.ts`, `sidebar.ts`) --------

  /**
   * The context the rail's actions run in: the gateway, and the write tier,
   * asked for through the same request as sending (`ensureScope`) only when an
   * action needs it, by the viewer that started it.
   */
  private actionContext(owner: object | null): TaskActionContext & SidebarContext {
    const generation = this.generation;
    return {
      request: async (method, params) => {
        this.checkNotWithdrawn(owner);
        if (generation !== this.generation) throw new Error("Switched to another gateway.");
        try {
          return await this.request(method, params);
        } catch (error) {
          this.noteMissingScope(error);
          throw error;
        }
      },
      ensureWrite: async () => {
        if (this.options.readOnly)
          throw new Error("This host only reads; it does not change tasks.");
        await this.ensureScope(WRITE_SCOPE, owner);
        this.checkNotWithdrawn(owner);
      },
      now: () => this.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      stopMark: (key) => this.waiting.stopMark(key),
      stopRuns: async (key) => {
        const runs = this.state.transcripts[key]?.runs ?? [];
        await Promise.all(
          runs
            .filter((run) => run.state === "running" || run.state === "waiting")
            .map((run) =>
              this.stopRun(key, run.id, owner ? { owner, everyRun: true } : { everyRun: true }),
            ),
        );
        return (this.state.transcripts[key]?.runs ?? []).filter((run) => isActive(run.state))
          .length;
      },
      runsActive: (key) =>
        (this.state.transcripts[key]?.runs ?? []).some((run) => isActive(run.state)),
      runMark: (key) => {
        const row = this.rows.get(capId(key, MAX_ID_CHARS));
        const active = row?.hasActiveRun === true || row?.status === "running";
        return `${this.waiting.latestRunId(key) ?? ""}\u0000${active ? "active" : "idle"}`;
      },
    };
  }

  /** A task the gateway just created, listed at once from its answer until `sessions.changed` brings its row. */
  private listCreated(created: CreatedTask): string {
    const key = capId(created.key, MAX_ID_CHARS);
    if (!this.rows.has(key) && isTaskSession(created.row)) {
      // Within the same bound as a list read: the newest `MAX_LISTED_TASKS`, the oldest giving way.
      this.rows = newestRows([...this.rows.values(), created.row]);
      this.publishTasks();
    }
    return created.key;
  }

  /** A new, empty task under a bot (F-054). Answers its key, already in the task list. */
  async newTask(
    botId: string,
    options: { label?: string | null; owner?: object } = {},
  ): Promise<string> {
    const ctx = this.actionContext(options.owner ?? null);
    return this.listCreated(await newTask(ctx, botId, options.label ?? null));
  }

  /** A bot's replacement first task, "Main", after its last unarchived task went (F-424). */
  async newMainTask(botId: string, options: { owner?: object } = {}): Promise<string> {
    return this.listCreated(await newMainTask(this.actionContext(options.owner ?? null), botId));
  }

  async renameTask(key: string, label: string, options: { owner?: object } = {}): Promise<void> {
    await renameTask(this.actionContext(options.owner ?? null), key, label);
  }

  async pinTask(key: string, pinned: boolean, options: { owner?: object } = {}): Promise<void> {
    await pinTask(this.actionContext(options.owner ?? null), key, pinned);
  }

  /**
   * Mark a task unread or read. `opened` is a read the person did not ask for
   * (opening the task): it names the unread marker it saw, and is made only
   * while the connection already writes, never asking for access.
   */
  async markTask(
    key: string,
    unread: boolean,
    options: { owner?: object; opened?: boolean } = {},
  ): Promise<void> {
    if (options.opened) {
      if (!this.holds(WRITE_SCOPE) || this.options.readOnly) return;
      const id = capId(key, MAX_ID_CHARS);
      const row = this.rows.get(id);
      if (!row || row.unread !== true || this.openedReads.has(id)) return;
      if (this.openedReads.size >= MAX_OPENED_READS) return;
      const marker = typeof row.markedUnreadAt === "number" ? row.markedUnreadAt : null;
      this.openedReads.add(id);
      try {
        await markTask(this.actionContext(options.owner ?? null), key, false, marker);
      } finally {
        this.openedReads.delete(id);
      }
      return;
    }
    await markTask(this.actionContext(options.owner ?? null), key, unread);
  }

  async archiveTask(
    key: string,
    options: { stop?: boolean; owner?: object } = {},
  ): Promise<ArchiveResult> {
    return archiveTask(this.actionContext(options.owner ?? null), key, {
      stop: options.stop === true,
    });
  }

  async restoreTask(key: string, options: { owner?: object } = {}): Promise<void> {
    await restoreTask(this.actionContext(options.owner ?? null), key);
  }

  async deleteTask(key: string, options: { owner?: object } = {}): Promise<void> {
    await deleteTask(this.actionContext(options.owner ?? null), key);
  }

  /** A bot's archived tasks, read now and not kept (`operator.read`). */
  async listArchived(botId: string): Promise<ArchivedList> {
    if (this.state.connection.status !== "connected")
      throw new Error("Not connected to the gateway.");
    return listArchived(this.actionContext(null), botId);
  }

  /** Change the rail's arrangement on the gateway; `base` is this device's, for the first change. */
  async changeSidebar(
    change: SidebarChange,
    base: SidebarPrefs | null,
    options: { owner?: object } = {},
  ): Promise<void> {
    const generation = this.generation;
    // Asked now: a read asked after this write began outranks its answer when they tie.
    const issued = ++this.sidebarIssued;
    const next = await changeSidebar(this.actionContext(options.owner ?? null), change, base);
    // Shown only if nothing newer, by the arrangement's own revision, is shown already.
    if (generation === this.generation) this.setSidebar(next, issued);
  }

  // Usage and warning budgets (`usage.ts`, `usage-engine.ts`; controls.md sections 16, 17) ------

  /** A page's usage figures, read now and not kept; `busy` while the host reads as many as it reads at once. */
  readUsage(request: Omit<UsageReportRequest, "bots">): Promise<UsageReport | UsageBusy> {
    if (this.state.connection.status !== "connected")
      return Promise.reject(new Error("Not connected to the gateway."));
    return this.usage.readReport({ ...request, bots: this.state.bots.map((bot) => bot.id) });
  }

  /** Set or remove a warning budget, kept with the gateway as this person's preference. */
  async changeBudget(change: BudgetChange, options: { owner?: object } = {}): Promise<void> {
    if (this.options.readOnly) throw new Error("This host only reads; it does not change budgets.");
    const owner = options.owner ?? null;
    const url = this.settings?.url;
    await this.actionContext(owner).ensureWrite();
    // A grant of write access reconnects to the same gateway, so the write is bound to the
    // connection that holds it now. A switch to another gateway is never written to.
    if (this.settings?.url !== url) throw new Error("Switched to another gateway.");
    // Every request of the write is the viewer's: none is sent once that viewer has gone.
    await this.usage.changeBudget(change, this.actionContext(owner).request);
  }

  /** The routines a budget can be set for, read now and not kept. */
  listRoutines(): Promise<BudgetRoutine[]> {
    if (this.state.connection.status !== "connected")
      return Promise.reject(new Error("Not connected to the gateway."));
    return this.usage.listRoutines();
  }

  /** Count every budget, and read the providers' limits, again now. */
  async refreshUsage(): Promise<void> {
    if (this.state.connection.status !== "connected") return;
    await Promise.all([this.usage.countBudgets(), this.usage.refreshLimits()]);
  }

  /**
   * Show an arrangement unless a newer one is shown: answers are ordered by the revision the
   * gateway holds with the arrangement (`SidebarPrefs.rev`), never by when they arrive, so a
   * late read or an old write's acknowledgement never hides another device's later change.
   */
  private setSidebar(sidebar: SidebarState, issued: number): void {
    const shown = this.state.sidebar;
    if (sidebar.status === "ok" && shown?.status === "ok") {
      const next = sidebarRev(sidebar.prefs);
      const now = sidebarRev(shown.prefs);
      // A tie (the same revision, or values with none) goes to what was asked last.
      if (next < now || (next === now && issued < this.sidebarShown)) return;
    }
    this.sidebarShown = Math.max(this.sidebarShown, issued);
    this.store.update((state) => ({ ...state, sidebar }));
  }

  /** Read the arrangement the gateway keeps; on any failure the rail keeps its own. */
  private async loadSidebar(generation: number): Promise<void> {
    const issued = ++this.sidebarIssued;
    try {
      const sidebar = await readSidebar(this.actionContext(null));
      if (generation === this.generation) this.setSidebar(sidebar, issued);
    } catch (error) {
      this.log("warn", `users.prefs.get failed: ${errorMessage(error)}`);
      if (generation === this.generation && this.state.sidebar?.status !== "ok")
        this.setSidebar({ ...initialSidebar, status: "unavailable" }, issued);
    }
  }

  /**
   * The approvals pending at a connect, for the rail's waiting state (needs
   * `operator.approvals`). The gateway lists a pending approval only to the
   * device whose run asked for it (and to admin), so this restores this device's
   * own; another device learns of one only from the run's live lifecycle.
   */
  private async loadWaitingApprovals(generation: number): Promise<void> {
    if (!this.holds(APPROVALS_SCOPE)) return;
    let changed = false;
    for (const source of APPROVAL_SOURCES) {
      try {
        const value = await this.request(source.method, {});
        if (generation !== this.generation) return;
        const record = asRecord(value);
        const items = Array.isArray(value)
          ? value
          : Array.isArray(record?.approvals)
            ? record.approvals
            : [];
        for (const item of items) {
          const card = source.parse(item);
          if (card?.status === "pending")
            changed = this.waiting.restoreApproval(card, this.now()) || changed;
        }
      } catch (error) {
        this.log("warn", `${source.method} failed: ${errorMessage(error)}`);
      }
    }
    if (changed) this.publishTasks();
  }

  /** The questions pending at a connect, for the rail's waiting state (needs `operator.questions`). */
  private async loadWaitingQuestions(generation: number): Promise<void> {
    if (!this.holds(QUESTIONS_SCOPE)) return;
    try {
      const listed = asRecord(await this.request("question.list", {}));
      if (generation !== this.generation) return;
      const questions = Array.isArray(listed?.questions) ? listed.questions : [];
      this.waiting.replaceQuestions(questions, this.now());
      this.publishTasks();
    } catch (error) {
      this.log("warn", `question.list failed: ${errorMessage(error)}`);
    }
  }

  // Helpers --------------------------------------------------------------------

  private request(
    method: string,
    params: unknown,
    options?: { onSent?: (requestId: string) => void },
  ): Promise<unknown> {
    if (!this.protocol) return Promise.reject(new NotSentError());
    return this.protocol.request(method, params, options);
  }

  private setConnection(patch: Partial<ConnectionState>): void {
    this.store.update((state) => ({ ...state, connection: { ...state.connection, ...patch } }));
  }

  private async loadIdentity() {
    this.identity ??= await this.host.signer.loadIdentity();
    return this.identity;
  }

  private async loadToken(
    url: string,
    deviceId: string,
    role: string,
  ): Promise<StoredDeviceToken | null> {
    const raw = await this.host.storage.get(this.tokenKey(url, deviceId, role));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredDeviceToken> & { scopes?: string[] };
    if (typeof parsed.token !== "string") return null;
    return {
      token: parsed.token,
      // Earlier builds stored the grant as `scopes`.
      grantedScopes: parsed.grantedScopes ?? parsed.scopes ?? [],
      // Records from before the write step-up mean read only. Admin is held only when this
      // client asked for it and recorded the grant (`adminHeld`), never because a grant lists it.
      heldScopes: [
        ...normalizeHeldScopes(parsed.heldScopes),
        ...(parsed.adminHeld === true ? [ADMIN_SCOPE] : []),
        ...(parsed.pairingHeld === true ? [PAIRING_SCOPE] : []),
      ],
      ...(parsed.adminHeld === true ? { adminHeld: true } : {}),
      ...(parsed.pairingHeld === true ? { pairingHeld: true } : {}),
    };
  }

  private async writeToken(
    url: string,
    deviceId: string,
    role: string,
    record: StoredDeviceToken,
  ): Promise<void> {
    await this.host.storage.set(this.tokenKey(url, deviceId, role), JSON.stringify(record));
  }

  private tokenParams(deviceId: string) {
    return { clientId: CLIENT_ID, deviceId, role: "operator" };
  }

  /** Device tokens are scoped to one gateway, so a token is never offered to another. */
  private tokenKey(url: string, deviceId: string, role: string): string {
    return `deviceToken:${encodeURIComponent(url)}:${deviceId}:${role}`;
  }

  /**
   * A token store for one connection. Every operation names its gateway URL,
   * and a write is dropped once that connection is no longer current, checked
   * after every wait, so a late write can never land after a switch.
   */
  private connectionTokenStore(url: string, generation: number): GatewayBrowserDeviceTokenStore {
    const current = () => generation === this.generation && this.settings?.url === url;
    return {
      // The lifecycle uses the record's scopes for reconnects. Report the
      // scopes this client means to hold, so a broader grant is never asked for.
      load: async ({ deviceId, role }) => {
        const record = await this.loadToken(url, deviceId, role);
        if (!record) return null;
        return {
          token: record.token,
          scopes: this.options.readOnly ? [...READ_SCOPES] : [...record.heldScopes],
        };
      },
      store: async ({ deviceId, role, token, scopes }) => {
        if (!current()) return;
        const existing = await this.loadToken(url, deviceId, role);
        if (!current()) return;
        await this.writeToken(url, deviceId, role, {
          token,
          grantedScopes: scopes,
          heldScopes: existing?.heldScopes ?? [...READ_SCOPES],
          ...(existing?.adminHeld ? { adminHeld: true } : {}),
          ...(existing?.pairingHeld ? { pairingHeld: true } : {}),
        });
      },
      clear: async ({ deviceId, role }) => {
        if (!current()) return;
        await this.host.storage.delete(this.tokenKey(url, deviceId, role));
      },
    };
  }

  private now(): number {
    return this.host.now?.() ?? Date.now();
  }

  private randomId(): string {
    if (this.host.randomId) return this.host.randomId();
    const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  private log(level: "debug" | "info" | "warn" | "error", message: string): void {
    this.host.log?.(level, message);
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const RESYNC_STRENGTH: Record<CaughtUp["reason"], number> = { reconnect: 1, gap: 2 };

function strongerResync(
  a: CaughtUp["reason"] | null,
  b: CaughtUp["reason"] | null,
): CaughtUp["reason"] | null {
  if (!a) return b;
  if (!b) return a;
  return RESYNC_STRENGTH[b] > RESYNC_STRENGTH[a] ? b : a;
}

/**
 * Whether a step rebuilt from history is the step shown: for a tool, the
 * gateway's own call id; for reasoning, the fetched text begins with the text
 * the shown step holds (which keeps the beginning of its text).
 */
function sameStep(
  shown: Run["steps"][number],
  read: Run["steps"][number],
  whole: StepRaw,
): boolean {
  if (shown.kind === "tool")
    return (
      read.kind === "tool" && shown.toolCallId !== null && read.toolCallId === shown.toolCallId
    );
  const thinking = asRecord(whole.call)?.thinking;
  return (
    read.kind === "reasoning" &&
    typeof thinking === "string" &&
    thinking.startsWith(shown.output?.text ?? "")
  );
}

/**
 * Whether the history the gateway returned replaced the message that holds a
 * step with its oversized placeholder (`__openclaw.truncated` with reason
 * `oversized`, for a message above its 131,072-byte limit, whatever
 * `maxChars` asked): a tool result naming the step's call, or an assistant
 * message of the step's run where the step's reasoning anchor is in effect.
 */
function oversizedWhere(
  messages: unknown,
  runId: string,
  step: Run["steps"][number],
  windowCut: boolean,
): boolean {
  const rows = Array.isArray(messages) ? messages : [];
  const oversized = (row: RawRecord) => {
    const meta = asRecord(row.__openclaw);
    return meta?.truncated === true && meta.reason === "oversized";
  };
  if (step.kind === "tool") {
    return rows.some((entry) => {
      const row = asRecord(entry);
      return (
        row !== null &&
        oversized(row) &&
        (row.toolCallId ?? row.tool_call_id ?? row.toolUseId ?? row.tool_use_id) === step.toolCallId
      );
    });
  }
  // The step's anchor, from its id: `reasoning:<runId>:<anchor>:<n>`.
  const prefix = `reasoning:${runId}:`;
  if (!step.id.startsWith(prefix)) return false;
  const rest = step.id.slice(prefix.length);
  const anchor = rest.slice(0, rest.lastIndexOf(":"));
  const first = asRecord(rows[0]);
  let current =
    windowCut && first && first.role !== "user" && asRecord(first.__openclaw)?.runId === runId
      ? "c"
      : "s";
  for (const entry of rows) {
    const row = asRecord(entry);
    if (!row || asRecord(row.__openclaw)?.runId !== runId || row.role !== "assistant") continue;
    if (oversized(row) && current === anchor) return true;
    for (const part of Array.isArray(row.content) ? row.content : []) {
      const block = asRecord(part);
      if (
        (block?.type === "toolCall" || block?.type === "tool_use") &&
        typeof block.id === "string"
      )
        current = `t.${block.id}`;
    }
  }
  return false;
}

/** A count a host sets: the default when it sets none, and never above it. */
export function hostLimit(value: number | undefined, max: number, name: string): number {
  if (value === undefined) return max;
  if (!Number.isInteger(value) || value < 1 || value > max)
    throw new RangeError(`${name} must be a whole number from 1 to ${max}.`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The reactions kept for the messages these history items show, and no others (F-283). */
function reactionsShown(
  reactions: Record<string, MessageReaction[]>,
  items: TranscriptItem[],
): Record<string, MessageReaction[]> {
  const shown = shownMessageIds({ items } as Transcript);
  const kept = Object.fromEntries(Object.entries(reactions).filter(([id]) => shown.has(id)));
  return Object.keys(kept).length === Object.keys(reactions).length ? reactions : kept;
}

/** The gateway's message ids a transcript shows: its history items' and their bubbles' (F-283). */
function shownMessageIds(transcript: Transcript): Set<string> {
  const ids = new Set<string>();
  for (const item of transcript.items) {
    if (item.messageId) ids.add(item.messageId);
    for (const block of item.blocks)
      if (block.kind === "text" && block.messageId) ids.add(block.messageId);
  }
  return ids;
}

/**
 * A message's reactions as the gateway summarises them (`[{emoji, count, identities}]`), the
 * most counted first, at most `MAX_REACTIONS_PER_MESSAGE`; `mine` when `selfId` reacted.
 */
function reactionsOf(summary: unknown, selfId: string | null): MessageReaction[] {
  if (!Array.isArray(summary)) return [];
  const out: MessageReaction[] = [];
  for (const entry of summary) {
    const row = asRecord(entry);
    const emoji = row?.emoji;
    const count = row?.count;
    if (typeof emoji !== "string" || !emoji || emoji.length > 64) continue;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1) continue;
    const identities = Array.isArray(row?.identities) ? row.identities : [];
    const mine =
      selfId !== null && identities.some((each: unknown) => asRecord(each)?.id === selfId);
    out.push({ emoji, count, mine });
  }
  return out.sort((a, b) => b.count - a.count).slice(0, MAX_REACTIONS_PER_MESSAGE);
}

function validTurnLimit(minutes: number): boolean {
  return (
    Number.isInteger(minutes) &&
    minutes >= MIN_TURN_LIMIT_MINUTES &&
    minutes <= MAX_TURN_LIMIT_MINUTES
  );
}
