import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accountStoreProblems } from "../src/account-stores.ts";
import {
  accountOfCredential,
  accountProfiles,
  credentialFor,
  profileEntryProblem,
  profileHash,
  saveAccountCommand,
  SCRIPTED_ACCOUNTS,
} from "../src/accounts.ts";
import {
  devConfig,
  lockOrder,
  LOOPBACK_PROXIES,
  main,
  openInstance,
  PLUGIN_RULE,
  recordedStartOptions,
  sandboxProblems,
  start,
} from "../src/cli.ts";
import { loadDevPlugin, manifestProviderProblems, pluginEntry } from "../src/dev-plugins.ts";
import { CHECKOUT_DIR } from "../src/env.ts";
import { startFakeProvider } from "../src/fake-provider.ts";
import { ScriptedAccounts } from "../src/scripted-accounts.ts";
import type { InstancePorts } from "../src/registry.ts";

const temps: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

function temp(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "clawtrate-accounts-")));
  temps.push(dir);
  return dir;
}

const PORTS: InstancePorts = { gatewayPort: 19240, providerPort: 19250 };
const STATE = "/state/.openclaw-clawtrate-dev-accounts";
const ACCOUNTS = { accounts: true } as const;
const withAccounts = () => devConfig("token", PORTS, STATE, [], ACCOUNTS);
const problems = (config: unknown) => sandboxProblems(config, PORTS, STATE, [], ACCOUNTS);

describe("scripted accounts", () => {
  it("name their account in a made-up credential, and only theirs", () => {
    const key = credentialFor("api_key", "acme", "work");
    expect(key).toBe("clawtrate-dev-key.acme.work");
    expect(accountOfCredential(`Bearer ${key}`)).toEqual({ account: "acme:work", kind: "api_key" });
    expect(accountOfCredential(credentialFor("oauth", "acme", "travel", 3))).toEqual({
      account: "acme:travel",
      kind: "oauth",
    });
    expect(accountOfCredential(credentialFor("token", "globex", "team"))?.kind).toBe("token");
    for (const other of [
      undefined,
      "",
      "Bearer scripted-dev-provider",
      "clawtrate-dev-key.acme",
      "clawtrate-dev-key.Acme.work",
    ]) {
      expect(accountOfCredential(other)).toBeNull();
    }
    expect(() => credentialFor("api_key", "acme", "../x")).toThrow(/not a scripted account/);
  });

  it("are named in the gateway's log as twelve hex digits of their id's SHA-256", () => {
    expect(profileHash("acme:work")).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(profileHash("acme:work")).not.toBe(profileHash("acme:home"));
  });

  it("start with two acme accounts and one globex account shared, and one kept by otto", () => {
    expect(SCRIPTED_ACCOUNTS.map((a) => [a.id, a.label, a.kind, a.store])).toEqual([
      ["acme:work", "Work", "api_key", { shared: true }],
      ["acme:home", "Home", "api_key", { shared: true }],
      ["globex:team", "Team", "token", { shared: true }],
      ["acme:studio", "Studio", "api_key", { bot: "otto" }],
    ]);
  });

  it("are saved by the gateway's own command line, the credential on stdin, never in the arguments", () => {
    for (const account of SCRIPTED_ACCOUNTS) {
      const { args, stdin } = saveAccountCommand(account);
      expect(args.join(" ")).not.toContain("clawtrate-dev-");
      expect(stdin).toBe(`${credentialFor(account.kind, account.provider, account.name)}\n`);
      expect(args).toContain("bot" in account.store ? account.store.bot : "main");
    }
    expect(saveAccountCommand(SCRIPTED_ACCOUNTS[2]!).args.slice(0, 3)).toEqual([
      "models",
      "auth",
      "paste-token",
    ]);
  });
});

