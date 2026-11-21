import type {
  ArchivedTask,
  Bot,
  ConnectionState,
  DiscoveryState,
  Routine,
  SidebarState,
  Task,
} from "@clawtrate/core";
import { ACTIVE_RUN_MESSAGE, isApprovalDisconnect } from "@clawtrate/core";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { Avatar } from "./Avatar.tsx";
import { useBridge, useCommand } from "./bridge.tsx";
import { copyText } from "./clipboard.ts";
import { gatewayLabel, rowTime } from "./format.ts";
import { forgetFailure } from "./forget.ts";
import {
  ArchiveIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronIcon,
  ClockIcon,
  CloseIcon,
  CopyIcon,
  EditIcon,
  EyeIcon,
  HideIcon,
  MoreIcon,
  PinIcon,
  PlusIcon,
  RestoreIcon,
  SearchIcon,
  SectionIcon,
  SettingsIcon,
  DownloadIcon,
  SortIcon,
  StarIcon,
  TrashIcon,
  UnreadIcon,
} from "./icons.tsx";
import { Menu, type MenuEntry } from "./Menu.tsx";
import type { BubbleChoice, ThemeChoice } from "./preferences.ts";
import {
  ArchivedGroup,
  isActive,
  neighbour,
  RailDialog,
  RenameField,
  useActionRunner,
  type DialogSpec,
} from "./RailActions.tsx";
import { arrange, rosterScope, SORT_ORDERS, useRoster } from "./roster.ts";
import {
  botLabel,
  summarize,
  taskState,
  TASK_CAP,
  TASK_CAP_ONE_PANE,
  visibleTasks,
  type BotSummary,
  type RunState,
  type SelectionModel,
} from "./selection.ts";
import { isUnread } from "./unread.ts";

/** The gateway's state in words, for the footer, its menu and its accessible name. */
export function presenceWords(connection: ConnectionState, catchingUp: boolean): string {
  switch (connection.status) {
    case "connected":
      return catchingUp ? "Catching up" : "Connected";
    case "reconnecting":
    case "connecting":
      return "Reconnecting…";
    case "pairing":
      return "Awaiting approval";
    case "error":
      return isApprovalDisconnect(connection.error?.code)
        ? "Disconnected"
        : "Can't reach the gateway";
    case "idle":
      return "Not connected";
    case "disconnected":
      return "Disconnected";
  }
}

/** The footer dot: the gateway's presence, never a single task's trouble. */
function presenceDot(connection: ConnectionState, catchingUp: boolean): string {
  return connection.status === "connected" && catchingUp ? "connecting" : connection.status;
}

/** Re-render once a minute, so relative times stay true. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The 12 px mark for a state. Done with failures shows the failed mark. */
function StateMark({ state }: { state: RunState | null }) {
  if (!state) return null;
  const shape = state === "done-with-failures" ? "failed" : state;
  return <span className="glyph" data-state={shape} aria-hidden="true" />;
}

/**
 * A bot's avatar with its state: the ring while it works, a badge at the top
 * right when it needs you or something failed, and the primary bot's star at
 * the lower right.
 */
function Presence({ bot, state, primary }: { bot: Bot; state: RunState | null; primary: boolean }) {
  return (
    <span
      className="presence"
      data-state={state ?? "idle"}
      data-kind={bot.avatarUrl ? "image" : "character"}
      aria-hidden="true"
    >
      <Avatar bot={bot} />
      {state && state !== "working" && <StateMark state={state} />}
      {primary && (
        <span className="primary-star" data-testid="primary-star">
          <StarIcon />
        </span>
      )}
    </span>
  );
}

type Tip = { text: string; top: number; left: number };

/** A routine run counts as working; anything more urgent the bot's tasks show wins (automation.md section 8). */
function withRoutine(summary: BotSummary, running: Routine | null): BotSummary {
  return running && (!summary.state || summary.state === "stopped")
    ? { ...summary, state: "working" }
    : summary;
}

/** A routine run's row stays under its bot this long after it finished (Clawtrate's choice, the gateway's default retention). */
const ROUTINE_ROW_MS = 24 * 60 * 60 * 1000;

function recentRoutineRuns(bot: Bot, routines: Routine[], now: number): Routine[] {
  return routines.filter(
    (each) =>
      each.botId === bot.id &&
      each.target === "isolated" &&
      each.payload === "agentTurn" &&
      (each.runningAt !== null ||
        (each.lastRunAt !== null && now - (each.lastEndedAt ?? each.lastRunAt) < ROUTINE_ROW_MS)),
  );
}

function RoutineRow({
  routine,
  now,
  onOpen,
}: {
  routine: Routine;
  now: number;
  onOpen: (id: string, runAt: number | null) => void;
}) {
  const failed = routine.runningAt === null && routine.lastStatus === "error";
  const at = routine.runningAt ?? routine.lastRunAt!;
  return (
    <li>
      <button
        type="button"
        className="task routine-task"
        data-testid="routine-task"
        data-routine={routine.id}
        data-state={routine.runningAt !== null ? "working" : failed ? "failed" : undefined}
        aria-label={`${routine.name}, routine run${routine.runningAt !== null ? ", running" : failed ? ", failed" : ""}`}
        onClick={() => onOpen(routine.id, at)}
      >
        <ClockIcon className="task-pin" />
        <span className="task-title">{routine.name}</span>
        <time className="task-time" aria-hidden="true">
          {routine.runningAt !== null ? "now" : rowTime(at, now)}
        </time>
        <span className="task-mark" aria-hidden="true">
          {routine.runningAt !== null ? (
            <StateMark state="working" />
          ) : failed ? (
            <StateMark state="failed" />
          ) : null}
        </span>
      </button>
    </li>
  );
}

/**
 * A row's menu as a control of its own, for touch, where there is no right-click
 * or Menu key: shown only with a coarse pointer (styles: `.row-more`), at least
 * 44 px. A keyboard reaches the same menu with Shift+F10 on the row.
 */
function MoreButton({ label, onOpen }: { label: string; onOpen: (trigger: HTMLElement) => void }) {
  return (
    <button
      type="button"
      className="icon-button row-more"
      data-variant="quiet"
      tabIndex={-1}
      aria-label={label}
      aria-haspopup="menu"
      onClick={(event) => onOpen(event.currentTarget)}
    >
      <MoreIcon />
    </button>
  );
}

/** How a task's state ends its row's accessible name (conversation.md, section 20). */
const SPOKEN: Record<RunState, string> = {
  working: ", working",
  waiting: ", needs you",
  blocked: ", blocked",
  failed: ", last run failed",
  "done-with-failures": ", done with failures",
  stopped: ", stopped",
  queued: ", queued",
};

/** What a bot's rows can do: set only when the connection writes. */
type TaskActions = {
  renaming: string | null;
  onRename: (task: Task) => void;
  commitRename: (task: Task, label: string) => Promise<void>;
  endRename: (task: Task, renamed: boolean) => void;
  onNewTask: (bot: Bot) => void;
};

