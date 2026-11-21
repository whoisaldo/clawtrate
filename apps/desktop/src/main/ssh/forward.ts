// The forward's life (docs/design/setup.md, section 8): one `ssh -N -L` per
// route, reported to the caller in every state, restarted by itself after a
// drop with a stated back-off, and usable again only after a repeated LOOK
// names the same gateway service on the same port. Each attempt listens on a
// fresh local socket of its own, so the local address of an "up" names that
// attempt and no other. Closing it is explicit and waits until its process is
// gone. The process, the LOOK, the socket picker and the clock are passed in,
// so the state machine is tested without `ssh`.

import { MAX_FORWARD_LISTENERS } from "@clawtrate/core";

import type { ChannelFacts, ProbeResult } from "./http-probe.ts";
import type { SshFailure, UnreachableCause } from "./ssh-output.ts";

/** Seconds before each try after a failure: 1, 2, 4, 8 and 16, then every 30. */
export const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000] as const;
export const BACKOFF_STEADY_MS = 30000;
/** After this long without the forward up, the state says so (`longOutage`). */
export const LONG_OUTAGE_MS = 120000;
/** A lost race for the local socket is retried at once, this many times in a row. */
export const PORT_RETRIES = 5;

export const backoffMs = (failures: number) =>
  failures < 1 ? 0 : (BACKOFF_MS[failures - 1] ?? BACKOFF_STEADY_MS);

export type ForwardCause =
  | { kind: "unreachable"; cause: UnreachableCause }
  | { kind: "sign-in-refused" }
  | { kind: "host-key-unknown" }
  | { kind: "dropped" }
  | { kind: "timed-out" }
  | { kind: "ssh-stopped"; exit: number | null }
  | { kind: "local-port-taken" }
  /** The LOOK found the gateway's service on that port, but stopped or not answering. */
  | { kind: "gateway-not-running" }
  /** The other computer's SSH server could not connect to the gateway's port. */
  | { kind: "gateway-not-answering" }
  /** The LOOK found no gateway service on that port, or answered in a way that couldn't be read. */
  | { kind: "cant-tell" }
  /** The other computer's SSH server refused to forward a connection to the gateway's port. */
  | { kind: "forwarding-refused" }
  /** `ssh` could not be started. */
  | { kind: "spawn-failed" };

export type ForwardState =
  | { phase: "starting"; attempt: number }
  /** `local` is the attempt's own local socket: a path in the host's private SSH folder. */
  | { phase: "verifying"; local: string; attempt: number }
  | { phase: "up"; local: string; restored: boolean }
  | {
      phase: "waiting";
      cause: ForwardCause;
      /** Failures since the forward was last up. */
      failures: number;
      retryInMs: number;
      /** True once the forward has not been up for `LONG_OUTAGE_MS`. */
      longOutage: boolean;
    }
  | { phase: "closed"; reason: "closed" | "key-changed" | "different-gateway" };

/** One running `ssh -N -L`. */
export type ForwardProcess = {
  pid: number | null;
  onListening(listener: () => void): void;
  /** Called once, when the process has ended, with what its error output showed. */
  onExit(listener: (failure: SshFailure) => void): void;
  /** What its output said about its forwarded connections so far. */
  channel(): ChannelFacts;
  /** Ends it by PID and resolves once it is gone. */
  end(): Promise<void>;
};

export type VerifyResult =
  | { kind: "same" }
  | { kind: "different" }
  | { kind: "not-running" }
  | { kind: "cant-tell" }
  | { kind: "failed"; failure: SshFailure };

