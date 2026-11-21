// The SSH transport of "Another computer" (docs/design/setup.md, sections 5, 8
// and 19): routes from a validated destination and the person's configuration,
// host keys captured and pinned as one act, the LOOK over `/bin/sh -s`, the
// three failures told apart, and the forward. The setup host
// (`apps/desktop/src/setup/remote.ts`) and its confirmations call it.
//
// The forward listens on a fresh Unix socket of its own in the host's private
// SSH folder, never on a local TCP port: no other local account or process
// can be what the client's WebSocket reaches (docs/decisions.md, "SSH to
// another computer").

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { MAX_SSH_CAPTURES, MAX_SSH_FORWARDS, MAX_SSH_ROUTES } from "@clawtrate/core";

import { probeHttp } from "./http-probe.ts";
import { createOwn, readOwn, removeOwn, secureDir, UnsafeAppFile, writeOwn } from "./app-files.ts";
import {
  accountText,
  endpointText,
  isGatewayPort,
  isRouteId,
  parseDestination,
  routeAlias,
} from "./destination.ts";
import { ForwardSupervisor, type ForwardProcess, type VerifyResult } from "./forward.ts";
import {
  AppKnownHosts,
  type HostKey,
  type Pin,
  keyLabel,
  literalKeyAt,
  parseKnownHostsLine,
} from "./known-hosts.ts";
import {
  type FoundService,
  type GatewayService,
  type LookFacts,
  lookScript,
  MAX_LOOK_OUTPUT,
  parseLookOutput,
  sameService,
  serviceOnPort,
} from "./look.ts";
import { type ConfigRefusal, resolveTarget, type Target } from "./person-config.ts";
import {
  maxScriptOutput,
  parseScriptOutput,
  remoteScript,
  type ScriptKind,
  type ScriptValues,
} from "./scripts.ts";
import type { ProgramPlace } from "./look.ts";
import { routeConfigText } from "./route-config.ts";
import { endProcess, ProcessTable, type RunResult, runSsh, type Spawn } from "./run.ts";
import {
  classifySshFailure,
  failureFromFacts,
  ForwardOutput,
  parseSshVersion,
  readProbeLines,
  type SshFailure,
} from "./ssh-output.ts";
import { guardWorld, isAutomatedRun, type SshWorld, SshWorldRefused } from "./world.ts";

/** How long a captured key may wait for the person's decision. */
export const CAPTURE_TTL_MS = 2 * 60 * 1000;
const PROBE_TIMEOUT_MS = 20000;
const LOOK_TIMEOUT_MS = 35000;

export type Route = {
  id: string;
  /** `clawtrate-route-<id>-<endpoint tag>`: an alias, its files and its pin belong to one endpoint. */
  alias: string;
  /** The resolved endpoint: "you@[devbox.example]:22". */
  endpoint: string;
  /** Which preparation of the route this is; only the latest is accepted. */
  generation: string;
  target: Target;
  /** The full destination, as text: "you@devbox.example". */
  account: string;
  /** "you@devbox.example (SSH port 22)", for the account's confirmation and every prompt. */
  accountWithPort: string;
};

export type InvalidDestination = {
  ok: false;
  kind: "invalid-destination";
  message: "That isn't an SSH host or alias Clawtrate can use.";
};

export type NotSupportedHere = {
  ok: false;
  kind: "not-supported-here";
  /** `socket-path`: the private SSH folder's path is too long for a local socket in it. */
  reason: "ssh-missing" | "ssh-version" | "platform" | "socket-path";
};

export type Failed = { ok: false; kind: "failed"; failure: SshFailure; note: FailureNote };

export type FailureNote = { title: string; sentence: string; next: string | null };

/** The fixed copy for a failure (docs/design/setup.md, section 5). */
export function failureNote(
  failure: SshFailure,
  route: Route,
  platform: NodeJS.Platform,
): FailureNote {
  const { account, target } = route;
  switch (failure.kind) {
    case "unreachable":
      return {
        title: `Can't reach ${account}`,
        sentence: `Nothing answered at ${target.hostName}, port ${target.port} (${failure.cause}).`,
        next: "Check the name and that the computer is on.",
      };
    case "sign-in-refused":
      return {
        title: `${account} didn't accept your key`,
        sentence: `The SSH sign-in for ${account} was refused.`,
        next:
          "Check that your key is on that computer. A key with a passphrase has to be in your SSH agent first." +
          (platform === "win32" ? " Key-agent sign-in has not been verified on Windows." : ""),
      };
    case "host-key-unknown":
      return {
        title: `Is this ${target.destination.host}?`,
        sentence: `This is the first time Clawtrate connects to ${target.destination.host}.`,
        next: null,
      };
    case "host-key-changed":
      return {
        title: `${target.destination.host}'s key has changed`,
        sentence: `The key ${target.destination.host} presented is not the one Clawtrate trusted. This happens when a computer is reinstalled, and it is also what someone between you and ${target.destination.host} would cause. Clawtrate won't connect until you decide.`,
        next: null,
      };
    case "timed-out":
      return { title: "ssh stopped", sentence: "ssh didn't finish in time.", next: null };
    case "spawn-failed":
      return {
        title: "ssh couldn't start",
        sentence: "Clawtrate couldn't start ssh on this computer.",
        next: null,
      };
    default:
      return {
        title: "ssh stopped",
        sentence: `ssh stopped (exit ${"exit" in failure && failure.exit !== null ? failure.exit : "unknown"}).`,
        next: null,
      };
  }
}

