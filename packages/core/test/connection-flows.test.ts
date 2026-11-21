// Parity rows for connecting and pairing that the core decides.
import { PROTOCOL_VERSION } from "@openclaw/gateway-client/browser";
import { describe, expect, it } from "vitest";
import { createBridgeSession, parseBridgeCommand } from "../src/bridge.ts";
import { ClawtrateClient } from "../src/client.ts";
import { MAX_GATEWAY_URL_CHARS } from "../src/gateway-url.ts";
import { pairingEnded, protocolMismatch } from "../src/connect-errors.ts";
import {
  FakeGateway,
  deferred,
  helloOk,
  memoryStorage,
  sleep,
  testHost,
  tokenKey,
  until,
} from "./fake-gateway.ts";

const URL = "ws://127.0.0.1:19001";
const OTHER_URL = "ws://127.0.0.1:19002";
const FAST = { reconnect: { initialMs: 20, maxMs: 40 } };

/**
 * Memory storage whose writes land one at a time, in order, as the file store's
 * do. A test can hold a key's next write before it lands, or the answer to it
 * after it has landed.
 */
function orderedStorage() {
  const base = memoryStorage();
  let tail: Promise<void> = Promise.resolve();
  const beforeLanding = new Map<string, Promise<void>>();
  const afterLanding = new Map<string, Promise<void>>();
  const write = (key: string, change: () => void) => {
    const landed = beforeLanding.get(key);
    const answered = afterLanding.get(key);
    beforeLanding.delete(key);
    afterLanding.delete(key);
    const run = tail.then(async () => {
      await landed;
      change();
    });
    tail = run.catch(() => {});
    return answered ? run.then(() => answered) : run;
  };
  const hold = (gates: Map<string, Promise<void>>, key: string) => {
    const gate = deferred<void>();
    gates.set(key, gate.promise);
    return () => gate.resolve();
  };
  return {
    ...base,
    set: (key: string, value: string) => write(key, () => void base.data.set(key, value)),
    delete: (key: string) => write(key, () => void base.data.delete(key)),
    /** Hold the key's next write before it lands; the returned function lets it land. */
    holdWrite: (key: string) => hold(beforeLanding, key),
    /** Let the key's next write land but hold its answer; the returned function answers. */
    holdAnswer: (key: string) => hold(afterLanding, key),
  };
}

/** Storage whose writes can be made to fail and then work again. */
function failingStorage() {
  const storage = memoryStorage();
  const set = storage.set.bind(storage);
  return Object.assign(storage, {
    failWrites(failing: boolean) {
      storage.set = failing ? () => Promise.reject(new Error("The disk is full.")) : set;
    },
  });
}

const savedSettings = (storage: { data: Map<string, string> }) =>
  JSON.parse(storage.data.get("connection") ?? "null") as {
    url: string;
    suspended?: boolean;
  } | null;

/** A gateway that answers every connect with a pairing request; the id can change. */
function pairingGateway(ids: string[]) {
  const gateway = new FakeGateway();
  let attempt = 0;
  gateway.connectReply = () => ({
    ok: false,
    error: {
      code: "NOT_PAIRED",
      message: "device pairing required",
      details: {
        code: "PAIRING_REQUIRED",
        reason: "not-paired",
        requestId: ids[Math.min(attempt++, ids.length - 1)],
        deviceId: "device-1",
        requestedRole: "operator",
        requestedScopes: ["operator.read"],
      },
    },
  });
  return gateway;
}

