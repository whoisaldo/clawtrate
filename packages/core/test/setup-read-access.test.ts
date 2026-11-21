// What Connect on this computer asks for (docs/design/setup.md §7): read,
// always. A device with a saved pairing reconnects for setup asking for
// `operator.read` alone, whatever its saved record holds or comes to hold;
// every hello is held to the signed request; and a pairing-only upgrade
// adds pairing and nothing else, whatever the gateway grants.

import { describe, expect, it } from "vitest";
import {
  ClawtrateClient,
  SETUP_CONNECT_REFUSED,
  SETUP_ENDPOINT_CHANGED,
  SETUP_PAIRING_GONE,
} from "../src/client.ts";
import { MAX_LOOK_OTHERS, initialSetupState } from "../src/setup.ts";
import { PAIRING_SCOPE, READ_SCOPE, READ_SCOPES, WRITE_SCOPE } from "../src/scopes.ts";
import { AccountsGateway, accountsClient } from "./accounts-fake.ts";
import { FAST, URL_A } from "./client-harness.ts";
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
type Connect = { scopes: string[]; auth?: Record<string, string> };

const record = (heldScopes: string[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ token: "device-token", grantedScopes: heldScopes, heldScopes, ...extra });

/** A gateway that grants `granted` to any device-token connect. */
function granting(granted: string[]) {
  const gateway = new FakeGateway();
  gateway.connectReply = () => ({ ok: true, payload: helloOk(granted, "device-token") });
  return gateway;
}

