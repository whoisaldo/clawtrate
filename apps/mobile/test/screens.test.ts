import {
  callFromBlock,
  emptyActivity,
  enforceState,
  newRun,
  foldLineOf,
  initialState,
  lineOf,
  type Bot,
  type ClawtrateState,
  type Task,
  type Transcript,
  type TranscriptBlock,
  type TranscriptItem,
} from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { addressAttemptInProgress, addressSubmission } from "../src/address.ts";
import { homeModel, taskRows } from "../src/lists.ts";
import { back, connectView, current, HOME, inShell, keptMismatch } from "../src/navigation.ts";
import { chatRows, runningWords } from "../src/transcript.ts";

const LIVE = { connected: true, closed: false };
const KEY = "agent:otto:disk";

const NOW = new Date(2026, 10, 18, 9, 30).getTime();

describe("submitting the iPhone gateway address", () => {
  const saved = "wss://gateway.example/route?tenant=demo";
  const shown = "wss://gateway.example/route";

  it("keeps the saved endpoint and credential when the form is unchanged", () => {
    expect(addressSubmission(saved, shown, "")).toEqual({ type: "retry" });
    expect(addressSubmission(saved, shown, "replacement")).toEqual({
      type: "connect",
      url: saved,
      token: "replacement",
    });
  });

  it("uses the current form values after an edit", () => {
    expect(addressSubmission(saved, " wss://other.example ", "replacement")).toEqual({
      type: "connect",
      url: "wss://other.example",
      token: "replacement",
    });
    expect(addressSubmission(saved, " ", "replacement")).toBeNull();
  });

  it("blocks submissions during an attempt and allows them while waiting to retry", () => {
    const connection = { ...initialState.connection, status: "connecting" as const };
    expect(addressAttemptInProgress(connection)).toBe(true);
    expect(addressAttemptInProgress({ ...connection, retryAt: NOW })).toBe(false);
    expect(addressAttemptInProgress({ ...connection, status: "error" })).toBe(false);
  });
});

function bot(id: string, extra: Partial<Bot> = {}): Bot {
  return {
    id,
    name: id[0]!.toUpperCase() + id.slice(1),
    emoji: null,
    avatarUrl: null,
    theme: null,
    model: null,
    isDefault: false,
    ...extra,
  };
}

function task(key: string, updatedAt: number | null, extra: Partial<Task> = {}): Task {
  const botId = key.split(":")[1]!;
  return {
    key,
    botId,
    sessionId: null,
    title: key.split(":")[2]!,
    preview: null,
    updatedAt,
    status: "idle",
    unread: false,
    ...extra,
  };
}

function state(extra: Partial<ClawtrateState> = {}): ClawtrateState {
  return {
    ...initialState,
    connection: {
      ...initialState.connection,
      status: "connected",
      gatewayUrl: "ws://127.0.0.1:19201",
    },
    discovery: { status: "ready", error: null, partial: false },
    ...extra,
  };
}