function TaskRows({
  bot,
  tasks,
  routineRuns,
  onOpenRoutineRun,
  selection,
  onOpenTask,
  onTip,
  onTaskMenu,
  actions,
  archived,
  cap,
  now,
  onScreenKey,
}: {
  bot: Bot;
  tasks: Task[];
  routineRuns: Routine[];
  onOpenRoutineRun?: ((id: string, runAt: number | null) => void) | undefined;
  selection: SelectionModel;
  onOpenTask: (botId: string, key: string) => void;
  onTip: (tip: Tip | null) => void;
  onTaskMenu: (task: Task, trigger: HTMLElement, x: number, y: number, toggle?: boolean) => void;
  actions: TaskActions | null;
  archived: {
    gone: ReadonlyMap<string, number | null>;
    open: boolean;
    onToggle: () => void;
    onMenu: (task: ArchivedTask, trigger: HTMLElement, x: number, y: number) => void;
  };
  /** Rows shown before "Show all": fewer in one pane, so the rest of the list stays in view. */
  cap: number;
  now: number;
  /** The task whose conversation is on screen: none while Routines covers it. */
  onScreenKey: string | null;
}) {
  const currentKey = selection.bot?.id === bot.id ? (selection.task?.key ?? null) : null;
  const all = selection.showAll.has(bot.id);
  const rows = [
    ...tasks.map((task) => ({ key: task.key, at: task.updatedAt, pinned: task.pinned, task })),
    ...routineRuns.map((routine) => ({
      key: `routine:${routine.id}`,
      at: routine.runningAt ?? routine.lastRunAt,
      pinned: false,
      routine,
    })),
  ].sort(
    (a, b) => Number(b.pinned === true) - Number(a.pinned === true) || (b.at ?? 0) - (a.at ?? 0),
  );
  const showTip = (element: HTMLElement, text: string) => {
    const title = element.querySelector(".task-title");
    if (!title || title.scrollWidth <= title.clientWidth) return onTip(null);
    const rect = element.getBoundingClientRect();
    const fits = rect.right + 12 + 280 < window.innerWidth;
    onTip({
      text,
      top: fits ? rect.top + rect.height / 2 : rect.bottom + 18,
      left: fits ? rect.right + 8 : Math.max(8, rect.left),
    });
  };
  return (
    <ul className="task-list" aria-label={`${bot.name}'s tasks`} data-testid="task-list">
      {visibleTasks(rows, currentKey, all, cap).map((row) => {
        if ("routine" in row)
          return (
            <RoutineRow
              key={row.key}
              routine={row.routine}
              now={now}
              onOpen={(id, at) => onOpenRoutineRun?.(id, at)}
            />
          );
        const { task } = row;
        const current = task.key === currentKey;
        const unread =
          (task.key !== onScreenKey || selection.keptUnread.has(task.key)) &&
          isUnread(task, selection.unreadSeen);
        const state = taskState(task, selection.seen, selection.task?.key ?? null);
        const spoken =
          task.title +
          (task.pinned ? ", pinned" : "") +
          (state ? SPOKEN[state] : unread ? ", unread" : "");
        if (actions?.renaming === task.key) {
          return (
            <li key={task.key}>
              <RenameField
                task={task}
                onCommit={(label) => actions.commitRename(task, label)}
                onDone={(renamed) => actions.endRename(task, renamed)}
              />
            </li>
          );
        }
        return (
          <li key={task.key}>
            <button
              type="button"
              className="task"
              data-testid="task"
              data-key={task.key}
              data-pinned={task.pinned || undefined}
              data-status={task.status}
              data-state={state ?? undefined}
              data-unread={unread}
              aria-current={current ? "true" : undefined}
              aria-label={spoken}
              aria-description={
                task.updatedAt === null
                  ? undefined
                  : `Last activity ${task.status === "running" ? "now" : rowTime(task.updatedAt, now)}`
              }
              onClick={() => onOpenTask(bot.id, task.key)}
              onDoubleClick={actions ? () => actions.onRename(task) : undefined}
              onContextMenu={(event) => {
                event.preventDefault();
                onTip(null);
                onTaskMenu(task, event.currentTarget, event.clientX, event.clientY);
              }}
              onMouseEnter={(event) => showTip(event.currentTarget, task.title)}
              onMouseLeave={() => onTip(null)}
              onFocus={(event) => showTip(event.currentTarget, task.title)}
              onBlur={() => onTip(null)}
            >
              {task.pinned && <PinIcon className="task-pin" />}
              <span className="task-title">{task.title}</span>
              {task.updatedAt !== null && (
                <time className="task-time" aria-hidden="true">
                  {task.status === "running" ? "now" : rowTime(task.updatedAt, now)}
                </time>
              )}
              {/* One slot for at most one mark, kept even when empty so times line up. */}
              <span className="task-mark" aria-hidden="true">
                {state ? (
                  <StateMark state={state} />
                ) : unread ? (
                  <span className="unread-dot" />
                ) : null}
              </span>
            </button>
            <MoreButton
              label={`More for ${task.title}`}
              onOpen={(trigger) => {
                const rect = trigger.getBoundingClientRect();
                onTip(null);
                onTaskMenu(task, trigger, rect.right - 232, rect.bottom, true);
              }}
            />
          </li>
        );
      })}
      {rows.length > cap && (
        <li>
          <button
            type="button"
            className="task task-more"
            onClick={() => selection.toggleShowAll(bot.id)}
          >
            <span className="task-title">{all ? "Show fewer" : `Show all ${rows.length}`}</span>
          </button>
        </li>
      )}
      {actions && (
        <li>
          <button
            type="button"
            className="task task-more task-new"
            data-testid="new-task-row"
            // One gesture, one task: a double-click's second click and a held key's repeats
            // belong to the same activation, whenever the first create was answered.
            onClick={(event) => {
              if (event.detail > 1) return;
              actions.onNewTask(bot);
            }}
            onKeyDown={(event) => {
              if (event.repeat && (event.key === "Enter" || event.key === " "))
                event.preventDefault();
            }}
            // Nor does its second press take focus back from the new task's composer.
            onMouseDown={(event) => {
              if (event.detail > 1) event.preventDefault();
            }}
          >
            <PlusIcon />
            <span className="task-title">New task</span>
          </button>
        </li>
      )}
      {actions && (
        <ArchivedGroup
          bot={bot}
          tasks={tasks}
          gone={archived.gone}
          open={archived.open}
          onToggle={archived.onToggle}
          onMenu={archived.onMenu}
          now={now}
        />
      )}
    </ul>
  );
}

type MenuState =
  | { kind: "gateway"; trigger: HTMLElement }
  | { kind: "plus"; trigger: HTMLElement }
  | { kind: "sort"; trigger: HTMLElement }
  | { kind: "plus"; trigger: HTMLElement }
  | { kind: "bot"; botId: string; trigger: HTMLElement; x: number; y: number }
  /** "Move to": the sections a bot can go to, in place of its menu. */
  | { kind: "move"; botId: string; trigger: HTMLElement; x: number; y: number }
  | { kind: "task"; botId: string; key: string; trigger: HTMLElement; x: number; y: number }
  | { kind: "archived"; task: ArchivedTask; trigger: HTMLElement; x: number; y: number };

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

/** Drop the separators a menu would start or end with, or show twice in a row. */
function tidy(entries: MenuEntry[]): MenuEntry[] {
  return entries.filter(
    (entry, index) =>
      entry.kind !== "rule" ||
      (index > 0 && index < entries.length - 1 && entries[index + 1]?.kind !== "rule"),
  );
}

