// A setup connection's two listener reads and its consent, under races
// (docs/decisions.md, "The host's confirmation"): each read belongs to the
// socket that started it, both share one deadline within the handshake's
// time, a read that failed closes its own socket at once, a retired read
// leaves the connection that replaced it alone, and the saved pairing is read
// again after the last listener read, so a plan that no longer matches the
// person's consent never goes out.

import { describe, expect, it } from "vitest";
import {
  ClawtrateClient,
  SETUP_ENDPOINT_CHANGED,
  SETUP_PAIRING_APPEARED,
  SETUP_PAIRING_GONE,
} from "../src/client.ts";
import { READ_SCOPE } from "../src/scopes.ts";
import { FAST } from "./client-harness.ts";
import {
  deferred,
  FakeGateway,
  gatedStorage,
  helloOk,
  memoryStorage,
  sleep,
  testHost,
  tokenKey,
  until,
} from "./fake-gateway.ts";

const URL = "ws://127.0.0.1:19940";
const CODE = "fictional".repeat(4) + "1234567";
const SAVED = JSON.stringify({
  token: "device-token",
  grantedScopes: [READ_SCOPE],
  heldScopes: [READ_SCOPE],
});
type Connect = { auth?: { bootstrapToken?: string; deviceToken?: string } };

/** A gateway that grants read and a device token to any connect. */
function readGateway() {
  const gateway = new FakeGateway();
  gateway.connectReply = () => ({ ok: true, payload: helloOk([READ_SCOPE], "device-token") });
  return gateway;
}

const code = () => ({ url: URL, bootstrapToken: CODE, expiresAtMs: Date.now() + 60_000 });

describe("a setup socket's listener reads", () => {
  it("F-492: a failed read at open closes that socket at once, before its plan goes on, and nothing is sent", async () => {
    const gateway = readGateway();
    const storage = gatedStorage();
    const host = testHost(gateway, storage);
    // The socket's plan waits on its token read, so only the open read can end it now.
    host.createWebSocket = (url) => {
      storage.hold(tokenKey(URL));
      return gateway.createWebSocket(url);
    };
    const client = new ClawtrateClient(host, FAST);
    await client.start();
    let reads = 0;
    // Another listener as the socket opens, the look's again just before the frame.
    const verify = async () => ++reads > 1;
    await client.connectWithSetupCode(code(), { verify });
    await until(() => client.state.connection.error?.code === SETUP_ENDPOINT_CHANGED);
    await until(() => gateway.sockets[0]?.readyState === 3);
    expect(storage.waiting(tokenKey(URL))).toBeGreaterThan(0);
    storage.release(tokenKey(URL));
    await sleep(100);
    expect(gateway.connects).toHaveLength(0);
    expect(gateway.sockets).toHaveLength(1);
    expect(client.state.connection.error?.code).toBe(SETUP_ENDPOINT_CHANGED);
    client.stop();
  });

  it("F-492: a retired read never closes or changes the connection that replaced it", async () => {
    const gateway = readGateway();
    const storage = memoryStorage({ [tokenKey(URL)]: SAVED });
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    const first = deferred<boolean>();
    const firstVerify = async () => first.promise;
    await client.connectForSetup(URL, { verify: firstVerify });
    await until(() => gateway.sockets[0]?.readyState === 1);
    // The person connects again: a new connection, its own check, its listener as found.
    await client.connectForSetup(URL, { verify: async () => true });
    await until(() => client.state.discovery.status === "ready");
    const replacement = gateway.sockets.at(-1)!;
    // The first socket's read answers late, and says another process listened then.
    first.resolve(false);
    await sleep(100);
    expect(replacement.readyState).toBe(1);
    expect(client.state.connection.status).toBe("connected");
    expect(client.state.connection.error).toBeNull();
    expect(gateway.connects).toHaveLength(1);
    // And its check is still the replacement's own: a reconnect goes ahead.
    gateway.dropAll();
    await until(
      () => gateway.connects.length === 2 && client.state.connection.status === "connected",
    );
    client.stop();
  });

  it("F-492: both reads share one deadline within the handshake's time, and it ends the commands they started", async () => {
    const gateway = readGateway();
    const client = new ClawtrateClient(testHost(gateway, memoryStorage()), {
      ...FAST,
      setupListenerReadsMs: 200,
    });
    await client.start();
    const signals: AbortSignal[] = [];
    // The look's listener at open, then a read that never answers.
    const verify = async (signal: AbortSignal) => {
      signals.push(signal);
      if (signals.length === 1) return true;
      return new Promise<boolean>(() => {});
    };
    const started = Date.now();
    await client.connectWithSetupCode(code(), { verify });
    await until(() => client.state.connection.error?.code === SETUP_ENDPOINT_CHANGED, 3000);
    // Well before the protocol's 15 s, and as a change, never a timed-out retry.
    expect(Date.now() - started).toBeLessThan(3000);
    expect(signals).toHaveLength(2);
    // One signal for both reads of the socket, ended at the deadline.
    expect(signals[1]).toBe(signals[0]);
    expect(signals[0]!.aborted).toBe(true);
    expect(gateway.connects).toHaveLength(0);
    await sleep(100);
    expect(gateway.sockets).toHaveLength(1);
    client.stop();
  });
});

