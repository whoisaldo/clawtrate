// Parity rows for the shell's frame: the welcome screen, the title pill, the
// rail's search and the keyboard shortcuts that move between bots.
import { expect, test, type Page } from "@playwright/test";
import { contextFor, openFixture, OTTO_DISK, SIZES } from "./fixture.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;
const PHONE = SIZES.find((size) => size.phone)!;

const box = async (page: Page, selector: string) => (await page.locator(selector).boundingBox())!;

for (const size of [WIDE, PHONE]) {
  test.describe(`at ${size.name}`, () => {
    test.use(contextFor(size, "light"));

    test("F-001: first launch is a welcome screen with the mark, a tagline and one action, Connect a gateway", async ({
      page,
    }) => {
      // A fresh viewer: no gateway saved, nothing stored.
      await openFixture(page, "scene=connect", "light");
      const screen = page.getByRole("main");
      const mark = screen.locator(".connect-brand img");
      await expect(mark).toBeVisible();
      expect(await mark.getAttribute("src")).toMatch(/logo-mark/);
      expect((await mark.boundingBox())!.width).toBe(56);
      await expect(screen.getByRole("heading", { level: 1, name: "Clawtrate" })).toBeVisible();
      const tagline = screen.locator(".connect-brand p");
      await expect(tagline).toHaveText("Your OpenClaw agents, orchestrated.");
      const lineHeight = await tagline.evaluate((el) =>
        parseFloat(getComputedStyle(el).lineHeight),
      );
      expect((await tagline.boundingBox())!.height).toBeLessThan(lineHeight * 1.5);
      // One primary action, and it connects a gateway: no vendor account anywhere.
      const primary = screen.locator('.button[data-variant="primary"]');
      await expect(primary).toHaveCount(1);
      await expect(primary).toHaveAccessibleName("Connect a gateway");
      await expect(screen).not.toContainText(/sign in|log in|sign up|account/i);
    });
  });
}

