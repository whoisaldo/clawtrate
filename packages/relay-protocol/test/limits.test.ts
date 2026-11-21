// Bounded reassembly, a shared receive budget, the partial-message deadline, and ending a
// channel: exhaustion, abort and close.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  channelPrologue,
  decodeRecord,
  encodeFrame,
  encodeRecord,
  generateKeyPair,
  Initiator,
  MAX_MESSAGE_BYTES,
  MAX_PARTIAL_MESSAGE_MS,
  MAX_RECORD_DATA_BYTES,
  MAX_TEXT_RECORDS,
  ReceiveBudget,
  RelayProtocolError,
  Responder,
  type ChannelOptions,
  type ChannelRecord,
  type TransportKeys,
} from "../src/index.ts";
import { CipherState, IKHandshake } from "../src/noise.ts";
import { deliver, makePair, openPair, RELAY_ID, TestGate, type Pair } from "./helpers.ts";

afterEach(() => vi.restoreAllMocks());

/** A pair whose connector takes the given options. */
function pairWith(options: ChannelOptions, gate = new TestGate()): Pair {
  const phoneKey = generateKeyPair();
  const connectorKey = generateKeyPair();
  gate.enrolled.push(Uint8Array.from(phoneKey.publicKey));
  const phone = new Initiator({
    relayId: RELAY_ID,
    connectorKey: connectorKey.publicKey,
    staticKey: phoneKey,
  });
  const connector = new Responder({ relayId: RELAY_ID, staticKey: connectorKey, gate, ...options });
  const pair = { phone, connector, gate, phoneKey, connectorKey };
  openPair(pair);
  return pair;
}

function keysOf(channel: Initiator | Responder): TransportKeys {
  return (channel as unknown as { keys: TransportKeys }).keys;
}

const TWO_RECORDS = "x".repeat(MAX_RECORD_DATA_BYTES + 1);

/**
 * Seals records one at a time in the sender's order, the way a peer may interleave them; the
 * channel's own `sendText` makes all of a message's records at once.
 */
function sealAs(channel: Initiator | Responder, record: ChannelRecord): Uint8Array {
  return encodeFrame({
    type: "transport",
    body: keysOf(channel).send.encrypt(new Uint8Array(0), encodeRecord(record)),
  });
}
const FULL_PART: ChannelRecord = {
  kind: "text-part",
  data: new Uint8Array(MAX_RECORD_DATA_BYTES).fill(120),
};

