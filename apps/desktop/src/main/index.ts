// Electron main process: hosts the core client and serves state to the renderer over IPC.

import {
  batchSnapshots,
  createBridgeSession,
  type BridgeSession,
  parseBridgeCommand,
  type ClawtrateState,
  type HostInfo,
  PendingSaves,
} from "@clawtrate/core";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  safeStorage,
  session,
  shell,
  type WebContents,
} from "electron";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { applyUnreadBadge, dotBitmap, parseBadgeCount } from "./badge.ts";
import { startDesktopUpdates } from "./update/build-info.ts";
import { createUpdatePreferenceStore } from "./update/preferences.ts";
import { windowsAppUserModelId } from "./identity.ts";
import { safeFileName, writeExactly, type SaveResult } from "./save.ts";
import {
  readDevConnection,
  selectInstance,
  startHostRuntime,
  type HostRuntime,
} from "../host/runtime.ts";
import { SetupController } from "../setup/controller.ts";
import { SetupRouter, SetupSlice } from "../setup/host.ts";
import { chooseDataDir, sshTransportFor } from "../setup/private-dir.ts";
import { RemoteSetup, type HostAnswer, type HostQuestion } from "../setup/remote.ts";
import { RouteStore, routedStorage, type TokenSeal } from "../setup/routes.ts";
import { productionWorld as sshProductionWorld } from "./ssh/world.ts";
import { SshTransport } from "./ssh/transport.ts";
import { ProgramRunner } from "../setup/programs.ts";
import { resolveSetupLaunch, sandboxOpener, type Opened } from "../setup/sandbox.ts";
import { startSyntheticGateway } from "../setup/synthetic-gateway.ts";
import { desktopStartup } from "../setup/startup.ts";
import { processIdentity } from "../../../../tools/dev-gateway/src/state-guard.ts";
import { accountHome, productionWorld, type SetupRefusedError } from "../setup/world.ts";

app.setName("Clawtrate");
// On Windows, the taskbar button belongs to the installer's shortcuts from the first window.
const appUserModelId = windowsAppUserModelId(process.platform, app.isPackaged);
if (appUserModelId) app.setAppUserModelId(appUserModelId);
// Every renderer is sandboxed, including any not created through createWindow.
app.enableSandbox();

const APP_ROOT = app.getAppPath();
const REPO_ROOT = join(APP_ROOT, "../..");
const RESOURCES = join(APP_ROOT, "resources");
const RENDERER_DIR = join(import.meta.dirname, "../renderer");
// Only a development build loads the renderer from the dev server; a packaged
// app never loads a URL taken from its environment.
const DEV_SERVER = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;

/** The app's own content: its renderer folder, or the dev server in development. */
function isAppContent(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === "file:") return url.href.startsWith(pathToFileURL(RENDERER_DIR).href + "/");
  if (DEV_SERVER === undefined) return false;
  const dev = new URL(DEV_SERVER);
  // The dev server's page, assets and its hot-reload socket.
  return url.hostname === dev.hostname && url.port === dev.port;
}

/** Links leave the app only for the web: http and https open in the system browser. */
function openExternally(raw: string): void {
  try {
    const { protocol } = new URL(raw);
    if (protocol === "http:" || protocol === "https:") void shell.openExternal(raw);
  } catch {
    // not a URL: ignored
  }
}

let runtime: HostRuntime | null = null;
let window: BrowserWindow | null = null;
/** The programs setup started, ended by PID when the app quits. */
const programs = new ProgramRunner();
let closeSetup: () => Promise<void> = async () => {};
/** Ends the SSH route's forward and every `ssh` the host started, by PID. */
let closeRemote: () => Promise<void> = async () => {};

