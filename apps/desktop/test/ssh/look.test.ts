// The LOOK script and its parser: output well-formed and hostile, and the
// script itself run under each shell this machine has as the outer login
// shell, with start-up files that print, in a home of the test's own.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  LOOK_SCRIPT_BODY,
  lookScript,
  MAX_LOOK_NOISE,
  MAX_LOOK_OUTPUT,
  parseGatewayStatus,
  parseLookOutput,
  sameService,
  serviceOnPort,
} from "../../src/main/ssh/look.ts";
import {
  absolutePlacesHere,
  installStubOpenclaw,
  statusJson,
  tempDir,
  testEnv,
} from "./harness.ts";

const ID = "6f1c2b9e-0d7a-4c3e-9b1f-2a8e5d4c3b21";
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const status_ = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ...(statusJson({ port: 18789, home: "/srv/you" }) as object), ...extra });

const wellFormed = (lines: string[] = []) =>
  [
    `{"k":"begin","id":"${ID}"}`,
    `{"k":"uname","s":"${b64("Linux\n")}","m":"${b64("x86_64\n")}","n":"${b64("devbox\n")}"}`,
    `{"k":"program","i":0,"c":"${b64("1234567890 4096\n")}"}`,
    `{"k":"version","exit":0,"v":"${b64("OpenClaw 2026.10.6 (fe06181)")}"}`,
    `{"k":"status-default","exit":0,"v":"${b64(status_())}"}`,
    ...lines,
    `{"k":"signs","state":1,"launchd":0,"systemd":1,"cstate":0,"claunchd":0,"csystemd":0}`,
    `{"k":"end","id":"${ID}"}`,
    "",
  ].join("\n");