/** The fixed copy for a forward's cause that has no SSH failure of its own. */
export function forwardNote(
  cause:
    | { kind: "forwarding-refused" }
    | { kind: "gateway-not-running" }
    | { kind: "gateway-not-answering" },
  route: Route,
): { title: string; sentence: string } {
  const name = route.target.destination.host;
  if (cause.kind === "forwarding-refused") {
    return {
      title: `${name} doesn't allow forwarding`,
      sentence: `The SSH server on ${name} refused this forwarded connection. Check whether its SSH configuration and your key allow forwarding to the gateway port.`,
    };
  }
  if (cause.kind === "gateway-not-answering") {
    return {
      title: `Nothing answered on the gateway port on ${name}`,
      sentence: "The SSH server could not connect to the gateway's port.",
    };
  }
  return {
    title: `OpenClaw stopped on ${name}`,
    sentence: "The gateway there isn't answering on its port.",
  };
}

/** A captured key as the person sees it: never its bytes, and never taken back from the page. */
export type ShownKey = { captureId: string; label: string; fingerprint: string };

export type HostKeyCheck =
  | { ok: true; state: "pinned"; label: string; fingerprint: string }
  | { ok: true; state: "pinned-from-known-hosts"; label: string; fingerprint: string }
  | { ok: true; state: "first-contact"; presented: ShownKey }
  | {
      ok: true;
      state: "changed";
      trusted: { label: string; fingerprint: string; pinnedAt: string };
      presented: ShownKey;
    };

export type PinResult =
  | { ok: true; label: string; fingerprint: string }
  | { ok: false; kind: "no-such-capture" | "already-pinned" | "nothing-to-replace" }
  /** The trusted key is no longer the one shown beside this capture: check again and confirm again. */
  | { ok: false; kind: "pin-changed" };

export type LookResult =
  | { ok: true; facts: LookFacts }
  | Failed
  | NotSupportedHere
  | { ok: false; kind: "not-pinned" }
  | {
      ok: false;
      kind: "cant-tell";
      reason:
        | "timed-out"
        | "too-large"
        | "no-begin"
        | "no-end"
        | "malformed"
        | "incomplete"
        | "script-failed";
    };

/** What a CODE, START or STOP script found: the program's place and OpenClaw's answer, in memory. */
export type ScriptResult =
  | { ok: true; program: ProgramPlace | null; answer: { text: string; exit: number | null } | null }
  | Failed
  | NotSupportedHere
  | { ok: false; kind: "not-pinned" }
  | {
      ok: false;
      kind: "cant-tell";
      reason:
        | "timed-out"
        | "too-large"
        | "no-begin"
        | "no-end"
        | "malformed"
        | "incomplete"
        | "script-failed";
    };

export type OpenForwardResult =
  | { ok: true; forward: ForwardSupervisor }
  | NotSupportedHere
  | StaleRoute
  | AppFilesUnsafe
  | {
      ok: false;
      kind: "not-pinned" | "not-a-found-service" | "forward-open" | "too-many-forwards";
    }
  | { ok: false; kind: "closing" };

/** A route prepared again since, or forgotten: nothing is done with it. */
export type StaleRoute = { ok: false; kind: "stale-route" };
const STALE: StaleRoute = { ok: false, kind: "stale-route" };
export type RouteForwardOpen = { ok: false; kind: "forward-open" };

type Capture = {
  id: string;
  routeId: string;
  /** The preparation and endpoint of the route whose configuration the probe ran with. */
  generation: string;
  key: HostKey;
  endpoint: string;
  at: number;
  replaces: boolean;
  /** For a replacement: the trusted key shown beside it, which it may replace and no other. */
  trusted: { type: string; key: string } | null;
};

export type TransportOptions = {
  spawn?: Spawn;
  now?: () => number;
};

const MIN_VERSION = { major: 8, minor: 4 };
/** Windows' bundled client, as the research ran it. */
const MIN_WINDOWS_VERSION = { major: 9, minor: 5 };

const atLeast = (v: { major: number; minor: number }, min: { major: number; minor: number }) =>
  v.major > min.major || (v.major === min.major && v.minor >= min.minor);

export class SshTransport {
  readonly processes: ProcessTable;
  private readonly known: AppKnownHosts;
  private readonly captures = new Map<string, Capture>();
  /** Each route id's latest preparation, at most `MAX_SSH_ROUTES`; an older one is stale. */
  private readonly routes = new Map<string, string>();
  /** One forward per route id, with the preparation and service it was opened for. */
  private readonly forwards = new Map<
    string,
    { generation: string; service: GatewayService; forward: ForwardSupervisor }
  >();
  /** Ends every run in flight when `closeAll` is called; replaced afterwards. */
  private stopAll = new AbortController();
  /** Every public call in flight, so that `closeAll` waits for them. */
  private inflight: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private client: Promise<{ ok: true } | NotSupportedHere> | null = null;

  readonly world: SshWorld;

