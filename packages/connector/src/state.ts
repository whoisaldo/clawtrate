// The connector's own state folder: its keys, its relay id's settings, the phone allowlist with
// the pending enrollment offers, what it changed in the gateway's config, and the running
// connector's status. Nothing here is ever written inside an OpenClaw folder.
//
// Every file is JSON, written atomically (a new file beside it, flushed, then renamed over it)
// and readable by its owner alone. A file that does not read back as exactly what this version
// writes is refused, never repaired or overwritten. Writes that read first take the folder's
// lock, so `pair-phone`, `remove-phone` and the running connector never lose each other's change.

import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

export type StateErrorCode =
  /** A file is not what this version writes: bad JSON, wrong fields or values. */
  | "corrupt"
  /** The folder or a file can be read or changed by someone other than its owner, or is a link. */
  | "unsafe"
  /** The folder would sit inside an OpenClaw folder. */
  | "openclaw_folder"
  /** Another command held the folder's lock for too long. */
  | "busy"
  /** Setup has not been run on this folder. */
  | "not_set_up";

export class StateError extends Error {
  readonly code: StateErrorCode;
  constructor(code: StateErrorCode, message: string) {
    super(message);
    this.name = "StateError";
    this.code = code;
  }
}

/** How long a command may wait for the lock, and when a lock left behind counts as abandoned. */
const LOCK_WAIT_MS = 3_000;
const LOCK_STALE_MS = 30_000;
const LOCK_FILE = ".lock";

/** `$CLAWTRATE_CONNECTOR_HOME`, or `~/.clawtrate-connector`. */
export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const chosen = env.CLAWTRATE_CONNECTOR_HOME;
  return chosen ? resolve(chosen) : join(homedir(), ".clawtrate-connector");
}

/**
 * Refuses a folder inside an OpenClaw folder: any part of the resolved path whose name begins
 * with `.openclaw` (the gateway's `~/.openclaw` and every profile's `~/.openclaw-<profile>`), or
 * inside `$OPENCLAW_STATE_DIR` or `$OPENCLAW_HOME` when they are set. Links are resolved for the
 * part of the path that exists.
 */
export function checkNotOpenclawFolder(dir: string, env: NodeJS.ProcessEnv = process.env): void {
  const resolved = resolveExisting(dir);
  const parts = resolved.split(sep);
  if (parts.some((part) => part.toLowerCase().startsWith(".openclaw"))) {
    throw new StateError("openclaw_folder", `${resolved} is inside an OpenClaw folder.`);
  }
  for (const name of ["OPENCLAW_STATE_DIR", "OPENCLAW_HOME"] as const) {
    const value = env[name];
    if (!value) continue;
    const root = resolveExisting(value);
    if (resolved === root || resolved.startsWith(root + sep) || root.startsWith(resolved + sep)) {
      throw new StateError("openclaw_folder", `${resolved} overlaps ${name}.`);
    }
  }
}

/** The real path of the longest part of `path` that exists, with the rest appended. */
function resolveExisting(path: string): string {
  let head = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...tail.reverse());
    } catch {
      const parent = dirname(head);
      if (parent === head) return resolve(path);
      tail.push(basename(head));
      head = parent;
    }
  }
}

/** Sleeps the thread: the lock is held for milliseconds, and the gate's commit is synchronous. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class StateDir {
  readonly path: string;

  private constructor(path: string) {
    this.path = path;
  }

  /** Opens an existing folder, checking where it is and who may read it. */
  static open(dir: string, env: NodeJS.ProcessEnv = process.env): StateDir {
    if (!isAbsolute(dir)) dir = resolve(dir);
    checkNotOpenclawFolder(dir, env);
    const state = new StateDir(dir);
    state.checkFolder();
    return state;
  }

  /** Creates the folder, owner-only, if it does not exist, then opens it. */
  static create(dir: string, env: NodeJS.ProcessEnv = process.env): StateDir {
    if (!isAbsolute(dir)) dir = resolve(dir);
    checkNotOpenclawFolder(dir, env);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return StateDir.open(dir, env);
  }

  private checkFolder(): void {
    let info;
    try {
      info = lstatSync(this.path);
    } catch {
      throw new StateError("not_set_up", `${this.path} does not exist. Run setup first.`);
    }
    if (!info.isDirectory()) throw new StateError("unsafe", `${this.path} is not a folder.`);
    if ((info.mode & 0o077) !== 0) {
      throw new StateError("unsafe", `${this.path} can be read by others; it must be mode 700.`);
    }
    const uid = process.getuid?.();
    if (uid !== undefined && info.uid !== uid) {
      throw new StateError("unsafe", `${this.path} belongs to another user.`);
    }
  }

  file(name: string): string {
    return join(this.path, name);
  }

  /**
   * Reads one file and checks it with `parse`. Null when it does not exist. A link, a file
   * others can read, bad JSON or a value `parse` refuses throws.
   */
  read<T>(name: string, parse: (value: unknown) => T): T | null {
    const path = this.file(name);
    let info;
    try {
      info = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (!info.isFile()) throw new StateError("unsafe", `${path} is not a plain file.`);
    if ((info.mode & 0o077) !== 0) {
      throw new StateError("unsafe", `${path} can be read by others; it must be mode 600.`);
    }
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new StateError("corrupt", `${path} is not valid JSON. It was left as it is.`);
    }
    try {
      return parse(value);
    } catch (error) {
      throw new StateError(
        "corrupt",
        `${path} is not a file this version wrote (${(error as Error).message}). It was left as it is.`,
      );
    }
  }

  /** Writes one file atomically, mode 600: a new file is written and flushed, then renamed. */
  write(name: string, value: unknown): void {
    const path = this.file(name);
    const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try {
      try {
        writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, path);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        // Already renamed or never made.
      }
      throw error;
    }
    // The rename is kept once the folder itself is flushed.
    const dirFd = openSync(this.path, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  }

  /** Removes one file of the folder's own, by name. */
  remove(name: string): void {
    try {
      unlinkSync(this.file(name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  /**
   * Runs `action` holding the folder's lock, synchronously. Another holder is waited for up to
   * 3 seconds; a lock older than 30 seconds was left by a process that died and is taken over.
   */
  withLock<T>(action: () => T): T {
    const path = this.file(LOCK_FILE);
    const deadline = Date.now() + LOCK_WAIT_MS;
    let fd: number | null = null;
    while (fd === null) {
      try {
        fd = openSync(path, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (lockAge(path) > LOCK_STALE_MS) {
          try {
            unlinkSync(path);
          } catch {
            // Another process took it over first.
          }
          continue;
        }
        if (Date.now() > deadline) {
          throw new StateError("busy", `${this.path} is busy: another command holds its lock.`);
        }
        sleepSync(10);
      }
    }
    try {
      writeSync(fd, `${process.pid}\n`);
      return action();
    } finally {
      closeSync(fd);
      unlinkSync(path);
    }
  }
}

function lockAge(path: string): number {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

// Small strict readers for the files' shapes.

export function objectWithKeys(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("not an object");
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) {
    throw new Error(`fields ${actual.join(",")} instead of ${expected.join(",")}`);
  }
  return value as Record<string, unknown>;
}

export function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`${key} is not text`);
  return value;
}

export function millisField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${key} is not a time`);
  }
  return value;
}

export function versionOne(record: Record<string, unknown>): void {
  if (record.v !== 1) throw new Error("not version 1");
}
