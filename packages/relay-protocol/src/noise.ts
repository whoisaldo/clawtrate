// Noise_IK_25519_ChaChaPoly_SHA256, written from the Noise Protocol Framework, revision 34
// (https://noiseprotocol.org/noise.html), sections 5 and 7. Only the IK pattern is built:
//
//   IK:
//     <- s
//     ...
//     -> e, es, s, ss
//     <- e, ee, se
//
// The initiator (the phone) knows the responder's (the connector's) static key in advance,
// from the pairing code.

import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, secureRandomBytes, utf8Encode, type RandomBytes } from "./bytes.ts";
import { fail, RelayProtocolError } from "./errors.ts";
import { KEY_BYTES, NOISE_MAX_MESSAGE_BYTES, TAG_BYTES } from "./limits.ts";

export const NOISE_PROTOCOL_NAME = "Noise_IK_25519_ChaChaPoly_SHA256";

const HASH_BYTES = 32;
const EMPTY = new Uint8Array(0);
/** Noise reserves 2^64-1; a JavaScript number counts exactly to 2^53-1, which no session reaches. */
const MAX_NONCE = Number.MAX_SAFE_INTEGER;

export interface KeyPair {
  readonly secretKey: Uint8Array;
  readonly publicKey: Uint8Array;
}

/** An X25519 key pair for Noise: the phone's or the connector's static key. */
export function generateKeyPair(random: RandomBytes = secureRandomBytes): KeyPair {
  const seed = random(KEY_BYTES);
  const pair = keyPairFromSecret(seed);
  // The pair keeps its own copy; a seed from a test's source belongs to the test.
  if (random === secureRandomBytes) seed.fill(0);
  return pair;
}

export function keyPairFromSecret(secretKey: Uint8Array): KeyPair {
  // One copy, read from the bytes and not through an iterator, serves both halves.
  const copy = new Uint8Array(secretKey);
  if (copy.length !== KEY_BYTES) fail("bad_key", "An X25519 secret key is 32 bytes.");
  return { secretKey: copy, publicKey: x25519.getPublicKey(copy) };
}

function dh(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== KEY_BYTES) fail("bad_key", "An X25519 public key is 32 bytes.");
  let shared: Uint8Array;
  try {
    // noble refuses low-order points, whose shared secret is all zero.
    shared = x25519.getSharedSecret(secretKey, publicKey);
  } catch {
    return fail("bad_key", "The peer's key is a low-order point.");
  }
  let any = 0;
  for (const byte of shared) any |= byte;
  if (any === 0) fail("bad_key", "The peer's key is a low-order point.");
  return shared;
}

function hkdf2(chainingKey: Uint8Array, input: Uint8Array): [Uint8Array, Uint8Array] {
  const tempKey = hmac(sha256, chainingKey, input);
  const out1 = hmac(sha256, tempKey, Uint8Array.of(1));
  const second = concatBytes(out1, Uint8Array.of(2));
  const out2 = hmac(sha256, tempKey, second);
  tempKey.fill(0);
  second.fill(0);
  return [out1, out2];
}

/** Noise section 5.1: a key and a counting nonce. */
export class CipherState {
  #key: Uint8Array | null;
  #nonce = 0;
  #cleared = false;

  constructor(key: Uint8Array | null = null) {
    this.#key = key;
  }

  get hasKey(): boolean {
    return this.#key !== null;
  }

  /** How many more messages this key can take before it is used up. */
  get remaining(): number {
    return this.#cleared ? 0 : MAX_NONCE - this.#nonce;
  }

  /** Moves the counter so that `remaining` messages are left. Tests only: it reaches exhaustion fast. */
  static leaveRemainingForTests(cipher: CipherState, remaining: number): void {
    cipher.#nonce = MAX_NONCE - remaining;
  }

  /** Overwrites the key, best effort in JavaScript, and refuses any further use. */
  clear(): void {
    this.#key?.fill(0);
    this.#key = null;
    this.#cleared = true;
  }

