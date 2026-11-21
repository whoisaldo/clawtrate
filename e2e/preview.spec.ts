import { expect, test, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { protocolMismatch } from "../packages/core/src/connect-errors.ts";
import { openInstance } from "../tools/dev-gateway/src/cli.ts";
import { parseJsonOutput } from "../tools/dev-gateway/src/env.ts";
import {
  devGateway,
  FORBIDDEN_PORTS,
  listInstances,
  runningOthers,
  startHost,
  stopChild,
} from "./global-setup.ts";
import { leaveIdle } from "./teardown.ts";

/** This run's own development gateway instance, created by global setup. */
const INSTANCE = process.env.CLAWTRATE_DEV_INSTANCE!;

/**
 * Run an OpenClaw command on this run's instance, through the dev tool's own
 * guarded runner, which adds the instance's profile and refuses any other state.
 */
async function openclaw(args: string[]): Promise<string> {
  const result = await openInstance(INSTANCE).runner.run(args);
  if (result.status !== 0) {
    throw new Error(`openclaw ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  }
  return result.stdout;
}

/** A gateway method, called with the instance's own operator credentials. */
async function gatewayCall<T>(method: string, params: unknown): Promise<T> {
  return parseJsonOutput<T>(
    await openclaw(["gateway", "call", method, "--params", JSON.stringify(params), "--json"]),
  );
}

type SessionRow = {
  key: string;
  agentId?: string;
  updatedAt?: number | null;
  archived?: boolean;
  lastMessagePreview?: string;
  totalTokens?: number;
  contextTokens?: number;
};
type AgentRow = {
  id: string;
  kind?: string;
  name?: string;
  identity?: { name?: string; theme?: string };
};

const SESSION_LIST = {
  limit: 200,
  includeDerivedTitles: true,
  includeLastMessage: true,
  excludeCron: true,
  excludeSubagents: true,
};

async function openShell(page: Page) {
  await page.goto(process.env.CLAWTRATE_E2E_URL!);
  await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 20_000 });
}

/**
 * A bot's row, by its accessible name: the name, then its number of tasks. The
 * title pill's name also starts with the bot's name, so the count is part of it.
 */
function botRow(page: Page, bot: string) {
  return page.getByTestId("bot-list").getByRole("button", { name: new RegExp(`^${bot}\\b`) });
}

/**
 * Open a bot without folding it: the open bot's row folds and unfolds, so it is
 * clicked only when its tasks are not showing and it is not a single-task row
 * that is already current.
 */
async function openBot(page: Page, bot: string) {
  const row = botRow(page, bot);
  const expanded = await row.getAttribute("aria-expanded");
  const current = await row.getAttribute("aria-current");
  if (expanded === "true" || (expanded === null && current === "true")) return;
  await row.click();
}

async function openTask(page: Page, bot: string, task: string) {
  await openBot(page, bot);
  // A bot with one task shows no task rows: opening the bot is the whole action.
  const list = page.getByRole("list", { name: `${bot}'s tasks` });
  const rows = list.getByTestId("task");
  if ((await rows.count()) > 0) {
    // Past six tasks the rail lists the most recent; the rest are behind "Show all".
    const showAll = list.getByRole("button", { name: /^Show all/ });
    if ((await rows.filter({ hasText: task }).count()) === 0 && (await showAll.count()) > 0)
      await showAll.click();
    await rows.filter({ hasText: task }).first().click({ timeout: 20_000 });
  }
  await expect(page.getByRole("heading", { level: 1, name: task })).toBeVisible({
    timeout: 20_000,
  });
  // The heading shows while the history is still being read, and a count taken then misses
  // the task's earlier turns; live runs can show before the read ends, too. The read takes
  // seconds on a loaded machine.
  await expect(page.getByTestId("transcript")).toHaveAttribute("data-status", "ready", {
    timeout: 20_000,
  });
}

/**
 * A bot's task for one check alone, made on the gateway with its label as its title: no other
 * check's run, stop or message is in it, and no seeded task changes. New on every run, so a
 * repeated check never meets an earlier run's task.
 */
async function gatewayTask(botId: string, label: string): Promise<{ key: string; title: string }> {
  const suffix = randomBytes(4).toString("hex");
  const title = `${label} ${suffix}`;
  const key = `agent:${botId}:check-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${suffix}`;
  await gatewayCall("sessions.create", { key, agentId: botId, label: title });
  return { key, title };
}

/** A run in a task, as the gateway's owner starts one; resolves when it has ended. */
async function runOnGateway(botId: string, key: string, message: string): Promise<void> {
  await openclaw([
    "agent",
    "--agent",
    botId,
    "--session-key",
    key,
    "--message",
    message,
    "--thinking",
    "low",
    "--json",
  ]);
}

/** A bot's task rows, all of them: past six the rail lists the newest, the rest behind Show all. */
async function allTasks(page: Page, bot: string) {
  await openBot(page, bot);
  const list = page.getByRole("list", { name: `${bot}'s tasks` });
  const showAll = list.getByRole("button", { name: /^Show all/ });
  if ((await showAll.count()) > 0) await showAll.click();
  return list.getByTestId("task");
}

/** How many tasks the gateway lists for a bot now, as the rail counts them. */
async function gatewayTaskCount(botId: string): Promise<number> {
  const { sessions } = await gatewayCall<{ sessions: SessionRow[] }>("sessions.list", {
    ...SESSION_LIST,
    limit: 500,
  });
  return sessions.filter((row) => row.agentId === botId && !row.archived).length;
}

/**
 * A task of Otto's for one check alone, opened in the page: no other check's run, stop or
 * queued message can be in it. Its title is its label.
 */
async function ownTask(page: Page, label: string): Promise<{ key: string; title: string }> {
  return ownTaskOf(page, "otto", "Otto", label);
}

/** A new task of a bot's own, opened in the page. */
async function ownTaskOf(
  page: Page,
  botId: string,
  bot: string,
  label: string,
): Promise<{ key: string; title: string }> {
  const { key, title } = await gatewayTask(botId, label);
  await expect(
    page.getByRole("list", { name: `${bot}'s tasks` }).or(page.getByTestId("bot-list")),
  ).not.toHaveCount(0);
  await expect
    .poll(
      async () => {
        await openBot(page, bot);
        const list = page.getByRole("list", { name: `${bot}'s tasks` });
        const showAll = list.getByRole("button", { name: /^Show all/ });
        if ((await showAll.count()) > 0) await showAll.click();
        return list.getByTestId("task").filter({ hasText: title }).count();
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  await page
    .getByRole("list", { name: `${bot}'s tasks` })
    .getByTestId("task")
    .filter({ hasText: title })
    .first()
    .click();
  // A task with no message yet has no title heading ("Nothing here yet"); its title pill names it.
  await expect(page.getByRole("button", { name: `${bot}, ${title}. Show details.` })).toBeVisible();
  return { key, title };
}

/** The id of the run the gateway has in flight in a task: the exact run a check acts on. */
async function inFlightRunId(key: string): Promise<string> {
  let runId = "";
  await expect
    .poll(
      async () => {
        const history = await gatewayCall<{ inFlightRun?: { runId?: string } }>("chat.history", {
          sessionKey: key,
          limit: 1,
        });
        runId = history.inFlightRun?.runId ?? "";
        return runId;
      },
      { timeout: 30_000 },
    )
    .not.toBe("");
  return runId;
}

/** When the running check began: a check that fails leaves nothing it started after this. */
let checkStarted = 0;
/** The preview hosts the running check started for itself, stopped when it ends. */
let ownHosts: Array<() => Promise<void>> = [];
test.beforeEach(() => {
  checkStarted = Date.now();
  ownHosts = [];
});
// Playwright reads its fixtures from the first argument's pattern; this hook needs none.
// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  test.setTimeout(testInfo.timeout + 120_000);
  for (const stop of ownHosts) await stop();
  if (testInfo.status !== testInfo.expectedStatus) await leaveIdle(gatewayCall, checkStarted);
});

/**
 * A preview host of the running check's own, with no device and no pairing yet: a check that
 * pairs, or that asks for access, does it here, and leaves the shared host as it was.
 */
async function freshHost(): Promise<string> {
  const data = mkdtempSync(join(tmpdir(), "clawtrate-e2e-fresh-"));
  const started = startHost(INSTANCE, process.env.CLAWTRATE_E2E_STATIC!, data);
  started.gated.release();
  ownHosts.push(async () => {
    await stopChild(started.host);
    rmSync(data, { recursive: true, force: true });
  });
  const url = await started.url;
  expect(FORBIDDEN_PORTS).not.toContain(Number(new URL(url).port));
  return url;
}

/** Pair a page's host with the gateway, as its owner approves the request. */
async function pairOn(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.getByRole("button", { name: "Use the development gateway" }).click();
  await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible({
    timeout: 20_000,
  });
  await expect
    .poll(() => devGateway(INSTANCE, "approve"), { timeout: 30_000, intervals: [1000] })
    .toMatch(/^Approved /m);
  await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 30_000 });
}

/**
 * The shared preview host, paired and with interactive access, whichever checks run and in
 * whatever order: done here when it is not done yet, so no check relies on another's having
 * done it.
 */
test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto(process.env.CLAWTRATE_E2E_URL!);
    const connect = page.getByRole("button", { name: "Use the development gateway" });
    const bots = page.getByTestId("bot");
    await expect
      .poll(async () => (await connect.isVisible()) || (await bots.count()) === 4, {
        timeout: 30_000,
      })
      .toBe(true);
    if (await connect.isVisible()) await pairOn(page, process.env.CLAWTRATE_E2E_URL!);
    await openTask(page, "Otto", "Disk almost full on the media box");
    const bar = page.getByRole("region", { name: "Access" });
    const asking = bar.getByRole("button", { name: /^Request (access|again)$/ });
    if ((await asking.count()) > 0) {
      await asking.click();
      await expect
        .poll(() => devGateway(INSTANCE, "approve"), { timeout: 30_000, intervals: [1000] })
        .toMatch(/^Approved /m);
    }
    await expect(composer(page)).toBeVisible({ timeout: 30_000 });
  } finally {
    await context.close();
  }
});

/** The stop note of one run, by its id: never another run's note left from earlier. */
const stopNote = (page: Page, runId: string) =>
  page.locator(`[data-testid="stop-note"][data-run="${runId}"]`);

// Not serial: the checks run in file order on one worker (playwright.config.ts), each in a
// task of its own or on seeded tasks it leaves as it found them, so one failing on timing
// does not keep the others from running.

test("runs on its own instance while another instance's gateway is listening", () => {
  expect(INSTANCE, "global setup names this run's instance").toMatch(/^e2e-[0-9a-f]{8}$/);
  const rows = listInstances();
  const mine = rows.find((row) => row.name === INSTANCE)!;
  expect(mine.gatewayRunning).toBe(true);
  expect(mine.stateDir).toMatch(new RegExp(`\\.openclaw-clawtrate-dev-${INSTANCE}$`));
  for (const port of [mine.gatewayPort, mine.providerPort]) {
    expect(FORBIDDEN_PORTS).not.toContain(port);
  }
  expect(FORBIDDEN_PORTS).not.toContain(Number(new URL(process.env.CLAWTRATE_E2E_URL!).port));
  // The sentinel, and anything else that was running, is up and has its own ports.
  const sentinel = rows.find((row) => row.name === process.env.CLAWTRATE_E2E_SENTINEL);
  expect(sentinel?.gatewayRunning).toBe(true);
  for (const other of rows.filter((row) => row.gatewayRunning && row.name !== INSTANCE)) {
    expect(other.gatewayPort).not.toBe(mine.gatewayPort);
    expect(other.providerPort).not.toBe(mine.providerPort);
  }
});

