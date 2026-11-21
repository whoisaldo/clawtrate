// Starts what the end-to-end tests need and returns the teardown that stops it.
//
// Every run has its own development gateway instance, named for the run, on
// ports the dev tooling chooses. It never uses the default instance or its
// ports, whether or not something runs there, so runs in several checkouts can
// go at once. Before its own instance it starts an unseeded sentinel instance,
// so there is always another instance's gateway listening while the tests run;
// the tests and the teardown check that it, and every instance that was already
// running, is left as it was.
//
// Cleanup removes exactly what this run created: each instance by name and by
// the run id this run gave it, the preview host it spawned and its temporary
// folders. Each resource is written to a run record in this checkout before or
// as it is acquired. Cleanup runs from the teardown, from a setup failure, on
// SIGINT and SIGTERM, and when the process exits. A run killed outright leaves
// its record behind, and the next run in this checkout cleans it up once that
// run's runner is proven gone.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatedSpawn, type Gated } from "../tools/dev-gateway/src/env.ts";
import { newRunId, processIdentity, processState } from "../tools/dev-gateway/src/state-guard.ts";
import {
  cleanUp,
  recoverDeadRuns,
  runIncludes,
  saveRecord,
  TEMP_PREFIX,
  type RunRecord,
} from "./run-record.ts";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "tools/dev-gateway/src/cli.ts");
/** Run records of this checkout's end-to-end runs. Git-ignored. */
const RECORDS = join(ROOT, "tools/dev-gateway/.run/e2e");
import { FORBIDDEN_PORTS } from "./ports.ts";
export { FORBIDDEN_PORTS } from "./ports.ts";

export type ListedInstance = {
  name: string | null;
  stateDir: string;
  gatewayPort: number | null;
  providerPort: number | null;
  gatewayPid: number | null;
  gatewayRunning: boolean;
  gatewayState: "none" | "dead" | "alive" | "unknown";
};

function cliEnv(): NodeJS.ProcessEnv {
  // The instance is named by the flag alone, never inherited from the environment.
  const env = { ...process.env };
  delete env.CLAWTRATE_DEV_INSTANCE;
  return env;
}

export function devGateway(instance: string | null, ...args: string[]): string {
  const flags = instance === null ? [] : ["--instance", instance];
  return execFileSync(process.execPath, [CLI, ...args, ...flags], {
    cwd: ROOT,
    env: cliEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

export function listInstances(): ListedInstance[] {
  return JSON.parse(devGateway(null, "list", "--json")) as ListedInstance[];
}

/**
 * The running instances this run must leave alone, by name, pid and ports: the
 * default instance, named instances that are not e2e runs', and the ones in
 * `keep`. Other e2e runs' instances come and go with those runs.
 */
export function runningOthers(own: string[], keep: string[] = []): string[] {
  return listInstances()
    .filter(
      (row) =>
        // A gateway that cannot be checked counts as running: it must be left alone too.
        (row.gatewayState === "alive" || row.gatewayState === "unknown") &&
        (row.name === null ||
          (!own.includes(row.name) && (!row.name.startsWith("e2e-") || keep.includes(row.name)))),
    )
    .map(
      (row) =>
        `${row.name ?? "(default)"} pid ${row.gatewayPid} ports ${row.gatewayPort}/${row.providerPort}`,
    )
    .sort();
}

/** Reset one of this run's instances, only if it still holds the run this run gave it. */
const resetInstance = (name: string, runId: string) => {
  devGateway(name, "reset", "--run-id", runId);
};

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Stop a child we started: SIGTERM, a bounded wait, then SIGKILL. */
export async function stopChild(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timer = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), timeoutMs),
  );
  if ((await Promise.race([exited, timer])) === "timeout") {
    child.kill("SIGKILL");
    await exited;
  }
}

/**
 * The preview host, spawned behind a gate so it cannot run before it is
 * recorded. A test that quits and restarts a client starts its own with this,
 * on its own copy of the host's data, and stops it by its process.
 */
