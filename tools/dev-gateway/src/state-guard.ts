// The development gateway never runs on reused state. Every start deletes the
// tool's own state folder and creates it again empty, so there is nothing old
// to inspect for credentials. OpenClaw keeps secrets in SQLite stores that a
// clean profile also has, so checking contents could never prove a folder clean.
//
// "The tool's own" is decided without following links: the state path is a real
// directory, not a symlink, and holds the marker as a regular file. Anything
// else is foreign and is never deleted or changed.
//
// The marker records every process a start spawned on the folder, each by PID
// and by its start time, so a PID the system has since reused never counts as
// the tool's process. A process the marker cannot identify is unknown, and
// unknown is treated as running: nothing is deleted or signalled on its account.

import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isNamedInstancePort, validateInstanceName } from "./instance.ts";

export const MARKER_FILE = ".clawtrate-dev-gateway";
const CREATED_BY = "clawtrate tools/dev-gateway";

export type ProcessRole = "start" | "provider" | "gateway" | "node";
export const PROCESS_ROLES: readonly ProcessRole[] = ["start", "provider", "gateway", "node"];
/** The processes a start spawns and records. `node` only with `--with-node`. */
export type SpawnedRole = Exclude<ProcessRole, "start">;

/** What a start records about itself when it creates the folder. */
export type MarkerOrigin = {
  /** The instance name, or null for the default instance. */
  instance?: string | null;
  gatewayPort?: number;
  providerPort?: number;
  /** The checkout whose tool created the folder. Local only, never committed. */
  checkout?: string;
  /** The `start` process, alive while the folder is being prepared. */
  startPid?: number;
  startIdentity?: string;
};

export type Marker = MarkerOrigin & {
  createdBy: typeof CREATED_BY;
  createdAt: string;
  /** Unguessable id of the start that created this folder. */
  runId: string;
  /** Written before the process is spawned; replaced by its PID and identity after. */
  providerPending?: true;
  gatewayPending?: true;
  nodePending?: true;
  providerPid?: number;
  providerIdentity?: string;
  gatewayPid?: number;
  gatewayIdentity?: string;
  /** The scripted node host (`--with-node`), when there is one. */
  nodePid?: number;
  nodeIdentity?: string;
};

/**
 * This checkout's claim on an instance, written by `start` once the folder is
 * created and never changed. Processes are proven through the marker.
 */
export type RunRecord = {
  runId: string;
  instance: string | null;
  checkout: string;
  gatewayPort: number;
  providerPort: number;
  startedAt: string;
};

export type Ownership = "absent" | "owned" | "foreign";

export class ForeignStateError extends Error {
  constructor(stateDir: string) {
    super(
      `${stateDir} exists but was not created by the dev-gateway tool. ` +
        "Nothing was deleted or changed. Move it away yourself if it is not needed.",
    );
    this.name = "ForeignStateError";
  }
}

/** Thrown instead of deleting, restarting or signalling when that cannot be proven safe. */
export class StateInUseError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "StateInUseError";
  }
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** A regular file's JSON object, never through a link; null otherwise. */
export function readJsonFile(path: string): Record<string, unknown> | null {
  if (!lstatOrNull(path)?.isFile()) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function readMarker(stateDir: string): Marker | null {
  const marker = readJsonFile(join(stateDir, MARKER_FILE));
  if (marker?.createdBy !== CREATED_BY) return null;
  return marker as Marker;
}

/** Decided with `lstat` only: no link is followed. */
export function ownership(stateDir: string): Ownership {
  const stat = lstatOrNull(stateDir);
  if (!stat) return "absent";
  if (stat.isSymbolicLink() || !stat.isDirectory()) return "foreign";
  return readMarker(stateDir) ? "owned" : "foreign";
}

export function newRunId(): string {
  return randomBytes(24).toString("hex");
}

/** A PID that may be checked or signalled: an integer above 1. Never 0, 1 or a group. */
export function validPid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 1;
}

/**
 * What a look at one PID established. "exited" needs positive evidence: the
 * kernel reports no such process, or `ps` shows it as a zombie. A lookup that
 * failed, timed out or could not be read is "unknown", never "exited".
 */
