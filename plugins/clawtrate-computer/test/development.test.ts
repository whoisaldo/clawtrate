// The plugin registers only on a named development instance the dev-gateway
// tool started. A gateway configured as the README describes, with a valid
// managed profile for each bot, gets nothing: no method, route, hook or
// service. Each instance here is built in a temporary home, as the tool leaves
// one: the state folder, its marker naming this process, and the plugin's copy
// inside the folder.

import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { developmentInstanceProblem as signinCheck } from "../../clawtrate-dev-signin/index.js";
import { developmentInstanceProblem as computerCheck } from "../lib/development.js";
import { BASE_CONFIG, BROWSER_CONFIG } from "./harness.ts";

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const temps: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Plugin = { register(api: unknown): void };
let loads = 0;
async function load(dir: string): Promise<Plugin> {
  loads += 1;
  const url = `${pathToFileURL(join(dir, "index.js")).href}?load=${loads}`;
  return ((await import(url)) as { default: Plugin }).default;
}

/** A gateway's plugin api, configured as the README says, that counts what is registered. */
function gateway() {
  const registered: string[] = [];
  const warnings: string[] = [];
  return {
    registered,
    warnings,
    api: {
      pluginConfig: BASE_CONFIG,
      config: BROWSER_CONFIG,
      runtime: { config: { current: () => BROWSER_CONFIG } },
      logger: { info() {}, warn: (m: string) => warnings.push(m), error() {} },
      registerGatewayMethod: (name: string) => registered.push(`method ${name}`),
      registerHttpRoute: (route: { path: string }) => registered.push(`route ${route.path}`),
      registerService: () => registered.push("service"),
      on: (name: string) => registered.push(`hook ${name}`),
    },
  };
}

function instance(name = "computer") {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "clawtrate-computer-dev-")));
  temps.push(home);
  const stateDir = join(home, `.openclaw-clawtrate-dev-${name}`);
  const copy = join(stateDir, "clawtrate-plugins", "clawtrate-computer");
  mkdirSync(copy, { recursive: true });
  cpSync(join(PLUGIN_DIR, "index.js"), join(copy, "index.js"));
  cpSync(join(PLUGIN_DIR, "lib"), join(copy, "lib"), { recursive: true });
  writeFileSync(
    join(stateDir, ".clawtrate-dev-gateway"),
    JSON.stringify({
      createdBy: "clawtrate tools/dev-gateway",
      instance: name,
      gatewayPid: process.pid,
    }),
  );
  vi.stubEnv("HOME", home);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_PROFILE", `clawtrate-dev-${name}`);
  return { home, stateDir, copy };
}

describe("development gateways only (issue #29)", () => {
  it("a gateway configured normally gets no method, route, hook or service, and the log says why", async () => {
    // An ordinary gateway: its own state folder and profile, and a valid configuration.
    const home = realpathSync.native(mkdtempSync(join(tmpdir(), "clawtrate-computer-home-")));
    temps.push(home);
    mkdirSync(join(home, ".openclaw"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("OPENCLAW_STATE_DIR", join(home, ".openclaw"));
    vi.stubEnv("OPENCLAW_PROFILE", "");
    const g = gateway();
    (await load(PLUGIN_DIR)).register(g.api);
    expect(g.registered).toEqual([]);
    expect(g.warnings).toEqual([
      expect.stringMatching(
        /^clawtrate-computer registers nothing here: .* is not a named development instance's/,
      ),
    ]);
  });

  it("nor does the checkout's own copy inside a development instance, or one with another gateway's marker", async () => {
    instance();
    const outside = gateway();
    (await load(PLUGIN_DIR)).register(outside.api);
    expect(outside.registered).toEqual([]);
    expect(outside.warnings).toEqual([
      expect.stringMatching(/outside the instance's state folder/),
    ]);
    vi.unstubAllEnvs();
    const { stateDir, copy } = instance("other");
    writeFileSync(
      join(stateDir, ".clawtrate-dev-gateway"),
      JSON.stringify({
        createdBy: "clawtrate tools/dev-gateway",
        instance: "other",
        gatewayPid: process.pid + 1,
      }),
    );
    const other = gateway();
    (await load(copy)).register(other.api);
    expect(other.registered).toEqual([]);
    expect(other.warnings).toEqual([expect.stringMatching(/is not the gateway the tool started/)]);
  });

  it("registers its methods, route, hooks and service in an instance the tool started", async () => {
    const { copy } = instance();
    const g = gateway();
    (await load(copy)).register(g.api);
    expect(g.warnings).toEqual([]);
    expect(g.registered).toEqual(
      expect.arrayContaining([
        "method clawtrate-computer.tabs",
        "route /clawtrate-computer/stream",
        "hook before_tool_call",
        "service",
      ]),
    );
  });

  it("checks exactly as the development sign-in plugin does", () => {
    const body = (f: (...args: never[]) => unknown) => f.toString();
    expect(body(computerCheck)).toBe(body(signinCheck));
  });
});
