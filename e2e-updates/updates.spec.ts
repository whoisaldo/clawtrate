// The same main entry, sandboxed preload and renderer as the launch check.
// Only this temporary build links the service to the test's own feed.
import { expect, test as base, type Page, type TestInfo } from "@playwright/test";
import { once } from "node:events";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  statSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  cpSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import type { DesktopUpdates } from "../packages/core/src/desktop-updates.ts";
import { setTimeout as pause } from "node:timers/promises";
import { join } from "node:path";
import { sidebarGateway } from "../apps/desktop/test/update/sidebar-gateway.ts";
import { feedFor, feedServer, json, payload } from "../apps/desktop/test/update/harness.ts";
import { fileKeyFor, FILE_EXTENSION } from "../apps/desktop/src/main/update/feed.ts";
import { appEnv, debuggingPort } from "../e2e-packaged/desktop-driver.ts";
import { askToClose, forceEnd } from "../e2e-packaged/windows.ts";

type TestApp = {
  page: Page;
  server: Awaited<ReturnType<typeof feedServer>>;
  filePath: string;
  body: Buffer;
  profile: string;
  resume: () => void;
  manifest: Record<string, unknown>;
  rendererRequests: string[];
};

type ProbeWindow = Window & {
  clawtrateHost: { desktopUpdates: DesktopUpdates };
  seenUpdates: string[];
};

