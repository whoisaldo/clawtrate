// Seeded fuzzing of every decoder. Each run is the same; a failure names its seed and input.
// The properties: a decoder either returns a value that encodes back to its exact input, or
// throws `RelayProtocolError` and nothing else. A channel fed changed frames fails, never
// opens, and never delivers text. A changed register proof is never accepted.

import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import {
  createRegisterNonce,
  createRegisterProof,
  decodeAnswer,
  decodeConnectorToRelay,
  decodeEndpointToRelay,
  decodeFrame,
  decodeHello,
  decodeRecord,
  generateKeyPair,
  decodeRelayToConnector,
  decodeRelayToEndpoint,
  encodeAnswer,
  encodeFrame,
  encodeHello,
  encodeRecord,
  encodeRelayMessage,
  MAX_FRAME_BYTES,
  MemoryReplayStore,
  relayIdFromKey,
  RelayProtocolError,
  Responder,
  verifyRegisterProof,
  type ChannelEvent,
  type RelayMessage,
} from "../src/index.ts";
import { makePair, openPair, RELAY_ID, sends, seeded, TestGate, toHex } from "./helpers.ts";

type Rng = ReturnType<typeof seeded>;

/** Random bytes, often around the sizes the decoders care about. */
function randomInput(rng: Rng): Uint8Array {
  const sizes = [0, 1, 2, 3, 17, 18, 48, 50, 96, 98, 112, 114, 160, 162, 300];
  const length = rng.next() < 0.7 ? sizes[rng.int(sizes.length)]! : rng.int(400);
  const bytes = rng.bytes(length);
  // Often make the header plausible, so the fuzzer gets past the first checks.
  if (length > 0 && rng.next() < 0.6) bytes[0] = 1;
  if (length > 1 && rng.next() < 0.6) bytes[1] = 1 + rng.int(3);
  return bytes;
}

/** One to four changes: flipped bits, replaced, inserted or deleted bytes, or a cut. */
function mutate(rng: Rng, input: Uint8Array): Uint8Array {
  let bytes = [...input];
  for (let n = 1 + rng.int(4); n > 0; n--) {
    const at = rng.int(bytes.length + 1);
    switch (rng.int(5)) {
      case 0:
        if (at < bytes.length) bytes[at]! ^= 1 << rng.int(8);
        break;
      case 1:
        if (at < bytes.length) bytes[at] = rng.int(256);
        break;
      case 2:
        bytes.splice(at, 0, rng.int(256));
        break;
      case 3:
        bytes.splice(at, 1);
        break;
      case 4:
        bytes = bytes.slice(0, at);
        break;
    }
  }
  return Uint8Array.from(bytes);
}

function mutateText(rng: Rng, text: string): string {
  const alphabet = '{}[]":,tnulfe0123456789.-_ \\abcdefghijklmnopqrstuvwxyzAZ=é\u2028';
  let chars = [...text];
  for (let n = 1 + rng.int(3); n > 0; n--) {
    const at = rng.int(chars.length + 1);
    const char = alphabet[rng.int(alphabet.length)]!;
    switch (rng.int(3)) {
      case 0:
        chars[at] = char;
        break;
      case 1:
        chars.splice(at, 0, char);
        break;
      case 2:
        chars.splice(at, 1);
        break;
    }
  }
  chars = chars.filter((c) => c !== undefined);
  return chars.join("");
}

/** Runs `decode`; it must return or throw `RelayProtocolError`. Returns the value or null. */
function attempt<T>(decode: () => T, input: () => string): T | null {
  try {
    return decode();
  } catch (error) {
    if (!(error instanceof RelayProtocolError)) {
      throw new Error(`Decoder threw ${String(error)} for ${input()}`, { cause: error });
    }
    return null;
  }
}