export function startHost(
  instance: string,
  staticDir: string,
  dataDir: string,
  options: { readOnly?: boolean } = {},
) {
  const gated: Gated = gatedSpawn(
    spawn,
    process.execPath,
    [
      join(ROOT, "apps/desktop/src/web-host/main.ts"),
      "--host",
      "127.0.0.1",
      // The system picks a free port; the host prints the one it bound.
      "--port",
      "0",
      "--instance",
      instance,
      "--static-dir",
      staticDir,
      "--data-dir",
      dataDir,
      // A host pinned to the read tier: it never asks for more access.
      ...(options.readOnly ? ["--read-only"] : []),
    ],
    // The instance is named by the flag alone, never inherited from the environment.
    { cwd: ROOT, env: cliEnv(), stdio: ["ignore", "pipe", "inherit"] },
  );
  const host = gated.child;
  const url = new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error(`preview host did not start:\n${output}`)),
      20_000,
    );
    host.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const match = /Local\s+(http:\/\/\S+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!.replace("localhost", "127.0.0.1"));
      }
    });
    host.once("exit", (code) => reject(new Error(`preview host exited with ${code}:\n${output}`)));
  });
  return { host, url, gated };
}

function selfIdentity(): string {
  const found = processIdentity(process.pid);
  if (found.state !== "alive") throw new Error("could not determine this process's start time");
  return found.identity;
}

