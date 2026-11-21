// The relay's durable state for a relay id, in SQLite: the register proofs' jtis, the key each
// relay id is pinned to, and the per-minute counts. The same SQL runs in a Durable Object's
// SQLite storage and in Node's `node:sqlite`.
//
// Ported from T3 Code (https://github.com/pingdotgg/t3code) at commit 18d1c4db:
// infra/relay/src/auth/DpopProofs.ts (`consume`: one insert that does nothing on conflict, and
// the proof counts as fresh only if the insert returned its row) and
// infra/relay/src/environments/EnvironmentLinker.ts (an id already linked to one key is never
// moved to another). The SQLite schema, the pruning grace and the rate counts are Clawtrate's own.
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

import { toBase64Url, type KeyClaims, type ReplayStore } from "@clawtrate/relay-protocol";
import { RATE_WINDOW_MS, REPLAY_RETENTION_GRACE_MS } from "./limits.ts";

export type SqlValue = string | number | null;

/**
 * Synchronous SQLite. `transaction` runs its function as one atomic step: in a Durable Object,
 * `transactionSync`; in Node, BEGIN IMMEDIATE and COMMIT. Any failure throws.
 */
export interface SqlDriver {
  all(query: string, ...params: SqlValue[]): Record<string, unknown>[];
  transaction<T>(fn: () => T): T;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS relay_replay (
    scope TEXT NOT NULL,
    jti TEXT NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    PRIMARY KEY (scope, jti)
  )`,
  `CREATE TABLE IF NOT EXISTS relay_pins (
    relay_id TEXT PRIMARY KEY,
    public_key TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS relay_rates (
    bucket TEXT PRIMARY KEY,
    window_start_ms INTEGER NOT NULL,
    count INTEGER NOT NULL
  )`,
];

/** What a room needs of its store. `RelayStore` is the one both runtimes use. */
export interface RoomStore {
  readonly replay: ReplayStore;
  readonly claims: KeyClaims;
  /** Counts one event in `bucket`'s current minute; true while the count is within `limit`. */
  hit(bucket: string, nowMs: number, limit: number): boolean;
}

export class RelayStore implements RoomStore {
  readonly #sql: SqlDriver;
  readonly replay: ReplayStore;
  readonly claims: KeyClaims;

  constructor(sql: SqlDriver) {
    this.#sql = sql;
    for (const statement of SCHEMA) sql.all(statement);
    this.replay = { consume: (input) => this.#consume(input) };
    this.claims = {
      claim: (relayId, publicKey, attempt) => this.#claim(relayId, publicKey, attempt),
    };
  }

  /**
   * Counts one event in `bucket`'s current minute and says whether it is within `limit`. A
   * window from a clock that went back is started again.
   */
  hit(bucket: string, nowMs: number, limit: number): boolean {
    return this.#sql.transaction(() => {
      this.#sql.all(
        "DELETE FROM relay_rates WHERE window_start_ms <= ? OR window_start_ms > ?",
        nowMs - RATE_WINDOW_MS,
        nowMs,
      );
      const [row] = this.#sql.all("SELECT count FROM relay_rates WHERE bucket = ?", bucket);
      if (row === undefined) {
        this.#sql.all(
          "INSERT INTO relay_rates (bucket, window_start_ms, count) VALUES (?, ?, 1)",
          bucket,
          nowMs,
        );
        return 1 <= limit;
      }
      const count = Number(row.count) + 1;
      this.#sql.all("UPDATE relay_rates SET count = ? WHERE bucket = ?", count, bucket);
      return count <= limit;
    });
  }

  /** The key a relay id is pinned to, base64url, or null. */
  pinnedKey(relayId: string): string | null {
    const [row] = this.#sql.all("SELECT public_key FROM relay_pins WHERE relay_id = ?", relayId);
    return row === undefined ? null : String(row.public_key);
  }

  /** One atomic step: prune, then insert the jti unless it is there. True only if it was not. */
  #consume(input: {
    readonly scope: string;
    readonly jti: string;
    readonly expiresAtMs: number;
    readonly nowMs: number;
  }): boolean {
    return this.#sql.transaction(() => {
      this.#sql.all(
        "DELETE FROM relay_replay WHERE expires_at_ms <= ?",
        input.nowMs - REPLAY_RETENTION_GRACE_MS,
      );
      const inserted = this.#sql.all(
        `INSERT INTO relay_replay (scope, jti, expires_at_ms) VALUES (?, ?, ?)
         ON CONFLICT (scope, jti) DO NOTHING RETURNING jti`,
        input.scope,
        input.jti,
        input.expiresAtMs,
      );
      return inserted.length === 1;
    });
  }

  /**
   * One atomic step: reads `attempt.live`, then pins an unclaimed id to `publicKey`. True for a
   * new pin or the key already pinned; false for another key or a dead attempt, which records
   * nothing.
   */
  #claim(relayId: string, publicKey: Uint8Array, attempt: { readonly live: boolean }): boolean {
    const key = toBase64Url(publicKey);
    return this.#sql.transaction(() => {
      if (!attempt.live) return false;
      const pinned = this.pinnedKey(relayId);
      if (pinned === null) {
        this.#sql.all("INSERT INTO relay_pins (relay_id, public_key) VALUES (?, ?)", relayId, key);
        return true;
      }
      return pinned === key;
    });
  }
}
