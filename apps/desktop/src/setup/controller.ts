// Setting up on this computer, as the host runs it (docs/design/setup.md
// §2, §4, §7): the look, the host's own confirmation before a pairing, the
// one-time code it makes and redeems itself, and what the interface sees.
// The interface can ask for a look, for Back and for Connect; it can't name
// a program, a port or a profile, and Connect does nothing until the host's
// dialog says yes.

import {
  GatewayChangedError,
  initialSetupState,
  SETUP_ENDPOINT_CHANGED,
  SETUP_PAIRING_APPEARED,
  SETUP_PAIRING_GONE,
  type ClawtrateClient,
  type ClawtrateState,
  type SetupFailure,
  type SetupHost,
  type SetupState,
} from "@clawtrate/core";
import { boundedFileIdentity, LIMITS, lookHere, type FoundGateway } from "./look.ts";
import { parseAuthMode, parseSetupCode, parseStatus } from "./parse.ts";
import type { ProgramResult } from "./programs.ts";
import type { Opened } from "./sandbox.ts";
import { guardPort, programPath, SetupRefusedError } from "./world.ts";

/** A prepared operation expires after this long and can't be repeated (§2). */
export const OPERATION_LIFETIME_MS = 2 * 60_000;
/** After this long, the look says it is still looking (§4). */
export const SLOW_LOOK_MS = 8_000;
const QR_LIMIT = { timeoutMs: 20_000, maxBytes: 16 * 1024 };

/** A program that ran to its end, in time and within its limit, and exited 0. */
const succeeded = (result: ProgramResult) =>
  result.exitCode === 0 && !result.timedOut && !result.tooLarge && !result.failed;

/** The connection a setup attempt opened, by its address. */
/** Setup's connection: its attempt, its address and the client's selection that made it. */
type Owned = { attempt: number; url: string; selection: number };

/** What the host's own dialog shows: its words, nothing the page wrote. */
export type Confirmation = { message: string; detail: string; confirm: string };

export type SetupControllerOptions = {
  client: ClawtrateClient;
  /**
   * The world the look and Connect run against and what answers their
   * commands, opened again for every look and every Connect: the real
   * computer and its programs, a sandbox and its stand-in (`sandbox.ts`), or
   * why there is none.
   */
  open: () => Promise<Opened | SetupRefusedError>;
  /** Ends every program the look started, by PID. */
  stopPrograms: () => void;
  /** The host's native dialog, or null where the host has none (the web preview). */
  confirm: ((confirmation: Confirmation) => Promise<boolean>) | null;
  /** The host's log: fixed lines only, never a program's output or a credential. */
  log?: (line: string) => void;
  now?: () => number;
};

/**
 * The dialog's words (§2, "The host's confirmation"). Connect asks for read
 * access, always: a device with a saved pairing for this address reconnects
 * asking for read alone.
 */
export function pairConfirmation(
  found: FoundGateway,
  access: "new" | "paired" = "new",
): Confirmation {
  const where = `the ${found.profile.name} gateway on this computer`;
  if (access === "paired")
    return {
      message: `Connect this device read-only to ${where}?`,
      detail: "This device has a saved pairing for this address.",
      confirm: "Connect read-only",
    };
  return {
    message: `Pair this device read-only with ${where}?`,
    detail: "Clawtrate asks for read access. The gateway may ask its owner to approve this device.",
    confirm: "Pair",
  };
}

export class SetupController implements SetupHost {
  private readonly options: SetupControllerOptions;
  private state: SetupState = initialSetupState;
  /** Counts looks and connects; anything finishing for an older one is dropped. */
  private attempt = 0;
  private found: FoundGateway | null = null;
  /** The connection this setup attempt opened, by attempt and address: the only one Back closes. */
  private owned: Owned | null = null;
  /** Closing `owned`, while that is under way: one at a time, for that owner only. */
  private cleaning: { owned: Owned; done: Promise<boolean> } | null = null;
  private slowTimer: ReturnType<typeof setTimeout> | null = null;
  private watching: (() => void) | null = null;
  private readonly now: () => number;

  constructor(options: SetupControllerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    options.client.setSetup(this.state);
    // Back to the first screen once a gateway set up here is let go.
    options.client.store.subscribe((state) => {
      if (this.state.phase === "done" && state.connection.status === "idle")
        this.publish(initialSetupState);
    });
  }

  get current(): SetupState {
    return this.state;
  }

  private publish(next: SetupState): void {
    this.state = next;
    this.options.client.setSetup(next);
  }

