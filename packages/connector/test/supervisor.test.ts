// Supervision of the control socket, on a clock the test holds.
//
// Scenarios ported from T3 Code, `apps/server/src/cloud/ManagedEndpointRuntime.test.ts` at
// commit 18d1c4db ("supervises the active connector and restarts it after process exit", "does
// not restart a connector that exits after the server receives SIGINT/SIGTERM", "restarts only
// the inspected connector and supervises its replacement") and from the policy those tests and
// `ManagedEndpointRuntime.ts` pin: the crash-loop ladder, its reset after a stable run, backoff
// kept when recovery returns the same config, and the readiness threshold that doubles.
//
// MIT License
//
// Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import { describe, expect, it } from "vitest";
import {
  NOT_READY_CHECKS_BEFORE_RESTART,
  NOT_READY_CHECKS_MAX,
  READINESS_INTERVAL_MS,
  REGISTRATION_TIMEOUT_MS,
  RESTART_BACKOFF_MAX_MS,
  RESTART_STABLE_UPTIME_MS,
  Supervisor,
  type LinkEvents,
  type Readiness,
  type Timers,
} from "../src/supervisor.ts";

/** A clock and timers the test advances by hand. */
class ManualTimers implements Timers {
  #now = 0;
  #next = 1;
  readonly #timers = new Map<number, { at: number; action: () => void }>();

  now(): number {
    return this.#now;
  }

