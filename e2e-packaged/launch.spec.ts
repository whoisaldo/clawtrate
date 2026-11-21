// The packaged app launches, shows its window and connect screen, and pairs
// with a development gateway instance of this run's own. On Windows, where no
// development gateway runs, the tests that need one are skipped.
import type { DesktopUpdates } from "../packages/core/src/desktop-updates.ts";
import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { devGateway } from "../e2e/global-setup.ts";
import { openInstance } from "../tools/dev-gateway/src/cli.ts";
import { provenEndpoint } from "../tools/dev-gateway/src/endpoint.ts";
import { parseJsonOutput } from "../tools/dev-gateway/src/env.ts";
import { runDirFor } from "../tools/dev-gateway/src/instance.ts";
import { fuseMismatches } from "../apps/desktop/packaging/fuse-check.ts";
import { macSigningRequested, windowsSigningRequested } from "../apps/desktop/packaging/signing.ts";
import { APP_ID } from "../apps/desktop/src/main/identity.ts";
import { launchPlace, packagedExecutable } from "./global-setup.ts";
import {
  integrityLevels,
  mainWindowTitle,
  taskbarOverlayDescription,
  windowsProcesses,
  type OverlayRead,
} from "./windows.ts";

const ROOT = join(import.meta.dirname, "..");
const INSTANCE = process.env.CLAWTRATE_DEV_INSTANCE!;
const APP = process.env.CLAWTRATE_PACKAGED_APP!;
const USER_DATA = process.env.CLAWTRATE_PACKAGED_USER_DATA!;
const APP_PID = Number(process.env.CLAWTRATE_PACKAGED_PID);
const APP_LOG = process.env.CLAWTRATE_PACKAGED_LOG ?? "";
const SANDBOX = process.env.CLAWTRATE_PACKAGED_SANDBOX!;
/** A made-up key for the scripted API-key sign-in: its account is `acme:packaged`. */
const TYPED_KEY = "clawtrate-dev-key.acme.packaged";

/** Whether a file, or any file under a folder, holds the value, as UTF-8 or UTF-16 text. */
function holds(path: string, value: string): string[] {
  if (!existsSync(path)) return [];
  const stat = lstatSync(path);
  if (stat.isDirectory())
    return readdirSync(path).flatMap((name) => holds(join(path, name), value));
  // Sockets and links (the single-instance lock's) hold no text of their own.
  if (!stat.isFile()) return [];
  const bytes = readFileSync(path);
  return bytes.includes(Buffer.from(value, "utf8")) || bytes.includes(Buffer.from(value, "utf16le"))
    ? [path]
    : [];
}
const WINDOWS = process.platform === "win32";
const NO_GATEWAY = "no development gateway runs on Windows";

/** The app's direct children, as the system reports them: PID and full command line. */
function helpers(): { pid: number; command: string }[] {
  if (WINDOWS) return windowsProcesses().filter(({ ppid }) => ppid === APP_PID);
  const out = execFileSync("ps", ["-axww", "-o", "pid=,ppid=,command="], { encoding: "utf8" });
  return out.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match && Number(match[2]) === APP_PID
      ? [{ pid: Number(match[1]), command: match[3]! }]
      : [];
  });
}

/**
 * The kernel's answer to whether a process is confined by a sandbox:
 * `sandbox_check(pid, NULL, 0)` from libSystem returns 1 for a process that
 * has entered a Seatbelt profile and 0 for one that has not. Node has no way
 * to call it, so Apple's Python (part of the command line tools that git on
 * macOS already needs) calls it through ctypes.
 */
function kernelSaysSandboxed(pid: number): number {
  const script = [
    "import ctypes, sys",
    "lib = ctypes.CDLL('/usr/lib/libSystem.B.dylib')",
    "lib.sandbox_check.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int]",
    "print(lib.sandbox_check(int(sys.argv[1]), None, 0))",
  ].join("\n");
  return Number(
    execFileSync("/usr/bin/python3", ["-I", "-c", script, String(pid)], {
      encoding: "utf8",
    }).trim(),
  );
}

