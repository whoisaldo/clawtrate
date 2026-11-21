import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FONT_PACKAGES, licenseText } from "../scripts/font-licenses.ts";
import { FONT_LICENSES } from "../src/font-licenses.ts";

describe("the fonts' licenses travel with the app", () => {
  it("carries each embedded font's whole license, as its package ships it", () => {
    expect(FONT_LICENSES.map((license) => license.name)).toEqual(
      FONT_PACKAGES.map((font) => font.name),
    );
    for (const [index, font] of FONT_PACKAGES.entries()) {
      const text = licenseText(font.pkg);
      expect(text).toContain("SIL OPEN FONT LICENSE Version 1.1");
      expect(FONT_LICENSES[index]!.text).toBe(text);
    }
  });

  it("covers every font the app embeds", () => {
    const app = JSON.parse(readFileSync(join(import.meta.dirname, "../app.json"), "utf8")) as {
      expo: { plugins: Array<string | [string, { fonts: string[] }]> };
    };
    const fonts = app.expo.plugins.flatMap((plugin) =>
      Array.isArray(plugin) && plugin[0] === "expo-font" ? plugin[1].fonts : [],
    );
    expect(fonts.length).toBeGreaterThan(0);
    for (const font of fonts)
      expect(
        FONT_PACKAGES.some(({ pkg }) => font.includes(`/${pkg}/`)),
        font,
      ).toBe(true);
  });
});
