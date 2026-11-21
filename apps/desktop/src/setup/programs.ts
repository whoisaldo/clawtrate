// The one way the host starts a program for setup (docs/design/setup.md
// §2 rules 2, 4 and 6): a fixed program, one of the exact commands the look
// and Connect use, an environment the caller names in full from a fixed set
// of variables, a working folder of its own, never a shell. Standard output
// is read in memory up to a limit; standard error is read and dropped, so no
// free-form message of a program is ever kept. A program that ignores the
// request to stop is killed after a short grace.

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";
import { INSTANCE_NAME_PATTERN } from "../../../../tools/dev-gateway/src/instance.ts";

export type ProgramResult = {
  /** The exit code, or null when the program was ended or did not start. */
  exitCode: number | null;
  stdout: string;
  timedOut: boolean;
  tooLarge: boolean;
  /** The program could not be started at all. */
  failed: boolean;
  /**
   * Its output didn't end before the program's own end and a short drain (a worker it started
   * kept the pipe): what came is dropped, never parsed, and `stdout` is empty.
   */
  cut?: boolean;
};

export type ProgramRequest = {
  program: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  /** The working folder: the sandbox's home, or the home in production. Never the app's own. */
  cwd: string;
  timeoutMs: number;
  maxBytes: number;
};

export type RunProgram = (request: ProgramRequest) => Promise<ProgramResult>;

/** How long a program asked to stop gets before it is killed. */
export const STOP_GRACE_MS = 2_000;

/** The commands the look and Connect run, after the optional profile pair. */
const COMMANDS: ReadonlyArray<readonly string[]> = [
  ["--version"],
  ["gateway", "status", "--json"],
  ["gateway", "status", "--json", "--deep"],
  ["config", "get", "gateway.auth.mode", "--json"],
];
const QR = ["qr", "--json", "--voice-node", "--url"];
/** The one address a code may be made for: this computer's loopback, a valid port. */
const LOOPBACK_URL = /^ws:\/\/127\.0\.0\.1:([1-9][0-9]{3,4})$/;
const ENV_KEYS = new Set([
  "HOME",
  "LANG",
  "NO_COLOR",
  "PATH",
  "OPENCLAW_PROFILE",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
]);
/**
 * No shell reads a request (`shell: false`, the arguments as an array), so a value or a path is
 * refused only for what a process environment or a file name can't carry well: control
 * characters, NUL among them. A home whose name has an accent or an apostrophe passes.
 */
const hasControl = (text: string) =>
  [...text].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);

const profileName = (name: string | undefined) =>
  name === "clawtrate" ||
  (name !== undefined &&
    name.startsWith("clawtrate-dev-") &&
    INSTANCE_NAME_PATTERN.test(name.slice("clawtrate-dev-".length)));

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/** Whether `args` is exactly one of the look's or Connect's commands. */
export function isLookCommand(args: readonly string[]): boolean {
  const rest = args[0] === "--profile" ? (profileName(args[1]) ? args.slice(2) : null) : args;
  if (rest === null) return false;
  if (COMMANDS.some((command) => same(rest, command))) return true;
  if (rest.length !== QR.length + 1 || !same(rest.slice(0, QR.length), QR)) return false;
  const match = LOOPBACK_URL.exec(rest[QR.length]!);
  return match !== null && Number(match[1]) <= 65535;
}

/** Throws before anything starts when the program, command, variables or folder are not ones the host may use. */
export function checkRequest(request: ProgramRequest): void {
  // A fixed path from the look's list, which may hold a space ("Application Support").
  if (!isAbsolute(request.program) || hasControl(request.program))
    throw new Error("refusing a program that is not a fixed absolute path");
  if (!isLookCommand(request.args)) throw new Error("refusing a command the look doesn't run");
  for (const [key, value] of Object.entries(request.env)) {
    if (!ENV_KEYS.has(key) || hasControl(value) || value.length > 4096)
      throw new Error("refusing an environment variable the look doesn't pass");
  }
  if (!isAbsolute(request.cwd))
    throw new Error("refusing a program without a working folder of its own");
}

/**
 * Starts programs and remembers each by its PID until it exits, so that
 * `stopAll` ends exactly the ones it started. Each starts as the leader of a
 * process group of its own, so a worker it starts is in that group: stopping
 * signals the group by its id, which the system doesn't reuse while any
 * member lives, never a process found by name. A worker that leaves the group
 * on purpose is not setup's to supervise. `check` decides which requests may
 * start; the setup host uses `checkRequest`.
 */
export class ProgramRunner {
  private readonly children = new Set<ChildProcess>();
  /** The process groups of programs this runner started, until each has no member left. */
  private readonly groups = new Set<number>();
  private readonly spawnImpl: typeof nodeSpawn;
  private readonly check: (request: ProgramRequest) => void;
  private readonly graceMs: number;

