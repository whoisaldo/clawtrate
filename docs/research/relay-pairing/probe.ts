// Probes for the relay pairing design (docs/research/relay-pairing.md): what the screens of
// "Connect a phone", "Approve from here", the Remote access row and the phone's states rest on.
// It needs the relay protocol, the relay, the connector and core's relay route (R1 to R4, not yet
// on main): copy it to packages/connector/e2e/ on a checkout that has them, and run it there,
// against a named development instance. Every token is redacted from what it prints.
//
//   pnpm dev-gateway start --instance <name> --trust-loopback-proxy --no-seed
//   node pairing-probe.ts impersonate --instance <name> --profile limited|voice-node
//   node pairing-probe.ts approve --instance <name>
//   node pairing-probe.ts states --instance <name>
//   pnpm dev-gateway start --instance <plain> --no-seed
//   node pairing-probe.ts proxies --instance <plain>

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { WebSocketServer, type RawData, type WebSocket as WsSocket } from "ws";
import { generateKeyPair, secureRandomBytes, toBase64Url, type KeyPair } from "@clawtrate/relay-protocol";
import { FORBIDDEN_PORTS } from "../../../e2e/ports.ts";
import { startRelayServer } from "../../../services/relay/src/node/server.ts";
import { instancePorts, openInstance, readDevConnection } from "../../../tools/dev-gateway/src/cli.ts";
import { parseRelayCode } from "../../core/src/relay/code.ts";
import { RelaySocket, type RelayTransport } from "../../core/src/relay/socket.ts";
import { addOffer } from "../src/allowlist.ts";
import { main, type CliIo } from "../src/cli.ts";
import { dialUrl, loadConfig, loadKeys } from "../src/config.ts";
import { parseStatus, STATUS_FILE } from "../src/daemon.ts";
import { encodeRelayCode } from "../src/envelope.ts";
import { parseJsonOutput, type OpenclawRunner } from "../src/openclaw.ts";
import { StateDir } from "../src/state.ts";

const { values, positionals } = parseArgs({
  options: { instance: { type: "string" }, profile: { type: "string", default: "limited" } },
  allowPositionals: true,
});
const scenario = positionals[0];
const name = values.instance;
if (!name) throw new Error("--instance <name> is required");
const inst = openInstance(name);
const { gatewayPort } = instancePorts(inst);
if (FORBIDDEN_PORTS.includes(gatewayPort) || gatewayPort === 18789) throw new Error("port");
if (!readDevConnection(inst.connectionFile)) throw new Error("start the instance first");

const requireFromTool = createRequire(new URL("../../../tools/dev-gateway/package.json", import.meta.url));
const { GatewayClient } = (await import(
  pathToFileURL(requireFromTool.resolve("@openclaw/gateway-client")).href
)) as { GatewayClient: new (options: unknown) => GatewayClientLike };
interface GatewayClientLike {
  start(): void;
  request<T>(method: string, params?: unknown): Promise<T>;
  stopAndWait(): Promise<void>;
}

const say = (label: string, value: unknown) =>
  console.log(`[${scenario}] ${label}: ${typeof value === "string" ? value : JSON.stringify(redact(value))}`);
const TOKENISH = /^(token|deviceToken|bootstrapToken|code|setupCode|enroll)$/;
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, TOKENISH.test(k) && typeof v === "string" ? "<redacted>" : redact(v)]),
    );
  }
  if (typeof value === "string") return value.replace(/requestId: [0-9a-f-]{36}/, "requestId: <id>");
  return value;
}

const openclaw: OpenclawRunner = (args) => inst.runner.run(args);
async function openclawJson<T>(args: string[]): Promise<{ status: number | null; json: T | null; err: string }> {
  const r = await openclaw(args);
  let json: T | null = null;
  try {
    json = parseJsonOutput(r.stdout) as T;
  } catch {
    json = null;
  }
  const err = (r.stderr || "").trim().split("\n").slice(-2).join(" ").slice(0, 300);
  return { status: r.status, json, err };
}

