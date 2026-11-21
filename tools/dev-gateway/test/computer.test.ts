// The computer plugin on a development instance: its contract addition, the
// browser setup the tool writes from it, the guard over that setup, the ports
// it uses, the scripted pages, and the confinement of the development browser
// to those pages (with a real Chromium, against addresses nothing answers).

import { spawn, type ChildProcess } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chromium } from "@playwright/test";
import {
  browserConfig,
  browserPortOffsets,
  browserProcesses,
  browserPorts,
  confinementArgs,
  devConfig,
  developmentChromium,
  loadPlugins,
  PLUGIN_RULE,
  reset,
  sandboxProblems,
  settleBrowserProcesses,
} from "../src/cli.ts";
import {
  additionProblems,
  BOT_BROWSER_CHOICES,
  botBrowsersProblems,
  loadDevPlugin,
} from "../src/dev-plugins.ts";
import { CHECKOUT_DIR, OpenclawRunner } from "../src/env.ts";
import { processIdentity } from "../src/state-guard.ts";
import { CHECKOUT as FIXTURE_CHECKOUT, seedInstance, testInstance } from "./fixtures.ts";
import { choosePorts } from "../src/registry.ts";
import { PAGES_RECORD_PATH, REFUSED_TITLE, startScriptedPages } from "../src/scripted-pages.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const PORTS = { gatewayPort: 19400, providerPort: 19410 };
/** A private-range address, built here so no such literal sits in the repository. */
const PRIVATE_ADDRESS = [10, 0, 0, 1].join(".");
const CHROMIUM = "/opt/chromium-for-tests/chrome";
const temps: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});
const temp = () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "clawtrate-computer-")));
  temps.push(dir);
  return dir;
};

const plugin = () => loadDevPlugin("clawtrate-computer", CHECKOUT_DIR, PLUGIN_RULE);
type Config = ReturnType<typeof devConfig> & Record<string, unknown>;
const config = (state: string) =>
  devConfig("tok", PORTS, state, [plugin()], {}, CHROMIUM) as Config;

describe("the computer plugin's contract addition", () => {
  it("passes the guard and declares browsers for two seeded bots, with timings from their sets", () => {
    const loaded = plugin();
    expect(loaded).toMatchObject({ id: "clawtrate-computer", tools: [], settings: {} });
    expect(loaded.botBrowsers).toEqual({
      bots: ["marlow", "pip"],
      drainTimeoutMs: 5000,
      renewTimeoutMs: 6000,
    });
  });

  it("accepts only a closed declaration: seeded bots, each once, at most four, timings from their sets", () => {
    const seed = PLUGIN_RULE.seedBots;
    expect(
      botBrowsersProblems({ bots: ["pip"], drainTimeoutMs: 2000, renewTimeoutMs: 20000 }, seed),
    ).toEqual([]);
    for (const bad of [
      null,
      [],
      { bots: ["pip"], drainTimeoutMs: 2000 },
      { bots: ["pip"], drainTimeoutMs: 2000, renewTimeoutMs: 6000, profile: "x" },
      { bots: [], drainTimeoutMs: 2000, renewTimeoutMs: 6000 },
      { bots: ["pip", "pip"], drainTimeoutMs: 2000, renewTimeoutMs: 6000 },
      { bots: ["ledger"], drainTimeoutMs: 2000, renewTimeoutMs: 6000 },
      { bots: [...seed, "pip"], drainTimeoutMs: 2000, renewTimeoutMs: 6000 },
      { bots: "pip", drainTimeoutMs: 2000, renewTimeoutMs: 6000 },
      { bots: ["pip"], drainTimeoutMs: 2001, renewTimeoutMs: 6000 },
      { bots: ["pip"], drainTimeoutMs: 2000, renewTimeoutMs: "6000" },
      { bots: ["pip"], drainTimeoutMs: 60000, renewTimeoutMs: 6000 },
    ]) {
      expect(botBrowsersProblems(bad, seed).length, JSON.stringify(bad)).toBeGreaterThan(0);
    }
    expect(BOT_BROWSER_CHOICES.maxBots).toBe(4);
    const addition = {
      plugin: "p",
      botBrowsers: { bots: ["nobody"], drainTimeoutMs: 1, renewTimeoutMs: 1 },
    };
    expect(additionProblems(addition, { ...PLUGIN_RULE, manifestId: "p" })).toEqual([
      "botBrowsers.bots must be 1 to 4 different seeded bots (main, otto, marlow, pip)",
      "botBrowsers.drainTimeoutMs must be one of 2000, 5000, 15000",
      "botBrowsers.renewTimeoutMs must be one of 6000, 10000, 20000",
    ]);
  });

  it("refuses two plugins that both give bots browsers", () => {
    const checkout = temp();
    for (const name of ["computer-a", "computer-b"]) {
      const dir = join(checkout, "plugins", name);
      mkdirSync(dir, { recursive: true });
      cpSync(join(CHECKOUT_DIR, "plugins", "clawtrate-computer"), dir, { recursive: true });
      for (const file of ["openclaw.plugin.json", "clawtrate-dev-contract.json"]) {
        const path = join(dir, file);
        const json = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        json[file === "openclaw.plugin.json" ? "id" : "plugin"] = name;
        writeFileSync(path, JSON.stringify(json));
      }
    }
    expect(() => loadPlugins({ checkout, name: "x" }, ["computer-a", "computer-b"])).toThrow(
      /only one plugin of an instance may give bots browsers/,
    );
    expect(loadPlugins({ checkout, name: "x" }, ["computer-a"])).toHaveLength(1);
  });
});

