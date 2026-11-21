// The relay on Cloudflare Workers: the Worker routes each socket to the Durable Object for its
// relay id, and the object runs the room (`../core/room.ts`) over hibernatable WebSockets.
//
// The object keeps nothing in memory that it cannot rebuild. Each socket's state is its
// WebSocket attachment, written before any await; the relay id's pins, proof jtis and counts
// are in the object's SQLite storage. Relay pings get their pong from the runtime's
// auto-response, without waking the object.

import { DurableObject } from "cloudflare:workers";
import { isRelayId, RELAY_PING, RELAY_PONG } from "@clawtrate/relay-protocol";
import {
  addressText,
  DEFAULT_LIMITS,
  HEALTH_BODY,
  parseRoute,
  planRequest,
  RelayRoom,
  RelayStore,
  type RelayLimits,
  type RoomClock,
  type RoomSocket,
  type SocketState,
  type SqlDriver,
} from "../core/index.ts";

export interface Env {
  readonly RELAY_ROOM: DurableObjectNamespace<RelayRoomObject>;
  /** The relay's public origin, which register proofs must name: `wss://host[:port]`. */
  readonly RELAY_ORIGIN: string;
  /** "1" for local development only: lets RELAY_ORIGIN be a `ws:` loopback origin. */
  readonly RELAY_ALLOW_LOOPBACK_WS?: string;
}

/** Headers the Worker sets on the request it forwards to the object. */
const PATH_HEADER = "x-relay-path";
const FROM_HEADER = "x-relay-from";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const plan = planRequest(request.method, url.pathname, request.headers.get("Upgrade"));
    if (plan.kind === "health") {
      return new Response(request.method === "HEAD" ? null : HEALTH_BODY, {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }
    if (plan.kind === "refuse") return new Response(null, { status: plan.status });
    const room = env.RELAY_ROOM.get(env.RELAY_ROOM.idFromName(plan.route.relayId));
    // Only what the object needs: the path it routes on and the address Cloudflare saw.
    return room.fetch("https://relay.internal/", {
      headers: {
        Upgrade: "websocket",
        [PATH_HEADER]: url.pathname,
        [FROM_HEADER]: addressText(request.headers.get("CF-Connecting-IP")),
      },
    });
  },
} satisfies ExportedHandler<Env>;

/** The room clock in a Durable Object, and its conversions to and from the runtime's Date. */
export interface WorkerClock extends RoomClock {
  /** The room clock's reading for a runtime time (an auto-response's timestamp). */
  fromDate(dateMs: number): number;
  /** The runtime time at which the room clock reads `at`, for the alarm. */
  toDate(at: number): number;
}