describe("the closed contract with accounts", () => {
  it("accepts the generated config, and what the gateway writes about scripted accounts", () => {
    expect(problems(withAccounts())).toEqual([]);
    const config = withAccounts() as unknown as {
      auth: { profiles: Record<string, unknown>; order?: unknown };
    };
    // A sign-in's profile, a label written later, and an order a sign-in wrote.
    config.auth.profiles["acme:travel"] = {
      provider: "acme",
      mode: "oauth",
      email: "travel@acme.example",
    };
    (config.auth.profiles["acme:work"] as Record<string, unknown>).displayName = "Office";
    config.auth.order = { acme: ["acme:travel", "acme:work"] };
    expect(problems(config)).toEqual([]);
  });

  it("puts every account provider on the instance's own scripted model, with no key", () => {
    const providers = withAccounts().models.providers as Record<
      string,
      { baseUrl: string; apiKey?: string }
    >;
    for (const id of ["acme", "globex"]) {
      expect(providers[id]!.baseUrl).toBe("http://127.0.0.1:19250/v1");
      expect(providers[id]!.apiKey).toBeUndefined();
    }
    expect((withAccounts() as { logging?: { file: string } }).logging?.file).toBe(
      `${STATE}/logs/gateway.jsonl`,
    );
  });

  it("refuses a profile of any other provider, shape or kind", () => {
    const refused: [string, unknown][] = [
      ["openai:work", { provider: "openai", mode: "api_key" }],
      ["acme:work", { provider: "globex", mode: "api_key" }],
      ["acme:work", { provider: "acme", mode: "aws-sdk" }],
      ["acme:work", { provider: "acme", mode: "api_key", apiKey: "x" }],
      ["acme:work", { provider: "acme", mode: "api_key", displayName: "a\nb" }],
      ["acme:../x", { provider: "acme", mode: "api_key" }],
      // A value of the wrong type is refused before its value is looked at.
      ["acme:work", { provider: "acme", mode: ["api_key"] }],
      ["acme:work", { provider: "acme", mode: ["token"] }],
      ["acme:work", { provider: "acme", mode: ["oauth"] }],
      ["acme:work", { provider: ["acme"], mode: "api_key" }],
      ["acme:work", { provider: "acme", mode: "api_key", displayName: ["Work"] }],
    ];
    for (const [id, entry] of refused) {
      const config = withAccounts() as unknown as { auth: { profiles: Record<string, unknown> } };
      config.auth.profiles[id] = entry;
      expect(problems(config), JSON.stringify([id, entry])).toEqual([
        expect.stringMatching(/^auth\.profiles must be scripted account profiles, found /),
      ]);
      expect(profileEntryProblem(id, entry)).not.toBeNull();
    }
  });

  it("refuses an order naming another provider's account, and any other auth key", () => {
    const config = withAccounts() as unknown as { auth: Record<string, unknown> };
    config.auth.order = { acme: ["openai:work"] };
    expect(problems(config)[0]).toMatch(/^auth\.order must be orders of scripted accounts/);
    config.auth.order = { openai: ["openai:work"] };
    expect(problems(config)[0]).toMatch(/^auth\.order must be orders of scripted accounts/);
    config.auth.order = { acme: [["acme:work"]] };
    expect(problems(config)[0]).toMatch(/^auth\.order must be orders of scripted accounts/);
    config.auth.order = { acme: "acme:work" };
    expect(problems(config)[0]).toMatch(/^auth\.order must be orders of scripted accounts/);
    delete config.auth.order;
    config.auth.cooldowns = {};
    expect(problems(config)).toEqual(["auth.cooldowns is not allowed"]);
  });

  it("refuses an account provider pointed anywhere but the scripted model, or given a key", () => {
    const moved = withAccounts() as unknown as {
      models: { providers: Record<string, Record<string, unknown>> };
    };
    moved.models.providers.acme!.baseUrl = "https://api.example.com/v1";
    expect(problems(moved)).toEqual([
      'models.providers.acme.baseUrl must be "http://127.0.0.1:19250/v1", found "https://api.example.com/v1"',
    ]);
    const keyed = withAccounts() as unknown as {
      models: { providers: Record<string, Record<string, unknown>> };
    };
    keyed.models.providers.globex!.apiKey = "clawtrate-dev-key.globex.team";
    expect(problems(keyed)).toEqual(["models.providers.globex.apiKey is not allowed"]);
  });

  it("keeps accounts out of an instance started without them", () => {
    expect(sandboxProblems(withAccounts(), PORTS, STATE)).toEqual(
      expect.arrayContaining([
        "models.providers.acme is not allowed",
        "auth is not allowed",
        "logging is not allowed",
      ]),
    );
    expect(Object.keys(accountProfiles())).toEqual(SCRIPTED_ACCOUNTS.map((a) => a.id));
  });

  it("are refused on the default instance before anything is touched", async () => {
    const home = temp();
    await expect(
      start(openInstance(null, { home, runRoot: join(home, "run") }), ACCOUNTS),
    ).rejects.toThrow(/default instance never has scripted accounts/);
  });

  it("reads back only a record of start options it wrote", () => {
    const runDir = temp();
    expect(recordedStartOptions({ runDir })).toEqual({});
    for (const [text, ok] of [
      ['{"accounts":true}', true],
      ["{}", true],
      ['{"accounts":"yes"}', false],
      ['{"accounts":true,"plugins":[]}', false],
      ["[]", false],
      ['[{"accounts":true}]', false],
      ['{"accounts":[true]}', false],
    ] as const) {
      rmSync(join(runDir, "start-options.json"), { force: true });
      writeFileSync(join(runDir, "start-options.json"), text);
      if (ok) expect(recordedStartOptions({ runDir })).toEqual(JSON.parse(text));
      else expect(() => recordedStartOptions({ runDir })).toThrow(/not a record of start options/);
    }
  });
});

