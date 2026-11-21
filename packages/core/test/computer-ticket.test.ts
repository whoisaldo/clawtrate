// A view's ticket is a bearer capability: whoever presents it gets the
// stream. It goes from the plugin's answer to the stream's address on this
// host and nowhere else. This drives a real client and a viewer's bridge
// session through a view, a take, input, a release and a dropped connection,
// and searches everything a viewer or a log could receive for the ticket.

import { describe, expect, it } from "vitest";
import { utf8Bytes } from "../src/bytes.ts";
import { batchSnapshots, createBridgeSession } from "../src/bridge.ts";
import type { WebSocketLike } from "../src/host.ts";
import { grantingGateway, openTask } from "./client-harness.ts";
import { helloOk, until } from "./fake-gateway.ts";

// An invented ticket of the plugin's shape (48 hex), built here so no literal looks like a secret.
const TICKET = "9c1d7e3a".repeat(6);
const TYPED = "library-card-0042";
const GEN = "c".repeat(32);
const KEY = "agent:pip:trip";
const TAB = "TAB0000000000000000000000000000A";

class Stream implements WebSocketLike {
  readyState = 1;
  binaryType?: string;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
}

function frame(): ArrayBuffer {
  const header = utf8Bytes(
    JSON.stringify({
      url: "http://127.0.0.1:1/sign-in",
      cssWidth: 800,
      cssHeight: 600,
      scrollX: 0,
      scrollY: 0,
      ts: 1,
    }),
  );
  const out = new Uint8Array(4 + header.length + 8);
  new DataView(out.buffer).setUint32(0, header.length);
  out.set(header, 4);
  out.set([0xff, 0xd8, 1, 2, 3, 4, 0xff, 0xd9], 4 + header.length);
  return out.buffer;
}

describe("the view's ticket (section 17; docs/decisions.md, The computer)", () => {
  it("F-142: reaches only the stream's address on this host: never a state, a snapshot, an answer to a viewer, an error or the log", async () => {
    const gateway = grantingGateway();
    gateway.connectReply = (params) => {
      const { scopes } = params as { scopes: string[] };
      return {
        ok: true,
        payload: {
          ...helloOk(scopes, "device-token"),
          features: { methods: ["clawtrate-computer.tabs"], events: [] },
        },
      };
    };
    gateway.handlers["clawtrate-computer.tabs"] = () => ({
      agentId: "pip",
      profile: "bot-pip",
      browser: "running",
      tabs: [{ targetId: TAB, url: "http://127.0.0.1:1/sign-in", title: "Sign in", lease: null }],
    });
    gateway.handlers["clawtrate-computer.view.open"] = () => ({
      streamId: "stream-1",
      wsPath: `/clawtrate-computer/stream?ticket=${TICKET}`,
      expiresAtMs: Date.now() + 60_000,
      renewWithinMs: 20_000,
      targetId: TAB,
    });
    gateway.handlers["clawtrate-computer.control.take"] = () => ({
      state: "granted",
      generation: GEN,
      renewWithinMs: 20_000,
      targetId: TAB,
      guarantee: [],
    });
    gateway.handlers["clawtrate-computer.input"] = () => ({ ok: true });
    gateway.handlers["clawtrate-computer.control.release"] = () => ({
      state: "released",
      generation: GEN,
      targetId: TAB,
    });

    // The host's socket factory: the gateway's own connection, and the streams the engine opens.
    const streams: Array<{ url: string; socket: Stream }> = [];
    const logs: string[] = [];
    const { client } = await openTask({
      gateway,
      key: KEY,
      client: {},
    });
    // The client was made by the harness; give its host a stream factory and a log.
    const host = (
      client as unknown as {
        host: { createWebSocket: (url: string) => WebSocketLike; log?: unknown };
      }
    ).host;
    const original = host.createWebSocket;
    host.createWebSocket = (url: string) => {
      if (url.includes("/clawtrate-computer/stream")) {
        const socket = new Stream();
        streams.push({ url, socket });
        return socket;
      }
      return original(url);
    };
    host.log = (_level: string, message: string) => logs.push(message);

    const snapshots: string[] = [];
    // What a host sends its viewers (one snapshot per tick), and every state written.
    const stop = batchSnapshots(
      client.store.subscribe,
      (state) => snapshots.push(JSON.stringify(state)),
      0,
    );
    const states: string[] = [];
    const unsubscribe = client.store.subscribe((state) => states.push(JSON.stringify(state)));
    const viewer = createBridgeSession(client);
    const answers: string[] = [];
    const ask = async (command: Parameters<typeof viewer.apply>[0]) => {
      try {
        answers.push(JSON.stringify((await viewer.apply(command)) ?? null));
      } catch (error) {
        answers.push(String(error));
      }
    };

    await ask({ type: "openSession", key: KEY });
    await ask({ type: "computerShow", key: KEY });
    const id = viewer.computerViewer()!;
    await until(() => client.state.computer?.panes[id]?.availability === "ready");
    await ask({ type: "computerWatch" });
    await until(() => streams.length === 1);
    // The ticket was used: on the stream's address, on the gateway's own origin.
    expect(streams[0]!.url).toBe(`ws://127.0.0.1:19001/clawtrate-computer/stream?ticket=${TICKET}`);
    streams[0]!.socket.onmessage?.({
      data: JSON.stringify({ type: "ready", url: "http://127.0.0.1:1/sign-in", title: "Sign in" }),
    });
    streams[0]!.socket.onmessage?.({ data: frame() });
    await ask({ type: "computerFrame", n: client.state.computer!.panes[id]!.view!.n, after: 0 });
    await ask({ type: "computerTake" });
    await until(() => client.state.computer?.panes[id]?.control.status === "granted");
    await ask({ type: "computerInput", input: { kind: "text", text: TYPED } });
    await until(() => gateway.calls("clawtrate-computer.input").length === 1);
    await ask({ type: "computerRelease", answer: null });
    await until(() => client.state.computer?.panes[id]?.control.status === "none");
    // A dropped connection, and a view that cannot open, on the error paths.
    await ask({ type: "computerWatch" });
    gateway.dropAll();
    await until(() => client.state.connection.status !== "connected");
    await ask({ type: "computerWatch" });
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 50));
    viewer.dispose();
    stop();
    unsubscribe();

    // How many snapshots a host coalesces the writes into depends on timing; every write is searched.
    expect(snapshots.length).toBeGreaterThan(0);
    expect(states.length).toBeGreaterThan(10);
    const everything = [
      ...snapshots,
      ...states,
      JSON.stringify(client.state),
      ...answers,
      ...logs,
    ].join("\n");
    expect(everything).not.toContain(TICKET);
    expect(everything).not.toContain("ticket=");
    // Nothing typed into the page is kept or logged; the input went to the gateway once.
    expect(everything).not.toContain(TYPED);
    expect(gateway.calls("clawtrate-computer.input")).toEqual([
      { sessionKey: KEY, targetId: TAB, generation: GEN, kind: "text", text: TYPED },
    ]);
    // The lease's generation never reaches a viewer's pane either.
    expect(JSON.stringify(snapshots.map((each) => JSON.parse(each).computer?.panes))).not.toContain(
      GEN,
    );
    client.stop();
  });
});
