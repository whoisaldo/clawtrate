// Core's WebSocket factory on iOS: React Native's WebSocket, which has the
// WHATWG shape core uses. Core checks a gateway's address before it connects;
// the factory refuses anything but ws: and wss: again, so no other scheme ever
// reaches the native socket.

import type { WebSocketFactory, WebSocketLike } from "@clawtrate/core";

export type WebSocketConstructor = new (url: string) => WebSocketLike;

export function createSocketFactory(Socket: WebSocketConstructor): WebSocketFactory {
  return (url) => {
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
    if (scheme !== "ws" && scheme !== "wss") {
      throw new Error(`A gateway is reached over ws: or wss:, not ${scheme ?? "this address"}.`);
    }
    return new Socket(url);
  };
}