async function stopElectron(app: ChildProcess) {
  const { pid } = app;
  if (!pid || app.exitCode !== null || app.signalCode !== null) return;
  const deadline = AbortSignal.timeout(25_000);
  const exited = once(app, "exit", { signal: deadline });
  const windows = process.platform === "win32";
  const force = () => {
    if (windows) forceEnd(pid);
    else app.kill("SIGKILL");
  };
  const timer = setTimeout(force, 15_000);
  try {
    if (windows) {
      if (askToClose(pid)) force();
    } else app.kill("SIGTERM");
    await exited;
  } catch (error) {
    if (deadline.aborted)
      throw new Error(`Electron PID ${pid} did not exit after forced shutdown`, { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
const test = base.extend<{ desktopApp: TestApp }>({
  desktopApp: async ({ playwright }, use) => {
    const desktop = join(import.meta.dirname, "../apps/desktop");
    const require = createRequire(join(desktop, "package.json"));
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "clawtrate-update-app-")));
    const cleanup = new AsyncDisposableStack();
    cleanup.defer(() =>
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
    );
    const resume = Promise.withResolvers<void>();
    try {
      const server = await feedServer();
      cleanup.defer(() => server.close());
      const key = fileKeyFor(process.platform, process.arch);
      if (!key) throw new Error("The desktop check needs a supported package target");
      const { body, sha512 } = payload(4000000);
      const filePath = "/file." + FILE_EXTENSION[key];
      const file = { url: server.origin + filePath, size: body.length, sha512 };
      const manifest = feedFor(server.origin, "1.1.0", file, { files: { [key]: file } });
      server.route("/stable", json(manifest));
      server.route(
        "/nightly",
        json({ ...manifest, track: "nightly", version: "0.1.0-nightly.20261101.1" }),
      );
      server.route(filePath, async (_, response) => {
        response.writeHead(200, { "content-length": body.length });
        response.write(body.subarray(0, 2000000));
        await resume.promise;
        response.end(body.subarray(2000000));
      });
      const env = appEnv();
      execFileSync(
        process.execPath,
        [
          join(desktop, "node_modules/electron-vite/bin/electron-vite.js"),
          "build",
          "--config",
          "test/update/electron.config.ts",
          "--outDir",
          join(dir, "out"),
        ],
        {
          cwd: desktop,
          env: { ...env, UPDATE_SCREEN_TEST_PORT: String(server.port) },
          timeout: 60_000,
          killSignal: "SIGKILL",
        },
      );
      cpSync(join(desktop, "resources"), join(dir, "resources"), { recursive: true });
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "update-screen-test",
          version: "0.1.0",
          type: "module",
          main: "out/main/index.js",
        }),
      );
      symlinkSync(
        join(desktop, "node_modules"),
        join(dir, "node_modules"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const profile = join(dir, "profile");
      const app = spawn(
        require("electron"),
        [dir, "--user-data-dir=" + profile, "--remote-debugging-port=0"],
        {
          cwd: dir,
          env: {
            ...env,
            CLAWTRATE_DEV_INSTANCE: "update-ui-test",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      // The app's own output, its last 16 KiB, read as it comes so a full pipe never holds it.
      let output = "";
      const keep = (chunk: Buffer) => (output = (output + chunk.toString("utf8")).slice(-16_384));
      app.stdout!.on("data", keep);
      app.stderr!.on("data", keep);
      cleanup.defer(() => stopElectron(app));
      await once(app, "spawn");
      const port = await debuggingPort(profile, app).catch((error: Error) => {
        // What the app printed and what its data folder holds say where its start stopped.
        let files: string;
        try {
          files = readdirSync(profile).join(", ");
        } catch (cause) {
          files = String(cause);
        }
        throw new Error(`${error.message}\nData folder: ${files}\nApp output:\n${output}`, {
          cause: error,
        });
      });
      const browser = await playwright.chromium.connectOverCDP("http://127.0.0.1:" + port);
      cleanup.defer(() => browser.close());
      const context = browser.contexts()[0]!;
      const page = context.pages()[0] ?? (await context.waitForEvent("page"));
      await page.locator(".app").waitFor();
      const rendererRequests: string[] = [];
      page.on("request", (r) => {
        if (/^https?:/.test(r.url())) rendererRequests.push(r.url());
      });
      await use({
        page,
        server,
        filePath,
        body,
        profile,
        resume: resume.resolve,
        manifest,
        rendererRequests,
      });
    } finally {
      // A locked or unreadable diagnostic must not skip the cleanup.
      try {
        const failure = join(dir, "profile", "folder-error.txt");
        if (existsSync(failure))
          console.error("Update folder:", readFileSync(failure, "utf8").slice(0, 4096));
      } catch (error) {
        console.error("Update folder diagnostic unreadable:", error);
      }
      resume.resolve();
      await cleanup.disposeAsync();
    }
  },
});

// A failure may be visible only in the host's state, which fixture teardown closes away.
test.afterEach(async ({ desktopApp }, testInfo) => {
  if (testInfo.status === "passed" || testInfo.status === "skipped") return;
  // A test that captured before its own cleanup keeps that snapshot.
  if (testInfo.attachments.some((each) => each.name === "host-state")) return;
  await captureHostState(desktopApp.page, testInfo, desktopApp.server, desktopApp.rendererRequests);
});

test("F-231: checks only the chosen feed and downloads matching bytes on request", async ({
  desktopApp,
}) => {
  const { page, server, filePath, body, manifest, resume, rendererRequests } = desktopApp;
  await page.keyboard.press("ControlOrMeta+,");
  await page.getByRole("button", { name: "Updates", exact: true }).click();
  const line = page.locator(".updates-section dd").last();
  await expect(line).toHaveText("Not checked yet.");
  await expect(
    page.getByText("Checks 127.0.0.1 for a newer build, only when you choose to."),
  ).toBeVisible();
  await expect(page.getByText("Clawtrate 0.1.0", { exact: false }).first()).toBeVisible();
  await expect(page.getByRole("radio", { name: "Stable" })).toBeChecked();
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  expect(server.requests).toEqual([]);
  await page.getByRole("button", { name: "Check for Updates" }).click();
  await expect(line).toHaveText("Clawtrate 1.1.0 is offered by the update source.");
  expect(server.requests).toEqual(["/stable"]);
  await expect(page.locator("#update-source")).toHaveText(
    "Downloads Clawtrate 1.1.0 from 127.0.0.1, only when you choose to.",
  );
  const download = page.getByRole("button", { name: "Download", exact: true });
  await download.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("group", { name: "Update status" })).toBeFocused();
  // Windows prepares two protected directories before it requests the first byte.
  await expect.poll(() => server.requests, { timeout: 35_000 }).toContain(filePath);
  await expect
    .poll(async () => Number(await page.getByRole("progressbar").getAttribute("value")))
    .toBeGreaterThan(0);
  const bar = page.getByRole("progressbar");
  expect(Number(await bar.getAttribute("value"))).toBeLessThan(body.length);
  await expect(bar).toHaveAttribute("max", String(body.length));
  const total = await page.evaluate((size) => size.toLocaleString(), body.length);
  await expect(line).toContainText(`of ${total} bytes`);
  expect(server.requests).toEqual(["/stable", filePath]);
  await expect(line).not.toContainText("checksum");
  resume();
  // Windows reads the file back in PowerShell, which first compiles its C# helper.
  await expect(line).toHaveText(
    "Clawtrate 1.1.0 is downloaded, and its size and checksum match the update source. Installation isn't available from this screen.",
    { timeout: 30_000 },
  );
  await expect(page.getByRole("button", { name: "Restart to Update" })).toHaveCount(0);
  const nightly = page.getByRole("radio", { name: "Nightly" });
  await nightly.click();
  await expect(nightly).toBeChecked();
  await expect(line).toHaveText("Not checked yet.");
  expect(server.requests).toEqual(["/stable", filePath]);
  await page.getByRole("button", { name: "Check for Updates" }).click();
  await expect(line).toHaveText(
    "No newer Nightly build was offered. Clawtrate 0.1.0 is still running.",
  );
  expect(server.requests).toEqual(["/stable", filePath, "/nightly"]);

  // Same size, different checksum. Only a new check can offer another download.
  const damaged = Buffer.from(body);
  damaged[0] = damaged[0]! ^ 1;
  server.route(filePath, (_req, res) => res.end(damaged));
  const stable = page.getByRole("radio", { name: "Stable" });
  await stable.click();
  await expect(stable).toBeChecked();
  await page.getByRole("button", { name: "Check for Updates" }).click();
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(line).toHaveText("The downloaded file doesn't match the update source.");
  await expect(page.getByRole("button", { name: "Restart to Update" })).toHaveCount(0);
  const key = fileKeyFor(process.platform, process.arch)!;
  const files = manifest.files as Record<string, { size: number; sha512: string; url: string }>;
  server.route(
    "/stable",
    json({ ...manifest, files: { [key]: { ...files[key]!, size: body.length + 1 } } }),
  );
  server.route(filePath, (_req, res) => res.end(body));
  await page.getByRole("button", { name: "Check for Updates" }).click();
  await expect(line).toHaveText("Clawtrate 1.1.0 is offered by the update source.");
  expect(server.requests).toEqual([
    "/stable",
    filePath,
    "/nightly",
    "/stable",
    filePath,
    "/stable",
  ]);

  await download.click();
  await expect(line).toHaveText("The downloaded file doesn't match the update source.");
  await expect(page.getByRole("button", { name: "Restart to Update" })).toHaveCount(0);
  const reading = await page.evaluate(() =>
    (window as unknown as ProbeWindow).clawtrateHost.desktopUpdates.get(),
  );
  expect(reading.state).toMatchObject({
    kind: "failed",
    stage: "download",
    reason: "size-mismatch",
  });
  expect(server.requests).toEqual([
    "/stable",
    filePath,
    "/nightly",
    "/stable",
    filePath,
    "/stable",
    filePath,
  ]);
  expect(rendererRequests).toEqual([]);
});

/** A failure may be visible only in the host's state, which teardown closes away. */
async function captureHostState(
  page: Page,
  info: TestInfo,
  server: TestApp["server"],
  rendererRequests: string[],
) {
  try {
    const reading = await Promise.race([
      page.evaluate(() => (window as unknown as ProbeWindow).clawtrateHost.desktopUpdates.get()),
      pause(10_000).then(() => null),
    ]).catch((cause) => ({ error: String(cause) }));
    const file = join(info.outputDir, "host-state.json");
    mkdirSync(info.outputDir, { recursive: true });
    writeFileSync(
      file,
      JSON.stringify(
        { reading, requests: server.requests, rendererRequests, notes: info.annotations },
        null,
        2,
      ),
    );
    await info.attach("host-state", { path: file, contentType: "application/json" });
  } catch {
    // The failure under diagnosis still outranks the diagnostics.
  }
}

/** Which element has focus, in words, for a failure's notes. */
const focusedElement = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return "none";
    const name = el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 60) ?? "";
    return `${el.tagName.toLowerCase()}${el.getAttribute("role") ? `[role=${el.getAttribute("role")}]` : ""} ${name}`;
  });

