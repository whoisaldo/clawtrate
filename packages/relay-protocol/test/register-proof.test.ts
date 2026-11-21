// The rejection cases are ported from T3 Code (https://github.com/pingdotgg/t3code) at commit
// 18d1c4db: packages/shared/src/dpop.test.ts ("rejects malformed DPoP header and payload JSON",
// "rejects method, URL, thumbprint, and time-window mismatches", "reports a time-window failure
// only after the proof signature is valid", "accepts clock offsets through 300 seconds in either
// direction") and infra/relay/src/auth/DpopProofs.verifyAndConsume.test.ts ("rejects replays
// until a future proof's time window closes").
//
// Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalRelayOrigin,
  EnrollmentOffer,
  RelayProtocolError,
  ControlRegistration,
  createRegisterNonce,
  decodeRelayToConnector,
  MemoryKeyClaims,
  MemoryRegistrationStore,
  createRegisterProof,
  isRelayId,
  MemoryReplayStore,
  REGISTER_PROOF_TYP,
  relayIdFromKey,
  toBase64Url,
  verifyRegisterProof,
  type KeyClaims,
  type RegistrationSnapshot,
  type RegistrationStore,
  type ReplayStore,
} from "../src/index.ts";

const AUDIENCE = "wss://relay.example.test";
const NOW_MS = Date.UTC(2026, 10, 20, 12, 0, 0);
const NOW_S = NOW_MS / 1_000;
const secretKey = ed25519.utils.randomSecretKey();
const publicKey = ed25519.getPublicKey(secretKey);
const relayId = relayIdFromKey(publicKey);
const nonce = createRegisterNonce();

function verify(
  proof: string | undefined,
  overrides: Partial<{
    relayId: string;
    audience: string;
    nonce: string;
    nowMs: number;
    replay: ReplayStore;
  }> = {},
) {
  return verifyRegisterProof({
    proof,
    relayId,
    audience: AUDIENCE,
    nonce,
    nowMs: NOW_MS,
    replay: new MemoryReplayStore(),
    ...overrides,
  });
}

/** Signs any payload the way the connector does, so tests can make proofs it never would. */
function sign(
  payload: unknown,
  key: Uint8Array = secretKey,
  context = "clawtrate relay register proof\n",
) {
  const encoded = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const message = new TextEncoder().encode(context + encoded);
  return `${encoded}.${toBase64Url(ed25519.sign(message, key))}`;
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    typ: REGISTER_PROOF_TYP,
    aud: AUDIENCE,
    relayId,
    key: toBase64Url(publicKey),
    nonce,
    iat: NOW_S,
    jti: toBase64Url(new Uint8Array(16).fill(1)),
    ...overrides,
  };
}

describe("the relay id", () => {
  it("is lowercase base32 of the first 16 bytes of SHA-256 over the key", () => {
    // Computed separately: base32(sha256(bytes([7] * 32))[:16]), lowercased, unpadded.
    expect(relayIdFromKey(new Uint8Array(32).fill(7))).toBe("joyg7dsohj3rluqb2vz5bkscg4");
  });

  it("accepts every id a key derives and no other spelling", () => {
    for (let i = 0; i < 200; i++) {
      const id = relayIdFromKey(ed25519.getPublicKey(ed25519.utils.randomSecretKey()));
      expect(id).toHaveLength(26);
      expect(isRelayId(id)).toBe(true);
    }
    const id = "joyg7dsohj3rluqb2vz5bkscg4";
    for (const other of [
      id.toUpperCase(),
      `${id.slice(0, 25)}5`,
      id.slice(0, 25),
      `${id}a`,
      `${id}=`,
      7,
    ]) {
      expect(isRelayId(other)).toBe(false);
    }
  });
});