describe("the iPhone app's screens", () => {
  it("F-003: opens Home as soon as the bots have loaded, before their tasks, and shows the steps until then", () => {
    const loading = state({ discovery: { status: "loading", error: null, partial: false } });
    expect(inShell(loading, null)).toBe(false);
    expect(connectView(loading, null, true)).toBe("setup");
    const withBots = { ...loading, bots: [bot("otto")] };
    expect(inShell(withBots, null)).toBe(true);
    // Until its tasks arrive the row says so.
    expect(homeModel(withBots, {}, NOW).rows[0]!.preview).toBe("Loading tasks");
  });

  it("chooses the welcome screen first, then the address, the steps, the pairing and the protocol notice", () => {
    const idle = { ...initialState };
    expect(connectView(idle, null, false)).toBe("welcome");
    // A gateway kept but not reopened (an earlier install's, or after Disconnect) is a choice on the welcome screen.
    const kept = state({
      connection: {
        ...initialState.connection,
        status: "disconnected",
        gatewayUrl: "ws://127.0.0.1:1",
      },
    });
    expect(connectView(kept, null, false)).toBe("welcome");
    expect(connectView(kept, null, true)).toBe("address");
    expect(connectView(idle, null, true)).toBe("address");
    const connecting = state({
      connection: {
        ...initialState.connection,
        status: "connecting",
        gatewayUrl: "ws://127.0.0.1:1",
      },
    });
    expect(connectView(connecting, null, true)).toBe("setup");
    const failed = state({
      connection: {
        ...initialState.connection,
        status: "error",
        gatewayUrl: "ws://127.0.0.1:1",
        error: { code: "UNREACHABLE", message: "x", hint: null },
      },
    });
    expect(connectView(failed, null, false)).toBe("address");
    const pairing = state({
      connection: {
        ...initialState.connection,
        status: "pairing",
        gatewayUrl: "ws://127.0.0.1:1",
        pairing: {
          requestId: "r",
          deviceId: "d",
          message: "",
          approveCommand: "c",
          approveNote: null,
          requestedScopes: ["operator.read"],
        },
      },
    });
    expect(connectView(pairing, null, true)).toBe("pairing");
    const mismatch = {
      code: "PROTOCOL_MISMATCH",
      message: "m",
      hint: null,
      protocol: { gateway: 5, client: 4 },
    };
    // A mismatch stays while Retry repeats the handshake, and goes once a pairing starts.
    expect(
      keptMismatch({ ...failed, connection: { ...failed.connection, error: mismatch } }, null),
    ).toBe(mismatch);
    expect(keptMismatch(connecting, mismatch)).toBe(mismatch);
    expect(keptMismatch(pairing, mismatch)).toBeNull();
    expect(connectView(connecting, mismatch, true)).toBe("protocol");
    expect(inShell(state({ bots: [bot("otto")] }), mismatch)).toBe(false);
  });

  it("F-427: Back goes from a task's chat to its bot's task list, and from there to Home", () => {
    const chat = { name: "task", botId: "otto", key: "agent:otto:a" } as const;
    expect(back(chat)).toEqual({ name: "bot", botId: "otto" });
    expect(back(back(chat))).toEqual(HOME);
    // A bot or task the gateway no longer lists falls back to what is there.
    const s = state({ bots: [bot("otto")], tasksByBot: { otto: [task("agent:otto:b", 1)] } });
    expect(current(chat, s)).toEqual({ name: "bot", botId: "otto" });
    expect(current({ name: "bot", botId: "pip" }, s)).toEqual(HOME);
    expect(current(chat, { ...s, tasksByBot: { otto: [task("agent:otto:a", 1)] } })).toEqual(chat);
  });

  it("lists pinned bots first, then the rest by their latest activity, without hidden bots, in the rail's words", () => {
    const bots = [
      bot("main", { name: "Juniper", isDefault: true, theme: "research" }),
      bot("otto"),
      bot("pip"),
      bot("marlow"),
    ];
    const s = state({
      bots,
      tasksByBot: {
        main: [task("agent:main:a", NOW - 3 * 86_400_000, { preview: "A summary of the week" })],
        otto: [
          task("agent:otto:disk", NOW - 60_000, { status: "running" }),
          task("agent:otto:old", NOW - 86_400_000, { unread: true }),
        ],
        pip: [task("agent:pip:plan", NOW - 120_000, { preview: "Saturday's route" })],
        marlow: [],
      },
      sidebar: {
        status: "ok",
        prefs: { pins: ["pip"], sections: [], hidden: ["marlow"], order: [] },
      },
    });
    const model = homeModel(s, {}, NOW);
    expect(model.pinned.map((row) => row.bot.id)).toEqual(["pip"]);
    expect(model.rows.map((row) => row.bot.id)).toEqual(["otto", "main"]);
    const [otto, juniper] = model.rows;
    expect(otto).toMatchObject({ time: "now", state: "working", unread: true, preview: "disk" });
    expect(otto!.spoken).toBe("Otto, working, 2 tasks, unread");
    expect(juniper).toMatchObject({
      label: "research",
      primary: true,
      preview: "A summary of the week",
      unread: false,
    });
    expect(juniper!.spoken).toBe("Juniper, 1 task, research, primary bot");
    // Read on this device, the dot goes.
    expect(homeModel(s, { "agent:otto:old": NOW - 86_400_000 }, NOW).rows[0]!.unread).toBe(false);
  });

  it("gives each task row its title, time and one mark, newest first as the engine orders them", () => {
    const rows = taskRows(
      [
        task("agent:otto:disk", NOW - 60_000, { status: "running" }),
        task("agent:otto:old", new Date(2026, 10, 9).getTime(), { unread: true }),
        task("agent:otto:none", null),
      ],
      {},
      NOW,
    );
    expect(rows.map((row) => [row.title, row.time, row.state, row.unread])).toEqual([
      ["disk", "now", "working", false],
      ["old", "Nov 9", null, true],
      ["none", "", null, false],
    ]);
    expect(rows[0]!.spoken).toBe("disk, working");
    expect(rows[1]!.spoken).toBe("old, unread");
  });

  it("does not use a live Home state or relative time for an offline cached run", () => {
    const otto = bot("otto");
    const offline = state({
      connection: { ...initialState.connection, status: "disconnected" },
      bots: [otto],
      tasksByBot: { otto: [task(KEY, NOW - 60_000, { status: "running" })] },
    });
    const row = homeModel(offline, {}, NOW).rows[0]!;
    expect(row.spoken).not.toMatch(/, working,/i);
    expect(row.time).not.toBe("now");
    const [cached] = taskRows(offline.tasksByBot.otto!, {}, NOW, false);
    expect([cached!.state, cached!.time, cached!.spoken]).toEqual([null, "9:29 AM", "disk"]);
  });

  it("does not tell this read-only reader to approve work on Home or in a task row", () => {
    const otto = bot("otto");
    const waiting = task(KEY, NOW - 60_000, { status: "waiting", waitingFor: "approval" });
    const row = homeModel(state({ bots: [otto], tasksByBot: { otto: [waiting] } }), {}, NOW)
      .rows[0]!;
    expect(`${row.preview} ${row.spoken}`).not.toMatch(/for you|approve a command|needs you/i);
    expect(row.waiting).toBe(false);
    expect(taskRows([waiting], {}, NOW)[0]!.spoken).not.toMatch(/needs you/i);
  });

  it("claims no task count before discovery gives one, and says when the tasks could not be loaded", () => {
    const otto = bot("otto");
    const loading = state({
      discovery: { status: "loading", error: null, partial: false },
      bots: [otto],
    });
    expect(homeModel(loading, {}, NOW).rows[0]).toMatchObject({
      spoken: "Otto",
      preview: "Loading tasks",
    });
    const failed = {
      ...loading,
      discovery: { status: "error" as const, error: "x", partial: false },
    };
    expect(homeModel(failed, {}, NOW).rows[0]).toMatchObject({
      spoken: "Otto",
      preview: "Couldn't load tasks",
    });
    // Ready with no key for the bot: the engine omits a bot with no task rows.
    expect(homeModel(state({ bots: [otto] }), {}, NOW).rows[0]).toMatchObject({
      spoken: "Otto, 0 tasks",
      preview: "No tasks yet",
    });
  });
});

