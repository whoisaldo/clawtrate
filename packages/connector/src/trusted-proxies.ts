// `gateway.trustedProxies`, which makes the gateway accept the connector's forwarded upgrade as
// one through a trusted proxy (remote) instead of refusing it (docs/research/relay.md).
//
// Turning it on records the exact earlier value first (absent, or the list as it was), sets the
// union of that list with the loopback addresses, and reads it back to verify. Turning it off
// puts back exactly the recorded value and reads it back again: "restored" is never inferred
// from having written a command. If someone changed the setting since the connector set it,
// nothing is overwritten and the record is kept.

import { objectWithKeys, versionOne, type StateDir } from "./state.ts";
import { runJson, type OpenclawRunner } from "./openclaw.ts";

export const LOOPBACK_PROXIES: readonly string[] = ["127.0.0.1", "::1"];
export const TRUSTED_PROXIES_FILE = "trusted-proxies.json";

/** A config value as the connector saw it: absent, or a list of addresses. */
export type ProxiesValue =
  { readonly present: false } | { readonly present: true; readonly value: readonly string[] };

export interface ProxiesRecord {
  /** Exactly what was there before the connector changed anything. */
  readonly earlier: ProxiesValue;
  /** What the connector set (the union). */
  readonly applied: readonly string[];
  /** False when the earlier value already covered loopback and nothing was written. */
  readonly changed: boolean;
}

/** How the connector reads and writes the one setting. */
export interface ProxiesConfig {
  read(): Promise<ProxiesValue>;
  /** Sets the list, only if the current value is still `expect`. */
  write(value: readonly string[], expect: ProxiesValue): Promise<void>;
  /** Removes the setting. */
  remove(): Promise<void>;
}

export class TrustedProxiesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrustedProxiesError";
  }
}

export function sameValue(a: ProxiesValue, b: ProxiesValue): boolean {
  if (!a.present || !b.present) return a.present === b.present;
  return a.value.length === b.value.length && a.value.every((item, i) => item === b.value[i]);
}

function listValue(value: unknown, what: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new TrustedProxiesError(
      `${what} is not a list of addresses; the connector leaves it alone.`,
    );
  }
  return value as string[];
}

function parseValue(value: unknown): ProxiesValue {
  const record = value as Record<string, unknown>;
  if (record?.present === false) {
    objectWithKeys(value, ["present"]);
    return { present: false };
  }
  objectWithKeys(value, ["present", "value"]);
  if (record.present !== true) throw new Error("present is not true or false");
  return { present: true, value: listValue(record.value, "value") };
}

export function parseRecord(value: unknown): ProxiesRecord {
  const record = objectWithKeys(value, ["v", "earlier", "applied", "changed"]);
  versionOne(record);
  if (typeof record.changed !== "boolean") throw new Error("changed is not true or false");
  return {
    earlier: parseValue(record.earlier),
    applied: listValue(record.applied, "applied"),
    changed: record.changed,
  };
}

/** The earlier list followed by whichever loopback addresses it lacks. */
export function unionWithLoopback(earlier: ProxiesValue): readonly string[] {
  const base = earlier.present ? earlier.value : [];
  return [...base, ...LOOPBACK_PROXIES.filter((address) => !base.includes(address))];
}

/**
 * Records, sets and verifies. Running it again after a success checks that the setting is
 * still what was applied and changes nothing.
 */
export async function enableTrustedProxies(
  state: StateDir,
  config: ProxiesConfig,
): Promise<ProxiesRecord> {
  const existing = state.read(TRUSTED_PROXIES_FILE, parseRecord);
  if (existing !== null) {
    const current = await config.read();
    if (!sameValue(current, { present: true, value: existing.applied })) {
      throw new TrustedProxiesError(
        "gateway.trustedProxies changed after the connector set it. The connector leaves it alone; check it, then run teardown and setup again.",
      );
    }
    return existing;
  }
  const earlier = await config.read();
  const applied = unionWithLoopback(earlier);
  const changed = !sameValue(earlier, { present: true, value: applied });
  const record: ProxiesRecord = { earlier, applied, changed };
  // The record is kept before anything changes, so a crash between the two can still be undone.
  state.write(TRUSTED_PROXIES_FILE, { v: 1, ...record });
  if (changed) await config.write(applied, earlier);
  const verified = await config.read();
  if (!sameValue(verified, { present: true, value: applied })) {
    throw new TrustedProxiesError(
      `gateway.trustedProxies reads back as ${describe(verified)}, not ${describe({ present: true, value: applied })}.`,
    );
  }
  return record;
}