  #nonceBytes(): Uint8Array {
    if (this.#nonce >= MAX_NONCE)
      fail("nonce_exhausted", "This channel has sent its last message.");
    // 32 bits of zeros, then the 64-bit counter, little-endian (section 12.3).
    const out = new Uint8Array(12);
    const view = new DataView(out.buffer);
    view.setUint32(4, this.#nonce % 0x1_0000_0000, true);
    view.setUint32(8, Math.floor(this.#nonce / 0x1_0000_0000), true);
    return out;
  }

  encrypt(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (this.#cleared) fail("closed", "This key has been cleared.");
    if (this.#key === null) return plaintext;
    const ciphertext = chacha20poly1305(this.#key, this.#nonceBytes(), ad).encrypt(plaintext);
    this.#nonce++;
    return ciphertext;
  }

  /** Fails with `decrypt_failed`; the counter only moves on success, as the specification says. */
  decrypt(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (this.#cleared) fail("closed", "This key has been cleared.");
    if (this.#key === null) return ciphertext;
    if (ciphertext.length < TAG_BYTES)
      fail("decrypt_failed", "The message is shorter than its tag.");
    let plaintext: Uint8Array;
    try {
      plaintext = chacha20poly1305(this.#key, this.#nonceBytes(), ad).decrypt(ciphertext);
    } catch (error) {
      if (error instanceof RelayProtocolError) throw error;
      return fail("decrypt_failed", "The message failed authentication.");
    }
    this.#nonce++;
    return plaintext;
  }
}

/** Noise section 5.2. */
class SymmetricState {
  #chainingKey: Uint8Array;
  #hash: Uint8Array;
  #cipher = new CipherState();

  constructor(protocolName: string) {
    const name = utf8Encode(protocolName);
    const h = name.length <= HASH_BYTES ? new Uint8Array(HASH_BYTES) : sha256(name);
    if (name.length <= HASH_BYTES) h.set(name);
    this.#hash = h;
    this.#chainingKey = Uint8Array.from(h);
  }

  get handshakeHash(): Uint8Array {
    return this.#hash;
  }

  mixKey(input: Uint8Array): void {
    const [chainingKey, key] = hkdf2(this.#chainingKey, input);
    this.#chainingKey.fill(0);
    this.#chainingKey = chainingKey;
    this.#cipher.clear();
    this.#cipher = new CipherState(key);
  }

  mixHash(data: Uint8Array): void {
    this.#hash = sha256(concatBytes(this.#hash, data));
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.#cipher.encrypt(this.#hash, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.#cipher.decrypt(this.#hash, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  /** Section 5.2's Split, after which the chaining key and the handshake cipher are wiped. */
  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf2(this.#chainingKey, EMPTY);
    this.dispose();
    return [new CipherState(k1), new CipherState(k2)];
  }

  /** What a test needs to see that the secrets are gone. */
  get secretsForTests(): { readonly chainingKey: Uint8Array; readonly cipherKeyed: boolean } {
    return { chainingKey: this.#chainingKey, cipherKeyed: this.#cipher.hasKey };
  }

  /** Wipes the chaining key and the handshake cipher, best effort. The hash `h` is kept. */
  dispose(): void {
    this.#chainingKey.fill(0);
    this.#cipher.clear();
  }
}

export interface TransportKeys {
  /** Encrypts what this side sends. */
  readonly send: CipherState;
  /** Decrypts what this side receives. */
  readonly receive: CipherState;
  /** The handshake hash `h`, the same on both sides; it names this session. */
  readonly handshakeHash: Uint8Array;
}

export interface IKHandshakeOptions {
  readonly initiator: boolean;
  readonly prologue: Uint8Array;
  readonly staticKey: KeyPair;
  /** The responder's static public key. The initiator must have it; the responder learns it. */
  readonly remoteStaticKey?: Uint8Array;
  /** Where the ephemeral key comes from. Tests pass the vector's ephemeral key. */
  readonly random?: RandomBytes;
}

type Step = "write1" | "read1" | "write2" | "read2" | "done" | "failed";

/**
 * One IK handshake, as section 5.3's HandshakeState. Messages must be taken in order; any
 * failure, including a failed decryption, ends the handshake for good.
 */
export class IKHandshake {
  readonly #symmetric = new SymmetricState(NOISE_PROTOCOL_NAME);
  readonly #static: KeyPair;
  readonly #random: RandomBytes;
  #ephemeral: KeyPair | null = null;
  #remoteStatic: Uint8Array | null;
  #remoteEphemeral: Uint8Array | null = null;
  #step: Step;
  /** True while a step runs, so a callback (the random source) cannot start another. */
  #busy = false;
  #keys: TransportKeys | null = null;

  constructor(options: IKHandshakeOptions) {
    this.#static = options.staticKey;
    this.#random = options.random ?? secureRandomBytes;
    this.#remoteStatic = options.remoteStaticKey ? Uint8Array.from(options.remoteStaticKey) : null;
    if (options.initiator && this.#remoteStatic?.length !== KEY_BYTES) {
      fail("bad_key", "The initiator needs the responder's 32-byte static key.");
    }
    this.#step = options.initiator ? "write1" : "read1";
    this.#symmetric.mixHash(options.prologue);
    // The pre-message `<- s`: both sides hash the responder's static key.
    this.#symmetric.mixHash(options.initiator ? this.#remoteStatic! : this.#static.publicKey);
  }

  /**
   * A copy of the peer's static key: known to the initiator from the start, to the responder
   * after message 1. A copy, so no caller can change the key the handshake goes on to use.
   */
  get remoteStaticKey(): Uint8Array | null {
    return this.#remoteStatic === null ? null : Uint8Array.from(this.#remoteStatic);
  }

  get complete(): boolean {
    return this.#step === "done";
  }

  /** The transport keys once the handshake is complete, while the handshake still owns them. */
  get transportKeys(): TransportKeys {
    if (this.#keys === null) return fail("unexpected", "The handshake holds no transport keys.");
    return this.#keys;
  }

  /**
   * Hands the transport keys to the caller, once. From then on the caller owns them and clears
   * them; `dispose` no longer touches them.
   */
  takeTransportKeys(): TransportKeys {
    const keys = this.transportKeys;
    this.#keys = null;
    return keys;
  }

  /**
   * Ends the handshake and wipes what it owns, best effort: the ephemeral secret, the remote
   * ephemeral key, the chaining key and the handshake cipher, and transport keys not yet taken.
   * The static keys belong to the caller. Safe to call any number of times.
   */
  dispose(): void {
    if (this.#step !== "done") this.#step = "failed";
    this.#ephemeral?.secretKey.fill(0);
    this.#ephemeral = null;
    this.#remoteEphemeral?.fill(0);
    this.#remoteEphemeral = null;
    this.#symmetric.dispose();
    this.#keys?.send.clear();
    this.#keys?.receive.clear();
    this.#keys = null;
  }

  /** Tests only: the secrets the handshake still holds, to check that disposal wiped them. */
  static secretsForTests(handshake: IKHandshake): {
    readonly ephemeralSecret: Uint8Array | null;
    readonly chainingKey: Uint8Array;
    readonly cipherKeyed: boolean;
    readonly holdsTransportKeys: boolean;
  } {
    return {
      ephemeralSecret: handshake.#ephemeral?.secretKey ?? null,
      ...handshake.#symmetric.secretsForTests,
      holdsTransportKeys: handshake.#keys !== null,
    };
  }

  #run<T>(step: Step, next: Step, body: () => T): T {
    if (this.#step !== step || this.#busy) {
      this.dispose();
      this.#step = "failed";
      return fail("unexpected", `This handshake cannot take step ${step} now.`);
    }
    this.#busy = true;
    try {
      const result = body();
      // A callback inside the step (the random source) that ended the handshake ended it.
      if (this.#step !== step) fail("failed", "The handshake ended while its step ran.");
      this.#step = next;
      return result;
    } catch (error) {
      this.dispose();
      throw error;
    } finally {
      this.#busy = false;
    }
  }

  /** MixKey(DH(secret, public)), wiping the shared secret after. */
  #mixDh(secretKey: Uint8Array, publicKey: Uint8Array): void {
    const shared = dh(secretKey, publicKey);
    this.#symmetric.mixKey(shared);
    shared.fill(0);
  }

  #newEphemeral(): Uint8Array {
    const seed = this.#random(KEY_BYTES);
    // A random source that disposed of the handshake ended it; install nothing.
    if (this.#step === "failed") fail("failed", "The handshake ended while its random source ran.");
    if (!(seed instanceof Uint8Array)) fail("bad_key", "The random source returned no bytes.");
    // Copied natively, so no iterator of the returned array runs; the copy is wiped after.
    const owned = new Uint8Array(seed);
    try {
      this.#ephemeral = keyPairFromSecret(owned);
    } finally {
      owned.fill(0);
    }
    if (this.#random === secureRandomBytes) seed.fill(0);
    this.#symmetric.mixHash(this.#ephemeral.publicKey);
    return this.#ephemeral.publicKey;
  }

  /** Initiator: `-> e, es, s, ss` and the payload. */
  writeMessage1(payload: Uint8Array): Uint8Array {
    return this.#run("write1", "read2", () => {
      const e = this.#newEphemeral();
      this.#mixDh(this.#ephemeral!.secretKey, this.#remoteStatic!);
      const s = this.#symmetric.encryptAndHash(this.#static.publicKey);
      this.#mixDh(this.#static.secretKey, this.#remoteStatic!);
      return checkSize(concatBytes(e, s, this.#symmetric.encryptAndHash(payload)));
    });
  }

  /** Responder: reads message 1 and returns its payload. */
  readMessage1(message: Uint8Array): Uint8Array {
    return this.#run("read1", "write2", () => {
      if (message.length < KEY_BYTES + KEY_BYTES + TAG_BYTES + TAG_BYTES) {
        fail("malformed", "Handshake message 1 is too short.");
      }
      checkSize(message);
      const re = message.subarray(0, KEY_BYTES);
      this.#remoteEphemeral = Uint8Array.from(re);
      this.#symmetric.mixHash(re);
      this.#mixDh(this.#static.secretKey, re);
      const rs = this.#symmetric.decryptAndHash(
        message.subarray(KEY_BYTES, KEY_BYTES + KEY_BYTES + TAG_BYTES),
      );
      this.#mixDh(this.#static.secretKey, rs);
      this.#remoteStatic = rs;
      return this.#symmetric.decryptAndHash(message.subarray(KEY_BYTES + KEY_BYTES + TAG_BYTES));
    });
  }

  /** Responder: `<- e, ee, se` and the payload. Completes the handshake. */
  writeMessage2(payload: Uint8Array): Uint8Array {
    return this.#run("write2", "done", () => {
      const e = this.#newEphemeral();
      this.#mixDh(this.#ephemeral!.secretKey, this.#remoteEphemeral!);
      this.#mixDh(this.#ephemeral!.secretKey, this.#remoteStatic!);
      const message = checkSize(concatBytes(e, this.#symmetric.encryptAndHash(payload)));
      const [initiatorToResponder, responderToInitiator] = this.#symmetric.split();
      this.#finish(responderToInitiator, initiatorToResponder);
      return message;
    });
  }

  /** Initiator: reads message 2 and returns its payload. Completes the handshake. */
  readMessage2(message: Uint8Array): Uint8Array {
    return this.#run("read2", "done", () => {
      if (message.length < KEY_BYTES + TAG_BYTES) {
        fail("malformed", "Handshake message 2 is too short.");
      }
      checkSize(message);
      const re = message.subarray(0, KEY_BYTES);
      this.#symmetric.mixHash(re);
      this.#mixDh(this.#ephemeral!.secretKey, re);
      this.#mixDh(this.#static.secretKey, re);
      const payload = this.#symmetric.decryptAndHash(message.subarray(KEY_BYTES));
      const [initiatorToResponder, responderToInitiator] = this.#symmetric.split();
      this.#finish(initiatorToResponder, responderToInitiator);
      return payload;
    });
  }

  #finish(send: CipherState, receive: CipherState): void {
    this.#keys = { send, receive, handshakeHash: this.#symmetric.handshakeHash };
    // Section 5.3: the ephemeral keys are no longer needed once the handshake is done.
    this.#ephemeral?.secretKey.fill(0);
    this.#ephemeral = null;
    this.#remoteEphemeral?.fill(0);
    this.#remoteEphemeral = null;
  }
}

function checkSize(message: Uint8Array): Uint8Array {
  if (message.length > NOISE_MAX_MESSAGE_BYTES) {
    fail("malformed", "A Noise message is at most 65535 bytes.");
  }
  return message;
}
