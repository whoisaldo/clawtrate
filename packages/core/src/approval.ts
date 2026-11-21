// What Clawtrate keeps after the gateway's owner approves a request
// (docs/design/setup.md §9, "After the person approves"): the checks of what
// the host read back on the gateway's computer, and the fixed words of each
// outcome. Pure: the host reads, the client decides, the interface shows.

/** The client id and mode every Clawtrate connection reports (`CLIENT_ID`, `CLIENT_MODE` in `client.ts`). */
const CLIENT_ID = "gateway-client";
const CLIENT_MODE = "ui";

/** The gateway's identity at the verified endpoint (`gateway call gateway.identity.get`). */
export type GatewayIdentityRead = { deviceId: string; publicKey: string };

/**
 * What the host read on the gateway's computer, at the verified loopback
 * endpoint, through the gateway (`gateway call … --expect-url`): its identity,
 * then its device list. A read that failed names its step, and OpenClaw's exit
 * code only when the host recorded one. `identity` fails when the endpoint,
 * its version or the identity itself couldn't be established; `list` carries
 * the identity that was read, so a different gateway is told apart from a
 * list that couldn't be read. The host issues the list only once the identity
 * is the expected one.
 */
export type ReadBack =
  | { ok: true; identity: GatewayIdentityRead; list: unknown }
  | { ok: false; step: "identity"; exitCode: number | null }
  | { ok: false; step: "list"; exitCode: number | null; identity: GatewayIdentityRead };

/**
 * Where the host is asked to read back (setup §9): the gateway identity this
 * connection established before the approval, which the endpoint must still
 * return before the list is read, and, for a connection the host's look found
 * on this computer, the profile it found it for, kept with the connection.
 */
export type ReadBackRequest = {
  expected: string | null;
  here: { profile: "default" | "clawtrate" } | null;
};

/** The device this client is, and what it means to hold after the approval. */
export type ReadBackDevice = { deviceId: string; publicKey: string; scopes: readonly string[] };

