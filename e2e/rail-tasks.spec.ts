// The rail's task actions against a real development gateway: this run's own
// instance, two preview hosts of their own (two devices of the gateway's
// owner), one granted the interactive tier and one left read-only. Every check
// uses a task of its own; each asserts what the gateway holds afterwards, that
// it survives a reload, and what the second connection sees. What the checks
// create is removed, and the arrangement they changed put back, afterwards.
import { expect, test, type Browser, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CLIENT_ID, CLIENT_MODE } from "../packages/core/src/client.ts";
import { admitsDeviceToken as admits } from "../tools/dev-gateway/src/device-token.ts";
import { provenEndpoint } from "../tools/dev-gateway/src/endpoint.ts";
import { runDirFor } from "../tools/dev-gateway/src/instance.ts";
import { openInstance, openOperator } from "../tools/dev-gateway/src/cli.ts";
import { parseJsonOutput } from "../tools/dev-gateway/src/env.ts";
import type { OperatorSession } from "../tools/dev-gateway/src/operator.ts";
import { devGateway, startHost, stopChild } from "./global-setup.ts";
import { leaveIdle } from "./teardown.ts";

const INSTANCE = process.env.CLAWTRATE_DEV_INSTANCE!;
const STATIC = process.env.CLAWTRATE_E2E_STATIC!;
const STAMP = Date.now().toString(36);
/** Where to save screenshots against the real gateway, when set. */
const SHOTS = process.env.CLAWTRATE_RAIL_SHOTS;

// Not serial: the checks run in file order on one worker (playwright.config.ts), each in a
// task of its own, on bots of its own, or on seeded tasks it leaves as it found them, so one
// failing on timing does not keep the others from running.

/** Reads of the gateway go through its command line, slow on a busy machine: each wait has its own deadline. */
const gateway = expect.configure({ timeout: 30_000 });

type Host = { child: ChildProcess; url: string; data: string };
const hosts: Host[] = [];
/** The interface with interactive access, and a second device that stays read-only. */
let page: Page;
let second: Page;
/** A paired operator that watches the gateway's events. */
let watcher: OperatorSession;
/** Tasks this spec made, removed afterwards. */
const made = new Set<string>();

async function openclaw(args: string[]): Promise<string> {
  const result = await openInstance(INSTANCE).runner.run(args);
  if (result.status !== 0)
    throw new Error(`openclaw ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

/** A gateway method with the instance's own operator credentials. */
async function gatewayCall<T>(method: string, params: unknown): Promise<T> {
  return parseJsonOutput<T>(
    await openclaw(["gateway", "call", method, "--params", JSON.stringify(params), "--json"]),
  );
}

type Row = {
  key: string;
  sessionId?: string;
  label?: string;
  pinned?: boolean;
  archived?: boolean;
  unread?: boolean;
  hasActiveRun?: boolean;
  isMain?: boolean;
};
const describe = async (key: string) =>
  (await gatewayCall<{ session: Row | null }>("sessions.describe", { key })).session;
const listed = async (botId: string, archived: boolean | "all" = false) =>
  (
    await gatewayCall<{ sessions: Row[] }>("sessions.list", {
      agentId: botId,
      archived,
      limit: 200,
      excludeCron: true,
      excludeSubagents: true,
    })
  ).sessions;

async function startOwnHost(): Promise<Host> {
  const data = mkdtempSync(join(tmpdir(), "clawtrate-rail-"));
  const started = startHost(INSTANCE, STATIC, data);
  started.gated.release();
  const host = { child: started.host, url: await started.url, data };
  hosts.push(host);
  return host;
}

async function pairedPage(browser: Browser, host: Host): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const next = await context.newPage();
  await next.goto(host.url);
  await next.getByRole("button", { name: "Use the development gateway" }).click();
  await expect(next.getByRole("heading", { name: "Approve this device" })).toBeVisible({
    timeout: 20_000,
  });
  await expect
    .poll(() => devGateway(INSTANCE, "approve"), { timeout: 30_000, intervals: [1000] })
    .toMatch(/^Approved /m);
  await expect(next.getByTestId("bot")).toHaveCount(4, { timeout: 30_000 });
  return next;
}

const botRow = (on: Page, name: string) =>
  on.getByTestId("bot-list").getByRole("button", { name: new RegExp(`^${name}\\b`) });
const taskRow = (on: Page, title: string) =>
  on.getByTestId("task").filter({ hasText: title }).first();

/** Show a bot's tasks, every one of them. */
async function unfold(on: Page, name: string): Promise<void> {
  const row = botRow(on, name).first();
  if ((await row.getAttribute("aria-expanded")) === "false") {
    await row.focus();
    await on.keyboard.press("ArrowRight");
  }
  const showAll = on
    .getByRole("list", { name: `${name}'s tasks` })
    .getByRole("button", { name: /^Show all/ });
  if (await showAll.count()) await showAll.click();
}

async function taskMenu(on: Page, title: string): Promise<void> {
  await taskRow(on, title).focus();
  await on.keyboard.press("Shift+F10");
  await expect(on.getByRole("menu")).toBeVisible();
}

/** A task of its own for one check, made on the gateway and listed by both pages. */
async function ownTask(
  botId: string,
  bot: string,
  label: string,
): Promise<{ key: string; title: string }> {
  const title = `${label} ${STAMP}`;
  const created = await gatewayCall<{ key: string }>("sessions.create", {
    agentId: botId,
    label: title,
  });
  made.add(created.key);
  for (const on of [page, second]) {
    await unfold(on, bot);
    await expect(taskRow(on, title)).toBeVisible({ timeout: 20_000 });
  }
  return { key: created.key, title };
}

async function reload(on: Page): Promise<void> {
  await on.reload();
  await expect(on.getByTestId("bot")).toHaveCount(4, { timeout: 30_000 });
}

/**
 * Ask the page's host to read the gateway's bots and tasks again (the bridge's
 * `retry`, which reloads them while connected): the host lists bots when it
 * connects, and a reload of the page keeps that connection.
 */
async function rereadBots(on: Page): Promise<void> {
  await on.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(`ws://${location.host}/bridge`);
        socket.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as { type: string; id?: string };
          if (message.type === "hello")
            socket.send(
              JSON.stringify({ type: "command", id: "reread", command: { type: "retry" } }),
            );
          else if (message.id === "reread") {
            socket.close();
            resolve();
          }
        };
        socket.onerror = () => reject(new Error("bridge socket error"));
      }),
  );
}

