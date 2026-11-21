// After the gateway's owner approves a request (docs/design/setup.md §9): the
// rotated or first token is staged in memory, the host reads back what the
// gateway granted where it has a shell, and a reconnect with the staged token
// must show the same gateway, the operator role and exactly the asked scopes
// before anything is saved. Each mismatch disconnects, saves no new token and
// asks nothing of the gateway that would change it.

import { describe, expect, it } from "vitest";
import { APPROVAL_WORDS, type ReadBack } from "../src/approval.ts";
import { createBridgeSession } from "../src/bridge.ts";
import { ClawtrateClient } from "../src/client.ts";
import type { ApprovalInstructions } from "../src/host.ts";
import { INTERACTIVE_SCOPES, READ_SCOPES } from "../src/scopes.ts";
import { FAST, URL_A, URL_B } from "./client-harness.ts";
import {
  deferred,
  FakeGateway,
  GatewayError,
  helloOk,
  memoryStorage,
  sleep,
  testHost,
  tokenKey,
  until,
} from "./fake-gateway.ts";

const GATEWAY = "gw-identity-1";
const REQUEST = "0d0d0d0d-0000-4000-8000-000000000001";
const OTHER_REQUEST = "0d0d0d0d-0000-4000-8000-000000000002";

type ConnectParams = { scopes: string[]; auth?: { deviceToken?: string; token?: string } };

/** This device's paired record, as `device.pair.list` reports it on 2026.10.6. */
function paired(scopes: readonly string[], overrides: Record<string, unknown> = {}) {
  return {
    deviceId: "device-1",
    publicKey: "public-key",
    displayName: "Clawtrate Test",
    clientId: "gateway-client",
    clientMode: "ui",
    role: "operator",
    roles: ["operator"],
    scopes: [...scopes].reverse(),
    approvedVia: "owner",
    tokens: [{ role: "operator", scopes: [...scopes], createdAtMs: 1 }],
    ...overrides,
  };
}

function pendingEntry(requestId: string, scopes: readonly string[], overrides = {}) {
  return {
    requestId,
    deviceId: "device-1",
    publicKey: "public-key",
    clientId: "gateway-client",
    clientMode: "ui",
    role: "operator",
    roles: ["operator"],
    scopes: [...scopes],
    isRepair: true,
    ...overrides,
  };
}

const identity = (deviceId = GATEWAY) => ({ deviceId, publicKey: "gateway-key" });
const listed = (pending: unknown[], pairedList: unknown[]) => ({ pending, paired: pairedList });
const exact = (scopes: readonly string[] = INTERACTIVE_SCOPES): ReadBack => ({
  ok: true,
  identity: identity(),
  list: listed([], [paired(scopes)]),
});

const NEVER_SENT = [
  "device.pair.approve",
  "device.pair.reject",
  "device.pair.remove",
  "device.token.revoke",
  "device.token.rotate",
];

/**
 * A read-only client, paired for read, with a gateway that grants what a
 * connect asks for and answers its identity; the host's read-back answers
 * `readBack()` and records what storage held when it was asked.
 */
async function setUp(
  options: {
    readBack?: (() => ReadBack | null | Promise<ReadBack | null>) | null;
    identity?: () => string;
    instructions?: ApprovalInstructions;
    /** The saved connection: by default one saved before its place was kept (a loopback address). */
    connection?: Record<string, unknown>;
    checkMs?: number;
  } = {},
) {
  const gateway = new FakeGateway();
  gateway.connectReply = (params) => {
    const { scopes, auth } = params as ConnectParams;
    return { ok: true, payload: helloOk(scopes, auth?.deviceToken ?? "device-token") };
  };
  gateway.handlers["gateway.identity.get"] = () => identity(options.identity?.() ?? GATEWAY);
  gateway.handlers["question.list"] = () => ({ questions: [] });
  for (const method of ["exec.approval.list", "plugin.approval.list", "openclaw.approval.list"])
    gateway.handlers[method] = () => [];
  const wait = deferred<unknown>();
  gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: REQUEST });
  gateway.handlers["device.scopes.waitUpgrade"] = () => wait.promise;
  const saved = JSON.stringify({
    token: "read-token",
    grantedScopes: READ_SCOPES,
    heldScopes: READ_SCOPES,
  });
  const storage = memoryStorage({
    connection: JSON.stringify(options.connection ?? { url: URL_A, token: null }),
    [tokenKey(URL_A)]: saved,
  });
  const reads: Array<{ url: string; stored: string | undefined; asked?: unknown }> = [];
  const host = {
    ...testHost(gateway, storage),
    approvalInstructions: () =>
      options.instructions ?? {
        command: `openclaw devices approve ${REQUEST}`,
        note: "On you@devbox.example (SSH port 22), run this for the default profile:",
        title: "Waiting for approval on devbox.",
        where: "devbox",
      },
    ...(options.readBack === null
      ? {}
      : {
          readBack: async (url: string, asked: unknown) => {
            reads.push({ url, stored: storage.data.get(tokenKey(URL_A)), asked });
            return (options.readBack ?? (() => exact()))();
          },
        }),
  };
  const client = new ClawtrateClient(host, {
    ...FAST,
    ...(options.checkMs ? { approvalCheckMs: options.checkMs } : {}),
  });
  await client.start();
  await until(() => client.state.connection.status === "connected");
  await until(() => client.state.connection.gatewayId === GATEWAY);
  const approve = (scopes: readonly string[] = INTERACTIVE_SCOPES, token = "rotated-token") =>
    wait.resolve({
      status: "approved",
      requestId: REQUEST,
      deviceToken: token,
      scopes: [...scopes],
    });
  const connectsWith = (token: string) =>
    gateway.connects.filter((c) => (c as ConnectParams).auth?.deviceToken === token);
  const changedGateway = () =>
    gateway.requests.filter((request) => NEVER_SENT.includes(request.method));
  return { gateway, storage, client, saved, reads, approve, connectsWith, changedGateway, wait };
}

async function waiting(client: ClawtrateClient) {
  await client.requestAccess();
  await until(() => client.state.connection.upgrade.status === "pending");
}

