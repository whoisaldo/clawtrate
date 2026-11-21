// The Computer tab's engine (`computer.ts`) against a scripted computer
// plugin: what each answer of the plugin's makes the pane say, the view from
// its ticket to its end, and control from the take to a confirmed hand-back.
// The plugin's answers are its own shapes (plugins/clawtrate-computer/README.md).

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ComputerViews,
  initialComputerState,
  LIVE_FOR_MS,
  MAX_FRAME_BYTES,
  MAX_QUEUED_INPUTS,
  parseFrame,
  pictureAge,
  stopProgress,
  streamUrl,
  type ComputerContext,
  type ComputerState,
  type StopAnswer,
} from "../src/computer.ts";
import * as words from "../src/computer-words.ts";
import type { WebSocketLike } from "../src/host.ts";
import { utf8Bytes } from "../src/bytes.ts";
import type { QuestionCard, Run } from "../src/runs.ts";

const KEY = "agent:pip:trip";
const TAB = "TAB0000000000000000000000000000A";
const OTHER = "TAB0000000000000000000000000000B";
const GEN = "a".repeat(32);
const GEN2 = "b".repeat(32);
// An invented ticket of the plugin's shape (48 hex), built here so no literal looks like a secret.
const TICKET = "f00dface".repeat(6);

type Handler = (params: Record<string, unknown>) => unknown;
const refused = (code: string, reason: string) =>
  Object.assign(new Error(`refused: ${reason}`), { gatewayCode: code, details: { reason } });
const policy = () =>
  Object.assign(new Error("policy"), {
    gatewayCode: "FORBIDDEN",
    details: { code: "SESSION_RESOURCE_TOOL_POLICY" },
  });
const never = () => new Promise<never>(() => {});
const flush = async (times = 6) => {
  for (let i = 0; i < times; i++) await Promise.resolve();
};

class Stream implements WebSocketLike {
  readyState = 1;
  binaryType?: string;
  closed: number | null = null;
  readonly url: string;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(url: string) {
    this.url = url;
  }
  send(): void {
    throw new Error("a viewer sends nothing on the stream");
  }
  close(code = 1000): void {
    this.closed = code;
    this.readyState = 3;
  }
  text(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  frame(width = 1280, height = 720, size = 64, ts = 1) {
    this.onmessage?.({ data: frameBytes(width, height, size, ts).buffer });
  }
  end(code: number) {
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }
}

function frameBytes(width: number, height: number, size: number, ts = 1): Uint8Array {
  const header = utf8Bytes(
    JSON.stringify({
      url: "http://127.0.0.1:1/p",
      cssWidth: width,
      cssHeight: height,
      scrollX: 0,
      scrollY: 0,
      ts,
    }),
  );
  const jpeg = new Uint8Array(size).fill(7);
  jpeg[0] = 0xff;
  jpeg[1] = 0xd8;
  const out = new Uint8Array(4 + header.length + jpeg.length);
  new DataView(out.buffer).setUint32(0, header.length);
  out.set(header, 4);
  out.set(jpeg, 4 + header.length);
  return out;
}

const tabsAnswer = (lease: unknown = null, extra: unknown[] = []) => ({
  agentId: "pip",
  profile: "bot-pip",
  browser: "running",
  tabs: [{ targetId: TAB, url: "http://127.0.0.1:1/sign-in", title: "Sign in", lease }, ...extra],
});

function question(overrides: Partial<QuestionCard> = {}): QuestionCard {
  return {
    id: "ask_1",
    runId: "run-1",
    status: "pending",
    questions: [
      {
        id: "q1",
        header: "Sign in",
        question: "Sign in, then hand the browser back.",
        options: [
          { index: 0, label: "I'm done", description: null, value: null },
          { index: 1, label: "Skip", description: null, value: null },
        ],
        optionsOmitted: 0,
        multiSelect: false,
        allowsOther: true,
      },
    ],
    createdAt: 0,
    expiresAt: null,
    answers: null,
    submitting: false,
    error: null,
    raw: null,
    ordinary: true,
    sent: null,
    settledBy: [],
    ...overrides,
  };
}

function harness(handlers: Record<string, Handler> = {}, options: { write?: boolean } = {}) {
  let state: ComputerState = initialComputerState;
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const streams: Stream[] = [];
  const logs: string[] = [];
  const env = { write: options.write ?? true, online: true, question: null as QuestionCard | null };
  const answered: Array<{ key: string; id: string; answers: unknown }> = [];
  const all: Record<string, Handler> = {
    "clawtrate-computer.tabs": () => tabsAnswer(),
    "clawtrate-computer.view.open": () => ({
      streamId: "stream-1",
      wsPath: `/clawtrate-computer/stream?ticket=${TICKET}`,
      expiresAtMs: Date.now() + 60_000,
      renewWithinMs: 20_000,
      targetId: TAB,
    }),
    "clawtrate-computer.view.renew": (p) => ({
      ok: true,
      renewWithinMs: 20_000,
      streamRenewed: p.streamId === "stream-1",
      leaseRenewed: p.generation === GEN,
    }),
    "clawtrate-computer.control.take": (p) => ({
      state: "granted",
      generation: GEN,
      renewWithinMs: 20_000,
      targetId: p.targetId,
      guarantee: [],
    }),
    "clawtrate-computer.control.release": (p) => ({
      state: "released",
      generation: p.generation,
      targetId: p.targetId,
    }),
    "clawtrate-computer.input": () => ({ ok: true }),
    ...handlers,
  };
  const ctx: ComputerContext = {
    request: async (method, params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      requests.push({ method, params: p });
      const handler = all[method];
      if (!handler) throw new Error(`unscripted ${method}`);
      return handler(p);
    },
    openStream: (url) => {
      const stream = new Stream(url);
      streams.push(stream);
      return stream;
    },
    gatewayUrl: () => "ws://127.0.0.1:19999",
    canWrite: () => env.online && env.write,
    online: () => env.online,
    now: () => Date.now(),
    get: () => state,
    set: (next) => {
      state = next;
    },
    pendingQuestion: () => (env.question?.status === "pending" ? env.question : null),
    questionStatus: (_key, id) => (env.question?.id === id ? env.question.status : null),
    answer: async (key, id, answers) => {
      answered.push({ key, id, answers });
    },
    stopTask: vi.fn(async () => ({ runIds: [], aborted: false })),
    log: (_level, message) => logs.push(message),
  };
  const views = new ComputerViews(ctx);
  const viewer = views.newViewer();
  const pane = () => state.panes[viewer]!;
  const calls = (method: string) =>
    requests.filter((r) => r.method === method).map((r) => r.params);
  return {
    views,
    viewer,
    pane,
    state: () => state,
    requests,
    calls,
    streams,
    logs,
    env,
    answered,
    ctx,
  };
}

async function ready(h: ReturnType<typeof harness>) {
  h.views.hello(["clawtrate-computer.tabs"]);
  h.views.show(h.viewer, KEY);
  await flush();
  expect(h.pane().availability).toBe("ready");
}

async function live(h: ReturnType<typeof harness>) {
  await ready(h);
  await h.views.watch(h.viewer);
  h.streams.at(-1)!.frame();
  expect(h.pane().view?.status).toBe("live");
}

async function granted(h: ReturnType<typeof harness>) {
  await live(h);
  await h.views.take(h.viewer);
  expect(h.pane().control.status).toBe("granted");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("what the plugin answers for the task's bot (F-141, section 19)", () => {
  it("F-141: says the plugin is not loaded from the hello's methods, and asks it nothing", async () => {
    const h = harness();
    h.views.hello(["chat.send"]);
    h.views.show(h.viewer, KEY);
    await flush();
    expect(h.state().plugin).toBe(false);
    expect(h.pane().availability).toBe("absent");
    expect(h.requests).toEqual([]);
  });

  it("F-141: tells a bot that is not configured from a task whose policy denies the browser, and from any other refusal", async () => {
    const h = harness({
      "clawtrate-computer.tabs": () => {
        throw refused("UNAVAILABLE", "bot_not_configured");
      },
    });
    await (h.views.hello(["clawtrate-computer.tabs"]), h.views.show(h.viewer, KEY), flush());
    expect(h.pane().availability).toBe("not-configured");

    const p = harness({
      "clawtrate-computer.tabs": () => {
        throw policy();
      },
    });
    p.views.hello(["clawtrate-computer.tabs"]);
    p.views.show(p.viewer, KEY);
    await flush();
    expect(p.pane().availability).toBe("not-allowed");

    const e = harness({
      "clawtrate-computer.tabs": () => {
        throw refused("FORBIDDEN", "session_access_required");
      },
    });
    e.views.hello(["clawtrate-computer.tabs"]);
    e.views.show(e.viewer, KEY);
    await flush();
    expect(e.pane().availability).toBe("error");
    expect(e.pane().error).toMatch(/session_access_required/);
  });

  it("F-141: an empty tab list is only that: no tabs, nothing said of a stopped browser", async () => {
    const h = harness({
      "clawtrate-computer.tabs": () => ({
        agentId: "pip",
        profile: "bot-pip",
        browser: "not-running",
        reason: "browser_unavailable",
        tabs: [],
      }),
    });
    await ready(h);
    expect(h.pane().tabs).toEqual([]);
    expect(h.pane().shown).toBeNull();
  });

  it("a read-only connection asks for none of the plugin's methods and is never shown a view", async () => {
    const h = harness({}, { write: false });
    h.views.hello(["clawtrate-computer.tabs"]);
    h.views.show(h.viewer, KEY);
    await flush();
    expect(h.pane().availability).toBe("read-only");
    await h.views.watch(h.viewer);
    await h.views.take(h.viewer);
    expect(h.requests).toEqual([]);
    expect(h.streams).toEqual([]);
    expect(h.pane().view).toBeNull();
    expect(h.pane().control.status).toBe("none");
  });

  it("shows the first real tab, not the browser's new-tab page, and names who holds each lease", async () => {
    const h = harness({
      "clawtrate-computer.tabs": () => ({
        browser: "running",
        tabs: [
          { targetId: OTHER, url: "chrome://newtab/", title: "New Tab", lease: null },
          {
            targetId: TAB,
            url: "http://127.0.0.1:1/sign-in",
            title: "Sign in",
            lease: { state: "granted", mine: false },
          },
        ],
      }),
    });
    await ready(h);
    expect(h.pane().shown).toBe(TAB);
    expect(h.pane().tabs[1]!.lease).toEqual({ state: "granted", holder: "elsewhere" });
  });
});

describe("a view from start to end (F-142, section 17)", () => {
  it("opens the stream on the gateway's own address with the ticket, and keeps the ticket out of the state", async () => {
    const h = harness();
    await ready(h);
    await h.views.watch(h.viewer);
    expect(h.streams).toHaveLength(1);
    expect(h.streams[0]!.url).toBe(
      `ws://127.0.0.1:19999/clawtrate-computer/stream?ticket=${TICKET}`,
    );
    expect(h.streams[0]!.binaryType).toBeUndefined();
    expect(JSON.stringify(h.state())).not.toContain(TICKET);
    expect(h.pane().view).toMatchObject({ status: "connecting", targetId: TAB });
    h.streams[0]!.text({
      type: "ready",
      targetId: TAB,
      url: "http://127.0.0.1:1/sign-in",
      title: "Sign in",
    });
    h.streams[0]!.frame(756, 413);
    expect(h.pane().view).toMatchObject({ status: "live", frame: 1, width: 756, height: 413 });
    expect(JSON.stringify(h.state())).not.toContain(TICKET);
    expect(h.logs.join("\n")).not.toContain(TICKET);
  });

  it("refuses a stream path that would leave the gateway's origin", () => {
    expect(streamUrl("ws://127.0.0.1:1", "/clawtrate-computer/stream?ticket=x")).toBe(
      "ws://127.0.0.1:1/clawtrate-computer/stream?ticket=x",
    );
    expect(
      streamUrl("ws://127.0.0.1:1", "//elsewhere.example/clawtrate-computer/stream?ticket=x"),
    ).toBeNull();
    expect(streamUrl("ws://127.0.0.1:1", "/other?ticket=x")).toBeNull();
    expect(streamUrl("http://127.0.0.1:1", "/clawtrate-computer/stream?ticket=x")).toBeNull();
  });

  it("hands the viewer only the newest frame, once, and drops it when the view ends", async () => {
    const h = harness();
    await live(h);
    const n = h.pane().view!.n;
    h.streams[0]!.frame(1280, 720, 80);
    h.streams[0]!.frame(1280, 720, 90);
    const first = await h.views.frame(h.viewer, n, 0);
    expect(first?.seq).toBe(3);
    // Drawn once: the host keeps nothing of it.
    const waiting = h.views.frame(h.viewer, n, 3);
    h.views.stopWatching(h.viewer);
    expect(await waiting).toBeNull();
    expect(await h.views.frame(h.viewer, n, 0)).toBeNull();
    expect(h.streams[0]!.closed).toBe(1000);
    expect(h.pane().view).toBeNull();
  });

  it("drops a frame larger than it keeps, and counts it", async () => {
    const h = harness();
    await live(h);
    h.streams[0]!.frame(1280, 720, 200_000);
    expect(h.pane().view).toMatchObject({ frame: 1, framesTooLarge: 1 });
  });

  it("disposes of a ticket that arrives after the person stopped watching: the stream is never opened", async () => {
    let answer!: (value: unknown) => void;
    const h = harness({
      "clawtrate-computer.view.open": () => new Promise((resolve) => (answer = resolve)),
    });
    await ready(h);
    const watching = h.views.watch(h.viewer);
    await flush();
    h.views.stopWatching(h.viewer);
    answer({
      streamId: "stream-1",
      wsPath: `/clawtrate-computer/stream?ticket=${TICKET}`,
      renewWithinMs: 20_000,
    });
    await watching;
    expect(h.streams).toEqual([]);
    expect(h.pane().view).toBeNull();
  });

  it("says how the view ended for each close code: tab closed, browser stopped answering, gateway ended it", async () => {
    for (const [code, end] of [
      [4004, "tab-closed"],
      [1011, "browser-gone"],
      [4006, "gateway-ended"],
      [1012, "gateway-ended"],
    ] as const) {
      const h = harness();
      await live(h);
      h.streams[0]!.end(code);
      expect(h.pane().view, String(code)).toMatchObject({ status: "ended", end });
    }
  });

  it("renews the view well within its deadline, and ends it when a renewal no longer renews the stream", async () => {
    vi.useFakeTimers();
    let renews = 0;
    const h = harness({
      "clawtrate-computer.view.renew": () => ({
        ok: true,
        renewWithinMs: 20_000,
        streamRenewed: (renews += 1) < 2,
        leaseRenewed: false,
      }),
    });
    await live(h);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.calls("clawtrate-computer.view.renew")).toEqual([
      { sessionKey: KEY, targetId: TAB, streamId: "stream-1" },
    ]);
    expect(h.pane().view?.status).toBe("live");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.pane().view).toMatchObject({ status: "ended", end: "gateway-ended" });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.calls("clawtrate-computer.view.renew")).toHaveLength(2);
  });

