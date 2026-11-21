// The look on this computer (docs/design/setup.md §4, §6): find the
// program in its fixed places, ask its version, ask each profile's gateway,
// and say what was found. Every step is read-only and has its own time
// limit; every program runs through `RunProgram`, never a shell, in the
// world's own working folder. A sandboxed world never runs the deep status.

import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { processIdentity, type Identify } from "../../../../tools/dev-gateway/src/state-guard.ts";
import { basename, dirname, join } from "node:path";
import {
  MAX_LOOK_OTHERS,
  OLDEST_OPENCLAW_VERSION,
  TESTED_OPENCLAW_VERSION,
  type CantTellReason,
  type LookOutcome,
  type SetupLook,
} from "@clawtrate/core";
import {
  compareVersions,
  parseAuthMode,
  parseBareVersion,
  parseExtraServices,
  parseStatus,
  parseVersionLine,
  serviceFact,
  type AuthMode,
  type GatewayStatus,
  type Version,
} from "./parse.ts";
import type { ProgramResult, RunProgram } from "./programs.ts";
import { programPath, type LookProfile, type LookWorld } from "./world.ts";

export const OLDEST_VERSION = OLDEST_OPENCLAW_VERSION;

export const LIMITS = {
  version: { timeoutMs: 10_000, maxBytes: 4 * 1024 },
  status: { timeoutMs: 20_000, maxBytes: 256 * 1024 },
  deep: { timeoutMs: 20_000, maxBytes: 512 * 1024 },
  auth: { timeoutMs: 10_000, maxBytes: 4 * 1024 },
} as const;

/** The design's limit on the look's own checks of files (§4). */
export const FILE_CHECK_MS = 2_000;

/** The steps the person sees: "Finding OpenClaw", "Checking its version", "Asking the gateway". */
export const LOOK_STEPS = 3;

/**
 * A gateway the look found and Connect may pair with: the facts the host's
 * dialog shows and checks again. Its identities stay in the host, never in a
 * snapshot.
 */
export type FoundGateway = {
  program: string;
  /** The program file's identity when it was found (`fileIdentity`). */
  programIdentity: string;
  profile: LookProfile;
  port: number;
  /** The exact endpoint Connect uses: `ws://127.0.0.1:<port>`. */
  url: string;
  version: string;
  /** The config file `gateway status` named for this profile, and the service's. */
  configPath: string;
  daemonConfigPath: string | null;
  /** The service as the status reported it. */
  serviceKey: string;
  /** The one process listening on the endpoint, by PID and the system's start time. */
  listener: { pid: number; started: string };
};

/** A program file's identity: device, inode, size and time, read without opening it. */
export async function fileIdentity(path: string): Promise<string | null> {
  try {
    const found = await stat(path, { bigint: true });
    return [found.dev, found.ino, found.size, found.mtimeNs, found.ctimeNs].join(":");
  } catch {
    return null;
  }
}

export type LookReport = { look: SetupLook; found: FoundGateway | null };

const empty: Omit<SetupLook, "outcome"> = {
  reason: null,
  version: null,
  profile: null,
  listens: null,
  service: null,
  port: null,
  authMode: null,
  access: null,
  others: [],
};

const cantTell = (reason: CantTellReason, version: string | null = null): SetupLook => ({
  ...empty,
  outcome: "cant-tell",
  reason,
  version,
});

class FileCheckTimeout extends Error {}

/** Every file check of one look, together, within `FILE_CHECK_MS`. */
function withDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  const left = Math.max(0, deadline - Date.now());
  return Promise.race([
    work,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => reject(new FileCheckTimeout()), left);
      timer.unref?.();
    }),
  ]);
}

/**
 * The OpenClaw versions whose commands the look runs: those whose pinned source
 * shows a read-only path past the launcher's package-lifecycle branch. None yet:
 * in 2026.10.6 every command but the browser's native host goes through it
 * (openclaw.mjs, lines 649-715), and an unsupported Node starts a runtime
 * recovery that may install one (lines 37-80). Any other version declines.
 */
export const READ_ONLY_VERSIONS: ReadonlySet<string> = new Set();

/**
 * The installed version, read from the package the program belongs to, without
 * running it: the launcher `openclaw.mjs` it resolves to, beside the package's
 * own `package.json` named "openclaw". Null when it isn't that.
 */
