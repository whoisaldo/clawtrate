// Recording, setting, verifying and restoring `gateway.trustedProxies`, against a config
// stand-in that applies OpenClaw's conditional writes, and the command lines the connector
// sends OpenClaw's `config`.

import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenclawRunner } from "../src/openclaw.ts";
import { StateDir } from "../src/state.ts";
import {
  enableTrustedProxies,
  openclawProxiesConfig,
  readProxiesRecord,
  restoreTrustedProxies,
  type ProxiesConfig,
  type ProxiesValue,
} from "../src/trusted-proxies.ts";
import { tempRoot } from "./helpers.ts";

/** A gateway config holding one setting, with `--expect-current-*` semantics. */
class ConfigStandIn implements ProxiesConfig {
  value: ProxiesValue;
  writes = 0;
  /** Set to make writes appear to succeed without changing anything. */
  ignoreWrites = false;

  constructor(value: ProxiesValue) {
    this.value = value;
  }

  async read(): Promise<ProxiesValue> {
    return this.value.present
      ? { present: true, value: [...this.value.value] }
      : { present: false };
  }

  async write(value: readonly string[], expect: ProxiesValue): Promise<void> {
    const same = JSON.stringify(expect) === JSON.stringify(this.value);
    if (!same) throw new Error("expectation mismatch; nothing saved");
    this.writes++;
    if (!this.ignoreWrites) this.value = { present: true, value: [...value] };
  }

  async remove(): Promise<void> {
    if (!this.value.present) throw new Error("absent");
    this.writes++;
    if (!this.ignoreWrites) this.value = { present: false };
  }
}

let cleanup: () => void;
let state: StateDir;
beforeEach(() => {
  let root: string;
  ({ root, cleanup } = tempRoot());
  state = StateDir.create(join(root, "state"));
});
afterEach(() => cleanup());

describe("gateway.trustedProxies", () => {
  it("absent: records absent, sets loopback, verifies, and on teardown removes it again", async () => {
    const config = new ConfigStandIn({ present: false });
    const record = await enableTrustedProxies(state, config);
    expect(record).toEqual({
      earlier: { present: false },
      applied: ["127.0.0.1", "::1"],
      changed: true,
    });
    expect(config.value).toEqual({ present: true, value: ["127.0.0.1", "::1"] });
    expect(readProxiesRecord(state)).toEqual(record);
    expect(await restoreTrustedProxies(state, config)).toBe("restored");
    expect(config.value).toEqual({ present: false });
    expect(readProxiesRecord(state)).toBeNull();
  });

  it("an earlier list: sets the union, and teardown restores the exact earlier list, order included", async () => {
    const earlier = ["::1", "198.51.100.0/24"];
    const config = new ConfigStandIn({ present: true, value: earlier });
    const record = await enableTrustedProxies(state, config);
    expect(record.applied).toEqual(["::1", "198.51.100.0/24", "127.0.0.1"]);
    expect(config.value).toEqual({ present: true, value: record.applied });
    expect(await restoreTrustedProxies(state, config)).toBe("restored");
    expect(config.value).toEqual({ present: true, value: earlier });
  });

  it("an empty earlier list comes back empty, not absent", async () => {
    const config = new ConfigStandIn({ present: true, value: [] });
    await enableTrustedProxies(state, config);
    expect(await restoreTrustedProxies(state, config)).toBe("restored");
    expect(config.value).toEqual({ present: true, value: [] });
  });

  it("already covering loopback: writes nothing, and teardown changes nothing", async () => {
    const config = new ConfigStandIn({ present: true, value: ["127.0.0.1", "::1"] });
    const record = await enableTrustedProxies(state, config);
    expect(record.changed).toBe(false);
    expect(config.writes).toBe(0);
    expect(await restoreTrustedProxies(state, config)).toBe("unchanged");
    expect(config.value).toEqual({ present: true, value: ["127.0.0.1", "::1"] });
  });

  it("setup again is idempotent, and refuses when someone changed the setting meanwhile", async () => {
    const config = new ConfigStandIn({ present: false });
    await enableTrustedProxies(state, config);
    await enableTrustedProxies(state, config);
    expect(config.writes).toBe(1);
    config.value = { present: true, value: ["127.0.0.1"] };
    await expect(enableTrustedProxies(state, config)).rejects.toThrow(/changed after/);
  });

  it("does not overwrite a value someone else set, and keeps the record", async () => {
    const config = new ConfigStandIn({ present: false });
    await enableTrustedProxies(state, config);
    config.value = { present: true, value: ["127.0.0.1", "::1", "203.0.113.0/24"] };
    await expect(restoreTrustedProxies(state, config)).rejects.toThrow(/did not set/);
    expect(config.value).toEqual({ present: true, value: ["127.0.0.1", "::1", "203.0.113.0/24"] });
    expect(readProxiesRecord(state)).not.toBeNull();
  });

  it("never infers success from a write: a value that does not read back fails, and the record stays", async () => {
    const config = new ConfigStandIn({ present: false });
    config.ignoreWrites = true;
    await expect(enableTrustedProxies(state, config)).rejects.toThrow(/reads back as absent/);
    expect(readProxiesRecord(state)?.earlier).toEqual({ present: false });

    const restoring = new ConfigStandIn({ present: true, value: ["::1"] });
    const fresh = StateDir.create(join(state.path, "..", "second"));
    await enableTrustedProxies(fresh, restoring);
    restoring.ignoreWrites = true;
    await expect(restoreTrustedProxies(fresh, restoring)).rejects.toThrow(/reads back/);
    expect(readProxiesRecord(fresh)).not.toBeNull();
  });

  it("leaves a value that is not a list of addresses alone", async () => {
    const run: OpenclawRunner = async () => ({
      status: 0,
      stdout: '{"port":1,"trustedProxies":"127.0.0.1"}',
      stderr: "",
    });
    await expect(openclawProxiesConfig(run).read()).rejects.toThrow(/not a list/);
    await expect(enableTrustedProxies(state, openclawProxiesConfig(run))).rejects.toThrow(
      /not a list/,
    );
    expect(readProxiesRecord(state)).toBeNull();
  });
});

