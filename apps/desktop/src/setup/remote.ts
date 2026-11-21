// Another computer over SSH, as the host runs it (docs/design/setup.md §5 to
// §8): the field's refusals by name, the account's confirmation, first
// contact, a key already trusted and a changed key, the LOOK and its found
// card, Connect with a one-time code made there by the CODE script, the
// forward connected into the client, the route's life in the status strip,
// Start when the gateway is proven stopped, and Remove.
//
// The interface asks; the host decides. Every step that runs anything on the
// other computer, pins or replaces a key, registers this device, starts a
// gateway or forgets a route waits for the host's own dialog. Pair and Start
// keep what the dialog named (the account, SSH port, pinned key, program and
// service) as one snapshot that expires and is used once, and read it all
// again after the answer: anything that differs ends the step. The page never
// names a program, a port, a profile, a key or a route: it sends what was
// typed, and the host resolves everything else from its own state.
//
// The client reaches the gateway only through a channel: one forward attempt's
// own Unix socket, which only this host's forward listens on. Each channel has
// an address of its own, which resolves nowhere (`*.ssh.invalid`) and is
// allowed only while that attempt is up; the client's socket is made on the
// channel's socket by the host itself (`socketFor`). After every hello the
// client reads the gateway's identity before anything else is asked or
// allowed (`connectRoute`'s `identity`), and the strip says the route is back
// only after that.

import { randomBytes } from "node:crypto";

import {
  APPROVAL_IDENTITY_CHANGED,
  APPROVAL_IDENTITY_UNREAD,
  APPROVAL_UNCONFIRMED,
  initialSetupState,
  PAIRING_STOPPED,
  MAX_SSH_CHANNELS,
  MAX_SSH_REMEMBERED_IDS,
  ROUTE_IDENTITY_CHANGED,
  ROUTE_IDENTITY_UNREAD,
  SETUP_ENDPOINT_CHANGED,
  SETUP_PAIRING_GONE,
  type ApprovalPlace,
  type ClawtrateClient,
  type ReadBack,
  type ReadBackRequest,
  type ClawtrateState,
  type RouteStatus,
  type SetupFailure,
  type SetupState,
  type SshFailureKind,
  type SshSetup,
  type UnreachableWords,
  type WebSocketLike,
} from "@clawtrate/core";

import type { ForwardState, ForwardSupervisor } from "../main/ssh/forward.ts";
import {
  sameService,
  serviceOnPort,
  type GatewayService,
  type GatewayStatus,
  type LookFacts,
} from "../main/ssh/look.ts";
import { routeWebSocket } from "../main/ssh/socket.ts";
import type { SshFailure } from "../main/ssh/ssh-output.ts";
import type { HostKeyCheck, Route, SshTransport } from "../main/ssh/transport.ts";
import { OPERATION_LIFETIME_MS, type Confirmation } from "./controller.ts";
import { parseSetupCode } from "./parse.ts";
import { sshRouteKey, type RouteStore, type SshRouteRecord } from "./routes.ts";
import { parseDeviceList, parseIdentity } from "./read-back.ts";
import { sshLook, type SshLook } from "./ssh-look.ts";

export { sshRouteKey } from "./routes.ts";

/** The host's dialog, with a checkbox the person must tick for some operations (§2). */
export type HostQuestion = Confirmation & { checkbox?: string };
export type HostAnswer = { confirmed: boolean; checked: boolean };

/** Why this host offers no SSH route: its app files aren't proven private, or its `ssh` can't be used. */
export type TransportRefusal = { refused: "app-files-unsafe" | "not-supported" };

export type RemoteSetupOptions = {
  client: ClawtrateClient;
  /**
   * The SSH transport, made once and only after the app-data privacy check
   * passed (`private-dir.ts`), or why there is none.
   */
  transport: () => SshTransport | TransportRefusal;
  routes: RouteStore;
  /** The host's native dialog, or null where it has none. */
  ask: ((question: HostQuestion) => Promise<HostAnswer>) | null;
  /** The setup slice's main part, and its route part (`SetupSlice`). */
  publish: (next: SetupState) => void;
  publishRoute: (route: RouteStatus | null) => void;
  log?: (line: string) => void;
  now?: () => number;
  /** How long the strip says "connected again" (§8). */
  restoredMs?: number;
  /** How long Connect waits for the forward to come up. */
  forwardWaitMs?: number;
};

/**
 * How far the other computer's clock may be ahead of this one's when a code
 * made there is checked: a code lives ten minutes from when it was made there.
 */
export const CODE_CLOCK_SKEW_MS = 2 * 60_000;
/** After Start, the LOOK is repeated this many times, this far apart, for the gateway to come up. */
const START_LOOKS = 10;
const START_LOOK_GAP_MS = 2_000;
/** Times the Replace dialog is asked again while its box is unticked. */
const REPLACE_ASKS = 3;

const newRouteId = () => `r${randomBytes(6).toString("hex")}`;
/** Destinations whose route id this run remembers. */
const MAX_REMEMBERED_IDS = MAX_SSH_REMEMBERED_IDS;
/** Channels kept: the newest, each one forward attempt's socket. */
const MAX_CHANNELS = MAX_SSH_CHANNELS;

/** A channel's address: resolves nowhere, so only this host's own socket ever carries it. */
const CHANNEL_URL = /^ws:\/\/c[0-9a-f]{16}\.ssh\.invalid$/;
export const isChannelUrl = (url: string) => CHANNEL_URL.test(url);

const emptyThere = (destination: string): SshSetup => ({
  destination,
  account: null,
  name: null,
  port: null,
  invalid: false,
  refusal: null,
  key: null,
  failure: null,
});

/** What a failure of `ssh` is shown as (§5): the three failures, and the rest in fixed copy. */
function failureOf(failure: SshFailure): {
  kind: SshFailureKind;
  cause: UnreachableWords | null;
  exit: number | null;
} {
  switch (failure.kind) {
    case "unreachable":
      return { kind: "unreachable", cause: failure.cause, exit: failure.exit };
    case "sign-in-refused":
      return { kind: "sign-in-refused", cause: null, exit: failure.exit };
    case "timed-out":
      return { kind: "timed-out", cause: null, exit: null };
    case "spawn-failed":
      return { kind: "spawn-failed", cause: null, exit: null };
    default:
      return { kind: "ssh-stopped", cause: null, exit: "exit" in failure ? failure.exit : null };
  }
}

const setupFailure = (kind: SetupFailure["kind"]): SetupFailure => ({
  kind,
  exitCode: null,
  port: null,
  reason: null,
});

/** One forward attempt's local socket, by the address the client is given for it. */
type Channel = { url: string; local: string; gatewayPort: number; forward: ForwardSupervisor };

/** What a Pair or Start dialog named, read again after the answer; used once, within its lifetime. */
type Consent = {
  op: "pair" | "start";
  route: Route;
  at: number;
  /** After this the consent is spent: checked on the answer and again right before CODE or START. */
  deadline: number;
  /** The attempt it was given for: another one since, and it starts nothing. */
  attempt: number;
  fingerprint: string;
  program: string;
  programSum: string;
  version: string | null;
  /** Pair: the running service. Start: the stopped one. */
  service: GatewayService | null;
  stopped: { profile: string; port: number; label: string | null; configPath: string } | null;
};

/** The route the app is connected through: its record, prepared route, forward and watchers. */
type Live = {
  record: SshRouteRecord;
  route: Route;
  forward: ForwardSupervisor;
  /** The channel the client was last given. */
  channel: Channel;
  status: RouteStatus;
  stop: Array<() => void>;
  restoredTimer: ReturnType<typeof setTimeout> | null;
  /** The forward is up again and the client was given its channel: the gateway hasn't answered as itself yet. */
  awaiting: boolean;
};

const statusOf = (record: SshRouteRecord, phase: RouteStatus["phase"]): RouteStatus => ({
  name: record.name,
  account: record.account,
  port: record.sshPort,
  phase,
  cause: null,
  profile: record.profile,
  retry: false,
});

