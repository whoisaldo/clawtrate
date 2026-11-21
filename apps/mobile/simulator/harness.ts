// What the Simulator checks use: the device, the gateway instance and the tools
// `pnpm mobile:check` gives them (scripts/check.ts), Maestro to drive the app,
// the dev tool's own guarded runner for OpenClaw commands, a loopback proxy the
// checks can cut and restore, and a gateway that speaks another protocol.

import { execFile, spawnSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { createServer, Socket, type Server } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { WebSocket, WebSocketServer } from "ws";
import { openInstance } from "../../../tools/dev-gateway/src/cli.ts";
import { parseJsonOutput } from "../../../tools/dev-gateway/src/env.ts";
import { decodePng } from "../../../tools/brand/src/png.ts";

const run = promisify(execFile);
const REPO = join(import.meta.dirname, "../../..");
const OUTPUT = join(import.meta.dirname, "../build/maestro");

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set: run these checks with pnpm mobile:check.`);
  return value;
}

export const env = {
  get device() {
    return need("CLAWTRATE_IOS_DEVICE");
  },
  get bundle() {
    return need("CLAWTRATE_IOS_BUNDLE");
  },
  get instance() {
    return need("CLAWTRATE_IOS_INSTANCE");
  },
  get gateway() {
    return need("CLAWTRATE_IOS_GATEWAY");
  },
  get token() {
    return need("CLAWTRATE_IOS_TOKEN");
  },
};

/** One Maestro command, as its YAML takes it. */
export type Step = Record<string, unknown> | string;

/**
 * Run Maestro commands on the checks' device as one flow. A flow is YAML, and
 * JSON is YAML, so each command is written as JSON. Every wait is for a
 * condition (`extendedWaitUntil`, Maestro's own retrying assertions), never a
 * fixed sleep.
 */
export async function steps(
  name: string,
  commands: Step[],
  options: {
    /** The app the steps look at: Clawtrate unless another one has come forward (Safari). */
    appId?: string;
    /** The whole run's bound, past which the driver is stopped and the steps fail. */
    timeoutMs?: number;
    /** False when a driver restart would invalidate a timed assertion. */
    retryDriverStartup?: boolean;
  } = {},
): Promise<void> {
  const dir = join(OUTPUT, name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "flow.yaml");
  writeFileSync(
    file,
    `appId: ${options.appId ?? env.bundle}\n---\n${commands.map((c) => `- ${JSON.stringify(c)}`).join("\n")}\n`,
    { mode: 0o600 },
  );
  // The driver's runner is installed once and kept between flows. When it
  // does not start (a loaded machine), that is no result of the app's: the
  // flow is run once more, with the runner installed afresh.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await run(
        need("CLAWTRATE_IOS_MAESTRO"),
        [
          "--device",
          env.device,
          "test",
          attempt === 1 ? "--no-reinstall-driver" : "--reinstall-driver",
          "--debug-output",
          dir,
          file,
        ],
        {
          maxBuffer: 16 * 1024 * 1024,
          // Ten minutes for the driver to start on a loaded machine, and the steps themselves.
          timeout: options.timeoutMs ?? 25 * 60_000,
          killSignal: "SIGKILL",
        },
      );
      return;
    } catch (error) {
      const { stdout = "", stderr = "" } = error as { stdout?: string; stderr?: string };
      const output = `${stdout}${stderr}`;
      if (
        attempt === 1 &&
        options.retryDriverStartup !== false &&
        DRIVER_DID_NOT_START.test(output)
      )
        continue;
      throw new Error(`Steps "${name}" failed:\n${output}`, { cause: error });
    }
  }
}

/** What Maestro says when its runner on the device did not start, before any step ran. */
const DRIVER_DID_NOT_START =
  /iOS driver not ready in time|operation never finished bootstrapping|IOSDriverTimeoutException/;

/** A server's close, bounded: a socket that lingers does not hold the checks. */
export function closeWithin(close: Promise<void>, ms = 5_000): Promise<void> {
  return Promise.race([close, new Promise<void>((resolve) => setTimeout(resolve, ms))]);
}

export type Selector = { id?: string; text?: string; [key: string]: unknown };

/** Regular expression for a literal text: Maestro matches text as a pattern. */
export const lit = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const see = (selector: Selector | string): Step => ({ assertVisible: selector });
export const notSee = (selector: Selector | string): Step => ({ assertNotVisible: selector });
export const tap = (selector: Selector | string): Step => ({ tapOn: selector });
export const waitFor = (selector: Selector | string, ms = 60_000): Step => ({
  extendedWaitUntil: { visible: selector, timeout: ms },
});
export const waitGone = (selector: Selector | string, ms = 60_000): Step => ({
  extendedWaitUntil: { notVisible: selector, timeout: ms },
});
export const scrollTo = (selector: Selector, direction: "UP" | "DOWN"): Step => ({
  scrollUntilVisible: { element: selector, direction, timeout: 30_000 },
});

type Node = { attributes?: Record<string, string>; children?: Node[] };

/**
 * Maestro's view of the screen, as JSON text. Like `steps`, a driver that did
 * not start is no result of the app's: it is asked once more, with the runner
 * installed afresh.
 */
async function hierarchy(): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const { stdout } = await run(
        need("CLAWTRATE_IOS_MAESTRO"),
        [
          "--device",
          env.device,
          "hierarchy",
          attempt === 1 ? "--no-reinstall-driver" : "--reinstall-driver",
        ],
        { maxBuffer: 64 * 1024 * 1024 },
      );
      return stdout;
    } catch (error) {
      const { stdout = "", stderr = "" } = error as { stdout?: string; stderr?: string };
      if (attempt === 1 && DRIVER_DID_NOT_START.test(`${stdout}${stderr}`)) continue;
      throw error;
    }
  }
}

/** Where each element with an id is on screen now, in points, from Maestro's view of the app. */
export async function layout(): Promise<
  Map<string, Array<{ x1: number; y1: number; x2: number; y2: number; text: string }>>
> {
  const stdout = await hierarchy();
  const tree = JSON.parse(stdout.slice(stdout.indexOf("{"))) as Node;
  const found = new Map<
    string,
    Array<{ x1: number; y1: number; x2: number; y2: number; text: string }>
  >();
  const walk = (node: Node) => {
    const a = node.attributes ?? {};
    const m = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(a.bounds ?? "");
    if (a["resource-id"] && m) {
      const list = found.get(a["resource-id"]) ?? [];
      list.push({
        x1: +m[1]!,
        y1: +m[2]!,
        x2: +m[3]!,
        y2: +m[4]!,
        text: a.accessibilityText ?? "",
      });
      found.set(a["resource-id"], list);
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  return found;
}

/** Where the first element whose text matches is on screen, in points, from Maestro's view of the app. */
export async function boundsOf(
  pattern: RegExp,
): Promise<{ x1: number; y1: number; x2: number; y2: number } | null> {
  const stdout = await hierarchy();
  const tree = JSON.parse(stdout.slice(stdout.indexOf("{"))) as Node;
  let found: { x1: number; y1: number; x2: number; y2: number } | null = null;
  const walk = (node: Node) => {
    if (found) return;
    const a = node.attributes ?? {};
    const m = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(a.bounds ?? "");
    if (m && (pattern.test(a.accessibilityText ?? "") || pattern.test(a.text ?? ""))) {
      found = { x1: +m[1]!, y1: +m[2]!, x2: +m[3]!, y2: +m[4]! };
      return;
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  return found;
}

/**
 * The screen as pixels: the colour at a point. `pointsWide` is the screen's
 * width in points (the widest element `layout` found), which gives the scale.
 */
export function screen(pointsWide: number): (x: number, y: number) => [number, number, number] {
  const file = join(OUTPUT, "screen.png");
  simctl("io", env.device, "screenshot", file);
  const image = decodePng(readFileSync(file));
  const scale = image.width / pointsWide;
  return (x, y) => {
    const i = (Math.round(y * scale) * image.width + Math.round(x * scale)) * 4;
    return [image.data[i]!, image.data[i + 1]!, image.data[i + 2]!];
  };
}

/** A token's colour as RGB, for a hex token. */
export function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Two colours within a few levels of each other per channel. */
export function near(a: number[], b: number[], tolerance = 6): boolean {
  return a.every((value, i) => Math.abs(value - b[i]!) <= tolerance);
}

function simctl(...args: string[]) {
  const result = spawnSync("xcrun", ["simctl", ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`simctl ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

/**
 * Start the app, naming the gateway the check runs as the development gateway
 * (so the pairing screen shows the dev tool's approve command). `fresh` first
 * resets the device's Keychain: the app starts with no gateway and a new key.
 */
export function launch(options: {
  fresh?: boolean;
  devGateway: string;
  switcherProbePort?: number;
}) {
  quit();
  if (options.fresh) simctl("keychain", env.device, "reset");
  simctl(
    "launch",
    env.device,
    env.bundle,
    "-ClawtrateDevGatewayURL",
    options.devGateway,
    "-ClawtrateDevGatewayInstance",
    env.instance,
    ...(options.switcherProbePort === undefined
      ? []
      : ["-ClawtrateSwitcherProbePort", String(options.switcherProbePort)]),
  );
}

/** Bring the app, still running, back to the front, as tapping it again would. */
export function activate() {
  simctl("launch", env.device, env.bundle);
}

/** Whether an app runs on the device now, from the system's own list of the apps it launched. */
export function running(bundleId: string): boolean {
  return simctl("spawn", env.device, "launchctl", "list").includes(`UIKitApplication:${bundleId}`);
}

/** Delete the app and install it again: iOS removes its data with it, not its Keychain items. */
export function reinstall() {
  quit();
  simctl("uninstall", env.device, env.bundle);
  simctl("install", env.device, need("CLAWTRATE_IOS_APP"));
}

/** What the device's pasteboard holds. */
export function pasteboard(): string {
  return simctl("pbpaste", env.device);
}

/** The system's text size, as Settings, Accessibility, Larger Text sets it. */
export function textSize(size: "large" | "accessibility-extra-extra-extra-large") {
  simctl("ui", env.device, "content_size", size);
}

/** The built app's Info.plist value for a key. */
export function infoPlist(key: string): string {
  const result = spawnSync(
    "plutil",
    ["-extract", key, "raw", "-o", "-", join(need("CLAWTRATE_IOS_APP"), "Info.plist")],
    {
      encoding: "utf8",
    },
  );
  if (result.status !== 0) throw new Error(`Info.plist has no ${key}`);
  return result.stdout.trim();
}

/**
 * The newest app-switcher snapshot iOS saved in the app's container, as pixels,
 * once one newer than `after` exists. iOS writes it as the app leaves the front.
 */
export async function switcherSnapshot(after: number) {
  const container = simctl("get_app_container", env.device, env.bundle, "data").trim();
  const root = join(container, "Library/SplashBoard/Snapshots");
  const newest = () => {
    const found: Array<{ path: string; time: number }> = [];
    const walk = (dir: string) => {
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ktx")) found.push({ path, time: statSync(path).mtimeMs });
      }
    };
    walk(root);
    return found.sort((a, b) => b.time - a.time)[0];
  };
  const snapshot = await until("the switcher's snapshot", async () => {
    const latest = newest();
    return latest && latest.time > after ? latest : null;
  });
  const png = join(OUTPUT, "switcher.png");
  const converted = spawnSync("sips", ["-s", "format", "png", snapshot.path, "--out", png], {
    encoding: "utf8",
  });
  if (converted.status !== 0) throw new Error(`Could not read the snapshot: ${converted.stderr}`);
  return { ...decodePng(readFileSync(png)), savedAt: snapshot.time };
}

