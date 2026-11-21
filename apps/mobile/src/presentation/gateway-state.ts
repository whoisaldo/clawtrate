// The connection's state and its problem, as Settings' Gateway pane names them
// (F-227).

import type { ConnectionState } from "@clawtrate/core";
import { failureTitle } from "./connect-words.ts";

/** The connection's state, as the Gateway pane names it. */
export function gatewayState(connection: ConnectionState): string {
  switch (connection.status) {
    case "connected":
      // Re-pairing: the gateway holds this device's new authorization until its owner decides.
      return connection.upgrade.status === "requesting" || connection.upgrade.status === "pending"
        ? "Pairing pending"
        : "Connected";
    case "pairing":
      return "Pairing pending";
    case "disconnected":
      return "Disconnected";
    case "idle":
      return "Not connected";
    case "error":
      return "Offline";
    case "connecting":
    case "reconnecting":
      // An attempt under way is connecting; waiting for the next one is offline.
      return connection.retryAt === null ? "Connecting" : "Offline";
  }
}

/** The pane's error line: pairing rejected or expired, unreachable, protocol incompatible. */
export function gatewayProblem(
  connection: ConnectionState,
): { title: string; message: string } | null {
  const error = connection.error;
  if (!error) return null;
  if (error.code === "PROTOCOL_MISMATCH") {
    return { title: "This gateway speaks another protocol", message: error.message };
  }
  if (error.code === "PAIRING_ENDED") {
    return { title: failureTitle(error.code), message: error.message };
  }
  if (connection.status === "connected") return null;
  return {
    title: "Can't reach the gateway",
    message: [error.message, error.hint].filter(Boolean).join(" "),
  };
}

/** The Gateway pane's words. */
export const SETTINGS_WORDS = {
  title: "Settings",
  close: "Close settings",
  gateway: "Gateway",
  address: "Address",
  noAddress: "None yet",
  state: "State",
  device: "This device",
  scopes: "Granted scopes",
  noScopes: "None while not connected",
  noneGranted: "None granted",
  server: "Gateway",
  reconnect: "Reconnect",
  disconnect: "Disconnect",
  useAnother: "Use another gateway",
} as const;

/** The state's dot: connected, connecting, unreachable, or off. */
export function gatewayDot(state: string): "connected" | "connecting" | "error" | "disconnected" {
  return state === "Connected"
    ? "connected"
    : state === "Connecting" || state === "Pairing pending"
      ? "connecting"
      : state === "Offline"
        ? "error"
        : "disconnected";
}

/**
 * What the pane offers: Reconnect from Offline or Disconnected, Disconnect
 * (which keeps the pairing) while connected or trying to be, and Use another
 * gateway (which forgets this one) whenever there is a gateway.
 */
export function gatewayActions(connection: ConnectionState): {
  reconnect: boolean;
  disconnect: boolean;
  forget: boolean;
} {
  const state = gatewayState(connection);
  return {
    reconnect: state === "Offline" || state === "Disconnected",
    disconnect:
      connection.status === "connected" ||
      connection.status === "connecting" ||
      connection.status === "reconnecting",
    forget: connection.gatewayUrl !== null,
  };
}

/** The gateway's version and protocol, once the hello said them. */
export function serverWords(connection: ConnectionState): string | null {
  if (!connection.serverVersion) return null;
  return `OpenClaw ${connection.serverVersion}${connection.protocol !== null ? ` · protocol ${connection.protocol}` : ""}`;
}

/** The scopes the gateway granted, while connected. */
export function grantedWords(connection: ConnectionState): string {
  if (connection.status !== "connected") return SETTINGS_WORDS.noScopes;
  return connection.scopes.length > 0 ? connection.scopes.join(", ") : SETTINGS_WORDS.noneGranted;
}

/**
 * The gateway's address as Settings shows it: scheme, host, port and path, never
 * a user name, a password, a query or a fragment someone put in the address.
 */
export function addressWords(url: string | null): string {
  if (!url) return SETTINGS_WORDS.noAddress;
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${path}`;
  } catch {
    return url.replace(/[?#].*$/, "").replace(/\/\/[^/@]*@/, "//");
  }
}

/** The pane's last line: the pairing is kept, and what this device may do. */
export function pairingNote(
  gateway: string,
  holds: { admin?: boolean; holdsAll: boolean; readOnly: boolean | undefined },
): string {
  return `${gateway} keeps this device's pairing while it is disconnected. ${
    holds.admin
      ? "This device holds admin access, which it asked for to change bots and accounts."
      : holds.holdsAll
        ? "This device can send, stop and answer."
        : holds.readOnly
          ? "This device asks for read access only."
          : "This device reads. Re-pair to ask for sending, stopping and answering."
  }`;
}
