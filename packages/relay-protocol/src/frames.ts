// The bytes on a relayed session. The relay passes frames between the phone and the connector
// unchanged and can read only their header; see the package README for the layout.

import { concatBytes, utf8Decode, utf8Encode } from "./bytes.ts";
import { fail } from "./errors.ts";
import {
  FRAME_HEADER_BYTES,
  KEY_BYTES,
  MAX_CLOSE_REASON_BYTES,
  MAX_FRAME_BYTES,
  MAX_HANDSHAKE_PAYLOAD_BYTES,
  MAX_PING_BYTES,
  MAX_RECORD_DATA_BYTES,
  NOISE_MAX_MESSAGE_BYTES,
  RECORD_HEADER_BYTES,
  TAG_BYTES,
} from "./limits.ts";

export const PROTOCOL_VERSION = 1;

export type FrameType = "handshake1" | "handshake2" | "transport";

export interface Frame {
  readonly type: FrameType;
  /** A Noise message. */
  readonly body: Uint8Array;
}

const FRAME_TYPE_BYTE: Readonly<Record<FrameType, number>> = {
  handshake1: 1,
  handshake2: 2,
  transport: 3,
};

/** The smallest and largest Noise message each frame type carries. */
const FRAME_BODY_BYTES: Readonly<Record<FrameType, readonly [number, number]>> = {
  // e, then s and the payload, each encrypted with a tag.
  handshake1: [
    KEY_BYTES + KEY_BYTES + TAG_BYTES + TAG_BYTES,
    KEY_BYTES + KEY_BYTES + TAG_BYTES + MAX_HANDSHAKE_PAYLOAD_BYTES + TAG_BYTES,
  ],
  // e, then the encrypted payload.
  handshake2: [KEY_BYTES + TAG_BYTES, KEY_BYTES + MAX_HANDSHAKE_PAYLOAD_BYTES + TAG_BYTES],
  // One encrypted record: at least its kind byte.
  transport: [RECORD_HEADER_BYTES + TAG_BYTES, NOISE_MAX_MESSAGE_BYTES],
};

export function encodeFrame(frame: Frame): Uint8Array {
  checkFrameBody(frame.type, frame.body.length);
  return concatBytes(Uint8Array.of(PROTOCOL_VERSION, FRAME_TYPE_BYTE[frame.type]), frame.body);
}

/** Reads a frame's header and checks its length. Throws `RelayProtocolError` and nothing else. */
export function decodeFrame(bytes: Uint8Array): Frame {
  if (!(bytes instanceof Uint8Array)) fail("malformed", "A frame is binary.");
  if (bytes.length > MAX_FRAME_BYTES) fail("malformed", "The frame is over the size cap.");
  if (bytes.length < FRAME_HEADER_BYTES) fail("malformed", "The frame has no header.");
  if (bytes[0] !== PROTOCOL_VERSION) {
    fail("unsupported_version", `Frame version ${bytes[0]} is not version ${PROTOCOL_VERSION}.`);
  }
  const type = frameTypeOf(bytes[1]!);
  const body = bytes.subarray(FRAME_HEADER_BYTES);
  checkFrameBody(type, body.length);
  return { type, body };
}

function frameTypeOf(byte: number): FrameType {
  switch (byte) {
    case 1:
      return "handshake1";
    case 2:
      return "handshake2";
    case 3:
      return "transport";
    default:
      return fail("malformed", `Frame type ${byte} is unknown.`);
  }
}

function checkFrameBody(type: FrameType, length: number): void {
  const [min, max] = FRAME_BODY_BYTES[type];
  if (length < min || length > max) {
    fail("malformed", `A ${type} frame carries ${min} to ${max} bytes, not ${length}.`);
  }
}

/** What one decrypted transport message holds. */
export type ChannelRecord =
  /** The initiator's first record: proves it completed the handshake, so it is not a replay. */
  | { readonly kind: "confirm" }
  /**
   * The responder's first record, sent after the confirm record and its own final check: the
   * phone is admitted, or refused after all. Message 2's "accepted" is provisional until this.
   */
  | { readonly kind: "admission"; readonly answer: Answer }
  /** Part of a UTF-8 text message; more parts follow. Exactly `MAX_RECORD_DATA_BYTES`. */
  | { readonly kind: "text-part"; readonly data: Uint8Array }
  /** The last (or only) part of a UTF-8 text message. */
  | { readonly kind: "text-end"; readonly data: Uint8Array }
  | { readonly kind: "ping"; readonly data: Uint8Array }
  | { readonly kind: "pong"; readonly data: Uint8Array }
  /** The sender is done; it carries a WebSocket close code and reason for the far side. */
  | { readonly kind: "close"; readonly code: number; readonly reason: string };

export type RecordKind = ChannelRecord["kind"];

const RECORD_KIND_BYTE: Readonly<Record<RecordKind, number>> = {
  confirm: 1,
  "text-part": 2,
  "text-end": 3,
  ping: 4,
  pong: 5,
  close: 6,
  admission: 7,
};

export function encodeRecord(record: ChannelRecord): Uint8Array {
  const kind = Uint8Array.of(RECORD_KIND_BYTE[record.kind]);
  switch (record.kind) {
    case "confirm":
      return kind;
    case "admission":
      return concatBytes(kind, Uint8Array.of(answerByte(record.answer)));
    case "text-part":
    case "text-end":
    case "ping":
    case "pong":
      checkRecordData(record.kind, record.data.length);
      return concatBytes(kind, record.data);
    case "close": {
      if (!isSendableCloseCode(record.code))
        fail("malformed", `Close code ${record.code} is not sendable.`);
      const reason = utf8Encode(record.reason);
      if (reason.length > MAX_CLOSE_REASON_BYTES)
        fail("malformed", "The close reason is too long.");
      return concatBytes(kind, Uint8Array.of(record.code >> 8, record.code & 0xff), reason);
    }
  }
}

