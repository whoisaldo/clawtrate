import { isApprovalDisconnect, type ClawtrateState, type Transcript } from "@clawtrate/core";
import { useEffect, useState } from "react";
import type { ApprovalAction } from "./ApprovalWait.tsx";
import { gatewayLabel } from "./format.ts";

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

export function useSyncPhase(state: ClawtrateState, taskKey: string | null): SyncPhase {
  const connected = state.connection.status === "connected";
  const [phase, setPhase] = useState<SyncPhase>(connected ? "none" : "dropped");
  // Adjusted while rendering, so the strip never shows a stale state for a frame.
  // "Synced" waits for bots, tasks and the open task's reload to succeed.
  if (!connected && phase !== "dropped") setPhase("dropped");
  else if (
    connected &&
    phase === "dropped" &&
    state.discovery.status === "ready" &&
    taskInSync(state, taskKey)
  ) {
    setPhase("synced");
  }
  useEffect(() => {
    if (phase !== "synced") return;
    const timer = setTimeout(() => setPhase("none"), SYNCED_FOR_MS);
    return () => clearTimeout(timer);
  }, [phase]);
  return phase;
}

export type Strip = {
  tone: "warn" | "danger" | "ok" | "off";
  /** The state. It keeps its place beside the action and shortens only after the explanation. */
  text: string;
  /** The state in fewer words, for the one-pane layout. */
  short?: string;
  /** The explanation after the middle dot; it shortens first. */
  more: string | null;
  /**
   * `route-retry` restores an SSH route's forward at once; `review` opens that
   * computer's screens again (docs/design/setup.md §8).
   */
  action: "retry" | "reload" | "reconnect" | "route-retry" | "review" | "approval" | null;
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
  // Clawtrate disconnected after an approval it couldn't confirm (§9): said before a route's own
  // state, with the same actions as the access bar, never a plain Reconnect to another gateway.
  if (connection.status === "error" && isApprovalDisconnect(connection.error?.code))
    return {
      tone: "danger",
      text: "Disconnected",
      more: connection.error?.message ?? null,
      action: "approval",
      countdown: false,
    };
  const route = routeStrip(state);
  if (route) return route;
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

/**
 * The SSH route's own words (docs/design/setup.md §8), while its forward is
 * not simply up: being restored, back, out of reach, or stopped for a reason
 * the person decides about. Null when the route is up, or there is none.
 */
export function routeStrip(state: ClawtrateState): Strip | null {
  const route = state.setup?.route;
  if (!route) return null;
  const account = route.account;
  switch (route.phase) {
    case "restoring":
      return {
        tone: "warn",
        text: `Restoring the connection to ${account}`,
        short: "Restoring the connection",
        more: "showing saved messages",
        // Retry is offered only while the host can act on it: the forward waiting for its next try.
        action: route.retry ? "route-retry" : null,
        countdown: false,
      };
    case "restored":
      return {
        tone: "ok",
        text: `Connected to OpenClaw on ${account} again`,
        short: "Connected again",
        more: null,
        action: null,
        countdown: false,
      };
    case "unreachable":
      return {
        tone: "danger",
        text: `Can't reach ${account}`,
        short: "Can't reach the computer",
        more: route.cause ?? "showing saved messages",
        action: "route-retry",
        countdown: false,
      };
    case "key-changed":
      return {
        tone: "danger",
        text: `SSH presented a key that differs from the saved key for ${account}`,
        short: "The SSH key differs",
        more: null,
        action: "review",
        countdown: false,
      };
    case "service-changed":
      return {
        tone: "danger",
        text: "The service found at the gateway port changed",
        short: "The service changed",
        more: null,
        action: "review",
        countdown: false,
      };
    case "different-gateway":
      return {
        tone: "danger",
        text: "A different OpenClaw gateway answered",
        short: "A different gateway",
        more: null,
        action: "review",
        countdown: false,
      };
    case "stopped":
      return {
        tone: "danger",
        text: `OpenClaw stopped on ${account}`,
        more: null,
        action: "review",
        countdown: false,
      };
    case "failed":
      return {
        tone: "danger",
        text: `Couldn't restore the connection to OpenClaw on ${account}`,
        short: "Couldn't restore the connection",
        more: null,
        action: "review",
        countdown: false,
      };
    default:
      return null;
  }
}

/**
 * One compact pill in the protected band under the title pill, centred on the
 * conversation. It overlays the transcript, so nothing moves when it comes or
 * goes, and it mounts only when needed, so its countdown starts then.
 */
export function StatusStrip({
  strip,
  retryAt,
  onRetry,
  onReload,
  onRoute,
  approval = null,
}: {
  strip: Strip;
  retryAt: number | null;
  onRetry: () => void;
  onReload: () => void;
  /** The SSH route's "Retry now" and "Review", both the host's. */
  onRoute?: () => void;
  /** After an approval Clawtrate couldn't confirm: the access bar's first action (§9). */
  approval?: ApprovalAction | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!strip.countdown) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [strip.countdown]);
  const seconds =
    strip.countdown && retryAt !== null ? Math.max(0, Math.ceil((retryAt - now) / 1000)) : null;
  const text = strip.countdown
    ? seconds
      ? `Reconnecting in ${seconds}s`
      : "Reconnecting…"
    : strip.text;
  return (
    <div
      className="status-strip"
      role="status"
      data-tone={strip.tone}
      data-testid="status-strip"
      title={strip.more ? `${text} · ${strip.more}` : text}
    >
      <span className="status-dot" aria-hidden="true" />
      <span className="status-strip-text">
        {strip.short ? (
          <strong>
            <span className="strip-long">{text}</span>
            <span className="strip-short">{strip.short}</span>
          </strong>
        ) : (
          <strong>{text}</strong>
        )}
        {strip.more && <span>· {strip.more}</span>}
      </span>
      {strip.action === "approval" && approval && (
        <button type="button" onClick={approval.run}>
          {approval.label}
        </button>
      )}
      {strip.action && strip.action !== "approval" && (
        <button
          type="button"
          onClick={
            strip.action === "reload"
              ? onReload
              : strip.action === "route-retry" || strip.action === "review"
                ? (onRoute ?? onRetry)
                : onRetry
          }
        >
          {strip.action === "retry" || strip.action === "route-retry"
            ? "Retry now"
            : strip.action === "reconnect"
              ? "Reconnect"
              : strip.action === "review"
                ? "Review"
                : "Try again"}
        </button>
      )}
    </div>
  );
}
