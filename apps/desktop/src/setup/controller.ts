// Setting up on this computer, as the host runs it (docs/design/setup.md
// §2, §4, §7): the look, the host's own confirmation before a pairing, the
// one-time code it makes and redeems itself, and what the interface sees.
// The interface can ask for a look, for Back and for Connect; it can't name
// a program, a port or a profile, and Connect does nothing until the host's
// dialog says yes.

import {
  APPROVAL_IDENTITY_CHANGED,
  APPROVAL_IDENTITY_UNREAD,
  APPROVAL_UNCONFIRMED,
  initialSetupState,
  PAIRING_STOPPED,
  SETUP_ENDPOINT_CHANGED,
  SETUP_PAIRING_GONE,
  type ClawtrateClient,
  type ApprovalPlace,
  type ClawtrateState,
  type ReadBack,
  type ReadBackRequest,
  type SetupFailure,
  type SetupHost,
  type SetupState,
} from "@clawtrate/core";
import { boundedFileIdentity, LIMITS, lookHere, type FoundGateway } from "./look.ts";
import { parseAuthMode, parseSetupCode, parseStatus } from "./parse.ts";
import type { ProgramResult } from "./programs.ts";
import { readBackHere } from "./read-back.ts";
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
  /** Where the setup slice goes: the client's, unless a router shares it (`host.ts`). */
  publish?: (next: SetupState) => void;
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

/**
 * Where the look found the gateway, kept with the connection once it is saved
 * (§9): its profile, when it is one of the two Clawtrate names in commands.
 */
function hereOf(found: FoundGateway): { here?: { profile: "default" | "clawtrate" } } {
  const name = found.profile.name;
  return name === "default" || name === "clawtrate" ? { here: { profile: name } } : {};
}

export class SetupController implements SetupHost {
  private readonly options: SetupControllerOptions;
  private state: SetupState = initialSetupState;
  /** Counts looks and connects; anything finishing for an older one is dropped. */
  private attempt = 0;
  private found: FoundGateway | null = null;
  /** The connection this setup attempt opened, by attempt and address: the only one Back closes. */
  private owned: { attempt: number; url: string } | null = null;
  private slowTimer: ReturnType<typeof setTimeout> | null = null;
  private watching: (() => void) | null = null;
  private readonly now: () => number;

  constructor(options: SetupControllerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    (options.publish ?? ((next) => options.client.setSetup(next)))(this.state);
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
    if (this.options.publish) this.options.publish(next);
    else this.options.client.setSetup(next);
  }

  /** Where the owner approves a request for the gateway at `url` (§9), when this setup found it. */
  placeFor(url: string): ApprovalPlace | null {
    const found = this.found;
    if (!found || found.url !== url) return null;
    const profile = found.profile.name;
    return profile === "default" || profile === "clawtrate"
      ? { route: "this-computer", profile }
      : null;
  }

