// The relay's SQLite store, on Node's `node:sqlite` (the Durable Object runs the same SQL, and
// `relay.test.ts` covers it there).
//
// The replay window case and the key pin case port test scenarios from T3 Code
// (https://github.com/pingdotgg/t3code) at commit 18d1c4db:
// infra/relay/src/auth/DpopProofs.verifyAndConsume.test.ts ("rejects replays until a future
// proof's time window closes") and infra/relay/src/environments/EnvironmentLinker.test.ts
// ("refuses to move an active link to a different environment key").
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

import { DatabaseSync } from "node:sqlite";
import {
  createRegisterNonce,
  createRegisterProof,
  toBase64Url,
  verifyRegisterProof,
} from "@clawtrate/relay-protocol";
import { describe, expect, it } from "vitest";
import { RATE_WINDOW_MS, RelayStore, REPLAY_RETENTION_GRACE_MS } from "../src/core/index.ts";
import { sqliteDriver } from "../src/node/server.ts";
import { connectorKey } from "./support.ts";

function newStore() {
  const driver = sqliteDriver(new DatabaseSync(":memory:"));
  return { store: new RelayStore(driver), driver };
}

const ORIGIN = "wss://relay.example.test";

describe("the replay store", () => {
  it("rejects replays until a future proof's time window closes", async () => {
    const { store } = newStore();
    const key = connectorKey();
    const nonce = createRegisterNonce();
    const now = Date.UTC(2026, 4, 25, 12);
    // Signed by a connector whose clock runs 60 seconds ahead, the most the relay allows.
    const proof = createRegisterProof({
      secretKey: key.secretKey,
      audience: ORIGIN,
      nonce,
      nowMs: now + 60_000,
    });
    const input = { proof, relayId: key.relayId, audience: ORIGIN, nonce, replay: store.replay };
    expect(await verifyRegisterProof({ ...input, nowMs: now })).toMatchObject({ ok: true });
    for (const { elapsedMs, code } of [
      { elapsedMs: 0, code: "replayed" },
      { elapsedMs: 61_000, code: "replayed" },
      { elapsedMs: 120_999, code: "replayed" },
      { elapsedMs: 121_000, code: "time_window" },
    ]) {
      const result = await verifyRegisterProof({ ...input, nowMs: now + elapsedMs });
      expect(result, `Replay after ${elapsedMs}ms`).toEqual({ ok: false, code });
    }
  });

  it("records a jti once per scope, and keeps it for an hour past its expiry", () => {
    const { store, driver } = newStore();
    const consume = (scope: string, nowMs: number) =>
      store.replay.consume({ scope, jti: "j1", expiresAtMs: 10_000, nowMs });
    expect(consume("a", 1_000)).toBe(true);
    expect(consume("a", 1_000)).toBe(false);
    expect(consume("b", 1_000)).toBe(true);
    // A wall clock that jumps forward and back within the grace cannot revive the jti.
    expect(consume("a", 10_000 + REPLAY_RETENTION_GRACE_MS - 1)).toBe(false);
    expect(driver.all("SELECT COUNT(*) AS n FROM relay_replay")).toEqual([{ n: 2 }]);
    expect(consume("a", 10_000 + REPLAY_RETENTION_GRACE_MS)).toBe(true);
    // Both old rows were pruned; only the new one is left.
    expect(driver.all("SELECT COUNT(*) AS n FROM relay_replay")).toEqual([{ n: 1 }]);
  });
});

describe("the key pins", () => {
  it("refuses to move a pinned relay id to a different key", () => {
    const { store } = newStore();
    const live = { live: true };
    const pinned = connectorKey();
    const other = connectorKey();
    expect(store.claims.claim(pinned.relayId, pinned.publicKey, live)).toBe(true);
    expect(store.claims.claim(pinned.relayId, pinned.publicKey, live)).toBe(true);
    expect(store.claims.claim(pinned.relayId, other.publicKey, live)).toBe(false);
    expect(store.pinnedKey(pinned.relayId)).toBe(toBase64Url(pinned.publicKey));
  });

  it("records nothing for an attempt that is no longer live", () => {
    const { store } = newStore();
    const key = connectorKey();
    expect(store.claims.claim(key.relayId, key.publicKey, { live: false })).toBe(false);
    expect(store.pinnedKey(key.relayId)).toBeNull();
  });
});

describe("the per-minute counts", () => {
  it("allows up to the limit in a window, and starts again after it or after the clock goes back", () => {
    const { store } = newStore();
    expect([1, 2, 3].map((i) => store.hit("r dial", 1_000 + i, 2))).toEqual([true, true, false]);
    expect(store.hit("r other", 1_004, 2)).toBe(true);
    expect(store.hit("r dial", 1_001 + RATE_WINDOW_MS, 2)).toBe(true);
    expect(store.hit("r dial", 1_002 + RATE_WINDOW_MS, 2)).toBe(true);
    expect(store.hit("r dial", 1_003 + RATE_WINDOW_MS, 2)).toBe(false);
    expect(store.hit("r dial", 500, 2)).toBe(true);
  });
});
