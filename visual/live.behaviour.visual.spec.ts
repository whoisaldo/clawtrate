// How the live conversation behaves, in the fixture mode: sending, the keys,
// Stop, queueing, steering and holding, the access request, notices, motion
// and attachments (docs/design/conversation.md). The fixture answers the
// engine's commands closely enough for the interface; what depends on the
// gateway is proven in e2e/. Each title starts with the rows it covers.
import type { Run } from "../packages/core/src/runs.ts";
import type { ClawtrateState } from "../packages/core/src/types.ts";
import { expect, test, type Page } from "@playwright/test";
import { contextFor, openFixture, OTTO_DISK, settle, SIZES } from "./fixture.ts";

const open = (page: Page, scene: string, extra = "") =>
  openFixture(page, `scene=${scene}&${OTTO_DISK}&panel=closed${extra}`, "light");

const field = (page: Page) => page.getByTestId("composer-input");
const announcer = (page: Page) => page.getByTestId("announcer");

/**
 * Hold the fixture's delayed answers, or let them through: a state that lasts only until the
 * answer (Stopping…) is held while the check looks at it, never timed.
 */
const answers = (page: Page, action: "hold" | "release") =>
  page.evaluate(
    (name) =>
      (window as unknown as { clawtrateFixture: Record<string, () => void> }).clawtrateFixture[
        name
      ]!(),
    action,
  );

/** Change the fixture's state from the test, as the host's next snapshot would. */
async function setRun(page: Page, change: Record<string, unknown>) {
  await page.evaluate((patch) => {
    const fixture = (
      window as unknown as {
        clawtrateFixture: { setState: (f: (s: ClawtrateState) => ClawtrateState) => void };
      }
    ).clawtrateFixture;
    fixture.setState((state) => {
      const key = "agent:otto:disk-space";
      const transcript = state.transcripts[key]!;
      return {
        ...state,
        transcripts: {
          ...state.transcripts,
          [key]: {
            ...transcript,
            runs: transcript.runs.map((run: Run) =>
              run.id === "run-live" ? { ...run, ...patch } : run,
            ),
          },
        },
      };
    });
  }, change);
}

