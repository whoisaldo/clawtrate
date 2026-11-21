// `pnpm mobile:check` stopped by a signal before it starts the driver: nothing is
// spawned, and only its own device and instance are removed. Every subprocess,
// file and socket is a mock; no Simulator, gateway or process is touched.
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => {
  const device = "41D5162E-6110-4853-98C5-0B53076DE619";
  const devices = JSON.stringify({
    devices: {
      runtime: [{ udid: device, name: "Clawtrate checks 111111111111", state: "Booted" }],
    },
  });
  const runtimes = JSON.stringify({
    runtimes: [
      {
        identifier: "SimRuntime.iOS.test",
        version: "27",
        isAvailable: true,
        supportedDeviceTypes: [{ name: "iPhone 17", identifier: "test-phone" }],
      },
    ],
  });
  return {
    device,
    execFileSync: vi.fn((_command: string, args: string[]) => {
      if (args[0] === "-o") return "Thu Nov 19 08:20:00 2026";
      if (args[1] === "list" && args[2] === "runtimes") return runtimes;
      if (args[1] === "list" && args[2] === "devices") return devices;
      if (args[1] === "create") return device;
      return "";
    }),
    spawn: vi.fn(),
    spawnSync: vi.fn(() => ({ status: 0, stderr: "" })),
  };
});

vi.mock("node:child_process", () => ({
  execFileSync: io.execFileSync,
  spawnSync: io.spawnSync,
  spawn: io.spawn,
}));
vi.mock("node:fs", () => ({
  existsSync: () => true,
  readdirSync: () => [],
  readFileSync: () => {
    throw new Error("No earlier run");
  },
  writeFileSync: () => {},
  renameSync: () => {},
  rmSync: () => {},
}));
vi.mock("node:crypto", () => ({ randomBytes: () => Buffer.alloc(24, 0x11) }));
// The loopback port for the driver's settings: the signal comes while it closes.
vi.mock("node:net", () => ({
  createServer: () => ({
    listen: (_port: number, host: string, done: () => void) => {
      expect(host).toBe("127.0.0.1");
      done();
    },
    address: () => ({ port: 47000 }),
    close: (done: () => void) => {
      process.emit("SIGINT", "SIGINT");
      done();
    },
  }),
}));
vi.mock("../../desktop/src/host/runtime.ts", () => ({
  readDevConnection: () => ({ url: "ws://127.0.0.1:47001", token: "check-signal-token" }),
}));
vi.mock("../scripts/build.ts", () => ({
  APP_PATH: "/check-signal/Clawtrate.app",
  BUILD_DIR: "/check-signal/build",
  BUNDLE_ID: "dev.clawtrate.mobile",
}));
vi.mock("../scripts/xcode.ts", () => ({ findDeveloperDir: () => "/check-signal/Xcode" }));

import { main } from "../scripts/check.ts";

describe("the Simulator check stopped early", () => {
  it("starts no driver after a SIGINT that comes while it finds its loopback port, and removes only its own device and instance", async () => {
    vi.stubEnv("JAVA_HOME", "/check-signal/java");
    const before = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
    io.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      setImmediate(() => child.emit("exit", 0));
      return child;
    });
    try {
      expect(await main()).toBe(130);
      expect(io.spawn).not.toHaveBeenCalled();
      expect(io.spawnSync.mock.calls.map((call) => (call as unknown[]).slice(0, 2))).toEqual([
        [process.execPath, expect.arrayContaining(["start", "--instance", "ios-111111111111"])],
        ["xcrun", ["simctl", "shutdown", io.device]],
        ["xcrun", ["simctl", "delete", io.device]],
        [process.execPath, expect.arrayContaining(["reset", "--instance", "ios-111111111111"])],
      ]);
    } finally {
      for (const signal of ["SIGINT", "SIGTERM"] as const)
        for (const listener of process.listeners(signal))
          if (!before[signal].includes(listener)) process.removeListener(signal, listener);
      vi.unstubAllEnvs();
    }
  });
});
