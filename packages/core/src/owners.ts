// Every map, set and array the host keeps outside its state, with its bound:
// the client's own collections, a viewer's bridge session's, and the waiting
// files'. Two tests hold it to that: one reflects over the live objects' own
// properties, and the values of their maps, sets and arrays, and fails for any
// collection this registry does not name or past its `max`; the other scans
// the source and fails for any `new Map`, `Set`, `WeakMap`, `WeakSet`, array
// literal or factory-made collection (`Array.from`, `Array.of`,
// `Object.fromEntries`) kept in a class field, a module-level variable or a
// variable a later-running function captures, directly or inside an object
// literal written as that value, that is neither a field named here nor on its
// allowlist. Neither sees a collection put into a plain object after it was
// made (`box.list = []` on an object that is not `this`), nor one another
// function call returns.
// `hostWorstCase` adds each entry's `max × each` to the
// part of the host's worst case it names (`row`), so the documented table is
// arithmetic over this registry. Sizes are JSON characters, as in
// `state-bounds.ts`; an entry whose values are the state's own objects counts
// only its keys, since the state already counts the objects.

import {
  MAX_ACCOUNTS,
  MAX_PREF_ID_CHARS,
  MAX_SECRET_JSON_CHARS,
  MAX_SIGNIN_SECRETS,
} from "./accounts.ts";
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_PENDING_ATTACHMENTS } from "./attachments.ts";
import { jsonLength, worstCase } from "./bounds.ts";
import {
  FOREIGN_RUNS_PER_SESSION,
  FOREIGN_SESSIONS,
  MAX_ACCESS_WAITERS,
  MAX_FOREIGN_READ_SESSIONS,
  MAX_OPENED_READS,
  MAX_APPROVAL_ATTEMPTS,
  MAX_APPROVAL_OUTCOMES,
  MAX_APPROVAL_READERS,
  MAX_OUTCOME_LOOKUPS,
  MAX_ROUTE_HELD_WRITES,
  MAX_SPAWN_LINKS,
  MAX_STREAMS_PER_TASK,
} from "./client.ts";
import { MAX_VIEWER_OPEN_TASKS } from "./bridge.ts";
import { ADMIN_SCOPES } from "./scopes.ts";
import {
  MAX_FILE_TRANSFERS,
  MAX_PENDING_SAVES,
  MAX_SAVE_BYTES,
  MAX_TRANSFER_BYTES,
} from "./files.ts";
import { MAX_ROUTINE_UPDATES } from "./routines.ts";
import { emptyActivity, MAX_QUEUE_ALIASES } from "./runs.ts";
import { MAX_STORE_LISTENERS } from "./store.ts";
import {
  MAX_WAITING_ID_CHARS,
  MAX_WAITING_MARKERS,
  MAX_WAITING_SESSIONS,
  WAITING_HELD_CHARS,
  WAITING_MARKER_CHARS,
  WAITING_RUN_CHARS,
} from "./waiting.ts";
import {
  APPROVAL_ATTEMPTS,
  MAX_BOTS,
  APPROVAL_OUTCOME,
  MAX_CREATIONS,
  MAX_FILE_NAME_CHARS,
  MAX_ID_CHARS,
  MAX_LISTED_TASKS,
  MAX_OUTBOX,
  MAX_PENDING_APPROVAL_COUNT,
  MAX_RUN_LIST,
  MAX_RUN_TEXT_CHARS,
  MAX_STEPS_PER_TASK,
  MAX_TRACKED_TASKS,
  MAX_UNROUTED,
  RUN,
  WORST_ROW_CHARS,
} from "./state-bounds.ts";

/** One collection: at most `max` entries of at most `each` JSON characters, counted in the host's `row`. */
export type Owner = {
  max: number;
  each: number;
  /**
   * The part of `hostWorstCase` its entries are counted in; null when it
   * keeps nothing, holds only functions or handles, or is inside another
   * entry's values and counted in that entry's `each`.
   */
  row: string | null;
  /** Entries die with the objects they name (a WeakSet), so there is no count to keep. */
  weak?: boolean;
  /**
   * Its values are bounded by a schema or a budget, not walked further for
   * collections: what bounds them.
   */
  opaque?: string;
};

