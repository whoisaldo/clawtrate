// The sandbox of the look on this computer (docs/development/setup.md).
//
// A run that must be sandboxed (`mustSandbox`) is given a description,
// `sandbox.json`, in a private folder of the account's under a temporary root
// fixed in code, reached without links and outside the account's home. The description selects a development instance, that
// instance's run, and a fixture scenario from a closed set, and nothing else:
// no program, no folder, no port. Every path is computed here from the
// description's own folder; inside the account's home the only one is the
// exact state folder of the named instance, proven to be this run's with the
// dev-gateway tool's own marker, this checkout's run record and the gateway
// process's identity, before anything in it is used.
//
// The look's programs are answered by the stand-in in this file, chosen here
// in host code: version and auth mode from fixtures, the gateway's status
// from the proven run's records. It starts no program of OpenClaw's, loads no
// OpenClaw config and opens no socket. Only the `pairing` scenario opens one:
// the host's own synthetic gateway on loopback (`synthetic-gateway.ts`),
// whose one-time codes come from the stand-in's fixture mint.

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, sep } from "node:path";
import { TESTED_OPENCLAW_VERSION } from "@clawtrate/core";
import {
  INSTANCE_PROFILE_PREFIX,
  isNamedInstancePort,
  NAMED_PORT_BLOCK,
  NAMED_PORT_RANGE,
  runDirFor,
  stateDirFor,
  validateInstanceName,
} from "../../../../tools/dev-gateway/src/instance.ts";
import {
  MARKER_FILE,
  markerProblems,
  processIdentity,
  processState,
  runMatches,
  type Identify,
  type Marker,
  type RunRecord,
} from "../../../../tools/dev-gateway/src/state-guard.ts";
import { isLookCommand, type ProgramResult, type RunProgram } from "./programs.ts";
import type { SyntheticGateway } from "./synthetic-gateway.ts";
import { mustSandbox, SetupRefusedError, type LookWorld } from "./world.ts";

/** The description's name in its run folder. */
export const SANDBOX_FILE = "sandbox.json";

/**
 * What a sandbox's stand-in answers. `recorded`: the instance as its run
 * recorded it. `untested-version`: the same, with a version this build isn't
 * tested with. `not-found` and `program-missing`: no program, without and
 * with signs of an installation. `pairing`: the host's synthetic gateway,
 * which Connect pairs with through the fixture mint.
 */
export const SCENARIOS = [
  "recorded",
  "untested-version",
  "not-found",
  "program-missing",
  "pairing",
] as const;
export type Scenario = (typeof SCENARIOS)[number];

/** The version the `untested-version` scenario reports. */
export const UNTESTED_VERSION = "2026.9.37";

/** The program a sandboxed look "runs": the stand-in in this file, never a file on disk. */
export const STAND_IN_PROGRAM = "/clawtrate-stand-in/openclaw";

/** Development instances a sandbox may never name: other work's own. */
const FORBIDDEN_INSTANCES = new Set(["preview-accounts"]);
const RUN_ID = /^[0-9a-f]{48}$/;
const MAX_DESCRIPTION_BYTES = 1024;
const MAX_RECORD_BYTES = 64 * 1024;

export type SandboxDescription = { instance: string; run: string; scenario: Scenario };

/** A description that passed, and the folders computed from its place. */
export type ValidatedSandbox = {
  description: SandboxDescription;
  /** The launch's private folder, which holds the description. */
  root: string;
  file: string;
  /** The look's home and working folder, and the web host's data folder. */
  home: string;
  cwd: string;
  appData: string;
};

type Entry = {
  isDirectory(): boolean;
  isFile(): boolean;
  uid: number;
  mode: number;
  nlink: number;
};

/** The only file system calls the boundary makes, so a test can count them. */
export type SandboxFiles = {
  /** An entry's metadata, never following a link; null when it isn't there. */
  lstat(path: string): Entry | null;
  realpath(path: string): string | null;
  /**
   * A small regular file's text, opened without following a link and checked
   * on the same descriptor: one link, this account's, within `maxBytes`.
   * Null otherwise.
   */
  read(path: string, maxBytes: number, uid: number | null): string | null;
};

