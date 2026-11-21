// Stand-ins for the connector's tests: a state folder in a temporary directory, a gateway that
// records every upgrade it is asked for, and a phone speaking the protocol package's initiator.

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocket } from "ws";
import { WebSocketServer, type RawData } from "ws";
import {
  generateKeyPair,
  Initiator,
  RELAY_PING,
  RELAY_PONG,
  type ChannelEvent,
  type KeyPair,
} from "@clawtrate/relay-protocol";
import { CONFIG_FILE, KEYS_FILE, newKeys, serializeConfig, loadKeys } from "../src/config.ts";
import { StateDir } from "../src/state.ts";

/** A temporary parent folder, removed by `cleanup`. The state folder is made inside it. */
export function tempRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "clawtrate-connector-test-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A set-up state folder: keys and settings, as `setup` leaves them. */
export function setUpState(root: string, relayOrigin: string, gatewayPort: number): StateDir {
  const state = StateDir.create(join(root, "state"));
  state.write(KEYS_FILE, newKeys());
  state.write(
    CONFIG_FILE,
    serializeConfig({
      relayOrigin,
      gatewayPort,
      openclaw: { bin: "openclaw-stand-in", profile: null },
    }),
  );
  return state;
}

export function keysOf(state: StateDir) {
  return loadKeys(state);
}

export async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

export function waitFor(what: string, test: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (test()) return resolve();
      if (Date.now() > end) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

/**
 * A gateway stand-in: records each upgrade's headers and every text message, and answers each
 * message with `reply(text)` when given.
 */
export class FakeGateway {
  readonly upgrades: IncomingHttpHeaders[] = [];
  readonly received: string[] = [];
  readonly sockets: WebSocket[] = [];
  /** TCP connections, whether or not they asked for an upgrade. */
  connections = 0;
  reply: ((text: string) => string | null) | null = null;
  readonly #server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  readonly #wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  port = 0;

  async start(): Promise<this> {
    this.#server.on("connection", () => this.connections++);
    this.#server.on("upgrade", (request, socket, head) => {
      this.upgrades.push(request.headers);
      this.#wss.handleUpgrade(request, socket, head, (ws) => {
        this.sockets.push(ws);
        ws.on("message", (data: RawData) => {
          const text = data.toString();
          this.received.push(text);
          const answer = this.reply?.(text);
          if (answer != null) ws.send(answer);
        });
      });
    });
    this.port = await listen(this.#server);
    return this;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.terminate();
    this.#wss.close();
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}

/** A phone: the protocol's initiator over a WebSocket the test gives it. */
export class Phone {
  readonly key: KeyPair;
  readonly channel: Initiator;
  readonly texts: string[] = [];
  readonly events: ChannelEvent[] = [];
  readonly relayMessages: string[] = [];
  socket: WebSocket | null = null;
  closed = false;

  constructor(input: {
    relayId: string;
    connectorKey: Uint8Array;
    enroll?: Uint8Array;
    key?: KeyPair;
  }) {
    this.key = input.key ?? generateKeyPair();
    this.channel = new Initiator({
      relayId: input.relayId,
      connectorKey: input.connectorKey,
      staticKey: this.key,
      ...(input.enroll ? { enroll: input.enroll } : {}),
    });
  }

  /** Attaches to a socket already spliced to the connector and sends handshake message 1. */
  attach(socket: WebSocket): void {
    this.socket = socket;
    socket.on("message", (data: RawData, isBinary: boolean) => {
      if (!isBinary) {
        const text = data.toString();
        this.relayMessages.push(text);
        if (text === RELAY_PING) socket.send(RELAY_PONG);
        return;
      }
      if (this.channel.currentState === "closed" || this.channel.currentState === "failed") return;
      const events = this.channel.receive(new Uint8Array(data as Buffer));
      for (const event of events) {
        this.events.push(event);
        if (event.type === "send") socket.send(event.frame);
        if (event.type === "text") this.texts.push(event.text);
      }
    });
    socket.on("close", () => (this.closed = true));
  }

  start(): void {
    this.socket!.send(this.channel.start());
  }

  get opened(): boolean {
    return this.events.some((event) => event.type === "open");
  }

  refusal(): string | null {
    const refused = this.events.find((event) => event.type === "refused");
    return refused?.type === "refused" ? refused.reason : null;
  }

  send(text: string): void {
    for (const frame of this.channel.sendText(text)) this.socket!.send(frame);
  }
}

/**
 * A relay stand-in for one session: accepts the connector's session socket, says `open`, and
 * hands the socket to the test as the phone's end.
 */
export class FakeSessionRelay {
  readonly #server = createServer();
  readonly #wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  readonly paths: string[] = [];
  readonly sessions: WebSocket[] = [];
  port = 0;

  async start(): Promise<this> {
    this.#server.on("upgrade", (request, socket, head) => {
      this.paths.push(request.url ?? "");
      this.#wss.handleUpgrade(request, socket, head, (ws) => {
        this.sessions.push(ws);
        ws.on("message", (data: RawData, isBinary: boolean) => {
          if (!isBinary && data.toString() === RELAY_PING) ws.send(RELAY_PONG);
        });
        ws.send('{"t":"open"}');
      });
    });
    this.port = await listen(this.#server);
    return this;
  }

  get origin(): string {
    return `ws://127.0.0.1:${this.port}`;
  }

  async close(): Promise<void> {
    for (const socket of this.sessions) socket.terminate();
    this.#wss.close();
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}
