// View models the interface renders. Gateway payloads are mapped into these in
// mapping.ts and runs.ts; nothing outside core needs to know the wire shapes.

import { initialAccountsState, type AccountsState } from "./accounts.ts";
import { initialRoutinesState, type RoutinesState } from "./routines.ts";
import type { ApprovalCard } from "./approvals.ts";
import type { InterSessionMessage, LinkedRun, McpToolIdentity } from "./cards.ts";
import type { TaskActivity } from "./runs.ts";
import type { CheckInsState } from "./check-ins.ts";
import type { SidebarState } from "./sidebar.ts";
import type { ComputerState } from "./computer.ts";
import { initialUsage, type UsageState } from "./usage.ts";

export type ConnectionStatus =
  /** No gateway configured yet. */
  | "idle"
  | "connecting"
  /** The gateway knows this device but an operator has not approved it yet. */
  | "pairing"
  | "connected"
  /** Was connected, lost the socket, and is retrying with backoff. */
  | "reconnecting"
  /** Stopped retrying; needs the user to act. */
  | "error"
  /** The user disconnected; the gateway and the pairing are kept until they reconnect. */
  | "disconnected";

export type PairingRequest = {
  requestId: string;
  deviceId: string;
  message: string;
  /** What the person approving runs. The host chooses it, because it knows which gateway this is. */
  approveCommand: string;
  /** Where and by whom the command is run, when that is not obvious. */
  approveNote: string | null;
  requestedScopes: string[];
};

export type ConnectionError = {
  code: string;
  message: string;
  hint: string | null;
  /** For `PROTOCOL_MISMATCH`: the protocol the gateway speaks, and the one this client speaks. */
  protocol?: { gateway: number | null; client: number };
};

export type ScopeUpgradeStatus =
  | "idle"
  /** `device.scopes.requestUpgrade` is on its way. */
  | "requesting"
  /** The gateway holds a pending request; its owner has to approve it. */
  | "pending"
  /** Approved; the client reconnected with the new grant. */
  | "approved"
  | "rejected"
  | "expired"
  /** The request failed, or was approved without the scope it asked for. */
  | "error";

/** Stepping up from `operator.read` to `operator.write`, or to `operator.admin` (`scopes` says which). */
export type ScopeUpgradeState = {
  status: ScopeUpgradeStatus;
  /** The scopes asked for. */
  scopes: string[];
  requestId: string | null;
  /** What the person approving runs, chosen by the host as for pairing. */
  approveCommand: string | null;
  approveNote: string | null;
  error: string | null;
};

export type ConnectionState = {
  status: ConnectionStatus;
  gatewayUrl: string | null;
  /**
   * The gateway's own identity (`gateway.identity.get` `deviceId`), stable
   * across addresses and restarts. Null until it is read, or when the gateway
   * does not give it.
   */
  gatewayId: string | null;
  serverVersion: string | null;
  protocol: number | null;
  /** Scopes the gateway granted this connection (`hello-ok.auth.scopes`). */
  scopes: string[];
  /** Scopes this client asks for on every connect. Never more than it means to hold. */
  requestedScopes: string[];
  /** True while the connection holds `operator.write`, so sending and stopping work. */
  canWrite: boolean;
  /** True while the connection holds `operator.questions`, so question cards can be answered. */
  canAnswer: boolean;
  /** True while the connection holds `operator.approvals`, so approvals can be seen and resolved. */
  canApprove: boolean;
  /** True while the connection holds `operator.admin`, so bots and accounts can be changed. */
  canAdmin: boolean;
  upgrade: ScopeUpgradeState;
  deviceId: string | null;
  pairing: PairingRequest | null;
  error: ConnectionError | null;
  /** Epoch ms of the next reconnect attempt, when one is scheduled. */
  retryAt: number | null;
  /** Epoch ms of the latest hello: what was loaded before it is not yet in sync. */
  connectedAt: number | null;
  /** True once this device holds a device token for the current gateway. */
  paired: boolean;
  /**
   * The ceilings a message and its files must fit, from the latest `hello-ok.policy`: each
   * image within the smaller of 6 MiB and the gateway's image ceiling, each other file within
   * the smaller of 20 MiB and its file ceiling, the encoded request within `maxPayload`. Null
   * before the first hello.
   */
  sendLimits: SendLimits | null;
};