export const nodeFiles: SandboxFiles = {
  lstat(path) {
    try {
      return lstatSync(path);
    } catch (error) {
      // Only "not there" is an answer; any other failure is not, and refuses.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
  realpath(path) {
    try {
      return realpathSync(path);
    } catch {
      return null;
    }
  },
  read(path, maxBytes, uid) {
    let fd: number;
    try {
      // Never through a link, and never waiting on something that isn't a regular file.
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
      return null;
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) return null;
      if (uid !== null && stat.uid !== uid) return null;
      const buffer = Buffer.alloc(Math.max(1, stat.size));
      const length = readSync(fd, buffer, 0, buffer.length, 0);
      return buffer.subarray(0, length).toString("utf8");
    } catch {
      return null;
    } finally {
      closeSync(fd);
    }
  },
};

/** A temporary root of the system's, by the names it goes by and its own canonical path. */
type TempRoot = { canonical: string; names: string[] };

/**
 * The system's temporary roots, whatever TMPDIR says: TMPDIR only chooses a
 * place inside one of them.
 */
export function systemTempRoots(platform: NodeJS.Platform): TempRoot[] {
  if (platform === "darwin")
    return [
      { canonical: "/private/tmp", names: ["/tmp", "/private/tmp"] },
      { canonical: "/private/var/folders", names: ["/var/folders", "/private/var/folders"] },
    ];
  if (platform === "linux")
    return [
      { canonical: "/tmp", names: ["/tmp"] },
      { canonical: "/var/tmp", names: ["/var/tmp"] },
    ];
  return [];
}

export type SandboxContext = {
  platform: NodeJS.Platform;
  /** The account's home, from the account (`accountHome`); null refuses. */
  home: string | null;
  /** This process's user, whose folders and files the run's must be. */
  uid: number | null;
  files?: SandboxFiles;
  roots?: TempRoot[];
};

const within = (inner: string, outer: string) =>
  inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : outer + sep);

/** A folder of this account's that only it can enter, not a link (its `lstat`). */
const privateFolder = (entry: Entry | null, uid: number | null) =>
  entry !== null &&
  entry.isDirectory() &&
  (uid === null || (entry.uid === uid && (entry.mode & 0o077) === 0));

/**
 * The description at `path`, checked before anything in it is used: the
 * path absolute and normal, named `sandbox.json`, in a folder that is a real,
 * private folder of this account's below one of the system's temporary
 * roots, with no link on the way down from that root, outside the account's
 * home; the file a small regular file of this account's with one link, read
 * without following a link; its value exactly an instance, its run and a
 * scenario. Its `home` and `work` folders must be real private folders too.
 */
export function validateSandbox(path: string, context: SandboxContext): ValidatedSandbox {
  const files = context.files ?? nodeFiles;
  const home = context.home;
  if (home === null) throw new SetupRefusedError("home");
  if (!isAbsolute(path) || normalize(path) !== path || basename(path) !== SANDBOX_FILE)
    throw new SetupRefusedError("file");
  const root = dirname(path);
  const roots = context.roots ?? systemTempRoots(context.platform);
  // The folder's own path from the temporary root down, which must be its
  // canonical path: no link anywhere below the root, no "." or "..".
  let canonical: string | null = null;
  for (const temp of roots) {
    const name = temp.names.find((candidate) => root.startsWith(candidate + sep));
    if (name === undefined) continue;
    if (files.realpath(temp.canonical) === temp.canonical)
      canonical = temp.canonical + root.slice(name.length);
    break;
  }
  if (canonical === null || files.realpath(root) !== canonical) throw new SetupRefusedError("file");
  const realHome = files.realpath(home) ?? home;
  if (within(canonical, realHome) || within(realHome, canonical) || within(canonical, home))
    throw new SetupRefusedError("home");
  if (!privateFolder(files.lstat(canonical), context.uid)) throw new SetupRefusedError("file");
  const folders = {
    home: join(canonical, "home"),
    cwd: join(canonical, "work"),
    appData: join(canonical, "app-data"),
  };
  for (const folder of Object.values(folders)) {
    if (!privateFolder(files.lstat(folder), context.uid)) throw new SetupRefusedError("file");
  }
  const text = files.read(join(canonical, SANDBOX_FILE), MAX_DESCRIPTION_BYTES, context.uid);
  if (text === null) throw new SetupRefusedError("file");
  return {
    description: parseDescription(text),
    root: canonical,
    file: join(canonical, SANDBOX_FILE),
    ...folders,
  };
}

