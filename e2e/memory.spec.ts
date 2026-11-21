import { expect, test, type Page } from "@playwright/test";
import { openInstance, openOperator } from "../tools/dev-gateway/src/cli.ts";
import { messageText, type ChatMessage } from "../tools/dev-gateway/src/scripts.ts";
import type { OperatorSession } from "../tools/dev-gateway/src/operator.ts";
import { devGateway } from "./global-setup.ts";

const INSTANCE = process.env.CLAWTRATE_DEV_INSTANCE!;
const agentId = "otto";
const name = "MEMORY.md";
const original = "Keep a weekly release log.";
const revised = "Update the release log on Friday.";
const added = "Review the release checklist on Monday.";
let gateway: OperatorSession;

async function root() {
  return (
    await gateway.request<{ file: { hash?: string; content?: string } }>("agents.files.get", {
      agentId,
      name,
    })
  ).file;
}

async function approve() {
  await expect
    .poll(() => devGateway(INSTANCE, "approve"), { timeout: 30_000 })
    .toMatch(/^Approved /m);
}

async function openMemory(page: Page) {
  await page.goto(process.env.CLAWTRATE_E2E_URL!);
  const connect = page.getByRole("button", { name: "Use the development gateway" });
  const bots = page.getByTestId("bot");
  await expect
    .poll(async () => (await connect.isVisible()) || (await bots.count()) >= 4, { timeout: 20_000 })
    .toBe(true);
  if (await connect.isVisible()) {
    await connect.click();
    await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible();
    await approve();
  }
  await page
    .getByTestId("bot-list")
    .getByRole("button", { name: /^Otto\b/ })
    .click();
  if (!(await page.getByTestId("work-panel").isVisible()))
    await page.keyboard.press("ControlOrMeta+\\");
  await page.getByRole("tab", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  const memory = page.getByTestId("memory-page");
  await expect(memory.getByRole("heading", { name: "Root memory" })).toBeVisible();
  return memory;
}

// One session for every ask: a session per ask would fill Otto's rail and push
// the seeded tasks behind "Show all" for the specs that run after this one.
let memoryKey: string;

async function askMemory() {
  const run = await gateway.send(memoryKey, "What do you remember about me?");
  expect((await gateway.terminal(String(run.runId))).state).toBe("final");
  // Only the newest reply: the session's history keeps what earlier turns answered.
  const history = await gateway.request<{ messages: ChatMessage[] }>("chat.history", {
    sessionKey: memoryKey,
    limit: 6,
  });
  const reply = history.messages.findLast((message) => message.role === "assistant");
  return reply ? messageText(reply) : null;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  gateway = await openOperator(
    openInstance(INSTANCE),
    "Memory checks",
    ["operator.admin", "operator.read", "operator.write"],
    [],
  );
  const { hash } = await root();
  await gateway.request("agents.files.set", {
    agentId,
    name,
    content: original,
    ...(hash ? { expectedHash: hash } : { expectedMissing: true }),
  });
  memoryKey = (await gateway.request<{ key: string }>("sessions.create", { agentId })).key;
});

test.afterAll(async () => gateway?.close());