describe("the browser setup the tool writes", () => {
  it("gives only the declared bots the browser tool, one managed profile each, on the instance's ports", () => {
    const state = temp();
    const c = config(state);
    const { pagesPort, defaultCdpPort, botCdpPorts } = browserPorts(PORTS, ["marlow", "pip"]);
    expect([pagesPort, defaultCdpPort, ...botCdpPorts]).toEqual([19411, 19412, 19413, 19414]);
    expect(c.browser).toEqual({
      enabled: true,
      headless: true,
      noSandbox: process.platform === "linux",
      evaluateEnabled: false,
      allowSystemProfileImport: false,
      executablePath: CHROMIUM,
      defaultProfile: "openclaw",
      ssrfPolicy: { allowedHostnames: ["127.0.0.1"] },
      extraArgs: [
        "--host-rules=MAP * 127.0.0.1:19411",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--disable-breakpad",
      ],
      profiles: {
        openclaw: { cdpPort: 19412 },
        "bot-marlow": { cdpPort: 19413 },
        "bot-pip": { cdpPort: 19414 },
      },
    });
    expect((c.plugins.entries as Record<string, unknown>)["clawtrate-computer"]).toEqual({
      enabled: true,
      config: {
        bots: {
          marlow: { profile: "bot-marlow", cdpUrl: "http://127.0.0.1:19413" },
          pip: { profile: "bot-pip", cdpUrl: "http://127.0.0.1:19414" },
        },
        drainTimeoutMs: 5000,
        renewTimeoutMs: 6000,
      },
    });
    expect(c.tools.allow).toContain("browser");
    expect(c.tools.deny).not.toContain("browser");
    for (const [bot, entry] of Object.entries(c.agents.entries)) {
      const denied = (entry.tools.deny as string[] | undefined) ?? [];
      expect(denied.includes("browser"), bot).toBe(!["marlow", "pip"].includes(bot));
    }
    expect(sandboxProblems(c, PORTS, state, [plugin()], {}, CHROMIUM)).toEqual([]);
  });

  it("without the plugin there is no browser block and the browser tool stays denied to every bot", () => {
    const c = devConfig("tok", PORTS, temp()) as Config;
    expect(c.browser).toBeUndefined();
    expect(c.tools.deny).toContain("browser");
    expect(c.tools.allow).not.toContain("browser");
  });

  it("R3-04, C-04: the gateway the launcher starts keeps each bot's browser data in the instance and never uses the owner's browsers", () => {
    const home = temp();
    const runRoot = temp();
    const { stateDir, runId } = seedInstance(home, "alpha", { runRoot });
    // The launcher's own spawn of the gateway, recorded and never run.
    const spawned: { args: string[]; env: NodeJS.ProcessEnv; cwd: string }[] = [];
    const runner = new OpenclawRunner({
      instance: "alpha",
      stateDir,
      runFile: testInstance(home, runRoot, "alpha").runFile,
      checkout: FIXTURE_CHECKOUT,
      spawnImpl: ((
        _bin: string,
        args: string[],
        options: { env: NodeJS.ProcessEnv; cwd: string },
      ) => {
        spawned.push({ args, env: options.env, cwd: options.cwd });
        throw new Error("a test must never reach a real spawn");
      }) as never,
    });
    runner.freshRunId = runId;
    expect(() => runner.spawnGated(["gateway", "run"], { stdio: "ignore" })).toThrow(/never reach/);
    const [gateway] = spawned;
    // The gateway's own rule (OpenClaw 2026.10.6, resolveConfigDir and
    // resolveOpenClawUserDataDir): a managed profile's data is
    // <OPENCLAW_STATE_DIR, else the folder of OPENCLAW_CONFIG_PATH, else ~/.openclaw>/browser/<profile>/user-data.
    const env = gateway!.env;
    const root =
      env.OPENCLAW_STATE_DIR?.trim() ||
      (env.OPENCLAW_CONFIG_PATH?.trim() ? dirname(env.OPENCLAW_CONFIG_PATH.trim()) : undefined) ||
      join(String(env.HOME), ".openclaw");
    expect(root).toBe(stateDir);
    expect(dirname(String(env.OPENCLAW_CONFIG_PATH))).toBe(stateDir);
    expect(gateway!.cwd).toBe(stateDir);
    const { browser } = browserConfig(PORTS, plugin().botBrowsers!, CHROMIUM);
    for (const [name, profile] of Object.entries(browser.profiles)) {
      // No userDataDir, cdpUrl, attach or driver: each is a managed profile the
      // gateway launches, with its data where the rule above puts it.
      expect(Object.keys(profile), name).toEqual(["cdpPort"]);
      const data = join(root, "browser", name, "user-data");
      expect(relative(stateDir, data).startsWith(".."), data).toBe(false);
      expect(isAbsolute(relative(stateDir, data)), data).toBe(false);
    }
    expect(browser.allowSystemProfileImport).toBe(false);
    expect(Object.keys(browser)).not.toContain("cdpUrl");
    expect(Object.keys(browser)).not.toContain("attachOnly");
  });

  it("the Chromium is the one Playwright installed for this checkout", () => {
    const path = developmentChromium();
    expect(path).toBe(chromium.executablePath());
    expect(path).toMatch(/ms-playwright/);
  });

  it("the guard refuses every change to that setup", () => {
    const state = temp();
    const mutations: [string, (c: Config) => void][] = [
      ["confinement switches removed", (c) => (c.browser!.extraArgs = [])],
      [
        "host rules to another port",
        (c) => (c.browser!.extraArgs[0] = "--host-rules=MAP * 127.0.0.1:19999"),
      ],
      ["a proxy added", (c) => c.browser!.extraArgs.push("--proxy-server=http://127.0.0.1:1")],
      [
        "private networks allowed",
        (c) => Object.assign(c.browser!.ssrfPolicy, { dangerouslyAllowPrivateNetwork: true }),
      ],
      ["another hostname allowed", (c) => c.browser!.ssrfPolicy.allowedHostnames.push("localhost")],
      ["script evaluation on", (c) => (c.browser!.evaluateEnabled = true)],
      ["profile import on", (c) => (c.browser!.allowSystemProfileImport = true as never)],
      ["a headed browser", (c) => (c.browser!.headless = false)],
      [
        "the sandbox switched the other way",
        (c) => (c.browser!.noSandbox = process.platform !== "linux"),
      ],
      ["another executable", (c) => (c.browser!.executablePath = "/Applications/Some Browser")],
      [
        "a profile's own data folder",
        (c) => Object.assign(c.browser!.profiles["bot-pip"]!, { userDataDir: "/tmp/x" }),
      ],
      [
        "a remote endpoint",
        (c) =>
          Object.assign(c.browser!.profiles["bot-pip"]!, {
            cdpUrl: `http://${PRIVATE_ADDRESS}:9222`,
          }),
      ],
      ["a profile added", (c) => Object.assign(c.browser!.profiles, { extra: { cdpPort: 19415 } })],
      [
        "the browser tool for main",
        (c) => delete (c.agents.entries.main!.tools as { deny?: string[] }).deny,
      ],
      [
        "a bot's endpoint elsewhere",
        (c) => {
          const bots = (
            (c.plugins.entries as Record<string, unknown>)["clawtrate-computer"] as {
              config: { bots: Record<string, { cdpUrl: string }> };
            }
          ).config.bots;
          bots.pip!.cdpUrl = "http://127.0.0.1:9222";
        },
      ],
      [
        "a longer drain",
        (c) => {
          (
            (c.plugins.entries as Record<string, unknown>)["clawtrate-computer"] as {
              config: { drainTimeoutMs: number };
            }
          ).config.drainTimeoutMs = 15000;
        },
      ],
    ];
    for (const [what, mutate] of mutations) {
      const c = structuredClone(config(state));
      mutate(c);
      expect(
        sandboxProblems(c, PORTS, state, [plugin()], {}, CHROMIUM).length,
        what,
      ).toBeGreaterThan(0);
    }
  });
});

