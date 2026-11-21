// Connect on this computer at the edges of its consent and its connection
// (docs/design/setup.md §7, docs/decisions.md): the endpoint's listener read
// again once the setup socket opens and again just before its credential
// goes; a refusal whose code the protocol doesn't name; a Back whose cleanup
// failed; and a saved pairing that went or came after the person agreed.
// Production's setup world with in-memory sockets, fixture outputs and a
// fake process lookup: no gateway, no OpenClaw command and no network.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClawtrateClient, type ClawtrateHost } from "@clawtrate/core";
import { describe, expect, it, vi } from "vitest";
import {
  FakeGateway,
  deferred,
  helloOk,
  memoryStorage,
  testHost,
  tokenKey,
  until,
} from "../../../packages/core/test/fake-gateway.ts";
import { SetupController } from "../src/setup/controller.ts";
import type { Opened } from "../src/setup/sandbox.ts";
import { productionWorld } from "../src/setup/world.ts";
import { authJson, qrJson, statusJson, VERSION_LINE } from "./fixtures/openclaw-outputs.ts";

const URL = "ws://127.0.0.1:19940";
const PORT = 19940;
const CODE = "fictional".repeat(4) + "1234567";
const TOKEN = "fixture-device-token-for-unit-test";
const SCOPES = ["operator.read"];
const READ_TOKEN = JSON.stringify({ token: TOKEN, grantedScopes: SCOPES, heldScopes: SCOPES });

function makeClient(gateway: FakeGateway, storage = memoryStorage(), host?: ClawtrateHost) {
  return new ClawtrateClient(host ?? testHost(gateway, storage), {
    reconnect: { initialMs: 10, maxMs: 20 },
  });
}

/** The process the status reports on the port, which a test can swap for another. */
type Listener = { pid: number };

