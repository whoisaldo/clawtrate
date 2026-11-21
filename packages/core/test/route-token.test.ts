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
import {
  deferred,
  FakeGateway,
  helloOk,
  memoryStorage,
  sleep,
  testHost,
  until,
} from "./fake-gateway.ts";
import type { ReadBack } from "../src/approval.ts";

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

describe("F-500: a route Clawtrate disconnected after an approval it couldn't confirm", () => {
  it("stays disconnected with the design's words when its forward drops afterwards", async () => {
    const { gateway, storage, client } = setup();
    storage.data.set(ROUTE_TOKEN, SAVED_TOKEN);
    gateway.connectReply = (params) => {
      const { scopes, auth } = params as { scopes: string[]; auth?: { deviceToken?: string } };
      return { ok: true, payload: helloOk(scopes, auth?.deviceToken ?? "token-1") };
    };
    gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-1" });
    gateway.handlers["device.scopes.waitUpgrade"] = () => ({
      status: "approved",
      requestId: "up-1",
      deviceToken: "rotated",
      scopes: ["operator.read", "operator.write", "operator.admin"],
    });
    await client.start();
    await client.connectRoute({ url: "ws://127.0.0.1:50001", route: ROUTE });
    await until(() => client.state.connection.status === "connected");
    await client.requestAccess();
    await until(() => client.state.connection.upgrade.status === "unconfirmed");
    // The route's forward goes down now, before the kept disconnect has retired the route.
    client.holdRoute(ROUTE);
    expect(client.state.connection.status).toBe("error");
    expect(client.state.connection.error?.code).toBe("APPROVAL_UNCONFIRMED");
    await until(() => JSON.parse(storage.data.get("connection")!).suspended === true);
    expect(JSON.parse(storage.data.get(ROUTE_TOKEN)!).token).toBe("token-1");
    client.stop();
  });
});

describe("F-500: a route's approval, confirmed through the route", () => {
  const REQ = "0d0d0d0d-0000-4000-8000-0000000000aa";
  const INTERACTIVE = [
    "operator.read",
    "operator.write",
    "operator.approvals",
    "operator.questions",
  ];

  /** A route waiting on an upgrade; `readBack` answers the host's read there. */
  async function routed(readBack: () => Promise<unknown> | unknown) {
    const gateway = new FakeGateway();
    gateway.connectReply = (params) => {
      const { scopes, auth } = params as { scopes: string[]; auth?: { deviceToken?: string } };
      return { ok: true, payload: helloOk(scopes, auth?.deviceToken ?? "token-1") };
    };
    let identity = "gateway-1";
    gateway.handlers["gateway.identity.get"] = () => ({ deviceId: identity, publicKey: "key" });
    gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: REQ });
    let approve: (value: unknown) => void = () => {};
    gateway.handlers["device.scopes.waitUpgrade"] = () =>
      new Promise((resolve) => {
        approve = resolve;
      });
    const storage = memoryStorage({ [ROUTE_TOKEN]: SAVED_TOKEN });
    const client = new ClawtrateClient(
      { ...testHost(gateway, storage), readBack: async () => readBack() as never },
      { reconnect: { initialMs: 20, maxMs: 40 } },
    );
    await client.start();
    await client.connectRoute({ url: "ws://127.0.0.1:50001", route: ROUTE, identity: "gateway-1" });
    await until(() => client.state.connection.status === "connected");
    await client.requestAccess();
    await until(() => client.state.connection.upgrade.status === "pending");
    return {
      gateway,
      storage,
      client,
      setIdentity: (next: string) => (identity = next),
      approve: () =>
        approve({
          status: "approved",
          requestId: REQ,
          deviceToken: "rotated",
          scopes: INTERACTIVE,
        }),
    };
  }

  const exactRead = () => ({
    ok: true,
    identity: { deviceId: "gateway-1", publicKey: "key" },
    list: {
      pending: [],
      paired: [
        {
          deviceId: "device-1",
          publicKey: "public-key",
          clientId: "gateway-client",
          clientMode: "ui",
          role: "operator",
          scopes: INTERACTIVE,
          tokens: [{ role: "operator", scopes: INTERACTIVE }],
        },
      ],
    },
  });

  it("the forward dropping while the approval is confirmed ends it: unconfirmed, nothing kept", async () => {
    let release: (value: unknown) => void = () => {};
    const t = await routed(() => new Promise((resolve) => (release = resolve)));
    t.approve();
    await until(() => t.client.state.connection.upgrade.status === "confirming");
    t.client.holdRoute(ROUTE);
    expect(t.client.state.connection.upgrade.status).toBe("unconfirmed");
    expect(t.client.suspended).toBe(true);
    release(exactRead());
    // The forward comes back on a new channel: the route stays as it was left.
    await t.client.connectRoute({
      url: "ws://127.0.0.1:50002",
      route: ROUTE,
      identity: "gateway-1",
    });
    await sleep(80);
    expect(t.client.state.connection.status).toBe("error");
    expect(t.storage.data.get(ROUTE_TOKEN)).toBe(SAVED_TOKEN);
    t.client.stop();
  });

  it("a forward that comes back before the kept disconnect is saved opens nothing", async () => {
    const t = await routed(() => ({ ok: false, step: "identity", exitCode: null }));
    const sockets = () => t.gateway.sockets.length;
    // The suspension's own write is held open while the forward comes back.
    const release = deferred<void>();
    const set = t.storage.set;
    t.storage.set = async (key, value) => {
      if (key === "connection" && value.includes('"suspended":true')) await release.promise;
      await set(key, value);
    };
    t.approve();
    await until(() => t.client.state.connection.upgrade.status === "identity-unread");
    const before = sockets();
    const back = t.client.connectRoute({
      url: "ws://127.0.0.1:50002",
      route: ROUTE,
      identity: "gateway-1",
    });
    await sleep(80);
    expect(JSON.parse(t.storage.data.get("connection")!).suspended).toBeUndefined();
    expect(sockets()).toBe(before);
    release.resolve();
    await back;
    await until(() => JSON.parse(t.storage.data.get("connection")!).suspended === true);
    await sleep(80);
    expect(sockets()).toBe(before);
    expect(t.client.state.connection.status).toBe("error");
    t.client.stop();
  });

  it("a confirming reconnect through the route that reaches another gateway has §9's words", async () => {
    const t = await routed(exactRead);
    t.gateway.connectReply = (params) => {
      const { scopes, auth } = params as { scopes: string[]; auth?: { deviceToken?: string } };
      if (auth?.deviceToken === "rotated") t.setIdentity("gateway-2");
      return { ok: true, payload: helloOk(scopes, auth?.deviceToken ?? "token-1") };
    };
    t.approve();
    await until(() => t.client.state.connection.status === "error");
    expect(t.client.state.connection.error).toMatchObject({
      code: "APPROVAL_IDENTITY_CHANGED",
      message: "This route now leads to a different gateway.",
    });
    expect(t.storage.data.get(ROUTE_TOKEN)).toBe(SAVED_TOKEN);
    t.client.stop();
  });

  it("confirmed through the route, the token is kept for the route and the route stays verified", async () => {
    const t = await routed(exactRead);
    t.approve();
    await until(() => t.client.state.connection.canWrite);
    expect(JSON.parse(t.storage.data.get(ROUTE_TOKEN)!).token).toBe("rotated");
    expect(t.client.state.connection.gatewayId).toBe("gateway-1");
    t.client.stop();
  });
});