const ROOT = join(import.meta.dirname, "..");

/** This instance's address and shared token, proven as the tool proves them. */
function endpoint(): { url: string; token: string } {
  const proven = provenEndpoint({
    instance: INSTANCE,
    home: homedir(),
    runDir: runDirFor(INSTANCE, join(ROOT, "tools/dev-gateway/.run")),
    checkout: realpathSync(ROOT),
  });
  if ("refusal" in proven) throw new Error(proven.refusal);
  return proven;
}

/** The device token a host keeps for this gateway, from its own data folder. */
function storedToken(host: Host): string {
  const state = JSON.parse(readFileSync(join(host.data, "state.json"), "utf8")) as Record<
    string,
    string
  >;
  const entry = Object.entries(state).find(([key]) => key.startsWith("deviceToken:"));
  if (!entry) throw new Error("the host keeps no device token");
  return (JSON.parse(entry[1]) as { token: string }).token;
}

/**
 * Whether the gateway admits a connection as a host's own device (its key, from
 * its data folder) with this device token and no shared token: as the host would.
 */
async function admitsDeviceToken(host: Host, token: string): Promise<boolean> {
  return admits({
    url: endpoint().url,
    privateKeyPem: readFileSync(join(host.data, "device-key.pem"), "utf8"),
    token,
    clientName: CLIENT_ID,
    mode: CLIENT_MODE,
  });
}

/** Send a message in a task as the person does: the composer of the task open on the page. */
async function sendInTask(on: Page, title: string, text: string): Promise<void> {
  await taskRow(on, title).click();
  await on.getByTestId("composer-input").fill(text);
  await on.getByTestId("composer-input").press("Enter");
}

async function shot(on: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await on.screenshot({ path: join(SHOTS, `${name}.png`) });
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  expect(INSTANCE, "a named instance").toMatch(/^[a-z0-9-]+$/);
  watcher = await openOperator(
    openInstance(INSTANCE),
    "Clawtrate rail check",
    ["operator.read"],
    ["tool-events"],
  );
  await watcher.request("sessions.subscribe", {});
  page = await pairedPage(browser, await startOwnHost());
  // Interactive access, asked as the person asks it: Request access in the access bar.
  await botRow(page, "Pip").first().click();
  const bar = page.getByRole("region", { name: "Access" });
  await bar.getByRole("button", { name: "Request access" }).click();
  await expect(bar).toContainText("Waiting for approval.");
  await expect
    .poll(() => devGateway(INSTANCE, "approve"), { timeout: 30_000, intervals: [1000] })
    .toMatch(/^Approved /m);
  await expect(page.getByTestId("composer-input")).toBeVisible({ timeout: 30_000 });
  second = await pairedPage(browser, await startOwnHost());
});

/** Stop every preview host this spec started, and remove its folder. */
async function stopHosts(): Promise<void> {
  for (const host of hosts.splice(0)) {
    await stopChild(host.child).catch(() => host.child.kill("SIGKILL"));
    rmSync(host.data, { recursive: true, force: true });
  }
}
// A worker that leaves without its hooks (a timeout, an interrupt) takes its hosts with it.
process.once("exit", () => {
  for (const host of hosts) host.child.kill("SIGKILL");
});

/** A step of the teardown, given at most `ms`; one that takes longer is left, not waited on. */
const within = <T>(ms: number, work: Promise<T>): Promise<T | undefined> =>
  Promise.race([
    work,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
  ]);