/** Whether a command-line switch was given, to Chromium or to the app. */
function hasSwitch(name: string): boolean {
  return (
    app.commandLine?.hasSwitch(name) === true ||
    process.argv.some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`))
  );
}

/** A switch's value, given to Chromium or to the app; empty when it has none. */
function switchValue(name: string): string {
  return app.commandLine?.getSwitchValue(name) ?? "";
}

/**
 * How this launch sets up on this computer (docs/development/setup.md),
 * resolved before the single-instance lock and the host runtime: the real
 * computer for a packaged app nothing automates; otherwise only the sandbox
 * the launch names, checked now, or a refusal.
 */
const SETUP = resolveSetupLaunch({
  packaged: app.isPackaged,
  env: process.env,
  switches: hasSwitch,
  switchValue,
  context: { platform: process.platform, home: accountHome(), uid: process.getuid?.() ?? null },
});

/**
 * What the host starts on, from that launch, also before the lock: a sandbox's
 * checked `app-data` or, refused, the folder the launch named with
 * `--user-data-dir` or else a fresh private temporary folder as its data
 * folder, and then no development gateway and no saved gateway reopened.
 * Only a person's packaged app keeps the ordinary data folder and resumes.
 */
const STARTUP = desktopStartup(SETUP, {
  packaged: app.isPackaged,
  devConnection: () =>
    readDevConnection(REPO_ROOT, { instance: selectInstance(undefined, process.env) }),
  autoConnectDev: () => process.env.CLAWTRATE_AUTOCONNECT_DEV === "1",
  launchData: () => switchValue("user-data-dir") || null,
  privateData: () => mkdtempSync(join(tmpdir(), "clawtrate-refused-")),
});
if (STARTUP.userData) app.setPath("userData", STARTUP.userData);

/**
 * The checkout whose run records prove a sandbox's run: this development
 * build's own; a packaged app is told by its launch check.
 */
function launcherCheckout(): string | null {
  const path = app.isPackaged ? switchValue("clawtrate-setup-checkout") : REPO_ROOT;
  try {
    return path ? realpathSync(path) : null;
  } catch {
    return null;
  }
}

/** What each look and Connect opens: the real computer, the sandbox, or the refusal. */
function setupOpener(): {
  open: () => Promise<Opened | SetupRefusedError>;
  close: () => Promise<void>;
} {
  const close = async () => {};
  if (SETUP.kind === "refused") return { open: async () => SETUP.error, close };
  if (SETUP.kind === "sandbox") {
    return sandboxOpener({
      file: SETUP.file,
      sandbox: SETUP.sandbox,
      platform: process.platform,
      context: {
        platform: process.platform,
        home: accountHome(),
        uid: process.getuid?.() ?? null,
        checkout: launcherCheckout(),
      },
      startGateway: startSyntheticGateway,
      log: (line) => console.log(line),
    });
  }
  // The real computer; on Windows the look starts nothing.
  const home = accountHome();
  return {
    open: async () => ({
      world: productionWorld({
        home: home ?? "",
        appData: app.getPath("userData"),
        platform: process.platform,
        lang: process.env.LANG,
      }),
      run: programs.run,
      identify: processIdentity,
    }),
    close,
  };
}

/** The host's own confirmation (docs/design/setup.md §2): a native dialog, never the page. */
async function askNatively(question: HostQuestion): Promise<HostAnswer> {
  const options = {
    type: "question" as const,
    message: question.message,
    detail: question.detail,
    buttons: [question.confirm, "Cancel"],
    defaultId: question.checkbox ? 1 : 0,
    cancelId: 1,
    noLink: true,
    ...(question.checkbox ? { checkboxLabel: question.checkbox, checkboxChecked: false } : {}),
  };
  const owner = window && !window.isDestroyed() ? window : null;
  const answer = owner
    ? await dialog.showMessageBox(owner, options)
    : await dialog.showMessageBox(options);
  return { confirmed: answer.response === 0, checked: answer.checkboxChecked === true };
}

async function confirmNatively(confirmation: {
  message: string;
  detail: string;
  confirm: string;
}): Promise<boolean> {
  return (await askNatively(confirmation)).confirmed;
}

/**
 * The SSH transport of a person's app, made once, only after its data folder,
 * its `ssh` folder and every folder above them are proven private, and made
 * only below a proven parent (`sshTransportFor`, docs/design/setup.md §2
 * rule 3). A development build or an automated run never reaches another
 * computer: its SSH world would be this account's real one.
 */
function sshTransport(
  dataDir: string,
): SshTransport | { refused: "app-files-unsafe" | "not-supported" } {
  return sshTransportFor(dataDir, (dir) => new SshTransport(sshProductionWorld(dir)), {
    log: (line) => console.log(line),
  });
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    title: "Clawtrate",
    width: 1320,
    height: 840,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0b0e14" : "#f4f5f2",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    ...(process.platform === "darwin" ? {} : { icon: join(RESOURCES, "icon.png") }),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  win.on("closed", () => {
    if (window === win) window = null;
  });
  win.once("ready-to-show", () => {
    if (!process.env.CLAWTRATE_SCREENSHOT) win.show();
  });

  if (DEV_SERVER) void win.loadURL(DEV_SERVER);
  else void win.loadFile(join(RENDERER_DIR, "index.html"));
  return win;
}

/**
 * Verification aid: with CLAWTRATE_SCREENSHOT=<path>, wait for the shell to render,
 * save the window as a PNG, and quit. The window is never shown.
 */
async function captureAndQuit(win: BrowserWindow, path: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const ready = (await win.webContents.executeJavaScript(
      `document.querySelectorAll('[data-testid="transcript-turn"]').length > 0`,
    )) as boolean;
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await new Promise((resolve) => setTimeout(resolve, 800));
  const image = await win.webContents.capturePage();
  writeFileSync(path, image.toPNG());
  app.quit();
}

/**
 * Every web contents, the window's and any other: no new windows (links from
 * transcripts open in the system browser), no navigation, no webviews.
 */
app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.on("will-attach-webview", (event) => event.preventDefault());
});

/**
 * Nothing but the app's own files is loaded. The one exception is a bot's
 * picture, an https image the gateway names (the page's policy allows it as
 * `img-src https:`). The renderer is granted no permissions except writing
 * text to the clipboard for the copy buttons.
 */
function lockDownSession(): void {
  const ses = session.defaultSession;
  ses.webRequest.onBeforeRequest((details, callback) => {
    const allowed =
      isAppContent(details.url) ||
      details.url.startsWith("devtools:") ||
      details.url.startsWith("data:") ||
      (details.resourceType === "image" && details.url.startsWith("https://"));
    callback({ cancel: !allowed });
  });
  const allowedPermission = (permission: string) => permission === "clipboard-sanitized-write";
  ses.setPermissionRequestHandler((_contents, permission, grant) =>
    grant(allowedPermission(permission)),
  );
  ses.setPermissionCheckHandler((_contents, permission) => allowedPermission(permission));
}

/**
 * Show the save dialog for the bytes `saves` holds under `ticket` and
 * write exactly those bytes where the person chooses. They are released when
 * the dialog is cancelled, when the write ends either way, and when the
 * window or its page goes; a page that went has nothing written for it.
 */
async function saveHeld(
  saves: PendingSaves,
  ticket: number,
  contents: WebContents,
  name: string,
): Promise<SaveResult> {
  const drop = () => saves.release(ticket);
  const navigated = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
    if (details.isMainFrame && !details.isSameDocument) drop();
  };
  contents.once("destroyed", drop);
  contents.on("render-process-gone", drop);
  contents.on("did-start-navigation", navigated);
  try {
    const owner = BrowserWindow.fromWebContents(contents);
    const options = {
      defaultPath: join(app.getPath("downloads"), name),
      properties: ["createDirectory", "showOverwriteConfirmation"] as Array<
        "createDirectory" | "showOverwriteConfirmation"
      >,
    };
    const chosen = owner
      ? await dialog.showSaveDialog(owner, options)
      : await dialog.showSaveDialog(options);
    const data = saves.get(ticket);
    if (chosen.canceled || !chosen.filePath || !data) return { status: "cancelled" };
    return await writeExactly(
      { readFile, writeFile, rename, rm, stat },
      chosen.filePath,
      new Uint8Array(data),
    );
  } finally {
    contents.removeListener("destroyed", drop);
    contents.removeListener("render-process-gone", drop);
    contents.removeListener("did-start-navigation", navigated);
    drop();
  }
}

/**
 * A route's device token, encrypted with Electron's `safeStorage` before it is
 * written: the system keychain on macOS, the desktop's secret service on
 * Linux. Linux's plain-text fallback is no encryption, so no token is kept there.
 */
function systemSeal(): TokenSeal {
  return {
    available: () => {
      try {
        if (!safeStorage.isEncryptionAvailable()) return false;
        return (
          process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text"
        );
      } catch {
        return false;
      }
    },
    seal: (plain) => safeStorage.encryptString(plain).toString("base64"),
    open: (sealed) => {
      try {
        return safeStorage.decryptString(Buffer.from(sealed, "base64"));
      } catch {
        return null;
      }
    },
  };
}

/** The device key and tokens live here, readable by this user only. */
function privateDataDir(): string | null {
  // Only a person's app takes its folder from the environment; every other run keeps its own.
  const chosen = SETUP.kind === "production" ? process.env.CLAWTRATE_DATA_DIR : undefined;
  const dir = chosen ?? join(app.getPath("userData"), "gateway");
  // Proven first and made only below a proven parent; a folder that can't be proven is left as
  // it is, and nothing is kept below it (`chooseDataDir`).
  const choice = chooseDataDir(dir);
  if (choice.ok) return choice.dir;
  console.log(`[setup] The data folder isn't proven private (${choice.reason} at ${choice.at}).`);
  dialog.showErrorBox(
    "Clawtrate can't keep its data private",
    `Clawtrate keeps this device's key and pairings in ${dir}, and another account could change that folder or one above it. Clawtrate didn't change it. Make the folders above it yours alone, then open Clawtrate again.`,
  );
  return null;
}

async function main(): Promise<void> {
  await app.whenReady();
  lockDownSession();
  if (process.platform === "darwin" && !app.isPackaged) {
    app.dock?.setIcon(join(RESOURCES, "icon-mac.png"));
  }

  const devInstance = STARTUP.devGateway ? selectInstance(undefined, process.env) : null;
  const dataDir = privateDataDir();
  if (dataDir === null) {
    app.quit();
    return;
  }
  // A route's device token is encrypted by the system before it is written (Keychain on macOS,
  // the desktop's secret service on Linux); where it can't be, no token is kept and SSH doesn't pair.
  const routes = new RouteStore(dataDir, {
    seal: systemSeal(),
    onEvict: (record) => remote?.forgetEvicted(record),
  });
  // Set once the setup host exists: where a request is approved, and a route's word on an address.
  let router: SetupRouter | null = null;
  let remote: RemoteSetup | null = null;
  runtime = await startHostRuntime({
    kind: "desktop",
    displayName: "Clawtrate Desktop",
    dataDir,
    wrapStorage: (store) => routedStorage(store, routes),
    approvalPlace: (url) => router?.placeFor(url) ?? null,
    readBack: async (url, request) => (router ? router.readBack(url, request) : null),
    routeAllows: (url) => remote?.allows(url) ?? null,
    // A route's channel is reached only on its forward's own local socket.
    routeSocket: (url) => remote?.socketFor(url) ?? null,
    reopenRoute: async (route) => remote?.reopen(route),
    // A sandboxed or refused start (every development build and automated run) has no
    // development gateway, doesn't auto-connect and never resumes a saved gateway.
    devGateway: STARTUP.devGateway,
    recheckDevGateway: () => readDevConnection(REPO_ROOT, { instance: devInstance }),
    autoConnectDev: STARTUP.autoConnectDev,
    resume: STARTUP.resume,
  });
  const { client, info, policy } = runtime;
  const userDir = app.getPath("userData");
  const updates = await startDesktopUpdates({
    version: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    downloadDir: join(userDir, "updates"),
    store: createUpdatePreferenceStore(join(userDir, "update-preferences.json")),
    changed(snapshot) {
      if (window && !window.isDestroyed())
        window.webContents.send("clawtrate:update:changed", snapshot);
    },
  });
  app.on("quit", () => updates.shutdown());
  ipcMain.handle("clawtrate:update:restart", (_event, id: unknown) => updates.restart(id));
  ipcMain.handle("clawtrate:update:get", () => updates.get());
  ipcMain.handle("clawtrate:update:check", (_event, track: unknown, revision: unknown) =>
    updates.check(track, revision),
  );
  ipcMain.handle("clawtrate:update:track", (_event, track: unknown) => updates.chooseTrack(track));
  ipcMain.handle("clawtrate:update:download", (_event, id: unknown) => updates.download(id));
  // Setup on this computer. A development build and every automated run look only in a sandbox.
  const opener = setupOpener();
  closeSetup = opener.close;
  const slice = new SetupSlice(client);
  const setup = new SetupController({
    client,
    open: opener.open,
    stopPrograms: () => programs.stopAll(),
    confirm: confirmNatively,
    log: (line) => console.log(line),
    publish: (next) => slice.setMain(next),
  });
  // Another computer only in a person's app: never with this account's real SSH files otherwise.
  // Windows has no local socket the host can prove private for the forward: no SSH route there.
  const ssh =
    SETUP.kind === "production" && (process.platform === "darwin" || process.platform === "linux");
  remote = ssh
    ? new RemoteSetup({
        client,
        transport: () => sshTransport(dataDir),
        routes,
        ask: askNatively,
        publish: (next) => slice.setMain(next),
        publishRoute: (route) => slice.setRoute(route),
        log: (line) => console.log(line),
      })
    : null;
  closeRemote = () => remote?.closeAll() ?? Promise.resolve();
  router = new SetupRouter(setup, remote);
  policy.setup = router;
  info.setup = { look: true, pair: true, platform: process.platform, ssh };
  if (remote && STARTUP.resume) void remote.resume();

  ipcMain.handle("clawtrate:hello", (): { info: HostInfo; state: ClawtrateState } => ({
    info,
    state: client.state,
  }));
  // One bridge session per window, so a closed window releases its transcripts.
  const sessions = new Map<number, BridgeSession>();
  ipcMain.handle("clawtrate:command", async (event, raw: unknown) => {
    const contents = event.sender;
    let session = sessions.get(contents.id);
    if (!session) {
      const created = createBridgeSession(client, policy);
      sessions.set(contents.id, created);
      contents.once("destroyed", () => {
        created.dispose();
        sessions.delete(contents.id);
      });
      session = created;
    }
    // Only the command's plain-data answer crosses back to the renderer.
    return session.apply(parseBridgeCommand(raw));
  });
  // Files arrive as bytes, never as paths: a renderer cannot make this process read a file of its choosing.
  ipcMain.handle("clawtrate:attach", (_event, raw: unknown) => {
    const file = raw as { name?: unknown; type?: unknown; data?: unknown } | null;
    const data = file?.data;
    if (!(data instanceof ArrayBuffer)) throw new Error("invalid file");
    const store = policy.attachments!;
    const meta = { fileName: file?.name, mimeType: file?.type };
    store.check(meta, data.byteLength);
    return store.add(meta, data.byteLength, () => Buffer.from(data).toString("base64"));
  });
  // Saving a file the Work pane holds: its bytes arrive, never a path; the person picks
  // where in the system's save dialog, starting in Downloads, and only that file is written.
  // No more than the largest content a reader sends, and one dialog at a time: a page cannot
  // make this process hold more (`PendingSaves`, counted as `saves` in docs/decisions.md).
  const saves = new PendingSaves();
  ipcMain.handle("clawtrate:save", (event, raw: unknown): Promise<SaveResult> => {
    const file = raw as { name?: unknown; data?: unknown } | null;
    const data = file?.data;
    if (!(data instanceof ArrayBuffer)) throw new Error("invalid file");
    // The bytes move out of the request, which Electron keeps until the answer: one copy, here.
    const ticket = saves.hold(event.sender.id, data);
    return saveHeld(saves, ticket, event.sender, safeFileName(file?.name));
  });
  // Unread activity on the dock (macOS, Linux) or the taskbar button (Windows).
  const dot = nativeImage.createFromBitmap(Buffer.from(dotBitmap(16, [10, 110, 92])), {
    width: 16,
    height: 16,
  });
  ipcMain.on("clawtrate:badge", (_event, raw: unknown) => {
    const count = parseBadgeCount(raw);
    if (count === null) return;
    applyUnreadBadge(
      {
        platform: process.platform,
        setBadgeCount: (value) => app.setBadgeCount(value),
        setOverlay: (icon, description) => {
          for (const win of BrowserWindow.getAllWindows()) {
            win.setOverlayIcon(icon ? dot : null, description);
          }
        },
      },
      count,
    );
  });
  batchSnapshots(client.store.subscribe, (state) => {
    // A snapshot can fire after the window closed, during quit for one.
    if (window && !window.isDestroyed()) window.webContents.send("clawtrate:state", state);
  });

  window = createWindow();
  if (process.env.CLAWTRATE_SCREENSHOT)
    void captureAndQuit(window, process.env.CLAWTRATE_SCREENSHOT);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) window = createWindow();
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" || process.env.CLAWTRATE_SCREENSHOT) app.quit();
});

/** How long quitting waits for the SSH forward and every `ssh` the host started to end. */
const QUIT_WAIT_MS = 5_000;
let quitting: "no" | "waiting" | "done" = "no";

app.on("before-quit", (event) => {
  if (quitting === "done") return;
  if (quitting === "waiting") {
    event.preventDefault();
    return;
  }
  // The SSH children end first, by PID, within a bound; then the app quits as before.
  event.preventDefault();
  quitting = "waiting";
  programs.stopAll();
  void closeSetup();
  runtime?.client.stop();
  const bound = new Promise<void>((resolve) => setTimeout(resolve, QUIT_WAIT_MS));
  // An approval's token and gateway, committed together or both put back, within the same bound.
  const settled = runtime?.client.settled() ?? Promise.resolve();
  const closed = Promise.all([closeRemote().catch(() => undefined), settled]);
  void Promise.race([closed, bound]).finally(() => {
    quitting = "done";
    app.quit();
  });
});

// One app per data folder: a second launch focuses the running window and exits.
if (app.requestSingleInstanceLock()) {
  app.on("second-instance", () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  void main();
} else {
  app.quit();
}
