// What the look's programs printed, turned into typed facts in memory
// (docs/design/setup.md §2 rule 6, §19 "Validated arguments"). Every value
// is checked against the shape it must have; anything else is "the wrong
// shape" and the raw text is dropped with the result.

import { MAX_LOOK_OTHER_CHARS, type LookService } from "@clawtrate/core";

/** `openclaw --version`: `OpenClaw 2026.10.6 (fe06181)`. */
const VERSION_LINE = /^OpenClaw (\d{4})\.(\d{1,2})\.(\d{1,3})( \([0-9a-f]{7,12}\))?$/;
/** A gateway's own version, as `gateway status --json` reports it. */
const BARE_VERSION = /^(\d{4})\.(\d{1,2})\.(\d{1,3})$/;

export type Version = { text: string; parts: [number, number, number] };

export function parseVersionLine(stdout: string): Version | null {
  const match = VERSION_LINE.exec(stdout.trim());
  if (!match) return null;
  const parts: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return { text: parts.join("."), parts };
}

export function parseBareVersion(value: unknown): Version | null {
  if (typeof value !== "string") return null;
  const match = BARE_VERSION.exec(value);
  if (!match) return null;
  const parts: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return { text: parts.join("."), parts };
}

export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i += 1) if (a.parts[i] !== b.parts[i]) return a.parts[i]! - b.parts[i]!;
  return 0;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** One JSON value and nothing else, or null. */
function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

/** What `openclaw gateway status --json` says about one profile's gateway. */
export type GatewayStatus = {
  configExists: boolean;
  /** The profile's config file, kept to tell this gateway from another; never shown or opened. */
  configPath: string;
  port: number;
  /** Its configured bind, when the status names `loopback` or `lan`; otherwise not reported. */
  bind: "loopback" | "lan" | null;
  /**
   * The service as the status describes it: a registered LaunchAgent or
   * systemd user unit, `none` when the status says its unit is missing, and
   * null when it doesn't describe one the look understands.
   */
  service:
    { kind: "launchagent" | "systemd"; state: "running" | "stopped" | "other" } | "none" | null;
  /** The service's facts as reported, to tell whether it changed; never shown. */
  serviceKey: string;
  /** Whether something listens on the gateway's port. */
  listening: boolean;
  /** `rpc.ok` with the version the running gateway reported, or null. */
  answered: Version | null;
  /** `rpc.ok` was false. */
  unanswered: boolean;
  /** The one endpoint Connect may use: `ws://127.0.0.1:<port>`. */
  url: string;
  /**
   * Both addresses the status reports, the one it probed and the one its RPC
   * answered on, are exactly `url` (at most one terminal slash), and the
   * port it checked is the gateway's. Anything else (`localhost`, IPv6, TLS,
   * a path, a query, a user, another port) and Clawtrate can't confirm where
   * the gateway answers.
   */
  endpointConfirmed: boolean;
  /** The one process listening on exactly `127.0.0.1:<port>`, or null when none or several. */
  listenerPid: number | null;
  /** The config file the service runs with, when reported. */
  daemonConfigPath: string | null;
  /** Whether the status says its service belongs to this gateway (not `diagnostic-only`). */
  serviceAssociated: boolean;
};

/** A reported address, compared with the endpoint after taking off at most one terminal slash. */
const sameEndpoint = (value: unknown, url: string) =>
  typeof value === "string" && (value === url || value === `${url}/`);

const pid = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 1 ? value : null;

/** The single process listening on exactly `127.0.0.1:<port>`, or null. */
function listenerOf(value: unknown, port: number): number | null {
  if (!Array.isArray(value)) return null;
  const pids = new Set<number | null>();
  for (const entry of value) {
    const listener = record(entry);
    if (listener?.address === `127.0.0.1:${port}`) pids.add(pid(listener.pid));
  }
  const [only] = [...pids];
  return pids.size === 1 && only !== null && only !== undefined ? only : null;
}

