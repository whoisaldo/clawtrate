// A1 and A3: what a host connects to, and what it tells people to run.
import { createFileStore } from "@clawtrate/core/node";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  childFor,
  deadProcess,
  liveProcess,
  OTHER_CHECKOUT,
  seedInstance,
  stopChildren,
  type Proc,
} from "../../../tools/dev-gateway/test/fixtures.ts";
import WebSocket, { WebSocketServer } from "ws";
import {
  approvalInstructionsFor,
  DEV_GATEWAY_URL,
  devRunDir,
  readDevConnection,
  SavedGatewayRefusedError,
  startHostRuntime,
} from "../src/host/runtime.ts";
import { startWebHost } from "../src/web-host/server.ts";
import { NAMED_PORT_BLOCK, NAMED_PORT_RANGE } from "../../../tools/dev-gateway/src/instance.ts";
import { portFree } from "../../../tools/dev-gateway/src/registry.ts";

async function until(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// A stand-in for some other, private gateway. It only counts connection attempts.
let other: WebSocketServer;
let otherUrl = "";
let attempts = 0;

beforeAll(async () => {
  other = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  other.on("connection", (socket) => {
    attempts += 1;
    socket.close();
  });
  await new Promise((resolve) => other.once("listening", resolve));
  otherUrl = `ws://127.0.0.1:${(other.address() as AddressInfo).port}`;
});

afterAll(() => {
  other.close();
  stopChildren();
});

async function dataDirRemembering(url: string): Promise<string> {
  const dataDir = mkdtempSync(join(tmpdir(), "clawtrate-runtime-"));
  await createFileStore(join(dataDir, "state.json")).set(
    "connection",
    JSON.stringify({ url, token: null }),
  );
  return dataDir;
}

const devGateway = { url: DEV_GATEWAY_URL, token: "dev-token", instance: null };

describe("token-free development mode (A1)", () => {
  it("refuses to start when the data directory remembers another gateway", async () => {
    const dataDir = await dataDirRemembering(otherUrl);
    await expect(
      startHostRuntime({
        kind: "web",
        displayName: "Clawtrate Web",
        dataDir,
        devGateway,
        autoConnectDev: true,
        devOnly: true,
        recheckDevGateway: () => devGateway,
      }),
    ).rejects.toBeInstanceOf(SavedGatewayRefusedError);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(attempts).toBe(0);
  });

  it("never serves another gateway's data to an unauthenticated bridge", async () => {
    // Even if a runtime were built around a saved private gateway, the client
    // refuses it before opening a socket.
    const dataDir = await dataDirRemembering(otherUrl);
    const runtime = await startHostRuntime({
      kind: "web",
      displayName: "Clawtrate Web",
      dataDir,
      devGateway,
      recheckDevGateway: () => devGateway,
    });
    expect(runtime.client.state.connection.status).not.toBe("idle");
    runtime.client.stop();
    const { ClawtrateClient } = await import("@clawtrate/core");
    const { createNodeHost } = await import("@clawtrate/core/node");
    const guarded = new ClawtrateClient(
      createNodeHost({
        dataDir,
        client: { displayName: "Clawtrate Web", version: "test", platform: "test" },
      }),
      { allowGatewayUrl: (url) => url === DEV_GATEWAY_URL },
    );
    await guarded.start();
    const before = attempts;
    const staticDir = mkdtempSync(join(tmpdir(), "clawtrate-static-"));
    writeFileSync(join(staticDir, "index.html"), "<!doctype html>");
    const host = startWebHost({
      runtime: { client: guarded, info: runtime.info, policy: {} },
      staticDir,
      host: "127.0.0.1",
      port: 0,
      accessToken: null,
    });
    await new Promise((resolve) => host.server.once("listening", resolve));
    const port = (host.server.address() as AddressInfo).port;
    const hello = await new Promise<{
      state: { connection: { status: string; error: { code: string } | null }; bots: unknown[] };
    }>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
      socket.once("message", (data) => {
        resolve(JSON.parse(String(data)));
        socket.close();
      });
      socket.once("error", reject);
    });
    expect(hello.state.bots).toEqual([]);
    expect(hello.state.connection.status).toBe("error");
    expect(hello.state.connection.error?.code).toBe("GATEWAY_NOT_ALLOWED");
    expect(attempts).toBe(before);
    guarded.stop();
    await host.close();
  });
});