describe("F-500: a scope upgrade is kept only once its read-back and reconnect confirm it", () => {
  it("stages the rotated token, reads back, reconnects with exactly the asked scopes, then saves it", async () => {
    const t = await setUp();
    await waiting(t.client);
    expect(t.client.state.connection.upgrade).toMatchObject({
      approveTitle: "Waiting for approval on devbox.",
      approveCommand: `openclaw devices approve ${REQUEST}`,
    });
    t.approve();
    await until(() => t.client.state.connection.canWrite);
    // The read-back ran before anything was saved, against this gateway's address and the
    // identity established before the approval.
    expect(t.reads).toEqual([
      { url: URL_A, stored: t.saved, asked: { expected: GATEWAY, here: null } },
    ]);
    // The reconnect used the staged token and asked for exactly the interactive set.
    const reconnect = t.connectsWith("rotated-token");
    expect(reconnect).toHaveLength(1);
    expect(new Set((reconnect[0] as ConnectParams).scopes)).toEqual(new Set(INTERACTIVE_SCOPES));
    const stored = JSON.parse(t.storage.data.get(tokenKey(URL_A))!);
    expect(stored.token).toBe("rotated-token");
    expect(new Set(stored.heldScopes)).toEqual(new Set(INTERACTIVE_SCOPES));
    expect(t.client.state.connection.upgrade.status).toBe("approved");
    expect(t.changedGateway()).toEqual([]);
    t.client.stop();
  });

  it("saves nothing until the reconnect's hello, even while the read-back waits", async () => {
    const hold = deferred<ReadBack>();
    const t = await setUp({ readBack: () => hold.promise });
    await waiting(t.client);
    t.approve();
    await until(() => t.client.state.connection.upgrade.status === "confirming");
    await sleep(30);
    expect(t.storage.data.get(tokenKey(URL_A))).toBe(t.saved);
    expect(t.connectsWith("rotated-token")).toEqual([]);
    // When the staged token's reconnect reaches the gateway, before its hello, still nothing.
    const atConnect: Array<string | undefined> = [];
    const reply = t.gateway.connectReply;
    t.gateway.connectReply = (params, url) => {
      if ((params as ConnectParams).auth?.deviceToken === "rotated-token")
        atConnect.push(t.storage.data.get(tokenKey(URL_A)));
      return reply(params, url);
    };
    hold.resolve(exact());
    await until(() => t.client.state.connection.canWrite);
    expect(atConnect).toEqual([t.saved]);
    expect(JSON.parse(t.storage.data.get(tokenKey(URL_A))!).token).toBe("rotated-token");
    t.client.stop();
  });

  const unconfirmedText = `${APPROVAL_WORDS.unconfirmed.title} ${APPROVAL_WORDS.unconfirmed.detail}`;

  /** The approval came to `status`: disconnected, the saved token as it was, the rotated one never used. */
  async function refused(t: Awaited<ReturnType<typeof setUp>>, status: string, words: string) {
    await until(() => t.client.state.connection.status === "error");
    expect(t.client.state.connection.upgrade.status).toBe(status);
    expect(t.client.state.connection.error).toMatchObject({ message: words });
    expect(t.client.state.connection.canWrite).toBe(false);
    expect(t.storage.data.get(tokenKey(URL_A))).toBe(t.saved);
    expect(JSON.stringify(t.client.state)).not.toContain("rotated-token");
    expect(t.changedGateway()).toEqual([]);
    // Kept disconnected, as by Disconnect: nothing reopens it until the person reconnects.
    await until(() => JSON.parse(t.storage.data.get("connection")!).suspended === true);
    await sleep(100);
    expect(t.client.state.connection.status).toBe("error");
    t.client.stop();
  }

  it("a wider grant than asked disconnects before any reconnect and saves no token", async () => {
    const t = await setUp();
    await waiting(t.client);
    t.approve([...INTERACTIVE_SCOPES, "operator.admin"]);
    await refused(t, "unconfirmed", unconfirmedText);
    expect(t.connectsWith("rotated-token")).toEqual([]);
    expect(t.reads).toEqual([]);
  });

  it("a record wider than asked disconnects and saves no token", async () => {
    const t = await setUp({
      readBack: () => ({
        ok: true,
        identity: identity(),
        list: listed([], [paired([...INTERACTIVE_SCOPES, "operator.admin"])]),
      }),
    });
    await waiting(t.client);
    t.approve();
    await refused(t, "unconfirmed", unconfirmedText);
    expect(t.connectsWith("rotated-token")).toEqual([]);
  });

  it("a record that reports another client disconnects and saves no token", async () => {
    const t = await setUp({
      readBack: () => ({
        ok: true,
        identity: identity(),
        list: listed([], [paired(INTERACTIVE_SCOPES, { clientId: "openclaw-control-ui" })]),
      }),
    });
    await waiting(t.client);
    t.approve();
    await refused(t, "unconfirmed", unconfirmedText);
  });

  it("a record with another role beside the operator's disconnects and saves no token", async () => {
    const t = await setUp({
      readBack: () => ({
        ok: true,
        identity: identity(),
        list: listed([], [paired(INTERACTIVE_SCOPES, { roles: ["operator", "node"] })]),
      }),
    });
    await waiting(t.client);
    t.approve();
    await refused(t, "unconfirmed", unconfirmedText);
  });

  it("a different gateway at the endpoint says so, disconnects and saves no token", async () => {
    const t = await setUp({
      readBack: () => ({
        ok: true,
        identity: identity("gw-other"),
        list: listed([], [paired(INTERACTIVE_SCOPES)]),
      }),
    });
    await waiting(t.client);
    t.approve();
    await refused(t, "identity-changed", APPROVAL_WORDS.identityChanged);
  });

  it("an identity that couldn't be read says so and saves no token", async () => {
    const t = await setUp({ readBack: () => ({ ok: false, step: "identity", exitCode: 1 }) });
    await waiting(t.client);
    t.approve();
    await refused(t, "identity-unread", APPROVAL_WORDS.identityUnread);
  });

  it("a failed read-back of the list disconnects and saves no token", async () => {
    const t = await setUp({
      readBack: () => ({ ok: false, step: "list", exitCode: 2, identity: identity() }),
    });
    await waiting(t.client);
    t.approve();
    await refused(t, "unconfirmed", unconfirmedText);
  });

  it("a read-back that throws is an identity that couldn't be read", async () => {
    const t = await setUp({
      readBack: () => {
        throw new Error("ssh: connection closed");
      },
    });
    await waiting(t.client);
    t.approve();
    await refused(t, "identity-unread", APPROVAL_WORDS.identityUnread);
  });

  it("a list that couldn't be read beside another gateway's identity says it is another gateway", async () => {
    const t = await setUp({
      readBack: () => ({ ok: false, step: "list", exitCode: null, identity: identity("gw-x") }),
    });
    await waiting(t.client);
    t.approve();
    await refused(t, "identity-changed", APPROVAL_WORDS.identityChanged);
  });

  it("a reconnect granted other scopes than asked disconnects and saves no token", async () => {
    const t = await setUp();
    await waiting(t.client);
    t.gateway.connectReply = (params) => {
      const { scopes, auth } = params as ConnectParams;
      const granted =
        auth?.deviceToken === "rotated-token" ? [...scopes, "operator.admin"] : scopes;
      return { ok: true, payload: helloOk(granted) };
    };
    t.approve();
    await refused(t, "unconfirmed", unconfirmedText);
    expect(t.connectsWith("rotated-token")).toHaveLength(1);
  });

  it("a reconnect the gateway refuses disconnects and saves no token", async () => {
    const t = await setUp();
    await waiting(t.client);
    t.gateway.connectReply = () => ({
      ok: false,
      error: {
        code: "UNAUTHORIZED",
        message: "device token mismatch",
        details: { code: "AUTH_DEVICE_TOKEN_MISMATCH" },
      },
    });
    t.approve();
    await refused(t, "unconfirmed", unconfirmedText);
  });

  it("a reconnect that reaches a different gateway says so and saves no token", async () => {
    let id = GATEWAY;
    const t = await setUp({ identity: () => id });
    await waiting(t.client);
    t.gateway.connectReply = (params) => {
      const { scopes, auth } = params as ConnectParams;
      if (auth?.deviceToken === "rotated-token") id = "gw-other";
      return { ok: true, payload: helloOk(scopes) };
    };
    t.approve();
    await refused(t, "identity-changed", APPROVAL_WORDS.identityChanged);
  });

  for (const connection of [
    { url: URL_A, token: null },
    { url: URL_A, token: null, here: { profile: "default" } },
  ])
    it(`a host with no read-back keeps nothing for a connection that needs one (${Object.keys(connection).join(", ")})`, async () => {
      const t = await setUp({ readBack: null, connection });
      await waiting(t.client);
      expect(t.client.state.connection.upgrade.place).toBe("here");
      t.approve();
      await refused(t, "identity-unread", APPROVAL_WORDS.identityUnread);
    });

  it("a host with no read-back still lets a marked address's hello decide", async () => {
    const t = await setUp({
      readBack: null,
      connection: { url: URL_A, token: null, address: true },
    });
    await waiting(t.client);
    t.approve();
    await until(() => t.client.state.connection.canWrite);
    expect(JSON.parse(t.storage.data.get(tokenKey(URL_A))!).token).toBe("rotated-token");
    t.client.stop();
  });

  it("an adapter that answers null for a connection that needs a read keeps nothing", async () => {
    const t = await setUp({ readBack: () => null });
    await waiting(t.client);
    t.approve();
    await refused(t, "identity-unread", APPROVAL_WORDS.identityUnread);
  });

  it("an explicit address route is never read back: the hello decides, against the same gateway", async () => {
    const t = await setUp({
      readBack: () => null,
      connection: { url: URL_A, token: null, address: true },
    });
    await waiting(t.client);
    expect(t.client.state.connection.upgrade.place).toBe("address");
    t.approve();
    await until(() => t.client.state.connection.canWrite);
    expect(t.reads).toEqual([]);
    t.client.stop();
  });

  it("an explicit address route that reaches another gateway on reconnect saves no token", async () => {
    let id = GATEWAY;
    const t = await setUp({
      identity: () => id,
      connection: { url: URL_A, token: null, address: true },
    });
    await waiting(t.client);
    t.gateway.connectReply = (params) => {
      const { scopes, auth } = params as ConnectParams;
      if (auth?.deviceToken === "rotated-token") id = "gw-other";
      return { ok: true, payload: helloOk(scopes) };
    };
    t.approve();
    await refused(t, "identity-changed", APPROVAL_WORDS.identityChanged);
  });

  it("a connection found on this computer whose host can't read back there keeps nothing", async () => {
    const t = await setUp({
      readBack: () => null,
      connection: { url: URL_A, token: null, here: { profile: "clawtrate" } },
    });
    await waiting(t.client);
    t.approve();
    await refused(t, "identity-unread", APPROVAL_WORDS.identityUnread);
    // The kept profile was handed to the host, which had no proof to read with.
    expect(t.reads[0]?.asked).toEqual({ expected: GATEWAY, here: { profile: "clawtrate" } });
  });

  it("a loopback connection saved before its place was kept is read back, and keeps nothing without it", async () => {
    const t = await setUp({ readBack: () => null });
    await waiting(t.client);
    t.approve();
    await refused(t, "identity-unread", APPROVAL_WORDS.identityUnread);
  });

  it("an upgrade with no gateway identity established before it keeps nothing", async () => {
    const t = await setUp();
    await waiting(t.client);
    // As if the identity read on this connection had given nothing.
    t.client.store.update((state) => ({
      ...state,
      connection: { ...state.connection, gatewayId: null },
    }));
    (t.client as unknown as { gatewayIdentity: unknown }).gatewayIdentity = null;
    t.approve();
    await refused(t, "identity-unread", APPROVAL_WORDS.identityUnread);
    expect(t.reads).toEqual([]);
  });
});

