// The route store (docs/design/setup.md §2 "Routes", §15; docs/decisions.md,
// "Routes, when the setup flow's SSH package is built"): what the host keeps
// of each SSH route, and the one device token each route has. It is one
// private file, `routes.json`, in the host's private data folder, written
// whole through a private sibling and renamed into place.
//
// A route's device token lives here and nowhere else: the core client keeps a
// routed connection's token under `deviceToken:route:<key>:…`, and the host's
// storage hands exactly those keys to this store (`routedStorage`). A token is
// kept only for a route the store has a record of, one per route; removing the
// route removes its token with it. The token is encrypted before it is written
// (`TokenSeal`: Electron's `safeStorage` in the app), so neither the file nor a
// sibling left by a failed or interrupted write holds it in plain text. Where
// the system can't encrypt it, no token is kept and the host doesn't pair.
//
// The file is read only through a descriptor that refuses a link, from a data
// folder proven private, as a plain file of this account's with one link,
// closed to everyone else and small. Each record is bounded, and its key is
// recomputed from what it names: a record whose key doesn't match is dropped.

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

import { MAX_SSH_ROUTE_RECORDS, ROUTE_KEY, type KeyValueStore } from "@clawtrate/core";

import { ensurePrivateDir, readAclWithLs, type AclReading } from "./private-dir.ts";

/** What identifies an SSH route and what Remove needs, never a forward's local address. */
export type SshRouteRecord = {
  kind: "ssh";
  /** The transport's route id: its alias and files carry it. */
  id: string;
  /** The key its device token is kept for (`ROUTE_KEY`): the pinned key, the endpoint, the port, the profile. */
  key: string;
  /** What the person typed, as it passed the destination pattern. */
  destination: string;
  /** The name typed, without the user: "devbox". */
  name: string;
  /** "you@devbox.example". */
  account: string;
  /** The SSH port the account is reached on. */
  sshPort: number;
  /** The resolved endpoint: "you@[devbox.example]:22". */
  endpoint: string;
  /** The pinned key's fingerprint when the route was made. */
  fingerprint: string;
  /** The gateway service the LOOK found: its profile, label, configuration path and port there. */
  profile: "default" | "clawtrate";
  serviceLabel: "LaunchAgent" | "systemd user" | "systemd" | "Scheduled Task";
  configPath: string;
  gatewayPort: number;
  /** The gateway's identity (`gateway.identity.get`), once read after a hello. */
  identity: string | null;
  /** When it was last connected, ms. */
  lastUsed: number;
};

/** A route's key: what identifies it, never the forward's local address (docs/decisions.md, "Routes"). */
export function sshRouteKey(parts: {
  fingerprint: string;
  endpoint: string;
  gatewayPort: number;
  profile: "default" | "clawtrate";
}): string {
  const digest = createHash("sha256")
    .update(`ssh\n${parts.fingerprint}\n${parts.endpoint}\n${parts.gatewayPort}\n${parts.profile}`)
    .digest("hex");
  return `ssh-${digest.slice(0, 24)}`;
}

/**
 * How a token is kept at rest: encrypted by the system before it is written.
 * `available` is false where the system can't (no keychain, or Linux's plain
 * text fallback): no token is kept there.
 */
export type TokenSeal = {
  available(): boolean;
  seal(plain: string): string;
  /** Null when the text isn't one this system sealed. */
  open(sealed: string): string | null;
};

/** Where tokens can't be encrypted: nothing is sealed, so nothing is kept. */
export const NO_SEAL: TokenSeal = {
  available: () => false,
  seal: () => {
    throw new TokenStorageUnavailable();
  },
  open: () => null,
};

export class TokenStorageUnavailable extends Error {
  override name = "TokenStorageUnavailable";
  constructor() {
    super("This computer can't keep a route's device token encrypted, so none is kept.");
  }
}

type Stored = SshRouteRecord & {
  /** The route's one device token record, as the core wrote it, sealed, for one device and role. */
  token: { deviceId: string; role: string; sealed: string } | null;
};

type FileShape = { version: 2; routes: Stored[] };

