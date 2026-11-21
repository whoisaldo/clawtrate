// A world and an `sshd` of the test's own: a temporary home with its own SSH
// configuration, known-hosts file and key, and an `sshd` started as the current
// user on a loopback port, with its own host key, authorized keys and
// configuration, stopped by its PID. Nothing of this machine's own SSH setup is
// read or used: every `ssh` here runs with `-F` on a generated file, the test's
// key, `IdentitiesOnly`, no agent and `SSH_AUTH_SOCK` removed.

import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer, type Socket } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import { PROGRAM_PLACES } from "../../src/main/ssh/look.ts";
import type { SshWorld } from "../../src/main/ssh/world.ts";

export const SSHD = "/usr/sbin/sshd";
export const SSH = process.platform === "win32" ? "" : "/usr/bin/ssh";
export const KEYGEN = "/usr/bin/ssh-keygen";

/** The environment every program of these tests runs with: no agent. */
export function testEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.SSH_AUTH_SOCK;
  delete env.SSH_AGENT_PID;
  return env;
}

/**
 * A fresh folder of the test's own. On macOS it is made in /tmp, not the
 * per-user temporary folder, whose long path leaves no room for a forward's
 * local socket (104 bytes) in the folders below it.
 */
export function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), prefix)));
}

export function keygen(path: string, type: "ed25519" | "ecdsa" = "ed25519"): void {
  execFileSync(KEYGEN, ["-q", "-t", type, "-N", "", "-C", "clawtrate-test", "-f", path], {
    env: testEnv(),
    stdio: "ignore",
  });
}

