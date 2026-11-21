// Enrollment is committed only after the phone proves it is live (the confirm record), through
// a one-use admission bound to the live channel; the key the gate and the host see is a copy
// of the one the handshake authenticated; and a gate cannot undo a channel's end.

import { describe, expect, it } from "vitest";
import {
  Admission,
  encodeAnswer,
  encodeRecord,
  EnrollmentOffer,
  generateKeyPair,
  Initiator,
  RelayProtocolError,
  Responder,
  type CommitResult,
  type GateCheck,
} from "../src/index.ts";
import { admissionOf, makePair, openPair, RELAY_ID, sends, settle, TestGate } from "./helpers.ts";

const SECRET = new Uint8Array(32).fill(9);

function phoneFor(connectorKey: Uint8Array, staticKey = generateKeyPair(), enroll = true) {
  return new Initiator({
    relayId: RELAY_ID,
    connectorKey,
    staticKey,
    ...(enroll ? { enroll: SECRET } : {}),
  });
}

/** Runs a pair to the admit event and returns it. */
function toAdmit(pair: ReturnType<typeof makePair>) {
  const [hs2] = sends(pair.connector.receive(pair.phone.start()));
  const [confirm] = sends(pair.phone.receive(hs2!));
  return pair.connector.receive(confirm!);
}