/** The screen now, whole, as pixels. */
export function frame(): { width: number; data: Uint8Array } {
  const file = join(OUTPUT, "frame.png");
  simctl("io", env.device, "screenshot", file);
  const image = decodePng(readFileSync(file));
  return { width: image.width, data: image.data };
}

/**
 * Whether a region of the screen changes from frame to frame: frames are taken
 * until one differs from the first within the region, or eight seconds pass.
 * `region` is in points, and `pointsWide` is the screen's width in points.
 */
export async function moves(
  region: { x1: number; y1: number; x2: number; y2: number },
  pointsWide: number,
): Promise<boolean> {
  const crop = ({ width, data }: { width: number; data: Uint8Array }) => {
    const scale = width / pointsWide;
    const out: number[] = [];
    for (let y = Math.round(region.y1 * scale); y < Math.round(region.y2 * scale); y += 1)
      for (let x = Math.round(region.x1 * scale); x < Math.round(region.x2 * scale); x += 1) {
        const i = (y * width + x) * 4;
        out.push(data[i]!, data[i + 1]!, data[i + 2]!);
      }
    return out;
  };
  const first = crop(frame());
  const end = Date.now() + 8_000;
  while (Date.now() < end) {
    const next = crop(frame());
    if (next.some((value, i) => Math.abs(value - first[i]!) > 24)) return true;
  }
  return false;
}

