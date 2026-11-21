// Named instances, process proof, locks and deletion. Every test runs under a
// fresh temporary HOME and run folder; no real profile is read and no OpenClaw
// process is started. The only processes started are `sleep` stand-ins and
// lock workers, stopped by PID.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { devConfig, list, prune, reset, sandboxProblems, start, stop } from "../src/cli.ts";
import { guardArgs, OpenclawRunner, openclawEnv, providerEnv } from "../src/env.ts";
import {
  INSTANCE_ENV,
  instanceFromStateDirName,
  isNamedInstancePort,
  NAMED_PORT_RANGE,
  profileArgs,
  profileFor,
  selectInstance,
  stateDirFor,
  validateInstanceName,
} from "../src/instance.ts";
import { instanceLockPath, portLockPath, withLock } from "../src/lock.ts";
import { candidateBlocks, choosePorts } from "../src/registry.ts";
import {
  inUseRefusal,
  MARKER_FILE,
  newRunId,
  readMarker,
  spawnRefusal,
  StateInUseError,
} from "../src/state-guard.ts";
import {
  CHECKOUT,
  childFor,
  children,
  deadProcess,
  liveProcess,
  OTHER_CHECKOUT,
  seedInstance,
  snapshot,
  stopChildren,
  tempDir,
  testInstance,
  writeRun,
} from "./fixtures.ts";

afterAll(stopChildren);
afterEach(() => vi.restoreAllMocks());

const WORKER = join(import.meta.dirname, "lock-worker.ts");
const CLI = join(import.meta.dirname, "../src/cli.ts");

/** An instance whose OpenClaw spawns are recorded and never executed. */
function recordingInstance(home: string, name: string | null, runRoot: string) {
  const calls: { args: string[]; env: NodeJS.ProcessEnv; cwd: string }[] = [];
  const record = (_bin: string, args: string[], options: { env: NodeJS.ProcessEnv; cwd: string }) =>
    calls.push({ args, env: options.env, cwd: options.cwd });
  const fakeSpawnSync = ((bin: string, args: string[], options: never) => {
    record(bin, args, options);
    return { status: 0, stdout: "", stderr: "" };
  }) as unknown as typeof spawnSync;
  const fakeSpawn = ((bin: string, args: string[], options: never) => {
    record(bin, args, options);
    throw new Error("a test must never reach a real spawn");
  }) as unknown as typeof spawn;
  const base = testInstance(home, runRoot, name);
  const runner = new OpenclawRunner({
    instance: name,
    stateDir: base.stateDir,
    runFile: base.runFile,
    checkout: CHECKOUT,
    spawnImpl: fakeSpawn,
    spawnSyncImpl: fakeSpawnSync,
  });
  return { inst: testInstance(home, runRoot, name, { runner }), runner, calls };
}

/** Every signal the code under test sends. Signal 0, a liveness probe, is not counted. */
function watchSignals() {
  const real = process.kill.bind(process);
  const sent: [number, string | number | undefined][] = [];
  vi.spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number) => {
    if (signal !== 0) sent.push([pid, signal]);
    return real(pid, signal);
  });
  return sent;
}

function worker(...args: string[]): ChildProcess {
  const child = spawn(process.execPath, [WORKER, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  return child;
}

function output(child: ChildProcess, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let all = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      all += chunk.toString("utf8");
      if (all.includes(text)) resolve(all);
    });
    child.once("exit", (code) =>
      all.includes(text) ? resolve(all) : reject(new Error(`exit ${code}: ${all}`)),
    );
  });
}

const exited = (child: ChildProcess) =>
  new Promise<number | null>((resolve) =>
    child.exitCode !== null ? resolve(child.exitCode) : child.once("exit", (code) => resolve(code)),
  );

const runRecord = (runId: string, checkout = CHECKOUT) => ({
  runId,
  instance: "alpha",
  checkout,
  gatewayPort: 19240,
  providerPort: 19250,
  startedAt: "",
});

