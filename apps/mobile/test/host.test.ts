import { createPrivateKey, createPublicKey, createHash, sign, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  DEVICE_SERVICE,
  itemName,
  STATE_SERVICE,
  type KeychainOptions,
  type SecureStoreLike,
} from "../src/host/keychain.ts";
import { createKeychainSigner, DEVICE_KEY_ITEM } from "../src/host/signer.ts";
import { createSocketFactory, type WebSocketConstructor } from "../src/host/socket.ts";
import { createSecrets, REDACTED } from "../src/host/secrets.ts";
import { createKeychainStore } from "../src/host/store.ts";

/** A Keychain of generic-password items, keyed by service and name, as expo-secure-store keeps them. */
function fakeKeychain() {
  const items = new Map<string, string>();
  const calls: Array<{ op: string; key: string; options: KeychainOptions }> = [];
  const id = (key: string, options: KeychainOptions) => `${options.keychainService}/${key}`;
  const keychain: SecureStoreLike & { items: Map<string, string>; calls: typeof calls } = {
    items,
    calls,
    async getItemAsync(key, options) {
      calls.push({ op: "get", key, options });
      return items.get(id(key, options)) ?? null;
    },
    async setItemAsync(key, value, options) {
      calls.push({ op: "set", key, options });
      // expo-secure-store refuses any other character in a key.
      if (!/^[\w.-]+$/.test(key)) throw new Error(`invalid key ${key}`);
      items.set(id(key, options), value);
    },
    async deleteItemAsync(key, options) {
      calls.push({ op: "delete", key, options });
      items.delete(id(key, options));
    },
  };
  return keychain;
}

const ACCESSIBLE = 7;

describe("the iOS host's store", () => {
  it("keeps every value core stores in the Keychain, one item per key, readable only on this device", async () => {
    const keychain = fakeKeychain();
    const store = createKeychainStore(keychain, ACCESSIBLE);
    const tokenKey = `deviceToken:${encodeURIComponent("ws://127.0.0.1:19201")}:abc:operator`;
    await store.set("connection", '{"url":"ws://127.0.0.1:19201","token":"bootstrap"}');
    await store.set(tokenKey, '{"token":"device"}');
    expect(await store.get("connection")).toBe(
      '{"url":"ws://127.0.0.1:19201","token":"bootstrap"}',
    );
    expect(await store.get(tokenKey)).toBe('{"token":"device"}');
    expect(await store.get("missing")).toBeNull();
    await store.delete("connection");
    expect(await store.get("connection")).toBeNull();
    expect(await store.get(tokenKey)).toBe('{"token":"device"}');
    expect(keychain.calls.every((call) => call.options.keychainService === STATE_SERVICE)).toBe(
      true,
    );
    expect(keychain.calls.every((call) => call.options.keychainAccessible === ACCESSIBLE)).toBe(
      true,
    );
  });

  it("names items with letters, digits, dots, dashes and underscores only, one name per key", () => {
    const keys = [
      "connection",
      "deviceToken:ws%3A%2F%2Fa:1:operator",
      "deviceToken:ws%3A%2F%2Fb:1:operator",
      "ä:/",
    ];
    const names = keys.map(itemName);
    for (const name of names) expect(name).toMatch(/^[\w.-]+$/);
    expect(new Set(names).size).toBe(keys.length);
  });
});

/** Node's view of a raw Ed25519 key pair, to check the signer against an independent implementation. */
function nodeKeys(secretKey: Uint8Array, publicKey: Uint8Array) {
  const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
  const jwk = { kty: "OKP", crv: "Ed25519", d: b64u(secretKey), x: b64u(publicKey) };
  return {
    privateKey: createPrivateKey({ key: jwk, format: "jwk" }),
    publicKey: createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" }),
  };
}

