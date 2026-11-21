// State preparation and the spawn boundary. Every test uses a fresh temporary
// HOME; no real profile is ever read, and no real gateway is started.
import type { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { status } from "../src/cli.ts";
import { assertDevStateDir, devStateDir, OpenclawRunner, SpawnRefusedError } from "../src/env.ts";
import {
  ForeignStateError,
  MARKER_FILE,
  newRunId,
  ownership,
  prepareFreshState,
  readMarker,
  recordProcess,
  spawnRefusal,
  type MarkerOrigin,
} from "../src/state-guard.ts";
import {
  CHECKOUT,
  deadProcess,
  liveProcess,
  seedInstance,
  snapshot,
  stopChildren,
  tempDir,
  testInstance,
  writeRun,
} from "./fixtures.ts";

afterAll(stopChildren);

const tempHome = () => tempDir("clawtrate-home-");

function plant(root: string, path: string, contents: string | Buffer = "PLANTED=1\n"): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), contents);
}

/** What a start of the default instance records when it creates the folder. */
function origin(): MarkerOrigin {
  const start = deadProcess();
  return { instance: null, checkout: CHECKOUT, startPid: start.pid, startIdentity: start.identity };
}

/** A runner on temporary paths whose spawns are counted, never executed. */
function countingRunner(home: string) {
  const calls: string[][] = [];
  const fakeSpawn = ((_bin: string, args: string[]) => {
    calls.push(args);
    throw new Error("a test must never reach a real spawn");
  }) as unknown as typeof spawn;
  const fakeSpawnSync = ((_bin: string, args: string[]) => {
    calls.push(args);
    throw new Error("a test must never reach a real spawn");
  }) as unknown as typeof spawnSync;
  const runner = new OpenclawRunner({
    instance: null,
    stateDir: devStateDir(home),
    runFile: join(home, "run", "state.json"),
    checkout: CHECKOUT,
    spawnImpl: fakeSpawn,
    spawnSyncImpl: fakeSpawnSync,
  });
  const inst = testInstance(home, join(home, "run"), null, { runner });
  return { runner, calls, inst };
}

const runFor = (runId: string) => ({
  runId,
  instance: null,
  checkout: CHECKOUT,
  gatewayPort: 19001,
  providerPort: 19091,
  startedAt: "",
});

describe("preparing fresh state", () => {
  it("resolves to .openclaw-dev under the given home and nowhere else", () => {
    const home = tempHome();
    expect(devStateDir(home)).toBe(join(home, ".openclaw-dev"));
    expect(() => assertDevStateDir(devStateDir(home), home)).not.toThrow();
    expect(() => assertDevStateDir(join(home, ".openclaw"), home)).toThrow(
      /lives only in ~\/\.openclaw-dev/,
    );
  });

  it("starting over an owned folder leaves a new folder without anything planted in it", () => {
    const home = tempHome();
    const stateDir = devStateDir(home);
    prepareFreshState(stateDir, newRunId(), origin());
    // Credentials can live in SQLite stores, deep files and behind links.
    plant(stateDir, "agents/main/agent/openclaw-agent.sqlite", Buffer.from("SQLite format 3\0key"));
    plant(stateDir, "state/openclaw.sqlite", Buffer.from("SQLite format 3\0key"));
    plant(stateDir, "a/b/c/d/e/f/g/h/i/j/.env", "OPENAI_API_KEY=planted\n");
    const outside = join(home, "elsewhere");
    plant(outside, "auth-profiles.json", '{"profiles":{"x":{"key":"planted"}}}');
    symlinkSync(outside, join(stateDir, "linked-agents"));
    const outsideBefore = snapshot(outside);

    const runId = newRunId();
    prepareFreshState(stateDir, runId, origin());

    expect(readdirSync(stateDir)).toEqual([MARKER_FILE]);
    expect(readMarker(stateDir)?.runId).toBe(runId);
    expect(lstatSync(stateDir).mode & 0o777).toBe(0o700);
    // The link was removed, not followed: what it pointed at is untouched.
    expect(snapshot(outside)).toEqual(outsideBefore);
  });

  it("refuses a foreign folder and leaves it byte for byte untouched", () => {
    const home = tempHome();
    const stateDir = devStateDir(home);
    plant(stateDir, "openclaw.json", "{}");
    plant(stateDir, "agents/main/agent/openclaw-agent.sqlite", Buffer.from("SQLite format 3\0"));
    plant(stateDir, ".env", "TOKEN=someone-elses\n");
    const before = snapshot(stateDir);
    expect(ownership(stateDir)).toBe("foreign");
    expect(() => prepareFreshState(stateDir, newRunId(), origin())).toThrow(ForeignStateError);
    expect(snapshot(stateDir)).toEqual(before);
  });

  it("treats a marker that is a link, or not the tool's, as foreign", () => {
    const home = tempHome();
    const stateDir = devStateDir(home);
    const real = join(home, "real-marker");
    writeFileSync(real, JSON.stringify({ createdBy: "clawtrate tools/dev-gateway", runId: "x" }));
    mkdirSync(stateDir);
    symlinkSync(real, join(stateDir, MARKER_FILE));
    expect(ownership(stateDir)).toBe("foreign");
    expect(() => prepareFreshState(stateDir, newRunId(), origin())).toThrow(ForeignStateError);

    const other = devStateDir(tempHome());
    plant(other, MARKER_FILE, '{"createdBy":"someone else","runId":"x"}');
    expect(ownership(other)).toBe("foreign");
  });

  it("refuses a state path that is a symlink, even to a folder the tool made", () => {
    const home = tempHome();
    const target = join(home, "target");
    prepareFreshState(target, newRunId(), origin());
    plant(target, "keep.txt", "keep");
    const before = snapshot(target);
    const stateDir = devStateDir(home);
    symlinkSync(target, stateDir);
    expect(ownership(stateDir)).toBe("foreign");
    expect(() => prepareFreshState(stateDir, newRunId(), origin())).toThrow(ForeignStateError);
    expect(lstatSync(stateDir).isSymbolicLink()).toBe(true);
    expect(snapshot(target)).toEqual(before);
  });

  it("never starts over, runs on or deletes an old marker, even when nothing runs", () => {
    const home = tempHome();
    const stateDir = devStateDir(home);
    plant(stateDir, MARKER_FILE, '{"createdBy":"clawtrate tools/dev-gateway","createdAt":"x"}');
    expect(ownership(stateDir)).toBe("owned");
    const before = snapshot(stateDir);
    expect(
      spawnRefusal({ stateDir, run: null, freshRunId: "", instance: null, checkout: CHECKOUT }),
    ).toMatch(/older version of this tool/);
    expect(() => prepareFreshState(stateDir, newRunId(), origin())).toThrow(
      /older version of this tool/,
    );
    expect(snapshot(stateDir)).toEqual(before);
  });

  it("creates the folder with only a marker when none exists", () => {
    const stateDir = devStateDir(tempHome());
    expect(ownership(stateDir)).toBe("absent");
    prepareFreshState(stateDir, newRunId(), origin());
    expect(ownership(stateDir)).toBe("owned");
    expect(readdirSync(stateDir)).toEqual([MARKER_FILE]);
  });
});

