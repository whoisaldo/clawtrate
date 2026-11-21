// A fake gateway host and a fake browser for the plugin's tests. The plugin's
// real register code and handlers run against them; nothing here touches a
// gateway, a real browser or the network.

import { EventEmitter } from "node:events";
import { createComputer, newState } from "../index.js";

export const ATLAS = "http://127.0.0.1:19113";
export const PIXEL = "http://127.0.0.1:19114";
export const ATLAS_TAB = "A".repeat(32);
export const PIXEL_TAB = "B".repeat(32);
export const FOREIGN_TAB = "C".repeat(32);
export const ATLAS_SESSION = "agent:atlas:main";
export const PIXEL_SESSION = "agent:pixel:main";

type Json = Record<string, unknown>;
export type Target = {
  id: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl: string;
};

export const page = (base: string, id: string, url = "http://127.0.0.1:9/page"): Target => ({
  id,
  type: "page",
  url,
  title: "Page",
  webSocketDebuggerUrl: `${base.replace("http", "ws")}/devtools/page/${id}`,
});

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The real timer, kept before any check fakes the clock: the fake browser stands for another
 * process, so it answers in real time while the plugin's own deadlines run on the check's clock.
 */
const browserTimer = globalThis.setTimeout;

/** One real turn of the event loop: lets the fake browser answer while a fake clock stands still. */
export const nextTurn = () => new Promise((resolve) => browserTimer(resolve, 0));

export type LogEntry = {
  t: number;
  kind: "connect" | "send" | "close";
  url: string;
  method?: string;
  params?: Json;
};

/**
 * A fake browser: the target lists `fetch` returns, and WebSocket connections
 * whose opening, replies and closing a test controls. Every connection and
 * command is logged with the time it happened.
 */
export class FakeBrowser {
  lists = new Map<string, Target[]>();
  log: LogEntry[] = [];
  fetches: { url: string; init: RequestInit | undefined }[] = [];
  /** Discovery never answers (until aborted). */
  stallDiscovery = false;
  /** Connections never open (until closed). */
  stallConnect = false;
  connectDelayMs = 0;
  replyDelayMs = 0;
  /** The browser's own id in its debugger address; a restarted browser has another. */
  browserId = "fake-browser-0001";
  /** The browser gives no debugger address of its own, so it cannot be watched. */
  noBrowserEndpoint = false;
  /** Commands that are never answered. */
  stalledMethods = new Set<string>();
  /** Tabs, by target id, whose session answers no command. */
  stalledTabs = new Set<string>();
  sockets: FakeSocket[] = [];

  constructor() {
    this.lists.set(ATLAS, [page(ATLAS, ATLAS_TAB)]);
    this.lists.set(PIXEL, [page(PIXEL, PIXEL_TAB)]);
  }

  fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    this.fetches.push({ url, init });
    const signal = init?.signal ?? undefined;
    if (this.stallDiscovery) {
      await new Promise((_, reject) =>
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
      );
    }
    const u = new URL(url);
    const base = `${u.protocol}//${u.host}`;
    const list = this.lists.get(base);
    if (!list) throw new TypeError("fetch failed");
    if (u.pathname === "/json/version") {
      if (this.noBrowserEndpoint) return new Response("{}", { status: 200 });
      const ws = `${base.replace("http", "ws")}/devtools/browser/${this.browserId}`;
      return new Response(JSON.stringify({ webSocketDebuggerUrl: ws }), { status: 200 });
    }
    return new Response(JSON.stringify(list), { status: 200 });
  };

  get WebSocketImpl() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const browser = this;
    return class extends FakeSocket {
      constructor(url: string) {
        super(browser, url);
      }
    } as unknown as typeof WebSocket;
  }

  /** The CDP commands sent so far, by method. */
  sent(prefix = ""): LogEntry[] {
    return this.log.filter((e) => e.kind === "send" && e.method?.startsWith(prefix));
  }

  /** The CDP commands sent to tabs (not to the browser itself), by method. */
  sentToTabs(prefix = ""): LogEntry[] {
    return this.sent(prefix).filter((e) => e.url.includes("/devtools/page/"));
  }

  /** Connections to tabs, not the plugin's watch on the browser itself. */
  get tabSockets(): FakeSocket[] {
    return this.sockets.filter((s) => s.url.includes("/devtools/page/"));
  }

  /** The open watch connection on a browser, if any. */
  watchSocket(base: string): FakeSocket | undefined {
    return this.sockets.find(
      (s) => !s.closed && s.url.startsWith(`${base.replace("http", "ws")}/devtools/browser/`),
    );
  }

  /** A tab closing, as the browser tells a watch. */
  tabDetached(base: string, targetId: string) {
    this.lists.set(
      base,
      (this.lists.get(base) ?? []).filter((t) => t.id !== targetId),
    );
    this.watchSocket(base)?.emit("message", {
      data: JSON.stringify({
        method: "Target.detachedFromTarget",
        params: { sessionId: `S-${targetId}`, targetId },
      }),
    });
  }

  /** An event from a tab, as the browser sends it to a watch (by the tab's session). */
  tabEvent(base: string, targetId: string, method: string, params: Json) {
    this.watchSocket(base)?.emit("message", {
      data: JSON.stringify({ method, params, sessionId: `S-${targetId}` }),
    });
  }
}

