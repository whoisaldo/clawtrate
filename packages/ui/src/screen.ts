import type { ClawtrateState, SetupState } from "@clawtrate/core";
import type { SetupView } from "./setup/Setup.tsx";

/**
 * Which screen to show. Once there is anything to read, the shell stays up
 * through every reconnect, failure and retry; only a new pairing request or a
 * first connection with nothing loaded shows the connection screen.
 */
export function screenFor(state: ClawtrateState): "connect" | "shell" {
  const { status, error } = state.connection;
  if (status === "pairing") return "connect";
  // A gateway on another protocol gets a full-window notice, whatever is cached.
  if (error?.code === "PROTOCOL_MISMATCH") return "connect";
  if (state.bots.length > 0) return "shell";
  // The setup steps stay until the bots have loaded; then the app opens.
  if (status === "connected" && state.discovery.status === "loading") return "connect";
  return status === "connected" ? "shell" : "connect";
}

/** Whether the host has setup under way: a look, a decision, Connect, or another computer named. */
export const setupUnderWay = (setup: SetupState | undefined): boolean =>
  setup !== undefined && (setup.phase !== "idle" || Boolean(setup.there));

/**
 * The setup screen once the host's setup changed: setup the host started
 * while the first question was showing (a restore at launch, or another
 * window) opens where it stands; anything else keeps the person's choice.
 */
export function followSetup(view: SetupView, wasUnderWay: boolean, underWay: boolean): SetupView {
  return underWay && !wasUnderWay && view === "first" ? "here" : view;
}
