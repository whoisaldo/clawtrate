// The LOOK script, run on the other computer as `/bin/sh -s` with the script on
// standard input (docs/design/setup.md, section 19), and the parser for what it
// prints. The script is a constant; its one value is the run's request id,
// which the host makes and validates. It clears every OPENCLAW_ variable the
// login left, so no inherited profile, state, config or port changes what the
// two profiles name, looks only in fixed places, and prints one JSON line per
// fact between a begin and an end line carrying that id, so anything a login
// start-up file printed before it is told apart and dropped. The program it
// found is named with its checksum, so a later script runs that same file or
// nothing. Every program output travels as base64 and is checked here, in
// memory, before any fact is returned; nothing raw is kept.

import { randomUUID } from "node:crypto";

import { OLDEST_OPENCLAW_VERSION } from "@clawtrate/core";

/** The fixed places, in order; the facts name a place by its index. */
export const PROGRAM_PLACES = [
  "~/.openclaw/bin/openclaw",
  "/opt/homebrew/bin/openclaw",
  "/usr/local/bin/openclaw",
  "~/.local/bin/openclaw",
  "~/.npm-global/bin/openclaw",
] as const;

export type ProgramPlace = (typeof PROGRAM_PLACES)[number];

/**
 * Clears every OPENCLAW_ variable the login set, or stops: an inherited
 * profile, state folder, config path or port would change what the two
 * profiles name. A variable that can't be cleared ends the script.
 */
export const CLEAR_OPENCLAW = String.raw`for v in $(env | sed -n 's/^\(OPENCLAW_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v" || exit 65; done`;

/** The script's body. Edit with care: a test runs it under several shells and a hostile login. */
export const LOOK_SCRIPT_BODY = String.raw`set -eu
case "$request_id" in
  *[!0-9a-f-]*|'') exit 64 ;;
esac
${CLEAR_OPENCLAW}
# Stop after 30 seconds, whatever is still running.
( sleep 30 </dev/null >/dev/null 2>&1 & s=$!
  trap 'kill "$s" 2>/dev/null; exit 0' TERM
  wait "$s" && kill -TERM 0 2>/dev/null ) </dev/null >/dev/null 2>&1 &
watchdog=$!
cd "$HOME" 2>/dev/null || cd /
b64() { head -c "$1" | base64 | tr -d '\r\n'; }
line() { printf '{"k":"%s"%s}\n' "$1" "$2"; }
line begin ",\"id\":\"$request_id\""
line uname ",\"s\":\"$(uname -s </dev/null 2>/dev/null | b64 256 || true)\",\"m\":\"$(uname -m </dev/null 2>/dev/null | b64 256 || true)\",\"n\":\"$(uname -n </dev/null 2>/dev/null | b64 256 || true)\""
prog=''
i=0
for p in "$HOME/.openclaw/bin/openclaw" /opt/homebrew/bin/openclaw /usr/local/bin/openclaw "$HOME/.local/bin/openclaw" "$HOME/.npm-global/bin/openclaw"; do
  if [ -z "$prog" ] && [ -f "$p" ] && [ -x "$p" ]; then prog=$p; line program ",\"i\":$i,\"c\":\"$(cksum < "$p" 2>/dev/null | b64 64 || true)\""; fi
  i=$((i + 1))
done
exec 4>&1
# A program's output is cut to 32 KiB as it is produced, and sent straight out as base64; its
# exit status comes back on fd 3. Nothing of it is held in a variable.
run() {
  key=$1; shift
  printf '{"k":"%s","v":"' "$key"
  code=$( { { "$prog" "$@" </dev/null 2>/dev/null && c=0 || c=$?; printf '%s' "$c" >&3; } | b64 32768 >&4; } 3>&1 )
  case "$code" in ''|*[!0-9]*) code=255 ;; esac
  printf '","exit":%s}\n' "$code"
}
if [ -n "$prog" ]; then
  run version --version
  run status-default gateway status --json
  if [ -d "$HOME/.openclaw-clawtrate" ]; then
    run status-clawtrate --profile clawtrate gateway status --json
  fi
fi
has() { if [ -e "$1" ]; then printf 1; else printf 0; fi; }
line signs ",\"state\":$(has "$HOME/.openclaw"),\"launchd\":$(has "$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist"),\"systemd\":$(has "$HOME/.config/systemd/user/openclaw-gateway.service"),\"cstate\":$(has "$HOME/.openclaw-clawtrate"),\"claunchd\":$(has "$HOME/Library/LaunchAgents/ai.openclaw.clawtrate.plist"),\"csystemd\":$(has "$HOME/.config/systemd/user/openclaw-gateway-clawtrate.service")"
kill -TERM "$watchdog" 2>/dev/null || true
line end ",\"id\":\"$request_id\""
`;

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The script as sent: the one assignment the host writes, then the constant body. */
export function lookScript(requestId: string = randomUUID()): { requestId: string; text: string } {
  if (!REQUEST_ID.test(requestId)) throw new Error("Not a request id.");
  return { requestId, text: `request_id='${requestId}'\n${LOOK_SCRIPT_BODY}` };
}

