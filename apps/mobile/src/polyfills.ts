// What the official gateway client expects of its JavaScript engine that React
// Native's does not provide on its own, given from Expo's native modules. Core
// is unchanged: these are the platform's part, set before anything else loads.

import { getRandomValues, randomUUID } from "expo-crypto";

type CryptoLike = { getRandomValues?: unknown; randomUUID?: unknown };
const scope = globalThis as unknown as { crypto?: CryptoLike };

// Request ids: the client refuses to make them without a cryptographic source.
scope.crypto ??= {};
scope.crypto.getRandomValues ??= getRandomValues;
scope.crypto.randomUUID ??= randomUUID;

// The reconnect scheduler combines its own abort signal with a caller's.
type Signal = {
  aborted: boolean;
  reason?: unknown;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
};
const Abort = globalThis as unknown as {
  AbortController?: new () => { signal: Signal; abort(reason?: unknown): void };
  AbortSignal?: { any?: (signals: Signal[]) => Signal };
};
if (Abort.AbortSignal && Abort.AbortController && typeof Abort.AbortSignal.any !== "function") {
  const Controller = Abort.AbortController;
  Abort.AbortSignal.any = (signals) => {
    const controller = new Controller();
    for (const signal of signals) {
      if (signal.aborted) {
        controller.abort(signal.reason);
        break;
      }
      signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
    }
    return controller.signal;
  };
}
