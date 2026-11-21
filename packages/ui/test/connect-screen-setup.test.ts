// The first screen while setup's Connect is answered by a change of this
// device's saved pairing (docs/decisions.md, "The host's confirmation"): the
// connection ends in its setup code and the card asks again, in the words
// for what is there now, instead of the address-and-token form.
import {
  initialState,
  initialSetupState,
  SETUP_PAIRING_APPEARED,
  SETUP_PAIRING_GONE,
  type ClawtrateBridge,
  type HostInfo,
  type SetupState,
} from "@clawtrate/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BridgeProvider } from "../src/bridge.tsx";
import { ConnectScreen } from "../src/ConnectScreen.tsx";

const URL = "ws://127.0.0.1:19940";
const info: HostInfo = {
  kind: "desktop",
  version: "test",
  devGateway: null,
  setup: { look: true, pair: true, platform: "darwin" },
};

/** The card's state after the controller sent the person back to it, and the ended connection. */
function render(access: "new" | "paired", code: string): string {
  const setup: SetupState = {
    ...initialSetupState,
    phase: "found",
    look: {
      outcome: "running",
      reason: null,
      version: "2026.10.6",
      profile: "default",
      listens: "loopback",
      service: "none",
      port: 19940,
      authMode: null,
      access,
      others: [],
    },
  };
  const connection = {
    ...initialState.connection,
    status: "error" as const,
    gatewayUrl: URL,
    error: { code, message: "fixture", hint: null },
  };
  return renderToStaticMarkup(
    createElement(BridgeProvider, {
      bridge: { info } as ClawtrateBridge,
      children: createElement(ConnectScreen, {
        info,
        setup,
        connection,
        discovery: initialState.discovery,
      }),
    }),
  );
}

describe("the setup card after a change of this device's saved pairing", () => {
  it("F-492: a pairing gone at the handshake shows the card for a new pairing, not the form", () => {
    const html = render("new", SETUP_PAIRING_GONE);
    expect(html).toContain("OpenClaw is running");
    expect(html).toContain("The gateway may ask its owner to approve this device.");
    expect(html).not.toContain('placeholder="Gateway address"');
  });

  it("F-492: a pairing that appeared at the handshake shows the card for reusing it, not the form", () => {
    const html = render("paired", SETUP_PAIRING_APPEARED);
    expect(html).toContain("OpenClaw is running");
    expect(html).toContain("This device has a saved pairing for this address.");
    expect(html).not.toContain('placeholder="Gateway address"');
  });
});
