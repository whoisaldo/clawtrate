// The bounds of everything the host keeps in its state, declared against the
// state's own types: a field added to one of them without a bound here does
// not compile. `enforceState` applies them where state is written; the
// worst-case totals are arithmetic over them (`worstCase`), and
// `docs/decisions.md` states the same numbers. All lengths are JSON
// characters (`bounds.ts`).

import { MAX_GATEWAY_URL_CHARS } from "./gateway-url.ts";
import {
  MAX_ACCOUNTS,
  MAX_CATALOG_MODELS,
  MAX_EFFORT_LEVELS,
  MAX_FALLBACKS,
  MAX_KEY_PROVIDERS,
  MAX_LOCK_CHECKS,
  MAX_ORDER_IDS,
  MAX_SIGNIN_METHODS,
  type AccountsState,
  type AccountWrite,
  type BotBinding,
  type BotCreationState,
  type CatalogModel,
  type GatewayAccount,
  type KeyProvider,
  type LockCheck,
  type LockEvidence,
  type SignInMethod,
  type SignInResult,
  type SignInState,
  type SignInStep,
  type StoredOrder,
} from "./accounts.ts";
import {
  MAX_ROUTINE_TEXT_CHARS,
  MAX_ROUTINES,
  MAX_ROUTINE_RUN_TEXT_CHARS,
  type Routine,
  type RoutineSchedule,
  type RoutinesState,
} from "./routines.ts";
import type {
  ApprovalAttempts,
  ApprovalCard,
  ApprovalResolution,
  ApprovalResolver,
  DecisionAttempt,
  ExecApprovalDetail,
  SentRequest,
  SettlingRecord,
  PluginApprovalDetail,
  SystemAgentApprovalDetail,
} from "./approvals.ts";
import {
  capId,
  cutText,
  enforce,
  flagged,
  id,
  json,
  list,
  map,
  object,
  scalar,
  text,
  union,
  worstCase,
  type Bound,
} from "./bounds.ts";
import type { InterSessionMessage, LinkedRun, McpToolIdentity } from "./cards.ts";
import {
  MAX_BUDGET_ID_CHARS,
  MAX_BUDGETS,
  MAX_LIMIT_PROVIDERS,
  MAX_LIMIT_TEXT_CHARS,
  MAX_LIMIT_WINDOWS,
  MAX_ROUTINE_NAME_CHARS,
  MAX_TIME_ZONE_CHARS,
  type Budget,
  type BudgetCount,
  type DateRange,
  type LimitWindow,
  type ProviderLimit,
  type ProviderLimits,
  type UsageState,
} from "./usage.ts";
import type {
  CaughtUp,
  ClosedCard,
  OutgoingAttachmentInfo,
  OutgoingMessage,
  PendingCard,
  QuestionCard,
  QuestionItem,
  QuestionOption,
  Preamble,
  Run,
  RunEnding,
  RunError,
  Step,
  StepFiles,
  RunErrorRaw,
  StoppedWith,
  StepText,
} from "./runs.ts";
import { MAX_STEP_PATH_CHARS, MAX_STEP_PATHS } from "./file-paths.ts";
import {
  MAX_SECTION_NAME_CHARS,
  MAX_SIDEBAR_BOTS,
  MAX_SIDEBAR_ID_CHARS,
  MAX_SIDEBAR_SECTIONS,
  type SidebarPrefs,
  type SidebarSection,
  type SidebarState,
} from "./sidebar.ts";
import type { Digest } from "./bounds.ts";
import {
  MAX_LOOK_OTHER_CHARS,
  MAX_LOOK_OTHERS,
  type SetupFailure,
  type SetupLook,
  type SetupState,
} from "./setup.ts";
import {
  MAX_CHECKIN_KEPT,
  MAX_CHECKIN_PROMPT_CHARS,
  type CheckInDefaults,
  type CheckInJob,
  type CheckInSave,
  type CheckInSetting,
  type CheckInsState,
} from "./check-ins.ts";
import { MAX_ACTION_FACTS_CHARS } from "./actions.ts";
import type {
  Bot,
  ClawtrateState,
  ConnectionError,
  ConnectionState,
  DiscoveryState,
  MessageReaction,
  PairingRequest,
  ReplyReference,
  ScopeUpgradeState,
  SendLimits,
  Task,
  TaskContext,
  TaskCreation,
  ToolResult,
  Transcript,
  TranscriptBlock,
  TranscriptItem,
} from "./types.ts";

// Field caps, in JSON characters --------------------------------------------------