describe("reassembly bounds", () => {
  it("a text-part record must be a full record, so a message takes at most 401 records", () => {
    expect(MAX_TEXT_RECORDS).toBe(401);
    for (const length of [1, MAX_RECORD_DATA_BYTES - 1]) {
      expect(() => decodeRecord(Uint8Array.of(2, ...new Uint8Array(length)))).toThrow(
        RelayProtocolError,
      );
      expect(() => encodeRecord({ kind: "text-part", data: new Uint8Array(length) })).toThrow(
        RelayProtocolError,
      );
    }
    const pair = makePair();
    openPair(pair);
    expect(pair.phone.sendText("x".repeat(MAX_MESSAGE_BYTES))).toHaveLength(MAX_TEXT_RECORDS);
  });

  it("refuses an oversize string before encoding it", () => {
    const pair = makePair();
    openPair(pair);
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    expect(() => pair.phone.sendText("x".repeat(MAX_MESSAGE_BYTES + 1))).toThrow(
      expect.objectContaining({ code: "message_too_large" }),
    );
    expect(encode).not.toHaveBeenCalled();
  });

  it("shares one receive budget across channels and gives it back", () => {
    const budget = new ReceiveBudget(MAX_RECORD_DATA_BYTES + 10);
    const a = pairWith({ budget });
    const b = pairWith({ budget });
    const [aPart] = a.phone.sendText(TWO_RECORDS);
    const [bPart] = b.phone.sendText(TWO_RECORDS);
    expect(a.connector.receive(aPart!)).toEqual([]);
    expect(budget.usedBytes).toBe(MAX_RECORD_DATA_BYTES);
    expect(a.connector.bufferedBytes).toBe(MAX_RECORD_DATA_BYTES);
    expect(() => b.connector.receive(bPart!)).toThrow(
      expect.objectContaining({ code: "over_budget" }),
    );
    expect(b.connector.currentState).toBe("failed");
    // Ending a channel mid-message gives its share back.
    a.connector.abort();
    expect(budget.usedBytes).toBe(0);
  });

  it("reserves room for the joined copy before allocating it, and gives it back", () => {
    const held = MAX_RECORD_DATA_BYTES + 1;
    // Room for the held records but not for the joined copy as well.
    const tight = new ReceiveBudget(2 * held - 1);
    const a = pairWith({ budget: tight });
    const [part, end] = a.phone.sendText(TWO_RECORDS);
    a.connector.receive(part!);
    expect(() => a.connector.receive(end!)).toThrow(
      expect.objectContaining({ code: "over_budget" }),
    );
    expect(tight.usedBytes).toBe(0);
    // Room for both: the message arrives and every byte comes back.
    const enough = new ReceiveBudget(2 * held);
    const b = pairWith({ budget: enough });
    expect(deliver(b.connector, b.phone.sendText(TWO_RECORDS))).toEqual([
      { type: "text", text: TWO_RECORDS },
    ]);
    expect(enough.usedBytes).toBe(0);
    // A join that fails strict UTF-8 still gives its reservation back.
    const c = pairWith({ budget: enough });
    c.connector.receive(sealAs(c.phone, FULL_PART));
    const bad = sealAs(c.phone, { kind: "text-end", data: Uint8Array.of(0xff) });
    expect(() => c.connector.receive(bad)).toThrow(expect.objectContaining({ code: "bad_utf8" }));
    expect(enough.usedBytes).toBe(0);
  });

  it("fails a message still unfinished after MAX_PARTIAL_MESSAGE_MS by the host's clock", () => {
    let now = 1_000;
    const pair = pairWith({ clock: () => now });
    pair.connector.receive(sealAs(pair.phone, FULL_PART));
    expect(pair.connector.partialMessageSince).toBe(1_000);
    // Keep-alives in between do not extend it.
    now += MAX_PARTIAL_MESSAGE_MS;
    const [pong] = pair.connector.receive(
      sealAs(pair.phone, { kind: "ping", data: new Uint8Array(0) }),
    );
    if (pong?.type !== "send") throw new Error("No pong.");
    now += 1;
    const end = sealAs(pair.phone, { kind: "text-end", data: Uint8Array.of(120) });
    expect(() => pair.connector.receive(end)).toThrow(RelayProtocolError);
    expect(pair.connector.currentState).toBe("failed");
    expect(pair.connector.bufferedBytes).toBe(0);
  });

  it("accepts a message finished exactly at the deadline", () => {
    let now = 0;
    const pair = pairWith({ clock: () => now });
    const [part, end] = pair.phone.sendText(TWO_RECORDS);
    pair.connector.receive(part!);
    expect(pair.connector.partialMessageDeadline).toBe(MAX_PARTIAL_MESSAGE_MS);
    now = MAX_PARTIAL_MESSAGE_MS;
    expect(pair.connector.expirePartialMessage()).toBe(false);
    expect(pair.connector.receive(end!)).toEqual([{ type: "text", text: TWO_RECORDS }]);
    expect(pair.connector.partialMessageSince).toBeNull();
  });

  it("checks the deadline on every record: a keep-alive after it fails the channel", () => {
    const budget = new ReceiveBudget(10 * MAX_RECORD_DATA_BYTES);
    let now = 0;
    const pair = pairWith({ clock: () => now, budget });
    pair.connector.receive(sealAs(pair.phone, FULL_PART));
    now = MAX_PARTIAL_MESSAGE_MS + 1;
    const ping = sealAs(pair.phone, { kind: "ping", data: new Uint8Array(0) });
    expect(() => pair.connector.receive(ping)).toThrow(
      expect.objectContaining({ code: "timed_out" }),
    );
    expect(pair.connector.bufferedBytes).toBe(0);
    expect(budget.usedBytes).toBe(0);
  });

  it("lets the host's timer expire a quiet message at the same boundary", () => {
    let now = 500;
    const pair = pairWith({ clock: () => now });
    expect(pair.connector.expirePartialMessage()).toBe(false);
    pair.connector.receive(sealAs(pair.phone, FULL_PART));
    now = 500 + MAX_PARTIAL_MESSAGE_MS;
    expect(pair.connector.expirePartialMessage()).toBe(false);
    now += 1;
    expect(pair.connector.expirePartialMessage()).toBe(true);
    expect(pair.connector.currentState).toBe("failed");
    expect(pair.connector.bufferedBytes).toBe(0);
    expect(pair.connector.expirePartialMessage()).toBe(false);
  });

  it("fails on a clock reading that is not whole milliseconds or that goes back", () => {
    for (const reading of [Number.NaN, -1, 1.5]) {
      const pair = pairWith({ clock: () => reading });
      expect(() => pair.connector.receive(sealAs(pair.phone, FULL_PART)), String(reading)).toThrow(
        expect.objectContaining({ code: "bad_time" }),
      );
      expect(pair.connector.partialMessageSince).toBeNull();
    }
    let now = 1_000;
    const pair = pairWith({ clock: () => now });
    pair.connector.receive(sealAs(pair.phone, FULL_PART));
    now = 999;
    expect(() =>
      pair.connector.receive(sealAs(pair.phone, { kind: "text-end", data: Uint8Array.of(120) })),
    ).toThrow(expect.objectContaining({ code: "bad_time" }));
    // The host's expiry call fails closed the same way.
    let reading = 0;
    const timer = pairWith({ clock: () => reading });
    timer.connector.receive(sealAs(timer.phone, FULL_PART));
    reading = Number.NaN;
    expect(() => timer.connector.expirePartialMessage()).toThrow(RelayProtocolError);
    expect(timer.connector.currentState).toBe("failed");
  });

  it("a clock that ends the channel while it is read leaves nothing buffered or charged", () => {
    const budget = new ReceiveBudget(10 * MAX_RECORD_DATA_BYTES);
    let abortOnRead = false;
    let connector: Responder | null = null;
    const pair = pairWith({
      budget,
      clock: () => {
        if (abortOnRead) connector!.abort();
        return 1_000;
      },
    });
    connector = pair.connector;
    abortOnRead = true;
    expect(() => pair.connector.receive(sealAs(pair.phone, FULL_PART))).toThrow(
      expect.objectContaining({ code: "failed" }),
    );
    expect(pair.connector.currentState).toBe("failed");
    expect(pair.connector.bufferedBytes).toBe(0);
    expect(budget.usedBytes).toBe(0);
  });
});