describe("the LOOK's output, parsed in memory", () => {
  it("gives typed, checked facts", () => {
    const parsed = parseLookOutput(wellFormed(), ID);
    expect(parsed).toEqual({
      ok: true,
      noiseLines: 0,
      facts: {
        system: { os: "Linux", machine: "x86_64", nodeName: "devbox" },
        program: "~/.openclaw/bin/openclaw",
        programSum: "1234567890 4096",
        version: { year: 2026, month: 10, day: 6, build: "fe06181" },
        gateways: [
          {
            profile: "default",
            exit: 0,
            portStatus: "busy",
            rpcUrl: "ws://127.0.0.1:18789",
            service: { label: "LaunchAgent", loaded: true, running: true, pid: 4242 },
            configPath: "/srv/you/.openclaw/openclaw.json",
            port: 18789,
            bindMode: "loopback",
            version: { year: 2026, month: 10, day: 6, build: null },
            rpcOk: true,
            listenerPids: [4242],
          },
        ],
        signs: {
          defaultState: true,
          defaultService: true,
          clawtrateState: false,
          clawtrateService: false,
        },
      },
    });
  });

  it("drops what a login start-up file printed before the begin line, fake facts included", () => {
    const noise = [
      "Welcome to devbox",
      `{"k":"begin","id":"00000000-0000-0000-0000-000000000000"}`,
      `{"k":"program","i":1}`,
      `{"k":"end","id":"00000000-0000-0000-0000-000000000000"}`,
    ].join("\n");
    const parsed = parseLookOutput(`${noise}\n${wellFormed()}`, ID);
    expect(parsed).toMatchObject({
      ok: true,
      noiseLines: 4,
      facts: { program: "~/.openclaw/bin/openclaw" },
    });
  });

  it("ignores what comes after the end line", () => {
    expect(parseLookOutput(`${wellFormed()}logout noise\n`, ID).ok).toBe(true);
  });

  it.each([
    ["no begin line", "nothing\n", "no-begin"],
    [
      "a begin line for another run",
      wellFormed().replaceAll(ID, "00000000-0000-0000-0000-000000000000"),
      "no-begin",
    ],
    ["no end line", wellFormed().split("\n").slice(0, -2).join("\n"), "no-end"],
    ["a line that isn't JSON", wellFormed(["not json"]), "malformed"],
    ["an array", wellFormed(["[1,2]"]), "malformed"],
    ["an unknown fact", wellFormed([`{"k":"exec","v":"rm"}`]), "malformed"],
    ["a fact twice", wellFormed([`{"k":"program","i":0}`]), "malformed"],
    [
      "a place outside the list",
      wellFormed().replace(`{"k":"program","i":0,`, `{"k":"program","i":9,`),
      "malformed",
    ],
    [
      "a place by path",
      wellFormed().replace(`{"k":"program","i":0,`, `{"k":"program","i":"/tmp/x",`),
      "malformed",
    ],
    ["output that isn't base64", wellFormed().replace(/"v":"[^"]+"/, `"v":"%%%"`), "malformed"],
    ["an exit that isn't a number", wellFormed().replace(`"exit":0`, `"exit":"0"`), "malformed"],
    ["signs that aren't 0 or 1", wellFormed().replace(`"state":1`, `"state":true`), "malformed"],
    [
      "an end with another id",
      wellFormed().replace(`{"k":"end","id":"${ID}"}`, `{"k":"end","id":"x"}`),
      "malformed",
    ],
    [
      "too much output",
      wellFormed([`{"k":"pad","v":"${"A".repeat(MAX_LOOK_OUTPUT)}"}`]),
      "too-large",
    ],
    [
      "a decoded output over the limit",
      wellFormed([`{"k":"status-clawtrate","exit":0,"v":"${b64("x".repeat(33 * 1024))}"}`]),
      "malformed",
    ],
  ])("refuses %s", (_name, stdout, reason) => {
    expect(parseLookOutput(stdout, ID)).toEqual({ ok: false, reason });
  });

  it("checks every value, and keeps nothing it can't check", () => {
    const hostile = wellFormed()
      .replace(b64("OpenClaw 2026.10.6 (fe06181)"), b64("OpenClaw 2026.10.6; rm -rf ~"))
      .replace(b64("devbox\n"), b64("<img src=x onerror=alert(1)>"));
    const parsed = parseLookOutput(hostile, ID);
    expect(parsed).toMatchObject({ ok: true, facts: { version: "unreadable", system: null } });

    const gateway = parseGatewayStatus(
      "default",
      0,
      JSON.stringify({
        service: {
          label: "<b>LaunchAgent</b>",
          loaded: "yes",
          runtime: { status: "running", pid: -1 },
        },
        config: { daemon: { path: "/srv/you/.openclaw/openclaw.json\nrm -rf /" } },
        gateway: { port: "18789", bindMode: "everywhere", version: "2026.10.6-evil" },
        rpc: { ok: "true" },
        port: { listeners: [{ pid: 0 }, { pid: "1" }, { pid: 77 }] },
      }),
    );
    expect(gateway).toEqual({
      profile: "default",
      exit: 0,
      portStatus: null,
      rpcUrl: null,
      service: { label: "other", loaded: null, running: true, pid: null },
      configPath: null,
      port: null,
      bindMode: null,
      version: null,
      rpcOk: null,
      // One listener it can't read makes the list unknown: neither shorter nor empty.
      listenerPids: null,
    });
    expect(
      parseGatewayStatus("default", 0, JSON.stringify({ gateway: { port: 80 } }))?.port,
    ).toBeNull();
    expect(parseGatewayStatus("default", 1, "not json")).toBeNull();
    // A status that isn't JSON is a fact of its own, not a parse failure.
    const broken = parseLookOutput(wellFormed().replace(b64(status_()), b64("Error: boom")), ID);
    expect(broken).toMatchObject({
      ok: true,
      facts: { gateways: [{ profile: "default", unreadable: true }] },
    });
  });
});

describe("the LOOK's output limit", () => {
  /** A status of valid JSON that is exactly `bytes` long. */
  const statusOf = (bytes: number) => {
    const status = JSON.parse(status_()) as Record<string, unknown>;
    status.pad = "";
    status.pad = "x".repeat(bytes - JSON.stringify(status).length);
    return JSON.stringify(status);
  };
  const largest = (noise: string) =>
    noise +
    [
      `{"k":"begin","id":"${ID}"}`,
      `{"k":"uname","s":"${b64("x".repeat(256))}","m":"${b64("x".repeat(256))}","n":"${b64("x".repeat(256))}"}`,
      `{"k":"program","i":4}`,
      `{"k":"version","v":"${b64("v".repeat(32 * 1024))}","exit":255}`,
      `{"k":"status-default","v":"${b64(statusOf(32 * 1024))}","exit":0}`,
      `{"k":"status-clawtrate","v":"${b64(statusOf(32 * 1024))}","exit":0}`,
      `{"k":"signs","state":1,"launchd":1,"systemd":1,"cstate":1,"claunchd":1,"csystemd":1}`,
      `{"k":"end","id":"${ID}"}`,
      "",
    ].join("\n");

  it("is the largest whole LOOK the script can print, plus an allowance for login noise", () => {
    // 32 KiB is 43,692 characters of base64; 256 bytes, 344.
    // begin 58 + uname 1,067 + program 22 + three program records of 43,735 + signs 85 + end 56
    // = 132,493 characters, and 16,384 more for what login files print before the begin line.
    expect(MAX_LOOK_NOISE).toBe(16 * 1024);
    expect(MAX_LOOK_OUTPUT).toBe(132493 + 16384);
    const noise = "x".repeat(MAX_LOOK_NOISE - 1) + "\n";
    const out = largest(noise);
    expect(out.length).toBeLessThanOrEqual(MAX_LOOK_OUTPUT);
    // Both profiles' statuses at the script's own limit, beside a version at its limit too.
    expect(parseLookOutput(out, ID)).toMatchObject({
      ok: true,
      facts: { gateways: [{ profile: "default" }, { profile: "clawtrate" }] },
    });
  });

  it("is too large when login files print more than their allowance before the begin line", () => {
    expect(parseLookOutput(largest("x".repeat(MAX_LOOK_NOISE) + "\n"), ID)).toEqual({
      ok: false,
      reason: "too-large",
    });
  });
});

describe("a LOOK that is incomplete or inconsistent", () => {
  const begin = `{"k":"begin","id":"${ID}"}`;
  const end = `{"k":"end","id":"${ID}"}`;
  const without = (key: string) =>
    wellFormed()
      .split("\n")
      .filter((line) => !line.startsWith(`{"k":"${key}"`))
      .join("\n");

  it.each([
    ["an empty frame", `${begin}\n${end}\n`],
    ["no system line", without("uname")],
    ["no signs line", without("signs")],
    ["a program without its version", without("version")],
    ["a program without its status", without("status-default")],
    [
      "Clawtrate's profile seen without its status",
      wellFormed().replace(`"cstate":0`, `"cstate":1`),
    ],
  ])("is incomplete: %s", (_name, stdout) => {
    expect(parseLookOutput(stdout, ID)).toEqual({ ok: false, reason: "incomplete" });
  });

  it("is malformed when it reports a program's answers without a program", () => {
    expect(parseLookOutput(without("program"), ID)).toEqual({ ok: false, reason: "malformed" });
  });

  const service = (status: Record<string, unknown>, exit = 0) => {
    const parsed = parseLookOutput(
      wellFormed().replace(
        `{"k":"status-default","exit":0,"v":"${b64(status_())}"}`,
        `{"k":"status-default","exit":${exit},"v":"${b64(JSON.stringify(status))}"}`,
      ),
      ID,
    );
    if (!parsed.ok) throw new Error(parsed.reason);
    return serviceOnPort(parsed.facts, 18789);
  };
  const base = () => JSON.parse(status_()) as Record<string, Record<string, unknown>>;

  it("finds no service in a status that failed, or one of unknown kind or state", () => {
    expect(service(base(), 1)).toEqual({ ok: false, reason: "cant-tell" });
    const unknownRuntime = base();
    unknownRuntime.service = { ...unknownRuntime.service, runtime: { pid: 4242 } };
    expect(service(unknownRuntime)).toEqual({ ok: false, reason: "cant-tell" });
    const noPid = base();
    noPid.service = { ...noPid.service, runtime: { status: "running" } };
    expect(service(noPid)).toEqual({ ok: false, reason: "cant-tell" });
    const notLoaded = base();
    notLoaded.service = { ...notLoaded.service, loaded: null };
    expect(service(notLoaded)).toEqual({ ok: false, reason: "cant-tell" });
    const otherKind = base();
    otherKind.service = { ...otherKind.service, label: "supervisord" };
    expect(service(otherKind)).toEqual({ ok: false, reason: "cant-tell" });
    const noRpc = base();
    delete noRpc.rpc;
    expect(service(noRpc)).toEqual({ ok: false, reason: "cant-tell" });
    expect(service(base())).toMatchObject({ ok: true, holdsPort: true });
  });

  it("finds no service when a status didn't parse", () => {
    const parsed = parseLookOutput(
      wellFormed().replace(
        `{"k":"status-default","exit":0,"v":"${b64(status_())}"}`,
        `{"k":"status-default","exit":1,"v":"${b64("Error")}"}`,
      ),
      ID,
    );
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(serviceOnPort(parsed.facts, 18789)).toEqual({ ok: false, reason: "cant-tell" });
  });

  it("can't tell from a status that exited 0 but didn't parse, empty included", () => {
    for (const text of ["", "{", "Error"]) {
      const parsed = parseLookOutput(
        wellFormed().replace(
          `{"k":"status-default","exit":0,"v":"${b64(status_())}"}`,
          `{"k":"status-default","exit":0,"v":"${b64(text)}"}`,
        ),
        ID,
      );
      if (!parsed.ok) throw new Error(parsed.reason);
      expect(serviceOnPort(parsed.facts, 18789), JSON.stringify(text)).toEqual({
        ok: false,
        reason: "cant-tell",
      });
    }
  });
});

describe("the gateway service on a port", () => {
  const facts = (extra: Record<string, unknown> = {}) => {
    const parsed = parseLookOutput(wellFormed().replace(b64(status_()), b64(status_(extra))), ID);
    if (!parsed.ok) throw new Error();
    return parsed.facts;
  };

  it("names the profile, service, configuration and port, and whether the service's process holds the port", () => {
    const found = serviceOnPort(facts(), 18789);
    expect(found).toEqual({
      ok: true,
      holdsPort: true,
      service: {
        profile: "default",
        serviceLabel: "LaunchAgent",
        configPath: "/srv/you/.openclaw/openclaw.json",
        port: 18789,
      },
    });
    // Another process on the port, alone or beside the service: not a found service.
    for (const listeners of [[{ pid: 9 }], [{ pid: 4242 }, { pid: 9 }], []]) {
      expect(
        serviceOnPort(facts({ port: { listeners } }), 18789),
        JSON.stringify(listeners),
      ).toEqual({
        ok: false,
        reason: "cant-tell",
      });
    }
    expect(serviceOnPort(facts(), 18790)).toEqual({ ok: false, reason: "none" });
    // A running service whose gateway didn't answer its RPC is not proven stopped.
    expect(serviceOnPort(facts({ rpc: { ok: false } }), 18789)).toEqual({
      ok: false,
      reason: "cant-tell",
    });
  });

  it("can't tell from a partial list of listeners: past sixteen, or one without a process", () => {
    const sixteen = Array.from({ length: 16 }, () => ({ pid: 4242 }));
    expect(
      serviceOnPort(facts({ port: { status: "busy", listeners: sixteen } }), 18789),
    ).toMatchObject({
      ok: true,
      holdsPort: true,
    });
    // The seventeenth listener is another process.
    expect(
      serviceOnPort(
        facts({ port: { status: "busy", listeners: [...sixteen, { pid: 5151 }] } }),
        18789,
      ),
    ).toEqual({ ok: false, reason: "cant-tell" });
    // A listener without a process: the service's own beside it proves nothing.
    expect(
      serviceOnPort(facts({ port: { status: "busy", listeners: [{ pid: 4242 }, {}] } }), 18789),
    ).toEqual({
      ok: false,
      reason: "cant-tell",
    });
  });

  it("is the same service only when all four agree", () => {
    const a = {
      profile: "default",
      serviceLabel: "LaunchAgent",
      configPath: "/srv/a",
      port: 18789,
    } as const;
    expect(sameService(a, { ...a })).toBe(true);
    expect(sameService(a, { ...a, configPath: "/srv/b" })).toBe(false);
    expect(sameService(a, { ...a, profile: "clawtrate" })).toBe(false);
    expect(sameService(a, { ...a, serviceLabel: "systemd user" })).toBe(false);
    expect(sameService(a, { ...a, port: 18790 })).toBe(false);
  });
});

describe("the LOOK script", () => {
  it("is a constant whose one value is a validated request id", () => {
    const { requestId, text } = lookScript(ID);
    expect(requestId).toBe(ID);
    expect(text).toBe(`request_id='${ID}'\n${LOOK_SCRIPT_BODY}`);
    expect(() => lookScript("x'; rm -rf ~; '")).toThrow();
    expect(lookScript().requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  const SHELLS = [
    "/bin/sh",
    "/bin/bash",
    "/bin/zsh",
    "/bin/dash",
    "/bin/ksh",
    "/bin/csh",
    "/bin/tcsh",
    "/usr/bin/fish",
  ];
  const present = SHELLS.filter((shell) => existsSync(shell));
  const missing = SHELLS.filter((shell) => !existsSync(shell));
  let root: string;
  let home: string;

  beforeAll(() => {
    root = tempDir("clawtrate-look-");
    home = join(root, "home");
    mkdirSync(home, { recursive: true });
    const stub = installStubOpenclaw(home);
    stub.setVersion("OpenClaw 2026.10.6 (fe06181)\n");
    stub.setStatus("default", statusJson({ port: 18789, home }));
    stub.setStatus("clawtrate", statusJson({ port: 18800, home }));
    mkdirSync(join(home, ".openclaw-clawtrate"));
    // A hostile login environment: every start-up file prints, on both outputs, with fake facts.
    // Each writes to stderr by /dev/stderr, which every shell family reads the same way:
    // csh takes `>&2` for a file named 2.
    const noise = [
      "echo 'Last login: never'",
      `echo '{"k":"begin","id":"${ID}"}'`,
      "echo 'to stderr' > /dev/stderr",
      "",
    ].join("\n");
    for (const file of [
      ".zshenv",
      ".zshrc",
      ".bashrc",
      ".profile",
      ".bash_profile",
      ".kshrc",
      ".cshrc",
      ".tcshrc",
      ".login",
    ]) {
      writeFileSync(join(home, file), noise);
    }
    mkdirSync(join(home, ".config", "fish"), { recursive: true });
    writeFileSync(join(home, ".config", "fish", "config.fish"), "echo 'fish says hi'\n");
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /**
   * Runs the script as sshd would: `<login shell> -c '/bin/sh -s'`, in a process
   * group of its own, as sshd's session is, so its 30-second stop reaches only it.
   */
  const runUnder = (shell: string, homeDir: string) =>
    new Promise<{ status: number | null; parsed: ReturnType<typeof parseLookOutput> }>(
      (resolve) => {
        const script = lookScript();
        const env = testEnv({
          HOME: homeDir,
          ZDOTDIR: homeDir,
          ENV: join(homeDir, ".kshrc"),
          BASH_ENV: join(homeDir, ".bashrc"),
        });
        const child = spawn(shell, ["-c", "/bin/sh -s"], {
          env,
          cwd: homeDir,
          detached: true,
          stdio: ["pipe", "pipe", "ignore"],
        });
        let stdout = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => (stdout += chunk));
        child.stdin.end(script.text);
        const timer = setTimeout(() => child.pid && process.kill(-child.pid, "SIGKILL"), 40000);
        child.once("close", (status) => {
          clearTimeout(timer);
          resolve({ status, parsed: parseLookOutput(stdout, script.requestId) });
        });
      },
    );

  it.each(present)(
    "runs the same with %s as the login shell, start-up files and all",
    async (shell) => {
      const { status, parsed } = await runUnder(shell, home);
      expect(status).toBe(0);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.facts.program).toBe("~/.openclaw/bin/openclaw");
      expect(parsed.facts.version).toMatchObject({ year: 2026, month: 10, day: 6 });
      expect(parsed.facts.gateways.map((g) => g.profile)).toEqual(["default", "clawtrate"]);
      expect(parsed.facts.signs).toMatchObject({ defaultState: true, clawtrateState: true });
    },
  );

  if (missing.length) {
    it.skip(`under ${missing.join(", ")} (skipped: not installed here)`, () => {});
  }

  const places = absolutePlacesHere();
  it.skipIf(places.length > 0)(
    places.length
      ? `finds nothing in a home without OpenClaw (skipped: this machine has a program at a fixed place, ${places.join(", ")}, which the script would run)`
      : "finds nothing in a home without OpenClaw",
    async () => {
      const empty = join(root, "empty");
      mkdirSync(empty, { recursive: true });
      const { parsed } = await runUnder("/bin/sh", empty);
      expect(parsed).toMatchObject({
        ok: true,
        facts: {
          program: null,
          version: null,
          gateways: [],
          signs: { defaultState: false, defaultService: false },
        },
      });
    },
  );

  it(
    "cuts a program's output where it is produced, so endless output ends the LOOK at once",
    { timeout: 45000 },
    async () => {
      const loud = join(root, "loud");
      mkdirSync(join(loud, ".openclaw", "bin"), { recursive: true });
      writeFileSync(
        join(loud, ".openclaw", "bin", "openclaw"),
        '#!/bin/sh\ncase "$1" in --version) echo "OpenClaw 2026.10.6" ;; *) exec yes clawtrate ;; esac\n',
        { mode: 0o755 },
      );
      const started = Date.now();
      const { parsed } = await runUnder("/bin/sh", loud);
      expect(Date.now() - started).toBeLessThan(10000);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      // Cut at 32 KiB, so the program was stopped by its pipe: not a status that can be read.
      expect(parsed.facts.gateways).toEqual([
        { profile: "default", exit: expect.any(Number), unreadable: true },
      ]);
      expect((parsed.facts.gateways[0] as { exit: number }).exit).not.toBe(0);
    },
  );

  it("stops itself after 30 seconds", { timeout: 45000 }, async () => {
    const slow = join(root, "slow");
    mkdirSync(join(slow, ".openclaw", "bin"), { recursive: true });
    writeFileSync(join(slow, ".openclaw", "bin", "openclaw"), "#!/bin/sh\nexec sleep 120\n", {
      mode: 0o755,
    });
    const started = Date.now();
    const { parsed } = await runUnder("/bin/sh", slow);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThan(29000);
    expect(elapsed).toBeLessThan(40000);
    expect(parsed).toEqual({ ok: false, reason: "no-end" });
  });
});