async function checkStable() {
  const api = (window as unknown as ProbeWindow).clawtrateHost.desktopUpdates;
  return api.check("stable", (await api.get()).revision);
}
for (const stage of ["check", "download"] as const) {
  test(`F-231: retires a held ${stage} while saving a track`, async ({ desktopApp }) => {
    const { page, server, filePath, body, profile, manifest, resume } = desktopApp;
    const delayed = Promise.withResolvers<void>();
    if (stage === "check")
      server.route("/stable", async (req, res) => {
        await delayed.promise;
        json(manifest)(req, res);
      });
    try {
      await page.keyboard.press("ControlOrMeta+,");
      await page.getByRole("button", { name: "Updates", exact: true }).click();
      await page.evaluate(() => {
        const w = window as unknown as ProbeWindow;
        w.seenUpdates = [];
        const updates = w.clawtrateHost.desktopUpdates;
        updates.subscribe(() => {
          throw new Error("A subscriber failed");
        });
        updates.subscribe((s) => {
          w.seenUpdates.push(s.state.kind);
        });
      });
      const status = page.getByRole("group", { name: "Update status" });
      const check = page.getByRole("button", { name: "Check for Updates" });
      const download = page.getByRole("button", { name: "Download", exact: true });
      const stable = page.getByRole("radio", { name: "Stable" }),
        nightly = page.getByRole("radio", { name: "Nightly" });
      await check.focus();
      const notes = test.info().annotations;
      notes.push({ type: "focus before Enter", description: await focusedElement(page) });
      await page.keyboard.press("Enter");
      notes.push({ type: "focus after Enter", description: await focusedElement(page) });
      await expect(status).toBeFocused();
      await expect.poll(() => server.requests).toEqual(["/stable"]);
      let id = "";
      if (stage === "download") {
        await expect(download).toBeVisible();
        id = await page.evaluate(async () => {
          const s = await (window as unknown as ProbeWindow).clawtrateHost.desktopUpdates.get();
          return s.state.kind === "offered" ? s.state.offerId : "";
        });
        expect(id).not.toBe("");
        await download.click();
        await expect.poll(() => server.requests, { timeout: 35_000 }).toContain(filePath);
        await expect
          .poll(async () => Number(await page.getByRole("progressbar").getAttribute("value")))
          .toBeGreaterThan(0);
        await page.keyboard.press("Escape");
        await page.keyboard.press("ControlOrMeta+,");
        await expect(page.getByRole("progressbar")).toBeVisible();
      }
      const before = stage === "check" ? ["/stable"] : ["/stable", filePath];
      writeFileSync(join(profile, "hold-choice"), "");
      if (stage === "download") writeFileSync(join(profile, "refuse-choice"), "");
      await nightly.click();
      const pending = page
        .locator(".b-hint")
        .filter({ hasText: "Saving Nightly as the update track…" });
      await expect(pending).toBeVisible();
      await expect(stable).toBeChecked();
      await expect(check).toHaveCount(0);
      await expect(download).toHaveCount(0);
      await expect(page.locator("#update-source")).toHaveCount(0);
      await expect(page.getByRole("progressbar")).toHaveCount(0);
      await nightly.press("ArrowLeft");
      await nightly.press("Space");
      await expect(stable).toBeChecked();
      const busy = await page.evaluate(checkStable);
      expect(busy.outcome).toBe("busy");
      delayed.resolve();
      resume();
      await expect(status.locator("dd")).toHaveText("Not checked yet.");
      await expect(pending).toBeVisible();
      rmSync(join(profile, "hold-choice"));
      await expect(pending).toHaveCount(0);
      await expect(stage === "check" ? nightly : stable).toBeChecked();
      await expect(check).toBeVisible();
      if (stage === "download") {
        const notice = page.getByText("Couldn't save the track. Stable is still selected.", {
          exact: true,
        });
        await expect(notice).toBeVisible();
        const stale = await page.evaluate(
          (id) => (window as unknown as ProbeWindow).clawtrateHost.desktopUpdates.download(id),
          id,
        );
        expect(stale.outcome).toBe("stale");
        await expect(notice).toBeVisible();
      } else {
        const stale = await page.evaluate(checkStable);
        expect(stale.outcome).toBe("stale");
      }
      expect(server.requests).toEqual(before);
      const seen = await page.evaluate(() => (window as unknown as ProbeWindow).seenUpdates);
      expect(seen).toContain("checking");
      if (stage === "download")
        expect(seen).toEqual(expect.arrayContaining(["offered", "downloading", "not-checked"]));
      server.route("/stable", json(manifest));
      server.route(filePath, (_req, r) => r.end(body));
      if (stage === "check") {
        await stable.click();
        await expect(stable).toBeChecked();
      }
      await check.click();
      await download.click();
      await expect(status).toContainText("checksum match");
      expect(await page.evaluate(() => (window as unknown as ProbeWindow).seenUpdates)).toContain(
        "verified",
      );
    } catch (error) {
      // Cleanup releases the held choice, so the failure's state is read first.
      await captureHostState(page, test.info(), server, desktopApp.rendererRequests);
      throw error;
    } finally {
      delayed.resolve();
      resume();
      rmSync(join(profile, "hold-choice"), { force: true });
    }
  });
}