export class RemoteSetup {
  private readonly options: RemoteSetupOptions;
  private readonly now: () => number;
  private transportMade: SshTransport | TransportRefusal | null = null;
  private state: SetupState = initialSetupState;
  /** Counts attempts; anything finishing for an older one is dropped. */
  private attempt = 0;
  private route: Route | null = null;
  private capture: { captureId: string; replaces: boolean } | null = null;
  /** The pinned key's fingerprint, once the route is pinned. */
  private fingerprint: string | null = null;
  private found: SshLook | null = null;
  /** The open dialog's snapshot, for Pair or Start. */
  private consent: Consent | null = null;
  /** The setup attempt's forward and record, until it becomes live or is let go. */
  private pending: {
    forward: ForwardSupervisor;
    record: SshRouteRecord;
    fresh: boolean;
    channel: Channel | null;
  } | null = null;
  private live: Live | null = null;
  /** The route the app's saved connection names while it isn't live: Remove and Review act on it. */
  private saved: SshRouteRecord | null = null;
  private readonly channels = new Map<string, Channel>();
  private watching: (() => void) | null = null;
  /** The route id each destination was prepared with in this run, so its pin is found again. */
  private readonly ids = new Map<string, string>();

  constructor(options: RemoteSetupOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  get current(): SetupState {
    return this.state;
  }

  /** Whether setup is on another computer now: the router sends Connect, Back and Cancel here. */
  get active(): boolean {
    return this.state.there !== undefined && this.state.there !== null;
  }

  private publish(next: SetupState): void {
    this.state = next;
    this.options.publish(next);
  }

  private log(line: string): void {
    this.options.log?.(`[setup] ${line}`);
  }

  private withThere(patch: Partial<SshSetup>): SshSetup {
    return { ...(this.state.there ?? emptyThere("")), ...patch };
  }

  private transport(): SshTransport | TransportRefusal {
    this.transportMade ??= this.options.transport();
    return this.transportMade;
  }

  private failThere(failure: SshSetup["failure"], look = this.state.look): void {
    this.publish({ ...this.state, phase: "failed", look, there: this.withThere({ failure }) });
  }

  private failSetup(kind: SetupFailure["kind"]): void {
    this.publish({ ...this.state, phase: "failed", failure: setupFailure(kind) });
  }

  // Channels --------------------------------------------------------------------

  /** A new channel for a forward attempt that is up on `local`. */
  private channelFor(forward: ForwardSupervisor, local: string, gatewayPort: number): Channel {
    const channel: Channel = {
      url: `ws://c${randomBytes(8).toString("hex")}.ssh.invalid`,
      local,
      gatewayPort,
      forward,
    };
    this.channels.set(channel.url, channel);
    for (const [url, old] of this.channels) {
      if (this.channels.size <= MAX_CHANNELS) break;
      if (!this.isCurrent(old)) this.channels.delete(url);
    }
    return channel;
  }

  /** Whether `channel` is the live or pending route's, its forward up on that same socket now. */
  private isCurrent(channel: Channel): boolean {
    const held = this.live?.channel === channel || this.pending?.channel === channel;
    if (!held) return false;
    const state = channel.forward.state;
    const transport = this.transportMade;
    return (
      state.phase === "up" &&
      state.local === channel.local &&
      transport !== null &&
      !("refused" in transport) &&
      transport.socketIsOurs(channel.local)
    );
  }

  /**
   * Whether the client may open a socket to `url` now: a channel's address
   * only while it is current, false for any other channel address, and null
   * for an address that is no channel's, which the host's other rules decide.
   */
  allows(url: string): boolean | null {
    const channel = this.channels.get(url);
    if (!channel) return isChannelUrl(url) ? false : null;
    return this.isCurrent(channel);
  }

  /**
   * The client's socket for a channel's address, made on the channel's own
   * local socket and only while it is current; null for any other address.
   */
  socketFor(url: string): WebSocketLike | null {
    if (!isChannelUrl(url)) return null;
    const channel = this.channels.get(url);
    if (!channel || !this.isCurrent(channel))
      throw new Error("That SSH route's channel isn't current.");
    return routeWebSocket(channel.local, channel.gatewayPort, () => this.isCurrent(channel));
  }

  /** Where the owner approves a request for the gateway at `url` (§9): the channel's route. */
  placeFor(url: string): ApprovalPlace | null {
    const channel = this.channels.get(url);
    if (!channel) return null;
    const record =
      this.live?.channel === channel
        ? this.live.record
        : this.pending?.channel === channel
          ? this.pending.record
          : null;
    return record
      ? {
          route: "ssh",
          name: record.name,
          account: record.account,
          port: record.sshPort,
          profile: record.profile,
        }
      : null;
  }

  /**
   * The read-back after an approval (§9) for the gateway at `url`: through
   * this route's own pinned SSH connection, a fresh LOOK that must find the
   * route's profile running a supported version on exactly the route's
   * gateway port there; then IDENTITY and, only when it returns `expected`,
   * LIST, each a constant script for that profile and port, run with the
   * program the LOOK found. Just before LIST and again after it the forward
   * must be current on its socket and a fresh LOOK must report the same
   * listener (the service's process, every listener on the port, the running
   * version, the program and its checksum), or nothing read counts. Null for an address that is no route's
   * channel (the client takes a route's missing read as an identity it
   * couldn't read). Reads only.
   */
  async readBack(url: string, request: ReadBackRequest): Promise<ReadBack | null> {
    const channel = this.channels.get(url);
    if (!channel) return null;
    const held =
      this.live?.channel === channel
        ? { route: this.live.route, record: this.live.record }
        : this.pending?.channel === channel
          ? { route: this.route, record: this.pending.record }
          : null;
    if (!held) return null;
    const unread = { ok: false, step: "identity", exitCode: null } as const;
    const transport = this.transport();
    if (!held.route || "refused" in transport) return unread;
    const route = held.route;
    const record = held.record;
    const stillHeld = () =>
      this.channels.get(url) === channel &&
      (this.live?.channel === channel || this.pending?.channel === channel);
    const look = await transport.look(route);
    if (!look.ok || !stillHeld()) return unread;
    const proved = listenerFacts(look.facts, record.profile, record.gatewayPort);
    // The same listener as the LOOK proved, through a forward that is current on its socket:
    // asked just before LIST and again after it, and a list on either side of a change is discarded.
    const sameListener = async () => {
      if (!stillHeld() || !this.isCurrent(channel)) return false;
      const again = await transport.look(route);
      return (
        again.ok &&
        stillHeld() &&
        this.isCurrent(channel) &&
        proved !== null &&
        listenerFacts(again.facts, record.profile, record.gatewayPort) === proved
      );
    };
    // The endpoint and its version, established again for the route's own profile alone.
    const facts = sshLook({
      ...look.facts,
      gateways: look.facts.gateways.filter((gateway) => gateway.profile === record.profile),
    });
    if (
      facts.look.outcome !== "running" ||
      !facts.found ||
      facts.look.profile !== record.profile ||
      facts.look.port !== record.gatewayPort ||
      !facts.program ||
      !facts.programSum
    )
      return unread;
    const values = {
      profile: record.profile,
      port: record.gatewayPort,
      program: facts.program,
      programSum: facts.programSum,
    };
    const read = async (kind: "identity" | "list") => {
      const ran = await transport.runScript(route, kind, values);
      // Nothing ran, or not the program the LOOK found: no exit code of OpenClaw's to name.
      if (!ran.ok || !ran.answer || ran.program !== facts.program)
        return { text: null, exitCode: null };
      return ran.answer.exit === 0
        ? { text: ran.answer.text, exitCode: 0 }
        : { text: null, exitCode: ran.answer.exit };
    };
    const id = await read("identity");
    if (!stillHeld()) return unread;
    const identity = id.text === null ? null : parseIdentity(id.text);
    if (!identity) return { ok: false, step: "identity", exitCode: id.exitCode || null };
    // Another gateway at the route's endpoint: its device list is never asked for.
    if (request.expected !== null && identity.deviceId !== request.expected)
      return { ok: false, step: "list", exitCode: null, identity };
    const changed = { ok: false, step: "list", exitCode: null, identity } as const;
    if (!(await sameListener())) return changed;
    const listed = await read("list");
    if (!stillHeld()) return unread;
    const list = listed.text === null ? null : parseDeviceList(listed.text);
    if (!list) return { ok: false, step: "list", exitCode: listed.exitCode || null, identity };
    if (!(await sameListener())) return changed;
    return { ok: true, identity, list };
  }

  // The look -------------------------------------------------------------------

  /** Look on another computer for what was typed (§5). */
  async there(destination: string): Promise<void> {
    const attempt = (this.attempt += 1);
    this.stopWatching();
    await this.letGoPending();
    if (attempt !== this.attempt) return;
    this.route = null;
    this.capture = null;
    this.found = null;
    this.fingerprint = null;
    this.consent = null;
    const base = emptyThere(destination);
    const transport = this.transport();
    if ("refused" in transport) {
      this.publish({
        ...initialSetupState,
        phase: "failed",
        there: { ...base, failure: { kind: transport.refused, cause: null, exit: null } },
      });
      return;
    }
    const prepared = this.prepare(transport, destination);
    if (!prepared.ok) {
      if (prepared.kind === "invalid-destination") {
        this.publish({ ...initialSetupState, there: { ...base, invalid: true } });
      } else if (prepared.kind === "refused") {
        this.publish({
          ...initialSetupState,
          there: {
            ...base,
            refusal: {
              category: prepared.category,
              setting: prepared.setting,
              title: prepared.title,
              sentence: prepared.sentence,
            },
          },
        });
      } else {
        this.publish({
          ...initialSetupState,
          phase: "failed",
          there: {
            ...base,
            failure: {
              kind: prepared.kind === "app-files-unsafe" ? "app-files-unsafe" : "ssh-stopped",
              cause: null,
              exit: null,
            },
          },
        });
      }
      return;
    }
    this.route = prepared;
    const there: SshSetup = {
      ...base,
      account: prepared.account,
      name: prepared.target.name,
      port: prepared.target.port,
    };
    const ask = this.options.ask;
    if (!ask) {
      this.publish({
        ...initialSetupState,
        phase: "failed",
        there: { ...there, failure: { kind: "not-supported", cause: null, exit: null } },
      });
      return;
    }
    this.publish({ ...initialSetupState, phase: "confirming", there });
    // The full resolved account, host and SSH port, before anything runs there (rule 3).
    const answer = await this.askSafely({
      message: `Look for OpenClaw as ${prepared.accountWithPort}?`,
      detail: "This uses the remote account's SSH login environment.",
      confirm: "Look",
    });
    if (attempt !== this.attempt) return;
    if (!answer.confirmed) {
      // Back to the field, with what was typed still in it.
      this.publish({ ...initialSetupState, there });
      return;
    }
    await this.reach(attempt);
  }

  /**
   * The route for what was typed, with one stable id per saved route: a saved
   * record of that destination or of the same resolved endpoint keeps its id
   * (and so its pin), the live route is looked at through its own prepared
   * route and forward, and a name looked at before in this run keeps its id.
   */
  private prepare(
    transport: SshTransport,
    destination: string,
  ): ReturnType<SshTransport["prepareRoute"]> {
    const live = this.live;
    // The configuration as it is now, before any route held for that name is used.
    const resolved = transport.resolve(destination);
    if (!resolved.ok) return resolved;
    if (live && live.record.destination === destination) {
      // The live route only while the person's settings still resolve to exactly its target.
      if (sameTarget(resolved.target, live.route.target)) return live.route as Route & { ok: true };
      return transport.prepareRoute(newRouteId(), destination);
    }
    const saved = this.options.routes.list().find((each) => each.destination === destination);
    let prepared = transport.prepareRoute(
      saved?.id ?? this.ids.get(destination) ?? newRouteId(),
      destination,
    );
    if (!prepared.ok && prepared.kind === "forward-open")
      prepared = transport.prepareRoute(newRouteId(), destination);
    if (prepared.ok) {
      const first = prepared;
      const same = this.options.routes
        .list()
        .find((each) => each.endpoint === first.endpoint && each.id !== first.id);
      if (same) {
        // Another name for a saved endpoint: that route's id, never a second pin for one endpoint.
        transport.forget(first);
        // The live route only while this name's settings resolve to exactly its target.
        if (live && live.record.id === same.id)
          return sameTarget(first.target, live.route.target)
            ? (live.route as Route & { ok: true })
            : transport.prepareRoute(newRouteId(), destination);
        prepared = transport.prepareRoute(same.id, destination);
      }
    }
    if (prepared.ok) {
      this.ids.delete(destination);
      this.ids.set(destination, prepared.id);
      for (const name of this.ids.keys()) {
        if (this.ids.size <= MAX_REMEMBERED_IDS) break;
        this.ids.delete(name);
      }
    }
    return prepared;
  }

  private async askSafely(question: HostQuestion): Promise<HostAnswer> {
    try {
      return (await this.options.ask?.(question)) ?? { confirmed: false, checked: false };
    } catch {
      return { confirmed: false, checked: false };
    }
  }

  /** "Reaching devbox": where the route's key stands, then the look (§5). */
  private async reach(attempt: number): Promise<void> {
    const transport = this.transport();
    const route = this.route;
    if ("refused" in transport || !route) return;
    this.publish({
      ...this.state,
      phase: "looking",
      step: 0,
      slow: false,
      look: null,
      failure: null,
      there: this.withThere({ key: null, failure: null, notice: null }),
    });
    const check = await transport.checkHostKey(route);
    if (attempt !== this.attempt) return;
    if (!check.ok) {
      this.failFromTransport(check);
      return;
    }
    if (check.state === "pinned" || check.state === "pinned-from-known-hosts") {
      this.fingerprint = check.fingerprint;
      this.capture = null;
      await this.lookThere(attempt);
      return;
    }
    this.showKey(check);
  }

  /** A first contact's key, or a changed key beside the trusted one, waiting for the person. */
  private showKey(check: Extract<HostKeyCheck, { state: "first-contact" | "changed" }>): void {
    this.capture = { captureId: check.presented.captureId, replaces: check.state === "changed" };
    this.publish({
      ...this.state,
      phase: "key",
      there: this.withThere({
        key: {
          state: check.state,
          presented: { label: check.presented.label, fingerprint: check.presented.fingerprint },
          trusted: check.state === "changed" ? check.trusted : null,
        },
      }),
    });
  }

  private failFromTransport(result: { ok: false; kind: string; failure?: SshFailure }): void {
    if (result.kind === "stale-route") return;
    if (result.kind === "failed" && result.failure) {
      this.failThere(failureOf(result.failure));
      return;
    }
    this.failThere({
      kind:
        result.kind === "app-files-unsafe"
          ? "app-files-unsafe"
          : result.kind === "not-supported-here"
            ? "not-supported"
            : "ssh-stopped",
      cause: null,
      exit: null,
    });
  }

  /** The LOOK over the pinned connection, and the found card (§5, §6). */
  private async lookThere(attempt: number): Promise<void> {
    const transport = this.transport();
    const route = this.route;
    if ("refused" in transport || !route) return;
    this.publish({
      ...this.state,
      phase: "looking",
      step: 1,
      there: this.withThere({ key: null }),
    });
    const result = await transport.look(route);
    if (attempt !== this.attempt) return;
    if (!result.ok) {
      if (result.kind === "cant-tell") {
        this.publish({
          ...this.state,
          phase: "found",
          look: {
            outcome: "cant-tell",
            reason: result.reason === "timed-out" ? "timeout" : "shape",
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
      if (result.kind === "not-pinned") {
        await this.reach(attempt);
        return;
      }
      this.failFromTransport(result);
      return;
    }
    const found = sshLook(result.facts);
    this.found = found;
    let access: "new" | "paired" | null = null;
    if (found.found && this.fingerprint) {
      const key = this.keyFor(route, found.found.service);
      access = (await this.options.client.hasRouteToken(key).catch(() => false)) ? "paired" : "new";
      if (attempt !== this.attempt) return;
    }
    this.publish({
      ...this.state,
      phase: "found",
      step: 0,
      look: { ...found.look, access },
      failure: null,
    });
  }

  private keyFor(route: Route, service: GatewayService): string {
    return sshRouteKey({
      fingerprint: this.fingerprint!,
      endpoint: route.endpoint,
      gatewayPort: service.port,
      profile: service.profile,
    });
  }

  // Keys ----------------------------------------------------------------------------

  /** After the host's dialog: pins exactly the key first contact captured (rule 8). */
  async trustKey(): Promise<void> {
    const route = this.route;
    const capture = this.capture;
    const key = this.state.there?.key;
    const transport = this.transport();
    if (
      this.state.phase !== "key" ||
      !route ||
      !capture ||
      capture.replaces ||
      key?.state !== "first-contact" ||
      "refused" in transport
    )
      throw new Error("There is no key to trust. Look again.");
    const attempt = (this.attempt += 1);
    const answer = await this.askSafely({
      message: `Trust the key ${route.accountWithPort} presented?`,
      detail: `${key.presented.label} ${key.presented.fingerprint}\n\nClawtrate will connect to ${route.account} only while it presents this key.`,
      confirm: "Trust",
    });
    if (attempt !== this.attempt) return;
    if (!answer.confirmed) return;
    const pinned = transport.trustCapturedKey(route, capture.captureId);
    this.capture = null;
    if (!pinned.ok) {
      // Expired, used or changed meanwhile: the key is captured again and shown again.
      await this.reach(attempt);
      return;
    }
    this.fingerprint = pinned.fingerprint;
    await this.lookThere(attempt);
  }

  /**
   * After the host's dialog and its checkbox: replaces a changed key by the one
   * captured (§5). Confirmed with the box unticked, the dialog says so and asks
   * again, so the answer is never silently dropped. The route's token for the
   * old key goes the moment the new key is pinned.
   */
  async replaceKey(): Promise<void> {
    const route = this.route;
    const capture = this.capture;
    const key = this.state.there?.key;
    const transport = this.transport();
    if (
      this.state.phase !== "key" ||
      !route ||
      !capture?.replaces ||
      key?.state !== "changed" ||
      !key.trusted ||
      "refused" in transport
    )
      throw new Error("There is no changed key to replace. Look again.");
    const attempt = (this.attempt += 1);
    if (this.state.there?.notice)
      this.publish({ ...this.state, there: this.withThere({ notice: null }) });
    const detail = `Saved: ${key.trusted.label} ${key.trusted.fingerprint}\nPresented now: ${key.presented.label} ${key.presented.fingerprint}`;
    let answer: HostAnswer = { confirmed: false, checked: false };
    for (let i = 0; i < REPLACE_ASKS; i += 1) {
      answer = await this.askSafely({
        message: `Replace the saved key for ${route.accountWithPort}?`,
        detail: i === 0 ? detail : `Tick the box to replace the key, or Cancel.\n\n${detail}`,
        confirm: "Replace",
        checkbox: `I checked the new key on ${route.account} itself`,
      });
      if (attempt !== this.attempt || !answer.confirmed || answer.checked) break;
    }
    if (attempt !== this.attempt) return;
    if (!answer.confirmed) return;
    if (!answer.checked) {
      // Replace pressed and the box left unticked: nothing replaced, and the screen says so.
      this.publish({ ...this.state, there: this.withThere({ notice: "replace-unticked" }) });
      return;
    }
    const replaced = transport.replaceTrustedKey(route, capture.captureId);
    this.capture = null;
    if (!replaced.ok) {
      await this.reach(attempt);
      return;
    }
    // The old key's routes keep no token, and the live one is let go: it was the old key's.
    for (const record of this.options.routes.list()) {
      if (record.id === route.id) this.options.routes.deleteToken(record.key);
    }
    if (this.live?.record.id === route.id) await this.closeLive(this.live, { forget: false });
    this.fingerprint = replaced.fingerprint;
    await this.lookThere(attempt);
  }

  // Consent snapshots ---------------------------------------------------------

  private snapshot(
    op: Consent["op"],
    route: Route,
    found: SshLook,
    attempt: number,
  ): Consent | null {
    if (!this.fingerprint || !found.program || !found.programSum) return null;
    const at = this.now();
    return {
      op,
      route,
      at,
      deadline: at + OPERATION_LIFETIME_MS,
      attempt,
      fingerprint: this.fingerprint,
      program: found.program,
      programSum: found.programSum,
      version: found.look.version,
      service: found.found?.service ?? null,
      stopped: found.stopped
        ? {
            profile: found.stopped.profile,
            port: found.stopped.port,
            label: found.stopped.label?.label ?? null,
            configPath: found.stopped.configPath,
          }
        : null,
    };
  }

  /**
   * Whether a consent still holds at the moment its action starts: within its
   * lifetime, for this attempt and this prepared route. Checked right before
   * CODE or START, after every wait since the answer.
   */
  private stillHolds(consent: Consent, attempt: number): boolean {
    return (
      attempt === this.attempt &&
      consent.attempt === attempt &&
      this.route === consent.route &&
      this.now() <= consent.deadline
    );
  }

  /**
   * After the dialog's answer: the snapshot is taken (once, within its
   * lifetime) and every fact it named read again: the same prepared route, the
   * same pinned key, the same program file, version and service. The fresh
   * look, or null when anything differs.
   */
  private async recheck(consent: Consent, attempt: number): Promise<SshLook | null> {
    if (this.consent !== consent) return null;
    this.consent = null;
    if (this.now() > consent.deadline) return null;
    const transport = this.transport();
    if ("refused" in transport || this.route !== consent.route) return null;
    const check = await transport.checkHostKey(consent.route);
    if (attempt !== this.attempt) return null;
    if (!check.ok || check.state !== "pinned" || check.fingerprint !== consent.fingerprint)
      return null;
    const look = await transport.look(consent.route);
    if (attempt !== this.attempt || !look.ok) return null;
    const fresh = sshLook(look.facts);
    if (
      fresh.program !== consent.program ||
      fresh.programSum !== consent.programSum ||
      fresh.look.version !== consent.version
    )
      return null;
    if (consent.op === "pair") {
      if (!fresh.found || !consent.service || !sameService(fresh.found.service, consent.service))
        return null;
    } else {
      const was = consent.stopped;
      const now = fresh.stopped;
      if (
        !was ||
        !now ||
        now.profile !== was.profile ||
        now.port !== was.port ||
        (now.label?.label ?? null) !== was.label ||
        now.configPath !== was.configPath
      )
        return null;
    }
    return fresh;
  }

  // Connect ---------------------------------------------------------------------

  /** Connect (§7 over SSH): the code made there, the forward, a read-only pairing. */
  async connect(): Promise<void> {
    const route = this.route;
    const found = this.found;
    const service = found?.found;
    const transport = this.transport();
    const look = this.state.look;
    if (
      (this.state.phase !== "found" && this.state.phase !== "failed") ||
      !route ||
      !found ||
      !service ||
      look?.outcome !== "running" ||
      !this.fingerprint ||
      "refused" in transport
    )
      throw new Error("There is nothing to connect to. Look again.");
    const attempt = (this.attempt += 1);
    if (!this.options.routes.canKeepTokens()) {
      this.failThere({ kind: "no-token-storage", cause: null, exit: null });
      return;
    }
    const key = this.keyFor(route, service.service);
    const known = this.options.routes.byKey(key);
    // A route with a recorded identity and no token is paired again, with its own dialog.
    const access = look.access === "paired" && this.options.routes.hasToken(key) ? "paired" : "new";
    const where = `the ${service.service.profile} gateway on ${route.accountWithPort}`;
    const consent = this.snapshot("pair", route, found, attempt);
    this.consent = consent;
    this.publish({
      ...this.state,
      phase: "confirming",
      failure: null,
      there: this.withThere({ failure: null }),
    });
    const answer = await this.askSafely(
      access === "paired"
        ? {
            message: `Connect this device read-only to ${where}?`,
            detail: "This device has a saved token for this route. Clawtrate asks for read access.",
            confirm: "Connect read-only",
          }
        : {
            message: `Pair this device read-only with ${where}?`,
            detail:
              "Clawtrate asks for read access. The gateway may ask its owner to approve this device.",
            confirm: "Pair",
          },
    );
    if (attempt !== this.attempt) return;
    if (!answer.confirmed || !consent) {
      this.consent = null;
      this.publish({ ...this.state, phase: "found" });
      return;
    }
    this.publish({ ...this.state, phase: "connecting", step: 0 });
    // What the dialog named, read again before anything changes there or here.
    const fresh = await this.recheck(consent, attempt);
    if (attempt !== this.attempt) return;
    if (!fresh?.found || !fresh.program || !fresh.programSum) {
      this.failSetup("changed");
      return;
    }
    // This computer's live route is let go before its forward is opened again.
    if (this.live?.record.id === route.id) await this.closeLive(this.live, { forget: false });
    if (attempt !== this.attempt) return;
    const record: SshRouteRecord = {
      kind: "ssh",
      id: route.id,
      key,
      destination: this.state.there?.destination ?? route.target.destination.typed,
      name: route.target.name,
      account: route.account,
      sshPort: route.target.port,
      endpoint: route.endpoint,
      fingerprint: this.fingerprint,
      profile: service.service.profile,
      serviceLabel: service.service.serviceLabel as SshRouteRecord["serviceLabel"],
      configPath: service.service.configPath,
      gatewayPort: service.service.port,
      identity: known?.identity ?? null,
      lastUsed: this.now(),
    };
    // Step 1: the code, made there with the program the dialog named, unless this route is paired.
    let code: { bootstrapToken: string; expiresAtMs: number } | null = null;
    // The consent holds until the action starts: its deadline and attempt, checked here last.
    if (!this.stillHolds(consent, attempt)) {
      if (attempt === this.attempt) this.failSetup("changed");
      return;
    }
    if (access === "new") {
      const made = await transport.runScript(route, "code", {
        profile: service.service.profile,
        port: service.service.port,
        program: fresh.program,
        programSum: fresh.programSum,
      });
      if (attempt !== this.attempt) return;
      if (!made.ok) {
        if (
          made.kind === "failed" ||
          made.kind === "app-files-unsafe" ||
          made.kind === "not-supported-here"
        ) {
          this.failFromTransport(made);
        } else {
          this.failThere({ kind: "code-failed", cause: null, exit: null });
        }
        return;
      }
      // The program the LOOK found, still the same file, or nothing was run.
      if (made.program !== fresh.program) {
        this.failSetup("changed");
        return;
      }
      if (!made.answer) {
        this.failThere({ kind: "code-failed", cause: null, exit: null });
        return;
      }
      const parsed =
        made.answer.exit === 0
          ? parseSetupCode(
              made.answer.text,
              `ws://127.0.0.1:${service.service.port}`,
              this.now() + CODE_CLOCK_SKEW_MS,
            )
          : null;
      if (!parsed) {
        this.failThere({ kind: "code-failed", cause: null, exit: made.answer.exit });
        return;
      }
      code = { bootstrapToken: parsed.bootstrapToken, expiresAtMs: parsed.expiresAtMs };
    }
    // Step 2: the forward to the gateway's port there, up only after a LOOK names the same service.
    this.publish({ ...this.state, step: 1 });
    const channel = await this.openChannel(route, fresh.found, record, !known, attempt);
    if (!channel) return;
    // The route is recorded before its first token, which only the store keeps.
    this.options.routes.put(record);
    this.publish({ ...this.state, step: 2 });
    this.watchConnect(attempt, key, channel.url);
    await this.options.client.connectRoute({
      url: channel.url,
      route: key,
      identity: record.identity,
      ...(code ? { code } : {}),
      setup: { check: () => this.isCurrent(channel) },
    });
  }

  /** The forward for a setup attempt, up, and its channel; null when it failed (and says so). */
  private async openChannel(
    route: Route,
    found: NonNullable<SshLook["found"]>,
    record: SshRouteRecord,
    fresh: boolean,
    attempt: number,
  ): Promise<Channel | null> {
    const transport = this.transport();
    if ("refused" in transport) return null;
    const opened = await transport.openForward(route, found);
    if (attempt !== this.attempt) {
      if (opened.ok && this.live?.forward !== opened.forward) void opened.forward.close();
      return null;
    }
    if (!opened.ok) {
      this.failFromTransport(opened as { ok: false; kind: string });
      return null;
    }
    const forward = opened.forward;
    this.pending = { forward, record, fresh, channel: null };
    const up = await this.waitUp(forward, attempt);
    if (attempt !== this.attempt) return null;
    if (up.phase !== "up") {
      await this.letGoPending();
      // Back while the forward closed: the screen it went to stays.
      if (attempt === this.attempt) this.failThere(forwardFailure(up));
      return null;
    }
    const channel = this.channelFor(forward, up.local, found.service.port);
    this.pending.channel = channel;
    return channel;
  }

  /** The forward's first "up", or how it failed, within the wait. */
  private waitUp(forward: ForwardSupervisor, attempt: number): Promise<ForwardState> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (state: ForwardState) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        stop();
        resolve(state);
      };
      const timer = setTimeout(() => finish(forward.state), this.options.forwardWaitMs ?? 45_000);
      const stop = forward.onState((state) => {
        if (attempt !== this.attempt) return finish(state);
        if (state.phase === "up" || state.phase === "closed") finish(state);
        // A forward that fails is shown at its first failure: Connect is the person's to retry.
        else if (state.phase === "waiting") finish(state);
      });
      const now = forward.state;
      if (now.phase === "up" || now.phase === "closed" || now.phase === "waiting") finish(now);
    });
  }

  /** Follows Connect's connection on `url`, its channel, until the bots are read, or it failed (§7). */
  private watchConnect(attempt: number, key: string, url: string): void {
    this.stopWatching();
    const client = this.options.client;
    const check = (state: ClawtrateState) => {
      if (attempt !== this.attempt || client.route !== key) return;
      const { connection, discovery } = state;
      // Only this channel's connection: what the store still says of the one it replaces (another
      // route, connected) is not this attempt's.
      if (connection.gatewayUrl !== url) return;
      if (connection.status === "connected") {
        // The client reads the gateway's identity before it says connected; never live without it.
        if (!connection.gatewayId) return;
        this.acceptPairing(key, connection.gatewayId);
        if (discovery.status === "ready") {
          this.stopWatching();
          void this.becomeLive(key, connection.gatewayId);
          this.publish({ ...this.state, phase: "done", step: 3 });
        } else if (discovery.status === "error") {
          if (this.state.failure?.kind !== "bots")
            this.publish({ ...this.state, phase: "failed", failure: setupFailure("bots") });
        } else if (this.state.step !== 3) this.publish({ ...this.state, step: 3 });
        return;
      }
      if (connection.status === "error") {
        this.stopWatching();
        const code = connection.error?.code;
        // A different gateway after the owner's approval (§9) gets the same cleanup as §8's.
        const identity =
          code === ROUTE_IDENTITY_CHANGED ||
          code === ROUTE_IDENTITY_UNREAD ||
          code === APPROVAL_IDENTITY_CHANGED;
        const pending = this.pending;
        // Not the route's gateway, or no saying: the same cleanup as on a restore (retireIdentity).
        // The cleanup lets go only of its own attempt, never of a Connect started meanwhile.
        if (identity && pending?.record)
          void this.retireIdentity(pending.record, pending.forward).then(() =>
            this.pending === pending ? this.letGoPending() : undefined,
          );
        else void this.letGoPending();
        if (this.saved)
          this.options.publishRoute(
            statusOf(this.saved, identity ? "different-gateway" : "failed"),
          );
        this.publish({
          ...this.state,
          phase: "failed",
          failure: setupFailure(
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
                          : code === ROUTE_IDENTITY_CHANGED
                            ? "identity"
                            : code === ROUTE_IDENTITY_UNREAD
                              ? "identity-unread"
                              : code === SETUP_PAIRING_GONE
                                ? "pairing-gone"
                                : code === SETUP_ENDPOINT_CHANGED || code === "GATEWAY_NOT_ALLOWED"
                                  ? "changed"
                                  : "other",
          ),
        });
      }
    };
    this.watching = client.store.subscribe(check);
  }

  /**
   * The gateway answered as itself and the client kept the token: the pairing
   * is accepted, and its record keeps that identity from now on, so a Back
   * while the bots load keeps it (§7) and a restore checks the next gateway
   * against it.
   */
  private acceptPairing(key: string, identity: string): void {
    const pending = this.pending;
    if (!pending || pending.record.key !== key) return;
    if (!pending.fresh && pending.record.identity === identity) return;
    const record = { ...pending.record, identity };
    try {
      this.options.routes.put(record);
    } catch {
      // A store that can't be written kept no token either: the attempt stays as it was.
      return;
    }
    pending.record = record;
    pending.fresh = false;
  }

  private stopWatching(): void {
    this.watching?.();
    this.watching = null;
  }

  /** The setup attempt's forward and new record go, unless they became the live route. */
  private async letGoPending(): Promise<void> {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    const client = this.options.client;
    if (client.route === pending.record.key && this.live?.record.key !== pending.record.key) {
      await client.disconnect();
    }
    if (this.live?.forward !== pending.forward) await pending.forward.close();
    // A route made by this attempt and never connected is forgotten with its token.
    if (pending.fresh && this.live?.record.id !== pending.record.id)
      this.options.routes.remove(pending.record.id);
  }

  // The live route --------------------------------------------------------------

  /** The attempt's forward is the app's route now: its life is the status strip's (§8). */
  private async becomeLive(key: string, identity: string): Promise<void> {
    const pending = this.pending;
    const route = this.route;
    if (!pending?.channel || !route) return;
    this.pending = null;
    const old = this.live;
    if (old && old.record.id !== pending.record.id) await this.closeLive(old, { forget: false });
    // The identity the client read on this channel, after its hello: the route's from now on.
    const record = { ...pending.record, identity, lastUsed: this.now() };
    this.options.routes.put(record);
    const live: Live = {
      record,
      route,
      forward: pending.forward,
      channel: pending.channel,
      status: statusOf(record, "up"),
      stop: [],
      restoredTimer: null,
      awaiting: false,
    };
    this.live = live;
    this.saved = null;
    this.followLive(live, key);
    this.setStatus(live, live.status);
  }

  private setStatus(live: Live, status: RouteStatus): void {
    live.status = status;
    if (this.live === live) this.options.publishRoute(status);
  }

  /**
   * The forward's drops and returns (§8, §15). A return gives the client a new
   * channel; the strip keeps saying the route is being restored until the
   * gateway answered there with the route's identity, and only then says it is
   * back. Disconnect, another gateway, or Remove retire the route: nothing of
   * it reconnects or speaks over what the app shows then.
   */
  private followLive(live: Live, key: string): void {
    const client = this.options.client;
    const status = (patch: Partial<RouteStatus>) =>
      this.setStatus(live, { ...live.status, ...patch });
    const retired = () => this.live !== live || client.route !== key || client.suspended;
    let down = false;
    live.stop.push(
      live.forward.onState((state) => {
        if (this.live !== live) return;
        if (state.phase === "up") {
          if (!down) return;
          down = false;
          if (retired()) return;
          const channel = this.channelFor(live.forward, state.local, live.record.gatewayPort);
          live.channel = channel;
          live.awaiting = true;
          // Waiting for the gateway to say who it is: nothing for Retry to do.
          status({ phase: "restoring", cause: null, retry: false });
          // The route's own token, by itself, to the gateway's port on the pinned computer.
          void client
            .connectRoute({ url: channel.url, route: key, identity: live.record.identity })
            .catch(() => {
              if (this.live === live) status({ phase: "failed", cause: null, retry: false });
            });
          return;
        }
        if (state.phase === "closed") {
          if (state.reason === "closed") return;
          down = true;
          live.awaiting = false;
          client.holdRoute(key);
          if (state.reason === "different-gateway")
            status({ phase: "service-changed", cause: null, retry: false });
          else status({ phase: "key-changed", cause: null, retry: false });
          return;
        }
        if (!down) {
          down = true;
          live.awaiting = false;
          client.holdRoute(key);
        }
        if (state.phase === "waiting") {
          const cause = state.cause;
          if (cause.kind === "gateway-not-running")
            status({ phase: "stopped", cause: null, retry: false });
          else if (state.longOutage)
            status({
              phase:
                cause.kind === "unreachable" || cause.kind === "timed-out"
                  ? "unreachable"
                  : "failed",
              cause: cause.kind === "unreachable" ? cause.cause : null,
              retry: cause.kind === "unreachable" || cause.kind === "timed-out",
            });
          // The forward waits for its next try: Retry starts it now.
          else status({ phase: "restoring", cause: null, retry: true });
        } else if (live.status.phase !== "unreachable")
          status({ phase: "restoring", cause: null, retry: false });
      }),
    );
    let retiredIdentity = false;
    live.stop.push(
      client.store.subscribe((state) => {
        if (this.live !== live) return;
        // After the owner's approval, a different gateway answered this route (§9): §8's cleanup,
        // the route's token dropped and its forward closed, its record kept for Review.
        if (
          client.route === key &&
          state.connection.error?.code === APPROVAL_IDENTITY_CHANGED &&
          !retiredIdentity
        ) {
          retiredIdentity = true;
          void this.retireIdentity(live.record, live.forward);
          status({ phase: "different-gateway", cause: null, retry: false });
        }
        // Disconnect, another gateway, or Disconnect kept across a restart: the route is retired.
        if (client.route !== key || client.suspended) {
          void this.retire(live, client.suspended && client.route === key);
          return;
        }
        const connection = state.connection;
        if (!live.awaiting) return;
        if (connection.status === "connected" && connection.gatewayId === live.record.identity) {
          live.awaiting = false;
          status({ phase: "restored", cause: null });
          if (live.restoredTimer) clearTimeout(live.restoredTimer);
          live.restoredTimer = setTimeout(() => {
            if (this.live === live && live.status.phase === "restored") status({ phase: "up" });
          }, this.options.restoredMs ?? 4_000);
          return;
        }
        if (connection.status === "error" || connection.status === "pairing") {
          live.awaiting = false;
          const code = connection.error?.code;
          if (code === ROUTE_IDENTITY_CHANGED || code === ROUTE_IDENTITY_UNREAD) {
            void this.retireIdentity(live.record, live.forward);
            status({ phase: "different-gateway", cause: null, retry: false });
          } else status({ phase: "failed", cause: null, retry: false });
        }
      }),
    );
  }

  /** The live route stops being the app's: its forward closes, its record stays. */
  private async retire(live: Live, suspended: boolean): Promise<void> {
    if (this.live !== live) return;
    await this.closeLive(live, { forget: false, keepClient: true });
    if (suspended) {
      this.saved = live.record;
      this.options.publishRoute(statusOf(live.record, "disconnected"));
    }
  }

  /**
   * The status strip's "Retry now" while the forward is being restored, and
   * its "Review" when the key changed, another service or gateway answered,
   * the gateway stopped or the route couldn't be restored (§8): that
   * computer's screens again, from the account's confirmation, with the
   * route's record and pin kept.
   */
  async retryRoute(): Promise<void> {
    const live = this.live;
    if (!live) {
      if (this.saved) await this.there(this.saved.destination);
      return;
    }
    const phase = live.status.phase;
    if (phase === "restoring" || phase === "unreachable") {
      if (live.forward.state.phase === "waiting") live.forward.retryNow();
      return;
    }
    const destination = live.record.destination;
    await this.closeLive(live, { forget: false });
    this.saved = live.record;
    await this.there(destination);
  }

  // Start -----------------------------------------------------------------------

  /** Start OpenClaw there, when the look proved it stopped (F-497), after the host's dialog. */
  async start(): Promise<void> {
    const route = this.route;
    const found = this.found;
    const stopped = found?.stopped;
    const transport = this.transport();
    if (
      this.state.phase !== "found" ||
      this.state.look?.outcome !== "stopped" ||
      !route ||
      !found ||
      !stopped ||
      "refused" in transport
    )
      throw new Error("There is nothing to start. Look again.");
    const attempt = (this.attempt += 1);
    const label = stopped.label?.label ?? "service";
    const consent = this.snapshot("start", route, found, attempt);
    this.consent = consent;
    const answer = await this.askSafely({
      message: `Start OpenClaw on ${route.accountWithPort}?`,
      detail: `Clawtrate will ask the ${stopped.profile} profile's ${label} to start.`,
      confirm: "Start",
    });
    if (attempt !== this.attempt) return;
    if (!answer.confirmed || !consent) {
      this.consent = null;
      return;
    }
    this.publish({ ...this.state, phase: "connecting", step: 0 });
    // The facts again after the answer: the same key, program, version and stopped service.
    const fresh = await this.recheck(consent, attempt);
    if (attempt !== this.attempt) return;
    if (!fresh?.stopped || !fresh.program || !fresh.programSum) {
      this.failSetup("changed");
      return;
    }
    // The consent holds until START runs: its deadline and attempt, checked here last.
    if (!this.stillHolds(consent, attempt)) {
      if (attempt === this.attempt) this.failSetup("changed");
      return;
    }
    const ran = await transport.runScript(route, "start", {
      profile: fresh.stopped.profile,
      port: fresh.stopped.port,
      program: fresh.program,
      programSum: fresh.programSum,
    });
    if (attempt !== this.attempt) return;
    // The script refused before START: its program wasn't the one the look named. Nothing ran.
    if (ran.ok && (ran.program !== fresh.program || !ran.answer)) {
      this.failThere({ kind: "start-not-run", cause: null, exit: null });
      return;
    }
    if (!ran.ok) {
      // ssh couldn't sign in or reach it: START didn't run. Anything else: it may have.
      if (ran.kind === "failed" || ran.kind === "not-supported-here" || ran.kind === "not-pinned")
        this.failFromTransport(ran);
      else this.failThere({ kind: "start-unconfirmed", cause: null, exit: null });
      return;
    }
    if (ran.answer!.exit !== 0) {
      this.failThere({ kind: "start-failed", cause: null, exit: ran.answer!.exit });
      return;
    }
    this.publish({ ...this.state, step: 1 });
    for (let i = 0; i < START_LOOKS; i += 1) {
      const look = await transport.look(route);
      if (attempt !== this.attempt) return;
      const now = look.ok ? sshLook(look.facts) : null;
      if (
        now?.found &&
        now.found.service.profile === fresh.stopped.profile &&
        now.found.service.port === fresh.stopped.port
      ) {
        await this.lookThere(attempt);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, START_LOOK_GAP_MS));
      if (attempt !== this.attempt) return;
    }
    // START ran and exited 0; what followed never showed the gateway running.
    this.failThere({ kind: "start-unconfirmed", cause: null, exit: null });
  }

