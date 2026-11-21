// The look on this computer (docs/design/setup.md §4, §6), from recorded
// command outputs: every result, what each runs, and the guard that keeps
// an automated run away from the real computer. No program runs here: a
// fake runner answers from the recordings.

import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseStatus } from "../src/setup/parse.ts";
import { lookHere } from "../src/setup/look.ts";
import {
  checkRequest,
  ProgramRunner,
  type ProgramRequest,
  type ProgramResult,
} from "../src/setup/programs.ts";
import {
  parseDescription,
  proveRun,
  resolveSetupLaunch,
  sandboxOpener,
  SCENARIOS,
  STAND_IN_PROGRAM,
  validateSandbox,
  type SandboxContext,
} from "../src/setup/sandbox.ts";
import {
  accountHome,
  guardPort,
  mustSandbox,
  productionWorld,
  SANDBOX_MARKERS,
  SANDBOX_SWITCHES,
  SetupRefusedError,
  type LookWorld,
} from "../src/setup/world.ts";
import { MARKER_FILE } from "../../../tools/dev-gateway/src/state-guard.ts";
import { authJson, statusJson, VERSION_LINE } from "./fixtures/openclaw-outputs.ts";
import * as fake from "./fixtures/sandbox.ts";
import type { Identify } from "../../../tools/dev-gateway/src/state-guard.ts";

/** The recorded status's listener (pid 4242), alive with this start time. */
const LISTENER_STARTED = "2026-11-16T21:27:01Z";
const listening: Identify = (pid) =>
  pid === 4242
    ? { state: "alive", identity: LISTENER_STARTED }
    : { state: "exited", how: "absent" };
/** The look, with the recorded listener alive unless a test says otherwise. */
const look = (
  world: LookWorld,
  run: Parameters<typeof lookHere>[1],
  identify: Identify = listening,
) => lookHere(world, run, { identify });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clawtrate-look-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  // The sandbox fixtures' own temporary roots too, passed or failed.
  fake.removeBases();
});

function executable(path: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 1\n");
  chmodSync(path, 0o755);
  return path;
}

/** A recorded status with one fact changed by `change`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function withStatus(json: string, change: (status: any) => void): string {
  const status = JSON.parse(json) as unknown;
  change(status);
  return JSON.stringify(status);
}

/** A production-shaped world in a temporary home, with its program list kept to that home. */
function homeWorld(options: { program?: boolean; platform?: NodeJS.Platform } = {}): LookWorld {
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const world = productionWorld({
    home,
    appData: join(dir, "app"),
    platform: options.platform ?? "darwin",
  });
  const program = join(home, ".local/bin/openclaw");
  if (options.program !== false) executable(program);
  return {
    ...world,
    candidates: [join(dir, "app/openclaw/bin/openclaw"), program],
    // A fixture CLI of the test's own, run as a read-only version would be.
    readOnly: async () => ({ verified: true, version: null }),
  };
}

type Reply = Partial<ProgramResult> | ((request: ProgramRequest) => Partial<ProgramResult>);

/** Answers each command from a table keyed by its arguments, and records every request. */
function fakeRunner(table: Record<string, Reply>) {
  const requests: ProgramRequest[] = [];
  const run = async (request: ProgramRequest): Promise<ProgramResult> => {
    // Every request the look makes is one the host's runner would start.
    checkRequest(request);
    requests.push(request);
    const key = request.args.join(" ");
    const reply = table[key];
    const result = typeof reply === "function" ? reply(request) : reply;
    return {
      exitCode: 0,
      stdout: "",
      timedOut: false,
      tooLarge: false,
      failed: false,
      ...(result ?? { exitCode: 1 }),
    };
  };
  return { run, requests };
}

const defaultTable = (status = statusJson({ port: 18789 }), auth = authJson()) => ({
  "--version": { stdout: VERSION_LINE },
  "gateway status --json": { stdout: status },
  "gateway status --json --deep": { stdout: status },
  "config get gateway.auth.mode --json": { stdout: auth },
});

describe("what the look runs of an installed OpenClaw", () => {
  it("F-492 F-515: an OpenClaw whose launcher may repair itself is never run: the look reads its version and declines", async () => {
    // An installed package as npm leaves it, its launcher a stand-in that leaves a marker if it
    // runs at all, with the lifecycle work the real launcher would replay still pending.
    const root = join(dir, "lib/node_modules/openclaw");
    mkdirSync(root, { recursive: true });
    const marker = join(dir, "lifecycle-ran");
    const launcher = join(root, "openclaw.mjs");
    writeFileSync(launcher, `#!/bin/sh\ntouch '${marker}'\necho 'OpenClaw 2026.10.6 (0123abc)'\n`, {
      mode: 0o755,
    });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.10.6" }),
    );
    writeFileSync(join(root, ".openclaw-lifecycle-pending"), "");
    mkdirSync(join(dir, "bin"));
    symlinkSync(launcher, join(dir, "bin/openclaw"));
    const home = join(dir, "home");
    mkdirSync(join(home, ".openclaw"), { recursive: true });
    const world = {
      ...productionWorld({ home, appData: dir, platform: "darwin" }),
      candidates: [join(dir, "bin/openclaw")],
    };
    const runs: ProgramRequest[] = [];
    const runner = new ProgramRunner();
    const report = await lookHere(world, (request) => (runs.push(request), runner.run(request)));
    expect(report?.look).toMatchObject({
      outcome: "cant-tell",
      reason: "read-only",
      version: "2026.10.6",
    });
    expect(report?.found).toBeNull();
    expect(runs).toEqual([]);
    expect(existsSync(marker)).toBe(false);
    // Something that isn't an OpenClaw package is declined the same way, without a version.
    const other = await lookHere({ ...world, candidates: [process.execPath] }, async () => {
      throw new Error("nothing runs");
    });
    expect(other?.look).toMatchObject({ outcome: "cant-tell", reason: "read-only", version: null });
  });
});