describe("local pairing at the gateway's default", () => {
  const DEFAULT_PAIRING = { defaultLocalPairing: true } as const;
  const config = () => devConfig("token", PORTS, STATE, [], DEFAULT_PAIRING);

  it("leaves autoApproveLocal unset, and only that", () => {
    const plain = devConfig("token", PORTS, STATE) as unknown as {
      gateway: Record<string, unknown>;
    };
    const left = config() as unknown as { gateway: Record<string, unknown> };
    expect(plain.gateway.nodes).toEqual({ pairing: { autoApproveLocal: false } });
    expect(left.gateway.nodes).toBeUndefined();
    const { nodes: _nodes, ...rest } = plain.gateway;
    expect(left.gateway).toEqual(rest);
    expect({ ...plain, gateway: undefined }).toEqual({ ...left, gateway: undefined });
  });

  it("is kept by the contract in both directions", () => {
    expect(sandboxProblems(config(), PORTS, STATE, [], DEFAULT_PAIRING)).toEqual([]);
    expect(sandboxProblems(config(), PORTS, STATE)).toEqual(["gateway.nodes is required"]);
    const approving = config() as unknown as { gateway: Record<string, unknown> };
    approving.gateway.nodes = { pairing: { autoApproveLocal: true } };
    expect(sandboxProblems(approving, PORTS, STATE, [], DEFAULT_PAIRING)).toEqual([
      "gateway.nodes is not allowed",
    ]);
    expect(sandboxProblems(approving, PORTS, STATE)).toEqual([
      "gateway.nodes.pairing.autoApproveLocal must be false, found true",
    ]);
  });

  it("is refused on the default instance before anything is touched", async () => {
    const home = temp();
    await expect(
      start(openInstance(null, { home, runRoot: join(home, "run") }), DEFAULT_PAIRING),
    ).rejects.toThrow(/default instance always requires explicit pairing/);
    expect(readdirSync(home)).toEqual([]);
  });

  it("is refused by every command but start and up", async () => {
    for (const command of ["status", "stop", "seed", "reset", "approve"]) {
      await expect(
        main([command, "--instance", "probe", "--default-local-pairing"], {}),
      ).rejects.toThrow(`--default-local-pairing is a start option; ${command} does not take it`);
    }
  });

  it("is read back from the record of start options", () => {
    const runDir = temp();
    for (const [text, ok] of [
      ['{"defaultLocalPairing":true}', true],
      ['{"accounts":true,"defaultLocalPairing":true}', true],
      ['{"defaultLocalPairing":"yes"}', false],
      ['{"defaultLocalPairing":true,"autoApproveLocal":true}', false],
    ] as const) {
      rmSync(join(runDir, "start-options.json"), { force: true });
      writeFileSync(join(runDir, "start-options.json"), text);
      if (ok) expect(recordedStartOptions({ runDir })).toEqual(JSON.parse(text));
      else expect(() => recordedStartOptions({ runDir })).toThrow(/not a record of start options/);
    }
  });
});