/** A message the gateway adds to a task as the bot's, with no run (`chat.inject`). */
export async function inject(sessionKey: string, message: string): Promise<void> {
  await gatewayCall("chat.inject", { sessionKey, message });
}

/** Close the app, as the person would. */
export function quit() {
  const result = spawnSync("xcrun", ["simctl", "terminate", env.device, env.bundle], {
    encoding: "utf8",
  });
  // An app that is not running has nothing to close.
  if (result.status !== 0 && !/found nothing to terminate/.test(result.stderr))
    throw new Error(`simctl terminate: ${result.stderr}`);
}

/** An OpenClaw command on the checks' instance, through the dev tool's guarded runner. */
export async function openclaw(args: string[]): Promise<string> {
  const result = await openInstance(env.instance).runner.run(args);
  if (result.status !== 0)
    throw new Error(`openclaw ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

export async function gatewayCall<T>(method: string, params: unknown): Promise<T> {
  return parseJsonOutput<T>(
    await openclaw(["gateway", "call", method, "--params", JSON.stringify(params), "--json"]),
  );
}

export type Device = {
  requestId?: string;
  deviceId?: string;
  displayName?: string;
  scopes?: string[];
};

export async function devices(): Promise<{ pending: Device[]; paired: Device[] }> {
  const listed = parseJsonOutput<{ pending?: Device[]; paired?: Device[] }>(
    await openclaw(["devices", "list", "--json"]),
  );
  return { pending: listed.pending ?? [], paired: listed.paired ?? [] };
}

/** `pnpm dev-gateway <command> --instance <the checks' instance>`. */
export function devGateway(command: string) {
  const result = spawnSync(
    process.execPath,
    [join(REPO, "tools/dev-gateway/src/cli.ts"), command, "--instance", env.instance],
    {
      cwd: REPO,
      encoding: "utf8",
    },
  );
  if (result.status !== 0)
    throw new Error(`dev-gateway ${command}: ${result.stdout}${result.stderr}`);
  return result.stdout;
}

/** Wait for a condition on the gateway's side, checked every half second. */
export async function until<T>(
  what: string,
  check: () => Promise<T | null | undefined>,
  ms = 60_000,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** A loopback TCP proxy to the gateway, which a check cuts (every socket closed, nothing listening) and restores. */
export class Proxy {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  port = 0;
  /** Every connection the app opened through the proxy, since it started. */
  connections = 0;
  private readonly target: number;
  constructor(target: number) {
    this.target = target;
  }

  async start(): Promise<string> {
    await this.listen(0);
    return `ws://127.0.0.1:${this.port}`;
  }

  private listen(port: number) {
    const server = createServer((client) => {
      this.connections += 1;
      const upstream = new Socket();
      upstream.connect(this.target, "127.0.0.1");
      for (const socket of [client, upstream]) {
        this.sockets.add(socket);
        socket.on("close", () => this.sockets.delete(socket));
        socket.on("error", () => {
          client.destroy();
          upstream.destroy();
        });
      }
      client.pipe(upstream).pipe(client);
    });
    this.server = server;
    return new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        this.port = (server.address() as { port: number }).port;
        resolve();
      });
    });
  }

  /** The connection drops, and the gateway cannot be reached until `restore`. */
  async cut() {
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    if (server) await closeWithin(new Promise<void>((resolve) => server.close(() => resolve())));
  }

  async restore() {
    await this.listen(this.port);
  }

  async stop() {
    await this.cut();
  }
}

