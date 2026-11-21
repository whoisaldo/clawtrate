// Usage and warning budgets (docs/design/controls.md, sections 16 and 17), on
// the shapes OpenClaw 2026.10.6 returned on a development gateway: `usage.cost`,
// `sessions.usage`, `chat.history` rows and `usage.status`.

import { afterEach, describe, expect, it, vi } from "vitest";
import { parseBridgeCommand } from "../src/bridge.ts";
import { ClawtrateClient } from "../src/client.ts";
import { enforceState, initialState } from "../src/index.ts";
import {
  COUNT_AFTER_RUN_MS,
  COUNT_COUNTING_MS,
  COUNT_EVERY_MS,
  LIMITS_EVERY_MS,
  MAX_USAGE_REPORTS,
  USAGE_REQUESTS_AT_ONCE,
  UsageEngine,
  type UsageContext,
  type UsageReportRequest,
} from "../src/usage-engine.ts";
import {
  applyBudgetChange,
  BudgetError,
  budgetPercent,
  budgetTokens,
  BUDGETS_PREF_KEY,
  costOf,
  currentCount,
  dateIn,
  figureOf,
  initialUsage,
  isoWeekday,
  MAX_BUDGETS,
  parseBudgets,
  parseLimits,
  rangeFor,
  routineOfKey,
  routinesOf,
  runsOfHistory,
  sentRunIds,
  tasksOf,
  type BudgetInput,
  type UsageState,
} from "../src/usage.ts";
import { INTERACTIVE_SCOPES, READ_SCOPES } from "../src/scopes.ts";
import { FAST, grantingGateway, URL_A, URL_B } from "./client-harness.ts";
import { deferred, memoryStorage, testHost, tokenKey, until } from "./fake-gateway.ts";

// Thursday 19 November 2026, 06:00 UTC: 01:00 in New York, 15:00 in Tokyo.
const NOW = Date.UTC(2026, 10, 19, 6, 0, 0);
const NY = "America/New_York";

const totals = (input: number, output: number, cost: Partial<Record<string, number>> = {}) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + output,
  totalCost: 0,
  inputCost: 0,
  outputCost: 0,
  cacheReadCost: 0,
  cacheWriteCost: 0,
  missingCostEntries: 0,
  ...cost,
});
const fresh = { status: "fresh", cachedFiles: 4, pendingFiles: 0, staleFiles: 0 };

const assistant = (runId: string, at: number, tokens = 200) => ({
  role: "assistant",
  provider: "scripted",
  model: "dev-1",
  usage: {
    input: tokens * 0.6,
    output: tokens * 0.4,
    totalTokens: tokens,
    cacheRead: 0,
    cacheWrite: 0,
  },
  timestamp: at,
  __openclaw: { runId },
});
const person = (runId: string, at: number) => ({
  role: "user",
  timestamp: at,
  idempotencyKey: `${runId}:user`,
  __openclaw: { senderIdentity: { type: "profile", id: "gateway-owner" } },
  content: "Reply with a note on Saturday's plan.",
});
const fromBot = (runId: string, at: number, source: string) => ({
  role: "assistant",
  timestamp: at,
  idempotencyKey: `${runId}:user`,
  provenance: {
    kind: "inter_session",
    sourceSessionKey: source,
    sourceChannel: "webchat",
    sourceTool: "sessions_send",
  },
  content: "#reply Could you look over the plan?",
});
const sendResult = (recipient: string, runId: string | null, status = "ok") => ({
  role: "toolResult",
  toolName: "sessions_send",
  details: { sessionKey: recipient },
  isError: false,
  content: [
    {
      type: "text",
      text: JSON.stringify({ ...(runId ? { runId } : {}), sessionKey: recipient, status }),
    },
  ],
});

describe("periods", () => {
  it("F-234: a Daily budget counts today and a Weekly one Monday to today, in its own time zone", () => {
    expect(dateIn(NOW, NY)).toBe("2026-11-19");
    expect(dateIn(NOW, "Pacific/Pago_Pago")).toBe("2026-11-18");
    expect(isoWeekday("2026-11-16")).toBe(1);
    expect(isoWeekday("2026-11-22")).toBe(7);
    expect(rangeFor("daily", NOW, NY)).toEqual({
      startDate: "2026-11-19",
      endDate: "2026-11-19",
      timeZone: NY,
    });
    expect(rangeFor("weekly", NOW, NY)).toEqual({
      startDate: "2026-11-16",
      endDate: "2026-11-19",
      timeZone: NY,
    });
    // On a Monday the week is that one day; on a Sunday it runs back to Monday.
    expect(rangeFor("weekly", Date.UTC(2026, 10, 16, 12), NY).startDate).toBe("2026-11-16");
    expect(rangeFor("weekly", Date.UTC(2026, 10, 23, 3), NY)).toMatchObject({
      startDate: "2026-11-16",
      endDate: "2026-11-22",
    });
    expect(rangeFor("month", NOW, NY)).toMatchObject({
      startDate: "2026-10-21",
      endDate: "2026-11-19",
    });
    // The same moment is another day, and another week, somewhere else.
    expect(rangeFor("weekly", Date.UTC(2026, 10, 16, 3), NY).startDate).toBe("2026-11-09");
    expect(rangeFor("weekly", Date.UTC(2026, 10, 16, 3), "Asia/Tokyo").startDate).toBe(
      "2026-11-16",
    );
  });

  it("a run is in a period when its date in the period's time zone is one of the days asked of the gateway, across a change of the clocks", () => {
    const runAt = (at: number, range: { startDate: string; endDate: string; timeZone: string }) =>
      runsOfHistory([person("r", at - 1), assistant("r", at)], range).map((run) => run.tokens);
    // Cairo's 24 April 2026 has no midnight: the clocks go from 23:59 on the 23rd to 01:00.
    // The gateway's day starts at 22:00 UTC, so a run at 21:30 UTC (23:30 on the 23rd) is not in it.
    const cairo = { startDate: "2026-04-24", endDate: "2026-04-24", timeZone: "Africa/Cairo" };
    expect(runAt(Date.parse("2026-04-23T21:30:00Z"), cairo)).toEqual([]);
    expect(runAt(Date.parse("2026-04-23T22:00:00Z"), cairo)).toEqual([200]);
    // After the change it is UTC+3: the day has 23 hours and ends at 21:00 UTC.
    expect(runAt(Date.parse("2026-04-24T20:59:59Z"), cairo)).toEqual([200]);
    expect(runAt(Date.parse("2026-04-24T21:00:00Z"), cairo)).toEqual([]);
    // New York's 1 November 2026 has 25 hours, 04:00 UTC to 05:00 UTC the next day.
    const fall = { startDate: "2026-11-01", endDate: "2026-11-01", timeZone: NY };
    expect(runAt(Date.parse("2026-11-01T03:59:59Z"), fall)).toEqual([]);
    expect(runAt(Date.parse("2026-11-02T04:59:59Z"), fall)).toEqual([200]);
    expect(runAt(Date.parse("2026-11-02T05:00:00Z"), fall)).toEqual([]);
  });
});

