// The rail's task actions in the fixture: keyboard paths, where focus goes
// after each action, what the host is asked, and that a read-only connection
// offers none of them.
import type { BridgeCommand } from "../packages/core/src/bridge.ts";
import { expect, test, type Page } from "@playwright/test";
import { contextFor, openFixture, settle, SIZES } from "./fixture.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;
const OTTO = "bot=otto&task=agent:otto:disk-space";

test.use(contextFor(WIDE, "light"));

const rail = (page: Page) => page.getByRole("navigation", { name: "Bots" });
const bot = (page: Page, name: string) =>
  page.getByTestId("bot-list").getByRole("button", { name: new RegExp(`^${name}\\b`) });
const tasksOf = (page: Page, name: string) =>
  page.getByRole("list", { name: `${name}'s tasks` }).getByTestId("task");
const taskRow = (page: Page, title: string) =>
  page.getByTestId("task").filter({ hasText: title }).first();
/** The commands the interface sent the host, of one kind. */
const sent = (page: Page, type: string) =>
  page.evaluate(
    (kind) =>
      (
        window as unknown as { clawtrateFixture: { sent: BridgeCommand[] } }
      ).clawtrateFixture.sent.filter((command) => command.type === kind),
    type,
  );

async function taskMenu(page: Page, title: string) {
  await taskRow(page, title).focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menu", { name: new RegExp(`^${title}`) })).toBeVisible();
}

test("F-012 F-054: on a writing connection a round + sits at the top right beside search; its New task creates an empty task, selects it and focuses its composer", async ({
  page,
}) => {
  await openFixture(page, `scene=rail-write&${OTTO}`, "light");
  const top = page.locator(".rail-top");
  const search = top.getByRole("button", { name: "Search", exact: true });
  const plus = top.getByRole("button", { name: "New", exact: true });
  await expect(plus).toBeVisible();
  // Top right, after search, round.
  const [s, p, r] = await Promise.all([
    search.boundingBox(),
    plus.boundingBox(),
    rail(page).boundingBox(),
  ]);
  expect(p!.x).toBeGreaterThan(s!.x);
  expect(r!.x + r!.width - (p!.x + p!.width)).toBeLessThan(20);
  expect(await plus.evaluate((el) => getComputedStyle(el).borderRadius)).not.toBe("0px");
  await expect(plus).toHaveAttribute("aria-haspopup", "menu");

  await plus.click();
  const menu = page.getByRole("menu", { name: "New" });
  // New task first; New bot follows it in the same menu.
  await expect(menu.getByRole("menuitem")).toHaveText(["New task for Otto⌥T", "New bot⌘N"]);
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("Enter");
  // Selected, first under Otto, and the composer has focus.
  await expect(page.locator(".title-pill-task")).toHaveText("New task");
  await expect(tasksOf(page, "Otto").first()).toHaveAttribute("aria-current", "true");
  await expect(tasksOf(page, "Otto").first()).toHaveAccessibleName("New task");
  await expect(page.locator(".composer-input")).toBeFocused();
  expect(await sent(page, "newTask")).toEqual([{ type: "newTask", botId: "otto", label: null }]);
});

test("F-054: New task from the bot's menu, from the last row of its tasks and with ⌥T, each selects the new task with focus in its composer", async ({
  page,
}) => {
  await openFixture(page, `scene=rail-write&${OTTO}`, "light");
  // A bot that is not open: its menu.
  await bot(page, "Juniper").focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "New task" }).click();
  await expect(page.locator(".composer-input")).toBeFocused();
  await expect(tasksOf(page, "Juniper").first()).toHaveAttribute("aria-current", "true");
  // The New task row at the end of the open bot's tasks.
  await page.getByTestId("new-task-row").first().click();
  await expect(page.locator(".composer-input")).toBeFocused();
  expect((await sent(page, "newTask")).length).toBe(2);
  // The shortcut, from anywhere.
  await page.locator(".transcript, .conversation").first().click();
  await page.keyboard.press("Alt+KeyT");
  await expect.poll(async () => (await sent(page, "newTask")).length).toBe(3);
  await expect(page.locator(".composer-input")).toBeFocused();
});