/** Exactly `{ instance, run, scenario? }`, each of its shape; anything else refuses. */
export function parseDescription(text: string): SandboxDescription {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SetupRefusedError("file");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new SetupRefusedError("file");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => !["instance", "run", "scenario"].includes(key)))
    throw new SetupRefusedError("file");
  let instance: string;
  try {
    instance = validateInstanceName(record.instance);
  } catch {
    throw new SetupRefusedError("file");
  }
  if (FORBIDDEN_INSTANCES.has(instance)) throw new SetupRefusedError("file");
  if (typeof record.run !== "string" || !RUN_ID.test(record.run))
    throw new SetupRefusedError("file");
  // Left out means recorded; anything given, an explicit null too, must be one of the five.
  const scenario = Object.hasOwn(record, "scenario") ? record.scenario : "recorded";
  if (!SCENARIOS.includes(scenario as Scenario)) throw new SetupRefusedError("file");
  return { instance, run: record.run, scenario: scenario as Scenario };
}

/** What the proven run says of its gateway. */
export type RunProof = {
  profile: string;
  stateDir: string;
  configPath: string;
  configExists: boolean;
  port: number;
  /** The gateway process the run recorded, by PID and start time: alive, or proven gone. */
  running: boolean;
  gatewayPid: number | null;
};

export type ProofContext = {
  /** The account's home; null refuses. */
  home: string | null;
  uid: number | null;
  /** The launcher's checkout, as a real path: whose run records prove the run. */
  checkout: string | null;
  identify?: Identify;
  files?: SandboxFiles;
};