describe("the look on this computer", () => {
  it("F-492: a running gateway of the tested version is found and named by profile, version, how it listens and its service", async () => {
    const world = homeWorld();
    const { run, requests } = fakeRunner(defaultTable());
    const report = await look(world, run);
    expect(report?.look).toEqual({
      outcome: "running",
      reason: null,
      version: "2026.10.6",
      profile: "default",
      listens: "loopback",
      service: "none",
      port: 18789,
      authMode: null,
      access: "new",
      others: [],
    });
    expect(report?.found).toMatchObject({ port: 18789, version: "2026.10.6" });
    expect(report?.found?.profile.args).toEqual([]);
    // Read-only commands only, each an argument array for the program found.
    expect(requests.map((request) => request.args.join(" ")).sort()).toEqual([
      "--version",
      "config get gateway.auth.mode --json",
      "gateway status --json",
      "gateway status --json --deep",
    ]);
    for (const request of requests) {
      expect(request.program).toBe(join(dir, "home/.local/bin/openclaw"));
      expect(Object.keys(request.env).sort()).toEqual(["HOME", "LANG", "NO_COLOR", "PATH"]);
    }
  });

  it("F-516: a service is named only when the status associates it with this gateway, and a configured bind only for loopback or LAN", async () => {
    const associated = { targetRole: "gateway" };
    const running = await look(
      homeWorld(),
      fakeRunner(defaultTable(statusJson({ port: 18789, service: "running", ...associated }))).run,
    );
    expect(running?.look.service).toBe("launchagent");
    const systemd = await look(
      homeWorld({ platform: "linux" }),
      fakeRunner(
        defaultTable(
          statusJson({ port: 18789, service: "running", label: "systemd", ...associated }),
        ),
      ).run,
    );
    expect(systemd?.look.service).toBe("systemd");
    // As recorded: a running service the status calls diagnostic-only is not this gateway's.
    const diagnostic = await look(
      homeWorld(),
      fakeRunner(defaultTable(statusJson({ port: 18789, service: "running" }))).run,
    );
    expect(diagnostic?.look.service).toBeNull();
    // A missing unit is reported as such.
    const none = await look(homeWorld(), fakeRunner(defaultTable(statusJson({ port: 18789 }))).run);
    expect(none?.look.service).toBe("none");
    const lan = await look(
      homeWorld(),
      fakeRunner(defaultTable(statusJson({ port: 18789, bind: "lan" }))).run,
    );
    expect(lan?.look.listens).toBe("lan");
    for (const bind of ["auto", "tailnet", "custom"]) {
      const report = await look(
        homeWorld(),
        fakeRunner(defaultTable(statusJson({ port: 18789, bind }))).run,
      );
      expect(report?.look.listens, bind).toBeNull();
    }
  });

  it("F-515: the tested version is offered for Connect, with what the look established", async () => {
    const report = await look(homeWorld(), fakeRunner(defaultTable()).run);
    expect(report?.look).toMatchObject({ outcome: "running", version: "2026.10.6", access: "new" });
    expect(report?.found).not.toBeNull();
  });

  it("F-515: another version is named and not offered for Connect", async () => {
    const report = await look(
      homeWorld(),
      fakeRunner(defaultTable(statusJson({ port: 18789, answered: "2026.9.37" }))).run,
    );
    expect(report?.look).toMatchObject({ outcome: "untested", version: "2026.9.37" });
    expect(report?.found).toBe(null);
    const newer = await look(
      homeWorld(),
      fakeRunner(defaultTable(statusJson({ port: 18789, answered: "2026.11.2" }))).run,
    );
    expect(newer?.look.outcome).toBe("untested");
  });

  it("F-515: a reported version below the automatic setup floor is too old", async () => {
    const report = await look(
      homeWorld(),
      fakeRunner(defaultTable(statusJson({ port: 18789, answered: "2026.6.2" }))).run,
    );
    expect(report?.look).toMatchObject({ outcome: "too-old", version: "2026.6.2" });
    expect(report?.found).toBe(null);
  });

  it("F-515: a version of the wrong shape is a gateway the look can't tell", async () => {
    const program = await look(
      homeWorld(),
      fakeRunner({ ...defaultTable(), "--version": { stdout: "openclaw version 9\n" } }).run,
    );
    expect(program?.look).toMatchObject({ outcome: "cant-tell", reason: "shape" });
    const gateway = await look(
      homeWorld(),
      fakeRunner(defaultTable(statusJson({ port: 18789, answered: "v10; rm -rf" }))).run,
    );
    expect(gateway?.look).toMatchObject({ outcome: "cant-tell", reason: "shape" });
    expect(gateway?.found).toBe(null);
  });

  it("a gateway that signs in another way than a token is named and not connected to", async () => {
    const report = await look(
      homeWorld(),
      fakeRunner(defaultTable(statusJson({ port: 18789 }), authJson("password"))).run,
    );
    expect(report?.look).toMatchObject({ outcome: "not-token", authMode: "password" });
    expect(report?.found).toBe(null);
  });

  it("a gateway started by hand and stopped is installed but not running", async () => {
    const report = await look(
      homeWorld(),
      fakeRunner(defaultTable(statusJson({ port: 18789, answered: null }))).run,
    );
    expect(report?.look).toMatchObject({
      outcome: "stopped",
      version: "2026.10.6",
      service: "none",
      port: 18789,
    });
    expect(report?.found).toBe(null);
  });

  it("a registered service that is stopped, with nothing listening, is proven stopped", async () => {
    const report = await look(
      homeWorld(),
      fakeRunner(
        defaultTable(
          statusJson({ port: 18789, answered: null, service: "stopped", targetRole: "gateway" }),
        ),
      ).run,
    );
    expect(report?.look).toMatchObject({ outcome: "stopped", service: "launchagent-stopped" });
  });

  it("a service that runs, or a port that is taken, without an answer can't be told", async () => {
    for (const status of [
      statusJson({ port: 18789, answered: null, service: "running" }),
      statusJson({ port: 18789, answered: null, listening: true }),
    ]) {
      const report = await look(homeWorld(), fakeRunner(defaultTable(status)).run);
      expect(report?.look).toMatchObject({ outcome: "cant-tell", reason: "no-answer" });
    }
  });

  it("a step that times out can't be told", async () => {
    const report = await look(
      homeWorld(),
      fakeRunner({ ...defaultTable(), "gateway status --json": { timedOut: true, exitCode: null } })
        .run,
    );
    expect(report?.look).toMatchObject({ outcome: "cant-tell", reason: "timeout" });
  });

  it("a program with no gateway set up can't be told, and offers nothing to connect to", async () => {
    const report = await look(
      homeWorld(),
      fakeRunner(defaultTable(statusJson({ configExists: false, answered: null }))).run,
    );
    expect(report?.look).toMatchObject({ outcome: "cant-tell", reason: "not-set-up" });
  });

  it("no program, no ~/.openclaw and no service is not found, and nothing runs", async () => {
    const { run, requests } = fakeRunner({});
    const report = await look(homeWorld({ program: false }), run);
    expect(report?.look.outcome).toBe("not-found");
    expect(requests).toEqual([]);
  });

  it("no program, with ~/.openclaw or a service, is set up with its program missing", async () => {
    const world = homeWorld({ program: false });
    mkdirSync(join(world.home, ".openclaw"));
    expect((await look(world, fakeRunner({}).run))?.look.outcome).toBe("program-missing");
    rmSync(join(world.home, ".openclaw"), { recursive: true });
    mkdirSync(join(world.home, "Library/LaunchAgents"), { recursive: true });
    writeFileSync(join(world.home, "Library/LaunchAgents/ai.openclaw.gateway.plist"), "");
    expect((await look(world, fakeRunner({}).run))?.look.outcome).toBe("program-missing");
  });

  it("a file that is not executable is not the program", async () => {
    const world = homeWorld({ program: false });
    mkdirSync(join(world.home, ".local/bin"), { recursive: true });
    writeFileSync(world.candidates[1]!, "not a program");
    expect((await look(world, fakeRunner({}).run))?.look.outcome).toBe("not-found");
  });

  it("on Windows the look doesn't run", async () => {
    const { run, requests } = fakeRunner(defaultTable());
    const report = await look(homeWorld({ platform: "win32" }), run);
    expect(report?.look.outcome).toBe("windows");
    expect(requests).toEqual([]);
  });

  it("F-516: other services and profiles are named and never asked; only the default profile and Clawtrate's own are", async () => {
    const world = homeWorld();
    mkdirSync(join(world.home, ".openclaw-work"));
    mkdirSync(join(world.home, ".openclaw-clawtrate"));
    const status = statusJson({
      port: 18789,
      extraServices: [{ label: "com.example.openclaw-gateway" }, { label: "bad; label" }],
    });
    const { run, requests } = fakeRunner({
      ...defaultTable(status),
      "--profile clawtrate gateway status --json": {
        stdout: statusJson({ port: 19300, answered: null }),
      },
      "--profile clawtrate config get gateway.auth.mode --json": { stdout: authJson() },
    });
    const report = await look(world, run);
    expect(report?.look.outcome).toBe("running");
    expect(report?.look.profile).toBe("default");
    expect(report?.look.others).toEqual(["service com.example.openclaw-gateway", "profile work"]);
    const asked = requests.map((request) => request.args.join(" "));
    expect(asked.filter((args) => args.includes("work"))).toEqual([]);
    expect(asked).toContain("--profile clawtrate gateway status --json");
    // The deep status is read for its other services only, once.
    expect(asked.filter((args) => args.endsWith("--deep"))).toEqual([
      "gateway status --json --deep",
    ]);
  });

  it("F-516: Clawtrate's own profile is chosen when the default profile has no gateway", async () => {
    const world = homeWorld();
    mkdirSync(join(world.home, ".openclaw-clawtrate"));
    const report = await look(
      world,
      fakeRunner({
        ...defaultTable(statusJson({ port: 18789, configExists: false, answered: null })),
        "--profile clawtrate gateway status --json": { stdout: statusJson({ port: 19300 }) },
        "--profile clawtrate config get gateway.auth.mode --json": { stdout: authJson() },
      }).run,
    );
    expect(report?.look).toMatchObject({ outcome: "running", profile: "clawtrate", port: 19300 });
    expect(report?.found?.profile.args).toEqual(["--profile", "clawtrate"]);
  });

  it("F-516: a gateway Connect can use is chosen over the default profile's untested one; between two it can use, the default", async () => {
    const world = homeWorld();
    mkdirSync(join(world.home, ".openclaw-clawtrate"));
    const clawtrate = {
      "--profile clawtrate gateway status --json": { stdout: statusJson({ port: 19300 }) },
      "--profile clawtrate config get gateway.auth.mode --json": { stdout: authJson() },
    };
    const untested = await look(
      world,
      fakeRunner({
        ...defaultTable(statusJson({ port: 18789, answered: "2026.9.37" })),
        ...clawtrate,
      }).run,
    );
    expect(untested?.look).toMatchObject({ outcome: "running", profile: "clawtrate", port: 19300 });
    expect(untested?.found?.port).toBe(19300);
    const both = await look(world, fakeRunner({ ...defaultTable(), ...clawtrate }).run);
    expect(both?.look).toMatchObject({ outcome: "running", profile: "default", port: 18789 });
  });

  it("F-492: a program file replaced while the look asks it is not offered for Connect", async () => {
    const world = homeWorld();
    const program = join(world.home, ".local/bin/openclaw");
    const { run } = fakeRunner({
      ...defaultTable(),
      "gateway status --json": () => {
        writeFileSync(program, "#!/bin/sh\n# another program\nexit 0\n");
        return { stdout: statusJson({ port: 18789 }) };
      },
    });
    const report = await look(world, run);
    expect(report?.found).toBeNull();
    expect(report?.look).toMatchObject({ outcome: "cant-tell", reason: "endpoint" });
  });

  it("F-516: a found gateway is identified by its profile, config path, service, port and answer", async () => {
    const report = await look(homeWorld(), fakeRunner(defaultTable()).run);
    expect(report?.found).toMatchObject({
      configPath: "<state>/openclaw.json",
      port: 18789,
      version: "2026.10.6",
    });
    expect(report?.found?.profile.name).toBe("default");
    expect(report?.look.service).toBe("none");
  });

  it("runs every program in the world's own working folder, never the app's", async () => {
    const world = homeWorld();
    const { run, requests } = fakeRunner(defaultTable());
    await look(world, run);
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) expect(request.cwd).toBe(world.home);
  });

  it("F-516: a sandboxed look never runs the deep status", async () => {
    const at = fake.world();
    const run = fake.instance({
      home: at.home,
      checkout: at.checkout,
      name: "su1-test",
      run: fake.runId("a"),
    });
    const { file } = fake.runFolder(join(at.base, "runs"), { instance: run.name, run: run.run });
    const { identify } = fake.identities();
    const opener = sandboxOpener({
      file,
      platform: "darwin",
      context: {
        platform: process.platform,
        home: at.home,
        uid: at.uid,
        checkout: at.checkout,
        identify,
      },
      startGateway: () => Promise.reject(new Error("no gateway in this scenario")),
    });
    const opened = await opener.open();
    if (opened instanceof SetupRefusedError) throw opened;
    const requests: ProgramRequest[] = [];
    const report = await look(
      opened.world,
      (request) => {
        requests.push(request);
        return opened.run(request);
      },
      opened.identify,
    );
    expect(report?.look.outcome).toBe("running");
    expect(requests.map((request) => request.args.slice(2).join(" ")).sort()).toEqual([
      "--version",
      "config get gateway.auth.mode --json",
      "gateway status --json",
    ]);
  });

  it("F-516: a gateway that answered somewhere other than its own loopback port isn't offered", async () => {
    for (const status of [
      statusJson({ port: 18789, rpcUrl: "ws://127.0.0.1:18790" }),
      statusJson({ port: 18789, probeUrl: "ws://127.0.0.1:18790" }),
      statusJson({ port: 18789, rpcUrl: "wss://127.0.0.1:18789" }),
      statusJson({ port: 18789, probeUrl: "ws://192.0.2.10:18789" }),
    ]) {
      const report = await look(homeWorld(), fakeRunner(defaultTable(status)).run);
      expect(report?.look).toMatchObject({ outcome: "cant-tell", reason: "endpoint" });
      expect(report?.found).toBe(null);
    }
  });

  it("F-516: only the exact endpoint is a gateway Connect may use: IPv6, localhost, TLS, a path, a query, a user or another port is not", async () => {
    const at = (probe: string, rpc = probe) =>
      statusJson({ port: 19940, probeUrl: probe, rpcUrl: rpc });
    for (const status of [
      at("ws://[::1]:19940"),
      at("ws://localhost:19940"),
      at("wss://127.0.0.1:19940"),
      at("ws://127.0.0.1:19940/gateway"),
      at("ws://127.0.0.1:19940/?token=x"),
      at("ws://someone@127.0.0.1:19940"),
      at("ws://127.0.0.1:19940//"),
      at("ws://127.0.0.1:19940", "ws://[::1]:19940"),
      at("ws://127.0.0.1:19941", "ws://127.0.0.1:19940"),
      withStatus(statusJson({ port: 19940 }), (value) => {
        value.port.port = 19941;
      }),
    ]) {
      const report = await look(homeWorld(), fakeRunner(defaultTable(status)).run);
      expect(report?.look, status.slice(0, 0)).toMatchObject({
        outcome: "cant-tell",
        reason: "endpoint",
      });
      expect(report?.found).toBeNull();
    }
    // One terminal slash is the same address.
    const slash = await look(
      homeWorld(),
      fakeRunner(defaultTable(at("ws://127.0.0.1:19940/"))).run,
    );
    expect(slash?.found?.url).toBe("ws://127.0.0.1:19940");
  });

  it("F-516: an omitted daemon config path is allowed, but an invalid one makes status unusable", () => {
    const status = statusJson();
    const omitted = withStatus(status, (value) => {
      delete value.config.daemon.path;
    });
    expect(parseStatus(omitted)?.daemonConfigPath).toBeNull();
    for (const path of [null, 42, "", "x".repeat(1025)]) {
      const malformed = withStatus(status, (value) => {
        value.config.daemon.path = path;
      });
      expect(parseStatus(malformed)).toBeNull();
    }
  });

  it.each(["unit", "targetRole"])("F-516: the whole service %s identifies the service", (field) => {
    const status = (suffix: string) =>
      withStatus(statusJson(), (value) => {
        value.service[field] = "x".repeat(128) + suffix;
      });
    const first = parseStatus(status("1"));
    const second = parseStatus(status("2"));
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.serviceKey).not.toBe(second!.serviceKey);
  });

  it("F-516: a gateway with no identifiable listener, two listeners, a listener that isn't running, or another config file for its service is not offered", async () => {
    const cases = [
      withStatus(statusJson({ port: 19940 }), (value) => {
        value.port.listeners = [];
      }),
      withStatus(statusJson({ port: 19940 }), (value) => {
        value.port.listeners.push({ pid: 5151, address: "127.0.0.1:19940" });
      }),
      withStatus(statusJson({ port: 19940 }), (value) => {
        value.port.listeners[0].address = "0.0.0.0:19940";
      }),
      withStatus(statusJson({ port: 19940 }), (value) => {
        value.config.daemon.path = "<other>/openclaw.json";
      }),
    ];
    for (const status of cases) {
      const report = await look(homeWorld(), fakeRunner(defaultTable(status)).run);
      expect(report?.look).toMatchObject({ outcome: "cant-tell", reason: "endpoint" });
      // Nothing Connect could use either.
      expect(report?.found).toBeNull();
    }
    const gone = await look(
      homeWorld(),
      fakeRunner(defaultTable(statusJson({ port: 19940 }))).run,
      () => ({
        state: "exited",
        how: "absent",
      }),
    );
    expect(gone?.look).toMatchObject({ outcome: "cant-tell", reason: "endpoint" });
    expect(gone?.found).toBeNull();
    // The positive control: one listener, alive, the same config.
    const found = await look(
      homeWorld(),
      fakeRunner(defaultTable(statusJson({ port: 19940 }))).run,
    );
    expect(found?.found).toMatchObject({
      url: "ws://127.0.0.1:19940",
      listener: { pid: 4242, started: LISTENER_STARTED },
    });
    // The identities stay in the host: none of them is in what the interface sees.
    expect(JSON.stringify(found?.look)).not.toContain("4242");
    expect(JSON.stringify(found?.look)).not.toContain(LISTENER_STARTED);
  });

  it("F-516: two profiles that report the same endpoint can't be told apart, and neither is offered; distinct endpoints choose the default", async () => {
    const world = homeWorld();
    mkdirSync(join(dir, "home/.openclaw-clawtrate"), { recursive: true });
    const same = await look(
      world,
      fakeRunner({
        ...defaultTable(statusJson({ port: 19940 })),
        "--profile clawtrate gateway status --json": { stdout: statusJson({ port: 19940 }) },
        "--profile clawtrate config get gateway.auth.mode --json": { stdout: authJson() },
      }).run,
    );
    expect(same?.look).toMatchObject({ outcome: "cant-tell", reason: "endpoint" });
    expect(same?.found).toBeNull();
    const distinct = await look(
      world,
      fakeRunner({
        ...defaultTable(statusJson({ port: 19940 })),
        "--profile clawtrate gateway status --json": { stdout: statusJson({ port: 19960 }) },
        "--profile clawtrate config get gateway.auth.mode --json": { stdout: authJson() },
      }).run,
    );
    expect(distinct?.look).toMatchObject({ outcome: "running", profile: "default", port: 19940 });
  });

  it("F-516: Clawtrate's own profile is looked at only when its state is a real folder, not a file or a link", async () => {
    for (const make of [
      () => writeFileSync(join(dir, "home/.openclaw-clawtrate"), "x"),
      () => {
        mkdirSync(join(dir, "elsewhere"), { recursive: true });
        symlinkSync(join(dir, "elsewhere"), join(dir, "home/.openclaw-clawtrate"));
      },
    ]) {
      rmSync(join(dir, "home"), { recursive: true, force: true });
      const world = homeWorld();
      make();
      const { run, requests } = fakeRunner(defaultTable(statusJson({ port: 19940 })));
      await look(world, run);
      expect(requests.some((request) => request.args.includes("clawtrate"))).toBe(false);
    }
  });

  it("F-516: a bind or a service the status doesn't describe is not reported, never a fact", async () => {
    const odd = await look(
      homeWorld(),
      fakeRunner(defaultTable(statusJson({ port: 18789, bind: "mystery" }))).run,
    );
    expect(odd?.look.listens).toBe(null);
    const unknown = await look(
      homeWorld(),
      fakeRunner(defaultTable(statusJson({ port: 18789, label: "Something else" }))).run,
    );
    expect(unknown?.look.service).toBe(null);
    const diagnostic = await look(
      homeWorld(),
      fakeRunner(defaultTable(statusJson({ port: 18789, service: "unknown" }))).run,
    );
    expect(diagnostic?.look.service).toBe(null);
  });

  it("F-516: a file named like a profile's folder is not a profile", async () => {
    const world = homeWorld();
    writeFileSync(join(world.home, ".openclaw-work"), "not a folder");
    symlinkSync(join(dir, "app"), join(world.home, ".openclaw-linked"));
    const report = await look(world, fakeRunner(defaultTable()).run);
    expect(report?.look.others).toEqual([]);
  });

  it("a status or auth command that can't be started is the program's own result, at each stage, with nothing after it", async () => {
    for (const [key, reply] of [
      ["gateway status --json", { failed: true, exitCode: null }],
      ["gateway status --json", { exitCode: 127 }],
      ["config get gateway.auth.mode --json", { failed: true, exitCode: null }],
      ["config get gateway.auth.mode --json", { exitCode: 126 }],
    ] as const) {
      const { run, requests } = fakeRunner({ ...defaultTable(), [key]: reply });
      const report = await look(homeWorld(), run);
      expect(report?.look.outcome, `${key} ${JSON.stringify(reply)}`).toBe("cant-run");
      expect(report?.found).toBeNull();
      // Only the version and the one stage's commands ran.
      for (const request of requests)
        expect([
          "--version",
          "gateway status --json",
          "config get gateway.auth.mode --json",
          "gateway status --json --deep",
        ]).toContain(request.args.join(" "));
    }
  });

  it("a program that can't be started is its own result, not an answer of the wrong shape", async () => {
    for (const reply of [{ failed: true, exitCode: null }, { exitCode: 127 }, { exitCode: 126 }]) {
      const report = await look(
        homeWorld(),
        fakeRunner({ ...defaultTable(), "--version": reply }).run,
      );
      expect(report?.look.outcome).toBe("cant-run");
    }
  });

  it("F-516: Clawtrate's own profile is not asked when its folder isn't there", async () => {
    const { run, requests } = fakeRunner(defaultTable());
    await look(homeWorld(), run);
    expect(requests.some((request) => request.args.includes("clawtrate"))).toBe(false);
  });
});

