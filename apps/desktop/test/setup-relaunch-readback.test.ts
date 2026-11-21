// A scope upgrade on a gateway set up on this computer, after the app was
// relaunched (docs/design/setup.md §9): the connection keeps the profile the
// host's look found, so a fresh setup controller, which has looked at nothing
// in this run, establishes that profile's endpoint and version again and reads
// back through it before the rotated token is kept. Without that proof nothing
// new is kept. A fake runner stands in for `openclaw`, and the core's fake
// gateway for the gateway.

import { ClawtrateClient, type ReadBackRequest } from "@clawtrate/core";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deferred,
  FakeGateway,
  helloOk,
  memoryStorage,
  testHost,
  tokenKey,
  until,
} from "../../../packages/core/test/fake-gateway.ts";
import { approvalInstructionsFor } from "../src/host/runtime.ts";
import { SetupController } from "../src/setup/controller.ts";
import { checkRequest, type ProgramRequest, type ProgramResult } from "../src/setup/programs.ts";
import { productionWorld, type LookWorld } from "../src/setup/world.ts";
import type { Identify } from "../../../tools/dev-gateway/src/state-guard.ts";
import { authJson, qrJson, statusJson, VERSION_LINE } from "./fixtures/openclaw-outputs.ts";

const PORT = 19941;
const URL = `ws://127.0.0.1:${PORT}`;
const CODE = "Xq3v8Lw0eXk2Rj9TaNf5Hc1UbYm7Pd4GsZi6Ko2EaVr";
const GATEWAY = "a".repeat(64);
const REQUEST = "0d0d0d0d-0000-4000-8000-0000000000b1";
const INTERACTIVE = ["operator.read", "operator.write", "operator.approvals", "operator.questions"];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clawtrate-relaunch-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function world(): LookWorld {
  const program = join(dir, "bin/openclaw");
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(program, "#!/bin/sh\nexit 1\n");
  chmodSync(program, 0o755);
  mkdirSync(join(dir, "home"), { recursive: true });
  const home = productionWorld({ home: join(dir, "home"), appData: dir, platform: "darwin" });
  return { ...home, candidates: [program], profiles: [home.profiles[0]!], deep: false };
}

const IDENTITY = JSON.stringify({ deviceId: GATEWAY, publicKey: "gateway-public-key" });
const recordList = (scopes: string[]) =>
  JSON.stringify({
    pending: [],
    paired: [
      {
        deviceId: "device-1",
        publicKey: "public-key",
        clientId: "gateway-client",
        clientMode: "ui",
        role: "operator",
        roles: ["operator"],
        scopes,
        tokens: [{ role: "operator", scopes }],
      },
    ],
  });

