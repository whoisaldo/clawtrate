// A take is granted only when the tab is quiet. A finished tool result or a
// stopped run does not prove that the gateway's browser work has settled,
// so the plugin stops loading at the browser and waits for the tab to stay
// quiet; if it cannot establish that within its deadline it grants nothing.
// (The real case, a cancelled navigation on a real gateway, is a computer
// check in `pnpm scenarios`.)

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GRANT_GUARANTEE } from "../index.js";
import { ATLAS, ATLAS_TAB, load, page, sleep, until } from "./harness.ts";

const tab = { targetId: ATLAS_TAB };

describe("a take waits for a quiet tab", () => {
  it("stops loading at the browser, then grants after a whole quiet window", async () => {
    const h = load({ quietWindowMs: 150 });
    const asked = performance.now();
    const answer = await h.call("control.take", tab);
    const answered = performance.now();
    expect(answer.payload?.state).toBe("granted");
    const stops = h.browser.sentToTabs("Page.stopLoading");
    // On the lease's own connection to this tab: a stop before Page.enable
    // (which Chromium holds back while a navigation is pending), and one after.
    expect(stops.map((e) => e.url)).toEqual([
      `ws://127.0.0.1:19113/devtools/page/${ATLAS_TAB}`,
      `ws://127.0.0.1:19113/devtools/page/${ATLAS_TAB}`,
    ]);
    const enable = h.browser.sentToTabs("Page.enable")[0]!;
    expect(stops[0]!.t).toBeGreaterThan(asked);
    expect(stops[0]!.t).toBeLessThan(enable.t);
    expect(enable.t).toBeLessThan(stops[1]!.t);
    expect(answered - stops[1]!.t).toBeGreaterThanOrEqual(140);
    expect(h.statesOf(answer.payload!.generation)).toEqual(["draining", "granted"]);
    await h.stop();
  });

  it("stops again, and starts the window over, when a navigation starts or commits within it", async () => {
    const h = load({ quietWindowMs: 120, quietTimeoutMs: 3000 });
    const take = h.call("control.take", tab);
    // The stop before Page.enable, then one that opens a window: disturb each window once.
    let stops = 2;
    for (const method of ["Page.frameStartedLoading", "Page.frameNavigated"]) {
      await until(() => h.browser.sent("Page.stopLoading").length >= stops);
      h.browser.tabSockets.at(-1)!.event(method, { frameId: "f", frame: { id: "f", url: "x" } });
      stops += 1;
    }
    const answer = await take;
    expect(answer.payload?.state).toBe("granted");
    expect(h.browser.sent("Page.stopLoading")).toHaveLength(4);
    await h.stop();
  });

  it("refuses the take, busy because the browser is not quiet, when the tab keeps loading", async () => {
    const h = load({ quietWindowMs: 100, quietTimeoutMs: 600 });
    const take = h.call("control.take", tab);
    await until(() => h.browser.tabSockets.length > 0);
    const socket = h.browser.tabSockets.at(-1)!;
    const keepLoading = setInterval(
      () => socket.event("Page.frameStartedLoading", { frameId: "f" }),
      30,
    );
    let answer;
    try {
      answer = await take;
    } finally {
      clearInterval(keepLoading);
    }
    expect(answer.payload).toMatchObject({
      state: "busy",
      reason: "the bot's browser is still loading a page",
      runningCalls: 0,
    });
    const generation = answer.payload!.generation;
    expect(h.statesOf(generation)).toEqual(["draining", "busy"]);
    expect(h.events.find((e) => e.state === "busy")?.reason).toBe("browser-not-quiet");
    expect(h.state.leases.size).toBe(0);
    expect(socket.closed).toBe(true);
    // The bot is not left blocked.
    expect((await h.before("atlas", "run-a", "c1", { action: "tabs" }))?.block).toBeUndefined();
    await h.stop();
  });

  it("refuses the take in time when the browser holds back Page.enable (a navigation it could not stop)", async () => {
    const h = load({
      timeouts: { discoveryMs: 300, connectMs: 300, commandMs: 200 },
      quietTimeoutMs: 2000,
    });
    h.browser.stalledMethods.add("Page.enable");
    const answer = await h.call("control.take", tab);
    expect(answer.payload?.state).toBe("busy");
    expect(h.events.some((e) => e.state === "granted")).toBe(false);
    await h.stop();
  });

  it("refuses the take in time when the browser does not answer the stop", async () => {
    const h = load({
      timeouts: { discoveryMs: 300, connectMs: 300, commandMs: 200 },
      quietTimeoutMs: 2000,
    });
    h.browser.stalledMethods.add("Page.stopLoading");
    const started = performance.now();
    const answer = await h.call("control.take", tab);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(answer.payload?.state).toBe("busy");
    expect(h.events.some((e) => e.state === "granted")).toBe(false);
    expect(h.state.leases.size).toBe(0);
    await h.stop();
  });

  it("does not count the tab's own end of loading as activity", async () => {
    const h = load({ quietWindowMs: 120 });
    const take = h.call("control.take", tab);
    await until(() => h.browser.sent("Page.stopLoading").length >= 2);
    h.browser.tabSockets.at(-1)!.event("Page.frameStoppedLoading", { frameId: "f" });
    expect((await take).payload?.state).toBe("granted");
    expect(h.browser.sent("Page.stopLoading")).toHaveLength(2);
    await h.stop();
  });

  it("a caller that leaves while the tab is brought to rest is granted nothing", async () => {
    const h = load({ quietWindowMs: 300 });
    const connection = new AbortController();
    const take = h.call("control.take", tab, { connection });
    await until(() => h.browser.sent("Page.stopLoading").length >= 2);
    connection.abort();
    const answer = await take;
    expect(answer.error?.details?.reason).toBe("control_request_ended");
    expect(h.events.map((e) => e.state)).toEqual(["draining", "revoked"]);
    await h.stop();
  });

  it("stops listening to the tab's navigations once granted", async () => {
    const h = load();
    const answer = await h.call("control.take", tab);
    expect(answer.payload?.state).toBe("granted");
    const socket = h.browser.tabSockets.at(-1)!;
    // A person's own navigation after the grant changes nothing.
    socket.event("Page.frameStartedLoading", { frameId: "f" });
    socket.event("Page.frameNavigated", { frame: { id: "f", url: "x" } });
    expect(h.browser.sent("Page.stopLoading")).toHaveLength(2);
    expect(h.state.leases.values().next().value?.state).toBe("granted");
    await h.stop();
  });
});

