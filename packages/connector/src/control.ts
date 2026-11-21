// The connector's control socket to the relay, `/v1/connector/<relayId>`: it answers the
// relay's challenge with a register proof, then hears of phones dialing. One socket is one
// supervised link (supervisor.ts).

import { WebSocket, type RawData } from "ws";
import {
  createRegisterProof,
  decodeRelayToConnector,
  encodeRelayMessage,
  MAX_RELAY_MESSAGE_BYTES,
  RELAY_PING,
  RELAY_PONG,
} from "@clawtrate/relay-protocol";
import { relayOriginOptions } from "./config.ts";
import type { ControlLink, LinkEvents, Readiness } from "./supervisor.ts";

/** The relay asks for a ping at least every 30 seconds; one is sent as soon as a socket opens. */
export const RELAY_PING_INTERVAL_MS = 25_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;

export interface ControlOptions {
  readonly relayOrigin: string;
  readonly relayId: string;
  readonly registrationSecret: Uint8Array;
  readonly events: LinkEvents & {
    /** A phone dialed: open `/v1/session/<relayId>/<session>`. `from` is unchecked text. */
    dial(session: string, from: string): void;
  };
  /** Wall-clock milliseconds, for the proof's `iat`. */
  readonly wallClock?: () => number;
  readonly log?: (message: string) => void;
}

export function openControl(options: ControlOptions): ControlLink {
  const url = `${options.relayOrigin}/v1/connector/${options.relayId}`;
  const socket = new WebSocket(url, {
    maxPayload: MAX_RELAY_MESSAGE_BYTES,
    perMessageDeflate: false,
    followRedirects: false,
    handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
  });
  let challenged = false;
  let registered = false;
  let heard = false;
  let ended = false;
  let pinger: ReturnType<typeof setInterval> | null = null;

  const end = (reason: string) => {
    if (ended) return;
    ended = true;
    if (pinger !== null) clearInterval(pinger);
    socket.removeAllListeners();
    socket.on("error", () => {});
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.terminate();
    }
    options.events.exited(reason);
  };

  socket.on("open", () => {
    socket.send(RELAY_PING);
    pinger = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(RELAY_PING);
    }, RELAY_PING_INTERVAL_MS);
  });
  socket.on("message", (data: RawData, isBinary: boolean) => {
    heard = true;
    if (isBinary) return end("binary_on_control");
    let message;
    try {
      message = decodeRelayToConnector(data.toString("utf8"));
    } catch {
      return end("bad_message");
    }
    switch (message.t) {
      case "challenge": {
        if (challenged) return end("second_challenge");
        challenged = true;
        let proof: string;
        try {
          proof = createRegisterProof({
            secretKey: options.registrationSecret,
            audience: options.relayOrigin,
            nonce: message.nonce,
            nowMs: (options.wallClock ?? Date.now)(),
            ...relayOriginOptions(options.relayOrigin),
          });
        } catch (error) {
          options.log?.(`Could not make the register proof: ${(error as Error).message}`);
          return end("proof_failed");
        }
        socket.send(encodeRelayMessage({ t: "register", proof }));
        return;
      }
      case "registered":
        if (!challenged || registered) return end("unexpected_registered");
        registered = true;
        options.events.registered();
        return;
      case "dial":
        if (!registered) return end("dial_before_registered");
        options.events.dial(message.session, message.from);
        return;
      case "error":
        options.log?.(`The relay closed the control socket: ${message.code}`);
        return end(`relay_error:${message.code}`);
      case "ping":
        socket.send(RELAY_PONG);
        return;
      case "pong":
        return;
    }
  });
  socket.on("unexpected-response", (_request, response) => {
    end(`http_${response.statusCode ?? 0}`);
  });
  socket.on("error", (error) => end(`socket_error:${error.message}`));
  socket.on("close", (code) => end(`closed:${code}`));

  return {
    close: () => end("closed_by_connector"),
    readiness(): Readiness {
      if (!registered || ended) return "unknown";
      const answered = heard;
      heard = false;
      return answered ? "ready" : "not_ready";
    },
  };
}
