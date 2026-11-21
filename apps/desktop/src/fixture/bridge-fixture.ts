// A bridge that serves fixed state, for development and the visual tests. It
// implements the same ClawtrateBridge the desktop and web hosts do, holds
// everything in memory, and never opens a socket or makes a request.

import { holdableTimers } from "./timers.ts";
import { fixtureRoutines, routineCommands, type RoutineParams } from "./routines.ts";
import {
  applyApprovalResolved,
  applyQuestionResolved,
  beginDecision,
  beginReadback,
  decisionRefusal,
  decisionText,
  endDecision,
  endReadback,
  initialState,
  MAX_RAW_ENTRY_CHARS,
  noteSent,
  readbackPending,
  resolveRequest,
  markQuestion,
  PAIRING_ENDED,
  type ApprovalCard,
  type BridgeCommand,
  type BridgeResultFor,
  type ClawtrateBridge,
  noDesktopUpdates,
  type ClawtrateState,
  type ConnectionState,
  type HostInfo,
  type RunRawRead,
  type TaskActivity,
  type Transcript,
} from "@clawtrate/core";
import {
  CARD_SCENES,
  cardScene,
  isCardScene,
  questionEvent,
  wholeApproval,
  type CardSceneName,
  type DecisionMode,
} from "./cards.ts";
import {
  FAILING_TASK,
  OPEN_TASK,
  fixtureBots,
  fixtureTasks,
  fixtureTranscripts,
  withTaskStates,
} from "./data.ts";
import { FILE_COMMANDS, fileAnswers, withFileRuns, type FileParams } from "./files.ts";
import {
  accountCommand,
  fixtureAccounts,
  NO_ACCOUNT_PARAMS,
  withAccess,
  type AccountParams,
} from "./accounts.ts";
import { machineCommands, NO_MACHINE_PARAMS, type MachineParams } from "./machines.ts";
import { FAILED_EVENT, LIVE_SCENES, liveCommand, liveScene, type LiveScene } from "./live.ts";
import { isRailScene, RAIL_SCENES, railCommands, railScene } from "./rail.ts";
import { ACTION_SCENES, actionScene, isActionScene } from "./actions.ts";
import { isSetupState, setupCommand, setupInfo, SETUP_STATES } from "./setup.ts";
import { checkInCommands, fixtureCheckIns, type CheckInParams } from "./check-ins.ts";
import { memoryCommands } from "./memory.ts";
import { fixtureUsage, NO_USAGE_PARAMS, usageCommand, type UsageParams } from "./usage.ts";

export const FIXTURE_INFO: HostInfo = {
  kind: "web",
  version: "0.1.0",
  devGateway: { url: "ws://127.0.0.1:19001" },
  deviceName: "Clawtrate Web",
};

export const GATEWAY_URL = "ws://127.0.0.1:18789";
/** The fixture gateway's identity, as `gateway.identity.get` would give it. Invented. */
export const GATEWAY_ID = "6f3b0d2e9a41c7f58e2d4b1a0c9e7f3d5b8a2c4e6f1d0b9a8c7e5f4d3b2a1c0e";
const DEVICE_ID = "a41c9e02f7d84b19c6e2";

/** Every scene the fixture can show, by the name used in `?scene=`. */
export const SCENES = [
  "main",
  "connect",
  "connect-error",
  "connecting",
  "pairing",
  "reconnecting",
  "reconnecting-unloaded",
  "offline",
  "offline-long-address",
  "catching-up",
  "synced",
  "sync-pending",
  "sync-failed",
  "refresh-failed",
  "load-failed",
  "loading",
  "discovery-error",
  "discovering",
  "empty",
  "partial",
  "zero-tasks",
  "task-states",
  "protocol-mismatch",
  "pairing-ended",
  "connect-unreachable",
  "disconnected",
  "offline-unreachable",
  "offline-down",
  ...LIVE_SCENES,
  ...RAIL_SCENES,
  ...ACTION_SCENES,
] as const;

