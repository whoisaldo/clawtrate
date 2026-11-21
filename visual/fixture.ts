import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";

/** Where the fixture is served: 5341 unless `CLAWTRATE_FIXTURE_PORT` names another. */
export const FIXTURE_PORT = Number(process.env.CLAWTRATE_FIXTURE_PORT ?? 5341);

/** Every fixture page sees the same moment, so row times and stamps are stable. */
export const NOW = new Date("2026-11-16T17:40:00-05:00");

export const OTTO_DISK = "bot=otto&task=agent:otto:disk-space";

export type Size = {
  name: string;
  width: number;
  height: number;
  /** A phone: a coarse pointer, so the app uses its touch sizes. */
  phone?: boolean;
};

export const SIZES: Size[] = [
  { name: "1440", width: 1440, height: 900 },
  { name: "1100", width: 1100, height: 800 },
  { name: "800", width: 800, height: 700 },
  { name: "phone", width: 390, height: 844, phone: true },
];

export const THEMES = ["light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export function contextFor(size: Size, theme: Theme) {
  return {
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: 1,
    isMobile: size.phone === true,
    hasTouch: size.phone === true,
    colorScheme: theme,
  } as const;
}

/** Open the fixture on a scene, with the clock fixed and the fonts loaded. */
export async function openFixture(page: Page, query: string, theme: Theme): Promise<void> {
  await page.clock.setFixedTime(NOW);
  await page.goto(`/?${query}&theme=${theme}`);
  await page.locator(".app").waitFor();
  await page.evaluate(() => document.fonts.ready);
  await expect
    .poll(() => page.evaluate(() => document.fonts.check('15px "Figtree Variable"')))
    .toBe(true);
}

/** Let layout, ResizeObservers and the follow-to-end logic settle. */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

/**
 * The frame a screenshot is to show is the final one: every font face the page uses is
 * loaded and none is loading, every image is decoded, and the transcript, at its end, and
 * the shelf keep the same geometry for three frames in a row. Text on screen alone does not
 * say so: a font, an image or the follow-to-end scroll can still move what is drawn.
 */