const T = MAX_TRACKED_TASKS;
const ID = MAX_ID_CHARS;
/** A number, a counter or a short flag. */
const N = 24;
/** A scope name, a resync reason, a list kind. */
const SHORT = 32;
/** A digest key (`digestKey`): three base-36 numbers. */
const DIGEST = 32;
const runWithoutSteps = worstCase(RUN, new Map([["steps", 0]]));
const ROW = ID + WORST_ROW_CHARS;

/**
 * The client's own collections, by property path. `*` stands for the values
 * of a map or set and the items of an array: a collection inside them is
 * named here too, with its count per value.
 */
export const CLIENT_OWNERS: Record<string, Owner> = {
  // Task list rows: only the fields read, the newest `MAX_LISTED_TASKS`.
  rows: { max: MAX_LISTED_TASKS, each: ROW, row: "sessionRows", opaque: "`SESSION_ROW`" },
  // Task lists being read: a hello's and one refresh's, each its rows so far, bounded per page.
  listings: { max: 2, each: MAX_LISTED_TASKS * ROW, row: "sessionRows" },
  "listings.*": { max: MAX_LISTED_TASKS, each: ROW, row: null, opaque: "`SESSION_ROW`" },
  // Per followed task: keys and small values.
  openSessions: { max: T, each: ID + N, row: "bookkeeping" },
  retained: { max: T, each: ID, row: "bookkeeping" },
  incarnations: { max: T, each: ID + N, row: "bookkeeping" },
  loads: { max: T, each: ID + SHORT, row: "bookkeeping" },
  deliveries: { max: T, each: ID, row: "bookkeeping" },
  historyTimers: { max: T, each: ID, row: "bookkeeping" },
  resyncReasons: { max: T, each: ID + SHORT, row: "bookkeeping" },
  expiryTimers: { max: T, each: ID, row: "bookkeeping" },
  afterRunning: { max: T, each: ID, row: "bookkeeping" },
  afterAgain: { max: T, each: ID, row: "bookkeeping" },
  // A task's `agent.wait` check in flight, and the ids of the active runs it last checked.
  endChecking: { max: T, each: ID, row: "bookkeeping" },
  endChecked: { max: T, each: ID + MAX_RUN_LIST * (ID + 1), row: "bookkeeping" },
  // One per task and list kind (three approval kinds and questions).
  listRequested: { max: T * 4, each: ID + SHORT + N, row: "bookkeeping" },
  listApplied: { max: T * 4, each: ID + SHORT + N, row: "bookkeeping" },
  // A task's tool map read in flight, and whether another was asked for.
  toolReads: { max: T, each: ID + N, row: "bookkeeping" },
  // A run's turn limit, for each run of a followed task.
  turnTimers: { max: T * MAX_RUN_LIST, each: 2 * ID + 1, row: "bookkeeping" },
  // Streaming `chat` text: run id, task, agent and the text only.
  "streams.runs": {
    max: T * MAX_STREAMS_PER_TASK,
    each: 3 * ID + MAX_RUN_TEXT_CHARS,
    row: "streamBaselines",
  },
  // Raw payloads: their content is the table's budget; these are their keys. Each retained step
  // and each retained run's failure has one, and one incoming entry before the table prunes.
  "raw.entries": {
    max: T * (MAX_STEPS_PER_TASK + MAX_RUN_LIST) + 1,
    each: 3 * ID + 1 + N,
    row: "rawPayloads",
    opaque: "the raw table's budget, `MAX_RAW_BYTES`",
  },
  "raw.perTask": { max: T, each: ID + N, row: "rawPayloads" },
  // Which tasks wait for the person (`waiting.ts`): a key, and its markers (counted below).
  "waiting.sessions": {
    max: MAX_WAITING_SESSIONS,
    each: MAX_WAITING_ID_CHARS + MAX_WAITING_MARKERS * WAITING_MARKER_CHARS,
    row: "bookkeeping",
  },
  "waiting.sessions.*": { max: MAX_WAITING_MARKERS, each: WAITING_MARKER_CHARS, row: null },
  // Each task's latest run by id, and whether it was stopped.
  "waiting.runs": { max: MAX_WAITING_SESSIONS, each: WAITING_RUN_CHARS, row: "bookkeeping" },
  // Tasks the engine follows, as their runs describe them.
  // A task's read on opening, while it is on its way.
  openedReads: { max: MAX_OPENED_READS, each: ID, row: "bookkeeping" },
  "waiting.held": { max: MAX_WAITING_SESSIONS, each: WAITING_HELD_CHARS, row: "bookkeeping" },
  // Sessions no viewer has open: a few runs each, without their steps; their payloads are not kept.
  foreign: {
    max: FOREIGN_SESSIONS,
    each:
      ID +
      jsonLength(emptyActivity) +
      MAX_QUEUE_ALIASES * 2 * ID +
      FOREIGN_RUNS_PER_SESSION * (runWithoutSteps + 1),
    row: "foreignRuns",
  },
  foreignReads: {
    max: MAX_FOREIGN_READ_SESSIONS,
    each: ID + MAX_STEPS_PER_TASK * N,
    row: "bookkeeping",
  },
  "foreignReads.*": { max: MAX_STEPS_PER_TASK, each: N, row: null },
  "foreign.*.runs": {
    max: FOREIGN_RUNS_PER_SESSION,
    each: runWithoutSteps,
    row: null,
    opaque: "`RUN`, its steps dropped",
  },
  "foreign.*.outbox": { max: 0, each: 0, row: null },
  "foreign.*.questions": { max: 0, each: 0, row: null },
  "foreign.*.approvals": { max: 0, each: 0, row: null },
  "foreignRaw.entries": { max: 0, each: 0, row: null },
  "foreignRaw.perTask": { max: 0, each: 0, row: null },
  spawnedBy: { max: MAX_SPAWN_LINKS, each: 2 * ID, row: "spawnLinks" },
  recipients: { max: T, each: ID + 2 * MAX_STEPS_PER_TASK * ID, row: "recipientLinks" },
  "recipients.*.runs": { max: MAX_STEPS_PER_TASK, each: ID, row: null },
  "recipients.*.sessions": { max: MAX_STEPS_PER_TASK, each: ID, row: null },
  // Each unsettled approval's attempts, apart from any task, while anything is outstanding.
  approvalAttempts: {
    max: MAX_APPROVAL_ATTEMPTS,
    each: ID + worstCase(APPROVAL_ATTEMPTS),
    row: "approvalAttempts",
    opaque: "`APPROVAL_ATTEMPTS`",
  },
  approvalOutcomes: {
    max: MAX_APPROVAL_OUTCOMES,
    each: ID + worstCase(APPROVAL_OUTCOME),
    row: "approvalOutcomes",
    opaque: "`APPROVAL_OUTCOME`",
  },
  // The same objects as the state's `unroutedApprovals`: only the keys are more.
  unrouted: { max: MAX_UNROUTED, each: ID, row: "bookkeeping", opaque: "`APPROVAL`" },
  lookingUp: { max: MAX_OUTCOME_LOOKUPS, each: ID, row: "bookkeeping" },
  // Whole reads of pending approvals' text: the digest given to each viewer.
  approvalReads: {
    max: T * MAX_PENDING_APPROVAL_COUNT + 1,
    each: 2 * ID + 1 + MAX_APPROVAL_READERS * DIGEST,
    row: "approvalReads",
  },
  "approvalReads.*": { max: MAX_APPROVAL_READERS, each: DIGEST, row: null },
  // Creations: the same objects as the state's `creations`, and their timers, waiters and slots.
  creations: { max: MAX_CREATIONS, each: ID, row: "bookkeeping", opaque: "`CREATION`" },
  creationTimers: { max: MAX_CREATIONS, each: ID, row: "bookkeeping" },
  creationWaiters: { max: MAX_CREATIONS, each: ID, row: "bookkeeping" },
  "creationWaiters.*": { max: MAX_ACCESS_WAITERS, each: 0, row: null },
  checkingSlots: { max: MAX_CREATIONS, each: ID, row: "bookkeeping" },
  accessWaiters: { max: MAX_ACCESS_WAITERS, each: SHORT, row: "bookkeeping" },
  // The scopes a device-access request keeps: those of the admin tier the connection held.
  heldBase: { max: ADMIN_SCOPES.length, each: SHORT, row: "bookkeeping" },
  // Files of outgoing messages: their content is `outboxFiles`; these are the names kept beside it.
  attachmentContent: {
    max: T * MAX_OUTBOX,
    each: 2 * ID + MAX_ATTACHMENTS_PER_MESSAGE * 3 * MAX_FILE_NAME_CHARS,
    row: "outboxFiles",
  },
  "attachmentContent.*.files": {
    max: MAX_ATTACHMENTS_PER_MESSAGE,
    each: 3 * MAX_FILE_NAME_CHARS,
    row: null,
    opaque: "file content, counted in `outboxFiles`",
  },
  // The store's listeners: a host's windows and web viewers.
  "store.listeners": { max: MAX_STORE_LISTENERS, each: 0, row: null },
  // A routed connection's token writes, functions held until its identity matched, then dropped.
  routeHeldWrites: { max: MAX_ROUTE_HELD_WRITES, each: 0, row: null },
  // Viewers that went away; an entry lives only as long as the viewer's own object.
  withdrawnOwners: { max: 0, each: 0, row: null, weak: true },
  // Provider accounts (`accounts-engine.ts`): how each account was made, from the record of the
  // sign-ins Clawtrate started; what it set for each bot; bots whose empty fallback list did not land.
  // Keys and values are bounded where they enter (`prefProfileId`, `prefBotId`, `readIntent`).
  "accounts.kinds": { max: MAX_ACCOUNTS, each: MAX_PREF_ID_CHARS + SHORT, row: "bookkeeping" },
  "accounts.intents": {
    max: MAX_ACCOUNTS,
    each: 2 * MAX_PREF_ID_CHARS + SHORT,
    row: "bookkeeping",
  },
  "accounts.unwritten": { max: MAX_ACCOUNTS, each: ID, row: "bookkeeping" },
  // The bots there before the first Create of the bot being made, while its answer is in doubt.
  "accounts.before": { max: MAX_BOTS, each: ID, row: "bookkeeping" },
  // What the person typed into the one sign-in under way, in the forms it may come back in, while
  // that sign-in lasts, to scrub the gateway's answers: never in the state, forgotten at its end.
  "accounts.secrets": { max: MAX_SIGNIN_SECRETS, each: MAX_SECRET_JSON_CHARS, row: "bookkeeping" },
  "routines.updates": { max: MAX_ROUTINE_UPDATES, each: ID + N, row: "bookkeeping" },
  // File content on its way to a viewer, in chunks: the base64 of the largest content a reader
  // sends, its id and its counters; dropped once read, released, or idle past its time.
  "fileTransfers.held": {
    max: MAX_FILE_TRANSFERS,
    each: ID + Math.ceil(MAX_TRANSFER_BYTES / 3) * 4 + 4 * N,
    row: "fileTransfers",
  },
};