describe("a setup reconnect with a saved pairing", () => {
  it("F-492: a device that holds write asks for read alone, holds read, and keeps write saved for later ordinary connections", async () => {
    const gateway = granting([READ_SCOPE, WRITE_SCOPE]);
    const storage = memoryStorage({ [tokenKey(URL)]: record([READ_SCOPE, WRITE_SCOPE]) });
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await client.connectForSetup(URL);
    await until(() => client.state.discovery.status === "ready");
    expect((gateway.connects[0] as Connect).scopes).toEqual([READ_SCOPE]);
    expect((gateway.connects[0] as Connect).auth).toEqual({ deviceToken: "device-token" });
    expect(client.state.connection.scopes).toEqual([READ_SCOPE]);
    expect(client.state.connection.canWrite).toBe(false);
    expect(JSON.parse(storage.data.get(tokenKey(URL))!).heldScopes).toEqual([
      READ_SCOPE,
      WRITE_SCOPE,
    ]);
    // Setup is over: the next ordinary connection asks for what the device holds.
    gateway.dropAll();
    await until(
      () => gateway.connects.length === 2 && client.state.connection.status === "connected",
    );
    expect((gateway.connects[1] as Connect).scopes).toEqual([READ_SCOPE, WRITE_SCOPE]);
    expect(client.state.connection.canWrite).toBe(true);
    client.stop();
  });

  it("F-492: a setup whose bots failed to load keeps asking for read alone, on a reconnect and a retry", async () => {
    const gateway = granting([READ_SCOPE, WRITE_SCOPE]);
    const bots = gateway.handlers["agents.list"]!;
    gateway.handlers["agents.list"] = () => {
      throw new Error("fixture: the bots couldn't be read");
    };
    const storage = memoryStorage({ [tokenKey(URL)]: record([READ_SCOPE, WRITE_SCOPE]) });
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await client.connectForSetup(URL);
    await until(() => client.state.discovery.status === "error");
    // The setup failure screen is up. The connection drops and reconnects by itself.
    gateway.dropAll();
    await until(
      () => gateway.connects.length === 2 && client.state.connection.status === "connected",
    );
    expect((gateway.connects[1] as Connect).scopes).toEqual([READ_SCOPE]);
    // And the screen's Try again, from a dropped connection, opens with read alone too.
    gateway.refuseConnections = true;
    gateway.dropAll();
    await until(() => client.state.connection.status !== "connected");
    gateway.refuseConnections = false;
    await client.retryNow();
    await until(
      () => client.state.connection.status === "connected" && gateway.connects.length >= 3,
    );
    for (const sent of gateway.connects as Connect[]) expect(sent.scopes).toEqual([READ_SCOPE]);
    expect(client.state.connection.canWrite).toBe(false);
    // Once the bots are read, setup is over and an ordinary reconnect asks for what is held.
    gateway.handlers["agents.list"] = bots;
    gateway.dropAll();
    await until(() => client.state.discovery.status === "ready");
    const count = gateway.connects.length;
    gateway.dropAll();
    await until(
      () => gateway.connects.length > count && client.state.connection.status === "connected",
    );
    expect((gateway.connects.at(-1) as Connect).scopes).toEqual([READ_SCOPE, WRITE_SCOPE]);
    client.stop();
  });

  it("F-492: the first frame with a credential goes only within the dialog's consent, a saved token's too", async () => {
    for (const mode of ["saved-token", "code"] as const) {
      const gateway = granting([READ_SCOPE]);
      const storage = memoryStorage(
        mode === "saved-token" ? { [tokenKey(URL)]: record([READ_SCOPE]) } : {},
      );
      const client = new ClawtrateClient(testHost(gateway, storage), FAST);
      await client.start();
      // The dialog's two minutes have passed by the time the socket is ready to send.
      const consent = () => false;
      if (mode === "saved-token") await client.connectForSetup(URL, { consent });
      else
        await client.connectWithSetupCode(
          {
            url: URL,
            bootstrapToken: "setup-bootstrap-0123456789abcdefghijklmnop",
            expiresAtMs: Date.now() + 600_000,
          },
          { consent },
        );
      await until(() => client.state.connection.error?.code === SETUP_ENDPOINT_CHANGED);
      await sleep(100);
      expect(gateway.connects).toHaveLength(0);
      client.stop();
    }
    // Within it, the frame goes; once its hello is in, the consent is used and a reconnect
    // after the two minutes still goes on.
    const gateway = granting([READ_SCOPE]);
    const storage = memoryStorage({ [tokenKey(URL)]: record([READ_SCOPE]) });
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    let holds = true;
    await client.connectForSetup(URL, { consent: () => holds });
    await until(() => client.state.connection.status === "connected");
    holds = false;
    gateway.dropAll();
    await until(
      () => gateway.connects.length === 2 && client.state.connection.status === "connected",
    );
    client.stop();
  });

  it("F-492: a device that holds pairing alone asks for read alone", async () => {
    const gateway = granting([READ_SCOPE, PAIRING_SCOPE]);
    const storage = memoryStorage({
      [tokenKey(URL)]: record([READ_SCOPE], { pairingHeld: true }),
    });
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await client.connectForSetup(URL);
    await until(() => client.state.connection.status === "connected");
    expect((gateway.connects[0] as Connect).scopes).toEqual([READ_SCOPE]);
    expect(client.state.connection.scopes).toEqual([READ_SCOPE]);
    client.stop();
  });

  it("F-492: a wider record that appears after the dialog, before the request is signed, still asks for read alone", async () => {
    const gateway = granting([READ_SCOPE, WRITE_SCOPE]);
    const storage = gatedStorage({ [tokenKey(URL)]: record([READ_SCOPE]) });
    storage.hold(tokenKey(URL));
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    const connecting = client.connectForSetup(URL);
    await until(() => storage.waiting(tokenKey(URL)) > 0);
    storage.data.set(tokenKey(URL), record([READ_SCOPE, WRITE_SCOPE]));
    storage.release(tokenKey(URL));
    await connecting;
    await until(() => client.state.connection.status === "connected");
    for (const connect of gateway.connects)
      expect((connect as Connect).scopes).toEqual([READ_SCOPE]);
    expect(client.state.connection.canWrite).toBe(false);
    client.stop();
  });

  it("F-492: a saved pairing gone before the request is signed sends nothing and asks for a new consent", async () => {
    const gateway = granting([READ_SCOPE]);
    const storage = memoryStorage({ [tokenKey(URL)]: record([READ_SCOPE]) });
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    storage.data.delete(tokenKey(URL));
    await client.connectForSetup(URL);
    await until(() => client.state.connection.status === "error");
    expect(client.state.connection.error?.code).toBe(SETUP_PAIRING_GONE);
    expect(gateway.connects).toEqual([]);
    await sleep(100);
    expect(gateway.connects).toEqual([]);
    client.stop();
  });

  it("F-492: a hello granting more than asked is held to the request, on a read-only host with a wider record too", async () => {
    const gateway = granting([READ_SCOPE, WRITE_SCOPE, "operator.approvals"]);
    const storage = memoryStorage({ [tokenKey(URL)]: record([READ_SCOPE, WRITE_SCOPE]) });
    const client = new ClawtrateClient(testHost(gateway, storage), { ...FAST, readOnly: true });
    await client.start();
    await client.connect({ url: URL, token: null });
    await until(() => client.state.connection.status === "connected");
    expect((gateway.connects[0] as Connect).scopes).toEqual([READ_SCOPE]);
    expect(client.state.connection.scopes).toEqual([READ_SCOPE]);
    expect(client.state.connection.canWrite).toBe(false);
    expect(client.state.connection.canApprove).toBe(false);
    client.stop();
  });

  it("F-492: a write grant supplies the read that was asked; an unasked scope never enters", async () => {
    const gateway = granting([WRITE_SCOPE]);
    const storage = memoryStorage({ [tokenKey(URL)]: record([READ_SCOPE]) });
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await client.connect({ url: URL, token: null });
    await until(() => client.state.connection.status === "connected");
    expect(client.state.connection.scopes).toEqual([READ_SCOPE]);
    expect(client.state.connection.canWrite).toBe(false);
    client.stop();
  });

  it("F-492: says whether this device has a saved pairing for an address", async () => {
    const storage = memoryStorage({ [tokenKey(URL)]: record([READ_SCOPE, WRITE_SCOPE]) });
    const client = new ClawtrateClient(testHost(new FakeGateway(), storage), FAST);
    expect(await client.deviceAccess(URL)).toBe("paired");
    expect(await client.deviceAccess("ws://127.0.0.1:19960")).toBe("new");
  });
});

