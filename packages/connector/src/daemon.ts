// The running connector (`clawtrate-connector run`): the supervised control socket, one
// RelaySession per dial, and a status file the `status` command reads.

import { ReceiveBudget, toBase64Url } from "@clawtrate/relay-protocol";
import { Allowlist } from "./allowlist.ts";
import { loadConfig, loadKeys, type ConnectorConfig, type ConnectorKeys } from "./config.ts";
import { openControl } from "./control.ts";
import { RelaySession, type OpenSocket } from "./session.ts";
import { millisField, objectWithKeys, stringField, versionOne, type StateDir } from "./state.ts";
import {
  Supervisor,
  type ControlLink,
  type LinkEvents,
  type SupervisorState,
} from "./supervisor.ts";

export const STATUS_FILE = "status.json";
/** The relay allows 8 sessions per relay id; the connector holds no more. */
export const MAX_SESSIONS = 8;
/** Text buffered across every session for messages still arriving. */
export const RECEIVE_BUDGET_BYTES = 64 * 1024 * 1024;
/** How often the status file is rewritten while nothing changes, and when it counts as stale. */
export const HEARTBEAT_MS = 30_000;
export const STATUS_STALE_MS = 3 * HEARTBEAT_MS;
/** How often live sessions are checked against the allowlist, so a removed phone is cut off. */
export const ALLOWLIST_SWEEP_MS = 5_000;

export interface RunStatus {
  readonly pid: number;
  readonly startedAtMs: number;
  readonly updatedAtMs: number;
  readonly state: SupervisorState;
  readonly relayId: string;
  readonly sessions: number;
  readonly lastExit: string | null;
}

export function parseStatus(value: unknown): RunStatus {
  const record = objectWithKeys(value, [
    "v",
    "pid",
    "startedAtMs",
    "updatedAtMs",
    "state",
    "relayId",
    "sessions",
    "lastExit",
  ]);
  versionOne(record);
  const state = stringField(record, "state");
  if (!["stopped", "connecting", "registered", "waiting"].includes(state))
    throw new Error("bad state");
  if (record.lastExit !== null && typeof record.lastExit !== "string")
    throw new Error("bad lastExit");
  return {
    pid: millisField(record, "pid"),
    startedAtMs: millisField(record, "startedAtMs"),
    updatedAtMs: millisField(record, "updatedAtMs"),
    state: state as SupervisorState,
    relayId: stringField(record, "relayId"),
    sessions: millisField(record, "sessions"),
    lastExit: record.lastExit as string | null,
  };
}

export interface DaemonOptions {
  readonly state: StateDir;
  readonly log?: (message: string) => void;
  /** Tests only. */
  readonly openSocket?: OpenSocket;
  /** Tests only: how a control link is opened. */
  readonly connect?: (
    config: ConnectorConfig,
    keys: ConnectorKeys,
    events: LinkEvents & { dial(session: string, from: string): void },
  ) => ControlLink;
}

export class ConnectorDaemon {
  readonly #options: DaemonOptions;
  readonly #config: ConnectorConfig;
  readonly #keys: ConnectorKeys;
  readonly #allowlist: Allowlist;
  readonly #budget = new ReceiveBudget(RECEIVE_BUDGET_BYTES);
  readonly #sessions = new Map<string, RelaySession>();
  readonly #supervisor: Supervisor<ConnectorConfig>;
  readonly #startedAtMs = Date.now();
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #sweep: ReturnType<typeof setInterval> | null = null;

  constructor(options: DaemonOptions) {
    this.#options = options;
    this.#config = loadConfig(options.state);
    this.#keys = loadKeys(options.state);
    this.#allowlist = new Allowlist(options.state);
    const log = options.log ?? (() => {});
    const connect = options.connect ?? defaultConnect(log);
    this.#supervisor = new Supervisor<ConnectorConfig>({
      connect: (config, events) =>
        connect(config, this.#keys, {
          ...events,
          dial: (session, from) => this.#dial(session, from),
        }),
      configKey: (config) => `${config.relayOrigin} ${config.gatewayPort}`,
      onChange: () => this.#writeStatus(),
      log,
    });
  }

  get relayId(): string {
    return this.#keys.relayId;
  }

  get sessions(): ReadonlyMap<string, RelaySession> {
    return this.#sessions;
  }

  get supervisorState(): SupervisorState {
    return this.#supervisor.status.state;
  }

  start(): void {
    this.#supervisor.applyConfig(this.#config);
    this.#heartbeat = setInterval(() => this.#writeStatus(), HEARTBEAT_MS);
    this.#sweep = setInterval(() => this.#sweepRemoved(), ALLOWLIST_SWEEP_MS);
  }

  stop(): void {
    if (this.#heartbeat !== null) clearInterval(this.#heartbeat);
    if (this.#sweep !== null) clearInterval(this.#sweep);
    this.#supervisor.stop();
    for (const session of [...this.#sessions.values()]) session.end("stopping");
    this.#writeStatus();
  }

  #dial(session: string, from: string): void {
    if (this.#sessions.has(session) || this.#sessions.size >= MAX_SESSIONS) return;
    const log = this.#options.log;
    const relaySession = new RelaySession({
      relayOrigin: this.#config.relayOrigin,
      relayId: this.#keys.relayId,
      session,
      from,
      staticKey: this.#keys.noise,
      gate: this.#allowlist,
      gatewayPort: this.#config.gatewayPort,
      budget: this.#budget,
      ...(this.#options.openSocket ? { openSocket: this.#options.openSocket } : {}),
      ...(log ? { log } : {}),
      onEnd: (ended, reason) => {
        if (this.#sessions.get(ended.id) === ended) this.#sessions.delete(ended.id);
        log?.(`Session ${ended.id.slice(0, 6)} ended: ${reason}`);
        this.#writeStatus();
      },
    });
    this.#sessions.set(session, relaySession);
    this.#writeStatus();
  }

  /** Ends sessions whose phone `remove-phone` took off the allowlist. */
  #sweepRemoved(): void {
    for (const session of [...this.#sessions.values()]) {
      const key = session.phoneKey;
      if (key === null) continue;
      let enrolled: boolean;
      try {
        enrolled = this.#allowlist.isEnrolled(key);
      } catch {
        enrolled = false; // An allowlist that cannot be read admits nobody.
      }
      if (!enrolled) {
        this.#options.log?.(
          `Phone ${toBase64Url(key).slice(0, 8)} was removed; ending its session.`,
        );
        session.end("phone_removed");
      }
    }
  }

  #writeStatus(): void {
    const status = this.#supervisor?.status;
    if (status === undefined) return;
    try {
      this.#options.state.write(STATUS_FILE, {
        v: 1,
        pid: process.pid,
        startedAtMs: this.#startedAtMs,
        updatedAtMs: Date.now(),
        state: status.state,
        relayId: this.#keys.relayId,
        sessions: this.#sessions.size,
        lastExit: status.lastExit,
      });
    } catch (error) {
      this.#options.log?.(`Could not write the status file: ${(error as Error).message}`);
    }
  }
}

function defaultConnect(log: (message: string) => void): NonNullable<DaemonOptions["connect"]> {
  return (config, keys, events) =>
    openControl({
      relayOrigin: config.relayOrigin,
      relayId: keys.relayId,
      registrationSecret: keys.registrationSecret,
      events,
      log,
    });
}
