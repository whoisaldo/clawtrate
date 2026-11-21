// F-319: a download saves exactly the bytes the reader supplied, and a failed
// write is read back before anything is said about the file that was there.
// The main process's own `save` handler runs here as the app registers it,
// with Electron's modules replaced: what a page hands it is written exactly,
// and it holds no more than a reader sends, for one dialog at a time.
import { MAX_SAVE_BYTES } from "@clawtrate/core";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { safeFileName, writeExactly, type SaveFs } from "../src/main/save.ts";

type Chosen = { canceled: boolean; filePath?: string };
const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => unknown>(),
  dialogs: [] as Array<{ options: { defaultPath: string }; answer: (chosen: Chosen) => void }>,
  appDir: "",
  /** The data folder a refused start under the test runner chose. */
  userData: [] as string[],
}));
vi.mock("electron", () => {
  const app = {
    setName() {},
    enableSandbox() {},
    getVersion: () => "1.0.0",
    getAppPath: () => electron.appDir,
    getPath: () => electron.appDir,
    setPath: (_name: string, path: string) => electron.userData.push(path),
    whenReady: async () => {},
    isPackaged: true,
    on() {},
    quit() {},
    requestSingleInstanceLock: () => true,
    setBadgeCount() {},
  };
  class BrowserWindow {
    static getAllWindows = () => [];
    static fromWebContents = () => null;
    webContents = { send() {}, isDestroyed: () => false };
    on() {}
    once() {}
    loadFile() {}
    loadURL() {}
    isDestroyed = () => false;
  }
  return {
    app,
    BrowserWindow,
    dialog: {
      showSaveDialog: (options: { defaultPath: string }) =>
        new Promise<Chosen>((answer) => electron.dialogs.push({ options, answer })),
    },
    ipcMain: {
      handle: (channel: string, fn: (event: unknown, raw: unknown) => unknown) =>
        electron.handlers.set(channel, fn),
      on() {},
    },
    nativeImage: { createFromBitmap: () => ({}) },
    nativeTheme: { shouldUseDarkColors: false },
    session: {
      defaultSession: {
        webRequest: { onBeforeRequest() {} },
        setPermissionRequestHandler() {},
        setPermissionCheckHandler() {},
      },
    },
    shell: { openExternal() {} },
  };
});
vi.mock("../src/host/runtime.ts", () => ({
  readDevConnection: () => null,
  selectInstance: () => undefined,
  startHostRuntime: async () => ({
    client: { state: {}, store: { subscribe: () => () => {} }, stop() {}, setSetup() {} },
    info: {},
    policy: {},
  }),
}));

const real: SaveFs = { readFile, writeFile, rename, rm, stat };
const dirs: string[] = [];
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), "clawtrate-save-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const bytes = Uint8Array.from({ length: 70_000 }, (_, i) => (i * 37 + 11) & 255);

describe("saving a file the Work pane holds", () => {
  it("F-319: writes exactly the bytes, under the chosen name, over an earlier file too", async () => {
    const dir = folder();
    const target = join(dir, "usage.png");
    writeFileSync(target, "older bytes");
    expect(await writeExactly(real, target, bytes)).toEqual({ status: "saved", name: "usage.png" });
    expect(new Uint8Array(readFileSync(target))).toEqual(bytes);
  });

  it("F-319: a failed write that left the earlier file says it is unchanged only after reading it back", async () => {
    const dir = folder();
    const target = join(dir, "notes.md");
    writeFileSync(target, "earlier");
    const failing: SaveFs = { ...real, rename: async () => Promise.reject(new Error("disk full")) };
    expect(await writeExactly(failing, target, bytes)).toEqual({
      status: "failed",
      message: "disk full",
      target: "unchanged",
    });
    expect(readFileSync(target, "utf8")).toBe("earlier");
  });

  it("F-319: a write that failed and left something else says it may be incomplete", async () => {
    const dir = folder();
    const target = join(dir, "notes.md");
    writeFileSync(target, "earlier");
    const partial: SaveFs = {
      ...real,
      rename: async () => {
        writeFileSync(target, "half");
        throw new Error("interrupted");
      },
    };
    expect(await writeExactly(partial, target, bytes)).toMatchObject({
      status: "failed",
      target: "unknown",
    });
  });

  it("F-319: nothing there before and nothing after is said as nothing saved", async () => {
    const dir = folder();
    const failing: SaveFs = {
      ...real,
      writeFile: async () => Promise.reject(new Error("read-only")),
    };
    expect(await writeExactly(failing, join(dir, "a.md"), bytes)).toMatchObject({
      status: "failed",
      target: "absent",
    });
  });

  it("offers a plain file name, never a folder", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("a\u0000b:c.md")).toBe("a_b_c.md");
    expect(safeFileName("..")).toBe("file");
    expect(safeFileName(42)).toBe("file");
  });
});

