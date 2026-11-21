// The connector end to end, on loopback: the relay's Node runner, this connector running in the
// foreground as its own process, a named development gateway started with R0's
// `--trust-loopback-proxy`, and a Node phone on the protocol package's initiator.
//
//   pnpm dev-gateway start --instance <name> --trust-loopback-proxy --no-seed
//   node packages/connector/e2e/dev-gateway.ts --instance <name>
//
// It proves, against the real gateway:
// - `setup` reads `gateway.trustedProxies` through OpenClaw's command line, records it and verifies
//   it covers loopback; `teardown` leaves it as it was;
// - `pair-phone` makes a pairing code from `openclaw qr --limited`, which the phone uses: its
//   enrollment secret enrolls the phone at the connector, and its bootstrap token is redeemed with
//   the gateway through the relay;
// - the gateway makes the phone wait for approval (it arrives as remote, with the connector's
//   X-Forwarded-For), then after `devices approve` says hello with exactly `operator.read`, and a
//   request round trip works inside the end-to-end channel;
// - a phone that is not enrolled is refused, and the gateway gets no connection at all.
//
// Everything listens on 127.0.0.1. The default instance and its ports are refused, and so is 18789.
// OpenClaw runs only through the development tool's guarded runner. The phone's device is removed
// from the gateway at the end, and every temporary folder this makes is deleted.

import { spawn, type ChildProcess } from "node:child_process";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  createHash,
  sign,
} from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { createServer as createTcpServer, connect as tcpConnect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  fromBase64Url,
  generateKeyPair,
  Initiator,
  RELAY_PING,
  RELAY_PONG,
  type KeyPair,
} from "@clawtrate/relay-protocol";
import { FORBIDDEN_PORTS } from "../../../e2e/ports.ts";
import { startRelayServer } from "../../../services/relay/src/node/server.ts";
import {
  instancePorts,
  openInstance,
  readDevConnection,
  recordedStartOptions,
} from "../../../tools/dev-gateway/src/cli.ts";
import { main, type CliIo } from "../src/cli.ts";
import { parseStatus, STATUS_FILE } from "../src/daemon.ts";
import { parseJsonOutput, type OpenclawRunner } from "../src/openclaw.ts";
import { StateDir } from "../src/state.ts";

const { values } = parseArgs({ options: { instance: { type: "string" } } });
const name = values.instance;
if (!name) throw new Error("--instance <name> is required; the default instance is never used");
const inst = openInstance(name);
if (!recordedStartOptions(inst).trustLoopbackProxy) {
  throw new Error(`instance ${name} was not started with --trust-loopback-proxy`);
}
const { gatewayPort } = instancePorts(inst);
if (FORBIDDEN_PORTS.includes(gatewayPort) || gatewayPort === 18789) {
  throw new Error(`refusing gateway port ${gatewayPort}`);
}
if (!readDevConnection(inst.connectionFile))
  throw new Error(`instance ${name} has no connection file; start it first`);

interface GatewayClientLike {
  start(): void;
  request<T>(method: string, params?: unknown): Promise<T>;
  stopAndWait(): Promise<void>;
}

// The pinned client, from the development tool's own dependencies.
const requireFromTool = createRequire(
  new URL("../../../tools/dev-gateway/package.json", import.meta.url),
);
const { GatewayClient } = (await import(
  pathToFileURL(requireFromTool.resolve("@openclaw/gateway-client")).href
)) as {
  GatewayClient: new (options: unknown) => GatewayClientLike;
};

