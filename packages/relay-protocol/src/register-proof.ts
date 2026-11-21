// The connector's register proof: a signed, bounded, replay-guarded answer to the relay's
// challenge, proving it holds the Ed25519 key its relay id is derived from.
//
// Ported from T3 Code (https://github.com/pingdotgg/t3code) at commit 18d1c4db:
// packages/shared/src/dpop.ts (`verifyDpopProof`: the failure codes, checking claims, then the
// signature, then the time window) and infra/relay/src/auth/DpopProofs.ts (consuming the proof's
// `jti` once, kept until the end of the last second its time window accepts it). The challenge
// lifetime, one registration per socket and the key pin are Clawtrate's own.
//
// Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import { ed25519 } from "@noble/curves/ed25519.js";
import {
  concatBytes,
  fromBase64Url,
  fromBase64UrlOfLength,
  secureRandomBytes,
  toBase64Url,
  utf8Decode,
  utf8Encode,
  type RandomBytes,
} from "./bytes.ts";
import { fail, RelayProtocolError } from "./errors.ts";
import { readFlatObject } from "./json.ts";
import { MAX_REGISTER_PROOF_CHARS, REGISTER_CHALLENGE_MS } from "./limits.ts";
import { createRegisterNonce, encodeRelayMessage, REGISTER_NONCE_BYTES } from "./messages.ts";
import { relayIdFromKey } from "./relay-id.ts";
import { checkMillis, isMillis } from "./time.ts";

export const REGISTER_PROOF_TYP = "clawtrate-relay-register/1";
/**
 * How far a proof's `iat` may sit from the relay's clock, in either direction. The proof also
 * answers a nonce the relay chose for this socket, so it is good for this one registration only.
 */
export const REGISTER_PROOF_MAX_AGE_SECONDS = 60;
/** Signed in front of the payload, so the signature means nothing in any other context. */
const SIGNING_CONTEXT = utf8Encode("clawtrate relay register proof\n");
const JTI_BYTES = 16;
const SIGNATURE_BYTES = 64;
const MAX_AUDIENCE_CHARS = 256;
/** The largest `iat` whose replay record expiry is still a safe integer of milliseconds. */
const MAX_IAT_SECONDS =
  Math.floor(Number.MAX_SAFE_INTEGER / 1_000) - REGISTER_PROOF_MAX_AGE_SECONDS - 1;

export type RegisterProofFailureCode =
  | "missing_proof"
  | "malformed_proof"
  /** The relay id in the proof is not the one its key derives. */
  | "key_mismatch"
  /** The proof is for another relay id than the socket's. */
  | "relay_mismatch"
  /** The proof is for another relay origin. */
  | "audience_mismatch"
  /** The proof answers another challenge. */
  | "nonce_mismatch"
  | "invalid_signature"
  | "time_window"
  | "replayed"
  /** The host's clock is not a nonnegative whole number of milliseconds. */
  | "bad_clock"
  /** The replay store or the key claims failed; the registration fails with them. */
  | "store_failed"
  /** The socket's challenge is older than `REGISTER_CHALLENGE_MS`. */
  | "challenge_expired"
  /** The socket already registered, or tried to. */
  | "already_used"
  /** The relay id was first claimed by another key. */
  | "claimed_by_other_key"
  /** The socket was aborted while the attempt waited. */
  | "aborted";

export type RegisterProofResult =
  | {
      readonly ok: true;
      readonly relayId: string;
      readonly publicKey: Uint8Array;
      readonly jti: string;
      readonly iat: number;
    }
  | { readonly ok: false; readonly code: RegisterProofFailureCode };

interface RegisterProofPayload {
  readonly typ: typeof REGISTER_PROOF_TYP;
  /** The relay's canonical origin, for example `wss://relay.example.test`. */
  readonly aud: string;
  readonly relayId: string;
  /** The Ed25519 public key, base64url. */
  readonly key: string;
  /** The relay's challenge nonce. */
  readonly nonce: string;
  /** Seconds since the epoch, by the connector's clock. */
  readonly iat: number;
  readonly jti: string;
}

const PAYLOAD_KEYS = ["typ", "aud", "relayId", "key", "nonce", "iat", "jti"] as const;

/** Only these hosts may use `ws:`, and only where a test turns it on. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);
/** A scheme and an authority (host and optional port), and at most a final slash. */
const ORIGIN_SPELLING = /^wss?:\/\/[A-Za-z0-9.\-[\]:]+\/?$/i;