describe("the OpenClaw spawn boundary", () => {
  it("status with absent state spawns nothing", async () => {
    const home = tempHome();
    const { inst, calls } = countingRunner(home);
    const lines: string[] = [];
    await status(inst, (line) => lines.push(line));
    expect(calls).toEqual([]);
    expect(lines.join("\n")).toMatch(
      /healthy {5}no \(not checked: There is no development gateway state/,
    );
  });

  it("status with foreign state spawns nothing", async () => {
    const home = tempHome();
    plant(devStateDir(home), "openclaw.json", "{}");
    writeRun(join(home, "run", "state.json"), runFor(newRunId()));
    const { inst, calls } = countingRunner(home);
    const lines: string[] = [];
    await status(inst, (line) => lines.push(line));
    expect(calls).toEqual([]);
    expect(lines.join("\n")).toMatch(/not checked: .*was not created by the dev-gateway tool/);
  });

  it("refuses a later command when the recorded gateway is not running", async () => {
    const home = tempHome();
    const { runId } = seedInstance(home, null, { gateway: deadProcess() });
    writeRun(join(home, "run", "state.json"), runFor(runId));
    const { runner, calls } = countingRunner(home);
    expect(runner.refusal()).toMatch(/\) is not running/);
    await expect(runner.run(["devices", "list"])).rejects.toBeInstanceOf(SpawnRefusedError);
    expect(() => runner.runSync(["config", "validate"])).toThrow(SpawnRefusedError);
    expect(() => runner.spawnGated(["gateway", "run"], {})).toThrow(SpawnRefusedError);
    expect(calls).toEqual([]);
  });

  it("refuses a gateway whose PID now belongs to another process", () => {
    const home = tempHome();
    const reused = { pid: liveProcess().pid, identity: "1970-01-01T00:00:00Z" };
    const { runId } = seedInstance(home, null, { gateway: reused });
    writeRun(join(home, "run", "state.json"), runFor(runId));
    expect(countingRunner(home).runner.refusal()).toMatch(/is not running/);
  });

  it("refuses state that a different start recorded", () => {
    const home = tempHome();
    seedInstance(home, null, { gateway: liveProcess() });
    writeRun(join(home, "run", "state.json"), runFor(newRunId()));
    expect(countingRunner(home).runner.refusal()).toMatch(
      /does not belong to the gateway this checkout last started/,
    );
  });

  it("allows OpenClaw during the start that created the state, then only while its gateway runs", () => {
    const home = tempHome();
    const stateDir = devStateDir(home);
    const runId = newRunId();
    prepareFreshState(stateDir, runId, origin());
    const check = (freshRunId: string | null, run: object | null) =>
      spawnRefusal({ stateDir, run: run as never, freshRunId, instance: null, checkout: CHECKOUT });

    expect(check(runId, null)).toBeNull(); // configuring and starting
    expect(check(null, null)).toMatch(/does not belong/); // no run recorded yet
    expect(check(newRunId(), null)).toMatch(/does not belong/); // another start's id

    const gateway = liveProcess();
    recordProcess(stateDir, runId, "gateway", gateway.pid);
    expect(check(null, runFor(runId))).toBeNull();
    expect(check(null, { ...runFor(runId), checkout: "/test/other" })).toMatch(/does not belong/);
  });

  it("refuses to record a process on state another start created", () => {
    const stateDir = devStateDir(tempHome());
    prepareFreshState(stateDir, newRunId(), origin());
    expect(() => recordProcess(stateDir, newRunId(), "gateway", liveProcess().pid)).toThrow(
      /no longer the state this start created/,
    );
    expect(existsSync(join(stateDir, MARKER_FILE))).toBe(true);
  });
});