let browser: Browser;
let page: Page;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  browser = await chromium.connectOverCDP(process.env.CLAWTRATE_PACKAGED_CDP!);
  await expect
    .poll(() => browser.contexts().flatMap((context) => context.pages()).length)
    .toBeGreaterThan(0);
  page = browser.contexts().flatMap((context) => context.pages())[0]!;
});

test.afterAll(async () => {
  // Disconnects; the teardown quits the app.
  await browser?.close();
});

test("opens its window from the packaged app on the connect screen", async () => {
  expect(USER_DATA).toBe(realpathSync.native(USER_DATA));
  // The renderer is the one inside the app's archive, not the source tree.
  const bundled = WINDOWS
    ? decodeURI(
        pathToFileURL(join(realpathSync(APP), "resources/app.asar/out/renderer/index.html")).href,
      )
    : `file://${realpathSync(APP)}/Contents/Resources/app.asar/out/renderer/index.html`;
  expect(decodeURI(page.url())).toBe(bundled);
  await expect(page).toHaveTitle("Clawtrate");
  await expect(page.getByRole("heading", { name: "Clawtrate" })).toBeVisible();
  // The first screen asks where OpenClaw runs; the address-and-token form is under Advanced.
  await expect(page.getByRole("heading", { name: "Where does OpenClaw run?" })).toBeVisible();
  await page.getByRole("button", { name: "Advanced" }).click();
  await expect(page.getByPlaceholder("Gateway address")).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect" })).toBeVisible();
  // This checks the packaged build capability before a verified offer exists.
  const updates = await page.evaluate(() =>
    (
      window as unknown as { clawtrateHost: { desktopUpdates: DesktopUpdates } }
    ).clawtrateHost.desktopUpdates.get(),
  );
  // The signing variables that configured the build, as in apps/desktop/packaging/update-defines.ts.
  const signed = WINDOWS ? windowsSigningRequested(process.env) : macSigningRequested(process.env);
  expect(updates).toMatchObject({
    install: {
      kind: "unavailable-in-this-build",
      reason: !signed
        ? "build-not-signed"
        : WINDOWS
          ? "windows-install-pending-trial"
          : "no-verified-download",
    },
    lastAttempt: null,
  });
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { clawtrateHost: { desktopUpdates: DesktopUpdates } }
      ).clawtrateHost.desktopUpdates.restart("absent"),
    ),
  ).toMatchObject({ outcome: "stale", snapshot: { lastAttempt: null } });
  // A packaged app does not look for the development gateway.
  await expect(page.getByRole("button", { name: "Use the development gateway" })).toHaveCount(0);

  // No Node in the page, only the preload's narrow bridge, and the page's policy is in force.
  const page_ = await page.evaluate(() => ({
    require: typeof (globalThis as { require?: unknown }).require,
    process: typeof (globalThis as { process?: unknown }).process,
    host: Object.keys((window as unknown as { clawtrateHost: object }).clawtrateHost).sort(),
    csp:
      document
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute("content") ?? "",
  }));
  expect(page_.require).toBe("undefined");
  expect(page_.process).toBe("undefined");
  // The whole bridge: six functions and the platform name. `attach` hands a file's
  // bytes to the main process for a later message, `save` hands it the bytes of a file
  // the Work pane holds to save where the person chooses, and `setBadge` gives it the
  // number of unread tasks for the dock badge; anything else here is a regression.
  expect(page_.host).toEqual([
    "attach",
    "desktopUpdates",
    "hello",
    "onState",
    "platform",
    "save",
    "send",
    "setBadge",
  ]);
  expect(page_.csp).toContain("default-src 'self'");
  expect(page_.csp).toContain("script-src 'self'");
});