/**
 * What a gateway answers a client offering protocols it does not speak, read
 * from the checks' real gateway: offered protocol 99, it names its own (4).
 */
export async function realMismatchReply(): Promise<{
  challenge: unknown;
  reply: { error?: { details?: Record<string, unknown> } };
}> {
  const socket = new WebSocket(env.gateway);
  return new Promise((resolve, reject) => {
    let challenge: unknown = null;
    socket.onerror = () => reject(new Error("socket error"));
    socket.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as { type: string; event?: string; id?: string };
      if (frame.type === "event" && frame.event === "connect.challenge") {
        challenge = frame;
        socket.send(
          JSON.stringify({
            type: "req",
            id: "probe",
            method: "connect",
            params: {
              minProtocol: 99,
              maxProtocol: 99,
              client: { id: "gateway-client", version: "0.0.0", platform: "test", mode: "ui" },
              role: "operator",
              scopes: ["operator.read"],
              caps: [],
            },
          }),
        );
      } else if (frame.type === "res" && frame.id === "probe") {
        socket.close();
        resolve({ challenge, reply: frame as never });
      }
    };
  });
}

/**
 * A gateway on protocol 5: it challenges like the real one and answers every
 * connect with the real gateway's mismatch reply, naming protocol 5, then
 * closes the socket as the real one does (1002).
 */
