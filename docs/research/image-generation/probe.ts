// The probe behind docs/research/image-generation.md, for the facts the image
// checks (tools/dev-gateway/src/image-checks.ts) do not assert. Run it against
// a named development instance of your own started with `--with-images`:
//
//   pnpm dev-gateway start --instance pictures --with-images --no-seed
//   node docs/research/image-generation/probe.ts pictures [tools|invoke|avatar|expiry]...
//   pnpm dev-gateway reset --instance pictures
//
// Each step prints what the gateway answered, as JSON, with the instance's
// state folder shortened to <state>. `expiry` waits for a download ticket to
// expire (about five minutes). Nothing here leaves loopback.

import { openInstance, openOperator } from "../../../tools/dev-gateway/src/cli.ts";
import { provenEndpoint } from "../../../tools/dev-gateway/src/endpoint.ts";
import { readRunRecord } from "../../../tools/dev-gateway/src/state-guard.ts";
import { IMAGE_PROMPT } from "../../../tools/dev-gateway/src/scenarios.ts";
import { outcomeMarker } from "../../../tools/dev-gateway/src/scripted-images.ts";

type JsonRecord = Record<string, unknown>;
const [name, ...steps] = process.argv.slice(2);
if (!name) throw new Error("usage: probe.ts <instance> [tools|invoke|avatar|expiry]...");
const inst = openInstance(name);
const run = readRunRecord(inst.runFile);
if (!run) throw new Error(`instance ${name} has no run file; start it first`);
const expectedRunId = run.runId;

function currentConnection() {
  const endpoint = provenEndpoint({
    instance: inst.name,
    home: inst.home,
    runDir: inst.runDir,
    checkout: inst.checkout,
    identify: inst.identify,
    expectedRunId,
  });
  if ("refusal" in endpoint) throw new Error(`instance ${name}: ${endpoint.refusal}`);
  return endpoint;
}
const connection = currentConnection();
const origin = connection.url.replace("ws://", "http://");

function sameConnection() {
  const current = currentConnection();
  if (current.url !== connection.url || current.token !== connection.token) {
    throw new Error(`instance ${name}: the development gateway connection changed`);
  }
  return current;
}

function gatewayAddress(address: string): URL {
  const url = new URL(address, origin);
  if (url.protocol !== "http:" || url.origin !== origin || url.username || url.password) {
    throw new Error("the probe requires a URL on the proven development gateway");
  }
  return url;
}

function gatewayFetch(address: string, init?: RequestInit): Promise<Response> {
  sameConnection();
  return fetch(gatewayAddress(address), { ...init, redirect: "error" });
}

const print = (label: string, value: unknown) =>
  console.log(`${label}: ${JSON.stringify(value).replaceAll(inst.stateDir, "<state>")}`);
const attempt = (promise: Promise<unknown>) =>
  promise.catch((error: unknown) => ({ refused: String(error) }));

const probeOperator = (label: string, scopes: string[], caps: string[]) =>
  openOperator(inst, label, scopes, caps, sameConnection);
const writer = await probeOperator("Clawtrate image probe", ["operator.read", "operator.write"], ["tool-events"]);
const stamp = Date.now().toString(36);

/** A new task of Juniper's that has run `#image`, and its picture's artifact once it is there. */
async function taskWithPicture(tag: string) {
  const key = `agent:main:probe-${tag}-${stamp}`;
  const sent = (await writer.send(key, "#image")) as JsonRecord;
  await writer.terminal(String(sent.runId), 120_000);
  for (let i = 0; i < 60; i += 1) {
    const listed = (await writer.request("artifacts.list", { sessionKey: key, messageRole: "assistant" })) as JsonRecord;
    const [artifact] = (listed.artifacts as JsonRecord[]) ?? [];
    if (artifact) return { key, artifact };
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`no picture arrived in ${key}`);
}

const invoke = (sessionKey: string, args: JsonRecord, op = writer) =>
  attempt(op.request("tools.invoke", { name: "image_generate", args, sessionKey }, 120_000));