test.afterAll(async () => {
  test.setTimeout(180_000);
  try {
    // Put the arrangement back as it was: no pins, no sections.
    if (page && hosts.length > 0)
      await within(
        15_000,
        page
          .evaluate(
            async (changes) => {
              for (const change of changes) {
                await new Promise<void>((resolve) => {
                  const socket = new WebSocket(`ws://${location.host}/bridge`);
                  const done = () => {
                    socket.close();
                    resolve();
                  };
                  setTimeout(done, 5_000);
                  socket.onmessage = (event) => {
                    const message = JSON.parse(String(event.data)) as { type: string; id?: string };
                    if (message.type === "hello")
                      socket.send(
                        JSON.stringify({
                          type: "command",
                          id: "undo",
                          command: { type: "changeSidebar", change, base: null },
                        }),
                      );
                    else if (message.id === "undo") done();
                  };
                  socket.onerror = done;
                });
              }
            },
            [
              { op: "pin", botId: "pip", pinned: false },
              { op: "section", botId: "marlow", section: null },
            ],
          )
          .catch(() => {}),
      );
  } finally {
    // The hosts go first, whatever happens to the rest.
    await stopHosts();
  }
  // What the checks made on the gateway, removed in parallel within a deadline.
  await within(
    90_000,
    Promise.allSettled(
      [...made].map(async (key) => {
        const row = await describe(key).catch(() => null);
        if (!row?.sessionId) return;
        await gatewayCall("chat.abort", { sessionKey: key }).catch(() => {});
        if (!row.archived)
          await gatewayCall("sessions.patch", {
            key,
            archived: true,
            expectedSessionId: row.sessionId,
          }).catch(() => {});
        await gatewayCall("sessions.delete", {
          key,
          archivedOnly: true,
          deleteTranscript: true,
          expectedSessionId: row.sessionId,
        }).catch(() => {});
      }),
    ),
  );
  await within(5_000, watcher?.close() ?? Promise.resolve());
  await within(5_000, admin?.close() ?? Promise.resolve());
});

/** When the running check began: a check that fails leaves nothing it started after this. */
let checkStarted = 0;
test.beforeEach(() => {
  checkStarted = Date.now();
});
// Playwright reads its fixtures from the first argument's pattern; this hook needs none.
// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  test.setTimeout(testInfo.timeout + 120_000);
  if (testInfo.status !== testInfo.expectedStatus) await leaveIdle(gatewayCall, checkStarted);
});

test("F-054 F-012: New task from the + at the top right creates an empty task on the gateway, selects it and focuses its composer", async () => {
  const before = new Set((await listed("pip")).map((row) => row.key));
  await botRow(page, "Pip").first().click();
  const plus = page.locator(".rail-top").getByRole("button", { name: "New", exact: true });
  await plus.click();
  await page.getByRole("menuitem", { name: "New task for Pip" }).click();
  await expect(page.getByTestId("composer-input")).toBeFocused({ timeout: 20_000 });
  await expect(page.locator(".title-pill-task")).toHaveText("New task");
  // One new task on the gateway, under Pip, with no run started.
  let created: Row | undefined;
  await expect
    .poll(
      async () => {
        created = (await listed("pip")).find((row) => !before.has(row.key));
        return created?.key ?? null;
      },
      { timeout: 20_000 },
    )
    .toMatch(/^agent:pip:dashboard:/);
  made.add(created!.key);
  expect(created!.hasActiveRun ?? false).toBe(false);
  await expect(page.locator(`.task[data-key="${created!.key}"]`)).toHaveAttribute(
    "aria-current",
    "true",
  );
  // The second device lists it too.
  await unfold(second, "Pip");
  await expect(second.locator(`.task[data-key="${created!.key}"]`)).toBeVisible({
    timeout: 20_000,
  });
});

test("F-055: two tasks of one bot never show each other's messages", async () => {
  const first = await ownTask("pip", "Pip", "Separate one");
  const other = await ownTask("pip", "Pip", "Separate two");
  await taskRow(page, first.title).click();
  const words = `Only in the first task ${STAMP}`;
  await page.getByTestId("composer-input").fill(words);
  await page.getByTestId("composer-input").press("Enter");
  await expect(page.getByTestId("transcript")).toContainText(words, { timeout: 30_000 });
  await taskRow(page, other.title).click();
  await expect(page.locator(".title-pill-task")).toHaveText(other.title);
  await expect(page.getByRole("region", { name: "Conversation" })).not.toContainText(words);
  // And on the gateway: each history is its own.
  const history = async (key: string) =>
    JSON.stringify(await gatewayCall("chat.history", { sessionKey: key, limit: 50 }));
  expect(await history(first.key)).toContain(words);
  expect(await history(other.key)).not.toContain(words);
});

test("F-056: a rename in place reaches the gateway, survives a reload and is seen by the second connection", async () => {
  const task = await ownTask("pip", "Pip", "Rename me");
  const renamed = `Renamed ${STAMP}`;
  await taskRow(page, task.title).dblclick();
  await page.getByRole("textbox", { name: `Rename ${task.title}` }).fill(renamed);
  await page.keyboard.press("Enter");
  await expect(taskRow(page, renamed)).toBeFocused({ timeout: 20_000 });
  await gateway.poll(async () => (await describe(task.key))?.label).toBe(renamed);
  await expect(taskRow(second, renamed)).toBeVisible({ timeout: 20_000 });
  await shot(page, "renamed-light-1440");
  await reload(page);
  await unfold(page, "Pip");
  await expect(taskRow(page, renamed)).toBeVisible({ timeout: 20_000 });
});

