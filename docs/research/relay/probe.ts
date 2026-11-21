// Probes behind docs/research/relay.md. Research code, not a check.
//
//   pnpm dev-gateway start --instance <name> --default-local-pairing --trust-loopback-proxy --no-seed
//   node docs/research/relay/probe.ts <experiment> --instance <name> [--approve]
//
// It puts a stand-in relay connector between this project's client and a
// development gateway: a loopback proxy on the gateway's computer that
// forwards each WebSocket upgrade to the gateway, as a connector would, and
// reports what the gateway did with the connection: paired it silently, made
// it wait for approval, or refused it.
//
// It acts only on a named development instance this checkout started with
// `--default-local-pairing`, so a silent local pairing is possible at all, and
// reads that instance's address and token from the tool's own run files. It
// runs `openclaw` only through the tool's guarded runner (so always with
// `--profile clawtrate-dev-<name>`). Every line it prints passes through
// `redact`. The scratch client folders it makes are removed when it ends.
//
// Experiments:
//   desktop   this project's client connects straight to the gateway's port
//             with the shared token, as the desktop app does on its own computer
//   plain     through the connector, which forwards the upgrade unchanged
//   host      through the connector, which rewrites Host to a relay's name
//             and adds no forwarded headers
//   xff       through the connector, which rewrites Host and adds
//             X-Forwarded-For (a documentation address), -Proto and -Host;
//             with --approve, `devices approve <requestId>` on the gateway's
//             computer, then the client's next retry
//   xff-loopback  as xff, with X-Forwarded-For naming a loopback address
//   code      `openclaw qr --json --limited --url wss://<relay name>`, then a new
//             device redeems the code through the xff connector asking for
//             operator.read; with --approve, the same approval

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createHash, generateKeyPairSync, createPublicKey, createPrivateKey, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ClawtrateClient } from "../../../packages/core/src/client.ts";
import { createNodeHost } from "../../../packages/core/src/node/index.ts";
import { openInstance, readDevConnection, recordedStartOptions } from "../../../tools/dev-gateway/src/cli.ts";
import { parseJsonOutput } from "../../../tools/dev-gateway/src/env.ts";

// The pinned client, from the development tool's own dependencies.
const requireFromTool = createRequire(new URL("../../../tools/dev-gateway/package.json", import.meta.url));
const { GatewayClient } = (await import(
  pathToFileURL(requireFromTool.resolve("@openclaw/gateway-client")).href
)) as typeof import("@openclaw/gateway-client");

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    instance: { type: "string" },
    approve: { type: "boolean", default: false },
  },
  allowPositionals: true,
});
const experiment = positionals[0];
if (!values.instance) throw new Error("--instance <name> is required; the default instance is never probed");
const inst = openInstance(values.instance);
const startOptions = recordedStartOptions(inst);
if (!startOptions.defaultLocalPairing) {
  throw new Error(`instance "${values.instance}" was not started with --default-local-pairing`);
}
const connection = readDevConnection(inst.connectionFile);
if (!connection || connection.instance !== values.instance) throw new Error("no connection record for this instance");
const gatewayPort = Number(new URL(connection.url).port);

/** A relay's public name, from the reserved `.example` domain. */
const RELAY_HOST = "gw-0123abcd.relay.example";
/** The phone's address as a relay would see it, from the documentation range (RFC 5737). */
const PHONE_IP = "203.0.113.7";

