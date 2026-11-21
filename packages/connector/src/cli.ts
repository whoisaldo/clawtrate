#!/usr/bin/env node
// clawtrate-connector: reach this computer's OpenClaw gateway from a phone through Clawtrate's
// relay, end to end encrypted. See the package README.

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { secureRandomBytes, toBase64Url } from "@clawtrate/relay-protocol";
import { addOffer, checkLabel, readPhones, removePhones } from "./allowlist.ts";
import {
  canonicalOrigin,
  checkGatewayPort,
  CONFIG_FILE,
  dialUrl,
  KEYS_FILE,
  loadConfig,
  loadKeys,
  newKeys,
  parseConfig,
  parseKeys,
  serializeConfig,
  type ConnectorConfig,
} from "./config.ts";
import { ConnectorDaemon, parseStatus, STATUS_FILE, STATUS_STALE_MS } from "./daemon.ts";
import { checkSetupCode, encodeRelayCode, MAX_OFFER_MS } from "./envelope.ts";
import { cliRunner, runJson, type OpenclawRunner } from "./openclaw.ts";
import { renderQr } from "./qr.ts";
import {
  LAUNCH_AGENT_FILE,
  serviceInstructions,
  SYSTEMD_UNIT_FILE,
  writeServiceFiles,
} from "./service.ts";
import { defaultStateDir, StateDir } from "./state.ts";
import {
  enableTrustedProxies,
  openclawProxiesConfig,
  readProxiesRecord,
  restoreTrustedProxies,
} from "./trusted-proxies.ts";

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  readonly env: NodeJS.ProcessEnv;
  now(): number;
  /** Whether stdout is a terminal, for the QR code's colours. */
  readonly isTTY: boolean;
  /** How OpenClaw's command line is run; the default runs the configured binary and profile. */
  openclaw?(config: ConnectorConfig): OpenclawRunner;
  /** `run` waits on this; the default resolves on SIGINT or SIGTERM. */
  untilStopped?(): Promise<void>;
}

const USAGE = `usage: clawtrate-connector <command> [--state-dir <dir>]

  setup --relay <wss://origin> [--gateway-port <port>] [--openclaw-bin <path>]
        [--openclaw-profile <name>] [--service-dir <dir>] [--no-trusted-proxies]
  run                         keep the relay connection up, in the foreground
  status [--json]
  pair-phone [--name <name>] [--json]
  remove-phone <phone key or name>
  teardown                    put gateway.trustedProxies back and remove the service files`;

const DEFAULT_GATEWAY_PORT = 18789;
const SERVICE_DIR = "service";

export async function main(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "setup":
        return await setup(rest, io);
      case "run":
        return await run(rest, io);
      case "status":
        return status(rest, io);
      case "pair-phone":
        return await pairPhone(rest, io);
      case "remove-phone":
        return removePhone(rest, io);
      case "teardown":
        return await teardown(rest, io);
      default:
        io.err(USAGE);
        return 2;
    }
  } catch (error) {
    io.err(`clawtrate-connector ${command}: ${(error as Error).message}`);
    return 1;
  }
}

function stateDirOf(values: { "state-dir"?: string | undefined }, io: CliIo): string {
  return values["state-dir"] ?? defaultStateDir(io.env);
}

function runnerFor(config: ConnectorConfig, io: CliIo): OpenclawRunner {
  return io.openclaw ? io.openclaw(config) : cliRunner(config.openclaw);
}