export function Rail({
  routeName = null,
  bots,
  tasksByBot,
  discovery,
  connection,
  catchingUp,
  selection,
  onePane,
  onOpen,
  onShowList,
  theme,
  onTheme,
  bubbles,
  onBubbles,
  updateEntry,
  onOpenSettings,
  onNewBot,
  inert,
  interactive = false,
  sidebar,
  newTaskHint = "⌘T",
  routines = [],
  routinesOpen = false,
  onOpenRoutines,
  onOpenRoutineRun,
}: {
  /** The SSH route's account: the gateway's name when the address is a forward's (setup.md §8). */
  routeName?: string | null;
  bots: Bot[];
  tasksByBot: Record<string, Task[]>;
  discovery: DiscoveryState;
  connection: ConnectionState;
  /** True while the gateway is back but its bots and tasks are still reloading after a drop. */
  catchingUp: boolean;
  selection: SelectionModel;
  /** One pane at a time: a bot with several tasks unfolds in place instead of opening. */
  onePane: boolean;
  /** A task, or a bot with one task or none, was opened. */
  onOpen: (options?: { composer?: boolean }) => void;
  /** One pane: show the list, for a search started from a conversation. */
  onShowList: () => void;
  theme: ThemeChoice;
  onTheme: (choice: ThemeChoice) => void;
  bubbles: BubbleChoice;
  onBubbles: (choice: BubbleChoice) => void;
  updateEntry: boolean;
  onOpenSettings: (section?: "updates") => void;
  /**
   * "New bot" in the "+" menu (visual-language.md section 7, bots.md section
   * 3); absent, with the "+" itself, when the connection may not write.
   */
  onNewBot: (() => void) | null;
  inert: boolean;
  /** The connection writes: the rail offers New task and every task and arrangement action. */
  interactive?: boolean;
  /** The arrangement as the gateway keeps it. */
  sidebar?: SidebarState | undefined;
  /** The New task shortcut as this host takes it: ⌘T in the desktop app, ⌥T in a browser. */
  newTaskHint?: string;
  /** The gateway's routines: a bot works while one of its routines runs (F-024), and each run shows under it (F-193). */
  routines?: Routine[];
  routinesOpen?: boolean;
  onOpenRoutines?: () => void;
  /** Open a routine's run that started at `runAt`, or the routine itself (`null`) while it runs. */
  onOpenRoutineRun?: (id: string, runAt: number | null) => void;
}) {
  const send = useCommand();
  const bridge = useBridge();
  const now = useMinuteClock();
  // The arrangement belongs to the gateway. Its identity arrives with its bots,
  // so the scope is settled only once there are bots.
  const roster = useRoster(
    bots.length > 0 ? rosterScope(connection) : null,
    connection.gatewayUrl
      ? rosterScope({ gatewayId: null, gatewayUrl: connection.gatewayUrl })
      : null,
    {
      sidebar,
      interactive,
      change: (change, base) => bridge.invoke({ type: "changeSidebar", change, base }),
    },
  );
  const [tip, setTip] = useState<Tip | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [drag, setDrag] = useState<{ id: string; over: string | null; before: boolean } | null>(
    null,
  );
  const listRef = useRef<HTMLUListElement>(null);
  const gateway = routeName ?? gatewayLabel(connection.gatewayUrl);
  const words = presenceWords(connection, catchingUp);
  const dot = presenceDot(connection, catchingUp);
  const onScreenKey = routinesOpen ? null : (selection.task?.key ?? null);
  const manual = roster.prefs.sort === "manual";
  const sortLabel = SORT_ORDERS.find((order) => order.id === roster.prefs.sort)!.label;

  // Bot search: null while closed, the query while open.
  const [query, setQuery] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  /** Where focus goes once the rail has rendered: a field or the open bot. */
  const focusAfter = useRef<"search" | "search-button" | "selected" | null>(null);
  /** A bot whose row gets focus once the rail has rendered, after a menu action moved it. */
  const [refocus, setRefocus] = useState<{ bot: string } | null>(null);
  const needle = query?.trim().toLowerCase() ?? "";

  const arranged = useMemo(
    () => arrange(bots, tasksByBot, roster.prefs),
    [bots, tasksByBot, roster.prefs],
  );
  const pinnedIds = arranged.pinned.map((bot) => bot.id);
  const matches = useMemo(
    () =>
      needle
        ? [
            ...arranged.pinned,
            ...arranged.list,
            ...arranged.sections.flatMap((section) => section.bots),
            ...arranged.hidden,
          ].filter((bot) => bot.name.toLowerCase().includes(needle))
        : null,
    [arranged, needle],
  );
  /** The bots in the order the rail shows them, for the shortcuts. Hidden bots are not in it. */
  const ordered = useMemo(
    () =>
      matches ?? [
        ...arranged.pinned,
        ...arranged.list,
        ...arranged.sections.flatMap((section) => section.bots),
      ],
    [matches, arranged],
  );
  const pinHasRoutines = (botId: string) =>
    arranged.pinned.some(
      (bot) => bot.id === botId && recentRoutineRuns(bot, routines, now).length > 0,
    );
  const owner = matches
    ? undefined
    : arranged.pinned.find((bot) => selection.isOpen(bot.id, pinHasRoutines(bot.id)));

  useEffect(() => {
    if (!announcement) return;
    const timer = setTimeout(() => setAnnouncement(""), 2000);
    return () => clearTimeout(timer);
  }, [announcement]);

  const closeMenu = useCallback(
    (refocus: boolean) => {
      if (refocus && menu?.trigger.isConnected) menu.trigger.focus();
      setMenu(null);
    },
    [menu],
  );

  const openTask = (botId: string, key: string) => {
    selection.selectTask(botId, key);
    onOpen();
  };

  // Task actions ---------------------------------------------------------------

  const runner = useActionRunner(setAnnouncement);
  const [dialog, setDialog] = useState<DialogSpec | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  /** Bots whose Archived group is open. */
  const [archivedOpen, setArchivedOpen] = useState<Set<string>>(() => new Set());
  /** Bots whose New task is on its way; held across renders, read and written by events only. */
  const [creating] = useState(() => new Set<string>());
  /**
   * Archived tasks this viewer deleted or restored: gone from the open group at once. Each is
   * named with the archive it left (`archivedAt`), so the same task archived again shows.
   */
  const [archivedGone, setArchivedGone] = useState<ReadonlyMap<string, number | null>>(
    () => new Map(),
  );
  const goneFromArchive = (task: { key: string; archivedAt?: number | null }) =>
    setArchivedGone((current) => new Map(current).set(task.key, task.archivedAt ?? null));
  /** Where focus goes once the rail has rendered after an action: a task's row, or the composer. */
  const [focusTask, setFocusTask] = useState<{
    key: string | null;
    bot: string;
    composer?: boolean;
  } | null>(null);

  const toggleArchived = (botId: string) =>
    setArchivedOpen((current) => {
      const next = new Set(current);
      if (!next.delete(botId)) next.add(botId);
      return next;
    });

  /** New task (F-054): an empty task under the bot, selected, with focus in its composer. */
  const newTask = (bot: Bot) => {
    setMenu(null);
    // One create per activation: a second press while one is on its way does nothing.
    if (creating.has(bot.id)) return;
    creating.add(bot.id);
    void runner.run(`start a task for ${bot.name}`, async () => {
      let key: string;
      try {
        ({ key } = await bridge.invoke({ type: "newTask", botId: bot.id, label: null }));
      } finally {
        creating.delete(bot.id);
      }
      selection.selectTask(bot.id, key);
      selection.unfold(bot.id);
      setFocusTask({ key, bot: bot.id, composer: true });
      onOpen({ composer: true });
      setAnnouncement(`Started a new task for ${bot.name}.`);
    });
  };

  /** After a task left the list: F-424's Main when it was the last, then focus where it was. */
  const afterRemoval = async (bot: Bot, task: Task, remaining: Task[], next: string | null) => {
    if (remaining.length === 0) {
      const { key } = await bridge.invoke({ type: "newMainTask", botId: bot.id });
      selection.selectTask(bot.id, key);
      setFocusTask({ key: null, bot: bot.id });
      return;
    }
    if (selection.task?.key === task.key && next) selection.selectTask(bot.id, next);
    setFocusTask({ key: next, bot: bot.id });
  };

  const archive = (bot: Bot, task: Task, trigger: HTMLElement | null) => {
    const tasks = tasksByBot[bot.id] ?? [];
    const remaining = tasks.filter((other) => other.key !== task.key);
    const next = neighbour(tasks, task.key);
    const act = async (stop: boolean) => {
      const { stoppedRun } = await bridge.invoke({ type: "archiveTask", key: task.key, stop });
      setAnnouncement(`Archived ${task.title}.`);
      // The gateway's archive ends anything running in the task: a run that had just started,
      // seen to end as stopped on its own end event, is said here, with the way back.
      if (stoppedRun)
        runner.tell({
          tone: "info",
          text: "Archived. A run that had just started was stopped.",
          action: {
            label: "Restore",
            onSelect: () => restore({ key: task.key, title: task.title, botId: bot.id }),
          },
        });
      await afterRemoval(bot, task, remaining, next);
    };
    const askStop = () =>
      setDialog({
        title: `Stop and archive “${task.title}”?`,
        body: <p>{bot.name} is still working on this task. Archiving it stops its run first.</p>,
        confirm: { label: "Stop and archive" },
        onConfirm: () => act(true),
        returnTo: trigger,
      });
    if (isActive(task)) {
      askStop();
      return;
    }
    // The task may have started working since its row was drawn: the engine sends nothing then,
    // and the person gets the same question as for a task that was already working.
    void runner.run(`archive ${task.title}`, async () => {
      try {
        await act(false);
      } catch (failure) {
        if (failure instanceof Error && failure.message.includes(ACTIVE_RUN_MESSAGE)) askStop();
        else throw failure;
      }
    });
  };

  const remove = (
    bot: Bot,
    task: { key: string; title: string; status?: Task["status"]; archivedAt?: number | null },
    trigger: HTMLElement | null,
    listed: boolean,
  ) => {
    const tasks = tasksByBot[bot.id] ?? [];
    const remaining = tasks.filter((other) => other.key !== task.key);
    const next = neighbour(tasks, task.key);
    setDialog({
      title: `Delete “${task.title}”?`,
      body: (
        <>
          <p>
            This removes the task and its conversation from the gateway. It can't be undone. What{" "}
            {bot.name} saved to memory during it stays.
          </p>
          {task.status && isActive({ status: task.status }) && <p>Its run is stopped first.</p>}
        </>
      ),
      confirm: { label: "Delete", tone: "danger" },
      onConfirm: async () => {
        await bridge.invoke({ type: "deleteTask", key: task.key });
        setAnnouncement(`Deleted ${task.title}.`);
        if (listed) await afterRemoval(bot, task as Task, remaining, next);
        else {
          goneFromArchive(task);
          setFocusTask({ key: null, bot: bot.id });
        }
      },
      returnTo: trigger,
    });
  };

  const restore = (
    task: Pick<ArchivedTask, "key" | "title" | "botId"> & { archivedAt?: number | null },
  ) => {
    void runner.run(`restore ${task.title}`, async () => {
      await bridge.invoke({ type: "restoreTask", key: task.key });
      goneFromArchive(task);
      setAnnouncement(`Restored ${task.title}.`);
      setFocusTask({ key: task.key, bot: task.botId });
    });
  };

  const taskActions: TaskActions | null = interactive
    ? {
        renaming,
        onRename: (task) => {
          setTip(null);
          setRenaming(task.key);
        },
        commitRename: async (task, label) => {
          await bridge.invoke({ type: "renameTask", key: task.key, label });
          setAnnouncement(`Renamed to ${label}.`);
        },
        endRename: (task) => {
          setRenaming(null);
          setFocusTask({ key: task.key, bot: task.botId });
        },
        onNewTask: newTask,
      }
    : null;

  /** Mark unread or read (F-022), on the gateway and in this viewer. */
  // This viewer's own read state follows only once the gateway took the change: a refused or
  // failed one leaves the rail and the badge as the gateway reports them.
  const mark = (task: Task, unread: boolean) =>
    void runner.run(unread ? "mark it unread" : "mark it read", async () => {
      await bridge.invoke({ type: "markTask", key: task.key, unread, opened: false });
      if (unread) selection.markUnreadHere(task.key);
      else selection.markReadHere(task);
    });

  const openTaskMenu = (task: Task, trigger: HTMLElement, x: number, y: number, toggle = false) => {
    setTip(null);
    setMenu((current) =>
      toggle && current?.kind === "task" && current.trigger === trigger
        ? null
        : { kind: "task", botId: task.botId, key: task.key, trigger, x, y },
    );
  };

  const openArchivedMenu = (task: ArchivedTask, trigger: HTMLElement, x: number, y: number) => {
    setTip(null);
    setMenu({ kind: "archived", task, trigger, x, y });
  };

  const archivedProps = (bot: Bot) => ({
    gone: archivedGone,
    open: archivedOpen.has(bot.id),
    onToggle: () => toggleArchived(bot.id),
    onMenu: openArchivedMenu,
  });

  const clickBot = (bot: Bot, count: number) => {
    if (count < 2) {
      selection.selectBot(bot.id);
      onOpen();
    } else if (onePane || bot.id === selection.bot?.id) {
      // One pane: a bot with several tasks unfolds in place. Two panes: the
      // open bot's row folds and unfolds it.
      selection.toggleFold(bot.id);
    } else {
      selection.selectBot(bot.id);
    }
  };

  // A pinned tile. The grid has one task block, with one owner at a time.
  const clickPin = (bot: Bot, count: number) => {
    const hasRoutines = pinHasRoutines(bot.id);
    if (count < 2 && !hasRoutines) {
      selection.selectBot(bot.id);
      onOpen();
    } else if (bot.id === owner?.id) {
      selection.toggleFold(bot.id, hasRoutines);
    } else if (onePane || bot.id === selection.bot?.id) {
      selection.unfoldOnly(bot.id, pinnedIds, hasRoutines);
    } else {
      selection.selectBot(bot.id);
      selection.release(pinnedIds.filter((id) => id !== bot.id));
    }
  };

  const openSearch = useCallback(() => {
    focusAfter.current = "search";
    setQuery((current) => current ?? "");
    onShowList();
  }, [onShowList]);

  const closeSearch = (refocus: boolean) => {
    if (refocus) focusAfter.current = "search-button";
    setQuery(null);
  };

  /**
   * Focus a bot's row or tile where it is now. A bot that is not shown, such as
   * a hidden one in the folded section, leaves focus on that section's toggle,
   * then on the first row, then on the search button.
   */
  const focusBot = (id: string) => {
    const list = listRef.current;
    const row =
      list?.querySelector<HTMLElement>(`:is(.bot, .pin)[data-bot="${CSS.escape(id)}"]`) ??
      list?.querySelector<HTMLElement>(".hidden-toggle") ??
      list?.querySelector<HTMLElement>(".pin, .bot") ??
      searchButtonRef.current;
    row?.focus();
  };

  // Focus moves only after the element it goes to has rendered.
  useEffect(() => {
    const target = focusAfter.current;
    if (!target) return;
    focusAfter.current = null;
    if (target === "search") searchRef.current?.focus();
    else if (target === "search-button") searchButtonRef.current?.focus();
    else focusBot(selection.bot?.id ?? "");
  });
  useEffect(() => {
    if (refocus) focusBot(refocus.bot);
  }, [refocus]);

  // After an action: the composer of a new task once it is selected, or the row a task
  // left, or the restored or renamed task's row, once it has rendered. Each target is
  // used once.
  const focusedFor = useRef<object | null>(null);
  const selectedKey = selection.task?.key ?? null;
  useEffect(() => {
    if (!focusTask || focusedFor.current === focusTask) return;
    if (focusTask.composer) {
      if (selectedKey !== focusTask.key) return;
      const field = document.querySelector<HTMLElement>(".composer-input");
      if (!field) return;
      focusedFor.current = focusTask;
      field.focus();
      return;
    }
    const row = focusTask.key
      ? listRef.current?.querySelector<HTMLElement>(
          `.task[data-key="${CSS.escape(focusTask.key)}"]`,
        )
      : null;
    if (focusTask.key && !row) return;
    focusedFor.current = focusTask;
    if (row) row.focus();
    else focusBot(focusTask.bot);
  }, [focusTask, selectedKey, tasksByBot, archivedOpen]);

  // Shortcuts that work anywhere in the shell: ⌘⇧F searches bots, ⌘1 to ⌘9
  // open a bot, Alt+Up and Alt+Down or Control+Tab and Control+Shift+Tab
  // move to the previous or next bot. The drawer, while open, keeps them out.
  useEffect(() => {
    const open = (bot: Bot) => {
      // Routines covers the conversation: the selected bot's is not on screen yet.
      if (bot.id === selection.bot?.id && !routinesOpen) return;
      const inList = listRef.current?.contains(document.activeElement) ?? false;
      selection.selectBot(bot.id);
      onOpen();
      if (inList) focusAfter.current = "selected";
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (inert) return;
      const command = event.metaKey || event.ctrlKey;
      const typing = (event.target as HTMLElement | null)?.closest?.("input, textarea") != null;
      if (command && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        openSearch();
        return;
      }
      // New task for the open bot: ⌘T in the desktop app, ⌥T in a browser (which keeps ⌘T).
      if (
        event.code === "KeyT" &&
        !event.repeat &&
        !event.shiftKey &&
        ((command && !event.altKey) || (event.altKey && !command)) &&
        interactive &&
        selection.bot
      ) {
        event.preventDefault();
        newTask(selection.bot);
        return;
      }
      let target: Bot | undefined;
      if (command && !event.shiftKey && !event.altKey && /^[1-9]$/.test(event.key)) {
        target = ordered[Number(event.key) - 1];
      } else {
        const arrow = event.altKey && !event.shiftKey && !command && !typing;
        const step =
          arrow && event.key === "ArrowDown"
            ? 1
            : arrow && event.key === "ArrowUp"
              ? -1
              : event.ctrlKey && event.key === "Tab"
                ? event.shiftKey
                  ? -1
                  : 1
                : 0;
        if (step === 0) return;
        const index = ordered.findIndex((bot) => bot.id === selection.bot?.id);
        target = ordered[Math.max(0, Math.min(ordered.length - 1, index + step))];
      }
      if (!target) return;
      event.preventDefault();
      open(target);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- newTask reads the latest render's state
  }, [inert, openSearch, onOpen, selection, ordered, interactive, routinesOpen]);

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeSearch(true);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      listRef.current?.querySelector<HTMLElement>(".bot")?.focus();
    } else if (event.key === "Enter") {
      const first = matches?.[0];
      if (!first) return;
      event.preventDefault();
      closeSearch(false);
      selection.selectBot(first.id);
      onOpen();
      focusAfter.current = "selected";
    }
  };

  /** Move a bot within the manual order of the list. */
  const moveBot = (id: string, toIndex: number) => {
    const shown = arranged.list.map((bot) => bot.id);
    const without = shown.filter((other) => other !== id);
    const before = without[Math.max(0, toIndex)] ?? null;
    // One bot's move: every other bot keeps the place the arrangement holds, so another
    // device's moves made meanwhile survive.
    void runner.run(`move ${bots.find((bot) => bot.id === id)?.name ?? id}`, () =>
      roster.move(id, before, shown),
    );
  };

  // A second press on the touch control that opened a menu closes it (`toggle`).
  const openBotMenu = (
    botId: string,
    trigger: HTMLElement,
    x: number,
    y: number,
    toggle = false,
  ) => {
    setTip(null);
    setMenu((current) =>
      toggle && current?.kind === "bot" && current.trigger === trigger
        ? null
        : { kind: "bot", botId, trigger, x, y },
    );
  };

  const openGatewayMenu = (trigger: HTMLElement) => {
    setTip(null);
    setMenu((current) => (current?.kind === "gateway" ? null : { kind: "gateway", trigger }));
  };

  const onGatewayKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && menu?.kind !== "gateway") {
      event.preventDefault();
      setMenu({ kind: "gateway", trigger: event.currentTarget });
    }
  };

  // The rail's arrow keys: Up and Down move between rows, Home and End go to
  // the ends, Right unfolds a bot, Left folds it or goes from a task to its bot.
  // In the manual order, Alt+Shift+Up and Down move the focused bot.
  const onListKey = (event: KeyboardEvent<HTMLUListElement>) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>(
      ".pin, .bot, .task, .hidden-toggle",
    );
    if (!row || !listRef.current) return;
    const rows = [
      ...listRef.current.querySelectorAll<HTMLElement>(".pin, .bot, .task, .hidden-toggle"),
    ];
    const index = rows.indexOf(row);
    const botId = row.dataset.bot ?? null;
    const isPin = row.classList.contains("pin");
    const isBot = isPin || row.classList.contains("bot");
    const hasPinRoutines = isPin && botId !== null && pinHasRoutines(botId);
    if (
      event.altKey &&
      event.shiftKey &&
      manual &&
      !matches &&
      botId &&
      row.classList.contains("bot") &&
      !row.closest(".hidden-list") &&
      (event.key === "ArrowUp" || event.key === "ArrowDown")
    ) {
      event.preventDefault();
      const at = arranged.list.findIndex((bot) => bot.id === botId);
      if (at === -1) return;
      moveBot(botId, at + (event.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      rows[
        Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))
      ]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      rows[event.key === "Home" ? 0 : rows.length - 1]?.focus();
    } else if (
      event.key === "ArrowRight" &&
      isBot &&
      botId &&
      !selection.isOpen(botId, hasPinRoutines)
    ) {
      event.preventDefault();
      if (isPin) selection.unfoldOnly(botId, pinnedIds, hasPinRoutines);
      else selection.toggleFold(botId);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (!isBot) {
        const block = row.closest(".pin-tasks");
        if (block && owner) {
          listRef.current
            .querySelector<HTMLElement>(`.pin[data-bot="${CSS.escape(owner.id)}"]`)
            ?.focus();
        } else {
          row.closest(".bot-group")?.querySelector<HTMLElement>(":scope > .bot")?.focus();
        }
      } else if (botId && selection.isOpen(botId, hasPinRoutines))
        selection.toggleFold(botId, hasPinRoutines);
    } else if (
      isBot &&
      botId &&
      (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
    ) {
      event.preventDefault();
      const rect = row.getBoundingClientRect();
      openBotMenu(botId, row, rect.left + 40, rect.bottom - 6);
    } else if (
      row.dataset.key &&
      (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
    ) {
      event.preventDefault();
      const rect = row.getBoundingClientRect();
      if (row.classList.contains("archived-task")) {
        row.click();
        return;
      }
      const task = Object.values(tasksByBot)
        .flat()
        .find((each) => each.key === row.dataset.key);
      if (task) openTaskMenu(task, row, rect.left + 40, rect.bottom - 6);
    } else if (
      event.key === "F2" &&
      taskActions &&
      row.dataset.key &&
      !row.classList.contains("archived-task")
    ) {
      event.preventDefault();
      setTip(null);
      setRenaming(row.dataset.key);
    }
  };

  // Disconnect forgets the gateway this menu names, so it is offered only with its address.
  const forgetUrl = connection.gatewayUrl;
  const gatewayEntries: MenuEntry[] = [
    {
      kind: "head",
      title: gateway,
      lines: [
        `${words} · ${connection.gatewayUrl ?? "no address"}`,
        ...(connection.serverVersion ? [`OpenClaw ${connection.serverVersion}`] : []),
      ],
    },
    { kind: "rule" },
    { kind: "label", text: "Theme" },
    ...(
      [
        ["system", "Match the system"],
        ["light", "Light"],
        ["dark", "Dark"],
      ] as const
    ).map(([choice, label]): MenuEntry => ({
      kind: "radio",
      label,
      checked: theme === choice,
      onSelect: () => {
        onTheme(choice);
        closeMenu(true);
      },
    })),
    { kind: "rule" },
    { kind: "label", text: "Your messages" },
    ...(
      [
        ["accent", "Accent"],
        ["neutral", "Neutral"],
      ] as const
    ).map(([choice, label]): MenuEntry => ({
      kind: "radio",
      label,
      checked: bubbles === choice,
      onSelect: () => {
        onBubbles(choice);
        closeMenu(true);
      },
    })),
    { kind: "rule" },
    {
      kind: "item",
      label: "Settings",
      icon: <SettingsIcon />,
      // Focus goes back to the gateway button first, so Settings returns it there.
      onSelect: () => {
        closeMenu(true);
        onOpenSettings();
      },
    },
    ...(forgetUrl
      ? [
          {
            kind: "item",
            label: "Disconnect",
            tone: "danger",
            onSelect: () => {
              setMenu(null);
              void send({ type: "disconnect", gatewayUrl: forgetUrl }).catch((error: unknown) =>
                runner.tell({ tone: "danger", text: forgetFailure(error) }),
              );
            },
          } satisfies MenuEntry,
        ]
      : []),
  ];

  const sortEntries: MenuEntry[] = [
    { kind: "label", text: "Sort bots" },
    ...SORT_ORDERS.map((order): MenuEntry => ({
      kind: "radio",
      label: order.label,
      checked: roster.prefs.sort === order.id,
      // The gateway cannot keep a read-only device's order for other clients.
      ...(order.id === "manual" ? { note: "This device only" } : {}),
      onSelect: () => {
        roster.setSort(order.id);
        closeMenu(true);
      },
    })),
  ];

  const menuBot = menu?.kind === "bot" ? bots.find((b) => b.id === menu.botId) : undefined;
  const botEntries = (bot: Bot): MenuEntry[] => {
    const tasks = tasksByBot[bot.id] ?? [];
    const hidden = roster.prefs.hidden.includes(bot.id);
    const pinned = pinnedIds.includes(bot.id);
    const listIndex = arranged.list.findIndex((other) => other.id === bot.id);
    const task = selection.taskFor(bot.id);
    // The row may move (pinned, unpinned, reordered or shown again), so focus
    // follows the bot to where it is once the rail has rendered.
    const after = (action: () => void) => () => {
      action();
      setMenu(null);
      setRefocus({ bot: bot.id });
    };
    const unreadTasks = tasks.filter((each) => isUnread(each, selection.unreadSeen));
    const only = tasks.length === 1 ? tasks[0]! : null;
    return tidy([
      ...(interactive
        ? [
            {
              kind: "item" as const,
              label: "New task",
              icon: <PlusIcon />,
              onSelect: () => newTask(bot),
            },
            { kind: "rule" as const },
          ]
        : []),
      ...(tasks.length > 1 && !hidden
        ? [
            {
              kind: "item" as const,
              label: selection.isOpen(bot.id) ? "Hide tasks" : "Show tasks",
              icon: <ChevronIcon />,
              onSelect: after(() =>
                pinned && !selection.isOpen(bot.id)
                  ? selection.unfoldOnly(bot.id, pinnedIds)
                  : selection.toggleFold(bot.id),
              ),
            },
            { kind: "rule" as const },
          ]
        : []),
      ...(!hidden && roster.editable
        ? [
            {
              kind: "item" as const,
              label: pinned ? "Unpin" : "Pin",
              icon: <PinIcon />,
              onSelect: after(() => {
                if (pinned) selection.release([bot.id]);
                // On the gateway's arrangement the row moves once the change is made: focus follows it then.
                void runner.run(pinned ? `unpin ${bot.name}` : `pin ${bot.name}`, async () => {
                  await roster.togglePin(bot.id);
                  setRefocus({ bot: bot.id });
                });
              }),
            },
          ]
        : []),
      // Sections are the gateway's to keep: offered only on a connection that writes.
      ...(!hidden && !pinned && interactive && roster.editable
        ? [
            {
              kind: "item" as const,
              label: "Move to…",
              icon: <SectionIcon />,
              onSelect: () =>
                setMenu((current) =>
                  current?.kind === "bot" ? { ...current, kind: "move", botId: bot.id } : current,
                ),
            },
          ]
        : []),
      ...(manual && !matches && listIndex > 0 && roster.editable
        ? [
            {
              kind: "item" as const,
              label: "Move up",
              icon: <ArrowUpIcon />,
              onSelect: after(() => moveBot(bot.id, listIndex - 1)),
            },
          ]
        : []),
      ...(manual &&
      !matches &&
      listIndex !== -1 &&
      listIndex < arranged.list.length - 1 &&
      roster.editable
        ? [
            {
              kind: "item" as const,
              label: "Move down",
              icon: <ArrowDownIcon />,
              onSelect: after(() => moveBot(bot.id, listIndex + 1)),
            },
          ]
        : []),
      { kind: "rule" },
      ...(interactive && tasks.length > 0
        ? [
            unreadTasks.length > 0
              ? {
                  kind: "item" as const,
                  label: "Mark as read",
                  icon: <UnreadIcon />,
                  onSelect: after(() => unreadTasks.forEach((each) => mark(each, false))),
                }
              : {
                  kind: "item" as const,
                  label: "Mark as unread",
                  icon: <UnreadIcon />,
                  onSelect: after(() =>
                    mark(
                      tasks.reduce((a, b) => ((b.updatedAt ?? 0) > (a.updatedAt ?? 0) ? b : a)),
                      true,
                    ),
                  ),
                },
          ]
        : []),
      ...(interactive && only
        ? [
            {
              kind: "item" as const,
              label: "Rename task…",
              icon: <EditIcon />,
              onSelect: () => {
                const trigger = menu?.trigger ?? null;
                setMenu(null);
                setDialog({
                  title: `Rename “${only.title}”`,
                  body: <p>The new name shows in the list and at the top of the conversation.</p>,
                  confirm: { label: "Rename" },
                  field: { label: "Name", placeholder: only.title, maxLength: 512 },
                  onConfirm: async (label) => {
                    await bridge.invoke({ type: "renameTask", key: only.key, label });
                    setAnnouncement(`Renamed to ${label.trim()}.`);
                  },
                  returnTo: trigger,
                });
              },
            },
          ]
        : []),
      ...(task
        ? [
            {
              kind: "item" as const,
              label: "Copy conversation ID",
              icon: <CopyIcon />,
              onSelect: after(() => {
                void copyText(task.key).then((result) =>
                  setAnnouncement(
                    result === "copied"
                      ? `Copied the conversation ID of ${task.title}.`
                      : "Couldn't copy the conversation ID.",
                  ),
                );
              }),
            },
          ]
        : []),
      { kind: "rule" },
      !roster.editable
        ? { kind: "rule" }
        : hidden
          ? {
              kind: "item",
              label: "Show in sidebar",
              icon: <EyeIcon />,
              onSelect: after(() => {
                void runner.run(`show ${bot.name}`, async () => {
                  await roster.setHidden(bot.id, false);
                  setRefocus({ bot: bot.id });
                });
              }),
            }
          : {
              kind: "item",
              label: "Hide from sidebar",
              icon: <HideIcon />,
              // The row goes into the folded section, so focus goes to its toggle.
              onSelect: after(() => {
                selection.release([bot.id]);
                void runner.run(`hide ${bot.name}`, async () => {
                  await roster.setHidden(bot.id, true);
                  setRefocus({ bot: bot.id });
                });
                setAnnouncement(`${bot.name} is hidden. Hidden bots keep working.`);
              }),
            },
      ...(interactive && only && !only.isMain
        ? [
            { kind: "rule" as const },
            {
              kind: "item" as const,
              label: "Archive task",
              note: "Ends anything running in this task.",
              icon: <ArchiveIcon />,
              onSelect: () => {
                const trigger = menu?.trigger ?? null;
                setMenu(null);
                archive(bot, only, trigger);
              },
            },
            {
              kind: "item" as const,
              label: "Delete task…",
              icon: <TrashIcon />,
              tone: "danger" as const,
              onSelect: () => {
                const trigger = menu?.trigger ?? null;
                setMenu(null);
                remove(bot, only, trigger, true);
              },
            },
          ]
        : []),
    ]);
  };

  /** "Move to": the bot's sections, a new one, or none (F-016). */
  const moveEntries = (bot: Bot): MenuEntry[] => {
    const current = roster.prefs.sections.find((section) => section.bots.includes(bot.id))?.name;
    const done = (text: string) => {
      setMenu(null);
      setRefocus({ bot: bot.id });
      setAnnouncement(text);
    };
    return tidy([
      { kind: "label", text: `Move ${bot.name} to` },
      ...roster.prefs.sections
        .filter((section) => section.name !== current)
        .map((section): MenuEntry => ({
          kind: "item",
          label: section.name,
          icon: <SectionIcon />,
          onSelect: () => {
            void runner.run(`move ${bot.name}`, async () => {
              await roster.moveToSection(bot.id, section.name);
              setRefocus({ bot: bot.id });
            });
            done(`Moved ${bot.name} to ${section.name}.`);
          },
        })),
      { kind: "rule" },
      {
        kind: "item",
        label: "New section…",
        icon: <PlusIcon />,
        onSelect: () => {
          const trigger = menu?.trigger ?? null;
          setMenu(null);
          setDialog({
            title: "Move to a new section",
            body: <p>{bot.name} moves into the section; others can join it with Move to.</p>,
            confirm: { label: "Create section" },
            field: { label: "Section name", placeholder: "Work", maxLength: 64 },
            onConfirm: async (name) => {
              await roster.moveToSection(bot.id, name);
              setRefocus({ bot: bot.id });
              setAnnouncement(`Moved ${bot.name} to ${name.trim()}.`);
            },
            returnTo: trigger,
          });
        },
      },
      ...(current
        ? [
            {
              kind: "item" as const,
              label: `Remove from ${current}`,
              icon: <CloseIcon />,
              onSelect: () => {
                void runner.run(`move ${bot.name}`, async () => {
                  await roster.moveToSection(bot.id, null);
                  setRefocus({ bot: bot.id });
                });
                done(`${bot.name} is no longer in ${current}.`);
              },
            },
          ]
        : []),
    ]);
  };

  /** A task's menu: on its row, by right-click, Shift+F10 or the Menu key. */
  const taskEntries = (bot: Bot, task: Task): MenuEntry[] => {
    const unread =
      isUnread(task, selection.unreadSeen) &&
      (task.key !== onScreenKey || selection.keptUnread.has(task.key));
    const trigger = menu?.trigger ?? null;
    const close = () => setMenu(null);
    return tidy([
      ...(interactive
        ? [
            {
              kind: "item" as const,
              label: "Rename",
              icon: <EditIcon />,
              hint: "F2",
              onSelect: () => {
                close();
                setRenaming(task.key);
              },
            },
            {
              kind: "item" as const,
              label: task.pinned ? "Unpin" : "Pin",
              icon: <PinIcon />,
              onSelect: () => {
                close();
                void runner.run(task.pinned ? "unpin it" : "pin it", async () => {
                  await bridge.invoke({ type: "pinTask", key: task.key, pinned: !task.pinned });
                  setAnnouncement(`${task.pinned ? "Unpinned" : "Pinned"} ${task.title}.`);
                  setFocusTask({ key: task.key, bot: bot.id });
                });
              },
            },
            {
              kind: "item" as const,
              label: unread ? "Mark as read" : "Mark as unread",
              icon: <UnreadIcon />,
              onSelect: () => {
                closeMenu(true);
                mark(task, !unread);
              },
            },
          ]
        : []),
      {
        kind: "item",
        label: "Copy conversation ID",
        icon: <CopyIcon />,
        onSelect: () => {
          closeMenu(true);
          void copyText(task.key).then((result) =>
            setAnnouncement(
              result === "copied"
                ? `Copied the conversation ID of ${task.title}.`
                : "Couldn't copy the conversation ID.",
            ),
          );
        },
      },
      // The gateway never archives or deletes a bot's main session: neither is offered for it.
      ...(interactive && !task.isMain
        ? [
            { kind: "rule" as const },
            {
              kind: "item" as const,
              label: isActive(task) ? "Stop and archive…" : "Archive",
              // The gateway's archive ends whatever runs in the task, also a run started just now.
              ...(isActive(task) ? {} : { note: "Ends anything running in this task." }),
              icon: <ArchiveIcon />,
              onSelect: () => {
                close();
                archive(bot, task, trigger);
              },
            },
            {
              kind: "item" as const,
              label: "Delete…",
              icon: <TrashIcon />,
              tone: "danger" as const,
              onSelect: () => {
                close();
                remove(bot, task, trigger, true);
              },
            },
          ]
        : []),
    ]);
  };

  /** An archived task's menu: Restore and Delete, when the connection writes. */
  const archivedEntries = (task: ArchivedTask): MenuEntry[] => {
    const bot = bots.find((each) => each.id === task.botId);
    const trigger = menu?.trigger ?? null;
    if (!interactive || !bot) return [{ kind: "head", title: task.title, lines: ["Archived"] }];
    return [
      {
        kind: "item",
        label: "Restore",
        icon: <RestoreIcon />,
        onSelect: () => {
          setMenu(null);
          restore(task);
        },
      },
      { kind: "rule" },
      {
        kind: "item",
        label: "Delete…",
        icon: <TrashIcon />,
        tone: "danger",
        onSelect: () => {
          setMenu(null);
          remove(bot, task, trigger, false);
        },
      },
    ];
  };

  /** The "+" menu's New task for the open bot; New bot follows it in the same menu. */
  const plusEntries = (bot: Bot): MenuEntry[] => [
    {
      kind: "item",
      label: `New task for ${bot.name}`,
      icon: <PlusIcon />,
      hint: newTaskHint,
      onSelect: () => newTask(bot),
    },
  ];

  const gatewayName = `${gateway}, ${words.replace("…", "").toLowerCase()}. Open the gateway menu.`;

  // Since it began waiting, while a task waits for the person (conversation.md,
  // section 20); "now" while any of the bot's tasks runs; else the latest activity.
  const time = (tasks: Task[], summary: BotSummary) => {
    const waiting = tasks
      .filter((task) => task.status === "waiting" && task.waitingSince !== undefined)
      .map((task) => task.waitingSince!);
    if (waiting.length > 0) return rowTime(Math.min(...waiting), now);
    return tasks.some((task) => task.status === "running")
      ? "now"
      : rowTime(summary.latest?.updatedAt ?? null, now);
  };

  const onContextMenu = (bot: Bot) => (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    openBotMenu(bot.id, event.currentTarget, event.clientX, event.clientY);
  };

  const draggable = manual && !matches && roster.editable;
  const dragProps = (bot: Bot, inList: boolean) =>
    draggable && inList
      ? {
          onDragOver: (event: DragEvent<HTMLLIElement>) => {
            if (!drag) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            const rect = event.currentTarget.getBoundingClientRect();
            const before = event.clientY < rect.top + rect.height / 2;
            if (drag.over !== bot.id || drag.before !== before) {
              setDrag({ ...drag, over: bot.id, before });
            }
          },
          onDrop: (event: DragEvent<HTMLLIElement>) => {
            event.preventDefault();
            if (!drag || drag.id === bot.id) return setDrag(null);
            const rest = arranged.list.filter((other) => other.id !== drag.id);
            const at = rest.findIndex((other) => other.id === bot.id);
            moveBot(drag.id, drag.before ? at : at + 1);
            setDrag(null);
          },
        }
      : {};

  const runningRoutine = (botId: string) =>
    routines.find((each) => each.botId === botId && each.runningAt !== null) ?? null;

  const renderRow = (bot: Bot, place: "list" | "section" | "hidden" | "search") => {
    const tasks = tasksByBot[bot.id] ?? [];
    const running = runningRoutine(bot.id);
    const summary = withRoutine(
      summarize(tasks, selection.seen, onScreenKey, selection.unreadSeen),
      running,
    );
    const waiting = waitingWords(tasks);
    const open = place !== "search" && selection.isOpen(bot.id);
    const several = tasks.length > 1;
    const routineRuns =
      place !== "search" && (open || !several) ? recentRoutineRuns(bot, routines, now) : [];
    const showTasks = open || (place !== "search" && interactive && archivedOpen.has(bot.id));
    const selected = bot.id === selection.bot?.id;
    const latest = summary.latest;
    return (
      <li
        key={bot.id}
        className="bot-group"
        data-open={open || undefined}
        data-drop={
          drag && drag.over === bot.id && drag.id !== bot.id
            ? drag.before
              ? "before"
              : "after"
            : undefined
        }
        {...dragProps(bot, place === "list")}
      >
        <button
          type="button"
          className="bot"
          data-testid="bot"
          data-bot={bot.id}
          data-state={summary.state ?? undefined}
          draggable={draggable && place === "list" ? true : undefined}
          onDragStart={(event) => {
            event.dataTransfer.setData("text/plain", bot.id);
            event.dataTransfer.effectAllowed = "move";
            setTip(null);
            setDrag({ id: bot.id, over: null, before: true });
          }}
          onDragEnd={() => setDrag(null)}
          aria-current={selected && !open ? "true" : undefined}
          aria-expanded={several && place !== "search" ? open : undefined}
          aria-label={botLabel(bot, tasks.length, summary, {
            primary: bot.isDefault,
            label: bot.theme,
          })}
          onClick={() =>
            clickBot(bot, place === "search" ? Math.min(tasks.length, 1) : tasks.length)
          }
          onContextMenu={onContextMenu(bot)}
        >
          <Presence bot={bot} state={summary.state} primary={bot.isDefault} />
          <span className="bot-text">
            <span className="bot-line">
              <span className="bot-name">{bot.name}</span>
              {bot.theme && <span className="bot-label">{bot.theme}</span>}
              <time className="bot-time">{time(tasks, summary)}</time>
            </span>
            <span className="bot-line">
              <span className="bot-preview" data-tone={waiting ? "warn" : undefined}>
                {waiting ??
                  (running
                    ? `Running ${running.name}`
                    : latest
                      ? (latest.preview ?? latest.title)
                      : discovery.status === "loading"
                        ? "Loading tasks"
                        : "No tasks yet")}
              </span>
              {summary.unread && <span className="unread-dot" />}
            </span>
          </span>
        </button>
        {several && place !== "search" && (
          <button
            type="button"
            className="icon-button bot-toggle"
            tabIndex={-1}
            aria-label={`${open ? "Hide" : "Show"} ${bot.name}'s tasks`}
            onClick={() => selection.toggleFold(bot.id)}
          >
            <ChevronIcon />
          </button>
        )}
        <MoreButton
          label={`More for ${bot.name}`}
          onOpen={(trigger) => {
            const rect = trigger.getBoundingClientRect();
            openBotMenu(bot.id, trigger, rect.right - 232, rect.bottom, true);
          }}
        />
        {(showTasks || routineRuns.length > 0) && (
          <TaskRows
            bot={bot}
            tasks={showTasks ? tasks : []}
            routineRuns={routineRuns}
            onOpenRoutineRun={onOpenRoutineRun}
            selection={selection}
            onOpenTask={openTask}
            onTip={setTip}
            onTaskMenu={openTaskMenu}
            actions={showTasks ? taskActions : null}
            archived={archivedProps(bot)}
            cap={onePane ? TASK_CAP_ONE_PANE : TASK_CAP}
            now={now}
            onScreenKey={onScreenKey}
          />
        )}
      </li>
    );
  };

  const renderPin = (bot: Bot) => {
    const tasks = tasksByBot[bot.id] ?? [];
    const summary = withRoutine(
      summarize(tasks, selection.seen, onScreenKey, selection.unreadSeen),
      runningRoutine(bot.id),
    );
    const several = tasks.length > 1 || pinHasRoutines(bot.id);
    return (
      <li key={bot.id}>
        <button
          type="button"
          className="pin"
          data-testid="bot"
          data-bot={bot.id}
          data-state={summary.state ?? undefined}
          aria-current={bot.id === selection.bot?.id ? "true" : undefined}
          aria-expanded={several ? owner?.id === bot.id : undefined}
          aria-label={botLabel(bot, tasks.length, summary, {
            primary: bot.isDefault,
            label: bot.theme,
          })}
          title={bot.name}
          onClick={() => clickPin(bot, tasks.length)}
          onContextMenu={onContextMenu(bot)}
        >
          <Presence bot={bot} state={summary.state} primary={bot.isDefault} />
          <span className="pin-name">
            <span>{bot.name}</span>
            {summary.unread && <span className="unread-dot" />}
          </span>
        </button>
        <MoreButton
          label={`More for ${bot.name}`}
          onOpen={(trigger) => {
            const rect = trigger.getBoundingClientRect();
            openBotMenu(bot.id, trigger, rect.left, rect.bottom, true);
          }}
        />
      </li>
    );
  };

  const updateButton = updateEntry && (
    <button
      type="button"
      className="icon-button update-entry"
      aria-label="Open Updates"
      title="Open Updates"
      onClick={() => onOpenSettings("updates")}
    >
      <DownloadIcon />
    </button>
  );
  return (
    <nav className="rail" aria-label="Bots" inert={inert}>
      <div className="rail-top">
        <button
          type="button"
          className="icon-button rail-status"
          aria-haspopup="menu"
          aria-expanded={menu?.kind === "gateway"}
          aria-label={gatewayName}
          onClick={(event) => openGatewayMenu(event.currentTarget)}
          onKeyDown={onGatewayKey}
        >
          <SettingsIcon />
          <span className="status-dot" data-status={dot} />
        </button>
        {updateButton}
        {query === null ? (
          <>
            {onOpenRoutines && (
              <button
                type="button"
                className="icon-button"
                aria-label="Routines"
                title="Routines"
                aria-current={routinesOpen ? "page" : undefined}
                onClick={onOpenRoutines}
              >
                <ClockIcon />
              </button>
            )}
            <button
              type="button"
              className="icon-button"
              aria-haspopup="menu"
              aria-expanded={menu?.kind === "sort"}
              aria-label={`Sort bots: ${sortLabel}${manual ? ", this device only" : ""}`}
              title={`Sort bots: ${sortLabel}${manual ? " (this device only)" : ""}`}
              onClick={(event) => {
                const trigger = event.currentTarget;
                setMenu((current) => (current?.kind === "sort" ? null : { kind: "sort", trigger }));
              }}
            >
              <SortIcon />
            </button>
            <button
              type="button"
              ref={searchButtonRef}
              className="icon-button"
              aria-label="Search bots"
              title="Search bots (⌘⇧F)"
              onClick={openSearch}
            >
              <SearchIcon />
            </button>
            {/* One "+" for both: New task for the open bot, and New bot. */}
            {((interactive && selection.bot) || onNewBot) && (
              <button
                type="button"
                className="icon-button rail-plus"
                data-testid="plus"
                aria-haspopup="menu"
                aria-expanded={menu?.kind === "plus"}
                aria-label="New"
                title="New"
                onClick={(event) => {
                  const trigger = event.currentTarget;
                  setTip(null);
                  setMenu((current) =>
                    current?.kind === "plus" ? null : { kind: "plus", trigger },
                  );
                }}
              >
                <PlusIcon />
              </button>
            )}
          </>
        ) : (
          <div className="rail-search" role="search">
            <SearchIcon />
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onSearchKey}
              placeholder="Search bots"
              aria-label="Search bots"
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              className="icon-button"
              data-variant="quiet"
              aria-label="Close search"
              title="Close search (Esc)"
              onClick={() => closeSearch(true)}
            >
              <CloseIcon />
            </button>
          </div>
        )}
      </div>
      <ul
        className="bot-list"
        data-testid="bot-list"
        data-dragging={drag ? "true" : undefined}
        ref={listRef}
        onKeyDown={onListKey}
        onScroll={() => setTip(null)}
        aria-busy={discovery.status === "loading" && bots.length === 0 ? true : undefined}
      >
        {bots.length === 0 &&
          (discovery.status === "loading" ? (
            <li className="rail-empty">
              <strong>Loading bots</strong>Loading this gateway's bots.
            </li>
          ) : (
            <li className="rail-empty">
              <strong>No bots</strong>Bots appear here once the gateway has one.
            </li>
          ))}
        {matches ? (
          <>
            {bots.length > 0 && matches.length === 0 && (
              <li className="rail-empty" role="status">
                <strong>No bots match</strong>No bot's name contains "{query?.trim()}".
              </li>
            )}
            {matches.map((bot) => renderRow(bot, "search"))}
          </>
        ) : (
          <>
            {arranged.pinned.length > 0 && (
              <li>
                <ul className="pin-grid" aria-label="Pinned bots">
                  {arranged.pinned.map(renderPin)}
                </ul>
              </li>
            )}
            {owner && (
              <li className="pin-tasks">
                <p className="pin-tasks-label" aria-hidden="true">
                  <Avatar bot={owner} />
                  {owner.name}
                </p>
                <TaskRows
                  bot={owner}
                  tasks={tasksByBot[owner.id] ?? []}
                  routineRuns={recentRoutineRuns(owner, routines, now)}
                  onOpenRoutineRun={onOpenRoutineRun}
                  selection={selection}
                  onOpenTask={openTask}
                  onTip={setTip}
                  onTaskMenu={openTaskMenu}
                  actions={taskActions}
                  archived={archivedProps(owner)}
                  cap={onePane ? TASK_CAP_ONE_PANE : TASK_CAP}
                  now={now}
                  onScreenKey={onScreenKey}
                />
              </li>
            )}
            {arranged.list.map((bot) => renderRow(bot, "list"))}
            {arranged.sections.map((section) => (
              <li key={`section:${section.name}`} className="rail-section-group">
                <p className="rail-section" id={`section-${section.name}`}>
                  {section.name}
                </p>
                <ul className="section-list" aria-labelledby={`section-${section.name}`}>
                  {section.bots.map((bot) => renderRow(bot, "section"))}
                </ul>
              </li>
            ))}
            {arranged.hidden.length > 0 && (
              <li className="rail-hidden">
                <button
                  type="button"
                  className="hidden-toggle"
                  aria-expanded={showHidden}
                  onClick={() => setShowHidden((open) => !open)}
                >
                  <ChevronIcon />
                  Hidden bots
                  <span className="hidden-count">{arranged.hidden.length}</span>
                </button>
                {showHidden && (
                  <ul className="hidden-list" aria-label="Hidden bots">
                    {arranged.hidden.map((bot) => renderRow(bot, "hidden"))}
                  </ul>
                )}
              </li>
            )}
          </>
        )}
        {discovery.partial && <li className="list-note">Showing the most recent tasks only.</li>}
      </ul>
      <p className="visually-hidden" role="status">
        {announcement}
      </p>
      {runner.notice && (
        <div
          className="rail-notice"
          role={runner.notice.tone === "danger" ? "alert" : "status"}
          data-tone={runner.notice.tone === "info" ? "info" : undefined}
          data-testid="rail-notice"
        >
          <span>{runner.notice.text}</span>
          {runner.notice.action && (
            <button
              type="button"
              className="button"
              data-size="sm"
              onClick={() => {
                const action = runner.notice?.action;
                runner.dismiss();
                action?.onSelect();
              }}
            >
              {runner.notice.action.label}
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            data-variant="quiet"
            aria-label="Dismiss"
            onClick={runner.dismiss}
          >
            <CloseIcon />
          </button>
        </div>
      )}
      {interactive && connection.upgrade.status === "pending" && (
        <p className="rail-notice" data-tone="wait" role="status" data-testid="rail-access-wait">
          Waiting for the gateway's owner to approve access. The change is made once they do.
        </p>
      )}
      <div className="rail-footer">
        <button
          type="button"
          className="gateway-pill"
          aria-haspopup="menu"
          aria-expanded={menu?.kind === "gateway"}
          aria-label={gatewayName}
          onClick={(event) => openGatewayMenu(event.currentTarget)}
          onKeyDown={onGatewayKey}
        >
          <span className="status-dot" data-status={dot} />
          <span className="gateway-pill-text" aria-hidden="true">
            <strong>{gateway}</strong>
            <span>{words}</span>
          </span>
        </button>
        {updateButton}
      </div>
      {menu?.kind === "gateway" && (
        <Menu
          label="Gateway"
          className="gateway-menu"
          entries={gatewayEntries}
          onClose={closeMenu}
          trigger={menu.trigger}
        />
      )}
      {menu?.kind === "sort" && (
        <Menu
          label="Sort bots"
          className="rail-menu sort-menu"
          style={{
            left: Math.max(8, menu.trigger.getBoundingClientRect().right - 232),
            top: menu.trigger.getBoundingClientRect().bottom + 6,
          }}
          entries={sortEntries}
          onClose={closeMenu}
          trigger={menu.trigger}
        />
      )}
      {menu?.kind === "bot" && menuBot && (
        <Menu
          label={menuBot.name}
          className="rail-menu"
          style={{
            left: Math.max(8, Math.min(menu.x, window.innerWidth - 244)),
            top: Math.max(8, Math.min(menu.y, window.innerHeight - 280)),
          }}
          entries={botEntries(menuBot)}
          onClose={closeMenu}
          trigger={menu.trigger}
        />
      )}
      {menu?.kind === "plus" && ((interactive && selection.bot) || onNewBot) && (
        <Menu
          label="New"
          className="rail-menu plus-menu"
          style={{
            left: Math.max(8, menu.trigger.getBoundingClientRect().right - 232),
            top: menu.trigger.getBoundingClientRect().bottom + 6,
          }}
          entries={[
            ...(interactive && selection.bot ? plusEntries(selection.bot) : []),
            ...(onNewBot
              ? [
                  {
                    kind: "item" as const,
                    label: "New bot",
                    icon: <PlusIcon />,
                    hint: "⌘N",
                    onSelect: () => {
                      // Focus goes back to the "+" first, so the dialog returns it there.
                      closeMenu(true);
                      onNewBot();
                    },
                  },
                ]
              : []),
          ]}
          onClose={closeMenu}
          trigger={menu.trigger}
        />
      )}
      {menu?.kind === "move" && bots.find((b) => b.id === menu.botId) && (
        <Menu
          label={`Move ${bots.find((b) => b.id === menu.botId)!.name} to`}
          className="rail-menu"
          style={{
            left: Math.max(8, Math.min(menu.x, window.innerWidth - 244)),
            top: Math.max(8, Math.min(menu.y, window.innerHeight - 320)),
          }}
          entries={moveEntries(bots.find((b) => b.id === menu.botId)!)}
          onClose={closeMenu}
          trigger={menu.trigger}
        />
      )}
      {menu?.kind === "task" &&
        (() => {
          const bot = bots.find((b) => b.id === menu.botId);
          const task = (tasksByBot[menu.botId] ?? []).find((each) => each.key === menu.key);
          if (!bot || !task) return null;
          return (
            <Menu
              label={task.title}
              className="rail-menu task-menu"
              style={{
                left: Math.max(8, Math.min(menu.x, window.innerWidth - 244)),
                top: Math.max(8, Math.min(menu.y, window.innerHeight - 300)),
              }}
              entries={taskEntries(bot, task)}
              onClose={closeMenu}
              trigger={menu.trigger}
            />
          );
        })()}
      {menu?.kind === "archived" && (
        <Menu
          label={menu.task.title}
          className="rail-menu"
          style={{
            left: Math.max(8, Math.min(menu.x, window.innerWidth - 244)),
            top: Math.max(8, Math.min(menu.y, window.innerHeight - 140)),
          }}
          entries={archivedEntries(menu.task)}
          onClose={closeMenu}
          trigger={menu.trigger}
        />
      )}
      {dialog && <RailDialog spec={dialog} onClose={() => setDialog(null)} />}
      {tip && (
        <div
          className="rail-tooltip"
          role="tooltip"
          style={{ top: tip.top, left: tip.left }}
          data-testid="rail-tooltip"
        >
          {tip.text}
        </div>
      )}
    </nav>
  );
}
