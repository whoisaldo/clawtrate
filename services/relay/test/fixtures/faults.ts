// Test doubles shared by the Node tests and the Worker fixture: a store whose replay or pin
// table fails, and a room clock that runs faster than real time.

import type { SqlDriver } from "../../src/core/index.ts";

export type Fault = "replay" | "claims";

const FAULT_TABLES: Record<Fault, string> = { replay: "relay_replay", claims: "relay_pins" };

/** Every query on the fault's table throws, as a storage error would; creating it still works. */
export function faultySql(sql: SqlDriver, fault: Fault): SqlDriver {
  const table = FAULT_TABLES[fault];
  return {
    all: (query, ...params) => {
      if (query.includes(table) && !query.trimStart().startsWith("CREATE")) {
        throw new Error(`Test fault: ${table} is unavailable.`);
      }
      return sql.all(query, ...params);
    },
    transaction: (fn) => sql.transaction(fn),
  };
}

/**
 * A room clock that runs `factor` times faster than the Date clock from `epoch`, so the relay's
 * real deadlines (a 60-second challenge, a two-minute idle limit) pass in a test's seconds.
 */
export function warpedClock(epoch: number, factor: number) {
  const now = () => Math.floor(epoch + (Date.now() - epoch) * factor);
  return {
    now,
    wall: () => Date.now(),
    fromDate: (dateMs: number) => Math.floor(epoch + (dateMs - epoch) * factor),
    toDate: (at: number) => Math.ceil(epoch + (at - epoch) / factor),
    delayUntil: (at: number) => Math.max(0, Math.ceil((at - now()) / factor)),
  };
}
