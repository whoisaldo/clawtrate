// The allowlist as the channel's gate and admission transaction, with the protocol package's own
// initiator and responder exchanging frames in memory.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  generateKeyPair,
  Initiator,
  Responder,
  toBase64Url,
  type ChannelEvent,
  type KeyPair,
} from "@clawtrate/relay-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addOffer, Allowlist, PHONES_FILE, readPhones, removePhones } from "../src/allowlist.ts";
import { StateDir } from "../src/state.ts";
import { tempRoot } from "./helpers.ts";

const RELAY_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaa";

let root: string;
let cleanup: () => void;
let state: StateDir;
let nowMs: number;
let allowlist: Allowlist;
let connectorKey: KeyPair;
beforeEach(() => {
  ({ root, cleanup } = tempRoot());
  state = StateDir.create(join(root, "state"));
  nowMs = 1_800_000_000_000;
  allowlist = new Allowlist(state, () => nowMs);
  connectorKey = generateKeyPair();
});
afterEach(() => cleanup());

const sends = (events: readonly ChannelEvent[]) =>
  events.flatMap((event) => (event.type === "send" ? [event.frame] : []));

/** Runs one opening. Returns what the phone saw and whether the connector admitted it. */
function open(phoneKey: KeyPair, enroll?: Uint8Array, recorded?: { message1?: Uint8Array }) {
  const phone = new Initiator({
    relayId: RELAY_ID,
    connectorKey: connectorKey.publicKey,
    staticKey: phoneKey,
    ...(enroll ? { enroll } : {}),
  });
  const connector = new Responder({ relayId: RELAY_ID, staticKey: connectorKey, gate: allowlist });
  const message1 = phone.start();
  if (recorded) recorded.message1 = message1;
  const atPhone = phone.receive(sends(connector.receive(message1))[0]!);
  // Refused at the handshake: the gate turned it away before any admission.
  if (phone.currentState === "closed") return { phone: atPhone, admitted: false, at: "handshake" };
  const atConnector = connector.receive(sends(atPhone)[0]!);
  const admit = atConnector.find((event) => event.type === "admit");
  if (admit?.type !== "admit") throw new Error("no admit");
  const attempt = connector.beginAdmission(admit.admission);
  const settled = connector.settle(attempt, allowlist.commit(attempt));
  const last = phone.receive(settled.frame!);
  return { phone: [...atPhone, ...last], admitted: settled.admitted, at: "admission" };
}

const refusalOf = (events: readonly ChannelEvent[]) =>
  events.flatMap((event) => (event.type === "refused" ? [event.reason] : []))[0] ?? null;

