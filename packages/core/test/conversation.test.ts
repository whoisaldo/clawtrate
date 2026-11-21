// The live conversation through the client: scope step-up, sending, steering,
// questions, stopping, creating tasks and resync, against the in-memory
// gateway. Test names carry the parity rows they support.

import { describe, expect, it } from "vitest";
import { createBridgeSession } from "../src/bridge.ts";
import { APPROVAL_CAPS, CLIENT_CAPS, ClawtrateClient, SendTooLargeError } from "../src/client.ts";
import { INTERACTIVE_SCOPES, READ_SCOPES } from "../src/scopes.ts";
import {
  deferred,
  FakeGateway,
  GatewayError,
  helloOk,
  memoryStorage,
  sleep,
  testHost,
  tokenKey,
  until,
} from "./fake-gateway.ts";

const URL_A = "ws://127.0.0.1:19001";
const KEY = "agent:otto:disk-space";
const FAST = { reconnect: { initialMs: 20, maxMs: 40 } };

type ConnectParams = {
  scopes: string[];
  caps: string[];
  auth?: { token?: string; deviceToken?: string };
};

/** A gateway that grants what a paired device asks for, as one with an approved upgrade does. */
function grantingGateway() {
  const gateway = new FakeGateway();
  // A paired device keeps the token it presented; a new one is issued only at pairing.
  gateway.connectReply = (params) => {
    const { scopes, auth } = params as ConnectParams;
    return { ok: true, payload: helloOk(scopes, auth?.deviceToken ?? "device-token") };
  };
  let run = 0;
  gateway.handlers["chat.send"] = () => ({ runId: `run-${(run += 1)}`, status: "started" });
  gateway.handlers["chat.abort"] = () => ({ ok: true, aborted: true, runIds: [] });
  gateway.handlers["question.list"] = () => ({ questions: [] });
  return gateway;
}

function connectAt(gateway: FakeGateway, index: number): ConnectParams {
  return gateway.connects[index] as ConnectParams;
}

/** A client whose device already holds the given scopes, with one task open. */
async function openTask(
  options: { held?: readonly string[]; gateway?: FakeGateway; turnLimitMs?: number } = {},
) {
  const gateway = options.gateway ?? grantingGateway();
  const storage = memoryStorage({
    connection: JSON.stringify({ url: URL_A, token: null }),
    [tokenKey(URL_A)]: JSON.stringify({
      token: "device-token",
      grantedScopes: options.held ?? INTERACTIVE_SCOPES,
      heldScopes: options.held ?? INTERACTIVE_SCOPES,
    }),
  });
  const client = new ClawtrateClient(testHost(gateway, storage), {
    ...FAST,
    ...(options.turnLimitMs ? { turnLimitMs: options.turnLimitMs } : {}),
  });
  await client.start();
  await until(() => client.state.discovery.status === "ready");
  client.openSession(KEY);
  await until(() => client.state.transcripts[KEY]?.status === "ready");
  return { client, gateway, storage, transcript: () => client.state.transcripts[KEY]! };
}

const agentEvent = (runId: string, seq: number, stream: string, data: Record<string, unknown>) => ({
  runId,
  seq,
  stream,
  ts: 1_000 + seq,
  sessionKey: KEY,
  data,
});

function startRun(gateway: FakeGateway, runId = "run-x") {
  gateway.emit("agent", agentEvent(runId, 1, "lifecycle", { phase: "start" }));
}

const question = (id: string, runId: string) => ({
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
  sessionKey: KEY,
  runId,
  createdAtMs: 1,
  expiresAtMs: 900_001,
  status: "pending",
});

/** A request id in the gateway's UUID shape: only such an id goes in an approve command (setup §9). */
const UP_1 = "0d0d0d0d-0000-4000-8000-000000000001";