const secrets: string[] = [connection.token];
const redact = (text: string) => {
  let out = text;
  for (const secret of secrets) if (secret && secret.length >= 8) out = out.split(secret).join("<redacted>");
  return out.replace(/("(?:token|deviceToken|bootstrapToken|setupCode)"\s*:\s*")[^"]+/g, "$1<redacted>");
};
const say = (...parts: unknown[]) =>
  console.log(redact(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const scratch = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

function runOpenclaw(args: string[]) {
  const result = inst.runner.runSync(args);
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

function devices() {
  const { status, out } = runOpenclaw(["devices", "list", "--json"]);
  if (status !== 0) return { error: out.slice(0, 400) };
  const parsed = parseJsonOutput<{ pending?: Record<string, unknown>[]; paired?: Record<string, unknown>[] }>(out);
  const pick = (d: Record<string, unknown>) => ({
    deviceId: String(d.deviceId ?? "").slice(0, 12),
    requestId: d.requestId,
    displayName: d.displayName,
    roles: d.roles,
    scopes: d.scopes,
    approvedVia: d.approvedVia,
    remoteIp: d.remoteIp,
  });
  return { pending: (parsed.pending ?? []).map(pick), paired: (parsed.paired ?? []).map(pick) };
}

/** The gateway log's lines about proxies, locality and pairing written since `from` bytes. */
const gatewayLog = join(inst.runDir, "gateway.log");
const logSize = () => statSync(gatewayLog).size;
function logSince(from: number) {
  return readFileSync(gatewayLog)
    .subarray(from)
    .toString("utf8")
    .split("\n")
    .filter((line) => /proxy|Host header|remote|pairing|trusted|unattributable/i.test(line))
    .map((line) => line.slice(0, 300));
}

type Mode = "plain" | "host" | "xff" | "xff-loopback";

/** The stand-in connector: forwards one upgrade per client socket to the gateway's loopback port. */
async function connector(mode: Mode) {
  const server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  const answers: number[] = [];
  server.on("upgrade", (req, socket, head) => {
    const upstream = netConnect(gatewayPort, "127.0.0.1", () => {
      const headers: Record<string, string | string[] | undefined> = { ...req.headers };
      if (mode !== "plain") headers.host = RELAY_HOST;
      if (mode === "xff" || mode === "xff-loopback") {
        headers["x-forwarded-for"] = mode === "xff" ? PHONE_IP : "127.0.0.1";
        headers["x-forwarded-proto"] = "https";
        headers["x-forwarded-host"] = RELAY_HOST;
      }
      const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      upstream.write(head);
      upstream.once("data", (chunk: Buffer) => {
        const status = /^HTTP\/1\.1 (\d{3})/.exec(chunk.toString("latin1"));
        if (status) answers.push(Number(status[1]));
      });
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `ws://127.0.0.1:${port}`, answers, close: () => server.close() };
}

function coreClient(dataDir: string) {
  return new ClawtrateClient(
    createNodeHost({
      dataDir,
      client: { displayName: "Clawtrate Desktop", version: "0.0.0-research", platform: process.platform },
    }),
    { reconnect: { initialMs: 500, maxMs: 2000 } },
  );
}

async function settle(done: () => boolean, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !done()) await sleep(100);
}

function summary(client: ClawtrateClient) {
  const c = client.state.connection;
  return {
    status: c.status,
    scopes: c.scopes,
    paired: c.paired,
    pairing: c.pairing && { requestId: c.pairing.requestId, requestedScopes: c.pairing.requestedScopes },
    error: c.error && { code: c.error.code, message: c.error.message },
    gatewayId: c.gatewayId?.slice(0, 12) ?? null,
  };
}

function approve(requestId: string) {
  const approved = runOpenclaw(["devices", "approve", requestId]);
  say(`devices approve ${requestId}: exit ${approved.status}`);
}

/** This project's client, with the shared token, straight to the gateway or through the connector. */
async function connectWith(mode: Mode | "desktop") {
  const from = logSize();
  const relay = mode === "desktop" ? null : await connector(mode);
  const url = relay?.url ?? `ws://127.0.0.1:${gatewayPort}`;
  const client = coreClient(scratch("relay-probe-"));
  await client.start();
  say(`[${mode}] trustedProxies set: ${Boolean(startOptions.trustLoopbackProxy)}; connect ${url}${relay ? ` (connector -> 127.0.0.1:${gatewayPort})` : ""} with the shared token`);
  await client.connect({ url, token: connection!.token });
  await settle(() => ["connected", "pairing", "error"].includes(client.state.connection.status), 12_000);
  await settle(() => client.state.connection.gatewayId !== null || client.state.connection.status !== "connected", 4000);
  if (relay) say(`[${mode}] upgrade answers the connector saw:`, relay.answers);
  say(`[${mode}] core client:`, summary(client));
  say(`[${mode}] gateway devices:`, devices());
  const requestId = client.state.connection.pairing?.requestId;
  if (values.approve && requestId) {
    approve(requestId);
    await settle(() => client.state.connection.status === "connected" && client.state.connection.gatewayId !== null, 15_000);
    say(`[${mode}] after approval:`, summary(client));
    say(`[${mode}] gateway devices:`, devices());
  }
  say(`[${mode}] gateway log:`, logSince(from));
  client.stop();
  relay?.close();
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

/** One connect with a bootstrap token, as a phone would make through the relay. */
function redeem(url: string, bootstrapToken: string, device: ReturnType<typeof identity>, tokens: Record<string, unknown>) {
  return new Promise<Record<string, unknown>>((resolve) => {
    let finished = false;
    const finish = (value: Record<string, unknown>) => {
      if (finished) return;
      finished = true;
      void client.stopAndWait().catch(() => {});
      resolve(value);
    };
    const client = new GatewayClient({
      url,
      bootstrapToken,
      clientName: "gateway-client",
      mode: "ui",
      clientDisplayName: "Clawtrate relay research phone",
      clientVersion: "0.0.0-research",
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
          createPublicKey(pem).export({ type: "spki", format: "der" }).subarray(-32).toString("base64url"),
        loadDeviceAuthToken: ({ deviceId, role }: { deviceId: string; role: string }) => tokens[`${deviceId}:${role}`],
        storeDeviceAuthToken: (rec: { deviceId: string; role: string; token: string }) => {
          secrets.push(rec.token);
          tokens[`${rec.deviceId}:${rec.role}`] = rec;
        },
        clearDeviceAuthToken: ({ deviceId, role }: { deviceId: string; role: string }) => delete tokens[`${deviceId}:${role}`],
      },
      onHelloOk: (hello: { auth?: { role?: string; scopes?: string[]; deviceToken?: string } }) => {
        if (hello.auth?.deviceToken) secrets.push(hello.auth.deviceToken);
        finish({ outcome: "hello", role: hello.auth?.role, scopes: hello.auth?.scopes, deviceToken: Boolean(hello.auth?.deviceToken) });
      },
      onConnectError: (error: Error & { details?: Record<string, unknown>; code?: string }) =>
        finish({ outcome: "refused", message: error.message, code: error.code, details: error.details }),
    } as never);
    client.start();
    setTimeout(() => finish({ outcome: "no answer in 15 s" }), 15_000);
  });
}

async function code() {
  const from = logSize();
  const args = ["qr", "--json", "--limited", "--url", `wss://${RELAY_HOST}`];
  const { status, out } = runOpenclaw(args);
  say(`openclaw ${args.join(" ")}: exit ${status}`);
  if (status !== 0) return say(out.slice(0, 600));
  const result = parseJsonOutput<Record<string, unknown> & { setupCode: string }>(out);
  secrets.push(result.setupCode);
  const payload = JSON.parse(Buffer.from(result.setupCode, "base64url").toString("utf8")) as Record<string, unknown> & {
    bootstrapToken: string;
  };
  secrets.push(payload.bootstrapToken);
  say("result:", { access: result.access, urlSource: result.urlSource }, "payload url:", payload.url);
  const relay = await connector("xff");
  const device = identity();
  const tokens: Record<string, unknown> = {};
  const first = await redeem(relay.url, payload.bootstrapToken, device, tokens);
  say("[code via xff connector] first connect, asking for operator.read:", first);
  const listed = devices();
  say("[code via xff connector] gateway devices:", listed);
  const pending = "pending" in listed ? listed.pending.find((d) => d.deviceId === device.deviceId.slice(0, 12)) : undefined;
  if (values.approve && typeof pending?.requestId === "string") {
    approve(pending.requestId);
    say("[code via xff connector] the same device connects again:", await redeem(relay.url, payload.bootstrapToken, device, tokens));
    say("[code via xff connector] gateway devices:", devices());
  }
  say("[code] gateway log:", logSince(from));
  relay.close();
}

const experiments: Record<string, () => Promise<unknown>> = {
  desktop: () => connectWith("desktop"),
  plain: () => connectWith("plain"),
  host: () => connectWith("host"),
  xff: () => connectWith("xff"),
  "xff-loopback": () => connectWith("xff-loopback"),
  code,
};
if (!experiment || !experiments[experiment]) {
  console.log(`usage: probe.ts <${Object.keys(experiments).join("|")}> --instance <name> [--approve]`);
  process.exit(1);
}
await experiments[experiment]!();
setTimeout(() => process.exit(0), 300);
