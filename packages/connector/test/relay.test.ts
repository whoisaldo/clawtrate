// The running connector against the relay's own Node runner (services/relay), on 127.0.0.1:
// it registers its relay id, answers dials, enrolls a phone with a pairing code's secret, and
// bridges it to a gateway stand-in; a phone it does not know is refused with no gateway
// connection; a removed phone is cut off; the link comes back after the relay restarts.

import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startRelayServer, type RelayServer } from "../../../services/relay/src/node/server.ts";
import { addOffer, removePhones } from "../src/allowlist.ts";
import { ConnectorDaemon, parseStatus, STATUS_FILE } from "../src/daemon.ts";
import type { StateDir } from "../src/state.ts";
import { FakeGateway, keysOf, Phone, setUpState, tempRoot, waitFor } from "./helpers.ts";

let cleanup: () => void;
let relay: RelayServer;
let gateway: FakeGateway;
let state: StateDir;
let daemon: ConnectorDaemon;
const opened: WebSocket[] = [];

beforeEach(async () => {
  let root: string;
  ({ root, cleanup } = tempRoot());
  relay = await startRelayServer({ host: "127.0.0.1", port: 0 });
  gateway = await new FakeGateway().start();
  gateway.reply = (text) => `gateway:${text}`;
  state = setUpState(root, relay.origin, gateway.port);
  daemon = new ConnectorDaemon({ state });
  daemon.start();
  await waitFor("registration", () => daemon.supervisorState === "registered");
});
afterEach(async () => {
  daemon.stop();
  for (const socket of opened) socket.terminate();
  opened.length = 0;
  await relay.close();
  await gateway.close();
  cleanup();
});

/** A phone dialing the relay; the handshake starts once the relay says `open`. */
async function dialFrom(phone: Phone): Promise<void> {
  const socket = new WebSocket(`${relay.url}/v1/dial/${daemon.relayId}`, {
    perMessageDeflate: false,
  });
  opened.push(socket);
  phone.attach(socket);
  await waitFor("the splice", () => phone.relayMessages.includes('{"t":"open"}'));
  phone.start();
}

function enrolledPhone(label = "Test phone"): Phone {
  const keys = keysOf(state);
  const secret = crypto.getRandomValues(new Uint8Array(32));
  addOffer(state, { secret, expiresAtMs: Date.now() + 600_000, label }, Date.now());
  return new Phone({ relayId: keys.relayId, connectorKey: keys.noise.publicKey, enroll: secret });
}

describe("the connector through the relay's Node runner", () => {
  it("registers, enrolls a phone, and carries a message round trip with X-Forwarded-For", async () => {
    const phone = enrolledPhone();
    await dialFrom(phone);
    await waitFor("admission", () => phone.opened);
    phone.send('{"type":"req","id":"1","method":"health"}');
    await waitFor("the answer", () => phone.texts.length === 1);
    expect(phone.texts).toEqual(['gateway:{"type":"req","id":"1","method":"health"}']);
    expect(gateway.upgrades).toHaveLength(1);
    // The relay reported 127.0.0.1, which is never forwarded.
    expect(gateway.upgrades[0]!["x-forwarded-for"]).toBe("192.0.2.1");
    const status = state.read(STATUS_FILE, parseStatus)!;
    expect(status).toMatchObject({
      state: "registered",
      relayId: daemon.relayId,
      sessions: 1,
      pid: process.pid,
    });
  });

  it("refuses a phone it does not know before the gateway sees a connection", async () => {
    const keys = keysOf(state);
    const stranger = new Phone({ relayId: keys.relayId, connectorKey: keys.noise.publicKey });
    await dialFrom(stranger);
    await waitFor("the refusal", () => stranger.refusal() !== null);
    expect(stranger.refusal()).toBe("not_enrolled");
    await waitFor("the session to end", () => daemon.sessions.size === 0);
    expect(gateway.connections).toBe(0);
  });

  it("ends a removed phone's session, and refuses it afterwards", async () => {
    const phone = enrolledPhone("Removable");
    await dialFrom(phone);
    await waitFor("admission", () => phone.opened);
    removePhones(state, "Removable", Date.now());
    await waitFor("the session to end", () => daemon.sessions.size === 0, 8_000);
    const keys = keysOf(state);
    const again = new Phone({
      relayId: keys.relayId,
      connectorKey: keys.noise.publicKey,
      key: phone.key,
    });
    await dialFrom(again);
    await waitFor("the refusal", () => again.refusal() !== null);
    expect(again.refusal()).toBe("not_enrolled");
  }, 15_000);

  it("registers again after the relay restarts on the same port", async () => {
    const port = relay.port;
    await relay.close();
    await waitFor("the link to drop", () => daemon.supervisorState !== "registered");
    relay = await startRelayServer({ host: "127.0.0.1", port });
    await waitFor("registration again", () => daemon.supervisorState === "registered", 10_000);
    const phone = enrolledPhone();
    await dialFrom(phone);
    await waitFor("admission", () => phone.opened);
  }, 15_000);
});
