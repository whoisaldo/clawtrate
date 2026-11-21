// Approving this device's access over SSH (docs/design/setup.md §9), end to
// end: a named development instance of OpenClaw 2026.10.6 of this run's own,
// reached through an sshd of the test's own on loopback, with keys of its own
// in a temporary folder (harness.ts). The stand-in `openclaw` in the test's
// home answers the LOOK from the instance's facts and runs the code and the
// two reads after an approval with the real program, through the development
// tool's guarded runner, for that instance alone (mint-code.ts, read-call.ts).
// The host's own code does the rest: the route, the waiting state's words for
// its account and port, the IDENTITY and LIST scripts over the pinned SSH
// connection, the reconnect with the staged token and the sealed route store.
//
// It needs `sshd`, `ssh-keygen` and OpenClaw 2026.10.6 on PATH, and starts and
// resets its instance itself, recorded before it starts so that a killed run
// is cleaned up by the next end-to-end run in this checkout.

import { ClawtrateClient } from "@clawtrate/core";
import { createNodeHost } from "@clawtrate/core/node";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { until } from "../../../../packages/core/test/fake-gateway.ts";
import { FORBIDDEN_PORTS } from "../../../../e2e/ports.ts";
import {
  cleanUp,
  isRunTempDir,
  saveRecord,
  TEMP_PREFIX,
  type RunRecord,
} from "../../../../e2e/run-record.ts";
import { openInstance } from "../../../../tools/dev-gateway/src/cli.ts";
import { parseJsonOutput } from "../../../../tools/dev-gateway/src/env.ts";
import { newRunId, processIdentity } from "../../../../tools/dev-gateway/src/state-guard.ts";
import { approvalInstructionsFor } from "../../src/host/runtime.ts";
import { SshTransport } from "../../src/main/ssh/transport.ts";
import { SetupSlice } from "../../src/setup/host.ts";
import { RemoteSetup } from "../../src/setup/remote.ts";
import { RouteStore, routedStorage } from "../../src/setup/routes.ts";
import {
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
const INSTANCE = `e2e-${RUN}-approve-ssh`;
/** The development tool's profile for this run's instance: the only one any `openclaw` here names. */
const PROFILE = `clawtrate-dev-${INSTANCE}`;
const INTERACTIVE = ["operator.approvals", "operator.questions", "operator.read", "operator.write"];

function openclawHere(): string | null {
  const found = spawnSync("/bin/sh", ["-c", "command -v openclaw"], { encoding: "utf8" });
  const path = found.stdout.trim();
  if (found.status !== 0 || !path) return null;
  const version = spawnSync(path, ["--profile", PROFILE, "--version"], { encoding: "utf8" });
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
    ? "approving this device's access over the test's own sshd"
    : `approving this device's access over the test's own sshd (skipped: ${skip})`;

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
  let gatewayPid: number;
  let routes: RouteStore;
  let transport: SshTransport;
  let client: ClawtrateClient;
  let remote: RemoteSetup;
  let stub: ReturnType<typeof installStubOpenclaw>;

  /** The instance's devices, as its own CLI lists them, through the tool's guarded runner. */
  const devices = () =>
    parseJsonOutput<{ paired?: Array<{ deviceId?: string; scopes?: string[] }> }>(
      openInstance(INSTANCE).runner.runSync(["devices", "list", "--json"]).stdout,
    );
  /** The device token the route store holds for this route, sealed on disk. */
  const routeToken = () => {
    const [route] = routes.list();
    const raw = routes.getToken(route!.key, client.state.connection.deviceId!, "operator");
    return raw === null ? null : (JSON.parse(raw) as { token: string; heldScopes: string[] });
  };
  const reads = () => stub.calls().filter((call) => call.startsWith("gateway call "));

  beforeAll(async () => {
    const self = processIdentity(process.pid);
    if (self.state !== "alive") throw new Error("could not determine this process's start time");
    record.runner.identity = self.identity;
    // In the short temporary folder, named so a later run recovers it if this one is killed.
    root = tempDir(`${TEMP_PREFIX}ssh-approve-${RUN}-`);
    if (!isRunTempDir(root)) throw new Error("the test's folder is not one a later run recovers");
    record.dirs.push(root);
    const runId = newRunId();
    record.instances.push({ name: INSTANCE, runId });
    saveRecord(RECORDS, record);
    cli("start", "--run-id", runId, "--instance", INSTANCE, "--default-local-pairing", "--no-seed");
    const listed = JSON.parse(
      execFileSync(process.execPath, [CLI, "list", "--json"], { cwd: ROOT, encoding: "utf8" }),
    ) as Array<{ name: string | null; gatewayPort: number | null; gatewayPid: number | null }>;
    const mine = listed.find((row) => row.name === INSTANCE);
    if (!mine?.gatewayPort || !mine.gatewayPid)
      throw new Error(`instance ${INSTANCE} is not running`);
    if (FORBIDDEN_PORTS.includes(mine.gatewayPort))
      throw new Error(`instance ${INSTANCE} is on port ${mine.gatewayPort}, which this never uses`);
    gatewayPort = mine.gatewayPort;
    gatewayPid = mine.gatewayPid;

    t = makeWorld(root);
    server = await startSshd(root, t.home, t.userKey);
    // The daemon, by PID and start time, with its folder: recorded before anything uses it, so a
    // later run stops exactly it and removes exactly that folder if this one is killed.
    const daemon = processIdentity(server.pid);
    if (daemon.state !== "alive") throw new Error("could not determine the test sshd's start time");
    record.sshd = { pid: server.pid, identity: daemon.identity, dir: root };
    saveRecord(RECORDS, record);
    assertSessionHome(root, server, t.world, t.userKey);
    stub = installStubOpenclaw(t.home);
    stub.setVersion("OpenClaw 2026.10.6 (fe06181)\n");
    stub.setStatus(
      "default",
      statusJson({ port: gatewayPort, home: t.home, pid: mine.gatewayPid }),
    );
    const real = [
      `export HOME='${userInfo().homedir}'`,
      `export PATH='${process.env.PATH ?? "/usr/bin:/bin"}'`,
      `export OPENCLAW_BIN='${OPENCLAW}'`,
    ];
    stub.setCodeScript(
      "default",
      [
        ...real,
        `exec '${process.execPath}' '${join(import.meta.dirname, "mint-code.ts")}' '${INSTANCE}' "$@"`,
        "",
      ].join("\n"),
    );
    // The list can be held, to drop the SSH sessions while it runs.
    stub.setCallScript(
      "default",
      [
        'd="$HOME/.openclaw/stub"',
        'if [ "$3" = device.pair.list ] && [ -f "$d/hold" ]; then',
        '  while [ ! -f "$d/release" ]; do sleep 0.2; done',
        "fi",
        // Or the service's status changes as the list is read: another listener, another version.
        'if [ "$3" = device.pair.list ] && [ -f "$d/status-after-list.json" ]; then',
        '  mv "$d/status-after-list.json" "$d/status-default.json"',
        "fi",
        ...real,
        `exec '${process.execPath}' '${join(import.meta.dirname, "read-call.ts")}' '${INSTANCE}' "$@"`,
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

    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    routes = new RouteStore(dataDir, { seal: testSeal });
    transport = new SshTransport({ ...t.world, appDir: join(dataDir, "ssh") });
    let setupHost: RemoteSetup | null = null;
    client = new ClawtrateClient(
      createNodeHost({
        dataDir,
        client: { displayName: "Clawtrate Desktop", version: "0.1.0", platform: process.platform },
        wrapStorage: (store) => routedStorage(store, routes),
        routeSocket: (url) => setupHost?.socketFor(url) ?? null,
        // As the app: the route's words and its read-back, from the host's own setup.
        approvalInstructions: approvalInstructionsFor(
          null,
          (url) => setupHost?.placeFor(url) ?? null,
        ),
        readBack: async (url, request) => (setupHost ? setupHost.readBack(url, request) : null),
      }),
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
      ask: async () => ({ confirmed: true, checked: false }),
      publish: (next) => slice.setMain(next),
      publishRoute: (route) => slice.setRoute(route),
      restoredMs: 500,
    });
    await remote.there("devbox");
    await remote.trustKey();
    await remote.connect();
    await until(() => client.state.setup!.phase === "done", 60_000);
    expect(client.state.connection).toMatchObject({
      status: "connected",
      scopes: ["operator.read"],
    });
  }, 240_000);

  afterAll(async () => {
    if (stub) writeFileSync(join(t.home, ".openclaw", "stub", "release"), "");
    await remote?.closeAll();
    await transport?.closeAll();
    client?.stop();
    await server?.stop();
    const problems = cleanUp(RECORDS, record, (name, runId) =>
      cli("reset", "--run-id", runId, "--instance", name),
    );
    // The folder this test made, by its exact name, once its own sshd has stopped.
    if (root) rmSync(root, { recursive: true, force: true });
    expect(problems).toEqual([]);
  }, 120_000);

  it("F-500: the waiting state names the route's account, port and profile; the approval is kept after IDENTITY, LIST and the reconnect show exactly what was asked", async () => {
    const before = routeToken()!;
    expect(before.heldScopes).toEqual(["operator.read"]);
    await client.requestAccess();
    await until(() => client.state.connection.upgrade.status === "pending", 30_000);
    const upgrade = client.state.connection.upgrade;
    const id = upgrade.requestId!;
    expect(upgrade).toMatchObject({
      approveTitle: "Waiting for approval on devbox.",
      approveNote: `On ${t.world.localUser}@127.0.0.1 (SSH port ${server.port}), run this for the default profile:`,
      approveCommand: `openclaw devices approve ${id}`,
    });
    expect(reads()).toEqual([]);

    // The person runs the command on that computer: the development tool's approve.
    cli("approve", id, "--instance", INSTANCE);
    await until(() => client.state.connection.canWrite, 60_000);

    // Both reads ran over SSH, each for the gateway's port there, before the token was kept.
    const url = `ws://127.0.0.1:${gatewayPort}`;
    expect(reads()).toEqual([
      `gateway call gateway.identity.get --expect-url ${url} --json`,
      `gateway call device.pair.list --expect-url ${url} --json`,
    ]);
    expect([...client.state.connection.scopes].sort()).toEqual(INTERACTIVE);
    const after = routeToken()!;
    expect(after.token).not.toBe(before.token);
    expect([...after.heldScopes].sort()).toEqual(INTERACTIVE);
    const mine = (devices().paired ?? []).filter(
      (each) => each.deviceId === client.state.connection.deviceId,
    );
    expect(mine).toHaveLength(1);
    expect([...mine[0]!.scopes!].sort()).toEqual(INTERACTIVE);
  });

  it("F-500: the read-back establishes the route's endpoint and version first, and reads no list for another gateway", async () => {
    const url = client.state.connection.gatewayUrl!;
    const expected = client.state.connection.gatewayId!;
    const status = (port: number, running = true) =>
      stub.setStatus("default", statusJson({ port, home: t.home, pid: gatewayPid, running }));
    try {
      // The route's profile now answers on another port there: nothing is read at all.
      status(gatewayPort + 1);
      let ran = reads().length;
      expect(await remote.readBack(url, { expected, here: null })).toEqual({
        ok: false,
        step: "identity",
        exitCode: null,
      });
      expect(reads().length).toBe(ran);
      // The route's service reports itself stopped: the same.
      status(gatewayPort, false);
      expect(await remote.readBack(url, { expected, here: null })).toMatchObject({
        ok: false,
        step: "identity",
      });
      expect(reads().length).toBe(ran);
      // The endpoint is the route's, but another identity is expected: IDENTITY, and no LIST.
      status(gatewayPort);
      ran = reads().length;
      const other = await remote.readBack(url, { expected: "0".repeat(64), here: null });
      expect(other).toMatchObject({ ok: false, step: "list", identity: { deviceId: expected } });
      expect(reads().slice(ran)).toEqual([
        `gateway call gateway.identity.get --expect-url ws://127.0.0.1:${gatewayPort} --json`,
      ]);
    } finally {
      status(gatewayPort);
    }
  });

  it("F-500: a service that changes while LIST runs, another listener or another version, discards the read", async () => {
    const url = client.state.connection.gatewayUrl!;
    const expected = client.state.connection.gatewayId!;
    const stubDir = join(t.home, ".openclaw", "stub");
    const proved = statusJson({ port: gatewayPort, home: t.home, pid: gatewayPid });
    try {
      for (const after of [
        statusJson({ port: gatewayPort, home: t.home, pid: gatewayPid + 1 }),
        statusJson({ port: gatewayPort, home: t.home, pid: gatewayPid, version: "2026.10.7" }),
      ]) {
        stub.setStatus("default", proved);
        writeFileSync(join(stubDir, "status-after-list.json"), JSON.stringify(after, null, 2));
        const ran = reads().length;
        const read = await remote.readBack(url, { expected, here: null });
        // IDENTITY and LIST both ran, and the list doesn't count.
        expect(reads().slice(ran)).toEqual([
          `gateway call gateway.identity.get --expect-url ws://127.0.0.1:${gatewayPort} --json`,
          `gateway call device.pair.list --expect-url ws://127.0.0.1:${gatewayPort} --json`,
        ]);
        expect(read).toMatchObject({ ok: false, step: "list", identity: { deviceId: expected } });
      }
      // With nothing changed, the same read counts.
      stub.setStatus("default", proved);
      expect(await remote.readBack(url, { expected, here: null })).toMatchObject({ ok: true });
    } finally {
      rmSync(join(stubDir, "status-after-list.json"), { force: true });
      stub.setStatus("default", proved);
    }
  });

  it("F-500: an SSH drop after the person ran the command, while Clawtrate reads back, disconnects and saves no new token", async () => {
    const before = routeToken()!;
    const stubDir = join(t.home, ".openclaw", "stub");
    writeFileSync(join(stubDir, "hold"), "");
    rmSync(join(stubDir, "release"), { force: true });
    const ranBefore = reads().length;
    await client.requestAccess("admin");
    await until(() => client.state.connection.upgrade.status === "pending", 30_000);
    cli("approve", client.state.connection.upgrade.requestId!, "--instance", INSTANCE);
    // The read-back is under way: IDENTITY ran, LIST is held on that computer.
    await until(
      () =>
        reads()
          .slice(ranBefore)
          .some((call) => call.includes("device.pair.list")),
      60_000,
    );
    await server.dropSessions();
    await until(() => client.state.connection.upgrade.status === "unconfirmed", 60_000);
    expect(client.state.connection.status).toBe("error");
    expect(client.state.connection.error?.message).toBe(
      "Clawtrate disconnected. It couldn't confirm what this request granted. Review this device's access on the gateway before reconnecting.",
    );
    expect(routeToken()).toEqual(before);
    writeFileSync(join(stubDir, "release"), "");
    rmSync(join(stubDir, "hold"), { force: true });
    // The device is still paired there: nothing was removed.
    const mine = (devices().paired ?? []).filter(
      (each) => each.deviceId === client.state.connection.deviceId,
    );
    expect(mine).toHaveLength(1);
  });
});
