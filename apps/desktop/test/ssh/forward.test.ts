// The forward's state machine, with a process, a LOOK and a clock of the
// test's own: every state reported, the stated back-off, a lost port race, a
// changed key, another gateway on the port, a long outage, and closing.

import { MAX_FORWARD_LISTENERS } from "@clawtrate/core";
import { describe, expect, it } from "vitest";

import {
  backoffMs,
  type ForwardDeps,
  type ForwardProcess,
  type ForwardState,
  ForwardSupervisor,
  LONG_OUTAGE_MS,
  type VerifyResult,
} from "../../src/main/ssh/forward.ts";
import type { ProbeResult } from "../../src/main/ssh/http-probe.ts";
import type { SshFailure } from "../../src/main/ssh/ssh-output.ts";

type FakeProcess = ForwardProcess & {
  listen(): void;
  exit(failure: SshFailure): void;
  ended: boolean;
  port: string;
};

function harness(verifyResults: VerifyResult[] = [], probeResults: ProbeResult[] = []) {
  let verifyCalls = 0;
  let now = 0;
  const timers: Array<{ at: number; callback: () => void; id: number }> = [];
  let nextId = 1;
  const processes: FakeProcess[] = [];
  let nextPort = 50000;
  const verifies: Array<(result: VerifyResult) => void> = [];
  const signals: AbortSignal[] = [];
  const deps: ForwardDeps = {
    pickLocal: async () => `/sockets/f${nextPort++}.s`,
    start: (port) => {
      const listening: Array<() => void> = [];
      const exits: Array<(failure: SshFailure) => void> = [];
      const process: FakeProcess = {
        pid: 1000 + processes.length,
        port,
        ended: false,
        onListening: (listener) => listening.push(listener),
        onExit: (listener) => exits.push(listener),
        channel: () => ({ refused: false, connectFailed: false }),
        end: async () => {
          if (process.ended) return;
          process.ended = true;
          for (const listener of exits) listener({ kind: "ssh-stopped", exit: null });
        },
        listen: () => listening.forEach((listener) => listener()),
        exit: (failure) => {
          process.ended = true;
          exits.forEach((listener) => listener(failure));
        },
      };
      processes.push(process);
      return process;
    },
    probe: async () => probeResults.shift() ?? "http",
    verify: (signal) =>
      ++verifyCalls && signals.push(signal) && verifyResults.length
        ? Promise.resolve(verifyResults.shift()!)
        : new Promise((resolve) => verifies.push(resolve)),
    now: () => now,
    setTimer: (callback, ms) => {
      const id = nextId++;
      timers.push({ at: now + ms, callback, id });
      return id;
    },
    clearTimer: (id) => {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index !== -1) timers.splice(index, 1);
    },
  };
  const forward = new ForwardSupervisor(deps);
  const states: ForwardState[] = [];
  forward.onState((state) => states.push(state));
  const flush = async () => {
    for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return {
    forward,
    states,
    processes,
    verifies,
    flush,
    pending: () => timers.map((timer) => timer.at - now),
    verifyCalls: () => verifyCalls,
    deps,
    signals,
    async advance(ms: number) {
      now += ms;
      for (const timer of timers.filter((t) => t.at <= now)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.callback();
      }
      await flush();
    },
    last: () => processes.at(-1)!,
    /** The newest process listens, and the LOOK names the same service. */
    async up() {
      await flush();
      this.last().listen();
      await flush();
    },
  };
}

describe("the forward's back-off", () => {
  it("is 1, 2, 4, 8 and 16 seconds, then every 30", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(backoffMs)).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000,
    ]);
  });
});

describe("the forward's listeners", () => {
  it("are bounded", () => {
    const h = harness();
    // The harness holds one already.
    for (let i = 1; i < MAX_FORWARD_LISTENERS; i++) h.forward.onState(() => {});
    expect(() => h.forward.onState(() => {})).toThrow();
  });
});