describe("handshake state", () => {
  function secretsOf(channel: Initiator | Responder) {
    return IKHandshake.secretsForTests(
      (channel as unknown as { handshake: IKHandshake }).handshake,
    );
  }
  function wiped(channel: Initiator | Responder): void {
    const secrets = secretsOf(channel);
    expect(secrets.ephemeralSecret === null || secrets.ephemeralSecret.every((b) => b === 0)).toBe(
      true,
    );
    expect(secrets.chainingKey.every((b) => b === 0)).toBe(true);
    expect(secrets.cipherKeyed).toBe(false);
    expect(secrets.holdsTransportKeys).toBe(false);
  }

  it("is wiped when a channel is aborted mid-handshake", () => {
    const pair = makePair();
    pair.connector.receive(pair.phone.start());
    expect(secretsOf(pair.phone).chainingKey.some((b) => b !== 0)).toBe(true);
    pair.phone.abort();
    wiped(pair.phone);
  });

  it("is wiped once the handshake splits, and stays so through a normal close", () => {
    const pair = makePair();
    openPair(pair);
    wiped(pair.phone);
    wiped(pair.connector);
    pair.connector.receive(pair.phone.close());
    wiped(pair.phone);
    wiped(pair.connector);
  });

  it("an authenticated answer that is malformed still wipes the split keys", () => {
    const pair = makePair();
    const hs1 = pair.phone.start();
    // A connector that writes a valid message 2 carrying an answer no connector may give.
    const responder = new IKHandshake({
      initiator: false,
      prologue: channelPrologue(RELAY_ID),
      staticKey: pair.connectorKey,
    });
    responder.readMessage1(hs1.subarray(2));
    const body = responder.writeMessage2(Uint8Array.of(1, 9));
    expect(() => pair.phone.receive(encodeFrame({ type: "handshake2", body }))).toThrow(
      expect.objectContaining({ code: "malformed" }),
    );
    wiped(pair.phone);
    expect(keysOf(pair.phone)).toBeNull();
  });

  it("a random source that ends the channel or reenters the handshake leaves it failed", () => {
    const connectorKey = generateKeyPair();
    let phone: Initiator | null = null;
    phone = new Initiator({
      relayId: RELAY_ID,
      connectorKey: connectorKey.publicKey,
      staticKey: generateKeyPair(),
      random: (length) => {
        phone!.abort();
        return new Uint8Array(length).fill(5);
      },
    });
    expect(() => phone.start()).toThrow(expect.objectContaining({ code: "failed" }));
    expect(phone.currentState).toBe("failed");
    wiped(phone);

    let inner: unknown = null;
    const handshake: IKHandshake = new IKHandshake({
      initiator: true,
      prologue: channelPrologue(RELAY_ID),
      staticKey: generateKeyPair(),
      remoteStaticKey: connectorKey.publicKey,
      random: (length) => {
        try {
          handshake.writeMessage1(new Uint8Array(0));
        } catch (error) {
          inner = error;
        }
        return new Uint8Array(length).fill(5);
      },
    });
    expect(() => handshake.writeMessage1(new Uint8Array(0))).toThrow(
      expect.objectContaining({ code: "failed" }),
    );
    expect(inner).toMatchObject({ code: "unexpected" });
    expect(handshake.complete).toBe(false);
    expect(() => handshake.readMessage2(new Uint8Array(48))).toThrow(
      expect.objectContaining({ code: "unexpected" }),
    );
  });

  it("copies the random bytes without running the returned array's iterator", () => {
    let iterated = 0;
    const phone: Initiator = new Initiator({
      relayId: RELAY_ID,
      connectorKey: generateKeyPair().publicKey,
      staticKey: generateKeyPair(),
      random: (length) => {
        const bytes = new Uint8Array(length).fill(5);
        const values = bytes[Symbol.iterator].bind(bytes);
        Object.defineProperty(bytes, Symbol.iterator, {
          value: () => {
            iterated++;
            phone.abort();
            return values();
          },
        });
        return bytes;
      },
    });
    phone.start();
    expect(iterated).toBe(0);
    expect(phone.currentState).toBe("handshaking");
    phone.abort();
  });

  it("a step that a callback ended during it fails and keeps no new key", () => {
    // A proxy is copied element by element, through its traps; one of them ends the channel.
    let ended = false;
    const phone: Initiator = new Initiator({
      relayId: RELAY_ID,
      connectorKey: generateKeyPair().publicKey,
      staticKey: generateKeyPair(),
      random: (length) => {
        const bytes = new Uint8Array(length).fill(5);
        return new Proxy(bytes, {
          get: (target, key) => {
            if (!ended) {
              ended = true;
              phone.abort();
            }
            return key === Symbol.iterator
              ? () => target[Symbol.iterator]()
              : Reflect.get(target, key, target);
          },
        });
      },
    });
    expect(() => phone.start()).toThrow(expect.objectContaining({ code: "failed" }));
    expect(ended).toBe(true);
    expect(phone.currentState).toBe("failed");
    expect(secretsOf(phone).ephemeralSecret).toBeNull();
    wiped(phone);
  });
});