/** Ids, session keys and run ids. A longer one is replaced by its digest (`#…`), never cut. */
export const MAX_ID_CHARS = 1_024;
/** Short gateway strings: phases, reasons, kinds, model and agent names. */
export const MAX_NAME_CHARS = 256;
/** A step's title. */
export const MAX_TITLE_CHARS = 256;
/** Each of a step's arguments, output and result as displayed; the raw table holds them whole. */
export const MAX_STEP_BODY_CHARS = 2_048;
/** How much of a long step text's end a step keeps (`StepText.tail`): where tools write notices. */
export const MAX_TEXT_TAIL = 400;
/** An error message, on a step, a run or a card. */
export const MAX_ERROR_JSON_CHARS = 2_048;
/** Each retried-attempt error and a failed Stop's message on a run. */
export const MAX_ATTEMPT_ERROR_CHARS = 1_024;
/** A step's raw payload carried inline; a larger one is read with `readStepRaw`. */
export const MAX_INLINE_RAW_CHARS = 2_048;
/** A run's streaming reply text as displayed; the transcript holds it whole. */
export const MAX_RUN_TEXT_CHARS = 16_384;
/** Each text, reasoning or tool block of a history item; `readHistoryItem` reads it whole. */
export const MAX_BLOCK_CHARS = 2_048;
/** An inter-session message's text. */
export const MAX_INTER_SESSION_CHARS = 2_048;
/** A tool call's arguments and result as an item of the history page shows them; the step holds more. */
export const MAX_ITEM_TOOL_CHARS = 1_024;
/** An outgoing message's text. Refused at sending past it, never cut: it is the user's instruction. */
export const MAX_MESSAGE_JSON_CHARS = 34_000;
/** A file name or type kept for an outgoing message. */
export const MAX_FILE_NAME_CHARS = 600;
/** A question's text; each option's label and description. */
export const MAX_QUESTION_CHARS = 2_048;
export const MAX_OPTION_CHARS = 512;
/** Each answer string kept on a settled question for display. */
export const MAX_ANSWER_CHARS = 512;
/** An approval's command, or the text a plugin or system-agent approval asks about. Past it only deny is offered until the whole text is read. */
export const MAX_COMMAND_CHARS = 8_192;
/** An approval's other descriptive fields (directory, path, warning, description). */
export const MAX_APPROVAL_FIELD_CHARS = 2_048;
/** Records kept as received: an approval's or question's record, scope, analysis or run plan. */
export const MAX_RECORD_CHARS = 2_048;
/** A bot's avatar (a data: or https: URL); a larger one is not kept. */
export const MAX_AVATAR_CHARS = 32_768;
/** A task's title or preview in the task list. */
export const MAX_TASK_LINE_CHARS = 1_024;
/** Connection and discovery messages, and the approve commands shown. */
export const MAX_MESSAGE_LINE_CHARS = 2_048;

// Counts ---------------------------------------------------------------------------

/**
 * Tasks the client follows at once: the default, and the most a host may set
 * (`ClientOptions.limits.trackedTasks`); a host on a smaller device sets fewer.
 */
export const MAX_TRACKED_TASKS = 8;
/** Runs one task keeps, finished or not; finished ones are at most `MAX_RUNS_PER_TASK`. */
export const MAX_RUN_LIST = 32;
/** Steps one task keeps across its runs. */
export const MAX_STEPS_PER_TASK = 128;
/** Cards a run holds pending, suspended by Stop, or closed. */
export const MAX_PENDING_CARDS = 4;
export const MAX_CLOSED_CARDS_PER_RUN = 8;
/** Texts beside a tool call kept per run (`Run.preambles`). */
export const MAX_PREAMBLES_PER_RUN = 8;
/** Retried-attempt errors kept per run. */
export const MAX_ATTEMPT_ERROR_COUNT = 5;
/** Items of a task's history page (`chat.history` limit) and blocks across them. */
export const MAX_HISTORY_ITEMS = 200;
/** As many as the page holds: a run of many actions keeps every block the page can, in one item. */
/** The facts a history block keeps of its result's details (`ToolResult.facts`). */
export const MAX_TOOL_FACTS_CHARS = 160;
export const MAX_BLOCKS_PER_ITEM = 300;
export const MAX_HISTORY_BLOCKS = 300;
/** Inter-session messages kept per task, newest. */
export const MAX_INTER_SESSION = 64;
/** Outgoing messages per task (also `MAX_OUTBOX_PER_TASK`). */
export const MAX_OUTBOX = 16;
export const MAX_FILES_PER_MESSAGE = 20;
/** Pending questions per task; past it a question is counted in `questionsOmitted`. */
export const MAX_PENDING_QUESTIONS_PER_TASK = 4;
/** Settled questions per task (also `MAX_SETTLED_QUESTIONS`). */
export const MAX_SETTLED_QUESTION_COUNT = 4;
export const MAX_QUESTION_ITEMS = 3;
export const MAX_QUESTION_OPTIONS = 8;
export const MAX_ANSWERS_PER_QUESTION = 8;
/** Pending approvals per task (also `MAX_PENDING_APPROVALS_PER_TASK`), settled ones kept. */
export const MAX_PENDING_APPROVAL_COUNT = 16;
/** Records the gateway sent that settled a request, kept per request: one per source (event, reply, read-back). */
export const MAX_SETTLING_RECORDS = 3;
/** Decisions this client sent, kept per approval: the newest. */
export const MAX_SENT_DECISIONS = 4;
export const MAX_SETTLED_APPROVAL_COUNT = 8;
export const MAX_COMMAND_ARGS = 16;
/** Recipient runs a task's sends name. */
export const MAX_LINKED_RUNS = 32;
/** Tool-server tools a task keeps from `tools.effective`, by effective name. */
export const MAX_MCP_TOOLS = 128;
/** Built-in and plugin tools a task keeps from `tools.effective`, by effective name. */
export const MAX_BUILTIN_TOOLS = 256;
/** A tool's effective name: the gateway cuts it to 64 characters (`buildSafeToolName`). */
export const MAX_TOOL_NAME_CHARS = 128;
/** Steer aliases per task (also `MAX_STEER_ALIASES`). */
export const MAX_STEER_ALIAS_COUNT = 16;
/** Queue aliases per task (also `MAX_QUEUE_ALIASES`). */
export const MAX_QUEUE_ALIAS_COUNT = 16;
/** Bots listed, and tasks listed across bots. */
export const MAX_BOTS = 32;
export const MAX_LISTED_TASKS = 500;
/** Approvals no followed task shows (also `MAX_UNROUTED_APPROVALS`). */
export const MAX_UNROUTED = 16;
/** Task creations kept until settled. */
export const MAX_CREATIONS = 8;
/** Scopes in a grant or request. */
export const MAX_SCOPES = 16;
/** What a stop's note names of each kind it also stopped (`Run.stoppedWith`). */
export const MAX_STOPPED_NAMED = 8;
/** The gateway's preview of a message replied to, as kept on the reply (F-067). */
export const MAX_REPLY_PREVIEW_CHARS = 512;
/** Messages whose reactions a task keeps: at most one per history row shown. */
export const MAX_REACTED_MESSAGES = MAX_HISTORY_ITEMS;
/** Distinct emoji kept per message, the most counted first. */
export const MAX_REACTIONS_PER_MESSAGE = 12;
/** One emoji: the gateway accepts one grapheme of at most 32 code points. */
export const MAX_EMOJI_CHARS = 66;

