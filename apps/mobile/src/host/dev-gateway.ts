// Which approve command the pairing screen shows. A gateway the person typed
// gets the generic OpenClaw command with its note. A development gateway
// instance (`pnpm dev-gateway`) gets the tool's own command, never an
// unqualified `openclaw` one that would address a default profile: the
// Simulator checks launch the app with its address and instance as launch
// arguments (`-ClawtrateDevGatewayURL ws://…`, `-ClawtrateDevGatewayInstance
// <name>`), which iOS puts in the app's user defaults for that launch.

import {
  defaultApprovalInstructions,
  type ApprovalInstructions,
  type ClawtrateHost,
} from "@clawtrate/core";

export type DevGatewayHint = { url: string; instance: string | null };

export const DEV_GATEWAY_URL_ARG = "ClawtrateDevGatewayURL";
export const DEV_GATEWAY_INSTANCE_ARG = "ClawtrateDevGatewayInstance";

/** A dev-gateway instance name: the tool's own rule (`INSTANCE_NAME_PATTERN`). */
const INSTANCE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/;
/** The development gateway listens on loopback only. */
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOOPBACK_URL = /^ws:\/\/127\.0\.0\.1:\d{1,5}$/;

/** The development gateway named by the launch arguments, when both are well formed. */
export function devGatewayHint(read: (key: string) => unknown): DevGatewayHint | null {
  const url = read(DEV_GATEWAY_URL_ARG);
  const instance = read(DEV_GATEWAY_INSTANCE_ARG);
  if (typeof url !== "string" || !LOOPBACK_URL.test(url)) return null;
  if (instance === undefined || instance === null || instance === "")
    return { url, instance: null };
  if (typeof instance !== "string" || !INSTANCE_NAME.test(instance)) return null;
  return { url, instance };
}

/** The approve command for a pairing request, as the desktop host chooses it. */
export function approvalInstructionsFor(
  hint: DevGatewayHint | null,
): NonNullable<ClawtrateHost["approvalInstructions"]> {
  return (gatewayUrl, requestId): ApprovalInstructions =>
    hint && gatewayUrl === hint.url
      ? {
          command:
            hint.instance === null
              ? "pnpm dev-gateway approve"
              : `pnpm dev-gateway approve --instance ${hint.instance}`,
          note: null,
        }
      : REQUEST_ID.test(requestId)
        ? defaultApprovalInstructions(gatewayUrl, requestId)
        : {
            command: "",
            note: "The gateway's owner approves this device among the gateway's pending requests, on the machine where the gateway runs.",
          };
}
