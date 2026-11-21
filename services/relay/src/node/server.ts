// The relay as a Node process, for local development, tests and self-hosting behind something
// that ends TLS. It runs the same room as the Durable Object, one per relay id, over `ws`, and
// keeps the same SQLite tables in `node:sqlite`. It listens on loopback only.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { canonicalRelayOrigin, MAX_FRAME_BYTES } from "@clawtrate/relay-protocol";
import {
  addressText,
  DEFAULT_LIMITS,
  HEALTH_BODY,
  planRequest,
  RelayRoom,
  RelayStore,
  type RelayLimits,
  type RoomClock,
  type RoomSocket,
  type SocketState,
  type SqlDriver,
} from "../core/index.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);

export interface NodeClock extends RoomClock {
  /** Real milliseconds until the room clock reads `at`. */
  delayUntil(at: number): number;
}

export interface RelayServerOptions {
  /** `127.0.0.1` (the default) or `::1`. Nothing else: the Node runner serves this machine only. */
  readonly host?: string;
  /** 0, the default, picks a free port. */
  readonly port?: number;
  /**
   * The origin register proofs must name. Defaults to `ws://<host>:<port>`, accepted only
   * because it is a loopback origin; behind a TLS proxy, the proxy's `wss://` origin.
   */
  readonly origin?: string;
  /** A SQLite file for pins, proof jtis and counts. Without one they are kept in memory. */
  readonly database?: string;
  readonly limits?: Partial<RelayLimits>;
  /** Tests only: the room clock. */
  readonly clock?: NodeClock;
  /** Tests only: the SQL under the store. */
  readonly sql?: SqlDriver;
}

export interface RelayServer {
  /** `ws://host:port`, the base for every socket path. */
  readonly url: string;
  readonly origin: string;
  readonly port: number;
  /**
   * Tests only: drops a room's memory, as a Durable Object loses its own in hibernation. Its
   * sockets stay open and the next event builds the room again from them and the store.
   */
  hibernate(relayId: string): void;
  close(): Promise<void>;
}

export const monotonicClock: NodeClock = {
  now: () => Math.floor(performance.now()),
  wall: () => Date.now(),
  delayUntil: (at) => Math.max(0, at - Math.floor(performance.now())),
};

