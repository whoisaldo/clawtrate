// The Work pane's Computer tab against real development gateways
// (work-pane.md, Part 3): the run's seeded instance with the computer plugin
// (`e2e-<run>-computer`, whose Marlow and Pip have browsers of their own,
// confined to the instance's scripted pages on loopback), and the run's main
// instance, which has no plugin. Bots act as the gateway's owner makes them,
// through the scripted model's browser directives. Each check works in a task
// of its own, on preview hosts of its own, so none relies on another's state.
//
// With CLAWTRATE_COMPUTER_SHOTS=<folder outside the repository>, it also saves
// screenshots of what it checked there.
import { expect, test, type Browser, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserPorts, instancePorts, openInstance } from "../tools/dev-gateway/src/cli.ts";
import { parseJsonOutput } from "../tools/dev-gateway/src/env.ts";
import { PAGES_RECORD_PATH } from "../tools/dev-gateway/src/scripted-pages.ts";
import { readMarker } from "../tools/dev-gateway/src/state-guard.ts";
import { execFileSync } from "node:child_process";
import { devGateway, FORBIDDEN_PORTS, startHost, stopChild } from "./global-setup.ts";

const COMPUTER = process.env.CLAWTRATE_E2E_COMPUTER!;
const MAIN = process.env.CLAWTRATE_DEV_INSTANCE!;
const SHOTS = process.env.CLAWTRATE_COMPUTER_SHOTS ?? null;

async function openclaw(instance: string, args: string[]): Promise<string> {
  const result = await openInstance(instance).runner.run(args);
  if (result.status !== 0)
    throw new Error(`openclaw ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

const gatewayCall = async <T>(instance: string, method: string, params: unknown): Promise<T> =>
  parseJsonOutput<T>(
    await openclaw(instance, [
      "gateway",
      "call",
      method,
      "--params",
      JSON.stringify(params),
      "--json",
    ]),
  );

/** A task of Pip's on the computer instance, with a label. */
async function createTask(slug: string, label: string): Promise<string> {
  const key = `agent:pip:${slug}`;
  await gatewayCall(COMPUTER, "sessions.create", { key, agentId: "pip", label });
  return key;
}

/** A run in the task, as the gateway's owner starts one; resolves with its output when it ends. */
const runInTask = (key: string, message: string) =>
  openclaw(COMPUTER, [
    "agent",
    "--agent",
    "pip",
    "--session-key",
    key,
    "--message",
    message,
    "--json",
  ]);

/** What the scripted pages recorded of the input that reached them since `since`. */
async function pageRecord(
  since = 0,
): Promise<{ events: Array<{ kind: string; value: string }>; seq: number }> {
  const ports = instancePorts(openInstance(COMPUTER));
  const { pagesPort } = browserPorts(ports, ["marlow", "pip"]);
  expect(FORBIDDEN_PORTS).not.toContain(pagesPort);
  const answer = await fetch(`http://127.0.0.1:${pagesPort}${PAGES_RECORD_PATH}?since=${since}`);
  return (await answer.json()) as { events: Array<{ kind: string; value: string }>; seq: number };
}

/** Preview hosts this file started, stopped when it ends. */
const hosts: Array<() => Promise<void>> = [];
async function hostOn(instance: string): Promise<string> {
  const data = mkdtempSync(join(tmpdir(), "clawtrate-e2e-computer-"));
  const started = startHost(instance, process.env.CLAWTRATE_E2E_STATIC!, data);
  started.gated.release();
  hosts.push(async () => {
    await stopChild(started.host);
    rmSync(data, { recursive: true, force: true });
  });
  const url = await started.url;
  expect(FORBIDDEN_PORTS).not.toContain(Number(new URL(url).port));
  return url;
}
test.afterAll(async () => {
  for (const stop of hosts.splice(0)) await stop();
});

/** Pair a page's host with an instance, as its owner approves the request. */
async function pair(page: Page, url: string, instance: string) {
  await page.goto(url);
  await page.getByRole("button", { name: "Use the development gateway" }).click();
  await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible({
    timeout: 20_000,
  });
  await expect
    .poll(() => devGateway(instance, "approve"), { timeout: 30_000, intervals: [1000] })
    .toMatch(/^Approved /m);
  await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 30_000 });
}