  // Remove ----------------------------------------------------------------------

  /**
   * Settings, Gateway, "Remove this gateway…", or the same on a saved route
   * that couldn't be restored (§8): after the host's dialog, local only. The
   * forward is stopped by its PID, and the route's record, pinned key, files
   * and token are deleted. Nothing runs on the other computer: OpenClaw there
   * keeps running and still lists this device.
   */
  async removeRoute(): Promise<void> {
    const target = this.live?.record ?? this.saved;
    if (!target) throw new Error("There is no route to another computer to remove.");
    const answer = await this.askSafely({
      message: `Remove ${target.account} (SSH port ${target.sshPort}) from Clawtrate?`,
      detail:
        "Clawtrate disconnects and deletes its saved route, key and token. The device remains listed in OpenClaw.",
      confirm: "Remove",
    });
    if (!answer.confirmed) return;
    const live = this.live;
    if (live ? live.record.id !== target.id : this.saved?.id !== target.id) return;
    this.attempt += 1;
    this.stopWatching();
    await this.letGoPending();
    if (live) await this.closeLive(live, { forget: false });
    if (!(await this.forgetRecord(target))) {
      // The pinned key is still in Clawtrate's file: Remove didn't finish, and says so.
      this.saved = target;
      this.options.publishRoute(statusOf(target, "failed"));
      this.publish({
        ...initialSetupState,
        phase: "failed",
        there: {
          ...emptyThere(target.destination),
          account: target.account,
          name: target.name,
          port: target.sshPort,
          failure: { kind: "remove-failed", cause: null, exit: null },
        },
      });
      return;
    }
    this.saved = null;
    this.publish(initialSetupState);
  }

