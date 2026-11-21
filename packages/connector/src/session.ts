// One relayed phone session at the connector: the session socket to the relay, the Noise IK
// responder, and, only once the phone is admitted, the connector's own WebSocket to the gateway.
//
//   relay session socket ── frames ──► Responder ── text ──► gateway socket (built here)
//
// The gateway socket is opened after `settle` admits the phone and never before: a phone that is
// not enrolled, or whose enrollment is refused, never causes a connection to the gateway. Its
// upgrade is the connector's own (forwarded.ts): `X-Forwarded-For` always set, no `Origin`, and
// no header from the phone. Text passes both ways unchanged; the gateway's protocol, its
// `connect` signature and its device tokens are the phone's business.

import { WebSocket, type ClientOptions, type RawData } from "ws";
import {
  decodeRelayToEndpoint,
  isSendableCloseCode,
  MAX_CLOSE_REASON_BYTES,
  MAX_FRAME_BYTES,
  MAX_MESSAGE_BYTES,
  RELAY_PING,
  RELAY_PONG,
  Responder,
  type AdmissionAttempt,
  type ChannelEvent,
  type CommitResult,
  type KeyPair,
  type PhoneGate,
  type ReceiveBudget,
} from "@clawtrate/relay-protocol";
import { RELAY_PING_INTERVAL_MS } from "./control.ts";
import { forwardedHeaders } from "./forwarded.ts";

/** A phone has this long, from the session socket opening, to finish its handshake and confirm. */
export const ADMISSION_TIMEOUT_MS = 30_000;
/**
 * The most bytes waiting to be written on either socket, and the most phone text held while the
 * gateway socket opens: one largest message and some room.
 */
export const MAX_QUEUED_BYTES = MAX_MESSAGE_BYTES + 8 * 1024 * 1024;

export interface AdmissionGate extends PhoneGate {
  /** The admission transaction (allowlist.ts). */
  commit(attempt: AdmissionAttempt): CommitResult;
}

/** Opens a WebSocket; tests pass one that records what was asked. */
export type OpenSocket = (url: string, options: ClientOptions) => WebSocket;

export const openSocket: OpenSocket = (url, options) => new WebSocket(url, options);

export interface SessionOptions {
  readonly relayOrigin: string;
  readonly relayId: string;
  readonly session: string;
  /** The phone's address as the relay reported it; checked again in forwarded.ts. */
  readonly from: string;
  readonly staticKey: KeyPair;
  readonly gate: AdmissionGate;
  readonly gatewayPort: number;
  readonly budget: ReceiveBudget;
  readonly openSocket?: OpenSocket;
  /** Monotonic whole milliseconds, for the partial-message deadline. */
  readonly clock?: () => number;
  readonly onEnd?: (session: RelaySession, reason: string) => void;
  readonly log?: (message: string) => void;
}

export type SessionStage = "handshaking" | "bridging" | "ended";