/**
 * A checkout whose dev tooling started `instance` under a temporary home: the
 * instance's marker with a live stand-in gateway, this checkout's run file and
 * connection file. Pieces can be changed to model stale or edited state.
 */
function provenCheckout(
  instance: string | null,
  options: {
    gateway?: Proc;
    checkout?: string;
    connection?: Record<string, unknown>;
    port?: number;
  } = {},
) {
  const home = mkdtempSync(join(tmpdir(), "clawtrate-home-"));
  const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "clawtrate-checkout-")));
  const runDir = devRunDir(repoRoot, instance);
  const gateway = options.gateway ?? liveProcess();
  const port = instance === null ? 19001 : (options.port ?? 19240);
  const { runId, stateDir } = seedInstance(home, instance, {
    gateway,
    checkout: options.checkout ?? repoRoot,
    runRoot: join(repoRoot, "tools/dev-gateway/.run"),
    ...(instance === null ? {} : { marker: { gatewayPort: port, providerPort: port + 10 } }),
  });
  // The run file records the checkout that started it; edit it back to this one.
  writeFileSync(
    join(runDir, "state.json"),
    JSON.stringify({
      runId,
      instance,
      checkout: repoRoot,
      gatewayPort: port,
      providerPort: port + 10,
      startedAt: "",
    }),
  );
  const url = `ws://127.0.0.1:${port}`;
  writeFileSync(
    join(runDir, "connection.json"),
    JSON.stringify({ url, token: "t", instance, runId, ...options.connection }),
  );
  const read = () => readDevConnection(repoRoot, { instance, home });
  return { home, repoRoot, runDir, stateDir, runId, url, gateway, read };
}