describe("scope step-up (B1, F-002)", () => {
  it("connects with exactly read, asks once for the interactive set, then connects with exactly that", async () => {
    const gateway = grantingGateway();
    const wait = deferred<unknown>();
    gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: UP_1 });
    gateway.handlers["device.scopes.waitUpgrade"] = () => wait.promise;
    const storage = memoryStorage();
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await client.connect({ url: URL_A, token: "bootstrap" });
    await until(() => client.state.discovery.status === "ready");
    expect(connectAt(gateway, 0).scopes).toEqual([...READ_SCOPES]);
    expect(connectAt(gateway, 0).caps).toEqual([...CLIENT_CAPS]);
    expect(CLIENT_CAPS).toEqual(["tool-events"]);
    expect(client.state.connection).toMatchObject({ canWrite: false, canAnswer: false });

    await client.requestAccess();
    await until(() => client.state.connection.upgrade.status === "pending");
    expect(gateway.calls("device.scopes.requestUpgrade")).toEqual([
      { scopes: [...INTERACTIVE_SCOPES] },
    ]);
    expect(client.state.connection.upgrade).toMatchObject({
      requestId: UP_1,
      scopes: [...INTERACTIVE_SCOPES],
      approveCommand: `openclaw devices approve ${UP_1}`,
    });
    expect(client.state.connection.upgrade.approveNote).toMatch(/gateway's computer/);

    wait.resolve({
      status: "approved",
      requestId: UP_1,
      deviceToken: "rotated-token",
      scopes: [...INTERACTIVE_SCOPES],
    });
    await until(() => client.state.connection.canWrite);
    expect(client.state.connection.upgrade.status).toBe("approved");
    expect(client.state.connection.canAnswer).toBe(true);
    const upgraded = connectAt(gateway, 1);
    expect(upgraded.scopes).toEqual([...INTERACTIVE_SCOPES]);
    // Holding operator.approvals, the connect now claims the approval caps too.
    expect(upgraded.caps).toEqual([...CLIENT_CAPS, ...APPROVAL_CAPS]);
    expect(upgraded.auth?.deviceToken ?? upgraded.auth?.token).toBe("rotated-token");
    expect(JSON.parse(storage.data.get(tokenKey(URL_A))!)).toEqual({
      token: "rotated-token",
      grantedScopes: [...INTERACTIVE_SCOPES],
      heldScopes: [...INTERACTIVE_SCOPES],
    });
    // The step-up is not reported as a resync.
    expect(Object.values(client.state.transcripts).every((t) => t.caughtUp === null)).toBe(true);

    // Later connects ask for exactly the held set, never more.
    gateway.dropAll();
    await until(() => gateway.connects.length === 3);
    expect(connectAt(gateway, 2).scopes).toEqual([...INTERACTIVE_SCOPES]);
    client.stop();
  });

  it("never asks for admin, even when the stored grant includes it", async () => {
    const gateway = grantingGateway();
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: null }),
      [tokenKey(URL_A)]: JSON.stringify({
        token: "t",
        grantedScopes: ["operator.admin"],
        heldScopes: [...INTERACTIVE_SCOPES, "operator.admin", "operator.pairing"],
      }),
    });
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await until(() => gateway.connects.length > 0);
    expect(connectAt(gateway, 0).scopes).toEqual([...INTERACTIVE_SCOPES]);
    client.stop();
  });

  it("asks on the first send, holds the message, and fails it when the request is rejected (F-075)", async () => {
    const gateway = grantingGateway();
    const wait = deferred<unknown>();
    gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-2" });
    gateway.handlers["device.scopes.waitUpgrade"] = () => wait.promise;
    const { client, transcript } = await openTask({ gateway, held: READ_SCOPES });

    const id = client.sendMessage(KEY, "Clear the cache.");
    expect(transcript().outbox[0]).toMatchObject({
      id,
      status: "awaiting-access",
      text: "Clear the cache.",
    });
    expect(transcript().runs[0]).toMatchObject({ id, state: "running" });
    await until(() => client.state.connection.upgrade.status === "pending");

    wait.resolve({ status: "rejected", requestId: "up-2" });
    await until(() => transcript().outbox[0]?.status === "failed");
    expect(client.state.connection.upgrade).toMatchObject({ status: "rejected" });
    expect(transcript().outbox[0]!.error).toMatch(/did not approve/);
    expect(transcript().runs[0]).toMatchObject({ state: "failed" });
    expect(gateway.calls("chat.send")).toEqual([]);
    expect(gateway.connects).toHaveLength(1);
    client.stop();
  });

  it("reports an expired request and returns a pending stop to running", async () => {
    const gateway = grantingGateway();
    const wait = deferred<unknown>();
    gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-3" });
    gateway.handlers["device.scopes.waitUpgrade"] = () => wait.promise;
    const { client, transcript } = await openTask({ gateway, held: READ_SCOPES });
    startRun(gateway);
    await until(() => transcript().runs.length === 1);

    const stopping = client.stopRun(KEY, "run-x");
    expect(transcript().runs[0]!.state).toBe("stopping");
    await until(() => client.state.connection.upgrade.status === "pending");
    wait.resolve({ status: "expired", requestId: "up-3" });
    await stopping;
    expect(client.state.connection.upgrade.status).toBe("expired");
    expect(transcript().runs[0]).toMatchObject({ state: "running" });
    expect(transcript().runs[0]!.stopError).toMatch(/expired/);
    expect(gateway.calls("chat.abort")).toEqual([]);
    client.stop();
  });
});