  it("ends the view at once when the connection drops, and says so", async () => {
    const h = harness();
    await live(h);
    h.env.online = false;
    h.views.connectionLost();
    expect(h.pane().view).toMatchObject({ status: "ended", end: "dropped" });
    expect(h.streams[0]!.closed).toBe(1000);
  });
});

describe("taking control (F-142, F-144, section 18)", () => {
  it("F-142: says it waits while the take drains, then You have control only once the gateway grants it", async () => {
    let grant!: (value: unknown) => void;
    const h = harness({
      "clawtrate-computer.control.take": () => new Promise((resolve) => (grant = resolve)),
    });
    await live(h);
    const taking = h.views.take(h.viewer);
    await flush();
    expect(h.pane().control.status).toBe("draining");
    // Frames still arriving prove nothing.
    h.streams[0]!.frame();
    expect(h.pane().control.status).toBe("draining");
    grant({
      state: "granted",
      generation: GEN,
      renewWithinMs: 6_000,
      targetId: TAB,
      guarantee: [],
    });
    await taking;
    expect(h.pane().control).toMatchObject({ status: "granted", renewWithinMs: 6_000 });
    // The generation stays in the engine.
    expect(JSON.stringify(h.state().panes)).not.toContain(GEN);
  });

  it("F-142: a take refused while the bot acts says so, and one refused while its work has not settled says that, each with Try again", async () => {
    const h = harness({
      "clawtrate-computer.control.take": () => ({
        state: "busy",
        reason: "bot-still-acting",
        runningCalls: 1,
        generation: GEN,
      }),
    });
    await live(h);
    await h.views.take(h.viewer);
    expect(h.pane().control).toMatchObject({
      status: "busy",
      busyReason: "bot-still-acting",
      busyCount: 1,
    });
    await h.views.take(h.viewer);
    await h.views.take(h.viewer);
    expect(h.pane().control.busyCount).toBe(3);

    for (const reason of ["browser-not-quiet", "download-in-progress", "browser-not-watched"]) {
      const u = harness({
        "clawtrate-computer.control.take": () => ({
          state: "busy",
          reason,
          runningCalls: 0,
          generation: GEN,
        }),
      });
      await live(u);
      await u.views.take(u.viewer);
      expect(u.pane().control, reason).toMatchObject({
        status: "unsettled",
        busyReason: reason,
        busyCount: 1,
      });
    }
  });

  it("F-142: a busy take is read by the plugin's code, not its sentence; a reason this app does not know is never still acting", async () => {
    const answers: Array<[Record<string, unknown>, string | null, string]> = [
      // The plugin's own answer: `reason` is its sentence, `cause` its code.
      [
        { reason: "the bot's browser is still loading a page", cause: "browser-not-quiet" },
        "browser-not-quiet",
        "unsettled",
      ],
      [
        { reason: "the bot is still acting in this browser", cause: "bot-still-acting" },
        "bot-still-acting",
        "busy",
      ],
      [
        {
          reason: "a browser call of the bot has not reported that it ended",
          cause: "bot-calls-unconfirmed",
        },
        "bot-calls-unconfirmed",
        "unsettled",
      ],
      // A plugin without `cause` gives only its sentence: not a code, so no reason.
      [{ reason: "the bot's browser is still loading a page" }, null, "unsettled"],
    ];
    for (const [fields, busyReason, status] of answers) {
      const h = harness({
        "clawtrate-computer.control.take": () => ({
          state: "busy",
          ...fields,
          runningCalls: 0,
          generation: GEN,
        }),
      });
      await live(h);
      await h.views.take(h.viewer);
      expect(h.pane().control, JSON.stringify(fields)).toMatchObject({ status, busyReason });
    }
    expect(words.busyLine("Pip", null)).toBe(
      "The gateway didn't give control of Pip's browser. Try again in a moment.",
    );
    expect(words.busyLine("Pip", "bot-calls-unconfirmed")).toContain(
      "Can't confirm whether Pip is still acting",
    );
    expect(words.busyLine("Pip", "browser-not-watched")).not.toContain("still acting");
  });

  it("F-142: someone else holding the tab is a conflict, not control", async () => {
    let lease: unknown = null;
    const h = harness({
      "clawtrate-computer.tabs": () => tabsAnswer(lease),
      "clawtrate-computer.control.take": () => {
        throw refused("UNAVAILABLE", "control_held");
      },
    });
    await live(h);
    lease = { state: "granted", mine: false };
    await h.views.take(h.viewer);
    await flush();
    expect(h.pane().control.status).toBe("conflict");
    expect(h.pane().tabs[0]!.lease).toEqual({ state: "granted", holder: "elsewhere" });
  });

  it("F-142: a refused take names no holder until a read made after it does: another device still asking is asking, not in control, and the line clears once that request ends", async () => {
    let lease: unknown = null;
    let read!: () => void;
    const h = harness({
      "clawtrate-computer.tabs": () =>
        new Promise((resolve) => (read = () => resolve(tabsAnswer(lease)))),
      "clawtrate-computer.control.take": () => {
        throw refused("UNAVAILABLE", "control_held");
      },
    });
    h.views.hello(["clawtrate-computer.tabs"]);
    h.views.show(h.viewer, KEY);
    read();
    await flush();
    await h.views.watch(h.viewer);
    h.streams.at(-1)!.frame();
    // A read from before the refusal still says nothing holds the tab.
    void h.views.readTabs(h.viewer);
    const old = read;
    lease = { state: "draining", mine: false };
    await h.views.take(h.viewer);
    expect(h.pane().control.status).toBe("conflict");
    // The old read answers first: it can't say who has the tab now.
    old();
    await flush();
    expect(h.pane().control.status).toBe("conflict");
    expect(h.pane().tabs[0]!.lease).toBeNull();
    // The read made after the refusal: another device is asking, and nobody has control yet.
    read();
    await flush();
    expect(h.pane().control.status).toBe("conflict");
    expect(h.pane().tabs[0]!.lease).toEqual({ state: "draining", holder: "elsewhere" });
    // That request ends: the next read finds nothing on the tab, and the refusal's line goes.
    lease = null;
    h.views.controlEvent({
      agentId: "pip",
      profile: "bot-pip",
      targetId: TAB,
      holder: "bot",
      state: "busy",
      generation: GEN2,
    });
    read();
    await flush();
    expect(h.pane().control.status).toBe("none");
  });

  it("F-142: a draining event belongs to a take only once a read says the tab's request is this connection's, and to no take when another viewer of this app waits for the same tab", async () => {
    let lease: unknown = null;
    const grants: Array<(value: unknown) => void> = [];
    const grant = (value: unknown) => grants.splice(0).forEach((resolve) => resolve(value));
    const h = harness({
      "clawtrate-computer.tabs": () => tabsAnswer(lease),
      "clawtrate-computer.control.take": () => new Promise((resolve) => grants.push(resolve)),
    });
    await live(h);
    const taking = h.views.take(h.viewer);
    await flush();
    // Another device's request, broadcast to every reader: the read says it isn't this one's.
    lease = { state: "draining", mine: false };
    h.views.controlEvent({
      agentId: "pip",
      profile: "bot-pip",
      targetId: TAB,
      holder: "user",
      state: "draining",
      generation: GEN2,
    });
    await flush();
    h.views.cancelTake(h.viewer);
    await flush();
    expect(h.calls("clawtrate-computer.control.release")).toEqual([]);
    grant({
      state: "busy",
      reason: "the bot is still acting in this browser",
      cause: "bot-still-acting",
      runningCalls: 1,
      generation: GEN,
    });
    await taking;

    // Two viewers of this app wait for the same tab: the event can be either's, so neither takes it.
    const second = h.views.newViewer();
    h.views.show(second, KEY);
    await flush();
    await h.views.watch(second);
    lease = null;
    const first = h.views.take(h.viewer);
    const other = h.views.take(second);
    await flush();
    lease = { state: "draining", mine: true };
    h.views.controlEvent({
      agentId: "pip",
      profile: "bot-pip",
      targetId: TAB,
      holder: "user",
      state: "draining",
      generation: GEN,
    });
    await flush();
    h.views.cancelTake(second);
    await flush();
    expect(h.calls("clawtrate-computer.control.release")).toEqual([]);
    grant({
      state: "busy",
      reason: "the bot is still acting in this browser",
      cause: "bot-still-acting",
      runningCalls: 1,
      generation: GEN,
    });
    await Promise.all([first, other]);
  });

  it("F-142: Cancel withdraws the take with the draining event's generation, and a grant that wins the race is given back at once with no input", async () => {
    let grant!: (value: unknown) => void;
    let lease: unknown = null;
    const h = harness({
      "clawtrate-computer.tabs": () => tabsAnswer(lease),
      "clawtrate-computer.control.take": () => new Promise((resolve) => (grant = resolve)),
    });
    await live(h);
    const taking = h.views.take(h.viewer);
    await flush();
    // This connection's request: the read after the event lists it as its own.
    lease = { state: "draining", mine: true };
    h.views.controlEvent({
      agentId: "pip",
      profile: "bot-pip",
      targetId: TAB,
      holder: "user",
      state: "draining",
      generation: GEN,
    });
    h.views.cancelTake(h.viewer);
    await flush();
    expect(h.calls("clawtrate-computer.control.release")).toEqual([
      { sessionKey: KEY, targetId: TAB, generation: GEN },
    ]);
    expect(h.pane().control.status).toBe("none");
    grant({
      state: "granted",
      generation: GEN2,
      renewWithinMs: 20_000,
      targetId: TAB,
      guarantee: [],
    });
    await taking;
    await flush();
    expect(h.calls("clawtrate-computer.control.release").at(-1)).toEqual({
      sessionKey: KEY,
      targetId: TAB,
      generation: GEN2,
    });
    expect(h.pane().control.status).toBe("none");
    expect(h.views.input(h.viewer, { kind: "text", text: "x" })).toBe(false);
    expect(h.calls("clawtrate-computer.input")).toEqual([]);
  });

  it("F-142: sends input to the held tab one call at a time, in order, with the generation, and only while held", async () => {
    let release!: () => void;
    const h = harness({
      "clawtrate-computer.input": () =>
        new Promise((resolve) => (release = () => resolve({ ok: true }))),
    });
    expect(h.views.input(h.viewer, { kind: "text", text: "no" })).toBe(false);
    await granted(h);
    expect(h.views.input(h.viewer, { kind: "click", x: 10, y: 20 })).toBe(true);
    h.views.input(h.viewer, { kind: "text", text: "pa" });
    h.views.input(h.viewer, { kind: "text", text: "ss" });
    h.views.input(h.viewer, { kind: "scroll", x: null, y: null, deltaX: 0, deltaY: 120 });
    await flush();
    expect(h.calls("clawtrate-computer.input")).toHaveLength(1);
    release();
    await flush();
    release();
    await flush();
    release();
    await flush();
    expect(h.calls("clawtrate-computer.input")).toEqual([
      { sessionKey: KEY, targetId: TAB, generation: GEN, kind: "click", x: 10, y: 20 },
      { sessionKey: KEY, targetId: TAB, generation: GEN, kind: "text", text: "pass" },
      { sessionKey: KEY, targetId: TAB, generation: GEN, kind: "scroll", deltaX: 0, deltaY: 120 },
    ]);
    // Nothing typed is kept in the state or logged.
    expect(JSON.stringify(h.state())).not.toContain("pass");
    expect(h.logs.join("")).not.toContain("pass");
  });

  it("keeps at most MAX_QUEUED_INPUTS inputs waiting and drops the rest", async () => {
    const h = harness({ "clawtrate-computer.input": never });
    await granted(h);
    let accepted = 0;
    for (let i = 0; i < MAX_QUEUED_INPUTS + 5; i++)
      if (h.views.input(h.viewer, { kind: "click", x: i, y: i })) accepted += 1;
    // One is on its way; the queue holds the rest up to its bound.
    expect(accepted).toBe(MAX_QUEUED_INPUTS + 1);
  });

  it("F-142: You have control holds only while each renewal confirms the lease; one that does not says control ended, with no cause", async () => {
    vi.useFakeTimers();
    let renewed = true;
    const h = harness({
      "clawtrate-computer.view.renew": (p) => ({
        ok: true,
        renewWithinMs: 20_000,
        streamRenewed: true,
        leaseRenewed: renewed && p.generation === GEN,
      }),
    });
    await granted(h);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.calls("clawtrate-computer.view.renew").at(-1)).toEqual({
      sessionKey: KEY,
      targetId: TAB,
      streamId: "stream-1",
      generation: GEN,
    });
    expect(h.pane().control.status).toBe("granted");
    renewed = false;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.pane().control).toMatchObject({ status: "ended", endCause: null });
  });

  it("F-142: a control event for this lease that it expired or was revoked ends control with its cause; one for another lease changes nothing", async () => {
    const h = harness();
    await granted(h);
    h.views.controlEvent({
      agentId: "pip",
      profile: "bot-pip",
      targetId: TAB,
      holder: "bot",
      state: "expired",
      generation: GEN2,
    });
    expect(h.pane().control.status).toBe("granted");
    h.views.controlEvent({
      agentId: "pip",
      profile: "bot-pip",
      targetId: TAB,
      holder: "bot",
      state: "revoked",
      generation: GEN,
      reason: "connection-closed",
    });
    expect(h.pane().control).toMatchObject({ status: "ended", endCause: "revoked" });
    expect(h.views.input(h.viewer, { kind: "text", text: "x" })).toBe(false);
  });

  it("F-144: every reader keeps the latest control event of each bot's tab, so a read-only device sees someone else hold it", () => {
    const h = harness({}, { write: false });
    h.views.controlEvent({
      agentId: "pip",
      profile: "bot-pip",
      targetId: TAB,
      holder: "user",
      state: "granted",
      generation: GEN,
    });
    h.views.controlEvent({
      agentId: "pip",
      profile: "bot-pip",
      targetId: TAB,
      holder: "bot",
      state: "released",
      generation: GEN,
    });
    expect(h.state().control).toEqual([
      expect.objectContaining({
        agentId: "pip",
        targetId: TAB,
        state: "released",
        generation: GEN,
      }),
    ]);
    // Anything else is not a control event.
    h.views.controlEvent({
      agentId: "pip",
      targetId: "bad id!",
      state: "granted",
      generation: GEN,
    });
    h.views.controlEvent({ agentId: "pip", targetId: TAB, state: "granted", generation: "short" });
    expect(h.state().control).toHaveLength(1);
  });
});

