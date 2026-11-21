// The client's WebSocket over an SSH route (docs/decisions.md, "SSH to another
// computer"): it is made only on the forward's own local socket, proven the
// forward's own just before it connects, and speaks to the gateway as a local
// client of that computer would, with the gateway's loopback address and port
// as its Host. Nothing it sends goes over a local TCP port.

import { connect } from "node:net";

import type { WebSocketLike } from "@clawtrate/core";
import WebSocket from "ws";

/** The largest message the client takes, as the gateway's own limit allows (`ws`'s default). */
const MAX_PAYLOAD = 100 * 1024 * 1024;

/**
 * A WebSocket to the gateway at `gatewayPort` on the other computer, through
 * the local socket at `path`. `proven` is asked when the connection is made;
 * a socket that isn't the forward's own any more gets no connection.
 */
export function routeWebSocket(
  path: string,
  gatewayPort: number,
  proven: () => boolean,
): WebSocketLike {
  const socket = new WebSocket(`ws://127.0.0.1:${gatewayPort}`, {
    createConnection: () => {
      if (!proven()) throw new Error("The SSH route's local socket isn't the forward's own.");
      return connect({ path });
    },
    perMessageDeflate: false,
    maxPayload: MAX_PAYLOAD,
    handshakeTimeout: 15_000,
    followRedirects: false,
  });
  return socket as unknown as WebSocketLike;
}
