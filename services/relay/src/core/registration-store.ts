// A control socket's registration, kept on the socket itself: on a Durable Object, the
// WebSocket attachment, which survives hibernation and is discarded with the socket; on the
// Node runner, the socket's state in memory. It meets the protocol's `RegistrationStore`
// contract with synchronous writes. A commit copies and checks the snapshot, reads whether the
// attempt is still live, and writes the success, with nothing between that reading and the
// write. Abort and expiry come from the socket's close and the room's alarm, other events of
// the same single-threaded object, so they land before the commit or after it, never inside.

import {
  fromBase64Url,
  REGISTER_NONCE_BYTES,
  toBase64Url,
  type RegistrationCommit,
  type RegistrationSnapshot,
  type RegistrationState,
  type RegistrationStore,
} from "@clawtrate/relay-protocol";
import type { ControlState, RoomSocket } from "./room.ts";

const STATES: ReadonlySet<RegistrationState> = new Set([
  "challenged",
  "verifying",
  "registered",
  "failed",
]);

export class SocketRegistrationStore implements RegistrationStore {
  readonly #socket: RoomSocket;
  readonly #id: string;

  /** The store for the control socket `socket`, whose state carries the id `id`. */
  constructor(socket: RoomSocket, id: string) {
    this.#socket = socket;
    this.#id = id;
  }

  persist(snapshot: RegistrationSnapshot): void {
    const copy = copySnapshot(snapshot);
    if (copy.state === "registered") {
      throw new Error("A success is stored only by commitRegistered.");
    }
    this.#socket.save({ ...this.#current(), reg: copy });
  }

  commitRegistered(
    snapshot: RegistrationSnapshot,
    attempt: { readonly live: boolean },
  ): RegistrationCommit {
    const copy = copySnapshot(snapshot);
    if (copy.state !== "registered") throw new Error("Only a success is committed.");
    const current = this.#current();
    // The attempt's last reading, then the write: nothing runs between the two.
    if (!attempt.live) return "cancelled";
    this.#socket.save({ ...current, reg: copy });
    return "committed";
  }

  /** The socket's control state, or a throw if the socket no longer holds this registration. */
  #current(): ControlState {
    const current = this.#socket.load();
    if (current?.role !== "control" || current.id !== this.#id) {
      throw new Error("The control socket is gone.");
    }
    return current;
  }
}

/**
 * Reads each field once, into plain data, and refuses anything that is not a snapshot, by the
 * protocol's own checks: a canonical 32-byte nonce, times in nonnegative whole milliseconds, a
 * last reading no earlier than the challenge, and one of the four states.
 */
function copySnapshot(snapshot: RegistrationSnapshot): RegistrationSnapshot {
  const copy: RegistrationSnapshot = {
    nonce: snapshot.nonce,
    issuedAtMs: snapshot.issuedAtMs,
    lastReadingMs: snapshot.lastReadingMs,
    state: snapshot.state,
  };
  if (
    !isNonce(copy.nonce) ||
    !isMillis(copy.issuedAtMs) ||
    !isMillis(copy.lastReadingMs) ||
    copy.lastReadingMs < copy.issuedAtMs ||
    !STATES.has(copy.state)
  ) {
    throw new Error("Not a registration snapshot.");
  }
  return copy;
}

function isNonce(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const bytes = fromBase64Url(value);
  return bytes !== null && bytes.length === REGISTER_NONCE_BYTES && toBase64Url(bytes) === value;
}

function isMillis(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
