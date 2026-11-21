// Development gateway control.
//
//   pnpm dev-gateway start     a fresh, seeded gateway: stop the tool's own gateway,
//                              delete its state, create it again empty, configure,
//                              start the scripted model and the gateway, then seed
//                              the sample bots and conversations
//   pnpm dev-gateway up        the same as start
//   pnpm dev-gateway seed      seed the running gateway again (verifies what exists)
//   pnpm dev-gateway approve   approve pending Clawtrate pairing requests
//   pnpm dev-gateway status    show what is running
//   pnpm dev-gateway stop      stop the processes this tool started
//   pnpm dev-gateway reset     stop, then delete the instance's state folder
//   pnpm dev-gateway list      the instances this tool created on this machine
//   pnpm dev-gateway prune     remove named instances nothing is running on, on the
//                              whole machine (deliberate maintenance; no --instance)
//
// The instance commands take `--instance <name>` (or CLAWTRATE_DEV_INSTANCE). Without
// one it addresses the default instance: `openclaw --dev`, ~/.openclaw-dev,
// ports 19001 and 19091. A named instance is `openclaw --profile
// clawtrate-dev-<name>` in ~/.openclaw-clawtrate-dev-<name>, on free ports the
// tool chooses at start and records. See instance.ts.
//
// State is never reused: OpenClaw keeps credentials in SQLite stores that a
// clean profile also has, so only a folder created empty by this start is safe.

import { addScriptedRoutines } from "./routines.ts";
import { FILES_BOT, seedWorkspaceFiles } from "./seed-files.ts";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  activityRefusal,
  ForeignStateError,
  inUseRefusal,
  markerProblems,
  newRunId,
  ownership,
  prepareFreshState,
  processIdentity,
  processState,
  processVerdict,
  readMarker,
  readRunRecord,
  recordPending,
  recordProcess,
  runMatches,
  StateInUseError,
  validPid,
  type Identify,
  type ProcessState,
  type RunRecord,
  type SpawnedRole,
} from "./state-guard.ts";
import {
  nodeCommandRequest,
  nodeDeviceRequest,
  SCRIPTED_NODE_NAME,
  scriptedNodeArgs,
  scriptedNodeDir,
  scriptedNodeEnv,
} from "./scripted-node.ts";
import {
  CHECKOUT_DIR,
  GATEWAY_PORT,
  MODEL_ID,
  MODEL_REF,
  OpenclawRunner,
  PROVIDER_ID,
  PROVIDER_PORT,
  assertInstanceStateDir,
  devStateDir,
  gatedSpawn,
  instancePaths,
  parseJsonOutput,
  providerEnv,
  type Gated,
  type InstancePaths,
} from "./env.ts";
import {
  BROWSER_PORT_OFFSET,
  PAGES_PORT_OFFSET,
  PROVIDER_PORT_OFFSET,
  isNamedInstancePort,
  profileArgs,
  selectInstance,
} from "./instance.ts";
import { instanceLockPath, portLockPath, withLock } from "./lock.ts";
import {
  choosePorts,
  listInstances,
  NOT_CHECKED,
  portOpen,
  type InstanceEntry,
  type InstancePorts,
} from "./registry.ts";
import { CODING_AGENT_SERVER } from "./coding-agent-mcp.ts";
import { contractProblems, matching, optional, type Contract } from "./contract.ts";
import { accountStoreProblems } from "./account-stores.ts";
import {
  ACCOUNT_PROVIDERS,
  accountProfiles,
  accountsConfig,
  authContract,
  saveAccountCommand,
  SCRIPTED_ACCOUNTS,
} from "./accounts.ts";
import {
  checkedCopy,
  copyPlugin,
  loadDevPlugin,
  pluginCopy,
  pluginEntry,
  pluginSelectionProblem,
  trustedCodeNotice,
  type BotBrowsers,
  type DevPlugin,
  type PluginRule,
} from "./dev-plugins.ts";
import { SEED_CAPS, SEED_SCOPES, seedExample, verifyExample } from "./examples.ts";
import { OperatorSession } from "./operator.ts";
import {
  MESSAGING_PAIR,
  messagingPartner,
  SCENARIO_EXAMPLES,
  SEED_BOTS,
  SHELL_BOT,
  sessionKeyFor,
  type SeedBot,
  type SeedTask,
  type SeedTurn,
} from "./seed-data.ts";
import { spawn, spawnSync } from "node:child_process";

export type DevConnection = {
  url: string;
  token: string;
  instance?: string | null;
  runId?: string;
};

/**
 * One instance as a command sees it: its paths, its guarded runner, the home it
 * is under and the checkout it acts for. `identify` and `listening` are the
 * process and port probes, replaceable in tests.
 */
export type DevInstance = InstancePaths & {
  home: string;
  checkout: string;
  runner: OpenclawRunner;
  identify: Identify;
  listening: (port: number) => Promise<boolean>;
  /** How long a stopped process's port may stay open after its PID is gone (`portReleased`). */
  portReleaseMs: number;
  /** Spawns the scripted model (the gateway goes through the runner). */
  spawn: typeof spawn;
};

export function openInstance(
  name: string | null,
  options: {
    home?: string;
    runRoot?: string;
    runner?: OpenclawRunner;
    checkout?: string;
    identify?: Identify;
    listening?: (port: number) => Promise<boolean>;
    portReleaseMs?: number;
    spawn?: typeof spawn;
  } = {},
): DevInstance {
  const home = options.home ?? homedir();
  const paths = instancePaths(name, {
    home,
    ...(options.runRoot ? { runRoot: options.runRoot } : {}),
  });
  const checkout = options.checkout ?? CHECKOUT_DIR;
  const identify = options.identify ?? processIdentity;
  const runner =
    options.runner ??
    new OpenclawRunner({
      instance: name,
      stateDir: paths.stateDir,
      runFile: paths.runFile,
      checkout,
      identify,
    });
  return {
    ...paths,
    home,
    checkout,
    runner,
    identify,
    listening: options.listening ?? portOpen,
    portReleaseMs: options.portReleaseMs ?? PORT_RELEASE_MS,
    spawn: options.spawn ?? spawn,
  };
}

const DEFAULT_PORTS: InstancePorts = { gatewayPort: GATEWAY_PORT, providerPort: PROVIDER_PORT };

/** The display name of the client the seed plays the user with. */
const SEED_CLIENT = "Clawtrate seed";

const label = (inst: { name: string | null }) =>
  inst.name === null ? "the default instance" : `instance "${inst.name}"`;

/** The flag a printed command needs to address the same instance. */
const instanceFlag = (inst: { name: string | null }) =>
  inst.name === null ? "" : ` --instance ${inst.name}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function assertInside(path: string, dir: string): void {
  const rel = relative(dir, path);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new Error(`refusing to write outside ${dir}: ${path}`);
}

/** Write a file whole and rename it into place; a link at the path is replaced, not followed. */
function writeFileAtomic(path: string, contents: string): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, contents, { mode: 0o600 });
  renameSync(temp, path);
}

function writeState(inst: DevInstance, state: RunRecord): void {
  mkdirSync(inst.runDir, { recursive: true });
  writeFileAtomic(inst.runFile, `${JSON.stringify(state, null, 2)}\n`);
}

export function readDevConnection(path: string): DevConnection | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as DevConnection;
}

async function waitFor(label: string, check: () => Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** The stand-in coding agent, run by the gateway as a stdio MCP server. */
export const CODING_AGENT_SCRIPT = fileURLToPath(new URL("./coding-agent-mcp.ts", import.meta.url));

/**
 * Each bot's tool policy. Exec stays denied for every bot but the shell bot,
 * which asks a person about every command it has no approved rule for. Only
 * the messaging pair may message each other.
 */
function botEntries(stateDir: string, browserBots: readonly string[] | null) {
  const entries: Record<string, { workspace: string; tools: Record<string, unknown> }> = {};
  for (const bot of SEED_BOTS) {
    const partner = messagingPartner(bot.id);
    entries[bot.id] = {
      // Where `agents add` used to put them: the built-in bot in workspace/, the others in workspaces/<id>.
      workspace:
        bot.id === "main" ? join(stateDir, "workspace") : join(stateDir, "workspaces", bot.id),
      tools: {
        ...(bot.id === SHELL_BOT ? { exec: { mode: "ask" } } : {}),
        agentToAgent: { send: partner ? [partner] : [] },
        // With browsers of their own, only those bots get the browser tool.
        ...(browserBots && !browserBots.includes(bot.id) ? { deny: ["browser"] } : {}),
      },
    };
  }
  return entries;
}

/** The browser profile of a bot with a browser of its own. */
export const botProfile = (botId: string) => `bot-${botId}`;

/** The ports of an instance's own browsers and scripted pages (instance.ts). */
export function browserPorts(ports: InstancePorts, bots: readonly string[]) {
  return {
    pagesPort: ports.providerPort + PAGES_PORT_OFFSET,
    defaultCdpPort: ports.gatewayPort + BROWSER_PORT_OFFSET,
    botCdpPorts: bots.map((_, i) => ports.gatewayPort + BROWSER_PORT_OFFSET + 1 + i),
  };
}

/** The block offsets an instance with `count` bot browsers also needs free. */
export const browserPortOffsets = (count: number) => [
  PROVIDER_PORT_OFFSET + PAGES_PORT_OFFSET,
  ...Array.from({ length: count + 1 }, (_, i) => BROWSER_PORT_OFFSET + i),
];

/**
 * The Chromium the development browser runs: the one Playwright installed for
 * this checkout's end-to-end tests, never a browser of the machine's owner.
 */
export function developmentChromium(checkout: string = CHECKOUT_DIR): string {
  let path: string;
  try {
    const require = createRequire(join(checkout, "package.json"));
    const { chromium } = require("@playwright/test") as {
      chromium: { executablePath(): string };
    };
    path = chromium.executablePath();
  } catch (error) {
    throw new Error(`could not find Playwright's Chromium: ${String(error)}`, { cause: error });
  }
  if (!existsSync(path)) {
    throw new Error(
      `Playwright's Chromium is not installed (${path}). Run \`pnpm exec playwright install chromium\`.`,
    );
  }
  return path;
}

