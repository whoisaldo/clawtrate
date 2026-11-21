// F-495 F-496 F-497 F-498 F-499: Another computer over SSH (docs/design/setup.md
// §5 to §8), on fixed state: every screen matches its approved baseline in
// light and dark, at 1440 px and the phone; the field, the key, the card and
// the strip send the host's commands and nothing else; Settings offers Remove.
import { expect, test, type Page } from "@playwright/test";
import { contextFor, openFixture, settle, SIZES, THEMES } from "./fixture.ts";

const SCREENS = [
  "there",
  "there-invalid",
  "there-refused",
  "there-looking",
  "there-hostkey",
  "there-changed",
  "there-found",
  "there-stopped",
  "there-not-found",
  "there-connecting",
  "there-starting",
  "there-unreachable",
  "there-sign-in",
  "there-code-failed",
  "there-app-files",
  "there-contradictory",
  "there-resume",
  "there-resume-failed",
  "there-resume-refused",
  "there-endpoint-changed",
  "there-replace-unticked",
  "there-gateway-stopped",
  "there-service-changed",
  "there-start-not-run",
  "there-start-unconfirmed",
  "there-remove-failed",
];
const STRIPS = [
  "route-restoring",
  "route-restored",
  "route-unreachable",
  "route-key-changed",
  "route-failed",
  "route-different",
  "route-restoring-identity",
];

const sent = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { clawtrateFixture: { sent: Array<Record<string, unknown>> } }
    ).clawtrateFixture.sent.map((command) => JSON.stringify(command)),
  );