describe("an upgrade is held to what it asked for", () => {
  it("F-492: a pairing-only upgrade the gateway answers with write and approvals stores pairing and nothing more", async () => {
    const fake = new AccountsGateway();
    const wait = deferred<unknown>();
    fake.gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-1" });
    fake.gateway.handlers["device.scopes.waitUpgrade"] = () => wait.promise;
    const { client, storage } = await accountsClient({ gateway: fake, scopes: READ_SCOPES });
    await client.requestAccess("pairing");
    await until(() => client.state.connection.upgrade.status === "pending");
    expect(fake.gateway.calls("device.scopes.requestUpgrade")).toEqual([
      { scopes: [READ_SCOPE, PAIRING_SCOPE] },
    ]);
    const wider = [READ_SCOPE, WRITE_SCOPE, "operator.approvals", PAIRING_SCOPE];
    const before = fake.gateway.connects.length;
    wait.resolve({ status: "approved", requestId: "up-1", deviceToken: "rotated", scopes: wider });
    await until(() => JSON.parse(storage.data.get(tokenKey(URL_A))!).token === "rotated");
    const stored = JSON.parse(storage.data.get(tokenKey(URL_A))!);
    expect(stored.heldScopes).toEqual([READ_SCOPE, PAIRING_SCOPE]);
    expect(stored.grantedScopes).toEqual([READ_SCOPE, PAIRING_SCOPE]);
    expect(stored.adminHeld).toBeUndefined();
    // The reconnect that follows uses the rotated token and asks for read and pairing alone.
    await until(
      () => fake.gateway.connects.length > before && client.state.connection.status === "connected",
    );
    const reconnect = fake.gateway.connects.at(-1) as Connect;
    expect(reconnect.auth).toEqual({ deviceToken: "rotated" });
    expect(reconnect.scopes).toEqual([READ_SCOPE, PAIRING_SCOPE]);
    expect(client.state.connection.scopes).toEqual([READ_SCOPE, PAIRING_SCOPE]);
    expect(client.state.connection.canWrite).toBe(false);
    client.stop();
  });

  it("F-492: an approval that grants admin for a request for write is not taken as approved, since admin isn't kept", async () => {
    const fake = new AccountsGateway();
    const wait = deferred<unknown>();
    fake.gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-2" });
    fake.gateway.handlers["device.scopes.waitUpgrade"] = () => wait.promise;
    const { client, storage } = await accountsClient({ gateway: fake, scopes: READ_SCOPES });
    await client.requestAccess("interactive");
    await until(() => client.state.connection.upgrade.status === "pending");
    wait.resolve({
      status: "approved",
      requestId: "up-2",
      deviceToken: "rotated",
      scopes: ["operator.admin"],
    });
    await until(() => client.state.connection.upgrade.status !== "pending");
    expect(client.state.connection.upgrade.status).not.toBe("approved");
    expect(client.state.connection.upgrade.error).toContain("operator.admin");
    expect(JSON.parse(storage.data.get(tokenKey(URL_A))!).adminHeld).toBeUndefined();
    client.stop();
  });
});

