// Provider accounts per bot (docs/design/bots.md) against a real development
// gateway: this run's accounts instance, started with two scripted providers,
// labelled accounts and the scripted sign-ins (tools/dev-gateway/README.md).
// The interface runs on a preview host of its own and is driven as a person
// drives it; what landed is read from the gateway and from the scripted
// model's record of which account each request came from. Nothing here
// reaches a real provider.
//
// With CLAWTRATE_ACCOUNT_SHOTS=<folder outside the repository>, it also saves
// screenshots of what it checked there, at 1440 and 390 px in both themes.
import { expect, test, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCOUNT_CLIENTS, SIGNIN_CHOICES } from "../tools/dev-gateway/src/account-checks.ts";
import { openInstance, openOperator } from "../tools/dev-gateway/src/cli.ts";
import type { OperatorSession } from "../tools/dev-gateway/src/operator.ts";
import { devGateway, listInstances, startHost, stopChild } from "./global-setup.ts";

const INSTANCE = process.env.CLAWTRATE_E2E_ACCOUNTS!;
const STATIC = process.env.CLAWTRATE_E2E_STATIC!;
const SHOTS = process.env.CLAWTRATE_ACCOUNT_SHOTS ?? null;
/** A made-up key for the scripted API-key sign-in: its account is `acme:typed`. */
const TYPED_KEY = "clawtrate-dev-key.acme.typed";

test.describe.configure({ mode: "serial" });

let host: { child: ChildProcess; url: string; data: string } | null = null;
let page: Page;
let admin: OperatorSession;
let providerUrl: string;
/** Every frame the host sent the page, as text. */
const frames: string[] = [];

type Json = Record<string, unknown>;

async function config(): Promise<Json> {
  return ((await admin.request<{ config: Json }>("config.get", {})).config ?? {}) as Json;
}
const entry = (cfg: Json, bot: string) =>
  ((cfg.agents as Json | undefined)?.entries as Record<string, Json> | undefined)?.[bot];

/** A bot's view of a provider's accounts, refreshed, as the gateway reports it. */
async function view(bot: string, provider: string) {
  const status = await admin.request<{
    providers?: Array<{
      provider: string;
      profiles: Array<{ profileId: string; source: string; type: string }>;
      profileOrder?: string[];
    }>;
  }>("models.authStatus", { agentId: bot, refresh: true });
  return status.providers?.find((each) => each.provider === provider);
}

async function scripted<T = Json>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${providerUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (await response.json()) as T;
}

type Request = { seq: number; account: string | null; session: string | null; status: number };
async function requestsFor(session: string): Promise<Request[]> {
  const all = await scripted<{ requests: Request[] }>("/scripted/requests");
  return all.requests.filter((each) => each.session === session);
}

/** Screenshots of the page as it is, at 1440 and 390 in both themes, when asked for. */
async function shots(name: string): Promise<void> {
  if (!SHOTS) return;
  const size = page.viewportSize()!;
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: theme });
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(SHOTS, `${name}-${theme}-${width}.png`) });
    }
  }
  await page.setViewportSize(size);
  await page.emulateMedia({ colorScheme: "light" });
}

const dialog = (name: string | RegExp) => page.getByRole("dialog", { name });
const botRow = (name: string) =>
  page.getByTestId("bot-list").getByRole("button", { name: new RegExp(`^${name}\\b`) });

async function approve(): Promise<void> {
  await expect
    .poll(() => devGateway(INSTANCE, "approve"), { timeout: 30_000, intervals: [1000] })
    .toMatch(/^Approved /m);
}

/** One bridge command, over the host's own bridge socket, as another viewer of the page sends it. */
async function hostCommand(command: Json): Promise<void> {
  await page.evaluate(
    (command) =>
      new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(`ws://${location.host}/bridge`);
        socket.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as { type: string; id?: string };
          if (message.type === "hello")
            socket.send(JSON.stringify({ type: "command", id: "do", command }));
          else if (message.id === "do") {
            socket.close();
            resolve();
          }
        };
        socket.onerror = () => reject(new Error("bridge socket error"));
      }),
    command,
  );
}

