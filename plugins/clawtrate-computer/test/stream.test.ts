// The live view: one-use, short-lived tickets; frames in the built-in
// screencast's layout; and a stream that ends when it is not renewed, when
// the session's access is revoked, when the tab closes or when the viewer
// sends anything but a close.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ATLAS, ATLAS_TAB, Access, load, nextTurn, sleep, until } from "./harness.ts";

const tab = { targetId: ATLAS_TAB };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64");

async function watching(h: ReturnType<typeof load>, caller = {}) {
  const started = h.browser.sent("Page.startScreencast").length;
  const view = await h.call("view.open", tab, caller);
  expect(view.ok).toBe(true);
  const socket = await h.upgrade(String(view.payload!.wsPath));
  await until(() => h.browser.sent("Page.startScreencast").length === started + 1);
  const cdp = h.browser.tabSockets.at(-1)!;
  return { view: view.payload!, socket, cdp };
}

const frame = (cdp: { event(method: string, params: object): void }, sessionId = 1) =>
  cdp.event("Page.screencastFrame", {
    data: JPEG,
    sessionId,
    metadata: {
      deviceWidth: 800,
      deviceHeight: 600,
      scrollOffsetX: 0,
      scrollOffsetY: 40,
      timestamp: 12.5,
    },
  });

describe("view tickets", () => {
  it("a ticket opens one stream once; a used, unknown or expired ticket is refused", async () => {
    const h = load({ ticketTtlMs: 100 });
    const view = await h.call("view.open", tab);
    expect(view.payload).toMatchObject({ targetId: ATLAS_TAB, renewWithinMs: 20000 });
    expect(String(view.payload!.wsPath)).toMatch(
      /^\/clawtrate-computer\/stream\?ticket=[0-9a-f]{48}$/,
    );
    const first = await h.upgrade(String(view.payload!.wsPath));
    expect(first.status).toBe("HTTP/1.1 101 Switching Protocols");
    expect((await h.upgrade(String(view.payload!.wsPath))).status).toBe(
      "HTTP/1.1 401 Unauthorized",
    );
    expect((await h.upgrade("/clawtrate-computer/stream?ticket=" + "0".repeat(48))).status).toBe(
      "HTTP/1.1 401 Unauthorized",
    );
    const late = await h.call("view.open", tab);
    await sleep(150);
    expect(h.state.streams.has(String(late.payload!.streamId))).toBe(false);
    expect((await h.upgrade(String(late.payload!.wsPath))).status).toBe(
      "HTTP/1.1 401 Unauthorized",
    );
  });

  it("a ticket whose session's access was revoked opens nothing", async () => {
    const h = load();
    const access = new Access();
    const view = await h.call("view.open", tab, { access });
    access.revoke();
    expect((await h.upgrade(String(view.payload!.wsPath))).status).toBe(
      "HTTP/1.1 401 Unauthorized",
    );
    expect(h.browser.sockets).toEqual([]);
  });

  it("a ticket is a bearer capability: it opens the stream for whoever presents it, which still ends with the view's connection", async () => {
    const h = load();
    const connection = new AbortController();
    const view = await h.call("view.open", tab, { connection });
    // The upgrade carries nothing of the presenting connection: only the ticket.
    const socket = await h.upgrade(String(view.payload!.wsPath));
    expect(socket.status).toBe("HTTP/1.1 101 Switching Protocols");
    connection.abort();
    expect(socket.closeCode()).toEqual({ code: 4006, reason: "authority_revoked" });
  });

  it("an unrenewed view takes its unused ticket with it before the ticket's own deadline; a renewal gives the ticket no more time", async () => {
    const early = load({ renewTimeoutMs: 120, ticketTtlMs: 5000 });
    const view = await early.call("view.open", tab);
    expect(Number(view.payload!.expiresAtMs) - Date.now()).toBeGreaterThan(4000);
    await sleep(200);
    expect((await early.upgrade(String(view.payload!.wsPath))).status).toBe(
      "HTTP/1.1 401 Unauthorized",
    );
    const renewed = load({ renewTimeoutMs: 5000, ticketTtlMs: 150 });
    const kept = await renewed.call("view.open", tab);
    await sleep(80);
    expect(
      (await renewed.call("view.renew", { ...tab, streamId: kept.payload!.streamId })).payload,
    ).toMatchObject({ streamRenewed: true });
    await sleep(120);
    expect((await renewed.upgrade(String(kept.payload!.wsPath))).status).toBe(
      "HTTP/1.1 401 Unauthorized",
    );
    expect(readFileSync(join(import.meta.dirname, "../README.md"), "utf8")).toContain(
      "**The ticket is a bearer capability.**",
    );
  });

  it("bounds the views one connection can open", async () => {
    const h = load();
    for (let i = 0; i < 8; i += 1) expect((await h.call("view.open", tab)).ok).toBe(true);
    expect((await h.call("view.open", tab)).error?.details?.reason).toBe("too_many_views");
    expect((await h.call("view.open", tab, { connId: "conn-B" })).ok).toBe(true);
  });
});