/**
 * The Chromium switches that confine a development browser: every
 * connection it opens, to any host, address, port or scheme, is made to the
 * instance's scripted pages on loopback instead (`--host-rules`), and WebRTC
 * may not send UDP around it. The scripted pages answer only their own pages
 * and refuse everything else. Crash reporting is off too: Chromium's crash
 * handler is a process of its own, outside these rules. (It still starts on
 * macOS, and exits with its browser.)
 */
export const confinementArgs = (pagesPort: number) => [
  `--host-rules=MAP * 127.0.0.1:${pagesPort}`,
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--disable-breakpad",
];

/**
 * The browser setup for bots with browsers of their own, all written by the
 * tool from a plugin's `botBrowsers` declaration: one managed, headless
 * profile per bot on ports of the instance's block, the gateway's navigation
 * policy strict but for 127.0.0.1, no script evaluation, no import of a
 * system browser's cookies, Playwright's Chromium, and the confinement
 * switches above. Returns the gateway's `browser` block and the plugin's
 * config.
 */
export function browserConfig(
  ports: InstancePorts,
  declaration: BotBrowsers,
  executablePath: string,
) {
  const { pagesPort, defaultCdpPort, botCdpPorts } = browserPorts(ports, declaration.bots);
  const profiles: Record<string, { cdpPort: number }> = { openclaw: { cdpPort: defaultCdpPort } };
  const bots: Record<string, { profile: string; cdpUrl: string }> = {};
  declaration.bots.forEach((botId, i) => {
    profiles[botProfile(botId)] = { cdpPort: botCdpPorts[i]! };
    bots[botId] = { profile: botProfile(botId), cdpUrl: `http://127.0.0.1:${botCdpPorts[i]}` };
  });
  return {
    browser: {
      enabled: true,
      headless: true,
      // On Linux, Chromium's own sandbox needs user namespaces that CI runners and containers
      // do not give it, so the browser would not start; Playwright runs it without one there too.
      // The browser is confined to the scripted pages on loopback either way (`extraArgs`).
      noSandbox: process.platform === "linux",
      evaluateEnabled: false,
      allowSystemProfileImport: false,
      executablePath,
      defaultProfile: "openclaw",
      ssrfPolicy: { allowedHostnames: ["127.0.0.1"] },
      extraArgs: confinementArgs(pagesPort),
      profiles,
    },
    plugin: {
      bots,
      drainTimeoutMs: declaration.drainTimeoutMs,
      renewTimeoutMs: declaration.renewTimeoutMs,
    },
  };
}

/** What a start adds to the base config, beyond plugins. */
export type StartOptions = {
  /** The scripted provider accounts (accounts.ts); named instances only. */
  accounts?: boolean;
  /**
   * Leave `gateway.nodes.pairing.autoApproveLocal` unset, at the gateway's own
   * default, instead of false; named instances only. For research into what
   * a first pairing on loopback does when nobody has changed the setting.
   */
  defaultLocalPairing?: boolean;
};

/** The config the development gateway runs with. Written fresh by every start. */
export function devConfig(
  token: string,
  ports: InstancePorts = DEFAULT_PORTS,
  stateDir: string = devStateDir(),
  plugins: DevPlugin[] = [],
  options: StartOptions = {},
  chromium?: string,
) {
  const accounts = options.accounts ? accountsConfig(ports.providerPort, stateDir) : null;
  const owner = plugins.find((plugin) => plugin.botBrowsers);
  const browsers = owner?.botBrowsers
    ? browserConfig(ports, owner.botBrowsers, chromium ?? developmentChromium())
    : null;
  const entryOf = (plugin: DevPlugin) => {
    const entry = pluginEntry(plugin, stateDir, ports.providerPort);
    return plugin === owner && browsers
      ? { ...entry, config: { ...entry.config, ...browsers.plugin } }
      : entry;
  };
  return {
    gateway: {
      mode: "local",
      port: ports.gatewayPort,
      bind: "loopback",
      auth: { mode: "token", token },
      // Require explicit approval even on loopback, so the pairing flow is real,
      // unless this instance was started to see the gateway's own default.
      ...(options.defaultLocalPairing ? {} : { nodes: { pairing: { autoApproveLocal: false } } }),
    },
    discovery: { mdns: { mode: "off" } },
    update: { checkOnStart: false },
    // Everything the gateway itself fetches from beyond loopback (the plugin
    // catalog and its feed, plugin downloads, a remote tool server) goes
    // through this proxy, the instance's own scripted model, which refuses it
    // and logs what was asked for. Loopback still connects directly.
    proxy: { proxyUrl: `http://127.0.0.1:${ports.providerPort}` },
    models: {
      // Only the scripted provider exists; no ambient or bundled providers are merged in.
      mode: "replace",
      providers: {
        [PROVIDER_ID]: {
          baseUrl: `http://127.0.0.1:${ports.providerPort}/v1`,
          api: "openai-completions",
          apiKey: "scripted-dev-provider",
          models: [
            {
              id: MODEL_ID,
              name: "Scripted dev model",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 8192,
            },
          ],
        },
        // The scripted provider accounts' providers, on the same scripted model.
        ...accounts?.providers,
      },
    },
    // Each scripted account's label; the credentials are in the account stores.
    ...(accounts ? { auth: accounts.auth } : {}),
    ...(accounts ? { logging: accounts.logging } : {}),
    agents: {
      defaults: {
        model: { primary: MODEL_REF },
        thinkingDefault: "low",
        systemAgent: { agentId: "main" },
        heartbeat: { agentId: "main" },
      },
      // The bots are declared here so their tool policy is part of the checked
      // config from the first start. Several bots need explicit ownership.
      ownership: "explicit",
      entries: botEntries(stateDir, owner?.botBrowsers?.bots ?? null),
    },
    tools: {
      // Offer tools directly instead of behind tool_search/tool_call wrappers,
      // so scripted tool calls name the real tool.
      toolSearch: false,
      // With no policy the gateway runs model shell commands without asking.
      // This global policy is inherited by every bot without its own override,
      // including bots created later. Only the shell bot overrides it, with "ask".
      exec: { mode: "deny" },
      // Bot-to-bot messages only between the pair; both ends must match.
      agentToAgent: { enabled: true, allow: [...MESSAGING_PAIR] },
      // File tools stay inside each bot's own workspace.
      fs: { workspaceOnly: true },
      web: {
        // Web search goes to the scripted model server, through the bundled
        // Ollama search provider's base URL; see the plugin entry below.
        search: { enabled: true, provider: "ollama" },
        // web_fetch cannot be limited to loopback, so it is off.
        fetch: { enabled: false },
      },
      // The only tools any bot is offered: those the scenarios use. A tool
      // the gateway adds later is off until it is listed here.
      allow: [
        ...ALLOWED_TOOLS,
        ...plugins.flatMap((plugin) => plugin.tools),
        ...(browsers ? ["browser"] : []),
      ],
      // Denied as well, so a change to the allowlist cannot bring them back:
      // tools that reach the network, manage the gateway or its installation,
      // drive a browser or another device, or send through a channel. With
      // bot browsers the browser tool is denied per bot instead (botEntries).
      deny: DENIED_TOOLS.filter((tool) => !(browsers && tool === "browser")),
    },
    // The stand-in coding agent: a local command server, no network, run in
    // the instance's own folder.
    mcp: {
      servers: {
        [CODING_AGENT_SERVER]: {
          transport: "stdio",
          command: process.execPath,
          args: [CODING_AGENT_SCRIPT],
          cwd: stateDir,
        },
      },
    },
    // No "Recent session creations" notice queued in a bot's main task for
    // every new task: the gateway's next turn there, which nobody sent, would
    // carry it. (Scheduled heartbeats are already off with the scheduler.)
    session: { notifyOnCreate: false },
    // Routines can be created and removed, but the scheduler never runs one,
    // so no job can run a turn, a script or a delivery (webhooks included).
    cron: { enabled: false, triggers: { enabled: false } },
    // Memory search is outside `models` and defaults to a hosted embeddings
    // provider. Off, with no provider, so nothing can reach a paid API.
    memory: { search: { enabled: false, provider: "none" } },
    plugins: {
      entries: {
        "memory-core": { config: { dreaming: { enabled: false } } },
        // Only the search half of the bundled Ollama plugin is used, on loopback.
        ollama: { config: { webSearch: { baseUrl: searchBaseUrl(ports) } } },
        // The project's own plugins named at start, each as its addition says.
        ...Object.fromEntries(plugins.map((plugin) => [plugin.id, entryOf(plugin)])),
      },
      // Each loaded from the instance's own copy of what was checked.
      ...(plugins.length > 0
        ? { load: { paths: plugins.map((plugin) => pluginCopy(stateDir, plugin.name)) } }
        : {}),
    },
    ...(browsers ? { browser: browsers.browser } : {}),
  };
}

/** Plugin entries that belong to the development config itself. */
export const RESERVED_PLUGIN_IDS = ["memory-core", "ollama"] as const;

/**
 * Every tool the installed gateway provides itself (`tools.catalog` of
 * OpenClaw 2026.10.6, plugins' tools included). A plugin may turn on only
 * tools it provides, never one of these.
 */
export const GATEWAY_TOOLS = [
  ...["ls", "read", "write", "edit", "apply_patch", "exec", "process", "code_execution"],
  ...["secrets", "web_search", "web_fetch", "x_search", "memory_search", "memory_get"],
  ...["presence", "sessions", "sessions_list", "sessions_history", "sessions_search"],
  ...["conversations_list", "conversations_send", "conversations_turn", "sessions_send"],
  ...["sessions_spawn", "github_identity_status", "github_publish", "agents_wait"],
  ...["sessions_yield", "subagents", "session_status", "suggest_task", "dismiss_task"],
  ...["browser", "screen", "theme", "dashboard", "terminal", "portal", "canvas"],
  ...["show_widget", "message", "heartbeat_respond", "automations", "gateway", "plugins"],
  ...["openclaw", "nodes", "computer", "mobile_ui", "decision_evaluate", "agents_list"],
  ...["get_goal", "create_goal", "update_goal", "progress_card", "ask_user"],
  ...["skill_workshop", "skills_search", "skills_read", "view_image", "image_generate"],
  ...["music_generate", "video_generate", "transcripts", "tts", "pdf", "dir_fetch"],
  ...["dir_list", "file_fetch", "file_write", "node_inference", "intent", "talk_voice"],
] as const;