export type SceneName = (typeof SCENES)[number] | CardSceneName;

type Step = { after: number; change: (state: ClawtrateState) => ClawtrateState };

const connected: ConnectionState = {
  ...initialState.connection,
  status: "connected",
  gatewayUrl: GATEWAY_URL,
  gatewayId: GATEWAY_ID,
  serverVersion: "2026.10.6",
  protocol: 4,
  scopes: ["operator.read"],
  deviceId: DEVICE_ID,
  paired: true,
  // What OpenClaw 2026.10.6 advertises by default: images 6 MiB, files the 25 MiB frame's
  // budget once base64-encoded (18.6 MiB), frames 25 MiB.
  sendLimits: {
    imageBytes: 6 * 1024 * 1024,
    fileBytes: 19_464_192,
    payloadBytes: 25 * 1024 * 1024,
    files: 20,
  },
};

function loaded(now: number): ClawtrateState {
  const bots = fixtureBots();
  return {
    connection: { ...connected, connectedAt: now - 1000 },
    discovery: { status: "ready", error: null, partial: false },
    bots,
    tasksByBot: fixtureTasks(now, bots),
    transcripts: fixtureTranscripts(now, bots),
    unroutedApprovals: [],
    unroutedApprovalsOmitted: 0,
    creations: [],
    accounts: initialState.accounts,
    routines: initialState.routines,
    retention: initialState.retention,
  };
}

function idle(): ClawtrateState {
  return { ...initialState, connection: { ...initialState.connection, deviceId: DEVICE_ID } };
}

function pairing(): ClawtrateState {
  return {
    ...initialState,
    connection: {
      ...initialState.connection,
      status: "pairing",
      gatewayUrl: GATEWAY_URL,
      deviceId: DEVICE_ID,
      retryAt: Date.now() + 4000,
      pairing: {
        requestId: "5d2a90c4-1b7e-4f0a-9c3d-2e8f6a1b0c55",
        deviceId: DEVICE_ID,
        message: "pairing required",
        approveCommand: "openclaw devices approve 5d2a90c4-1b7e-4f0a-9c3d-2e8f6a1b0c55",
        approveNote: "The gateway's owner runs this on the gateway's machine.",
        requestedScopes: ["operator.read"],
      },
    },
  };
}

const UNREACHABLE = {
  code: "UNREACHABLE",
  message: "Nothing answered at 127.0.0.1:18789.",
  hint: "Check that the gateway is running and that the address is right.",
};

const withConnection = (state: ClawtrateState, change: Partial<ConnectionState>) => ({
  ...state,
  connection: { ...state.connection, ...change },
});

const reconnecting = (state: ClawtrateState) =>
  withConnection(state, { status: "reconnecting", retryAt: Date.now() + 4000 });

/**
 * Strictly increasing times, so "loaded after the latest connect" holds even
 * when a test fixes the page's clock.
 */
let tick = 0;
const stamp = () => Date.now() + (tick += 1);

/** The connection is back: what was loaded before is now out of date. */
const catchingUp = (state: ClawtrateState): ClawtrateState => ({
  ...withConnection(state, {
    status: "connected",
    retryAt: null,
    error: null,
    connectedAt: stamp(),
  }),
  discovery: { ...state.discovery, status: "loading" },
});

/** Bots and tasks have loaded again; open transcripts have not reloaded yet. */
const discovered = (state: ClawtrateState): ClawtrateState => ({
  ...state,
  discovery: { status: "ready", error: null, partial: false },
});

/** Every transcript that did not fail has reloaded. */
const reloaded = (state: ClawtrateState): ClawtrateState => {
  const at = stamp();
  const transcripts = Object.fromEntries(
    Object.entries(state.transcripts).map(([key, transcript]) => [
      key,
      transcript.status === "error" ? transcript : { ...transcript, loadedAt: at },
    ]),
  );
  return { ...state, transcripts };
};

