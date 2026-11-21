import { describe, expect, it } from "vitest";
import { approvalInstructionsFor as desktopInstructions } from "../../desktop/src/host/runtime.ts";
import { INSTANCE_NAME_PATTERN } from "../../../tools/dev-gateway/src/instance.ts";
import {
  approvalInstructionsFor,
  DEV_GATEWAY_INSTANCE_ARG,
  DEV_GATEWAY_URL_ARG,
  devGatewayHint,
} from "../src/host/dev-gateway.ts";

const ID = "5d2a90c4-1b7e-4f0a-9c3d-2e8f6a1b0c55";
const read = (values: Record<string, unknown>) => (key: string) => values[key];

describe("the approve command on the iOS pairing screen", () => {
  it("is the dev tool's own for the development gateway the launch arguments name, the generic one otherwise", () => {
    const hint = devGatewayHint(
      read({ [DEV_GATEWAY_URL_ARG]: "ws://127.0.0.1:19201", [DEV_GATEWAY_INSTANCE_ARG]: "checks" }),
    );
    expect(hint).toEqual({ url: "ws://127.0.0.1:19201", instance: "checks" });
    const ios = approvalInstructionsFor(hint);
    const desktop = desktopInstructions({
      url: "ws://127.0.0.1:19201",
      token: "t",
      instance: "checks",
    });
    for (const url of ["ws://127.0.0.1:19201", "ws://127.0.0.1:19202", "wss://gateway.example"]) {
      expect(ios(url, ID)).toEqual(desktop(url, ID));
    }
    expect(ios("ws://127.0.0.1:19201", ID).command).toBe(
      "pnpm dev-gateway approve --instance checks",
    );
    expect(ios("wss://gateway.example", ID).command).not.toContain("dev-gateway");
    // An id the gateway sent in another form goes into no command.
    expect(ios("wss://gateway.example", "invalid id").command).toBe("");
    expect(ios("wss://gateway.example", "invalid id").note).toContain("pending requests");
    expect(approvalInstructionsFor(null)("ws://127.0.0.1:19201", ID)).toEqual(
      desktopInstructions(null)("ws://127.0.0.1:19201", ID),
    );
  });

  it("ignores launch arguments that do not name a loopback gateway and a valid instance", () => {
    expect(devGatewayHint(read({}))).toBeNull();
    expect(devGatewayHint(read({ [DEV_GATEWAY_URL_ARG]: "wss://gateway.example" }))).toBeNull();
    expect(
      devGatewayHint(
        read({
          [DEV_GATEWAY_URL_ARG]: "ws://127.0.0.1:19201",
          [DEV_GATEWAY_INSTANCE_ARG]: "Bad Name",
        }),
      ),
    ).toBeNull();
    expect(devGatewayHint(read({ [DEV_GATEWAY_URL_ARG]: "ws://127.0.0.1:19001" }))).toEqual({
      url: "ws://127.0.0.1:19001",
      instance: null,
    });
  });

  // The rule is restated in the app, which cannot bundle the tool's Node module.
  it("checks instance names by the dev tool's own rule", () => {
    for (const name of [
      "a",
      "checks",
      "m61-ios",
      "a".repeat(24),
      "-a",
      "a-",
      "A",
      "a".repeat(25),
      "dev_x",
    ]) {
      const hint = devGatewayHint(
        read({ [DEV_GATEWAY_URL_ARG]: "ws://127.0.0.1:19201", [DEV_GATEWAY_INSTANCE_ARG]: name }),
      );
      expect(hint !== null).toBe(INSTANCE_NAME_PATTERN.test(name));
    }
  });
});
