import type { BridgeCommand, ConnectionState } from "@clawtrate/core";
import { addressWords } from "./presentation/gateway-state.ts";

export function addressAttemptInProgress(connection: ConnectionState): boolean {
  return (
    (connection.status === "connecting" || connection.status === "reconnecting") &&
    connection.retryAt === null
  );
}

export function addressSubmission(
  saved: string | null,
  field: string,
  token: string,
): Extract<BridgeCommand, { type: "connect" | "retry" }> | null {
  const url = field.trim();
  if (url === "") return null;
  if (saved && url === addressWords(saved))
    return token ? { type: "connect", url: saved, token } : { type: "retry" };
  return { type: "connect", url, token: token || null };
}