describe("the forward's states", () => {
  it("starts, verifies with the LOOK, and only then is up", async () => {
    const h = harness([{ kind: "same" }]);
    h.forward.open();
    await h.flush();
    expect(h.forward.state).toEqual({ phase: "starting", attempt: 1 });
    await h.up();
    expect(h.states.map((s) => s.phase)).toEqual(["starting", "verifying", "up"]);
    expect(h.forward.state).toEqual({ phase: "up", local: "/sockets/f50000.s", restored: false });
  });

  it("is up only after a connection through it was answered as HTTP: a failed connection may run the LOOK, never put it up", async () => {
    const h = harness(
      [{ kind: "cant-tell" }, { kind: "same" }],
      ["no-answer", "forwarding-refused", "gateway-closed", "http"],
    );
    h.forward.open();
    await h.up();
    expect(h.forward.state).toMatchObject({ phase: "waiting", cause: { kind: "cant-tell" } });
    expect(h.verifyCalls()).toBe(0);
    expect(h.processes[0]!.ended).toBe(true);
    await h.advance(1000);
    await h.up();
    expect(h.forward.state).toMatchObject({
      phase: "waiting",
      cause: { kind: "forwarding-refused" },
    });
    await h.advance(2000);
    await h.up();
    // A forwarded connection that failed: one LOOK, and while it can't tell, the port didn't answer.
    expect(h.forward.state).toMatchObject({
      phase: "waiting",
      cause: { kind: "gateway-not-answering" },
    });
    expect(h.verifyCalls()).toBe(1);
    expect(h.states.some((s) => s.phase === "up")).toBe(false);
    await h.advance(4000);
    await h.up();
    expect(h.verifyCalls()).toBe(2);
    expect(h.forward.state.phase).toBe("up");
  });

  it("runs one LOOK on the pinned account when the gateway's port closed through a live SSH route, and says stopped only when it is", async () => {
    const h = harness([{ kind: "not-running" }], ["gateway-closed"]);
    h.forward.open();
    await h.up();
    expect(h.verifyCalls()).toBe(1);
    expect(h.forward.state).toMatchObject({
      phase: "waiting",
      cause: { kind: "gateway-not-running" },
    });
    await h.forward.close();
  });

  it("is not up while the LOOK is still running", async () => {
    const h = harness();
    h.forward.open();
    await h.up();
    expect(h.forward.state.phase).toBe("verifying");
    h.verifies.shift()!({ kind: "same" });
    await h.flush();
    expect(h.forward.state.phase).toBe("up");
  });

  it("after a drop, waits as stated, comes back by itself, and says it was restored", async () => {
    const h = harness([{ kind: "same" }, { kind: "same" }]);
    h.forward.open();
    await h.up();
    h.last().exit({ kind: "dropped", exit: 255 });
    await h.flush();
    expect(h.forward.state).toEqual({
      phase: "waiting",
      cause: { kind: "dropped" },
      failures: 1,
      retryInMs: 1000,
      longOutage: false,
    });
    expect(h.pending()).toEqual([1000]);
    await h.advance(999);
    expect(h.processes).toHaveLength(1);
    await h.advance(1);
    expect(h.processes).toHaveLength(2);
    await h.up();
    expect(h.forward.state).toEqual({ phase: "up", local: "/sockets/f50001.s", restored: true });
  });

  it("backs off further with each failure in a row, and starts over once up", async () => {
    const h = harness();
    h.forward.open();
    await h.flush();
    const waits: number[] = [];
    for (let i = 0; i < 7; i++) {
      h.last().exit({ kind: "unreachable", cause: "timed out", exit: 255 });
      await h.flush();
      const state = h.forward.state;
      if (state.phase !== "waiting") throw new Error(state.phase);
      waits.push(state.retryInMs);
      await h.advance(state.retryInMs);
    }
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    await h.up();
    h.verifies.shift()!({ kind: "same" });
    await h.flush();
    h.last().exit({ kind: "dropped", exit: 255 });
    await h.flush();
    expect(h.forward.state).toMatchObject({ phase: "waiting", retryInMs: 1000 });
  });

  it("says so after two minutes without the forward up", async () => {
    const h = harness([{ kind: "same" }]);
    h.forward.open();
    await h.up();
    h.last().exit({ kind: "dropped", exit: 255 });
    await h.flush();
    let elapsed = 0;
    while (elapsed < LONG_OUTAGE_MS) {
      const state = h.forward.state;
      if (state.phase !== "waiting") throw new Error(state.phase);
      expect(state.longOutage).toBe(elapsed >= LONG_OUTAGE_MS);
      elapsed += state.retryInMs;
      await h.advance(state.retryInMs);
      h.last().exit({ kind: "unreachable", cause: "network unreachable", exit: 255 });
      await h.flush();
    }
    expect(h.forward.state).toMatchObject({
      phase: "waiting",
      longOutage: true,
      cause: { kind: "unreachable" },
    });
  });

  it("tries again at once on retryNow, as on wake or a network change", async () => {
    const h = harness();
    h.forward.open();
    await h.flush();
    h.last().exit({ kind: "unreachable", cause: "network unreachable", exit: 255 });
    await h.flush();
    expect(h.pending()).toEqual([1000]);
    h.forward.retryNow();
    await h.flush();
    expect(h.processes).toHaveLength(2);
    expect(h.pending()).toEqual([]);
  });

  it("turns a start that throws into a state, and tries again", async () => {
    const h = harness([{ kind: "same" }]);
    const realStart = h.deps.start;
    let throws = true;
    h.deps.start = (port) => {
      if (throws) throw new Error("spawn EAGAIN");
      return realStart(port);
    };
    h.forward.open();
    await h.flush();
    expect(h.forward.state).toMatchObject({
      phase: "waiting",
      cause: { kind: "spawn-failed" },
      retryInMs: 1000,
    });
    throws = false;
    await h.advance(1000);
    await h.up();
    expect(h.forward.state.phase).toBe("up");
  });

  it("picks another local socket at once when its socket was taken, a bounded number of times", async () => {
    const h = harness();
    h.forward.open();
    await h.flush();
    for (let i = 0; i < 5; i++) {
      h.last().exit({ kind: "local-port-taken", exit: 255 });
      await h.flush();
      expect(h.forward.state.phase).toBe("starting");
    }
    expect(h.processes.map((p) => p.port)).toEqual(
      [50000, 50001, 50002, 50003, 50004, 50005].map((n) => `/sockets/f${n}.s`),
    );
    h.last().exit({ kind: "local-port-taken", exit: 255 });
    await h.flush();
    expect(h.forward.state).toMatchObject({
      phase: "waiting",
      cause: { kind: "local-port-taken" },
    });
  });

  it("stops for good when the key changed, from the forward or from the LOOK", async () => {
    const h = harness([{ kind: "same" }]);
    h.forward.open();
    await h.up();
    h.last().exit({ kind: "host-key-changed", exit: 255 });
    await h.flush();
    expect(h.forward.state).toEqual({ phase: "closed", reason: "key-changed" });
    expect(h.pending()).toEqual([]);

    const k = harness([{ kind: "failed", failure: { kind: "host-key-changed", exit: 255 } }]);
    k.forward.open();
    await k.up();
    expect(k.forward.state).toEqual({ phase: "closed", reason: "key-changed" });
    expect(k.last().ended).toBe(true);
  });

  it("closes when the LOOK names another gateway service on that port", async () => {
    const h = harness([{ kind: "same" }, { kind: "different" }]);
    h.forward.open();
    await h.up();
    h.last().exit({ kind: "dropped", exit: 255 });
    await h.advance(1000);
    await h.up();
    expect(h.forward.state).toEqual({ phase: "closed", reason: "different-gateway" });
    expect(h.last().ended).toBe(true);
    expect(h.states.filter((s) => s.phase === "up")).toHaveLength(1);
  });

  it("is not usable while the gateway there is stopped, and waits for it", async () => {
    const h = harness([{ kind: "not-running" }, { kind: "cant-tell" }, { kind: "same" }]);
    h.forward.open();
    await h.up();
    expect(h.forward.state).toMatchObject({
      phase: "waiting",
      cause: { kind: "gateway-not-running" },
    });
    expect(h.processes[0]!.ended).toBe(true);
    await h.advance(1000);
    await h.up();
    expect(h.forward.state).toMatchObject({
      phase: "waiting",
      cause: { kind: "cant-tell" },
      retryInMs: 2000,
    });
    await h.advance(2000);
    await h.up();
    expect(h.forward.state.phase).toBe("up");
  });

  it("closes explicitly, ends its process, and nothing restarts it", async () => {
    const h = harness([{ kind: "same" }]);
    h.forward.open();
    await h.up();
    await h.forward.close();
    expect(h.forward.state).toEqual({ phase: "closed", reason: "closed" });
    expect(h.last().ended).toBe(true);
    await h.advance(60000);
    expect(h.processes).toHaveLength(1);
    h.forward.retryNow();
    await h.flush();
    expect(h.processes).toHaveLength(1);
  });

  it("resolves close only once a retiring process has ended", async () => {
    const h = harness([{ kind: "not-running" }]);
    let release: () => void = () => {};
    h.forward.open();
    await h.flush();
    const first = h.last();
    first.end = () =>
      new Promise<void>((resolve) => {
        release = () => {
          first.ended = true;
          resolve();
        };
      });
    first.listen();
    await h.flush();
    expect(h.forward.state).toMatchObject({
      phase: "waiting",
      cause: { kind: "gateway-not-running" },
    });
    let closed = false;
    const closing = h.forward.close().then(() => (closed = true));
    await h.flush();
    expect(closed).toBe(false);
    expect(h.forward.state.phase).not.toBe("closed");
    release();
    await closing;
    expect(first.ended).toBe(true);
    expect(h.forward.state).toEqual({ phase: "closed", reason: "closed" });
  });

  it("stops its LOOK when closed, and resolves only once the LOOK has ended", async () => {
    const h = harness();
    h.forward.open();
    await h.up();
    // The LOOK in flight ends only when its signal says so.
    const pending = h.verifies.shift()!;
    expect(h.forward.state.phase).toBe("verifying");
    const signal = h.signals.at(-1) ?? null;
    expect(signal?.aborted).toBe(false);
    let closed = false;
    const closing = h.forward.close().then(() => (closed = true));
    await h.flush();
    expect(signal?.aborted).toBe(true);
    expect(closed).toBe(false);
    pending({ kind: "cant-tell" });
    await closing;
    expect(closed).toBe(true);
  });

  it("closes while waiting or while the LOOK runs, and ignores what arrives late", async () => {
    const h = harness();
    h.forward.open();
    await h.up();
    const late = h.verifies.shift()!;
    const closing = h.forward.close();
    // A LOOK that answers "same" after close was asked for doesn't bring it up.
    late({ kind: "same" });
    await closing;
    await h.flush();
    expect(h.forward.state).toEqual({ phase: "closed", reason: "closed" });
    expect(h.states.some((s) => s.phase === "up")).toBe(false);

    const w = harness();
    w.forward.open();
    await w.flush();
    w.last().exit({ kind: "dropped", exit: 255 });
    await w.flush();
    await w.forward.close();
    expect(w.pending()).toEqual([]);
    expect(w.forward.state).toEqual({ phase: "closed", reason: "closed" });
  });
});

