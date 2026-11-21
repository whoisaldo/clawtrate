// The read-back on this computer after an approval (docs/design/setup.md §9):
// the two fixed reads with the program the look found, for its profile, at
// the address it verified, and nothing else the host's runner would start.

import { describe, expect, it } from "vitest";
import { checkRequest, type ProgramRequest, type ProgramResult } from "../src/setup/programs.ts";
import { readBackHere } from "../src/setup/read-back.ts";

const GATEWAY = "1111111111111111111111111111111111111111111111111111111111111111";
const URL = "ws://127.0.0.1:19420";
const ok = (stdout: string): ProgramResult => ({
  exitCode: 0,
  stdout,
  timedOut: false,
  tooLarge: false,
  failed: false,
});
const IDENTITY = `{\n  "deviceId": "${GATEWAY}",\n  "publicKey": "gateway-public-key-for-tests"\n}\n`;
const LIST = '{\n  "pending": [],\n  "paired": []\n}\n';

function runner(answers: Record<string, ProgramResult>) {
  const asked: ProgramRequest[] = [];
  return {
    asked,
    run: async (request: ProgramRequest) => {
      checkRequest(request);
      asked.push(request);
      return answers[request.args.find((arg) => arg.includes("."))!] ?? ok("");
    },
  };
}

const spec = (
  run: (request: ProgramRequest) => Promise<ProgramResult>,
  expected: string | null = GATEWAY,
) => ({
  run,
  program: "/opt/homebrew/bin/openclaw",
  profileArgs: ["--profile", "clawtrate"],
  env: { HOME: "/var/empty/clawtrate", PATH: "/opt/homebrew/bin:/usr/bin:/bin" },
  cwd: "/var/empty/clawtrate",
  url: URL,
  expected,
});
const IDENTITY_READ = { deviceId: GATEWAY, publicKey: "gateway-public-key-for-tests" };

describe("F-500: the read-back on this computer", () => {
  it("reads the identity, then the list, for the profile at the verified address", async () => {
    const r = runner({ "gateway.identity.get": ok(IDENTITY), "device.pair.list": ok(LIST) });
    expect(await readBackHere(spec(r.run))).toEqual({
      ok: true,
      identity: { deviceId: GATEWAY, publicKey: "gateway-public-key-for-tests" },
      list: { pending: [], paired: [] },
    });
    expect(r.asked.map((request) => request.args)).toEqual([
      [
        "--profile",
        "clawtrate",
        "gateway",
        "call",
        "gateway.identity.get",
        "--expect-url",
        URL,
        "--json",
      ],
      [
        "--profile",
        "clawtrate",
        "gateway",
        "call",
        "device.pair.list",
        "--expect-url",
        URL,
        "--json",
      ],
    ]);
  });

  it("a read that failed names its step, and OpenClaw's exit code only when it ran to its end", async () => {
    const failing = (exitCode: number | null, more: Partial<ProgramResult> = {}) => ({
      ...ok(""),
      exitCode,
      ...more,
    });
    expect(await readBackHere(spec(runner({ "gateway.identity.get": failing(1) }).run))).toEqual({
      ok: false,
      step: "identity",
      exitCode: 1,
    });
    expect(
      await readBackHere(
        spec(runner({ "gateway.identity.get": ok(IDENTITY), "device.pair.list": failing(2) }).run),
      ),
    ).toEqual({ ok: false, step: "list", exitCode: 2, identity: IDENTITY_READ });
    // Ended by the host, cut at its bound, or an answer of another shape: no exit code to name.
    for (const result of [
      failing(null, { timedOut: true }),
      failing(0, { tooLarge: true }),
      ok('{"pending": []}'),
    ])
      expect(
        await readBackHere(
          spec(runner({ "gateway.identity.get": ok(IDENTITY), "device.pair.list": result }).run),
        ),
      ).toEqual({ ok: false, step: "list", exitCode: null, identity: IDENTITY_READ });
  });

  it("another gateway's identity at the endpoint is returned with no list asked for", async () => {
    const r = runner({ "gateway.identity.get": ok(IDENTITY), "device.pair.list": ok(LIST) });
    const other = "2".repeat(64);
    expect(await readBackHere(spec(r.run, other))).toEqual({
      ok: false,
      step: "list",
      exitCode: null,
      identity: IDENTITY_READ,
    });
    expect(r.asked.map((request) => request.args[4])).toEqual(["gateway.identity.get"]);
  });

  it("the host's runner starts the two reads at a loopback address and refuses any other call", () => {
    const request = (args: string[]): ProgramRequest => ({
      program: "/opt/homebrew/bin/openclaw",
      args,
      env: {},
      cwd: "/var/empty/clawtrate",
      timeoutMs: 1000,
      maxBytes: 1000,
    });
    const call = (method: string, url = URL, last = "--json") => [
      "gateway",
      "call",
      method,
      "--expect-url",
      url,
      last,
    ];
    expect(() => checkRequest(request(call("gateway.identity.get")))).not.toThrow();
    expect(() =>
      checkRequest(request(["--profile", "clawtrate", ...call("device.pair.list")])),
    ).not.toThrow();
    for (const args of [
      call("device.pair.approve"),
      call("device.pair.remove"),
      call("device.pair.list", "ws://203.0.113.4:19420"),
      call("device.pair.list", "ws://127.0.0.1:19420/x"),
      call("device.pair.list", URL, "--params"),
      ["--profile", "work", ...call("device.pair.list")],
      ["devices", "approve", "e5eb4aa8-175f-40f1-bc7a-8f15cfc40942"],
    ])
      expect(() => checkRequest(request(args))).toThrow();
  });
});