async function setup(args: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      "state-dir": { type: "string" },
      relay: { type: "string" },
      "gateway-port": { type: "string" },
      "openclaw-bin": { type: "string" },
      "openclaw-profile": { type: "string" },
      "service-dir": { type: "string" },
      "no-trusted-proxies": { type: "boolean", default: false },
    },
  });
  const state = StateDir.create(stateDirOf(values, io), io.env);
  const earlier = state.read(CONFIG_FILE, parseConfig);
  const relay = values.relay ?? earlier?.relayOrigin;
  if (relay === undefined) throw new Error("--relay <wss://origin> is required the first time.");
  const config: ConnectorConfig = parseConfig(
    serializeConfig({
      relayOrigin: canonicalOrigin(relay),
      gatewayPort: checkGatewayPort(
        values["gateway-port"] === undefined
          ? (earlier?.gatewayPort ?? DEFAULT_GATEWAY_PORT)
          : Number(values["gateway-port"]),
      ),
      openclaw: {
        bin: values["openclaw-bin"] ?? earlier?.openclaw.bin ?? "openclaw",
        profile: values["openclaw-profile"] ?? earlier?.openclaw.profile ?? null,
      },
    }),
  );
  state.withLock(() => {
    if (state.read(KEYS_FILE, parseKeys) === null) state.write(KEYS_FILE, newKeys());
    state.write(CONFIG_FILE, serializeConfig(config));
  });
  const keys = loadKeys(state);
  io.out(`State folder: ${state.path}`);
  io.out(`Relay: ${config.relayOrigin}, relay id ${keys.relayId}`);
  io.out(`Gateway: ws://127.0.0.1:${config.gatewayPort}`);

  if (values["no-trusted-proxies"]) {
    io.out("gateway.trustedProxies was not checked (--no-trusted-proxies).");
  } else {
    const record = await enableTrustedProxies(state, openclawProxiesConfig(runnerFor(config, io)));
    const earlierText = record.earlier.present ? JSON.stringify(record.earlier.value) : "absent";
    io.out(
      record.changed
        ? `gateway.trustedProxies set to ${JSON.stringify(record.applied)} (it was ${earlierText}); teardown puts it back.`
        : `gateway.trustedProxies already covers loopback: ${JSON.stringify(record.applied)}.`,
    );
  }

  const serviceDir = values["service-dir"] ?? join(state.path, SERVICE_DIR);
  mkdirSync(serviceDir, { recursive: true, mode: 0o700 });
  const written = writeServiceFiles(serviceDir, {
    node: process.execPath,
    cli: fileURLToPath(import.meta.url),
    stateDir: state.path,
  });
  io.out(`Service files: ${written.launchAgent}, ${written.systemdUnit}`);
  for (const line of serviceInstructions(written)) io.out(line);
  io.out("Or run it in the foreground: clawtrate-connector run");
  return 0;
}

async function run(args: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({ args, options: { "state-dir": { type: "string" } } });
  const state = StateDir.open(stateDirOf(values, io), io.env);
  const daemon = new ConnectorDaemon({
    state,
    log: (message) => io.err(`${new Date(io.now()).toISOString()} ${message}`),
  });
  daemon.start();
  io.err(`Connector running for relay id ${daemon.relayId}.`);
  await (io.untilStopped ?? untilSignal)();
  daemon.stop();
  return 0;
}

function untilSignal(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
}

function status(args: string[], io: CliIo): number {
  const { values } = parseArgs({
    args,
    options: { "state-dir": { type: "string" }, json: { type: "boolean", default: false } },
  });
  const state = StateDir.open(stateDirOf(values, io), io.env);
  const config = loadConfig(state);
  const keys = loadKeys(state);
  const nowMs = io.now();
  const phones = readPhones(state);
  const proxies = readProxiesRecord(state);
  const running = state.read(STATUS_FILE, parseStatus);
  const fresh = running !== null && nowMs - running.updatedAtMs <= STATUS_STALE_MS;
  const summary = {
    relayOrigin: config.relayOrigin,
    relayId: keys.relayId,
    connectorKey: toBase64Url(keys.noise.publicKey),
    gatewayPort: config.gatewayPort,
    running: fresh ? running.state : "not running",
    sessions: fresh ? running.sessions : 0,
    lastExit: running?.lastExit ?? null,
    phones: phones.phones.map((phone) => ({
      name: phone.label,
      key: phone.key,
      addedAtMs: phone.addedAtMs,
    })),
    openPairingCodes: phones.offers.filter((o) => !o.used && nowMs < o.expiresAtMs).length,
    trustedProxies: proxies,
  };
  if (values.json) {
    io.out(JSON.stringify(summary, null, 2));
    return 0;
  }
  io.out(`Relay: ${summary.relayOrigin}, relay id ${summary.relayId}`);
  io.out(`Gateway: ws://127.0.0.1:${summary.gatewayPort}`);
  io.out(
    fresh
      ? `Connector: ${summary.running}, ${summary.sessions} session(s)`
      : `Connector: not running${running ? ` (last seen ${new Date(running.updatedAtMs).toISOString()})` : ""}`,
  );
  if (summary.lastExit) io.out(`Last relay link end: ${summary.lastExit}`);
  io.out(
    proxies === null
      ? "gateway.trustedProxies: not set by this connector"
      : `gateway.trustedProxies: ${JSON.stringify(proxies.applied)}${proxies.changed ? `, set by this connector (was ${proxies.earlier.present ? JSON.stringify(proxies.earlier.value) : "absent"})` : ""}`,
  );
  io.out(`Phones: ${summary.phones.length}`);
  for (const phone of summary.phones) {
    io.out(`  ${phone.name}  ${phone.key}  added ${new Date(phone.addedAtMs).toISOString()}`);
  }
  if (summary.openPairingCodes > 0) io.out(`Open pairing codes: ${summary.openPairingCodes}`);
  return 0;
}

