// The person's SSH configuration, read as text (docs/design/setup.md, section
// 5). Only eight settings are taken from the blocks that apply to the typed
// name: HostName, User, Port, IdentityFile, IdentitiesOnly, CertificateFile,
// IdentityAgent and PubkeyAuthentication.
// A setting that could run a command, open a forward, reach the computer
// through another one, choose its address, change how its key is checked or
// how this account signs in is refused by name, and so is any setting this
// file does not know. A relative Include is read from the SSH configuration
// folder, as OpenSSH reads it, and an Include this file can't follow exactly is
// refused by name. The file is never given to `ssh`,
// and `ssh -G` is never used: it would evaluate `Match exec`.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { type Destination, isHost, isUser, parsePort } from "./destination.ts";
import { physicalPath, within } from "./paths.ts";
import { CONFIG_PATH } from "./route-config.ts";
import { guardWorld, isAgentSocket, type SshWorld, SshWorldRefused } from "./world.ts";

export type RefusalCategory =
  "jump-host" | "command-or-forward" | "host-key" | "unsupported" | "invalid-value" | "unreadable";

export type ConfigRefusal = {
  ok: false;
  kind: "refused";
  category: RefusalCategory;
  /** The setting by its usual spelling, such as "ProxyJump", or "" when the file couldn't be read. */
  setting: string;
  title: string;
  sentence: string;
};

export type Target = {
  ok: true;
  destination: Destination;
  /** The name typed, without the user: "devbox". */
  name: string;
  hostName: string;
  user: string;
  port: number;
  identityFiles: string[];
  identitiesOnly: boolean | null;
  certificateFiles: string[];
  /** The person's `IdentityAgent`: "world" when they set none (or `SSH_AUTH_SOCK`), so the app's choice stands. */
  identityAgent: "world" | "none" | { socket: string };
  pubkeyAuthentication: "yes" | "no" | "unbound" | "host-bound" | null;
};

const TAKEN = new Map([
  ["hostname", "HostName"],
  ["user", "User"],
  ["port", "Port"],
  ["identityfile", "IdentityFile"],
  ["identitiesonly", "IdentitiesOnly"],
  ["certificatefile", "CertificateFile"],
  ["identityagent", "IdentityAgent"],
  ["pubkeyauthentication", "PubkeyAuthentication"],
]);

const REFUSED = new Map<string, [string, RefusalCategory]>([
  ["proxyjump", ["ProxyJump", "jump-host"]],
  ["proxycommand", ["ProxyCommand", "jump-host"]],
  ["match", ["Match", "command-or-forward"]],
  ["localcommand", ["LocalCommand", "command-or-forward"]],
  ["permitlocalcommand", ["PermitLocalCommand", "command-or-forward"]],
  ["remotecommand", ["RemoteCommand", "command-or-forward"]],
  ["localforward", ["LocalForward", "command-or-forward"]],
  ["remoteforward", ["RemoteForward", "command-or-forward"]],
  ["dynamicforward", ["DynamicForward", "command-or-forward"]],
  ["sendenv", ["SendEnv", "command-or-forward"]],
  ["setenv", ["SetEnv", "command-or-forward"]],
  ["forwardagent", ["ForwardAgent", "command-or-forward"]],
  ["forwardx11", ["ForwardX11", "command-or-forward"]],
  ["controlmaster", ["ControlMaster", "command-or-forward"]],
  ["controlpath", ["ControlPath", "command-or-forward"]],
  ["include", ["Include", "command-or-forward"]],
  ["stricthostkeychecking", ["StrictHostKeyChecking", "host-key"]],
  ["userknownhostsfile", ["UserKnownHostsFile", "host-key"]],
  ["globalknownhostsfile", ["GlobalKnownHostsFile", "host-key"]],
  ["knownhostscommand", ["KnownHostsCommand", "host-key"]],
  ["updatehostkeys", ["UpdateHostKeys", "host-key"]],
  ["hostkeyalias", ["HostKeyAlias", "host-key"]],
  ["verifyhostkeydns", ["VerifyHostKeyDNS", "host-key"]],
  ["revokedhostkeys", ["RevokedHostKeys", "host-key"]],
  ["hostkeyalgorithms", ["HostKeyAlgorithms", "host-key"]],
  ["checkhostip", ["CheckHostIP", "host-key"]],
  ["casignaturealgorithms", ["CASignatureAlgorithms", "host-key"]],
  ["hashknownhosts", ["HashKnownHosts", "host-key"]],
  ["ciphers", ["Ciphers", "host-key"]],
  ["macs", ["MACs", "host-key"]],
  ["kexalgorithms", ["KexAlgorithms", "host-key"]],
  ["forwardx11trusted", ["ForwardX11Trusted", "command-or-forward"]],
  ["addressfamily", ["AddressFamily", "unsupported"]],
  ["preferredauthentications", ["PreferredAuthentications", "unsupported"]],
  ["pubkeyacceptedalgorithms", ["PubkeyAcceptedAlgorithms", "unsupported"]],
  ["pubkeyacceptedkeytypes", ["PubkeyAcceptedKeyTypes", "unsupported"]],
  ["passwordauthentication", ["PasswordAuthentication", "unsupported"]],
  ["kbdinteractiveauthentication", ["KbdInteractiveAuthentication", "unsupported"]],
  ["challengeresponseauthentication", ["ChallengeResponseAuthentication", "unsupported"]],
  ["gssapiauthentication", ["GSSAPIAuthentication", "unsupported"]],
  ["numberofpasswordprompts", ["NumberOfPasswordPrompts", "unsupported"]],
]);