describe("F-500: an SSH drop while waiting, or after the person ran the command", () => {
  it("after the command ran, the old token is refused: unconfirmed, no new token, nothing removed", async () => {
    const t = await setUp();
    await waiting(t.client);
    // The person approves while the route is down: the gateway rotates the token, so the
    // old one is refused on every reconnect (as OpenClaw 2026.10.6 does).
    t.gateway.connectReply = () => ({
      ok: false,
      error: {
        code: "UNAUTHORIZED",
        message: "unauthorized: device token mismatch (rotate/reissue device token)",
        details: { code: "AUTH_DEVICE_TOKEN_MISMATCH" },
      },
    });
    t.gateway.dropAll();
    await until(() => t.client.state.connection.status === "error");
    expect(t.client.state.connection.upgrade.status).toBe("unconfirmed");
    expect(t.client.state.connection.error?.message).toBe(
      `${APPROVAL_WORDS.unconfirmed.title} ${APPROVAL_WORDS.unconfirmed.detail}`,
    );
    expect(t.changedGateway()).toEqual([]);
    // This device's earlier token is left as it was: nothing is forgotten for this outcome.
    expect(t.storage.data.get(tokenKey(URL_A))).toBe(t.saved);
    // Kept disconnected as any unconfirmed approval: at once, and across a restart.
    expect(t.client.suspended).toBe(true);
    await until(() => JSON.parse(t.storage.data.get("connection")!).suspended === true);
    t.client.stop();
  });

  it("a confirming reconnect refused for another protocol version says identity or version, and keeps nothing", async () => {
    const t = await setUp();
    await waiting(t.client);
    t.gateway.connectReply = (params) => {
      const { scopes, auth } = params as ConnectParams;
      if (auth?.deviceToken === "rotated-token")
        return {
          ok: false,
          error: {
            code: "INVALID_REQUEST",
            message: "protocol mismatch",
            details: { code: "PROTOCOL_MISMATCH", expectedProtocol: 5 },
          },
        };
      return { ok: true, payload: helloOk(scopes) };
    };
    t.approve();
    await until(() => t.client.state.connection.status === "error");
    expect(t.client.state.connection.upgrade.status).toBe("identity-unread");
    expect(t.client.state.connection.error?.message).toBe(APPROVAL_WORDS.identityUnread);
    expect(t.storage.data.get(tokenKey(URL_A))).toBe(t.saved);
    expect(t.connectsWith("rotated-token")).toHaveLength(1);
    t.client.stop();
  });

  it("before the command ran, it waits on the same request again, and an approval then is shown as found", async () => {
    const t = await setUp();
    await waiting(t.client);
    const second = deferred<unknown>();
    t.gateway.handlers["device.scopes.waitUpgrade"] = () => second.promise;
    t.gateway.dropAll();
    await until(() => t.client.state.connection.status !== "connected");
    await until(() => t.client.state.connection.status === "connected");
    await until(() => t.gateway.calls("device.scopes.waitUpgrade").length === 2);
    // The same request, by its id: never a second request for the person to approve.
    expect(t.gateway.calls("device.scopes.requestUpgrade")).toHaveLength(1);
    expect(t.gateway.calls("device.scopes.waitUpgrade")[1]).toEqual({ requestId: REQUEST });
    expect(t.client.state.connection.upgrade).toMatchObject({
      status: "pending",
      requestId: REQUEST,
      approveCommand: `openclaw devices approve ${REQUEST}`,
    });
    second.resolve({
      status: "approved",
      requestId: REQUEST,
      deviceToken: "rotated-token",
      scopes: [...INTERACTIVE_SCOPES],
    });
    await until(() => t.client.state.connection.canWrite);
    expect(t.client.state.connection.upgrade).toMatchObject({ status: "approved", nowShown: true });
    expect(JSON.parse(t.storage.data.get(tokenKey(URL_A))!).token).toBe("rotated-token");
    t.client.stop();
  });

  it("a request the gateway no longer holds when waited on again is stale", async () => {
    const t = await setUp();
    await waiting(t.client);
    t.gateway.handlers["device.scopes.waitUpgrade"] = () => {
      throw new GatewayError({
        code: "INVALID_REQUEST",
        message: "scope upgrade expired or not found",
      });
    };
    t.gateway.dropAll();
    await until(() => t.client.state.connection.upgrade.status === "stale");
    expect(t.client.state.connection.upgrade.approveCommand).toBeNull();
    expect(t.gateway.calls("device.scopes.requestUpgrade")).toHaveLength(1);
    t.client.stop();
  });
});

