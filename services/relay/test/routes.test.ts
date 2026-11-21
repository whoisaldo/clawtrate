import { createSessionId } from "@clawtrate/relay-protocol";
import { describe, expect, it } from "vitest";
import { addressRateKey, addressText, parseRoute, planRequest } from "../src/core/index.ts";
import { startRelayServer } from "../src/node/server.ts";
import { connectorKey } from "./support.ts";

describe("the relay's paths", () => {
  const relayId = connectorKey().relayId;
  const session = createSessionId();

  it("reads the three socket paths in their one spelling", () => {
    expect(parseRoute(`/v1/connector/${relayId}`)).toEqual({ role: "control", relayId });
    expect(parseRoute(`/v1/dial/${relayId}`)).toEqual({ role: "dial", relayId });
    expect(parseRoute(`/v1/session/${relayId}/${session}`)).toEqual({
      role: "session",
      relayId,
      session,
    });
    for (const path of [
      `/v1/connector/${relayId}/`,
      `/v1/connector/${relayId.toUpperCase()}`,
      `/v1/dial/${relayId}/${session}`,
      `/v1/session/${relayId}`,
      `/v1/session/${relayId}/${session}=`,
      `/v2/dial/${relayId}`,
      `//v1/dial/${relayId}`,
      "/health/",
    ]) {
      expect(parseRoute(path), path).toBeNull();
    }
  });

  it("answers health, wants a GET upgrade on a socket path, and finds nothing elsewhere", () => {
    expect(planRequest("GET", "/health", null)).toEqual({ kind: "health" });
    expect(planRequest("POST", "/health", null)).toEqual({ kind: "refuse", status: 405 });
    expect(planRequest("GET", `/v1/dial/${relayId}`, "WebSocket")).toEqual({
      kind: "socket",
      route: { role: "dial", relayId },
    });
    expect(planRequest("GET", `/v1/dial/${relayId}`, null)).toEqual({
      kind: "refuse",
      status: 426,
    });
    expect(planRequest("POST", `/v1/dial/${relayId}`, "websocket")).toEqual({
      kind: "refuse",
      status: 405,
    });
    expect(planRequest("GET", "/", "websocket")).toEqual({ kind: "refuse", status: 404 });
  });
});

describe("the phone's address", () => {
  it("passes IPv4 and IPv6 text and empties anything else", () => {
    expect(addressText("203.0.113.7")).toBe("203.0.113.7");
    expect(addressText(" 2001:DB8::7 ")).toBe("2001:db8::7");
    expect(addressText("::ffff:192.0.2.1")).toBe("::ffff:192.0.2.1");
    for (const bad of [
      null,
      undefined,
      "",
      "256.0.0.1",
      "203.0.113",
      "2001:db8::1%en0",
      "1::2::3",
      "x",
    ]) {
      expect(addressText(bad), String(bad)).toBe("");
    }
    expect(addressText(`${"1:".repeat(22)}1`)).toBe("");
  });

  it("counts IPv4 whole, IPv4-mapped as IPv4, and IPv6 by its /64", () => {
    expect(addressRateKey("203.0.113.7")).toBe("203.0.113.7");
    expect(addressRateKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(addressRateKey("2001:db8:0:1::7")).toBe("2001:db8:0:1::/64");
    expect(addressRateKey("2001:db8:0:1:ffff::1")).toBe("2001:db8:0:1::/64");
    expect(addressRateKey("2001:db8:0:2::7")).toBe("2001:db8:0:2::/64");
    expect(addressRateKey("")).toBe("unknown");
  });
});

describe("the Node runner", () => {
  it("listens on loopback only", async () => {
    // 192.0.2.1 is a documentation address, so even without the check nothing is bound there.
    for (const host of ["192.0.2.1", "localhost"]) {
      await expect(startRelayServer({ host }), host).rejects.toThrow(
        "The Node relay listens on 127.0.0.1 or ::1 only.",
      );
    }
  });
});