describe("the connector's register proof", () => {
  it("verifies a fresh proof and names the key and relay id it proves", async () => {
    const proof = createRegisterProof({ secretKey, audience: AUDIENCE, nonce, nowMs: NOW_MS });
    const result = await verify(proof);
    expect(result).toMatchObject({ ok: true, relayId, iat: NOW_S });
    if (result.ok) expect(result.publicKey).toEqual(publicKey);
  });

  it("rejects a missing or malformed proof", async () => {
    const good = createRegisterProof({ secretKey, audience: AUDIENCE, nonce, nowMs: NOW_MS });
    const [encoded, signature] = good.split(".") as [string, string];
    const notJson = toBase64Url(new TextEncoder().encode("{"));
    for (const proof of [undefined, "", "   "]) {
      expect(await verify(proof)).toEqual({ ok: false, code: "missing_proof" });
    }
    for (const proof of [
      encoded,
      `${good}.extra`,
      `${notJson}.${signature}`,
      `${encoded}=.${signature}`,
      `${encoded}.${signature.slice(1)}`,
      `${encoded}.${signature}A`,
      `${encoded}.${"A".repeat(1_100)}`,
      sign(payload({ typ: "dpop+jwt" })),
      sign(payload({ extra: 1 })),
      sign({ ...payload(), jti: undefined }),
      sign(payload({ iat: NOW_S + 0.5 })),
      sign(payload({ iat: -1 })),
      sign(payload({ iat: String(NOW_S) })),
      sign(payload({ jti: "short" })),
      sign(payload({ nonce: "short" })),
      sign(payload({ key: toBase64Url(new Uint8Array(31)) })),
      sign(payload({ aud: "" })),
      sign(payload({ aud: "x".repeat(257) })),
      sign([payload()]),
      sign(null),
    ]) {
      expect(await verify(proof), proof).toEqual({ ok: false, code: "malformed_proof" });
    }
  });

  it("rejects relay id, audience, nonce and key mismatches", async () => {
    const proof = createRegisterProof({ secretKey, audience: AUDIENCE, nonce, nowMs: NOW_MS });
    const otherRelayId = relayIdFromKey(new Uint8Array(32).fill(7));
    expect(await verify(proof, { relayId: otherRelayId })).toEqual({
      ok: false,
      code: "relay_mismatch",
    });
    expect(await verify(proof, { audience: "wss://other.example.test" })).toEqual({
      ok: false,
      code: "audience_mismatch",
    });
    expect(await verify(proof, { nonce: createRegisterNonce() })).toEqual({
      ok: false,
      code: "nonce_mismatch",
    });
    // The key signs a proof claiming another key's relay id.
    expect(
      await verify(sign(payload({ relayId: otherRelayId })), { relayId: otherRelayId }),
    ).toEqual({
      ok: false,
      code: "key_mismatch",
    });
  });

  it("rejects a proof signed by another key or in another context", async () => {
    const otherKey = ed25519.utils.randomSecretKey();
    expect(await verify(sign(payload(), otherKey))).toEqual({
      ok: false,
      code: "invalid_signature",
    });
    expect(await verify(sign(payload(), secretKey, ""))).toEqual({
      ok: false,
      code: "invalid_signature",
    });
    // A payload changed after signing.
    const good = createRegisterProof({ secretKey, audience: AUDIENCE, nonce, nowMs: NOW_MS });
    const signature = good.split(".")[1]!;
    const changed = sign(payload({ iat: NOW_S - 1 })).split(".")[0]!;
    expect(await verify(`${changed}.${signature}`)).toEqual({
      ok: false,
      code: "invalid_signature",
    });
  });

  it("reports a time-window failure only after the proof signature is valid", async () => {
    const old = sign(payload({ iat: NOW_S - 1_000 }));
    expect(await verify(old)).toEqual({ ok: false, code: "time_window" });
    const oldAndForged = sign(payload({ iat: NOW_S - 1_000 }), ed25519.utils.randomSecretKey());
    expect(await verify(oldAndForged)).toEqual({ ok: false, code: "invalid_signature" });
  });

  it("accepts clock offsets through 60 seconds in either direction", async () => {
    for (const { offset, accepted } of [
      { offset: -60, accepted: true },
      { offset: 60, accepted: true },
      { offset: -61, accepted: false },
      { offset: 61, accepted: false },
    ]) {
      const result = await verify(sign(payload()), { nowMs: NOW_MS + offset * 1_000 });
      expect(result.ok, `Clock offset: ${offset}s`).toBe(accepted);
      if (!result.ok) expect(result.code).toBe("time_window");
    }
  });

  it("rejects a replayed proof", async () => {
    const replay = new MemoryReplayStore();
    const proof = createRegisterProof({ secretKey, audience: AUDIENCE, nonce, nowMs: NOW_MS });
    expect((await verify(proof, { replay })).ok).toBe(true);
    expect(await verify(proof, { replay })).toEqual({ ok: false, code: "replayed" });
  });

  it("rejects replays until a future proof's time window closes", async () => {
    const replay = new MemoryReplayStore();
    const proof = sign(payload({ iat: NOW_S + 60, jti: toBase64Url(new Uint8Array(16).fill(2)) }));
    expect((await verify(proof, { replay })).ok).toBe(true);
    for (const { elapsedMs, code } of [
      { elapsedMs: 0, code: "replayed" },
      { elapsedMs: 61_000, code: "replayed" },
      { elapsedMs: 120_999, code: "replayed" },
      { elapsedMs: 121_000, code: "time_window" },
    ]) {
      const result = await verify(proof, { replay, nowMs: NOW_MS + elapsedMs });
      expect(result, `Replay after ${elapsedMs}ms`).toEqual({ ok: false, code });
    }
    // The store keeps the jti exactly as long as the proof could pass the time check.
    replay.prune(NOW_MS + 120_999);
    expect(replay.size).toBe(1);
    replay.prune(NOW_MS + 121_000);
    expect(replay.size).toBe(0);
  });

  it("keeps replay records apart per relay id, and forgets them when they expire", () => {
    const replay = new MemoryReplayStore();
    const entry = { jti: "j", expiresAtMs: 10, nowMs: 0 };
    expect(replay.consume({ ...entry, scope: "a" })).toBe(true);
    expect(replay.consume({ ...entry, scope: "b" })).toBe(true);
    expect(replay.consume({ ...entry, scope: "a" })).toBe(false);
    expect(replay.consume({ ...entry, scope: "a", nowMs: 10 })).toBe(true);
  });

  it("checks the signature before it consumes anything, and fails when the store fails", async () => {
    let consumed = 0;
    const counting: ReplayStore = { consume: () => (consumed++, true) };
    await verify(sign(payload(), ed25519.utils.randomSecretKey()), { replay: counting });
    await verify(sign(payload({ iat: NOW_S - 1_000 })), { replay: counting });
    expect(consumed).toBe(0);
    const broken: ReplayStore = {
      consume: () => Promise.reject(new Error("storage unavailable")),
    };
    expect(await verify(sign(payload()), { replay: broken })).toEqual({
      ok: false,
      code: "store_failed",
    });
  });
});