/**
 * Settings that are left out without a refusal: the host's own file sets them,
 * or `ssh`'s default stands. None runs anything, chooses the address, touches
 * the key check or the connection's algorithms, or chooses which identity
 * signs in: `AddKeysToAgent` and `UseKeychain` only load keys into the agent,
 * and `BatchMode` is the host's own.
 */
const IGNORED = new Set([
  "addkeystoagent",
  "usekeychain",
  "serveraliveinterval",
  "serveralivecountmax",
  "connecttimeout",
  "connectionattempts",
  "tcpkeepalive",
  "compression",
  "loglevel",
  "visualhostkey",
  "batchmode",
  "requesttty",
  "escapechar",
  "ignoreunknown",
]);

const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES = 32;
const MAX_DEPTH = 8;
const MAX_LIST = 16;

/** The note for a refused setting: it names the setting, whatever its group. */
function refusal(category: RefusalCategory, setting: string, name: string): ConfigRefusal {
  const plain = "Use a plain SSH alias or Advanced.";
  const notes: Record<RefusalCategory, [string, string]> = {
    "jump-host": [
      `The SSH settings for ${name} include ${setting}.`,
      `Clawtrate doesn't connect through another computer. ${plain}`,
    ],
    "command-or-forward": [
      `Clawtrate can't use ${setting} in the SSH settings for ${name}.`,
      plain,
    ],
    "host-key": [`Clawtrate can't use ${setting} in the SSH settings for ${name}.`, plain],
    unsupported: [`Clawtrate can't use ${setting} in the SSH settings for ${name}.`, plain],
    "invalid-value": [
      `Clawtrate can't use ${setting} in the SSH settings for ${name}.`,
      `Clawtrate takes plain values only: no tokens such as %h, no variables, and files in your home folder. ${plain}`,
    ],
    unreadable: ["Clawtrate couldn't read your SSH configuration.", "Use Advanced."],
  };
  const [title, sentence] = notes[category];
  return { ok: false, kind: "refused", category, setting, title, sentence };
}

/**
 * OpenSSH's host pattern: `*` and `?`, compared without case. It walks the
 * name once, going back only to just after the last `*` it passed, so its work
 * is at most the pattern's length times the name's, whatever the wildcards.
 */