  constructor(world: SshWorld, options: TransportOptions = {}) {
    guardWorld(world);
    this.world = world;
    this.processes = new ProcessTable(options.spawn);
    this.now = options.now ?? Date.now;
    secureDir(world.appDir);
    this.known = new AppKnownHosts(join(world.appDir, "known_hosts"));
    // A socket left by a run that ended without closing its forward listens on nothing now.
    for (const name of readdirSync(world.appDir)) {
      const path = join(world.appDir, name);
      if (this.socketIsOurs(path)) rmSync(path, { force: true });
    }
  }

  /** Whether this computer's `ssh` is one the module can use; asked once. */
  checkClient(): Promise<{ ok: true } | NotSupportedHere> {
    this.client ??= (async () => {
      // Windows has no local socket this module can prove private: no SSH route there.
      if (!["darwin", "linux"].includes(this.world.platform)) {
        return { ok: false, kind: "not-supported-here", reason: "platform" } as const;
      }
      if (Buffer.byteLength(socketPathIn(this.world.appDir, "0".repeat(12))) > MAX_SOCKET_PATH) {
        return { ok: false, kind: "not-supported-here", reason: "socket-path" } as const;
      }
      if (!existsSync(this.world.ssh)) {
        return { ok: false, kind: "not-supported-here", reason: "ssh-missing" } as const;
      }
      const run = await runSsh(this.processes, this.world, ["-V"], {
        signal: this.signal(),
        timeoutMs: 5000,
        maxStdout: 4096,
      });
      if (run.cancelled) {
        this.client = null;
        return { ok: false, kind: "not-supported-here", reason: "ssh-missing" } as const;
      }
      // The version command has to have worked, not only printed a version.
      if (run.spawnFailed || run.exit !== 0) {
        return { ok: false, kind: "not-supported-here", reason: "ssh-version" } as const;
      }
      const version = parseSshVersion(run.stderr + run.stdout);
      const min = this.world.platform === "win32" ? MIN_WINDOWS_VERSION : MIN_VERSION;
      if (
        !version ||
        version.windows !== (this.world.platform === "win32") ||
        !atLeast(version, min)
      ) {
        return { ok: false, kind: "not-supported-here", reason: "ssh-version" } as const;
      }
      return { ok: true } as const;
    })();
    return this.client;
  }

  /** A route from what was typed, or the refusal that names why not. Writes the route's files. */
  /**
   * What was typed, resolved from the person's configuration as it is now,
   * or why not, with no file written and nothing run: what a fresh Look
   * compares with a route it already holds.
   */
  resolve(
    typed: unknown,
  ):
    | { ok: true; target: Target; endpoint: string }
    | ConfigRefusal
    | InvalidDestination
    | AppFilesUnsafe {
    return guarded(() => {
      const destination = parseDestination(typed);
      if (!destination)
        return {
          ok: false as const,
          kind: "invalid-destination" as const,
          message: "That isn't an SSH host or alias Clawtrate can use." as const,
        };
      const target = resolveTarget(this.world, destination);
      if (!target.ok) return target;
      guardWorld(this.world, [...target.identityFiles, ...target.certificateFiles]);
      return {
        ok: true as const,
        target,
        endpoint: endpointText(target.user, target.hostName, target.port),
      };
    });
  }

  private prepareRouteInner(
    routeId: string,
    typed: unknown,
  ): (Route & { ok: true }) | ConfigRefusal | InvalidDestination | RouteForwardOpen {
    if (!isRouteId(routeId)) throw new Error("Not a route id.");
    if (this.forwards.has(routeId)) return { ok: false, kind: "forward-open" };
    const destination = parseDestination(typed);
    if (!destination) {
      return {
        ok: false,
        kind: "invalid-destination",
        message: "That isn't an SSH host or alias Clawtrate can use.",
      };
    }
    const target = resolveTarget(this.world, destination);
    if (!target.ok) return target;
    if (isAutomatedRun() && target.identityAgent !== "world" && target.identityAgent !== "none") {
      throw new SshWorldRefused(
        "An automated run must not use an SSH agent, the configuration's included.",
      );
    }
    guardWorld(this.world, [...target.identityFiles, ...target.certificateFiles]);
    const endpoint = endpointText(target.user, target.hostName, target.port);
    const route: Route = {
      id: routeId,
      alias: routeAlias(routeId, endpoint),
      endpoint,
      generation: randomUUID(),
      target: deepFreeze(target),
      account: accountText(target.user, target.hostName),
      accountWithPort: `${accountText(target.user, target.hostName)} (SSH port ${target.port})`,
    };
    // An earlier preparation's objects are stale from here on, and its files for another endpoint go.
    this.routes.delete(routeId);
    while (this.routes.size >= MAX_SSH_ROUTES) {
      const oldest = [...this.routes.keys()].find((id) => !this.forwards.has(id));
      if (oldest === undefined) break;
      this.routes.delete(oldest);
    }
    this.routes.set(routeId, route.generation);
    this.removeConfigs(routeId, route.alias);
    this.writeConfigs(route);
    return Object.freeze({ ok: true as const, ...route });
  }

  /** Whether `route` is the latest preparation of its id. */
  private current(route: Route): boolean {
    return this.routes.get(route.id) === route.generation;
  }

