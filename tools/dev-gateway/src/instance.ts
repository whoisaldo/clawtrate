// Development gateway instances: which OpenClaw profile, state folder, run
// folder and ports a dev-gateway command addresses. No other module decides it.
//
//   default instance   `openclaw --dev`, ~/.openclaw-dev, ports 19001 and 19091
//   named instance     `openclaw --profile clawtrate-dev-<name>`,
//                      ~/.openclaw-clawtrate-dev-<name>, ports the tool chooses
//                      from NAMED_PORT_RANGE at start and records
//
// OpenClaw 2026.10.6 maps `--profile <p>` to `$HOME/.openclaw-<p>`
// (`resolveProfileStateDir`) and takes the gateway port from
// OPENCLAW_GATEWAY_PORT, then `gateway.port` in the config. The tool sets both.
//
// This file has no dependencies beyond node:path, so the desktop and web hosts
// validate instance names and endpoints with the same rules.

import { join } from "node:path";

/** Every named instance's OpenClaw profile starts with this. */
export const INSTANCE_PROFILE_PREFIX = "clawtrate-dev-";
/** Lowercase letters, digits and inner hyphens, 1 to 24 characters. */
export const INSTANCE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/;
/** Names that read as another profile even with the prefix. */
const RESERVED_NAMES = new Set(["default", "dev"]);
/** Selects an instance for every dev-gateway command and the preview hosts. */
export const INSTANCE_ENV = "CLAWTRATE_DEV_INSTANCE";

export const DEFAULT_GATEWAY_PORT = 19001;
export const DEFAULT_PROVIDER_PORT = 19091;
export const DEFAULT_GATEWAY_URL = `ws://127.0.0.1:${DEFAULT_GATEWAY_PORT}`;

/**
 * Named instances take their ports from this range, one block of
 * `NAMED_PORT_BLOCK` per instance: the gateway on the first port (OpenClaw
 * reserves the next two for its sandbox and browser helpers) and the scripted
 * model ten above it. The default instance's ports and the web preview's are
 * outside it.
 */
export const NAMED_PORT_RANGE = { first: 19200, last: 19999 } as const;
export const NAMED_PORT_BLOCK = 20;
export const PROVIDER_PORT_OFFSET = 10;
/**
 * An instance whose plugin gives bots browsers of their own (`botBrowsers`)
 * also uses these ports of its block: the scripted pages one above the
 * scripted model, and from the twelfth on, the default browser profile's
 * debugging port followed by one per bot.
 */
export const PAGES_PORT_OFFSET = 1;
export const BROWSER_PORT_OFFSET = 12;
/**
 * An instance started with `--with-images` also uses the last port of its
 * block, from its gateway's, for the stand-in image provider.
 */
export const IMAGES_PORT_OFFSET = NAMED_PORT_BLOCK - 1;
/** Ports a named instance never uses, whatever the range says. */
export const RESERVED_PORTS: ReadonlySet<number> = new Set([
  DEFAULT_GATEWAY_PORT,
  DEFAULT_PROVIDER_PORT,
  5310,
  18789,
]);

export class InstanceNameError extends Error {
  constructor(raw: unknown, why: string) {
    super(
      `refusing instance name ${JSON.stringify(raw)}: ${why}. ` +
        "Use 1 to 24 lowercase letters, digits and inner hyphens.",
    );
    this.name = "InstanceNameError";
  }
}

/** The name, or throws. Called before any path is built from it. */
export function validateInstanceName(raw: unknown): string {
  if (typeof raw !== "string") throw new InstanceNameError(raw, "not a string");
  if (!INSTANCE_NAME_PATTERN.test(raw)) throw new InstanceNameError(raw, "invalid characters");
  if (RESERVED_NAMES.has(raw)) throw new InstanceNameError(raw, "reserved");
  return raw;
}

/**
 * The instance a command addresses: `--instance` or CLAWTRATE_DEV_INSTANCE,
 * otherwise the default instance (null). Both set to different names is an error.
 */
export function selectInstance(flag: string | undefined, env: NodeJS.ProcessEnv): string | null {
  const fromEnv = env[INSTANCE_ENV] === "" ? undefined : env[INSTANCE_ENV];
  if (flag !== undefined && fromEnv !== undefined && flag !== fromEnv) {
    throw new Error(
      `--instance ${JSON.stringify(flag)} and ${INSTANCE_ENV}=${JSON.stringify(fromEnv)} disagree`,
    );
  }
  const raw = flag ?? fromEnv;
  return raw === undefined ? null : validateInstanceName(raw);
}

export function profileFor(name: string | null): string {
  return name === null ? "dev" : `${INSTANCE_PROFILE_PREFIX}${validateInstanceName(name)}`;
}

/** The root options that select the instance's OpenClaw profile. */
export function profileArgs(name: string | null): string[] {
  return name === null ? ["--dev"] : ["--profile", profileFor(name)];
}

export function stateDirFor(name: string | null, home: string): string {
  return join(home, `.openclaw-${profileFor(name)}`);
}

/** Where this checkout keeps an instance's run file, logs and connection file. */
export function runDirFor(name: string | null, toolRunDir: string): string {
  return name === null ? toolRunDir : join(toolRunDir, "instances", validateInstanceName(name));
}

/** The state folder name back to its instance, or undefined when it is not one. */
export function instanceFromStateDirName(entry: string): string | null | undefined {
  if (entry === ".openclaw-dev") return null;
  const prefix = `.openclaw-${INSTANCE_PROFILE_PREFIX}`;
  if (!entry.startsWith(prefix)) return undefined;
  const name = entry.slice(prefix.length);
  try {
    return validateInstanceName(name);
  } catch {
    return undefined;
  }
}

/** A port a named instance may use for its gateway or scripted model. */
export function isNamedInstancePort(port: unknown): port is number {
  return (
    typeof port === "number" &&
    Number.isInteger(port) &&
    port >= NAMED_PORT_RANGE.first &&
    port <= NAMED_PORT_RANGE.last &&
    !RESERVED_PORTS.has(port)
  );
}
