// The Work pane's Computer tab (work-pane.md, Part 3) against approved
// baselines, in light and dark at 1440, 1100 and 800 px and at phone width:
// every state of sections 17 to 19, the full view and its control bar, and
// the machine. The fixture answers with the engine itself and a scripted
// computer plugin (apps/desktop/src/fixture/computer.ts).
import { expect, test, type Page } from "@playwright/test";
import { contextFor, openFixture, settle, SIZES, THEMES } from "./fixture.ts";
import {
  COMPUTER,
  computerPanel,
  control,
  controlBar,
  fullView,
  openFull,
  OTTO_COMPUTER,
  take,
  tileReady,
  watch,
} from "./computer-helpers.ts";

type Scene = { name: string; rows: string; query: string; ready: (page: Page) => Promise<void> };
const panel = computerPanel;

const SCENES: Scene[] = [
  {
    name: "computer-noplugin",
    rows: "F-141",
    query: `${COMPUTER}&computer=noplugin`,
    ready: (page) =>
      expect(panel(page).getByText("Watching isn't set up on this gateway")).toBeVisible(),
  },
  {
    name: "computer-unconfigured",
    rows: "F-141",
    query: `${COMPUTER}&computer=unconfigured`,
    ready: (page) =>
      expect(
        panel(page).getByText("Watching isn't set up for Juniper on this gateway."),
      ).toBeVisible(),
  },
  {
    name: "computer-unused",
    rows: "F-141",
    query: `${COMPUTER}&computer=unused`,
    ready: (page) => expect(panel(page).getByText("No screen to show")).toBeVisible(),
  },
  {
    name: "computer-readonly",
    rows: "F-141",
    query: `${COMPUTER}&computer=watching&access=read`,
    ready: (page) =>
      expect(
        panel(page).getByText(
          "Watching needs a connection that can send. This device is read-only.",
        ),
      ).toBeVisible(),
  },
  {
    name: "computer-closed",
    rows: "F-141",
    query: `${COMPUTER}&computer=closed`,
    ready: (page) =>
      expect(
        panel(page).getByText("Juniper's browser has no tabs open.", { exact: false }),
      ).toBeVisible(),
  },
  {
    name: "computer-tile",
    rows: "F-144",
    query: `${COMPUTER}&computer=watching`,
    ready: tileReady,
  },
  {
    name: "computer-firstwatch",
    rows: "F-144",
    query: `${COMPUTER}&computer=watching&firstwatch=1`,
    ready: (page) => expect(panel(page).getByTestId("computer-first-watch")).toBeVisible(),
  },
  {
    name: "computer-watching",
    rows: "F-142",
    query: `${COMPUTER}&computer=watching`,
    ready: watch,
  },
  {
    name: "computer-active",
    rows: "F-139",
    query: `${COMPUTER}&computer=active`,
    ready: async (page) => {
      await tileReady(page);
      await expect(page.getByTestId("computer-button")).toHaveAttribute("data-active", "true");
    },
  },
  { name: "computer-full", rows: "F-142", query: `${COMPUTER}&computer=watching`, ready: openFull },
  {
    name: "computer-draining",
    rows: "F-142",
    query: `${COMPUTER}&computer=draining`,
    ready: async (page) => {
      await openFull(page);
      await take(page);
      await expect(controlBar(page)).toContainText("Waiting for the gateway to confirm control…");
    },
  },
  {
    name: "computer-control",
    rows: "F-142 F-145",
    query: `${COMPUTER}&computer=control`,
    ready: control,
  },
  {
    name: "computer-control-tile",
    rows: "F-142",
    query: `${COMPUTER}&computer=control`,
    ready: async (page) => {
      await control(page);
      await fullView(page)
        .getByRole("button", { name: /^Close the full view/ })
        .click();
      await expect(panel(page).getByTestId("computer-tile-control")).toBeVisible();
    },
  },
  {
    name: "computer-busy",
    rows: "F-142",
    query: `${COMPUTER}&computer=busy`,
    ready: async (page) => {
      await openFull(page);
      await take(page);
      await expect(controlBar(page)).toContainText(
        "Juniper is still acting in this browser. Try again in a moment.",
      );
    },
  },
  {
    name: "computer-unsettled",
    rows: "F-142",
    query: `${COMPUTER}&computer=unsettled`,
    ready: async (page) => {
      await openFull(page);
      await take(page);
      await expect(controlBar(page)).toContainText("A page in Juniper's browser is still loading.");
    },
  },
  {
    name: "computer-conflict",
    rows: "F-142",
    query: `${COMPUTER}&computer=conflict`,
    ready: async (page) => {
      await openFull(page);
      await take(page);
      await expect(controlBar(page)).toContainText(
        "Someone on another device is asking for control of Juniper's browser.",
      );
    },
  },
  {
    name: "computer-elsewhere",
    rows: "F-142",
    query: `${COMPUTER}&computer=elsewhere`,
    ready: async (page) => {
      await tileReady(page);
      await expect(panel(page).getByTestId("computer-elsewhere")).toBeVisible();
    },
  },
  {
    name: "computer-stuck",
    rows: "F-149",
    query: `${COMPUTER}&computer=stuck`,
    ready: async (page) => {
      await openFull(page);
      await take(page);
      for (let i = 0; i < 2; i++) {
        await expect(controlBar(page)).toContainText("Juniper is still acting");
        await controlBar(page).getByRole("button", { name: "Try again" }).click();
      }
      await expect(controlBar(page)).toContainText("Juniper is still acting");
      await fullView(page)
        .getByRole("button", { name: /^Close the full view/ })
        .click();
      await expect(panel(page).getByTestId("computer-stuck")).toBeVisible();
    },
  },
  {
    name: "computer-ended",
    rows: "F-142",
    query: `${COMPUTER}&computer=ended`,
    ready: async (page) => {
      await tileReady(page);
      await panel(page).getByRole("button", { name: "Watch Juniper's browser" }).click();
      await expect(panel(page).getByText("The view ended.", { exact: true })).toBeVisible();
    },
  },
  {
    name: "computer-tabclosed",
    rows: "F-142",
    query: `${COMPUTER}&computer=tabclosed`,
    ready: async (page) => {
      await tileReady(page);
      await panel(page).getByRole("button", { name: "Watch Juniper's browser" }).click();
      await expect(panel(page).getByText("This tab was closed.")).toBeVisible();
    },
  },
  {
    name: "computer-releasefail",
    rows: "F-145",
    query: `${COMPUTER}&computer=releasefail`,
    ready: async (page) => {
      await control(page);
      await controlBar(page).getByRole("button", { name: "Give back control" }).click();
      await expect(controlBar(page)).toContainText("Giving control back wasn't confirmed.");
    },
  },
  {
    name: "computer-complexquestion",
    rows: "F-145",
    query: `${COMPUTER}&computer=complexquestion`,
    ready: async (page) => {
      await control(page);
      await expect(
        controlBar(page).getByRole("button", { name: "Give back control and answer" }),
      ).toBeVisible();
    },
  },
  {
    name: "computer-machine",
    rows: "F-147 F-148 F-153 F-154",
    query: `${OTTO_COMPUTER}&computer=watching`,
    ready: async (page) => {
      await expect(panel(page).getByTestId("computer-node")).toContainText("Connected");
      await expect(panel(page).getByTestId("computer-commands")).toBeVisible();
    },
  },
  {
    name: "computer-offline",
    rows: "F-148 F-150",
    query: `${OTTO_COMPUTER}&computer=offline`,
    ready: (page) => expect(panel(page).getByRole("button", { name: "Check again" })).toBeVisible(),
  },
  {
    name: "computer-nodeunknown",
    rows: "F-148",
    query: `${OTTO_COMPUTER}&computer=nodeunknown`,
    ready: (page) => expect(panel(page).getByTestId("computer-node")).toContainText("Unknown"),
  },
];

for (const size of SIZES) {
  for (const theme of THEMES) {
    test.describe(`${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      for (const scene of SCENES) {
        test(`${scene.rows}: ${scene.name}`, async ({ page }) => {
          await openFixture(page, scene.query, theme);
          await scene.ready(page);
          await settle(page);
          await expect(page).toHaveScreenshot(`${scene.name}-${theme}-${size.name}.png`);
        });
      }
    });
  }
}