describe("instance names", () => {
  it("accepts short lowercase names with inner hyphens", () => {
    for (const name of ["a", "alpha", "e2e-1a2b3c4d", "x-y-z", "a".repeat(24), "0"]) {
      expect(validateInstanceName(name)).toBe(name);
    }
  });

  it("rejects anything else before a path is built", () => {
    for (const name of [
      "",
      "Alpha",
      "ALPHA",
      "-a",
      "a-",
      "a_b",
      "a.b",
      "a b",
      " a",
      "a\n",
      "a/b",
      "../a",
      "..",
      ".",
      "~",
      "a".repeat(25),
      "é",
    ]) {
      expect(() => validateInstanceName(name), JSON.stringify(name)).toThrow(
        /refusing instance name/,
      );
      expect(() => profileFor(name)).toThrow(/refusing instance name/);
      expect(() => stateDirFor(name, "/state/x")).toThrow(/refusing instance name/);
    }
    expect(() => validateInstanceName(undefined)).toThrow(/not a string/);
  });

  it("never resolves to the default profile, the --dev profile or an unprefixed one", () => {
    for (const name of ["default", "Default", "DEFAULT", "dev", "DEV", "Dev"]) {
      expect(() => validateInstanceName(name)).toThrow(/refusing instance name/);
    }
    const home = "/state/x";
    for (const name of ["alpha", "e2e-0", "openclaw", "clawtrate-dev", "default-1", "dev-1"]) {
      expect(profileFor(name)).toBe(`clawtrate-dev-${name}`);
      expect(profileArgs(name)).toEqual(["--profile", `clawtrate-dev-${name}`]);
      const dir = stateDirFor(name, home);
      expect(dir).toBe(join(home, `.openclaw-clawtrate-dev-${name}`));
      expect(dir).not.toBe(join(home, ".openclaw"));
      expect(dir).not.toBe(join(home, ".openclaw-dev"));
    }
    expect(profileArgs(null)).toEqual(["--dev"]);
    expect(stateDirFor(null, home)).toBe(join(home, ".openclaw-dev"));
  });

  it("is selected by --instance or the environment, never both disagreeing", () => {
    expect(selectInstance(undefined, {})).toBeNull();
    expect(selectInstance(undefined, { [INSTANCE_ENV]: "" })).toBeNull();
    expect(selectInstance("alpha", {})).toBe("alpha");
    expect(selectInstance(undefined, { [INSTANCE_ENV]: "beta" })).toBe("beta");
    expect(selectInstance("alpha", { [INSTANCE_ENV]: "alpha" })).toBe("alpha");
    expect(() => selectInstance("alpha", { [INSTANCE_ENV]: "beta" })).toThrow(/disagree/);
    expect(() => selectInstance(undefined, { [INSTANCE_ENV]: "default" })).toThrow(/refusing/);
  });

  it("maps state folder names back only for the tool's own instances", () => {
    expect(instanceFromStateDirName(".openclaw-dev")).toBeNull();
    expect(instanceFromStateDirName(".openclaw-clawtrate-dev-alpha")).toBe("alpha");
    for (const entry of [".openclaw", ".openclaw-roster-probe", ".openclaw-clawtrate-dev-Bad"]) {
      expect(instanceFromStateDirName(entry)).toBeUndefined();
    }
  });

  it("the CLI validates the selector before any command and creates nothing (A4)", () => {
    const home = tempDir("clawtrate-home-");
    const run = (args: string[], env: NodeJS.ProcessEnv = {}) =>
      spawnSync(process.execPath, [CLI, ...args], {
        env: { PATH: process.env.PATH, HOME: home, ...env },
        encoding: "utf8",
      });
    for (const args of [
      ["start", "--instance", "../../.openclaw"],
      ["reset", "--instance", "default"],
      ["status", "--instance", "DEV"],
      ["prune", "--instance", "../bad"],
      ["list", "--instance", "../bad"],
    ]) {
      const result = run(args);
      expect(result.status, args.join(" ")).toBe(1);
      expect(result.stderr).toMatch(/refusing instance name/);
    }
    expect(run(["stop"], { [INSTANCE_ENV]: "a/b" }).status).toBe(1);
    // A valid selector on the machine-wide commands is refused, not ignored.
    for (const [args, env] of [
      [["prune", "--instance", "alpha"], {}],
      [["prune"], { [INSTANCE_ENV]: "beta" }],
      [["list", "--instance", "alpha"], {}],
    ] as const) {
      const result = run([...args], env);
      expect(result.status, args.join(" ")).toBe(1);
      expect(result.stderr).toMatch(/covers every instance on this machine/);
    }
    const disagree = run(["prune", "--instance", "alpha"], { [INSTANCE_ENV]: "beta" });
    expect(disagree.status).toBe(1);
    expect(disagree.stderr).toMatch(/disagree/);
    expect(readdirSync(home)).toEqual([]);
    // Starts the CLI as a process for each case: seconds alone, many more on a loaded machine.
  }, 120_000);
});

