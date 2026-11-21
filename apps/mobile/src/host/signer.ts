// The device's Ed25519 identity on iOS. The 32-byte private key is generated on
// the device from the system's random source the first time it is needed and
// kept in the Keychain (see keychain.ts); signing runs in JavaScript with
// @noble/curves. The key is never written anywhere else and never logged.

import { ed25519 } from "@noble/curves/ed25519.js";
import { fromBase64, sha256Hex, toBase64, utf8Bytes, type DeviceSigner } from "@clawtrate/core";
import { DEVICE_SERVICE, type SecureStoreLike } from "./keychain.ts";

/** The Keychain item that holds the private key, base64. */
export const DEVICE_KEY_ITEM = "device-key";

const base64url = (bytes: Uint8Array) =>
  toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function createKeychainSigner(
  keychain: SecureStoreLike,
  accessible: number,
  /** The system's cryptographic random source. */
  randomBytes: (count: number) => Uint8Array,
): DeviceSigner {
  const options = { keychainService: DEVICE_SERVICE, keychainAccessible: accessible };
  let loaded: Promise<{ secretKey: Uint8Array; deviceId: string; publicKey: string }> | null = null;

  const load = () =>
    (loaded ??= (async () => {
      const saved = await keychain.getItemAsync(DEVICE_KEY_ITEM, options);
      let secretKey: Uint8Array;
      if (saved === null) {
        // Only an absent key is made anew. A read that fails (a locked device)
        // rejects, and the identity the gateway knows is kept.
        secretKey = randomBytes(32);
        if (secretKey.length !== 32) throw new Error("the random source gave the wrong length");
        await keychain.setItemAsync(DEVICE_KEY_ITEM, toBase64(secretKey), options);
      } else {
        const decoded = fromBase64(saved);
        if (!decoded || decoded.length !== 32)
          throw new Error("the device key in the Keychain is unreadable");
        secretKey = decoded;
      }
      const raw = ed25519.getPublicKey(secretKey);
      return { secretKey, deviceId: sha256Hex(raw), publicKey: base64url(raw) };
    })().catch((error: unknown) => {
      // A failed load is tried again next time rather than kept.
      loaded = null;
      throw error;
    }));

  return {
    async loadIdentity() {
      const { deviceId, publicKey } = await load();
      return { deviceId, publicKey };
    },
    async sign(payload) {
      const { secretKey } = await load();
      return base64url(ed25519.sign(utf8Bytes(payload), secretKey));
    },
  };
}
