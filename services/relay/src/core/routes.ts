// The relay's URL paths. Anything else is not found.

import { isRelayId, isSessionId, PROTOCOL_VERSION } from "@clawtrate/relay-protocol";

export type Route =
  | { readonly role: "control"; readonly relayId: string }
  | { readonly role: "dial"; readonly relayId: string }
  | { readonly role: "session"; readonly relayId: string; readonly session: string };

export const HEALTH_PATH = "/health";

/** The health answer: no state, no counts, nothing about any relay id. */
export const HEALTH_BODY = JSON.stringify({ ok: true, protocol: PROTOCOL_VERSION });

export type RequestPlan =
  | { readonly kind: "health" }
  | { readonly kind: "socket"; readonly route: Route }
  | { readonly kind: "refuse"; readonly status: 404 | 405 | 426 };

/** What an HTTP request to the relay gets, from its method, path and Upgrade header. */
export function planRequest(
  method: string,
  pathname: string,
  upgrade: string | null | undefined,
): RequestPlan {
  if (pathname === HEALTH_PATH) {
    return method === "GET" || method === "HEAD"
      ? { kind: "health" }
      : { kind: "refuse", status: 405 };
  }
  const route = parseRoute(pathname);
  if (route === null) return { kind: "refuse", status: 404 };
  if (method !== "GET") return { kind: "refuse", status: 405 };
  if (upgrade?.toLowerCase() !== "websocket") return { kind: "refuse", status: 426 };
  return { kind: "socket", route };
}

/**
 * `/v1/connector/<relayId>`, `/v1/dial/<relayId>` or `/v1/session/<relayId>/<session>`, with
 * exactly the spellings the protocol produces; null for anything else.
 */
export function parseRoute(pathname: string): Route | null {
  const parts = pathname.split("/");
  if (parts[0] !== "" || parts[1] !== "v1") return null;
  const [, , kind, relayId, session, ...rest] = parts;
  if (!isRelayId(relayId) || rest.length > 0) return null;
  if (kind === "connector" && session === undefined) return { role: "control", relayId };
  if (kind === "dial" && session === undefined) return { role: "dial", relayId };
  if (kind === "session" && isSessionId(session)) return { role: "session", relayId, session };
  return null;
}