/** Ask for the interactive tier in an open task, and approve it on the gateway. */
async function grant(page: Page, instance: string) {
  const bar = page.getByRole("region", { name: "Access" });
  await bar.getByRole("button", { name: /^Request (access|again)$/ }).click();
  await expect
    .poll(() => devGateway(instance, "approve"), { timeout: 30_000, intervals: [1000] })
    .toMatch(/^Approved /m);
  await expect(page.getByTestId("composer-input")).toBeVisible({ timeout: 30_000 });
}

const botRow = (page: Page, bot: string) =>
  page.getByTestId("bot-list").getByRole("button", { name: new RegExp(`^${bot}\\b`) });

async function openTask(page: Page, bot: string, task: string) {
  const back = page.getByRole("button", { name: "Back to bots" });
  if (await back.isVisible()) await back.click();
  const row = botRow(page, bot);
  if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
  const list = page.getByRole("list", { name: `${bot}'s tasks` });
  const all = list.getByRole("button", { name: /^Show all/ });
  if (await all.isVisible()) await all.click();
  await list.getByTestId("task").filter({ hasText: task }).click();
  await expect(page.getByRole("button", { name: new RegExp(`^${bot}, ${task}\\.`) })).toBeVisible();
}

const panel = (page: Page) => page.locator("#work-tabpanel-computer");
const full = (page: Page) => page.getByTestId("screen-view");
const bar = (page: Page) => full(page).getByTestId("control-bar");

async function showComputer(page: Page) {
  if ((await page.locator(".shell").getAttribute("data-panel")) !== "open")
    await page.getByRole("button", { name: "Show work panel" }).click();
  await page.getByRole("tab", { name: /^Computer/ }).click();
}

/** Watch, and wait for a picture: the canvas has the page's frame. */
async function watch(page: Page) {
  await panel(page).getByRole("button", { name: "Watch Pip's browser" }).click({ timeout: 30_000 });
  await expect
    .poll(
      () =>
        panel(page)
          .locator(".screen[data-state=live] canvas")
          .evaluate((canvas: HTMLCanvasElement) => canvas.width)
          .catch(() => 0),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
}

/** A click at a point of the page, in its own CSS pixels, through the picture. */
async function clickPage(page: Page, x: number, y: number) {
  const frame = full(page).getByTestId("screen-frame");
  const point = await frame.evaluate(
    (element, at) => {
      const canvas = element.querySelector("canvas")!;
      const rect = canvas.getBoundingClientRect();
      const width = Number(element.getAttribute("data-page-width"));
      const height = Number(element.getAttribute("data-page-height"));
      const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
      const left = rect.left + (rect.width - canvas.width * scale) / 2;
      const top = rect.top + (rect.height - canvas.height * scale) / 2;
      return {
        x: left + (at.x / width) * canvas.width * scale,
        y: top + (at.y / height) * canvas.height * scale,
      };
    },
    { x, y },
  );
  await page.mouse.click(point.x, point.y);
}

async function shoot(
  page: Page,
  name: string,
  themes: Array<"light" | "dark"> = ["light", "dark"],
) {
  if (!SHOTS) return;
  for (const theme of themes) {
    await page.emulateMedia({ colorScheme: theme });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, `${name}-${theme}.png`) });
  }
  await page.emulateMedia({ colorScheme: null });
}

/** A page on a host of its own on the computer instance, paired, and granted when asked. */
async function viewer(browser: Browser, granted: boolean, label: string) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await pair(page, await hostOn(COMPUTER), COMPUTER);
  await openTask(page, "Pip", label);
  if (granted) await grant(page, COMPUTER);
  return { page, close: () => context.close() };
}

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

const WATCH_TASK = "Computer watch";
let watchKey: Promise<string> | null = null;
/**
 * The task the Watch checks share, created and browsed by whichever of them runs first, so a
 * run that selects only some of them (`-g`) still has it.
 */
const watchTask = () =>
  (watchKey ??= createTask("e2e-computer-watch", WATCH_TASK).then(async (key) => {
    await runInTask(key, "#browse");
    return key;
  }));

