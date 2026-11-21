// The parts of "Another computer" that run nothing: the route store with one
// sealed token per route, the app-data privacy check at the host's own entry
// point, what the found card says from the LOOK's facts, and the approve
// command for a route's account, SSH port and profile.

import { approvalForPlace, TESTED_OPENCLAW_VERSION } from "@clawtrate/core";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { memoryStorage } from "../../../packages/core/test/fake-gateway.ts";
import { parseGatewayStatus, serviceOnPort, type LookFacts } from "../src/main/ssh/look.ts";
import { statusJson as statusJsonRecorded } from "./fixtures/openclaw-outputs.ts";
import { approvalInstructionsFor } from "../src/host/runtime.ts";
import {
  chooseDataDir,
  readAclWithLs,
  ensurePrivateDir,
  sshTransportFor,
  type AclReading,
} from "../src/setup/private-dir.ts";
import {
  NO_SEAL,
  RouteStore,
  routedStorage,
  sshRouteKey,
  type SshRouteRecord,
} from "../src/setup/routes.ts";
import { sshLook } from "../src/setup/ssh-look.ts";
import { tempDir, testSeal } from "./ssh/harness.ts";

/**
 * The installed OpenClaw CLI's own choice of where `gateway status` probes
 * for a bind mode (`pickProbeHostForBind`): that one self-contained function's
 * source, read from its package and evaluated alone, so none of the package's
 * module code runs. Null where no OpenClaw is installed, or another version than the one
 * `docs/decisions.md` names.
 */
const probeHostOfInstalledCli:
  ((bind: string, tailnet: string | null, custom?: string) => string) | null = (() => {
  try {
    const bin = execFileSync("/bin/sh", ["-c", "command -v openclaw"], { encoding: "utf8" }).trim();
    // A wrapper script names its package's entry; an npm link resolves into the package.
    const entry = /"([^"]+)\/dist\/entry\.js"/.exec(readFileSync(bin, "utf8").slice(0, 4096));
    const dist = entry ? `${entry[1]}/dist` : join(dirname(realpathSync(bin)), "dist");
    // Only the version the decisions name: another one's probe says nothing about it.
    const version = (
      JSON.parse(readFileSync(join(dist, "..", "package.json"), "utf8")) as {
        version?: unknown;
      }
    ).version;
    if (version !== TESTED_OPENCLAW_VERSION) return null;
    for (const name of readdirSync(dist)) {
      if (!name.endsWith(".mjs")) continue;
      const text = readFileSync(join(dist, name), "utf8");
      const match =
        /function pickProbeHostForBind\(bindMode, tailnetIPv4, customBindHost\) \{[^}]*\}/.exec(
          text,
        );
      if (!match) continue;
      return new Function(`${match[0]}\nreturn pickProbeHostForBind;`)() as (
        bind: string,
        tailnet: string | null,
        custom?: string,
      ) => string;
    }
  } catch {
    // Not installed here.
  }
  return null;
})();

const dirs: string[] = [];
const fresh = (prefix: string) => {
  const dir = tempDir(prefix);
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    // A test may have closed a folder; it is opened again to be removed.
    try {
      chmodSync(dir, 0o700);
    } catch {
      // already gone
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

const FINGERPRINT = `SHA256:${"A".repeat(43)}`;
const record = (patch: Partial<SshRouteRecord> = {}): SshRouteRecord => {
  const base = {
    kind: "ssh" as const,
    id: "r0123456789ab",
    destination: "devbox",
    name: "devbox",
    account: "you@devbox.example",
    sshPort: 22,
    endpoint: "you@[devbox.example]:22",
    fingerprint: FINGERPRINT,
    profile: "default" as const,
    serviceLabel: "LaunchAgent" as const,
    configPath: "~/.openclaw/openclaw.json",
    gatewayPort: 18789,
    identity: null,
    lastUsed: 1,
    ...patch,
  };
  return {
    ...base,
    key:
      patch.key ??
      sshRouteKey({
        fingerprint: base.fingerprint,
        endpoint: base.endpoint,
        gatewayPort: base.gatewayPort,
        profile: base.profile,
      }),
  };
};

/** Every file under `dir` whose bytes hold `secret`. */
function holding(dir: string, secret: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      if (readFileSync(path).includes(Buffer.from(secret))) found.push(path);
    } catch {
      // a folder or an unreadable entry holds no token here
    }
  }
  return found;
}

const TOKEN = '{"token":"plain-device-token-1"}';
const tokenKey = (key: string) => `deviceToken:route:${key}:device-1:operator`;