test("F-014: a task's pin reaches the gateway, survives a reload and is seen by the second connection", async () => {
  const task = await ownTask("pip", "Pip", "Pin me");
  await taskMenu(page, task.title);
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
  await gateway.poll(async () => (await describe(task.key))?.pinned).toBe(true);
  for (const on of [page, second]) {
    await expect(
      on.getByRole("list", { name: "Pip's tasks" }).getByTestId("task").first(),
    ).toHaveAccessibleName(new RegExp(`^${task.title}, pinned`), { timeout: 20_000 });
  }
  await reload(page);
  await unfold(page, "Pip");
  await expect(
    page.getByRole("list", { name: "Pip's tasks" }).getByTestId("task").first(),
  ).toHaveAccessibleName(new RegExp(`^${task.title}, pinned`));
  await taskMenu(page, task.title);
  await page.getByRole("menuitem", { name: "Unpin" }).click();
  await gateway.poll(async () => (await describe(task.key))?.pinned ?? false).toBe(false);
});

test("F-022: Mark as unread reaches the gateway, survives a reload and is seen by the second connection; opening reads it", async () => {
  const task = await ownTask("pip", "Pip", "Unread me");
  await gateway.poll(async () => (await describe(task.key))?.unread ?? false).toBe(false);
  await taskMenu(page, task.title);
  await page.getByRole("menuitem", { name: "Mark as unread" }).click();
  await gateway.poll(async () => (await describe(task.key))?.unread).toBe(true);
  await expect(taskRow(second, task.title).locator(".unread-dot")).toHaveCount(1, {
    timeout: 20_000,
  });
  await reload(page);
  await unfold(page, "Pip");
  await expect(taskRow(page, task.title).locator(".unread-dot")).toHaveCount(1, {
    timeout: 20_000,
  });
  // Opening it on the writing device reads it on the gateway, and the other device sees that.
  await taskRow(page, task.title).click();
  await expect
    .poll(async () => (await describe(task.key))?.unread, { timeout: 20_000 })
    .toBe(false);
  await expect(taskRow(second, task.title).locator(".unread-dot")).toHaveCount(0, {
    timeout: 20_000,
  });
});

test("F-277: Archive moves a task into the bot's Archived group on the gateway, survives a reload and leaves the second connection's list; Restore brings it back", async () => {
  const task = await ownTask("pip", "Pip", "Archive me");
  await taskMenu(page, task.title);
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await gateway.poll(async () => (await describe(task.key))?.archived).toBe(true);
  await expect(taskRow(second, task.title)).toHaveCount(0, { timeout: 20_000 });
  await reload(page);
  await unfold(page, "Pip");
  await expect(taskRow(page, task.title)).toHaveCount(0);
  await page
    .getByRole("list", { name: "Pip's tasks" })
    .getByRole("button", { name: "Archived", exact: true })
    .click();
  const archived = page.getByRole("list", { name: "Pip's archived tasks" });
  await expect(archived.getByTestId("archived-task").filter({ hasText: task.title })).toBeVisible({
    timeout: 20_000,
  });
  await shot(page, "archived-light-1440");
  await archived.getByTestId("archived-task").filter({ hasText: task.title }).click();
  await page.getByRole("menuitem", { name: "Restore" }).click();
  await gateway.poll(async () => (await describe(task.key))?.archived ?? false).toBe(false);
  await expect(taskRow(second, task.title)).toBeVisible({ timeout: 20_000 });
});