describe("the gateway's figures", () => {
  it("F-232: tokens are the gateway's totals, and the cost is its estimate or a stated absence, never a zero", () => {
    const figure = figureOf({
      updatedAt: 1234,
      totals: totals(1080, 720, { totalCost: 0.42, inputCost: 0.3, outputCost: 0.12 }),
      cacheStatus: fresh,
    });
    expect(figure).toEqual({
      tokens: { input: 1080, output: 720, cacheRead: 0, cacheWrite: 0, total: 1800 },
      cost: { status: "estimate", usd: 0.42 },
      asOf: 1234,
      counting: false,
    });
    expect(costOf(totals(1, 1, { totalCost: 0.1, inputCost: 0.1, missingCostEntries: 2 }))).toEqual(
      { status: "partial", usd: 0.1, unpriced: 2 },
    );
    expect(costOf(totals(1, 1, { missingCostEntries: 3 }))).toEqual({
      status: "unavailable",
      unpriced: 3,
    });
    // A configured price of zero is an estimate of zero, not an absence.
    expect(costOf(totals(1, 1))).toEqual({ status: "estimate", usd: 0 });
    // A total that gives no cost at all is no estimate of $0.00.
    expect(costOf({ totalTokens: 1000 })).toEqual({ status: "unavailable", unpriced: 0 });
    expect(figureOf({ totals: { totalTokens: 1000 } }).tokens.total).toBe(1000);
  });

  it("F-232: says the figure is still being counted when the gateway's records are being read", () => {
    expect(
      figureOf({
        totals: totals(1, 1),
        cacheStatus: { status: "refreshing", pendingFiles: 8, staleFiles: 8 },
      }).counting,
    ).toBe(true);
    expect(figureOf({ totals: totals(1, 1), cacheStatus: fresh }).counting).toBe(false);
    expect(figureOf({ totals: totals(1, 1) }).asOf).toBeNull();
  });

  it("F-232: an answer without totals is a failed read, never zero tokens and an estimate of $0.00", async () => {
    expect(() => figureOf({ updatedAt: 1, cacheStatus: fresh })).toThrow("had no totals");
    expect(() => figureOf(null)).toThrow("had no totals");
    // Totals with no token count in them are no zero either; a reported zero is one.
    expect(() => figureOf({ totals: {}, cacheStatus: fresh })).toThrow("had no token totals");
    expect(() => figureOf({ totals: { input: 5 }, cacheStatus: fresh })).toThrow(
      "had no token totals",
    );
    expect(figureOf({ totals: { totalTokens: 0 }, cacheStatus: fresh }).tokens.total).toBe(0);
    expect(
      figureOf({ totals: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0 }, cacheStatus: fresh })
        .tokens.total,
    ).toBe(5);
    // In a report: the bot whose answer had none is unavailable, the others are read.
    const gateway = fakeGateway();
    const empty: typeof gateway.request = async (method, raw) =>
      method === "usage.cost" && (raw as { agentId?: string }).agentId === "otto"
        ? { updatedAt: 1, cacheStatus: fresh }
        : gateway.request(method, raw);
    const { engine } = engineOn({ ...gateway, request: empty });
    const report = await reportOf(engine, {
      botId: null,
      period: "today",
      timeZone: NY,
      detail: false,
      bots: ["marlow", "otto"],
    });
    expect(report.bots).toEqual([
      expect.objectContaining({ botId: "marlow", error: null }),
      { botId: "otto", figure: null, error: "The gateway's answer had no totals." },
    ]);
    await expect(
      reportOf(engine, { botId: "otto", period: "today", timeZone: NY, detail: false, bots: [] }),
    ).rejects.toThrow("had no totals");
    engine.onClose();
  });

  it("lists each task's share, a routine's task by its routine, and still-counted tasks", () => {
    const tasks = tasksOf({
      sessions: [
        { key: "agent:otto:disk-space", label: "Disk almost full", usage: totals(600, 400) },
        {
          key: "agent:otto:cron:f3ab2dfd-4f99",
          label: "Automation: weekly-cleanup",
          usage: totals(120, 80),
        },
        { key: "agent:otto:cert-renewal", usage: totals(0, 0) },
        { key: "agent:otto:counting", usage: null, computing: true },
      ],
    });
    expect(tasks.map((t) => [t.key, t.total, t.routineId, t.computing])).toEqual([
      ["agent:otto:disk-space", 1000, null, false],
      ["agent:otto:cron:f3ab2dfd-4f99", 200, "f3ab2dfd-4f99", false],
      ["agent:otto:counting", 0, null, true],
    ]);
    expect(routineOfKey("agent:otto:cron:abc:run:1")).toBe("abc");
    expect(routineOfKey("agent:otto:main")).toBeNull();
  });

  it("F-235: keeps the limits providers report with their window, reset time and the gateway's time, and nothing else", () => {
    const limits = parseLimits({
      updatedAt: 99,
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          windows: [{ label: "Weekly", usedPercent: 62, resetAt: 1795600000000 }, { label: "Bad" }],
        },
        { provider: "xai", displayName: "xAI", windows: [], error: "Timeout" },
        { displayName: "no provider" },
      ],
    });
    expect(limits).toEqual({
      status: "ok",
      updatedAt: 99,
      refreshing: false,
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          windows: [{ label: "Weekly", usedPercent: 62, resetAt: 1795600000000 }],
          error: null,
        },
        { provider: "xai", displayName: "xAI", windows: [], error: "Timeout" },
      ],
    });
    // The development gateway's answer: a time and no providers.
    expect(parseLimits({ updatedAt: 5, providers: [] }).providers).toEqual([]);
    // An answer without the list says nothing about providers: it is a failed read.
    expect(() => parseLimits({ updatedAt: 77 })).toThrow("had no list of providers");
  });
});

describe("routines", () => {
  it("F-234: lists the routines that run in tasks of their own, and leaves out those whose runs share a task", () => {
    expect(
      routinesOf({
        jobs: [
          {
            id: "2d59561b",
            name: "heartbeat-main",
            agentId: "main",
            sessionTarget: "main",
            payload: { kind: "heartbeat" },
          },
          {
            id: "f3ab2dfd",
            name: "weekly-cleanup",
            displayName: "Weekly cleanup",
            agentId: "otto",
            sessionTarget: "isolated",
            payload: { kind: "agentTurn" },
          },
          {
            id: "c0ffee",
            name: "nightly",
            effectiveAgentId: "pip",
            sessionTarget: "current",
            sessionKey: "agent:pip:ask-marlow",
            payload: { kind: "agentTurn" },
          },
          // Runs in a task it names, beside everything else in that task (OpenClaw's cron
          // `session:` target): its use can't be told apart from the task's.
          {
            id: "notes",
            name: "daily-notes",
            agentId: "otto",
            sessionTarget: "session:agent:otto:daily-notes",
            payload: { kind: "agentTurn" },
          },
          // No target given: where it runs isn't established.
          { id: "unknown", name: "unknown", agentId: "otto", payload: { kind: "agentTurn" } },
          { id: "bad id!", agentId: "otto", sessionTarget: "isolated" },
        ],
      }),
    ).toEqual([
      { id: "f3ab2dfd", name: "Weekly cleanup", botId: "otto" },
      { id: "c0ffee", name: "nightly", botId: "pip" },
    ]);
  });
});

describe("where a bot's runs came from", () => {
  const T = Date.UTC(2026, 10, 19, 6);
  it("F-131: a run another bot's message started is told apart from a person's, by the row the gateway keyed to it", () => {
    const runs = runsOfHistory(
      [
        person("r1", T),
        assistant("r1", T + 1),
        fromBot("r2", T + 2, "agent:pip:ask-marlow"),
        assistant("r2", T + 3, 300),
        assistant("r2", T + 4, 100),
        assistant("r3", T + 5),
        assistant("r4", T - 10_000_000),
      ],
      { startDate: "2026-11-19", endDate: "2026-11-19", timeZone: NY },
    );
    expect(runs).toEqual([
      { runId: "r1", tokens: 200, trigger: "person", sourceKey: null },
      { runId: "r2", tokens: 400, trigger: "bot", sourceKey: "agent:pip:ask-marlow" },
      { runId: "r3", tokens: 200, trigger: "unknown", sourceKey: null },
    ]);
  });

  it("F-131: accepted queued delivery names a run and a queued notification does not", () => {
    const sendsJson = (result: Record<string, unknown>) => ({
      role: "toolResult",
      toolName: "sessions_send",
      isError: false,
      content: [{ type: "text", text: JSON.stringify(result) }],
    });
    const named = sentRunIds([
      sendResult("agent:marlow:main", "r2"),
      sendsJson({
        status: "accepted",
        targetDisposition: "queued",
        runId: "queued-run",
        sessionKey: "agent:marlow:main",
      }),
      sendsJson({
        status: "queued",
        runStarted: false,
        notificationId: "note",
        sessionKey: "agent:marlow:main",
      }),
      sendResult("agent:otto:main", "r9", "forbidden"),
      { role: "toolResult", toolName: "read", content: "{}" },
      // Cut by the gateway to a display length: its first fields are still read.
      {
        role: "toolResult",
        toolName: "sessions_send",
        details: { sessionKey: "agent:pip:main" },
        content: [
          {
            type: "text",
            text: '{\n  "runId": "r7",\n  "sessionKey": "agent:pip:main",\n  "status": "ok",\n  "reply": "Happy to he…',
          },
        ],
      },
      // Cut before its status: whether it was refused is not known, so it names nothing.
      {
        role: "toolResult",
        toolName: "sessions_send",
        content: [{ type: "text", text: '{\n  "runId": "r8",\n  "sessionKey": "agent:otto:mai' }],
      },
    ]);
    expect([...named.entries()].map(([k, v]) => [k, [...v]])).toEqual([
      ["agent:marlow:main", ["r2", "queued-run"]],
      ["agent:pip:main", ["r7"]],
    ]);
  });
});