// The schema -----------------------------------------------------------------------

const ID = id(MAX_ID_CHARS);
const NAME = text(MAX_NAME_CHARS);
const NUMBER = scalar(24);
const FLAG = scalar(5);
const ENUM = scalar(32);

const digest = object<Digest>()({ length: NUMBER, a: NUMBER, b: NUMBER });
const stepText = object<StepText>()({
  text: text(MAX_STEP_BODY_CHARS),
  totalChars: NUMBER,
  tail: text(MAX_TEXT_TAIL + 48),
  lines: NUMBER,
});
export const STEP: Bound = flagged<Step>()({
  id: ID,
  kind: ENUM,
  title: text(MAX_TITLE_CHARS),
  toolName: ID,
  toolCallId: ID,
  status: ENUM,
  startedAt: NUMBER,
  endedAt: NUMBER,
  argsText: stepText,
  output: stepText,
  result: stepText,
  error: text(MAX_ERROR_JSON_CHARS),
  approvalId: ID,
  failureKind: NAME,
  truncated: FLAG,
  replaceable: FLAG,
  correction: NUMBER,
  continuation: digest,
  // Inline only when its whole JSON fits; otherwise null and read with `readStepRaw`.
  raw: json(MAX_INLINE_RAW_CHARS),
  rawSize: NUMBER,
  // What the reading of an action needs, projected to fit (`projectArgs`, `projectDetails`).
  args: json(MAX_ACTION_FACTS_CHARS),
  details: json(MAX_ACTION_FACTS_CHARS),
  commandBearing: FLAG,
  rowTimes: FLAG,
  omittedBefore: NUMBER,
  resultCut: FLAG,
  gatewayTitle: text(MAX_NAME_CHARS),
  // A path is an id: never cut, since a cut path would name another file.
  files: object<StepFiles>()({
    paths: list(MAX_STEP_PATHS, id(MAX_STEP_PATH_CHARS)),
    changed: FLAG,
    created: FLAG,
  }),
});
const pendingCard = object<PendingCard>()({ id: ID, kind: ENUM, since: NUMBER });
const closedCard = object<ClosedCard>()({ id: ID, kind: ENUM, since: NUMBER, reason: ENUM });
const runError = object<RunError>()({
  message: text(MAX_ERROR_JSON_CHARS),
  kind: NAME,
  raw: object<RunErrorRaw>()({ holds: ENUM, chars: NUMBER }),
});
const runEnding = object<RunEnding>()({
  stopReason: NAME,
  timeoutPhase: NAME,
  providerStarted: FLAG,
  status: NAME,
});
const preamble = object<Preamble>()({
  id: ID,
  text: text(MAX_BLOCK_CHARS),
  ended: FLAG,
  beforeCall: ID,
});
export const RUN: Bound = flagged<Run>()({
  id: ID,
  bound: FLAG,
  state: ENUM,
  origin: ENUM,
  messageId: ID,
  anchorItemId: ID,
  phase: NAME,
  model: NAME,
  text: text(MAX_RUN_TEXT_CHARS),
  textSource: ENUM,
  textItemId: ID,
  textComplete: FLAG,
  steps: list(MAX_STEPS_PER_TASK, STEP, { pool: "steps" }),
  pendingCards: list(MAX_PENDING_CARDS, pendingCard),
  suspendedCards: list(MAX_PENDING_CARDS, pendingCard),
  closedCards: list(MAX_CLOSED_CARDS_PER_RUN, closedCard),
  startedAt: NUMBER,
  reportedStartAt: NUMBER,
  endedAt: NUMBER,
  error: runError,
  stopRequestedAt: NUMBER,
  finishedBeforeStop: FLAG,
  stopError: text(MAX_ATTEMPT_ERROR_CHARS),
  lastSeq: NUMBER,
  ending: runEnding,
  outcomeKnown: FLAG,
  attemptErrors: list(MAX_ATTEMPT_ERROR_COUNT, text(MAX_ATTEMPT_ERROR_CHARS)),
  omittedSteps: NUMBER,
  omittedTools: NUMBER,
  omittedToolsAtEnd: NUMBER,
  endFromRows: FLAG,
  preambles: list(MAX_PREAMBLES_PER_RUN, preamble),
  reasoningAnchor: ID,
  nextReasoning: NUMBER,
  reasoningRevision: NUMBER,
  requestId: ID,
  stoppedWith: object<StoppedWith>()({
    helpers: NUMBER,
    bots: list(MAX_STOPPED_NAMED, ID),
    uncertain: list(MAX_STOPPED_NAMED, ID),
    refused: list(MAX_STOPPED_NAMED, ID),
    unanswered: list(MAX_STOPPED_NAMED, ID),
    omitted: NUMBER,
    recipientsAsked: FLAG,
  }),
  stoppedForTimeouts: NUMBER,
  turnLimit: NUMBER,
  retry: object<NonNullable<Run["retry"]>>()({ attempt: NUMBER, of: NUMBER, reason: NAME }),
});
const attachmentInfo = object<OutgoingAttachmentInfo>()({
  fileName: text(MAX_FILE_NAME_CHARS),
  mimeType: text(MAX_FILE_NAME_CHARS),
  sizeBytes: NUMBER,
});
export const OUTGOING: Bound = object<OutgoingMessage>()({
  id: ID,
  text: text(MAX_MESSAGE_JSON_CHARS),
  mode: ENUM,
  status: ENUM,
  runId: ID,
  messageSeq: NUMBER,
  leftAt: NUMBER,
  createdAt: NUMBER,
  error: text(MAX_ERROR_JSON_CHARS),
  attachments: list(MAX_FILES_PER_MESSAGE, attachmentInfo),
  replyToId: ID,
});
const questionOption = object<QuestionOption>()({
  index: NUMBER,
  label: text(MAX_OPTION_CHARS),
  description: text(MAX_OPTION_CHARS),
  value: text(MAX_OPTION_CHARS),
});
const questionItem = object<QuestionItem>()({
  id: ID,
  header: text(MAX_OPTION_CHARS),
  question: text(MAX_QUESTION_CHARS),
  options: list(MAX_QUESTION_OPTIONS, questionOption),
  optionsOmitted: NUMBER,
  multiSelect: FLAG,
  allowsOther: FLAG,
});
/** A record the gateway sent that settled a request, and where it came from. */
const settlingRecord = object<SettlingRecord>()({ via: NAME, record: json(MAX_RECORD_CHARS) });
/** A request this client sent to settle one: its method and parameters. */
const sentRequest = object<SentRequest>()({ method: NAME, params: json(MAX_RECORD_CHARS) });
export const QUESTION: Bound = flagged<QuestionCard>()({
  id: ID,
  runId: ID,
  status: ENUM,
  questions: list(MAX_QUESTION_ITEMS, questionItem),
  createdAt: NUMBER,
  expiresAt: NUMBER,
  answers: map(
    MAX_QUESTION_ITEMS,
    MAX_ID_CHARS,
    list(MAX_ANSWERS_PER_QUESTION, text(MAX_ANSWER_CHARS)),
  ),
  submitting: FLAG,
  error: text(MAX_ERROR_JSON_CHARS),
  raw: json(MAX_RECORD_CHARS),
  ordinary: FLAG,
  sent: sentRequest,
  settledBy: list(MAX_SETTLING_RECORDS, settlingRecord),
});
const execDetail = object<ExecApprovalDetail>()({
  command: text(MAX_COMMAND_CHARS),
  commandArgv: list(MAX_COMMAND_ARGS, text(MAX_OPTION_CHARS)),
  cwd: text(MAX_APPROVAL_FIELD_CHARS),
  host: NAME,
  nodeId: ID,
  security: NAME,
  ask: NAME,
  resolvedPath: text(MAX_APPROVAL_FIELD_CHARS),
  warningText: text(MAX_APPROVAL_FIELD_CHARS),
  commandAnalysis: json(MAX_RECORD_CHARS),
  runsOn: ENUM,
  systemRunPlan: json(MAX_RECORD_CHARS),
});
const pluginDetail = object<PluginApprovalDetail>()({
  title: text(MAX_APPROVAL_FIELD_CHARS),
  description: text(MAX_APPROVAL_FIELD_CHARS),
  detail: text(MAX_COMMAND_CHARS),
  severity: NAME,
  pluginId: NAME,
  toolName: ID,
});
const systemAgentDetail = object<SystemAgentApprovalDetail>()({
  title: text(MAX_APPROVAL_FIELD_CHARS),
  description: text(MAX_APPROVAL_FIELD_CHARS),
  command: text(MAX_COMMAND_CHARS),
  proposalHash: NAME,
});
const resolver = object<ApprovalResolver>()({ kind: ENUM, id: ID });
const decisionAttempt = object<DecisionAttempt>()({ attempt: NUMBER, decision: ENUM });
export const APPROVAL: Bound = flagged<ApprovalCard>()({
  id: ID,
  kind: ENUM,
  status: ENUM,
  decision: ENUM,
  reason: NAME,
  sessionKey: ID,
  agentId: NAME,
  runId: ID,
  toolCallId: ID,
  stepId: ID,
  runEnded: FLAG,
  createdAt: NUMBER,
  expiresAt: NUMBER,
  resolvedAt: NUMBER,
  resolvedBy: NAME,
  resolver,
  inferred: FLAG,
  outcomeUnknown: FLAG,
  applicationStatus: NAME,
  allowedDecisions: list(3, ENUM),
  unavailableDecisions: list(3, ENUM),
  parentSessionKey: ID,
  relation: ENUM,
  exec: execDetail,
  plugin: pluginDetail,
  systemAgent: systemAgentDetail,
  scope: json(MAX_RECORD_CHARS),
  decisionDigest: NAME,
  decisionCut: FLAG,
  submitting: FLAG,
  submittingDecision: ENUM,
  attempt: NUMBER,
  inFlight: list(2, decisionAttempt),
  unknownAt: NUMBER,
  unknownDeny: FLAG,
  readingAt: NUMBER,
  sent: list(MAX_SENT_DECISIONS, sentRequest),
  settledBy: list(MAX_SETTLING_RECORDS, settlingRecord),
  error: text(MAX_ERROR_JSON_CHARS),
  decisionError: ENUM,
  stillOpen: FLAG,
  raw: json(MAX_RECORD_CHARS),
});
const toolResult = object<ToolResult>()({
  isError: FLAG,
  text: text(MAX_ITEM_TOOL_CHARS),
  // Five small facts: an exit code, three flags and two line counts.
  facts: json(MAX_TOOL_FACTS_CHARS),
  clipped: FLAG,
});
const block = union<TranscriptBlock, "kind">("kind")({
  text: object<Extract<TranscriptBlock, { kind: "text" }>>()({
    kind: ENUM,
    text: text(MAX_BLOCK_CHARS),
    messageId: ID,
    replyToId: ID,
  }),
  reasoning: object<Extract<TranscriptBlock, { kind: "reasoning" }>>()({
    kind: ENUM,
    text: text(MAX_BLOCK_CHARS),
  }),
  "tool-call": object<Extract<TranscriptBlock, { kind: "tool-call" }>>()({
    kind: ENUM,
    callId: ID,
    name: text(MAX_NAME_CHARS),
    argumentsText: text(MAX_ITEM_TOOL_CHARS),
    argumentsAbsent: FLAG,
    result: toolResult,
  }),
});
const item = flagged<TranscriptItem>()({
  id: ID,
  role: ENUM,
  timestamp: NUMBER,
  blocks: list(MAX_BLOCKS_PER_ITEM, block, { pool: "blocks" }),
  model: NAME,
  truncated: FLAG,
  messageId: ID,
  replyTo: object<ReplyReference>()({
    id: ID,
    text: text(MAX_REPLY_PREVIEW_CHARS),
    sender: NAME,
  }),
  idempotencyKey: ID,
});
const reaction = object<MessageReaction>()({
  emoji: id(MAX_EMOJI_CHARS),
  count: NUMBER,
  mine: FLAG,
});
const interSession = flagged<InterSessionMessage>()({
  itemId: ID,
  text: text(MAX_INTER_SESSION_CHARS),
  sourceSessionKey: ID,
  sourceTool: NAME,
  senderLabel: NAME,
  senderAgentId: NAME,
  timestamp: NUMBER,
});
const linkedRun = object<LinkedRun>()({
  id: ID,
  sessionKey: ID,
  state: ENUM,
  outcomeKnown: FLAG,
  startedAt: NUMBER,
  endedAt: NUMBER,
});
const caughtUp = object<CaughtUp>()({ reason: ENUM, at: NUMBER });
export const TRANSCRIPT: Bound = flagged<Transcript>()({
  runs: list(MAX_RUN_LIST, RUN, { pools: { steps: MAX_STEPS_PER_TASK } }),
  outbox: list(MAX_OUTBOX, OUTGOING),
  questions: list(MAX_PENDING_QUESTIONS_PER_TASK + MAX_SETTLED_QUESTION_COUNT, QUESTION),
  approvals: list(MAX_PENDING_APPROVAL_COUNT + MAX_SETTLED_APPROVAL_COUNT, APPROVAL),
  approvalAccess: ENUM,
  approvalSources: map(3, 16, ENUM),
  steerAliases: map(MAX_STEER_ALIAS_COUNT, MAX_ID_CHARS, ID),
  queueAliases: map(MAX_QUEUE_ALIAS_COUNT, MAX_ID_CHARS, ID),
  caughtUp,
  questionsOmitted: NUMBER,
  runsOmitted: NUMBER,
  sessionKey: ID,
  status: ENUM,
  items: list(MAX_HISTORY_ITEMS, item, { pools: { blocks: MAX_HISTORY_BLOCKS } }),
  error: text(MAX_MESSAGE_LINE_CHARS),
  hasMore: FLAG,
  live: object<NonNullable<Transcript["live"]>>()({ runId: ID, text: text(MAX_RUN_TEXT_CHARS) }),
  linkedRuns: map(MAX_LINKED_RUNS, MAX_ID_CHARS, linkedRun),
  interSession: list(MAX_INTER_SESSION, interSession),
  mcpTools: map(
    MAX_MCP_TOOLS,
    MAX_TOOL_NAME_CHARS,
    object<McpToolIdentity>()({ server: NAME, tool: NAME }),
  ),
  // Names and a root are ids: a cut one would name another tool or folder.
  builtinTools: list(MAX_BUILTIN_TOOLS, id(MAX_TOOL_NAME_CHARS)),
  workspaceRoot: id(MAX_STEP_PATH_CHARS),
  reactions: map(MAX_REACTED_MESSAGES, MAX_ID_CHARS, list(MAX_REACTIONS_PER_MESSAGE, reaction)),
  loadedAt: NUMBER,
});