/**
 * Properties of the client that are not walked for collections, and why: what
 * the host passed in, the official client package's objects, and the state.
 */
export const CLIENT_NOT_WALKED: Record<string, string> = {
  host: "the host's own objects: its socket factory, storage and signer",
  protocol: "the official client package's protocol client; its requests time out",
  auth: "the official client package's device-auth lifecycle and this connection's token store",
  scopeUpgrade: "the official client package's access request, one at a time",
  "store.value": "the state, bounded by its schema (`state-bounds.ts`) and counted in `state`",
  "accounts.ctx": "the client's own functions, handed to the accounts engine",
  "accounts.signInAbort": "a handle that ends the one sign-in request that waits",
  "routines.ctx": "the client's own functions, handed to the routines engine",
  "usage.ctx": "the client's own functions, handed to the usage engine",
  "machines.ctx": "the client's own functions, handed to the machines engine, which keeps nothing",
};

/** The class of each client property whose own collections are named under it. */
export const CLIENT_PARTS: Record<string, string> = {
  raw: "RawTable",
  foreignRaw: "RawTable",
  streams: "ChatTextBaselines",
  store: "ObservableStore",
  fileTransfers: "FileTransfers",
  accounts: "AccountsEngine",
  routines: "RoutinesEngine",
  usage: "UsageEngine",
  machines: "MachinesEngine",
  waiting: "WaitingIndex",
};

