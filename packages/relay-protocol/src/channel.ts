// The end-to-end channel between a phone (the Noise initiator) and a connector (the responder),
// carried by the relay as opaque frames. Neither class does I/O: `receive` takes one frame from
// the peer and returns what happened, including frames the caller must send back.
//
// The opening, in frames and records:
//
//   phone                                         connector
//   handshake1  (hello: enroll secret or none) ->
//                                              <- handshake2  (answer, provisional if accepted)
//   confirm record                             ->              "admit" event with a one-use
//                                                              handle; the host's transaction
//                                                              commits through settle()
//                                              <- admission record ("open" on the phone)
//
// Nothing changes on the connector before the confirm record: handshake message 1 can be
// replayed by whoever recorded it, and only the confirm record proves the phone is live.

import { equalBytes, utf8Decode, utf8Encode, type RandomBytes } from "./bytes.ts";
import { fail } from "./errors.ts";
import {
  decodeAnswer,
  decodeFrame,
  decodeHello,
  decodeRecord,
  encodeAnswer,
  isRefusal,
  encodeFrame,
  encodeHello,
  encodeRecord,
  ENROLL_SECRET_BYTES,
  PROTOCOL_VERSION,
  type Answer,
  type ChannelRecord,
  type FrameType,
} from "./frames.ts";
import {
  MAX_MESSAGE_BYTES,
  MAX_PARTIAL_MESSAGE_MS,
  MAX_PING_BYTES,
  MAX_RECORD_DATA_BYTES,
} from "./limits.ts";
import { IKHandshake, type KeyPair, type TransportKeys } from "./noise.ts";
import { isRelayId } from "./relay-id.ts";
import { checkMillis } from "./time.ts";

/**
 * Whatever the connector's gate needs to find a matching offer again at commit: an id or the
 * offer object. Opaque to the channel. Never the raw secret.
 */
export type OfferCandidate = object;

/** Admissions that can still be settled. A handle leaves it when settled or when its channel ends. */
const liveAdmissions = new WeakSet<Admission>();

/**
 * One confirmed phone on one session, waiting for the host's transaction. It carries nothing a
 * caller could reuse: no key, no secret. Use it once, through `Responder.beginAdmission`.
 */
export class Admission {
  /** True until it is settled or its channel ends. */
  get live(): boolean {
    return liveAdmissions.has(this);
  }
}

/** What the host's transaction is given by `beginAdmission`. */
export interface AdmissionAttempt {
  /** A copy of the authenticated phone key. Persist exactly these bytes. */
  readonly phoneKey: Uint8Array;
  /** The gate's candidate when it found a matching offer; null when it found the key enrolled. */
  readonly candidate: OfferCandidate | null;
  /**
   * True while this attempt can still be admitted. Check it inside the transaction, in the same
   * atomic step as the write: once the channel ends it is false, and nothing may be committed.
   */
  readonly live: boolean;
}

/**
 * The transaction's answer: the key is enrolled now (it was, or the offer was spent and the
 * key added), or a refusal.
 */
export type CommitResult = "enrolled" | Refusal;

export type SettleResult =
  /** Send `frame`; act only on `phoneKey`. */
  | { readonly admitted: true; readonly frame: Uint8Array; readonly phoneKey: Uint8Array }
  /** Send `frame`, the refusal; the channel is closed. */
  | { readonly admitted: false; readonly reason: Refusal; readonly frame: Uint8Array }
  /**
   * The channel ended while the transaction ran. Whatever it committed stays committed; nothing
   * is sent and the gateway is not opened.
   */
  | { readonly admitted: false; readonly reason: "ended"; readonly frame: null };

/** Why a connector turned a phone away. */
export type Refusal = Exclude<Answer, "accepted">;

export type ChannelEvent =
  /** A frame to send to the peer now, in order. */
  | { readonly type: "send"; readonly frame: Uint8Array }
  /** The phone: the connector admitted it; text may flow. */
  | { readonly type: "open" }
  /**
   * The connector: the phone confirmed the handshake. Pass the handle to `beginAdmission`, run
   * the transaction, then `settle`.
   */
  | { readonly type: "admit"; readonly admission: Admission }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "pong"; readonly data: Uint8Array }
  /** The peer closed the channel. A message it had not finished is discarded. */
  | { readonly type: "close"; readonly code: number; readonly reason: string }
  /** The phone was turned away; the channel is closed. */
  | { readonly type: "refused"; readonly reason: Refusal };

