import { describe, expect, it } from "vitest";
import { createBridgeSession } from "../src/bridge.ts";
import { ClawtrateClient, MAX_SESSION_PAGES, REQUESTED_SCOPES } from "../src/client.ts";
import {
  FakeGateway,
  GatewayError,
  helloOk,
  memoryStorage,
  testHost,
  sleep,
  tokenKey,
  until,
} from "./fake-gateway.ts";

const URL_A = "ws://127.0.0.1:19001";
const URL_B = "wss://gateway.example.com";
const FAST = { reconnect: { initialMs: 20, maxMs: 40 } };

function connectParams(gateway: FakeGateway, index = 0) {
  return gateway.connects[index] as {
    scopes: string[];
    auth?: { token?: string; deviceToken?: string };
  };
}

async function connected(gateway = new FakeGateway(), storage = memoryStorage()) {
  const client = new ClawtrateClient(testHost(gateway, storage), FAST);
  await client.start();
  await client.connect({ url: URL_A, token: "bootstrap" });
  await until(() => client.state.discovery.status === "ready");
  return { client, gateway, storage };
}

describe("requested scopes (B1)", () => {
  it("requests exactly operator.read on first pairing", async () => {
    const { gateway } = await connected();
    expect(connectParams(gateway).scopes).toEqual([...REQUESTED_SCOPES]);
    expect(connectParams(gateway).auth?.token).toBe("bootstrap");
  });

  it("requests exactly operator.read when a stored token was granted more", async () => {
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: null }),
      [tokenKey(URL_A)]: JSON.stringify({
        token: "synthetic-token",
        scopes: ["operator.read", "operator.write", "operator.admin"],
      }),
    });
    const gateway = new FakeGateway();
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await until(() => gateway.connects.length > 0);
    const params = connectParams(gateway);
    expect(params.scopes).toEqual(["operator.read"]);
    expect(params.auth?.token ?? params.auth?.deviceToken).toBe("synthetic-token");
    client.stop();
  });

  it("keeps the grant separate from what it requests after pairing", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: true,
      payload: helloOk(["operator.read", "operator.write"], "issued-token"),
    });
    const { client, storage } = await connected(gateway);
    expect(JSON.parse(storage.data.get(tokenKey(URL_A))!)).toEqual({
      token: "issued-token",
      // A grant wider than the request is stored as the request: the client holds read only.
      grantedScopes: ["operator.read"],
      heldScopes: ["operator.read"],
    });
    gateway.dropAll();
    await until(() => gateway.connects.length === 2);
    expect(connectParams(gateway, 1).scopes).toEqual(["operator.read"]);
    client.stop();
  });
});

describe("allowed gateways (A1)", () => {
  it("does not resume a saved gateway the host does not allow", async () => {
    const storage = memoryStorage({ connection: JSON.stringify({ url: URL_B, token: null }) });
    const gateway = new FakeGateway();
    const client = new ClawtrateClient(testHost(gateway, storage), {
      ...FAST,
      allowGatewayUrl: (url) => url === URL_A,
    });
    await client.start();
    await client.retryNow();
    await sleep(60);
    expect(gateway.sockets).toHaveLength(0);
    expect(client.state.connection.status).toBe("error");
    expect(client.state.connection.error?.code).toBe("GATEWAY_NOT_ALLOWED");
    await expect(client.connect({ url: URL_B })).rejects.toThrow(/not allowed/);
    expect(gateway.sockets).toHaveLength(0);
  });
});

