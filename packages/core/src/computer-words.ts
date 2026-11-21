// The Computer tab's sentences (docs/design/work-pane.md, sections 15 to 19),
// in one place, so the desktop app and the iOS app say the same thing and a
// translation replaces one module. The engine keeps codes; these turn them
// into the design's words. Every refusal of the computer plugin that the tab
// shows is mapped here, from the plugin's own reason.

import type { BusyReason, ClosedCode, ComputerOutcome, ViewEnd } from "./computer.ts";

/** The standing second line of "You have control": exactly what a grant guarantees. */
export const pausedLine = (bot: string) =>
  `${bot}'s new browser actions are paused. Something it already started can still change this page.`;

/** What reaches the page, and what stays open, while the person holds control. */
export const reachLine = (bot: string) =>
  `Clicks, scrolling and typed text reach the page; Enter, Tab and other keys don't yet. Until you give control back, ${bot}'s new browser actions are paused, in every one of ${bot}'s tasks; something it already started can still change this page. Other ways in aren't blocked: the gateway's own browser controls, and other tools such as commands, can still reach this browser. Pages you open aren't checked by the gateway's browser rules.`;

export const captionLine = (bot: string) => `${bot}'s browser, used by all of its tasks`;

export const firstWatchLine = (bot: string) =>
  `This is ${bot}'s browser, used by all of ${bot}'s tasks. It may be signed in to sites, and what you see here is live: anyone who can see your screen sees it too.`;

export const connectingLine = (bot: string) => `Connecting to ${bot}'s browser…`;

/** How a view ended, as section 17's table says it. */
export function viewEndLine(bot: string, end: ViewEnd, error: string | null): string {
  switch (end) {
    case "tab-closed":
      return "This tab was closed.";
    case "browser-gone":
      return `The view ended. The connection to ${bot}'s browser is unavailable.`;
    case "dropped":
      return "The view ended when the connection dropped.";
    case "failed":
      return error ? `Couldn't open the view. ${error}` : "Couldn't open the view.";
    case "gateway-ended":
    case "stopped":
      return "The view ended.";
  }
}

export const noPluginTitle = "Watching isn't set up on this gateway";
export const noPluginBody = (_bot: string) =>
  "Watching is available on a Clawtrate development gateway configured for this bot.";
/** General behavior, not a reading of this gateway's own profiles. */
export const noPluginShared = (_bot: string) =>
  "On a gateway without it, bots that use the browser may share one default profile, with its sign-ins.";
export const unconfiguredTitle = (bot: string) =>
  `Watching isn't set up for ${bot} on this gateway.`;
export const unconfiguredBody = (bot: string) =>
  `${bot} isn't one of the bots the computer plugin on this gateway gives a browser of its own.`;
export const unconfiguredShared = (_bot: string) =>
  "Bots that use the browser may share one default profile, with its sign-ins.";
export const notAllowedTitle = (bot: string) => `${bot} can't use a browser in this task.`;
export const notAllowedBody =
  "The gateway's tool policy for this task doesn't allow the browser, so there is nothing to watch here.";
/**
 * Where an exec approval asked to run its command: a node by name, or the host it named. The
 * gateway's machine only when the approval named the gateway; without a host, it isn't known.
 */
export function approvalTargetLine(host: string | null, nodeId: string | null): string {
  if (nodeId) return nodeId;
  switch (host) {
    case "node":
      return "a node";
    case "sandbox":
      return "a sandbox";
    case "gateway":
      return "the gateway's machine";
    default:
      return "Machine not reported.";
  }
}
export const askFailedLine = (bot: string) => `Couldn't ask the computer plugin about ${bot}.`;
export const readOnlyLine = "Watching needs a connection that can send. This device is read-only.";
export const unusedTitle = "No screen to show";
export const unusedBody = (bot: string) => `When ${bot} uses its browser, you can watch it here.`;
export const noTabsLine = (bot: string) =>
  `${bot}'s browser has no tabs open. If ${bot} opens one, it appears here.`;
/** The plugin couldn't look (its list timed out or failed): not the same as no tabs. */
export const tabsUnknownLine = (bot: string) => `Couldn't check for tabs in ${bot}'s browser.`;
/** The full view has no view open, and none opening: nothing is shown. */
export const noViewLine = "No view open";

export const elsewhereLine = (bot: string) =>
  `Someone on another device has control of ${bot}'s browser.`;
/** Another window or tab of this same app holds the lease: the plugin sees one device. */
export const otherWindowLine = (bot: string) =>
  `Another window of this app has control of ${bot}'s browser.`;
/** A take elsewhere is still waiting for the bot (`draining`): nobody has control yet. */
export const takingElsewhereLine = (bot: string) =>
  `Someone on another device is asking for control of ${bot}'s browser.`;
export const takingOtherWindowLine = (bot: string) =>
  `Another window of this app is asking for control of ${bot}'s browser.`;
/** A take refused as held, before a read tells who holds the tab and how far. */
export const requestHeldLine = "That tab already has a control request.";

/** A take on its way: no reason is known until the plugin answers. */
export const waitingLine = (_bot: string) => "Waiting for the gateway to confirm control…";

