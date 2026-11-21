// Transcript stamps and the copy for empty, loading and failed states.

import { daysAgo } from "../../../../packages/ui/src/format.ts";

/** More than this between two messages puts a stamp between them. */
export const STAMP_GAP_MS = 10 * 60_000;

/**
 * Whether a centred stamp goes before a message at `at`: before the first
 * message, and wherever more than ten minutes pass or the day changes.
 * `previous` is the time of the last message with a time.
 */
export function stampBefore(previous: number | null, at: number | null): boolean {
  return (
    at !== null &&
    (previous === null || at - previous > STAMP_GAP_MS || daysAgo(previous, at) !== 0)
  );
}

export const CONVERSATION_WORDS = {
  waitingTitle: "Waiting for the gateway",
  waitingBody: "This conversation loads when the connection returns.",
  loadFailed: "Could not load this conversation",
  tryAgain: "Try again",
  emptyTitle: "Nothing here yet",
  refreshFailed: "Couldn't refresh this conversation. Showing what was loaded before.",
  loading: "Loading conversation",
  /** A message the gateway truncated when it stored it: the desktop's words for a truncated result. */
  truncated: "Truncated by the gateway. The rest was not sent.",
  /** A message this client cut to its bound: the gateway sent it whole. */
  shortened: "Shortened here. Some of this message is missing from this view.",
  /** The task has older messages than were loaded: the desktop's words for a partial history. */
  earlier: "Only part of this task's history is loaded here, so earlier messages may be missing.",
  jumpToLatest: "Jump to latest",
} as const;

/** A task with no messages yet, on a connection that reads. */
export function emptyBody(botName: string): string {
  return `Messages between you and ${botName} in this task will appear here.`;
}

/** The read-only explanation where the composer goes, on a host that only reads. */
export function readOnlyWords(botName: string): { lead: string; rest: string } {
  return {
    lead: "Read-only.",
    rest: ` You can follow ${botName}'s work here. Approvals and questions aren't shown on this connection.`,
  };
}