describe("pairing", () => {
  it("F-002: the pending request lists exactly the scopes this device asked for", async () => {
    const gateway = pairingGateway(["req-1"]);
    const client = new ClawtrateClient(testHost(gateway), FAST);
    await client.connect({ url: URL, token: "t" });
    await until(() => client.state.connection.status === "pairing");
    expect((gateway.connects[0] as { scopes: string[] }).scopes).toEqual(["operator.read"]);
    expect(client.state.connection.pairing?.requestedScopes).toEqual(["operator.read"]);
    client.stop();
  });

  it("F-009: a request that is no longer pending says it was rejected or expired, without guessing which; retrying asks again", async () => {
    const gateway = pairingGateway(["req-1", "req-2", "req-3"]);
    const client = new ClawtrateClient(testHost(gateway), FAST);
    await client.connect({ url: URL, token: "t" });
    await until(() => client.state.connection.pairing?.requestId === "req-1");
    // "Check now": the gateway answers with a new request, so the old one is gone.
    await client.retryNow();
    await until(() => client.state.connection.status === "error");
    expect(client.state.connection.error).toMatchObject({ code: "PAIRING_ENDED" });
    expect(client.state.connection.error?.message).toMatch(
      /^It was rejected, or it expired before anyone approved it; the gateway does not say which\. Try again to send a new request/,
    );
    expect(client.state.connection.pairing).toBe(null);
    const attempts = gateway.connects.length;
    await sleep(100);
    expect(gateway.connects.length, "it stops retrying").toBe(attempts);
    // Trying again shows the new request.
    await client.retryNow();
    await until(() => client.state.connection.status === "pairing");
    expect(client.state.connection.pairing?.requestId).toBe("req-3");
    expect(client.state.connection.error).toBe(null);
    client.stop();
  });

  it("F-009: however long the request waited, the outcome is the same", async () => {
    let clock = 1_000_000;
    const gateway = pairingGateway(["req-1", "req-2"]);
    const client = new ClawtrateClient({ ...testHost(gateway), now: () => clock }, FAST);
    await client.connect({ url: URL, token: "t" });
    await until(() => client.state.connection.pairing?.requestId === "req-1");
    // Well past OpenClaw's pending lifetime of five minutes: a rejection then
    // looks the same as an expiry, so the client still does not choose one.
    clock += 600_000;
    await client.retryNow();
    await until(() => client.state.connection.status === "error");
    expect(client.state.connection.error).toMatchObject({ code: "PAIRING_ENDED" });
    client.stop();
  });

  it("F-009: a request has ended only when a different one replaces it", () => {
    expect(pairingEnded(null, "a")).toBe(false);
    expect(pairingEnded("a", "a")).toBe(false);
    expect(pairingEnded("a", "")).toBe(false);
    expect(pairingEnded("a", "b")).toBe(true);
  });
});