async function installedVersion(program: string): Promise<string | null> {
  try {
    const launcher = await realpath(program);
    if (basename(launcher) !== "openclaw.mjs") return null;
    const manifest = join(dirname(launcher), "package.json");
    const info = await stat(manifest);
    if (!info.isFile() || info.size > 64 * 1024) return null;
    const parsed = JSON.parse(await readFile(manifest, "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    if (parsed.name !== "openclaw" || typeof parsed.version !== "string") return null;
    return parseBareVersion(parsed.version) ? parsed.version : null;
  } catch {
    return null;
  }
}

/** Production's check: the package's own version, and whether it is one verified read-only. */
export async function readOnlyProgram(
  program: string,
): Promise<{ verified: boolean; version: string | null }> {
  const version = await installedVersion(program);
  return { verified: version !== null && READ_ONLY_VERSIONS.has(version), version };
}

/** `fileIdentity` within the look's limit on file checks: null when the file system doesn't answer. */
export const boundedFileIdentity = (path: string): Promise<string | null> =>
  withDeadline(fileIdentity(path), Date.now() + FILE_CHECK_MS).catch(() => null);

/** Whether a path exists, followed through links. */
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** The first candidate that is a regular executable file. */
async function findProgram(world: LookWorld): Promise<string | null> {
  for (const candidate of world.candidates) {
    try {
      const found = await stat(candidate);
      if (found.isFile() && (found.mode & 0o111) !== 0) return candidate;
    } catch {
      // not there
    }
  }
  return null;
}

/** Other profiles' state folders in the home folder, by name only: folders, never opened. */
async function otherProfiles(world: LookWorld, active: () => void): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(world.home);
  } catch {
    return [];
  }
  // Nothing more is looked at once the sandbox no longer passes.
  active();
  const known = new Set(world.profiles.flatMap((profile) => [profile.name, "clawtrate"]));
  const names: string[] = [];
  for (const entry of entries) {
    const match = /^\.openclaw-([a-z0-9][a-z0-9._-]{0,63})$/.exec(entry);
    if (!match || known.has(match[1]!)) continue;
    // A file or a link of that name is not a profile.
    const folder = await lstat(join(world.home, entry)).then(
      (found) => found.isDirectory(),
      () => false,
    );
    if (folder) names.push(`profile ${match[1]}`);
  }
  return names.sort();
}

type ProfileLook =
  | { kind: "status"; status: GatewayStatus; auth: AuthMode | null }
  | { kind: "fail"; reason: CantTellReason }
  | { kind: "cant-run" };

export type LookOptions = {
  /** Called as each step starts. */
  onStep?: (step: number) => void;
  /** Set when the person went Back: nothing more is started. */
  cancelled?: () => boolean;
  /** A process's start time, to identify a gateway's listener; `ps` by default. */
  identify?: Identify;
  /**
   * A sandbox's check that its description still is the one the run validated:
   * throws the refusal. Asked before the file checks and after every wait.
   */
  checkActive?: () => void;
};

/** Whether a program couldn't be started at all: spawn failed, or the system said it can't run it. */
const couldNotRun = (result: ProgramResult) =>
  result.failed || result.exitCode === 126 || result.exitCode === 127;

