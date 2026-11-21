// Core's key/value store on iOS: one Keychain item per key (see keychain.ts).

import type { KeyValueStore } from "@clawtrate/core";
import { itemName, STATE_SERVICE, type SecureStoreLike } from "./keychain.ts";

export function createKeychainStore(keychain: SecureStoreLike, accessible: number): KeyValueStore {
  const options = { keychainService: STATE_SERVICE, keychainAccessible: accessible };
  return {
    get: (key) => keychain.getItemAsync(itemName(key), options),
    set: (key, value) => keychain.setItemAsync(itemName(key), value, options),
    delete: (key) => keychain.deleteItemAsync(itemName(key), options),
  };
}
