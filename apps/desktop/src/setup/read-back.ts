// The host's read-back after an approval (docs/design/setup.md §9): on the
// gateway's computer, through the gateway itself at the verified loopback
// endpoint, the gateway's identity and then its device list. Two fixed
// commands, both reads; nothing here changes the gateway. The client decides
// what the answers mean (`@clawtrate/core` `approval.ts`).

import type { GatewayIdentityRead, ReadBack } from "@clawtrate/core";
import type { ProgramResult, RunProgram } from "./programs.ts";

/** The two reads, each a fixed `gateway call` for the verified address. */
export const READ_BACK_METHODS = ["gateway.identity.get", "device.pair.list"] as const;
export type ReadBackMethod = (typeof READ_BACK_METHODS)[number];

/** The most of each answer the host reads, in bytes: an identity is two short fields, a list may be long. */
export const READ_BACK_BYTES: Record<ReadBackMethod, number> = {
  "gateway.identity.get": 4 * 1024,
  "device.pair.list": 256 * 1024,
};
const READ_BACK_TIMEOUT_MS = 20_000;

/** The arguments of one read, after the profile's own: `gateway call <method> --expect-url <url> --json`. */
export const readBackArgs = (method: ReadBackMethod, url: string): string[] => [
  "gateway",
  "call",
  method,
  "--expect-url",
  url,
  "--json",
];

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** One whole JSON document, or null: `--json` output spans lines, so it is never read line by line. */
function document(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** `gateway.identity.get`'s answer: the gateway's device id and public key, or null for anything else. */
export function parseIdentity(text: string): GatewayIdentityRead | null {
  const body = record(document(text));
  const deviceId = body?.deviceId;
  const publicKey = body?.publicKey;
  return typeof deviceId === "string" &&
    /^[0-9a-f]{64}$/.test(deviceId) &&
    typeof publicKey === "string" &&
    publicKey.length > 0 &&
    publicKey.length <= 128
    ? { deviceId, publicKey }
    : null;
}

/** `device.pair.list`'s answer, whole: an object with its `pending` and `paired` lists, or null. */
export function parseDeviceList(text: string): { pending: unknown[]; paired: unknown[] } | null {
  const body = record(document(text));
  return body && Array.isArray(body.pending) && Array.isArray(body.paired)
    ? { pending: body.pending, paired: body.paired }
    : null;
}

/** OpenClaw's exit code, only when the program ran to its own end; null when it was ended or didn't start. */
const exitOf = (result: ProgramResult): number | null =>
  result.timedOut || result.failed || result.tooLarge ? null : result.exitCode;

/** The program, its profile's arguments and environment, and the verified address, on this computer. */
export type ReadBackHere = {
  run: RunProgram;
  program: string;
  profileArgs: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd: string;
  url: string;
  /** The identity the connection established; the list is read only when the endpoint returns it. */
  expected: string | null;
  /**
   * Whether the endpoint's listener is still the one proved before the reads:
   * asked just before the device list and again after it, and a list read on
   * either side of a change is discarded.
   */
  listener?: () => Promise<boolean>;
};

/**
 * Reads back on this computer: the identity, then the list, each with the
 * program the look found, for its profile, at the address it verified. A read
 * that didn't end in time, within its bound, with exit 0 and one whole JSON
 * document of the expected shape names its step, and its exit code when
 * OpenClaw recorded one. An identity other than `expected` is returned with
 * no list read.
 */
export async function readBackHere(spec: ReadBackHere): Promise<ReadBack> {
  const call = (method: ReadBackMethod) =>
    spec.run({
      program: spec.program,
      args: [...spec.profileArgs, ...readBackArgs(method, spec.url)],
      env: spec.env,
      cwd: spec.cwd,
      timeoutMs: READ_BACK_TIMEOUT_MS,
      maxBytes: READ_BACK_BYTES[method],
    });
  const identityRun = await call("gateway.identity.get");
  const identity =
    identityRun.exitCode === 0 && exitOf(identityRun) === 0
      ? parseIdentity(identityRun.stdout)
      : null;
  if (!identity) {
    const exit = exitOf(identityRun);
    return { ok: false, step: "identity", exitCode: exit === 0 ? null : exit };
  }
  // Another gateway at the endpoint: its device list is never asked for.
  if (spec.expected !== null && identity.deviceId !== spec.expected)
    return { ok: false, step: "list", exitCode: null, identity };
  // The list only from the listener that answered as that gateway, the same before and after it.
  const changed = { ok: false, step: "list", exitCode: null, identity } as const;
  if (spec.listener && !(await spec.listener())) return changed;
  const listRun = await call("device.pair.list");
  const list =
    listRun.exitCode === 0 && exitOf(listRun) === 0 ? parseDeviceList(listRun.stdout) : null;
  if (!list) {
    const exit = exitOf(listRun);
    return { ok: false, step: "list", exitCode: exit === 0 ? null : exit, identity };
  }
  if (spec.listener && !(await spec.listener())) return changed;
  return { ok: true, identity, list };
}
