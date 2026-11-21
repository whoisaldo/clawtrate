// The search palette against this run's own development gateway
// (docs/design/search.md): a preview host of its own paired at the read tier,
// and a paired admin operator that adds one routine, named with this run's
// stamp, and removes it afterwards. Messages, files and routines come from the
// gateway's own `sessions.search`, `sessions.files.list` and `cron.list`.
import { expect, test, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInstance, openOperator } from "../tools/dev-gateway/src/cli.ts";
import type { OperatorSession } from "../tools/dev-gateway/src/operator.ts";
import { scriptedRoutine } from "../tools/dev-gateway/src/routines.ts";
import { devGateway, startHost, stopChild } from "./global-setup.ts";

const INSTANCE = process.env.CLAWTRATE_DEV_INSTANCE!;
const STATIC = process.env.CLAWTRATE_E2E_STATIC!;
const STAMP = Date.now().toString(36);

let host: { child: ChildProcess; data: string } | null = null;
let page: Page;
let admin: OperatorSession;
let routineId: string | null = null;

const palette = () => page.getByTestId("search-palette");
const group = (id: string) => palette().getByTestId(`search-group-${id}`);
const options = (id: string) => group(id).getByRole("option");

async function search(text: string) {
  if (await palette().count()) await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+K");
  await palette().getByRole("combobox", { name: "Search" }).fill(text);
  // Once nothing in view is pending, the live region speaks.
  await expect(palette().getByTestId("search-announcer")).not.toHaveText("", { timeout: 20_000 });
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  expect(INSTANCE, "a named instance").toMatch(/^[a-z0-9-]+$/);
  admin = await openOperator(
    openInstance(INSTANCE),
    "Clawtrate search check",
    ["operator.admin", "operator.read"],
    [],
  );
  const job = (await admin.request(
    "cron.add",
    scriptedRoutine(`Search check ${STAMP}`, "pip"),
  )) as {
    id: string;
  };
  routineId = job.id;
  await admin.request("cron.update", { id: job.id, patch: { enabled: false } });
  const data = mkdtempSync(join(tmpdir(), "clawtrate-search-"));
  const started = startHost(INSTANCE, STATIC, data);
  started.gated.release();
  host = { child: started.host, data };
  const url = await started.url;
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    timezoneId: "America/New_York",
    locale: "en-US",
  });
  page = await context.newPage();
  await page.goto(url);
  await page.getByRole("button", { name: "Use the development gateway" }).click();
  await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible({
    timeout: 20_000,
  });
  await expect
    .poll(() => devGateway(INSTANCE, "approve"), { timeout: 30_000, intervals: [1000] })
    .toMatch(/^Approved /m);
  await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 30_000 });
});

test.afterAll(async () => {
  test.setTimeout(120_000);
  if (routineId) await admin.request("cron.remove", { id: routineId }).catch(() => {});
  await admin?.close();
  await page?.context().close();
  if (host) {
    await stopChild(host.child).catch(() => host?.child.kill("SIGKILL"));
    rmSync(host.data, { recursive: true, force: true });
  }
});
process.once("exit", () => host?.child.kill("SIGKILL"));

test("F-033: on a read-only connection, messages, files and routines come from the gateway, each group saying what it searched", async () => {
  await search("transcode");
  // The seeded conversation's own words, as `sessions.search` returned them.
  const user = options("messages").filter({ hasText: "Disk almost full on the media box · User" });
  await expect(user.first()).toContainText("Yes, clear the transcode cache.");
  await expect(group("messages")).toContainText(/newest first/);
  // Files are searched through each bot's newest task, and say what they covered.
  await search("mountain");
  await expect(options("files").filter({ hasText: "mountain-weekend.md" })).toContainText(
    "lists · Pip",
  );
  await expect(group("files")).toContainText("Some folders may be skipped.");
  // A routine that is off is found by its name, with its bot.
  await search(STAMP);
  const routine = options("routines").filter({ hasText: `Search check ${STAMP}` });
  await expect(routine).toContainText("Pip · Off");
});

test("F-033: a message from the gateway's search opens in its conversation, scrolled into view and ringed", async () => {
  await search("clear the transcode");
  const user = options("messages")
    .filter({ hasText: "Disk almost full on the media box · User" })
    .first();
  await user.click();
  await expect(palette()).toHaveCount(0);
  await expect(page.locator(".title-pill-task")).toHaveText("Disk almost full on the media box");
  const unit = page
    .locator(".transcript .msg-unit")
    .filter({ hasText: "Yes, clear the transcode cache." });
  await expect(unit).toBeInViewport();
  await expect(unit.locator(".bubble")).toHaveClass(/search-hit/);
  await expect(page.locator(".turn[data-search-focus]")).toBeFocused();
});