  private log(line: string): void {
    this.options.log?.(`[setup] ${line}`);
  }

  private fail(failure: Partial<SetupFailure> & Pick<SetupFailure, "kind">): void {
    this.publish({
      ...this.state,
      phase: "failed",
      failure: { exitCode: null, port: null, reason: null, ...failure },
    });
  }

  /** The world and its runner; throws `SetupRefusedError`. */
  private async open(): Promise<Opened> {
    let opened: Opened | SetupRefusedError;
    try {
      opened = await this.options.open();
    } catch {
      opened = new SetupRefusedError("file");
    }
    if (opened instanceof SetupRefusedError) throw opened;
    return opened;
  }

  /** Loud, in fixed words: the log names the refusal, never an error's own text. */
  private refused(error: unknown): void {
    const refusal = error instanceof SetupRefusedError ? error : new SetupRefusedError("file");
    this.log(refusal.message);
    this.publish({
      ...initialSetupState,
      look: this.state.look,
      phase: "failed",
      failure: { kind: "refused", exitCode: null, port: null, reason: refusal.reason },
    });
  }

  async look(): Promise<void> {
    this.stopWatching();
    // Another look: the earlier one's programs end before this one asks anything.
    this.options.stopPrograms();
    const attempt = (this.attempt += 1);
    this.found = null;
    this.clearSlow();
    let opened: Opened;
    try {
      opened = await this.open();
    } catch (error) {
      // Loud: in the log, and in the interface as its own failure.
      if (attempt === this.attempt) this.refused(error);
      return;
    }
    if (attempt !== this.attempt) return;
    this.publish({ ...initialSetupState, phase: "looking" });
    this.slowTimer = setTimeout(() => {
      if (attempt === this.attempt && this.state.phase === "looking")
        this.publish({ ...this.state, slow: true });
    }, SLOW_LOOK_MS);
    let refusal: SetupRefusedError | null = null;
    const report = await lookHere(opened.world, opened.run, {
      identify: opened.identify,
      ...(opened.assertActive ? { checkActive: opened.assertActive } : {}),
      onStep: (step) => {
        if (attempt === this.attempt && this.state.phase === "looking")
          this.publish({ ...this.state, step });
      },
      cancelled: () => attempt !== this.attempt,
    }).catch((error: unknown) => {
      // A sandbox that stopped passing mid-look is a refusal, not an answer of the wrong shape.
      if (error instanceof SetupRefusedError) refusal = error;
      return null;
    });
    if (attempt !== this.attempt) return;
    if (refusal) {
      this.clearSlow();
      this.refused(refusal);
      return;
    }
    this.clearSlow();
    if (!report) {
      this.publish({
        ...initialSetupState,
        phase: "found",
        look: {
          outcome: "cant-tell",
          reason: "shape",
          version: null,
          profile: null,
          listens: null,
          service: null,
          port: null,
          authMode: null,
          access: null,
          others: [],
        },
      });
      return;
    }
    this.found = report.found;
    // What this device can already do on the gateway found, said on its card and in the dialog.
    const access = report.found
      ? await this.options.client.deviceAccess(report.found.url).catch(() => "new" as const)
      : null;
    if (attempt !== this.attempt) return;
    try {
      opened.assertActive?.();
    } catch (error) {
      this.found = null;
      this.refused(error);
      return;
    }
    this.publish({
      ...initialSetupState,
      phase: "found",
      look: access ? { ...report.look, access } : report.look,
    });
  }

  cancel(): void {
    const phase = this.state.phase;
    this.attempt += 1;
    this.clearSlow();
    this.options.stopPrograms();
    if (phase === "looking") {
      this.publish(initialSetupState);
      return;
    }
    if (phase === "confirming") {
      // The dialog's answer, when it comes, is for an attempt that is over.
      this.publish({ ...this.state, phase: "found" });
      return;
    }
    if (phase === "connecting" || phase === "failed") {
      this.stopWatching();
      void this.closeOwned();
      this.publish(
        this.state.look
          ? { ...initialSetupState, phase: "found", look: this.state.look }
          : initialSetupState,
      );
    }
  }

  reset(): void {
    this.attempt += 1;
    this.clearSlow();
    this.stopWatching();
    this.options.stopPrograms();
    this.found = null;
    void this.closeOwned();
    this.publish(initialSetupState);
  }