describe("allowed gateways on every reconnect (A2)", () => {
  it("checks before every automatic retry and stops retrying once a gateway is refused", async () => {
    const gateway = new FakeGateway();
    let allowed = true;
    let checks = 0;
    const client = new ClawtrateClient(testHost(gateway, memoryStorage()), {
      ...FAST,
      allowGatewayUrl: (url) => {
        checks += 1;
        return allowed && url === URL_A;
      },
    });
    await client.start();
    await client.connect({ url: URL_A, token: "bootstrap" });
    await until(() => client.state.discovery.status === "ready");
    expect(gateway.sockets).toHaveLength(1);
    // The proof is lost, then the connection drops: the protocol's own retry
    // must ask again and open nothing.
    allowed = false;
    const before = checks;
    gateway.dropAll();
    await until(() => client.state.connection.error?.code === "GATEWAY_NOT_ALLOWED");
    await sleep(150);
    expect(checks).toBeGreaterThan(before);
    expect(gateway.sockets).toHaveLength(1);
    expect(client.state.connection.status).toBe("error");
    expect(client.state.connection.retryAt).toBeNull();
    client.stop();
  });
});

describe("pairing instructions (A3)", () => {
  function pairingGateway() {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: false,
      error: {
        code: "NOT_PAIRED",
        message: "pairing required",
        details: { code: "PAIRING_REQUIRED", requestId: "req-123", deviceId: "device-1" },
      },
    });
    return gateway;
  }

  it("uses the host's instructions", async () => {
    const gateway = pairingGateway();
    const client = new ClawtrateClient(
      {
        ...testHost(gateway),
        approvalInstructions: () => ({ command: "pnpm dev-gateway approve", note: null }),
      },
      FAST,
    );
    await client.connect({ url: URL_A, token: "t" });
    await until(() => client.state.connection.status === "pairing");
    expect(client.state.connection.pairing).toMatchObject({
      requestId: "req-123",
      approveCommand: "pnpm dev-gateway approve",
      approveNote: null,
    });
    client.stop();
  });

  it("falls back to the gateway owner's command with a note, and lists pending devices for an id of another shape", async () => {
    const gateway = pairingGateway();
    const client = new ClawtrateClient(testHost(gateway), FAST);
    await client.connect({ url: URL_B, token: "t" });
    await until(() => client.state.connection.status === "pairing");
    // Only a request id of the gateway's UUID shape is put in a command (setup §9).
    expect(client.state.connection.pairing).toMatchObject({
      approveCommand: "openclaw devices list",
      approveTitle: "Waiting for approval.",
    });
    expect(client.state.connection.pairing?.approveNote).toMatch(/gateway's computer/);
    client.stop();
  });

  it("names the request id in the address route's command when it has the gateway's shape", async () => {
    const id = "e5eb4aa8-175f-40f1-bc7a-8f15cfc40942";
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: false,
      error: {
        code: "NOT_PAIRED",
        message: "pairing required",
        details: { code: "PAIRING_REQUIRED", requestId: id, deviceId: "device-1" },
      },
    });
    const client = new ClawtrateClient(testHost(gateway), FAST);
    await client.connect({ url: URL_B, token: "t" });
    await until(() => client.state.connection.status === "pairing");
    expect(client.state.connection.pairing).toMatchObject({
      approveCommand: `openclaw devices approve ${id}`,
      approveNote:
        "Run this on the gateway's computer, with `--profile <name>` if the gateway doesn't use the default profile:",
    });
    client.stop();
  });
});

describe("shared transcripts (B2)", () => {
  it("keeps a task open while another viewer still shows it, and releases closed viewers", async () => {
    const { client, gateway } = await connected();
    const key = "agent:main:task";
    const first = createBridgeSession(client);
    const second = createBridgeSession(client);
    await first.apply({ type: "openSession", key });
    await first.apply({ type: "openSession", key }); // repeated opens are idempotent per viewer
    await second.apply({ type: "openSession", key });
    expect(client.sessionInterest(key)).toBe(2);

    await first.apply({ type: "closeSession", key });
    expect(gateway.calls("sessions.messages.unsubscribe")).toEqual([]);
    expect(client.state.transcripts[key]).toBeDefined();

    second.dispose(); // the second tab closes without sending closeSession
    expect(client.sessionInterest(key)).toBe(0);
    expect(gateway.calls("sessions.messages.unsubscribe")).toEqual([{ key }]);
    expect(client.state.transcripts[key]).toBeUndefined();
    client.stop();
  });
});