/** What one message may carry (`ConnectionState.sendLimits`). Sizes in bytes. */
export type SendLimits = {
  /** Each image's decoded size. */
  imageBytes: number;
  /** Each other file's decoded size. */
  fileBytes: number;
  /** The whole `chat.send` frame, its files base64-encoded. */
  payloadBytes: number;
  /** Files in one message. */
  files: number;
};

export type Bot = {
  id: string;
  name: string;
  emoji: string | null;
  /** A data: or https: URL, safe to render directly. */
  avatarUrl: string | null;
  theme: string | null;
  model: string | null;
  isDefault: boolean;
  /** Paths of fields cut to their bound (an avatar too large to keep is dropped). */
  cut?: string[];
};

export type TaskStatus =
  | "running"
  | "done"
  | "failed"
  | "idle"
  /**
   * The next three come from run events (a pending approval or question, an
   * unreachable machine, a failed step in a finished run) that a read-only
   * connection does not receive yet; the mapping never produces them today.
   */
  | "waiting"
  | "blocked"
  | "done-with-failures"
  /** The latest run was stopped (`interrupted` or `killed`). */
  | "stopped"
  /** A run waits its turn on the gateway (`queued`) and nothing runs yet. */
  | "queued";

export type Task = {
  key: string;
  botId: string;
  sessionId: string | null;
  title: string;
  preview: string | null;
  updatedAt: number | null;
  status: TaskStatus;
  unread: boolean;
  /**
   * Context use after the latest run: tokens used out of the model's context
   * window. Absent when the gateway does not report both.
   */
  context?: TaskContext;
  /**
   * The bot's main session (`isMain`, or its `agent:<bot>:main` key): the gateway
   * refuses to archive or delete it ("Cannot archive an agent's main session.").
   */
  isMain?: boolean;
  /** Pinned on the gateway (`sessions.patch` `pinned`); pinned tasks come first under their bot. */
  pinned?: boolean;
  /** What the task waits on while `status` is `waiting` (`waiting.ts`), and since when. */
  waitingFor?: "approval" | "question";
  waitingSince?: number;
  /**
   * The gateway's explicit unread marker (`markedUnreadAt`), or null when it has
   * none: a read made on opening names it, so it never clears a newer "Mark as unread".
   */
  unreadMarker?: number | null;
  /**
   * The reasoning effort the task asks for (`thinkingLevel` on its session
   * row), as the gateway names it. Absent when the task records none.
   */
  effort?: string;
  /** Paths of fields cut to their bound. */
  cut?: string[];
};

export type TaskContext = {
  used: number;
  window: number;
  /** False when the gateway says the count is from before the latest run. */
  fresh: boolean;
};

export type ToolResult = {
  isError: boolean;
  text: string;
  /**
   * What the reading reads of the few `details` the gateway's history keeps
   * (`exitCode`, `ok`, `changed`, `created`, and a diff's line counts), so a
   * call history alone holds reads as its step does. Absent when none was kept.
   */
  facts?: Record<string, unknown>;
  /** The text is not the whole result: the gateway cut what it stored, or this app did. */
  clipped?: boolean;
};

export type TranscriptBlock =
  | {
      kind: "text";
      text: string;
      /**
       * The gateway's id of the row this bubble's text came from (`__openclaw.id`), on a bot's
       * turn: what a reaction, a reply or Copy message ID on this bubble names. A turn of several
       * rows shows several bubbles, each with its own.
       */
      messageId?: string;
      /**
       * The gateway's id of the message this bubble's row answers (`openclawDelivery.replyToId`):
       * its thread. OpenClaw 2026.10.6 keeps one only on a row with no tool call.
       */
      replyToId?: string;
    }
  | { kind: "reasoning"; text: string }
  | {
      kind: "tool-call";
      callId: string;
      name: string;
      /** Pretty-printed JSON arguments. */
      argumentsText: string;
      /** The row carried no arguments at all (`argumentsText` is then empty). */
      argumentsAbsent?: boolean;
      result: ToolResult | null;
    };

export type TranscriptItem = {
  /** Stable display key. */
  id: string;
  role: "user" | "assistant" | "system";
  timestamp: number | null;
  blocks: TranscriptBlock[];
  model: string | null;
  /**
   * The gateway cut a row of this item to its display length
   * (`__openclaw.truncated`): present and true only then. Its text, here or
   * read whole, is a prefix of what the gateway stored.
   */
  truncated?: boolean;
  /**
   * The gateway's id of the row whose text this item shows (`__openclaw.id`; for a bot's turn,
   * its last row with text): what a reaction or a reply to it names. Absent when the row has none.
   */
  messageId?: string;
  /**
   * The message this user row replies to, as the gateway's history says (`__openclaw.replyToId`),
   * with its preview of it. A bot's turn carries none here: each of its bubbles has its own.
   */
  replyTo?: ReplyReference;
  /**
   * The key the gateway stored this user row under (`__openclaw.idempotencyKey`): what ties it to a
   * message this client sent (`namesOutgoing`).
   */
  idempotencyKey?: string;
  /** Paths of fields cut to their bound; `readHistoryItem` reads the item whole, keeping nothing. */
  cut?: string[];
};

