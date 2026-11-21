// Which `ssh` clients the transport uses, and the typed "not supported here"
// for the rest: Windows' bundled OpenSSH from the version the research ran,
// OpenSSH 8.4 or later elsewhere. The clients here are stand-ins that only
// print a version, so no real `ssh` runs.

import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseDestination } from "../../src/main/ssh/destination.ts";
import { AppKnownHosts, fingerprintOf } from "../../src/main/ssh/known-hosts.ts";
import { routeConfigText } from "../../src/main/ssh/route-config.ts";
import type { Spawn } from "../../src/main/ssh/run.ts";
import { MAX_LOOK_OUTPUT } from "../../src/main/ssh/look.ts";
import { SshTransport } from "../../src/main/ssh/transport.ts";
import { productionWorld, type SshWorld } from "../../src/main/ssh/world.ts";
import { tempDir, testEnv } from "./harness.ts";

let root: string;

beforeAll(() => {
  root = tempDir("clawtrate-ssh-client-");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function worldWith(version: string | null, platform: NodeJS.Platform, name: string): SshWorld {
  const dir = join(root, name);
  mkdirSync(join(dir, "home", ".ssh"), { recursive: true });
  const ssh = join(dir, "fake-ssh");
  if (version !== null) {
    writeFileSync(ssh, `#!/bin/sh\necho '${version}' >&2\n`);
    chmodSync(ssh, 0o755);
  }
  return {
    home: join(dir, "home"),
    personConfig: join(dir, "home", ".ssh", "config"),
    personKnownHosts: join(dir, "home", ".ssh", "known_hosts"),
    ssh,
    appDir: join(dir, "app"),
    localUser: "you",
    agent: "none",
    platform,
    env: testEnv(),
  };
}

type Held = {
  args: string[];
  answered: boolean;
  stdin: () => string;
  answer(stderr: string, stdout?: string, exit?: number): void;
};

/**
 * A spawn whose children are held: each waits, without running anything,
 * until the test answers it with error output, standard output and an exit.
 */
function heldSpawn(): {
  spawn: Spawn;
  held: Held[];
  next(): Promise<Held>;
  /** The result of `work`, answering every run it starts after those already answered with exit 255. */
  settle<T>(work: Promise<T>): Promise<T>;
} {
  const held: Held[] = [];
  let waiting: Array<() => void> = [];
  let pid = 0;
  /** How many runs `next` has handed out, in the order they started. */
  let taken = 0;
  const spawnHeld: Spawn = (_file, args) => {
    const child = new EventEmitter() as ChildProcess;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let input = "";
    stdin.on("data", (chunk: Buffer) => (input += chunk.toString("utf8")));
    let closed = false;
    const close = (code: number | null) => {
      if (closed) return;
      closed = true;
      setTimeout(() => child.emit("close", code), 10);
    };
    Object.assign(child, {
      pid: ++pid,
      stdin,
      stdout,
      stderr,
      kill: () => {
        close(null);
        return true;
      },
    });
    const run: Held = {
      args: [...args],
      answered: false,
      stdin: () => input,
      answer: (err, out = "", exit = 0) => {
        run.answered = true;
        stderr.write(err);
        stdout.write(out);
        close(exit);
      },
    };
    held.push(run);
    for (const wake of waiting) wake();
    waiting = [];
    return child;
  };
  return {
    spawn: spawnHeld,
    held,
    next: () => {
      const index = taken++;
      return new Promise((resolve) => {
        const check = () => (held.length > index ? resolve(held[index]!) : waiting.push(check));
        check();
      });
    },
    settle: async <T>(work: Promise<T>): Promise<T> => {
      for (;;) {
        const done = await Promise.race([
          work.then((value) => ({ value })),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
        ]);
        if (done) return done.value;
        for (const run of held) if (!run.answered) run.answer("", "", 255);
      }
    },
  };
}

/**
 * A spawn whose children write their error output one line per turn of the
 * event loop, then exit. A child told to stop dies at once, before its next
 * line or its own exit: as on Linux, where the reader woken by a line can run,
 * and signal ssh, before ssh writes the line after it.
 */
function lineByLineSpawn(script: (args: readonly string[]) => { lines: string[]; exit: number }): {
  spawn: Spawn;
  killed: () => number;
} {
  let pid = 0;
  let killed = 0;
  const spawnLines: Spawn = (_file, args) => {
    const child = new EventEmitter() as ChildProcess;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stdin.resume();
    let closed = false;
    const close = (code: number | null) => {
      if (closed) return;
      closed = true;
      setImmediate(() => child.emit("close", code));
    };
    Object.assign(child, {
      pid: ++pid,
      stdin,
      stdout,
      stderr,
      kill: () => {
        killed++;
        close(null);
        return true;
      },
    });
    const { lines, exit } = script(args);
    const step = (i: number) => {
      if (closed) return;
      if (i === lines.length) return close(exit);
      stderr.write(lines[i] + "\n");
      setImmediate(() => step(i + 1));
    };
    setImmediate(() => step(0));
    return child;
  };
  return { spawn: spawnLines, killed: () => killed };
}

describe.skipIf(process.platform === "win32")("the ssh client", () => {
  it.each([
    ["macOS's client", "OpenSSH_9.9p2, LibreSSL 3.3.6", "darwin", { ok: true }],
    [
      "Ubuntu's client",
      "OpenSSH_9.6p1 Ubuntu-3ubuntu13.5, OpenSSL 3.0.13 30 Jan 2024",
      "linux",
      { ok: true },
    ],
    [
      "the oldest client with known-hosts none",
      "OpenSSH_8.4p1, OpenSSL 1.1.1",
      "linux",
      { ok: true },
    ],
    // Windows has no local socket the host can prove private for the forward: no SSH route there.
    [
      "Windows' bundled 9.5",
      "OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2",
      "win32",
      { ok: false, kind: "not-supported-here", reason: "platform" },
    ],
    [
      "Windows 10's bundled 8.1",
      "OpenSSH_for_Windows_8.1p1, LibreSSL 3.0.2",
      "win32",
      { ok: false, kind: "not-supported-here", reason: "platform" },
    ],
    [
      "a client too old for known-hosts none",
      "OpenSSH_7.4p1, OpenSSL 1.0.2k-fips",
      "linux",
      { ok: false, kind: "not-supported-here", reason: "ssh-version" },
    ],
    [
      "another program on Windows",
      "OpenSSH_9.9p2, LibreSSL 3.3.6",
      "win32",
      { ok: false, kind: "not-supported-here", reason: "platform" },
    ],
    [
      "something else",
      "PuTTY Release 0.81",
      "linux",
      { ok: false, kind: "not-supported-here", reason: "ssh-version" },
    ],
    [
      "another system",
      "OpenSSH_9.9p2",
      "freebsd",
      { ok: false, kind: "not-supported-here", reason: "platform" },
    ],
  ] as const)("%s", async (_name, version, platform, expected) => {
    const transport = new SshTransport(
      worldWith(version, platform, `${platform}-${version.length}-${Math.random()}`),
    );
    expect(await transport.checkClient()).toEqual(expected);
  });

  it("needs the version command to have worked, not only printed a version", async () => {
    const world = worldWith("OpenSSH_9.9p2, LibreSSL 3.3.6", "darwin", "fails");
    writeFileSync(world.ssh, "#!/bin/sh\necho 'OpenSSH_9.9p2, LibreSSL 3.3.6' >&2\nexit 1\n", {
      mode: 0o755,
    });
    expect(await new SshTransport(world).checkClient()).toEqual({
      ok: false,
      kind: "not-supported-here",
      reason: "ssh-version",
    });
  });

  it("opens a forward only through the same gates as every other call", async () => {
    const found = {
      ok: true as const,
      holdsPort: true as const,
      service: {
        profile: "default" as const,
        serviceLabel: "LaunchAgent" as const,
        configPath: "/srv/you/.openclaw/openclaw.json",
        port: 18789,
      },
    };
    // An unsupported client: nothing but the version command runs.
    const started: string[][] = [];
    const old = worldWith("OpenSSH_7.4p1, OpenSSL 1.0.2k-fips", "linux", "gate-old");
    const oldTransport = new SshTransport(old, {
      spawn: (file, args, env) => {
        started.push([...args]);
        return spawn(file, args, { env, stdio: ["pipe", "pipe", "pipe"] });
      },
    });
    writeFileSync(old.personConfig, "Host devbox\n  HostName devbox.example\n");
    const oldRoute = oldTransport.prepareRoute("1", "devbox");
    if (!oldRoute.ok) throw new Error();
    expect(await oldTransport.openForward(oldRoute, found)).toEqual({
      ok: false,
      kind: "not-supported-here",
      reason: "ssh-version",
    });
    expect(started).toEqual([["-V"]]);
    // A supported client: no pin, no forward; a stale route or a service not found, no forward.
    const world = worldWith("OpenSSH_9.9p2, LibreSSL 3.3.6", "darwin", "gate-new");
    const transport = new SshTransport(world);
    writeFileSync(world.personConfig, "Host devbox\n  HostName devbox.example\n");
    const route = transport.prepareRoute("1", "devbox");
    if (!route.ok) throw new Error();
    expect(await transport.openForward(route, found)).toEqual({ ok: false, kind: "not-pinned" });
    expect(
      await transport.openForward(route, { ...found, holdsPort: false } as unknown as typeof found),
    ).toEqual({ ok: false, kind: "not-a-found-service" });
    transport.prepareRoute("1", "devbox");
    expect(await transport.openForward(route, found)).toEqual({ ok: false, kind: "stale-route" });
  });

  it("work begun on a route prepared again before it finishes is stale, and pins nothing", async () => {
    const version = "OpenSSH_9.9p2, LibreSSL 3.3.6\n";
    const key = Buffer.concat([
      Buffer.from([0, 0, 0, 11]),
      Buffer.from("ssh-ed25519"),
      Buffer.from([0, 0, 0, 32]),
      Buffer.alloc(32, 3),
    ]).toString("base64");
    const fingerprint = fingerprintOf(key);
    const make = (name: string) => {
      const world = worldWith(version.trim(), "darwin", name);
      const fake = heldSpawn();
      const transport = new SshTransport(world, { spawn: fake.spawn });
      const block = (host: string) => `Host devbox\n  HostName ${host}\n`;
      writeFileSync(world.personConfig, block("devbox.example"));
      const route = transport.prepareRoute("1", "devbox");
      if (!route.ok) throw new Error(JSON.stringify(route));
      const moveAway = () => {
        writeFileSync(world.personConfig, block("other.example"));
        const moved = transport.prepareRoute("1", "devbox");
        if (!moved.ok) throw new Error(JSON.stringify(moved));
      };
      const pinnedLines = () => {
        const file = join(world.appDir, "known_hosts");
        return existsSync(file) ? readFileSync(file, "utf8") : "";
      };
      return { world, fake, transport, route, moveAway, pinnedLines };
    };

    // The version check is still running when the route moves: nothing more starts.
    const a = make("stale-version");
    const checking = a.transport.checkHostKey(a.route);
    const versionRun = await a.fake.next();
    expect(versionRun.args).toEqual(["-V"]);
    a.moveAway();
    versionRun.answer(version);
    expect(await a.fake.settle(checking)).toEqual({ ok: false, kind: "stale-route" });
    expect(a.fake.held.map((run) => run.args[0])).toEqual(["-V"]);

    // The prior-trust lookup answers after the route moved: its key is not pinned for the old route.
    const b = make("stale-prior");
    writeFileSync(b.world.personKnownHosts, `devbox.example ssh-ed25519 ${key}\n`);
    const looking = b.transport.checkHostKey(b.route);
    (await b.fake.next()).answer(version);
    const lookup = await b.fake.next();
    expect(lookup.args[1]).toBe(b.transport.configPath(b.route, "lookup"));
    b.moveAway();
    lookup.answer(
      [
        `debug1: Server host key: ssh-ed25519 ${fingerprint}`,
        `debug1: Host 'devbox.example' is known and matches the ED25519 host key.`,
        `debug1: Found key in ${b.world.personKnownHosts}:1`,
        "",
      ].join("\n"),
      "",
      255,
    );
    expect(await b.fake.settle(looking)).toEqual({ ok: false, kind: "stale-route" });
    expect(b.pinnedLines()).not.toContain(b.route.alias);
    expect(b.fake.held).toHaveLength(2);

    // A LOOK that answers whole after the route moved is not that route's answer.
    const c = make("stale-look");
    new AppKnownHosts(join(c.world.appDir, "known_hosts")).pin(
      c.route.alias,
      { type: "ssh-ed25519", key, fingerprint },
      c.route.endpoint,
      new Date(0),
      false,
    );
    const look = c.transport.look(c.route);
    (await c.fake.next()).answer(version);
    const lookRun = await c.fake.next();
    c.moveAway();
    const id = /^request_id='([0-9a-f-]+)'$/m.exec(lookRun.stdin())![1]!;
    const b64 = (text: string) => Buffer.from(text).toString("base64");
    lookRun.answer(
      "",
      [
        `{"k":"begin","id":"${id}"}`,
        `{"k":"uname","s":"${b64("Linux")}","m":"${b64("x86_64")}","n":"${b64("devbox")}"}`,
        `{"k":"signs","state":0,"launchd":0,"systemd":0,"cstate":0,"claunchd":0,"csystemd":0}`,
        `{"k":"end","id":"${id}"}`,
        "",
      ].join("\n"),
      0,
    );
    expect(await c.fake.settle(look)).toEqual({ ok: false, kind: "stale-route" });
  });

  it("two checks of one route that both find an earlier key: one pins it, the other is pinned, nothing throws", async () => {
    const version = "OpenSSH_9.9p2, LibreSSL 3.3.6\n";
    const keyOf = (fill: number) =>
      Buffer.concat([
        Buffer.from([0, 0, 0, 11]),
        Buffer.from("ssh-ed25519"),
        Buffer.from([0, 0, 0, 32]),
        Buffer.alloc(32, fill),
      ]).toString("base64");
    const lookupAnswer = (world: SshWorld, key: string) =>
      [
        `debug1: Server host key: ssh-ed25519 ${fingerprintOf(key)}`,
        `debug1: Host 'devbox.example' is known and matches the ED25519 host key.`,
        `debug1: Found key in ${world.personKnownHosts}:1`,
        "",
      ].join("\n");
    for (const later of ["same", "another"] as const) {
      const world = worldWith(version.trim(), "darwin", `prior-twice-${later}`);
      const fake = heldSpawn();
      const transport = new SshTransport(world, { spawn: fake.spawn });
      writeFileSync(world.personConfig, "Host devbox\n  HostName devbox.example\n");
      const route = transport.prepareRoute("1", "devbox");
      if (!route.ok) throw new Error(JSON.stringify(route));
      const first = keyOf(4);
      writeFileSync(world.personKnownHosts, `devbox.example ssh-ed25519 ${first}\n`);
      const one = transport.checkHostKey(route);
      const two = transport.checkHostKey(route);
      (await fake.next()).answer(version);
      const lookupOne = await fake.next();
      const lookupTwo = await fake.next();
      lookupOne.answer(lookupAnswer(world, first), "", 255);
      expect(await one).toMatchObject({ ok: true, state: "pinned-from-known-hosts" });
      // The second lookup answers after the pin was written: with the same key, or with another.
      const second = later === "same" ? first : keyOf(5);
      writeFileSync(world.personKnownHosts, `devbox.example ssh-ed25519 ${second}\n`);
      lookupTwo.answer(lookupAnswer(world, second), "", 255);
      if (later === "another") {
        // Checked against the pin there now, which the server presents.
        const pinned = await fake.next();
        expect(pinned.args[1]).toBe(transport.configPath(route));
        pinned.answer(
          `debug1: Host 'clawtrate' is known and matches the ED25519 host key.\n`,
          "",
          255,
        );
      }
      expect(await fake.settle(two), later).toEqual({
        ok: true,
        state: "pinned",
        label: "ED25519",
        fingerprint: fingerprintOf(first),
      });
      const pins = readFileSync(join(world.appDir, "known_hosts"), "utf8");
      expect(pins, later).toContain(first);
      expect(pins, later).not.toContain(keyOf(5));
    }
  });

  it("reads a host-key probe's answer whole, where a stopped ssh can die before its next line or its exit (as on Linux)", async () => {
    const version = "OpenSSH_9.9p2, LibreSSL 3.3.6";
    const keyOf = (fill: number) =>
      Buffer.concat([
        Buffer.from([0, 0, 0, 11]),
        Buffer.from("ssh-ed25519"),
        Buffer.from([0, 0, 0, 32]),
        Buffer.alloc(32, fill),
      ]).toString("base64");
    const trusted = keyOf(6);
    const presented = keyOf(7);
    /** The capture's file, from the capture configuration it was started with. */
    const captureFile = (args: readonly string[]) =>
      /\/capture-[^/]+\.conf$/.test(args[1] ?? "")
        ? (/UserKnownHostsFile "([^"]+)"/.exec(readFileSync(args[1]!, "utf8"))?.[1] ?? null)
        : null;
    const make = (
      name: string,
      answer: (args: readonly string[]) => { lines: string[]; exit: number },
    ) => {
      const world = worldWith(version, "darwin", name);
      const fake = lineByLineSpawn((args) =>
        args[0] === "-V" ? { lines: [version], exit: 0 } : answer(args),
      );
      const transport = new SshTransport(world, { spawn: fake.spawn });
      writeFileSync(world.personConfig, "Host devbox\n  HostName devbox.example\n");
      const route = transport.prepareRoute("1", "devbox");
      if (!route.ok) throw new Error(JSON.stringify(route));
      return { world, transport, route, fake };
    };

    // A key the person trusts: the match, then on the next turn the file and line it was found at.
    const prior = make("linux-prior", (args) => {
      const file = captureFile(args);
      if (file) return { lines: [], exit: 255 };
      return {
        lines: [
          `debug1: Server host key: ssh-ed25519 ${fingerprintOf(trusted)}`,
          "debug1: Host 'devbox.example' is known and matches the ED25519 host key.",
          `debug1: Found key in ${prior.world.personKnownHosts}:1`,
          "debug1: Authentications that can continue: publickey",
        ],
        exit: 255,
      };
    });
    writeFileSync(prior.world.personKnownHosts, `devbox.example ssh-ed25519 ${trusted}\n`);
    expect(await prior.transport.checkHostKey(prior.route)).toMatchObject({
      ok: true,
      state: "pinned-from-known-hosts",
      fingerprint: fingerprintOf(trusted),
    });

    // A changed key: the refusal, then on the next turn ssh's own exit 255.
    const changed = make("linux-changed", (args) => {
      const file = captureFile(args);
      if (file) {
        // The capture writes the presented key, then says so.
        writeFileSync(file, `${changed.route.alias} ssh-ed25519 ${presented}\n`);
        return {
          lines: [
            `Warning: Permanently added '${changed.route.alias}' (ED25519) to the list of known hosts.`,
          ],
          exit: 255,
        };
      }
      return {
        lines: [
          "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
          "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @",
          "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
          "Host key verification failed.",
        ],
        exit: 255,
      };
    });
    new AppKnownHosts(join(changed.world.appDir, "known_hosts")).pin(
      changed.route.alias,
      { type: "ssh-ed25519", key: trusted, fingerprint: fingerprintOf(trusted) },
      changed.route.endpoint,
      new Date(0),
      false,
    );
    expect(await changed.transport.checkHostKey(changed.route)).toMatchObject({
      ok: true,
      state: "changed",
      trusted: { fingerprint: fingerprintOf(trusted) },
      presented: { fingerprint: fingerprintOf(presented) },
    });
  });

  it("reports the pin a match was made against, when a replacement lands while the probe runs", async () => {
    const version = "OpenSSH_9.9p2, LibreSSL 3.3.6\n";
    const keyOf = (fill: number) =>
      Buffer.concat([
        Buffer.from([0, 0, 0, 11]),
        Buffer.from("ssh-ed25519"),
        Buffer.from([0, 0, 0, 32]),
        Buffer.alloc(32, fill),
      ]).toString("base64");
    const world = worldWith(version.trim(), "darwin", "pin-replaced-during-probe");
    const fake = heldSpawn();
    const transport = new SshTransport(world, { spawn: fake.spawn });
    writeFileSync(world.personConfig, "Host devbox\n  HostName devbox.example\n");
    const route = transport.prepareRoute("1", "devbox");
    if (!route.ok) throw new Error(JSON.stringify(route));
    const pins = new AppKnownHosts(join(world.appDir, "known_hosts"));
    const a = keyOf(8);
    const b = keyOf(9);
    pins.pin(
      route.alias,
      { type: "ssh-ed25519", key: a, fingerprint: fingerprintOf(a) },
      route.endpoint,
      new Date(0),
      false,
    );
    const matched = (key: string) =>
      [
        `debug1: Server host key: ssh-ed25519 ${fingerprintOf(key)}`,
        `debug1: Host '${route.alias}' is known and matches the ED25519 host key.`,
        `debug1: Found key in ${join(world.appDir, "known_hosts")}:1`,
        "",
      ].join("\n");
    const checking = transport.checkHostKey(route);
    (await fake.next()).answer(version);
    const probe = await fake.next();
    // An approved replacement installs B before ssh reads the file; ssh then matches B.
    pins.pin(
      route.alias,
      { type: "ssh-ed25519", key: b, fingerprint: fingerprintOf(b) },
      route.endpoint,
      new Date(1),
      true,
    );
    // Checked again against the pin there now: that check, when it comes, matches B too.
    void fake.next().then((recheck) => recheck.answer(matched(b), "", 255));
    probe.answer(matched(b), "", 255);
    expect(await checking).toEqual({
      ok: true,
      state: "pinned",
      label: "ED25519",
      fingerprint: fingerprintOf(b),
    });
  });

  it("turns a spawn that fails into a typed result, never an exception", async () => {
    const world = worldWith("OpenSSH_9.9p2, LibreSSL 3.3.6", "darwin", "spawn");
    const transport = new SshTransport(world, {
      spawn: (file, args, env) => {
        if (args[0] === "-V") return spawn(file, args, { env, stdio: ["pipe", "pipe", "pipe"] });
        throw new Error("spawn EAGAIN");
      },
    });
    writeFileSync(world.personConfig, "Host devbox\n  HostName devbox.example\n");
    const route = transport.prepareRoute("1", "devbox");
    if (!route.ok) throw new Error();
    expect(await transport.checkHostKey(route)).toMatchObject({
      ok: false,
      kind: "failed",
      failure: { kind: "spawn-failed" },
      note: { title: "ssh couldn't start" },
    });
    // A program that isn't there, started after the version was read.
    const gone = worldWith("OpenSSH_9.9p2, LibreSSL 3.3.6", "darwin", "gone");
    const goneTransport = new SshTransport(gone);
    expect(await goneTransport.checkClient()).toEqual({ ok: true });
    rmSync(gone.ssh);
    writeFileSync(gone.personConfig, "Host devbox\n  HostName devbox.example\n");
    const goneRoute = goneTransport.prepareRoute("1", "devbox");
    if (!goneRoute.ok) throw new Error();
    expect(await goneTransport.checkHostKey(goneRoute)).toMatchObject({
      ok: false,
      failure: { kind: "spawn-failed" },
    });
  });

  it("is not supported here when the program is missing, and nothing else runs", async () => {
    const started: string[][] = [];
    const transport = new SshTransport(worldWith(null, "darwin", "missing"), {
      spawn: (_file, args) => {
        started.push([...args]);
        throw new Error("nothing may start");
      },
    });
    writeFileSync(transport.world.personConfig, "Host devbox\n  HostName devbox.example\n");
    const route = transport.prepareRoute("1", "devbox");
    if (!route.ok) throw new Error();
    expect(await transport.checkHostKey(route)).toEqual({
      ok: false,
      kind: "not-supported-here",
      reason: "ssh-missing",
    });
    expect(await transport.look(route)).toEqual({
      ok: false,
      kind: "not-supported-here",
      reason: "ssh-missing",
    });
    expect(started).toEqual([]);
  });

  it("reads the script's own exit status: a whole answer from a script that failed is not a LOOK", async () => {
    // A stand-in ssh: answers -V, and otherwise prints a whole, well-formed LOOK for the id it is sent.
    const make = (exit: number) => {
      const world = worldWith("OpenSSH_9.9p2, LibreSSL 3.3.6", "darwin", `exit-${exit}`);
      const b64 = (text: string) => Buffer.from(text).toString("base64");
      writeFileSync(
        world.ssh,
        [
          "#!/bin/sh",
          'if [ "$1" = "-V" ]; then echo "OpenSSH_9.9p2, LibreSSL 3.3.6" >&2; exit 0; fi',
          "id=$(head -n 1 | sed \"s/^request_id='\\(.*\\)'$/\\1/\")",
          "cat >/dev/null",
          `printf '{"k":"begin","id":"%s"}\\n' "$id"`,
          `printf '{"k":"uname","s":"${b64("Linux")}","m":"${b64("x86_64")}","n":"${b64("devbox")}"}\\n'`,
          `printf '{"k":"signs","state":0,"launchd":0,"systemd":0,"cstate":0,"claunchd":0,"csystemd":0}\\n'`,
          `printf '{"k":"end","id":"%s"}\\n' "$id"`,
          `exit ${exit}`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const transport = new SshTransport(world);
      writeFileSync(world.personConfig, "Host devbox\n  HostName devbox.example\n");
      const route = transport.prepareRoute("1", "devbox");
      if (!route.ok) throw new Error(JSON.stringify(route));
      const key = Buffer.concat([
        Buffer.from([0, 0, 0, 11]),
        Buffer.from("ssh-ed25519"),
        Buffer.from([0, 0, 0, 32]),
        Buffer.alloc(32, 1),
      ]).toString("base64");
      new AppKnownHosts(join(world.appDir, "known_hosts")).pin(
        route.alias,
        { type: "ssh-ed25519", key, fingerprint: fingerprintOf(key) },
        route.endpoint,
        new Date(0),
        false,
      );
      return { transport, route };
    };
    const good = make(0);
    expect(await good.transport.look(good.route)).toMatchObject({
      ok: true,
      facts: { program: null },
    });
    const failed = make(3);
    expect(await failed.transport.look(failed.route)).toEqual({
      ok: false,
      kind: "cant-tell",
      reason: "script-failed",
    });
  });

  it("counts the LOOK's output in bytes: multibyte noise past the limit is too much", async () => {
    const world = worldWith("OpenSSH_9.9p2, LibreSSL 3.3.6", "darwin", "bytes");
    // Two-byte characters: more bytes than the limit, though fewer characters.
    const count = Math.ceil(MAX_LOOK_OUTPUT * 0.6);
    writeFileSync(
      world.ssh,
      [
        "#!/bin/sh",
        'if [ "$1" = "-V" ]; then echo "OpenSSH_9.9p2, LibreSSL 3.3.6" >&2; exit 0; fi',
        "cat >/dev/null",
        `printf '${"é".repeat(count)}\\n'`,
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const transport = new SshTransport(world);
    writeFileSync(world.personConfig, "Host devbox\n  HostName devbox.example\n");
    const route = transport.prepareRoute("1", "devbox");
    if (!route.ok) throw new Error();
    const key = Buffer.concat([
      Buffer.from([0, 0, 0, 11]),
      Buffer.from("ssh-ed25519"),
      Buffer.from([0, 0, 0, 32]),
      Buffer.alloc(32, 2),
    ]).toString("base64");
    new AppKnownHosts(join(world.appDir, "known_hosts")).pin(
      route.alias,
      { type: "ssh-ed25519", key, fingerprint: fingerprintOf(key) },
      route.endpoint,
      new Date(0),
      false,
    );
    expect(await transport.look(route)).toEqual({
      ok: false,
      kind: "cant-tell",
      reason: "too-large",
    });
  });

  it("writes Windows paths with forward slashes, and uses Windows' bundled ssh in production", () => {
    const world = { ...worldWith("x", "win32", "paths"), platform: "win32" as const };
    const text = routeConfigText(
      "1",
      {
        ok: true,
        destination: parseDestination("devbox")!,
        name: "devbox",
        hostName: "devbox.example",
        user: "you",
        port: 22,
        identityFiles: ["C:\\ProgramData\\you\\.ssh\\id_ed25519"],
        identitiesOnly: true,
        certificateFiles: [],
        identityAgent: "world",
        pubkeyAuthentication: null,
      },
      world,
      "C:\\ProgramData\\Clawtrate\\ssh\\known_hosts",
    );
    expect(text).toContain('  IdentityFile "C:/ProgramData/you/.ssh/id_ed25519"\n');
    expect(text).toContain('  UserKnownHostsFile "C:/ProgramData/Clawtrate/ssh/known_hosts"\n');
    const production = productionWorld(join(root, "prod"), { SSH_AUTH_SOCK: "/srv/agent.sock" });
    expect(production.agent).toEqual(
      process.platform === "win32" ? "windows-pipe" : { socket: "/srv/agent.sock" },
    );
    expect(productionWorld(join(root, "prod"), {}).agent).toEqual(
      process.platform === "win32" ? "windows-pipe" : "none",
    );
    expect(production.ssh).toBe(process.platform === "win32" ? production.ssh : "/usr/bin/ssh");
  });
});