test("F-211: reads a bot's stored memory, scope, and revision without requesting admin", async ({
  page,
}) => {
  const memory = await openMemory(page);
  const item = memory.getByRole("listitem").filter({ hasText: original });
  await expect(item).toContainText("MEMORY.md · Otto only");
  await expect(item).toContainText(`Revision ${(await root()).hash?.slice(0, 7)}, changed `);
  await expect(item).toContainText("Who saved this revision isn't recorded.");
  await expect(item).toContainText("Search for this revision is unconfirmed.");
  await expect(memory.getByRole("button", { name: "Request admin access" })).toBeVisible();
  await expect(memory.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
});

test("F-212: edits a root item after an explicit admin request", async ({ page }) => {
  const memory = await openMemory(page);
  const access = memory.getByRole("button", { name: "Request admin access" });
  await access.click();
  await expect(memory.getByText("Waiting for approval.")).toBeVisible();
  await approve();
  await expect(page.getByTestId("admin-bar")).toContainText("Admin access granted.", {
    timeout: 30_000,
  });
  const item = memory.getByRole("listitem").filter({ hasText: original });
  await item.getByRole("button", { name: "Edit", exact: true }).click();
  await memory.getByLabel("Memory text").fill(revised);
  await memory.getByRole("button", { name: "Save memory" }).click();
  await expect(memory.getByText(revised, { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await root()).content, { timeout: 30_000 }).toBe(revised);
  expect(await askMemory()).toBe(revised);
});

test("F-377: adds root memory; note writes wait on the plugin's recorded review", async ({
  page,
}) => {
  const memory = await openMemory(page);
  await memory.getByRole("button", { name: "Add memory" }).click();
  await memory.getByLabel("Memory text").fill(added);
  await memory.getByRole("button", { name: "Save memory" }).click();
  await expect(memory.getByRole("listitem").filter({ hasText: added })).toBeVisible({
    timeout: 15_000,
  });
  expect((await root()).content).toContain(added);
  expect(await askMemory()).toContain(added);

  await memory.getByRole("button", { name: "Add memory" }).click();
  const saveIn = memory.getByLabel("Save in");
  await expect(saveIn).toBeVisible();
  await expect(saveIn.locator("option")).toHaveCount(2);
  await expect(
    memory.getByText(
      "Notes are read-only here until the memory plugin's security review is recorded.",
    ),
  ).toBeVisible();
  await memory.getByRole("button", { name: "Cancel" }).click();
});

test("F-377: About you stays a destination for an empty file while note writes are held", async ({
  page,
}) => {
  const user = await gateway.request<{ file: { hash?: string } }>("agents.files.get", {
    agentId,
    name: "USER.md",
  });
  await gateway.request("agents.files.set", {
    agentId,
    name: "USER.md",
    content: "",
    ...(user.file.hash ? { expectedHash: user.file.hash } : { expectedMissing: true }),
  });
  const memory = await openMemory(page);
  await expect(memory.getByText("No text stored in USER.md.")).toBeVisible();
  await memory.getByRole("button", { name: "Add memory" }).click();
  await memory.getByLabel("Save in").selectOption("USER.md");
  await memory.getByLabel("Memory text").fill("Prefers plain summaries on Friday.");
  await memory.getByRole("button", { name: "Save memory" }).click();
  await expect(
    memory.getByRole("listitem").filter({ hasText: "Prefers plain summaries on Friday." }),
  ).toBeVisible({ timeout: 15_000 });
  expect(
    (
      await gateway.request<{ file: { content: string } }>("agents.files.get", {
        agentId,
        name: "USER.md",
      })
    ).file.content,
  ).toContain("Prefers plain summaries on Friday.");
});

test("F-375: confirms deletion and removes an item from the bot's next new private task", async ({
  page,
}) => {
  const memory = await openMemory(page);
  const item = memory.getByRole("listitem").filter({ hasText: added });
  await item.getByRole("button", { name: "Delete", exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: "Delete this memory?" });
  await expect(confirm).toContainText(added);
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(item).toBeVisible();
  await item.getByRole("button", { name: "Delete", exact: true }).click();
  await confirm.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(item).toHaveCount(0);
  expect(await askMemory()).toBe(revised);
});

test("F-216: a bot replies to the ordinary memory question with the memory it received", async ({
  page,
}) => {
  await openMemory(page);
  await page.getByRole("button", { name: "Hide work panel" }).click();
  const plus = page.locator(".rail-top").getByRole("button", { name: "New", exact: true });
  await plus.click();
  await page.getByRole("menuitem", { name: "New task for Otto" }).click();
  const composer = page.getByTestId("composer-input");
  await expect(composer).toBeFocused({ timeout: 20_000 });
  await expect(page.locator(".title-pill-task")).toHaveText("New task");
  await composer.fill("What do you remember about me?");
  await composer.press("Enter");
  await expect(page.getByTestId("memory-page")).toBeHidden();
  await expect(
    page
      .getByTestId("message")
      .filter({ hasText: revised })
      .locator(".bubble:not([data-streaming])"),
  ).toHaveText(revised, { timeout: 30_000 });
});

test("F-212: a concurrent write keeps the gateway's revision and leaves the draft available", async ({
  page,
}) => {
  const memory = await openMemory(page);
  const item = memory.getByRole("listitem").filter({ hasText: revised });
  await item.getByRole("button", { name: "Edit", exact: true }).click();
  const { hash } = await root();
  const newer = "Another editor saved this revision.";
  await gateway.request("agents.files.set", { agentId, name, content: newer, expectedHash: hash });
  const editor = memory.getByLabel("Memory text");
  await editor.fill("My unsaved draft.");
  await memory.getByRole("button", { name: "Save memory" }).click();
  await expect(memory.getByRole("alert")).toBeVisible();
  await expect(editor).toHaveValue("My unsaved draft.");
  expect((await root()).content).toBe(newer);
});

test("F-211: a root file that fails its first load stands alone beside itself", async ({
  page,
}) => {
  // The gateway refuses nothing here: the read's own size limit fails this file alone.
  const { hash } = await root();
  await gateway.request("agents.files.set", {
    agentId,
    name,
    content: "x".repeat(262_145),
    expectedHash: hash,
  });
  const memory = await openMemory(page);
  const alert = memory.getByRole("alert");
  await expect(alert).toContainText("MEMORY.md", { timeout: 15_000 });
  await expect(alert).toContainText("too large");
  // The other root file and the notes list stayed usable.
  await expect(
    memory.getByRole("listitem").filter({ hasText: "Prefers plain summaries" }),
  ).toBeVisible();
  await expect(memory.getByRole("heading", { name: "Notes" })).toBeVisible();
  await expect(memory.getByText("No notes.")).toBeVisible();
  await expect(memory.getByRole("button", { name: "Add memory" })).toBeVisible();
  const { hash: restoredHash } = await root();
  await gateway.request("agents.files.set", {
    agentId,
    name,
    content: revised,
    expectedHash: restoredHash,
  });
});
