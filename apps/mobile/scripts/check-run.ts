// What `pnpm mobile:check` records about its own run, and how it proves that a
// Simulator device, a gateway instance or a process is its own before it touches
// it. A run has one random id. The device is named after it, and the record holds
// the device's identifier, so a device is the run's only when both agree; the
// gateway instance is started with the same id as the dev tool's run id
// (`--run-id`), so the tool refuses to reset an instance another run holds under
// that name; the runner is identified by its PID and the start time `ps` reports,
// so a reused PID is not taken for the run. The record is written whole and
// renamed into place.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

export const DEVICE_PREFIX = "Clawtrate checks ";

export type CheckRecord = {
  /** 48 lowercase hex digits: the dev tool's run id for the instance, and the run's name. */
  run: string;
  pid: number;
  /** When the runner started, as `ps -o lstart` prints it. */
  started: string;
  /** The device's identifier, once it exists. */
  device: string | null;
  instance: string;
};

export function newRun(): string {
  return randomBytes(24).toString("hex");
}

export function deviceName(run: string): string {
  return `${DEVICE_PREFIX}${run.slice(0, 12)}`;
}

export function instanceName(run: string): string {
  return `ios-${run.slice(0, 12)}`;
}

/** A device is the run's when its identifier is the one the run recorded and its name is the run's. */
export function ownsDevice(record: CheckRecord, device: { udid: string; name: string }): boolean {
  return (
    record.device !== null &&
    device.udid === record.device &&
    device.name === deviceName(record.run)
  );
}

export function readRecord(path: string): CheckRecord | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<CheckRecord>;
    if (
      typeof value.run !== "string" ||
      !/^[0-9a-f]{48}$/.test(value.run) ||
      typeof value.pid !== "number" ||
      typeof value.started !== "string" ||
      typeof value.instance !== "string" ||
      value.instance !== instanceName(value.run) ||
      (value.device !== null && typeof value.device !== "string")
    )
      return null;
    return value as CheckRecord;
  } catch {
    return null;
  }
}

/** Written whole to a temporary file and renamed into place, so a reader never sees half a record. */
export function writeRecord(path: string, record: CheckRecord): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

/** When a process started, as `ps` prints it, or null when there is no such process. */
export function startTime(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

/** Whether the run that wrote a record is still running: the same PID, started at the same time. */
export function runnerAlive(
  record: CheckRecord,
  startOf: (pid: number) => string | null = startTime,
): boolean {
  return startOf(record.pid) === record.started;
}

/**
 * Maestro 2.12.1 asks its servers for a newer version and can send them an
 * error report, whatever its analytics setting says. For the checks it is
 * pointed at a loopback port nothing listens on, so neither leaves this machine.
 */
export function maestroEnv(closedPort: number): Record<string, string> {
  return {
    MAESTRO_CLI_NO_ANALYTICS: "1",
    MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: "true",
    MAESTRO_DISABLE_UPDATE_CHECK: "true",
    MAESTRO_API_URL: `http://127.0.0.1:${closedPort}`,
    // On a loaded machine its runner can take many minutes to start on the device.
    MAESTRO_DRIVER_STARTUP_TIMEOUT: "600000",
  };
}
