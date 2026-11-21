// Process lookups that fail, records written before spawning, gated processes,
// and migrating from an older version of the tool. Everything runs under a
// temporary HOME; OpenClaw and the scripted model are replaced by `sleep`
// stand-ins, and no real port is probed or bound.
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { list, openInstance, prune, reset, start, stop } from "../src/cli.ts";
import { GATE_SCRIPT, gatedSpawn, OpenclawRunner } from "../src/env.ts";
import { stateDirFor } from "../src/instance.ts";
import { instanceLockPath, lockDir, withLock } from "../src/lock.ts";
import {
  MARKER_FILE,
  newRunId,
  processIdentity,
  processState,
  psIdentity,
  readMarker,
  type Identify,
} from "../src/state-guard.ts";
import {
  CHECKOUT,
  children,
  deadProcess,
  identityOf,
  liveProcess,
  seedInstance,
  snapshot,
  stopChildren,
  tempDir,
  testInstance,
  writeRun,
} from "./fixtures.ts";

afterAll(stopChildren);

const WORKER = join(import.meta.dirname, "lock-worker.ts");
const realPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = realPath;
});

/** A process lookup whose `ps` misbehaves as `script` says. */
function brokenPs(script: string): Identify {
  const dir = tempDir("clawtrate-ps-");
  writeFileSync(join(dir, "ps"), `#!/bin/sh\n${script}\n`);
  chmodSync(join(dir, "ps"), 0o755);
  return psIdentity([join(dir, "ps")]);
}

/** A process lookup with no `ps` at all. */
function noPs(): Identify {
  return psIdentity([join(tempDir("clawtrate-empty-path-"), "ps")]);
}

const FAILURES: [string, () => Identify][] = [
  ["ps exits with an error", () => brokenPs("exit 2")],
  ["ps prints something unreadable", () => brokenPs("echo '???'")],
  // Exit status 0 with words that are not a process row must not pass for an identity.
  ["ps prints an error message", () => brokenPs("echo 'ERROR permission denied'")],
  ["ps prints a state without a start time", () => brokenPs("echo 'S permission denied'")],
  ["ps prints a zombie state without a start time", () => brokenPs("echo 'Z garbage here'")],
  [
    "ps prints more than one row",
    () => brokenPs("printf 'S    Mon Nov 16 21:00:00 2026\\nS    Mon Nov 16 21:00:01 2026\\n'"),
  ],
  ["ps cannot be run", noPs],
];

/** The PID a worker prints as `pid <n>`. */
function printedPid(worker: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let all = "";
    worker.stdout!.on("data", (chunk: Buffer) => {
      all += chunk.toString("utf8");
      const match = /^pid (\d+)$/m.exec(all);
      if (match) resolve(Number(match[1]));
    });
    worker.once("exit", () => /^pid \d+$/m.test(all) || reject(new Error(all)));
  });
}

