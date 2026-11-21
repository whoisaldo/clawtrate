// The relay's own text messages. Binary WebSocket messages carry end-to-end frames
// (`frames.ts`); text messages are between the relay and one endpoint, and are JSON objects
// with a type `t`. Each decoder accepts only what that direction may carry.
//
//   Control socket, connector at /v1/connector/<relayId>:
//     relay -> connector  challenge, registered, dial, error, ping, pong
//     connector -> relay  register, ping, pong
//   Dial socket (phone at /v1/dial/<relayId>) and session socket
//   (connector at /v1/session/<relayId>/<session>):
//     relay -> endpoint   open, error, ping, pong
//     endpoint -> relay   ping, pong

import {
  fromBase64UrlOfLength,
  secureRandomBytes,
  toBase64Url,
  utf8Encode,
  type RandomBytes,
} from "./bytes.ts";
import { fail } from "./errors.ts";
import { readFlatObject, type FlatValue } from "./json.ts";
import { MAX_REGISTER_PROOF_CHARS, MAX_RELAY_MESSAGE_BYTES } from "./limits.ts";

/** The exact keep-alive texts, so the relay can answer them without waking (Workers' auto-response). */
export const RELAY_PING = '{"t":"ping"}';
export const RELAY_PONG = '{"t":"pong"}';

export const REGISTER_NONCE_BYTES = 32;
export const SESSION_ID_BYTES = 16;
const MAX_ADDRESS_CHARS = 45;

/** Error codes the relay sends today. Decoders accept other well-formed codes, for newer relays. */
export const RELAY_ERROR_CODES = [
  "bad_message",
  "bad_proof",
  "replaced",
  "connector_offline",
  "rate_limited",
  "session_limit",
  "dial_timeout",
  "peer_gone",
  "frame_too_large",
  "idle_timeout",
  "internal",
] as const;
export type RelayErrorCode = (typeof RELAY_ERROR_CODES)[number];

type KeepAlive = { readonly t: "ping" } | { readonly t: "pong" };
type RelayError = { readonly t: "error"; readonly code: string };

export type RelayToConnector =
  /** The relay's first message: the nonce the register proof must answer. */
  | { readonly t: "challenge"; readonly nonce: string }
  | { readonly t: "registered" }
  /**
   * A phone dialed. The connector opens /v1/session/<relayId>/<session>. `from` is the phone's
   * address as the relay saw it, or empty; the relay can lie about it.
   */
  | { readonly t: "dial"; readonly session: string; readonly from: string }
  | RelayError
  | KeepAlive;

export type ConnectorToRelay = { readonly t: "register"; readonly proof: string } | KeepAlive;

/** On a dial or session socket: `open` means the two sockets are spliced and frames flow. */
export type RelayToEndpoint = { readonly t: "open" } | RelayError | KeepAlive;

export type EndpointToRelay = KeepAlive;

export type RelayMessage = RelayToConnector | ConnectorToRelay | RelayToEndpoint;

/** A fresh challenge nonce for a control socket. */
export function createRegisterNonce(random: RandomBytes = secureRandomBytes): string {
  return toBase64Url(random(REGISTER_NONCE_BYTES));
}

export function createSessionId(random: RandomBytes = secureRandomBytes): string {
  return toBase64Url(random(SESSION_ID_BYTES));
}

export function isSessionId(value: unknown): value is string {
  return fromBase64UrlOfLength(value, SESSION_ID_BYTES) !== null;
}

/** Writes a message with its keys in a fixed order. */
export function encodeRelayMessage(message: RelayMessage): string {
  let text: string;
  switch (message.t) {
    case "challenge":
      text = JSON.stringify({ t: message.t, nonce: message.nonce });
      break;
    case "dial":
      text = JSON.stringify({ t: message.t, session: message.session, from: message.from });
      break;
    case "register":
      text = JSON.stringify({ t: message.t, proof: message.proof });
      break;
    case "error":
      text = JSON.stringify({ t: message.t, code: message.code });
      break;
    case "registered":
    case "open":
    case "ping":
    case "pong":
      text = JSON.stringify({ t: message.t });
      break;
  }
  // Check what was written with the decoder of every direction that may carry it.
  checkFields(parseObject(text));
  return text;
}

