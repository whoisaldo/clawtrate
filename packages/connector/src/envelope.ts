// The relay pairing code `pair-phone` prints, in the form core's parser reads (the relay route,
// #270): base64url, unpadded, of one flat JSON object, with its members in this order:
//
//   { "v": 1, "relay": <canonical relay origin>, "relayId": <26 chars>,
//     "connectorKey": <Noise static public key, 43 chars>, "enroll": <32-byte secret, 43 chars>,
//     "expiresAtMs": <when the secret expires>, "openclaw": <OpenClaw setup code> }
//
// The OpenClaw setup code is the gateway's own, made by `openclaw qr --url <dial address>`:
// base64url JSON with exactly `url`, `bootstrapToken` and `expiresAtMs`, whose `url` must be
// this connector's dial address. It is checked before a code is made from it.

import { fromBase64Url, toBase64Url } from "@clawtrate/relay-protocol";

export const RELAY_CODE_VERSION = 1;
/** The longest pairing code core reads, and the longest setup code inside one. */
export const MAX_RELAY_CODE_CHARS = 4096;
export const MAX_SETUP_CODE_CHARS = 2048;
/** An enrollment secret lasts no longer than this, nor longer than the setup code. */
export const MAX_OFFER_MS = 10 * 60 * 1000;

export interface RelayCodeFields {
  readonly relayOrigin: string;
  readonly relayId: string;
  /** base64url of the Noise static public key. */
  readonly connectorKey: string;
  readonly enroll: Uint8Array;
  readonly expiresAtMs: number;
  readonly setupCode: string;
}

export function encodeRelayCode(fields: RelayCodeFields): string {
  const json = JSON.stringify({
    v: RELAY_CODE_VERSION,
    relay: fields.relayOrigin,
    relayId: fields.relayId,
    connectorKey: fields.connectorKey,
    enroll: toBase64Url(fields.enroll),
    expiresAtMs: fields.expiresAtMs,
    openclaw: fields.setupCode,
  });
  const code = toBase64Url(new TextEncoder().encode(json));
  if (code.length > MAX_RELAY_CODE_CHARS) throw new Error("The pairing code would be too long.");
  return code;
}

export interface SetupCode {
  readonly url: string;
  readonly expiresAtMs: number;
}

/**
 * Checks an OpenClaw setup code before it goes into a pairing code: exactly the three fields,
 * the dial address as its `url`, a token, and an expiry still ahead.
 */
export function checkSetupCode(setupCode: unknown, dialUrl: string, nowMs: number): SetupCode {
  if (typeof setupCode !== "string" || setupCode.length > MAX_SETUP_CODE_CHARS) {
    throw new Error("OpenClaw's setup code is missing or too long.");
  }
  const bytes = fromBase64Url(setupCode);
  if (bytes === null) throw new Error("OpenClaw's setup code is not base64url.");
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("OpenClaw's setup code is not JSON.");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("OpenClaw's setup code is not an object.");
  }
  const keys = Object.keys(payload).sort().join(",");
  if (keys !== "bootstrapToken,expiresAtMs,url") {
    throw new Error(
      `OpenClaw's setup code has the fields ${keys}; a relay code takes url, bootstrapToken and expiresAtMs.`,
    );
  }
  const { url, bootstrapToken, expiresAtMs } = payload as Record<string, unknown>;
  if (url !== dialUrl)
    throw new Error("OpenClaw's setup code is for another address than this connector's.");
  if (typeof bootstrapToken !== "string" || !/^[\x21-\x7e]{1,512}$/.test(bootstrapToken)) {
    throw new Error("OpenClaw's setup code has no usable bootstrap token.");
  }
  if (
    typeof expiresAtMs !== "number" ||
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= nowMs
  ) {
    throw new Error("OpenClaw's setup code has already expired.");
  }
  return { url, expiresAtMs };
}
