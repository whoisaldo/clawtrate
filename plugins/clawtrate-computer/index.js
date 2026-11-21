// clawtrate-computer: a browser of its own for each configured bot, a live
// view of it for the people who can use that bot, and a controlled way for a
// person to take it over (a sign-in, a captcha) and hand it back.
//
// What it adds to an OpenClaw gateway, and what it cannot guarantee, is in
// README.md beside this file. In short:
//
//   before_tool_call   pins each configured bot's `browser` calls to its own
//                      profile on the gateway host, allows it only tab
//                      actions, blocks it while a person holds control, and
//                      keeps every other agent out of the bots' profiles
//   after_tool_call    ends the record of a running bot call (recorded from
//                      the start of its before_tool_call check)
//   agent_end          ends the records of a run's calls, also one whose
//                      after_tool_call never came
//   gateway methods    clawtrate-computer.tabs, .view.open, .view.renew,
//                      .control.take, .control.release, .input
//                      (operator.write, session access with the browser tool)
//   HTTP upgrade       /clawtrate-computer/stream?ticket=…, the live frames
//   event              plugin.clawtrate-computer.control (operator.read)
//
// Rights come only from the session the gateway admitted (its bot) and that
// bot's live tab list from its own browser on loopback; never from tool
// results. Every wait has a deadline; a lease or view ends when its caller's
// connection closes, when it is not renewed, when its tab closes, when the
// session's access is revoked, or when the plugin stops.

import { randomBytes, randomUUID } from "node:crypto";
import { developmentInstanceProblem } from "./lib/development.js";
import {
  BOT_ACTIONS,
  DEFAULT_IMPORT_PROFILE,
  PLUGIN_ID,
  browserConfigProblems,
  parseConfig,
  profileOwner,
  profileSelector,
  toolString,
} from "./lib/config.js";
import { CdpError, TIMEOUTS, cdpTargets, openCdp } from "./lib/cdp.js";
import { watchBrowser } from "./lib/watch.js";
import {
  acceptUpgrade,
  binaryFrame,
  closeFrame,
  frameReader,
  frame,
  refuseUpgrade,
  textFrame,
} from "./lib/websocket.js";

/**
 * The host can load this module more than once (one copy served the tool
 * hooks, another the gateway methods), so shared state lives in one
 * process-wide slot.
 */
export const STATE_KEY = Symbol.for("clawtrate-computer.state.v1");
export const STREAM_PATH = `/${PLUGIN_ID}/stream`;
/** How long a view ticket can be used. A late or unused ticket is harmless. */
export const TICKET_TTL_MS = 60_000;
/**
 * A take is granted only once the tab has stayed quiet this long after the
 * plugin stopped whatever it was loading, and is refused if that does not
 * happen within QUIET_TIMEOUT_MS.
 */
export const QUIET_WINDOW_MS = 500;
export const QUIET_TIMEOUT_MS = 5000;
/** Events that mean a frame of the tab started, or committed, a navigation. */
const NAVIGATION_EVENTS = new Set([
  "Page.frameStartedLoading",
  "Page.frameStartedNavigating",
  "Page.frameRequestedNavigation",
  "Page.frameScheduledNavigation",
  "Page.frameNavigated",
  "Page.navigatedWithinDocument",
]);
/** The longest a release, expiry or shutdown waits for queued input to settle. */
const SETTLE_CAP_MS = 1000;
const MAX_STREAMS = 64;
const MAX_STREAMS_PER_CONNECTION = 8;
/** Frames are dropped, not queued, while this much is still unsent to a viewer. */
const STREAM_BUFFER_LIMIT = 4 * 1024 * 1024;
const TARGET_ID = /^[A-Za-z0-9]{8,64}$/;
const GENERATION = /^[0-9a-f]{32}$/;
const COORDINATE_LIMIT = 100000;
const TEXT_LIMIT = 2000;

/** How long a bot's browser call waits for the plugin to start watching its browser. */
const WATCH_WAIT_MS = 2000;
/**
 * How long a bot call may go without reporting its end before the plugin no
 * longer says the bot is acting: a take then says it cannot confirm.
 */
const CALL_CONFIRM_MS = 120_000;
/** Calls whose end arrived, remembered so a late pre-call check records nothing. */
const MAX_ENDED_CALLS = 256;
/** Bot runs whose end arrived, remembered so a late pre-call check of theirs records nothing. */
const MAX_ENDED_RUNS = 64;

/**
 * What a granted take guarantees, exactly, in the answer and on the plugin's
 * page. Nothing more is promised: work the bot started before the take, such
 * as a timer or script on the page, can still change it.
 */
export const GRANT_GUARANTEE = Object.freeze([
  "Input from the person reaches the page.",
  "New browser calls from this bot are refused while control is held.",
  "Work the bot had already started can still affect the page.",
]);

/** Why a take was refused as busy: the event's reason and the answer's words. */
const UNRESOLVED = {
  calls: ["bot-still-acting", "the bot is still acting in this browser"],
  unconfirmed: [
    "bot-calls-unconfirmed",
    "a browser call of the bot has not reported that it ended, so whether the bot is still acting cannot be confirmed",
  ],
  loading: ["browser-not-quiet", "the bot's browser is still loading a page"],
  download: ["download-in-progress", "a download in the bot's browser is still in progress"],
  closed: ["browser-not-watched", "the plugin cannot see what the bot's browser is doing"],
  // The proof failed with no load or download reported: nothing says the browser is busy.
  unproved: [
    "browser-not-watched",
    "the plugin could not confirm that the bot's browser has settled",
  ],
  unwatched: [
    "browser-not-watched",
    "a tab of the bot's browser does not answer the plugin, so whether it has settled cannot be seen",
  ],
};

/** Thrown inside a sequence of browser commands when the caller's access has gone. */
const STALE = Symbol("stale");

/** Messages the bot and people see. */
export const BLOCKED_WHILE_HELD =
  "A person has control of this bot's browser. Wait until they give it back.";

export function newState() {
  return {
    /**
     * runId + toolCallId -> { agentId, profile, runId, startedAt } for each bot
     * browser call from its pre-call check until its end, its run's end or its abort
     */
    inflight: new Map(),
    /** runId + toolCallId of calls whose end arrived, at most MAX_ENDED_CALLS, oldest first */
    endedCalls: new Set(),
    /** agentId + runId of bot runs whose end arrived, at most MAX_ENDED_RUNS, oldest first */
    endedRuns: new Set(),
    /** profile + targetId -> lease */
    leases: new Map(),
    /** streamId -> stream */
    streams: new Map(),
    /** ticket -> streamId */
    tickets: new Map(),
    /** callbacks run whenever a call or a lease changes */
    waiters: new Set(),
    /** profile -> { registration, pending: Promise<watch | null>, watch } */
    watches: new Map(),
    /**
     * profile -> { browserUrl, guids }: downloads a lost watch had seen begin
     * and not end, carried to the next watch of the same browser.
     */
    unfinishedDownloads: new Map(),
  };
}

