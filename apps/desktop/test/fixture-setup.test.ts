// The fixture's setup answers (apps/desktop/src/fixture/setup.ts): a delayed step
// belongs to the look or Connect that asked for it, never to a later one.
import { initialState, type ClawtrateState } from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { setupCommand } from "../src/fixture/setup.ts";

function fixture() {
  let state: ClawtrateState = initialState;
  const timers: Array<{ ms: number; run: () => void }> = [];
  const set = (next: ClawtrateState) => void (state = next);
  const send = (type: "setupLook" | "setupCancel" | "setupConnect" | "setupReset") =>
    setupCommand(
      { type },
      () => state,
      set,
      () => state,
      (ms, run) => void timers.push({ ms, run }),
    );
  /** Runs every delayed step due by `ms`, in order. */
  const runUntil = (ms: number) => {
    for (const timer of timers.filter((t) => t.ms <= ms).sort((a, b) => a.ms - b.ms)) timer.run();
  };
  return { send, runUntil, timers, setup: () => state.setup };
}

describe("the fixture's setup answers", () => {
  it("a look cancelled and started again isn't finished early by the first look's steps", () => {
    const f = fixture();
    f.send("setupLook");
    f.send("setupCancel");
    f.send("setupLook");
    // The first look's steps fire; only the second look's own may move it.
    for (const timer of f.timers.slice(0, 3)) timer.run();
    expect(f.setup()).toMatchObject({ phase: "looking", step: 0 });
    for (const timer of f.timers.slice(3)) timer.run();
    expect(f.setup()?.phase).toBe("found");
  });

  it("a Connect started again after Back isn't moved on by the first Connect's steps", () => {
    const f = fixture();
    f.send("setupLook");
    f.runUntil(900);
    f.send("setupConnect");
    const first = f.timers.length;
    f.send("setupCancel");
    f.send("setupConnect");
    for (const timer of f.timers.slice(first - 3, first)) timer.run();
    expect(f.setup()).toMatchObject({ phase: "connecting", step: 0 });
  });
});