const log = (line: string) => console.log(`connector-e2e: ${line}`);
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`check failed: ${message}`);
  log(`ok: ${message}`);
}
async function waitFor(what: string, test: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const openclaw: OpenclawRunner = (args) => inst.runner.run(args);
async function openclawJson<T>(args: string[]): Promise<T> {
  const result = await openclaw(args);
  if (result.status !== 0)
    throw new Error(`openclaw ${args.slice(0, 2).join(" ")}: exit ${result.status}`);
  return parseJsonOutput(result.stdout) as T;
}

// Everything this run makes, removed at the end.
const scratch = mkdtempSync(join(tmpdir(), "clawtrate-connector-e2e-"));
const stateDir = join(scratch, "state");
const cleanups: (() => Promise<void> | void)[] = [
  () => rmSync(scratch, { recursive: true, force: true }),
];

/**
 * A TCP pass-through between the connector and the gateway's port, counting connections, so
 * "the gateway saw no connection" is measured. The gateway still sees a socket from 127.0.0.1
 * carrying the connector's own upgrade, byte for byte.
 */
let gatewayConnections = 0;
const passThrough = createTcpServer((client) => {
  gatewayConnections++;
  const upstream = tcpConnect(gatewayPort, "127.0.0.1");
  client.pipe(upstream).pipe(client);
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
});
await new Promise<void>((resolve) => passThrough.listen(0, "127.0.0.1", resolve));
const passThroughPort = (passThrough.address() as AddressInfo).port;
cleanups.push(() => new Promise<void>((resolve) => passThrough.close(() => resolve())));

const relay = await startRelayServer({ host: "127.0.0.1", port: 0 });
cleanups.push(() => relay.close());
log(`relay on ${relay.url}, gateway ${name} on port ${gatewayPort} (through ${passThroughPort})`);

const outputs: string[] = [];
const io: CliIo = {
  out: (line) => outputs.push(line),
  err: (line) => outputs.push(line),
  env: process.env,
  now: Date.now,
  isTTY: false,
  openclaw: () => openclaw,
};
async function cli(args: string[]): Promise<string[]> {
  outputs.length = 0;
  const code = await main([...args, "--state-dir", stateDir], io);
  if (code !== 0)
    throw new Error(`clawtrate-connector ${args[0]} exited ${code}: ${outputs.join(" | ")}`);
  return [...outputs];
}

let connector: ChildProcess | null = null;
let deviceId: string | null = null;
try {
  // setup, with the gateway's real config read through OpenClaw.
  const setupLines = await cli([
    "setup",
    "--relay",
    relay.origin,
    "--gateway-port",
    String(passThroughPort),
    "--service-dir",
    join(scratch, "service"),
  ]);
  log(setupLines.filter((line) => line.includes("trustedProxies")).join(" "));
  check(
    setupLines.some((line) =>
      line.includes('gateway.trustedProxies already covers loopback: ["127.0.0.1","::1"]'),
    ),
    "setup read gateway.trustedProxies from the gateway and verified it covers loopback",
  );

  // The connector, in the foreground, as its own process.
  connector = spawn(
    process.execPath,
    [fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "run", "--state-dir", stateDir],
    {
      stdio: ["ignore", "inherit", "pipe"],
    },
  );
  let connectorLog = "";
  connector.stderr!.on("data", (chunk: Buffer) => (connectorLog += chunk.toString("utf8")));
  const state = StateDir.open(stateDir);
  await waitFor(
    "the connector to register",
    () => state.read(STATUS_FILE, parseStatus)?.state === "registered",
  );
  check(true, `the connector registered with the relay (pid ${connector.pid})`);

  // pair-phone, with a real `openclaw qr --limited`.
  const [pairing] = await cli(["pair-phone", "--name", "E2E phone", "--json"]);
  const { code } = JSON.parse(pairing!) as { code: string };
  const envelope = JSON.parse(new TextDecoder().decode(fromBase64Url(code)!)) as {
    relay: string;
    relayId: string;
    connectorKey: string;
    enroll: string;
    openclaw: string;
  };
  const setup = JSON.parse(new TextDecoder().decode(fromBase64Url(envelope.openclaw)!)) as {
    url: string;
    bootstrapToken: string;
  };
  check(
    setup.url === `${envelope.relay}/v1/dial/${envelope.relayId}`,
    "the setup code carries the relay dial address",
  );

  const phoneKey = generateKeyPair();
  const enrolled = await tunnel({ envelope, phoneKey, enroll: fromBase64Url(envelope.enroll)! });
  cleanups.push(() => enrolled.close());

  // The phone redeems the bootstrap token through the relay: the gateway makes it wait.
  const device = identity();
  deviceId = device.deviceId;
  const tokens: Record<string, unknown> = {};
  const first = await redeem(enrolled.url, setup.bootstrapToken, device, tokens);
  log(`first connect: ${JSON.stringify(redacted(first))}`);
  check(
    first.outcome === "refused" && /pairing required/i.test(String(first.message)),
    "the gateway made the relayed phone wait for approval",
  );
  check(gatewayConnections >= 1, "the enrolled phone reached the gateway through the connector");
  const listed = await openclawJson<{
    pending?: { deviceId: string; requestId: string; scopes?: string[]; remoteIp?: string }[];
  }>(["devices", "list", "--json"]);
  const pending = listed.pending?.find((entry) => entry.deviceId === device.deviceId);
  check(pending !== undefined, "the gateway lists the phone's pairing request");
  check(
    pending.remoteIp === "192.0.2.1",
    "the request carries the connector's forwarded address, so the gateway saw a remote device",
  );
  check(JSON.stringify(pending.scopes) === '["operator.read"]', "it asks for operator.read alone");
  const approved = await openclaw(["devices", "approve", pending.requestId]);
  check(approved.status === 0, "devices approve on the gateway's computer");

  const second = await redeem(enrolled.url, setup.bootstrapToken, device, tokens, true);
  log(`after approval: ${JSON.stringify(redacted(second))}`);
  check(second.outcome === "hello", "hello through the relay after approval");
  check(JSON.stringify(second.scopes) === '["operator.read"]', "hello with exactly operator.read");
  check(second.roundTrip === true, "a request round trip inside the end-to-end channel");

  const devices = await openclawJson<{
    paired?: { deviceId: string; approvedVia?: string; remoteIp?: string }[];
  }>(["devices", "list", "--json"]);
  const paired = devices.paired?.find((entry) => entry.deviceId === device.deviceId);
  check(
    paired !== undefined && paired.approvedVia !== "silent",
    `the pairing was approved, not silent (${paired?.approvedVia})`,
  );

  // A phone that is not enrolled: refused at the connector, no connection to the gateway.
  const before = gatewayConnections;
  const stranger = await tunnel({ envelope, phoneKey: generateKeyPair(), enroll: null });
  cleanups.push(() => stranger.close());
  const refused = await stranger.probe();
  check(refused === "not_enrolled", "the connector refused a phone that is not enrolled");
  await new Promise((resolve) => setTimeout(resolve, 500));
  check(gatewayConnections === before, "the gateway got no connection for it");

  // Status, then teardown leaves trustedProxies as it was.
  const status = await cli(["status", "--json"]);
  const summary = JSON.parse(status.join("\n")) as { running: string; phones: { name: string }[] };
  check(
    summary.running === "registered" && summary.phones.some((phone) => phone.name === "E2E phone"),
    "status shows the running connector and the enrolled phone",
  );
  connector.kill("SIGTERM");
  await new Promise((resolve) => connector!.once("exit", resolve));
  connector = null;
  const teardown = await cli(["teardown", "--service-dir", join(scratch, "service")]);
  check(
    teardown.some((line) => line.includes("was not changed by this connector")),
    "teardown left gateway.trustedProxies as it was",
  );
  const after = await openclawJson<{ trustedProxies?: string[] }>([
    "config",
    "get",
    "gateway",
    "--json",
  ]);
  check(
    JSON.stringify(after.trustedProxies) === '["127.0.0.1","::1"]',
    "the gateway's trustedProxies reads back unchanged",
  );
  if (connectorLog.includes("Error")) log(`connector log:\n${connectorLog}`);
  log("PASS");
} finally {
  if (connector !== null && connector.exitCode === null) connector.kill("SIGTERM");
  if (deviceId) await openclaw(["devices", "remove", deviceId]).catch(() => {});
  for (const cleanup of cleanups.reverse()) await cleanup();
}

/**
 * The phone's end: a loopback WebSocket server that OpenClaw's own client connects to, each of
 * whose connections dials the relay and runs one Noise IK session as the initiator, carrying the
 * client's text unchanged.
 */
async function tunnel(input: {
  envelope: { relay: string; relayId: string; connectorKey: string };
  phoneKey: KeyPair;
  enroll: Uint8Array | null;
}) {
  const server = createHttpServer();
  const wss = new WebSocketServer({ server, perMessageDeflate: false });
  const sockets: WebSocket[] = [];
  const session = (
    onClient: ((text: string) => void) | null,
    onEnd: (refusal: string | null) => void,
  ) => {
    const channel = new Initiator({
      relayId: input.envelope.relayId,
      connectorKey: fromBase64Url(input.envelope.connectorKey)!,
      staticKey: input.phoneKey,
      ...(input.enroll ? { enroll: input.enroll } : {}),
    });
    const relaySocket = new WebSocket(`${input.envelope.relay}/v1/dial/${input.envelope.relayId}`, {
      perMessageDeflate: false,
    });
    sockets.push(relaySocket);
    const queued: string[] = [];
    let refusal: string | null = null;
    relaySocket.on("message", (data: RawData, isBinary: boolean) => {
      if (!isBinary) {
        const text = data.toString();
        if (text === '{"t":"open"}') relaySocket.send(channel.start());
        else if (text === RELAY_PING) relaySocket.send(RELAY_PONG);
        return;
      }
      if (channel.currentState === "closed" || channel.currentState === "failed") return;
      for (const event of channel.receive(new Uint8Array(data as Buffer))) {
        if (event.type === "send") relaySocket.send(event.frame);
        else if (event.type === "open") for (const text of queued.splice(0)) send(text);
        else if (event.type === "text") onClient?.(event.text);
        else if (event.type === "refused") refusal = event.reason;
        else if (event.type === "close") relaySocket.close();
      }
    });
    relaySocket.on("close", () => onEnd(refusal));
    const send = (text: string) => {
      if (channel.currentState !== "open") return void queued.push(text);
      for (const frame of channel.sendText(text)) relaySocket.send(frame);
    };
    return {
      send,
      close: () => {
        if (channel.currentState === "open") relaySocket.send(channel.close(1000, ""));
        channel.abort();
        relaySocket.close();
      },
    };
  };
  wss.on("connection", (client) => {
    sockets.push(client);
    const phone = session(
      (text) => client.send(text),
      () => client.close(),
    );
    client.on("message", (data: RawData) => phone.send(data.toString()));
    client.on("close", () => phone.close());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    get url() {
      return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    /** One session with no client: resolves with the connector's refusal, or null. */
    probe: () => new Promise<string | null>((resolve) => session(null, resolve)),
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.terminate();
        wss.close();
        server.close(() => resolve());
      }),
  };
}

function identity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return {
    deviceId: createHash("sha256").update(raw).digest("hex"),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/** One connect with the setup code's bootstrap token, as a phone makes it, through the tunnel. */
function redeem(
  url: string,
  bootstrapToken: string,
  device: ReturnType<typeof identity>,
  tokens: Record<string, unknown>,
  roundTrip = false,
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (value: Record<string, unknown>) => {
      if (finished) return;
      finished = true;
      void client.stopAndWait().catch(() => {});
      resolve(value);
    };
    const client: GatewayClientLike = new GatewayClient({
      url,
      bootstrapToken,
      clientName: "gateway-client",
      mode: "ui",
      clientDisplayName: "Clawtrate connector e2e phone",
      clientVersion: "0.0.0-e2e",
      platform: "ios",
      role: "operator",
      scopes: ["operator.read"],
      caps: ["tool-events"],
      minProtocol: 4,
      maxProtocol: 4,
      deviceIdentity: device,
      hostDeps: {
        signDevicePayload: (pem: string, payload: string) =>
          sign(null, Buffer.from(payload), createPrivateKey(pem)).toString("base64url"),
        publicKeyRawBase64UrlFromPem: (pem: string) =>
          createPublicKey(pem)
            .export({ type: "spki", format: "der" })
            .subarray(-32)
            .toString("base64url"),
        loadDeviceAuthToken: ({ deviceId, role }: { deviceId: string; role: string }) =>
          tokens[`${deviceId}:${role}`],
        storeDeviceAuthToken: (record: { deviceId: string; role: string; token: string }) => {
          tokens[`${record.deviceId}:${record.role}`] = record;
        },
        clearDeviceAuthToken: ({ deviceId, role }: { deviceId: string; role: string }) =>
          delete tokens[`${deviceId}:${role}`],
      },
      onHelloOk: (hello: { auth?: { role?: string; scopes?: string[]; deviceToken?: string } }) => {
        const outcome = {
          outcome: "hello",
          role: hello.auth?.role,
          scopes: hello.auth?.scopes,
          deviceToken: Boolean(hello.auth?.deviceToken),
        };
        if (!roundTrip) return finish(outcome);
        client
          .request<{ agents?: unknown[] }>("agents.list", {})
          .then((answer) =>
            finish({
              ...outcome,
              roundTrip: Array.isArray(answer?.agents),
              agents: answer?.agents?.length,
            }),
          )
          .catch((error: Error) => finish({ ...outcome, roundTrip: false, error: error.message }));
      },
      onConnectError: (error: Error & { details?: Record<string, unknown>; code?: string }) =>
        finish({ outcome: "refused", message: error.message, code: error.code }),
    });
    client.start();
    setTimeout(() => finish({ outcome: "no answer in 20 s" }), 20_000);
  });
}

function redacted(value: Record<string, unknown>): Record<string, unknown> {
  return {
    ...value,
    message:
      typeof value.message === "string"
        ? value.message.replace(/requestId: [^)]+/, "requestId: …")
        : value.message,
  };
}
