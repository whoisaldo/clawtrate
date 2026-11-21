// The Cmd/Ctrl+K palette (docs/design/search.md): one list over the bots,
// task names, messages, files, links, routines and settings. Each group says
// what it searched, and "no match" is said only of that. The query lives here
// while the palette is open and nowhere else.

import {
  MAX_SEARCH_QUERY_CHARS,
  type Bot,
  type ClawtrateState,
  type FileSearch,
  type MessageHit,
  type MessageSearch,
  type RoutineHit,
  type RoutineSearch,
  type Task,
} from "@clawtrate/core";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Avatar } from "../Avatar.tsx";
import { useBridge } from "../bridge.tsx";
import { gatewayLabel, rowTime } from "../format.ts";
import { ClockIcon, FileIcon, LinkIcon, SearchIcon, SettingsIcon } from "../icons.tsx";
import { messageOf } from "../Messages.tsx";
import { SETTINGS_SECTIONS, type SettingsSection } from "../Settings.tsx";
import { findIn, indexLinks, listed, plural } from "./match.ts";
import "./search.css";

/** Where an opened result goes; the shell takes it there. */
export type SearchTarget =
  | { kind: "bot"; botId: string }
  | { kind: "task"; botId: string; key: string }
  | { kind: "message"; botId: string; key: string; messageId: string; said: string }
  | { kind: "routine"; botId: string; id: string }
  | { kind: "setting"; section: SettingsSection };

/** Asked after typing pauses (search.md §6). */
export const PAUSE_MS = 250;
/** A request not answered in this long is given up. */
export const DEADLINE_MS = 8_000;
/** Rows a group shows before "Show all". */
const FIRST_ROWS = 5;
/** Bots one "Search each bot for more" asks. */
const EACH_BOTS = 24;
/** Bots whose files one batch searches. */
const FILE_BATCH = 8;
/** Requests one lane keeps in flight. */
const POOL = 4;
/** Tasks the device's list keeps (`MAX_LISTED_TASKS`). */
const LISTED = 500;
/** The live region speaks this long after the last source in view answers. */
const SAY_AFTER_MS = 400;

class Deadline extends Error {
  constructor() {
    super("the gateway didn't answer in 8 seconds");
  }
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

function withDeadline<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Deadline()), DEADLINE_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

type EachBot = {
  botId: string;
  state: "queued" | "pending" | "done" | "failed";
  reply?: MessageSearch;
  error?: string;
};
type Idle = { status: "idle" } | { status: "searching" } | { status: "offline" };
type MessagesState =
  | Idle
  | { status: "failed"; error: string }
  | {
      status: "done";
      reply: MessageSearch;
      /** Keys in the task list when the results came. */
      listed: ReadonlySet<string>;
      /** Every bot asked so far, batch after batch, in the order asked. */
      each: { bots: EachBot[] } | null;
    };
type RoutinesState =
  | Idle
  | { status: "failed"; error: string }
  | {
      status: "done";
      routines: RoutineHit[];
      last: RoutineSearch;
      revision: string | null;
      more: null | "loading" | "changed" | { error: string };
    };
type FileBot = {
  botId: string;
  state: "pending" | "done" | "failed";
  result?: FileSearch;
  error?: string;
  timedOut?: boolean;
};
type FilesState =
  | { status: "idle" }
  | { status: "offline" }
  | { status: "short" }
  | { status: "unloaded" }
  | { status: "run"; bots: FileBot[]; roster: string[] };

type Opening = {
  rowKey: string;
  key: string;
  hit: { botId: string; messageId: string; timestamp: number | null; said: string };
  /** The session the result came from, and whether the task list held it then. */
  sessionId: string | null;
  wasListed: boolean;
  status: "loading" | "failed" | "earlier" | "missing" | "gone";
  line: string | null;
  gen: number;
  /**
   * Set by Try again until the bridge sends its first state after the history is
   * asked for again: until then the transcript in view is the one that failed.
   */
  reread?: boolean;
};

type Row = {
  key: string;
  kind: "bot" | "task" | "message" | "file" | "link" | "routine" | "setting" | "action";
  name: string;
  lead?: ReactNode;
  first: ReactNode;
  second?: ReactNode;
  address?: { text: string; refused: boolean };
  hint?: string;
  note?: { text: string; tone?: "danger" };
  open: () => void;
};
type Section = { line: string | null; tone?: "danger"; rows: Row[] };
type Group = {
  id: "bots" | "tasks" | "messages" | "files" | "links" | "routines" | "settings";
  name: string;
  /** Results it found; drawn after the name. */
  count: number;
  lines: string[];
  tone?: "danger";
  sections: Section[];
  actions: Row[];
  searching: boolean;
  /** Searched over all it covers, so a group with no results is named under "No matches in". */
  complete: boolean;
  /** What it covered, for "No matches in". */
  covered: string;
};

const GROUP_WORD: Record<Group["id"], [string, string]> = {
  bots: ["bot", "bots"],
  tasks: ["task", "tasks"],
  messages: ["message", "messages"],
  files: ["file", "files"],
  links: ["link", "links"],
  routines: ["routine", "routines"],
  settings: ["setting", "settings"],
};

/** A name with the characters the device found drawn in medium weight. */
function Marked({ text, query }: { text: string; query: string }) {
  const at = findIn(text, query);
  if (!at) return <>{text}</>;
  return (
    <>
      {text.slice(0, at[0])}
      <b>{text.slice(at[0], at[1])}</b>
      {text.slice(at[1])}
    </>
  );
}

/** A file's name, cut in the middle so the extension stays. */
function middleCut(name: string, max = 48): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const tail = dot > 0 && name.length - dot <= 12 ? name.slice(dot - 6) : name.slice(-12);
  return `${name.slice(0, max - tail.length - 1)}…${tail}`;
}

const snippetText = (snippet: string) => snippet.replace(/\s+/g, " ").trim();

