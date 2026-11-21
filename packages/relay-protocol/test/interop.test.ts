// Noise IK against a second, independent implementation: the IK path written again here on
// Node's OpenSSL bindings (X25519, RFC 5869 HKDF with SHA-256, ChaCha20-Poly1305), with each
// implementation on each end in turn. It needs no network, so CI runs it.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  channelPrologue,
  IKHandshake,
  keyPairFromSecret,
  NOISE_PROTOCOL_NAME,
  type TransportKeys,
} from "../src/index.ts";
import { hex, RELAY_ID } from "./helpers.ts";
import cacophony from "./vectors/cacophony-ik.json";

const EMPTY = Buffer.alloc(0);
// DER prefixes for raw 32-byte X25519 keys (RFC 8410).
const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");

const secretKeyObject = (raw: Uint8Array): KeyObject =>
  createPrivateKey({ key: Buffer.concat([PKCS8_X25519, raw]), format: "der", type: "pkcs8" });
const publicKeyObject = (raw: Uint8Array): KeyObject =>
  createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: "der", type: "spki" });
const publicOf = (secret: Uint8Array): Buffer =>
  createPublicKey(secretKeyObject(secret)).export({ format: "der", type: "spki" }).subarray(-32);
const dh = (secret: Uint8Array, peer: Uint8Array): Buffer =>
  diffieHellman({ privateKey: secretKeyObject(secret), publicKey: publicKeyObject(peer) });
const sha256 = (...parts: Uint8Array[]): Buffer =>
  createHash("sha256").update(Buffer.concat(parts)).digest();
const freshSecret = (): Buffer =>
  generateKeyPairSync("x25519").privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);

function aead(
  encrypt: boolean,
  key: Uint8Array,
  counter: bigint,
  ad: Uint8Array,
  data: Uint8Array,
) {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64LE(counter, 4);
  if (encrypt) {
    const cipher = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
    cipher.setAAD(ad);
    return Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);
  }
  const decipher = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  decipher.setAAD(ad);
  decipher.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
}

/** The other implementation: one side of an IK handshake, then its transport. */
class Reference {
  #ck: Buffer;
  #h: Buffer;
  #k: Buffer | null = null;
  #re: Uint8Array | null = null;
  #rs: Uint8Array | null;
  #sendCounter = 0n;
  #receiveCounter = 0n;
  #send: Buffer | null = null;
  #receive: Buffer | null = null;

  readonly initiator: boolean;
  readonly s: Uint8Array;
  readonly e: Uint8Array;

  constructor(
    initiator: boolean,
    s: Uint8Array,
    e: Uint8Array,
    prologue: Uint8Array,
    responderPublic: Uint8Array,
  ) {
    this.initiator = initiator;
    this.s = s;
    this.e = e;
    const name = Buffer.from(NOISE_PROTOCOL_NAME, "utf8");
    expect(name.length).toBe(32);
    this.#ck = name;
    this.#h = sha256(sha256(name, prologue), responderPublic);
    this.#rs = initiator ? responderPublic : null;
  }

  get h(): Buffer {
    return this.#h;
  }