export type RestoreOutcome =
  /** The recorded value was put back and read back. */
  | "restored"
  /** The connector had changed nothing. */
  | "unchanged"
  /** There was no record. */
  | "nothing";

/** Puts back exactly the recorded earlier value, verifies it, then drops the record. */
export async function restoreTrustedProxies(
  state: StateDir,
  config: ProxiesConfig,
): Promise<RestoreOutcome> {
  const record = state.read(TRUSTED_PROXIES_FILE, parseRecord);
  if (record === null) return "nothing";
  if (!record.changed) {
    state.remove(TRUSTED_PROXIES_FILE);
    return "unchanged";
  }
  const current = await config.read();
  if (!sameValue(current, record.earlier)) {
    if (!sameValue(current, { present: true, value: record.applied })) {
      throw new TrustedProxiesError(
        `gateway.trustedProxies is now ${describe(current)}, which the connector did not set; it was left as it is.`,
      );
    }
    if (record.earlier.present) {
      await config.write(record.earlier.value, { present: true, value: record.applied });
    } else {
      await config.remove();
    }
    const verified = await config.read();
    if (!sameValue(verified, record.earlier)) {
      throw new TrustedProxiesError(
        `gateway.trustedProxies reads back as ${describe(verified)}, not the earlier ${describe(record.earlier)}.`,
      );
    }
  }
  state.remove(TRUSTED_PROXIES_FILE);
  return "restored";
}

export function readProxiesRecord(state: StateDir): ProxiesRecord | null {
  return state.read(TRUSTED_PROXIES_FILE, parseRecord);
}

function describe(value: ProxiesValue): string {
  return value.present ? JSON.stringify(value.value) : "absent";
}

/**
 * The setting through OpenClaw's command line. Reading takes the `gateway` section, which a
 * running gateway always has, and looks for the key in it, so "absent" is told apart from a
 * failure. Writing is conditional on the value read (`--expect-current-json` or
 * `--expect-current-absent`), so a change made in between is refused rather than overwritten.
 */
export function openclawProxiesConfig(run: OpenclawRunner): ProxiesConfig {
  return {
    async read() {
      const gateway = await runJson(run, ["config", "get", "gateway", "--json"]);
      if (typeof gateway !== "object" || gateway === null || Array.isArray(gateway)) {
        throw new TrustedProxiesError("openclaw config get gateway did not print an object.");
      }
      if (!Object.hasOwn(gateway, "trustedProxies")) return { present: false };
      return {
        present: true,
        value: listValue(
          (gateway as Record<string, unknown>).trustedProxies,
          "gateway.trustedProxies",
        ),
      };
    },
    async write(value, expect) {
      const args = [
        "config",
        "set",
        "gateway.trustedProxies",
        JSON.stringify(value),
        "--strict-json",
      ];
      args.push(
        ...(expect.present
          ? ["--expect-current-json", JSON.stringify(expect.value)]
          : ["--expect-current-absent"]),
      );
      const result = await run(args);
      if (result.status !== 0) {
        throw new TrustedProxiesError(
          `openclaw config set gateway.trustedProxies failed (exit ${result.status}); nothing was changed.`,
        );
      }
    },
    async remove() {
      const result = await run(["config", "unset", "gateway.trustedProxies"]);
      if (result.status !== 0) {
        throw new TrustedProxiesError(
          `openclaw config unset gateway.trustedProxies failed (exit ${result.status}).`,
        );
      }
    },
  };
}