describe("one control socket's registration", () => {
  function socket(
    overrides: Partial<{
      clock: () => number;
      wallClock: () => number;
      replay: ReplayStore;
      claims: KeyClaims;
      origin: string;
      restore: RegistrationSnapshot;
      store: RegistrationStore;
    }> = {},
  ) {
    return new ControlRegistration({
      relayId,
      origin: AUDIENCE,
      clock: () => 5_000,
      wallClock: () => NOW_MS,
      replay: new MemoryReplayStore(),
      claims: new MemoryKeyClaims(),
      ...overrides,
    });
  }
  function proofFor(registration: ControlRegistration, audience = AUDIENCE) {
    const challenge = decodeRelayToConnector(registration.challengeMessage);
    if (challenge.t !== "challenge") throw new Error("No challenge.");
    return createRegisterProof({ secretKey, audience, nonce: challenge.nonce, nowMs: NOW_MS });
  }
  /**
   * The reference store, recording each write and each commit's outcome. `failFailure` makes
   * storing `failed` throw.
   */
  function recording(options: { failFailure?: boolean } = {}) {
    const memory = new MemoryRegistrationStore();
    const seen: string[] = [];
    const store: RegistrationStore = {
      persist: (snapshot) => {
        seen.push(snapshot.state);
        if (snapshot.state === "failed" && options.failFailure) throw new Error("down");
        memory.persist(snapshot);
      },
      commitRegistered: (snapshot, attempt) => {
        seen.push("commit");
        const outcome = memory.commitRegistered(snapshot, attempt);
        seen.push(outcome);
        return outcome;
      },
    };
    return { store, seen, latest: () => memory.latest! };
  }
  /** Key claims that wait in the claim, while the success is prepared, until released. */
  function heldClaims() {
    const pinned = new MemoryKeyClaims();
    let release = (): void => {};
    let waiting = false;
    const claims: KeyClaims = {
      claim: (id, key, attempt) =>
        new Promise((resolve) => {
          waiting = true;
          release = () => resolve(pinned.claim(id, key, attempt));
        }),
    };
    return {
      claims,
      release: () => release(),
      reach: async () => {
        for (let i = 0; i < 50 && !waiting; i++) await Promise.resolve();
        expect(waiting).toBe(true);
      },
    };
  }

  it("issues a fresh challenge per socket and registers once", async () => {
    const first = socket();
    const second = socket();
    expect(first.challengeMessage).not.toBe(second.challengeMessage);
    expect(first.state).toBe("challenged");
    const proof = proofFor(first);
    expect((await first.register(proof)).ok).toBe(true);
    expect(first.state).toBe("registered");
    expect(await first.register(proofFor(first))).toEqual({ ok: false, code: "already_used" });
    // A proof for one socket's challenge is no good on another socket.
    expect(await second.register(proof)).toEqual({ ok: false, code: "nonce_mismatch" });
    expect(await second.register(proofFor(second))).toEqual({ ok: false, code: "already_used" });
  });

  it("takes one attempt even when two overlap", async () => {
    const registration = socket();
    const proof = proofFor(registration);
    const results = await Promise.all([registration.register(proof), registration.register(proof)]);
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(results[1]).toEqual({ ok: false, code: "already_used" });
  });

  it("refuses a challenge older than 60 seconds by the monotonic clock", async () => {
    for (const [elapsed, ok] of [
      [60_000, true],
      [60_001, false],
    ] as const) {
      let now = 1_000;
      const registration = socket({ clock: () => now });
      const proof = proofFor(registration);
      now += elapsed;
      const result = await registration.register(proof);
      expect(result.ok, `${elapsed}ms`).toBe(ok);
      if (!result.ok) expect(result.code).toBe("challenge_expired");
    }
  });

  it("compares the signed origin with the relay's canonical origin", async () => {
    expect(canonicalRelayOrigin("WSS://Relay.Example.TEST:443/")).toBe(AUDIENCE);
    expect(canonicalRelayOrigin("ws://127.0.0.1:8787", { allowLoopbackWs: true })).toBe(
      "ws://127.0.0.1:8787",
    );
    for (const bad of [
      "https://relay.example.test",
      "wss://relay.example.test/v1",
      "wss://user@relay.example.com",
      "wss://relay.example.test?x=1",
      "relay.example.test",
    ]) {
      expect(() => canonicalRelayOrigin(bad), bad).toThrow(RelayProtocolError);
    }
    // The connector signs the canonical form of what it was given.
    const relaxed = socket({ origin: "wss://relay.example.test/" });
    expect((await relaxed.register(proofFor(relaxed, "wss://RELAY.example.test:443"))).ok).toBe(
      true,
    );
    // A proof whose signed origin is not canonical does not match.
    const strict = socket();
    const challenge = decodeRelayToConnector(strict.challengeMessage);
    if (challenge.t !== "challenge") throw new Error("No challenge.");
    const spelled = sign(payload({ aud: "wss://relay.example.test/", nonce: challenge.nonce }));
    expect(await strict.register(spelled)).toEqual({ ok: false, code: "audience_mismatch" });
  });

  it("pins the relay id to the first key that registers it", async () => {
    const claims = new MemoryKeyClaims();
    expect(claims.claim(relayId, new Uint8Array(32).fill(1), { live: true })).toBe(true);
    const registration = socket({ claims });
    expect(await registration.register(proofFor(registration))).toEqual({
      ok: false,
      code: "claimed_by_other_key",
    });
    expect(registration.state).toBe("failed");
    const own = new MemoryKeyClaims();
    for (let i = 0; i < 2; i++) {
      const again = socket({ claims: own });
      expect((await again.register(proofFor(again))).ok).toBe(true);
    }
  });

  it("fails when the replay store or the key claims fail", async () => {
    const replay = socket({ replay: { consume: () => Promise.reject(new Error("down")) } });
    expect(await replay.register(proofFor(replay))).toEqual({ ok: false, code: "store_failed" });
    expect(replay.state).toBe("failed");
    const claims = socket({ claims: { claim: () => Promise.reject(new Error("down")) } });
    expect(await claims.register(proofFor(claims))).toEqual({ ok: false, code: "store_failed" });
  });

  it("a store that checks and inserts atomically lets one of two overlapping uses through", async () => {
    const store = new MemoryReplayStore();
    // An asynchronous store in front of the atomic reference, as a database would be.
    const slow: ReplayStore = {
      consume: async (input) => {
        await Promise.resolve();
        return store.consume(input);
      },
    };
    const proof = createRegisterProof({ secretKey, audience: AUDIENCE, nonce, nowMs: NOW_MS });
    const results = await Promise.all([
      verify(proof, { replay: slow }),
      verify(proof, { replay: slow }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, code: "replayed" }]);
  });

  it("expires a quiet challenge from the relay's timer, and then takes no attempt", async () => {
    let now = 5_000;
    const registration = socket({ clock: () => now });
    expect(registration.expiresAtMs).toBe(65_000);
    now = 65_000;
    expect(registration.expire()).toBe(false);
    now = 65_001;
    expect(registration.expire()).toBe(true);
    expect(registration.state).toBe("failed");
    expect(registration.expire()).toBe(false);
    expect(await registration.register(proofFor(registration))).toEqual({
      ok: false,
      code: "already_used",
    });
  });

  it("a store that outlasts the challenge cannot register: no key claim, no success", async () => {
    let now = 5_000;
    let release = (): void => {};
    const store = new MemoryReplayStore();
    const slow: ReplayStore = {
      consume: (input) =>
        new Promise((resolve) => {
          release = () => resolve(store.consume(input));
        }),
    };
    let claims = 0;
    const counting: KeyClaims = { claim: () => (claims++, true) };
    const registration = socket({ clock: () => now, replay: slow, claims: counting });
    const pending = registration.register(proofFor(registration));
    await Promise.resolve();
    now = 5_000 + 60_001;
    release();
    expect(await pending).toEqual({ ok: false, code: "challenge_expired" });
    expect(claims).toBe(0);
    expect(registration.state).toBe("failed");
  });

  it("an abort while the key claim waits stops the claim from taking effect", async () => {
    const pinned = new MemoryKeyClaims();
    let release = (): void => {};
    const waiting: KeyClaims = {
      claim: (id, key, attempt) =>
        new Promise((resolve) => {
          release = () => resolve(pinned.claim(id, key, attempt));
        }),
    };
    const registration = socket({ claims: waiting });
    const pending = registration.register(proofFor(registration));
    for (let i = 0; i < 5; i++) await Promise.resolve();
    registration.abort();
    release();
    expect(await pending).toEqual({ ok: false, code: "aborted" });
    // Nothing was pinned: a later registration with another key could still claim the id.
    expect(pinned.claim(relayId, new Uint8Array(32).fill(3), { live: true })).toBe(true);
  });

  it("keeps verifying stored while the success is prepared; an abort then cancels it", async () => {
    const saved = recording();
    const held = heldClaims();
    const registration = socket({ store: saved.store, claims: held.claims });
    const pending = registration.register(proofFor(registration));
    await held.reach();
    expect(saved.latest().state).toBe("verifying");
    expect(socket({ restore: saved.latest() }).state).toBe("failed");
    registration.abort();
    held.release();
    expect(await pending).toEqual({ ok: false, code: "aborted" });
    expect(saved.seen).toEqual(["verifying", "failed"]);
    expect(socket({ restore: saved.latest() }).state).toBe("failed");
  });

  it("the timer's expiry during preparation reports the clock failure it saw", async () => {
    for (const [label, timerReading, code] of [
      ["rollback, then recovery", 4_999, "bad_clock"],
      ["elapsed deadline", 65_001, "challenge_expired"],
      ["plain abort", null, "aborted"],
    ] as const) {
      let now = 5_000;
      const saved = recording();
      const held = heldClaims();
      const registration = socket({ clock: () => now, store: saved.store, claims: held.claims });
      const pending = registration.register(proofFor(registration));
      await held.reach();
      if (timerReading === null) {
        registration.abort();
      } else {
        now = timerReading;
        expect(registration.expire(), label).toBe(true);
        // The clock comes back in time; the cause the timer saw stays.
        now = 5_000;
      }
      held.release();
      expect(await pending, label).toEqual({ ok: false, code });
      expect(saved.seen, label).toEqual(["verifying", "failed"]);
    }
  });

  it("an expiry before publication cancels it; one after it changes nothing", async () => {
    // Before: the deadline passes just before the commit's own liveness reading.
    let now = 5_000;
    const before = recording();
    const late = socket({
      clock: () => now,
      store: {
        persist: before.store.persist,
        commitRegistered: (snapshot, attempt) => {
          now = 65_001;
          return before.store.commitRegistered(snapshot, attempt);
        },
      },
    });
    expect(await late.register(proofFor(late))).toEqual({
      ok: false,
      code: "challenge_expired",
    });
    expect(before.seen).toEqual(["verifying", "commit", "cancelled", "failed"]);
    // After: the registration is complete; a timer or a socket end is teardown.
    now = 5_000;
    const after = recording();
    const done = socket({ clock: () => now, store: after.store });
    expect((await done.register(proofFor(done))).ok).toBe(true);
    now = 65_001;
    expect(done.expire()).toBe(false);
    done.abort();
    expect(done.state).toBe("registered");
    expect(after.seen).toEqual(["verifying", "commit", "committed"]);
    expect(socket({ restore: after.latest() }).state).toBe("registered");
  });

  it("completes in the same turn as the commit: an abort queued from it is teardown", async () => {
    let inCommit = false;
    let stateAtAbort: string | null = null;
    const saved = recording();
    const registration: ControlRegistration = socket({
      clock: () => {
        if (inCommit) {
          inCommit = false;
          queueMicrotask(() => {
            registration.abort();
            stateAtAbort = registration.state;
          });
        }
        return 5_000;
      },
      store: {
        persist: saved.store.persist,
        commitRegistered: (snapshot, attempt) => {
          inCommit = true;
          return saved.store.commitRegistered(snapshot, attempt);
        },
      },
    });
    expect((await registration.register(proofFor(registration))).ok).toBe(true);
    expect(stateAtAbort).toBe("registered");
    expect(registration.state).toBe("registered");
    expect(saved.seen).toEqual(["verifying", "commit", "committed"]);
    expect(socket({ restore: saved.latest() }).state).toBe("registered");
  });

  it("a failure that cannot be stored is store_failed, and leaves no success to restore", async () => {
    const saved = recording({ failFailure: true });
    const held = heldClaims();
    const registration = socket({ store: saved.store, claims: held.claims });
    const pending = registration.register(proofFor(registration));
    await held.reach();
    registration.abort();
    held.release();
    expect(await pending).toEqual({ ok: false, code: "store_failed" });
    expect(registration.state).toBe("failed");
    expect(saved.latest().state).toBe("verifying");
    expect(socket({ restore: saved.latest() }).state).toBe("failed");
  });

  it("only a liveness reading that prevents publication is a cancellation", async () => {
    const promised = Promise.resolve("committed" as const);
    type Answer = (
      attempt: { readonly live: boolean },
      end: () => void,
    ) => "committed" | "cancelled";
    const answers: Record<string, Answer> = {
      // An answer that comes later is no answer: what it publishes, and when, is unknown.
      "a promise": () => promised as unknown as "committed",
      "a throw after reading live": (attempt) => {
        void attempt.live;
        throw new Error("down");
      },
      "cancelled while live": (attempt) => (attempt.live, "cancelled"),
      "committed after the attempt ended": (attempt, end) => {
        end();
        return attempt.live ? "cancelled" : "committed";
      },
    };
    for (const [label, answer] of Object.entries(answers)) {
      const memory = new MemoryRegistrationStore();
      const registration: ControlRegistration = socket({
        store: {
          persist: (snapshot) => memory.persist(snapshot),
          commitRegistered: (_snapshot, attempt) => answer(attempt, () => registration.abort()),
        },
      });
      expect(await registration.register(proofFor(registration)), label).toEqual({
        ok: false,
        code: "store_failed",
      });
      expect(registration.state, label).toBe("failed");
      expect(memory.latest?.state, label).toBe("failed");
    }
  });

  it("a replay denial that arrives past the deadline reports the expiry, with no timer", async () => {
    let now = 5_000;
    const late = socket({
      clock: () => now,
      replay: { consume: () => ((now = 5_000 + 60_001), false) },
    });
    expect(await late.register(proofFor(late))).toEqual({ ok: false, code: "challenge_expired" });
    // In time, the denial stands.
    const inTime = socket({ replay: { consume: () => false } });
    expect(await inTime.register(proofFor(inTime))).toEqual({ ok: false, code: "replayed" });
  });

  it("stores failed in the same turn as a commit that wrote and then threw", async () => {
    const memory = new MemoryRegistrationStore();
    let afterThrow: string | undefined;
    const registration = socket({
      store: {
        persist: (snapshot) => memory.persist(snapshot),
        commitRegistered: (snapshot, attempt) => {
          memory.commitRegistered(snapshot, attempt);
          queueMicrotask(() => (afterThrow = memory.latest?.state));
          throw new Error("write not confirmed");
        },
      },
    });
    expect(await registration.register(proofFor(registration))).toEqual({
      ok: false,
      code: "store_failed",
    });
    // With a synchronous persist, nothing ran between the commit and the failed write.
    expect(afterThrow).toBe("failed");
  });

  it("a denial that arrives after the attempt ended reports why it ended", async () => {
    // The replay check waits; meanwhile the timer sees a clock rollback, an expired deadline,
    // or the socket closes. The clock then recovers and the replay check answers "seen".
    const cases: [
      string,
      (registration: ControlRegistration, set: (ms: number) => void) => void,
      string,
    ][] = [
      [
        "a clock that went back",
        (registration, set) => {
          set(4_000);
          expect(registration.expire()).toBe(true);
          set(5_000);
        },
        "bad_clock",
      ],
      [
        "a deadline that passed",
        (registration, set) => {
          set(5_000 + 60_001);
          expect(registration.expire()).toBe(true);
        },
        "challenge_expired",
      ],
      ["an abort", (registration) => registration.abort(), "aborted"],
    ];
    for (const [label, end, code] of cases) {
      let now = 5_000;
      let answer = (_seen: boolean): void => {};
      const saved = recording();
      const registration = socket({
        clock: () => now,
        store: saved.store,
        replay: { consume: () => new Promise<boolean>((resolve) => (answer = resolve)) },
      });
      const pending = registration.register(proofFor(registration));
      for (let i = 0; i < 5; i++) await Promise.resolve();
      end(registration, (ms) => (now = ms));
      answer(false);
      expect(await pending, label).toEqual({ ok: false, code });
      expect(saved.latest().state, label).toBe("failed");
    }
    // A storage fault still wins over the cause.
    let fail = (_error: unknown): void => {};
    const faulty = socket({
      replay: { consume: () => new Promise<boolean>((_resolve, reject) => (fail = reject)) },
      store: recording().store,
    });
    const faultPending = faulty.register(proofFor(faulty));
    for (let i = 0; i < 5; i++) await Promise.resolve();
    faulty.abort();
    fail(new Error("down"));
    expect(await faultPending).toEqual({ ok: false, code: "store_failed" });
  });

  it("checks each commit reply against the liveness reading the store took", async () => {
    type Answer = (
      attempt: { readonly live: boolean },
      end: () => void,
    ) => "committed" | "cancelled";
    const answers: Record<string, Answer> = {
      "committed without a reading": () => "committed",
      "cancelled after a direct abort, without a reading": (_attempt, end) => (end(), "cancelled"),
      "cancelled after a true reading, then an abort": (attempt, end) => {
        void attempt.live;
        end();
        return "cancelled";
      },
    };
    for (const [label, answer] of Object.entries(answers)) {
      const memory = new MemoryRegistrationStore();
      const registration: ControlRegistration = socket({
        store: {
          persist: (snapshot) => memory.persist(snapshot),
          commitRegistered: (_snapshot, attempt) => answer(attempt, () => registration.abort()),
        },
      });
      expect(await registration.register(proofFor(registration)), label).toEqual({
        ok: false,
        code: "store_failed",
      });
      expect(registration.state, label).toBe("failed");
      expect(memory.latest?.state, label).toBe("failed");
    }
    // A false reading with the attempt ended is a real cancellation.
    let now = 5_000;
    const cancelled = socket({
      clock: () => now,
      store: {
        persist: () => {},
        commitRegistered: (_snapshot, attempt) => {
          now = 5_000 + 60_001;
          return attempt.live ? "committed" : "cancelled";
        },
      },
    });
    expect(await cancelled.register(proofFor(cancelled))).toEqual({
      ok: false,
      code: "challenge_expired",
    });
  });

  it("a malformed reply that cannot be observed still ends the attempt as a storage fault", async () => {
    const throwingThen = Promise.resolve("committed");
    Object.defineProperty(throwingThen, "then", {
      get() {
        throw new Error("then getter");
      },
    });
    const throwingConstructor = Promise.resolve("committed");
    Object.defineProperty(throwingConstructor, "constructor", {
      get() {
        throw new Error("constructor getter");
      },
    });
    const hostileProxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("prototype trap");
        },
        get() {
          throw new Error("get trap");
        },
      },
    );
    const replies: Record<string, unknown> = {
      "a promise whose own then getter throws": throwingThen,
      "a promise whose constructor getter throws": throwingConstructor,
      "a proxy that throws on every trap": hostileProxy,
    };
    for (const [label, reply] of Object.entries(replies)) {
      const memory = new MemoryRegistrationStore();
      const registration = socket({
        store: {
          persist: (snapshot) => memory.persist(snapshot),
          commitRegistered: (_snapshot, attempt) => (void attempt.live, reply as "committed"),
        },
      });
      expect(await registration.register(proofFor(registration)), label).toEqual({
        ok: false,
        code: "store_failed",
      });
      expect(registration.state, label).toBe("failed");
      expect(memory.latest?.state, label).toBe("failed");
    }
  });

  it("an abort just after the proof checks out asks the store for no success", async () => {
    let afterClaim = false;
    const saved = recording();
    const registration: ControlRegistration = socket({
      // The reading after the claim ends the socket once the attempt's next step has begun.
      clock: () => {
        if (afterClaim) {
          afterClaim = false;
          queueMicrotask(() => registration.abort());
        }
        return 5_000;
      },
      claims: {
        claim: (_id, _key, attempt) => {
          const live = attempt.live;
          afterClaim = true;
          return live;
        },
      },
      store: saved.store,
    });
    expect(await registration.register(proofFor(registration))).toEqual({
      ok: false,
      code: "aborted",
    });
    expect(saved.seen).toEqual(["verifying", "failed"]);
  });

  it("a clock that ends the attempt while it is read cannot revive it", async () => {
    // Without a store: the abort comes from the last reading before success.
    let abortOnRead = false;
    const registration: ControlRegistration = socket({
      clock: () => {
        if (abortOnRead) registration.abort();
        return 5_000;
      },
      claims: {
        claim: (_id, _key, attempt) => {
          const live = attempt.live;
          abortOnRead = true;
          return live;
        },
      },
    });
    expect(await registration.register(proofFor(registration))).toEqual({
      ok: false,
      code: "aborted",
    });
    expect(registration.state).toBe("failed");

    // With a store: the abort comes from the reading the commit makes of `live`.
    let inCommit = false;
    const memory = new MemoryRegistrationStore();
    const seen: string[] = [];
    const committing: ControlRegistration = socket({
      clock: () => {
        if (inCommit) committing.abort();
        return 5_000;
      },
      store: {
        persist: (snapshot) => void (seen.push(snapshot.state), memory.persist(snapshot)),
        commitRegistered: (snapshot, attempt) => {
          inCommit = true;
          const outcome = memory.commitRegistered(snapshot, attempt);
          inCommit = false;
          seen.push(outcome);
          return outcome;
        },
      },
    });
    expect(await committing.register(proofFor(committing))).toEqual({
      ok: false,
      code: "aborted",
    });
    expect(seen).toEqual(["verifying", "cancelled", "failed"]);
  });

  it("an uninterrupted success is committed once and leaves the attempt no longer live", async () => {
    const saved = recording();
    let claimed: { readonly live: boolean } | null = null;
    const registration = socket({
      store: saved.store,
      claims: { claim: (_id, _key, attempt) => ((claimed = attempt), attempt.live) },
    });
    expect((await registration.register(proofFor(registration))).ok).toBe(true);
    expect(registration.state).toBe("registered");
    expect(saved.seen).toEqual(["verifying", "commit", "committed"]);
    expect(claimed!.live).toBe(false);
    expect(socket({ restore: saved.latest() }).state).toBe("registered");
  });

  it("the reference store takes a success only through a commit that finds the attempt live", () => {
    const memory = new MemoryRegistrationStore();
    const snapshot = socket().snapshot();
    const registered = { ...snapshot, state: "registered" as const };
    expect(() => memory.persist(registered)).toThrow(RelayProtocolError);
    expect(() => memory.commitRegistered(snapshot, { live: true })).toThrow(RelayProtocolError);
    expect(() => memory.persist({ ...snapshot, lastReadingMs: Number.NaN })).toThrow(
      RelayProtocolError,
    );
    expect(memory.commitRegistered(registered, { live: false })).toBe("cancelled");
    expect(memory.latest).toBeNull();
    expect(memory.commitRegistered(registered, { live: true })).toBe("committed");
    expect(memory.latest).toEqual(registered);
  });

  it("the reference store hands out copies of what it stored", () => {
    const memory = new MemoryRegistrationStore();
    const registration = socket();
    memory.persist(registration.snapshot());
    const seen = memory.latest as { state: string };
    seen.state = "registered";
    expect(memory.latest?.state).toBe("challenged");
  });

  it("the reference store copies the snapshot before its liveness reading", () => {
    let live = true;
    const memory = new MemoryRegistrationStore();
    const original = socket().snapshot();
    // A getter on the input that ends the attempt runs before `live` is read, not after.
    const snapshot = {
      ...original,
      state: "registered" as const,
      get lastReadingMs() {
        live = false;
        return original.lastReadingMs;
      },
    };
    expect(
      memory.commitRegistered(snapshot, {
        get live() {
          return live;
        },
      }),
    ).toBe("cancelled");
    expect(memory.latest).toBeNull();
  });

  it("fails an attempt whose clock goes back between readings, whatever it reads later", async () => {
    // Issued at 5,000; in time at 55,000; then 10,000, still inside the window but behind.
    for (const later of [10_000, 55_000, 60_000]) {
      const readings = [5_000, 55_000, 10_000];
      const registration = socket({ clock: () => readings.shift() ?? later });
      expect(await registration.register(proofFor(registration)), String(later)).toEqual({
        ok: false,
        code: "bad_clock",
      });
      expect(registration.state).toBe("failed");
    }
  });

  it("a lower reading inside the key claim ends the attempt with bad_clock", async () => {
    let now = 5_000;
    let live: boolean | null = null;
    const registration = socket({
      clock: () => now,
      replay: { consume: () => ((now = 55_000), true) },
      claims: {
        claim: (_id, _key, attempt) => {
          now = 10_000;
          live = attempt.live;
          now = 55_000;
          return live;
        },
      },
    });
    expect(await registration.register(proofFor(registration))).toEqual({
      ok: false,
      code: "bad_clock",
    });
    expect(live).toBe(false);
    expect(registration.state).toBe("failed");
  });

  it("stores verifying before any store is asked, and the outcome before it returns", async () => {
    const saved = recording();
    const replay = new MemoryReplayStore();
    const registration = socket({
      store: saved.store,
      replay: { consume: (input) => (saved.seen.push("replay"), replay.consume(input)) },
    });
    expect((await registration.register(proofFor(registration))).ok).toBe(true);
    expect(saved.seen).toEqual(["verifying", "replay", "commit", "committed"]);
    const failing = socket({
      store: {
        persist: () => Promise.reject(new Error("down")),
        commitRegistered: () => "committed",
      },
    });
    expect(await failing.register(proofFor(failing))).toEqual({ ok: false, code: "store_failed" });
    expect(failing.state).toBe("failed");
    // A clock failure ends the attempt early; its failure is stored too.
    let now = 5_000;
    const early = recording();
    const clocked = socket({
      clock: () => now,
      store: early.store,
      replay: { consume: () => ((now = Number.NaN), true) },
    });
    expect(await clocked.register(proofFor(clocked))).toEqual({ ok: false, code: "bad_clock" });
    expect(early.seen).toEqual(["verifying", "failed"]);
  });

  it("pins its origin when it starts; changing the options later changes nothing", async () => {
    const options = {
      relayId,
      origin: "wss://Relay.Example.TEST:443",
      clock: () => 5_000,
      wallClock: () => NOW_MS,
      replay: new MemoryReplayStore(),
      claims: new MemoryKeyClaims(),
    };
    const registration = new ControlRegistration(options);
    options.origin = "wss://other.example.test";
    expect(registration.origin).toBe(AUDIENCE);
    expect((await registration.register(proofFor(registration))).ok).toBe(true);
  });

  it("checks the origin as written, before normalizing it, and allows ws: only on loopback in tests", () => {
    for (const bad of [
      "wss://relay.example.test/./",
      "wss://relay.example.test/a/..",
      "wss://relay.example.test?",
      "wss://relay.example.test#",
      "wss://relay.example.test//",
      "wss://relay.example.test%2f",
      " wss://relay.example.test",
    ]) {
      expect(() => canonicalRelayOrigin(bad), bad).toThrow(RelayProtocolError);
    }
    expect(() => canonicalRelayOrigin("ws://relay.example.test")).toThrow(RelayProtocolError);
    expect(() =>
      canonicalRelayOrigin("ws://relay.example.test", { allowLoopbackWs: true }),
    ).toThrow(RelayProtocolError);
    expect(() => canonicalRelayOrigin("ws://127.0.0.1:8787")).toThrow(RelayProtocolError);
    expect(canonicalRelayOrigin("ws://[::1]:8787", { allowLoopbackWs: true })).toBe(
      "ws://[::1]:8787",
    );
    expect(canonicalRelayOrigin("wss://relay.example.test:8443/")).toBe(
      "wss://relay.example.test:8443",
    );
  });

  it("survives hibernation as a snapshot; an attempt cut off by it is not resumed", async () => {
    const registration = socket();
    const snapshot = registration.snapshot();
    const restored = socket({ restore: snapshot });
    expect(restored.challengeMessage).toBe(registration.challengeMessage);
    expect((await restored.register(proofFor(registration))).ok).toBe(true);
    // Only a challenge, a committed success or a failure is restored; anything else fails.
    for (const state of ["verifying", "prepared"]) {
      const cut = socket({ restore: { ...snapshot, state } as unknown as RegistrationSnapshot });
      expect(cut.state, state).toBe("failed");
    }
    expect(socket({ restore: { ...snapshot, state: "registered" } }).state).toBe("registered");
    expect(() => socket({ restore: { ...snapshot, lastReadingMs: 4_999 } })).toThrow(
      RelayProtocolError,
    );
  });

  it("keeps the last clock reading across hibernation, so a lower one is refused", async () => {
    let now = 5_000;
    const clock = () => now;
    const original = socket({ clock });
    now = 55_000;
    expect(original.expire()).toBe(false);
    const snapshot = original.snapshot();
    expect(snapshot).toMatchObject({
      state: "challenged",
      issuedAtMs: 5_000,
      lastReadingMs: 55_000,
    });
    now = 10_000;
    const restored = socket({ clock, restore: snapshot });
    expect(await restored.register(proofFor(restored))).toEqual({ ok: false, code: "bad_clock" });
    expect(restored.state).toBe("failed");
  });
});