  constructor(
    options: {
      spawn?: typeof nodeSpawn;
      check?: (request: ProgramRequest) => void;
      graceMs?: number;
    } = {},
  ) {
    this.spawnImpl = options.spawn ?? nodeSpawn;
    this.check = options.check ?? checkRequest;
    this.graceMs = options.graceMs ?? STOP_GRACE_MS;
  }

  /** Whether a group this runner started still has a member; a gone one is forgotten. */
  private alive(group: number): boolean {
    try {
      process.kill(-group, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
      this.groups.delete(group);
      return false;
    }
  }

  /** Signals one group this runner started, while it has members. */
  private signal(group: number, name: NodeJS.Signals): void {
    if (!this.alive(group)) return;
    try {
      process.kill(-group, name);
    } catch {
      // gone meanwhile
    }
  }

  /**
   * Asks a program and the workers in its group to stop, and kills what is
   * still there after the grace. Resolves once the group has no member left,
   * or a moment after the kill.
   */
  private end(group: number): Promise<void> {
    if (!this.alive(group)) return Promise.resolve();
    this.signal(group, "SIGTERM");
    return new Promise((resolve) => {
      const started = Date.now();
      const poll = setInterval(() => {
        if (!this.alive(group)) {
          clearInterval(poll);
          resolve();
          return;
        }
        const waited = Date.now() - started;
        if (waited >= this.graceMs) this.signal(group, "SIGKILL");
        if (waited >= this.graceMs + 1000) {
          clearInterval(poll);
          resolve();
        }
      }, 50);
      poll.unref?.();
    });
  }

  readonly run: RunProgram = (request) => {
    this.check(request);
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = this.spawnImpl(request.program, [...request.args], {
          env: { ...request.env },
          cwd: request.cwd,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          // A process group of its own, which the workers it starts join.
          detached: process.platform !== "win32",
        });
      } catch {
        resolve({ exitCode: null, stdout: "", timedOut: false, tooLarge: false, failed: true });
        return;
      }
      this.children.add(child);
      const group = child.pid;
      if (group !== undefined && process.platform !== "win32") this.groups.add(group);
      const stop = () => {
        if (group !== undefined && process.platform !== "win32") void this.end(group);
        else child.kill("SIGTERM");
      };
      const chunks: Buffer[] = [];
      let ended = false;
      child.stdout!.once("end", () => (ended = true));
      let size = 0;
      let timedOut = false;
      let tooLarge = false;
      let settled = false;
      const finish = (result: ProgramResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.children.delete(child);
        // A descendant that kept the pipes open must not keep the look waiting.
        child.stdout?.destroy();
        child.stderr?.destroy();
        resolve(result);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, request.timeoutMs);
      child.stdout!.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > request.maxBytes) {
          tooLarge = true;
          stop();
          return;
        }
        chunks.push(chunk);
      });
      // Read and dropped: a program's own messages are never kept or shown.
      child.stderr!.on("data", () => {});
      child.once("error", () =>
        finish({ exitCode: null, stdout: "", timedOut, tooLarge, failed: true }),
      );
      const done = (code: number | null) => {
        // Only a whole output is kept: one still open after the drain was cut, and is dropped.
        const cut = !ended;
        finish({
          exitCode: code,
          stdout: tooLarge || cut ? "" : Buffer.concat(chunks).toString("utf8"),
          timedOut,
          tooLarge,
          failed: false,
          ...(cut ? { cut: true } : {}),
        });
      };
      child.once("close", (code) => done(code));
      // When the program has exited, its pipes get a moment to drain, then it is over.
      child.once("exit", (code) => {
        const drain = setTimeout(() => done(code), 500);
        drain.unref?.();
      });
    });
  };

  /** How many groups this runner started still have a member: workers may outlive their program. */
  groupsLeft(): number {
    return [...this.groups].filter((group) => this.alive(group)).length;
  }

  /** The PIDs of the programs running now. */
  running(): number[] {
    return [...this.children].flatMap((child) => (child.pid === undefined ? [] : [child.pid]));
  }

  /**
   * Ends every program this runner started, and the workers in their groups,
   * killing what is still there after the grace.
   */
  stopAll(): void {
    void this.stopAllAndWait();
  }

  /** `stopAll`, resolving once every group this runner started has no member left. */
  async stopAllAndWait(): Promise<void> {
    for (const child of this.children)
      if (process.platform === "win32" && child.exitCode === null) child.kill("SIGTERM");
    await Promise.all([...this.groups].map((group) => this.end(group)));
  }
}