function transcript(items: TranscriptItem[]): Transcript {
  return {
    ...emptyActivity,
    linkedRuns: {},
    interSession: [],
    mcpTools: {},
    sessionKey: "agent:otto:disk",
    status: "ready",
    items,
    error: null,
    hasMore: false,
    live: null,
    loadedAt: 1,
  };
}

const read = (id: string, path: string): Extract<TranscriptBlock, { kind: "tool-call" }> => ({
  kind: "tool-call",
  callId: id,
  name: "read",
  argumentsText: JSON.stringify({ path }),
  result: { isError: false, text: `contents of ${path}` },
});

describe("the iPhone chat's rows", () => {
  const at = new Date(2026, 10, 18, 9, 0).getTime();
  const items: TranscriptItem[] = [
    {
      id: "u1",
      role: "user",
      timestamp: at,
      blocks: [{ kind: "text", text: "What is eating the space?" }],
      model: null,
    },
    {
      id: "a1",
      role: "assistant",
      timestamp: at + 60_000,
      model: null,
      blocks: [
        { kind: "reasoning", text: "Look at the files first." },
        read("c1", "AGENTS.md"),
        { kind: "text", text: "On it: the **media** folder." },
        read("c2", "notes/a.md"),
        read("c3", "notes/b.md"),
        { kind: "text", text: "Done." },
      ],
    },
    {
      id: "s1",
      role: "system",
      timestamp: at + 30 * 60_000,
      blocks: [{ kind: "text", text: "Session reset" }],
      model: null,
    },
  ];

  it("puts stamps before the first message and after ten quiet minutes, bubbles in order, and each action as a line in the engine's words", () => {
    const rows = chatRows(task("agent:otto:disk", at), transcript(items), "Otto", NOW, LIVE);
    expect(rows.map((row) => row.kind)).toEqual([
      "stamp",
      "user",
      "action",
      "bot",
      "action",
      "bot",
      "stamp",
      "event",
    ]);
    expect(rows[0]).toMatchObject({
      kind: "stamp",
      text: expect.stringMatching(/^Today 9:00\sAM$/),
    });
    expect(rows[1]).toMatchObject({ text: "What is eating the space?" });
    // One read is one line; two reads in a row share one, as the desktop folds them.
    const ctx = {};
    expect(rows[2]).toMatchObject({
      kind: "action",
      text: lineOf(callFromBlock(read("c1", "AGENTS.md"), undefined, undefined), ctx).title,
    });
    expect(rows[2]!.kind === "action" && rows[2]!.text).toContain("AGENTS.md");
    expect(rows[4]).toMatchObject({
      kind: "action",
      text: foldLineOf(
        [read("c2", "notes/a.md"), read("c3", "notes/b.md")].map((b) =>
          callFromBlock(b, undefined, undefined),
        ),
        ctx,
      ).title,
    });
    expect(rows[3]).toMatchObject({ kind: "bot", text: "On it: the **media** folder." });
    expect(rows[7]).toMatchObject({ kind: "event", text: "Session reset" });
    // Reasoning stays folded away.
    expect(JSON.stringify(rows)).not.toContain("Look at the files first.");
  });

  it("says a task runs while the gateway reports it running, and says nothing of it once it ends", () => {
    const running = chatRows(
      task("agent:otto:disk", at, { status: "running" }),
      transcript(items),
      "Otto",
      NOW,
      LIVE,
    );
    expect(running.at(-1)).toEqual({
      kind: "running",
      id: "running",
      text: "The gateway reports a run for Otto.",
      tone: "live",
    });
    const done = chatRows(
      task("agent:otto:disk", at, { status: "done" }),
      transcript(items),
      "Otto",
      NOW,
      LIVE,
    );
    expect(done.some((row) => row.kind === "running")).toBe(false);
  });

  it("never says a cached task is working while the connection is lost or closed, and says which", () => {
    const cached = task("agent:otto:disk", at, { status: "running" });
    expect(
      runningWords(cached, transcript([]), "Otto", { connected: false, closed: false }),
    ).toEqual({
      text: "Reconnecting. Last seen working",
      tone: "lost",
    });
    expect(
      runningWords(cached, transcript([]), "Otto", { connected: false, closed: true }),
    ).toEqual({
      text: "Disconnected. Last seen working",
      tone: "off",
    });
    // A task opened while offline has no transcript: the gateway's row says what was last seen.
    expect(runningWords(cached, undefined, "Otto", { connected: false, closed: true })).toEqual({
      text: "Disconnected. Last seen working",
      tone: "off",
    });
    // With a run loaded, the status line's words, closed or dropped.
    const live = {
      ...transcript([]),
      runs: [newRun("run-1", { state: "running", origin: "local", bound: true }, 1)],
    };
    expect(runningWords(cached, live, "Otto", { connected: false, closed: true })?.text).toBe(
      "Disconnected. Last seen thinking",
    );
  });

  it("shows text that streams with no tool running, and says the bot is writing, not thinking", () => {
    const run = {
      ...newRun("run-1", { state: "running", origin: "local", bound: true }, 1),
      text: "Half a reply",
    };
    const rows = chatRows(
      task("agent:otto:disk", at, { status: "running" }),
      { ...transcript([]), runs: [run] },
      "Otto",
      NOW,
      LIVE,
    );
    expect(rows.slice(-2)).toEqual([
      { kind: "bot", id: "live:run-1", text: "Half a reply" },
      { kind: "running", id: "running", text: "Writing", tone: "live" },
    ]);
  });

  it("keeps cut live text and its shortening note when history is unavailable offline", () => {
    const run = {
      ...newRun("run-1", { state: "running", origin: "local", bound: true }, 1),
      text: "Part of a reply",
      cut: ["text"],
    };
    const rows = chatRows(
      task(KEY, at, { status: "running" }),
      { ...transcript([]), status: "error", runs: [run] },
      "Otto",
      NOW,
      { connected: false, closed: false },
    );
    expect(rows.slice(0, 2)).toEqual([
      { kind: "bot", id: "live:run-1", text: "Part of a reply" },
      {
        kind: "note",
        id: "shortened:live:run-1",
        text: "Shortened here. Some of this message is missing from this view.",
      },
    ]);
  });

  it("says a message is shortened when the engine cut it or the gateway truncated it, and that earlier messages are not loaded", () => {
    const long: TranscriptItem = {
      id: "a2",
      role: "assistant",
      timestamp: at,
      model: null,
      blocks: [{ kind: "text", text: `${"word ".repeat(500)}Last sentence.` }],
    };
    const bounded = enforceState({
      ...initialState,
      transcripts: { [KEY]: { ...transcript([long]), hasMore: true } },
    }).transcripts[KEY]!;
    const rows = chatRows(task(KEY, at), bounded, "Otto", NOW, LIVE);
    expect(rows[0]).toEqual({
      kind: "note",
      id: "earlier",
      text: "Only part of this task's history is loaded here, so earlier messages may be missing.",
    });
    expect(rows.find((row) => row.kind === "note" && row.id === "shortened:a2")?.text).toBe(
      "Shortened here. Some of this message is missing from this view.",
    );
    const truncated = chatRows(
      task(KEY, at),
      transcript([{ ...items[0]!, truncated: true }]),
      "Otto",
      NOW,
      LIVE,
    );
    expect(truncated.map((row) => row.kind)).toEqual(["stamp", "user", "note"]);
    expect(truncated[2]).toMatchObject({
      text: "Truncated by the gateway. The rest was not sent.",
    });
    expect(
      chatRows(task(KEY, at), transcript(items), "Otto", NOW, LIVE).some(
        (row) => row.kind === "note",
      ),
    ).toBe(false);
  });

  it("does not say only the first part is kept when a later block of the shortened message is whole", () => {
    const mixed: TranscriptItem = {
      id: "mixed",
      role: "assistant",
      timestamp: at,
      model: null,
      blocks: [
        { kind: "text", text: `${"word ".repeat(500)}Missing tail of first block.` },
        { kind: "text", text: "Final block is whole." },
      ],
    };
    const bounded = enforceState({
      ...initialState,
      transcripts: { [KEY]: transcript([mixed]) },
    }).transcripts[KEY]!;
    const rows = chatRows(task(KEY, at, { status: "done" }), bounded, "Otto", NOW, LIVE);
    expect(rows.some((row) => row.kind === "bot" && row.text === "Final block is whole.")).toBe(
      true,
    );
    expect(rows.find((row) => row.kind === "note")?.text).toBe(
      "Shortened here. Some of this message is missing from this view.",
    );
  });
});
