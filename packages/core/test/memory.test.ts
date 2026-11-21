// A memory write holds the gateway that supplied its draft: the identity is
// asked again at the write, so a held identity read across a reconnect cannot
// send a draft to a different gateway at the same address.

import { describe, expect, it } from "vitest";
import { ClawtrateClient } from "../src/client.ts";
import { FakeGateway, helloOk, memoryStorage, testHost, tokenKey, until } from "./fake-gateway.ts";

const URL = "ws://127.0.0.1:19001";
const FAST = { reconnect: { initialMs: 20, maxMs: 40 } };
const HELD = ["operator.read", "operator.write", "operator.admin"];
const hex = (n: number) => String(n).padStart(4, "0").repeat(16);

function memoryGateway(identity: () => string) {
  const gateway = new FakeGateway();
  gateway.connectReply = () => ({
    ok: true,
    payload: helloOk(HELD, "device-token"),
  });
  gateway.handlers["gateway.identity.get"] = () => ({ deviceId: identity() });
  gateway.handlers["agents.files.set"] = () => ({ ok: true });
  return gateway;
}

async function connected(identity: () => string) {
  const gateway = memoryGateway(identity);
  const storage = memoryStorage({
    connection: JSON.stringify({ url: URL, token: null }),
    [tokenKey(URL)]: JSON.stringify({
      token: "device-token",
      grantedScopes: HELD,
      heldScopes: HELD,
      adminHeld: true,
    }),
  });
  const client = new ClawtrateClient(testHost(gateway, storage), FAST);
  await client.start();
  await until(() => client.state.discovery.status === "ready");
  return { client, gateway };
}

describe("memory writes", () => {
  it("F-212: note edits and deletions stay read-only at the host", async () => {
    const { client, gateway } = await connected(() => "gw-one");
    try {
      for (const content of ["Updated note.", null]) {
        await expect(
          client.writeMemory("otto", "memory/meeting.md", "gw-one", hex(1), content),
        ).rejects.toThrow(/notes are read-only/i);
      }
      expect(
        gateway.requests.filter(({ method }) =>
          ["clawtrate-memory.write", "clawtrate-memory.delete"].includes(method),
        ),
      ).toHaveLength(0);
    } finally {
      client.stop();
    }
  });

  it("F-212: a draft held across a reconnect does not write to the gateway that now answers", async () => {
    let deviceId = "gw-one";
    const { client, gateway } = await connected(() => deviceId);
    // The gateway behind the address is replaced while the draft is held.
    deviceId = "gw-two";
    await expect(
      client.writeMemory("otto", "MEMORY.md", "gw-one", hex(1), "Saved text."),
    ).rejects.toThrow(/different gateway/);
    expect(gateway.requests.some(({ method }) => method === "agents.files.set")).toBe(false);
    // The same draft, re-opened against the gateway that now answers, writes.
    await client.writeMemory("otto", "MEMORY.md", "gw-two", hex(1), "Saved text.");
    expect(gateway.requests.some(({ method }) => method === "agents.files.set")).toBe(true);
    client.stop();
  });

  it("F-212: a write without a gateway identity, or with a failed identity read, is refused", async () => {
    const { client, gateway } = await connected(() => "gw-one");
    await expect(client.writeMemory("otto", "USER.md", null, null, "Saved text.")).rejects.toThrow(
      /different gateway/,
    );
    gateway.handlers["gateway.identity.get"] = () => {
      throw new Error("identity read lost");
    };
    await expect(
      client.writeMemory("otto", "USER.md", "gw-one", null, "Saved text."),
    ).rejects.toThrow("identity read lost");
    expect(gateway.requests.some(({ method }) => method === "agents.files.set")).toBe(false);
    client.stop();
  });
});
