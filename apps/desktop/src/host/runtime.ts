// The part of every Node host that is the same in Electron and the web host:
// one core client, the device's data directory, and development gateway detection.

import {
  approvalForPlace,
  AttachmentStore,
  ClawtrateClient,
  defaultApprovalInstructions,
  type ApprovalInstructions,
  type ApprovalPlace,
  type KeyValueStore,
  type ReadBack,
  type ReadBackRequest,
  type BridgePolicy,
  type HostInfo,
  type WebSocketLike,
} from "@clawtrate/core";
import { createNodeHost } from "@clawtrate/core/node";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { provenEndpoint } from "../../../../tools/dev-gateway/src/endpoint.ts";
import {
  DEFAULT_GATEWAY_URL,
  runDirFor,
  validateInstanceName,
} from "../../../../tools/dev-gateway/src/instance.ts";
import type { Identify } from "../../../../tools/dev-gateway/src/state-guard.ts";

export { selectInstance } from "../../../../tools/dev-gateway/src/instance.ts";

export const APP_VERSION = "0.1.0";

/** The default development instance's endpoint (`openclaw --dev`, loopback). */
export const DEV_GATEWAY_URL = DEFAULT_GATEWAY_URL;

export type DevGatewayConnection = {
  url: string;
  token: string;
  /** The dev-gateway instance; null is the default instance. */
  instance: string | null;
};

/** This checkout's run folder for an instance, where `pnpm dev-gateway start` writes its files. */
export function devRunDir(repoRoot: string, instance: string | null = null): string {
  return runDirFor(instance, join(repoRoot, "tools/dev-gateway/.run"));
}

/**
 * The selected development instance's connection, only when this checkout
 * started that instance and its gateway is running now: the instance's
 * marker, run id, checkout, port and live gateway process must all agree with
 * this checkout's run and connection files (`provenEndpoint`). Anything stale,
 * incomplete, linked or mismatched gives null.
 */
export function readDevConnection(
  repoRoot: string,
  options: { instance?: string | null; home?: string; identify?: Identify } = {},
): DevGatewayConnection | null {
  // The name is validated before any path is built from it.
  const instance = options.instance == null ? null : validateInstanceName(options.instance);
  let checkout: string;
  try {
    checkout = realpathSync(repoRoot);
  } catch {
    return null;
  }
  const proof = provenEndpoint({
    instance,
    home: options.home ?? homedir(),
    runDir: devRunDir(repoRoot, instance),
    checkout,
    ...(options.identify ? { identify: options.identify } : {}),
  });
  return "refusal" in proof ? null : proof;
}

/**
 * The approve command to show. Only the development gateway gets the dev
 * tooling's command. A gateway setup reached on this computer or over SSH gets
 * the command for its profile and the computer to run it on
 * (docs/design/setup.md §9), after a relaunch too, from the profile kept with
 * the connection; an address route keeps the general one, even where a setup
 * found a gateway at the same address.
 */
export function approvalInstructionsFor(
  devGateway: DevGatewayConnection | null,
  placeFor: (gatewayUrl: string) => ApprovalPlace | null = () => null,
): (
  gatewayUrl: string,
  requestId: string,
  here?: { profile: "default" | "clawtrate" } | null,
  address?: boolean,
) => ApprovalInstructions {
  return (gatewayUrl, requestId, here, address) => {
    if (devGateway && gatewayUrl === devGateway.url)
      return {
        command:
          devGateway.instance === null
            ? "pnpm dev-gateway approve"
            : `pnpm dev-gateway approve --instance ${devGateway.instance}`,
        note: null,
      };
    // An address the person typed is never given the words of a place a setup found there.
    const place = address
      ? null
      : (placeFor(gatewayUrl) ??
        (here ? ({ route: "this-computer", profile: here.profile } as const) : null));
    return place
      ? approvalForPlace(place, requestId)
      : defaultApprovalInstructions(gatewayUrl, requestId);
  };
}

export type HostRuntime = {
  client: ClawtrateClient;
  info: HostInfo;
  policy: BridgePolicy;
};

export class SavedGatewayRefusedError extends Error {
  constructor(url: string) {
    super(
      `This host only connects to the development gateway, but its data directory remembers ${url}. ` +
        "Use a separate --data-dir for the development gateway, or start with an access token.",
    );
    this.name = "SavedGatewayRefusedError";
  }
}