test("F-054: one create per activation, however fast the presses; one read per open of an unread task", async ({
  page,
}) => {
  await openFixture(page, `scene=rail-write&${OTTO}`, "light");
  // Two clicks dispatched in the same moment, before any answer.
  await page
    .getByTestId("new-task-row")
    .first()
    .evaluate((row: HTMLElement) => {
      row.click();
      row.click();
    });
  await expect(page.locator(".composer-input")).toBeFocused();
  await expect(tasksOf(page, "Otto").filter({ hasText: "New task" })).toHaveCount(1);
  expect(await sent(page, "newTask")).toHaveLength(1);
  // A double-click once that one is made: one more.
  await page.getByTestId("new-task-row").first().dblclick();
  await expect.poll(async () => (await sent(page, "newTask")).length).toBe(2);
  await expect(page.locator(".composer-input")).toBeFocused();
  await expect(tasksOf(page, "Otto").filter({ hasText: "New task" })).toHaveCount(2);
  // Opening an unread task: one read, though the row changes as it is read.
  await taskRow(page, "Weekly backup check").click();
  await expect(taskRow(page, "Weekly backup check").locator(".unread-dot")).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await sent(page, "markTask")).filter(
          (command) => "key" in command && command.key === "agent:otto:backup-check",
        ).length,
    )
    .toBe(1);
  await page.waitForFunction(() => document.querySelector(".composer-input") !== null);
  expect(
    (await sent(page, "markTask")).filter(
      (command) => "key" in command && command.key === "agent:otto:backup-check",
    ),
  ).toEqual([{ type: "markTask", key: "agent:otto:backup-check", unread: false, opened: true }]);
});

test("F-022: a refused unread change leaves the rail and the badge as the gateway reports them", async ({
  page,
}) => {
  await openFixture(page, `scene=rail-write&${OTTO}`, "light");
  const badge = () =>
    page.evaluate(
      () =>
        (window as unknown as { clawtrateFixture: { badge: number | null } }).clawtrateFixture
          .badge,
    );
  await expect.poll(badge).not.toBeNull();
  const before = await badge();
  await page.evaluate(() =>
    (
      window as unknown as { clawtrateFixture: { refuse(type: string): void } }
    ).clawtrateFixture.refuse("markTask"),
  );
  await taskMenu(page, "Certificate renewal");
  await page.getByRole("menuitem", { name: "Mark as unread" }).click();
  await expect(page.getByTestId("rail-notice")).toContainText(
    "Couldn't mark it unread. The gateway refused the change.",
  );
  await expect(taskRow(page, "Certificate renewal")).toHaveAccessibleName(
    "Certificate renewal warning",
  );
  expect(await badge()).toBe(before);
  await taskMenu(page, "Weekly backup check");
  await page.getByRole("menuitem", { name: "Mark as read" }).click();
  await expect(page.getByTestId("rail-notice")).toContainText("Couldn't mark it read.");
  await expect(taskRow(page, "Weekly backup check").locator(".unread-dot")).toHaveCount(1);
  expect(await badge()).toBe(before);
});

test("F-022: two clicks at once on an unread task open it with one read", async ({ page }) => {
  await openFixture(page, `scene=rail-write&${OTTO}`, "light");
  // Both clicks dispatched in the same moment, before any answer.
  await taskRow(page, "Weekly backup check").evaluate((row: HTMLElement) => {
    row.click();
    row.click();
  });
  await expect(page.locator(".title-pill-task")).toHaveText("Weekly backup check");
  const reads = async () =>
    (await sent(page, "markTask")).filter(
      (command) => "key" in command && command.key === "agent:otto:backup-check",
    );
  await expect.poll(async () => (await reads()).length).toBe(1);
  await page.waitForFunction(() => document.querySelector(".composer-input") !== null);
  expect(await reads()).toEqual([
    { type: "markTask", key: "agent:otto:backup-check", unread: false, opened: true },
  ]);
});

test("F-022: a refused read on opening leaves the task unread in the rail and the badge, as the gateway has it", async ({
  page,
}) => {
  await openFixture(page, `scene=rail-write&${OTTO}`, "light");
  const badge = () =>
    page.evaluate(
      () =>
        (window as unknown as { clawtrateFixture: { badge: number | null } }).clawtrateFixture
          .badge,
    );
  await expect.poll(badge).not.toBeNull();
  const before = await badge();
  await page.evaluate(() =>
    (
      window as unknown as { clawtrateFixture: { refuse(type: string): void } }
    ).clawtrateFixture.refuse("markTask"),
  );
  const unread = taskRow(page, "Weekly backup check");
  await expect(unread.locator(".unread-dot")).toHaveCount(1);
  await unread.click();
  await expect.poll(async () => (await sent(page, "markTask")).length).toBeGreaterThan(0);
  // Leaving it, its read is refused again: the dot and the badge stay as the gateway reports.
  await taskRow(page, "Disk almost full on the media box").click();
  await expect.poll(async () => (await sent(page, "markTask")).length).toBeGreaterThanOrEqual(2);
  await expect(unread.locator(".unread-dot")).toHaveCount(1);
  await expect.poll(badge).toBe(before);
});

test("F-278: a confirmed delete of an archived task removes its row and its menu at once", async ({
  page,
}) => {
  await openFixture(page, `scene=rail-write&${OTTO}`, "light");
  await page.getByRole("button", { name: "Archived" }).click();
  const archived = page.getByRole("list", { name: "Otto's archived tasks" });
  await expect(archived.getByTestId("archived-task")).toHaveCount(2);
  await archived.getByTestId("archived-task").filter({ hasText: "Old printer driver" }).click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(
    archived.getByTestId("archived-task").filter({ hasText: "Old printer driver" }),
  ).toHaveCount(0);
  await expect(archived.getByTestId("archived-task")).toHaveCount(1);
  await expect(page.getByRole("menu")).toHaveCount(0);
});