test("looks on this computer only in the sandbox the launch check gave it", async () => {
  await page.getByRole("button", { name: "Back" }).click();
  await page
    .getByRole("list", { name: "Where does OpenClaw run?" })
    .getByRole("button", { name: /This computer/ })
    .click();
  if (WINDOWS) {
    await expect(page.getByRole("heading", { name: "Use Advanced on Windows" })).toBeVisible();
  } else {
    // The run's own instance, by its profile: the only one the sandbox lets the look see.
    await expect(page.getByRole("heading", { name: "OpenClaw is running" })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByTestId("setup-found").locator("dl > div").nth(1)).toHaveText(
      `Profileclawtrate-dev-${INSTANCE}`,
    );
  }
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: "Advanced" }).click();
  await expect(page.getByPlaceholder("Gateway address")).toBeVisible();
});

test("starts with the update tracks compiled into the packaged app", async () => {
  const updates = await page.evaluate(() =>
    (
      window as unknown as { clawtrateHost: { desktopUpdates: DesktopUpdates } }
    ).clawtrateHost.desktopUpdates.get(),
  );
  expect(updates).toMatchObject({
    revision: 0,
    preferenceIssue: null,
    lastCheck: null,
    pendingTrack: null,
  });
  const tracks = updates.tracks.map(({ track }) => track);
  const supported = ["stable", "nightly"] as const;
  expect(tracks).toEqual(supported.filter((track) => tracks.includes(track)));
  if (tracks.length) {
    for (const { source } of updates.tracks)
      expect(new URL(`https://${source}`).hostname).toBe(source);
    expect(updates.selectedTrack).toBe(
      tracks.find((track) => track === updates.runningTrack) ?? tracks[0],
    );
    expect(updates.state).toEqual({ kind: "not-checked" });
    return;
  }
  expect(updates).toMatchObject({
    state: { kind: "failed", stage: "check", reason: "not-configured" },
    selectedTrack: null,
  });
  const reply = await page.evaluate(
    (revision) =>
      (
        window as unknown as { clawtrateHost: { desktopUpdates: DesktopUpdates } }
      ).clawtrateHost.desktopUpdates.check("stable", revision),
    updates.revision,
  );
  expect(reply).toEqual({ outcome: "invalid", snapshot: updates });
});

test("names its window Clawtrate, as Windows sees it", async () => {
  test.skip(!WINDOWS, "on macOS the page's title above is the window's title");
  // The window is shown once its page has painted; until then Windows reports no title.
  await expect.poll(() => mainWindowTitle(APP_PID), { timeout: 20_000 }).toBe("Clawtrate");
});

test("shows unread tasks as an overlay on its taskbar button, and clears it at zero", async () => {
  test.skip(!WINDOWS, "the macOS dock badge is not read from outside yet");
  // The page reports the count through the bridge, as the renderer does for
  // unread tasks; the main process sets the overlay icon, whose description
  // Windows gives as the taskbar button's help text. The button is the one
  // with the app's own id, the bundle id its installer gives its shortcuts,
  // from the first launch on: not the executable's path.
  const setBadge = (count: number) =>
    page.evaluate((value) => {
      (
        window as unknown as { clawtrateHost: { setBadge(n: number): void } }
      ).clawtrateHost.setBadge(value);
    }, count);
  const reads: OverlayRead[] = [];
  let step = { phase: "set", expected: "3 unread" };
  try {
    await setBadge(3);
    await expect
      .poll(() => taskbarOverlayDescription(APP_ID, reads), { timeout: 15_000 })
      .toBe(step.expected);
    step = { phase: "clear", expected: "" };
    await setBadge(0);
    await expect
      .poll(() => taskbarOverlayDescription(APP_ID, reads), { timeout: 15_000 })
      .toBe(step.expected);
  } catch (error) {
    await test.info().attach("taskbar-overlay", {
      body: JSON.stringify({ ...step, lastReads: reads.slice(-5) }, null, 2),
      contentType: "application/json",
    });
    throw error;
  }
});