describe("the iOS host's device signer", () => {
  const seed = Uint8Array.from({ length: 32 }, (_, i) => i * 7 + 1);

  it("makes the key once from the system's random source, keeps it in the Keychain and signs as Node does", async () => {
    const keychain = fakeKeychain();
    const random = vi.fn((count: number) => seed.slice(0, count));
    const signer = createKeychainSigner(keychain, ACCESSIBLE, random);
    const [first, second] = await Promise.all([signer.loadIdentity(), signer.loadIdentity()]);
    expect(random).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    // The key is in the device service's item, and nowhere else.
    expect([...keychain.items.keys()]).toEqual([`${DEVICE_SERVICE}/${DEVICE_KEY_ITEM}`]);
    expect(keychain.items.get(`${DEVICE_SERVICE}/${DEVICE_KEY_ITEM}`)).toBe(
      Buffer.from(seed).toString("base64"),
    );
    expect(keychain.calls.every((call) => call.options.keychainAccessible === ACCESSIBLE)).toBe(
      true,
    );

    // The identity is what the gateway expects: the raw public key in base64url, its SHA-256 in hex.
    const raw = Buffer.from(first.publicKey, "base64url");
    expect(raw).toHaveLength(32);
    expect(first.deviceId).toBe(createHash("sha256").update(raw).digest("hex"));
    const keys = nodeKeys(seed, raw);
    expect(Buffer.from(keys.publicKey.export({ format: "jwk" }).x!, "base64url")).toEqual(raw);

    const payload =
      "v3|device|gateway-client|ui|operator|operator.read|1794921969869|token|nonce|ios|";
    const signature = await signer.sign(payload);
    expect(
      verify(null, Buffer.from(payload), keys.publicKey, Buffer.from(signature, "base64url")),
    ).toBe(true);
    // Ed25519 is deterministic: Node's signature with the same key is the same bytes.
    expect(signature).toBe(sign(null, Buffer.from(payload), keys.privateKey).toString("base64url"));
  });

  it("loads the same identity in a later launch without making a new key", async () => {
    const keychain = fakeKeychain();
    const before = await createKeychainSigner(keychain, ACCESSIBLE, () => seed).loadIdentity();
    const random = vi.fn(() => new Uint8Array(32));
    const after = await createKeychainSigner(keychain, ACCESSIBLE, random).loadIdentity();
    expect(after).toEqual(before);
    expect(random).not.toHaveBeenCalled();
  });

  it("keeps the identity when the Keychain cannot be read, and tries again next time", async () => {
    const keychain = fakeKeychain();
    await createKeychainSigner(keychain, ACCESSIBLE, () => seed).loadIdentity();
    const stored = keychain.items.get(`${DEVICE_SERVICE}/${DEVICE_KEY_ITEM}`);
    const random = vi.fn(() => new Uint8Array(32).fill(9));
    const locked = {
      ...keychain,
      getItemAsync: vi
        .fn()
        .mockRejectedValueOnce(new Error("locked"))
        .mockImplementation(keychain.getItemAsync),
    };
    const signer = createKeychainSigner(locked, ACCESSIBLE, random);
    await expect(signer.loadIdentity()).rejects.toThrow("locked");
    expect(random).not.toHaveBeenCalled();
    expect(keychain.items.get(`${DEVICE_SERVICE}/${DEVICE_KEY_ITEM}`)).toBe(stored);
    // Unlocked again, the same key.
    const identity = await signer.loadIdentity();
    expect(identity.deviceId).toBe(
      (await createKeychainSigner(keychain, ACCESSIBLE, random).loadIdentity()).deviceId,
    );
    expect(random).not.toHaveBeenCalled();
  });

  it("refuses a stored key that is not 32 bytes rather than replace it", async () => {
    const keychain = fakeKeychain();
    keychain.items.set(
      `${DEVICE_SERVICE}/${DEVICE_KEY_ITEM}`,
      Buffer.from("short").toString("base64"),
    );
    const random = vi.fn(() => seed);
    await expect(createKeychainSigner(keychain, ACCESSIBLE, random).loadIdentity()).rejects.toThrow(
      "unreadable",
    );
    expect(random).not.toHaveBeenCalled();
  });
});

describe("the iOS host's socket factory", () => {
  it("opens React Native's WebSocket at the gateway's address", () => {
    const opened: string[] = [];
    class Socket {
      readyState = 0;
      onopen = null;
      onmessage = null;
      onclose = null;
      onerror = null;
      constructor(url: string) {
        opened.push(url);
      }
      send() {}
      close() {}
    }
    const factory = createSocketFactory(Socket as unknown as WebSocketConstructor);
    const socket = factory("wss://gateway.example:443");
    expect(socket).toBeInstanceOf(Socket);
    factory("ws://127.0.0.1:19201");
    expect(opened).toEqual(["wss://gateway.example:443", "ws://127.0.0.1:19201"]);
  });

  it("opens nothing for another scheme", () => {
    const Socket = vi.fn();
    const factory = createSocketFactory(Socket as unknown as WebSocketConstructor);
    for (const url of [
      "http://127.0.0.1:19201",
      "https://gateway.example",
      "file:///etc/hosts",
      "127.0.0.1:19201",
    ])
      expect(() => factory(url)).toThrow(/ws: or wss:/);
    expect(Socket).not.toHaveBeenCalled();
  });
});

describe("the iOS host's credential scrubbing", () => {
  it("scrubs a short token the connect form accepted", () => {
    const secrets = createSecrets();
    secrets.learn("connection", JSON.stringify({ token: "Rv7q" }));
    expect(secrets.redact("Gateway refused Rv7q")).toBe(`Gateway refused ${REDACTED}`);
  });

  it("scrubs a longer token whole when a shorter known token is its prefix", () => {
    const secrets = createSecrets();
    const bootstrap = "check-prefix";
    const device = `${bootstrap}-sentinel-tail`;
    secrets.learn("connection", JSON.stringify({ token: bootstrap }));
    secrets.learn("deviceToken:sample", JSON.stringify({ token: device }));
    expect(secrets.redact(device)).toBe(REDACTED);
    expect(secrets.redact(`${bootstrap} and ${device}`)).toBe(`${REDACTED} and ${REDACTED}`);
  });
});
