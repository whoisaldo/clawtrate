// The IDENTITY and LIST scripts (apps/desktop/src/main/ssh/scripts.ts), the
// two reads after an approval (docs/design/setup.md §9), run here as the
// other computer's `/bin/sh -s` would run them, in a home of the test's own
// with a stand-in `openclaw` in the first fixed place, and their output
// parsed as the host parses it (read-back.ts). No `ssh` and no OpenClaw
// program run.

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  parseScriptOutput,
  remoteScript,
  SCRIPT_ANSWER_BYTES,
  SCRIPT_BODIES,
  type ScriptValues,
} from "../../src/main/ssh/scripts.ts";
import { parseDeviceList, parseIdentity } from "../../src/setup/read-back.ts";
import { tempDir } from "./harness.ts";

const GATEWAY = "1111111111111111111111111111111111111111111111111111111111111111";

describe.skipIf(process.platform === "win32")("the IDENTITY and LIST scripts", () => {
  let home: string;
  let sum: string;
  const values = (patch: Partial<ScriptValues> = {}): ScriptValues => ({
    profile: "default",
    port: 19420,
    program: "~/.openclaw/bin/openclaw",
    programSum: sum,
    ...patch,
  });
  beforeAll(() => {
    home = tempDir("clawtrate-read-back-scripts-");
    const bin = join(home, ".openclaw", "bin");
    mkdirSync(bin, { recursive: true });
    // Answers as OpenClaw 2026.10.6 does: `--json` documents over several lines. A
    // file `fail` makes the read exit with its number, after printing what it printed.
    writeFileSync(
      join(bin, "openclaw"),
      [
        "#!/bin/sh",
        'printf \'%s\\n\' "$*" >> "$HOME/calls"',
        'env | grep "^OPENCLAW_" >> "$HOME/env" || true',
        'case "$*" in',
        `  *"gateway call gateway.identity.get --expect-url ws://127.0.0.1:"*" --json") if [ -f "$HOME/identity.json" ]; then cat "$HOME/identity.json"; else printf '{\\n  "deviceId": "${GATEWAY}",\\n  "publicKey": "gateway-public-key-for-tests"\\n}\\n'; fi ;;`,
        '  *"gateway call device.pair.list --expect-url ws://127.0.0.1:"*" --json") cat "$HOME/list.json" ;;',
        "  *) exit 9 ;;",
        "esac",
        'if [ -f "$HOME/fail" ]; then exit "$(cat "$HOME/fail")"; fi',
        "",
      ].join("\n"),
    );
    chmodSync(join(bin, "openclaw"), 0o755);
    sum = execFileSync("/bin/sh", ["-c", 'cksum < "$1"', "sh", join(bin, "openclaw")], {
      encoding: "utf8",
    }).trim();
    writeFileSync(
      join(home, "list.json"),
      JSON.stringify(
        {
          pending: [],
          paired: [
            {
              deviceId: "2222222222222222222222222222222222222222222222222222222222222222",
              clientId: "gateway-client",
              clientMode: "ui",
              role: "operator",
              roles: ["operator"],
              scopes: ["operator.read"],
              tokens: [{ role: "operator", scopes: ["operator.read"] }],
            },
          ],
        },
        null,
        2,
      ),
    );
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  const run = (text: string, env: Record<string, string> = {}) =>
    spawnSync("/bin/sh", ["-s"], {
      input: `echo 'a login file says hello'\n${text}`,
      env: { HOME: home, PATH: "/usr/bin:/bin", ...env },
      encoding: "utf8",
      timeout: 20_000,
    });
  const calls = () => {
    try {
      return readFileSync(join(home, "calls"), "utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };

  it("F-500: IDENTITY runs only its read, for the profile and port it was given, and the whole JSON document comes back", () => {
    rmSync(join(home, "calls"), { force: true });
    const script = remoteScript("identity", values());
    const out = run(script.text);
    expect(out.status).toBe(0);
    const parsed = parseScriptOutput("identity", out.stdout, script.requestId);
    if (!parsed.ok || !parsed.answer) throw new Error("no answer");
    expect(parsed.answer.exit).toBe(0);
    // Several lines, parsed whole.
    expect(parsed.answer.text.split("\n").length).toBeGreaterThan(2);
    expect(parseIdentity(parsed.answer.text)).toEqual({
      deviceId: GATEWAY,
      publicKey: "gateway-public-key-for-tests",
    });
    // The default profile carries no flag; Clawtrate's own is the literal pair.
    expect(calls()).toEqual([
      "gateway call gateway.identity.get --expect-url ws://127.0.0.1:19420 --json",
    ]);
    const own = remoteScript("identity", values({ profile: "clawtrate", port: 19421 }));
    expect(run(own.text).status).toBe(0);
    expect(calls().at(-1)).toBe(
      "--profile clawtrate gateway call gateway.identity.get --expect-url ws://127.0.0.1:19421 --json",
    );
  });

  it("F-500: LIST runs only its read, and the device list comes back whole", () => {
    rmSync(join(home, "calls"), { force: true });
    const script = remoteScript("list", values());
    const parsed = parseScriptOutput("list", run(script.text).stdout, script.requestId);
    if (!parsed.ok || !parsed.answer) throw new Error("no answer");
    expect(parseDeviceList(parsed.answer.text)?.paired).toHaveLength(1);
    expect(calls()).toEqual([
      "gateway call device.pair.list --expect-url ws://127.0.0.1:19420 --json",
    ]);
  });

  it("F-500: OpenClaw's failing status comes back apart from its output, under set -e", () => {
    writeFileSync(join(home, "fail"), "2");
    try {
      const script = remoteScript("list", values());
      const out = run(script.text);
      // The script itself ends whole: the command's failure didn't stop it before its status.
      expect(out.status).toBe(0);
      const parsed = parseScriptOutput("list", out.stdout, script.requestId);
      expect(parsed).toMatchObject({ ok: true, answer: { exit: 2 } });
    } finally {
      rmSync(join(home, "fail"), { force: true });
    }
  });

  it("F-500: no OPENCLAW_ variable the login left reaches the reads, so the default profile names the default profile", () => {
    rmSync(join(home, "env"), { force: true });
    for (const kind of ["identity", "list"] as const) {
      const script = remoteScript(kind, values());
      const out = run(script.text, {
        OPENCLAW_PROFILE: "work",
        OPENCLAW_CONFIG_PATH: "/elsewhere/openclaw.json",
        OPENCLAW_STATE_DIR: "/elsewhere",
        OPENCLAW_GATEWAY_URL: "ws://elsewhere.example:18789",
      });
      expect(out.status).toBe(0);
    }
    expect(existsSync(join(home, "env")) ? readFileSync(join(home, "env"), "utf8") : "").toBe("");
  });

  it("F-500: only a validated profile and port enter the reads; tampered assignments run nothing", () => {
    expect(() => remoteScript("list", values({ profile: "work" as "default" }))).toThrow();
    expect(() => remoteScript("list", values({ port: 80 }))).toThrow();
    rmSync(join(home, "calls"), { force: true });
    for (const assigned of [
      `profile='default --url x'\nport='19420'\nprog_i='0'\nprog_sum='${sum}'\n`,
      `profile='default'\nport='19420;id'\nprog_i='0'\nprog_sum='${sum}'\n`,
    ]) {
      const out = run(
        `request_id='00000000-0000-4000-8000-000000000000'\n${assigned}${SCRIPT_BODIES.list}`,
      );
      expect(out.status).toBe(64);
    }
    expect(calls()).toEqual([]);
    // Each read is a fixed `gateway call` for the loopback port: no approve, no remove.
    for (const kind of ["identity", "list"] as const) {
      expect(SCRIPT_BODIES[kind]).toContain(" gateway call ");
      expect(SCRIPT_BODIES[kind]).not.toMatch(/approve|remove|reject|revoke|rotate/);
    }
  });

  it("F-500: an answer past its bound is refused whole, even when its first part is a whole document", () => {
    // A complete identity document filling the 4 KiB bound exactly, then more after it.
    const doc = `{"deviceId": "${GATEWAY}", "publicKey": "gateway-public-key-for-tests"}`;
    const filled = doc.slice(0, -1) + " ".repeat(SCRIPT_ANSWER_BYTES.identity - doc.length) + "}";
    expect(Buffer.byteLength(filled)).toBe(SCRIPT_ANSWER_BYTES.identity);
    expect(parseIdentity(filled)).not.toBeNull();
    writeFileSync(join(home, "identity.json"), `${filled}\n{"more": "after the bound"}\n`);
    try {
      const script = remoteScript("identity", values());
      const out = run(script.text);
      expect(out.status).toBe(0);
      expect(parseScriptOutput("identity", out.stdout, script.requestId)).toEqual({
        ok: false,
        reason: "too-large",
      });
      // Exactly at the bound, it is whole and read.
      writeFileSync(join(home, "identity.json"), filled);
      const exact = remoteScript("identity", values());
      const parsed = parseScriptOutput("identity", run(exact.text).stdout, exact.requestId);
      if (!parsed.ok || !parsed.answer) throw new Error("no answer");
      expect(parseIdentity(parsed.answer.text)?.deviceId).toBe(GATEWAY);
    } finally {
      rmSync(join(home, "identity.json"), { force: true });
    }
  });

  it("F-500: a status the script couldn't record is absent, never a number of its own", () => {
    const id = "00000000-0000-4000-8000-000000000000";
    const out = [
      `{"k":"begin","id":"${id}"}`,
      `{"k":"program","i":0}`,
      `{"k":"answer","v":"","exit":null}`,
      `{"k":"end","id":"${id}"}`,
      "",
    ].join("\n");
    expect(parseScriptOutput("list", out, id)).toMatchObject({
      ok: true,
      answer: { text: "", exit: null },
    });
    // The script itself prints null where it has no status.
    expect(SCRIPT_BODIES.list).toContain("code=null");
    expect(SCRIPT_BODIES.list).not.toContain("code=255");
  });

  it("F-500: an answer that isn't one whole document of the expected shape reads as nothing", () => {
    expect(parseIdentity('{"deviceId": "not-hex", "publicKey": "k"}')).toBeNull();
    expect(parseIdentity(`{"deviceId": "${GATEWAY}"}`)).toBeNull();
    expect(parseIdentity(`{"deviceId": "${GATEWAY}", "publicKey": "k"}\n{}`)).toBeNull();
    expect(parseDeviceList('{"pending": []}')).toBeNull();
    expect(parseDeviceList('{"pending": [], "paired": [')).toBeNull();
    expect(parseDeviceList('{"pending": [], "paired": []}')).toEqual({ pending: [], paired: [] });
  });
});
