// What an end-to-end run created, saved as it goes so the run itself, or the
// next run in the same checkout after a crash, can remove exactly that.
//
// Every process is judged alive, exited or unknown (state-guard.ts). Unknown
// never authorises anything: the record and the temporary folders stay, and
// the reason is reported.

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  processIdentity,
  processVerdict,
  validPid,
  type Identify,
} from "../tools/dev-gateway/src/state-guard.ts";

export const TEMP_PREFIX = "clawtrate-e2e-";

export type Proc = { pid: number; identity: string };

export type RunRecord = {
  run: string;
  runner: Proc;
  /** Each instance with the run id this run gave it, written before its start. */
  instances: { name: string; runId: string }[];
  /** Written before the preview host is spawned; it is gated until `host` is written. */
  hostPending?: true;
  host: Proc | null;
  dirs: string[];
};

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export const recordPath = (dir: string, run: string) => join(dir, `${run}.json`);

export function saveRecord(dir: string, record: RunRecord): void {
  mkdirSync(dir, { recursive: true });
  const temp = `${recordPath(dir, record.run)}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(temp, recordPath(dir, record.run));
}

const isProc = (p: unknown): p is Proc =>
  p !== null &&
  typeof p === "object" &&
  validPid((p as Proc).pid) &&
  typeof (p as Proc).identity === "string" &&
  (p as Proc).identity !== "";

export function readRecord(path: string): RunRecord | null {
  try {
    const record = JSON.parse(readFileSync(path, "utf8")) as RunRecord;
    if (
      /^[0-9a-f]{8}$/.test(record.run) &&
      isProc(record.runner) &&
      (record.host === null || isProc(record.host)) &&
      (record.hostPending === undefined || record.hostPending === true) &&
      Array.isArray(record.instances) &&
      // Only this run's own instances, each with a run id of the tool's format.
      record.instances.every(
        (entry) =>
          (entry?.name === `e2e-${record.run}` ||
            entry?.name === `e2e-${record.run}-other` ||
            entry?.name === `e2e-${record.run}-acct` ||
            // The setup checks' own instance, recorded by e2e/setup.spec.ts.
            entry?.name === `e2e-${record.run}-setup`) &&
          typeof entry.runId === "string" &&
          /^[0-9a-f]{48}$/.test(entry.runId),
      ) &&
      Array.isArray(record.dirs)
    ) {
      return record;
    }
  } catch {
    // unreadable: left alone
  }
  return null;
}

/** A temporary folder a run may have created: directly in the system temp folder, with our prefix. */
export const isRunTempDir = (dir: unknown): dir is string =>
  typeof dir === "string" && dirname(dir) === tmpdir() && basename(dir).startsWith(TEMP_PREFIX);

/**
 * Remove everything a record lists, synchronously, so it also works from a
 * signal or exit handler. The preview host is signalled only while it is
 * still the recorded process, and its folders are removed only once it is
 * proven gone; if that cannot be determined, nothing of it is touched. Each
 * instance goes through `reset` by name and run id, which proves
 * its processes itself. Returns what could not be cleaned up; the record is
 * removed only when nothing is left.
 */
export function cleanUp(
  dir: string,
  record: RunRecord,
  reset: (name: string, runId: string) => void,
  identify: Identify = processIdentity,
  hostStopMs = 10_000,
): string[] {
  const problems: string[] = [];
  // A pending host without a record never ran: its gate opens only after the record.
  let hostGone = true;
  if (record.host) {
    const { pid, identity } = record.host;
    let verdict = processVerdict(pid, identity, identify);
    if (verdict.state === "alive") {
      process.kill(pid, "SIGTERM");
      const deadline = Date.now() + hostStopMs;
      // Through "unknown" too: a lookup can fail for a moment while a process exits.
      while (verdict.state !== "dead" && Date.now() < deadline) {
        sleepSync(100);
        verdict = processVerdict(pid, identity, identify);
      }
    }
    if (verdict.state !== "dead") {
      hostGone = false;
      problems.push(
        verdict.state === "alive"
          ? `the preview host (pid ${pid}) did not exit after SIGTERM; its folders are kept`
          : `could not determine whether the preview host (pid ${pid}) is running: ${verdict.reason}; its folders are kept`,
      );
    }
  }
  if (hostGone) {
    for (const path of record.dirs) {
      if (isRunTempDir(path)) rmSync(path, { recursive: true, force: true });
    }
  }
  for (const { name, runId } of [...record.instances].reverse()) {
    try {
      reset(name, runId);
    } catch (error) {
      problems.push(`reset ${name}: ${String(error)}`);
    }
  }
  if (problems.length === 0) rmSync(recordPath(dir, record.run), { force: true });
  return problems;
}

/**
 * Clean up this checkout's earlier runs that were killed and could not clean
 * up themselves: only those whose runner is proven gone. A run whose runner is
 * running, or cannot be checked, is left alone with its record.
 */
export function recoverDeadRuns(
  dir: string,
  reset: (name: string, runId: string) => void,
  log: (line: string) => void = console.log,
  identify: Identify = processIdentity,
): void {
  let files: string[];
  try {
    files = readdirSync(dir).filter((file) => /^[0-9a-f]{8}\.json$/.test(file));
  } catch {
    return;
  }
  for (const file of files) {
    const record = readRecord(join(dir, file));
    if (!record) {
      log(`Left ${file} alone: it is not a run record this version wrote`);
      continue;
    }
    const runner = processVerdict(record.runner.pid, record.runner.identity, identify);
    if (runner.state === "alive") continue;
    if (runner.state === "unknown") {
      log(
        `Left end-to-end run ${record.run} alone: could not determine whether it is still running (${runner.reason})`,
      );
      continue;
    }
    log(`Cleaning up interrupted end-to-end run ${record.run}`);
    const problems = cleanUp(dir, record, reset, identify);
    for (const problem of problems) log(problem);
  }
}