test("F-231: a stale check or download reconciles the screen without contacting a different source or file", async ({
  desktopApp,
}) => {
  const { page, profile, server, manifest } = desktopApp;
  await page.keyboard.press("ControlOrMeta+,");
  await page.getByRole("button", { name: "Updates", exact: true }).click();
  const line = page.locator(".update-result dd");
  const check = page.getByRole("button", { name: "Check for Updates" });
  const download = page.getByRole("button", { name: "Download", exact: true });
  const hold = join(profile, "hold-events");
  writeFileSync(hold, "");
  const choice = await page.evaluate(() =>
    (window as unknown as ProbeWindow).clawtrateHost.desktopUpdates.chooseTrack("nightly"),
  );
  expect(choice.outcome).toBe("accepted");
  await expect(page.getByRole("radio", { name: "Stable" })).toBeChecked();
  await check.click();
  await expect(page.getByRole("radio", { name: "Nightly" })).toBeChecked();
  await expect(page.locator(".update-result")).toContainText(
    "The update track changed. Check the selected source again.",
  );
  expect(server.requests).toEqual([]);
  rmSync(hold);
  await page.getByRole("radio", { name: "Stable" }).click();
  await expect(page.getByRole("radio", { name: "Stable" })).toBeChecked();
  await check.click();
  await expect(line).toContainText("1.1.0 is offered");
  writeFileSync(hold, "");
  server.route("/stable", json({ ...manifest, version: "1.2.0" }));
  const second = await page.evaluate(checkStable);
  expect(second.snapshot.state.kind).toBe("offered");
  await expect(line).toContainText("1.1.0 is offered");
  await download.click();
  await expect(line).toContainText("1.2.0 is offered");
  expect(server.requests).toEqual(["/stable", "/stable"]);
});