test.describe("sending", () => {
  test("F-068 F-072: Enter sends and clears the draft, Shift+Enter adds a line, and an empty draft sends nothing", async ({
    page,
  }) => {
    await open(page, "composer");
    await expect(field(page)).toHaveAttribute("placeholder", "Message Otto");
    await expect(page.getByRole("button", { name: "Attach files" })).toBeVisible();
    const send = page.getByRole("button", { name: "Send", exact: true });
    await expect(send).toBeDisabled();
    await field(page).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("outgoing")).toHaveCount(0);

    await field(page).fill("First line");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("second line");
    await expect(field(page)).toHaveValue("First line\nsecond line");
    await expect(send).toBeEnabled();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("outgoing")).toContainText("second line");
    await expect(field(page)).toHaveValue("");
    await expect(field(page)).toBeFocused();
  });

  test("F-068 F-073: one submit sends once, and a send still on its way never clears the next draft", async ({
    page,
  }) => {
    await open(page, "composer");
    // The host answers slowly.
    await page.evaluate(() => {
      const fixture = (
        window as unknown as { clawtrateFixture: { invoke: (c: unknown) => Promise<unknown> } }
      ).clawtrateFixture;
      const original = fixture.invoke.bind(fixture);
      (window as unknown as { __calls: number }).__calls = 0;
      fixture.invoke = (command: unknown) => {
        if ((command as { type: string }).type === "sendMessage")
          (window as unknown as { __calls: number }).__calls += 1;
        return new Promise((resolve) => setTimeout(resolve, 600)).then(() => original(command));
      };
    });
    await field(page).fill("Only once, please");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await expect(field(page)).toHaveValue("");
    await page.keyboard.type("The next thought");
    await expect(page.getByTestId("outgoing")).toHaveCount(1);
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => (window as unknown as { __calls: number }).__calls)).toBe(1);
    await expect(page.getByTestId("outgoing").locator(".bubble")).toHaveText(["Only once, please"]);
    await expect(field(page)).toHaveValue("The next thought");
  });

  test("F-106: Enter while the prior send is still being taken leaves the draft with an explicit notice", async ({
    page,
  }) => {
    await open(page, "composer");
    await page.evaluate(() => {
      const w = window as unknown as {
        clawtrateFixture: { invoke: (c: unknown) => Promise<unknown> };
        sentTexts: string[];
        releaseFirst?: () => void;
      };
      const fixture = w.clawtrateFixture;
      const original = fixture.invoke.bind(fixture);
      w.sentTexts = [];
      fixture.invoke = (command: unknown) => {
        const each = command as { type: string; text?: string };
        if (each.type !== "sendMessage") return original(command);
        w.sentTexts.push(each.text ?? "");
        // The first send's answer is held until the check releases it.
        if (w.sentTexts.length === 1)
          return new Promise<void>((resolve) => (w.releaseFirst = resolve)).then(() =>
            original(command),
          );
        return original(command);
      };
    });
    const sent = () =>
      page.evaluate(() => (window as unknown as { sentTexts: string[] }).sentTexts);
    await field(page).fill("First words");
    await page.keyboard.press("Enter");
    await expect(field(page)).toHaveValue("");
    await page.keyboard.type("Second words");
    await page.keyboard.press("Enter");
    await expect(page.locator(".composer-shelf [role=alert]")).toContainText(
      "This message is still in the composer.",
    );
    await expect(field(page)).toHaveValue("Second words");
    expect(await sent()).toEqual(["First words"]);
    await page.evaluate(() => (window as unknown as { releaseFirst: () => void }).releaseFirst());
    await expect(page.getByTestId("outgoing")).toHaveCount(1);
    await field(page).focus();
    await page.keyboard.press("Enter");
    await expect.poll(sent).toEqual(["First words", "Second words"]);
    await expect(field(page)).toHaveValue("");
  });

  test("F-074: Enter while a file is still being added leaves the draft with an explicit notice", async ({
    page,
  }) => {
    await open(page, "composer");
    await page.evaluate(() => {
      const w = window as unknown as {
        clawtrateFixture: {
          attach: (file: unknown) => Promise<unknown>;
          invoke: (c: unknown) => Promise<unknown>;
        };
        sentTexts: string[];
        releaseFile?: () => void;
      };
      const fixture = w.clawtrateFixture;
      const attach = fixture.attach.bind(fixture);
      const invoke = fixture.invoke.bind(fixture);
      w.sentTexts = [];
      // The host takes the file when the check says so.
      fixture.attach = (file: unknown) =>
        new Promise<void>((resolve) => (w.releaseFile = resolve)).then(() => attach(file));
      fixture.invoke = (command: unknown) => {
        const each = command as { type: string; text?: string };
        if (each.type === "sendMessage") w.sentTexts.push(each.text ?? "");
        return invoke(command);
      };
    });
    const sent = () =>
      page.evaluate(() => (window as unknown as { sentTexts: string[] }).sentTexts);
    await page
      .locator('.composer input[type="file"]')
      .setInputFiles([{ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("notes") }]);
    await expect(page.locator(".attachments .chip")).toHaveCount(1);
    await field(page).fill("With the notes");
    await page.keyboard.press("Enter");
    await expect(page.locator(".composer-shelf [role=alert]")).toContainText(
      "This message is still in the composer.",
    );
    await expect(field(page)).toHaveValue("With the notes");
    expect(await sent()).toEqual([]);
    await page.evaluate(() => (window as unknown as { releaseFile: () => void }).releaseFile());
    await expect(page.locator(".attachments .chip[aria-busy=true]")).toHaveCount(0);
    await field(page).focus();
    await page.keyboard.press("Enter");
    await expect.poll(sent).toEqual(["With the notes"]);
  });

  test("F-073: a refused send gives its words and files back, ahead of anything typed since", async ({
    page,
  }) => {
    await open(page, "composer");
    await page.evaluate(() => {
      const fixture = (
        window as unknown as { clawtrateFixture: { invoke: (c: unknown) => Promise<unknown> } }
      ).clawtrateFixture;
      const original = fixture.invoke.bind(fixture);
      // The refusal comes when the check says so, not after a time: the words and files must be
      // seen to leave first, on a machine of any speed.
      const held = window as unknown as { refuse?: () => void };
      fixture.invoke = (command: unknown) =>
        (command as { type: string }).type === "sendMessage"
          ? new Promise((_, reject) => {
              held.refuse = () => reject(new Error("The message is too long."));
            })
          : original(command);
    });
    await page
      .locator('.composer input[type="file"]')
      .setInputFiles([{ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("notes") }]);
    await expect(page.locator(".attachments .chip")).toHaveCount(1);
    await field(page).fill("Refused words");
    await page.keyboard.press("Enter");
    await expect(page.locator(".attachments .chip")).toHaveCount(0);
    await page.keyboard.type("typed meanwhile");
    await expect(field(page)).toHaveValue("typed meanwhile");
    await page.evaluate(() => (window as unknown as { refuse: () => void }).refuse());
    await expect(page.locator(".composer-shelf [role=alert]")).toContainText(
      "Couldn't send this message.",
    );
    await expect(field(page)).toHaveValue("Refused words\ntyped meanwhile");
    await expect(page.locator(".attachments .chip")).toHaveText([/notes\.txt/]);
  });

  test("F-073: a draft belongs to one gateway as well as one task", async ({ page }) => {
    await open(page, "composer");
    await field(page).fill("Draft on the first gateway");
    await page.evaluate(() => {
      const fixture = (
        window as unknown as {
          clawtrateFixture: {
            setState: (f: (s: { connection: { gatewayUrl: string | null } }) => unknown) => void;
          };
        }
      ).clawtrateFixture;
      fixture.setState((state) => ({
        ...state,
        connection: { ...state.connection, gatewayUrl: "ws://127.0.0.1:18790" },
      }));
    });
    await expect(field(page)).toHaveValue("");
    await page.evaluate(() => {
      const fixture = (
        window as unknown as {
          clawtrateFixture: {
            setState: (f: (s: { connection: { gatewayUrl: string | null } }) => unknown) => void;
          };
        }
      ).clawtrateFixture;
      fixture.setState((state) => ({
        ...state,
        connection: { ...state.connection, gatewayUrl: "ws://127.0.0.1:18789" },
      }));
    });
    await expect(field(page)).toHaveValue("Draft on the first gateway");
  });

  test("F-072: Cmd/Ctrl+Enter sends from anywhere in the window", async ({ page }) => {
    await open(page, "composer");
    await field(page).fill("Sent from the transcript");
    await page.getByTestId("transcript").focus();
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(page.getByTestId("outgoing")).toContainText("Sent from the transcript");
  });

  test("F-081 F-085: within a second of a send the status line shows the avatar and Thinking", async ({
    page,
  }) => {
    await open(page, "composer");
    await field(page).fill("Check the disk again");
    const sent = Date.now();
    await page.keyboard.press("Enter");
    const line = page.getByTestId("status-line");
    await expect(line).toBeVisible({ timeout: 1000 });
    expect(Date.now() - sent).toBeLessThan(1000);
    await expect(line.getByTestId("status-phrase")).toHaveText("Thinking");
    await expect(line.locator(".presence")).toHaveAttribute("data-state", "thinking");
    await expect(line).toHaveAccessibleName("Otto, thinking. Nothing running to show.");
    // The gateway has not reported when the run started: no clock.
    await expect(line.locator(".status-elapsed")).toHaveCount(0);
  });

  test("F-465 F-466: Cmd/Ctrl+I focuses the composer, and Cmd/Ctrl+L puts exactly the selected text in it", async ({
    page,
  }) => {
    await open(page, "composer");
    await page.getByTestId("transcript").focus();
    await page.keyboard.press("ControlOrMeta+i");
    await expect(field(page)).toBeFocused();
    await page.evaluate(() => {
      const heading = document.querySelector(".task-line")!;
      const range = document.createRange();
      range.selectNodeContents(heading);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      (document.querySelector(".transcript") as HTMLElement).focus();
    });
    await page.keyboard.press("ControlOrMeta+l");
    await expect(field(page)).toHaveValue("Disk almost full on the media box");
    await expect(field(page)).toBeFocused();
  });

  test("F-466: Cmd/Ctrl+L appends the selected text after an existing draft, on a new line, and focuses the field", async ({
    page,
  }) => {
    await open(page, "composer");
    await field(page).fill("About this:");
    await page.evaluate(() => {
      const heading = document.querySelector(".task-line")!;
      const range = document.createRange();
      range.selectNodeContents(heading);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      (document.querySelector(".transcript") as HTMLElement).focus();
    });
    await expect(field(page)).not.toBeFocused();
    await page.keyboard.press("ControlOrMeta+l");
    await expect(field(page)).toHaveValue("About this:\nDisk almost full on the media box");
    await expect(field(page)).toBeFocused();
    // Nothing was sent: the words wait in the field.
    await expect(page.getByTestId("outgoing")).toHaveCount(0);
  });

  test("F-073: an unsent draft is kept per task", async ({ page }) => {
    await open(page, "composer");
    await field(page).fill("Half a thought about the disk");
    await page.getByTestId("task").filter({ hasText: "Weekly backup check" }).click();
    await expect(field(page)).toHaveValue("");
    await field(page).fill("Something about backups");
    await page.getByTestId("task").filter({ hasText: "Disk almost full" }).click();
    await expect(field(page)).toHaveValue("Half a thought about the disk");
    await page.getByTestId("task").filter({ hasText: "Weekly backup check" }).click();
    await expect(field(page)).toHaveValue("Something about backups");
  });

  test("F-260: a line starting with > is sent as a block quote", async ({ page }) => {
    await open(page, "composer");
    await field(page).fill("> the disk is 94% full\n\nIs that still true?");
    await page.keyboard.press("Enter");
    const bubble = page.getByTestId("outgoing");
    await expect(bubble.locator("blockquote")).toHaveText("the disk is 94% full");
    await expect(bubble.locator("p").last()).toHaveText("Is that still true?");
  });

  test("F-106: several messages sent quickly each appear once, in order", async ({ page }) => {
    await open(page, "composer");
    for (const text of ["one", "two", "three"]) {
      await field(page).fill(text);
      await page.keyboard.press("Enter");
    }
    await expect(page.getByTestId("outgoing").locator(".bubble")).toHaveText([
      "one",
      "two",
      "three",
    ]);
  });

  test("F-075: a failed send says so, and Resend and Delete act on it", async ({ page }) => {
    await open(page, "send-failed");
    const bubble = page.getByTestId("outgoing");
    await expect(bubble).toContainText("Failed to send");
    // Not in your colour: the gateway never accepted it.
    await expect(bubble.locator(".msg")).toHaveAttribute("data-pending", "held");
    await bubble.getByRole("button", { name: "Resend" }).click();
    await expect(bubble).toHaveAttribute("data-status", "sending");
    await expect(bubble).not.toContainText("Failed to send");
    await open(page, "send-failed");
    await page.getByTestId("outgoing").getByRole("button", { name: "Delete" }).click();
    await expect(page.getByTestId("outgoing")).toHaveCount(0);
  });

  test("F-075: a send whose outcome is unknown is never shown as received, and Resend sends it again", async ({
    page,
  }) => {
    await open(page, "send-unknown");
    const bubble = page.getByTestId("outgoing");
    await expect(bubble).toContainText("Not known whether the gateway received it");
    await expect(bubble).not.toContainText(/took it|Sent|Steer/);
    // Not in your colour: nothing establishes that the gateway took it.
    await expect(bubble.locator(".msg")).toHaveAttribute("data-pending", "held");
    await bubble.getByRole("button", { name: "Resend" }).click();
    await expect(bubble).toHaveAttribute("data-status", "sending");
  });

  test("F-287: a message written offline is held in the neutral fill and marked to send when reconnected", async ({
    page,
  }) => {
    await open(page, "offline-send");
    const held = page.getByTestId("outgoing").filter({ hasText: "Skip the photos folder." });
    await expect(held).toContainText("Sends when reconnected");
    await expect(held.locator(".msg")).toHaveAttribute("data-pending", "held");
    await expect(field(page)).toHaveAttribute(
      "placeholder",
      "Offline. Messages send when you reconnect.",
    );
    // Offline the composer is Send alone.
    await expect(page.getByTestId("stop")).toHaveCount(0);
    // When the connection returns and the gateway takes it, it takes your colour and loses the mark.
    await page.evaluate(() => {
      const fixture = (
        window as unknown as {
          clawtrateFixture: { setState: (f: (s: ClawtrateState) => ClawtrateState) => void };
        }
      ).clawtrateFixture;
      fixture.setState((state) => {
        const key = "agent:otto:disk-space";
        const transcript = state.transcripts[key]!;
        return {
          ...state,
          connection: { ...state.connection, status: "connected", retryAt: null },
          transcripts: {
            ...state.transcripts,
            [key]: {
              ...transcript,
              outbox: transcript.outbox.map((each) =>
                each.status === "awaiting-access" ? { ...each, status: "sent" } : each,
              ),
            },
          },
        };
      });
    });
    await expect(held).not.toContainText("Sends when reconnected");
    await expect(held.locator(".msg")).not.toHaveAttribute("data-pending", "held");
  });

  test("F-074 F-285: files attach as chips; one over the limit is refused before sending and can be removed", async ({
    page,
  }) => {
    await open(page, "composer");
    const input = page.locator('.composer input[type="file"]');
    await input.setInputFiles([
      { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.alloc(1024 * 1024) },
      { name: "photo.png", mimeType: "image/png", buffer: Buffer.alloc(8.2 * 1024 * 1024) },
    ]);
    const chips = page.locator(".attachments .chip");
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(0)).toContainText("1.0 MB");
    await expect(chips.nth(1)).toContainText("8.2 MB. Images can be up to 6 MB.");
    await expect(chips.nth(1)).toHaveAttribute("data-tone", "danger");
    const send = page.getByRole("button", { name: "Send", exact: true });
    await expect(send).toBeDisabled();
    await page.getByRole("button", { name: "Remove photo.png" }).click();
    await expect(chips).toHaveCount(1);
    await expect(send).toBeEnabled();
    await send.click();
    await expect(page.getByTestId("outgoing")).toHaveCount(1);
    await expect(page.getByTestId("outgoing")).toContainText("notes.txt");
    await expect(chips).toHaveCount(0);
  });

  test("F-074 F-285: the gateway's own file ceiling, and a message too large as sent, each hold Send with the reason", async ({
    page,
  }) => {
    await open(page, "composer");
    const input = page.locator('.composer input[type="file"]');
    // The fixture's gateway advertises what OpenClaw 2026.10.6 does: files up to 18.6 MB.
    await input.setInputFiles([
      { name: "scan.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(19 * 1024 * 1024) },
    ]);
    const chips = page.locator(".attachments .chip");
    await expect(chips).toContainText("19.0 MB. Files can be up to 18.6 MB.");
    const send = page.getByRole("button", { name: "Send", exact: true });
    await expect(send).toBeDisabled();
    await page.getByRole("button", { name: "Remove scan.pdf" }).click();
    // Four files of 5 MB each fit, one by one, but not together once encoded for the request.
    await input.setInputFiles(
      [1, 2, 3, 4].map((n) => ({
        name: `part-${n}.pdf`,
        mimeType: "application/pdf",
        buffer: Buffer.alloc(5 * 1024 * 1024),
      })),
    );
    await expect(chips).toHaveCount(4);
    const reason = "26.7 MB to send with its files. A message can carry up to 25 MB.";
    await expect(page.locator(".attachments-note")).toHaveText(reason);
    await expect(send).toBeDisabled();
    await expect(send).toHaveAttribute("title", reason);
    await page.getByRole("button", { name: "Remove part-4.pdf" }).click();
    await expect(page.locator(".attachments-note")).toHaveCount(0);
    await expect(send).toBeEnabled();
  });
});