/** Reads a decrypted transport payload. Throws `RelayProtocolError` and nothing else. */
export function decodeRecord(bytes: Uint8Array): ChannelRecord {
  if (!(bytes instanceof Uint8Array)) fail("malformed", "A record is binary.");
  if (bytes.length < RECORD_HEADER_BYTES) fail("malformed", "The record has no kind.");
  const data = bytes.subarray(RECORD_HEADER_BYTES);
  switch (bytes[0]) {
    case 1:
      if (data.length !== 0) fail("malformed", "A confirm record is empty.");
      return { kind: "confirm" };
    case 2:
      checkRecordData("text-part", data.length);
      return { kind: "text-part", data };
    case 3:
      checkRecordData("text-end", data.length);
      return { kind: "text-end", data };
    case 4:
      checkRecordData("ping", data.length);
      return { kind: "ping", data };
    case 5:
      checkRecordData("pong", data.length);
      return { kind: "pong", data };
    case 6: {
      if (data.length < 2) fail("malformed", "A close record carries a code.");
      const code = (data[0]! << 8) | data[1]!;
      if (!isSendableCloseCode(code)) fail("malformed", `Close code ${code} is not sendable.`);
      const reason = data.subarray(2);
      if (reason.length > MAX_CLOSE_REASON_BYTES)
        fail("malformed", "The close reason is too long.");
      return { kind: "close", code, reason: utf8Decode(reason) };
    }
    case 7:
      if (data.length !== 1) fail("malformed", "An admission record carries one status.");
      return { kind: "admission", answer: answerOf(data[0]!) };
    default:
      return fail("malformed", `Record kind ${bytes[0]} is unknown.`);
  }
}

function checkRecordData(kind: RecordKind, length: number): void {
  const [min, max] =
    kind === "ping" || kind === "pong"
      ? [0, MAX_PING_BYTES]
      : kind === "text-part"
        ? // A full record, or a message could take one record per byte.
          [MAX_RECORD_DATA_BYTES, MAX_RECORD_DATA_BYTES]
        : [0, MAX_RECORD_DATA_BYTES];
  if (length < min || length > max) {
    fail("malformed", `A ${kind} record carries ${min} to ${max} bytes, not ${length}.`);
  }
}

/** The codes RFC 6455 lets an endpoint send: never 1004 to 1006 or 1015. */
export function isSendableCloseCode(code: number): boolean {
  return (
    Number.isInteger(code) &&
    ((code >= 1000 && code <= 1003) ||
      (code >= 1007 && code <= 1014) ||
      (code >= 3000 && code <= 4999))
  );
}

/** What the phone puts in handshake message 1. */
export interface Hello {
  /** The one-time enrollment secret from the pairing code, sent only while the phone is not enrolled. */
  readonly enroll?: Uint8Array;
}

export const ENROLL_SECRET_BYTES = 32;
const HELLO_HAS_ENROLL = 1;

export function encodeHello(hello: Hello): Uint8Array {
  if (hello.enroll === undefined) return Uint8Array.of(PROTOCOL_VERSION, 0);
  if (hello.enroll.length !== ENROLL_SECRET_BYTES) {
    fail("malformed", "An enrollment secret is 32 bytes.");
  }
  return concatBytes(Uint8Array.of(PROTOCOL_VERSION, HELLO_HAS_ENROLL), hello.enroll);
}

export function decodeHello(bytes: Uint8Array): Hello {
  if (bytes.length < 2 || bytes[0] !== PROTOCOL_VERSION)
    fail("malformed", "The hello is malformed.");
  if (bytes[1] === 0 && bytes.length === 2) return {};
  if (bytes[1] === HELLO_HAS_ENROLL && bytes.length === 2 + ENROLL_SECRET_BYTES) {
    return { enroll: bytes.slice(2) };
  }
  return fail("malformed", "The hello is malformed.");
}

/** The connector's answer in handshake message 2. */
export type Answer = "accepted" | "not_enrolled" | "enrollment_refused";

const ANSWER_BYTE: Readonly<Record<Answer, number>> = {
  accepted: 0,
  not_enrolled: 1,
  enrollment_refused: 2,
};

export function encodeAnswer(answer: Answer): Uint8Array {
  return Uint8Array.of(PROTOCOL_VERSION, answerByte(answer));
}

/** The one encoder of an answer's status byte. Anything but the three answers fails. */
function answerByte(answer: unknown): number {
  if (typeof answer !== "string" || !Object.hasOwn(ANSWER_BYTE, answer)) {
    return fail("malformed", "The answer is not one of the three answers.");
  }
  return ANSWER_BYTE[answer as Answer];
}

/** True for the two ways to turn a phone away. */
export function isRefusal(value: unknown): value is Exclude<Answer, "accepted"> {
  return value === "not_enrolled" || value === "enrollment_refused";
}

export function decodeAnswer(bytes: Uint8Array): Answer {
  if (bytes.length !== 2 || bytes[0] !== PROTOCOL_VERSION)
    fail("malformed", "The answer is malformed.");
  return answerOf(bytes[1]!);
}

function answerOf(byte: number): Answer {
  switch (byte) {
    case 0:
      return "accepted";
    case 1:
      return "not_enrolled";
    case 2:
      return "enrollment_refused";
    default:
      return fail("malformed", "The answer is malformed.");
  }
}