  /**
   * The read-back after an approval (§9) for a gateway found on this
   * computer at `url`: for the profile kept with the connection (after a
   * relaunch too), or the one this setup found. A fresh look for exactly that
   * profile must find it running a supported version at exactly that address,
   * with one listener; then the identity is read there and, only when it is
   * `expected`, the device list. Just before the list and again after it, the
   * endpoint's listener (its PID and start time, from the status's own port
   * report), the running version and the program file must be the ones the
   * fresh look proved, or nothing read counts. Null for an address
   * this computer's look has no profile for. Reads only.
   */
  async readBack(url: string, request: ReadBackRequest): Promise<ReadBack | null> {
    const name =
      request.here?.profile ?? (this.found?.url === url ? this.found.profile.name : null);
    if (!name) return null;
    const unread = { ok: false, step: "identity", exitCode: null } as const;
    let opened: Opened | SetupRefusedError;
    try {
      opened = await this.options.open();
    } catch {
      return unread;
    }
    if (opened instanceof SetupRefusedError) return unread;
    try {
      const profiles = opened.world.profiles.filter((profile) => profile.name === name);
      if (profiles.length !== 1) return unread;
      // The endpoint and its version, established again for that profile alone.
      const report = await lookHere({ ...opened.world, profiles, deep: false }, opened.run, {
        identify: opened.identify,
        ...(opened.assertActive ? { checkActive: opened.assertActive } : {}),
      });
      const found = report?.found;
      if (!found || report.look.outcome !== "running" || found.url !== url) return unread;
      const read = await readBackHere({
        run: opened.run,
        program: found.program,
        profileArgs: found.profile.args,
        env: { ...opened.world.env, PATH: programPath(found.program), ...found.profile.env },
        cwd: opened.world.cwd,
        url: found.url,
        expected: request.expected,
        // Before the list and after it: the endpoint's listener by PID and start time, the
        // running version, the endpoint and the program file, as the fresh look proved them.
        listener: () => this.unchanged(opened, found),
      });
      // The proof held through both reads: the same listener, and the same program file.
      const program = opened.world.installed
        ? "stand-in"
        : await boundedFileIdentity(found.program);
      if (!this.sameListener(opened, found) || program !== found.programIdentity) return unread;
      return read;
    } catch {
      return unread;
    }
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

  /**
   * Review or Look again after an approval for a gateway set up here (§9):
   * the look for the profile the connection was saved with alone, never
   * another; a gateway of that profile found anywhere but the saved address
   * is "This changed since you looked." Without a saved profile, the look.
   */
  async reviewOf(saved: { profile: string; url: string } | null): Promise<void> {
    await this.look(saved ?? undefined);
  }

  /** The selected gateway's saved place on this computer, as the client keeps it. */
  savedHere(): { profile: string; url: string } | null {
    return this.options.client.here;
  }

  async look(saved?: { profile: string; url: string }): Promise<void> {
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
    const world = saved
      ? { ...opened.world, profiles: opened.world.profiles.filter((p) => p.name === saved.profile) }
      : opened.world;
    const report = await lookHere(world, opened.run, {
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
    // The saved profile's gateway, at the saved address, or this isn't the gateway reviewed.
    if (saved && report.found && report.found.url !== saved.url) {
      this.fail({ kind: "changed" });
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
   * the client's queue. Another gateway selected since is never touched.
   */
  private async closeOwned(): Promise<void> {
    const owned = this.owned;
    this.owned = null;
    // Refused when another gateway is selected by then: that one stays as it is.
    if (owned) await this.options.client.disconnect(owned.url).catch(() => {});
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
      await this.connectOpened(attempt, opened, found, expired);
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
    // The person agreed to reuse a saved pairing, not to a new one: gone, the card asks again.
    if (!paired && this.state.look?.access === "paired") return this.pairingGone();
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
    if (paired) {
      // A saved pairing for this address: reused, asking for read alone (§7).
      this.publish({ ...this.state, step: 1 });
      this.owned = { attempt, url: found.url };
      this.watch(attempt, found.url, found.port);
      await client.connectForSetup(found.url, { check: listening, ...hereOf(found) });
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
    this.owned = { attempt, url: found.url };
    this.watch(attempt, found.url, found.port);
    // Handed to the client and dropped here: the code lives in the client's memory until its hello.
    await client.connectWithSetupCode(code, { check: listening, ...hereOf(found) });
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
  private watch(attempt: number, url: string, port: number): void {
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
        if (discovery.status === "ready") {
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
        this.fail({
          kind:
            code === "SETUP_GRANT_REFUSED"
              ? "grant"
              : code === APPROVAL_UNCONFIRMED
                ? "approval-unconfirmed"
                : code === APPROVAL_IDENTITY_CHANGED
                  ? "approval-identity"
                  : code === APPROVAL_IDENTITY_UNREAD
                    ? "approval-identity-unread"
                    : code === PAIRING_STOPPED
                      ? "stopped"
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

  private stopWatching(): void {
    this.watching?.();
    this.watching = null;
  }

  private clearSlow(): void {
    if (this.slowTimer) clearTimeout(this.slowTimer);
    this.slowTimer = null;
  }
}