function globMatch(pattern: string, value: string, caseSensitive = false): boolean {
  const p = caseSensitive ? pattern : pattern.toLowerCase();
  const v = caseSensitive ? value : value.toLowerCase();
  let i = 0;
  let j = 0;
  let star = -1;
  let resume = 0;
  while (j < v.length) {
    if (i < p.length && p[i] !== "*" && (p[i] === "?" || p[i] === v[j])) {
      i++;
      j++;
    } else if (i < p.length && p[i] === "*") {
      star = i++;
      resume = j;
    } else if (star !== -1) {
      i = star + 1;
      j = ++resume;
    } else {
      return false;
    }
  }
  while (i < p.length && p[i] === "*") i++;
  return i === p.length;
}

/** Whether a `Host` line's patterns apply to `name`: one positive match and no negated one. */
export function hostLineMatches(patterns: readonly string[], name: string): boolean {
  let matched = false;
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) {
      if (globMatch(pattern.slice(1), name)) return false;
    } else if (globMatch(pattern, name)) {
      matched = true;
    }
  }
  return matched;
}

type Line = { keyword: string; spelling: string; value: string };

class Unreadable extends Error {}

/** One line as keyword and value, or null for a blank line or a comment. */
export function splitLine(raw: string): Line | null {
  const line = raw.replace(/\r$/, "").trim();
  if (line === "" || line.startsWith("#")) return null;
  const match = /^([A-Za-z][A-Za-z0-9]*)(?:\s*=\s*|\s+)(.*)$/.exec(line);
  if (!match) throw new Unreadable();
  const spelling = match[1]!;
  return { keyword: spelling.toLowerCase(), spelling, value: match[2]!.trim() };
}

