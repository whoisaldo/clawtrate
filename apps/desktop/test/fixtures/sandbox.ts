// Fake accounts, a fake checkout and fake development instances for the
// sandbox's tests: every folder under one temporary base, as the
// dev-gateway tool and the launchers write them, with a file layer that
// counts what is read and a process lookup that counts what is asked.
// Nothing here starts a program or opens a socket.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeFiles, SANDBOX_FILE, type SandboxFiles } from "../../src/setup/sandbox.ts";
import { MARKER_FILE, type Identify } from "../../../../tools/dev-gateway/src/state-guard.ts";

export const GATEWAY_PID = 4343;
export const START_PID = 4242;
export const STARTED = "Mon Nov 16 21:27:01 2026";

export const runId = (digit: string) => digit.repeat(48);

/** Every base folder made since the last `removeBases`. */
const bases: string[] = [];

/** A base folder, by its canonical path, under the system's temporary folder. */
export function base(): string {
  const made = realpathSync(mkdtempSync(join(tmpdir(), "clawtrate-sandbox-test-")));
  bases.push(made);
  return made;
}

/** Removes every base folder made so far, with what is in it: each test's `afterEach`. */
export function removeBases(): void {
  for (const made of bases.splice(0)) rmSync(made, { recursive: true, force: true });
}

/** A file layer that records every content read and every lookup. */
export function counting(files: SandboxFiles = nodeFiles) {
  const reads: string[] = [];
  const lookups: string[] = [];
  const layer: SandboxFiles = {
    lstat: (path) => (lookups.push(path), files.lstat(path)),
    realpath: (path) => (lookups.push(path), files.realpath(path)),
    read: (path, max, uid) => (reads.push(path), files.read(path, max, uid)),
  };
  return { files: layer, reads, lookups };
}

/** A process lookup that knows one live gateway, and records each question. */
export function identities(alive: Set<number> = new Set([GATEWAY_PID, START_PID])) {
  const asked: number[] = [];
  const identify: Identify = (pid) => {
    asked.push(pid);
    return alive.has(pid)
      ? { state: "alive", identity: STARTED }
      : { state: "exited", how: "absent" };
  };
  return { identify, asked, alive };
}

export type Instance = { name: string; run: string; port: number; stateDir: string };

/**
 * A development instance as `pnpm dev-gateway start` leaves it: its state
 * folder in `home` with the tool's marker and a config, and the run record
 * in `checkout`'s run folder. `overrides` changes the marker.
 */
export function instance(options: {
  home: string;
  checkout: string;
  name: string;
  run: string;
  port?: number;
  marker?: Record<string, unknown>;
  record?: Record<string, unknown> | null;
}): Instance {
  const port = options.port ?? 19940;
  const stateDir = join(options.home, `.openclaw-clawtrate-dev-${options.name}`);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(stateDir, MARKER_FILE),
    JSON.stringify({
      createdBy: "clawtrate tools/dev-gateway",
      createdAt: "2026-11-20T00:00:00.000Z",
      runId: options.run,
      instance: options.name,
      gatewayPort: port,
      providerPort: port + 10,
      checkout: options.checkout,
      startPid: START_PID,
      startIdentity: STARTED,
      providerPid: START_PID,
      providerIdentity: STARTED,
      gatewayPid: GATEWAY_PID,
      gatewayIdentity: STARTED,
      ...options.marker,
    }),
  );
  writeFileSync(join(stateDir, "openclaw.json"), "{}");
  if (options.record !== null) {
    const runDir = join(options.checkout, "tools/dev-gateway/.run/instances", options.name);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "state.json"),
      JSON.stringify({
        runId: options.run,
        instance: options.name,
        checkout: options.checkout,
        gatewayPort: port,
        providerPort: port + 10,
        startedAt: "2026-11-20T00:00:00.000Z",
        ...options.record,
      }),
    );
  }
  return { name: options.name, run: options.run, port, stateDir };
}

/** A launch's private run folder under `parent`, with its home, working folder and description. */
export function runFolder(parent: string, description: unknown): { root: string; file: string } {
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "clawtrate-setup-"));
  mkdirSync(join(root, "home"), { mode: 0o700 });
  mkdirSync(join(root, "work"), { mode: 0o700 });
  mkdirSync(join(root, "app-data"), { mode: 0o700 });
  const file = join(root, SANDBOX_FILE);
  writeFileSync(file, typeof description === "string" ? description : JSON.stringify(description), {
    mode: 0o600,
  });
  return { root, file };
}

/** Three fake account homes, one checkout, and the account the host runs as. */
export function world() {
  const at = base();
  const homes = ["account", "second-account", "third-account"].map((name) => {
    const home = join(at, name);
    mkdirSync(join(home, ".openclaw"), { recursive: true });
    return home;
  });
  const checkout = join(at, "checkout");
  mkdirSync(checkout, { recursive: true });
  return { base: at, home: homes[0]!, homes, checkout, uid: process.getuid?.() ?? null };
}
