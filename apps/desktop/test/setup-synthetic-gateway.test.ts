// The pairing scenario's synthetic gateway (apps/desktop/src/setup/synthetic-gateway.ts)
// with the real client and the Node host, over a WebSocket on this
// computer's loopback: a code its mint made pairs for exactly read and the
// app opens on its bots; any other code, a used one or an expired one, is refused.

import { ClawtrateClient } from "@clawtrate/core";
import { createNodeHost } from "@clawtrate/core/node";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { until } from "../../../packages/core/test/fake-gateway.ts";
import { startSyntheticGateway, type SyntheticGateway } from "../src/setup/synthetic-gateway.ts";

let dir: string;
let gateway: SyntheticGateway;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "clawtrate-synthetic-"));
  gateway = await startSyntheticGateway();
});
afterEach(async () => {
  await gateway.close();
  rmSync(dir, { recursive: true, force: true });
});

function client(name: string) {
  return new ClawtrateClient(
    createNodeHost({
      dataDir: join(dir, name),
      client: { displayName: "Clawtrate Test", version: "0.0.0", platform: "test" },
    }),
    { reconnect: { initialMs: 20, maxMs: 40 } },
  );
}

describe("the synthetic gateway", () => {
  it("listens on loopback only, and pairs a code its mint made for exactly read, opening on its bots", async () => {
    expect(gateway.url).toBe(`ws://127.0.0.1:${gateway.port}`);
    const app = client("paired");
    await app.start();
    await app.connectWithSetupCode(gateway.mint(Date.now()));
    await until(() => app.state.discovery.status === "ready", 10_000);
    expect(app.state.connection.status).toBe("connected");
    expect(app.state.bots.map((bot) => bot.name)).toEqual(["Juniper"]);
    app.stop();
  });

  it("refuses a code it didn't make, a code used once already, and an expired one", async () => {
    const code = gateway.mint(Date.now());
    const first = client("first");
    await first.start();
    await first.connectWithSetupCode(code);
    await until(() => first.state.connection.status === "connected", 10_000);
    first.stop();
    for (const [name, attempt] of [
      ["reused", code],
      ["foreign", { ...code, bootstrapToken: "x".repeat(43) }],
      ["expired", gateway.mint(Date.now() - 11 * 60_000)],
    ] as const) {
      const app = client(name);
      await app.start();
      await app.connectWithSetupCode({ ...attempt, expiresAtMs: Date.now() + 60_000 });
      await until(() => app.state.connection.status === "error", 10_000);
      expect(app.state.bots, name).toEqual([]);
      app.stop();
    }
  });

  it("a peer that sends a frame that isn't an object, or breaks the protocol, loses its own socket and the host stays up", async () => {
    const closed: number[] = [];
    for (const send of [
      (socket: WebSocket) => socket.send("null"),
      (socket: WebSocket) => socket.send("[1]"),
      // A text frame that isn't UTF-8: `ws` reports it as an error on that connection.
      (socket: WebSocket) => socket.send(Buffer.from([0xff, 0xfe, 0xfd]), { binary: false }),
    ]) {
      const socket = new WebSocket(gateway.url);
      socket.on("error", () => {});
      await new Promise((resolve) => socket.once("open", resolve));
      send(socket);
      closed.push(await new Promise<number>((resolve) => socket.once("close", resolve)));
    }
    expect(closed.every((code) => code === 1008 || code === 1007 || code === 1006)).toBe(true);
    // Still listening, and still pairs.
    expect(gateway.ownsListener(gateway.port)).toBe(true);
    const app = client("after");
    await app.start();
    await app.connectWithSetupCode(gateway.mint(Date.now()));
    await until(() => app.state.connection.status === "connected", 10_000);
    app.stop();
  });
});