describe("frames", () => {
  it("sends ready, then each frame with the built-in header and the JPEG, and acknowledges it", async () => {
    const h = load();
    const { socket, cdp } = await watching(h);
    frame(cdp, 7);
    await until(() => socket.frames().some((f) => f.opcode === 0x2));
    const [ready] = socket.frames().filter((f) => f.opcode === 0x1);
    expect(JSON.parse(ready!.payload.toString())).toEqual({
      type: "ready",
      targetId: ATLAS_TAB,
      url: "http://127.0.0.1:9/page",
      title: "Page",
    });
    const binary = socket.frames().find((f) => f.opcode === 0x2)!.payload;
    const length = binary.readUInt32BE(0);
    expect(JSON.parse(binary.subarray(4, 4 + length).toString())).toEqual({
      url: "http://127.0.0.1:9/page",
      cssWidth: 800,
      cssHeight: 600,
      scrollX: 0,
      scrollY: 40,
      ts: 12.5,
    });
    expect(binary.subarray(4 + length)).toEqual(Buffer.from(JPEG, "base64"));
    await until(() => h.browser.sent("Page.screencastFrameAck").length === 1);
    expect(h.browser.sent("Page.screencastFrameAck")[0]!.params).toEqual({ sessionId: 7 });
    expect(h.warnings).toEqual([]);
  });

  it("reports a navigation of the top frame as meta", async () => {
    const h = load();
    const { socket, cdp } = await watching(h);
    cdp.event("Page.frameNavigated", { frame: { id: "f", url: "http://127.0.0.1:9/next" } });
    cdp.event("Page.frameNavigated", {
      frame: { id: "g", parentId: "f", url: "http://127.0.0.1:9/inner" },
    });
    await until(() => socket.frames().filter((f) => f.opcode === 0x1).length === 2);
    expect(
      JSON.parse(
        socket
          .frames()
          .filter((f) => f.opcode === 0x1)[1]!
          .payload.toString(),
      ),
    ).toEqual({
      type: "meta",
      url: "http://127.0.0.1:9/next",
    });
  });

  it("drops frames, rather than queueing them, while the viewer is behind", async () => {
    const h = load();
    const { socket, cdp } = await watching(h);
    socket.writableLength = 8 * 1024 * 1024;
    frame(cdp);
    await until(() => h.browser.sent("Page.screencastFrameAck").length === 1);
    expect(socket.frames().filter((f) => f.opcode === 0x2)).toEqual([]);
  });
});