const caughtUp = (state: ClawtrateState): ClawtrateState => reloaded(discovered(state));

function failTranscript(state: ClawtrateState, key: string, keepItems: boolean): ClawtrateState {
  const transcript = state.transcripts[key];
  if (!transcript) return state;
  return {
    ...state,
    transcripts: {
      ...state.transcripts,
      [key]: {
        ...transcript,
        status: "error",
        items: keepItems ? transcript.items : [],
        live: null,
        error: "chat.history timed out after 15 seconds.",
      },
    },
  };
}

/** The scene's first state, and the changes that follow it. */
function scene(name: SceneName, now: number): { initial: ClawtrateState; steps: Step[] } {
  const base = loaded(now);
  if (isCardScene(name)) return { initial: cardScene(name, now).change(base), steps: [] };
  if (isRailScene(name)) return { initial: railScene(name, base, now), steps: [] };
  switch (name) {
    case "main":
      return { initial: base, steps: [] };
    case "connect":
      return { initial: idle(), steps: [] };
    case "connect-error":
      return {
        initial: withConnection(idle(), {
          status: "error",
          gatewayUrl: GATEWAY_URL,
          error: {
            code: "ECONNREFUSED",
            message: "Nothing answered at 127.0.0.1:18789.",
            hint: "Check that the gateway is running and that the address and port are right.",
          },
        }),
        steps: [],
      };
    case "connecting":
      return {
        initial: withConnection(idle(), { status: "connecting", gatewayUrl: GATEWAY_URL }),
        steps: [],
      };
    case "pairing":
      return { initial: pairing(), steps: [] };
    case "reconnecting":
      return { initial: reconnecting(base), steps: [] };
    case "reconnecting-unloaded": {
      const transcripts = { ...base.transcripts };
      delete transcripts[OPEN_TASK];
      return { initial: reconnecting({ ...base, transcripts }), steps: [] };
    }
    case "offline":
      return {
        initial: withConnection(base, {
          status: "error",
          retryAt: null,
          error: { code: "ECONNREFUSED", message: "Connection refused", hint: null },
        }),
        steps: [],
      };
    case "offline-long-address":
      return {
        initial: withConnection(base, {
          status: "error",
          gatewayUrl: "wss://gateway-in-the-basement-rack-two.example:18789",
          retryAt: null,
          error: { code: "ECONNREFUSED", message: "Connection refused", hint: null },
        }),
        steps: [],
      };
    case "catching-up":
      return { initial: reconnecting(base), steps: [{ after: 60, change: catchingUp }] };
    case "synced":
      return {
        initial: reconnecting(base),
        steps: [
          { after: 60, change: catchingUp },
          { after: 160, change: caughtUp },
        ],
      };
    case "sync-pending":
      // Bots and tasks are back, but the open task has not reloaded.
      return {
        initial: reconnecting(base),
        steps: [
          { after: 60, change: catchingUp },
          { after: 160, change: discovered },
        ],
      };
    case "sync-failed":
      return {
        initial: reconnecting(base),
        steps: [
          { after: 60, change: (s) => failTranscript(catchingUp(s), OPEN_TASK, true) },
          { after: 160, change: caughtUp },
        ],
      };
    case "refresh-failed":
      return { initial: failTranscript(base, OPEN_TASK, true), steps: [] };
    case "load-failed":
      return { initial: failTranscript(base, FAILING_TASK, false), steps: [] };
    case "loading": {
      const transcripts = { ...base.transcripts };
      delete transcripts[OPEN_TASK];
      return { initial: { ...base, transcripts }, steps: [] };
    }
    case "discovery-error":
      return {
        initial: {
          ...base,
          discovery: {
            status: "error",
            error: "agents.list failed: the gateway is restarting.",
            partial: false,
          },
        },
        steps: [],
      };
    case "discovering":
      return {
        initial: {
          ...initialState,
          connection: connected,
          discovery: { ...base.discovery, status: "loading" },
        },
        steps: [],
      };
    case "empty":
      return {
        initial: { ...initialState, connection: connected, discovery: base.discovery },
        steps: [],
      };
    case "partial":
      return { initial: { ...base, discovery: { ...base.discovery, partial: true } }, steps: [] };
    case "zero-tasks":
      return { initial: { ...base, tasksByBot: { ...base.tasksByBot, marlow: [] } }, steps: [] };
    case "protocol-mismatch":
      return {
        initial: withConnection(base, {
          status: "error",
          retryAt: null,
          protocol: 5,
          serverVersion: "2027.2.1",
          error: {
            code: "PROTOCOL_MISMATCH",
            message: "This gateway speaks protocol 5. This version of Clawtrate speaks protocol 4.",
            hint: null,
            protocol: { gateway: 5, client: 4 },
          },
        }),
        steps: [],
      };
    case "pairing-ended":
      return {
        initial: withConnection(idle(), {
          status: "error",
          gatewayUrl: GATEWAY_URL,
          error: { ...PAIRING_ENDED, hint: null },
        }),
        steps: [],
      };
    case "connect-unreachable":
      return {
        initial: withConnection(idle(), {
          status: "connecting",
          gatewayUrl: GATEWAY_URL,
          retryAt: Date.now() + 4000,
          error: UNREACHABLE,
        }),
        steps: [],
      };
    case "disconnected":
      return { initial: withConnection(base, { status: "disconnected" }), steps: [] };
    case "offline-unreachable":
    case "offline-down":
      return {
        initial: withConnection(reconnecting(base), { error: UNREACHABLE }),
        steps: [],
      };
    case "task-states":
      return { initial: { ...base, tasksByBot: withTaskStates(base.tasksByBot) }, steps: [] };
    default:
      if (isActionScene(name)) return actionScene(name, base, now);
      return liveScene(name as LiveScene, base, now);
  }
}

