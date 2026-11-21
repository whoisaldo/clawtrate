// Approving a request on OpenClaw 2026.10.6 (docs/design/setup.md §9): the
// waiting state with the host's words for where the request waits and its
// profile-qualified command, and what an approval came to, each in the
// design's fixed words. Dark first, light after, at 1440 and at phone width.
// There is no "Approve from here" on this version: no state draws one.
import { expect, test, type Page } from "@playwright/test";
import { contextFor, openFixture, OTTO_DISK, paintedFinal, SIZES, type Theme } from "./fixture.ts";

const SHOWN = SIZES.filter((size) => size.name === "1440" || size.phone);
const THEMES: Theme[] = ["dark", "light"];
const REQUEST = "7c41d09e-52b3-4e8a-9f10-3d6b2a7e9c41";

const UNCONFIRMED =
  "Clawtrate disconnected. It couldn't confirm what this request granted. Review this device's access on the gateway before reconnecting.";

const bar = (page: Page) => page.getByTestId("access-bar");

/**
 * Each state: its scene, and what the bar must say and offer. The outcomes after an
 * approval are shown as the desktop app on an SSH route shows them (`setup`), with that
 * route's look and review.
 */
const STATES: Array<{ scene: string; setup?: string; check: (page: Page) => Promise<void> }> = [
  {
    scene: "access-waiting-ssh",
    check: async (page) => {
      await expect(bar(page)).toContainText(
        "Waiting for approval on devbox. On you@devbox.example (SSH port 22), run this for the default profile:",
      );
      await expect(bar(page).locator(".command code")).toHaveText(
        `openclaw devices approve ${REQUEST}`,
      );
      await expect(bar(page).getByRole("button", { name: "Copy approve command" })).toBeVisible();
      await expect(bar(page)).toContainText("Request 7c41d09e");
      // The host looks on a schedule over SSH, and says when next (§9).
      await expect(bar(page).getByTestId("access-next")).toHaveText("checking again in 4s");
      await expect(bar(page).getByRole("button", { name: "Check now" })).toBeVisible();
      await expect(bar(page).getByRole("button", { name: "Stop waiting" })).toBeVisible();
      await expect(bar(page).getByRole("button", { name: /Cancel request/ })).toHaveCount(0);
    },
  },
  {
    scene: "access-waiting-here",
    check: async (page) => {
      await expect(bar(page)).toContainText(
        "Waiting for approval on this computer. In Terminal on this computer, run this for Clawtrate's profile:",
      );
      await expect(bar(page).locator(".command code")).toHaveText(
        `openclaw --profile clawtrate devices approve ${REQUEST}`,
      );
      await expect(bar(page).getByTestId("access-next")).toHaveText("checking again in 4s");
      await expect(bar(page).getByRole("button", { name: "Check now" })).toBeVisible();
    },
  },
  {
    scene: "access-waiting-address",
    check: async (page) => {
      await expect(bar(page)).toContainText(
        "Waiting for approval. Run this on the gateway's computer, with `--profile <name>` if the gateway doesn't use the default profile:",
      );
      // No shell there: the wait is the gateway's own, so no Check now and no next check.
      await expect(bar(page)).toContainText("This changes by itself as soon as the owner approves");
      await expect(bar(page).getByRole("button", { name: "Check now" })).toHaveCount(0);
      await expect(bar(page).getByTestId("access-next")).toHaveCount(0);
      await expect(bar(page).getByRole("button", { name: "Stop waiting" })).toBeVisible();
    },
  },
  {
    scene: "access-confirming",
    check: (page) =>
      expect(bar(page)).toContainText("Approved. Checking what the gateway granted…"),
  },
  {
    scene: "access-unconfirmed",
    setup: "route-up",
    check: async (page) => {
      await expect(bar(page)).toContainText(UNCONFIRMED);
      // The route's look, and reconnecting as its own choice.
      await expect(bar(page).getByRole("button", { name: "Look again" })).toBeVisible();
      await expect(bar(page).getByRole("button", { name: "Reconnect" })).toBeVisible();
      // The gateway answered; Clawtrate disconnected: never "Can't reach".
      await expect(page.getByTestId("status-strip")).toContainText("Disconnected");
      await expect(page.getByTestId("status-strip")).not.toContainText("Can't reach");
      await expect(bar(page).locator(".command code")).toHaveCount(0);
    },
  },
  {
    scene: "access-stale",
    check: async (page) => {
      await expect(bar(page)).toContainText(
        "Clawtrate couldn't find this request in the gateway's pending list.",
      );
      await expect(bar(page).getByRole("button", { name: "Check again" })).toBeVisible();
      await expect(bar(page).getByRole("button", { name: "Request again" })).toBeVisible();
    },
  },
  {
    scene: "access-other-request",
    check: async (page) => {
      await expect(bar(page)).toContainText(
        "The gateway's pending request for this device isn't the one Clawtrate asked for.",
      );
      await expect(bar(page).locator(".command code")).toHaveCount(0);
    },
  },
  {
    scene: "access-identity-changed",
    setup: "route-up",
    check: async (page) => {
      await expect(bar(page)).toContainText("This route now leads to a different gateway.");
      await expect(bar(page).getByRole("button", { name: "Review" })).toBeVisible();
      await expect(bar(page).getByRole("button", { name: "Look again" })).toHaveCount(0);
      await expect(bar(page).getByRole("button", { name: "Reconnect" })).toHaveCount(0);
      // The status strip offers the bar's own action, never a reconnect to that gateway.
      const strip = page.getByTestId("status-strip");
      await expect(strip.getByRole("button", { name: "Review" })).toBeVisible();
      await expect(strip.getByRole("button", { name: "Reconnect" })).toHaveCount(0);
    },
  },
  {
    scene: "access-identity-unread",
    setup: "route-up",
    check: async (page) => {
      await expect(bar(page)).toContainText(
        "Clawtrate couldn't confirm this gateway's identity or version.",
      );
      await expect(bar(page).getByRole("button", { name: "Look again" })).toBeVisible();
    },
  },
  {
    scene: "access-list-unread",
    check: (page) =>
      expect(bar(page)).toContainText(
        "Couldn't read the gateway's requests on devbox. OpenClaw exited with code 2.",
      ),
  },
];