  /** Removes the route's configuration files, but those of `keep`. */
  private removeConfigs(routeId: string, keep: string | null): void {
    const prefix = `route-${routeId}-`;
    const keepName = keep === null ? null : keep.slice("clawtrate-".length);
    for (const name of readdirSync(this.world.appDir)) {
      if (!name.startsWith(prefix) || !name.endsWith(".conf")) continue;
      if (keepName !== null && name.startsWith(`${keepName}.`)) continue;
      removeOwn(join(this.world.appDir, name));
    }
  }

  configPath(route: Route, purpose: "normal" | "lookup" = "normal"): string {
    return join(
      this.world.appDir,
      `${route.alias.slice("clawtrate-".length)}${purpose === "lookup" ? ".lookup" : ""}.conf`,
    );
  }

  private writeConfigs(route: Route): void {
    for (const purpose of ["normal", "lookup"] as const) {
      const text = routeConfigText(route.id, route.target, this.world, this.known.path, purpose);
      writeOwn(this.configPath(route, purpose), text);
    }
  }

  private endpoint(route: Route): string {
    return route.endpoint;
  }

  /** The fixed options of every probe: no session, no credentials offered. */
  private probeArgs(config: string, alias: string, extra: string[]): string[] {
    return [
      "-F",
      config,
      "-v",
      "-N",
      "-T",
      "-o",
      "PreferredAuthentications=none",
      "-o",
      "NumberOfPasswordPrompts=0",
      ...extra,
      "--",
      alias,
    ];
  }

  private async probe(config: string, alias: string, extra: string[] = []) {
    const run = await runSsh(this.processes, this.world, this.probeArgs(config, alias, extra), {
      signal: this.signal(),
      timeoutMs: PROBE_TIMEOUT_MS,
      maxStdout: 4096,
      // The key question is settled once the server's key was checked or written. A match is
      // whole only with the file and line it was found at, which ssh writes on the line after
      // it; a refusal is left to end by itself, so that its exit status 255 is read. On Linux
      // the reader can run, and stop ssh, before ssh writes that next line or exits.
      stopWhen: (stderr) =>
        (/is known and matches the/.test(stderr) &&
          /debug1: Found key in [^\n]*:[0-9]+\r?\n/.test(stderr)) ||
        /Permanently added|Authentications that can continue/.test(stderr),
    });
    return { run, lines: readProbeLines(run.stderr) };
  }

  private failed(route: Route, failure: SshFailure): Failed {
    return {
      ok: false,
      kind: "failed",
      failure,
      note: failureNote(failure, route, this.world.platform),
    };
  }

  /**
   * Where the route's host key stands: pinned, pinned now from a key the person
   * already trusts, first contact, or changed. A key is captured without
   * signing in; a changed key is never replaced here.
   */
  private async checkHostKeyInner(
    route: Route,
  ): Promise<HostKeyCheck | Failed | NotSupportedHere | StaleRoute> {
    const client = await this.checkClient();
    if (!client.ok) return client;
    if (!this.current(route)) return STALE;
    const pin = this.known.get(route.alias, route.endpoint);
    if (pin) return this.checkPinned(route, pin);
    const prior = await this.priorTrust(route);
    if (!this.current(route)) return STALE;
    // Another check of this route may have pinned a key while this one looked: never overwritten.
    const pinnedMeanwhile = this.known.get(route.alias, route.endpoint);
    if (pinnedMeanwhile) {
      if (prior && prior.type === pinnedMeanwhile.type && prior.key === pinnedMeanwhile.key) {
        return {
          ok: true,
          state: "pinned",
          label: keyLabel(pinnedMeanwhile.type),
          fingerprint: pinnedMeanwhile.fingerprint,
        };
      }
      return this.checkPinned(route, pinnedMeanwhile);
    }
    if (prior) {
      const pinned = this.known.pin(
        route.alias,
        prior,
        this.endpoint(route),
        new Date(this.now()),
        false,
      );
      return {
        ok: true,
        state: "pinned-from-known-hosts",
        label: keyLabel(pinned.type),
        fingerprint: pinned.fingerprint,
      };
    }
    const captured = await this.capture(route, null);
    if (!this.current(route)) return STALE;
    if (!captured.ok) return captured;
    return { ok: true, state: "first-contact", presented: this.shown(captured.capture) };
  }

  /** Where a pinned route's key stands: still the pinned one, or changed (with the key presented now). */
  private async checkPinned(route: Route, pin: Pin): Promise<HostKeyCheck | Failed | StaleRoute> {
    const { run, lines } = await this.probe(this.configPath(route), route.alias);
    if (!this.current(route)) return STALE;
    // An approved replacement may have installed another key while ssh read the file: what it
    // matched or refused is then about that key, so the check is made again against it.
    const now = this.known.get(route.alias, route.endpoint);
    if (now && (now.type !== pin.type || now.key !== pin.key)) return this.checkPinned(route, now);
    if (lines.matches)
      return {
        ok: true,
        state: "pinned",
        label: keyLabel(pin.type),
        fingerprint: pin.fingerprint,
      };
    const failure = runFailure(run);
    if (failure.kind !== "host-key-changed" && failure.kind !== "host-key-unknown") {
      return this.failed(route, failure);
    }
    const captured = await this.capture(route, pin);
    if (!this.current(route)) return STALE;
    if (!captured.ok) return captured;
    if (captured.capture.key.fingerprint === pin.fingerprint) {
      this.captures.delete(captured.capture.id);
      return {
        ok: true,
        state: "pinned",
        label: keyLabel(pin.type),
        fingerprint: pin.fingerprint,
      };
    }
    return {
      ok: true,
      state: "changed",
      trusted: {
        label: keyLabel(pin.type),
        fingerprint: pin.fingerprint,
        pinnedAt: pin.pinnedAt,
      },
      presented: this.shown(captured.capture),
    };
  }

