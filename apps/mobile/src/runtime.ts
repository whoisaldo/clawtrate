// Core runs in the app's own JavaScript runtime: one `ClawtrateClient` on the
// iOS host, and one bridge session, the app being its one viewer. Screens read
// the client's state, coalesced to one snapshot per 16 ms as the desktop's
// hosts do, and act only through the session's validated commands.

import {
  batchSnapshots,
  ClawtrateClient,
  createBridgeSession,
  type BridgeCommand,
  type BridgeResultFor,
  type BridgeSession,
  type ClawtrateState,
} from "@clawtrate/core";
import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import { createIosHost } from "./host/index.ts";
import type { DevGatewayHint } from "./host/dev-gateway.ts";

export type Runtime = {
  client: ClawtrateClient;
  session: BridgeSession;
  devGateway: DevGatewayHint | null;
  send: <C extends BridgeCommand>(command: C) => Promise<BridgeResultFor<C>>;
  /** Any credential this host holds, scrubbed from a string about to be shown. */
  redact: (text: string) => string;
};

let runtime: Runtime | null = null;

/**
 * The app's one client. The connection is read-only: this build has no
 * command that writes, so it pins the client to `operator.read` and never
 * asks for more (`readOnly`).
 */
export function startRuntime(): Runtime {
  if (runtime) return runtime;
  const { host, devGateway, secrets, installedBefore, markInstalled } = createIosHost();
  // A gateway saved by an earlier install of the app is kept, not reopened: the
  // welcome screen offers it as a choice.
  const client = new ClawtrateClient(host, { readOnly: true, resume: installedBefore });
  const session = createBridgeSession(client);
  runtime = {
    client,
    session,
    devGateway,
    send: async (command) => {
      const result = await session.apply(command);
      if (command.type === "connect" || command.type === "retry") markInstalled();
      return result;
    },
    redact: secrets.redact,
  };
  void client.start().catch((error: unknown) => {
    console.error(
      `[core] could not start: ${secrets.redact(error instanceof Error ? error.message : String(error))}`,
    );
  });
  return runtime;
}

export const RuntimeContext = createContext<Runtime | null>(null);

export function useRuntime(): Runtime {
  const value = useContext(RuntimeContext);
  if (!value) throw new Error("the app's runtime is not started");
  return value;
}

/** The client's state, one snapshot per 16 ms at most. */
export function useClawtrateState(): ClawtrateState {
  const { client } = useRuntime();
  const subscribe = useCallback(
    (changed: () => void) => batchSnapshots(client.store.subscribe, changed),
    [client],
  );
  return useSyncExternalStore(subscribe, client.store.get);
}