/** One computer: its runner and gateway, and the app's storage, shared by every launch. */
function computer() {
  const requests: ProgramRequest[] = [];
  const replies: Record<string, Partial<ProgramResult>> = {
    "--version": { stdout: VERSION_LINE },
    "gateway status --json": { stdout: statusJson({ port: PORT }) },
    "config get gateway.auth.mode --json": { stdout: authJson() },
    [`qr --json --voice-node --url ${URL}`]: { stdout: qrJson(URL, CODE, Date.now() + 600_000) },
    [`gateway call gateway.identity.get --expect-url ${URL} --json`]: { stdout: IDENTITY },
    [`gateway call device.pair.list --expect-url ${URL} --json`]: {
      stdout: recordList(INTERACTIVE),
    },
  };
  const run = async (request: ProgramRequest): Promise<ProgramResult> => {
    checkRequest(request);
    requests.push(request);
    const reply = replies[request.args.join(" ")];
    return {
      exitCode: 0,
      stdout: "",
      timedOut: false,
      tooLarge: false,
      failed: false,
      ...(reply ?? { exitCode: 1 }),
    };
  };
  // 4242 is the gateway the look found; 4343 another live process that can take its port.
  const identify: Identify = (pid) =>
    pid === 4242 || pid === 4343
      ? { state: "alive", identity: `Mon Nov 16 21:27:01 2026 ${pid}` }
      : { state: "exited", how: "absent" };
  const gateway = new FakeGateway();
  gateway.connectReply = (params) => {
    const { scopes, auth } = params as {
      scopes: string[];
      auth?: { bootstrapToken?: string; deviceToken?: string };
    };
    if (auth?.bootstrapToken === CODE)
      return { ok: true, payload: helloOk(["operator.read"], "device-token") };
    // More than read only to the rotated token: an upgrade shows only on the staged token's socket.
    const granted = auth?.deviceToken === "rotated-token" ? scopes : ["operator.read"];
    return { ok: true, payload: helloOk(granted, auth?.deviceToken ?? "device-token") };
  };
  gateway.handlers["gateway.identity.get"] = () => ({
    deviceId: GATEWAY,
    publicKey: "gateway-public-key",
  });
  gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: REQUEST });
  const approval = deferred<unknown>();
  gateway.handlers["device.scopes.waitUpgrade"] = () => approval.promise;
  const storage = memoryStorage();
  const theWorld = world();

  /** One launch of the app: a client and a setup controller of its own, nothing carried over. */
  async function launch() {
    let setup: SetupController | null = null;
    const asked: ReadBackRequest[] = [];
    const client = new ClawtrateClient(
      {
        ...testHost(gateway, storage),
        approvalInstructions: approvalInstructionsFor(null, (url) => setup?.placeFor(url) ?? null),
        readBack: async (url, request) => {
          asked.push(request);
          return setup ? setup.readBack(url, request) : null;
        },
      },
      { reconnect: { initialMs: 20, maxMs: 40 } },
    );
    setup = new SetupController({
      client,
      open: async () => ({ world: theWorld, run, identify }),
      stopPrograms: () => {},
      confirm: async () => true,
    });
    await client.start();
    return { client, setup, asked };
  }

  const approve = () =>
    approval.resolve({
      status: "approved",
      requestId: REQUEST,
      deviceToken: "rotated-token",
      scopes: INTERACTIVE,
    });
  return { requests, replies, storage, gateway, launch, approve };
}

/** Set up on this computer in a first launch, then quit. */
async function setUpHere(c: ReturnType<typeof computer>) {
  const first = await c.launch();
  await first.setup.look();
  await first.setup.connect();
  await until(() => first.setup.current.phase === "done");
  first.client.stop();
}