/** A reply's reference to the message it answers, as the gateway stores it (F-067). */
export type ReplyReference = {
  /** The gateway's id of the message replied to. */
  id: string;
  /**
   * The gateway's preview of its text (`replyToPreview.text`, or else the message history
   * attached, `replyToMessage.message`), or null.
   */
  text: string | null;
  /** Who wrote it, as the gateway labels them (`replyToPreview.senderLabel`), or null. */
  sender: string | null;
};

/** One emoji's reactions on a message, as the gateway counts them (F-283). */
export type MessageReaction = {
  emoji: string;
  count: number;
  /** True when this connection's own person is among those who reacted with it. */
  mine: boolean;
};

/** One open task: its durable transcript plus its live runs and outgoing messages. */
export type Transcript = TaskActivity & {
  sessionKey: string;
  status: "loading" | "ready" | "error";
  items: TranscriptItem[];
  error: string | null;
  hasMore: boolean;
  /**
   * Text of the task's active run, before it lands in history. Derived from
   * `runs`; kept for views that only draw one streaming bubble.
   */
  live: { runId: string; text: string } | null;
  /** Recipient runs that this task's bot-to-bot sends name, where this connection saw them. */
  linkedRuns: Record<string, LinkedRun>;
  /** Messages from other sessions in this task's history (inter-session provenance). */
  interSession: InterSessionMessage[];
  /**
   * The gateway's current map from a tool-server tool's effective name to its
   * server and tool, as `tools.effective` reports it for this task. Evidence
   * of a call's tool before its result only: the gateway rebuilds it from the
   * current catalog, which need not be the one a running attempt captured, and
   * a result's own `details` overrule it.
   */
  mcpTools: Record<string, McpToolIdentity>;
  /**
   * The built-in and plugin tools `tools.effective` lists for this task, by
   * effective name: a general card of one of these folds by its name (8.3).
   * Absent until the inventory is read.
   */
  builtinTools?: string[];
  /**
   * The bot's workspace root, as the gateway names it (`agents.files.list`
   * `workspace`): an absolute path is a memory note only inside it (8.2).
   * Absent or null when the gateway has not said; nothing is inferred then.
   */
  workspaceRoot?: string | null;
  /**
   * The reactions on the messages this transcript shows, by the gateway's message id
   * (`session.reactions.list`, then `session.reaction` events). Absent until read.
   */
  reactions?: Record<string, MessageReaction[]>;
  /** Paths of fields cut to their bound that no item beneath records itself. */
  cut?: string[];
  /** Epoch ms of the latest successful history load. */
  loadedAt: number | null;
};

/** Loading bots and tasks after each connect, separate from the socket's own state. */
export type DiscoveryState = {
  status: "idle" | "loading" | "ready" | "error";
  /** Set when a read failed; data from earlier successful reads is kept. */
  error: string | null;
  /** True when the gateway reported more tasks than the client loaded. */
  partial: boolean;
};

