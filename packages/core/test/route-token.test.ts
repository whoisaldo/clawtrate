// Routes (docs/decisions.md, "Routes, when the setup flow's SSH package is
// built"): a routed connection's device token is kept for its route, never for
// the address it answers on now, so an SSH forward that comes back on another
// channel reconnects with the same token, keeps what is on screen, and sends
// nothing while the route is held. After every hello the gateway's identity is
// read before anything else is asked or allowed, and the route's address is
// asked again before anything is signed or sent.

import { describe, expect, it } from "vitest";
import {
  ClawtrateClient,
  ROUTE_IDENTITY_CHANGED,
  ROUTE_IDENTITY_UNREAD,
  ROUTE_NOT_SAVED,
  SETUP_PAIRING_GONE,
} from "../src/client.ts";
import { FakeGateway, helloOk, memoryStorage, sleep, testHost, until } from "./fake-gateway.ts";

const ROUTE = "ssh-0123456789abcdef01234567";
const ROUTE_TOKEN = `deviceToken:route:${ROUTE}:device-1:operator`;

function setup(options: { allowed?: () => boolean } = {}) {
  const gateway = new FakeGateway();
  gateway.connectReply = () => ({ ok: true, payload: helloOk(["operator.read"], "token-1") });
  let identity: string | null = "gateway-1";
  gateway.handlers["gateway.identity.get"] = () => {
    if (identity === null) throw new Error("no identity");
    return { deviceId: identity, publicKey: "key" };
  };
  const storage = memoryStorage();
  const client = new ClawtrateClient(testHost(gateway, storage), {
    reconnect: { initialMs: 20, maxMs: 40 },
    ...(options.allowed ? { allowGatewayUrl: options.allowed } : {}),
  });
  return { gateway, storage, client, setIdentity: (next: string | null) => (identity = next) };
}

const SAVED_TOKEN = JSON.stringify({
  token: "token-1",
  grantedScopes: ["operator.read"],
  heldScopes: ["operator.read"],
});

describe("a routed connection", () => {
  it("keeps its first token for the route, never for the address, and only for exactly read", async () => {
    const { gateway, storage, client } = setup();
    await client.start();
    await client.connectRoute({
      url: "ws://127.0.0.1:50001",
      route: ROUTE,
      code: { bootstrapToken: "b".repeat(43), expiresAtMs: Date.now() + 60_000 },
    });
    await until(() => client.state.connection.status === "connected");
    expect(JSON.parse(storage.data.get(ROUTE_TOKEN)!)).toMatchObject({ token: "token-1" });
    expect([...storage.data.keys()].filter((key) => key.startsWith("deviceToken"))).toEqual([
      ROUTE_TOKEN,
    ]);
    expect(await client.hasRouteToken(ROUTE)).toBe(true);
    expect(await client.hasDeviceToken("ws://127.0.0.1:50001")).toBe(false);
    expect((gateway.connects[0] as { auth: { bootstrapToken: string } }).auth.bootstrapToken).toBe(
      "b".repeat(43),
    );
  });

  it("comes back on another address with the route's own token, keeps what is on screen, and sends nothing while held", async () => {
    const { gateway, storage, client } = setup();
    storage.data.set(
      ROUTE_TOKEN,
      JSON.stringify({
        token: "token-1",
        grantedScopes: ["operator.read"],
        heldScopes: ["operator.read"],
      }),
    );
    await client.start();
    await client.connectRoute({ url: "ws://127.0.0.1:50001", route: ROUTE });
    await until(
      () => client.state.connection.status === "connected" && client.state.bots.length > 0,
    );
    const sockets = gateway.sockets.length;
    client.holdRoute(ROUTE);
    expect(client.state.connection.status).toBe("reconnecting");
    gateway.dropAll();
    await sleep(200);
    // Held: no socket is opened again by the client's own retries.
    expect(gateway.sockets.length).toBe(sockets);
    expect(client.state.bots.length).toBeGreaterThan(0);
    await client.connectRoute({ url: "ws://127.0.0.1:50002", route: ROUTE });
    expect(client.state.connection.status).toBe("reconnecting");
    expect(client.state.bots.length).toBeGreaterThan(0);
    await until(() => client.state.connection.status === "connected");
    expect(gateway.sockets.at(-1)!.url).toBe("ws://127.0.0.1:50002");
    const auth = (gateway.connects.at(-1) as { auth: Record<string, string> }).auth;
    expect(auth.bootstrapToken).toBeUndefined();
    expect(JSON.stringify(auth)).toContain("token-1");
  });

  it("is never resumed by the client itself: its host opens the route first", async () => {
    const { gateway, storage, client } = setup();
    storage.data.set(
      "connection",
      JSON.stringify({ url: "ws://127.0.0.1:50001", token: null, route: ROUTE }),
    );
    await client.start();
    await sleep(50);
    expect(gateway.sockets).toEqual([]);
    expect(client.state.connection.status).toBe("idle");
    expect((await client.savedSettings())?.route).toBe(ROUTE);
  });

  it("a dropped route token is gone, and another route's token is never offered", async () => {
    const { gateway, storage, client } = setup();
    storage.data.set(
      ROUTE_TOKEN,
      JSON.stringify({ token: "token-1", heldScopes: ["operator.read"] }),
    );
    await client.start();
    await client.dropRouteToken(ROUTE);
    expect(storage.data.has(ROUTE_TOKEN)).toBe(false);
    storage.data.set(
      ROUTE_TOKEN,
      JSON.stringify({ token: "token-1", heldScopes: ["operator.read"] }),
    );
    await client.connectRoute({
      url: "ws://127.0.0.1:50001",
      route: "ssh-ffffffffffffffffffffffff",
    });
    // A route without its token sends nothing: no other credential is offered there.
    await until(() => client.state.connection.status === "error");
    expect(client.state.connection.error?.code).toBe(SETUP_PAIRING_GONE);
    expect(gateway.connects).toEqual([]);
    expect(() => client.holdRoute("not-a-route")).not.toThrow();
    await expect(client.connectRoute({ url: "ws://127.0.0.1:1", route: "../x" })).rejects.toThrow();
  });
});