describe("the sandbox: a run's description, its folder and its proven instance", () => {
  /**
   * Three fake account homes, one checkout with two runs, and the account
   * the host runs as. The first run is this description's; the second is a
   * legitimate named run of the same checkout that the description doesn't
   * select. Every check counts what it read and which processes it asked.
   */
  function setting(options: { description?: unknown; port?: number } = {}) {
    const at = fake.world();
    const mine = fake.instance({
      home: at.home,
      checkout: at.checkout,
      name: "su1-test",
      run: fake.runId("a"),
      ...(options.port === undefined ? {} : { port: options.port }),
    });
    const other = fake.instance({
      home: at.home,
      checkout: at.checkout,
      name: "su1-other",
      run: fake.runId("b"),
      port: 19960,
    });
    const folder = fake.runFolder(
      join(at.base, "runs"),
      options.description ?? { instance: mine.name, run: mine.run },
    );
    const files = fake.counting();
    const processes = fake.identities();
    const context = {
      platform: process.platform,
      home: at.home,
      uid: at.uid,
      checkout: at.checkout,
      files: files.files,
      identify: processes.identify,
    } satisfies SandboxContext & Parameters<typeof proveRun>[1];
    let gateways = 0;
    const opener = (file = folder.file) =>
      sandboxOpener({
        file,
        platform: "darwin",
        context,
        startGateway: () => {
          gateways += 1;
          return Promise.reject(new Error("no gateway here"));
        },
      });
    /** Opens and returns the refusal's reason, or "opened". */
    const outcome = async (file = folder.file) => {
      const opened = await opener(file).open();
      return opened instanceof SetupRefusedError ? opened.reason : "opened";
    };
    return {
      ...at,
      mine,
      other,
      ...folder,
      files,
      processes,
      context,
      opener,
      outcome,
      gateways: () => gateways,
    };
  }

  /** Nothing was read but the description, no process was asked about, no gateway started. */
  const stoppedAtTheDescription = (s: ReturnType<typeof setting>) => {
    expect(s.files.reads.every((path) => path.endsWith("/sandbox.json"))).toBe(true);
    expect(s.processes.asked).toEqual([]);
    expect(s.gateways()).toBe(0);
  };

  it("opens a description in a private run folder whose instance is this run's, with its home, working folder and the stand-in", async () => {
    const s = setting();
    const opened = await s.opener().open();
    if (opened instanceof SetupRefusedError) throw opened;
    expect(opened.world).toMatchObject({
      kind: "sandbox",
      home: join(s.root, "home"),
      cwd: join(s.root, "work"),
      candidates: [],
      installed: { program: STAND_IN_PROGRAM, signs: true },
      env: {},
      serviceFiles: [],
      deep: false,
      pairs: false,
    });
    expect(opened.world.profiles).toEqual([
      {
        name: "clawtrate-dev-su1-test",
        args: ["--profile", "clawtrate-dev-su1-test"],
        stateDir: s.mine.stateDir,
        required: true,
        env: {},
      },
    ]);
    // The description, the instance's marker, this checkout's run record, and the description
    // again once the run is proven: nothing else is read.
    expect(s.files.reads).toEqual([
      s.file,
      join(s.mine.stateDir, MARKER_FILE),
      join(s.checkout, "tools/dev-gateway/.run/instances/su1-test/state.json"),
      s.file,
    ]);
    expect(s.processes.asked).toEqual([fake.GATEWAY_PID]);
    // A development instance's port is never one Connect may use.
    expect(opened.world.portAllowed(s.mine.port)).toBe(false);
  });

  it("a pairing gateway that failed to start is started again on the next open, and closing after a failed start settles", async () => {
    const s = setting({
      description: { instance: "su1-test", run: fake.runId("a"), scenario: "pairing" },
    });
    let starts = 0;
    let closes = 0;
    const server = {
      url: "ws://127.0.0.1:19999",
      port: 19999,
      mint: () => ({ url: "ws://127.0.0.1:19999", bootstrapToken: "x", expiresAtMs: 0 }),
      ownsListener: () => true,
      close: async () => {
        closes += 1;
      },
    };
    const opener = sandboxOpener({
      file: s.file,
      platform: "darwin",
      context: s.context,
      startGateway: () => {
        starts += 1;
        return starts === 1 ? first.promise : Promise.resolve(server);
      },
    });
    const first = Promise.withResolvers<typeof server>();
    const opening = opener.open();
    // Shutdown while the start is under way, which then fails: it settles, with nothing to close.
    const closing = opener.close();
    first.reject(new Error("port in use"));
    await expect(closing).resolves.toBeUndefined();
    expect(await opening).toBeInstanceOf(SetupRefusedError);
    const opened = await opener.open();
    if (opened instanceof SetupRefusedError) throw opened;
    expect(starts).toBe(2);
    expect(opened.ownsListener?.(19999)).toBe(true);
    await opener.close();
    expect(closes).toBe(1);
  });

  it("takes exactly an instance, its run and a scenario from the closed set, and nothing that names a program, a folder or a port", () => {
    const run = fake.runId("a");
    expect(parseDescription(JSON.stringify({ instance: "su1-test", run }))).toEqual({
      instance: "su1-test",
      run,
      scenario: "recorded",
    });
    for (const scenario of SCENARIOS)
      expect(
        parseDescription(JSON.stringify({ instance: "su1-test", run, scenario })).scenario,
      ).toBe(scenario);
    const refused = [
      { instance: "su1-test", run, scenario: "live" },
      { instance: "su1-test", run, openclaw: "/tmp/openclaw" },
      { instance: "su1-test", run, stateDir: "/tmp/state" },
      { instance: "su1-test", run, home: "/tmp/home" },
      { instance: "su1-test", run, facts: "/tmp/facts.json" },
      { instance: "su1-test", run, port: 19940 },
      { instance: "su1-test", run: "abc" },
      { instance: "default", run },
      { instance: "dev", run },
      { instance: "preview-accounts", run },
      { instance: "../.openclaw", run },
      [],
      null,
    ];
    for (const value of refused)
      expect(() => parseDescription(JSON.stringify(value)), JSON.stringify(value)).toThrow(
        SetupRefusedError,
      );
    expect(() => parseDescription("{")).toThrow(SetupRefusedError);
  });

  it("S1: explicit null is refused as an invalid scenario", () => {
    expect(() =>
      parseDescription(
        JSON.stringify({ instance: "su1-test", run: fake.runId("a"), scenario: null }),
      ),
    ).toThrow(SetupRefusedError);
    // Left out, it is the recorded scenario.
    expect(
      parseDescription(JSON.stringify({ instance: "su1-test", run: fake.runId("a") })).scenario,
    ).toBe("recorded");
  });

  it("refuses a description outside a private run folder below the system's temporary root, before reading it", async () => {
    const s = setting();
    // Not named sandbox.json, relative, not normal.
    for (const path of [
      join(s.root, "other.json"),
      "sandbox.json",
      `${s.root}/../${s.root.split("/").pop()}/sandbox.json`,
    ])
      expect(await s.outcome(path), path).toBe("file");
    // A folder that isn't under one of the system's temporary roots.
    expect(() =>
      validateSandbox(s.file, {
        ...s.context,
        roots: [{ canonical: "/nowhere", names: ["/nowhere"] }],
      }),
    ).toThrow(SetupRefusedError);
    // A folder others can enter.
    chmodSync(s.root, 0o755);
    expect(await s.outcome()).toBe("file");
    chmodSync(s.root, 0o700);
    expect(s.files.reads).toEqual([]);
    stoppedAtTheDescription(s);
  });

  it("refuses a temporary root redirected into a fake home, a linked ancestor, and a run folder inside or around the account's home", async () => {
    const s = setting();
    // A folder in the temporary root that is a link into the account's home.
    const target = join(s.home, "redirected");
    mkdirSync(target);
    const { file } = fake.runFolder(target, { instance: s.mine.name, run: s.mine.run });
    symlinkSync(target, join(s.base, "redirect"));
    expect(await s.outcome(join(s.base, "redirect", file.split("/").slice(-2).join("/")))).toBe(
      "file",
    );
    // The run folder itself in the account's home: never, even below the temporary root.
    expect(await s.outcome(file)).toBe("home");
    // The account's home inside the run folder.
    const around = fake.runFolder(join(s.base, "around"), {
      instance: s.mine.name,
      run: s.mine.run,
    });
    expect(
      validateSandbox.bind(null, around.file, { ...s.context, home: join(around.root, "home") }),
    ).toThrow(/outside the account's home/);
    expect(s.files.reads).toEqual([]);
    stoppedAtTheDescription(s);
  });

  it("F-492: refuses a run folder below a folder another account could replace it through", async () => {
    const s = setting();
    const shared = join(s.base, "shared");
    const box = fake.runFolder(shared, { instance: s.mine.name, run: s.mine.run });
    // A folder above the run folder that its group and others may write, without the sticky bit:
    // anyone could rename the run folder away and put their own in its place.
    chmodSync(shared, 0o777);
    expect(await s.outcome(box.file)).toBe("file");
    chmodSync(shared, 0o775);
    expect(await s.outcome(box.file)).toBe("file");
    // Sticky, as the temporary root is: only an entry's owner may rename it.
    chmodSync(shared, 0o1777);
    expect(await s.outcome(box.file)).toBe("opened");
    // Owned by another account, even unwritable to others.
    chmodSync(shared, 0o755);
    const lstat = s.context.files.lstat;
    s.context.files.lstat = (path) => {
      const entry = lstat(path);
      return path === shared && entry ? Object.assign(Object.create(entry), { uid: 4321 }) : entry;
    };
    expect(await s.outcome(box.file)).toBe("file");
    s.context.files.lstat = lstat;
    expect(await s.outcome(box.file)).toBe("opened");
  });

  it("refuses a description, a home or a working folder that is a link, a second link to the description, and another account's file", async () => {
    const s = setting();
    // The description a link to a good one elsewhere.
    const elsewhere = fake.runFolder(join(s.base, "elsewhere"), {
      instance: s.mine.name,
      run: s.mine.run,
    });
    const linked = fake.runFolder(join(s.base, "linked"), "{}");
    rmSync(linked.file);
    symlinkSync(elsewhere.file, linked.file);
    expect(await s.outcome(linked.file)).toBe("file");
    // A hard link to it.
    const hard = fake.runFolder(join(s.base, "hard"), "{}");
    rmSync(hard.file);
    linkSync(elsewhere.file, hard.file);
    expect(await s.outcome(hard.file)).toBe("file");
    // Its home or working folder a link.
    for (const folder of ["home", "work"]) {
      const box = fake.runFolder(join(s.base, `link-${folder}`), {
        instance: s.mine.name,
        run: s.mine.run,
      });
      rmSync(join(box.root, folder), { recursive: true });
      symlinkSync(join(s.home), join(box.root, folder));
      expect(await s.outcome(box.file), folder).toBe("file");
    }
    // Another account's description.
    expect(() => validateSandbox(s.file, { ...s.context, uid: (s.uid ?? 0) + 1 })).toThrow(
      SetupRefusedError,
    );
    expect(s.processes.asked).toEqual([]);
    expect(s.gateways()).toBe(0);
  });

  it("S2: setup refuses a linked app-data directory before starting the host", () => {
    const s = setting();
    rmSync(join(s.root, "app-data"), { recursive: true });
    symlinkSync(s.home, join(s.root, "app-data"));
    const launched = resolveSetupLaunch({
      packaged: true,
      env: {},
      switches: (name) => name === "clawtrate-setup-sandbox",
      switchValue: (name) => (name === "clawtrate-setup-sandbox" ? s.file : ""),
      context: s.context,
    });
    expect(launched.kind === "refused" && launched.error.reason).toBe("file");
    expect(s.files.reads).toEqual([]);
    expect(s.processes.asked).toEqual([]);
  });

  it("refuses when the account can't be read, instead of trusting HOME", async () => {
    const s = setting();
    expect(accountHome(() => ({ homedir: "/accounts/someone" }))).toBe("/accounts/someone");
    expect(
      accountHome(() => {
        throw new Error("no account");
      }),
    ).toBeNull();
    expect(accountHome(() => ({ homedir: "relative" }))).toBeNull();
    expect(() => validateSandbox(s.file, { ...s.context, home: null })).toThrow(SetupRefusedError);
    expect(() =>
      proveRun(parseDescription(JSON.stringify({ instance: "su1-test", run: s.mine.run })), {
        ...s.context,
        home: null,
      }),
    ).toThrow(SetupRefusedError);
    // HOME and the working folder of this process play no part.
    const saved = process.env.HOME;
    process.env.HOME = s.root;
    try {
      const opened = await s.opener().open();
      expect(opened instanceof SetupRefusedError ? opened.reason : opened.world.home).toBe(
        join(s.root, "home"),
      );
    } finally {
      // An absent HOME is put back absent, not as the text "undefined".
      if (saved === undefined) delete process.env.HOME;
      else process.env.HOME = saved;
    }
  });

  it("refuses unrelated state in the account's home, a second legitimate run, and a run of another checkout or account", async () => {
    // An instance folder that isn't the tool's: no marker.
    const bare = setting({ description: { instance: "unrelated", run: fake.runId("a") } });
    mkdirSync(join(bare.home, ".openclaw-clawtrate-dev-unrelated"));
    expect(await bare.outcome()).toBe("state");
    // An instance nobody started.
    const none = setting({ description: { instance: "nobody", run: fake.runId("a") } });
    expect(await none.outcome()).toBe("state");
    // The second run, named with the first's run id, and the first with the second's.
    const crossed = setting({ description: { instance: "su1-other", run: fake.runId("a") } });
    expect(await crossed.outcome()).toBe("state");
    const swapped = setting({ description: { instance: "su1-test", run: fake.runId("b") } });
    expect(await swapped.outcome()).toBe("state");
    // The same instance in another fake account's home is never looked at.
    const s = setting();
    fake.instance({
      home: s.homes[1]!,
      checkout: s.checkout,
      name: "su1-third",
      run: fake.runId("c"),
    });
    const third = fake.runFolder(join(s.base, "third"), {
      instance: "su1-third",
      run: fake.runId("c"),
    });
    expect(await s.outcome(third.file)).toBe("state");
    // A run recorded by another checkout.
    const foreign = setting();
    const elsewhere = join(foreign.base, "other-checkout");
    mkdirSync(elsewhere);
    expect(
      proveRun.bind(
        null,
        { instance: "su1-test", run: fake.runId("a"), scenario: "recorded" },
        { ...foreign.context, checkout: elsewhere },
      ),
    ).toThrow(SetupRefusedError);
    for (const each of [bare, none, crossed, swapped]) expect(each.processes.asked).toEqual([]);
  });

  it("refuses a forged, stale or mismatched marker or run record, and a port off its block", async () => {
    const cases: Array<
      [
        string,
        Parameters<typeof fake.instance>[0]["marker"],
        Parameters<typeof fake.instance>[0]["record"],
      ]
    > = [
      // Forged: the shape the old guard trusted, a name and a port.
      [
        "forged",
        { runId: undefined, checkout: undefined, startPid: undefined, startIdentity: undefined },
        undefined,
      ],
      ["another tool", { createdBy: "someone else" }, undefined],
      ["another instance", { instance: "su1-elsewhere" }, undefined],
      ["stale run", { runId: fake.runId("d") }, undefined],
      ["another checkout", { checkout: "/elsewhere" }, undefined],
      ["ports disagree", undefined, { gatewayPort: 19980 }],
      ["provider ports disagree", undefined, { providerPort: 19981 }],
      ["no run record", undefined, null],
    ];
    for (const [name, marker, record] of cases) {
      const at = fake.world();
      fake.instance({
        home: at.home,
        checkout: at.checkout,
        name: "su1-test",
        run: fake.runId("a"),
        ...(marker ? { marker } : {}),
        ...(record !== undefined ? { record } : {}),
      });
      const processes = fake.identities();
      expect(
        () =>
          proveRun(
            { instance: "su1-test", run: fake.runId("a"), scenario: "recorded" },
            { home: at.home, uid: at.uid, checkout: at.checkout, identify: processes.identify },
          ),
        name,
      ).toThrow(SetupRefusedError);
      // Without a run file the gateway is asked about once: only a stopped one passes.
      expect(processes.asked, name).toEqual(name === "no run record" ? [fake.GATEWAY_PID] : []);
    }
    // A port in the range but not the first of its block, a reserved one, and OpenClaw's default.
    for (const port of [19941, 19600 + 1, 18789]) {
      const at = fake.world();
      fake.instance({
        home: at.home,
        checkout: at.checkout,
        name: "su1-test",
        run: fake.runId("a"),
        port,
      });
      expect(
        () =>
          proveRun(
            { instance: "su1-test", run: fake.runId("a"), scenario: "recorded" },
            {
              home: at.home,
              uid: at.uid,
              checkout: at.checkout,
              identify: fake.identities().identify,
            },
          ),
        String(port),
      ).toThrow(SetupRefusedError);
    }
  });

  it("refuses a linked default or named state, a linked home, and links among the state's files, reading nothing past them", async () => {
    // The named state folder a link to a folder holding a good marker.
    const linked = setting();
    renameSync(linked.mine.stateDir, join(linked.base, "moved-state"));
    symlinkSync(join(linked.base, "moved-state"), linked.mine.stateDir);
    expect(await linked.outcome()).toBe("state");
    expect(linked.files.reads).toEqual([linked.file]);
    // A fake account whose default state is a link, with a marker in it: a description can't reach it at all.
    const defaults = setting({
      description: {
        instance: "su1-test",
        run: fake.runId("a"),
        stateDir: join(fake.base(), ".openclaw"),
      },
    });
    expect(await defaults.outcome()).toBe("file");
    // The account's home reached through a link.
    const home = setting();
    symlinkSync(home.home, join(home.base, "home-link"));
    expect(
      proveRun.bind(
        null,
        { instance: "su1-test", run: fake.runId("a"), scenario: "recorded" },
        { ...home.context, home: join(home.base, "home-link") },
      ),
    ).toThrow(SetupRefusedError);
    // The marker a link, the config a link or a second link to another file.
    const marker = setting();
    renameSync(join(marker.mine.stateDir, MARKER_FILE), join(marker.base, "marker"));
    symlinkSync(join(marker.base, "marker"), join(marker.mine.stateDir, MARKER_FILE));
    expect(await marker.outcome()).toBe("state");
    for (const kind of ["symlink", "hard link"]) {
      const config = setting();
      const path = join(config.mine.stateDir, "openclaw.json");
      writeFileSync(join(config.base, "elsewhere.json"), "{}");
      rmSync(path);
      if (kind === "symlink") symlinkSync(join(config.base, "elsewhere.json"), path);
      else linkSync(join(config.base, "elsewhere.json"), path);
      expect(await config.outcome(), kind).toBe("state");
      // The gateway is identified first; the config is looked at only after it.
      expect(config.processes.asked, kind).toEqual([fake.GATEWAY_PID]);
    }
    expect(linked.processes.asked).toEqual([]);
    // A state folder another account owns.
    const owned = setting();
    const others = {
      ...owned.files.files,
      lstat: (path: string) => {
        const entry = owned.files.files.lstat(path);
        return entry && path === owned.mine.stateDir
          ? Object.assign(Object.create(entry) as typeof entry, { uid: entry.uid + 1 })
          : entry;
      },
    };
    expect(() =>
      proveRun(
        { instance: "su1-test", run: fake.runId("a"), scenario: "recorded" },
        { ...owned.context, files: others },
      ),
    ).toThrow(SetupRefusedError);
    expect(owned.files.reads).toEqual([]);
  });

  it("S4: a linked run-record parent is refused before its record is read", async () => {
    const s = setting();
    const path = join(s.checkout, "tools/dev-gateway/.run");
    const elsewhere = join(s.base, "records-elsewhere");
    renameSync(path, elsewhere);
    symlinkSync(elsewhere, path);
    expect(await s.outcome()).toBe("state");
    expect(s.files.reads).not.toContain(join(path, "instances", s.mine.name, "state.json"));
    expect(s.processes.asked).toEqual([]);
  });

  it("S4: a recorded live instance is required to identify its gateway before inspecting config", async () => {
    const s = setting();
    s.context.identify = () => ({ state: "unknown", reason: "no process answer" });
    expect(await s.outcome()).toBe("state");
    expect(s.files.lookups).not.toContain(join(s.mine.stateDir, "openclaw.json"));
  });

  it("S4: a pending gateway cannot count as a stopped instance", () => {
    const at = fake.world();
    const name = "su1-test";
    const run = fake.runId("a");
    fake.instance({
      home: at.home,
      checkout: at.checkout,
      name,
      run,
      marker: { gatewayPid: undefined, gatewayIdentity: undefined, gatewayPending: true },
      record: null,
    });
    expect(() =>
      proveRun(
        { instance: name, run, scenario: "recorded" },
        { ...at, identify: fake.identities(new Set()).identify },
      ),
    ).toThrow(SetupRefusedError);
  });

  it("S4: a malformed run record is not treated as an absent record", async () => {
    const s = setting();
    s.processes.alive.clear();
    writeFileSync(
      join(s.checkout, "tools/dev-gateway/.run/instances", s.mine.name, "state.json"),
      "{",
    );
    expect(await s.outcome()).toBe("state");
  });

  it("says an instance `stop` ended is stopped, from its marker alone, and refuses a live gateway without its run record", async () => {
    // As `pnpm dev-gateway stop` leaves it: the run file removed, the marker kept.
    const at = fake.world();
    fake.instance({
      home: at.home,
      checkout: at.checkout,
      name: "su1-test",
      run: fake.runId("a"),
      record: null,
    });
    const processes = fake.identities(new Set());
    const proof = proveRun(
      { instance: "su1-test", run: fake.runId("a"), scenario: "recorded" },
      { home: at.home, uid: at.uid, checkout: at.checkout, identify: processes.identify },
    );
    expect(proof).toMatchObject({ running: false, port: 19940 });
    // Its gateway alive: a run file is needed to prove it this checkout's.
    expect(() =>
      proveRun(
        { instance: "su1-test", run: fake.runId("a"), scenario: "recorded" },
        { home: at.home, uid: at.uid, checkout: at.checkout, identify: fake.identities().identify },
      ),
    ).toThrow(SetupRefusedError);
    // The marker of another checkout, or of another run, is not this one's even when stopped.
    for (const marker of [{ checkout: "/elsewhere" }, { runId: fake.runId("d") }]) {
      const other = fake.world();
      fake.instance({
        home: other.home,
        checkout: other.checkout,
        name: "su1-test",
        run: fake.runId("a"),
        record: null,
        marker,
      });
      expect(() =>
        proveRun(
          { instance: "su1-test", run: fake.runId("a"), scenario: "recorded" },
          {
            home: other.home,
            uid: other.uid,
            checkout: other.checkout,
            identify: fake.identities(new Set()).identify,
          },
        ),
      ).toThrow(SetupRefusedError);
    }
  });

  it("says a stopped instance is stopped, from its own records, and refuses one it can't tell", async () => {
    const stopped = setting();
    stopped.processes.alive.clear();
    const opened = await stopped.opener().open();
    if (opened instanceof SetupRefusedError) throw opened;
    const report = await lookHere(opened.world, opened.run, { identify: opened.identify });
    expect(report?.look.outcome).toBe("stopped");
    const unknown = setting();
    const proof = () =>
      proveRun(
        { instance: "su1-test", run: fake.runId("a"), scenario: "recorded" },
        {
          ...unknown.context,
          identify: () => ({ state: "unknown", reason: "ps failed" }),
        },
      );
    expect(proof).toThrow(SetupRefusedError);
  });

  /** The markers and switches the design names, written out: not read from the code under test. */
  const MARKERS = [
    "CLAWTRATE_E2E_RUN",
    "CLAWTRATE_AUTOMATED",
    "CLAWTRATE_SCREENSHOT",
    "CLAWTRATE_SETUP_SANDBOX",
    "VITEST",
    "CI",
  ];
  const SWITCHES = [
    "remote-debugging-port",
    "remote-debugging-pipe",
    "inspect",
    "inspect-brk",
    "clawtrate-setup-sandbox",
  ];

  it("must sandbox a development build, any marker present at all, any switch, and a sandbox named by the environment", () => {
    const none = () => false;
    expect(mustSandbox({ packaged: true, env: {}, switches: none })).toBe(false);
    expect(mustSandbox({ packaged: false, env: {}, switches: none })).toBe(true);
    expect([...SANDBOX_MARKERS]).toEqual(MARKERS);
    expect([...SANDBOX_SWITCHES]).toEqual(SWITCHES);
    for (const key of MARKERS) {
      expect(mustSandbox({ packaged: true, env: { [key]: "" }, switches: none }), key).toBe(true);
    }
    for (const name of SWITCHES) {
      expect(mustSandbox({ packaged: true, env: {}, switches: (n) => n === name }), name).toBe(
        true,
      );
    }
    expect(SANDBOX_MARKERS).toContain("CLAWTRATE_SETUP_SANDBOX");
  });

  it("resolves the launch: every marker alone, the environment's file alone, a bare or empty switch, and the switch over the environment", () => {
    const s = setting();
    const second = fake.runFolder(join(s.base, "second"), {
      instance: s.mine.name,
      run: s.mine.run,
    });
    const launch = (options: {
      packaged?: boolean;
      env?: NodeJS.ProcessEnv;
      switches?: Record<string, string>;
    }) =>
      resolveSetupLaunch({
        packaged: options.packaged ?? true,
        env: options.env ?? {},
        switches: (name) => Object.hasOwn(options.switches ?? {}, name),
        switchValue: (name) => options.switches?.[name] ?? "",
        context: s.context,
      });
    expect(launch({}).kind).toBe("production");
    // An unmarked packaged start reads and looks up nothing at all.
    expect(s.files.reads).toEqual([]);
    expect(s.files.lookups).toEqual([]);
    const refused = (value: ReturnType<typeof launch>) =>
      value.kind === "refused" ? value.error.reason : value.kind;
    // Each marker by itself, no debugging switch, no file: refused, as given none.
    for (const key of MARKERS.filter((key) => key !== "CLAWTRATE_SETUP_SANDBOX"))
      expect(refused(launch({ env: { [key]: "1" } })), key).toBe("missing");
    expect(refused(launch({ packaged: false }))).toBe("missing");
    // The environment's file alone.
    const fromEnv = launch({ env: { CLAWTRATE_SETUP_SANDBOX: second.file } });
    expect(fromEnv.kind === "sandbox" && fromEnv.file).toBe(second.file);
    // An empty variable, and a bare switch: sandboxed, and given none.
    expect(refused(launch({ env: { CLAWTRATE_SETUP_SANDBOX: "" } }))).toBe("missing");
    expect(refused(launch({ switches: { "clawtrate-setup-sandbox": "" } }))).toBe("missing");
    // A bare switch with the environment's file: that file.
    const bare = launch({
      switches: { "clawtrate-setup-sandbox": "" },
      env: { CLAWTRATE_SETUP_SANDBOX: second.file },
    });
    expect(bare.kind === "sandbox" && bare.file).toBe(second.file);
    // Both given: the switch's.
    const both = launch({
      switches: { "clawtrate-setup-sandbox": s.file },
      env: { CLAWTRATE_SETUP_SANDBOX: second.file },
    });
    expect(both.kind === "sandbox" && both.file).toBe(s.file);
    // Windows looks at nothing, whatever it is given; a bad file is refused with its reason.
    expect(
      resolveSetupLaunch({
        packaged: false,
        env: {},
        switches: () => false,
        switchValue: () => "",
        context: { ...s.context, platform: "win32" },
      }).kind,
    ).toBe("windows");
    expect(
      refused(launch({ switches: { "clawtrate-setup-sandbox": "/tmp/nowhere/sandbox.json" } })),
    ).toBe("file");
    expect(s.processes.asked).toEqual([]);
  });

  it("never lets Connect use a port its world doesn't allow, and never OpenClaw's default in a sandbox", () => {
    const sandbox = {
      ...homeWorld(),
      kind: "sandbox" as const,
      portAllowed: (port: number) => port === 18789,
    };
    expect(() => guardPort(18789, sandbox)).toThrow(SetupRefusedError);
    expect(() => guardPort(19940, sandbox)).toThrow(SetupRefusedError);
    expect(() => guardPort(18789, homeWorld())).not.toThrow();
  });
});