/** A look and Connect against production's world, with a fixture CLI and process lookup. */
async function withLocalSetup(
  client: ClawtrateClient,
  exercise: (setup: SetupController) => Promise<void>,
  listener: Listener = { pid: 4242 },
) {
  const dir = mkdtempSync(join(tmpdir(), "clawtrate-setup-edges-"));
  const world = {
    ...productionWorld({ home: dir, appData: dir, platform: "darwin" }),
    candidates: [process.execPath],
    deep: false,
  };
  const opened: Opened = {
    world,
    // The look's listener and a stranger, each alive with its own start time.
    identify: (pid) =>
      pid === 4242
        ? { state: "alive", identity: "start-4242" }
        : pid === 5555
          ? { state: "alive", identity: "start-5555" }
          : { state: "exited", how: "absent" },
    run: async ({ args }) => {
      const text = args.join(" ");
      const stdout =
        text === "--version"
          ? VERSION_LINE
          : text === "gateway status --json"
            ? statusJson({ port: PORT, listenerPid: listener.pid })
            : text === "config get gateway.auth.mode --json"
              ? authJson()
              : text.startsWith("qr ")
                ? qrJson(URL, CODE, Date.now() + 60_000)
                : "";
      return { stdout, exitCode: stdout ? 0 : 1, timedOut: false, tooLarge: false, failed: false };
    },
  };
  try {
    const setup = new SetupController({
      client,
      open: async () => opened,
      confirm: async () => true,
      stopPrograms: () => {},
    });
    await client.start({ resume: false });
    await setup.look();
    expect(setup.current.look?.outcome).toBe("running");
    await exercise(setup);
  } finally {
    client.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Whether any Connect frame the gateway received carried this mode's credential. */
function sentCredential(gateway: FakeGateway, mode: "bootstrap" | "saved-token"): boolean {
  return gateway.connects.some((params) => {
    const { auth } = params as { auth?: { bootstrapToken?: string; deviceToken?: string } };
    return mode === "bootstrap" ? auth?.bootstrapToken === CODE : auth?.deviceToken === TOKEN;
  });
}

describe("the setup socket's listener, read again before its credential", () => {
  for (const mode of ["bootstrap", "saved-token"] as const) {
    it(`F-492: another process listening as the setup socket opens sends no credential (${mode})`, async () => {
      const gateway = new FakeGateway();
      const storage = memoryStorage(mode === "saved-token" ? { [tokenKey(URL)]: READ_TOKEN } : {});
      const host = testHost(gateway, storage);
      const listener = { pid: 4242 };
      // Between the look's last check and the open: the port is another process's now, while
      // the process the look found is still alive with its own start time.
      host.createWebSocket = (url) => {
        listener.pid = 5555;
        return gateway.createWebSocket(url);
      };
      const client = makeClient(gateway, storage, host);
      await withLocalSetup(
        client,
        async (setup) => {
          await setup.connect();
          await until(() => gateway.connects.length > 0 || setup.current.phase === "failed");
          expect(gateway.sockets.length).toBeGreaterThan(0);
          expect(sentCredential(gateway, mode)).toBe(false);
          expect(gateway.connects).toHaveLength(0);
          expect(setup.current.failure?.kind).toBe("changed");
        },
        listener,
      );
    });

    it(`F-492: another process listening once the socket is open sends no credential (${mode})`, async () => {
      const gateway = new FakeGateway();
      const storage = memoryStorage(mode === "saved-token" ? { [tokenKey(URL)]: READ_TOKEN } : {});
      const host = testHost(gateway, storage);
      const listener = { pid: 4242 };
      // Between the open and the first frame with a credential: the request is being signed.
      const sign = host.signer.sign;
      host.signer = {
        ...host.signer,
        sign: async (payload) => {
          listener.pid = 5555;
          return sign(payload);
        },
      };
      const client = makeClient(gateway, storage, host);
      await withLocalSetup(
        client,
        async (setup) => {
          await setup.connect();
          await until(() => gateway.connects.length > 0 || setup.current.phase === "failed");
          expect(sentCredential(gateway, mode)).toBe(false);
          expect(gateway.connects).toHaveLength(0);
          expect(setup.current.failure?.kind).toBe("changed");
        },
        listener,
      );
    });
  }

  it("F-492: with the same listener throughout, the setup credential goes and the app opens", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({ ok: true, payload: helloOk(SCOPES, TOKEN) });
    const client = makeClient(gateway);
    await withLocalSetup(client, async (setup) => {
      await setup.connect();
      await until(() => setup.current.phase === "done");
      expect(sentCredential(gateway, "bootstrap")).toBe(true);
    });
  });
});

describe("a refusal on reopening a gateway set up here", () => {
  it("F-492: a code the protocol doesn't name is published as the client's own", async () => {
    const gateway = new FakeGateway();
    const storage = memoryStorage();
    gateway.connectReply = () => ({ ok: true, payload: helloOk(SCOPES, TOKEN) });
    const first = makeClient(gateway, storage);
    await withLocalSetup(first, async (setup) => {
      await setup.connect();
      await until(() => setup.current.phase === "done");
      expect(storage.data.has("connection")).toBe(true);
    });
    // The ordinary connection to the saved gateway; the refusal carries the token as its code.
    gateway.connectReply = () => ({
      ok: false,
      error: { code: "INVALID_REQUEST", message: "Fixture refusal", details: { code: TOKEN } },
    });
    const restarted = makeClient(gateway, storage);
    const snapshots: string[] = [];
    const unsubscribe = restarted.store.subscribe((state) => {
      snapshots.push(JSON.stringify(state.connection));
    });
    try {
      await restarted.start();
      await until(() => Boolean(restarted.state.connection.error));
      expect(snapshots.some((snapshot) => snapshot.includes(TOKEN))).toBe(false);
      expect(restarted.state.connection.error?.code).toBe("CONNECT_REFUSED");
    } finally {
      unsubscribe();
      restarted.stop();
    }
  });
});

describe("Back, when closing setup's connection fails", () => {
  it("F-492: the failure is said, the connection stays setup's, and Back tries again", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({ ok: true, payload: helloOk(SCOPES, TOKEN) });
    const bots = deferred<object>();
    gateway.handlers["agents.list"] = () => bots.promise;
    const firstDelete = deferred<void>();
    const storage = memoryStorage();
    const remove = storage.delete;
    const deleteSetting = vi.fn(async (key: string) => {
      if (key === "connection" && deleteSetting.mock.calls.length === 1) await firstDelete.promise;
      return remove(key);
    });
    const confirm = vi.fn(async () => true);
    const client = makeClient(gateway, { ...storage, delete: deleteSetting });
    await withLocalSetup(client, async (setup) => {
      (setup as unknown as { options: { confirm: typeof confirm } }).options.confirm = confirm;
      await setup.connect();
      await until(() => gateway.calls("agents.list").length > 0);
      expect(storage.data.has("connection")).toBe(true);
      setup.cancel();
      await until(() => deleteSetting.mock.calls.length === 1);
      // While that cleanup is under way the screen stays as it was: no card to Connect from yet.
      expect(setup.current.phase).toBe("connecting");
      await expect(setup.connect()).rejects.toThrow(/nothing to connect to/);
      firstDelete.reject(new Error("fixture settings write failed"));
      await until(() => setup.current.phase === "failed");
      expect(setup.current.failure?.kind).toBe("cleanup");
      expect(deleteSetting).toHaveBeenCalledTimes(1);
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(client.state.connection.status).not.toBe("idle");
      setup.cancel();
      await until(() => client.state.connection.status === "idle");
      expect(gateway.sockets.every((socket) => socket.readyState === 3)).toBe(true);
      expect(storage.data.has("connection")).toBe(false);
      expect(setup.current.phase).toBe("found");
    });
  });

  it("F-492: Connect after a failed cleanup closes setup's connection first, or starts nothing", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({ ok: true, payload: helloOk(SCOPES, TOKEN) });
    const bots = deferred<object>();
    gateway.handlers["agents.list"] = () => bots.promise;
    const storage = memoryStorage();
    const remove = storage.delete;
    let failing = true;
    const deleteSetting = vi.fn(async (key: string) => {
      if (key === "connection" && failing) throw new Error("fixture settings write failed");
      return remove(key);
    });
    const confirm = vi.fn(async () => true);
    const client = makeClient(gateway, { ...storage, delete: deleteSetting });
    await withLocalSetup(client, async (setup) => {
      (setup as unknown as { options: { confirm: typeof confirm } }).options.confirm = confirm;
      await setup.connect();
      await until(() => gateway.calls("agents.list").length > 0);
      setup.cancel();
      await until(() => setup.current.phase === "failed");
      const sockets = gateway.sockets.length;
      // Still failing: Connect asks nothing and opens nothing.
      await setup.connect();
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(gateway.sockets).toHaveLength(sockets);
      expect(setup.current.failure?.kind).toBe("cleanup");
      // Closed this time: Connect goes on to its dialog. The first connection's hello saved a
      // device token, a pairing the person hasn't agreed to reuse, so the card asks for that.
      failing = false;
      await setup.connect();
      expect(confirm).toHaveBeenCalledTimes(2);
      expect(client.state.connection.status).toBe("idle");
      expect(storage.data.has("connection")).toBe(false);
      expect(gateway.sockets.every((socket) => socket.readyState === 3)).toBe(true);
      expect(setup.current.phase).toBe("found");
      expect(setup.current.look?.access).toBe("paired");
    });
  });
});