describe("per-instance folders, markers and the spawn boundary", () => {
  it("gives each instance its own state folder, run folder and marker", () => {
    const home = tempDir("clawtrate-home-");
    const runRoot = tempDir("clawtrate-run-");
    const alpha = testInstance(home, runRoot, "alpha");
    const dflt = testInstance(home, runRoot, null);
    expect(alpha.stateDir).toBe(join(home, ".openclaw-clawtrate-dev-alpha"));
    expect(alpha.runFile).toBe(join(runRoot, "instances/alpha/state.json"));
    expect(alpha.connectionFile).toBe(join(runRoot, "instances/alpha/connection.json"));
    expect(dflt.stateDir).toBe(join(home, ".openclaw-dev"));
    expect(dflt.runFile).toBe(join(runRoot, "state.json"));
    seedInstance(home, "alpha");
    expect(readMarker(alpha.stateDir)!.instance).toBe("alpha");
    expect(existsSync(dflt.stateDir)).toBe(false);
  });

  it("runs OpenClaw with the instance's profile, folder and recorded port only", () => {
    const home = tempDir("clawtrate-home-");
    const runRoot = tempDir("clawtrate-run-");
    const { stateDir, runId } = seedInstance(home, "alpha", { runRoot });
    const { runner, calls } = recordingInstance(home, "alpha", runRoot);
    runner.freshRunId = runId;
    runner.runSync(["config", "validate"]);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.args).toEqual(["--profile", "clawtrate-dev-alpha", "config", "validate"]);
    expect(call!.cwd).toBe(stateDir);
    expect(call!.env.OPENCLAW_PROFILE).toBe("clawtrate-dev-alpha");
    expect(call!.env.OPENCLAW_STATE_DIR).toBe(stateDir);
    expect(call!.env.OPENCLAW_GATEWAY_PORT).toBe("19240");
  });

  it("never lets a caller pick the profile", () => {
    expect(guardArgs(["agents", "list"], "alpha")).toEqual([
      "--profile",
      "clawtrate-dev-alpha",
      "agents",
      "list",
    ]);
    expect(guardArgs(["agents", "list"])).toEqual(["--dev", "agents", "list"]);
    for (const bad of ["--dev", "--profile", "--profile=default"]) {
      expect(() => guardArgs(["agents", bad], "alpha")).toThrow(/never selects another/);
    }
  });

  it("keeps the environment allowlist for named instances", () => {
    const shell = { PATH: "/usr/bin", OPENAI_API_KEY: "secret", OPENCLAW_PROFILE: "default" };
    const env = openclawEnv(shell, { name: "alpha", stateDir: "/h/.x", gatewayPort: 19240 });
    expect(Object.keys(env).sort()).toEqual(
      [
        "PATH",
        "HOME",
        "OPENCLAW_PROFILE",
        "OPENCLAW_STATE_DIR",
        "OPENCLAW_CONFIG_PATH",
        "OPENCLAW_GATEWAY_PORT",
        "NO_COLOR",
      ].sort(),
    );
    expect(env.OPENCLAW_PROFILE).toBe("clawtrate-dev-alpha");
    expect(providerEnv(shell, 19250)).toEqual({
      PATH: "/usr/bin",
      SCRIPTED_PROVIDER_PORT: "19250",
    });
  });

  it("checks the generated config against the instance's own ports", () => {
    const ports = { gatewayPort: 19240, providerPort: 19250 };
    expect(sandboxProblems(devConfig("t", ports), ports)).toEqual([]);
    expect(sandboxProblems(devConfig("t"), ports)).toEqual([
      "gateway.port must be 19240, found 19001",
      'proxy.proxyUrl must be "http://127.0.0.1:19250", found "http://127.0.0.1:19091"',
      'models.providers.scripted.baseUrl must be "http://127.0.0.1:19250/v1", found "http://127.0.0.1:19091/v1"',
      'plugins.entries.ollama.config.webSearch.baseUrl must be "http://127.0.0.1:19250", found "http://127.0.0.1:19091"',
    ]);
  });

  it("refuses a folder whose marker names another instance or a port outside the range", () => {
    const home = tempDir("clawtrate-home-");
    const { stateDir: beta } = seedInstance(home, "beta");
    const alphaDir = stateDirFor("alpha", home);
    mkdirSync(alphaDir);
    writeFileSync(join(alphaDir, MARKER_FILE), readFileSync(join(beta, MARKER_FILE)));
    const check = (stateDir: string, instance: string, freshRunId: string | null = null) =>
      spawnRefusal({ stateDir, run: null, freshRunId, instance, checkout: CHECKOUT });
    expect(check(alphaDir, "alpha")).toMatch(/names instance "beta", not "alpha"/);

    const { stateDir: gamma, runId } = seedInstance(home, "gamma", {
      marker: { gatewayPort: 18789 },
    });
    expect(check(gamma, "gamma", runId)).toMatch(/records no valid ports/);
    expect(isNamedInstancePort(18789)).toBe(false);
    expect(isNamedInstancePort(19001)).toBe(false);
  });
});