for (const size of SHOWN) {
  for (const theme of THEMES) {
    test.describe(`approving a request ${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      for (const state of STATES) {
        test(`F-500: ${state.scene}`, async ({ page }) => {
          await openFixture(
            page,
            `scene=${state.scene}&${OTTO_DISK}&panel=closed${state.setup ? `&setup=${state.setup}` : ""}`,
            theme,
          );
          await state.check(page);
          await expect(page.getByRole("button", { name: /Approve from here/ })).toHaveCount(0);
          await paintedFinal(page);
          await expect(page).toHaveScreenshot(`approve-${state.scene}-${theme}-${size.name}.png`);
        });
      }

      test("F-500: a grant confirmed after a lost wait is said once on the strip, then Granted", async ({
        page,
      }) => {
        await openFixture(page, `scene=access-recovered&${OTTO_DISK}&panel=closed`, theme);
        await expect(page.getByTestId("status-strip")).toContainText(
          "The gateway now shows the requested access.",
        );
        // Timers run with the clock fixed: after two seconds, the existing Granted words.
        await expect(page.getByTestId("status-strip")).toContainText("Access granted", {
          timeout: 6000,
        });
        await expect(page.getByTestId("access-bar")).toHaveCount(0);
      });

      test("F-500: the pairing screen over SSH", async ({ page }) => {
        await openFixture(page, "scene=pairing-ssh", theme);
        const note = page.locator(".approve-note");
        await expect(note).toHaveText(
          "Waiting for approval on devbox. On you@devbox.example (SSH port 22), run this for the default profile:",
        );
        await expect(page.locator(".command code")).toHaveText(
          "openclaw devices approve 5d2a90c4-1b7e-4f0a-9c3d-2e8f6a1b0c55",
        );
        await expect(page.getByText("Request 5d2a90c4", { exact: false })).toBeVisible();
        await expect(page.getByRole("button", { name: "Stop waiting" })).toBeVisible();
        await expect(page.getByRole("button", { name: /Approve from here/ })).toHaveCount(0);
        await paintedFinal(page);
        await expect(page).toHaveScreenshot(`approve-pairing-ssh-${theme}-${size.name}.png`);
      });
    });
  }
}

test("F-500: an address route's Review opens Settings on its Gateway pane, whichever pane was shown last", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFixture(
    page,
    `scene=access-identity-changed-address&${OTTO_DISK}&panel=closed`,
    "light",
  );
  // Settings shown last on another pane.
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("button", { name: "Usage" }).click();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.getByTestId("access-bar").getByRole("button", { name: "Review" }).click();
  await expect(dialog.getByRole("heading", { name: "Gateway" })).toBeVisible();
});