async function pairPhone(args: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      "state-dir": { type: "string" },
      name: { type: "string", default: "Phone" },
      json: { type: "boolean", default: false },
    },
  });
  const label = checkLabel(values.name);
  const state = StateDir.open(stateDirOf(values, io), io.env);
  const config = loadConfig(state);
  const keys = loadKeys(state);
  const dial = dialUrl(config.relayOrigin, keys.relayId);
  // `--limited`: the phone asks for read access alone, and the owner approves it on the gateway.
  const qr = await runJson(runnerFor(config, io), ["qr", "--json", "--limited", "--url", dial]);
  const setupCode = (qr as { setupCode?: unknown } | null)?.setupCode;
  const nowMs = io.now();
  const setup = checkSetupCode(setupCode, dial, nowMs);
  const expiresAtMs = Math.min(setup.expiresAtMs, nowMs + MAX_OFFER_MS);
  const secret = secureRandomBytes(32);
  let code: string;
  try {
    addOffer(state, { secret, expiresAtMs, label }, nowMs);
    code = encodeRelayCode({
      relayOrigin: config.relayOrigin,
      relayId: keys.relayId,
      connectorKey: toBase64Url(keys.noise.publicKey),
      enroll: secret,
      expiresAtMs,
      setupCode: setupCode as string,
    });
  } finally {
    secret.fill(0);
  }
  if (values.json) {
    io.out(JSON.stringify({ code, expiresAtMs, relayId: keys.relayId }));
    return 0;
  }
  io.out(renderQr(code, { color: io.isTTY }));
  io.out("");
  io.out(`Scan this with Clawtrate on the phone, or paste the code:`);
  io.out(code);
  io.out("");
  io.out(`It works once, until ${new Date(expiresAtMs).toLocaleTimeString()}.`);
  io.out(
    "The phone then waits for you to approve it on the gateway: openclaw devices approve <request id>",
  );
  return 0;
}

function removePhone(args: string[], io: CliIo): number {
  const { values, positionals } = parseArgs({
    args,
    options: { "state-dir": { type: "string" } },
    allowPositionals: true,
  });
  if (positionals.length !== 1) throw new Error("name one phone, by its key or its name.");
  const state = StateDir.open(stateDirOf(values, io), io.env);
  const removed = removePhones(state, positionals[0]!, io.now());
  if (removed.length === 0) {
    io.err("No phone has that key or name.");
    return 1;
  }
  for (const phone of removed) io.out(`Removed ${phone.label} (${phone.key}).`);
  io.out(
    "A running connector ends its session within seconds. To revoke the device on the gateway too: openclaw devices remove <device id>",
  );
  return 0;
}

async function teardown(args: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { "state-dir": { type: "string" }, "service-dir": { type: "string" } },
  });
  const state = StateDir.open(stateDirOf(values, io), io.env);
  const config = loadConfig(state);
  const outcome = await restoreTrustedProxies(state, openclawProxiesConfig(runnerFor(config, io)));
  io.out(
    outcome === "restored"
      ? "gateway.trustedProxies is back to its earlier value, read back to check."
      : outcome === "unchanged"
        ? "gateway.trustedProxies was not changed by this connector; left as it is."
        : "This connector has no record of gateway.trustedProxies; nothing to put back.",
  );
  const serviceDir = values["service-dir"] ?? join(state.path, SERVICE_DIR);
  for (const name of [LAUNCH_AGENT_FILE, SYSTEMD_UNIT_FILE])
    rmSync(join(serviceDir, name), { force: true });
  io.out(
    "The generated service files were removed. Unload a service you installed from them yourself.",
  );
  io.out(`Keys and paired phones stay in ${state.path}.`);
  return 0;
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2), {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    env: process.env,
    now: Date.now,
    isTTY: process.stdout.isTTY === true,
  });
  process.exit(code);
}