type Fixture = {
  setState: (change: (state: Record<string, unknown>) => Record<string, unknown>) => void;
  invoke: (command: Record<string, unknown>) => Promise<unknown>;
  refuse: (type: string) => void;
  raceArchive: () => void;
  badge: number | null;
  getState: () => { tasksByBot: Record<string, Array<{ key: string; unread: boolean }>> };
};

test("Archive: a task that starts working as Archive goes out gets the Stop and archive question, not an error", async ({
  page,
}) => {
  await openFixture(page, `scene=rail-write&${OTTO}`, "light");
  await taskMenu(page, "Certificate renewal");
  const archive = page.getByRole("menuitem", { name: "Archive", exact: true });
  // Where Archive is offered, it says what the gateway's archive does.
  await expect(archive).toHaveAccessibleDescription("Ends anything running in this task.");
  // The gateway's task starts working while the request is out, before it answers.
  await page.evaluate(() => {
    const bridge = (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture;
    const invoke = bridge.invoke.bind(bridge);
    bridge.invoke = (command) => {
      if (command.type === "archiveTask")
        bridge.setState((state) => {
          const tasksByBot = state.tasksByBot as Record<string, Array<Record<string, unknown>>>;
          return {
            ...state,
            tasksByBot: {
              ...tasksByBot,
              otto: tasksByBot.otto!.map((task) =>
                task.key === command.key ? { ...task, status: "running" } : task,
              ),
            },
          };
        });
      return invoke(command);
    };
  });
  await archive.click();
  const dialog = page.getByRole("dialog", { name: /Stop and archive/ });
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("rail-notice")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Stop and archive" }).click();
  await expect(taskRow(page, "Certificate renewal")).toHaveCount(0);
});

test("Archive: when the archive stopped a run that had just started, the notice says so, with Restore", async ({
  page,
}) => {
  await openFixture(page, `scene=rail-write&${OTTO}`, "light");
  await page.evaluate(() =>
    (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture.raceArchive(),
  );
  await taskMenu(page, "Certificate renewal");
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
  const notice = page.getByTestId("rail-notice");
  await expect(notice).toContainText("Archived. A run that had just started was stopped.");
  await expect(notice).toHaveAttribute("role", "status");
  await notice.getByRole("button", { name: "Restore" }).click();
  await expect(taskRow(page, "Certificate renewal")).toBeVisible();
  // An archive that met no run says nothing more.
  await taskMenu(page, "Router firmware");
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
  await expect(taskRow(page, "Router firmware")).toHaveCount(0);
  await expect(page.getByTestId("rail-notice")).toHaveCount(0);
});

test("F-054: a double-click's second click creates nothing, however fast the first create was answered; a deliberate second New task creates one", async ({
  page,
}) => {
  await openFixture(page, `scene=rail-write&${OTTO}`, "light");
  const row = page.getByTestId("new-task-row").first();
  // The first click's create is answered before the gesture's second click lands.
  await row.evaluate((el) =>
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })),
  );
  await expect(page.locator(".composer-input")).toBeFocused();
  await row.evaluate((el) =>
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 })),
  );
  // A double-click held for longer than the answer takes.
  await row.dblclick({ delay: 180 });
  await expect.poll(async () => (await sent(page, "newTask")).length).toBe(2);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="task"]').length > 0);
  expect(await sent(page, "newTask")).toHaveLength(2);
  // Once that one has opened, New task again is a new task.
  await expect(page.locator(".composer-input")).toBeFocused();
  await row.click();
  await expect.poll(async () => (await sent(page, "newTask")).length).toBe(3);
});