  /**
   * Closes the connection this setup opened, connected or not, while its bots
   * load too, and one still waiting to open: the disconnect waits behind it in
   * the client's queue. Another gateway selected since is never touched. The
   * connection stays setup's own until the client has forgotten it, or says
   * another gateway is selected: a cleanup that failed (its settings couldn't
   * be deleted, so it stays connected) says so, and Back or Connect tries it
   * again. A cleanup under way is shared, and its answer changes the screen
   * only for the owner and the attempt it was asked for. True once closed.
   */
  private async closeOwned(): Promise<boolean> {
    const owned = this.owned;
    if (!owned) return true;
    const attempt = this.attempt;
    let cleaning = this.cleaning;
    if (cleaning?.owned !== owned) {
      const done = this.options.client.disconnect(owned.url, owned.selection).then(
        () => true,
        // Refused because another gateway is selected by then: that one stays as it is.
        (error: unknown) => error instanceof GatewayChangedError,
      );
      const entry = { owned, done };
      cleaning = this.cleaning = entry;
      void done.then(() => {
        if (this.cleaning === entry) this.cleaning = null;
      });
    }
    if (await cleaning.done) {
      if (this.owned === owned) this.owned = null;
      return true;
    }
    if (this.owned === owned && attempt === this.attempt) this.fail({ kind: "cleanup" });
    return false;
  }

  /**
   * Before setup asks anything, ends an earlier connection that didn't finish:
   * Connect replaces the selected gateway, as Advanced's Connect does, and the
   * later choice is the one kept. A connected one is replaced when setup's own
   * connection opens.
   */
  private async letGo(): Promise<void> {
    const status = this.options.client.state.connection.status;
    if (status !== "idle" && status !== "connected") await this.options.client.disconnect();
  }

  async connect(): Promise<void> {
    const found = this.found;
    const phase = this.state.phase;
    if (
      (phase !== "found" && phase !== "failed") ||
      !found ||
      this.state.look?.outcome !== "running"
    ) {
      throw new Error("There is nothing to connect to. Look again.");
    }
    // Setup's own earlier connection, one Back couldn't close included, is closed first.
    if (this.owned && !(await this.closeOwned())) return;
    if (this.found !== found) return;
    const attempt = (this.attempt += 1);
    const confirm = this.options.confirm;
    if (!confirm) {
      this.fail({ kind: "no-dialog" });
      return;
    }
    // Prepared from the host's own state; the page gave nothing but the request.
    const prepared = { found, at: this.now(), used: false };
    const expired = () => this.now() - prepared.at > OPERATION_LIFETIME_MS;
    this.publish({ ...this.state, phase: "confirming", failure: null });
    const access = this.state.look?.access ?? "new";
    let yes: boolean;
    try {
      yes = await confirm(pairConfirmation(found, access));
    } catch {
      yes = false;
    }
    if (attempt !== this.attempt) return;
    if (!yes) {
      // Nothing was minted or registered.
      this.publish({ ...this.state, phase: "found" });
      return;
    }
    if (prepared.used || expired()) {
      this.fail({ kind: "changed" });
      return;
    }
    prepared.used = true;
    let opened: Opened;
    try {
      opened = await this.open();
      if (attempt !== this.attempt) return;
      // A sandbox pairs only in its pairing scenario, with the host's own synthetic gateway.
      if (!opened.world.pairs) throw new SetupRefusedError("pairing");
      guardPort(found.port, opened.world);
    } catch (error) {
      if (attempt === this.attempt) this.refused(error);
      return;
    }
    this.publish({ ...this.state, phase: "connecting", step: 0, failure: null });
    try {
      await this.connectOpened(attempt, opened, found, expired, access);
    } catch (error) {
      if (attempt !== this.attempt) return;
      this.stopWatching();
      void this.closeOwned();
      // A sandbox that stopped passing: refused in fixed words, and setup's own connection closed.
      if (error instanceof SetupRefusedError) this.refused(error);
      // Anything else that failed here (a saved record that can't be read): a failure to try again from.
      else this.fail({ kind: "other" });
    }
  }

