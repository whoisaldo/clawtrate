import { describe, expect, it } from "vitest";
import {
  createRegisterNonce,
  createSessionId,
  decodeConnectorToRelay,
  decodeEndpointToRelay,
  decodeRelayToConnector,
  decodeRelayToEndpoint,
  encodeRelayMessage,
  isSessionId,
  MAX_RELAY_MESSAGE_BYTES,
  RELAY_ERROR_CODES,
  RELAY_PING,
  RELAY_PONG,
  RelayProtocolError,
  type RelayMessage,
} from "../src/index.ts";

const nonce = createRegisterNonce();
const session = createSessionId();

describe("relay messages", () => {
  it("round-trip in the directions that carry them", () => {
    const cases: [RelayMessage, ((text: unknown) => RelayMessage)[]][] = [
      [{ t: "challenge", nonce }, [decodeRelayToConnector]],
      [{ t: "registered" }, [decodeRelayToConnector]],
      [{ t: "dial", session, from: "2001:db8::7" }, [decodeRelayToConnector]],
      [{ t: "dial", session, from: "" }, [decodeRelayToConnector]],
      [{ t: "register", proof: "a.b" }, [decodeConnectorToRelay]],
      [{ t: "open" }, [decodeRelayToEndpoint]],
      [{ t: "error", code: "connector_offline" }, [decodeRelayToConnector, decodeRelayToEndpoint]],
      [
        { t: "ping" },
        [
          decodeRelayToConnector,
          decodeConnectorToRelay,
          decodeRelayToEndpoint,
          decodeEndpointToRelay,
        ],
      ],
    ];
    for (const [message, decoders] of cases) {
      const text = encodeRelayMessage(message);
      for (const decode of decoders) expect(decode(text)).toEqual(message);
    }
  });

  it("refuse a message in a direction that does not carry it", () => {
    expect(() => decodeConnectorToRelay(encodeRelayMessage({ t: "challenge", nonce }))).toThrow(
      RelayProtocolError,
    );
    expect(() => decodeRelayToEndpoint(encodeRelayMessage({ t: "registered" }))).toThrow(
      RelayProtocolError,
    );
    expect(() => decodeEndpointToRelay(encodeRelayMessage({ t: "open" }))).toThrow(
      RelayProtocolError,
    );
    expect(() => decodeRelayToConnector(encodeRelayMessage({ t: "register", proof: "p" }))).toThrow(
      RelayProtocolError,
    );
  });

  it("keep-alives are fixed texts, so the relay can answer them without waking", () => {
    expect(encodeRelayMessage({ t: "ping" })).toBe(RELAY_PING);
    expect(encodeRelayMessage({ t: "pong" })).toBe(RELAY_PONG);
    expect(RELAY_PING).toBe('{"t":"ping"}');
  });

  it("refuse extra or missing fields and bad values", () => {
    for (const text of [
      '{"t":"ping","x":1}',
      '{"t":"challenge"}',
      `{"t":"challenge","nonce":"${nonce}x"}`,
      `{"t":"challenge","nonce":"${nonce.slice(1)}"}`,
      `{"t":"dial","session":"${session}"}`,
      `{"t":"dial","session":"${session}","from":"host.example"}`,
      `{"t":"dial","session":"${session}","from":"${"1".repeat(46)}"}`,
      `{"t":"dial","session":"x","from":""}`,
      '{"t":"error","code":"Bad"}',
      `{"t":"error","code":"${"a".repeat(33)}"}`,
      '{"t":"error","code":7}',
      '{"t":"nope"}',
      '{"t":["ping"]}',
      '{"__proto__":{"t":"ping"}}',
      '{"t":"ping"} x',
      '{"t":"ping",}',
      '{"t":"ping"',
      "{'t':'ping'}",
      '{"t":"pi\nng"}',
      '{"t":"ping","x":tru}',
      '["ping"]',
      "null",
      "7",
      "{",
      "",
    ]) {
      expect(() => decodeRelayToConnector(text), text).toThrow(RelayProtocolError);
    }
    for (const proof of ["", "p".repeat(1_025)]) {
      expect(() => decodeConnectorToRelay(JSON.stringify({ t: "register", proof }))).toThrow(
        RelayProtocolError,
      );
    }
    expect(() => decodeRelayToEndpoint(new Uint8Array(2))).toThrow(RelayProtocolError);
  });

  it("refuse text over the size cap", () => {
    // Whitespace before the closing brace is valid JSON, so only the length changes.
    const padded = (spaces: number) => `{"t":"ping"${" ".repeat(spaces)}}`;
    expect(padded(MAX_RELAY_MESSAGE_BYTES - 12)).toHaveLength(MAX_RELAY_MESSAGE_BYTES);
    expect(decodeEndpointToRelay(padded(MAX_RELAY_MESSAGE_BYTES - 12))).toEqual({ t: "ping" });
    expect(() => decodeEndpointToRelay(padded(MAX_RELAY_MESSAGE_BYTES - 11))).toThrow(
      expect.objectContaining({ code: "bad_message" }),
    );
  });

  it("accept a well-formed error code a newer relay may send", () => {
    expect(decodeRelayToEndpoint('{"t":"error","code":"maintenance"}')).toEqual({
      t: "error",
      code: "maintenance",
    });
    expect(RELAY_ERROR_CODES).toContain("connector_offline");
  });

  it("session ids are 16 random bytes in canonical base64url", () => {
    expect(session).toHaveLength(22);
    expect(isSessionId(session)).toBe(true);
    // The last character holds 2 bits of data and 4 zero bits; "B" sets one of the zero bits.
    expect(isSessionId(`${session.slice(0, 21)}B`)).toBe(false);
    expect(isSessionId(`${session}A`)).toBe(false);
    expect(createSessionId()).not.toBe(session);
  });
});

describe("unambiguous parsing", () => {
  it("refuses a repeated member name, also when one spelling is escaped", () => {
    for (const text of [
      '{"t":"ping","t":"ping"}',
      '{"t":"ping","\\u0074":"pong"}',
      '{"t":"error","code":"a","code":"b"}',
      `{"t":"challenge","nonce":"${nonce}","n\\u006fnce":"${nonce}"}`,
    ]) {
      expect(() => decodeRelayToConnector(text), text).toThrow(
        expect.objectContaining({ code: "bad_message" }),
      );
    }
  });

  it("accepts ordinary whitespace and any member order", () => {
    expect(decodeRelayToConnector(` {\n "nonce" : "${nonce}" ,\t"t":"challenge" } `)).toEqual({
      t: "challenge",
      nonce,
    });
    expect(decodeRelayToConnector('{"\\u0074":"ping"}')).toEqual({ t: "ping" });
  });

  it("keeps a type that is not a string inside the protocol's error", () => {
    for (const text of [
      '{"t":{"toString":1,"valueOf":1}}',
      '{"t":["ping"]}',
      '{"t":7}',
      '{"t":null}',
      "{}",
    ]) {
      expect(() => decodeRelayToConnector(text), text).toThrow(
        expect.objectContaining({
          code: "bad_message",
          message: expect.not.stringContaining("[object"),
        }),
      );
    }
  });
});
