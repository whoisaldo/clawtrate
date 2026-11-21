// Keeps the connector's control socket to the relay up: restarts it when it ends, backs off
// while it keeps ending quickly, restarts one that stays open but stops answering, and never
// restarts after shutdown.
//
// Ported from T3 Code, `apps/server/src/cloud/ManagedEndpointRuntime.ts` at commit 18d1c4db
// (its cloudflared supervision: `superviseConnector`, `watchConnectorReadiness`, `applyConfig`
// and their constants), rewritten in plain TypeScript without Effect, with a relay control
// socket in place of a cloudflared process.
//
// MIT License
//
// Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/** A link that stayed up this long was healthy: its exit restarts at once and resets the backoff. */
export const RESTART_STABLE_UPTIME_MS = 30_000;
export const RESTART_BACKOFF_BASE_MS = 1_000;
export const RESTART_BACKOFF_MAX_MS = 60_000;
/**
 * A link that has not registered by now is restarted. The relay's challenge lasts 60 seconds
 * and it closes a socket that does not answer; this catches one that never even challenges.
 */
export const REGISTRATION_TIMEOUT_MS = 90_000;
/** How often readiness is read, and how many "not ready" readings in a row restart the link. */
export const READINESS_INTERVAL_MS = 30_000;
export const NOT_READY_CHECKS_BEFORE_RESTART = 6;
export const NOT_READY_CHECKS_MAX = 60;

/**
 * What a link says when asked, like cloudflared's `/ready`: only an explicit "not ready"
 * counts. "unknown" (not registered yet) says nothing.
 */
export type Readiness = "ready" | "not_ready" | "unknown";

/** One control socket's life. */
export interface ControlLink {
  /** Ends the link. Its `exited` event follows, or is not needed. */
  close(): void;
  readiness(): Readiness;
}

export interface LinkEvents {
  registered(): void;
  /** The link ended. Called at most once; later calls are ignored. */
  exited(reason: string): void;
}

