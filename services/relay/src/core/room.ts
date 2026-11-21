// One relay id's sockets and what the relay does with them: the connector's control socket and
// its registration, phones' dials, the connector's session sockets, and the splice between a
// dial and its session. The Durable Object and the Node runner both drive this class.
//
// Nothing here lives only in memory except a registration that is waiting on its stores. Each
// socket's state, its registration's included (`SocketRegistrationStore`), is saved on the
// socket (a Durable Object's WebSocket attachment, which survives hibernation), and the relay
// id's durable state is in `RelayStore`. A room built afresh over
// the same sockets and store, as a Durable Object is after hibernation, carries on where the
// last one stopped.
//
// Binary messages are forwarded unchanged. The relay reads their size, never their contents.

import {
  ControlRegistration,
  createSessionId,
  decodeConnectorToRelay,
  decodeEndpointToRelay,
  encodeRelayMessage,
  MAX_FRAME_BYTES,
  REGISTER_CHALLENGE_MS,
  RELAY_PONG,
  type RegistrationSnapshot,
  type RelayErrorCode,
} from "@clawtrate/relay-protocol";
import { addressRateKey } from "./address.ts";
import type { RelayLimits } from "./limits.ts";
import { SocketRegistrationStore } from "./registration-store.ts";
import type { Route } from "./routes.ts";
import type { RoomStore } from "./store.ts";

export interface ControlState {
  readonly role: "control";
  readonly id: string;
  readonly reg: RegistrationSnapshot;
  readonly seenAt: number;
}

export interface DialState {
  readonly role: "dial";
  readonly id: string;
  readonly session: string;
  /** The phone's address as the relay saw it, or empty. */
  readonly from: string;
  /** True once the connector's session socket is spliced to it. */
  readonly open: boolean;
  readonly since: number;
  readonly seenAt: number;
  /** Bytes this socket sent into the relay. */
  readonly bytes: number;
}

export interface SessionState {
  readonly role: "session";
  readonly id: string;
  readonly session: string;
  readonly seenAt: number;
  readonly bytes: number;
}

export type SocketState = ControlState | DialState | SessionState;

/** One WebSocket as the room sees it. Hosts may hand out a new wrapper for each event. */
export interface RoomSocket {
  readonly open: boolean;
  send(data: string | Uint8Array): void;
  close(code: number, reason: string): void;
  load(): SocketState | null;
  save(state: SocketState): void;
  /** When the runtime last answered a relay ping for this socket without the room, or null. */
  autoPongAt(): number | null;
  /** Bytes waiting to be written to this socket, or null where the runtime does not say. */
  queuedBytes(): number | null;
}

export interface RoomClock {
  /**
   * Elapsed whole milliseconds, never set back, on a relay that hibernates one that survives
   * hibernation. Every deadline is on this clock.
   */
  now(): number;
  /** Wall-clock milliseconds since the epoch, for the register proof's `iat`. */
  wall(): number;
}

export interface RoomOptions {
  readonly relayId: string;
  /** The relay's configured origin, which register proofs must name. */
  readonly origin: string;
  /** Tests and local development only: accept a `ws:` loopback origin. */
  readonly allowLoopbackWs: boolean;
  readonly limits: RelayLimits;
  readonly clock: RoomClock;
  readonly store: RoomStore;
  /** The room's sockets. Those that are no longer open, or have no state yet, are skipped. */
  readonly sockets: () => Iterable<RoomSocket>;
}

/** The close code sent with each error; the error message itself carries the reason. */
const CLOSE_CODES: Record<RelayErrorCode, number> = {
  bad_message: 1008,
  bad_proof: 1008,
  replaced: 1000,
  connector_offline: 1008,
  rate_limited: 1008,
  session_limit: 1008,
  dial_timeout: 1000,
  peer_gone: 1000,
  frame_too_large: 1009,
  idle_timeout: 1000,
  internal: 1011,
};

interface Entry<S extends SocketState = SocketState> {
  readonly socket: RoomSocket;
  readonly state: S;
}

export class RelayRoom {
  readonly #options: RoomOptions;
  /** Registrations in memory, by socket id: only while one is challenged or waiting on a store. */
  readonly #registrations = new Map<string, ControlRegistration>();

  constructor(options: RoomOptions) {
    this.#options = options;
  }

