// What a host process provides to the core. Core itself uses no DOM and no
// Node APIs, so the same code runs in Electron's main process, plain Node and Expo.

import type { ReadBack, ReadBackRequest } from "./approval.ts";

/**
 * Async key/value persistence. Values are strings; core stores JSON. `set` and
 * `delete` resolve only once the change is kept; a change that could not be kept
 * rejects, and `get` goes on returning what was kept before.
 */
export type KeyValueStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
};

/**
 * The device's Ed25519 identity. The host keeps the private key; core only asks
 * for signatures. `deviceId` is the hex SHA-256 of the raw 32-byte public key and
 * `publicKey` is that raw key in base64url, as the gateway expects.
 */
export type DeviceSigner = {
  loadIdentity(): Promise<{ deviceId: string; publicKey: string }>;
  /** Ed25519 signature of the UTF-8 payload, base64url encoded. */
  sign(payload: string): Promise<string>;
};

/** The subset of the WHATWG WebSocket that core uses. Browsers, Node 22+ and React Native all provide it. */
export type WebSocketLike = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

export type WebSocketFactory = (url: string) => WebSocketLike;

export type ClientIdentity = {
  /** Shown to the gateway operator when approving the device, for example "Clawtrate Desktop". */
  displayName: string;
  version: string;
  /** Runtime platform such as `darwin`, `linux`, `win32`, `ios` or `web`. */
  platform: string;
};

export type ApprovalInstructions = {
  command: string;
  note: string | null;
  /** The waiting line's head, naming where the request waits (setup §9): "Waiting for approval on devbox." */
  title?: string | null;
  /** The computer the request waits on, as the words name it: "devbox", "this computer". */
  where?: string | null;
};

export type ClawtrateHost = {
  createWebSocket: WebSocketFactory;
  storage: KeyValueStore;
  signer: DeviceSigner;
  client: ClientIdentity;
  now?: () => number;
  randomId?: () => string;
  log?: (level: "debug" | "info" | "warn" | "error", message: string) => void;
  /**
   * How to approve a pairing request on this gateway. The host knows whether the
   * gateway is the local development one; core falls back to the generic command.
   */
  approvalInstructions?: (
    gatewayUrl: string,
    requestId: string,
    /** The profile the host's look found this connection's gateway for on this computer, as kept with it. */
    here?: { profile: "default" | "clawtrate" } | null,
    /** The connection is an explicit address the person typed or pasted: no place is named for it. */
    address?: boolean,
  ) => ApprovalInstructions;
  /**
   * Where the host has a shell on the gateway's computer (this computer, an
   * SSH route): establish the endpoint and its version for the route's
   * profile again, read the gateway's identity there and, only when it is
   * `expected`, its device list, at the verified loopback endpoint, through
   * the gateway (setup §9). A null answer: the host has no shell for this
   * address. Only an explicit address route may have none; for any other,
   * the client takes it as an identity it couldn't read. Reads only: it never
   * changes the gateway.
   */
  readBack?: (gatewayUrl: string, request: ReadBackRequest) => Promise<ReadBack | null>;
};