describe("handing back (F-145, section 18)", () => {
  it("F-145: the release is confirmed by its own success: input stops at once, and nothing says Watching until then", async () => {
    let done!: (value: unknown) => void;
    const h = harness({
      "clawtrate-computer.control.release": () => new Promise((resolve) => (done = resolve)),
    });
    await granted(h);
    h.views.release(h.viewer);
    expect(h.pane().control.status).toBe("releasing");
    expect(h.views.input(h.viewer, { kind: "text", text: "x" })).toBe(false);
    done({ state: "released", generation: GEN, targetId: TAB });
    await flush();
    expect(h.pane().control).toMatchObject({ status: "none", released: true });
  });

  it("F-145: a refused release is not proof of ownership: unconfirmed, and Check settles it from a renewal", async () => {
    const h = harness({
      "clawtrate-computer.control.release": () => {
        throw refused("FORBIDDEN", "not_holder");
      },
    });
    await granted(h);
    h.views.release(h.viewer);
    await flush();
    expect(h.pane().control.status).toBe("unconfirmed");
    expect(h.views.input(h.viewer, { kind: "text", text: "x" })).toBe(false);
    await h.views.check(h.viewer);
    expect(h.pane().control).toMatchObject({ status: "granted", stillHeld: true });

    const ended = harness({
      "clawtrate-computer.control.release": () => {
        throw refused("FORBIDDEN", "not_holder");
      },
      "clawtrate-computer.view.renew": () => ({
        ok: true,
        renewWithinMs: 20_000,
        streamRenewed: true,
        leaseRenewed: false,
      }),
    });
    await granted(ended);
    ended.views.release(ended.viewer);
    await flush();
    await ended.views.check(ended.viewer);
    expect(ended.pane().control).toMatchObject({ status: "ended", endCause: null });
  });

  it("F-145: a release that is not answered becomes unconfirmed at its deadline", async () => {
    vi.useFakeTimers();
    const h = harness({ "clawtrate-computer.control.release": never });
    await granted(h);
    h.views.release(h.viewer);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.pane().control.status).toBe("unconfirmed");
  });

  it("F-145: only a released event with this lease's generation confirms the hand-back; another lease's does not", async () => {
    const h = harness({ "clawtrate-computer.control.release": never });
    await granted(h);
    h.views.release(h.viewer);
    h.views.controlEvent({
      agentId: "pip",
      profile: "bot-pip",
      targetId: TAB,
      holder: "bot",
      state: "released",
      generation: GEN2,
    });
    expect(h.pane().control.status).toBe("releasing");
    h.views.controlEvent({
      agentId: "pip",
      profile: "bot-pip",
      targetId: TAB,
      holder: "bot",
      state: "released",
      generation: GEN,
    });
    expect(h.pane().control.status).toBe("none");
  });

  it("F-145: an answer goes only once the release is confirmed, as the option at its place", async () => {
    let done!: (value: unknown) => void;
    const h = harness({
      "clawtrate-computer.control.release": () => new Promise((resolve) => (done = resolve)),
    });
    h.env.question = question();
    await granted(h);
    h.views.release(h.viewer, { answer: { questionId: "ask_1", itemId: "q1", option: 0 } });
    await flush();
    expect(h.answered).toEqual([]);
    expect(h.pane().control).toMatchObject({ status: "releasing", answerQueued: true });
    done({ state: "released", generation: GEN, targetId: TAB });
    await flush();
    expect(h.answered).toEqual([{ key: KEY, id: "ask_1", answers: { q1: [{ option: 0 }] } }]);
    expect(h.pane().control.outcome).toBe("answered");
  });

  it("F-145: a refused release sends no queued answer and says so", async () => {
    const h = harness({
      "clawtrate-computer.control.release": () => {
        throw refused("FORBIDDEN", "not_holder");
      },
    });
    h.env.question = question();
    await granted(h);
    h.views.release(h.viewer, { answer: { questionId: "ask_1", itemId: "q1", option: 1 } });
    await flush();
    expect(h.answered).toEqual([]);
    expect(h.pane().control).toMatchObject({ status: "unconfirmed", outcome: "answer-not-sent" });
  });

  it("F-145: a question that closes while its answer waits removes the answer; the release goes on", async () => {
    let done!: (value: unknown) => void;
    const h = harness({
      "clawtrate-computer.control.release": () => new Promise((resolve) => (done = resolve)),
    });
    h.env.question = question();
    await granted(h);
    h.views.release(h.viewer, { answer: { questionId: "ask_1", itemId: "q1", option: 0 } });
    h.env.question = question({ status: "answered" });
    h.views.questionClosed(KEY, "ask_1", "answered");
    expect(h.pane().control).toMatchObject({
      status: "releasing",
      answerQueued: false,
      outcome: "dropped-answered",
    });
    done({ state: "released", generation: GEN, targetId: TAB });
    await flush();
    expect(h.answered).toEqual([]);
    expect(h.pane().control.outcome).toBe("dropped-answered");

    const r = harness();
    r.env.question = question();
    await granted(r);
    // The client says so once the task's state has the question closed.
    r.env.question = question({ status: "cancelled" });
    r.views.questionClosed(KEY, "ask_1", "run-ended");
    expect(r.pane().control).toMatchObject({ status: "granted", questionGone: "run-ended" });
  });

  it("F-145: a lost connection retires the hand-back: no queued answer is ever sent, and ownership stays unknown until the leases are read again", async () => {
    let done!: (value: unknown) => void;
    let lease: unknown = null;
    const h = harness({
      "clawtrate-computer.control.release": () => new Promise((resolve) => (done = resolve)),
      "clawtrate-computer.tabs": () => tabsAnswer(lease),
    });
    h.env.question = question();
    await granted(h);
    h.views.release(h.viewer, { answer: { questionId: "ask_1", itemId: "q1", option: 0 } });
    h.env.online = false;
    h.views.connectionLost();
    expect(h.pane().control.status).toBe("maybe-held");
    done({ state: "released", generation: GEN, targetId: TAB });
    await flush();
    expect(h.answered).toEqual([]);
    expect(h.pane().control.status).toBe("maybe-held");
    // Back: the browser's leases are read before anything is offered.
    h.env.online = true;
    lease = { state: "granted", mine: false };
    h.views.reconnected();
    expect(h.pane().control.status).toBe("checking");
    h.views.hello(["clawtrate-computer.tabs"]);
    await flush();
    expect(h.pane().control.status).toBe("maybe-held");
    lease = null;
    await h.views.readTabs(h.viewer);
    expect(h.pane().control.status).toBe("ended");
    expect(h.answered).toEqual([]);
  });

  it("F-150: after a drop, a lookup that couldn't see the browser settles nothing; a lease this connection holds is not the old one", async () => {
    let answer: unknown = tabsAnswer();
    const h = harness({ "clawtrate-computer.tabs": () => answer });
    await granted(h);
    h.env.online = false;
    h.views.connectionLost();
    answer = { ...tabsAnswer(), browser: "not-running", reason: "discovery_timeout", tabs: [] };
    h.env.online = true;
    h.views.reconnected();
    h.views.hello(["clawtrate-computer.tabs"]);
    await flush();
    expect(h.pane().browser).toBe("unknown");
    expect(h.pane().control.status).toBe("checking");
    // Another viewer of this app took the tab on the new connection: the old lease ended.
    answer = tabsAnswer({ state: "granted", mine: true });
    await h.views.readTabs(h.viewer);
    expect(h.pane().control.status).toBe("ended");
    // So another tab can be taken.
    answer = tabsAnswer({ state: "granted", mine: true }, [
      { targetId: OTHER, url: "http://127.0.0.1:1/other", title: "Other", lease: null },
    ]);
    await h.views.readTabs(h.viewer);
    h.views.choose(h.viewer, OTHER);
    await h.views.take(h.viewer);
    expect(h.calls("clawtrate-computer.control.take").at(-1)).toEqual({
      sessionKey: KEY,
      targetId: OTHER,
    });
  });
});