describe("a grant hands over a live connection", () => {
  it("is refused when the lease's connection closes in the quiet window while the browser's list is slow", async () => {
    const h = load({
      quietWindowMs: 110,
      timeouts: { discoveryMs: 900, connectMs: 300, commandMs: 300 },
    });
    const take = h.call("control.take", tab);
    await until(() => h.browser.sent("Page.stopLoading").length === 2);
    h.browser.stallDiscovery = true;
    h.browser.tabSockets.at(-1)!.close();
    const answer = await take;
    expect([answer.ok, answer.error?.details?.reason]).toEqual([false, "control_request_ended"]);
    expect(h.events.some((e) => e.state === "granted")).toBe(false);
    expect(h.events.at(-1)).toMatchObject({ state: "revoked", reason: "browser-unavailable" });
    expect(h.state.leases.size).toBe(0);
    await h.stop();
  });

  it("is refused when the proof command after the last stop is not answered", async () => {
    const h = load({ timeouts: { discoveryMs: 300, connectMs: 300, commandMs: 200 } });
    h.browser.stalledMethods.add("Page.getFrameTree");
    const answer = await h.call("control.take", tab);
    expect(answer.payload?.state).not.toBe("granted");
    expect(h.events.some((e) => e.state === "granted")).toBe(false);
    await h.stop();
  });

  it("a proof command that isn't answered, with nothing seen loading, says the plugin couldn't confirm the browser settled, never that a page is loading", async () => {
    const h = load({ timeouts: { discoveryMs: 300, connectMs: 300, commandMs: 200 } });
    h.browser.stalledMethods.add("Page.getFrameTree");
    const answer = await h.call("control.take", tab);
    expect(answer.payload).toMatchObject({
      state: "busy",
      cause: "browser-not-watched",
      reason: "the plugin could not confirm that the bot's browser has settled",
    });
    await h.stop();
  });

  it("follows a command answered on its connection after the last stop", async () => {
    const h = load();
    const answer = await h.call("control.take", tab);
    expect(answer.payload?.state).toBe("granted");
    const page = h.browser.sent("").filter((e) => e.url.includes("/devtools/page/"));
    const lastStop = page.map((e) => e.method).lastIndexOf("Page.stopLoading");
    expect(page.slice(lastStop + 1).map((e) => e.method)).toEqual(["Page.getFrameTree"]);
    await h.stop();
  });
});

