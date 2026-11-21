// What Home and a bot's task list show, from the engine's state.
// Pure, so the unit tests cover it.

import type { Bot, ClawtrateState, Task } from "@clawtrate/core";
import { arrange, fromSidebar, type RosterPrefs } from "./presentation/arrangement.ts";
import {
  botLabel,
  botPreview,
  botTime,
  summarize,
  taskLabel,
  taskState,
  taskTime,
  TASK_WORDS,
  type RunState,
} from "./presentation/summary.ts";
import { isUnread, type SeenMap } from "../../../packages/ui/src/unread.ts";

export type BotRow = {
  bot: Bot;
  name: string;
  /** The bot's label pill (`identity.theme`), when it has one. */
  label: string | null;
  primary: boolean;
  time: string;
  preview: string;
  /** The preview says what the bot waits for, in the warning colour. */
  waiting: boolean;
  unread: boolean;
  state: RunState | null;
  /** The row's accessible name, as the rail's: "Otto, working, 4 tasks, unread". */
  spoken: string;
};

export type HomeModel = {
  pinned: BotRow[];
  rows: BotRow[];
  sections: Array<{ name: string; rows: BotRow[] }>;
};

/** No arrangement on the gateway: no pins, nothing hidden, the most recent activity first. */
const DEFAULT_PREFS: RosterPrefs = {
  pinned: [],
  hidden: [],
  sort: "recent",
  manual: [],
  sections: [],
};

/** A bot's task list that the gateway could not send. */
export const TASKS_FAILED = "Couldn't load tasks";

/**
 * A task as a row on this phone may say it: a run counts as present only while
 * connected with discovery ready, and this read-only connection cannot answer
 * what a task waits for.
 */
function rowTask(task: Task, current: boolean): Task {
  if (task.status === "waiting" || (!current && task.status === "running"))
    return { ...task, status: "idle" };
  return task;
}

export function botRow(state: ClawtrateState, bot: Bot, seen: SeenMap, now: number): BotRow {
  const known = state.tasksByBot[bot.id];
  const current = state.connection.status === "connected" && state.discovery.status === "ready";
  const tasks = (known ?? []).map((task) => rowTask(task, current));
  const summary = summarize(tasks, seen, null);
  // No list yet, and none to come until discovery is ready: no count to claim.
  const unknown = known === undefined && state.discovery.status !== "ready";
  return {
    bot,
    name: bot.name,
    label: bot.theme,
    primary: bot.isDefault,
    time: botTime(tasks, summary, now),
    preview:
      unknown && state.discovery.status === "error"
        ? TASKS_FAILED
        : unknown
          ? TASK_WORDS.loading
          : botPreview(tasks, summary, state.discovery.status === "loading"),
    waiting: false,
    unread: summary.unread,
    state: summary.state,
    spoken: unknown
      ? bot.name
      : botLabel(bot, tasks.length, summary, { primary: bot.isDefault, label: bot.theme }),
  };
}

/**
 * Home: pinned bots as tiles, then the rows, then the user's sections, in the
 * arrangement the gateway keeps for its user, ordered by recent activity.
 * Hidden bots are not listed.
 */
export function homeModel(state: ClawtrateState, seen: SeenMap, now: number): HomeModel {
  const prefs = state.sidebar?.prefs ? fromSidebar(state.sidebar.prefs, "recent") : DEFAULT_PREFS;
  const arranged = arrange(state.bots, state.tasksByBot, prefs);
  const row = (bot: Bot) => botRow(state, bot, seen, now);
  return {
    pinned: arranged.pinned.map(row),
    rows: arranged.list.map(row),
    sections: arranged.sections.map((section) => ({
      name: section.name,
      rows: section.bots.map(row),
    })),
  };
}

export type TaskRow = {
  task: Task;
  title: string;
  /** Empty when the gateway gave the task no time. */
  time: string;
  state: RunState | null;
  unread: boolean;
  spoken: string;
};

/** A bot's task rows, newest activity first, as the engine orders them. */
export function taskRows(tasks: Task[], seen: SeenMap, now: number, current = true): TaskRow[] {
  return tasks.map((task) => {
    const shown = rowTask(task, current);
    const state = taskState(shown, seen, null);
    const unread = isUnread(task, seen);
    return {
      task,
      title: task.title,
      time: task.updatedAt === null ? "" : taskTime(shown, now),
      state,
      unread,
      spoken: taskLabel(task, state, unread),
    };
  });
}
