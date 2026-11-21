// Starts the relay on either runtime and talks to it the way a connector and a phone do.
//
// - `node`: the Node runner, `startRelayServer`, on 127.0.0.1.
// - `worker`: the Worker and its Durable Object in Miniflare, through Wrangler's local test
//   harness (`wrangler dev --local`'s runtime), on 127.0.0.1. Nothing reaches Cloudflare.

import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createRegisterProof,
  RELAY_PING,
  RELAY_PONG,
  relayIdFromKey,
  toBase64Url,
  type RelayToConnector,
} from "@clawtrate/relay-protocol";
import type { RelayLimits } from "../src/core/index.ts";
import { sqliteDriver, startRelayServer } from "../src/node/server.ts";
import { faultySql, warpedClock, type Fault } from "./fixtures/faults.ts";

export type RuntimeName = "node" | "worker";
export const RUNTIMES: readonly RuntimeName[] = ["node", "worker"];

export interface RelayOptions {
  readonly limits?: Partial<RelayLimits>;
  /** Runs the room clock this many times faster than real time. */
  readonly warp?: number;
  readonly fault?: Fault;
}

export interface Relay {
  readonly runtime: RuntimeName;
  /** `ws://127.0.0.1:<port>` */
  readonly url: string;
  /** The origin register proofs name. */
  readonly origin: string;
  /** The real milliseconds a room-clock duration takes. */
  real(roomMs: number): number;
  /** Pins a relay id to a key, as if that key had registered it first. */
  pin(relayId: string, publicKey: Uint8Array): Promise<void>;
  /** Drops the room's memory, as hibernation does; its sockets stay open. */
  hibernate(relayId: string): Promise<void>;
  close(): Promise<void>;
}

const ROOT = join(import.meta.dirname, "..");
const PIN_SQL = "INSERT INTO relay_pins (relay_id, public_key) VALUES (?, ?)";
const PIN_TABLE =
  "CREATE TABLE IF NOT EXISTS relay_pins (relay_id TEXT PRIMARY KEY, public_key TEXT NOT NULL)";

export async function startRelay(runtime: RuntimeName, options: RelayOptions = {}): Promise<Relay> {
  return runtime === "node" ? startNode(options) : startWorker(options);
}

async function startNode(options: RelayOptions): Promise<Relay> {
  const factor = options.warp ?? 1;
  const db = new DatabaseSync(":memory:");
  const driver = sqliteDriver(db);
  const server = await startRelayServer({
    sql: options.fault === undefined ? driver : faultySql(driver, options.fault),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(factor === 1 ? {} : { clock: warpedClock(Date.now(), factor) }),
  });
  return {
    runtime: "node",
    url: server.url,
    origin: server.origin,
    real: (roomMs) => roomMs / factor,
    pin: async (relayId, publicKey) => {
      driver.all(PIN_SQL, relayId, toBase64Url(publicKey));
    },
    hibernate: async (relayId) => server.hibernate(relayId),
    close: async () => {
      await server.close();
      db.close();
    },
  };
}

async function startWorker(options: RelayOptions): Promise<Relay> {
  process.env.WRANGLER_SEND_METRICS = "false";
  const { createTestHarness } = await import("wrangler");
  const factor = options.warp ?? 1;
  // Any loopback origin will do: the connector stand-in signs the one the relay is given.
  const origin = "ws://127.0.0.1:8787";
  const vars: Record<string, string> = {
    RELAY_ORIGIN: origin,
    RELAY_ALLOW_LOOPBACK_WS: "1",
    TEST_LIMITS: JSON.stringify(options.limits ?? {}),
    TEST_WARP: String(factor),
    TEST_EPOCH: String(Date.now()),
  };
  if (options.fault !== undefined) vars.TEST_FAULT = options.fault;
  const server = createTestHarness({
    root: ROOT,
    workers: [
      {
        config: {
          name: "clawtrate-relay-test",
          main: "./test/fixtures/worker.ts",
          compatibility_date: "2026-11-01",
          vars,
          durable_objects: { bindings: [{ name: "RELAY_ROOM", class_name: "RelayRoomObject" }] },
          migrations: [{ tag: "v1", new_sqlite_classes: ["RelayRoomObject"] }],
        },
      },
    ],
  });
  const { url } = await server.listen();
  if (url.hostname !== "127.0.0.1") throw new Error(`The harness is on ${url.hostname}.`);
  const worker = server.getWorker();
  return {
    runtime: "worker",
    url: `ws://${url.host}`,
    origin,
    real: (roomMs) => roomMs / factor,
    pin: async (relayId, publicKey) => {
      const storage = await worker.getDurableObjectStorage("RelayRoomObject", { name: relayId });
      await storage.exec(PIN_TABLE);
      await storage.exec(PIN_SQL, relayId, toBase64Url(publicKey));
    },
    hibernate: (relayId) =>
      worker.evictDurableObject("RelayRoomObject", { name: relayId, webSockets: "hibernate" }),
    close: () => server.close(),
  };
}

export type Received = string | Uint8Array;