  /** Connect after the dialog, on an opened world: throws `SetupRefusedError`. */
  private async connectOpened(
    attempt: number,
    opened: Opened,
    found: FoundGateway,
    expired: () => boolean,
    /** What the card and the dialog offered: reuse this device's saved pairing, or a new one. */
    access: "new" | "paired",
  ): Promise<void> {
    const client = this.options.client;
    const changedNow = () => {
      if (attempt === this.attempt) this.fail({ kind: "changed" });
    };
    // After the dialog: the same listener, before anything else.
    if (!this.sameListener(opened, found)) return changedNow();
    await this.letGo();
    // A setup cancelled while the earlier connection was let go starts nothing more.
    if (attempt !== this.attempt) return;
    if (!this.sameListener(opened, found)) return changedNow();
    const paired = await client.hasDeviceToken(found.url);
    if (attempt !== this.attempt) return;
    if (!this.sameListener(opened, found)) return changedNow();
    // The person agreed to what the dialog named: reusing this device's saved pairing, or a new
    // pairing. A pairing gone or appeared since, and the card asks again.
    if (paired !== (access === "paired"))
      return paired ? this.pairingAppeared() : this.pairingGone();
    // The facts are read again after every wait that can be long, and the consent's two
    // minutes hold on every branch: anything other than what the dialog named, and nothing runs.
    const changed = async () => !(await this.unchanged(opened, found)) || expired();
    if (await changed()) {
      if (attempt === this.attempt) this.fail({ kind: "changed" });
      return;
    }
    if (attempt !== this.attempt) return;
    // Every socket the client opens for this, retries included, finds the same listener first;
    // a sandbox that stopped passing then is refused, and the client opens nothing.
    const listening = () => {
      // An attempt that is over opens nothing, even a connection still waiting in the client's queue.
      if (attempt !== this.attempt) return false;
      try {
        return this.sameListener(opened, found);
      } catch (error) {
        if (attempt === this.attempt) {
          this.stopWatching();
          this.refused(error);
        }
        return false;
      }
    };
    // Once each socket is up and again just before its credential goes, the endpoint's
    // listener is read again: the port's listener by PID and start time, the endpoint, the
    // program file, as the look found them. Any difference sends nothing (docs/decisions.md).
    const verify = async () => {
      if (attempt !== this.attempt) return false;
      try {
        return (await this.unchanged(opened, found)) && attempt === this.attempt;
      } catch (error) {
        if (attempt === this.attempt) {
          this.stopWatching();
          this.refused(error);
        }
        return false;
      }
    };
    if (paired) {
      // A saved pairing for this address: reused, asking for read alone (§7).
      this.publish({ ...this.state, step: 1 });
      // The selection this connect makes: its cleanup and its readiness are that one's only.
      const selection = client.nextSelection();
      this.owned = { attempt, url: found.url, selection };
      this.watch(attempt, found.url, found.port, selection);
      await client.connectForSetup(found.url, {
        check: listening,
        verify,
        consent: () => !expired(),
      });
      return;
    }
    const made = await opened.run({
      program: found.program,
      args: [...found.profile.args, "qr", "--json", "--voice-node", "--url", found.url],
      env: { ...opened.world.env, PATH: programPath(found.program), ...found.profile.env },
      cwd: opened.world.cwd,
      ...QR_LIMIT,
    });
    if (attempt !== this.attempt) return;
    const code = succeeded(made) ? parseSetupCode(made.stdout, found.url, this.now()) : null;
    if (!code) {
      this.fail({ kind: "code-failed", exitCode: made.exitCode });
      return;
    }
    // The listener is checked again after the code is made and before it is sent.
    if (await changed()) {
      if (attempt === this.attempt) this.fail({ kind: "changed" });
      return;
    }
    if (attempt !== this.attempt) return;
    this.publish({ ...this.state, step: 1 });
    const selection = client.nextSelection();
    this.owned = { attempt, url: found.url, selection };
    this.watch(attempt, found.url, found.port, selection);
    // Handed to the client and dropped here: the code lives in the client's memory until its hello.
    await client.connectWithSetupCode(code, {
      check: listening,
      verify,
      consent: () => !expired(),
    });
  }

  /**
   * The same process, by PID and start time, still listens where the look
   * found the gateway; in a sandbox, the description still passes (it throws
   * the refusal otherwise) and the host's own synthetic gateway still owns
   * the listener at exactly that endpoint.
   */
  private sameListener(opened: Opened, found: FoundGateway): boolean {
    opened.assertActive?.();
    if (
      opened.world.kind === "sandbox" &&
      (found.listener.pid !== process.pid ||
        found.url !== `ws://127.0.0.1:${found.port}` ||
        !opened.world.portAllowed(found.port) ||
        !opened.ownsListener?.(found.port))
    )
      return false;
    const now = opened.identify(found.listener.pid);
    return now.state === "alive" && now.identity === found.listener.started;
  }