export async function startHostRuntime(options: {
  kind: HostInfo["kind"];
  displayName: string;
  dataDir: string;
  devGateway: DevGatewayConnection | null;
  /** Connect to the development gateway at startup when nothing else is saved. */
  autoConnectDev?: boolean;
  /**
   * Only ever connect to the development gateway. Saved, typed and retried
   * connections to any other gateway are refused, so token-free hosts cannot
   * resume another gateway.
   */
  devOnly?: boolean;
  /**
   * Proves the development gateway again; usually `readDevConnection` with the
   * same options. Required with a development gateway: its address is opened
   * only while this proof holds, checked by the client before every attempt,
   * including its own retries, so a port another process has taken over after
   * the gateway stopped is never reconnected to.
   */
  recheckDevGateway?: () => DevGatewayConnection | null;
  /**
   * Pin the connection to the read tier: the host asks for `operator.read`
   * alone, never asks for more access, and tells the interface so.
   */
  readOnly?: boolean;
  /**
   * Reopen the gateway the data folder remembers (the default). A development
   * build, an automated run and the web host's setup look pass false: they
   * never resume a saved gateway, whatever its address.
   */
  resume?: boolean;
  /** Where a gateway's owner approves a request, for setup's routes (`approvalInstructionsFor`). */
  approvalPlace?: (gatewayUrl: string) => ApprovalPlace | null;
  /** The read-back after an approval (setup §9), for setup's routes; null for any other address. */
  readBack?: (gatewayUrl: string, request: ReadBackRequest) => Promise<ReadBack | null>;
  /**
   * A route's word on an address before every socket: true or false for an
   * SSH forward's local address (only the current one, while it is up), null
   * for any other address, which the rules above decide.
   */
  routeAllows?: (gatewayUrl: string) => boolean | null;
  /** The host's own socket for a route's address (an SSH forward's channel), or null for any other. */
  routeSocket?: (gatewayUrl: string) => WebSocketLike | null;
  /** Reconnect after Disconnect on a routed connection: only the host can open its route again. */
  reopenRoute?: (route: string) => Promise<void>;
  /** Wraps the host's store: the desktop keeps route tokens in its route store. */
  wrapStorage?: (store: KeyValueStore) => KeyValueStore;
}): Promise<HostRuntime> {
  if (options.devOnly && !options.devGateway) {
    throw new Error(
      "Development-only mode needs the development gateway. Run `pnpm dev-gateway up`.",
    );
  }
  const dev = options.devGateway;
  if (dev && !options.recheckDevGateway) {
    throw new Error("a development gateway needs a way to prove it again before each connection");
  }
  const devGateway = dev ? { url: dev.url, token: dev.token } : null;
  const stillProven = () => {
    const proof = options.recheckDevGateway!();
    return proof !== null && proof.url === dev!.url && proof.token === dev!.token;
  };
  const client = new ClawtrateClient(
    createNodeHost({
      dataDir: options.dataDir,
      client: {
        displayName: options.displayName,
        version: APP_VERSION,
        platform: process.platform,
      },
      approvalInstructions: approvalInstructionsFor(
        options.devGateway,
        options.approvalPlace ?? (() => null),
      ),
      ...(options.wrapStorage ? { wrapStorage: options.wrapStorage } : {}),
      ...(options.routeSocket ? { routeSocket: options.routeSocket } : {}),
      ...(options.readBack ? { readBack: options.readBack } : {}),
      log: (level, message) => {
        if (level !== "debug") console[level === "info" ? "log" : level](`[core] ${message}`);
      },
    }),
    {
      allowGatewayUrl: (url) => {
        const routed = options.routeAllows?.(url) ?? null;
        if (routed !== null) return routed && !options.devOnly;
        if (dev && url === dev.url) return stillProven();
        // Other gateways the user chose deliberately, unless this host is development-only.
        return !options.devOnly;
      },
      ...(options.readOnly ? { readOnly: true } : {}),
      ...(options.reopenRoute ? { reopenRoute: options.reopenRoute } : {}),
    },
  );
  const devOnly = options.devOnly ? dev : null;
  if (devOnly) {
    const saved = await client.savedSettings();
    if (saved && saved.url !== devOnly.url) throw new SavedGatewayRefusedError(saved.url);
  }
  await client.start({ resume: options.resume !== false });
  if (options.autoConnectDev && devGateway && client.state.connection.status === "idle") {
    await client.connect(devGateway);
  }
  return {
    client,
    info: {
      kind: options.kind,
      version: APP_VERSION,
      deviceName: options.displayName,
      // How a command reaches that instance on its machine, for the commands the app shows.
      devGateway: dev
        ? {
            url: dev.url,
            cli:
              dev.instance === null
                ? "openclaw --dev"
                : `openclaw --profile clawtrate-dev-${dev.instance}`,
          }
        : null,
      ...(options.readOnly ? { readOnly: true } : {}),
    },
    // Files viewers add before sending, held in this process until a message takes them.
    policy: {
      devGateway,
      attachments: new AttachmentStore({ newId: randomUUID }),
    },
  };
}