test("hands a second launch to the running app instead of starting another", async () => {
  // The same data folder, so the same single-instance lock. The second process
  // must exit by itself, successfully, and leave the first one and its one window.
  // Never a packaged app without a sandbox, even one that only hands over to the running app.
  // The run's temporary home, temporary folder and working folder, as the first launch had.
  const place = launchPlace(process.env.CLAWTRATE_PACKAGED_PLACE!);
  const second = spawn(
    packagedExecutable(APP),
    [`--user-data-dir=${USER_DATA}`, `--clawtrate-setup-sandbox=${SANDBOX}`],
    {
      cwd: place.cwd,
      env: place.env,
      stdio: "ignore",
    },
  );
  const exited = new Promise<number | null>((resolve) => second.once("exit", resolve));
  const code = await Promise.race([
    exited,
    new Promise<"running">((resolve) => setTimeout(() => resolve("running"), 15_000)),
  ]);
  if (code === "running") second.kill();
  expect(code, "the second launch's exit code").toBe(0);
  expect(() => process.kill(APP_PID, 0), "the first app is still running").not.toThrow();
  await page.waitForTimeout(500);
  expect(browser.contexts().flatMap((context) => context.pages())).toHaveLength(1);
});

test("runs its renderer in the operating system's sandbox", () => {
  expect(Number.isInteger(APP_PID) && APP_PID > 1).toBe(true);
  if (WINDOWS) {
    // Room for PowerShell's first compile of the token reader (see integrityLevels).
    test.setTimeout(150_000);
    // Chromium starts a sandboxed renderer on Windows with a restricted token at
    // untrusted integrity, and the main process keeps the user's own level. The
    // integrity level is read from each process's token, from outside.
    // This assertion has never been seen to fail: the packaged Windows app,
    // started with the sandbox turned off (--no-sandbox or
    // ELECTRON_DISABLE_SANDBOX=1), crashes at once with an access violation
    // (0xC0000005) before any renderer exists, so no unsandboxed renderer could
    // be produced to read.
    const renderers = helpers().filter(({ command }) => /\s--type=renderer(\s|$)/.test(command));
    expect(renderers.length, "the app's renderer processes").toBeGreaterThan(0);
    const levels = integrityLevels([APP_PID, ...renderers.map(({ pid }) => pid)]);
    for (const { pid, command } of renderers) {
      expect(command, `renderer ${pid}`).not.toMatch(/\s--no-sandbox(\s|$)/);
      expect(levels.get(pid), `integrity level of renderer ${pid}`).toBe(0);
    }
    expect(levels.get(APP_PID), "integrity level of the main process").toBeGreaterThan(0);
    return;
  }
  // The page having no Node globals says nothing about the sandbox; context
  // isolation alone gives that. So the evidence is the renderer process
  // itself, from outside it. Its launch arguments show how Chromium started
  // it: a sandboxed renderer gets --seatbelt-client, the pipe over which it
  // receives its Seatbelt profile and enters it before running any page code,
  // and an unsandboxed one gets --no-sandbox and no seatbelt client. The
  // kernel then confirms the process is actually confined. Neither can be
  // satisfied when `sandbox: false` or a missing app.enableSandbox() lets the
  // renderer run unsandboxed, which is what this test exists to catch.
  const renderers = helpers().filter(({ command }) => /\s--type=renderer(\s|$)/.test(command));
  expect(renderers.length, "the app's renderer processes").toBeGreaterThan(0);
  for (const { pid, command } of renderers) {
    expect(command, `renderer ${pid}`).toMatch(/\s--seatbelt-client=\d+(\s|$)/);
    expect(command, `renderer ${pid}`).not.toMatch(/\s--no-sandbox(\s|$)/);
    expect(kernelSaysSandboxed(pid), `sandbox_check for renderer ${pid}`).toBe(1);
  }
  // The same query tells an unsandboxed process apart: the main process is not sandboxed.
  expect(kernelSaysSandboxed(APP_PID), "sandbox_check for the main process").toBe(0);
});