/** The scripted model server also answers web searches. */
export function searchBaseUrl(ports: InstancePorts): string {
  return `http://127.0.0.1:${ports.providerPort}`;
}

/**
 * Denied for every bot: tools that reach the network (web_fetch, x_search,
 * code_execution, tts and the media generators), drive a browser, screen or
 * paired device (browser, canvas, screen, computer, nodes, mobile_ui and the
 * file-transfer plugin's node tools), run a model on a node (node_inference),
 * send through a chat channel (message, conversations_send, conversations_turn),
 * or publish (github_publish).
 */
export const ALLOWED_TOOLS = [
  "read",
  "write",
  // The gateway offers apply_patch with write whatever the list says; it is
  // listed so the list says what is offered. Workspace only, like write.
  "apply_patch",
  "edit",
  "ls",
  "exec",
  "web_search",
  "ask_user",
  "sessions_send",
  "sessions_list",
  "progress_card",
  "automations",
  `${CODING_AGENT_SERVER}__*`,
] as const;

export const DENIED_TOOLS = [
  "gateway",
  "plugins",
  "openclaw",
  "web_fetch",
  "x_search",
  "code_execution",
  "tts",
  "image_generate",
  "music_generate",
  "video_generate",
  "browser",
  "canvas",
  "screen",
  "computer",
  "nodes",
  "mobile_ui",
  "dir_fetch",
  "dir_list",
  "file_fetch",
  "file_write",
  "node_inference",
  "message",
  "conversations_send",
  "conversations_turn",
  "github_publish",
  // Offered even outside the allowlist unless denied; not needed here.
  "skills_read",
  "skills_search",
  "skill_workshop",
] as const;

/** What a plugin's contract addition is checked against. */
export const PLUGIN_RULE: PluginRule = {
  gatewayTools: [...GATEWAY_TOOLS, ...DENIED_TOOLS],
  reserved: RESERVED_PLUGIN_IDS,
  seedBots: SEED_BOTS.map((bot) => bot.id),
  scriptedProviders: ACCOUNT_PROVIDERS,
};

/** Check the checkout's own plugins named at start and take each into memory. */
export function loadPlugins(
  inst: { checkout: string; name: string | null },
  names: string[],
): DevPlugin[] {
  const problem = pluginSelectionProblem(inst.name, names);
  if (problem) throw new Error(problem);
  const plugins = names.map((name) => loadDevPlugin(name, inst.checkout, PLUGIN_RULE));
  if (plugins.filter((plugin) => plugin.botBrowsers).length > 1) {
    throw new Error("only one plugin of an instance may give bots browsers of their own");
  }
  return plugins;
}

/**
 * The development config contract (contract.ts): exactly the generated
 * config, with the generated token, plus the fields seeding writes into each
 * bot's entry (its identity), and nothing else.
 */
export function devConfigContract(
  ports: InstancePorts = DEFAULT_PORTS,
  stateDir: string = devStateDir(),
  plugins: DevPlugin[] = [],
  options: StartOptions = {},
  chromium?: string,
): Contract {
  const contract = structuredClone(
    devConfig("", ports, stateDir, plugins, options, chromium),
  ) as unknown as Record<string, Record<string, unknown>>;
  // With accounts, the gateway itself writes profile entries (labels, sign-ins,
  // the CLI's saves): scripted accounts only, each of a closed shape.
  if (options.accounts) (contract as Record<string, unknown>).auth = authContract();
  (contract.gateway!.auth as Record<string, unknown>).token = matching(
    "a token",
    (value) => typeof value === "string" && /^\S+$/.test(value),
  );
  const entries = (contract.agents!.entries as Record<string, Record<string, unknown>>) ?? {};
  for (const bot of SEED_BOTS) {
    // `agents set-identity` during the seed.
    entries[bot.id]!.identity = optional({ name: bot.name, emoji: bot.emoji, theme: bot.theme });
  }
  // The CLI stamps the version that last wrote the config, and the migrations
  // it considers applied, whenever it writes it.
  (contract as Record<string, unknown>).meta = optional({
    lastTouchedVersion: optional("2026.10.6"),
    lastTouchedAt: optional(matching("a time stamp", (value) => typeof value === "string")),
    migrations: optional({
      modelPolicyAllowlist: optional(true),
      utilityModelSeparation: optional(true),
    }),
  });
  return contract as unknown as Contract;
}

/**
 * The guarantees the development gateway must keep, as one closed contract:
 * only the scripted model; token auth on loopback with explicit pairing;
 * every workspace inside the instance; no memory-search embeddings; a shell
 * only for the shell bot and only with approval; messages only between the
 * messaging pair; only the stand-in MCP server; file tools in the workspace;
 * web search only to the scripted server; only the allowed tools; and no other
 * key at all. Returns what is wrong, one line per difference, with its path.
 */
export function sandboxProblems(
  config: unknown,
  ports?: InstancePorts,
  stateDir?: string,
  plugins: DevPlugin[] = [],
  options: StartOptions = {},
  chromium?: string,
): string[] {
  return contractProblems(config, devConfigContract(ports, stateDir, plugins, options, chromium));
}

/** The plugins this run of the instance was started with and their digests, beside its run file. */
const pluginsFile = (inst: DevInstance) => join(inst.runDir, "plugins.json");

function recordedPlugins(inst: DevInstance): DevPlugin[] {
  if (!existsSync(pluginsFile(inst))) return [];
  const recorded = JSON.parse(readFileSync(pluginsFile(inst), "utf8")) as unknown;
  if (
    !Array.isArray(recorded) ||
    !recorded.every((p) => p && typeof p.name === "string" && typeof p.digest === "string")
  ) {
    throw new Error(`${pluginsFile(inst)} is not a list of plugins and their digests`);
  }
  // The instance's copies, checked again against the digests recorded at start.
  return (recorded as { name: string; digest: string }[]).map(({ name, digest }) =>
    checkedCopy(name, digest, inst.stateDir, PLUGIN_RULE),
  );
}

/** What this run of the instance was started with besides plugins, beside its run file. */
const startOptionsFile = (inst: DevInstance) => join(inst.runDir, "start-options.json");

export function recordedStartOptions(inst: { runDir: string }): StartOptions {
  const path = join(inst.runDir, "start-options.json");
  if (!existsSync(path)) return {};
  const recorded = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (
    recorded === null ||
    typeof recorded !== "object" ||
    Array.isArray(recorded) ||
    Object.keys(recorded).some((key) => key !== "accounts" && key !== "defaultLocalPairing") ||
    !["boolean", "undefined"].includes(typeof (recorded as StartOptions).accounts) ||
    !["boolean", "undefined"].includes(typeof (recorded as StartOptions).defaultLocalPairing)
  ) {
    throw new Error(`${path} is not a record of start options`);
  }
  return recorded as StartOptions;
}

function assertSandboxed(
  inst: DevInstance,
  ports: InstancePorts,
  plugins: DevPlugin[] = recordedPlugins(inst),
  options: StartOptions = recordedStartOptions(inst),
): void {
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(inst.configPath, "utf8"));
  } catch (error) {
    throw new Error(
      `cannot read ${inst.configPath}: ${String(error)}. Run \`pnpm dev-gateway reset${instanceFlag(inst)}\`.`,
      { cause: error },
    );
  }
  const problems = sandboxProblems(config, ports, inst.stateDir, plugins, options);
  if (problems.length > 0) {
    throw new Error(
      `the development gateway config is not sandboxed:\n  - ${problems.join("\n  - ")}\nRun \`pnpm dev-gateway reset${instanceFlag(inst)}\` to recreate it.`,
    );
  }
}

/** Write a new config and bootstrap token into the state folder `start` just created. */
function writeFreshConfig(
  inst: DevInstance,
  ports: InstancePorts,
  runId: string,
  plugins: DevPlugin[] = [],
  options: StartOptions = {},
): DevConnection {
  const token = randomBytes(24).toString("base64url");
  writeFileSync(
    inst.configPath,
    `${JSON.stringify(devConfig(token, ports, inst.stateDir, plugins, options), null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
  const connection = {
    url: `ws://127.0.0.1:${ports.gatewayPort}`,
    token,
    instance: inst.name,
    runId,
  };
  mkdirSync(inst.runDir, { recursive: true });
  writeFileAtomic(inst.connectionFile, `${JSON.stringify(connection, null, 2)}\n`);
  // The contract first: `config validate` loads plugins, so nothing runs
  // before a config that breaks it is refused.
  assertSandboxed(inst, ports, plugins, options);
  const validation = inst.runner.runSync(["config", "validate"]);
  if (validation.status !== 0) {
    throw new Error(`generated config is invalid:\n${validation.stdout}${validation.stderr}`);
  }
  if (options.accounts) {
    // Each account saved the way the gateway's own command line saves one,
    // its made-up credential on stdin; the config must still keep the contract.
    for (const account of SCRIPTED_ACCOUNTS) {
      const { args, stdin } = saveAccountCommand(account);
      const saved = inst.runner.runSync(args, { input: stdin });
      if (saved.status !== 0) {
        throw new Error(`could not save account ${account.id}:\n${saved.stdout}${saved.stderr}`);
      }
    }
    // `paste-token` rewrites its profile entry without the label; put every
    // label back as generated.
    const written = JSON.parse(readFileSync(inst.configPath, "utf8")) as {
      auth?: { profiles?: Record<string, Record<string, unknown>> };
    };
    for (const [id, entry] of Object.entries(accountProfiles())) {
      const profile = written.auth?.profiles?.[id];
      if (profile) profile.displayName = entry.displayName;
    }
    writeFileAtomic(inst.configPath, `${JSON.stringify(written, null, 2)}\n`);
    assertSandboxed(inst, ports, plugins, options);
  }
  return connection;
}

/** Healthy means the guard allows OpenClaw and the gateway answers; a refusal spawns nothing. */
async function gatewayHealthy(inst: DevInstance): Promise<boolean> {
  const runner = inst.runner;
  if (runner.refusal()) return false;
  if (!(await inst.listening(runner.gatewayPort()))) return false;
  const result = await runner.run(["gateway", "call", "health", "--json", "--timeout", "3000"]);
  return result.status === 0;
}

type ExecScope = {
  agentId?: string;
  mode?: { effective?: string };
  security?: { effective?: string };
  ask?: { effective?: string };
  askFallback?: { effective?: string };
};

