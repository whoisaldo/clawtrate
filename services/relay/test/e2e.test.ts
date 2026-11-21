// End to end through the relay on both runtimes: a Node connector stand-in and a Node phone
// stand-in, using the protocol package, enroll the phone, open a Noise IK channel and exchange
// text. The relay sees only what the stand-ins send it, and passes every frame unchanged.

import {
  EnrollmentOffer,
  generateKeyPair,
  Initiator,
  Responder,
  type AdmissionAttempt,
  type ChannelEvent,
  type CommitResult,
  type GateCheck,
  type PhoneGate,
} from "@clawtrate/relay-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  registerConnector,
  RUNTIMES,
  splice,
  startRelay,
  type Relay,
  type TestSocket,
} from "./support.ts";

/** The connector's allowlist: one offer, and the keys enrolled through it. */
class Allowlist implements PhoneGate {
  readonly enrolled: Uint8Array[] = [];
  readonly offer: EnrollmentOffer;

  constructor(secret: Uint8Array) {
    this.offer = new EnrollmentOffer(secret, Date.now() + 600_000);
  }

  check(phoneKey: Uint8Array, enroll: Uint8Array | undefined): GateCheck {
    if (this.#has(phoneKey)) return "enrolled";
    if (enroll === undefined) return "not_enrolled";
    return this.offer.matches(enroll, Date.now()) ? { eligible: this.offer } : "enrollment_refused";
  }

  commit(attempt: AdmissionAttempt): CommitResult {
    if (!attempt.live) return "not_enrolled";
    if (this.#has(attempt.phoneKey)) return "enrolled";
    if (attempt.candidate !== this.offer || !this.offer.spend(Date.now())) {
      return "enrollment_refused";
    }
    this.enrolled.push(Uint8Array.from(attempt.phoneKey));
    return "enrolled";
  }

  #has(key: Uint8Array): boolean {
    return this.enrolled.some((known) => Buffer.from(known).equals(Buffer.from(key)));
  }
}

/** Every frame one stand-in sent, and every frame the other received, in order. */
interface Wire {
  readonly sent: Uint8Array[];
  readonly received: Uint8Array[];
}

/** Sends `frames` over `from` and feeds what arrives at `to` into `channel`. */
async function cross(
  frames: readonly Uint8Array[],
  from: TestSocket,
  to: TestSocket,
  channel: Initiator | Responder,
  wire: Wire,
): Promise<ChannelEvent[]> {
  for (const frame of frames) {
    from.send(frame);
    wire.sent.push(frame);
  }
  const events: ChannelEvent[] = [];
  for (let i = 0; i < frames.length; i++) {
    const frame = await to.bytes();
    wire.received.push(frame);
    events.push(...channel.receive(frame));
  }
  return events;
}

const sends = (events: readonly ChannelEvent[]) =>
  events.flatMap((event) => (event.type === "send" ? [event.frame] : []));
const texts = (events: readonly ChannelEvent[]) =>
  events.flatMap((event) => (event.type === "text" ? [event.text] : []));

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  return Buffer.from(haystack).indexOf(Buffer.from(needle)) !== -1;
}

describe.each(RUNTIMES)("end to end through the relay on %s", (runtime) => {
  let relay: Relay;
  beforeAll(async () => {
    relay = await startRelay(runtime);
  }, 120_000);
  afterAll(async () => {
    await relay?.close();
  });

  it(
    "opens a Noise session and round-trips text, and the relay carries only ciphertext",
    { timeout: 20_000 },
    async () => {
      const { control, key } = await registerConnector(relay);
      const connectorStatic = generateKeyPair();
      const phoneStatic = generateKeyPair();
      const secret = crypto.getRandomValues(new Uint8Array(32));
      const allowlist = new Allowlist(secret);
      const phone = new Initiator({
        relayId: key.relayId,
        connectorKey: connectorStatic.publicKey,
        staticKey: phoneStatic,
        enroll: secret,
      });
      const connector = new Responder({
        relayId: key.relayId,
        staticKey: connectorStatic,
        gate: allowlist,
      });
      const sockets = await splice(relay, control, key.relayId);
      const up: Wire = { sent: [], received: [] };
      const down: Wire = { sent: [], received: [] };

      // The opening: message 1, message 2, the confirm record, the admission record.
      const atConnector = await cross(
        [phone.start()],
        sockets.phone,
        sockets.session,
        connector,
        up,
      );
      const atPhone = await cross(sends(atConnector), sockets.session, sockets.phone, phone, down);
      const confirmed = await cross(sends(atPhone), sockets.phone, sockets.session, connector, up);
      const admit = confirmed.find((event) => event.type === "admit");
      if (admit?.type !== "admit") throw new Error("The connector did not admit the phone.");
      const attempt = connector.beginAdmission(admit.admission);
      const settled = connector.settle(attempt, allowlist.commit(attempt));
      expect(settled.frame).not.toBeNull();
      const opened = await cross([settled.frame!], sockets.session, sockets.phone, phone, down);
      expect(opened.some((event) => event.type === "open")).toBe(true);
      expect(connector.currentState).toBe("open");
      expect(allowlist.enrolled).toHaveLength(1);

      // Text both ways, one short message and one that takes several records.
      const question = "What did the build bot finish overnight?";
      const answer = `Three tasks finished. ${"Details follow. ".repeat(12_000)}`;
      const asked = await cross(
        phone.sendText(question),
        sockets.phone,
        sockets.session,
        connector,
        up,
      );
      expect(texts(asked)).toEqual([question]);
      const answerFrames = connector.sendText(answer);
      expect(answerFrames.length).toBeGreaterThan(1);
      const answered = await cross(answerFrames, sockets.session, sockets.phone, phone, down);
      expect(texts(answered)).toEqual([answer]);

      // The relay passed every frame unchanged and in order, and none of them holds the text,
      // the enrollment secret or either static key in the clear.
      for (const wire of [up, down]) {
        expect(wire.received).toHaveLength(wire.sent.length);
        wire.sent.forEach((frame, i) =>
          expect(Buffer.from(wire.received[i]!).equals(Buffer.from(frame))).toBe(true),
        );
      }
      const secrets = [
        new TextEncoder().encode(question),
        new TextEncoder().encode("Three tasks finished."),
        new TextEncoder().encode("Details follow."),
        secret,
        phoneStatic.publicKey,
      ];
      for (const frame of [...up.received, ...down.received]) {
        expect(frame[0]).toBe(1);
        for (const plain of secrets) expect(contains(frame, plain)).toBe(false);
      }

      // A close inside the channel, then the sockets go.
      const closing = await cross([phone.close()], sockets.phone, sockets.session, connector, up);
      expect(closing.some((event) => event.type === "close")).toBe(true);
      sockets.phone.close();
      expect(await sockets.session.refused()).toEqual({ error: "peer_gone", code: 1000 });
      control.close();
    },
  );
});