test.describe("the title pill", () => {
  test.use(contextFor(WIDE, "light"));

  test("F-062: floats at the top centre with the bot's small avatar and name, and opens the details", async ({
    page,
  }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}&panel=closed`, "light");
    const pill = page.locator(".title-pill");
    await expect(pill).toBeVisible();
    // No bar: the header has no fill of its own, and the pill floats in it.
    expect(
      await page
        .locator(".conversation-header")
        .evaluate((el) => getComputedStyle(el).backgroundColor),
    ).toBe("rgba(0, 0, 0, 0)");
    const conversation = await box(page, ".conversation");
    const rect = await box(page, ".title-pill");
    expect(
      Math.abs(rect.x + rect.width / 2 - (conversation.x + conversation.width / 2)),
    ).toBeLessThanOrEqual(1);
    expect(rect.y - conversation.y).toBeLessThan(56 - rect.height);
    expect(await pill.evaluate((el) => getComputedStyle(el).borderRadius)).toBe("999px");
    const avatar = await box(page, ".title-pill .avatar");
    expect(avatar.width).toBe(22);
    await expect(pill.locator(".title-pill-name")).toHaveText("Otto");
    await expect(page.getByTestId("work-panel")).toHaveCount(0);
    await pill.click();
    const panel = page.getByTestId("work-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("heading", { name: "Otto" })).toBeVisible();
  });
});

/** A bot's row, by the start of its accessible name. */
const botRow = (page: Page, name: string) =>
  page.getByTestId("bot-list").getByRole("button", { name: new RegExp(`^${name}\\b`) });

test.describe("bot search", () => {
  test.use(contextFor(WIDE, "light"));

  test("F-267: Cmd/Ctrl+Shift+F opens bot search, which filters the rail by name", async ({
    page,
  }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
    const rows = page.getByTestId("bot");
    await expect(rows).toHaveCount(5);
    // The round search button sits at the top right of the rail.
    const button = page.getByRole("button", { name: "Search", exact: true });
    const rail = await box(page, ".rail");
    const at = (await button.boundingBox())!;
    expect(rail.x + rail.width - (at.x + at.width)).toBeLessThanOrEqual(12);
    expect(at.y - rail.y).toBeLessThan(56 - at.height);

    await page.getByRole("heading", { level: 1 }).click();
    await page.keyboard.press("ControlOrMeta+Shift+F");
    const field = page.getByRole("textbox", { name: "Search bots" });
    await expect(field).toBeFocused();
    await field.fill("ott");
    await expect(rows).toHaveCount(1);
    await expect(botRow(page, "Otto")).toBeVisible();
    await field.fill("PI");
    await expect(rows).toHaveCount(1);
    await expect(botRow(page, "Pip")).toBeVisible();
    await field.fill("nobody");
    await expect(rows).toHaveCount(0);
    await expect(page.getByTestId("bot-list")).toContainText("No bots match");
    // Escape closes it, shows every bot again and gives focus back to the button.
    await page.keyboard.press("Escape");
    await expect(field).toHaveCount(0);
    await expect(rows).toHaveCount(5);
    await expect(button).toBeFocused();
    // Enter opens the first match.
    await page.keyboard.press("ControlOrMeta+Shift+F");
    await page.keyboard.type("marl");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Main");
    await expect(botRow(page, "Marlow")).toBeFocused();
    await expect(rows).toHaveCount(5);
  });
});

test.describe("moving between bots", () => {
  test.use(contextFor(WIDE, "light"));

  test("F-028: Cmd/Ctrl+1 to 9 open sidebar bots; Alt+Up/Down and Control+Tab move to the previous or next", async ({
    page,
  }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
    const heading = page.getByRole("heading", { level: 1 });
    const opened = async (bot: string, task: string | RegExp) => {
      await expect(heading).toHaveText(task);
      await expect(page.locator(".title-pill-name")).toHaveText(bot);
    };
    await page.locator(".transcript").focus();
    // The rail's order is recent activity: Otto, Juniper, Marlow, Pip, Quartermaster.
    await page.keyboard.press("ControlOrMeta+3");
    await opened("Marlow", "Main");
    await page.keyboard.press("ControlOrMeta+2");
    await opened("Juniper", "Heat pump vs. gas furnace");
    await page.keyboard.press("ControlOrMeta+5");
    await opened("Quartermaster of the Family Calendar and Errands", /Pick up the dry cleaning/);
    // There is no sixth bot, so nothing changes.
    await page.keyboard.press("ControlOrMeta+6");
    await opened("Quartermaster of the Family Calendar and Errands", /Pick up the dry cleaning/);
    await page.keyboard.press("ControlOrMeta+1");
    await opened("Otto", "Disk almost full on the media box");
    await page.keyboard.press("Alt+ArrowDown");
    await opened("Juniper", "Heat pump vs. gas furnace");
    await page.keyboard.press("Alt+ArrowDown");
    await opened("Marlow", "Main");
    await page.keyboard.press("Alt+ArrowUp");
    await opened("Juniper", "Heat pump vs. gas furnace");
    await page.keyboard.press("Control+Tab");
    await opened("Marlow", "Main");
    await page.keyboard.press("Control+Tab");
    await opened("Pip", "Plan the week");
    await page.keyboard.press("Control+Shift+Tab");
    await opened("Marlow", "Main");
    // From a row in the rail, focus follows to the bot that opened.
    await botRow(page, "Marlow").focus();
    await page.keyboard.press("Control+Tab");
    await opened("Pip", "Plan the week");
    await expect(botRow(page, "Pip")).toBeFocused();

    // Ten bots: Cmd/Ctrl+6 to 9 open the sixth to the ninth; the tenth has no shortcut.
    const extra = ["Ash", "Birch", "Cedar", "Dahlia", "Elm"];
    await page.evaluate((names) => {
      type State = { bots: Array<Record<string, unknown>> };
      (
        window as unknown as {
          clawtrateFixture: { setState: (change: (state: State) => State) => void };
        }
      ).clawtrateFixture.setState((state) => ({
        ...state,
        bots: [
          ...state.bots,
          ...names.map((name) => ({
            id: name.toLowerCase(),
            name,
            emoji: null,
            avatarUrl: null,
            theme: null,
            model: null,
            isDefault: false,
          })),
        ],
      }));
    }, extra);
    await expect(page.getByTestId("bot")).toHaveCount(10);
    await page.locator(".transcript").focus();
    for (const [index, name] of extra.slice(0, 4).entries()) {
      await page.keyboard.press(`ControlOrMeta+${index + 6}`);
      await expect(page.locator(".title-pill-name")).toHaveText(name);
    }
    await page.keyboard.press("ControlOrMeta+1");
    await opened("Otto", "Disk almost full on the media box");
    await page.keyboard.press("ControlOrMeta+9");
    await expect(page.locator(".title-pill-name")).toHaveText("Dahlia");
  });
});
