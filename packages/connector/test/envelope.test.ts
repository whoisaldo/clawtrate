// The pairing code `pair-phone` prints: the envelope core's relay route parses (#270), its QR
// code, and the command that makes it, with OpenClaw's command line played by a stand-in.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fromBase64Url, toBase64Url } from "@clawtrate/relay-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPhones } from "../src/allowlist.ts";
import { main, type CliIo } from "../src/cli.ts";
import { dialUrl, loadKeys } from "../src/config.ts";
import { checkSetupCode, encodeRelayCode, MAX_OFFER_MS } from "../src/envelope.ts";
import type { OpenclawRunner } from "../src/openclaw.ts";
import { qrModules, renderQr } from "../src/qr.ts";
import type { StateDir } from "../src/state.ts";
import { setUpState, tempRoot } from "./helpers.ts";

const RELAY = "wss://relay.example";
const NOW = 1_800_000_000_000;

let cleanup: () => void;
let state: StateDir;
beforeEach(() => {
  let root: string;
  ({ root, cleanup } = tempRoot());
  state = setUpState(root, RELAY, 19_999);
});
afterEach(() => cleanup());

const setupCodeFor = (url: string, expiresAtMs = NOW + 600_000, extra: object = {}) =>
  toBase64Url(
    new TextEncoder().encode(
      JSON.stringify({ url, bootstrapToken: "bt-0123456789abcdef", expiresAtMs, ...extra }),
    ),
  );

/**
 * The envelope's rules as core's parser applies them (#270, `packages/core/src/relay/code.ts`):
 * canonical base64url of strict UTF-8, exactly seven members in a flat object, version 1, a
 * canonical relay id, 32-byte keys in canonical base64url, and a setup code for the dial address.
 */
function readEnvelope(code: string) {
  expect(code.length).toBeLessThanOrEqual(4096);
  const bytes = fromBase64Url(code);
  expect(bytes).not.toBeNull();
  expect(toBase64Url(bytes!)).toBe(code);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes!);
  const value = JSON.parse(text) as Record<string, unknown>;
  expect(Object.keys(value)).toEqual([
    "v",
    "relay",
    "relayId",
    "connectorKey",
    "enroll",
    "expiresAtMs",
    "openclaw",
  ]);
  expect(value.v).toBe(1);
  expect(value.relayId).toMatch(/^[a-z2-7]{25}[aeimquy4]$/);
  for (const key of ["connectorKey", "enroll"] as const) {
    const decoded = fromBase64Url(value[key] as string);
    expect(decoded?.length).toBe(32);
    expect(toBase64Url(decoded!)).toBe(value[key]);
  }
  const setup = JSON.parse(
    new TextDecoder().decode(fromBase64Url(value.openclaw as string)!),
  ) as Record<string, unknown>;
  expect(Object.keys(setup).sort()).toEqual(["bootstrapToken", "expiresAtMs", "url"]);
  expect(setup.url).toBe(`${value.relay}/v1/dial/${value.relayId}`);
  return { value, setup };
}

function io(openclaw: OpenclawRunner, lines: string[], now = NOW): CliIo {
  return {
    out: (line) => lines.push(line),
    err: (line) => lines.push(`ERR ${line}`),
    env: {},
    now: () => now,
    isTTY: false,
    openclaw: () => openclaw,
  };
}