describe("how a stream ends", () => {
  it("delayed revocation: a frame is withheld once access has gone stale, before any abort arrives", async () => {
    const h = load();
    const access = new Access();
    const { socket, cdp } = await watching(h, { access });
    frame(cdp);
    await until(() => socket.frames().some((f) => f.opcode === 0x2));
    // Stale, but its abort has not been delivered (and never is, here).
    access.revoked = true;
    expect(access.controller.signal.aborted).toBe(false);
    frame(cdp);
    expect(socket.frames().filter((f) => f.opcode === 0x2).length).toBe(1);
    expect(socket.closeCode()).toEqual({ code: 4006, reason: "authority_revoked" });
    expect(cdp.closed).toBe(true);
  });

  it("revocation that is signalled closes it with 4006 at once, and no frame follows", async () => {
    const h = load();
    const access = new Access();
    const { socket, cdp } = await watching(h, { access });
    frame(cdp);
    await until(() => socket.frames().some((f) => f.opcode === 0x2));
    access.revoke();
    expect(socket.closeCode()).toEqual({ code: 4006, reason: "authority_revoked" });
    frame(cdp);
    expect(socket.frames().filter((f) => f.opcode === 0x2).length).toBe(1);
    expect(cdp.closed).toBe(true);
  });

  it("an unrenewed stream closes with 4006; a renewed one stays", async () => {
    // The plugin's deadlines on a clock that moves only when the check moves it, so a slow
    // machine cannot let the kept stream's deadline pass between two renewals.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // `work` and then `ready`, with the clock standing still: only the fake browser answers.
      const settle = async <T>(work: Promise<T>, ready = () => true): Promise<T> => {
        let finished = false;
        const settled = work.finally(() => (finished = true));
        for (let i = 0; !(finished && ready()); i += 1) {
          if (i > 1000) throw new Error("did not settle with the clock standing still");
          await nextTurn();
          await vi.advanceTimersByTimeAsync(0);
        }
        return settled;
      };
      const h = load({ renewTimeoutMs: 150 });
      const open = async () => {
        const started = h.browser.sent("Page.startScreencast").length;
        const view = await settle(h.call("view.open", tab));
        const socket = await settle(
          h.upgrade(String(view.payload!.wsPath)),
          () => h.browser.sent("Page.startScreencast").length === started + 1,
        );
        return { streamId: view.payload!.streamId, socket };
      };
      const kept = await open();
      const dropped = await open();
      for (let i = 0; i < 4; i += 1) {
        await vi.advanceTimersByTimeAsync(80);
        const renewal = await settle(h.call("view.renew", { ...tab, streamId: kept.streamId }));
        expect(renewal.payload).toMatchObject({ streamRenewed: true, leaseRenewed: false });
      }
      // 320 ms on: the stream nobody renewed ended at 150; the kept one was renewed every 80.
      expect(dropped.socket.closeCode()).toEqual({ code: 4006, reason: "authority_revoked" });
      expect(kept.socket.closeCode()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("only its own connection renews a stream", async () => {
    const h = load();
    const { view } = await watching(h);
    expect(
      (await h.call("view.renew", { ...tab, streamId: view.streamId }, { connId: "conn-B" }))
        .payload,
    ).toMatchObject({
      streamRenewed: false,
    });
  });

  it("the tab closing closes it with 4004", async () => {
    const h = load();
    const { socket, cdp } = await watching(h);
    h.browser.lists.set(ATLAS, []);
    cdp.close();
    await until(() => socket.closeCode() !== null);
    expect(socket.closeCode()).toEqual({ code: 4004, reason: "target_closed" });
    const detached = await watching(load());
    detached.cdp.event("Inspector.detached", { reason: "target_closed" });
    expect(detached.socket.closeCode()).toEqual({ code: 4004, reason: "target_closed" });
  });

  it("a connection that closes while the tab is still listed, or with the browser gone, closes it with 1011, not as the tab closing", async () => {
    for (const how of ["still listed", "browser gone", "detached otherwise"]) {
      const h = load();
      const { socket, cdp } = await watching(h);
      if (how === "browser gone") h.browser.lists.delete(ATLAS);
      if (how === "detached otherwise") {
        cdp.event("Inspector.detached", { reason: "Render process gone." });
      } else cdp.close();
      await until(() => socket.closeCode() !== null);
      expect(socket.closeCode(), how).toEqual({ code: 1011, reason: "browser_unavailable" });
      await h.stop();
    }
  });

  it("a viewer that sends data is closed; a ping is answered; a close is honoured", async () => {
    const h = load();
    const masked = (opcode: number, payload: Buffer) => {
      const mask = Buffer.from([1, 2, 3, 4]);
      const body = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!));
      return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | body.length]), mask, body]);
    };
    const pinged = await watching(h);
    pinged.socket.emit("data", masked(0x9, Buffer.from("hi")));
    expect(
      pinged.socket.frames().some((f) => f.opcode === 0xa && f.payload.toString() === "hi"),
    ).toBe(true);
    pinged.socket.emit("data", masked(0x8, Buffer.from([0x03, 0xe8])));
    expect(pinged.socket.closeCode()).toEqual({ code: 1000, reason: "closed" });
    const talker = await watching(h);
    talker.socket.emit("data", masked(0x1, Buffer.from("click")));
    expect(talker.socket.closeCode()).toEqual({ code: 1003, reason: "view_only" });
    expect(h.browser.sent("Input.")).toEqual([]);
  });

  it("a stalled screencast start closes the stream in time", async () => {
    const h = load({ timeouts: { discoveryMs: 200, connectMs: 200, commandMs: 200 } });
    h.browser.stalledMethods.add("Page.enable");
    const view = await h.call("view.open", tab);
    const socket = await h.upgrade(String(view.payload!.wsPath));
    expect(socket.closeCode()).toEqual({ code: 1011, reason: "browser_unavailable" });
  });
});