  /** A literal key for the resolved host and port in the person's known-hosts file, verified, or null. */
  private async priorTrust(route: Route): Promise<HostKey | null> {
    if (!existsSync(this.world.personKnownHosts)) return null;
    const { lines } = await this.probe(this.configPath(route, "lookup"), route.alias);
    if (!this.current(route)) return null;
    if (!lines.matches || !lines.foundIn || !lines.serverKey) return null;
    const norm = (path: string) => {
      const p = path.replaceAll("\\", "/");
      return this.world.platform === "win32" || this.world.platform === "darwin"
        ? p.toLowerCase()
        : p;
    };
    if (norm(lines.foundIn.file) !== norm(this.world.personKnownHosts)) return null;
    let text: string;
    try {
      text = readFileSync(this.world.personKnownHosts, "utf8");
    } catch {
      return null;
    }
    if (text.length > 4 * 1024 * 1024) return null;
    const key = literalKeyAt(text, lines.foundIn.line);
    if (
      !key ||
      key.fingerprint !== lines.serverKey.fingerprint ||
      key.type !== lines.serverKey.type
    )
      return null;
    return key;
  }

  /** Connects once, offering nothing, and keeps the key the computer presented on that connection. */
  private async capture(
    route: Route,
    trusted: Pin | null,
  ): Promise<{ ok: true; capture: Capture } | Failed | StaleRoute> {
    const id = randomUUID();
    const file = join(this.world.appDir, `capture-${id}`);
    // The capture has a configuration of its own, so that its file's path is a quoted value, never split.
    const config = join(this.world.appDir, `capture-${id}.conf`);
    createOwn(file, "");
    try {
      createOwn(config, routeConfigText(route.id, route.target, this.world, file, "capture"));
      const { run } = await this.probe(config, route.alias);
      if (!this.current(route)) return STALE;
      const lines = (readOwn(file, 64 * 1024) ?? "")
        .split("\n")
        .filter((line) => line.trim() !== "");
      const parsed = lines.length === 1 ? parseKnownHostsLine(lines[0]!) : null;
      if (!parsed || parsed.hosts !== route.alias) {
        return this.failed(route, runFailure(run));
      }
      const capture: Capture = {
        id: randomUUID(),
        routeId: route.id,
        generation: route.generation,
        key: { type: parsed.type, key: parsed.key, fingerprint: parsed.fingerprint },
        endpoint: this.endpoint(route),
        at: this.now(),
        replaces: trusted !== null,
        trusted: trusted && { type: trusted.type, key: trusted.key },
      };
      this.keepCapture(capture);
      return { ok: true, capture };
    } finally {
      removeOwn(file);
      removeOwn(config);
    }
  }

  /** Keeps a capture: expired ones are dropped, then the oldest past `MAX_SSH_CAPTURES`. */
  private keepCapture(capture: Capture): void {
    for (const [id, kept] of this.captures) {
      if (this.now() - kept.at > CAPTURE_TTL_MS) this.captures.delete(id);
    }
    while (this.captures.size >= MAX_SSH_CAPTURES) {
      const oldest = this.captures.keys().next().value;
      if (oldest === undefined) break;
      this.captures.delete(oldest);
    }
    this.captures.set(capture.id, capture);
  }

  private shown(capture: Capture): ShownKey {
    return {
      captureId: capture.id,
      label: keyLabel(capture.key.type),
      fingerprint: capture.key.fingerprint,
    };
  }

  private takeCapture(route: Route, captureId: string, replaces: boolean): Capture | null {
    const capture = this.captures.get(captureId);
    if (!capture || capture.routeId !== route.id || capture.replaces !== replaces) return null;
    this.captures.delete(captureId);
    if (this.now() - capture.at > CAPTURE_TTL_MS) return null;
    if (capture.generation !== route.generation || capture.endpoint !== route.endpoint) return null;
    return capture;
  }

  /** After the host's confirmation: pins exactly the bytes captured at first contact. */
  private trustInner(route: Route, captureId: string): PinResult {
    if (this.known.get(route.alias, route.endpoint)) return { ok: false, kind: "already-pinned" };
    const capture = this.takeCapture(route, captureId, false);
    if (!capture) return { ok: false, kind: "no-such-capture" };
    const pin = this.known.pin(
      route.alias,
      capture.key,
      capture.endpoint,
      new Date(this.now()),
      false,
    );
    return { ok: true, label: keyLabel(pin.type), fingerprint: pin.fingerprint };
  }

