// Node implementations of the host services: a JSON file store, an Ed25519 key
// kept in a private file, and the built-in WebSocket. Used by Electron's main
// process and by the web preview host. Never imported by shared code.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ClawtrateHost,
  ClientIdentity,
  DeviceSigner,
  KeyValueStore,
  WebSocketLike,
} from "../host.ts";

async function writePrivateFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, contents, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
}

/**
 * A key/value store persisted as one JSON file with owner-only permissions. A
 * change is written to a copy, and the copy becomes what `get` reads only once
 * the file has been replaced.
 */
export function createFileStore(path: string): KeyValueStore {
  let cache: Record<string, string> | null = null;
  let queue: Promise<void> = Promise.resolve();

  const load = async () => {
    if (cache) return cache;
    // A write can land while this read is in flight; the first value to fill the cache wins.
    try {
      const loaded = JSON.parse(await readFile(path, "utf8")) as Record<string, string>;
      cache ??= loaded;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      cache ??= {};
    }
    return cache;
  };
  const persist = (mutate: (data: Record<string, string>) => void) => {
    const run = queue.then(async () => {
      const data = { ...(await load()) };
      mutate(data);
      await writePrivateFile(path, `${JSON.stringify(data, null, 2)}\n`);
      cache = data;
    });
    queue = run.catch(() => {});
    return run;
  };

  return {
    get: async (key) => (await load())[key] ?? null,
    set: (key, value) =>
      persist((data) => {
        data[key] = value;
      }),
    delete: (key) =>
      persist((data) => {
        delete data[key];
      }),
  };
}

/** Raw 32-byte Ed25519 public key from a SPKI key object. */
function rawPublicKey(publicKeyPem: string): Buffer {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return Buffer.from(der.subarray(der.length - 32));
}

/** Ed25519 device identity in a PEM file, created on first use. */
export function createFileSigner(path: string): DeviceSigner {
  let loaded: Promise<{ privateKeyPem: string; deviceId: string; publicKey: string }> | null = null;

  const load = () =>
    (loaded ??= (async () => {
      let privateKeyPem: string;
      try {
        privateKeyPem = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const { privateKey } = generateKeyPairSync("ed25519");
        privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
        await writePrivateFile(path, privateKeyPem);
      }
      const publicKeyPem = createPublicKey(createPrivateKey(privateKeyPem))
        .export({ type: "spki", format: "pem" })
        .toString();
      const raw = rawPublicKey(publicKeyPem);
      return {
        privateKeyPem,
        deviceId: createHash("sha256").update(raw).digest("hex"),
        publicKey: raw.toString("base64url"),
      };
    })());

  return {
    async loadIdentity() {
      const { deviceId, publicKey } = await load();
      return { deviceId, publicKey };
    },
    async sign(payload) {
      const { privateKeyPem } = await load();
      return sign(null, Buffer.from(payload, "utf8"), createPrivateKey(privateKeyPem)).toString(
        "base64url",
      );
    },
  };
}

export type NodeHostOptions = {
  /** Directory for the device key and saved connection state. Created with mode 0700. */
  dataDir: string;
  client: ClientIdentity;
  log?: ClawtrateHost["log"];
  approvalInstructions?: ClawtrateHost["approvalInstructions"];
  /** The host's read-back on the gateway's computer after an approval (setup §9). */
  readBack?: ClawtrateHost["readBack"];
  /** Wraps the file store: the desktop host keeps each route's device token in its route store. */
  wrapStorage?: (store: KeyValueStore) => KeyValueStore;
  /**
   * The host's own socket for an address it holds (an SSH route's forward), or
   * null for any other address, which gets the built-in WebSocket.
   */
  routeSocket?: (url: string) => WebSocketLike | null;
};

export function createNodeHost(options: NodeHostOptions): ClawtrateHost {
  return {
    createWebSocket: (url) =>
      options.routeSocket?.(url) ?? (new WebSocket(url) as unknown as WebSocketLike),
    storage: (options.wrapStorage ?? ((store) => store))(
      createFileStore(join(options.dataDir, "state.json")),
    ),
    signer: createFileSigner(join(options.dataDir, "device-key.pem")),
    client: options.client,
    ...(options.log ? { log: options.log } : {}),
    ...(options.approvalInstructions ? { approvalInstructions: options.approvalInstructions } : {}),
    ...(options.readBack ? { readBack: options.readBack } : {}),
  };
}