export interface OriginOptions {
  /** Tests only: accept `ws:` for a relay on this machine. */
  readonly allowLoopbackWs?: boolean;
}

/**
 * The one spelling of a relay origin both sides sign and compare: `wss://host[:port]`,
 * lowercase, without the default port. The text given must already be a scheme, a host, an
 * optional port and at most a final slash; no path, query, fragment or credentials, checked
 * before any normalizing. `ws:` only for a loopback host, and only with `allowLoopbackWs`.
 * Anything else fails with `malformed`.
 */
export function canonicalRelayOrigin(origin: string, options: OriginOptions = {}): string {
  if (typeof origin !== "string" || origin.length > MAX_AUDIENCE_CHARS) {
    fail("malformed", "The relay origin is not short text.");
  }
  if (!ORIGIN_SPELLING.test(origin)) {
    fail("malformed", "A relay origin is a scheme, a host and an optional port.");
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return fail("malformed", "The relay origin is not a URL.");
  }
  const loopbackWs =
    url.protocol === "ws:" && options.allowLoopbackWs === true && LOOPBACK_HOSTS.has(url.hostname);
  if ((url.protocol !== "wss:" && !loopbackWs) || url.host === "") {
    fail("malformed", "A relay origin is wss:, or ws: on this machine in tests.");
  }
  return `${url.protocol}//${url.host}`;
}

/**
 * Remembers each proof's `jti` until its time window closes. The contract a relay's store
 * must meet:
 * - `consume` checks and records in one atomic step: of two calls with the same scope and jti,
 *   however they overlap, at most one returns true until `expiresAtMs`;
 * - a record outlives a restart or hibernation of the relay until `expiresAtMs`;
 * - a store that cannot answer throws or rejects, and the registration fails (`store_failed`);
 *   it never answers true on failure.
 * `MemoryReplayStore` is the reference implementation, for tests and a single Node process.
 */
export interface ReplayStore {
  consume(input: {
    readonly scope: string;
    readonly jti: string;
    readonly expiresAtMs: number;
    readonly nowMs: number;
  }): boolean | Promise<boolean>;
}

export class MemoryReplayStore implements ReplayStore {
  readonly #seen = new Map<string, number>();