  /**
   * Whether the profile's gateway still is what the dialog named: the same
   * program file, the same endpoint, config files, service and version, the
   * same listener by PID and start time, and token sign-in, each command
   * having finished in time and within its limit.
   */
  private async unchanged(opened: Opened, found: FoundGateway): Promise<boolean> {
    const { world, run } = opened;
    const identity = world.installed ? "stand-in" : await boundedFileIdentity(found.program);
    if (identity !== found.programIdentity) return false;
    const env = { ...world.env, PATH: programPath(found.program), ...found.profile.env };
    const [statusRun, authRun] = await Promise.all([
      run({
        program: found.program,
        args: [...found.profile.args, "gateway", "status", "--json"],
        env,
        cwd: world.cwd,
        ...LIMITS.status,
      }),
      run({
        program: found.program,
        args: [...found.profile.args, "config", "get", "gateway.auth.mode", "--json"],
        env,
        cwd: world.cwd,
        ...LIMITS.auth,
      }),
    ]);
    if (!succeeded(statusRun) || !succeeded(authRun)) return false;
    const status = parseStatus(statusRun.stdout);
    return (
      status !== null &&
      status.configExists &&
      status.url === found.url &&
      status.endpointConfirmed &&
      status.configPath === found.configPath &&
      status.daemonConfigPath === found.daemonConfigPath &&
      status.serviceKey === found.serviceKey &&
      status.answered?.text === found.version &&
      status.listenerPid === found.listener.pid &&
      this.sameListener(opened, found) &&
      parseAuthMode(authRun.stdout) === "token"
    );
  }

  /** Follows the connection Connect started, until it is in or has failed. */
  /** Follows this attempt's connection to `url` only: another route's state says nothing about it. */
  private watch(attempt: number, url: string, port: number, selection: number): void {
    this.stopWatching();
    let seen = false;
    const check = (state: ClawtrateState) => {
      if (attempt !== this.attempt) return;
      const { connection, discovery } = state;
      // Let go from elsewhere ("Use another gateway" on the pairing screen): this attempt is over.
      if (seen && connection.status === "idle" && connection.gatewayUrl === null) {
        this.stopWatching();
        this.attempt += 1;
        this.owned = null;
        this.publish(
          this.state.look
            ? { ...initialSetupState, phase: "found", look: this.state.look }
            : initialSetupState,
        );
        return;
      }
      if (connection.gatewayUrl !== url) return;
      seen = true;
      if (connection.status === "connected") {
        // Ready only for this selection's own read: one left from an earlier selection of the
        // same address isn't this connection's.
        if (discovery.status === "ready" && this.options.client.readyFor(selection)) {
          this.stopWatching();
          this.publish({ ...this.state, phase: "done", step: 2 });
        } else if (discovery.status === "error") {
          // Connected, but the bots weren't read: that is what the screen says. A retry
          // that reads them still opens the app, so the watch goes on.
          if (this.state.failure?.kind !== "bots") this.fail({ kind: "bots", port });
        } else if (this.state.step !== 2) this.publish({ ...this.state, step: 2 });
        return;
      }
      if (connection.status === "error") {
        this.stopWatching();
        const code = connection.error?.code;
        // The saved pairing went before the socket asked: back to the card, for a new consent.
        if (code === SETUP_PAIRING_GONE) return this.pairingGone();
        // One appeared before the code went: back to the card, for consent to reuse it.
        if (code === SETUP_PAIRING_APPEARED) return this.pairingAppeared();
        this.fail({
          kind:
            code === "SETUP_GRANT_REFUSED"
              ? "grant"
              : code === "AUTH_BOOTSTRAP_TOKEN_INVALID"
                ? "code-refused"
                : code === "UNREACHABLE"
                  ? "unreachable"
                  : code === SETUP_ENDPOINT_CHANGED
                    ? "changed"
                    : "other",
          port,
        });
      }
    };
    this.watching = this.options.client.store.subscribe(check);
  }

  /** Back to the card for a new consent: this device's saved pairing is gone. */
  private pairingGone(): void {
    this.publish({
      ...this.state,
      phase: "found",
      failure: null,
      look: this.state.look && { ...this.state.look, access: "new" },
    });
  }

  /** Back to the card for consent to reuse it: this device has a saved pairing for the address now. */
  private pairingAppeared(): void {
    this.publish({
      ...this.state,
      phase: "found",
      failure: null,
      look: this.state.look && { ...this.state.look, access: "paired" },
    });
  }

  private stopWatching(): void {
    this.watching?.();
    this.watching = null;
  }

  private clearSlow(): void {
    if (this.slowTimer) clearTimeout(this.slowTimer);
    this.slowTimer = null;
  }
}