describe("two Connects that wait for the same cleanup", () => {
  it("F-492: only one reaches the dialog once the shared cleanup closes setup's connection", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({ ok: true, payload: helloOk(SCOPES, TOKEN) });
    const bots = deferred<object>();
    gateway.handlers["agents.list"] = () => bots.promise;
    const storage = memoryStorage();
    const remove = storage.delete;
    let failing = true;
    const closing = deferred<void>();
    const deleteSetting = vi.fn(async (key: string) => {
      if (key === "connection" && failing) throw new Error("fixture settings write failed");
      if (key === "connection") await closing.promise;
      return remove(key);
    });
    const confirm = vi.fn(async () => true);
    const client = makeClient(gateway, { ...storage, delete: deleteSetting });
    await withLocalSetup(client, async (setup) => {
      (setup as unknown as { options: { confirm: typeof confirm } }).options.confirm = confirm;
      await setup.connect();
      await until(() => gateway.calls("agents.list").length > 0);
      setup.cancel();
      await until(() => setup.current.failure?.kind === "cleanup");
      // Connect pressed twice: both wait for the one cleanup, which then succeeds.
      failing = false;
      const first = setup.connect();
      const second = setup.connect();
      await until(() => deleteSetting.mock.calls.length === 2);
      closing.resolve();
      await Promise.all([first, second]);
      expect(deleteSetting).toHaveBeenCalledTimes(2);
      expect(confirm).toHaveBeenCalledTimes(2);
    });
  });
});

