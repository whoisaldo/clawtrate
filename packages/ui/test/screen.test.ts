import {
  initialSetupState,
  initialState,
  type ClawtrateState,
  type ConnectionStatus,
  type HostInfo,
} from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { screenFor, setupHolds } from "../src/screen.ts";

function state(status: ConnectionStatus, bots: number): ClawtrateState {
  return {
    ...initialState,
    connection: { ...initialState.connection, status },
    bots: Array.from({ length: bots }, (_, i) => ({
      id: `b${i}`,
      name: `Bot ${i}`,
      emoji: null,
      avatarUrl: null,
      theme: null,
      model: null,
      isDefault: i === 0,
    })),
  };
}

describe("screenFor (C2)", () => {
  it("keeps the shell up through every automatic retry while data is cached", () => {
    for (const status of ["connected", "reconnecting", "connecting", "error"] as const) {
      expect(screenFor(state(status, 4))).toBe("shell");
    }
  });

  it("shows the connection screen for first connects and pairing", () => {
    expect(screenFor(state("idle", 0))).toBe("connect");
    expect(screenFor(state("connecting", 0))).toBe("connect");
    expect(screenFor(state("pairing", 0))).toBe("connect");
    expect(screenFor(state("pairing", 4))).toBe("connect");
  });

  it("shows the shell for a connected gateway with no bots, so its error or empty state is visible", () => {
    expect(screenFor(state("connected", 0))).toBe("shell");
  });
});

describe("setupHolds", () => {
  const info = {
    kind: "desktop",
    version: "test",
    devGateway: null,
    setup: { look: true, pair: true, platform: "darwin" },
  } as HostInfo;
  const failed = (kind: "bots" | "cleanup" | "changed") => ({
    ...initialSetupState,
    phase: "failed" as const,
    failure: { kind, exitCode: null, port: null, reason: null },
  });

  it("F-492: a cleanup that failed keeps setup on screen while its bots finish loading", () => {
    // Back's cleanup failed, so setup's connection is still up: its bots loading must not
    // open the app over the failure that asks for Back.
    const loaded = state("connected", 4);
    expect(screenFor(loaded)).toBe("shell");
    expect(setupHolds(info, failed("cleanup"))).toBe(true);
    expect(setupHolds(info, failed("bots"))).toBe(true);
    expect(setupHolds(info, { ...initialSetupState, phase: "connecting" })).toBe(true);
    // Any other failure, a host without setup, or no setup state: the state decides.
    expect(setupHolds(info, failed("changed"))).toBe(false);
    const { setup: _offered, ...withoutSetup } = info;
    expect(setupHolds(withoutSetup, failed("cleanup"))).toBe(false);
    expect(setupHolds(info, undefined)).toBe(false);
  });
});
