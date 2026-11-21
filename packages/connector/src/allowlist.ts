// The phone allowlist and its enrollment offers, kept in `phones.json`.
//
// `pair-phone` adds an offer: the SHA-256 of a fresh 32-byte secret, its expiry and the phone's
// name. The secret itself is printed in the pairing code and never stored. When a phone's Noise
// handshake arrives, the running connector's gate looks, without changing anything, for the
// phone's key or a live offer its secret matches. After the phone confirms, the admission
// transaction, under the folder's lock and in one synchronous step, checks the attempt is still
// live, finds the offer unused and unexpired, spends it and adds the key. A secret is good once,
// until it expires: a replay finds the offer spent, and a late one finds it expired.

import { sha256 } from "@noble/hashes/sha2.js";
import {
  EnrollmentOffer,
  fromBase64Url,
  KEY_BYTES,
  toBase64Url,
  type AdmissionAttempt,
  type CommitResult,
  type GateCheck,
  type PhoneGate,
} from "@clawtrate/relay-protocol";
import { millisField, objectWithKeys, stringField, versionOne, type StateDir } from "./state.ts";

export const PHONES_FILE = "phones.json";
/** The most phones one connector keeps, and the most offers it holds open at once. */
export const MAX_PHONES = 32;
export const MAX_OPEN_OFFERS = 8;
export const MAX_LABEL_CHARS = 64;

export interface Phone {
  /** The phone's Noise static public key, base64url. */
  readonly key: string;
  readonly label: string;
  readonly addedAtMs: number;
}

export interface Offer {
  readonly id: string;
  /** SHA-256 of the enrollment secret, base64url. */
  readonly secretHash: string;
  readonly label: string;
  readonly expiresAtMs: number;
  readonly used: boolean;
}

export interface Phones {
  readonly phones: readonly Phone[];
  readonly offers: readonly Offer[];
}

const EMPTY: Phones = { phones: [], offers: [] };

function key32Text(text: string, what: string): string {
  const bytes = fromBase64Url(text);
  if (bytes === null || bytes.length !== KEY_BYTES) throw new Error(`${what} is not 32 bytes`);
  return text;
}

export function checkLabel(label: string): string {
  if (label.length === 0 || label.length > MAX_LABEL_CHARS || !/^[\x20-\x7e]+$/.test(label)) {
    throw new Error(`a name is 1 to ${MAX_LABEL_CHARS} printable ASCII characters`);
  }
  return label;
}

export function parsePhones(value: unknown): Phones {
  const record = objectWithKeys(value, ["v", "phones", "offers"]);
  versionOne(record);
  if (!Array.isArray(record.phones) || !Array.isArray(record.offers)) {
    throw new Error("phones and offers are lists");
  }
  const phones = record.phones.map((item: unknown): Phone => {
    const phone = objectWithKeys(item, ["key", "label", "addedAtMs"]);
    return {
      key: key32Text(stringField(phone, "key"), "a phone key"),
      label: checkLabel(stringField(phone, "label")),
      addedAtMs: millisField(phone, "addedAtMs"),
    };
  });
  const offers = record.offers.map((item: unknown): Offer => {
    const offer = objectWithKeys(item, ["id", "secretHash", "label", "expiresAtMs", "used"]);
    if (typeof offer.used !== "boolean") throw new Error("used is not true or false");
    return {
      id: key32Text(stringField(offer, "id"), "an offer id"),
      secretHash: key32Text(stringField(offer, "secretHash"), "a secret hash"),
      label: checkLabel(stringField(offer, "label")),
      expiresAtMs: millisField(offer, "expiresAtMs"),
      used: offer.used,
    };
  });
  if (new Set(phones.map((phone) => phone.key)).size !== phones.length) {
    throw new Error("a phone is listed twice");
  }
  if (phones.length > MAX_PHONES) throw new Error("too many phones");
  return { phones, offers };
}

function serialize(phones: Phones): unknown {
  return { v: 1, phones: phones.phones, offers: phones.offers };
}

export function readPhones(state: StateDir): Phones {
  return state.read(PHONES_FILE, parsePhones) ?? EMPTY;
}

/** Offers that are still open at `nowMs`: unused and unexpired. */
function openOffers(phones: Phones, nowMs: number): Offer[] {
  return phones.offers.filter((offer) => !offer.used && nowMs < offer.expiresAtMs);
}

/** Drops offers that have expired: a spent one is kept until then, so a replay reads as spent. */
function pruned(phones: Phones, nowMs: number): Phones {
  return { phones: phones.phones, offers: phones.offers.filter((o) => nowMs < o.expiresAtMs) };
}