describe("clock inputs", () => {
  const badTimes = [Number.NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY];

  it("an enrollment offer refuses a time that is not whole nonnegative milliseconds", () => {
    const secret = new Uint8Array(32).fill(5);
    for (const time of badTimes) {
      expect(() => new EnrollmentOffer(secret, time), String(time)).toThrow(
        expect.objectContaining({ code: "bad_time" }),
      );
      const offer = new EnrollmentOffer(secret, 100);
      expect(() => offer.matches(secret, time), String(time)).toThrow(
        expect.objectContaining({ code: "bad_time" }),
      );
      expect(() => offer.spend(time), String(time)).toThrow(
        expect.objectContaining({ code: "bad_time" }),
      );
      expect(offer.used).toBe(false);
    }
  });

  it("proof creation and verification fail closed on a bad clock", async () => {
    const proof = createRegisterProof({ secretKey, audience: AUDIENCE, nonce, nowMs: NOW_MS });
    for (const time of badTimes) {
      expect(await verify(proof, { nowMs: time }), String(time)).toEqual({
        ok: false,
        code: "bad_clock",
      });
      expect(
        () => createRegisterProof({ secretKey, audience: AUDIENCE, nonce, nowMs: time }),
        String(time),
      ).toThrow(expect.objectContaining({ code: "bad_time" }));
    }
    for (const clock of [() => Number.NaN, () => -5]) {
      const registration = new ControlRegistration({
        relayId,
        origin: AUDIENCE,
        clock: () => 0,
        wallClock: clock,
        replay: new MemoryReplayStore(),
        claims: new MemoryKeyClaims(),
      });
      expect(await registration.register(proof)).toEqual({ ok: false, code: "bad_clock" });
    }
  });

  it("refuses an iat whose replay record could not be kept in safe milliseconds", async () => {
    const largest = Math.floor(Number.MAX_SAFE_INTEGER / 1_000) - 61;
    const nowAt = (iat: number) => iat * 1_000;
    expect((await verify(sign(payload({ iat: largest })), { nowMs: nowAt(largest) })).ok).toBe(
      true,
    );
    expect(await verify(sign(payload({ iat: largest + 1 })), { nowMs: nowAt(largest) })).toEqual({
      ok: false,
      code: "malformed_proof",
    });
  });

  it("refuses a signed payload with a repeated member name", async () => {
    const good = JSON.stringify(payload());
    const repeated = good.replace('"aud":', '"aud":"wss://other.example.test","aud":');
    const encoded = toBase64Url(new TextEncoder().encode(repeated));
    const message = new TextEncoder().encode(`clawtrate relay register proof\n${encoded}`);
    const proof = `${encoded}.${toBase64Url(ed25519.sign(message, secretKey))}`;
    expect(await verify(proof)).toEqual({ ok: false, code: "malformed_proof" });
  });

  it("refuses to sign an iat past the replay record's range, or a nonce that is not canonical", () => {
    const largest = Math.floor(Number.MAX_SAFE_INTEGER / 1_000) - 61;
    expect(() =>
      createRegisterProof({ secretKey, audience: AUDIENCE, nonce, nowMs: largest * 1_000 }),
    ).not.toThrow();
    expect(() =>
      createRegisterProof({ secretKey, audience: AUDIENCE, nonce, nowMs: (largest + 1) * 1_000 }),
    ).toThrow(expect.objectContaining({ code: "bad_time" }));
    for (const bad of [`${nonce}A`, nonce.slice(1), "", `${nonce.slice(0, 42)}B`, "a".repeat(43)]) {
      if (bad === nonce) continue;
      expect(
        () => createRegisterProof({ secretKey, audience: AUDIENCE, nonce: bad, nowMs: NOW_MS }),
        bad,
      ).toThrow(expect.objectContaining({ code: "malformed" }));
    }
  });

  it("checks a proof's type and length before trimming or splitting it", async () => {
    const huge = " ".repeat(1_000_000);
    const trim = vi.spyOn(String.prototype, "trim");
    expect(await verify(huge)).toEqual({ ok: false, code: "malformed_proof" });
    expect(trim).not.toHaveBeenCalled();
    trim.mockRestore();
    expect(await verify(7 as unknown as string)).toEqual({ ok: false, code: "missing_proof" });
    expect(await verify("   ")).toEqual({ ok: false, code: "missing_proof" });
  });
});