export default async function globalSetup() {
  const run = process.env.CLAWTRATE_E2E_RUN ?? randomBytes(4).toString("hex");
  if (!/^[0-9a-f]{8}$/.test(run)) throw new Error(`CLAWTRATE_E2E_RUN must be 8 hex digits`);
  const name = `e2e-${run}`;
  const sentinel = `e2e-${run}-other`;
  // Provider accounts (docs/design/bots.md) run on an instance of their own, with scripted
  // accounts and sign-ins, so nothing they create reaches the seeded instance's checks.
  const accounts = `e2e-${run}-acct`;
  // The Computer tab's checks need the computer plugin: an instance of its own, started only
  // when this run can include them.
  const computer = `e2e-${run}-computer`;
  const withComputer = runIncludes(process.argv, "e2e/work-computer.spec.ts");
  const own = [name, sentinel, accounts, computer];
  // The spec's own dev-gateway calls address this run's instance.
  process.env.CLAWTRATE_DEV_INSTANCE = name;
  process.env.CLAWTRATE_E2E_SENTINEL = sentinel;
  process.env.CLAWTRATE_E2E_ACCOUNTS = accounts;
  if (withComputer) process.env.CLAWTRATE_E2E_COMPUTER = computer;

  recoverDeadRuns(RECORDS, resetInstance);

  // Registered before anything is started.
  const record: RunRecord = {
    run,
    runner: { pid: process.pid, identity: selfIdentity() },
    instances: [],
    host: null,
    dirs: [],
  };
  saveRecord(RECORDS, record);
  let child: ChildProcess | null = null;
  let host: ChildProcess | null = null;
  let cleaned: string[] | null = null;
  const cleanUpOnce = (): string[] => {
    if (cleaned) return cleaned;
    // A dev-gateway command still running is ended first; the reset below
    // waits for the instance's lock, which that command holds until it exits.
    if (child && child.exitCode === null && child.signalCode === null) {
      const found = processIdentity(child.pid!);
      child.kill("SIGTERM");
      // Wait, synchronously, until it has exited: the reset must not see it running.
      if (found.state === "alive") {
        const deadline = Date.now() + 15_000;
        while (
          processState(child.pid, found.identity, processIdentity) === "alive" &&
          Date.now() < deadline
        ) {
          sleepSync(100);
        }
      }
    }
    cleaned = cleanUp(RECORDS, record, resetInstance);
    return cleaned;
  };
  const onSignal = (signal: NodeJS.Signals) => {
    const problems = cleanUpOnce();
    if (problems.length > 0) console.error(problems.join("\n"));
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("exit", () => void cleanUpOnce());

  /** A dev-gateway command, run so that signals are handled while it runs. */
  const cli = (instance: string, ...args: string[]) =>
    new Promise<void>((resolve, reject) => {
      if (cleaned) return reject(new Error("the run was interrupted"));
      child = spawn(process.execPath, [CLI, ...args, "--instance", instance], {
        cwd: ROOT,
        env: {
          ...cliEnv(),
          ...(args.includes("clawtrate-memory") ? { FS_SAFE_NATIVE_MODE: "require" } : {}),
        },
        stdio: ["ignore", "inherit", "inherit"],
      });
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        code === 0
          ? resolve()
          : reject(new Error(`dev-gateway ${args[0]} ${instance} failed (${code ?? signal})`)),
      );
    });
  /** Start an instance, recording its name and run id first. */
  const startInstance = (instance: string, ...flags: string[]) => {
    const runId = newRunId();
    record.instances.push({ name: instance, runId });
    saveRecord(RECORDS, record);
    return cli(instance, "start", "--run-id", runId, ...flags);
  };
  const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
    record.dirs.push(dir);
    saveRecord(RECORDS, record);
    return dir;
  };

  const alreadyRunning = runningOthers(own);
  const teardown = async () => {
    if (host) await stopChild(host);
    const problems = [...cleanUpOnce()];
    const after = runningOthers(own);
    const gone = alreadyRunning.filter((row) => !after.includes(row));
    // The default instance is this run's to leave alone. Another named instance belongs
    // to other work on the machine and may stop or restart during a run, as the packaged
    // check already allows; the sentinel proves this run touches no instance but its own.
    const guarded = gone.filter((row) => row.startsWith("(default) "));
    if (guarded.length > 0) {
      problems.push(`instances that were running changed: ${guarded.join(", ")}`);
    }
    const others = gone.filter((row) => !row.startsWith("(default) "));
    if (others.length > 0) {
      console.log(`Note: other instances changed during the run, not by it: ${others.join(", ")}`);
    }
    if (listInstances().some((row) => row.name !== null && own.includes(row.name))) {
      problems.push("this run's instance folders were not removed");
    }
    if (problems.length > 0) throw new Error(problems.join("\n"));
  };

  try {
    const staticDir = tempDir();
    const dataDir = tempDir();
    // Another instance's gateway is listening before this run's starts.
    await startInstance(sentinel, "--no-seed");
    process.env.CLAWTRATE_E2E_OTHERS = JSON.stringify(runningOthers([name], [sentinel]));
    // Every start is a fresh, seeded gateway.
    await startInstance(name, "--with-plugin", "clawtrate-memory");
    // It also has a paired machine (`--with-node`), for Settings, Machines and "Where a bot runs".
    await startInstance(
      accounts,
      "--with-accounts",
      "--with-plugin",
      "clawtrate-dev-signin",
      "--with-node",
      "--no-seed",
    );
    // With the computer plugin, whose Marlow and Pip have browsers of their own. Seeded: the
    // seed gives the bots their names.
    if (withComputer) await startInstance(computer, "--with-plugin", "clawtrate-computer");
    for (const instance of withComputer ? [name, accounts, computer] : [name, accounts]) {
      const mine = listInstances().find((row) => row.name === instance);
      if (!mine?.gatewayRunning) throw new Error(`instance ${instance} is not running`);
      for (const port of [mine.gatewayPort, mine.providerPort]) {
        if (port === null || FORBIDDEN_PORTS.includes(port)) {
          throw new Error(`instance ${instance} is on port ${port}, which e2e never uses`);
        }
      }
    }

    // Built into this run's own folder, so parallel runs never share output.
    execFileSync(
      "pnpm",
      [
        "--filter",
        "@clawtrate/desktop",
        "exec",
        "vite",
        "build",
        "--config",
        "vite.web.config.ts",
        "--outDir",
        staticDir,
        "--emptyOutDir",
      ],
      { cwd: ROOT, stdio: "ignore" },
    );
    if (cleaned) throw new Error("the run was interrupted");
    record.hostPending = true;
    saveRecord(RECORDS, record);
    const started = startHost(name, staticDir, dataDir);
    host = started.host;
    const found = processIdentity(host.pid!);
    if (found.state !== "alive") {
      started.gated.abort();
      throw new Error("could not record the preview host");
    }
    record.host = { pid: host.pid!, identity: found.identity };
    delete record.hostPending;
    saveRecord(RECORDS, record);
    started.gated.release();
    const url = await started.url;
    if (FORBIDDEN_PORTS.includes(Number(new URL(url).port))) {
      throw new Error(`preview host is on ${url}, a port e2e never uses`);
    }
    process.env.CLAWTRATE_E2E_URL = url;
    // For a test that runs a second client host from the same build and a copy of this one's data.
    process.env.CLAWTRATE_E2E_STATIC = staticDir;
    process.env.CLAWTRATE_E2E_DATA = dataDir;
  } catch (error) {
    if (host) await stopChild(host);
    const problems = cleanUpOnce();
    if (problems.length > 0) console.error(problems.join("\n"));
    throw error;
  }
  return teardown;
}