describe("the allowlist", () => {
  it("refuses a phone that is not enrolled and brings no secret", () => {
    const { phone, admitted } = open(generateKeyPair());
    expect(admitted).toBe(false);
    expect(refusalOf(phone)).toBe("not_enrolled");
  });

  it("enrolls a phone once with a live secret, and admits it afterwards without one", () => {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    addOffer(state, { secret, expiresAtMs: nowMs + 600_000, label: "Test phone" }, nowMs);
    const phoneKey = generateKeyPair();
    expect(open(phoneKey, secret).admitted).toBe(true);
    const phones = readPhones(state);
    expect(phones.phones).toEqual([
      { key: toBase64Url(phoneKey.publicKey), label: "Test phone", addedAtMs: nowMs },
    ]);
    expect(phones.offers[0]!.used).toBe(true);
    expect(open(phoneKey).admitted).toBe(true);
  });

  it("refuses a replayed secret: a second phone, and the same message 1 sent again", () => {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    addOffer(state, { secret, expiresAtMs: nowMs + 600_000, label: "Test phone" }, nowMs);
    const recorded: { message1?: Uint8Array } = {};
    expect(open(generateKeyPair(), secret, recorded).admitted).toBe(true);
    const second = open(generateKeyPair(), secret);
    expect(second.admitted).toBe(false);
    expect(refusalOf(second.phone)).toBe("enrollment_refused");
    // The spent offer is no longer open at the gate.
    expect(second.at).toBe("handshake");
    expect(readPhones(state).phones).toHaveLength(1);
    // Whoever recorded the first phone's message 1 replays it to a new responder: the key is
    // enrolled now, but a replay cannot produce the confirm record, so nothing is admitted.
    const replayed = new Responder({ relayId: RELAY_ID, staticKey: connectorKey, gate: allowlist });
    const answer = replayed.receive(recorded.message1!);
    expect(answer.some((event) => event.type === "admit")).toBe(false);
    expect(replayed.currentState).toBe("confirming");
  });

  it("refuses an expired secret, at the handshake and at the commit", () => {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    addOffer(state, { secret, expiresAtMs: nowMs + 1_000, label: "Test phone" }, nowMs);
    nowMs += 1_000;
    const late = open(generateKeyPair(), secret);
    expect(late.admitted).toBe(false);
    expect(refusalOf(late.phone)).toBe("enrollment_refused");
    expect(late.at).toBe("handshake");

    // Expiring between the handshake and the confirm record.
    nowMs = 1_800_000_000_000;
    const secret2 = crypto.getRandomValues(new Uint8Array(32));
    addOffer(state, { secret: secret2, expiresAtMs: nowMs + 1_000, label: "Second" }, nowMs);
    const phone = new Initiator({
      relayId: RELAY_ID,
      connectorKey: connectorKey.publicKey,
      staticKey: generateKeyPair(),
      enroll: secret2,
    });
    const connector = new Responder({
      relayId: RELAY_ID,
      staticKey: connectorKey,
      gate: allowlist,
    });
    const atPhone = phone.receive(sends(connector.receive(phone.start()))[0]!);
    nowMs += 1_000;
    const admit = connector.receive(sends(atPhone)[0]!).find((event) => event.type === "admit");
    if (admit?.type !== "admit") throw new Error("no admit");
    const attempt = connector.beginAdmission(admit.admission);
    expect(allowlist.commit(attempt)).toBe("enrollment_refused");
    expect(readPhones(state).phones.filter((p) => p.label === "Second")).toEqual([]);
  });

  it("admits only one of two phones that both passed the gate with one secret", () => {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    addOffer(state, { secret, expiresAtMs: nowMs + 600_000, label: "Test phone" }, nowMs);
    const pairs = [generateKeyPair(), generateKeyPair()].map((key) => {
      const phone = new Initiator({
        relayId: RELAY_ID,
        connectorKey: connectorKey.publicKey,
        staticKey: key,
        enroll: secret,
      });
      const connector = new Responder({
        relayId: RELAY_ID,
        staticKey: connectorKey,
        gate: allowlist,
      });
      const atPhone = phone.receive(sends(connector.receive(phone.start()))[0]!);
      return { connector, confirm: sends(atPhone)[0]! };
    });
    const results = pairs.map(({ connector, confirm }) => {
      const admit = connector.receive(confirm).find((event) => event.type === "admit");
      if (admit?.type !== "admit") throw new Error("no admit");
      const attempt = connector.beginAdmission(admit.admission);
      return connector.settle(attempt, allowlist.commit(attempt)).admitted;
    });
    expect(results).toEqual([true, false]);
    expect(readPhones(state).phones).toHaveLength(1);
  });

  it("commits nothing for an attempt whose channel ended", () => {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    addOffer(state, { secret, expiresAtMs: nowMs + 600_000, label: "Test phone" }, nowMs);
    const phone = new Initiator({
      relayId: RELAY_ID,
      connectorKey: connectorKey.publicKey,
      staticKey: generateKeyPair(),
      enroll: secret,
    });
    const connector = new Responder({
      relayId: RELAY_ID,
      staticKey: connectorKey,
      gate: allowlist,
    });
    const atPhone = phone.receive(sends(connector.receive(phone.start()))[0]!);
    const admit = connector.receive(sends(atPhone)[0]!).find((event) => event.type === "admit");
    if (admit?.type !== "admit") throw new Error("no admit");
    const attempt = connector.beginAdmission(admit.admission);
    connector.abort();
    expect(allowlist.commit(attempt)).toBe("enrollment_refused");
    expect(readPhones(state).phones).toEqual([]);
    expect(readPhones(state).offers[0]!.used).toBe(false);
  });

  it("keeps the secret's hash only, never the secret", () => {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    addOffer(state, { secret, expiresAtMs: nowMs + 600_000, label: "Test phone" }, nowMs);
    const text = readFileSync(state.file(PHONES_FILE), "utf8");
    expect(text).not.toContain(toBase64Url(secret));
    expect(text).not.toContain(Buffer.from(secret).toString("hex"));
    expect(text).not.toContain(Buffer.from(secret).toString("base64"));
  });

  it("removes a phone by key or name; a removed phone is refused at its next handshake", () => {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    addOffer(state, { secret, expiresAtMs: nowMs + 600_000, label: "Kitchen" }, nowMs);
    const phoneKey = generateKeyPair();
    expect(open(phoneKey, secret).admitted).toBe(true);
    expect(removePhones(state, "Nobody", nowMs)).toEqual([]);
    expect(removePhones(state, "Kitchen", nowMs).map((p) => p.label)).toEqual(["Kitchen"]);
    const again = open(phoneKey);
    expect(again.admitted).toBe(false);
    expect(refusalOf(again.phone)).toBe("not_enrolled");
  });
});