export type ChannelState =
  /** The initiator before `start`. */
  | "idle"
  | "handshaking"
  /** Message 2 is done: the connector waits for the confirm record, the phone for admission. */
  | "confirming"
  /** The connector has the confirm record and waits for the host's `settle`. */
  | "admitting"
  | "open"
  /** Ended by an authenticated close or refusal. */
  | "closed"
  /** Ended by an error or by `abort`. */
  | "failed";

/**
 * The prologue both sides hash before the handshake: the protocol's name and version and the
 * relay id, so a session spliced to another relay id fails.
 */
export function channelPrologue(relayId: string): Uint8Array {
  if (!isRelayId(relayId)) fail("bad_relay_id", "The relay id is not canonical.");
  return utf8Encode(`clawtrate-relay/${PROTOCOL_VERSION}\n${relayId}`);
}

/**
 * What the connector's allowlist says at message 1: the key is enrolled; or it is not, but its
 * secret matches a live offer, named by an opaque candidate; or a refusal.
 */
export type GateCheck = "enrolled" | Refusal | { readonly eligible: OfferCandidate };

/**
 * The connector's read-only look at its allowlist when message 1 arrives. It must change
 * nothing: the commit comes after the phone proves it is live. It is given copies, which are
 * wiped when it returns. It must not call back into the channel.
 */
export interface PhoneGate {
  check(phoneKey: Uint8Array, enroll: Uint8Array | undefined): GateCheck;
}

function checkGateResult(check: unknown): GateCheck {
  if (check === "enrolled" || isRefusal(check)) return check;
  if (typeof check === "object" && check !== null) {
    // Read once: the candidate checked here is the one the transaction is given.
    const eligible = (check as { readonly eligible?: unknown }).eligible;
    if (typeof eligible === "object" && eligible !== null) return { eligible };
  }
  return fail("malformed", "The gate's answer is not one it may give.");
}

/**
 * One pairing code's enrollment secret. It is good once, until it expires. `matches` only
 * looks; `redeem` spends it, and belongs in the same transaction that adds the phone's key.
 */
export class EnrollmentOffer {
  readonly #secret: Uint8Array;
  readonly expiresAtMs: number;
  #used = false;

  constructor(secret: Uint8Array, expiresAtMs: number) {
    if (secret.length !== ENROLL_SECRET_BYTES)
      fail("malformed", "An enrollment secret is 32 bytes.");
    this.expiresAtMs = checkMillis(expiresAtMs, "The offer's expiry");
    this.#secret = Uint8Array.from(secret);
  }

  get used(): boolean {
    return this.#used;
  }

  /** True for the matching secret, unused, before `expiresAtMs`. Compares in constant time. */
  matches(secret: Uint8Array, nowMs: number): boolean {
    checkMillis(nowMs, "The time");
    const same = equalBytes(secret, this.#secret);
    return same && !this.#used && nowMs < this.expiresAtMs;
  }

  /**
   * Spends the offer at commit, without the secret: the gate matched it at message 1. True
   * once, before `expiresAtMs`.
   */
  spend(nowMs: number): boolean {
    checkMillis(nowMs, "The time");
    if (this.#used || nowMs >= this.expiresAtMs) return false;
    this.#used = true;
    this.#secret.fill(0);
    return true;
  }
}

/**
 * Buffered text across every channel of one host. A channel takes room for each record of an
 * unfinished message and gives it back when the message completes or the channel ends; one
 * that finds no room fails with `over_budget`.
 */
export class ReceiveBudget {
  readonly limitBytes: number;
  #used = 0;

  constructor(limitBytes: number) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) {
      fail("malformed", "A budget is a whole number of bytes.");
    }
    this.limitBytes = limitBytes;
  }

  get usedBytes(): number {
    return this.#used;
  }