export class FakeSocket extends EventEmitter {
  readonly url: string;
  readonly browser: FakeBrowser;
  open = false;
  closed = false;

  constructor(browser: FakeBrowser, url: string) {
    super();
    this.browser = browser;
    this.url = url;
    browser.sockets.push(this);
    browser.log.push({ t: performance.now(), kind: "connect", url });
    if (!browser.stallConnect) {
      browserTimer(() => {
        if (this.closed) return;
        this.open = true;
        this.emit("open", {});
      }, browser.connectDelayMs);
    }
  }

  addEventListener(type: string, fn: (event: unknown) => void, options?: { once?: boolean }) {
    if (options?.once) this.once(type, fn);
    else this.on(type, fn);
  }

  removeEventListener(type: string, fn: (event: unknown) => void) {
    this.off(type, fn);
  }

  send(raw: string) {
    if (!this.open || this.closed) throw new Error("not open");
    const message = JSON.parse(raw) as { id: number; method: string; params: Json };
    this.browser.log.push({
      t: performance.now(),
      kind: "send",
      url: this.url,
      method: message.method,
      params: message.params,
    });
    if (message.method === "Target.setAutoAttach" && this.url.includes("/devtools/browser/")) {
      // Chromium reports every tab open now before it answers.
      const base = this.url.slice(0, this.url.indexOf("/devtools/")).replace("ws", "http");
      for (const target of this.browser.lists.get(base) ?? []) {
        this.emit("message", {
          data: JSON.stringify({
            method: "Target.attachedToTarget",
            params: {
              sessionId: `S-${target.id}`,
              targetInfo: { targetId: target.id, type: "page", url: target.url },
              waitingForDebugger: false,
            },
          }),
        });
      }
    }
    if (this.browser.stalledMethods.has(message.method)) return;
    const session = (message as { sessionId?: string }).sessionId;
    if (session && this.browser.stalledTabs.has(session.replace(/^S-/, ""))) return;
    browserTimer(() => {
      if (!this.closed)
        this.emit("message", { data: JSON.stringify({ id: message.id, result: {} }) });
    }, this.browser.replyDelayMs);
  }

  /** An event from the browser, such as a screencast frame. */
  event(method: string, params: Json) {
    this.emit("message", { data: JSON.stringify({ method, params }) });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    this.browser.log.push({ t: performance.now(), kind: "close", url: this.url });
    browserTimer(() => this.emit("close", { code: 1000, reason: "" }), 0);
  }
}

export type Caller = {
  agentId?: string;
  sessionKey?: string;
  connId?: string;
  /** Aborts when this caller's gateway connection closes. */
  connection?: AbortController;
  /** The session's access, as the host retains it; `revoke` ends it. */
  access?: Access;
};

/** A session's access as the host grants it: current until revoked. */
export class Access {
  revoked = false;
  readonly controller = new AbortController();
  releases = 0;
  revoke() {
    this.revoked = true;
    this.controller.abort();
  }
  assertCurrent = () => {
    if (this.revoked) throw new Error("session access changed");
  };
  retain = () => ({
    signal: this.controller.signal,
    assertCurrent: this.assertCurrent,
    release: () => {
      this.releases += 1;
    },
  });
}