describe("a saved pairing that went or came after the person agreed", () => {
  it("F-492: a pairing gone at the handshake sends nothing and goes back to the card for a new pairing", async () => {
    const gateway = new FakeGateway();
    const storage = memoryStorage({ [tokenKey(URL)]: READ_TOKEN });
    const host = testHost(gateway, storage);
    host.createWebSocket = (url) => {
      storage.data.delete(tokenKey(URL));
      return gateway.createWebSocket(url);
    };
    const client = makeClient(gateway, storage, host);
    await withLocalSetup(client, async (setup) => {
      expect(setup.current.look?.access).toBe("paired");
      await setup.connect();
      await until(() => setup.current.phase === "found" && setup.current.look?.access === "new");
      expect(gateway.connects).toHaveLength(0);
      // What the first screen renders from (packages/ui/test/connect-screen-setup.test.ts).
      expect(client.state.connection.error?.code).toBe("SETUP_PAIRING_GONE");
    });
  });

  it("F-492: a pairing that appeared after the Pair dialog goes back to the card, for consent to reuse it", async () => {
    const gateway = new FakeGateway();
    const storage = memoryStorage();
    const client = makeClient(gateway, storage);
    const hasDeviceToken = client.hasDeviceToken.bind(client);
    let reads = 0;
    client.hasDeviceToken = (url) => {
      // The look reads first; the second read is Connect's, after the dialog.
      if (++reads === 2) storage.data.set(tokenKey(URL), READ_TOKEN);
      return hasDeviceToken(url);
    };
    await withLocalSetup(client, async (setup) => {
      expect(setup.current.look?.access).toBe("new");
      await setup.connect();
      expect(gateway.sockets).toHaveLength(0);
      expect(setup.current.phase).toBe("found");
      expect(setup.current.look?.access).toBe("paired");
    });
  });

  it("F-492: a pairing that appeared at the handshake sends neither credential, and the card asks again", async () => {
    const gateway = new FakeGateway();
    const storage = memoryStorage();
    const host = testHost(gateway, storage);
    host.createWebSocket = (url) => {
      storage.data.set(tokenKey(URL), READ_TOKEN);
      return gateway.createWebSocket(url);
    };
    const client = makeClient(gateway, storage, host);
    await withLocalSetup(client, async (setup) => {
      expect(setup.current.look?.access).toBe("new");
      await setup.connect();
      await until(
        () =>
          gateway.connects.length > 0 ||
          (setup.current.phase === "found" && setup.current.look?.access === "paired"),
      );
      expect(gateway.connects).toHaveLength(0);
      expect(setup.current.phase).toBe("found");
      expect(setup.current.look?.access).toBe("paired");
      expect(client.state.connection.error?.code).toBe("SETUP_PAIRING_APPEARED");
      expect(JSON.stringify(client.state)).not.toContain(CODE);
    });
  });
});