  take(bytes: number): boolean {
    if (this.#used + bytes > this.limitBytes) return false;
    this.#used += bytes;
    return true;
  }

  give(bytes: number): void {
    this.#used = Math.max(0, this.#used - bytes);
  }
}

export interface ChannelOptions {
  /** A budget shared by the host's channels for buffered text. */
  readonly budget?: ReceiveBudget;
  /**
   * The host's monotonic clock, in whole milliseconds; a reading that is not one, or that goes
   * back, fails the channel. With it, any record that arrives after `partialMessageDeadline`
   * fails the channel, keep-alives included. A peer that goes quiet sends nothing to check, so
   * once a message begins the host arms a timer for just after `partialMessageDeadline` and
   * calls `expirePartialMessage`, and cancels it when the message completes or the channel ends.
   * It must not call back into the channel.
   */
  readonly clock?: () => number;
}

abstract class Channel {
  protected state: ChannelState;
  protected keys: TransportKeys | null = null;
  readonly #budget: ReceiveBudget | null;
  readonly #clock: (() => number) | null;
  #handshakeHash: Uint8Array | null = null;
  #parts: Uint8Array[] = [];
  #partBytes = 0;
  #partialSince: number | null = null;
  #lastSample: number | null = null;
  #receiving = false;

  protected constructor(state: ChannelState, options: ChannelOptions) {
    this.state = state;
    this.#budget = options.budget ?? null;
    this.#clock = options.clock ?? null;
  }

  get currentState(): ChannelState {
    return this.state;
  }

  /** The Noise handshake hash: the same on both ends of one session, and different for every session. */
  get handshakeHash(): Uint8Array | null {
    return this.#handshakeHash === null ? null : Uint8Array.from(this.#handshakeHash);
  }

  /** Bytes held for a message that has not finished arriving. */
  get bufferedBytes(): number {
    return this.#partBytes;
  }

  /** The clock reading when the unfinished message began, or null. Needs `clock`. */
  get partialMessageSince(): number | null {
    return this.#partialSince;
  }

  /**
   * The last clock reading at which the unfinished message may still continue, or null. One
   * millisecond later it has expired, on the receive path and for `expirePartialMessage` alike.
   */
  get partialMessageDeadline(): number | null {
    return this.#partialSince === null ? null : this.#partialSince + MAX_PARTIAL_MESSAGE_MS;
  }