describe("the forward and its observers", () => {
  it("keeps its life going when an observer throws: the retry is set, close resolves", async () => {
    const h = harness([], ["no-answer"]);
    const seen: string[] = [];
    h.forward.onState(() => {
      throw new Error("an observer's own fault");
    });
    h.forward.onState((state) => seen.push(state.phase));
    h.forward.open();
    await h.up();
    expect(h.forward.state).toMatchObject({ phase: "waiting", cause: { kind: "cant-tell" } });
    // The observer after the one that threw still heard every state, and the retry is set.
    expect(seen).toEqual(["starting", "verifying", "waiting"]);
    expect(h.pending()).toEqual([1000]);
    await expect(h.forward.close()).resolves.toBeUndefined();
    expect(h.forward.state).toEqual({ phase: "closed", reason: "closed" });
    expect(seen.at(-1)).toBe("closed");
  });
});

describe("the forward's attempts", () => {
  /** A forward whose first process, once told to end, ends only when `release` is called. */
  const retiringSlowly = async () => {
    const h = harness([], ["no-answer", "http"]);
    let release: () => void = () => {};
    h.forward.open();
    await h.flush();
    const first = h.last();
    first.end = () =>
      new Promise<void>((resolve) => {
        release = () => {
          first.ended = true;
          resolve();
        };
      });
    first.listen();
    await h.flush();
    expect(h.forward.state).toMatchObject({ phase: "waiting", cause: { kind: "cant-tell" } });
    return { h, release: () => release() };
  };

  it("starts no replacement, timed or at once, until the old ssh has ended", async () => {
    for (const retry of ["timer", "now"] as const) {
      const { h, release } = await retiringSlowly();
      if (retry === "timer") await h.advance(1000);
      else h.forward.retryNow();
      await h.flush();
      expect(h.processes, retry).toHaveLength(1);
      release();
      await h.flush();
      expect(h.processes, retry).toHaveLength(2);
      await h.forward.close();
    }
  });

  it("keeps only the order of its retirements, not what each one ended with", async () => {
    const h = harness([], ["no-answer", "no-answer", "no-answer", "http"]);
    h.forward.open();
    for (const wait of [1000, 2000, 4000]) {
      await h.up();
      await h.advance(wait);
    }
    // The barrier the next attempt waits on holds nothing of the processes retired before.
    const barrier = (h.forward as unknown as { retiring: Promise<unknown> }).retiring;
    expect(await barrier).toBeUndefined();
    await h.forward.close();
  });

  it("starts nothing after the old ssh ends when it was closed meanwhile", async () => {
    const { h, release } = await retiringSlowly();
    await h.advance(1000);
    const closing = h.forward.close();
    release();
    await closing;
    await h.flush();
    expect(h.processes).toHaveLength(1);
    expect(h.forward.state).toEqual({ phase: "closed", reason: "closed" });
  });

  it("starts one attempt, not two, when an observer retries from the waiting state", async () => {
    const h = harness([{ kind: "same" }], ["no-answer", "http"]);
    let retried = false;
    h.forward.onState((state) => {
      if (state.phase === "waiting" && !retried) {
        retried = true;
        h.forward.retryNow();
      }
    });
    h.forward.open();
    await h.up();
    expect(retried).toBe(true);
    // The observer's retry is the only one: no timer is left to start another.
    expect(h.pending()).toEqual([]);
    await h.up();
    expect(h.forward.state).toMatchObject({ phase: "up" });
    await h.advance(60000);
    expect(h.processes).toHaveLength(2);
    expect(h.forward.state).toMatchObject({ phase: "up", local: h.processes[1]!.port });
    await h.forward.close();
  });

  it("is never up for a process that exited while its LOOK ran, and that LOOK is stopped", async () => {
    const h = harness();
    h.forward.open();
    await h.up();
    expect(h.forward.state.phase).toBe("verifying");
    const look = h.verifies.shift()!;
    const signal = h.signals.at(-1)!;
    // ssh drops while the LOOK is still running.
    h.last().exit({ kind: "dropped", exit: 255 });
    await h.flush();
    expect(h.forward.state).toMatchObject({ phase: "waiting", cause: { kind: "dropped" } });
    expect(signal.aborted).toBe(true);
    // The LOOK answers "same" anyway, before the retry: nothing is up.
    look({ kind: "same" });
    await h.flush();
    expect(h.forward.state).toMatchObject({ phase: "waiting", cause: { kind: "dropped" } });
    expect(h.states.some((s) => s.phase === "up")).toBe(false);
    await h.forward.close();
  });
});