test("F-139 F-142: a bot opens a scripted loopback page in its own browser; the Computer tab shows nothing until Watch, then the page live, full window on Open", async ({
  browser,
}) => {
  await watchTask();
  const { page, close } = await viewer(browser, true, WATCH_TASK);
  try {
    // The header's button appears once the task used the browser tool, and opens Computer.
    const button = page.getByTestId("computer-button");
    await expect(button).toHaveAccessibleName("Pip's computer. Show the computer");
    await button.click();
    await expect(page.getByRole("tab", { name: "Computer" })).toBeFocused();
    // The precondition: the bot's own browser call opened the page on the gateway.
    await expect(
      panel(page).getByTestId("computer-actions"),
      "Pip's browser call failed on the gateway, so there is no page to watch",
    ).not.toContainText("Couldn't use the browser");
    // The tab list is the plugin's answer, read from the bot's browser: wait for it.
    await expect(panel(page).getByTestId("computer-caption")).toContainText(
      "Pip's browser, used by all of its tasks",
      { timeout: 30_000 },
    );
    await expect(panel(page).getByTestId("computer-caption")).toContainText(
      "Scripted sign-in · 127.0.0.1:",
    );
    await expect(panel(page).locator("canvas")).toHaveCount(0);
    await expect(panel(page).getByTestId("computer-machine")).toContainText(
      "The gateway's machine, in Pip's own browser",
    );
    await watch(page);
    await shoot(page, "watching-1440");
    // The scripted page is quiet: its screencast sends no frame while nothing changes, and after
    // 10 s without a usable frame the tile no longer says Live, though the view is renewed.
    await expect(panel(page).locator(".screen-live")).toHaveText(/^Last picture, 1\d s ago$/, {
      timeout: 20_000,
    });
    await expect(panel(page).locator(".screen[data-state=live] canvas")).toHaveCount(1);
    await panel(page).getByRole("button", { name: "Open Pip's browser full window" }).click();
    await expect(full(page)).toContainText("Pip's browser");
    await expect(full(page)).toContainText("Watching");
    await expect
      .poll(() =>
        full(page)
          .locator("canvas")
          .evaluate((canvas: HTMLCanvasElement) => canvas.width)
          .catch(() => 0),
      )
      .toBeGreaterThan(0);
    await shoot(page, "full-view-1440");
    await page.keyboard.press("Escape");
    await expect(full(page)).toHaveCount(0);
    await panel(page).getByRole("button", { name: "Stop watching" }).click();
    await expect(panel(page).getByRole("button", { name: "Watch Pip's browser" })).toBeVisible();
  } finally {
    await close();
  }
});