  /**
   * For the host's timer: fails the channel if its unfinished message is past the deadline, and
   * returns true if it did. A bad clock reading fails the channel too.
   */
  expirePartialMessage(): boolean {
    if (this.state === "closed" || this.state === "failed") return false;
    try {
      const now = this.#sample();
      if (now === null || !this.#pastDeadline(now)) return false;
    } catch (error) {
      this.terminate("failed");
      throw error;
    }
    this.terminate("failed");
    return true;
  }

  /**
   * Takes one binary frame from the peer. Anything wrong with it (tampering, a replayed,
   * reordered or dropped frame, a frame the state does not allow, a size over a cap) throws
   * `RelayProtocolError` and fails the channel for good: the caller closes the socket.
   */
  receive(bytes: Uint8Array): ChannelEvent[] {
    this.#checkUsable();
    // A callback (the gate) calling back in would see a half-made transition.
    if (this.#receiving) fail("unexpected", "receive was called from inside a callback.");
    this.#receiving = true;
    try {
      const frame = decodeFrame(bytes);
      return this.receiveFrame(frame.type, frame.body);
    } catch (error) {
      this.terminate("failed");
      throw error;
    } finally {
      this.#receiving = false;
    }
  }

  protected abstract receiveFrame(type: FrameType, body: Uint8Array): ChannelEvent[];

  /**
   * Encrypts a text message, split into as many frames as it needs. A message over
   * `MAX_MESSAGE_BYTES` is refused and the channel stays open; a channel without enough
   * messages left on its key fails before sending any.
   */
  sendText(text: string): Uint8Array[] {
    this.#checkOpen();
    // A UTF-16 unit takes at least one UTF-8 byte, so this needs no encoding.
    if (text.length > MAX_MESSAGE_BYTES) {
      fail("message_too_large", `A message is at most ${MAX_MESSAGE_BYTES} bytes.`);
    }
    const bytes = utf8Encode(text);
    if (bytes.length > MAX_MESSAGE_BYTES) {
      fail("message_too_large", `A message is at most ${MAX_MESSAGE_BYTES} bytes.`);
    }
    const records = Math.max(1, Math.ceil(bytes.length / MAX_RECORD_DATA_BYTES));
    if (this.keys!.send.remaining < records) {
      this.terminate("failed");
      fail("nonce_exhausted", "This channel's key cannot send this message.");
    }
    const frames: Uint8Array[] = [];
    for (let offset = 0; offset < bytes.length || frames.length === 0;) {
      const end = Math.min(offset + MAX_RECORD_DATA_BYTES, bytes.length);
      const data = bytes.subarray(offset, end);
      frames.push(
        this.seal(end === bytes.length ? { kind: "text-end", data } : { kind: "text-part", data }),
      );
      offset = end;
    }
    return frames;
  }

  /** A ping the peer answers with a pong carrying the same bytes. */
  ping(data: Uint8Array = new Uint8Array(0)): Uint8Array {
    this.#checkOpen();
    if (data.length > MAX_PING_BYTES)
      fail("malformed", `A ping carries at most ${MAX_PING_BYTES} bytes.`);
    return this.seal({ kind: "ping", data });
  }

  /** Ends the channel with an authenticated close and returns the last frame to send. */
  close(code = 1000, reason = ""): Uint8Array {
    this.#checkOpen();
    const frame = this.seal({ kind: "close", code, reason });
    this.terminate("closed");
    return frame;
  }

  /**
   * Ends the channel at once, for a socket that closed or timed out: it drops the keys, any
   * unfinished message and any pending enrollment. Safe to call in any state, any number of
   * times. Returns true only if an authenticated close or refusal ended the channel first; a
   * socket that ends without one ended abnormally.
   */
  abort(): boolean {
    if (this.state === "closed") return true;
    this.terminate("failed");
    return false;
  }

  /** Encrypts one record. Running out of messages on the key ends the channel. */
  protected seal(record: ChannelRecord): Uint8Array {
    let body: Uint8Array;
    try {
      body = this.keys!.send.encrypt(new Uint8Array(0), encodeRecord(record));
    } catch (error) {
      if ((error as { code?: unknown }).code === "nonce_exhausted") this.terminate("failed");
      throw error;
    }
    return encodeFrame({ type: "transport", body });
  }

  protected open(body: Uint8Array): ChannelRecord {
    return decodeRecord(this.keys!.receive.decrypt(new Uint8Array(0), body));
  }

  /** Takes ownership of the handshake's transport keys, the moment the handshake splits. */
  protected adoptKeys(handshake: IKHandshake): void {
    const keys = handshake.takeTransportKeys();
    this.keys = keys;
    this.#handshakeHash = Uint8Array.from(keys.handshakeHash);
  }

  /**
   * The one way into `closed` or `failed`: wipes the handshake, the transport keys, buffered
   * text and anything pending, and ends a pending admission.
   */
  protected terminate(state: "closed" | "failed"): void {
    if (this.state === "closed" || this.state === "failed") return;
    this.state = state;
    this.handshake.dispose();
    this.keys?.send.clear();
    this.keys?.receive.clear();
    this.keys = null;
    this.#dropPartial();
    this.dropPending();
  }

  /** The channel's handshake, disposed of with the channel. */
  protected abstract readonly handshake: IKHandshake;

  /** Subclasses wipe what they hold for the opening. */
  protected dropPending(): void {}

  /** Handles a record on an open channel. Every record, keep-alives too, meets the deadline. */
  protected receiveRecord(record: ChannelRecord): ChannelEvent[] {
    const now = this.#sample();
    if (now !== null && this.#pastDeadline(now)) {
      fail("timed_out", "The message took too long to arrive.");
    }
    if (now !== null && this.#partialSince === null && record.kind === "text-part") {
      this.#partialSince = now;
    }
    switch (record.kind) {
      case "text-part":
      case "text-end":
        return this.#receiveText(record.kind, record.data);
      case "ping":
        return [{ type: "send", frame: this.seal({ kind: "pong", data: record.data }) }];
      case "pong":
        return [{ type: "pong", data: Uint8Array.from(record.data) }];
      case "close":
        // An authenticated close cancels a message still arriving.
        this.terminate("closed");
        return [{ type: "close", code: record.code, reason: record.reason }];
      case "confirm":
      case "admission":
        return fail("unexpected", `A ${record.kind} record comes once, first.`);
    }
  }

  /** A checked reading of the host's clock, or null without one. */
  #sample(): number | null {
    if (this.#clock === null) return null;
    const now = checkMillis(this.#clock(), "The clock");
    // The clock may not call back into the channel; one that ended it ends this step.
    this.#checkUsable();
    if (this.#lastSample !== null && now < this.#lastSample) {
      fail("bad_time", "The clock went backwards.");
    }
    this.#lastSample = now;
    return now;
  }

  #pastDeadline(now: number): boolean {
    return this.#partialSince !== null && now - this.#partialSince > MAX_PARTIAL_MESSAGE_MS;
  }

  #receiveText(kind: "text-part" | "text-end", data: Uint8Array): ChannelEvent[] {
    if (this.#partBytes + data.length > MAX_MESSAGE_BYTES) {
      fail("message_too_large", `A message is at most ${MAX_MESSAGE_BYTES} bytes.`);
    }
    if (this.#budget !== null && !this.#budget.take(data.length)) {
      fail("over_budget", "The host has no room for more buffered text.");
    }
    this.#partBytes += data.length;
    this.#parts.push(Uint8Array.from(data));
    if (kind === "text-part") return [];
    // Joining makes a second copy of the message; reserve room for it before allocating.
    const total = this.#partBytes;
    if (this.#budget !== null && !this.#budget.take(total)) {
      fail("over_budget", "The host has no room to join this message.");
    }
    let joined: Uint8Array | null = null;
    let text: string;
    try {
      joined = new Uint8Array(total);
      let offset = 0;
      for (const part of this.#parts) {
        joined.set(part, offset);
        offset += part.length;
      }
      text = utf8Decode(joined);
    } finally {
      joined?.fill(0);
      this.#budget?.give(total);
    }
    this.#dropPartial();
    // The returned text, and the host's own write queues, need bounds of their own.
    return [{ type: "text", text }];
  }

  #dropPartial(): void {
    for (const part of this.#parts) part.fill(0);
    this.#budget?.give(this.#partBytes);
    this.#parts = [];
    this.#partBytes = 0;
    this.#partialSince = null;
  }

  #checkUsable(): void {
    if (this.state === "failed") fail("failed", "The channel has failed.");
    if (this.state === "closed") fail("closed", "The channel is closed.");
  }