describe("a setup connection, end to end of its first hello", () => {
  it("F-492: a setup that reused this device's pairing saves its gateway once its hello is in", async () => {
    const gateway = granting([READ_SCOPE]);
    const storage = memoryStorage({ [tokenKey(URL)]: record([READ_SCOPE]) });
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await client.connectForSetup(URL);
    await until(() => client.state.discovery.status === "ready");
    expect(JSON.parse(storage.data.get("connection")!)).toEqual({ url: URL, token: null });
    client.stop();
  });

  it("F-492: a refused saved token on a setup reuse is forgotten, behind the fixed code", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "device token mismatch",
        details: { code: "AUTH_DEVICE_TOKEN_MISMATCH" },
      },
    });
    const storage = memoryStorage({ [tokenKey(URL)]: record([READ_SCOPE]) });
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await client.connectForSetup(URL);
    await until(() => client.state.connection.status === "error");
    expect(client.state.connection.error?.code).toBe(SETUP_CONNECT_REFUSED);
    expect(client.state.connection.paired).toBe(false);
    await until(() => !storage.data.has(tokenKey(URL)));
    client.stop();
  });

  it("F-492: a setup pairing the gateway says not to wait on ends in a failure, not an approval wait that can't end", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: false,
      error: {
        code: "NOT_PAIRED",
        message: "pairing required",
        details: {
          code: "PAIRING_REQUIRED",
          requestId: "r-1",
          recommendedNextStep: "contact_owner",
        },
      },
    });
    const client = new ClawtrateClient(testHost(gateway, memoryStorage()), FAST);
    await client.start();
    await client.connectWithSetupCode({
      url: URL,
      bootstrapToken: "setup-bootstrap-0123456789abcdefghijklmnop",
      expiresAtMs: Date.now() + 600_000,
    });
    await until(() => client.state.connection.status === "error");
    expect(client.state.connection.error?.code).toBe("PAIRING_ENDED");
    expect(client.state.connection.pairing).toBeNull();
    await sleep(150);
    expect(gateway.connects).toHaveLength(1);
    client.stop();
  });

  it("F-492: a setup code connection that meets a token saved after its code went keeps that record's held access", async () => {
    const gateway = new FakeGateway();
    const storage = memoryStorage();
    // Saved while the gateway answers the code: before it, the code wouldn't go (SETUP_PAIRING_APPEARED).
    gateway.connectReply = (params) => {
      expect((params as { auth?: { bootstrapToken?: string } }).auth?.bootstrapToken).toBeTruthy();
      storage.data.set(
        tokenKey(URL),
        record([READ_SCOPE, WRITE_SCOPE], { adminHeld: true, pairingHeld: true }),
      );
      return { ok: true, payload: helloOk([READ_SCOPE], "reissued-token") };
    };
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await client.connectWithSetupCode({
      url: URL,
      bootstrapToken: "setup-bootstrap-0123456789abcdefghijklmnop",
      expiresAtMs: Date.now() + 600_000,
    });
    await until(() => storage.data.get(tokenKey(URL))?.includes("reissued-token") === true);
    const stored = JSON.parse(storage.data.get(tokenKey(URL))!);
    expect(stored.heldScopes).toEqual(expect.arrayContaining([READ_SCOPE, WRITE_SCOPE]));
    expect(stored.adminHeld).toBe(true);
    expect(stored.pairingHeld).toBe(true);
    client.stop();
  });

  it("F-492: a hello accepted on a socket replaced meanwhile saves no token and no settings", async () => {
    const gateway = new FakeGateway();
    let replies = 0;
    let holdNext = false;
    gateway.connectReply = () => {
      replies += 1;
      // The first socket's hello is accepted slowly: its read of the saved record waits.
      if (replies === 1) holdNext = true;
      return {
        ok: true,
        payload: helloOk([READ_SCOPE], replies === 1 ? "retired-token" : "current-token"),
      };
    };
    const base = memoryStorage({ [tokenKey(URL)]: record([READ_SCOPE]) });
    const held = deferred<void>();
    let settingsWrites = 0;
    const storage = {
      ...base,
      get: async (key: string) => {
        if (key === tokenKey(URL) && holdNext) {
          holdNext = false;
          await held.promise;
        }
        return base.get(key);
      },
      set: async (key: string, value: string) => {
        if (key === "connection") settingsWrites += 1;
        return base.set(key, value);
      },
    };
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await client.connect({ url: URL });
    await until(() => replies === 1);
    await sleep(50);
    // That socket drops while its hello is being accepted; the protocol opens a newer one,
    // on the same address and connection, which connects and saves its own token.
    gateway.dropAll();
    await until(() => base.data.get(tokenKey(URL))?.includes("current-token") === true);
    const writes = settingsWrites;
    held.resolve();
    await sleep(150);
    expect(JSON.parse(base.data.get(tokenKey(URL))!).token).toBe("current-token");
    expect(settingsWrites).toBe(writes);
    client.stop();
  });

  it("F-492: a plan of a setup connection already replaced reads and changes nothing of the new one", async () => {
    const gateway = granting([READ_SCOPE]);
    const storage = memoryStorage({ [tokenKey(URL)]: record([READ_SCOPE]) });
    // From the second read of the token on, each read waits until the test lets it go.
    let reads = 0;
    let holdFrom = 2;
    const held: Array<() => void> = [];
    const get = storage.get.bind(storage);
    storage.get = async (key: string) => {
      if (key === tokenKey(URL) && ++reads >= holdFrom)
        await new Promise<void>((go) => held.push(go));
      return get(key);
    };
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    const codes: string[] = [];
    client.store.subscribe((state) => {
      const code = state.connection.error?.code;
      if (code) codes.push(code);
    });
    // The first attempt's plan waits for its token while a second attempt starts.
    void client.connectForSetup(URL);
    await until(() => held.length === 1);
    storage.data.delete(tokenKey(URL));
    const second = client.connectForSetup(URL);
    await until(() => held.length === 2);
    // The old read answers "no token" after the new attempt began.
    held[0]!();
    await sleep(20);
    storage.data.set(tokenKey(URL), record([READ_SCOPE]));
    holdFrom = Infinity;
    held[1]!();
    await second;
    await until(() => client.state.connection.status === "connected");
    expect(codes).not.toContain(SETUP_PAIRING_GONE);
    expect(client.state.connection.scopes).toEqual([READ_SCOPE]);
    client.stop();
  });

  it("F-492: until the bots are first read, a retry after the hello checks the listener again", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({ ok: true, payload: helloOk([READ_SCOPE], "device-token") });
    // The bots never arrive: setup is still under way when the socket drops.
    gateway.handlers["agents.list"] = () => new Promise(() => {});
    let listening = true;
    const client = new ClawtrateClient(testHost(gateway, memoryStorage()), FAST);
    await client.start();
    await client.connectWithSetupCode(
      {
        url: URL,
        bootstrapToken: "setup-bootstrap-0123456789abcdefghijklmnop",
        expiresAtMs: Date.now() + 600_000,
      },
      { check: () => listening },
    );
    await until(() => client.state.connection.status === "connected");
    listening = false;
    gateway.dropAll();
    await sleep(300);
    expect(gateway.sockets).toHaveLength(1);
    expect(client.state.connection.error?.code).toBe("SETUP_ENDPOINT_CHANGED");
    client.stop();
  });

  it("keeps the host's setup slice as the store bounds it", () => {
    const client = new ClawtrateClient(testHost(new FakeGateway(), memoryStorage()), FAST);
    const others = Array.from({ length: MAX_LOOK_OTHERS + 40 }, (_, i) => `profile p${i}`);
    client.setSetup({
      ...initialSetupState,
      phase: "found",
      look: {
        outcome: "running",
        reason: null,
        version: null,
        profile: null,
        listens: null,
        service: null,
        port: null,
        authMode: null,
        access: null,
        others,
      },
    });
    expect(client.state.setup?.look?.others).toHaveLength(MAX_LOOK_OTHERS);
    const kept = (client as unknown as { setupSlice: typeof client.state.setup }).setupSlice;
    expect(kept?.look?.others).toHaveLength(MAX_LOOK_OTHERS);
  });
});