describe("F-500: Check now and Stop waiting", () => {
  it("the request still pending keeps the waiting state", async () => {
    let read: ReadBack = { ok: true, identity: identity(), list: listed([], []) };
    const t = await setUp({ readBack: () => read });
    await waiting(t.client);
    read = {
      ok: true,
      identity: identity(),
      list: listed([pendingEntry(REQUEST, INTERACTIVE_SCOPES)], [paired(READ_SCOPES)]),
    };
    await t.client.checkAccess();
    expect(t.client.state.connection.upgrade).toMatchObject({
      status: "pending",
      approveCommand: `openclaw devices approve ${REQUEST}`,
    });
    t.client.stop();
  });

  it("a stale request says the gateway's pending list doesn't hold it, and keeps no command", async () => {
    const t = await setUp({
      readBack: () => ({ ok: true, identity: identity(), list: listed([], [paired(READ_SCOPES)]) }),
    });
    await waiting(t.client);
    await t.client.checkAccess();
    expect(t.client.state.connection.upgrade).toMatchObject({
      status: "stale",
      approveCommand: null,
    });
    expect(t.changedGateway()).toEqual([]);
    t.client.stop();
  });

  it("another pending request for this device shows no command for it and stops waiting", async () => {
    const t = await setUp({
      readBack: () => ({
        ok: true,
        identity: identity(),
        list: listed(
          [pendingEntry(OTHER_REQUEST, [...INTERACTIVE_SCOPES, "operator.admin"])],
          [paired(READ_SCOPES)],
        ),
      }),
    });
    await waiting(t.client);
    await t.client.checkAccess();
    expect(t.client.state.connection.upgrade).toMatchObject({
      status: "other-request",
      approveCommand: null,
    });
    expect(JSON.stringify(t.client.state)).not.toContain(OTHER_REQUEST);
    t.client.stop();
  });

  it("the same id from another client is another request", async () => {
    const t = await setUp({
      readBack: () => ({
        ok: true,
        identity: identity(),
        list: listed(
          [pendingEntry(REQUEST, INTERACTIVE_SCOPES, { clientId: "openclaw-control-ui" })],
          [paired(READ_SCOPES)],
        ),
      }),
    });
    await waiting(t.client);
    await t.client.checkAccess();
    expect(t.client.state.connection.upgrade.status).toBe("other-request");
    t.client.stop();
  });

  it("a list that couldn't be read names the computer, and the exit code only when recorded", async () => {
    let exitCode: number | null = 2;
    const t = await setUp({
      readBack: () => ({ ok: false, step: "list", exitCode, identity: identity() }),
    });
    await waiting(t.client);
    await t.client.checkAccess();
    expect(t.client.state.connection.upgrade).toMatchObject({
      status: "list-unread",
      error: "Couldn't read the gateway's requests on devbox. OpenClaw exited with code 2.",
    });
    exitCode = null;
    await t.client.checkAccess();
    expect(t.client.state.connection.upgrade.error).toBe(
      "Couldn't read the gateway's requests on devbox.",
    );
    // Still connected and still waiting on the gateway: a failed look changes nothing else.
    expect(t.client.state.connection.status).toBe("connected");
    t.client.stop();
  });

  it("a different gateway at the endpoint, while waiting, ends the wait and the connection", async () => {
    const t = await setUp({
      readBack: () => ({ ok: true, identity: identity("gw-other"), list: listed([], []) }),
    });
    await waiting(t.client);
    await t.client.checkAccess();
    expect(t.client.state.connection.upgrade.status).toBe("identity-changed");
    expect(t.client.state.connection.status).toBe("error");
    expect(t.client.state.connection.error?.code).toBe("APPROVAL_IDENTITY_CHANGED");
    // The wait is over: an approval that arrives now keeps nothing and reconnects nothing.
    t.approve();
    await sleep(50);
    expect(t.connectsWith("rotated-token")).toEqual([]);
    expect(t.storage.data.get(tokenKey(URL_A))).toBe(t.saved);
    expect(t.client.suspended).toBe(true);
    t.client.stop();
  });

  it("an identity that couldn't be read while waiting can be looked at again, and the wait goes on", async () => {
    let read: ReadBack = { ok: false, step: "identity", exitCode: null };
    const t = await setUp({ readBack: () => read });
    await waiting(t.client);
    await t.client.checkAccess();
    expect(t.client.state.connection.upgrade.status).toBe("identity-unread");
    expect(t.client.state.connection.status).toBe("connected");
    read = {
      ok: true,
      identity: identity(),
      list: listed([pendingEntry(REQUEST, INTERACTIVE_SCOPES)], [paired(READ_SCOPES)]),
    };
    await t.client.checkAccess();
    expect(t.client.state.connection.upgrade.status).toBe("pending");
    t.client.stop();
  });

  it("where the host can look, the waiting request is checked on a schedule, and says when", async () => {
    const t = await setUp({ checkMs: 60 });
    await waiting(t.client);
    const first = t.client.state.connection.upgrade.checkAt;
    expect(typeof first).toBe("number");
    expect(t.client.state.connection.upgrade.place).toBe("here");
    await until(() => t.reads.length >= 2);
    // Read-only, and nothing but reads: the wait itself goes on.
    expect(t.changedGateway()).toEqual([]);
    expect(t.gateway.calls("device.scopes.requestUpgrade")).toHaveLength(1);
    t.client.stopWaiting();
    const reads = t.reads.length;
    await sleep(150);
    expect(t.reads.length).toBe(reads);
    t.client.stop();
  });

  it("a wait resumed after a drop has its own scheduled check, as the first one did", async () => {
    const t = await setUp({ checkMs: 10_000 });
    await waiting(t.client);
    t.gateway.handlers["device.scopes.waitUpgrade"] = () => new Promise(() => {});
    t.gateway.dropAll();
    await until(() => t.client.state.connection.status !== "connected");
    await until(() => t.gateway.calls("device.scopes.waitUpgrade").length === 2);
    await until(() => t.client.state.connection.upgrade.status === "pending");
    expect(typeof t.client.state.connection.upgrade.checkAt).toBe("number");
    t.client.stop();
  });

  it("a slower earlier check never overwrites a newer one's answer", async () => {
    const slow = deferred<ReadBack>();
    let calls = 0;
    const waitingRead: ReadBack = {
      ok: true,
      identity: identity(),
      list: listed([pendingEntry(REQUEST, INTERACTIVE_SCOPES)], [paired(READ_SCOPES)]),
    };
    const t = await setUp({ readBack: () => (calls++ === 0 ? slow.promise : waitingRead) });
    await waiting(t.client);
    const earlier = t.client.checkAccess();
    await until(() => calls === 1);
    await t.client.checkAccess();
    expect(t.client.state.connection.upgrade.status).toBe("pending");
    // The earlier check now answers that nothing is pending: it is too late to count.
    slow.resolve({ ok: true, identity: identity(), list: listed([], [paired(READ_SCOPES)]) });
    await earlier;
    expect(t.client.state.connection.upgrade.status).toBe("pending");
    t.client.stop();
  });

  it("Request again after a wait found stale ends that wait and makes a new request", async () => {
    const t = await setUp({
      readBack: () => ({ ok: true, identity: identity(), list: listed([], [paired(READ_SCOPES)]) }),
    });
    await waiting(t.client);
    await t.client.checkAccess();
    expect(t.client.state.connection.upgrade.status).toBe("stale");
    await t.client.requestAccess();
    await until(() => t.gateway.calls("device.scopes.requestUpgrade").length === 2);
    await until(() => t.client.state.connection.upgrade.status === "pending");
    t.client.stop();
  });

  it("an address route has no scheduled check and no Check now: its wait is continuous", async () => {
    const t = await setUp({ checkMs: 30, connection: { url: URL_A, token: null, address: true } });
    await waiting(t.client);
    expect(t.client.state.connection.upgrade.checkAt ?? null).toBeNull();
    await t.client.checkAccess();
    await sleep(100);
    expect(t.reads).toEqual([]);
    t.client.stop();
  });

  it("a Check now answer that arrives while the approval is confirmed is dropped", async () => {
    const check = deferred<ReadBack>();
    const confirm = deferred<ReadBack>();
    let calls = 0;
    const t = await setUp({
      readBack: () => (calls++ === 0 ? check.promise : confirm.promise),
    });
    await waiting(t.client);
    const checking = t.client.checkAccess();
    t.approve();
    await until(() => t.reads.length === 2);
    expect(t.client.state.connection.upgrade.status).toBe("confirming");
    // The late answer says the request isn't listed: it would have said stale.
    check.resolve({ ok: true, identity: identity(), list: listed([], []) });
    await checking;
    await sleep(30);
    expect(t.client.state.connection.upgrade.status).toBe("confirming");
    confirm.resolve(exact());
    await until(() => t.client.state.connection.canWrite);
    expect(t.client.state.connection.upgrade.status).toBe("approved");
    t.client.stop();
  });

  it("a Check now answer that arrives after Stop waiting is dropped", async () => {
    const hold = deferred<ReadBack>();
    const t = await setUp({ readBack: () => hold.promise });
    await waiting(t.client);
    const checking = t.client.checkAccess();
    t.client.stopWaiting();
    hold.resolve({ ok: true, identity: identity(), list: listed([], []) });
    await checking;
    expect(t.client.state.connection.upgrade.status).toBe("idle");
    t.client.stop();
  });

  it("Stop waiting stops this device's wait and asks nothing of the gateway", async () => {
    const t = await setUp();
    await waiting(t.client);
    const before = t.gateway.requests.length;
    t.client.stopWaiting();
    expect(t.client.state.connection.upgrade.status).toBe("idle");
    await sleep(30);
    expect(t.gateway.requests.slice(before)).toEqual([]);
    // The gateway's request stays; an approval that arrives later finds no waiter and keeps nothing.
    t.approve();
    await sleep(30);
    expect(t.storage.data.get(tokenKey(URL_A))).toBe(t.saved);
    t.client.stop();
  });
});