test("F-002 F-003 F-009: pairs with the development gateway in steps, says when the pairing request is no longer pending, and shows bots, tasks and a transcript", async ({
  page,
}) => {
  expect(process.env.CLAWTRATE_E2E_URL, "global setup provides the preview URL").toBeTruthy();
  // Behave like the plain-http remote preview: no secure context, no clipboard API.
  await page.addInitScript(() => {
    Object.defineProperty(window, "isSecureContext", { get: () => false });
    Object.defineProperty(Navigator.prototype, "clipboard", { get: () => undefined });
  });
  // A host of this check's own, never paired: the pairing it checks starts from nothing.
  await page.goto(await freshHost());

  await expect(page.getByRole("heading", { name: "Clawtrate" })).toBeVisible();
  await page.getByRole("button", { name: "Use the development gateway" }).click();

  // A fresh device identity must be approved on the gateway host, over the real protocol.
  await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible();
  // The pairing screen shows the product's mark alone, named for the product.
  await expect(page.getByRole("img", { name: "Clawtrate" })).toBeVisible();
  const pairing = page.locator(".panel");
  // The development gateway is approved with the dev tooling, never an unqualified
  // command that would address a default-profile gateway.
  await expect(pairing.locator(".command code")).toHaveText([
    `pnpm dev-gateway approve --instance ${INSTANCE}`,
  ]);
  await expect(pairing).not.toContainText("openclaw devices approve");

  // Copying works without the clipboard API.
  await pairing.getByRole("button", { name: "Copy approve command" }).click();
  await expect(pairing.locator(".copy-status")).toHaveText(/Copied\.|Press .+ to copy\./);

  // F-003: setting up is a list of steps; this one is connected and waiting for approval.
  const steps = page.getByTestId("setup-steps").locator("li");
  await expect(steps.nth(0)).toHaveText(/^Connected to 127\.0\.0\.1:\d+$/);
  await expect(steps.nth(1)).toHaveText(/^Waiting for approval/);
  await expect(steps.nth(2)).toHaveText("Load bots");
  // F-002: the request lists exactly the scope the device asked for.
  const scopes = pairing.getByRole("list", { name: "This device asks to" }).locator("li");
  await expect(scopes).toHaveCount(1);
  await expect(scopes).toHaveAttribute("data-scope", "operator.read");
  type Pending = { requestId: string; displayName?: string; scopes?: string[] };
  const listed = parseJsonOutput<{ pending?: Pending[] }>(
    await openclaw(["devices", "list", "--json"]),
  );
  const request = (listed.pending ?? []).find((r) => r.displayName?.startsWith("Clawtrate"))!;
  expect(request.scopes).toEqual(["operator.read"]);
  await expect(page.locator(".connect-foot")).toContainText(request.requestId.slice(0, 8));

  // F-009: the gateway's owner rejects the request. The gateway tells this
  // client only that its request is gone, so the app says it was rejected or
  // expired, and offers to try again.
  await openclaw(["devices", "reject", request.requestId]);
  const alert = page.getByRole("alert");
  await expect(alert.locator("strong")).toHaveText("The pairing request is no longer pending", {
    timeout: 15_000,
  });
  await expect(alert).toContainText("It was rejected, or it expired before anyone approved it");
  await alert.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible();
  await expect(page.locator(".connect-foot")).not.toContainText(request.requestId.slice(0, 8));

  devGateway(INSTANCE, "approve");

  // The pairing screen reconnects by itself once the request is approved.
  const bots = page.getByTestId("bot");
  await expect(bots).toHaveCount(4, { timeout: 20_000 });
  await expect(page.getByTestId("setup-steps")).toHaveCount(0);
  // Every seeded bot; their order is checked against the gateway's activity below.
  expect((await page.locator(".bot-list .bot-name").allTextContents()).sort()).toEqual([
    "Juniper",
    "Marlow",
    "Otto",
    "Pip",
  ]);

  // Every task the gateway lists for Otto: the three scripted tasks and the seeded approval
  // example, and any task another check has made.
  const tasks = await allTasks(page, "Otto");
  await expect
    .poll(async () => (await tasks.count()) === (await gatewayTaskCount("otto")))
    .toBe(true);
  await expect(tasks).toContainText([
    "List the workspace (approved)",
    "Certificate renewal warning",
    "Weekly backup check",
    "Disk almost full on the media box",
  ]);

  await openTask(page, "Otto", "Disk almost full on the media box");
  const turns = page.getByTestId("transcript-turn");
  await expect(turns).toHaveCount(4);
  await expect(turns.nth(0)).toContainText("The media box says the disk is 94% full");
  await expect(turns.nth(1)).toContainText("The usual suspects on a media box");
  await expect(page.getByTestId("tool-call")).toHaveCount(3);

  // Each action is a card. Opened, it shows what came back; its Raw tab, the
  // arguments and the gateway's result as sent.
  const read = page.locator('[data-testid="tool-call"][data-kind="read"]');
  await expect(read.locator(":scope > summary")).toHaveAccessibleName(/^Read AGENTS\.md/);
  await read.locator(":scope > summary").click();
  await expect(read.getByRole("tabpanel")).toContainText(
    "You are Otto, the operator for a small home server.",
  );
  await read.getByRole("tab", { name: "Raw" }).click();
  await expect(read.getByRole("region", { name: "What the gateway sent" })).toContainText(
    '"path": "AGENTS.md"',
  );

  // The footer is the gateway menu's button; its name and dot carry the state.
  const gateway = page.getByRole("button", { name: /, connected\. Open the gateway menu\.$/ });
  await expect(gateway).toBeVisible();
  await expect(gateway.locator(".status-dot")).toHaveAttribute("data-status", "connected");
});

test("two tabs on one host each show a task's transcript: one opened while the other has it open, and one reloaded while the other holds it", async ({
  page,
}) => {
  const TASK = "Disk almost full on the media box";
  const ASKED = "The media box says the disk is 94% full. What is eating the space?";
  await openShell(page);
  await openTask(page, "Otto", TASK);
  await expect(page.locator(".transcript")).toContainText(ASKED, { timeout: 20_000 });
  // A second tab opens the task the first has open: the host follows it already.
  const second = await page.context().newPage();
  await openShell(second);
  await openTask(second, "Otto", TASK);
  await expect(second.locator(".transcript")).toContainText(ASKED, { timeout: 20_000 });
  // Reloaded while the first tab holds the task, it shows it again.
  await openShell(second);
  await openTask(second, "Otto", TASK);
  await expect(second.locator(".transcript")).toContainText(ASKED, { timeout: 20_000 });
  await second.close();
});

test("a task stays read after it was opened", async ({ page }) => {
  await openShell(page);
  await openTask(page, "Otto", "Weekly backup check");
  await openTask(page, "Otto", "Disk almost full on the media box");
  const backup = page.getByTestId("task").filter({ hasText: "Weekly backup check" });
  await expect(backup).toHaveAttribute("data-unread", "false");
  await page.reload();
  await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 20_000 });
  // Otto is restored as the open bot and is already unfolded; a click would fold it.
  await openBot(page, "Otto");
  await expect(backup).toHaveAttribute("data-unread", "false");
});

