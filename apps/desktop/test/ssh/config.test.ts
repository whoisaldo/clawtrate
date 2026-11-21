// The destination, the person's SSH configuration and the configuration the
// host writes: every honored setting, every refusal, and hostile input.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseDestination, routeAlias } from "../../src/main/ssh/destination.ts";
import { hostLineMatches, resolveTarget, type Target } from "../../src/main/ssh/person-config.ts";
import { pathValue, routeConfigText } from "../../src/main/ssh/route-config.ts";
import type { SshWorld } from "../../src/main/ssh/world.ts";
import { SSH, tempDir, testEnv } from "./harness.ts";

let root: string;
let world: SshWorld;

beforeAll(() => {
  root = tempDir("clawtrate-ssh-config-");
  mkdirSync(join(root, "home", ".ssh"), { recursive: true });
  world = {
    home: join(root, "home"),
    personConfig: join(root, "home", ".ssh", "config"),
    personKnownHosts: join(root, "home", ".ssh", "known_hosts"),
    ssh: SSH,
    appDir: join(root, "app"),
    localUser: "you",
    agent: "none",
    platform: process.platform === "win32" ? "linux" : process.platform,
    env: testEnv(),
  };
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const resolveWith = (text: string, typed = "devbox") => {
  writeFileSync(world.personConfig, text);
  return resolveTarget(world, parseDestination(typed)!);
};

describe("the destination", () => {
  it("accepts an alias, a host name and user@host, and shows them back whole", () => {
    expect(parseDestination("devbox")).toEqual({ typed: "devbox", user: null, host: "devbox" });
    expect(parseDestination("you@devbox.example")).toEqual({
      typed: "you@devbox.example",
      user: "you",
      host: "devbox.example",
    });
    expect(parseDestination("_ci.bot-1@198.51.100.7")?.host).toBe("198.51.100.7");
  });

  it.each([
    ["an option smuggled as the host", "-oProxyCommand=touch"],
    ["an option after the user", "you@-oProxyCommand=x"],
    ["a user starting with a dash", "-you@devbox"],
    ["a host starting with a dot", ".devbox"],
    ["a space", "dev box"],
    ["a newline", "devbox\nProxyCommand x"],
    ["a carriage return", "devbox\r"],
    ["a tab", "dev\tbox"],
    ["a percent token", "%h"],
    ["a percent token in the host", "dev%dbox"],
    ["a variable", "${HOME}"],
    ["a port after a colon", "devbox:22"],
    ["an IPv6 address", "2001:db8::1"],
    ["a path", "devbox/x"],
    ["quotes", '"devbox"'],
    ["a single quote", "dev'box"],
    ["a semicolon", "devbox;true"],
    ["a backtick", "devbox`id`"],
    ["two at signs", "a@b@c"],
    ["an empty user", "@devbox"],
    ["empty", ""],
    ["a non-ASCII letter", "dévbox"],
    ["too long a host", "a".repeat(254)],
    ["too long a user", `${"u".repeat(65)}@devbox`],
  ])("refuses %s", (_name, typed) => {
    expect(parseDestination(typed)).toBeNull();
  });

  it("refuses what isn't a string", () => {
    for (const value of [undefined, null, 1, ["devbox"], { host: "devbox" }]) {
      expect(parseDestination(value)).toBeNull();
    }
  });
});

describe("the person's SSH configuration", () => {
  it("takes the eight settings from the matching block", () => {
    const target = resolveWith(
      [
        "# my hosts",
        "Host devbox",
        "  HostName devbox.example",
        "  User you",
        "  Port 2222",
        "  IdentityFile ~/.ssh/id_ed25519",
        '  IdentityFile "~/.ssh/second key"',
        "  IdentitiesOnly yes",
        "  CertificateFile ~/.ssh/id_ed25519-cert.pub",
        "  IdentityAgent none",
        "  PubkeyAuthentication host-bound",
        "",
      ].join("\n"),
    );
    expect(target).toMatchObject({
      ok: true,
      name: "devbox",
      hostName: "devbox.example",
      user: "you",
      port: 2222,
      identitiesOnly: true,
      identityFiles: [
        join(world.home, ".ssh", "id_ed25519"),
        join(world.home, ".ssh", "second key"),
      ],
      certificateFiles: [join(world.home, ".ssh", "id_ed25519-cert.pub")],
      identityAgent: "none",
      pubkeyAuthentication: "host-bound",
    });
  });

  it("is a plain host with port 22 and the local user when nothing matches, or there is no file", () => {
    expect(resolveWith("Host other\n  HostName 192.0.2.1\n", "devbox.example")).toMatchObject({
      ok: true,
      hostName: "devbox.example",
      user: "you",
      port: 22,
      identityFiles: [],
      identitiesOnly: null,
    });
    rmSync(world.personConfig);
    expect(resolveTarget(world, parseDestination("devbox")!)).toMatchObject({
      ok: true,
      hostName: "devbox",
    });
  });

  it("follows OpenSSH: the first value wins across matching blocks, keys add up, the typed user wins", () => {
    const target = resolveWith(
      [
        "User fromtop",
        "Host dev*",
        "  Port 2200",
        "  IdentityFile ~/.ssh/a",
        "Host devbox",
        "  Port 2222",
        "  User you",
        "  IdentityFile ~/.ssh/b",
        "Host *",
        "  IdentitiesOnly no",
        "",
      ].join("\n"),
      "me@devbox",
    );
    expect(target).toMatchObject({
      user: "me",
      port: 2200,
      identitiesOnly: false,
      identityFiles: [join(world.home, ".ssh", "a"), join(world.home, ".ssh", "b")],
    });
    expect(resolveWith("User fromtop\nHost devbox\n  User you\n")).toMatchObject({
      user: "fromtop",
    });
  });

  it("matches host patterns as OpenSSH does: wildcards, negation, case", () => {
    expect(hostLineMatches(["dev*"], "devbox")).toBe(true);
    expect(hostLineMatches(["d?vbox"], "devbox")).toBe(true);
    expect(hostLineMatches(["DEVBOX"], "devbox")).toBe(true);
    expect(hostLineMatches(["*", "!devbox"], "devbox")).toBe(false);
    expect(hostLineMatches(["!devbox"], "other")).toBe(false);
    expect(hostLineMatches(["dev.box"], "devxbox")).toBe(false);
    expect(hostLineMatches(["other", "devbox"], "devbox")).toBe(true);
  });

  it("matches a pattern of several wildcards in bounded time, with the same answers", () => {
    // A pattern that does not match, whose wildcards a backtracking match would try every way to place.
    const started = Date.now();
    expect(hostLineMatches(["*a*a*a*a*a*b"], "a".repeat(80))).toBe(false);
    expect(hostLineMatches(["!*a*a*a*a*a*b", "*"], "a".repeat(80))).toBe(true);
    expect(Date.now() - started).toBeLessThan(200);
    for (const [pattern, name, matches] of [
      ["*a*a*a*a*a*b", "a".repeat(80) + "b", true],
      ["*box", "devbox", true],
      ["*box", "devboxes", false],
      ["d*v*x", "devbox", true],
      ["d*v*x?", "devbox", false],
      ["??????", "devbox", true],
      ["?????", "devbox", false],
      ["**", "", true],
      ["Dev*.EXAMPLE", "devbox.example", true],
      ["dev*.example", "devbox.example.org", false],
    ] as const) {
      expect(hostLineMatches([pattern], name), `${pattern} ${name}`).toBe(matches);
    }
  });

  it("accepts the Key=Value form and quoted values", () => {
    expect(
      resolveWith('Host devbox\n  HostName=devbox.example\n  IdentityFile "~/.ssh/my key"\n'),
    ).toMatchObject({
      hostName: "devbox.example",
      identityFiles: [join(world.home, ".ssh", "my key")],
    });
  });

  it("follows an Include outside any block, with a pattern in its last part", () => {
    mkdirSync(join(world.home, ".ssh", "config.d"), { recursive: true });
    writeFileSync(join(world.home, ".ssh", "config.d", "10-dev"), "Host devbox\n  Port 2201\n");
    writeFileSync(join(world.home, ".ssh", "config.d", "20-other"), "Host other\n  Port 9\n");
    expect(resolveWith("Include config.d/*\nHost devbox\n  Port 2222\n")).toMatchObject({
      port: 2201,
    });
    expect(resolveWith("Include ~/.ssh/config.d/10-dev\n")).toMatchObject({ port: 2201 });
    // A missing included file is skipped, as OpenSSH does.
    expect(resolveWith("Include config.d/none\n")).toMatchObject({ ok: true, port: 22 });
  });

  it("honors IdentityAgent as the person set it, off included, and refuses one it can't name", () => {
    expect(resolveWith("Host devbox\n  IdentityAgent none\n")).toMatchObject({
      identityAgent: "none",
    });
    expect(resolveWith("Host devbox\n  IdentityAgent SSH_AUTH_SOCK\n")).toMatchObject({
      identityAgent: "world",
    });
    expect(resolveWith("Host devbox\n  Port 22\n")).toMatchObject({ identityAgent: "world" });
    expect(
      resolveWith('Host devbox\n  IdentityAgent "~/Library/Group Containers/agent.sock"\n'),
    ).toMatchObject({
      identityAgent: { socket: `${world.home}/Library/Group Containers/agent.sock` },
    });
    for (const line of [
      "IdentityAgent $SSH_AUTH_SOCK",
      "IdentityAgent /srv/elsewhere.sock",
      "IdentityAgent agent.sock",
    ]) {
      expect(resolveWith(`Host devbox\n  ${line}\n`), line).toMatchObject({
        ok: false,
        category: "invalid-value",
        setting: "IdentityAgent",
      });
    }
  });

  it("honors PubkeyAuthentication as the person set it, off included", () => {
    expect(resolveWith("Host devbox\n  PubkeyAuthentication no\n")).toMatchObject({
      pubkeyAuthentication: "no",
    });
    expect(resolveWith("Host devbox\n  PubkeyAuthentication host-bound\n")).toMatchObject({
      pubkeyAuthentication: "host-bound",
    });
    expect(resolveWith("Host devbox\n  Port 22\n")).toMatchObject({ pubkeyAuthentication: null });
    expect(resolveWith("Host devbox\n  PubkeyAuthentication maybe\n")).toMatchObject({
      ok: false,
      setting: "PubkeyAuthentication",
    });
  });

  it("refuses a key, certificate or Include that a link leads out of the home folder", () => {
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "id"), "");
    writeFileSync(join(outside, "conf"), "Host devbox\n  Port 2222\n");
    symlinkSync(outside, join(world.home, "out"), "dir");
    try {
      for (const setting of ["IdentityFile", "CertificateFile"]) {
        expect(resolveWith(`Host devbox\n  ${setting} ~/out/id\n`), setting).toMatchObject({
          ok: false,
          category: "invalid-value",
          setting,
        });
      }
      expect(resolveWith("Include ~/out/conf\n")).toMatchObject({
        ok: false,
        category: "invalid-value",
        setting: "Include",
      });
      // A pattern's match that is a link out of the home folder: the Include is refused.
      mkdirSync(join(world.home, ".ssh", "linked.d"), { recursive: true });
      writeFileSync(join(world.home, ".ssh", "linked.d", "10.conf"), "Host devbox\n  Port 2201\n");
      symlinkSync(join(outside, "conf"), join(world.home, ".ssh", "linked.d", "20.conf"));
      expect(resolveWith("Include ~/.ssh/linked.d/*.conf\n")).toMatchObject({
        ok: false,
        category: "invalid-value",
        setting: "Include",
      });
      rmSync(join(world.home, ".ssh", "linked.d", "20.conf"));
      expect(resolveWith("Include ~/.ssh/linked.d/*.conf\n")).toMatchObject({
        ok: true,
        port: 2201,
      });
      // Spelled outside but walked inside is inside: a link into the home folder is fine.
      symlinkSync(join(world.home, ".ssh"), join(outside, "back"), "dir");
      expect(resolveWith(`Host devbox\n  IdentityFile ~/out/back/id\n`)).toMatchObject({
        ok: true,
      });
    } finally {
      rmSync(join(world.home, "out"));
    }
  });

  it.skipIf(process.platform === "win32")(
    "refuses a key whose .pub or -cert.pub beside it a link leads out of the home folder",
    () => {
      const outside = join(root, "outside-companions");
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "sentinel"), "not a key\n");
      const key = join(world.home, ".ssh", "companion");
      writeFileSync(key, "");
      try {
        for (const suffix of [".pub", "-cert.pub"]) {
          symlinkSync(join(outside, "sentinel"), key + suffix);
          try {
            // The key itself is an ordinary file in the home; what OpenSSH reads beside it is not.
            expect(
              resolveWith("Host devbox\n  IdentityFile ~/.ssh/companion\n"),
              suffix,
            ).toMatchObject({
              ok: false,
              category: "invalid-value",
              setting: "IdentityFile",
            });
            // The default key names are checked the same way.
            symlinkSync(key, join(world.home, ".ssh", "id_ed25519"));
            symlinkSync(join(outside, "sentinel"), join(world.home, ".ssh", "id_ed25519" + suffix));
            expect(resolveWith("Host devbox\n  HostName devbox.example\n"), suffix).toMatchObject({
              ok: false,
              category: "invalid-value",
              setting: "IdentityFile",
            });
          } finally {
            for (const path of [key + suffix, join(world.home, ".ssh", "id_ed25519" + suffix)]) {
              rmSync(path, { force: true });
            }
            rmSync(join(world.home, ".ssh", "id_ed25519"), { force: true });
          }
        }
        // With nothing beside it, the same key is taken.
        expect(resolveWith("Host devbox\n  IdentityFile ~/.ssh/companion\n")).toMatchObject({
          ok: true,
          identityFiles: [key],
        });
      } finally {
        rmSync(key, { force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "refuses a configuration, or an Include's folder, that is there but can't be read",
    () => {
      const locked = join(world.home, ".ssh", "locked");
      mkdirSync(locked, { recursive: true });
      writeFileSync(join(locked, "config"), "Host devbox\n  Port 2222\n");
      writeFileSync(join(locked, "part.conf"), "Host devbox\n  Port 2222\n");
      chmodSync(locked, 0o000);
      try {
        // The file is there, behind a folder this account may not search: not "no settings".
        expect(
          resolveTarget(
            { ...world, personConfig: join(locked, "config") },
            parseDestination("devbox")!,
          ),
        ).toMatchObject({ ok: false, category: "unreadable" });
        expect(resolveWith("Include ~/.ssh/locked/*.conf\n")).toMatchObject({
          ok: false,
          category: "unreadable",
        });
        // A path that isn't there is still no settings.
        expect(
          resolveTarget(
            { ...world, personConfig: join(world.home, ".ssh", "absent", "config") },
            parseDestination("devbox")!,
          ),
        ).toMatchObject({ ok: true, port: 22 });
        expect(resolveWith("Include ~/.ssh/absent/*.conf\n")).toMatchObject({ ok: true, port: 22 });
      } finally {
        chmodSync(locked, 0o700);
        rmSync(locked, { recursive: true, force: true });
      }
    },
  );

  it("does not follow an Include out of the home folder, and names the Include", () => {
    expect(resolveWith("Include /etc/ssh/ssh_config\n")).toMatchObject({
      ok: false,
      category: "invalid-value",
      setting: "Include",
      title: "Clawtrate can't use Include in the SSH settings for devbox.",
    });
  });

  it("reads a relative Include from the SSH configuration folder, as OpenSSH does, even from a file that was itself included", () => {
    // ~/.ssh/config includes conf.d/main; conf.d/main includes `extra` relatively, which OpenSSH
    // reads as ~/.ssh/extra, never ~/.ssh/conf.d/extra.
    mkdirSync(join(world.home, ".ssh", "conf.d"), { recursive: true });
    writeFileSync(join(world.home, ".ssh", "conf.d", "main"), "Include extra\n");
    writeFileSync(join(world.home, ".ssh", "conf.d", "extra"), "Host devbox\n  Port 2200\n");
    writeFileSync(join(world.home, ".ssh", "extra"), "Host devbox\n  HostKeyAlias other\n");
    try {
      expect(resolveWith("Include conf.d/main\n")).toMatchObject({
        ok: false,
        category: "host-key",
        setting: "HostKeyAlias",
      });
    } finally {
      rmSync(join(world.home, ".ssh", "conf.d"), { recursive: true, force: true });
      rmSync(join(world.home, ".ssh", "extra"), { force: true });
    }
  });

  it("refuses an Include with tokens, variables or more than one path by the name Include", () => {
    for (const line of [
      "Include %d/.ssh/extra",
      "Include ${HOME}/x",
      "Include a b",
      'Include "a" b',
    ])
      expect(resolveWith(`${line}\n`), line).toMatchObject({
        ok: false,
        setting: "Include",
        title: "Clawtrate can't use Include in the SSH settings for devbox.",
      });
  });

  it.each([
    [
      "ProxyJump",
      "ProxyJump bastion.example",
      "jump-host",
      "The SSH settings for devbox include ProxyJump.",
    ],
    [
      "ProxyCommand",
      "ProxyCommand nc %h %p",
      "jump-host",
      "The SSH settings for devbox include ProxyCommand.",
    ],
    ["LocalCommand", "LocalCommand touch x", "command-or-forward", null],
    ["PermitLocalCommand", "PermitLocalCommand yes", "command-or-forward", null],
    ["RemoteCommand", "RemoteCommand tmux attach", "command-or-forward", null],
    ["LocalForward", "LocalForward 8080 127.0.0.1:80", "command-or-forward", null],
    ["RemoteForward", "RemoteForward 9000 127.0.0.1:9000", "command-or-forward", null],
    ["DynamicForward", "DynamicForward 1080", "command-or-forward", null],
    ["SendEnv", "SendEnv LANG", "command-or-forward", null],
    ["SetEnv", "SetEnv FOO=bar", "command-or-forward", null],
    ["ForwardAgent", "ForwardAgent yes", "command-or-forward", null],
    ["ForwardX11", "ForwardX11 yes", "command-or-forward", null],
    ["ControlMaster", "ControlMaster auto", "command-or-forward", null],
    ["ControlPath", "ControlPath ~/.ssh/cm-%C", "command-or-forward", null],
    ["Include", "Include other", "command-or-forward", null],
    [
      "StrictHostKeyChecking",
      "StrictHostKeyChecking no",
      "host-key",
      "Clawtrate can't use StrictHostKeyChecking in the SSH settings for devbox.",
    ],
    ["UserKnownHostsFile", "UserKnownHostsFile /dev/null", "host-key", null],
    ["GlobalKnownHostsFile", "GlobalKnownHostsFile none", "host-key", null],
    ["KnownHostsCommand", "KnownHostsCommand /bin/true", "host-key", null],
    ["UpdateHostKeys", "UpdateHostKeys yes", "host-key", null],
    ["HostKeyAlias", "HostKeyAlias other", "host-key", null],
    ["VerifyHostKeyDNS", "VerifyHostKeyDNS yes", "host-key", null],
    ["RevokedHostKeys", "RevokedHostKeys ~/.ssh/revoked", "host-key", null],
    // These change key checking, the address chosen or how this account signs in: never dropped.
    ["HostKeyAlgorithms", "HostKeyAlgorithms ssh-rsa", "host-key", null],
    ["CheckHostIP", "CheckHostIP yes", "host-key", null],
    ["AddressFamily", "AddressFamily inet6", "unsupported", null],
    ["PreferredAuthentications", "PreferredAuthentications password", "unsupported", null],
    ["PasswordAuthentication", "PasswordAuthentication yes", "unsupported", null],
    ["GSSAPIAuthentication", "GSSAPIAuthentication yes", "unsupported", null],
  ])("refuses %s in a matching block, by name", (setting, line, category, title) => {
    const refusal = resolveWith(`Host devbox\n  HostName devbox.example\n  ${line}\n`);
    expect(refusal).toMatchObject({ ok: false, kind: "refused", category, setting });
    // The note names the actual setting, whatever its group.
    expect(refusal).toMatchObject({
      title: title ?? `Clawtrate can't use ${setting} in the SSH settings for devbox.`,
    });
    // The same setting in a block that doesn't match is not the route's concern.
    if (setting !== "Include") {
      expect(resolveWith(`Host other\n  ${line}\nHost devbox\n  Port 2222\n`)).toMatchObject({
        ok: true,
      });
    }
  });

  it("refuses a refused setting that applies to every host", () => {
    expect(resolveWith("Host *\n  ForwardAgent yes\n")).toMatchObject({
      ok: false,
      setting: "ForwardAgent",
    });
    expect(resolveWith("ProxyJump bastion.example\n")).toMatchObject({
      ok: false,
      setting: "ProxyJump",
    });
  });

  it("refuses any Match, whose conditions can't be evaluated without running them", () => {
    expect(resolveWith('Host devbox\n  Port 2222\nMatch exec "true"\n  User root\n')).toMatchObject(
      {
        ok: false,
        category: "command-or-forward",
        setting: "Match",
        title: "Clawtrate can't use Match in the SSH settings for devbox.",
        sentence: "Use a plain SSH alias or Advanced.",
      },
    );
  });

  it("refuses a setting it does not know, by name", () => {
    expect(resolveWith("Host devbox\n  CanonicalizeHostname yes\n")).toMatchObject({
      ok: false,
      category: "unsupported",
      setting: "CanonicalizeHostname",
    });
  });

  it("leaves out settings that run nothing and don't touch the key check", () => {
    expect(
      resolveWith(
        "Host devbox\n  AddKeysToAgent yes\n  ServerAliveInterval 5\n  Compression yes\n  Port 2222\n",
      ),
    ).toMatchObject({ ok: true, port: 2222 });
  });

  it.each([
    ["a percent token in HostName", "HostName %h.example", "HostName"],
    ["a variable in IdentityFile", "IdentityFile ${HOME}/.ssh/id", "IdentityFile"],
    ["a token in IdentityFile", "IdentityFile ~/.ssh/id_%r", "IdentityFile"],
    ["a key outside the home folder", "IdentityFile /etc/ssh/ssh_host_ed25519_key", "IdentityFile"],
    ["a key climbing out of the home folder", "IdentityFile ~/../other/.ssh/id", "IdentityFile"],
    ["a relative key", "IdentityFile id_ed25519", "IdentityFile"],
    ["another user's home", "IdentityFile ~root/.ssh/id", "IdentityFile"],
    ["a port out of range", "Port 70000", "Port"],
    ["a port with letters", "Port 22x", "Port"],
    ["a user with a dash first", "User -oProxyCommand=x", "User"],
    ["a host name with a dash first", "HostName -oProxyCommand=x", "HostName"],
    ["a host name with spaces", "HostName devbox -p 1", "HostName"],
    ["an IdentitiesOnly that isn't yes or no", "IdentitiesOnly maybe", "IdentitiesOnly"],
    ["an unbalanced quote", 'IdentityFile "~/.ssh/id', "IdentityFile"],
    ["a quote inside a value", 'IdentityFile ~/.ssh/i"d', "IdentityFile"],
    ["a backslash", "IdentityFile ~/.ssh/a\\b", "IdentityFile"],
  ])("refuses %s", (_name, line, setting) => {
    expect(resolveWith(`Host devbox\n  ${line}\n`)).toMatchObject({
      ok: false,
      category: "invalid-value",
      setting,
    });
  });

  it("refuses a file it can't read as SSH configuration", () => {
    expect(resolveWith("Host devbox\n  !!!\n")).toMatchObject({
      ok: false,
      category: "unreadable",
    });
    expect(resolveWith("Host 'devbox'\n")).toMatchObject({ ok: false, category: "unreadable" });
    writeFileSync(world.personConfig, "#".repeat(300 * 1024));
    expect(resolveTarget(world, parseDestination("devbox")!)).toMatchObject({
      ok: false,
      category: "unreadable",
    });
  });

  it("refuses an Include loop instead of following it for ever", () => {
    writeFileSync(join(world.home, ".ssh", "loop"), "Include loop\n");
    expect(resolveWith("Include loop\n")).toMatchObject({ ok: false, category: "unreadable" });
  });
});

const target = (overrides: Partial<Target> = {}): Target => ({
  ok: true,
  destination: parseDestination("devbox")!,
  name: "devbox",
  hostName: "devbox.example",
  user: "you",
  port: 22,
  identityFiles: [],
  identitiesOnly: null,
  certificateFiles: [],
  identityAgent: "world",
  pubkeyAuthentication: null,
  ...overrides,
});

/** The alias of route 1 to the default target's endpoint. */
const A1 = routeAlias("1", "you@[devbox.example]:22");

describe("the configuration the host writes", () => {
  it("is one directive per line, with its fixed options and no forwards", () => {
    const text = routeConfigText(
      "1",
      target({
        identityFiles: ["/srv/you/.ssh/id_ed25519"],
        identitiesOnly: true,
        certificateFiles: ["/srv/you/.ssh/id_ed25519-cert.pub"],
      }),
      { ...world, agent: { socket: "/srv/agent.sock" } },
      "/srv/app/known_hosts",
    );
    expect(text).toBe(
      [
        `Host ${A1}`,
        "  HostName devbox.example",
        "  User you",
        "  Port 22",
        '  IdentityFile "/srv/you/.ssh/id_ed25519"',
        "  IdentitiesOnly yes",
        '  CertificateFile "/srv/you/.ssh/id_ed25519-cert.pub"',
        `  HostKeyAlias ${A1}`,
        '  UserKnownHostsFile "/srv/app/known_hosts"',
        "  GlobalKnownHostsFile none",
        "  StrictHostKeyChecking yes",
        "  UpdateHostKeys no",
        "  BatchMode yes",
        "  ConnectTimeout 10",
        "  ServerAliveInterval 15",
        "  ServerAliveCountMax 3",
        "  ExitOnForwardFailure yes",
        "  ClearAllForwardings yes",
        "  ForwardAgent no",
        "  ForwardX11 no",
        "  PermitLocalCommand no",
        "  ControlMaster no",
        "  ControlPath none",
        "  RequestTTY no",
        '  IdentityAgent "/srv/agent.sock"',
        "",
      ].join("\n"),
    );
    expect(text).not.toMatch(
      /Forward [0-9]|LocalForward|RemoteForward|DynamicForward|ProxyCommand|ProxyJump/,
    );
  });

  it("writes the agent the app chose, or the person's, and PubkeyAuthentication as set", () => {
    const sock = { ...world, agent: { socket: "/srv/agent.sock" } } as const;
    expect(routeConfigText("1", target(), sock, "/srv/kh")).toContain(
      '\n  IdentityAgent "/srv/agent.sock"\n',
    );
    expect(routeConfigText("1", target({ identityAgent: "none" }), sock, "/srv/kh")).toContain(
      "\n  IdentityAgent none\n",
    );
    expect(
      routeConfigText(
        "1",
        target({ identityAgent: { socket: "/srv/you/1p.sock" } }),
        world,
        "/srv/kh",
      ),
    ).toContain('\n  IdentityAgent "/srv/you/1p.sock"\n');
    expect(
      routeConfigText("1", target({ pubkeyAuthentication: "no" }), world, "/srv/kh"),
    ).toContain("\n  PubkeyAuthentication no\n");
    expect(routeConfigText("1", target(), world, "/srv/kh")).not.toContain("PubkeyAuthentication");
    expect(
      routeConfigText("1", target(), { ...world, agent: "windows-pipe" }, "/srv/kh"),
    ).not.toContain("IdentityAgent");
  });

  it("adds IdentityAgent none when the world has no agent", () => {
    expect(routeConfigText("1", target(), world, "/srv/app/known_hosts")).toContain(
      "\n  IdentityAgent none\n",
    );
  });

  it("looks up prior trust with the person's known-hosts file and without the route's alias", () => {
    const text = routeConfigText("1", target(), world, "/srv/app/known_hosts", "lookup");
    expect(text).not.toContain("HostKeyAlias");
    expect(text).toContain(`  UserKnownHostsFile "${world.personKnownHosts}"\n`);
    expect(text).toContain("  StrictHostKeyChecking yes\n");
  });

  it("quotes every path, writes Windows paths with forward slashes, and refuses anything ssh would expand", () => {
    expect(pathValue("/srv/Application Support/known_hosts", "darwin")).toBe(
      '"/srv/Application Support/known_hosts"',
    );
    expect(pathValue("/srv/Jane O'Neil (Work) & Co, #1/kh", "darwin")).toBe(
      `"/srv/Jane O'Neil (Work) & Co, #1/kh"`,
    );
    expect(pathValue("C:\\ProgramData\\Clawtrate\\known_hosts", "win32")).toBe(
      '"C:/ProgramData/Clawtrate/known_hosts"',
    );
    for (const bad of [
      "/srv/%d/known_hosts",
      "/srv/${HOME}/kh",
      "~/kh",
      '/srv/a"b',
      "/srv/a\nHost x",
      "/srv/a\\b",
      "relative/kh",
      "/srv/trailing ",
    ]) {
      expect(() => pathValue(bad, "linux"), bad).toThrow();
    }
  });

  it("refuses a route id, host, user or port that isn't valid", () => {
    expect(() => routeConfigText("A-1", target(), world, "/srv/kh")).toThrow();
    expect(() =>
      routeConfigText("1", target({ hostName: "-oProxyCommand=x" }), world, "/srv/kh"),
    ).toThrow();
    expect(() => routeConfigText("1", target({ user: "a b" }), world, "/srv/kh")).toThrow();
    expect(() => routeConfigText("1", target({ port: 0 }), world, "/srv/kh")).toThrow();
  });

  it.skipIf(!existsSync(SSH))(
    "names its keys explicitly, so ssh adds none of the account's own and uses no agent",
    () => {
      const dir = join(root, "explicit");
      mkdirSync(dir, { recursive: true });
      const home = userInfo().homedir;
      for (const [name, identityFiles] of [
        ["none", []],
        ["one", [join(dir, "id_ed25519")]],
      ] as const) {
        const file = join(dir, `${name}.conf`);
        writeFileSync(
          file,
          routeConfigText(
            "1",
            target({ identityFiles: [...identityFiles] }),
            world,
            join(dir, "kh"),
          ),
        );
        // `-G` on the host's own file only: no Match in it, nothing evaluated, no connection.
        const run = spawnSync(SSH, ["-G", "-F", file, "--", A1], {
          env: testEnv(),
          encoding: "utf8",
        });
        expect(run.status).toBe(0);
        const lines = run.stdout.split("\n");
        expect(lines.filter((line) => line.startsWith("identityfile "))).toEqual(
          identityFiles.length
            ? identityFiles.map((path) => `identityfile ${path}`)
            : ["identityfile none"],
        );
        expect(lines).toContain("identityagent none");
        // No path of any home's .ssh, spelled with `~` or in full, beyond the keys named.
        const homeSsh = lines.filter(
          (line) =>
            line.includes("~/.ssh") || line.includes(join(home, ".ssh")) || line.includes("/.ssh/"),
        );
        expect(homeSsh, name).toEqual([]);
      }
    },
  );

  it("names OpenSSH's default keys of the world's home when the configuration names none", () => {
    writeFileSync(join(world.home, ".ssh", "id_ed25519"), "");
    writeFileSync(join(world.home, ".ssh", "id_rsa"), "");
    try {
      expect(resolveWith("Host devbox\n  HostName devbox.example\n")).toMatchObject({
        identityFiles: [`${world.home}/.ssh/id_rsa`, `${world.home}/.ssh/id_ed25519`],
      });
      // Named ones replace the defaults.
      expect(resolveWith("Host devbox\n  IdentityFile ~/.ssh/work\n")).toMatchObject({
        identityFiles: [`${world.home}/.ssh/work`],
      });
    } finally {
      rmSync(join(world.home, ".ssh", "id_ed25519"));
      rmSync(join(world.home, ".ssh", "id_rsa"));
    }
    expect(resolveWith("Host devbox\n  HostName devbox.example\n")).toMatchObject({
      identityFiles: [],
    });
  });

  it.skipIf(!existsSync(SSH))(
    "reads back in ssh whole a path with spaces and a profile name's other characters, the capture's included",
    () => {
      const dir = join(root, "Jane O'Neil (Work) & Co, #1 [é]=b+c!~");
      mkdirSync(dir, { recursive: true });
      for (const purpose of ["normal", "capture"] as const) {
        const file = join(dir, `${purpose}.conf`);
        writeFileSync(
          file,
          routeConfigText(
            "1",
            target({ identityFiles: [join(dir, "my key")] }),
            world,
            join(dir, "known hosts"),
            purpose,
          ),
        );
        const run = spawnSync(SSH, ["-G", "-F", file, "--", A1], {
          env: testEnv(),
          encoding: "utf8",
        });
        expect(run.status).toBe(0);
        expect(run.stdout).toContain(`\nidentityfile ${join(dir, "my key")}\n`);
        expect(run.stdout).toContain(`\nuserknownhostsfile ${join(dir, "known hosts")}\n`);
        expect(run.stdout).toContain(
          purpose === "capture"
            ? "\nstricthostkeychecking accept-new\n"
            : "\nstricthostkeychecking true\n",
        );
      }
    },
  );

  it("takes a key path with a profile name's characters from the person's configuration", () => {
    expect(
      resolveWith(`Host devbox\n  IdentityFile "~/.ssh/Jane O'Neil (Work) & Co, #1"\n`),
    ).toMatchObject({
      ok: true,
      identityFiles: [`${world.home}/.ssh/Jane O'Neil (Work) & Co, #1`],
    });
  });

  it.skipIf(!existsSync(SSH))(
    "reads back in ssh as written: each value whole, spaces included",
    () => {
      const dir = join(root, "with space");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "route.conf");
      writeFileSync(
        file,
        routeConfigText(
          "7",
          target({ identityFiles: [join(dir, "my key")], hostName: "198.51.100.7", port: 2222 }),
          world,
          join(dir, "known_hosts"),
        ),
      );
      // `-G` on the host's own file only: it holds no Match, so nothing is evaluated or run.
      const run = spawnSync(
        SSH,
        ["-G", "-F", file, "--", routeAlias("7", "you@[198.51.100.7]:2222")],
        {
          env: testEnv(),
          encoding: "utf8",
        },
      );
      expect(run.status).toBe(0);
      const settings = new Map(
        run.stdout
          .split("\n")
          .map((line) => [line.slice(0, line.indexOf(" ")), line.slice(line.indexOf(" ") + 1)]),
      );
      expect(settings.get("hostname")).toBe("198.51.100.7");
      expect(settings.get("port")).toBe("2222");
      expect(settings.get("identityfile")).toBe(join(dir, "my key"));
      expect(settings.get("userknownhostsfile")).toBe(join(dir, "known_hosts"));
      expect(settings.get("hostkeyalias")).toBe(routeAlias("7", "you@[198.51.100.7]:2222"));
      expect(settings.get("stricthostkeychecking")).toBe("true");
      expect(settings.get("clearallforwardings")).toBe("yes");
      expect(settings.get("identityagent")).toBe("none");
      expect(settings.get("controlmaster")).toBe("false");
      expect(settings.get("batchmode")).toBe("yes");
    },
  );
});