  #checkOpen(): void {
    this.#checkUsable();
    if (this.state !== "open") fail("unexpected", "The channel is not open yet.");
  }
}

export interface InitiatorOptions extends ChannelOptions {
  readonly relayId: string;
  /** The connector's Noise static public key, pinned by the pairing code. */
  readonly connectorKey: Uint8Array;
  /** The phone's own Noise static key pair. */
  readonly staticKey: KeyPair;
  /** The pairing code's enrollment secret, until the phone is enrolled. */
  readonly enroll?: Uint8Array;
  /** Tests only, to replay known ephemeral keys; production uses `crypto.getRandomValues`. */
  readonly random?: RandomBytes;
}

/**
 * The phone's end. Call `start`, send its frame, then feed every frame from the relay to
 * `receive`. It reports `open` only on the connector's admission record.
 */
export class Initiator extends Channel {
  protected readonly handshake: IKHandshake;
  readonly #hello: Uint8Array;

  constructor(options: InitiatorOptions) {
    super("idle", options);
    this.#hello = encodeHello(options.enroll === undefined ? {} : { enroll: options.enroll });
    this.handshake = new IKHandshake({
      initiator: true,
      prologue: channelPrologue(options.relayId),
      staticKey: options.staticKey,
      remoteStaticKey: options.connectorKey,
      ...(options.random ? { random: options.random } : {}),
    });
  }

