// The copy and setup steps for the iOS connection and pairing screens.

import type { ConnectionState } from "@clawtrate/core";
import { gatewayLabel } from "../../../../packages/ui/src/format.ts";

export const PRODUCT_NAME = "Clawtrate";
export const SLOGAN = "Your OpenClaw agents, orchestrated.";

export const CONNECT_WORDS = {
  /** The welcome screen's one action (F-001), and the connect form's submit on the desktop. */
  connect: "Connect a gateway",
  connecting: "Connecting…",
  connectTitle: "Connect to your gateway",
  address: "Gateway address",
  token: "Token, for the first pairing only",
  tokenLabel: "Gateway token, needed for the first pairing only",
  devGateway: "Use the development gateway",
  hint: `${PRODUCT_NAME} works with an OpenClaw gateway you already run. It asks for read access only, and the token is used for the first pairing.`,
  missingAddress: {
    title: "Enter the gateway's address",
    message: "It looks like ws://host:port or wss://host.",
  },
  tryAgain: "Try again",
  useAnother: "Use another gateway",
  approveTitle: "Approve this device",
  copyApprove: "Copy approve command",
  copied: "Copied.",
  scopesLabel: "This device asks to",
  checkNow: "Check now",
  checking: "Checking…",
  setupLabel: "Setting up",
  waitingStep: "Waiting for approval",
  waiting: "Waiting for approval, checking again",
  notYet: "Not approved yet, checking again",
  protocolTitle: "This gateway speaks another protocol",
  retry: "Retry",
  retrying: "Retrying…",
  chooseAnother: "Choose another gateway",
  preparingIdentity: "Preparing device identity…",
  /** The welcome screen's choice for a gateway kept from before: never taken without asking. */
  reconnectTo: (gateway: string) => `Reconnect to ${gateway}`,
} as const;

/**
 * A connection that is not encrypted: a `ws:` address whose host is not this
 * device. Clawtrate does not refuse it (a gateway on the person's own tailnet
 * is the usual case), but says so before connecting and beside the address.
 */
export const CLEARTEXT_WORDS = {
  title: "This connection is not encrypted",
  body: "Clawtrate does not encrypt a ws:// connection, so the gateway's token and your conversations can be read on the way. Use it only on a network you trust, such as your own tailnet.",
} as const;

/** Whether a gateway address is unencrypted and leaves this device. */
export function isCleartext(url: string | null | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== "ws:") return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return !(host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host));
}

/**
 * The scopes the pending-approval screen lists: those this client asked for and
 * signed (`connection.requestedScopes`), never the gateway's echo of them. When
 * the echo differs, `echoed` holds it, so the screen can say so and show both.
 */
export function pairingScopes(connection: ConnectionState): {
  asked: string[];
  echoed: string[] | null;
} {
  const asked = connection.requestedScopes;
  const echo = connection.pairing?.requestedScopes ?? [];
  const same = echo.length === asked.length && echo.every((scope) => asked.includes(scope));
  return { asked, echoed: same ? null : echo };
}

/** What the screen says when the gateway's echo of the request differs from what was signed. */
export function scopesDifferWords(echoed: string[]): string {
  return `The gateway reports this request as asking for ${
    echoed.length > 0 ? echoed.map(scopeWords).join(", ") : "nothing"
  }. This device asked only for what is listed above.`;
}

/** A connection failure's title. */
export function failureTitle(code: string | null | undefined): string {
  switch (code) {
    case "PAIRING_ENDED":
      return "The pairing request is no longer pending";
    default:
      return "Could not connect";
  }
}

/** What a requested scope lets this device do, in plain words. */
const SCOPE_WORDS: Record<string, string> = {
  "operator.read": "Read bots, tasks and conversations",
};

/** A requested scope in plain words; an unknown scope shows its id. */
export function scopeWords(scope: string): string {
  return SCOPE_WORDS[scope] ?? scope;
}

/** The pairing screen's sentence under its title. */
export function pairingLede(gatewayUrl: string | null): string {
  return `${gatewayLabel(gatewayUrl)} requires approval for this device. Approve it on the gateway's machine and ${PRODUCT_NAME} will retry the connection.`;
}

/** The seconds until the host's next retry, after the waiting words: " in 4s", or " now". */
export function countdownWords(until: number | null, now: number): string {
  // No retry waiting means an attempt is under way.
  if (until === null) return " now";
  const seconds = Math.max(0, Math.ceil((until - now) / 1000));
  return seconds > 0 ? ` in ${seconds}s` : " now";
}

/** The protocol notice's sentence: both versions, and what to do. */
export function protocolLede(
  gatewayUrl: string | null,
  protocol: { gateway: number | null; client: number } | undefined,
): string {
  const gateway = gatewayLabel(gatewayUrl);
  return `${
    protocol?.gateway === null || protocol?.gateway === undefined
      ? `${gateway} does not speak protocol ${protocol?.client ?? ""}, the one this version of ${PRODUCT_NAME} speaks.`
      : `${gateway} speaks protocol ${protocol.gateway}. This version of ${PRODUCT_NAME} speaks protocol ${protocol.client}.`
  } Update the one that is older, then retry.`;
}

export type SetupStepState = "done" | "current" | "pending";

export type SetupStep = {
  state: SetupStepState;
  /** Null for the waiting step, whose words the screen writes with its countdown. */
  label: string | null;
  /** The pairing step while it waits for approval. */
  waiting?: boolean;
};

/**
 * Setting up a gateway, one step at a time: connecting, pairing this device,
 * loading its bots (F-003). The app opens as soon as the bots have loaded.
 */
export function setupSteps(connection: ConnectionState, loadingBots: boolean): SetupStep[] {
  const gateway = gatewayLabel(connection.gatewayUrl);
  const pairing = connection.status === "pairing";
  const reached = pairing || loadingBots;
  return [
    reached
      ? { state: "done", label: `Connected to ${gateway}` }
      : { state: "current", label: `Connecting to ${gateway}` },
    loadingBots || (connection.paired && !pairing)
      ? { state: "done", label: "This device is paired" }
      : pairing
        ? { state: "current", label: null, waiting: true }
        : { state: "pending", label: "Pair this device" },
    loadingBots
      ? { state: "current", label: "Loading bots" }
      : { state: "pending", label: "Load bots" },
  ];
}

/**
 * The connection screens' foot line, for support: on the pairing screen the
 * request and this device, on the protocol notice the gateway and its version,
 * else this device; then the host and its version ("Desktop 0.1.0").
 */
export function footWords(
  screen: "connect" | "pairing" | "protocol",
  connection: ConnectionState,
  host: string,
): string {
  switch (screen) {
    case "pairing": {
      const pairing = connection.pairing!;
      return `Request ${pairing.requestId.slice(0, 8)} · this device ${(connection.deviceId ?? pairing.deviceId).slice(0, 8)} · ${host}`;
    }
    case "protocol":
      return `${gatewayLabel(connection.gatewayUrl)}${connection.serverVersion ? ` · OpenClaw ${connection.serverVersion}` : ""} · ${host}`;
    case "connect":
      return `${connection.deviceId ? `This device ${connection.deviceId.slice(0, 8)}` : CONNECT_WORDS.preparingIdentity} · ${host}`;
  }
}