export type ClawtrateState = {
  connection: ConnectionState;
  discovery: DiscoveryState;
  bots: Bot[];
  tasksByBot: Record<string, Task[]>;
  transcripts: Record<string, Transcript>;
  /**
   * Pending approvals no followed task can show yet: the asking session is not
   * open, and no open task is known to have spawned or messaged it. Kept, with
   * their origin, until a task they belong to is known or the gateway settles
   * them; at most `MAX_UNROUTED_APPROVALS`.
   */
  unroutedApprovals: ApprovalCard[];
  /** Pending approvals not kept because `unroutedApprovals` was full; a list read brings them back. */
  unroutedApprovalsOmitted: number;
  /** Task creations this client has asked for and not yet seen settled (`TaskCreation`). */
  creations: TaskCreation[];
  /**
   * The gateway's provider accounts as each bot sees them, the sign-ins it
   * can start, each bot's binding and lock evidence, and the sign-in and bot
   * creation under way (`accounts.ts`). Read when a screen asks
   * (`refreshAccounts`). Holds no credential and nothing the person typed.
   */
  accounts: AccountsState;
  /**
   * The gateway's scheduled jobs, check-in jobs left out (`routines.ts`): read
   * on every connect from `cron.list` and kept current by the `cron` event.
   */
  routines: RoutinesState;
  /**
   * A secondary alarm: roughly what the state takes, against the arithmetic
   * bound of `state-bounds.ts`. The bound holds by construction; `near` only
   * says it is being approached.
   */
  retention: { estimated: number; bound: number; near: boolean };
  /**
   * The "Turn time limit" in minutes: a run this client started fails at it, and the client
   * aborts it (F-100). Clawtrate's own wall-clock limit, kept by the host; 50 by default.
   */
  turnLimitMinutes?: number;
  /**
   * The rail's arrangement as the gateway keeps it for this user (`sidebar.ts`):
   * pinned bots, sections, hidden bots and the manual order. Absent where a host
   * does not read it.
   */
  sidebar?: SidebarState;
  /**
   * The Work pane's Computer tab (`computer.ts`): whether the gateway has the
   * computer plugin, the latest control event of each bot's tab, and each
   * viewer's pane. Never a ticket, a frame or a lease's generation of this
   * device's own. Absent where a host does not show it.
   */
  computer?: ComputerState;
  /**
   * The bots' check-ins (`check-ins.ts`): their heartbeat jobs, the scheduler,
   * their own settings and the save under way. Absent until a screen reads them
   * (`refreshCheckIns`).
   */
  checkIns?: CheckInsState;
  /**
   * Warning budgets as the gateway keeps them for this person, each one's count
   * for its current period, and the limits providers report (`usage.ts`).
   * Absent where a host does not read them.
   */
  usage?: UsageState;
  /** Paths of fields cut to their bound that nothing beneath records itself. */
  cut?: string[];
};

/**
 * A task creation the user asked for. Kept from before `sessions.create` is
 * sent until the gateway's answer is known, so a request that times out is
 * neither lost nor sent twice: it is checked again with the same idempotency
 * key, which the gateway answers with the original outcome.
 */
export type TaskCreation = {
  /** Also the `idempotencyKey`. */
  id: string;
  botId: string;
  text: string;
  label: string | null;
  /**
   * `creating` while the request is out; `checking` when the answer did not
   * come and the same gateway start is being asked again with the same key;
   * `failed` when the gateway refused it (retry or dismiss); `unknown` when
   * nothing establishes whether it happened (dismiss, or the user's own retry,
   * which may create a second task: `error` says so); `created` once the task
   * exists.
   */
  status: "creating" | "checking" | "failed" | "unknown" | "created";
  /** When it was last asked of the gateway; its key is asked again only within `CREATION_KEY_WINDOW_MS` of it. */
  createdAt: number;
  error: string | null;
  /** The new task, once created. */
  key: string | null;
  /**
   * The `hello-ok.server.bootId` of the gateway start the request went to;
   * null if the hello carried none. The key is asked again automatically only
   * of that same start, which holds its idempotency record.
   */
  gatewayBootId: string | null;
};

export const initialScopeUpgrade: ScopeUpgradeState = {
  status: "idle",
  scopes: [],
  requestId: null,
  approveCommand: null,
  approveNote: null,
  error: null,
};

export const initialConnectionState: ConnectionState = {
  status: "idle",
  gatewayUrl: null,
  gatewayId: null,
  serverVersion: null,
  protocol: null,
  scopes: [],
  requestedScopes: [],
  canWrite: false,
  canAnswer: false,
  canApprove: false,
  canAdmin: false,
  upgrade: initialScopeUpgrade,
  deviceId: null,
  pairing: null,
  error: null,
  retryAt: null,
  connectedAt: null,
  paired: false,
  sendLimits: null,
};

export const initialDiscoveryState: DiscoveryState = {
  status: "idle",
  error: null,
  partial: false,
};

export const initialState: ClawtrateState = {
  connection: initialConnectionState,
  discovery: initialDiscoveryState,
  bots: [],
  tasksByBot: {},
  transcripts: {},
  unroutedApprovals: [],
  unroutedApprovalsOmitted: 0,
  creations: [],
  accounts: initialAccountsState,
  routines: initialRoutinesState,
  retention: { estimated: 0, bound: 0, near: false },
  sidebar: { status: "unknown", prefs: null },
  computer: { plugin: null, control: [], panes: {} },
  usage: initialUsage,
};