const callKey = (runId, toolCallId) => `${runId}\n${toolCallId}`;
const leaseKey = (profile, targetId) => `${profile}\n${targetId}`;
const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isSignal = (value) =>
  value !== null &&
  typeof value === "object" &&
  typeof value.aborted === "boolean" &&
  typeof value.addEventListener === "function";
const finite = (value, limit) =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;
const unref = (timer) => {
  timer?.unref?.();
  return timer;
};

class RequestError extends Error {
  constructor(code, reason, message) {
    super(message);
    this.code = code;
    this.reason = reason;
  }
}
const refuse = (code, reason, message) => {
  throw new RequestError(code, reason, message);
};

/** The CDP commands for one input, or throws INVALID_REQUEST. */
export function inputCommands(params) {
  const { kind } = params;
  if (kind === "click") {
    const { x, y } = params;
    if (!finite(x, COORDINATE_LIMIT) || !finite(y, COORDINATE_LIMIT) || x < 0 || y < 0) {
      refuse("INVALID_REQUEST", "bad_input", "a click needs x and y in the page's CSS pixels");
    }
    const at = { x, y };
    return [
      ["Input.dispatchMouseEvent", { type: "mouseMoved", ...at }],
      [
        "Input.dispatchMouseEvent",
        { type: "mousePressed", ...at, button: "left", buttons: 1, clickCount: 1 },
      ],
      [
        "Input.dispatchMouseEvent",
        { type: "mouseReleased", ...at, button: "left", buttons: 0, clickCount: 1 },
      ],
    ];
  }
  if (kind === "scroll") {
    const { x = 0, y = 0, deltaX = 0, deltaY } = params;
    if (
      ![x, y].every((v) => finite(v, COORDINATE_LIMIT) && v >= 0) ||
      !finite(deltaX, COORDINATE_LIMIT) ||
      !finite(deltaY, COORDINATE_LIMIT)
    ) {
      refuse("INVALID_REQUEST", "bad_input", "a scroll needs deltaY, and x, y and deltaX if given");
    }
    return [["Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY }]];
  }
  if (kind === "text") {
    const { text } = params;
    if (typeof text !== "string" || text.length === 0 || text.length > TEXT_LIMIT) {
      refuse("INVALID_REQUEST", "bad_input", `text must be 1 to ${TEXT_LIMIT} characters`);
    }
    return [["Input.insertText", { text }]];
  }
  return refuse("INVALID_REQUEST", "bad_input", "kind must be click, scroll or text");
}

/**
 * Register the plugin on `api`. Returns a handle for tests. `options` lets
 * tests replace the state slot, the deadlines and lifetimes, `fetch` and
 * `WebSocket`.
 */
export function createComputer(api, options = {}) {
  const config = parseConfig(api.pluginConfig ?? {});
  // The gateway's environment: its port can come from there, and with it the
  // ports of the profiles it adds by itself.
  const env = options.env ?? process.env;
  const startProblems = browserConfigProblems(api.config, config, env);
  if (startProblems.length > 0) {
    throw new Error(`${PLUGIN_ID}: the browser config does not match: ${startProblems.join("; ")}`);
  }
  const state = options.state ?? (globalThis[STATE_KEY] ??= newState());
  const timeouts = { ...TIMEOUTS, ...options.timeouts };
  const ticketTtlMs = options.ticketTtlMs ?? TICKET_TTL_MS;
  const net = {
    timeouts,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.WebSocketImpl ? { WebSocketImpl: options.WebSocketImpl } : {}),
  };
  const { bots } = config;
  // Tests may use shorter times than the config's bounds allow.
  const drainTimeoutMs = options.drainTimeoutMs ?? config.drainTimeoutMs;
  const renewTimeoutMs = options.renewTimeoutMs ?? config.renewTimeoutMs;
  const quietWindowMs = options.quietWindowMs ?? QUIET_WINDOW_MS;
  const quietTimeoutMs = options.quietTimeoutMs ?? QUIET_TIMEOUT_MS;
  const callConfirmMs = options.callConfirmMs ?? CALL_CONFIRM_MS;
  const logger = api.logger ?? {};
  const warn = (message) => logger.warn?.(`${PLUGIN_ID}: ${message}`);
  const registration = Symbol("registration");
  let emitEvent = () => {};
  let stopped = false;

  const currentConfig = () => {
    try {
      return api.runtime?.config?.current?.() ?? api.config;
    } catch {
      return api.config;
    }
  };
  const changed = () => {
    for (const waiter of [...state.waiters]) waiter();
  };
  /** Resolves true once `predicate` holds, false at the deadline or on abort. */
  const waitUntil = (predicate, ms, signal) =>
    new Promise((resolve) => {
      if (predicate()) return resolve(true);
      if (signal?.aborted) return resolve(false);
      const done = (value) => {
        clearTimeout(timer);
        state.waiters.delete(check);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const check = () => predicate() && done(true);
      const onAbort = () => done(false);
      const timer = setTimeout(() => done(predicate()), ms);
      state.waiters.add(check);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  /**
   * The plugin's watch on a bot's browser, opened if needed; null when the
   * browser cannot be watched (not running, or not answering in time).
   */
  function ensureWatch(
    bot,
    ms = timeouts.discoveryMs + timeouts.connectMs + timeouts.commandMs,
    allow = () => true,
  ) {
    const known = state.watches.get(bot.profile);
    if (known?.watch && !known.watch.closed) return Promise.resolve(known.watch);
    // A watch already being set up is waited for no longer than `ms` either.
    const pending = known?.pending ?? startWatch(bot, allow);
    let timer;
    return Promise.race([
      pending,
      new Promise((resolve) => (timer = unref(setTimeout(() => resolve(null), ms)))),
    ]).finally(() => clearTimeout(timer));
  }

  /** Set up the plugin's watch of a bot's browser; resolves with it, or null. */
  function startWatch(bot, allow) {
    const entry = { registration, watch: null, pending: null };
    // Set up on the opener's behalf: each setup command only while `allow` holds.
    const carried = (browserUrl) => {
      const known = state.unfinishedDownloads.get(bot.profile);
      return known?.browserUrl === browserUrl ? known.guids : [];
    };
    entry.pending = watchBrowser(bot, { ...net, onChange: changed, allow, carried })
      .then((watch) => {
        if (state.watches.get(bot.profile) !== entry || stopped) {
          watch.close();
          return null;
        }
        // Set up. What it sends later (Page.enable for a tab opened later) is
        // the plugin's own observation of the bot's browser, on no caller's behalf.
        watch.setAllow(() => !stopped);
        entry.watch = watch;
        watch.onClose(() => {
          if (state.watches.get(bot.profile) === entry) state.watches.delete(bot.profile);
          // Remembered for the next watch of this same browser.
          const guids = watch.inProgress();
          if (guids.length > 0) {
            state.unfinishedDownloads.set(bot.profile, { browserUrl: watch.browserUrl, guids });
          } else state.unfinishedDownloads.delete(bot.profile);
          changed();
        });
        return watch;
      })
      .catch(() => {
        if (state.watches.get(bot.profile) === entry) state.watches.delete(bot.profile);
        return null;
      })
      .finally(() => (entry.pending = null));
    state.watches.set(bot.profile, entry);
    return entry.pending;
  }

  const emitControl = (lease, eventState, reason) =>
    emitEvent("control", {
      agentId: lease.agentId,
      profile: lease.profile,
      targetId: lease.targetId,
      holder: eventState === "draining" || eventState === "granted" ? "user" : "bot",
      state: eventState,
      generation: lease.generation,
      ...(reason ? { reason } : {}),
    });
  const runningCalls = (profile) =>
    [...state.inflight.values()].filter((call) => call.profile === profile).length;
  /** Whether a call on the profile reported its start within `callConfirmMs`. */
  const confirmedCalls = (profile) =>
    [...state.inflight.values()].some(
      (call) => call.profile === profile && Date.now() - call.startedAt < callConfirmMs,
    );
  const leaseOnProfile = (profile) =>
    [...state.leases.values()].some((lease) => lease.profile === profile);

  // ---- leases ----

  /**
   * End a lease: stop and settle its queued input, then unblock the bot and
   * say so. Safe to call any number of times; returns the same promise.
   */
  function endLease(lease, endState, reason) {
    if (lease.ended) return lease.ended;
    // Claimed first: aborting below closes the lease's own connection to the
    // tab, whose close handler calls here again and must get this ending.
    let finish;
    lease.ended = new Promise((resolve) => (finish = resolve));
    lease.ending = true;
    clearTimeout(lease.expiry);
    for (const unbind of lease.unbind) unbind();
    lease.abort.abort(reason);
    void (async () => {
      // Every step of an input honours the abort, so this settles at once;
      // the cap only guards against a step that does not.
      let cap;
      await Promise.race([
        lease.queue,
        new Promise((resolve) => (cap = unref(setTimeout(resolve, SETTLE_CAP_MS)))),
      ]);
      clearTimeout(cap);
      lease.cdp?.close();
      try {
        lease.retained?.release();
      } catch {
        // already released
      }
      if (state.leases.get(lease.key) === lease) state.leases.delete(lease.key);
      emitControl(lease, endState, reason);
      changed();
    })().finally(finish);
    return lease.ended;
  }

  function armLeaseExpiry(lease) {
    clearTimeout(lease.expiry);
    lease.expiry = unref(
      setTimeout(() => void endLease(lease, "expired", "not-renewed"), renewTimeoutMs),
    );
  }

  /**
   * Bring the lease's tab to rest before it is granted. A finished tool
   * result, an aborted call or a stopped run is not proof that the browser is
   * quiet: the gateway's own browser work (a navigation, say) can go on after
   * all three. So the plugin stops loading at the browser itself, turns on
   * the tab's page events, stops again, and watches: any navigation starting
   * or committing within the quiet window is stopped again and the window
   * starts over. True once a whole window passes quietly; false at the
   * deadline, when a command fails or is not answered, or when the lease
   * ends.
   */
  async function quiesce(lease, current, watch) {
    const { cdp } = lease;
    const { signal } = lease.abort;
    // Every command goes out on the caller's behalf, so only while its access holds.
    const send = (method) => {
      if (!current()) throw STALE;
      return cdp.send(method, {}, { signal });
    };
    const activity = () => lease.activity;
    const deadline = Date.now() + quietTimeoutMs;
    try {
      // Stopped first: Chromium answers Page.enable on a new connection only
      // once a pending navigation has committed, but answers a stop at once
      // and cancels that navigation.
      await send("Page.stopLoading");
      await send("Page.enable");
      for (;;) {
        // Losing the watch is a refusal, at any moment.
        if (watch.closed) return "closed";
        const seen = activity();
        await send("Page.stopLoading");
        // What the plugin cannot stop, a download or another tab loading, it
        // waits for, and refuses at the deadline.
        const settled = await waitUntil(
          () => watch.unresolved() === null || lease.ending,
          deadline - Date.now(),
          signal,
        );
        if (lease.ending || signal.aborted) return false;
        if (!settled) return watch.unresolved() ?? false;
        if (activity() !== seen) continue;
        if (Date.now() + quietWindowMs > deadline) return false;
        const disturbed = await waitUntil(
          () => activity() !== seen || watch.unresolved() !== null || lease.ending,
          quietWindowMs,
          signal,
        );
        if (lease.ending || signal.aborted) return false;
        if (!disturbed) {
          // Proof that the connection a grant would hand over still works:
          // a command answered on it after the last stop.
          await send("Page.getFrameTree");
          if (lease.ending || signal.aborted) return false;
          if (cdp.closed) return "lost";
          // What it saw while the proof was out starts the window over (or,
          // the watch lost, refuses at the top of the loop).
          if (watch.closed || activity() !== seen || watch.unresolved() !== null) continue;
          return true;
        }
      }
    } catch (error) {
      if (error === STALE) return "stale";
      // A command not answered: a load or download seen says so; with none, the proof failed.
      return cdp.closed ? "lost" : (watch.unresolved() ?? "unproved");
    }
  }

  /**
   * Whether the tab and the bot's browser are, at this instant, as quiet as
   * the plugin last found them: nothing unresolved in the watch, the watch
   * still open, and no navigation in the tab since `seen`.
   */
  const stillQuiet = (lease, watch, seen) =>
    !watch.closed && watch.unresolved() === null && lease.activity === seen && !lease.cdp.closed;

  /** Run `fn` after everything already queued on this lease (input, release, expiry). */
  function exclusive(lease, fn) {
    const run = lease.queue.then(fn, fn);
    lease.queue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  // ---- streams ----

  function endStream(stream, code, reason) {
    if (stream.ended) return;
    stream.ended = true;
    state.streams.delete(stream.id);
    if (stream.ticket) state.tickets.delete(stream.ticket);
    clearTimeout(stream.expiry);
    clearTimeout(stream.ticketExpiry);
    for (const unbind of stream.unbind) unbind();
    stream.abort.abort(reason);
    stream.cdp?.close();
    try {
      stream.retained?.release();
    } catch {
      // already released
    }
    const { socket } = stream;
    if (socket && !socket.destroyed) {
      socket.write(closeFrame(code, reason));
      socket.end();
      unref(setTimeout(() => socket.destroy(), 1000));
    }
  }

  function armStreamExpiry(stream) {
    clearTimeout(stream.expiry);
    stream.expiry = unref(
      setTimeout(() => endStream(stream, 4006, "authority_revoked"), renewTimeoutMs),
    );
  }

  /** End every lease and view on a bot's tabs that its browser no longer lists. */
  function reconcile(bot, tabs) {
    const live = new Set(tabs.map((tab) => tab.id));
    for (const lease of state.leases.values()) {
      if (lease.profile === bot.profile && !live.has(lease.targetId)) {
        void endLease(lease, "tab-closed", "tab-gone");
      }
    }
    for (const stream of state.streams.values()) {
      if (stream.bot.profile === bot.profile && !live.has(stream.targetId)) {
        endStream(stream, 4004, "target_closed");
      }
    }
  }

  /**
   * Why a connection to a tab closed. A closed socket is not proof that the
   * tab was closed: the browser can have stopped or been replaced, or the
   * connection alone dropped. "tab" only when the bot's browser answers and
   * no longer lists the tab.
   */
  async function whyClosed(bot, targetId) {
    try {
      const tabs = await cdpTargets(bot, net);
      return tabs.some((tab) => tab.id === targetId) ? "connection" : "tab";
    } catch {
      return "browser";
    }
  }

  /** End every lease and view of a bot whose browser config no longer matches. */
  function retireBot(bot, reason) {
    const watched = state.watches.get(bot.profile);
    if (watched) {
      state.watches.delete(bot.profile);
      watched.watch?.close();
    }
    for (const lease of state.leases.values()) {
      if (lease.profile === bot.profile) void endLease(lease, "revoked", reason);
    }
    for (const stream of state.streams.values()) {
      if (stream.bot.profile === bot.profile) endStream(stream, 4006, "authority_revoked");
    }
  }

  // ---- admission ----

  /** The caller's connection: its id and the signal that aborts when it closes. */
  function callerOf(opts) {
    const client = opts.client;
    const connId = typeof client?.connId === "string" && client.connId ? client.connId : null;
    const signal = isSignal(client?.connectionSignal) ? client.connectionSignal : undefined;
    const gone = () => signal?.aborted === true || client?.invalidated === true;
    if (!connId) refuse("FORBIDDEN", "no_connection", "this call needs a gateway connection");
    if (gone()) refuse("UNAVAILABLE", "connection_closed", "the connection has closed");
    return { connId, signal, gone };
  }

  /** Call `fn` once when the connection closes; returns the unbinder. */
  function onGone(signal, fn) {
    if (!signal) return () => {};
    signal.addEventListener("abort", fn, { once: true });
    return () => signal.removeEventListener("abort", fn);
  }

  /** The bot of the session the gateway admitted, with a matching browser config. */
  function admitBot(opts) {
    const auth = opts.sessionAccessAuthority;
    const agentId = auth?.target?.agentId;
    if (!auth?.target?.sessionKey || typeof agentId !== "string") {
      refuse("FORBIDDEN", "session_access_required", "this call needs access to a bot's session");
    }
    const bot = bots.get(agentId);
    if (!bot) {
      refuse(
        "UNAVAILABLE",
        "bot_not_configured",
        "this bot has no browser of its own in the computer plugin",
      );
    }
    const problems = browserConfigProblems(currentConfig(), config, env);
    if (problems.length > 0) {
      retireBot(bot, "browser-config-changed");
      refuse(
        "UNAVAILABLE",
        "browser_config_mismatch",
        `the browser config changed: ${problems[0]}`,
      );
    }
    return { auth, bot };
  }

  const targetIdOf = (params) => {
    const targetId = params?.targetId;
    if (typeof targetId !== "string" || !TARGET_ID.test(targetId)) {
      refuse(
        "INVALID_REQUEST",
        "bad_target",
        "targetId must be a tab id from clawtrate-computer.tabs",
      );
    }
    return targetId;
  };

  async function liveTabs(bot, signal) {
    try {
      const tabs = await cdpTargets(bot, { ...net, signal });
      reconcile(bot, tabs);
      return tabs;
    } catch (error) {
      const reason = error instanceof CdpError ? error.reason : "browser_unavailable";
      return refuse("UNAVAILABLE", reason, "the bot's browser did not answer");
    }
  }

  /** The tab, live in the session's bot's own browser. */
  async function admitTab(bot, targetId, caller) {
    const tab = (await liveTabs(bot, caller.signal)).find((t) => t.id === targetId);
    if (!tab)
      refuse("FORBIDDEN", "tab_not_in_bots_browser", "the tab is not in this bot's browser");
    return tab;
  }

  /** The caller's current lease on the tab, if it holds it with this generation. */
  function heldLease(bot, targetId, caller, generation) {
    const lease = state.leases.get(leaseKey(bot.profile, targetId));
    if (
      !lease ||
      lease.ending ||
      lease.holderConnId !== caller.connId ||
      typeof generation !== "string" ||
      lease.generation !== generation
    ) {
      return null;
    }
    return lease;
  }

  const retainOf = (auth) => {
    let retained;
    try {
      retained = auth.retain();
      retained.assertCurrent();
      return retained;
    } catch {
      try {
        retained?.release();
      } catch {
        // already released
      }
      return refuse("FORBIDDEN", "session_access_ended", "the session's access ended");
    }
  };

  /**
   * Whether the caller may still be answered: its connection is open and the
   * gateway still grants the access (`authority`, the request's or a
   * retained one). Access can end, or start refreshing, while the plugin
   * waits on the browser, before any abort reaches it; so this runs after
   * every wait and before anything is disclosed or granted.
   */
  const stillCurrent = (caller, authority) => {
    if (caller.gone()) return false;
    try {
      authority.assertCurrent();
      return true;
    } catch {
      return false;
    }
  };
  const accessEnded = () =>
    refuse("FORBIDDEN", "session_access_ended", "the session's access ended");

  // ---- methods ----

  const method = (name, handler) =>
    api.registerGatewayMethod(
      `${PLUGIN_ID}.${name}`,
      async (opts) => {
        try {
          await handler(opts, isPlainObject(opts.params) ? opts.params : {});
        } catch (error) {
          if (!(error instanceof RequestError)) throw error;
          opts.respond(false, undefined, {
            code: error.code,
            message: error.message,
            details: { reason: error.reason },
          });
        }
      },
      { scope: "operator.write", sessionAccess: { mode: "write", requiredTool: "browser" } },
    );

  method("tabs", async (opts) => {
    const caller = callerOf(opts);
    const { auth, bot } = admitBot(opts);
    let tabs;
    try {
      tabs = await cdpTargets(bot, { ...net, signal: caller.signal });
    } catch (error) {
      if (!stillCurrent(caller, auth)) accessEnded();
      // An empty list says only that there is nothing to show.
      opts.respond(true, {
        agentId: bot.agentId,
        profile: bot.profile,
        browser: "not-running",
        reason: error instanceof CdpError ? error.reason : "browser_unavailable",
        tabs: [],
      });
      return;
    }
    reconcile(bot, tabs);
    // Nothing about the tabs is said once the caller's access has ended.
    if (!stillCurrent(caller, auth)) accessEnded();
    opts.respond(true, {
      agentId: bot.agentId,
      profile: bot.profile,
      browser: "running",
      tabs: tabs.map((tab) => {
        const lease = state.leases.get(leaseKey(bot.profile, tab.id));
        return {
          targetId: tab.id,
          url: tab.url,
          title: tab.title,
          lease:
            lease && !lease.ending
              ? { state: lease.state, mine: lease.holderConnId === caller.connId }
              : null,
        };
      }),
    });
  });

  method("view.open", async (opts, params) => {
    const caller = callerOf(opts);
    const { auth, bot } = admitBot(opts);
    const targetId = targetIdOf(params);
    await admitTab(bot, targetId, caller);
    if (!stillCurrent(caller, auth)) accessEnded();
    const mine = [...state.streams.values()].filter((s) => s.connId === caller.connId);
    if (state.streams.size >= MAX_STREAMS || mine.length >= MAX_STREAMS_PER_CONNECTION) {
      refuse("UNAVAILABLE", "too_many_views", "too many views are open");
    }
    if (caller.gone()) refuse("UNAVAILABLE", "connection_closed", "the connection has closed");
    const ticket = randomBytes(24).toString("hex");
    const stream = {
      id: randomUUID(),
      registration,
      bot,
      targetId,
      connId: caller.connId,
      retained: retainOf(auth),
      abort: new AbortController(),
      ticket,
      socket: null,
      cdp: null,
      ended: false,
      unbind: [],
    };
    stream.unbind.push(onGone(caller.signal, () => endStream(stream, 4006, "authority_revoked")));
    if (isSignal(stream.retained.signal)) {
      stream.unbind.push(
        onGone(stream.retained.signal, () => endStream(stream, 4006, "authority_revoked")),
      );
    }
    const expiresAtMs = Date.now() + ticketTtlMs;
    stream.ticketExpiry = unref(
      setTimeout(() => {
        // A ticket that was never used ends its view.
        if (!stream.socket) endStream(stream, 4006, "ticket_expired");
      }, ticketTtlMs),
    );
    state.streams.set(stream.id, stream);
    state.tickets.set(ticket, stream.id);
    armStreamExpiry(stream);
    opts.respond(true, {
      streamId: stream.id,
      wsPath: `${STREAM_PATH}?ticket=${ticket}`,
      expiresAtMs,
      renewWithinMs: renewTimeoutMs,
      targetId,
    });
  });

  method("view.renew", async (opts, params) => {
    const caller = callerOf(opts);
    const { auth, bot } = admitBot(opts);
    const targetId = targetIdOf(params);
    if (params.streamId === undefined && params.generation === undefined) {
      refuse("INVALID_REQUEST", "bad_request", "give a streamId, a generation, or both");
    }
    await admitTab(bot, targetId, caller);
    const stream =
      typeof params.streamId === "string" ? state.streams.get(params.streamId) : undefined;
    const ownStream =
      stream &&
      !stream.ended &&
      stream.connId === caller.connId &&
      stream.bot.profile === bot.profile &&
      stream.targetId === targetId
        ? stream
        : undefined;
    const lease = heldLease(bot, targetId, caller, params.generation);
    if (!stillCurrent(caller, auth)) {
      // What this caller holds on the tab ends with its access.
      if (ownStream) endStream(ownStream, 4006, "authority_revoked");
      if (lease) void endLease(lease, "revoked", "access-revoked");
      accessEnded();
    }
    let streamRenewed = false;
    if (ownStream) {
      if (stillCurrent(caller, ownStream.retained)) {
        armStreamExpiry(ownStream);
        streamRenewed = true;
      } else {
        endStream(ownStream, 4006, "authority_revoked");
      }
    }
    let leaseRenewed = false;
    if (lease && lease.state === "granted") {
      try {
        lease.retained.assertCurrent();
        armLeaseExpiry(lease);
        leaseRenewed = true;
      } catch {
        void endLease(lease, "revoked", "access-revoked");
      }
    }
    opts.respond(true, { ok: true, renewWithinMs: renewTimeoutMs, streamRenewed, leaseRenewed });
  });

  method("control.take", async (opts, params) => {
    const caller = callerOf(opts);
    const { auth, bot } = admitBot(opts);
    const targetId = targetIdOf(params);
    await admitTab(bot, targetId, caller);
    const key = leaseKey(bot.profile, targetId);
    if (state.leases.has(key)) {
      refuse("UNAVAILABLE", "control_held", "someone has or is taking control of this tab");
    }
    if (caller.gone()) refuse("UNAVAILABLE", "connection_closed", "the connection has closed");
    const lease = {
      key,
      registration,
      agentId: bot.agentId,
      profile: bot.profile,
      targetId,
      bot,
      generation: randomBytes(16).toString("hex"),
      holderConnId: caller.connId,
      state: "draining",
      retained: retainOf(auth),
      abort: new AbortController(),
      queue: Promise.resolve(),
      ending: false,
      ended: null,
      cdp: null,
      unbind: [],
    };
    state.leases.set(key, lease);
    lease.unbind.push(
      onGone(caller.signal, () => void endLease(lease, "revoked", "connection-closed")),
    );
    if (isSignal(lease.retained.signal)) {
      lease.unbind.push(
        onGone(lease.retained.signal, () => void endLease(lease, "revoked", "access-revoked")),
      );
    }
    emitControl(lease, "draining");
    changed();
    const current = () => stillCurrent(caller, lease.retained) && stillCurrent(caller, auth);
    /** End the lease as busy and say so, but only to a caller whose access still holds. */
    const busy = async (cause, reason) => {
      const running = runningCalls(bot.profile);
      await endLease(lease, "busy", cause);
      if (!stillCurrent(caller, auth)) accessEnded();
      opts.respond(true, {
        state: "busy",
        reason,
        // The same code as the control event's reason; `reason` is the sentence.
        cause,
        runningCalls: running,
        generation: lease.generation,
      });
    };
    // New bot calls are blocked from now on; running ones get drainTimeoutMs.
    const drained = await waitUntil(
      () => runningCalls(bot.profile) === 0,
      drainTimeoutMs,
      lease.abort.signal,
    );
    if (lease.ending)
      refuse("UNAVAILABLE", "control_request_ended", "the request for control ended");
    if (!current()) {
      await endLease(lease, "revoked", "access-revoked");
      accessEnded();
    }
    // A call that has not reported its end for `callConfirmMs` may have ended
    // without the gateway saying so: the take says it cannot confirm.
    if (!drained) {
      return busy(...(confirmedCalls(bot.profile) ? UNRESOLVED.calls : UNRESOLVED.unconfirmed));
    }
    // The lease's own connection to the tab: input goes through it, and the
    // lease ends when it closes (the tab or the browser went away).
    try {
      lease.cdp = await openCdp(bot, targetId, { ...net, signal: lease.abort.signal });
    } catch (error) {
      if (!lease.ending) {
        const gone = error instanceof CdpError && error.reason === "target_gone";
        await endLease(
          lease,
          gone ? "tab-closed" : "revoked",
          gone ? "tab-gone" : "browser-unavailable",
        );
      }
      refuse("UNAVAILABLE", "control_request_ended", "could not connect to the tab");
    }
    // Every navigation the tab reports, from its connection on until the grant.
    lease.activity = 0;
    lease.cdp.on((message) => {
      if (lease.state === "draining" && NAVIGATION_EVENTS.has(message.method)) {
        lease.activity += 1;
        changed();
      }
    });
    lease.cdp.onClose(() => {
      if (lease.ending) return;
      void whyClosed(bot, targetId).then((why) =>
        why === "tab"
          ? endLease(lease, "tab-closed", "target-closed")
          : endLease(lease, "revoked", "browser-unavailable"),
      );
    });
    if (lease.ending)
      refuse("UNAVAILABLE", "control_request_ended", "the request for control ended");
    // What the plugin can see in the bot's browser, it must not grant over.
    // A watch this take sets up sends each of its commands only while the
    // caller's access holds, checked right before it.
    if (!current()) {
      await endLease(lease, "revoked", "access-revoked");
      accessEnded();
    }
    const watch = await ensureWatch(bot, undefined, current);
    if (lease.ending)
      refuse("UNAVAILABLE", "control_request_ended", "the request for control ended");
    if (!current()) {
      await endLease(lease, "revoked", "access-revoked");
      accessEnded();
    }
    if (!watch) return busy(...UNRESOLVED.closed);
    // A tab that did not answer the watch before is asked again: one slow
    // answer never leaves a take refused for good.
    await watch.recheck();
    const quiet = await quiesce(lease, current, watch);
    const seen = lease.activity;
    if (lease.ending)
      refuse("UNAVAILABLE", "control_request_ended", "the request for control ended");
    if (quiet === "stale" || !current()) {
      await endLease(lease, "revoked", "access-revoked");
      accessEnded();
    }
    // Never granted on a connection that has died, whatever its close handler finds out later.
    if (quiet === "lost" || lease.cdp.closed) {
      await endLease(lease, "revoked", "browser-unavailable");
      refuse("UNAVAILABLE", "control_request_ended", "the connection to the tab closed");
    }
    // Never granted while the bot's browser may still be loading or downloading what the bot started.
    if (quiet !== true) return busy(...(UNRESOLVED[quiet] ?? UNRESOLVED.loading));
    // Connecting waited: the grant goes out only while the access still holds.
    if (!current()) {
      await endLease(lease, "revoked", "access-revoked");
      accessEnded();
    }
    if (lease.cdp.closed) {
      await endLease(lease, "revoked", "browser-unavailable");
      refuse("UNAVAILABLE", "control_request_ended", "the connection to the tab closed");
    }
    // The grant is the last thing that happens: anything seen up to this
    // instant refuses it (nothing has awaited since the quiet step's last look).
    if (!stillQuiet(lease, watch, seen)) {
      // A navigation seen in the tab is loading; a connection gone since is no proof at all.
      const why = watch.closed
        ? "closed"
        : (watch.unresolved() ?? (lease.cdp.closed ? "unproved" : "loading"));
      return busy(...(UNRESOLVED[why] ?? UNRESOLVED.loading));
    }
    lease.state = "granted";
    armLeaseExpiry(lease);
    emitControl(lease, "granted");
    opts.respond(true, {
      state: "granted",
      generation: lease.generation,
      renewWithinMs: renewTimeoutMs,
      targetId,
      guarantee: GRANT_GUARANTEE,
    });
  });

  method("control.release", async (opts, params) => {
    const caller = callerOf(opts);
    const { bot } = admitBot(opts);
    // No browser round trip: a release completes even when the browser is stalled.
    const targetId = targetIdOf(params);
    const lease = heldLease(bot, targetId, caller, params.generation);
    if (!lease) {
      refuse("FORBIDDEN", "not_holder", "only the current holder can release, with its generation");
    }
    await endLease(lease, "released", "released");
    // Released either way; the answer goes only to a caller whose access still holds.
    if (!stillCurrent(caller, opts.sessionAccessAuthority)) accessEnded();
    opts.respond(true, { state: "released", generation: lease.generation, targetId });
  });

  method("input", async (opts, params) => {
    const caller = callerOf(opts);
    const { auth, bot } = admitBot(opts);
    const targetId = targetIdOf(params);
    if (typeof params.generation !== "string" || !GENERATION.test(params.generation)) {
      refuse("FORBIDDEN", "not_holder", "take control first");
    }
    const commands = inputCommands(params);
    const lease = heldLease(bot, targetId, caller, params.generation);
    if (!lease || lease.state !== "granted")
      refuse("FORBIDDEN", "not_holder", "take control first");
    // The holder, the lease and the session's access are checked again
    // before every command, so input admitted under a lease cannot land
    // after it ends.
    const accessHolds = () => stillCurrent(caller, auth) && stillCurrent(caller, lease.retained);
    const stillHeld = () => {
      if (lease.ending || state.leases.get(lease.key) !== lease || lease.state !== "granted") {
        throw new CdpError("lease_ended", "control ended");
      }
      if (!stillCurrent(caller, auth)) throw new Error("the request's access ended");
      lease.retained.assertCurrent();
    };
    try {
      await exclusive(lease, async () => {
        for (const [name, args] of commands) {
          stillHeld();
          if (!lease.cdp || lease.cdp.closed) throw new CdpError("closed", "the tab closed");
          await lease.cdp.send(name, args, { signal: lease.abort.signal });
        }
      });
    } catch (error) {
      // However the input ended (refused, failed, or its reply never came),
      // a lease whose caller has lost access is ended, not kept.
      if (!accessHolds()) {
        await endLease(lease, "revoked", "access-revoked");
        accessEnded();
      }
      refuse(
        "UNAVAILABLE",
        "input_not_delivered",
        `input not delivered: ${error?.message ?? error}`,
      );
    }
    // The last reply waited too: nothing is confirmed, and the lease is not
    // extended, unless the lease and the caller's access still hold now.
    try {
      stillHeld();
    } catch (error) {
      if (!(error instanceof CdpError) || !accessHolds()) {
        await endLease(lease, "revoked", "access-revoked");
        accessEnded();
      }
      refuse("UNAVAILABLE", "input_not_delivered", "control ended before the input was confirmed");
    }
    armLeaseExpiry(lease);
    opts.respond(true, { ok: true });
  });

  // ---- the stream ----

  api.registerHttpRoute({
    path: STREAM_PATH,
    auth: "plugin",
    match: "exact",
    handler: (_req, res) => {
      res.writeHead(426, { "content-type": "text/plain" });
      res.end("websocket upgrade required");
      return true;
    },
    handleUpgrade: async (req, socket, head) => {
      socket.on("error", () => {});
      const ticket = new URL(req.url ?? "", "http://127.0.0.1").searchParams.get("ticket") ?? "";
      // One use: deleted before anything else can happen.
      const streamId = state.tickets.get(ticket);
      state.tickets.delete(ticket);
      const stream = streamId ? state.streams.get(streamId) : undefined;
      if (!stream || stream.ended || stream.socket) {
        refuseUpgrade(socket, 401, "Unauthorized");
        return true;
      }
      stream.ticket = null;
      clearTimeout(stream.ticketExpiry);
      try {
        stream.retained.assertCurrent();
      } catch {
        endStream(stream, 4006, "authority_revoked");
        refuseUpgrade(socket, 401, "Unauthorized");
        return true;
      }
      if (!acceptUpgrade(req, socket)) {
        endStream(stream, 1002, "bad_upgrade");
        refuseUpgrade(socket, 400, "Bad Request");
        return true;
      }
      stream.socket = socket;
      socket.setNoDelay?.(true);
      const read = frameReader(
        ({ opcode, payload }) => {
          if (opcode === 0x8) endStream(stream, 1000, "closed");
          else if (opcode === 0x9 && !socket.destroyed) socket.write(frame(0xa, payload));
        },
        (code, reason) => endStream(stream, code, reason),
      );
      socket.on("data", read);
      socket.on("close", () => endStream(stream, 1000, "closed"));
      if (head?.length) read(head);
      let cdp;
      try {
        cdp = await openCdp(stream.bot, stream.targetId, { ...net, signal: stream.abort.signal });
      } catch (error) {
        const gone = error instanceof CdpError && error.reason === "target_gone";
        endStream(stream, gone ? 4004 : 1011, gone ? "target_closed" : "browser_unavailable");
        return true;
      }
      if (stream.ended) {
        cdp.close();
        return true;
      }
      stream.cdp = cdp;
      let url = cdp.target.url;
      const lost = () => {
        if (stream.ended) return;
        void whyClosed(stream.bot, stream.targetId).then((why) =>
          why === "tab"
            ? endStream(stream, 4004, "target_closed")
            : endStream(stream, 1011, "browser_unavailable"),
        );
      };
      cdp.onClose(lost);
      // Nothing about the page goes out once the access behind the ticket
      // has ended: not the first address and title, not a later address.
      const current = () => {
        try {
          stream.retained.assertCurrent();
          return true;
        } catch {
          endStream(stream, 4006, "authority_revoked");
          return false;
        }
      };
      if (!current()) return true;
      socket.write(
        textFrame({ type: "ready", targetId: stream.targetId, url, title: cdp.target.title }),
      );
      cdp.on((message) => {
        if (stream.ended) return;
        if (message.method === "Page.screencastFrame") {
          const { data, metadata = {}, sessionId } = message.params ?? {};
          if (!current()) return;
          void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
          if (typeof data !== "string" || socket.destroyed) return;
          if (socket.writableLength > STREAM_BUFFER_LIMIT) return;
          // The built-in screencast's layout, so one decoder serves both:
          // a 4-byte big-endian header length, the JSON header, the JPEG.
          const header = Buffer.from(
            JSON.stringify({
              url,
              cssWidth: metadata.deviceWidth,
              cssHeight: metadata.deviceHeight,
              scrollX: metadata.scrollOffsetX,
              scrollY: metadata.scrollOffsetY,
              ts: metadata.timestamp,
            }),
          );
          const length = Buffer.alloc(4);
          length.writeUInt32BE(header.length, 0);
          socket.write(binaryFrame(Buffer.concat([length, header, Buffer.from(data, "base64")])));
        } else if (message.method === "Page.frameNavigated" && !message.params?.frame?.parentId) {
          if (!current()) return;
          url = String(message.params?.frame?.url ?? "").slice(0, 2048);
          socket.write(textFrame({ type: "meta", url }));
        } else if (message.method === "Inspector.detached") {
          // The browser says why: only "target_closed" is the tab closing.
          if (message.params?.reason === "target_closed") endStream(stream, 4004, "target_closed");
          else lost();
        }
      });
      try {
        if (!current()) return true;
        await cdp.send("Page.enable", {}, { signal: stream.abort.signal });
        if (!current()) return true;
        await cdp.send(
          "Page.startScreencast",
          { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 1280, everyNthFrame: 1 },
          { signal: stream.abort.signal },
        );
      } catch {
        if (!stream.ended) endStream(stream, 1011, "browser_unavailable");
      }
      return true;
    },
  });

  // ---- the bot's browser tool ----

  // Priority 1000, chosen to be above the usual ones so the pin is in place
  // before most other hooks see the call; the gateway runs hooks highest
  // first, and another plugin can choose a higher priority. A block here
  // ends the decision.
  api.on(
    "before_tool_call",
    (event, ctx) => {
      if (event?.toolName !== "browser") return undefined;
      const params = isPlainObject(event.params) ? event.params : {};
      const bot = bots.get(ctx?.agentId);
      if (!bot) {
        // Every other agent stays out of the bots' browsers: by any spelling
        // of a bot's profile, by another profile that the gateway resolves to
        // a bot's endpoint, by default, as an import destination or through
        // a dashboard.
        const now = currentConfig();
        // An import with no `into` goes to DEFAULT_IMPORT_PROFILE.
        const reached = [
          profileOwner(now, config, params.profile, env),
          profileOwner(now, config, toolString(params.into) ?? DEFAULT_IMPORT_PROFILE, env),
        ];
        if (reached.some((owner) => owner.bot)) {
          return { block: true, blockReason: "That browser profile belongs to another bot." };
        }
        if (reached.some((owner) => owner.unresolved)) {
          return {
            block: true,
            blockReason:
              "The browser config cannot be read, so which browser this call reaches is unknown.",
          };
        }
        if (params.dashboard !== undefined) {
          return {
            block: true,
            blockReason: "Browser dashboards are off while bots have browsers of their own.",
          };
        }
        return undefined;
      }
      const action = toolString(params.action);
      if (!BOT_ACTIONS.has(action)) {
        return {
          block: true,
          blockReason: `Browser action "${action ?? ""}" is not available to this bot.`,
        };
      }
      const target = toolString(params.target);
      if (
        params.node !== undefined ||
        params.dashboard !== undefined ||
        params.into !== undefined ||
        (target !== undefined && target !== "host")
      ) {
        return {
          block: true,
          blockReason:
            "This bot's browser is its own, on the gateway's machine; node, sandbox, dashboard and import routing are not allowed.",
        };
      }
      const runId = toolString(event.runId) ?? toolString(ctx?.runId);
      const toolCallId = toolString(event.toolCallId) ?? toolString(ctx?.toolCallId);
      if (!runId || !toolCallId) {
        return {
          block: true,
          blockReason:
            "A browser call without a run and call id cannot be tracked, so it is refused.",
        };
      }
      // Recorded before anything is awaited: however the gateway's hooks are
      // ordered or timed, the call is never running unrecorded. A refusal
      // below takes the record back.
      const key = callKey(runId, toolCallId);
      const record = trackCall(bot, runId, toolCallId, ctx);
      const refused = (answer) => {
        if (record) untrackCall(key, record);
        return answer;
      };
      const refusal = () => {
        if (leaseOnProfile(bot.profile)) return { block: true, blockReason: BLOCKED_WHILE_HELD };
        if (browserConfigProblems(currentConfig(), config, env).length > 0) {
          return {
            block: true,
            blockReason: "This bot's browser is not set up as the computer plugin expects.",
          };
        }
        return null;
      };
      const early = refusal();
      if (early) return refused(early);
      // The plugin watches the bot's browser before the call runs, so that a
      // later take can see a download or a load the call starts. A browser not
      // running yet is watched once the call has started it (after_tool_call).
      return ensureWatch(bot, WATCH_WAIT_MS).then(() => {
        // The hold and the config can have changed while it waited.
        const late = refusal();
        if (late) return refused(late);
        // target "host": never a node or sandbox browser; when host control is
        // not allowed for the session, the browser tool refuses the call.
        return { params: { ...params, action, profile: bot.profile, target: "host" } };
      });
    },
    { matcher: ["browser"], priority: 1000 },
  );

  /**
   * Record a bot call as running, from its pre-call check. It stops counting
   * when its end arrives (after_tool_call), when its run ends (agent_end) or
   * when it is cancelled; one whose end already arrived is not recorded.
   */
  function trackCall(bot, runId, toolCallId, ctx) {
    const key = callKey(runId, toolCallId);
    if (state.endedCalls.has(key) || state.endedRuns.has(callKey(bot.agentId, runId))) return null;
    const record = {
      agentId: bot.agentId,
      profile: bot.profile,
      runId,
      startedAt: Date.now(),
      unbind: () => {},
    };
    // A cancelled call no longer counts as running (a take still brings the
    // tab to rest, see quiesce). The listener goes when the call completes,
    // so a long run does not gather one per call on its signal.
    const signal = ctx?.abortSignal;
    if (isSignal(signal)) {
      if (signal.aborted) return null;
      const forget = () => untrackCall(key, record);
      signal.addEventListener("abort", forget, { once: true });
      record.unbind = () => signal.removeEventListener("abort", forget);
    }
    state.inflight.set(key, record);
    changed();
    return record;
  }

  function untrackCall(key, record) {
    record.unbind();
    if (state.inflight.get(key) !== record) return;
    state.inflight.delete(key);
    changed();
  }

  /** The call's end arrived: it is not running, and a late pre-call check records nothing. */
  function callEnded(key) {
    state.endedCalls.delete(key);
    state.endedCalls.add(key);
    while (state.endedCalls.size > MAX_ENDED_CALLS) {
      state.endedCalls.delete(state.endedCalls.values().next().value);
    }
  }

  // A run's end ends its calls, also one whose own end never arrived, and one whose pre-call
  // check comes after it.
  api.on("agent_end", (event, ctx) => {
    const runId = toolString(ctx?.runId) ?? toolString(event?.runId);
    if (!runId || !bots.has(ctx?.agentId)) return;
    const run = callKey(ctx.agentId, runId);
    state.endedRuns.delete(run);
    state.endedRuns.add(run);
    while (state.endedRuns.size > MAX_ENDED_RUNS) {
      state.endedRuns.delete(state.endedRuns.values().next().value);
    }
    for (const [key, record] of [...state.inflight]) {
      if (record.runId !== runId || record.agentId !== ctx.agentId) continue;
      callEnded(key);
      untrackCall(key, record);
    }
  });

  api.on(
    "after_tool_call",
    (event, ctx) => {
      if (event?.toolName !== "browser") return;
      const runId = toolString(event.runId) ?? toolString(ctx?.runId);
      const toolCallId = toolString(event.toolCallId) ?? toolString(ctx?.toolCallId);
      if (!runId || !toolCallId) return;
      const key = callKey(runId, toolCallId);
      const record = state.inflight.get(key);
      // Only a configured bot's own call: its end, in whatever order it comes.
      if (!bots.has(ctx?.agentId) || (record && record.agentId !== ctx?.agentId)) return;
      callEnded(key);
      if (record) {
        untrackCall(key, record);
        // A call can have started the browser: watch it from now on.
        const bot = bots.get(record.agentId);
        if (bot) void ensureWatch(bot);
        const ran = profileSelector(event.params?.profile);
        if (ran !== undefined && ran !== record.profile) {
          warn(`a browser call of ${record.agentId} ran with profile ${ran}, not its own`);
        }
      }
    },
    { matcher: ["browser"] },
  );

  // ---- events and shutdown ----

  async function stop() {
    stopped = true;
    for (const [profile, entry] of state.watches) {
      if (entry.registration !== registration) continue;
      state.watches.delete(profile);
      entry.watch?.close();
    }
    const endings = [];
    for (const lease of state.leases.values()) {
      if (lease.registration === registration)
        endings.push(endLease(lease, "revoked", "plugin-stopped"));
    }
    for (const stream of state.streams.values()) {
      if (stream.registration === registration) endStream(stream, 1012, "shutdown");
    }
    await Promise.all(endings);
    emitEvent = () => {};
  }

  // Service ids are global across plugins, so this one carries the plugin's id.
  api.registerService({
    id: `${PLUGIN_ID}-control`,
    start(ctx) {
      const events = ctx?.gatewayEvents;
      emitEvent = events
        ? (name, payload) => events.emit(name, payload, { scope: "operator.read" })
        : () => {};
    },
    stop,
  });

  return { state, config, stop };
}

export default {
  id: PLUGIN_ID,
  name: "Clawtrate computer",
  description:
    "A browser of its own for each configured bot, a live view of it, and a person's takeover and hand-back.",
  register(api) {
    // Development gateways only, until the plugin is ready for others (README, issue #29): on
    // any other gateway it registers no method, route, hook or service, and says why.
    const problem = developmentInstanceProblem();
    if (problem) {
      const say = api.logger?.warn?.bind(api.logger) ?? console.warn;
      say(`clawtrate-computer registers nothing here: ${problem}`);
      return;
    }
    createComputer(api);
  },
};
