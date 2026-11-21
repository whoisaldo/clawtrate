// F-491 F-492 F-515 F-516: every state of setting up on this computer
// (docs/design/setup.md §3 to §7) matches its approved baseline, in light and
// dark, at 1440 px and the phone; the first screen, a found gateway and
// Connect's steps at 1100 and 800 px too.
import { expect, test } from "@playwright/test";
import { contextFor, openFixture, settle, SIZES, THEMES } from "./fixture.ts";

const STATES = [
  "first",
  "looking",
  "looking-slow",
  "found",
  "found-others",
  "untested",
  "too-old",
  "stopped",
  "stopped-by-hand",
  "program-missing",
  "cant-tell",
  "cant-tell-shape",
  "cant-tell-read-only",
  "not-token",
  "not-found",
  "windows",
  "connecting",
  "code-failed",
  "code-refused",
  "grant",
  "unreachable",
  "changed",
  "refused",
  "refused-home",
  "found-paired",
  "found-not-reported",
  "cant-run",
  "endpoint",
  "bots",
];
const EVERY_WIDTH = new Set(["first", "found", "connecting"]);

for (const size of SIZES) {
  for (const theme of THEMES) {
    test.describe(`${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      const shown =
        size.name === "1440" || size.phone
          ? STATES
          : STATES.filter((state) => EVERY_WIDTH.has(state));
      for (const state of shown) {
        test(`F-491 F-492 F-515 F-516: setup ${state}`, async ({ page }) => {
          await openFixture(page, `setup=${state}`, theme);
          await expect(page.getByTestId("setup")).toBeVisible();
          await settle(page);
          await expect(page).toHaveScreenshot(`this-computer-${state}-${theme}-${size.name}.png`);
        });
      }
    });
  }
}
