// The app-data privacy check that comes before any SSH transport is made
// (docs/design/setup.md §2 rule 3; docs/decisions.md, "SSH to another
// computer"): the folder the host keeps its SSH files in, and every folder
// above it, must be ones no other account can redirect. OpenSSH reopens the
// configuration and known-hosts paths by name, so a folder another account can
// replace or rename under the host would let it change what `ssh` reads.
//
// The existing folders are proven first, from the top down, and nothing is
// created until they are: each is looked at without following a link, must be
// a real folder owned by this account or by root, and must not be writable by
// group or others, except a sticky folder (such as /tmp), whose entries only
// their owners can rename or remove, when the folder below it is this
// account's own. A folder this account owns must be closed to group and
// others. Each folder's access control list is read as well: on macOS an entry
// that allows anyone but this account to add, delete, rename or change
// anything is refused, and on Linux any access control list is, because this
// check can't read one. Only then is each missing folder made, one at a time,
// exclusively, below its proven parent, and proven in turn. A path that
// resolves elsewhere than it is spelt, a check that can't be run, or anything
// else is not established, and SSH setup goes to Advanced. Windows has no SSH
// route in this version (docs/decisions.md).

import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { type as osType, userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export type PrivateDirVerdict =
  | { ok: true; verified: "posix" }
  | {
      ok: false;
      reason:
        | "not-absolute"
        | "resolves-elsewhere"
        | "missing"
        | "link"
        | "not-a-folder"
        | "another-account"
        | "writable-by-others"
        | "acl"
        | "unverifiable"
        | "outside-root"
        | "not-supported";
      /** The folder that failed, for the host's log only; never shown. */
      at: string;
    };

const STICKY = 0o1000;

export type PrivateDirOptions = {
  uid?: number | null;
  platform?: NodeJS.Platform;
  /**
   * For tests, a synthetic top: the walk stops there instead of at `/`, and a
   * `dir` outside it is `outside-root`.
   */
  root?: string;
  /** Make missing folders below the proven part (the default), or only prove what exists. */
  create?: boolean;
  /** Reads a folder's access control list; the default runs `/bin/ls`. For tests. */
  readAcl?: (path: string, platform: NodeJS.Platform) => AclReading;
};

/** A folder's access control list: none, entries (macOS), present but unread (Linux), or unreadable. */
export type AclReading =
  | { kind: "none" }
  | { kind: "entries"; entries: AclEntry[] }
  | { kind: "present" }
  | { kind: "unreadable" };

export type AclEntry = { principal: string; allow: boolean; rights: string[] };

/** The rights that add, remove, rename or change something in or about a folder. */
const CHANGING_RIGHTS = new Set([
  "add_file",
  "add_subdirectory",
  "delete",
  "delete_child",
  "write",
  "append",
  "writeattr",
  "writeextattr",
  "writesecurity",
  "chown",
]);

/** The rights that let another account list, enter or read a folder: refused on the leaf only. */
const READING_RIGHTS = new Set(["list", "search", "read"]);

/**
 * `ls -lde` on macOS lists ACL entries below the folder's line; on Linux a `+`
 * marks one. The flags and the reading follow the system actually running
 * (`os.type()`), whose `ls` this is: GNU `ls` has no `-e`.
 */
export function readAclWithLs(path: string, _platform?: NodeJS.Platform): AclReading {
  const darwin = osType() === "Darwin";
  let text: string;
  try {
    text = execFileSync("/bin/ls", [darwin ? "-lde" : "-ld", "--", path], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
  } catch {
    return { kind: "unreadable" };
  }
  const lines = text.split("\n").filter((line) => line !== "");
  const first = lines[0];
  if (!first || !/^[-d][rwxsStT-]{9}[@+.]?\s/.test(first)) return { kind: "unreadable" };
  if (!darwin) return first[10] === "+" ? { kind: "present" } : { kind: "none" };
  const entries: AclEntry[] = [];
  for (const line of lines.slice(1)) {
    const match = /^\s*\d+: (\S+)(?: inherited)? (allow|deny) (\S+)$/.exec(line);
    if (!match) return { kind: "unreadable" };
    entries.push({
      principal: match[1]!,
      allow: match[2] === "allow",
      rights: match[3]!.split(","),
    });
  }
  return entries.length ? { kind: "entries", entries } : { kind: "none" };
}

/**
 * Whether a folder's ACL lets anyone but this account change it, or, on the
 * leaf, list, enter or read it: folders above it are entered by others as usual.
 */
function aclOpensIt(reading: AclReading, me: string, leaf: boolean): boolean | null {
  switch (reading.kind) {
    case "none":
      return false;
    case "present":
      return true;
    case "unreadable":
      return null;
    case "entries":
      return reading.entries.some(
        (entry) =>
          entry.allow &&
          entry.principal !== `user:${me}` &&
          entry.rights.some(
            (right) => CHANGING_RIGHTS.has(right) || (leaf && READING_RIGHTS.has(right)),
          ),
      );
  }
}

type Fail = Extract<PrivateDirVerdict, { ok: false }>;
const fail = (reason: Fail["reason"], at: string): Fail => ({ ok: false, reason, at });

/**
 * Proves `dir` and the folders above it private to this account, creating the
 * missing ones below the proven part (see above), and closes an existing leaf
 * of this account's to group and others through a descriptor opened without
 * following a link.
 */
export function ensurePrivateDir(dir: string, options: PrivateDirOptions = {}): PrivateDirVerdict {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") return fail("not-supported", dir);
  const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : null);
  if (uid === null) return fail("another-account", dir);
  if (!isAbsolute(dir)) return fail("not-absolute", dir);
  const spelt = resolve(dir);
  const readAcl = options.readAcl ?? readAclWithLs;
  let me: string;
  try {
    me = userInfo().username;
  } catch {
    return fail("unverifiable", spelt);
  }
  let top = "/";
  if (options.root !== undefined) {
    try {
      top = realpathSync(options.root);
    } catch {
      return fail("missing", options.root);
    }
    if (spelt !== top && !spelt.startsWith(top.endsWith(sep) ? top : `${top}${sep}`))
      return fail("outside-root", spelt);
  }
  // The folders from the top down to `dir`.
  const chain: string[] = [];
  for (let current = spelt; ; current = dirname(current)) {
    chain.unshift(current);
    if (current === top || dirname(current) === current) break;
  }
  if (chain[0] !== top) return fail("outside-root", spelt);

  /** One existing folder, proven; `child` is the next one down, once it exists. */
  const prove = (
    path: string,
    info: Stats,
    leaf: boolean,
    childUid: number | null,
  ): Fail | null => {
    if (info.isSymbolicLink()) return fail("link", path);
    if (!info.isDirectory()) return fail("not-a-folder", path);
    if (info.uid !== uid && info.uid !== 0) return fail("another-account", path);
    if (leaf && info.uid !== uid) return fail("another-account", path);
    const othersWrite = (Number(info.mode) & 0o022) !== 0;
    if (othersWrite) {
      // A sticky folder lets others make entries, never rename or remove this account's own.
      const stickyOverOwn =
        info.uid === 0 && (Number(info.mode) & STICKY) !== 0 && childUid === uid;
      if (!stickyOverOwn) return fail("writable-by-others", path);
    }
    const opens = aclOpensIt(readAcl(path, platform), me, leaf);
    if (opens === null) return fail("unverifiable", path);
    if (opens) return fail("acl", path);
    return null;
  };

  // The part that exists, proven from the top down before anything is made.
  let existing = 0;
  const infos: Stats[] = [];
  for (const path of chain) {
    let info: Stats;
    try {
      info = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      return fail("unverifiable", path);
    }
    infos.push(info);
    existing += 1;
  }
  if (existing === 0) return fail("missing", chain[0]!);
  for (let i = 0; i < existing; i += 1) {
    const leaf = i === chain.length - 1;
    const childUid = i + 1 < existing ? Number(infos[i + 1]!.uid) : uid;
    // A folder of this account's that isn't the leaf is closed to others too.
    const info = infos[i]!;
    if (!leaf && info.uid === uid && (Number(info.mode) & 0o022) !== 0)
      return fail("writable-by-others", chain[i]!);
    const problem = prove(chain[i]!, info, leaf, childUid);
    if (problem) return problem;
  }
  // No link anywhere: the proven part resolves exactly as it is spelt.
  try {
    if (realpathSync(chain[existing - 1]!) !== chain[existing - 1]) {
      return fail("resolves-elsewhere", chain[existing - 1]!);
    }
  } catch {
    return fail("unverifiable", chain[existing - 1]!);
  }
  if (existing < chain.length && options.create === false) return fail("missing", spelt);

  // The missing folders, each made exclusively below its proven parent, and proven in turn.
  for (let i = existing; i < chain.length; i += 1) {
    const path = chain[i]!;
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch {
      return fail("unverifiable", path);
    }
    let info: Stats;
    try {
      info = lstatSync(path);
    } catch {
      return fail("unverifiable", path);
    }
    if (info.uid !== uid) return fail("another-account", path);
    const problem = prove(path, info, i === chain.length - 1, uid);
    if (problem) return problem;
  }

  // The leaf, through a descriptor that refuses a link: this account's, closed to everyone else.
  let fd: number;
  try {
    fd = openSync(spelt, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch {
    return fail("unverifiable", spelt);
  }
  try {
    const info = fstatSync(fd);
    if (!info.isDirectory() || info.uid !== uid) return fail("another-account", spelt);
    if ((info.mode & 0o077) !== 0) fchmodSync(fd, info.mode & 0o700);
    if ((fstatSync(fd).mode & 0o077) !== 0) return fail("writable-by-others", spelt);
  } catch {
    return fail("unverifiable", spelt);
  } finally {
    closeSync(fd);
  }
  return { ok: true, verified: "posix" };
}

/** Why the host offers no SSH route. */
export type SshFolderRefusal = { refused: "app-files-unsafe" | "not-supported" };

/**
 * The host's boundary, and what the desktop app's main process calls at
 * launch: the data folder and its `ssh` folder are proven private (and made
 * only below a proven parent), and only then is `make` given the SSH folder.
 * Otherwise nothing is made and SSH setup goes to Advanced. A system with no
 * private local channel for the forward (Windows) has no SSH route.
 */
export function sshTransportFor<T>(
  dataDir: string,
  make: (sshDir: string) => T,
  options: PrivateDirOptions & { log?: (line: string) => void } = {},
): T | SshFolderRefusal {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") return { refused: "not-supported" };
  for (const dir of [dataDir, join(dataDir, "ssh")]) {
    const verdict = ensurePrivateDir(dir, options);
    if (!verdict.ok) {
      options.log?.(`[setup] The app's SSH folder isn't proven private (${verdict.reason}).`);
      return { refused: "app-files-unsafe" };
    }
  }
  return make(join(dataDir, "ssh"));
}

/**
 * `dir` with the system's own links followed: a link owned by root, in a
 * folder owned by root that no one else can write (macOS's `/var` and
 * `/tmp`), can't be redirected by another account, and is resolved. Any other
 * link is left as it is spelt, for `ensurePrivateDir` to refuse.
 */
export function followSystemLinks(dir: string): string {
  if (!isAbsolute(dir)) return dir;
  const parts = resolve(dir).split(sep).filter(Boolean);
  let current: string = sep;
  for (let i = 0; i < parts.length; i += 1) {
    const next = join(current, parts[i]!);
    let info: Stats;
    try {
      info = lstatSync(next);
    } catch {
      // Missing from here on: what follows is made below a proven parent, or refused.
      return join(next, ...parts.slice(i + 1));
    }
    if (info.isSymbolicLink()) {
      let parent: Stats;
      try {
        parent = lstatSync(current);
      } catch {
        return resolve(dir);
      }
      const systems = info.uid === 0 && parent.uid === 0 && (Number(parent.mode) & 0o022) === 0;
      if (!systems) return resolve(dir);
      try {
        current = realpathSync(next);
      } catch {
        return resolve(dir);
      }
      continue;
    }
    current = next;
  }
  return current;
}

/** The data folder the desktop app keeps its device key, tokens and routes in, or why there is none. */
export type DataDirChoice =
  | { ok: true; dir: string; verified: "posix" | "windows-unverified" }
  /** `at`: the folder that failed, for the host's log only. */
  | { ok: false; dir: string; reason: Fail["reason"]; at: string };

/**
 * The desktop app's data folder, as its main process takes it at launch,
 * before either store is built: on macOS and Linux only once `ensurePrivateDir`
 * proved it and the folders above it private (making the missing ones below a
 * proven parent). A folder that can't be proven is not changed or made, and
 * the launch stops with a folder error the person can fix and retry. Windows
 * relies on the folder's inherited access controls, which this doesn't verify.
 */
export function chooseDataDir(
  dir: string,
  options: PrivateDirOptions & { mkdir?: (dir: string) => void } = {},
): DataDirChoice {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    try {
      (options.mkdir ?? ((path) => mkdirSync(path, { recursive: true })))(dir);
    } catch {
      // A file in its place, or no right to make it: the folder error, as on macOS and Linux.
      return { ok: false, dir, reason: "unverifiable", at: dir };
    }
    return { ok: true, dir, verified: "windows-unverified" };
  }
  // The system's own links followed (macOS's temporary folders are under `/var`); no other.
  const real = followSystemLinks(dir);
  const verdict = ensurePrivateDir(real, options);
  return verdict.ok
    ? { ok: true, dir: real, verified: "posix" }
    : { ok: false, dir, reason: verdict.reason, at: verdict.at };
}