/** Synchronous SQL over `node:sqlite`, with BEGIN IMMEDIATE transactions. */
export function sqliteDriver(db: DatabaseSync): SqlDriver {
  const statements = new Map<string, StatementSync>();
  const prepare = (query: string) => {
    let statement = statements.get(query);
    if (statement === undefined) {
      statement = db.prepare(query);
      statements.set(query, statement);
    }
    return statement;
  };
  return {
    all: (query, ...params) => prepare(query).all(...(params as SQLInputValue[])),
    transaction: (fn) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

/** The room's view of a `ws` socket: its state is kept beside it, in memory. */
export class NodeSocket implements RoomSocket {
  readonly #ws: WebSocket;
  #state: SocketState | null = null;

  constructor(ws: WebSocket) {
    this.#ws = ws;
  }

  get open(): boolean {
    return this.#ws.readyState === WebSocket.OPEN;
  }

  send(data: string | Uint8Array): void {
    this.#ws.send(data, { binary: typeof data !== "string" });
  }

  close(code: number, reason: string): void {
    this.#ws.close(code, reason);
  }

  terminate(): void {
    this.#ws.terminate();
  }

  load(): SocketState | null {
    return this.#state;
  }

  save(state: SocketState): void {
    this.#state = state;
  }

  autoPongAt(): null {
    return null;
  }

  queuedBytes(): number {
    return this.#ws.bufferedAmount;
  }
}

interface NodeRoom {
  room: RelayRoom;
  readonly sockets: Set<NodeSocket>;
  timer: ReturnType<typeof setTimeout> | null;
}

export async function startRelayServer(options: RelayServerOptions = {}): Promise<RelayServer> {
  const host = options.host ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error("The Node relay listens on 127.0.0.1 or ::1 only.");
  }
  const limits: RelayLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const clock = options.clock ?? monotonicClock;
  const db = options.sql === undefined ? new DatabaseSync(options.database ?? ":memory:") : null;
  const store = new RelayStore(options.sql ?? sqliteDriver(db!));
  const rooms = new Map<string, NodeRoom>();
  const wss = new WebSocketServer({
    noServer: true,
    // Larger messages are refused from their header, before any of them is buffered.
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
    clientTracking: false,
  });

  const http = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://relay.invalid");
    const plan = planRequest(request.method ?? "GET", url.pathname, request.headers.upgrade);
    if (plan.kind === "health") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(request.method === "HEAD" ? undefined : HEALTH_BODY);
      return;
    }
    response.writeHead(plan.kind === "refuse" ? plan.status : 426).end();
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port ?? 0, host, () => resolve());
  });
  const port = (http.address() as AddressInfo).port;
  const url = `ws://${host.includes(":") ? `[${host}]` : host}:${port}`;
  const origin = options.origin ?? url;
  const allowLoopbackWs = origin.toLowerCase().startsWith("ws:");
  try {
    canonicalRelayOrigin(origin, { allowLoopbackWs });
  } catch (error) {
    http.close();
    throw error;
  }

  const newRoom = (relayId: string, sockets: Set<NodeSocket>) =>
    new RelayRoom({
      relayId,
      origin,
      allowLoopbackWs,
      limits,
      clock,
      store,
      sockets: () => sockets,
    });

  const roomFor = (relayId: string): NodeRoom => {
    let room = rooms.get(relayId);
    if (room === undefined) {
      const sockets = new Set<NodeSocket>();
      room = { room: newRoom(relayId, sockets), sockets, timer: null };
      rooms.set(relayId, room);
    }
    return room;
  };

  const schedule = (relayId: string, room: NodeRoom) => {
    if (room.timer !== null) clearTimeout(room.timer);
    room.timer = null;
    if (room.sockets.size === 0) {
      rooms.delete(relayId);
      return;
    }
    const at = room.room.nextDeadline();
    if (at === null) return;
    room.timer = setTimeout(() => {
      room.timer = null;
      room.room.alarm();
      schedule(relayId, room);
    }, clock.delayUntil(at));
  };

  const refuseUpgrade = (socket: Duplex, status: number) => {
    socket.end(`HTTP/1.1 ${status} ${status === 404 ? "Not Found" : "Refused"}\r\n\r\n`);
  };

  http.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "/", "http://relay.invalid");
    const plan = planRequest(request.method ?? "GET", url.pathname, request.headers.upgrade);
    if (plan.kind !== "socket")
      return refuseUpgrade(socket, plan.kind === "refuse" ? plan.status : 426);
    const { route } = plan;
    wss.handleUpgrade(request, socket, head, (ws) => {
      const room = roomFor(route.relayId);
      const relaySocket = new NodeSocket(ws);
      room.sockets.add(relaySocket);
      ws.on("message", (data: RawData, isBinary: boolean) => {
        const payload = isBinary ? toBytes(data) : rawText(data);
        void room.room.message(relaySocket, payload).then(() => schedule(route.relayId, room));
      });
      // An oversize message or a protocol error is followed by `close`.
      ws.on("error", () => {});
      ws.on("close", () => {
        room.sockets.delete(relaySocket);
        room.room.closed(relaySocket);
        schedule(route.relayId, room);
      });
      room.room.connect(relaySocket, route, addressText(request.socket.remoteAddress));
      schedule(route.relayId, room);
    });
  });

  return {
    url,
    origin,
    port,
    hibernate(relayId) {
      const room = rooms.get(relayId);
      if (room !== undefined) room.room = newRoom(relayId, room.sockets);
    },
    async close() {
      for (const room of rooms.values()) {
        if (room.timer !== null) clearTimeout(room.timer);
        for (const socket of room.sockets) socket.terminate();
      }
      rooms.clear();
      wss.close();
      await new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      });
      db?.close();
    },
  };
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function rawText(data: RawData): string {
  return Buffer.from(toBytes(data)).toString("utf8");
}