describe("what the plugin can see in the bot's browser, a take does not grant over", () => {
  const SECOND = "D".repeat(32);
  const watched = async (h: ReturnType<typeof load>) => {
    // A bot call is admitted only once the plugin watches its browser.
    await h.before("atlas", "run-w", "c-w", { action: "tabs" });
    await h.after("atlas", "run-w", "c-w");
    expect(h.browser.watchSocket(ATLAS), "no watch on the bot's browser").toBeDefined();
  };

  it("refuses while a download in that browser is in progress, and grants once it has finished", async () => {
    const h = load({ quietWindowMs: 60, quietTimeoutMs: 500 });
    await watched(h);
    h.browser.tabEvent(ATLAS, ATLAS_TAB, "Page.downloadWillBegin", { guid: "g1", url: "x" });
    h.browser.tabEvent(ATLAS, ATLAS_TAB, "Page.downloadProgress", {
      guid: "g1",
      state: "inProgress",
    });
    const refused = await h.call("control.take", tab);
    expect(refused.payload).toMatchObject({
      state: "busy",
      reason: "a download in the bot's browser is still in progress",
    });
    expect(h.events.find((e) => e.state === "busy")?.reason).toBe("download-in-progress");
    h.browser.tabEvent(ATLAS, ATLAS_TAB, "Page.downloadProgress", {
      guid: "g1",
      state: "completed",
    });
    expect((await h.call("control.take", tab)).payload?.state).toBe("granted");
    await h.stop();
  });

  it("waits for a download that ends before the deadline, and grants only after it", async () => {
    const h = load({ quietWindowMs: 60, quietTimeoutMs: 2000 });
    await watched(h);
    h.browser.tabEvent(ATLAS, ATLAS_TAB, "Page.downloadWillBegin", { guid: "g2", url: "x" });
    let finishedAt = 0;
    setTimeout(() => {
      finishedAt = performance.now();
      h.browser.tabEvent(ATLAS, ATLAS_TAB, "Page.downloadProgress", {
        guid: "g2",
        state: "canceled",
      });
    }, 300);
    const answer = await h.call("control.take", tab);
    expect(answer.payload?.state).toBe("granted");
    expect(finishedAt).toBeGreaterThan(0);
    await h.stop();
  });

  it("a download that begins in the quiet window starts it over", async () => {
    const h = load({ quietWindowMs: 150, quietTimeoutMs: 600 });
    await watched(h);
    const take = h.call("control.take", tab);
    await until(() => h.browser.sentToTabs("Page.stopLoading").length === 2);
    h.browser.tabEvent(ATLAS, ATLAS_TAB, "Page.downloadWillBegin", { guid: "g3", url: "x" });
    expect((await take).payload?.state).toBe("busy");
    expect(h.events.some((e) => e.state === "granted")).toBe(false);
    await h.stop();
  });

  it("refuses while another tab of that browser is still loading, and grants once it has stopped", async () => {
    const h = load({ quietWindowMs: 60, quietTimeoutMs: 500 });
    h.browser.lists.set(ATLAS, [page(ATLAS, ATLAS_TAB), page(ATLAS, SECOND)]);
    await watched(h);
    h.browser.tabEvent(ATLAS, SECOND, "Page.frameStartedLoading", { frameId: "f2" });
    const refused = await h.call("control.take", tab);
    expect(refused.payload).toMatchObject({
      state: "busy",
      reason: "the bot's browser is still loading a page",
    });
    h.browser.tabEvent(ATLAS, SECOND, "Page.frameStoppedLoading", { frameId: "f2" });
    expect((await h.call("control.take", tab)).payload?.state).toBe("granted");
    await h.stop();
  });

  it("a tab that does not answer the watch in time is not loading for ever: the take says it cannot see it, and is granted once the tab answers when asked again", async () => {
    // As Chromium's own empty tab did under load: Page.enable not answered in time.
    const h = load({
      timeouts: { discoveryMs: 300, connectMs: 300, commandMs: 200 },
      quietWindowMs: 60,
      quietTimeoutMs: 500,
    });
    h.browser.lists.set(ATLAS, [page(ATLAS, ATLAS_TAB), page(ATLAS, SECOND)]);
    h.browser.stalledTabs.add(SECOND);
    await watched(h);
    await sleep(300);
    const refused = await h.call("control.take", tab);
    expect(refused.payload).toMatchObject({ state: "busy", cause: "browser-not-watched" });
    expect(h.events.find((e) => e.state === "busy")?.reason).toBe("browser-not-watched");
    // The tab answers now: the next take asks it again and is granted.
    h.browser.stalledTabs.delete(SECOND);
    expect((await h.call("control.take", tab)).payload?.state).toBe("granted");
    await h.stop();
  });

  it("a busy answer carries the event's code as `cause` beside its sentence", async () => {
    const h = load({ quietWindowMs: 60, quietTimeoutMs: 500 });
    h.browser.lists.set(ATLAS, [page(ATLAS, ATLAS_TAB), page(ATLAS, SECOND)]);
    await watched(h);
    h.browser.tabEvent(ATLAS, SECOND, "Page.frameStartedLoading", { frameId: "f2" });
    const refused = await h.call("control.take", tab);
    expect(refused.payload).toMatchObject({
      state: "busy",
      reason: "the bot's browser is still loading a page",
      cause: "browser-not-quiet",
    });
    expect(h.events.find((e) => e.state === "busy")?.reason).toBe(refused.payload?.cause);
    await h.stop();
  });

  it("a stop that isn't answered while another tab is loading says the browser is loading, not that it isn't watched", async () => {
    const h = load({
      quietWindowMs: 60,
      quietTimeoutMs: 1500,
      timeouts: { discoveryMs: 300, connectMs: 300, commandMs: 200 },
    });
    h.browser.lists.set(ATLAS, [page(ATLAS, ATLAS_TAB), page(ATLAS, SECOND)]);
    await watched(h);
    h.browser.tabEvent(ATLAS, SECOND, "Page.frameStartedLoading", { frameId: "f2" });
    h.browser.stalledMethods.add("Page.stopLoading");
    const refused = await h.call("control.take", tab);
    expect(refused.payload).toMatchObject({ state: "busy", cause: "browser-not-quiet" });
    await h.stop();
  });

  it("refuses when the plugin cannot watch the bot's browser", async () => {
    const h = load();
    h.browser.noBrowserEndpoint = true;
    const answer = await h.call("control.take", tab);
    expect(answer.payload).toMatchObject({
      state: "busy",
      reason: "the plugin cannot see what the bot's browser is doing",
    });
    expect(h.events.find((e) => e.state === "busy")?.reason).toBe("browser-not-watched");
    await h.stop();
  });

  it("watches again after the watch lost the browser", async () => {
    const h = load();
    await watched(h);
    h.browser.watchSocket(ATLAS)!.close();
    await until(() => !h.browser.watchSocket(ATLAS));
    expect((await h.call("control.take", tab)).payload?.state).toBe("granted");
    expect(h.browser.watchSocket(ATLAS)).toBeDefined();
    await h.stop();
  });

  it("the watch changes nothing in the browser: it attaches without pausing tabs and turns on page events", async () => {
    const h = load();
    await watched(h);
    const toBrowser = h.browser.log
      .filter((e) => e.kind === "send" && e.url.includes("/devtools/browser/"))
      .map((e) => [e.method, e.params]);
    expect(toBrowser).toEqual([
      ["Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }],
      ["Page.enable", {}],
    ]);
    await h.stop();
  });

  it("a bot call waits for the watch, and is refused if a take began meanwhile", async () => {
    const h = load();
    h.browser.connectDelayMs = 120;
    const call = h.before("atlas", "run-x", "c-x", { action: "tabs" });
    await until(() => h.browser.sockets.length > 0);
    const take = h.call("control.take", tab);
    const result = await call;
    expect(result?.block).toBe(true);
    expect(h.state.inflight.size).toBe(0);
    expect((await take).payload?.state).toBe("granted");
    await h.stop();
  });

  it("a granted take says exactly what it guarantees, and that the bot's earlier work can still act", async () => {
    const h = load();
    const answer = await h.call("control.take", tab);
    expect(answer.payload?.guarantee).toEqual([
      "Input from the person reaches the page.",
      "New browser calls from this bot are refused while control is held.",
      "Work the bot had already started can still affect the page.",
    ]);
    await h.stop();
  });
});

it("the plugin's page states the same guarantee, and that earlier work can still act", () => {
  const page = readFileSync(join(import.meta.dirname, "../README.md"), "utf8").replace(/\s+/g, " ");
  expect(page).toContain(
    `exactly these three statements: ${GRANT_GUARANTEE.map((line) => `"${line}"`).join(" ")}`,
  );
  expect(page).toContain(
    "**Work the bot had already started can still affect the page after a grant.**",
  );
});

describe("the grant is the last thing that happens", () => {
  const SECOND = "E".repeat(32);
  /** A take held at its proof command, with the proof's id, so a test can act first. */
  async function atProof(h: ReturnType<typeof load>) {
    h.browser.lists.set(ATLAS, [page(ATLAS, ATLAS_TAB), page(ATLAS, SECOND)]);
    await h.before("atlas", "run-p", "c-p", { action: "tabs" });
    await h.after("atlas", "run-p", "c-p");
    h.browser.stalledMethods.add("Page.getFrameTree");
    const take = h.call("control.take", tab);
    await until(() => h.browser.sentToTabs("Page.getFrameTree").length === 1);
    const lease = h.browser.tabSockets.at(-1)!;
    const proofId = h.browser.log.filter((e) => e.kind === "send" && e.url === lease.url).length;
    const answerProof = () => {
      h.browser.stalledMethods.delete("Page.getFrameTree");
      lease.emit("message", { data: JSON.stringify({ id: proofId, result: {} }) });
    };
    return { take, lease, answerProof };
  }
  const opts = {
    quietWindowMs: 80,
    quietTimeoutMs: 700,
    timeouts: { discoveryMs: 500, connectMs: 500, commandMs: 2000 },
  };

  for (const [what, reason, act] of [
    [
      "a download beginning",
      "download-in-progress",
      (h: ReturnType<typeof load>) =>
        h.browser.tabEvent(ATLAS, SECOND, "Page.downloadWillBegin", { guid: "d", url: "x" }),
    ],
    [
      "another tab starting to load",
      "browser-not-quiet",
      (h: ReturnType<typeof load>) =>
        h.browser.tabEvent(ATLAS, SECOND, "Page.frameStartedLoading", { frameId: "f2" }),
    ],
    [
      "the watch losing the browser",
      "browser-not-watched",
      (h: ReturnType<typeof load>) => h.browser.watchSocket(ATLAS)!.close(),
    ],
  ] as const) {
    it(`is refused when ${what} is seen while the proof is out`, async () => {
      const h = load(opts);
      const { take, answerProof } = await atProof(h);
      act(h);
      await sleep(20);
      answerProof();
      const answer = await take;
      expect(answer.payload?.state).toBe("busy");
      expect(h.events.find((e) => e.state === "busy")?.reason).toBe(reason);
      expect(h.events.some((e) => e.state === "granted")).toBe(false);
      await h.stop();
    });
  }

  it("starts the window over, stopping again, when the tab navigates while the proof is out", async () => {
    const h = load(opts);
    const { take, lease, answerProof } = await atProof(h);
    const stops = h.browser.sentToTabs("Page.stopLoading").length;
    lease.event("Page.frameStartedNavigating", { frameId: "f" });
    answerProof();
    const answer = await take;
    // The navigation was stopped again and the window passed in full before the grant.
    expect(h.browser.sentToTabs("Page.stopLoading").length).toBeGreaterThan(stops);
    expect(h.browser.sentToTabs("Page.getFrameTree").length).toBe(2);
    expect(answer.payload?.state).toBe("granted");
    await h.stop();
  });

  it("is refused when the tab starts loading in the watch while the proof is out and does not stop", async () => {
    const h = load(opts);
    const { take, lease, answerProof } = await atProof(h);
    lease.event("Page.frameStartedNavigating", { frameId: "f" });
    h.browser.tabEvent(ATLAS, ATLAS_TAB, "Page.frameStartedLoading", { frameId: "f" });
    answerProof();
    expect((await take).payload?.state).toBe("busy");
    expect(h.events.some((e) => e.state === "granted")).toBe(false);
    await h.stop();
  });

  it("is refused at once when the watch is lost in the quiet window", async () => {
    const h = load({ quietWindowMs: 300, quietTimeoutMs: 5000 });
    await h.before("atlas", "run-q", "c-q", { action: "tabs" });
    await h.after("atlas", "run-q", "c-q");
    const take = h.call("control.take", tab);
    await until(() => h.browser.sentToTabs("Page.stopLoading").length === 2);
    const started = performance.now();
    h.browser.watchSocket(ATLAS)!.close();
    const answer = await take;
    expect(performance.now() - started).toBeLessThan(1500);
    expect(answer.payload?.state).toBe("busy");
    expect(h.events.find((e) => e.state === "busy")?.reason).toBe("browser-not-watched");
    await h.stop();
  });
});

describe("a download belongs to the browser, not to the tab that started it", () => {
  const SOURCE = "F".repeat(32);
  const withSource = async (h: ReturnType<typeof load>) => {
    h.browser.lists.set(ATLAS, [page(ATLAS, ATLAS_TAB), page(ATLAS, SOURCE)]);
    await h.before("atlas", "run-d", "c-d", { action: "tabs" });
    await h.after("atlas", "run-d", "c-d");
    h.browser.tabEvent(ATLAS, SOURCE, "Page.downloadWillBegin", { guid: "g", url: "x" });
    h.browser.tabEvent(ATLAS, SOURCE, "Page.downloadProgress", { guid: "g", state: "inProgress" });
  };
  const opts = { quietWindowMs: 50, quietTimeoutMs: 400 };
  const reason = (h: ReturnType<typeof load>) =>
    h.events.filter((e) => e.state === "busy").at(-1)?.reason;

  it("a take on another tab is refused after the source tab closes, while the download was not seen to end", async () => {
    const h = load(opts);
    await withSource(h);
    h.browser.tabDetached(ATLAS, SOURCE);
    const answer = await h.call("control.take", tab);
    expect(answer.payload?.state).toBe("busy");
    expect(reason(h)).toBe("download-in-progress");
    await h.stop();
  });

  it("is granted once the browser reports the download finished or cancelled, before its tab closed", async () => {
    for (const end of ["completed", "canceled"]) {
      const h = load(opts);
      await withSource(h);
      h.browser.tabEvent(ATLAS, SOURCE, "Page.downloadProgress", { guid: "g", state: end });
      h.browser.tabDetached(ATLAS, SOURCE);
      expect((await h.call("control.take", tab)).payload?.state, end).toBe("granted");
      await h.stop();
    }
  });

  it("is still waited for by the next watch of the same browser, and forgotten with a browser that was replaced", async () => {
    const h = load(opts);
    await withSource(h);
    h.browser.tabDetached(ATLAS, SOURCE);
    h.browser.watchSocket(ATLAS)!.close();
    await until(() => h.state.watches.size === 0);
    expect((await h.call("control.take", tab)).payload?.state).toBe("busy");
    expect(reason(h)).toBe("download-in-progress");
    // The browser restarted: its downloads ended with it.
    h.browser.watchSocket(ATLAS)!.close();
    await until(() => h.state.watches.size === 0);
    h.browser.browserId = "fake-browser-0002";
    expect((await h.call("control.take", tab)).payload?.state).toBe("granted");
    await h.stop();
  });
});

it("the plugin's page says exactly which downloads a take waits for", () => {
  const text = readFileSync(join(import.meta.dirname, "../README.md"), "utf8").replace(/\s+/g, " ");
  expect(text).toContain(
    "**the downloads a take waits for**: every download the plugin has seen begin in the bot's browser, from when it began until the browser reports it finished or cancelled, also after the tab that started it has closed.",
  );
  expect(text).not.toContain("a download in progress anywhere in the bot's browser");
});