test("F-231: an older Check on the same track preserves the verified download", async ({
  desktopApp,
}) => {
  const { page, profile, server, filePath, body, resume } = desktopApp;
  await page.keyboard.press("ControlOrMeta+,");
  await page.getByRole("button", { name: "Updates", exact: true }).click();
  const line = page.locator(".update-result dd");
  writeFileSync(join(profile, "hold-events"), "");
  const {
    snapshot: { state: offer },
  } = await page.evaluate(checkStable);
  if (offer.kind !== "offered") throw new Error("Expected an offer");
  resume();
  const verified = await page.evaluate(
    (id) => (window as unknown as ProbeWindow).clawtrateHost.desktopUpdates.download(id),
    offer.offerId,
  );
  expect(verified.snapshot.state).toMatchObject({ kind: "verified", offerId: offer.offerId });
  const offerDir = join(profile, "updates", offer.offerId);
  const files = readdirSync(offerDir);
  expect(files).toHaveLength(1);
  const artifact = join(offerDir, files[0]!);
  expect(readFileSync(artifact).equals(body)).toBe(true);
  await expect(line).toHaveText("Not checked yet.");
  expect(server.requests).toEqual(["/stable", filePath]);
  await page.getByRole("button", { name: "Check for Updates" }).click();
  await expect(line).toContainText("its size and checksum match the update source.");
  await expect(
    page.getByRole("button", { name: /^(Check for Updates|Download|Restart to Update)$/ }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      (window as unknown as ProbeWindow).clawtrateHost.desktopUpdates.get(),
    ),
  ).toEqual(verified.snapshot);
  expect(readFileSync(artifact).equals(body)).toBe(true);
  expect(server.requests).toEqual(["/stable", filePath]);
});