/** Records a new offer for `secret`, good until `expiresAtMs`. */
export function addOffer(
  state: StateDir,
  input: { secret: Uint8Array; expiresAtMs: number; label: string },
  nowMs: number,
): Offer {
  checkLabel(input.label);
  if (input.secret.length !== 32) throw new Error("an enrollment secret is 32 bytes");
  if (!(input.expiresAtMs > nowMs)) throw new Error("the offer would already have expired");
  return state.withLock(() => {
    const current = pruned(readPhones(state), nowMs);
    if (openOffers(current, nowMs).length >= MAX_OPEN_OFFERS) {
      throw new Error(`${MAX_OPEN_OFFERS} pairing codes are already open; wait for one to expire`);
    }
    if (current.phones.length >= MAX_PHONES) throw new Error(`${MAX_PHONES} phones are paired`);
    const offer: Offer = {
      id: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
      secretHash: toBase64Url(sha256(input.secret)),
      label: input.label,
      expiresAtMs: input.expiresAtMs,
      used: false,
    };
    state.write(PHONES_FILE, serialize({ ...current, offers: [...current.offers, offer] }));
    return offer;
  });
}

/** Removes the phones whose key or name is `which`, and returns them. */
export function removePhones(state: StateDir, which: string, nowMs: number): Phone[] {
  return state.withLock(() => {
    const current = pruned(readPhones(state), nowMs);
    const removed = current.phones.filter((p) => p.key === which || p.label === which);
    if (removed.length > 0) {
      state.write(
        PHONES_FILE,
        serialize({ ...current, phones: current.phones.filter((p) => !removed.includes(p)) }),
      );
    }
    return removed;
  });
}

/** What the gate names at message 1 and the transaction is handed back at commit. */
interface Candidate {
  readonly offerId: string;
  /** Holds the secret's hash, so R1's constant-time match and one-time spend apply to it. */
  readonly offer: EnrollmentOffer;
}

/**
 * The running connector's gate and admission transaction over the state folder. Each check
 * reads the file again, so a phone removed by `remove-phone` is refused at its next handshake.
 */
export class Allowlist implements PhoneGate {
  readonly #state: StateDir;
  readonly #now: () => number;

  constructor(state: StateDir, now: () => number = Date.now) {
    this.#state = state;
    this.#now = now;
  }

  isEnrolled(phoneKey: Uint8Array): boolean {
    const key = toBase64Url(phoneKey);
    return readPhones(this.#state).phones.some((phone) => phone.key === key);
  }

  /** Read-only, as the channel requires. */
  check(phoneKey: Uint8Array, enroll: Uint8Array | undefined): GateCheck {
    const phones = readPhones(this.#state);
    const key = toBase64Url(phoneKey);
    if (phones.phones.some((phone) => phone.key === key)) return "enrolled";
    if (enroll === undefined) return "not_enrolled";
    const nowMs = this.#now();
    const hash = sha256(enroll);
    for (const stored of openOffers(phones, nowMs)) {
      const offer = new EnrollmentOffer(fromBase64Url(stored.secretHash)!, stored.expiresAtMs);
      if (offer.matches(hash, nowMs)) {
        const candidate: Candidate = { offerId: stored.id, offer };
        return { eligible: candidate };
      }
    }
    return "enrollment_refused";
  }

  /**
   * The admission transaction. Under the lock, synchronously: read the file again, recheck the
   * offer, then read `attempt.live` and write, with nothing between that reading and the write.
   */
  commit(attempt: AdmissionAttempt): CommitResult {
    return this.#state.withLock(() => {
      const nowMs = this.#now();
      const current = pruned(readPhones(this.#state), nowMs);
      const key = toBase64Url(attempt.phoneKey);
      if (current.phones.some((phone) => phone.key === key)) return "enrolled";
      const candidate = attempt.candidate as Candidate | null;
      // The key was enrolled at the handshake and removed since.
      if (candidate === null) return "not_enrolled";
      const stored = current.offers.find((offer) => offer.id === candidate.offerId);
      if (stored === undefined || stored.used || nowMs >= stored.expiresAtMs) {
        return "enrollment_refused";
      }
      if (current.phones.length >= MAX_PHONES) return "enrollment_refused";
      if (!attempt.live || !candidate.offer.spend(nowMs)) return "enrollment_refused";
      const phone: Phone = { key, label: stored.label, addedAtMs: nowMs };
      this.#state.write(
        PHONES_FILE,
        serialize({
          phones: [...current.phones, phone],
          offers: current.offers.map((offer) =>
            offer === stored ? { ...offer, used: true } : offer,
          ),
        }),
      );
      return "enrolled";
    });
  }
}