describe("F-500: a first pairing its owner approved is confirmed before it is kept", () => {
  const CODE = "boot-code-1234567890";
  const FIRST = "e5eb4aa8-175f-40f1-bc7a-8f15cfc40942";

  async function firstPairing(
    readBack: () => ReadBack | null,
    hello?: (token: string) => string[],
    options: {
      failSettings?: boolean;
      firstGrant?: string[];
      /** The gateway's save waits until this settles. */
      holdSettings?: Promise<void>;
    } = {},
  ) {
    const gateway = new FakeGateway();
    let approved = false;
    gateway.connectReply = (params) => {
      const { auth } = params as ConnectParams & { auth?: { bootstrapToken?: string } };
      if (!approved)
        return {
          ok: false,
          error: {
            code: "NOT_PAIRED",
            message: "pairing required",
            details: { code: "PAIRING_REQUIRED", requestId: FIRST, deviceId: "device-1" },
          },
        };
      const token = auth?.deviceToken;
      return {
        ok: true,
        payload: helloOk(
          token ? (hello?.(token) ?? ["operator.read"]) : (options.firstGrant ?? ["operator.read"]),
          "first-token",
        ),
      };
    };
    gateway.handlers["gateway.identity.get"] = () => identity();
    const storage = memoryStorage();
    const settingsWrites: string[] = [];
    if (options.failSettings || options.holdSettings) {
      const set = storage.set;
      storage.set = async (key, value) => {
        if (key === "connection") {
          settingsWrites.push(value);
          if (options.failSettings) throw new Error("disk full");
          await options.holdSettings;
        }
        await set(key, value);
      };
    }
    const reads: Array<string | undefined> = [];
    const client = new ClawtrateClient(
      {
        ...testHost(gateway, storage),
        readBack: async () => {
          reads.push(storage.data.get(tokenKey(URL_A)));
          return readBack();
        },
      },
      FAST,
    );
    await client.start();
    await client.connectWithSetupCode({
      url: URL_A,
      bootstrapToken: CODE,
      expiresAtMs: Date.now() + 60_000,
    });
    await until(() => client.state.connection.status === "pairing");
    expect(client.state.connection.pairing?.approveCommand).toBe(
      `openclaw devices approve ${FIRST}`,
    );
    approved = true;
    await client.retryNow();
    return { gateway, storage, client, reads, settingsWrites };
  }

  it("reads back exactly read, reconnects with the token, then saves it and the gateway", async () => {
    const t = await firstPairing(() => ({
      ok: true,
      identity: identity(),
      list: listed([], [paired(READ_SCOPES)]),
    }));
    await until(() => t.client.state.connection.status === "connected");
    expect(t.reads).toEqual([undefined]);
    const auths = t.gateway.connects.map((c) => (c as ConnectParams).auth);
    expect(auths.at(-1)).toMatchObject({ deviceToken: "first-token" });
    expect(JSON.parse(t.storage.data.get(tokenKey(URL_A))!).heldScopes).toEqual(["operator.read"]);
    expect(JSON.parse(t.storage.data.get("connection")!).url).toBe(URL_A);
    t.client.stop();
  });

  it("a record with more than read disconnects with the design's words and saves nothing", async () => {
    const t = await firstPairing(() => ({
      ok: true,
      identity: identity(),
      list: listed([], [paired(INTERACTIVE_SCOPES)]),
    }));
    await until(() => t.client.state.connection.status === "error");
    expect(t.client.state.connection.error).toMatchObject({
      code: "APPROVAL_UNCONFIRMED",
      message: `${APPROVAL_WORDS.unconfirmed.title} ${APPROVAL_WORDS.unconfirmed.detail}`,
    });
    expect(t.storage.data.has(tokenKey(URL_A))).toBe(false);
    expect(t.storage.data.has("connection")).toBe(false);
    expect(JSON.stringify(t.client.state)).not.toContain(CODE);
    t.client.stop();
  });

  it("a reconnect granted more than read disconnects and saves nothing", async () => {
    const t = await firstPairing(
      () => ({ ok: true, identity: identity(), list: listed([], [paired(READ_SCOPES)]) }),
      () => ["operator.read", "operator.write"],
    );
    await until(() => t.client.state.connection.status === "error");
    expect(t.client.state.connection.error?.code).toBe("APPROVAL_UNCONFIRMED");
    expect(t.storage.data.has(tokenKey(URL_A))).toBe(false);
    t.client.stop();
  });

  it("a failed read-back disconnects and saves nothing", async () => {
    const t = await firstPairing(() => ({
      ok: false,
      step: "list",
      exitCode: 1,
      identity: identity(),
    }));
    await until(() => t.client.state.connection.status === "error");
    expect(t.client.state.connection.error?.code).toBe("APPROVAL_UNCONFIRMED");
    expect(t.storage.data.has(tokenKey(URL_A))).toBe(false);
    t.client.stop();
  });

  it("Stop during the gateway's save puts back both: no token and no gateway, and shutdown waits for it", async () => {
    const release = deferred<void>();
    const t = await firstPairing(
      () => ({ ok: true, identity: identity(), list: listed([], [paired(READ_SCOPES)]) }),
      undefined,
      { holdSettings: release.promise },
    );
    // The token is written, and the gateway's save is under way when the host stops.
    await until(() => t.settingsWrites.length === 1);
    expect(t.storage.data.has(tokenKey(URL_A))).toBe(true);
    t.client.stop();
    const settled = t.client.settled().then(() => "settled");
    await sleep(20);
    expect(await Promise.race([settled, Promise.resolve("waiting")])).toBe("waiting");
    release.resolve();
    expect(await settled).toBe("settled");
    expect(t.storage.data.has(tokenKey(URL_A))).toBe(false);
    expect(t.storage.data.has("connection")).toBe(false);
  });

  it("another gateway chosen during the save: both entries of this pairing are put back, then the new choice is saved", async () => {
    const release = deferred<void>();
    const t = await firstPairing(
      () => ({ ok: true, identity: identity(), list: listed([], [paired(READ_SCOPES)]) }),
      undefined,
      { holdSettings: release.promise },
    );
    await until(() => t.settingsWrites.length === 1);
    const chosen = t.client.connect({ url: URL_B, token: "other" }).catch(() => undefined);
    await sleep(20);
    release.resolve();
    await chosen;
    expect(t.storage.data.has(tokenKey(URL_A))).toBe(false);
    expect(JSON.parse(t.storage.data.get("connection")!).url).toBe(URL_B);
    t.client.stop();
  });

  it("a gateway that can't be saved leaves no token behind either", async () => {
    const t = await firstPairing(
      () => ({ ok: true, identity: identity(), list: listed([], [paired(READ_SCOPES)]) }),
      undefined,
      { failSettings: true },
    );
    await until(() => t.client.state.connection.status === "error");
    expect(t.client.state.connection.error?.code).toBe("APPROVAL_UNCONFIRMED");
    expect(t.storage.data.has(tokenKey(URL_A))).toBe(false);
    expect(t.storage.data.has("connection")).toBe(false);
    t.client.stop();
  });

  it("a first hello after the owner's approval granting more than read has §9's words", async () => {
    const t = await firstPairing(
      () => ({ ok: true, identity: identity(), list: listed([], [paired(READ_SCOPES)]) }),
      undefined,
      { firstGrant: ["operator.read", "operator.write"] },
    );
    await until(() => t.client.state.connection.status === "error");
    expect(t.client.state.connection.error).toMatchObject({
      code: "APPROVAL_UNCONFIRMED",
      message: `${APPROVAL_WORDS.unconfirmed.title} ${APPROVAL_WORDS.unconfirmed.detail}`,
    });
    expect(t.storage.data.has(tokenKey(URL_A))).toBe(false);
    expect(t.reads).toEqual([]);
    t.client.stop();
  });

  it("Stop waiting on the pairing screen stops retrying, drops the code, and asks nothing of the gateway", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: false,
      error: {
        code: "NOT_PAIRED",
        message: "pairing required",
        details: { code: "PAIRING_REQUIRED", requestId: FIRST, deviceId: "device-1" },
      },
    });
    const storage = memoryStorage();
    const client = new ClawtrateClient(
      { ...testHost(gateway, storage), readBack: async () => exact(READ_SCOPES) },
      FAST,
    );
    await client.start();
    await client.connectWithSetupCode({
      url: URL_A,
      bootstrapToken: CODE,
      expiresAtMs: Date.now() + 60_000,
    });
    await until(() => client.state.connection.status === "pairing");
    client.stopPairing();
    expect(client.state.connection).toMatchObject({
      status: "error",
      retryAt: null,
      pairing: null,
      error: { code: "PAIRING_STOPPED" },
    });
    const connects = gateway.connects.length;
    await sleep(150);
    expect(gateway.connects.length).toBe(connects);
    expect(JSON.stringify(client.state)).not.toContain(CODE);
    expect(gateway.requests.filter((r) => NEVER_SENT.includes(r.method))).toEqual([]);
    // The gateway stays selected, for another explicit attempt.
    expect(client.state.connection.gatewayUrl).toBe(URL_A);
    client.stop();
  });
});

