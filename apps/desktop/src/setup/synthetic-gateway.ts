// The gateway of a sandbox's `pairing` scenario (docs/development/setup.md):
// a synthetic one the host itself runs on this computer's loopback, on a port
// the system chooses, so that a development or test run can follow Connect to
// the end without any OpenClaw. It speaks the frames the pinned client
// expects, accepts only the one-time code the stand-in's fixture mint made
// for it, grants exactly `operator.read`, and answers the two reads the app
// needs to open on its bots. Nothing in it is a real gateway's behavior: it
// proves the app's side of pairing, not OpenClaw's.

import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { GATEWAY_PROTOCOL, TESTED_OPENCLAW_VERSION } from "@clawtrate/core";

/** How long a code the fixture mint makes stays good, as OpenClaw's own do. */
export const SYNTHETIC_CODE_MS = 10 * 60_000;

export type SyntheticGateway = {
  url: string;
  port: number;
  /** A one-time code for this gateway: the stand-in's `qr` answer, kept in this process only. */
  mint(now: number): { url: string; bootstrapToken: string; expiresAtMs: number };
  /** Whether this server still listens, on 127.0.0.1 at `port`: its own socket, asked directly. */
  ownsListener(port: number): boolean;
  close(): Promise<void>;
};

type Frame = { type?: unknown; id?: unknown; method?: unknown; params?: unknown };

const BOTS = {
  defaultId: "main",
  agents: [{ id: "main", identity: { name: "Juniper" } }],
};

export async function startSyntheticGateway(): Promise<SyntheticGateway> {
  const codes = new Map<string, number>();
  const devices = new Set<string>();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const port = (server.address() as AddressInfo).port;
  const url = `ws://127.0.0.1:${port}`;
  const startedAt = Date.now();
  const bootId = randomBytes(8).toString("hex");

  const hello = (deviceToken: string) => ({
    type: "hello-ok",
    protocol: GATEWAY_PROTOCOL,
    server: { version: TESTED_OPENCLAW_VERSION, connId: randomBytes(6).toString("hex"), bootId },
    features: { methods: [], events: [] },
    snapshot: { uptimeMs: Date.now() - startedAt },
    auth: { role: "operator", scopes: ["operator.read"], deviceToken },
    policy: { maxPayload: 26_214_400, maxBufferedBytes: 52_428_800, tickIntervalMs: 15_000 },
  });

  /** The connect's credential: a code minted here and still good, or a device token issued here. */
  const accepted = (params: unknown): string | null => {
    const auth = (params as { auth?: { bootstrapToken?: unknown; deviceToken?: unknown } } | null)
      ?.auth;
    const code = auth?.bootstrapToken;
    if (typeof code === "string" && (codes.get(code) ?? 0) > Date.now()) {
      codes.delete(code);
      const token = randomBytes(24).toString("base64url");
      devices.add(token);
      return token;
    }
    const device = auth?.deviceToken;
    return typeof device === "string" && devices.has(device) ? device : null;
  };

  const reply = (socket: WebSocket, id: string, result: Record<string, unknown>) =>
    socket.send(JSON.stringify({ type: "res", id, ...result }));

  server.on("connection", (socket) => {
    let connected = false;
    // A peer's protocol error ends that peer's socket, never the host.
    socket.on("error", () => socket.terminate());
    socket.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: randomBytes(12).toString("hex"), ts: Date.now() },
      }),
    );
    socket.on("message", (data) => {
      let frame: Frame;
      try {
        frame = JSON.parse(String(data)) as Frame;
      } catch {
        socket.close(1008, "bad frame");
        return;
      }
      // `null`, a number or an array parses too: only an object is a frame.
      if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
        socket.close(1008, "bad frame");
        return;
      }
      if (frame.type !== "req" || typeof frame.id !== "string") return;
      const id = frame.id;
      if (frame.method === "connect") {
        const token = accepted(frame.params);
        if (token === null) {
          reply(socket, id, {
            ok: false,
            error: { code: "INVALID_REQUEST", message: "unauthorized" },
          });
          return;
        }
        connected = true;
        reply(socket, id, { ok: true, payload: hello(token) });
        return;
      }
      if (!connected) {
        socket.close(1008, "not connected");
        return;
      }
      const answers: Record<string, unknown> = {
        "agents.list": BOTS,
        "sessions.subscribe": { subscribed: true, list: { sessions: [], hasMore: false } },
        "sessions.list": { sessions: [], hasMore: false },
      };
      const method = typeof frame.method === "string" ? frame.method : "";
      if (Object.hasOwn(answers, method)) reply(socket, id, { ok: true, payload: answers[method] });
      else reply(socket, id, { ok: false, error: { code: "UNKNOWN_METHOD", message: "unknown" } });
    });
  });

  return {
    url,
    port,
    mint(now) {
      const bootstrapToken = randomBytes(32).toString("base64url");
      const expiresAtMs = now + SYNTHETIC_CODE_MS;
      codes.set(bootstrapToken, expiresAtMs);
      return { url, bootstrapToken, expiresAtMs };
    },
    ownsListener(expected) {
      const address = server.address();
      return (
        address !== null &&
        typeof address === "object" &&
        address.address === "127.0.0.1" &&
        address.port === port &&
        expected === port
      );
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) client.terminate();
        server.close(() => resolve());
      }),
  };
}
