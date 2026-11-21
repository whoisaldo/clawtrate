import { describe, expect, it } from "vitest";
import { Initiator, RelayProtocolError, Responder, type ChannelEvent } from "../src/index.ts";
import { deliver, makePair, openPair, RELAY_ID, sends } from "./helpers.ts";

const FIXED_EPHEMERAL = new Uint8Array(32).fill(3);

/** Every single-bit change at every position: the low bit and the high bit of each byte. */
function* flips(frame: Uint8Array): Generator<Uint8Array> {
  for (let i = 0; i < frame.length; i++) {
    for (const bit of [0x01, 0x80]) {
      const copy = Uint8Array.from(frame);
      copy[i]! ^= bit;
      yield copy;
    }
  }
}

function expectProtocolError(run: () => unknown): RelayProtocolError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(RelayProtocolError);
    return error as RelayProtocolError;
  }
  throw new Error("Expected a RelayProtocolError.");
}

// Each case runs hundreds of handshakes; a busy machine may take several times longer than usual.
describe("tampering", { timeout: 60_000 }, () => {
  it("any changed bit in handshake message 1 fails the connector before the gate is asked", () => {
    const pair = makePair();
    const hs1 = pair.phone.start();
    let gateAsked = false;
    const gate = {
      check: () => ((gateAsked = true), "enrolled" as const),
    };
    let count = 0;
    for (const changed of flips(hs1)) {
      const connector = new Responder({ relayId: RELAY_ID, staticKey: pair.connectorKey, gate });
      expectProtocolError(() => connector.receive(changed));
      expect(connector.currentState).toBe("failed");
      count++;
    }
    expect(count).toBe(hs1.length * 2);
    expect(gateAsked).toBe(false);
  });

  it("any changed bit in handshake message 2 fails the phone before it opens", () => {
    const pair = makePair();
    // Phones with the same keys and the same ephemeral key all write the same message 1, so
    // the connector's one message 2 answers each of them.
    const phone = () =>
      new Initiator({
        relayId: RELAY_ID,
        connectorKey: pair.connectorKey.publicKey,
        staticKey: pair.phoneKey,
        enroll: new Uint8Array(32).fill(9),
        random: () => FIXED_EPHEMERAL,
      });
    const [hs2] = sends(pair.connector.receive(phone().start()));

    // The unchanged message opens a phone, so each failure below is the change's doing.
    const control = phone();
    control.start();
    expect(control.receive(hs2!).map((e) => e.type)).toEqual(["send"]);

    for (const changed of flips(hs2!)) {
      const tampered = phone();
      tampered.start();
      expectProtocolError(() => tampered.receive(changed));
      expect(tampered.currentState).toBe("failed");
    }
  });

  it("any changed bit in a transport frame fails the receiver, and it stays failed", () => {
    const length = (() => {
      const pair = makePair();
      openPair(pair);
      return pair.phone.sendText("hello")[0]!.length;
    })();
    for (let position = 0; position < length; position++) {
      for (const bit of [0x01, 0x80]) {
        const pair = makePair();
        openPair(pair);
        const [frame] = pair.phone.sendText("hello");
        const tampered = Uint8Array.from(frame!);
        tampered[position]! ^= bit;
        expectProtocolError(() => pair.connector.receive(tampered));
        expect(pair.connector.currentState).toBe("failed");
        // The genuine frame no longer helps.
        expect(expectProtocolError(() => pair.connector.receive(frame!)).code).toBe("failed");
      }
    }
  });

  it("truncated or extended frames fail", () => {
    const changes = [
      (frame: Uint8Array) => frame.subarray(0, frame.length - 1),
      (frame: Uint8Array) => Uint8Array.of(...frame, 0),
    ];
    for (const change of changes) {
      // The session that made the frame, so only the changed length can make it fail.
      const pair = makePair();
      openPair(pair);
      const [frame] = pair.phone.sendText("hello");
      expectProtocolError(() => pair.connector.receive(change(frame!)));
      expect(pair.connector.currentState).toBe("failed");
    }
  });

  it("a frame of another protocol version is refused", () => {
    const pair = makePair();
    const hs1 = Uint8Array.from(pair.phone.start());
    hs1[0] = 2;
    expect(expectProtocolError(() => pair.connector.receive(hs1)).code).toBe("unsupported_version");
  });
});

