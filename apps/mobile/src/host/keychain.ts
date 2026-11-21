// The iOS Keychain, as the host uses it. Every value core stores holds a
// credential (the gateway's bootstrap token in the saved connection, the device
// tokens), and the device's private key is one too, so all of it lives in the
// Keychain, never in a file or plain storage. Each value is one generic-password
// item, readable only while the device is unlocked and never synced or restored
// to another device (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`).
//
// The expo-secure-store calls are passed in, so the store and the signer run in
// Node's unit tests against a fake Keychain.

import { toBase64, utf8Bytes } from "@clawtrate/core";

/** The expo-secure-store options this host passes. */
export type KeychainOptions = { keychainService: string; keychainAccessible: number };

/** The part of expo-secure-store the host uses. */
export type SecureStoreLike = {
  getItemAsync(key: string, options: KeychainOptions): Promise<string | null>;
  setItemAsync(key: string, value: string, options: KeychainOptions): Promise<void>;
  deleteItemAsync(key: string, options: KeychainOptions): Promise<void>;
};

/** Keychain services: one for what core stores, one for the device key. */
export const STATE_SERVICE = "dev.clawtrate.mobile.state";
export const DEVICE_SERVICE = "dev.clawtrate.mobile.device";

/**
 * A Keychain item name for a core key. Core's keys hold `:` and `%` (a device
 * token's key names the gateway's address), and a Keychain item name here may
 * hold only letters, digits, `.`, `-` and `_`, so the key is base64url encoded.
 */
export function itemName(key: string): string {
  return `k.${toBase64(utf8Bytes(key)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}