  /** A socket the host has just accepted on `route`. `from` is the address the runtime saw. */
  connect(socket: RoomSocket, route: Route, from: string): void {
    try {
      if (route.role === "control") this.#connectControl(socket);
      else if (route.role === "dial") this.#connectDial(socket, from);
      else this.#connectSession(socket, route.session);
    } catch {
      this.#refuse(socket, "internal");
    }
  }

  /**
   * A text or binary message from a socket. One that arrives while a close the room started
   * finishes is ignored: a socket the room closed is discarded, and its record, whatever it
   * says, is never acted on again.
   */
  async message(socket: RoomSocket, data: string | Uint8Array): Promise<void> {
    if (!socket.open) return;
    const state = socket.load();
    if (state === null) return this.#refuse(socket, "internal");
    try {
      if (typeof data === "string") await this.#text(socket, state, data);
      else this.#binary(socket, state, data);
    } catch {
      this.#end(socket, "internal");
    }
  }

  /** A socket the runtime reports closed. */
  closed(socket: RoomSocket): void {
    const state = socket.load();
    if (state !== null) this.#cascade(state, "peer_gone");
  }

  /** Ends whatever has passed its deadline. The host calls it at `nextDeadline()`. */
  alarm(): void {
    const { limits } = this.#options;
    const now = this.#now();
    for (const { socket } of this.#entries()) {
      // An earlier socket in this pass may have ended this one or changed it.
      const state = socket.open ? socket.load() : null;
      if (state === null) continue;
      if (state.role === "control") {
        if (state.reg.state === "registered") {
          if (now - this.#lastActive(socket, state) > limits.idleMs) {
            this.#end(socket, "idle_timeout");
          }
        } else if (state.reg.state === "failed") {
          this.#end(socket, "bad_proof");
        } else {
          const registration = this.#registration(socket, state);
          if (registration.state === "failed") this.#end(socket, "internal");
          else if (registration.expire()) this.#end(socket, "idle_timeout");
        }
      } else if (state.role === "dial" && !state.open) {
        if (now - state.since > limits.dialTimeoutMs) this.#end(socket, "dial_timeout");
      } else if (state.role === "dial") {
        const peer = this.#peer(state);
        if (peer === null) this.#end(socket, "peer_gone");
        else if (now - this.#sessionActive({ socket, state }, peer) > limits.idleMs) {
          this.#end(socket, "idle_timeout", "idle_timeout");
        }
      } else if (this.#peer(state) === null) {
        this.#end(socket, "peer_gone");
      }
    }
  }

  /** The room clock's reading at which `alarm()` next has something to end, or null. */
  nextDeadline(): number | null {
    const { limits } = this.#options;
    let next: number | null = null;
    const at = (deadline: number) => {
      next = next === null ? deadline : Math.min(next, deadline);
    };
    for (const entry of this.#entries()) {
      const { socket, state } = entry;
      if (state.role === "control") {
        if (state.reg.state === "registered")
          at(this.#lastActive(socket, state) + limits.idleMs + 1);
        else if (state.reg.state === "failed") at(this.#now());
        else at(state.reg.issuedAtMs + REGISTER_CHALLENGE_MS + 1);
      } else if (state.role === "dial") {
        if (!state.open) at(state.since + limits.dialTimeoutMs + 1);
        else {
          const peer = this.#peer(state);
          at(peer === null ? this.#now() : this.#sessionActive(entry, peer) + limits.idleMs + 1);
        }
      }
    }
    return next;
  }

  #connectControl(socket: RoomSocket): void {
    const { limits } = this.#options;
    const now = this.#now();
    if (!this.#hit("control", now, limits.controlConnectsPerMinute)) {
      return this.#refuse(socket, "rate_limited");
    }
    const pending = this.#entries().filter(
      ({ state }) => state.role === "control" && isPending(state.reg),
    ).length;
    if (pending >= limits.maxPendingControls) return this.#refuse(socket, "rate_limited");
    const id = createSessionId();
    const registration = this.#newRegistration(socket, id);
    socket.save({ role: "control", id, reg: registration.snapshot(), seenAt: now });
    this.#registrations.set(id, registration);
    socket.send(registration.challengeMessage);
  }

  #connectDial(socket: RoomSocket, from: string): void {
    const { limits } = this.#options;
    const now = this.#now();
    if (
      !this.#hit("dial", now, limits.dialsPerMinute) ||
      !this.#hit(`dial ${addressRateKey(from)}`, now, limits.dialsPerMinutePerAddress)
    ) {
      return this.#refuse(socket, "rate_limited");
    }
    const control = this.#registeredControl();
    if (control === null) return this.#refuse(socket, "connector_offline");
    const sessions = this.#entries().filter(({ state }) => state.role === "dial").length;
    if (sessions >= limits.maxSessions) return this.#refuse(socket, "session_limit");
    const session = createSessionId();
    socket.save({
      role: "dial",
      id: createSessionId(),
      session,
      from,
      open: false,
      since: now,
      seenAt: now,
      bytes: 0,
    });
    control.socket.send(encodeRelayMessage({ t: "dial", session, from }));
  }