describe("a routed connection's gateway", () => {
  it("is asked who it is after every hello, before anything else is read or allowed; another identity ends it", async () => {
    const { gateway, storage, client, setIdentity } = setup();
    storage.data.set(ROUTE_TOKEN, SAVED_TOKEN);
    await client.start();
    await client.connectRoute({
      url: "ws://c0000000000000001.ssh.invalid",
      route: ROUTE,
      identity: "gateway-1",
    });
    await until(() => client.state.connection.status === "connected");
    expect(client.state.connection.gatewayId).toBe("gateway-1");
    // The identity was the first thing asked on that connection.
    expect(gateway.requests[0]!.method).toBe("gateway.identity.get");
    // Another gateway answers after a reconnect: nothing is read from it, nothing is allowed.
    setIdentity("gateway-2");
    const asked = gateway.requests.length;
    const statuses: string[] = [];
    client.store.subscribe((state) => statuses.push(state.connection.status));
    await client.connectRoute({
      url: "ws://c0000000000000002.ssh.invalid",
      route: ROUTE,
      identity: "gateway-1",
    });
    await until(() => client.state.connection.status === "error");
    expect(client.state.connection.error?.code).toBe(ROUTE_IDENTITY_CHANGED);
    expect(gateway.requests.slice(asked).map((r) => r.method)).toEqual(["gateway.identity.get"]);
    expect(statuses).not.toContain("connected");
    expect(client.state.connection.canWrite).toBe(false);
    // And it is not retried by the client itself.
    const sockets = gateway.sockets.length;
    await sleep(200);
    expect(gateway.sockets.length).toBe(sockets);
  });

  it("whose identity can't be read is not used, and a route's first identity is the one read", async () => {
    const { gateway, storage, client, setIdentity } = setup();
    storage.data.set(ROUTE_TOKEN, SAVED_TOKEN);
    await client.start();
    setIdentity(null);
    await client.connectRoute({
      url: "ws://c0000000000000001.ssh.invalid",
      route: ROUTE,
      identity: null,
    });
    await until(() => client.state.connection.status === "error");
    expect(client.state.connection.error?.code).toBe(ROUTE_IDENTITY_UNREAD);
    expect(gateway.calls("agents.list")).toEqual([]);
    setIdentity("gateway-7");
    await client.connectRoute({
      url: "ws://c0000000000000002.ssh.invalid",
      route: ROUTE,
      identity: null,
    });
    await until(() => client.state.connection.status === "connected");
    expect(client.state.connection.gatewayId).toBe("gateway-7");
    // From then on the route's identity is that one, through the client's own reconnects too.
    setIdentity("gateway-8");
    gateway.dropAll();
    await until(() => client.state.connection.status === "error");
    expect(client.state.connection.error?.code).toBe(ROUTE_IDENTITY_CHANGED);
  });

  it("whose address stops being its host's channel between the socket and the sign-in gets nothing signed or sent", async () => {
    let allowed = true;
    const { gateway, storage, client } = setup({ allowed: () => allowed });
    storage.data.set(ROUTE_TOKEN, SAVED_TOKEN);
    // The token is read once when the connection is set up and again when the sign-in is built,
    // after the socket opened: the channel goes in between.
    let reads = 0;
    const get = storage.get;
    storage.get = async (key) => {
      if (key === ROUTE_TOKEN && ++reads === 2) allowed = false;
      return get(key);
    };
    await client.start();
    await client.connectRoute({
      url: "ws://c0000000000000001.ssh.invalid",
      route: ROUTE,
      identity: "gateway-1",
    });
    await until(() => client.state.connection.status === "error");
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(gateway.sockets).toHaveLength(1);
    expect(client.state.connection.error?.code).toBe("GATEWAY_NOT_ALLOWED");
    expect(gateway.connects).toEqual([]);
  });

  it("asks nothing else, takes no event and keeps no token from its hello until its gateway said who it is", async () => {
    const { gateway, storage, client } = setup();
    storage.data.set(ROUTE_TOKEN, SAVED_TOKEN);
    // The hello carries a rotated token; the identity read hangs until the test answers it.
    gateway.connectReply = () => ({ ok: true, payload: helloOk(["operator.read"], "token-2") });
    let answer: (value: unknown) => void = () => {};
    gateway.handlers["gateway.identity.get"] = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    await client.start();
    await client.connectRoute({
      url: "ws://c0000000000000001.ssh.invalid",
      route: ROUTE,
      identity: "gateway-1",
    });
    await until(() => gateway.requests.some((r) => r.method === "gateway.identity.get"));
    // Every path that asks the gateway, the engines' included, is held.
    const tried = await Promise.allSettled([
      client.refreshAccounts(),
      client.refreshRoutines(),
      client.readBotRoutines("main"),
      client.refreshCheckIns("main"),
      client.refreshUsage(),
      client.readHistoryItem("agent:main:main", "item-1"),
    ]);
    expect(tried).toHaveLength(6);
    // An event the gateway sends now counts for nothing.
    gateway.emit("sessions.changed", { sessionKey: "agent:main:x", label: "planted" });
    gateway.emit("exec.approval.requested", {
      id: "planted-approval",
      request: {
        command: "uname -s",
        host: "gateway",
        agentId: "main",
        sessionKey: "agent:main:main",
        runId: "run-1",
        allowedDecisions: ["deny"],
      },
      createdAtMs: 2_000,
      expiresAtMs: 9_000_000_000_000,
    });
    await sleep(100);
    expect(gateway.requests.map((r) => r.method)).toEqual(["gateway.identity.get"]);
    expect(JSON.stringify(client.state)).not.toContain("planted");
    // The rotated token waits in memory: the saved one is unchanged.
    expect(JSON.parse(storage.data.get(ROUTE_TOKEN)!).token).toBe("token-1");
    expect(client.state.connection.status).not.toBe("connected");
    answer({ deviceId: "gateway-1", publicKey: "key" });
    await until(() => client.state.connection.status === "connected");
    expect(JSON.parse(storage.data.get(ROUTE_TOKEN)!).token).toBe("token-2");
  });

  it("keeps no first token, and saves no connection, when the gateway that redeemed its code isn't the route's", async () => {
    const { storage, client, setIdentity } = setup();
    setIdentity(null);
    await client.start();
    await client.connectRoute({
      url: "ws://c0000000000000001.ssh.invalid",
      route: ROUTE,
      code: { bootstrapToken: "b".repeat(43), expiresAtMs: Date.now() + 60_000 },
    });
    await until(() => client.state.connection.status === "error");
    expect(client.state.connection.error?.code).toBe(ROUTE_IDENTITY_UNREAD);
    expect(storage.data.has(ROUTE_TOKEN)).toBe(false);
    expect(storage.data.has("connection")).toBe(false);
  });

  it("a rotated token from a gateway that turns out to be another is never kept, and the saved one stays", async () => {
    const { gateway, storage, client, setIdentity } = setup();
    storage.data.set(ROUTE_TOKEN, SAVED_TOKEN);
    gateway.connectReply = () => ({ ok: true, payload: helloOk(["operator.read"], "token-9") });
    setIdentity("gateway-2");
    await client.start();
    await client.connectRoute({
      url: "ws://c0000000000000001.ssh.invalid",
      route: ROUTE,
      identity: "gateway-1",
    });
    await until(() => client.state.connection.status === "error");
    expect(client.state.connection.error?.code).toBe(ROUTE_IDENTITY_CHANGED);
    expect(JSON.parse(storage.data.get(ROUTE_TOKEN)!).token).toBe("token-1");
  });

  it("a refusal before its gateway said who it is ends the attempt and makes this device forget nothing", async () => {
    const { gateway, storage, client } = setup();
    storage.data.set(ROUTE_TOKEN, SAVED_TOKEN);
    gateway.connectReply = () => ({
      ok: false,
      error: { code: "AUTH_TOKEN_MISMATCH", message: "token mismatch" },
    });
    await client.start();
    await client.connectRoute({
      url: "ws://c0000000000000001.ssh.invalid",
      route: ROUTE,
      identity: "gateway-1",
    });
    await until(() => client.state.connection.status === "error");
    const sockets = gateway.sockets.length;
    await sleep(200);
    expect(gateway.sockets.length).toBe(sockets);
    expect(storage.data.get(ROUTE_TOKEN)).toBe(SAVED_TOKEN);
  });

  it("whose token can't be saved after its gateway said who it is ends the attempt with a fixed error", async () => {
    const { storage, client } = setup();
    const set = storage.set;
    storage.set = async (key, value) => {
      if (key === ROUTE_TOKEN) throw new Error("disk full");
      return set(key, value);
    };
    await client.start();
    await client.connectRoute({
      url: "ws://c0000000000000001.ssh.invalid",
      route: ROUTE,
      code: { bootstrapToken: "b".repeat(43), expiresAtMs: Date.now() + 60_000 },
    });
    await until(() => client.state.connection.status === "error");
    expect(client.state.connection.error?.code).toBe(ROUTE_NOT_SAVED);
    expect(storage.data.has(ROUTE_TOKEN)).toBe(false);
    expect(storage.data.has("connection")).toBe(false);
  });

  it("lets go of what it held for a hello once that connection closes before its gateway said who it is", async () => {
    const { gateway, storage, client } = setup();
    storage.data.set(ROUTE_TOKEN, SAVED_TOKEN);
    gateway.connectReply = () => ({ ok: true, payload: helloOk(["operator.read"], "token-2") });
    let answer: (value: unknown) => void = () => {};
    gateway.handlers["gateway.identity.get"] = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    await client.start();
    await client.connectRoute({
      url: "ws://c0000000000000001.ssh.invalid",
      route: ROUTE,
      identity: "gateway-1",
    });
    await until(() => gateway.requests.some((r) => r.method === "gateway.identity.get"));
    const held = () => (client as unknown as { routeHeldWrites: unknown[] }).routeHeldWrites;
    expect(held()).toHaveLength(1);
    client.holdRoute(ROUTE);
    expect(held()).toEqual([]);
    answer({ deviceId: "gateway-1", publicKey: "key" });
    await sleep(100);
    expect(JSON.parse(storage.data.get(ROUTE_TOKEN)!).token).toBe("token-1");
  });
});

describe("forgetting a route", () => {
  it("is decided in the connection queue: a Connect to another route queued first stays connected", async () => {
    const OTHER = "ssh-fedcba9876543210fedcba98";
    const { storage, client } = setup();
    storage.data.set(ROUTE_TOKEN, SAVED_TOKEN);
    storage.data.set(`deviceToken:route:${OTHER}:device-1:operator`, SAVED_TOKEN);
    await client.start();
    await client.connectRoute({ url: "ws://c0000000000000001.ssh.invalid", route: ROUTE });
    await until(() => client.state.connection.status === "connected");
    // Connect to the other route is queued; the first route is forgotten right after.
    const connecting = client.connectRoute({
      url: "ws://c0000000000000002.ssh.invalid",
      route: OTHER,
    });
    const forgetting = client.forgetRoute(ROUTE);
    await Promise.all([connecting, forgetting]);
    await until(() => client.state.connection.status === "connected");
    expect(client.route).toBe(OTHER);
    expect((await client.savedSettings())?.route).toBe(OTHER);
  });
});
