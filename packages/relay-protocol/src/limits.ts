/** The largest Noise message, from the Noise specification (section 3). */
export const NOISE_MAX_MESSAGE_BYTES = 65_535;
/** The ChaCha20-Poly1305 tag on every encrypted Noise payload. */
export const TAG_BYTES = 16;
/** An X25519 key or Diffie-Hellman output. */
export const KEY_BYTES = 32;

/** Version and type bytes in front of every frame. */
export const FRAME_HEADER_BYTES = 2;
/** The largest binary WebSocket message on a relayed session, header included. The relay drops bigger ones. */
export const MAX_FRAME_BYTES = FRAME_HEADER_BYTES + NOISE_MAX_MESSAGE_BYTES;
/** The largest handshake payload either side may send. */
export const MAX_HANDSHAKE_PAYLOAD_BYTES = 64;
/** The record kind byte in front of every decrypted transport payload. */
export const RECORD_HEADER_BYTES = 1;
/** The most data one record carries: a Noise message less its tag and the record kind. */
export const MAX_RECORD_DATA_BYTES = NOISE_MAX_MESSAGE_BYTES - TAG_BYTES - RECORD_HEADER_BYTES;
/**
 * The largest reassembled text message, in UTF-8 bytes. It is the gateway's own frame ceiling
 * when `hello-ok.policy.maxPayload` is absent (25 MiB), so a relayed route never refuses what a
 * direct route would carry.
 */
export const MAX_MESSAGE_BYTES = 26_214_400;
/**
 * The most records one text message takes. Every record but the last carries exactly
 * `MAX_RECORD_DATA_BYTES`, so a message of `MAX_MESSAGE_BYTES` takes 401.
 */
export const MAX_TEXT_RECORDS = Math.ceil(MAX_MESSAGE_BYTES / MAX_RECORD_DATA_BYTES);
/**
 * How long a host lets a text message stay unfinished, from its first record, before it
 * aborts the channel. Keep-alives in between do not extend it. 25 MiB takes about 3.5 minutes
 * at 1 Mbit/s.
 */
export const MAX_PARTIAL_MESSAGE_MS = 300_000;
/** The most opaque bytes a ping or pong carries. */
export const MAX_PING_BYTES = 32;
/** A WebSocket close reason's limit (RFC 6455 section 5.5: 125 bytes less the 2-byte code). */
export const MAX_CLOSE_REASON_BYTES = 123;

/** The largest relay text message (control socket, dial and session sockets), in UTF-8 bytes. */
export const MAX_RELAY_MESSAGE_BYTES = 4_096;
/** How long a control socket's challenge is good for, by the relay's monotonic clock. */
export const REGISTER_CHALLENGE_MS = 60_000;
/** The longest register proof the relay reads. */
export const MAX_REGISTER_PROOF_CHARS = 1_024;