describe("a setup plan against the consent given, after its last wait", () => {
  it("F-492: a saved pairing missing on the lifecycle's own read sends nothing, not a frame without auth", async () => {
    const gateway = readGateway();
    const storage = memoryStorage({ [tokenKey(URL)]: SAVED });
    const get = storage.get;
    let reads = 0;
    const host = testHost(gateway, {
      ...storage,
      // Each socket's plan reads the token itself first, then the lifecycle reads it again,
      // then the plan reads it once more after its last listener read. Missing only for the
      // lifecycle's read: the plan it builds carries no token, and only its own check stops it.
      get: async (key) => {
        if (key !== tokenKey(URL) || gateway.sockets.length === 0) return get(key);
        reads += 1;
        if (reads === 2) return null;
        return get(key);
      },
    });
    const client = new ClawtrateClient(host, FAST);
    await client.start();
    await client.connectForSetup(URL, { verify: async () => true });
    await until(() => client.state.connection.error?.code === SETUP_PAIRING_GONE);
    await sleep(100);
    expect(gateway.connects).toHaveLength(0);
    client.stop();
  });

  it.each(["code expires", "listener changes"] as const)(
    "F-492: a pending pairing sends nothing when its %s during the final storage read",
    async (change) => {
      const gateway = readGateway();
      const storage = gatedStorage();
      const pairing = code();
      let now = pairing.expiresAtMs - 1;
      let sameListener = true;
      const client = new ClawtrateClient({ ...testHost(gateway, storage), now: () => now }, FAST);
      const key = tokenKey(URL);
      let reads = 0;
      await client.start();
      try {
        await client.connectWithSetupCode(pairing, {
          check: () => sameListener,
          verify: async () => {
            if (++reads === 2) storage.hold(key);
            return true;
          },
        });
        await until(() => storage.waiting(key) > 0);
        if (change === "code expires") now = pairing.expiresAtMs;
        else sameListener = false;
        storage.release(key);
        await until(
          () => client.state.connection.status === "error" || gateway.connects.length > 0,
        );
        expect(gateway.connects).toHaveLength(0);
        expect(client.state.connection.error?.code).toBe(SETUP_ENDPOINT_CHANGED);
      } finally {
        storage.release(key);
        client.stop();
      }
    },
  );

  for (const change of ["appears", "goes"] as const) {
    it(`F-492: a saved pairing that ${change === "appears" ? "appears" : "goes"} while the last listener read is pending sends nothing`, async () => {
      const gateway = readGateway();
      const storage = memoryStorage(change === "goes" ? { [tokenKey(URL)]: SAVED } : {});
      const client = new ClawtrateClient(testHost(gateway, storage), FAST);
      await client.start();
      const last = deferred<boolean>();
      let reads = 0;
      const verify = async () => (++reads === 1 ? true : last.promise);
      if (change === "appears") await client.connectWithSetupCode(code(), { verify });
      else await client.connectForSetup(URL, { verify });
      await until(() => reads === 2);
      if (change === "appears") storage.data.set(tokenKey(URL), SAVED);
      else storage.data.delete(tokenKey(URL));
      last.resolve(true);
      const expected = change === "appears" ? SETUP_PAIRING_APPEARED : SETUP_PAIRING_GONE;
      await until(() => client.state.connection.error?.code === expected);
      await sleep(100);
      expect(gateway.connects).toHaveLength(0);
      expect(JSON.stringify(gateway.connects as Connect[])).not.toContain(CODE);
      expect(JSON.stringify(client.state)).not.toContain(CODE);
      client.stop();
    });
  }
});