export interface Timers {
  /** Monotonic milliseconds. */
  now(): number;
  setTimeout(action: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTimers: Timers = {
  now: () => Math.floor(performance.now()),
  setTimeout: (action, ms) => setTimeout(action, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type SupervisorState =
  /** No config, or stopped. */
  | "stopped"
  /** A link is open and not registered yet. */
  | "connecting"
  | "registered"
  /** Waiting out a backoff before the next link. */
  | "waiting";

export interface SupervisorStatus {
  readonly state: SupervisorState;
  /** The delay the next quick exit will wait, in milliseconds. */
  readonly nextRestartDelayMs: number;
  /** How many links have been started. */
  readonly starts: number;
  readonly lastExit: string | null;
}

export interface SupervisorOptions<C> {
  connect(config: C, events: LinkEvents): ControlLink;
  /** Two configs with the same key are the same link: a repeat keeps the backoff. */
  configKey(config: C): string;
  timers?: Timers;
  onChange?(status: SupervisorStatus): void;
  log?(message: string): void;
}

interface Active {
  readonly link: ControlLink;
  readonly configKey: string;
  readonly startedAtMs: number;
  registered: boolean;
  exited: boolean;
  registrationTimer: unknown;
}

export class Supervisor<C> {
  readonly #options: SupervisorOptions<C>;
  readonly #timers: Timers;
  #desired: C | null = null;
  #active: Active | null = null;
  #restartDelayMs = 0;
  #restartTimer: unknown = null;
  #readinessTimer: unknown = null;
  #notReadyChecks = 0;
  #notReadyThreshold = NOT_READY_CHECKS_BEFORE_RESTART;
  #stopped = false;
  #starts = 0;
  #lastExit: string | null = null;

  constructor(options: SupervisorOptions<C>) {
    this.#options = options;
    this.#timers = options.timers ?? realTimers;
  }

  get status(): SupervisorStatus {
    let state: SupervisorState = "stopped";
    if (this.#active !== null) state = this.#active.registered ? "registered" : "connecting";
    else if (this.#restartTimer !== null) state = "waiting";
    return {
      state,
      nextRestartDelayMs: this.#restartDelayMs,
      starts: this.#starts,
      lastExit: this.#lastExit,
    };
  }

  /**
   * Sets what the link should be. The same config again keeps the backoff, or every recovery
   * that returns the same settings would reset a crash loop; a different one resets it and
   * replaces the link. Null closes the link.
   */
  applyConfig(config: C | null): void {
    if (this.#stopped) return;
    const desired = this.#desired;
    const unchanged =
      desired !== null &&
      config !== null &&
      this.#options.configKey(desired) === this.#options.configKey(config);
    if (!unchanged) this.#restartDelayMs = 0;
    this.#desired = config;
    if (unchanged && (this.#active !== null || this.#restartTimer !== null)) return;
    this.#cancelRestart();
    this.#closeActive("replaced");
    if (config !== null) this.#start(config);
    this.#changed();
  }

  /** Shutdown: closes the link and never starts another. */
  stop(): void {
    this.#stopped = true;
    this.#desired = null;
    this.#cancelRestart();
    this.#closeActive("stopped");
    this.#changed();
  }

  #start(config: C): void {
    const configKey = this.#options.configKey(config);
    const active: Active = {
      link: undefined as unknown as ControlLink,
      configKey,
      startedAtMs: this.#timers.now(),
      registered: false,
      exited: false,
      registrationTimer: null,
    };
    this.#active = active;
    this.#starts++;
    this.#notReadyChecks = 0;
    const events: LinkEvents = {
      registered: () => {
        if (this.#active !== active || active.exited) return;
        active.registered = true;
        this.#timers.clearTimeout(active.registrationTimer);
        this.#changed();
      },
      exited: (reason) => this.#onExit(active, reason),
    };
    (active as { link: ControlLink }).link = this.#options.connect(config, events);
    if (this.#active !== active) return; // It exited while connecting.
    active.registrationTimer = this.#timers.setTimeout(() => {
      if (this.#active !== active || active.registered) return;
      this.#options.log?.("The relay did not register the connector in time; restarting.");
      this.#onExit(active, "registration_timeout");
      active.link.close();
    }, REGISTRATION_TIMEOUT_MS);
    this.#armReadiness();
  }

  /** The supervision of one link's exit: only the active link's exit restarts anything. */
  #onExit(active: Active, reason: string): void {
    if (active.exited) return;
    active.exited = true;
    this.#timers.clearTimeout(active.registrationTimer);
    if (this.#active !== active) return;
    this.#active = null;
    this.#disarmReadiness();
    this.#lastExit = reason;
    const uptimeMs = this.#timers.now() - active.startedAtMs;
    let delay: number;
    if (uptimeMs >= RESTART_STABLE_UPTIME_MS) {
      delay = 0;
      this.#restartDelayMs = 0;
    } else {
      delay = this.#restartDelayMs;
      this.#restartDelayMs =
        this.#restartDelayMs === 0
          ? RESTART_BACKOFF_BASE_MS
          : Math.min(this.#restartDelayMs * 2, RESTART_BACKOFF_MAX_MS);
    }
    const desired = this.#desired;
    if (
      this.#stopped ||
      desired === null ||
      this.#options.configKey(desired) !== active.configKey
    ) {
      this.#changed();
      return;
    }
    if (delay > 0) {
      this.#options.log?.(`The relay link keeps ending (${reason}); next try in ${delay} ms.`);
    }
    this.#restartTimer = this.#timers.setTimeout(() => {
      this.#restartTimer = null;
      const current = this.#desired;
      if (this.#stopped || current === null || this.#active !== null) return;
      if (this.#options.configKey(current) !== active.configKey) return;
      this.#start(current);
      this.#changed();
    }, delay);
    this.#changed();
  }

  #armReadiness(): void {
    this.#disarmReadiness();
    this.#readinessTimer = this.#timers.setTimeout(() => {
      this.#readinessTimer = null;
      this.#checkReadiness();
    }, READINESS_INTERVAL_MS);
  }

  #disarmReadiness(): void {
    if (this.#readinessTimer !== null) this.#timers.clearTimeout(this.#readinessTimer);
    this.#readinessTimer = null;
  }

  #checkReadiness(): void {
    const active = this.#active;
    if (active === null) return;
    const readiness = active.link.readiness();
    if (readiness === "ready") {
      this.#notReadyChecks = 0;
      this.#notReadyThreshold = NOT_READY_CHECKS_BEFORE_RESTART;
    } else if (readiness === "not_ready") {
      this.#notReadyChecks++;
      if (this.#notReadyChecks >= this.#notReadyThreshold) {
        this.#notReadyChecks = 0;
        this.#notReadyThreshold = Math.min(this.#notReadyThreshold * 2, NOT_READY_CHECKS_MAX);
        this.#options.log?.("The relay link stopped answering; restarting it.");
        this.#onExit(active, "not_ready");
        active.link.close();
        return;
      }
    }
    this.#armReadiness();
  }

  #closeActive(reason: string): void {
    const active = this.#active;
    if (active === null) return;
    this.#active = null;
    active.exited = true;
    this.#timers.clearTimeout(active.registrationTimer);
    this.#disarmReadiness();
    this.#lastExit = reason;
    active.link.close();
  }

  #cancelRestart(): void {
    if (this.#restartTimer !== null) this.#timers.clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
  }

  #changed(): void {
    this.#options.onChange?.(this.status);
  }
}
