// Probes behind docs/research/setup-flow.md, sections 2.1 and 2.2. Research code, not a check.
//
//   pnpm dev-gateway start --instance <name> --default-local-pairing --no-seed
//   node docs/research/setup-flow/approve-probe.ts <experiment> --instance <name>
//
// It acts only on a named development instance this checkout started with
// `--default-local-pairing`, and runs `openclaw` only through the tool's guarded
// runner (so always with `--profile clawtrate-dev-<name>`). It never prints a
// token or a public key: every line it prints passes through `redact`.
//
// Experiments:
//   approve    this project's client pairs read-only and asks for the
//              interactive tier; the pending entry is printed field by field;
//              `devices approve <id> --json` approves it; the device's record
//              is read back; the same id is approved again (stale), and an id
//              that was never pending (premature)
//   supersede  the client asks for the interactive tier, then for admin; the
//              first id is approved (superseded); the second is rejected
//   exec       a new bot gets `tools.exec.mode` "ask", then "full", through
//              `config.patch`; each is read back with `config.get` and the
//              effective policy of `openclaw approvals get --json`
//   stricter   with a bot at "full", the gateway host's approvals file asks on a
//              miss; the effective policy is read; the file is restored
//   list       `agents.list` at operator.read: each bot's `defaultPermissionMode`
//   exact      the candidates for an exact-id approval with no fallback and the
//              profile's own credentials: `gateway call device.pair.approve
//              --expect-url`, and `devices approve --url` with no token
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ClawtrateClient } from "../../../packages/core/src/client.ts";
import { createNodeHost } from "../../../packages/core/src/node/index.ts";
import { openInstance, readDevConnection, recordedStartOptions } from "../../../tools/dev-gateway/src/cli.ts";
import { parseJsonOutput } from "../../../tools/dev-gateway/src/env.ts";
import { OperatorSession } from "../../../tools/dev-gateway/src/operator.ts";