  /**
   * The one cleanup after a gateway that isn't the route's, or one that
   * wouldn't say who it is, on Pair, at launch and on a restore: the
   * connection is held, the forward closed and the route's token dropped; the
   * record stays, for Review, and only a fresh Pair, with its own dialog,
   * keeps a token for it again.
   */
  private async retireIdentity(
    record: SshRouteRecord,
    forward: ForwardSupervisor | null,
  ): Promise<void> {
    const client = this.options.client;
    client.holdRoute(record.key);
    await client.dropRouteToken(record.key).catch(() => undefined);
    this.options.routes.deleteToken(record.key);
    if (forward) await forward.close();
  }

  /**
   * A saved route that isn't live, deleted by its id: its pin and files
   * first, then its record, token and the saved connection that names it.
   * A pin that couldn't be deleted is a failed Remove, and the rest stays.
   */
  private async forgetRecord(record: SshRouteRecord): Promise<boolean> {
    const transport = this.transport();
    if (!("refused" in transport) && !transport.forgetId(record.id).ok) return false;
    const client = this.options.client;
    await client.forgetRoute(record.key);
    this.options.routes.remove(record.id);
    await client.dropRouteToken(record.key).catch(() => undefined);
    this.options.publishRoute(null);
    return true;
  }

  /** A record the store let go (too many, or its key taken): its pin and files go too. */
  forgetEvicted(record: SshRouteRecord): void {
    if (this.live?.record.id === record.id || this.pending?.record.id === record.id) return;
    const transport = this.transportMade;
    if (transport && !("refused" in transport)) transport.forgetId(record.id);
  }