const waitUntil = async (check: () => boolean, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

describe("a process whose identity cannot be read is unknown, never exited (B2)", () => {
  it("reports alive, exited and zombie only on positive evidence", async () => {
    const live = liveProcess();
    expect(processIdentity(live.pid)).toEqual({ state: "alive", identity: live.identity });
    expect(processIdentity(deadProcess().pid)).toEqual({ state: "exited", how: "absent" });
    // A shell that starts a child and replaces itself with a process that never reaps it.
    const parent = spawn("/bin/sh", ["-c", "sleep 0 & exec sleep 30"], { stdio: "ignore" });
    children.push(parent);
    let zombie = 0;
    await waitUntil(() => {
      // pgrep leaves zombies out, so look for the child in the full process table.
      const table = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
      const row = table.stdout
        .split("\n")
        .map((line) => line.trim().split(/\s+/).map(Number))
        .find(([, ppid]) => ppid === parent.pid);
      zombie = row?.[0] ?? 0;
      return zombie > 1 && processIdentity(zombie).state === "exited";
    });
    expect(processIdentity(zombie)).toEqual({ state: "exited", how: "zombie" });
  });

  it("reads the state macOS ps shows for a process that is exiting", () => {
    const live = liveProcess();
    const exiting = brokenPs("echo '?E   Mon Nov 16 21:00:00 2026    '");
    expect(exiting(live.pid)).toEqual({
      state: "alive",
      identity: "Mon Nov 16 21:00:00 2026",
    });
  });

  it("stop waits through a lookup that briefly fails while the process exits", async () => {
    const home = tempDir("clawtrate-home-");
    const runRoot = tempDir("clawtrate-run-");
    const gateway = liveProcess();
    seedInstance(home, "alpha", { runRoot, gateway });
    // Once the process has exited, the next three lookups fail, as they can mid-exit.
    let failing = -1;
    const identify: Identify = (pid) => {
      const real = processIdentity(pid);
      if (pid !== gateway.pid || real.state === "alive") return real;
      if (failing === -1) failing = 3;
      if (failing > 0) {
        failing -= 1;
        return { state: "unknown", reason: "ps output unreadable" };
      }
      return real;
    };
    await stop(testInstance(home, runRoot, "alpha", { identify }));
    expect(failing).toBe(0);
    expect(processState(gateway.pid, gateway.identity, processIdentity)).toBe("dead");
  });

  it("is unknown when ps does not answer in time, while the process lives", () => {
    const live = liveProcess();
    const found = brokenPs("exec sleep 30")(live.pid);
    expect(found.state).toBe("unknown");
    expect(found.state === "unknown" && found.reason).toMatch(/could not run ps/);
  }, 15_000);

  for (const [what, breakIt] of FAILURES) {
    it(`is unknown when ${what}, while the process lives`, () => {
      const live = liveProcess();
      const gone = deadProcess();
      const identify = breakIt();
      expect(identify(live.pid).state).toBe("unknown");
      expect(processState(live.pid, live.identity, identify)).toBe("unknown");
      // Absence is still positive: the kernel says so without ps.
      expect(identify(gone.pid)).toEqual({ state: "exited", how: "absent" });
    });

    it(`refuses every deletion, signal and start when ${what}`, async () => {
      const home = tempDir("clawtrate-home-");
      const runRoot = tempDir("clawtrate-run-");
      const gateway = liveProcess();
      const { stateDir } = seedInstance(home, "alpha", { runRoot, gateway });
      const before = snapshot(stateDir);
      const identify = breakIt();
      const inst = testInstance(home, runRoot, "alpha", { identify });
      await expect(reset(inst)).rejects.toThrow(/could not determine whether/);
      await expect(stop(inst)).rejects.toThrow(
        /could not determine whether .*Nothing was signalled/,
      );
      await expect(start(inst, { seed: false })).rejects.toThrow(/could not determine whether/);
      const lines: string[] = [];
      await prune({
        home,
        runRoot,
        listening: async () => false,
        log: (l) => lines.push(l),
        identify,
      });
      expect(lines.join("\n")).toMatch(/Kept .*could not determine whether/);
      expect(list({ home, json: true, log: () => {}, identify })[0]?.gatewayState).toBe("unknown");
      expect(snapshot(stateDir)).toEqual(before);
      expect(processIdentity(gateway.pid).state).toBe("alive");
    });
  }
});

describe("a process is recorded before it can run (B1)", () => {
  it("a gated command does not run until released, and keeps its PID and start time when it does", async () => {
    const dir = tempDir("clawtrate-gate-");
    const held = gatedSpawn(spawn, "touch", [join(dir, "ran")], {});
    children.push(held.child);
    const before = identityOf(held.child.pid!);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(existsSync(join(dir, "ran"))).toBe(false);
    held.abort();
    const code = await new Promise((resolve) => held.child.once("exit", resolve));
    expect(code).toBe(70);
    expect(existsSync(join(dir, "ran"))).toBe(false);

    const released = gatedSpawn(spawn, "sleep", ["30"], {});
    children.push(released.child);
    const identity = identityOf(released.child.pid!);
    released.release();
    await waitUntil(() => {
      const ps = spawnSync("ps", ["-o", "command=", "-p", String(released.child.pid)], {
        encoding: "utf8",
      });
      return ps.stdout.trim().startsWith("sleep");
    });
    expect(identityOf(released.child.pid!)).toBe(identity);
    expect(before).toBeTruthy();
  });

  it("a released gate does not keep the spawner alive", async () => {
    const worker = spawn(process.execPath, [WORKER, "gate-release"], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    children.push(worker);
    const pid = await printedPid(worker);
    const identity = identityOf(pid);
    const exited = await Promise.race([
      new Promise((resolve) => worker.once("exit", () => resolve(true))),
      new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);
    expect(exited).toBe(true);
    // The released command runs on; it is a stand-in, stopped here by PID and start time.
    expect(processState(pid, identity, processIdentity)).toBe("alive");
    process.kill(pid, "SIGTERM");
  }, 10_000);

  it("a process whose spawner is killed before recording it exits without running", async () => {
    const dir = tempDir("clawtrate-gate-");
    const marker = join(dir, "ran");
    const worker = spawn(process.execPath, [WORKER, "gate-crash", marker], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    children.push(worker);
    const pid = await printedPid(worker);
    await waitUntil(() => processIdentity(pid).state === "exited");
    expect(existsSync(marker)).toBe(false);
  });

  for (const role of ["provider", "gateway"] as const) {
    it(`a start killed right after spawning its ${role} leaves a record recovery can act on`, async () => {
      const home = tempDir("clawtrate-home-");
      const runRoot = tempDir("clawtrate-run-");
      const worker = spawn(
        process.execPath,
        [WORKER, "start-crash", home, runRoot, "crash", role],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      children.push(worker);
      let printed = "";
      worker.stdout!.on("data", (chunk: Buffer) => (printed += chunk.toString("utf8")));
      const pid = await printedPid(worker);
      await new Promise((resolve) => worker.once("exit", resolve));
      const stateDir = stateDirFor("crash", home);
      const marker = readMarker(stateDir)!;
      // The intent was written before the spawn; the PID never was.
      expect(marker[`${role}Pending`]).toBe(true);
      expect(marker[`${role}Pid`]).toBeUndefined();
      // A provider spawned before the gateway was recorded whole and runs.
      const provider = /^provider (\d+)$/m.exec(printed);
      if (role === "gateway") {
        expect(marker.providerPid).toBe(Number(provider![1]));
        expect(processState(marker.providerPid, marker.providerIdentity, processIdentity)).toBe(
          "alive",
        );
      }
      // The gated process saw its spawner go and exited without running anything.
      await waitUntil(() => processIdentity(pid).state === "exited");
      // Recovery, as the next end-to-end run does it: reset by name and run id.
      const inst = openInstance("crash", {
        home,
        runRoot,
        checkout: "/test/worker",
        listening: async () => false,
      });
      await reset(inst, { runId: marker.runId });
      expect(existsSync(stateDir)).toBe(false);
      if (role === "gateway") {
        expect(processState(marker.providerPid, marker.providerIdentity, processIdentity)).toBe(
          "dead",
        );
      }
    });
  }

  it("counts a pending process as running while its start runs, and unknown when that is unknown", async () => {
    const home = tempDir("clawtrate-home-");
    const runRoot = tempDir("clawtrate-run-");
    const { stateDir } = seedInstance(home, "alpha", {
      start: liveProcess(),
      marker: { providerPending: true },
    });
    const before = snapshot(stateDir);
    await expect(reset(testInstance(home, runRoot, "alpha"))).rejects.toThrow(
      /start process .* is still running/,
    );
    await expect(
      reset(testInstance(home, runRoot, "alpha", { identify: brokenPs("exit 2") })),
    ).rejects.toThrow(/could not determine whether its start process/);
    expect(snapshot(stateDir)).toEqual(before);

    const inconsistent = seedInstance(tempDir("clawtrate-home-"), "beta", {
      provider: deadProcess(),
      marker: { providerPending: true },
    });
    expect(readMarker(inconsistent.stateDir)!.providerPending).toBe(true);
    await expect(
      reset(testInstance(join(inconsistent.stateDir, ".."), runRoot, "beta")),
    ).rejects.toThrow(/provider process record is inconsistent/);
  });
});

/** OpenClaw and the scripted model replaced by gated `sleep` stand-ins, under a temporary HOME. */
function fakedInstance(home: string, runRoot: string, name: string | null) {
  const stand = (options: SpawnOptions): ChildProcess => {
    const child = spawn("/bin/sh", ["-c", GATE_SCRIPT, "sleep", "120"], {
      ...options,
      env: { PATH: realPath },
    });
    children.push(child);
    return child;
  };
  const fakeSpawn = ((bin: string, args: string[], options: SpawnOptions) => {
    if (bin === "/bin/sh" && args[0] === "-c") return stand(options);
    // An OpenClaw CLI call: health answers, and the exec policy is denied
    // everywhere but the shell bot, which asks.
    const out = args.includes("approvals")
      ? JSON.stringify({
          effectivePolicy: {
            scopes: [
              { agentId: "main", security: { effective: "deny" } },
              {
                agentId: "otto",
                mode: { effective: "ask" },
                security: { effective: "allowlist" },
                ask: { effective: "on-miss" },
                askFallback: { effective: "deny" },
              },
            ],
          },
        })
      : "{}";
    return spawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(out)})`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  }) as unknown as typeof spawn;
  const fakeSpawnSync = (() => ({
    status: 0,
    stdout: "",
    stderr: "",
  })) as unknown as typeof spawnSync;
  const base = testInstance(home, runRoot, name);
  const stateDir = base.stateDir;
  // A port "listens" while the process recorded for it is alive.
  const listening = async (port: number) => {
    const marker = readMarker(stateDir);
    if (!marker) return false;
    const role =
      port === marker.gatewayPort ? "gateway" : port === marker.providerPort ? "provider" : null;
    if (!role) return false;
    return (
      processState(marker[`${role}Pid`], marker[`${role}Identity`], processIdentity) === "alive"
    );
  };
  return testInstance(home, runRoot, name, {
    listening,
    spawn: fakeSpawn,
    runner: new OpenclawRunner({
      instance: name,
      stateDir,
      runFile: base.runFile,
      checkout: CHECKOUT,
      spawnImpl: fakeSpawn,
      spawnSyncImpl: fakeSpawnSync,
    }),
  });
}

describe("a start holds the instance's lock until it is finished (B4)", () => {
  it("a stop issued while the gateway is still coming up waits for the start, then stops it", async () => {
    const home = tempDir("clawtrate-home-");
    const runRoot = tempDir("clawtrate-run-");
    const faked = fakedInstance(home, runRoot, "alpha");
    let healthy = false;
    // The gateway's port is open once it is healthy, and closes when its process exits.
    const gatewayListening = () => {
      const marker = readMarker(faked.stateDir);
      return (
        healthy &&
        processState(marker?.gatewayPid, marker?.gatewayIdentity, processIdentity) === "alive"
      );
    };
    const inst = {
      ...faked,
      listening: async (port: number) =>
        port === readMarker(faked.stateDir)?.gatewayPort
          ? gatewayListening()
          : faked.listening(port),
    };
    const events: string[] = [];
    const starting = start(inst, { seed: false }).then(() => events.push("started"));
    await waitUntil(() => readMarker(inst.stateDir)?.gatewayPid !== undefined);
    const stopping = stop(inst).then(() => events.push("stopped"));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(events).toEqual([]);
    const marker = readMarker(inst.stateDir)!;
    expect(processState(marker.gatewayPid, marker.gatewayIdentity, processIdentity)).toBe("alive");
    healthy = true;
    await Promise.all([starting, stopping]);
    expect(events).toEqual(["started", "stopped"]);
    expect(processState(marker.gatewayPid, marker.gatewayIdentity, processIdentity)).toBe("dead");
  }, 20_000);
});

describe("a stopped process is stopped once its port is closed too", () => {
  it.each(["ESRCH", "EPERM"])(
    "handles %s between the ownership check and the signal",
    async (code) => {
      const home = tempDir("clawtrate-home-");
      const runRoot = tempDir("clawtrate-run-");
      const gateway = deadProcess();
      const { marker } = seedInstance(home, "alpha", { runRoot, gateway });
      let exited = false;
      const listening = vi.fn(async () => false);
      const inst = testInstance(home, runRoot, "alpha", {
        identify: (pid) =>
          pid === gateway.pid && !exited
            ? { state: "alive", identity: gateway.identity }
            : processIdentity(pid),
        listening,
      });
      const kill = process.kill.bind(process);
      const signal = vi.spyOn(process, "kill").mockImplementation((pid, how) => {
        if (how === 0) return kill(pid, 0);
        expect([pid, how]).toEqual([gateway.pid, "SIGTERM"]);
        exited = code === "ESRCH";
        throw Object.assign(new Error(code), { code });
      });
      try {
        if (code === "ESRCH") {
          await stop(inst);
          expect(listening).toHaveBeenCalledWith(marker.gatewayPort);
          expect(existsSync(inst.runFile)).toBe(false);
        } else {
          await expect(stop(inst)).rejects.toMatchObject({ code: "EPERM" });
          expect(existsSync(inst.runFile)).toBe(true);
        }
        expect(signal).toHaveBeenCalledWith(gateway.pid, "SIGTERM");
      } finally {
        signal.mockRestore();
      }
    },
  );

  // A gateway killed while busy can show as exited while its socket is still open (issue #153).
  it("a reset waits for a stopped gateway's port to close, then removes the folder", async () => {
    const home = tempDir("clawtrate-home-");
    const runRoot = tempDir("clawtrate-run-");
    const gateway = liveProcess();
    const { stateDir, marker } = seedInstance(home, "alpha", {
      runRoot,
      gateway,
      provider: liveProcess(),
    });
    // The gateway's port answers for five more probes after its PID is gone.
    let openAfterExit = 5;
    const listening = async (port: number) => {
      if (port !== marker.gatewayPort) return false;
      if (processState(gateway.pid, gateway.identity, processIdentity) === "alive") return true;
      if (openAfterExit === 0) return false;
      openAfterExit -= 1;
      return true;
    };
    await reset(testInstance(home, runRoot, "alpha", { listening }));
    expect(openAfterExit).toBe(0);
    expect(existsSync(stateDir)).toBe(false);
  });

  it("a reset of an instance with a paired machine stops its node by PID and still waits for the gateway's port", async () => {
    const home = tempDir("clawtrate-home-");
    const runRoot = tempDir("clawtrate-run-");
    const gateway = liveProcess();
    const node = liveProcess();
    const { stateDir, marker } = seedInstance(home, "alpha", {
      runRoot,
      gateway,
      provider: liveProcess(),
      marker: { nodePid: node.pid, nodeIdentity: node.identity },
    });
    let openAfterExit = 3;
    const listening = async (port: number) => {
      if (port !== marker.gatewayPort) return false;
      if (processState(gateway.pid, gateway.identity, processIdentity) === "alive") return true;
      if (openAfterExit === 0) return false;
      openAfterExit -= 1;
      return true;
    };
    await reset(testInstance(home, runRoot, "alpha", { listening }));
    expect(processState(node.pid, node.identity, processIdentity)).toBe("dead");
    expect(openAfterExit).toBe(0);
    expect(existsSync(stateDir)).toBe(false);
  });

  it("a port still open after the wait fails the stop, naming the process and port, and the reset deletes nothing", async () => {
    const home = tempDir("clawtrate-home-");
    const runRoot = tempDir("clawtrate-run-");
    const gateway = liveProcess();
    const { stateDir, marker } = seedInstance(home, "alpha", { runRoot, gateway });
    const before = snapshot(stateDir);
    const inst = testInstance(home, runRoot, "alpha", {
      listening: async (port) => port === marker.gatewayPort,
      portReleaseMs: 300,
    });
    await expect(reset(inst)).rejects.toThrow(
      `could not confirm that every process stopped; its records are kept. ` +
        `the gateway (pid ${gateway.pid}) has exited, but its port ${marker.gatewayPort} is still open`,
    );
    expect(processState(gateway.pid, gateway.identity, processIdentity)).toBe("dead");
    expect(snapshot(stateDir)).toEqual(before);
  });

  /** An instance whose gateway's port stays open while `open.value` is true; its first stop times out. */
  async function timedOutStop() {
    const home = tempDir("clawtrate-home-");
    const runRoot = tempDir("clawtrate-run-");
    const gateway = liveProcess();
    const { marker } = seedInstance(home, "alpha", { runRoot, gateway });
    const open = { value: true };
    const inst = testInstance(home, runRoot, "alpha", {
      listening: async (port) => open.value && port === marker.gatewayPort,
      portReleaseMs: 300,
    });
    await expect(stop(inst)).rejects.toThrow(`its port ${marker.gatewayPort} is still open`);
    expect(processState(gateway.pid, gateway.identity, processIdentity)).toBe("dead");
    expect(existsSync(inst.runFile)).toBe(true);
    return { inst, gateway, marker, open };
  }

  it("a stop run again while the port of a gateway an earlier stop ended stays open keeps the run file and names the port", async () => {
    const { inst, gateway, marker } = await timedOutStop();
    // The gateway is gone, so this stop signals nothing, but its port still counts.
    await expect(stop(inst)).rejects.toThrow(
      `the gateway (pid ${gateway.pid}) has exited, but its port ${marker.gatewayPort} is still open`,
    );
    expect(existsSync(inst.runFile)).toBe(true);
  });

  it("a stop run again once that port has closed succeeds and removes the run file", async () => {
    const { inst, open } = await timedOutStop();
    open.value = false;
    await stop(inst);
    expect(existsSync(inst.runFile)).toBe(false);
  });
});

describe("lock files are used only through real directories (B4)", () => {
  it("refuses a lock folder, its parent or a lock file that is a link, and runs nothing", async () => {
    const cases: [string, (home: string) => void][] = [
      [
        "the tool's folder",
        (home) =>
          symlinkSync(tempDir("clawtrate-elsewhere-"), join(home, ".clawtrate-dev-gateway")),
      ],
      [
        "the lock folder",
        (home) => {
          mkdirSync(join(home, ".clawtrate-dev-gateway"));
          symlinkSync(tempDir("clawtrate-elsewhere-"), lockDir(home));
        },
      ],
      [
        "the lock file",
        (home) => {
          mkdirSync(lockDir(home), { recursive: true });
          symlinkSync(
            join(tempDir("clawtrate-elsewhere-"), "x.lock"),
            instanceLockPath(home, "alpha"),
          );
        },
      ],
    ];
    for (const [what, plant] of cases) {
      const home = tempDir("clawtrate-home-");
      plant(home);
      let ran = false;
      await expect(
        withLock(instanceLockPath(home, "alpha"), async () => {
          ran = true;
        }),
        what,
      ).rejects.toThrow(/refusing to use .* (not a plain directory|not a plain file)/);
      expect(ran, what).toBe(false);
    }
  });
});

describe("migrating from an older version of the tool (ruling 6)", () => {
  for (const name of [null, "alpha"]) {
    it(`starts ${name === null ? "the default instance" : "a named instance"} once the old folder is moved aside and the old run file removed`, async () => {
      const home = tempDir("clawtrate-home-");
      const runRoot = tempDir("clawtrate-run-");
      const stateDir = stateDirFor(name, home);
      // What the version at fdea2bf left: its marker, and its run file in this checkout.
      mkdirSync(stateDir);
      writeFileSync(
        join(stateDir, MARKER_FILE),
        JSON.stringify({
          createdBy: "clawtrate tools/dev-gateway",
          runId: newRunId(),
          instance: name,
          checkout: CHECKOUT,
          startPid: deadProcess().pid,
          gatewayPid: deadProcess().pid,
          providerPid: deadProcess().pid,
        }),
      );
      const inst = fakedInstance(home, runRoot, name);
      writeRun(inst.runFile, { runId: "old", gatewayPid: deadProcess().pid, startedAt: "" });
      await expect(start(inst, { seed: false })).rejects.toThrow(/older version of this tool/);

      // The owner's steps: processes already stopped, folder moved aside, run file deleted.
      const aside = `${stateDir}.moved-aside`;
      renameSync(stateDir, aside);
      const asideBefore = snapshot(aside);
      await expect(start(inst, { seed: false })).rejects.toThrow(/not a run file this version/);
      spawnSync("rm", [inst.runFile]);

      await start(inst, { seed: false });
      const marker = readMarker(stateDir)!;
      expect(marker.instance).toBe(name);
      expect(processState(marker.gatewayPid, marker.gatewayIdentity, processIdentity)).toBe(
        "alive",
      );
      expect(processState(marker.providerPid, marker.providerIdentity, processIdentity)).toBe(
        "alive",
      );
      // The moved-aside folder is never adopted, listed or touched.
      expect(list({ home, json: true, log: () => {} }).map((row) => row.name)).toEqual([name]);
      await reset(inst);
      expect(existsSync(stateDir)).toBe(false);
      expect(processState(marker.gatewayPid, marker.gatewayIdentity, processIdentity)).toBe("dead");
      expect(snapshot(aside)).toEqual(asideBefore);
    });
  }
});