describe("budgets in the state", () => {
  it("keeps a bot's and a routine's id of the longest length allowed, and the budget's key, as they are", () => {
    const botId = "b".repeat(128);
    const routineId = "r".repeat(128);
    const [budget] = parseBudgets({
      budgets: [{ botId, routineId, period: "daily", tokens: 1_000, timeZone: NY }],
    }).budgets;
    expect(budget?.id).toBe(`routine:${routineId}`);
    const kept = enforceState({
      ...initialState,
      usage: { ...initialUsage, budgets: [budget!] },
    }).usage!.budgets[0]!;
    expect([kept.id, kept.botId, kept.routineId]).toEqual([
      `routine:${routineId}`,
      botId,
      routineId,
    ]);
  });
});

describe("budgets kept with the gateway", () => {
  const otto: BudgetInput = {
    botId: "otto",
    routineId: null,
    routineName: null,
    period: "weekly",
    tokens: 2_000_000,
    timeZone: NY,
  };

  it("S17: a budget is a whole number of 1,000 tokens or more, said in the form's words", () => {
    expect(budgetTokens("2,500,000")).toBe(2_500_000);
    expect(budgetTokens("900")).toBe("Enter a whole number of 1,000 or more.");
    expect(budgetTokens("1.5")).toBe("Enter a whole number of 1,000 or more.");
    expect(budgetTokens("")).toBe("Enter a whole number of 1,000 or more.");
    // Past the largest budget, the form says the largest, not a bound the number already meets.
    expect(budgetTokens("1,000,000,000,001")).toBe(
      "Enter a whole number of 1,000,000,000,000 or less.",
    );
    expect(budgetTokens("1,000,000,000,000")).toBe(1_000_000_000_000);
    expect(() =>
      applyBudgetChange({ budgets: [] }, { op: "set", budget: { ...otto, tokens: 999 } }, NOW),
    ).toThrow(BudgetError);
  });

  it("F-234: one budget per bot and per routine, replaced when set again, at most 16", () => {
    let prefs = applyBudgetChange({ budgets: [] }, { op: "set", budget: otto }, NOW);
    prefs = applyBudgetChange(
      prefs,
      { op: "set", budget: { ...otto, period: "daily", tokens: 400_000 } },
      NOW + 1,
    );
    prefs = applyBudgetChange(
      prefs,
      {
        op: "set",
        budget: {
          ...otto,
          routineId: "f3ab2dfd",
          routineName: "weekly-cleanup",
          period: "daily",
          tokens: 200_000,
        },
      },
      NOW,
    );
    expect(prefs.budgets.map((b) => [b.id, b.period, b.tokens])).toEqual([
      ["bot:otto", "daily", 400_000],
      ["routine:f3ab2dfd", "daily", 200_000],
    ]);
    expect(
      applyBudgetChange(prefs, { op: "remove", id: "bot:otto" }, NOW).budgets.map((b) => b.id),
    ).toEqual(["routine:f3ab2dfd"]);
    let full = { budgets: [] as ReturnType<typeof parseBudgets>["budgets"] };
    for (let i = 0; i < MAX_BUDGETS; i += 1)
      full = applyBudgetChange(full, { op: "set", budget: { ...otto, botId: `bot${i}` } }, NOW);
    expect(() =>
      applyBudgetChange(full, { op: "set", budget: { ...otto, botId: "one-more" } }, NOW),
    ).toThrow("At most 16 budgets");
    // Replacing one of the sixteen is not one more.
    expect(
      applyBudgetChange(full, { op: "set", budget: { ...otto, botId: "bot3", tokens: 5000 } }, NOW)
        .budgets,
    ).toHaveLength(MAX_BUDGETS);
  });

  it("reads what the gateway holds as budgets, dropping what is not one", () => {
    const prefs = parseBudgets({
      rev: 3,
      budgets: [
        {
          botId: "otto",
          period: "weekly",
          tokens: 2_000_000,
          timeZone: NY,
          setAt: 1,
          extra: "dropped",
        },
        { botId: "otto", period: "daily", tokens: 1_000, timeZone: NY },
        { botId: "pip", period: "monthly", tokens: 5_000, timeZone: NY },
        { botId: "pip", period: "daily", tokens: 5_000, timeZone: "Not/AZone" },
        { botId: "bad id!", period: "daily", tokens: 5_000, timeZone: NY },
        "nonsense",
      ],
    });
    expect(prefs).toEqual({
      rev: 3,
      budgets: [
        {
          id: "bot:otto",
          botId: "otto",
          routineId: null,
          routineName: null,
          period: "weekly",
          tokens: 2_000_000,
          timeZone: NY,
          setAt: 1,
        },
      ],
    });
    expect(parseBudgets(null)).toEqual({ budgets: [] });
    // A routine budget with an id that isn't one is dropped, never read as the bot's budget,
    // which would then push out the bot's own budget as a duplicate.
    expect(
      parseBudgets({
        budgets: [
          { botId: "otto", routineId: "bad id!", period: "daily", tokens: 5_000, timeZone: NY },
          { botId: "otto", period: "weekly", tokens: 2_000_000, timeZone: NY },
        ],
      }).budgets.map((b) => [b.id, b.tokens]),
    ).toEqual([["bot:otto", 2_000_000]]);
  });

  it("F-396: a budget's share is its count over its tokens, and a count from another period is not shown as this one's", () => {
    const budget = parseBudgets({
      budgets: [{ botId: "otto", period: "weekly", tokens: 2_000_000, timeZone: NY }],
    }).budgets[0]!;
    expect(budgetPercent(budget, 1_640_000)).toBe(82);
    expect(budgetPercent(budget, null)).toBeNull();
    const usage: UsageState = {
      ...initialUsage,
      budgets: [budget],
      counts: [
        {
          budgetId: "bot:otto",
          range: rangeFor("weekly", NOW, NY),
          used: 1_640_000,
          asOf: NOW,
          counting: false,
          partial: false,
          error: null,
        },
      ],
    };
    expect(currentCount(usage, budget, NOW)?.used).toBe(1_640_000);
    // A week later the same count belongs to last week.
    expect(currentCount(usage, budget, NOW + 7 * 86_400_000)).toBeNull();
  });
});

/** A gateway that answers the usage methods and `users.prefs` from fixed records. */
function fakeGateway(options: { identity?: boolean; meddle?: number; counting?: boolean } = {}) {
  let prefs: unknown = undefined;
  let meddle = options.meddle ?? 0;
  let routineTarget = "isolated";
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const T = Date.UTC(2026, 10, 19, 6);
  const histories: Record<string, unknown[]> = {
    "agent:marlow:main": [
      person("m1", T),
      assistant("m1", T + 1),
      fromBot("m2", T + 2, "agent:pip:ask-marlow"),
      assistant("m2", T + 3),
    ],
    // A message from Pip whose send returned before Marlow answered (`accepted`): no result names
    // its run, so it is not counted as another bot's.
    "agent:marlow:other": [
      person("m3", T),
      assistant("m3", T + 1, 500),
      fromBot("m4", T + 2, "agent:pip:slow"),
      assistant("m4", T + 3, 300),
      // A send the gateway delivered, whose run then failed: the result is an error that names
      // the run (`sentBeforeError`), and the run's tokens are another bot's.
      fromBot("m5", T + 4, "agent:pip:slow"),
      assistant("m5", T + 5, 100),
      // A send refused before delivery: its error names a run that no message started.
      fromBot("m6", T + 6, "agent:pip:slow"),
      assistant("m6", T + 7, 100),
    ],
    "agent:pip:slow": [
      person("p2", T),
      sendResult("agent:marlow:other", null, "accepted"),
      {
        role: "toolResult",
        toolName: "sessions_send",
        isError: false,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "error",
              sentBeforeError: true,
              runId: "m5",
              sessionKey: "agent:marlow:other",
              error: "after delivery",
            }),
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "sessions_send",
        isError: false,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "error",
              runId: "m6",
              sessionKey: "agent:marlow:other",
              error: "before delivery",
            }),
          },
        ],
      },
    ],
    "agent:pip:ask-marlow": [
      person("p1", T),
      assistant("p1", T + 1),
      sendResult("agent:marlow:main", "m2"),
      assistant("p1", T + 4),
    ],
  };
  /** A bot's (or every bot's) total for the range asked, the same in each of the gateway's answers. */
  const total = (params: Record<string, unknown>) => {
    const week = params.startDate !== params.endDate;
    const byAgent: Record<string, number> = {
      marlow: week ? 1700 : 900,
      otto: week ? 1800 : 1800,
      pip: 600,
      all: 4100,
    };
    return byAgent[(params.agentId as string | undefined) ?? "all"] ?? 0;
  };
  const request = async (method: string, raw: unknown): Promise<unknown> => {
    const params = (raw ?? {}) as Record<string, unknown>;
    calls.push({ method, params });
    switch (method) {
      case "users.prefs.get":
        if (options.identity === false) return { status: "no_durable_identity" };
        return { status: "ok", entries: prefs === undefined ? {} : { [BUDGETS_PREF_KEY]: prefs } };
      case "users.prefs.set": {
        if (options.identity === false) return { status: "no_durable_identity" };
        if (meddle > 0) {
          meddle -= 1;
          prefs = {
            rev: 7,
            budgets: [{ botId: "pip", period: "daily", tokens: 9_000, timeZone: NY }],
          };
          return { status: "conflict" };
        }
        const expected = (params.expectedEntries as Record<string, unknown>)[BUDGETS_PREF_KEY];
        if (JSON.stringify(expected ?? null) !== JSON.stringify(prefs ?? null))
          return { status: "conflict" };
        prefs = (params.entries as Record<string, unknown>)[BUDGETS_PREF_KEY];
        return { status: "ok" };
      }
      case "usage.cost":
        return {
          updatedAt: 4242,
          totals: totals(total(params), 0),
          cacheStatus: options.counting ? { status: "refreshing", pendingFiles: 3 } : fresh,
        };
      case "sessions.usage":
        return {
          updatedAt: 4343,
          // The aggregate over every matching task: the same as the headline in this snapshot.
          totals: totals(total(params), 0),
          sessions:
            params.agentId === "otto"
              ? [
                  { key: "agent:otto:cron:job1", usage: totals(120, 80) },
                  { key: "agent:otto:disk-space", usage: totals(1000, 600) },
                ]
              : [
                  { key: "agent:marlow:main", usage: totals(400, 0) },
                  { key: "agent:marlow:other", usage: totals(1300, 0) },
                ],
          cacheStatus: fresh,
        };
      case "chat.history":
        return { messages: histories[params.sessionKey as string] ?? [], hasMore: false };
      case "usage.status":
        return { updatedAt: 77, providers: [] };
      case "cron.get":
        // A routine as `cron.get` gives it: running in tasks of its own, unless moved.
        return {
          id: params.id,
          name: "Weekly cleanup",
          agentId: "otto",
          sessionTarget: routineTarget,
          payload: { kind: "agentTurn" },
        };
      default:
        throw new Error(`unexpected ${method}`);
    }
  };
  return {
    request,
    calls,
    prefs: () => prefs,
    /** Move the routine's runs to another session target, as `cron.update` does. */
    retarget: (target: string) => {
      routineTarget = target;
    },
  };
}

