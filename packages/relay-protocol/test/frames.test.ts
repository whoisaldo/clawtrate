import { describe, expect, it } from "vitest";
import {
  decodeAnswer,
  decodeFrame,
  decodeHello,
  decodeRecord,
  encodeAnswer,
  encodeFrame,
  encodeHello,
  encodeRecord,
  MAX_FRAME_BYTES,
  MAX_RECORD_DATA_BYTES,
  RelayProtocolError,
  type ChannelRecord,
} from "../src/index.ts";

describe("frames", () => {
  it("are a version byte, a type byte and the Noise message", () => {
    const body = new Uint8Array(17).fill(4);
    const frame = encodeFrame({ type: "transport", body });
    expect([...frame.subarray(0, 2)]).toEqual([1, 3]);
    expect(decodeFrame(frame)).toEqual({ type: "transport", body });
  });

  it("hold each type to the lengths its Noise message can have", () => {
    const cases: [number, number, number][] = [
      // type byte, shortest body, longest body
      [1, 96, 160],
      [2, 48, 112],
      [3, 17, 65_535],
    ];
    for (const [type, min, max] of cases) {
      for (const length of [min, max]) {
        expect(() => decodeFrame(Uint8Array.of(1, type, ...new Uint8Array(length)))).not.toThrow();
      }
      for (const length of [min - 1, max + 1]) {
        expect(() => decodeFrame(new Uint8Array([1, type, ...new Uint8Array(length)]))).toThrow(
          RelayProtocolError,
        );
      }
    }
    expect(MAX_FRAME_BYTES).toBe(65_537);
    expect(() => decodeFrame(new Uint8Array(MAX_FRAME_BYTES + 1))).toThrow(RelayProtocolError);
  });

  it("refuse an unknown type, a missing header and another version", () => {
    for (const bytes of [
      new Uint8Array(0),
      Uint8Array.of(1),
      Uint8Array.of(1, 0, 0),
      Uint8Array.of(1, 4, 0),
    ]) {
      expect(() => decodeFrame(bytes)).toThrow(expect.objectContaining({ code: "malformed" }));
    }
    expect(() => decodeFrame(Uint8Array.of(0, 3, ...new Uint8Array(17)))).toThrow(
      expect.objectContaining({ code: "unsupported_version" }),
    );
  });
});

describe("records", () => {
  it("round-trip every kind", () => {
    const records: ChannelRecord[] = [
      { kind: "confirm" },
      { kind: "text-part", data: new Uint8Array(MAX_RECORD_DATA_BYTES) },
      { kind: "admission", answer: "accepted" },
      { kind: "admission", answer: "enrollment_refused" },
      { kind: "text-end", data: new Uint8Array(0) },
      { kind: "text-end", data: new Uint8Array(MAX_RECORD_DATA_BYTES) },
      { kind: "ping", data: new Uint8Array(32) },
      { kind: "pong", data: new Uint8Array(0) },
      { kind: "close", code: 1000, reason: "" },
      { kind: "close", code: 4999, reason: "é".repeat(61) },
    ];
    for (const record of records) expect(decodeRecord(encodeRecord(record))).toEqual(record);
  });

  it("refuse what breaks a kind's rules", () => {
    for (const bytes of [
      new Uint8Array(0),
      Uint8Array.of(0),
      Uint8Array.of(7),
      Uint8Array.of(1, 0),
      Uint8Array.of(2),
      Uint8Array.of(4, ...new Uint8Array(33)),
      Uint8Array.of(6, 3),
      Uint8Array.of(6, 0x03, 0xee),
      Uint8Array.of(6, 0x03, 0xe8, ...new Uint8Array(124)),
      new Uint8Array(MAX_RECORD_DATA_BYTES + 2).fill(3, 0, 1),
    ]) {
      expect(() => decodeRecord(bytes), `${bytes.slice(0, 4)}`).toThrow(RelayProtocolError);
    }
    expect(() => decodeRecord(Uint8Array.of(6, 0x03, 0xe8, 0xff))).toThrow(
      expect.objectContaining({ code: "bad_utf8" }),
    );
    expect(() => encodeRecord({ kind: "close", code: 1000, reason: "x".repeat(124) })).toThrow(
      RelayProtocolError,
    );
  });
});

describe("handshake payloads", () => {
  it("a hello carries the enrollment secret or nothing, and an answer one status", () => {
    const enroll = new Uint8Array(32).fill(2);
    expect(decodeHello(encodeHello({}))).toEqual({});
    expect(decodeHello(encodeHello({ enroll }))).toEqual({ enroll });
    expect(encodeHello({ enroll })).toHaveLength(34);
    for (const answer of ["accepted", "not_enrolled", "enrollment_refused"] as const) {
      expect(decodeAnswer(encodeAnswer(answer))).toBe(answer);
    }
  });

  it("refuse anything else", () => {
    expect(() => encodeHello({ enroll: new Uint8Array(31) })).toThrow(RelayProtocolError);
    for (const bytes of [
      Uint8Array.of(1),
      Uint8Array.of(2, 0),
      Uint8Array.of(1, 0, 0),
      Uint8Array.of(1, 1, ...new Uint8Array(31)),
      Uint8Array.of(1, 2, ...new Uint8Array(32)),
    ]) {
      expect(() => decodeHello(bytes)).toThrow(RelayProtocolError);
    }
    for (const bytes of [
      Uint8Array.of(1),
      Uint8Array.of(1, 3),
      Uint8Array.of(2, 0),
      Uint8Array.of(1, 0, 0),
    ]) {
      expect(() => decodeAnswer(bytes)).toThrow(RelayProtocolError);
    }
  });
});
