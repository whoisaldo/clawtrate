// What the look on this computer may see (docs/design/setup.md §4): the
// home folder, the fixed places of the `openclaw` program, the profiles it
// considers, the environment and working folder its programs get and the
// ports it may use. Production resolves them from the real computer, for a
// packaged app nothing automates. Every run that must be sandboxed
// (`mustSandbox`) looks only in a sandbox the host computes itself
// (`sandbox.ts`), whose answers come from the host's own stand-in: such a run
// never starts a program of OpenClaw's.

import { userInfo } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { SetupRefusal } from "@clawtrate/core";

/** OpenClaw's default gateway port. A sandboxed run never uses it. */
export const OPENCLAW_DEFAULT_PORT = 18789;

/** The system's own program folders, the start of every program's PATH. */
const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

export type LookProfile = {
  /** What the person sees: `default`, `clawtrate`, or a development instance's profile. */
  name: string;
  /** The root options that select it: none for the default profile (rule 11). */
  args: string[];
  /** Its state folder. A profile that isn't `required` is looked at only when this exists. */
  stateDir: string;
  required: boolean;
  /** Set for every program run for this profile, beside the world's environment. */
  env: Record<string, string>;
};

export type LookWorld = {
  kind: "production" | "sandbox";
  platform: NodeJS.Platform;
  home: string;
  /** The working folder of every program the look starts: never the app's own. */
  cwd: string;
  /** Where the program may be, in order; the first regular executable file is used. */
  candidates: string[];
  /**
   * A sandbox's answer to where the program is and whether OpenClaw is set up,
   * from its scenario: no file is checked for them.
   */
  installed?: { program: string | null; signs: boolean };
  profiles: LookProfile[];
  /** The whole environment of every program the look starts, before the profile's own. */
  env: Record<string, string>;
  /** Service files whose presence says OpenClaw is set up here. */
  serviceFiles: string[];
  /** Whether the look may run `gateway status --deep`, which scans the system's service folders. */
  deep: boolean;
  /** A gateway port the host may run commands for and connect to. */
  portAllowed: (port: number) => boolean;
  /** Whether Connect may make a code or reconnect here: a sandbox only in its pairing scenario. */
  pairs: boolean;
};

/** Each refusal's line in the host's log: fixed words, never a path or an error's text. */
const REFUSAL_LINES: Record<SetupRefusal, string> = {
  missing: "this run must look in a sandbox and was given none",
  file: "the sandbox's description is not in a private folder of the account's under the system's temporary root, reached without links, or has the wrong shape",
  home: "the sandbox's home and working folder must be outside the account's home",
  state:
    "the development instance's state folder, its run or its config did not pass the run's checks",
  pairing: "this sandbox's scenario does not pair",
};

export class SetupRefusedError extends Error {
  readonly reason: SetupRefusal;
  constructor(reason: SetupRefusal) {
    super(`The look on this computer refused to start: ${REFUSAL_LINES[reason]}.`);
    this.name = "SetupRefusedError";
    this.reason = reason;
  }
}

function serviceFilesUnder(home: string, platform: NodeJS.Platform): string[] {
  if (platform === "darwin") {
    return ["ai.openclaw.gateway", "ai.openclaw.clawtrate"].map((label) =>
      join(home, "Library/LaunchAgents", `${label}.plist`),
    );
  }
  if (platform === "linux") {
    return ["openclaw-gateway", "openclaw-gateway-clawtrate"].map((unit) =>
      join(home, ".config/systemd/user", `${unit}.service`),
    );
  }
  return [];
}

const validPort = (port: number) => Number.isInteger(port) && port >= 1024 && port <= 65535;

/** The real computer's world, for a packaged app that nothing automates. */
export function productionWorld(options: {
  home: string;
  appData: string;
  platform: NodeJS.Platform;
  lang?: string | undefined;
}): LookWorld {
  const { home, platform } = options;
  return {
    kind: "production",
    platform,
    home,
    cwd: home,
    candidates: [
      join(options.appData, "openclaw/bin/openclaw"),
      join(home, ".openclaw/bin/openclaw"),
      "/opt/homebrew/bin/openclaw",
      "/usr/local/bin/openclaw",
      join(home, ".local/bin/openclaw"),
      join(home, ".npm-global/bin/openclaw"),
    ],
    profiles: [
      { name: "default", args: [], stateDir: join(home, ".openclaw"), required: true, env: {} },
      {
        name: "clawtrate",
        args: ["--profile", "clawtrate"],
        stateDir: join(home, ".openclaw-clawtrate"),
        required: false,
        env: {},
      },
    ],
    env: { HOME: home, LANG: options.lang ?? "en_US.UTF-8", NO_COLOR: "1" },
    serviceFiles: serviceFilesUnder(home, platform),
    deep: true,
    portAllowed: validPort,
    pairs: true,
  };
}

/** The variables that mark a run that must be sandboxed: present at all, an empty value too. */
export const SANDBOX_MARKERS = [
  "CLAWTRATE_E2E_RUN",
  "CLAWTRATE_AUTOMATED",
  "CLAWTRATE_SCREENSHOT",
  "CLAWTRATE_SETUP_SANDBOX",
  "VITEST",
  "CI",
] as const;

/** The switches that mark a driven app. */
export const SANDBOX_SWITCHES = [
  "remote-debugging-port",
  "remote-debugging-pipe",
  "inspect",
  "inspect-brk",
  "clawtrate-setup-sandbox",
] as const;

/**
 * Whether this run must be sandboxed: a development build, any marker
 * variable present at all, any of the switches, or a sandbox file named by
 * the environment. A packaged app started with none of these is a person's
 * and looks at the real computer.
 */
export function mustSandbox(options: {
  packaged: boolean;
  env: NodeJS.ProcessEnv;
  switches: (name: string) => boolean;
}): boolean {
  return (
    !options.packaged ||
    SANDBOX_MARKERS.some((key) => Object.hasOwn(options.env, key)) ||
    SANDBOX_SWITCHES.some((name) => options.switches(name))
  );
}

/**
 * The real home folder, from the account, never from an environment a test
 * may have changed. Null when the account can't be read: the caller refuses.
 */
export function accountHome(lookup: () => { homedir: string } = userInfo): string | null {
  try {
    const home = lookup().homedir;
    return typeof home === "string" && isAbsolute(home) ? home : null;
  } catch {
    return null;
  }
}

/**
 * Refuses a port Connect may not use: anything the world doesn't allow, and
 * in a sandbox never OpenClaw's default.
 */
export function guardPort(port: number, world: LookWorld): void {
  if (!world.portAllowed(port) || (world.kind === "sandbox" && port === OPENCLAW_DEFAULT_PORT))
    throw new SetupRefusedError("state");
}

/** The PATH a program gets: its own folder, then the system's. */
export function programPath(program: string): string {
  return [dirname(program), ...SYSTEM_PATH].join(":");
}