export function decodeRelayToConnector(text: unknown): RelayToConnector {
  return decodeFor(text, [
    "challenge",
    "registered",
    "dial",
    "error",
    "ping",
    "pong",
  ]) as RelayToConnector;
}

export function decodeConnectorToRelay(text: unknown): ConnectorToRelay {
  return decodeFor(text, ["register", "ping", "pong"]) as ConnectorToRelay;
}

export function decodeRelayToEndpoint(text: unknown): RelayToEndpoint {
  return decodeFor(text, ["open", "error", "ping", "pong"]) as RelayToEndpoint;
}

export function decodeEndpointToRelay(text: unknown): EndpointToRelay {
  return decodeFor(text, ["ping", "pong"]) as EndpointToRelay;
}

function decodeFor(text: unknown, allowed: readonly RelayMessage["t"][]): RelayMessage {
  const members = parseObject(text);
  const t = members.get("t");
  if (typeof t !== "string" || !(allowed as readonly string[]).includes(t)) {
    bad("The relay message's type is not accepted here.");
  }
  return checkFields(members);
}

function parseObject(text: unknown): Map<string, FlatValue> {
  if (typeof text !== "string") return bad("A relay message is text.");
  // UTF-8 takes at least one byte per UTF-16 unit, so the first test bounds the encoding's cost.
  if (text.length > MAX_RELAY_MESSAGE_BYTES || utf8Encode(text).length > MAX_RELAY_MESSAGE_BYTES) {
    bad("The relay message is over the size cap.");
  }
  return readFlatObject(text);
}

function checkFields(members: Map<string, FlatValue>): RelayMessage {
  const t = members.get("t");
  switch (t) {
    case "challenge": {
      exactKeys(members, ["t", "nonce"]);
      const nonce = members.get("nonce");
      if (fromBase64UrlOfLength(nonce, REGISTER_NONCE_BYTES) === null) bad("Bad nonce.");
      return { t, nonce: nonce as string };
    }
    case "dial": {
      exactKeys(members, ["t", "session", "from"]);
      const session = members.get("session");
      const from = members.get("from");
      if (!isSessionId(session)) bad("Bad session id.");
      if (!isAddressText(from)) bad("Bad address.");
      return { t, session, from: from as string };
    }
    case "register": {
      exactKeys(members, ["t", "proof"]);
      const proof = members.get("proof");
      if (
        typeof proof !== "string" ||
        proof.length === 0 ||
        proof.length > MAX_REGISTER_PROOF_CHARS
      ) {
        bad("Bad proof.");
      }
      return { t, proof };
    }
    case "error": {
      exactKeys(members, ["t", "code"]);
      const code = members.get("code");
      if (typeof code !== "string" || !/^[a-z][a-z_]{0,31}$/.test(code)) bad("Bad code.");
      return { t, code };
    }
    case "registered":
    case "open":
    case "ping":
    case "pong":
      exactKeys(members, ["t"]);
      return { t };
    default:
      return bad("Unknown relay message.");
  }
}

function exactKeys(members: Map<string, FlatValue>, keys: readonly string[]): void {
  if (members.size !== keys.length || !keys.every((key) => members.has(key))) {
    bad("The relay message has missing or extra fields.");
  }
}

/** An IPv4 or IPv6 address as text, or empty. The connector checks it further before use. */
function isAddressText(value: unknown): boolean {
  return (
    typeof value === "string" && value.length <= MAX_ADDRESS_CHARS && /^[0-9A-Fa-f.:]*$/.test(value)
  );
}

function bad(message: string): never {
  return fail("bad_message", message);
}
