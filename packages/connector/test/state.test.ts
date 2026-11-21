import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePhones, PHONES_FILE } from "../src/allowlist.ts";
import { CONFIG_FILE, KEYS_FILE, loadKeys, newKeys, parseConfig } from "../src/config.ts";
import type { StateError } from "../src/state.ts";
import { checkNotOpenclawFolder, StateDir } from "../src/state.ts";
import { tempRoot } from "./helpers.ts";

let root: string;
let cleanup: () => void;
beforeEach(() => ({ root, cleanup } = tempRoot()));
afterEach(() => cleanup());

const codeOf = (action: () => unknown): string | undefined => {
  try {
    action();
  } catch (error) {
    return (error as StateError).code;
  }
  return undefined;
};

describe("the state folder", () => {
  it("is created owner-only, and every file is written owner-only", () => {
    const state = StateDir.create(join(root, "state"));
    state.write(KEYS_FILE, newKeys());
    expect(statSync(state.path).mode & 0o777).toBe(0o700);
    expect(statSync(state.file(KEYS_FILE)).mode & 0o777).toBe(0o600);
  });

  it("writes atomically: the old file stays whole when a write fails, and nothing is left beside it", () => {
    const state = StateDir.create(join(root, "state"));
    state.write(PHONES_FILE, { v: 1, phones: [], offers: [] });
    const before = readFileSync(state.file(PHONES_FILE), "utf8");
    // A value JSON cannot write fails before the rename.
    expect(() => state.write(PHONES_FILE, { v: 1, big: 1n })).toThrow();
    expect(readFileSync(state.file(PHONES_FILE), "utf8")).toBe(before);
    expect(readdirSync(state.path).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("replaces a file whole: a reader sees the old or the new content, never a mix", () => {
    const state = StateDir.create(join(root, "state"));
    state.write(PHONES_FILE, { v: 1, phones: [], offers: [] });
    const inode = statSync(state.file(PHONES_FILE)).ino;
    state.write(PHONES_FILE, { v: 1, phones: [], offers: [] });
    // A rename puts a new file in place; an in-place rewrite would keep the inode.
    expect(statSync(state.file(PHONES_FILE)).ino).not.toBe(inode);
  });

  it("refuses a corrupt file and leaves it as it is", () => {
    const state = StateDir.create(join(root, "state"));
    writeFileSync(state.file(KEYS_FILE), "{not json", { mode: 0o600 });
    expect(codeOf(() => loadKeys(state))).toBe("corrupt");
    expect(readFileSync(state.file(KEYS_FILE), "utf8")).toBe("{not json");

    writeFileSync(
      state.file(PHONES_FILE),
      JSON.stringify({ v: 1, phones: [], offers: [], extra: 1 }),
      { mode: 0o600 },
    );
    expect(codeOf(() => state.read(PHONES_FILE, parsePhones))).toBe("corrupt");
    writeFileSync(state.file(PHONES_FILE), JSON.stringify({ v: 2, phones: [], offers: [] }), {
      mode: 0o600,
    });
    expect(codeOf(() => state.read(PHONES_FILE, parsePhones))).toBe("corrupt");
    writeFileSync(
      state.file(PHONES_FILE),
      JSON.stringify({ v: 1, phones: [{ key: "short", label: "x", addedAtMs: 1 }], offers: [] }),
      { mode: 0o600 },
    );
    expect(codeOf(() => state.read(PHONES_FILE, parsePhones))).toBe("corrupt");
    writeFileSync(
      state.file(CONFIG_FILE),
      JSON.stringify({
        v: 1,
        relayOrigin: "wss://Relay.example/",
        gatewayPort: 1,
        openclaw: { bin: "o", profile: null },
      }),
      { mode: 0o600 },
    );
    expect(codeOf(() => state.read(CONFIG_FILE, parseConfig))).toBe("corrupt");
  });

  it("refuses a file others can read, a link, and a folder others can read", () => {
    const state = StateDir.create(join(root, "state"));
    state.write(KEYS_FILE, newKeys());
    chmodSync(state.file(KEYS_FILE), 0o644);
    expect(codeOf(() => loadKeys(state))).toBe("unsafe");
    chmodSync(state.file(KEYS_FILE), 0o600);

    writeFileSync(join(root, "elsewhere.json"), JSON.stringify(newKeys()), { mode: 0o600 });
    symlinkSync(join(root, "elsewhere.json"), state.file("keys-link.json"));
    expect(codeOf(() => state.read("keys-link.json", (v) => v))).toBe("unsafe");

    chmodSync(state.path, 0o755);
    expect(codeOf(() => StateDir.open(state.path))).toBe("unsafe");
  });

  it("is never inside an OpenClaw folder", () => {
    for (const name of [".openclaw", ".openclaw-dev", ".openclaw-clawtrate-dev-x", ".OpenClaw"]) {
      expect(codeOf(() => checkNotOpenclawFolder(join(root, name, "connector")))).toBe(
        "openclaw_folder",
      );
      expect(codeOf(() => StateDir.create(join(root, name, "connector")))).toBe("openclaw_folder");
    }
    // Through a link, too.
    mkdirSync(join(root, ".openclaw-profile"));
    symlinkSync(join(root, ".openclaw-profile"), join(root, "innocent"));
    expect(codeOf(() => checkNotOpenclawFolder(join(root, "innocent", "connector")))).toBe(
      "openclaw_folder",
    );
    // And inside the state folder OpenClaw's environment names.
    const env = { OPENCLAW_STATE_DIR: join(root, "gateway-state") };
    expect(codeOf(() => checkNotOpenclawFolder(join(root, "gateway-state", "c"), env))).toBe(
      "openclaw_folder",
    );
    expect(codeOf(() => checkNotOpenclawFolder(join(root, "connector"), env))).toBeUndefined();
  });

  it("serializes writers with its lock, and takes over a lock its holder abandoned", () => {
    const state = StateDir.create(join(root, "state"));
    const lock = state.file(".lock");
    writeFileSync(lock, "12345\n", { mode: 0o600 });
    const started = Date.now();
    expect(codeOf(() => state.withLock(() => 1))).toBe("busy");
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_900);
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(lock, old, old);
    expect(state.withLock(() => 7)).toBe(7);
    expect(() => statSync(lock)).toThrow();
  });
});
