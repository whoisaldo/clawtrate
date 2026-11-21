// The main process's startup with Electron replaced by a recorder: a packaged
// Windows app gives itself the bundle id as its AppUserModelID before it
// creates any window, so its taskbar button is the installer's shortcuts'
// from the first window on. Other platforms and development builds do not.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_ID } from "../src/main/identity.ts";

const recorded = vi.hoisted(() => ({
  calls: [] as string[],
  packaged: true,
  /** The data folders a refused start under the test runner chose. */
  userData: [] as string[],
}));

vi.mock("electron", () => {
  const { calls } = recorded;
  class BrowserWindow {
    static getAllWindows = () => [];
    static fromWebContents = () => null;
    webContents = { send() {} };
    constructor() {
      calls.push("window");
    }
    on() {
      return this;
    }
    once() {
      return this;
    }
    isDestroyed() {
      return false;
    }
    loadFile() {
      return Promise.resolve();
    }
    loadURL() {
      return Promise.resolve();
    }
  }
  const app = {
    get isPackaged() {
      return recorded.packaged;
    },
    setName: () => calls.push("setName"),
    enableSandbox: () => calls.push("enableSandbox"),
    setAppUserModelId: (id: string) => calls.push(`setAppUserModelId ${id}`),
    getAppPath: () => "/app",
    getVersion: () => "1.0.0",
    getPath: () => dataDir,
    setPath: (_name: string, path: string) => recorded.userData.push(path),
    whenReady: () => Promise.resolve(),
    on: () => app,
    requestSingleInstanceLock: () => true,
    quit() {},
    setBadgeCount() {},
  };
  return {
    app,
    BrowserWindow,
    // A data folder the launch refuses shows this and quits: recorded, so the test says why.
    dialog: { showErrorBox: (title: string) => calls.push(`showErrorBox ${title}`) },
    ipcMain: { handle() {}, on() {} },
    nativeImage: { createFromBitmap: () => ({}) },
    nativeTheme: { shouldUseDarkColors: false },
    session: {
      defaultSession: {
        webRequest: { onBeforeRequest() {} },
        setPermissionRequestHandler() {},
        setPermissionCheckHandler() {},
      },
    },
    shell: {},
  };
});

// The gateway client is not what this test is about: a runtime that holds nothing.
vi.mock("../src/host/runtime.ts", () => ({
  selectInstance: () => null,
  readDevConnection: () => null,
  startHostRuntime: () =>
    Promise.resolve({
      client: { state: {}, store: { subscribe: () => () => {} }, stop() {}, setSetup() {} },
      info: {},
      policy: {},
    }),
}));

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let dataDir: string;

beforeEach(() => {
  recorded.calls.length = 0;
  dataDir = mkdtempSync(join(tmpdir(), "clawtrate-startup-"));
  vi.stubEnv("CLAWTRATE_DATA_DIR", dataDir);
  vi.stubEnv("CLAWTRATE_SCREENSHOT", "");
  vi.resetModules();
});

afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
  for (const dir of recorded.userData.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Runs the main process's startup as `os`, packaged or not, until it has created its window. */
async function startUp(os: NodeJS.Platform, packaged: boolean): Promise<string[]> {
  Object.defineProperty(process, "platform", { ...platform, value: os });
  recorded.packaged = packaged;
  // The launch's own lines, so a refused data folder names its reason and the folder that failed.
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    await import("../src/main/index.ts");
    await vi.waitFor(() =>
      expect(
        recorded.calls,
        `${os}: ${lines.filter((l) => l.startsWith("[setup]")).join("; ")}`,
      ).toContain("window"),
    );
  } finally {
    log.mockRestore();
  }
  return [...recorded.calls];
}

describe("the AppUserModelID at startup", () => {
  it("is the bundle id in a packaged Windows app, set before any window is created", async () => {
    const calls = await startUp("win32", true);
    const set = calls.indexOf(`setAppUserModelId ${APP_ID}`);
    expect(set).toBeGreaterThanOrEqual(0);
    expect(set).toBeLessThan(calls.indexOf("window"));
    expect(calls.filter((call) => call.startsWith("setAppUserModelId"))).toHaveLength(1);
  });

  it("is left to Electron in a development build on Windows", async () => {
    const calls = await startUp("win32", false);
    expect(calls.some((call) => call.startsWith("setAppUserModelId"))).toBe(false);
  });

  it("is not set on macOS or Linux", async () => {
    for (const os of ["darwin", "linux"] as const) {
      recorded.calls.length = 0;
      vi.resetModules();
      const calls = await startUp(os, true);
      expect(calls.some((call) => call.startsWith("setAppUserModelId"))).toBe(false);
    }
  });
});