describe("through OpenClaw's command line", () => {
  it("reads the gateway section, and writes conditionally on what it read", async () => {
    const calls: string[][] = [];
    let gateway: Record<string, unknown> = {
      port: 19_999,
      auth: { mode: "token", token: "__REDACTED__" },
    };
    const run: OpenclawRunner = async (args) => {
      calls.push(args);
      if (args[1] === "get")
        return { status: 0, stdout: `[plugins] loaded\n${JSON.stringify(gateway)}\n`, stderr: "" };
      if (args[1] === "set") gateway = { ...gateway, trustedProxies: JSON.parse(args[3]!) };
      if (args[1] === "unset") {
        const { trustedProxies: _dropped, ...rest } = gateway;
        gateway = rest;
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    const config = openclawProxiesConfig(run);
    await enableTrustedProxies(state, config);
    expect(calls).toEqual([
      ["config", "get", "gateway", "--json"],
      [
        "config",
        "set",
        "gateway.trustedProxies",
        '["127.0.0.1","::1"]',
        "--strict-json",
        "--expect-current-absent",
      ],
      ["config", "get", "gateway", "--json"],
    ]);
    calls.length = 0;
    await restoreTrustedProxies(state, config);
    expect(calls).toEqual([
      ["config", "get", "gateway", "--json"],
      ["config", "unset", "gateway.trustedProxies"],
      ["config", "get", "gateway", "--json"],
    ]);

    gateway = { port: 1, trustedProxies: ["::1"] };
    calls.length = 0;
    await enableTrustedProxies(state, config);
    expect(calls[1]).toEqual([
      "config",
      "set",
      "gateway.trustedProxies",
      '["::1","127.0.0.1"]',
      "--strict-json",
      "--expect-current-json",
      '["::1"]',
    ]);
  });

  it("fails closed when OpenClaw fails", async () => {
    const run: OpenclawRunner = async () => ({
      status: 1,
      stdout: '{"ok":false,"error":{"type":"cli_error","message":"x"}}',
      stderr: "",
    });
    await expect(enableTrustedProxies(state, openclawProxiesConfig(run))).rejects.toThrow(/failed/);
    expect(readProxiesRecord(state)).toBeNull();
  });
});