test("F-015 F-017 F-019 F-031 F-425: the rail lists the gateway's bots by recent activity, with the primary bot's star, labels, previews and times", async ({
  page,
}) => {
  await openShell(page);
  const [{ sessions }, agents] = await Promise.all([
    gatewayCall<{ sessions: SessionRow[] }>("sessions.list", SESSION_LIST),
    gatewayCall<{ defaultId: string; agents: AgentRow[] }>("agents.list", {}),
  ]);
  const latest = new Map<string, number>();
  for (const row of sessions) {
    if (row.archived || !row.agentId) continue;
    latest.set(row.agentId, Math.max(latest.get(row.agentId) ?? 0, row.updatedAt ?? 0));
  }
  const bots = agents.agents.filter((agent) => agent.kind !== "system");
  const name = (agent: AgentRow) => agent.identity?.name ?? agent.name ?? agent.id;
  // F-031: recent activity, the default order: the latest message in any task, newest first.
  const expected = [...bots]
    .sort((a, b) => (latest.get(b.id) ?? -Infinity) - (latest.get(a.id) ?? -Infinity))
    .map(name);
  await expect(page.locator(".bot-list > .bot-group > .bot .bot-name")).toHaveText(expected);
  await expect(page.getByRole("button", { name: /^Sort bots/ })).toHaveAccessibleName(
    "Sort bots: Recent activity",
  );

  for (const agent of bots) {
    const row = botRow(page, name(agent));
    // F-015: the gateway's default bot carries the star, and only it.
    await expect(row.getByTestId("primary-star")).toHaveCount(
      agent.id === agents.defaultId ? 1 : 0,
    );
    // F-019: the label is the agent's identity theme.
    await expect(row.locator(".bot-label")).toHaveText(agent.identity!.theme!);
    // F-017: a preview of the latest message and the time of the latest activity.
    const newest = sessions
      .filter((s) => s.agentId === agent.id && !s.archived)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]!;
    const words = newest
      .lastMessagePreview!.replace(/[*_`#|]/g, "")
      .split(/\s+/)
      .slice(0, 3);
    await expect(row.locator(".bot-preview")).toContainText(words.join(" "));
    await expect(row.locator(".bot-time")).toHaveText(/^(\d{1,2}:\d{2}\s[AP]M|Yesterday)$/);
  }
  expect(agents.defaultId).toBe("main");
  await expect(page.getByTestId("primary-star")).toHaveCount(1);

  // F-425: a bot's tasks show their titles and times, and its fold is remembered.
  const ottoTasks = await allTasks(page, "Otto");
  await expect(ottoTasks.first()).toBeVisible();
  await expect(ottoTasks.locator(".task-time")).toHaveText(
    Array(await ottoTasks.count()).fill(/^(\d{1,2}:\d{2}\s[AP]M|Yesterday)$/),
  );
  await botRow(page, "Pip").focus();
  await page.keyboard.press("ArrowRight");
  await page.reload();
  await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 20_000 });
  await expect(botRow(page, "Pip")).toHaveAttribute("aria-expanded", "true");
});

test("F-013 F-027 F-266: this device keeps its pins and hidden bots under the gateway's own identity", async ({
  page,
}) => {
  const identity = await gatewayCall<{ deviceId: string }>("gateway.identity.get", {});
  expect(identity.deviceId).toMatch(/^[0-9a-f]{64}$/);
  // A connection that only reads keeps its own arrangement while the gateway holds none: a
  // host of this check's own, paired and nothing more. One that writes keeps it on the
  // gateway for every device, which `rail-tasks.spec.ts` checks.
  await pairOn(page, await freshHost());
  await botRow(page, "Otto").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pin" }).click();
  await expect(page.locator('.pin-grid .pin[data-bot="otto"]')).toBeVisible();
  const keys = await page.evaluate(() =>
    Object.keys(localStorage).filter((key) => key.startsWith("clawtrate.roster")),
  );
  expect(keys).toEqual([`clawtrate.roster:gateway:${identity.deviceId}`]);
  await page.locator('.pin-grid .pin[data-bot="otto"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: "Unpin" }).click();
  await expect(page.locator(".pin-grid")).toHaveCount(0);
});

test("F-059 F-063: a task's header shows the gateway's context use, and stamps separate its blocks", async ({
  page,
}) => {
  await openShell(page);
  await openTask(page, "Otto", "Disk almost full on the media box");
  const { sessions } = await gatewayCall<{ sessions: SessionRow[] }>("sessions.list", SESSION_LIST);
  const row = sessions.find((s) => s.key === "agent:otto:disk-space")!;
  expect(row.totalTokens).toBeGreaterThan(0);
  expect(row.contextTokens).toBe(128_000);
  await expect(page.getByTestId("task-context")).toHaveText(
    `Context: ${row.totalTokens!.toLocaleString("en-US")} of ${row.contextTokens!.toLocaleString("en-US")} tokens`,
  );
  // The seeded messages are seconds apart: one stamp, before the first message.
  await expect(page.locator(".transcript .stamp")).toHaveText([
    /^(Today|Yesterday) \d{1,2}:\d{2}\s[AP]M$/,
  ]);
  await expect(page.locator(".msg .bubble").first()).toHaveAttribute("title", /\d:\d\d/);
});

test("F-076: find matches a phrase from the gateway's reply across its bold text", async ({
  page,
}) => {
  await openShell(page);
  await openTask(page, "Otto", "Disk almost full on the media box");
  // The seeded reply says "The disk is now at **61%**.": the figure is bold.
  await expect(page.locator(".msg .bubble strong", { hasText: "61%" })).toBeVisible();
  await page.locator(".transcript").focus();
  await page.keyboard.press("ControlOrMeta+F");
  await page.getByRole("textbox", { name: "Find in conversation" }).fill("the disk is now at 61%");
  await expect(page.getByTestId("find-bar").getByRole("status")).toHaveText("1 of 1");
  const current = await page.evaluate(() => {
    const registry = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights;
    return [...(registry.get("clawtrate-find-current") ?? [])][0]?.toString();
  });
  expect(current).toBe("The disk is now at 61%");
  await page.keyboard.press("Escape");
});

test("the conversation keeps its width and the work panel becomes a drawer", async ({ page }) => {
  await openShell(page);
  await openTask(page, "Otto", "Disk almost full on the media box");
  await page.getByRole("button", { name: "Show work panel" }).click();
  for (const [width, height] of [
    [1440, 900],
    [1100, 700],
    [800, 600],
  ] as const) {
    await page.setViewportSize({ width, height });
    await expect(page.getByTestId("work-panel")).toBeVisible();
    const conversation = await page.locator(".conversation").boundingBox();
    expect(conversation!.width, `conversation width at ${width}px`).toBeGreaterThanOrEqual(440);
  }

  // Work docks when the conversation keeps 600px: from a 1240px window.
  await page.setViewportSize({ width: 1240, height: 800 });
  await expect(page.getByTestId("work-panel")).not.toHaveAttribute("role", "dialog");
  const docked = await page.locator(".conversation").boundingBox();
  expect(docked!.width, "conversation beside docked Work").toBeGreaterThanOrEqual(600);
  await page.setViewportSize({ width: 1239, height: 800 });
  await expect(page.getByTestId("work-panel")).toHaveAttribute("role", "dialog");

  // Narrow: Escape closes the drawer.
  await page.setViewportSize({ width: 800, height: 600 });
  await page.keyboard.press("Escape");
  await expect(page.locator(".shell")).toHaveAttribute("data-panel", "closed");

  // At 688px both panes still show, and the conversation keeps 440px.
  await page.setViewportSize({ width: 688, height: 600 });
  await expect(page.locator(".rail")).toBeVisible();
  await expect(page.locator(".conversation")).toBeVisible();
  const narrow = await page.locator(".conversation").boundingBox();
  expect(narrow!.width, "conversation width at 688px").toBeGreaterThanOrEqual(440);

  // Narrowest: the rail and the conversation take turns.
  await page.setViewportSize({ width: 600, height: 600 });
  await page.getByRole("button", { name: "Back to bots" }).click();
  const ottoTasks = page.getByRole("list", { name: "Otto's tasks" });
  await expect(ottoTasks).toBeVisible();
  await expect(page.locator(".conversation")).toBeHidden();
  // One pane shows three of an unfolded bot's tasks, so the rest of the list stays in view.
  await ottoTasks.getByRole("button", { name: /^Show all/ }).click();
  await ottoTasks.getByTestId("task").filter({ hasText: "Weekly backup check" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Weekly backup check" })).toBeVisible();
  await expect(ottoTasks).toBeHidden();
});

test("the overlay drawer takes keyboard focus and gives it back", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await openShell(page);
  await openTask(page, "Otto", "Disk almost full on the media box");
  if ((await page.locator(".shell").getAttribute("data-panel")) === "open") {
    await page.keyboard.press("Escape");
  }

  // Open by keyboard: focus moves into the drawer.
  await page.getByRole("button", { name: "Show work panel" }).focus();
  await page.keyboard.press("Enter");
  const close = page.getByRole("button", { name: "Close work panel" }).last();
  await expect(close).toBeFocused();

  // Tabbing never lands on anything the drawer covers.
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press("Tab");
    const placement = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      if (!active || active === document.body) return { inConversation: false, covered: false };
      const rect = active.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {
        inConversation: active.closest(".conversation") !== null,
        covered: rect.width > 0 && hit !== null && hit !== active && !active.contains(hit),
      };
    });
    expect(placement, `focus after ${i + 1} tabs`).toEqual({
      inConversation: false,
      covered: false,
    });
  }

  // Escape closes it and focus returns to the toggle.
  await page.keyboard.press("Escape");
  await expect(page.locator(".shell")).toHaveAttribute("data-panel", "closed");
  await expect(page.getByRole("button", { name: "Show work panel" })).toBeFocused();

  // The wide inline pane is ordinary page content: opening it keeps focus on the toggle.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Show work panel" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Hide work panel" })).toBeFocused();
  // Docked, Escape does not close Work; tidy up with the toggle.
  await page.getByRole("button", { name: "Hide work panel" }).click();
});

test("the rail names every bot", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await openShell(page);
  for (const name of ["Juniper", "Marlow", "Otto", "Pip"]) {
    await expect(botRow(page, name)).toBeVisible();
    await expect(botRow(page, name)).toContainText(name);
  }
  // A task title truncated in the 248px rail shows in full on keyboard focus,
  // and each task row shows the time of its latest activity.
  const ottoTasks = await allTasks(page, "Otto");
  await ottoTasks.filter({ hasText: "Disk almost full on the media box" }).focus();
  await expect(page.getByTestId("rail-tooltip")).toHaveText("Disk almost full on the media box");
  await expect(ottoTasks.locator(".task-time")).toHaveCount(await ottoTasks.count());
  await expect(ottoTasks.first().locator(".task-time")).not.toHaveText("");
  // A title that fits shows no tooltip. Beside its time it fits the 280px rail.
  await page.setViewportSize({ width: 1440, height: 900 });
  await ottoTasks.filter({ hasText: "Weekly backup check" }).focus();
  await expect(page.getByTestId("rail-tooltip")).toHaveCount(0);
});

test("on one pane a bot unfolds in place, and folding never changes the conversation", async ({
  page,
}) => {
  await openShell(page);
  await openTask(page, "Otto", "Disk almost full on the media box");
  // One pane shows the conversation first; Back shows the list.
  await page.setViewportSize({ width: 600, height: 700 });
  await page.getByRole("button", { name: "Back to bots" }).click();
  await openBot(page, "Juniper");
  await expect(botRow(page, "Juniper")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".conversation")).toBeHidden();
  const juniperTasks = page.getByRole("list", { name: "Juniper's tasks" }).getByTestId("task");
  await juniperTasks.first().click();
  await expect(page.locator(".conversation")).toBeVisible();
  await page.getByRole("button", { name: "Back to bots" }).click();
  await expect(botRow(page, "Juniper")).toHaveAttribute("aria-expanded", "true");

  // Two panes: folding the open bot keeps its conversation.
  await page.setViewportSize({ width: 1440, height: 900 });
  await openTask(page, "Otto", "Weekly backup check");
  await botRow(page, "Otto").click();
  await expect(botRow(page, "Otto")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("heading", { level: 1, name: "Weekly backup check" })).toBeVisible();
});

test("the gateway menu opens from the keyboard and keeps the theme", async ({ page }) => {
  await openShell(page);
  const trigger = page.getByRole("button", { name: /Open the gateway menu\.$/ });
  for (const key of ["ArrowUp", "ArrowDown"]) {
    await trigger.focus();
    await page.keyboard.press(key);
    // Focus starts on the checked theme, the menu's first checked item.
    await expect(page.getByRole("menuitemradio", { checked: true }).first()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  }
  await trigger.click();
  await page.getByRole("menuitemradio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 20_000 });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await trigger.click();
  await page.getByRole("menuitemradio", { name: "Match the system" }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme");
});

test("the drawer is modal, and focus follows it across the docking width", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await openShell(page);
  await openTask(page, "Otto", "Disk almost full on the media box");
  await page.getByRole("button", { name: "Show work panel" }).click();
  const work = page.getByTestId("work-panel");
  await expect(work).toHaveAttribute("role", "dialog");
  await expect(page.locator(".rail")).toHaveAttribute("inert", "");
  // Tab from the pane's last control returns to its first.
  const close = page.getByRole("button", { name: "Close work panel" }).last();
  await page.getByRole("tabpanel").focus();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");

  // Docked at 1440px with focus in the conversation; narrowing moves focus to Close.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Show work panel" }).click();
  await expect(work).not.toHaveAttribute("role", "dialog");
  await page.getByTestId("transcript").focus();
  await page.setViewportSize({ width: 1100, height: 700 });
  await expect(close).toBeFocused();
  // Widening again keeps the pane open, removes the role and moves nothing.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(work).toBeVisible();
  await expect(work).not.toHaveAttribute("role", "dialog");
  await expect(close).toBeFocused();
  await page.getByRole("button", { name: "Hide work panel" }).click();
});

/** A run the engine would hold, for injected state: running, started elsewhere. */
const INJECTED_RUN = {
  id: "injected",
  bound: true,
  state: "running",
  origin: "gateway",
  messageId: null,
  anchorItemId: null,
  phase: null,
  model: null,
  textSource: "chat",
  textItemId: null,
  textComplete: false,
  steps: [],
  pendingCards: [],
  suspendedCards: [],
  closedCards: [],
  endedAt: null,
  error: null,
  stopRequestedAt: null,
  finishedBeforeStop: false,
  stopError: null,
  lastSeq: null,
  ending: null,
  outcomeKnown: true,
  attemptErrors: [],
  omittedSteps: 0,
  nextReasoning: 0,
};

/** Proxy the bridge socket so a test can inject host state into the page. */
async function proxyBridge(page: Page) {
  let lastState: Record<string, unknown> | null = null;
  let toPage: ((message: string) => void) | null = null;
  let frozen = false;
  await page.routeWebSocket(/\/bridge$/, (ws) => {
    const server = ws.connectToServer();
    toPage = (message) => ws.send(message);
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      const parsed = JSON.parse(String(message)) as { state?: Record<string, unknown> };
      if (parsed.state) lastState = parsed.state;
      if (!frozen || !parsed.state) ws.send(message);
    });
  });
  return {
    /** Hold back the host's own snapshots, so injected state is not overwritten. */
    freeze() {
      frozen = true;
    },
    inject(change: (state: Record<string, unknown>) => Record<string, unknown>) {
      expect(lastState, "the host sent state").not.toBeNull();
      toPage!(JSON.stringify({ type: "state", state: change(structuredClone(lastState!)) }));
    },
  };
}

test("a streamed reply does not pull a reader away from older messages", async ({ page }) => {
  const bridge = await proxyBridge(page);
  await page.setViewportSize({ width: 1440, height: 700 });
  await openShell(page);
  await openTask(page, "Otto", "Disk almost full on the media box");
  const transcript = page.getByTestId("transcript");
  await expect(page.getByTestId("transcript-turn")).toHaveCount(4);
  await transcript.evaluate((element) => (element.scrollTop = 0));
  await page.waitForTimeout(100);

  const key = "agent:otto:disk-space";
  bridge.freeze();
  bridge.inject((state) => {
    const transcripts = state.transcripts as Record<string, { runs: unknown[] }>;
    transcripts[key]!.runs.push({
      ...INJECTED_RUN,
      text: "Checking the disk again.",
      startedAt: Date.now(),
    });
    return state;
  });
  await expect(page.getByTestId("live-turn")).toHaveCount(1);
  expect(await transcript.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(page.getByTestId("jump-latest")).toBeVisible();

  await page.getByTestId("jump-latest").click();
  await expect(page.getByTestId("jump-latest")).toBeHidden();
  const atEnd = await transcript.evaluate(
    (element) => element.scrollHeight - element.scrollTop - element.clientHeight < 2,
  );
  expect(atEnd).toBe(true);
});

test("a dropped connection keeps the shell and shows one status strip", async ({ page }) => {
  const bridge = await proxyBridge(page);
  await openShell(page);
  await openTask(page, "Otto", "Disk almost full on the media box");
  await expect(page.getByTestId("transcript-turn")).toHaveCount(4);
  const before = await page.locator(".rail").boundingBox();
  bridge.freeze();

  for (const status of ["reconnecting", "connecting", "reconnecting"]) {
    bridge.inject((state) => ({
      ...state,
      connection: {
        ...(state.connection as object),
        status,
        retryAt: Date.now() + 4000,
      },
    }));
    await expect(page.getByTestId("status-strip")).toContainText(/Reconnecting in [1-5]s/);
    await expect(page.getByTestId("transcript-turn")).toHaveCount(4);
  }
  // The strip floats; nothing moves.
  expect(await page.locator(".rail").boundingBox()).toEqual(before);
  await expect(page.getByRole("heading", { name: "Connect to your gateway" })).toHaveCount(0);
});

test("the status strip is centred on the conversation beside a docked Work pane", async ({
  page,
}) => {
  const bridge = await proxyBridge(page);
  await page.setViewportSize({ width: 1240, height: 800 });
  await openShell(page);
  await openTask(page, "Otto", "Disk almost full on the media box");
  await page.getByRole("button", { name: "Show work panel" }).click();
  await expect(page.getByTestId("work-panel")).not.toHaveAttribute("role", "dialog");
  bridge.freeze();
  bridge.inject((state) => ({
    ...state,
    connection: {
      ...(state.connection as object),
      status: "reconnecting",
      retryAt: Date.now() + 4000,
    },
  }));
  const strip = page.getByTestId("status-strip");
  await expect(strip).toContainText(/Reconnecting/);
  const s = (await strip.boundingBox())!;
  const c = (await page.locator(".conversation").boundingBox())!;
  expect(Math.abs(s.x + s.width / 2 - (c.x + c.width / 2))).toBeLessThanOrEqual(1);
  const retry = (await page.getByRole("button", { name: "Retry now" }).boundingBox())!;
  const hit = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x!, y!)?.textContent,
    [retry.x + retry.width / 2, retry.y + retry.height / 2],
  );
  expect(hit).toBe("Retry now");

  // With the transcript scrolled, nothing shows at the strip's height.
  await page.getByTestId("transcript").evaluate((element) => (element.scrollTop = 200));
  const mask = await page
    .getByTestId("transcript")
    .evaluate((element) => getComputedStyle(element).maskImage);
  expect(mask).toMatch(/rgba\(0, 0, 0, 0\) 90px, rgb\(0, 0, 0\) 98px/);
});

test("tool calls open to their arguments, result and error", async ({ page }) => {
  const bridge = await proxyBridge(page);
  await openShell(page);
  await openTask(page, "Otto", "Disk almost full on the media box");
  const read = page.locator('[data-testid="tool-call"][data-kind="read"]');
  await read.locator(":scope > summary").click();
  await read.getByRole("tab", { name: "Raw" }).click();
  await expect(read).toContainText("Arguments");
  await expect(read).toContainText("Result");

  // The seed's calls all succeed; inject a failed one to see its state.
  const key = "agent:otto:disk-space";
  bridge.freeze();
  bridge.inject((state) => {
    const transcripts = state.transcripts as Record<
      string,
      { items: Array<Record<string, unknown>> }
    >;
    transcripts[key]!.items.push({
      id: "injected-failure",
      role: "assistant",
      timestamp: Date.now(),
      model: null,
      blocks: [
        {
          kind: "tool-call",
          callId: "injected",
          name: "write",
          argumentsText: '{\n  "path": "/etc/hosts"\n}',
          result: { isError: true, text: "Permission denied" },
        },
      ],
    });
    return state;
  });
  const failed = page.locator('[data-testid="tool-call"][data-call="injected"]');
  await expect(failed.locator(":scope > summary")).toHaveAccessibleName(
    "Couldn't edit hosts, Permission denied, failed",
  );
  await failed.locator(":scope > summary").click();
  await expect(failed).toContainText("Error");
  await expect(failed).toContainText("Permission denied");
});

test("F-227 F-387 F-457: Settings shows the gateway, this device and its granted scopes; Disconnect keeps the pairing until Reconnect", async ({
  page,
}) => {
  // A host of this check's own, paired for reading only: its scopes are exactly that.
  await pairOn(page, await freshHost());
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const state = dialog.getByTestId("gateway-state");
  await expect(state).toHaveText("Connected");
  await expect(dialog.getByTestId("gateway-facts")).toContainText(
    `Address${process.env.CLAWTRATE_E2E_GATEWAY ?? "ws://127.0.0.1:"}`,
  );
  await expect(dialog.getByTestId("gateway-facts")).toContainText("This deviceClawtrate Web · ");
  // The scopes the gateway granted, from its hello.
  await expect(dialog.getByTestId("granted-scopes")).toHaveText("operator.read");
  await expect(dialog.getByTestId("gateway-facts")).toContainText(
    "OpenClaw 2026.10.6 · protocol 4",
  );

  await dialog.getByRole("button", { name: "Disconnect" }).click();
  await expect(state).toHaveText("Disconnected");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("status-strip")).toContainText("Disconnected");
  await expect(page.getByTestId("bot")).toHaveCount(4);
  // It stays disconnected, and reconnects with its own device token: no new pairing request.
  await page.waitForTimeout(1500);
  await page.keyboard.press("ControlOrMeta+,");
  await expect(state).toHaveText("Disconnected");
  await dialog.getByRole("button", { name: "Reconnect" }).click();
  await expect(state).toHaveText("Connected", { timeout: 15_000 });
  const listed = parseJsonOutput<{ pending?: unknown[] }>(
    await openclaw(["devices", "list", "--json"]),
  );
  expect(listed.pending ?? []).toEqual([]);
});

test("F-017 F-020: a run started on the gateway shows its bot working, then the row shows the reply", async ({
  page,
}) => {
  // Every state the host sends the page, to see the run while it lasts.
  const seen: Array<{
    tasksByBot?: Record<string, Array<{ key: string; status: string; preview: string | null }>>;
  }> = [];
  await page.routeWebSocket(/\/bridge$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      const parsed = JSON.parse(String(message)) as { state?: (typeof seen)[number] };
      if (parsed.state) seen.push(parsed.state);
      ws.send(message);
    });
  });
  await openShell(page);
  const { key } = await gatewayTask("marlow", "Anything new");
  await runOnGateway("marlow", key, "A note from the end-to-end run: is anything new?");
  const task = (state: (typeof seen)[number]) =>
    state.tasksByBot?.marlow?.find((t) => t.key === key);
  await expect.poll(() => seen.some((state) => task(state)?.status === "running")).toBe(true);
  // The row says the bot worked while it did, and shows the reply once it finished.
  await expect(botRow(page, "Marlow")).not.toHaveAccessibleName(/working/);
  await expect(botRow(page, "Marlow").locator(".bot-preview")).toContainText(
    "This is the scripted development model",
  );
  // Its count is every task the gateway lists for Marlow now, this check's own included.
  await expect(botRow(page, "Marlow")).toHaveAccessibleName(
    new RegExp(`^Marlow, ${await gatewayTaskCount("marlow")} tasks`),
  );
});

test("F-323: work goes on after the page is closed, and reopening shows where it got to", async ({
  page,
}) => {
  await openShell(page);
  const { key, title } = await gatewayTask("pip", "Errands");
  await runOnGateway("pip", key, "Plan the errands for Saturday.");
  await openTask(page, "Pip", title);
  // Counted once the transcript has loaded; count() does not wait for it.
  await expect(page.getByTestId("transcript-turn").first()).toBeVisible();
  const before = await page.getByTestId("transcript-turn").count();
  const context = page.context();
  // Ask the gateway for a run, and leave the preview while it works.
  const run = runOnGateway("pip", key, "One more stop: the post office.");
  await page.close();
  await run;
  const again = await context.newPage();
  await again.goto(process.env.CLAWTRATE_E2E_URL!);
  await expect(again.getByTestId("bot")).toHaveCount(4, { timeout: 20_000 });
  await expect(again.getByRole("heading", { level: 1, name: title })).toBeVisible();
  await expect(again.getByTestId("transcript-turn")).toHaveCount(before + 2);
  await expect(again.getByTestId("transcript-turn").last()).toContainText(
    "This is the scripted development model",
  );
  await expect(botRow(again, "Pip")).not.toHaveAccessibleName(/working/);
});

test("F-027: a hidden bot keeps working: a run on the gateway shows in the Hidden bots section, then its reply", async ({
  page,
}) => {
  // Hidden on this device alone: a host of this check's own that only reads, so the gateway's
  // arrangement, which the shared host would change for every later check, stays as it was.
  await pairOn(page, await freshHost());
  await botRow(page, "Marlow").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Hide from sidebar" }).click();
  await page.getByRole("button", { name: /^Hidden bots/ }).click();
  const hidden = page.getByRole("list", { name: "Hidden bots" });
  await openBot(page, "Marlow");
  const { key } = await gatewayTask("marlow", "While hidden");
  const task = hidden.locator(`[data-key="${key}"]`);
  await expect(task).toHaveAttribute("data-status", "idle");
  // The avatar summarizes every task, including runs started outside this check.
  await task.evaluate((row) => {
    const seen: Array<string | null> = [];
    (window as unknown as { hiddenStates: typeof seen }).hiddenStates = seen;
    new MutationObserver((changes) => {
      seen.push(...changes.map((change) => change.oldValue), row.getAttribute("data-status"));
    }).observe(row, {
      attributes: true,
      attributeFilter: ["data-status"],
      attributeOldValue: true,
    });
  });
  const prompt = "From the end-to-end run, while hidden: anything new?";
  await runOnGateway("marlow", key, prompt);
  await expect(task).toHaveAttribute("data-status", "done");
  const wasRunning = await page.evaluate(() =>
    (window as unknown as { hiddenStates: Array<string | null> }).hiddenStates.includes("running"),
  );
  expect(wasRunning).toBe(true);
  await task.click();
  await expect(page.getByTestId("transcript-turn").last()).toContainText(
    `This is the scripted development model. It has no reply written for: ${prompt}`,
  );
  // It stayed hidden throughout.
  await expect(page.locator('.bot-list > .bot-group > .bot[data-bot="marlow"]')).toHaveCount(0);
});

test("F-088: a gateway run that narrates between its tool calls shows each narration as its own short bubble, with its action cards between", async ({
  page,
}) => {
  await openShell(page);
  const { key, title } = await gatewayTask("pip", "Narrated");
  // Composed directives: a round ends after each tool call, and the text
  // after it opens the next, so the reply narrates between its two calls.
  await runOnGateway("pip", key, "#text #list #write");
  await openTask(page, "Pip", title);
  const turn = page.getByTestId("transcript-turn").last();
  await expect(turn).toContainText("I wrote notes/scratch.md.");
  const parts = await turn
    .locator(
      ':scope > .msg[data-role="assistant"], :scope > .msg-unit > .msg[data-role="assistant"], :scope > .action',
    )
    .evaluateAll((nodes) =>
      nodes.map((node) =>
        node.classList.contains("action")
          ? `[${node.querySelector("summary")!.getAttribute("aria-label")!.split(",")[0]}]`
          : node.textContent!.trim(),
      ),
    );
  expect(parts).toEqual([
    "Here is a plain reply, streamed in small pieces with no reasoning first.",
    "[Looked in .]",
    "Those are the files in my workspace.",
    "[Created scratch.md]",
    "I wrote notes/scratch.md.",
  ]);
  await expect(turn.locator('.msg[data-role="assistant"] .bubble')).toHaveCount(3);
});

test("F-323: a client quit while a run is in progress, and opened again, shows the run where it is, then how it ended", async ({
  browser,
}) => {
  // A client of this test's own: the same build, a copy of the preview host's
  // data (its device and pairing), started and quit here.
  const data = mkdtempSync(join(tmpdir(), "clawtrate-e2e-restart-"));
  cpSync(process.env.CLAWTRATE_E2E_DATA!, data, { recursive: true });
  let host: ChildProcess | null = null;
  const start = async () => {
    const started = startHost(INSTANCE, process.env.CLAWTRATE_E2E_STATIC!, data);
    host = started.host;
    started.gated.release();
    const url = await started.url;
    expect(FORBIDDEN_PORTS).not.toContain(Number(new URL(url).port));
    return url;
  };
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    let page = await context.newPage();
    await page.goto(await start());
    await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 20_000 });
    const { key, title } = await gatewayTask("pip", "Mountain days");
    // About eleven seconds of slowly streamed text, with no reasoning first.
    const run = runOnGateway("pip", key, "#stream 8");
    await expect(botRow(page, "Pip")).toHaveAccessibleName(/^Pip, working/, { timeout: 15_000 });
    // Quit the client while the run goes on.
    await page.close();
    await stopChild(host!);
    host = null;
    // Open it again.
    page = await context.newPage();
    await page.goto(await start());
    await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 20_000 });
    await expect(botRow(page, "Pip")).toHaveAccessibleName(/^Pip, working/);
    await openTask(page, "Pip", title);
    // The reply so far, still being written.
    const live = page.getByTestId("live-turn");
    await expect(live).toContainText("Here is a long answer, streamed slowly.");
    await expect(live).not.toContainText("part 32 of 32.");
    await run;
    // Then the finished reply, and the bot is no longer working.
    await expect(page.getByTestId("transcript-turn").last()).toContainText("part 32 of 32.", {
      timeout: 15_000,
    });
    await expect(live).toHaveCount(0);
    await expect(botRow(page, "Pip")).not.toHaveAccessibleName(/working/);
  } finally {
    await context.close();
    if (host) await stopChild(host);
    rmSync(data, { recursive: true, force: true });
  }
});

test("F-263: a real gateway's protocol mismatch names the protocol it speaks", async () => {
  const mine = listInstances().find((row) => row.name === INSTANCE)!;
  const socket = new WebSocket(`ws://127.0.0.1:${mine.gatewayPort}`);
  const reply = await new Promise<{ ok: boolean; error?: { details?: unknown } }>(
    (resolve, reject) => {
      socket.onerror = () => reject(new Error("socket error"));
      socket.onmessage = (event) => {
        const frame = JSON.parse(String(event.data)) as {
          type: string;
          event?: string;
          id?: string;
        };
        if (frame.type === "event" && frame.event === "connect.challenge") {
          socket.send(
            JSON.stringify({
              type: "req",
              id: "probe",
              method: "connect",
              params: {
                minProtocol: 99,
                maxProtocol: 99,
                client: { id: "gateway-client", version: "0.0.0", platform: "test", mode: "ui" },
                role: "operator",
                scopes: ["operator.read"],
                caps: [],
              },
            }),
          );
        } else if (frame.type === "res" && frame.id === "probe") {
          resolve(frame as never);
        }
      };
    },
  );
  socket.close();
  expect(reply.ok).toBe(false);
  expect(protocolMismatch(reply.error?.details)).toEqual({ gateway: 4, client: 4 });
});

// The live conversation against this run's real development gateway. The
// scripted model answers a message sent from the app with a short reply and
// a reasoning segment; it cannot yet stream slowly, ask or need approval.

/** Pending device requests on this run's gateway, newest last. */
async function pendingRequests(): Promise<string[]> {
  const listed = parseJsonOutput<{ pending?: Array<{ requestId: string }> }>(
    await openclaw(["devices", "list", "--json"]),
  );
  return (listed.pending ?? []).map((request) => request.requestId);
}

/** Record, on every change, what the live turn and the status line show. */
async function watchRun(page: Page) {
  await page.evaluate(() => {
    const seen: Array<Record<string, unknown>> = [];
    (window as unknown as { __seen: unknown }).__seen = seen;
    new MutationObserver(() => {
      const live = document.querySelector("[data-testid=live-turn] .bubble");
      seen.push({
        at: performance.now(),
        live: live?.textContent ?? null,
        caret: !!live?.querySelector(".stream-caret"),
        busy: live?.getAttribute("aria-busy") ?? null,
        status: !!document.querySelector("[data-testid=status-line]"),
        phrase: document.querySelector("[data-testid=status-phrase]")?.textContent ?? null,
        steer: [...document.querySelectorAll("[data-testid=outgoing] .msg-caption")].some(
          (caption) => caption.textContent === "Steer requested",
        ),
      });
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  return () =>
    page.evaluate(
      () =>
        (window as unknown as { __seen: Array<Record<string, unknown>> }).__seen as Array<{
          at: number;
          live: string | null;
          caret: boolean;
          busy: string | null;
          status: boolean;
          phrase: string | null;
          steer: boolean;
        }>,
    );
}

const composer = (page: Page) => page.getByTestId("composer-input");

test("F-456: a refused request leaves the read tier as it was; an approved one gives the composer", async ({
  page,
}) => {
  // A host of this check's own, paired for reading only: the shared one has access already.
  await pairOn(page, await freshHost());
  await openTask(page, "Otto", "Disk almost full on the media box");
  const bar = page.getByRole("region", { name: "Access" });
  await expect(bar).toContainText("Read-only.");
  await expect(composer(page)).toHaveCount(0);

  // Asked only when the person chooses to; the owner refuses it on the gateway's machine.
  expect(await pendingRequests()).toEqual([]);
  await bar.getByRole("button", { name: "Request access" }).click();
  await expect(bar).toContainText("Waiting for approval.");
  await expect(bar.locator(".command code")).toHaveText(
    `pnpm dev-gateway approve --instance ${INSTANCE}`,
  );
  const [refused] = await pendingRequests();
  expect(refused).toBeTruthy();
  await expect(bar).toContainText(`Request ${refused!.slice(0, 8)}`);
  await openclaw(["devices", "reject", refused!]);
  await expect(bar).toContainText(
    "The request was denied. Nothing changed. This device can still read.",
  );
  // The old authorization stays: the conversation still reads.
  await expect(page.getByTestId("transcript-turn").first()).toBeVisible();

  // Asked again and approved: the composer takes the bar's place.
  await bar.getByRole("button", { name: "Request again" }).click();
  await expect(bar).toContainText("Waiting for approval.");
  devGateway(INSTANCE, "approve");
  await expect(composer(page)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("region", { name: "Access" })).toHaveCount(0);
  await expect(page.getByTestId("status-strip")).toContainText("Access granted");
  const gateway = page.getByRole("button", { name: /, connected\. Open the gateway menu\.$/ });
  await expect(gateway).toBeVisible();
});

test("F-081 F-082 F-083 F-085 F-089 F-095 F-433: a sent message shows the status line within a second, its reply streams in, and the line leaves when the run completes", async ({
  page,
}) => {
  await openShell(page);
  await ownTask(page, "Status line");
  const seen = await watchRun(page);
  // A reply that streams for a few seconds, so it is on screen while the run goes on.
  await composer(page).fill("How full is the backup disk this week? #stream 3");
  const sent = Date.now();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("status-line")).toBeVisible({ timeout: 1000 });
  expect(Date.now() - sent).toBeLessThan(1000);
  await expect(page.getByTestId("status-line")).toHaveCount(0, { timeout: 30_000 });

  const samples = await seen();
  // The phrase was never empty, never named the bot, and started at Thinking.
  const phrases = samples.flatMap((sample) => (sample.phrase === null ? [] : [sample.phrase]));
  expect(phrases[0]).toBe("Thinking");
  expect(phrases.every((phrase) => phrase.trim().length > 0 && !/Otto/.test(phrase))).toBe(true);
  // The reply was on screen, streaming with its caret, while the run was still going.
  expect(
    samples.some(
      (sample) => sample.live && sample.caret && sample.busy === "true" && sample.status,
    ),
  ).toBe(true);
  // Once complete, history holds the message and its reply once each.
  await expect(
    page.getByText("How full is the backup disk this week? #stream 3", { exact: true }),
  ).toHaveCount(1);
  await expect(
    page
      .getByTestId("transcript-turn")
      .filter({ hasText: "Here is a long answer, streamed slowly." }),
  ).toHaveCount(1);
  await expect(page.getByTestId("outgoing")).toHaveCount(0);
  await expect(page.getByTestId("live-turn")).toHaveCount(0);
});

test("F-097: Stop during a real run is offered beside Send, and the gateway's confirmation ends the run as stopped", async ({
  page,
}) => {
  await openShell(page);
  // A task of its own, so no earlier check's turn can come back in it or hold its note.
  const { key } = await ownTask(page, "Stop button");
  await composer(page).fill("Check the backup disk once more, slowly. #slow 15");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("status-line")).toBeVisible();
  await expect(page.getByRole("button", { name: "Request a steer" })).toBeVisible();
  // Pressed at once, before the gateway may have named the run: the engine aborts it once named.
  await page.getByRole("button", { name: "Stop Otto" }).click();
  const runId = await inFlightRunId(key).catch(() => "");
  const note = runId ? stopNote(page, runId) : page.getByTestId("stop-note");
  await expect(note).toContainText("Completed actions are not undone.", { timeout: 30_000 });
  await expect(note).toContainText(/^Stopped/);
  await expect(page.getByTestId("status-line")).toHaveCount(0);
  await expect.poll(() => gatewayIdle(key), { timeout: 30_000 }).toBe(true);
  // "Stopping…" shows until the gateway confirms; on loopback the
  // confirmation can land in the same snapshot, so it is checked in the fixture.
});

test("F-097: a typed /stop stops the run, and the note does not say it came from elsewhere", async ({
  page,
}) => {
  await openShell(page);
  // A task of its own: a stop leaves a mark the gateway's restart recovery reads (docs/decisions.md).
  const { key } = await ownTask(page, "Typed stop");
  await composer(page).fill("Look through every backup set again. #slow 15");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("status-line")).toBeVisible();
  // Typed once the gateway has the run in flight: the exact run the note must belong to.
  const runId = await inFlightRunId(key);
  await composer(page).fill("/stop");
  await page.keyboard.press("Enter");
  const note = stopNote(page, runId);
  await expect(note).toContainText("Completed actions are not undone.", { timeout: 30_000 });
  await expect(note).not.toContainText("another device");
  await expect(page.getByTestId("status-line")).toHaveCount(0);
  await expect.poll(() => gatewayIdle(key), { timeout: 30_000 }).toBe(true);
});

test("F-097: a typed Stop now stops the run through the gateway, as the Stop button does", async ({
  page,
}) => {
  await openShell(page);
  const { key } = await ownTask(page, "Typed stop now");
  await composer(page).fill("Go through the old logs. #slow 15");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("status-line")).toBeVisible();
  const runId = await inFlightRunId(key);
  await composer(page).fill("Stop now");
  await page.keyboard.press("Enter");
  const note = stopNote(page, runId);
  await expect(note).toContainText("Completed actions are not undone.", { timeout: 30_000 });
  await expect(note).not.toContainText("another device");
  await expect(page.getByTestId("status-line")).toHaveCount(0);
  // The words were Stop, not a message: none reached the task.
  await expect(page.getByTestId("outgoing").filter({ hasText: "Stop now" })).toHaveCount(0);
  await expect.poll(() => gatewayIdle(key), { timeout: 30_000 }).toBe(true);
  expect(await gatewayHasMessage(key, "Stop now")).toBe(false);
});

test("F-074 F-285: a file chosen with + reaches the gateway; one over the gateway's limit stays a marked chip, holds Send until removed, and the valid 1 MiB file then sends", async ({
  page,
}) => {
  await openShell(page);
  const { key } = await ownTask(page, "Files and limits");
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("composer").getByRole("button", { name: "Attach files" }).click();
  await (
    await chooser
  ).setFiles([
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.alloc(1024 * 1024, 65) },
    { name: "photo.png", mimeType: "image/png", buffer: Buffer.alloc(7 * 1024 * 1024) },
  ]);
  const chips = page.locator(".attachments .chip");
  await expect(chips).toHaveCount(2);
  await expect(chips.filter({ hasText: "notes.txt" })).toContainText("1.0 MB");
  // The gateway's own image ceiling, as its hello said it.
  await expect(chips.filter({ hasText: "photo.png" })).toContainText(
    "7.0 MB. Images can be up to 6 MB.",
  );
  await expect(chips.filter({ hasText: "photo.png" })).toHaveAttribute("data-tone", "danger");
  await composer(page).fill("Two files, one too large. #text");
  const send = page.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeDisabled();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("outgoing")).toHaveCount(0);
  await page.getByRole("button", { name: "Remove photo.png" }).click();
  await expect(chips).toHaveCount(1);
  await expect(send).toBeEnabled();
  await send.click();
  await expect(chips).toHaveCount(0);
  type Media = { fileName?: string; sizeBytes?: number };
  const sentMedia = async () => {
    const history = await gatewayCall<{
      messages: Array<{ role: string; __openclaw?: { media?: Media[] } }>;
    }>("chat.history", { sessionKey: key, limit: 10 });
    return history.messages
      .filter((row) => row.role === "user")
      .flatMap((row) => row.__openclaw?.media ?? [])
      .map((media) => [media.fileName, media.sizeBytes]);
  };
  await expect.poll(sentMedia, { timeout: 30_000 }).toEqual([["notes.txt", 1024 * 1024]]);
  await expect.poll(() => gatewayIdle(key), { timeout: 30_000 }).toBe(true);
});

