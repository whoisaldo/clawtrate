// The SSH route end to end, as research §1 ran it: a named development
// instance of OpenClaw 2026.10.6 of this run's own, reached through an sshd of
// the test's own on loopback (harness.ts). The stand-in `openclaw` in the
// test's home answers the LOOK from the instance's recorded facts and makes
// the one-time code with the real program, through the development tool's
// guarded runner, for that instance alone (mint-code.ts). The host's own
// code does the rest: the account's dialog, first contact, the CODE script,
// the forward on its private local socket, the client's real WebSocket made
// on that socket by the host, the identity read after every hello, the
// sealed route store, the restore and Remove.
//
// It needs `sshd`, `ssh-keygen` and OpenClaw 2026.10.6 on PATH, and starts
// and resets its instance itself, recorded before it starts so that a killed
// run is cleaned up by the next end-to-end run in this checkout.

import { ClawtrateClient } from "@clawtrate/core";
import { createNodeHost } from "@clawtrate/core/node";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { until } from "../../../../packages/core/test/fake-gateway.ts";
import { FORBIDDEN_PORTS } from "../../../../e2e/ports.ts";
import { cleanUp, saveRecord, type RunRecord } from "../../../../e2e/run-record.ts";
import { openInstance } from "../../../../tools/dev-gateway/src/cli.ts";
import { parseJsonOutput } from "../../../../tools/dev-gateway/src/env.ts";
import { newRunId, processIdentity } from "../../../../tools/dev-gateway/src/state-guard.ts";
import { defaultSpawn, type Spawn } from "../../src/main/ssh/run.ts";
import { SshTransport } from "../../src/main/ssh/transport.ts";
import { SetupSlice } from "../../src/setup/host.ts";
import { isChannelUrl, RemoteSetup } from "../../src/setup/remote.ts";
import { RouteStore, routedStorage } from "../../src/setup/routes.ts";
import {
  alive,
  assertSessionHome,
  installStubOpenclaw,
  makeWorld,
  sshdAvailability,
  startSshd,
  statusJson,
  tempDir,
  testSeal,
  type TestSshd,
  type TestWorld,
} from "./harness.ts";

const ROOT = join(import.meta.dirname, "../../../..");
const CLI = join(ROOT, "tools/dev-gateway/src/cli.ts");
const RECORDS = join(ROOT, "tools/dev-gateway/.run/e2e");
const RUN = randomBytes(4).toString("hex");
const INSTANCE = `e2e-${RUN}-ssh`;

function openclawHere(): string | null {
  const found = spawnSync("/bin/sh", ["-c", "command -v openclaw"], { encoding: "utf8" });
  const path = found.stdout.trim();
  if (found.status !== 0 || !path) return null;
  const version = spawnSync(path, ["--version"], { encoding: "utf8" });
  return version.status === 0 && /^OpenClaw 2026\.10\.6\b/.test(version.stdout.trim())
    ? path
    : null;
}

const sshd = sshdAvailability();
const OPENCLAW = sshd.ok ? openclawHere() : null;
const skip = !sshd.ok
  ? sshd.reason
  : OPENCLAW === null
    ? "OpenClaw 2026.10.6 is not on PATH"
    : null;
const title =
  skip === null
    ? "the SSH route to a development gateway behind the test's own sshd"
    : `the SSH route to a development gateway behind the test's own sshd (skipped: ${skip})`;

const cli = (...args: string[]) =>
  execFileSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key !== "CLAWTRATE_DEV_INSTANCE"),
    ),
    stdio: ["ignore", "ignore", "inherit"],
  });