describe("development eligibility needs proof, not two agreeing files (A1)", () => {
  it("accepts the selected instance when marker, run, checkout, port and live gateway agree", () => {
    for (const instance of [null, "alpha"]) {
      const { url, read } = provenCheckout(instance);
      expect(read()).toEqual({ url, token: "t", instance });
    }
    expect(devRunDir("/repo", "alpha")).toBe("/repo/tools/dev-gateway/.run/instances/alpha");
    expect(devRunDir("/repo")).toBe("/repo/tools/dev-gateway/.run");
  });

  it("refuses a run file and a connection file that agree when there is no marker", () => {
    const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "clawtrate-checkout-")));
    const runDir = devRunDir(repoRoot, "alpha");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "state.json"), JSON.stringify({ gatewayPort: 19200 }));
    writeFileSync(
      join(runDir, "connection.json"),
      JSON.stringify({ instance: "alpha", url: "ws://127.0.0.1:19200", token: "probe" }),
    );
    const home = mkdtempSync(join(tmpdir(), "clawtrate-home-"));
    expect(readDevConnection(repoRoot, { instance: "alpha", home })).toBeNull();
  });

  it("refuses anything stale, incomplete, linked or mismatched", () => {
    const refused = (label: string, read: () => unknown) => expect(read(), label).toBeNull();
    refused("gateway gone", provenCheckout("alpha", { gateway: deadProcess() }).read);
    const reused = { pid: liveProcess().pid, identity: "Thu Jan  1 00:00:00 1970" };
    refused("gateway pid reused", provenCheckout("alpha", { gateway: reused }).read);
    const unknowable = provenCheckout("alpha");
    refused("gateway alive but its lookup failed", () =>
      readDevConnection(unknowable.repoRoot, {
        instance: "alpha",
        home: unknowable.home,
        identify: () => ({ state: "unknown", reason: "ps failed" }),
      }),
    );
    refused(
      "another checkout's marker",
      provenCheckout("alpha", { checkout: OTHER_CHECKOUT }).read,
    );
    refused(
      "connection file of another run",
      provenCheckout("alpha", { connection: { runId: "f".repeat(48) } }).read,
    );
    refused(
      "connection file names another port",
      provenCheckout("alpha", { connection: { url: "ws://127.0.0.1:19260" } }).read,
    );
    refused(
      "connection file names a remote host",
      provenCheckout(null, { connection: { url: "ws://gateway.example.com:19001" } }).read,
    );

    const linkedConnection = provenCheckout("alpha");
    const real = join(linkedConnection.runDir, "real.json");
    renameSync(join(linkedConnection.runDir, "connection.json"), real);
    symlinkSync(real, join(linkedConnection.runDir, "connection.json"));
    refused("connection file is a link", linkedConnection.read);

    const linkedState = provenCheckout("alpha");
    const moved = `${linkedState.stateDir}-real`;
    renameSync(linkedState.stateDir, moved);
    symlinkSync(moved, linkedState.stateDir);
    refused("state folder is a link", linkedState.read);

    const otherInstance = provenCheckout("alpha");
    expect(
      readDevConnection(otherInstance.repoRoot, { instance: "beta", home: otherInstance.home }),
    ).toBeNull();
  });

  it("rejects an instance name that is not one before reading anything", () => {
    for (const name of ["../alpha", "Alpha", "default", "dev", ""]) {
      expect(() => readDevConnection("/nonexistent", { instance: name })).toThrow(
        /refusing instance name/,
      );
    }
  });

  it("without a token, proves the gateway again before every connection", async () => {
    for (const instance of [null, "alpha"]) {
      const proven = provenCheckout(instance);
      const devGateway = proven.read()!;
      expect(devGateway).not.toBeNull();
      const runtime = await startHostRuntime({
        kind: "web",
        displayName: "Clawtrate Web",
        dataDir: mkdtempSync(join(tmpdir(), "clawtrate-runtime-")),
        devGateway,
        devOnly: true,
        recheckDevGateway: proven.read,
      });
      // With how a command reaches that instance, for the commands the interface shows.
      expect(runtime.info.devGateway).toEqual({
        url: proven.url,
        cli: instance === null ? "openclaw --dev" : "openclaw --profile clawtrate-dev-alpha",
      });
      expect(runtime.policy.devGateway).toEqual({ url: proven.url, token: "t" });
      const before = attempts;
      // Any other gateway, including the default instance's for a named one.
      for (const url of [otherUrl, instance === null ? "ws://127.0.0.1:19240" : DEV_GATEWAY_URL]) {
        await expect(runtime.client.connect({ url, token: null })).rejects.toThrow(/not allowed/i);
      }
      // Its own gateway once that process is gone: the next (re)connection is refused
      // before a socket is opened, so a port someone else takes over is never trusted.
      childFor(proven.gateway.pid).kill("SIGTERM");
      await new Promise((resolve) => childFor(proven.gateway.pid).once("exit", resolve));
      expect(proven.read()).toBeNull();
      await expect(runtime.client.connect({ url: proven.url, token: null })).rejects.toThrow(
        /not allowed/i,
      );
      expect(attempts).toBe(before);
      runtime.client.stop();
    }
  });

  it("an automatic retry after the proof is lost opens nothing, with the desktop and the token-free wiring", async () => {
    for (const mode of ["desktop", "token-free"] as const) {
      // A listener on the instance's port that is not (or no longer) its gateway.
      let port = NAMED_PORT_RANGE.last + 1 - NAMED_PORT_BLOCK;
      while (!(await portFree(port))) port -= NAMED_PORT_BLOCK;
      const listener = new WebSocketServer({ host: "127.0.0.1", port });
      await new Promise((resolve) => listener.once("listening", resolve));
      let connections = 0;
      listener.on("connection", (socket) => {
        connections += 1;
        socket.terminate();
      });
      const proven = provenCheckout("alpha", { port });
      const devGateway = proven.read()!;
      expect(devGateway).not.toBeNull();
      const runtime = await startHostRuntime({
        kind: mode === "desktop" ? "desktop" : "web",
        displayName: "Clawtrate",
        dataDir: mkdtempSync(join(tmpdir(), "clawtrate-runtime-")),
        devGateway,
        autoConnectDev: true,
        recheckDevGateway: proven.read,
        ...(mode === "token-free" ? { devOnly: true } : {}),
      });
      await until(() => connections === 1);
      // The gateway process is gone; the protocol's own retry must ask again.
      childFor(proven.gateway.pid).kill("SIGTERM");
      await new Promise((resolve) => childFor(proven.gateway.pid).once("exit", resolve));
      await until(
        () => runtime.client.state.connection.error?.code === "GATEWAY_NOT_ALLOWED",
        8000,
      );
      await new Promise((resolve) => setTimeout(resolve, 2500));
      expect(connections, mode).toBe(1);
      expect(runtime.client.state.connection.retryAt).toBeNull();
      runtime.client.stop();
      await new Promise((resolve) => listener.close(resolve));
    }
  }, 30_000);

  it("does not start token-free without a proven development gateway", async () => {
    await expect(
      startHostRuntime({
        kind: "web",
        displayName: "Clawtrate Web",
        dataDir: mkdtempSync(join(tmpdir(), "clawtrate-runtime-")),
        devGateway: null,
        devOnly: true,
        recheckDevGateway: () => null,
      }),
    ).rejects.toThrow(/needs the development gateway/);
  });

  it("shows the approve command for the same instance", () => {
    const named = { url: "ws://127.0.0.1:19240", token: "t", instance: "alpha" };
    expect(approvalInstructionsFor(named)(named.url, "req-1")).toEqual({
      command: "pnpm dev-gateway approve --instance alpha",
      note: null,
    });
    expect(approvalInstructionsFor(named)(DEV_GATEWAY_URL, REQ).command).toBe(
      `openclaw devices approve ${REQ}`,
    );
  });
});