test("F-278: Delete, confirmed, stops the task's active run first, then removes the task and its transcript; what the bot saved to memory stays", async () => {
  const task = await ownTask("pip", "Pip", "Delete me");
  // The bot saves a memory note during the task.
  const memory = join(
    openInstance(INSTANCE).stateDir,
    "workspaces",
    "pip",
    "memory",
    "2026-11-17.md",
  );
  await sendInTask(page, task.title, "#remember");
  await gateway.poll(() => existsSync(memory)).toBe(true);
  const saved = readFileSync(memory, "utf8");
  await gateway.poll(async () => (await describe(task.key))?.hasActiveRun ?? false).toBe(false);
  // A long run is under way when Delete is chosen.
  await sendInTask(page, task.title, "#slow 40");
  await gateway.poll(async () => (await describe(task.key))?.hasActiveRun).toBe(true);
  await taskMenu(page, task.title);
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  const dialog = page.getByRole("dialog", { name: `Delete “${task.title}”?` });
  await expect(dialog).toContainText("Its run is stopped first.");
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
  // The run ended as stopped before the task went: its abort and end come before the removal.
  const ofTask = (event: { payload: unknown }) =>
    (event.payload as { sessionKey?: string; key?: string }).sessionKey === task.key ||
    (event.payload as { key?: string }).key === task.key;
  const removedAt = () =>
    watcher.events.findIndex(
      (event) =>
        event.event === "sessions.changed" &&
        ofTask(event) &&
        /delete/.test(String((event.payload as { reason?: string }).reason)),
    );
  await gateway.poll(removedAt).toBeGreaterThan(-1);
  const abortedAt = watcher.events.findIndex(
    (event) =>
      event.event === "chat" &&
      ofTask(event) &&
      (event.payload as { state?: string }).state === "aborted",
  );
  const endedAt = watcher.events.findIndex(
    (event) =>
      event.event === "agent" &&
      ofTask(event) &&
      (event.payload as { data?: { phase?: string } }).data?.phase === "end",
  );
  expect(abortedAt).toBeGreaterThan(-1);
  expect(endedAt).toBeGreaterThan(-1);
  expect(Math.max(abortedAt, endedAt)).toBeLessThan(removedAt());
  // The task and its transcript are gone; the memory note is as it was.
  await gateway.poll(async () => await describe(task.key)).toBeNull();
  expect((await listed("pip", "all")).some((row) => row.key === task.key)).toBe(false);
  const history = await openInstance(INSTANCE).runner.run([
    "gateway",
    "call",
    "chat.history",
    "--params",
    JSON.stringify({ sessionKey: task.key, limit: 50 }),
    "--json",
  ]);
  const messages =
    history.status === 0
      ? (parseJsonOutput<{ messages?: unknown[] }>(history.stdout).messages ?? [])
      : [];
  expect(messages).toEqual([]);
  expect(readFileSync(memory, "utf8")).toBe(saved);
  await expect(taskRow(page, task.title)).toHaveCount(0);
  await expect(taskRow(second, task.title)).toHaveCount(0, { timeout: 20_000 });
});

test("F-277: Stop and archive stops a working task's run and archives it; restored, its history is as it was", async () => {
  const task = await ownTask("pip", "Pip", "Stop and archive me");
  await sendInTask(page, task.title, "Hello");
  await gateway.poll(async () => (await describe(task.key))?.hasActiveRun ?? false).toBe(false);
  const history = async () =>
    JSON.stringify(
      (
        await gatewayCall<{ messages: Array<{ __openclaw?: { id?: string }; role?: string }> }>(
          "chat.history",
          { sessionKey: task.key, limit: 50 },
        )
      ).messages.map((message) => [message.__openclaw?.id, message.role]),
    );
  await sendInTask(page, task.title, "#slow 40");
  await gateway.poll(async () => (await describe(task.key))?.hasActiveRun).toBe(true);
  await taskMenu(page, task.title);
  await page.getByRole("menuitem", { name: "Stop and archive…" }).click();
  const dialog = page.getByRole("dialog", { name: /Stop and archive/ });
  await dialog.getByRole("button", { name: "Stop and archive" }).click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
  await gateway.poll(async () => (await describe(task.key))?.archived).toBe(true);
  expect(
    watcher.events.some(
      (event) =>
        event.event === "chat" &&
        (event.payload as { sessionKey?: string }).sessionKey === task.key &&
        (event.payload as { state?: string }).state === "aborted",
    ),
  ).toBe(true);
  const archivedHistory = await history();
  // Restored from the Archived group: the same history.
  const toggle = page
    .getByRole("list", { name: "Pip's tasks" })
    .getByRole("button", { name: "Archived", exact: true });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  const archived = page.getByRole("list", { name: "Pip's archived tasks" });
  await archived.getByTestId("archived-task").filter({ hasText: task.title }).click();
  await page.getByRole("menuitem", { name: "Restore" }).click();
  await gateway.poll(async () => (await describe(task.key))?.archived ?? false).toBe(false);
  expect(await history()).toBe(archivedHistory);
  expect(JSON.parse(archivedHistory).length).toBeGreaterThanOrEqual(2);
});

test("F-022: a new reply marks a task unread on both devices; a Mark as unread from another client stays while the task is open here", async () => {
  const task = await ownTask("pip", "Pip", "New reply");
  // A reply from a run started elsewhere, in a task neither device has open.
  await gatewayCall("chat.send", {
    sessionKey: task.key,
    message: "Hello",
    idempotencyKey: `${task.key}-hello`,
  });
  for (const on of [page, second])
    await expect(taskRow(on, task.title).locator(".unread-dot")).toHaveCount(1, {
      timeout: 30_000,
    });
  // Opened here, it is read; marked unread by another client while open, it stays unread.
  await taskRow(page, task.title).click();
  await gateway.poll(async () => (await describe(task.key))?.unread).toBe(false);
  await expect(taskRow(second, task.title).locator(".unread-dot")).toHaveCount(0, {
    timeout: 20_000,
  });
  await gatewayCall("sessions.patch", { key: task.key, unread: true });
  await expect(taskRow(second, task.title).locator(".unread-dot")).toHaveCount(1, {
    timeout: 20_000,
  });
  // Both devices have the change now; the open one does not clear it.
  const until = Date.now() + 3_000;
  while (Date.now() < until) expect((await describe(task.key))?.unread).toBe(true);
});