  #mixKey(input: Uint8Array): void {
    const out = Buffer.from(hkdfSync("sha256", input, this.#ck, EMPTY, 64));
    this.#ck = out.subarray(0, 32);
    this.#k = out.subarray(32);
  }

  #seal(plaintext: Uint8Array): Buffer {
    const out = aead(true, this.#k!, 0n, this.#h, plaintext);
    this.#h = sha256(this.#h, out);
    return out;
  }

  #open(ciphertext: Uint8Array): Buffer {
    const out = aead(false, this.#k!, 0n, this.#h, ciphertext);
    this.#h = sha256(this.#h, ciphertext);
    return out;
  }

  write1(payload: Uint8Array): Buffer {
    const e = publicOf(this.e);
    this.#h = sha256(this.#h, e);
    this.#mixKey(dh(this.e, this.#rs!));
    const s = this.#seal(publicOf(this.s));
    this.#mixKey(dh(this.s, this.#rs!));
    return Buffer.concat([e, s, this.#seal(payload)]);
  }

  read1(message: Uint8Array): Buffer {
    this.#re = message.subarray(0, 32);
    this.#h = sha256(this.#h, this.#re);
    this.#mixKey(dh(this.s, this.#re));
    this.#rs = this.#open(message.subarray(32, 80));
    this.#mixKey(dh(this.s, this.#rs));
    return this.#open(message.subarray(80));
  }

  write2(payload: Uint8Array): Buffer {
    const e = publicOf(this.e);
    this.#h = sha256(this.#h, e);
    this.#mixKey(dh(this.e, this.#re!));
    this.#mixKey(dh(this.e, this.#rs!));
    const out = Buffer.concat([e, this.#seal(payload)]);
    this.#split();
    return out;
  }

  read2(message: Uint8Array): Buffer {
    const re = message.subarray(0, 32);
    this.#h = sha256(this.#h, re);
    this.#mixKey(dh(this.e, re));
    this.#mixKey(dh(this.s, re));
    const payload = this.#open(message.subarray(32));
    this.#split();
    return payload;
  }

  #split(): void {
    const out = Buffer.from(hkdfSync("sha256", EMPTY, this.#ck, EMPTY, 64));
    const [k1, k2] = [out.subarray(0, 32), out.subarray(32)];
    this.#send = this.initiator ? k1 : k2;
    this.#receive = this.initiator ? k2 : k1;
  }

  send(plaintext: Uint8Array): Buffer {
    return aead(true, this.#send!, this.#sendCounter++, EMPTY, plaintext);
  }

  receive(ciphertext: Uint8Array): Buffer {
    return aead(false, this.#receive!, this.#receiveCounter++, EMPTY, ciphertext);
  }
}

interface Setup {
  readonly initiatorStatic: Uint8Array;
  readonly responderStatic: Uint8Array;
  readonly initiatorEphemeral: Uint8Array;
  readonly responderEphemeral: Uint8Array;
  readonly prologue: Uint8Array;
}

/**
 * Runs the handshake with the package on one end and the reference on the other, then
 * `transport` messages, each from the side its flag names. Returns every ciphertext.
 */
function run(
  setup: Setup,
  packageIsInitiator: boolean,
  payloads: [Uint8Array, Uint8Array],
  transport: readonly { readonly fromInitiator: boolean; readonly payload: Uint8Array }[],
): { handshake: [Buffer, Buffer]; hash: Buffer; transport: Buffer[] } {
  const responderPublic = publicOf(setup.responderStatic);
  const pkg = new IKHandshake({
    initiator: packageIsInitiator,
    prologue: setup.prologue,
    staticKey: keyPairFromSecret(
      packageIsInitiator ? setup.initiatorStatic : setup.responderStatic,
    ),
    ...(packageIsInitiator ? { remoteStaticKey: responderPublic } : {}),
    random: () => (packageIsInitiator ? setup.initiatorEphemeral : setup.responderEphemeral),
  });
  const ref = new Reference(
    !packageIsInitiator,
    packageIsInitiator ? setup.responderStatic : setup.initiatorStatic,
    packageIsInitiator ? setup.responderEphemeral : setup.initiatorEphemeral,
    setup.prologue,
    responderPublic,
  );
  let m1: Buffer;
  let m2: Buffer;
  if (packageIsInitiator) {
    m1 = Buffer.from(pkg.writeMessage1(payloads[0]));
    expect(ref.read1(m1)).toEqual(Buffer.from(payloads[0]));
    m2 = ref.write2(payloads[1]);
    expect(Buffer.from(pkg.readMessage2(m2))).toEqual(Buffer.from(payloads[1]));
  } else {
    m1 = ref.write1(payloads[0]);
    expect(Buffer.from(pkg.readMessage1(m1))).toEqual(Buffer.from(payloads[0]));
    expect(Buffer.from(pkg.remoteStaticKey!)).toEqual(publicOf(setup.initiatorStatic));
    m2 = Buffer.from(pkg.writeMessage2(payloads[1]));
    expect(ref.read2(m2)).toEqual(Buffer.from(payloads[1]));
  }
  const keys: TransportKeys = pkg.transportKeys;
  expect(Buffer.from(keys.handshakeHash)).toEqual(ref.h);
  const ciphertexts = transport.map(({ fromInitiator, payload }) => {
    const fromPackage = fromInitiator === packageIsInitiator;
    const ciphertext = fromPackage
      ? Buffer.from(keys.send.encrypt(EMPTY, payload))
      : ref.send(payload);
    const plaintext = fromPackage
      ? ref.receive(ciphertext)
      : Buffer.from(keys.receive.decrypt(EMPTY, ciphertext));
    expect(plaintext).toEqual(Buffer.from(payload));
    return ciphertext;
  });
  return { handshake: [m1, m2], hash: ref.h, transport: ciphertexts };
}

describe("Noise IK interoperation with an independent OpenSSL-backed implementation", () => {
  const [vector] = cacophony.vectors;

  for (const packageIsInitiator of [true, false]) {
    const role = packageIsInitiator ? "initiator" : "responder";

    it(`reproduces the Cacophony vector with the package as ${role}`, () => {
      const [m1, m2, ...rest] = vector!.messages;
      const result = run(
        {
          initiatorStatic: hex(vector!.init_static),
          responderStatic: hex(vector!.resp_static),
          initiatorEphemeral: hex(vector!.init_ephemeral),
          responderEphemeral: hex(vector!.resp_ephemeral),
          prologue: hex(vector!.init_prologue),
        },
        packageIsInitiator,
        [hex(m1!.payload), hex(m2!.payload)],
        rest.map((m, i) => ({ fromInitiator: i % 2 === 0, payload: hex(m.payload) })),
      );
      expect(result.handshake.map((m) => m.toString("hex"))).toEqual([
        m1!.ciphertext,
        m2!.ciphertext,
      ]);
      expect(result.hash.toString("hex")).toBe(vector!.handshake_hash);
      expect(result.transport.map((c) => c.toString("hex"))).toEqual(rest.map((m) => m.ciphertext));
    });

    it(`talks to it with fresh keys, Clawtrate's prologue and 600 messages, the package as ${role}`, () => {
      const transport = [
        { fromInitiator: true, payload: new Uint8Array(0) },
        { fromInitiator: true, payload: new Uint8Array(65_519).fill(7) },
        { fromInitiator: false, payload: new Uint8Array(65_519).fill(8) },
        ...Array.from({ length: 597 }, (_, i) => ({
          fromInitiator: i % 3 !== 0,
          payload: Buffer.from(`message ${i}`),
        })),
      ];
      run(
        {
          initiatorStatic: freshSecret(),
          responderStatic: freshSecret(),
          initiatorEphemeral: freshSecret(),
          responderEphemeral: freshSecret(),
          prologue: channelPrologue(RELAY_ID),
        },
        packageIsInitiator,
        [Uint8Array.of(1, 1, ...new Uint8Array(32).fill(9)), Uint8Array.of(1, 0)],
        transport,
      );
    });
  }
});
