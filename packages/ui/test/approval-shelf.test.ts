// What each of setup §9's outcomes offers in the access bars, and what each
// action sends: Look again opens the route's look, Review that route's
// review, Reconnect reconnects, and none of them reconnects in another's name.

import {
  initialConnectionState,
  initialScopeUpgrade,
  type BridgeCommand,
  type ConnectionState,
  type ScopeUpgradeState,
} from "@clawtrate/core";
import { isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { approvalActions, approvalShelf } from "../src/ApprovalWait.tsx";
import { stripFor } from "../src/StatusStrip.tsx";

type Props = { children?: ReactNode; onClick?: () => void };

/** Every button in a shelf's action, by its label. */
function buttons(node: ReactNode): Map<string, () => void> {
  const found = new Map<string, () => void>();
  const walk = (each: ReactNode) => {
    if (Array.isArray(each)) return each.forEach(walk);
    if (!isValidElement<Props>(each)) return;
    if (each.type === "button" && typeof each.props.children === "string")
      found.set(each.props.children, each.props.onClick!);
    walk(each.props.children);
  };
  walk(node);
  return found;
}

function shelf(
  upgrade: Partial<ScopeUpgradeState>,
  connection: Partial<ConnectionState> = {},
  looks = true,
  settings: string[] = [],
) {
  const sent: BridgeCommand[] = [];
  const send = async (command: BridgeCommand) => void sent.push(command);
  const result = approvalShelf(
    {
      ...initialConnectionState,
      status: "error",
      ...connection,
      upgrade: { ...initialScopeUpgrade, ...upgrade },
    },
    send as never,
    () => sent.push({ type: "requestAccess" }),
    undefined,
    looks,
    () => settings.push("opened"),
  );
  const actions = buttons(result?.action);
  const press = (label: string) => {
    actions.get(label)!();
    return sent.at(-1);
  };
  return { result, labels: [...actions.keys()], press };
}

describe("F-500: the outcomes' actions do what they say", () => {
  it("unconfirmed: Look again opens the route's look, and Reconnect is its own action", () => {
    const ssh = shelf({ status: "unconfirmed", place: "ssh" });
    expect(ssh.labels).toEqual(["Look again", "Reconnect"]);
    expect(ssh.press("Look again")).toEqual({ type: "setupRetryRoute" });
    expect(ssh.press("Reconnect")).toEqual({ type: "retry" });
    // On this computer, the look for the saved profile at its address, never another profile.
    expect(shelf({ status: "unconfirmed", place: "here" }).press("Look again")).toEqual({
      type: "setupReviewHere",
    });
    // An address route has no look of its own: only Reconnect.
    expect(shelf({ status: "unconfirmed", place: "address" }).labels).toEqual(["Reconnect"]);
  });

  it("a different gateway: Review opens that route's review, and nothing reconnects to it", () => {
    const ssh = shelf({ status: "identity-changed", place: "ssh" });
    expect(ssh.labels).toEqual(["Review"]);
    expect(ssh.press("Review")).toEqual({ type: "setupRetryRoute" });
    expect(shelf({ status: "identity-changed", place: "here" }).press("Review")).toEqual({
      type: "setupReviewHere",
    });
    // An address route: Review opens Settings, which names the address and offers another gateway.
    const opened: string[] = [];
    const address = shelf({ status: "identity-changed", place: "address" }, {}, true, opened);
    expect(address.labels).toEqual(["Review"]);
    address.press("Review");
    expect(opened).toEqual(["opened"]);
  });

  it("the status strip offers the bar's own first action, never Reconnect to another gateway", () => {
    for (const [status, place, label] of [
      ["identity-changed", "ssh", "Review"],
      ["identity-changed", "here", "Review"],
      ["identity-changed", "address", "Review"],
      ["unconfirmed", "ssh", "Look again"],
      ["unconfirmed", "address", "Reconnect"],
    ] as const) {
      const connection: ConnectionState = {
        ...initialConnectionState,
        status: "error",
        error: {
          code: "APPROVAL_IDENTITY_CHANGED",
          message: "This route now leads to a different gateway.",
          hint: null,
        },
        upgrade: { ...initialScopeUpgrade, status, place },
      };
      const state = {
        connection,
        discovery: { status: "ready" },
        setup: { route: { phase: "disconnected" } },
      } as never;
      const strip = stripFor(state, "live" as never, null);
      expect(strip?.action).toBe("approval");
      const sent: BridgeCommand[] = [];
      const first = approvalActions(
        connection,
        (async (c: BridgeCommand) => void sent.push(c)) as never,
        true,
        () => {},
      )[0];
      expect(first?.label).toBe(label);
      const bar = shelf({ status, place });
      expect(bar.labels[0]).toBe(label);
    }
  });

  it("stale: Check again only where the host can read the list; an address route asks again only", () => {
    const here = shelf({ status: "stale", place: "here" }, { status: "connected" });
    expect(here.labels).toEqual(["Check again", "Request again"]);
    expect(here.press("Check again")).toEqual({ type: "checkAccess" });
    expect(shelf({ status: "stale", place: "address" }, { status: "connected" }).labels).toEqual([
      "Request again",
    ]);
  });

  it("an identity that couldn't be read: Look again looks again, while waiting or after", () => {
    const waiting = shelf({ status: "identity-unread", place: "ssh" }, { status: "connected" });
    expect(waiting.press("Look again")).toEqual({ type: "checkAccess" });
    const after = shelf({ status: "identity-unread", place: "ssh" });
    expect(after.press("Look again")).toEqual({ type: "setupRetryRoute" });
  });

  it("a host without setup's looks offers Reconnect, never a look it can't open", () => {
    expect(shelf({ status: "unconfirmed", place: "here" }, {}, false).labels).toEqual([
      "Reconnect",
    ]);
    expect(shelf({ status: "identity-changed", place: "ssh" }, {}, false).labels).toEqual([]);
  });

  it("confirmed: nothing is still under way, so the bar no longer says it connects again", () => {
    expect(shelf({ status: "approved" }, { status: "connected" }).result).toBeNull();
  });
});