test("F-301: a turn the gateway fails offers Copy request ID, which copies the id Raw shows beside the gateway's error event", async ({
  page,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await openShell(page);
  const { key } = await ownTask(page, "Copy request id");
  await composer(page).fill("This one fails. #model-error");
  await page.keyboard.press("Enter");
  const card = page.getByTestId("turn-error");
  await expect(card).toBeVisible({ timeout: 60_000 });
  await card.getByRole("button", { name: "Raw" }).click();
  const shown = ((await card.getByTestId("request-id").textContent()) ?? "").trim();
  // The protocol client's own id for the frame, as it set it ("<n>:<uuid>").
  expect(shown).toMatch(/^\S{8,}$/);
  // Read when opened: what the gateway sent that ended the run, labelled as exactly that.
  await expect(card.getByTestId("turn-error-raw")).toContainText(
    /The (chat event|data of the agent lifecycle event) that ended the turn, as received/,
  );
  await expect(card.getByTestId("run-raw")).toBeVisible();
  // One failure is shown once: no bot bubble repeats it, and nothing is "Incomplete".
  await expect(page.getByTestId("incomplete")).toHaveCount(0);
  await expect(
    page.getByTestId("transcript-turn").and(page.locator('[data-role="assistant"]')),
  ).toHaveCount(0);
  await page.evaluate(() => navigator.clipboard.writeText(""));
  await card.getByRole("button", { name: "Copy request ID" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(shown);
  await expect.poll(() => gatewayIdle(key), { timeout: 30_000 }).toBe(true);
});

test("F-066 F-283 F-067: on a real turn of a progress bubble and a final one, each bubble's actions name its own row: a reaction is set and taken back on the gateway, and a reply sent from its thread names it", async ({
  page,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await openShell(page);
  const { key } = await ownTask(page, "React and reply");
  // Text beside a call, then the answer: one turn, two rows of the gateway's, two bubbles.
  await composer(page).fill("Say something short. #text #read");
  await page.keyboard.press("Enter");
  await expect.poll(() => gatewayIdle(key), { timeout: 60_000 }).toBe(true);
  type Row = {
    role: string;
    content?: unknown;
    __openclaw?: { id?: string; replyToId?: string };
  };
  const rows = async () =>
    (await gatewayCall<{ messages: Row[] }>("chat.history", { sessionKey: key, limit: 20 }))
      .messages;
  const hasText = (row: Row) =>
    typeof row.content === "string"
      ? row.content.trim() !== ""
      : Array.isArray(row.content) &&
        row.content.some(
          (part: { type?: string; text?: string }) => part.type === "text" && part.text?.trim(),
        );
  const answers = (await rows()).filter((row) => row.role === "assistant" && hasText(row));
  expect(answers).toHaveLength(2);
  const progressId = answers[0]!.__openclaw!.id!;
  const finalId = answers[1]!.__openclaw!.id!;
  expect(progressId).not.toBe(finalId);
  const progress = page.locator(`[data-testid="message"][data-message="${progressId}"]`);
  const final = page.locator(`[data-testid="message"][data-message="${finalId}"]`);
  await expect(progress).toBeVisible({ timeout: 30_000 });
  await expect(final).toBeVisible();
  await expect(progress).toContainText("Here is a plain reply");
  await expect(final).toContainText("I read my instructions file.");
  const opacity = (actions: ReturnType<typeof progress.getByTestId>) =>
    actions.evaluate((el) => Number(getComputedStyle(el).opacity));
  const actions = progress.getByTestId("message-actions");
  await progress.locator(".msg > .bubble").hover();
  await expect.poll(() => opacity(actions)).toBe(1);

  // F-283: a reaction on the progress bubble, as the gateway records it under its row, and taken back.
  const listed = async (id: string) => {
    const answer = await gatewayCall<{ reactions: Record<string, Array<{ emoji: string }>> }>(
      "session.reactions.list",
      { sessionKey: key },
    );
    return (answer.reactions[id] ?? []).map((each) => each.emoji);
  };
  await actions.getByRole("button", { name: "Add a reaction" }).click();
  await page
    .getByRole("menu", { name: "Add a reaction" })
    .getByRole("menuitem", { name: /Thumbs up/ })
    .click();
  const badge = progress.getByTestId("reaction");
  await expect(badge).toHaveText("👍1", { timeout: 30_000 });
  await expect(badge).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => listed(progressId), { timeout: 30_000 }).toEqual(["👍"]);
  expect(await listed(finalId)).toEqual([]);
  await expect(final.getByTestId("reactions")).toHaveCount(0);
  await badge.click();
  await expect(progress.getByTestId("reactions")).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(() => listed(progressId), { timeout: 30_000 }).toEqual([]);

  // F-066: the final bubble's More copies the final row's id.
  await final.locator(".msg > .bubble").hover();
  const finalActions = final.getByTestId("message-actions");
  await expect.poll(() => opacity(finalActions)).toBe(1);
  await finalActions.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Copy message ID" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(finalId);

  // F-067: Reply on the progress bubble opens its thread, and the reply names its row.
  await progress.locator(".msg > .bubble").hover();
  await actions.getByRole("button", { name: "Reply in a thread" }).click();
  const thread = page.getByRole("dialog", { name: "Thread" });
  await expect(thread.getByTestId("thread-message").first()).toContainText("Here is a plain reply");
  await thread.getByTestId("thread-input").fill("A reply to that. #text");
  await page.keyboard.press("Enter");
  await expect
    .poll(
      async () =>
        (await rows()).some(
          (row) => row.role === "user" && row.__openclaw?.replyToId === progressId,
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
  await expect(thread).toContainText("1 reply", { timeout: 30_000 });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("reply-quote")).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => gatewayIdle(key), { timeout: 60_000 }).toBe(true);
});

test("F-071 F-070: / lists the bot's own skills by name and the gateway's commands, a chosen skill goes to the gateway with the words, and @ lists the bots", async ({
  page,
}) => {
  await openShell(page);
  const { key } = await ownTask(page, "Slash and mention");
  type Skill = { name: string; userInvocable?: boolean; eligible?: boolean; disabled?: boolean };
  const listed = await gatewayCall<{ skills: Skill[] }>("skills.status", { agentId: "otto" });
  const runnable = listed.skills
    .filter((each) => each.userInvocable && each.eligible && !each.disabled)
    .map((each) => each.name);
  expect(runnable).toContain("weather");
  await composer(page).click();
  await page.keyboard.type("/");
  const rows = page.getByRole("listbox", { name: "Skills and commands" }).getByRole("option");
  await expect(rows.first()).toBeVisible({ timeout: 30_000 });
  const skills = await rows
    .and(page.locator('[data-kind="skill"]'))
    .evaluateAll((all) => all.map((each) => each.getAttribute("data-name")));
  // The skills this bot may run, by name and in the gateway's order, and nothing else, are
  // the Skill rows (the first 50 the list shows).
  expect(skills).toEqual(runnable.slice(0, Math.min(50, runnable.length)));
  await expect(rows.filter({ hasText: "/status" }).locator(".composer-menu-tag")).toHaveText(
    "Command",
  );
  // No app's action is offered: the gateway lists none here, and the menu does not read them.
  expect(await rows.locator(".composer-menu-tag", { hasText: "Action" }).count()).toBe(0);
  await page.keyboard.type("weath");
  await expect(rows).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("token-chip")).toContainText("/weather");
  await page.keyboard.type("in Lisbon #text");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => gatewayHasMessage(key, "/weather in Lisbon #text"), { timeout: 30_000 })
    .toBe(true);
  await expect.poll(() => gatewayIdle(key), { timeout: 60_000 }).toBe(true);

  await composer(page).click();
  await page.keyboard.type("Ask @");
  const mentions = page
    .getByRole("listbox", { name: "Mention a bot or routine" })
    .getByRole("option");
  await expect(mentions.filter({ hasText: "@Marlow" })).toContainText("Bot", { timeout: 30_000 });
  await expect(mentions.filter({ hasText: /Bot$/ })).toHaveCount(4);
  await page.keyboard.press("Escape");
  await composer(page).fill("");
});

test("F-100: with the Turn time limit set to 1 minute, a longer turn is stopped through the gateway, and once it confirms the card names the limit and who stopped it", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await openShell(page);
  const setLimit = async (minutes: string) => {
    await page.keyboard.press("ControlOrMeta+,");
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("button", { name: "Conversation", exact: true }).click();
    const field = settings.getByLabel("Turn time limit");
    await field.fill(minutes);
    await field.press("Enter");
    await page.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+,");
    await expect(settings.getByLabel("Turn time limit")).toHaveValue(minutes);
    await page.keyboard.press("Escape");
  };
  // The host is shared by later checks: its limit goes back to the default whatever happens.
  try {
    await setLimit("1");
    const { key } = await ownTask(page, "Turn limit");
    await composer(page).fill("Write it out very slowly. #slow 120");
    await page.keyboard.press("Enter");
    const runId = await inFlightRunId(key);
    await expect(page.getByTestId("status-line")).toBeVisible();
    const card = page.getByTestId("turn-error");
    await expect(card).toContainText("Otto's turn reached its 1 minute limit", {
      timeout: 120_000,
    });
    await expect(card).toContainText("Clawtrate stopped it at the Turn time limit in Settings");
    await expect(page.getByTestId("status-line")).toHaveCount(0);
    // The gateway ended that run because it was asked to (`rpc`), not by a limit of its own.
    const ended = await gatewayCall<{ stopReason?: string }>("agent.wait", {
      runId,
      timeoutMs: 10_000,
    });
    expect(ended.stopReason).toBe("rpc");
    await expect.poll(() => gatewayIdle(key), { timeout: 60_000 }).toBe(true);
  } finally {
    await setLimit("50");
  }
});