export type ForwardDeps = {
  /** A fresh local socket for one attempt, which no other attempt has had. */
  pickLocal(): Promise<string>;
  start(local: string): ForwardProcess;
  /** Makes one connection through the forward: did the far end answer as an HTTP service? */
  probe(local: string, process: ForwardProcess, signal: AbortSignal): Promise<ProbeResult>;
  /** Runs the LOOK again and compares the gateway service on the gateway's port; `signal` ends it. */
  verify(signal: AbortSignal): Promise<VerifyResult>;
  now(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
};

function causeOf(failure: SshFailure): ForwardCause {
  switch (failure.kind) {
    case "unreachable":
      return { kind: "unreachable", cause: failure.cause };
    case "ssh-stopped":
      return { kind: "ssh-stopped", exit: failure.exit };
    case "host-key-changed":
      // Handled before this is called; never retried.
      return { kind: "ssh-stopped", exit: failure.exit };
    default:
      return { kind: failure.kind };
  }
}

export class ForwardSupervisor {
  private current: ForwardState = { phase: "starting", attempt: 1 };
  private readonly listeners = new Set<(state: ForwardState) => void>();
  private process: ForwardProcess | null = null;
  private timer: unknown = null;
  /** Each start gets a new generation; a late event of an older one is ignored. */
  private generation = 0;
  private failures = 0;
  private portRetries = 0;
  private downSince: number;
  private everUp = false;
  private closing: Promise<void> | null = null;
  /** Ends the probe and the LOOK in flight when the forward closes. */
  private readonly stop = new AbortController();
  /** Everything this forward started that may still be running: retiring processes, probes, LOOKs. */
  private work: Promise<unknown> = Promise.resolve();
  /** The ending of a process this forward retired; the next attempt starts only after it. */
  private retiring: Promise<void> = Promise.resolve();

  private readonly deps: ForwardDeps;

  constructor(deps: ForwardDeps) {
    this.deps = deps;
    this.downSince = deps.now();
  }

  get state(): ForwardState {
    return this.current;
  }

  /** At most `MAX_FORWARD_LISTENERS` at once. */
  onState(listener: (state: ForwardState) => void): () => void {
    if (this.listeners.size >= MAX_FORWARD_LISTENERS) throw new Error("Too many listeners.");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Starts the first attempt. */
  open(): void {
    if (this.generation !== 0) return;
    this.track(this.attempt());
  }

  /** Tries again now: "Retry now", waking from sleep, or a network change. */
  retryNow(): void {
    if (this.current.phase !== "waiting") return;
    this.clearTimer();
    this.track(this.attempt());
  }

  /** Stop the forward and join its local SSH process, HTTP probe and LOOK request. */
  close(): Promise<void> {
    return this.finish("closed");
  }

  private set(state: ForwardState): void {
    this.current = state;
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        // An observer's fault is its own: the others still hear, and the forward's life goes on.
      }
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
  }

  private closed(): boolean {
    return this.current.phase === "closed" || this.closing !== null;
  }

  private track(work: Promise<unknown>): void {
    this.work = Promise.allSettled([this.work, work]);
  }

  /** Join this supervisor's local work. Closing SSH does not confirm remote program exit. */
  private finish(reason: "closed" | "key-changed" | "different-gateway"): Promise<void> {
    if (this.closing) return this.closing;
    this.generation++;
    this.clearTimer();
    this.stop.abort();
    const process = this.process;
    this.process = null;
    if (process) this.track(process.end());
    this.closing = (async () => {
      // Work tracked while waiting is waited for too.
      let seen: Promise<unknown>;
      do {
        seen = this.work;
        await seen;
      } while (seen !== this.work);
      this.set({ phase: "closed", reason });
    })();
    return this.closing;
  }

  private async attempt(): Promise<void> {
    if (this.closed()) return;
    const generation = ++this.generation;
    this.set({ phase: "starting", attempt: this.failures + 1 });
    // A timed retry or "retry now" waits until the ssh it replaces has ended.
    await this.retiring;
    if (generation !== this.generation || this.closed()) return;
    let port: string;
    try {
      port = await this.deps.pickLocal();
    } catch {
      if (generation === this.generation) this.fail({ kind: "local-port-taken" });
      return;
    }
    if (generation !== this.generation || this.closed()) return;
    let process: ForwardProcess;
    try {
      process = this.deps.start(port);
    } catch {
      // A spawn that throws, or a full process table, is a state like any other failure.
      this.fail({ kind: "spawn-failed" });
      return;
    }
    this.process = process;
    // Ends this attempt's probe and LOOK when its process exits, as well as when the forward closes.
    const attemptStop = new AbortController();
    const signal = AbortSignal.any([this.stop.signal, attemptStop.signal]);
    process.onExit((failure) => {
      if (generation !== this.generation || this.closed()) return;
      // The attempt is over: what its probe or LOOK says later is about a process that is gone.
      this.generation++;
      attemptStop.abort();
      this.process = null;
      if (failure.kind === "host-key-changed") {
        void this.finish("key-changed");
      } else if (failure.kind === "local-port-taken" && this.portRetries < PORT_RETRIES) {
        this.portRetries++;
        this.track(this.attempt());
      } else {
        this.fail(causeOf(failure));
      }
    });
    process.onListening(() => {
      if (generation !== this.generation || this.closed()) return;
      this.portRetries = 0;
      this.set({ phase: "verifying", local: port, attempt: this.failures + 1 });
      // The listener is only the cue: up needs one answered connection through it, then the LOOK.
      const checked = this.deps
        .probe(port, process, signal)
        .catch((): ProbeResult => "no-answer")
        .then((answer) => {
          if (generation !== this.generation || this.closed()) return;
          if (answer === "forwarding-refused") return this.restart({ kind: "forwarding-refused" });
          // The SSH route is alive and the gateway's port is closed: one LOOK says whether the
          // service there is stopped, or its state is unknown.
          if (answer === "gateway-closed")
            return this.deps.verify(signal).then(
              (result) => this.portClosed(generation, result),
              () => this.portClosed(generation, { kind: "cant-tell" }),
            );
          if (answer !== "http") return this.restart({ kind: "cant-tell" });
          return this.deps.verify(signal).then(
            (result) => this.verified(generation, port, result),
            () => this.verified(generation, port, { kind: "cant-tell" }),
          );
        });
      this.track(checked);
    });
  }

  private verified(generation: number, port: string, result: VerifyResult): void {
    if (generation !== this.generation || this.closed()) return;
    switch (result.kind) {
      case "same": {
        const restored = this.everUp;
        this.everUp = true;
        this.failures = 0;
        this.set({ phase: "up", local: port, restored });
        return;
      }
      case "different":
        void this.finish("different-gateway");
        return;
      case "failed":
        if (result.failure.kind === "host-key-changed") {
          void this.finish("key-changed");
          return;
        }
        this.restart(causeOf(result.failure));
        return;
      case "not-running":
        this.restart({ kind: "gateway-not-running" });
        return;
      case "cant-tell":
        this.restart({ kind: "cant-tell" });
        return;
    }
  }

  /** The gateway's port closed through a live SSH route, and what one LOOK said of its service. */
  private portClosed(generation: number, result: VerifyResult): void {
    if (generation !== this.generation || this.closed()) return;
    if (result.kind === "not-running") return this.restart({ kind: "gateway-not-running" });
    if (result.kind === "different") {
      void this.finish("different-gateway");
      return;
    }
    if (result.kind === "failed" && result.failure.kind === "host-key-changed") {
      void this.finish("key-changed");
      return;
    }
    this.restart({ kind: "gateway-not-answering" });
  }

  /** The forward is not usable: end its process, then wait and try again. */
  private restart(cause: ForwardCause): void {
    const process = this.process;
    this.process = null;
    this.generation++;
    if (process) {
      const ended = process.end();
      // Only the order is kept: each barrier resolves to nothing, holding no earlier results.
      this.retiring = Promise.allSettled([this.retiring, ended]).then(() => {});
      this.track(ended);
    }
    this.fail(cause);
  }

  private fail(cause: ForwardCause): void {
    if (this.closed()) return;
    if (this.current.phase === "up") this.downSince = this.deps.now();
    this.failures++;
    const retryInMs = backoffMs(this.failures);
    this.clearTimer();
    const generation = this.generation;
    this.set({
      phase: "waiting",
      cause,
      failures: this.failures,
      retryInMs,
      longOutage: this.deps.now() - this.downSince >= LONG_OUTAGE_MS,
    });
    // An observer may have retried, or closed the forward, while it heard "waiting".
    if (generation !== this.generation || this.closed()) return;
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      this.track(this.attempt());
    }, retryInMs);
  }
}