const pairing = object<PairingRequest>()({
  requestId: ID,
  deviceId: ID,
  message: text(MAX_MESSAGE_LINE_CHARS),
  approveCommand: text(MAX_MESSAGE_LINE_CHARS),
  approveNote: text(MAX_MESSAGE_LINE_CHARS),
  requestedScopes: list(MAX_SCOPES, NAME),
});
const connectionError = object<ConnectionError>()({
  code: NAME,
  message: text(MAX_MESSAGE_LINE_CHARS),
  hint: text(MAX_MESSAGE_LINE_CHARS),
  protocol: object<NonNullable<ConnectionError["protocol"]>>()({ gateway: NUMBER, client: NUMBER }),
});
const upgrade = object<ScopeUpgradeState>()({
  status: ENUM,
  scopes: list(MAX_SCOPES, NAME),
  requestId: ID,
  approveCommand: text(MAX_MESSAGE_LINE_CHARS),
  approveNote: text(MAX_MESSAGE_LINE_CHARS),
  error: text(MAX_MESSAGE_LINE_CHARS),
});
const connection = object<ConnectionState>()({
  status: ENUM,
  gatewayUrl: text(MAX_GATEWAY_URL_CHARS),
  gatewayId: ID,
  serverVersion: NAME,
  protocol: NUMBER,
  scopes: list(MAX_SCOPES, NAME),
  requestedScopes: list(MAX_SCOPES, NAME),
  canWrite: FLAG,
  canAnswer: FLAG,
  canApprove: FLAG,
  canAdmin: FLAG,
  upgrade,
  deviceId: ID,
  pairing,
  error: connectionError,
  retryAt: NUMBER,
  connectedAt: NUMBER,
  paired: FLAG,
  sendLimits: object<SendLimits>()({
    imageBytes: NUMBER,
    fileBytes: NUMBER,
    payloadBytes: NUMBER,
    files: NUMBER,
  }),
});
const discovery = object<DiscoveryState>()({
  status: ENUM,
  error: text(MAX_MESSAGE_LINE_CHARS),
  partial: FLAG,
});
const bot = flagged<Bot>()({
  id: ID,
  name: NAME,
  emoji: NAME,
  avatarUrl: json(MAX_AVATAR_CHARS),
  theme: NAME,
  model: NAME,
  isDefault: FLAG,
});
const task = flagged<Task>()({
  key: ID,
  botId: ID,
  sessionId: ID,
  title: text(MAX_TASK_LINE_CHARS),
  preview: text(MAX_TASK_LINE_CHARS),
  updatedAt: NUMBER,
  status: ENUM,
  unread: FLAG,
  isMain: FLAG,
  pinned: FLAG,
  waitingFor: ENUM,
  waitingSince: NUMBER,
  unreadMarker: NUMBER,
  context: object<TaskContext>()({ used: NUMBER, window: NUMBER, fresh: FLAG }),
  effort: NAME,
});
/** The rail's arrangement as the gateway keeps it (`sidebar.ts`). */
const sidebarId = id(MAX_SIDEBAR_ID_CHARS);
const sidebar = object<SidebarState>()({
  status: ENUM,
  prefs: object<SidebarPrefs>()({
    pins: list(MAX_SIDEBAR_BOTS, sidebarId),
    sections: list(
      MAX_SIDEBAR_SECTIONS,
      object<SidebarSection>()({
        // A name of `MAX_SECTION_NAME_CHARS` characters, each escaped at its longest (`\u0000`), never cut.
        name: text(MAX_SECTION_NAME_CHARS * 6 + 2),
        bots: list(MAX_SIDEBAR_BOTS, sidebarId),
      }),
    ),
    hidden: list(MAX_SIDEBAR_BOTS, sidebarId),
    order: list(MAX_SIDEBAR_BOTS, sidebarId),
    rev: NUMBER,
  }),
});
/** Warning budgets, their counts and the providers' limits (`usage.ts`). */
// An id bound counts JSON characters: a plain id of `MAX_BUDGET_ID_CHARS` and its two quotes,
// and a budget's key, `routine:` before such an id.
const usageId = id(MAX_BUDGET_ID_CHARS + 2);
const budgetKey = id("routine:".length + MAX_BUDGET_ID_CHARS + 2);
const zone = text(MAX_TIME_ZONE_CHARS + 2);
// A date, YYYY-MM-DD, quoted.
const date = text(12);
const dateRange = object<DateRange>()({ startDate: date, endDate: date, timeZone: zone });
const budget = object<Budget>()({
  id: budgetKey,
  botId: usageId,
  routineId: usageId,
  // A name of `MAX_ROUTINE_NAME_CHARS` characters, each escaped at its longest (`\u0000`).
  routineName: text(MAX_ROUTINE_NAME_CHARS * 6 + 2),
  period: ENUM,
  tokens: NUMBER,
  timeZone: zone,
  setAt: NUMBER,
});
const budgetCount = object<BudgetCount>()({
  budgetId: budgetKey,
  range: dateRange,
  used: NUMBER,
  asOf: NUMBER,
  counting: FLAG,
  partial: FLAG,
  error: text(MAX_MESSAGE_LINE_CHARS),
});
const limitText = text(MAX_LIMIT_TEXT_CHARS * 6 + 2);
const limitWindow = object<LimitWindow>()({
  label: limitText,
  usedPercent: NUMBER,
  resetAt: NUMBER,
});
const providerLimit = object<ProviderLimit>()({
  provider: usageId,
  displayName: limitText,
  windows: list(MAX_LIMIT_WINDOWS, limitWindow),
  error: limitText,
});
export const USAGE: Bound = object<UsageState>()({
  budgetsStatus: ENUM,
  budgets: list(MAX_BUDGETS, budget),
  rev: NUMBER,
  counts: list(MAX_BUDGETS, budgetCount),
  limits: object<ProviderLimits>()({
    status: ENUM,
    updatedAt: NUMBER,
    providers: list(MAX_LIMIT_PROVIDERS, providerLimit),
    refreshing: FLAG,
  }),
});
/** A task creation as kept (`MAX_CREATIONS` of them). */
export const CREATION: Bound = object<TaskCreation>()({
  id: ID,
  botId: ID,
  text: text(MAX_MESSAGE_JSON_CHARS),
  label: text(MAX_TASK_LINE_CHARS),
  status: ENUM,
  createdAt: NUMBER,
  error: text(MAX_ERROR_JSON_CHARS),
  key: ID,
  gatewayBootId: NAME,
});
const retentionAlarm = object<ClawtrateState["retention"]>()({
  estimated: NUMBER,
  bound: NUMBER,
  near: FLAG,
});