function dayAndTime(timestamp: number | null): string {
  if (timestamp === null) return "";
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function SearchPalette({
  state,
  mac,
  holds,
  onOpen,
  onClose,
}: {
  state: ClawtrateState;
  /** ⌘ on a Mac, Ctrl elsewhere. */
  mac: boolean;
  /** Whether the shell holds a task open now; asked when an answer comes, even after closing. */
  holds: (key: string) => boolean;
  onOpen: (target: SearchTarget) => void;
  onClose: () => void;
}) {
  const bridge = useBridge();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const fieldRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const query = text.trim();
  const [messages, setMessages] = useState<MessagesState>({ status: "idle" });
  const [routines, setRoutines] = useState<RoutinesState>({ status: "idle" });
  const [files, setFiles] = useState<FilesState>({ status: "idle" });
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [opening, setOpening] = useState<Opening | null>(null);
  const [fileNote, setFileNote] = useState<string | null>(null);
  const [said, setSaid] = useState("");

  const connected = state.connection.status === "connected";
  const gatewayName = gatewayLabel(state.connection.gatewayUrl);
  const botsById = useMemo(() => new Map(state.bots.map((bot) => [bot.id, bot])), [state.bots]);
  const tasks = useMemo(() => Object.values(state.tasksByBot).flat(), [state.tasksByBot]);
  const taskByKey = useMemo(() => new Map(tasks.map((task) => [task.key, task])), [tasks]);
  const botName = useCallback((id: string) => botsById.get(id)?.name ?? id, [botsById]);

  // Every change to the text, and every change of connection, starts a new generation: a reply,
  // retry or open from an earlier one is dropped before it changes anything (search.md §6).
  const generation = useRef(0);
  const latest = useRef({ query, state, connected });
  useEffect(() => {
    latest.current = { query, state, connected };
  });
  const lanes = useRef({ messages: Promise.resolve(), routines: Promise.resolve() });
  const pool = useRef<{ busy: number; queue: Array<() => void> }>({ busy: 0, queue: [] });
  const opened = useRef<string | null>(null);

  /** Run `job` in the Files pool, at most four at once; queued work of an old generation is dropped. */
  const pooled = useCallback(<T,>(gen: number, job: () => Promise<T>): Promise<T | null> => {
    return new Promise((resolve) => {
      const start = () => {
        if (gen !== generation.current) return resolve(null);
        pool.current.busy += 1;
        job()
          .then(resolve, () => resolve(null))
          .finally(() => {
            pool.current.busy -= 1;
            pool.current.queue.shift()?.();
          });
      };
      if (pool.current.busy < POOL) start();
      else pool.current.queue.push(start);
    });
  }, []);

  const searchMessages = useCallback(
    async (gen: number, q: string) => {
      setMessages({ status: "searching" });
      await lanes.current.messages;
      if (gen !== generation.current) return;
      const asked = withDeadline(bridge.invoke({ type: "searchMessages", query: q, botId: null }));
      lanes.current.messages = asked.then(
        () => {},
        () => {},
      );
      try {
        const reply = await asked;
        if (gen !== generation.current) return;
        const keys = new Set(
          Object.values(latest.current.state.tasksByBot).flatMap((list) =>
            list.map((task) => task.key),
          ),
        );
        setMessages({ status: "done", reply, listed: keys, each: null });
      } catch (error) {
        if (gen === generation.current) setMessages({ status: "failed", error: reason(error) });
      }
    },
    [bridge],
  );

  const routinePage = useCallback(
    async (gen: number, q: string, offset: number) => {
      if (offset === 0) setRoutines({ status: "searching" });
      else setRoutines((now) => (now.status === "done" ? { ...now, more: "loading" } : now));
      await lanes.current.routines;
      if (gen !== generation.current) return;
      const asked = withDeadline(bridge.invoke({ type: "searchRoutines", query: q, offset }));
      lanes.current.routines = asked.then(
        () => {},
        () => {},
      );
      try {
        const page = await asked;
        if (gen !== generation.current) return;
        setRoutines((now) => {
          if (offset === 0 || now.status !== "done")
            return {
              status: "done",
              routines: page.routines,
              last: page,
              revision: page.revision,
              more: null,
            };
          // Every page must come from the list the first page was cut from (search.md §7).
          if (page.revision !== now.revision || page.offset !== now.last.nextOffset)
            return { ...now, more: "changed" };
          return { ...now, routines: [...now.routines, ...page.routines], last: page, more: null };
        });
      } catch (error) {
        if (gen !== generation.current) return;
        if (offset === 0) setRoutines({ status: "failed", error: reason(error) });
        else
          setRoutines((now) =>
            now.status === "done" ? { ...now, more: { error: reason(error) } } : now,
          );
      }
    },
    [bridge],
  );

  const searchFileBots = useCallback(
    (gen: number, q: string, botIds: string[]) => {
      setFiles((now) => {
        const bots = now.status === "run" ? [...now.bots] : [];
        for (const botId of botIds) {
          const index = bots.findIndex((each) => each.botId === botId);
          const pending: FileBot = { botId, state: "pending" };
          if (index >= 0) bots[index] = pending;
          else bots.push(pending);
        }
        const roster =
          now.status === "run" ? now.roster : latest.current.state.bots.map((bot) => bot.id);
        return { status: "run", bots, roster };
      });
      for (const botId of botIds) {
        void pooled(gen, async () => {
          let settled: FileBot;
          try {
            const result = await withDeadline(
              bridge.invoke({ type: "searchFiles", query: q, botId }),
            );
            settled = { botId, state: "done", result };
          } catch (error) {
            settled = {
              botId,
              state: "failed",
              error: reason(error),
              timedOut: error instanceof Deadline,
            };
          }
          if (gen !== generation.current) return;
          setFiles((now) =>
            now.status === "run"
              ? { ...now, bots: now.bots.map((each) => (each.botId === botId ? settled : each)) }
              : now,
          );
        });
      }
    },
    [bridge, pooled],
  );

  /** Ask every gateway source for the latest text, once. */
  const ask = useCallback(
    (gen: number) => {
      const { query: q, state: now, connected: online } = latest.current;
      if (!q) return;
      if (!online) {
        setMessages({ status: "offline" });
        setRoutines({ status: "offline" });
        setFiles({ status: "offline" });
        return;
      }
      void searchMessages(gen, q);
      void routinePage(gen, q, 0);
      if (q.length < 2) setFiles({ status: "short" });
      else if (now.bots.length === 0) setFiles({ status: "unloaded" });
      else
        searchFileBots(
          gen,
          q,
          now.bots.slice(0, FILE_BATCH).map((bot) => bot.id),
        );
    },
    [searchMessages, routinePage, searchFileBots],
  );

  /** A new generation: the gateway's groups lose the previous answer at once. */
  const restart = useCallback((q: string, online: boolean) => {
    generation.current += 1;
    pool.current.queue = [];
    setShown(new Set());
    setActiveKey(null);
    setOpening(null);
    setFileNote(null);
    setSaid("");
    const idle = !q ? "idle" : online ? "searching" : "offline";
    setMessages({ status: idle });
    setRoutines({ status: idle });
    setFiles({ status: !q ? "idle" : online ? (q.length < 2 ? "short" : "idle") : "offline" });
    return generation.current;
  }, []);

  useEffect(() => {
    const gen = restart(query, latest.current.connected);
    if (!query || !latest.current.connected) return;
    const timer = setTimeout(() => ask(gen), PAUSE_MS);
    return () => clearTimeout(timer);
  }, [query, ask, restart]);

  // Asked before any bot was known, Files starts when the roster comes; the other groups stay.
  useEffect(() => {
    if (files.status === "unloaded" && state.bots.length > 0)
      searchFileBots(
        generation.current,
        latest.current.query,
        state.bots.slice(0, FILE_BATCH).map((bot) => bot.id),
      );
  }, [files.status, state.bots, searchFileBots]);

  const connectionKey = `${state.connection.status}\n${state.connection.gatewayUrl}\n${state.connection.scopes.join(",")}`;
  const lastConnection = useRef(connectionKey);
  useEffect(() => {
    if (lastConnection.current === connectionKey) return;
    lastConnection.current = connectionKey;
    const gen = restart(latest.current.query, latest.current.connected);
    if (latest.current.connected) ask(gen);
  }, [connectionKey, ask, restart]);

  const searchEach = useCallback(
    (gen: number, q: string, asked: string[]) => {
      setMessages((now) =>
        now.status === "done"
          ? {
              ...now,
              each: {
                bots: [
                  ...(now.each?.bots ?? []),
                  ...asked.map((botId): EachBot => ({ botId, state: "queued" })),
                ],
              },
            }
          : now,
      );
      const set = (botId: string, change: Partial<EachBot>) =>
        setMessages((now) =>
          now.status === "done" && now.each
            ? {
                ...now,
                each: {
                  ...now.each,
                  bots: now.each.bots.map((each) =>
                    each.botId === botId ? { ...each, ...change } : each,
                  ),
                },
              }
            : now,
        );
      let next = 0;
      const lane = async () => {
        while (next < asked.length) {
          const botId = asked[next++]!;
          if (gen !== generation.current) return;
          set(botId, { state: "pending" });
          try {
            const reply = await withDeadline(
              bridge.invoke({ type: "searchMessages", query: q, botId }),
            );
            if (gen === generation.current) set(botId, { state: "done", reply });
          } catch (error) {
            if (gen === generation.current) set(botId, { state: "failed", error: reason(error) });
          }
        }
      };
      for (let i = 0; i < POOL; i += 1) void lane();
    },
    [bridge],
  );

  const retryEachBot = useCallback(
    (gen: number, q: string, botId: string) => {
      const set = (change: Partial<EachBot>) =>
        setMessages((now) =>
          now.status === "done" && now.each
            ? {
                ...now,
                each: {
                  ...now.each,
                  bots: now.each.bots.map((each) =>
                    each.botId === botId ? { ...each, ...change } : each,
                  ),
                },
              }
            : now,
        );
      set({ state: "pending" });
      withDeadline(bridge.invoke({ type: "searchMessages", query: q, botId })).then(
        (reply) => gen === generation.current && set({ state: "done", reply }),
        (error: unknown) =>
          gen === generation.current && set({ state: "failed", error: reason(error) }),
      );
    },
    [bridge],
  );

  /** The place a result names, checked against what the app keeps now; the line when it can't open. */
  const goneLine = useCallback(
    (botId: string, key: string, sessionId: string | null, wasListed: boolean): string | null => {
      const now = latest.current.state;
      if (!now.bots.some((bot) => bot.id === botId))
        return `${botName(botId)} is no longer in this connection's list of bots.`;
      const task = Object.values(now.tasksByBot)
        .flat()
        .find((each) => each.key === key);
      if (!task)
        return wasListed
          ? "This task is no longer in this device's task list."
          : `This task isn't in this device's task list, which keeps up to ${LISTED} tasks.`;
      if (sessionId !== null && task.sessionId !== null && task.sessionId !== sessionId)
        return "This task's conversation was replaced since the search. Search again.";
      return null;
    },
    [botName],
  );

  // A message opens only once its task's loaded history holds it (search.md §9),
  // and only while the task still holds the session the result came from.
  const finishOpening = useCallback(
    (open: Opening) => {
      // A restart in the same commit leaves this effect the previous render's opening.
      if (open.gen !== generation.current || open.reread) return;
      const transcript = latest.current.state.transcripts[open.key];
      if (!transcript || transcript.status === "loading") return;
      const gone = goneLine(open.hit.botId, open.key, open.sessionId, open.wasListed);
      if (gone) {
        setOpening({ ...open, status: "gone", line: gone });
        return;
      }
      if (transcript.status === "error") {
        setOpening({
          ...open,
          status: "failed",
          line: `Couldn't load this conversation: ${transcript.error ?? "the gateway refused"}.`,
        });
        return;
      }
      if (messageOf(transcript, open.hit.messageId)) {
        if (opened.current === open.key) opened.current = null;
        onOpen({
          kind: "message",
          botId: open.hit.botId,
          key: open.key,
          messageId: open.hit.messageId,
          said: open.hit.said,
        });
        return;
      }
      const oldest = transcript.items.find((item) => item.timestamp !== null)?.timestamp ?? null;
      const earlier =
        transcript.hasMore &&
        open.hit.timestamp !== null &&
        oldest !== null &&
        open.hit.timestamp < oldest;
      setOpening({
        ...open,
        status: earlier ? "earlier" : "missing",
        line: earlier
          ? "This message is earlier than the 200 messages this conversation shows, so it can't be shown in place."
          : "This message isn't in the conversation's loaded messages.",
      });
    },
    [onOpen, goneLine],
  );
  useEffect(() => {
    if (opening?.status === "loading") finishOpening(opening);
  }, [opening, state.transcripts, finishOpening]);

  /** Ask for a task's history; a refusal shows on the result that asked. */
  const load = useCallback(
    (open: Opening) => {
      bridge.send({ type: "openSession", key: open.key }).then(
        () => {
          if (!open.reread) return;
          // States and answers come in order, so the next state holds the history asked for now.
          const stop = bridge.subscribe(() => {
            stop();
            setOpening((now) => (now === open ? { ...open, reread: false } : now));
          });
        },
        (error: unknown) =>
          setOpening((now) =>
            now === open
              ? {
                  ...open,
                  status: "failed",
                  line: `Couldn't load this conversation: ${reason(error)}.`,
                }
              : now,
          ),
      );
    },
    [bridge],
  );

  const openMessage = useCallback(
    (
      rowKey: string,
      hit:
        | MessageHit
        | {
            botId: string;
            sessionKey: string;
            sessionId: string | null;
            messageId: string;
            timestamp: number | null;
            role: "user" | "assistant";
          },
      wasListed: boolean,
      title: string,
    ) => {
      const gone = goneLine(hit.botId, hit.sessionKey, hit.sessionId, wasListed);
      const said = `Opened ${title}, at ${hit.role === "user" ? "the user message" : `${botName(hit.botId)}'s reply`}${hit.timestamp !== null ? ` of ${dayAndTime(hit.timestamp)}` : ""}`;
      const open: Opening = {
        rowKey,
        key: hit.sessionKey,
        hit: { botId: hit.botId, messageId: hit.messageId, timestamp: hit.timestamp, said },
        sessionId: hit.sessionId,
        wasListed,
        status: gone ? "gone" : "loading",
        line: gone,
        gen: generation.current,
      };
      setOpening(open);
      if (gone) return;
      // The conversation behind the palette stays as it was while this task's history loads.
      if (!latest.current.state.transcripts[hit.sessionKey]) {
        if (opened.current && opened.current !== hit.sessionKey)
          void bridge.send({ type: "closeSession", key: opened.current });
        opened.current = hit.sessionKey;
        load(open);
      } else finishOpening(open);
    },
    [bridge, botName, goneLine, finishOpening, load],
  );
  useEffect(
    () => () => {
      // Nothing queued starts once the palette has closed.
      generation.current += 1;
      pool.current.queue = [];
      if (opened.current) void bridge.send({ type: "closeSession", key: opened.current });
    },
    [bridge],
  );

  const links = useMemo(() => indexLinks(state.transcripts), [state.transcripts]);
  const loadedConversations = Object.values(state.transcripts).filter(
    (transcript) => transcript.status === "ready",
  ).length;

  const groups = useMemo((): Group[] => {
    if (!query) return [];
    const gen = generation.current;
    const out: Group[] = [];
    const discoveryFailed = state.discovery.status === "error";
    const unloaded = state.bots.length === 0 && state.discovery.status !== "ready";
    const avatar = (id: string) => {
      const bot = botsById.get(id);
      return bot ? <Avatar bot={bot} /> : null;
    };

    const botRows: Row[] = state.bots
      .filter((bot) => findIn(bot.name, query))
      .map((bot: Bot) => ({
        key: `bot:${bot.id}`,
        kind: "bot",
        name: `Bot ${bot.name}${bot.theme ? `, ${bot.theme}` : ""}`,
        lead: <Avatar bot={bot} />,
        first: <Marked text={bot.name} query={query} />,
        second: bot.theme ?? undefined,
        hint: "Open",
        open: () => onOpen({ kind: "bot", botId: bot.id }),
      }));
    out.push({
      id: "bots",
      name: "Bots",
      count: botRows.length,
      lines: discoveryFailed
        ? ["Couldn't load the gateway's bots. Showing the bots loaded before."]
        : unloaded
          ? ["The gateway's bots haven't loaded yet."]
          : [],
      sections: [{ line: null, rows: botRows }],
      actions: [],
      searching: false,
      complete: !discoveryFailed && !unloaded,
      covered: "Every bot this connection can see, by name.",
    });

    const taskRows: Row[] = tasks
      .filter((task) => findIn(task.title, query))
      .map((task: Task) => {
        const when = rowTime(task.updatedAt);
        return {
          key: `task:${task.key}`,
          kind: "task",
          name: `Task ${task.title}, ${botName(task.botId)}${when ? `, ${when}` : ""}`,
          lead: avatar(task.botId),
          first: <Marked text={task.title} query={query} />,
          second: `${botName(task.botId)}${when ? ` · ${when}` : ""}`,
          hint: "Open",
          open: () => onOpen({ kind: "task", botId: task.botId, key: task.key }),
        };
      });
    const tasksLine = discoveryFailed
      ? "Couldn't load the task list. Titles in the tasks loaded before."
      : state.discovery.partial
        ? "Titles in this device's task list, which was cut short: it holds the most recent tasks only."
        : `Titles in this device's task list, which keeps up to ${LISTED} tasks`;
    out.push({
      id: "tasks",
      name: "Tasks",
      count: taskRows.length,
      lines: [tasksLine],
      sections: [{ line: null, rows: taskRows }],
      actions: [],
      searching: false,
      complete: !discoveryFailed && !state.discovery.partial && !unloaded,
      covered: `Titles in this device's task list, which keeps up to ${LISTED} tasks.`,
    });

    out.push(messagesGroup());
    out.push(filesGroup());

    const linkRows: Row[] = links
      .filter((link) => link.address.toLowerCase().includes(query.toLowerCase()))
      .map((link) => {
        const task = taskByKey.get(link.sessionKey);
        const botId = task?.botId ?? link.sessionKey.split(":")[1] ?? "";
        const title = task?.title ?? link.sessionKey;
        const rowKey = `link:${link.sessionKey}:${link.messageId}:${link.address}`;
        return {
          key: rowKey,
          kind: "link",
          name: link.refused
            ? `Address ${link.address}, in ${title}. It can't be opened from Clawtrate: ${link.refused}.`
            : `Link ${link.address}, in ${title}.`,
          lead: (
            <span className="s-icon">
              <LinkIcon />
            </span>
          ),
          first: link.host ?? link.address,
          address: { text: link.address, refused: link.refused !== null },
          second: `${title} · ${botName(botId)}`,
          hint: "Go to message",
          ...(link.refused
            ? { note: { text: `It can't be opened from Clawtrate: ${link.refused}.` } }
            : {}),
          open: () =>
            openMessage(
              rowKey,
              {
                botId,
                sessionKey: link.sessionKey,
                sessionId: task?.sessionId ?? null,
                messageId: link.messageId,
                timestamp: null,
                role: link.role,
              },
              task !== undefined,
              title,
            ),
        };
      });
    out.push({
      id: "links",
      name: "Links",
      count: linkRows.length,
      lines: [
        loadedConversations
          ? `Only from the ${plural(loadedConversations, "conversation")} this device has loaded`
          : "No conversation is loaded on this device yet",
      ],
      sections: [{ line: null, rows: linkRows }],
      actions: [],
      searching: false,
      complete: loadedConversations > 0,
      covered: `Links in the ${plural(loadedConversations, "conversation")} this device has loaded.`,
    });

    out.push(routinesGroup());

    const settingRows: Row[] = SETTINGS_SECTIONS.filter(
      ([, name, line]) => findIn(name, query) || findIn(line, query),
    ).map(([section, name, line]) => ({
      key: `setting:${section}`,
      kind: "setting",
      name: `Setting ${name}`,
      lead: (
        <span className="s-icon">
          <SettingsIcon />
        </span>
      ),
      first: <Marked text={name} query={query} />,
      second: line,
      hint: "Open",
      open: () => onOpen({ kind: "setting", section }),
    }));
    out.push({
      id: "settings",
      name: "Settings",
      count: settingRows.length,
      lines: [],
      sections: [{ line: null, rows: settingRows }],
      actions: [],
      searching: false,
      complete: true,
      covered: "The sections of Clawtrate's Settings.",
    });
    return out;

    function notConnected(
      group: Omit<Group, "lines" | "sections" | "actions" | "searching" | "complete" | "count">,
    ): Group {
      return {
        ...group,
        count: 0,
        lines: [
          `Not searched: ${gatewayName} isn't connected. Search runs again when it reconnects.`,
        ],
        sections: [],
        actions: [],
        searching: false,
        complete: false,
      };
    }

    function searching(
      group: Omit<Group, "lines" | "sections" | "actions" | "searching" | "complete" | "count">,
    ): Group {
      return {
        ...group,
        count: 0,
        lines: ["Searching…"],
        sections: [],
        actions: [],
        searching: true,
        complete: false,
      };
    }

    function messageRows(
      hits: MessageHit[],
      reply: MessageSearch,
      wasListed: ReadonlySet<string>,
    ): Row[] {
      return [...hits]
        .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
        .map((hit) => {
          const task = taskByKey.get(hit.sessionKey);
          const title = task?.title ?? reply.titles[hit.sessionKey] ?? hit.sessionKey;
          const who = hit.role === "user" ? "User" : botName(hit.botId);
          const when = rowTime(hit.timestamp);
          const snippet = snippetText(hit.snippet);
          const rowKey = `message:${hit.sessionKey}:${hit.messageId}`;
          return {
            key: rowKey,
            kind: "message" as const,
            name: `Message in ${title}, from ${hit.role === "user" ? "a user" : botName(hit.botId)}${hit.timestamp !== null ? `, ${dayAndTime(hit.timestamp)}` : ""}: ${snippet}`,
            lead: avatar(hit.botId),
            first: (
              <>
                {title} · {who}
                {when && <span className="s-time"> · {when}</span>}
              </>
            ),
            second: <span className="s-clamp">{snippet}</span>,
            hint: "Go to message",
            open: () => openMessage(rowKey, hit, wasListed.has(hit.sessionKey), title),
          };
        });
    }

    function replyFlags(reply: MessageSearch): string[] {
      return [
        ...(reply.indexing ? ["Some messages are still being indexed."] : []),
        ...(reply.archivedExcluded > 0
          ? [
              `${plural(reply.archivedExcluded, "task has", "tasks have")} archived transcript content that wasn't searched.`,
            ]
          : []),
      ];
    }

    function messagesGroup(): Group {
      const base = {
        id: "messages" as const,
        name: "Messages",
        covered:
          "User messages and bot replies in tasks this gateway lets you see. Excludes routine runs, subagent tasks and archived tasks.",
      };
      if (messages.status === "offline") return notConnected(base);
      if (messages.status === "idle" || messages.status === "searching") return searching(base);
      if (messages.status === "failed")
        return {
          ...base,
          count: 0,
          lines: [`Couldn't search messages: ${messages.error}.`],
          tone: "danger",
          sections: [],
          actions: [action("messages:retry", "Try again", () => void searchMessages(gen, query))],
          searching: false,
          complete: false,
        };
      const { reply, each } = messages;
      const flags = replyFlags(reply);
      const incomplete = reply.truncated || flags.length > 0;
      const eachAction =
        incomplete && !each
          ? [
              action("messages:each", "Search each bot for more", () =>
                searchEach(
                  gen,
                  query,
                  state.bots.slice(0, EACH_BOTS).map((bot) => bot.id),
                ),
              ),
            ]
          : [];
      if (each) {
        const notAsked = state.bots
          .map((bot) => bot.id)
          .filter((id) => !each.bots.some((bot) => bot.botId === id));
        const answered = each.bots.filter((bot) => bot.state === "done");
        const failed = each.bots.filter((bot) => bot.state === "failed");
        const pending = each.bots.filter((bot) => bot.state === "pending").length;
        const queued = each.bots.filter((bot) => bot.state === "queued").length;
        const running = pending + queued > 0;
        const first = running
          ? `Searching ${plural(each.bots.length, "bot")}… ${answered.length} answered, ${failed.length ? `${failed.length} couldn't search, ` : ""}${pending} in progress, ${queued} queued.`
          : `${answered.length} of ${plural(each.bots.length, "bot")} answered. ${plural(
              answered.reduce((sum, bot) => sum + (bot.reply?.hits.length ?? 0), 0),
              "message",
            )} returned.`;
        const lines = [
          first,
          ...(notAsked.length ? [`Not asked: ${listed(notAsked.map(botName))}.`] : []),
        ];
        if (running)
          return {
            ...base,
            count: reply.hits.length,
            lines,
            sections: [{ line: null, rows: messageRows(reply.hits, reply, messages.listed) }],
            actions: [],
            searching: true,
            complete: false,
          };
        const sections: Section[] = each.bots.map((bot) => {
          const name = botName(bot.botId);
          if (bot.state === "failed")
            return {
              line: `${name} · couldn't search: ${bot.error ?? ""}`,
              tone: "danger" as const,
              rows: [],
            };
          const r = bot.reply!;
          const extra = replyFlags(r);
          const head = r.truncated
            ? `${name} · ${r.hits.length} returned. More match; add words to narrow them.`
            : extra.length
              ? `${name} · ${r.hits.length ? `${r.hits.length} returned` : "none returned"}.`
              : r.hits.length
                ? `${name} · all ${plural(r.hits.length, "match", "matches")}`
                : `${name} · no matches`;
          return {
            line: [head, ...extra].join(" "),
            rows: messageRows(r.hits, r, messages.listed),
          };
        });
        const actions = [
          ...failed.map((bot) =>
            action(`messages:retry:${bot.botId}`, `Try again for ${botName(bot.botId)}`, () =>
              retryEachBot(gen, query, bot.botId),
            ),
          ),
          ...(notAsked.length
            ? [
                action(
                  "messages:each-next",
                  `Search the next ${plural(Math.min(EACH_BOTS, notAsked.length), "bot")}`,
                  () => searchEach(gen, query, notAsked.slice(0, EACH_BOTS)),
                ),
              ]
            : []),
        ];
        return {
          ...base,
          count: sections.reduce((sum, section) => sum + section.rows.length, 0),
          lines,
          sections,
          actions,
          searching: false,
          complete: false,
        };
      }
      const n = reply.hits.length;
      const lines = reply.truncated
        ? [
            `Showing the ${n} matches the gateway returned, newest first. More indexed messages match.`,
            ...flags,
          ]
        : flags.length
          ? [`${plural(n, "match", "matches")} returned, newest first.`, ...flags]
          : [`All ${plural(n, "matching message")}, newest first`];
      return {
        ...base,
        count: n,
        lines,
        sections: [{ line: null, rows: messageRows(reply.hits, reply, messages.listed) }],
        actions: eachAction,
        searching: false,
        complete: !incomplete,
      };
    }

    function filesGroup(): Group {
      const base = {
        id: "files" as const,
        name: "Files",
        covered:
          "File names returned from workspaces the palette can verify. Some folders may be skipped.",
      };
      if (files.status === "offline") return notConnected(base);
      if (files.status === "short")
        return {
          ...base,
          count: 0,
          lines: ["Type 2 or more characters to search file names."],
          sections: [],
          actions: [],
          searching: false,
          complete: false,
        };
      if (files.status === "unloaded")
        return {
          ...base,
          count: 0,
          lines: ["Not searched: the gateway's bots haven't loaded yet."],
          sections: [],
          actions: [],
          searching: false,
          complete: false,
        };
      if (files.status === "idle") return searching(base);
      const settled = files.bots.every((bot) => bot.state !== "pending");
      const rows: Row[] = [];
      const lines: string[] = [];
      const returned: string[] = [];
      const empty: string[] = [];
      let searched = 0;
      const retries: Row[] = [];
      for (const bot of files.bots) {
        const name = botName(bot.botId);
        if (bot.state === "pending") continue;
        if (bot.state === "failed") {
          lines.push(
            bot.timedOut
              ? `${name}: the gateway didn't answer in 8 seconds.`
              : `${name}: the gateway refused the search: ${bot.error ?? ""}.`,
          );
          retries.push(
            action(`files:retry:${bot.botId}`, `Try again for ${name}`, () =>
              searchFileBots(gen, query, [bot.botId]),
            ),
          );
          continue;
        }
        const result = bot.result!;
        if (result.status === "unverified") {
          lines.push(`Not searched: ${name}'s workspace could not be verified.`);
          continue;
        }
        if (result.status === "no-root") {
          lines.push(
            `${name}: the gateway returned no workspace for its task, so nothing was searched.`,
          );
          continue;
        }
        searched += 1;
        if (result.paths.length === 0) empty.push(name);
        else returned.push(name);
        if (result.truncated)
          lines.push(
            `${name}: the gateway stopped at its limit of 500 names or 5,000 entries walked.`,
          );
        if (result.returned > result.paths.length)
          lines.push(
            `${name}: showing ${result.paths.length} of the ${result.returned} names returned.`,
          );
        for (const path of result.paths) {
          const slash = path.lastIndexOf("/");
          const file = path.slice(slash + 1);
          const folder = slash > 0 ? path.slice(0, slash) : "";
          const rowKey = `file:${bot.botId}:${path}`;
          rows.push({
            key: rowKey,
            kind: "file",
            name: `File ${path}, ${name}`,
            lead: (
              <span className="s-icon">
                <FileIcon />
              </span>
            ),
            first: middleCut(file),
            second: folder ? `${folder} · ${name}` : name,
            hint: "Names only",
            ...(fileNote === rowKey
              ? {
                  note: {
                    text: "Opening a file from search is unavailable until the gateway can bind the read to the workspace searched.",
                  },
                }
              : {}),
            open: () => setFileNote(rowKey),
          });
        }
      }
      const head: string[] = [];
      if (returned.length)
        head.push(
          `Names the gateway returned from the workspaces of ${listed(returned)}. Some folders may be skipped.`,
        );
      if (empty.length) head.push(`No file names returned from ${listed(empty)}.`);
      // Some folders may be skipped, so Files always keeps its coverage line.
      if (!returned.length && settled) head.push("Some folders may be skipped.");
      const notAsked = files.roster.filter((id) => !files.bots.some((bot) => bot.botId === id));
      const tail: string[] = [];
      if (notAsked.length) tail.push(`Not asked yet: ${listed(notAsked.map(botName))}.`);
      if (settled && searched < files.roster.length)
        tail.push(
          `${searched} of ${plural(files.roster.length, "bot's workspace", "bots' workspaces")} searched.`,
        );
      const actions = settled
        ? [
            ...retries,
            ...(notAsked.length
              ? [
                  action(
                    "files:next",
                    `Search the next ${Math.min(FILE_BATCH, notAsked.length)} bots' files`,
                    () => searchFileBots(gen, query, notAsked.slice(0, FILE_BATCH)),
                  ),
                ]
              : []),
          ]
        : [];
      return {
        ...base,
        count: rows.length,
        lines: settled ? [...head, ...lines, ...tail] : ["Searching…", ...lines],
        sections: [{ line: null, rows }],
        actions,
        searching: !settled,
        complete: false,
      };
    }

    function routinesGroup(): Group {
      const base = {
        id: "routines" as const,
        name: "Routines",
        covered: "Routine names, descriptions and bot details.",
      };
      if (routines.status === "offline") return notConnected(base);
      if (routines.status === "idle" || routines.status === "searching") return searching(base);
      if (routines.status === "failed")
        return {
          ...base,
          count: 0,
          lines: [`Couldn't search routines: ${routines.error}.`],
          tone: "danger",
          sections: [],
          actions: [action("routines:retry", "Try again", () => void routinePage(gen, query, 0))],
          searching: false,
          complete: false,
        };
      const { last, more } = routines;
      const total = last.total ?? routines.routines.length;
      const rows: Row[] = routines.routines.map((routine) => {
        const owner = botName(routine.botId);
        const onlyId =
          findIn(routine.id, query) !== null &&
          !findIn(routine.name, query) &&
          !findIn(routine.description, query) &&
          !findIn(routine.botId, query) &&
          !findIn(owner, query);
        const state = routine.enabled ? "On" : "Off";
        return {
          key: `routine:${routine.id}`,
          kind: "routine",
          name: `Routine ${routine.name}, ${owner}, ${state.toLowerCase()}. Opens routine.`,
          lead: (
            <span className="s-icon">
              <ClockIcon />
            </span>
          ),
          first: <Marked text={routine.name} query={query} />,
          second: `${owner} · ${state}${onlyId ? ` · Matched its id, ${routine.id}` : ""}`,
          hint: "Open routine",
          open: () => onOpen({ kind: "routine", botId: routine.botId, id: routine.id }),
        };
      });
      const lines: string[] = [];
      const actions: Row[] = [];
      const pagedOnce = last.offset > 0;
      if (more === "changed")
        lines.push(
          "The list of routines changed while more were loading. Search again to see it from the start.",
        );
      else if (typeof more === "object" && more !== null) {
        lines.push(`Couldn't load more routines: ${more.error}.`);
        actions.push(
          action(
            "routines:more-retry",
            "Try again",
            () => void routinePage(gen, query, last.nextOffset ?? 0),
          ),
        );
      } else if (last.hasMore && last.nextOffset !== null) {
        lines.push(`First ${routines.routines.length} of ${total}`);
        if (more === "loading") lines.push("Loading more…");
        else
          actions.push(
            action(
              "routines:more",
              `Show ${Math.min(total - routines.routines.length, last.routines.length || 50)} more routines`,
              () => void routinePage(gen, query, last.nextOffset!),
            ),
          );
      } else if (pagedOnce)
        lines.push(
          routines.revision !== null
            ? `All ${plural(total, "routine")}`
            : `${plural(routines.routines.length, "routine result")} loaded`,
        );
      else lines.push("Matches routine names, descriptions and bot details");
      return {
        ...base,
        count: rows.length,
        lines,
        sections: [{ line: null, rows }],
        actions,
        searching: more === "loading",
        complete: !last.hasMore && more === null,
      };
    }

    function action(key: string, label: string, run: () => void): Row {
      return { key, kind: "action", name: label, first: label, open: run };
    }
  }, [
    query,
    state.bots,
    state.discovery,
    tasks,
    taskByKey,
    botsById,
    botName,
    links,
    loadedConversations,
    messages,
    routines,
    files,
    gatewayName,
    fileNote,
    onOpen,
    openMessage,
    searchMessages,
    searchEach,
    retryEachBot,
    searchFileBots,
    routinePage,
  ]);

  // What is drawn: a group with results or not searched in full; the rest are named at the end.
  const drawn = groups.filter((group) => group.count > 0 || !group.complete);
  const pending = groups.some((group) => group.searching);
  const noMatches = groups.filter((group) => group.count === 0 && group.complete);

  /** The rows and actions shown, in order, with the opening line and its action under its row. */
  const view = useMemo(() => {
    const options: Row[] = [];
    const out = drawn.map((group) => {
      const total = group.sections.reduce((sum, section) => sum + section.rows.length, 0);
      const full = shown.has(group.id) || total <= FIRST_ROWS;
      let left = FIRST_ROWS;
      const sections = group.sections.map((section) => {
        const rows = full ? section.rows : section.rows.slice(0, Math.max(0, left));
        left -= rows.length;
        const withOpening = rows.flatMap((row): Row[] => {
          if (opening?.rowKey !== row.key) return [row];
          const note =
            opening.status === "loading"
              ? { text: "Opening…" }
              : opening.line
                ? {
                    text: opening.line,
                    ...(opening.status === "failed" ? { tone: "danger" as const } : {}),
                  }
                : undefined;
          const marked: Row = note ? { ...row, note } : row;
          const follow: Row[] =
            opening.status === "earlier" || opening.status === "missing"
              ? [
                  {
                    key: `${row.key}:latest`,
                    kind: "action",
                    name: "Open the task at its latest",
                    first: "Open the task at its latest",
                    open: () => {
                      const gone = goneLine(opening.hit.botId, opening.key, null, true);
                      if (gone) setOpening({ ...opening, status: "gone", line: gone });
                      else {
                        if (opened.current === opening.key) opened.current = null;
                        onOpen({ kind: "task", botId: opening.hit.botId, key: opening.key });
                      }
                    },
                  },
                ]
              : opening.status === "failed"
                ? [
                    {
                      key: `${row.key}:retry`,
                      kind: "action",
                      name: "Try again",
                      first: "Try again",
                      open: () => {
                        const retry: Opening = {
                          ...opening,
                          status: "loading",
                          line: null,
                          reread: true,
                        };
                        // The bridge keeps one entry per task. The shell's task stays the shell's:
                        // reopened only while the shell still holds it, even after search closes,
                        // and never closed by search. Any other task search holds from here, as
                        // when it opens one, and reopens only while this search is current.
                        const shell = holds(opening.key);
                        if (!shell && opened.current !== opening.key) {
                          if (opened.current)
                            void bridge.send({ type: "closeSession", key: opened.current });
                          opened.current = opening.key;
                        }
                        void bridge
                          .send({ type: "closeSession", key: opening.key })
                          .then(
                            () =>
                              (shell ? holds(opening.key) : retry.gen === generation.current) &&
                              load(retry),
                          );
                        setOpening(retry);
                      },
                    },
                  ]
                : [];
          return [marked, ...follow];
        });
        options.push(...withOpening);
        return { ...section, rows: withOpening };
      });
      const [one, many] = GROUP_WORD[group.id];
      const showAll: Row[] = full
        ? []
        : [
            {
              key: `${group.id}:all`,
              kind: "action",
              name: `Show all ${total} ${total === 1 ? one : many}`,
              first: `Show all ${total} ${total === 1 ? one : many}`,
              open: () => setShown((now) => new Set([...now, group.id])),
            },
          ];
      const actions = [...showAll, ...group.actions];
      options.push(...actions);
      return { group, sections, actions };
    });
    return { groups: out, options };
  }, [drawn, shown, opening, goneLine, onOpen, bridge, load, holds]);

  const options = view.options;
  const active = options.find((row) => row.key === activeKey) ?? options[0] ?? null;
  // The active row is held by identity, so a group filling in above it does not move it.
  useEffect(() => {
    if (activeKey === null && active) setActiveKey(active.key);
  }, [activeKey, active]);
  const activeId = active ? `s-opt-${cssId(active.key)}` : undefined;

  useEffect(() => {
    if (!activeId) return;
    document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  // The live region says only what the screen says, once nothing in view is pending.
  useEffect(() => {
    if (!query || pending) {
      setSaid("");
      return;
    }
    const timer = setTimeout(() => setSaid(announcement(drawn, noMatches)), SAY_AFTER_MS);
    return () => clearTimeout(timer);
    // `drawn` and `noMatches` follow from `groups`.
  }, [query, pending, groups]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    fieldRef.current?.focus();
  }, []);

  const move = (to: number) => {
    const next = options[Math.max(0, Math.min(options.length - 1, to))];
    if (next) setActiveKey(next.key);
  };
  const groupStarts = view.groups
    .map(({ sections, actions }) => sections.flatMap((section) => section.rows)[0] ?? actions[0])
    .filter((row): row is Row => row !== undefined)
    .map((row) => options.indexOf(row));
  const index = active ? options.indexOf(active) : -1;

  const onKey = (event: KeyboardEvent<HTMLElement>) => {
    // The window's own shortcuts stay behind the palette while it is open.
    event.stopPropagation();
    const command = mac ? event.metaKey : event.ctrlKey;
    if (command && event.key.toLowerCase() === "k") {
      event.preventDefault();
      fieldRef.current?.select();
      return;
    }
    // An input method's keys, and Cancel's own, are left alone: only the field moves the list.
    if (event.nativeEvent.isComposing || event.target !== fieldRef.current) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(index - 1);
    } else if (event.key === "PageDown") {
      event.preventDefault();
      const next = groupStarts.find((start) => start > index);
      if (next !== undefined) move(next);
    } else if (event.key === "PageUp") {
      event.preventDefault();
      const previous = groupStarts.filter((start) => start < index).at(-1);
      if (previous !== undefined) move(previous);
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      active?.open();
    } else if (event.key === "Enter") {
      // Shift+Enter hands a link to the browser only once the link confirmation exists (#71).
      event.preventDefault();
    } else if (event.key === "Tab" && !cancelRef.current?.checkVisibility()) {
      // The field is the palette's one stop; where Cancel shows (the phone), Tab reaches it.
      event.preventDefault();
    }
  };

  const covered = [
    ["Bots", "Every bot this connection can see, by name."],
    [
      "Tasks",
      `Titles in this device's task list, which keeps up to ${LISTED} tasks.${state.discovery.partial ? " It was cut short, so it holds the most recent tasks only." : ""}`,
    ],
    [
      "Messages",
      "User messages and bot replies in tasks this gateway lets you see. Excludes routine runs, subagent tasks and archived tasks.",
    ],
    [
      "Files",
      "File names returned from workspaces the palette can verify. Some folders may be skipped.",
    ],
    [
      "Links",
      loadedConversations
        ? `Links in the conversations loaded on this device: ${loadedConversations} now.`
        : "Links in conversations you open. None is loaded now.",
    ],
    ["Routines", "Routine names, descriptions and bot details."],
    ["Settings", "The sections of Clawtrate's Settings."],
  ] as const;

  return (
    <dialog
      ref={dialogRef}
      className="search-layer"
      aria-label="Search"
      data-testid="search-palette"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="s-scrim" onClick={onClose} />
      <div className="s-palette" onKeyDown={onKey}>
        <div className="s-top">
          <span className="s-glass">
            <SearchIcon />
          </span>
          <input
            ref={fieldRef}
            className="s-field"
            type="text"
            role="combobox"
            aria-label="Search"
            aria-expanded={query !== ""}
            aria-controls="s-results"
            aria-autocomplete="list"
            aria-activedescendant={query ? activeId : undefined}
            placeholder="Search bots, tasks, messages, files, links, routines and settings"
            maxLength={MAX_SEARCH_QUERY_CHARS}
            autoComplete="off"
            spellCheck={false}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <button
            ref={cancelRef}
            type="button"
            className="button s-cancel"
            data-variant="quiet"
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
        <div className="s-body" ref={listRef}>
          {!query ? (
            <div className="s-idle" data-testid="search-idle">
              <h2 className="s-group-name">What search looks in</h2>
              <dl>
                {covered.map(([name, line]) => (
                  <div key={name}>
                    <dt>{name}</dt>
                    <dd>{line}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : (
            <div id="s-results" role="listbox" aria-label="Results">
              {view.groups.map(({ group, sections, actions }) => (
                <div
                  key={group.id}
                  className="s-group"
                  role="group"
                  aria-labelledby={`s-g-${group.id}`}
                  aria-describedby={group.lines.length ? `s-l-${group.id}` : undefined}
                  data-group={group.id}
                  data-tone={group.tone}
                  data-testid={`search-group-${group.id}`}
                >
                  <div className="s-group-head" role="presentation">
                    <p className="s-group-name" id={`s-g-${group.id}`}>
                      {group.name}
                      {group.count > 0 ? ` · ${group.count}` : ""}
                    </p>
                    {group.lines.length > 0 && (
                      <div className="s-group-lines" id={`s-l-${group.id}`}>
                        {group.lines.map((line) => (
                          <span className="s-line" key={line}>
                            {line}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  {group.searching && group.count === 0 && (
                    <div className="s-skeleton" aria-hidden="true">
                      <span />
                      <span />
                    </div>
                  )}
                  {sections.map((section, i) => (
                    <div key={i} role="presentation">
                      {section.line && (
                        <div className="s-sub" data-tone={section.tone} role="presentation">
                          <span className="s-sub-line">{section.line}</span>
                        </div>
                      )}
                      {section.rows.map((row) => (
                        <Option
                          key={row.key}
                          row={row}
                          active={row === active}
                          onPick={setActiveKey}
                        />
                      ))}
                    </div>
                  ))}
                  {actions.map((row) => (
                    <Option key={row.key} row={row} active={row === active} onPick={setActiveKey} />
                  ))}
                </div>
              ))}
              {!pending && noMatches.length > 0 && (
                <div className="s-nomatch" role="presentation" data-testid="search-no-matches">
                  <p className="s-group-name">
                    No matches in {listed(noMatches.map((group) => group.name))}
                  </p>
                  <dl>
                    {noMatches.map((group) => (
                      <div key={group.id}>
                        <dt>{group.name}</dt>
                        <dd>{group.covered}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}
            </div>
          )}
        </div>
        <p className="s-foot">↑↓ Move · ↵ Open · Esc Close</p>
        <p
          className="visually-hidden"
          role="status"
          aria-live="polite"
          data-testid="search-announcer"
        >
          {said}
        </p>
      </div>
    </dialog>
  );
}

const cssId = (key: string) => key.replace(/[^A-Za-z0-9-]/g, (char) => `_${char.charCodeAt(0)}_`);

function Option({
  row,
  active,
  onPick,
}: {
  row: Row;
  active: boolean;
  onPick: (key: string) => void;
}) {
  return (
    <div
      id={`s-opt-${cssId(row.key)}`}
      className={row.kind === "action" ? "s-row s-action" : "s-row"}
      role="option"
      aria-selected={active}
      aria-label={row.note ? `${row.name} ${row.note.text}` : row.name}
      data-kind={row.kind}
      data-testid="search-option"
      onMouseMove={() => {
        if (!active) onPick(row.key);
      }}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        onPick(row.key);
        row.open();
      }}
    >
      {row.lead && <span className="s-lead">{row.lead}</span>}
      <span className="s-text">
        <span className="s-first">{row.first}</span>
        {row.address && (
          <span className="s-address" data-refused={row.address.refused || undefined}>
            {row.address.text}
          </span>
        )}
        {row.second && <span className="s-second">{row.second}</span>}
        {row.note && (
          <span className="s-note" data-tone={row.note.tone} data-testid="search-row-note">
            {row.note.text}
          </span>
        )}
      </span>
      {row.hint && (
        <span className="s-hint" aria-hidden="true">
          {row.hint}
        </span>
      )}
    </div>
  );
}

/** The live region's words, drawn from the same groups as the list (search.md §12). */
function announcement(drawn: Group[], none: Group[]): string {
  const noMatch = none.length ? `No matches in ${listed(none.map((group) => group.name))}.` : "";
  const limited = drawn.filter((group) => !group.complete);
  if (limited.length === 0) {
    const counts = drawn.map((group) =>
      plural(group.count, GROUP_WORD[group.id][0], GROUP_WORD[group.id][1]),
    );
    const total = drawn.reduce((sum, group) => sum + group.count, 0);
    return [`${plural(total, "result")}: ${counts.join(", ")}.`, noMatch].filter(Boolean).join(" ");
  }
  const limits = limited.flatMap((group) => {
    if (group.tone === "danger") return [`${group.name} couldn't be searched.`];
    if (
      group.id === "messages" &&
      group.lines.some((line) => line.includes("More indexed messages match"))
    )
      return ["More messages match."];
    if (group.id === "files")
      return group.lines.some((line) => line.startsWith("Type 2"))
        ? ["Files weren't searched: type 2 or more characters."]
        : ["Some folders may be skipped."];
    if (group.id === "links") return ["No conversation is loaded, so no links were searched."];
    return group.lines.slice(0, 1);
  });
  return [noMatch, ...limits].filter(Boolean).join(" ");
}