export type Lookup =
  | { state: "alive"; identity: string }
  | { state: "exited"; how: "absent" | "zombie" }
  | { state: "unknown"; reason: string };

export type Identify = (pid: number) => Lookup;

const unknown = (reason: string): Lookup => ({ state: "unknown", reason });

/** Asks the kernel whether the PID exists. Signal 0 delivers nothing. */
function kernelSaysAbsent(pid: number): boolean | string {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return true;
    // EPERM: it exists and belongs to someone else. Anything else is not an answer.
    return code === "EPERM" ? false : `could not check pid ${pid}: ${String(code)}`;
  }
}

/**
 * One row of `ps -o stat= -o lstart=` in the C locale: a state field, then a
 * start time such as `Mon Nov 16 21:27:01 2026`. The state's first character
 * varies by system; macOS shows `?E` for a process that is exiting.
 */
const PS_ROW =
  /^\s*([DIRSTUWXZt?][A-Za-z+<>]{0,7})\s+((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*$/;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A start time as `ps` prints it in UTC ("Mon Nov 16 21:27:01 2026"), as the
 * identity this tool records: "2026-11-16T21:27:01Z", the same whatever time
 * zone the caller runs in.
 */
function utcIdentity(lstart: string): string | null {
  const [, month, day, time, year] = lstart.trim().split(/\s+/);
  const index = MONTHS.indexOf(month ?? "");
  if (index < 0 || !day || !time || !year) return null;
  return `${year}-${String(index + 1).padStart(2, "0")}-${day.padStart(2, "0")}T${time}Z`;
}

/**
 * An identity recorded by earlier versions: the start time in the local time
 * zone of whoever recorded it, which can't be compared with one read now.
 */
const LOCAL_IDENTITY =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/;

/** Where the system keeps `ps`, in order; a merged `/usr` has both. */
const SYSTEM_PS = ["/bin/ps", "/usr/bin/ps"];

/**
 * A process lookup that runs the first of `candidates` that exists: the
 * process's start time from `ps`, which together with its PID identifies it.
 */
export function psIdentity(candidates: readonly string[]): Identify {
  return (pid) => {
    if (!validPid(pid)) return unknown(`${String(pid)} is not a process id this tool checks`);
    const absent = kernelSaysAbsent(pid);
    if (absent === true) return { state: "exited", how: "absent" };
    if (typeof absent === "string") return unknown(absent);
    // The system's own ps, by its fixed path, never one PATH would choose; none there, no answer.
    const ps = candidates.find((path) => existsSync(path));
    if (ps === undefined) return unknown("the system's ps was not found");
    const result = spawnSync(ps, ["-o", "stat=", "-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5000,
      // A fixed environment, so every caller reads the same start time: English day and month
      // names in the C locale, in UTC whatever the caller's time zone.
      env: { LC_ALL: "C", TZ: "UTC" },
    });
    // A process that exited between the two looks makes ps fail; that much is still positive.
    const failed = (reason: string): Lookup =>
      kernelSaysAbsent(pid) === true ? { state: "exited", how: "absent" } : unknown(reason);
    if (result.error) return failed(`could not run ps for pid ${pid}: ${result.error.message}`);
    if (result.status !== 0) {
      return failed(`ps for pid ${pid} exited with ${result.status ?? result.signal}`);
    }
    // Only one complete row counts: a known state field and a whole start time. Anything
    // else, such as an error message printed with exit status 0, is not an answer, and
    // must never become an identity that differs from the recorded one.
    const rows = result.stdout.split("\n").filter((line) => line.trim() !== "");
    const match = rows.length === 1 ? PS_ROW.exec(rows[0]!) : null;
    if (!match) return failed(`could not read ps output for pid ${pid}`);
    // A zombie has exited; only its parent has not collected it yet.
    if (match[1]!.startsWith("Z")) return { state: "exited", how: "zombie" };
    const identity = utcIdentity(match[2]!);
    if (identity === null) return failed(`could not read ps output for pid ${pid}`);
    return { state: "alive", identity };
  };
}

/** The system's own `ps`, run by its fixed path. */
export const processIdentity: Identify = psIdentity(SYSTEM_PS);

/** "none": not recorded. "unknown": not determinable, so treated as possibly running. */
export type ProcessState = "none" | "dead" | "alive" | "unknown";

export function processState(pid: unknown, identity: unknown, identify: Identify): ProcessState {
  return processVerdict(pid, identity, identify).state;
}

/** The state of a recorded process, with why it is unknown when it is. */
export function processVerdict(
  pid: unknown,
  identity: unknown,
  identify: Identify,
): { state: ProcessState; reason?: string } {
  if (pid === undefined && identity === undefined) return { state: "none" };
  if (!validPid(pid) || typeof identity !== "string" || identity === "") {
    return { state: "unknown", reason: "its record cannot identify a process" };
  }
  // A start time recorded in a local time zone: neither a match nor a mismatch.
  if (LOCAL_IDENTITY.test(identity)) {
    return { state: "unknown", reason: "its record's start time is in a local time zone" };
  }
  const now = identify(pid);
  if (now.state === "unknown") return { state: "unknown", reason: now.reason };
  if (now.state === "exited") return { state: "dead" };
  // A live process with another start time holds a reused PID: the recorded one is gone.
  return { state: now.identity === identity ? "alive" : "dead" };
}

/** Markers written by versions of the tool before process identities were recorded. */
export function isLegacyMarker(marker: Marker): boolean {
  return marker.startIdentity === undefined;
}

/**
 * Everything wrong with a marker for the instance whose folder it sits in.
 * Any problem makes the folder untrusted: never started over, signalled or
 * deleted by the tool. Markers of older versions always have problems.
 */
export function markerProblems(marker: Marker, instance: string | null): string[] {
  const problems: string[] = [];
  if (isLegacyMarker(marker)) {
    problems.push("it was written by an older version of this tool (see the README on migrating)");
  }
  if (typeof marker.runId !== "string" || !/^[0-9a-f]{48}$/.test(marker.runId)) {
    problems.push("its run id is missing or malformed");
  }
  if (marker.instance !== instance) {
    problems.push(
      `it names instance ${JSON.stringify(marker.instance ?? null)}, not ${JSON.stringify(instance)}`,
    );
  } else if (instance !== null) {
    try {
      validateInstanceName(instance);
    } catch {
      problems.push("its instance name is invalid");
    }
  }
  if (typeof marker.checkout !== "string" || marker.checkout === "") {
    problems.push("it records no checkout");
  }
  if (instance !== null) {
    if (!isNamedInstancePort(marker.gatewayPort) || !isNamedInstancePort(marker.providerPort)) {
      problems.push("it records no valid ports");
    }
  }
  for (const role of PROCESS_ROLES) {
    const pid = marker[`${role}Pid`];
    const identity = marker[`${role}Identity`];
    const recorded = pid !== undefined || identity !== undefined;
    if (role === "start" && !recorded) problems.push("it records no start process");
    if (recorded && (!validPid(pid) || typeof identity !== "string" || identity === "")) {
      problems.push(`its ${role} process record is incomplete or invalid`);
    }
    if (role !== "start") {
      const pending = marker[`${role}Pending`];
      if (pending !== undefined && (pending !== true || recorded)) {
        problems.push(`its ${role} process record is inconsistent`);
      }
    }
  }
  return problems;
}

function instanceLabel(instance: string | null, stateDir: string): string {
  const name = instance === null ? "the default instance" : `instance "${instance}"`;
  return `${name} (${stateDir})`;
}

type Activity =
  | { kind: "idle" }
  | { kind: "untrusted"; reason: string }
  | { kind: "running"; role: ProcessRole; pid: number; marker: Marker }
  | { kind: "unknown"; role: ProcessRole; pid: unknown; reason: string; marker: Marker };

/**
 * Whether anything recorded on an owned folder could still be running. "idle"
 * needs every recorded process proven gone. A process recorded as pending, to
 * be spawned but not yet recorded, is gated (see `gatedSpawn` in env.ts): it
 * cannot run before its record is written, and exits as soon as the start that
 * spawned it is gone. So it counts as running while that start runs, unknown
 * while that start is unknown, and gone once that start is proven gone.
 */
function activity(stateDir: string, instance: string | null, identify: Identify): Activity {
  if (ownership(stateDir) !== "owned") return { kind: "idle" };
  const marker = readMarker(stateDir)!;
  const problems = markerProblems(marker, instance);
  if (problems.length > 0) return { kind: "untrusted", reason: problems.join("; ") };
  // A start holds the instance's lifecycle lock until it has finished, so a
  // caller that is itself the recorded start process (and holds that lock, as
  // every deleting command does) knows that start is over.
  const startIsSelf = marker.startPid === process.pid;
  const start = startIsSelf
    ? ({ state: "none" } as const)
    : processVerdict(marker.startPid, marker.startIdentity, identify);
  for (const role of PROCESS_ROLES) {
    const pending = role !== "start" && marker[`${role}Pending`] === true;
    const verdict = pending
      ? start
      : role === "start"
        ? start
        : processVerdict(marker[`${role}Pid`], marker[`${role}Identity`], identify);
    const pid = pending ? marker.startPid : marker[`${role}Pid`];
    if (verdict.state === "alive") return { kind: "running", role, pid: pid!, marker };
    if (verdict.state === "unknown") {
      return { kind: "unknown", role, pid, reason: verdict.reason ?? "unknown", marker };
    }
  }
  return { kind: "idle" };
}

/** Why the folder must not be deleted because something on it may run, or null. */
export function activityRefusal(
  stateDir: string,
  instance: string | null,
  identify: Identify = processIdentity,
): string | null {
  const found = activity(stateDir, instance, identify);
  const label = instanceLabel(instance, stateDir);
  if (found.kind === "untrusted") {
    return `${label} has a marker this tool cannot trust: ${found.reason}. Nothing was changed.`;
  }
  if (found.kind === "unknown") {
    return `${label}: could not determine whether its ${found.role} process (pid ${String(found.pid)}) is still running (${found.reason}). Nothing was changed.`;
  }
  if (found.kind === "running") {
    const where = found.marker.checkout ? `, started from ${found.marker.checkout}` : "";
    return `${label} is in use: its ${found.role} process (pid ${found.pid}${where}) is still running. Nothing was changed.`;
  }
  return null;
}

/** True when this checkout's run file proves the folder's current run is this checkout's. */
export function runMatches(
  run: RunRecord | null,
  marker: Marker | null,
  instance: string | null,
  checkout: string,
): boolean {
  return (
    run !== null &&
    marker !== null &&
    typeof marker.runId === "string" &&
    marker.runId !== "" &&
    run.runId === marker.runId &&
    run.instance === instance &&
    marker.instance === instance &&
    run.checkout === checkout &&
    marker.checkout === checkout
  );
}

/**
 * Why this checkout must not touch the folder because processes it cannot
 * prove its own may run on it, or because it cannot tell, or null. Running
 * processes of this checkout's own run are for `stop` to prove and stop.
 */
export function inUseRefusal(
  stateDir: string,
  instance: string | null,
  run: RunRecord | null,
  checkout: string,
  identify: Identify = processIdentity,
): string | null {
  const found = activity(stateDir, instance, identify);
  if (found.kind === "idle") return null;
  if (found.kind === "running" && runMatches(run, found.marker, instance, checkout)) return null;
  if (found.kind !== "running") return activityRefusal(stateDir, instance, identify);
  const where = found.marker.checkout ? ` (${found.marker.checkout})` : "";
  return (
    `${instanceLabel(instance, stateDir)} is in use: its ${found.role} process (pid ${found.pid}) ` +
    `is still running and was started by another checkout${where}, not by this one. ` +
    "Nothing was changed. Use another instance name, or stop it from the checkout that started it."
  );
}

function writeMarker(stateDir: string, marker: Marker): void {
  // Written whole and renamed into place, so a reader never sees half a marker.
  const temp = join(stateDir, `${MARKER_FILE}.${process.pid}.tmp`);
  writeFileSync(temp, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, join(stateDir, MARKER_FILE));
}

/**
 * Leave the state folder empty apart from a new marker for `runId`. An owned
 * folder is deleted first only when nothing recorded on it can still be
 * running (links inside it are removed, never followed); a foreign one is
 * refused untouched. Callers hold the instance's lifecycle lock and check for
 * listeners first.
 */
export function prepareFreshState(
  stateDir: string,
  runId: string,
  origin: MarkerOrigin,
  identify: Identify = processIdentity,
  now = new Date(),
): void {
  const owner = ownership(stateDir);
  if (owner === "foreign") throw new ForeignStateError(stateDir);
  if (owner === "owned") {
    const busy = activityRefusal(stateDir, origin.instance ?? null, identify);
    if (busy) throw new StateInUseError(busy);
    rmSync(stateDir, { recursive: true });
  }
  // Fails if anything appeared in the meantime, rather than reusing it.
  mkdirSync(stateDir, { mode: 0o700 });
  writeMarker(stateDir, { ...origin, createdBy: CREATED_BY, createdAt: now.toISOString(), runId });
}

function markerOfRun(stateDir: string, runId: string): Marker {
  const marker = readMarker(stateDir);
  if (ownership(stateDir) !== "owned" || marker?.runId !== runId) {
    throw new Error(`${stateDir} is no longer the state this start created`);
  }
  return marker;
}

/** Record, before spawning it, that this start is about to spawn a process. */
export function recordPending(stateDir: string, runId: string, role: SpawnedRole): void {
  writeMarker(stateDir, { ...markerOfRun(stateDir, runId), [`${role}Pending`]: true });
}

/** Complete a pending record with the PID and start time of the process just spawned. */
export function recordProcess(
  stateDir: string,
  runId: string,
  role: SpawnedRole,
  pid: number | undefined,
  identify: Identify = processIdentity,
): void {
  const marker = markerOfRun(stateDir, runId);
  const found = validPid(pid) ? identify(pid) : null;
  if (!validPid(pid) || found?.state !== "alive") {
    throw new Error(
      `the ${role} process (pid ${String(pid)}) could not be recorded: ${found?.state === "unknown" ? found.reason : "it is not running"}`,
    );
  }
  const next: Marker = { ...marker, [`${role}Pid`]: pid, [`${role}Identity`]: found.identity };
  delete next[`${role}Pending`];
  writeMarker(stateDir, next);
}

/** A run file, if it is a regular file with every field of the current format. */
export function readRunRecord(path: string): RunRecord | null {
  const run = readJsonFile(path);
  if (
    !run ||
    typeof run.runId !== "string" ||
    !(run.instance === null || typeof run.instance === "string") ||
    typeof run.checkout !== "string" ||
    typeof run.gatewayPort !== "number" ||
    typeof run.providerPort !== "number" ||
    typeof run.startedAt !== "string"
  ) {
    return null;
  }
  return run as RunRecord;
}

/**
 * Why OpenClaw must not run now, or null when it may. It may run only against
 * the tool's own state, and only during the start that just created it
 * (`freshRunId`) or while the gateway this checkout's run recorded is running.
 */
export function spawnRefusal(params: {
  stateDir: string;
  run: RunRecord | null;
  freshRunId: string | null;
  /** The instance this folder must belong to; null is the default instance. */
  instance: string | null;
  checkout: string;
  identify?: Identify;
}): string | null {
  const owner = ownership(params.stateDir);
  if (owner === "absent") {
    return "There is no development gateway state. Run `pnpm dev-gateway start`.";
  }
  if (owner === "foreign") return new ForeignStateError(params.stateDir).message;
  const marker = readMarker(params.stateDir)!;
  const { instance } = params;
  const problems = markerProblems(marker, instance);
  if (problems.length > 0) {
    return `${params.stateDir} has a marker this tool cannot trust: ${problems.join("; ")}.`;
  }
  if (params.freshRunId !== null && marker.runId === params.freshRunId) return null;
  const { run } = params;
  if (
    !runMatches(run, marker, instance, params.checkout) ||
    run!.gatewayPort !== (instance === null ? run!.gatewayPort : marker.gatewayPort) ||
    run!.providerPort !== (instance === null ? run!.providerPort : marker.providerPort)
  ) {
    return "The development gateway state does not belong to the gateway this checkout last started. Run `pnpm dev-gateway start`.";
  }
  const state = processState(
    marker.gatewayPid,
    marker.gatewayIdentity,
    params.identify ?? processIdentity,
  );
  if (state !== "alive") {
    return `The development gateway started on this state (pid ${marker.gatewayPid ?? "?"}) is not running. Run \`pnpm dev-gateway start\`.`;
  }
  return null;
}