describe("a trusted loopback proxy", () => {
  const TRUSTING = { trustLoopbackProxy: true } as const;
  const config = () => devConfig("token", PORTS, STATE, [], TRUSTING);
  type Gateway = { gateway: Record<string, unknown> };

  it("sets trustedProxies to loopback, and only that", () => {
    const plain = devConfig("token", PORTS, STATE) as unknown as Gateway;
    const trusting = config() as unknown as Gateway;
    expect(plain.gateway.trustedProxies).toBeUndefined();
    expect(trusting.gateway.trustedProxies).toEqual(["127.0.0.1", "::1"]);
    expect(LOOPBACK_PROXIES).toEqual(["127.0.0.1", "::1"]);
    const { trustedProxies: _trusted, ...rest } = trusting.gateway;
    expect(rest).toEqual(plain.gateway);
    expect({ ...plain, gateway: undefined }).toEqual({ ...trusting, gateway: undefined });
  });

  it("keeps explicit pairing unless local pairing is also left at the default", () => {
    const both = devConfig("token", PORTS, STATE, [], {
      trustLoopbackProxy: true,
      defaultLocalPairing: true,
    }) as unknown as Gateway;
    expect((config() as unknown as Gateway).gateway.nodes).toEqual({
      pairing: { autoApproveLocal: false },
    });
    expect(both.gateway.nodes).toBeUndefined();
    expect(both.gateway.trustedProxies).toEqual(["127.0.0.1", "::1"]);
  });

  it("is kept by the contract in both directions", () => {
    expect(sandboxProblems(config(), PORTS, STATE, [], TRUSTING)).toEqual([]);
    expect(sandboxProblems(config(), PORTS, STATE)).toEqual([
      "gateway.trustedProxies is not allowed",
    ]);
    expect(sandboxProblems(devConfig("token", PORTS, STATE), PORTS, STATE, [], TRUSTING)).toEqual([
      "gateway.trustedProxies is required",
    ]);
    for (const wider of [
      ["0.0.0.0/0"],
      ["127.0.0.0/8", "::1"],
      ["127.0.0.1"],
      ["127.0.0.1", "::1", "198.51.100.0/24"],
      ["::1", "127.0.0.1"],
    ]) {
      const changed = config() as unknown as Gateway;
      changed.gateway.trustedProxies = wider;
      expect(sandboxProblems(changed, PORTS, STATE, [], TRUSTING)).toEqual([
        `gateway.trustedProxies must be exactly ["127.0.0.1","::1"], found ${JSON.stringify(wider)}`,
      ]);
    }
    const fallback = config() as unknown as Gateway;
    fallback.gateway.allowRealIpFallback = true;
    expect(sandboxProblems(fallback, PORTS, STATE, [], TRUSTING)).toEqual([
      "gateway.allowRealIpFallback is not allowed",
    ]);
  });

  it("is refused on the default instance before anything is touched", async () => {
    const home = temp();
    await expect(
      start(openInstance(null, { home, runRoot: join(home, "run") }), TRUSTING),
    ).rejects.toThrow(/default instance never trusts a proxy/);
    expect(readdirSync(home)).toEqual([]);
  });

  it("is refused by every command but start and up", async () => {
    for (const command of ["status", "stop", "seed", "reset", "approve"]) {
      await expect(
        main([command, "--instance", "probe", "--trust-loopback-proxy"], {}),
      ).rejects.toThrow(`--trust-loopback-proxy is a start option; ${command} does not take it`);
    }
  });

  it("is read back from the record of start options", () => {
    const runDir = temp();
    for (const [text, ok] of [
      ['{"trustLoopbackProxy":true}', true],
      ['{"defaultLocalPairing":true,"trustLoopbackProxy":true}', true],
      ['{"accounts":true,"defaultLocalPairing":true,"trustLoopbackProxy":true}', true],
      ['{"trustLoopbackProxy":"yes"}', false],
      ['{"trustLoopbackProxy":["127.0.0.1"]}', false],
      ['{"trustLoopbackProxy":true,"trustedProxies":["0.0.0.0/0"]}', false],
    ] as const) {
      rmSync(join(runDir, "start-options.json"), { force: true });
      writeFileSync(join(runDir, "start-options.json"), text);
      if (ok) expect(recordedStartOptions({ runDir })).toEqual(JSON.parse(text));
      else expect(() => recordedStartOptions({ runDir })).toThrow(/not a record of start options/);
    }
  });
});