/** Routes kept: this version connects through one at a time, and remembers a few. */
export const MAX_ROUTES = MAX_SSH_ROUTE_RECORDS;
/** The store's file, at most. */
export const MAX_ROUTE_FILE_BYTES = 256 * 1024;
/** A sealed token, at most: the core's token record is well under 4 KiB before sealing. */
const MAX_SEALED_CHARS = 16 * 1024;

const TOKEN_KEY = /^deviceToken:route:((?:ssh|here)-[0-9a-f]{24}):([^:]{1,256}):([a-z]{1,32})$/;

/** Whether a storage key is a route's device token: the core's key for a routed connection. */
export const isRouteTokenKey = (key: string) => key.startsWith("deviceToken:route:");

export type RouteStoreOptions = {
  seal?: TokenSeal;
  /** Whether the data folder is private now; the default proves it (`ensurePrivateDir`). */
  folderIsPrivate?: (dir: string) => boolean;
  /** Records evicted (too many, or another record took their key): their pins and files go too. */
  onEvict?: (record: SshRouteRecord) => void;
  /** For tests: the rename that puts a whole file in place. */
  rename?: (from: string, to: string) => void;
  /** For tests: reads the route file's access control list; the default runs `/bin/ls`. */
  readAcl?: (path: string, platform: NodeJS.Platform) => AclReading;
};

export class RouteStore {
  readonly path: string;
  private readonly dir: string;
  private readonly seal: TokenSeal;
  private readonly options: RouteStoreOptions;
  private cache: FileShape | null = null;

  constructor(dir: string, options: RouteStoreOptions = {}) {
    this.dir = dir;
    this.path = join(dir, "routes.json");
    this.seal = options.seal ?? NO_SEAL;
    this.options = options;
  }

  /** Whether a device token can be kept for a route here: encrypted, in a private folder. */
  canKeepTokens(): boolean {
    return this.seal.available() && this.folderIsPrivate();
  }

  private folderIsPrivate(): boolean {
    return this.options.folderIsPrivate
      ? this.options.folderIsPrivate(this.dir)
      : ensurePrivateDir(this.dir, { create: false }).ok;
  }

  private load(): FileShape {
    if (this.cache) return this.cache;
    const empty: FileShape = { version: 2, routes: [] };
    if (!this.folderIsPrivate()) {
      // Nothing is read from, or kept in, a folder that isn't proven private; nothing is cached
      // either, so a later read of the proven folder starts from its file, never from empty.
      return empty;
    }
    const text = readPrivateFile(this.path, this.options.readAcl);
    let parsed: unknown;
    try {
      parsed = text === null ? null : JSON.parse(text);
    } catch {
      parsed = null;
    }
    const shape = parsed as { version?: unknown; routes?: unknown } | null;
    // A store of an earlier draft kept its tokens unsealed: removed, in this proven folder, and
    // the person pairs again.
    if (shape?.version === 1) rmSync(this.path, { force: true });
    const routes: Stored[] = [];
    if (shape && shape.version === 2 && Array.isArray(shape.routes)) {
      for (const each of shape.routes.slice(0, MAX_ROUTES)) {
        if (
          validStored(each) &&
          !routes.some((other) => other.id === each.id || other.key === each.key)
        )
          routes.push(each);
      }
    }
    this.cache = { version: 2, routes };
    // A sibling a write left behind holds no plain token; it goes all the same.
    for (const name of safeList(this.dir)) {
      if (/^routes\.json\.[0-9a-f]{12}\.tmp$/.test(name))
        rmSync(join(this.dir, name), { force: true });
    }
    return this.cache;
  }

