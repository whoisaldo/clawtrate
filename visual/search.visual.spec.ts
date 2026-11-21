// The search palette (docs/design/search.md) against approved baselines, in
// light and dark at 1440, 1100 and 800 px and at phone width: before anything
// is typed, and with results from every kind of source. The fixture's
// messages, files and routines are made up (apps/desktop/src/fixture/search.ts).
import { expect, test } from "@playwright/test";
import { contextFor, openFixture, OTTO_DISK, settle, SIZES, THEMES } from "./fixture.ts";

const SCENES = [
  { name: "idle", text: "" },
  { name: "results", text: "transcode" },
];

for (const size of SIZES) {
  for (const theme of THEMES) {
    test.describe(`${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));

      for (const scene of SCENES) {
        test(`F-033: the palette, ${scene.name}`, async ({ page }) => {
          await openFixture(page, `scene=main&${OTTO_DISK}&search=on&routines=on`, theme);
          await page.keyboard.press("ControlOrMeta+K");
          const palette = page.getByTestId("search-palette");
          await expect(palette.getByRole("combobox", { name: "Search" })).toBeFocused();
          if (scene.text) {
            await page.keyboard.type(scene.text);
            // Once nothing in view is pending, the live region speaks.
            await expect(palette.getByTestId("search-announcer")).not.toHaveText("");
          }
          await settle(page);
          await expect(page).toHaveScreenshot(`search-${scene.name}-${theme}-${size.name}.png`);
        });
      }
    });
  }
}