describe("the tab shown and the tab watched", () => {
  it("F-142: while a tab is watched it stays the one shown, even when a list leaves it out for a while", async () => {
    const other = { targetId: OTHER, url: "http://127.0.0.1:1/other", title: "Other", lease: null };
    let answer: unknown = tabsAnswer(null, [other]);
    const h = harness({ "clawtrate-computer.tabs": () => answer });
    await ready(h);
    h.views.choose(h.viewer, OTHER);
    await h.views.watch(h.viewer);
    h.streams.at(-1)!.frame();
    const both = answer;
    answer = { ...tabsAnswer(), browser: "not-running", reason: "discovery_timeout", tabs: [] };
    await h.views.readTabs(h.viewer);
    answer = tabsAnswer();
    await h.views.readTabs(h.viewer);
    answer = both;
    await h.views.readTabs(h.viewer);
    expect(h.pane().view).toMatchObject({ targetId: OTHER, status: "live" });
    expect(h.pane().shown).toBe(OTHER);
    await h.views.take(h.viewer);
    expect(h.calls("clawtrate-computer.control.take").at(-1)).toEqual({
      sessionKey: KEY,
      targetId: OTHER,
    });
  });

  it("F-142: a watched tab that moves past the tabs kept stays the one shown, and Take asks for it", async () => {
    const other = { targetId: OTHER, url: "http://127.0.0.1:1/other", title: "Other", lease: null };
    let answer: unknown = tabsAnswer(null, [other]);
    const h = harness({ "clawtrate-computer.tabs": () => answer });
    await ready(h);
    h.views.choose(h.viewer, OTHER);
    await h.views.watch(h.viewer);
    h.streams.at(-1)!.frame();
    // Sixteen tabs opened before it: the watched one is the seventeenth, past the list kept.
    const filler = Array.from({ length: 15 }, (_, i) => ({
      targetId: `TAB${String(i).padStart(29, "0")}C`,
      url: `http://127.0.0.1:1/${i}`,
      title: `Tab ${i}`,
      lease: null,
    }));
    answer = tabsAnswer(null, [...filler, other]);
    await h.views.readTabs(h.viewer);
    expect(h.pane().tabs.some((tab) => tab.targetId === OTHER)).toBe(false);
    expect(h.pane().view).toMatchObject({ targetId: OTHER, status: "live" });
    expect(h.pane().shown).toBe(OTHER);
    await h.views.take(h.viewer);
    expect(h.calls("clawtrate-computer.control.take").at(-1)).toEqual({
      sessionKey: KEY,
      targetId: OTHER,
    });
  });

  it("F-142: input goes nowhere while the picture shows another tab than the one held", async () => {
    const h = harness();
    await granted(h);
    // The view's tab changed under the lease (as a stream replaced on another tab would).
    (h.views as unknown as { lives: Map<string, { view: { targetId: string } }> }).lives.get(
      h.viewer,
    )!.view.targetId = OTHER;
    expect(h.views.input(h.viewer, { kind: "text", text: "x" })).toBe(false);
    expect(h.calls("clawtrate-computer.input")).toEqual([]);
  });

  it("F-142: a lookup that lists nothing while a tab is watched leaves Take on the watched tab once the list is back", async () => {
    let answer: unknown = tabsAnswer(null, [
      { targetId: OTHER, url: "http://127.0.0.1:1/other", title: "Other", lease: null },
    ]);
    const h = harness({ "clawtrate-computer.tabs": () => answer });
    await ready(h);
    h.views.choose(h.viewer, OTHER);
    await h.views.watch(h.viewer);
    h.streams.at(-1)!.frame();
    expect(h.pane().view).toMatchObject({ targetId: OTHER, status: "live" });
    const listed = answer;
    answer = { ...tabsAnswer(), browser: "not-running", reason: "discovery_timeout", tabs: [] };
    await h.views.readTabs(h.viewer);
    answer = listed;
    await h.views.readTabs(h.viewer);
    expect(h.pane().shown).toBe(OTHER);
    await h.views.take(h.viewer);
    expect(h.calls("clawtrate-computer.control.take").at(-1)).toEqual({
      sessionKey: KEY,
      targetId: OTHER,
    });
  });
});