/** The same scopes, in any order, with no repeats on either side. */
export function sameScopes(a: readonly unknown[], b: readonly string[]): boolean {
  const left = new Set(a);
  return (
    left.size === a.length &&
    new Set(b).size === b.length &&
    left.size === b.length &&
    b.every((scope) => left.has(scope))
  );
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : null;

/** The `pending` and `paired` lists of `device.pair.list`, or null when it isn't that shape. */
function lists(list: unknown): { pending: unknown[]; paired: unknown[] } | null {
  const body = record(list);
  if (!body || !Array.isArray(body.pending) || !Array.isArray(body.paired)) return null;
  return { pending: body.pending, paired: body.paired };
}

/** The operator role alone, as the entry reports it in `role` and, when present, `roles`. */
function operatorAlone(entry: Record<string, unknown>): boolean {
  if (entry.role !== "operator") return false;
  if (entry.roles === undefined) return true;
  const roles = strings(entry.roles);
  return roles !== null && roles.length === 1 && roles[0] === "operator";
}

/** The request's reported client and mode are Clawtrate's own. */
const ourClient = (entry: Record<string, unknown>) =>
  entry.clientId === CLIENT_ID && entry.clientMode === CLIENT_MODE;

/**
 * This device's paired record after an approval, as `device.pair.list`
 * reports it: exactly one record for this device id, with this public key,
 * Clawtrate's reported client and mode, the operator role alone, and both its
 * scopes and its one operator token's scopes exactly the expected set.
 * Anything else, or a list of another shape, is a mismatch.
 */
export function checkPairedRecord(list: unknown, device: ReadBackDevice): "exact" | "mismatch" {
  const body = lists(list);
  if (!body) return "mismatch";
  const mine = body.paired.map(record).filter((entry) => entry?.deviceId === device.deviceId);
  if (mine.length !== 1) return "mismatch";
  const entry = mine[0]!;
  if (entry.publicKey !== device.publicKey || !ourClient(entry) || !operatorAlone(entry))
    return "mismatch";
  const scopes = strings(entry.scopes);
  if (!scopes || !sameScopes(scopes, device.scopes)) return "mismatch";
  // Summaries only: the list never carries a token itself. One operator token, nothing for another role.
  const tokens = Array.isArray(entry.tokens) ? entry.tokens.map(record) : null;
  if (!tokens || tokens.length !== 1) return "mismatch";
  const token = tokens[0];
  const tokenScopes = strings(token?.scopes);
  if (!token || token.role !== "operator" || !tokenScopes) return "mismatch";
  return sameScopes(tokenScopes, device.scopes) ? "exact" : "mismatch";
}

/**
 * The gateway's pending list for the request this client holds:
 * `waiting` when the list holds exactly that request id for this device and
 * key, Clawtrate's client, the operator role alone and exactly the asked
 * scopes, and no other pending entry for this device; `other` when it holds a
 * pending entry for this device that isn't that; `absent` when it holds
 * nothing for this device. A list of another shape is `unreadable`.
 */
export function checkPending(
  list: unknown,
  device: ReadBackDevice & { requestId: string },
): "waiting" | "other" | "absent" | "unreadable" {
  const body = lists(list);
  if (!body) return "unreadable";
  const mine = body.pending.map(record).filter((entry) => entry?.deviceId === device.deviceId);
  if (mine.length === 0) return "absent";
  if (mine.length > 1) return "other";
  const entry = mine[0]!;
  const scopes = strings(entry.scopes);
  return entry.requestId === device.requestId &&
    entry.publicKey === device.publicKey &&
    ourClient(entry) &&
    operatorAlone(entry) &&
    scopes !== null &&
    sameScopes(scopes, device.scopes)
    ? "waiting"
    : "other";
}

/**
 * The identity the host read against the one the route established: `same`,
 * `other` for a different gateway's, `unread` when there was no identity to
 * compare with or the read gave none.
 */
export function checkIdentity(
  read: GatewayIdentityRead | null,
  expected: string | null,
): "same" | "other" | "unread" {
  if (!read || typeof read.deviceId !== "string" || read.deviceId === "" || !expected)
    return "unread";
  return read.deviceId === expected ? "same" : "other";
}

/**
 * The outcomes of a request after the owner approved it or Clawtrate looked
 * again, each in the design's fixed words (§9, "Outcomes").
 */
export const APPROVAL_WORDS = {
  /** The record or the reconnect showed anything else, or couldn't be read. */
  unconfirmed: {
    title: "Clawtrate disconnected.",
    detail:
      "It couldn't confirm what this request granted. Review this device's access on the gateway before reconnecting.",
  },
  /** The request isn't pending any more, and the reconnect confirmed exactly the asked access. */
  nowShown: "The gateway now shows the requested access.",
  /** The request isn't pending, and the access isn't there; or stale can't be told from not yet listed. */
  stale: "Clawtrate couldn't find this request in the gateway's pending list.",
  /** A different pending request for this device: no command is shown for it. */
  otherRequest: "The gateway's pending request for this device isn't the one Clawtrate asked for.",
  /** The gateway's identity couldn't be read, or isn't one Clawtrate supports. */
  identityUnread: "Clawtrate couldn't confirm this gateway's identity or version.",
  /** The identity was read, and it is a different gateway's. */
  identityChanged: "This route now leads to a different gateway.",
} as const;

/**
 * Whether a connection error is one Clawtrate made itself after an approval it
 * couldn't confirm (setup §9): the gateway answered, and Clawtrate disconnected.
 */
export const isApprovalDisconnect = (code: string | null | undefined): boolean =>
  code === "APPROVAL_UNCONFIRMED" ||
  code === "APPROVAL_IDENTITY_CHANGED" ||
  code === "APPROVAL_IDENTITY_UNREAD";

/** "Couldn't read the gateway's requests on devbox.", with OpenClaw's exit code only when recorded. */
export function listUnreadWords(where: string | null, exitCode: number | null): string {
  const on = where ? ` on ${where}` : "";
  const exit = exitCode === null ? "" : ` OpenClaw exited with code ${exitCode}.`;
  return `Couldn't read the gateway's requests${on}.${exit}`;
}