  /** Handshake message 1, to send first. */
  start(): Uint8Array {
    if (this.state !== "idle") fail("unexpected", "The channel has already started.");
    try {
      const body = this.handshake.writeMessage1(this.#hello);
      this.state = "handshaking";
      return encodeFrame({ type: "handshake1", body });
    } catch (error) {
      this.terminate("failed");
      throw error;
    } finally {
      this.#hello.fill(0);
    }
  }

  protected override dropPending(): void {
    this.#hello.fill(0);
  }

  protected receiveFrame(type: FrameType, body: Uint8Array): ChannelEvent[] {
    if (this.state === "handshaking" && type === "handshake2") {
      const payload = this.handshake.readMessage2(body);
      // Adopt the split keys before reading the answer, so a bad answer still wipes them.
      this.adoptKeys(this.handshake);
      let answer: Answer;
      try {
        answer = decodeAnswer(payload);
      } finally {
        payload.fill(0);
      }
      if (answer !== "accepted") {
        this.terminate("closed");
        return [{ type: "refused", reason: answer }];
      }
      const confirm = this.seal({ kind: "confirm" });
      this.state = "confirming";
      return [{ type: "send", frame: confirm }];
    }
    if (this.state === "confirming" && type === "transport") {
      const record = this.open(body);
      if (record.kind !== "admission") {
        fail("unexpected", "The connector's first record must be its admission.");
      }
      if (record.answer !== "accepted") {
        this.terminate("closed");
        return [{ type: "refused", reason: record.answer }];
      }
      this.state = "open";
      return [{ type: "open" }];
    }
    if (this.state === "open" && type === "transport") return this.receiveRecord(this.open(body));
    return fail("unexpected", `A ${type} frame is not expected now.`);
  }
}

export interface ResponderOptions extends ChannelOptions {
  readonly relayId: string;
  /** The connector's Noise static key pair. */
  readonly staticKey: KeyPair;
  readonly gate: PhoneGate;
  /** Tests only, to replay known ephemeral keys; production uses `crypto.getRandomValues`. */
  readonly random?: RandomBytes;
}

/**
 * The connector's end, one per relayed session. Feed it every frame from the relay.
 *
 * At message 1 it asks the gate, read-only, and answers; an "accepted" answer is provisional.
 * When the phone's confirm record arrives it reports `admit` with a one-use `Admission`. The
 * host passes it to `beginAdmission`, which gives the transaction the authenticated key and
 * the gate's candidate. Inside one atomic step the transaction checks the attempt is still
 * live, rechecks the offer's expiry and its own policy, and spends the offer and adds the key
 * (or finds the key still enrolled); then the host calls `settle` with the result. Only a
 * committed "enrolled" admits the phone. Act only on the key `settle` returns, and open no gateway socket before it. Call `abort()` when the socket ends, a write
 * fails or the host gives up waiting; a write that fails after a commit leaves the enrollment
 * in place.
 */
export class Responder extends Channel {
  protected readonly handshake: IKHandshake;
  readonly #gate: PhoneGate;
  /** The phone's key as message 1 authenticated it; never handed out, only copies. */
  #phoneKey: Uint8Array | null = null;
  #candidate: OfferCandidate | null = null;
  /** The pending admission, until it is settled or the channel ends. */
  #admission: Admission | null = null;
  #attempt: AdmissionAttempt | null = null;

  constructor(options: ResponderOptions) {
    super("handshaking", options);
    this.#gate = options.gate;
    this.handshake = new IKHandshake({
      initiator: false,
      prologue: channelPrologue(options.relayId),
      staticKey: options.staticKey,
      ...(options.random ? { random: options.random } : {}),
    });
  }

  /** A copy of the phone's Noise static key, once handshake message 1 is read. */
  get phoneKey(): Uint8Array | null {
    return this.#phoneKey === null ? null : Uint8Array.from(this.#phoneKey);
  }

