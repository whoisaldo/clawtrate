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
 * `stopAll` ends exactly the ones it started. `check` decides which requests
 * may start; the setup host uses `checkRequest`.
 */
export class ProgramRunner {
  private readonly children = new Set<ChildProcess>();
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

  /** Asks a child to stop, and kills it if it is still there after the grace. */
  private end(child: ChildProcess): void {
    const pid = child.pid;
    if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }, this.graceMs);
    timer.unref?.();
    child.once("exit", () => clearTimeout(timer));
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
        });
      } catch {
        resolve({ exitCode: null, stdout: "", timedOut: false, tooLarge: false, failed: true });
        return;
      }
      this.children.add(child);
      const chunks: Buffer[] = [];
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
        this.end(child);
      }, request.timeoutMs);
      child.stdout!.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > request.maxBytes) {
          tooLarge = true;
          this.end(child);
          return;
        }
        chunks.push(chunk);
      });
      // Read and dropped: a program's own messages are never kept or shown.
      child.stderr!.on("data", () => {});
      child.once("error", () =>
        finish({ exitCode: null, stdout: "", timedOut, tooLarge, failed: true }),
      );
      const done = (code: number | null) =>
        finish({
          exitCode: code,
          stdout: tooLarge ? "" : Buffer.concat(chunks).toString("utf8"),
          timedOut,
          tooLarge,
          failed: false,
        });
      child.once("close", (code) => done(code));
      // When the program has exited, its pipes get a moment to drain, then it is over.
      child.once("exit", (code) => {
        const drain = setTimeout(() => done(code), 500);
        drain.unref?.();
      });
    });
  };

  /** The PIDs of the programs running now. */
  running(): number[] {
    return [...this.children].flatMap((child) => (child.pid === undefined ? [] : [child.pid]));
  }

  /** Ends every program this runner started that still runs, by its PID, killing it after the grace. */
  stopAll(): void {
    for (const child of this.children) this.end(child);
  }
}