describe("ending a channel", () => {
  it("a send the key cannot finish fails the channel before any frame is made", () => {
    const pair = makePair();
    openPair(pair);
    CipherState.leaveRemainingForTests(keysOf(pair.phone).send, 1);
    const encrypt = vi.spyOn(CipherState.prototype, "encrypt");
    expect(() => pair.phone.sendText(TWO_RECORDS)).toThrow(
      expect.objectContaining({ code: "nonce_exhausted" }),
    );
    // Nothing was encrypted: the record count was checked first.
    expect(encrypt).not.toHaveBeenCalled();
    expect(pair.phone.currentState).toBe("failed");
    expect(keysOf(pair.phone)).toBeNull();
    expect(() => pair.phone.sendText("x")).toThrow(expect.objectContaining({ code: "failed" }));
  });

  it("running out of messages on a ping or close fails the channel too", () => {
    for (const send of [(p: Pair) => p.phone.ping(), (p: Pair) => p.phone.close()]) {
      const pair = makePair();
      openPair(pair);
      CipherState.leaveRemainingForTests(keysOf(pair.phone).send, 0);
      expect(() => send(pair)).toThrow(expect.objectContaining({ code: "nonce_exhausted" }));
      expect(pair.phone.currentState).toBe("failed");
      expect(keysOf(pair.phone)).toBeNull();
    }
  });

  it("the last message a key allows still goes", () => {
    const pair = makePair();
    openPair(pair);
    CipherState.leaveRemainingForTests(keysOf(pair.phone).send, 1);
    CipherState.leaveRemainingForTests(keysOf(pair.connector).receive, 1);
    expect(deliver(pair.connector, pair.phone.sendText("last"))).toEqual([
      { type: "text", text: "last" },
    ]);
  });

  it("abort is safe in any state, any number of times, and tells an authenticated close apart", () => {
    const pair = makePair();
    expect(pair.phone.abort()).toBe(false);
    expect(pair.phone.abort()).toBe(false);
    expect(pair.phone.currentState).toBe("failed");

    const open = makePair();
    openPair(open);
    expect(open.phone.abort()).toBe(false);
    expect(keysOf(open.phone)).toBeNull();

    const closed = makePair();
    openPair(closed);
    closed.phone.receive(closed.connector.close(1000, "done"));
    expect(closed.connector.abort()).toBe(true);
    expect(closed.phone.abort()).toBe(true);
    expect(closed.phone.currentState).toBe("closed");
  });

  it("an authenticated close in the middle of a message cancels it", () => {
    const pair = makePair();
    openPair(pair);
    pair.connector.receive(sealAs(pair.phone, FULL_PART));
    expect(pair.connector.bufferedBytes).toBe(MAX_RECORD_DATA_BYTES);
    const close = sealAs(pair.phone, { kind: "close", code: 4000, reason: "bye" });
    expect(pair.connector.receive(close)).toEqual([{ type: "close", code: 4000, reason: "bye" }]);
    expect(pair.connector.bufferedBytes).toBe(0);
  });
});