export type HookResult = { block?: boolean; blockReason?: string; params?: Json };

export type Answer = {
  ok: boolean;
  payload?: Json;
  error?: { code: string; message: string; details?: { reason?: string } };
};

export const BASE_CONFIG = {
  bots: {
    atlas: { profile: "bot-atlas", cdpUrl: ATLAS },
    pixel: { profile: "bot-pixel", cdpUrl: PIXEL },
  },
  drainTimeoutMs: 1000,
};

export const BROWSER_CONFIG = {
  browser: {
    defaultProfile: "openclaw",
    profiles: {
      openclaw: { cdpPort: 19112 },
      "bot-atlas": { cdpPort: 19113 },
      "bot-pixel": { cdpPort: 19114 },
    },
  },
};

export type Host = Awaited<ReturnType<typeof load>>;

/**
 * Register the plugin on a fake host. `hostConfig` is the gateway config
 * the plugin reads; `current` replaces what `api.runtime.config.current()`
 * returns later.
 */
export function load(
  options: {
    config?: Json;
    hostConfig?: Json;
    browser?: FakeBrowser;
    timeouts?: { discoveryMs: number; connectMs: number; commandMs: number };
    renewTimeoutMs?: number;
    ticketTtlMs?: number;
    quietWindowMs?: number;
    quietTimeoutMs?: number;
    callConfirmMs?: number;
  } = {},
) {
  const browser = options.browser ?? new FakeBrowser();
  const methods = new Map<string, { handler: (opts: Json) => Promise<void>; opts: Json }>();
  const hooks = new Map<string, { fn: (event: Json, ctx: Json) => unknown; opts: Json }[]>();
  const routes: Json[] = [];
  const services: { start(ctx: Json): void; stop(): Promise<void> | void }[] = [];
  const events: Json[] = [];
  const warnings: string[] = [];
  let current: Json = options.hostConfig ?? BROWSER_CONFIG;
  const api = {
    pluginConfig: options.config ?? BASE_CONFIG,
    config: options.hostConfig ?? BROWSER_CONFIG,
    runtime: { config: { current: () => current } },
    logger: { info() {}, warn: (m: string) => warnings.push(m), error() {} },
    registerGatewayMethod: (name: string, handler: (opts: Json) => Promise<void>, opts: Json) =>
      methods.set(name, { handler, opts }),
    registerHttpRoute: (route: Json) => routes.push(route),
    registerService: (service: (typeof services)[number]) => services.push(service),
    on: (name: string, fn: (event: Json, ctx: Json) => unknown, opts: Json = {}) =>
      (hooks.get(name) ?? hooks.set(name, []).get(name)!).push({ fn, opts }),
  };
  const state = newState();
  const handle = createComputer(api, {
    state,
    timeouts: options.timeouts ?? { discoveryMs: 300, connectMs: 300, commandMs: 300 },
    ticketTtlMs: options.ticketTtlMs,
    env: {},
    // Short, so a take is quick; quiet.test.ts sets its own.
    quietWindowMs: options.quietWindowMs ?? 20,
    quietTimeoutMs: options.quietTimeoutMs,
    renewTimeoutMs: options.renewTimeoutMs,
    callConfirmMs: options.callConfirmMs,
    fetchImpl: browser.fetchImpl,
    WebSocketImpl: browser.WebSocketImpl,
  });
  for (const service of services) {
    service.start({
      gatewayEvents: { emit: (name: string, payload: Json) => events.push({ name, ...payload }) },
    });
  }

  async function call(method: string, params: Json, caller: Caller = {}): Promise<Answer> {
    const entry = methods.get(`clawtrate-computer.${method}`);
    if (!entry) throw new Error(`no method ${method}`);
    const agentId = caller.agentId ?? "atlas";
    const sessionKey = caller.sessionKey ?? `agent:${agentId}:main`;
    const access = caller.access ?? new Access();
    let out: Answer | undefined;
    await entry.handler({
      params: { sessionKey, ...params },
      client: {
        connId: caller.connId ?? "conn-A",
        connectionSignal: (caller.connection ?? new AbortController()).signal,
      },
      sessionAccessAuthority: {
        target: { agentId, sessionKey, sessionId: `sid-${sessionKey}` },
        ...access,
        assertCurrent: access.assertCurrent,
        retain: access.retain,
      },
      respond: (ok: boolean, payload?: Json, error?: Answer["error"]) => {
        out = { ok, ...(payload ? { payload } : {}), ...(error ? { error } : {}) };
      },
    });
    return out ?? { ok: false, error: { code: "NONE", message: "no response" } };
  }

  async function hook(name: string, event: Json, ctx: Json) {
    let result: unknown;
    const list = [...(hooks.get(name) ?? [])].sort(
      (a, b) => Number(b.opts.priority ?? 0) - Number(a.opts.priority ?? 0),
    );
    for (const { fn } of list) {
      const value = await fn({ ...event }, ctx);
      if (value !== undefined) result = value;
      if ((value as Json | undefined)?.block === true) break;
    }
    return result as HookResult | undefined;
  }

  const before = (
    agentId: string,
    runId: string | undefined,
    toolCallId: string | undefined,
    params: Json,
    extra: Json = {},
  ) =>
    hook(
      "before_tool_call",
      { toolName: "browser", runId, toolCallId, params },
      { agentId, runId, ...extra },
    );
  const after = (agentId: string, runId: string, toolCallId: string, params: Json = {}) =>
    hook("after_tool_call", { toolName: "browser", runId, toolCallId, params }, { agentId, runId });

  /** Open a stream with a ticket on a fake socket; returns what it was sent. */
  async function upgrade(wsPath: string) {
    const route = routes.find((r) => wsPath.startsWith(String(r.path)))!;
    const socket = new FakeServerSocket();
    await (route.handleUpgrade as (req: Json, socket: unknown, head: Buffer) => Promise<boolean>)(
      {
        url: wsPath,
        headers: {
          upgrade: "websocket",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-version": "13",
        },
      },
      socket,
      Buffer.alloc(0),
    );
    return socket;
  }

  return {
    browser,
    methods,
    hooks,
    routes,
    events,
    warnings,
    state,
    handle,
    call,
    hook,
    before,
    after,
    upgrade,
    setCurrent: (config: Json) => {
      current = config;
    },
    stop: () => Promise.all(services.map((service) => service.stop())),
    /** The control events about one lease, by state. */
    statesOf: (generation: unknown) =>
      events.filter((e) => e.name === "control" && e.generation === generation).map((e) => e.state),
  };
}