  setTimeout(action: () => void, ms: number): unknown {
    const id = this.#next++;
    this.#timers.set(id, { at: this.#now + ms, action });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  /** Moves the clock forward, firing every timer that falls due, in order. */
  advance(ms: number): void {
    const end = this.#now + ms;
    for (;;) {
      let due: [number, { at: number; action: () => void }] | null = null;
      for (const entry of this.#timers) {
        if (entry[1].at <= end && (due === null || entry[1].at < due[1].at)) due = entry;
      }
      if (due === null) break;
      this.#timers.delete(due[0]);
      this.#now = due[1].at;
      due[1].action();
    }
    this.#now = end;
  }
}

interface FakeLink {
  readonly id: number;
  readonly config: string;
  readonly events: LinkEvents;
  closed: boolean;
  readiness: Readiness;
}

function harness() {
  const timers = new ManualTimers();
  const links: FakeLink[] = [];
  const supervisor = new Supervisor<string>({
    timers,
    configKey: (config) => config,
    connect: (config, events) => {
      const link: FakeLink = {
        id: links.length,
        config,
        events,
        closed: false,
        readiness: "unknown",
      };
      links.push(link);
      return {
        close: () => {
          link.closed = true;
        },
        readiness: () => link.readiness,
      };
    },
  });
  /** Gaps between consecutive link starts, after an exit. */
  const crash = () => links.at(-1)!.events.exited("closed:1006");
  return { timers, links, supervisor, crash };
}

describe("supervision of the relay link", () => {
  it("restarts the active link after it exits", () => {
    const { timers, links, supervisor, crash } = harness();
    supervisor.applyConfig("relay-a");
    expect(links).toHaveLength(1);
    links[0]!.events.registered();
    expect(supervisor.status.state).toBe("registered");
    crash();
    timers.advance(0);
    expect(links).toHaveLength(2);
    expect(links[1]!.config).toBe("relay-a");
  });

  it("does not restart a link that exits after shutdown", () => {
    const { timers, links, supervisor } = harness();
    supervisor.applyConfig("relay-a");
    supervisor.stop();
    expect(links[0]!.closed).toBe(true);
    links[0]!.events.exited("closed:1000");
    timers.advance(RESTART_BACKOFF_MAX_MS * 2);
    expect(links).toHaveLength(1);
    expect(supervisor.status.state).toBe("stopped");
    supervisor.applyConfig("relay-a");
    expect(links).toHaveLength(1);
  });

  it("cancels a restart already waiting out its backoff at shutdown", () => {
    const { timers, links, supervisor, crash } = harness();
    supervisor.applyConfig("relay-a");
    crash();
    timers.advance(0);
    crash();
    expect(supervisor.status.state).toBe("waiting");
    supervisor.stop();
    timers.advance(RESTART_BACKOFF_MAX_MS * 2);
    expect(links).toHaveLength(2);
    expect(supervisor.status.state).toBe("stopped");
  });

  it("acts only on the active link: a replaced link's exit restarts nothing", () => {
    const { timers, links, supervisor } = harness();
    supervisor.applyConfig("relay-a");
    supervisor.applyConfig("relay-b");
    expect(links).toHaveLength(2);
    expect(links[0]!.closed).toBe(true);
    links[0]!.events.exited("closed:1006");
    links[0]!.events.registered();
    timers.advance(RESTART_BACKOFF_MAX_MS);
    expect(links).toHaveLength(2);
    expect(supervisor.status.state).toBe("connecting");
    links[1]!.events.registered();
    expect(supervisor.status.state).toBe("registered");
  });

  it("backs off while the link keeps ending quickly: at once, then 1 s doubling to 60 s", () => {
    const { timers, links, supervisor, crash } = harness();
    supervisor.applyConfig("relay-a");
    const delays: number[] = [];
    for (let i = 0; i < 9; i++) {
      crash();
      const before = links.length;
      let waited = 0;
      while (links.length === before) {
        timers.advance(100);
        waited += 100;
      }
      delays.push(waited === 100 ? 0 : waited);
    }
    expect(delays).toEqual([0, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
  });

  it("resets the backoff after a link stays up for 30 seconds", () => {
    const { timers, links, supervisor, crash } = harness();
    supervisor.applyConfig("relay-a");
    for (let i = 0; i < 5; i++) {
      crash();
      timers.advance(
        supervisor.status.nextRestartDelayMs === 1_000
          ? 0
          : supervisor.status.nextRestartDelayMs / 2,
      );
    }
    expect(supervisor.status.nextRestartDelayMs).toBe(16_000);
    timers.advance(RESTART_STABLE_UPTIME_MS);
    crash();
    expect(supervisor.status.nextRestartDelayMs).toBe(0);
    const before = links.length;
    timers.advance(0);
    expect(links).toHaveLength(before + 1);
  });

  it("keeps the backoff when recovery applies the same config, and resets it for a new one", () => {
    const { timers, supervisor, crash } = harness();
    supervisor.applyConfig("relay-a");
    crash();
    timers.advance(0);
    crash();
    timers.advance(1_000);
    expect(supervisor.status.nextRestartDelayMs).toBe(2_000);
    supervisor.applyConfig("relay-a");
    expect(supervisor.status.nextRestartDelayMs).toBe(2_000);
    supervisor.applyConfig("relay-b");
    expect(supervisor.status.nextRestartDelayMs).toBe(0);
  });

  it("restarts a link that never registers", () => {
    const { timers, links, supervisor } = harness();
    supervisor.applyConfig("relay-a");
    timers.advance(REGISTRATION_TIMEOUT_MS - 1);
    expect(links[0]!.closed).toBe(false);
    timers.advance(1);
    expect(links[0]!.closed).toBe(true);
    expect(supervisor.status.lastExit).toBe("registration_timeout");
  });

  it("restarts a link after six not-ready readings in a row, then waits twice as long, up to 60", () => {
    const { timers, links, supervisor } = harness();
    supervisor.applyConfig("relay-a");
    const register = () => {
      const link = links.at(-1)!;
      link.events.registered();
      link.readiness = "not_ready";
      return link;
    };
    let link = register();
    timers.advance(READINESS_INTERVAL_MS * (NOT_READY_CHECKS_BEFORE_RESTART - 1));
    expect(link.closed).toBe(false);
    timers.advance(READINESS_INTERVAL_MS);
    expect(link.closed).toBe(true);
    expect(supervisor.status.lastExit).toBe("not_ready");

    const thresholds: number[] = [];
    for (let i = 0; i < 4; i++) {
      timers.advance(RESTART_BACKOFF_MAX_MS);
      link = register();
      let readings = 0;
      while (!link.closed) {
        timers.advance(READINESS_INTERVAL_MS);
        readings++;
      }
      thresholds.push(readings);
    }
    expect(thresholds).toEqual([12, 24, 48, NOT_READY_CHECKS_MAX]);
  });

  it("counts only explicit not-ready readings, and a ready one resets the count and threshold", () => {
    const { timers, links, supervisor } = harness();
    supervisor.applyConfig("relay-a");
    const link = links[0]!;
    link.events.registered();
    link.readiness = "unknown";
    timers.advance(READINESS_INTERVAL_MS * 20);
    expect(link.closed).toBe(false);
    link.readiness = "not_ready";
    timers.advance(READINESS_INTERVAL_MS * (NOT_READY_CHECKS_BEFORE_RESTART - 1));
    link.readiness = "ready";
    timers.advance(READINESS_INTERVAL_MS);
    link.readiness = "not_ready";
    timers.advance(READINESS_INTERVAL_MS * (NOT_READY_CHECKS_BEFORE_RESTART - 1));
    expect(link.closed).toBe(false);
    timers.advance(READINESS_INTERVAL_MS);
    expect(link.closed).toBe(true);
  });
});