test("F-142 F-145: a take is refused while the bot acts and granted once its work has settled; typed input reaches the page; giving control back frees the bot", async ({
  browser,
}) => {
  const key = await watchTask();
  const { page, close } = await viewer(browser, true, WATCH_TASK);
  try {
    await showComputer(page);
    await watch(page);
    await panel(page).getByRole("button", { name: "Open Pip's browser full window" }).click();
    // Nothing of the bot's runs: control is granted, with its second line.
    await full(page).getByRole("button", { name: "Take control" }).click();
    await expect(bar(page)).toContainText(
      "You have control" +
        "Pip's new browser actions are paused. Something it already started can still change this page.",
      { timeout: 60_000 },
    );
    await shoot(page, "control-bar-1440");
    // The page is the scripted sign-in page: its name field is at (40, 110) to (440, 150).
    const before = (await pageRecord()).seq;
    await clickPage(page, 240, 130);
    await page.keyboard.type("scripted reader");
    await expect
      .poll(
        async () =>
          (await pageRecord(before)).events.some(
            (e) => e.kind === "text" && e.value === "scripted reader",
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    // Escape in control never hands back; it moves to Give back control.
    await page.keyboard.press("Escape");
    await expect(bar(page).getByRole("button", { name: "Give back control" })).toBeFocused();
    await expect(full(page)).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(full(page).getByText("Watching", { exact: true })).toBeVisible({
      timeout: 20_000,
    });

    // The bot acts in its browser: a slow navigation, past the plugin's drain deadline.
    const slow = runInTask(key, "#browse-slow");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("computer-button")).toHaveAttribute("data-active", "true", {
      timeout: 60_000,
    });
    await expect(page.getByRole("tab", { name: "Computer, in use" })).toBeVisible();
    await panel(page).getByRole("button", { name: "Open Pip's browser full window" }).click();
    await full(page).getByRole("button", { name: "Take control" }).click();
    await expect(bar(page)).toContainText("Waiting for the gateway to confirm control…");
    await expect(bar(page)).toContainText(
      /Pip is still acting in this browser\. Try again in a moment\.|A page in Pip's browser is still loading\.|Can't see whether Pip's browser has settled/,
      { timeout: 30_000 },
    );
    await expect(bar(page)).not.toContainText("You have control");
    await expect(bar(page).getByRole("button", { name: "Try again" })).toBeVisible();
    // The view went on through the bot's work: renewed well within the plugin's own deadline.
    await expect(full(page).locator("canvas")).toHaveCount(1);
    await shoot(page, "take-refused-1440");
    await slow;
    await expect(full(page).locator("canvas")).toHaveCount(1);
    // Settled: the same take, again, is granted.
    await expect(async () => {
      await bar(page).getByRole("button", { name: "Try again" }).click({ timeout: 2_000 });
      await expect(bar(page)).toContainText("You have control", { timeout: 25_000 });
    }).toPass({ timeout: 90_000 });
    await bar(page).getByRole("button", { name: "Give back control" }).click();
    await expect(full(page).getByText("Watching", { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    // The bot's browser works again: its next browser call is not refused.
    const read = await runInTask(key, "#browse-read");
    expect(read).not.toContain("A person has control of my browser");
    if (SHOTS) {
      // The phone's full view, watching and in control.
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(full(page)).toHaveAttribute("data-layout", "phone");
      await shoot(page, "full-view-390", ["light"]);
      await full(page)
        .locator(".control-dock")
        .getByRole("button", { name: "Take control" })
        .click();
      await expect(full(page).locator(".control-dock")).toContainText("You have control", {
        timeout: 60_000,
      });
      await shoot(page, "control-bar-390", ["light"]);
      await full(page)
        .locator(".control-dock")
        .getByRole("button", { name: "Give back control" })
        .click();
      await expect(full(page).locator(".control-dock")).not.toContainText("You have control", {
        timeout: 20_000,
      });
    }
  } finally {
    await close();
  }
});

test("F-144 F-145: a real question while Pip's browser can be taken: its card, Waiting for you in the conversation and both rows, and Show the question on its own card; giving control back alone leaves it pending; the banner's Take control is granted, the bar's answer goes once control is given back, and Pip carries on", async ({
  browser,
}) => {
  const label = "Computer question";
  const key = await createTask("e2e-computer-question", label);
  await runInTask(key, "#browse");
  // The run asks and waits for the answer: it ends only once it is answered.
  const asking = runInTask(key, "#ask");
  const { page, close } = await viewer(browser, true, label);
  try {
    await showComputer(page);
    const banner = panel(page).getByTestId("computer-banner");
    await expect(banner).toContainText("Pip is waiting for you", { timeout: 60_000 });
    await expect(banner).toContainText("Which route should I plan for Saturday?");
    // The conversation shows the question's card; Pip's row and the task's row say it waits.
    const card = page
      .locator(".transcript [data-testid=question-card]")
      .filter({ hasText: "Which route should I plan for Saturday?" });
    await expect(card).toBeVisible();
    await expect(page.getByTestId("status-phrase")).toHaveText("Waiting for you");
    await expect(botRow(page, "Pip").first().locator(".bot-preview")).toHaveText(
      "Waiting for you: a question",
      { timeout: 30_000 },
    );
    await expect(page.getByTestId("task").filter({ hasText: label }).first()).toHaveAccessibleName(
      /, needs you$/,
    );
    // Show the question brings that question's card into view and focuses it, scrolled away or not.
    await page.locator(".transcript").evaluate((element: HTMLElement) => {
      let node: HTMLElement | null = element;
      while (
        node &&
        !(
          node.scrollHeight > node.clientHeight &&
          /auto|scroll/.test(getComputedStyle(node).overflowY)
        )
      )
        node = node.parentElement;
      if (node) node.scrollTop = 0;
    });
    await banner.getByRole("button", { name: "Show the question" }).click();
    await expect(card).toBeInViewport();
    await expect
      .poll(() => card.evaluate((element) => element.contains(document.activeElement)))
      .toBe(true);
    await showComputer(page);
    // Giving control back alone leaves the question unanswered.
    await banner.getByRole("button", { name: "Take control" }).click();
    await expect(bar(page)).toContainText("You have control", { timeout: 60_000 });
    await bar(page).getByRole("button", { name: "Give back control" }).click();
    await expect(full(page).getByText("Watching", { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(card).not.toContainText("Answered");
    await expect(page.getByTestId("status-phrase")).toHaveText("Waiting for you");
    await page.keyboard.press("Escape");
    await expect(full(page)).toHaveCount(0);
    await banner.getByRole("button", { name: "Take control" }).click();
    await expect(bar(page)).toContainText("You have control", { timeout: 60_000 });
    // The question is still the gateway's, pending, while control is held.
    await expect(card).not.toContainText("Answered");
    await bar(page).getByRole("button", { name: "Lake loop" }).click();
    await expect(bar(page)).toContainText("Answer sent. Pip can carry on.", { timeout: 30_000 });
    // Released first, then answered: the run goes on with its browser free.
    const output = await asking;
    expect(output).not.toContain("A person has control of my browser");
    const read = await runInTask(key, "#browse-read");
    expect(read).not.toContain("A person has control of my browser");
  } finally {
    await close();
  }
});

test("F-142: when the gateway stops answering renewals, You have control ends within the lease: input stops at once, and the bar says control isn't confirmed", async ({
  browser,
}) => {
  await watchTask();
  const { page, close } = await viewer(browser, true, WATCH_TASK);
  // This run's own instance's gateway, by its PID from the tool's marker: paused, never stopped.
  const marker = readMarker(openInstance(COMPUTER).stateDir);
  const pid = marker?.gatewayPid;
  expect(typeof pid === "number" && pid > 1, "the instance's gateway PID").toBe(true);
  // The gateway renames its process, so it is known by the port it listens on: this instance's.
  const port = marker?.gatewayPort;
  expect(FORBIDDEN_PORTS, "the instance's own gateway port").not.toContain(port);
  const listening = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
    encoding: "utf8",
  });
  expect(listening.split("\n"), "the PID is this instance's gateway").toContain(String(pid));
  let paused = false;
  try {
    await showComputer(page);
    await watch(page);
    await panel(page).getByRole("button", { name: "Open Pip's browser full window" }).click();
    await full(page).getByRole("button", { name: "Take control" }).click();
    await expect(bar(page)).toContainText("You have control", { timeout: 60_000 });
    const before = (await pageRecord()).seq;
    process.kill(pid!, "SIGSTOP");
    paused = true;
    // Within three quarters of the development contract's 6 s lease, with no answer and no event.
    await expect(bar(page)).toContainText(
      "The gateway hasn't confirmed that you still have control of Pip's browser. Input has stopped.",
      { timeout: 8_000 },
    );
    await full(page).getByTestId("screen-frame").focus();
    await page.keyboard.type("never sent");
    process.kill(pid!, "SIGCONT");
    paused = false;
    // Read again once the gateway answers: still held (the note under the bar), or ended; never a guess.
    await expect(full(page)).toContainText(/You still have control\.|Your control ended/, {
      timeout: 30_000,
    });
    await page.waitForTimeout(1_000);
    expect(
      (await pageRecord(before)).events.some((e) => e.value.includes("never sent")),
      "typed while control wasn't confirmed",
    ).toBe(false);
    if (await bar(page).getByRole("button", { name: "Give back control" }).isVisible())
      await bar(page).getByRole("button", { name: "Give back control" }).click();
  } finally {
    if (paused) process.kill(pid!, "SIGCONT");
    await close();
  }
});

test("F-142 F-144: a second device sees who holds the browser, and a read-only device is never offered control", async ({
  browser,
}) => {
  await watchTask();
  const holder = await viewer(browser, true, WATCH_TASK);
  const other = await viewer(browser, true, WATCH_TASK);
  const reader = await viewer(browser, false, WATCH_TASK);
  try {
    await showComputer(holder.page);
    await watch(holder.page);
    await holder.page.getByRole("button", { name: "Open Pip's browser full window" }).click();
    await full(holder.page).getByRole("button", { name: "Take control" }).click();
    await expect(bar(holder.page)).toContainText("You have control", { timeout: 60_000 });

    await showComputer(other.page);
    await expect(panel(other.page).getByTestId("computer-elsewhere")).toHaveText(
      "Someone on another device has control of Pip's browser.",
      { timeout: 30_000 },
    );
    // Its own take is refused, and says why; it is not given control.
    await watch(other.page);
    await other.page.getByRole("button", { name: "Open Pip's browser full window" }).click();
    await full(other.page).getByRole("button", { name: "Take control" }).click();
    await expect(bar(other.page)).toContainText(
      "Someone on another device has control of Pip's browser.",
    );
    await expect(bar(other.page)).not.toContainText("You have control");

    await showComputer(reader.page);
    await expect(panel(reader.page)).toContainText(
      "Watching needs a connection that can send. This device is read-only.",
    );
    await expect(panel(reader.page).getByRole("button", { name: "Request access" })).toBeVisible();
    await expect(
      panel(reader.page).getByRole("button", { name: /Watch|Take control/ }),
    ).toHaveCount(0);
    await expect(panel(reader.page).locator("canvas")).toHaveCount(0);
    // The control events reach every reader.
    await expect(panel(reader.page)).toContainText(
      "Someone on another device has control of Pip's browser.",
      {
        timeout: 30_000,
      },
    );

    await bar(holder.page).getByRole("button", { name: "Give back control" }).click();
    await expect(full(holder.page).getByText("Watching", { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(panel(other.page).getByTestId("computer-elsewhere")).toHaveCount(0, {
      timeout: 30_000,
    });
  } finally {
    await holder.close();
    await other.close();
    await reader.close();
  }
});

test("F-142 F-150: a dropped connection ends the view and control at once, and once connected again the tab reads the browser's leases before offering anything", async ({
  browser,
}) => {
  await watchTask();
  const { page, close } = await viewer(browser, true, WATCH_TASK);
  try {
    await showComputer(page);
    await watch(page);
    await page.getByRole("button", { name: "Open Pip's browser full window" }).click();
    await full(page).getByRole("button", { name: "Take control" }).click();
    await expect(bar(page)).toContainText("You have control", { timeout: 60_000 });
    await full(page).getByRole("button", { name: "Close the full view (Esc)" }).click();
    await page.keyboard.press("ControlOrMeta+,");
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("button", { name: "Disconnect" }).click();
    await page.keyboard.press("Escape");
    await expect(panel(page).getByTestId("computer-held")).toContainText(
      "The connection dropped. Input has stopped. The gateway ends control when it observes this connection close; check its state after reconnecting.",
    );
    await expect(panel(page).locator("canvas")).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+,");
    await settings.getByRole("button", { name: "Reconnect" }).click();
    await expect(settings.getByTestId("gateway-state")).toHaveText("Connected", {
      timeout: 20_000,
    });
    await page.keyboard.press("Escape");
    // The gateway revoked the lease when the old connection closed: the tab says control ended.
    await expect(panel(page)).toContainText("Your control ended.", { timeout: 30_000 });
    // The view does not come back by itself; watching again is the person's choice.
    await expect(panel(page)).toContainText("The view ended when the connection dropped.");
    await expect(panel(page).getByTestId("computer-elsewhere")).toHaveCount(0);
    await panel(page).getByRole("button", { name: "Watch again" }).click();
    await expect
      .poll(
        () =>
          panel(page)
            .locator(".screen[data-state=live] canvas")
            .evaluate((canvas: HTMLCanvasElement) => canvas.width)
            .catch(() => 0),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);
  } finally {
    await close();
  }
});

test("F-141: without the computer plugin the screen section says watching isn't set up, and the rest of the tab works", async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  try {
    await pair(page, await hostOn(MAIN), MAIN);
    await openTask(page, "Otto", "Disk almost full on the media box");
    await showComputer(page);
    await expect(panel(page).getByTestId("computer-noplugin")).toContainText(
      "Watching isn't set up on this gateway",
    );
    await expect(panel(page).getByTestId("computer-noplugin")).toContainText(
      "On a gateway without it, bots that use the browser may share one default profile, with its sign-ins.",
    );
    await expect(panel(page).getByTestId("computer-machine")).toContainText(
      "Command approval target",
    );
    await shoot(page, "noplugin-1440");
    if (SHOTS) {
      await page.setViewportSize({ width: 390, height: 844 });
      await shoot(page, "noplugin-390", ["light"]);
    }
  } finally {
    await context.close();
  }
});