for (const size of SIZES.filter((each) => each.name === "1440" || each.phone)) {
  for (const theme of THEMES) {
    test.describe(`${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      for (const state of SCREENS) {
        test(`F-495 F-496 F-497: another computer ${state}`, async ({ page }) => {
          await openFixture(page, `setup=${state}`, theme);
          await expect(page.getByTestId("setup")).toBeVisible();
          await settle(page);
          await expect(page).toHaveScreenshot(
            `another-computer-${state}-${theme}-${size.name}.png`,
          );
        });
      }
      for (const state of STRIPS) {
        test(`F-498: the status strip, ${state}`, async ({ page }) => {
          await openFixture(page, `setup=${state}`, theme);
          await expect(page.getByTestId("status-strip")).toBeVisible();
          await settle(page);
          await expect(page).toHaveScreenshot(
            `another-computer-${state}-${theme}-${size.name}.png`,
          );
        });
      }
    });
  }
}

test.describe("behaviour", () => {
  test.use(contextFor(SIZES[0]!, "light"));

  test("F-495: Another computer asks for an SSH host or alias, sends exactly what was typed, and a bad one is refused under the field", async ({
    page,
  }) => {
    await openFixture(page, "setup=first", "light");
    await page
      .getByRole("list", { name: "Where does OpenClaw run?" })
      .getByRole("button", { name: /Another computer/ })
      .click();
    await expect(page.getByRole("heading", { name: "Another computer" })).toBeFocused();
    const field = page.getByRole("textbox", { name: "SSH host or alias" });
    await expect(field).toHaveAttribute("placeholder", "devbox or you@devbox.example");
    await expect(
      page.getByText(
        "Clawtrate uses SSH keys and a limited set of settings from your SSH configuration. It never asks for a password.",
      ),
    ).toBeVisible();
    await field.fill("-oProxyCommand=x");
    await field.press("Enter");
    await expect(page.getByRole("alert")).toHaveText(
      "That isn't an SSH host or alias Clawtrate can use.",
    );
    await field.fill("you@devbox.example");
    await page.getByRole("button", { name: "Look there" }).click();
    expect((await sent(page)).filter((each) => each.includes("setupThere"))).toEqual([
      JSON.stringify({ type: "setupThere", destination: "-oProxyCommand=x" }),
      JSON.stringify({ type: "setupThere", destination: "you@devbox.example" }),
    ]);
    await expect(
      page.getByRole("heading", { name: "On you@devbox.example (SSH port 22)" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "OpenClaw is running" })).toBeVisible();
  });

  test("F-495: a refused setting is named, with Advanced; a first contact shows the fingerprint and asks the host to trust it", async ({
    page,
  }) => {
    await openFixture(page, "setup=there-refused", "light");
    await expect(page.getByText("The SSH settings for devbox include ProxyJump.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Advanced" })).toBeVisible();
    await openFixture(page, "setup=there-hostkey", "light");
    await expect(page.getByRole("heading", { name: "Is this devbox?" })).toBeVisible();
    await expect(
      page.getByText(
        "Clawtrate has no trusted key for you@devbox.example, SSH port 22. This is the key SSH presented.",
        { exact: false },
      ),
    ).toBeVisible();
    await expect(page.getByTestId("setup-fingerprint")).toContainText(
      "SHA256:Q3v8Lw0e Xk2Rj9Ta Nf5Hc1Ub Ym7Pd4Gs Zi6Ko2Ea Vr8",
    );
    await page.getByRole("button", { name: "Trust this key…" }).click();
    expect(await sent(page)).toContain(JSON.stringify({ type: "setupTrustKey" }));
  });

  test("F-495: a changed key shows both fingerprints; Try again looks again, and replacing it is a quiet button that asks the host", async ({
    page,
  }) => {
    await openFixture(page, "setup=there-changed", "light");
    await expect(
      page.getByText(
        "SSH presented a key that differs from the saved key for you@devbox.example (SSH port 22).",
      ),
    ).toBeVisible();
    await expect(page.getByTestId("setup-fingerprint")).toHaveCount(2);
    await expect(page.getByText("Saved ED25519 key, pinned 2026-10-02")).toBeVisible();
    await expect(page.getByText("Presented now: ED25519 key")).toBeVisible();
    await page.getByRole("button", { name: "Replace the saved key…" }).click();
    expect(await sent(page)).toContain(JSON.stringify({ type: "setupReplaceKey" }));
  });

  test("F-496 F-497: the card on another computer connects, or offers Start when OpenClaw is proven stopped", async ({
    page,
  }) => {
    await openFixture(page, "setup=there-found", "light");
    await page.getByRole("button", { name: "Connect read-only" }).click();
    expect(await sent(page)).toContain(JSON.stringify({ type: "setupConnect" }));
    await openFixture(page, "setup=there-stopped", "light");
    await page.getByRole("button", { name: "Start OpenClaw…" }).click();
    expect(await sent(page)).toContain(JSON.stringify({ type: "setupStart" }));
    await openFixture(page, "setup=there-not-found", "light");
    await expect(
      page.getByText("Setting OpenClaw up on another computer isn't offered in this version."),
    ).toBeVisible();
  });

  test("F-498 F-499: the strip's Retry now restores the route; Settings names the route and removes it through the host", async ({
    page,
  }) => {
    await openFixture(page, "setup=route-restoring", "light");
    const strip = page.getByTestId("status-strip");
    await expect(strip).toContainText("Restoring the connection to you@devbox.example");
    await strip.getByRole("button", { name: "Retry now" }).click();
    expect(await sent(page)).toContain(JSON.stringify({ type: "setupRetryRoute" }));
    await openFixture(page, "setup=route-up", "light");
    await page.keyboard.press("ControlOrMeta+,");
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(
      settings.getByText("Over SSH to you@devbox.example, default profile"),
    ).toBeVisible();
    await expect(settings.getByRole("button", { name: "Use another gateway" })).toHaveCount(0);
    await settings.getByRole("button", { name: "Remove this gateway…" }).click();
    expect(await sent(page)).toContain(JSON.stringify({ type: "setupRemoveRoute" }));
  });

  test("F-498 F-499: at launch, the saved route opens with its token and no QR step; one that couldn't be restored can be removed from its screen", async ({
    page,
  }) => {
    await openFixture(page, "setup=there-resume", "light");
    // The step list's own rows: the step under way is also said in a hidden live region.
    const steps = page.getByTestId("setup-step-list");
    await expect(steps.getByText("Opening the SSH forward")).toBeVisible();
    await expect(steps.getByText("Connecting with the saved device token")).toBeVisible();
    await expect(page.getByText(/one-time code/)).toHaveCount(0);
    await openFixture(page, "setup=there-resume-failed", "light");
    await page.getByRole("button", { name: "Remove you@devbox.example from Clawtrate…" }).click();
    expect(await sent(page)).toContain(JSON.stringify({ type: "setupRemoveRoute" }));
  });

  test("F-498: the strip says a route couldn't be restored, or that a different gateway answered, with Review", async ({
    page,
  }) => {
    await openFixture(page, "setup=route-failed", "light");
    const strip = page.getByTestId("status-strip");
    await expect(strip).toContainText(
      "Couldn't restore the connection to OpenClaw on you@devbox.example",
    );
    await strip.getByRole("button", { name: "Review" }).click();
    expect(await sent(page)).toContain(JSON.stringify({ type: "setupRetryRoute" }));
    await openFixture(page, "setup=route-different", "light");
    await expect(strip).toContainText("A different OpenClaw gateway answered");
  });
  test("F-495 F-499: a saved route that couldn't be opened keeps Remove on the field and the key screens, and Replace unticked says nothing was replaced", async ({
    page,
  }) => {
    for (const state of ["there-resume-refused", "there-endpoint-changed"]) {
      await openFixture(page, `setup=${state}`, "light");
      await page.getByRole("button", { name: /^Remove you@devbox\.example/ }).click();
      expect(await sent(page)).toContain(JSON.stringify({ type: "setupRemoveRoute" }));
    }
    await expect(page.getByText(/no longer lead to you@devbox\.example/)).toBeVisible();
    await openFixture(page, "setup=there-replace-unticked", "light");
    await expect(page.getByText("Nothing was replaced.")).toBeVisible();
    await openFixture(page, "setup=route-restoring-identity", "light");
    await expect(page.getByTestId("status-strip").getByRole("button")).toHaveCount(0);
    await openFixture(page, "setup=there-remove-failed", "light");
    await expect(page.getByRole("button", { name: "Remove again…" })).toBeVisible();
  });
});