/** The server side of a stream's socket: records what the plugin writes. */
export class FakeServerSocket extends EventEmitter {
  destroyed = false;
  ended = false;
  writableLength = 0;
  written: Buffer[] = [];
  write(data: string | Buffer) {
    this.written.push(Buffer.from(data));
    return true;
  }
  end(data?: string | Buffer) {
    if (data) this.written.push(Buffer.from(data));
    this.ended = true;
    this.destroyed = true;
    this.emit("close");
  }
  destroy() {
    this.destroyed = true;
  }
  setNoDelay() {}
  /** The HTTP status line written, if any. */
  get status(): string {
    return this.written[0]?.toString("latin1").split("\r\n")[0] ?? "";
  }
  /** WebSocket frames written after the handshake: opcode and payload. */
  frames(): { opcode: number; payload: Buffer }[] {
    const out: { opcode: number; payload: Buffer }[] = [];
    for (const chunk of this.written.slice(1)) {
      const opcode = chunk[0]! & 0x0f;
      let length = chunk[1]! & 0x7f;
      let offset = 2;
      if (length === 126) {
        length = chunk.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        length = Number(chunk.readBigUInt64BE(2));
        offset = 10;
      }
      out.push({ opcode, payload: chunk.subarray(offset, offset + length) });
    }
    return out;
  }
  /** The close frame's code and reason, if one was written. */
  closeCode(): { code: number; reason: string } | null {
    const close = this.frames().find((f) => f.opcode === 0x8);
    return close
      ? { code: close.payload.readUInt16BE(0), reason: close.payload.subarray(2).toString() }
      : null;
  }
}

/** Wait for `test` to hold, checking every 10 ms, at most `ms`. */
export async function until(test: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!test()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(10);
  }
}