export type Version = { year: number; month: number; day: number; build: string | null };

export type ServiceLabel = "LaunchAgent" | "systemd user" | "systemd" | "Scheduled Task" | "other";

export type GatewayStatus = {
  profile: "default" | "clawtrate";
  exit: number;
  /** What the status said of the gateway's port: "free" or "busy", or null when it didn't say. */
  portStatus: "free" | "busy" | null;
  /** The address its RPC probe answered on, as reported. */
  rpcUrl: string | null;
  service: {
    label: ServiceLabel;
    loaded: boolean | null;
    running: boolean | null;
    pid: number | null;
  } | null;
  configPath: string | null;
  port: number | null;
  bindMode: "loopback" | "lan" | "tailnet" | "auto" | "custom" | null;
  version: Version | null;
  rpcOk: boolean | null;
  /** The processes OpenClaw saw listening on the gateway's port; null when the list was missing or unreadable. */
  listenerPids: number[] | null;
};

export type LookFacts = {
  system: { os: string; machine: string; nodeName: string } | null;
  program: ProgramPlace | null;
  /** The program file's `cksum` ("<crc> <size>"), so a later script runs this same file or nothing. */
  programSum: string | null;
  /** From `openclaw --version`; null when no program, "unreadable" when it answered something else. */
  version: Version | "unreadable" | null;
  gateways: Array<
    GatewayStatus | { profile: "default" | "clawtrate"; exit: number; unreadable: true }
  >;
  signs: {
    defaultState: boolean;
    defaultService: boolean;
    clawtrateState: boolean;
    clawtrateService: boolean;
  };
};

export type LookParse =
  | { ok: true; facts: LookFacts; noiseLines: number }
  | { ok: false; reason: "no-begin" | "no-end" | "malformed" | "too-large" | "incomplete" };

/** What the script keeps of one program's answer (`b64 32768`), and of each `uname` value (`b64 256`). */
const MAX_PROGRAM_BYTES = 32 * 1024;
const MAX_UNAME_BYTES = 256;
const MAX_DECODED = MAX_PROGRAM_BYTES;
const base64Chars = (bytes: number) => Math.ceil(bytes / 3) * 4;
/** One line the script prints, at its largest: its fixed characters, its values and its line break. */
const lineChars = (fixed: string, values: number) => fixed.length + values + 1;

/**
 * The largest whole LOOK the script can print, line by line. 32 KiB is 43,692
 * characters of base64 and 256 bytes are 344, so: begin 58 + uname 1,067 +
 * program 22 + three program records (version and both profiles' statuses,
 * each counted with the longest key and a three-digit exit) of 43,735 + signs
 * 85 + end 56 = 132,493 characters.
 */
const MAX_LOOK_FACTS =
  lineChars('{"k":"begin","id":""}', 36) +
  lineChars('{"k":"uname","s":"","m":"","n":""}', 3 * base64Chars(MAX_UNAME_BYTES)) +
  lineChars('{"k":"program","i":4}', 0) +
  3 * lineChars('{"k":"status-clawtrate","v":"","exit":255}', base64Chars(MAX_PROGRAM_BYTES)) +
  lineChars(
    '{"k":"signs","state":1,"launchd":1,"systemd":1,"cstate":1,"claunchd":1,"csystemd":1}',
    0,
  ) +
  lineChars('{"k":"end","id":""}', 36);

