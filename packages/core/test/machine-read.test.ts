// The Computer tab's machine read (`client.readMachine`) stays on the gateway it started on: once
// another gateway is chosen, nothing more is asked and nothing read is returned for the task.

import { describe, expect, it } from "vitest";
import { KEY, openTask, URL_B } from "./client-harness.ts";
import { deferred } from "./fake-gateway.ts";

describe("a machine read across a change of gateway (F-147)", () => {
  it("F-147: a read whose probe was still out when another gateway was chosen asks nothing more and is refused", async () => {
    const { client, gateway } = await openTask();
    const probe = deferred<unknown>();
    gateway.handlers["computer.status"] = (params) =>
      (params as { probe?: boolean }).probe ? probe.promise : { configured: false };
    gateway.handlers["config.get"] = () => ({ config: {} });
    gateway.handlers["node.list"] = () => ({ nodes: [] });
    const reading = client.readMachine(KEY, [], true);
    await client.connect({ url: URL_B, token: "t" });
    probe.reject(new Error("gone"));
    await expect(reading).rejects.toThrow("Switched to another gateway.");
    expect(gateway.calls("config.get")).toEqual([]);
    expect(gateway.calls("node.list")).toEqual([]);
    client.stop();
  });
});