describe("F-500: an approval is bound to one request and one connection", () => {
  it("Disconnect while the read-back runs: the late answer reopens nothing and saves nothing", async () => {
    const hold = deferred<ReadBack>();
    const t = await setUp({ readBack: () => hold.promise });
    await waiting(t.client);
    t.approve();
    await until(() => t.client.state.connection.upgrade.status === "confirming");
    await t.client.suspend();
    hold.resolve(exact());
    await sleep(80);
    expect(t.connectsWith("rotated-token")).toEqual([]);
    expect(t.storage.data.get(tokenKey(URL_A))).toBe(t.saved);
    expect(t.client.state.connection.status).toBe("disconnected");
    t.client.stop();
  });

  it("another gateway chosen while the read-back runs: nothing of the approval is kept", async () => {
    const hold = deferred<ReadBack>();
    const t = await setUp({ readBack: () => hold.promise });
    await waiting(t.client);
    t.approve();
    await until(() => t.client.state.connection.upgrade.status === "confirming");
    await t.client.connect({ url: "ws://127.0.0.1:19002" });
    hold.resolve(exact());
    await sleep(80);
    expect(t.connectsWith("rotated-token")).toEqual([]);
    expect(t.storage.data.get(tokenKey(URL_A))).toBe(t.saved);
    t.client.stop();
  });

  it("a confirming socket that drops before its hello is terminal: no retry with the staged token", async () => {
    const t = await setUp();
    await waiting(t.client);
    t.gateway.refuseConnections = true;
    t.approve();
    await until(() => t.client.state.connection.status === "error");
    expect(t.client.state.connection.upgrade.status).toBe("unconfirmed");
    t.gateway.refuseConnections = false;
    await sleep(150);
    expect(t.client.state.connection.status).toBe("error");
    expect(t.connectsWith("rotated-token")).toEqual([]);
    expect(t.storage.data.get(tokenKey(URL_A))).toBe(t.saved);
    expect(JSON.stringify(t.client.state)).not.toContain("rotated-token");
    await until(() => JSON.parse(t.storage.data.get("connection")!).suspended === true);
    t.client.stop();
  });

  it("a confirming hello in another protocol says identity or version, and keeps nothing", async () => {
    const t = await setUp();
    await waiting(t.client);
    t.gateway.connectReply = (params) => {
      const { scopes, auth } = params as ConnectParams;
      const hello = helloOk(scopes) as Record<string, unknown>;
      return {
        ok: true,
        payload: auth?.deviceToken === "rotated-token" ? { ...hello, protocol: 99 } : hello,
      };
    };
    t.approve();
    await until(() => t.client.state.connection.status === "error");
    expect(t.client.state.connection.upgrade.status).toBe("identity-unread");
    expect(t.client.state.connection.error).toMatchObject({
      code: "APPROVAL_IDENTITY_UNREAD",
      message: APPROVAL_WORDS.identityUnread,
    });
    expect(t.storage.data.get(tokenKey(URL_A))).toBe(t.saved);
    t.client.stop();
  });

  it("refused, it is kept disconnected at once, before its suspension is saved", async () => {
    const t = await setUp({ readBack: () => ({ ok: false, step: "identity", exitCode: null }) });
    await waiting(t.client);
    // The suspension's own write is held open.
    const release = deferred<void>();
    const set = t.storage.set;
    t.storage.set = async (key, value) => {
      if (key === "connection" && value.includes('"suspended":true')) await release.promise;
      await set(key, value);
    };
    t.approve();
    await until(() => t.client.state.connection.status === "error");
    expect(JSON.parse(t.storage.data.get("connection")!).suspended).toBeUndefined();
    expect(t.client.suspended).toBe(true);
    release.resolve();
    await until(() => JSON.parse(t.storage.data.get("connection")!).suspended === true);
    // Reconnect is the person's: it opens again, with the saved token.
    await t.client.retryNow();
    await until(() => t.client.state.connection.status === "connected");
    expect(t.client.suspended).toBe(false);
    t.client.stop();
  });
});

