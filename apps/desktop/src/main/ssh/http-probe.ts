// One connection through a forward before it is called up: the far end must
// answer as an HTTP service, as the gateway's port does. The request carries no
// credential, no cookie and no token: a GET of the gateway's health path. Only
// whether a status line came back is read; nothing of the answer is kept.

import { connect, type Socket } from "node:net";

/** What the forward's own output said about its connections, as parsed facts. */
export type ChannelFacts = {
  /** The server refused to open a forwarded connection ("administratively prohibited"). */
  refused: boolean;
  /** The server could not connect to the gateway's port ("connect failed"). */
  connectFailed: boolean;
};

export type ProbeResult = "http" | "forwarding-refused" | "gateway-closed" | "no-answer";

const STATUS_LINE = /^HTTP\/1\.[01] [1-5][0-9]{2} [\t\x20-\x7e\x80-\xff]*\r$/;
const MAX_READ = 1024;

/**
 * Connects to the forward's local socket (a path) or port, sends one plain request, and reads
 * whether the far end answered with an HTTP status line. When the connection
 * closes without one, the forward's facts tell a refused forwarding and a
 * closed gateway port from no answer.
 */
export function probeHttp(
  local: number | string,
  gatewayPort: number,
  channel: () => ChannelFacts,
  timeoutMs = 5000,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    // Already stopped: no connection is made.
    if (signal?.aborted) {
      resolve("no-answer");
      return;
    }
    let settled = false;
    let received = Buffer.alloc(0);
    let socket: Socket | null = null;
    let again: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => finish("no-answer");
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (again) clearTimeout(again);
      // The forward's signal outlives every probe: nothing of this one stays on it.
      signal?.removeEventListener("abort", onAbort);
      socket?.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish("no-answer"), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    const closedWithout = () => {
      if (settled) return;
      // The forward's line about the refused channel can come just after the close.
      const deadline = Date.now() + 750;
      const look = () => {
        const facts = channel();
        if (facts.refused) return finish("forwarding-refused");
        if (facts.connectFailed) return finish("gateway-closed");
        if (Date.now() >= deadline) return finish("no-answer");
        setTimeout(look, 50);
      };
      look();
    };
    const attempt = () => {
      if (settled) return;
      const current =
        typeof local === "number" ? connect(local, "127.0.0.1") : connect({ path: local });
      socket = current;
      let connected = false;
      current.on("connect", () => {
        connected = true;
        current.write(
          `GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:${gatewayPort}\r\nConnection: close\r\n\r\n`,
        );
      });
      current.on("data", (chunk: Buffer) => {
        const part = chunk.subarray(0, MAX_READ - received.length);
        received = Buffer.concat([received, part]);
        const end = received.indexOf(0x0a);
        if (end !== -1) {
          finish(
            STATUS_LINE.test(received.subarray(0, end).toString("latin1")) ? "http" : "no-answer",
          );
        } else if (received.length === MAX_READ) {
          finish("no-answer");
        }
      });
      current.on("error", (error: NodeJS.ErrnoException) => {
        if (settled) return;
        // OpenSSH logs that it listens just before it binds the port: refused here, before any
        // connection was made, means not bound yet, so the probe tries again until its time is up.
        if (!connected && (error.code === "ECONNREFUSED" || error.code === "ENOENT")) {
          current.removeAllListeners("close");
          current.destroy();
          again = setTimeout(attempt, 50);
          return;
        }
        closedWithout();
      });
      current.on("close", closedWithout);
    };
    attempt();
  });
}