describe("ports", () => {
  it("an instance with bot browsers needs the pages port and one port per browser of its block free", async () => {
    expect(browserPortOffsets(2)).toEqual([11, 12, 13, 14]);
    const home = temp();
    const busy = new Set<number>();
    const free = async (port: number) => !busy.has(port);
    const first = await choosePorts("computer-ports", home, free, browserPortOffsets(2));
    busy.add(first.gatewayPort + 14);
    const second = await choosePorts("computer-ports", home, free, browserPortOffsets(2));
    expect(second.gatewayPort).not.toBe(first.gatewayPort);
    // Without bot browsers that port does not matter.
    expect((await choosePorts("computer-ports", home, free)).gatewayPort).toBe(first.gatewayPort);
  });
});

/** Start the scripted pages on a free loopback port. */
async function pages(): Promise<{ port: number; origin: string }> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise((resolve) => probe.close(resolve));
  const server = startScriptedPages({ port });
  servers.push(server);
  await new Promise((resolve) => server.once("listening", resolve));
  return { port, origin: `http://127.0.0.1:${port}` };
}

const record = async (origin: string) =>
  (await (await fetch(`${origin}${PAGES_RECORD_PATH}`)).json()) as {
    refused: { host: string; path: string; method: string }[];
    events: { kind: string; value: string }[];
  };