describe("leaving (section 17, How a view ends; section 18, Leaving while in control)", () => {
  it("leaving gives control back first, then ends the view at once", async () => {
    const h = harness();
    await granted(h);
    h.views.leave(h.viewer);
    expect(h.calls("clawtrate-computer.control.release")).toEqual([
      { sessionKey: KEY, targetId: TAB, generation: GEN },
    ]);
    expect(h.pane().view).toBeNull();
    expect(h.streams[0]!.closed).toBe(1000);
    await flush();
    expect(h.pane().control.status).toBe("none");
  });

  it("leaving with the hand-back unconfirmed stops renewing and keeps one line on the tab until it is settled", async () => {
    vi.useFakeTimers();
    const h = harness({
      "clawtrate-computer.control.release": () => {
        throw refused("FORBIDDEN", "not_holder");
      },
    });
    await granted(h);
    h.views.release(h.viewer);
    await vi.advanceTimersByTimeAsync(0);
    h.views.leave(h.viewer);
    expect(h.pane().control).toMatchObject({
      status: "unconfirmed",
      outOfSight: true,
      renewWithinMs: 20_000,
    });
    const renewals = h.calls("clawtrate-computer.view.renew").length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.calls("clawtrate-computer.view.renew")).toHaveLength(renewals);
    // Switching task keeps the line.
    h.views.show(h.viewer, "agent:pip:other");
    expect(h.pane().control).toMatchObject({ status: "unconfirmed", outOfSight: true, key: KEY });
  });

  it("switching task while in control keeps the hand-back on the tab it came from, and offers Release again if it is not confirmed", async () => {
    vi.useFakeTimers();
    const h = harness({
      "clawtrate-computer.control.release": () => {
        throw refused("FORBIDDEN", "not_holder");
      },
    });
    await granted(h);
    h.views.show(h.viewer, "agent:pip:other");
    expect(h.pane().control).toMatchObject({ status: "releasing", outOfSight: true, key: KEY });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.pane().control).toMatchObject({ status: "unconfirmed", outOfSight: true, key: KEY });
  });

  it("a Check still out when the viewer leaves the tab changes nothing there: no renewing for a tab out of sight", async () => {
    vi.useFakeTimers();
    let renewed!: (value: unknown) => void;
    let held = false;
    const h = harness({
      "clawtrate-computer.control.release": () => {
        throw refused("FORBIDDEN", "not_holder");
      },
      "clawtrate-computer.view.renew": () =>
        held ? new Promise((resolve) => (renewed = resolve)) : { leaseRenewed: true },
    });
    await granted(h);
    h.views.release(h.viewer);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.pane().control.status).toBe("unconfirmed");
    held = true;
    const checking = h.views.check(h.viewer);
    h.views.leave(h.viewer);
    renewed({ leaseRenewed: true, viewRenewed: true });
    await checking;
    expect(h.pane().control).toMatchObject({ status: "unconfirmed", outOfSight: true });
    const renewals = h.calls("clawtrate-computer.view.renew").length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.calls("clawtrate-computer.view.renew")).toHaveLength(renewals);
  });

  it("F-149: switching gateways drops the Stop line, and a Stop still out changes nothing on the new gateway", async () => {
    const h = harness();
    await ready(h);
    let answer!: (value: StopAnswer) => void;
    h.ctx.stopTask = vi.fn(() => new Promise<StopAnswer>((resolve) => (answer = resolve)));
    const stopping = h.views.stopTask(h.viewer);
    expect(h.pane().stop).toMatchObject({ sending: true });
    h.views.reset();
    expect(h.pane().stop).toBeNull();
    answer({ runIds: ["run-1"], aborted: null });
    await stopping;
    expect(h.pane().stop).toBeNull();
  });

  it("a Check started with the hand-back already out of sight is retired when the viewer leaves again", async () => {
    vi.useFakeTimers();
    let renewed!: (value: unknown) => void;
    let held = false;
    const h = harness({
      "clawtrate-computer.control.release": () => {
        throw refused("FORBIDDEN", "not_holder");
      },
      "clawtrate-computer.view.renew": () =>
        held ? new Promise((resolve) => (renewed = resolve)) : { leaseRenewed: true },
    });
    await granted(h);
    h.views.release(h.viewer);
    await vi.advanceTimersByTimeAsync(0);
    h.views.leave(h.viewer);
    // Back on Computer: the unconfirmed hand-back is still out of sight; Check, then leave.
    h.views.show(h.viewer, KEY);
    expect(h.pane().control).toMatchObject({ status: "unconfirmed", outOfSight: true });
    held = true;
    const checking = h.views.check(h.viewer);
    h.views.leave(h.viewer);
    renewed({ leaseRenewed: true, viewRenewed: true });
    await checking;
    expect(h.pane().control).toMatchObject({ status: "unconfirmed", outOfSight: true });
    const renewals = h.calls("clawtrate-computer.view.renew").length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.calls("clawtrate-computer.view.renew")).toHaveLength(renewals);
  });

  it("a Check refused as the tab gone, arriving after the viewer left and a later hand-back began, ends nothing", async () => {
    vi.useFakeTimers();
    let reject!: (error: unknown) => void;
    let releases = 0;
    let held = false;
    const h = harness({
      "clawtrate-computer.control.release": () => {
        releases += 1;
        if (releases === 1) throw refused("FORBIDDEN", "not_holder");
        return never();
      },
      "clawtrate-computer.view.renew": () =>
        held ? new Promise((_resolve, fail) => (reject = fail)) : { leaseRenewed: true },
    });
    await granted(h);
    h.views.release(h.viewer);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.pane().control.status).toBe("unconfirmed");
    held = true;
    const checking = h.views.check(h.viewer);
    h.views.leave(h.viewer);
    // Back, and giving control back again: that hand-back is on its way.
    h.views.show(h.viewer, KEY);
    h.views.release(h.viewer);
    expect(h.pane().control.status).toBe("releasing");
    reject(refused("UNAVAILABLE", "tab_not_in_bots_browser"));
    await checking;
    expect(h.pane().control).toMatchObject({ status: "releasing", key: KEY });
    expect(h.views.input(h.viewer, { kind: "text", text: "x" })).toBe(false);
  });

  it("a viewer that goes away gives control back and leaves no pane", async () => {
    const h = harness();
    await granted(h);
    h.views.dispose(h.viewer);
    expect(h.calls("clawtrate-computer.control.release")).toHaveLength(1);
    expect(h.state().panes).toEqual({});
  });

  it("F-149: Stop in this task goes through the conversation's Stop and keeps only what the gateway answered", async () => {
    const h = harness();
    h.ctx.stopTask = vi.fn(async () => ({ runIds: ["run-1"], aborted: null }));
    await ready(h);
    await h.views.stopTask(h.viewer);
    expect(h.ctx.stopTask).toHaveBeenCalledWith(KEY, null);
    expect(h.pane().stop).toEqual({
      sending: false,
      runIds: ["run-1"],
      aborted: null,
      error: null,
    });
    const refusedStop = harness();
    refusedStop.ctx.stopTask = vi.fn(async () => {
      throw refused("FORBIDDEN", "not_allowed");
    });
    await ready(refusedStop);
    await refusedStop.views.stopTask(refusedStop.viewer);
    expect(refusedStop.pane().stop).toMatchObject({
      sending: false,
      error: "refused: not_allowed",
    });
  });

  it("F-149: says Stopped only from each run's own end; a refused stop, one still stopping and an abort of nothing are not a stop", () => {
    const run = (state: Run["state"], stopError: string | null = null, outcomeKnown = true) => ({
      id: "run-1",
      state,
      stopError,
      outcomeKnown,
    });
    const asked = { sending: false, runIds: ["run-1"], aborted: null, error: null };
    expect(stopProgress(null, [])).toEqual({ kind: "none" });
    expect(stopProgress({ ...asked, sending: true }, [run("running")])).toEqual({
      kind: "sending",
    });
    // Accepted, the run still stopping: the composer's own Stop says Stopping.
    expect(stopProgress(asked, [run("stopping")])).toEqual({ kind: "stopping" });
    // Refused: the run goes back to running, with the gateway's refusal.
    expect(stopProgress(asked, [run("running", "Not allowed.")])).toEqual({
      kind: "refused",
      error: "Not allowed.",
    });
    expect(stopProgress(asked, [run("stopped")])).toEqual({ kind: "stopped" });
    // Stopped by this client's inference, with nothing showing how it ended: not a confirmed stop.
    expect(stopProgress(asked, [run("stopped", null, false)])).toEqual({ kind: "ended" });
    expect(stopProgress(asked, [run("completed")])).toEqual({ kind: "ended" });
    expect(stopProgress(asked, [])).toEqual({ kind: "stopping" });
    const none = { sending: false, runIds: [], aborted: false, error: null };
    expect(stopProgress(none, [])).toEqual({ kind: "nothing" });
    expect(stopProgress({ ...none, aborted: true }, [])).toEqual({ kind: "accepted" });
  });
});

