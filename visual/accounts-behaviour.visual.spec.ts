// How the account screens behave (docs/design/bots.md, sections 2 to 11 and
// 19): the "+" menu and ⌘N, focus in and out of the dialogs, the radio groups'
// one tab stop and arrows, the selects, Escape that belongs to the innermost
// thing, the access bar for admin, and what a read-only connection shows.
import type { ClawtrateBridge, ClawtrateState } from "../packages/core/src/index.ts";
import { expect, test, type Page } from "@playwright/test";
import { contextFor, NOW, openFixture, OTTO_DISK, settle, SIZES } from "./fixture.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;
const PHONE = SIZES.find((size) => size.phone)!;
const ADMIN = `scene=main&${OTTO_DISK}&access=admin`;

test.use(contextFor(WIDE, "light"));

const newBot = (page: Page) => page.getByTestId("new-bot");
const sent = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { clawtrateFixture: { sent: Array<Record<string, unknown>> } }
    ).clawtrateFixture.sent.map((each) => ({ ...each })),
  );

type Frames = { releaseFrames: () => void };
/** Animation frames asked for from now wait until `releaseFrames`: a slow frame, made certain. */
const holdFrames = (page: Page) =>
  page.evaluate(() => {
    const real = window.requestAnimationFrame.bind(window);
    const held: FrameRequestCallback[] = [];
    window.requestAnimationFrame = (callback) => (held.push(callback), 0);
    (window as unknown as Frames).releaseFrames = () => {
      window.requestAnimationFrame = real;
      for (const callback of held.splice(0)) real(callback);
    };
  });
/** Runs the held callbacks and waits until they have run. */
const releaseFrames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((done) => {
        (window as unknown as Frames).releaseFrames();
        requestAnimationFrame(() => done());
      }),
  );

test("F-034: the one + menu offers New task and New bot with ⌘N; New bot opens on its name, and Escape gives focus back to +", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  const plus = page.getByTestId("plus");
  await expect(plus).toHaveCount(1);
  await plus.click();
  const menu = page.getByRole("menu", { name: "New" });
  await expect(menu.getByRole("menuitem")).toHaveText(["New task for Otto⌥T", "New bot⌘N"]);
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: /^New bot/ })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(newBot(page)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Name" })).toBeFocused();
  // The live picture follows the shape and colour chosen.
  await page.getByRole("radio", { name: "gem" }).click();
  await page.getByRole("radio", { name: "Blue" }).click();
  await expect(page.locator(".b-preview svg g").first()).toHaveAttribute("fill", "#5b8dff");
  await page.keyboard.press("Escape");
  await expect(newBot(page)).toHaveCount(0);
  await expect(plus).toBeFocused();
  // What was entered is kept: the dialog opens again with it, from ⌘N.
  await page.keyboard.press("ControlOrMeta+n");
  await expect(page.getByRole("radio", { name: "gem" })).toHaveAttribute("aria-checked", "true");
});

test("F-034: shapes and colours are radio groups of one tab stop; arrows move and choose; Enter in the name is Next", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("textbox", { name: "Name" }).fill("Viral");
  await page.keyboard.press("Tab");
  const drop = page.getByRole("radio", { name: "drop" });
  await expect(drop).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: "gem" })).toBeFocused();
  await expect(page.getByRole("radio", { name: "gem" })).toHaveAttribute("aria-checked", "true");
  // Frames asked for from Home on run only after Tab: a focus move the key left for a later
  // frame lands after Tab and takes focus back from the colours.
  await holdFrames(page);
  await page.keyboard.press("Home");
  await expect(page.getByRole("radio", { name: "pebble" })).toHaveAttribute("aria-checked", "true");
  // Read while the frames are held: Home itself moved focus to the shape it chose.
  const homeFocusedPebble = await page
    .getByRole("radio", { name: "pebble" })
    .evaluate((radio) => radio === document.activeElement);
  // One tab stop: Tab leaves the group for the colours.
  await page.keyboard.press("Tab");
  await releaseFrames(page);
  await expect(page.getByRole("radio", { name: "Pink" })).toBeFocused();
  expect(homeFocusedPebble).toBe(true);
  await page.getByRole("textbox", { name: "Name" }).press("Enter");
  await expect(page.getByRole("heading", { name: "Account", level: 2 })).toBeVisible();
  await expect(page.getByText("Choose the account Viral runs on.")).toBeVisible();
  // Back keeps everything.
  await page.getByRole("button", { name: "Back to the picture" }).click();
  await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue("Viral");
  await expect(page.getByRole("radio", { name: "pebble" })).toHaveAttribute("aria-checked", "true");
});

