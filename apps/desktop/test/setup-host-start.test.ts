// How a host starts when setup must be sandboxed (docs/development/setup.md):
// the launch is resolved before the single-instance lock and the runtime; a
// sandboxed start never resumes the gateway its data folder remembers,
// whatever its address, while a gateway chosen in Advanced still connects;
// and the web host's setup look needs its sandbox and keeps its data there.

import { ClawtrateClient } from "@clawtrate/core";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FakeGateway,
  helloOk,
  memoryStorage,
  testHost,
  until,
} from "../../../packages/core/test/fake-gateway.ts";
import { startHostRuntime } from "../src/host/runtime.ts";
import { setupLookChoice } from "../src/web-host/setup-look.ts";
import { desktopStartup, webStartup } from "../src/setup/startup.ts";
import { resolveSetupLaunch } from "../src/setup/sandbox.ts";
import { vi } from "vitest";
import * as fake from "./fixtures/sandbox.ts";

// Every fake home and run folder goes, whether the test passed or not.
afterEach(() => fake.removeBases());

/** Another gateway this device was connected to before: never one a sandboxed start reopens. */
const SAVED = "ws://127.0.0.1:19940";
const CHOSEN = "ws://127.0.0.1:19960";

describe("a sandboxed host's start", () => {
  it("never resumes the saved gateway, and a gateway chosen in Advanced still connects", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: true,
      payload: helloOk(["operator.read"], "device-token"),
    });
    const storage = memoryStorage({ connection: JSON.stringify({ url: SAVED, token: null }) });
    const client = new ClawtrateClient(testHost(gateway, storage));
    await client.start({ resume: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gateway.sockets).toHaveLength(0);
    expect(client.state.connection.status).toBe("idle");
    // The production route a person chooses: Advanced, an address and a token.
    await client.connect({ url: CHOSEN, token: "shared-token" });
    await until(() => client.state.connection.status === "connected");
    expect(gateway.sockets.map((socket) => socket.url)).toEqual([CHOSEN]);
    client.stop();
  });

  it("a person's start still resumes it", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: true,
      payload: helloOk(["operator.read"], "device-token"),
    });
    const storage = memoryStorage({ connection: JSON.stringify({ url: SAVED, token: null }) });
    const client = new ClawtrateClient(testHost(gateway, storage));
    await client.start();
    await until(() => gateway.sockets.length > 0);
    expect(gateway.sockets[0]!.url).toBe(SAVED);
    client.stop();
  });

  it("the host runtime passes it on: a data folder that remembers a gateway opens nothing", async () => {
    const at = fake.world();
    const dataDir = join(at.base, "data");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, "state.json"),
      JSON.stringify({ connection: JSON.stringify({ url: SAVED, token: null }) }),
    );
    const runtime = await startHostRuntime({
      kind: "desktop",
      displayName: "Clawtrate Test",
      dataDir,
      devGateway: null,
      resume: false,
    });
    expect(runtime.client.state.connection.status).toBe("idle");
    expect(runtime.client.state.connection.gatewayUrl ?? null).toBeNull();
    runtime.client.stop();
  });

  it("S8: sandboxed and refused startup never resolve an independent gateway or ordinary data", async () => {
    const at = fake.world();
    const run = fake.instance({
      home: at.home,
      checkout: at.checkout,
      name: "su1-test",
      run: fake.runId("a"),
    });
    const folder = fake.runFolder(join(at.base, "runs"), { instance: run.name, run: run.run });
    const context = { platform: process.platform, home: at.home, uid: at.uid };
    const launch = (file: string | null) =>
      resolveSetupLaunch({
        packaged: false,
        env: {},
        switches: (name) => name === "clawtrate-setup-sandbox",
        switchValue: (name) => (name === "clawtrate-setup-sandbox" ? (file ?? "") : ""),
        context,
      });
    const sandboxed = launch(folder.file);
    const refused = launch(null);
    expect([sandboxed.kind, refused.kind]).toEqual(["sandbox", "refused"]);
    for (const resolved of [sandboxed, refused]) {
      // A development gateway, an auto-connect setting and the ordinary data folder, all on offer.
      const devConnection = vi.fn(() => ({ url: SAVED, token: "dev-token", instance: "su1-test" }));
      const autoConnectDev = vi.fn(() => true);
      const privateData = vi.fn(() => fake.base());
      const startup = desktopStartup(resolved, {
        packaged: false,
        devConnection,
        autoConnectDev,
        launchData: () => null,
        privateData,
      });
      expect(devConnection).not.toHaveBeenCalled();
      expect(autoConnectDev).not.toHaveBeenCalled();
      expect(startup).toMatchObject({ devGateway: null, autoConnectDev: false, resume: false });
      expect(startup.userData).toBe(
        resolved.kind === "sandbox"
          ? join(folder.root, "app-data")
          : privateData.mock.results[0]?.value,
      );
      // And a data folder that remembers a gateway, started that way, opens nothing.
      const dataDir = join(startup.userData!, "gateway");
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(
        join(dataDir, "state.json"),
        JSON.stringify({ connection: JSON.stringify({ url: SAVED, token: null }) }),
      );
      const runtime = await startHostRuntime({
        kind: "desktop",
        displayName: "Clawtrate Test",
        dataDir,
        ...startup,
      });
      expect(runtime.client.state.connection).toMatchObject({ status: "idle", gatewayUrl: null });
      runtime.client.stop();
    }
    // The web host's setup look: no development gateway, no ordinary data folder.
    const chosen = setupLookChoice({ "setup-look": true, "setup-sandbox": folder.file }, context);
    if (chosen.kind !== "sandbox") throw new Error(chosen.kind);
    const devConnection = vi.fn(() => null);
    const dataDir = vi.fn(() => "/ordinary");
    expect(webStartup(chosen, { devConnection, dataDir, autoConnectDev: true })).toEqual({
      dataDir: join(folder.root, "app-data"),
      devGateway: null,
      autoConnectDev: false,
      resume: false,
    });
    expect(devConnection).not.toHaveBeenCalled();
    expect(dataDir).not.toHaveBeenCalled();
  });

  it("a refused start keeps the data folder its launch named, and still no gateway", () => {
    const refused = resolveSetupLaunch({
      packaged: false,
      env: {},
      switches: () => false,
      switchValue: () => "",
      context: { platform: process.platform, home: "/nowhere", uid: null },
    });
    expect(refused.kind).toBe("refused");
    const devConnection = vi.fn(() => ({ url: SAVED, token: "dev-token", instance: "su1-test" }));
    const privateData = vi.fn(() => "/fresh");
    const startup = (launchData: string | null) =>
      desktopStartup(refused, {
        packaged: false,
        devConnection,
        autoConnectDev: () => true,
        launchData: () => launchData,
        privateData,
      });
    // A harness's own --user-data-dir stays the data folder, so Chromium's files land where it looks.
    expect(startup("/harness/profile")).toEqual({
      userData: "/harness/profile",
      devGateway: null,
      autoConnectDev: false,
      resume: false,
    });
    expect(privateData).not.toHaveBeenCalled();
    expect(startup(null).userData).toBe("/fresh");
    expect(devConnection).not.toHaveBeenCalled();
    const main = readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8");
    expect(main).toContain('launchData: () => switchValue("user-data-dir") || null,');
  });

  it("the desktop host resolves the launch before its lock and its runtime, and resumes only a person's app", () => {
    const main = readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8");
    const resolved = main.indexOf("resolveSetupLaunch({");
    const chosen = main.indexOf("desktopStartup(SETUP,");
    const placed = main.indexOf('app.setPath("userData", STARTUP.userData)');
    expect(resolved).toBeGreaterThan(-1);
    expect(resolved).toBeLessThan(chosen);
    expect(chosen).toBeLessThan(placed);
    expect(placed).toBeLessThan(main.indexOf("app.requestSingleInstanceLock()"));
    expect(placed).toBeLessThan(main.indexOf("await startHostRuntime("));
    expect(main).toContain("devGateway: STARTUP.devGateway,");
    expect(main).toContain("resume: STARTUP.resume,");
    const web = readFileSync(new URL("../src/web-host/main.ts", import.meta.url), "utf8");
    expect(web.indexOf("setupLookChoice(values")).toBeLessThan(
      web.indexOf("webStartup(setupLook,"),
    );
    expect(web.indexOf("webStartup(setupLook,")).toBeLessThan(
      web.indexOf("await startHostRuntime("),
    );
    expect(web).toContain("resume: start.resume,");
  });
});

