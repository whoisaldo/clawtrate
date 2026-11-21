// The end-to-end run record and the recovery of interrupted runs (e2e/run-record.ts).
// Runners and preview hosts are `sleep` stand-ins; instance resets are recorded,
// never run. Every folder is created here and removed here.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  cleanUp,
  readRecord,
  recordPath,
  recoverDeadRuns,
  saveRecord,
  TEMP_PREFIX,
  type RunRecord,
} from "../../../e2e/run-record.ts";
import {
  newRunId,
  processIdentity,
  processState,
  psIdentity,
  type Identify,
} from "../src/state-guard.ts";
import { children, deadProcess, liveProcess, stopChildren, tempDir } from "./fixtures.ts";

const made: string[] = [];
afterAll(() => {
  stopChildren();
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const own = (dir: string) => (made.push(dir), dir);

/** A record as a run leaves it: its instances, temporary folders and host. */
function aRun(runner: { pid: number; identity: string }, host: RunRecord["host"] = null) {
  const records = own(tempDir("clawtrate-records-"));
  const run = "aabbccdd";
  const record: RunRecord = {
    run,
    runner,
    instances: [
      { name: `e2e-${run}-other`, runId: newRunId() },
      { name: `e2e-${run}`, runId: newRunId() },
    ],
    host,
    dirs: [
      own(mkdtempSync(join(tmpdir(), TEMP_PREFIX))),
      own(mkdtempSync(join(tmpdir(), TEMP_PREFIX))),
    ],
  };
  saveRecord(records, record);
  const resets: string[] = [];
  const lines: string[] = [];
  return {
    records,
    record,
    resets,
    lines,
    reset: (name: string, runId: string) => void resets.push(`${name} ${runId}`),
    log: (line: string) => void lines.push(line),
    kept: () => existsSync(recordPath(records, run)) && record.dirs.every((d) => existsSync(d)),
    gone: () => !existsSync(recordPath(records, run)) && record.dirs.every((d) => !existsSync(d)),
  };
}

/** A process lookup whose `ps` misbehaves as `script` says. */
function brokenPs(script: string): Identify {
  const dir = own(tempDir("clawtrate-ps-"));
  writeFileSync(join(dir, "ps"), `#!/bin/sh\n${script}\n`);
  chmodSync(join(dir, "ps"), 0o755);
  return psIdentity([join(dir, "ps")]);
}

describe("recovering interrupted end-to-end runs (B2)", () => {
  it("leaves a run whose runner is alive alone, with its record and folders", () => {
    const run = aRun(liveProcess());
    recoverDeadRuns(run.records, run.reset, run.log);
    expect(run.kept()).toBe(true);
    expect(run.resets).toEqual([]);
  });

  for (const [what, script] of [
    ["ps exits with an error", "exit 2"],
    ["ps prints something unreadable", "echo '???'"],
    ["ps prints an error message", "echo 'ERROR permission denied'"],
  ] as const) {
    it(`leaves a live run alone when ${what}, and says so`, () => {
      const run = aRun(liveProcess());
      recoverDeadRuns(run.records, run.reset, run.log, brokenPs(script));
      expect(run.kept()).toBe(true);
      expect(run.resets).toEqual([]);
      expect(run.lines.join("\n")).toMatch(
        /Left end-to-end run aabbccdd alone: could not determine whether it is still running/,
      );
    });
  }

  it("cleans up a run whose runner is proven gone: host first, then its folders, instances and record", () => {
    const host = liveProcess();
    const run = aRun(deadProcess(), host);
    recoverDeadRuns(run.records, run.reset, run.log);
    expect(processState(host.pid, host.identity, processIdentity)).toBe("dead");
    expect(run.gone()).toBe(true);
    // Each instance by its name and the run id this run gave it, the run's own first.
    expect(run.resets).toEqual(
      [...run.record.instances].reverse().map(({ name, runId }) => `${name} ${runId}`),
    );
  });

  it("keeps the folders and the record when the host's state cannot be determined", () => {
    const host = liveProcess();
    const run = aRun(deadProcess(), host);
    const identify: Identify = (pid) =>
      pid === host.pid ? { state: "unknown", reason: "ps failed" } : processIdentity(pid);
    recoverDeadRuns(run.records, run.reset, run.log, identify);
    expect(run.kept()).toBe(true);
    expect(processState(host.pid, host.identity, processIdentity)).toBe("alive");
    expect(run.lines.join("\n")).toMatch(/could not determine whether the preview host/);
  });

  it("keeps the folders and the record while the host has not exited", () => {
    // A host that ignores SIGTERM.
    const stubborn = spawn("/bin/sh", ["-c", "trap '' TERM; while :; do sleep 1; done"], {
      stdio: "ignore",
    });
    children.push(stubborn);
    const found = processIdentity(stubborn.pid!);
    if (found.state !== "alive") throw new Error("stand-in did not start");
    const run = aRun(deadProcess(), { pid: stubborn.pid!, identity: found.identity });
    const problems = cleanUp(run.records, run.record, run.reset, processIdentity, 300);
    expect(problems.join("\n")).toMatch(/did not exit after SIGTERM; its folders are kept/);
    expect(run.kept()).toBe(true);
    stubborn.kill("SIGKILL");
  });

  it("removes the folders of a run whose host was pending: a gated host never ran", () => {
    const run = aRun(deadProcess());
    run.record.hostPending = true;
    saveRecord(run.records, run.record);
    recoverDeadRuns(run.records, run.reset, run.log);
    expect(run.gone()).toBe(true);
  });

  it("recovers the setup checks' own instance, named for its run", () => {
    const run = aRun(deadProcess());
    run.record.instances.push({ name: `e2e-${run.record.run}-setup`, runId: newRunId() });
    saveRecord(run.records, run.record);
    expect(readRecord(recordPath(run.records, run.record.run))?.instances).toContainEqual(
      expect.objectContaining({ name: `e2e-${run.record.run}-setup` }),
    );
  });

  it("leaves alone a record that names instances other than its run's own", () => {
    const run = aRun(deadProcess());
    run.record.instances.push({ name: "review", runId: newRunId() });
    saveRecord(run.records, run.record);
    expect(readRecord(recordPath(run.records, run.record.run))).toBeNull();
    recoverDeadRuns(run.records, run.reset, run.log);
    expect(run.kept()).toBe(true);
    expect(run.resets).toEqual([]);
    expect(run.lines.join("\n")).toMatch(/not a run record this version wrote/);
  });
});