test("F-021: a question from a run puts its bot in Waiting for you: a question until it is answered", async () => {
  const task = await ownTask("pip", "Pip", "Ask me");
  await sendInTask(page, task.title, "#ask");
  const pip = botRow(page, "Pip").first();
  await expect(pip.locator(".bot-preview")).toHaveText("Waiting for you: a question", {
    timeout: 30_000,
  });
  await expect(pip).toHaveAccessibleName(/^Pip, waiting for you/);
  await expect(taskRow(page, task.title)).toHaveAccessibleName(/, needs you$/);
  // Answered (dismissed) on the gateway by another client: nothing is pending, the state clears.
  const pending = await gatewayCall<{ questions: Array<{ id: string; sessionKey?: string }> }>(
    "question.list",
    {},
  );
  const question = pending.questions.find((each) => each.sessionKey === task.key);
  expect(question, "the run's question is pending on the gateway").toBeTruthy();
  await gatewayCall("question.resolve", { id: question!.id, cancel: true });
  await expect(pip).not.toHaveAccessibleName(/waiting for you/, { timeout: 30_000 });
});

test("F-014 F-016: a bot's pin and its section are kept on the gateway for the user: they survive a reload and the second device shows them", async () => {
  await botRow(page, "Pip").first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
  await expect(page.getByRole("list", { name: "Pinned bots" }).locator(".pin")).toHaveCount(1, {
    timeout: 20_000,
  });
  await botRow(page, "Marlow").first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to…" }).click();
  await page.getByRole("menuitem", { name: "New section…" }).click();
  await page.getByRole("textbox", { name: "Section name" }).fill("Writing");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("list", { name: "Writing" }).getByTestId("bot")).toHaveCount(1, {
    timeout: 20_000,
  });
  // The other device, a different browser and host with nothing of this one's, shows both.
  await expect(second.getByRole("list", { name: "Pinned bots" }).locator(".pin")).toHaveCount(1, {
    timeout: 20_000,
  });
  await expect(
    second.getByRole("list", { name: "Writing" }).getByTestId("bot"),
  ).toHaveAccessibleName(/^Marlow/);
  await shot(page, "pins-sections-light-1440");
  await reload(second);
  await expect(second.getByRole("list", { name: "Pinned bots" }).locator(".pin")).toHaveCount(1, {
    timeout: 20_000,
  });
  await expect(second.locator(".rail-section", { hasText: "Writing" })).toBeVisible();
  // On the read-only device the gateway's arrangement offers no change.
  await botRow(second, "Marlow").first().click({ button: "right" });
  const items = await second.getByRole("menu").getByRole("menuitem").allTextContents();
  expect(items).not.toContain("Pin");
  expect(items).not.toContain("Move to…");
  await second.keyboard.press("Escape");
});

test("F-021 F-057: while a bot's run waits for an approval its row says Waiting for you on both devices; stopped, the state clears and the task says stopped where it was not open", async () => {
  const task = await ownTask("otto", "Otto", "Wait for me");
  await taskRow(page, task.title).click();
  await page.getByTestId("composer-input").fill("#approve");
  await page.getByTestId("composer-input").press("Enter");
  for (const on of [page, second]) {
    const otto = botRow(on, "Otto").first();
    await expect(otto).toHaveAccessibleName(/^Otto, waiting for you/, { timeout: 30_000 });
    await expect(otto.locator(".presence")).toHaveAttribute("data-state", "waiting");
  }
  await expect(botRow(second, "Otto").first().locator(".bot-preview")).toHaveText(
    "Waiting for you: approve a command",
  );
  await expect(taskRow(second, task.title)).toHaveAccessibleName(/, needs you$/);
  await shot(second, "waiting-light-1440");
  // Stopped: nothing is pending, and the state clears everywhere.
  await gatewayCall("chat.abort", { sessionKey: task.key });
  for (const on of [page, second]) {
    await expect(botRow(on, "Otto").first()).not.toHaveAccessibleName(/waiting for you/, {
      timeout: 30_000,
    });
  }
  // The gateway's row keeps no status for a stopped run; the lifecycle's end said so.
  await expect(taskRow(second, task.title)).toHaveAccessibleName(/, stopped$/, { timeout: 20_000 });
  await expect(taskRow(second, task.title).locator(".glyph")).toHaveAttribute(
    "data-state",
    "stopped",
  );
});

/** A paired admin connection of this spec's own, for making and removing its bots. */
let admin: OperatorSession | null = null;
async function adminClient(): Promise<OperatorSession> {
  admin ??= await openOperator(
    openInstance(INSTANCE),
    "Clawtrate rail check (admin)",
    ["operator.read", "operator.write", "operator.admin"],
    [],
  );
  return admin;
}

/** Whether the gateway lists a bot now, by its own `agents.list`. */
async function listsBot(botId: string): Promise<boolean> {
  const listed = (await (await adminClient()).request("agents.list", {})) as {
    agents?: Array<{ id: string }>;
  };
  return (listed.agents ?? []).some((agent) => agent.id === botId);
}

