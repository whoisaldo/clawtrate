import {
  initialSetupState,
  initialState,
  type ClawtrateState,
  type ConnectionStatus,
} from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { followSetup, screenFor, setupUnderWay } from "../src/screen.ts";

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

describe("the setup screen and the host's setup", () => {
  it("opens setup the host started while the first question showed, and keeps the person's choice otherwise", () => {
    expect(setupUnderWay(undefined)).toBe(false);
    expect(setupUnderWay(initialSetupState)).toBe(false);
    const restoring = { ...initialSetupState, phase: "connecting" as const, step: 1 };
    expect(setupUnderWay(restoring)).toBe(true);
    // A restore at launch published after the first question showed: its screens open.
    expect(followSetup("first", false, true)).toBe("here");
    // The person's own screens stay, and nothing changes while setup goes on or ends.
    expect(followSetup("another", false, true)).toBe("another");
    expect(followSetup("advanced", false, true)).toBe("advanced");
    expect(followSetup("first", true, true)).toBe("first");
    expect(followSetup("here", true, false)).toBe("here");
    expect(followSetup("first", true, false)).toBe("first");
  });
});
