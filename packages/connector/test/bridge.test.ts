// The gateway bridge: one RelaySession per dial, over real sockets on 127.0.0.1, with a relay
// stand-in that hands the test the phone's end of the session and a gateway stand-in that
// records every upgrade it is asked for.

import type { ClientOptions } from "ws";
import {
  MAX_FRAME_BYTES,
  MAX_MESSAGE_BYTES,
  ReceiveBudget,
  type KeyPair,
} from "@clawtrate/relay-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addOffer, Allowlist } from "../src/allowlist.ts";
import { FALLBACK_FORWARDED_FOR, forwardedFor } from "../src/forwarded.ts";
import { openSocket, RelaySession, type OpenSocket } from "../src/session.ts";
import type { StateDir } from "../src/state.ts";
import {
  FakeGateway,
  FakeSessionRelay,
  keysOf,
  Phone,
  setUpState,
  tempRoot,
  waitFor,
} from "./helpers.ts";

let cleanup: () => void;
let relay: FakeSessionRelay;
let gateway: FakeGateway;
let state: StateDir;
let keys: { relayId: string; noise: KeyPair };
let sessions: RelaySession[];
let opened: { url: string; options: ClientOptions }[];

beforeEach(async () => {
  let root: string;
  ({ root, cleanup } = tempRoot());
  relay = await new FakeSessionRelay().start();
  gateway = await new FakeGateway().start();
  state = setUpState(root, relay.origin, gateway.port);
  keys = keysOf(state);
  sessions = [];
  opened = [];
});
afterEach(async () => {
  for (const session of sessions) session.end("test over");
  await relay.close();
  await gateway.close();
  cleanup();
});

const recording: OpenSocket = (url, options) => {
  opened.push({ url, options });
  return openSocket(url, options);
};

let counter = 0;
/** Starts a session for a dial from `from`, and returns the phone attached to its other end. */
async function dial(from: string, phone: Phone): Promise<RelaySession> {
  const before = relay.sessions.length;
  const session = new RelaySession({
    relayOrigin: relay.origin,
    relayId: keys.relayId,
    session: `AAAAAAAAAAAAAAAAAAAA${String(counter++ % 10)}A`,
    from,
    staticKey: keys.noise,
    gate: new Allowlist(state),
    gatewayPort: gateway.port,
    budget: new ReceiveBudget(64 * 1024 * 1024),
    openSocket: recording,
  });
  sessions.push(session);
  await waitFor("the session socket", () => relay.sessions.length > before);
  phone.attach(relay.sessions[before]!);
  phone.start();
  return session;
}

function enrolledPhone(): Phone {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  addOffer(state, { secret, expiresAtMs: Date.now() + 600_000, label: "Test phone" }, Date.now());
  return new Phone({ relayId: keys.relayId, connectorKey: keys.noise.publicKey, enroll: secret });
}

/** The connector's own upgrade: these headers and no others. */
const WEBSOCKET_HEADERS = [
  "connection",
  "host",
  "sec-websocket-key",
  "sec-websocket-version",
  "upgrade",
];
const FORWARDED_HEADERS = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"];