describe("sending (F-075, F-081, F-106)", () => {
  it("shows the message at once, sends it with its idempotency key and reconciles it with history", async () => {
    const { client, gateway, transcript } = await openTask();
    const id = client.sendMessage(KEY, "  Clear it.  ");
    // Pending at once, with a running run and a live line, before the gateway answers.
    expect(transcript().outbox).toMatchObject([
      { id, text: "Clear it.", status: "sending", mode: "new" },
    ]);
    expect(transcript().live).toEqual({ runId: id, text: "" });
    await until(() => transcript().outbox[0]?.status === "sent");
    expect(gateway.calls("chat.send")).toEqual([
      { sessionKey: KEY, message: "Clear it.", idempotencyKey: id, queueMode: "followup" },
    ]);
    expect(transcript().runs[0]).toMatchObject({ id: "run-1", bound: true, messageId: id });

    gateway.handlers["chat.history"] = () => ({
      messages: [
        {
          role: "user",
          content: "Clear it.",
          __openclaw: { id: "u1", seq: 1, idempotencyKey: id },
        },
      ],
      hasMore: false,
      inFlightRun: { runId: "run-1", text: "" },
    });
    gateway.emit("session.message", { sessionKey: KEY, messageId: "u1", messageSeq: 1 });
    await until(() => transcript().outbox.length === 0);
    expect(transcript().items.map((item) => item.role)).toEqual(["user"]);
    expect(transcript().runs[0]).toMatchObject({
      id: "run-1",
      anchorItemId: "u1:0",
      state: "running",
    });
    client.stop();
  });

  it("F-095 F-433: reopened in the middle of a run whose reasoning came first, the reply streamed so far shows and goes on streaming", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.history"] = () => ({
      messages: [
        { role: "user", content: "How did last night go?", __openclaw: { id: "u1", seq: 1 } },
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "Check the backup log first." }],
          __openclaw: { id: "a1", seq: 2, runId: "run-1" },
        },
      ],
      hasMore: false,
      inFlightRun: { runId: "run-1", text: "The backup finished at 02:14" },
    });
    const { client, transcript } = await openTask({ gateway });
    await until(() => transcript().runs.some((run) => run.id === "run-1"));
    const run = () => transcript().runs.find((each) => each.id === "run-1")!;
    expect(run()).toMatchObject({ state: "running", text: "The backup finished at 02:14" });
    expect(run().textComplete).toBe(false);
    expect(run().steps.map((step) => step.kind)).toEqual(["reasoning"]);
    gateway.emit("chat", {
      runId: "run-1",
      sessionKey: KEY,
      seq: 3,
      state: "delta",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "The backup finished at 02:14 and wrote 41 GB." }],
      },
    });
    await until(() => run().text === "The backup finished at 02:14 and wrote 41 GB.");
    client.stop();
  });

  it("retries a refused message with the same key, and deletes one", async () => {
    const { client, gateway, transcript } = await openTask();
    let refuse = true;
    gateway.handlers["chat.send"] = () => {
      if (refuse) throw new GatewayError({ code: "INVALID_REQUEST", message: "budget exhausted" });
      return { runId: "run-ok", status: "started" };
    };
    const id = client.sendMessage(KEY, "First");
    await until(() => transcript().outbox[0]?.status === "failed");
    expect(transcript().outbox[0]!.error).toBe("budget exhausted");
    expect(transcript().runs[0]).toMatchObject({
      id,
      state: "failed",
      error: { message: "budget exhausted" },
    });

    refuse = false;
    client.retryMessage(KEY, id);
    await until(() => transcript().outbox[0]?.status === "sent");
    const keys = gateway
      .calls("chat.send")
      .map((p) => (p as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toEqual([id, id]);
    expect(transcript().runs.map((run) => [run.id, run.state])).toEqual([["run-ok", "running"]]);

    refuse = true;
    const second = client.sendMessage(KEY, "Second");
    await until(() => transcript().outbox.find((m) => m.id === second)?.status === "failed");
    client.deleteMessage(KEY, second);
    expect(transcript().outbox.map((m) => m.id)).toEqual([id]);
    expect(transcript().runs.find((run) => run.id === second)).toBeUndefined();
    client.stop();
  });

  it("F-075: a send whose answer never came stays unknown through the reconnect and history, is never called accepted, and is retried only on request", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.handlers["chat.send"] = () => new Promise(() => {});
    const id = client.sendMessage(KEY, "Lost in transit");
    await until(() => gateway.calls("chat.send").length === 1);
    // The connection drops before any answer: whether the frame reached the gateway is not known.
    gateway.dropAll();
    // Not failed: unknown, while history is read again after the reconnect.
    await until(() => transcript().outbox[0]?.status === "checking");
    expect(transcript().runs).toEqual([]);
    // History holds no row with its key: still unknown, never unconfirmed (which means accepted).
    await until(() => transcript().outbox[0]?.status === "unknown");
    await sleep(50);
    expect(transcript().outbox[0]!.status).toBe("unknown");
    expect(gateway.calls("chat.send")).toHaveLength(1);
    client.retryMessage(KEY, id);
    await until(() => gateway.calls("chat.send").length === 2);
    expect(
      gateway.calls("chat.send").map((p) => (p as { idempotencyKey: string }).idempotencyKey),
    ).toEqual([id, id]);
    client.stop();
  });

  it("refuses an oversized image or frame before anything reaches the socket", async () => {
    const gateway = grantingGateway();
    gateway.connectReply = (params) => {
      const hello = helloOk((params as ConnectParams).scopes, "device-token");
      return { ok: true, payload: { ...hello, policy: { ...hello.policy, maxPayload: 4_000 } } };
    };
    const { client, transcript } = await openTask({ gateway });
    const image = {
      type: "image",
      mimeType: "image/png",
      fileName: "big.png",
      content: "A".repeat(Math.ceil((6_291_457 * 4) / 3) + 4),
    };
    expect(() => client.sendMessage(KEY, "look", { attachments: [image] })).toThrow(
      SendTooLargeError,
    );
    expect(() => client.sendMessage(KEY, "x".repeat(5_000))).toThrow(/at most 4000/);
    expect(transcript().outbox).toEqual([]);
    expect(gateway.calls("chat.send")).toEqual([]);
    client.stop();
  });

  it("F-074 F-285: follows the file, image and frame ceilings the gateway advertises, and says them on the connection", async () => {
    const gateway = grantingGateway();
    gateway.connectReply = (params) => {
      const hello = helloOk((params as ConnectParams).scopes, "device-token");
      return {
        ok: true,
        payload: {
          ...hello,
          policy: { ...hello.policy, attachments: { maxBytes: 1_000_000, maxImageBytes: 500_000 } },
        },
      };
    };
    const { client, transcript } = await openTask({ gateway });
    expect(client.state.connection.sendLimits).toEqual({
      imageBytes: 500_000,
      fileBytes: 1_000_000,
      payloadBytes: 26_214_400,
      files: 20,
    });
    const file = (bytes: number) => ({
      type: "file",
      mimeType: "application/pdf",
      fileName: "report.pdf",
      content: "A".repeat(Math.ceil((bytes * 4) / 3)),
    });
    // Under Clawtrate's own 20 MiB, over the gateway's 1,000,000 bytes: refused before the socket.
    expect(() => client.sendMessage(KEY, "here", { attachments: [file(1_000_003)] })).toThrow(
      /up to 1000000 bytes/,
    );
    expect(gateway.calls("chat.send")).toEqual([]);
    expect(transcript().outbox).toEqual([]);
    client.sendMessage(KEY, "here", { attachments: [file(999_000)] });
    await until(() => gateway.calls("chat.send").length === 1);
    client.stop();
  });

  it("F-074: a gateway that says nothing of its ceilings gets Clawtrate's own: 6 MiB images, 20 MiB files, 25 MiB frames", async () => {
    const { client } = await openTask();
    expect(client.state.connection.sendLimits).toEqual({
      imageBytes: 6_291_456,
      fileBytes: 20_971_520,
      payloadBytes: 26_214_400,
      files: 20,
    });
    client.stop();
  });
});