/** What login start-up files may print before the begin line: a bound of its own. */
export const MAX_LOOK_NOISE = 16 * 1024;

/** The most the host reads of a LOOK: the largest whole LOOK and the noise allowance, 148,877. */
export const MAX_LOOK_OUTPUT = MAX_LOOK_FACTS + MAX_LOOK_NOISE;

/** What `cksum` prints for standard input: the CRC and the size, in decimal. */
export const PROGRAM_SUM = /^[0-9]{1,10} [0-9]{1,20}$/;
const VERSION = /^OpenClaw (\d{4})\.(\d{1,2})\.(\d{1,3})( \(([0-9a-f]{7,12})\))?$/;
const GATEWAY_VERSION = /^(\d{4})\.(\d{1,2})\.(\d{1,3})$/;
const SYSTEM_WORD = /^[A-Za-z0-9_.-]{1,64}$/;
const NODE_NAME = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const CONFIG_PATH = /^(?:\/|~\/)[\p{L}\p{N} ._+@/-]{1,1024}$/u;

function decode(value: unknown): string | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const text = Buffer.from(value, "base64").toString("utf8");
  return text.length > MAX_DECODED ? null : text;
}

export function parseVersion(text: string): Version | null {
  const match = VERSION.exec(text.trim());
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    build: match[5] ?? null,
  };
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const bool = (value: unknown) => (typeof value === "boolean" ? value : null);
const pid = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value < 2 ** 31
    ? value
    : null;

/** The facts the design reads from `gateway status --json`, each checked; the rest is dropped. */
export function parseGatewayStatus(
  profile: "default" | "clawtrate",
  exit: number,
  text: string,
): GatewayStatus | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const top = record(json);
  if (!top) return null;
  const service = record(top.service);
  const runtime = record(service?.runtime);
  const gateway = record(top.gateway);
  const daemon = record(record(top.config)?.daemon);
  const rpc = record(top.rpc);
  const portStatus = record(top.port);
  const label = typeof service?.label === "string" ? service.label : null;
  const port = gateway?.port;
  const bind = gateway?.bindMode;
  const version =
    typeof gateway?.version === "string" ? GATEWAY_VERSION.exec(gateway.version) : null;
  const path =
    typeof daemon?.path === "string" && CONFIG_PATH.test(daemon.path) ? daemon.path : null;
  const status = typeof runtime?.status === "string" ? runtime.status : null;
  const listeners: unknown = portStatus?.listeners;
  const listenerPids =
    Array.isArray(listeners) && listeners.length <= 16
      ? listeners.map((listener) => pid(record(listener)?.pid))
      : null;
  const rpcUrl = typeof rpc?.url === "string" && rpc.url.length <= 64 ? rpc.url : null;
  return {
    profile,
    exit,
    portStatus:
      portStatus?.status === "free" ? "free" : portStatus?.status === "busy" ? "busy" : null,
    rpcUrl,
    service: service
      ? {
          label:
            label === "LaunchAgent" ||
            label === "systemd user" ||
            label === "systemd" ||
            label === "Scheduled Task"
              ? label
              : "other",
          loaded: bool(service.loaded),
          running: status === "running" ? true : status === "stopped" ? false : null,
          pid: pid(runtime?.pid),
        }
      : null,
    configPath: path,
    port:
      typeof port === "number" && Number.isInteger(port) && port >= 1024 && port <= 65535
        ? port
        : null,
    bindMode:
      bind === "loopback" ||
      bind === "lan" ||
      bind === "tailnet" ||
      bind === "auto" ||
      bind === "custom"
        ? bind
        : null,
    version: version
      ? {
          year: Number(version[1]),
          month: Number(version[2]),
          day: Number(version[3]),
          build: null,
        }
      : null,
    rpcOk: bool(rpc?.ok),
    listenerPids:
      listenerPids !== null && listenerPids.every((value): value is number => value !== null)
        ? listenerPids
        : null,
  };
}

const flag = (value: unknown) => (value === 0 || value === 1 ? value === 1 : null);

