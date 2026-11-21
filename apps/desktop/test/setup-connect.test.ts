// Connect, with nothing typed (docs/design/setup.md §2, §7): the host's own
// dialog before anything is minted, the one-time code it makes and redeems
// itself for read alone, and the places that code never reaches. A fake
// runner stands in for `openclaw`, and the core's fake gateway for the gateway.

import { ClawtrateClient, type ClawtrateState } from "@clawtrate/core";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FakeGateway,
  helloOk,
  memoryStorage,
  sleep,
  testHost,
  tokenKey,
  until,
} from "../../../packages/core/test/fake-gateway.ts";
import {
  OPERATION_LIFETIME_MS,
  SetupController,
  type Confirmation,
} from "../src/setup/controller.ts";
import {
  checkRequest,
  ProgramRunner,
  type ProgramRequest,
  type ProgramResult,
} from "../src/setup/programs.ts";
import { productionWorld, SetupRefusedError, type LookWorld } from "../src/setup/world.ts";
import type { Identify } from "../../../tools/dev-gateway/src/state-guard.ts";
import { authJson, qrJson, statusJson, VERSION_LINE } from "./fixtures/openclaw-outputs.ts";

/** A recorded status with one fact changed by `change`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function withStatus(json: string, change: (status: any) => void): string {
  const status = JSON.parse(json) as unknown;
  change(status);
  return JSON.stringify(status);
}

const PORT = 19940;
const URL = `ws://127.0.0.1:${PORT}`;
const CODE = "Xq3v8Lw0eXk2Rj9TaNf5Hc1UbYm7Pd4GsZi6Ko2EaVr";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clawtrate-connect-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * The world Connect runs against here: a production-shaped one in a
 * temporary home whose program is a fake runner, allowed to use the found
 * gateway's port. The sandbox's own world is tested in setup-stand-in.test.ts.
 */
function world(): LookWorld {
  const program = join(dir, "bin/openclaw");
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(program, "#!/bin/sh\nexit 1\n");
  chmodSync(program, 0o755);
  mkdirSync(join(dir, "home"), { recursive: true });
  const home = productionWorld({ home: join(dir, "home"), appData: dir, platform: "darwin" });
  return { ...home, candidates: [program], profiles: [home.profiles[0]!], deep: false };
}

type Reply =
  Partial<ProgramResult> | (() => Partial<ProgramResult> | Promise<Partial<ProgramResult>>);

function harness(
  options: {
    replies?: Record<string, Reply>;
    confirm?: ((confirmation: Confirmation) => Promise<boolean>) | null;
    gateway?: FakeGateway;
    world?: LookWorld | SetupRefusedError;
    now?: () => number;
  } = {},
) {
  const timeline: string[] = [];
  const requests: ProgramRequest[] = [];
  const replies: Record<string, Reply> = {
    "--version": { stdout: VERSION_LINE },
    "gateway status --json": { stdout: statusJson({ port: PORT }) },
    "gateway status --json --deep": { stdout: statusJson({ port: PORT }) },
    "config get gateway.auth.mode --json": { stdout: authJson() },
    [`qr --json --voice-node --url ${URL}`]: { stdout: qrJson(URL, CODE, Date.now() + 600_000) },
    ...options.replies,
  };
  const run = async (request: ProgramRequest): Promise<ProgramResult> => {
    checkRequest(request);
    requests.push(request);
    const key = request.args.join(" ");
    timeline.push(`run ${key}`);
    const reply = replies[key];
    const result = typeof reply === "function" ? await reply() : reply;
    return {
      exitCode: 0,
      stdout: "",
      timedOut: false,
      tooLarge: false,
      failed: false,
      ...(result ?? { exitCode: 1 }),
    };
  };
  // The listener the recorded status names (pid 4242), by its start time; a test may replace it.
  const listeners = new Map<number, string>([[4242, "Mon Nov 16 21:27:01 2026"]]);
  const identify: Identify = (pid) => {
    const started = listeners.get(pid);
    return started ? { state: "alive", identity: started } : { state: "exited", how: "absent" };
  };
  const gateway = options.gateway ?? new FakeGateway();
  if (!options.gateway) {
    gateway.connectReply = (params) => {
      const auth = (params as { auth?: { bootstrapToken?: string } }).auth;
      return auth?.bootstrapToken === CODE
        ? { ok: true, payload: helloOk(["operator.read"], "device-token") }
        : { ok: false, error: { code: "INVALID_REQUEST", message: "unauthorized" } };
    };
  }
  const storage = memoryStorage();
  const logs: string[] = [];
  const host = {
    ...testHost(gateway, storage),
    log: (_level: string, line: string) => void logs.push(line),
  };
  const client = new ClawtrateClient(host, { reconnect: { initialMs: 20, maxMs: 40 } });
  const snapshots: string[] = [];
  client.store.subscribe((state: ClawtrateState) => snapshots.push(JSON.stringify(state)));
  const theWorld = options.world ?? world();
  const dialogs: Confirmation[] = [];
  let stopped = 0;
  const confirm =
    options.confirm === null
      ? null
      : async (confirmation: Confirmation) => {
          dialogs.push(confirmation);
          timeline.push("dialog");
          return options.confirm ? options.confirm(confirmation) : true;
        };
  const setup = new SetupController({
    client,
    open: async () => {
      const chosen = theWorld;
      return chosen instanceof SetupRefusedError ? chosen : { world: chosen, run, identify };
    },
    stopPrograms: () => void (stopped += 1),
    confirm,
    log: (line) => logs.push(line),
    ...(options.now ? { now: options.now } : {}),
  });
  /** Everything the code must never reach, as one string. */
  const everywhere = () =>
    [
      ...snapshots,
      JSON.stringify(client.state),
      ...logs,
      ...requests.map((request) => JSON.stringify({ args: request.args, env: request.env })),
      JSON.stringify([...storage.data.entries()]),
      JSON.stringify(dialogs),
    ].join("\n");
  return {
    setup,
    client,
    gateway,
    storage,
    requests,
    timeline,
    dialogs,
    logs,
    everywhere,
    stopped: () => stopped,
    listeners,
  };
}