describe("a run's start as the gateway reports it (F-081)", () => {
  it("is unknown for a run this client started until the gateway's lifecycle start, then that start", async () => {
    const { client, gateway, transcript } = await openTask();
    client.sendMessage(KEY, "Count the files");
    await until(() => transcript().runs[0]?.bound === true);
    const run = transcript().runs[0]!;
    // The client's own send time is not the gateway's word.
    expect(run.startedAt).not.toBeNull();
    expect(run.reportedStartAt).toBeNull();
    gateway.emit(
      "agent",
      agentEvent(run.id, 1, "lifecycle", { phase: "start", startedAt: 1_700_000_000_000 }),
    );
    await until(() => transcript().runs[0]?.reportedStartAt !== null);
    expect(transcript().runs[0]!.reportedStartAt).toBe(1_700_000_000_000);
    client.stop();
  });
});

describe("steering and questions (F-096, F-292, F-468)", () => {
  it("steers into the active run and hides the steer's own settled run", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.handlers["chat.send"] = () => ({ runId: "steer-run", status: "started" });
    startRun(gateway);
    await until(() => transcript().runs.length === 1);
    const id = client.sendMessage(KEY, "Also check /var");
    await until(() => transcript().outbox[0]?.status === "sent");
    expect(gateway.calls("chat.send")[0]).toMatchObject({ queueMode: "steer", idempotencyKey: id });
    expect(transcript().outbox[0]).toMatchObject({ mode: "steer", runId: "run-x" });
    gateway.emit("chat", { runId: "steer-run", sessionKey: KEY, seq: 1, state: "final" });
    await sleep(20);
    expect(transcript().runs.map((run) => [run.id, run.state])).toEqual([["run-x", "running"]]);
    client.stop();
  });

  it("holds a message while a question is pending, never sending it as an answer", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.handlers["question.resolve"] = () => ({ status: "cancelled" });
    startRun(gateway);
    gateway.emit("question.requested", question("ask_1", "run-x"));
    await until(() => transcript().runs[0]?.state === "waiting");

    const id = client.sendMessage(KEY, "Never mind, just do it");
    expect(transcript().outbox[0]).toMatchObject({ id, status: "held", mode: "steer" });
    await sleep(30);
    expect(gateway.calls("chat.send")).toEqual([]);

    await client.dismissQuestion(KEY, "ask_1");
    expect(gateway.calls("question.resolve")).toEqual([{ id: "ask_1", cancel: true }]);
    expect(transcript().questions[0]!.status).toBe("dismissed");
    await until(() => gateway.calls("chat.send").length === 1);
    expect(gateway.calls("chat.send")[0]).toMatchObject({ queueMode: "steer", idempotencyKey: id });
    expect(transcript().runs[0]!.state).toBe("running");
    client.stop();
  });

  it("cancels a held message, which is then never sent (F-281)", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.handlers["question.resolve"] = () => ({ status: "cancelled" });
    startRun(gateway);
    gateway.emit("question.requested", question("ask_9", "run-x"));
    await until(() => transcript().runs[0]?.state === "waiting");

    const id = client.sendMessage(KEY, "Hold this one");
    expect(transcript().outbox[0]).toMatchObject({ id, status: "held" });
    client.cancelQueued(KEY, id);
    expect(transcript().outbox[0]).toMatchObject({ id, status: "cancelled" });

    await client.dismissQuestion(KEY, "ask_9");
    await sleep(30);
    expect(gateway.calls("chat.send")).toEqual([]);
    client.stop();
  });

  it("answers a question card with question.resolve", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.handlers["question.resolve"] = (params) => ({
      status: "answered",
      answers: (params as { answers: unknown }).answers,
    });
    startRun(gateway);
    gateway.emit("question.requested", question("ask_2", "run-x"));
    await until(() => transcript().questions.length === 1);
    await expect(client.answerQuestion(KEY, "ask_2", { size: ["L"] })).rejects.toThrow(
      /no question size/,
    );
    await client.answerQuestion(KEY, "ask_2", { color: ["Blue", "teal, typed in"] });
    expect(gateway.calls("question.resolve")).toEqual([
      { id: "ask_2", answers: { answers: { color: ["Blue", "teal, typed in"] } } },
    ]);
    expect(transcript().questions[0]).toMatchObject({
      status: "answered",
      answers: { color: ["Blue", "teal, typed in"] },
    });
    expect(transcript().runs[0]!.state).toBe("running");
    // The gateway's own event repeats it harmlessly.
    gateway.emit("question.resolved", {
      id: "ask_2",
      status: "answered",
      answers: { answers: { color: ["Blue"] } },
    });
    await sleep(20);
    expect(transcript().runs[0]!.closedCards).toHaveLength(1);
    client.stop();
  });

  it("restores a pending question from question.list when a task opens", async () => {
    const gateway = grantingGateway();
    gateway.handlers["question.list"] = () => ({
      questions: [
        question("ask_3", "run-y"),
        { ...question("ask_4", "run-z"), sessionKey: "agent:otto:other" },
      ],
    });
    const { client, transcript } = await openTask({ gateway });
    await until(() => transcript().questions.length === 1);
    expect(transcript().questions[0]!.id).toBe("ask_3");
    expect(transcript().runs[0]).toMatchObject({ id: "run-y", state: "waiting" });
    client.stop();
  });
});