/** An approval's attempts the client keeps by id while any are outstanding (`MAX_APPROVAL_ATTEMPTS`). */
export const APPROVAL_ATTEMPTS: Bound = object<ApprovalAttempts>()({
  attempt: NUMBER,
  inFlight: list(2, decisionAttempt),
  unknownAt: NUMBER,
  unknownDeny: FLAG,
  readingAt: NUMBER,
  decisionError: ENUM,
  stillOpen: FLAG,
  submitting: FLAG,
  submittingDecision: ENUM,
});

/** An approval outcome the client keeps by id (`MAX_APPROVAL_OUTCOMES` of them). */
export const APPROVAL_OUTCOME: Bound = object<ApprovalResolution>()({
  id: ID,
  status: ENUM,
  decision: ENUM,
  reason: NAME,
  resolvedAt: NUMBER,
  resolvedBy: NAME,
  resolver,
  applicationStatus: NAME,
  authoritative: FLAG,
  lossy: FLAG,
  sessionKey: ID,
  runId: ID,
  records: list(MAX_SETTLING_RECORDS, settlingRecord),
});

/** The session-row fields the task list reads; everything else in a row is not kept. */
const SESSION_ROW_FIELDS = [
  "agentId",
  "archived",
  "category",
  "contextTokens",
  "createdAt",
  "derivedTitle",
  "displayName",
  "hasActiveRun",
  "isMain",
  "key",
  "label",
  "lastActivityAt",
  "lastMessagePreview",
  "lastRunError",
  "markedUnreadAt",
  "pinned",
  "sessionId",
  "sessionKey",
  "spawnedBy",
  "status",
  "totalTokens",
  "totalTokensFresh",
  "unread",
  "updatedAt",
] as const;