test("F-099: a run stuck on a tool call that never returns reaches stopped within 30 seconds of Stop", async ({
  page,
}) => {
  await openShell(page);
  const { key } = await ownTask(page, "Stuck tool");
  // The stand-in coding agent's call that does not finish for an hour.
  await composer(page).fill("Start the long coding task. #mcp-stop");
  await page.keyboard.press("Enter");
  const runId = await inFlightRunId(key);
  await expect.poll(() => toolStarted(key, runId), { timeout: 60_000 }).toBe(true);
  const pressed = Date.now();
  await page.getByRole("button", { name: "Stop Otto" }).click();
  const note = stopNote(page, runId);
  await expect(note).toContainText("Completed actions are not undone.", { timeout: 30_000 });
  expect(Date.now() - pressed).toBeLessThan(30_000);
  await expect(page.getByTestId("status-line")).toHaveCount(0);
  await expect.poll(() => gatewayIdle(key), { timeout: 30_000 }).toBe(true);
});

test("F-296 F-298: Stop also stops the exact run of the bot this run messaged, and the note names it", async ({
  page,
}) => {
  await openShell(page);
  const { key } = await ownTaskOf(page, "pip", "Pip", "Stop the messaged bot");
  // Pip messages Marlow, whose answer takes 15 seconds, then keeps writing.
  await composer(page).fill("Ask Marlow, then write slowly. #message-slow #slow 30");
  await page.keyboard.press("Enter");
  const runId = await inFlightRunId(key);
  type Row = { role: string; toolName?: string; details?: { runId?: string; sessionKey?: string } };
  // The recipient's run, as the send's result names it.
  let recipient: { runId: string; sessionKey: string } | null = null;
  await expect
    .poll(
      async () => {
        const history = await gatewayCall<{
          inFlightRun?: {
            events?: Array<{
              stream?: string;
              data?: { phase?: string; name?: string; result?: { details?: Row["details"] } };
            }>;
          };
        }>("chat.history", { sessionKey: key, limit: 5 });
        const result = (history.inFlightRun?.events ?? []).find(
          (event) =>
            event.stream === "tool" &&
            event.data?.phase === "result" &&
            event.data.name === "sessions_send",
        );
        const details = result?.data?.result?.details;
        if (details?.runId && details.sessionKey)
          recipient = { runId: details.runId, sessionKey: details.sessionKey };
        return recipient !== null;
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  const peer = recipient as unknown as { runId: string; sessionKey: string };
  // Marlow is working on it when Stop is pressed.
  await expect.poll(() => gatewayIdle(peer.sessionKey), { timeout: 30_000 }).toBe(false);
  await page.getByRole("button", { name: "Stop Pip" }).click();
  const note = stopNote(page, runId);
  await expect(note).toContainText("Completed actions are not undone.", { timeout: 30_000 });
  await expect(note.getByTestId("stopped-with")).toContainText(
    "Stopped with it: Marlow's run for this message.",
    { timeout: 30_000 },
  );
  // Marlow's own run, the one the send named, ended on the gateway by an abort request (`rpc`),
  // long before its 15 seconds.
  const ended = await gatewayCall<{ runId?: string; stopReason?: string; endedAt?: number }>(
    "agent.wait",
    { runId: peer.runId, timeoutMs: 10_000 },
  );
  expect(ended).toMatchObject({ runId: peer.runId, stopReason: "rpc" });
  await expect.poll(() => gatewayIdle(peer.sessionKey), { timeout: 10_000 }).toBe(true);
  await expect.poll(() => gatewayIdle(key), { timeout: 30_000 }).toBe(true);
});

test("F-101: after three of the run's tool calls in a row time out, the run is stopped and its note says why", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await openShell(page);
  const { key } = await ownTask(page, "Three timeouts");
  // Three commands that each run past their one-second limit, then a slow reply that would go on.
  await composer(page).fill("#exec-timeout #exec-timeout #exec-timeout #slow 60");
  await page.keyboard.press("Enter");
  const runId = await inFlightRunId(key);
  for (let n = 0; n < 3; n += 1) {
    const pending = page
      .getByTestId("approval-card")
      .filter({ has: page.getByRole("button", { name: "Allow once" }) });
    await expect(pending).toHaveCount(1, { timeout: 60_000 });
    await pending.getByRole("button", { name: "Allow once" }).click();
    await expect(pending).toHaveCount(0, { timeout: 30_000 });
  }
  const note = stopNote(page, runId);
  await expect(note.locator("b")).toHaveText("Stopped after 3 tool calls in a row timed out.", {
    timeout: 60_000,
  });
  await expect(note).toContainText("may not be responding");
  await expect(page.getByTestId("status-line")).toHaveCount(0);
  // Stopped before its slow reply could finish.
  await expect.poll(() => gatewayIdle(key), { timeout: 30_000 }).toBe(true);
  const history = await gatewayCall<{ messages: Array<{ role: string; content?: unknown }> }>(
    "chat.history",
    { sessionKey: key, limit: 40 },
  );
  expect(JSON.stringify(history.messages)).not.toContain("part 240 of 240");
});

test("F-061: Queue after this turn holds a message on the shelf and runs it once the turn ends", async ({
  page,
}) => {
  await openShell(page);
  const { key } = await ownTask(page, "Queue after turn");
  // Long enough that the turn is still going when the next message is queued behind it.
  await composer(page).fill("Which certificate is it? #stream 10");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("status-line")).toBeVisible();
  await composer(page).fill("And when does it renew?");
  await page.keyboard.press("Alt+Enter");
  const row = page.getByTestId("shelf-row");
  await expect(row).toContainText("Queued");
  await expect(row).toContainText("And when does it renew?");
  await expect(row).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId("status-line")).toHaveCount(0, { timeout: 60_000 });
  await expect.poll(() => gatewayIdle(key), { timeout: 30_000 }).toBe(true);
  const turns = page.getByTestId("transcript-turn");
  await expect(turns.filter({ hasText: "And when does it renew?" })).toHaveCount(2);
  // In the order sent: the queued message came after the first one's reply.
  const order = await turns.evaluateAll((all) => all.map((turn) => turn.textContent ?? ""));
  const first = order.findIndex((text) => text.includes("Which certificate is it?"));
  const queued = order.findIndex((text) => text === "And when does it renew?");
  expect(first).toBeGreaterThan(-1);
  expect(queued).toBeGreaterThan(first + 1);
});

