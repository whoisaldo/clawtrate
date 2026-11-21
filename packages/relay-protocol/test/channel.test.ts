import { describe, expect, it } from "vitest";
import {
  Admission,
  channelPrologue,
  decodeFrame,
  encodeFrame,
  encodeHello,
  encodeRecord,
  EnrollmentOffer,
  generateKeyPair,
  IKHandshake,
  Initiator,
  MAX_FRAME_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_RECORD_DATA_BYTES,
  relayIdFromKey,
  RelayProtocolError,
  Responder,
} from "../src/index.ts";
import { admissionOf, deliver, makePair, openPair, RELAY_ID, sends, TestGate } from "./helpers.ts";

function texts(events: ReturnType<typeof deliver>): string[] {
  return events.flatMap((event) => (event.type === "text" ? [event.text] : []));
}

describe("the end-to-end channel", () => {
  it("enrolls a new phone with the pairing code's secret, then carries text both ways", () => {
    const pair = makePair();
    expect(pair.gate.enrolled).toEqual([]);
    openPair(pair);
    expect(pair.phone.currentState).toBe("open");
    expect(pair.connector.currentState).toBe("open");
    expect(pair.gate.enrolled).toEqual([pair.phoneKey.publicKey]);
    expect(pair.gate.offer!.used).toBe(true);
    expect(pair.connector.phoneKey).toEqual(pair.phoneKey.publicKey);
    expect(pair.phone.handshakeHash).toEqual(pair.connector.handshakeHash);

    expect(texts(deliver(pair.connector, pair.phone.sendText('{"type":"req"}')))).toEqual([
      '{"type":"req"}',
    ]);
    expect(texts(deliver(pair.phone, pair.connector.sendText("é ✓ 𝄞")))).toEqual(["é ✓ 𝄞"]);
  });

  it("lets an enrolled phone back in without a secret, and the next session has its own keys", () => {
    const first = makePair();
    openPair(first);
    const phone = new Initiator({
      relayId: RELAY_ID,
      connectorKey: first.connectorKey.publicKey,
      staticKey: first.phoneKey,
    });
    const connector = new Responder({
      relayId: RELAY_ID,
      staticKey: first.connectorKey,
      gate: first.gate,
    });
    openPair({ ...first, phone, connector });
    expect(phone.handshakeHash).not.toEqual(first.phone.handshakeHash);
    expect(texts(deliver(connector, phone.sendText("again")))).toEqual(["again"]);
  });

  it("turns away a phone that is not enrolled and sent no secret, before anything opens", () => {
    const pair = makePair({ enroll: false });
    const events = pair.connector.receive(pair.phone.start());
    expect(events.map((e) => e.type)).toEqual(["send", "refused"]);
    expect(pair.connector.currentState).toBe("closed");
    expect(pair.phone.receive(sends(events)[0]!)).toEqual([
      { type: "refused", reason: "not_enrolled" },
    ]);
    expect(pair.phone.currentState).toBe("closed");
    expect(pair.gate.enrolled).toEqual([]);
    expect(() => pair.phone.sendText("x")).toThrow(RelayProtocolError);
  });

  it("refuses a wrong, expired or already used secret", () => {
    // Wrong secret.
    const wrong = makePair();
    wrong.gate.offer = new EnrollmentOffer(new Uint8Array(32).fill(1), 60_000);
    const wrongAnswer = sends(wrong.connector.receive(wrong.phone.start()));
    expect(wrong.phone.receive(wrongAnswer[0]!)).toEqual([
      { type: "refused", reason: "enrollment_refused" },
    ]);

    // Expired.
    const expired = makePair();
    expired.gate.nowMs = 60_000;
    const expiredAnswer = sends(expired.connector.receive(expired.phone.start()));
    expect(expired.phone.receive(expiredAnswer[0]!)).toEqual([
      { type: "refused", reason: "enrollment_refused" },
    ]);
    expect(expired.gate.offer!.used).toBe(false);

    // Used by one phone, then offered by another.
    const used = makePair();
    openPair(used);
    const other = new Initiator({
      relayId: RELAY_ID,
      connectorKey: used.connectorKey.publicKey,
      staticKey: generateKeyPair(),
      enroll: new Uint8Array(32).fill(9),
    });
    const connector = new Responder({
      relayId: RELAY_ID,
      staticKey: used.connectorKey,
      gate: used.gate,
    });
    expect(other.receive(sends(connector.receive(other.start()))[0]!)).toEqual([
      { type: "refused", reason: "enrollment_refused" },
    ]);
    expect(used.gate.enrolled).toHaveLength(1);
  });

  it("an enrollment offer matches the whole secret and is spent once", () => {
    const secret = new Uint8Array(32).fill(5);
    const offer = new EnrollmentOffer(secret, 100);
    const almost = Uint8Array.from(secret);
    almost[31] = 6;
    expect(offer.matches(almost, 0)).toBe(false);
    expect(offer.matches(secret.subarray(0, 31), 0)).toBe(false);
    expect(offer.matches(secret, 100)).toBe(false);
    expect(offer.matches(secret, 99)).toBe(true);
    expect(offer.spend(100)).toBe(false);
    expect(offer.spend(99)).toBe(true);
    expect(offer.spend(99)).toBe(false);
    expect(offer.matches(secret, 0)).toBe(false);
    expect(() => new EnrollmentOffer(new Uint8Array(16), 100)).toThrow(RelayProtocolError);
  });

  it("opens only after the confirm record and the host's admission, in that order", () => {
    const pair = makePair();
    const [hs2] = sends(pair.connector.receive(pair.phone.start()));
    expect(pair.connector.currentState).toBe("confirming");
    expect(() => pair.connector.sendText("too early")).toThrow(/not open/);
    const phoneEvents = pair.phone.receive(hs2!);
    // Message 2's "accepted" is provisional: the phone sends confirm but does not open.
    expect(phoneEvents.map((e) => e.type)).toEqual(["send"]);
    expect(pair.phone.currentState).toBe("confirming");
    expect(() => pair.phone.sendText("too early")).toThrow(/not open/);
    const connectorEvents = pair.connector.receive(sends(phoneEvents)[0]!);
    expect(connectorEvents.map((e) => e.type)).toEqual(["admit"]);
    expect(pair.connector.currentState).toBe("admitting");
    const attempt = pair.connector.beginAdmission(admissionOf(connectorEvents));
    const settled = pair.connector.settle(attempt, pair.gate.commit(attempt));
    if (!settled.admitted) throw new Error("Not admitted.");
    expect(settled.phoneKey).toEqual(pair.phoneKey.publicKey);
    expect(pair.phone.receive(settled.frame)).toEqual([{ type: "open" }]);
  });

  it("refuses frames from the phone while the host decides, and admissions not its own", () => {
    const pair = makePair();
    expect(() => pair.connector.beginAdmission(new Admission())).toThrow(
      expect.objectContaining({ code: "unexpected" }),
    );
    const [hs2] = sends(pair.connector.receive(pair.phone.start()));
    const [confirm] = sends(pair.phone.receive(hs2!));
    pair.connector.receive(confirm!);
    expect(() => pair.connector.receive(confirm!)).toThrow(RelayProtocolError);
    expect(pair.connector.currentState).toBe("failed");
  });

  it("refuses an authenticated first record from the phone that is not confirm", () => {
    const pair = makePair();
    // A phone built from the handshake alone, so its first record can be anything.
    const phone = new IKHandshake({
      initiator: true,
      prologue: channelPrologue(RELAY_ID),
      staticKey: pair.phoneKey,
      remoteStaticKey: pair.connectorKey.publicKey,
    });
    const hs1 = encodeFrame({ type: "handshake1", body: phone.writeMessage1(encodeHello({})) });
    pair.gate.enrolled.push(Uint8Array.from(pair.phoneKey.publicKey));
    const [hs2] = sends(pair.connector.receive(hs1));
    phone.readMessage2(decodeFrame(hs2!).body);
    const text = encodeRecord({ kind: "text-end", data: Uint8Array.of(104, 105) });
    const body = phone.transportKeys.send.encrypt(new Uint8Array(0), text);
    expect(() => pair.connector.receive(encodeFrame({ type: "transport", body }))).toThrow(
      expect.objectContaining({ code: "unexpected" }),
    );
    expect(pair.connector.currentState).toBe("failed");
    expect(pair.gate.commits).toBe(0);
  });

  it("fails the handshake when the phone pinned another connector key", () => {
    const pair = makePair();
    const impostor = new Responder({
      relayId: RELAY_ID,
      staticKey: generateKeyPair(),
      gate: pair.gate,
    });
    expect(() => impostor.receive(pair.phone.start())).toThrow(
      expect.objectContaining({ code: "decrypt_failed" }),
    );
    expect(impostor.currentState).toBe("failed");
    expect(pair.gate.enrolled).toEqual([]);
    expect(pair.gate.offer!.used).toBe(false);
  });

  it("fails the handshake when the two ends name different relay ids", () => {
    const pair = makePair({ relayId: relayIdFromKey(new Uint8Array(32).fill(8)) });
    expect(() => pair.connector.receive(pair.phone.start())).toThrow(
      expect.objectContaining({ code: "decrypt_failed" }),
    );
    expect(pair.gate.offer!.used).toBe(false);
  });

  it("refuses a relay id that is not canonical", () => {
    const connectorKey = generateKeyPair();
    for (const relayId of ["", "A".repeat(26), `${RELAY_ID.slice(0, 25)}b`, `${RELAY_ID}a`]) {
      expect(
        () =>
          new Initiator({
            relayId,
            connectorKey: connectorKey.publicKey,
            staticKey: generateKeyPair(),
          }),
      ).toThrow(expect.objectContaining({ code: "bad_relay_id" }));
    }
  });

  it("splits a large message into frames under the cap, cutting inside characters, and joins it", () => {
    const pair = makePair();
    openPair(pair);
    // Three-byte characters, so record boundaries fall inside a character.
    const text = "✓".repeat(MAX_RECORD_DATA_BYTES);
    const frames = pair.phone.sendText(text);
    expect(frames).toHaveLength(3);
    for (const frame of frames) expect(frame.length).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    expect(frames.slice(0, -1).map((f) => f.length)).toEqual([MAX_FRAME_BYTES, MAX_FRAME_BYTES]);
    expect(deliver(pair.connector, frames.slice(0, -1))).toEqual([]);
    expect(texts(deliver(pair.connector, frames.slice(-1)))).toEqual([text]);
  });

  it("sends an empty message as one frame", () => {
    const pair = makePair();
    openPair(pair);
    const frames = pair.connector.sendText("");
    expect(frames).toHaveLength(1);
    expect(texts(deliver(pair.phone, frames))).toEqual([""]);
  });

  it("keeps a leading byte order mark as text", () => {
    const pair = makePair();
    openPair(pair);
    expect(texts(deliver(pair.phone, pair.connector.sendText("﻿hi")))).toEqual(["﻿hi"]);
  });

  it("refuses to send a message over the gateway's frame ceiling, and the channel stays open", () => {
    const pair = makePair();
    openPair(pair);
    expect(() => pair.phone.sendText("x".repeat(MAX_MESSAGE_BYTES + 1))).toThrow(
      expect.objectContaining({ code: "message_too_large" }),
    );
    expect(pair.phone.currentState).toBe("open");
    expect(
      texts(deliver(pair.connector, pair.phone.sendText("x".repeat(MAX_MESSAGE_BYTES)))),
    ).toEqual(["x".repeat(MAX_MESSAGE_BYTES)]);
  });

  it("answers a ping with a pong carrying the same bytes", () => {
    const pair = makePair();
    openPair(pair);
    const pong = sends(pair.connector.receive(pair.phone.ping(Uint8Array.of(1, 2, 3))));
    expect(pair.phone.receive(pong[0]!)).toEqual([{ type: "pong", data: Uint8Array.of(1, 2, 3) }]);
    expect(texts(deliver(pair.phone, pair.connector.sendText("after")))).toEqual(["after"]);
    expect(() => pair.phone.ping(new Uint8Array(33))).toThrow(RelayProtocolError);
  });

  it("carries a close code and reason, and nothing passes after it", () => {
    const pair = makePair();
    openPair(pair);
    const close = pair.connector.close(4008, "gateway closed");
    expect(pair.connector.currentState).toBe("closed");
    expect(pair.phone.receive(close)).toEqual([
      { type: "close", code: 4008, reason: "gateway closed" },
    ]);
    expect(pair.phone.currentState).toBe("closed");
    expect(() => pair.phone.sendText("late")).toThrow(expect.objectContaining({ code: "closed" }));
    expect(() => pair.phone.receive(close)).toThrow(expect.objectContaining({ code: "closed" }));
    expect(() => pair.connector.sendText("late")).toThrow(
      expect.objectContaining({ code: "closed" }),
    );
    expect(() => pair.connector.close(1006)).toThrow(RelayProtocolError);
  });

  it("refuses a close code an endpoint may not send", () => {
    const pair = makePair();
    openPair(pair);
    for (const code of [999, 1004, 1005, 1006, 1015, 2000, 5000, 1000.5]) {
      expect(() => pair.phone.close(code)).toThrow(RelayProtocolError);
    }
    expect(pair.phone.currentState).toBe("open");
  });

  it("frames carry only the version, the type and ciphertext the relay cannot read", () => {
    const pair = makePair();
    const { hs1 } = openPair(pair);
    const [frame] = pair.phone.sendText("secret words");
    expect(decodeFrame(frame!).type).toBe("transport");
    const plain = new TextEncoder().encode("secret words");
    const containsPlain = (bytes: Uint8Array) =>
      bytes.some((_, i) => plain.every((byte, j) => bytes[i + j] === byte));
    expect(containsPlain(frame!)).toBe(false);
    // The phone's static key travels encrypted in message 1.
    const phoneKey = pair.phoneKey.publicKey;
    expect(hs1.some((_, i) => phoneKey.every((byte, j) => hs1[i + j] === byte))).toBe(false);
  });

  it("keeps a gate error visible and fails the channel", () => {
    const gate = new TestGate();
    gate.check = () => {
      throw new Error("allowlist unreadable");
    };
    const connectorKey = generateKeyPair();
    const phone = new Initiator({
      relayId: RELAY_ID,
      connectorKey: connectorKey.publicKey,
      staticKey: generateKeyPair(),
    });
    const connector = new Responder({ relayId: RELAY_ID, staticKey: connectorKey, gate });
    expect(() => connector.receive(phone.start())).toThrow("allowlist unreadable");
    expect(connector.currentState).toBe("failed");
  });
});