/** A single value, unquoted. Null when it holds quotes anywhere else or is empty. */
function singleValue(value: string): string | null {
  if (value.startsWith('"')) {
    if (value.length < 2 || !value.endsWith('"')) return null;
    const inner = value.slice(1, -1);
    return inner === "" || inner.includes('"') ? null : inner;
  }
  if (value === "" || /["'\s]/.test(value)) return null;
  return value;
}

/** Characters a path may hold: letters, digits, space and `._+@-/`, and a Windows drive. */
const PATH_CHARS = CONFIG_PATH;

/**
 * Whether `path` is inside `home`, both by its spelling and as the file system
 * walks it: a link that leads out of the home folder doesn't count as inside.
 */
function insideHome(path: string, home: string, platform: NodeJS.Platform): boolean {
  const strictly = (p: string, h: string) => within(p, h, platform) && !within(h, p, platform);
  return strictly(resolve(path), resolve(home)) && strictly(physicalPath(path), physicalPath(home));
}

/** A key or certificate path from the person's file: under their home, absolute, plain. */
export function resolvePersonPath(raw: string, world: SshWorld): string | null {
  let value = raw;
  if (world.platform === "win32") value = value.replaceAll("\\", "/");
  if (/[%$`"\\]/.test(value) || /\p{Cc}/u.test(value)) return null;
  let path: string;
  // Kept as spelled, so that what is checked is what `ssh` opens: a `..` after a link is not undone here.
  if (value === "~" || value.startsWith("~/")) path = `${world.home}/${value.slice(2)}`;
  else if (value.startsWith("~")) return null;
  else if (isAbsolute(value) || /^[A-Za-z]:\//.test(value)) path = value;
  else return null;
  // Under a test run, a path into the real .ssh folder is refused before anything looks at it.
  guardWorld(world, [path]);
  const shown = world.platform === "win32" ? path.replaceAll("\\", "/") : path;
  if (!PATH_CHARS.test(shown)) return null;
  if (!insideHome(path, world.home, world.platform)) return null;
  return path;
}

type Found = {
  hostName?: string;
  user?: string;
  port?: number;
  identitiesOnly?: boolean;
  identityFiles: string[];
  certificateFiles: string[];
  identityAgent?: "world" | "none" | { socket: string };
  pubkey?: "yes" | "no" | "unbound" | "host-bound";
};

type Reader = (path: string) => string | null;

/** A path that is not there: no file, or a part of it that is not a folder. Any other error is unreadable. */
const notThere = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

const defaultReader: Reader = (path) => {
  let size: number;
  try {
    const info = statSync(path);
    if (!info.isFile()) return null;
    size = info.size;
  } catch (error) {
    if (notThere(error)) return null;
    throw new Unreadable();
  }
  if (size > MAX_FILE_BYTES) throw new Unreadable();
  return readFileSync(path, "utf8");
};

/** An Include this file can't follow exactly as OpenSSH would: refused by the name Include. */
class IncludeRefused extends Error {}

/**
 * The files an `Include` names: one path, or `*` and `?` in its last part
 * only. A relative path is in the SSH configuration folder, as OpenSSH reads
 * it from the person's file, never beside the file that included it.
 */
function includedFiles(raw: string, world: SshWorld): string[] {
  const value = singleValue(raw);
  // Only one path, with `*` and `?` in its last part: no escapes, classes, braces or tokens.
  if (value === null || /[%$`~\\[\]{}!]/.test(value.slice(value.startsWith("~/") ? 2 : 0)))
    throw new IncludeRefused();
  let path: string;
  // As spelled, as with key paths; each file is guarded before it is opened (`walk`).
  if (value.startsWith("~/")) path = `${world.home}/${value.slice(2)}`;
  else if (isAbsolute(value)) path = value;
  else path = `${dirname(world.personConfig)}/${value}`;
  guardWorld(world, [path]);
  if (!insideHome(path, world.home, world.platform)) throw new IncludeRefused();
  const last = basename(path);
  if (/[*?]/.test(dirname(path))) throw new IncludeRefused();
  if (!/[*?]/.test(last)) return [path];
  guardWorld(world, [dirname(path)]);
  let names: string[];
  try {
    names = readdirSync(dirname(path));
  } catch (error) {
    if (notThere(error)) return [];
    throw new Unreadable();
  }
  const files = names
    // File names match as they are spelt, and a pattern matches no dotfile, as glob(3) does.
    .filter((name) => globMatch(last, name, true) && !name.startsWith("."))
    .sort()
    .map((name) => `${dirname(path)}/${name}`);
  // Each match as the file system walks it: a link among them that leads out of home refuses all.
  if (files.some((file) => !insideHome(file, world.home, world.platform)))
    throw new IncludeRefused();
  return files;
}

type Walk = { files: number; refusal: [RefusalCategory, string] | null };

function walk(
  path: string,
  name: string,
  world: SshWorld,
  read: Reader,
  found: Found,
  state: Walk,
  depth: number,
): void {
  if (state.refusal) return;
  if (depth > MAX_DEPTH || ++state.files > MAX_FILES) throw new Unreadable();
  // Under a test run, a file in the real .ssh folder is refused before it is opened.
  guardWorld(world, [path]);
  const text = read(path);
  if (text === null) return;
  let active = true; // the part before any Host line applies to every host
  let inBlock = false;
  for (const raw of text.split("\n")) {
    const line = splitLine(raw);
    if (!line) continue;
    if (line.keyword === "host") {
      if (/["']/.test(line.value)) throw new Unreadable();
      active = hostLineMatches(line.value.split(/\s+/).filter(Boolean), name);
      inBlock = true;
      continue;
    }
    if (line.keyword === "match") {
      // A Match block's conditions can't be evaluated without running them.
      state.refusal = ["command-or-forward", "Match"];
      return;
    }
    if (!active) continue;
    if (line.keyword === "include") {
      if (inBlock) {
        state.refusal = ["command-or-forward", "Include"];
        return;
      }
      let files: string[];
      try {
        files = includedFiles(line.value, world);
      } catch (error) {
        if (!(error instanceof IncludeRefused)) throw error;
        state.refusal = ["invalid-value", "Include"];
        return;
      }
      for (const file of files) {
        walk(file, name, world, read, found, state, depth + 1);
        if (state.refusal) return;
      }
      continue;
    }
    const refused = REFUSED.get(line.keyword);
    if (refused) {
      state.refusal = [refused[1], refused[0]];
      return;
    }
    const taken = TAKEN.get(line.keyword);
    if (!taken) {
      if (IGNORED.has(line.keyword)) continue;
      state.refusal = ["unsupported", line.spelling];
      return;
    }
    const value = singleValue(line.value);
    const bad = () => {
      state.refusal = ["invalid-value", taken];
    };
    if (value === null || /[%$]/.test(value)) return bad();
    switch (line.keyword) {
      case "hostname":
        if (!isHost(value)) return bad();
        found.hostName ??= value;
        break;
      case "user":
        if (!isUser(value)) return bad();
        found.user ??= value;
        break;
      case "port": {
        const port = parsePort(value);
        if (port === null) return bad();
        found.port ??= port;
        break;
      }
      case "identityagent": {
        if (value === "none") found.identityAgent ??= "none";
        else if (value === "SSH_AUTH_SOCK") found.identityAgent ??= "world";
        else {
          const socket = resolvePersonPath(value, world);
          if (socket === null || !isAgentSocket(socket)) return bad();
          found.identityAgent ??= { socket };
        }
        break;
      }
      case "pubkeyauthentication": {
        const choice = value.toLowerCase();
        if (
          choice !== "yes" &&
          choice !== "no" &&
          choice !== "unbound" &&
          choice !== "host-bound"
        ) {
          return bad();
        }
        found.pubkey ??= choice;
        break;
      }
      case "identitiesonly":
        if (!/^(yes|no)$/i.test(value)) return bad();
        found.identitiesOnly ??= value.toLowerCase() === "yes";
        break;
      case "identityfile":
      case "certificatefile": {
        const resolved = resolvePersonPath(value, world);
        const list = line.keyword === "identityfile" ? found.identityFiles : found.certificateFiles;
        if (resolved === null || list.length >= MAX_LIST) return bad();
        if (!list.includes(resolved)) list.push(resolved);
        break;
      }
    }
  }
}

/** The key names OpenSSH tries when a configuration names none, in its order. */
export const DEFAULT_IDENTITIES = [
  "id_rsa",
  "id_ecdsa",
  "id_ecdsa_sk",
  "id_ed25519",
  "id_ed25519_sk",
];

/**
 * With no IdentityFile configured, Clawtrate looks for id_rsa, id_ecdsa,
 * id_ecdsa_sk, id_ed25519 and id_ed25519_sk under your home and adds each
 * existing eligible file explicitly. With no eligible file, it sets
 * IdentityFile none. Clawtrate also checks the companion paths OpenSSH can
 * derive from each key (`resolveTarget`).
 */
function defaultIdentities(world: SshWorld): string[] {
  const candidates = DEFAULT_IDENTITIES.map((name) => join(world.home, ".ssh", name));
  guardWorld(world, candidates);
  return candidates.filter((path) => resolvePersonPath(path, world) !== null && existsSync(path));
}

/**
 * The target for a validated destination: the eight settings from the blocks
 * of the person's configuration that apply to its host, or a refusal that
 * names the setting.
 */
export function resolveTarget(
  world: SshWorld,
  destination: Destination,
  read: Reader = defaultReader,
): Target | ConfigRefusal {
  const name = destination.host;
  const found: Found = { identityFiles: [], certificateFiles: [] };
  const state: Walk = { files: 0, refusal: null };
  try {
    walk(world.personConfig, name, world, read, found, state, 0);
  } catch (error) {
    if (error instanceof SshWorldRefused) throw error;
    return refusal("unreadable", "", name);
  }
  if (state.refusal) return refusal(state.refusal[0], state.refusal[1], name);
  const user = destination.user ?? found.user ?? world.localUser;
  if (!isUser(user)) return refusal("invalid-value", "User", name);
  const identityFiles = found.identityFiles.length ? found.identityFiles : defaultIdentities(world);
  for (const file of identityFiles) {
    const companions = [file, `${file}.pub`];
    if (!found.certificateFiles.length) companions.push(`${file}-cert.pub`);
    if (companions.some((path) => resolvePersonPath(path, world) === null)) {
      return refusal("invalid-value", "IdentityFile", name);
    }
  }
  return {
    ok: true,
    destination,
    name,
    hostName: found.hostName ?? destination.host,
    user,
    port: found.port ?? 22,
    identityFiles,
    identitiesOnly: found.identitiesOnly ?? null,
    certificateFiles: found.certificateFiles,
    identityAgent: found.identityAgent ?? "world",
    pubkeyAuthentication: found.pubkey ?? null,
  };
}