describe("replay, reordering, dropping and reflection", () => {
  it("a transport frame delivered twice fails the second time", () => {
    const pair = makePair();
    openPair(pair);
    const [frame] = pair.phone.sendText("once");
    expect(deliver(pair.connector, [frame!])).toEqual([{ type: "text", text: "once" }]);
    expect(expectProtocolError(() => pair.connector.receive(frame!)).code).toBe("decrypt_failed");
    expect(pair.connector.currentState).toBe("failed");
  });

  it("frames delivered out of order fail", () => {
    const pair = makePair();
    openPair(pair);
    const [first] = pair.phone.sendText("first");
    const [second] = pair.phone.sendText("second");
    expect(expectProtocolError(() => pair.connector.receive(second!)).code).toBe("decrypt_failed");
    expect(expectProtocolError(() => pair.connector.receive(first!)).code).toBe("failed");
  });

  it("a dropped frame fails the next one", () => {
    const pair = makePair();
    openPair(pair);
    pair.phone.sendText("dropped");
    const [next] = pair.phone.sendText("next");
    expect(expectProtocolError(() => pair.connector.receive(next!)).code).toBe("decrypt_failed");
  });

  it("a frame sent back to its sender fails: each direction has its own key", () => {
    const pair = makePair();
    openPair(pair);
    const [frame] = pair.phone.sendText("echo");
    expect(expectProtocolError(() => pair.phone.receive(frame!)).code).toBe("decrypt_failed");
  });

  it("a frame from one session fails in another session between the same keys", () => {
    const pair = makePair();
    openPair(pair);
    const phone = new Initiator({
      relayId: RELAY_ID,
      connectorKey: pair.connectorKey.publicKey,
      staticKey: pair.phoneKey,
    });
    const connector = new Responder({
      relayId: RELAY_ID,
      staticKey: pair.connectorKey,
      gate: pair.gate,
    });
    openPair({ ...pair, phone, connector });
    const [fromFirst] = pair.phone.sendText("first session");
    expect(expectProtocolError(() => connector.receive(fromFirst!)).code).toBe("decrypt_failed");
  });

  it("a recorded session replayed to a fresh connector never opens or delivers text", () => {
    const pair = makePair();
    const { hs1, confirm } = openPair(pair);
    const recorded = [hs1, confirm, ...pair.phone.sendText("run the tool")];
    expect(pair.gate.enrolled).toHaveLength(1);

    // The relay replays everything the phone sent, in order, to a new session.
    const replayed = new Responder({
      relayId: RELAY_ID,
      staticKey: pair.connectorKey,
      gate: pair.gate,
    });
    const events: ChannelEvent[] = [];
    events.push(...replayed.receive(recorded[0]!));
    // Message 1 alone cannot be told from a fresh one, so the connector answers it...
    expect(events.map((e) => e.type)).toEqual(["send"]);
    expect(replayed.currentState).toBe("confirming");
    // ...but its answer used a fresh ephemeral key, so the recorded confirm fails.
    expect(expectProtocolError(() => replayed.receive(recorded[1]!)).code).toBe("decrypt_failed");
    expect(replayed.currentState).toBe("failed");
    expect(events.some((e) => e.type === "open" || e.type === "text")).toBe(false);
    // No second enrollment, and the offer was not spent again.
    expect(pair.gate.enrolled).toHaveLength(1);
  });

  it("a handshake message 1, fresh or replayed, enrolls nothing and spends nothing", () => {
    const pair = makePair();
    const hs1 = pair.phone.start();
    // The phone never hears back; the relay replays message 1 to two more sessions.
    for (let i = 0; i < 3; i++) {
      const connector = new Responder({
        relayId: RELAY_ID,
        staticKey: pair.connectorKey,
        gate: pair.gate,
      });
      expect(connector.receive(hs1).map((e) => e.type)).toEqual(["send"]);
      connector.abort();
    }
    expect(pair.gate.enrolled).toEqual([]);
    expect(pair.gate.offer!.used).toBe(false);
  });

  it("handshake frames after the handshake are refused", () => {
    const pair = makePair();
    const { hs1, hs2 } = openPair(pair);
    expect(expectProtocolError(() => pair.phone.receive(hs2)).code).toBe("unexpected");
    expect(expectProtocolError(() => pair.connector.receive(hs1)).code).toBe("unexpected");
  });

  it("a transport frame before the handshake is refused", () => {
    const opened = makePair();
    openPair(opened);
    const [frame] = opened.phone.sendText("early");
    const fresh = makePair();
    expect(expectProtocolError(() => fresh.connector.receive(frame!)).code).toBe("unexpected");
    fresh.phone.start();
    expect(expectProtocolError(() => fresh.phone.receive(frame!)).code).toBe("unexpected");
  });
});