/** A task's rows on the gateway: each row's role and visible text, in order. */
async function historyRows(key: string): Promise<Array<{ role: string; text: string }>> {
  const history = await gatewayCall<{
    messages: Array<{ role: string; content?: unknown }>;
  }>("chat.history", { sessionKey: key, limit: 60 });
  const textOf = (content: unknown): string =>
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part: { type?: string; text?: string }) =>
              part.type === "text" ? (part.text ?? "") : "",
            )
            .join("")
        : "";
  return history.messages
    .map((row) => ({ role: row.role, text: textOf(row.content).trim() }))
    .filter((row) => (row.role === "user" || row.role === "assistant") && row.text !== "");
}

/** The transcript's turns as the page shows them: each one's role and text, in order. */
async function shownTurns(page: Page): Promise<Array<{ role: string; text: string }>> {
  return page.getByTestId("transcript-turn").evaluateAll((all) =>
    all.map((turn) => ({
      role: turn.getAttribute("data-role") ?? "",
      text: (turn.textContent ?? "").trim(),
    })),
  );
}

/** Where each message is among a task's rows of that role: once, and in the order sent. */
function placesOf(rows: Array<{ role: string; text: string }>, texts: string[]): number[] {
  return texts.map((text) => {
    const at = rows.flatMap((row, index) =>
      row.role === "user" && row.text.includes(text) ? [index] : [],
    );
    expect(at, `"${text}" appears once`).toHaveLength(1);
    return at[0]!;
  });
}