  private async closeLive(
    live: Live,
    { forget, keepClient = false }: { forget: boolean; keepClient?: boolean },
  ): Promise<void> {
    if (this.live === live) this.live = null;
    for (const stop of live.stop) stop();
    live.stop = [];
    if (live.restoredTimer) clearTimeout(live.restoredTimer);
    const client = this.options.client;
    if (!keepClient && client.route === live.record.key) await client.disconnect();
    await live.forward.close();
    if (forget) {
      const transport = this.transport();
      if (!("refused" in transport)) transport.forgetId(live.record.id);
      this.options.routes.remove(live.record.id);
      await client.dropRouteToken(live.record.key).catch(() => undefined);
    }
    this.options.publishRoute(null);
  }

  // Launch and Reconnect -------------------------------------------------------

  /**
   * At launch, the route the app was connected through, when the client's
   * saved connection names it (§8, §15). One kept across Disconnect waits for
   * Reconnect; any other is opened again (`restore`).
   */
  async resume(): Promise<void> {
    const saved = await this.options.client.savedSettings();
    const record = saved?.route ? this.options.routes.byKey(saved.route) : null;
    if (!record) return;
    this.saved = record;
    if (saved?.suspended) {
      this.options.publishRoute(statusOf(record, "disconnected"));
      return;
    }
    await this.restore(record);
  }