/** Session-row fields that are ids: kept under the id cap (`#digest` when longer), never cut. */
const SESSION_ROW_IDS = new Set(["agentId", "key", "sessionId", "sessionKey", "spawnedBy"]);

/**
 * A session row as the client keeps it: the fields it reads, ids under the id
 * cap and every other string cut to `MAX_TASK_LINE_CHARS` (both 1,024).
 */
export function SESSION_ROW(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of SESSION_ROW_FIELDS) {
    const value = row[field];
    if (value === undefined) continue;
    out[field] =
      typeof value === "string"
        ? SESSION_ROW_IDS.has(field)
          ? capId(value, MAX_ID_CHARS)
          : cutText(value, MAX_TASK_LINE_CHARS)
        : typeof value === "object" && value !== null
          ? null
          : value;
  }
  return out;
}
/** Characters one kept session row can take. */
export const WORST_ROW_CHARS =
  2 +
  SESSION_ROW_FIELDS.reduce((sum, field) => sum + field.length + 3 + MAX_TASK_LINE_CHARS + 1, 0);

// Provider accounts (accounts.ts). Nothing here holds a credential or anything typed.
const account = object<GatewayAccount>()({
  id: ID,
  provider: ID,
  label: NAME,
  type: ENUM,
  status: ENUM,
  expiresAt: NUMBER,
  kind: ENUM,
  made: ENUM,
  keptBy: ID,
  logoutSupported: FLAG,
});
const signInMethod = object<SignInMethod>()({
  id: ID,
  provider: ID,
  label: NAME,
  hint: NAME,
  kind: ENUM,
  flow: ENUM,
  group: ENUM,
});
const keyProvider = object<KeyProvider>()({ provider: ID, hasKey: FLAG, method: ID });
const catalogModel = object<CatalogModel>()({
  provider: ID,
  id: ID,
  name: NAME,
  available: FLAG,
  levels: list(MAX_EFFORT_LEVELS, ENUM),
  defaultLevel: ENUM,
});
const storedOrder = object<StoredOrder>()({
  ids: list(MAX_ORDER_IDS, ID),
  stored: FLAG,
  configured: ENUM,
});
const lockEvidence = object<LockEvidence>()({
  status: ENUM,
  checkedAt: NUMBER,
  lastMatchAt: NUMBER,
  lostAt: NUMBER,
  error: text(MAX_MESSAGE_LINE_CHARS),
});
const binding = object<BotBinding>()({
  botId: ID,
  primary: ID,
  provider: ID,
  model: ID,
  account: ID,
  mode: ENUM,
  fallbacks: list(MAX_FALLBACKS, ID),
  suffixLost: FLAG,
  accountMissing: FLAG,
  effort: ENUM,
  order: storedOrder,
  evidence: lockEvidence,
  fallbacksUnwritten: FLAG,
});
const signInStep = object<SignInStep>()({
  id: ID,
  type: ENUM,
  title: NAME,
  message: text(MAX_MESSAGE_LINE_CHARS),
  url: text(MAX_MESSAGE_LINE_CHARS),
  code: NAME,
  expiresInMinutes: NUMBER,
  placeholder: NAME,
  sensitive: FLAG,
});
const lockCheck = object<LockCheck>()({ botId: ID, account: ID, outcome: ENUM });
const signInResult = object<SignInResult>()({
  added: list(MAX_ACCOUNTS, ID),
  landed: ENUM,
  keptBy: ID,
  readFailed: FLAG,
  locks: list(MAX_LOCK_CHECKS, lockCheck),
});
const signIn = object<SignInState>()({
  id: ID,
  method: ID,
  provider: ID,
  label: NAME,
  flow: ENUM,
  forBot: ID,
  keptOnly: FLAG,
  stage: ENUM,
  step: signInStep,
  error: text(MAX_MESSAGE_LINE_CHARS),
  cancelling: FLAG,
  saving: FLAG,
  startedAt: NUMBER,
  result: signInResult,
  byKey: FLAG,
  known: list(MAX_ACCOUNTS, ID),
  cancelUnknown: FLAG,
});
const botCreation = object<BotCreationState>()({
  name: NAME,
  status: ENUM,
  slow: FLAG,
  botId: ID,
  error: text(MAX_MESSAGE_LINE_CHARS),
  missing: list(4, ENUM),
  uncertain: FLAG,
});
const accountWrite = object<AccountWrite>()({
  what: ENUM,
  target: ID,
  status: ENUM,
  error: text(MAX_MESSAGE_LINE_CHARS),
  at: NUMBER,
});
export const ACCOUNTS: Bound = object<AccountsState>()({
  status: ENUM,
  error: text(MAX_MESSAGE_LINE_CHARS),
  readAt: NUMBER,
  labels: FLAG,
  defaultModel: ID,
  mainShared: FLAG,
  accounts: list(MAX_ACCOUNTS, account),
  methods: list(MAX_SIGNIN_METHODS, signInMethod),
  keyProviders: list(MAX_KEY_PROVIDERS, keyProvider),
  models: list(MAX_CATALOG_MODELS, catalogModel),
  bindings: list(MAX_BOTS, binding),
  signIn,
  creation: botCreation,
  write: accountWrite,
});