const QUICK = ["Also the photos folder.", "And the music folder.", "Then send me a summary."];

/**
 * Enter on the words in the composer until it takes them. The field empties as a send starts,
 * before the host has taken it; an Enter in that moment is not taken, the words stay with a
 * notice, and the person sends them again, as this does.
 */
async function enterUntilTaken(page: Page): Promise<void> {
  await expect(async () => {
    if ((await composer(page).inputValue()) !== "") await page.keyboard.press("Enter");
    await expect(composer(page)).toHaveValue("", { timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
}

test("F-106: under Steer, a slow message and three quick ones each appear once, shown in the order the gateway records them, and the last is answered; again after a reload", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await openShell(page);
  const { key, title } = await ownTask(page, "Quick messages, steered");
  await composer(page).fill("Look at the disk use. #slow 15");
  await page.keyboard.press("Enter");
  // The run is under way on the gateway: the next three go as steers, the default.
  await inFlightRunId(key);
  for (const text of QUICK) {
    await composer(page).fill(text);
    await expect(page.getByRole("button", { name: "How to send: Steer" })).toBeVisible();
    // The next message is typed only once the composer took this one.
    await enterUntilTaken(page);
  }
  await expect.poll(() => gatewayIdle(key), { timeout: 120_000 }).toBe(true);
  await expect(page.getByTestId("status-line")).toHaveCount(0, { timeout: 60_000 });
  const all = ["Look at the disk use.", ...QUICK];
  /** The messages in the order these rows hold them, each once, the first one first. */
  const check = (rows: Array<{ role: string; text: string }>) => {
    const places = placesOf(rows, all);
    expect(Math.min(...places)).toBe(places[0]);
    // A steer is a request: the gateway joins it to the turn or holds it as a turn of its own,
    // which it records when it runs, so how the steers are answered, and in which order they
    // are recorded, is its own. Whichever is last is answered.
    expect(
      rows.slice(Math.max(...places) + 1).filter((row) => row.role === "assistant").length,
      "a reply after the last message",
    ).toBeGreaterThan(0);
    return [...all].sort((a, b) => places[all.indexOf(a)]! - places[all.indexOf(b)]!);
  };
  await expect
    .poll(async () => (await historyRows(key)).length, { timeout: 30_000 })
    .toBeGreaterThan(4);
  const recorded = check(await historyRows(key));
  await expect
    .poll(async () => (await shownTurns(page)).filter((t) => t.role === "user").length, {
      timeout: 30_000,
    })
    .toBe(4);
  // The page shows them as the gateway's history records them.
  await expect
    .poll(async () => check(await shownTurns(page)), { timeout: 30_000 })
    .toEqual(recorded);
  // No message the gateway took is shown as not sent, and none is left on the shelf.
  await expect(page.getByTestId("shelf-row")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 20_000 });
  await openTask(page, "Otto", title);
  await expect
    .poll(async () => (await shownTurns(page)).filter((t) => t.role === "user").length, {
      timeout: 30_000,
    })
    .toBe(4);
  expect(check(await shownTurns(page))).toEqual(recorded);
});

test("F-106: under Queue, a slow message and three quick ones each start a turn of their own, in order, each with its own reply; again after a reload", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await openShell(page);
  const { key, title } = await ownTask(page, "Quick messages, queued");
  await composer(page).fill("Look at the disk use. #slow 15");
  await page.keyboard.press("Enter");
  await inFlightRunId(key);
  await composer(page).fill(QUICK[0]!);
  // The mode menu sets Queue for the rest of this run.
  await page.getByRole("button", { name: "How to send: Steer" }).click();
  await page.getByRole("menuitemradio", { name: /Queue after this turn/ }).click();
  await expect(page.getByRole("button", { name: "How to send: Queue" })).toBeVisible();
  await composer(page).focus();
  await enterUntilTaken(page);
  for (const text of QUICK.slice(1)) {
    await composer(page).fill(text);
    // As above: the next message is typed only once the composer took this one.
    await enterUntilTaken(page);
  }
  await expect(page.getByTestId("shelf-row")).toHaveCount(0, { timeout: 180_000 });
  await expect.poll(() => gatewayIdle(key), { timeout: 120_000 }).toBe(true);
  await expect(page.getByTestId("status-line")).toHaveCount(0, { timeout: 60_000 });
  const check = (rows: Array<{ role: string; text: string }>) => {
    const places = placesOf(rows, ["Look at the disk use.", ...QUICK]);
    expect(places).toEqual([...places].sort((a, b) => a - b));
    // Four pairs in order: each message, then its own reply before the next message.
    const bounds = [...places, rows.length];
    for (let n = 0; n < 4; n += 1) {
      const between = rows.slice(bounds[n]! + 1, bounds[n + 1]);
      expect(
        between.filter((row) => row.role === "assistant").length,
        `reply to message ${n + 1}`,
      ).toBeGreaterThan(0);
    }
  };
  await expect
    .poll(async () => (await historyRows(key)).filter((r) => r.role === "assistant").length, {
      timeout: 30_000,
    })
    .toBeGreaterThanOrEqual(4);
  check(await historyRows(key));
  await expect
    .poll(async () => (await shownTurns(page)).filter((t) => t.role === "user").length, {
      timeout: 30_000,
    })
    .toBe(4);
  check(await shownTurns(page));
  await page.reload();
  await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 20_000 });
  await openTask(page, "Otto", title);
  await expect
    .poll(async () => (await shownTurns(page)).filter((t) => t.role === "user").length, {
      timeout: 30_000,
    })
    .toBe(4);
  check(await shownTurns(page));
});

test("F-106: a steer acknowledged into the gateway's queue is described as a request", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openShell(page);
  const { key } = await ownTask(page, "Steer requested");
  await composer(page).fill("#approve");
  await page.keyboard.press("Enter");
  const runId = await inFlightRunId(key);
  await expect(page.getByTestId("status-line")).toContainText("Waiting for you", {
    timeout: 30_000,
  });
  await composer(page).fill("Only the notes folder.");
  await page.keyboard.press("Enter");
  await expect(composer(page)).toHaveValue("");
  // The gateway holds the steer as a queued turn under an id of its own.
  type Pending = { pendingInputs?: { items?: Array<{ runId?: string }> } };
  await expect
    .poll(
      async () =>
        (
          (await gatewayCall<Pending>("chat.history", { sessionKey: key, limit: 5 })).pendingInputs
            ?.items ?? []
        ).some((item) => typeof item.runId === "string" && item.runId !== runId),
      { timeout: 30_000 },
    )
    .toBe(true);
  // No caption promises that it joined the turn.
  const steer = page.getByTestId("outgoing").filter({ hasText: "Only the notes folder." });
  await expect(steer.locator(".msg-caption")).toHaveText("Steer requested", { timeout: 30_000 });
  await page.getByRole("button", { name: "Stop Otto" }).click();
  // The waiting approval's run is the one stopped, and the note is that run's.
  const note = page.locator(`[data-testid="stop-note"][data-run="${runId}"]`);
  await expect(note).toContainText("Completed actions are not undone.", { timeout: 30_000 });
  await expect(note).toContainText("The gateway may still run messages it already accepted.");
  const ended = await gatewayCall<{ stopReason?: string }>("agent.wait", {
    runId,
    timeoutMs: 10_000,
  });
  expect(ended.stopReason).toBe("rpc");
  await expect.poll(() => gatewayIdle(key), { timeout: 60_000 }).toBe(true);
});

test("F-096: a message sent while the run works is steered into it and captioned Steer once accepted", async ({
  page,
}) => {
  await openShell(page);
  const { key } = await ownTask(page, "Steer");
  const seen = await watchRun(page);
  await composer(page).fill("Start on the backup report. #slow-tool 20");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("status-line")).toBeVisible();
  // The barrier: this run's slow tool has started on the gateway, with twenty seconds of it to
  // go, so the steer is taken into the run, not queued after it. The scripted tool has no
  // release of its own to hold it longer.
  const runId = await inFlightRunId(key);
  await expect.poll(() => toolStarted(key, runId), { timeout: 30_000 }).toBe(true);
  await composer(page).fill("Only the photos set, please.");
  await expect(page.getByRole("button", { name: "How to send: Steer" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("status-line")).toHaveCount(0, { timeout: 60_000 });
  expect((await seen()).some((sample) => sample.steer)).toBe(true);
  // The gateway admitted it as a steer, by its own record: in its history the message is
  // answered inside the run it was sent into, not by a turn of its own after that run.
  await expect
    .poll(() => answeredInsideRun(key, "Only the photos set, please.", runId), {
      timeout: 30_000,
    })
    .toBe("inside");
  await expect(
    page.locator(".transcript").getByText("Only the photos set, please.", { exact: true }),
  ).not.toHaveCount(0);
  await expect.poll(() => gatewayIdle(key), { timeout: 30_000 }).toBe(true);
});

test("F-058: two tasks of one bot run at the same time", async ({ page }) => {
  await openShell(page);
  const first = await ownTask(page, "First of two");
  await composer(page).fill("First of two at once. #stream 5");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("status-line")).toBeVisible();
  const second = await ownTask(page, "Second of two");
  await composer(page).fill("Second of two at once.");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("status-line")).toHaveCount(0, { timeout: 30_000 });
  await openTask(page, "Otto", first.title);
  await expect(page.getByTestId("status-line")).toHaveCount(0, { timeout: 30_000 });
  // The gateway's own record: the second task's message arrived before the
  // first task's reply to its own message was recorded.
  type Row = { role: string; content?: unknown; __openclaw?: { recordTimestampMs?: number } };
  const rows = async (key: string) =>
    (await gatewayCall<{ messages: Row[] }>("chat.history", { sessionKey: key, limit: 40 }))
      .messages;
  const at = (row: Row | undefined) => row?.__openclaw?.recordTimestampMs ?? Number.NaN;
  const said = (row: Row, text: string) => JSON.stringify(row.content ?? "").includes(text);
  /** The first reply recorded after the user's row that says `text`. */
  const replyTo = (list: Row[], text: string) => {
    const asked = list.findLastIndex((row) => row.role === "user" && said(row, text));
    return asked < 0 ? undefined : list.slice(asked + 1).find((row) => row.role === "assistant");
  };
  let firstReplied = Number.NaN;
  await expect
    .poll(async () => (firstReplied = at(replyTo(await rows(first.key), "First of two"))), {
      timeout: 30_000,
    })
    .not.toBeNaN();
  const secondRows = await rows(second.key);
  const secondAsked = at(
    secondRows.findLast((row) => row.role === "user" && said(row, "Second of two")),
  );
  expect(secondAsked).toBeLessThan(firstReplied);
  await expect(
    page.getByTestId("transcript-turn").filter({ hasText: "First of two at once." }),
  ).toHaveCount(1);
  await expect(
    page
      .getByTestId("transcript-turn")
      .filter({ hasText: "Here is a long answer, streamed slowly." }),
  ).not.toHaveCount(0);
});