  /** Reconnect after Disconnect, for the route the client's connection names. */
  async reopen(key: string): Promise<void> {
    const record = this.options.routes.byKey(key);
    if (!record) return;
    this.saved = record;
    await this.restore(record);
  }

  /**
   * A saved route opened again with nothing asked: the same endpoint and
   * pinned key, the same gateway service, a token kept for it, then the
   * forward and the route's own token. Anything that differs is shown as it
   * is: the failure, a changed key, or the found card, and the strip and
   * Settings keep the route, so Remove works without a connection.
   */
  private async restore(record: SshRouteRecord): Promise<void> {
    const transport = this.transport();
    if ("refused" in transport) return;
    const attempt = (this.attempt += 1);
    this.stopWatching();
    await this.letGoPending();
    if (attempt !== this.attempt) return;
    this.options.publishRoute(statusOf(record, "restoring"));
    const failRoute = (phase: RouteStatus["phase"] = "failed") =>
      this.options.publishRoute(statusOf(record, phase));
    const route = transport.prepareRoute(record.id, record.destination);
    if (!route.ok || route.endpoint !== record.endpoint) {
      failRoute();
      // The field says why: the setting refused by name, a name that isn't usable, or the name
      // now resolving to another account, host or port; the saved route's Remove stays offered.
      const there = emptyThere(record.destination);
      this.publish({
        ...initialSetupState,
        there: !route.ok
          ? route.kind === "refused"
            ? {
                ...there,
                refusal: {
                  category: route.category,
                  setting: route.setting,
                  title: route.title,
                  sentence: route.sentence,
                },
              }
            : route.kind === "invalid-destination"
              ? { ...there, invalid: true }
              : { ...there, failure: { kind: "app-files-unsafe", cause: null, exit: null } }
          : { ...there, notice: "endpoint-changed" },
      });
      return;
    }
    this.route = route;
    this.found = null;
    this.consent = null;
    const there: SshSetup = {
      ...emptyThere(record.destination),
      account: route.account,
      name: route.target.name,
      port: route.target.port,
      resume: true,
    };
    this.publish({ ...initialSetupState, phase: "connecting", step: 0, there });
    const check = await transport.checkHostKey(route);
    if (attempt !== this.attempt) return;
    if (!check.ok) {
      failRoute(
        check.kind === "failed" && check.failure.kind === "unreachable" ? "unreachable" : "failed",
      );
      this.failFromTransport(check);
      return;
    }
    if (check.state === "changed" || check.state === "first-contact") {
      failRoute(check.state === "changed" ? "key-changed" : "failed");
      this.showKey(check);
      return;
    }
    this.fingerprint = check.fingerprint;
    if (check.state !== "pinned" || check.fingerprint !== record.fingerprint) {
      failRoute();
      await this.lookThere(attempt);
      return;
    }
    const look = await transport.look(route);
    if (attempt !== this.attempt) return;
    const now = look.ok ? serviceOnPort(look.facts, record.gatewayPort, record.profile) : null;
    const expected = {
      profile: record.profile,
      serviceLabel: record.serviceLabel,
      configPath: record.configPath,
      port: record.gatewayPort,
    };
    const hasToken = await this.options.client.hasRouteToken(record.key).catch(() => false);
    if (attempt !== this.attempt) return;
    if (!now?.ok || !sameService(now.service, expected) || !hasToken || record.identity === null) {
      // Not the same service, no token kept, or no gateway identity recorded with the pairing to
      // check the next one against: the found card, and Pair asks again.
      failRoute(now && !now.ok && now.reason === "not-running" ? "stopped" : "failed");
      if (look.ok) {
        this.found = sshLook(look.facts);
        const access = this.found.found ? (hasToken ? "paired" : "new") : null;
        this.publish({
          ...initialSetupState,
          phase: "found",
          look: { ...this.found.look, access },
          there: { ...there, resume: false },
        });
      } else this.failFromTransport(look);
      return;
    }
    this.found = sshLook(look.ok ? look.facts : emptyFacts());
    this.publish({ ...this.state, step: 1 });
    const channel = await this.openChannel(route, now, record, false, attempt);
    if (!channel) {
      if (attempt === this.attempt)
        failRoute(this.state.there?.failure?.kind === "unreachable" ? "unreachable" : "failed");
      return;
    }
    this.publish({ ...this.state, step: 2 });
    this.watchConnect(attempt, record.key, channel.url);
    await this.options.client.connectRoute({
      url: channel.url,
      route: record.key,
      identity: record.identity,
    });
  }