describe("queueing and stopping (F-097, F-419, F-420, F-421)", () => {
  it("F-468: queues a message sent while stopping; once the stop is confirmed it stays, not sent, until sent again", async () => {
    const { client, gateway, transcript } = await openTask();
    startRun(gateway);
    await until(() => transcript().runs.length === 1);
    await client.stopRun(KEY, "run-x");
    expect(gateway.calls("chat.abort")).toEqual([{ sessionKey: KEY, runId: "run-x" }]);
    expect(transcript().runs[0]!.state).toBe("stopping");

    const id = client.sendMessage(KEY, "Then do this instead");
    expect(transcript().outbox[0]).toMatchObject({ id, status: "queued", mode: "queue" });
    expect(transcript().runs.map((run) => run.state)).toEqual(["stopping", "queued"]);
    await sleep(20);
    expect(gateway.calls("chat.send")).toEqual([]);

    gateway.emit("chat", {
      runId: "run-x",
      sessionKey: KEY,
      seq: 2,
      state: "aborted",
      stopReason: "rpc",
    });
    await until(() => transcript().outbox[0]?.status === "not-sent");
    await sleep(30);
    // Nothing starts by itself after a confirmed Stop.
    expect(gateway.calls("chat.send")).toEqual([]);
    expect(transcript().runs.map((run) => [run.id, run.state])).toEqual([
      ["run-x", "stopped"],
      [id, "cancelled"],
    ]);
    // Sending it is the person's choice: it starts a run with the same key.
    client.retryMessage(KEY, id);
    await until(() => gateway.calls("chat.send").length === 1);
    expect(gateway.calls("chat.send")[0]).toMatchObject({
      queueMode: "followup",
      idempotencyKey: id,
    });
    client.stop();
  });

  it("ends as completed when the run finished before the stop took effect", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.handlers["chat.abort"] = () => ({ ok: true, aborted: false, runIds: [] });
    startRun(gateway);
    await until(() => transcript().runs.length === 1);
    await client.stopRun(KEY, "run-x");
    gateway.emit("agent", agentEvent("run-x", 2, "lifecycle", { phase: "end", aborted: false }));
    await until(() => transcript().runs[0]!.state === "completed");
    expect(transcript().runs[0]!.finishedBeforeStop).toBe(true);
    client.stop();
  });

  it("cancels queued messages when the task is archived (F-420)", async () => {
    const { client, gateway, transcript } = await openTask();
    startRun(gateway);
    await until(() => transcript().runs.length === 1);
    client.sendMessage(KEY, "later", { mode: "queue" });
    gateway.emit("sessions.changed", { sessionKey: KEY, session: { archived: true } });
    await until(() => transcript().outbox[0]?.status === "cancelled");
    expect(transcript().runs[1]!.state).toBe("cancelled");
    gateway.emit("chat", { runId: "run-x", sessionKey: KEY, seq: 2, state: "final" });
    await sleep(30);
    expect(gateway.calls("chat.send")).toEqual([]);
    client.stop();
  });

  it("stops a run this client started at the turn limit, aborting it by its id (F-100)", async () => {
    const { client, gateway, transcript } = await openTask({ turnLimitMs: 60 });
    client.sendMessage(KEY, "Take your time");
    await until(() => transcript().runs[0]?.state === "stopping", 2_000);
    expect(transcript().runs[0]!.turnLimit).toBe(0);
    await until(() => gateway.calls("chat.abort").length === 1);
    expect(gateway.calls("chat.abort")[0]).toEqual({ sessionKey: KEY, runId: "run-1" });
    client.stop();
  });
});