describe.skipIf(skip !== null)(title, { timeout: 180_000 }, () => {
  const record: RunRecord = {
    run: RUN,
    runner: { pid: process.pid, identity: "" },
    instances: [],
    host: null,
    dirs: [],
  };
  let root: string;
  let t: TestWorld;
  let server: TestSshd;
  let gatewayPort: number;
  let dataDir: string;
  let routes: RouteStore;
  let transport: SshTransport;
  let client: ClawtrateClient;
  let remote: RemoteSetup;
  const started: Array<{ args: readonly string[]; pid: number | undefined }> = [];
  const spawn: Spawn = (file, args, env) => {
    const child = defaultSpawn(file, args, env);
    started.push({ args, pid: child.pid });
    return child;
  };
  const questions: string[] = [];
  const phases: string[] = [];

  /** The instance's devices, as its own CLI lists them, through the tool's guarded runner. */
  const devices = () =>
    parseJsonOutput<{
      pending?: Array<{ deviceId?: string }>;
      paired?: Array<{
        deviceId?: string;
        scopes?: string[];
        approvedVia?: string;
        roles?: string[];
      }>;
    }>(openInstance(INSTANCE).runner.runSync(["devices", "list", "--json"]).stdout);

  beforeAll(async () => {
    const self = processIdentity(process.pid);
    if (self.state !== "alive") throw new Error("could not determine this process's start time");
    record.runner.identity = self.identity;
    root = tempDir("clawtrate-ssh-gateway-");
    record.dirs.push(root);
    const runId = newRunId();
    record.instances.push({ name: INSTANCE, runId });
    saveRecord(RECORDS, record);
    cli("start", "--run-id", runId, "--instance", INSTANCE, "--default-local-pairing", "--no-seed");
    const listed = JSON.parse(
      execFileSync(process.execPath, [CLI, "list", "--json"], { cwd: ROOT, encoding: "utf8" }),
    ) as Array<{
      name: string | null;
      gatewayPort: number | null;
      gatewayPid: number | null;
      gatewayRunning: boolean;
    }>;
    const mine = listed.find((row) => row.name === INSTANCE);
    if (!mine?.gatewayRunning || !mine.gatewayPort || !mine.gatewayPid)
      throw new Error(`instance ${INSTANCE} is not running`);
    if (FORBIDDEN_PORTS.includes(mine.gatewayPort))
      throw new Error(`instance ${INSTANCE} is on port ${mine.gatewayPort}, which this never uses`);
    gatewayPort = mine.gatewayPort;

    t = makeWorld(root);
    server = await startSshd(root, t.home, t.userKey);
    assertSessionHome(root, server, t.world, t.userKey);
    // The stand-in: the instance's facts for the LOOK, the real program for the code.
    const stub = installStubOpenclaw(t.home);
    stub.setVersion("OpenClaw 2026.10.6 (fe06181)\n");
    stub.setStatus(
      "default",
      statusJson({ port: gatewayPort, home: t.home, pid: mine.gatewayPid }),
    );
    // Every value quoted for the shell, an apostrophe in a checkout path included; HOME as this
    // process reads it, which is where `openInstance` finds the instance.
    const q = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
    stub.setCodeScript(
      "default",
      [
        `export HOME=${q(homedir())}`,
        `export PATH=${q(process.env.PATH ?? "/usr/bin:/bin")}`,
        `export OPENCLAW_BIN=${q(OPENCLAW!)}`,
        `exec ${q(process.execPath)} ${q(join(import.meta.dirname, "mint-code.ts"))} ${q(INSTANCE)} "$@"`,
        "",
      ].join("\n"),
    );
    t.writeConfig(
      [
        "Host devbox",
        "  HostName 127.0.0.1",
        `  Port ${server.port}`,
        `  User ${t.world.localUser}`,
        `  IdentityFile ${t.userKey}`,
        "  IdentitiesOnly yes",
        "",
      ].join("\n"),
    );

    dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    routes = new RouteStore(dataDir, { seal: testSeal });
    transport = new SshTransport({ ...t.world, appDir: join(dataDir, "ssh") }, { spawn });
    let setupHost: RemoteSetup | null = null;
    client = new ClawtrateClient(
      createNodeHost({
        dataDir,
        client: { displayName: "Clawtrate Desktop", version: "0.1.0", platform: process.platform },
        wrapStorage: (store) => routedStorage(store, routes),
        // As the app: a channel's socket is the host's own, on the forward's local socket.
        routeSocket: (url) => setupHost?.socketFor(url) ?? null,
      }),
      // Only the route's current channel, while it is up.
      {
        allowGatewayUrl: (url) => setupHost?.allows(url) ?? false,
        reopenRoute: async (route) => setupHost?.reopen(route),
      },
    );
    await client.start({ resume: false });
    const slice = new SetupSlice(client);
    setupHost = remote = new RemoteSetup({
      client,
      transport: () => transport,
      routes,
      ask: async (question) => {
        questions.push(question.message);
        return { confirmed: true, checked: false };
      },
      publish: (next) => slice.setMain(next),
      publishRoute: (route) => slice.setRoute(route),
      restoredMs: 500,
    });
    client.store.subscribe((state) => {
      const phase = state.setup?.route?.phase;
      if (phase && phases.at(-1) !== phase) phases.push(phase);
    });
  }, 240_000);

  afterAll(async () => {
    await remote?.closeAll();
    await transport?.closeAll();
    client?.stop();
    await server?.stop();
    const problems = cleanUp(RECORDS, record, (name, runId) =>
      cli("reset", "--run-id", runId, "--instance", name),
    );
    expect(problems).toEqual([]);
  }, 120_000);

  it("F-496 F-494 F-495: first contact, the CODE script, the forward on its private socket, and a silent read-only pairing through it, with the token on disk only sealed in the route store", async () => {
    await remote.there("devbox");
    expect(client.state.setup!.phase).toBe("key");
    await remote.trustKey();
    expect(client.state.setup!.look).toMatchObject({ outcome: "running", version: "2026.10.6" });
    await remote.connect();
    await until(() => client.state.setup!.phase === "done", 60_000);
    const account = `${t.world.localUser}@127.0.0.1 (SSH port ${server.port})`;
    expect(questions).toEqual([
      `Look for OpenClaw as ${account}?`,
      `Trust the key ${account} presented?`,
      `Pair this device read-only with the default gateway on ${account}?`,
    ]);
    // The client's address is the channel's, and the forward listens on a socket, no TCP port.
    expect(isChannelUrl(client.state.connection.gatewayUrl!)).toBe(true);
    const spec = started.find((run) => run.args.includes("-L"))!.args;
    expect(spec[spec.indexOf("-L") + 1]).toMatch(
      new RegExp(`^${join(dataDir, "ssh")}/f[0-9a-f]{12}\\.s:127\\.0\\.0\\.1:${gatewayPort}$`),
    );
    expect(client.state.connection.gatewayId).toBeTruthy();
    // Exactly read, approved by the gateway without anyone approving it.
    expect(client.state.connection).toMatchObject({
      status: "connected",
      scopes: ["operator.read"],
    });
    const deviceId = client.state.connection.deviceId!;
    const mine = (devices().paired ?? []).filter((device) => device.deviceId === deviceId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.scopes).toEqual(["operator.read"]);
    expect(mine[0]!.approvedVia).toBe("silent");
    expect(client.state.bots.length).toBeGreaterThan(0);
    // The device token: sealed in the route store, and in plain text in no file of this run.
    const [record] = routes.list();
    const token = (
      JSON.parse(routes.getToken(record!.key, deviceId, "operator")!) as { token: string }
    ).token;
    expect(token.length).toBeGreaterThan(16);
    expect(readFileSync(routes.path, "utf8")).toContain("sealed:");
    const holding: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        const info = statSync(path);
        if (info.isDirectory()) walk(path);
        else if (
          info.isFile() &&
          info.size < 8 * 1024 * 1024 &&
          readFileSync(path, "utf8").includes(token)
        )
          holding.push(path);
      }
    };
    walk(root);
    expect(holding).toEqual([]);
  });

  it("F-498: the forward comes back by itself after the sshd drops, and the route's own token reconnects with no new pairing, said back only once the gateway answered as itself", async () => {
    const deviceId = client.state.connection.deviceId!;
    const identity = client.state.connection.gatewayId;
    phases.length = 0;
    const atRestored: string[] = [];
    const stop = client.store.subscribe((state) => {
      if (state.setup?.route?.phase === "restored" && atRestored.length === 0)
        atRestored.push(`${state.connection.status} ${state.connection.gatewayId}`);
    });
    await server.dropSessions();
    await until(() => phases.includes("restoring"), 20_000);
    await until(() => phases.includes("restored"), 60_000);
    stop();
    expect(atRestored).toEqual([`connected ${identity}`]);
    await until(() => client.state.connection.status === "connected", 30_000);
    expect(client.state.connection.scopes).toEqual(["operator.read"]);
    const mine = (devices().paired ?? []).filter((device) => device.deviceId === deviceId);
    expect(mine).toHaveLength(1);
    expect(devices().pending ?? []).toEqual([]);
  });

  it("F-499: Remove is local only: it closes the forward and forgets the route, its pin and its token", async () => {
    const deviceId = client.state.connection.deviceId!;
    const forwards = started.filter((run) => run.args.includes("-L")).map((run) => run.pid!);
    expect(forwards.some((pid) => alive(pid))).toBe(true);
    await remote.removeRoute();
    expect(questions.at(-1)).toBe(
      `Remove ${t.world.localUser}@127.0.0.1 (SSH port ${server.port}) from Clawtrate?`,
    );
    expect(forwards.filter((pid) => alive(pid))).toEqual([]);
    expect(routes.list()).toEqual([]);
    expect(readFileSync(join(dataDir, "ssh", "known_hosts"), "utf8")).toBe("");
    expect(client.state.connection.status).toBe("idle");
    // OpenClaw there keeps running, and still lists this device: Remove ran nothing there.
    expect(openInstance(INSTANCE).runner.refusal()).toBeNull();
    expect((devices().paired ?? []).map((device) => device.deviceId)).toContain(deviceId);
  });
});