describe("enrollment", () => {
  it("message 1 and message 2 change nothing; the confirm record and the host's commit do", () => {
    const pair = makePair();
    const [hs2] = sends(pair.connector.receive(pair.phone.start()));
    expect(pair.gate.checks).toBe(1);
    expect(pair.gate.enrolled).toEqual([]);
    expect(pair.gate.offer!.used).toBe(false);
    const [confirm] = sends(pair.phone.receive(hs2!));
    expect(pair.gate.enrolled).toEqual([]);
    const events = pair.connector.receive(confirm!);
    expect(events).toHaveLength(1);
    // The event carries a handle and nothing a caller could reuse: no key, no secret.
    expect(Object.keys(events[0]!)).toEqual(["type", "admission"]);
    expect(Object.keys(admissionOf(events))).toEqual([]);
    expect(pair.gate.enrolled).toEqual([]);
    expect(pair.phone.receive(settle(pair.connector, pair.gate, events))).toEqual([
      { type: "open" },
    ]);
    expect(pair.gate.enrolled).toEqual([pair.phoneKey.publicKey]);
    expect(pair.gate.offer!.used).toBe(true);
  });

  it("an admission is used once, and only by its own channel", () => {
    const pair = makePair();
    const events = toAdmit(pair);
    const admission = admissionOf(events);
    const other = makePair();
    const otherEvents = toAdmit(other);
    expect(() => pair.connector.beginAdmission(admissionOf(otherEvents))).toThrow(
      expect.objectContaining({ code: "unexpected" }),
    );
    expect(() => pair.connector.beginAdmission(new Admission())).toThrow(RelayProtocolError);
    const attempt = pair.connector.beginAdmission(admission);
    expect(() => pair.connector.beginAdmission(admission)).toThrow(RelayProtocolError);
    const otherAttempt = other.connector.beginAdmission(admissionOf(otherEvents));
    expect(() => pair.connector.settle(otherAttempt, "enrolled")).toThrow(RelayProtocolError);
    expect(pair.connector.settle(attempt, pair.gate.commit(attempt)).admitted).toBe(true);
    // A settled attempt is spent: settling it again sends nothing.
    expect(pair.connector.settle(attempt, "enrolled")).toEqual({
      admitted: false,
      reason: "ended",
      frame: null,
    });
  });

  it("a queued admit event handled after abort cannot reach the transaction", () => {
    const pair = makePair();
    const events = toAdmit(pair);
    // The socket closes before the host gets to the event.
    pair.connector.abort();
    expect(admissionOf(events).live).toBe(false);
    expect(() => pair.connector.beginAdmission(admissionOf(events))).toThrow(RelayProtocolError);
    expect(pair.gate.commits).toBe(0);
    expect(pair.gate.offer!.used).toBe(false);
    expect(pair.gate.enrolled).toEqual([]);
  });

  it("an abort while the transaction runs stops the commit, and nothing is sent", () => {
    const pair = makePair();
    const attempt = pair.connector.beginAdmission(admissionOf(toAdmit(pair)));
    expect(attempt.live).toBe(true);
    pair.connector.abort();
    expect(attempt.live).toBe(false);
    // The transaction checks `live` in its atomic step and writes nothing.
    const result = pair.gate.commit(attempt);
    expect(pair.gate.offer!.used).toBe(false);
    expect(pair.gate.enrolled).toEqual([]);
    expect(pair.connector.settle(attempt, result)).toEqual({
      admitted: false,
      reason: "ended",
      frame: null,
    });
  });

  it("an abort after the commit keeps the enrollment and opens nothing", () => {
    const pair = makePair();
    const attempt = pair.connector.beginAdmission(admissionOf(toAdmit(pair)));
    expect(pair.gate.commit(attempt)).toBe("enrolled");
    // The write of the admission frame fails, so the host aborts.
    pair.connector.abort();
    expect(pair.connector.settle(attempt, "enrolled")).toEqual({
      admitted: false,
      reason: "ended",
      frame: null,
    });
    expect(pair.gate.enrolled).toEqual([pair.phoneKey.publicKey]);
    expect(pair.connector.currentState).toBe("failed");
  });

  it("a dropped handshake leaves the offer unspent and nothing pending", () => {
    const pair = makePair();
    const [hs2] = sends(pair.connector.receive(pair.phone.start()));
    // The relay drops message 2; the host times out and aborts.
    expect(pair.connector.abort()).toBe(false);
    expect(pair.connector.currentState).toBe("failed");
    expect(pair.gate.offer!.used).toBe(false);
    expect(pair.gate.enrolled).toEqual([]);
    // The phone, told nothing, gives up the same way.
    pair.phone.receive(hs2!);
    expect(pair.phone.abort()).toBe(false);
    // The same code still works for a fresh attempt.
    const retry = makePair();
    retry.gate.offer = pair.gate.offer;
    openPair(retry);
    expect(retry.gate.enrolled).toHaveLength(1);
  });

  it("an offer that expires between message 1 and the confirm record is refused at commit", () => {
    const pair = makePair();
    const events = toAdmit(pair);
    pair.gate.nowMs = pair.gate.offer!.expiresAtMs;
    const refusal = settle(pair.connector, pair.gate, events);
    expect(pair.connector.currentState).toBe("closed");
    expect(pair.phone.receive(refusal)).toEqual([
      { type: "refused", reason: "enrollment_refused" },
    ]);
    expect(pair.phone.currentState).toBe("closed");
    expect(pair.gate.enrolled).toEqual([]);
    expect(pair.gate.offer!.used).toBe(false);
  });

  it("of two phones confirming with one secret, only the first commit enrolls", () => {
    const gate = new TestGate();
    gate.offer = new EnrollmentOffer(SECRET, 60_000);
    const connectorKey = generateKeyPair();
    const ends = [0, 1].map(() => ({
      phone: phoneFor(connectorKey.publicKey),
      connector: new Responder({ relayId: RELAY_ID, staticKey: connectorKey, gate }),
    }));
    // Both pass the read-only check at message 1 and both confirm.
    const admits = ends.map(({ phone, connector }) => {
      const [hs2] = sends(connector.receive(phone.start()));
      const [confirm] = sends(phone.receive(hs2!));
      return connector.receive(confirm!);
    });
    expect(gate.checks).toBe(2);
    const results = ends.map(({ phone, connector }, i) =>
      phone.receive(settle(connector, gate, admits[i]!)),
    );
    expect(results).toEqual([
      [{ type: "open" }],
      [{ type: "refused", reason: "enrollment_refused" }],
    ]);
    expect(gate.enrolled).toHaveLength(1);
  });

  it("a failed commit admits nobody and spends nothing; the phone can try again", () => {
    const pair = makePair();
    pair.gate.failNextCommit = true;
    const events = toAdmit(pair);
    expect(() => settle(pair.connector, pair.gate, events)).toThrow("allowlist write failed");
    expect(pair.connector.currentState).toBe("failed");
    expect(pair.phone.currentState).toBe("confirming");
    expect(pair.gate.enrolled).toEqual([]);
    expect(pair.gate.offer!.used).toBe(false);

    const phone = phoneFor(pair.connectorKey.publicKey, pair.phoneKey);
    const connector = new Responder({
      relayId: RELAY_ID,
      staticKey: pair.connectorKey,
      gate: pair.gate,
    });
    openPair({ ...pair, phone, connector });
    expect(pair.gate.enrolled).toEqual([pair.phoneKey.publicKey]);
  });

  it("a phone removed from the allowlist before it confirms is refused at commit", () => {
    const pair = makePair({ enroll: false });
    pair.gate.enrolled.push(Uint8Array.from(pair.phoneKey.publicKey));
    const events = toAdmit(pair);
    pair.gate.enrolled.length = 0;
    const refusal = settle(pair.connector, pair.gate, events);
    expect(pair.phone.receive(refusal)).toEqual([{ type: "refused", reason: "not_enrolled" }]);
  });
});