describe("stop signals only processes it can prove are this checkout's (A1)", () => {
  it("never signals a PID of -1, 0, 1 or a non-integer, and then signals nothing at all", async () => {
    for (const pid of [-1, 0, 1, 1.5, "123"]) {
      const home = tempDir("clawtrate-home-");
      const runRoot = tempDir("clawtrate-run-");
      const provider = liveProcess();
      seedInstance(home, "alpha", {
        runRoot,
        provider,
        marker: { gatewayPid: pid, gatewayIdentity: "x" },
      });
      const sent = watchSignals();
      await expect(stop(testInstance(home, runRoot, "alpha")), String(pid)).rejects.toThrow(
        /Nothing was signalled/,
      );
      expect(sent).toEqual([]);
      expect(childFor(provider.pid).exitCode).toBeNull();
      vi.restoreAllMocks();
    }
  });

  it("never signals a recorded PID the system has given to another process", async () => {
    const home = tempDir("clawtrate-home-");
    const runRoot = tempDir("clawtrate-run-");
    const unrelated = liveProcess();
    seedInstance(home, "alpha", {
      runRoot,
      gateway: { pid: unrelated.pid, identity: "1970-01-01T00:00:00Z" },
    });
    const sent = watchSignals();
    const inst = testInstance(home, runRoot, "alpha");
    await stop(inst);
    expect(sent).toEqual([]);
    expect(childFor(unrelated.pid).exitCode).toBeNull();
    expect(existsSync(inst.runFile)).toBe(false);
  });

  it("signals nothing for a run file without a marker, or in an older format", async () => {
    const home = tempDir("clawtrate-home-");
    const runRoot = tempDir("clawtrate-run-");
    const victim = liveProcess();
    const inst = testInstance(home, runRoot, "alpha");
    const sent = watchSignals();
    // Only a run file, naming a live process, with no state folder at all.
    writeRun(inst.runFile, { runId: newRunId(), gatewayPid: victim.pid, startedAt: "" });
    await expect(stop(inst)).rejects.toThrow(/not a run file this version of the tool wrote/);
    writeRun(inst.runFile, { ...runRecord(newRunId()), gatewayPid: victim.pid });
    // The folder is gone, so the file proves nothing and is dropped.
    await stop(inst);
    expect(existsSync(inst.runFile)).toBe(false);
    expect(sent).toEqual([]);
    expect(childFor(victim.pid).exitCode).toBeNull();
  });

  it("refuses when the run file and the marker disagree on the checkout", async () => {
    const home = tempDir("clawtrate-home-");
    const runRoot = tempDir("clawtrate-run-");
    const gateway = liveProcess();
    const { runId } = seedInstance(home, "alpha", { gateway, checkout: OTHER_CHECKOUT });
    const inst = testInstance(home, runRoot, "alpha");
    writeRun(inst.runFile, runRecord(runId));
    const sent = watchSignals();
    await expect(stop(inst)).rejects.toThrow(/run file and the marker disagree/);
    expect(sent).toEqual([]);
    expect(childFor(gateway.pid).exitCode).toBeNull();
  });

  it("stops the processes it proves, and only those", async () => {
    const home = tempDir("clawtrate-home-");
    const runRoot = tempDir("clawtrate-run-");
    const gateway = liveProcess();
    const provider = liveProcess();
    seedInstance(home, "alpha", { runRoot, gateway, provider });
    const bystander = liveProcess();
    const sent = watchSignals();
    await stop(testInstance(home, runRoot, "alpha"));
    expect(sent.map(([pid]) => pid).sort()).toEqual([gateway.pid, provider.pid].sort());
    expect(childFor(bystander.pid).exitCode).toBeNull();
  });
});

