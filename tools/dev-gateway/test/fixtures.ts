// Shared test helpers. Everything lives under fresh temporary folders; the only
// processes started are `sleep` stand-ins and lock workers, stopped by PID.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInstance } from "../src/cli.ts";
import { stateDirFor } from "../src/instance.ts";
import {
  MARKER_FILE,
  newRunId,
  processIdentity,
  type Marker,
  type RunRecord,
} from "../src/state-guard.ts";

export const CHECKOUT = "/test/this-checkout";
export const OTHER_CHECKOUT = "/test/other-checkout";

export const tempDir = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

/** Every entry under a folder with its type, mode, mtime and content hash, without following links. */
export function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const key = rel ? `${rel}/${name}` : name;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) out[key] = `link ${readlinkSync(path)}`;
      else if (stat.isDirectory()) {
        out[key] = `dir ${stat.mode} ${stat.mtimeMs}`;
        walk(path, key);
      } else {
        const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
        out[key] = `file ${stat.mode} ${stat.mtimeMs} ${hash}`;
      }
    }
  };
  walk(root, "");
  return out;
}

export type Proc = { pid: number; identity: string };

/** Children the tests started; stopped by PID in `stopChildren`. */
export const children: ChildProcess[] = [];

/** The start time of a live process, or a test failure. */
export function identityOf(pid: number): string {
  const found = processIdentity(pid);
  if (found.state !== "alive") throw new Error(`pid ${pid} is not alive: ${JSON.stringify(found)}`);
  return found.identity;
}

/** A live stand-in process with its real identity. */
export function liveProcess(): Proc {
  const child = spawn("sleep", ["120"], { stdio: "ignore" });
  children.push(child);
  return { pid: child.pid!, identity: identityOf(child.pid!) };
}

export function childFor(pid: number): ChildProcess {
  return children.find((child) => child.pid === pid)!;
}

/** A PID whose process has exited, with the identity it had. */
export function deadProcess(): Proc {
  const result = spawnSync("true");
  return { pid: result.pid!, identity: "1970-01-01T00:00:00Z" };
}

export function stopChildren(): void {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
}

export const noListeners = async () => false;

/** An instance opened for this checkout under a temporary home, with no real port probes. */
export function testInstance(
  home: string,
  runRoot: string,
  name: string | null,
  extra: Parameters<typeof openInstance>[1] = {},
) {
  return openInstance(name, {
    home,
    runRoot,
    checkout: CHECKOUT,
    listening: noListeners,
    ...extra,
  });
}

/**
 * An instance folder as a start of `checkout` would leave it: a full marker
 * with the given processes, some state files, and optionally this checkout's
 * run file for it.
 */
export function seedInstance(
  home: string,
  name: string | null,
  options: {
    start?: Proc;
    provider?: Proc;
    gateway?: Proc;
    checkout?: string;
    marker?: Record<string, unknown>;
    runRoot?: string;
  } = {},
) {
  const stateDir = stateDirFor(name, home);
  const runId = newRunId();
  const ports =
    name === null
      ? { gatewayPort: 19001, providerPort: 19091 }
      : { gatewayPort: 19240, providerPort: 19250 };
  const start = options.start ?? deadProcess();
  const marker: Record<string, unknown> = {
    createdBy: "clawtrate tools/dev-gateway",
    createdAt: new Date().toISOString(),
    runId,
    instance: name,
    ...ports,
    checkout: options.checkout ?? CHECKOUT,
    startPid: start.pid,
    startIdentity: start.identity,
    ...(options.provider
      ? { providerPid: options.provider.pid, providerIdentity: options.provider.identity }
      : {}),
    ...(options.gateway
      ? { gatewayPid: options.gateway.pid, gatewayIdentity: options.gateway.identity }
      : {}),
    ...options.marker,
  };
  mkdirSync(stateDir, { mode: 0o700 });
  writeFileSync(join(stateDir, MARKER_FILE), JSON.stringify(marker));
  writeFileSync(join(stateDir, "openclaw.json"), '{"gateway":{}}\n');
  mkdirSync(join(stateDir, "agents/main/agent"), { recursive: true });
  writeFileSync(join(stateDir, "agents/main/agent/openclaw-agent.sqlite"), "SQLite format 3\0");
  if (options.runRoot) {
    const inst = testInstance(home, options.runRoot, name);
    writeRun(inst.runFile, {
      runId,
      instance: name,
      checkout: options.checkout ?? CHECKOUT,
      ...ports,
      startedAt: "",
    });
  }
  return { stateDir, runId, marker: marker as Marker };
}

export function writeRun(path: string, run: RunRecord | Record<string, unknown>): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(run));
}