/** Every file under the host's data folder, as text: what the host keeps on disk. */
function hostFiles(dir: string): string {
  let text = "";
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) text += hostFiles(path);
    else text += readFileSync(path, "latin1");
  }
  return text;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  expect(INSTANCE, "this run's accounts instance").toMatch(/^e2e-[0-9a-f]{8}-acct$/);
  const row = listInstances().find((each) => each.name === INSTANCE);
  expect(row?.gatewayRunning, "the accounts instance runs").toBe(true);
  providerUrl = `http://127.0.0.1:${row!.providerPort}`;
  admin = await openOperator(
    openInstance(INSTANCE),
    "Clawtrate accounts check",
    [...ACCOUNT_CLIENTS.admin.scopes],
    [...ACCOUNT_CLIENTS.admin.caps],
  );

  const data = mkdtempSync(join(tmpdir(), "clawtrate-accounts-"));
  const started = startHost(INSTANCE, STATIC, data);
  started.gated.release();
  host = { child: started.host, url: await started.url, data };

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  page = await context.newPage();
  // What the host sends the page, to show that a typed key never comes back.
  await page.routeWebSocket(/\/bridge$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      frames.push(String(message));
      ws.send(message);
    });
  });
  await page.goto(host.url);
  await page.getByRole("button", { name: "Use the development gateway" }).click();
  await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible({
    timeout: 20_000,
  });
  await approve();
  await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 30_000 });
  // The interactive tier first, through the bridge's requestAccess, as the composer's access
  // bar asks for it ("+" needs it); these bots have no task yet, so no composer to ask from.
  await hostCommand({ type: "requestAccess" });
  await approve();
  await expect(page.getByTestId("plus")).toBeVisible({ timeout: 30_000 });
});

test.afterAll(async () => {
  await admin?.close();
  if (host) {
    await stopChild(host.child);
    rmSync(host.data, { recursive: true, force: true });
  }
});

test("F-034 F-472: New bot asks for admin access, then creates a bot on the second of two accounts of one provider; its first run sends that account's credential", async () => {
  test.setTimeout(180_000);
  await page.keyboard.press("ControlOrMeta+n");
  const create = dialog("New bot");
  await expect(create).toBeVisible();
  await expect(create.getByRole("textbox", { name: "Name" })).toBeFocused();
  await create.getByRole("textbox", { name: "Name" }).fill("Second");
  await create.getByRole("radio", { name: "hex" }).click();
  await create.getByRole("radio", { name: "Sky" }).click();
  await create.getByRole("button", { name: "Next" }).click();
  const account = dialog("Account");
  await expect(account.getByText("Choose the account Second runs on.")).toBeVisible();
  // Below admin the rows are shown but cannot be chosen; the access bar takes Create's place.
  const bar = account.getByTestId("admin-bar");
  await expect(bar).toContainText("Admin access needed.");
  await expect(account.getByRole("button", { name: "Create" })).toHaveCount(0);
  await bar.getByRole("button", { name: "Request admin access" }).click();
  await expect(bar).toContainText("Waiting for approval.", { timeout: 15_000 });
  await approve();
  await expect(account.getByTestId("admin-bar")).toContainText("Admin access granted.", {
    timeout: 30_000,
  });
  // On admin the gateway sends labels: the two Acme accounts are told apart by them.
  const home = account.getByRole("radio", { name: /^Acme · Home/ });
  await expect(home).toBeVisible({ timeout: 15_000 });
  await expect(account.getByRole("radio", { name: /^Acme · Work/ })).toBeVisible();
  await expect(account.getByRole("radio", { name: /^Let the gateway choose/ })).toBeVisible();
  // Nothing is chosen at first: the default model names no account.
  await expect(account.getByRole("radio", { checked: true })).toHaveCount(0);
  await home.click();
  await expect(home).toHaveAttribute("aria-checked", "true");
  await shots("account-step");
  await account.getByRole("button", { name: "Create" }).click();
  await expect(account).toHaveCount(0, { timeout: 30_000 });

  // Stored on the account, with an empty fallback list, and the picture chosen.
  const created = entry(await config(), "second")!;
  expect(created.model).toEqual({ primary: "acme/dev-1@acme:home", fallbacks: [] });
  expect(String((created.identity as Json | undefined)?.avatar ?? "")).toMatch(
    /^data:image\/png;base64,/,
  );
  // The new bot is selected, on its first, empty task, with the composer ready.
  await expect(botRow("Second")).toHaveAttribute("aria-current", "true", { timeout: 20_000 });
  // Drawn with the picture chosen, which the gateway keeps with the bot.
  await expect(botRow("Second").locator("img")).toHaveAttribute("src", /^data:image\/png;base64,/);
  const field = page.getByTestId("composer-input");
  await expect(field).toBeVisible({ timeout: 20_000 });

  // Its first run reaches the scripted model with the second account's credential only.
  await field.fill("#text");
  await field.press("Enter");
  await expect
    .poll(async () => (await requestsFor("agent:second:main")).length, { timeout: 60_000 })
    .toBeGreaterThan(0);
  const requests = await requestsFor("agent:second:main");
  expect(requests[0]).toMatchObject({ account: "acme:home", status: 200 });
  expect(requests.every((each) => each.account === "acme:home")).toBe(true);
});