export class RelayRoomObject extends DurableObject<Env> {
  #room: RelayRoom | null = null;
  #clock: WorkerClock | null = null;
  /** The alarm this object last set, or null when none is set. Undefined until read. */
  #alarmAt: number | null | undefined = undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(RELAY_PING, RELAY_PONG));
  }

  /** The relay's limits. */
  protected roomLimits(): RelayLimits {
    return DEFAULT_LIMITS;
  }

  /**
   * Workers have no elapsed-time clock that survives hibernation, so the room clock is the
   * runtime's Date, held so that it never reads earlier than any time already saved on a socket
   * or read before: a clock set back stalls the room clock rather than moving it back.
   */
  protected roomClock(): WorkerClock {
    let floor = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const state = ws.deserializeAttachment() as SocketState | null;
      if (state === null) continue;
      floor = Math.max(floor, state.seenAt);
      if (state.role === "control") floor = Math.max(floor, state.reg.issuedAtMs);
      if (state.role === "dial") floor = Math.max(floor, state.since);
    }
    return {
      now: () => (floor = Math.max(floor, Date.now())),
      wall: () => Date.now(),
      fromDate: (dateMs) => dateMs,
      toDate: (at) => at,
    };
  }

  protected roomSql(): SqlDriver {
    const storage = this.ctx.storage;
    return {
      all: (query, ...params) => storage.sql.exec(query, ...params).toArray(),
      transaction: (fn) => storage.transactionSync(fn),
    };
  }

  override async fetch(request: Request): Promise<Response> {
    const route = parseRoute(request.headers.get(PATH_HEADER) ?? "");
    const room = this.#getRoom();
    if (route === null || route.relayId !== this.ctx.id.name) {
      return new Response(null, { status: 404 });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const socket = new NewSocket(server, this.roomSocket(server));
    room.connect(socket, route, request.headers.get(FROM_HEADER) ?? "");
    socket.accept(this.ctx);
    await this.#schedule();
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const data = typeof message === "string" ? message : new Uint8Array(message);
    await this.#getRoom().message(this.roomSocket(ws), data);
    await this.#schedule();
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    this.#getRoom().closed(this.roomSocket(ws));
    // Answer the peer's close, so its side finishes now rather than at a timeout. A code it
    // may not echo becomes 1000.
    try {
      ws.close(code === 1005 || code === 1006 || code === 1015 ? 1000 : code, "");
    } catch {
      // Already answered.
    }
    await this.#schedule();
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.#getRoom().closed(this.roomSocket(ws));
    await this.#schedule();
  }

  override async alarm(): Promise<void> {
    // The alarm that woke the object is spent.
    this.#alarmAt = null;
    this.#getRoom().alarm();
    await this.#schedule();
  }

  #getRoom(): RelayRoom {
    if (this.#room !== null) return this.#room;
    const relayId = this.ctx.id.name;
    if (!isRelayId(relayId)) throw new Error("A relay room is named by its relay id.");
    this.#room = new RelayRoom({
      relayId,
      origin: this.env.RELAY_ORIGIN,
      allowLoopbackWs: this.env.RELAY_ALLOW_LOOPBACK_WS === "1",
      limits: this.roomLimits(),
      clock: this.#getClock(),
      store: new RelayStore(this.roomSql()),
      sockets: () => this.ctx.getWebSockets().map((ws) => this.roomSocket(ws)),
    });
    return this.#room;
  }

  #getClock(): WorkerClock {
    this.#clock ??= this.roomClock();
    return this.#clock;
  }

  /** The room's view of a hibernatable socket: its state is the socket's attachment. */
  protected roomSocket(ws: WebSocket): RoomSocket {
    const ctx = this.ctx;
    const clock = this.#getClock();
    return {
      get open() {
        return ws.readyState === WebSocket.OPEN;
      },
      send: (data) => ws.send(data),
      close: (code, reason) => ws.close(code, reason),
      load: () => (ws.deserializeAttachment() as SocketState | null) ?? null,
      save: (state) => ws.serializeAttachment(state),
      autoPongAt: () => {
        const at = ctx.getWebSocketAutoResponseTimestamp(ws);
        return at === null ? null : clock.fromDate(at.getTime());
      },
      queuedBytes: () => null,
    };
  }

  /**
   * Sets the alarm for the room's next deadline. An alarm already set earlier stays: it wakes
   * the room, which then sets the next one, so activity costs no storage write.
   */
  async #schedule(): Promise<void> {
    const at = this.#getRoom().nextDeadline();
    if (at === null) return;
    const date = this.#getClock().toDate(at);
    if (this.#alarmAt === undefined) this.#alarmAt = await this.ctx.storage.getAlarm();
    if (this.#alarmAt !== null && this.#alarmAt <= date) return;
    await this.ctx.storage.setAlarm(date);
    this.#alarmAt = date;
  }
}

/**
 * A socket the room is deciding on. What the room does to it waits until the decision: a
 * socket the room keeps is then accepted for hibernation, with its state and messages; one it
 * refuses is accepted plainly, sent its error and closed. (A hibernatable socket closed before
 * the upgrade's response leaves the client waiting seconds for the close to finish.)
 */
class NewSocket implements RoomSocket {
  readonly #ws: WebSocket;
  readonly #kept: RoomSocket;
  #accepted = false;
  #state: SocketState | null = null;
  readonly #sent: (string | Uint8Array)[] = [];
  #closed: { readonly code: number; readonly reason: string } | null = null;

  constructor(ws: WebSocket, kept: RoomSocket) {
    this.#ws = ws;
    this.#kept = kept;
  }

  get open(): boolean {
    return this.#accepted ? this.#kept.open : this.#closed === null;
  }

  send(data: string | Uint8Array): void {
    if (this.#accepted) this.#kept.send(data);
    else this.#sent.push(data);
  }

  close(code: number, reason: string): void {
    if (this.#accepted) this.#kept.close(code, reason);
    else this.#closed ??= { code, reason };
  }

  load(): SocketState | null {
    return this.#accepted ? this.#kept.load() : this.#state;
  }

  save(state: SocketState): void {
    if (this.#accepted) this.#kept.save(state);
    else this.#state = state;
  }

  autoPongAt(): number | null {
    return this.#accepted ? this.#kept.autoPongAt() : null;
  }

  queuedBytes(): null {
    return null;
  }

  /** Carries out the room's decision. Later calls go straight to the accepted socket. */
  accept(ctx: DurableObjectState): void {
    const closed = this.#closed;
    if (closed === null) {
      ctx.acceptWebSocket(this.#ws);
      if (this.#state !== null) this.#ws.serializeAttachment(this.#state);
    } else {
      this.#ws.accept();
    }
    this.#accepted = true;
    for (const data of this.#sent.splice(0)) this.#ws.send(data);
    if (closed !== null) this.#ws.close(closed.code, closed.reason);
  }
}