describe("F-500: a manual first pairing through Advanced is confirmed before it is kept", () => {
  const FIRST = "e5eb4aa8-175f-40f1-bc7a-8f15cfc40942";

  async function advanced(
    options: { grant?: string[]; identity?: () => unknown; manual?: boolean } = {},
  ) {
    const gateway = new FakeGateway();
    let approved = options.manual === false;
    const atConfirm: boolean[] = [];
    const storage = memoryStorage();
    gateway.connectReply = (params) => {
      const { scopes, auth } = params as ConnectParams;
      if (!approved)
        return {
          ok: false,
          error: {
            code: "NOT_PAIRED",
            message: "pairing required",
            details: { code: "PAIRING_REQUIRED", requestId: FIRST, deviceId: "device-1" },
          },
        };
      if (auth?.deviceToken === "first-token") {
        atConfirm.push(storage.data.has(tokenKey(URL_A)));
        return { ok: true, payload: helloOk(scopes) };
      }
      return { ok: true, payload: helloOk(options.grant ?? ["operator.read"], "first-token") };
    };
    gateway.handlers["gateway.identity.get"] = options.identity ?? (() => identity());
    const reads: string[] = [];
    const client = new ClawtrateClient(
      {
        ...testHost(gateway, storage),
        readBack: async (url) => {
          reads.push(url);
          return null;
        },
      },
      FAST,
    );
    await client.start();
    await client.connect({ url: URL_A, token: "bootstrap-secret" });
    if (options.manual !== false) {
      await until(() => client.state.connection.status === "pairing");
      approved = true;
      await client.retryNow();
    }
    const deviceTokens = () =>
      gateway.connects.map((c) => (c as ConnectParams).auth?.deviceToken).filter(Boolean);
    return { gateway, storage, client, reads, atConfirm, deviceTokens };
  }

  it("stages the token, confirms exactly read and the gateway on a second hello, then keeps it", async () => {
    const t = await advanced();
    await until(() => t.client.state.connection.status === "connected");
    await until(() => t.storage.data.has(tokenKey(URL_A)));
    // The second hello used the staged token, and nothing was kept before it.
    expect(t.deviceTokens()).toEqual(["first-token"]);
    expect(t.atConfirm).toEqual([false]);
    expect(JSON.parse(t.storage.data.get(tokenKey(URL_A))!)).toMatchObject({
      token: "first-token",
      heldScopes: ["operator.read"],
    });
    // An explicit address has no shell: nothing was read back there.
    expect(t.reads).toEqual([]);
    expect(JSON.parse(t.storage.data.get("connection")!).token).toBeNull();
    t.client.stop();
  });

  it("a grant of more than read keeps nothing, with the approval's words", async () => {
    const t = await advanced({ grant: ["operator.read", "operator.write"] });
    await until(() => t.client.state.connection.status === "error");
    expect(t.client.state.connection.error).toMatchObject({
      code: "APPROVAL_UNCONFIRMED",
      message: `${APPROVAL_WORDS.unconfirmed.title} ${APPROVAL_WORDS.unconfirmed.detail}`,
    });
    expect(t.storage.data.has(tokenKey(URL_A))).toBe(false);
    expect(t.deviceTokens()).toEqual([]);
    t.client.stop();
  });

  it("a confirming hello whose gateway can't say who it is keeps nothing", async () => {
    const t = await advanced({
      identity: () => {
        throw new GatewayError({ code: "UNAVAILABLE", message: "no identity" });
      },
    });
    await until(() => t.client.state.connection.status === "error");
    expect(t.client.state.connection.error?.code).toBe("APPROVAL_IDENTITY_UNREAD");
    // It failed on the confirming connection itself, with the staged token.
    expect(t.deviceTokens()).toEqual(["first-token"]);
    expect(t.storage.data.has(tokenKey(URL_A))).toBe(false);
    t.client.stop();
  });

  it("a pairing the gateway grants by itself keeps section 7's outcome: the first hello's token, no second hello", async () => {
    const t = await advanced({ manual: false });
    await until(() => t.client.state.connection.status === "connected");
    await until(() => t.storage.data.has(tokenKey(URL_A)));
    expect(t.deviceTokens()).toEqual([]);
    t.client.stop();
  });
});