test("keeps the fuses it was packaged with", async () => {
  // Read from the binary as it was built or installed: Node's own entry points
  // off, and only its archive loaded, checked against its hash.
  expect(await fuseMismatches(packagedExecutable(APP), process.platform)).toEqual([]);
});

test("pairs with its own development gateway instance and shows the seeded bots", async () => {
  test.skip(WINDOWS, NO_GATEWAY);
  expect(INSTANCE).toMatch(/^e2e-[0-9a-f]{8}$/);
  const endpoint = provenEndpoint({
    instance: INSTANCE,
    home: homedir(),
    runDir: runDirFor(INSTANCE, join(ROOT, "tools/dev-gateway/.run")),
    checkout: realpathSync(ROOT),
  });
  if ("refusal" in endpoint) throw new Error(endpoint.refusal);
  expect(endpoint.url).toMatch(/^ws:\/\/127\.0\.0\.1:(19[2-9]\d\d)$/);

  await page.getByPlaceholder("Gateway address").fill(endpoint.url);
  await page.getByPlaceholder("Gateway token, for pairing").fill(endpoint.token);
  await page.getByRole("button", { name: "Connect" }).click();

  // A fresh device identity must be approved on the gateway, over the real protocol.
  await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible({
    timeout: 20_000,
  });
  devGateway(INSTANCE, "approve");

  const bots = page.getByTestId("bot");
  await expect(bots).toHaveCount(4, { timeout: 20_000 });
  // The rail orders bots by recent activity (F-031), so the names are compared as a set.
  expect((await bots.locator(".bot-name").allTextContents()).sort()).toEqual([
    "Juniper",
    "Marlow",
    "Otto",
    "Pip",
  ]);
  await page.getByRole("button", { name: /^Otto, \d+ tasks?/ }).click();
  await page
    .getByRole("list", { name: "Otto's tasks" })
    .getByTestId("task")
    .filter({ hasText: "Disk almost full on the media box" })
    .click();
  await expect(page.getByTestId("transcript-turn")).toHaveCount(4);
});

test("sends a key typed into it to the gateway, and keeps it in none of its logs or data", async () => {
  test.skip(WINDOWS, NO_GATEWAY);
  // Admin access first: only admin connections start a sign-in.
  await page.keyboard.press("Meta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Accounts", exact: true }).click();
  await settings.getByRole("button", { name: "Request admin access" }).click();
  await expect
    .poll(() => devGateway(INSTANCE, "approve"), { timeout: 30_000, intervals: [1000] })
    .toMatch(/^Approved /m);
  const connect = settings.getByRole("button", { name: "Connect an account" }).first();
  await expect(connect).toBeVisible({ timeout: 30_000 });
  await connect.click();
  await settings.locator("details.b-disclosure summary").click();
  await settings.getByRole("combobox", { name: "Provider" }).selectOption("acme");
  const field = settings.getByTestId("api-key");
  await field.fill(TYPED_KEY);
  await settings.getByRole("button", { name: "Save key" }).click();
  await expect(settings.getByRole("heading", { name: "Key saved" })).toBeVisible({
    timeout: 30_000,
  });
  await settings.getByRole("textbox", { name: "Label" }).fill("Packaged");
  await settings.getByRole("button", { name: "Done" }).click();
  // On the gateway: the account its key made, as the app reads it back.
  await expect(settings.getByRole("button", { name: /^Acme · Packaged, API key/ })).toBeVisible({
    timeout: 20_000,
  });
  await page.keyboard.press("Escape");
  // Nowhere the app writes: its output (its log) and every file in its data folder.
  expect(APP_LOG, "the app's log").not.toBe("");
  expect(readFileSync(APP_LOG, "utf8").length, "the app's log has its output").toBeGreaterThan(0);
  expect(holds(APP_LOG, TYPED_KEY)).toEqual([]);
  expect(holds(USER_DATA, TYPED_KEY)).toEqual([]);
  expect(holds(join(homedir(), "Library/Logs/Clawtrate"), TYPED_KEY)).toEqual([]);
  expect(await page.content()).not.toContain(TYPED_KEY);
});