describe("the sign-in plugin and the plugin rule", () => {
  it("loads the checkout's sign-in plugin with a path on the scripted model and sign-ins for acme only", () => {
    const plugin = loadDevPlugin("clawtrate-dev-signin", CHECKOUT_DIR, PLUGIN_RULE);
    expect([plugin.id, plugin.providers, plugin.tools]).toEqual([
      "clawtrate-dev-signin",
      ["acme"],
      [],
    ]);
    expect(pluginEntry(plugin, STATE, 19250)).toEqual({
      enabled: true,
      config: { signinUrl: "http://127.0.0.1:19250/scripted/signin" },
    });
  });

  it("refuses a manifest that declares a real provider, an alias or a catalog", () => {
    const scripted = ["acme", "globex"];
    expect(manifestProviderProblems({ providers: ["acme"] }, scripted).problems).toEqual([]);
    for (const manifest of [
      { providers: ["openai"] },
      { providerAuthChoices: [{ provider: "xai", method: "oauth" }] },
      { setup: { providers: [{ id: "anthropic" }] } },
      { providers: "acme" },
      { providers: ["acme"], providerAuthAliases: { openai: "acme" } },
      { providers: ["acme"], modelCatalog: {} },
    ]) {
      expect(
        manifestProviderProblems(manifest, scripted).problems,
        JSON.stringify(manifest),
      ).not.toEqual([]);
    }
  });

  it("is given its scripted-model path only as a plain absolute path", () => {
    const plugin = loadDevPlugin("clawtrate-dev-signin", CHECKOUT_DIR, PLUGIN_RULE);
    expect(() => pluginEntry(plugin, STATE, Number.NaN)).toThrow(/no scripted model port/);
  });

  it("is refused without accounts before anything is touched", async () => {
    const home = temp();
    await expect(
      start(openInstance("signin", { home, runRoot: join(home, "run") }), {
        plugins: ["clawtrate-dev-signin"],
      }),
    ).rejects.toThrow(/start with --with-accounts/);
  });
});