describe("the pairing code", () => {
  it("encodes exactly the envelope core parses", () => {
    const keys = loadKeys(state);
    const enroll = crypto.getRandomValues(new Uint8Array(32));
    const code = encodeRelayCode({
      relayOrigin: RELAY,
      relayId: keys.relayId,
      connectorKey: toBase64Url(keys.noise.publicKey),
      enroll,
      expiresAtMs: NOW + 1,
      setupCode: setupCodeFor(dialUrl(RELAY, keys.relayId)),
    });
    const { value } = readEnvelope(code);
    expect(value.relay).toBe(RELAY);
    expect(value.connectorKey).toBe(toBase64Url(keys.noise.publicKey));
    expect(value.enroll).toBe(toBase64Url(enroll));
    expect(value.expiresAtMs).toBe(NOW + 1);
  });

  const r4Parser = fileURLToPath(new URL("../../core/src/relay/code.ts", import.meta.url));
  it.skipIf(!existsSync(r4Parser))("is accepted by core's own relay code parser", async () => {
    const { parseRelayCode } = (await import(/* @vite-ignore */ r4Parser)) as {
      parseRelayCode(
        input: string,
        nowMs: number,
        options?: { allowLoopbackWs?: boolean },
      ): {
        route: { relayOrigin: string; relayId: string; connectorKey: string };
        enroll: Uint8Array;
        bootstrapToken: string;
        expiresAtMs: number;
      };
    };
    const keys = loadKeys(state);
    const enroll = crypto.getRandomValues(new Uint8Array(32));
    const now = Date.now();
    const code = encodeRelayCode({
      relayOrigin: RELAY,
      relayId: keys.relayId,
      connectorKey: toBase64Url(keys.noise.publicKey),
      enroll,
      expiresAtMs: now + 300_000,
      setupCode: setupCodeFor(dialUrl(RELAY, keys.relayId), now + 600_000),
    });
    const parsed = parseRelayCode(code, now);
    expect(parsed.route).toEqual({
      kind: "relay",
      relayOrigin: RELAY,
      relayId: keys.relayId,
      connectorKey: toBase64Url(keys.noise.publicKey),
    });
    expect(Buffer.from(parsed.enroll).equals(Buffer.from(enroll))).toBe(true);
    expect(parsed.bootstrapToken).toBe("bt-0123456789abcdef");
    expect(parsed.expiresAtMs).toBe(now + 300_000);
  });

  it("refuses a setup code for another address, with other fields, or expired", () => {
    const dial = `${RELAY}/v1/dial/aaaaaaaaaaaaaaaaaaaaaaaaaa`;
    expect(checkSetupCode(setupCodeFor(dial), dial, NOW).expiresAtMs).toBe(NOW + 600_000);
    expect(() => checkSetupCode(setupCodeFor("wss://elsewhere.example"), dial, NOW)).toThrow(
      /another address/,
    );
    expect(() =>
      checkSetupCode(setupCodeFor(dial, NOW + 1, { tlsFingerprint: "x" }), dial, NOW),
    ).toThrow(/fields/);
    expect(() => checkSetupCode(setupCodeFor(dial, NOW), dial, NOW)).toThrow(/expired/);
    expect(() => checkSetupCode("not base64!", dial, NOW)).toThrow();
    expect(() => checkSetupCode(undefined, dial, NOW)).toThrow();
  });

  it("is drawn as a QR code with a light border", () => {
    const rows = qrModules("clawtrate relay code");
    expect(rows.length).toBe(rows[0]!.length);
    expect(rows[0]!.every((dark) => !dark)).toBe(true);
    expect(rows[2]!.slice(2, 9).every((dark) => dark)).toBe(true); // a finder pattern's top edge
    const text = renderQr("clawtrate relay code", { color: false });
    expect(text.split("\n")).toHaveLength(Math.ceil(rows.length / 2));
    expect(renderQr("x", { color: true })).toContain("\x1b[30;47m");
  });
});

describe("pair-phone", () => {
  it("asks OpenClaw for a limited setup code for its dial address, records an offer and prints the code", async () => {
    const keys = loadKeys(state);
    const dial = dialUrl(RELAY, keys.relayId);
    const calls: string[][] = [];
    const runner: OpenclawRunner = async (args) => {
      calls.push(args);
      return {
        status: 0,
        stdout: `some log line\n${JSON.stringify({ setupCode: setupCodeFor(dial, NOW + 3_600_000), access: "limited" })}`,
        stderr: "",
      };
    };
    const lines: string[] = [];
    expect(
      await main(
        ["pair-phone", "--state-dir", state.path, "--name", "My phone", "--json"],
        io(runner, lines),
      ),
    ).toBe(0);
    expect(calls).toEqual([["qr", "--json", "--limited", "--url", dial]]);
    const printed = JSON.parse(lines[0]!) as { code: string; expiresAtMs: number };
    const { value } = readEnvelope(printed.code);
    // The secret lasts ten minutes at most, even when the setup code lasts longer.
    expect(value.expiresAtMs).toBe(NOW + MAX_OFFER_MS);
    const offers = readPhones(state).offers;
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      label: "My phone",
      expiresAtMs: NOW + MAX_OFFER_MS,
      used: false,
    });

    const shown: string[] = [];
    expect(await main(["pair-phone", "--state-dir", state.path], io(runner, shown))).toBe(0);
    expect(shown.join("\n")).toContain("█");
    const code = shown.find((line) => /^[A-Za-z0-9_-]{200,}$/.test(line))!;
    readEnvelope(code);
  });

  it("refuses a setup code OpenClaw made for another address, and records nothing", async () => {
    const runner: OpenclawRunner = async () => ({
      status: 0,
      stdout: JSON.stringify({ setupCode: setupCodeFor("wss://elsewhere.example/v1/dial/x") }),
      stderr: "",
    });
    const lines: string[] = [];
    expect(await main(["pair-phone", "--state-dir", state.path], io(runner, lines))).toBe(1);
    expect(lines.join("\n")).toMatch(/another address/);
    expect(readPhones(state).offers).toEqual([]);
  });
});