export class RelaySession {
  readonly id: string;
  readonly #options: SessionOptions;
  readonly #open: OpenSocket;
  readonly #clock: () => number;
  readonly #relay: WebSocket;
  readonly #channel: Responder;
  #gateway: WebSocket | null = null;
  #pending: string[] = [];
  #pendingBytes = 0;
  #phoneKey: Uint8Array | null = null;
  #stage: SessionStage = "handshaking";
  #spliced = false;
  #pinger: ReturnType<typeof setInterval> | null = null;
  #admissionTimer: ReturnType<typeof setTimeout> | null = null;
  #deadlineTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: SessionOptions) {
    this.id = options.session;
    this.#options = options;
    this.#open = options.openSocket ?? openSocket;
    this.#clock = options.clock ?? (() => Math.floor(performance.now()));
    this.#channel = new Responder({
      relayId: options.relayId,
      staticKey: options.staticKey,
      gate: options.gate,
      budget: options.budget,
      clock: this.#clock,
    });
    this.#relay = this.#open(
      `${options.relayOrigin}/v1/session/${options.relayId}/${options.session}`,
      { maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false, followRedirects: false },
    );
    this.#relay.on("open", () => {
      this.#relay.send(RELAY_PING);
      this.#pinger = setInterval(() => {
        if (this.#relay.readyState === WebSocket.OPEN) this.#relay.send(RELAY_PING);
      }, RELAY_PING_INTERVAL_MS);
    });
    this.#relay.on("message", (data: RawData, isBinary: boolean) =>
      this.#fromRelay(data, isBinary),
    );
    this.#relay.on("close", () => this.end("relay_closed"));
    this.#relay.on("error", () => this.end("relay_error"));
    this.#relay.on("unexpected-response", (_request, response) =>
      this.end(`relay_http_${response.statusCode ?? 0}`),
    );
    this.#admissionTimer = setTimeout(() => this.end("admission_timeout"), ADMISSION_TIMEOUT_MS);
  }

  get stage(): SessionStage {
    return this.#stage;
  }

  /** The admitted phone's key, once `settle` admitted it. */
  get phoneKey(): Uint8Array | null {
    return this.#phoneKey === null ? null : Uint8Array.from(this.#phoneKey);
  }

  /** Whether this session ever opened a gateway socket. */
  get gatewayOpened(): boolean {
    return this.#gateway !== null;
  }

  #fromRelay(data: RawData, isBinary: boolean): void {
    if (this.#stage === "ended") return;
    const bytes = toBytes(data);
    if (!isBinary) {
      let message;
      try {
        message = decodeRelayToEndpoint(bytes.toString("utf8"));
      } catch {
        return this.end("bad_relay_message");
      }
      if (message.t === "open") this.#spliced = true;
      else if (message.t === "ping") this.#relay.send(RELAY_PONG);
      else if (message.t === "error") this.end(`relay_error:${message.code}`);
      return;
    }
    if (!this.#spliced) return this.end("frame_before_open");
    let events: ChannelEvent[];
    try {
      events = this.#channel.receive(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length));
    } catch (error) {
      return this.end(`channel:${(error as { code?: string }).code ?? "failed"}`);
    }
    for (const event of events) {
      if ((this.#stage as SessionStage) === "ended") return;
      this.#onEvent(event);
    }
    this.#armDeadline();
  }

  #onEvent(event: ChannelEvent): void {
    switch (event.type) {
      case "send":
        this.#toRelay([event.frame]);
        return;
      case "admit":
        this.#admit(event);
        return;
      case "text":
        this.#toGateway(event.text);
        return;
      case "close": {
        const gateway = this.#gateway;
        if (gateway !== null && gateway.readyState === WebSocket.OPEN) {
          gateway.close(event.code, event.reason);
        }
        this.end("phone_closed");
        return;
      }
      case "refused":
        this.end(`refused:${event.reason}`);
        return;
      case "pong":
      case "open":
        return;
    }
  }

  #admit(event: Extract<ChannelEvent, { type: "admit" }>): void {
    const attempt = this.#channel.beginAdmission(event.admission);
    let result: CommitResult;
    try {
      result = this.#options.gate.commit(attempt);
    } catch (error) {
      this.#options.log?.(`The allowlist could not be written: ${(error as Error).message}`);
      return this.end("commit_failed");
    }
    const settled = this.#channel.settle(attempt, result);
    if (settled.frame !== null) this.#toRelay([settled.frame]);
    if (!settled.admitted) {
      this.end(`refused:${settled.reason}`);
      return;
    }
    if (this.#admissionTimer !== null) clearTimeout(this.#admissionTimer);
    this.#admissionTimer = null;
    this.#phoneKey = settled.phoneKey;
    this.#stage = "bridging";
    this.#openGateway();
  }

  /** The connector's own upgrade to the gateway: its headers are built here and nowhere else. */
  #openGateway(): void {
    const gateway = this.#open(`ws://127.0.0.1:${this.#options.gatewayPort}`, {
      headers: { ...forwardedHeaders(this.#options.from, this.#options.relayOrigin) },
      perMessageDeflate: false,
      followRedirects: false,
      maxPayload: MAX_MESSAGE_BYTES,
      handshakeTimeout: 10_000,
    });
    this.#gateway = gateway;
    gateway.on("open", () => {
      const pending = this.#pending;
      this.#pending = [];
      this.#pendingBytes = 0;
      for (const text of pending) this.#toGateway(text);
    });
    gateway.on("message", (data: RawData, isBinary: boolean) => {
      if (this.#stage !== "bridging") return;
      if (isBinary) return this.#closeChannel(1003, "binary from the gateway");
      let frames: Uint8Array[];
      try {
        frames = this.#channel.sendText(toBytes(data).toString("utf8"));
      } catch {
        return this.#closeChannel(1009, "message too large");
      }
      this.#toRelay(frames);
    });
    gateway.on("close", (code: number, reason: Buffer) => {
      if (this.#stage !== "bridging") return;
      this.#closeChannel(isSendableCloseCode(code) ? code : 1011, reason.toString("utf8"));
    });
    gateway.on("unexpected-response", (_request, response) => {
      this.#options.log?.(
        `The gateway refused the connector's upgrade: HTTP ${response.statusCode}`,
      );
      this.#closeChannel(1011, "the gateway refused the connection");
    });
    gateway.on("error", () => this.#closeChannel(1011, "the gateway connection failed"));
  }

  #toGateway(text: string): void {
    const gateway = this.#gateway;
    if (gateway === null) return;
    if (gateway.readyState === WebSocket.CONNECTING) {
      this.#pendingBytes += Buffer.byteLength(text);
      if (this.#pendingBytes > MAX_QUEUED_BYTES) return this.#closeChannel(1008, "too much queued");
      this.#pending.push(text);
      return;
    }
    if (gateway.readyState !== WebSocket.OPEN) return;
    gateway.send(text);
    if (gateway.bufferedAmount > MAX_QUEUED_BYTES) this.#closeChannel(1008, "too much queued");
  }

  #toRelay(frames: readonly Uint8Array[]): void {
    if (this.#relay.readyState !== WebSocket.OPEN) return this.end("relay_not_open");
    for (const frame of frames) this.#relay.send(frame);
    if (this.#relay.bufferedAmount > MAX_QUEUED_BYTES) this.end("relay_backlog");
  }

  /** An authenticated close to the phone, then the end. */
  #closeChannel(code: number, reason: string): void {
    if (this.#stage === "ended") return;
    if (this.#channel.currentState === "open") {
      try {
        this.#toRelay([this.#channel.close(code, truncateUtf8(reason, MAX_CLOSE_REASON_BYTES))]);
      } catch {
        // The channel failed meanwhile; the end below aborts it.
      }
    }
    this.end(`closed:${code}`);
  }

  /** The partial-message deadline: a timer for just after it, as the channel asks of its host. */
  #armDeadline(): void {
    const deadline = this.#channel.partialMessageDeadline;
    if (deadline === null) {
      if (this.#deadlineTimer !== null) clearTimeout(this.#deadlineTimer);
      this.#deadlineTimer = null;
      return;
    }
    if (this.#deadlineTimer !== null) return;
    this.#deadlineTimer = setTimeout(
      () => {
        this.#deadlineTimer = null;
        let expired: boolean;
        try {
          expired = this.#channel.expirePartialMessage();
        } catch {
          expired = true;
        }
        if (expired) this.end("partial_message_timeout");
        else this.#armDeadline();
      },
      Math.max(0, deadline - this.#clock() + 1),
    );
  }

  /** Ends everything: the channel, both sockets and every timer. Safe to call again. */
  end(reason: string): void {
    if (this.#stage === "ended") return;
    this.#stage = "ended";
    this.#channel.abort();
    for (const timer of [this.#admissionTimer, this.#deadlineTimer]) {
      if (timer !== null) clearTimeout(timer);
    }
    if (this.#pinger !== null) clearInterval(this.#pinger);
    this.#pending = [];
    for (const socket of [this.#relay, this.#gateway]) {
      if (socket === null) continue;
      socket.on("error", () => {});
      if (socket.readyState === WebSocket.OPEN) socket.close(1000);
      else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
    }
    this.#options.onEnd?.(this, reason);
  }
}

function toBytes(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function truncateUtf8(text: string, maxBytes: number): string {
  let out = text;
  while (Buffer.byteLength(out) > maxBytes) out = out.slice(0, -1);
  return out;
}