describe("the gateway bridge", () => {
  it("opens its own upgrade with X-Forwarded-For, no Origin and no other header", async () => {
    const phone = enrolledPhone();
    await dial("127.0.0.1", phone);
    await waitFor("the phone admitted", () => phone.opened);
    await waitFor("the gateway upgrade", () => gateway.upgrades.length === 1);
    const headers = gateway.upgrades[0]!;
    expect(Object.keys(headers).sort()).toEqual(
      [...WEBSOCKET_HEADERS, ...FORWARDED_HEADERS].sort(),
    );
    expect(headers["x-forwarded-for"]).toBe(FALLBACK_FORWARDED_FOR);
    expect(headers["x-forwarded-proto"]).toBe("http");
    expect(headers["x-forwarded-host"]).toBe(`127.0.0.1:${relay.port}`);
    expect(headers.host).toBe(`127.0.0.1:${gateway.port}`);
    expect(headers.origin).toBeUndefined();
  });

  it("sets a non-loopback X-Forwarded-For on every upgrade, whatever address the relay reports", async () => {
    const privateV4 = [10, 1, 2, 3].join(".");
    const cases: [string, string][] = [
      ["127.0.0.1", FALLBACK_FORWARDED_FOR],
      ["::1", FALLBACK_FORWARDED_FOR],
      ["", FALLBACK_FORWARDED_FOR],
      [privateV4, FALLBACK_FORWARDED_FOR],
      ["::ffff:127.0.0.1", FALLBACK_FORWARDED_FOR],
      ["9.9.9.9", "9.9.9.9"],
      ["::ffff:9.9.9.9", "9.9.9.9"],
      ["2606:4700::1111", "2606:4700:0:0:0:0:0:1111"],
    ];
    for (const [index, [from, expected]] of cases.entries()) {
      await dial(from, enrolledPhone());
      await waitFor(`the upgrade for "${from}"`, () => gateway.upgrades.length === index + 1);
      expect(gateway.upgrades[index]!["x-forwarded-for"]).toBe(expected);
    }
    for (const headers of gateway.upgrades) {
      expect(headers["x-forwarded-for"]).not.toMatch(/^(127\.|::1$|$)/);
      expect(Object.keys(headers).sort()).toEqual(
        [...WEBSOCKET_HEADERS, ...FORWARDED_HEADERS].sort(),
      );
    }
  });

  it("passes the phone's text and the gateway's answers through unchanged, header-like text included", async () => {
    gateway.reply = (text) => `echo:${text}`;
    const phone = enrolledPhone();
    await dial("9.9.9.9", phone);
    await waitFor("the phone admitted", () => phone.opened);
    const connect = JSON.stringify({
      type: "req",
      id: "1",
      method: "connect",
      params: { headers: { Origin: "https://evil.example", "X-Forwarded-For": "127.0.0.1" } },
    });
    const large = `{"type":"event","payload":"${"z".repeat(200_000)}"}`;
    phone.send(connect);
    phone.send("Origin: https://evil.example\r\nX-Forwarded-For: 127.0.0.1\r\n\r\n");
    phone.send(large);
    await waitFor("three answers", () => phone.texts.length === 3);
    expect(gateway.received).toEqual([
      connect,
      "Origin: https://evil.example\r\nX-Forwarded-For: 127.0.0.1\r\n\r\n",
      large,
    ]);
    expect(phone.texts).toEqual(gateway.received.map((text) => `echo:${text}`));
    // Whatever the phone sent, the one upgrade still carried only the connector's headers.
    expect(gateway.upgrades).toHaveLength(1);
    expect(gateway.upgrades[0]!["x-forwarded-for"]).toBe("9.9.9.9");
    expect(gateway.upgrades[0]!.origin).toBeUndefined();
  });

  it("refuses a phone that is not enrolled before the gateway sees any connection", async () => {
    const stranger = new Phone({ relayId: keys.relayId, connectorKey: keys.noise.publicKey });
    const session = await dial("9.9.9.9", stranger);
    await waitFor("the refusal", () => stranger.refusal() !== null);
    expect(stranger.refusal()).toBe("not_enrolled");
    await waitFor("the session to end", () => session.stage === "ended");
    expect(session.gatewayOpened).toBe(false);
    expect(gateway.connections).toBe(0);
    expect(gateway.upgrades).toEqual([]);
  });

  it("refuses a wrong enrollment secret before the gateway sees any connection", async () => {
    addOffer(
      state,
      { secret: new Uint8Array(32).fill(1), expiresAtMs: Date.now() + 600_000, label: "Real" },
      Date.now(),
    );
    const guesser = new Phone({
      relayId: keys.relayId,
      connectorKey: keys.noise.publicKey,
      enroll: new Uint8Array(32).fill(2),
    });
    const session = await dial("9.9.9.9", guesser);
    await waitFor("the refusal", () => guesser.refusal() !== null);
    expect(guesser.refusal()).toBe("enrollment_refused");
    await waitFor("the session to end", () => session.stage === "ended");
    expect(gateway.connections).toBe(0);
  });

  it("takes its size limits from the protocol", async () => {
    const phone = enrolledPhone();
    await dial("9.9.9.9", phone);
    await waitFor("the phone admitted", () => phone.opened);
    await waitFor("the gateway socket", () => opened.length === 2);
    const [relaySocket, gatewaySocket] = opened;
    expect(relaySocket!.options.maxPayload).toBe(MAX_FRAME_BYTES);
    expect(gatewaySocket!.url).toBe(`ws://127.0.0.1:${gateway.port}`);
    expect(gatewaySocket!.options.maxPayload).toBe(MAX_MESSAGE_BYTES);
    expect(gatewaySocket!.options.followRedirects).toBe(false);
    expect(gatewaySocket!.options.perMessageDeflate).toBe(false);
  });

  it("closes the channel to the phone when the gateway closes, and ends the session", async () => {
    const phone = enrolledPhone();
    const session = await dial("9.9.9.9", phone);
    await waitFor("the gateway socket", () => gateway.sockets.length === 1);
    gateway.sockets[0]!.close(4001, "bye");
    await waitFor("the phone's close", () => phone.events.some((event) => event.type === "close"));
    const close = phone.events.find((event) => event.type === "close");
    expect(close).toEqual({ type: "close", code: 4001, reason: "bye" });
    await waitFor("the session to end", () => session.stage === "ended");
  });
});

describe("the forwarded address", () => {
  it("is never loopback, private or empty", () => {
    const privates = [
      [10, 0, 0, 1],
      [172, 16, 0, 1],
      [192, 168, 1, 1],
      [100, 64, 0, 1],
      [169, 254, 1, 1],
    ].map((parts) => parts.join("."));
    for (const from of [
      "127.0.0.1",
      "127.1.2.3",
      "0.0.0.0",
      "::",
      "::1",
      "",
      "nonsense",
      "1.2.3",
      "01.2.3.4",
      ...privates,
    ]) {
      expect(forwardedFor(from)).toBe(FALLBACK_FORWARDED_FOR);
    }
    expect(forwardedFor(["fe80", "", "1"].join(":"))).toBe(FALLBACK_FORWARDED_FOR);
    expect(forwardedFor(["fd00", "", "1"].join(":"))).toBe(FALLBACK_FORWARDED_FOR);
    expect(forwardedFor("203.0.113.7")).toBe(FALLBACK_FORWARDED_FOR);
    expect(forwardedFor("2001:db8::1")).toBe(FALLBACK_FORWARDED_FOR);
    expect(forwardedFor("8.8.4.4")).toBe("8.8.4.4");
  });
});