/** One viewer's bridge session, per viewer (`MAX_WEB_VIEWERS` on the web host). */
export const VIEWER_OWNERS: Record<string, Owner> = {
  open: { max: MAX_VIEWER_OPEN_TASKS, each: ID, row: "viewers" },
};
/** Properties of a viewer's session that are not walked: the client and the host's policy. */
export const VIEWER_NOT_WALKED: Record<string, string> = {
  client: "the client, walked on its own",
  policy: "the host's policy; its waiting files are walked on their own (`ATTACHMENT_OWNERS`)",
};

/** The files waiting for a message (`AttachmentStore`); their content is `uploads`. */
export const ATTACHMENT_OWNERS: Record<string, Owner> = {
  entries: {
    max: MAX_PENDING_ATTACHMENTS,
    each: 2 * ID + 3 * MAX_FILE_NAME_CHARS,
    row: "uploads",
    opaque: "file content within `MAX_PENDING_ATTACHMENT_BYTES`",
  },
  reserved: { max: MAX_PENDING_ATTACHMENTS, each: N, row: "uploads" },
};
export const ATTACHMENT_NOT_WALKED: Record<string, string> = {
  options: "the store's settings: an id source, a clock and two numbers",
};

/**
 * Files waiting for their save dialog in the desktop app (`PendingSaves`):
 * the bytes a viewer handed over, kept as bytes, keyed by its window.
 */
