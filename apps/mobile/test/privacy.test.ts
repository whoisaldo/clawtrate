import { describe, expect, it } from "vitest";
import { createSecrets, learningStore, REDACTED } from "../src/host/secrets.ts";

/** A plain in-memory store, as the Keychain store behaves. */
function memory() {
  const items = new Map<string, string>();
  return {
    get: async (key: string) => items.get(key) ?? null,
    set: async (key: string, value: string) => void items.set(key, value),
    delete: async (key: string) => void items.delete(key),
  };
}

describe("credentials never leave in a string the app shows or logs", () => {
  it("scrubs the bootstrap token and every device token from whatever the gateway sent back", async () => {
    const secrets = createSecrets();
    const store = learningStore(memory(), secrets);
    await store.set(
      "connection",
      JSON.stringify({ url: "ws://127.0.0.1:1", token: "bootstrap-secret-123" }),
    );
    await store.set(
      "deviceToken:ws%3A%2F%2F127.0.0.1%3A1:dev:operator",
      JSON.stringify({ token: "device-token-456789" }),
    );
    const echoed =
      "Refused bootstrap-secret-123 and device-token-456789; try bootstrap-secret-123 again.";
    expect(secrets.redact(echoed)).toBe(
      `Refused ${REDACTED} and ${REDACTED}; try ${REDACTED} again.`,
    );
    expect(secrets.redact("Nothing answered at 127.0.0.1:1.")).toBe(
      "Nothing answered at 127.0.0.1:1.",
    );
  });

  it("learns a token kept from an earlier launch as soon as it is read", async () => {
    const inner = memory();
    await inner.set("deviceToken:x:dev:operator", JSON.stringify({ token: "kept-from-before-1" }));
    const secrets = createSecrets();
    const store = learningStore(inner, secrets);
    expect(secrets.redact("kept-from-before-1")).toBe("kept-from-before-1");
    await store.get("deviceToken:x:dev:operator");
    expect(secrets.redact("kept-from-before-1")).toBe(REDACTED);
  });

  it("ignores values that are not credentials", async () => {
    const secrets = createSecrets();
    secrets.learn("roster:gateway:x", JSON.stringify({ token: "notasecretbutlong" }));
    secrets.learn("connection", "not json");
    expect(secrets.redact("notasecretbutlong")).toBe("notasecretbutlong");
  });
});