export function isScene(value: string | null): value is SceneName {
  return value !== null && [...SCENES, ...CARD_SCENES].includes(value as SceneName);
}

/** Change one task's live state, as the engine would. */
function inTask(
  state: ClawtrateState,
  key: string,
  change: (activity: TaskActivity) => TaskActivity,
): ClawtrateState {
  const transcript = state.transcripts[key];
  if (!transcript) return state;
  return {
    ...state,
    transcripts: {
      ...state.transcripts,
      [key]: { ...transcript, ...change(transcript) } as Transcript,
    },
  };
}

/** A read-back that found the request still pending, as the engine applies it. */
function readBack(activity: TaskActivity, approvalId: string): TaskActivity {
  const card = activity.approvals.find((each) => each.id === approvalId);
  if (!card || card.status !== "pending" || card.decisionError === null) return activity;
  const begun = beginReadback(activity, approvalId);
  const read = readbackPending(begun.activity, approvalId, begun.attempt);
  return endReadback(read.activity, approvalId, begun.attempt);
}

/** The strings the gateway would report for an answer: each chosen option's value or label. */
function answerStrings(
  transcript: Transcript | undefined,
  questionId: string,
  answers: Record<string, Array<string | { option: number }>>,
): Record<string, string[]> {
  const card = transcript?.questions.find((each) => each.id === questionId);
  return Object.fromEntries(
    Object.entries(answers).map(([id, list]) => {
      const item = card?.questions.find((each) => each.id === id);
      return [
        id,
        list.map((answer) => {
          if (typeof answer === "string") return answer;
          const option = item?.options.find((each) => each.index === answer.option);
          return option?.value ?? option?.label ?? String(answer.option);
        }),
      ];
    }),
  );
}