describe("F-500: a connection saved before the address mark, to a remote address", () => {
  it("still needs a read-back: with none to be had it keeps nothing, and waits with the address words", async () => {
    const REMOTE = "wss://gateway.example";
    const gateway = new FakeGateway();
    gateway.connectReply = (params) => {
      const { scopes, auth } = params as ConnectParams;
      return { ok: true, payload: helloOk(scopes, auth?.deviceToken ?? "device-token") };
    };
    gateway.handlers["gateway.identity.get"] = () => identity();
    gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: REQUEST });
    gateway.handlers["device.scopes.waitUpgrade"] = () => ({
      status: "approved",
      requestId: REQUEST,
      deviceToken: "rotated-token",
      scopes: [...INTERACTIVE_SCOPES],
    });
    const saved = JSON.stringify({
      token: "read-token",
      grantedScopes: READ_SCOPES,
      heldScopes: READ_SCOPES,
    });
    const storage = memoryStorage({
      connection: JSON.stringify({ url: REMOTE, token: null }),
      [tokenKey(REMOTE)]: saved,
    });
    const client = new ClawtrateClient(
      { ...testHost(gateway, storage), readBack: async () => null },
      FAST,
    );
    await client.start();
    await until(() => client.state.connection.gatewayId === GATEWAY);
    await client.requestAccess();
    await until(() => client.state.connection.status === "error");
    expect(client.state.connection.upgrade).toMatchObject({
      status: "identity-unread",
      place: "address",
    });
    expect(storage.data.get(tokenKey(REMOTE))).toBe(saved);
    expect(
      gateway.connects.some((c) => (c as ConnectParams).auth?.deviceToken === "rotated-token"),
    ).toBe(false);
    client.stop();
  });
});

describe("F-500: the waiting words follow how the connection was chosen", () => {
  it("a first pairing's command is built with the profile kept with the connection", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: false,
      error: {
        code: "NOT_PAIRED",
        message: "pairing required",
        details: { code: "PAIRING_REQUIRED", requestId: REQUEST, deviceId: "device-1" },
      },
    });
    const asked: unknown[][] = [];
    const client = new ClawtrateClient(
      {
        ...testHost(gateway, memoryStorage()),
        approvalInstructions: (...args: unknown[]) => {
          asked.push(args);
          return { command: "the host's command", note: null };
        },
      },
      FAST,
    );
    await client.start();
    await client.connectWithSetupCode(
      { url: URL_A, bootstrapToken: "b".repeat(43), expiresAtMs: Date.now() + 60_000 },
      { here: { profile: "clawtrate" } },
    );
    await until(() => client.state.connection.status === "pairing");
    expect(asked.at(-1)).toEqual([URL_A, REQUEST, { profile: "clawtrate" }, false]);
    client.stop();
  });

  it("an explicit address tells the host so, so no place found there is named for it", async () => {
    const asked: unknown[][] = [];
    const t = await setUp({ connection: { url: URL_A, token: null, address: true } });
    const host = t.client as unknown as {
      host: { approvalInstructions: (...a: unknown[]) => unknown };
    };
    const original = host.host.approvalInstructions;
    host.host.approvalInstructions = (...args: unknown[]) => {
      asked.push(args);
      return original(...args);
    };
    await waiting(t.client);
    expect(asked.at(-1)?.slice(2)).toEqual([null, true]);
    t.client.stop();
  });
});

describe("F-500: Review and Look again on this computer", () => {
  it("a host without the saved profile's look refuses, and never looks generally instead", async () => {
    const t = await setUp();
    const looked: string[] = [];
    const viewer = createBridgeSession(t.client, {
      setup: {
        look: async () => void looked.push("look"),
        cancel: () => {},
        connect: async () => {},
        reset: () => {},
      },
    });
    await expect(viewer.apply({ type: "setupReviewHere" })).rejects.toThrow();
    expect(looked).toEqual([]);
    viewer.dispose();
    t.client.stop();
  });
});