/** What the gateway must report for a bot: denied, or for the shell bot, asking on every miss. */
export function execScopeProblem(scope: ExecScope): string | null {
  const got = `security ${scope.security?.effective ?? "unknown"}, ask ${scope.ask?.effective ?? "unknown"}`;
  if (scope.agentId === SHELL_BOT) {
    const asks =
      scope.mode?.effective === "ask" &&
      scope.security?.effective === "allowlist" &&
      scope.ask?.effective === "on-miss" &&
      scope.askFallback?.effective === "deny";
    return asks
      ? null
      : `exec for ${SHELL_BOT} must ask (allowlist, on-miss, fallback deny); it is ${got}`;
  }
  return scope.security?.effective === "deny"
    ? null
    : `exec for ${scope.agentId ?? "the default scope"} must be denied; it is ${got}`;
}

/** Ask the running gateway what exec policy each bot actually gets. */
export async function execPolicyProblems(inst: DevInstance): Promise<string[]> {
  const snapshot = parseJsonOutput<{ effectivePolicy?: { scopes?: ExecScope[] } }>(
    await must(inst, ["approvals", "get", "--json"]),
  );
  const scopes = snapshot.effectivePolicy?.scopes ?? [];
  if (scopes.length === 0) return ["the gateway reported no exec policy scopes"];
  const problems = scopes.flatMap((scope) => execScopeProblem(scope) ?? []);
  if (!scopes.some((scope) => scope.agentId === SHELL_BOT)) {
    problems.push(`the gateway reported no exec policy for ${SHELL_BOT}`);
  }
  return problems;
}

async function assertExecDenied(inst: DevInstance): Promise<void> {
  const problems = await execPolicyProblems(inst);
  if (problems.length > 0)
    throw new Error(`exec policy is not as configured:\n  - ${problems.join("\n  - ")}`);
}

/** Refuse, changing nothing, when processes this checkout cannot prove its own may run on it. */
function assertNotInUse(inst: DevInstance): void {
  const reason = inUseRefusal(
    inst.stateDir,
    inst.name,
    readRunRecord(inst.runFile),
    inst.checkout,
    inst.identify,
  );
  if (reason) throw new StateInUseError(reason);
}

/** The ports a listener on would mean the instance may still be in use. */
function instancePortsToCheck(inst: DevInstance): number[] {
  if (inst.name === null) return [GATEWAY_PORT, PROVIDER_PORT];
  const marker = readMarker(inst.stateDir);
  const ports = [marker?.gatewayPort, marker?.providerPort].filter(isNamedInstancePort);
  // A browser left running on the instance's ports also means it is in use.
  let bots: string[] = [];
  try {
    bots = recordedPlugins(inst).find((plugin) => plugin.botBrowsers)?.botBrowsers?.bots ?? [];
  } catch {
    // An unreadable record adds nothing; the processes are checked anyway.
  }
  if (bots.length > 0 && ports.length === 2) {
    const { pagesPort, defaultCdpPort, botCdpPorts } = browserPorts(
      { gatewayPort: ports[0]!, providerPort: ports[1]! },
      bots,
    );
    ports.push(pagesPort, defaultCdpPort, ...botCdpPorts);
  }
  return ports;
}

/**
 * Why the instance's folder must not be deleted, or null. Deleting needs proof
 * that nothing is running: a valid marker naming this instance, every recorded
 * process proven gone, and nothing listening on the instance's ports.
 */
async function deletionRefusal(inst: DevInstance): Promise<string | null> {
  if (ownership(inst.stateDir) !== "owned") return null;
  const busy = activityRefusal(inst.stateDir, inst.name, inst.identify);
  if (busy) return busy;
  for (const port of instancePortsToCheck(inst)) {
    if (await inst.listening(port)) {
      return `${label(inst)} (${inst.stateDir}) may still be in use: something is listening on its port ${port}. Nothing was changed.`;
    }
  }
  return null;
}

/**
 * Hold the instance's lifecycle lock, shared by start, stop, reset and prune.
 * A start holds it until its gateway is seeded, so others wait for that.
 */
function withInstanceLock<T>(inst: DevInstance, fn: () => Promise<T>): Promise<T> {
  return withLock(instanceLockPath(inst.home, inst.name), fn, {
    what: `the lifecycle lock of ${label(inst)}`,
    timeoutMs: 10 * 60_000,
  });
}

/**
 * Spawn one of the instance's processes so that a start killed at any instant
 * leaves a record of it: the intent is recorded first, the process is spawned
 * behind its gate, its PID and start time complete the record, and only then
 * may it run. A process that cannot be recorded is made to exit unrun.
 */
function spawnRecorded(
  inst: DevInstance,
  runId: string,
  role: SpawnedRole,
  spawnIt: () => Gated,
): void {
  recordPending(inst.stateDir, runId, role);
  const gated = spawnIt();
  gated.child.unref();
  try {
    recordProcess(inst.stateDir, runId, role, gated.child.pid, inst.identify);
  } catch (error) {
    gated.abort();
    throw error;
  }
  gated.release();
}

/**
 * Start the scripted node host (`scripted-node.ts`) on a healthy gateway, recorded
 * like the gateway, and pair it: its device request and then its command
 * approval, each found by what it must be and approved by id. Runs inside
 * `start`, under its lock.
 */