describe("frames", () => {
  it("reads the plugin's frame layout and refuses anything else", () => {
    expect(parseFrame(frameBytes(756, 413, 10))?.header).toEqual({
      url: "http://127.0.0.1:1/p",
      cssWidth: 756,
      cssHeight: 413,
      capturedAt: null,
    });
    expect(parseFrame(frameBytes(756, 413, 10, 1_800_000_000.25))?.header.capturedAt).toBe(
      1_800_000_000_250,
    );
    expect(parseFrame(new Uint8Array([0, 0, 0, 2, 123, 125, 1, 2]))).toBeNull();
    const notJpeg = frameBytes(10, 10, 10);
    notJpeg[notJpeg.length - 10] = 0;
    expect(parseFrame(notJpeg)).toBeNull();
  });
});

describe("renewing within the plugin's own deadline", () => {
  it("F-142: renews a view at a quarter of the renewal time the plugin gives, timed from each renewal's start however slowly it is answered", async () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    const h = harness({
      "clawtrate-computer.view.open": () => ({
        streamId: "stream-1",
        wsPath: `/clawtrate-computer/stream?ticket=${TICKET}`,
        renewWithinMs: 6_000,
        targetId: TAB,
      }),
      // Each renewal takes four seconds to be answered.
      "clawtrate-computer.view.renew": () => {
        sent.push(Date.now());
        return new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({ ok: true, renewWithinMs: 6_000, streamRenewed: true, leaseRenewed: false }),
            4_000,
          ),
        );
      },
    });
    await live(h);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(sent.length).toBeGreaterThanOrEqual(7);
    const gaps = sent.slice(1).map((at, i) => at - sent[i]!);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(1_500);
    expect(h.pane().view?.status).toBe("live");
  });
});

describe("Live only while a usable picture is recent (F-142, section 17)", () => {
  it("F-142: Live while a usable frame was drawn within the stated interval; after it the last picture and its age", () => {
    expect(LIVE_FOR_MS).toBe(10_000);
    expect(pictureAge(null, 50_000)).toEqual({ kind: "none" });
    expect(pictureAge({ at: 40_000, capturedAt: null }, 50_000)).toEqual({ kind: "live" });
    expect(pictureAge({ at: 40_000, capturedAt: null }, 50_001)).toEqual({
      kind: "last",
      ageMs: 10_001,
    });
    // A frame captured long before it was drawn is as old as its capture.
    expect(pictureAge({ at: 49_000, capturedAt: 30_000 }, 50_000)).toEqual({
      kind: "last",
      ageMs: 20_000,
    });
  });

  it("F-142: the last picture's age in seconds, then minutes", () => {
    expect(words.lastPictureLine(10_001)).toBe("Last picture, 10 s ago");
    expect(words.lastPictureLine(61_000)).toBe("Last picture, 1 min ago");
    expect(words.lastPictureLine(3_700_000)).toBe("Last picture, over an hour ago");
  });

  it("F-142: the pane keeps the newest usable frame's capture time; a frame too large, or renewals, change nothing", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const h = harness();
    await ready(h);
    await h.views.watch(h.viewer);
    const stream = h.streams.at(-1)!;
    stream.frame(1280, 720, 64, 1_799_999_999.5);
    expect(h.pane().view).toMatchObject({
      status: "live",
      capturedAt: 1_799_999_999_500,
      frameAt: 1_800_000_000_000,
    });
    const frame = await h.views.frame(h.viewer, h.pane().view!.n, 0);
    expect(frame).toMatchObject({ seq: 1, capturedAt: 1_799_999_999_500 });
    // 30 s on: renewals confirm the stream, a frame too large arrives, nothing usable does.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.calls("clawtrate-computer.view.renew").length).toBeGreaterThan(0);
    stream.frame(1280, 720, MAX_FRAME_BYTES + 1, 1_800_000_029.9);
    expect(h.pane().view).toMatchObject({
      frame: 1,
      framesTooLarge: 1,
      capturedAt: 1_799_999_999_500,
      frameAt: 1_800_000_000_000,
    });
    // A header without the screencast's time gives none, never this host's clock.
    stream.frame(1280, 720, 64, 0);
    expect(h.pane().view).toMatchObject({ frame: 2, capturedAt: null });
  });
});

describe("control only while renewals confirm it (F-142, section 18)", () => {
  it("F-142: a refused renewal stops input at once and says control isn't confirmed; a renewal that confirms it gives it back", async () => {
    vi.useFakeTimers();
    let answer: "refuse" | "renew" = "renew";
    const h = harness({
      "clawtrate-computer.view.renew": (p) => {
        if (answer === "refuse") throw refused("UNAVAILABLE", "gateway_busy");
        return {
          ok: true,
          renewWithinMs: 20_000,
          streamRenewed: true,
          leaseRenewed: p.generation === GEN,
        };
      },
    });
    await granted(h);
    expect(h.views.input(h.viewer, { kind: "text", text: "a" })).toBe(true);
    answer = "refuse";
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.pane().control.status).toBe("unverified");
    expect(h.views.input(h.viewer, { kind: "text", text: "b" })).toBe(false);
    answer = "renew";
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.pane().control).toMatchObject({ status: "granted", stillHeld: true });
    expect(h.views.input(h.viewer, { kind: "text", text: "c" })).toBe(true);
  });

  it("F-142: with renewals unanswered, input stops by the local cutoff, before the lease's own deadline and with no expiry event", async () => {
    vi.useFakeTimers();
    const h = harness({
      "clawtrate-computer.control.take": (p) => ({
        state: "granted",
        generation: GEN,
        renewWithinMs: 6_000,
        targetId: p.targetId,
        guarantee: [],
      }),
      "clawtrate-computer.view.renew": () => never(),
    });
    await granted(h);
    await vi.advanceTimersByTimeAsync(4_400);
    expect(h.pane().control.status).toBe("granted");
    // 0.75 of the 6 s deadline since the grant, the last confirmation: before any renewal gave up.
    await vi.advanceTimersByTimeAsync(200);
    expect(h.pane().control.status).toBe("unverified");
    expect(h.views.input(h.viewer, { kind: "text", text: "after the cutoff" })).toBe(false);
    // Still not "ended": nothing established that either.
    await vi.advanceTimersByTimeAsync(21_000);
    expect(h.pane().control.status).toBe("unverified");
  });

  it("F-142: Check reads it: renewed is You still have control, not renewed is control ended; giving it back works from there", async () => {
    vi.useFakeTimers();
    let renewed = true;
    let refuse = true;
    const h = harness({
      "clawtrate-computer.view.renew": (p) => {
        if (refuse) throw refused("UNAVAILABLE", "gateway_busy");
        return {
          ok: true,
          renewWithinMs: 20_000,
          streamRenewed: true,
          leaseRenewed: renewed && p.generation === GEN,
        };
      },
    });
    await live(h);
    refuse = false;
    await h.views.take(h.viewer);
    refuse = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.pane().control.status).toBe("unverified");
    refuse = false;
    await h.views.check(h.viewer);
    expect(h.pane().control).toMatchObject({ status: "granted", stillHeld: true });
    refuse = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.pane().control.status).toBe("unverified");
    refuse = false;
    renewed = false;
    await h.views.check(h.viewer);
    expect(h.pane().control.status).toBe("ended");
  });
});