/** Setting up on the host's computer (`setup.ts`): fixed facts and a few short names. */
const setupLook = object<SetupLook>()({
  outcome: ENUM,
  reason: ENUM,
  version: NAME,
  profile: NAME,
  listens: ENUM,
  service: ENUM,
  port: NUMBER,
  authMode: ENUM,
  access: ENUM,
  others: list(MAX_LOOK_OTHERS, text(MAX_LOOK_OTHER_CHARS)),
});
const setup = object<SetupState>()({
  phase: ENUM,
  step: NUMBER,
  slow: FLAG,
  look: setupLook,
  failure: object<SetupFailure>()({ kind: ENUM, exitCode: NUMBER, port: NUMBER, reason: ENUM }),
});

// Check-ins (check-ins.ts): one job and one setting per bot, the default and the one save under way.
const checkInJob = object<CheckInJob>()({
  botId: ID,
  enabled: FLAG,
  everyMs: NUMBER,
  nextRunAtMs: NUMBER,
});
// A prompt code unit can take six characters when escaped in JSON.
const checkInPrompt = text(6 * MAX_CHECKIN_PROMPT_CHARS + 2);
const checkInSetting = object<CheckInSetting>()({
  botId: ID,
  every: NAME,
  prompt: checkInPrompt,
  promptCut: FLAG,
});
const checkInDefaults = object<CheckInDefaults>()({
  inherited: list(MAX_CHECKIN_KEPT + 1, ID),
  inheritedCut: FLAG,
  every: NAME,
  everyCut: FLAG,
  prompt: checkInPrompt,
  promptCut: FLAG,
});
const checkInSave = object<CheckInSave>()({
  id: ID,
  botId: ID,
  status: ENUM,
  error: text(MAX_MESSAGE_LINE_CHARS),
});
export const CHECK_INS: Bound = object<CheckInsState>()({
  status: ENUM,
  error: text(MAX_MESSAGE_LINE_CHARS),
  gatewayId: ID,
  scheduler: FLAG,
  readBotIds: list(MAX_BOTS, ID),
  jobs: list(MAX_BOTS, checkInJob),
  settings: list(MAX_BOTS, checkInSetting),
  defaults: checkInDefaults,
  save: checkInSave,
});

