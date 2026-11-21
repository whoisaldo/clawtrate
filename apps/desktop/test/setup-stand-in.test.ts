// The stand-in for `openclaw` in a sandbox (docs/development/setup.md): the
// host's own answers to the look's exact commands, for the proven instance
// alone. Every spawn, socket and request of this process is counted here:
// a sandboxed look and Connect start no program and, outside the pairing
// scenario, open nothing.

import type * as ChildProcess from "node:child_process";
import type * as Http from "node:http";
import type * as Https from "node:https";
import type * as Net from "node:net";
import type * as Tls from "node:tls";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProgramRequest } from "../src/setup/programs.ts";
import type { Scenario } from "../src/setup/sandbox.ts";
import type { SyntheticGateway } from "../src/setup/synthetic-gateway.ts";

const opened = vi.hoisted(() => ({ spawns: [] as string[], sockets: [] as string[] }));

vi.mock("node:child_process", async (original) => {
  const real = await original<typeof ChildProcess>();
  const count =
    <T extends (...args: never[]) => unknown>(name: string, fn: T) =>
    (...args: Parameters<T>) => {
      opened.spawns.push(`${name} ${String(args[0])}`);
      return fn(...args);
    };
  return {
    ...real,
    spawn: count("spawn", real.spawn),
    spawnSync: count("spawnSync", real.spawnSync),
    execFile: count("execFile", real.execFile),
    execFileSync: count("execFileSync", real.execFileSync),
    exec: count("exec", real.exec),
    execSync: count("execSync", real.execSync),
    fork: count("fork", real.fork),
  };
});
vi.mock("node:net", async (original) => {
  const real = await original<typeof Net>();
  return {
    ...real,
    connect: (...args: Parameters<typeof real.connect>) => {
      opened.sockets.push("net.connect");
      return real.connect(...args);
    },
    createConnection: (...args: Parameters<typeof real.createConnection>) => {
      opened.sockets.push("net.createConnection");
      return real.createConnection(...args);
    },
    createServer: (...args: Parameters<typeof real.createServer>) => {
      opened.sockets.push("net.createServer");
      return real.createServer(...args);
    },
  };
});
vi.mock("node:tls", async (original) => {
  const real = await original<typeof Tls>();
  return {
    ...real,
    connect: (...args: Parameters<typeof real.connect>) => {
      opened.sockets.push("tls.connect");
      return real.connect(...args);
    },
  };
});
vi.mock("node:https", async (original) => {
  const real = await original<typeof Https>();
  return {
    ...real,
    request: (...args: Parameters<typeof real.request>) => {
      opened.sockets.push("https.request");
      return real.request(...args);
    },
    get: (...args: Parameters<typeof real.get>) => {
      opened.sockets.push("https.get");
      return real.get(...args);
    },
  };
});
vi.mock("node:http", async (original) => {
  const real = await original<typeof Http>();
  return {
    ...real,
    request: (...args: Parameters<typeof real.request>) => {
      opened.sockets.push("http.request");
      return real.request(...args);
    },
    get: (...args: Parameters<typeof real.get>) => {
      opened.sockets.push("http.get");
      return real.get(...args);
    },
  };
});

const { ClawtrateClient } = await import("@clawtrate/core");
const { FakeGateway, testHost, memoryStorage, until } =
  await import("../../../packages/core/test/fake-gateway.ts");
const { SetupController } = await import("../src/setup/controller.ts");
const { lookHere } = await import("../src/setup/look.ts");
const { isLookCommand } = await import("../src/setup/programs.ts");
const { sandboxOpener, STAND_IN_PROGRAM, UNTESTED_VERSION } =
  await import("../src/setup/sandbox.ts");
const { SetupRefusedError } = await import("../src/setup/world.ts");
const { startSyntheticGateway } = await import("../src/setup/synthetic-gateway.ts");
const fake = await import("./fixtures/sandbox.ts");

const PROFILE = "clawtrate-dev-su1-test";

// Every fake home, run record and checkout goes, whether the test passed or not.
afterEach(() => fake.removeBases());

