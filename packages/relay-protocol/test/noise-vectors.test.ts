import { describe, expect, it } from "vitest";
import {
  IKHandshake,
  keyPairFromSecret,
  NOISE_PROTOCOL_NAME,
  RelayProtocolError,
} from "../src/index.ts";
import { hex, toHex } from "./helpers.ts";
import cacophony from "./vectors/cacophony-ik.json";

describe("Noise IK against the Cacophony test vectors", () => {
  it("has a vector for exactly this protocol", () => {
    expect(cacophony.vectors.length).toBeGreaterThan(0);
    for (const vector of cacophony.vectors) expect(vector.protocol_name).toBe(NOISE_PROTOCOL_NAME);
  });

  for (const [index, vector] of cacophony.vectors.entries()) {
    it(`reproduces vector ${index}: both handshake messages, the handshake hash and every transport message`, () => {
      const responderStatic = keyPairFromSecret(hex(vector.resp_static));
      expect(toHex(responderStatic.publicKey)).toBe(vector.init_remote_static);

      const initiator = new IKHandshake({
        initiator: true,
        prologue: hex(vector.init_prologue),
        staticKey: keyPairFromSecret(hex(vector.init_static)),
        remoteStaticKey: hex(vector.init_remote_static),
        random: () => hex(vector.init_ephemeral),
      });
      const responder = new IKHandshake({
        initiator: false,
        prologue: hex(vector.resp_prologue),
        staticKey: responderStatic,
        random: () => hex(vector.resp_ephemeral),
      });

      const [first, second, ...transport] = vector.messages;
      const message1 = initiator.writeMessage1(hex(first!.payload));
      expect(toHex(message1)).toBe(first!.ciphertext);
      expect(toHex(responder.readMessage1(message1))).toBe(first!.payload);
      expect(toHex(responder.remoteStaticKey!)).toBe(
        toHex(keyPairFromSecret(hex(vector.init_static)).publicKey),
      );

      const message2 = responder.writeMessage2(hex(second!.payload));
      expect(toHex(message2)).toBe(second!.ciphertext);
      expect(toHex(initiator.readMessage2(message2))).toBe(second!.payload);

      expect(toHex(initiator.transportKeys.handshakeHash)).toBe(vector.handshake_hash);
      expect(toHex(responder.transportKeys.handshakeHash)).toBe(vector.handshake_hash);

      expect(transport.length).toBeGreaterThan(0);
      for (const [i, message] of transport.entries()) {
        // After a two-message handshake, the initiator sends first and the sides alternate.
        const [sender, receiver] = i % 2 === 0 ? [initiator, responder] : [responder, initiator];
        const empty = new Uint8Array(0);
        const ciphertext = sender.transportKeys.send.encrypt(empty, hex(message.payload));
        expect(toHex(ciphertext)).toBe(message.ciphertext);
        expect(toHex(receiver.transportKeys.receive.decrypt(empty, ciphertext))).toBe(
          message.payload,
        );
      }
    });
  }

  it("derives a key pair's public half from the same bytes it keeps as the secret", () => {
    const secret = new Uint8Array(32).fill(9);
    // An array whose iterator lies about its bytes must not split the pair.
    Object.defineProperty(secret, Symbol.iterator, {
      value: function* () {
        for (let i = 0; i < 32; i++) yield 7;
      },
    });
    const pair = keyPairFromSecret(secret);
    expect(toHex(pair.secretKey)).toBe("09".repeat(32));
    expect(toHex(pair.publicKey)).toBe(
      toHex(keyPairFromSecret(new Uint8Array(32).fill(9)).publicKey),
    );
  });

  it("hands out copies of the peer's static key, so a caller cannot change the handshake", () => {
    const vector = cacophony.vectors[0]!;
    const responder = new IKHandshake({
      initiator: false,
      prologue: hex(vector.resp_prologue),
      staticKey: keyPairFromSecret(hex(vector.resp_static)),
      random: () => hex(vector.resp_ephemeral),
    });
    responder.readMessage1(hex(vector.messages[0]!.ciphertext));
    responder.remoteStaticKey!.fill(0);
    expect(toHex(responder.remoteStaticKey!)).toBe(
      toHex(keyPairFromSecret(hex(vector.init_static)).publicKey),
    );
    expect(toHex(responder.writeMessage2(hex(vector.messages[1]!.payload)))).toBe(
      vector.messages[1]!.ciphertext,
    );
  });

  it("ends a handshake that is driven out of order", () => {
    const vector = cacophony.vectors[0]!;
    const initiator = new IKHandshake({
      initiator: true,
      prologue: hex(vector.init_prologue),
      staticKey: keyPairFromSecret(hex(vector.init_static)),
      remoteStaticKey: hex(vector.init_remote_static),
    });
    expect(() => initiator.readMessage2(new Uint8Array(48))).toThrow(RelayProtocolError);
    expect(() => initiator.writeMessage1(new Uint8Array(0))).toThrow(RelayProtocolError);
  });
});