// Routines (routines.ts): the list only; runs and their conversations are never kept.
const routineSchedule = object<RoutineSchedule>()({
  kind: ENUM,
  expr: NAME,
  tz: NAME,
  everyMs: NUMBER,
  anchorMs: NUMBER,
  staggerMs: NUMBER,
  at: NAME,
  name: NAME,
});
const routine = object<Routine>()({
  id: ID,
  botId: ID,
  name: NAME,
  enabled: FLAG,
  schedule: routineSchedule,
  payload: ENUM,
  text: text(MAX_ROUTINE_TEXT_CHARS),
  textCut: FLAG,
  canRecreate: FLAG,
  target: ENUM,
  sharedSessionKey: ID,
  delivery: ENUM,
  deliveryChannel: NAME,
  nextRunAt: NUMBER,
  lastRunAt: NUMBER,
  lastEndedAt: NUMBER,
  lastStatus: ENUM,
  lastError: text(MAX_ROUTINE_RUN_TEXT_CHARS),
  runningAt: NUMBER,
  deleteAfterRun: FLAG,
  gated: FLAG,
  updatedAt: NUMBER,
});
export const ROUTINES: Bound = object<RoutinesState>()({
  status: ENUM,
  error: text(MAX_MESSAGE_LINE_CHARS),
  schedulerOn: FLAG,
  routines: list(MAX_ROUTINES, routine),
  omitted: NUMBER,
  revision: NUMBER,
  removed: object<NonNullable<RoutinesState["removed"]>>()({
    id: ID,
    ranOnce: FLAG,
    runAt: NUMBER,
  }),
  listedOn: NUMBER,
});

/** Every part of the state but the transcripts, and the transcripts as one map. */
export const STATE: Bound = flagged<ClawtrateState>()({
  connection,
  discovery,
  bots: list(MAX_BOTS, bot),
  tasksByBot: map(MAX_BOTS, MAX_ID_CHARS, list(MAX_LISTED_TASKS, task, { pool: "tasks" })),
  transcripts: map(MAX_TRACKED_TASKS, MAX_ID_CHARS, TRANSCRIPT),
  unroutedApprovals: list(MAX_UNROUTED, APPROVAL),
  unroutedApprovalsOmitted: NUMBER,
  creations: list(MAX_CREATIONS, CREATION),
  accounts: ACCOUNTS,
  routines: ROUTINES,
  retention: retentionAlarm,
  sidebar,
  setup,
  checkIns: CHECK_INS,
  turnLimitMinutes: NUMBER,
  usage: USAGE,
});
/** The listed-tasks pool, applied over the whole state. */
const STATE_POOLS = { tasks: MAX_LISTED_TASKS };

// Enforcing and the totals ------------------------------------------------------------

/** Bring state written by the client within its bounds. Unchanged parts are not walked again. */
export function enforceState(state: ClawtrateState): ClawtrateState {
  return enforce({ kind: "list", max: 1, item: STATE, pools: STATE_POOLS }, [
    state,
  ])[0] as ClawtrateState;
}

/** The most JSON characters one task's transcript can take. */
export const WORST_TASK_CHARS = worstCase(TRANSCRIPT);
/** The most JSON characters the whole state can take: every followed task, the lists and the rest. */
export const WORST_STATE_CHARS = worstCase({
  kind: "list",
  max: 1,
  item: STATE,
  pools: STATE_POOLS,
});
/** The most one viewer's snapshot can take: the state with only that viewer's open tasks. */
export function worstViewerChars(openTasks: number): number {
  return (
    WORST_STATE_CHARS - (MAX_TRACKED_TASKS - openTasks) * (MAX_ID_CHARS + 2 + WORST_TASK_CHARS)
  );
}