/** A request id in the gateway's UUID shape. */
const REQ = "e5eb4aa8-175f-40f1-bc7a-8f15cfc40942";

describe("pairing instructions (A3)", () => {
  it("shows only the dev tooling's command for the development gateway", () => {
    expect(approvalInstructionsFor(devGateway)(DEV_GATEWAY_URL, "req-1")).toEqual({
      command: "pnpm dev-gateway approve",
      note: null,
    });
  });

  it("shows the owner's command, with where to run it, for any other gateway", () => {
    for (const instructions of [
      approvalInstructionsFor(devGateway)("wss://gateway.example.com", REQ),
      approvalInstructionsFor(null)(DEV_GATEWAY_URL, REQ),
    ]) {
      expect(instructions.command).toBe(`openclaw devices approve ${REQ}`);
      expect(instructions.title).toBe("Waiting for approval.");
      expect(instructions.note).toBe(
        "Run this on the gateway's computer, with `--profile <name>` if the gateway doesn't use the default profile:",
      );
    }
    // An address the person typed: never a place's words, even where a setup found one there.
    const here = approvalInstructionsFor(null, () => ({
      route: "this-computer",
      profile: "clawtrate",
    }));
    expect(here(DEV_GATEWAY_URL, REQ).title).toBe("Waiting for approval on this computer.");
    expect(here(DEV_GATEWAY_URL, REQ, null, true)).toEqual(
      approvalInstructionsFor(null)(DEV_GATEWAY_URL, REQ),
    );
    // Only an id of the gateway's UUID shape goes in a command (setup §9).
    expect(approvalInstructionsFor(null)(DEV_GATEWAY_URL, "req-1").command).toBe(
      "openclaw devices list",
    );
  });
});