  /**
   * Starts the host's transaction for this channel's admission, once. The attempt carries a
   * copy of the authenticated key and the gate's candidate; check `attempt.live` inside the
   * transaction, in the same atomic step as the write. Then call `settle` with its result; if
   * the transaction fails, call `abort()`.
   */
  beginAdmission(admission: Admission): AdmissionAttempt {
    if (
      admission !== this.#admission ||
      !admission.live ||
      this.state !== "admitting" ||
      this.#attempt !== null
    ) {
      fail("unexpected", "This admission is not this channel's pending one.");
    }
    const attempt: AdmissionAttempt = {
      phoneKey: Uint8Array.from(this.#phoneKey!),
      candidate: this.#candidate,
      get live() {
        return liveAdmissions.has(admission);
      },
    };
    this.#attempt = attempt;
    return attempt;
  }

  /**
   * Ends the admission with the transaction's result. Only "enrolled" admits the phone. A
   * result that is not a `CommitResult`, or an attempt whose key was changed, fails the
   * channel. If the channel ended while the transaction ran, nothing is sent: whatever was
   * committed stays committed, and the gateway is not opened.
   */
  settle(attempt: AdmissionAttempt, result: CommitResult): SettleResult {
    // An attempt whose channel ended changes nothing, whichever channel it was.
    if (!attempt.live) return { admitted: false, reason: "ended", frame: null };
    if (attempt !== this.#attempt) fail("unexpected", "This is not this channel's attempt.");
    if (result !== "enrolled" && !isRefusal(result)) {
      this.terminate("failed");
      fail("malformed", "The transaction's answer is not one it may give.");
    }
    if (!equalBytes(attempt.phoneKey, this.#phoneKey!)) {
      this.terminate("failed");
      fail("unexpected", "The transaction changed the phone key it was given.");
    }
    if (result === "enrolled") {
      const frame = this.seal({ kind: "admission", answer: "accepted" });
      const phoneKey = Uint8Array.from(this.#phoneKey!);
      this.dropPending();
      this.state = "open";
      return { admitted: true, frame, phoneKey };
    }
    const frame = this.seal({ kind: "admission", answer: result });
    this.terminate("closed");
    return { admitted: false, reason: result, frame };
  }

  /** Ends the pending admission too: a transaction still running sees `live` turn false. */
  protected override dropPending(): void {
    if (this.#admission !== null) liveAdmissions.delete(this.#admission);
    this.#admission = null;
    this.#attempt = null;
    this.#candidate = null;
  }

  protected receiveFrame(type: FrameType, body: Uint8Array): ChannelEvent[] {
    if (this.state === "handshaking" && type === "handshake1") return this.#readHello(body);
    if (this.state === "confirming" && type === "transport") {
      const record = this.open(body);
      if (record.kind !== "confirm")
        fail("unexpected", "The phone's first record must be confirm.");
      const admission = new Admission();
      liveAdmissions.add(admission);
      this.#admission = admission;
      this.state = "admitting";
      return [{ type: "admit", admission }];
    }
    if (this.state === "open" && type === "transport") return this.receiveRecord(this.open(body));
    return fail("unexpected", `A ${type} frame is not expected now.`);
  }

  #readHello(body: Uint8Array): ChannelEvent[] {
    let payload: Uint8Array | null = null;
    let enroll: Uint8Array | null = null;
    let check: GateCheck;
    try {
      payload = this.handshake.readMessage1(body);
      enroll = decodeHello(payload).enroll ?? null;
      this.#phoneKey = this.handshake.remoteStaticKey!;
      const keyCopy = Uint8Array.from(this.#phoneKey);
      const enrollCopy = enroll === null ? undefined : Uint8Array.from(enroll);
      try {
        check = checkGateResult(this.#gate.check(keyCopy, enrollCopy));
      } finally {
        keyCopy.fill(0);
        enrollCopy?.fill(0);
      }
    } finally {
      payload?.fill(0);
      enroll?.fill(0);
    }
    // The gate may have ended the channel (an abort from inside it); stop before sealing.
    if ((this.state as ChannelState) !== "handshaking") {
      fail("failed", "The channel ended while the gate was deciding.");
    }
    const answer: Answer = check === "enrolled" || typeof check === "object" ? "accepted" : check;
    const frame = encodeFrame({
      type: "handshake2",
      body: this.handshake.writeMessage2(encodeAnswer(answer)),
    });
    this.adoptKeys(this.handshake);
    if (answer !== "accepted") {
      this.terminate("closed");
      return [
        { type: "send", frame },
        { type: "refused", reason: answer },
      ];
    }
    this.#candidate = typeof check === "object" ? check.eligible : null;
    this.state = "confirming";
    return [{ type: "send", frame }];
  }
}