test("F-282: Start as new task runs the message in a new task under the same bot", async ({
  page,
}) => {
  await openShell(page);
  const { title } = await ownTask(page, "Restore plans");
  const titles = async () =>
    (await allTasks(page, "Otto")).locator(".task-title").allTextContents();
  const before = new Set(await titles());
  await composer(page).fill("Plan the next restore test.");
  await page.keyboard.press("ControlOrMeta+Shift+Enter");
  await expect(page.getByTestId("announcer")).toHaveText("Started as a new task");
  await expect(composer(page)).toHaveValue("");
  // The task it was typed in stays open.
  await expect(page.getByRole("button", { name: `Otto, ${title}. Show details.` })).toBeVisible();
  // The new task is the one the rail did not list before: it holds the message, and the bot
  // ran it there. Another check's task made meanwhile is told apart by what it holds.
  let fresh: string[] = [];
  await expect
    .poll(async () => (fresh = (await titles()).filter((each) => !before.has(each))).length, {
      timeout: 20_000,
    })
    .toBeGreaterThan(0);
  const turns = page.getByTestId("transcript-turn");
  const mine = turns.filter({ hasText: "Plan the next restore test." }).first();
  for (const candidate of fresh) {
    await (await allTasks(page, "Otto")).filter({ hasText: candidate }).first().click();
    const shown = await mine
      .waitFor({ state: "visible", timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    if (shown) break;
  }
  await expect(mine).toBeVisible();
  await expect(page.locator(".transcript")).toContainText(
    "This is the scripted development model",
    {
      timeout: 20_000,
    },
  );
});

/** Whether the gateway has nothing in flight or waiting in a task, so a check leaves it as it found it. */
async function gatewayIdle(key: string): Promise<boolean> {
  const history = await gatewayCall<{
    inFlightRun?: unknown;
    pendingInputs?: { items?: unknown[] };
  }>("chat.history", { sessionKey: key, limit: 1 });
  return !history.inFlightRun && (history.pendingInputs?.items ?? []).length === 0;
}

/** Whether a run's tool call is under way on the gateway: its in-flight run's events show the tool started. */
async function toolStarted(key: string, runId: string): Promise<boolean> {
  type Event = { stream?: string; data?: { phase?: string; kind?: string } };
  const history = await gatewayCall<{ inFlightRun?: { runId?: string; events?: Event[] } }>(
    "chat.history",
    { sessionKey: key, limit: 1 },
  );
  return (
    history.inFlightRun?.runId === runId &&
    (history.inFlightRun.events ?? []).some(
      (event) =>
        (event.stream === "tool" && event.data?.phase === "start") ||
        (event.stream === "item" && event.data?.kind === "tool" && event.data.phase === "start"),
    )
  );
}

/**
 * Where the gateway's history answers a message of yours: "inside" when the first reply after
 * it belongs to `runId` (it was steered into that run), "own" when it belongs to another run (a
 * turn of its own), "none" while history holds no reply after it, or no such message.
 */
async function answeredInsideRun(
  key: string,
  text: string,
  runId: string,
): Promise<"inside" | "own" | "none"> {
  type Row = { role: string; content?: unknown; __openclaw?: { runId?: string } };
  const history = await gatewayCall<{ messages: Row[] }>("chat.history", {
    sessionKey: key,
    limit: 40,
  });
  const asked = history.messages.findIndex(
    (row) => row.role === "user" && JSON.stringify(row.content ?? "").includes(text),
  );
  if (asked < 0) return "none";
  const reply = history.messages
    .slice(asked + 1)
    .find((row) => row.role !== "user" && typeof row.__openclaw?.runId === "string");
  if (!reply) return "none";
  return reply.__openclaw!.runId === runId ? "inside" : "own";
}

/** Whether the gateway's history of a task holds a message of yours with this text. */
async function gatewayHasMessage(key: string, text: string): Promise<boolean> {
  const history = await gatewayCall<{ messages: Array<{ role: string; content?: unknown }> }>(
    "chat.history",
    { sessionKey: key, limit: 40 },
  );
  return history.messages.some(
    (row) => row.role === "user" && JSON.stringify(row.content ?? "").includes(text),
  );
}

test("F-468: a message queued behind a slow reply stays Not sent after a confirmed Stop, and no run starts", async ({
  page,
}) => {
  await openShell(page);
  // A task of its own: no earlier check's stop note or turn is in it.
  const { key } = await ownTask(page, "Queue then stop");
  // The scripted model's slow reply: still going when Stop is pressed, whatever the machine.
  await composer(page).fill("#slow 15");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("status-line")).toBeVisible();
  const runId = await inFlightRunId(key);
  await composer(page).fill("Then send me a summary of the stop test.");
  await page.keyboard.press("Alt+Enter");
  const row = page
    .getByTestId("shelf-row")
    .filter({ hasText: "Then send me a summary of the stop test." });
  await expect(row).toContainText("Queued");
  await page.getByRole("button", { name: "Stop Otto" }).click();
  // This run's own note, confirmed by the gateway; never a note left by an earlier stop.
  const note = stopNote(page, runId);
  await expect(note).toContainText("Completed actions are not undone.", { timeout: 30_000 });
  await expect(note).toContainText(/^Stopped/);
  // The engine decides when the stop is confirmed: the message stays, not sent, until asked.
  await expect(row).toContainText("Not sent", { timeout: 15_000 });
  await expect(row.getByRole("button", { name: "Send" })).toBeVisible();
  await expect(page.getByTestId("status-line")).toHaveCount(0);
  expect(await gatewayHasMessage(key, "Then send me a summary of the stop test.")).toBe(false);
  // Removed, it never reaches the gateway.
  await row.getByRole("button", { name: "Remove" }).click();
  await expect(row).toHaveCount(0);
  await expect.poll(() => gatewayIdle(key), { timeout: 30_000 }).toBe(true);
});

test("F-468: a real question holds a message typed while it is pending, and answering releases it", async ({
  page,
}) => {
  await openShell(page);
  const { key } = await ownTask(page, "Held behind a question");
  await composer(page).fill("#ask");
  await page.keyboard.press("Enter");
  const card = page.getByTestId("question-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("status-phrase")).toHaveText("Waiting for you");
  const text = "Also keep anything from this month, as asked.";
  await composer(page).fill(text);
  await page.keyboard.press("Enter");
  const row = page.getByTestId("shelf-row").filter({ hasText: text });
  await expect(row).toContainText("Held until you answer");
  await expect(row.getByRole("button", { name: "Send now" })).toHaveCount(0);
  await expect(page.getByTestId("needs-you")).toContainText("Otto asked you a question");
  expect(await gatewayHasMessage(key, text)).toBe(false);
  // Answering the question, the last one pending, releases the held message.
  await card.locator(".option").first().click();
  await expect(row).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(() => gatewayHasMessage(key, text), { timeout: 30_000 }).toBe(true);
  await expect(page.getByTestId("status-line")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("transcript-turn").filter({ hasText: text })).not.toHaveCount(0);
});

/** The action cards' and folds' lines in a transcript, in order. */
const actionLines = (page: Page) =>
  page.locator(".transcript details.card.action > summary").evaluateAll((nodes) =>
    // A duration is said only where the gateway reported it; history does not, so it says "done".
    nodes.map((node) => node.getAttribute("aria-label")!.replace(/, ([0-9.]+ seconds|done)$/, "")),
  );

// These runs go to a task of their own, so nothing another check leaves behind (a stopped run,
// a refused send, another check's reads) changes them.
test("F-488 F-091 F-082 F-087: a real run with several steps: six reads of five files fold into one card, the status line says the running card and brings it into view, and the run ends with a run line", async ({
  page,
}) => {
  await openShell(page);
  const { title } = await ownTaskOf(page, "pip", "Pip", "Go through the workspace");
  await composer(page).fill("Go through the workspace. #read-six #slow-tool 8");
  await page.keyboard.press("Enter");
  // While the slow tool runs: the reads are one card, the slow call its own card, running.
  const status = page.getByTestId("status-line");
  const running = page.locator('.transcript details.card.action[data-status="running"]');
  await expect(running).toHaveCount(1, { timeout: 30_000 });
  const reads = page.locator(".transcript details.card.action[data-fold]").last();
  await expect(reads).toHaveAttribute("data-fold", "6");
  // The scenario reads AGENTS.md twice: five distinct files, six reads (7.4, counting).
  await expect(reads.locator(":scope > summary")).toHaveAccessibleName(
    /^Read 5 files · 6 reads, AGENTS\.md, SOUL\.md, IDENTITY\.md, USER\.md, BOOTSTRAP\.md, /,
  );
  const words = (await running.locator(".action-sentence").textContent())!
    .replace(/\s+/g, " ")
    .trim();
  await expect(status.getByTestId("status-phrase")).toHaveText(words);
  await expect(status).toHaveAttribute("title", words);
  await expect(status).toHaveAccessibleName(`Pip, working: ${words}. Show the action.`);
  const live = await actionLines(page);
  // The text written beside the slow call is one bubble, not repeated as a streaming reply.
  await expect(page.getByText("I read six files in my workspace.", { exact: true })).toHaveCount(1);
  // The status line brings the running card into view and focuses its line, without opening it.
  await page.getByTestId("transcript").evaluate((element) => (element.scrollTop = 0));
  await status.click();
  await expect(running.locator(":scope > summary")).toBeFocused();
  await expect(running).not.toHaveAttribute("open", "");
  // No reasoning text is on screen.
  await expect(
    page.getByText("I will read through my workspace files one after another."),
  ).toBeHidden();
  // The run ends: a run line counts its actions, and the reads are still one card.
  await expect(status).toHaveCount(0, { timeout: 60_000 });
  const run = page.getByTestId("run-line").last();
  await expect(run.locator("summary")).toHaveAccessibleName(/^Worked for \d+s · 7 actions$/);
  const ended = await actionLines(page);
  expect(ended.find((line) => line.startsWith("Read 5 files"))).toBe(
    live.find((line) => line.startsWith("Read 5 files")),
  );

  // History reloaded: the page is loaded again and reads the task anew; the same cards.
  await page.reload();
  await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 20_000 });
  await openTask(page, "Pip", title);
  await expect(page.getByTestId("run-line").last()).toBeVisible({ timeout: 30_000 });
  // Every card is the same. History keeps no `details` for a tool-server result, but the
  // gateway's map of tool names (`tools.effective`) still names the server and tool, once the
  // task's read of it, made after the history loads, has been answered.
  await expect.poll(() => actionLines(page), { timeout: 30_000 }).toEqual(ended);
  expect(ended).toContain("Used coder, slow task");
});

test("F-488 F-090: a real run of 42 actions shows all 42, live and after the page reads its history again", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openShell(page);
  const { title } = await ownTaskOf(page, "pip", "Pip", "Read it all");
  await composer(page).fill(`Read it all. ${Array(7).fill("#read-six").join(" ")}`);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("run-line")).toHaveCount(1, { timeout: 120_000 });
  await expect(page.getByTestId("status-line")).toHaveCount(0, { timeout: 120_000 });
  const run = page.getByTestId("run-line").last();
  await expect(run.locator("summary")).toHaveAccessibleName(/^Worked for \d+s · 42 actions$/);
  /** The reads after the last message of this check, counted through their folds. */
  const reads = () =>
    page.getByTestId("transcript").evaluate((element) => {
      const nodes = [...element.querySelectorAll(".bubble, details.card.action")];
      const start = nodes.findLastIndex((node) => node.textContent?.includes("Read it all."));
      return nodes
        .slice(start + 1)
        .filter((node) => node.matches("details.card.action[data-kind='read']"))
        .reduce((n, node) => n + Number((node as HTMLElement).dataset.fold ?? 1), 0);
    });
  expect(await reads()).toBe(42);

  await page.reload();
  await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 20_000 });
  await openTask(page, "Pip", title);
  await expect(page.getByText("Read it all.", { exact: false }).last()).toBeVisible({
    timeout: 30_000,
  });
  // Drawn from the engine's record: every action, none dropped at an item's bound.
  await expect.poll(reads, { timeout: 30_000 }).toBe(42);
  // The run line counts the same 42; a duration only where the gateway's lifecycle reported it.
  await expect(page.getByTestId("run-line").last().locator("summary")).toHaveAccessibleName(
    /^Worked( for \d+s)? · 42 actions$/,
  );
});

test("F-092 F-294: a real step that fails shows its failure on its own line, and the run line counts it", async ({
  page,
}) => {
  await openShell(page);
  await openTask(page, "Pip", "Two days in the mountains");
  await composer(page).fill("Look for my old notes. #tool-fail");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("status-line")).toHaveCount(0, { timeout: 30_000 });
  const failed = page.locator('.transcript details.card.action[data-status="failed"]').last();
  await expect(failed.locator(":scope > summary")).toHaveAccessibleName(
    /^Couldn't read old-notes\.md, .*, failed$/,
  );
  await expect(failed.locator(".action-state")).toHaveText("Failed");
  await expect(page.getByTestId("run-line").last().locator("summary")).toHaveAccessibleName(
    /^Worked for \d+s · 1 action · 1 failed$/,
  );
  // The error stays in Raw as the gateway sent it.
  await failed.locator(":scope > summary").click();
  await failed.getByRole("tab", { name: "Raw" }).click();
  await expect(failed.getByRole("region", { name: "What the gateway sent" })).toContainText(
    "missing/old-notes.md",
  );
});

test("leaves every other instance's gateway as it found it", () => {
  // Same processes on the same ports as before this run's instance started: the default
  // instance and this run's sentinel. Another named instance belongs to other work on the
  // machine and may stop or restart meanwhile.
  const sentinel = process.env.CLAWTRATE_E2E_SENTINEL!;
  const before = (JSON.parse(process.env.CLAWTRATE_E2E_OTHERS!) as string[]).filter(
    (row) => row.startsWith("(default) ") || row.startsWith(`${sentinel} `),
  );
  expect(before.some((row) => row.startsWith(`${sentinel} `))).toBe(true);
  expect(runningOthers([INSTANCE], [sentinel])).toEqual(expect.arrayContaining(before));
});