  consume(input: {
    readonly scope: string;
    readonly jti: string;
    readonly expiresAtMs: number;
    readonly nowMs: number;
  }): boolean {
    this.prune(input.nowMs);
    const key = `${input.scope}\n${input.jti}`;
    if (this.#seen.has(key)) return false;
    this.#seen.set(key, input.expiresAtMs);
    return true;
  }

  /** Forgets every jti whose window has closed. */
  prune(nowMs: number): void {
    checkMillis(nowMs, "The time");
    for (const [key, expiresAtMs] of this.#seen) if (expiresAtMs <= nowMs) this.#seen.delete(key);
  }

  get size(): number {
    return this.#seen.size;
  }
}

/**
 * Pins each relay id to the full public key that first registered it. The contract a relay's
 * store must meet: `claim` checks and records in one atomic step, and in that same step reads
 * `attempt.live`: when it is false it records nothing and returns false. Otherwise it returns
 * true for an unclaimed id (recording the key) or for the key already pinned, and false for any
 * other key. It throws or rejects if it cannot answer. `MemoryKeyClaims` is the reference.
 */
export interface KeyClaims {
  claim(
    relayId: string,
    publicKey: Uint8Array,
    attempt: { readonly live: boolean },
  ): boolean | Promise<boolean>;
}

export class MemoryKeyClaims implements KeyClaims {
  readonly #keys = new Map<string, string>();

  claim(relayId: string, publicKey: Uint8Array, attempt: { readonly live: boolean }): boolean {
    if (!attempt.live) return false;
    const key = toBase64Url(publicKey);
    const pinned = this.#keys.get(relayId);
    if (pinned === undefined) this.#keys.set(relayId, key);
    return pinned === undefined || pinned === key;
  }
}

/** The connector's answer to a challenge, as `<payload>.<signature>` in base64url. */
export function createRegisterProof(input: {
  /** The connector's Ed25519 secret key (32 bytes), used for nothing else. */
  readonly secretKey: Uint8Array;
  /** The relay's origin; it is signed in canonical form. */
  readonly audience: string;
  readonly nonce: string;
  readonly nowMs: number;
  /** Tests only; production uses `crypto.getRandomValues`. */
  readonly random?: RandomBytes;
  readonly allowLoopbackWs?: boolean;
}): string {
  const nowMs = checkMillis(input.nowMs, "The time");
  if (Math.floor(nowMs / 1_000) > MAX_IAT_SECONDS) {
    fail("bad_time", "The time is past what a register proof can carry.");
  }
  if (fromBase64UrlOfLength(input.nonce, REGISTER_NONCE_BYTES) === null) {
    fail("malformed", "The challenge nonce is not 32 bytes of canonical base64url.");
  }
  const publicKey = ed25519.getPublicKey(input.secretKey);
  const payload: RegisterProofPayload = {
    typ: REGISTER_PROOF_TYP,
    aud: canonicalRelayOrigin(input.audience, input),
    relayId: relayIdFromKey(publicKey),
    key: toBase64Url(publicKey),
    nonce: input.nonce,
    iat: Math.floor(nowMs / 1_000),
    jti: toBase64Url((input.random ?? secureRandomBytes)(JTI_BYTES)),
  };
  const encoded = toBase64Url(utf8Encode(JSON.stringify(payload)));
  const signature = ed25519.sign(signingInput(encoded), input.secretKey);
  const proof = `${encoded}.${toBase64Url(signature)}`;
  if (proof.length > MAX_REGISTER_PROOF_CHARS) {
    throw new RelayProtocolError(
      "malformed",
      "The register proof is too long; shorten the audience.",
    );
  }
  return proof;
}

/**
 * Checks a register proof for the socket at /v1/connector/<relayId>, then consumes its jti.
 * A failure is returned, never thrown; a relay origin that is not canonical-izable is a host
 * error and throws. Use it through `ControlRegistration`, which also holds the challenge's
 * lifetime, one registration per socket and the key pin.
 */
export async function verifyRegisterProof(input: {
  readonly proof: string | null | undefined;
  /** The relay id in the socket's path. */
  readonly relayId: string;
  /** This relay's configured origin. */
  readonly audience: string;
  /** The challenge this socket was sent. */
  readonly nonce: string;
  readonly nowMs: number;
  readonly replay: ReplayStore;
  readonly allowLoopbackWs?: boolean;
}): Promise<RegisterProofResult> {
  const audience = canonicalRelayOrigin(input.audience, input);
  if (!isMillis(input.nowMs)) return { ok: false, code: "bad_clock" };
  const result = checkRegisterProof({ ...input, audience });
  if (!result.ok) return result;
  let consumed: boolean;
  try {
    consumed = await input.replay.consume({
      scope: result.relayId,
      jti: result.jti,
      // The time check floors the clock to seconds, so the proof passes until the end of
      // second `iat + REGISTER_PROOF_MAX_AGE_SECONDS`.
      expiresAtMs: (result.iat + REGISTER_PROOF_MAX_AGE_SECONDS + 1) * 1_000,
      nowMs: input.nowMs,
    });
  } catch {
    return { ok: false, code: "store_failed" };
  }
  return consumed === true ? result : { ok: false, code: "replayed" };
}

function checkRegisterProof(input: {
  readonly proof: string | null | undefined;
  readonly relayId: string;
  readonly audience: string;
  readonly nonce: string;
  readonly nowMs: number;
}): RegisterProofResult {
  // Type and length first, so nothing scans text over the cap.
  if (typeof input.proof !== "string") return { ok: false, code: "missing_proof" };
  if (input.proof.length > MAX_REGISTER_PROOF_CHARS) return { ok: false, code: "malformed_proof" };
  if (input.proof.trim() === "") return { ok: false, code: "missing_proof" };
  const parts = input.proof.split(".");
  if (parts.length !== 2) return { ok: false, code: "malformed_proof" };
  const [encoded, encodedSignature] = parts as [string, string];
  const payload = decodePayload(encoded);
  const signature = fromBase64UrlOfLength(encodedSignature, SIGNATURE_BYTES);
  if (payload === null || signature === null) return { ok: false, code: "malformed_proof" };
  const publicKey = fromBase64UrlOfLength(payload.key, 32)!;

  if (relayIdFromKey(publicKey) !== payload.relayId) return { ok: false, code: "key_mismatch" };
  if (payload.relayId !== input.relayId) return { ok: false, code: "relay_mismatch" };
  if (payload.aud !== input.audience) return { ok: false, code: "audience_mismatch" };
  if (payload.nonce !== input.nonce) return { ok: false, code: "nonce_mismatch" };

  let verified: boolean;
  try {
    // Strict RFC 8032 decoding: canonical points and scalars, no small-order keys. Replay is
    // caught by the jti, not by the signature's bytes.
    verified = ed25519.verify(signature, signingInput(encoded), publicKey, { zip215: false });
  } catch {
    verified = false;
  }
  if (!verified) return { ok: false, code: "invalid_signature" };

  if (Math.abs(Math.floor(input.nowMs / 1_000) - payload.iat) > REGISTER_PROOF_MAX_AGE_SECONDS) {
    return { ok: false, code: "time_window" };
  }
  return { ok: true, relayId: payload.relayId, publicKey, jti: payload.jti, iat: payload.iat };
}

function signingInput(encodedPayload: string): Uint8Array {
  return concatBytes(SIGNING_CONTEXT, utf8Encode(encodedPayload));
}

function decodePayload(encoded: string): RegisterProofPayload | null {
  const bytes = fromBase64Url(encoded);
  if (bytes === null) return null;
  let members: Map<string, unknown>;
  try {
    // Refuses repeated member names, which JSON.parse would let the last one win.
    members = readFlatObject(utf8Decode(bytes));
  } catch {
    return null;
  }
  if (members.size !== PAYLOAD_KEYS.length || !PAYLOAD_KEYS.every((key) => members.has(key))) {
    return null;
  }
  const [typ, aud, relayId, key, nonce, iat, jti] = PAYLOAD_KEYS.map((name) => members.get(name));
  if (
    typ !== REGISTER_PROOF_TYP ||
    typeof aud !== "string" ||
    aud.length === 0 ||
    aud.length > MAX_AUDIENCE_CHARS ||
    typeof relayId !== "string" ||
    fromBase64UrlOfLength(key, 32) === null ||
    fromBase64UrlOfLength(nonce, REGISTER_NONCE_BYTES) === null ||
    typeof iat !== "number" ||
    !Number.isSafeInteger(iat) ||
    iat < 0 ||
    iat > MAX_IAT_SECONDS ||
    fromBase64UrlOfLength(jti, JTI_BYTES) === null
  ) {
    return null;
  }
  return { typ, aud, relayId, key: key as string, nonce: nonce as string, iat, jti: jti as string };
}

export type RegistrationState = "challenged" | "verifying" | "registered" | "failed";

/** What a relay keeps of a control socket's registration across hibernation. */
export interface RegistrationSnapshot {
  readonly nonce: string;
  readonly issuedAtMs: number;
  /** The latest elapsed-clock reading checked; a restored registration refuses a lower one. */
  readonly lastReadingMs: number;
  readonly state: RegistrationState;
}

export type RegistrationCommit = "committed" | "cancelled";

/**
 * Keeps one control socket's registration across hibernation. The full contract, and what the
 * host does when a socket cannot be restored safely, is in the package README. In short:
 * - `persist` stores a snapshot that is not a success (`challenged`, `verifying`, `failed`), in
 *   the order it is called; it never stores `registered`.
 * - `commitRegistered` is synchronous and is the only way a success is stored. It takes its own
 *   copy of the snapshot, then reads `attempt.live` as the last thing before it writes, with no
 *   callback or wait between: false stores nothing and returns `cancelled`, true stores the
 *   copy and returns `committed`. Its return is the registration's completion point.
 * - `cancelled` means only that the liveness reading prevented publication. A store that cannot
 *   answer, or cannot confirm a write, throws or rejects; the registration then fails with
 *   `store_failed`, and the host discards the socket's stored record.
 * `MemoryRegistrationStore` is the reference implementation, for tests and a single Node process.
 */
export interface RegistrationStore {
  persist(snapshot: RegistrationSnapshot): void | Promise<void>;
  commitRegistered(
    snapshot: RegistrationSnapshot,
    attempt: { readonly live: boolean },
  ): RegistrationCommit;
}

const REGISTRATION_STATES: readonly RegistrationState[] = [
  "challenged",
  "verifying",
  "registered",
  "failed",
];

/** A plain, checked copy of a snapshot: each field read once. */
function copySnapshot(snapshot: RegistrationSnapshot): RegistrationSnapshot {
  const copy: RegistrationSnapshot = {
    nonce: snapshot.nonce,
    issuedAtMs: snapshot.issuedAtMs,
    lastReadingMs: snapshot.lastReadingMs,
    state: snapshot.state,
  };
  if (
    fromBase64UrlOfLength(copy.nonce, REGISTER_NONCE_BYTES) === null ||
    !isMillis(copy.issuedAtMs) ||
    !isMillis(copy.lastReadingMs) ||
    copy.lastReadingMs < copy.issuedAtMs ||
    !REGISTRATION_STATES.includes(copy.state)
  ) {
    fail("malformed", "The registration snapshot is not valid.");
  }
  return copy;
}

export class MemoryRegistrationStore implements RegistrationStore {
  #latest: RegistrationSnapshot | null = null;

  /** A copy of the snapshot to restore from; null before the first write. */
  get latest(): RegistrationSnapshot | null {
    return this.#latest === null ? null : { ...this.#latest };
  }

  persist(snapshot: RegistrationSnapshot): void {
    const copy = copySnapshot(snapshot);
    if (copy.state === "registered") {
      fail("unexpected", "A success is stored only by commitRegistered.");
    }
    this.#latest = copy;
  }

  commitRegistered(
    snapshot: RegistrationSnapshot,
    attempt: { readonly live: boolean },
  ): RegistrationCommit {
    // Copied and checked first, so nothing the snapshot runs comes after the liveness reading.
    const copy = copySnapshot(snapshot);
    if (copy.state !== "registered") fail("unexpected", "Only a success is committed.");
    if (!attempt.live) return "cancelled";
    this.#latest = copy;
    return "committed";
  }
}

export interface ControlRegistrationOptions extends OriginOptions {
  /** The relay id in the socket's path. */
  readonly relayId: string;
  /** This relay's configured origin. It is checked and pinned when the socket starts. */
  readonly origin: string;
  /**
   * Elapsed time in whole milliseconds, never set back by wall-clock corrections; on a relay
   * that hibernates, one that survives hibernation. A reading below an earlier one ends the
   * attempt with `bad_clock`.
   */
  readonly clock: () => number;
  /** Wall-clock milliseconds since the epoch, for the proof's `iat`. */
  readonly wallClock: () => number;
  readonly replay: ReplayStore;
  readonly claims: KeyClaims;
  /**
   * Keeps the registration across hibernation. `verifying` is stored before any other store is
   * asked and stays stored while the success is prepared; the success is stored only by
   * `commitRegistered`, and a failure is stored before it is returned. A failure to store fails
   * the attempt with `store_failed`. `abort()` and `expire()` store nothing: see the README.
   */
  readonly store?: RegistrationStore;
  /** A registration restored after hibernation, instead of a fresh challenge. */
  readonly restore?: RegistrationSnapshot;
  /** Tests only; production uses `crypto.getRandomValues`. */
  readonly random?: RandomBytes;
}

/**
 * One control socket's registration, as the relay runs it: one fresh challenge, good for
 * `REGISTER_CHALLENGE_MS`, and one registration attempt.
 *
 * - The state moves to `verifying` before the first await, so a second attempt, even one that
 *   overlaps the first, gets `already_used`.
 * - The attempt is bound to this object's one in-flight token. After every await it checks
 *   that the token is still current and the challenge still in time: before the key claim,
 *   before the success is committed. The key claim and the commit are told whether the attempt
 *   is live. The first clock failure, whether the attempt's or the timer's, is its cause.
 * - A committed success is complete when `commitRegistered` returns, in the same turn: an abort
 *   or expiry before that cancels it, and a socket that ends after it is torn down as usual.
 * - `expire()` ends a challenge that ran out with no proof; the relay calls it from a timer,
 *   since a quiet socket sends nothing. `abort()` ends the registration when the socket goes.
 */
export class ControlRegistration {
  readonly #options: ControlRegistrationOptions;
  readonly #relayId: string;
  readonly #origin: string;
  readonly #allowLoopbackWs: boolean;
  readonly #nonce: string;
  readonly #issuedAtMs: number;
  #state: RegistrationState;
  #attempt: object | null = null;
  /** The latest clock reading; a later one may not be lower. */
  #lastReading: number;
  /** The clock failure that ended the attempt, kept so a later reading cannot change it. */
  #clockFailure: "bad_clock" | "challenge_expired" | null = null;

  constructor(options: ControlRegistrationOptions) {
    this.#options = options;
    this.#relayId = options.relayId;
    this.#allowLoopbackWs = options.allowLoopbackWs === true;
    this.#origin = canonicalRelayOrigin(options.origin, options);
    const restore = options.restore;
    if (restore) {
      if (fromBase64UrlOfLength(restore.nonce, REGISTER_NONCE_BYTES) === null) {
        fail("malformed", "The restored nonce is not 32 bytes of canonical base64url.");
      }
      this.#nonce = restore.nonce;
      this.#issuedAtMs = checkMillis(restore.issuedAtMs, "The challenge time");
      this.#lastReading = checkMillis(restore.lastReadingMs, "The last clock reading");
      if (this.#lastReading < this.#issuedAtMs) {
        fail("malformed", "The last clock reading is before the challenge.");
      }
      // An attempt cut off by hibernation, or any state but these, cannot be resumed.
      this.#state =
        restore.state === "challenged" || restore.state === "registered" ? restore.state : "failed";
    } else {
      this.#nonce = createRegisterNonce(options.random);
      this.#issuedAtMs = checkMillis(options.clock(), "The clock");
      this.#lastReading = this.#issuedAtMs;
      this.#state = "challenged";
    }
  }

  get state(): RegistrationState {
    return this.#state;
  }

  /** The canonical origin this socket checks proofs against, fixed when it started. */
  get origin(): string {
    return this.#origin;
  }

  /** The challenge message to send as the socket's first text. */
  get challengeMessage(): string {
    return encodeRelayMessage({ t: "challenge", nonce: this.#nonce });
  }

  /** The clock reading after which the challenge has expired. */
  get expiresAtMs(): number {
    return this.#issuedAtMs + REGISTER_CHALLENGE_MS;
  }

  snapshot(): RegistrationSnapshot {
    return {
      nonce: this.#nonce,
      issuedAtMs: this.#issuedAtMs,
      lastReadingMs: this.#lastReading,
      state: this.#state,
    };
  }

  /**
   * Ends the registration if the challenge is past its time (or the clock is not readable),
   * with or without an attempt in flight. Returns true if it ended it now.
   */
  expire(): boolean {
    if (!this.#open()) return false;
    const failure = this.#readClock();
    if (failure === null || !this.#open()) return false;
    // The attempt in flight, if any, reports what the timer saw, not a plain abort.
    if (this.#state === "verifying") this.#clockFailure = failure;
    this.#end();
    return true;
  }

  /** Ends the registration, for a socket that closed. Safe to call any number of times. */
  abort(): void {
    if (this.#open()) this.#end();
  }

  /** Checks the socket's one register proof. Any failure ends the registration for good. */
  async register(proof: string): Promise<RegisterProofResult> {
    if (this.#state !== "challenged") return { ok: false, code: "already_used" };
    const token = {};
    this.#attempt = token;
    this.#state = "verifying";
    const store = this.#options.store;
    let result: RegisterProofResult;
    try {
      await store?.persist(this.snapshot());
      result = await this.#verify(token, proof);
    } catch {
      result = { ok: false, code: "store_failed" };
    }
    // A denial that arrives after the attempt ended reports why it ended (a timer's clock
    // failure, an expiry or an abort), not what the slow check found. A storage fault still wins.
    if (!result.ok && result.code !== "store_failed" && !this.#current(token)) {
      result = { ok: false, code: this.#cause() };
    }
    if (result.ok) {
      // From here to completion nothing waits. Anything that ended the attempt since the proof
      // checked out wins over storing it.
      const lost = this.#check(token) ?? this.#complete(token, store);
      if (lost === null) return result;
      result = { ok: false, code: lost };
    }
    if (this.#attempt === token) this.#end();
    // This call took the token, so it stores the failure, whatever ended the attempt.
    try {
      await store?.persist(this.snapshot());
    } catch {
      return { ok: false, code: "store_failed" };
    }
    return result;
  }

  /**
   * Publishes the success and completes the registration in one step: null once the state is
   * `registered`, or else why not. Each reply is checked against the last liveness reading the
   * store took through this commit's `live`: `cancelled` counts only after a false reading with
   * the attempt ended, and `committed` only after a true reading with it still current. A store
   * that throws, answers anything else (a promise included), or replies without a reading or
   * against it, is `store_failed`.
   */
  #complete(token: object, store: RegistrationStore | undefined): RegisterProofFailureCode | null {
    if (store) {
      let lastRead: boolean | null = null;
      const check = (): boolean => this.#check(token) === null;
      const view = {
        get live(): boolean {
          lastRead = check();
          return lastRead;
        },
      };
      let outcome: unknown;
      try {
        outcome = store.commitRegistered({ ...this.snapshot(), state: "registered" }, view);
      } catch {
        return "store_failed";
      }
      const current = this.#current(token);
      const read = lastRead as boolean | null;
      if (outcome === "cancelled" && read === false && !current) return this.#cause();
      if (outcome === "committed" && read === true && current) {
        this.#attempt = null;
        this.#state = "registered";
        return null;
      }
      // What a promise publishes, and when, is not known here; its failure is not reported.
      // Observing it is best effort: a thenable or proxy that throws changes nothing.
      try {
        Promise.prototype.then.call(outcome, undefined, () => {});
      } catch {
        // Not a promise, or one that cannot be observed.
      }
      return "store_failed";
    }
    this.#attempt = null;
    this.#state = "registered";
    return null;
  }

  async #verify(token: object, proof: string): Promise<RegisterProofResult> {
    const options = this.#options;
    let wallMs: number;
    try {
      wallMs = checkMillis(options.wallClock(), "The wall clock");
    } catch {
      return { ok: false, code: "bad_clock" };
    }
    let lost = this.#check(token);
    if (lost !== null) return { ok: false, code: lost };
    const result = await verifyRegisterProof({
      proof,
      relayId: this.#relayId,
      audience: this.#origin,
      nonce: this.#nonce,
      nowMs: wallMs,
      replay: options.replay,
      allowLoopbackWs: this.#allowLoopbackWs,
    });
    // A store that took its time may have outlasted the challenge or the socket, whatever it
    // answered. A storage fault stays a storage fault.
    if (!result.ok && result.code === "store_failed") return result;
    lost = this.#check(token);
    if (lost !== null) return { ok: false, code: lost };
    if (!result.ok) return result;
    let claimed: boolean;
    try {
      claimed = await options.claims.claim(
        result.relayId,
        Uint8Array.from(result.publicKey),
        this.#view(token),
      );
    } catch {
      return { ok: false, code: "store_failed" };
    }
    lost = this.#check(token);
    if (lost !== null) return { ok: false, code: lost };
    return claimed === true ? result : { ok: false, code: "claimed_by_other_key" };
  }

  /** The attempt as a store sees it: live while `#check` finds it live. */
  #view(token: object): { readonly live: boolean } {
    const check = (): boolean => this.#check(token) === null;
    return {
      get live() {
        return check();
      },
    };
  }

  /**
   * The one liveness check: null while `token` is the attempt in flight and the challenge is in
   * time, or else why it ended. It reads the clock before the token, so a clock that ended the
   * attempt is seen. A clock failure ends the attempt and stays its cause.
   */
  #check(token: object): "aborted" | "bad_clock" | "challenge_expired" | null {
    const clock = this.#readClock();
    if (this.#attempt !== token || this.#state !== "verifying") return this.#cause();
    if (clock === null) return null;
    this.#clockFailure = clock;
    this.#end();
    return clock;
  }

  /** True while `token` is the attempt in flight. Reads no clock. */
  #current(token: object): boolean {
    return this.#attempt === token && this.#state === "verifying";
  }

  /** Why an ended attempt ended: the first clock failure seen, or else an abort. */
  #cause(): "aborted" | "bad_clock" | "challenge_expired" {
    return this.#clockFailure ?? "aborted";
  }

  /** Null for a reading in time; a reading that is not whole milliseconds or went back is bad. */
  #readClock(): "bad_clock" | "challenge_expired" | null {
    let now: number;
    try {
      now = checkMillis(this.#options.clock(), "The clock");
    } catch {
      return "bad_clock";
    }
    if (now < this.#lastReading) return "bad_clock";
    this.#lastReading = now;
    return now - this.#issuedAtMs > REGISTER_CHALLENGE_MS ? "challenge_expired" : null;
  }

  #open(): boolean {
    return this.#state === "challenged" || this.#state === "verifying";
  }

  #end(): void {
    this.#attempt = null;
    this.#state = "failed";
  }
}