test("F-472: a bot created with Let the gateway choose is stored with no account and an empty fallback list", async () => {
  await page.keyboard.press("ControlOrMeta+n");
  const create = dialog("New bot");
  await create.getByRole("textbox", { name: "Name" }).fill("Chooser");
  await create.getByRole("button", { name: "Next" }).click();
  const account = dialog("Account");
  const choose = account.getByRole("radio", { name: /^Let the gateway choose/ });
  await expect(choose).toContainText("No fixed account.");
  await choose.click();
  await account.getByRole("button", { name: "Create" }).click();
  await expect(account).toHaveCount(0, { timeout: 30_000 });
  // The gateway's default model, without an account, and no fallbacks.
  expect(entry(await config(), "chooser")!.model).toEqual({
    primary: "scripted/dev-1",
    fallbacks: [],
  });
  // Its settings show the third state.
  await page.keyboard.press("ControlOrMeta+\\");
  await page.getByRole("tab", { name: "Settings" }).click();
  await page.getByRole("button", { name: /^Account: .*Gateway chooses\. Open\.$/ }).click();
  await expect(page.getByTestId("gateway-note")).toContainText("The gateway chooses.");
  await expect(page.getByTestId("retained-order")).toHaveCount(0);
  await shots("account-page-gateway");
  await page.getByRole("button", { name: "Back to settings" }).click();
  await page.keyboard.press("ControlOrMeta+\\");
});

/** Open Settings on Accounts, and the connect component. */
async function connectFromSettings() {
  await page.keyboard.press("ControlOrMeta+,");
  const settings = dialog("Settings");
  await settings.getByRole("button", { name: "Accounts", exact: true }).click();
  await expect(settings.getByRole("heading", { name: "Accounts", level: 3 })).toBeVisible();
  return settings;
}

test("F-474 F-476: a sign-in with a link and a code lands where the screen says it landed, and takes a label", async () => {
  const settings = await connectFromSettings();
  await shots("settings-accounts");
  await settings.getByRole("button", { name: "Connect an account" }).first().click();
  await settings.getByRole("button", { name: /^Acme \(scripted\)/ }).click();
  const code = settings.locator(".b-code code");
  await expect(code).toBeVisible({ timeout: 20_000 });
  await expect(settings.getByText(/The code works for 15 minutes\./)).toBeVisible();
  await expect(settings.getByTestId("open-page")).toHaveAttribute(
    "href",
    new RegExp(`^${providerUrl}/`),
  );
  await shots("signin-waiting");
  // The person approves on the provider's page, as account "travel".
  await scripted("/scripted/signin/answer", {
    userCode: await code.textContent(),
    outcome: "approve",
    account: "travel",
  });
  await expect(settings.getByRole("heading", { name: "Connected to Acme" })).toBeVisible({
    timeout: 30_000,
  });
  // The screen says every bot can use it: another bot's refreshed view lists it as inherited.
  await expect(settings.getByTestId("landed")).toHaveText(
    "Every bot can use it: the gateway shows it to other bots as shared.",
  );
  expect(
    (await view("pip", "acme"))?.profiles.find((p) => p.profileId === "acme:travel"),
  ).toMatchObject({ source: "inherited", type: "oauth" });
  // Another Acme account exists: a label is required, and one already used is refused.
  const label = settings.getByRole("textbox", { name: "Label" });
  const done = settings.getByRole("button", { name: "Done" });
  await expect(done).toBeDisabled();
  await label.fill("work");
  await expect(
    settings.getByText("Another Acme account is called Work. Choose a different label."),
  ).toBeVisible();
  await expect(done).toBeDisabled();
  await label.fill("Travel");
  await done.click();
  await expect(
    settings.getByRole("button", { name: /^Acme · Travel, Subscription, / }),
  ).toBeVisible({ timeout: 20_000 });
  expect(((await config()).auth as Json).profiles).toMatchObject({
    "acme:travel": { displayName: "Travel" },
  });
  await page.keyboard.press("Escape");
});