const { values, positionals } = parseArgs({ args: process.argv.slice(2), options: { instance: { type: "string" } }, allowPositionals: true });
if (!values.instance) throw new Error("--instance required");
const inst = openInstance(values.instance);
if (!recordedStartOptions(inst).defaultLocalPairing) throw new Error("not --default-local-pairing");
const connection = readDevConnection(inst.connectionFile)!;
const url = connection.url;
const secrets = [connection.token];
const redact = (t: string) => {
  let o = t;
  for (const s of secrets) if (s && s.length >= 8) o = o.split(s).join("<redacted>");
  return o.replace(/("(?:token|deviceToken|bootstrapToken|setupCode|publicKey)"\s*:\s*")[^"]+/g, "$1<redacted>");
};
const say = (...p: unknown[]) => console.log(redact(p.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const run = (args: string[]) => {
  const r = inst.runner.runSync(args);
  return { status: r.status, out: `${r.stdout}`, err: `${r.stderr}` };
};
const list = () => parseJsonOutput<{ pending?: any[]; paired?: any[] }>(run(["devices", "list", "--json"]).out);
const settle = async (done: () => boolean, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end && !done()) await sleep(100);
};
const pick = (d: any) => {
  const { tokens, publicKey, ...rest } = d ?? {};
  return { ...rest, publicKey: publicKey ? "<present>" : undefined, tokens: tokens ? (Array.isArray(tokens) ? tokens.map((t: any) => ({ role: t.role, scopes: t.scopes, revokedAtMs: t.revokedAtMs })) : Object.keys(tokens)) : undefined };
};

async function pairedClient() {
  const dataDir = mkdtempSync(join(tmpdir(), "addenda-"));
  process.on("exit", () => rmSync(dataDir, { recursive: true, force: true }));
  const client = new ClawtrateClient(createNodeHost({ dataDir, client: { displayName: "Clawtrate Desktop", version: "0.0.0-research", platform: process.platform } }), { reconnect: { initialMs: 500, maxMs: 2000 } });
  await client.start();
  await client.connect({ url, token: connection.token });
  await settle(() => client.state.connection.status === "connected");
  await settle(() => client.state.connection.deviceId != null || client.state.connection.gatewayId != null, 3000);
  return client;
}
const upgradeOf = (c: any) => ({ status: c.state.connection.upgrade.status, requestId: c.state.connection.upgrade.requestId, scopes: c.state.connection.upgrade.scopes });

async function approve() {
  const client = await pairedClient();
  say("connected:", { status: client.state.connection.status, scopes: client.state.connection.scopes });
  const me = list().paired?.find((d: any) => d.displayName === "Clawtrate Desktop" && (d.scopes ?? []).length === 1);
  say("my record before:", pick(me));
  // Premature: an id that is not pending (the device has asked for nothing yet).
  const fake = "00000000-0000-4000-8000-000000000000";
  const pre = run(["devices", "approve", fake, "--json"]);
  say(`premature approve of a non-pending id: exit ${pre.status}`, pre.out.trim().slice(0, 300), pre.err.trim().slice(0, 300));
  void client.requestAccess("interactive").catch((e: unknown) => say("requestAccess:", String(e)));
  await settle(() => client.state.connection.upgrade.status === "pending", 10000);
  say("asked:", upgradeOf(client));
  const id = client.state.connection.upgrade.requestId;
  const pending = list().pending?.find((p: any) => p.requestId === id);
  say("pending entry, every field:", pick(pending));
  say("pending keys:", Object.keys(pending ?? {}).sort());
  const a = run(["devices", "approve", id, "--json"]);
  say(`approve ${id} --json: exit ${a.status}`);
  say("stdout:", a.out.trim().slice(0, 1500));
  if (a.err.trim()) say("stderr:", a.err.trim().slice(0, 400));
  await settle(() => client.state.connection.canWrite, 15000);
  const after = list().paired?.find((d: any) => d.deviceId === pending?.deviceId);
  say("my record after:", pick(after));
  say("client after:", { scopes: client.state.connection.scopes, upgrade: client.state.connection.upgrade.status });
  const again = run(["devices", "approve", id, "--json"]);
  say(`stale: approve the same id again: exit ${again.status}`, again.out.trim().slice(0, 300), again.err.trim().slice(0, 300));
  client.stop();
}

async function supersede() {
  const client = await pairedClient();
  void client.requestAccess("interactive").catch(() => {});
  await settle(() => client.state.connection.upgrade.status === "pending", 10000);
  const first = upgradeOf(client);
  say("first request:", first);
  void client.requestAccess("admin").catch(() => {});
  await settle(() => client.state.connection.upgrade.requestId !== first.requestId && client.state.connection.upgrade.status === "pending", 10000);
  const second = upgradeOf(client);
  say("second request:", second);
  const pend = list().pending?.filter((p: any) => p.deviceId === list().pending?.find((q: any) => q.requestId === second.requestId)?.deviceId);
  say("pending for this device:", pend?.map((p: any) => ({ requestId: p.requestId, scopes: p.scopes, clientId: p.clientId })));
  const old = run(["devices", "approve", first.requestId, "--json"]);
  say(`approve the superseded id: exit ${old.status}`, old.out.trim().slice(0, 400), old.err.trim().slice(0, 400));
  const dev = list();
  say("still pending:", dev.pending?.map((p: any) => ({ requestId: p.requestId, scopes: p.scopes })));
  // Leave it pending, then reject it, so the instance is tidy.
  const rej = run(["devices", "reject", second.requestId, "--json"]);
  say(`reject the current request: exit ${rej.status}`);
  client.stop();
}

async function exec() {
  const op = await OperatorSession.open({
    url, token: connection.token, displayName: "Clawtrate probe",
    scopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals"], caps: [],
    approvePairing: async (requestId: string) => { const r = run(["devices", "approve", requestId]); if (r.status !== 0) throw new Error(`approve failed ${r.status}`); },
  });
  const effective = (agent: string) => {
    const snap = parseJsonOutput<any>(run(["approvals", "get", "--json"]).out);
    return (snap.effectivePolicy?.scopes ?? []).filter((s: any) => s.agentId === agent).map((s: any) => ({ agentId: s.agentId, mode: s.mode?.effective, security: s.security?.effective, ask: s.ask?.effective, askFallback: s.askFallback?.effective }));
  };
  const cfgMode = async (agent: string) => {
    const got: any = await op.request("config.get", {});
    const cfg = got?.config ?? got?.parsed ?? {};
    return { hash: got?.hash, mode: cfg?.agents?.entries?.[agent]?.tools?.exec?.mode, global: cfg?.tools?.exec?.mode, keys: Object.keys(got ?? {}) };
  };
  const created: any = await op.request("agents.create", { name: "Probe Ask", model: "scripted/dev-1" });
  const bot = created?.agentId;
  say("agents.create:", { agentId: bot });
  say("before any write:", await cfgMode(bot), effective(bot));
  for (const mode of ["ask", "full"]) {
    const before: any = await op.request("config.get", {});
    await op.request("config.patch", { raw: JSON.stringify({ agents: { entries: { [bot]: { tools: { exec: { mode } } } } } }), baseHash: before.hash });
    await sleep(1500);
    say(`after writing ${mode}:`, await cfgMode(bot), effective(bot));
  }
  say("the other bots are unchanged:", effective("otto"), effective("main"));
  const del: any = await op.request("agents.delete", { agentId: bot }).catch((e: unknown) => String(e));
  say("agents.delete:", del);
  await op.close();
}

async function stricter() {
  const op = await OperatorSession.open({
    url, token: connection.token, displayName: "Clawtrate probe",
    scopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals"], caps: [],
    approvePairing: async (requestId: string) => { const r = run(["devices", "approve", requestId]); if (r.status !== 0) throw new Error(`approve failed ${r.status}`); },
  });
  const eff = (agent: string) => (parseJsonOutput<any>(run(["approvals", "get", "--json"]).out).effectivePolicy?.scopes ?? []).filter((s: any) => s.agentId === agent).map((s: any) => ({ agentId: s.agentId, mode: s.mode?.effective, security: s.security?.effective, ask: s.ask?.effective, sources: { security: s.security?.source, ask: s.ask?.source } }));
  const got: any = await op.request("config.get", {});
  const bots = Object.keys(got?.config?.agents?.entries ?? {});
  say("bots in config:", bots);
  let bot = bots.find((b) => b === "probe-ask");
  if (!bot) {
    const c: any = await op.request("agents.create", { name: "Probe Ask", model: "scripted/dev-1" });
    bot = c.agentId;
    const g: any = await op.request("config.get", {});
    await op.request("config.patch", { raw: JSON.stringify({ agents: { entries: { [bot!]: { tools: { exec: { mode: "full" } } } } } }), baseHash: g.hash });
    await sleep(1500);
  }
  say("full, before tightening:", eff(bot!));
  const ap: any = await op.request("exec.approvals.get", {});
  say("exec.approvals.get keys:", Object.keys(ap ?? {}), "defaults:", ap?.file?.defaults, "resolvedDefaults:", ap?.resolvedDefaults);
  const file = { ...(ap?.file ?? { version: 1 }), defaults: { ...(ap?.file?.defaults ?? {}), security: "allowlist", ask: "on-miss" } };
  await op.request("exec.approvals.set", { file, baseHash: ap.hash });
  await sleep(500);
  say("after the host file asks on a miss:", eff(bot!));
  const ap2: any = await op.request("exec.approvals.get", {});
  await op.request("exec.approvals.set", { file: { ...(ap2.file), defaults: ap?.file?.defaults ?? {} }, baseHash: ap2.hash });
  await sleep(500);
  say("host file restored:", eff(bot!));
  await op.close();
}

async function listBots() {
  const op = await OperatorSession.open({
    url, token: connection.token, displayName: "Clawtrate probe", scopes: ["operator.read"], caps: [],
    approvePairing: async (requestId: string) => { const r = run(["devices", "approve", requestId]); if (r.status !== 0) throw new Error(`approve failed ${r.status}`); },
  });
  const l: any = await op.request("agents.list", {});
  say("agents.list:", { defaultId: l.defaultId, agents: (l.agents ?? []).map((a: any) => ({ id: a.id, defaultPermissionMode: a.defaultPermissionMode })) });
  await op.close();
}

// Is there an exact-id approval with no fallback that uses the profile's own
// credentials? Each candidate runs against one live interactive-tier request.
async function exact() {
  const client = await pairedClient();
  void client.requestAccess("interactive").catch(() => {});
  await settle(() => client.state.connection.upgrade.status === "pending", 10000);
  const id = client.state.connection.upgrade.requestId;
  say("request:", upgradeOf(client));
  const show = (label: string, r: { status: number | null; out: string; err: string }) =>
    say(`${label}: exit ${r.status}`, { stdout: r.out.trim().slice(0, 600), stderr: r.err.trim().slice(0, 600) });
  show("gateway call gateway.identity.get --expect-url", run(["gateway", "call", "gateway.identity.get", "--expect-url", url, "--json"]));
  show("gateway call device.pair.list --expect-url", run(["gateway", "call", "device.pair.list", "--expect-url", url, "--json"]));
  show("gateway call device.pair.approve --expect-url", run(["gateway", "call", "device.pair.approve", "--params", JSON.stringify({ requestId: id }), "--expect-url", url, "--json"]));
  show("devices approve --url, no token", run(["devices", "approve", id, "--url", url, "--json"]));
  const still = list().pending?.find((p: any) => p.requestId === id);
  say("still pending after the candidates:", Boolean(still), still ? { scopes: still.scopes } : null);
  const rej = run(["devices", "reject", id, "--json"]);
  say(`reject: exit ${rej.status}`);
  client.stop();
}

const exp = positionals[0];
if (exp === "approve") await approve();
else if (exp === "supersede") await supersede();
else if (exp === "exec") await exec();
else if (exp === "stricter") await stricter();
else if (exp === "list") await listBots();
else if (exp === "exact") await exact();
else throw new Error("experiment?");
process.exit(0);
