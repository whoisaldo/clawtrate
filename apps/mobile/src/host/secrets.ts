// The credentials this host holds for core: the gateway's bootstrap token in the
// saved connection and every device token. They are learned as core stores and
// reads them, and scrubbed from every string the host logs or a screen shows,
// whatever the gateway sent back: a gateway that received a token can echo it in
// an error, a hint or a message.

import type { KeyValueStore } from "@clawtrate/core";

export const REDACTED = "•••";

export type Secrets = {
  /** Learn the credentials inside a value core stores under `key`. */
  learn(key: string, value: string | null): void;
  /** Any credential this host holds, replaced. */
  redact(text: string): string;
};

function tokensIn(key: string, value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const record = parsed as Record<string, unknown>;
  // The saved connection carries the bootstrap token; a token record its device token.
  if (key === "connection" || key.startsWith("deviceToken:")) {
    return typeof record.token === "string" ? [record.token] : [];
  }
  return [];
}

export function createSecrets(): Secrets {
  const known = new Set<string>();
  return {
    learn(key, value) {
      if (value === null) return;
      for (const token of tokensIn(key, value)) if (token !== "") known.add(token);
    },
    redact(text) {
      let out = text;
      for (const secret of [...known].sort((a, b) => b.length - a.length))
        if (out.includes(secret)) out = out.split(secret).join(REDACTED);
      return out;
    },
  };
}

/** Core's store, learning every credential that passes through it, read or written. */
export function learningStore(store: KeyValueStore, secrets: Secrets): KeyValueStore {
  return {
    get: async (key) => {
      const value = await store.get(key);
      secrets.learn(key, value);
      return value;
    },
    set: async (key, value) => {
      secrets.learn(key, value);
      await store.set(key, value);
    },
    delete: (key) => store.delete(key),
  };
}
