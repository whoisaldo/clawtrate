// Shared set-up for client tests: a gateway that grants what a paired device
// asks for, and a client with one task open.

import { ClawtrateClient, type ClientOptions } from "../src/client.ts";
import type { KeyValueStore } from "../src/host.ts";
import { INTERACTIVE_SCOPES } from "../src/scopes.ts";
import { FakeGateway, helloOk, memoryStorage, testHost, tokenKey, until } from "./fake-gateway.ts";

export const URL_A = "ws://127.0.0.1:19001";
export const URL_B = "ws://127.0.0.1:19002";
export const KEY = "agent:otto:disk-space";
export const FAST: ClientOptions = { reconnect: { initialMs: 20, maxMs: 40 } };

type ConnectParams = { scopes: string[]; auth?: { deviceToken?: string } };

export function grantingGateway(): FakeGateway {
  const gateway = new FakeGateway();
  gateway.connectReply = (params) => {
    const { scopes, auth } = params as ConnectParams;
    return { ok: true, payload: helloOk(scopes, auth?.deviceToken ?? "device-token") };
  };
  let run = 0;
  gateway.handlers["chat.send"] = () => ({ runId: `run-${(run += 1)}`, status: "started" });
  gateway.handlers["chat.abort"] = () => ({ ok: true, aborted: true, runIds: [] });
  gateway.handlers["question.list"] = () => ({ questions: [] });
  for (const method of ["exec.approval.list", "plugin.approval.list", "openclaw.approval.list"]) {
    gateway.handlers[method] = () => [];
  }
  return gateway;
}

export async function openTask(
  options: {
    gateway?: FakeGateway;
    held?: readonly string[];
    storage?: KeyValueStore & { data: Map<string, string> };
    client?: ClientOptions;
    key?: string;
  } = {},
) {
  const gateway = options.gateway ?? grantingGateway();
  const held = options.held ?? INTERACTIVE_SCOPES;
  const storage =
    options.storage ??
    memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: null, address: true }),
      [tokenKey(URL_A)]: JSON.stringify({
        token: "device-token",
        grantedScopes: held,
        heldScopes: held,
      }),
    });
  const client = new ClawtrateClient(testHost(gateway, storage), { ...FAST, ...options.client });
  await client.start();
  await until(() => client.state.discovery.status === "ready");
  const key = options.key ?? KEY;
  client.openSession(key);
  await until(() => client.state.transcripts[key]?.status === "ready");
  return { client, gateway, storage, transcript: () => client.state.transcripts[key]! };
}

export const agentEvent = (
  runId: string,
  seq: number,
  stream: string,
  data: Record<string, unknown>,
  sessionKey = KEY,
) => ({ runId, seq, stream, ts: 1_000 + seq, sessionKey, data });

export const questionRecord = (id: string, runId: string, sessionKey = KEY) => ({
  id,
  questions: [
    {
      questionId: "color",
      header: "Color",
      question: "Which?",
      options: [{ label: "Blue" }, { label: "Red" }],
      isOther: true,
    },
  ],
  agentId: "otto",
  sessionKey,
  runId,
  createdAtMs: 1,
  expiresAtMs: 9_000_000_000_000,
  status: "pending",
});

export const sentTexts = (gateway: FakeGateway) =>
  gateway.calls("chat.send").map((params) => (params as { message: string }).message);