  // Back, reset and quit --------------------------------------------------------

  /** Back from a wait or a failure: to the card, or to the field. */
  cancel(): void {
    const phase = this.state.phase;
    this.attempt += 1;
    this.consent = null;
    this.stopWatching();
    void this.letGoPending();
    if (phase === "connecting" || phase === "failed" || phase === "confirming") {
      if (this.state.look && this.found) {
        this.publish({
          ...this.state,
          phase: "found",
          failure: null,
          there: this.withThere({ failure: null }),
        });
        return;
      }
    }
    this.publish({
      ...initialSetupState,
      there: this.state.there ? emptyThere(this.state.there.destination) : null,
    });
  }

  /** Back to the first screen. The live route, if any, is left as it is. */
  reset(): void {
    this.attempt += 1;
    this.consent = null;
    this.stopWatching();
    void this.letGoPending();
    this.route = null;
    this.capture = null;
    this.found = null;
    if (this.state.there !== undefined && this.state.there !== null)
      this.publish(initialSetupState);
    else this.state = initialSetupState;
  }

  /** Ends every forward and `ssh` this host started, by PID. */
  async closeAll(): Promise<void> {
    this.attempt += 1;
    this.consent = null;
    this.stopWatching();
    const live = this.live;
    this.live = null;
    if (live) {
      for (const stop of live.stop) stop();
      if (live.restoredTimer) clearTimeout(live.restoredTimer);
    }
    const pending = this.pending;
    this.pending = null;
    if (pending) await pending.forward.close();
    const transport = this.transportMade;
    if (transport && !("refused" in transport)) await transport.closeAll();
  }
}