describe("the main process's save handler", () => {
  let id = 0;
  /** A window's page, as the handler sees its sender. */
  const page = () => Object.assign(new EventEmitter(), { id: (id += 1) });
  const save = (sender: EventEmitter, name: string, data: unknown) =>
    Promise.resolve().then(
      () =>
        electron.handlers.get("clawtrate:save")!({ sender }, { name, data }) as Promise<unknown>,
    );
  const dialogOpened = () => vi.waitFor(() => expect(electron.dialogs.length).toBe(1));
  const answer = (chosen: Chosen) => electron.dialogs.shift()!.answer(chosen);
  /** A byte of every value, a byte-order mark and a long pattern: what a reader may supply. */
  const supplied = () =>
    Uint8Array.from([
      ...Array.from({ length: 256 }, (_, i) => i),
      239,
      187,
      191,
      ...Array.from({ length: 70_000 }, (_, i) => (i * 37 + 11) & 255),
    ]);

  beforeAll(async () => {
    electron.appDir = folder();
    process.env.CLAWTRATE_DATA_DIR = join(electron.appDir, "gateway");
    await import("../src/main/index.ts");
    await vi.waitFor(() => expect(electron.handlers.has("clawtrate:save")).toBe(true));
  });
  afterEach(() => {
    while (electron.dialogs.length) answer({ canceled: true });
  });
  afterAll(() => {
    for (const dir of electron.userData.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("F-319: writes exactly the bytes the page handed over, where the dialog chose", async () => {
    const dir = folder();
    const bytes = supplied();
    const pending = save(page(), "../usage.png", bytes.slice().buffer);
    await dialogOpened();
    expect(electron.dialogs[0]!.options.defaultPath).toBe(join(electron.appDir, "usage.png"));
    answer({ canceled: false, filePath: join(dir, "chosen.png") });
    expect(await pending).toEqual({ status: "saved", name: "chosen.png" });
    expect(readFileSync(join(dir, "chosen.png")).equals(bytes)).toBe(true);
  });

  it("F-319: refuses more than the largest content a reader sends, before any dialog", async () => {
    await expect(save(page(), "big.bin", new ArrayBuffer(MAX_SAVE_BYTES + 1))).rejects.toThrow(
      /more than any of the gateway's readers sends/,
    );
    expect(electron.dialogs).toHaveLength(0);
  });

  it("F-319: holds the bytes once, for one dialog at a time; a cancelled dialog releases them", async () => {
    const one = page();
    const handed = new ArrayBuffer(MAX_SAVE_BYTES);
    const first = save(one, "a.bin", handed);
    await dialogOpened();
    // Moved out of the request: the handler's copy is the only one.
    expect(handed.byteLength).toBe(0);
    await expect(save(one, "b.bin", new ArrayBuffer(1))).rejects.toThrow(/waiting to be saved/);
    await expect(save(page(), "c.bin", new ArrayBuffer(1))).rejects.toThrow(/waiting to be saved/);
    expect(electron.dialogs).toHaveLength(1);
    answer({ canceled: true });
    expect(await first).toEqual({ status: "cancelled" });
    const again = save(one, "d.bin", new ArrayBuffer(1));
    await dialogOpened();
    answer({ canceled: true });
    expect(await again).toEqual({ status: "cancelled" });
  });

  it("F-319: a failed write releases the bytes", async () => {
    const one = page();
    const failed = save(one, "a.bin", new ArrayBuffer(3));
    await dialogOpened();
    answer({ canceled: false, filePath: join(folder(), "missing", "a.bin") });
    expect(await failed).toMatchObject({ status: "failed", target: "absent" });
    const again = save(one, "b.bin", new ArrayBuffer(1));
    await dialogOpened();
    answer({ canceled: true });
    await again;
  });

  it("F-319: a page reloaded while its dialog is open never has the next page's bytes written there", async () => {
    const sender = page();
    const before = save(sender, "old.bin", Uint8Array.from([1, 1, 1]).buffer);
    await dialogOpened();
    sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    // The same window's next page saves while the old dialog is still open.
    const after = save(sender, "new.bin", Uint8Array.from([2, 2]).buffer);
    await vi.waitFor(() => expect(electron.dialogs).toHaveLength(2));
    const dir = folder();
    answer({ canceled: false, filePath: join(dir, "old.bin") });
    expect(await before).toEqual({ status: "cancelled" });
    expect(existsSync(join(dir, "old.bin"))).toBe(false);
    answer({ canceled: false, filePath: join(dir, "new.bin") });
    expect(await after).toEqual({ status: "saved", name: "new.bin" });
    expect([...readFileSync(join(dir, "new.bin"))]).toEqual([2, 2]);
  });

  it("F-319: a window or page that goes while its dialog is open has its bytes dropped and nothing written", async () => {
    for (const goes of [
      (sender: EventEmitter) => sender.emit("destroyed"),
      (sender: EventEmitter) => sender.emit("render-process-gone"),
      (sender: EventEmitter) =>
        sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false }),
    ]) {
      const sender = page();
      const pending = save(sender, "a.bin", new ArrayBuffer(8));
      await dialogOpened();
      goes(sender);
      // Released at once: another page may save while that dialog is still open.
      const other = save(page(), "b.bin", new ArrayBuffer(1));
      await vi.waitFor(() => expect(electron.dialogs).toHaveLength(2));
      const target = join(folder(), "a.bin");
      answer({ canceled: false, filePath: target });
      expect(await pending).toEqual({ status: "cancelled" });
      expect(existsSync(target)).toBe(false);
      answer({ canceled: true });
      await other;
    }
  });
});