describe("the web host's setup look", () => {
  function sandbox() {
    const at = fake.world();
    const run = fake.instance({
      home: at.home,
      checkout: at.checkout,
      name: "su1-test",
      run: fake.runId("a"),
    });
    const folder = fake.runFolder(join(at.base, "runs"), { instance: run.name, run: run.run });
    return {
      ...folder,
      context: { platform: process.platform, home: at.home, uid: at.uid },
    };
  }

  it("is off without --setup-look, whatever --setup-sandbox says", () => {
    const s = sandbox();
    expect(setupLookChoice({ "setup-sandbox": s.file }, s.context)).toEqual({ kind: "off" });
  });

  it("needs --setup-sandbox, refuses --data-dir beside it, and keeps its data in the run folder", () => {
    const s = sandbox();
    const missing = setupLookChoice({ "setup-look": true }, s.context);
    expect(missing).toEqual({
      kind: "refused",
      message:
        "The look on this computer refused to start: this run must look in a sandbox and was given none.",
    });
    expect(
      setupLookChoice(
        { "setup-look": true, "setup-sandbox": s.file, "data-dir": "/tmp/x" },
        s.context,
      ).kind,
    ).toBe("refused");
    const chosen = setupLookChoice({ "setup-look": true, "setup-sandbox": s.file }, s.context);
    expect(chosen.kind === "sandbox" && chosen.dataDir).toBe(join(s.root, "app-data"));
  });

  it("refuses a description that doesn't pass, in fixed words", () => {
    const s = sandbox();
    const refused = setupLookChoice(
      { "setup-look": true, "setup-sandbox": join(s.root, "other.json") },
      s.context,
    );
    expect(refused).toEqual({
      kind: "refused",
      message:
        "The look on this computer refused to start: the sandbox's description is not in a private folder of the account's under the system's temporary root, reached without links, or has the wrong shape.",
    });
  });
});