for (const step of steps) {
  sameConnection();
  if (step === "tools") {
    const key = `agent:main:probe-tools-${stamp}`;
    const sent = (await writer.send(key, "#text")) as JsonRecord;
    await writer.terminal(String(sent.runId), 120_000);
    const catalog = (await writer.request("tools.catalog", { agentId: "main" })) as { groups: { id: string; tools: JsonRecord[] }[] };
    print("tools.catalog", catalog.groups.flatMap((g) => g.tools.filter((t) => t.id === "image_generate").map((t) => ({ group: g.id, ...t }))));
    const effective = (await writer.request("tools.effective", { agentId: "main", sessionKey: key })) as { toolAccess: { tools: JsonRecord[] } };
    print("tools.effective", effective.toolAccess.tools.find((t) => t.id === "image_generate"));
  }
  if (step === "invoke") {
    const never = `agent:main:probe-invoke-${stamp}`;
    const foreground = (await invoke(never, { prompt: IMAGE_PROMPT })) as JsonRecord;
    print("invoke, a key never created", foreground);
    // The foreground file, over the gateway's assistant media route.
    const path = String(((rec(rec(foreground.output).details).paths as string[]) ?? [])[0]);
    const route = `${origin}/__openclaw__/assistant-media?source=${encodeURIComponent(path)}`;
    const bearer = { authorization: `Bearer ${connection.token}` };
    const served = await gatewayFetch(route, { headers: bearer });
    print("assistant media route", {
      withoutToken: (await gatewayFetch(route)).status,
      withToken: served.status,
      type: served.headers.get("content-type"),
      bytes: (await served.arrayBuffer()).byteLength,
    });
    const meta = (await (await gatewayFetch(`${route}&meta=1`, { headers: bearer })).json()) as JsonRecord;
    const ticketed = await gatewayFetch(`${route}&mediaTicket=${encodeURIComponent(String(meta.mediaTicket))}`);
    print("assistant media route, meta=1", { ...meta, mediaTicket: typeof meta.mediaTicket, ticketWithoutToken: ticketed.status });
    print("the never-created task's history", ((await writer.request("chat.history", { sessionKey: never, limit: 5 })) as JsonRecord).messages);
    // A task bound to a saved session, with no messages yet.
    const created = `agent:main:probe-created-${stamp}`;
    await writer.request("sessions.create", { key: created, agentId: "main" });
    print("invoke, a task made with sessions.create", await invoke(created, { prompt: IMAGE_PROMPT }));
    print("invoke, action list", await invoke(`agent:main:probe-invoke-${stamp}`, { action: "list" }));
    for (const outcome of ["refuse", "fail", "hang"] as const) {
      const started = Date.now();
      const answer = await invoke(`agent:main:probe-invoke-${outcome}-${stamp}`, {
        prompt: `${IMAGE_PROMPT} ${outcomeMarker(outcome)}`,
        ...(outcome === "hang" ? { timeoutMs: 5000 } : {}),
      });
      print(`invoke, ${outcome} (${Date.now() - started} ms)`, answer);
    }
    const { key } = await taskWithPicture("invoke-history");
    print("invoke, the same prompt on a task with history", await invoke(key, { prompt: IMAGE_PROMPT }));
    print("invoke, a new prompt on a task with history", await invoke(key, { prompt: "A green hill under a sun" }));
    const reader = await probeOperator("Clawtrate image probe (reader)", ["operator.read"], []);
    print("invoke, read only", await invoke(key, { prompt: IMAGE_PROMPT }, reader));
    await reader.close();
  }
  if (step === "avatar" || step === "expiry") {
    const admin = await probeOperator("Clawtrate image probe (admin)", ["operator.admin"], []);
    const { key, artifact } = await taskWithPicture(step);
    const download = (await writer.request("artifacts.download", { sessionKey: key, artifactId: artifact.id })) as JsonRecord;
    const ticket = gatewayAddress(String(download.url));
    const bytes = Buffer.from(await (await gatewayFetch(ticket.href)).arrayBuffer());
    const invoked = (await invoke(`agent:main:probe-path-${stamp}`, { prompt: IMAGE_PROMPT })) as JsonRecord;
    const path = String(((rec(rec(invoked.output).details).paths as string[]) ?? [])[0]);
    const sources: Record<string, string> =
      step === "avatar"
        ? {
            "the downloaded bytes as a data: URL": `data:image/png;base64,${bytes.toString("base64")}`,
            "the path tools.invoke named": path,
            "the gateway's media path": ticket.pathname,
            "the ticketed address": ticket.href,
          }
        : { "the ticketed address": ticket.href };
    if (step === "avatar") {
      // Saved, and shown only up to the gateway's encoded-length limit for a data URL.
      for (const decoded of [2_097_152, 2_098_176]) {
        sources[`a data URL labelled image/png with ${decoded} decoded bytes`] = `data:image/png;base64,${Buffer.alloc(decoded, 7).toString("base64")}`;
      }
    }
    for (const [label, avatar] of Object.entries(sources)) {
      const updated = await attempt(admin.request("agents.update", { agentId: "marlow", avatar }));
      const readBack = await pictureOf(admin);
      const saved = await pictureOf(admin, "avatar");
      print(`avatar from ${label}`, { sent: avatar.length, updated, saved: saved === avatar, shown: readBack.length, same: readBack === avatar });
    }
    print("agents.update with write only", await attempt(writer.request("agents.update", { agentId: "marlow", avatar: "data:image/png;base64,AA==" })));
    if (step === "expiry") {
      const wait = Date.parse(String(download.expiresAt)) - Date.now() + 20_000;
      await new Promise((resolve) => setTimeout(resolve, wait));
      const stored = await pictureOf(admin);
      print("after the ticket expired", { stillStored: stored === ticket.href, fetched: (await gatewayFetch(stored)).status });
      const again = (await writer.request("artifacts.download", { sessionKey: key, artifactId: artifact.id })) as JsonRecord;
      print("a new download after the expiry", { fetched: (await gatewayFetch(String(again.url))).status });
    }
    await admin.close();
  }
}
await writer.close();
process.exit(0);

function rec(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" ? (value as JsonRecord) : {};
}

/** Marlow's picture as `agents.list` shows it (`avatarUrl`), or as it was saved (`avatar`). */
async function pictureOf(
  admin: Awaited<ReturnType<typeof openOperator>>,
  field: "avatarUrl" | "avatar" = "avatarUrl",
): Promise<string> {
  const agents = ((await admin.request("agents.list", {})) as { agents: JsonRecord[] }).agents;
  return String(rec(agents.find((agent) => agent.id === "marlow")?.identity)[field] ?? "");
}