export async function protocolFiveGateway(): Promise<{
  url: string;
  /** Every request method the app sent, in order: only connects may come. */
  methods: string[];
  close: () => Promise<void>;
}> {
  const methods: string[] = [];
  const { challenge, reply } = await realMismatchReply();
  const details = {
    ...reply.error?.details,
    expectedProtocol: 5,
    clientMinProtocol: 4,
    clientMaxProtocol: 4,
  };
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  server.on("connection", (socket) => {
    socket.send(JSON.stringify(challenge));
    socket.on("message", (data) => {
      const frame = JSON.parse(String(data)) as { id?: string; method?: string; type?: string };
      if (frame.type === "req" && frame.method) methods.push(frame.method);
      if (frame.method !== "connect") return;
      socket.send(JSON.stringify({ ...reply, id: frame.id, error: { ...reply.error, details } }));
      socket.close(1002);
    });
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    methods,
    close: () => {
      for (const client of server.clients) client.terminate();
      return closeWithin(new Promise<void>((resolve) => server.close(() => resolve())));
    },
  };
}

/**
 * A gateway that refuses every connect with an error whose message repeats
 * everything the app sent, its credential included, as a hostile or broken
 * gateway could.
 */
export async function echoingGateway(): Promise<{ url: string; close: () => Promise<void> }> {
  const { challenge } = await realMismatchReply();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  server.on("connection", (socket) => {
    socket.send(JSON.stringify(challenge));
    socket.on("message", (data) => {
      const frame = JSON.parse(String(data)) as { id?: string; method?: string; params?: unknown };
      if (frame.method !== "connect") return;
      socket.send(
        JSON.stringify({
          type: "res",
          id: frame.id,
          ok: false,
          error: {
            code: "INVALID_REQUEST",
            message: `Refused connect ${JSON.stringify(frame.params)}`,
          },
        }),
      );
      socket.close(1008);
    });
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    close: () => {
      for (const client of server.clients) client.terminate();
      return closeWithin(new Promise<void>((resolve) => server.close(() => resolve())));
    },
  };
}

/** A gateway frame, as far as a relay reads and changes it. */
export type RelayFrame = {
  type?: string;
  id?: string;
  method?: string;
  ok?: boolean;
  payload?: Record<string, unknown>;
  error?: unknown;
};

/**
 * A loopback relay to a gateway. `fromPhone` sees each request the app sends and
 * may answer it itself instead of passing it on; `fromGateway` may change a reply
 * on its way back, knowing the method it answers. `drop` closes the app's
 * sockets, so it connects again.
 */
export async function relay(
  upstream: string,
  hooks: {
    fromPhone?: (frame: RelayFrame) => RelayFrame | null;
    fromGateway?: (frame: RelayFrame, method: string | undefined) => void;
  },
): Promise<{ url: string; drop: () => void; close: () => Promise<void> }> {
  const sockets = new Set<WebSocket>();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  server.on("connection", (phone) => {
    const gateway = new WebSocket(upstream);
    sockets.add(gateway);
    const methods = new Map<string, string>();
    gateway.on("close", () => {
      sockets.delete(gateway);
      phone.close();
    });
    gateway.on("error", () => phone.close());
    phone.on("close", () => gateway.terminate());
    phone.on("error", () => gateway.terminate());
    phone.on("message", (data) => {
      const frame = JSON.parse(String(data)) as RelayFrame;
      const answer = hooks.fromPhone?.(frame) ?? null;
      if (answer) return phone.send(JSON.stringify(answer));
      if (frame.type === "req" && frame.id && frame.method) methods.set(frame.id, frame.method);
      if (gateway.readyState === WebSocket.OPEN) gateway.send(String(data));
      else gateway.once("open", () => gateway.send(String(data)));
    });
    gateway.on("message", (data) => {
      const frame = JSON.parse(String(data)) as RelayFrame;
      hooks.fromGateway?.(frame, frame.id === undefined ? undefined : methods.get(frame.id));
      if (phone.readyState === WebSocket.OPEN) phone.send(JSON.stringify(frame));
    });
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    drop: () => {
      for (const phone of server.clients) phone.terminate();
    },
    close: () => {
      for (const phone of server.clients) phone.terminate();
      for (const socket of sockets) socket.terminate();
      return closeWithin(new Promise<void>((resolve) => server.close(() => resolve())));
    },
  };
}

/** Maestro's whole view of the screen as text: every label and value the app exposes. */
export async function screenText(): Promise<string> {
  return hierarchy();
}

/** How many of the app's own data files hold each needle, as UTF-8 or UTF-16. */
export function containerHits(needles: string[]): number[] {
  const root = simctl("get_app_container", env.device, env.bundle, "data").trim();
  const hits = needles.map(() => 0);
  const visit = (dir: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        const bytes = readFileSync(path);
        needles.forEach((needle, i) => {
          if (bytes.includes(Buffer.from(needle)) || bytes.includes(Buffer.from(needle, "utf16le")))
            hits[i]! += 1;
        });
      }
    }
  };
  visit(root);
  return hits;
}

/** The app's own log lines since a time, from the device's unified log. */
export function appLog(sinceSeconds: number): string {
  const result = spawnSync(
    "xcrun",
    [
      "simctl",
      "spawn",
      env.device,
      "log",
      "show",
      "--last",
      `${sinceSeconds}s`,
      "--style",
      "compact",
      "--predicate",
      'process == "Clawtrate"',
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error(`log show: ${result.stderr}`);
  return result.stdout;
}

/** A loopback port nothing listens on. */
export async function deadPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * With CLAWTRATE_IOS_SHOTS set, the screen as it is now, in light and in dark.
 * A screenshot is evidence for the report, never an assertion; the wait after
 * changing the appearance only lets the screen redraw.
 */
export async function shoot(name: string) {
  const dir = process.env.CLAWTRATE_IOS_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  for (const appearance of ["light", "dark"]) {
    simctl("ui", env.device, "appearance", appearance);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    simctl("io", env.device, "screenshot", join(dir, `${name}-${appearance}.png`));
  }
  simctl("ui", env.device, "appearance", "light");
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
