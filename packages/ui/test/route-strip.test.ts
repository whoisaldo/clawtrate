// The SSH route's words in the status strip (docs/design/setup.md §8): "Retry now"
// only while the host can act on it, the forward waiting for its next try.
import type { ClawtrateState, RouteStatus } from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { routeStrip } from "../src/StatusStrip.tsx";

const route = (patch: Partial<RouteStatus>): RouteStatus => ({
  name: "devbox",
  account: "you@devbox.example",
  port: 22,
  phase: "restoring",
  cause: null,
  profile: "default",
  retry: false,
  ...patch,
});
const state = (status: RouteStatus) => ({ setup: { route: status } }) as unknown as ClawtrateState;

describe("the SSH route's strip", () => {
  it("F-498: offers Retry now while restoring only when the host can act on it", () => {
    expect(routeStrip(state(route({ retry: true })))?.action).toBe("route-retry");
    expect(routeStrip(state(route({ retry: false })))).toMatchObject({
      text: "Restoring the connection to you@devbox.example",
      action: null,
    });
  });
});
