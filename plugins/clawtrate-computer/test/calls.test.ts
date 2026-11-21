// A bot's browser call counts as running from its pre-call check until its end
// arrives, its run ends or it is cancelled, in whatever order the gateway's
// hooks come; one that never reports an end makes a take say it cannot
// confirm, never that the bot is acting for ever.

import { describe, expect, it } from "vitest";
import { ATLAS_TAB, FakeBrowser, load, sleep } from "./harness.ts";

const tab = { targetId: ATLAS_TAB };

/**
 * A stand-in for the gateway's tool call: it runs the pre-call check
 * (`before_tool_call`) and waits for it at most `hookTimeoutMs`. Past that it
 * gives up on the check: `abortOnTimeout` aborts the check's signal and
 * blocks the call, as OpenClaw 2026.10.6 does; without it the call runs
 * anyway. Either way the call's end (`after_tool_call`) follows at once, and
 * the late check is left to finish on its own.
 */
async function gatewayCall(
  h: ReturnType<typeof load>,
  runId: string,
  toolCallId: string,
  { hookTimeoutMs, abortOnTimeout }: { hookTimeoutMs: number; abortOnTimeout: boolean },
) {
  const signal = new AbortController();
  const check = h.before(
    "atlas",
    runId,
    toolCallId,
    { action: "act" },
    {
      abortSignal: signal.signal,
    },
  );
  const gaveUp = await Promise.race([
    check.then(() => false),
    sleep(hookTimeoutMs).then(() => true),
  ]);
  if (gaveUp && abortOnTimeout) signal.abort();
  await h.after("atlas", runId, toolCallId);
  return { gaveUp, check };
}

describe("a bot call's record ends with the call, whatever the order of the gateway's hooks", () => {
  it("a call the gateway lets run before its slow pre-call check returns is never left running", async () => {
    // Discovery stalls, so the check's wait for the bot's browser is slow.
    const browser = new FakeBrowser();
    browser.stallDiscovery = true;
    const h = load({ browser });
    const { gaveUp, check } = await gatewayCall(h, "run-1", "c1", {
      hookTimeoutMs: 50,
      abortOnTimeout: false,
    });
    expect(gaveUp, "the gateway stopped waiting for the check").toBe(true);
    await check;
    expect(h.state.inflight.size).toBe(0);
    browser.stallDiscovery = false;
    expect((await h.call("control.take", tab)).payload?.state).toBe("granted");
  });

  it("the gateway's own timeout, which aborts the check's signal and blocks the call, leaves nothing running", async () => {
    const browser = new FakeBrowser();
    browser.stallDiscovery = true;
    const h = load({ browser });
    const { gaveUp, check } = await gatewayCall(h, "run-1", "c1", {
      hookTimeoutMs: 50,
      abortOnTimeout: true,
    });
    expect(gaveUp).toBe(true);
    await check;
    expect(h.state.inflight.size).toBe(0);
  });

  it("a call counts as running from the start of its pre-call check, so a take started meanwhile waits for it", async () => {
    const browser = new FakeBrowser();
    browser.stallDiscovery = true;
    const h = load({ browser });
    const check = h.before("atlas", "run-1", "c1", { action: "act" });
    expect(h.state.inflight.size, "recorded before anything is awaited").toBe(1);
    await check;
    expect(h.state.inflight.size).toBe(1);
    await h.after("atlas", "run-1", "c1");
    expect(h.state.inflight.size).toBe(0);
  });

  it("a call refused by its pre-call check takes its record back", async () => {
    const h = load();
    expect((await h.call("control.take", tab)).payload?.state).toBe("granted");
    const held = await h.before("atlas", "run-1", "c1", { action: "act" });
    expect(held?.blockReason).toBe(
      "A person has control of this bot's browser. Wait until they give it back.",
    );
    expect(h.state.inflight.size).toBe(0);
  });

  it("a call whose end never arrives is ended by its run's end", async () => {
    const h = load();
    await h.before("atlas", "run-1", "c1", { action: "act" });
    await h.before("atlas", "run-2", "c2", { action: "act" });
    expect(h.state.inflight.size).toBe(2);
    // Another agent's run of the same id ends nothing of the bot's.
    await h.hook("agent_end", {}, { agentId: "someone", runId: "run-1" });
    expect(h.state.inflight.size).toBe(2);
    await h.hook("agent_end", {}, { agentId: "atlas", runId: "run-1" });
    expect([...h.state.inflight.keys()]).toEqual(["run-2\nc2"]);
    // Its end arriving late changes nothing, and a late check for it records nothing.
    await h.after("atlas", "run-1", "c1");
    await h.before("atlas", "run-1", "c1", { action: "act" });
    expect([...h.state.inflight.keys()]).toEqual(["run-2\nc2"]);
  });

  it("a run's end that arrives before a call's pre-call check leaves that call unrecorded, and other runs' calls tracked", async () => {
    const h = load();
    await h.hook("agent_end", {}, { agentId: "atlas", runId: "run-1" });
    await h.before("atlas", "run-1", "c1", { action: "act" });
    expect(h.state.inflight.size).toBe(0);
    await h.before("atlas", "run-2", "c2", { action: "act" });
    expect([...h.state.inflight.keys()]).toEqual(["run-2\nc2"]);
    expect((await h.call("control.take", tab)).payload?.state).not.toBe("granted");
  });

  it("a call that has reported no end for the stated time makes a take say it cannot confirm, never that the bot is acting", async () => {
    // The drain waits 1 s here; a call is confirmed as running for 1.5 s.
    const h = load({ callConfirmMs: 1500 });
    await h.before("atlas", "run-1", "c1", { action: "act" });
    const acting = await h.call("control.take", tab);
    expect(acting.payload).toMatchObject({ state: "busy", cause: "bot-still-acting" });
    await sleep(600);
    const unknown = await h.call("control.take", tab);
    expect(unknown.payload).toMatchObject({
      state: "busy",
      cause: "bot-calls-unconfirmed",
      runningCalls: 1,
    });
    expect(h.statesOf(unknown.payload!.generation)).toEqual(["draining", "busy"]);
    // Once the run says it ended, the take goes through.
    await h.hook("agent_end", {}, { agentId: "atlas", runId: "run-1" });
    expect((await h.call("control.take", tab)).payload?.state).toBe("granted");
  });

  it("a pre-call check waits for a watch already being set up no longer than its own bound", async () => {
    const browser = new FakeBrowser();
    browser.stallDiscovery = true;
    // Setting up a watch can take 8 s here; a pre-call check waits 2 s at most.
    const h = load({ browser, timeouts: { discoveryMs: 8000, connectMs: 300, commandMs: 300 } });
    // A call's end starts the watch of the bot's browser, which stalls.
    await h.before("atlas", "run-1", "c1", { action: "act" });
    await h.after("atlas", "run-1", "c1");
    const started = Date.now();
    await h.before("atlas", "run-2", "c2", { action: "act" });
    expect(Date.now() - started).toBeLessThan(3000);
    await h.stop();
  }, 20_000);
});
