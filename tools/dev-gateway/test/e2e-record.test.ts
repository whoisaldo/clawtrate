// The end-to-end run record and the recovery of interrupted runs (e2e/run-record.ts).
// Runners and preview hosts are `sleep` stand-ins; instance resets are recorded,
// never run. Every folder is created here and removed here.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

  it("recovers the approval checks' own instances, named for their run", () => {
    const run = aRun(deadProcess());
    for (const suffix of ["approve", "approve-ssh"])
      run.record.instances.push({ name: `e2e-${run.record.run}-${suffix}`, runId: newRunId() });
    saveRecord(run.records, run.record);
    expect(readRecord(recordPath(run.records, run.record.run))).not.toBeNull();
    recoverDeadRuns(run.records, run.reset, run.log);
    expect(run.resets.map((line) => line.split(" ")[0])).toEqual(
      expect.arrayContaining([
        `e2e-${run.record.run}-approve`,
        `e2e-${run.record.run}-approve-ssh`,
      ]),
    );
    expect(run.gone()).toBe(true);
  });

  it.runIf(process.platform === "darwin")(
    "recovers a folder of the run's in macOS's short temporary folder, and no other there",
    () => {
      const run = aRun(deadProcess());
      const short = own(realpathSync(mkdtempSync(join("/tmp", TEMP_PREFIX))));
      const other = own(realpathSync(mkdtempSync(join("/tmp", "clawtrate-not-e2e-"))));
      run.record.dirs.push(short, other);
      saveRecord(run.records, run.record);
      recoverDeadRuns(run.records, run.reset, run.log);
      expect(existsSync(short)).toBe(false);
      expect(existsSync(other)).toBe(true);
    },
  );

  it("stops an interrupted SSH check's sshd by its PID, waits for it, then removes its exact folder", () => {
    const daemon = liveProcess();
    const run = aRun(deadProcess());
    const dir = own(mkdtempSync(join(tmpdir(), `${TEMP_PREFIX}ssh-approve-${run.record.run}-`)));
    saveRecord(run.records, {
      ...run.record,
      dirs: [...run.record.dirs, dir],
      sshd: { ...daemon, dir },
    });
    recoverDeadRuns(run.records, run.reset, run.log);
    expect(processState(daemon.pid, daemon.identity, processIdentity)).toBe("dead");
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(recordPath(run.records, run.record.run))).toBe(false);
  });

  it("an sshd that exits between the check and the signal is still cleaned up, folder and record", () => {
    const gone = deadProcess();
    const run = aRun(deadProcess());
    const dir = own(mkdtempSync(join(tmpdir(), `${TEMP_PREFIX}ssh-approve-${run.record.run}-`)));
    saveRecord(run.records, {
      ...run.record,
      dirs: [...run.record.dirs, dir],
      sshd: { ...gone, dir },
    });
    // Alive when first asked; by the signal it has exited, so the signal itself fails.
    let asked = 0;
    const identify: Identify = (pid) =>
      pid === gone.pid
        ? asked++ === 0
          ? { state: "alive", identity: gone.identity }
          : { state: "exited", how: "absent" }
        : processIdentity(pid);
    expect(() => recoverDeadRuns(run.records, run.reset, run.log, identify)).not.toThrow();
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(recordPath(run.records, run.record.run))).toBe(false);
  });

  it("never signals a process that only shares the recorded sshd's PID, and keeps no folder of another run", () => {
    const other = liveProcess();
    const run = aRun(deadProcess());
    const dir = own(mkdtempSync(join(tmpdir(), `${TEMP_PREFIX}ssh-approve-${run.record.run}-`)));
    // Another start time: the recorded daemon is gone, and this process isn't it.
    saveRecord(run.records, {
      ...run.record,
      sshd: { pid: other.pid, identity: "Thu Jan  1 00:00:00 1970", dir },
    });
    recoverDeadRuns(run.records, run.reset, run.log);
    expect(processState(other.pid, other.identity, processIdentity)).toBe("alive");
    expect(existsSync(dir)).toBe(false);
    // A folder named for another run isn't one this record may name.
    const elsewhere = own(mkdtempSync(join(tmpdir(), `${TEMP_PREFIX}ssh-approve-ffffffff-`)));
    const path = join(run.records, "ffeeddcc.json");
    writeFileSync(
      path,
      JSON.stringify({
        ...run.record,
        run: "ffeeddcc",
        instances: [],
        sshd: { ...other, dir: elsewhere },
      }),
    );
    expect(readRecord(path)).toBeNull();
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