async function startScriptedNode(
  inst: DevInstance,
  runId: string,
  ports: InstancePorts,
): Promise<void> {
  const connection = readDevConnection(inst.connectionFile);
  if (!connection) throw new Error(`${label(inst)} has no connection file`);
  const dir = scriptedNodeDir(inst.stateDir);
  assertInside(dir, inst.stateDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const nodeLog = openSync(join(inst.runDir, "node.log"), "w");
  spawnRecorded(inst, runId, "node", () =>
    inst.runner.spawnNodeGated(
      scriptedNodeArgs(ports.gatewayPort),
      scriptedNodeEnv(inst.stateDir, connection.token),
      { stdio: ["ignore", nodeLog, nodeLog] },
    ),
  );
  closeSync(nodeLog);
  const json = async (args: string[]) =>
    JSON.parse(await must(inst, [...args, "--json"])) as unknown;
  let device: { requestId: string; deviceId: string } | null = null;
  await waitFor(
    `${SCRIPTED_NODE_NAME}'s pairing request`,
    async () => (device = nodeDeviceRequest(await json(["devices", "list"]))) !== null,
    120_000,
  );
  await must(inst, ["devices", "approve", device!.requestId]);
  let request: string | null = null;
  await waitFor(
    `${SCRIPTED_NODE_NAME}'s command approval request`,
    async () =>
      (request = nodeCommandRequest(await json(["nodes", "pending"]), device!.deviceId)) !== null,
    120_000,
  );
  await must(inst, ["nodes", "approve", request!]);
}

const RUN_ID_PATTERN = /^[0-9a-f]{48}$/;

/**
 * The only way to start the gateway: on a state folder this command has just
 * created empty. The tool's own gateway is stopped and its state deleted first;
 * foreign state, and state whose processes this checkout cannot prove its own,
 * is refused untouched. Ends with a seeded, verified gateway. `runId` lets a
 * caller that must clean up later (the end-to-end tests) know it in advance.
 */
export async function start(
  inst: DevInstance,
  options: {
    seed?: boolean;
    runId?: string;
    plugins?: string[];
    accounts?: boolean;
    defaultLocalPairing?: boolean;
    /** A paired machine: the gateway's own node host (`scripted-node.ts`); named instances only. */
    node?: boolean;
  } = {},
): Promise<void> {
  assertInstanceStateDir(inst.stateDir, inst.name, inst.home);
  if (options.node && inst.name === null) {
    throw new Error("the default instance never has a paired machine; use --instance <name>");
  }
  const runId = options.runId ?? newRunId();
  if (!RUN_ID_PATTERN.test(runId)) throw new Error("--run-id must be 48 lowercase hex digits");
  if (options.accounts && inst.name === null) {
    throw new Error("the default instance never has scripted accounts; use --instance <name>");
  }
  if (options.defaultLocalPairing && inst.name === null) {
    throw new Error(
      "the default instance always requires explicit pairing; use --instance <name> with --default-local-pairing",
    );
  }
  const startOptions: StartOptions = {
    ...(options.accounts ? { accounts: true } : {}),
    ...(options.defaultLocalPairing ? { defaultLocalPairing: true } : {}),
  };
  // Refused before anything changes: a name that is not this checkout's own
  // plugin, or whose addition breaks the rule for plugins.
  const plugins = loadPlugins(inst, options.plugins ?? []);
  const signIns = plugins.filter((plugin) => plugin.providers.length > 0);
  if (signIns.length > 0 && !options.accounts) {
    throw new Error(
      `plugin ${signIns[0]!.name} declares sign-ins for the scripted account providers; start with --with-accounts`,
    );
  }
  const browserBots = plugins.find((plugin) => plugin.botBrowsers)?.botBrowsers?.bots ?? [];
  const browserPortsOf = (ports: InstancePorts) => {
    const { pagesPort, defaultCdpPort, botCdpPorts } = browserPorts(ports, browserBots);
    return [pagesPort, defaultCdpPort, ...botCdpPorts];
  };
  // Found before anything changes, so a missing Chromium refuses the start.
  if (browserBots.length > 0) developmentChromium(inst.checkout);
  const runner = inst.runner;
  await withInstanceLock(inst, async () => {
    if (ownership(inst.stateDir) === "foreign") throw new ForeignStateError(inst.stateDir);
    assertNotInUse(inst);
    await stopLocked(inst);
    const blocked = await deletionRefusal(inst);
    if (blocked) throw new StateInUseError(blocked);
    const self = inst.identify(process.pid);
    if (self.state !== "alive") throw new Error("could not determine this process's start time");
    // Ports are chosen and recorded in the new marker under one lock, so two
    // starts on this machine never take the same ones.
    const ports = await withLock(
      portLockPath(inst.home),
      async () => {
        const picked =
          inst.name === null
            ? DEFAULT_PORTS
            : await choosePorts(
                inst.name,
                inst.home,
                undefined,
                browserPortOffsets(browserBots.length),
              );
        for (const port of [
          picked.gatewayPort,
          picked.providerPort,
          ...(browserBots.length > 0 ? browserPortsOf(picked) : []),
        ]) {
          if (await inst.listening(port)) {
            throw new Error(`port ${port} is in use by a process this tool did not start`);
          }
        }
        prepareFreshState(
          inst.stateDir,
          runId,
          {
            instance: inst.name,
            ...picked,
            checkout: inst.checkout,
            startPid: process.pid,
            startIdentity: self.identity,
          },
          inst.identify,
        );
        return picked;
      },
      { what: "the dev-gateway port lock" },
    );
    writeState(inst, {
      runId,
      instance: inst.name,
      checkout: inst.checkout,
      ...ports,
      startedAt: new Date().toISOString(),
    });
    runner.freshRunId = runId;
    try {
      for (const plugin of plugins) {
        console.log(trustedCodeNotice(plugin));
        copyPlugin(plugin, inst.stateDir, PLUGIN_RULE);
      }
      writeFileAtomic(
        pluginsFile(inst),
        `${JSON.stringify(plugins.map(({ name, digest }) => ({ name, digest })))}\n`,
      );
      writeFileAtomic(startOptionsFile(inst), `${JSON.stringify(startOptions)}\n`);
      writeFreshConfig(inst, ports, runId, plugins, startOptions);
      const providerLog = openSync(join(inst.runDir, "provider.log"), "w");
      spawnRecorded(inst, runId, "provider", () =>
        gatedSpawn(
          inst.spawn,
          process.execPath,
          [fileURLToPath(new URL("./provider-main.ts", import.meta.url))],
          {
            detached: true,
            stdio: ["ignore", providerLog, providerLog],
            env: {
              ...providerEnv(process.env, ports.providerPort),
              // The pages the development browser may open, when there is one.
              ...(browserBots.length > 0
                ? { SCRIPTED_PAGES_PORT: String(browserPorts(ports, browserBots).pagesPort) }
                : {}),
            },
          },
        ),
      );
      closeSync(providerLog);
      await waitFor("the scripted provider", () => inst.listening(ports.providerPort), 10_000);
      if (browserBots.length > 0) {
        const { pagesPort } = browserPorts(ports, browserBots);
        await waitFor("the scripted pages", () => inst.listening(pagesPort), 10_000);
      }

      const gatewayLog = openSync(join(inst.runDir, "gateway.log"), "w");
      spawnRecorded(inst, runId, "gateway", () =>
        runner.spawnGated(
          ["gateway", "run", "--port", String(ports.gatewayPort), "--bind", "loopback"],
          { stdio: ["ignore", gatewayLog, gatewayLog] },
        ),
      );
      closeSync(gatewayLog);
    } finally {
      // From here on OpenClaw runs only while this start's gateway is alive.
      runner.freshRunId = null;
    }
    // The lock is held until the gateway is healthy, sandboxed and seeded, so
    // no other command acts on an instance that is still starting.
    // A ceiling on a condition, not a wait: on a heavily loaded machine a cold start of the
    // gateway has taken more than 90 seconds.
    await waitFor("the development gateway", () => gatewayHealthy(inst), 240_000);
    await assertExecDenied(inst);
    if (options.node) await startScriptedNode(inst, runId, ports);
    const marker = readMarker(inst.stateDir);
    console.log(
      `Development gateway (${label(inst)}) ready on ws://127.0.0.1:${ports.gatewayPort}`,
    );
    console.log(`  profile         openclaw ${profileArgs(inst.name).join(" ")}`);
    console.log(`  state           ${inst.stateDir}`);
    console.log(
      `  scripted model  http://127.0.0.1:${ports.providerPort}/v1 (pid ${marker?.providerPid})`,
    );
    console.log(`  gateway         pid ${marker?.gatewayPid}, logs in ${inst.runDir}`);
    if (options.node) {
      console.log(`  machine         ${SCRIPTED_NODE_NAME}, node host pid ${marker?.nodePid}`);
    }
    if (browserBots.length > 0) {
      const { pagesPort, botCdpPorts } = browserPorts(ports, browserBots);
      console.log(`  scripted pages  http://127.0.0.1:${pagesPort}/scripted/pages/sign-in`);
      browserBots.forEach((bot, i) =>
        console.log(`  browser         ${bot}: profile ${botProfile(bot)}, port ${botCdpPorts[i]}`),
      );
    }
    // Pip's workspace holds a picture and a git checkout for the Work pane's Files tab,
    // seeded or not: the scenario check reads the picture on an unseeded instance.
    const filesWorkspace = join(inst.stateDir, "workspaces", FILES_BOT);
    assertInside(filesWorkspace, inst.stateDir);
    seedWorkspaceFiles(filesWorkspace);
    // Unseeded starts are for checks that need a running gateway, not its data.
    if (options.seed !== false) await seed(inst);
  });
}

/**
 * Direct children of a process, each with its identity at the time it was
 * listed. A child that cannot be listed or identified is not signalled later.
 */
function childProcesses(pid: number, identify: Identify): { pid: number; identity: string }[] {
  const result = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8", timeout: 5000 });
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    console.log(`Could not list the children of pid ${pid}; none of them will be signalled`);
    return [];
  }
  return result.stdout
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter(validPid)
    .flatMap((child) => {
      const found = identify(child);
      return found.state === "alive" ? [{ pid: child, identity: found.identity }] : [];
    });
}

type StopTarget = { role: string; pid: number; identity: string; port?: number };

/** How long a stopped process's port may stay open once its PID is gone. */
export const PORT_RELEASE_MS = 10_000;

/**
 * Wait until nothing listens on the port a stopped process held. Its PID can
 * look gone before its sockets are closed: a gateway killed while its threads
 * are busy can show as a zombie while its last threads still hold its
 * listening socket. Null once the port is closed; what is wrong, naming the
 * process and the port, when it is still open after `inst.portReleaseMs`.
 */
async function portReleased(inst: DevInstance, target: StopTarget): Promise<string | null> {
  if (target.port === undefined) return null;
  const deadline = Date.now() + inst.portReleaseMs;
  while (await inst.listening(target.port)) {
    if (Date.now() >= deadline) {
      return `the ${target.role} (pid ${target.pid}) has exited, but its port ${target.port} is still open after ${inst.portReleaseMs / 1000} s`;
    }
    await sleep(100);
  }
  return null;
}

/**
 * The development browser's processes on an instance: Chromium and its
 * helpers, found by an argument naming the instance's own browser folder
 * (`--user-data-dir=<state>/browser/…`, a helper's `--database=…`). A helper
 * can outlive the browser and leave the gateway's process tree, so it is
 * found by its arguments, not by its parent. A process that merely mentions
 * the folder otherwise is not one of them.
 */
export function browserProcesses(
  stateDir: string,
  rows: { pid: number; command: string }[],
): number[] {
  const folder = `${stateDir}/browser/`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const argument = new RegExp(`(?:^|\\s)--[a-z][a-z0-9-]*=${folder}`);
  return rows
    .filter((row) => row.pid !== process.pid && argument.test(row.command))
    .map((row) => row.pid);
}

/** Every process with its full command line, or null when `ps` cannot say. */
export function listProcesses(): { pid: number; command: string }[] | null {
  const result = spawnSync("ps", ["-axww", "-o", "pid=,command="], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), command: match[2]! }] : [];
  });
}