describe("the route store", () => {
  it("reads its file only when the file's own access control list is owner-only, and proves its folder again before any token, cached or not", async () => {
    const dir = fresh("clawtrate-routes-acl-");
    const writer = new RouteStore(dir, { seal: testSeal });
    const one = record();
    writer.put(one);
    await routedStorage(memoryStorage(), writer).set(tokenKey(one.key), TOKEN);
    // An entry that lets everyone read the file: nothing read from it.
    const everyone = (): AclReading => ({
      kind: "entries",
      entries: [{ principal: "group:everyone", allow: true, rights: ["read"] }],
    });
    const opened = new RouteStore(dir, { seal: testSeal, readAcl: everyone });
    expect(opened.list()).toEqual([]);
    expect(opened.getToken(one.key, "device-1", "operator")).toBeNull();
    // An unreadable list is not owner-only either; none is.
    expect(
      new RouteStore(dir, { seal: testSeal, readAcl: () => ({ kind: "unreadable" }) }).list(),
    ).toEqual([]);
    expect(
      new RouteStore(dir, { seal: testSeal, readAcl: () => ({ kind: "none" }) }).list(),
    ).toHaveLength(1);
    // A folder that stops being private gives no token, though the store had it cached.
    let private_ = true;
    const cached = new RouteStore(dir, { seal: testSeal, folderIsPrivate: () => private_ });
    expect(cached.getToken(one.key, "device-1", "operator")).toBe(TOKEN);
    private_ = false;
    expect(cached.getToken(one.key, "device-1", "operator")).toBeNull();
    expect(cached.hasToken(one.key)).toBe(false);
  });

  it("a read refused while the folder can't be proven private caches nothing: a later write keeps the routes saved", async () => {
    const dir = fresh("clawtrate-routes-refused-");
    const one = record();
    const writer = new RouteStore(dir, { seal: testSeal });
    writer.put(one);
    await routedStorage(memoryStorage(), writer).set(tokenKey(one.key), TOKEN);
    let private_ = false;
    const store = new RouteStore(dir, { seal: testSeal, folderIsPrivate: () => private_ });
    expect(store.list()).toEqual([]);
    private_ = true;
    store.put(record({ id: "r999999999999", endpoint: "you@[elsewhere.example]:22" }));
    expect(
      store
        .list()
        .map((each) => each.id)
        .sort(),
    ).toEqual(["r0123456789ab", "r999999999999"]);
    expect(store.getToken(one.key, "device-1", "operator")).toBe(TOKEN);
  });

  it.skipIf(process.platform !== "darwin")(
    "a route file with a real macOS ACL entry for anyone else isn't read",
    async () => {
      const dir = fresh("clawtrate-routes-macacl-");
      const writer = new RouteStore(dir, { seal: testSeal });
      writer.put(record());
      execFileSync("/bin/chmod", ["+a", "group:everyone allow read", writer.path]);
      expect(new RouteStore(dir, { seal: testSeal }).list()).toEqual([]);
      execFileSync("/bin/chmod", ["-N", writer.path]);
      expect(new RouteStore(dir, { seal: testSeal }).list()).toHaveLength(1);
    },
  );

  it("a store an earlier draft left with unsealed tokens (version 1) is removed, and the person pairs again", () => {
    const dir = fresh("clawtrate-routes-v1-");
    const path = join(dir, "routes.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        routes: [{ ...record(), token: { deviceId: "device-1", role: "operator", value: TOKEN } }],
      }),
      { mode: 0o600 },
    );
    const routes = new RouteStore(dir, { seal: testSeal });
    expect(routes.list()).toEqual([]);
    expect(existsSync(path)).toBe(false);
    expect(holding(dir, "plain-device-token-1")).toEqual([]);
  });

  it("keeps one sealed token per route, only for a route it has a record of, and in its own file alone", async () => {
    const dir = fresh("clawtrate-routes-");
    const routes = new RouteStore(dir, { seal: testSeal });
    const base = memoryStorage();
    const storage = routedStorage(base, routes);
    const one = record();
    await expect(storage.set(tokenKey(one.key), TOKEN)).rejects.toThrow();
    routes.put(one);
    await storage.set(tokenKey(one.key), TOKEN);
    await storage.set("connection", '{"url":"ws://127.0.0.1:5000"}');
    expect(await storage.get(tokenKey(one.key))).toBe(TOKEN);
    // On disk only sealed: the plain token is in no file.
    expect(holding(dir, "plain-device-token-1")).toEqual([]);
    expect(readFileSync(routes.path, "utf8")).toContain("sealed:");
    expect([...base.data.keys()]).toEqual(["connection"]);
    // A second write replaces the one token; there is never a second.
    await storage.set(tokenKey(one.key), '{"token":"plain-device-token-2"}');
    expect(await storage.get(tokenKey(one.key))).toBe('{"token":"plain-device-token-2"}');
    // Another device's or role's key reads nothing.
    expect(await storage.get(`deviceToken:route:${one.key}:device-2:operator`)).toBeNull();
    expect(readFileSync(routes.path).length).toBeGreaterThan(0);
    const { statSync } = await import("node:fs");
    expect(statSync(routes.path).mode & 0o077).toBe(0);
  });

  it("keeps no token where the system can't encrypt it, and says so", async () => {
    const dir = fresh("clawtrate-routes-");
    const routes = new RouteStore(dir, { seal: NO_SEAL });
    routes.put(record());
    expect(routes.canKeepTokens()).toBe(false);
    expect(() => routes.setToken(record().key, "device-1", "operator", TOKEN)).toThrow(
      /can't keep a route's device token encrypted/,
    );
    expect(holding(dir, "plain-device-token-1")).toEqual([]);
  });

  it("a failed write and an update interrupted before its rename leave no file with the plain token", () => {
    const dir = fresh("clawtrate-routes-");
    // The rename fails, and the process "dies" before its own clean-up: the sibling stays.
    let crash = false;
    const routes = new RouteStore(dir, {
      seal: testSeal,
      rename: (from, to) => {
        if (crash) {
          // As if the process ended here: the sibling is copied aside before the clean-up.
          writeFileSync(join(dir, "left-behind"), readFileSync(from));
          throw new Error("crashed");
        }
        renameSync(from, to);
      },
    });
    const one = record();
    routes.put(one);
    crash = true;
    expect(() => routes.setToken(one.key, "device-1", "operator", TOKEN)).toThrow("crashed");
    // The sibling the write made is gone, and what it held was sealed.
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(existsSync(join(dir, "left-behind"))).toBe(true);
    expect(holding(dir, "plain-device-token-1")).toEqual([]);
    expect(readFileSync(join(dir, "left-behind"), "utf8")).toContain("sealed:");
  });

  it("a route whose key changed loses its token; removing a route removes its token; evicted records are told", async () => {
    const dir = fresh("clawtrate-routes-");
    const evicted: string[] = [];
    const routes = new RouteStore(dir, {
      seal: testSeal,
      onEvict: (gone) => evicted.push(gone.id),
    });
    const storage = routedStorage(memoryStorage(), routes);
    const one = record();
    routes.put(one);
    await storage.set(tokenKey(one.key), TOKEN);
    routes.put({ ...one, lastUsed: 2 });
    expect(await storage.get(tokenKey(one.key))).toBe(TOKEN);
    const replaced = record({ fingerprint: `SHA256:${"B".repeat(43)}` });
    expect(replaced.key).not.toBe(one.key);
    routes.put(replaced);
    expect(await storage.get(tokenKey(one.key))).toBeNull();
    expect(await storage.get(tokenKey(replaced.key))).toBeNull();
    routes.remove(replaced.id);
    expect(routes.list()).toEqual([]);
    // The key never names a forward's local address: only the pinned key, endpoint, gateway port, profile.
    expect(record({ gatewayPort: 18790 }).key).not.toBe(one.key);
    expect(record({ profile: "clawtrate" }).key).not.toBe(one.key);
    // A ninth route lets the oldest go, and the host is told so it forgets its pin and files.
    for (let i = 0; i < 9; i += 1)
      routes.put(
        record({
          id: `r${String(i).padStart(12, "0")}`,
          endpoint: `you@[devbox-${i}.example]:22`,
          lastUsed: 10 + i,
        }),
      );
    expect(routes.list()).toHaveLength(8);
    expect(evicted).toEqual(["r000000000000"]);
    // Another record taking a record's key lets that one go as well.
    routes.put(
      record({ id: "rffffffffffff", endpoint: "you@[devbox-8.example]:22", lastUsed: 100 }),
    );
    expect(evicted).toContain("r000000000008");
  });

  it("reads only a plain private file of this account's with one link, and drops records whose key isn't what they name", () => {
    const dir = fresh("clawtrate-routes-");
    const writer = new RouteStore(dir, { seal: testSeal });
    const one = record();
    writer.put(one);
    writer.setToken(one.key, "device-1", "operator", TOKEN);
    const good = readFileSync(writer.path, "utf8");
    const read = () => new RouteStore(dir, { seal: testSeal });
    expect(read().getToken(one.key, "device-1", "operator")).toBe(TOKEN);
    // Readable by others: not read.
    chmodSync(writer.path, 0o644);
    expect(read().list()).toEqual([]);
    chmodSync(writer.path, 0o600);
    // A second link to it: not read.
    linkSync(writer.path, join(dir, "other-name"));
    expect(read().list()).toEqual([]);
    rmSync(join(dir, "other-name"));
    expect(read().list()).toHaveLength(1);
    // A link in its place: not followed.
    const elsewhere = join(dir, "elsewhere.json");
    writeFileSync(elsewhere, good, { mode: 0o600 });
    rmSync(writer.path);
    symlinkSync(elsewhere, writer.path);
    expect(read().list()).toEqual([]);
    rmSync(writer.path);
    // A record whose key is another route's, or with a value past its bound, is dropped.
    const shape = JSON.parse(good) as { routes: Array<Record<string, unknown>> };
    shape.routes[0]!.key = record({ gatewayPort: 18790 }).key;
    writeFileSync(writer.path, JSON.stringify(shape), { mode: 0o600 });
    expect(read().list()).toEqual([]);
    shape.routes[0]!.key = one.key;
    shape.routes[0]!.account = "x".repeat(400);
    writeFileSync(writer.path, JSON.stringify(shape), { mode: 0o600 });
    expect(read().list()).toEqual([]);
    // A folder that isn't proven private is neither read nor written.
    shape.routes[0]!.account = one.account;
    writeFileSync(writer.path, JSON.stringify(shape), { mode: 0o600 });
    const closed = new RouteStore(dir, { seal: testSeal, folderIsPrivate: () => false });
    expect(closed.list()).toEqual([]);
    expect(closed.canKeepTokens()).toBe(false);
    expect(() => closed.put(one)).toThrow(/isn't proven private/);
  });
});