describe("the lock subcommand", () => {
  it("never acts on the default instance", async () => {
    const home = temp();
    await expect(
      lockOrder(openInstance(null, { home, runRoot: join(home, "run") }), {
        bot: "otto",
        provider: "acme",
        profileId: "acme:work",
      }),
    ).rejects.toThrow(/only on a named development instance/);
  });

  it("refuses arguments that are not a bot, a provider and one of its accounts", async () => {
    const home = temp();
    const inst = openInstance("locks", { home, runRoot: join(home, "run") });
    for (const [request, why] of [
      [{ bot: "--all", provider: "acme", profileId: "acme:work" }, /not a bot id/],
      [{ bot: "otto", provider: "-x", profileId: null }, /not a provider id/],
      [{ bot: "otto", provider: "acme", profileId: "globex:team" }, /not an account of acme/],
      [{ bot: "otto", provider: "acme", profileId: "acme:" }, /not an account of acme/],
    ] as const) {
      await expect(lockOrder(inst, request)).rejects.toThrow(why);
    }
  });

  /**
   * A named instance whose guard lets OpenClaw run (a stub runner that
   * records every command instead of running it), with `agents.entries` as
   * given in its config.
   */
  function lockable(entries: Record<string, unknown>) {
    const home = temp();
    const stateDir = join(home, ".openclaw-clawtrate-dev-locks");
    mkdirSync(join(stateDir, "agents", "main", "agent"), { recursive: true });
    writeFileSync(join(stateDir, "openclaw.json"), JSON.stringify({ agents: { entries } }));
    const runner = {
      refusal: () => null,
      gatewayPort: () => 19240,
      run: vi.fn(async (_args: string[]) => ({
        status: 0,
        stdout: '{"order":["acme:work"]}',
        stderr: "",
      })),
    };
    const inst = openInstance("locks", {
      home,
      runRoot: join(home, "run"),
      runner: runner as never,
      listening: async () => true,
    });
    return { inst, runner, stateDir, home };
  }
  const lockWork = (inst: ReturnType<typeof openInstance>, bot = "main") =>
    lockOrder(inst, { bot, provider: "acme", profileId: "acme:work" });

  it("refuses, running nothing, when the config puts a store outside the instance", async () => {
    const outside = temp();
    const { inst, runner } = lockable({ main: { agentDir: outside } });
    await expect(lockWork(inst)).rejects.toThrow(
      /refusing to lock main.*outside the instance's state folder/s,
    );
    await expect(
      lockOrder(inst, { bot: "otto", provider: "acme", profileId: null }),
    ).rejects.toThrow(/refusing to unlock otto.*agents\.entries\.main\.agentDir/s);
    expect(runner.run).not.toHaveBeenCalled();
    expect(readdirSync(outside)).toEqual([]);
  });

  it("refuses a store reached through a link, or a store file that is a link", async () => {
    const outside = temp();
    const linked = lockable({});
    symlinkSync(outside, join(linked.stateDir, "agents", "otto"));
    await expect(lockWork(linked.inst, "otto")).rejects.toThrow(/passes through a link/);
    const fileLink = lockable({});
    symlinkSync(
      join(outside, "store"),
      join(fileLink.stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
    );
    await expect(lockWork(fileLink.inst)).rejects.toThrow(/not a plain file/);
    expect([...linked.runner.run.mock.calls, ...fileLink.runner.run.mock.calls]).toEqual([]);
  });

  it("runs the gateway's command line when every store is the instance's own", async () => {
    const { inst, runner, stateDir } = lockable({
      otto: { agentDir: "" },
      pip: {},
    });
    // An empty agentDir is not a path; one inside the instance is fine.
    await expect(lockWork(inst)).rejects.toThrow(/agents\.entries\.otto\.agentDir/);
    writeFileSync(
      join(stateDir, "openclaw.json"),
      JSON.stringify({
        agents: { entries: { otto: { agentDir: join(stateDir, "agents", "otto", "agent") } } },
      }),
    );
    expect(await lockWork(inst, "otto")).toEqual(["acme:work"]);
    expect(runner.run.mock.calls.map(([args]) => args.slice(0, 4).join(" "))).toEqual([
      "gateway call health --json",
      "models auth order set",
      "models auth order get",
    ]);
  });

  it("names every store a config can point a command at", () => {
    const state = temp();
    expect(accountStoreProblems(state, {}, "otto")).toEqual([]);
    for (const [config, problem] of [
      [
        { agents: { entries: { otto: { agentDir: "~/elsewhere" } } } },
        /not an absolute, plain path/,
      ],
      [
        { agents: { entries: { otto: { agentDir: `${state}/agents/../../x` } } } },
        /not an absolute, plain path/,
      ],
      [
        { agents: { entries: { otto: { agentDir: state } } } },
        /outside the instance's state folder/,
      ],
      [{ agents: { entries: { otto: { agentDir: ["x"] } } } }, /is not a path/],
      [
        { agents: { defaults: { agentDir: `${state}/a` } } },
        /agents\.defaults may not name an agentDir/,
      ],
      [{ agents: [] }, /agents is not an object/],
      [[], /the config is not an object/],
    ] as const) {
      expect(accountStoreProblems(state, config, "otto"), JSON.stringify(config)).toEqual(
        expect.arrayContaining([expect.stringMatching(problem)]),
      );
    }
    // Another bot's outside folder is refused too, whichever bot is locked.
    expect(
      accountStoreProblems(state, { agents: { entries: { pip: { agentDir: temp() } } } }, "otto"),
    ).toHaveLength(1);
  });

  it("refuses a named instance this checkout has not started, spawning nothing", async () => {
    const home = temp();
    const inst = openInstance("locks", { home, runRoot: join(home, "run") });
    await expect(
      lockOrder(inst, { bot: "otto", provider: "acme", profileId: "acme:work" }),
    ).rejects.toThrow();
  });
});

describe("the scripted side", () => {
  const listen = async () => {
    const server = startFakeProvider({ port: 0, chunkDelayMs: 0 });
    servers.push(server);
    await new Promise((resolve) => server.once("listening", resolve));
    const address = server.address();
    return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  };
  const post = async (base: string, path: string, body: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const complete = (base: string, key: string | null) =>
    fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({
        model: "dev-1",
        stream: false,
        messages: [{ role: "user", content: "#text\nRuntime: agent=main | session=agent:main:t1" }],
      }),
    }).then((r) => r.status);

  it("records which account each request came from, and fails one account while the others answer", async () => {
    const base = await listen();
    const work = credentialFor("api_key", "acme", "work");
    const home = credentialFor("api_key", "acme", "home");
    await post(base, "/scripted/accounts/fail", { account: "acme:work", status: 402, times: 1 });
    expect(await complete(base, work)).toBe(402);
    expect(await complete(base, work)).toBe(200);
    await post(base, "/scripted/accounts/fail", { account: "acme:home", status: 429 });
    expect(await complete(base, home)).toBe(429);
    expect(await complete(base, home)).toBe(429);
    expect(await complete(base, work)).toBe(200);
    await post(base, "/scripted/accounts/clear", { account: "acme:home" });
    expect(await complete(base, home)).toBe(200);
    // The default provider's placeholder key is no account; no credential at all is refused.
    expect(await complete(base, "scripted-dev-provider")).toBe(200);
    expect(await complete(base, null)).toBe(401);
    const { requests } = (await (await fetch(`${base}/scripted/requests`)).json()) as {
      requests: { account: string | null; credential: string; status: number; session: string }[];
    };
    expect(requests.map((r) => [r.account, r.credential, r.status])).toEqual([
      ["acme:work", "api_key", 402],
      ["acme:work", "api_key", 200],
      ["acme:home", "api_key", 429],
      ["acme:home", "api_key", 429],
      ["acme:work", "api_key", 200],
      ["acme:home", "api_key", 200],
      [null, "other", 200],
      [null, "none", 401],
    ]);
    expect(requests[0]!.session).toBe("agent:main:t1");
    expect(
      (await post(base, "/scripted/accounts/fail", { account: "acme:work", status: 500 })).status,
    ).toBe(400);
  });

  it("records the status the scripted model really answered, a scripted model error included", async () => {
    const base = await listen();
    const work = credentialFor("api_key", "acme", "work");
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${work}` },
      body: JSON.stringify({
        model: "dev-1",
        stream: false,
        messages: [
          { role: "user", content: "#model-error\nRuntime: agent=main | session=agent:main:t2" },
        ],
      }),
    });
    const { requests } = (await (await fetch(`${base}/scripted/requests`)).json()) as {
      requests: { account: string; status: number }[];
    };
    expect(response.status).not.toBe(200);
    expect(requests.map((r) => [r.account, r.status])).toEqual([["acme:work", response.status]]);
  });

  it("answers a failure with the message it was given, so the gateway's reason can be tried", async () => {
    const base = await listen();
    const work = credentialFor("api_key", "acme", "work");
    const message = "The request was not accepted (scripted)";
    await post(base, "/scripted/accounts/fail", { account: "acme:work", status: 402, message });
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${work}` },
      body: JSON.stringify({
        model: "dev-1",
        stream: false,
        messages: [{ role: "user", content: "#text" }],
      }),
    });
    expect(response.status).toBe(402);
    expect(((await response.json()) as { error: { message: string } }).error.message).toBe(message);
    for (const bad of [
      { message: "two\nlines" },
      { message: ["x"] },
      { message: "" },
      { status: "402" },
      { times: "1" },
    ]) {
      expect(
        (await post(base, "/scripted/accounts/fail", { account: "acme:work", status: 402, ...bad }))
          .status,
        JSON.stringify(bad),
      ).toBe(400);
    }
  });

  it("plays a device sign-in: pending until the person answers, then the account or the refusal", async () => {
    const base = await listen();
    const started = await post(base, "/scripted/signin/device/start", { provider: "acme" });
    expect(
      String(started.body.verificationUri).startsWith(`${base}/scripted/signin/device?code=`),
    ).toBe(true);
    const poll = () =>
      post(base, "/scripted/signin/device/poll", { deviceCode: started.body.deviceCode });
    expect((await poll()).body).toEqual({ status: "pending" });
    const page = await (await fetch(String(started.body.verificationUri))).text();
    expect(page).toContain(String(started.body.userCode));
    await post(base, "/scripted/signin/answer", {
      userCode: started.body.userCode,
      outcome: "approve",
      account: "travel",
    });
    const done = (await poll()).body as { status: string; tokens: Record<string, unknown> };
    expect(done.status).toBe("approved");
    expect(done.tokens.account).toBe("acme:travel");
    expect(accountOfCredential(String(done.tokens.access))).toEqual({
      account: "acme:travel",
      kind: "oauth",
    });
    const refused = await post(base, "/scripted/signin/device/start", { provider: "acme" });
    await post(base, "/scripted/signin/answer", {
      userCode: refused.body.userCode,
      outcome: "refuse",
    });
    expect(
      (await post(base, "/scripted/signin/device/poll", { deviceCode: refused.body.deviceCode }))
        .body.status,
    ).toBe("refused");
  });

  it("plays a browser sign-in whose code is pasted back once, and a key check", async () => {
    const base = await listen();
    const started = await post(base, "/scripted/signin/browser/start", { provider: "acme" });
    const answered = await post(base, "/scripted/signin/answer", {
      state: started.body.state,
      outcome: "expire",
      account: "late",
    });
    expect(new URL(String(answered.body.redirectUrl)).searchParams.get("code")).toBe(
      answered.body.code,
    );
    const exchange = () =>
      post(base, "/scripted/signin/browser/exchange", {
        provider: "acme",
        code: answered.body.code,
      });
    expect((await exchange()).body.status).toBe("expired");
    expect((await exchange()).body.status).toBe("refused");
    const key = credentialFor("api_key", "acme", "spare");
    expect(
      (await post(base, "/scripted/signin/key/check", { provider: "acme", key })).body,
    ).toEqual({
      status: "approved",
      account: "acme:spare",
    });
    await post(base, "/scripted/signin/key-outcome", { key, outcome: "refuse" });
    expect(
      (await post(base, "/scripted/signin/key/check", { provider: "acme", key })).body.status,
    ).toBe("refused");
    expect(
      (await post(base, "/scripted/signin/key/check", { provider: "globex", key })).body.status,
    ).toBe("refused");
  });

  it("times each request by its own clock and counts a failure down per account", () => {
    let now = 1_000;
    const accounts = new ScriptedAccounts({ baseUrl: () => "http://127.0.0.1:1", now: () => now });
    accounts.fail("acme:work", 401, 2);
    const work = {
      authorization: `Bearer ${credentialFor("api_key", "acme", "work")}`,
      model: null,
      session: null,
    };
    expect(
      [accounts.observe(work), accounts.observe(work), accounts.observe(work)].map(
        (o) => o.failure?.status ?? null,
      ),
    ).toEqual([401, 401, null]);
    now += 5;
    expect(
      accounts.observe({ authorization: undefined, model: null, session: null }).failure,
    ).toEqual({
      status: 401,
    });
    expect(accounts.requests(3).map((r) => [r.seq, r.at])).toEqual([[4, 1_005]]);
    expect(accounts.failing()).toEqual({});
    accounts.fail("acme:home", 429);
    expect(accounts.failing()).toEqual({
      "acme:home": { status: 429, remaining: "until cleared" },
    });
  });
});
