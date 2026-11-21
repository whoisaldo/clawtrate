// The relay on both runtimes, the Node runner and the Worker with its Durable Object in
// Miniflare, through real WebSockets on 127.0.0.1.

import { MAX_FRAME_BYTES, MAX_RELAY_MESSAGE_BYTES, RELAY_PING } from "@clawtrate/relay-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bytesOf,
  connectorKey,
  openControl,
  proofFor,
  registerConnector,
  RUNTIMES,
  sleep,
  splice,
  startRelay,
  TestSocket,
  type Relay,
  type RelayOptions,
} from "./support.ts";

const START_TIMEOUT = 120_000;
const pong = { t: "pong" };

/** Starts a relay for the describe block it is called in. */
function relayFor(runtime: (typeof RUNTIMES)[number], options: RelayOptions = {}) {
  let relay: Relay | undefined;
  beforeAll(async () => {
    relay = await startRelay(runtime, options);
  }, START_TIMEOUT);
  afterAll(async () => {
    await relay?.close();
  });
  return () => relay!;
}

const register = (relay: Relay, proof: string) => JSON.stringify({ t: "register", proof });

describe.each(RUNTIMES)("the relay on %s", (runtime) => {
  describe("register, dial, splice and limits", { timeout: 20_000 }, () => {
    const relay = relayFor(runtime, {
      limits: {
        maxSessions: 2,
        maxPendingControls: 2,
        controlConnectsPerMinute: 4,
        dialsPerMinutePerAddress: 4,
        maxSessionBytes: 300_000,
      },
    });

    it("answers health on HTTP and refuses other requests", async () => {
      const http = relay().url.replace(/^ws/, "http");
      const health = await fetch(`${http}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true, protocol: 1 });
      const relayId = connectorKey().relayId;
      expect((await fetch(`${http}/v1/dial/${relayId}`)).status).toBe(426);
      expect((await fetch(`${http}/v1/dial/not-a-relay-id`)).status).toBe(404);
      expect((await fetch(`${http}/v1/connector/${relayId}/extra`)).status).toBe(404);
      expect((await fetch(`${http}/v1/session/${relayId}/short`)).status).toBe(404);
      expect((await fetch(`${http}/`)).status).toBe(404);
      await expect(TestSocket.open(`${relay().url}/v1/nothing`)).rejects.toThrow();
    });

    it("registers a connector, with a fresh challenge on every control socket", async () => {
      const key = connectorKey();
      const first = await openControl(relay(), key.relayId);
      const second = await openControl(relay(), key.relayId);
      expect(first.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(second.nonce).not.toBe(first.nonce);
      first.socket.send(register(relay(), proofFor(relay(), key, first.nonce)));
      expect(await first.socket.json()).toEqual({ t: "registered" });
      first.socket.send(RELAY_PING);
      expect(await first.socket.json()).toEqual(pong);
      second.socket.close();
      first.socket.close();
    });

    it("refuses a proof for another socket's challenge, another origin or another key", async () => {
      const key = connectorKey();
      const other = await openControl(relay(), key.relayId);
      const wrongNonce = await openControl(relay(), key.relayId);
      wrongNonce.socket.send(register(relay(), proofFor(relay(), key, other.nonce)));
      expect(await wrongNonce.socket.refused()).toEqual({ error: "bad_proof", code: 1008 });

      const wrongOrigin = await openControl(relay(), key.relayId);
      const audience = "wss://relay.example.test";
      wrongOrigin.socket.send(
        register(relay(), proofFor(relay(), key, wrongOrigin.nonce, { audience })),
      );
      expect(await wrongOrigin.socket.refused()).toEqual({ error: "bad_proof", code: 1008 });
      other.socket.close();

      // Another key's proof on this relay id's path.
      const stranger = connectorKey();
      const wrongKey = await openControl(relay(), key.relayId);
      wrongKey.socket.send(register(relay(), proofFor(relay(), stranger, wrongKey.nonce)));
      expect(await wrongKey.socket.refused()).toEqual({ error: "bad_proof", code: 1008 });
    });

    it("lets a socket register once, and closes it on a second attempt", async () => {
      const key = connectorKey();
      const { socket, nonce } = await openControl(relay(), key.relayId);
      socket.send(register(relay(), proofFor(relay(), key, nonce)));
      expect(await socket.json()).toEqual({ t: "registered" });
      socket.send(register(relay(), proofFor(relay(), key, nonce)));
      expect(await socket.refused()).toEqual({ error: "bad_proof", code: 1008 });
    });

    it("refuses a key other than the one the relay id is pinned to", async () => {
      const key = connectorKey();
      await relay().pin(key.relayId, connectorKey().publicKey);
      const { socket, nonce } = await openControl(relay(), key.relayId);
      socket.send(register(relay(), proofFor(relay(), key, nonce)));
      expect(await socket.refused()).toEqual({ error: "bad_proof", code: 1008 });
    });

    it("replaces a registered connector with a newer registration of the same key", async () => {
      const first = await registerConnector(relay());
      const second = await registerConnector(relay(), first.key);
      expect(await first.control.refused()).toEqual({ error: "replaced", code: 1000 });
      const { phone, session } = await splice(relay(), second.control, first.key.relayId);
      phone.close();
      session.close();
      second.control.close();
    });

    it("tells a phone that dials a relay id with no connector that it is offline", async () => {
      const phone = await TestSocket.open(`${relay().url}/v1/dial/${connectorKey().relayId}`);
      expect(await phone.refused()).toEqual({ error: "connector_offline", code: 1008 });
    });

    it("splices a dial to a session and passes binary frames unchanged both ways", async () => {
      const { control, key } = await registerConnector(relay());
      const { phone, session, dial } = await splice(relay(), control, key.relayId);
      expect(dial).toMatchObject({ t: "dial", from: "127.0.0.1" });
      expect(dial.t === "dial" && dial.session).toMatch(/^[A-Za-z0-9_-]{22}$/);
      const up = bytesOf(1_000, 3);
      phone.send(up);
      expect(await session.bytes()).toEqual(up);
      const down = bytesOf(2_000, 5);
      session.send(down);
      expect(await phone.bytes()).toEqual(down);
      for (const socket of [control, phone, session]) {
        socket.send(RELAY_PING);
        expect(await socket.json()).toEqual(pong);
      }
      phone.close();
      expect(await session.refused()).toEqual({ error: "peer_gone", code: 1000 });
      control.close();
    });

    it("carries a frame of the largest size and refuses one a byte larger", async () => {
      const { control, key } = await registerConnector(relay());
      const { phone, session } = await splice(relay(), control, key.relayId);
      const largest = bytesOf(MAX_FRAME_BYTES, 7);
      phone.send(largest);
      expect(await session.bytes()).toEqual(largest);
      session.send(largest);
      expect(await phone.bytes()).toEqual(largest);

      phone.send(bytesOf(MAX_FRAME_BYTES + 1));
      // The Node runner refuses the message from its header, before reading it, with the
      // close alone; the Worker reads it, then sends the error and the same close.
      const message = await phone.next();
      if (message !== null)
        expect(JSON.parse(message as string)).toEqual({ t: "error", code: "frame_too_large" });
      expect((await phone.closed).code).toBe(1009);
      expect(await session.refused()).toEqual({ error: "peer_gone", code: 1000 });
      control.close();
    });

    it("reads relay messages of up to 4,096 bytes and refuses longer ones", async () => {
      const { control, key } = await registerConnector(relay());
      const { phone, session } = await splice(relay(), control, key.relayId);
      const padded = (length: number) => `{"t":"ping"${" ".repeat(length - RELAY_PING.length)}}`;
      expect(padded(MAX_RELAY_MESSAGE_BYTES)).toHaveLength(MAX_RELAY_MESSAGE_BYTES);
      phone.send(padded(MAX_RELAY_MESSAGE_BYTES));
      expect(await phone.json()).toEqual(pong);
      phone.send(padded(MAX_RELAY_MESSAGE_BYTES + 1));
      expect(await phone.refused()).toEqual({ error: "bad_message", code: 1008 });
      expect(await session.refused()).toEqual({ error: "peer_gone", code: 1000 });
      control.close();
    });

    it("refuses binary on a control socket or before a splice, and text it cannot read", async () => {
      const { control, key } = await registerConnector(relay());
      control.send(bytesOf(10));
      expect(await control.refused()).toEqual({ error: "bad_message", code: 1008 });

      const second = await registerConnector(relay(), key);
      const phone = await TestSocket.open(`${relay().url}/v1/dial/${key.relayId}`);
      expect(await second.control.json()).toMatchObject({ t: "dial" });
      phone.send(bytesOf(10));
      expect(await phone.refused()).toEqual({ error: "bad_message", code: 1008 });

      second.control.send(JSON.stringify({ t: "open" }));
      expect(await second.control.refused()).toEqual({ error: "bad_message", code: 1008 });

      const third = await registerConnector(relay(), key);
      const { phone: spliced, session } = await splice(relay(), third.control, key.relayId);
      spliced.send("hello");
      expect(await spliced.refused()).toEqual({ error: "bad_message", code: 1008 });
      expect(await session.refused()).toEqual({ error: "peer_gone", code: 1000 });
      third.control.close();
    });

    it("opens a session socket only for a dial that is waiting for it", async () => {
      const { control, key } = await registerConnector(relay());
      const unknown = await TestSocket.open(
        `${relay().url}/v1/session/${key.relayId}/AAAAAAAAAAAAAAAAAAAAAA`,
      );
      expect(await unknown.refused()).toEqual({ error: "peer_gone", code: 1000 });
      const { phone, session, dial } = await splice(relay(), control, key.relayId);
      const again = await TestSocket.open(
        `${relay().url}/v1/session/${key.relayId}/${dial.t === "dial" ? dial.session : ""}`,
      );
      expect(await again.refused()).toEqual({ error: "peer_gone", code: 1000 });
      session.close();
      expect(await phone.refused()).toEqual({ error: "peer_gone", code: 1000 });
      control.close();
    });

    it("tells waiting phones when the connector goes, and a reconnected connector of its dials", async () => {
      const first = await registerConnector(relay());
      const waiting = await TestSocket.open(`${relay().url}/v1/dial/${first.key.relayId}`);
      expect(await first.control.json()).toMatchObject({ t: "dial" });
      // A newer registration takes over: it hears of the phone that is still waiting.
      const second = await registerConnector(relay(), first.key);
      expect(await first.control.refused()).toEqual({ error: "replaced", code: 1000 });
      const dial = await second.control.json();
      expect(dial).toMatchObject({ t: "dial", from: "127.0.0.1" });
      const session = await TestSocket.open(
        `${relay().url}/v1/session/${first.key.relayId}/${String(dial.session)}`,
      );
      expect(await waiting.json()).toEqual({ t: "open" });
      expect(await session.json()).toEqual({ t: "open" });
      waiting.close();
      session.close();

      // With no connector left, a waiting phone is told.
      const phone = await TestSocket.open(`${relay().url}/v1/dial/${first.key.relayId}`);
      expect(await second.control.json()).toMatchObject({ t: "dial" });
      second.control.close();
      expect(await phone.refused()).toEqual({ error: "connector_offline", code: 1008 });
    });

    it("caps the sessions per relay id", async () => {
      const { control, key } = await registerConnector(relay());
      const phones: TestSocket[] = [];
      for (let i = 0; i < 2; i++) {
        phones.push(await TestSocket.open(`${relay().url}/v1/dial/${key.relayId}`));
        expect(await control.json()).toMatchObject({ t: "dial" });
      }
      const third = await TestSocket.open(`${relay().url}/v1/dial/${key.relayId}`);
      expect(await third.refused()).toEqual({ error: "session_limit", code: 1008 });
      for (const phone of phones) phone.close();
      control.close();
    });

    it("caps the dials per minute from one address", async () => {
      const { control, key } = await registerConnector(relay());
      for (let i = 0; i < 4; i++) {
        const phone = await TestSocket.open(`${relay().url}/v1/dial/${key.relayId}`);
        expect(await control.json()).toMatchObject({ t: "dial" });
        phone.close();
        await phone.closed;
      }
      const flood = await TestSocket.open(`${relay().url}/v1/dial/${key.relayId}`);
      expect(await flood.refused()).toEqual({ error: "rate_limited", code: 1008 });
      control.close();
    });

    it("caps control connections per minute and control sockets still unregistered", async () => {
      const key = connectorKey();
      const pending = [
        await openControl(relay(), key.relayId),
        await openControl(relay(), key.relayId),
      ];
      const third = await TestSocket.open(`${relay().url}/v1/connector/${key.relayId}`);
      expect(await third.refused()).toEqual({ error: "rate_limited", code: 1008 });
      for (const { socket } of pending) {
        socket.close();
        await socket.closed;
      }
      // Three connections so far this minute; the fourth is the last one allowed.
      const fourth = await openControl(relay(), key.relayId);
      fourth.socket.close();
      const fifth = await TestSocket.open(`${relay().url}/v1/connector/${key.relayId}`);
      expect(await fifth.refused()).toEqual({ error: "rate_limited", code: 1008 });
    });

    it("closes a session once it has carried its byte budget", async () => {
      const { control, key } = await registerConnector(relay());
      const { phone, session } = await splice(relay(), control, key.relayId);
      const frame = bytesOf(MAX_FRAME_BYTES);
      for (let i = 0; i < 4; i++) {
        (i % 2 === 0 ? phone : session).send(frame);
        expect(await (i % 2 === 0 ? session : phone).bytes()).toEqual(frame);
      }
      phone.send(frame);
      expect(await phone.refused()).toEqual({ error: "rate_limited", code: 1008 });
      expect(await session.refused()).toEqual({ error: "rate_limited", code: 1008 });
      control.close();
    });

    it("keeps a challenge, a registration and a splice through hibernation", async () => {
      const key = connectorKey();
      const { socket: control, nonce } = await openControl(relay(), key.relayId);
      await relay().hibernate(key.relayId);
      control.send(register(relay(), proofFor(relay(), key, nonce)));
      expect(await control.json()).toEqual({ t: "registered" });
      await relay().hibernate(key.relayId);
      const { phone, session } = await splice(relay(), control, key.relayId);
      await relay().hibernate(key.relayId);
      const up = bytesOf(5_000, 11);
      phone.send(up);
      expect(await session.bytes()).toEqual(up);
      session.send(up);
      expect(await phone.bytes()).toEqual(up);
      phone.send(RELAY_PING);
      expect(await phone.json()).toEqual(pong);
      await relay().hibernate(key.relayId);
      phone.close();
      expect(await session.refused()).toEqual({ error: "peer_gone", code: 1000 });
      // The relay id is still pinned to its key after hibernation.
      const stranger = connectorKey();
      const other = await openControl(relay(), key.relayId);
      other.socket.send(register(relay(), proofFor(relay(), stranger, other.nonce)));
      expect(await other.socket.refused()).toEqual({ error: "bad_proof", code: 1008 });
      control.close();
    });
  });

  describe("deadlines, with nothing arriving", { timeout: 30_000 }, () => {
    // The room clock runs 30 times faster: the 60-second challenge lasts 2 seconds.
    const relay = relayFor(runtime, { warp: 30, limits: { idleMs: 60_000 } });

    // These sockets send nothing at all. On the Worker, the close after the error then takes
    // workerd about 10 seconds to finish (see the README), so only the error is timed.
    it("ends a challenge that gets no answer", { timeout: 40_000 }, async () => {
      const started = Date.now();
      const { socket } = await openControl(relay(), connectorKey().relayId, { greet: false });
      expect(await socket.json(10_000)).toEqual({ t: "error", code: "idle_timeout" });
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(relay().real(60_000) - 50);
      expect(elapsed).toBeLessThan(relay().real(60_000) + 2_000);
      expect((await socket.closed).code).toBe(1000);
    });

    it("ends a dial the connector never answers", { timeout: 40_000 }, async () => {
      const { control, key } = await registerConnector(relay());
      const started = Date.now();
      const phone = await TestSocket.open(`${relay().url}/v1/dial/${key.relayId}`, {
        greet: false,
      });
      expect(await control.json()).toMatchObject({ t: "dial" });
      expect(await phone.json(10_000)).toEqual({ t: "error", code: "dial_timeout" });
      expect(Date.now() - started).toBeLessThan(relay().real(15_000) + 2_000);
      expect((await phone.closed).code).toBe(1000);
      control.close();
    });

    it("keeps sockets that ping, and closes them once they go quiet", async () => {
      const { control, key } = await registerConnector(relay());
      const { phone, session } = await splice(relay(), control, key.relayId);
      // Pings for longer than the idle limit keep everything open.
      const until = Date.now() + relay().real(60_000) * 1.5;
      while (Date.now() < until) {
        control.send(RELAY_PING);
        phone.send(RELAY_PING);
        expect(await control.json()).toEqual(pong);
        expect(await phone.json()).toEqual(pong);
        await sleep(relay().real(10_000));
      }
      expect(await control.refused(10_000)).toEqual({ error: "idle_timeout", code: 1000 });
      expect(await phone.refused(10_000)).toEqual({ error: "idle_timeout", code: 1000 });
      expect(await session.refused(10_000)).toEqual({ error: "idle_timeout", code: 1000 });
    });
  });

  describe.each(["replay", "claims"] as const)("with a failing %s store", (fault) => {
    const relay = relayFor(runtime, { fault });

    it("fails the registration", { timeout: 20_000 }, async () => {
      const key = connectorKey();
      const { socket, nonce } = await openControl(relay(), key.relayId);
      socket.send(register(relay(), proofFor(relay(), key, nonce)));
      expect(await socket.refused()).toEqual({ error: "internal", code: 1011 });
      const phone = await TestSocket.open(`${relay().url}/v1/dial/${key.relayId}`);
      expect(await phone.refused()).toEqual({ error: "connector_offline", code: 1008 });
    });
  });
});