test("F-074: files can be dragged into the composer or pasted into its field", async ({ page }) => {
  await open(page, "composer");
  await page.locator(".composer-box").evaluate((box) => {
    const data = new DataTransfer();
    data.items.add(new File(["dragged"], "dragged.txt", { type: "text/plain" }));
    box.dispatchEvent(
      new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }),
    );
  });
  await field(page).evaluate((input) => {
    const data = new DataTransfer();
    data.items.add(new File(["pasted"], "pasted.png", { type: "image/png" }));
    input.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await expect(page.locator(".attachments .chip")).toHaveText([/dragged\.txt/, /pasted\.png/]);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("outgoing")).toContainText("dragged.txt, pasted.png");
});

test("F-282: Start as new task with files attached keeps the words and the files, and says why", async ({
  page,
}) => {
  await open(page, "composer");
  await page
    .locator('.composer input[type="file"]')
    .setInputFiles([{ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("notes") }]);
  await field(page).fill("Start this elsewhere");
  await page.keyboard.press("ControlOrMeta+Shift+Enter");
  await expect(page.locator(".composer-shelf [role=alert]")).toContainText(
    "A new task can't take files yet.",
  );
  await expect(field(page)).toHaveValue("Start this elsewhere");
  await expect(page.locator(".attachments .chip")).toHaveText([/notes\.txt/]);
  await expect(announcer(page)).not.toHaveText("Started as a new task");
});