describe.skipIf(process.platform === "win32")("the app-data privacy check", () => {
  it("proves the folders that exist before it makes any, and makes each missing one below a proven parent", () => {
    const root = fresh("clawtrate-private-");
    expect(ensurePrivateDir(join(root, "a", "b", "ssh"), { root })).toEqual({
      ok: true,
      verified: "posix",
    });
    expect(existsSync(join(root, "a", "b", "ssh"))).toBe(true);
    // A folder above it that others can write, without the sticky bit: nothing is made below it.
    mkdirSync(join(root, "open"), { mode: 0o700 });
    chmodSync(join(root, "open"), 0o777);
    expect(ensurePrivateDir(join(root, "open", "ssh"), { root })).toMatchObject({
      ok: false,
      reason: "writable-by-others",
    });
    expect(existsSync(join(root, "open", "ssh"))).toBe(false);
    // Group-writable is writable by another account too.
    chmodSync(join(root, "open"), 0o770);
    expect(ensurePrivateDir(join(root, "open", "ssh"), { root })).toMatchObject({
      ok: false,
      reason: "writable-by-others",
    });
    // Another account's folder, as seen by a different uid.
    expect(ensurePrivateDir(join(root, "a", "b", "ssh"), { root, uid: 4242 })).toMatchObject({
      ok: false,
      reason: "another-account",
    });
    // An access control list that lets another account change it: refused, on Linux any at all.
    const acl = (path: string): AclReading =>
      path === join(root, "a")
        ? {
            kind: "entries",
            entries: [{ principal: "group:staff", allow: true, rights: ["add_file"] }],
          }
        : { kind: "none" };
    expect(
      ensurePrivateDir(join(root, "a", "b", "ssh"), { root, readAcl: acl, platform: "darwin" }),
    ).toMatchObject({ ok: false, reason: "acl", at: join(root, "a") });
    expect(
      ensurePrivateDir(join(root, "a", "b", "ssh"), {
        root,
        platform: "linux",
        readAcl: (path) => (path === join(root, "a") ? { kind: "present" } : { kind: "none" }),
      }),
    ).toMatchObject({ ok: false, reason: "acl" });
    // A deny entry, as macOS puts on a home folder, changes nothing.
    expect(
      ensurePrivateDir(join(root, "a", "b", "ssh"), {
        root,
        platform: "darwin",
        readAcl: () => ({
          kind: "entries",
          entries: [{ principal: "group:everyone", allow: false, rights: ["delete"] }],
        }),
      }).ok,
    ).toBe(true);
    // A check that can't be run establishes nothing.
    expect(
      ensurePrivateDir(join(root, "a", "b", "ssh"), {
        root,
        readAcl: () => ({ kind: "unreadable" }),
      }),
    ).toMatchObject({ ok: false, reason: "unverifiable" });
  });

  it("at the host's own entry point: a redirected leaf, an ancestor another account can write, and a macOS ACL each give no transport, and nothing is made through them", () => {
    const root = fresh("clawtrate-entry-");
    let made = 0;
    const make = () => {
      made += 1;
      return "transport";
    };
    // The data folder's `ssh` is a link elsewhere: refused, and nothing is created there.
    const outside = fresh("clawtrate-outside-");
    mkdirSync(join(root, "data"), { mode: 0o700 });
    symlinkSync(outside, join(root, "data", "ssh"));
    expect(sshTransportFor(join(root, "data"), make, { root })).toEqual({
      refused: "app-files-unsafe",
    });
    expect(readdirSync(outside)).toEqual([]);
    // An ancestor another account can write: refused before the data folder is made.
    mkdirSync(join(root, "shared"), { mode: 0o700 });
    chmodSync(join(root, "shared"), 0o775);
    expect(sshTransportFor(join(root, "shared", "data"), make, { root })).toEqual({
      refused: "app-files-unsafe",
    });
    expect(existsSync(join(root, "shared", "data"))).toBe(false);
    // The same folder, private, gives the transport its `ssh` folder, made here.
    const ok = sshTransportFor(join(root, "home", "data"), make, { root });
    expect(ok).toBe("transport");
    expect(existsSync(join(root, "home", "data", "ssh"))).toBe(true);
    expect(made).toBe(1);
    // Windows has no private channel for the forward: no transport at all.
    expect(sshTransportFor(join(root, "home", "data"), make, { root, platform: "win32" })).toEqual({
      refused: "not-supported",
    });
    expect(made).toBe(1);
  });

  it("the Linux app's default data folder on a standard Ubuntu home (home 750 or 755, ~/.config 700 or 755, no ACL) is proven and made, and a group-writable ancestor is refused", () => {
    const linux = { platform: "linux" as const, readAcl: (): AclReading => ({ kind: "none" }) };
    for (const [homeMode, configMode] of [
      [0o750, 0o700],
      [0o755, 0o755],
      [0o750, 0o755],
      [0o755, 0o700],
    ] as const) {
      // `root` stands for `/`, and `home` for root's 755 `/home`; the user's home and ~/.config below.
      const root = fresh("clawtrate-ubuntu-");
      mkdirSync(join(root, "home", "runner", ".config"), { recursive: true });
      chmodSync(join(root, "home"), 0o755);
      chmodSync(join(root, "home", "runner"), homeMode);
      chmodSync(join(root, "home", "runner", ".config"), configMode);
      const gateway = join(root, "home", "runner", ".config", "Clawtrate", "gateway");
      const mode = `${homeMode.toString(8)}/${configMode.toString(8)}`;
      expect(chooseDataDir(gateway, { root, ...linux }), mode).toEqual({
        ok: true,
        dir: gateway,
        verified: "posix",
      });
      expect(statSync(join(root, "home", "runner", ".config", "Clawtrate")).mode & 0o777).toBe(
        0o700,
      );
      expect(
        sshTransportFor(gateway, () => "transport", { root, ...linux }),
        mode,
      ).toBe("transport");
    }
    // A group-writable ~/.config: another account in the group could replace what is below it.
    const root = fresh("clawtrate-ubuntu-");
    mkdirSync(join(root, "home", "runner", ".config"), { recursive: true });
    chmodSync(join(root, "home", "runner"), 0o750);
    chmodSync(join(root, "home", "runner", ".config"), 0o775);
    const gateway = join(root, "home", "runner", ".config", "Clawtrate", "gateway");
    expect(chooseDataDir(gateway, { root, ...linux })).toMatchObject({
      ok: false,
      reason: "writable-by-others",
      at: join(root, "home", "runner", ".config"),
    });
    expect(existsSync(join(root, "home", "runner", ".config", "Clawtrate"))).toBe(false);
    // And a group-writable home, the same.
    chmodSync(join(root, "home", "runner", ".config"), 0o755);
    chmodSync(join(root, "home", "runner"), 0o770);
    expect(chooseDataDir(gateway, { root, ...linux })).toMatchObject({
      ok: false,
      reason: "writable-by-others",
      at: join(root, "home", "runner"),
    });
  });

  it("a leaf whose ACL lets another account list, search or read it isn't private; the same entry on a folder above it is ordinary", () => {
    for (const right of ["list", "search", "read"]) {
      const root = fresh("clawtrate-leaf-acl-");
      mkdirSync(join(root, "app", "data"), { recursive: true, mode: 0o700 });
      const leaf = join(root, "app", "data");
      const entryOn =
        (where: string) =>
        (path: string): AclReading =>
          path === where
            ? {
                kind: "entries",
                entries: [{ principal: "user:someone", allow: true, rights: [right] }],
              }
            : { kind: "none" };
      expect(ensurePrivateDir(leaf, { root, readAcl: entryOn(leaf) }), right).toMatchObject({
        ok: false,
        reason: "acl",
        at: leaf,
      });
      expect(ensurePrivateDir(leaf, { root, readAcl: entryOn(join(root, "app")) }).ok, right).toBe(
        true,
      );
    }
  });

  it("reads a folder's access control list with the flags of the system actually running, whatever platform a caller simulates", () => {
    // On Linux, GNU ls has no `-e`: a simulated macOS must not make the real reading fail.
    const root = fresh("clawtrate-acl-system-");
    for (const platform of ["darwin", "linux"] as const)
      expect(readAclWithLs(root, platform), platform).toEqual({ kind: "none" });
    for (const platform of ["darwin", "linux"] as const)
      expect(chooseDataDir(join(root, "gateway"), { root, platform }).ok, platform).toBe(true);
  });

  it("the launch's data folder: a redirected folder, an ancestor another account can write and a macOS ACL each stop the launch, and nothing is changed or made there", () => {
    const root = fresh("clawtrate-data-");
    // A redirected leaf: refused, and the folder it leads to keeps its mode.
    const outside = fresh("clawtrate-data-outside-");
    chmodSync(outside, 0o755);
    symlinkSync(outside, join(root, "redirected"));
    expect(chooseDataDir(join(root, "redirected"), { root })).toMatchObject({ ok: false });
    expect(statSync(outside).mode & 0o777).toBe(0o755);
    // An ancestor another account can write: refused, and the data folder isn't made below it.
    mkdirSync(join(root, "shared"), { mode: 0o700 });
    chmodSync(join(root, "shared"), 0o777);
    expect(chooseDataDir(join(root, "shared", "gateway"), { root })).toMatchObject({
      ok: false,
      reason: "writable-by-others",
    });
    expect(existsSync(join(root, "shared", "gateway"))).toBe(false);
    expect(statSync(join(root, "shared")).mode & 0o777).toBe(0o777);
    // A private place: proven, made, and the same folder the SSH leaf is then made in.
    expect(chooseDataDir(join(root, "home", "gateway"), { root })).toEqual({
      ok: true,
      dir: join(root, "home", "gateway"),
      verified: "posix",
    });
    expect(sshTransportFor(join(root, "home", "gateway"), () => "transport", { root })).toBe(
      "transport",
    );
    // The system's own links are followed (macOS keeps temporary folders below root's /var link),
    // and the folder is taken where it really is.
    const viaSystem = mkdtempSync(join(tmpdir(), "clawtrate-data-system-"));
    dirs.push(viaSystem);
    const taken = chooseDataDir(join(viaSystem, "gateway"));
    expect(taken).toMatchObject({ ok: true, dir: join(realpathSync(viaSystem), "gateway") });
    // Windows keeps its own branch: the folder is made, its ACLs are the system's.
    const made: string[] = [];
    expect(
      chooseDataDir("D:\\Clawtrate\\gateway", {
        platform: "win32",
        mkdir: (dir) => made.push(dir),
      }),
    ).toMatchObject({ ok: true, verified: "windows-unverified" });
    expect(made).toEqual(["D:\\Clawtrate\\gateway"]);
    // A folder Windows can't make (a file in its place) is the folder error, not a throw.
    expect(
      chooseDataDir("D:\\Clawtrate\\gateway", {
        platform: "win32",
        mkdir: () => {
          throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
        },
      }),
    ).toEqual({
      ok: false,
      dir: "D:\\Clawtrate\\gateway",
      reason: "unverifiable",
      at: "D:\\Clawtrate\\gateway",
    });
  });

  it.skipIf(process.platform !== "darwin")(
    "the launch's data folder below a folder with a macOS ACL that lets everyone add files is refused and not made",
    () => {
      const root = fresh("clawtrate-data-acl-");
      mkdirSync(join(root, "app"), { mode: 0o700 });
      execFileSync("/bin/chmod", [
        "+a",
        "group:everyone allow add_file,delete_child",
        join(root, "app"),
      ]);
      expect(chooseDataDir(join(root, "app", "gateway"), { root })).toMatchObject({
        ok: false,
        reason: "acl",
      });
      expect(existsSync(join(root, "app", "gateway"))).toBe(false);
      execFileSync("/bin/chmod", ["-N", join(root, "app")]);
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "reads a real macOS ACL: an entry that lets everyone add files to an ancestor is refused at the entry point",
    () => {
      const root = fresh("clawtrate-acl-");
      mkdirSync(join(root, "app"), { mode: 0o700 });
      execFileSync("/bin/chmod", [
        "+a",
        "group:everyone allow add_file,delete_child",
        join(root, "app"),
      ]);
      expect(ensurePrivateDir(join(root, "app", "data"), { root })).toMatchObject({
        ok: false,
        reason: "acl",
        at: join(root, "app"),
      });
      expect(sshTransportFor(join(root, "app", "data"), () => "transport", { root })).toEqual({
        refused: "app-files-unsafe",
      });
      expect(existsSync(join(root, "app", "data"))).toBe(false);
      execFileSync("/bin/chmod", ["-N", join(root, "app")]);
      expect(sshTransportFor(join(root, "app", "data"), () => "transport", { root })).toBe(
        "transport",
      );
    },
  );
});

const facts = (patch: Partial<LookFacts> = {}): LookFacts => ({
  system: { os: "Darwin", machine: "arm64", nodeName: "devbox" },
  program: "~/.openclaw/bin/openclaw",
  programSum: "1234567890 4096",
  version: { year: 2026, month: 10, day: 6, build: "fe06181" },
  gateways: [],
  signs: {
    defaultState: true,
    defaultService: true,
    clawtrateState: false,
    clawtrateService: false,
  },
  ...patch,
});
const gateway = (patch: Record<string, unknown> = {}) => ({
  profile: "default" as const,
  exit: 0,
  portStatus: "busy" as "busy" | "free" | null,
  rpcUrl: "ws://127.0.0.1:18789" as string | null,
  service: { label: "LaunchAgent" as const, loaded: true, running: true, pid: 7 },
  configPath: "~/.openclaw/openclaw.json",
  port: 18789,
  bindMode: "loopback" as const,
  version: { year: 2026, month: 10, day: 6, build: null },
  rpcOk: true as boolean | null,
  listenerPids: [7] as number[] | null,
  ...patch,
});
const stoppedService = { label: "LaunchAgent", loaded: true, running: false, pid: null };
const provenStopped = {
  service: stoppedService,
  rpcOk: false,
  portStatus: "free",
  listenerPids: [],
};

describe("what the found card says over SSH", () => {
  it("names only what the LOOK established: running, untested, too old, proven stopped, missing, not found", () => {
    expect(sshLook(facts({ gateways: [gateway()] })).look).toMatchObject({
      outcome: "running",
      version: "2026.10.6",
      profile: "default",
      listens: "loopback",
      service: "launchagent",
      port: 18789,
      authMode: null,
      others: [],
    });
    expect(
      sshLook(
        facts({ gateways: [gateway({ version: { year: 2026, month: 9, day: 37, build: null } })] }),
      ).look.outcome,
    ).toBe("untested");
    expect(
      sshLook(
        facts({ gateways: [gateway({ version: { year: 2026, month: 6, day: 2, build: null } })] }),
      ).look.outcome,
    ).toBe("too-old");
    const stopped = sshLook(facts({ gateways: [gateway(provenStopped)] }));
    expect(stopped.look).toMatchObject({ outcome: "stopped", service: "launchagent-stopped" });
    expect(stopped.stopped).toMatchObject({ profile: "default", port: 18789 });
    expect(sshLook(facts({ program: null })).look.outcome).toBe("program-missing");
    expect(
      sshLook(
        facts({
          program: null,
          signs: {
            defaultState: false,
            defaultService: false,
            clawtrateState: false,
            clawtrateService: false,
          },
        }),
      ).look.outcome,
    ).toBe("not-found");
    // A listener that isn't the service's own process: Clawtrate can't tell, and offers no Connect.
    const foreign = sshLook(facts({ gateways: [gateway({ listenerPids: [7, 8] })] }));
    expect(foreign.found).toBeNull();
    expect(foreign.look.outcome).toBe("cant-tell");
  });

  it("reads each profile's own status: a stopped default beside Clawtrate's profile running on the same port is no Start", () => {
    const both = sshLook(
      facts({
        gateways: [
          gateway(provenStopped),
          gateway({ profile: "clawtrate", configPath: "~/.openclaw-clawtrate/openclaw.json" }),
        ],
      }),
    );
    expect(both.stopped).toBeNull();
    expect(both.look).toMatchObject({ outcome: "running", profile: "clawtrate", port: 18789 });
    expect(both.found?.service.profile).toBe("clawtrate");
  });

  it("treats an unknown listener state as unknown: stopped only from a free port, a failed RPC, a loaded stopped service and a compatible CLI", () => {
    const tell = (patch: Record<string, unknown>, more: Partial<LookFacts> = {}) =>
      sshLook(facts({ gateways: [gateway({ ...provenStopped, ...patch })], ...more }));
    // The review's case: a stopped service entry with no port data and an RPC that answered.
    const missing = tell({ portStatus: null, listenerPids: null, rpcOk: true });
    expect(missing.stopped).toBeNull();
    expect(missing.look).toMatchObject({ outcome: "cant-tell", reason: "contradictory" });
    // Each fact alone, missing or disagreeing: never the stopped card.
    for (const patch of [
      { portStatus: null },
      { portStatus: "busy" },
      { listenerPids: null },
      { listenerPids: [99] },
      { rpcOk: null },
      { rpcOk: true },
      { exit: 1 },
      { service: { ...stoppedService, loaded: false } },
      { service: { ...stoppedService, loaded: null } },
    ])
      expect(tell(patch).stopped, JSON.stringify(patch)).toBeNull();
    // A CLI older than setup supports: not offered Start.
    expect(tell({}, { version: { year: 2026, month: 6, day: 2, build: null } }).stopped).toBeNull();
    // Running needs the RPC at exactly the gateway's loopback endpoint, and the gateway's version.
    expect(
      sshLook(facts({ gateways: [gateway({ rpcUrl: "ws://127.0.0.1:18790" })] })).found,
    ).toBeNull();
    expect(sshLook(facts({ gateways: [gateway({ rpcUrl: null })] })).found).toBeNull();
    expect(sshLook(facts({ gateways: [gateway({ version: null })] })).found).toBeNull();
    expect(sshLook(facts({ gateways: [gateway({ portStatus: "free" })] })).found).toBeNull();
    // A program the LOOK couldn't checksum is one no script will run.
    expect(sshLook(facts({ gateways: [gateway()], programSum: null })).look.outcome).toBe(
      "cant-tell",
    );
  });
});

describe("one stopped verdict, and the loopback endpoint the status proves", () => {
  it("the forward's \"stopped\" is the card's: an unloaded or contradictory stopped service is not stopped for either", () => {
    const cases: Array<[Record<string, unknown>, boolean]> = [
      [{}, true],
      [{ service: { ...stoppedService, loaded: false } }, false],
      [{ service: { ...stoppedService, loaded: null } }, false],
      [{ rpcOk: true }, false],
      [{ portStatus: "busy" }, false],
    ];
    for (const [patch, stopped] of cases) {
      const f = facts({ gateways: [gateway({ ...provenStopped, ...patch })] });
      const port = serviceOnPort(f, 18789);
      expect(port.ok ? "running" : port.reason, JSON.stringify(patch)).toBe(
        stopped ? "not-running" : "cant-tell",
      );
      expect(sshLook(f).stopped !== null, JSON.stringify(patch)).toBe(stopped);
    }
    // A CLI setup doesn't support: the forward doesn't call it stopped either.
    const old = facts({
      gateways: [gateway(provenStopped)],
      version: { year: 2026, month: 6, day: 2, build: null },
    });
    expect(serviceOnPort(old, 18789)).toMatchObject({ ok: false, reason: "cant-tell" });
  });

  it.skipIf(probeHostOfInstalledCli === null)(
    "the installed OpenClaw's status probes loopback for loopback and LAN binds, and elsewhere for tailnet and custom ones, which aren't offered",
    async () => {
      const pick = probeHostOfInstalledCli!;
      const port = 18789;
      const cases: Array<[string, string | undefined, "running" | "endpoint"]> = [
        ["loopback", undefined, "running"],
        ["lan", undefined, "running"],
        ["tailnet", undefined, "endpoint"],
        ["custom", "198.51.100.20", "endpoint"],
      ];
      for (const [bind, custom, expected] of cases) {
        const host = pick(bind, "203.0.113.9", custom);
        const text = statusJsonRecorded({
          port,
          bind,
          service: "running",
          targetRole: "gateway",
          probeUrl: `ws://${host}:${port}`,
          rpcUrl: `ws://${host}:${port}`,
        });
        // The recorded shape writes a placeholder where the real CLI prints its config's absolute path.
        const status = parseGatewayStatus(
          "default",
          0,
          text.replaceAll("<state>", "/srv/openclaw/state"),
        )!;
        const f = facts({ gateways: [status] });
        const look = sshLook(f);
        if (expected === "running") expect(look.look.outcome, bind).toBe("running");
        else expect(look.look, bind).toMatchObject({ outcome: "cant-tell", reason: "endpoint" });
        expect(look.found !== null, bind).toBe(expected === "running");
      }
    },
  );
});

describe("the approve command for a route's account, SSH port and profile", () => {
  const ssh = (profile: "default" | "clawtrate") =>
    ({ route: "ssh", account: "you@127.0.0.1", port: 2222, profile }) as const;
  const instructions = approvalInstructionsFor(null, (url) =>
    url === "ws://c0000000000000001.ssh.invalid"
      ? ssh("default")
      : url === "ws://c0000000000000002.ssh.invalid"
        ? ssh("clawtrate")
        : url === "ws://127.0.0.1:18789"
          ? { route: "this-computer", profile: "default" }
          : null,
  );
  const id = "e5eb4aa8-175f-40f1-bc7a-8f15cfc40942";

  it("names the full account and SSH port to run it on and the profile, with a validated request id only", () => {
    // An alias ("devbox") resolved elsewhere, on a port other than 22: the account and port as resolved.
    expect(instructions("ws://c0000000000000001.ssh.invalid", id)).toEqual({
      command: `openclaw devices approve ${id}`,
      note: "On you@127.0.0.1 (SSH port 2222), approve this request for the default profile.",
    });
    expect(instructions("ws://c0000000000000002.ssh.invalid", id)).toEqual({
      command: `openclaw --profile clawtrate devices approve ${id}`,
      note: "On you@127.0.0.1 (SSH port 2222), approve this request for the clawtrate profile.",
    });
    expect(instructions("ws://127.0.0.1:18789", id)).toEqual({
      command: `openclaw devices approve ${id}`,
      note: "On this computer, approve this request for the default profile:",
    });
    expect(instructions("wss://gateway.example", id)).toEqual({
      command: `openclaw devices approve ${id}`,
      note: "The gateway's owner runs this on the machine where the gateway runs.",
    });
    // No request id: list them, and match this device before approving.
    expect(approvalForPlace(ssh("default"), "")).toEqual({
      command: "openclaw devices list",
      note: "On you@127.0.0.1 (SSH port 2222), list pending devices for the default profile and match this device ID before you approve.",
    });
    // A request id of any other shape is never put into the command the person copies.
    for (const bad of ["x; rm -rf ~", "$(id)", "e5eb4aa8 175f", "a".repeat(36)])
      expect(approvalForPlace(ssh("default"), bad).command).toBe("openclaw devices list");
  });
});