/** A forward that didn't come up, in the failure section 5 or 8 names. */
function forwardFailure(state: ForwardState): SshSetup["failure"] {
  if (state.phase === "waiting") {
    const cause = state.cause;
    switch (cause.kind) {
      case "unreachable":
        return { kind: "unreachable", cause: cause.cause, exit: null };
      case "sign-in-refused":
        return { kind: "sign-in-refused", cause: null, exit: null };
      case "forwarding-refused":
        return { kind: "forwarding-refused", cause: null, exit: null };
      case "gateway-not-answering":
        return { kind: "gateway-not-answering", cause: null, exit: null };
      case "gateway-not-running":
        return { kind: "gateway-stopped", cause: null, exit: null };
      case "cant-tell":
        return { kind: "service-cant-tell", cause: null, exit: null };
      case "timed-out":
        return { kind: "timed-out", cause: null, exit: null };
      case "spawn-failed":
        return { kind: "spawn-failed", cause: null, exit: null };
      case "ssh-stopped":
        return { kind: "ssh-stopped", cause: null, exit: cause.exit };
      default:
        return { kind: "ssh-stopped", cause: null, exit: null };
    }
  }
  if (state.phase === "closed" && state.reason === "key-changed")
    return { kind: "key-changed", cause: null, exit: null };
  if (state.phase === "closed" && state.reason === "different-gateway")
    return { kind: "service-changed", cause: null, exit: null };
  return { kind: "ssh-stopped", cause: null, exit: null };
}

function emptyFacts() {
  return {
    system: null,
    program: null,
    programSum: null,
    version: null,
    gateways: [],
    signs: {
      defaultState: false,
      defaultService: false,
      clawtrateState: false,
      clawtrateService: false,
    },
  };
}

/** Whether two resolved targets name the same endpoint, keys, agent and sign-in. */
function sameTarget(a: Route["target"], b: Route["target"]): boolean {
  return JSON.stringify(targetFacts(a)) === JSON.stringify(targetFacts(b));
}

const targetFacts = (target: Route["target"]) => ({
  hostName: target.hostName,
  user: target.user,
  port: target.port,
  identityFiles: target.identityFiles,
  identitiesOnly: target.identitiesOnly,
  certificateFiles: target.certificateFiles,
  identityAgent: target.identityAgent,
  pubkeyAuthentication: target.pubkeyAuthentication,
});

/**
 * What a LOOK says of the listener at a route's gateway port, for its profile,
 * as one comparable string: the service's process, every process listening
 * on the port, the running version, and the program with its checksum. Null
 * when the LOOK doesn't establish one service holding the port alone.
 */
function listenerFacts(facts: LookFacts, profile: string, port: number): string | null {
  const gateway = facts.gateways.find(
    (each): each is GatewayStatus =>
      !("unreadable" in each) && each.profile === profile && each.port === port,
  );
  const found = serviceOnPort(facts, port);
  if (!gateway || !found.ok || found.service.profile !== profile) return null;
  return JSON.stringify([
    gateway.service?.pid ?? null,
    gateway.listenerPids,
    gateway.version,
    facts.program,
    facts.programSum,
  ]);
}