test.describe("the status line", () => {
  test("F-082 F-086 F-087: a running step's title is the phrase, the avatar works, and the phrase is its own tooltip", async ({
    page,
  }) => {
    await open(page, "run-working");
    const line = page.getByTestId("status-line");
    await expect(line.getByTestId("status-phrase")).toHaveText("Reading backup-2026-11-15.log");
    await expect(line.locator(".presence")).toHaveAttribute("data-state", "working");
    await expect(line).toHaveAttribute("title", "Reading backup-2026-11-15.log");
    await expect(line).toHaveAccessibleName(
      "Otto, working: Reading backup-2026-11-15.log. Show the action.",
    );
  });

  test("F-084: a light crosses the phrase while the bot works, and stops when it waits or stops", async ({
    page,
  }) => {
    const shimmer = (page: Page) =>
      page.getByTestId("status-phrase").evaluate((el) => getComputedStyle(el).animationName);
    await open(page, "run-working");
    expect(await shimmer(page)).toContain("shimmer");
    await open(page, "run-waiting");
    expect(await shimmer(page)).not.toContain("shimmer");
    await open(page, "run-stopping");
    expect(await shimmer(page)).not.toContain("shimmer");
  });

  test("F-291 F-086: with reduced motion nothing loops: the avatar, the phrase and the caret keep still forms", async ({
    page,
  }) => {
    await open(page, "run-working", "&motion=reduce");
    const still = await page.evaluate(() =>
      [".status-line .presence svg", ".status-line .presence", ".status-phrase"].map((selector) => {
        const element = document.querySelector(selector)!;
        return [
          getComputedStyle(element).animationName,
          getComputedStyle(element, "::before").animationName,
        ];
      }),
    );
    expect(still.flat().every((name) => name === "none")).toBe(true);
    // The working state still shows: the arc is held in place.
    expect(
      await page
        .locator(".status-line .presence")
        .evaluate((el) => getComputedStyle(el, "::before").opacity),
    ).toBe("1");
    await open(page, "run-streaming", "&motion=reduce");
    expect(
      await page.locator(".stream-caret").evaluate((el) => getComputedStyle(el).animationName),
    ).toBe("none");
    expect(
      await page
        .locator("[data-testid=live-turn] .md > p")
        .last()
        .evaluate((p) => getComputedStyle(p, "::after").animationName),
    ).toBe("none");
  });

  test("F-292: a pending card reads Waiting for you, and the running phrase returns when it settles", async ({
    page,
  }) => {
    await open(page, "run-waiting");
    const phrase = page.getByTestId("status-phrase");
    await expect(phrase).toHaveText("Waiting for you");
    await expect(page.locator(".status-line .presence")).toHaveAttribute("data-state", "waiting");
    await expect(page.getByTestId("needs-you")).toContainText("Otto needs your approval");
    await setRun(page, {
      state: "running",
      pendingCards: [],
      steps: [],
    });
    await page.evaluate(() => {
      const fixture = (
        window as unknown as {
          clawtrateFixture: { setState: (f: (s: ClawtrateState) => ClawtrateState) => void };
        }
      ).clawtrateFixture;
      fixture.setState((state) => {
        const key = "agent:otto:disk-space";
        return {
          ...state,
          transcripts: {
            ...state.transcripts,
            [key]: { ...state.transcripts[key]!, approvals: [] },
          },
        };
      });
    });
    await expect(phrase).toHaveText("Thinking");
    await expect(page.getByTestId("needs-you")).toHaveCount(0);
  });

  test("F-292: Review and Cmd/Ctrl+J go to the oldest pending card by arrival, questions and approvals mixed", async ({
    page,
  }) => {
    await open(page, "run-waiting");
    // An older question arrives in the state beside the newer approval.
    await page.evaluate(() => {
      const fixture = (
        window as unknown as {
          clawtrateFixture: { setState: (f: (s: ClawtrateState) => ClawtrateState) => void };
        }
      ).clawtrateFixture;
      fixture.setState((state) => {
        const key = "agent:otto:disk-space";
        const transcript = state.transcripts[key]!;
        const approval = transcript.approvals[0]!;
        return {
          ...state,
          transcripts: {
            ...state.transcripts,
            [key]: {
              ...transcript,
              questions: [
                {
                  id: "question-old",
                  runId: "run-live",
                  status: "pending",
                  questions: [
                    {
                      id: "which",
                      header: "Which",
                      question: "Which disk first?",
                      options: [
                        { index: 0, label: "The media disk", description: null, value: null },
                      ],
                      optionsOmitted: 0,
                      multiSelect: false,
                      allowsOther: true,
                    },
                  ],
                  createdAt: (approval.createdAt ?? Date.now()) - 60_000,
                  expiresAt: null,
                  answers: null,
                  submitting: false,
                  error: null,
                  raw: null,
                  ordinary: true,
                  sent: null,
                  settledBy: [],
                },
              ],
            },
          },
        };
      });
    });
    await expect(page.getByTestId("needs-you")).toContainText("Otto asked you a question");
    // In the transcript too, the real cards in the order they arrived.
    const cards = page.locator('.transcript .card.request[data-pending="true"]');
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toHaveAttribute("data-kind", "question");
    await expect(cards.nth(1)).toHaveAttribute("data-kind", "approval");
    const firstOption = page.getByTestId("question-card").locator('.option[tabindex="0"]');
    await page.getByTestId("needs-you").getByRole("button", { name: "Review" }).click();
    await expect(firstOption).toBeFocused();
    await page.getByTestId("transcript").focus();
    await page.keyboard.press("ControlOrMeta+j");
    await expect(firstOption).toBeFocused();
  });

  test("F-163: an approval card the reader has open stays open when its run settles into history, and Raw stays usable", async ({
    page,
  }) => {
    await open(page, "run-waiting");
    const card = page.getByTestId("approval-card");
    await card.getByRole("button", { name: "Allow", exact: true }).click();
    await expect(card.locator(".tag")).toHaveText("Allowed once", { timeout: 5_000 });
    await card.locator("summary").first().click();
    await expect(card.locator(".request-resolved-body")).toBeVisible();

    // The live reply is reconciled into its history row: the run is history's
    // now, its message is in the transcript and the outbox holds nothing.
    await page.evaluate(() => {
      const fixture = (
        window as unknown as {
          clawtrateFixture: { setState: (f: (s: ClawtrateState) => ClawtrateState) => void };
        }
      ).clawtrateFixture;
      fixture.setState((state) => {
        const key = "agent:otto:disk-space";
        const transcript = state.transcripts[key]!;
        const user = [...transcript.items].reverse().find((item) => item.role === "user")!;
        return {
          ...state,
          transcripts: {
            ...state.transcripts,
            [key]: {
              ...transcript,
              runs: transcript.runs.map((run: Run) =>
                run.id === "run-live"
                  ? {
                      ...run,
                      state: "completed" as const,
                      endedAt: Date.now(),
                      outcomeKnown: true,
                      anchorItemId: user.id,
                      textComplete: true,
                      text: "The cache is gone; 4 GB free again.",
                      pendingCards: [],
                    }
                  : run,
              ),
              outbox: [],
              items: [
                ...transcript.items,
                {
                  id: "row-reply:1",
                  role: "assistant" as const,
                  timestamp: Date.now(),
                  model: "scripted/dev-1",
                  blocks: [
                    {
                      kind: "tool-call" as const,
                      callId: "call-exec-1",
                      name: "exec",
                      argumentsText: '{\n  "command": "rm -rf /srv/media/cache/thumbs"\n}',
                      result: { isError: false, text: "Removed the cache." },
                    },
                    { kind: "text" as const, text: "The cache is gone; 4 GB free again." },
                  ],
                },
              ],
            },
          },
        };
      });
    });
    await expect(page.getByTestId("transcript")).toContainText("The cache is gone", {
      timeout: 5_000,
    });
    // The card kept its identity: still open, at its row, with Raw usable.
    await expect(card.locator(".tag")).toHaveText("Allowed once");
    await expect(card).toHaveAttribute("open", "");
    await card.getByRole("button", { name: "Raw" }).click();
    const panel = card.getByRole("region", { name: "What the gateway sent" });
    await expect(panel).toContainText("What this app sent (exec.approval.resolve)");
    await expect(panel).toContainText('"decision": "allow-once"');
  });

  test("F-089: the status line stays while replies and cards arrive and leaves only when the run ends", async ({
    page,
  }) => {
    await open(page, "run-working");
    await setRun(page, { text: "Half of the reply." });
    await expect(page.getByTestId("status-line")).toBeVisible();
    await setRun(page, {
      state: "waiting",
      pendingCards: [{ id: "x", kind: "approval", since: 1 }],
    });
    await expect(page.getByTestId("status-line")).toBeVisible();
    await setRun(page, { state: "completed", textComplete: true, endedAt: Date.now() });
    await expect(page.getByTestId("status-line")).toHaveCount(0);
    // No message that only says it is done.
    await expect(page.locator(".transcript")).not.toContainText(/Otto is done|finished\./);
    await expect(announcer(page)).toHaveText("Otto finished");
  });

  test("F-089: a run whose ending nothing established is not announced as finished or stopped", async ({
    page,
  }) => {
    await open(page, "run-working");
    await setRun(page, { state: "stopped", outcomeKnown: false, endedAt: Date.now() });
    await expect(page.getByTestId("status-line")).toHaveCount(0);
    await page.waitForTimeout(100);
    await expect(announcer(page)).not.toHaveText(/Stopped|finished|couldn't finish/);
    await expect(page.getByTestId("stop-note")).toHaveCount(0);
  });

  test("F-095 F-433: the reply streams with a caret and aria-busy until the gateway says it is complete", async ({
    page,
  }) => {
    await open(page, "run-streaming");
    const bubble = page.getByTestId("live-turn").locator(".bubble");
    await expect(bubble).toHaveAttribute("aria-busy", "true");
    await expect(bubble.locator(".stream-caret")).toHaveCount(1);
    await setRun(page, { text: "The backup finished at 02:14 and wrote 41 GB in all." });
    await expect(bubble).toContainText("wrote 41 GB in all.");
    await setRun(page, { textComplete: true });
    await expect(bubble).toHaveAttribute("aria-busy", "false");
    await expect(bubble.locator(".stream-caret")).toHaveCount(0);
  });

  test("F-433: the streaming marker lasts until the gateway says the reply is complete, through Stopping…", async ({
    page,
  }) => {
    await open(page, "run-streaming");
    const bubble = page.getByTestId("live-turn").locator(".bubble");
    await setRun(page, { state: "stopping", stopRequestedAt: Date.now() });
    await expect(page.getByTestId("status-phrase")).toHaveText("Stopping…");
    await expect(bubble).toHaveAttribute("aria-busy", "true");
    await expect(bubble).toHaveAttribute("data-streaming", "true");
    await setRun(page, { state: "stopped", endedAt: Date.now() });
    await expect(bubble).toHaveAttribute("aria-busy", "false");
    await expect(page.getByTestId("incomplete")).toHaveText("Incomplete");
  });

  test("F-433: a reply the gateway reported complete is never called Incomplete when the run then fails", async ({
    page,
  }) => {
    await open(page, "run-streaming");
    await setRun(page, { textComplete: true });
    await setRun(page, {
      state: "failed",
      endedAt: Date.now(),
      error: { message: "The provider went away.", kind: "provider" },
    });
    await expect(page.getByTestId("turn-error")).toBeVisible();
    await expect(page.getByTestId("incomplete")).toHaveCount(0);
  });

  test("F-433: the caret follows the last character when the reply ends with a list", async ({
    page,
  }) => {
    await open(page, "run-streaming");
    await setRun(page, { text: "Two folders were skipped:\n\n- photos\n- videos" });
    const bubble = page.getByTestId("live-turn").locator(".bubble");
    await expect(bubble.locator("li").last()).toHaveText("videos");
    const caret = await bubble
      .locator("li")
      .last()
      .evaluate((li) => {
        const after = getComputedStyle(li, "::after");
        return { content: after.content, width: after.width, display: after.display };
      });
    expect(caret).toEqual({ content: '""', width: "2px", display: "inline-block" });
    // The stand-in caret after the block is not drawn.
    await expect(bubble.locator(".stream-caret")).toBeHidden();
    // A paragraph ending carries it the same way.
    await setRun(page, { text: "The backup finished at 02:14." });
    expect(
      await bubble
        .locator(".md > p")
        .last()
        .evaluate((p) => getComputedStyle(p, "::after").width),
    ).toBe("2px");
  });

  test("F-433: a reply cut off by a stop or a failure keeps its text, captioned Incomplete", async ({
    page,
  }) => {
    for (const scene of ["run-stopped", "run-failed"]) {
      await open(page, scene);
      const reply = page.getByTestId("live-turn");
      await expect(reply).toContainText("Two folders were skipped because they were");
      await expect(reply.getByTestId("incomplete")).toHaveText("Incomplete");
    }
  });
});

test.describe("Stop", () => {
  test("F-097: Stop sits beside Send; Cmd/Ctrl+. stops; Stopping… replaces it, then the run ends as stopped", async ({
    page,
  }) => {
    await open(page, "run-working");
    await expect(page.getByRole("button", { name: "Stop Otto" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Request a steer" })).toBeVisible();
    await page.getByTestId("transcript").focus();
    await answers(page, "hold");
    await page.keyboard.press("ControlOrMeta+.");
    await expect(page.getByTestId("status-phrase")).toHaveText("Stopping…");
    await expect(page.getByRole("button", { name: "Stop Otto" })).toHaveCount(0);
    await expect(page.locator(".composer-status")).toHaveText("Stopping…");
    await answers(page, "release");
    await expect(page.getByTestId("stop-note")).toContainText("Completed actions are not undone.");
    await expect(page.getByTestId("status-line")).toHaveCount(0);
    await expect(announcer(page)).toHaveText("Stopped");
  });

  test("F-299: the stop note says how long the run took and that completed actions are not undone", async ({
    page,
  }) => {
    await open(page, "run-stopped");
    await expect(page.getByTestId("stop-note")).toHaveText(
      "Stopped after 40s. Completed actions are not undone.",
    );
    await open(page, "run-stopped-elsewhere");
    await expect(page.getByTestId("stop-note")).toContainText(
      "with no local Stop confirmed. Completed actions are not undone.",
    );
  });

  test("F-299: after a stop, completed actions and their results stay in the transcript, under the note", async ({
    page,
  }) => {
    await open(page, "run-stopped");
    // History now holds the stopped turn: its message, and a tool call that completed with its result.
    await page.evaluate(() => {
      const fixture = (
        window as unknown as {
          clawtrateFixture: { setState: (f: (s: ClawtrateState) => ClawtrateState) => void };
        }
      ).clawtrateFixture;
      fixture.setState((state) => {
        const key = "agent:otto:disk-space";
        const transcript = state.transcripts[key]!;
        const at = Date.now();
        return {
          ...state,
          transcripts: {
            ...state.transcripts,
            [key]: {
              ...transcript,
              outbox: [],
              items: [
                ...transcript.items,
                {
                  id: "h-ask",
                  role: "user",
                  timestamp: at - 40_000,
                  blocks: [
                    { kind: "text", text: "Can you check the backup log from last night too?" },
                  ],
                  model: null,
                },
                {
                  id: "h-work",
                  role: "assistant",
                  timestamp: at - 30_000,
                  blocks: [
                    {
                      kind: "tool-call",
                      callId: "call-read-1",
                      name: "read",
                      argumentsText: '{\n  "path": "/var/log/backup/backup-2026-11-15.log"\n}',
                      result: { isError: false, text: "02:14 backup finished, 41 GB written" },
                    },
                    { kind: "text", text: "The backup finished at 02:14 and wrote 41 GB." },
                  ],
                  model: null,
                },
              ],
              runs: transcript.runs.map((run) => ({
                ...run,
                messageId: null,
                anchorItemId: "h-ask",
              })),
            },
          },
        };
      });
    });
    await expect(page.getByTestId("stop-note")).toContainText("Completed actions are not undone.");
    const turn = page.getByTestId("transcript-turn").filter({ hasText: "wrote 41 GB" }).last();
    const call = turn.getByTestId("tool-call");
    await expect(call.locator(":scope > summary")).toHaveAccessibleName(
      /^Read backup-2026-11-15\.log/,
    );
    await call.locator("summary").click();
    await expect(call).toContainText("02:14 backup finished, 41 GB written");
    await expect(page.locator(".transcript")).toContainText(
      "The backup finished at 02:14 and wrote 41 GB.",
    );
  });

  test("F-419: a run that completed before Stop took effect says so", async ({ page }) => {
    await open(page, "run-finished-before-stop");
    await expect(page.getByTestId("stop-note")).toHaveText(
      "Finished before Stop took effect. The turn completed normally.",
    );
    await expect(page.getByTestId("incomplete")).toHaveCount(0);
  });

  test("F-100: a run Clawtrate stopped at its time limit ends with a card naming the limit and who stopped it", async ({
    page,
  }) => {
    await open(page, "run-turn-limit");
    const card = page.getByTestId("turn-error");
    await expect(card).toContainText("Otto's turn reached its 50 minute limit");
    await expect(card).toContainText(
      "Clawtrate stopped it at the Turn time limit in Settings, and the gateway confirmed.",
    );
    await expect(card).not.toContainText("The gateway ended the turn");
  });
});

test.describe("steering, queueing and holding", () => {
  test("F-096: a message sent while the run works is a steer, captioned Steer", async ({
    page,
  }) => {
    await open(page, "run-working");
    await field(page).fill("Skip the photos folder");
    await expect(page.getByRole("button", { name: "How to send: Steer" })).toBeVisible();
    await page.keyboard.press("Enter");
    const steer = page.getByTestId("outgoing").filter({ hasText: "Skip the photos folder" });
    await expect(steer.locator(".msg-caption")).toHaveText("Steer requested");
  });

  test("F-101: a run stopped after three tool calls in a row timed out says so, in the stop note's form", async ({
    page,
  }) => {
    await open(page, "run-stopped-timeouts");
    const note = page.getByTestId("stop-note");
    await expect(note.locator("b")).toHaveText("Stopped after 3 tool calls in a row timed out.");
    await expect(note).toContainText("The machine Otto works on may not be responding.");
    await expect(note.locator(".glyph")).toHaveAttribute("data-state", "stopped");
  });

  test("F-296: when some of the run's actions are no longer kept, the Stop note says other bots' work may continue", async ({
    page,
  }) => {
    await open(page, "run-stopped-with");
    const note = page.getByTestId("stop-note");
    await expect(note).not.toContainText("Some actions are no longer shown.");
    await setRun(page, { omittedTools: 3 });
    await expect(note).toContainText(
      "Some actions are no longer shown. Other bots' work may continue.",
    );
  });

  test("F-298 F-296: after a Stop the note lists what stopped with the run, named, and what may not have been delivered", async ({
    page,
  }) => {
    await open(page, "run-stopped-with");
    const note = page.getByTestId("stop-note");
    await expect(note.locator("p")).toContainText("Completed actions are not undone.");
    await expect(note.getByTestId("stopped-with").getByRole("listitem")).toHaveText([
      "Stopped with it: 1 helper run and Marlow's run for this message.",
      "The message to Pip may or may not have been delivered.",
    ]);
    // A plain stop claims nothing more.
    await open(page, "run-stopped");
    await expect(page.getByTestId("stop-note")).toBeVisible();
    await expect(page.getByTestId("stopped-with")).toHaveCount(0);
  });

  test("F-097: with two runs active and nothing tying them, Stop is not offered, and a typed Stop now keeps the words", async ({
    page,
  }) => {
    await open(page, "run-working");
    await expect(page.getByRole("button", { name: "Stop Otto" })).toBeVisible();
    // A second run beside it, as after a reconnect that missed the first one's end.
    await page.evaluate(() => {
      const fixture = (
        window as unknown as {
          clawtrateFixture: { setState: (f: (s: ClawtrateState) => ClawtrateState) => void };
        }
      ).clawtrateFixture;
      fixture.setState((state) => {
        const key = "agent:otto:disk-space";
        const transcript = state.transcripts[key]!;
        const first = transcript.runs.find((run: Run) => run.id === "run-live")!;
        return {
          ...state,
          transcripts: {
            ...state.transcripts,
            [key]: {
              ...transcript,
              runs: [...transcript.runs, { ...first, id: "run-current", steps: [] }],
            },
          },
        };
      });
    });
    await expect(page.getByRole("button", { name: "Stop Otto" })).toHaveCount(0);
    await field(page).fill("Stop now");
    await page.keyboard.press("Enter");
    await expect(page.locator(".composer-shelf [role=alert]")).toContainText(
      "Couldn't ask for Stop.",
    );
    await expect(field(page)).toHaveValue("Stop now");
  });

  test("F-097: a typed Stop now during a run stops it as Stop does, and is not sent as words", async ({
    page,
  }) => {
    await open(page, "run-working");
    await answers(page, "hold");
    await field(page).fill("Stop now.");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("status-phrase")).toHaveText("Stopping…");
    await expect(page.getByRole("button", { name: "Stop Otto" })).toHaveCount(0);
    await expect(field(page)).toHaveValue("");
    await expect(page.getByTestId("outgoing").filter({ hasText: "Stop now" })).toHaveCount(0);
    await expect(announcer(page)).toHaveText("Stopping");
    await answers(page, "release");
    await expect(page.getByTestId("stop-note")).toContainText("Completed actions are not undone.");
    // With no run, the same words are an ordinary message.
    await field(page).fill("Stop now");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("outgoing").filter({ hasText: "Stop now" })).toHaveCount(1);
  });

  test("F-061: the mode word's menu is keyboard operable; Queue after this turn queues as a shelf row", async ({
    page,
  }) => {
    await open(page, "run-working");
    await field(page).fill("Then send me a summary");
    const word = page.getByRole("button", { name: "How to send: Steer" });
    await word.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu", { name: "How to send" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitemradio", { name: /Request a steer/ })).toBeFocused();
    await expect(menu.getByRole("menuitemradio", { name: /Request a steer/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(word).toBeFocused();
    await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "How to send: Queue" })).toBeVisible();
    await field(page).focus();
    await page.keyboard.press("Enter");
    const row = page.getByTestId("shelf-row");
    await expect(row).toContainText("Queued");
    await expect(row).toContainText("Then send me a summary");
    await expect(page.getByTestId("outgoing").filter({ hasText: "Then send me" })).toHaveCount(0);
    await expect(announcer(page)).toHaveText("Queued");
  });

  test("F-061: Alt+Enter queues one message without changing the mode", async ({ page }) => {
    await open(page, "run-working");
    await field(page).fill("Queue just this one");
    await page.keyboard.press("Alt+Enter");
    await expect(page.getByTestId("shelf-row")).toContainText("Queue just this one");
    await field(page).fill("x");
    await expect(page.getByRole("button", { name: "How to send: Steer" })).toBeVisible();
  });

  test("F-280 F-281: Send now steers a queued message into the run; Cancel removes another, which never runs", async ({
    page,
  }) => {
    await open(page, "run-queued");
    const row = page.getByTestId("shelf-row");
    await row.getByRole("button", { name: "Send now" }).click();
    await expect(row).toHaveCount(0);
    const sent = page.getByTestId("outgoing").filter({ hasText: "Then send me a summary." });
    await expect(sent.locator(".msg-caption")).toHaveText("Steer requested");

    await open(page, "run-queued");
    await page.getByTestId("shelf-row").getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("shelf-row")).toHaveCount(0);
    await expect(page.getByTestId("outgoing").filter({ hasText: "Then send me" })).toHaveCount(0);
  });

  test("F-468: after a confirmed Stop a queued message stays on the shelf, Not sent, until Send or Remove", async ({
    page,
  }) => {
    await open(page, "run-working");
    await field(page).fill("Then send me a summary.");
    await page.keyboard.press("Alt+Enter");
    await expect(page.getByTestId("shelf-row")).toContainText("Queued");
    await page.getByRole("button", { name: "Stop Otto" }).click();
    await expect(page.getByTestId("stop-note")).toBeVisible();
    // Nothing starts by itself.
    const row = page.getByTestId("shelf-row");
    await expect(row).toContainText("Not sent");
    await expect(row).toContainText("Then send me a summary.");
    await expect(page.getByTestId("status-line")).toHaveCount(0);
    await expect(page.getByTestId("outgoing").filter({ hasText: "Then send me" })).toHaveCount(0);
    await row.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByTestId("shelf-row")).toHaveCount(0);
    await expect(page.getByTestId("outgoing").filter({ hasText: "Then send me" })).toHaveCount(1);
    await expect(page.getByTestId("status-line")).toBeVisible();

    await open(page, "stopped-not-sent");
    await page.getByTestId("shelf-row").getByRole("button", { name: "Remove" }).click();
    await expect(page.getByTestId("shelf-row")).toHaveCount(0);
    await expect(field(page)).toBeFocused();
  });

  test("F-061: a queued message the gateway refused to start stays on the shelf: Couldn't start, Try again, Delete", async ({
    page,
  }) => {
    await open(page, "queued-refused");
    const row = page.getByTestId("shelf-row");
    await expect(row).toHaveAttribute("data-tone", "danger");
    await expect(row).toContainText("Couldn't start");
    await expect(row).toContainText("the session's budget is used up");
    await expect(page.getByTestId("outgoing")).toHaveCount(0);
    await row.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("shelf-row")).toHaveCount(0);
    await expect(page.getByTestId("outgoing")).toHaveCount(1);
    await open(page, "queued-refused");
    await page.getByTestId("shelf-row").getByRole("button", { name: "Delete" }).click();
    await expect(page.getByTestId("shelf-row")).toHaveCount(0);
  });

  test("F-421: a message sent while the run is stopping is queued, with no Send now", async ({
    page,
  }) => {
    await open(page, "run-stopping");
    await expect(field(page)).toHaveAttribute("placeholder", "Queue a message for Otto");
    await field(page).fill("Try again afterwards");
    await page.keyboard.press("Enter");
    const rows = page.getByTestId("shelf-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.last()).toContainText("Try again afterwards");
    await expect(page.getByRole("button", { name: "Send now" })).toHaveCount(0);
  });

  test("F-468: while a question is pending every message is held, never offered Send now, and Edit takes it back without losing the draft", async ({
    page,
  }) => {
    await open(page, "run-question");
    await expect(page.getByTestId("status-phrase")).toHaveText("Waiting for you");
    await field(page).fill("Keep the yearly ones too");
    await expect(page.getByRole("button", { name: "How to send: Hold" })).toBeVisible();
    await expect(page.getByTestId("needs-you")).toHaveText(
      "Otto asked a question. A message sent now is held until you answer.Review",
    );
    await expect(page.getByRole("button", { name: "Hold until you answer" })).toBeVisible();
    await page.keyboard.press("Enter");
    const held = page.getByTestId("shelf-row").filter({ hasText: "Held until you answer" });
    await expect(held).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Send now" })).toHaveCount(0);
    await expect(page.getByTestId("outgoing").filter({ hasText: "yearly" })).toHaveCount(0);

    await field(page).fill("A draft in progress");
    await held.first().getByRole("button", { name: "Edit" }).click();
    await expect(field(page)).toHaveValue(
      "A draft in progress\nAlso keep anything from this month.",
    );
    // Its file comes back with it, as one record.
    await expect(page.locator(".attachments .chip")).toHaveText([/keep-list\.txt/]);
    await expect(held).toHaveCount(1);
  });

  test("F-468: Alt+Enter while a question is pending holds the message too", async ({ page }) => {
    await open(page, "run-question");
    await field(page).fill("Queue this after the turn");
    await page.keyboard.press("Alt+Enter");
    const held = page.getByTestId("shelf-row").filter({ hasText: "Queue this after the turn" });
    await expect(held).toContainText("Held until you answer");
    await expect(held.getByRole("button", { name: "Send now" })).toHaveCount(0);
    await expect(announcer(page)).toHaveText("Held until you answer");
  });

  test("F-282: Start as new task runs the message in a new task and keeps this one open", async ({
    page,
  }) => {
    await open(page, "run-working");
    await field(page).fill("Look at the printer instead");
    await page.keyboard.press("ControlOrMeta+Shift+Enter");
    await expect(announcer(page)).toHaveText("Started as a new task");
    await expect(field(page)).toHaveValue("");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Disk almost full on the media box",
    );
  });
});

