// Which screen the iPhone app shows. The connection screens come first; once
// the gateway's bots have loaded, the app is three screens deep
// (docs/design/visual-language.md, section 12): Home, a bot's task list, a
// task's chat. Back goes from the chat to the task list and from there to
// Home, whatever the bot's number of tasks. Pure, so the unit tests cover it.

import type { ClawtrateState, ConnectionError } from "@clawtrate/core";
import { screenFor } from "../../../packages/ui/src/screen.ts";

export type Route =
  { name: "home" } | { name: "bot"; botId: string } | { name: "task"; botId: string; key: string };

export const HOME: Route = { name: "home" };

/** Where Back goes. */
export function back(route: Route): Route {
  switch (route.name) {
    case "task":
      return { name: "bot", botId: route.botId };
    default:
      return HOME;
  }
}

/** A route whose bot or task the gateway no longer lists falls back to what still exists. */
export function current(route: Route, state: ClawtrateState): Route {
  if (route.name === "home") return route;
  if (!state.bots.some((bot) => bot.id === route.botId)) return HOME;
  if (route.name === "task") {
    const tasks = state.tasksByBot[route.botId];
    // Tasks still loading keep the chat open; a task the list dropped goes back to it.
    if (tasks && state.discovery.status === "ready" && !tasks.some((t) => t.key === route.key))
      return { name: "bot", botId: route.botId };
  }
  return route;
}

export type ConnectView = "welcome" | "address" | "setup" | "pairing" | "protocol";

/**
 * Which connection screen: the protocol notice for a gateway on another
 * protocol (kept while Retry repeats the handshake), the pairing screen while
 * the device waits for approval, the step list while it connects and loads,
 * the address form once the person chose to connect or something failed, and
 * else the welcome screen.
 */
export function connectView(
  state: ClawtrateState,
  mismatch: ConnectionError | null,
  addressOpen: boolean,
): ConnectView {
  const { connection, discovery } = state;
  if (mismatch) return "protocol";
  if (connection.status === "pairing" && connection.pairing) return "pairing";
  const loadingBots = connection.status === "connected" && discovery.status === "loading";
  if (loadingBots || connection.status === "connecting") return "setup";
  if (addressOpen || connection.error) return "address";
  // A gateway kept but not connected (from an earlier install, or after
  // Disconnect) is offered on the welcome screen, never reopened by itself.
  if (connection.status === "disconnected") return "welcome";
  if (connection.gatewayUrl) return "address";
  return "welcome";
}

/**
 * The protocol mismatch to keep on screen: set when the gateway answers one,
 * kept while a retry repeats the handshake, dropped once a handshake
 * succeeds, a pairing starts or the person chooses another gateway.
 */
export function keptMismatch(
  state: ClawtrateState,
  kept: ConnectionError | null,
): ConnectionError | null {
  const { status, error } = state.connection;
  if (error?.code === "PROTOCOL_MISMATCH") return error;
  if (kept && (status === "connected" || status === "idle" || status === "pairing")) return null;
  return kept;
}

/** The app is past the connection screens. */
export function inShell(state: ClawtrateState, mismatch: ConnectionError | null): boolean {
  return !mismatch && screenFor(state) === "shell";
}