/** A JSON object from a small file read without following a link, or null. */
function readRecord(files: SandboxFiles, path: string, uid: number | null) {
  const text = files.read(path, MAX_RECORD_BYTES, uid);
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const runRecordOf = (value: Record<string, unknown> | null): RunRecord | null =>
  value &&
  typeof value.runId === "string" &&
  (value.instance === null || typeof value.instance === "string") &&
  typeof value.checkout === "string" &&
  typeof value.gatewayPort === "number" &&
  typeof value.providerPort === "number" &&
  typeof value.startedAt === "string"
    ? (value as RunRecord)
    : null;

/** A gateway port a named instance is given: in the range, not reserved, the first of its block. */
export const blockPort = (port: unknown): port is number =>
  isNamedInstancePort(port) && (port - NAMED_PORT_RANGE.first) % NAMED_PORT_BLOCK === 0;

/**
 * Proves the description's run is this checkout's: the instance's exact
 * state folder in the account's home, a real folder of this account's,
 * neither it nor the home reached through a link; the tool's marker in it,
 * read without following a link, trusted by the tool's own rules, naming
 * this instance and this run; this checkout's run record agreeing on run,
 * instance, checkout and port; the port at the start of an instance's block;
 * and the gateway the marker recorded alive with its recorded start time, or
 * proven gone (stopped). A config file, when there, is a regular file with
 * one link. Anything else refuses, and nothing past a failed step is read.
 */
export function proveRun(description: SandboxDescription, context: ProofContext): RunProof {
  try {
    return proveRunOrThrow(description, context);
  } catch (error) {
    // A check that couldn't be made refuses in the same fixed words as one that failed.
    throw error instanceof SetupRefusedError ? error : new SetupRefusedError("state");
  }
}

function proveRunOrThrow(description: SandboxDescription, context: ProofContext): RunProof {
  const files = context.files ?? nodeFiles;
  const { home, checkout } = context;
  if (home === null || checkout === null) throw new SetupRefusedError("state");
  const instance = description.instance;
  const realHome = files.realpath(home);
  if (realHome === null || realHome !== normalize(home)) throw new SetupRefusedError("state");
  const stateDir = stateDirFor(instance, realHome);
  if (basename(stateDir) === ".openclaw") throw new SetupRefusedError("state");
  // The home is canonical and the folder itself, read without following it, is a folder.
  const entry = files.lstat(stateDir);
  if (!entry || !entry.isDirectory() || (context.uid !== null && entry.uid !== context.uid))
    throw new SetupRefusedError("state");
  const marker = readRecord(files, join(stateDir, MARKER_FILE), context.uid) as Marker | null;
  if (
    marker?.createdBy !== "clawtrate tools/dev-gateway" ||
    markerProblems(marker, instance).length > 0 ||
    marker.runId !== description.run ||
    marker.checkout !== checkout ||
    marker.gatewayPending === true ||
    !blockPort(marker.gatewayPort)
  )
    throw new SetupRefusedError("state");
  // This checkout's run record, reached through real folders only. `pnpm dev-gateway stop`
  // removes it once every process is proven gone and keeps the marker, so a record that
  // isn't there means stopped, and only a gateway proven gone passes then. A record that is
  // there but can't be read, or is of another shape, refuses.
  const runFile = join(runDirFor(instance, join(checkout, "tools/dev-gateway/.run")), "state.json");
  let parent = checkout;
  let parentExists = true;
  for (const part of ["tools", "dev-gateway", ".run", "instances", instance]) {
    parent = join(parent, part);
    const folder = files.lstat(parent);
    if (folder === null) {
      parentExists = false;
      break;
    }
    if (!folder.isDirectory()) throw new SetupRefusedError("state");
  }
  const runEntry = parentExists ? files.lstat(runFile) : null;
  if (runEntry && (!runEntry.isFile() || runEntry.nlink !== 1))
    throw new SetupRefusedError("state");
  const run = runEntry ? runRecordOf(readRecord(files, runFile, context.uid)) : null;
  if (
    runEntry &&
    (!run ||
      !runMatches(run, marker, instance, checkout) ||
      run.gatewayPort !== marker.gatewayPort ||
      run.providerPort !== marker.providerPort)
  )
    throw new SetupRefusedError("state");
  // The gateway, by PID and start time, before anything else in the folder is looked at.
  const gateway = processState(
    marker.gatewayPid,
    marker.gatewayIdentity,
    context.identify ?? processIdentity,
  );
  if (gateway === "none" || gateway === "unknown" || (!runEntry && gateway !== "dead"))
    throw new SetupRefusedError("state");
  const config = join(stateDir, "openclaw.json");
  const configEntry = files.lstat(config);
  if (configEntry && (!configEntry.isFile() || configEntry.nlink !== 1))
    throw new SetupRefusedError("state");
  return {
    profile: `${INSTANCE_PROFILE_PREFIX}${instance}`,
    stateDir,
    configPath: config,
    configExists: configEntry !== null,
    port: marker.gatewayPort,
    running: gateway === "alive",
    gatewayPid: typeof marker.gatewayPid === "number" ? marker.gatewayPid : null,
  };
}

const answer = (stdout: string, exitCode = 0): ProgramResult => ({
  exitCode,
  stdout,
  timedOut: false,
  tooLarge: false,
  failed: false,
});
const refusal = (): ProgramResult => answer("", 2);

/** A status shaped as `openclaw gateway status --json` prints it, from the stand-in's facts. */
function statusJson(options: {
  platform: NodeJS.Platform;
  configPath: string;
  configExists: boolean;
  port: number;
  running: boolean;
  /** The process listening on the port while it runs. */
  listener: number | null;
  version: string;
}): string {
  const url = `ws://127.0.0.1:${options.port}`;
  return JSON.stringify({
    service: {
      label: options.platform === "linux" ? "systemd" : "LaunchAgent",
      loaded: false,
      runtime: { status: "unknown", missingUnit: true },
    },
    config: { cli: { path: options.configPath, exists: options.configExists } },
    gateway: { bindMode: "loopback", port: options.port, probeUrl: url },
    port: {
      port: options.port,
      status: options.running ? "busy" : "free",
      listeners:
        options.running && options.listener !== null
          ? [{ pid: options.listener, address: `127.0.0.1:${options.port}` }]
          : [],
    },
    rpc: options.running ? { ok: true, version: options.version, url } : { ok: false, url },
  });
}

export type StandInOptions = {
  sandbox: ValidatedSandbox;
  platform: NodeJS.Platform;
  /** The run, proven again for every status the look asks. */
  prove: () => RunProof;
  /** The pairing scenario's gateway, started on its first use. */
  gateway: () => Promise<SyntheticGateway>;
  /** Throws the refusal once the description no longer is the one this run validated. */
  assertActive?: () => void;
  /** The host's log: fixed lines only. */
  log?: (line: string) => void;
  now?: () => number;
};

/**
 * The stand-in for `openclaw` in a sandbox: an answer in this process for
 * each of the look's exact commands, for this instance's profile alone. It
 * refuses the deep status and every other command, starts nothing and,
 * outside the pairing scenario, opens nothing.
 */
export function standIn(options: StandInOptions): RunProgram {
  const { description } = options.sandbox;
  const profile = `${INSTANCE_PROFILE_PREFIX}${description.instance}`;
  const version =
    description.scenario === "untested-version" ? UNTESTED_VERSION : TESTED_OPENCLAW_VERSION;
  const now = options.now ?? Date.now;
  const active = options.assertActive ?? (() => {});
  return async (request) => {
    // A description gone or changed refuses, in fixed words, before any answer.
    active();
    const args = request.args;
    if (
      request.program !== STAND_IN_PROGRAM ||
      args[0] !== "--profile" ||
      args[1] !== profile ||
      !isLookCommand(args)
    )
      return refusal();
    const command = args.slice(2).join(" ");
    if (command === "--version") return answer(`OpenClaw ${version}\n`);
    if (command === "config get gateway.auth.mode --json") return answer('"token"\n');
    if (command === "gateway status --json") {
      // A run that stops proving refuses, in fixed words: never a quiet failed answer.
      const proof = options.prove();
      if (description.scenario === "pairing") {
        const gateway = await options.gateway();
        active();
        // The synthetic gateway listens in this process, while its own socket says so.
        if (!gateway.ownsListener(gateway.port)) return refusal();
        return answer(
          statusJson({
            ...proof,
            platform: options.platform,
            port: gateway.port,
            running: true,
            listener: process.pid,
            version,
          }),
        );
      }
      return answer(
        statusJson({ ...proof, platform: options.platform, listener: proof.gatewayPid, version }),
      );
    }
    if (description.scenario === "pairing" && args[2] === "qr" && args.length === 7) {
      const gateway = await options.gateway();
      active();
      if (args[6] !== gateway.url || !gateway.ownsListener(gateway.port)) return refusal();
      const code = gateway.mint(now());
      options.log?.("[setup] The stand-in made a one-time code for the synthetic gateway.");
      return answer(
        JSON.stringify({ setupCode: Buffer.from(JSON.stringify(code)).toString("base64url") }),
      );
    }
    return refusal();
  };
}

/** A sandbox's world: its own home and working folder, the stand-in, its instance's profile. */
export function sandboxWorld(
  sandbox: ValidatedSandbox,
  platform: NodeJS.Platform,
  proof: RunProof,
  gatewayPort: number | null,
): LookWorld {
  const scenario = sandbox.description.scenario;
  return {
    kind: "sandbox",
    platform,
    home: sandbox.home,
    cwd: sandbox.cwd,
    candidates: [],
    installed: {
      program: scenario === "not-found" || scenario === "program-missing" ? null : STAND_IN_PROGRAM,
      signs: scenario !== "not-found",
    },
    profiles: [
      {
        name: proof.profile,
        args: ["--profile", proof.profile],
        stateDir: proof.stateDir,
        required: true,
        env: {},
      },
    ],
    env: {},
    serviceFiles: [],
    deep: false,
    portAllowed: (port) => gatewayPort !== null && port === gatewayPort,
    pairs: scenario === "pairing",
  };
}

/**
 * What the look and Connect run against, and how they identify a listening
 * process. A sandbox also says, at every step, whether its description still
 * is the one the run validated (`assertActive` throws the refusal) and, for
 * the pairing scenario, whether its synthetic gateway still owns the listener.
 */
export type Opened = {
  world: LookWorld;
  run: RunProgram;
  identify: Identify;
  assertActive?: () => void;
  ownsListener?: (port: number) => boolean;
};

/**
 * Opens a validated sandbox for one look or one Connect: the description
 * checked again where it lies, the run proven again, and the stand-in.
 */
export function sandboxOpener(options: {
  file: string;
  /** The description as the launch validated it at startup: what every later check compares to. */
  sandbox?: ValidatedSandbox;
  platform: NodeJS.Platform;
  context: SandboxContext & ProofContext;
  startGateway: () => Promise<SyntheticGateway>;
  log?: (line: string) => void;
}): { open: () => Promise<Opened | SetupRefusedError>; close: () => Promise<void> } {
  let gateway: Promise<SyntheticGateway> | null = null;
  // Shared while it starts and once it listens; a start that failed is tried again next time.
  const pairingGateway = () => {
    if (gateway) return gateway;
    const starting = options.startGateway();
    gateway = starting;
    starting.catch(() => {
      if (gateway === starting) gateway = null;
    });
    return starting;
  };
  let baseline: ValidatedSandbox | null = options.sandbox ?? null;
  // Once the description is seen gone or changed, this run refuses from then on, whatever
  // is put at that path later.
  let invalid: SetupRefusedError | null = null;
  const assertActive = () => {
    if (invalid) throw invalid;
    try {
      const current = validateSandbox(options.file, options.context);
      if (baseline === null) baseline = current;
      const a = baseline.description;
      const b = current.description;
      if (a.instance !== b.instance || a.run !== b.run || a.scenario !== b.scenario)
        throw new SetupRefusedError("file");
    } catch (error) {
      invalid = error instanceof SetupRefusedError ? error : new SetupRefusedError("file");
      throw invalid;
    }
  };
  const open = async (): Promise<Opened | SetupRefusedError> => {
    try {
      assertActive();
      const sandbox = baseline!;
      const prove = () => proveRun(sandbox.description, options.context);
      const proof = prove();
      const pairing = sandbox.description.scenario === "pairing";
      const server = pairing ? await pairingGateway() : null;
      assertActive();
      return {
        world: sandboxWorld(sandbox, options.platform, proof, server?.port ?? null),
        identify: options.context.identify ?? processIdentity,
        assertActive,
        ...(server ? { ownsListener: (port: number) => server.ownsListener(port) } : {}),
        run: standIn({
          sandbox,
          platform: options.platform,
          prove,
          gateway: pairingGateway,
          assertActive,
          ...(options.log ? { log: options.log } : {}),
        }),
      };
    } catch (error) {
      return error instanceof SetupRefusedError ? error : new SetupRefusedError("file");
    }
  };
  const close = async () => {
    const started = gateway;
    gateway = null;
    // A start that failed left nothing to close.
    const server = await started?.catch(() => null);
    if (server) await server.close();
  };
  return { open, close };
}

/**
 * How this launch sets up on this computer, resolved before anything else
 * starts: a packaged app nothing automates looks at the real computer; a run
 * that must be sandboxed looks only in the description it names, checked
 * here, or nowhere; on Windows the look starts nothing at all. The
 * description is named by `--clawtrate-setup-sandbox=<file>`, or when that
 * switch has no value, by CLAWTRATE_SETUP_SANDBOX.
 */
export type SetupLaunch =
  | { kind: "production" }
  | { kind: "windows" }
  | { kind: "sandbox"; file: string; sandbox: ValidatedSandbox }
  | { kind: "refused"; error: SetupRefusedError };

export function resolveSetupLaunch(options: {
  packaged: boolean;
  env: NodeJS.ProcessEnv;
  switches: (name: string) => boolean;
  switchValue: (name: string) => string;
  context: SandboxContext;
}): SetupLaunch {
  if (!mustSandbox(options)) return { kind: "production" };
  if (options.context.platform === "win32") return { kind: "windows" };
  const file =
    options.switchValue("clawtrate-setup-sandbox") || options.env.CLAWTRATE_SETUP_SANDBOX || "";
  if (file === "") return { kind: "refused", error: new SetupRefusedError("missing") };
  try {
    return { kind: "sandbox", file, sandbox: validateSandbox(file, options.context) };
  } catch (error) {
    return {
      kind: "refused",
      error: error instanceof SetupRefusedError ? error : new SetupRefusedError("file"),
    };
  }
}
