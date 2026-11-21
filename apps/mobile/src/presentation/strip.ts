// The status strip's state and words (docs/design/visual-language.md, section 11),
// derived from state the shell already has.

import type { ClawtrateState, Transcript } from "@clawtrate/core";
import { gatewayLabel } from "../../../../packages/ui/src/format.ts";

/**
 * Where the shell is after a connection problem: "dropped" from the moment the
 * connection is not connected until the gateway's bots and tasks (and the open
 * task) have loaded again, then "synced" for four seconds. Only a drop leads
 * to "Synced"; a first load never does.
 */
export type SyncPhase = "none" | "dropped" | "synced";

export const SYNCED_FOR_MS = 4000;

/** The open task failed to reload but still shows what was loaded before. */
export function refreshFailed(transcript: Transcript | undefined): boolean {
  return transcript?.status === "error" && transcript.items.length > 0;
}

/**
 * The open task's history has loaded since the latest connect. A transcript
 * kept from before the drop still says "ready", so its load time decides.
 */
export function taskInSync(state: ClawtrateState, taskKey: string | null): boolean {
  if (!taskKey) return true;
  const transcript = state.transcripts[taskKey];
  return (
    transcript?.status === "ready" &&
    (transcript.loadedAt ?? 0) >= (state.connection.connectedAt ?? 0)
  );
}

export type Strip = {
  tone: "warn" | "danger" | "ok" | "off";
  /** The state. It keeps its place beside the action and shortens only after the explanation. */
  text: string;
  /** The state in fewer words, for the one-pane layout. */
  short?: string;
  /** The explanation after the middle dot; it shortens first. */
  more: string | null;
  action: "retry" | "reload" | "reconnect" | null;
  /** Show the host's retry countdown in the text. */
  countdown: boolean;
};

/**
 * The one strip for the conversation, from state the shell already has. The
 * footer's dot and words and the composer read the same connection state, so
 * the three always agree.
 */
export function stripFor(
  state: ClawtrateState,
  phase: SyncPhase,
  taskKey: string | null,
): Strip | null {
  const { connection, discovery } = state;
  const transcript = taskKey ? state.transcripts[taskKey] : undefined;
  switch (connection.status) {
    case "reconnecting":
    case "connecting":
      return {
        tone: "warn",
        text: "Reconnecting",
        more: "showing saved messages",
        action: "retry",
        countdown: true,
      };
    case "error":
      return {
        tone: "danger",
        text: `Can't reach ${gatewayLabel(connection.gatewayUrl)}`,
        short: "Can't reach the gateway",
        more: connection.error?.message ?? "showing saved messages",
        action: "retry",
        countdown: false,
      };
    case "disconnected":
      return {
        tone: "off",
        text: "Disconnected",
        more: "showing saved messages",
        action: "reconnect",
        countdown: false,
      };
    case "connected":
      break;
    default:
      return null;
  }
  if (discovery.status === "error") {
    return {
      tone: "danger",
      text: "Couldn't load bots and tasks",
      short: "Couldn't load bots",
      more: discovery.error,
      action: "retry",
      countdown: false,
    };
  }
  if (phase === "dropped") {
    if (transcript?.status === "error") {
      return {
        tone: "danger",
        text: "Couldn't sync this task",
        more: null,
        action: "reload",
        countdown: false,
      };
    }
    // Back, but bots, tasks or the open task have not loaded again yet.
    return { tone: "warn", text: "Connected", more: "catching up", action: null, countdown: false };
  }
  if (phase === "synced") {
    return { tone: "ok", text: "Synced", more: null, action: null, countdown: false };
  }
  return null;
}

/** The strip's words for its state, with the host's retry countdown when it shows one. */
export function stripText(strip: Strip, seconds: number | null): string {
  if (!strip.countdown) return strip.text;
  return seconds ? `Reconnecting in ${seconds}s` : "Reconnecting…";
}

/** The strip's action, in words. */
export const STRIP_ACTION_WORDS: Record<NonNullable<Strip["action"]>, string> = {
  retry: "Retry now",
  reconnect: "Reconnect",
  reload: "Try again",
};