/** A take the plugin answered `busy`, by its reason; null when it gave none this app knows. */
export function busyLine(bot: string, reason: BusyReason | null): string {
  switch (reason) {
    case "bot-still-acting":
      return `${bot} is still acting in this browser. Try again in a moment.`;
    case "bot-calls-unconfirmed":
      return `Can't confirm whether ${bot} is still acting in this browser: one of its browser calls hasn't reported that it ended. Try again in a moment.`;
    case "browser-not-watched":
      return `Can't see whether ${bot}'s browser has settled, so control wasn't given. Try again in a moment.`;
    case "browser-not-quiet":
      return `A page in ${bot}'s browser is still loading.`;
    case "download-in-progress":
      return `A download in ${bot}'s browser is still in progress.`;
    default:
      return `The gateway didn't give control of ${bot}'s browser. Try again in a moment.`;
  }
}

export const stuckLine = (_bot: string) => "The last three requests didn't give you control.";
export const stopConfirmLine = (bot: string) =>
  `Stop ${bot}'s runs in this task? Steps already done stay done. The request affects only this task.`;
export const stoppedLine = (bot: string) => `Stopped ${bot}'s runs in this task.`;
/** Asked, and not yet ended by the runs themselves (`stopProgress`). */
export const stoppingLine = (bot: string) => `Stopping ${bot}'s runs in this task…`;
export const endedBeforeStopLine = (bot: string) =>
  `${bot}'s runs ended. A stop wasn't confirmed for every run.`;
export const stopRefusedLine = (bot: string, error: string) =>
  `Couldn't stop ${bot}'s runs in this task. ${error}`;
export const nothingToStopLine = (_bot: string) =>
  "The gateway reported no runs stopped in this task.";
/** The abort's answer gave no `aborted` at all. */
export const stopUnconfirmedLine = "The gateway didn't confirm the stop.";
export const stopAcceptedLine = (_bot: string) => "The gateway accepted the stop request.";

export const controlEndedLine = (cause: "expired" | "revoked" | null) =>
  cause === "expired"
    ? "Your control ended. It expired."
    : cause === "revoked"
      ? "Your control ended. It was revoked."
      : "Your control ended.";
export const releasingLine = "Giving control back…";
export const unconfirmedLine = (bot: string) =>
  `Giving control back wasn't confirmed. This device may still have control of ${bot}'s browser.`;
export const stillHeldLine = "You still have control.";
/** No renewal confirmed the lease (`unverified`): input has stopped until one does. */
export const unverifiedLine = (bot: string) =>
  `The gateway hasn't confirmed that you still have control of ${bot}'s browser. Input has stopped.`;
export const answerNotSentLine =
  "Your answer wasn't sent. Answer in the chat once control is given back.";
export const answeringLine = "Sending your answer…";
export const outOfSightLine = (bot: string, _renewWithinMs: number | null) =>
  `This device may still have control of ${bot}'s browser. Giving it back wasn't confirmed. The gateway will let it expire if it isn't renewed.`;
export const droppedLine =
  "The connection dropped. Input has stopped. The gateway ends control when it observes this connection close; check its state after reconnecting.";
export const checkingLine = (bot: string) => `Checking ${bot}'s question and browser…`;

const closedWords: Record<ClosedCode, string> = {
  answered: "was answered",
  dismissed: "was dismissed",
  cancelled: "was cancelled",
  expired: "expired",
  "run-ended": "",
};

/** The question closed while an answer waited behind the release. */
export function droppedAnswerLine(bot: string, code: ClosedCode): string {
  return code === "run-ended"
    ? `${bot}'s run ended, so your answer wasn't sent.`
    : `${bot}'s question ${closedWords[code]}, so your answer wasn't sent.`;
}

/** The question closed while the person held control. */
export function questionGoneLine(bot: string, code: ClosedCode): string {
  return code === "run-ended" ? `${bot}'s run ended.` : `${bot}'s question ${closedWords[code]}.`;
}

/** How the answer that followed a confirmed release ended. */
export function outcomeLine(bot: string, outcome: ComputerOutcome): string {
  switch (outcome) {
    case "answered":
      return `Answer sent. ${bot} can carry on.`;
    case "answer-failed":
      return "This device gave back control. The gateway didn't confirm your answer. Check the question in chat.";
    case "already-answered":
      return `${bot}'s question was already answered.`;
    case "question-unknown":
      return "Couldn't confirm the question is still pending. Your answer wasn't sent.";
    case "already-dismissed":
      return `${bot}'s question was dismissed.`;
    case "already-cancelled":
      return `${bot}'s question was cancelled.`;
    case "already-expired":
      return `${bot}'s question had expired.`;
    case "answer-not-sent":
      return answerNotSentLine;
    case "dropped-answered":
      return droppedAnswerLine(bot, "answered");
    case "dropped-dismissed":
      return droppedAnswerLine(bot, "dismissed");
    case "dropped-cancelled":
      return droppedAnswerLine(bot, "cancelled");
    case "dropped-expired":
      return droppedAnswerLine(bot, "expired");
    case "dropped-run-ended":
      return droppedAnswerLine(bot, "run-ended");
  }
}

export const waitingBanner = (bot: string, again: boolean) =>
  again ? `${bot} is still waiting for you` : `${bot} is waiting for you`;

/** The picture shown is no longer live: its age, rounded down (`pictureAge`). */
export function lastPictureLine(ageMs: number): string {
  const s = Math.floor(ageMs / 1000);
  if (s < 60) return `Last picture, ${s} s ago`;
  const m = Math.floor(s / 60);
  return m < 60 ? `Last picture, ${m} min ago` : "Last picture, over an hour ago";
}
/** A view is open but no usable frame has been drawn yet. */
export const noPictureLine = "No picture yet";