/** The script's standard output, parsed in memory. */
export function parseLookOutput(stdout: string, requestId: string): LookParse {
  if (stdout.length > MAX_LOOK_OUTPUT) return { ok: false, reason: "too-large" };
  const lines = stdout.split("\n").map((line) => line.replace(/\r$/, ""));
  const begin = lines.findIndex((line) => line === `{"k":"begin","id":"${requestId}"}`);
  if (begin === -1) return { ok: false, reason: "no-begin" };
  // What login files printed before the begin line has its own allowance.
  const noise = lines.slice(0, begin).reduce((sum, line) => sum + line.length + 1, 0);
  if (noise > MAX_LOOK_NOISE) return { ok: false, reason: "too-large" };
  const facts: LookFacts = {
    system: null,
    program: null,
    programSum: null,
    version: null,
    gateways: [],
    signs: {
      defaultState: false,
      defaultService: false,
      clawtrateState: false,
      clawtrateService: false,
    },
  };
  const seen = new Set<string>();
  const after = lines.slice(begin + 1);
  // What follows the last line break is not a line: empty, or a line the script was stopped in.
  after.pop();
  for (const line of after) {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      return { ok: false, reason: "malformed" };
    }
    const fact = record(json);
    const key = fact?.k;
    if (!fact || typeof key !== "string" || seen.has(key))
      return { ok: false, reason: "malformed" };
    seen.add(key);
    switch (key) {
      case "end": {
        if (fact.id !== requestId) return { ok: false, reason: "malformed" };
        // Every fact the script always prints, and each the program and the state it found call for.
        const needed = ["uname", "signs"];
        if (facts.program) needed.push("version", "status-default");
        if (facts.signs.clawtrateState && facts.program) needed.push("status-clawtrate");
        if (needed.some((name) => !seen.has(name))) return { ok: false, reason: "incomplete" };
        if (
          !facts.program &&
          ["version", "status-default", "status-clawtrate"].some((n) => seen.has(n))
        ) {
          return { ok: false, reason: "malformed" };
        }
        return { ok: true, facts, noiseLines: begin };
      }
      case "uname": {
        const [os, machine, nodeName] = [decode(fact.s), decode(fact.m), decode(fact.n)].map((v) =>
          v === null ? null : v.trim(),
        );
        facts.system =
          os &&
          machine &&
          nodeName &&
          SYSTEM_WORD.test(os) &&
          SYSTEM_WORD.test(machine) &&
          NODE_NAME.test(nodeName)
            ? { os, machine, nodeName }
            : null;
        break;
      }
      case "program": {
        const place = typeof fact.i === "number" ? PROGRAM_PLACES[fact.i] : undefined;
        if (!place) return { ok: false, reason: "malformed" };
        facts.program = place;
        const sum = decode(fact.c)?.trim() ?? null;
        facts.programSum = sum !== null && PROGRAM_SUM.test(sum) ? sum : null;
        break;
      }
      case "version": {
        const text = decode(fact.v);
        if (text === null || typeof fact.exit !== "number")
          return { ok: false, reason: "malformed" };
        facts.version = (fact.exit === 0 && parseVersion(text)) || "unreadable";
        break;
      }
      case "status-default":
      case "status-clawtrate": {
        const profile = key === "status-default" ? "default" : "clawtrate";
        const text = decode(fact.v);
        const exit = fact.exit;
        if (text === null || typeof exit !== "number" || !Number.isInteger(exit)) {
          return { ok: false, reason: "malformed" };
        }
        facts.gateways.push(
          parseGatewayStatus(profile, exit, text) ?? { profile, exit, unreadable: true },
        );
        break;
      }
      case "signs": {
        const values = ["state", "launchd", "systemd", "cstate", "claunchd", "csystemd"].map(
          (name) => flag(fact[name]),
        );
        if (values.some((value) => value === null)) return { ok: false, reason: "malformed" };
        const [state, launchd, systemd, cstate, claunchd, csystemd] = values as boolean[];
        facts.signs = {
          defaultState: state!,
          defaultService: launchd! || systemd!,
          clawtrateState: cstate!,
          clawtrateService: claunchd! || csystemd!,
        };
        break;
      }
      default:
        return { ok: false, reason: "malformed" };
    }
  }
  return { ok: false, reason: "no-end" };
}