describe("leaving Computer leaves the view closed (section 17)", () => {
  it("after leave, neither Watch nor Take control asks the gateway for anything until the tab is shown again", async () => {
    const h = harness();
    await ready(h);
    h.views.leave(h.viewer);
    const before = h.requests.length;
    await h.views.watch(h.viewer);
    await h.views.take(h.viewer);
    await flush();
    expect(h.requests.slice(before).map((r) => r.method)).toEqual([]);
    expect(h.pane().view).toBeNull();
    h.views.show(h.viewer, KEY);
    await flush();
    await h.views.watch(h.viewer);
    expect(h.calls("clawtrate-computer.view.open")).toHaveLength(1);
  });
});

describe("an answer belongs to its own pane and hand-back (F-145, section 18)", () => {
  it("F-145: a late result of an earlier task's answer never changes the pane now shown, nor a control taken since", async () => {
    let finishAnswer!: () => void;
    const h = harness();
    h.ctx.answer = () => new Promise<void>((resolve) => (finishAnswer = resolve));
    h.env.question = question();
    await granted(h);
    h.views.release(h.viewer, { answer: { questionId: "ask_1", itemId: "q1", option: 0 } });
    await flush();
    expect(h.pane().control.status).toBe("answering");
    // The person switches to another of Pip's tasks and takes control there.
    h.views.show(h.viewer, "agent:pip:another-task");
    await flush();
    await h.views.watch(h.viewer);
    h.streams.at(-1)!.frame();
    await h.views.take(h.viewer);
    expect(h.pane().control.status).toBe("granted");
    finishAnswer();
    await flush();
    expect(h.pane().key).toBe("agent:pip:another-task");
    expect(h.pane().control).toMatchObject({ status: "granted", outcome: null });
    expect(h.views.input(h.viewer, { kind: "text", text: "still mine" })).toBe(true);
  });

  it("F-145: a failed answer's late result does not change a pane shown for another task either", async () => {
    let failAnswer!: (error: Error) => void;
    const h = harness();
    h.ctx.answer = () => new Promise<void>((_resolve, reject) => (failAnswer = reject));
    h.env.question = question();
    await granted(h);
    h.views.release(h.viewer, { answer: { questionId: "ask_1", itemId: "q1", option: 0 } });
    await flush();
    h.views.show(h.viewer, "agent:pip:another-task");
    await flush();
    failAnswer(new Error("refused"));
    await flush();
    expect(h.pane().control).toMatchObject({ status: "none", outcome: null });
  });
});

describe("closing edits: tab choice, competing takes, confirmation in time, hand-back and refusals", () => {
  it("choosing another tab while Computer stays shown ends the old view and opens one on the new tab, and a take there goes to the new tab", async () => {
    const h = harness({
      "clawtrate-computer.tabs": () =>
        tabsAnswer(null, [
          { targetId: OTHER, url: "http://127.0.0.1:1/b", title: "B", lease: null },
        ]),
      "clawtrate-computer.view.open": (p) => ({
        streamId: `stream-${String(p.targetId).slice(-1)}`,
        wsPath: `/clawtrate-computer/stream?ticket=${TICKET}`,
        expiresAtMs: Date.now() + 60_000,
        renewWithinMs: 20_000,
        targetId: p.targetId,
      }),
    });
    await live(h);
    h.views.choose(h.viewer, OTHER);
    await flush();
    expect(h.calls("clawtrate-computer.view.open").map((p) => p.targetId)).toEqual([TAB, OTHER]);
    expect(h.pane().view).toMatchObject({ targetId: OTHER });
    await h.views.take(h.viewer);
    expect(h.calls("clawtrate-computer.control.take")).toEqual([
      { sessionKey: KEY, targetId: OTHER },
    ]);
    expect(h.pane().control).toMatchObject({ status: "granted", targetId: OTHER });

    // An ended view of the old tab is not shown for the new one: no view is open there.
    const e = harness({
      "clawtrate-computer.tabs": () =>
        tabsAnswer(null, [
          { targetId: OTHER, url: "http://127.0.0.1:1/b", title: "B", lease: null },
        ]),
    });
    await live(e);
    e.streams.at(-1)!.end(4006);
    expect(e.pane().view?.status).toBe("ended");
    e.views.choose(e.viewer, OTHER);
    expect(e.pane()).toMatchObject({ shown: OTHER, view: null });
  });

  it("with the six-second development lease and no expiry event, a renewal confirmed after its own deadline doesn't give control back: input stays stopped", async () => {
    vi.useFakeTimers();
    let answer!: (value: unknown) => void;
    let renewals = 0;
    const h = harness({
      "clawtrate-computer.view.renew": (p) => {
        renewals += 1;
        // The renewal sent at 1.5 s is answered, positively, only at 6.4 s.
        if (renewals === 1 && p.generation === GEN)
          return new Promise((resolve) => (answer = resolve));
        return new Promise(() => {});
      },
      "clawtrate-computer.control.take": (p) => ({
        state: "granted",
        generation: GEN,
        renewWithinMs: 6_000,
        targetId: p.targetId,
        guarantee: [],
      }),
    });
    await live(h);
    // The view's renewals are the stream's own: this check is about the lease.
    h.views.stopWatching(h.viewer);
    await h.views.take(h.viewer);
    expect(h.pane().control.status).toBe("granted");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(renewals).toBe(1);
    // 0.75 of 6 s after the grant was asked for: input has stopped.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.pane().control.status).toBe("unverified");
    await vi.advanceTimersByTimeAsync(1_900);
    answer({ ok: true, renewWithinMs: 6_000, streamRenewed: false, leaseRenewed: true });
    // As the late reply lands, too: it never restores control, not even for a moment.
    await vi.advanceTimersByTimeAsync(0);
    expect(h.pane().control.status).toBe("unverified");
    expect(h.views.input(h.viewer, { kind: "text", text: "late" })).toBe(false);
    await vi.advanceTimersByTimeAsync(1_200);
    // 7.6 s: the plugin's deadline (7.5 s) has passed; nothing here says control is held.
    expect(h.pane().control.status).toBe("unverified");
    expect(h.views.input(h.viewer, { kind: "text", text: "late" })).toBe(false);
  });

  it("a grant that took longer than its confirmation can count isn't control until a renewal sent after it confirms it", async () => {
    vi.useFakeTimers();
    let renewed!: (value: unknown) => void;
    const h = harness({
      "clawtrate-computer.view.renew": (p) =>
        p.generation === GEN
          ? new Promise((resolve) => (renewed = resolve))
          : { ok: true, renewWithinMs: 20_000, streamRenewed: true, leaseRenewed: false },
      "clawtrate-computer.control.take": (p) =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                state: "granted",
                generation: GEN,
                renewWithinMs: 6_000,
                targetId: p.targetId,
                guarantee: [],
              }),
            5_000,
          ),
        ),
    });
    await live(h);
    const taking = h.views.take(h.viewer);
    await vi.advanceTimersByTimeAsync(5_000);
    await taking;
    // 5 s since the take was sent: past 0.75 of the 6 s lease, so no control yet.
    expect(h.pane().control.status).toBe("unverified");
    expect(h.views.input(h.viewer, { kind: "text", text: "x" })).toBe(false);
    // The renewal sent at once confirms it.
    expect(h.calls("clawtrate-computer.view.renew").some((p) => p.generation === GEN)).toBe(true);
    renewed({ ok: true, renewWithinMs: 6_000, streamRenewed: true, leaseRenewed: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.pane().control).toMatchObject({ status: "granted", stillHeld: false });
  });

  it("Stop watching gives back control that isn't confirmed (unverified or unconfirmed) and renews nothing after", async () => {
    vi.useFakeTimers();
    let renewOk = true;
    let releaseOk = false;
    const h = harness({
      "clawtrate-computer.view.renew": (p) => {
        if (!renewOk) throw refused("UNAVAILABLE", "busy");
        return {
          ok: true,
          renewWithinMs: 6_000,
          streamRenewed: p.streamId === "stream-1",
          leaseRenewed: p.generation === GEN,
        };
      },
      "clawtrate-computer.control.release": (p) => {
        if (!releaseOk) throw refused("FORBIDDEN", "not_holder");
        return { state: "released", generation: p.generation, targetId: p.targetId };
      },
      "clawtrate-computer.control.take": (p) => ({
        state: "granted",
        generation: GEN,
        renewWithinMs: 6_000,
        targetId: p.targetId,
        guarantee: [],
      }),
    });
    await granted(h);
    renewOk = false;
    await vi.advanceTimersByTimeAsync(1_500);
    expect(h.pane().control.status).toBe("unverified");
    h.views.stopWatching(h.viewer);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls("clawtrate-computer.control.release")).toHaveLength(1);
    expect(h.pane().control.status).toBe("unconfirmed");
    const renewed = h.calls("clawtrate-computer.view.renew").length;
    // Unconfirmed: Stop watching asks again, and still nothing renews it.
    releaseOk = true;
    h.views.stopWatching(h.viewer);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.calls("clawtrate-computer.control.release")).toHaveLength(2);
    expect(h.pane().control.status).toBe("none");
    expect(h.calls("clawtrate-computer.view.renew")).toHaveLength(renewed);
  });

  it("F-145: a release answer for another lease confirms nothing, and the queued answer isn't sent", async () => {
    const h = harness({
      "clawtrate-computer.control.release": (p) => ({
        state: "released",
        generation: GEN2,
        targetId: p.targetId,
      }),
    });
    h.env.question = question();
    await granted(h);
    h.views.release(h.viewer, { answer: { questionId: "ask_1", itemId: "q1", option: 0 } });
    await flush();
    expect(h.answered).toEqual([]);
    expect(h.pane().control).toMatchObject({ status: "unconfirmed", outcome: "answer-not-sent" });
  });

  it("F-142: a renewal that times out after a later one confirmed the lease changes nothing", async () => {
    vi.useFakeTimers();
    let renewals = 0;
    // A 5 s lease: renewals go 1.25 s apart, so the first one's 5 s deadline passes after the
    // second and third answered.
    const h = harness({
      "clawtrate-computer.view.renew": (p) => {
        renewals += 1;
        if (renewals === 1) return new Promise(() => {});
        return {
          ok: true,
          renewWithinMs: 5_000,
          streamRenewed: p.streamId === "stream-1",
          leaseRenewed: true,
        };
      },
      "clawtrate-computer.control.take": () => ({
        state: "granted",
        generation: GEN,
        renewWithinMs: 5_000,
        targetId: TAB,
        guarantee: [],
      }),
    });
    await granted(h);
    await vi.advanceTimersByTimeAsync(6_400);
    expect(renewals).toBeGreaterThanOrEqual(4);
    expect(h.pane().control.status).toBe("granted");
  });

  it("F-145: a confirmed hand-back whose question can't be read sends no answer and keeps renewing the view", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.env.question = question();
    await granted(h);
    h.views.release(h.viewer, { answer: { questionId: "ask_1", itemId: "q1", option: 0 } });
    h.env.question = null;
    await vi.advanceTimersByTimeAsync(0);
    expect(h.pane().control.outcome).toBe("question-unknown");
    expect(h.pane().view?.status).toBe("live");
    const renewals = h.calls("clawtrate-computer.view.renew").length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.calls("clawtrate-computer.view.renew").length).toBeGreaterThan(renewals);
    expect(h.answered).toEqual([]);
  });

  it("F-145: another question of the task closing keeps the queued answer; a question whose state can't be read is not answered", async () => {
    let done!: (value: unknown) => void;
    const h = harness({
      "clawtrate-computer.control.release": () => new Promise((resolve) => (done = resolve)),
    });
    h.env.question = question();
    await granted(h);
    h.views.release(h.viewer, { answer: { questionId: "ask_1", itemId: "q1", option: 0 } });
    h.views.questionClosed(KEY, "ask_other", "answered");
    expect(h.pane().control).toMatchObject({
      status: "releasing",
      answerQueued: true,
      outcome: null,
    });
    // The question's state is gone from the task: the answer isn't sent.
    h.env.question = null;
    done({ state: "released", generation: GEN, targetId: TAB });
    await flush();
    expect(h.answered).toEqual([]);
    expect(h.pane().control.outcome).toBe("question-unknown");
    expect(words.outcomeLine("Pip", "question-unknown")).toBe(
      "Couldn't confirm the question is still pending. Your answer wasn't sent.",
    );
    expect(words.outcomeLine("Pip", "already-answered")).toBe(
      "Pip's question was already answered.",
    );
    expect(words.outcomeLine("Pip", "answer-failed")).toBe(
      "This device gave back control. The gateway didn't confirm your answer. Check the question in chat.",
    );
  });

  it("only known refusal causes count toward the three in a row; an unknown cause starts the count again", async () => {
    let cause: string | null = "browser-not-quiet";
    const h = harness({
      "clawtrate-computer.control.take": () => ({
        state: "busy",
        reason: "a sentence",
        ...(cause ? { cause } : {}),
        runningCalls: 0,
        generation: GEN,
      }),
    });
    await live(h);
    cause = "something-new";
    for (let i = 0; i < 3; i++) await h.views.take(h.viewer);
    expect(h.pane().control).toMatchObject({ busyReason: null, busyCount: 0 });
    cause = "browser-not-quiet";
    for (let i = 0; i < 3; i++) await h.views.take(h.viewer);
    expect(h.pane().control).toMatchObject({ busyReason: "browser-not-quiet", busyCount: 3 });
    expect(words.busyLine("Pip", "browser-not-quiet")).toBe(
      "A page in Pip's browser is still loading.",
    );
    expect(words.busyLine("Pip", "download-in-progress")).toBe(
      "A download in Pip's browser is still in progress.",
    );
    expect(words.waitingLine("Pip")).toBe("Waiting for the gateway to confirm control…");
  });

  it("a tab list the plugin couldn't read is not an empty browser", async () => {
    let reason = "discovery_timeout";
    const h = harness({
      "clawtrate-computer.tabs": () => ({
        agentId: "pip",
        profile: "bot-pip",
        browser: "not-running",
        reason,
        tabs: [],
      }),
    });
    await ready(h);
    expect(h.pane()).toMatchObject({ browser: "unknown", tabs: [] });
    reason = "browser_unavailable";
    await h.views.readTabs(h.viewer);
    expect(h.pane()).toMatchObject({ browser: "not-running", tabs: [] });
  });

  it("an exec approval's target is the gateway's machine only when it named the gateway", () => {
    expect(words.approvalTargetLine("gateway", null)).toBe("the gateway's machine");
    expect(words.approvalTargetLine(null, null)).toBe("Machine not reported.");
    expect(words.approvalTargetLine("node", "media-box")).toBe("media-box");
    expect(words.approvalTargetLine("node", null)).toBe("a node");
  });

  it("a stop whose answer doesn't say whether it aborted anything is unconfirmed, not 'nothing stopped'", () => {
    const stop = { sending: false, runIds: [], aborted: null, error: null };
    expect(stopProgress(stop, [])).toEqual({ kind: "unconfirmed" });
    expect(stopProgress({ ...stop, aborted: false }, [])).toEqual({ kind: "nothing" });
    expect(words.nothingToStopLine("Pip")).toBe(
      "The gateway reported no runs stopped in this task.",
    );
    expect(words.stopUnconfirmedLine).toBe("The gateway didn't confirm the stop.");
  });
});

