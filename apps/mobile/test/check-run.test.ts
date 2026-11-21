import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deviceName,
  instanceName,
  maestroEnv,
  newRun,
  ownsDevice,
  readRecord,
  runnerAlive,
  writeRecord,
  type CheckRecord,
} from "../scripts/check-run.ts";

const record = (change: Partial<CheckRecord> = {}): CheckRecord => {
  const run = change.run ?? newRun();
  return {
    run,
    pid: 4242,
    started: "Wed Nov 18 08:00:00 2026",
    device: "UDID-1",
    instance: instanceName(run),
    ...change,
  };
};

describe("what the Simulator check touches", () => {
  it("takes a device as its own only by the identifier it recorded and its run's own name, never by a prefix", () => {
    const mine = record();
    expect(ownsDevice(mine, { udid: "UDID-1", name: deviceName(mine.run) })).toBe(true);
    // Another run's device with the same prefix, or the recorded identifier now named otherwise.
    expect(ownsDevice(mine, { udid: "UDID-2", name: deviceName(mine.run) })).toBe(false);
    expect(ownsDevice(mine, { udid: "UDID-1", name: deviceName(newRun()) })).toBe(false);
    expect(ownsDevice(mine, { udid: "UDID-1", name: "Clawtrate checks" })).toBe(false);
    expect(
      ownsDevice({ ...mine, device: null }, { udid: "UDID-1", name: deviceName(mine.run) }),
    ).toBe(false);
  });

  it("names its instance after its run and gives the dev tool a run id it accepts", () => {
    const run = newRun();
    expect(run).toMatch(/^[0-9a-f]{48}$/);
    expect(instanceName(run)).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/);
  });

  it("knows its runner by PID and start time, so a reused PID is not the run", () => {
    const mine = record();
    expect(runnerAlive(mine, () => mine.started)).toBe(true);
    expect(runnerAlive(mine, () => "Wed Nov 18 09:00:00 2026")).toBe(false);
    expect(runnerAlive(mine, () => null)).toBe(false);
  });

  it("writes its record whole and refuses one it did not write", () => {
    const dir = mkdtempSync(join(tmpdir(), "check-run-"));
    try {
      const path = join(dir, "check-run.json");
      const mine = record();
      writeRecord(path, mine);
      expect(readRecord(path)).toEqual(mine);
      writeFileSync(path, JSON.stringify({ ...mine, instance: "someone-else" }));
      expect(readRecord(path)).toBeNull();
      writeFileSync(path, "{ half");
      expect(readRecord(path)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the driver's update check and error reports on a closed loopback port", () => {
    expect(maestroEnv(1)).toEqual({
      MAESTRO_CLI_NO_ANALYTICS: "1",
      MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: "true",
      MAESTRO_DISABLE_UPDATE_CHECK: "true",
      MAESTRO_API_URL: "http://127.0.0.1:1",
      MAESTRO_DRIVER_STARTUP_TIMEOUT: "600000",
    });
  });
});