describe("discovery failures (B3)", () => {
  it("reports a failed read, keeps the other result and recovers on retry", async () => {
    const gateway = new FakeGateway();
    let fail = true;
    gateway.handlers["agents.list"] = () => {
      if (fail) throw new GatewayError({ code: "UNAVAILABLE", message: "synthetic list failure" });
      return { defaultId: "main", agents: [{ id: "main", identity: { name: "Juniper" } }] };
    };
    gateway.handlers["sessions.subscribe"] = () => ({
      subscribed: true,
      list: { sessions: [{ key: "agent:main:a", agentId: "main", label: "A" }], hasMore: false },
    });
    const client = new ClawtrateClient(testHost(gateway), FAST);
    await client.connect({ url: URL_A, token: "t" });
    await until(() => client.state.discovery.status === "error");
    expect(client.state.connection.status).toBe("connected");
    expect(client.state.discovery.error).toMatch(/synthetic list failure/);
    expect(client.state.tasksByBot.main?.map((task) => task.title)).toEqual(["A"]);

    fail = false;
    await client.retryNow();
    await until(() => client.state.discovery.status === "ready");
    expect(client.state.bots.map((bot) => bot.name)).toEqual(["Juniper"]);
    expect(client.state.discovery.error).toBeNull();
    client.stop();
  });
});

describe("live session membership (B4)", () => {
  it("does not insert cron or subagent sessions from events", async () => {
    const { client, gateway } = await connected();
    const listCalls = gateway.calls("sessions.list").length;
    for (const key of ["agent:main:cron:nightly", "agent:main:subagent:helper", "subagent:x"]) {
      gateway.emit("sessions.changed", {
        sessionKey: key,
        agentId: "main",
        session: { label: "Should be excluded" },
      });
    }
    await sleep(350);
    expect(client.state.tasksByBot.main ?? []).toEqual([]);
    expect(gateway.calls("sessions.list")).toHaveLength(listCalls);
    client.stop();
  });

  it("re-reads the filtered list for an unknown session instead of inserting it", async () => {
    const gateway = new FakeGateway();
    const { client } = await connected(gateway);
    gateway.handlers["sessions.list"] = () => ({ sessions: [], hasMore: false }); // filtered out
    gateway.emit("sessions.changed", {
      sessionKey: "agent:main:spawned",
      agentId: "main",
      session: { label: "Spawned helper" },
    });
    await until(() => gateway.calls("sessions.list").length > 0);
    await sleep(20);
    expect(client.state.tasksByBot.main ?? []).toEqual([]);
    client.stop();
  });

  it("drops a known session that becomes archived or spawned, and on delete", async () => {
    const gateway = new FakeGateway();
    gateway.handlers["sessions.subscribe"] = () => ({
      subscribed: true,
      list: {
        sessions: [
          { key: "agent:main:a", agentId: "main", label: "A" },
          { key: "agent:main:b", agentId: "main", label: "B" },
          { key: "agent:main:c", agentId: "main", label: "C" },
        ],
        hasMore: false,
      },
    });
    const { client } = await connected(gateway);
    gateway.emit("sessions.changed", { sessionKey: "agent:main:a", session: { archived: true } });
    gateway.emit("sessions.changed", { sessionKey: "agent:main:b", session: { spawnedBy: "x" } });
    gateway.emit("sessions.changed", { sessionKey: "agent:main:c", reason: "delete" });
    await until(() => (client.state.tasksByBot.main ?? []).length === 0);
    client.stop();
  });
});