/** A bot made on the gateway for one check, once the gateway lists it; removed by the caller. */
async function ownBot(name: string): Promise<string> {
  const created = (await (
    await adminClient()
  ).request("agents.create", {
    name,
    workspace: join(openInstance(INSTANCE).stateDir, "workspaces", name.toLowerCase()),
    model: "scripted/dev-1",
  })) as { agentId: string };
  await expect.poll(() => listsBot(created.agentId), { timeout: 60_000 }).toBe(true);
  return created.agentId;
}

async function removeBot(botId: string): Promise<void> {
  await (
    await adminClient()
  )
    .request("agents.delete", { agentId: botId, deleteFiles: true })
    .catch(() => {});
  await expect.poll(() => listsBot(botId), { timeout: 60_000 }).toBe(false);
}

/**
 * Wait until the page's rail shows (or no longer shows) a bot: its host lists bots when it
 * connects, so it is asked to read them again until it does, within a deadline.
 */
async function railShowsBot(on: Page, name: string, shown: boolean): Promise<void> {
  await expect
    .poll(
      async () => {
        await rereadBots(on).catch(() => {});
        return (await botRow(on, name).count()) > 0;
      },
      { timeout: 90_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toBe(shown);
}

test("F-424: a bot's canonical main stays and offers neither Archive nor Delete; a bot without one gets exactly one empty Main, selected, when its last task is archived or deleted, however many clients act", async () => {
  // Two bots of its own are made and removed; each step waits on the gateway with its own deadline.
  test.setTimeout(300_000);
  // The gateway refuses to archive a canonical main, and the rail offers neither action for it.
  const main = await describe("agent:marlow:main");
  expect(main?.isMain).toBe(true);
  const refused = await openInstance(INSTANCE).runner.run([
    "gateway",
    "call",
    "sessions.patch",
    "--params",
    JSON.stringify({
      key: "agent:marlow:main",
      archived: true,
      expectedSessionId: main!.sessionId,
    }),
    "--json",
  ]);
  expect(refused.stdout + refused.stderr).toContain("Cannot archive an agent's main session.");
  await unfold(page, "Marlow");
  await taskMenu(page, "Notes for Pip");
  const items = await page.getByRole("menu").getByRole("menuitem").allTextContents();
  expect(items).not.toContain("Archive");
  expect(items).not.toContain("Delete…");
  await page.keyboard.press("Escape");

  // Two bots of this check's own, made on the gateway with no main session.
  const archiving = await ownBot(`Scout${STAMP}`);
  const deleting = await ownBot(`Ranger${STAMP}`);
  /** Each bot's one task, by bot. */
  const onlyTask = new Map<string, string>();
  try {
    for (const botId of [archiving, deleting]) {
      // Each bot's one task of its own, made once the gateway lists the bot.
      const only = (await (
        await adminClient()
      ).request("sessions.create", {
        agentId: botId,
        label: `Only task ${STAMP}`,
      })) as { key: string };
      made.add(only.key);
      onlyTask.set(botId, only.key);
    }
    await railShowsBot(page, `Scout${STAMP}`, true);
    await railShowsBot(page, `Ranger${STAMP}`, true);
    const onlyMain = async (botId: string) => {
      await gateway
        .poll(async () =>
          (await listed(botId)).map((row) => [row.key, row.isMain === true, row.label ?? null]),
        )
        .toEqual([[`agent:${botId}:main`, true, null]]);
      made.add(`agent:${botId}:main`);
    };
    // Archive: the bot's own menu, then exactly one Main, selected, with its composer.
    const scout = botRow(page, `Scout${STAMP}`).first();
    await expect(scout).toHaveAccessibleName(new RegExp(`^Scout${STAMP}, 1 task`), {
      timeout: 20_000,
    });
    await scout.click();
    await scout.focus();
    await page.keyboard.press("Shift+F10");
    await page.getByRole("menuitem", { name: "Archive task" }).click();
    await expect(page.locator(".title-pill-task")).toHaveText("Main", { timeout: 20_000 });
    await onlyMain(archiving);
    await expect(page.getByTestId("composer-input")).toBeVisible();
    // The new Main is canonical: neither action is offered for it.
    await scout.focus();
    await page.keyboard.press("Shift+F10");
    const mainItems = await page.getByRole("menu").getByRole("menuitem").allTextContents();
    expect(mainItems).not.toContain("Archive task");
    expect(mainItems).not.toContain("Delete task…");
    await page.keyboard.press("Escape");

    // Delete, while another client makes the bot's Main at the same moment: still one.
    const ranger = botRow(page, `Ranger${STAMP}`).first();
    await ranger.click();
    await ranger.focus();
    await page.keyboard.press("Shift+F10");
    await page.getByRole("menuitem", { name: "Delete task…" }).click();
    const other = openInstance(INSTANCE).runner.run([
      "gateway",
      "call",
      "sessions.create",
      "--params",
      JSON.stringify({ agentId: deleting, key: `agent:${deleting}:main` }),
      "--json",
    ]);
    await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
    await other;
    // The delete completed: the dialog closed with no error, and the task is gone from the
    // gateway, not only archived.
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
    await gateway.poll(async () => await describe(onlyTask.get(deleting)!)).toBeNull();
    await expect(page.locator(".title-pill-task")).toHaveText("Main", { timeout: 20_000 });
    await onlyMain(deleting);
  } finally {
    await removeBot(archiving);
    await removeBot(deleting);
    await railShowsBot(page, `Scout${STAMP}`, false);
    await railShowsBot(page, `Ranger${STAMP}`, false);
  }
});

test("a read-only connection offers none of the task actions on a real gateway", async () => {
  await expect(
    second.locator(".rail-top").getByRole("button", { name: "New", exact: true }),
  ).toHaveCount(0);
  await unfold(second, "Pip");
  await expect(second.getByTestId("new-task-row")).toHaveCount(0);
  await expect(second.getByTestId("archived-group")).toHaveCount(0);
  const first = second.getByRole("list", { name: "Pip's tasks" }).getByTestId("task").first();
  await first.focus();
  await second.keyboard.press("Shift+F10");
  await expect(second.getByRole("menu").getByRole("menuitem")).toHaveText(["Copy conversation ID"]);
  await second.keyboard.press("Escape");
  await second.keyboard.press("F2");
  await expect(second.getByTestId("task-rename")).toHaveCount(0);
});

test("F-021: a device opened again while its run waits for an approval shows the bot waiting, until nothing is pending", async () => {
  const task = await ownTask("otto", "Otto", "Wait across a restart");
  await sendInTask(page, task.title, "#approve");
  await expect(botRow(page, "Otto").first()).toHaveAccessibleName(/^Otto, waiting for you/, {
    timeout: 30_000,
  });
  // The same device, quit and opened again: a new host on the same data folder.
  const before = hosts[0]!;
  await stopChild(before.child);
  const started = startHost(INSTANCE, STATIC, before.data);
  started.gated.release();
  hosts[0] = { child: started.host, url: await started.url, data: before.data };
  await page.goto(hosts[0].url);
  await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 30_000 });
  await expect(botRow(page, "Otto").first()).toHaveAccessibleName(/^Otto, waiting for you/, {
    timeout: 30_000,
  });
  await expect(botRow(page, "Otto").first().locator(".bot-preview")).toHaveText(
    "Waiting for you: approve a command",
  );
  await gatewayCall("chat.abort", { sessionKey: task.key });
  await expect(botRow(page, "Otto").first()).not.toHaveAccessibleName(/waiting for you/, {
    timeout: 30_000,
  });
});