/** A WebSocket client that queues what it receives, for tests to take in order. */
export class TestSocket {
  readonly ws: WebSocket;
  readonly closed: Promise<{ code: number; reason: string }>;
  readonly #queue: Received[] = [];
  readonly #waiters: ((message: Received | null) => void)[] = [];
  #ended = false;
  #greeting = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    ws.addEventListener("message", (event) => {
      const data = event.data as string | ArrayBuffer;
      this.#push(typeof data === "string" ? data : new Uint8Array(data));
    });
    this.closed = new Promise((resolve) => {
      ws.addEventListener("close", (event) => {
        this.#ended = true;
        for (const waiter of this.#waiters.splice(0)) waiter(null);
        resolve({ code: event.code, reason: event.reason });
      });
    });
  }

  /**
   * Opens a socket. Like the connector and the phone, it sends a relay ping as soon as it is
   * open (the relay's README says why) and drops the pong; `greet: false` keeps it silent.
   */
  static open(url: string, options: { greet?: boolean } = {}): Promise<TestSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const socket = new TestSocket(ws);
      ws.addEventListener(
        "open",
        () => {
          if (options.greet !== false) {
            socket.#greeting = true;
            ws.send(RELAY_PING);
          }
          resolve(socket);
        },
        { once: true },
      );
      ws.addEventListener("error", () => reject(new Error(`Could not open ${url}.`)), {
        once: true,
      });
    });
  }

  /** The next message, or null once the socket has closed with nothing left. */
  next(timeoutMs = 5_000): Promise<Received | null> {
    const queued = this.#queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.#ended) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.#waiters.indexOf(done);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new Error("Nothing arrived in time."));
      }, timeoutMs);
      const done = (message: Received | null) => {
        clearTimeout(timer);
        resolve(message);
      };
      this.#waiters.push(done);
    });
  }

  /** The next message, which must be a relay message (text). */
  async json(timeoutMs?: number): Promise<Record<string, unknown>> {
    const message = await this.next(timeoutMs);
    if (typeof message !== "string") throw new Error(`Expected text, got ${String(message)}.`);
    return JSON.parse(message) as Record<string, unknown>;
  }

  async bytes(timeoutMs?: number): Promise<Uint8Array> {
    const message = await this.next(timeoutMs);
    if (!(message instanceof Uint8Array))
      throw new Error(`Expected bytes, got ${String(message)}.`);
    return message;
  }

  /** Waits for the relay's error and the close that follows it. */
  async refused(timeoutMs?: number): Promise<{ error: unknown; code: number }> {
    const message = await this.json(timeoutMs);
    const { code } = await this.closed;
    return { error: message.t === "error" ? message.code : message, code };
  }

  send(data: string | Uint8Array): void {
    this.ws.send(typeof data === "string" ? data : Uint8Array.from(data));
  }

  close(): void {
    this.ws.close();
  }

  #push(message: Received): void {
    if (this.#greeting && message === RELAY_PONG) {
      this.#greeting = false;
      return;
    }
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#queue.push(message);
    else waiter(message);
  }
}

export interface ConnectorKey {
  readonly secretKey: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly relayId: string;
}

/** A fresh Ed25519 registration key, and so a fresh relay id. */
export function connectorKey(): ConnectorKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const secretKey = Buffer.from(privateKey.export({ format: "jwk" }).d!, "base64url");
  const rawPublic = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  return {
    secretKey: new Uint8Array(secretKey),
    publicKey: new Uint8Array(rawPublic),
    relayId: relayIdFromKey(new Uint8Array(rawPublic)),
  };
}

/** Opens a control socket and reads its challenge nonce. */
export async function openControl(
  relay: Relay,
  relayId: string,
  options: { greet?: boolean } = {},
): Promise<{ socket: TestSocket; nonce: string }> {
  const socket = await TestSocket.open(`${relay.url}/v1/connector/${relayId}`, options);
  const challenge = await socket.json();
  if (challenge.t !== "challenge" || typeof challenge.nonce !== "string") {
    throw new Error(`Expected a challenge, got ${JSON.stringify(challenge)}.`);
  }
  return { socket, nonce: challenge.nonce };
}

export function proofFor(
  relay: Relay,
  key: ConnectorKey,
  nonce: string,
  overrides: { audience?: string; nowMs?: number } = {},
): string {
  return createRegisterProof({
    secretKey: key.secretKey,
    audience: overrides.audience ?? relay.origin,
    nonce,
    nowMs: overrides.nowMs ?? Date.now(),
    allowLoopbackWs: true,
  });
}

/** A connector stand-in: opens its control socket and registers. */
export async function registerConnector(
  relay: Relay,
  key: ConnectorKey = connectorKey(),
): Promise<{ control: TestSocket; key: ConnectorKey }> {
  const { socket, nonce } = await openControl(relay, key.relayId);
  socket.send(JSON.stringify({ t: "register", proof: proofFor(relay, key, nonce) }));
  const answer = await socket.json();
  if (answer.t !== "registered")
    throw new Error(`Expected registered, got ${JSON.stringify(answer)}.`);
  return { control: socket, key };
}

/** A phone stand-in dials, and the connector stand-in opens the session socket. */
export async function splice(
  relay: Relay,
  control: TestSocket,
  relayId: string,
): Promise<{ phone: TestSocket; session: TestSocket; dial: RelayToConnector }> {
  const phone = await TestSocket.open(`${relay.url}/v1/dial/${relayId}`);
  const dial = (await control.json()) as RelayToConnector;
  if (dial.t !== "dial") throw new Error(`Expected dial, got ${JSON.stringify(dial)}.`);
  const session = await TestSocket.open(`${relay.url}/v1/session/${relayId}/${dial.session}`);
  for (const socket of [phone, session]) {
    const open = await socket.json();
    if (open.t !== "open") throw new Error(`Expected open, got ${JSON.stringify(open)}.`);
  }
  return { phone, session, dial };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function bytesOf(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}