describe("the scripted pages", () => {
  it("serve their own pages on their own origin and refuse and record everything else", async () => {
    const { port, origin } = await pages();
    const signIn = await fetch(`${origin}/scripted/pages/sign-in`);
    expect(signIn.status).toBe(200);
    expect(await signIn.text()).toContain("<title>Scripted sign-in</title>");
    for (const path of ["/", "/v1/models", "/scripted/requests", "/scripted/pages/../../etc"]) {
      expect((await fetch(`${origin}${path}`)).status, path).toBe(403);
    }
    // A request for another host, the way the host rules deliver it.
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, path: "/", headers: { host: "192.0.2.1" } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
    expect((await record(origin)).refused.map((r) => r.host)).toContain("192.0.2.1");
  });
});

describe("the development browser is confined to the scripted pages", () => {
  it(
    "refuses outside addresses, other loopback ports and every other host, and reaches nothing else",
    { timeout: 120_000 },
    async () => {
      const { port, origin } = await pages();
      // A server of our own on another loopback port: it must never be reached.
      let reached = 0;
      const other = createServer((_req, res) => {
        reached += 1;
        res.end("other");
      });
      servers.push(other);
      await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
      const otherPort = (other.address() as { port: number }).port;
      const browser = await chromium.launch({
        executablePath: developmentChromium(),
        args: confinementArgs(port),
        headless: true,
        timeout: 60_000,
      });
      try {
        const page = await browser.newPage();
        await page.goto(`${origin}/scripted/pages/sign-in`, { timeout: 20_000 });
        expect(await page.title()).toBe("Scripted sign-in");
        // Every address here is reserved for documentation or never resolves, so
        // nothing outside could answer even if the confinement failed.
        for (const url of [
          "http://192.0.2.1/",
          "http://198.51.100.7:8080/login",
          "http://[2001:db8::1]/",
          "http://example.invalid/",
          "http://login.example/",
          `http://127.0.0.1:${otherPort}/`,
          `http://localhost:${otherPort}/`,
          `http://[::1]:${otherPort}/`,
        ]) {
          await page.goto(url, { timeout: 20_000 });
          expect(await page.title(), url).toBe(REFUSED_TITLE);
        }
        // TLS to anywhere ends at the scripted pages too, which do not speak it.
        await expect(page.goto("https://192.0.2.1/", { timeout: 20_000 })).rejects.toThrow();
        const hosts = (await record(origin)).refused.map((r) => r.host);
        for (const host of [
          "192.0.2.1",
          "198.51.100.7:8080",
          "[2001:db8::1]",
          "example.invalid",
          "login.example",
          `127.0.0.1:${otherPort}`,
          `localhost:${otherPort}`,
          `[::1]:${otherPort}`,
        ]) {
          expect(hosts, host).toContain(host);
        }
        expect(reached).toBe(0);
      } finally {
        await browser.close();
      }
    },
  );
});

