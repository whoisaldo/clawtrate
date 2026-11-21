// `pnpm mobile:check`: the iOS app's checks in the Simulator, from one command,
// with nobody at the screen. It creates a Simulator device of its own and boots
// it without the Simulator window, installs the build `pnpm mobile:build` made,
// starts a named development gateway instance of its own, and runs the checks
// in `simulator/` (Vitest driving Maestro flows). Afterwards it shuts down and
// deletes its device and resets its instance, also when a check fails or the
// run is interrupted; a termination stops the driver with the checks. A run
// killed outright leaves its record in `build/check-run.json`, and the next run
// removes what that record names, once it has proved each is that run's own
// (check-run.ts). A device or an instance it cannot remove is reported, and the
// record kept.
//
// Set CLAWTRATE_IOS_SHOTS=<folder> to also save each screen in light and dark.
// Arguments after the command go to Vitest (`pnpm mobile:check --bail=1`).

import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { readDevConnection } from "../../desktop/src/host/runtime.ts";
import { APP_PATH, BUILD_DIR, BUNDLE_ID } from "./build.ts";
import {
  deviceName,
  instanceName,
  maestroEnv,
  newRun,
  ownsDevice,
  readRecord,
  runnerAlive,
  startTime,
  writeRecord,
  type CheckRecord,
} from "./check-run.ts";
import { findDeveloperDir } from "./xcode.ts";

const REPO = join(import.meta.dirname, "../../..");
const RECORD = join(BUILD_DIR, "check-run.json");
/** iPhone sizes the checks prefer, in order. */
const DEVICE_TYPES = ["iPhone 17", "iPhone 16", "iPhone 17 Pro", "iPhone 18 Pro"];

/** The newest file or folder under ~/.local/share matching a name, for a tool installed there. */
function local(pattern: RegExp, inner: string): string | null {
  const dir = join(homedir(), ".local/share");
  if (!existsSync(dir)) return null;
  const found = readdirSync(dir)
    .filter((name) => pattern.test(name))
    .sort()
    .reverse()[0];
  return found && existsSync(join(dir, found, inner)) ? join(dir, found, inner) : null;
}

function tools(env: NodeJS.ProcessEnv) {
  const maestro = env.MAESTRO ?? local(/^maestro-[\d.]+$/, "bin/maestro") ?? "maestro";
  const javaHome = env.JAVA_HOME ?? local(/^temurin-jre-[\d.]+$/, "Contents/Home");
  if (!javaHome)
    throw new Error("Maestro needs Java 17 or later: set JAVA_HOME (docs/development/ios.md).");
  return { maestro, javaHome };
}