describe("lease recovery across a task switch (F-150, section 18)", () => {
  it("F-150: switching task while a drop's lease is being checked keeps it, settles it from its own task, then Take asks again", async () => {
    let oldRead!: (value: unknown) => void;
    let hold = false;
    let lease: unknown = null;
    const h = harness({
      "clawtrate-computer.tabs": (p) =>
        hold && p.sessionKey === KEY
          ? new Promise((resolve) => (oldRead = resolve))
          : tabsAnswer(p.sessionKey === KEY ? lease : null),
    });
    await granted(h);
    h.env.online = false;
    h.views.connectionLost();
    h.env.online = true;
    h.views.reconnected();
    hold = true;
    h.views.hello(["clawtrate-computer.tabs"]);
    await flush();
    expect(h.pane().control.status).toBe("checking");
    // Another task before the old task's read answers: the new task's list says nothing of it.
    hold = false;
    lease = { state: "granted", mine: false };
    h.views.show(h.viewer, "agent:marlow:other");
    await flush();
    oldRead(tabsAnswer(null));
    await flush();
    expect(h.pane().key).toBe("agent:marlow:other");
    expect(h.pane().control).toMatchObject({ status: "maybe-held", key: KEY });
    expect(
      h.calls("clawtrate-computer.tabs").filter((p) => p.sessionKey === KEY).length,
    ).toBeGreaterThan(1);
    // The old task's own read says the lease is gone: Take is offered again, and asks.
    lease = null;
    await h.views.readTabs(h.viewer);
    await flush();
    expect(h.pane().control.status).toBe("ended");
    await h.views.watch(h.viewer);
    await h.views.take(h.viewer);
    expect(h.calls("clawtrate-computer.control.take").at(-1)).toMatchObject({
      sessionKey: "agent:marlow:other",
    });
  });
});

describe("a release on its way (F-145, section 18)", () => {
  it("F-145: the view goes on being renewed while a slow release is on its way, the lease no longer", async () => {
    vi.useFakeTimers();
    const h = harness({
      "clawtrate-computer.view.open": () => ({
        streamId: "stream-1",
        wsPath: `/clawtrate-computer/stream?ticket=${TICKET}`,
        expiresAtMs: Date.now() + 60_000,
        renewWithinMs: 6_000,
        targetId: TAB,
      }),
      "clawtrate-computer.view.renew": (p) => ({
        ok: true,
        renewWithinMs: 6_000,
        streamRenewed: p.streamId === "stream-1",
        leaseRenewed: p.generation === GEN,
      }),
      "clawtrate-computer.control.release": () => never(),
    });
    await granted(h);
    h.views.release(h.viewer, {});
    expect(h.pane().control.status).toBe("releasing");
    const before = h.calls("clawtrate-computer.view.renew").length;
    await vi.advanceTimersByTimeAsync(7_000);
    const renewals = h.calls("clawtrate-computer.view.renew").slice(before);
    expect(renewals.length).toBeGreaterThan(1);
    expect(renewals.every((p) => p.streamId === "stream-1" && p.generation === undefined)).toBe(
      true,
    );
    expect(h.pane().view?.status).toBe("live");
  });
});