test.describe("keyboard", () => {
  test("F-072: inside a pending approval or question card Cmd/Ctrl+Enter answers that card and sends nothing; outside it, it sends", async ({
    page,
  }) => {
    const record = () =>
      page.evaluate(() => {
        const w = window as unknown as {
          clawtrateFixture: Record<string, (command: unknown) => Promise<unknown>>;
          sent: Array<{ type: string }>;
        };
        w.sent = [];
        const fixture = w.clawtrateFixture;
        const invoke = fixture.invoke!.bind(fixture);
        const send = fixture.send!.bind(fixture);
        fixture.invoke = (command) => (w.sent.push(command as { type: string }), invoke(command));
        fixture.send = (command) => (w.sent.push(command as { type: string }), send(command));
      });
    const types = () =>
      page.evaluate(() =>
        (window as unknown as { sent: Array<{ type: string }> }).sent.map((each) => each.type),
      );

    // An approval: ⌘↵ on its Deny button is Allow once, and the draft stays unsent.
    await openFixture(page, "scene=approval-pending&panel=closed", "light");
    await record();
    await field(page).fill("A draft that must not go");
    const approval = page.getByTestId("approval-card");
    await approval.getByRole("button", { name: "Deny" }).focus();
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(approval.locator(".tag")).toHaveText("Allowed once");
    expect(await types()).toEqual(["resolveApproval"]);
    await expect(field(page)).toHaveValue("A draft that must not go");
    await expect(page.getByTestId("outgoing")).toHaveCount(0);

    // A question: ⌘↵ inside the card sends its answer, not the draft.
    await openFixture(page, "scene=question-single&panel=closed", "light");
    await record();
    await field(page).fill("Another draft that stays");
    const question = page.getByTestId("question-card");
    await question.getByRole("radio").first().click();
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(question).toHaveAttribute("data-state", "answered");
    expect(await types()).toEqual(["answerQuestion"]);
    await expect(field(page)).toHaveValue("Another draft that stays");

    // Outside any card the same keys send the draft.
    await page.getByTestId("transcript").focus();
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(field(page)).toHaveValue("");
    expect(await types()).toEqual(["answerQuestion", "sendMessage"]);
  });

  test("F-097 F-102: focus is never left on a control that has gone", async ({ page }) => {
    await open(page, "run-working");
    await page.getByRole("button", { name: "Stop Otto" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Stop Otto" })).toHaveCount(0);
    await expect(field(page)).toBeFocused();

    await open(page, "run-queued");
    await page.getByTestId("shelf-row").getByRole("button", { name: "Cancel" }).focus();
    await page.keyboard.press("Enter");
    await expect(field(page)).toBeFocused();

    await open(page, "run-failed");
    await page.getByRole("button", { name: "Dismiss this error" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("turn-error-line")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Dismiss this error" })).toBeFocused();
  });

  test("F-075 F-089: focus moves to the field when a failed message's Delete or Resend, or the status line, goes", async ({
    page,
  }) => {
    await open(page, "send-failed");
    await page.getByTestId("outgoing").getByRole("button", { name: "Delete" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("outgoing")).toHaveCount(0);
    await expect(field(page)).toBeFocused();

    await open(page, "send-failed");
    await page.getByTestId("outgoing").getByRole("button", { name: "Resend" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("outgoing").getByRole("button", { name: "Resend" })).toHaveCount(
      0,
    );
    await expect(field(page)).toBeFocused();

    await open(page, "run-working");
    await page.getByTestId("status-line").focus();
    await setRun(page, { state: "completed", textComplete: true, endedAt: Date.now() });
    await expect(page.getByTestId("status-line")).toHaveCount(0);
    await expect(field(page)).toBeFocused();
  });

  test("F-282 F-072: with no run, Shift+F10 on Send opens its menu: Send and Start as new task", async ({
    page,
  }) => {
    await open(page, "composer");
    await field(page).fill("Start this somewhere new");
    await page.getByRole("button", { name: "Send", exact: true }).focus();
    await page.keyboard.press("Shift+F10");
    const menu = page.getByRole("menu", { name: "How to send" });
    await expect(menu.getByRole("menuitem")).toHaveText(["Send↵", "Start as new task⇧⌘↵"]);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(announcer(page)).toHaveText("Started as a new task");
  });
});

test("F-467: Cmd/Ctrl+/ shows every keyboard shortcut; Escape closes the list and returns focus", async ({
  page,
}) => {
  await open(page, "composer");
  await field(page).focus();
  await page.keyboard.press("ControlOrMeta+/");
  const list = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(list).toBeFocused();
  for (const keys of [
    "↵",
    "⇧↵",
    "⌥↵",
    "⇧⌘↵",
    "⌘↵",
    "⌘.",
    "⌘J",
    "⌘I",
    "⌘L",
    "⌘F",
    "⇧⌘F",
    "⌘1–9",
    "⌥↑ ⌥↓",
    "⌃Tab",
    "⌘\\",
    "⌘,",
    "⌘/",
  ]) {
    await expect(list.locator("kbd", { hasText: keys }).first()).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
  await expect(field(page)).toBeFocused();
});

test.describe("access", () => {
  test("F-456: Request access asks once, shows the host's command and request id, and is never made silently", async ({
    page,
  }) => {
    await open(page, "main");
    const bar = page.getByRole("region", { name: "Access" });
    await expect(bar).toContainText(
      "Read-only. You can follow Otto's work here. Approvals and questions aren't shown on this connection.",
    );
    await expect(page.getByTestId("composer-input")).toHaveCount(0);
    await bar.getByRole("button", { name: "Request access" }).click();
    await expect(bar).toContainText("Waiting for approval.");
    await expect(bar.locator(".command code")).toHaveText(
      "openclaw devices approve 7c41d09e-52b3-4e8a-9f10-3d6b2a7e9c41",
    );
    await expect(bar).toContainText("Request 7c41d09e");
    // An address route: the gateway's answer is waited for continuously, with no countdown and
    // no Check now, since the host has nothing to look at there; Stop waiting stops this
    // device's wait, and nothing offers to cancel the request (§9).
    await expect(bar.getByTestId("access-wait")).toHaveText(
      "This changes by itself as soon as the owner approves or denies the request, or it expires.",
    );
    await expect(bar.getByRole("button", { name: /Cancel request/ })).toHaveCount(0);
    await expect(bar.getByRole("button", { name: "Check now" })).toHaveCount(0);
    await expect(bar.getByTestId("access-next")).toHaveCount(0);
    await expect(bar.getByRole("button", { name: "Stop waiting" })).toBeVisible();
    await expect(bar.getByRole("button", { name: "Copy approve command" })).toBeVisible();
    await expect(bar.getByRole("button", { name: "Copy request id" })).toBeVisible();
    await expect(announcer(page)).toHaveText("Access requested");
  });

  test("F-456: denied and expired requests keep the read tier and offer to ask again", async ({
    page,
  }) => {
    await open(page, "access-denied");
    await expect(page.getByRole("region", { name: "Access" })).toContainText(
      "The request was denied. Nothing changed. This device can still read.",
    );
    await expect(page.getByRole("button", { name: "Request again" })).toBeVisible();
    await open(page, "access-expired");
    await expect(page.getByRole("region", { name: "Access" })).toContainText(
      "The request expired before it was approved.",
    );
    await expect(page.getByRole("button", { name: "Request again" })).toBeVisible();
  });

  test("F-456: when access arrives the composer takes the bar's place and the strip says Access granted", async ({
    page,
  }) => {
    await open(page, "access-granted");
    // The scene grants access 300 ms after it opens, and the request's controls go with
    // it. Focus one if it is still there; on a loaded machine it may already be gone.
    await page
      .getByRole("button", { name: "Copy request id" })
      .focus({ timeout: 200 })
      .catch(() => {});
    await expect(page.getByTestId("status-strip")).toContainText(
      "Access granted· you can send, stop and answer",
    );
    await expect(page.getByRole("region", { name: "Access" })).toHaveCount(0);
    await expect(field(page)).toBeVisible();
    await expect(announcer(page)).toHaveText("You can now send, stop and answer");
  });

  test("F-456: while a bot waits on the read tier, a note says this device can't see what it waits for, with Request access", async ({
    page,
  }) => {
    await open(page, "read-wait");
    const note = page.getByTestId("read-only-wait");
    await expect(note).toContainText(
      "Otto is waiting for an approval or an answer. This device can't see it on a read-only connection.",
    );
    // Above the status line, which says what it can.
    const order = await page.evaluate(() => {
      const note = document.querySelector("[data-testid=read-only-wait]")!;
      const line = document.querySelector("[data-testid=status-line]")!;
      return note.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING;
    });
    expect(order).toBeTruthy();
    await note.getByRole("button", { name: "Request access" }).click();
    await expect(page.getByRole("region", { name: "Access" })).toContainText(
      "Waiting for approval.",
    );
  });

  test("a host pinned to the read tier never offers to ask for access", async ({ page }) => {
    await open(page, "access-pinned");
    await expect(page.getByRole("region", { name: "Access" })).toContainText("Read-only.");
    await expect(page.getByRole("button", { name: "Request access" })).toHaveCount(0);
  });
});

test.describe("errors and resync", () => {
  test("F-102: a failed turn shows its card; Dismiss folds it to a line that opens it again; Try again sends the message", async ({
    page,
  }) => {
    await open(page, "run-failed");
    const card = page.getByRole("alert").filter({ hasText: "Otto couldn't finish this turn" });
    await expect(card).toContainText("The model provider is overloaded.");
    // A warning triangle, a bold title, the reason on its own line, and a round close button.
    await expect(card.locator(":scope > svg.icon")).toBeVisible();
    expect(
      Number(
        await card.locator(".turn-error-title").evaluate((el) => getComputedStyle(el).fontWeight),
      ),
    ).toBeGreaterThanOrEqual(600);
    await expect(card.locator(".turn-error-reason")).toHaveText(/overloaded/);
    const close = card.getByRole("button", { name: "Dismiss this error" });
    const round = await close.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return Number.parseFloat(getComputedStyle(el).borderTopLeftRadius) >= rect.width / 2 - 0.5;
    });
    expect(round).toBe(true);
    await card.getByRole("button", { name: "Dismiss this error" }).click();
    await expect(card).toHaveCount(0);
    await page.getByTestId("turn-error-line").click();
    await expect(page.getByTestId("turn-error")).toBeVisible();
    await page.getByTestId("turn-error").getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("status-line")).toBeVisible();
  });

  test("F-301: a failure's Raw is not in the state the window holds until it is opened", async ({
    page,
  }) => {
    await open(page, "run-failed");
    const held = () =>
      page.evaluate(() =>
        JSON.stringify(
          (
            window as unknown as { clawtrateFixture: { getState: () => unknown } }
          ).clawtrateFixture.getState(),
        ),
      );
    // The event's own fields, such as its sequence number, are not in the state.
    expect(await held()).not.toContain('"seq":14');
    expect(await held()).toContain('"holds":"chat-event"');
  });

  test("F-301: Copy request ID puts exactly the request id that Raw shows on the clipboard, and says so", async ({
    page,
  }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await open(page, "run-failed");
    const card = page.getByTestId("turn-error");
    const raw = card.getByRole("button", { name: "Raw" });
    await expect(raw).toHaveAttribute("aria-expanded", "false");
    await raw.click();
    await expect(raw).toHaveAttribute("aria-expanded", "true");
    const shown = (await card.getByTestId("request-id").textContent())!;
    expect(shown).toBe("b3f0c2a1-4d5e-4f60-8a71-92c3d4e5f607");
    // Raw is read when it is opened, and labelled as exactly what it holds.
    await expect(card.getByTestId("turn-error-raw")).toContainText(
      "The chat event that ended the turn, as received",
    );
    await expect(card.getByTestId("run-raw")).toContainText('"errorKind": "provider"');
    await page.evaluate(() => navigator.clipboard.writeText("something else"));
    await card.getByRole("button", { name: "Copy request ID" }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(shown);
    await expect(page.getByTestId("card-announcer")).toHaveText("Copied request ID");
    // A failure Clawtrate decided itself has no request of its own to copy.
    await open(page, "run-turn-limit");
    await expect(page.getByTestId("turn-error")).toBeVisible();
    await expect(
      page.getByTestId("turn-error").getByRole("button", { name: "Copy request ID" }),
    ).toHaveCount(0);
  });

  test("F-301: when the clipboard refuses, Copy request ID opens Raw with the request ID selected and the failure read", async ({
    page,
  }) => {
    await open(page, "run-failed");
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: () => Promise.reject(new Error("denied")) },
      });
      document.execCommand = () => false;
    });
    const card = page.getByTestId("turn-error");
    await card.getByRole("button", { name: "Copy request ID" }).click();
    await expect(page.getByTestId("card-announcer")).toHaveText(
      "Couldn't copy. The text is selected.",
    );
    await expect(card.getByRole("button", { name: "Raw" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString()))
      .toBe("b3f0c2a1-4d5e-4f60-8a71-92c3d4e5f607");
    // The failure itself is read too, as opening Raw reads it.
    await expect(card.getByTestId("run-raw")).toContainText('"errorKind": "provider"');
  });

  test("F-100 F-296: a run stopped at its turn limit says what happened to the other bots' runs it started", async ({
    page,
  }) => {
    await open(page, "run-turn-limit");
    await page.evaluate(() => {
      const fixture = (
        window as unknown as {
          clawtrateFixture: {
            setState: (f: (s: ClawtrateState) => ClawtrateState) => void;
          };
        }
      ).clawtrateFixture;
      fixture.setState((state) => {
        const key = "agent:otto:disk-space";
        const transcript = state.transcripts[key]!;
        return {
          ...state,
          transcripts: {
            ...state.transcripts,
            [key]: {
              ...transcript,
              runs: transcript.runs.map((run) => ({
                ...run,
                omittedTools: 2,
                stoppedWith: {
                  helpers: 0,
                  bots: [],
                  uncertain: [],
                  refused: ["agent:marlow:main"],
                  unanswered: [],
                  omitted: 0,
                  recipientsAsked: true,
                },
              })),
            },
          },
        };
      });
    });
    const card = page.getByTestId("turn-error");
    await expect(card).toContainText("turn reached its");
    await expect(card.getByTestId("stopped-with")).toHaveText(
      "The gateway refused to stop Marlow's run for this message.",
    );
    await expect(card).toContainText(
      "Some actions are no longer shown. Other bots' work may continue.",
    );
  });

  test("F-102: Try again sends the failed turn's message again with its files", async ({
    page,
  }) => {
    await open(page, "run-failed");
    await page.evaluate(() => {
      const fixture = (
        window as unknown as {
          clawtrateFixture: {
            setState: (f: (s: ClawtrateState) => ClawtrateState) => void;
          };
        }
      ).clawtrateFixture;
      fixture.setState((state) => {
        const key = "agent:otto:disk-space";
        const transcript = state.transcripts[key]!;
        return {
          ...state,
          transcripts: {
            ...state.transcripts,
            [key]: {
              ...transcript,
              outbox: transcript.outbox.map((each) => ({
                ...each,
                attachments: [{ fileName: "backup.log", mimeType: "text/plain", sizeBytes: 900 }],
              })),
            },
          },
        };
      });
    });
    await page.getByTestId("turn-error").getByRole("button", { name: "Try again" }).click();
    const again = page.getByTestId("outgoing");
    await expect(again).toHaveCount(2);
    await expect(again.last()).toContainText("Can you check the backup log from last night too?");
    await expect(again.last()).toContainText("backup.log");
  });

  test("F-103 F-300: errors collect above the composer, each can be dismissed, and Clear all clears them", async ({
    page,
  }) => {
    await open(page, "stop-failed");
    const notices = page.getByRole("group", { name: "Notifications" }).getByRole("alert");
    await expect(notices).toHaveCount(1);
    await expect(notices).toContainText("Couldn't stop Otto.");
    await notices.getByRole("button", { name: "Dismiss" }).click();
    await expect(notices).toHaveCount(0);

    await open(page, "stop-failed");
    // A second error: a message too long for the gateway.
    await field(page).fill("x");
    await page.evaluate(() => {
      const fixture = (window as unknown as { clawtrateFixture: { invoke: unknown } })
        .clawtrateFixture as { invoke: (c: unknown) => Promise<unknown> };
      const original = fixture.invoke;
      fixture.invoke = (command: unknown) =>
        (command as { type: string }).type === "sendMessage"
          ? Promise.reject(new Error("The message is too long."))
          : original(command);
    });
    await page.keyboard.press("Enter");
    await expect(notices).toHaveCount(2);
    await expect(notices.last()).toContainText(
      "Couldn't send this message. The message is too long.",
    );
    await page.getByRole("button", { name: "Clear all" }).click();
    await expect(notices).toHaveCount(0);
  });

  test("F-103: a notice belongs to its task: another task does not show it, and it is there on return", async ({
    page,
  }) => {
    await open(page, "composer");
    await page.evaluate(() => {
      const fixture = (
        window as unknown as {
          clawtrateFixture: { invoke: (c: unknown) => Promise<unknown> };
        }
      ).clawtrateFixture;
      const original = fixture.invoke.bind(fixture);
      fixture.invoke = (command: unknown) =>
        (command as { type: string }).type === "sendMessage"
          ? Promise.reject(new Error("The message is too long."))
          : original(command);
    });
    await field(page).fill("Too long for the gateway");
    await page.keyboard.press("Enter");
    const notices = page.getByRole("group", { name: "Notifications" });
    await expect(notices.getByRole("alert")).toContainText("Couldn't send this message.");
    await page.getByTestId("task").filter({ hasText: "Weekly backup check" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Weekly backup check" }),
    ).toBeVisible();
    await expect(page.getByRole("group", { name: "Notifications" })).toHaveCount(0);
    await page.getByTestId("task").filter({ hasText: "Disk almost full" }).click();
    await expect(notices.getByRole("alert")).toContainText("Couldn't send this message.");
  });

  test("F-104: while the connection is lost nothing moves, the status line says what was last seen, and the composer is offline", async ({
    page,
  }) => {
    await open(page, "offline-send");
    await expect(page.locator(".app")).toHaveAttribute("data-connection", "lost");
    await expect(page.getByTestId("status-phrase")).toHaveText(
      "Reconnecting. Last seen reading backup-2026-11-15.log",
    );
    const moving = await page.evaluate(() =>
      [...document.querySelectorAll(".presence, .presence svg, .status-phrase, .glyph")].some(
        (el) =>
          getComputedStyle(el).animationName !== "none" ||
          getComputedStyle(el, "::before").animationName !== "none",
      ),
    );
    expect(moving).toBe(false);
    await expect(page.locator(".status-elapsed")).toHaveCount(0);
    await expect(page.getByTestId("status-strip")).toContainText("Reconnecting");
  });

  test("F-104: back on the connection but not yet caught up, live work stays last seen until the task reloads", async ({
    page,
  }) => {
    await open(page, "run-working");
    const set = (patch: "drop" | "hello" | "loaded") =>
      page.evaluate((step) => {
        const fixture = (
          window as unknown as {
            clawtrateFixture: { setState: (f: (s: ClawtrateState) => ClawtrateState) => void };
          }
        ).clawtrateFixture;
        fixture.setState((state) => {
          const key = "agent:otto:disk-space";
          if (step === "drop")
            return {
              ...state,
              connection: {
                ...state.connection,
                status: "reconnecting",
                retryAt: Date.now() + 4000,
              },
            };
          if (step === "hello")
            return {
              ...state,
              connection: {
                ...state.connection,
                status: "connected",
                retryAt: null,
                connectedAt: Date.now() + 5,
              },
              discovery: { ...state.discovery, status: "loading" },
            };
          return {
            ...state,
            discovery: { ...state.discovery, status: "ready" },
            transcripts: {
              ...state.transcripts,
              [key]: { ...state.transcripts[key]!, loadedAt: Date.now() + 10 },
            },
          };
        });
      }, patch);
    await set("drop");
    await expect(page.locator(".app")).toHaveAttribute("data-connection", "lost");
    await set("hello");
    await expect(page.getByTestId("status-strip")).toContainText("catching up");
    // Connected is not caught up: nothing moves, the line and the composer stay as they were.
    await expect(page.locator(".app")).toHaveAttribute("data-connection", "lost");
    await expect(page.getByTestId("status-phrase")).toHaveText(
      "Reconnecting. Last seen reading backup-2026-11-15.log",
    );
    await expect(page.locator(".status-elapsed")).toHaveCount(0);
    await expect(field(page)).toHaveAttribute(
      "placeholder",
      "Offline. Messages send when you reconnect.",
    );
    expect(
      await page
        .locator(".status-line .presence")
        .evaluate((el) => getComputedStyle(el, "::before").animationName),
    ).toBe("none");
    await set("loaded");
    await expect(page.getByTestId("status-strip")).toContainText("Synced");
    await expect(page.locator(".app")).not.toHaveAttribute("data-connection", "lost");
    await expect(page.getByTestId("status-phrase")).toHaveText("Reading backup-2026-11-15.log");
    await expect(field(page)).toHaveAttribute("placeholder", "Message Otto");
  });

  test("F-107: after a reconnect the conversation catches up without showing a message twice", async ({
    page,
  }) => {
    await open(page, "run-working");
    await expect(page.getByTestId("outgoing")).toHaveCount(1);
    await page.evaluate(() => {
      const fixture = (
        window as unknown as {
          clawtrateFixture: { setState: (f: (s: ClawtrateState) => ClawtrateState) => void };
        }
      ).clawtrateFixture;
      fixture.setState((state) => ({
        ...state,
        connection: { ...state.connection, status: "reconnecting", retryAt: Date.now() + 4000 },
      }));
    });
    await expect(page.getByTestId("status-strip")).toContainText("Reconnecting");
    await page.evaluate(() => {
      const fixture = (
        window as unknown as {
          clawtrateFixture: { setState: (f: (s: ClawtrateState) => ClawtrateState) => void };
        }
      ).clawtrateFixture;
      // History now holds the message: it leaves the outbox and the run is anchored to it.
      fixture.setState((state) => {
        const key = "agent:otto:disk-space";
        const transcript = state.transcripts[key]!;
        const sent = transcript.outbox[0]!;
        return {
          ...state,
          connection: { ...state.connection, status: "connected", connectedAt: Date.now() + 1 },
          transcripts: {
            ...state.transcripts,
            [key]: {
              ...transcript,
              loadedAt: Date.now() + 2,
              outbox: [],
              items: [
                ...transcript.items,
                {
                  id: "h-sent",
                  role: "user",
                  timestamp: Date.now(),
                  blocks: [{ kind: "text", text: sent.text }],
                  model: null,
                },
              ],
              runs: transcript.runs.map((run: Run) => ({
                ...run,
                messageId: null,
                anchorItemId: "h-sent",
              })),
            },
          },
        };
      });
    });
    await expect(page.getByTestId("status-strip")).toContainText("Synced");
    await expect(
      page.locator(".transcript").getByText("Can you check the backup log from last night too?"),
    ).toHaveCount(1);
    await expect(page.getByTestId("status-line")).toBeVisible();
    await settle(page);
  });
});

test.describe("the phone", () => {
  test.use(
    contextFor(
      SIZES.find((size) => size.phone)!,
      "light",
    ),
  );

  test("F-072: a conversation that is not on screen does not answer Cmd/Ctrl+Enter, Cmd/Ctrl+. or Cmd/Ctrl+J", async ({
    page,
  }) => {
    await open(page, "run-working");
    await field(page).fill("Not from the list");
    await page.getByRole("button", { name: "Back to bots" }).click();
    await expect(page.getByTestId("bot-list")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+Enter");
    await page.keyboard.press("ControlOrMeta+.");
    await page.waitForTimeout(200);
    await expect(page.getByTestId("outgoing").locator(".bubble")).toHaveText([
      "Can you check the backup log from last night too?",
    ]);
    await expect(page.getByTestId("status-phrase")).not.toHaveText("Stopping…");
    // Back on the conversation: the draft was not sent.
    await page.getByTestId("task").filter({ hasText: "Disk almost full" }).click();
    await expect(field(page)).toHaveValue("Not from the list");
  });

  test("F-072: under Settings the conversation does not answer Cmd/Ctrl+Enter", async ({
    page,
  }) => {
    await open(page, "composer");
    await field(page).fill("Not while Settings is open");
    await page.keyboard.press("ControlOrMeta+,");
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await page.keyboard.press("ControlOrMeta+Enter");
    await page.waitForTimeout(200);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
    await expect(page.getByTestId("outgoing")).toHaveCount(0);
    await expect(field(page)).toHaveValue("Not while Settings is open");
  });

  test("F-061 F-282: the Send menu opens as a sheet from the foot of the screen with 52 px rows, from the mode word or a long press on Send, and Escape returns focus", async ({
    page,
  }) => {
    await open(page, "run-working");
    await field(page).fill("Then look at the photos");
    await page.getByRole("button", { name: "How to send: Steer" }).tap();
    const sheet = page.getByTestId("send-sheet");
    await expect(sheet.getByRole("menu", { name: "How to send" })).toBeVisible();
    const box = (await sheet.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(Math.round(box.x)).toBe(0);
    expect(Math.round(box.width)).toBe(viewport.width);
    expect(Math.round(box.y + box.height)).toBe(viewport.height);
    for (const item of await sheet.getByRole("menuitemradio").all())
      expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(52);
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(page.getByRole("button", { name: "How to send: Steer" })).toBeFocused();

    // Touch and hold on Send opens the same sheet; the release does not send.
    const send = page.getByTestId("send");
    await send.dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true });
    await page.waitForTimeout(650);
    await send.dispatchEvent("pointerup", { pointerType: "touch", isPrimary: true });
    await send.dispatchEvent("click");
    await expect(sheet.getByRole("menuitemradio", { name: /Queue after this turn/ })).toBeVisible();
    await expect(page.getByTestId("outgoing")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(send).toBeFocused();
    await expect(field(page)).toHaveValue("Then look at the photos");
  });

  test("F-068: every control in the composer and the shelf has at least a 44 px hit area on touch", async ({
    page,
  }) => {
    await open(page, "run-queued");
    await field(page).fill("Something to send");
    const sizes = await page.evaluate(() =>
      [
        ...document.querySelectorAll<HTMLElement>(
          ".composer-box button, .shelf-row button, .access-bar button",
        ),
      ]
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const after = getComputedStyle(element, "::after");
          const extended = after.content !== "none" && after.position === "absolute";
          return {
            name: element.getAttribute("aria-label") ?? element.textContent ?? "",
            width: Math.max(rect.width, extended ? Number.parseFloat(after.width) : 0),
            height: Math.max(rect.height, extended ? Number.parseFloat(after.height) : 0),
          };
        }),
    );
    expect(sizes.length).toBeGreaterThan(4);
    expect(sizes.filter((each) => each.width < 44 || each.height < 44)).toEqual([]);
  });
});