/** Every file under the temporary folder changed since `since`, as text, a few levels deep. */
function temporaryFiles(since: number): string[] {
  const found: string[] = [];
  const walk = (path: string, depth: number) => {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return;
    }
    if (stat.mtimeMs < since) return;
    if (stat.isDirectory() && depth < 4) {
      let entries: string[];
      try {
        entries = readdirSync(path);
      } catch {
        return;
      }
      for (const entry of entries) walk(join(path, entry), depth + 1);
    } else if (stat.isFile() && stat.size < 1024 * 1024) {
      try {
        found.push(readFileSync(path, "utf8"));
      } catch {
        // not readable: not written by this test
      }
    }
  };
  for (const entry of readdirSync(tmpdir())) walk(join(tmpdir(), entry), 0);
  return found;
}

const minted = (requests: ProgramRequest[]) =>
  requests.filter((request) => request.args.includes("qr"));

describe("Connect on this computer", () => {
  it("F-494 F-492: Connect asks the host's dialog first, then redeems a voice-node code for read alone, and the code reaches no state, snapshot, log, argument, environment, storage or dialog", async () => {
    const started = Date.now();
    const h = harness();
    await h.client.start();
    await h.setup.look();
    expect(h.setup.current.phase).toBe("found");
    expect(h.setup.current.look?.outcome).toBe("running");
    await h.setup.connect();
    await until(() => h.setup.current.phase === "done");

    expect(h.dialogs).toEqual([
      {
        message: "Pair this device read-only with the default gateway on this computer?",
        detail:
          "Clawtrate asks for read access. The gateway may ask its owner to approve this device.",
        confirm: "Pair",
      },
    ]);
    // Nothing is minted before the answer; the facts are read again after it.
    const dialogAt = h.timeline.indexOf("dialog");
    const qrAt = h.timeline.findIndex((line) => line.includes(" qr "));
    expect(dialogAt).toBeGreaterThan(-1);
    expect(qrAt).toBeGreaterThan(dialogAt);
    expect(h.timeline.slice(dialogAt + 1, qrAt)).toEqual(
      expect.arrayContaining([
        "run gateway status --json",
        "run config get gateway.auth.mode --json",
      ]),
    );
    expect(minted(h.requests)).toHaveLength(1);
    expect(minted(h.requests)[0]!.args).toEqual(["qr", "--json", "--voice-node", "--url", URL]);
    const sent = h.gateway.connects[0] as { scopes: string[]; auth: Record<string, string> };
    expect(sent.scopes).toEqual(["operator.read"]);
    expect(sent.auth).toEqual({ bootstrapToken: CODE });
    expect(h.client.state.connection.status).toBe("connected");
    expect(JSON.parse(h.storage.data.get(tokenKey(URL))!).heldScopes).toEqual(["operator.read"]);
    expect(h.everywhere()).not.toContain(CODE);
    expect(temporaryFiles(started).filter((text) => text.includes(CODE))).toEqual([]);
    // The shared token is never asked for: no command reads it or the config file.
    for (const request of h.requests) {
      expect(request.args.join(" ")).not.toMatch(/auth-token|gateway\.auth\.token|openclaw\.json/);
    }
    h.client.stop();
    // The temporary folder is scanned, which takes a while on a busy machine.
  }, 60_000);

  it("F-492: Connect redeems a voice-node code itself, asking for read, and the code stays out of renderer state, diagnostics and published errors", async () => {
    const h = harness();
    // The gateway refuses the code once, echoing it, then takes it.
    let refused = false;
    h.gateway.connectReply = (params) => {
      const auth = (params as { auth?: { bootstrapToken?: string } }).auth;
      if (!refused) {
        refused = true;
        return {
          ok: false,
          error: { code: "INVALID_REQUEST", message: `bad ${CODE}`, details: { code: CODE } },
        };
      }
      return auth?.bootstrapToken === CODE
        ? { ok: true, payload: helloOk(["operator.read"], "device-token") }
        : { ok: false, error: { code: "INVALID_REQUEST", message: "unauthorized" } };
    };
    await h.client.start();
    await h.setup.look();
    await h.setup.connect();
    await until(() => h.setup.current.phase === "failed");
    expect(h.dialogs).toHaveLength(1);
    expect(minted(h.requests).map((request) => request.args)).toEqual([
      ["qr", "--json", "--voice-node", "--url", URL],
    ]);
    const sent = h.gateway.connects[0] as { scopes: string[]; auth: Record<string, string> };
    expect(sent.scopes).toEqual(["operator.read"]);
    expect(sent.auth).toEqual({ bootstrapToken: CODE });
    // Renderer state (every snapshot), diagnostics (every log line) and the published error.
    expect(h.client.state.connection.error?.code).toBe("SETUP_CONNECT_REFUSED");
    expect(h.everywhere()).not.toContain(CODE);
    h.client.stop();
  });

  it("F-492: declining the host's dialog mints nothing and pairs nothing", async () => {
    const h = harness({ confirm: async () => false });
    await h.client.start();
    await h.setup.look();
    await h.setup.connect();
    expect(h.setup.current.phase).toBe("found");
    expect(minted(h.requests)).toEqual([]);
    await sleep(50);
    expect(h.gateway.connects).toEqual([]);
    expect([...h.storage.data.keys()]).toEqual([]);
    h.client.stop();
  });

  it("F-494: a host with no dialog of its own, the web preview, pairs nothing", async () => {
    const h = harness({ confirm: null });
    await h.client.start();
    await h.setup.look();
    await h.setup.connect();
    expect(h.setup.current.failure?.kind).toBe("no-dialog");
    expect(minted(h.requests)).toEqual([]);
    expect(h.gateway.connects).toEqual([]);
    h.client.stop();
  });

  it("F-492: facts that changed between the dialog and its answer run nothing", async () => {
    let port = PORT;
    const h = harness({
      replies: { "gateway status --json": () => ({ stdout: statusJson({ port }) }) },
      confirm: async () => {
        port = 19960;
        return true;
      },
    });
    await h.client.start();
    await h.setup.look();
    await h.setup.connect();
    expect(h.setup.current.failure?.kind).toBe("changed");
    expect(minted(h.requests)).toEqual([]);
    expect(h.gateway.connects).toEqual([]);
    h.client.stop();
  });

  it("F-492: an answer after the operation's two minutes runs nothing", async () => {
    let now = 1_000_000;
    const h = harness({
      now: () => now,
      confirm: async () => {
        now += OPERATION_LIFETIME_MS + 1;
        return true;
      },
    });
    await h.client.start();
    await h.setup.look();
    await h.setup.connect();
    expect(h.setup.current.failure?.kind).toBe("changed");
    expect(minted(h.requests)).toEqual([]);
    h.client.stop();
  });

  it("F-492: a code that can't be made ends in its own state, with the exit code", async () => {
    const h = harness({
      replies: { [`qr --json --voice-node --url ${URL}`]: { exitCode: 1, stdout: "" } },
    });
    await h.client.start();
    await h.setup.look();
    await h.setup.connect();
    expect(h.setup.current).toMatchObject({
      phase: "failed",
      failure: { kind: "code-failed", exitCode: 1 },
    });
    expect(h.gateway.connects).toEqual([]);
    h.client.stop();
  });

  it("F-494 F-492: a code for another address is refused before it is sent", async () => {
    const h = harness({
      replies: {
        [`qr --json --voice-node --url ${URL}`]: {
          stdout: qrJson("ws://192.0.2.10:19940", CODE, Date.now() + 600_000),
        },
      },
    });
    await h.client.start();
    await h.setup.look();
    await h.setup.connect();
    expect(h.setup.current.failure?.kind).toBe("code-failed");
    expect(h.gateway.connects).toEqual([]);
    expect(h.everywhere()).not.toContain(CODE);
    h.client.stop();
  });

  it("F-492: a code the gateway refuses ends in its own state", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "unauthorized: setup code invalid, expired, revoked, or already used",
        details: { code: "AUTH_BOOTSTRAP_TOKEN_INVALID" },
      },
    });
    const h = harness({ gateway });
    await h.client.start();
    await h.setup.look();
    await h.setup.connect();
    await until(() => h.setup.current.phase === "failed");
    expect(h.setup.current.failure?.kind).toBe("code-refused");
    expect(h.everywhere()).not.toContain(CODE);
    h.client.stop();
  });

  it("F-492: a grant wider than read ends in its own state and writes no token", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: true,
      payload: helloOk(["operator.read", "operator.write"], "wide-token"),
    });
    const h = harness({ gateway });
    await h.client.start();
    await h.setup.look();
    await h.setup.connect();
    await until(() => h.setup.current.phase === "failed");
    expect(h.setup.current.failure?.kind).toBe("grant");
    expect(h.storage.data.has(tokenKey(URL))).toBe(false);
    expect(h.everywhere()).not.toContain("wide-token");
    h.client.stop();
  });

  it("F-492: a gateway that asks before every device ends on the pairing screen", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: false,
      error: {
        code: "NOT_PAIRED",
        message: "device pairing required",
        details: {
          code: "PAIRING_REQUIRED",
          requestId: "e5eb4aa8-175f-40f1-bc7a-8f15cfc40942",
          deviceId: "device-1",
          requestedScopes: ["operator.read"],
        },
      },
    });
    const h = harness({ gateway });
    await h.client.start();
    await h.setup.look();
    await h.setup.connect();
    await until(() => h.client.state.connection.status === "pairing");
    expect(h.client.state.connection.pairing?.requestedScopes).toEqual(["operator.read"]);
    expect(h.setup.current.phase).toBe("connecting");
    h.client.stop();
  });

  it("F-515: another reported version cannot pair, start an update, or open a socket", async () => {
    for (const [version, outcome] of [
      ["2026.9.37", "untested"],
      ["2026.6.2", "too-old"],
    ] as const) {
      const h = harness({
        replies: {
          "gateway status --json": { stdout: statusJson({ port: PORT, answered: version }) },
        },
      });
      await h.client.start();
      await h.setup.look();
      expect(h.setup.current.look?.outcome, version).toBe(outcome);
      await expect(h.setup.connect()).rejects.toThrow(/nothing to connect to/);
      expect(h.dialogs).toEqual([]);
      expect(minted(h.requests)).toEqual([]);
      expect(h.gateway.sockets).toHaveLength(0);
      expect([...h.storage.data.keys()].filter((key) => key.startsWith("deviceToken:"))).toEqual(
        [],
      );
      // Only the look's own commands ran: nothing that pairs, updates or changes OpenClaw.
      expect(h.requests.map(({ args }) => args.join(" ")).sort()).toEqual([
        "--version",
        "config get gateway.auth.mode --json",
        "gateway status --json",
      ]);
      h.client.stop();
    }
  });

  it("Back during the look ends its programs and returns to the first screen", async () => {
    let release!: () => void;
    const h = harness({
      replies: {
        "gateway status --json": () =>
          new Promise((resolve) => {
            release = () => resolve({ stdout: statusJson({ port: PORT }) });
          }),
      },
    });
    await h.client.start();
    const looking = h.setup.look();
    await until(() => h.setup.current.step === 2);
    const before = h.stopped();
    h.setup.cancel();
    expect(h.stopped()).toBe(before + 1);
    expect(h.setup.current.phase).toBe("idle");
    release();
    await looking;
    expect(h.setup.current.phase).toBe("idle");
    h.client.stop();
  });

  it("a run given no sandbox, or a sandbox that didn't pass, is refused in fixed words, and starts and reads nothing", async () => {
    for (const reason of ["missing", "file", "home", "state"] as const) {
      const h = harness({ world: new SetupRefusedError(reason) });
      await h.client.start();
      await h.setup.look();
      expect(h.setup.current, reason).toMatchObject({
        phase: "failed",
        failure: { kind: "refused", reason },
      });
      expect(
        h.logs.filter((line) => line.includes("refused to start")),
        reason,
      ).toEqual([`[setup] ${new SetupRefusedError(reason).message}`]);
      expect(h.requests, reason).toEqual([]);
      h.client.stop();
    }
  });

  it("an error that isn't a refusal is logged as a fixed refusal, never its own text", async () => {
    const h = harness();
    const secret = "fixture-secret-0123456789abcdef";
    const setup = new SetupController({
      client: h.client,
      open: () => Promise.reject(new Error(`boom ${secret} /accounts/someone`)),
      stopPrograms: () => {},
      confirm: null,
      log: (line) => h.logs.push(line),
    });
    await setup.look();
    expect(setup.current.failure).toMatchObject({ kind: "refused", reason: "file" });
    expect(h.logs.join("\n")).not.toContain(secret);
    expect(h.logs.join("\n")).not.toContain("/accounts/");
    h.client.stop();
  });

  it("F-492: a device already paired with that gateway reconnects with its own token and mints no code", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: true,
      payload: helloOk(["operator.read"], "device-token"),
    });
    const h = harness({ gateway });
    await h.storage.set(
      tokenKey(URL),
      JSON.stringify({
        token: "device-token",
        grantedScopes: ["operator.read"],
        heldScopes: ["operator.read"],
      }),
    );
    await h.client.start();
    await h.setup.look();
    await h.setup.connect();
    await until(() => h.setup.current.phase === "done");
    expect(minted(h.requests)).toEqual([]);
    expect((h.gateway.connects[0] as { auth: unknown }).auth).toEqual({
      deviceToken: "device-token",
    });
    h.client.stop();
  });
});

