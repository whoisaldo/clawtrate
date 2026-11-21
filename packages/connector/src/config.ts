// The connector's settings and keys, in its state folder.

import { ed25519 } from "@noble/curves/ed25519.js";
import {
  canonicalRelayOrigin,
  fromBase64Url,
  generateKeyPair,
  keyPairFromSecret,
  relayIdFromKey,
  secureRandomBytes,
  toBase64Url,
  type KeyPair,
} from "@clawtrate/relay-protocol";
import { objectWithKeys, StateError, stringField, versionOne, type StateDir } from "./state.ts";

export const CONFIG_FILE = "connector.json";
export const KEYS_FILE = "keys.json";

export interface ConnectorConfig {
  /** The relay's canonical origin, `wss://host[:port]` (or `ws://` on loopback, for tests). */
  readonly relayOrigin: string;
  /** The gateway's port on 127.0.0.1. The connector connects nowhere else. */
  readonly gatewayPort: number;
  /** How to run OpenClaw's command line on this computer, for `qr` and `config`. */
  readonly openclaw: { readonly bin: string; readonly profile: string | null };
}

export interface ConnectorKeys {
  /** The Ed25519 key the relay id is derived from; used only for the register proof. */
  readonly registrationSecret: Uint8Array;
  /** The Noise static key; its public half goes in every pairing code. */
  readonly noise: KeyPair;
  readonly relayId: string;
}

/** `ws:` is accepted only for a relay on this machine. */
export function relayOriginOptions(origin: string): { allowLoopbackWs: boolean } {
  return { allowLoopbackWs: origin.startsWith("ws:") };
}

export function canonicalOrigin(origin: string): string {
  return canonicalRelayOrigin(origin, relayOriginOptions(origin));
}

export function checkGatewayPort(port: unknown): number {
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("the gateway port is not a port");
  }
  return port;
}

/** A plain profile name, as `openclaw --profile` takes it. */
const PROFILE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function parseConfig(value: unknown): ConnectorConfig {
  const record = objectWithKeys(value, ["v", "relayOrigin", "gatewayPort", "openclaw"]);
  versionOne(record);
  const relayOrigin = stringField(record, "relayOrigin");
  if (canonicalOrigin(relayOrigin) !== relayOrigin) throw new Error("relayOrigin is not canonical");
  const openclaw = objectWithKeys(record.openclaw, ["bin", "profile"]);
  const bin = stringField(openclaw, "bin");
  if (bin.length === 0) throw new Error("openclaw.bin is empty");
  const profile = openclaw.profile;
  if (profile !== null && (typeof profile !== "string" || !PROFILE.test(profile))) {
    throw new Error("openclaw.profile is not a profile name");
  }
  return {
    relayOrigin,
    gatewayPort: checkGatewayPort(record.gatewayPort),
    openclaw: { bin, profile },
  };
}

export function serializeConfig(config: ConnectorConfig): unknown {
  return { v: 1, ...config };
}

export function parseKeys(value: unknown): ConnectorKeys {
  const record = objectWithKeys(value, ["v", "registrationKey", "noiseKey"]);
  versionOne(record);
  const registration = key32(stringField(record, "registrationKey"), "registrationKey");
  const noise = keyPairFromSecret(key32(stringField(record, "noiseKey"), "noiseKey"));
  return {
    registrationSecret: registration,
    noise,
    relayId: relayIdFromKey(ed25519.getPublicKey(registration)),
  };
}

function key32(text: string, what: string): Uint8Array {
  const bytes = fromBase64Url(text);
  if (bytes === null || bytes.length !== 32) throw new Error(`${what} is not a 32-byte key`);
  return bytes;
}

/** New keys: an Ed25519 registration key and an X25519 Noise static key. */
export function newKeys(): unknown {
  return {
    v: 1,
    registrationKey: toBase64Url(secureRandomBytes(32)),
    noiseKey: toBase64Url(generateKeyPair().secretKey),
  };
}

export function loadConfig(state: StateDir): ConnectorConfig {
  const config = state.read(CONFIG_FILE, parseConfig);
  if (config === null)
    throw new StateError("not_set_up", `${state.path} has no settings. Run setup first.`);
  return config;
}

export function loadKeys(state: StateDir): ConnectorKeys {
  const keys = state.read(KEYS_FILE, parseKeys);
  if (keys === null)
    throw new StateError("not_set_up", `${state.path} has no keys. Run setup first.`);
  return keys;
}

/** The dial address a phone uses for this connector, which the OpenClaw setup code must carry. */
export function dialUrl(relayOrigin: string, relayId: string): string {
  return `${relayOrigin}/v1/dial/${relayId}`;
}