export async function lookHere(
  world: LookWorld,
  run: RunProgram,
  options: LookOptions = {},
): Promise<LookReport | null> {
  const cancelled = options.cancelled ?? (() => false);
  options.onStep?.(0);
  if (world.platform === "win32") return { look: { ...empty, outcome: "windows" }, found: null };
  const active = options.checkActive ?? (() => {});
  active();

  // Every file check of the look is started now, under one deadline, before any program runs.
  const files = Date.now() + FILE_CHECK_MS;
  // An optional profile is looked at only when its state is a real folder.
  const presence = withDeadline(
    Promise.all(
      world.profiles.map(
        (profile) =>
          profile.required ||
          lstat(profile.stateDir).then(
            (found) => found.isDirectory(),
            () => false,
          ),
      ),
    ),
    files,
  );
  presence.catch(() => {});
  const folderNames = withDeadline(otherProfiles(world, active), files).catch(() => [] as string[]);
  let program: string | null;
  try {
    program = world.installed
      ? world.installed.program
      : await withDeadline(findProgram(world), files);
    active();
    if (!program) {
      // A sandbox answers from its scenario: no file is checked.
      const setUp = world.installed
        ? world.installed.signs
        : (
            await withDeadline(
              Promise.all([join(world.home, ".openclaw"), ...world.serviceFiles].map(exists)),
              files,
            )
          ).some(Boolean);
      active();
      return {
        look: { ...empty, outcome: setUp ? "program-missing" : "not-found" },
        found: null,
      };
    }
  } catch (error) {
    if (error instanceof FileCheckTimeout) return { look: cantTell("timeout"), found: null };
    throw error;
  }
  const env = (profile: LookProfile) => ({
    ...world.env,
    PATH: programPath(program),
    ...profile.env,
  });
  const runFor = (
    profile: LookProfile,
    args: string[],
    limit: (typeof LIMITS)[keyof typeof LIMITS],
  ) =>
    run({ program, args: [...profile.args, ...args], env: env(profile), cwd: world.cwd, ...limit });

  if (cancelled()) return null;
  // The program's identity before anything runs it, under the file deadline: what Connect checks
  // again is the file whose answers these are.
  const identityNow = () =>
    world.installed
      ? Promise.resolve("stand-in")
      : withDeadline(fileIdentity(program), Date.now() + FILE_CHECK_MS);
  let programIdentity: string | null;
  try {
    programIdentity = await identityNow();
  } catch (error) {
    if (error instanceof FileCheckTimeout) return { look: cantTell("timeout"), found: null };
    throw error;
  }
  if (cancelled()) return null;
  active();
  options.onStep?.(1);
  // The real program runs only in a version whose commands are verified read-only. Its version
  // comes from its package, read, never from running it; anything else declines, running nothing.
  if (!world.installed) {
    let verdict: { verified: boolean; version: string | null };
    try {
      verdict = await withDeadline(
        (world.readOnly ?? readOnlyProgram)(program),
        Date.now() + FILE_CHECK_MS,
      );
    } catch (error) {
      if (error instanceof FileCheckTimeout) return { look: cantTell("timeout"), found: null };
      throw error;
    }
    if (cancelled()) return null;
    active();
    if (!verdict.verified) return { look: cantTell("read-only", verdict.version), found: null };
  }
  const first = world.profiles[0];
  if (!first) return { look: { ...empty, outcome: "not-found" }, found: null };
  const versionRun = await runFor(first, ["--version"], LIMITS.version);
  if (cancelled()) return null;
  active();
  if (couldNotRun(versionRun)) return { look: { ...empty, outcome: "cant-run" }, found: null };
  if (versionRun.timedOut) return { look: cantTell("timeout"), found: null };
  const programVersion = versionRun.exitCode === 0 ? parseVersionLine(versionRun.stdout) : null;
  if (!programVersion) return { look: cantTell("shape"), found: null };

  options.onStep?.(2);
  let considered: LookProfile[];
  try {
    const present = await presence;
    active();
    considered = world.profiles.filter((_, index) => present[index]);
  } catch (error) {
    if (error instanceof FileCheckTimeout) return { look: cantTell("timeout"), found: null };
    throw error;
  }
  // Back during the profile check starts nothing more.
  if (cancelled()) return null;
  // The deep status scans the system's service folders: never in a sandbox.
  const deep = world.deep
    ? runFor(first, ["gateway", "status", "--json", "--deep"], LIMITS.deep)
    : Promise.resolve(null);
  const looks: ProfileLook[] = await Promise.all(
    considered.map(async (profile): Promise<ProfileLook> => {
      const [statusRun, authRun] = await Promise.all([
        runFor(profile, ["gateway", "status", "--json"], LIMITS.status),
        runFor(profile, ["config", "get", "gateway.auth.mode", "--json"], LIMITS.auth),
      ]);
      if (couldNotRun(statusRun) || couldNotRun(authRun)) return { kind: "cant-run" };
      if (statusRun.timedOut || authRun.timedOut) return { kind: "fail", reason: "timeout" };
      const status = statusRun.exitCode === 0 ? parseStatus(statusRun.stdout) : null;
      if (!status) return { kind: "fail", reason: "shape" };
      return {
        kind: "status",
        status,
        auth: authRun.exitCode === 0 ? parseAuthMode(authRun.stdout) : null,
      };
    }),
  );
  const deepRun = await deep;
  if (cancelled()) return null;
  active();
  const services =
    deepRun && deepRun.exitCode === 0 ? (parseExtraServices(deepRun.stdout) ?? []) : [];
  // A required program that couldn't start is its own result.
  if (looks.some((look) => look.kind === "cant-run"))
    return { look: { ...empty, outcome: "cant-run" }, found: null };
  const folders = await folderNames;
  active();
  const others = [...services.map((label) => `service ${label}`), ...folders].slice(
    0,
    MAX_LOOK_OTHERS,
  );

  // Two profiles that report the same port can't be told apart: neither is offered.
  const ports = looks.flatMap((look) => (look.kind === "status" ? [look.status.port] : []));
  const shared = new Set(ports.filter((port, index) => ports.indexOf(port) !== index));
  const identify = options.identify ?? processIdentity;
  // The same file still, or nothing found here is offered.
  try {
    if ((await identityNow()) !== programIdentity) programIdentity = null;
  } catch (error) {
    if (error instanceof FileCheckTimeout) return { look: cantTell("timeout"), found: null };
    throw error;
  }
  if (cancelled()) return null;
  active();
  const results = considered.map((profile, index) => {
    const look = looks[index]!;
    if (look.kind === "status" && shared.has(look.status.port))
      return { look: cantTell("endpoint", programVersion.text), found: null };
    return classify(profile, look, programVersion, program, programIdentity, identify);
  });
  // A gateway Connect can use comes first, then another that answers, then a stopped one, then
  // what the default profile gave; between two alike, the default profile.
  const rank = (outcome: LookOutcome) =>
    outcome === "running"
      ? 0
      : ["untested", "too-old", "not-token"].includes(outcome)
        ? 1
        : outcome === "stopped"
          ? 2
          : 3;
  const chosen = [...results].sort((a, b) => rank(a.look.outcome) - rank(b.look.outcome))[0];
  if (!chosen) return { look: { ...empty, outcome: "not-found" }, found: null };
  return { look: { ...chosen.look, others }, found: chosen.found };
}