/** Whether this account can make symbolic links, to a folder and to a file, and why not. */
export function symlinkSupport(
  make: typeof symlinkSync = symlinkSync,
): { ok: true } | { ok: false; reason: string } {
  const dir = tempDir("clawtrate-links-check-");
  try {
    mkdirSync(join(dir, "folder"));
    writeFileSync(join(dir, "file"), "");
    make(join(dir, "folder"), join(dir, "to-folder"), "dir");
    make(join(dir, "file"), join(dir, "to-file"), "file");
    return { ok: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code ?? "an error";
    return { ok: false, reason: `this account can't make symbolic links (${code})` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Whether these tests can start an `sshd` of their own here, and why not. */
export function sshdAvailability(): { ok: true } | { ok: false; reason: string } {
  if (process.platform === "win32")
    return { ok: false, reason: "no sshd for the current user on Windows" };
  for (const program of [SSHD, SSH, KEYGEN]) {
    if (!existsSync(program)) return { ok: false, reason: `${program} is not installed` };
  }
  const dir = tempDir("clawtrate-sshd-check-");
  try {
    keygen(join(dir, "host"));
    writeFileSync(
      join(dir, "config"),
      `Port 22\nListenAddress 127.0.0.1\nHostKey ${join(dir, "host")}\nPidFile none\nUsePAM no\nSetEnv HOME=${dir}\n`,
    );
    const check = spawnSync(SSHD, ["-t", "-f", join(dir, "config")], {
      env: testEnv(),
      encoding: "utf8",
    });
    if (check.status !== 0)
      return { ok: false, reason: `sshd -t refused a test configuration (exit ${check.status})` };
    return { ok: true };
  } catch {
    return { ok: false, reason: "ssh-keygen failed" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The fixed places of the LOOK script that exist on this machine outside any home. */
export function absolutePlacesHere(): string[] {
  return PROGRAM_PLACES.filter((place) => place.startsWith("/") && existsSync(place));
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export type TestWorld = {
  root: string;
  home: string;
  world: SshWorld;
  userKey: string;
  /** Writes the person's SSH configuration in the test home. */
  writeConfig(text: string): void;
};

export function makeWorld(root: string): TestWorld {
  const home = join(root, "home");
  const dotSsh = join(home, ".ssh");
  mkdirSync(dotSsh, { recursive: true, mode: 0o700 });
  const userKey = join(dotSsh, "id_ed25519");
  keygen(userKey);
  const world: SshWorld = {
    home,
    personConfig: join(dotSsh, "config"),
    personKnownHosts: join(dotSsh, "known_hosts"),
    ssh: SSH,
    appDir: join(root, "app"),
    localUser: userInfo().username,
    agent: "none",
    platform: process.platform,
    env: testEnv(),
  };
  return {
    root,
    home,
    world,
    userKey,
    writeConfig: (text) => writeFileSync(world.personConfig, text, { mode: 0o600 }),
  };
}

/**
 * A stand-in `openclaw` in the test home's first fixed place, answering from
 * files the test writes. Beside the LOOK's commands it answers `qr --json
 * --voice-node --url <url>` (from `qr-<profile>.json`, or by running
 * `qr-<profile>.sh` when the test wrote one), `gateway start` and `gateway
 * stop`, and appends every command's arguments, which carry no code, to
 * `calls`.
 */
export function installStubOpenclaw(home: string): {
  setVersion(text: string): void;
  setStatus(profile: "default" | "clawtrate", json: unknown, exit?: number): void;
  setCode(profile: "default" | "clawtrate", json: unknown, exit?: number): void;
  setCodeScript(profile: "default" | "clawtrate", script: string): void;
  setStart(profile: "default" | "clawtrate", exit: number): void;
  /** What `gateway call …` runs, as a script given the command's arguments. */
  setCallScript(profile: "default" | "clawtrate", script: string): void;
  calls(): string[];
} {
  const bin = join(home, ".openclaw", "bin");
  const stub = join(home, ".openclaw", "stub");
  mkdirSync(bin, { recursive: true });
  mkdirSync(stub, { recursive: true });
  writeFileSync(
    join(bin, "openclaw"),
    [
      "#!/bin/sh",
      'd="$HOME/.openclaw/stub"',
      'printf \'%s\\n\' "$*" >> "$d/calls"',
      "p=default",
      'if [ "${1:-}" = --profile ] && [ "${2:-}" = clawtrate ]; then p=clawtrate; shift 2; fi',
      'case "$p $*" in',
      '  "default --version") cat "$d/version" ;;',
      '  "default gateway status --json") cat "$d/status-default.json"; exit "$(cat "$d/exit-default")" ;;',
      '  "clawtrate gateway status --json") cat "$d/status-clawtrate.json"; exit "$(cat "$d/exit-clawtrate")" ;;',
      '  "$p qr --json --voice-node --url ws://127.0.0.1:"*)',
      '    if [ -f "$d/qr-$p.sh" ]; then exec /bin/sh "$d/qr-$p.sh" "$@"; fi',
      '    cat "$d/qr-$p.json"; exit "$(cat "$d/qr-exit-$p")" ;;',
      '  "$p gateway start") : > "$d/started-$p"; exit "$(cat "$d/start-exit-$p" 2>/dev/null || echo 0)" ;;',
      '  "$p gateway stop") : > "$d/stopped-$p"; exit 0 ;;',
      '  "$p gateway call "*) if [ -f "$d/call-$p.sh" ]; then exec /bin/sh "$d/call-$p.sh" "$@"; fi; exit 2 ;;',
      "  *) exit 2 ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return {
    setVersion: (text) => writeFileSync(join(stub, "version"), text),
    setStatus: (profile, json, exit = 0) => {
      writeFileSync(join(stub, `status-${profile}.json`), JSON.stringify(json, null, 2));
      writeFileSync(join(stub, `exit-${profile}`), String(exit));
    },
    setCode: (profile, json, exit = 0) => {
      writeFileSync(join(stub, `qr-${profile}.json`), JSON.stringify(json));
      writeFileSync(join(stub, `qr-exit-${profile}`), String(exit));
    },
    setCodeScript: (profile, script) =>
      writeFileSync(join(stub, `qr-${profile}.sh`), script, { mode: 0o700 }),
    setStart: (profile, exit) => writeFileSync(join(stub, `start-exit-${profile}`), String(exit)),
    setCallScript: (profile, script) =>
      writeFileSync(join(stub, `call-${profile}.sh`), script, { mode: 0o700 }),
    calls: () => {
      const path = join(stub, "calls");
      return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
    },
  };
}

/** A `gateway status --json` shaped as OpenClaw 2026.10.6 prints it, reduced to what the parser reads. */
export function statusJson(options: {
  port: number;
  home: string;
  running?: boolean;
  rpcOk?: boolean;
  pid?: number;
  configPath?: string;
  /** The running gateway's version: 2026.10.6 as recorded. */
  version?: string;
}): unknown {
  const pid = options.pid ?? 4242;
  return {
    cli: { version: "2026.10.6" },
    service: {
      label: "LaunchAgent",
      loaded: true,
      runtime: { status: options.running === false ? "stopped" : "running", pid },
    },
    config: {
      daemon: {
        path: options.configPath ?? `${options.home}/.openclaw/openclaw.json`,
        exists: true,
      },
    },
    gateway: {
      bindMode: "loopback",
      bindHost: "127.0.0.1",
      port: options.port,
      version: options.version ?? "2026.10.6",
    },
    // A stopped service frees its port: nothing listens there, and the RPC fails.
    port:
      options.running === false
        ? { port: options.port, status: "free", listeners: [] }
        : { port: options.port, status: "busy", listeners: [{ pid }] },
    rpc: {
      ok: options.rpcOk ?? options.running !== false,
      url: `ws://127.0.0.1:${options.port}`,
    },
    extraServices: [],
  };
}

/** The PIDs of every descendant of `pid`, read from the process table. */
export function descendants(pid: number): number[] {
  const out = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  const children = new Map<number, number[]>();
  for (const line of out.split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (!child || !parent) continue;
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const found: number[] = [];
  const walk = (p: number) => {
    for (const c of children.get(p) ?? []) {
      found.push(c);
      walk(c);
    }
  };
  walk(pid);
  return found;
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitFor(check: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Whether this sshd has `PerSourcePenalties` (OpenSSH 9.8 and later). */
function penalties(): boolean {
  const out = spawnSync(SSHD, ["-V"], { encoding: "utf8" });
  const match = /OpenSSH_(\d+)\.(\d+)/.exec(`${out.stderr}${out.stdout}`);
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > 9 || (major === 9 && minor >= 8);
}

export type TestSshd = {
  port: number;
  pid: number;
  hostKey: string;
  /** Ends every connection's session processes, leaving the listener. */
  dropSessions(): Promise<void>;
  stop(): Promise<void>;
  /** Host keys beside `hostKey`, offered too. */
  extraHostKeys: string[];
  /** Starts again on the same port, with `hostKey` or a new one, and the extra keys given. */
  start(hostKey?: string, extraHostKeys?: string[]): Promise<void>;
};

/** An `sshd` of the test's own, as the current user, on a loopback port, with `home` as its sessions' HOME. */
export async function startSshd(
  root: string,
  home: string,
  authorizedKey: string,
  options: { forwarding?: "local" | "no" } = {},
): Promise<TestSshd> {
  const dir = join(root, "sshd");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const port = await freePort();
  let hostKey = join(dir, "host_ed25519");
  keygen(hostKey);
  let extra: string[] = [];
  writeFileSync(join(dir, "authorized_keys"), readFileSync(`${authorizedKey}.pub`), {
    mode: 0o600,
  });
  let child: ChildProcess | null = null;
  let log = "";
  const config = () =>
    [
      `Port ${port}`,
      "ListenAddress 127.0.0.1",
      `HostKey ${hostKey}`,
      ...extra.map((key) => `HostKey ${key}`),
      "PidFile none",
      `AuthorizedKeysFile ${join(dir, "authorized_keys")}`,
      "StrictModes no",
      "UsePAM no",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "PubkeyAuthentication yes",
      "PermitUserRC no",
      "PermitUserEnvironment no",
      "AllowAgentForwarding no",
      `AllowTcpForwarding ${options.forwarding ?? "local"}`,
      "X11Forwarding no",
      // Sessions see the test's home, not the account's: their start-up files and the LOOK's places.
      `SetEnv HOME=${home} ZDOTDIR=${home}`,
      // OpenSSH 9.8 and later refuse a source address for a while after refused sign-ins and the
      // credential-free key probes these tests make by the dozen; this sshd is the test's own.
      ...(penalties() ? ["PerSourcePenalties no"] : []),
      "LogLevel VERBOSE",
      "",
    ].join("\n");
  const sshd: TestSshd = {
    port,
    pid: 0,
    get hostKey() {
      return hostKey;
    },
    get extraHostKeys() {
      return extra;
    },
    async start(key, extraHostKeys) {
      if (key) hostKey = key;
      if (extraHostKeys) extra = extraHostKeys;
      writeFileSync(join(dir, "sshd_config"), config());
      log = "";
      const started = spawn(SSHD, ["-D", "-e", "-f", join(dir, "sshd_config")], {
        env: testEnv(),
        stdio: ["ignore", "ignore", "pipe"],
      });
      child = started;
      started.stderr?.setEncoding("utf8");
      started.stderr?.on("data", (chunk: string) => {
        log = (log + chunk).slice(-65536);
      });
      sshd.pid = started.pid ?? 0;
      try {
        await waitFor(
          () =>
            log.includes(`Server listening on 127.0.0.1 port ${port}`) || started.exitCode !== null,
          10000,
          "sshd to listen",
        );
        if (started.exitCode !== null) throw new Error(`sshd exited (${started.exitCode})`);
      } catch (error) {
        // A listener that didn't start in time is stopped here, by its PID, before the error goes on.
        await sshd.stop();
        throw error;
      }
    },
    async dropSessions() {
      if (!sshd.pid) return;
      for (const pid of descendants(sshd.pid).reverse()) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // already gone
        }
      }
      await waitFor(() => descendants(sshd.pid).length === 0, 5000, "sshd sessions to end");
    },
    async stop() {
      const running = child;
      if (!running || !sshd.pid) return;
      await sshd.dropSessions().catch(() => {});
      const done = new Promise<void>((resolve) => {
        if (running.exitCode !== null || running.signalCode !== null) resolve();
        else running.once("close", () => resolve());
      });
      running.kill("SIGTERM");
      await done;
      child = null;
    },
  };
  await sshd.start();
  return sshd;
}

/**
 * Proves, with a plain `ssh` of the test's own, that a session of this `sshd`
 * sees the test's home as HOME. Every LOOK depends on it: the script's first
 * fixed place is then the test's stand-in, and `~/.openclaw` is the test's.
 */
export function assertSessionHome(
  root: string,
  sshd: TestSshd,
  world: SshWorld,
  userKey: string,
): void {
  const config = join(root, "home-check.conf");
  const knownHosts = join(root, "home-check.known_hosts");
  writeFileSync(knownHosts, "");
  writeFileSync(
    config,
    [
      "Host home-check",
      "  HostName 127.0.0.1",
      `  Port ${sshd.port}`,
      `  User ${world.localUser}`,
      `  IdentityFile ${userKey}`,
      "  IdentitiesOnly yes",
      "  IdentityAgent none",
      `  UserKnownHostsFile ${knownHosts}`,
      "  GlobalKnownHostsFile none",
      "  StrictHostKeyChecking accept-new",
      "  BatchMode yes",
      "",
    ].join("\n"),
  );
  const run = spawnSync(SSH, ["-F", config, "--", "home-check", "/bin/sh", "-s"], {
    input: 'printf "%s" "$HOME"\n',
    env: testEnv(),
    encoding: "utf8",
    timeout: 15000,
  });
  const lines = run.stdout.split("\n");
  if (run.status !== 0 || lines[lines.length - 1] !== world.home) {
    throw new Error(
      "The test sshd's sessions do not see the test home as HOME; refusing to run the LOOK.",
    );
  }
}

/** A loopback HTTP server standing in for the gateway's port: every request gets 200. */
export function httpGateway(): Promise<{
  port: number;
  requests: string[];
  close(): Promise<void>;
}> {
  return new Promise((resolve) => {
    const sockets = new Set<Socket>();
    const requests: string[] = [];
    const server = createHttpServer((request, response) => {
      requests.push(`${request.method} ${request.url} ${JSON.stringify(request.headers)}`);
      response.end("ok");
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        port,
        requests,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            for (const socket of sockets) socket.destroy();
          }),
      });
    });
  });
}

/** A GET through a local port or socket: the status code, or null when nothing answered as HTTP. */
export function httpGet(local: number | string): Promise<number | null> {
  return new Promise((resolve) => {
    const request = httpRequest(
      typeof local === "number"
        ? { host: "127.0.0.1", port: local, path: "/", timeout: 3000 }
        : { socketPath: local, path: "/", timeout: 3000 },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? null);
      },
    );
    request.on("error", () => resolve(null));
    request.on("timeout", () => {
      request.destroy();
      resolve(null);
    });
    request.end();
  });
}

/**
 * A token seal for tests, standing in for Electron's `safeStorage`: what it
 * seals is the reversed bytes in base64 behind a marker, so a plain token
 * never appears in what is written.
 */
export const testSeal = {
  available: () => true,
  seal: (plain: string) => `sealed:${Buffer.from(plain, "utf8").reverse().toString("base64")}`,
  open: (sealed: string) =>
    sealed.startsWith("sealed:")
      ? Buffer.from(sealed.slice("sealed:".length), "base64").reverse().toString("utf8")
      : null,
};