if (process.platform !== "win32")
  test("F-231 F-030: a storage-blocked check opens from the sidebar and retries the chosen feed", async ({
    desktopApp,
  }) => {
    const { page, profile, server } = desktopApp;
    const gateway = await sidebarGateway();
    const mode = statSync(profile).mode & 0o777;
    try {
      // The first screen asks where OpenClaw runs; the address-and-token form is under Advanced.
      await page.getByRole("button", { name: "Advanced" }).click();
      await page.getByPlaceholder("Gateway address").fill(gateway.url);
      await page.getByRole("button", { name: "Connect a gateway", exact: true }).click();
      await expect(page.locator(".rail")).toBeVisible();
      const entry = page.getByRole("button", { name: "Open Updates" });
      await expect(entry).toHaveCount(0);
      await page.keyboard.press("ControlOrMeta+,");
      await page.getByRole("button", { name: "Updates", exact: true }).click();
      chmodSync(profile, 0o770);
      await page.getByRole("button", { name: "Check for Updates" }).click();
      const line = page.locator(".update-result dd");
      const notice = page
        .locator(".update-result")
        .getByText("Couldn't prepare update storage on this device.", { exact: true });
      await expect(line).toHaveText("Couldn't check for updates.");
      await expect(notice).toBeVisible();
      const retry = page.getByRole("button", { name: "Try again" });
      await expect(retry).toBeVisible();
      await page.keyboard.press("Escape");
      await entry.click();
      await expect(line).toHaveText("Couldn't check for updates.");
      await expect(notice).toBeVisible();
      expect(server.requests).toEqual([]);
      chmodSync(profile, mode);
      await retry.click();
      await expect(line).toContainText("is offered by the update source.");
      await expect(notice).toHaveCount(0);
      expect(server.requests).toEqual(["/stable"]);
    } finally {
      chmodSync(profile, mode);
      await gateway.close();
    }
  });