test("F-474: a browser sign-in with the code pasted back lands where the screen says it landed", async () => {
  const settings = await connectFromSettings();
  await settings.getByRole("button", { name: "Connect an account" }).first().click();
  await settings.getByRole("button", { name: /^Acme in the browser \(scripted\)/ }).click();
  const paste = settings.getByTestId("paste");
  await expect(paste).toBeVisible({ timeout: 20_000 });
  await expect(paste).toHaveAttribute("type", "password");
  const href = await settings.getByTestId("open-page").getAttribute("href");
  const state = new URL(href!).searchParams.get("state");
  const answered = await scripted<{ code: string }>("/scripted/signin/answer", {
    state,
    outcome: "approve",
    account: "browse",
  });
  await paste.fill(answered.code);
  await settings.getByRole("button", { name: "Continue" }).click();
  await expect(settings.getByRole("heading", { name: "Connected to Acme" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(settings.getByTestId("landed")).toContainText("Every bot can use it");
  expect(
    (await view("otto", "acme"))?.profiles.find((p) => p.profileId === "acme:browse")?.source,
  ).toBe("inherited");
  // The pasted code went to the gateway; the host sent none of it back.
  expect(frames.some((frame) => frame.includes(answered.code))).toBe(false);
  await settings.getByRole("textbox", { name: "Label" }).fill("Browse");
  await settings.getByRole("button", { name: "Done" }).click();
  await expect(settings.getByRole("button", { name: /^Acme · Browse/ })).toBeVisible({
    timeout: 20_000,
  });
  await page.keyboard.press("Escape");
});

test("F-474 F-475: an API key typed into the key path reaches the gateway once and is kept nowhere in Clawtrate", async () => {
  const settings = await connectFromSettings();
  await settings.getByRole("button", { name: "Connect an account" }).first().click();
  // Never open by default, never chosen: a disclosure under the sign-ins.
  const disclosure = settings.locator("details.b-disclosure");
  await expect(disclosure).not.toHaveAttribute("open", "");
  await disclosure.locator("summary").click();
  await settings.getByRole("combobox", { name: "Provider" }).selectOption("acme");
  // Acme's key goes through its own sign-in, which adds an account: nothing is replaced.
  await expect(settings.getByText(/This replaces the Acme key/)).toHaveCount(0);
  const field = settings.getByTestId("api-key");
  await field.fill(TYPED_KEY);
  await settings.getByRole("button", { name: "Save key" }).click();
  await expect(field).toHaveCount(0, { timeout: 30_000 });
  await expect(settings.getByRole("heading", { name: "Key saved" })).toBeVisible({
    timeout: 30_000,
  });
  expect(
    (await view("main", "acme"))?.profiles.find((p) => p.profileId === "acme:typed")?.type,
  ).toBe("api_key");
  // Kept nowhere: not in anything the host sent the page, not in the host's files, not on the page.
  expect(frames.some((frame) => frame.includes(TYPED_KEY))).toBe(false);
  expect(hostFiles(host!.data).includes(TYPED_KEY)).toBe(false);
  expect(await page.content()).not.toContain(TYPED_KEY);
  await settings.getByRole("textbox", { name: "Label" }).fill("Typed");
  await settings.getByRole("button", { name: "Done" }).click();
  await expect(settings.getByRole("button", { name: /^Acme · Typed, API key/ })).toBeVisible({
    timeout: 20_000,
  });
  await page.keyboard.press("Escape");
});

test("F-474: a sign-in that is refused says so, and what the gateway now has", async () => {
  const settings = await connectFromSettings();
  await settings.getByRole("button", { name: "Connect an account" }).first().click();
  await settings.getByRole("button", { name: /^Acme \(scripted\)/ }).click();
  const code = settings.locator(".b-code code");
  await expect(code).toBeVisible({ timeout: 20_000 });
  await scripted("/scripted/signin/answer", {
    userCode: await code.textContent(),
    outcome: "refuse",
    account: "nope",
  });
  await expect(settings.getByRole("heading", { name: "Couldn't connect" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(settings.getByText(/refused the sign-in/)).toBeVisible();
  await expect(settings.getByTestId("reread")).toHaveText(
    "Clawtrate checked the gateway's accounts: no new Acme account.",
    { timeout: 20_000 },
  );
  expect((await view("main", "acme"))?.profiles.some((p) => p.profileId === "acme:nope")).toBe(
    false,
  );
  await page.keyboard.press("Escape");
});

/** Second's Account page, in the Work pane's Settings tab. */
async function accountPage() {
  await botRow("Second").click();
  if (!(await page.getByTestId("work-panel").isVisible()))
    await page.keyboard.press("ControlOrMeta+\\");
  await page.getByRole("tab", { name: "Settings" }).click();
  const back = page.getByRole("button", { name: "Back to settings" });
  if (!(await back.isVisible())) await page.getByRole("button", { name: /^Account: / }).click();
  return page.getByTestId("bot-settings");
}

test("F-476 F-490: a bot locked with the tool's command shows as Locked, and one unlocked shows as Bound", async () => {
  test.setTimeout(120_000);
  const settings = await accountPage();
  await expect(settings.getByTestId("bound-note")).toContainText(
    "Bound. Second runs on Acme · Home.",
  );
  // The lock command, for the gateway's owner to run, in the instance's own form.
  const command = settings.getByTestId("command");
  await expect(command).toContainText(
    `openclaw --profile clawtrate-dev-${INSTANCE} models auth order set --provider acme --agent second acme:home`,
  );
  await expect(settings.getByTestId("evidence")).toContainText("Not locked. Checked at");
  await shots("account-page-bound");
  devGateway(INSTANCE, "lock", "--agent", "second", "--provider", "acme", "acme:home");
  await settings.getByRole("button", { name: "Check now" }).click();
  await expect(settings.getByTestId("locked-note")).toContainText(
    "Locked. Second's ordinary runs use Acme · Home only",
    { timeout: 20_000 },
  );
  await expect(settings.getByTestId("evidence")).toContainText("Checked with the gateway at");
  await shots("account-page-locked");
  await page.getByRole("button", { name: "Back to settings" }).click();
  await expect(page.getByTestId("account-word")).toHaveText("Locked");
  // Unlocked on the gateway: Bound again, and the page says the lock is gone.
  devGateway(INSTANCE, "unlock", "--agent", "second", "--provider", "acme");
  await page.getByRole("button", { name: /^Account: / }).click();
  await settings.getByRole("button", { name: "Check now" }).click();
  await expect(settings.getByTestId("bound-note")).toBeVisible({ timeout: 20_000 });
  await expect(
    settings.getByText(/The lock is gone: the gateway's order for Second changed/),
  ).toBeVisible();
});

test("F-473: changing a locked bot to another account of its provider shows the lock out of date", async () => {
  test.setTimeout(120_000);
  devGateway(INSTANCE, "lock", "--agent", "second", "--provider", "acme", "acme:home");
  const settings = await accountPage();
  await settings.getByRole("button", { name: "Check now" }).click();
  await expect(settings.getByTestId("locked-note")).toBeVisible({ timeout: 20_000 });
  await settings.getByRole("button", { name: "Change account" }).click();
  await settings.getByRole("radio", { name: /^Acme · Work/ }).click();
  await expect(
    settings.getByText(
      /Second is locked to Acme · Home\. After saving, Second runs on Acme · Work first/,
    ),
  ).toBeVisible();
  await settings.getByRole("button", { name: "Save" }).click();
  await expect(settings.getByTestId("stale-note")).toContainText(
    "The lock is out of date. Second runs on Acme · Work first, but the gateway's order for Second still lists only Acme · Home",
    { timeout: 20_000 },
  );
  await expect(settings.getByTestId("command").first()).toContainText(
    "order set --provider acme --agent second acme:work",
  );
  expect(entry(await config(), "second")!.model).toEqual({
    primary: "acme/dev-1@acme:work",
    fallbacks: [],
  });
  // The gateway still keeps the old one-account order: the next run goes to the new account first.
  expect((await view("second", "acme"))?.profileOrder).toEqual(["acme:home"]);
  devGateway(INSTANCE, "unlock", "--agent", "second", "--provider", "acme");
});

test("F-490: a bot whose model on the gateway lists fallbacks, or lost its account, is reported with the way to correct it", async () => {
  test.setTimeout(120_000);
  // Fallbacks written on the gateway, not by Clawtrate.
  await patchConfig({
    agents: { entries: { second: { model: { fallbacks: ["globex/dev-1"] } } } },
  });
  const settings = await accountPage();
  await settings.getByRole("button", { name: "Check now" }).click();
  const note = settings.getByTestId("fallbacks-note");
  await expect(note).toContainText(
    "Second can move to another model. Its model on the gateway lists fallbacks (globex/dev-1)",
    { timeout: 20_000 },
  );
  await note.getByRole("button", { name: "Remove fallbacks" }).click();
  await expect(note).toHaveCount(0, { timeout: 20_000 });
  expect(entry(await config(), "second")!.model).toEqual({
    primary: "acme/dev-1@acme:work",
    fallbacks: [],
  });
  // The account suffix removed on the gateway, where Clawtrate set one: reported as such,
  // not as "Gateway chooses".
  await patchConfig({ agents: { entries: { second: { model: { primary: "acme/dev-1" } } } } });
  await settings.getByRole("button", { name: "Check now" }).click();
  await expect(
    settings.getByText(
      "The gateway's model for Second has no account. It now uses the gateway's choice of Acme account.",
    ),
  ).toBeVisible({ timeout: 30_000 });
  await expect(settings.getByRole("button", { name: "Choose an account" })).toBeVisible();
  await patchConfig({
    agents: { entries: { second: { model: { primary: "acme/dev-1@acme:work" } } } },
  });
});

test("F-476 F-490: an order in the gateway's settings is named as that, never as a lock", async () => {
  test.setTimeout(120_000);
  // Second on Acme · Work; the gateway's owner orders Acme's accounts in the settings: that one alone.
  // A patch that changes nothing makes no new revision to wait for, so it is made only when needed.
  const onWork = { primary: "acme/dev-1@acme:work", fallbacks: [] };
  if (JSON.stringify(entry(await config(), "second")?.model) !== JSON.stringify(onWork))
    await patchConfig({ agents: { entries: { second: { model: onWork } } } });
  await patchConfig({ auth: { order: { acme: ["acme:work"] } } });
  try {
    const status = await view("second", "acme");
    expect(status?.profileOrder).toEqual(["acme:work"]);
    const settings = await accountPage();
    await settings.getByRole("button", { name: "Check now" }).click();
    await expect(settings.getByTestId("evidence")).toContainText(
      "The gateway's settings order Acme's accounts as Acme · Work. That order is the gateway's, not Second's own, so it is not a lock.",
      { timeout: 20_000 },
    );
    await expect(settings.getByTestId("locked-note")).toHaveCount(0);
    await expect(settings.getByTestId("bound-note")).toBeVisible();
    await page.getByRole("button", { name: "Back to settings" }).click();
    await expect(page.getByTestId("account-word")).toHaveText("Bound");
  } finally {
    await patchConfig({ auth: { order: { acme: null } } }, ["auth.order.acme"]);
  }
});

test("F-476 F-490: an account only another bot keeps is no account for this bot, and never a lock", async () => {
  test.setTimeout(120_000);
  // acme:studio is in Otto's own store: Otto's view lists it, Second's does not.
  expect((await view("otto", "acme"))?.profiles.some((p) => p.profileId === "acme:studio")).toBe(
    true,
  );
  expect((await view("second", "acme"))?.profiles.some((p) => p.profileId === "acme:studio")).toBe(
    false,
  );
  await patchConfig({
    agents: { entries: { second: { model: { primary: "acme/dev-1@acme:studio" } } } },
  });
  try {
    const settings = await accountPage();
    await settings.getByRole("button", { name: "Check now" }).click();
    await expect(
      settings.getByText(
        "No account. Second's account, Acme · Studio, is kept by Otto only, so Second can't use it.",
        { exact: false },
      ),
    ).toBeVisible({ timeout: 20_000 });
    await expect(settings.getByTestId("locked-note")).toHaveCount(0);
    await page.getByRole("button", { name: "Back to settings" }).click();
    await expect(page.getByTestId("account-word")).toHaveText("No account");
  } finally {
    await patchConfig({
      agents: { entries: { second: { model: { primary: "acme/dev-1@acme:work" } } } },
    });
  }
});

/** A merge patch of the gateway's config, as the gateway's owner might make it, applied. */
async function patchConfig(patch: Json, replacePaths?: string[]): Promise<void> {
  const before = await admin.request<{ hash: string; configRevisionHash?: string }>(
    "config.get",
    {},
  );
  await admin.request("config.patch", {
    raw: JSON.stringify(patch),
    baseHash: before.hash,
    ...(replacePaths ? { replacePaths } : {}),
  });
  await expect
    .poll(
      async () => {
        const now = await admin.request<{
          configRevisionHash?: string;
          appliedConfigHash?: string;
        }>("config.get", {});
        return (
          now.configRevisionHash !== before.configRevisionHash &&
          now.appliedConfigHash === now.configRevisionHash
        );
      },
      { timeout: 20_000 },
    )
    .toBe(true);
}

/** An Acme account of its own, through the scripted API-key sign-in, for main (shared). */
async function signInKey(name: string): Promise<string> {
  const sessionId = `accounts-e2e-${name}`;
  await admin.request("models.authLogin", {
    sessionId,
    authChoice: SIGNIN_CHOICES.apiKey,
    agentId: "main",
  });
  let answer: { stepId: string; value: unknown } | undefined;
  for (let i = 0; i < 20; i += 1) {
    const next = await admin.request<{
      done: boolean;
      status?: string;
      step?: { id: string; type: string; sensitive?: boolean };
    }>("wizard.next", { sessionId, ...(answer ? { answer } : {}) });
    if (next.done) {
      expect(next.status).toBe("done");
      return `acme:${name}`;
    }
    const step = next.step!;
    answer =
      step.type === "text" && step.sensitive
        ? { stepId: step.id, value: `clawtrate-dev-key.acme.${name}` }
        : { stepId: step.id, value: true };
  }
  throw new Error(`the sign-in of acme:${name} did not finish`);
}

test("F-476 F-490: a locked bot whose account answers 401, 402 or 429 fails the run, and no request reaches another account", async () => {
  // A rate-limited account is retried ten times with growing pauses: minutes on a loaded machine.
  test.setTimeout(1_200_000);
  const created = await admin.request<{ agentId: string }>("agents.create", {
    name: "Fence",
    model: "acme/dev-1@acme:work",
  });
  const bot = created.agentId;
  for (const status of [401, 402, 429] as const) {
    // A fresh account for each failure: the gateway rests an account after one.
    const account = await signInKey(`fence${status}`);
    await patchConfig({
      agents: {
        entries: { [bot]: { model: { primary: `acme/dev-1@${account}`, fallbacks: [] } } },
      },
    });
    devGateway(INSTANCE, "lock", "--agent", bot, "--provider", "acme", account);
    expect((await view(bot, "acme"))?.profileOrder).toEqual([account]);
    await scripted("/scripted/accounts/fail", { account, status });
    const session = `agent:${bot}:fence-${status}`;
    const sent = await admin.send(session, "#text");
    const end = await admin.terminal(String(sent.runId), 300_000);
    expect(end.state, `the run on ${account} answering ${status}`).toBe("error");
    const requests = await requestsFor(session);
    expect(requests.length).toBeGreaterThan(0);
    // Every request went to the locked account; none reached another Acme account.
    expect(requests.map((each) => each.account)).toEqual(requests.map(() => account));
    await scripted("/scripted/accounts/clear", { account });
  }
  // The interface says what the gateway's order shows, once it reads the bots again: a bot
  // another client made appears with the next read of the gateway's bots.
  await hostCommand({ type: "retry" });
  await expect(botRow("Fence")).toBeVisible({ timeout: 30_000 });
  await botRow("Fence").click();
  if (!(await page.getByTestId("work-panel").isVisible()))
    await page.keyboard.press("ControlOrMeta+\\");
  await page.getByRole("tab", { name: "Settings" }).click();
  await page.getByRole("button", { name: /^Account: / }).click();
  // Its account has no label: it is named by its provider and its id on the gateway.
  await expect(page.getByTestId("locked-note")).toContainText(
    "Locked. Fence's ordinary runs use Acme acme:fence429 only",
    { timeout: 30_000 },
  );
  devGateway(INSTANCE, "unlock", "--agent", bot, "--provider", "acme");
});