/** A proven run of this checkout's, its sandbox, and a pairing gateway that is never a real one. */
function sandbox(scenario?: Scenario) {
  const at = fake.world();
  const run = fake.instance({
    home: at.home,
    checkout: at.checkout,
    name: "su1-test",
    run: fake.runId("a"),
  });
  const { file, root } = fake.runFolder(join(at.base, "runs"), {
    instance: run.name,
    run: run.run,
    ...(scenario ? { scenario } : {}),
  });
  // The pairing scenario's synthetic gateway listens in this process.
  const processes = fake.identities(new Set([fake.GATEWAY_PID, fake.START_PID, process.pid]));
  const minted: string[] = [];
  let started = 0;
  const listening = { open: true };
  const gateway: SyntheticGateway = {
    url: "ws://127.0.0.1:19980",
    port: 19980,
    mint: (now) => {
      minted.push("code");
      return {
        url: "ws://127.0.0.1:19980",
        bootstrapToken: "c".repeat(43),
        expiresAtMs: now + 60_000,
      };
    },
    ownsListener: (port) => listening.open && port === 19980,
    close: async () => {},
  };
  const opener = sandboxOpener({
    file,
    platform: "darwin",
    context: {
      platform: process.platform,
      home: at.home,
      uid: at.uid,
      checkout: at.checkout,
      identify: processes.identify,
    },
    startGateway: async () => {
      started += 1;
      return gateway;
    },
  });
  return { at, run, file, root, processes, opener, minted, listening, started: () => started };
}

async function openOrThrow(opener: ReturnType<typeof sandbox>["opener"]) {
  const result = await opener.open();
  if (result instanceof SetupRefusedError) throw result;
  return result;
}

const ask = (args: string[], program = STAND_IN_PROGRAM): ProgramRequest => ({
  program,
  args,
  env: {},
  cwd: "/",
  timeoutMs: 1000,
  maxBytes: 4096,
});