describe("creating a task", () => {
  it("sends only write-scope fields to sessions.create and opens the new task", async () => {
    const gateway = grantingGateway();
    gateway.handlers["sessions.create"] = () => ({
      ok: true,
      key: "agent:otto:dashboard:abc",
      sessionId: "s-9",
      runStarted: true,
      runId: "run-new",
    });
    const { client } = await openTask({ gateway });
    const key = await client.createTask("otto", "Check the backups", { label: "Backups" });
    expect(key).toBe("agent:otto:dashboard:abc");
    const [params] = gateway.calls("sessions.create") as Array<Record<string, unknown>>;
    expect(Object.keys(params!).sort()).toEqual(["agentId", "idempotencyKey", "label", "message"]);
    expect(params).toMatchObject({
      agentId: "otto",
      message: "Check the backups",
      label: "Backups",
    });
    expect(client.sessionInterest(key)).toBe(1);
    expect(client.state.transcripts[key]!.runs[0]).toMatchObject({
      id: "run-new",
      state: "running",
    });
    client.stop();
  });
});

describe("resync after a gap or a reconnect (F-107)", () => {
  it("reloads after a frame sequence gap, flags it, and does not duplicate messages", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.history"] = () => ({
      messages: [{ role: "user", content: "Hi", __openclaw: { id: "u1", seq: 1 } }],
      hasMore: false,
    });
    const { client, transcript } = await openTask({ gateway });
    const historyReads = gateway.calls("chat.history").length;
    gateway.emit("agent", agentEvent("run-x", 1, "lifecycle", { phase: "start" }), 1);
    gateway.emit("agent", agentEvent("run-x", 3, "lifecycle", { phase: "end" }), 3); // frame 2 never arrives
    await until(() => transcript().caughtUp?.reason === "gap");
    expect(gateway.calls("chat.history").length).toBeGreaterThan(historyReads);
    expect(transcript().items).toHaveLength(1);
    client.stop();
  });

  it("does not take a jump in a run's own seq as loss: the gateway coalesces those frames", async () => {
    const { client, gateway, transcript } = await openTask();
    const reads = gateway.calls("chat.history").length;
    gateway.emit("agent", agentEvent("run-x", 1, "lifecycle", { phase: "start" }));
    gateway.emit("agent", agentEvent("run-x", 4, "thinking", { text: "a", delta: "a" }));
    await until(() => transcript().runs[0]?.steps.length === 1);
    await sleep(200);
    expect(transcript().caughtUp).toBeNull();
    expect(gateway.calls("chat.history").length).toBe(reads);
    client.stop();
  });

  it("reloads open tasks after a reconnect and says so", async () => {
    const { client, gateway, transcript } = await openTask();
    expect(transcript().caughtUp).toBeNull();
    gateway.dropAll();
    await until(() => transcript().caughtUp?.reason === "reconnect");
    client.stop();
  });
});

