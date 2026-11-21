// "Stop <Bot> in this task" from the Computer tab, through a viewer's bridge session: it stops
// every run of the task by its own id, as archive and delete do, and a viewer that goes away
// while it waits for write access takes it with it, as the conversation's Stop does.

import { describe, expect, it, vi } from "vitest";
import { createBridgeSession } from "../src/bridge.ts";
import type { ComputerViews } from "../src/computer.ts";
import { READ_SCOPES } from "../src/scopes.ts";
import { agentEvent, grantingGateway, KEY, openTask, questionRecord } from "./client-harness.ts";
import { deferred, sleep, until } from "./fake-gateway.ts";

describe("the Computer tab's Stop", () => {
  it("F-145: with two runs active and nothing naming the current one, asks the gateway to stop each", async () => {
    const gateway = grantingGateway();
    // A reconnect missed the original run's end; the gateway has another run in flight.
    gateway.handlers["chat.history"] = () => ({
      messages: [
        {
          role: "user",
          content: "First",
          __openclaw: { id: "u1", idempotencyKey: "original:user" },
        },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "exec", arguments: { command: "ls" } }],
          stopReason: "toolUse",
          __openclaw: { id: "a1", runId: "original" },
        },
      ],
      hasMore: false,
      inFlightRun: { runId: "current" },
    });
    gateway.handlers["chat.abort"] = () => ({ ok: true, aborted: true, runIds: [] });
    const { client, transcript } = await openTask({ gateway });
    gateway.emit("agent", agentEvent("original", 1, "lifecycle", { phase: "start" }));
    gateway.emit("agent", agentEvent("current", 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs.filter((each) => each.state === "running").length === 2);
    const viewer = createBridgeSession(client);
    await viewer.apply({ type: "openSession", key: KEY });
    await viewer.apply({ type: "computerShow", key: KEY });
    await viewer.apply({ type: "computerStopTask" });
    const id = viewer.computerViewer()!;
    expect(client.state.computer?.panes[id]?.stop).toMatchObject({
      sending: false,
      runIds: ["original", "current"],
    });
    const asked = gateway.calls("chat.abort").map((call) => (call as { runId?: string }).runId);
    expect(asked).toEqual(expect.arrayContaining(["original", "current"]));
    viewer.dispose();
    client.stop();
  });

  it("F-145: a Stop still waiting for write access is withdrawn when its viewer goes away", async () => {
    const wait = deferred<unknown>();
    const { client, gateway, transcript } = await openTask({ held: READ_SCOPES });
    gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-1" });
    gateway.handlers["device.scopes.waitUpgrade"] = () => wait.promise;
    gateway.handlers["chat.abort"] = () => ({ ok: true, aborted: true });
    gateway.emit("agent", agentEvent("run-1", 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs.some((each) => each.state === "running"));
    const viewer = createBridgeSession(client);
    await viewer.apply({ type: "openSession", key: KEY });
    await viewer.apply({ type: "computerShow", key: KEY });
    const stopping = viewer.apply({ type: "computerStopTask" });
    await until(() => client.state.connection.upgrade.status === "pending");
    viewer.dispose();
    wait.resolve({
      status: "approved",
      requestId: "up-1",
      deviceToken: "rotated",
      scopes: ["operator.read", "operator.write"],
    });
    await stopping;
    await sleep(30);
    expect(gateway.calls("chat.abort")).toEqual([]);
    client.stop();
  });

  it("F-145: a question cancelled while its run is stopping was cancelled; the run has not ended yet", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.abort"] = () => ({ ok: true, aborted: true, runIds: [] });
    const { client, transcript } = await openTask({ gateway });
    const closed = vi.spyOn(
      (client as unknown as { computer: ComputerViews }).computer,
      "questionClosed",
    );
    gateway.emit("agent", agentEvent("run-1", 1, "lifecycle", { phase: "start" }));
    gateway.emit("question.requested", questionRecord("ask_1", "run-1"));
    await until(() => transcript().questions.length === 1);
    await client.stopRun(KEY, "run-1");
    await until(() => transcript().runs[0]?.state === "stopping");
    gateway.emit("question.resolved", { id: "ask_1", status: "cancelled" });
    await until(() => closed.mock.calls.length > 0);
    expect(closed).toHaveBeenCalledWith(KEY, "ask_1", "cancelled");
    client.stop();
  });

  it("F-145: asks the gateway to stop every run at once, not one after another's answer", async () => {
    const gateway = grantingGateway();
    const slow = deferred<unknown>();
    gateway.handlers["chat.abort"] = (params) =>
      (params as { runId?: string }).runId === "run-1"
        ? slow.promise
        : { ok: true, aborted: true, runIds: [] };
    const { client, transcript } = await openTask({ gateway });
    gateway.emit("agent", agentEvent("run-1", 1, "lifecycle", { phase: "start" }));
    gateway.emit("agent", agentEvent("run-2", 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs.filter((each) => each.state === "running").length === 2);
    const viewer = createBridgeSession(client);
    await viewer.apply({ type: "openSession", key: KEY });
    await viewer.apply({ type: "computerShow", key: KEY });
    const stopping = viewer.apply({ type: "computerStopTask" });
    // The first run's answer hasn't come: the second run's Stop has gone anyway.
    await until(() => gateway.calls("chat.abort").length === 2);
    slow.resolve({ ok: true, aborted: true, runIds: [] });
    await stopping;
    viewer.dispose();
    client.stop();
  });
  it("F-145: Computer hears of a question's closure only once the transcript records it, so the bar sees no pending question", async () => {
    const gateway = grantingGateway();
    const { client, transcript } = await openTask({ gateway });
    const statuses: string[] = [];
    vi.spyOn(
      (client as unknown as { computer: ComputerViews }).computer,
      "questionClosed",
    ).mockImplementation(() => {
      statuses.push(transcript().questions[0]?.status ?? "none");
    });
    gateway.emit("agent", agentEvent("run-1", 1, "lifecycle", { phase: "start" }));
    gateway.emit("question.requested", questionRecord("ask_1", "run-1"));
    await until(() => transcript().questions.length === 1);
    // Answered on another device.
    gateway.emit("question.resolved", { id: "ask_1", status: "answered" });
    await until(() => statuses.length > 0);
    expect(statuses).toEqual(["answered"]);
    client.stop();
  });
});
