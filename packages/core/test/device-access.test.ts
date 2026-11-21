// Device access (`operator.pairing`) for Settings, Machines' paired devices
// (controls.md section 15): asked for only by name, on top of what the device
// holds, never by itself, and held once granted.
import { describe, expect, it } from "vitest";
import { createBridgeSession, parseBridgeCommand } from "../src/bridge.ts";
import { ClawtrateClient } from "../src/client.ts";
import {
  ADMIN_SCOPES,
  INTERACTIVE_SCOPES,
  PAIRING_SCOPE,
  READ_SCOPE,
  READ_SCOPES,
} from "../src/scopes.ts";
import { AccountsGateway, accountsClient } from "./accounts-fake.ts";
import { FAST, URL_A } from "./client-harness.ts";
import { deferred, memoryStorage, testHost, tokenKey, until } from "./fake-gateway.ts";

describe("device access", () => {
  it("F-157: is asked for only by an explicit request, with the scopes already held, and held once granted", async () => {
    const fake = new AccountsGateway();
    const wait = deferred<unknown>();
    fake.gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-7" });
    fake.gateway.handlers["device.scopes.waitUpgrade"] = () => wait.promise;
    fake.gateway.handlers["node.list"] = () => ({ nodes: [] });
    fake.gateway.handlers["config.get"] = () => ({ config: {}, hash: "c1" });
    // As OpenClaw 2026.10.6 answers a device-token connection below admin: its own record only.
    fake.gateway.handlers["device.pair.list"] = () => ({
      paired: [{ deviceId: "device-1", displayName: "Clawtrate Desktop", role: "operator" }],
    });
    const { client, storage } = await accountsClient({ gateway: fake, scopes: INTERACTIVE_SCOPES });
    // Reading the machines asks for nothing: devices say which access they need.
    const before = await client.readMachines();
    expect(before.devices).toEqual({ status: "needs-pairing" });
    expect(fake.gateway.calls("device.scopes.requestUpgrade")).toEqual([]);
    expect(fake.gateway.calls("device.pair.list")).toEqual([]);

    await client.requestAccess("pairing");
    await until(() => client.state.connection.upgrade.status === "pending");
    const wanted = [...INTERACTIVE_SCOPES, PAIRING_SCOPE];
    expect(fake.gateway.calls("device.scopes.requestUpgrade")).toEqual([{ scopes: wanted }]);
    wait.resolve({ status: "approved", requestId: "up-7", deviceToken: "rotated", scopes: wanted });
    await until(() => client.state.connection.scopes.includes(PAIRING_SCOPE));
    const stored = JSON.parse(storage.data.get(tokenKey(URL_A))!);
    expect(stored).toMatchObject({ pairingHeld: true, heldScopes: wanted });
    expect(stored.adminHeld).toBeUndefined();
    expect(client.state.connection.canAdmin).toBe(false);

    const after = await client.readMachines();
    expect(
      Array.isArray(after.devices) && after.devices.map((d) => [d.name, d.thisDevice]),
    ).toEqual([["Clawtrate Desktop", true]]);
    // Every later connect asks for what was granted, and nothing more.
    fake.gateway.dropAll();
    await until(
      () =>
        client.state.connection.status === "connected" &&
        client.state.connection.scopes.includes(PAIRING_SCOPE),
    );
    const connects = fake.gateway.connects as Array<{ scopes: string[] }>;
    expect(connects.at(-1)!.scopes).toEqual(wanted);
    client.stop();
  });

  it("F-157: from a read connection, device access asks for the pairing scope with read and nothing else", async () => {
    const fake = new AccountsGateway();
    const wait = deferred<unknown>();
    fake.gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-8" });
    fake.gateway.handlers["device.scopes.waitUpgrade"] = () => wait.promise;
    const { client, storage } = await accountsClient({ gateway: fake, scopes: READ_SCOPES });
    await client.requestAccess("pairing");
    await until(() => client.state.connection.upgrade.status === "pending");
    const wanted = [READ_SCOPE, PAIRING_SCOPE];
    expect(fake.gateway.calls("device.scopes.requestUpgrade")).toEqual([{ scopes: wanted }]);
    wait.resolve({ status: "approved", requestId: "up-8", deviceToken: "rotated", scopes: wanted });
    await until(() => client.state.connection.scopes.includes(PAIRING_SCOPE));
    expect(JSON.parse(storage.data.get(tokenKey(URL_A))!)).toMatchObject({
      pairingHeld: true,
      heldScopes: wanted,
    });
    expect(client.state.connection.canWrite).toBe(false);
    const connects = fake.gateway.connects as Array<{ scopes: string[] }>;
    expect(connects.at(-1)!.scopes).toEqual(wanted);
    // The admin request stays its own: it asks for admin with the interactive tier.
    await client.requestAccess("admin");
    await until(() => fake.gateway.calls("device.scopes.requestUpgrade").length === 2);
    expect(fake.gateway.calls("device.scopes.requestUpgrade")[1]).toEqual({
      scopes: [...ADMIN_SCOPES, PAIRING_SCOPE],
    });
    client.stop();
  });

  it("F-157: device access asked for while the connection is being set up asks with the scopes it holds once up", async () => {
    const fake = new AccountsGateway();
    const wait = deferred<unknown>();
    fake.gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-9" });
    fake.gateway.handlers["device.scopes.waitUpgrade"] = () => wait.promise;
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: null, address: true }),
      [tokenKey(URL_A)]: JSON.stringify({
        token: "device-token",
        grantedScopes: READ_SCOPES,
        heldScopes: READ_SCOPES,
      }),
    });
    const client = new ClawtrateClient(testHost(fake.gateway, storage), FAST);
    // Asked for when the connect request reaches the gateway, before its hello: nothing is held yet.
    const reply = fake.gateway.connectReply;
    let asked: Promise<void> | null = null;
    fake.gateway.connectReply = (params, url) => {
      if (!asked) {
        expect(client.state.connection.status).not.toBe("connected");
        asked = client.requestAccess("pairing");
      }
      return reply(params, url);
    };
    await client.start();
    await until(() => asked !== null);
    await asked;
    await until(() => client.state.connection.upgrade.status === "pending");
    expect(fake.gateway.calls("device.scopes.requestUpgrade")).toEqual([
      { scopes: [READ_SCOPE, PAIRING_SCOPE] },
    ]);
    client.stop();
  });

  for (const [second, tier, held] of [
    ["interactive", INTERACTIVE_SCOPES, "canWrite"],
    ["admin", ADMIN_SCOPES, "canAdmin"],
  ] as const) {
    it(`F-157: a request for ${second} made while device access is pending keeps its own outcome`, async () => {
      const fake = new AccountsGateway();
      const first = deferred<unknown>();
      const next = deferred<unknown>();
      let count = 0;
      fake.gateway.handlers["device.scopes.requestUpgrade"] = () => ({
        requestId: `up-${++count}`,
      });
      fake.gateway.handlers["device.scopes.waitUpgrade"] = (params) =>
        (params as { requestId: string }).requestId === "up-1" ? first.promise : next.promise;
      const { client } = await accountsClient({ gateway: fake, scopes: READ_SCOPES });
      await client.requestAccess("pairing");
      await until(() => client.state.connection.upgrade.status === "pending");
      await client.requestAccess(second);
      await until(() => fake.gateway.calls("device.scopes.requestUpgrade").length === 2);
      const wanted = [...tier, PAIRING_SCOPE];
      expect(fake.gateway.calls("device.scopes.requestUpgrade")[1]).toEqual({ scopes: wanted });
      // The first wait ends after it was replaced: the second request stays as it is.
      first.reject(new Error("cancelled"));
      await until(() => client.state.connection.upgrade.requestId === "up-2");
      await new Promise<void>((resolve) => setTimeout(() => resolve(), 50));
      expect(client.state.connection.upgrade.status).toBe("pending");
      next.resolve({
        status: "approved",
        requestId: "up-2",
        deviceToken: "rotated",
        scopes: wanted,
      });
      await until(() => client.state.connection[held]);
      expect(client.state.connection.scopes).toEqual(expect.arrayContaining(wanted));
      client.stop();
    });
  }

  it("F-274: a workspace change reads the gateway once and publishes no bot list of its own", async () => {
    const fake = new AccountsGateway();
    fake.gateway.handlers["agents.update"] = () => ({ ok: true, agentId: "otto" });
    const { client } = await accountsClient({ gateway: fake, scopes: [...ADMIN_SCOPES] });
    const before = fake.gateway.calls("agents.list").length;
    const bots = client.state.bots;
    await client.setBotWorkspace("otto", "/srv/claw/otto-2");
    expect(fake.gateway.calls("agents.list").length - before).toBe(1);
    expect(client.state.bots).toBe(bots);
    client.stop();
  });

  it("F-046: a session refuses a node choice that names no machine, and sends nothing", async () => {
    const sent: unknown[] = [];
    const client = {
      setCommandMachine: (...args: unknown[]) => {
        sent.push(args);
        return Promise.resolve();
      },
      withdraw: () => {},
    } as unknown as ClawtrateClient;
    const session = createBridgeSession(client);
    await expect(
      session.apply({
        type: "setCommandMachine",
        botId: "otto",
        host: "node",
        nodeId: null,
        baseHash: "c1",
      }),
    ).rejects.toThrow("invalid machine");
    expect(sent).toEqual([]);
    await session.apply({
      type: "setCommandMachine",
      botId: "otto",
      host: "gateway",
      nodeId: null,
      baseHash: "c1",
    });
    expect(sent).toEqual([["otto", { host: "gateway" }, "c1"]]);
    session.dispose();
  });

  it("F-156 F-157: a write read first is not sent once its viewer has closed", async () => {
    const fake = new AccountsGateway();
    const fileRead = deferred<unknown>();
    fake.gateway.handlers["exec.approvals.get"] = () => fileRead.promise;
    fake.gateway.handlers["exec.approvals.set"] = () => ({});
    const { client } = await accountsClient({ gateway: fake, scopes: [...ADMIN_SCOPES] });
    const viewer = createBridgeSession(client);
    const write = viewer.apply({
      type: "setMachineDefaults",
      machineId: "gateway",
      choice: "always",
      expectedHash: "h1",
    });
    await until(() => fake.gateway.calls("exec.approvals.get").length === 1);
    viewer.dispose();
    fileRead.resolve({ path: "/p", exists: true, hash: "h1", file: { version: 1 } });
    await expect(write).rejects.toThrow("The request was withdrawn.");
    expect(fake.gateway.calls("exec.approvals.set")).toEqual([]);
    client.stop();

    // This device's own rename below admin reads its record first: the same holds.
    const devices = new AccountsGateway();
    const listRead = deferred<unknown>();
    devices.gateway.handlers["device.pair.list"] = () => listRead.promise;
    devices.gateway.handlers["device.pair.rename"] = () => ({});
    const scopes = [READ_SCOPE, PAIRING_SCOPE];
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: null, address: true }),
      [tokenKey(URL_A)]: JSON.stringify({
        token: "device-token",
        grantedScopes: scopes,
        heldScopes: scopes,
        pairingHeld: true,
      }),
    });
    const own = new ClawtrateClient(testHost(devices.gateway, storage), FAST);
    await own.start();
    await until(() => own.state.connection.scopes.includes(PAIRING_SCOPE));
    const second = createBridgeSession(own);
    const rename = second.apply({
      type: "renameDevice",
      deviceId: own.state.connection.deviceId!,
      name: "Desk",
    });
    await until(() => devices.gateway.calls("device.pair.list").length === 1);
    second.dispose();
    listRead.resolve({
      paired: [{ deviceId: own.state.connection.deviceId, role: "operator" }],
    });
    await expect(rename).rejects.toThrow("The request was withdrawn.");
    expect(devices.gateway.calls("device.pair.rename")).toEqual([]);
    own.stop();
  });

  it("F-157: the bridge takes the request by name and nothing else", () => {
    expect(parseBridgeCommand({ type: "requestAccess", tier: "pairing" })).toEqual({
      type: "requestAccess",
      tier: "pairing",
    });
    expect(parseBridgeCommand({ type: "requestAccess", tier: "everything" })).toEqual({
      type: "requestAccess",
    });
    expect(() =>
      parseBridgeCommand({ type: "setMachineDefaults", machineId: "gateway", choice: "maybe" }),
    ).toThrow("invalid choice");
    // Path text the gateway may accept is forwarded as it is.
    expect(
      parseBridgeCommand({ type: "setBotWorkspace", botId: "otto", path: "folder\twith tab" }),
    ).toEqual({ type: "setBotWorkspace", botId: "otto", path: "folder\twith tab" });
  });
});