function simctl(env: NodeJS.ProcessEnv, ...args: string[]): string {
  return execFileSync("xcrun", ["simctl", ...args], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** The newest iOS runtime with one of the preferred iPhones, or what CLAWTRATE_IOS_RUNTIME and _DEVICE_TYPE name. */
function chooseDevice(env: NodeJS.ProcessEnv): { runtime: string; type: string; label: string } {
  const runtimes = (
    JSON.parse(simctl(env, "list", "runtimes", "-j")) as {
      runtimes: Array<{
        identifier: string;
        version: string;
        isAvailable: boolean;
        supportedDeviceTypes: Array<{ name: string; identifier: string }>;
      }>;
    }
  ).runtimes
    .filter((r) => r.isAvailable && r.identifier.includes("SimRuntime.iOS"))
    .filter((r) => !env.CLAWTRATE_IOS_RUNTIME || r.identifier === env.CLAWTRATE_IOS_RUNTIME)
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  const wanted = env.CLAWTRATE_IOS_DEVICE_TYPE ? [env.CLAWTRATE_IOS_DEVICE_TYPE] : DEVICE_TYPES;
  for (const runtime of runtimes) {
    for (const name of wanted) {
      const type = runtime.supportedDeviceTypes.find(
        (t) => t.name === name || t.identifier === name,
      );
      if (type)
        return {
          runtime: runtime.identifier,
          type: type.identifier,
          label: `${type.name}, iOS ${runtime.version}`,
        };
    }
  }
  throw new Error(`No installed iOS Simulator runtime supports ${wanted.join(" or ")}.`);
}

function devGateway(...args: string[]): number {
  return (
    spawnSync(process.execPath, [join(REPO, "tools/dev-gateway/src/cli.ts"), ...args], {
      cwd: REPO,
      // The approved workspace listing in the seed fixture uses byte order.
      env: { ...process.env, LC_ALL: "C" },
      stdio: "inherit",
    }).status ?? 1
  );
}

/** A loopback port nothing listens on, for what must not reach the network. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * Remove what a record names, each only once it is proven the run's own: the
 * device by the identifier and name the run recorded, the instance through the
 * dev tool with the run's id. A step that fails is reported and the record kept.
 */
function clean(record: CheckRecord, env: NodeJS.ProcessEnv): boolean {
  let ok = true;
  if (record.device) {
    const devices = JSON.parse(simctl(env, "list", "devices", "-j")) as {
      devices: { [runtime: string]: Array<{ udid: string; name: string; state: string }> };
    };
    const found = Object.values(devices.devices)
      .flat()
      .find((d) => d.udid === record.device);
    if (found && !ownsDevice(record, found)) {
      console.error(
        `The device ${found.udid} is named "${found.name}", not this run's; it was left alone.`,
      );
      ok = false;
    } else if (found) {
      if (found.state !== "Shutdown") {
        const shut = spawnSync("xcrun", ["simctl", "shutdown", found.udid], {
          env,
          encoding: "utf8",
        });
        if (shut.status !== 0) {
          console.error(`Could not shut down ${found.name}: ${shut.stderr.trim()}`);
          ok = false;
        }
      }
      const gone = spawnSync("xcrun", ["simctl", "delete", found.udid], { env, encoding: "utf8" });
      if (gone.status !== 0) {
        console.error(`Could not delete ${found.name} (${found.udid}): ${gone.stderr.trim()}`);
        ok = false;
      } else console.log(`Removed the Simulator device ${found.name}.`);
    }
  }
  if (devGateway("reset", "--instance", record.instance, "--run-id", record.run) !== 0) {
    console.error(
      `Could not reset the development gateway instance ${record.instance}; it was left as it is.`,
    );
    ok = false;
  }
  if (ok) rmSync(RECORD, { force: true });
  else console.error(`The record ${RECORD} is kept, so a later run can try again.`);
  return ok;
}

export async function main(): Promise<number> {
  if (!existsSync(APP_PATH))
    throw new Error(`There is no build at ${APP_PATH}. Run pnpm mobile:build first.`);
  const developerDir = findDeveloperDir();
  const env: NodeJS.ProcessEnv = { ...process.env, DEVELOPER_DIR: developerDir };
  const { maestro, javaHome } = tools(env);

  const previous = readRecord(RECORD);
  if (previous && runnerAlive(previous))
    throw new Error(`Another pnpm mobile:check (PID ${previous.pid}) is running in this checkout.`);
  if (previous) {
    console.log("Cleaning up after an earlier run that did not finish…");
    if (!clean(previous, env))
      throw new Error("An earlier run's device or instance could not be removed.");
  }

  const run = newRun();
  const record: CheckRecord = {
    run,
    pid: process.pid,
    started: startTime(process.pid) ?? "",
    device: null,
    instance: instanceName(run),
  };
  let child: ChildProcess | null = null;
  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${signal}: stopping the checks and cleaning up…`);
    // The checks run in a process group of their own, Vitest and the Maestro
    // driver it starts: the group this run made is stopped, and nothing else.
    if (child?.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // The run id is written before start. The device id is recorded as soon as create returns.
  writeRecord(RECORD, record);
  try {
    const choice = chooseDevice(env);
    const name = deviceName(run);
    record.device = simctl(env, "create", name, choice.type, choice.runtime).trim();
    writeRecord(RECORD, record);
    console.log(`Device: ${name} (${choice.label}), ${record.device}`);
    simctl(env, "boot", record.device);
    simctl(env, "bootstatus", record.device, "-b");
    simctl(env, "ui", record.device, "appearance", "light");
    simctl(env, "install", record.device, APP_PATH);

    console.log(
      `Starting the development gateway instance ${record.instance} (it seeds its bots; a few minutes)…`,
    );
    if (devGateway("start", "--instance", record.instance, "--run-id", run) !== 0)
      throw new Error("The development gateway did not start.");
    const gateway = readDevConnection(REPO, { instance: record.instance });
    if (!gateway) throw new Error(`The instance ${record.instance} is not running.`);
    const driverEnv = maestroEnv(await closedPort());
    if (stopping) return 130;

    child = spawn(
      join(REPO, "node_modules/.bin/vitest"),
      // Anything after the command goes to Vitest: `pnpm mobile:check --bail=1`.
      ["run", "--root", join(import.meta.dirname, "../simulator"), ...process.argv.slice(2)],
      {
        cwd: REPO,
        stdio: "inherit",
        detached: true,
        env: {
          ...env,
          ...driverEnv,
          JAVA_HOME: javaHome,
          CLAWTRATE_IOS_MAESTRO: maestro,
          CLAWTRATE_IOS_DEVICE: record.device,
          CLAWTRATE_IOS_BUNDLE: BUNDLE_ID,
          CLAWTRATE_IOS_APP: APP_PATH,
          CLAWTRATE_IOS_INSTANCE: record.instance,
          CLAWTRATE_IOS_GATEWAY: gateway.url,
          CLAWTRATE_IOS_TOKEN: gateway.token,
        },
      },
    );
    const code = await new Promise<number>((resolve) =>
      child!.on("exit", (status) => resolve(status ?? 1)),
    );
    return stopping ? 130 : code;
  } finally {
    if (!clean(record, env)) process.exitCode = 1;
  }
}

if (process.argv[1] === import.meta.filename) {
  main().then(
    (code) => {
      process.exitCode = process.exitCode || code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}
