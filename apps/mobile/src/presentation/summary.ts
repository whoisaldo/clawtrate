// Bot and task row state, timestamps, previews and accessible names.

import type { Bot, Task } from "@clawtrate/core";
import { rowTime } from "../../../../packages/ui/src/format.ts";
import { isUnread, type SeenMap } from "../../../../packages/ui/src/unread.ts";

export type RunState =
  "waiting" | "failed" | "blocked" | "done-with-failures" | "working" | "stopped" | "queued";

export type BotSummary = {
  /** The task with the latest activity, across all of the bot's tasks. */
  latest: Task | null;
  /** Any task is unread, other than the one on screen. */
  unread: boolean;
  /**
   * The most urgent state among the tasks: waiting for you, failed or blocked,
   * done with failures (until that task is opened), working. Done and unread is
   * the unread dot; idle is nothing.
   */
  state: RunState | null;
};

/** Not opened since its latest activity. */
function unseen(task: Task, seen: SeenMap): boolean {
  const lastSeen = seen[task.key];
  return lastSeen === undefined || (task.updatedAt ?? 0) > lastSeen;
}

/** A task's own state, as its row's mark says it. Opening a task clears done with failures. */
export function taskState(task: Task, seen: SeenMap, onScreenKey: string | null): RunState | null {
  switch (task.status) {
    case "running":
      return "working";
    case "waiting":
    case "failed":
    case "blocked":
      return task.status;
    case "done-with-failures":
    case "stopped":
      // Until the next run, or until the task is opened (conversation.md, section 4).
      return task.key !== onScreenKey && unseen(task, seen) ? task.status : null;
    case "queued":
      return "queued";
    default:
      return null;
  }
}

/** The order of section 4 for the avatar: a queued task counts as idle. */
const URGENCY: RunState[] = [
  "waiting",
  "failed",
  "blocked",
  "done-with-failures",
  "working",
  "stopped",
];

/**
 * What a bot's row says about all of its tasks. The three signals are
 * independent, so a folded bot never hides work in an older task.
 */
export function summarize(
  tasks: Task[],
  seen: SeenMap,
  onScreenKey: string | null,
  /** What this viewer read, for unread: the gateway's word alone on a connection that writes. */
  unreadSeen: SeenMap = seen,
): BotSummary {
  let latest: Task | null = null;
  for (const task of tasks) {
    if (!latest || (task.updatedAt ?? 0) > (latest.updatedAt ?? 0)) latest = task;
  }
  const states = new Set(tasks.map((task) => taskState(task, seen, onScreenKey)));
  return {
    latest,
    unread: tasks.some((task) => task.key !== onScreenKey && isUnread(task, unreadSeen)),
    // Failed and blocked share a place; failed is named first.
    state: URGENCY.find((state) => states.has(state)) ?? null,
  };
}

/** How a state is spoken in a row's name. */
export const STATE_WORDS: Record<RunState, string> = {
  waiting: "waiting for you",
  failed: "a run failed",
  blocked: "blocked",
  "done-with-failures": "done with failures",
  working: "working",
  stopped: "stopped",
  queued: "queued",
};

/**
 * A bot's accessible name: its name and state first, as assistive tools read a
 * busy bot ("Otto, working"), then its tasks and what else is true: "Otto,
 * working, 14 tasks, unread".
 */
export function botLabel(
  bot: Bot,
  count: number,
  summary: BotSummary,
  extra: { primary?: boolean; label?: string | null } = {},
): string {
  return (
    bot.name +
    (summary.state ? `, ${STATE_WORDS[summary.state]}` : "") +
    `, ${count} ${count === 1 ? "task" : "tasks"}` +
    (summary.unread ? ", unread" : "") +
    (extra.label ? `, ${extra.label}` : "") +
    (extra.primary ? ", primary bot" : "")
  );
}

