import { randomBytes as nobleRandomBytes } from "@noble/hashes/utils.js";
import { fail } from "./errors.ts";

/** A source of cryptographically secure random bytes. Tests replace it to replay known vectors. */
export type RandomBytes = (length: number) => Uint8Array;

/** `crypto.getRandomValues`, through `@noble/hashes`; it throws where no secure source exists. */
export const secureRandomBytes: RandomBytes = (length) => nobleRandomBytes(length);

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Compares in time that depends only on the lengths. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BASE64URL_INDEX = new Map([...BASE64URL].map((char, index) => [char, index]));

/** Base64url without padding (RFC 4648 section 5). */
export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const n = (a << 16) | (b << 8) | c;
    out += BASE64URL[(n >> 18) & 63];
    out += BASE64URL[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += BASE64URL[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += BASE64URL[n & 63];
  }
  return out;
}

/**
 * Decodes canonical unpadded base64url, or returns null. Canonical means that encoding the result
 * gives back the same text, so one value has exactly one spelling.
 */
export function fromBase64Url(text: string): Uint8Array | null {
  if (text.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let bits = 0;
  let buffer = 0;
  let offset = 0;
  for (const char of text) {
    const value = BASE64URL_INDEX.get(char);
    if (value === undefined) return null;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[offset++] = (buffer >> bits) & 0xff;
    }
    buffer &= (1 << bits) - 1;
  }
  // Leftover bits must be zero, or two spellings would decode to the same bytes.
  if (buffer !== 0) return null;
  return out;
}

/** Decodes base64url that must hold exactly `length` bytes, or returns null. */
export function fromBase64UrlOfLength(text: unknown, length: number): Uint8Array | null {
  if (typeof text !== "string" || text.length !== Math.ceil((length * 4) / 3)) return null;
  const bytes = fromBase64Url(text);
  return bytes !== null && bytes.length === length ? bytes : null;
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** Lowercase base32 without padding (RFC 4648 section 6), as used in host names. */
export function toBase32(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let buffer = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(buffer >> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function utf8Encode(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Decodes strict UTF-8, keeping a leading byte order mark as text. */
export function utf8Decode(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    return fail("bad_utf8", "The text is not valid UTF-8.");
  }
}