describe("the authenticated phone key", () => {
  it("is copied to the gate, the accessor, the attempt and the result, so no caller can change it", () => {
    const pair = makePair();
    const real = Uint8Array.from(pair.phoneKey.publicKey);
    const check = pair.gate.check.bind(pair.gate);
    pair.gate.check = (phoneKey, enroll) => {
      const answer = check(phoneKey, enroll);
      phoneKey.fill(0xaa);
      enroll?.fill(0xbb);
      return answer;
    };
    const [hs2] = sends(pair.connector.receive(pair.phone.start()));
    const [confirm] = sends(pair.phone.receive(hs2!));

    const accessor = pair.connector.phoneKey!;
    expect(accessor).toEqual(real);
    accessor.fill(0xcc);
    expect(pair.connector.phoneKey).toEqual(real);

    const attempt = pair.connector.beginAdmission(admissionOf(pair.connector.receive(confirm!)));
    expect(attempt.phoneKey).toEqual(real);
    const settled = pair.connector.settle(attempt, pair.gate.commit(attempt));
    if (!settled.admitted) throw new Error("Not admitted.");
    expect(settled.phoneKey).toEqual(real);
    expect(pair.gate.enrolled).toEqual([real]);
    settled.phoneKey.fill(0xdd);
    expect(pair.connector.phoneKey).toEqual(real);
    // The handshake finished with the authenticated key, so the phone opens.
    expect(pair.phone.receive(settled.frame)).toEqual([{ type: "open" }]);
  });

  it("a transaction that changed the key it persisted fails the channel instead of admitting", () => {
    const pair = makePair();
    const attempt = pair.connector.beginAdmission(admissionOf(toAdmit(pair)));
    attempt.phoneKey.fill(0xee);
    const result = pair.gate.commit(attempt);
    expect(() => pair.connector.settle(attempt, result)).toThrow(
      expect.objectContaining({ code: "unexpected" }),
    );
    expect(pair.connector.currentState).toBe("failed");
  });
});

describe("the gate", () => {
  it("cannot reopen a channel it aborted", () => {
    const pair = makePair();
    pair.gate.check = () => {
      pair.connector.abort();
      return { eligible: pair.gate.offer! };
    };
    expect(() => pair.connector.receive(pair.phone.start())).toThrow(
      expect.objectContaining({ code: "failed" }),
    );
    expect(pair.connector.currentState).toBe("failed");
  });

  it("cannot call back into the channel", () => {
    const pair = makePair();
    const hs1 = pair.phone.start();
    let inner: unknown = null;
    pair.gate.check = () => {
      try {
        pair.connector.receive(hs1);
      } catch (error) {
        inner = error;
      }
      return "not_enrolled";
    };
    // The outer call goes on as if nothing happened, and refuses the phone.
    expect(pair.connector.receive(hs1).map((e) => e.type)).toEqual(["send", "refused"]);
    expect(inner).toMatchObject({ code: "unexpected" });
    expect(pair.connector.currentState).toBe("closed");
  });

  it("must answer one of the gate's answers; anything else fails before message 2 is sealed", () => {
    for (const answer of ["eligible", "accepted", 0, undefined, { eligible: null }, {}]) {
      const pair = makePair();
      pair.gate.check = () => answer as unknown as GateCheck;
      expect(() => pair.connector.receive(pair.phone.start()), String(answer)).toThrow(
        expect.objectContaining({ code: "malformed" }),
      );
      expect(pair.connector.currentState).toBe("failed");
    }
  });

  it("reads the candidate once, inherited or own, and gives the transaction that one", () => {
    class Found {
      readonly offer: EnrollmentOffer;
      constructor(offer: EnrollmentOffer) {
        this.offer = offer;
      }
      get eligible(): object {
        return this.offer;
      }
    }
    const inherited = makePair();
    inherited.gate.check = () => new Found(inherited.gate.offer!) as unknown as GateCheck;
    const attempt = inherited.connector.beginAdmission(admissionOf(toAdmit(inherited)));
    expect(attempt.candidate).toBe(inherited.gate.offer);

    const pair = makePair();
    const seen: object[] = [];
    pair.gate.check = () =>
      ({
        get eligible() {
          const candidate = { read: seen.length };
          seen.push(candidate);
          return candidate;
        },
      }) as GateCheck;
    const changing = pair.connector.beginAdmission(admissionOf(toAdmit(pair)));
    expect(seen).toHaveLength(1);
    expect(changing.candidate).toBe(seen[0]);
  });

  it("a transaction's answer must be a commit result; anything else fails before sealing", () => {
    for (const result of ["accepted", "eligible", undefined]) {
      const pair = makePair();
      const attempt = pair.connector.beginAdmission(admissionOf(toAdmit(pair)));
      expect(() => pair.connector.settle(attempt, result as unknown as CommitResult)).toThrow(
        expect.objectContaining({ code: "malformed" }),
      );
      expect(pair.connector.currentState).toBe("failed");
    }
    expect(() => encodeAnswer("bogus" as never)).toThrow(RelayProtocolError);
    expect(() => encodeRecord({ kind: "admission", answer: "bogus" as never })).toThrow(
      RelayProtocolError,
    );
  });
});