const scratch = mkdtempSync(join(tmpdir(), "relay-pairing-probe-"));
const stateDir = join(scratch, "state");
const cleanups: (() => Promise<void> | void)[] = [() => rmSync(scratch, { recursive: true, force: true })];
const deviceIds: string[] = [];

const outputs: string[] = [];
const io: CliIo = {
  out: (l) => outputs.push(l),
  err: (l) => outputs.push(l),
  env: process.env,
  now: Date.now,
  isTTY: false,
  openclaw: () => openclaw,
};
async function cli(args: string[]): Promise<{ code: number; lines: string[] }> {
  outputs.length = 0;
  const code = await main([...args, "--state-dir", stateDir], io);
  return { code, lines: [...outputs] };
}

let relay = await startRelayServer({ host: "127.0.0.1", port: 0 });
cleanups.push(() => relay.close());
let connector: ChildProcess | null = null;

async function waitFor(what: string, test: () => boolean, ms = 30_000) {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
async function startConnector() {
  connector = spawn(process.execPath, [fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "run", "--state-dir", stateDir], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  const state = StateDir.open(stateDir);
  await waitFor("registration", () => state.read(STATUS_FILE, parseStatus)?.state === "registered");
}
async function stopConnector() {
  if (connector === null) return;
  const c = connector;
  connector = null;
  c.kill("SIGTERM");
  await new Promise((r) => c.once("exit", r));
}

async function setup(extra: string[] = []) {
  const r = await cli(["setup", "--relay", relay.origin, "--gateway-port", String(gatewayPort), "--service-dir", join(scratch, "service"), ...extra]);
  return r;
}

/** A code, as pair-phone makes it, or with another qr profile. */
async function makeCode(profile: string): Promise<string> {
  if (profile === "limited") {
    const r = await cli(["pair-phone", "--name", "Probe phone", "--json"]);
    if (r.code !== 0) throw new Error(r.lines.join(" | "));
    return (JSON.parse(r.lines[0]!) as { code: string }).code;
  }
  const state = StateDir.open(stateDir);
  const config = loadConfig(state);
  const keys = loadKeys(state);
  const dial = dialUrl(config.relayOrigin, keys.relayId);
  const qr = await openclawJson<{ setupCode: string; access?: string }>(["qr", "--json", `--${profile}`, "--url", dial]);
  say(`openclaw qr --${profile}`, { status: qr.status, access: qr.json?.access });
  const setupCode = qr.json!.setupCode;
  const now = Date.now();
  const expiresAtMs = now + 10 * 60 * 1000 - 1000;
  const secret = secureRandomBytes(32);
  addOffer(state, { secret, expiresAtMs, label: "Probe phone" }, now);
  return encodeRelayCode({
    relayOrigin: config.relayOrigin,
    relayId: keys.relayId,
    connectorKey: toBase64Url(keys.noise.publicKey),
    enroll: secret,
    expiresAtMs,
    setupCode,
  });
}

/** The phone: core's RelaySocket under a loopback WebSocket that OpenClaw's own client uses. */
const closes: { code: number; reason: string }[] = [];
async function phone(code: string, key: KeyPair = generateKeyPair(), withEnroll = true) {
  const parsed = parseRelayCode(code, Date.now(), { allowLoopbackWs: true });
  let enroll: Uint8Array | null = withEnroll ? parsed.enroll : null;
  const server = createHttpServer();
  const wss = new WebSocketServer({ server, perMessageDeflate: false });
  const live = new Set<WsSocket>();
  const open = (onText: ((t: string) => void) | null, onEnd: (c: { code: number; reason: string }) => void) => {
    const socket = new RelaySocket({
      route: parsed.route,
      staticKey: key,
      enroll,
      createTransport: (url) => new WebSocket(url) as unknown as RelayTransport,
    });
    enroll = null;
    const queued: string[] = [];
    socket.onopen = () => {
      for (const t of queued.splice(0)) socket.send(t);
    };
    socket.onmessage = (e) => onText?.(String(e.data));
    socket.onclose = (e) => {
      closes.push(e);
      onEnd(e);
    };
    return {
      send: (t: string) => (socket.readyState === 1 ? socket.send(t) : queued.push(t)),
      close: () => socket.close(1000),
    };
  };
  wss.on("connection", (client) => {
    live.add(client);
    const s = open((t) => client.send(t), () => client.close());
    client.on("message", (d: RawData) => s.send(d.toString()));
    client.on("close", () => {
      live.delete(client);
      s.close();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const handle = {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    bootstrapToken: parsed.bootstrapToken,
    /** One relay session with no client, to see how it ends. */
    probe: () => new Promise<{ code: number; reason: string }>((resolve) => open(null, resolve)),
    close: () =>
      new Promise<void>((r) => {
        for (const c of live) c.terminate();
        wss.close();
        server.close(() => r());
      }),
  };
  cleanups.push(handle.close);
  return handle;
}

function identity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const id = createHash("sha256").update(raw).digest("hex");
  deviceIds.push(id);
  return {
    deviceId: id,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

interface ConnectAs {
  clientName: string;
  mode: string;
  role: string;
  scopes: string[];
  platform: string;
  deviceFamily?: string;
}
const GATEWAY_CLIENT_READ: ConnectAs = { clientName: "gateway-client", mode: "ui", role: "operator", scopes: ["operator.read"], platform: "ios", deviceFamily: "iphone" };

function connect(url: string, device: ReturnType<typeof identity>, as: ConnectAs, tokens: Record<string, unknown>, bootstrapToken?: string) {
  return new Promise<Record<string, unknown>>((resolve) => {
    let done = false;
    const finish = (v: Record<string, unknown>) => {
      if (done) return;
      done = true;
      void client.stopAndWait().catch(() => {});
      resolve(v);
    };
    const client: GatewayClientLike = new GatewayClient({
      url,
      ...(bootstrapToken ? { bootstrapToken } : {}),
      clientName: as.clientName,
      mode: as.mode,
      clientDisplayName: "Relay pairing probe phone",
      clientVersion: "0.0.0-probe",
      platform: as.platform,
      ...(as.deviceFamily ? { deviceFamily: as.deviceFamily } : {}),
      role: as.role,
      scopes: as.scopes,
      caps: [],
      minProtocol: 4,
      maxProtocol: 4,
      deviceIdentity: device,
      hostDeps: {
        signDevicePayload: (pem: string, payload: string) => sign(null, Buffer.from(payload), createPrivateKey(pem)).toString("base64url"),
        publicKeyRawBase64UrlFromPem: (pem: string) =>
          createPublicKey(pem).export({ type: "spki", format: "der" }).subarray(-32).toString("base64url"),
        loadDeviceAuthToken: ({ deviceId, role }: { deviceId: string; role: string }) => tokens[`${deviceId}:${role}`],
        storeDeviceAuthToken: (record: { deviceId: string; role: string }) => {
          tokens[`${record.deviceId}:${record.role}`] = record;
        },
        clearDeviceAuthToken: ({ deviceId, role }: { deviceId: string; role: string }) => delete tokens[`${deviceId}:${role}`],
      },
      onHelloOk: (hello: { auth?: { role?: string; scopes?: string[]; deviceToken?: string; deviceTokens?: unknown } }) =>
        finish({
          outcome: "hello",
          role: hello.auth?.role,
          scopes: hello.auth?.scopes,
          deviceToken: Boolean(hello.auth?.deviceToken),
          deviceTokens: Array.isArray(hello.auth?.deviceTokens)
            ? (hello.auth!.deviceTokens as { role?: string; scopes?: string[] }[]).map((t) => ({ role: t.role, scopes: t.scopes }))
            : hello.auth?.deviceTokens === undefined
              ? undefined
              : "present",
        }),
      onConnectError: (e: Error & { code?: string; details?: { code?: string; reason?: string } }) =>
        finish({ outcome: "refused", message: e.message, code: e.code, detail: e.details?.code, reason: e.details?.reason }),
    });
    client.start();
    setTimeout(() => finish({ outcome: "no answer in 20 s" }), 20_000);
  });
}

async function devices() {
  const r = await openclawJson<{ pending?: Record<string, unknown>[]; paired?: Record<string, unknown>[] }>(["devices", "list", "--json"]);
  return r.json ?? { pending: [], paired: [] };
}
const pick = (e: Record<string, unknown> | undefined) =>
  e && {
    requestId: e.requestId ? "<id>" : undefined,
    deviceId: String(e.deviceId).slice(0, 12),
    clientId: e.clientId,
    clientMode: e.clientMode,
    platform: e.platform,
    role: e.role,
    roles: e.roles,
    scopes: e.scopes,
    approvedScopes: e.approvedScopes,
    remoteIp: e.remoteIp,
    approvedVia: e.approvedVia,
    isRepair: e.isRepair,
  };

try {
  if (scenario === "impersonate") {
    const s = await setup();
    say("setup", s.lines.filter((l) => l.includes("trustedProxies")));
    await startConnector();
    const profile = values.profile!;
    const as: ConnectAs =
      profile === "voice-node"
        ? { clientName: "node-host", mode: "node", role: "node", scopes: [], platform: "esp32", deviceFamily: "esp32" }
        : { clientName: "openclaw-ios", mode: "node", role: "node", scopes: [], platform: "ios", deviceFamily: "iphone" };
    const code = await makeCode(profile);
    const p = await phone(code);
    const device = identity();
    const result = await connect(p.url, device, as, {}, p.bootstrapToken);
    say(`a holder of a --${profile} code connects as ${as.clientName}, role ${as.role}, through the relay`, result);
    const list = await devices();
    say("gateway pending for it", pick(list.pending?.find((e) => e.deviceId === device.deviceId)));
    say("gateway paired for it", pick(list.paired?.find((e) => e.deviceId === device.deviceId)));
    // The same kind of code, used as Clawtrate's phone uses it, asking for more than read.
    const code2 = await makeCode(profile);
    const p2 = await phone(code2);
    const d2 = identity();
    const asks = { ...GATEWAY_CLIENT_READ, scopes: ["operator.read", "operator.write"] };
    const r2 = await connect(p2.url, d2, asks, {}, p2.bootstrapToken);
    say(`a --${profile} code, gateway-client asking for read and write`, r2);
    say("gateway pending for it", pick((await devices()).pending?.find((e) => e.deviceId === d2.deviceId)));
  } else if (scenario === "approve") {
    await setup();
    await startConnector();
    const code = await makeCode("limited");
    const p = await phone(code);
    const device = identity();
    const tokens: Record<string, unknown> = {};
    const first = await connect(p.url, device, GATEWAY_CLIENT_READ, tokens, p.bootstrapToken);
    say("first connect", first);
    const list = await devices();
    const entry = list.pending?.find((e) => e.deviceId === device.deviceId);
    say("devices list --json, the pending entry (all its fields)", Object.keys(entry ?? {}).sort());
    say("the pending entry", pick(entry));
    const gl = await openclawJson<{ pending?: Record<string, unknown>[] }>(["gateway", "call", "device.pair.list", "--json"]);
    say("gateway call device.pair.list", { status: gl.status, pendingFields: Object.keys(gl.json?.pending?.find((e) => e.deviceId === device.deviceId) ?? {}).sort(), err: gl.status ? gl.err : undefined });
    // A request id that is not pending.
    const bogus = await openclawJson(["gateway", "call", "device.pair.approve", "--params", JSON.stringify({ requestId: "00000000-0000-4000-8000-000000000000" }), "--json"]);
    say("gateway call device.pair.approve, an id that isn't pending", { status: bogus.status, err: bogus.err });
    // The phone asks again with more: the gateway supersedes the request.
    const wider = await connect(p.url, device, { ...GATEWAY_CLIENT_READ, scopes: ["operator.read", "operator.write"] }, tokens, p.bootstrapToken);
    say("the same phone asks again for read and write", wider);
    const after = await devices();
    const now = after.pending?.filter((e) => e.deviceId === device.deviceId) ?? [];
    say("pending for the device now", now.map(pick));
    say("the earlier request id still pending", now.some((e) => e.requestId === entry!.requestId));
    const stale = await openclawJson(["gateway", "call", "device.pair.approve", "--params", JSON.stringify({ requestId: entry!.requestId }), "--json"]);
    say("gateway call device.pair.approve with the earlier id", { status: stale.status, err: stale.err });
    // Back to read alone: a narrower retry.
    const narrower = await connect(p.url, device, GATEWAY_CLIENT_READ, tokens, p.bootstrapToken);
    say("the same phone asks again for read alone", narrower);
    const final = (await devices()).pending?.filter((e) => e.deviceId === device.deviceId) ?? [];
    say("pending for the device now", final.map(pick));
    const target = final[0]!;
    const ok = await openclawJson<Record<string, unknown>>(["gateway", "call", "device.pair.approve", "--params", JSON.stringify({ requestId: target.requestId }), "--json"]);
    say("gateway call device.pair.approve with the current id", {
      status: ok.status,
      resultKeys: Object.keys(ok.json ?? {}).sort(),
      device: pick(ok.json?.device as Record<string, unknown>),
      sameId: ok.json?.requestId === target.requestId,
    });
    const hello = await connect(p.url, device, GATEWAY_CLIENT_READ, tokens, p.bootstrapToken);
    say("the phone connects again", hello);
    say("paired", pick((await devices()).paired?.find((e) => e.deviceId === device.deviceId)));
  } else if (scenario === "states") {
    await setup();
    await startConnector();
    const key = generateKeyPair();
    const code = await makeCode("limited");
    const p = await phone(code, key);
    const device = identity();
    const tokens: Record<string, unknown> = {};
    await connect(p.url, device, GATEWAY_CLIENT_READ, tokens, p.bootstrapToken);
    const entry = (await devices()).pending?.find((e) => e.deviceId === device.deviceId);
    await openclaw(["devices", "approve", String(entry!.requestId)]);
    say("paired phone connects", await connect(p.url, device, GATEWAY_CLIENT_READ, tokens, p.bootstrapToken));
    const status = await cli(["status", "--json"]);
    say("status --json", JSON.parse(status.lines.join("\n")));
    // The same phone later, without the code's secret: as the app reconnects.
    const again = await phone(code, key, false);
    say("paired phone reconnects without the secret", await connect(again.url, device, GATEWAY_CLIENT_READ, tokens));
    // The connector stops.
    await stopConnector();
    say("status --json, connector stopped", (JSON.parse((await cli(["status", "--json"])).lines.join("\n")) as { running: string }).running);
    say("dial with the connector stopped", await again.probe());
    // The relay stops.
    const origin = relay.origin;
    await relay.close();
    say("dial with the relay stopped", await again.probe());
    relay = await startRelayServer({ host: "127.0.0.1", port: Number(new URL(origin.replace("ws", "http")).port) });
    await startConnector();
    say("after relay and connector are back", await connect(again.url, device, GATEWAY_CLIENT_READ, tokens));
    // A code used twice: the second phone.
    const other = await phone(code, generateKeyPair(), true);
    say("a second phone presents the same code", await other.probe());
    // remove-phone.
    const keyText = toBase64Url(key.publicKey);
    const removed = await cli(["remove-phone", keyText]);
    say("remove-phone", removed.lines.map((l) => l.replace(keyText, "<phone key>")));
    say("the removed phone dials", await again.probe());
    say("status phones after removal", (JSON.parse((await cli(["status", "--json"])).lines.join("\n")) as { phones: unknown[] }).phones.length);
    // Revoked on the gateway but still enrolled: enroll a new phone, approve, then devices remove.
    const key3 = generateKeyPair();
    const code3 = await makeCode("limited");
    const p3 = await phone(code3, key3);
    const d3 = identity();
    const t3: Record<string, unknown> = {};
    await connect(p3.url, d3, GATEWAY_CLIENT_READ, t3, p3.bootstrapToken);
    const e3 = (await devices()).pending?.find((e) => e.deviceId === d3.deviceId);
    await openclaw(["devices", "approve", String(e3!.requestId)]);
    await connect(p3.url, d3, GATEWAY_CLIENT_READ, t3, p3.bootstrapToken);
    const rm = await openclawJson(["devices", "remove", d3.deviceId, "--json"]);
    say("devices remove on the gateway", { status: rm.status });
    const p3b = await phone(code3, key3, false);
    say("the revoked phone reconnects with its device token", await connect(p3b.url, d3, GATEWAY_CLIENT_READ, t3));
    say("gateway pending after that", pick((await devices()).pending?.find((e) => e.deviceId === d3.deviceId)));
  } else if (scenario === "connector-view") {
    await setup();
    await startConnector();
    const st = async () => {
      const s = JSON.parse((await cli(["status", "--json"])).lines.join("\n")) as Record<string, unknown>;
      return { running: s.running, sessions: s.sessions, lastExit: s.lastExit };
    };
    say("status, relay up", await st());
    await relay.close();
    await new Promise((r) => setTimeout(r, 4000));
    say("status 4 s after the relay stopped", await st());
    await stopConnector();
    say("status right after the connector stopped", await st());
  } else if (scenario === "proxies") {
    const read = async () => (await openclawJson<Record<string, unknown>>(["config", "get", "gateway", "--json"])).json?.trustedProxies ?? "absent";
    say("before setup, gateway.trustedProxies", await read());
    // Before setup: the connector's forwarded upgrade is refused by the gateway.
    const pre = await setup(["--no-trusted-proxies"]);
    say("setup --no-trusted-proxies", pre.code);
    await startConnector();
    const code = await makeCode("limited");
    const p = await phone(code);
    const d = identity();
    say("a phone connects before trustedProxies is set", await connect(p.url, d, GATEWAY_CLIENT_READ, {}, p.bootstrapToken));
    say("how the relay route ended", closes.at(-1));
    // setup now sets it, with the gateway still running.
    const s = await setup();
    say("setup", { code: s.code, lines: s.lines.filter((l) => l.includes("trustedProxies")) });
    say("after setup, gateway.trustedProxies", await read());
    const code2 = await makeCode("limited");
    const p2 = await phone(code2);
    const d2 = identity();
    say("a phone connects after setup, no restart", await connect(p2.url, d2, GATEWAY_CLIENT_READ, {}, p2.bootstrapToken));
    say("pending", pick((await devices()).pending?.find((e) => e.deviceId === d2.deviceId)));
    const t = await cli(["teardown", "--service-dir", join(scratch, "service")]);
    say("teardown", { code: t.code, lines: t.lines.slice(0, 1) });
    say("after teardown, gateway.trustedProxies", await read());
    // Someone else changes it in between.
    await setup();
    await openclaw(["config", "set", "gateway.trustedProxies", JSON.stringify(["127.0.0.1", "::1", "198.51.100.0/24"]), "--strict-json"]);
    const t2 = await cli(["teardown", "--service-dir", join(scratch, "service")]);
    say("teardown after another change", { code: t2.code, lines: t2.lines });
    say("gateway.trustedProxies then", await read());
    const st = await cli(["status", "--json"]);
    say("status trustedProxies record", (JSON.parse(st.lines.join("\n")) as { trustedProxies: unknown }).trustedProxies);
    // Put the instance back as it was.
    await openclaw(["config", "unset", "gateway.trustedProxies"]);
    say("restored by hand for the instance", await read());
  } else {
    throw new Error("scenario: impersonate | approve | states | proxies");
  }
} finally {
  await stopConnector();
  for (const id of deviceIds) await openclaw(["devices", "remove", id]).catch(() => {});
  for (const c of cleanups.reverse()) await Promise.resolve().then(c).catch(() => {});
}