describe("the programs setup starts", () => {
  const base = {
    program: "/usr/bin/true",
    env: {},
    cwd: "/tmp",
    timeoutMs: 1000,
    maxBytes: 1024,
  };
  const ok = (args: string[]) => () => checkRequest({ ...base, args });

  it("F-494: starts only the exact commands the look and Connect use", () => {
    for (const args of [
      ["--version"],
      ["gateway", "status", "--json"],
      ["gateway", "status", "--json", "--deep"],
      ["config", "get", "gateway.auth.mode", "--json"],
      ["--profile", "clawtrate", "gateway", "status", "--json"],
      ["--profile", "clawtrate-dev-su1-test", "qr", "--json", "--voice-node", "--url", URL],
    ]) {
      expect(ok(args), args.join(" ")).not.toThrow();
    }
    for (const args of [
      ["gateway", "status", "--json", "--no-probe"],
      ["gateway", "status", "--json", "--url", URL],
      ["gateway", "start"],
      ["config", "get", "gateway.auth.token"],
      ["--profile", "work", "gateway", "status", "--json"],
      ["--profile", "clawtrate-dev-Bad", "--version"],
      ["qr", "--json", "--voice-node", "--url", "ws://192.0.2.10:19940"],
      ["qr", "--json", "--voice-node", "--url", "wss://127.0.0.1:19940"],
      ["qr", "--json", "--url", URL],
      ["--version", "--json"],
      [],
    ]) {
      expect(ok(args), args.join(" ")).toThrow();
    }
  });

  it("F-494: passes only the look's variables, and needs a working folder of its own", () => {
    expect(() => checkRequest({ ...base, args: ["--version"], env: { TOKEN: "x" } })).toThrow();
    for (const value of ["/tmp\nHOME=/x", "/tmp\u0000", "/tmp\u007f"])
      expect(() => checkRequest({ ...base, args: ["--version"], env: { HOME: value } })).toThrow();
    expect(() => checkRequest({ ...base, args: ["--version"], cwd: "relative" })).toThrow();
    expect(() =>
      checkRequest({ ...base, args: ["--version"], program: "relative/openclaw" }),
    ).toThrow();
    expect(() =>
      checkRequest({ ...base, args: ["--version"], env: { HOME: "/tmp", OPENCLAW_PROFILE: "x" } }),
    ).not.toThrow();
  });

  it("F-494: an account home with any name a file can have runs the look, and so does a program under it", () => {
    for (const home of [
      "/srv/accounts/José",
      "/srv/accounts/O'Connor",
      "/srv/accounts/a&b (work)",
    ]) {
      expect(() =>
        checkRequest({
          ...base,
          args: ["--version"],
          program: `${home}/.local/bin/openclaw`,
          env: { HOME: home, PATH: `${home}/.local/bin:/usr/bin:/bin` },
        }),
      ).not.toThrow();
    }
    expect(() =>
      checkRequest({
        ...base,
        args: ["--version"],
        program: "/srv/accounts/a\nb/.local/bin/openclaw",
      }),
    ).toThrow();
  });

  /** A runner for real system programs, with the look's own command check set aside. */
  const loose = () => new ProgramRunner({ check: () => {}, graceMs: 300 });

  it("F-494: a program gets exactly the environment and the working folder it is given, and its errors are not kept", async () => {
    const runner = loose();
    const result = await runner.run({
      ...base,
      program: "/usr/bin/env",
      args: [],
      env: { ONLY: "this" },
      timeoutMs: 5000,
      maxBytes: 4096,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("ONLY=this");
    const where = await runner.run({
      ...base,
      program: "/bin/pwd",
      args: [],
      cwd: dir,
      timeoutMs: 5000,
      maxBytes: 4096,
    });
    expect(realpathSync(where.stdout.trim())).toBe(realpathSync(dir));
    const failing = await runner.run({
      ...base,
      program: "/bin/ls",
      args: ["nonexistent-clawtrate-path"],
      timeoutMs: 5000,
      maxBytes: 4096,
    });
    expect(failing.exitCode).not.toBe(0);
    expect(JSON.stringify(failing)).not.toContain("nonexistent");
  });

  it("ends a program at its time limit and its output limit, and kills one that ignores the request to stop", async () => {
    const runner = loose();
    const slow = await runner.run({
      ...base,
      program: "/bin/sleep",
      args: ["5"],
      timeoutMs: 100,
      maxBytes: 4096,
    });
    expect(slow.timedOut).toBe(true);
    const large = await runner.run({
      ...base,
      program: "/usr/bin/yes",
      args: [],
      timeoutMs: 5000,
      maxBytes: 1024,
    });
    expect(large).toMatchObject({ tooLarge: true, stdout: "" });
    const started = Date.now();
    const stubborn = await runner.run({
      ...base,
      program: "/bin/sh",
      args: ["-c", "trap '' TERM; while :; do sleep 1; done"],
      timeoutMs: 100,
      maxBytes: 4096,
    });
    expect(stubborn.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(runner.running()).toEqual([]);
  }, 20_000);

  it("the host's runner refuses anything but the look's commands before it starts", async () => {
    const runner = new ProgramRunner();
    expect(() => runner.run({ ...base, program: "/usr/bin/env", args: [] })).toThrow();
  });
});

describe("Connect goes only to the gateway that answered, and says what is true", () => {
  const changedAfterDialog = async (change: Record<string, Reply>) => {
    let answered = false;
    const replies: Record<string, Reply> = {};
    for (const [key, reply] of Object.entries(change)) {
      const before = {
        "gateway status --json": { stdout: statusJson({ port: PORT }) },
        "config get gateway.auth.mode --json": { stdout: authJson() },
      }[key];
      replies[key] = () => (answered ? (typeof reply === "function" ? reply() : reply) : before!);
    }
    const h = harness({
      replies,
      confirm: async () => {
        answered = true;
        return true;
      },
    });
    await h.client.start();
    await h.setup.look();
    expect(h.setup.current.look?.outcome).toBe("running");
    await h.setup.connect();
    return h;
  };

  for (const [name, change] of [
    [
      "the service changed",
      { "gateway status --json": { stdout: statusJson({ port: PORT, service: "running" }) } },
    ],
    [
      "the status probed elsewhere",
      {
        "gateway status --json": {
          stdout: statusJson({ port: PORT, probeUrl: "ws://127.0.0.1:19960" }),
        },
      },
    ],
    [
      "its RPC answered elsewhere",
      {
        "gateway status --json": {
          stdout: statusJson({ port: PORT, rpcUrl: "wss://127.0.0.1:19940" }),
        },
      },
    ],
    [
      "the auth command failed",
      { "config get gateway.auth.mode --json": { exitCode: 1, stdout: authJson() } },
    ],
    [
      "the auth command timed out",
      {
        // Exit 0 and a well-shaped answer: only the timeout says it didn't finish.
        "config get gateway.auth.mode --json": {
          timedOut: true,
          exitCode: 0,
          stdout: authJson(),
        },
      },
    ],
    [
      "the status timed out with a well-shaped answer",
      {
        "gateway status --json": {
          timedOut: true,
          exitCode: 0,
          stdout: statusJson({ port: PORT }),
        },
      },
    ],
    [
      "the status went over its limit with a well-shaped answer",
      {
        "gateway status --json": {
          tooLarge: true,
          exitCode: 0,
          stdout: statusJson({ port: PORT }),
        },
      },
    ],
    [
      "its service's unit was replaced",
      {
        "gateway status --json": {
          stdout: withStatus(statusJson({ port: PORT }), (status) => {
            status.service.runtime = { status: "unknown", missingUnit: true, pid: 5151 };
          }),
        },
      },
    ],
    [
      "the service's config is another file",
      {
        "gateway status --json": {
          stdout: withStatus(statusJson({ port: PORT }), (status) => {
            status.config.daemon.path = "<other>/openclaw.json";
          }),
        },
      },
    ],
    [
      "another process listens on the port",
      {
        "gateway status --json": {
          stdout: withStatus(statusJson({ port: PORT }), (status) => {
            status.port.listeners[0].pid = 5252;
          }),
        },
      },
    ],
  ] as const) {
    it(`F-492 F-516: ${name} between the dialog and its answer, and nothing is minted`, async () => {
      const h = await changedAfterDialog(change as Record<string, Reply>);
      expect(h.setup.current.failure?.kind).toBe("changed");
      expect(minted(h.requests)).toEqual([]);
      expect(h.gateway.connects).toEqual([]);
      h.client.stop();
    });
  }

  it("F-516 F-492: the listener replaced by another process, or restarted under its PID, between the dialog and its answer mints nothing and saves no route", async () => {
    for (const replace of [
      (h: ReturnType<typeof harness>) => h.listeners.delete(4242),
      (h: ReturnType<typeof harness>) => h.listeners.set(4242, "Tue Nov 17 08:00:00 2026"),
    ]) {
      const h: ReturnType<typeof harness> = harness({
        confirm: async () => {
          replace(h);
          return true;
        },
      });
      await h.client.start();
      await h.setup.look();
      await h.setup.connect();
      expect(h.setup.current.failure?.kind).toBe("changed");
      expect(minted(h.requests)).toEqual([]);
      expect(h.gateway.sockets).toHaveLength(0);
      expect(h.storage.data.has("connection")).toBe(false);
      h.client.stop();
    }
  });

  it("F-516 F-492: a listener replaced while the code is made sends no code: nothing connects and no route is saved", async () => {
    const h: ReturnType<typeof harness> = harness({
      replies: {
        [`qr --json --voice-node --url ${URL}`]: () => {
          h.listeners.set(4242, "Tue Nov 17 08:00:00 2026");
          return { stdout: qrJson(URL, CODE, Date.now() + 600_000) };
        },
      },
    });
    await h.client.start();
    await h.setup.look();
    await h.setup.connect();
    expect(minted(h.requests)).toHaveLength(1);
    expect(h.setup.current.failure?.kind).toBe("changed");
    expect(h.gateway.sockets).toHaveLength(0);
    expect(h.storage.data.has("connection")).toBe(false);
    expect(h.everywhere()).not.toContain(CODE);
    h.client.stop();
  });

  it("F-516 F-492: a service replaced while the code is made sends no code", async () => {
    let made = false;
    const h = harness({
      replies: {
        "gateway status --json": () => ({
          stdout: made
            ? withStatus(statusJson({ port: PORT }), (status) => {
                status.service.runtime = { status: "unknown", missingUnit: true, pid: 5151 };
              })
            : statusJson({ port: PORT }),
        }),
        [`qr --json --voice-node --url ${URL}`]: () => {
          made = true;
          return { stdout: qrJson(URL, CODE, Date.now() + 600_000) };
        },
      },
    });
    await h.client.start();
    await h.setup.look();
    await h.setup.connect();
    expect(minted(h.requests)).toHaveLength(1);
    expect(h.setup.current.failure?.kind).toBe("changed");
    expect(h.gateway.sockets).toHaveLength(0);
    h.client.stop();
  });

  it("F-494 F-492: a code that claims to live longer than ten minutes is not one made here, and nothing connects", async () => {
    const h = harness({
      replies: {
        [`qr --json --voice-node --url ${URL}`]: {
          stdout: qrJson(URL, CODE, Date.now() + 11 * 60_000),
        },
      },
    });
    await h.client.start();
    await h.setup.look();
    await h.setup.connect();
    expect(h.setup.current.failure?.kind).toBe("code-failed");
    expect(h.gateway.sockets).toHaveLength(0);
    h.client.stop();
  });

  it("F-494 F-492: a code that timed out or went over its limit is not read, even well shaped, and nothing connects", async () => {
    for (const late of [{ timedOut: true }, { tooLarge: true }, { failed: true }]) {
      const h = harness({
        replies: {
          [`qr --json --voice-node --url ${URL}`]: {
            exitCode: 0,
            ...late,
            stdout: qrJson(URL, CODE, Date.now() + 600_000),
          },
        },
      });
      await h.client.start();
      await h.setup.look();
      await h.setup.connect();
      expect(h.setup.current.failure?.kind, JSON.stringify(late)).toBe("code-failed");
      expect(h.gateway.sockets).toHaveLength(0);
      expect(h.everywhere()).not.toContain(CODE);
      h.client.stop();
    }
  });

  it("F-492: a program file replaced at the same path after the look runs nothing more", async () => {
    const h: ReturnType<typeof harness> = harness({
      confirm: async () => {
        const program = join(dir, "bin/openclaw");
        rmSync(program);
        writeFileSync(program, "#!/bin/sh\nexit 0\n");
        chmodSync(program, 0o755);
        return true;
      },
    });
    await h.client.start();
    await h.setup.look();
    const before = h.requests.length;
    await h.setup.connect();
    expect(h.setup.current.failure?.kind).toBe("changed");
    expect(h.requests.length).toBe(before);
    h.client.stop();
  });

  it("F-492: the consent's two minutes hold on the branch of a device already paired too", async () => {
    let now = 1_000_000;
    const h: ReturnType<typeof harness> = harness({
      now: () => now,
      replies: {
        "gateway status --json": () => {
          // The recheck after the dialog ends past the consent's two minutes.
          if (h.dialogs.length > 0) now += OPERATION_LIFETIME_MS + 1;
          return { stdout: statusJson({ port: PORT }) };
        },
      },
    });
    await h.storage.set(
      tokenKey(URL),
      JSON.stringify({
        token: "device-token",
        grantedScopes: ["operator.read"],
        heldScopes: ["operator.read"],
      }),
    );
    await h.client.start();
    await h.setup.look();
    await h.setup.connect();
    expect(h.setup.current.failure?.kind).toBe("changed");
    expect(h.gateway.sockets).toHaveLength(0);
    h.client.stop();
  });

  it("F-516: with the default and Clawtrate's own profile both confirmed at distinct endpoints, the default is chosen and only its commands run", async () => {
    const own = join(dir, "home/.openclaw-clawtrate");
    mkdirSync(own, { recursive: true });
    const home = productionWorld({ home: join(dir, "home"), appData: dir, platform: "darwin" });
    const program = join(dir, "bin/openclaw");
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(program, "#!/bin/sh\nexit 1\n");
    chmodSync(program, 0o755);
    const h = harness({
      world: { ...home, candidates: [program], deep: false },
      replies: {
        "--profile clawtrate gateway status --json": { stdout: statusJson({ port: 19960 }) },
        "--profile clawtrate config get gateway.auth.mode --json": { stdout: authJson() },
      },
    });
    await h.client.start();
    await h.setup.look();
    expect(h.setup.current.look).toMatchObject({ outcome: "running", profile: "default" });
    const looked = h.requests.length;
    await h.setup.connect();
    await until(() => h.setup.current.phase === "done");
    const after = h.requests.slice(looked);
    expect(after.length).toBeGreaterThan(0);
    for (const request of after) expect(request.args).not.toContain("--profile");
    expect(minted(after)[0]!.args.at(-1)).toBe(URL);
    h.client.stop();
  });

  it("F-492: a device with a saved pairing that holds write is told it has one, and Connect asks for read alone and holds read", async () => {
    const h = harness();
    await h.storage.set(
      tokenKey(URL),
      JSON.stringify({
        token: "device-token",
        grantedScopes: ["operator.read", "operator.write"],
        heldScopes: ["operator.read", "operator.write"],
      }),
    );
    h.gateway.connectReply = () => ({
      ok: true,
      payload: helloOk(["operator.read", "operator.write"], "device-token"),
    });
    await h.client.start();
    await h.setup.look();
    expect(h.setup.current.look?.access).toBe("paired");
    await h.setup.connect();
    await until(() => h.setup.current.phase === "done");
    expect(h.dialogs[0]).toEqual({
      message: "Connect this device read-only to the default gateway on this computer?",
      detail: "This device has a saved pairing for this address.",
      confirm: "Connect read-only",
    });
    expect(JSON.stringify(h.dialogs)).not.toMatch(/can also send|already paired/);
    expect((h.gateway.connects[0] as { scopes: string[] }).scopes).toEqual(["operator.read"]);
    expect(h.client.state.connection.canWrite).toBe(false);
    expect(minted(h.requests)).toEqual([]);
    h.client.stop();
  });

  it("F-492: a saved pairing gone after the dialog sends nothing, and the card asks for a new consent", async () => {
    const h = harness({
      replies: {
        "gateway status --json": () => {
          // The pairing is removed while the facts are read again after the dialog.
          if (h.dialogs.length > 0) h.storage.data.delete(tokenKey(URL));
          return { stdout: statusJson({ port: PORT }) };
        },
      },
    });
    await h.storage.set(
      tokenKey(URL),
      JSON.stringify({
        token: "device-token",
        grantedScopes: ["operator.read"],
        heldScopes: ["operator.read"],
      }),
    );
    await h.client.start();
    await h.setup.look();
    await h.setup.connect();
    await until(() => h.setup.current.phase === "found");
    expect(h.setup.current.look?.access).toBe("new");
    expect(h.gateway.connects).toEqual([]);
    expect(minted(h.requests)).toEqual([]);
    h.client.stop();
  });

  it("a new look ends the earlier look's programs before it asks anything", async () => {
    let release!: () => void;
    const stopsAtVersion: number[] = [];
    let looks = 0;
    const h: ReturnType<typeof harness> = harness({
      replies: {
        "--version": () => {
          looks += 1;
          stopsAtVersion.push(h.stopped());
          return looks === 1
            ? new Promise((resolve) => (release = () => resolve({ stdout: VERSION_LINE })))
            : { stdout: VERSION_LINE };
        },
      },
    });
    await h.client.start();
    const first = h.setup.look();
    await until(() => stopsAtVersion.length === 1);
    await h.setup.look();
    release();
    await first;
    expect(stopsAtVersion[1]).toBeGreaterThan(stopsAtVersion[0]!);
    h.client.stop();
  });

  it("Back while the host's dialog is open returns to the card, and a later yes runs nothing", async () => {
    let answer!: (yes: boolean) => void;
    const h = harness({ confirm: () => new Promise((resolve) => (answer = resolve)) });
    await h.client.start();
    await h.setup.look();
    const looked = h.requests.length;
    const connecting = h.setup.connect();
    await until(() => h.setup.current.phase === "confirming");
    h.setup.cancel();
    expect(h.setup.current.phase).toBe("found");
    answer(true);
    await connecting;
    expect(h.setup.current.phase).toBe("found");
    expect(h.requests.length).toBe(looked);
    expect(h.gateway.sockets).toHaveLength(0);
    h.client.stop();
  });

  it("Back while the sandbox is checked again before the look starts nothing", async () => {
    const h = harness();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let ran = 0;
    const setup = new SetupController({
      client: h.client,
      open: async () => {
        await held;
        return {
          world: world(),
          run: async () => {
            ran += 1;
            return { exitCode: 0, stdout: "", timedOut: false, tooLarge: false, failed: false };
          },
          identify: () => ({ state: "exited", how: "absent" }),
        };
      },
      stopPrograms: () => {},
      confirm: null,
    });
    const looking = setup.look();
    setup.cancel();
    release();
    await looking;
    expect(setup.current.phase).toBe("idle");
    expect(ran).toBe(0);
    h.client.stop();
  });

  it("Back while the bots load closes the setup's own connection, and opens nothing more", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = (params) => {
      const auth = (params as { auth?: { bootstrapToken?: string } }).auth;
      return auth?.bootstrapToken === CODE
        ? { ok: true, payload: helloOk(["operator.read"], "device-token") }
        : { ok: false, error: { code: "INVALID_REQUEST", message: "unauthorized" } };
    };
    // The bots never arrive while Back is pressed.
    gateway.handlers["agents.list"] = () => new Promise(() => {});
    const h = harness({ gateway });
    await h.client.start();
    await h.setup.look();
    void h.setup.connect();
    await until(() => h.client.state.connection.status === "connected");
    expect(h.client.state.discovery.status).toBe("loading");
    h.setup.cancel();
    await until(() => h.client.state.connection.status === "idle");
    const sockets = h.gateway.sockets.length;
    await sleep(100);
    expect(h.gateway.sockets).toHaveLength(sockets);
    expect(h.setup.current.phase).toBe("found");
    h.client.stop();
  });

  it("Back leaves alone a connection the setup didn't open", async () => {
    const h = harness();
    h.gateway.connectReply = () => ({
      ok: true,
      payload: helloOk(["operator.read"], "other-token"),
    });
    await h.client.start();
    await h.client.connect({ url: "ws://127.0.0.1:19960", token: "typed" });
    await until(() => h.client.state.connection.status === "connected");
    await h.setup.look();
    h.setup.cancel();
    h.setup.reset();
    await sleep(50);
    expect(h.client.state.connection).toMatchObject({
      status: "connected",
      gatewayUrl: "ws://127.0.0.1:19960",
    });
    h.client.stop();
  });

  it("Back while the setup connection still waits to open ends it: no socket opens and nothing is saved", async () => {
    let holding = false;
    const held: Array<() => void> = [];
    const h = harness({
      replies: {
        [`qr --json --voice-node --url ${URL}`]: () => {
          // From the code on, the client's read of this device's token waits.
          holding = true;
          return { stdout: qrJson(URL, CODE, Date.now() + 600_000) };
        },
      },
    });
    const get = h.storage.get.bind(h.storage);
    h.storage.get = async (key: string) => {
      if (holding && key === tokenKey(URL)) await new Promise<void>((go) => held.push(go));
      return get(key);
    };
    await h.client.start();
    await h.setup.look();
    const connecting = h.setup.connect();
    await until(() => held.length > 0);
    // Nothing is selected yet: the connection hasn't published its address.
    expect(h.client.state.connection.gatewayUrl).toBeNull();
    h.setup.cancel();
    holding = false;
    for (const go of held) go();
    await connecting;
    await until(() => h.client.state.connection.status === "idle");
    await sleep(100);
    expect(h.gateway.sockets).toHaveLength(0);
    expect(h.client.state.connection.gatewayUrl).toBeNull();
    expect(h.storage.data.has("connection")).toBe(false);
    expect(h.setup.current.phase).toBe("found");
    h.client.stop();
  });

  it("F-492: a saved pairing gone before Connect checks for it makes no new pairing: the card asks for a new consent", async () => {
    const h = harness({
      confirm: async () => {
        // The person agreed to reuse the pairing; it goes while the dialog is answered.
        h.storage.data.delete(tokenKey(URL));
        return true;
      },
    });
    await h.storage.set(
      tokenKey(URL),
      JSON.stringify({
        token: "device-token",
        grantedScopes: ["operator.read"],
        heldScopes: ["operator.read"],
      }),
    );
    await h.client.start();
    await h.setup.look();
    expect(h.setup.current.look?.access).toBe("paired");
    await h.setup.connect();
    expect(h.dialogs[0]?.confirm).toBe("Connect read-only");
    expect(h.setup.current).toMatchObject({ phase: "found", failure: null });
    expect(h.setup.current.look?.access).toBe("new");
    expect(minted(h.requests)).toEqual([]);
    expect(h.gateway.connects).toEqual([]);
    h.client.stop();
  });

  it("a saved record that can't be read ends Connect in a failure to try again from, not on its progress", async () => {
    const h = harness();
    await h.client.start();
    await h.setup.look();
    h.client.hasDeviceToken = () => Promise.reject(new SyntaxError("Unexpected token"));
    await h.setup.connect();
    expect(h.setup.current).toMatchObject({ phase: "failed", failure: { kind: "other" } });
    expect(minted(h.requests)).toEqual([]);
    expect(h.gateway.connects).toEqual([]);
    expect(h.everywhere()).not.toContain("Unexpected token");
    h.client.stop();
  });

  it("F-492: Use another gateway on the setup's pairing screen ends the setup's attempt and returns to the card", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: false,
      error: {
        code: "NOT_PAIRED",
        message: "device pairing required",
        details: { code: "PAIRING_REQUIRED", requestId: "e5eb4aa8", requestedScopes: [] },
      },
    });
    const h = harness({ gateway });
    await h.client.start();
    await h.setup.look();
    await h.setup.connect();
    await until(() => h.client.state.connection.status === "pairing");
    expect(h.setup.current.phase).toBe("connecting");
    // As the pairing screen's button sends it.
    await h.client.disconnect(URL);
    await until(() => h.setup.current.phase === "found");
    expect(h.setup.current.look?.outcome).toBe("running");
    const sockets = h.gateway.sockets.length;
    await sleep(100);
    expect(h.gateway.sockets).toHaveLength(sockets);
    h.client.stop();
  });

  it("a connection to another route doesn't finish the setup: only its own route does", async () => {
    const h = harness();
    h.gateway.connectReply = (params, url) => {
      if (url !== URL) return { ok: true, payload: helloOk(["operator.read"], "other-token") };
      const auth = (params as { auth?: { bootstrapToken?: string } }).auth;
      return auth?.bootstrapToken === CODE
        ? { ok: true, payload: helloOk(["operator.read"], "device-token") }
        : { ok: false, error: { code: "INVALID_REQUEST", message: "unauthorized" } };
    };
    await h.client.start();
    // Another route, connected with its bots read, while the setup looks and connects.
    await h.client.connect({ url: "ws://127.0.0.1:19960", token: "typed" });
    await until(() => h.client.state.discovery.status === "ready");
    await h.setup.look();
    const doneAt: Array<string | null> = [];
    h.client.store.subscribe((state) => {
      if (h.setup.current.phase === "done" && doneAt.length === 0)
        doneAt.push(state.connection.gatewayUrl);
    });
    await h.setup.connect();
    await until(() => h.setup.current.phase === "done");
    expect(doneAt[0]).toBe(URL);
    h.client.stop();
  });

  it("connected with bots that couldn't be read, a retry that reads them opens the app", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = (params) => {
      const auth = (params as { auth?: { bootstrapToken?: string; deviceToken?: string } }).auth;
      return auth?.bootstrapToken === CODE || auth?.deviceToken === "device-token"
        ? { ok: true, payload: helloOk(["operator.read"], "device-token") }
        : { ok: false, error: { code: "INVALID_REQUEST", message: "unauthorized" } };
    };
    let failing = true;
    const bots = gateway.handlers["agents.list"]!;
    gateway.handlers["agents.list"] = (params) => {
      if (failing) throw new Error("not now");
      return bots(params);
    };
    const h = harness({ gateway });
    await h.client.start();
    await h.setup.look();
    await h.setup.connect();
    await until(() => h.setup.current.failure?.kind === "bots");
    failing = false;
    await h.client.retryNow();
    await until(() => h.setup.current.phase === "done");
    h.client.stop();
  });

  it("a setup cancelled while the earlier connection is let go starts nothing more", async () => {
    const h = harness();
    await h.client.start();
    await h.setup.look();
    // An earlier connection, still trying, that takes its time to be let go.
    h.gateway.refuseConnections = true;
    await h.client.connect({ url: "ws://127.0.0.1:19990", token: null });
    const disconnect = h.client.disconnect.bind(h.client);
    const holds: Array<() => void> = [];
    h.client.disconnect = async () => {
      await new Promise<void>((resolve) => holds.push(resolve));
      return disconnect();
    };
    let asked = 0;
    const hasDeviceToken = h.client.hasDeviceToken.bind(h.client);
    h.client.hasDeviceToken = (url: string) => {
      asked += 1;
      return hasDeviceToken(url);
    };
    const connecting = h.setup.connect();
    await until(() => holds.length > 0);
    h.setup.cancel();
    for (const release of holds) release();
    await connecting;
    // Nothing more is started, not even a read of this device's tokens.
    expect(asked).toBe(0);
    expect(minted(h.requests)).toEqual([]);
    h.client.stop();
  });

  it("a setup cancelled while it checks for an earlier pairing starts nothing more", async () => {
    const h = harness();
    await h.client.start();
    await h.setup.look();
    let release: ((paired: boolean) => void) | undefined;
    h.client.hasDeviceToken = () => new Promise<boolean>((resolve) => (release = resolve));
    const connecting = h.setup.connect();
    await until(() => release !== undefined);
    h.setup.cancel();
    release!(false);
    await connecting;
    expect(minted(h.requests)).toEqual([]);
    expect(h.gateway.connects).toEqual([]);
    h.client.stop();
  });

  it("the operation's two minutes hold until the code is made, not only until the answer", async () => {
    let now = 1_000_000;
    let answered = false;
    const h = harness({
      now: () => now,
      confirm: async () => {
        answered = true;
        return true;
      },
      replies: {
        "gateway status --json": () => {
          // The recheck after the answer takes longer than what is left of the two minutes.
          if (answered) now += OPERATION_LIFETIME_MS + 1;
          return { stdout: statusJson({ port: PORT }) };
        },
      },
    });
    await h.client.start();
    await h.setup.look();
    await h.setup.connect();
    expect(h.setup.current.failure?.kind).toBe("changed");
    expect(minted(h.requests)).toEqual([]);
    h.client.stop();
  });

  it("connected, with bots that couldn't be read, says so and doesn't open the app", async () => {
    const h = harness();
    h.gateway.handlers["agents.list"] = () => {
      throw new Error("agents unavailable");
    };
    await h.client.start();
    await h.setup.look();
    await h.setup.connect();
    await until(() => h.setup.current.phase === "failed");
    expect(h.setup.current.failure?.kind).toBe("bots");
    expect(h.client.state.connection.status).toBe("connected");
    h.client.stop();
  });
});