describe("F-500: after a relaunch, a gateway set up on this computer is still read back", () => {
  it("the kept profile gives the command, a fresh look establishes the endpoint, and only then is the token kept", async () => {
    const c = computer();
    await setUpHere(c);
    // The connection is kept with the profile the look found it for.
    expect(JSON.parse(c.storage.data.get("connection")!)).toMatchObject({
      url: URL,
      here: { profile: "default" },
    });
    const later = await c.launch();
    await until(() => later.client.state.connection.gatewayId === GATEWAY);
    await later.client.requestAccess();
    await until(() => later.client.state.connection.upgrade.status === "pending");
    expect(later.client.state.connection.upgrade).toMatchObject({
      approveTitle: "Waiting for approval on this computer.",
      approveNote: "In Terminal on this computer, run this for the default profile:",
      approveCommand: `openclaw devices approve ${REQUEST}`,
    });
    const before = c.requests.length;
    c.approve();
    await until(() => later.client.state.connection.canWrite);
    expect(later.asked).toEqual([{ expected: GATEWAY, here: { profile: "default" } }]);
    const run = c.requests.slice(before).map((request) => request.args.join(" "));
    // The endpoint and version first, then the identity, then the list.
    expect(run.slice(0, 1)).toEqual(["--version"]);
    expect(run).toContain("gateway status --json");
    const identityAt = run.indexOf(`gateway call gateway.identity.get --expect-url ${URL} --json`);
    const listAt = run.indexOf(`gateway call device.pair.list --expect-url ${URL} --json`);
    expect(identityAt).toBeGreaterThan(0);
    expect(listAt).toBeGreaterThan(identityAt);
    // The listener is checked between the two reads and again after the list.
    expect(run.slice(identityAt, listAt)).toContain("gateway status --json");
    expect(run.slice(listAt)).toContain("gateway status --json");
    expect(JSON.parse(c.storage.data.get(tokenKey(URL))!).token).toBe("rotated-token");
    later.client.stop();
  });

  it("in the same launch too, a version this build doesn't support now gives no read and keeps nothing", async () => {
    const c = computer();
    // Set up and approve in one launch: the setup's own look is still in memory.
    const later = await c.launch();
    await later.setup.look();
    await later.setup.connect();
    await until(() => later.setup.current.phase === "done");
    const saved = c.storage.data.get(tokenKey(URL));
    await until(() => later.client.state.connection.gatewayId === GATEWAY);
    await later.client.requestAccess();
    await until(() => later.client.state.connection.upgrade.status === "pending");
    c.replies["gateway status --json"] = {
      stdout: statusJson({ port: PORT, answered: "2026.9.1" }),
    };
    const before = c.requests.length;
    c.approve();
    await until(() => later.client.state.connection.status === "error");
    expect(later.client.state.connection.upgrade.status).toBe("identity-unread");
    expect(c.requests.slice(before).some((request) => request.args.includes("call"))).toBe(false);
    expect(c.storage.data.get(tokenKey(URL))).toBe(saved);
    later.client.stop();
  });

  it("when the fresh look finds the profile's gateway elsewhere, nothing is read and nothing new is kept", async () => {
    const c = computer();
    await setUpHere(c);
    const saved = c.storage.data.get(tokenKey(URL));
    const later = await c.launch();
    await until(() => later.client.state.connection.gatewayId === GATEWAY);
    await later.client.requestAccess();
    await until(() => later.client.state.connection.upgrade.status === "pending");
    // The profile's gateway now listens on another port.
    c.replies["gateway status --json"] = { stdout: statusJson({ port: PORT + 1 }) };
    const before = c.requests.length;
    c.approve();
    await until(() => later.client.state.connection.status === "error");
    expect(later.client.state.connection.upgrade.status).toBe("identity-unread");
    expect(c.requests.slice(before).some((request) => request.args.includes("call"))).toBe(false);
    expect(c.storage.data.get(tokenKey(URL))).toBe(saved);
    later.client.stop();
  });

  for (const during of ["gateway.identity.get", "device.pair.list"] as const) {
    it(`another process taking the port after ${during}, while the old one stays alive, discards the read and keeps nothing new`, async () => {
      const c = computer();
      await setUpHere(c);
      const saved = c.storage.data.get(tokenKey(URL));
      const later = await c.launch();
      await until(() => later.client.state.connection.gatewayId === GATEWAY);
      await later.client.requestAccess();
      await until(() => later.client.state.connection.upgrade.status === "pending");
      // That read answers as before; from then on the port's listener is process 4343.
      const key = `gateway call ${during} --expect-url ${URL} --json`;
      const reply = c.replies[key]!;
      Object.defineProperty(c.replies, key, {
        get: () => {
          c.replies["gateway status --json"] = {
            stdout: statusJson({ port: PORT, listenerPid: 4343 }),
          };
          return reply;
        },
      });
      c.approve();
      await until(() => later.client.state.connection.status === "error");
      expect(later.client.state.connection.upgrade.status).toBe("unconfirmed");
      expect(c.storage.data.get(tokenKey(URL))).toBe(saved);
      // A change before the list: the list was never asked of the new listener.
      if (during === "gateway.identity.get")
        expect(c.requests.some((r) => r.args.includes("device.pair.list"))).toBe(false);
      later.client.stop();
    });
  }

  it("Review and Look again look for the saved profile alone, at its saved address", async () => {
    const c = computer();
    await setUpHere(c);
    const later = await c.launch();
    // The same look for the saved profile finds its gateway at the saved address.
    await later.setup.reviewOf({ profile: "default", url: URL });
    expect(later.setup.current).toMatchObject({ phase: "found", look: { outcome: "running" } });
    // Another profile is never looked at for it, even where the default profile's gateway runs.
    const asked = c.requests.length;
    await later.setup.reviewOf({ profile: "clawtrate", url: URL });
    expect(later.setup.current.look?.outcome).not.toBe("running");
    expect(
      c.requests
        .slice(asked)
        .some((r) => !r.args.includes("clawtrate") && r.args.includes("status")),
    ).toBe(false);
    // The saved profile's gateway now elsewhere: this changed since it was set up.
    c.replies["gateway status --json"] = { stdout: statusJson({ port: PORT + 1 }) };
    await later.setup.reviewOf({ profile: "default", url: URL });
    expect(later.setup.current).toMatchObject({ phase: "failed", failure: { kind: "changed" } });
    later.client.stop();
  });
});
