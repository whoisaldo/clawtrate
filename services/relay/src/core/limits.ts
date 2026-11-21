// What the relay allows each relay id. The frame and relay-message sizes are the protocol's own
// (`@clawtrate/relay-protocol`); everything else here is the relay's.

import { MAX_MESSAGE_BYTES } from "@clawtrate/relay-protocol";

export interface RelayLimits {
  /** How long a phone's dial waits for the connector to open the session socket. */
  readonly dialTimeoutMs: number;
  /**
   * A registered control socket, or a spliced session, that carries nothing for this long is
   * closed. A relay ping counts, so endpoints that ping every 30 seconds stay well inside it.
   */
  readonly idleMs: number;
  /** Phones dialing or spliced at once, per relay id. */
  readonly maxSessions: number;
  /** Control sockets that have not registered yet, per relay id. */
  readonly maxPendingControls: number;
  /** Control socket connections per minute, per relay id. */
  readonly controlConnectsPerMinute: number;
  /** Dials per minute, per relay id. Session sockets per minute have the same cap. */
  readonly dialsPerMinute: number;
  /** Dials per minute, per relay id and phone address (IPv6 by its /64). */
  readonly dialsPerMinutePerAddress: number;
  /** Bytes one spliced session may carry, both directions together. */
  readonly maxSessionBytes: number;
  /**
   * Bytes waiting to be written to one socket, where the runtime reports it (Node). Above the
   * protocol's largest text message, so a slow phone can still take one whole message.
   */
  readonly maxQueuedBytes: number;
}

/** The window every per-minute count uses. */
export const RATE_WINDOW_MS = 60_000;

/**
 * How long past its expiry the relay keeps a register proof's `jti`, so a wall clock set back by
 * less than this cannot make a pruned proof pass again.
 */
export const REPLAY_RETENTION_GRACE_MS = 3_600_000;

export const DEFAULT_LIMITS: RelayLimits = {
  dialTimeoutMs: 15_000,
  idleMs: 120_000,
  maxSessions: 8,
  maxPendingControls: 4,
  controlConnectsPerMinute: 12,
  dialsPerMinute: 30,
  dialsPerMinutePerAddress: 10,
  maxSessionBytes: 1_073_741_824,
  maxQueuedBytes: MAX_MESSAGE_BYTES + 8_388_608,
};
