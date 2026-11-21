// A viewer's bridge session and its Computer pane: closing the pane's task leaves the pane
// (control given back, the view ended), and closing another task leaves it alone.

import { describe, expect, it, vi } from "vitest";
import { createBridgeSession } from "../src/bridge.ts";
import { MAX_FRAME_BYTES, MAX_INPUT_TEXT, MAX_QUEUED_INPUTS } from "../src/computer.ts";
import { CLIENT_OWNERS } from "../src/owners.ts";
import { KEY, openTask } from "./client-harness.ts";

describe("closing a task with the Computer tab shown", () => {
  it("F-145: leaves this viewer's pane on that task first; closing another task does not", async () => {
    const { client } = await openTask();
    const leave = vi.spyOn(client, "computerLeave");
    const viewer = createBridgeSession(client);
    await viewer.apply({ type: "openSession", key: KEY });
    await viewer.apply({ type: "openSession", key: "agent:otto:other" });
    await viewer.apply({ type: "computerShow", key: KEY });
    const id = viewer.computerViewer()!;
    await viewer.apply({ type: "closeSession", key: "agent:otto:other" });
    expect(leave).not.toHaveBeenCalled();
    await viewer.apply({ type: "closeSession", key: KEY });
    expect(leave).toHaveBeenCalledWith(id);
    viewer.dispose();
    client.stop();
  });
});

describe("the Computer tab's part of the host's worst case (owners.ts)", () => {
  it("counts each queued text input as JSON writes it, control characters included", () => {
    const each = CLIENT_OWNERS["computer.lives"]!.each;
    // The worst text a viewer can queue: every character escaped as `\u0001`.
    const worst = JSON.stringify("\u0001".repeat(MAX_INPUT_TEXT)).length;
    const frame = Math.ceil(MAX_FRAME_BYTES / 3) * 4;
    expect(each - frame).toBeGreaterThanOrEqual(MAX_QUEUED_INPUTS * worst);
  });
});