/** `gateway status --json`, or null when any fact the look needs has the wrong shape. */
export function parseStatus(stdout: string): GatewayStatus | null {
  const root = record(parseJson(stdout));
  if (!root) return null;
  const config = record(record(root.config)?.cli);
  const gateway = record(root.gateway);
  const service = record(root.service);
  const runtime = record(service?.runtime);
  const port = record(root.port);
  const rpc = record(root.rpc);
  if (!config || typeof config.exists !== "boolean") return null;
  if (typeof config.path !== "string" || config.path.length > 1024) return null;
  const daemon = record(record(root.config)?.daemon);
  const daemonPath = daemon?.path;
  if (
    daemonPath !== undefined &&
    (typeof daemonPath !== "string" || daemonPath.length === 0 || daemonPath.length > 1024)
  )
    return null;
  if (!gateway || !service || !port || !rpc || typeof rpc.ok !== "boolean") return null;
  const number = gateway.port;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1024 || number > 65535)
    return null;
  if (port.status !== "free" && port.status !== "busy") return null;

  const label = typeof service.label === "string" ? service.label : null;
  const kind =
    label === null
      ? null
      : /^launchagent$/i.test(label)
        ? "launchagent"
        : /^systemd( user)?$/i.test(label)
          ? "systemd"
          : null;
  const status = runtime?.status;
  const missing = runtime?.missingUnit === true;
  // A registered service is one launchd or systemd knows of: loaded, or its unit is there.
  const registered = kind !== null && !missing && (service.loaded === true || status === "stopped");
  let described: GatewayStatus["service"] = null;
  if (registered)
    described = {
      kind: kind!,
      state: status === "running" ? "running" : status === "stopped" ? "stopped" : "other",
    };
  else if (kind !== null && missing) described = "none";
  let answered: Version | null = null;
  if (rpc.ok) {
    answered =
      parseBareVersion(rpc.version) ??
      parseBareVersion(record(rpc.server)?.version) ??
      parseBareVersion(gateway.version);
    // An answer must carry its version.
    if (!answered) return null;
  }
  const url = `ws://127.0.0.1:${number}`;
  return {
    configExists: config.exists,
    configPath: config.path,
    port: number,
    // Only these two configured values say where it listens: `auto`, `tailnet` and a custom
    // address can each resolve to loopback, so they are not reported.
    bind: gateway.bindMode === "loopback" ? "loopback" : gateway.bindMode === "lan" ? "lan" : null,
    service: described,
    // What tells this service apart: its label, role, process, state and the unit it names.
    serviceKey: JSON.stringify([
      label,
      typeof service.targetRole === "string" ? service.targetRole : null,
      pid(runtime?.pid),
      service.loaded ?? null,
      status ?? null,
      missing,
      typeof service.unit === "string" ? service.unit : null,
    ]),
    listening: port.status === "busy",
    answered,
    unanswered: !rpc.ok,
    url,
    endpointConfirmed:
      sameEndpoint(gateway.probeUrl, url) && sameEndpoint(rpc.url, url) && port.port === number,
    listenerPid: listenerOf(port.listeners, number),
    daemonConfigPath: daemonPath ?? null,
    serviceAssociated:
      typeof service.targetRole === "string" && service.targetRole !== "diagnostic-only",
  };
}

/**
 * The service as the found card names it: a registered service only when the
 * status associates it with this gateway, "none" when it reports no unit, and
 * null (not reported) otherwise.
 */
export function serviceFact(status: GatewayStatus): LookService | null {
  const service = status.service;
  if (service === null) return null;
  if (service === "none") return "none";
  if (!status.serviceAssociated) return null;
  const stopped = service.state === "stopped";
  if (service.kind === "launchagent") return stopped ? "launchagent-stopped" : "launchagent";
  return stopped ? "systemd-stopped" : "systemd";
}

/** A service label from `extraServices`: shown as text, never used. */
const SERVICE_LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._()@:-]*$/;

/** The labels of `gateway status --json --deep`'s `extraServices`, or null for the wrong shape. */
export function parseExtraServices(stdout: string): string[] | null {
  const root = record(parseJson(stdout));
  if (!root || !Array.isArray(root.extraServices)) return null;
  const labels: string[] = [];
  for (const entry of root.extraServices) {
    const label = record(entry)?.label;
    if (
      typeof label === "string" &&
      label.length <= MAX_LOOK_OTHER_CHARS &&
      SERVICE_LABEL.test(label)
    )
      labels.push(label);
  }
  return labels;
}

export type AuthMode = "token" | "password" | "none" | "trusted-proxy";

/** `openclaw config get gateway.auth.mode --json`: one JSON string. */
export function parseAuthMode(stdout: string): AuthMode | null {
  const value = parseJson(stdout);
  return value === "token" || value === "password" || value === "none" || value === "trusted-proxy"
    ? value
    : null;
}

/** What the host keeps of a setup code it made: in memory, for one connect. */
export type SetupCode = { url: string; bootstrapToken: string; expiresAtMs: number };

/** A bootstrap token as OpenClaw mints them: base64url, 32 to 128 characters. */
const BOOTSTRAP_TOKEN = /^[A-Za-z0-9_-]{32,128}$/;

/**
 * `openclaw qr --json --voice-node --url <url>`: the code, decoded, only when
 * its address is exactly `url`. Nothing else of the output is kept.
 */
export function parseSetupCode(stdout: string, url: string, now: number): SetupCode | null {
  const root = record(parseJson(stdout));
  const encoded = root?.setupCode;
  if (typeof encoded !== "string" || encoded.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(encoded))
    return null;
  let payload: Record<string, unknown> | null;
  try {
    payload = record(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
  } catch {
    return null;
  }
  const token = payload?.bootstrapToken;
  const expires = payload?.expiresAtMs;
  if (payload?.url !== url) return null;
  if (typeof token !== "string" || !BOOTSTRAP_TOKEN.test(token)) return null;
  // A code made on this computer lives ten minutes: anything else is not one of them.
  if (
    typeof expires !== "number" ||
    !Number.isSafeInteger(expires) ||
    expires <= now ||
    expires > now + 600_000
  )
    return null;
  return { url, bootstrapToken: token, expiresAtMs: expires };
}
