// The live conversation's fixture scenes, with what shows once each is
// ready and the parity rows it illustrates. Shared by the baseline and the
// legibility checks.
import { expect, type Page } from "@playwright/test";
import { paintedFinal } from "./fixture.ts";

/** Each scene, and what shows once it is ready. */
export const LIVE_VIEWS: Array<{
  scene: string;
  rows: string;
  ready: (page: Page) => Promise<void>;
}> = [
  {
    scene: "main",
    rows: "F-456",
    ready: (page) => expect(page.getByTestId("access-bar")).toContainText("Read-only."),
  },
  {
    scene: "access-asking",
    rows: "F-456",
    ready: (page) => expect(page.getByTestId("access-bar")).toContainText("Asking the gateway"),
  },
  {
    scene: "access-requested",
    rows: "F-456",
    ready: (page) => expect(page.getByTestId("access-bar")).toContainText("Waiting for approval"),
  },
  {
    scene: "access-denied",
    rows: "F-456",
    ready: (page) => expect(page.getByTestId("access-bar")).toContainText("denied"),
  },
  {
    scene: "access-expired",
    rows: "F-456",
    ready: (page) => expect(page.getByTestId("access-bar")).toContainText("expired"),
  },
  {
    scene: "access-error",
    rows: "F-456",
    ready: (page) =>
      expect(page.getByTestId("access-bar")).toContainText("Couldn't send the request"),
  },
  {
    scene: "access-pinned",
    rows: "",
    ready: (page) => expect(page.getByTestId("access-bar")).toContainText("Read-only."),
  },
  {
    scene: "access-granted",
    rows: "F-456",
    ready: (page) => expect(page.getByTestId("status-strip")).toContainText("Access granted"),
  },
  {
    scene: "read-wait",
    rows: "F-086",
    ready: (page) => expect(page.getByTestId("status-line")).toContainText("Waiting for an answer"),
  },
  {
    scene: "run-stopped-timeouts",
    rows: "F-101",
    ready: (page) => expect(page.getByTestId("stop-note")).toContainText("timed out"),
  },
  {
    scene: "run-stopped-with",
    rows: "F-298 F-296 F-297",
    ready: (page) => expect(page.getByTestId("stopped-with")).toBeVisible(),
  },
  {
    scene: "message-actions",
    rows: "F-283 F-067",
    ready: (page) => expect(page.getByTestId("reactions")).toBeVisible(),
  },
  {
    scene: "message-actions-read",
    rows: "F-283",
    ready: (page) => expect(page.getByTestId("reactions")).toBeVisible(),
  },
  {
    scene: "composer",
    rows: "F-068",
    ready: (page) => expect(page.getByTestId("composer-input")).toBeVisible(),
  },
  {
    scene: "run-thinking",
    rows: "F-081 F-085",
    ready: (page) => expect(page.getByTestId("status-line")).toContainText("Thinking"),
  },
  {
    scene: "run-working",
    rows: "F-082 F-086",
    ready: (page) => expect(page.getByTestId("status-line")).toContainText("Reading"),
  },
  {
    scene: "run-streaming",
    rows: "F-095 F-433",
    ready: (page) => expect(page.getByTestId("live-turn")).toBeVisible(),
  },
  {
    scene: "run-waiting",
    rows: "F-292",
    ready: (page) => expect(page.getByTestId("needs-you")).toBeVisible(),
  },
  {
    scene: "run-question",
    rows: "F-468",
    ready: (page) => expect(page.getByTestId("shelf-row")).toContainText("Held until you answer"),
  },
  {
    scene: "run-queued",
    rows: "F-061 F-096 F-280 F-281",
    ready: (page) => expect(page.getByTestId("shelf-row")).toContainText("Queued"),
  },
  {
    scene: "run-stopping",
    rows: "F-097 F-421",
    ready: (page) => expect(page.getByTestId("status-line")).toContainText("Stopping…"),
  },
  {
    scene: "run-stopped",
    rows: "F-097 F-299 F-433",
    ready: (page) => expect(page.getByTestId("stop-note")).toBeVisible(),
  },
  {
    scene: "run-stopped-elsewhere",
    rows: "F-097",
    ready: (page) =>
      expect(page.getByTestId("stop-note")).toContainText("with no local Stop confirmed."),
  },
  {
    scene: "run-finished-before-stop",
    rows: "F-419",
    ready: (page) => expect(page.getByTestId("stop-note")).toContainText("Finished before Stop"),
  },
  {
    scene: "run-failed",
    rows: "F-102 F-433",
    ready: (page) => expect(page.getByTestId("turn-error")).toBeVisible(),
  },
  {
    scene: "run-turn-limit",
    rows: "F-100",
    ready: (page) => expect(page.getByTestId("turn-error")).toContainText("50 minute limit"),
  },
  {
    scene: "stop-failed",
    rows: "F-103",
    ready: (page) => expect(page.getByRole("alert")).toContainText("Couldn't stop Otto."),
  },
  {
    scene: "send-failed",
    rows: "F-075",
    ready: (page) => expect(page.getByTestId("outgoing")).toContainText("Failed to send"),
  },
  {
    scene: "stopped-not-sent",
    rows: "F-468",
    ready: (page) => expect(page.getByTestId("shelf-row")).toContainText("Not sent"),
  },
  {
    scene: "queued-refused",
    rows: "F-061",
    // The one refused start on the shelf, and the frame final around it.
    ready: async (page) => {
      await expect(page.getByTestId("shelf-row")).toHaveCount(1);
      await expect(page.getByTestId("shelf-row")).toContainText("Couldn't start");
      await paintedFinal(page);
    },
  },
  {
    scene: "send-unknown",
    rows: "F-075",
    ready: (page) =>
      expect(page.getByTestId("outgoing")).toContainText(
        "Not known whether the gateway received it",
      ),
  },
  {
    scene: "offline-send",
    rows: "F-287 F-104",
    ready: (page) =>
      expect(page.getByTestId("outgoing").last()).toContainText("Sends when reconnected"),
  },
];