  #connectSession(socket: RoomSocket, session: string): void {
    const { limits } = this.#options;
    const now = this.#now();
    if (!this.#hit("session", now, limits.dialsPerMinute)) {
      return this.#refuse(socket, "rate_limited");
    }
    const dial = this.#entries().find(
      (entry): entry is Entry<DialState> =>
        entry.state.role === "dial" && entry.state.session === session && !entry.state.open,
    );
    if (dial === undefined) return this.#refuse(socket, "peer_gone");
    socket.save({ role: "session", id: createSessionId(), session, seenAt: now, bytes: 0 });
    dial.socket.save({ ...dial.state, open: true, seenAt: now });
    const open = encodeRelayMessage({ t: "open" });
    dial.socket.send(open);
    socket.send(open);
  }

  async #text(socket: RoomSocket, state: SocketState, text: string): Promise<void> {
    const now = this.#now();
    if (state.role === "control") {
      let message;
      try {
        message = decodeConnectorToRelay(text);
      } catch {
        return this.#end(socket, "bad_message");
      }
      const touched: ControlState = { ...state, seenAt: now };
      socket.save(touched);
      if (message.t === "ping") socket.send(RELAY_PONG);
      else if (message.t === "register") await this.#register(socket, touched, message.proof);
      return;
    }
    let message;
    try {
      message = decodeEndpointToRelay(text);
    } catch {
      return this.#end(socket, "bad_message");
    }
    socket.save({ ...state, seenAt: now });
    if (message.t === "ping") socket.send(RELAY_PONG);
  }

  async #register(socket: RoomSocket, state: ControlState, proof: string): Promise<void> {
    const registration = this.#registration(socket, state);
    const result = await registration.register(proof);
    if (this.#registrations.get(state.id) === registration) this.#registrations.delete(state.id);
    if (!socket.open) return;
    if (!result.ok) {
      if (result.code === "aborted") return;
      const code: RelayErrorCode =
        result.code === "store_failed" || result.code === "bad_clock"
          ? "internal"
          : result.code === "challenge_expired"
            ? "idle_timeout"
            : "bad_proof";
      return this.#end(socket, code);
    }
    // The new registration is in place before the old one goes.
    for (const other of this.#entries()) {
      if (
        other.state.role === "control" &&
        other.state.id !== state.id &&
        other.state.reg.state === "registered"
      ) {
        this.#end(other.socket, "replaced");
      }
    }
    socket.send(encodeRelayMessage({ t: "registered" }));
    // Phones that dialed while the connector was reconnecting.
    for (const { state: dial } of this.#entries()) {
      if (dial.role === "dial" && !dial.open) {
        socket.send(encodeRelayMessage({ t: "dial", session: dial.session, from: dial.from }));
      }
    }
  }

  #binary(socket: RoomSocket, state: SocketState, bytes: Uint8Array): void {
    const { limits } = this.#options;
    if (state.role === "control" || (state.role === "dial" && !state.open)) {
      return this.#end(socket, "bad_message");
    }
    if (bytes.byteLength > MAX_FRAME_BYTES) return this.#end(socket, "frame_too_large");
    const peer = this.#peer(state);
    if (peer === null) return this.#end(socket, "peer_gone");
    const carried = state.bytes + peer.state.bytes + bytes.byteLength;
    const queued = peer.socket.queuedBytes();
    if (
      carried > limits.maxSessionBytes ||
      (queued !== null && queued + bytes.byteLength > limits.maxQueuedBytes)
    ) {
      return this.#end(socket, "rate_limited", "rate_limited");
    }
    peer.socket.send(bytes);
    socket.save({ ...state, seenAt: this.#now(), bytes: state.bytes + bytes.byteLength });
  }

  #newRegistration(socket: RoomSocket, id: string, restore?: RegistrationSnapshot) {
    const { relayId, origin, allowLoopbackWs, clock, store } = this.#options;
    return new ControlRegistration({
      relayId,
      origin,
      allowLoopbackWs,
      clock: () => clock.now(),
      wallClock: () => clock.wall(),
      replay: store.replay,
      claims: store.claims,
      // Saved on the socket, so the latest snapshot is the only one there is.
      store: new SocketRegistrationStore(socket, id),
      ...(restore === undefined ? {} : { restore }),
    });
  }

  /** The socket's registration: the one in memory, or one restored from its latest snapshot. */
  #registration(socket: RoomSocket, state: ControlState): ControlRegistration {
    let registration = this.#registrations.get(state.id);
    if (registration === undefined) {
      registration = this.#newRegistration(socket, state.id, state.reg);
      this.#registrations.set(state.id, registration);
    }
    return registration;
  }

  /** Ends a socket with `code`, and what depended on it. */
  #end(socket: RoomSocket, code: RelayErrorCode, peerCode: RelayErrorCode = "peer_gone"): void {
    const state = socket.load();
    this.#refuse(socket, code);
    if (state !== null) this.#cascade(state, peerCode);
  }

  /** What follows from a socket going: its peer goes, or its registration and waiting dials. */
  #cascade(state: SocketState, peerCode: RelayErrorCode): void {
    if (state.role === "control") {
      this.#registrations.get(state.id)?.abort();
      this.#registrations.delete(state.id);
      if (state.reg.state === "registered" && this.#registeredControl() === null) {
        for (const dial of this.#entries()) {
          if (dial.state.role === "dial" && !dial.state.open) {
            this.#refuse(dial.socket, "connector_offline");
          }
        }
      }
      return;
    }
    const peer = this.#peer(state);
    if (peer !== null) this.#refuse(peer.socket, peerCode);
  }

  #refuse(socket: RoomSocket, code: RelayErrorCode): void {
    if (!socket.open) return;
    try {
      socket.send(encodeRelayMessage({ t: "error", code }));
    } catch {
      // The close below still ends it.
    }
    try {
      socket.close(CLOSE_CODES[code], code);
    } catch {
      // Already closing.
    }
  }

  #entries(): Entry[] {
    const entries: Entry[] = [];
    for (const socket of this.#options.sockets()) {
      if (!socket.open) continue;
      const state = socket.load();
      if (state !== null) entries.push({ socket, state });
    }
    return entries;
  }

  #registeredControl(): Entry<ControlState> | null {
    return (
      this.#entries().find(
        (entry): entry is Entry<ControlState> =>
          entry.state.role === "control" && entry.state.reg.state === "registered",
      ) ?? null
    );
  }

  /** The other end of a splice: a session's open dial, or a dial's session. */
  #peer(state: DialState | SessionState): Entry<DialState | SessionState> | null {
    for (const entry of this.#entries()) {
      const other = entry.state;
      if (other.role === "control" || other.role === state.role) continue;
      if (other.session !== state.session) continue;
      if (other.role === "dial" && !other.open) continue;
      return entry as Entry<DialState | SessionState>;
    }
    return null;
  }

  #lastActive(socket: RoomSocket, state: SocketState): number {
    return Math.max(state.seenAt, socket.autoPongAt() ?? 0);
  }

  #sessionActive(a: Entry, b: Entry): number {
    return Math.max(this.#lastActive(a.socket, a.state), this.#lastActive(b.socket, b.state));
  }

  #now(): number {
    return this.#options.clock.now();
  }

  /** Counts one event in this relay id's bucket for the current minute. */
  #hit(bucket: string, now: number, limit: number): boolean {
    return this.#options.store.hit(`${this.#options.relayId} ${bucket}`, now, limit);
  }
}

function isPending(reg: RegistrationSnapshot): boolean {
  return reg.state === "challenged" || reg.state === "verifying";
}