export const SAVE_OWNERS: Record<string, Owner> = {
  held: {
    max: MAX_PENDING_SAVES,
    each: N + MAX_SAVE_BYTES,
    row: "saves",
    opaque: "file bytes, at most `MAX_SAVE_BYTES` each",
  },
};

/** Captured host keys waiting for the person's decision, in the desktop app's SSH transport. */
export const MAX_SSH_CAPTURES = 8;
/** Routes one SSH transport knows the latest preparation of; an older route is stale. */
export const MAX_SSH_ROUTES = 16;
/** Forwards one SSH transport keeps open at once. */
export const MAX_SSH_FORWARDS = 8;
/** `ssh` processes one SSH transport runs at once. */
export const MAX_SSH_PROCESSES = 32;
/** Listeners to one forward's states. */
export const MAX_FORWARD_LISTENERS = 8;
/** The longest key a captured known-hosts line may carry, in base64 characters. */
export const MAX_HOST_KEY_CHARS = 8192;

/**
 * The desktop app's SSH transport (`apps/desktop/src/main/ssh/`), behind the
 * setup screens of "Another computer": its captured keys wait for the
 * person's decision, and count in the host's worst case (`sshCaptures`).
 */
export const SSH_TRANSPORT_OWNERS: Record<string, Owner> = {
  captures: {
    max: MAX_SSH_CAPTURES,
    each: 3 * ID + MAX_HOST_KEY_CHARS + SHORT,
    row: "sshCaptures",
    opaque: "one public host key, at most `MAX_HOST_KEY_CHARS`, each dropped after 2 minutes",
  },
  forwards: { max: MAX_SSH_FORWARDS, each: N, row: null },
  routes: { max: MAX_SSH_ROUTES, each: 2 * ID, row: null },
};
/** The `ssh` processes an SSH transport runs (`ProcessTable`), by PID. */
export const SSH_PROCESS_OWNERS: Record<string, Owner> = {
  running: { max: MAX_SSH_PROCESSES, each: N, row: null },
};
/** Channels the setup host keeps: one forward attempt's local socket each, the newest. */
export const MAX_SSH_CHANNELS = 16;
/** Destinations whose route id the setup host remembers in one run. */
export const MAX_SSH_REMEMBERED_IDS = 16;
/** Route records the desktop's route store keeps, each with at most one sealed token. */
export const MAX_SSH_ROUTE_RECORDS = 8;