describe("a gateway another checkout started", () => {
  for (const name of [null, "alpha"] as const) {
    const which = name === null ? "the default instance" : "a named instance";

    it(`start and reset refuse ${which} and leave it byte for byte untouched`, async () => {
      const home = tempDir("clawtrate-home-");
      const runRoot = tempDir("clawtrate-run-");
      const gateway = liveProcess();
      const { stateDir } = seedInstance(home, name, { gateway, checkout: OTHER_CHECKOUT });
      const before = snapshot(stateDir);
      const { inst, calls } = recordingInstance(home, name, runRoot);
      const sent = watchSignals();

      await expect(start(inst)).rejects.toBeInstanceOf(StateInUseError);
      await expect(start(inst)).rejects.toThrow(
        new RegExp(
          `${name === null ? "the default instance" : 'instance "alpha"'} \\(${stateDir}\\) is in use: ` +
            `its gateway process \\(pid ${gateway.pid}\\) is still running and was started by another checkout \\(${OTHER_CHECKOUT}\\)`,
        ),
      );
      await expect(reset(inst)).rejects.toBeInstanceOf(StateInUseError);

      expect(snapshot(stateDir)).toEqual(before);
      expect(calls).toEqual([]);
      expect(sent).toEqual([]);
      expect(readdirSync(runRoot)).toEqual([]);
      expect(childFor(gateway.pid).exitCode).toBeNull();
    });
  }

  it("does not count this checkout's own run as another checkout's", () => {
    const home = tempDir("clawtrate-home-");
    const { stateDir, runId } = seedInstance(home, "alpha", { gateway: liveProcess() });
    const ours = runRecord(runId);
    expect(inUseRefusal(stateDir, "alpha", ours, CHECKOUT)).toBeNull();
    expect(inUseRefusal(stateDir, "alpha", null, CHECKOUT)).toMatch(/in use/);
    expect(inUseRefusal(stateDir, "alpha", runRecord(newRunId()), CHECKOUT)).toMatch(/in use/);
    expect(inUseRefusal(stateDir, "alpha", ours, OTHER_CHECKOUT)).toMatch(/in use/);
  });
});

