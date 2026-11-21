export type RelayProtocolErrorCode =
  /** A frame, record or payload is shorter, longer or shaped differently than its type allows. */
  | "malformed"
  /** A frame names a protocol version this package does not speak. */
  | "unsupported_version"
  /** A message would be larger than `MAX_MESSAGE_BYTES` once reassembled. */
  | "message_too_large"
  /** Text is not valid UTF-8. */
  | "bad_utf8"
  /** A key is the wrong length or a Diffie-Hellman result is all zero (a low-order point). */
  | "bad_key"
  /** A relay id is not the canonical form `relayIdFromKey` produces. */
  | "bad_relay_id"
  /** A handshake or transport message failed authentication: tampered, replayed, reordered or for another key. */
  | "decrypt_failed"
  /** A frame or record arrived that the channel's state does not allow. */
  | "unexpected"
  /** The channel was closed by either side; nothing more is sent or received. */
  | "closed"
  /** The channel failed earlier; nothing more is sent or received. */
  | "failed"
  /** The channel's 2^53 message counter is used up. */
  | "nonce_exhausted"
  /** A relay text message is not one this side accepts. */
  | "bad_message"
  /** A time is not a nonnegative safe integer number of milliseconds. */
  | "bad_time"
  /** A shared receive budget has no room for more buffered text. */
  | "over_budget"
  /** A text message stayed unfinished past `MAX_PARTIAL_MESSAGE_MS`. */
  | "timed_out";

export class RelayProtocolError extends Error {
  readonly code: RelayProtocolErrorCode;

  constructor(code: RelayProtocolErrorCode, message: string) {
    super(message);
    this.name = "RelayProtocolError";
    this.code = code;
  }
}

export function fail(code: RelayProtocolErrorCode, message: string): never {
  throw new RelayProtocolError(code, message);
}