  /** After the host's confirmation with its checkbox: replaces a changed key by the one captured. */
  private replaceInner(route: Route, captureId: string): PinResult {
    const current = this.known.get(route.alias, route.endpoint);
    if (!current) return { ok: false, kind: "nothing-to-replace" };
    const capture = this.takeCapture(route, captureId, true);
    if (!capture) return { ok: false, kind: "no-such-capture" };
    // The person approved replacing the key shown to them. If another approval has replaced
    // it since, nothing is written.
    if (capture.trusted?.type !== current.type || capture.trusted.key !== current.key) {
      return { ok: false, kind: "pin-changed" };
    }
    const pin = this.known.pin(
      route.alias,
      capture.key,
      capture.endpoint,
      new Date(this.now()),
      true,
    );
    return { ok: true, label: keyLabel(pin.type), fingerprint: pin.fingerprint };
  }

  /** Runs the LOOK script through the pinned connection, and returns its facts. */
  private async lookInner(
    route: Route,
    options: { signal?: AbortSignal } = {},
  ): Promise<LookResult | StaleRoute> {
    const client = await this.checkClient();
    if (!client.ok) return client;
    if (!this.current(route)) return STALE;
    if (!this.known.get(route.alias, route.endpoint)) return { ok: false, kind: "not-pinned" };
    const script = lookScript();
    const run = await runSsh(
      this.processes,
      this.world,
      ["-F", this.configPath(route), "--", route.alias, "/bin/sh", "-s"],
      {
        stdin: script.text,
        timeoutMs: LOOK_TIMEOUT_MS,
        maxStdout: MAX_LOOK_OUTPUT,
        signal: this.signal(options.signal),
      },
    );
    if (!this.current(route)) return STALE;
    if (run.timedOut || run.cancelled) return { ok: false, kind: "cant-tell", reason: "timed-out" };
    if (run.overflow) return { ok: false, kind: "cant-tell", reason: "too-large" };
    if (run.spawnFailed || run.exit === 255) return this.failed(route, runFailure(run));
    // The script ends with exit 0 after its last fact; anything else is not a whole answer.
    if (run.exit !== 0) return { ok: false, kind: "cant-tell", reason: "script-failed" };
    const parsed = parseLookOutput(run.stdout, script.requestId);
    if (!parsed.ok) return { ok: false, kind: "cant-tell", reason: parsed.reason };
    return { ok: true, facts: parsed.facts };
  }

  /** Runs a constant script (CODE, START, STOP) through the pinned connection. */
  private async scriptInner(
    route: Route,
    kind: ScriptKind,
    values: ScriptValues,
    options: { signal?: AbortSignal } = {},
  ): Promise<ScriptResult | StaleRoute> {
    const client = await this.checkClient();
    if (!client.ok) return client;
    if (!this.current(route)) return STALE;
    if (!this.known.get(route.alias, route.endpoint)) return { ok: false, kind: "not-pinned" };
    const script = remoteScript(kind, values);
    const run = await runSsh(
      this.processes,
      this.world,
      ["-F", this.configPath(route), "--", route.alias, "/bin/sh", "-s"],
      {
        stdin: script.text,
        timeoutMs: LOOK_TIMEOUT_MS,
        maxStdout: maxScriptOutput(kind),
        signal: this.signal(options.signal),
      },
    );
    if (!this.current(route)) return STALE;
    if (run.timedOut || run.cancelled) return { ok: false, kind: "cant-tell", reason: "timed-out" };
    if (run.overflow) return { ok: false, kind: "cant-tell", reason: "too-large" };
    if (run.spawnFailed || run.exit === 255) return this.failed(route, runFailure(run));
    if (run.exit !== 0) return { ok: false, kind: "cant-tell", reason: "script-failed" };
    const parsed = parseScriptOutput(kind, run.stdout, script.requestId);
    if (!parsed.ok) return { ok: false, kind: "cant-tell", reason: parsed.reason };
    return { ok: true, program: parsed.program, answer: parsed.answer };
  }

  /**
   * Runs one of the constant scripts, CODE, START or STOP, through the pinned
   * connection, for `profile` and the gateway's `port`. Only after the host's
   * own dialog: the caller's part. OpenClaw's answer is returned in memory.
   */
  runScript(
    route: Route,
    kind: ScriptKind,
    values: ScriptValues,
    options: { signal?: AbortSignal } = {},
  ): Promise<ScriptResult | AppFilesUnsafe | StaleRoute> {
    if (!this.current(route)) return Promise.resolve(STALE);
    return this.track(guardedAsync(() => this.scriptInner(route, kind, values, options)));
  }