describe("deletion needs proof that nothing runs (A5)", () => {
  it("refuses a marker with missing process fields", async () => {
    for (const name of [null, "alpha"]) {
      const home = tempDir("clawtrate-home-");
      const runRoot = tempDir("clawtrate-run-");
      const stateDir = stateDirFor(name, home);
      mkdirSync(stateDir);
      // Ownership magic and a run id, but nothing that identifies the processes.
      writeFileSync(
        join(stateDir, MARKER_FILE),
        JSON.stringify({
          createdBy: "clawtrate tools/dev-gateway",
          runId: newRunId(),
          instance: name,
        }),
      );
      writeFileSync(join(stateDir, "openclaw.json"), "{}");
      liveProcess(); // the gateway it no longer identifies
      const before = snapshot(stateDir);
      await expect(reset(testInstance(home, runRoot, name))).rejects.toThrow(
        /cannot trust: .*records no start process/,
      );
      if (name !== null) {
        const lines: string[] = [];
        await prune({ home, runRoot, listening: async () => false, log: (l) => lines.push(l) });
        expect(lines.join("\n")).toMatch(/Kept .*cannot trust/);
      }
      expect(snapshot(stateDir)).toEqual(before);
    }
  });

  it("refuses a marker whose process record is incomplete", async () => {
    const home = tempDir("clawtrate-home-");
    const { stateDir } = seedInstance(home, "alpha", { marker: { gatewayPid: liveProcess().pid } });
    const before = snapshot(stateDir);
    await expect(reset(testInstance(home, tempDir("clawtrate-run-"), "alpha"))).rejects.toThrow(
      /gateway process record is incomplete/,
    );
    expect(snapshot(stateDir)).toEqual(before);
  });

  it("refuses a marker that names another instance", async () => {
    const home = tempDir("clawtrate-home-");
    const { stateDir: beta } = seedInstance(home, "beta");
    const alphaDir = stateDirFor("alpha", home);
    mkdirSync(alphaDir);
    writeFileSync(join(alphaDir, MARKER_FILE), readFileSync(join(beta, MARKER_FILE)));
    const before = snapshot(alphaDir);
    await expect(reset(testInstance(home, tempDir("clawtrate-run-"), "alpha"))).rejects.toThrow(
      /names instance "beta", not "alpha"/,
    );
    expect(snapshot(alphaDir)).toEqual(before);
  });

  it("refuses every old-format marker, live or not, with or without fields (A5)", async () => {
    const shapes: Record<string, Record<string, unknown>> = {
      // Before instances: the default instance only, no instance field.
      "pre-instance, live gateway": { runId: "old", gatewayPid: liveProcess().pid },
      "pre-instance, no process fields": { runId: newRunId() },
      "pre-instance, nothing but the magic": {},
      // fdea2bf: instance, ports and checkout, but no process identities.
      "fdea2bf, processes gone": {
        runId: newRunId(),
        instance: null,
        gatewayPort: 19001,
        providerPort: 19091,
        checkout: CHECKOUT,
        startPid: deadProcess().pid,
        gatewayPid: deadProcess().pid,
        providerPid: deadProcess().pid,
      },
    };
    for (const [shape, fields] of Object.entries(shapes)) {
      const home = tempDir("clawtrate-home-");
      const runRoot = tempDir("clawtrate-run-");
      const stateDir = stateDirFor(null, home);
      mkdirSync(stateDir);
      writeFileSync(
        join(stateDir, MARKER_FILE),
        JSON.stringify({ createdBy: "clawtrate tools/dev-gateway", ...fields }),
      );
      writeFileSync(join(stateDir, "openclaw.json"), "{}");
      const before = snapshot(stateDir);
      const { inst, calls } = recordingInstance(home, null, runRoot);
      for (const attempt of [() => reset(inst), () => start(inst, { seed: false })]) {
        await expect(attempt(), shape).rejects.toThrow(/older version of this tool/);
      }
      expect(calls, shape).toEqual([]);
      expect(snapshot(stateDir), shape).toEqual(before);
    }
  });

  it("refuses while anything listens on the instance's ports, 19001 for the default instance", async () => {
    for (const [name, port] of [
      [null, 19001],
      ["alpha", 19240],
    ] as const) {
      const home = tempDir("clawtrate-home-");
      const runRoot = tempDir("clawtrate-run-");
      const { stateDir } = seedInstance(home, name);
      const before = snapshot(stateDir);
      const listening = async (p: number) => p === port;
      await expect(reset(testInstance(home, runRoot, name, { listening }))).rejects.toThrow(
        new RegExp(`listening on its port ${port}`),
      );
      if (name !== null) {
        const lines: string[] = [];
        await prune({ home, runRoot, listening, log: (line) => lines.push(line) });
        expect(lines.join("\n")).toMatch(/Kept .*listening on its port 19240/);
      }
      expect(snapshot(stateDir)).toEqual(before);
    }
  });

  it("removes an instance once everything recorded on it is proven gone", async () => {
    const home = tempDir("clawtrate-home-");
    const runRoot = tempDir("clawtrate-run-");
    const { stateDir } = seedInstance(home, "alpha", {
      runRoot,
      gateway: deadProcess(),
      provider: deadProcess(),
    });
    const inst = testInstance(home, runRoot, "alpha");
    await reset(inst);
    expect(existsSync(stateDir)).toBe(false);
    expect(existsSync(inst.runDir)).toBe(false);
  });

  it("reset with a run id removes only that run's folder (A4)", async () => {
    const home = tempDir("clawtrate-home-");
    const runRoot = tempDir("clawtrate-run-");
    const { stateDir, runId } = seedInstance(home, "alpha");
    const other = seedInstance(home, "other-checkout", { checkout: OTHER_CHECKOUT });
    const otherBefore = snapshot(other.stateDir);
    const before = snapshot(stateDir);
    await expect(
      reset(testInstance(home, runRoot, "alpha"), { runId: newRunId() }),
    ).rejects.toThrow(/holds another run/);
    expect(snapshot(stateDir)).toEqual(before);
    await reset(testInstance(home, runRoot, "alpha"), { runId });
    expect(existsSync(stateDir)).toBe(false);
    // A stopped instance of another checkout is not this run's to remove.
    expect(snapshot(other.stateDir)).toEqual(otherBefore);
  });
});

