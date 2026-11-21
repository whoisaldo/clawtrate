import { sha256 } from "@noble/hashes/sha2.js";
import { toBase32 } from "./bytes.ts";
import { fail } from "./errors.ts";

/** The relay id is the first 16 bytes of SHA-256 over the connector's Ed25519 public key. */
const RELAY_ID_HASH_BYTES = 16;

/**
 * Names a connector at the relay: lowercase base32 of the first 16 bytes of SHA-256 over its
 * Ed25519 registration key, 26 characters. Only the holder of that key can register the id,
 * so the first key to claim an id is the only one that ever can.
 */
export function relayIdFromKey(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) fail("bad_key", "An Ed25519 public key is 32 bytes.");
  return toBase32(sha256(publicKey).subarray(0, RELAY_ID_HASH_BYTES));
}

/**
 * True for the one spelling `relayIdFromKey` produces: 26 characters of lowercase base32, whose
 * last character carries 3 data bits and 2 zero bits.
 */
export function isRelayId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z2-7]{25}[aeimquy4]$/.test(value);
}