test("F-022: leaving a task whose opening read the gateway refused keeps its dot and the badge, also with an explicit unread mark", async ({
  page,
}) => {
  await openFixture(page, `scene=rail-write&${OTTO}`, "light");
  const key = "agent:otto:backup-check";
  await page.evaluate((key) => {
    const bridge = (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture;
    bridge.setState((state) => {
      const tasksByBot = state.tasksByBot as Record<string, Array<Record<string, unknown>>>;
      return {
        ...state,
        tasksByBot: {
          ...tasksByBot,
          otto: tasksByBot.otto!.map((task) =>
            task.key === key ? { ...task, unread: true, unreadMarker: Date.now() } : task,
          ),
        },
      };
    });
    bridge.refuse("markTask");
  }, key);
  const badge = () =>
    page.evaluate(
      () => (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture.badge,
    );
  await expect.poll(badge).not.toBeNull();
  const before = await badge();
  await taskRow(page, "Weekly backup check").click();
  await expect(page.locator(".title-pill-task")).toHaveText("Weekly backup check");
  await expect
    .poll(
      async () =>
        (await sent(page, "markTask")).filter((command) => "key" in command && command.key === key)
          .length,
    )
    .toBe(1);
  // The refusal is answered while the task is still open; only then is it left.
  await page.evaluate(() => new Promise((done) => setTimeout(done, 200)));
  await taskRow(page, "Disk almost full on the media box").click();
  await expect(page.locator(".title-pill-task")).toHaveText("Disk almost full on the media box");
  await expect(taskRow(page, "Weekly backup check").locator(".unread-dot")).toHaveCount(1);
  await expect.poll(badge).toBe(before);
});

test("F-022 F-023: a reply that comes while the read made on leaving a task is on its way keeps the task unread", async ({
  page,
}) => {
  await openFixture(page, `scene=rail-write&${OTTO}`, "light");
  const key = "agent:otto:backup-check";
  const badge = () =>
    page.evaluate(
      () => (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture.badge,
    );
  await taskRow(page, "Weekly backup check").click();
  await expect(page.locator(".title-pill-task")).toHaveText("Weekly backup check");
  const before = await badge();
  // The new reply reaches the gateway after the leaving read was sent and before it is
  // answered: the fixture records a command once it has taken it.
  await page.evaluate((key) => {
    const bridge = (window as unknown as { clawtrateFixture: Fixture & { sent: BridgeCommand[] } })
      .clawtrateFixture;
    const push = bridge.sent.push.bind(bridge.sent);
    bridge.sent.push = (...commands: BridgeCommand[]) => {
      const length = push(...commands);
      if (commands.some((command) => command.type === "markTask" && command.key === key)) {
        bridge.sent.push = push;
        bridge.setState((state) => {
          const tasksByBot = state.tasksByBot as Record<string, Array<Record<string, unknown>>>;
          return {
            ...state,
            tasksByBot: {
              ...tasksByBot,
              otto: tasksByBot.otto!.map((task) =>
                task.key === key
                  ? { ...task, unread: true, updatedAt: (task.updatedAt as number) + 60_000 }
                  : task,
              ),
            },
          };
        });
      }
      return length;
    };
  }, key);
  await taskRow(page, "Disk almost full on the media box").click();
  await expect(page.locator(".title-pill-task")).toHaveText("Disk almost full on the media box");
  // Past the time the fixture takes to answer the read.
  await page.evaluate(() => new Promise((done) => setTimeout(done, 400)));
  await expect(taskRow(page, "Weekly backup check").locator(".unread-dot")).toHaveCount(1);
  await expect.poll(badge).toBe((before ?? 0) + 1);
});

test("F-277: a task restored from the Archived group and archived again shows in the group again", async ({
  page,
}) => {
  await openFixture(page, `scene=rail-write&${OTTO}`, "light");
  await taskMenu(page, "Certificate renewal");
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
  await expect(taskRow(page, "Certificate renewal")).toHaveCount(0);
  await page.getByRole("button", { name: "Archived", exact: true }).click();
  const archived = page.getByRole("list", { name: "Otto's archived tasks" });
  await archived.getByTestId("archived-task").filter({ hasText: "Certificate renewal" }).click();
  await page.getByRole("menuitem", { name: "Restore" }).click();
  await expect(taskRow(page, "Certificate renewal")).toBeVisible();
  await expect(
    archived.getByTestId("archived-task").filter({ hasText: "Certificate renewal" }),
  ).toHaveCount(0);
  await taskMenu(page, "Certificate renewal");
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
  await expect(
    archived.getByTestId("archived-task").filter({ hasText: "Certificate renewal" }),
  ).toHaveCount(1);
});

test("F-056: double-click or F2 renames in place; Enter renames, Escape keeps the name, and focus returns to the row", async ({
  page,
}) => {
  await openFixture(page, `scene=rail-write&${OTTO}`, "light");
  // F2 from the keyboard, Escape keeps the name.
  await taskRow(page, "Certificate renewal").focus();
  await page.keyboard.press("F2");
  const field = page.getByRole("textbox", { name: "Rename Certificate renewal warning" });
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("Certificate renewal warning");
  await page.keyboard.type("Nope");
  await page.keyboard.press("Escape");
  await expect(field).toHaveCount(0);
  await expect(taskRow(page, "Certificate renewal warning")).toBeFocused();
  expect(await sent(page, "renameTask")).toEqual([]);

  // Double-click, type, Enter: the row and the conversation's header take the name.
  await taskRow(page, "Router firmware").dblclick();
  await page.getByRole("textbox", { name: "Rename Router firmware" }).fill("Router update");
  await page.keyboard.press("Enter");
  await expect(taskRow(page, "Router update")).toBeFocused();
  await expect(page.getByRole("heading", { level: 1, name: "Router update" })).toBeVisible();
  expect(await sent(page, "renameTask")).toEqual([
    { type: "renameTask", key: "agent:otto:router-firmware", label: "Router update" },
  ]);

  // The menu's Rename; a taken name stays in the field with the gateway's reason.
  await taskMenu(page, "Router update");
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await page.getByRole("textbox", { name: "Rename Router update" }).fill("Taken");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: "already called" })).toHaveText(
    'Another task of this bot is already called "Taken".',
  );
  await expect(page.getByRole("textbox", { name: "Rename Router update" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(taskRow(page, "Router update")).toBeFocused();
});

test("F-277: Archive moves a task into the Archived group with focus on the next row; Restore brings it back", async ({
  page,
}) => {
  await openFixture(page, `scene=rail-write&${OTTO}`, "light");
  await taskMenu(page, "Certificate renewal");
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await expect(taskRow(page, "Certificate renewal")).toHaveCount(0);
  await expect(taskRow(page, "Router firmware")).toBeFocused();
  await page.getByRole("button", { name: "Archived" }).click();
  const archived = page.getByRole("list", { name: "Otto's archived tasks" });
  await expect(archived.getByTestId("archived-task").first()).toHaveAccessibleName(
    "Certificate renewal warning, archived",
  );
  // An archived row's menu: Restore and Delete.
  await archived.getByTestId("archived-task").first().focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: "Certificate renewal warning" });
  await expect(menu.getByRole("menuitem")).toHaveText(["Restore", "Delete…"]);
  await menu.getByRole("menuitem", { name: "Restore" }).click();
  await expect(tasksOf(page, "Otto").filter({ hasText: "Certificate renewal" })).toHaveCount(1);
  await expect(taskRow(page, "Certificate renewal")).toBeFocused();
  await expect(archived.getByTestId("archived-task")).toHaveCount(2);
});

test("F-277: a task whose run is active asks Stop and archive or Cancel; Cancel changes nothing and gives focus back", async ({
  page,
}) => {
  await openFixture(page, `scene=rail-write&${OTTO}`, "light");
  await taskMenu(page, "Rotate the logs");
  await page.getByRole("menuitem", { name: "Stop and archive…" }).click();
  const dialog = page.getByRole("dialog", { name: /Stop and archive/ });
  await expect(dialog).toContainText("Archiving it stops its run first.");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(taskRow(page, "Rotate the logs")).toBeFocused();
  expect(await sent(page, "archiveTask")).toEqual([]);
  await taskMenu(page, "Rotate the logs");
  await page.getByRole("menuitem", { name: "Stop and archive…" }).click();
  await dialog.getByRole("button", { name: "Stop and archive" }).click();
  await expect(taskRow(page, "Rotate the logs")).toHaveCount(0);
  expect(await sent(page, "archiveTask")).toEqual([
    { type: "archiveTask", key: "agent:otto:rotate-logs", stop: true },
  ]);
});

test("F-278: Delete asks first, with Cancel focused; Delete removes the task and focus goes to the next row", async ({
  page,
}) => {
  await openFixture(page, `scene=rail-write&${OTTO}`, "light");
  await taskMenu(page, "Certificate renewal");
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete “Certificate renewal warning”?" });
  await expect(dialog).toContainText(
    "It can't be undone. What Otto saved to memory during it stays.",
  );
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  // Tab stays inside the dialog.
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Delete" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(taskRow(page, "Certificate renewal")).toBeFocused();
  expect(await sent(page, "deleteTask")).toEqual([]);

  await taskMenu(page, "Certificate renewal");
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(taskRow(page, "Certificate renewal")).toHaveCount(0);
  await expect(taskRow(page, "Router firmware")).toBeFocused();
  expect(await sent(page, "deleteTask")).toEqual([
    { type: "deleteTask", key: "agent:otto:cert-renewal" },
  ]);
  // A running task says its run is stopped first.
  await taskMenu(page, "Rotate the logs");
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await expect(page.getByRole("dialog")).toContainText("Its run is stopped first.");
});

test("F-424: archiving or deleting a bot's last task creates and selects a new Main; a bot's main session offers neither", async ({
  page,
}) => {
  // Juniper has no main session in the fixture: three tasks of its own.
  await openFixture(page, "scene=rail-write&bot=main", "light");
  for (const title of ["Heat pump", "Library e-book"]) {
    await taskMenu(page, title);
    await page.getByRole("menuitem", { name: "Archive" }).click();
    await expect(taskRow(page, title)).toHaveCount(0);
  }
  // One left: the bot's own menu archives it, and a new Main takes its place, selected.
  await expect(bot(page, "Juniper")).toHaveAccessibleName(/^Juniper, 1 task/);
  await bot(page, "Juniper").focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Archive task" }).click();
  await expect.poll(async () => (await sent(page, "newMainTask")).length).toBe(1);
  await expect(page.locator(".title-pill-task")).toHaveText("Main");
  await expect(bot(page, "Juniper")).toHaveAccessibleName(/^Juniper, 1 task/);
  await expect(bot(page, "Juniper")).toBeFocused();
  // Deleting that one makes another.
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Delete task…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect.poll(async () => (await sent(page, "newMainTask")).length).toBe(2);
  await expect(bot(page, "Juniper")).toHaveAccessibleName(/^Juniper, 1 task/);

  // Marlow's one task is its main session, which the gateway never archives or deletes.
  await bot(page, "Marlow").focus();
  await page.keyboard.press("Shift+F10");
  const items = await page.getByRole("menu").getByRole("menuitem").allTextContents();
  expect(items).toContain("Rename task…");
  // Its Rename dialog takes the 512 characters the gateway and the field in place take.
  await page.getByRole("menuitem", { name: "Rename task…" }).click();
  await expect(page.getByRole("dialog").getByRole("textbox", { name: "Name" })).toHaveAttribute(
    "maxlength",
    "512",
  );
  await page.keyboard.press("Escape");
  expect(items).not.toContain("Archive task");
  expect(items).not.toContain("Delete task…");
});

test("F-022: Mark as unread and Mark as read in a task's menu, sent to the host; opening a task reads it", async ({
  page,
}) => {
  await openFixture(page, `scene=rail-write&${OTTO}`, "light");
  await taskMenu(page, "Certificate renewal");
  await page.getByRole("menuitem", { name: "Mark as unread" }).click();
  await expect(taskRow(page, "Certificate renewal")).toHaveAccessibleName(
    "Certificate renewal warning, unread",
  );
  await expect(taskRow(page, "Certificate renewal")).toBeFocused();
  await taskMenu(page, "Certificate renewal");
  await page.getByRole("menuitem", { name: "Mark as read" }).click();
  await expect(taskRow(page, "Certificate renewal")).toHaveAccessibleName(
    "Certificate renewal warning",
  );
  expect(await sent(page, "markTask")).toEqual(
    expect.arrayContaining([
      { type: "markTask", key: "agent:otto:cert-renewal", unread: true, opened: false },
      { type: "markTask", key: "agent:otto:cert-renewal", unread: false, opened: false },
    ]),
  );
  // Opening an unread task reads it on the gateway too.
  await taskRow(page, "Weekly backup check").click();
  await expect
    .poll(async () =>
      (await sent(page, "markTask")).some(
        (command) =>
          "opened" in command && command.opened && command.key === "agent:otto:backup-check",
      ),
    )
    .toBe(true);
  await expect(taskRow(page, "Weekly backup check").locator(".unread-dot")).toHaveCount(0);
});

test("F-014 F-016: Pin and Move to change the gateway's arrangement; sections are small grey words; Remove from takes a bot out", async ({
  page,
}) => {
  await openFixture(page, `scene=rail-write&${OTTO}`, "light");
  await bot(page, "Juniper").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pin" }).click();
  await expect(page.getByRole("list", { name: "Pinned bots" }).locator(".pin")).toHaveCount(1);
  await expect(bot(page, "Juniper")).toBeFocused();
  expect(await sent(page, "changeSidebar")).toEqual([
    expect.objectContaining({ change: { op: "pin", botId: "main", pinned: true } }),
  ]);

  // Move to a new section: the dialog names it.
  await bot(page, "Quartermaster").focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Move to…" }).click();
  await expect(page.getByRole("menu", { name: /^Move Quartermaster .* to$/ })).toBeVisible();
  await page.getByRole("menuitem", { name: "New section…" }).click();
  const dialog = page.getByRole("dialog", { name: "Move to a new section" });
  await expect(dialog.getByRole("textbox", { name: "Section name" })).toBeFocused();
  await page.keyboard.type("Work");
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  const section = page.getByRole("list", { name: "Work" });
  await expect(section.getByTestId("bot")).toHaveCount(1);
  await expect(bot(page, "Quartermaster")).toBeFocused();
  const word = page.locator(".rail-section", { hasText: "Work" });
  expect(await word.evaluate((el) => getComputedStyle(el).fontSize)).toBe("13px");
  // Move another bot into it, then take it out again.
  await bot(page, "Pip").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to…" }).click();
  await page.getByRole("menuitem", { name: "Work" }).click();
  await expect(section.getByTestId("bot")).toHaveCount(2);
  await bot(page, "Pip").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to…" }).click();
  await page.getByRole("menuitem", { name: "Remove from Work" }).click();
  await expect(section.getByTestId("bot")).toHaveCount(1);
});

test("F-014: a task's Pin puts it first under its bot with a pin, and Unpin puts it back", async ({
  page,
}) => {
  await openFixture(page, `scene=rail-write&${OTTO}`, "light");
  await taskMenu(page, "Router firmware");
  await page.getByRole("menuitem", { name: "Pin" }).click();
  await expect(tasksOf(page, "Otto").first()).toHaveAccessibleName(/^Router firmware, pinned/);
  await expect(tasksOf(page, "Otto").first()).toBeFocused();
  await taskMenu(page, "Router firmware");
  await page.getByRole("menuitem", { name: "Unpin" }).click();
  await expect(tasksOf(page, "Otto").first()).not.toHaveAccessibleName(/^Router firmware/);
});

test("F-021 F-057: a waiting bot says what it waits for in the warning colour, its avatar shows the waiting badge, and a stopped or queued task its own mark", async ({
  page,
}) => {
  await openFixture(page, `scene=rail-waiting&${OTTO}`, "light");
  const marlow = bot(page, "Marlow");
  await expect(marlow.locator(".bot-preview")).toHaveText("Waiting for you: approve a command");
  await expect(marlow).toHaveAccessibleName(/^Marlow, waiting for you/);
  await expect(marlow.locator(".presence")).toHaveAttribute("data-state", "waiting");
  await expect(marlow.locator(".presence > .glyph")).toHaveAttribute("data-state", "waiting");
  const warn = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--warn)";
    document.body.append(probe);
    return getComputedStyle(probe).color;
  });
  expect(await marlow.locator(".bot-preview").evaluate((el) => getComputedStyle(el).color)).toBe(
    warn,
  );
  // Since it began waiting, not its latest activity.
  await expect(marlow.locator(".bot-time")).toHaveText("5:34 PM");
  await expect(bot(page, "Pip").locator(".bot-preview")).toHaveText("Waiting for you: a question");

  await bot(page, "Pip").focus();
  await page.keyboard.press("ArrowRight");
  const pip = tasksOf(page, "Pip");
  await expect(pip.filter({ hasText: "Reading list" })).toHaveAccessibleName(/, stopped$/);
  await expect(pip.filter({ hasText: "Reading list" }).locator(".glyph")).toHaveAttribute(
    "data-state",
    "stopped",
  );
  await expect(pip.filter({ hasText: "Birthday" })).toHaveAccessibleName(/, needs you$/);
  // A queued run: its own hollow ring and word; the bot's avatar counts it as idle.
  await bot(page, "Quartermaster").focus();
  await page.keyboard.press("ArrowRight");
  const errands = page
    .getByRole("list", { name: /^Quartermaster .*'s tasks$/ })
    .getByTestId("task")
    .filter({ hasText: "dry cleaning" });
  await expect(errands).toHaveAccessibleName(/, queued$/);
  await expect(errands.locator(".glyph")).toHaveAttribute("data-state", "queued");
  await expect(bot(page, "Quartermaster").locator(".presence")).toHaveAttribute(
    "data-state",
    "idle",
  );

  // Nothing pending: the state clears.
  await page.evaluate(() => {
    const fixture = (
      window as unknown as {
        clawtrateFixture: {
          setState: (change: (state: Record<string, unknown>) => Record<string, unknown>) => void;
        };
      }
    ).clawtrateFixture;
    fixture.setState((state) => {
      const tasksByBot = state.tasksByBot as Record<string, Array<Record<string, unknown>>>;
      return {
        ...state,
        tasksByBot: {
          ...tasksByBot,
          marlow: tasksByBot.marlow!.map((task) => ({
            ...task,
            status: "done",
            waitingFor: undefined,
          })),
        },
      };
    });
  });
  await expect(marlow.locator(".bot-preview")).not.toContainText("Waiting for you");
  await expect(marlow.locator(".presence")).toHaveAttribute("data-state", "idle");
});