/**
 * The setup host of "Another computer" (`apps/desktop/src/setup/remote.ts`):
 * the channels it gave the client, by address, and the route id of each
 * destination looked at in this run. Neither is shown or sent.
 */
export const REMOTE_SETUP_OWNERS: Record<string, Owner> = {
  channels: { max: MAX_SSH_CHANNELS, each: 2 * ID + SHORT, row: null },
  ids: { max: MAX_SSH_REMEMBERED_IDS, each: 2 * ID, row: null },
};

/** A forward's state listeners (`ForwardSupervisor`): functions. */
export const SSH_FORWARD_OWNERS: Record<string, Owner> = {
  listeners: { max: MAX_FORWARD_LISTENERS, each: N, row: null },
};

/**
 * The collection fields of each class whose instances the host keeps, from
 * the registry: what a class's source may declare. A field not named here is
 * found by the source scan.
 */
export function ownerClassFields(): Record<string, string[]> {
  const fields: Record<string, Set<string>> = {
    ClawtrateClient: new Set(),
    ViewerSession: new Set(Object.keys(VIEWER_OWNERS)),
    AttachmentStore: new Set(Object.keys(ATTACHMENT_OWNERS)),
    PendingSaves: new Set(Object.keys(SAVE_OWNERS)),
    SshTransport: new Set(Object.keys(SSH_TRANSPORT_OWNERS)),
    ProcessTable: new Set(Object.keys(SSH_PROCESS_OWNERS)),
    ForwardSupervisor: new Set(Object.keys(SSH_FORWARD_OWNERS)),
    RemoteSetup: new Set(Object.keys(REMOTE_SETUP_OWNERS)),
  };
  for (const path of Object.keys(CLIENT_OWNERS)) {
    const parts = path.split(".");
    if (parts.length === 1) fields.ClawtrateClient!.add(path);
    else if (parts.length === 2 && CLIENT_PARTS[parts[0]!]) {
      const owner = CLIENT_PARTS[parts[0]!]!;
      (fields[owner] ??= new Set()).add(parts[1]!);
    }
  }
  return Object.fromEntries(Object.entries(fields).map(([name, set]) => [name, [...set].sort()]));
}

/** The records in the desktop updater's private preference store. */
export const UPDATE_PREFERENCE_OWNERS: Record<string, Owner> = {
  attempt: {
    max: 1,
    each: JSON.stringify({
      target: "v".repeat(50),
      from: "v".repeat(50),
      track: "nightly",
      time: "2000-01-01T00:00:00.000Z",
      phase: "handoff",
    }).length,
    row: "updatePreferences",
  },
  selectedTrack: { max: 1, each: JSON.stringify("nightly").length, row: "updatePreferences" },
  lastCheck: {
    max: 1,
    each: JSON.stringify({ track: "nightly", readAt: "2000-01-01T00:00:00.000Z" }).length,
    row: "updatePreferences",
  },
};

/** JSON characters each registry row adds to the host's worst case, with `viewers` bridge sessions. */
export function ownerRows(viewers: number): Record<string, number> {
  const rows: Record<string, number> = {};
  const add = (owners: Record<string, Owner>, times: number) => {
    for (const owner of Object.values(owners)) {
      if (owner.row === null) continue;
      rows[owner.row] = (rows[owner.row] ?? 0) + times * owner.max * owner.each;
    }
  };
  add(CLIENT_OWNERS, 1);
  add(VIEWER_OWNERS, viewers);
  add(ATTACHMENT_OWNERS, 1);
  add(SAVE_OWNERS, 1);
  add(UPDATE_PREFERENCE_OWNERS, 1);
  add(SSH_TRANSPORT_OWNERS, 1);
  return rows;
}
