// The CODE and START scripts (apps/desktop/src/main/ssh/scripts.ts), run here
// as the other computer's `/bin/sh -s` would run them, in a home of the test's
// own with a stand-in `openclaw` in the first fixed place, and their output
// parsed as the host parses it. No `ssh` and no OpenClaw program run.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { execFileSync } from "node:child_process";

import { lookScript, parseLookOutput } from "../../src/main/ssh/look.ts";
import {
  maxScriptOutput,
  parseScriptOutput,
  remoteScript,
  SCRIPT_BODIES,
  type ScriptValues,
} from "../../src/main/ssh/scripts.ts";
import { tempDir } from "./harness.ts";

describe.skipIf(process.platform === "win32")("the CODE and START scripts", () => {
  let home: string;
  /** The program's checksum as the LOOK reports it. */
  let sum: string;
  const values = (patch: Partial<ScriptValues> = {}): ScriptValues => ({
    profile: "default",
    port: 19420,
    program: "~/.openclaw/bin/openclaw",
    programSum: sum,
    ...patch,
  });
  beforeAll(() => {
    home = tempDir("clawtrate-scripts-");
    const bin = join(home, ".openclaw", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "openclaw"),
      [
        "#!/bin/sh",
        'printf \'%s\\n\' "$*" >> "$HOME/calls"',
        'env | grep "^OPENCLAW_" >> "$HOME/env" || true',
        'case "$*" in',
        '  *"qr --json --voice-node --url ws://127.0.0.1:"*) printf \'{"setupCode":"abc"}\' ;;',
        '  *"gateway start") exit 3 ;;',
        "esac",
        "",
      ].join("\n"),
    );
    chmodSync(join(bin, "openclaw"), 0o755);
    sum = execFileSync("/bin/sh", ["-c", 'cksum < "$1"', "sh", join(bin, "openclaw")], {
      encoding: "utf8",
    }).trim();
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

  it("F-496: CODE runs the one fixed command for the profile and port it was given, and its answer comes back whole", () => {
    rmSync(join(home, "calls"), { force: true });
    const script = remoteScript("code", values());
    const out = run(script.text);
    expect(out.status).toBe(0);
    expect(parseScriptOutput("code", out.stdout, script.requestId)).toEqual({
      ok: true,
      program: "~/.openclaw/bin/openclaw",
      answer: { text: '{"setupCode":"abc"}', exit: 0 },
    });
    expect(calls()).toEqual(["qr --json --voice-node --url ws://127.0.0.1:19420"]);
    const own = remoteScript("code", values({ profile: "clawtrate", port: 19421 }));
    expect(run(own.text).status).toBe(0);
    expect(calls().at(-1)).toBe(
      "--profile clawtrate qr --json --voice-node --url ws://127.0.0.1:19421",
    );
  });

  it("F-497: START runs its one command, and the exit status comes back; there is no STOP", () => {
    rmSync(join(home, "calls"), { force: true });
    const start = remoteScript("start", values());
    const started = parseScriptOutput("start", run(start.text).stdout, start.requestId);
    expect(started).toMatchObject({ ok: true, answer: { exit: 3 } });
    expect(calls()).toEqual(["gateway start"]);
    // No STOP: the other scripts are the two reads of setup §9.
    expect(Object.keys(SCRIPT_BODIES)).toEqual(["code", "start", "identity", "list"]);
  });

  it("runs only the program file the LOOK found, by its place and checksum: a file changed since, or another place, runs nothing", () => {
    // The LOOK reports the place and the checksum the host then hands to the scripts.
    const look = lookScript();
    const looked = parseLookOutput(run(look.text).stdout, look.requestId);
    if (!looked.ok) throw new Error(looked.reason);
    expect(looked.facts.program).toBe("~/.openclaw/bin/openclaw");
    expect(looked.facts.programSum).toBe(sum);
    rmSync(join(home, "calls"), { force: true });
    // Another checksum: the file isn't the one the dialog named, so nothing runs.
    const other = remoteScript("code", values({ programSum: "1 2" }));
    expect(parseScriptOutput("code", run(other.text).stdout, other.requestId)).toEqual({
      ok: true,
      program: null,
      answer: null,
    });
    // Another place, where no program is: nothing runs either.
    const elsewhere = remoteScript("code", values({ program: "/usr/local/bin/openclaw" }));
    expect(
      parseScriptOutput("code", run(elsewhere.text).stdout, elsewhere.requestId),
    ).toMatchObject({ ok: true, program: null });
    expect(calls()).toEqual([]);
  });

  it("clears every OPENCLAW_ variable the login left before OpenClaw runs, so no inherited profile, state, config or port applies", () => {
    rmSync(join(home, "env"), { force: true });
    rmSync(join(home, "calls"), { force: true });
    const script = remoteScript("code", values());
    const out = run(script.text, {
      OPENCLAW_PROFILE: "work",
      OPENCLAW_STATE_DIR: "/elsewhere",
      OPENCLAW_CONFIG_PATH: "/elsewhere/openclaw.json",
      OPENCLAW_GATEWAY_PORT: "18999",
    });
    expect(out.status).toBe(0);
    // The stand-in ran: an empty log below is one it wrote with nothing in it.
    expect(calls()).toHaveLength(1);
    const seen = () =>
      existsSync(join(home, "env")) ? readFileSync(join(home, "env"), "utf8") : "";
    expect(seen()).toBe("");
    // The LOOK clears them the same way.
    rmSync(join(home, "env"), { force: true });
    rmSync(join(home, "calls"), { force: true });
    const look = lookScript();
    expect(run(look.text, { OPENCLAW_PROFILE: "work" }).status).toBe(0);
    expect(calls().length).toBeGreaterThan(0);
    expect(seen()).toBe("");
  });

  it("the host writes only a validated profile and port; the script refuses anything else before it runs a program", () => {
    expect(() => remoteScript("code", values({ profile: "work" as "default" }))).toThrow();
    expect(() => remoteScript("code", values({ port: 80 }))).toThrow();
    expect(() => remoteScript("code", values({ port: 19420.5 }))).toThrow();
    expect(() => remoteScript("code", values({ programSum: "1; id" }))).toThrow();
    expect(() =>
      remoteScript("code", values({ program: "/tmp/openclaw" as ScriptValues["program"] })),
    ).toThrow();
    rmSync(join(home, "calls"), { force: true });
    // The body checks again: a profile or a port no host would write ends the script at once.
    for (const assigned of [
      `profile='x;id'\nport='19420'\nprog_i='0'\nprog_sum='${sum}'\n`,
      `profile='default'\nport='1$(id)'\nprog_i='0'\nprog_sum='${sum}'\n`,
      `profile='default'\nport='19420'\nprog_i='9'\nprog_sum='${sum}'\n`,
      `profile='default'\nport='19420'\nprog_i='0'\nprog_sum='1;id'\n`,
    ]) {
      const out = run(
        `request_id='00000000-0000-4000-8000-000000000000'\n${assigned}${SCRIPT_BODIES.code}`,
      );
      expect(out.status).toBe(64);
    }
    expect(calls()).toEqual([]);
    // The only values in the constant bodies come from those five assignments.
    for (const body of Object.values(SCRIPT_BODIES)) {
      expect(body).not.toMatch(/request_id=|profile=|port=|prog_i=|prog_sum=/);
    }
  });

  it("what a login file prints before the begin line is dropped, a fake answer included, and a cut or tampered answer isn't read", () => {
    const script = remoteScript("code", values());
    const fake = '{"k":"answer","v":"e30=","exit":0}\n';
    const out = run(script.text);
    expect(parseScriptOutput("code", fake + out.stdout, script.requestId)).toMatchObject({
      ok: true,
      answer: { text: '{"setupCode":"abc"}' },
    });
    expect(parseScriptOutput("code", out.stdout, "00000000-0000-4000-8000-000000000000")).toEqual({
      ok: false,
      reason: "no-begin",
    });
    const cut = out.stdout.slice(0, out.stdout.indexOf('{"k":"end"'));
    expect(parseScriptOutput("code", cut, script.requestId)).toEqual({
      ok: false,
      reason: "no-end",
    });
    expect(
      parseScriptOutput("code", "x".repeat(maxScriptOutput("code") + 1), script.requestId),
    ).toEqual({ ok: false, reason: "too-large" });
  });
});