/** What a bot's line two says while one of its tasks waits for the person (F-021). */
export function waitingWords(tasks: Task[]): string | null {
  const waiting = tasks.filter((task) => task.status === "waiting");
  if (waiting.length === 0) return null;
  const first = waiting.reduce((a, b) => ((b.waitingSince ?? 0) < (a.waitingSince ?? 0) ? b : a));
  return first.waitingFor === "question"
    ? "Waiting for you: a question"
    : first.waitingFor === "approval"
      ? "Waiting for you: approve a command"
      : "Waiting for you";
}

/**
 * A bot's time: since it began waiting, while a task waits for the person
 * (conversation.md, section 20); "now" while any of its tasks runs; else its
 * latest activity.
 */
export function botTime(tasks: Task[], summary: BotSummary, now: number): string {
  const waiting = tasks
    .filter((task) => task.status === "waiting" && task.waitingSince !== undefined)
    .map((task) => task.waitingSince!);
  if (waiting.length > 0) return rowTime(Math.min(...waiting), now);
  return tasks.some((task) => task.status === "running")
    ? "now"
    : rowTime(summary.latest?.updatedAt ?? null, now);
}

/** A bot's line two: what it waits for, else its latest task's line, else why there is none. */
export function botPreview(tasks: Task[], summary: BotSummary, loading: boolean): string {
  const latest = summary.latest;
  return (
    waitingWords(tasks) ??
    (latest ? (latest.preview ?? latest.title) : loading ? TASK_WORDS.loading : TASK_WORDS.none)
  );
}

/** A task row's time: "now" while it runs, else its latest activity. */
export function taskTime(task: Task, now: number): string {
  return task.status === "running" ? "now" : rowTime(task.updatedAt, now);
}

/** How a task's own state ends its row's accessible name. */
export const SPOKEN: Record<RunState, string> = {
  working: ", working",
  waiting: ", needs you",
  blocked: ", blocked",
  failed: ", last run failed",
  "done-with-failures": ", done with failures",
  stopped: ", stopped",
  queued: ", queued",
};

/** A task row's accessible name: its title, then whether it is pinned, then its state or unread. */
export function taskLabel(task: Task, state: RunState | null, unread: boolean): string {
  return (
    task.title +
    (task.pinned ? ", pinned" : "") +
    (state ? SPOKEN[state] : unread ? ", unread" : "")
  );
}

/** The list's own notes: while the bots load, with none, and when the gateway's task list was cut short. */
export const LIST_WORDS = {
  loadingTitle: "Loading bots",
  loadingBody: "Loading this gateway's bots.",
  emptyTitle: "No bots",
  emptyBody: "Bots appear here once the gateway has one.",
  failedTitle: "Couldn't load bots and tasks",
  failedBody: "Could not load this gateway's bots and tasks.",
  partial: "Showing the most recent tasks only.",
} as const;

/** A bot's tasks, in words: while they load, with none, and the way back to the bots. */
export const TASK_WORDS = {
  loading: "Loading tasks",
  none: "No tasks yet",
  back: "Back to bots",
} as const;

/** A bot with no tasks, on a connection that reads. */
export function noTasksBody(botName: string): string {
  return `Conversations with ${botName} will be listed here.`;
}

/**
 * The list's note when it has no bot to show: while they load, when the read
 * failed (an unsuccessful read never says the gateway has none), and when the
 * gateway has none. Null when there are bots.
 */
export function listNote(
  bots: number,
  discovery: { status: string; error: string | null },
): { title: string; body: string; state: "loading" | "failed" | "empty" } | null {
  if (bots > 0) return null;
  if (discovery.status === "loading")
    return { title: LIST_WORDS.loadingTitle, body: LIST_WORDS.loadingBody, state: "loading" };
  if (discovery.status === "error")
    return {
      title: LIST_WORDS.failedTitle,
      body: discovery.error ?? LIST_WORDS.failedBody,
      state: "failed",
    };
  return { title: LIST_WORDS.emptyTitle, body: LIST_WORDS.emptyBody, state: "empty" };
}