/** The label macOS shows on the app's dock icon, as Launch Services reports it; null for none. */
function dockBadge(pid: number): string | null {
  const out = execFileSync("lsappinfo", ["info", "-only", "StatusLabel", String(pid)], {
    encoding: "utf8",
  });
  return /"label"="([^"]*)"/.exec(out)?.[1] ?? null;
}

/** A gateway method with this run's instance's own operator credentials. */
async function gatewayCall<T>(method: string, params: unknown): Promise<T> {
  const result = await openInstance(INSTANCE).runner.run([
    "gateway",
    "call",
    method,
    "--params",
    JSON.stringify(params),
    "--json",
  ]);
  if (result.status !== 0) throw new Error(`${method} failed:\n${result.stdout}${result.stderr}`);
  return parseJsonOutput<T>(result.stdout);
}

test("F-023: the dock badge counts the unread tasks, and follows what the gateway says of them", async () => {
  test.skip(WINDOWS, NO_GATEWAY);
  const unread = async () =>
    (
      await gatewayCall<{ sessions: Array<{ key: string; unread?: boolean }> }>("sessions.list", {
        limit: 200,
        excludeCron: true,
        excludeSubagents: true,
      })
    ).sessions.filter((row) => row.unread === true);
  // A count is shown, no more than the gateway's unread tasks: those this device has read
  // (the one on screen, and those it opened on the way) are not counted again.
  const listed = await unread();
  await expect.poll(() => Number(dockBadge(APP_PID) ?? 0), { timeout: 20_000 }).toBeGreaterThan(0);
  const shown = Number(dockBadge(APP_PID));
  expect(shown).toBeLessThanOrEqual(listed.length);
  // A task of Pip's, which this device never opened: read by another client, the badge takes
  // one away; unread again, it comes back.
  const pip = listed.find((row) => row.key.startsWith("agent:pip:"));
  expect(pip, "an unread task of Pip's").toBeTruthy();
  await gatewayCall("sessions.patch", { key: pip!.key, unread: false });
  await expect.poll(() => dockBadge(APP_PID), { timeout: 20_000 }).toBe(String(shown - 1));
  await gatewayCall("sessions.patch", { key: pip!.key, unread: true });
  await expect.poll(() => dockBadge(APP_PID), { timeout: 20_000 }).toBe(String(shown));
});

test("keeps the device key and tokens in its own data folder, readable by the user only", () => {
  test.skip(WINDOWS, `${NO_GATEWAY}, so the app has paired with none and written no key`);
  const dir = join(USER_DATA, "gateway");
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  const files = readdirSync(dir);
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    expect(statSync(join(dir, file)).mode & 0o077, file).toBe(0);
  }
});

test("stays on its own content", async () => {
  // A navigation the page starts is refused, and so is a window for anything
  // but the web. Checked from inside the page: the refused navigation leaves
  // Playwright waiting for one to finish.
  const result = await page.evaluate(async () => {
    const before = location.href;
    const win = window.open("file:///etc/hosts");
    location.href = "https://example.invalid/";
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return {
      windowRefused: win === null,
      stayed: location.href === before,
      bots: document.querySelectorAll('[data-testid="bot"]').length,
    };
  });
  // Paired on macOS, so the seeded bots are still shown; on Windows the connect screen is.
  expect(result).toEqual({ windowRefused: true, stayed: true, bots: WINDOWS ? 0 : 4 });
  expect(browser.contexts().flatMap((context) => context.pages())).toHaveLength(1);
});