function engineOn(gateway: ReturnType<typeof fakeGateway>, now = () => NOW) {
  let usage: UsageState = initialUsage;
  const ctx: UsageContext = {
    request: gateway.request,
    get: () => usage,
    update: (change) => {
      usage = change(usage);
    },
    connected: () => true,
    now,
    log: () => {},
  };
  return { engine: new UsageEngine(ctx), usage: () => usage };
}

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

/** A report that is read, not answered busy. */
async function reportOf(engine: UsageEngine, request: UsageReportRequest) {
  const answer = await engine.readReport(request);
  if ("busy" in answer) throw new Error("answered busy");
  return answer;
}

describe("the usage engine", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("F-234: a budget set on one device is read back by another, with the same value", async () => {
    const gateway = fakeGateway();
    const one = engineOn(gateway);
    const two = engineOn(gateway);
    await one.engine.changeBudget({
      op: "set",
      budget: {
        botId: "otto",
        routineId: null,
        routineName: null,
        period: "weekly",
        tokens: 2_500_000,
        timeZone: NY,
      },
    });
    expect(one.usage().budgets.map((b) => [b.id, b.period, b.tokens])).toEqual([
      ["bot:otto", "weekly", 2_500_000],
    ]);
    two.engine.onHello();
    await flush();
    expect(two.usage()).toMatchObject({
      budgetsStatus: "ok",
      rev: 1,
      budgets: [{ id: "bot:otto", period: "weekly", tokens: 2_500_000 }],
    });
    // A change on the first device reaches the second on the gateway's change event.
    await one.engine.changeBudget({
      op: "set",
      budget: {
        botId: "otto",
        routineId: null,
        routineName: null,
        period: "weekly",
        tokens: 3_000_000,
        timeZone: NY,
      },
    });
    two.engine.onPrefsChanged([BUDGETS_PREF_KEY]);
    await flush();
    expect(two.usage().budgets[0]?.tokens).toBe(3_000_000);
    one.engine.onClose();
    two.engine.onClose();
  });

  it("applies a change again to what another device wrote meanwhile, and keeps both", async () => {
    const gateway = fakeGateway({ meddle: 1 });
    const { engine, usage } = engineOn(gateway);
    await engine.changeBudget({
      op: "set",
      budget: {
        botId: "otto",
        routineId: null,
        routineName: null,
        period: "daily",
        tokens: 5_000,
        timeZone: NY,
      },
    });
    expect(usage().budgets.map((b) => b.id)).toEqual(["bot:pip", "bot:otto"]);
    expect(usage().rev).toBe(8);
    engine.onClose();
  });

  it("F-234: a write whose answer was lost is confirmed only by reading what the gateway holds, which is then shown", async () => {
    const budget: BudgetInput = {
      botId: "otto",
      routineId: null,
      routineName: null,
      period: "weekly",
      tokens: 5_000,
      timeZone: NY,
    };
    // Kept, then the answer lost: the read finds it, so it stands.
    const kept = fakeGateway();
    const keptThenLost: typeof kept.request = async (method, raw) => {
      const answer = await kept.request(method, raw);
      if (method === "users.prefs.set") throw new Error("Connection lost after the write");
      return answer;
    };
    const one = engineOn({ ...kept, request: keptThenLost });
    await expect(one.engine.changeBudget({ op: "set", budget })).resolves.toBeUndefined();
    expect(one.usage().budgets.map((b) => [b.id, b.tokens])).toEqual([["bot:otto", 5_000]]);
    one.engine.onClose();
    // Lost before the gateway kept it: it couldn't be confirmed, and what is held is shown.
    const lost = fakeGateway();
    const asked: string[] = [];
    const neverKept: typeof lost.request = async (method, raw) => {
      asked.push(method);
      if (method === "users.prefs.set") throw new Error("Connection lost");
      return lost.request(method, raw);
    };
    const two = engineOn({ ...lost, request: neverKept });
    await expect(two.engine.changeBudget({ op: "set", budget })).rejects.toThrow(
      "The change couldn't be confirmed: Connection lost. The read-back did not confirm this change.",
    );
    expect(two.usage()).toMatchObject({ budgetsStatus: "ok", budgets: [] });
    expect(asked).toEqual(["users.prefs.get", "users.prefs.set", "users.prefs.get"]);
    two.engine.onClose();

    // The answer lost as the connection closed: nothing is asked of the next gateway.
    const switched: Array<[string, string]> = [];
    let gatewayName = "first";
    let write: (error: Error) => void = () => {};
    const across = fakeGateway();
    const three = engineOn({
      ...across,
      request: async (method, raw) => {
        switched.push([gatewayName, method]);
        if (method === "users.prefs.set")
          return new Promise((_, reject) => {
            write = reject;
          });
        return across.request(method, raw);
      },
    });
    const crossing = three.engine.changeBudget({ op: "set", budget });
    await flush();
    three.engine.onClose();
    gatewayName = "second";
    write(new Error("old socket closed"));
    await expect(crossing).rejects.toThrow(
      "The change couldn't be confirmed: the connection to the gateway closed.",
    );
    expect(switched.filter(([name]) => name === "second")).toEqual([]);

    // A lost removal while another device changed another budget: the removal is confirmed,
    // and the other budget's new amount is shown.
    const routine = {
      botId: "otto",
      routineId: "job1",
      routineName: "Sample",
      period: "weekly",
      tokens: 1_000,
      timeZone: NY,
    };
    let stored: unknown = {
      rev: 7,
      budgets: [{ botId: "otto", period: "weekly", tokens: 1_000, timeZone: NY }, routine],
    };
    const four = engineOn({
      ...fakeGateway(),
      request: async (method, raw) => {
        if (method === "users.prefs.set") {
          const written = (raw as { entries: Record<string, { rev: number }> }).entries[
            BUDGETS_PREF_KEY
          ]!;
          stored = { rev: written.rev + 1, budgets: [{ ...routine, tokens: 3_000 }] };
          throw new Error("response lost");
        }
        return { status: "ok", entries: { [BUDGETS_PREF_KEY]: stored } };
      },
    });
    await expect(
      four.engine.changeBudget({ op: "remove", id: "bot:otto" }),
    ).resolves.toBeUndefined();
    expect(four.usage().budgets.map((b) => [b.id, b.tokens])).toEqual([["routine:job1", 3_000]]);
    four.engine.onClose();

    // A read-back the gateway can't give says that, never that it keeps no budgets.
    let writes = 0;
    const five = engineOn({
      ...fakeGateway(),
      request: async (method) => {
        if (method === "users.prefs.set") {
          writes += 1;
          throw new Error("response lost");
        }
        return writes ? { status: "unavailable" } : { status: "ok", entries: {} };
      },
    });
    await expect(five.engine.changeBudget({ op: "set", budget })).rejects.toThrow(
      "The change couldn't be confirmed: response lost. Reading the gateway's budgets again was unavailable.",
    );
    five.engine.onClose();

    // A conflict answered after the connection closed: no second attempt on the next one.
    let conflict: (value: unknown) => void = () => {};
    const sets: string[] = [];
    const six = engineOn({
      ...fakeGateway(),
      request: async (method) => {
        if (method === "users.prefs.set") {
          sets.push(method);
          return new Promise((resolve) => {
            conflict = resolve;
          });
        }
        return { status: "ok", entries: {} };
      },
    });
    const late = six.engine.changeBudget({ op: "set", budget });
    await flush();
    six.engine.onClose();
    conflict({ status: "conflict" });
    await expect(late).rejects.toThrow("the connection to the gateway closed");
    expect(sets).toHaveLength(1);
  });

  it("F-234: a budget write asks only through the request it was given, so a viewer that has gone sends nothing", async () => {
    const gateway = fakeGateway();
    const { engine } = engineOn(gateway);
    let withdrawn = false;
    const viewers = async (method: string, params: unknown) => {
      if (withdrawn) throw new Error("This viewer has gone.");
      const answer = await gateway.request(method, params);
      // The viewer goes while the preference is read.
      withdrawn = true;
      return answer;
    };
    await expect(
      engine.changeBudget(
        {
          op: "set",
          budget: {
            botId: "otto",
            routineId: null,
            routineName: null,
            period: "weekly",
            tokens: 5_000,
            timeZone: NY,
          },
        },
        viewers,
      ),
    ).rejects.toThrow();
    expect(gateway.calls.map((c) => c.method)).toEqual(["users.prefs.get"]);
    expect(gateway.prefs()).toBeUndefined();
    engine.onClose();
  });

  it("refuses a budget when the gateway keeps no preferences for this connection", async () => {
    const { engine, usage } = engineOn(fakeGateway({ identity: false }));
    await expect(
      engine.changeBudget({
        op: "set",
        budget: {
          botId: "otto",
          routineId: null,
          routineName: null,
          period: "daily",
          tokens: 5_000,
          timeZone: NY,
        },
      }),
    ).rejects.toThrow("keeps no preferences");
    engine.onHello();
    await flush();
    expect(usage().budgetsStatus).toBe("unavailable");
    engine.onClose();
  });

  it("F-234 F-396: counts a Daily and a Weekly budget over their own days, with the same request the Usage page makes", async () => {
    const gateway = fakeGateway();
    const { engine, usage } = engineOn(gateway);
    await engine.changeBudget({
      op: "set",
      budget: {
        botId: "marlow",
        routineId: null,
        routineName: null,
        period: "daily",
        tokens: 1_000,
        timeZone: NY,
      },
    });
    await engine.changeBudget({
      op: "set",
      budget: {
        botId: "otto",
        routineId: null,
        routineName: null,
        period: "weekly",
        tokens: 2_000,
        timeZone: NY,
      },
    });
    await engine.countBudgets();
    const counts = Object.fromEntries(usage().counts.map((c) => [c.budgetId, c]));
    expect(counts["bot:marlow"]).toMatchObject({
      used: 900,
      asOf: 4242,
      range: { startDate: "2026-11-19", endDate: "2026-11-19" },
    });
    expect(counts["bot:otto"]).toMatchObject({
      used: 1800,
      range: { startDate: "2026-11-16", endDate: "2026-11-19" },
    });
    const counted = gateway.calls.filter((c) => c.method === "usage.cost").map((c) => c.params);
    const report = await reportOf(engine, {
      botId: "otto",
      period: "week",
      timeZone: NY,
      detail: false,
      bots: [],
    });
    // The page's week and the Weekly budget are one request, so one number.
    expect(gateway.calls.at(-1)!.params).toEqual(counted.find((p) => p.agentId === "otto"));
    expect(report.figure.tokens.total).toBe(counts["bot:otto"]!.used);
    engine.onClose();
  });

  it("F-234: a routine's budget counts that routine's tasks only", async () => {
    const gateway = fakeGateway();
    const { engine, usage } = engineOn(gateway);
    await engine.changeBudget({
      op: "set",
      budget: {
        botId: "otto",
        routineId: "job1",
        routineName: "Weekly cleanup",
        period: "daily",
        tokens: 1_000,
        timeZone: NY,
      },
    });
    await engine.countBudgets();
    expect(usage().counts).toMatchObject([
      { budgetId: "routine:job1", used: 200, asOf: 4343, partial: false },
    ]);
    engine.onClose();
  });

  it("F-234: a reply without a task list keeps the routine's earlier count, marked failed, and shows no tasks", async () => {
    let broken = false;
    const gateway = fakeGateway();
    const { engine, usage } = engineOn({
      ...gateway,
      request: async (method, raw) =>
        broken && method === "sessions.usage"
          ? { updatedAt: 9, cacheStatus: fresh, totals: totals(1000, 600) }
          : gateway.request(method, raw),
    });
    await engine.changeBudget({
      op: "set",
      budget: {
        botId: "otto",
        routineId: "job1",
        routineName: "Weekly cleanup",
        period: "daily",
        tokens: 1_000,
        timeZone: NY,
      },
    });
    await engine.countBudgets();
    expect(usage().counts).toMatchObject([{ used: 200, error: null }]);
    broken = true;
    await engine.countBudgets();
    expect(usage().counts).toMatchObject([
      { used: 200, error: "The gateway's answer had no task list." },
    ]);
    const report = await reportOf(engine, {
      botId: "otto",
      period: "week",
      timeZone: NY,
      detail: true,
      bots: [],
    });
    expect(report.tasks).toBeNull();
    expect(report.sources).toBeNull();
    expect(report.detailError).toBe("The gateway's answer had no task list.");
    engine.onClose();
  });

  it("F-234: a routine moved into a shared task is no longer counted, can't be saved again, and can be removed", async () => {
    const gateway = fakeGateway();
    const { engine, usage } = engineOn(gateway);
    const budget: BudgetInput = {
      botId: "otto",
      routineId: "job1",
      routineName: "Weekly cleanup",
      period: "daily",
      tokens: 1_000,
      timeZone: NY,
    };
    await engine.changeBudget({ op: "set", budget });
    await engine.countBudgets();
    expect(usage().counts).toMatchObject([{ budgetId: "routine:job1", used: 200, error: null }]);
    // Moved into the bot's main task: its use can't be told apart.
    gateway.retarget("session:agent:otto:main");
    await engine.countBudgets();
    expect(usage().counts).toMatchObject([
      {
        budgetId: "routine:job1",
        used: null,
        counting: false,
        error: "Usage for this routine can't be counted separately.",
      },
    ]);
    // No sessions.usage read followed the eligibility read that said so.
    expect(gateway.calls.at(-1)?.method).toBe("cron.get");
    await expect(engine.changeBudget({ op: "set", budget })).rejects.toThrow(
      "Usage for this routine can't be counted separately.",
    );
    await engine.changeBudget({ op: "remove", id: "routine:job1" });
    expect(usage().budgets).toEqual([]);
    engine.onClose();
  });

  it("F-234: a routine's count read from a list the gateway capped is partial, never a settled figure", async () => {
    const gateway = fakeGateway();
    // The gateway lists at most `limit` tasks, the most recently updated first; its totals cover
    // every task. Here the routine's task is past the cap.
    const capped: typeof gateway.request = async (method, raw) => {
      if (method !== "sessions.usage") return gateway.request(method, raw);
      const params = raw as { limit: number };
      return {
        updatedAt: 4343,
        cacheStatus: fresh,
        sessions: Array.from({ length: params.limit }, (_, i) => ({
          key: `agent:otto:task-${i}`,
          usage: totals(1, 0),
        })),
        totals: totals(params.limit + 1200, 0),
      };
    };
    const { engine, usage } = engineOn({ ...gateway, request: capped });
    await engine.changeBudget({
      op: "set",
      budget: {
        botId: "otto",
        routineId: "job1",
        routineName: "Weekly cleanup",
        period: "daily",
        tokens: 1_000,
        timeZone: NY,
      },
    });
    await engine.countBudgets();
    expect(usage().counts).toMatchObject([{ budgetId: "routine:job1", used: 0, partial: true }]);
    engine.onClose();
  });

  it("F-396: counts again after a budgeted bot's run ends, once the gateway's total can include it, and every minute", async () => {
    vi.useFakeTimers();
    const gateway = fakeGateway();
    const { engine } = engineOn(gateway, () => Date.now());
    await engine.changeBudget({
      op: "set",
      budget: {
        botId: "otto",
        routineId: null,
        routineName: null,
        period: "daily",
        tokens: 1_000,
        timeZone: NY,
      },
    });
    await vi.advanceTimersByTimeAsync(10);
    const counted = () => gateway.calls.filter((c) => c.method === "usage.cost").length;
    const first = counted();
    expect(first).toBe(1);
    engine.onRunEnded("pip");
    engine.onRunEnded("otto");
    await vi.advanceTimersByTimeAsync(COUNT_AFTER_RUN_MS - 100);
    expect(counted()).toBe(first);
    await vi.advanceTimersByTimeAsync(200);
    expect(counted()).toBe(first + 1);
    await vi.advanceTimersByTimeAsync(COUNT_EVERY_MS + 10);
    expect(counted()).toBe(first + 2);
    engine.onClose();
    await vi.advanceTimersByTimeAsync(COUNT_EVERY_MS * 3);
    expect(counted()).toBe(first + 2);
  });

  it("F-131 F-237: a bot's sources count a sent run only when the sending task's result names it", async () => {
    const gateway = fakeGateway();
    const { engine } = engineOn(gateway);
    const report = await reportOf(engine, {
      botId: "marlow",
      period: "week",
      timeZone: NY,
      detail: true,
      bots: [],
    });
    expect(report.figure.tokens.total).toBe(1700);
    expect(report.tasks?.map((t) => [t.key, t.total])).toEqual([
      ["agent:marlow:other", 1300],
      ["agent:marlow:main", 400],
    ]);
    // m1 (a person's, 200) and m3 (500) are people's; m2 (200) is the run Pip's send names, and
    // m5 (100) the run a delivered send names before it failed; m4 (300), a message from Pip
    // that no result names, and m6 (100), named only by a send refused before delivery, are not
    // attributed.
    expect(report.sources).toEqual({
      people: 700,
      routines: 0,
      bots: 300,
      unattributed: 700,
      partial: false,
    });
    engine.onClose();
  });

  it("F-232: a failed recount keeps the earlier count's counting state, and says it failed", async () => {
    let fail = false;
    const gateway = fakeGateway({ counting: true });
    const { engine, usage } = engineOn({
      ...gateway,
      request: async (method, raw) => {
        if (fail && method === "usage.cost") throw new Error("read timed out");
        return gateway.request(method, raw);
      },
    });
    await engine.changeBudget({
      op: "set",
      budget: {
        botId: "otto",
        routineId: null,
        routineName: null,
        period: "weekly",
        tokens: 2_000,
        timeZone: NY,
      },
    });
    await engine.countBudgets();
    expect(usage().counts[0]).toMatchObject({ used: 1800, counting: true, error: null });
    fail = true;
    await engine.countBudgets();
    expect(usage().counts[0]).toMatchObject({
      used: 1800,
      counting: true,
      error: "read timed out",
    });
    engine.onClose();
  });

  it("F-234: a recount stops at a disconnect, asks the next gateway nothing of the old budgets, and that gateway's budgets are counted", async () => {
    const asked: Array<[string, string, unknown]> = [];
    let gatewayName = "first";
    const held: Array<() => void> = [];
    const old = Array.from({ length: 5 }, (_, i) => ({
      id: `bot:old-${i}`,
      botId: `old-${i}`,
      routineId: null,
      routineName: null,
      period: "weekly" as const,
      tokens: 1_000,
      timeZone: NY,
      setAt: 0,
    }));
    let usage: UsageState = { ...initialUsage, budgetsStatus: "ok", budgets: old };
    const engine = new UsageEngine({
      request: async (method, raw) => {
        const params = (raw ?? {}) as Record<string, unknown>;
        asked.push([gatewayName, method, params.agentId ?? null]);
        if (method === "users.prefs.get")
          return {
            status: "ok",
            entries: {
              [BUDGETS_PREF_KEY]: {
                budgets: [{ botId: "new", period: "weekly", tokens: 1_000, timeZone: NY }],
              },
            },
          };
        if (method === "usage.status") return { updatedAt: 1, providers: [] };
        if (gatewayName === "first") await new Promise<void>((resolve) => held.push(resolve));
        return { updatedAt: 2, totals: totals(10, 0), cacheStatus: fresh };
      },
      get: () => usage,
      update: (change) => {
        usage = change(usage);
      },
      connected: () => true,
      now: () => NOW,
      log: () => {},
    });
    const counting = engine.countBudgets();
    await flush();
    // Four of the five old budgets are being counted on the first gateway.
    expect(held).toHaveLength(4);
    engine.onClose();
    gatewayName = "second";
    engine.onHello();
    // The new connection's count is due.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    while (held.length > 0) held.shift()!();
    await counting;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const second = asked.filter(([name, method]) => name === "second" && method === "usage.cost");
    expect(second.map(([, , botId]) => botId)).toEqual(["new"]);
    expect(usage.counts.map((count) => count.budgetId)).toEqual(["bot:new"]);
    engine.onClose();
  });

  it("counts a budget again within seconds while the gateway is still counting it", async () => {
    vi.useFakeTimers();
    const gateway = fakeGateway({ counting: true });
    const { engine, usage } = engineOn(gateway, () => Date.now());
    await engine.changeBudget({
      op: "set",
      budget: {
        botId: "otto",
        routineId: null,
        routineName: null,
        period: "daily",
        tokens: 1_000,
        timeZone: NY,
      },
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(usage().counts[0]?.counting).toBe(true);
    const counted = () => gateway.calls.filter((c) => c.method === "usage.cost").length;
    const first = counted();
    await vi.advanceTimersByTimeAsync(COUNT_COUNTING_MS + 10);
    expect(counted()).toBe(first + 1);
    engine.onClose();
  });

  it("F-232: while the gateway is still counting, the sources are marked partial and the figure says so", async () => {
    const { engine } = engineOn(fakeGateway({ counting: true }));
    const report = await reportOf(engine, {
      botId: "marlow",
      period: "week",
      timeZone: NY,
      detail: true,
      bots: [],
    });
    expect(report.figure.counting).toBe(true);
    expect(report.sources?.partial).toBe(true);
    engine.onClose();
  });

  it("F-237: sources that can't be reconciled with the gateway's total are not shown, and the rest of a total still being counted is no figure", async () => {
    const gateway = fakeGateway();
    // The review's case: a 50-token total, while sessions.usage, read apart and still counting,
    // already lists 60 tokens of a routine's. Its aggregate agrees with the headline, so it is
    // the parts that come to more than the total that keep the sources from being shown.
    const apart: typeof gateway.request = async (method, raw) => {
      if (method === "usage.cost")
        return { updatedAt: 1, totals: totals(30, 20), cacheStatus: fresh };
      if (method === "sessions.usage")
        return {
          updatedAt: 1,
          totals: totals(30, 20),
          sessions: [{ key: "agent:otto:cron:job1", usage: totals(36, 24) }],
          cacheStatus: { status: "refreshing", pendingFiles: 1 },
        };
      return gateway.request(method, raw);
    };
    const one = engineOn({ ...gateway, request: apart });
    const report = await reportOf(one.engine, {
      botId: "otto",
      period: "week",
      timeZone: NY,
      detail: true,
      bots: [],
    });
    expect(report.detailCounting).toBe(true);
    expect(report.sources).toBeNull();
    expect(report.detailError).toBe(
      "The tasks' records and the gateway's total don't agree yet, so where the tokens came from isn't shown.",
    );
    one.engine.onClose();
    // A total still being counted: the named parts are shown as partial, the rest is not a figure.
    const two = engineOn(fakeGateway({ counting: true }));
    const counting = await reportOf(two.engine, {
      botId: "marlow",
      period: "week",
      timeZone: NY,
      detail: true,
      bots: [],
    });
    expect(counting.sources).toEqual({
      people: 700,
      routines: 0,
      bots: 300,
      unattributed: null,
      partial: true,
    });
    two.engine.onClose();
    // The opposite: a settled 400-token headline beside a settled aggregate of 500 over tasks of
    // 450 and 50. Neither the tasks nor the sources are shown.
    const gateway3 = fakeGateway();
    const apart3: typeof gateway3.request = async (method, raw) => {
      if (method === "usage.cost")
        return { updatedAt: 1, totals: totals(240, 160), cacheStatus: fresh };
      if (method === "sessions.usage")
        return {
          updatedAt: 1,
          cacheStatus: fresh,
          totals: totals(300, 200),
          sessions: [
            { key: "agent:otto:cron:job1", usage: totals(30, 20) },
            { key: "agent:otto:main", usage: totals(270, 180) },
          ],
        };
      return gateway3.request(method, raw);
    };
    const three = engineOn({ ...gateway3, request: apart3 });
    const opposite = await reportOf(three.engine, {
      botId: "otto",
      period: "week",
      timeZone: NY,
      detail: true,
      bots: [],
    });
    // The headline is still the gateway's figure for its own answer.
    expect(opposite.figure.tokens.total).toBe(400);
    expect(opposite.tasks).toBeNull();
    expect(opposite.sources).toBeNull();
    expect(opposite.detailError).toMatch(/don't agree yet/);
    three.engine.onClose();
  });

  it("F-237: a task whose history comes to more than its own figure keeps the sources from being shown", async () => {
    const gateway = fakeGateway();
    const T = Date.UTC(2026, 10, 19, 6);
    const apart: typeof gateway.request = async (method, raw) => {
      if (method === "usage.cost")
        return { updatedAt: 1, totals: totals(120, 80), cacheStatus: fresh };
      if (method === "sessions.usage")
        return {
          updatedAt: 1,
          cacheStatus: fresh,
          totals: totals(120, 80),
          sessions: [
            { key: "agent:otto:a", usage: totals(60, 40) },
            { key: "agent:otto:b", usage: totals(60, 40) },
          ],
        };
      if (method === "chat.history")
        // Task A is listed at 100 tokens, but its history, read later, holds a 150-token run.
        return (raw as { sessionKey: string }).sessionKey === "agent:otto:a"
          ? { messages: [person("a1", T), assistant("a1", T + 1, 150)], hasMore: false }
          : { messages: [], hasMore: false };
      return gateway.request(method, raw);
    };
    const { engine } = engineOn({ ...gateway, request: apart });
    const report = await reportOf(engine, {
      botId: "otto",
      period: "week",
      timeZone: NY,
      detail: true,
      bots: [],
    });
    expect(report.sources).toBeNull();
    expect(report.detailError).toMatch(/don't agree yet/);
    engine.onClose();
  });

  it("F-237: once a history disagrees with its task's figure, no further history is read, and the report ends only when the started reads have", async () => {
    const gateway = fakeGateway();
    const T = Date.UTC(2026, 10, 19, 6);
    const keys = Array.from({ length: 8 }, (_, i) => `agent:otto:t${i}`);
    const held: Array<() => void> = [];
    let inFlight = 0;
    let most = 0;
    const histories: string[] = [];
    const apart: typeof gateway.request = async (method, raw) => {
      if (method === "usage.cost")
        return { updatedAt: 1, totals: totals(80, 0), cacheStatus: fresh };
      if (method === "sessions.usage")
        return {
          updatedAt: 1,
          cacheStatus: fresh,
          totals: totals(80, 0),
          sessions: keys.map((key) => ({ key, usage: totals(10, 0) })),
        };
      if (method !== "chat.history") return gateway.request(method, raw);
      const { sessionKey } = raw as { sessionKey: string };
      histories.push(sessionKey);
      inFlight += 1;
      most = Math.max(most, inFlight);
      try {
        // The first task's history holds more than its own figure; the others answer when let go.
        if (sessionKey === keys[0])
          return { messages: [person("r0", T), assistant("r0", T + 1, 50)], hasMore: false };
        await new Promise<void>((resolve) => held.push(resolve));
        return { messages: [], hasMore: false };
      } finally {
        inFlight -= 1;
      }
    };
    const { engine } = engineOn({ ...gateway, request: apart });
    let ended = false;
    const reading = reportOf(engine, {
      botId: "otto",
      period: "week",
      timeZone: NY,
      detail: true,
      bots: [],
    }).finally(() => (ended = true));
    await until(() => held.length === USAGE_REQUESTS_AT_ONCE - 1);
    await flush();
    // The report, and its slot, stay while its reads are still out.
    expect(ended).toBe(false);
    expect(inFlight).toBe(USAGE_REQUESTS_AT_ONCE - 1);
    while (held.length > 0) {
      held.shift()!();
      await flush();
    }
    const report = await reading;
    expect(inFlight).toBe(0);
    expect(most).toBeLessThanOrEqual(USAGE_REQUESTS_AT_ONCE);
    expect(histories).toEqual(keys.slice(0, USAGE_REQUESTS_AT_ONCE));
    expect(report.sources).toBeNull();
    expect(report.detailError).toMatch(/don't agree yet/);
    engine.onClose();
  });

  it("F-237: a task list the gateway capped says so, and the sources read from it are partial", async () => {
    const gateway = fakeGateway();
    const capped: typeof gateway.request = async (method, raw) => {
      if (method !== "sessions.usage") return gateway.request(method, raw);
      const { limit } = raw as { limit: number };
      return {
        updatedAt: 1,
        cacheStatus: fresh,
        totals: totals(1700, 0),
        sessions: Array.from({ length: limit }, (_, i) => ({
          key: `agent:marlow:task-${i}`,
          usage: totals(i < 10 ? 1 : 0, 0),
        })),
      };
    };
    const { engine } = engineOn({ ...gateway, request: capped });
    const report = await reportOf(engine, {
      botId: "marlow",
      period: "week",
      timeZone: NY,
      detail: true,
      bots: [],
    });
    expect(report.tasksCapped).toBe(true);
    expect(report.tasksOmitted).toBe(2);
    expect(report.sources?.partial).toBe(true);
    engine.onClose();
  });

  it("F-237: every bot's figures, each read the same way as its own page", async () => {
    const gateway = fakeGateway();
    const { engine } = engineOn(gateway);
    const report = await reportOf(engine, {
      botId: null,
      period: "today",
      timeZone: NY,
      detail: false,
      bots: ["marlow", "otto", "pip"],
    });
    expect(report.figure.tokens.total).toBe(4100);
    expect(report.bots?.map((b) => [b.botId, b.figure?.tokens.total])).toEqual([
      ["marlow", 900],
      ["otto", 1800],
      ["pip", 600],
    ]);
    expect(gateway.calls.find((c) => c.method === "usage.cost")?.params).toMatchObject({
      agentScope: "all",
      mode: "specific",
      timeZone: NY,
    });
    engine.onClose();
  });

  it("F-234: reads at most two reports at once; a third is answered busy, not refused as a failure", async () => {
    const gateway = fakeGateway();
    // The gateway answers usage.cost only when told, so the first two reads stay in flight.
    const held: Array<() => void> = [];
    let inFlight = 0;
    let most = 0;
    const slow: typeof gateway.request = async (method, params) => {
      if (method !== "usage.cost") return gateway.request(method, params);
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise<void>((resolve) => held.push(resolve));
      inFlight -= 1;
      return gateway.request(method, params);
    };
    const { engine } = engineOn({ ...gateway, request: slow });
    const read = () =>
      engine.readReport({ botId: "otto", period: "today", timeZone: NY, detail: false, bots: [] });
    const reads = [read(), read()];
    await flush();
    // The third is answered at once, and as busy: nothing waits on the host for it.
    await expect(read()).resolves.toEqual({ busy: true });
    expect(held).toHaveLength(MAX_USAGE_REPORTS);
    while (held.length > 0) held.shift()!();
    const settled = await Promise.all(reads);
    expect(settled.map((each) => "figure" in each)).toEqual([true, true]);
    expect(most).toBe(MAX_USAGE_REPORTS);
    // Once one has ended, the next is read.
    const next = read();
    await flush();
    held.shift()!();
    await expect(next).resolves.toMatchObject({ botId: "otto" });
    engine.onClose();
  });

  it("a report ends with the connection it started on: nothing is asked of the next gateway, and no answer comes from it", async () => {
    const asked: Array<[string, string]> = [];
    const held: Array<() => void> = [];
    let gatewayName = "first";
    const gateway = fakeGateway();
    const request: typeof gateway.request = async (method, params) => {
      asked.push([gatewayName, method]);
      if (gatewayName === "first" && method === "usage.cost")
        await new Promise<void>((resolve) => held.push(resolve));
      return gateway.request(method, params);
    };
    const { engine } = engineOn({ ...gateway, request });
    const reads = [
      engine.readReport({ botId: "otto", period: "week", timeZone: NY, detail: true, bots: [] }),
      engine.readReport({
        botId: null,
        period: "week",
        timeZone: NY,
        detail: false,
        bots: ["pip"],
      }),
    ];
    await flush();
    // The connection closes and the client connects to another gateway.
    engine.onClose();
    gatewayName = "second";
    engine.onHello();
    await flush();
    while (held.length > 0) held.shift()!();
    for (const each of await Promise.allSettled(reads))
      expect(each).toMatchObject({
        status: "rejected",
        reason: { message: expect.stringMatching(/closed/) },
      });
    // The second gateway was asked only what its own hello asks, nothing of either report.
    expect(
      asked
        .filter(([name]) => name === "second")
        .map(([, method]) => method)
        .sort(),
    ).toEqual(["usage.status", "users.prefs.get"]);
    // Their slots are free again.
    await expect(
      engine.readReport({ botId: "otto", period: "today", timeZone: NY, detail: false, bots: [] }),
    ).resolves.toMatchObject({ botId: "otto" });
    engine.onClose();
    // A hello on the same socket, after its bootstrap, does not end a report that started on it.
    gatewayName = "first";
    const held2: Array<() => void> = held;
    const same = engine.readReport({
      botId: "otto",
      period: "today",
      timeZone: NY,
      detail: false,
      bots: [],
    });
    await flush();
    engine.onHello();
    await flush();
    while (held2.length > 0) held2.shift()!();
    await expect(same).resolves.toMatchObject({ botId: "otto" });
    engine.onClose();
  });

  it("F-235: refreshes of the providers' limits that overlap are one read, with one timer, and none outlives the connection", async () => {
    vi.useFakeTimers();
    const gateway = fakeGateway();
    const { engine } = engineOn(gateway, () => Date.now());
    const read = () => gateway.calls.filter((c) => c.method === "usage.status").length;
    for (let pair = 0; pair < 12; pair += 1)
      await Promise.all([engine.refreshLimits(), engine.refreshLimits()]);
    expect(read()).toBe(12);
    expect(vi.getTimerCount()).toBe(1);
    // The timer reads again, and leaves one timer.
    await vi.advanceTimersByTimeAsync(LIMITS_EVERY_MS + 10);
    expect(read()).toBe(13);
    expect(vi.getTimerCount()).toBe(1);
    // A refresh joins a read under way on the same connection; one after a close starts its own.
    const held: Array<() => void> = [];
    const { engine: other } = engineOn(
      {
        ...gateway,
        request: async (method, raw) => {
          await new Promise<void>((resolve) => held.push(resolve));
          return gateway.request(method, raw);
        },
      },
      () => Date.now(),
    );
    const first = other.refreshLimits();
    const joined = other.refreshLimits();
    expect(held).toHaveLength(1);
    other.onClose();
    held.shift()!();
    await Promise.all([first, joined]);
    engine.onClose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("F-235: a limits answer without its provider list is a failed read, not 'No limits reported'", async () => {
    const gateway = fakeGateway();
    const { engine, usage } = engineOn({
      ...gateway,
      request: async (method, raw) =>
        method === "usage.status" ? { updatedAt: 77 } : gateway.request(method, raw),
    });
    await engine.refreshLimits();
    expect(usage().limits.status).toBe("error");
    engine.onClose();
  });

  it("a hello that comes after its socket closed reads nothing and leaves no timer", async () => {
    vi.useFakeTimers();
    const gateway = fakeGateway();
    const engine = new UsageEngine({
      request: gateway.request,
      get: () => initialUsage,
      update: () => {},
      connected: () => false,
      now: () => Date.now(),
      log: () => {},
    });
    engine.onClose();
    engine.onHello();
    await vi.advanceTimersByTimeAsync(10);
    expect(gateway.calls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("F-235: reads the providers' limits at a hello", async () => {
    const { engine, usage } = engineOn(fakeGateway());
    engine.onHello();
    await flush();
    expect(usage().limits).toEqual({
      status: "ok",
      updatedAt: 77,
      providers: [],
      refreshing: false,
    });
    engine.onClose();
  });
});

describe("the bridge's usage commands", () => {
  it("checks every field before a command reaches the client", () => {
    expect(
      parseBridgeCommand({
        type: "readUsage",
        botId: "otto",
        period: "week",
        timeZone: NY,
        detail: true,
      }),
    ).toEqual({
      type: "readUsage",
      botId: "otto",
      period: "week",
      timeZone: NY,
      detail: true,
    });
    expect(() =>
      parseBridgeCommand({
        type: "readUsage",
        botId: null,
        period: "year",
        timeZone: NY,
        detail: false,
      }),
    ).toThrow("invalid period");
    expect(() =>
      parseBridgeCommand({
        type: "readUsage",
        botId: null,
        period: "week",
        timeZone: "Mars/Base",
        detail: false,
      }),
    ).toThrow("invalid time zone");
    const set = {
      op: "set",
      budget: { botId: "otto", routineId: null, period: "weekly", tokens: 5000, timeZone: NY },
    };
    expect(parseBridgeCommand({ type: "changeBudget", change: set })).toEqual({
      type: "changeBudget",
      change: {
        op: "set",
        budget: {
          botId: "otto",
          routineId: null,
          routineName: null,
          period: "weekly",
          tokens: 5000,
          timeZone: NY,
        },
      },
    });
    expect(() =>
      parseBridgeCommand({
        type: "changeBudget",
        change: { ...set, budget: { ...set.budget, tokens: 1.5 } },
      }),
    ).toThrow("invalid tokens");
    expect(() =>
      parseBridgeCommand({ type: "changeBudget", change: { op: "remove", id: "bot:../x" } }),
    ).toThrow("invalid budget id");
    expect(
      parseBridgeCommand({ type: "changeBudget", change: { op: "remove", id: "routine:job1" } }),
    ).toEqual({
      type: "changeBudget",
      change: { op: "remove", id: "routine:job1" },
    });
  });
});

describe("a budget write through the client", () => {
  const budget: BudgetInput = {
    botId: "otto",
    routineId: null,
    routineName: null,
    period: "weekly",
    tokens: 5_000,
    timeZone: NY,
  };

  /** A read-tier connection whose request for write access waits until `grant` is called. */
  async function readTier() {
    const gateway = grantingGateway();
    let prefs: unknown = undefined;
    gateway.handlers["users.prefs.get"] = () => ({
      status: "ok",
      entries: prefs === undefined ? {} : { [BUDGETS_PREF_KEY]: prefs },
    });
    gateway.handlers["users.prefs.set"] = (params) => {
      prefs = (params as { entries: Record<string, unknown> }).entries[BUDGETS_PREF_KEY];
      return { status: "ok" };
    };
    const wait = deferred<unknown>();
    gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-1" });
    gateway.handlers["device.scopes.waitUpgrade"] = () => wait.promise;
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: null, address: true }),
      [tokenKey(URL_A)]: JSON.stringify({
        token: "device-token",
        grantedScopes: READ_SCOPES,
        heldScopes: READ_SCOPES,
      }),
    });
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await until(() => client.state.discovery.status === "ready");
    const grant = () =>
      wait.resolve({
        status: "approved",
        requestId: "up-1",
        deviceToken: "rotated-token",
        scopes: [...INTERACTIVE_SCOPES],
      });
    return { client, gateway, grant, prefs: () => prefs };
  }

  it("F-234: a budget saved on a read-only connection is kept once write access is granted, on the connection the grant reopened", async () => {
    const { client, gateway, grant, prefs } = await readTier();
    const saving = client.changeBudget({ op: "set", budget }, { owner: {} });
    await until(() => client.state.connection.upgrade.status === "pending");
    expect(gateway.calls("users.prefs.set")).toEqual([]);
    grant();
    await expect(saving).resolves.toBeUndefined();
    expect(client.state.connection.canWrite).toBe(true);
    expect(prefs()).toMatchObject({ budgets: [expect.objectContaining({ id: "bot:otto" })] });
    client.stop();
  });

  it("F-234: a budget waiting for write access sends nothing once its viewer has gone, or once another gateway is chosen", async () => {
    const gone = await readTier();
    const owner = {};
    const withdrawn = gone.client.changeBudget({ op: "set", budget }, { owner });
    await until(() => gone.client.state.connection.upgrade.status === "pending");
    gone.client.withdraw(owner);
    gone.grant();
    await expect(withdrawn).rejects.toThrow("The request was withdrawn.");
    await until(() => gone.client.state.connection.canWrite);
    expect(gone.gateway.calls("users.prefs.set")).toEqual([]);
    gone.client.stop();

    const switched = await readTier();
    const elsewhere = switched.client.changeBudget({ op: "set", budget }, { owner: {} });
    await until(() => switched.client.state.connection.upgrade.status === "pending");
    await switched.client.connect({ url: URL_B, token: "t" });
    await expect(elsewhere).rejects.toThrow("Switched to another gateway.");
    expect(switched.gateway.calls("users.prefs.set")).toEqual([]);
    switched.client.stop();
  });
});