describe("the stand-in for openclaw", () => {
  it("answers the look's three commands for the proven instance, from fixtures and the run's records, and starts and opens nothing", async () => {
    opened.spawns.length = 0;
    opened.sockets.length = 0;
    const s = sandbox();
    const { run } = await openOrThrow(s.opener);
    const version = await run(ask(["--profile", PROFILE, "--version"]));
    expect(version).toMatchObject({ exitCode: 0, stdout: "OpenClaw 2026.10.6\n" });
    expect(
      (await run(ask(["--profile", PROFILE, "config", "get", "gateway.auth.mode", "--json"])))
        .stdout,
    ).toBe('"token"\n');
    const status = JSON.parse(
      (await run(ask(["--profile", PROFILE, "gateway", "status", "--json"]))).stdout,
    );
    expect(status).toEqual({
      service: {
        label: "LaunchAgent",
        loaded: false,
        runtime: { status: "unknown", missingUnit: true },
      },
      config: { cli: { path: join(s.run.stateDir, "openclaw.json"), exists: true } },
      gateway: { bindMode: "loopback", port: s.run.port, probeUrl: `ws://127.0.0.1:${s.run.port}` },
      port: {
        port: s.run.port,
        status: "busy",
        listeners: [{ pid: fake.GATEWAY_PID, address: `127.0.0.1:${s.run.port}` }],
      },
      rpc: { ok: true, version: "2026.10.6", url: `ws://127.0.0.1:${s.run.port}` },
    });
    // The run is proven again for each status: the gateway's process asked each time.
    expect(s.processes.asked).toEqual([fake.GATEWAY_PID, fake.GATEWAY_PID]);
    expect(opened.spawns).toEqual([]);
    expect(opened.sockets).toEqual([]);
    expect(s.started()).toBe(0);
  });

  it("refuses the deep status, every other command, another profile, the default profile and any other program", async () => {
    const s = sandbox();
    const { run } = await openOrThrow(s.opener);
    const refused = [
      ask(["--profile", PROFILE, "gateway", "status", "--json", "--deep"]),
      ask([
        "--profile",
        PROFILE,
        "qr",
        "--json",
        "--voice-node",
        "--url",
        `ws://127.0.0.1:${s.run.port}`,
      ]),
      ask(["--profile", PROFILE, "devices", "list", "--json"]),
      ask(["--profile", "clawtrate-dev-other", "--version"]),
      ask(["--profile", "clawtrate", "--version"]),
      ask(["--version"]),
      ask(["gateway", "status", "--json"]),
      ask(["--profile", PROFILE, "--version"], "/usr/local/bin/openclaw"),
      ask(["--profile", PROFILE, "--version"], join(s.root, "home/openclaw")),
    ];
    for (const request of refused)
      expect((await run(request)).exitCode, request.args.join(" ")).toBe(2);
    expect(s.minted).toEqual([]);
    expect(s.started()).toBe(0);
  });

  it("answers status only while the run is proven: a replaced marker or a gone gateway changes the answer", async () => {
    const s = sandbox();
    const { run } = await openOrThrow(s.opener);
    s.processes.alive.clear();
    const stopped = JSON.parse(
      (await run(ask(["--profile", PROFILE, "gateway", "status", "--json"]))).stdout,
    );
    expect(stopped.rpc).toEqual({ ok: false, url: `ws://127.0.0.1:${s.run.port}` });
    expect(stopped.port.status).toBe("free");
    // Another run's marker in the instance's folder: a refusal in fixed words, no answer.
    fake.instance({
      home: s.at.home,
      checkout: s.at.checkout,
      name: "su1-test",
      run: fake.runId("e"),
      record: null,
    });
    await expect(run(ask(["--profile", PROFILE, "gateway", "status", "--json"]))).rejects.toThrow(
      SetupRefusedError,
    );
  });

  it("reports the untested version in its scenario, and no program in the not-found and program-missing scenarios", async () => {
    const untested = sandbox("untested-version");
    const opened = await openOrThrow(untested.opener);
    expect(
      (await lookHere(opened.world, opened.run, { identify: opened.identify }))?.look,
    ).toMatchObject({
      outcome: "untested",
      version: UNTESTED_VERSION,
    });
    for (const [scenario, outcome] of [
      ["not-found", "not-found"],
      ["program-missing", "program-missing"],
    ] as const) {
      const s = sandbox(scenario);
      const world = await openOrThrow(s.opener);
      const asked: ProgramRequest[] = [];
      const report = await lookHere(
        world.world,
        (request) => {
          asked.push(request);
          return world.run(request);
        },
        { identify: world.identify },
      );
      expect(report?.look.outcome, scenario).toBe(outcome);
      expect(asked, scenario).toEqual([]);
    }
  });

  it("only in the pairing scenario: its gateway's port, and a code for that gateway's address alone", async () => {
    const s = sandbox("pairing");
    const { world, run } = await openOrThrow(s.opener);
    expect(world.pairs).toBe(true);
    expect(world.portAllowed(19980)).toBe(true);
    expect(world.portAllowed(s.run.port)).toBe(false);
    const status = JSON.parse(
      (await run(ask(["--profile", PROFILE, "gateway", "status", "--json"]))).stdout,
    );
    expect(status.gateway.port).toBe(19980);
    const other = await run(
      ask(["--profile", PROFILE, "qr", "--json", "--voice-node", "--url", "ws://127.0.0.1:19960"]),
    );
    expect(other.exitCode).toBe(2);
    expect(s.minted).toEqual([]);
    const code = await run(
      ask(["--profile", PROFILE, "qr", "--json", "--voice-node", "--url", "ws://127.0.0.1:19980"]),
    );
    expect(code.exitCode).toBe(0);
    expect(s.minted).toEqual(["code"]);
    expect(s.started()).toBe(1);
  });

  it("every command it answers is one of the look's exact commands", () => {
    for (const args of [
      ["--profile", PROFILE, "--version"],
      ["--profile", PROFILE, "gateway", "status", "--json"],
      ["--profile", PROFILE, "config", "get", "gateway.auth.mode", "--json"],
      ["--profile", PROFILE, "qr", "--json", "--voice-node", "--url", "ws://127.0.0.1:19980"],
    ])
      expect(isLookCommand(args)).toBe(true);
  });
});

