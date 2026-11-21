// Shared by the Computer tab's visual and behaviour checks.
import { expect, type Locator, type Page } from "@playwright/test";
import { OTTO_DISK } from "./fixture.ts";

/** Juniper's research task with the Work pane open on Computer. */
export const COMPUTER = "scene=main&bot=main&task=agent:main:ebook-apps&panel=open&tab=computer";
/** Otto's disk task on Computer: the machine with a node, and the commands. */
export const OTTO_COMPUTER = `scene=main&${OTTO_DISK}&panel=open&tab=computer`;

export const computerPanel = (page: Page) => page.locator("#work-tabpanel-computer");
export const fullView = (page: Page) => page.getByTestId("screen-view");
export const controlBar = (page: Page) => fullView(page).getByTestId("control-bar");

/** The tile has its tabs: the Watch pill is there. */
export const tileReady = (page: Page) =>
  expect(
    computerPanel(page).getByRole("button", { name: "Watch Juniper's browser" }),
  ).toBeVisible();

/**
 * The canvas shows a decoded frame: its first pixel is opaque. A canvas before its first frame is
 * 300 px wide and blank, so its width says nothing.
 */
export const painted = (canvas: Locator) =>
  expect
    .poll(
      () =>
        canvas
          .evaluate(
            (element: HTMLCanvasElement) =>
              element.getContext("2d")?.getImageData(0, 0, 1, 1).data[3] ?? 0,
          )
          .catch(() => 0),
      // Often: a view that ends soon after its frame clears the picture.
      { intervals: [20] },
    )
    .toBeGreaterThan(0);

/** Watch: the tile is live. */
async function startWatch(page: Page) {
  await tileReady(page);
  await computerPanel(page).getByRole("button", { name: "Watch Juniper's browser" }).click();
  await expect(computerPanel(page).locator(".screen[data-state=live] canvas")).toBeVisible();
}

/** Watch, and wait for the first frame to be drawn. */
export async function watch(page: Page) {
  await startWatch(page);
  await painted(computerPanel(page).locator(".screen canvas"));
}

/**
 * Watch, then open the full view at once and wait for its picture: a scene whose view ends soon
 * after its first frame (`ended`) still offers Open.
 */
export async function openFull(page: Page) {
  await startWatch(page);
  await computerPanel(page)
    .getByRole("button", { name: "Open Juniper's browser full window" })
    .click();
  await expect(fullView(page)).toBeVisible();
  await painted(fullView(page).locator("canvas"));
}

/** From the full view: Take control, and wait for the answer the scene's plugin gives. */
export async function take(page: Page) {
  await fullView(page).getByRole("button", { name: "Take control" }).click();
}

/** Take control and wait until the gateway granted it. */
export async function control(page: Page) {
  await openFull(page);
  await take(page);
  await expect(controlBar(page)).toContainText("You have control");
}
