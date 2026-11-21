// The registration store's contract (`fixtures/registration-contract.ts`) on both runtimes: on
// Node over the runner's `NodeSocket`, and in workerd over the Durable Object's hibernatable
// sockets and their attachments, run inside the object through the Worker fixture.

import { toBase64Url } from "@clawtrate/relay-protocol";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NodeSocket } from "../src/node/server.ts";
import {
  CONTRACT_CASES,
  runRegistrationContract,
  type ContractInput,
  type ContractResult,
} from "./fixtures/registration-contract.ts";
import { connectorKey, RUNTIMES, startRelay, type Relay } from "./support.ts";

function input(): ContractInput {
  const key = connectorKey();
  return { relayId: key.relayId, secretKey: toBase64Url(key.secretKey) };
}

describe.each(RUNTIMES)("the registration store on %s", (runtime) => {
  let results: ContractResult[] = [];
  let relay: Relay | null = null;

  beforeAll(async () => {
    if (runtime === "node") {
      // An open `ws` socket as the runner holds it; the store only reads and writes its state.
      const ws = { readyState: WebSocket.OPEN } as unknown as WebSocket;
      results = await runRegistrationContract({ socket: () => new NodeSocket(ws) }, input());
      return;
    }
    relay = await startRelay("worker");
    const response = await fetch(
      `${relay.url.replace("ws:", "http:")}/test/registration-contract`,
      { method: "POST", body: JSON.stringify(input()) },
    );
    expect(response.status).toBe(200);
    results = (await response.json()) as ContractResult[];
  });

  afterAll(async () => {
    await relay?.close();
  });

  it("runs every case", () => {
    expect(results.map((result) => result.name)).toEqual(CONTRACT_CASES);
  });

  it.each(CONTRACT_CASES)("%s", (name) => {
    expect(results.find((result) => result.name === name)?.error).toBeNull();
  });
});