describe("one lock for the life of an instance (A3, A6)", () => {
  it("a crashed holder's lock goes to one contender at a time, across processes", async () => {
    const home = tempDir("clawtrate-home-");
    const lock = portLockPath(home);
    const holder = worker("hold", lock);
    await output(holder, "held");
    // While the holder lives, nobody else gets the lock.
    await expect(withLock(lock, async () => "got it", { timeoutMs: 300 })).rejects.toThrow(
      /timed out/,
    );
    holder.kill("SIGKILL");
    await exited(holder);
    const log = join(home, "contention.log");
    writeFileSync(log, "");
    const contenders = ["a", "b", "c", "d"].map((id) => worker("contend", lock, log, id, "150"));
    expect(await Promise.all(contenders.map(exited))).toEqual([0, 0, 0, 0]);
    const events = readFileSync(log, "utf8").trim().split("\n");
    expect(events).toHaveLength(8);
    for (let i = 0; i < events.length; i += 2) {
      const [kindIn, id] = events[i]!.split(" ");
      const [kindOut, idOut] = events[i + 1]!.split(" ");
      expect([kindIn, kindOut, idOut]).toEqual(["in", "out", id]);
    }
  });

  it("two starts after a crashed holder never get the same ports", async () => {
    const home = tempDir("clawtrate-home-");
    const holder = worker("hold", portLockPath(home));
    await output(holder, "held");
    holder.kill("SIGKILL");
    await exited(holder);
    // These two names begin at the same port block.
    expect(candidateBlocks("locka0")[0]).toBe(candidateBlocks("lockb20")[0]);
    const a = worker("allocate", home, "locka0");
    const b = worker("allocate", home, "lockb20");
    const [outA, outB] = await Promise.all([output(a, "}"), output(b, "}")]);
    const portsA = JSON.parse(outA) as { gatewayPort: number };
    const portsB = JSON.parse(outB) as { gatewayPort: number };
    expect(portsA.gatewayPort).not.toBe(portsB.gatewayPort);
  });

  it("reset and prune wait for a start in progress, then leave its new folder alone", async () => {
    for (const command of ["reset", "prune"] as const) {
      const home = tempDir("clawtrate-home-");
      const runRoot = tempDir("clawtrate-run-");
      // A stopped run that reset or prune would otherwise remove.
      const old = seedInstance(home, "race", { runRoot, gateway: deadProcess() });
      const starter = worker("replace", home, "race");
      await output(starter, "locked");
      if (command === "reset") {
        await expect(reset(testInstance(home, runRoot, "race"))).rejects.toThrow(
          /start process .* is still running/,
        );
      } else {
        await expect(
          prune({ home, runRoot, listening: async () => false, log: () => {} }),
        ).resolves.toEqual([]);
      }
      const marker = readMarker(old.stateDir)!;
      expect(marker.runId).not.toBe(old.runId);
      expect(marker.startPid).toBe(starter.pid);
      starter.kill("SIGTERM");
    }
  });

  it("locks each instance on its own and the ports separately", () => {
    const home = "/h";
    expect(instanceLockPath(home, null)).toBe("/h/.clawtrate-dev-gateway/locks/default.lock");
    expect(instanceLockPath(home, "alpha")).toMatch(/\/instance-\d+\.lock$/);
    expect(portLockPath(home)).toBe("/h/.clawtrate-dev-gateway/locks/ports.lock");
  });

  it("chooses ports that no other instance has recorded and that are free", async () => {
    const home = tempDir("clawtrate-home-");
    const free = async () => true;
    const first = await choosePorts("alpha", home, free);
    expect(first.gatewayPort).toBe(candidateBlocks("alpha")[0]);
    expect(first.providerPort).toBe(first.gatewayPort + 10);
    seedInstance(home, "alpha", { marker: first });
    const second = await choosePorts("alpha", home, free);
    expect(second.gatewayPort).not.toBe(first.gatewayPort);
    const busy = new Set([second.gatewayPort + 2]);
    const third = await choosePorts("alpha", home, async (port) => !busy.has(port));
    expect([first.gatewayPort, second.gatewayPort]).not.toContain(third.gatewayPort);
    for (const ports of [first, second, third]) {
      expect(isNamedInstancePort(ports.gatewayPort)).toBe(true);
      expect(ports.gatewayPort).toBeGreaterThanOrEqual(NAMED_PORT_RANGE.first);
    }
    await expect(choosePorts("alpha", home, async () => false)).rejects.toThrow(/no free port/);
  });
});