  /**
   * Opens the route's forward to `gatewayPort` on the other computer's
   * loopback. It is usable only while its state is "up", which it reaches only
   * after a LOOK names `expected` on that port.
   */
  async openForward(route: Route, found: FoundService): Promise<OpenForwardResult> {
    // The same gates as every other call: the route as prepared, a client this module supports, a pin.
    if (!this.current(route)) return STALE;
    if (found.ok !== true || found.holdsPort !== true || !isGatewayPort(found.service.port)) {
      return { ok: false, kind: "not-a-found-service" };
    }
    const shutdown = this.stopAll.signal;
    const client = await this.checkClient();
    if (shutdown.aborted || this.stopAll.signal !== shutdown) {
      return { ok: false, kind: "closing" };
    }
    if (!client.ok) return client;
    const pinned = guarded(() => this.known.get(route.alias, route.endpoint));
    if (pinned !== null && "kind" in pinned) return pinned;
    if (pinned === null) return { ok: false, kind: "not-pinned" };
    if (!this.current(route)) return STALE;
    const expected = found.service;
    const gatewayPort = expected.port;
    const open = this.forwards.get(route.id);
    if (open && open.forward.state.phase !== "closed") {
      // One forward per route: the same one again, or none while another is open.
      if (open.generation === route.generation && sameService(open.service, expected)) {
        return { ok: true, forward: open.forward };
      }
      return { ok: false, kind: "forward-open" };
    }
    if (this.forwards.size >= MAX_SSH_FORWARDS) return { ok: false, kind: "too-many-forwards" };
    const forward = new ForwardSupervisor({
      pickLocal: async () => this.freshSocket(),
      start: (local) => this.startForward(route, local, gatewayPort),
      probe: (local, process, signal) =>
        this.socketIsOurs(local)
          ? probeHttp(local, gatewayPort, () => process.channel(), 5000, signal)
          : Promise.resolve("no-answer"),
      verify: async (signal): Promise<VerifyResult> => {
        const look = await this.look(route, { signal });
        if (look.ok) {
          const now = serviceOnPort(look.facts, gatewayPort, expected.profile);
          if (!now.ok) return { kind: now.reason === "not-running" ? "not-running" : "cant-tell" };
          return sameService(now.service, expected) ? { kind: "same" } : { kind: "different" };
        }
        if (look.kind === "failed") return { kind: "failed", failure: look.failure };
        return { kind: "cant-tell" };
      },
      now: this.now,
      setTimer: (callback, ms) => setTimeout(callback, ms),
      clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    });
    this.forwards.set(route.id, { generation: route.generation, service: expected, forward });
    forward.onState((state) => {
      if (state.phase === "closed" && this.forwards.get(route.id)?.forward === forward) {
        this.forwards.delete(route.id);
      }
    });
    forward.open();
    return { ok: true, forward };
  }

  /** A local socket path no attempt has had: a fresh name in the private SSH folder, absent now. */
  private freshSocket(): string {
    for (let i = 0; i < 8; i += 1) {
      const path = socketPathIn(this.world.appDir, randomBytes(6).toString("hex"));
      if (!existsSync(path)) return path;
    }
    throw new Error("No fresh local socket name.");
  }

  /**
   * Whether `path` is the forward's own socket: in the private SSH folder, a
   * socket (not a link), this account's, and closed to everyone else.
   */
  socketIsOurs(path: string): boolean {
    if (!isSocketPathIn(this.world.appDir, path)) return false;
    try {
      const info = lstatSync(path);
      const uid = typeof process.getuid === "function" ? process.getuid() : -1;
      return info.isSocket() && info.uid === uid && (info.mode & 0o077) === 0;
    } catch {
      return false;
    }
  }