export async function paintedFinal(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          await document.fonts.ready;
          const faces = [...document.fonts];
          const used = new Set(
            [...document.querySelectorAll<HTMLElement>("body *")]
              .filter((element) => element.childNodes.length > 0 && element.checkVisibility())
              .map((element) => getComputedStyle(element).fontFamily.split(",")[0]!.trim())
              .map((family) => family.replace(/^["']|["']$/g, "")),
          );
          const loaded = faces.every((face) => face.status !== "loading");
          const usedLoaded = [...used].every(
            (family) =>
              !faces.some((face) => face.family.replace(/^["']|["']$/g, "") === family) ||
              faces.some(
                (face) =>
                  face.family.replace(/^["']|["']$/g, "") === family && face.status === "loaded",
              ),
          );
          const images = await Promise.all(
            [...document.images].map((image) =>
              image
                .decode()
                .then(() => image.complete && image.naturalWidth > 0)
                .catch(() => false),
            ),
          );
          return loaded && usedLoaded && images.every(Boolean);
        }),
      { message: "fonts loaded and images decoded" },
    )
    .toBe(true);
  // When the wait times out, keep what each frame looked like so the artifact shows
  // whether the transcript stopped following the end or the shelf kept moving.
  const frames: Array<{
    scrollTop: number | null;
    scrollHeight: number | null;
    clientHeight: number | null;
    shelf: number[][];
  }> = [];
  try {
    await expect
      .poll(
        async () => {
          const attempt = await page.evaluate(
            () =>
              new Promise<{
                atEnd: boolean;
                frames: Array<{
                  scrollTop: number | null;
                  scrollHeight: number | null;
                  clientHeight: number | null;
                  shelf: number[][];
                }>;
              }>((resolve) => {
                const geometry = () => {
                  const transcript = document.querySelector<HTMLElement>(
                    "[data-testid=transcript]",
                  );
                  const rows = [...document.querySelectorAll("[data-testid=shelf-row]")];
                  return {
                    scrollTop: transcript ? transcript.scrollTop : null,
                    scrollHeight: transcript ? transcript.scrollHeight : null,
                    clientHeight: transcript ? transcript.clientHeight : null,
                    shelf: rows.map((row) => {
                      const box = row.getBoundingClientRect();
                      return [box.left, box.top, box.width, box.height];
                    }),
                  };
                };
                const atEnd = () => {
                  const transcript = document.querySelector<HTMLElement>(
                    "[data-testid=transcript]",
                  );
                  return (
                    !transcript ||
                    transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight <= 1
                  );
                };
                const seen = [geometry()];
                const frame = () => {
                  seen.push(geometry());
                  if (seen.length < 4) requestAnimationFrame(frame);
                  else {
                    // Record the full boxes, but keep the wait on the original vertical layout.
                    const layouts = seen.map(({ shelf, ...transcript }) =>
                      JSON.stringify([transcript, shelf.map(([, top, , height]) => [top, height])]),
                    );
                    resolve({ atEnd: new Set(layouts).size === 1 && atEnd(), frames: seen });
                  }
                };
                requestAnimationFrame(frame);
              }),
          );
          frames.push(...attempt.frames);
          return attempt.atEnd;
        },
        { message: "the transcript at its end and the shelf, unchanged for three frames" },
      )
      .toBe(true);
  } catch (error) {
    // A body attachment reaches disk only through the trace, so write the file where
    // the artifact is gathered from and attach it by path.
    const path = test.info().outputPath("painted-final-frames.json");
    writeFileSync(path, JSON.stringify(frames, null, 2));
    await test.info().attach("painted-final-frames", {
      path,
      contentType: "application/json",
    });
    throw error;
  }
}

/** On a phone the conversation covers the list; show the list. */
export async function showList(page: Page): Promise<void> {
  const back = page.getByRole("button", { name: "Back to bots" });
  if (await back.isVisible()) await back.click();
}

const railButton = (page: Page, name: string) =>
  page.getByTestId("bot-list").getByRole("button", { name: new RegExp(`^${name}\\b`) });

export type StateScene = { name: string; query: string; prepare?: (page: Page) => Promise<void> };

/** The states this branch added, for screenshots and the legibility audit. */
export const STATE_SCENES: StateScene[] = [
  { name: "rail-pinned", query: `scene=main&${OTTO_DISK}&pins=main,otto,pip`, prepare: showList },
  { name: "task-states", query: `scene=task-states&${OTTO_DISK}`, prepare: showList },
  {
    name: "hidden-bots",
    query: `scene=main&${OTTO_DISK}&hidden=marlow,quartermaster`,
    prepare: async (page) => {
      await showList(page);
      await page.getByRole("button", { name: /^Hidden bots/ }).click();
    },
  },
  {
    name: "sort-menu",
    query: `scene=main&${OTTO_DISK}&sort=manual`,
    prepare: async (page) => {
      await showList(page);
      await page.getByRole("button", { name: /^Sort bots/ }).click();
      await expect(page.getByRole("menu", { name: "Sort bots" })).toBeVisible();
    },
  },
  {
    name: "bot-menu",
    query: `scene=main&${OTTO_DISK}&sort=manual`,
    prepare: async (page) => {
      await showList(page);
      await railButton(page, "Juniper").focus();
      await page.keyboard.press("Shift+F10");
      await expect(page.getByRole("menu", { name: "Juniper" })).toBeVisible();
    },
  },
  { name: "narrated-week", query: "scene=main&bot=pip&task=agent:pip:week" },
  { name: "neutral-bubbles", query: `scene=main&${OTTO_DISK}&bubbles=neutral` },
  { name: "context-unavailable", query: "scene=main&bot=marlow" },
  {
    name: "find",
    query: `scene=main&${OTTO_DISK}`,
    prepare: async (page) => {
      await page.locator(".transcript").focus();
      await page.keyboard.press("ControlOrMeta+F");
      await page.getByRole("textbox", { name: "Find in conversation" }).fill("disk");
      await page.keyboard.press("Enter");
    },
  },
  { name: "setup-connecting", query: "scene=connect-unreachable" },
  { name: "setup-loading-bots", query: "scene=discovering" },
  { name: "pairing-ended", query: "scene=pairing-ended" },
  { name: "protocol-mismatch", query: `scene=protocol-mismatch&${OTTO_DISK}` },
  { name: "disconnected", query: `scene=disconnected&${OTTO_DISK}` },
  {
    name: "settings",
    query: `scene=offline-unreachable&${OTTO_DISK}`,
    prepare: async (page) => {
      await page.keyboard.press("ControlOrMeta+,");
      await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    },
  },
  {
    name: "bot-search",
    query: `scene=main&${OTTO_DISK}`,
    prepare: async (page) => {
      await showList(page);
      await page.keyboard.press("ControlOrMeta+Shift+F");
      await page.getByRole("textbox", { name: "Search bots" }).fill("p");
    },
  },
];