// The crypto-heavy cases take a few seconds; a busy CI runner may take several times longer.
describe("decoder fuzzing", { timeout: 60_000 }, () => {
  it("frames: random and changed bytes decode to the exact input or throw RelayProtocolError", () => {
    const rng = seeded(0xc1a77);
    const valid = [
      encodeFrame({ type: "handshake1", body: rng.bytes(130) }),
      encodeFrame({ type: "handshake2", body: rng.bytes(50) }),
      encodeFrame({ type: "transport", body: rng.bytes(40) }),
    ];
    let decoded = 0;
    for (let i = 0; i < 30_000; i++) {
      const input = i % 2 === 0 ? randomInput(rng) : mutate(rng, valid[i % valid.length]!);
      const frame = attempt(
        () => decodeFrame(input),
        () => toHex(input),
      );
      if (frame === null) continue;
      decoded++;
      expect(encodeFrame(frame)).toEqual(input);
    }
    expect(decoded).toBeGreaterThan(1_000);
    for (const length of [MAX_FRAME_BYTES, MAX_FRAME_BYTES + 1, 1 << 20]) {
      attempt(
        () => decodeFrame(new Uint8Array(length).fill(3, 1, 2).fill(1, 0, 1)),
        () => `${length} bytes`,
      );
    }
  });

  it("records, hellos and answers: random and changed bytes decode to the exact input or throw", () => {
    const rng = seeded(0x5eed);
    const valid = [
      encodeRecord({ kind: "confirm" }),
      encodeRecord({ kind: "admission", answer: "accepted" }),
      encodeRecord({ kind: "text-end", data: rng.bytes(3) }),
      encodeRecord({ kind: "ping", data: rng.bytes(8) }),
      encodeRecord({ kind: "close", code: 4001, reason: "é done" }),
    ];
    const decoders: [string, (bytes: Uint8Array) => Uint8Array | null][] = [
      ["record", (b) => encodeRecord(decodeRecord(b))],
      ["hello", (b) => encodeHello(decodeHello(b))],
      ["answer", (b) => encodeAnswer(decodeAnswer(b))],
    ];
    let decoded = 0;
    for (let i = 0; i < 30_000; i++) {
      const input = i % 2 === 0 ? randomInput(rng) : mutate(rng, valid[i % valid.length]!);
      if (rng.next() < 0.5 && input.length > 0) input[0] = 1 + rng.int(7);
      for (const [name, roundTrip] of decoders) {
        const encoded = attempt(
          () => roundTrip(input),
          () => `${name} ${toHex(input)}`,
        );
        if (encoded === null) continue;
        decoded++;
        expect(encoded, `${name} ${toHex(input)}`).toEqual(input);
      }
    }
    expect(decoded).toBeGreaterThan(1_000);
  });

  it("relay messages: random and changed text decodes to a value that encodes back to itself, or throws", () => {
    const rng = seeded(0x7e17);
    const valid = [
      encodeRelayMessage({ t: "challenge", nonce: createRegisterNonce(() => rng.bytes(32)) }),
      encodeRelayMessage({ t: "dial", session: "AAAAAAAAAAAAAAAAAAAAAA", from: "2001:db8::1" }),
      encodeRelayMessage({ t: "register", proof: "abc.def" }),
      encodeRelayMessage({ t: "error", code: "rate_limited" }),
      encodeRelayMessage({ t: "open" }),
      encodeRelayMessage({ t: "registered" }),
      '{"t":"ping"}',
    ];
    const decoders = [
      decodeRelayToConnector,
      decodeConnectorToRelay,
      decodeRelayToEndpoint,
      decodeEndpointToRelay,
    ];
    let decoded = 0;
    for (let i = 0; i < 30_000; i++) {
      const input = mutateText(rng, valid[i % valid.length]!);
      for (const decode of decoders) {
        const message = attempt<RelayMessage>(
          () => decode(input),
          () => JSON.stringify(input),
        );
        if (message === null) continue;
        decoded++;
        expect(decode(encodeRelayMessage(message))).toEqual(message);
      }
    }
    expect(decoded).toBeGreaterThan(500);
    for (const input of [undefined, null, 7, {}, [], new Uint8Array(3)]) {
      for (const decode of decoders)
        attempt(
          () => decode(input),
          () => String(input),
        );
    }
  });

  it("channels: changed handshake and transport frames fail the receiver; nothing opens or arrives", () => {
    const rng = seeded(0xface);
    const unwanted = (events: ChannelEvent[]) =>
      events.some((e) => e.type === "open" || e.type === "text");
    for (let i = 0; i < 300; i++) {
      const pair = makePair();
      const stage = i % 3;
      if (stage === 0) {
        const hs1 = pair.phone.start();
        const changed = mutate(rng, hs1);
        if (toHex(changed) === toHex(hs1)) continue;
        expect(() => pair.connector.receive(changed), toHex(changed)).toThrow(RelayProtocolError);
        expect(pair.gate.enrolled).toEqual([]);
      } else if (stage === 1) {
        const [hs2] = sends(pair.connector.receive(pair.phone.start()));
        const changed = mutate(rng, hs2!);
        if (toHex(changed) === toHex(hs2!)) continue;
        let events: ChannelEvent[] = [];
        expect(() => (events = pair.phone.receive(changed)), toHex(changed)).toThrow(
          RelayProtocolError,
        );
        expect(unwanted(events)).toBe(false);
      } else {
        openPair(pair);
        const [frame] = pair.phone.sendText(`message ${i}`);
        const changed = mutate(rng, frame!);
        if (toHex(changed) === toHex(frame!)) continue;
        expect(() => pair.connector.receive(changed), toHex(changed)).toThrow(RelayProtocolError);
      }
    }
  });

  it("channels: random frames at every stage throw RelayProtocolError and nothing else", () => {
    const rng = seeded(0xbead);
    const connectorKey = generateKeyPair();
    const gate = new TestGate();
    // A connector waiting for message 1 costs nothing to make, so it gets the most inputs.
    for (let i = 0; i < 5_000; i++) {
      const connector = new Responder({ relayId: RELAY_ID, staticKey: connectorKey, gate });
      const input = randomInput(rng);
      attempt(
        () => connector.receive(input),
        () => toHex(input),
      );
    }
    for (let i = 0; i < 300; i++) {
      const pair = makePair();
      if (i % 2 === 0) pair.phone.start();
      else openPair(pair);
      const input = randomInput(rng);
      for (const end of [pair.phone, pair.connector]) {
        if (end.currentState === "handshaking" || end.currentState === "open") {
          attempt(
            () => end.receive(input),
            () => toHex(input),
          );
        }
      }
    }
  });

  it("register proofs: a changed proof is never accepted, and no input throws", async () => {
    const rng = seeded(0x9e9e);
    const secretKey = ed25519.utils.randomSecretKey();
    const relayId = relayIdFromKey(ed25519.getPublicKey(secretKey));
    const nonce = createRegisterNonce();
    const audience = "wss://relay.example.test";
    const nowMs = Date.UTC(2026, 10, 20);
    const proof = createRegisterProof({ secretKey, audience, nonce, nowMs });
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.=+/ ";
    for (let i = 0; i < 2_000; i++) {
      const chars = [...proof];
      for (let n = 1 + rng.int(3); n > 0; n--) {
        const at = rng.int(chars.length + 1);
        const char = alphabet[rng.int(alphabet.length)]!;
        if (rng.next() < 0.6) chars[at] = char;
        else if (rng.next() < 0.5) chars.splice(at, 0, char);
        else chars.splice(at, 1);
      }
      const changed = chars.join("");
      const result = await verifyRegisterProof({
        proof: changed,
        relayId,
        audience,
        nonce,
        nowMs,
        replay: new MemoryReplayStore(),
      });
      expect(result.ok, changed).toBe(changed === proof);
    }
  });
});