/** The process can exit after its identity was checked and before the signal arrives. */
function signalIfPresent(pid: number, signal: NodeJS.Signals): boolean {
  try {
    return process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

/** How long the browser's processes get to exit by themselves, then after each signal. */
export const BROWSER_EXIT_WAITS = { own: 10_000, term: 5_000, kill: 3_000 };

/**
 * Wait until none of the instance's browser processes is left: first for
 * them to exit with their browser, then stopping those still there, each by
 * PID and only while it is still the process that was listed. True once none
 * is left; false when that could not be confirmed.
 */
export async function settleBrowserProcesses(
  inst: { stateDir: string; name: string | null; identify: Identify },
  waits = BROWSER_EXIT_WAITS,
): Promise<boolean> {
  const find = () => {
    const rows = listProcesses();
    if (!rows) return null;
    return browserProcesses(inst.stateDir, rows).flatMap((pid) => {
      const found = inst.identify(pid);
      return found.state === "alive" ? [{ pid, identity: found.identity }] : [];
    });
  };
  let left = find();
  if (left === null) {
    console.log(`Could not list processes to find the browser of ${label(inst)}`);
    return false;
  }
  if (left.length === 0) return true;
  const waitGone = async (ms: number) => {
    const deadline = Date.now() + ms;
    while (left!.length > 0 && Date.now() < deadline) {
      await sleep(200);
      left = find() ?? left;
    }
  };
  const count = left.length;
  await waitGone(waits.own);
  let stopped = 0;
  for (const [signal, ms] of [
    ["SIGTERM", waits.term],
    ["SIGKILL", waits.kill],
  ] as const) {
    if (left.length === 0) break;
    for (const proc of left) {
      if (processState(proc.pid, proc.identity, inst.identify) === "alive") {
        if (signalIfPresent(proc.pid, signal)) stopped += 1;
      }
    }
    await waitGone(ms);
  }
  if (left.length > 0) {
    console.log(
      `Could not confirm that the browser processes of ${label(inst)} stopped (pids ${left.map((p) => p.pid).join(", ")})`,
    );
    return false;
  }
  console.log(
    stopped > 0
      ? `Stopped the browser's leftover processes of ${label(inst)} (${stopped} signals)`
      : `Waited for the browser's ${count} processes of ${label(inst)} to exit`,
  );
  return true;
}

/**
 * Stop one proven process: its identity is checked again right before every
 * signal, so a PID the system reused is never signalled. Its direct children
 * are listed while it is still the proven parent, and each is signalled only
 * if it is still that same process. Returns false when its end could not be
 * confirmed.
 */
async function stopProcess(target: StopTarget, identify: Identify): Promise<boolean> {
  const state = () => processState(target.pid, target.identity, identify);
  if (state() !== "alive") return state() === "dead";
  const children = childProcesses(target.pid, identify);
  if (state() !== "alive") return state() === "dead";
  signalIfPresent(target.pid, "SIGTERM");
  // A lookup can fail for a moment while a process exits, so the wait goes on
  // through "unknown"; only a process proven alive is ever killed.
  const settled = async (ms: number) => {
    const deadline = Date.now() + ms;
    let now = state();
    while (now !== "dead" && Date.now() < deadline) {
      await sleep(200);
      now = state();
    }
    return now;
  };
  let forced = false;
  if ((await settled(15_000)) === "alive") {
    forced = signalIfPresent(target.pid, "SIGKILL");
    await settled(5_000);
  }
  if (state() !== "dead") {
    console.log(
      `Signalled the ${target.role} (pid ${target.pid}) but could not confirm it stopped`,
    );
    return false;
  }
  console.log(
    `Stopped the ${target.role} (pid ${target.pid})${forced ? " after a forced kill" : ""}`,
  );
  for (const child of children) {
    if (
      processState(child.pid, child.identity, identify) === "alive" &&
      signalIfPresent(child.pid, "SIGTERM")
    ) {
      console.log(`Stopped a leftover child of the ${target.role} (pid ${child.pid})`);
    }
  }
  return true;
}

/**
 * Stop the processes of this checkout's run of the instance, with the
 * lifecycle lock held. A process is signalled only when the folder is the
 * tool's own, its marker is valid, the marker's run id, instance and checkout
 * agree with this checkout's run file, and the live process has the PID and
 * start time the marker recorded at spawn. Anything else is refused, says what
 * disagrees, and signals nothing.
 */
async function stopLocked(inst: DevInstance): Promise<void> {
  if (!lstatOrNull(inst.runFile)) {
    console.log(
      `Nothing to stop: this checkout has no running processes on record for ${label(inst)}.`,
    );
    return;
  }
  const refuse = (why: string): never => {
    throw new StateInUseError(`Not stopping ${label(inst)}: ${why}. Nothing was signalled.`);
  };
  const run = readRunRecord(inst.runFile);
  if (!run) {
    refuse(
      `${inst.runFile} is not a run file this version of the tool wrote. ` +
        "Stop its processes yourself if they are still running, then delete it",
    );
  }
  const owner = ownership(inst.stateDir);
  if (owner === "foreign") throw new ForeignStateError(inst.stateDir);
  const marker = owner === "owned" ? readMarker(inst.stateDir)! : null;
  if (!marker || marker.runId !== run!.runId) {
    // The folder is gone or holds another run: the file proves nothing about
    // any process, so it is dropped and nothing is signalled.
    rmSync(inst.runFile, { force: true });
    console.log(
      `Discarded this checkout's stale run file for ${label(inst)}: ` +
        `${marker ? "its folder now holds another run" : "its folder is gone"}. Nothing was signalled.`,
    );
    return;
  }
  const problems = markerProblems(marker, inst.name);
  if (problems.length > 0) refuse(`its marker cannot be trusted: ${problems.join("; ")}`);
  if (!runMatches(run, marker, inst.name, inst.checkout)) {
    refuse(
      `this checkout's run file and the marker disagree (run file: instance ${JSON.stringify(run!.instance)}, ` +
        `checkout ${run!.checkout}; marker: instance ${JSON.stringify(marker.instance ?? null)}, ` +
        `checkout ${marker.checkout}; this checkout: ${inst.checkout})`,
    );
  }
  const targets: StopTarget[] = [];
  /** Recorded processes already gone, perhaps ended by an earlier stop: only their ports are checked. */
  const exited: StopTarget[] = [];
  for (const role of ["node", "gateway", "provider"] as const) {
    // A start without `--with-node` records no node.
    if (role === "node" && marker.nodePid === undefined) continue;
    const pid = marker[`${role}Pid`];
    const identity = marker[`${role}Identity`];
    const verdict = processVerdict(pid, identity, inst.identify);
    if (verdict.state === "unknown") {
      refuse(
        `could not determine whether its ${role} (pid ${String(pid)}) is running: ${verdict.reason}`,
      );
    }
    if (verdict.state !== "alive" && verdict.state !== "dead") continue;
    // The node host listens on no port of its own.
    const port = role === "node" ? undefined : marker[`${role}Port`];
    const target = { role, pid: pid!, identity: identity!, ...(port ? { port } : {}) };
    (verdict.state === "alive" ? targets : exited).push(target);
  }
  let confirmed = true;
  const openPorts: string[] = [];
  // Stopped means its PID is gone and so is its listener: a reset checks the port next.
  // Only a process proven alive is signalled; one already gone has only its port waited for.
  for (const target of [...targets, ...exited]) {
    if (targets.includes(target) && !(await stopProcess(target, inst.identify))) {
      confirmed = false;
      continue;
    }
    const open = await portReleased(inst, target);
    if (open) openPorts.push(open);
  }
  if (openPorts.length > 0) confirmed = false;
  // The gateway's browser and its helpers go with it, but not always at once.
  if (confirmed) confirmed = await settleBrowserProcesses(inst);
  if (!confirmed) {
    throw new StateInUseError(
      `${label(inst)}: could not confirm that every process stopped; its records are kept.` +
        (openPorts.length > 0 ? ` ${openPorts.join("; ")}.` : ""),
    );
  }
  rmSync(inst.runFile, { force: true });
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** Stop the processes this checkout started for the instance, once proven. Nothing else. */
export async function stop(inst: DevInstance): Promise<void> {
  await withInstanceLock(inst, () => stopLocked(inst));
}

/**
 * Stop, then delete the instance's state folder, if it is the tool's own, its
 * marker names this instance and nothing can still be running on it. Foreign
 * state is left alone. Only this one instance is affected. With `runId`, only
 * the folder of that run is removed.
 */
export async function reset(inst: DevInstance, options: { runId?: string } = {}): Promise<void> {
  assertInstanceStateDir(inst.stateDir, inst.name, inst.home);
  if (options.runId !== undefined && !RUN_ID_PATTERN.test(options.runId)) {
    throw new Error("--run-id must be 48 lowercase hex digits");
  }
  await withInstanceLock(inst, async () => {
    const owner = ownership(inst.stateDir);
    if (owner === "foreign") throw new ForeignStateError(inst.stateDir);
    if (owner === "owned" && options.runId !== undefined) {
      const runId = readMarker(inst.stateDir)!.runId;
      if (runId !== options.runId) {
        throw new StateInUseError(
          `${label(inst)} (${inst.stateDir}) holds another run than ${options.runId}. Nothing was changed.`,
        );
      }
    }
    assertNotInUse(inst);
    await stopLocked(inst);
    if (ownership(inst.stateDir) === "owned") {
      // Also a browser left by a gateway that is gone: nothing of it may outlive its folder.
      if (!(await settleBrowserProcesses(inst))) {
        throw new StateInUseError(
          `${label(inst)} (${inst.stateDir}): its browser's processes are still running. Nothing was deleted.`,
        );
      }
      const blocked = await deletionRefusal(inst);
      if (blocked) throw new StateInUseError(blocked);
      rmSync(inst.stateDir, { recursive: true });
      console.log(`Removed ${inst.stateDir}`);
    }
    rmSync(inst.connectionFile, { force: true });
    if (inst.name !== null) rmSync(inst.runDir, { recursive: true, force: true });
  });
}

/** Report what is running. OpenClaw is asked only when the guard allows it. */
export async function status(
  inst: DevInstance,
  log: (line: string) => void = console.log,
): Promise<void> {
  const runner = inst.runner;
  const connection = readDevConnection(inst.connectionFile);
  const owner = ownership(runner.stateDir);
  log(`instance    ${inst.name ?? "(default)"}`);
  log(`state dir   ${runner.stateDir} (${owner})`);
  const marker = owner === "owned" ? readMarker(runner.stateDir) : null;
  for (const role of ["provider", "gateway", "node"] as const) {
    if (role === "node" && marker?.nodePid === undefined && marker?.nodePending !== true) continue;
    const pid = marker?.[`${role}Pid`];
    const state =
      marker?.[`${role}Pending`] === true
        ? "pending"
        : processState(pid, marker?.[`${role}Identity`], inst.identify);
    const shown =
      state === "alive"
        ? `running, pid ${pid}`
        : state === "unknown"
          ? `unknown (pid ${String(pid)})`
          : state === "pending"
            ? "being started"
            : "stopped";
    log(`${role.padEnd(12)}${shown}`);
  }
  const inUse = inUseRefusal(
    runner.stateDir,
    inst.name,
    readRunRecord(runner.runFile),
    inst.checkout,
    inst.identify,
  );
  if (inUse) log(`in use      ${inUse}`);
  const refusal = runner.refusal();
  if (refusal) log(`healthy     no (not checked: ${refusal})`);
  else log(`healthy     ${(await gatewayHealthy(inst)) ? "yes" : "no"}`);
  if (connection) log(`url         ${connection.url}`);
}

async function must(inst: DevInstance, args: string[]): Promise<string> {
  const result = await inst.runner.run(args);
  if (result.status !== 0) {
    throw new Error(
      `openclaw ${profileArgs(inst.name).join(" ")} ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
}

type AgentRow = { id: string; workspace?: string };

async function existingSessionKeys(inst: DevInstance, botId: string): Promise<Set<string>> {
  const out = await must(inst, ["sessions", "--agent", botId, "--json", "--limit", "all"]);
  const parsed = parseJsonOutput<{ sessions?: Array<{ key?: string }> }>(out);
  return new Set((parsed.sessions ?? []).flatMap((row) => (row.key ? [row.key] : [])));
}

/** Create or restyle a bot. These commands write the gateway config, so they run one at a time. */
async function configureBot(
  inst: DevInstance,
  bot: SeedBot,
  agents: Map<string, AgentRow>,
): Promise<void> {
  const workspace = agents.get(bot.id)?.workspace ?? join(inst.stateDir, "workspaces", bot.id);
  assertInside(workspace, inst.stateDir);
  if (!agents.has(bot.id)) {
    await must(inst, [
      "agents",
      "add",
      bot.id,
      "--non-interactive",
      "--workspace",
      workspace,
      "--model",
      MODEL_REF,
      "--json",
    ]);
  }
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "AGENTS.md"), bot.instructions);
  await must(inst, [
    "agents",
    "set-identity",
    "--agent",
    bot.id,
    "--name",
    bot.name,
    "--emoji",
    bot.emoji,
    "--theme",
    bot.theme,
    "--json",
  ]);
}

type AgentRunOutput = {
  status?: string;
  summary?: string;
  result?: {
    meta?: { aborted?: boolean; stopReason?: string; finalAssistantVisibleText?: string };
  };
};

/** The text a scripted turn ends with: the text steps of its last round. */
export function expectedFinalText(turn: SeedTurn): string {
  const last = turn.rounds.at(-1) ?? [];
  return last
    .flatMap((step) => (step.kind === "text" ? [step.text] : []))
    .join("")
    .trim();
}

/** `openclaw agent` waits for the run's terminal outcome; check that it is the one we scripted. */
export function checkTurnOutcome(output: AgentRunOutput, turn: SeedTurn): string | null {
  const meta = output.result?.meta;
  if (output.status !== "ok" || output.summary !== "completed") {
    return `run ended with status ${output.status ?? "?"} (${output.summary ?? "no summary"})`;
  }
  if (meta?.aborted) return "run was aborted";
  if (meta?.stopReason !== "stop")
    return `run stopped with ${meta?.stopReason ?? "no stop reason"}`;
  const actual = (meta.finalAssistantVisibleText ?? "").trim();
  const expected = expectedFinalText(turn);
  if (actual !== expected)
    return `final reply differs from the script: ${JSON.stringify(actual.slice(0, 80))}`;
  return null;
}

type HistoryMessage = { role?: string; stopReason?: string; isError?: boolean; content?: unknown };

/** Check a seeded session's durable history against its script. Returns what is wrong. */
export function checkHistory(messages: HistoryMessage[], task: SeedTask): string[] {
  const problems: string[] = [];
  const users = messages.filter((m) => m.role === "user").length;
  if (users !== task.turns.length)
    problems.push(`expected ${task.turns.length} user turns, found ${users}`);
  const expectedTools = task.turns
    .flatMap((turn) => turn.rounds.flat())
    .filter((step) => step.kind === "tool").length;
  const results = messages.filter((m) => m.role === "toolResult");
  if (results.length !== expectedTools) {
    problems.push(`expected ${expectedTools} tool results, found ${results.length}`);
  }
  if (results.some((m) => m.isError)) problems.push("a tool call failed");
  // The scripted reasoning, calls and their arguments, and each turn's final text.
  const steps = task.turns.flatMap((turn) => turn.rounds.flat());
  const blocks = messages.flatMap((m) =>
    m.role === "assistant" && Array.isArray(m.content)
      ? (m.content as Record<string, unknown>[])
      : [],
  );
  const reasoning = blocks.flatMap((b) => (b.type === "thinking" ? [String(b.thinking)] : []));
  const scriptedReasoning = steps.flatMap((step) => (step.kind === "reasoning" ? [step.text] : []));
  if (reasoning.join("\n") !== scriptedReasoning.join("\n")) {
    problems.push("the reasoning differs from the script");
  }
  const calls = blocks.flatMap((b) =>
    b.type === "toolCall" ? [JSON.stringify([b.name, b.arguments])] : [],
  );
  const scriptedCalls = steps.flatMap((step) =>
    step.kind === "tool" ? [JSON.stringify([step.name, step.arguments])] : [],
  );
  if (JSON.stringify(calls) !== JSON.stringify(scriptedCalls)) {
    problems.push("the tool calls or their arguments differ from the script");
  }
  const texts = messages
    .filter((m) => m.role === "assistant" && m.stopReason === "stop")
    .map((m) =>
      (Array.isArray(m.content) ? (m.content as Record<string, unknown>[]) : [])
        .flatMap((b) => (b.type === "text" ? [String(b.text)] : []))
        .join("")
        .trim(),
    );
  if (JSON.stringify(texts) !== JSON.stringify(task.turns.map(expectedFinalText))) {
    problems.push("the replies differ from the script");
  }
  const last = messages.at(-1);
  if (last?.role !== "assistant" || last.stopReason !== "stop") {
    problems.push("the session does not end with a completed assistant reply");
  }
  return problems;
}

/** Run a bot's scripted conversations. Sessions are independent, so bots run in parallel. */
async function seedConversations(inst: DevInstance, bot: SeedBot): Promise<void> {
  const existing = await existingSessionKeys(inst, bot.id);
  for (const task of bot.tasks) {
    const key = sessionKeyFor(bot.id, task.slug);
    const alreadySeeded = existing.has(key);
    for (const turn of alreadySeeded ? [] : task.turns) {
      const output = parseJsonOutput<AgentRunOutput>(
        await must(inst, [
          "agent",
          "--agent",
          bot.id,
          "--session-key",
          key,
          "--message",
          turn.prompt,
          "--thinking",
          "low",
          "--json",
        ]),
      );
      const problem = checkTurnOutcome(output, turn);
      if (problem) throw new Error(`${bot.name} / ${task.label}: ${problem}`);
    }
    if (!alreadySeeded)
      await must(inst, [
        "gateway",
        "call",
        "sessions.patch",
        "--params",
        JSON.stringify({ key, label: task.label }),
        "--json",
      ]);
    const history = parseJsonOutput<{ messages?: HistoryMessage[] }>(
      await must(inst, [
        "gateway",
        "call",
        "chat.history",
        "--params",
        JSON.stringify({ sessionKey: key, limit: 200 }),
        "--json",
      ]),
    );
    const problems = checkHistory(history.messages ?? [], task);
    if (problems.length > 0) {
      const advice = alreadySeeded
        ? ` (run \`pnpm dev-gateway start${instanceFlag(inst)}\` for a fresh gateway)`
        : "";
      throw new Error(`${bot.name} / ${task.label}: ${problems.join("; ")}${advice}`);
    }
    console.log(
      `  ${bot.name}: ${task.label}${alreadySeeded ? " (already seeded, verified)" : ""}`,
    );
  }
}

export async function seed(inst: DevInstance): Promise<void> {
  const refusal = inst.runner.refusal();
  if (refusal) throw new Error(refusal);
  if (!(await gatewayHealthy(inst))) {
    throw new Error(
      `the development gateway is not running. Run \`pnpm dev-gateway start${instanceFlag(inst)}\` first.`,
    );
  }
  const listed = parseJsonOutput<AgentRow[] | { agents: AgentRow[] }>(
    await must(inst, ["agents", "list", "--json"]),
  );
  const rows = Array.isArray(listed) ? listed : listed.agents;
  const agents = new Map(rows.map((row) => [row.id, row]));
  console.log("Seeding sample bots and conversations");
  for (const bot of SEED_BOTS) await configureBot(inst, bot, agents);
  // Configuring the bots rewrote the config; it must still keep every guarantee.
  assertSandboxed(inst, instancePorts(inst));
  await assertExecDenied(inst);
  await Promise.all(SEED_BOTS.map((bot) => seedConversations(inst, bot)));
  await seedScenarioExamples(inst);
  console.log("Seed complete");
}

/** The ports an instance runs on: fixed for the default instance, from its marker otherwise. */
export function instancePorts(inst: DevInstance): InstancePorts {
  if (inst.name === null) return DEFAULT_PORTS;
  const marker = readMarker(inst.stateDir);
  if (!marker?.gatewayPort || !marker.providerPort) {
    throw new Error(`${inst.stateDir} records no ports`);
  }
  return { gatewayPort: marker.gatewayPort, providerPort: marker.providerPort };
}

/**
 * Connect a paired operator client to the instance: a new device key, its
 * pairing request approved by id through the guarded runner.
 */
export async function openOperator(
  inst: DevInstance,
  displayName: string,
  scopes: string[],
  caps: string[],
): Promise<OperatorSession> {
  const connection = readDevConnection(inst.connectionFile);
  if (!connection) throw new Error(`${label(inst)} has no connection file; start it first`);
  return OperatorSession.open({
    url: connection.url,
    token: connection.token,
    scopes,
    caps,
    displayName,
    approvePairing: async (requestId) => {
      await must(inst, ["devices", "approve", requestId]);
    },
  });
}

/**
 * The finished examples of live situations. A paired client plays the user:
 * it sends each prompt, answers the question and resolves the approval. Runs
 * one example at a time, after the scripted tasks, then unpairs itself.
 */
async function seedScenarioExamples(inst: DevInstance): Promise<void> {
  const keys = new Map<string, Set<string>>();
  for (const botId of new Set(SCENARIO_EXAMPLES.map((example) => example.botId))) {
    keys.set(botId, await existingSessionKeys(inst, botId));
  }
  console.log(
    `Seeding live examples as the user, through a paired client "${SEED_CLIENT}" (scopes ${SEED_SCOPES.join(", ")})`,
  );
  const op = await openOperator(inst, SEED_CLIENT, SEED_SCOPES, SEED_CAPS);
  try {
    for (const example of SCENARIO_EXAMPLES) {
      const key = sessionKeyFor(example.botId, example.slug);
      const bot = SEED_BOTS.find((b) => b.id === example.botId)?.name ?? example.botId;
      if (keys.get(example.botId)?.has(key)) {
        await verifyExample(op, example);
        console.log(`  ${bot}: ${example.label} (already seeded, verified)`);
        continue;
      }
      console.log(`  ${bot}: ${example.label}`);
      await seedExample(op, example, console.log);
    }
  } finally {
    await op.close();
    // The seed's device is not left paired.
    await must(inst, ["devices", "remove", op.deviceId]).catch((error: unknown) =>
      console.log(`Could not unpair the seed client: ${String(error)}`),
    );
  }
}

type PendingDevice = { requestId: string; clientId?: string; displayName?: string };

export async function approve(inst: DevInstance, requestId?: string): Promise<string[]> {
  const listed = parseJsonOutput<{ pending?: PendingDevice[] }>(
    await must(inst, ["devices", "list", "--json"]),
  );
  const pending = (listed.pending ?? []).filter((request) =>
    requestId ? request.requestId === requestId : request.displayName?.startsWith("Clawtrate"),
  );
  if (pending.length === 0) {
    console.log(requestId ? `No pending request ${requestId}` : "No pending Clawtrate requests");
    return [];
  }
  for (const request of pending) {
    await must(inst, ["devices", "approve", request.requestId]);
    console.log(`Approved ${request.displayName ?? "device"} (${request.requestId})`);
  }
  return pending.map((request) => request.requestId);
}

export type ListedInstance = {
  name: string | null;
  stateDir: string;
  runId: string | null;
  gatewayPort: number | null;
  providerPort: number | null;
  gatewayPid: number | null;
  gatewayRunning: boolean;
  /** "unknown" when it could not be determined whether the recorded gateway runs. */
  gatewayState: ProcessState;
  /** Started from this checkout, by its marker. */
  thisCheckout: boolean;
  checkout: string | null;
};

function describeEntry(entry: InstanceEntry, checkout: string): ListedInstance {
  return {
    name: entry.name,
    stateDir: entry.stateDir,
    runId: typeof entry.marker.runId === "string" ? entry.marker.runId : null,
    gatewayPort: entry.gatewayPort ?? null,
    providerPort: entry.providerPort ?? null,
    gatewayPid: entry.marker.gatewayPid ?? null,
    gatewayRunning: entry.gatewayRunning,
    gatewayState: entry.gatewayState,
    thisCheckout: entry.marker.checkout === checkout,
    checkout: entry.marker.checkout ?? null,
  };
}

/** The instances this tool created on this machine, from their state folders' markers. */
export function list(
  options: {
    home?: string;
    checkout?: string;
    identify?: Identify;
    json?: boolean;
    log?: (line: string) => void;
  } = {},
): ListedInstance[] {
  const log = options.log ?? console.log;
  const rows = listInstances(options.home ?? homedir(), options.identify).map((entry) =>
    describeEntry(entry, options.checkout ?? CHECKOUT_DIR),
  );
  if (options.json) {
    log(JSON.stringify(rows, null, 2));
    return rows;
  }
  if (rows.length === 0) log("No development gateway instances on this machine.");
  for (const row of rows) {
    const gateway =
      row.gatewayState === "alive"
        ? `running, pid ${row.gatewayPid}`
        : row.gatewayState === "unknown"
          ? `unknown (pid ${String(row.gatewayPid)})`
          : "stopped";
    const owner = row.thisCheckout ? "this checkout" : (row.checkout ?? "unknown checkout");
    log(`${row.name ?? "(default)"}`);
    log(`  state     ${row.stateDir}`);
    log(`  ports     gateway ${row.gatewayPort ?? "?"}, scripted model ${row.providerPort ?? "?"}`);
    log(`  gateway   ${gateway}`);
    log(`  started   from ${owner}`);
  }
  return rows;
}

/**
 * Machine-wide maintenance: remove every named instance, whichever checkout
 * created it, that is proven idle (see `deletionRefusal`), each under its
 * lifecycle lock with its marker read again after the lock is taken. The
 * default instance is never removed. Tests never call this.
 */
export async function prune(
  options: {
    home?: string;
    runRoot?: string;
    identify?: Identify;
    listening?: (port: number) => Promise<boolean>;
    log?: (line: string) => void;
  } = {},
): Promise<string[]> {
  const log = options.log ?? console.log;
  const home = options.home ?? homedir();
  const removed: string[] = [];
  for (const entry of listInstances(home, NOT_CHECKED)) {
    if (entry.name === null) continue;
    const inst = openInstance(entry.name, {
      home,
      ...(options.runRoot ? { runRoot: options.runRoot } : {}),
      ...(options.identify ? { identify: options.identify } : {}),
      ...(options.listening ? { listening: options.listening } : {}),
    });
    await withInstanceLock(inst, async () => {
      if (ownership(inst.stateDir) !== "owned") return;
      const blocked = await deletionRefusal(inst);
      if (blocked) {
        log(`Kept ${blocked}`);
        return;
      }
      rmSync(inst.stateDir, { recursive: true });
      rmSync(inst.runDir, { recursive: true, force: true });
      log(`Removed instance "${entry.name}" (${inst.stateDir})`);
      removed.push(entry.name!);
    });
  }
  if (removed.length === 0) log("No stopped instances to remove.");
  return removed;
}

/** The instance's current config, read without following a link. */
function readConfigForLock(inst: DevInstance): unknown {
  const stat = lstatOrNull(inst.configPath);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${inst.configPath} is not a plain file; nothing was run`);
  }
  try {
    return JSON.parse(readFileSync(inst.configPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`cannot read ${inst.configPath}: ${String(error)}; nothing was run`, {
      cause: error,
    });
  }
}

const LOCK_BOT = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const LOCK_PROVIDER = /^[a-z][a-z0-9-]{0,63}$/;
const LOCK_PROFILE = /^[a-z][a-z0-9-]{0,63}:[A-Za-z0-9._@+-]{1,128}$/;

/**
 * Set or clear a bot's stored one-account order for a provider, the "lock"
 * of docs/design/bots.md section 10, by running the gateway's own command
 * line (`openclaw models auth order set|clear`) on a named development
 * instance this checkout started and whose gateway is running. Clawtrate the
 * application never does this; the tool does, so that checks can. Returns
 * the order the gateway reports for the bot afterwards.
 */
export async function lockOrder(
  inst: DevInstance,
  request: { bot: string; provider: string; profileId: string | null },
): Promise<string[] | null> {
  if (inst.name === null) {
    throw new Error(
      "lock and unlock act only on a named development instance; use --instance <name>",
    );
  }
  if (!LOCK_BOT.test(request.bot)) throw new Error(`not a bot id: ${JSON.stringify(request.bot)}`);
  if (!LOCK_PROVIDER.test(request.provider)) {
    throw new Error(`not a provider id: ${JSON.stringify(request.provider)}`);
  }
  if (request.profileId !== null) {
    if (
      !LOCK_PROFILE.test(request.profileId) ||
      !request.profileId.startsWith(`${request.provider}:`)
    ) {
      throw new Error(
        `not an account of ${request.provider}: ${JSON.stringify(request.profileId)}`,
      );
    }
  }
  const refusal = inst.runner.refusal();
  if (refusal) throw new Error(refusal);
  // Before anything runs: the stores this command would read and write, as
  // the instance's current config names them, are the instance's own.
  const problems = accountStoreProblems(inst.stateDir, readConfigForLock(inst), request.bot);
  if (problems.length > 0) {
    throw new Error(
      `refusing to ${request.profileId === null ? "unlock" : "lock"} ${request.bot} on ${label(inst)}:\n  - ${problems.join("\n  - ")}`,
    );
  }
  if (!(await gatewayHealthy(inst))) {
    throw new Error(
      `${label(inst)} is not running. Run \`pnpm dev-gateway start${instanceFlag(inst)}\` first.`,
    );
  }
  const base = ["models", "auth", "order"];
  const where = ["--provider", request.provider, "--agent", request.bot];
  await must(
    inst,
    request.profileId === null
      ? [...base, "clear", ...where]
      : [...base, "set", ...where, request.profileId],
  );
  const read = parseJsonOutput<{ order?: string[] | null }>(
    await must(inst, [...base, "get", ...where, "--json"]),
  );
  return read.order ?? null;
}

const USAGE =
  "usage: pnpm dev-gateway <start|up|seed|routines|approve [requestId]|status|stop|reset> [--instance <name>] [--no-seed] [--run-id <id>] [--with-accounts] [--default-local-pairing] [--with-node] [--with-plugin <plugin>]...\n" +
  "       pnpm dev-gateway lock --instance <name> --agent <bot> --provider <provider> <profileId>\n" +
  "       pnpm dev-gateway unlock --instance <name> --agent <bot> --provider <provider>\n" +
  "       pnpm dev-gateway <list [--json]|prune>   (every instance on this machine)";

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      instance: { type: "string" },
      json: { type: "boolean", default: false },
      "no-seed": { type: "boolean", default: false },
      "run-id": { type: "string" },
      "with-plugin": { type: "string", multiple: true },
      "with-accounts": { type: "boolean", default: false },
      "with-node": { type: "boolean", default: false },
      "default-local-pairing": { type: "boolean", default: false },
      agent: { type: "string" },
      provider: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  // The selector is validated before any command runs or any path is built.
  const selected = selectInstance(values.instance, env);
  const [command, ...rest] = positionals;
  if (command === "list" || command === "prune") {
    if (selected !== null) {
      throw new Error(
        `${command} covers every instance on this machine; it does not take --instance or CLAWTRATE_DEV_INSTANCE`,
      );
    }
    if (command === "list") list({ json: values.json });
    else await prune();
    return;
  }
  const known = [
    "start",
    "up",
    "stop",
    "seed",
    "routines",
    "reset",
    "status",
    "approve",
    "lock",
    "unlock",
  ];
  if (!command || !known.includes(command)) {
    console.log(USAGE);
    process.exitCode = command ? 1 : 0;
    return;
  }
  if (values["default-local-pairing"] && command !== "start" && command !== "up") {
    throw new Error(`--default-local-pairing is a start option; ${command} does not take it`);
  }
  const inst = openInstance(selected);
  const runId = values["run-id"];
  switch (command) {
    case "start":
    case "up":
      return start(inst, {
        seed: !values["no-seed"],
        ...(runId ? { runId } : {}),
        plugins: values["with-plugin"] ?? [],
        accounts: values["with-accounts"],
        defaultLocalPairing: values["default-local-pairing"],
        node: values["with-node"],
      });
    case "stop":
      return stop(inst);
    case "seed":
      return seed(inst);
    case "routines": {
      const ids = await addScriptedRoutines(async (method, params) =>
        parseJsonOutput(
          await must(inst, [
            "gateway",
            "call",
            method,
            "--params",
            JSON.stringify(params),
            "--json",
          ]),
        ),
      );
      console.log(`Routines on ${label(inst)}: ${ids.join(", ")}`);
      return;
    }
    case "reset":
      return reset(inst, runId ? { runId } : {});
    case "status":
      return status(inst);
    case "approve":
      await approve(inst, rest[0]);
      return;
    case "lock":
    case "unlock": {
      const profileId = command === "lock" ? rest[0] : null;
      if (
        !values.agent ||
        !values.provider ||
        (command === "lock" ? rest.length !== 1 : rest.length !== 0)
      ) {
        throw new Error(USAGE);
      }
      const order = await lockOrder(inst, {
        bot: values.agent,
        provider: values.provider,
        profileId: profileId ?? null,
      });
      console.log(
        `${values.agent}'s stored order for ${values.provider} on ${label(inst)}: ${order ? JSON.stringify(order) : "none"}`,
      );
      return;
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // A signal ends the command at its next step, never inside one: a check and
  // the change it allows are one synchronous step. A kill can land anywhere,
  // which is why every process is recorded before its gate opens
  // (`spawnRecorded`). Locks are released by the operating system when the
  // process exits.
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    process.once(signal, () => {
      console.error(`Interrupted by ${signal}.`);
      process.exit(code);
    });
  }
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