describe("bridge commands for the live conversation", () => {
  it("acts only on tasks the viewer has open, and keeps a created task's interest per viewer", async () => {
    const gateway = grantingGateway();
    gateway.handlers["sessions.create"] = () => ({
      ok: true,
      key: "agent:otto:dashboard:new",
      runId: "run-n",
    });
    const { client } = await openTask({ gateway });
    const viewer = createBridgeSession(client);
    await expect(
      viewer.apply({ type: "sendMessage", key: KEY, text: "hi", mode: "auto", attachmentIds: [] }),
    ).rejects.toThrow(/not open in this view/);
    await viewer.apply({ type: "openSession", key: KEY });
    const sent = await viewer.apply({
      type: "sendMessage",
      key: KEY,
      text: "hi",
      mode: "auto",
      attachmentIds: [],
    });
    expect(sent.messageId).toBe(client.state.transcripts[KEY]!.outbox[0]!.id);

    const created = await viewer.apply({
      type: "createTask",
      botId: "otto",
      text: "New one",
      label: null,
    });
    expect(created).toEqual({ key: "agent:otto:dashboard:new" });
    expect(client.sessionInterest(created.key)).toBe(1);
    expect(
      await viewer.apply({ type: "readStepRaw", key: created.key, stepId: "tool:none" }),
    ).toBeNull();
    viewer.dispose();
    expect(client.sessionInterest(created.key)).toBe(0);
    client.stop();
  });
});