describe("task pagination (B5)", () => {
  function pagedGateway(total: number) {
    const rows = Array.from({ length: total }, (_, i) => ({
      key: `agent:${i % 10 === 0 ? "quiet" : "busy"}:t${i}`,
      agentId: i % 10 === 0 ? "quiet" : "busy",
      label: `Task ${i}`,
      updatedAt: total - i,
    }));
    const page = (offset: number) => {
      const sessions = rows.slice(offset, offset + 200);
      const more = offset + 200 < rows.length;
      return { sessions, hasMore: more, nextOffset: more ? offset + 200 : null, totalCount: total };
    };
    const gateway = new FakeGateway();
    gateway.handlers["sessions.subscribe"] = () => ({ subscribed: true, list: page(0) });
    gateway.handlers["sessions.list"] = (params) =>
      page((params as { offset?: number }).offset ?? 0);
    return gateway;
  }

  it("loads every page, across bots, beyond the first 200", async () => {
    const gateway = pagedGateway(450);
    const { client } = await connected(gateway);
    expect(gateway.calls("sessions.list").map((p) => (p as { offset: number }).offset)).toEqual([
      200, 400,
    ]);
    expect(client.state.tasksByBot.quiet).toHaveLength(45);
    expect(client.state.tasksByBot.busy).toHaveLength(405);
    expect(client.state.discovery.partial).toBe(false);
    client.stop();
  });

  it("says so when it stops at the page ceiling", async () => {
    const gateway = pagedGateway(200 * (MAX_SESSION_PAGES + 1));
    const { client } = await connected(gateway);
    expect(client.state.discovery.partial).toBe(true);
    client.stop();
  });
});

describe("reconnecting (C2)", () => {
  it("stays reconnecting through failed attempts and keeps the data", async () => {
    const { client, gateway } = await connected();
    expect(client.state.bots).toHaveLength(1);
    gateway.refuseConnections = true;
    gateway.dropAll();
    await until(() => client.state.connection.status === "reconnecting");
    const seen = new Set<string>();
    const stop = client.store.subscribe((state) => seen.add(state.connection.status));
    await until(() => gateway.sockets.length >= 4);
    expect([...seen]).toEqual(["reconnecting"]);
    expect(client.state.bots).toHaveLength(1);

    await client.retryNow();
    expect(client.state.connection.status).toBe("reconnecting");
    expect(client.state.bots).toHaveLength(1);

    gateway.refuseConnections = false;
    await until(() => client.state.connection.status === "connected");
    stop();
    client.stop();
  });
});

describe("knowing what is in sync after a reconnect", () => {
  it("stamps each connect and each successful history load, so a kept transcript is not taken as fresh", async () => {
    const { client, gateway } = await connected();
    const key = "agent:main:task";
    client.openSession(key);
    await until(() => client.state.transcripts[key]?.status === "ready");
    const firstLoad = client.state.transcripts[key]!.loadedAt!;
    expect(firstLoad).toBeGreaterThanOrEqual(client.state.connection.connectedAt!);

    // The next reload fails: the kept transcript keeps its old load time.
    let fail = true;
    gateway.handlers["chat.history"] = () => {
      if (fail) throw new GatewayError({ code: "UNAVAILABLE", message: "history failed" });
      return { messages: [], hasMore: false };
    };
    await sleep(5);
    gateway.dropAll();
    await until(() => client.state.connection.status === "reconnecting");
    await until(() => client.state.transcripts[key]?.status === "error");
    const reconnectedAt = client.state.connection.connectedAt!;
    expect(reconnectedAt).toBeGreaterThan(firstLoad);
    expect(client.state.transcripts[key]!.loadedAt).toBe(firstLoad);

    // A reload that succeeds is stamped after the connect.
    fail = false;
    gateway.dropAll();
    await until(
      () =>
        client.state.connection.status === "connected" &&
        client.state.transcripts[key]?.status === "ready",
    );
    expect(client.state.transcripts[key]!.loadedAt!).toBeGreaterThanOrEqual(
      client.state.connection.connectedAt!,
    );
    client.stop();
  });
});
