import { describe, expect, it } from "vitest";
import { isLocalAddress, LOCAL_NETWORK_HINT, localNetworkHint } from "../src/local-network.ts";

// Private, link-local and boundary addresses are built from their parts, so no
// tracked file writes one out (as test/addresses.test.ts does).
const join4 = (...parts: number[]) => parts.join(".");
const join6 = (...groups: string[]) => groups.join(":");
const home = `ws://${join4(192, 168, 1, 20)}:18789`;

describe("a local gateway nobody answers at", () => {
  it("knows a local address: private, link-local, .local and IPv6 local ranges", () => {
    for (const url of [
      home,
      `ws://${join4(10, 0, 0, 5)}`,
      `ws://${join4(172, 20, 1, 1)}`,
      `ws://${join4(169, 254, 3, 4)}`,
      "ws://studio.local:1",
      `ws://[${join6("fd12", "", "1")}]:1`,
      `ws://[${join6("fe80", "", "1")}]:1`,
    ])
      expect(isLocalAddress(url), url).toBe(true);
    for (const url of [
      "ws://127.0.0.1:1",
      "wss://gateway.example",
      // Just past the private 172.16/12 range.
      `ws://${join4(172, 32, 0, 1)}`,
      // A public address, from the documentation range.
      "ws://203.0.113.7",
      "nonsense",
      null,
    ])
      expect(isLocalAddress(url), String(url)).toBe(false);
  });

  it("says the Local Network permission may be the cause, and where to allow it, only when it may be", () => {
    expect(localNetworkHint("UNREACHABLE", home)).toBe(LOCAL_NETWORK_HINT);
    expect(LOCAL_NETWORK_HINT).toContain("Settings, Privacy & Security, Local Network");
    expect(localNetworkHint("UNREACHABLE", "wss://gateway.example")).toBeNull();
    expect(localNetworkHint("PAIRING_ENDED", home)).toBeNull();
  });
});