describe("a sandboxed setup, from the look to Connect", () => {
  function controller(scenario?: Scenario, answer: () => Promise<boolean> = async () => true) {
    const s = sandbox(scenario);
    const gateway = new FakeGateway();
    const logs: string[] = [];
    const client = new ClawtrateClient(
      {
        ...testHost(gateway, memoryStorage()),
        log: (_level: string, line: string) => void logs.push(line),
      },
      { reconnect: { initialMs: 20, maxMs: 40 } },
    );
    const dialogs: string[] = [];
    const setup = new SetupController({
      client,
      open: s.opener.open,
      stopPrograms: () => {},
      confirm: async (confirmation) => {
        dialogs.push(confirmation.message);
        return answer();
      },
      log: (line) => logs.push(line),
    });
    return { ...s, gateway, client, setup, logs, dialogs };
  }

  it("a development instance is looked at and never paired with: after the dialog, a fixed refusal, no code, no socket, no program", async () => {
    opened.spawns.length = 0;
    opened.sockets.length = 0;
    const c = controller();
    await c.setup.look();
    expect(c.setup.current.look?.outcome).toBe("running");
    await c.setup.connect();
    expect(c.dialogs).toHaveLength(1);
    expect(c.setup.current.failure).toMatchObject({ kind: "refused", reason: "pairing" });
    expect(c.logs).toContain(
      "[setup] The look on this computer refused to start: this sandbox's scenario does not pair.",
    );
    expect(c.minted).toEqual([]);
    expect(c.gateway.sockets).toHaveLength(0);
    expect(opened.spawns).toEqual([]);
    expect(opened.sockets).toEqual([]);
  });

  it("a description that stops proving between the look and Connect refuses Connect, in fixed words", async () => {
    const c = controller("pairing");
    await c.setup.look();
    expect(c.setup.current.look?.outcome).toBe("running");
    fake.instance({
      home: c.at.home,
      checkout: c.at.checkout,
      name: "su1-test",
      run: fake.runId("f"),
      record: null,
    });
    await c.setup.connect();
    expect(c.setup.current.failure).toMatchObject({ kind: "refused", reason: "state" });
    expect(c.minted).toEqual([]);
    expect(c.gateway.sockets).toHaveLength(0);
    for (const line of c.logs) expect(line).not.toContain(c.at.base);
  });

  it("the pairing scenario mints after the dialog, through the fixture, for its own gateway", async () => {
    const c = controller("pairing");
    c.gateway.connectReply = () => ({
      ok: false,
      error: { code: "INVALID_REQUEST", message: "x" },
    });
    await c.setup.look();
    await c.setup.connect();
    expect(c.dialogs).toHaveLength(1);
    expect(c.minted).toEqual(["code"]);
    await until(() => c.gateway.connects.length > 0);
    c.client.stop();
  });

  it("the pairing scenario makes no code and opens no socket while the host's dialog waits", async () => {
    let approve: (yes: boolean) => void = () => {};
    const c = controller("pairing", () => new Promise<boolean>((resolve) => (approve = resolve)));
    c.gateway.connectReply = () => ({
      ok: false,
      error: { code: "INVALID_REQUEST", message: "x" },
    });
    await c.setup.look();
    const connecting = c.setup.connect();
    await until(() => c.dialogs.length === 1);
    expect(c.setup.current.phase).toBe("confirming");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(c.minted).toEqual([]);
    expect(c.gateway.sockets).toHaveLength(0);
    approve(true);
    await connecting;
    expect(c.minted).toEqual(["code"]);
    await until(() => c.gateway.connects.length > 0);
    c.client.stop();
  });

  it("S8: removing a description while Connect waits stops before mint and socket", async () => {
    const c = controller("pairing");
    try {
      await c.setup.look();
      vi.spyOn(c.client, "hasDeviceToken").mockImplementationOnce(async () => {
        rmSync(c.file);
        return false;
      });
      await c.setup.connect();
      expect({
        failure: c.setup.current.failure,
        minted: c.minted,
        sockets: c.gateway.sockets.length,
      }).toMatchObject({ failure: { kind: "refused", reason: "file" }, minted: [], sockets: 0 });
      // Once refused, the same description put back at that path doesn't bring the run back.
      writeFileSync(
        c.file,
        JSON.stringify({ instance: c.run.name, run: c.run.run, scenario: "pairing" }),
        {
          mode: 0o600,
        },
      );
      await c.setup.look();
      expect(c.setup.current.failure).toMatchObject({ kind: "refused", reason: "file" });
    } finally {
      c.client.stop();
    }
  });

  it("S7: a pairing listener closed while the host process lives opens no socket", async () => {
    const s = sandbox("pairing");
    const server = await startSyntheticGateway();
    const gateway = new FakeGateway();
    const client = new ClawtrateClient(testHost(gateway, memoryStorage()));
    const opener = sandboxOpener({
      file: s.file,
      platform: "darwin",
      context: { ...s.at, platform: process.platform, identify: s.processes.identify },
      startGateway: async () => server,
    });
    const setup = new SetupController({
      client,
      open: opener.open,
      stopPrograms: () => {},
      confirm: async () => {
        await server.close();
        return true;
      },
    });
    try {
      await setup.look();
      expect(setup.current.look?.outcome).toBe("running");
      await setup.connect();
      expect(gateway.sockets).toHaveLength(0);
      expect(setup.current.failure?.kind).toBe("changed");
    } finally {
      client.stop();
      await opener.close();
    }
  });

  it("a description removed during the look is refused, not an answer of the wrong shape", async () => {
    const c = controller();
    vi.spyOn(c.client, "deviceAccess").mockImplementationOnce(async () => {
      rmSync(c.file);
      return "new";
    });
    await c.setup.look();
    expect(c.setup.current.failure).toMatchObject({ kind: "refused", reason: "file" });
    c.client.stop();
  });

  it("a pairing listener gone just before the socket opens no socket: the client's check asks the server itself", async () => {
    const c = controller("pairing");
    const redeem = c.client.connectWithSetupCode.bind(c.client);
    vi.spyOn(c.client, "connectWithSetupCode").mockImplementationOnce(async (code, setup) => {
      // Everything was checked; the listener goes as the code is handed over.
      c.listening.open = false;
      await redeem(code, setup);
    });
    await c.setup.look();
    await c.setup.connect();
    await until(() => c.setup.current.phase === "failed");
    expect(c.minted).toEqual(["code"]);
    expect(c.gateway.sockets).toHaveLength(0);
    c.client.stop();
  });

  it("the pairing scenario's status and code say nothing once its server no longer listens", async () => {
    const s = sandbox("pairing");
    const { run } = await openOrThrow(s.opener);
    s.listening.open = false;
    expect((await run(ask(["--profile", PROFILE, "gateway", "status", "--json"]))).exitCode).toBe(
      2,
    );
    expect(
      (
        await run(
          ask([
            "--profile",
            PROFILE,
            "qr",
            "--json",
            "--voice-node",
            "--url",
            "ws://127.0.0.1:19980",
          ]),
        )
      ).exitCode,
    ).toBe(2);
    expect(s.minted).toEqual([]);
  });

  it("a description removed while the look runs ends the look as a refusal", async () => {
    const s = sandbox();
    const client = new ClawtrateClient(testHost(new FakeGateway(), memoryStorage()));
    const setup = new SetupController({
      client,
      open: async () => {
        const opened = await s.opener.open();
        if (opened instanceof SetupRefusedError) return opened;
        return {
          ...opened,
          run: async (request) => {
            if (request.args.includes("--version")) rmSync(s.file);
            return opened.run(request);
          },
        };
      },
      stopPrograms: () => {},
      confirm: null,
    });
    await setup.look();
    expect(setup.current).toMatchObject({
      phase: "failed",
      failure: { kind: "refused", reason: "file" },
    });
    client.stop();
  });
});
