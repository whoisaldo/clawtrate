// The iOS host: what `packages/core/src/host.ts` asks for, from React Native
// and Expo's native modules. The same core runs here as in Electron and Node.

import type { ClawtrateHost } from "@clawtrate/core";
import { getRandomBytes, randomUUID } from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { Settings } from "react-native";
import { approvalInstructionsFor, devGatewayHint, type DevGatewayHint } from "./dev-gateway.ts";
import { createSocketFactory, type WebSocketConstructor } from "./socket.ts";
import { createKeychainSigner } from "./signer.ts";
import { createKeychainStore } from "./store.ts";
import { createSecrets, learningStore, type Secrets } from "./secrets.ts";

export const APP_VERSION = "0.1.0";
/** The name this device gives the gateway when it pairs. */
export const DEVICE_NAME = "Clawtrate iPhone";

/**
 * A mark in the app's user defaults, which iOS deletes with the app; the
 * Keychain is not deleted with it. A saved gateway found without the mark was
 * saved by an earlier install, so the app asks before it reconnects to it.
 */
export const INSTALL_MARK = "ClawtrateInstalled";

export type IosHost = {
  host: ClawtrateHost;
  devGateway: DevGatewayHint | null;
  secrets: Secrets;
  /** This install has run before: a saved gateway is its own choice. */
  installedBefore: boolean;
  markInstalled: () => void;
};

export function createIosHost(): IosHost {
  const accessible = SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY;
  const devGateway = devGatewayHint((key) => Settings.get(key));
  const secrets = createSecrets();
  return {
    devGateway,
    secrets,
    installedBefore: Settings.get(INSTALL_MARK) === "1",
    markInstalled: () => Settings.set({ [INSTALL_MARK]: "1" }),
    host: {
      createWebSocket: createSocketFactory(WebSocket as unknown as WebSocketConstructor),
      storage: learningStore(createKeychainStore(SecureStore, accessible), secrets),
      signer: createKeychainSigner(SecureStore, accessible, getRandomBytes),
      client: { displayName: DEVICE_NAME, version: APP_VERSION, platform: "ios" },
      randomId: randomUUID,
      approvalInstructions: approvalInstructionsFor(devGateway),
      log: (level, message) => {
        // Only problems reach the console, and never a credential the gateway sent back.
        if (level === "warn" || level === "error")
          console[level](`[core] ${secrets.redact(message)}`);
      },
    },
  };
}