/** What a repeated LOOK must name again for a route to be usable: the same gateway service on that port. */
export type GatewayService = {
  profile: "default" | "clawtrate";
  serviceLabel: ServiceLabel;
  configPath: string;
  port: number;
};

/** A gateway service a LOOK found, running and answering, whose own process is all that listens on its port. */
export type FoundService = { ok: true; service: GatewayService; holdsPort: true };

/**
 * The gateway service a LOOK found on `port`, only from a complete and
 * consistent status: the command succeeded, the service is of a known kind,
 * loaded and running with a known process, `rpc.ok`, and that process is
 * every listener on the port. A service that reports itself stopped is
 * "not-running"; anything less certain is "cant-tell".
 */
/**
 * The one verdict of "stopped", for the found card's Start and the forward's
 * "OpenClaw stopped": the status command succeeded, a loaded service of a
 * known kind reports itself stopped, the port is reported free with no
 * listener, the gateway's RPC failed, and the installed CLI is one setup
 * supports. Anything less, or anything that disagrees, is not proven.
 */
export function provenStopped(status: GatewayStatus, cli: LookFacts["version"]): boolean {
  if (cli === null || cli === "unreadable") return false;
  const [year, month, day] = OLDEST_OPENCLAW_VERSION.split(".").map(Number) as [
    number,
    number,
    number,
  ];
  const supported = cli.year - year || cli.month - month || cli.day - day;
  return (
    status.exit === 0 &&
    status.service !== null &&
    status.service.label !== "other" &&
    status.service.loaded === true &&
    status.service.running === false &&
    status.port !== null &&
    status.configPath !== null &&
    status.portStatus === "free" &&
    status.listenerPids !== null &&
    status.listenerPids.length === 0 &&
    status.rpcOk === false &&
    supported >= 0
  );
}

export function serviceOnPort(
  facts: LookFacts,
  port: number,
  /** The profile whose status is asked; without it, the first status that names the port. */
  profile?: "default" | "clawtrate",
): FoundService | { ok: false; reason: "none" | "not-running" | "cant-tell" | "endpoint" } {
  for (const gateway of facts.gateways) {
    if ("unreadable" in gateway) return { ok: false, reason: "cant-tell" };
    if (profile !== undefined && gateway.profile !== profile) continue;
    if (gateway.port !== port) continue;
    const service = gateway.service;
    if (gateway.exit !== 0 || !service || !gateway.configPath || service.label === "other") {
      return { ok: false, reason: "cant-tell" };
    }
    if (service.running === false) {
      // Stopped only as the found card's Start judges it (`provenStopped`).
      return provenStopped(gateway, facts.version)
        ? { ok: false, reason: "not-running" }
        : { ok: false, reason: "cant-tell" };
    }
    if (
      service.running !== true ||
      service.loaded !== true ||
      gateway.rpcOk !== true ||
      gateway.portStatus !== "busy" ||
      gateway.version === null
    ) {
      return { ok: false, reason: "cant-tell" };
    }
    // The RPC answered at exactly the gateway's loopback endpoint: a tailnet or custom bind is
    // probed elsewhere, and Clawtrate can't establish the loopback endpoint it forwards to.
    if (gateway.rpcUrl !== `ws://127.0.0.1:${port}`) return { ok: false, reason: "endpoint" };
    const pid = service.pid;
    if (
      pid === null ||
      gateway.listenerPids === null ||
      gateway.listenerPids.length === 0 ||
      gateway.listenerPids.some((each) => each !== pid)
    ) {
      return { ok: false, reason: "cant-tell" };
    }
    return {
      ok: true,
      holdsPort: true,
      service: {
        profile: gateway.profile,
        serviceLabel: service.label,
        configPath: gateway.configPath,
        port,
      },
    };
  }
  return { ok: false, reason: "none" };
}

export function sameService(a: GatewayService, b: GatewayService): boolean {
  return (
    a.profile === b.profile &&
    a.serviceLabel === b.serviceLabel &&
    a.configPath === b.configPath &&
    a.port === b.port
  );
}