const TESTED = parseBareVersion(TESTED_OPENCLAW_VERSION)!;
const OLDEST = parseBareVersion(OLDEST_VERSION)!;

function classify(
  profile: LookProfile,
  result: ProfileLook,
  programVersion: Version,
  program: string,
  programIdentity: string | null,
  identify: Identify,
): LookReport {
  if (result.kind === "cant-run") return { look: { ...empty, outcome: "cant-run" }, found: null };
  if (result.kind === "fail")
    return { look: cantTell(result.reason, programVersion.text), found: null };
  const { status, auth } = result;
  if (!status.configExists)
    return { look: cantTell("not-set-up", programVersion.text), found: null };
  const facts = {
    ...empty,
    profile: profile.name,
    listens: status.bind,
    service: serviceFact(status),
    port: status.port,
  };
  if (status.answered) {
    const version = status.answered;
    // The gateway that answered is the one Connect would go to, or it is not offered: the
    // exact endpoint, one identifiable listener on it, and the service's config the same
    // as the program's. A version alone is not enough.
    const listener = status.listenerPid === null ? null : identify(status.listenerPid);
    if (
      !status.endpointConfirmed ||
      listener?.state !== "alive" ||
      programIdentity === null ||
      (status.daemonConfigPath !== null && status.daemonConfigPath !== status.configPath)
    )
      return { look: cantTell("endpoint", version.text), found: null };
    const look = (outcome: LookOutcome, extra: Partial<SetupLook> = {}): SetupLook => ({
      ...facts,
      outcome,
      version: version.text,
      ...extra,
    });
    if (compareVersions(version, OLDEST) < 0) return { look: look("too-old"), found: null };
    if (auth === null) return { look: cantTell("shape", version.text), found: null };
    if (auth !== "token") return { look: look("not-token", { authMode: auth }), found: null };
    if (compareVersions(version, TESTED) !== 0) return { look: look("untested"), found: null };
    return {
      look: look("running", { access: "new" }),
      found: {
        program,
        programIdentity,
        profile,
        port: status.port,
        url: status.url,
        version: version.text,
        configPath: status.configPath,
        daemonConfigPath: status.daemonConfigPath,
        serviceKey: status.serviceKey,
        listener: { pid: status.listenerPid!, started: listener.identity },
      },
    };
  }
  // Nothing answered. Stopped only when nothing listens and no service claims to run.
  const service = status.service;
  const running = service !== null && service !== "none" && service.state !== "stopped";
  if (!status.listening && !running) {
    return { look: { ...facts, outcome: "stopped", version: programVersion.text }, found: null };
  }
  return { look: cantTell("no-answer", programVersion.text), found: null };
}