test("F-472: the Account step: subscriptions first, the gateway's choice last; Create waits for a choice; arrows choose", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("button", { name: "Next" }).click();
  const group = page.getByRole("radiogroup", { name: "Accounts" });
  await expect(group.locator(".b-group")).toHaveText(["Subscriptions", "API keys"]);
  const radios = group.getByRole("radio");
  await expect(radios.first()).toHaveAccessibleName(/^OpenAI · Work, Subscription, Marlow, Otto$/);
  await expect(radios.last()).toHaveAccessibleName(
    /^Let the gateway choose\. No fixed account\. The gateway picks one of OpenAI's accounts for each run, as its account order allows, with its default model, gpt-5\.5\.$/,
  );
  // An account kept by one bot is not offered to a bot that does not exist yet.
  await expect(group.getByRole("radio", { name: /Pip's key/ })).toHaveCount(0);
  // Nothing chosen: Create waits, and says why.
  await expect(page.getByTestId("create")).toBeDisabled();
  await expect(page.getByText("Choose an account, or let the gateway choose.")).toBeVisible();
  // One tab stop, the first row when none is chosen; arrows move and choose.
  await radios.first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(radios.nth(1)).toBeFocused();
  await expect(radios.nth(1)).toHaveAttribute("aria-checked", "true");
  await expect(group.locator('[role="radio"][tabindex="0"]')).toHaveCount(1);
  await page.keyboard.press("End");
  await expect(radios.last()).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("create")).toBeEnabled();
  // The model and effort follow, for the default model's provider.
  await expect(page.getByTestId("model-select")).toHaveAccessibleName("Model: gpt-5.5");
  await expect(page.getByTestId("effort-select")).toHaveAccessibleName("Effort: Medium");
});

test("F-472: when the gateway's default model names an account, that account is chosen at first, and the step says why", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&defacct=1`, "light");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("radio", { name: /^OpenAI · Work/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(
    page.getByText("Chosen because the gateway's default model names it."),
  ).toBeVisible();
});

test("F-472: Create writes the bot on the account chosen, with its model and effort, then opens it", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("textbox", { name: "Name" }).fill("Viral");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("radio", { name: /^xAI · Personal/ }).click();
  await expect(page.getByTestId("model-select")).toHaveAccessibleName("Model: grok-4.7");
  // A model with no levels offers no effort.
  await page.getByTestId("model-select").click();
  await page.getByRole("menuitemradio", { name: "grok-build-0.1" }).click();
  await expect(page.getByTestId("effort-select")).toHaveAccessibleName("Effort: Not offered");
  await expect(page.getByTestId("effort-select")).toBeDisabled();
  await page.getByTestId("create").click();
  await expect(newBot(page)).toHaveCount(0);
  const create = (await sent(page)).find((each) => each.type === "createBot");
  expect(create).toMatchObject({
    name: "Viral",
    account: "xai:personal",
    provider: "xai",
    model: "grok-build-0.1",
    effort: null,
  });
  expect(String(create!.avatar)).toMatch(/^data:image\/png;base64,/);
  await expect(
    page.getByTestId("bot-list").getByRole("button", { name: /^Viral\b/ }),
  ).toBeVisible();
});

for (const first of ["pairing", "interactive"] as const) {
  test(`F-157: late ${first} answers leave a newer admin grant in place`, async ({ page }) => {
    await page.clock.install({ time: NOW });
    await openFixture(
      page,
      `scene=main&${OTTO_DISK}&access=read&admin=grant&pairing=grant`,
      "light",
    );
    await page.clock.pauseAt(new Date(NOW.getTime() + 60_000));
    await page.evaluate(async (first) => {
      const { clawtrateFixture: bridge } = window as unknown as {
        clawtrateFixture: ClawtrateBridge & { hold(): void; release(): void };
      };
      await bridge.send(
        first === "pairing"
          ? { type: "requestAccess", tier: "pairing" }
          : { type: "requestAccess" },
      );
      bridge.hold();
      await bridge.send({ type: "requestAccess", tier: "admin" });
      bridge.release();
    }, first);
    const connection = () =>
      page.evaluate(
        () =>
          (window as unknown as { clawtrateFixture: ClawtrateBridge }).clawtrateFixture.getState()
            .connection,
      );
    const granted = await connection();
    expect(granted.scopes).toContain("operator.admin");
    await page.clock.runFor(300);
    expect((await connection()).upgrade.status).toBe("approved");
    await page.clock.runFor(1_000);
    expect((await connection()).scopes).toEqual(granted.scopes);
  });
}

test("F-472: an approval released before the request turns pending stays approved", async ({
  page,
}) => {
  await page.clock.install({ time: NOW });
  await openFixture(page, `scene=main&${OTTO_DISK}&access=write&admin=grant`, "light");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("textbox", { name: "Name" }).fill("Viral");
  await page.getByRole("button", { name: "Next" }).click();
  const bar = page.getByTestId("admin-bar");
  // Timers stop here, so the pending step cannot fire before the release, however slow the page.
  await page.clock.pauseAt(new Date(NOW.getTime() + 60_000));
  await page.evaluate(() =>
    (window as unknown as { clawtrateFixture: { hold(): void } }).clawtrateFixture.hold(),
  );
  await bar.getByRole("button", { name: "Request admin access" }).click();
  // Released before the fixture's 400 ms pending step: the approval comes first.
  await page.evaluate(() =>
    (window as unknown as { clawtrateFixture: { release(): void } }).clawtrateFixture.release(),
  );
  await expect(bar).toContainText("Admin access granted.");
  // The pending step's timer then fires, and must not take the approval back.
  await page.clock.runFor(1_500);
  const status = await page.evaluate(() => {
    let value = "";
    (
      window as unknown as {
        clawtrateFixture: { setState(f: (s: ClawtrateState) => ClawtrateState): void };
      }
    ).clawtrateFixture.setState((state) => {
      value = state.connection.upgrade.status;
      return state;
    });
    return value;
  });
  expect(status).toBe("approved");
  await expect(page.getByText("Choose the account Viral runs on.")).toBeVisible();
});

test("F-472: below admin the rows show but cannot be chosen, and the access bar takes Create's place; what was chosen survives the request", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}&access=write&admin=grant`, "light");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("textbox", { name: "Name" }).fill("Viral");
  await page.getByRole("button", { name: "Next" }).click();
  const work = page.getByRole("radio", { name: /^OpenAI openai:work/ });
  await expect(work).toHaveAttribute("aria-disabled", "true");
  await work.click({ force: true });
  await expect(work).toHaveAttribute("aria-checked", "false");
  const bar = page.getByTestId("admin-bar");
  await expect(bar).toContainText(
    "Admin access needed. Creating a bot changes the gateway's settings, which needs admin access. What you chose stays here while you ask.",
  );
  // The owner's approval is held until the check has seen the pending state: that state lasts
  // only until the approval, so a fixed delay is never long enough on a loaded machine.
  await page.evaluate(() =>
    (window as unknown as { clawtrateFixture: { hold(): void } }).clawtrateFixture.hold(),
  );
  await bar.getByRole("button", { name: "Request admin access" }).click();
  await expect(bar).toContainText("Waiting for approval.");
  await expect(bar.getByTestId("command")).toContainText("openclaw devices approve");
  expect(
    (await sent(page)).some((each) => each.type === "requestAccess" && each.tier === "admin"),
  ).toBe(true);
  await page.evaluate(() =>
    (window as unknown as { clawtrateFixture: { release(): void } }).clawtrateFixture.release(),
  );
  await expect(page.getByTestId("admin-bar")).toContainText("Admin access granted.");
  // Granted: labels arrive, the name is kept, and the rows can be chosen.
  await expect(page.getByText("Choose the account Viral runs on.")).toBeVisible();
  await page.getByRole("radio", { name: /^OpenAI · Work/ }).click();
  await expect(page.getByRole("radio", { name: /^OpenAI · Work/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("F-474: a sign-in's stages: the code with its link; Back cancels; the API key path is folded and never chosen", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Connect another account" }).click();
  // Subscriptions first; OpenRouter, billed per token, after.
  await expect(newBot(page).locator(".b-group")).toHaveText(["Subscriptions", "Billed per token"]);
  const disclosure = newBot(page).locator("details.b-disclosure");
  await expect(disclosure).not.toHaveAttribute("open", "");
  await expect(page.getByTestId("api-key")).toBeHidden();
  await newBot(page)
    .getByRole("button", { name: /^xAI · / })
    .click();
  await expect(page.getByRole("heading", { name: "Sign in to xAI", level: 2 })).toBeVisible();
  await expect(page.getByRole("group", { name: "Code QK4F 7PZD" })).toBeVisible();
  await expect(page.getByTestId("open-page")).toHaveAttribute("target", "_blank");
  await expect(page.getByText("Waiting for xAI. The code works for 15 minutes.")).toBeVisible();
  // Back returns to the methods and cancels the sign-in in progress.
  await page.getByRole("button", { name: "Back to sign-in methods" }).click();
  await expect(page.getByRole("heading", { name: "Connect an account", level: 2 })).toBeVisible();
  expect((await sent(page)).map((each) => each.type)).toEqual(
    expect.arrayContaining(["startSignIn", "cancelSignIn"]),
  );
});

test("F-474: a pasted code is a password field, cleared as it is sent", async ({ page }) => {
  await openFixture(page, ADMIN, "light");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Connect another account" }).click();
  await newBot(page)
    .getByRole("button", { name: /^ChatGPT in the browser/ })
    .click();
  const paste = page.getByTestId("paste");
  await expect(paste).toHaveAttribute("type", "password");
  await expect(paste).toHaveAttribute("autocomplete", "off");
  await paste.fill("made-up-code-0001");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Connected to OpenAI" })).toBeVisible();
  expect(await page.content()).not.toContain("made-up-code-0001");
  // The label step: another OpenAI account exists, so a label is required.
  await expect(page.getByRole("textbox", { name: "Label" })).toBeFocused();
  await expect(page.getByRole("button", { name: "Done" })).toBeDisabled();
  await page.getByRole("textbox", { name: "Label" }).fill("Studio");
  await page.getByRole("button", { name: "Done" }).click();
  // Back on the Account step, the new account chosen.
  await expect(page.getByRole("radio", { name: /^OpenAI · Studio/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("F-490: the Account page: the lock command, Check now, and Back to the row that opened it", async ({
  page,
}) => {
  await openFixture(
    page,
    `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=admin&lock=bound`,
    "light",
  );
  const row = page.getByRole("button", { name: /^Account: OpenAI · Work, Bound\. Open\.$/ });
  await row.click();
  await expect(page.getByRole("heading", { name: "Account", level: 3 })).toBeFocused();
  await expect(page.getByTestId("bound-note")).toContainText(
    "Bound. Otto runs on OpenAI · Work. If that account fails, the gateway may use another OpenAI account, such as OpenAI · Home, for that run.",
  );
  await expect(page.getByTestId("command")).toHaveText(
    "openclaw models auth order set --provider openai --agent otto openai:work",
  );
  // Copying the command: the page watches for the lock, every 4 seconds.
  await page.getByRole("button", { name: "Copy lock command" }).click();
  await expect(page.getByText("Checking the gateway for the lock, again in 4s")).toBeVisible();
  await page.getByRole("button", { name: "Check now" }).click();
  expect((await sent(page)).filter((each) => each.type === "checkLock").length).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Back to settings" }).click();
  await expect(row).toBeFocused();
});

test("F-490: what a lock doesn't cover is folded; the read that failed keeps the last confirmation, with its time", async ({
  page,
}) => {
  await openFixture(
    page,
    `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=admin&lock=failed`,
    "light",
  );
  await page
    .getByRole("button", { name: /^Account: OpenAI · Work, Locked, as of 5:28 PM\. Open\.$/ })
    .click();
  await expect(page.getByTestId("locked-note")).toContainText("Locked, as of 5:28 PM.");
  await expect(page.getByTestId("evidence-failed")).toContainText(
    "Couldn't read the gateway's order for Otto. Last confirmed locked at 5:28 PM.",
  );
  const ways = page.locator("details.b-disclosure", { hasText: "What a lock doesn't cover" });
  await expect(ways).not.toHaveAttribute("open", "");
  await ways.locator("summary").click();
  await expect(ways.locator("li")).toHaveCount(8);
});

test("F-473: changing a locked bot's account: the note before saving, then the lock out of date with both commands", async ({
  page,
}) => {
  await openFixture(
    page,
    `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=admin&lock=locked`,
    "light",
  );
  await page.getByRole("button", { name: /^Account: / }).click();
  await page.getByRole("button", { name: "Change account" }).click();
  await expect(page.getByRole("heading", { name: "Change account", level: 3 })).toBeFocused();
  const save = page.getByRole("button", { name: "Save" });
  await expect(save).toBeDisabled();
  await page.getByRole("radio", { name: /^OpenAI · Home/ }).click();
  await expect(
    page.getByText(
      /Otto is locked to OpenAI · Work\. After saving, Otto runs on OpenAI · Home first/,
    ),
  ).toBeVisible();
  await save.click();
  await expect(page.getByTestId("stale-note")).toContainText(
    "The lock is out of date. Otto runs on OpenAI · Home first, but the gateway's order for Otto still lists only OpenAI · Work",
  );
  await expect(page.getByTestId("command").first()).toHaveText(
    "openclaw models auth order set --provider openai --agent otto openai:home",
  );
  await expect(page.getByRole("heading", { name: "Account", level: 3 })).toBeFocused();
});

test("F-478: changing to a provider that lacks the bot's model asks for a model before saving, and the effort follows it", async ({
  page,
}) => {
  await openFixture(
    page,
    `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=admin&lock=bound`,
    "light",
  );
  await page.getByRole("button", { name: /^Account: / }).click();
  await page.getByRole("button", { name: "Change account" }).click();
  await page.getByRole("radio", { name: /^xAI · Personal/ }).click();
  await expect(
    page.getByText("xAI doesn't offer gpt-5.5. Choose one of its models."),
  ).toBeVisible();
  const save = page.getByRole("button", { name: "Save" });
  await expect(save).toBeDisabled();
  // Down opens the select's menu; Escape closes the menu alone.
  await page.getByTestId("model-select").focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menu", { name: "Model" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu", { name: "Model" })).toHaveCount(0);
  await expect(page.getByTestId("model-select")).toBeFocused();
  await expect(page.getByTestId("work-panel")).toBeVisible();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitemradio", { name: "grok-4.7" }).click();
  await expect(page.getByTestId("effort-select")).toHaveAccessibleName("Effort: Low");
  await expect(save).toBeEnabled();
  await save.click();
  const change = (await sent(page)).find((each) => each.type === "changeBotAccount");
  expect(change).toMatchObject({
    botId: "otto",
    account: "xai:personal",
    provider: "xai",
    model: "grok-4.7",
    effort: "low",
  });
});

test("F-472: Let the gateway choose for an existing bot, and the one-account order still stored, with its clear command", async ({
  page,
}) => {
  await openFixture(
    page,
    `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=admin&lock=retained`,
    "light",
  );
  await page.getByRole("button", { name: /^Account: OpenAI, Gateway chooses\. Open\.$/ }).click();
  await expect(page.getByTestId("gateway-note")).toContainText("The gateway chooses.");
  await expect(page.getByTestId("retained-order")).toContainText(
    "The gateway still has an order for Otto that names only OpenAI · Work",
  );
  await expect(page.getByTestId("retained-order").getByTestId("command")).toHaveText(
    "openclaw models auth order clear --provider openai --agent otto",
  );
  await page.getByRole("button", { name: "Bind to an account" }).click();
  await expect(page.getByRole("radio", { name: /^Let the gateway choose/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("F-476: below admin there are no labels: accounts are told apart by their ids; nothing that would do nothing is offered", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}&access=read`, "light");
  // On the read tier there is no "+".
  await expect(page.getByTestId("plus")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+n");
  await expect(newBot(page)).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Accounts", exact: true }).click();
  await expect(settings.getByRole("button", { name: /^OpenAI openai:work, / })).toBeVisible();
  await expect(settings.getByRole("button", { name: /^OpenAI openai:home, / })).toBeVisible();
  await expect(settings.getByRole("button", { name: "Connect an account" })).toHaveCount(0);
  await expect(settings.getByTestId("admin-bar")).toContainText("Read-only.");
  await settings.getByRole("button", { name: /^OpenAI openai:work, / }).click();
  await expect(settings.getByRole("button", { name: "Disconnect…" })).toHaveCount(0);
  await expect(settings.getByRole("button", { name: "Edit label" })).toHaveCount(0);
  // Escape closes Settings, and ⌘, opens it again on the section last shown.
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+,");
  await expect(settings.getByRole("heading", { name: "Accounts", level: 3 })).toBeVisible();
});

test("F-490: a read-only connection shows a bot's settings with every value, and changes nothing", async ({
  page,
}) => {
  await openFixture(
    page,
    `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=read&lock=locked`,
    "light",
  );
  await expect(page.getByTestId("model-select")).toBeDisabled();
  await page
    .getByRole("button", { name: /^Account: OpenAI openai:work, Locked\. Open\.$/ })
    .click();
  await expect(page.getByTestId("locked-note")).toBeVisible();
  await expect(page.getByRole("button", { name: "Change account" })).toHaveCount(0);
  await expect(page.getByTestId("admin-bar")).toContainText(
    "Changing Otto's settings needs admin access.",
  );
});

test("F-476: Disconnect asks first, with focus on Cancel; Escape closes the confirmation alone", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Accounts", exact: true }).click();
  await settings.getByRole("button", { name: /^OpenAI · Work, / }).click();
  await expect(settings.getByTestId("account-facts")).toContainText("Used byMarlow, Otto (locked)");
  await settings.getByRole("button", { name: "Disconnect…" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Disconnect OpenAI · Work?" });
  await expect(confirm).toHaveAccessibleDescription(
    "Marlow and Otto use it. They show No account until you choose another, and Clawtrate doesn't start them until then. Your gateway removes the sign-in.",
  );
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  await expect(settings).toBeVisible();
  // A label already used by the provider is refused, and the field says why.
  await settings.getByRole("button", { name: "Edit label" }).click();
  await settings.getByRole("textbox", { name: "Label" }).fill("home");
  await settings.getByRole("button", { name: "Save" }).click();
  await expect(settings.getByRole("textbox", { name: "Label" })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(settings.locator("#b-relabel-error")).toHaveText(
    "Another OpenAI account is called Home. Choose a different label.",
  );
});

test.describe("phone", () => {
  test.use(contextFor(PHONE, "light"));
  test("F-034: on a phone New bot is a sheet over the screen, and Settings opens on its list", async ({
    page,
  }) => {
    await openFixture(page, ADMIN, "light");
    await page.keyboard.press("ControlOrMeta+n");
    const sheet = newBot(page);
    await expect(sheet).toBeVisible();
    const box = (await sheet.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(388);
    expect(box.height).toBeGreaterThan(780);
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+,");
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings.getByRole("navigation", { name: "Settings" })).toBeVisible();
    await settings.getByRole("button", { name: "Accounts", exact: true }).click();
    await expect(settings.getByRole("navigation", { name: "Settings" })).toBeHidden();
    await settings.getByRole("button", { name: "Back to settings" }).click();
    await expect(settings.getByRole("navigation", { name: "Settings" })).toBeVisible();
    await settle(page);
  });
});

/** Change the fixture's state, as the engine would. */
const change = (page: Page, run: string) =>
  page.evaluate((body) => {
    const fixture = (
      window as unknown as {
        clawtrateFixture: { setState: (change: (state: unknown) => unknown) => void };
      }
    ).clawtrateFixture;
    fixture.setState(new Function("state", body) as (state: unknown) => unknown);
  }, run);

const SETTINGS_TAB = `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=admin`;

test("F-490: an order from the gateway's settings is named as that, never as a lock", async ({
  page,
}) => {
  await openFixture(page, `${SETTINGS_TAB}&lock=configured`, "light");
  await page.getByRole("button", { name: /^Account: OpenAI · Work, Bound\. Open\.$/ }).click();
  await expect(page.getByTestId("bound-note")).toBeVisible();
  await expect(page.getByTestId("locked-note")).toHaveCount(0);
  await expect(page.getByTestId("evidence")).toContainText(
    "The gateway's settings order OpenAI's accounts as OpenAI · Work. That order is the gateway's, not Otto's own, so it is not a lock.",
  );
  await expect(
    page.getByText(/The gateway's settings also set an order for OpenAI accounts\./),
  ).toBeVisible();
});

test("F-490: an answer that account status is unavailable is stated as that, with the last confirmation and its time", async ({
  page,
}) => {
  await openFixture(page, `${SETTINGS_TAB}&lock=unavailable`, "light");
  await page
    .getByRole("button", { name: /^Account: OpenAI · Work, Locked, as of 5:28 PM\. Open\.$/ })
    .click();
  await expect(page.getByTestId("locked-note")).toContainText("Locked, as of 5:28 PM.");
  await expect(page.getByTestId("evidence-unavailable")).toContainText(
    "The gateway says its account status is unavailable (PREPARED_MODEL_AUTH_UNAVAILABLE), so Clawtrate can't read Otto's order now. Last confirmed locked at 5:28 PM.",
  );
  await expect(page.getByTestId("evidence-failed")).toHaveCount(0);
});

test("F-490: evidence ages: an open page that goes offline, or reconnects, says when it last checked", async ({
  page,
}) => {
  await openFixture(page, `${SETTINGS_TAB}&lock=locked`, "light");
  await page.getByRole("button", { name: /^Account: / }).click();
  await expect(page.getByTestId("evidence")).toContainText("Checked with the gateway at 5:40 PM.");
  await page.clock.setFixedTime(new Date("2026-11-16T17:47:00-05:00"));
  await change(
    page,
    `return { ...state, connection: { ...state.connection, status: "reconnecting" } };`,
  );
  await expect(page.getByTestId("evidence")).toHaveText(
    "Last checked at 5:40 PM. Clawtrate checks again when it reconnects.",
  );
  await expect(page.getByTestId("locked-note")).toContainText("Locked, as of 5:40 PM.");
  // Connected again: the page does not keep evidence from before this connection; it reads the order again.
  await change(
    page,
    `return { ...state, connection: { ...state.connection, status: "connected", connectedAt: Date.now() } };`,
  );
  await expect(page.getByTestId("evidence")).toHaveText("Checked with the gateway at 5:47 PM.");
  expect(
    (await sent(page)).filter((each) => each.type === "checkLock").length,
  ).toBeGreaterThanOrEqual(2);
});

test("F-490 F-476: an account only another bot keeps is no account for this bot, whatever its order", async ({
  page,
}) => {
  await openFixture(page, `${SETTINGS_TAB}&lock=elsewhere`, "light");
  await page.getByRole("button", { name: /^Account: .*No account\. Open\.$/ }).click();
  await expect(
    page.getByText(
      "No account. Otto's account, Anthropic · Pip's key, is kept by Pip only, so Otto can't use it.",
      { exact: false },
    ),
  ).toBeVisible();
  await expect(page.getByTestId("locked-note")).toHaveCount(0);
});

test("F-472: Create and Save take only a choice the list shows now: a failed read, or an account gone, disables them", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("radio", { name: /^OpenAI · Home/ }).click();
  await expect(page.getByTestId("create")).toBeEnabled();
  await change(
    page,
    `return { ...state, accounts: { ...state.accounts, status: "error", error: "timed out" } };`,
  );
  await expect(page.getByText("Couldn't load the gateway's accounts.")).toBeVisible();
  await expect(page.getByRole("radio", { name: /^OpenAI · Home/ })).toHaveCount(0);
  await expect(page.getByTestId("create")).toBeDisabled();
  await expect(page.getByTestId("choice-gone")).toBeVisible();
  // Read again, and the account is gone from the gateway.
  await change(
    page,
    `return { ...state, accounts: { ...state.accounts, status: "ready", error: null, accounts: state.accounts.accounts.filter((a) => a.id !== "openai:home") } };`,
  );
  await expect(page.getByTestId("create")).toBeDisabled();
  await expect(page.getByTestId("choice-gone")).toHaveText(
    "The account chosen is no longer on the gateway. Choose another, or let the gateway choose.",
  );
  await page.getByRole("radio", { name: /^Let the gateway choose/ }).click();
  await expect(page.getByTestId("create")).toBeEnabled();
  await page.keyboard.press("Escape");
  // Change account: the same rule for Save.
  await page.keyboard.press("ControlOrMeta+\\");
  await page.getByRole("tab", { name: "Settings" }).click();
  await page.getByRole("button", { name: /^Account: / }).click();
  await page.getByRole("button", { name: "Change account" }).click();
  await page.getByRole("radio", { name: /^xAI · Personal/ }).click();
  await page.getByTestId("model-select").click();
  await page.getByRole("menuitemradio", { name: "grok-4.7" }).click();
  await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();
  await change(
    page,
    `return { ...state, accounts: { ...state.accounts, status: "error", error: "timed out" } };`,
  );
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
});

/** New bot, connecting an account, on the sign-in methods. */
async function connectFromNewBot(page: Page) {
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Connect another account" }).click();
}

test("F-474: a sign-in whose read afterwards failed says so, and Check again reads it", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&signin=unverified`, "light");
  await connectFromNewBot(page);
  await newBot(page)
    .getByRole("button", { name: /^xAI · / })
    .click();
  await expect(page.getByRole("heading", { name: "Signed in, not confirmed" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Connected to/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.getByRole("heading", { name: "Connected to xAI" })).toBeVisible();
  expect((await sent(page)).some((each) => each.type === "recheckSignIn")).toBe(true);
});

test("F-474: a cancel the gateway did not confirm stays on screen and says so; Back does not let it go", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&signin=cancel-unknown`, "light");
  await connectFromNewBot(page);
  await newBot(page)
    .getByRole("button", { name: /^xAI · / })
    .click();
  await expect(page.getByTestId("cancel-unknown")).toContainText(
    "Clawtrate couldn't tell whether the gateway cancelled the sign-in",
  );
  await page.getByRole("button", { name: "Back to sign-in methods" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to xAI", level: 2 })).toBeVisible();
  await expect(page.getByText("Sign-in cancelled")).toHaveCount(0);
});

test("F-474: where the gateway keeps sign-ins per bot, a bot connects an account from its own Change account page", async ({
  page,
}) => {
  await openFixture(page, `${SETTINGS_TAB}&lock=bound&kept=1&signin=connected`, "light");
  await page.getByRole("button", { name: /^Account: / }).click();
  await page.getByRole("button", { name: "Change account" }).click();
  const connect = page.getByRole("button", { name: /^Connect an account/ });
  await expect(connect).toContainText("A sign-in here is kept for Otto.");
  await connect.click();
  await expect(page.getByTestId("kept-note")).toContainText(
    "This gateway keeps this sign-in for Otto only.",
  );
  await page.getByRole("button", { name: /^xAI · / }).click();
  await expect(page.getByRole("heading", { name: "Connected to xAI" })).toBeVisible();
  await expect(page.getByTestId("landed")).toHaveText(
    "Saved for Otto only. Other bots can't use it.",
  );
  const start = (await sent(page)).find((each) => each.type === "startSignIn");
  expect(start).toMatchObject({ botId: "otto" });
  await page.getByRole("textbox", { name: "Label" }).fill("Side");
  await page.getByRole("button", { name: "Done" }).click();
  // Back on the choice, with the new account chosen, kept by Otto.
  await expect(page.getByRole("heading", { name: "Change account", level: 3 })).toBeVisible();
  await expect(
    page.getByRole("radio", { name: /^xAI · Side, Subscription, Only Otto can use it/ }),
  ).toHaveAttribute("aria-checked", "true");
});

test("F-034: a bot written whose first task did not land is said to exist, unfinished; Finish completes it by its id and opens it", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&create=partial`, "light");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("textbox", { name: "Name" }).fill("Viral");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("radio", { name: /^OpenAI · Home/ }).click();
  await page.getByTestId("create").click();
  const note = page.getByTestId("create-partial");
  await expect(note).toContainText(
    "Viral exists, and isn't finished. Viral was created, but its first task was not made",
  );
  // It is not offered as something to create again.
  await expect(page.getByTestId("create")).toBeDisabled();
  await note.getByRole("button", { name: "Finish Viral" }).click();
  await expect(newBot(page)).toHaveCount(0);
  const types = (await sent(page)).map((each) => each.type);
  expect(types.filter((type) => type === "createBot")).toHaveLength(1);
  expect(types).toContain("finishBot");
  await expect(
    page.getByTestId("bot-list").getByRole("button", { name: /^Viral\b/ }),
  ).toBeVisible();
});

test("F-476: on admin two unlabelled accounts of one provider read differently, by their ids, in New bot and Settings", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&labels=none`, "light");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("button", { name: "Next" }).click();
  const group = page.getByRole("radiogroup", { name: "Accounts" });
  const work = group.getByRole("radio", { name: /^OpenAI openai:work, / });
  const home = group.getByRole("radio", { name: /^OpenAI openai:home, / });
  await expect(work).toContainText("openai:work");
  await expect(home).toContainText("openai:home");
  await expect(page.getByTestId("unlabelled-hint")).toContainText("named by its id");
  const titles = await group.locator(".b-choice-title").allInnerTexts();
  expect(new Set(titles).size).toBe(titles.length);
  await page.keyboard.press("Escape");
  // Settings → Accounts: the rows read differently too, and each offers a label.
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Accounts", exact: true }).click();
  const rows = await settings.locator(".b-choice-title").allInnerTexts();
  expect(new Set(rows).size).toBe(rows.length);
  await settings.getByRole("button", { name: "Add a label to OpenAI openai:home" }).click();
  const field = settings.getByRole("textbox", { name: "Label" });
  await expect(field).toBeFocused();
  await field.fill("Home");
  await field.press("Enter");
  await expect(settings.getByRole("heading", { name: "OpenAI · Home", level: 3 })).toBeVisible();
});

test("F-476: two accounts that share a label, whatever its case, are told apart by their ids", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&labels=same`, "light");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("button", { name: "Next" }).click();
  const group = page.getByRole("radiogroup", { name: "Accounts" });
  await expect(group.getByRole("radio", { name: /^OpenAI · Work openai:work, / })).toBeVisible();
  await expect(group.getByRole("radio", { name: /^OpenAI · work openai:home, / })).toBeVisible();
  // xAI's label is its own: no id.
  await expect(group.getByRole("radio", { name: /^xAI · Personal, / })).toBeVisible();
});

test("F-474: a key the gateway refused is tried again where a key is typed, for the same provider", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&keyfails=1`, "light");
  await connectFromNewBot(page);
  await newBot(page).getByText("Use an API key instead").click();
  await newBot(page).getByRole("combobox", { name: "Provider" }).selectOption("xai");
  await page.getByTestId("api-key").fill("made-up-key-for-a-check");
  await newBot(page).getByRole("button", { name: "Save key" }).click();
  await expect(newBot(page).getByRole("heading", { name: "Couldn't connect" })).toBeVisible();
  await newBot(page).getByRole("button", { name: "Try again" }).click();
  // Back where a key is typed: the disclosure open, xAI chosen, the field empty and focused.
  await expect(newBot(page).locator("details.b-disclosure")).toHaveAttribute("open", "");
  await expect(newBot(page).getByRole("combobox", { name: "Provider" })).toHaveValue("xai");
  await expect(page.getByTestId("api-key")).toBeFocused();
  await expect(page.getByTestId("api-key")).toHaveValue("");
  expect((await sent(page)).filter((each) => each.type === "startSignIn")).toEqual([]);
});

test.describe("phone, a key", () => {
  test.use(contextFor(PHONE, "light"));
  test("F-474: on a phone, opening the API key path brings its fields into view", async ({
    page,
  }) => {
    await openFixture(page, ADMIN, "light");
    await connectFromNewBot(page);
    await newBot(page).getByText("Use an API key instead").click();
    await expect(page.getByTestId("api-key")).toBeInViewport();
  });
});

test("F-476: a label step closed before Done comes back, in New bot and in Settings → Accounts, until Done", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&signin=connected`, "light");
  await connectFromNewBot(page);
  await newBot(page)
    .getByRole("button", { name: /^xAI · / })
    .click();
  await expect(page.getByRole("heading", { name: "Connected to xAI" })).toBeVisible();
  // Closed before Done: New bot opens on the label step again.
  await page.keyboard.press("Escape");
  await expect(newBot(page)).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+n");
  await expect(page.getByRole("heading", { name: "Connected to xAI" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Label" })).toBeVisible();
  await page.keyboard.press("Escape");
  // Settings → Accounts opens on it too.
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Accounts", exact: true }).click();
  await expect(settings.getByRole("heading", { name: "Connected to xAI" })).toBeVisible();
  await settings.getByRole("textbox", { name: "Label" }).fill("Travel");
  await settings.getByRole("button", { name: "Done" }).click();
  await expect(settings.getByRole("heading", { name: "Accounts", level: 3 })).toBeVisible();
  // Done lets it go: Settings opens on the list.
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+,");
  await expect(settings.getByRole("heading", { name: "Accounts", level: 3 })).toBeVisible();
});

test("F-490: every place that names a lock words it from its evidence: Used by, Change account and the sign-in's result", async ({
  page,
}) => {
  await openFixture(page, `${SETTINGS_TAB}&lock=failed`, "light");
  // Change account: a lock last confirmed before a failed read is spoken of in the past, with its time.
  await page.getByRole("button", { name: /^Account: / }).click();
  await page.getByRole("button", { name: "Change account" }).click();
  await page.getByRole("radio", { name: /^OpenAI · Home/ }).click();
  await expect(page.getByTestId("locked-change-note")).toContainText(
    /^Otto was locked to OpenAI · Work when Clawtrate last checked, at \d+:\d\d [AP]M\. If it still is, after saving/,
  );
  await expect(page.getByText(/Otto is locked to/)).toHaveCount(0);
  // Settings → Accounts: Used by gives the same lock with its time.
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Accounts", exact: true }).click();
  await settings.getByRole("button", { name: /^OpenAI · Work,/ }).click();
  await expect(settings.getByTestId("account-facts")).toContainText(
    /Otto \(locked as of \d+:\d\d [AP]M\)/,
  );
  await expect(settings.getByTestId("account-facts")).not.toContainText("Otto (locked)");
});

test("F-474 F-490: a sign-in's result says a lock widened only from a read that shows it, and says when it couldn't check", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&signin=connected`, "light");
  await connectFromNewBot(page);
  await newBot(page)
    .getByRole("button", { name: /^xAI · / })
    .click();
  await expect(page.getByRole("heading", { name: "Connected to xAI" })).toBeVisible();
  await change(
    page,
    `return { ...state, accounts: { ...state.accounts, signIn: { ...state.accounts.signIn, result: { ...state.accounts.signIn.result, locks: [{ botId: "otto", account: "openai:work", outcome: "unchecked" }] } } } };`,
  );
  await expect(page.getByTestId("lock-unchecked")).toHaveText(
    "Clawtrate couldn't check Otto's lock after this sign-in, so it can't say whether the sign-in changed it. Otto's Account page checks it again.",
  );
  await expect(page.getByText(/added the new account to Otto's lock/)).toHaveCount(0);
});

test("F-474: a key saved directly is called saved only when the read after it shows the account; Check again reads it", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&keyread=fail`, "light");
  await connectFromNewBot(page);
  await newBot(page).getByText("Use an API key instead").click();
  await newBot(page).getByRole("combobox", { name: "Provider" }).selectOption("openai");
  await page.getByTestId("api-key").fill("made-up-key-for-a-check");
  await newBot(page).getByRole("button", { name: "Save key" }).click();
  await expect(
    newBot(page).getByRole("heading", { name: "Key sent, not confirmed" }),
  ).toBeVisible();
  await expect(newBot(page).getByRole("heading", { name: "Key saved" })).toHaveCount(0);
  await expect(newBot(page).getByRole("textbox", { name: "Label" })).toHaveCount(0);
  await newBot(page).getByRole("button", { name: "Check again" }).click();
  await newBot(page).getByRole("button", { name: "Continue" }).click();
  await expect(newBot(page).getByRole("heading", { name: "Key saved" })).toBeVisible();
  await expect(newBot(page).getByRole("textbox", { name: "Label" })).toBeVisible();
});

test("F-474: when two new accounts appear during a sign-in, the person chooses which is theirs before it is labelled", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&signin=several`, "light");
  await connectFromNewBot(page);
  await newBot(page)
    .getByRole("button", { name: /^xAI · / })
    .click();
  const several = newBot(page).getByTestId("several");
  await expect(several.getByRole("button")).toHaveCount(2);
  await expect(newBot(page).getByRole("textbox", { name: "Label" })).toHaveCount(0);
  await expect(
    newBot(page).getByText(/2 new xAI accounts appeared while this sign-in ran/),
  ).toBeVisible();
  await several
    .getByRole("button", { name: /^xAI xai:second: this is the account I signed in to$/ })
    .click();
  await expect(newBot(page).getByRole("heading", { name: "Connected to xAI" })).toBeVisible();
  await expect(
    newBot(page).getByText("You have another xAI account", { exact: false }),
  ).toBeVisible();
  expect((await sent(page)).filter((each) => each.type === "chooseSignInAccount")).toEqual([
    { type: "chooseSignInAccount", profileId: "xai:second" },
  ]);
});

/** Gives OpenAI's two accounts these labels. */
const labelsOf = (page: Page, home: string, work: string) =>
  change(
    page,
    `return { ...state, accounts: { ...state.accounts, accounts: state.accounts.accounts.map((a) => a.id === "openai:home" ? { ...a, label: ${JSON.stringify(home)} } : a.id === "openai:work" ? { ...a, label: ${JSON.stringify(work)} } : a) } };`,
  );

/** Each OpenAI id in the Account step: its own line, wholly inside its title. */
const idsShown = (page: Page) =>
  newBot(page)
    .locator('[data-value^="openai:"] .b-choice-id')
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const id = node.getBoundingClientRect();
        const title = node.closest(".b-choice-title")!.getBoundingClientRect();
        return {
          text: node.textContent,
          inside: id.left >= title.left - 0.5 && id.right <= title.right + 0.5,
        };
      }),
    );

for (const size of [WIDE, PHONE]) {
  test.describe(`names at ${size.name}`, () => {
    test.use(contextFor(size, "light"));

    test("F-476: labels that read the same, in spaces or case, show each account's id", async ({
      page,
    }) => {
      await openFixture(page, ADMIN, "light");
      await labelsOf(page, "My  plan", "my plan");
      await page.keyboard.press("ControlOrMeta+n");
      await page.getByRole("button", { name: "Next" }).click();
      expect(await idsShown(page)).toEqual([
        { text: "openai:work", inside: true },
        { text: "openai:home", inside: true },
      ]);
      // Settings → Accounts reads them the same way.
      await page.keyboard.press("Escape");
      await page.keyboard.press("ControlOrMeta+,");
      const settings = page.getByRole("dialog", { name: "Settings" });
      if (await settings.getByRole("button", { name: "Accounts", exact: true }).isVisible())
        await settings.getByRole("button", { name: "Accounts", exact: true }).click();
      await expect(
        settings.getByRole("button", { name: /^OpenAI · My plan openai:home, / }),
      ).toBeVisible();
      await expect(
        settings.getByRole("button", { name: /^OpenAI · my plan openai:work, / }),
      ).toBeVisible();
    });

    test("F-476: a long shared label gives way; each id stays whole on its own line", async ({
      page,
    }) => {
      await openFixture(page, ADMIN, "light");
      await labelsOf(page, "W".repeat(32), "W".repeat(32));
      await page.keyboard.press("ControlOrMeta+n");
      await page.getByRole("button", { name: "Next" }).click();
      expect(await idsShown(page)).toEqual([
        { text: "openai:work", inside: true },
        { text: "openai:home", inside: true },
      ]);
    });
  });
}