describe("instances side by side", () => {
  it("stop and reset of one instance leave the other's folder and processes alone", async () => {
    const home = tempDir("clawtrate-home-");
    const runRoot = tempDir("clawtrate-run-");
    const alphaGateway = liveProcess();
    const betaGateway = liveProcess();
    const alpha = seedInstance(home, "alpha", { runRoot, gateway: alphaGateway });
    const beta = seedInstance(home, "beta", {
      runRoot,
      gateway: betaGateway,
      marker: { gatewayPort: 19260, providerPort: 19270 },
    });
    const betaInst = testInstance(home, runRoot, "beta");
    const betaBefore = snapshot(beta.stateDir);
    const betaRunBefore = snapshot(betaInst.runDir);

    const alphaInst = testInstance(home, runRoot, "alpha");
    await stop(alphaInst);
    await exited(childFor(alphaGateway.pid));
    expect(childFor(alphaGateway.pid).signalCode).toBe("SIGTERM");
    await reset(alphaInst);
    expect(existsSync(alpha.stateDir)).toBe(false);

    expect(childFor(betaGateway.pid).exitCode).toBeNull();
    expect(childFor(betaGateway.pid).signalCode).toBeNull();
    expect(snapshot(beta.stateDir)).toEqual(betaBefore);
    expect(snapshot(betaInst.runDir)).toEqual(betaRunBefore);
  });
});

describe("listing and machine-wide pruning", () => {
  it("lists only the tool's folders and prunes only proven-idle named instances", async () => {
    const home = tempDir("clawtrate-home-");
    const runRoot = tempDir("clawtrate-run-");
    const live = liveProcess();
    seedInstance(home, null, { gateway: deadProcess() });
    const stale = seedInstance(home, "stale", { runRoot, gateway: deadProcess() });
    const other = seedInstance(home, "other-checkout", {
      gateway: deadProcess(),
      checkout: OTHER_CHECKOUT,
    });
    seedInstance(home, "live", { gateway: live, checkout: OTHER_CHECKOUT });
    seedInstance(home, "starting", { start: liveProcess() });
    for (const dir of [".openclaw", ".openclaw-roster-probe", ".openclaw-clawtrate-dev-unmarked"]) {
      mkdirSync(join(home, dir));
      writeFileSync(join(home, dir, "openclaw.json"), "{}");
    }

    const lines: string[] = [];
    const rows = list({ home, checkout: CHECKOUT, json: true, log: (line) => lines.push(line) });
    expect(rows.map((row) => row.name)).toEqual([
      null,
      "live",
      "other-checkout",
      "stale",
      "starting",
    ]);
    expect(JSON.parse(lines.join("\n"))).toEqual(rows);
    expect(rows.find((row) => row.name === "live")).toMatchObject({
      gatewayPid: live.pid,
      gatewayRunning: true,
      thisCheckout: false,
      checkout: OTHER_CHECKOUT,
    });

    const keep = [
      ".openclaw",
      ".openclaw-roster-probe",
      ".openclaw-clawtrate-dev-unmarked",
      ".openclaw-dev",
      ".openclaw-clawtrate-dev-live",
      ".openclaw-clawtrate-dev-starting",
    ];
    const before = Object.fromEntries(keep.map((dir) => [dir, snapshot(join(home, dir))]));
    // Deliberate maintenance: proven-idle named instances of any checkout go.
    const removed = await prune({ home, runRoot, listening: async () => false, log: () => {} });
    expect(removed.sort()).toEqual(["other-checkout", "stale"]);
    expect(existsSync(stale.stateDir)).toBe(false);
    expect(existsSync(other.stateDir)).toBe(false);
    for (const dir of keep) expect(snapshot(join(home, dir)), dir).toEqual(before[dir]);
  });
});