describe("stopping and resetting wait for the browser's processes", () => {
  const helpers: ChildProcess[] = [];
  afterEach(() => {
    for (const child of helpers.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
  });
  /** A stand-in for a browser helper of the instance: a process of the test's own with such an argument. */
  const helper = (arg: string, script = "setTimeout(() => {}, 30000)") => {
    const child = spawn(process.execPath, ["-e", script, "--", arg], { stdio: "ignore" });
    helpers.push(child);
    return child;
  };
  const gone = (child: ChildProcess) =>
    new Promise<void>((resolve) =>
      child.exitCode !== null || child.signalCode !== null
        ? resolve()
        : child.once("exit", () => resolve()),
    );
  const started = (child: ChildProcess) =>
    new Promise<void>((resolve) => (child.pid ? resolve() : child.once("spawn", () => resolve())));

  it("finds the instance's browser processes by an argument naming its browser folder, and nothing else", () => {
    const state = "/var/empty/clawtrate-test/.openclaw-clawtrate-dev-alpha";
    const rows = [
      {
        pid: 11,
        command: `/pw/Chromium --user-data-dir=${state}/browser/bot-pip/user-data --headless`,
      },
      {
        pid: 12,
        command: `/pw/Chromium Helper --type=utility --user-data-dir=${state}/browser/bot-pip/user-data`,
      },
      {
        pid: 13,
        command: `/pw/chrome_crashpad_handler --database=${state}/browser/bot-pip/user-data/Crashpad`,
      },
      { pid: 21, command: `tail -f ${state}/browser/bot-pip/user-data/chrome_debug.log` },
      { pid: 22, command: `/pw/Chromium --user-data-dir=${state}-other/browser/bot-pip/user-data` },
      {
        pid: 23,
        command: `/pw/Chromium --user-data-dir=/var/empty/clawtrate-test/.openclaw-clawtrate-dev-beta/browser/b/user-data`,
      },
      { pid: process.pid, command: `node --user-data-dir=${state}/browser/x` },
    ];
    expect(browserProcesses(state, rows)).toEqual([11, 12, 13]);
  });

  it("waits for those still exiting, stops those that stay, and leaves other processes alone", async () => {
    const state = temp();
    const folder = `--user-data-dir=${state}/browser/bot-pip/user-data`;
    const lingering = helper(folder, "setTimeout(() => {}, 600)");
    const stubborn = helper(folder, "process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000)");
    const unrelated = helper(`${state}/browser/bot-pip/notes.txt`);
    await Promise.all([lingering, stubborn, unrelated].map(started));
    await sleep(300); // the stubborn one has its SIGTERM handler in place
    const settled = await settleBrowserProcesses(
      { stateDir: state, name: "alpha", identify: processIdentity },
      { own: 1500, term: 500, kill: 3000 },
    );
    expect(settled).toBe(true);
    expect(lingering.exitCode).toBe(0);
    expect(stubborn.signalCode).toBe("SIGKILL");
    expect(unrelated.exitCode).toBeNull();
  });

  it("reset says the instance is reset only once its browser's processes are gone", async () => {
    const home = temp();
    const runRoot = temp();
    const { stateDir } = seedInstance(home, "alpha", { runRoot });
    const lingering = helper(
      `--user-data-dir=${stateDir}/browser/bot-pip/user-data`,
      "setTimeout(() => {}, 1500)",
    );
    await started(lingering);
    const before = Date.now();
    await reset(testInstance(home, runRoot, "alpha"));
    // Gone by the time reset returns, which waited for it rather than stopping it.
    expect(processIdentity(lingering.pid!).state).not.toBe("alive");
    expect(Date.now() - before).toBeGreaterThanOrEqual(1000);
    expect(existsSync(stateDir)).toBe(false);
    await gone(lingering);
    expect(lingering.exitCode).toBe(0);
  });
});