describe("connecting", () => {
  it("F-003: bots are published as soon as they load, before the tasks have", async () => {
    const gateway = new FakeGateway();
    let release: () => void = () => {};
    const tasks = new Promise<void>((resolve) => (release = resolve));
    gateway.handlers["sessions.subscribe"] = async () => {
      await tasks;
      return { subscribed: true, list: { sessions: [], hasMore: false } };
    };
    const client = new ClawtrateClient(testHost(gateway, memoryStorage()), FAST);
    await client.connect({ url: URL, token: "t" });
    await until(() => client.state.bots.length === 1);
    expect(client.state.discovery.status).toBe("loading");
    release();
    await until(() => client.state.discovery.status === "ready");
    client.stop();
  });

  it("F-009 F-387: an attempt nobody answers says what happened while it retries", async () => {
    const gateway = new FakeGateway();
    gateway.refuseConnections = true;
    const client = new ClawtrateClient(testHost(gateway), FAST);
    await client.connect({ url: URL, token: "t" });
    await until(() => client.state.connection.error?.code === "UNREACHABLE");
    expect(client.state.connection.status).toBe("connecting");
    expect(client.state.connection.error?.message).toBe("Nothing answered at 127.0.0.1:19001.");
    gateway.refuseConnections = false;
    await until(() => client.state.connection.status === "connected");
    expect(client.state.connection.error).toBe(null);
    client.stop();
  });

  it("F-387: Reconnect to a gateway that no longer answers goes from Connecting back to Offline, with the error", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: true,
      payload: helloOk(["operator.read"], "device-token"),
    });
    const client = new ClawtrateClient(testHost(gateway), FAST);
    await client.connect({ url: URL, token: "t" });
    await until(() => client.state.discovery.status === "ready");
    await client.suspend();
    gateway.refuseConnections = true;
    const seen: Array<{ status: string; retryAt: number | null; error: string | null }> = [];
    const stop = client.store.subscribe((state) =>
      seen.push({
        status: state.connection.status,
        retryAt: state.connection.retryAt,
        error: state.connection.error?.code ?? null,
      }),
    );
    await client.retryNow();
    await until(() => client.state.connection.error?.code === "UNREACHABLE");
    // An attempt under way (no retry scheduled), then waiting for the next with the error.
    expect(
      seen.some((s) => s.retryAt === null && s.error === null && s.status !== "disconnected"),
    ).toBe(true);
    await until(() => client.state.connection.retryAt !== null);
    expect(client.state.connection).toMatchObject({
      error: { code: "UNREACHABLE", message: "Nothing answered at 127.0.0.1:19001." },
    });
    expect(["connecting", "reconnecting"]).toContain(client.state.connection.status);
    expect(client.state.bots, "what was on screen stays").toHaveLength(1);
    stop();
    client.stop();
  });

  it("F-263: a gateway outside the client's protocol range gets no further requests, and the error names both versions", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "protocol mismatch",
        details: {
          code: "PROTOCOL_MISMATCH",
          clientMinProtocol: PROTOCOL_VERSION,
          clientMaxProtocol: PROTOCOL_VERSION,
          expectedProtocol: 5,
          minimumProbeProtocol: 3,
        },
      },
    });
    const client = new ClawtrateClient(testHost(gateway), FAST);
    await client.connect({ url: URL, token: "t" });
    await until(() => client.state.connection.status === "error");
    expect(client.state.connection.error).toMatchObject({
      code: "PROTOCOL_MISMATCH",
      protocol: { gateway: 5, client: PROTOCOL_VERSION },
      message: `This gateway speaks protocol 5. This version of Clawtrate speaks protocol ${PROTOCOL_VERSION}.`,
    });
    await sleep(100);
    expect(gateway.requests, "no feature or mutation requests").toEqual([]);
    expect(gateway.connects, "and no more handshakes until asked").toHaveLength(1);
    // Retry repeats the handshake.
    await client.retryNow();
    await until(() => gateway.connects.length === 2);
    client.stop();
  });

  it("F-263: a hello with another protocol is not used", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({ ok: true, payload: { ...helloOk(), protocol: 9 } });
    const client = new ClawtrateClient(testHost(gateway), FAST);
    await client.connect({ url: URL, token: "t" });
    await until(() => client.state.connection.status === "error");
    expect(client.state.connection.error?.protocol).toEqual({
      gateway: 9,
      client: PROTOCOL_VERSION,
    });
    expect(gateway.requests).toEqual([]);
    client.stop();
  });

  it("F-263: reads the protocol the gateway names from its error details", () => {
    expect(protocolMismatch({ code: "PROTOCOL_MISMATCH", expectedProtocol: 5 })).toEqual({
      gateway: 5,
      client: PROTOCOL_VERSION,
    });
    expect(protocolMismatch({ code: "PROTOCOL_MISMATCH" })).toEqual({
      gateway: null,
      client: PROTOCOL_VERSION,
    });
    expect(protocolMismatch({ code: "PAIRING_REQUIRED" })).toBe(null);
  });

  it("F-457 F-387: Disconnect closes the connection and keeps the pairing and what is on screen; Reconnect connects again", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: true,
      payload: helloOk(["operator.read"], "device-token"),
    });
    const storage = memoryStorage();
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await client.connect({ url: URL, token: "bootstrap" });
    await until(() => client.state.discovery.status === "ready");
    const session = createBridgeSession(client);
    await session.apply(parseBridgeCommand({ type: "suspend" }));
    expect(client.state.connection.status).toBe("disconnected");
    expect(client.state.connection.gatewayUrl).toBe(URL);
    expect(client.state.bots).toHaveLength(1);
    expect([...storage.data.keys()].some((key) => key.startsWith("deviceToken:"))).toBe(true);
    const sockets = gateway.sockets.filter((socket) => socket.readyState === 1);
    expect(sockets, "the connection is closed").toEqual([]);
    await sleep(100);
    expect(client.state.connection.status, "and it stays closed").toBe("disconnected");
    // Reconnect: the same gateway, with the device token, no bootstrap token.
    await session.apply(parseBridgeCommand({ type: "retry" }));
    await until(() => client.state.connection.status === "connected");
    const last = gateway.connects.at(-1) as { auth?: { token?: string; deviceToken?: string } };
    expect(last.auth?.token ?? last.auth?.deviceToken).toBe("device-token");
    client.stop();
  });

  it("F-457: after Disconnect, a restarted client stays disconnected until Reconnect, which then lasts across a restart too", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: true,
      payload: helloOk(["operator.read"], "device-token"),
    });
    const storage = memoryStorage();
    const first = new ClawtrateClient(testHost(gateway, storage), FAST);
    await first.start();
    await first.connect({ url: URL, token: "bootstrap" });
    await until(() => first.state.connection.status === "connected");
    await createBridgeSession(first).apply(parseBridgeCommand({ type: "suspend" }));
    first.stop();

    // The app quits and starts again, on the same device storage.
    const attempts = gateway.connects.length;
    const second = new ClawtrateClient(testHost(gateway, storage), FAST);
    await second.start();
    await sleep(150);
    expect(gateway.connects.length, "it does not reconnect by itself").toBe(attempts);
    expect(second.state.connection).toMatchObject({ status: "disconnected", gatewayUrl: URL });
    // Reconnect: the same gateway and device token.
    await createBridgeSession(second).apply(parseBridgeCommand({ type: "retry" }));
    await until(() => second.state.connection.status === "connected");
    second.stop();

    // Having reconnected, the next start opens the gateway as usual.
    const third = new ClawtrateClient(testHost(gateway, storage), FAST);
    await third.start();
    await until(() => third.state.connection.status === "connected");
    third.stop();
  });

  it("a gateway this device could not forget stays connected and saved; forgetting it once it can be written ends as usual", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: true,
      payload: helloOk(["operator.read"], "device-token"),
    });
    const storage = memoryStorage();
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await client.connect({ url: URL, token: "bootstrap" });
    await until(() => client.state.discovery.status === "ready");
    const remove = storage.delete.bind(storage);
    storage.delete = () => Promise.reject(new Error("The disk is full."));
    const session = createBridgeSession(client);
    await expect(
      session.apply(parseBridgeCommand({ type: "disconnect", gatewayUrl: URL })),
    ).rejects.toThrow("The disk is full.");
    expect(client.state.connection).toMatchObject({ status: "connected", gatewayUrl: URL });
    expect(client.state.bots).toHaveLength(1);
    expect(storage.data.has("connection"), "the gateway is still saved").toBe(true);
    await sleep(100);
    expect(client.state.connection.status).toBe("connected");
    const open = gateway.sockets.filter((socket) => socket.readyState === 1);
    expect(open, "the connection stays open").toHaveLength(1);
    storage.delete = remove;
    await session.apply(parseBridgeCommand({ type: "disconnect", gatewayUrl: URL }));
    expect(client.state.connection).toMatchObject({ status: "idle", gatewayUrl: null });
    expect(storage.data.has("connection")).toBe(false);
    client.stop();
  });

  it("forgetting a gateway while its first hello drops the shared token leaves it forgotten, after a restart too", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: true,
      payload: helloOk(["operator.read"], "device-token"),
    });
    const storage = orderedStorage();
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    // The hello saves the device token, and waits for the answer to that write.
    const answerToken = storage.holdAnswer(tokenKey(URL));
    await client.connect({ url: URL, token: "bootstrap" });
    await until(() => storage.data.has(tokenKey(URL)));
    // Disconnect's removal is under way and has not landed yet.
    const landForget = storage.holdWrite("connection");
    const forgetting = client.disconnect();
    await sleep(20);
    // The hello moves on toward dropping the shared token from the saved gateway.
    answerToken();
    await sleep(50);
    landForget();
    await forgetting;
    await sleep(100);
    expect(client.state.connection).toMatchObject({ status: "idle", gatewayUrl: null });
    expect(storage.data.has("connection"), "the gateway is not saved again").toBe(false);
    client.stop();

    const attempts = gateway.connects.length;
    const restarted = new ClawtrateClient(testHost(gateway, storage), FAST);
    await restarted.start();
    await sleep(150);
    expect(gateway.connects.length, "a restart opens no gateway").toBe(attempts);
    expect(restarted.state.connection.status).toBe("idle");
    restarted.stop();
  });

  it("a gateway that could not be saved is not the one Disconnect in Settings keeps", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: true,
      payload: helloOk(["operator.read"], "device-token"),
    });
    const storage = failingStorage();
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await client.connect({ url: URL, token: "bootstrap" });
    await until(() => client.state.connection.status === "connected");
    storage.failWrites(true);
    await expect(client.connect({ url: OTHER_URL, token: "other" })).rejects.toThrow(
      "The disk is full.",
    );
    expect(client.state.connection.gatewayUrl).toBe(URL);
    storage.failWrites(false);
    await createBridgeSession(client).apply(parseBridgeCommand({ type: "suspend" }));
    expect(savedSettings(storage)).toMatchObject({ url: URL, suspended: true });
    expect(client.state.connection).toMatchObject({ status: "disconnected", gatewayUrl: URL });
    client.stop();
  });

  it.each(["Connect", "Reconnect"])(
    "F-457: Stop keeps a pending %s and the request queued behind it from opening a socket",
    async (action) => {
      const gateway = new FakeGateway();
      const storage = orderedStorage();
      storage.data.set("connection", JSON.stringify({ url: URL, suspended: true }));
      const client = new ClawtrateClient(testHost(gateway, storage), FAST);
      await client.start();
      const release = storage.holdAnswer("connection");
      const pending = action === "Connect" ? client.connect({ url: OTHER_URL }) : client.retryNow();
      await until(() => !savedSettings(storage)?.suspended);
      const queued = action === "Connect" ? client.retryNow() : client.connect({ url: OTHER_URL });
      client.stop();
      release();
      try {
        await Promise.all([pending, queued]);
        expect(gateway.sockets).toHaveLength(0);
        await client.retryNow();
        expect(gateway.sockets).toHaveLength(1);
      } finally {
        client.stop();
      }
    },
  );

  it("F-457: stopping during startup leaves the saved gateway closed", async () => {
    const gateway = new FakeGateway();
    const storage = memoryStorage({ connection: JSON.stringify({ url: URL }) });
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    const starting = client.start();
    client.stop();
    try {
      await starting;
      expect(gateway.sockets).toHaveLength(0);
      expect(savedSettings(storage)?.url).toBe(URL);
    } finally {
      client.stop();
    }
  });

  it("a Reconnect that could not be saved fails again on the next try, and opens nothing", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: true,
      payload: helloOk(["operator.read"], "device-token"),
    });
    const storage = failingStorage();
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await client.connect({ url: URL, token: "bootstrap" });
    await until(() => client.state.connection.status === "connected");
    const session = createBridgeSession(client);
    await session.apply(parseBridgeCommand({ type: "suspend" }));
    const sockets = gateway.sockets.length;
    storage.failWrites(true);
    const retry = () => session.apply(parseBridgeCommand({ type: "retry" }));
    await expect(retry()).rejects.toThrow("The disk is full.");
    await expect(retry(), "the second Reconnect fails too").rejects.toThrow("The disk is full.");
    await sleep(100);
    expect(gateway.sockets.length, "no connection is opened").toBe(sockets);
    expect(client.state.connection.status).toBe("disconnected");
    expect(savedSettings(storage)).toMatchObject({ url: URL, suspended: true });
    client.stop();
  });

  it("a view that still shows one gateway cannot forget the gateway another view chose since", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: true,
      payload: helloOk(["operator.read"], "device-token"),
    });
    const storage = memoryStorage();
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await client.connect({ url: URL, token: "bootstrap" });
    await until(() => client.state.connection.status === "connected");
    const stale = createBridgeSession(client);
    const current = createBridgeSession(client);
    await current.apply(parseBridgeCommand({ type: "connect", url: OTHER_URL, token: "other" }));
    await until(() => client.state.connection.status === "connected");
    await expect(
      stale.apply(parseBridgeCommand({ type: "disconnect", gatewayUrl: URL })),
    ).rejects.toThrow("The selected gateway changed. Choose again.");
    expect(client.state.connection).toMatchObject({ status: "connected", gatewayUrl: OTHER_URL });
    expect(savedSettings(storage)?.url, "the other gateway stays saved").toBe(OTHER_URL);
    client.stop();
  });

  it("two views forgetting the same gateway both finish, and it is forgotten once", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: true,
      payload: helloOk(["operator.read"], "device-token"),
    });
    const storage = memoryStorage();
    const remove = storage.delete.bind(storage);
    let removals = 0;
    storage.delete = (key) => {
      if (key === "connection") removals += 1;
      return remove(key);
    };
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await client.connect({ url: URL, token: "bootstrap" });
    await until(() => client.state.connection.status === "connected");
    const forget = { type: "disconnect", gatewayUrl: URL };
    await Promise.all([
      createBridgeSession(client).apply(parseBridgeCommand(forget)),
      createBridgeSession(client).apply(parseBridgeCommand(forget)),
    ]);
    expect(removals, "the second finds nothing left to forget").toBe(1);
    expect(client.state.connection).toMatchObject({ status: "idle", gatewayUrl: null });
    expect(storage.data.has("connection")).toBe(false);
    client.stop();
  });

  it("F-457: a normalized address stays whole for Forget, including after a restart", async () => {
    const raw = URL + "/" + "é".repeat(400);
    const address = URL + "/" + "%C3%A9".repeat(400);
    expect(address.length).toBeGreaterThan(2_048);
    const storage = memoryStorage();
    const gateway = new FakeGateway();
    const first = new ClawtrateClient(testHost(gateway, storage), FAST);
    const resumed = new ClawtrateClient(testHost(gateway, storage), FAST);
    try {
      await createBridgeSession(first).apply(parseBridgeCommand({ type: "connect", url: raw }));
      expect(savedSettings(storage)?.url).toBe(address);
      expect(first.state.connection.gatewayUrl).toBe(address);
      await expect(
        first.connect({ url: URL + "/" + "a".repeat(MAX_GATEWAY_URL_CHARS) }),
      ).rejects.toThrow("The gateway address is too long.");
      expect(savedSettings(storage)?.url).toBe(address);
      first.stop();
      await resumed.start();
      const shown = resumed.state.connection.gatewayUrl;
      expect(shown).toBe(address);
      const viewer = createBridgeSession(resumed);
      // The connection form can submit its prefilled address to pair again, too.
      await viewer.apply(parseBridgeCommand({ type: "connect", url: shown }));
      await expect(
        viewer.apply(
          parseBridgeCommand({
            type: "disconnect",
            gatewayUrl: address.slice(0, -1) + "F",
          }),
        ),
      ).rejects.toThrow("The selected gateway changed");
      await viewer.apply(parseBridgeCommand({ type: "disconnect", gatewayUrl: shown }));
      expect(savedSettings(storage)).toBeNull();
    } finally {
      first.stop();
      resumed.stop();
    }
  });

  it("a forget names the gateway it means", () => {
    expect(() => parseBridgeCommand({ type: "disconnect" })).toThrow("invalid url");
    expect(() =>
      parseBridgeCommand({
        type: "disconnect",
        gatewayUrl: `ws://${"a".repeat(MAX_GATEWAY_URL_CHARS)}`,
      }),
    ).toThrow("invalid url");
  });

  it("a shared token that could not be removed after pairing is removed on the next hello", async () => {
    const gateway = new FakeGateway();
    let hellos = 0;
    // The first hello pairs this device; a later one need not send the device token again.
    gateway.connectReply = () => ({
      ok: true,
      payload: (hellos += 1) === 1 ? helloOk(["operator.read"], "device-token") : helloOk(),
    });
    const storage = memoryStorage();
    const set = storage.set.bind(storage);
    let failed = false;
    storage.set = (key, value) => {
      // Dropping the shared token fails, once.
      if (key === "connection" && !failed && JSON.parse(value).token === null) {
        failed = true;
        return Promise.reject(new Error("The disk is full."));
      }
      return set(key, value);
    };
    const logged: string[] = [];
    const host = {
      ...testHost(gateway, storage),
      log: (_: string, message: string) => void logged.push(message),
    };
    const client = new ClawtrateClient(host, FAST);
    await client.start();
    await client.connect({ url: URL, token: "bootstrap" });
    await until(() => client.state.connection.status === "connected");
    await until(() => failed);
    await sleep(50);
    expect(client.state.connection.status, "this hello still connects").toBe("connected");
    expect(gateway.sockets, "on the same socket").toHaveLength(1);
    expect(storage.data.has(tokenKey(URL)), "the device token is saved").toBe(true);
    expect(JSON.parse(storage.data.get("connection")!).token, "the file still holds it").toBe(
      "bootstrap",
    );
    expect(logged).toContain("Could not remove the shared gateway token from this device.");

    gateway.dropAll();
    await until(
      () => gateway.connects.length === 2 && client.state.connection.status === "connected",
    );
    const last = gateway.connects.at(-1) as { auth?: { token?: string; deviceToken?: string } };
    expect(last.auth?.token ?? last.auth?.deviceToken).toBe("device-token");
    await until(() => JSON.parse(storage.data.get("connection")!).token === null);
    expect(JSON.parse(storage.data.get("connection")!)).toEqual({
      url: URL,
      token: null,
      address: true,
    });
    client.stop();
  });

  it("a refused device token that could not be removed leaves the refusal on screen, and is not taken for a pairing", async () => {
    // A removal that fails unhandled fails this file: Vitest reports every unhandled rejection.
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: true,
      payload: helloOk(["operator.read"], "device-token"),
    });
    const storage = memoryStorage();
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await client.connect({ url: URL, token: "bootstrap" });
    await until(() => client.state.connection.status === "connected");
    expect(client.state.connection.paired).toBe(true);
    const remove = storage.delete.bind(storage);
    storage.delete = (key) =>
      key === tokenKey(URL) ? Promise.reject(new Error("The disk is full.")) : remove(key);
    // The gateway no longer accepts this device's token.
    const refuse = () => ({
      ok: false as const,
      error: {
        code: "UNAUTHORIZED",
        message: "device token mismatch",
        details: { code: "AUTH_DEVICE_TOKEN_MISMATCH", recommendedNextStep: "re_pair" },
      },
    });
    gateway.connectReply = refuse;
    gateway.dropAll();
    await until(() => client.state.connection.error?.code === "AUTH_DEVICE_TOKEN_MISMATCH");
    await sleep(50);
    expect(storage.data.has(tokenKey(URL)), "the refused token is still on disk").toBe(true);
    expect(client.state.connection).toMatchObject({
      paired: false,
      error: { code: "AUTH_DEVICE_TOKEN_MISMATCH", message: "device token mismatch" },
    });
    // Another attempt does not take the token still on disk for a pairing.
    const attempts = gateway.connects.length;
    await client.retryNow();
    expect(client.state.connection.paired, "trying again is not paired").toBe(false);
    await until(() => gateway.connects.length > attempts);
    await until(() => client.state.connection.error?.code === "AUTH_DEVICE_TOKEN_MISMATCH");
    expect(client.state.connection.paired).toBe(false);
    // Only a hello says this device is paired.
    gateway.connectReply = () => ({
      ok: true,
      payload: helloOk(["operator.read"], "device-token"),
    });
    await client.retryNow();
    await until(() => client.state.connection.status === "connected");
    expect(client.state.connection.paired).toBe(true);
    client.stop();
  });
});