test("on a read-only connection the rail offers none of the task actions", async ({ page }) => {
  for (const scene of ["main", "access-pinned", "rail-read"]) {
    await openFixture(page, `scene=${scene}&${OTTO}`, "light");
    await settle(page);
    await expect(
      page.locator(".rail-top").getByRole("button", { name: "New", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByTestId("new-task-row")).toHaveCount(0);
    await expect(page.getByTestId("archived-group")).toHaveCount(0);
    // A task's menu offers only Copy conversation ID.
    await taskMenu(page, "Certificate renewal");
    await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText(["Copy conversation ID"]);
    await page.keyboard.press("Escape");
    // Double-click and F2 open the task, not a field.
    await taskRow(page, "Certificate renewal").dblclick();
    await page.keyboard.press("F2");
    await expect(page.getByTestId("task-rename")).toHaveCount(0);
    // A bot's menu: no New task, no marks, no Move to, no task actions.
    await bot(page, "Marlow").focus();
    await page.keyboard.press("Shift+F10");
    const items = await page.getByRole("menu").getByRole("menuitem").allTextContents();
    for (const absent of [
      "New task",
      "Mark as unread",
      "Mark as read",
      "Move to…",
      "Rename task…",
      "Archive task",
      "Delete task…",
    ])
      expect(items).not.toContain(absent);
    await page.keyboard.press("Escape");
    // ⌥T does nothing.
    await page.keyboard.press("Alt+KeyT");
    expect(await sent(page, "newTask")).toEqual([]);
  }
  // On the gateway's arrangement, read-only: no Pin or Hide either.
  await bot(page, "Marlow").focus();
  await page.keyboard.press("Shift+F10");
  const items = await page.getByRole("menu").getByRole("menuitem").allTextContents();
  expect(items).not.toContain("Pin");
  expect(items).not.toContain("Hide from sidebar");
});

test("F-456: Re-pair sets Pairing pending; on approval the new authorization's scopes show and the state is Connected; on rejection the old one stays and the error shows", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO}`, "light");
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog.getByTestId("granted-scopes")).toHaveText("operator.read");
  await dialog.getByRole("button", { name: "Re-pair" }).click();
  await expect(dialog.getByTestId("gateway-state")).toHaveText("Pairing pending");
  await expect(dialog.getByTestId("repair-pending")).toContainText(
    "openclaw devices approve 7c41d09e-52b3-4e8a-9f10-3d6b2a7e9c41",
  );
  await expect(dialog.getByRole("button", { name: "Re-pair" })).toHaveCount(0);
  expect(await sent(page, "requestAccess")).toHaveLength(1);
  const setUpgrade = (upgrade: Record<string, unknown>, scopes?: string[]) =>
    page.evaluate(
      ({ upgrade, scopes }) => {
        const fixture = (
          window as unknown as {
            clawtrateFixture: {
              setState: (
                change: (state: { connection: Record<string, unknown> }) => unknown,
              ) => void;
            };
          }
        ).clawtrateFixture;
        fixture.setState((state) => ({
          ...state,
          connection: {
            ...state.connection,
            ...(scopes ? { scopes, canWrite: true, canAnswer: true, canApprove: true } : {}),
            upgrade: { ...(state.connection.upgrade as object), ...upgrade },
          },
        }));
      },
      { upgrade, scopes },
    );
  // Rejected: the old authorization stays, and the error shows.
  await setUpgrade({ status: "rejected" });
  await expect(dialog.getByTestId("gateway-state")).toHaveText("Connected");
  await expect(dialog.getByTestId("repair-problem")).toHaveText(
    "The gateway's owner rejected the new pairing. This device keeps its earlier access.",
  );
  await expect(dialog.getByTestId("granted-scopes")).toHaveText("operator.read");
  await expect(dialog.getByRole("button", { name: "Re-pair" })).toBeVisible();
  // Approved: the new authorization's scopes.
  await setUpgrade({ status: "approved" }, [
    "operator.read",
    "operator.write",
    "operator.approvals",
    "operator.questions",
  ]);
  await expect(dialog.getByTestId("gateway-state")).toHaveText("Connected");
  await expect(dialog.getByTestId("granted-scopes")).toContainText("operator.write");
  await expect(dialog.getByTestId("repair-problem")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Re-pair" })).toHaveCount(0);
});

test.describe("on a phone", () => {
  const PHONE = SIZES.find((size) => size.phone)!;
  test.use(contextFor(PHONE, "light"));

  test("F-054 F-025: every row with a menu shows a 44 px control for it, its menu has no shortcut hints, New task focuses the composer, and the list stays in view with a bot unfolded", async ({
    page,
  }) => {
    await openFixture(page, `scene=rail-write&${OTTO}`, "light");
    await page.getByRole("button", { name: "Back to bots" }).tap();
    // Otto is unfolded: three of its tasks, then the rest of the list, all in view.
    await expect(tasksOf(page, "Otto")).toHaveCount(3);
    await expect(page.getByRole("button", { name: "Show all 14" })).toBeVisible();
    const last = bot(page, "Quartermaster");
    const box = (await last.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(PHONE.height);
    // A visible control for every bot's and every task's menu, at least 44 px.
    for (const control of await page.locator(".row-more").all()) {
      const size = (await control.boundingBox())!;
      expect(size.width).toBeGreaterThanOrEqual(44);
      expect(size.height).toBeGreaterThanOrEqual(44);
      await expect(control).toBeVisible();
    }
    await expect(page.locator(".bot-group > .row-more")).toHaveCount(5);
    await expect(page.getByTestId("task-list").first().locator(".row-more")).toHaveCount(3);
    // A tap opens the task's menu, with no keyboard shortcuts in it.
    await page.getByRole("button", { name: "More for Weekly backup check" }).tap();
    const menu = page.getByRole("menu", { name: "Weekly backup check" });
    await expect(menu.getByRole("menuitem", { name: "Rename" })).toBeVisible();
    await expect(menu.locator(".menu-hint")).toBeHidden();
    await page.getByRole("button", { name: "More for Weekly backup check" }).tap();
    await expect(menu).toHaveCount(0);
    // And a bot's.
    await page.getByRole("button", { name: "More for Juniper" }).tap();
    await expect(
      page.getByRole("menu", { name: "Juniper" }).getByRole("menuitem", { name: "New task" }),
    ).toBeVisible();
    // New task from the row: the conversation shows with the composer focused.
    await page.getByRole("menuitem", { name: "New task" }).tap();
    await expect(page.locator(".composer-input")).toBeFocused();
    await expect(page.locator(".title-pill-task")).toHaveText("New task");
  });
});