export function createFixtureBridge(
  name: SceneName,
  /** `setup`: the desktop's first screen and a state of setup (`setup.ts`), over the connect scene. */
  options: {
    desktopUpdates?: ClawtrateBridge["desktopUpdates"];
    files?: FileParams;
    accounts?: AccountParams;
    setup?: string | null;
    routines?: RoutineParams;
    usage?: UsageParams;
    machines?: MachineParams;
    checkIns?: CheckInParams;
  } = {},
): ClawtrateBridge & {
  setState(change: (state: ClawtrateState) => ClawtrateState): void;
  /** Every command the interface sent, for tests that check what was asked of the host. */
  sent: BridgeCommand[];
  /** The last unread count the interface gave for the dock badge. */
  badge: number | null;
  /** From now on, refuse the rail's commands of this type, as a gateway refuses a change. */
  refuse(type: string): void;
  /** The next plain archive meets a run that had just started, and stops it. */
  raceArchive(): void;
  /**
   * Hold the fixture's timed scene steps and delayed answers (a decision applied, refused, or read
   * back; a reconnect answered; admin or device access granted; a machine setting read or saved)
   * until `release`: a test that must see a state lasting only until the answer comes holds it,
   * looks, then lets the answer through.
   * An answer asked for while held comes on release without waiting for a page timer, which a
   * loaded machine can leave unfired for longer than a check waits.
   */
  hold(): void;
  release(): void;
} {
  const now = Date.now();
  const setupName = isSetupState(options.setup ?? null) ? options.setup! : null;
  const { initial: sceneInitial, steps } = scene(setupName ? "connect" : name, now);
  const initial = setupName ? { ...sceneInitial, setup: SETUP_STATES[setupName]! } : sceneInitial;
  // The Work pane's Files scenes add the disk task's file runs, and answer the file commands.
  const fileParams = options.files ?? { state: null, checkout: false, failFirstOpen: false };
  const fileAnswer = fileAnswers(now, fileParams);
  const accountParams = options.accounts ?? NO_ACCOUNT_PARAMS;
  const routineParams = options.routines ?? { state: "none" };
  let state =
    fileParams.state === null
      ? initial
      : { ...initial, transcripts: withFileRuns(initial.transcripts, now, fileParams) };
  // Every scene with bots has the gateway's accounts; the address can give it more access.
  if (state.bots.length > 0)
    state = withAccess(
      {
        ...state,
        accounts: fixtureAccounts(now, accountParams),
        routines: fixtureRoutines(now, routineParams),
      },
      accountParams,
    );
  const checkInParams = options.checkIns ?? {
    checkins: null,
    defaultPrompt: false,
    scheduler: true,
    save: null,
  };
  const checkInCommand = checkInCommands(checkInParams);
  if (state.bots.length > 0)
    state = {
      ...state,
      checkIns: fixtureCheckIns(now, checkInParams, state.connection.gatewayId),
    };
  // And the usage the gateway reports, with this person's budgets.
  const usageParams = options.usage ?? NO_USAGE_PARAMS;
  if (state.bots.length > 0) state = { ...state, usage: fixtureUsage(now, usageParams) };
  const listeners = new Set<(state: ClawtrateState) => void>();
  const set = (next: ClawtrateState) => {
    state = next;
    for (const listener of listeners) listener(state);
  };
  // A scene's later steps are timed from when the interface first listens, after it has drawn
  // the first state: timed from here, a slow machine could draw its first frame after them,
  // and never show the state the scene starts from.
  let started = false;
  const startSteps = () => {
    if (started) return;
    started = true;
    for (const step of steps) deferred(() => set(step.change(state)), step.after);
  };
  let pairingChecks = 0;
  const sent: BridgeCommand[] = [];
  // How this scene's gateway answers a decision: it applies it, refuses it, or never answers.
  const decisions: DecisionMode = isCardScene(name) ? cardScene(name, now).decisions : "apply";
  const timers = holdableTimers();
  const { deferred } = timers;
  const later = (ms: number, change: (state: ClawtrateState) => ClawtrateState) =>
    deferred(() => set(change(state)), ms);
  const approval = (key: string, id: string): ApprovalCard | undefined =>
    state.transcripts[key]?.approvals.find((each) => each.id === id);

  // Files are named and counted, never kept.
  const files = new Map<string, { fileName: string; mimeType: string; sizeBytes: number }>();
  // The rail's task actions, answered as the engine would.
  const railRefused = new Set<string>();
  const railRace = { archive: false };
  const railCommand = railCommands(now, railRefused, railRace);
  const machineCommand = machineCommands(now, options.machines ?? NO_MACHINE_PARAMS);
  const memory = memoryCommands(now);
  const routineCommand = routineCommands(now, routineParams);
  let latestAccessRequest = 0;
  async function apply(command: BridgeCommand): Promise<unknown> {
    const checkIn = checkInCommand(command, () => state, set);
    if (checkIn) {
      sent.push(command);
      return checkIn;
    }
    if (
      command.type === "listMemory" ||
      command.type === "readMemory" ||
      command.type === "writeMemory"
    ) {
      sent.push(command);
      if (command.type === "writeMemory" && !state.connection.canAdmin)
        throw new Error("Changing memory requires admin access.");
      return memory(command);
    }
    const routine = routineCommand(command, () => state, set);
    if (routine) {
      sent.push(command);
      return routine;
    }
    const usage = usageCommand(command, () => state, set, usageParams);
    if (usage) {
      sent.push(command);
      return usage;
    }
    // Every access tier shares one upgrade. A delayed answer belongs to the request that started it.
    let setAnswer = set;
    if (command.type === "requestAccess") {
      const request = ++latestAccessRequest;
      setAnswer = (next) => {
        if (request === latestAccessRequest) set(next);
      };
    }
    const machine = machineCommand(command, () => state, setAnswer, deferred);
    if (machine) {
      sent.push(command);
      return machine;
    }
    const account = accountCommand(command, () => state, setAnswer, accountParams, deferred);
    if (account) {
      sent.push(command);
      return account;
    }
    const rail = railCommand(
      command,
      () => state,
      (next) => set(next),
    );
    if (rail) {
      sent.push(command);
      return rail;
    }
    const live = liveCommand(command, () => state, setAnswer, files, deferred);
    sent.push(command);
    if (live) return live;
    if (FILE_COMMANDS.has(command.type)) return fileAnswer(command);
    if (
      setupCommand(
        command,
        () => state,
        set,
        () => loaded(Date.now()),
        (ms, run) => deferred(run, ms),
        setupName === "found-protocol" ? "protocol" : "connected",
      )
    )
      return;
    switch (command.type) {
      case "connect":
      case "connectDevGateway":
        pairingChecks = 0;
        set(withConnection(idle(), { status: "connecting", gatewayUrl: GATEWAY_URL }));
        setTimeout(() => set(pairing()), 400);
        return;
      case "disconnect":
        set(idle());
        return;
      case "suspend":
        set(withConnection(state, { status: "disconnected", retryAt: null, error: null }));
        return;
      case "retry": {
        const { status } = state.connection;
        if (status === "pairing") {
          // "Check now": the first check finds nothing, the next one connects.
          await new Promise((resolve) => setTimeout(resolve, 500));
          pairingChecks += 1;
          if (pairingChecks === 1) set(withConnection(state, { retryAt: Date.now() + 5000 }));
          else set(loaded(Date.now()));
          return;
        }
        if (status === "connected" && state.discovery.status !== "error") return;
        const code = state.connection.error?.code ?? "";
        if (code.startsWith("PAIRING_")) {
          // Trying again sends a new pairing request.
          set(withConnection(idle(), { status: "connecting", gatewayUrl: GATEWAY_URL }));
          setTimeout(() => set(pairing()), 400);
          return;
        }
        if (code === "PROTOCOL_MISMATCH") {
          // The handshake is repeated, and the gateway still speaks another protocol.
          const mismatch = state;
          set(withConnection(state, { status: "connecting", error: null }));
          setTimeout(() => set(mismatch), 400);
          return;
        }
        // An attempt is under way, then the gateway answers; in "offline-down"
        // it still does not, and the next retry is scheduled.
        set(withConnection(state, { status: "reconnecting", retryAt: null, error: null }));
        // The gateway's answer to the attempt is a delayed answer a test can hold.
        if (name === "offline-down") {
          await new Promise<void>((resolve) => deferred(resolve, 300));
          set(withConnection(state, { retryAt: Date.now() + 4000, error: UNREACHABLE }));
          return;
        }
        await new Promise<void>((resolve) => deferred(resolve, 300));
        set(catchingUp(state));
        setTimeout(() => set(caughtUp(state)), 700);
        return;
      }
      case "openSession":
      case "closeSession":
      case "requestAccess":
        return;
      case "resolveApproval": {
        const { key, approvalId, decision } = command;
        const card = approval(key, approvalId);
        if (!card || card.status !== "pending") throw new Error("That approval is no longer open.");
        // As the engine: the same rule for what may leave, and the same numbered attempts.
        const refusal = decisionRefusal(card, decision);
        if (refusal) throw new Error(refusal);
        if (
          decision !== "deny" &&
          card.decisionCut &&
          command.shownDigest !== card.decisionDigest
        ) {
          throw new Error("This approval's text was cut; read it whole before allowing it.");
        }
        let attempt = 0;
        const sent = resolveRequest(card, decision, command.expiresInDays ?? null);
        set(
          inTask(state, key, (a) => {
            const begun = beginDecision(a, approvalId, decision);
            attempt = begun.attempt;
            return noteSent(begun.activity, approvalId, sent);
          }),
        );
        const mode = decision === "deny" ? "apply" : decisions;
        if (mode === "apply") {
          later(400, (s) =>
            inTask(s, key, (a) =>
              endDecision(
                applyApprovalResolved(a, {
                  id: approvalId,
                  status: decision === "deny" ? "denied" : "allowed",
                  decision,
                  reason: "user",
                  resolvedAt: Date.now(),
                  resolvedBy: null,
                  resolver: null,
                  applicationStatus: null,
                  authoritative: true,
                  lossy: false,
                  sessionKey: key,
                  runId: card.runId,
                  // The gateway's reply and its event, as it sends them.
                  records: [
                    { via: sent.method, record: { ok: true } },
                    {
                      via:
                        card.kind === "plugin"
                          ? "plugin.approval.resolved"
                          : "exec.approval.resolved",
                      record: {
                        id: approvalId,
                        decision,
                        resolvedBy: null,
                        ts: Date.now(),
                        request: (card.raw as { request?: unknown } | null)?.request ?? null,
                      },
                    },
                  ],
                }),
                approvalId,
                attempt,
                "answered",
                null,
              ),
            ),
          );
        } else if (mode === "refuse") {
          later(400, (s) =>
            inTask(s, key, (a) =>
              endDecision(
                a,
                approvalId,
                attempt,
                "refused",
                "allow-always is unavailable for this command",
              ),
            ),
          );
          // The read-back the engine sends after a refusal: still pending.
          later(800, (s) => inTask(s, key, (a) => readBack(a, approvalId)));
        } else {
          later(400, (s) =>
            inTask(s, key, (a) =>
              endDecision(
                a,
                approvalId,
                attempt,
                "unknown",
                "The gateway did not answer within 60 seconds.",
              ),
            ),
          );
        }
        return;
      }
      case "checkApproval": {
        // Read back: still pending on the gateway, so the unanswered decision was not applied.
        const { key, approvalId } = command;
        await new Promise((resolve) => setTimeout(resolve, 300));
        set(inTask(state, key, (a) => readBack(a, approvalId)));
        return;
      }
      case "answerQuestion": {
        const { key, questionId } = command;
        const answers = answerStrings(state.transcripts[key], questionId, command.answers);
        set(
          inTask(state, key, (a) =>
            markQuestion(a, questionId, {
              submitting: true,
              error: null,
              sent: {
                method: "question.resolve",
                params: { id: questionId, answers: { answers } },
              },
            }),
          ),
        );
        later(300, (s) =>
          inTask(s, key, (a) =>
            questionEvent({ id: questionId, status: "answered", answers: { answers } })(
              applyQuestionResolved(
                a,
                { id: questionId, status: "answered", answers: { answers } },
                { via: "question.resolve", record: { status: "answered", answers: { answers } } },
              ),
            ),
          ),
        );
        return;
      }
      case "dismissQuestion": {
        const { key, questionId } = command;
        set(
          inTask(state, key, (a) =>
            markQuestion(a, questionId, {
              submitting: true,
              error: null,
              sent: { method: "question.resolve", params: { id: questionId, cancel: true } },
            }),
          ),
        );
        later(300, (s) =>
          inTask(s, key, (a) =>
            questionEvent({ id: questionId, status: "cancelled" })(
              applyQuestionResolved(
                a,
                { id: questionId, status: "cancelled" },
                { via: "question.resolve", record: { status: "cancelled" } },
              ),
            ),
          ),
        );
        return;
      }
    }
  }

  async function answer<C extends BridgeCommand>(command: C): Promise<BridgeResultFor<C>> {
    switch (command.type) {
      case "readApprovalText": {
        const whole = wholeApproval(name, now, command.approvalId);
        if (!whole) throw new Error("That approval is no longer open.");
        return { text: decisionText(whole), digest: whole.decisionDigest } as BridgeResultFor<C>;
      }
      case "readStepRaw": {
        const transcript = state.transcripts[command.key];
        const step = transcript?.runs
          .flatMap((run) => run.steps)
          .find((each) => each.id === command.stepId);
        return (step?.raw ? { status: "available", raw: step.raw } : null) as BridgeResultFor<C>;
      }
      case "readRunRaw": {
        // As the engine answers: the event kept beside the state, or why there is none.
        const run = state.transcripts[command.key]?.runs.find((each) => each.id === command.runId);
        if (!run) return null as BridgeResultFor<C>;
        const raw = run.error?.raw;
        const read: RunRawRead = !raw
          ? { status: "not-kept", holds: null }
          : raw.chars > MAX_RAW_ENTRY_CHARS
            ? {
                status: "too-large",
                holds: raw.holds,
                chars: raw.chars,
                limit: MAX_RAW_ENTRY_CHARS,
              }
            : { status: "available", holds: raw.holds, payload: FAILED_EVENT };
        return read as BridgeResultFor<C>;
      }
      default:
        // The live scenes answer their own commands (takeBackMessage, sendAgain, sendMessage).
        return (await apply(command)) as BridgeResultFor<C>;
    }
  }

  return {
    desktopUpdates: options.desktopUpdates ?? noDesktopUpdates,
    info: setupName
      ? setupInfo(FIXTURE_INFO, setupName)
      : name === "access-pinned"
        ? { ...FIXTURE_INFO, readOnly: true }
        : FIXTURE_INFO,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      startSteps();
      return () => listeners.delete(listener);
    },
    send: async (command) => {
      await apply(command);
    },
    invoke: answer,
    attach: async (file) => {
      const info = {
        id: `file-${files.size + 1}`,
        fileName: file.name,
        mimeType: file.type,
        sizeBytes: file.data.byteLength,
      };
      files.set(info.id, info);
      return info;
    },
    setState: (change) => set(change(state)),
    sent,
    badge: null,
    refuse: (type: string) => void railRefused.add(type),
    raceArchive: () => void (railRace.archive = true),
    hold: timers.hold,
    release: timers.release,
  };
}