describe("F-500: a route on a host with no read-back", () => {
  it("keeps no approval: the route needs one, whatever the host can do", async () => {
    const { gateway, storage, client } = setup();
    storage.data.set(ROUTE_TOKEN, SAVED_TOKEN);
    gateway.connectReply = (params) => {
      const { scopes, auth } = params as { scopes: string[]; auth?: { deviceToken?: string } };
      return { ok: true, payload: helloOk(scopes, auth?.deviceToken ?? "token-1") };
    };
    gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-1" });
    gateway.handlers["device.scopes.waitUpgrade"] = () => ({
      status: "approved",
      requestId: "up-1",
      deviceToken: "rotated",
      scopes: ["operator.read", "operator.write", "operator.approvals", "operator.questions"],
    });
    await client.start();
    await client.connectRoute({ url: "ws://127.0.0.1:50001", route: ROUTE });
    await until(() => client.state.connection.status === "connected");
    await client.requestAccess();
    await until(() => client.state.connection.upgrade.status === "identity-unread");
    expect(JSON.parse(storage.data.get(ROUTE_TOKEN)!).token).toBe("token-1");
    client.stop();
  });
});

describe("F-500: a route's first pairing whose forward drops during the read-back", () => {
  it("is refused as a first pairing: no selection is saved, suspended or otherwise", async () => {
    const gateway = new FakeGateway();
    let approved = false;
    gateway.connectReply = () =>
      approved
        ? { ok: true, payload: helloOk(["operator.read"], "first-token") }
        : {
            ok: false,
            error: {
              code: "NOT_PAIRED",
              message: "pairing required",
              details: {
                code: "PAIRING_REQUIRED",
                requestId: "e5eb4aa8-175f-40f1-bc7a-8f15cfc40942",
                deviceId: "device-1",
              },
            },
          };
    gateway.handlers["gateway.identity.get"] = () => ({ deviceId: "gateway-1", publicKey: "key" });
    const reading = deferred<ReadBack>();
    let asked = 0;
    const storage = memoryStorage();
    const client = new ClawtrateClient(
      {
        ...testHost(gateway, storage),
        readBack: async () => {
          asked += 1;
          return reading.promise;
        },
      },
      { reconnect: { initialMs: 20, maxMs: 40 } },
    );
    await client.start();
    await client.connectRoute({
      url: "ws://127.0.0.1:50001",
      route: ROUTE,
      code: { bootstrapToken: "b".repeat(43), expiresAtMs: Date.now() + 60_000 },
    });
    await until(() => client.state.connection.status === "pairing");
    approved = true;
    await client.retryNow();
    await until(() => asked === 1);
    // The forward goes down while the host reads back.
    client.holdRoute(ROUTE);
    await until(() => client.state.connection.status === "error");
    expect(client.state.connection.error?.code).toBe("APPROVAL_UNCONFIRMED");
    await sleep(50);
    expect(storage.data.has("connection")).toBe(false);
    expect(storage.data.has(ROUTE_TOKEN)).toBe(false);
    expect(client.suspended).toBe(false);
    client.stop();
  });
});