test("F-456: Re-pair in Settings: pending, then refused, the old authorization stays and still connects, and the error shows; approved, the new authorization replaces the old one", async () => {
  const host = hosts[1]!;
  const settings = second.getByRole("dialog", { name: "Settings" });
  await second.keyboard.press("ControlOrMeta+,");
  await expect(settings.getByTestId("granted-scopes")).toHaveText("operator.read");
  const oldToken = storedToken(host);
  expect(await admitsDeviceToken(host, oldToken)).toBe(true);

  // Refused on the gateway's machine: the error shows and the old authorization stays.
  await settings.getByRole("button", { name: "Re-pair" }).click();
  await expect(settings.getByTestId("gateway-state")).toHaveText("Pairing pending", {
    timeout: 20_000,
  });
  const pending =
    parseJsonOutput<{ pending?: Array<{ requestId: string }> }>(
      await openclaw(["devices", "list", "--json"]),
    ).pending ?? [];
  expect(pending.length).toBe(1);
  await openclaw(["devices", "reject", pending[0]!.requestId]);
  await expect(settings.getByTestId("repair-problem")).toHaveText(
    "The gateway's owner rejected the new pairing. This device keeps its earlier access.",
    { timeout: 20_000 },
  );
  await expect(settings.getByTestId("gateway-state")).toHaveText("Connected");
  await expect(settings.getByTestId("granted-scopes")).toHaveText("operator.read");
  expect(storedToken(host)).toBe(oldToken);
  expect(await admitsDeviceToken(host, oldToken)).toBe(true);

  // Approved: the new authorization is stored and works; the old one no longer does.
  await settings.getByRole("button", { name: "Re-pair" }).click();
  await expect(settings.getByTestId("gateway-state")).toHaveText("Pairing pending", {
    timeout: 20_000,
  });
  await expect
    .poll(() => devGateway(INSTANCE, "approve"), { timeout: 30_000, intervals: [1000] })
    .toMatch(/^Approved /m);
  await expect(settings.getByTestId("granted-scopes")).toContainText("operator.write", {
    timeout: 30_000,
  });
  await expect(settings.getByTestId("gateway-state")).toHaveText("Connected");
  await expect(settings.getByRole("button", { name: "Re-pair" })).toHaveCount(0);
  const newToken = storedToken(host);
  expect(newToken).not.toBe(oldToken);
  expect(await admitsDeviceToken(host, newToken)).toBe(true);
  expect(await admitsDeviceToken(host, oldToken)).toBe(false);
  await second.keyboard.press("Escape");
});