  private startForward(route: Route, local: string, gatewayPort: number): ForwardProcess {
    const child = this.processes.start(this.world, [
      "-F",
      this.configPath(route),
      "-v",
      "-o",
      "ClearAllForwardings=no",
      // The socket is made closed to group and others, and never over a file that is there.
      "-o",
      "StreamLocalBindMask=0177",
      "-o",
      "StreamLocalBindUnlink=no",
      "-N",
      "-L",
      `${local}:127.0.0.1:${gatewayPort}`,
      "--",
      route.alias,
    ]);
    // The reader keeps at most 1,024 characters of the current unfinished stderr line so it
    // can classify it across chunks. It discards each complete line after classification
    // and exposes only typed facts.
    const output = new ForwardOutput(local);
    const listening: Array<() => void> = [];
    const exits: Array<(failure: SshFailure) => void> = [];
    let heard = false;
    child.stdin?.on("error", () => {});
    child.stdin?.end();
    child.stdout?.resume();
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      output.push(chunk);
      if (!heard && output.listening) {
        heard = true;
        for (const listener of listening) listener();
      }
    });
    let ended = false;
    const exit = (failure: SshFailure) => {
      if (ended) return;
      ended = true;
      for (const listener of exits) listener(failure);
    };
    // A spawn that failed may never close.
    child.once("error", () => {
      if (child.pid === undefined) exit({ kind: "spawn-failed" });
    });
    // The attempt's socket goes with its process.
    const unlink = () => {
      if (this.socketIsOurs(local)) rmSync(local, { force: true });
    };
    child.once("close", (code) => {
      unlink();
      exit(failureFromFacts(output.facts, code));
    });
    return {
      pid: child.pid ?? null,
      onListening: (listener) => listening.push(listener),
      onExit: (listener) => exits.push(listener),
      channel: () => ({ refused: output.refused, connectFailed: output.connectFailed }),
      end: () => endProcess(child).then(unlink),
    };
  }

  /** Forgets the route: its pin and its files. Its forwards must be closed first. */
  private forgetInner(route: Route): void {
    const prefix = `clawtrate-route-${route.id}-`;
    this.known.removeWhere((alias) => alias.startsWith(prefix));
    this.removeConfigs(route.id, null);
    this.routes.delete(route.id);
  }

  /** A route from what was typed, or the refusal that names why not. Writes the route's files. */
  prepareRoute(
    routeId: string,
    typed: unknown,
  ):
    | (Route & { ok: true })
    | ConfigRefusal
    | InvalidDestination
    | AppFilesUnsafe
    | RouteForwardOpen {
    return guarded(() => this.prepareRouteInner(routeId, typed));
  }

  /**
   * Where the route's host key stands: pinned, pinned now from a key the person
   * already trusts, first contact, or changed. A key is captured without
   * signing in; a changed key is never replaced here.
   */
  checkHostKey(
    route: Route,
  ): Promise<HostKeyCheck | Failed | NotSupportedHere | AppFilesUnsafe | StaleRoute> {
    if (!this.current(route)) return Promise.resolve(STALE);
    return this.track(guardedAsync(() => this.checkHostKeyInner(route)));
  }

  /** After the host's confirmation: pins exactly the bytes captured at first contact. */
  trustCapturedKey(route: Route, captureId: string): PinResult | AppFilesUnsafe | StaleRoute {
    if (!this.current(route)) return STALE;
    return guarded(() => this.trustInner(route, captureId));
  }

  /** After the host's confirmation with its checkbox: replaces a changed key by the one captured. */
  replaceTrustedKey(route: Route, captureId: string): PinResult | AppFilesUnsafe | StaleRoute {
    if (!this.current(route)) return STALE;
    return guarded(() => this.replaceInner(route, captureId));
  }

  /** Runs the LOOK script through the pinned connection, and returns its facts. */
  look(
    route: Route,
    options: { signal?: AbortSignal } = {},
  ): Promise<LookResult | AppFilesUnsafe | StaleRoute> {
    if (!this.current(route)) return Promise.resolve(STALE);
    return this.track(guardedAsync(() => this.lookInner(route, options)));
  }

  /**
   * Forgets a route by its id alone, as a saved record names it: its pins and
   * files, whatever preparation made them. Its forward must be closed first.
   */
  forgetId(routeId: string): { ok: true } | AppFilesUnsafe | RouteForwardOpen {
    if (!isRouteId(routeId)) throw new Error("Not a route id.");
    if (this.forwards.has(routeId)) return { ok: false, kind: "forward-open" };
    return guarded(() => {
      const prefix = `clawtrate-route-${routeId}-`;
      this.known.removeWhere((alias) => alias.startsWith(prefix));
      this.removeConfigs(routeId, null);
      this.routes.delete(routeId);
      return { ok: true } as const;
    });
  }

  /** Forgets the route: its pin and its files. Its forwards must be closed first. */
  forget(route: Route): { ok: true } | AppFilesUnsafe | StaleRoute | RouteForwardOpen {
    if (!this.current(route)) return STALE;
    if (this.forwards.has(route.id)) return { ok: false, kind: "forward-open" };
    return guarded(() => {
      this.forgetInner(route);
      return { ok: true } as const;
    });
  }

  /** Closes every forward and ends every process this transport started. */
  async closeAll(): Promise<void> {
    const shutdown = this.stopAll;
    const forwards = [...this.forwards.values()].map((open) => open.forward);
    shutdown.abort();
    await Promise.all(forwards.map((forward) => forward.close()));
    let seen: Promise<unknown>;
    do {
      seen = this.inflight;
      await seen;
    } while (seen !== this.inflight);
    await this.processes.endAll();
    if (this.stopAll === shutdown) this.stopAll = new AbortController();
  }

  /** The signal a run stops on: the caller's, or `closeAll`. */
  private signal(other?: AbortSignal): AbortSignal {
    return other ? AbortSignal.any([other, this.stopAll.signal]) : this.stopAll.signal;
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.inflight = Promise.allSettled([this.inflight, work]);
    return work;
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/** An app SSH file is a link, another account's, or not a plain file: nothing was done with it. */
export type AppFilesUnsafe = { ok: false; kind: "app-files-unsafe" };
const APP_FILES_UNSAFE: AppFilesUnsafe = { ok: false, kind: "app-files-unsafe" };

function guarded<T>(run: () => T): T | AppFilesUnsafe {
  try {
    return run();
  } catch (error) {
    if (error instanceof UnsafeAppFile) return APP_FILES_UNSAFE;
    throw error;
  }
}

async function guardedAsync<T>(run: () => Promise<T>): Promise<T | AppFilesUnsafe> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof UnsafeAppFile) return APP_FILES_UNSAFE;
    throw error;
  }
}

/** What a finished run that didn't do its job says, as a failure. */
function runFailure(run: RunResult): SshFailure {
  if (run.spawnFailed) return { kind: "spawn-failed" };
  if (run.timedOut) return { kind: "timed-out" };
  return classifySshFailure(run.stderr, run.exit);
}

/** The longest local socket path: `sun_path` is 104 bytes on macOS, with its terminating zero. */
export const MAX_SOCKET_PATH = 103;

/** A forward's local socket in the private SSH folder: `f<12 hex>.s`. */
export const socketPathIn = (appDir: string, name: string) => join(appDir, `f${name}.s`);

const isSocketPathIn = (appDir: string, path: string) =>
  path.startsWith(join(appDir, "f")) && /^f[0-9a-f]{12}\.s$/.test(path.slice(appDir.length + 1));