  private save(next: FileShape): void {
    if (!this.folderIsPrivate()) throw new Error("The route store's folder isn't proven private.");
    const temp = `${this.path}.${randomBytes(6).toString("hex")}.tmp`;
    const fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    let placed = false;
    try {
      try {
        const data = Buffer.from(`${JSON.stringify(next, null, 2)}\n`, "utf8");
        let offset = 0;
        while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      (this.options.rename ?? renameSync)(temp, this.path);
      placed = true;
    } finally {
      if (!placed) rmSync(temp, { force: true });
    }
    this.cache = next;
  }

  /** Keeps `routes`, the newest first, and tells the host which records it let go. */
  private keep(routes: Stored[], before: Stored[]): void {
    routes.sort((a, b) => b.lastUsed - a.lastUsed);
    const kept = routes.slice(0, MAX_ROUTES);
    this.save({ version: 2, routes: kept });
    for (const old of before) {
      if (!kept.some((each) => each.id === old.id)) this.options.onEvict?.(withoutToken(old));
    }
  }

  /** Every route, without its token. */
  list(): SshRouteRecord[] {
    return this.load().routes.map(withoutToken);
  }

  get(id: string): SshRouteRecord | null {
    const found = this.load().routes.find((route) => route.id === id);
    return found ? withoutToken(found) : null;
  }

  byKey(key: string): SshRouteRecord | null {
    const found = this.load().routes.find((route) => route.key === key);
    return found ? withoutToken(found) : null;
  }

  /**
   * Keeps `record`, replacing the route with its id. A route whose key changed
   * (another key pinned, another port, another profile) loses its token: a
   * token is offered only on the route it was issued for. Another record with
   * the same key is let go, with its pin and files.
   */
  put(record: SshRouteRecord): void {
    if (!validRecord(record)) throw new Error("Not a route record.");
    const data = this.load();
    const old = data.routes.find((route) => route.id === record.id);
    const others = data.routes.filter(
      (route) => route.id !== record.id && route.key !== record.key,
    );
    const token = old && old.key === record.key ? old.token : null;
    this.keep([...others, { ...record, token }], data.routes);
  }

  /** Forgets the route and its token. */
  remove(id: string): void {
    const data = this.load();
    if (!data.routes.some((route) => route.id === id)) return;
    this.save({ version: 2, routes: data.routes.filter((route) => route.id !== id) });
  }

  /** Whether the route has a token kept, for this device. */
  /**
   * The folder is proven again before any token is read, cached or not: one
   * that stopped being private gives no token, and its cache goes.
   */
  private tokensReadable(): boolean {
    if (this.folderIsPrivate()) return true;
    this.cache = null;
    return false;
  }

  hasToken(key: string): boolean {
    if (!this.tokensReadable()) return false;
    return this.load().routes.some((each) => each.key === key && each.token !== null);
  }

  getToken(key: string, deviceId: string, role: string): string | null {
    if (!this.tokensReadable()) return null;
    const route = this.load().routes.find((each) => each.key === key);
    const token = route?.token;
    if (!token || token.deviceId !== deviceId || token.role !== role) return null;
    return this.seal.open(token.sealed);
  }

  /** The route's one token, sealed; refused for a route the store has no record of, or unsealed. */
  setToken(key: string, deviceId: string, role: string, value: string): void {
    if (!this.seal.available()) throw new TokenStorageUnavailable();
    const data = this.load();
    const route = data.routes.find((each) => each.key === key);
    if (!route) throw new Error("There is no such route to keep a token for.");
    const sealed = this.seal.seal(value);
    if (sealed.length > MAX_SEALED_CHARS)
      throw new Error("The token is larger than a route keeps.");
    this.save({
      version: 2,
      routes: data.routes.map((each) =>
        each === route ? { ...each, token: { deviceId, role, sealed } } : each,
      ),
    });
  }

  deleteToken(key: string): void {
    const data = this.load();
    if (!data.routes.some((each) => each.key === key && each.token)) return;
    this.save({
      version: 2,
      routes: data.routes.map((each) => (each.key === key ? { ...each, token: null } : each)),
    });
  }
}

/** The names in `dir`, or none when it can't be listed. */
function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * The store's text, through a descriptor that refuses a link: a plain file of
 * this account's with one link, closed to group and others, and small. Null
 * when there is none; anything else is not this store's and is not read.
 */
/**
 * Whether the file the descriptor holds is this account's alone, its access
 * control list included: the list is read by path (macOS shows none through a
 * descriptor) and holds for the descriptor only while that path names the
 * same file, by device and inode, before and after it is read, in a folder
 * already proven private. An entry that allows anyone else anything, or one
 * that can't be read, is not owner-only.
 */
function ownerOnlyAcl(
  fd: number,
  path: string,
  readAcl: (path: string, platform: NodeJS.Platform) => AclReading,
): boolean {
  const held = fstatSync(fd);
  const same = () => {
    try {
      const now = lstatSync(path);
      return now.dev === held.dev && now.ino === held.ino;
    } catch {
      return false;
    }
  };
  if (!same()) return false;
  const reading = readAcl(path, process.platform);
  if (!same()) return false;
  let me: string;
  try {
    me = userInfo().username;
  } catch {
    return false;
  }
  if (reading.kind === "none") return true;
  if (reading.kind !== "entries") return false;
  return !reading.entries.some((entry) => entry.allow && entry.principal !== `user:${me}`);
}

function readPrivateFile(
  path: string,
  readAcl: (path: string, platform: NodeJS.Platform) => AclReading = readAclWithLs,
): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const info = fstatSync(fd);
    const uid = typeof process.getuid === "function" ? process.getuid() : -1;
    if (
      !info.isFile() ||
      info.uid !== uid ||
      (info.mode & 0o077) !== 0 ||
      info.nlink !== 1 ||
      info.size > MAX_ROUTE_FILE_BYTES
    )
      return null;
    // Its access control list too, on macOS and Linux, for the file this descriptor holds.
    if (process.platform !== "win32" && !ownerOnlyAcl(fd, path, readAcl)) return null;
    const buffer = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return buffer.subarray(0, offset).toString("utf8");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** The host's storage: a route's device token goes to the route store, everything else to `base`. */
export function routedStorage(base: KeyValueStore, routes: RouteStore): KeyValueStore {
  const parse = (key: string) => {
    const match = TOKEN_KEY.exec(key);
    if (!match) throw new Error("Not a route's token key.");
    return { key: match[1]!, deviceId: match[2]!, role: match[3]! };
  };
  return {
    get: async (key) => {
      if (!isRouteTokenKey(key)) return base.get(key);
      const { key: route, deviceId, role } = parse(key);
      return routes.getToken(route, deviceId, role);
    },
    set: async (key, value) => {
      if (!isRouteTokenKey(key)) return base.set(key, value);
      const { key: route, deviceId, role } = parse(key);
      routes.setToken(route, deviceId, role, value);
    },
    delete: async (key) => {
      if (!isRouteTokenKey(key)) return base.delete(key);
      routes.deleteToken(parse(key).key);
    },
  };
}

function withoutToken(stored: Stored): SshRouteRecord {
  const { token: _token, ...record } = stored;
  return record;
}

const LABELS = ["LaunchAgent", "systemd user", "systemd", "Scheduled Task"];
const bounded = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/\p{Cc}/u.test(value);

function validRecord(value: SshRouteRecord): boolean {
  if (!(
    value !== null &&
    typeof value === "object" &&
    value.kind === "ssh" &&
    typeof value.id === "string" &&
    /^r[0-9a-f]{12}$/.test(value.id) &&
    typeof value.key === "string" &&
    ROUTE_KEY.test(value.key) &&
    value.key.startsWith("ssh-") &&
    bounded(value.destination, 320) &&
    bounded(value.name, 320) &&
    bounded(value.account, 320) &&
    Number.isInteger(value.sshPort) &&
    value.sshPort >= 1 &&
    value.sshPort <= 65535 &&
    bounded(value.endpoint, 400) &&
    typeof value.fingerprint === "string" &&
    /^SHA256:[A-Za-z0-9+/]{43}$/.test(value.fingerprint) &&
    (value.profile === "default" || value.profile === "clawtrate") &&
    LABELS.includes(value.serviceLabel) &&
    bounded(value.configPath, 1024) &&
    Number.isInteger(value.gatewayPort) &&
    value.gatewayPort >= 1024 &&
    value.gatewayPort <= 65535 &&
    (value.identity === null || bounded(value.identity, 256)) &&
    typeof value.lastUsed === "number" &&
    Number.isFinite(value.lastUsed)
  ))
    return false;
  // The key is what the record names, recomputed: a record can't claim another route's token.
  return (
    value.key ===
    sshRouteKey({
      fingerprint: value.fingerprint,
      endpoint: value.endpoint,
      gatewayPort: value.gatewayPort,
      profile: value.profile,
    })
  );
}

function validStored(value: Stored): boolean {
  const token = value?.token;
  return (
    validRecord(value) &&
    (token === null ||
      (typeof token === "object" &&
        bounded(token.deviceId, 256) &&
        bounded(token.role, 32) &&
        bounded(token.sealed, MAX_SEALED_CHARS)))
  );
}
