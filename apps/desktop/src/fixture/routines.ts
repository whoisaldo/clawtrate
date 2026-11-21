// The fixture's routines (docs/design/automation.md): scheduled jobs across
// the sample bots, their runs, and a run's conversation, answered as the
// engine answers the routine commands. Every name, instruction and result is
// made up. Times are from the fixture's clock; next runs follow each schedule.
//
// Address parameters (without one, the gateway has no routines):
//   routines=on|empty|error|loading|running|scheduler-off|many|truncated
//     no routines, a failed read, still loading, Morning digest running now,
//     the gateway's scheduler off, Morning digest with 27 recorded runs, or
//     more routines than the client keeps, one of them a bot's it does not hold,
//     and one of Pip's that only Pip's own read or a search finds
//   routinehold=<id>   a routine's read, runs and conversations wait for releaseRoutineReads()
//   routinefail=<id>   a routine's read, runs and conversations fail
//   botomitted=<n>     a bot's own routine read counts n more it did not list
//   calendar=fail|partial   the calendar's read fails, or says it is partial
// With `access=admin` (accounts.ts) the routines can be changed, and:
//   save=refused|noanswer|conflict|changed   how the next save ends; `noanswer`
//                                    then finds it saved on "Check now", and
//                                    `changed` finds a new routine landed and
//                                    changed elsewhere since
//   pause=fail, run=already|fail, delete=fail   how those end
//   hooks=on                         the gateway's inbound hooks are on

// The module, not the package: the package brings the DOM, which the node-typed tests lack.
import { zonedTime } from "../../../../packages/ui/src/routines/schedule.ts";
import { changedFields, savedAs } from "@clawtrate/core";
import type {
  BridgeCommand,
  ClawtrateState,
  NewRoutine,
  Routine,
  RoutineFields,
  RoutineRun,
  RoutineSchedule,
  RoutinesState,
  RunConversation,
} from "@clawtrate/core";

export type RoutineParams = {
  state:
    | "none"
    | "ready"
    | "empty"
    | "error"
    | "loading"
    | "running"
    | "scheduler-off"
    | "many"
    | "truncated";
  hold?: string | null;
  fail?: string | null;
  calendar?: "fail" | "partial" | null;
  save?: "refused" | "noanswer" | "conflict" | "changed" | null;
  pause?: "fail" | null;
  run?: "already" | "fail" | "held" | null;
  remove?: "fail" | null;
  hooks?: boolean;
  botOmitted?: number;
};

const oneOf = <T extends string>(value: string | null, options: readonly T[]): T | null =>
  options.includes(value as T) ? (value as T) : null;

export function routineParams(params: URLSearchParams): RoutineParams {
  const state = params.get("routines");
  const calendar = params.get("calendar");
  return {
    state:
      state === "empty" ||
      state === "error" ||
      state === "loading" ||
      state === "running" ||
      state === "scheduler-off" ||
      state === "many" ||
      state === "truncated"
        ? state
        : state === "on"
          ? "ready"
          : "none",
    hold: params.get("routinehold"),
    fail: params.get("routinefail"),
    calendar: calendar === "fail" || calendar === "partial" ? calendar : null,
    save: oneOf(params.get("save"), ["refused", "noanswer", "conflict", "changed"] as const),
    pause: oneOf(params.get("pause"), ["fail"] as const),
    run: oneOf(params.get("run"), ["already", "fail", "held"] as const),
    remove: oneOf(params.get("delete"), ["fail"] as const),
    hooks: params.get("hooks") === "on",
    botOmitted: Number(params.get("botomitted")) || 0,
  };
}

const held: Array<() => void> = [];

/** Answer every held read (`routinehold`). */
export function releaseRoutineReads(): void {
  for (const release of held.splice(0)) release();
}

const NY = "America/New_York";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const schedule = (over: Partial<RoutineSchedule>): RoutineSchedule => ({
  kind: "cron",
  expr: null,
  tz: null,
  everyMs: null,
  at: null,
  name: null,
  ...over,
});

const base = (over: Partial<Routine> & Pick<Routine, "id" | "botId" | "name">): Routine => ({
  enabled: true,
  schedule: schedule({}),
  payload: "agentTurn",
  text: "",
  textCut: false,
  canRecreate: true,
  target: "isolated",
  delivery: "none",
  deliveryChannel: null,
  nextRunAt: null,
  lastRunAt: null,
  lastEndedAt: null,
  lastStatus: null,
  lastError: null,
  runningAt: null,
  deleteAfterRun: false,
  gated: false,
  updatedAt: null,
  ...over,
});

/** The wall-clock day of `now` in `tz`, `days` later, at `hour:minute` there. */
function at(now: number, tz: string, days: number, hour: number, minute = 0): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  })
    .formatToParts(now + days * DAY)
    .map((part) => Number(part.value) || 0)
    .filter((value) => value > 0);
  const [month, day, year] = parts as [number, number, number];
  return zonedTime(year, month, day, hour, minute, tz);
}

/** The first day after `now`, within five weeks, whose `hour:minute` in `tz` passes `keep`. */
function nextDay(
  now: number,
  tz: string,
  hour: number,
  keep: (weekday: string, day: number) => boolean,
): number {
  for (let days = 0; days < 36; days += 1) {
    const time = at(now, tz, days, hour);
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(
      time,
    );
    const day = Number(
      new Intl.DateTimeFormat("en-US", { timeZone: tz, day: "numeric" }).format(time),
    );
    if (time > now && keep(weekday, day)) return time;
  }
  return now + DAY;
}

/** The next weekday at 8:00 AM in New York after `now`. */
function nextWeekday8(now: number): number {
  for (let days = 0; days < 8; days += 1) {
    const time = at(now, NY, days, 8);
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: NY, weekday: "short" }).format(
      time,
    );
    if (time > now && weekday !== "Sat" && weekday !== "Sun") return time;
  }
  return now + DAY;
}

function nextAt(now: number, tz: string, hour: number, minute = 0): number {
  const today = at(now, tz, 0, hour, minute);
  return today > now ? today : at(now, tz, 1, hour, minute);
}

export const DIGEST = "routine-digest";

/** Routines past those the client keeps (`routines=truncated`), found only by their bot's read or a search. */
export function unkeptRoutines(now: number): Routine[] {
  return [
    base({
      id: "routine-trail",
      botId: "pip",
      name: "Trail conditions",
      schedule: schedule({ expr: "0 18 * * 5", tz: NY }),
      text: "Check the trail conditions for the weekend.",
      nextRunAt: nextDay(now, NY, 18, (weekday) => weekday === "Fri"),
    }),
  ];
}

export function fixtureRoutineList(now: number, params: RoutineParams): Routine[] {
  const lastDigest = at(now, NY, now > at(now, NY, 0, 8) ? 0 : -1, 8);
  // A bot past the 32 the client holds: its routine is listed under its id.
  const absent =
    params.state === "truncated"
      ? [
          base({
            id: "routine-ledger",
            botId: "ledger",
            name: "Ledger export",
            schedule: schedule({ expr: "0 6 * * *", tz: NY }),
            text: "Export yesterday's ledger.",
            nextRunAt: nextAt(now, NY, 6),
          }),
        ]
      : [];
  return [
    ...absent,
    base({
      id: DIGEST,
      botId: "marlow",
      name: "Morning digest",
      schedule: schedule({ expr: "0 8 * * 1-5", tz: NY }),
      text: "Summarise the notes I added yesterday, and list anything I need to answer today.",
      nextRunAt: nextWeekday8(now),
      lastRunAt: lastDigest,
      lastStatus: "ok",
      runningAt: params.state === "running" ? now - 2 * MINUTE : null,
    }),
    base({
      id: "routine-draft",
      botId: "marlow",
      name: "Send the draft to Sam",
      schedule: schedule({ kind: "at", at: new Date(at(now, NY, 2, 9)).toISOString(), tz: NY }),
      text: "Send Sam the final draft of the newsletter intro.",
      nextRunAt: at(now, NY, 2, 9),
      deleteAfterRun: true,
    }),
    base({
      id: "routine-disk",
      botId: "otto",
      name: "Disk space watch",
      schedule: schedule({ kind: "every", everyMs: 30 * MINUTE }),
      text: "Check free space on the media box and say so only if it is under 10%.",
      nextRunAt: now + 12 * MINUTE,
      lastRunAt: now - 18 * MINUTE,
      lastStatus: "skipped",
    }),
    base({
      id: "routine-backup",
      botId: "otto",
      name: "Nightly backup check",
      schedule: schedule({ expr: "30 3 * * *", tz: NY }),
      text: "Check last night's backup finished and that its size is in line with the week before.",
      nextRunAt: nextAt(now, NY, 3, 30),
      lastRunAt: at(now, NY, 0, 3, 30) < now ? at(now, NY, 0, 3, 30) : at(now, NY, -1, 3, 30),
      lastStatus: "error",
      lastError: "The model didn't answer within 120 seconds.",
    }),
    base({
      id: "routine-cert",
      botId: "otto",
      name: "Certificate renewal",
      // No zone: it runs in the gateway's own.
      schedule: schedule({ expr: "0 9 1 * *" }),
      text: "Renew the home server's certificate if it expires within 30 days.",
      nextRunAt: nextDay(now, "Europe/Berlin", 9, (_, day) => day === 1),
      lastRunAt: now - 18 * DAY,
      lastStatus: "ok",
    }),
    base({
      id: "routine-week",
      botId: "pip",
      name: "Plan the week",
      schedule: schedule({ expr: "0 17 * * 0", tz: "Europe/London" }),
      text: "Plan next week's dinners from what is in the fridge and the calendar.",
      // Bound to the conversation it was made in; its runs record that key.
      target: "other",
      sharedSessionKey: "agent:pip:week",
      nextRunAt: nextDay(now, "Europe/London", 17, (weekday) => weekday === "Sun"),
      lastRunAt: now - 3 * DAY,
      lastStatus: "ok",
    }),
    base({
      id: "routine-inbox",
      botId: "pip",
      name: "Inbox tidy-up",
      enabled: false,
      schedule: schedule({ expr: "0 16 * * 5", tz: NY }),
      text: "Archive newsletters older than a week.",
      lastRunAt: now - 6 * DAY,
      lastStatus: "ok",
    }),
    base({
      id: "routine-stretch",
      botId: "main",
      name: "Stretch break",
      schedule: schedule({ kind: "every", everyMs: 2 * HOUR }),
      payload: "systemEvent",
      canRecreate: false,
      target: "main",
      text: "Time to stand up and stretch.",
      delivery: "announce",
      nextRunAt: now + 40 * MINUTE,
      lastRunAt: now - 80 * MINUTE,
      lastStatus: "ok",
    }),
  ];
}

export function fixtureRoutines(now: number, params: RoutineParams): RoutinesState {
  if (params.state === "loading")
    return {
      status: "loading",
      error: null,
      schedulerOn: null,
      routines: [],
      omitted: 0,
      revision: 0,
      removed: null,
      listedOn: 0,
    };
  if (params.state === "error")
    return {
      status: "error",
      error: "The gateway didn't answer in time.",
      schedulerOn: null,
      routines: [],
      omitted: 0,
      revision: 0,
      removed: null,
      listedOn: 0,
    };
  return {
    status: "loaded",
    error: null,
    schedulerOn: params.state !== "scheduler-off",
    routines:
      params.state === "empty" || params.state === "none" ? [] : fixtureRoutineList(now, params),
    omitted: params.state === "truncated" ? 12 : 0,
    revision: 0,
    removed: null,
    listedOn: 0,
  };
}

const run = (
  routine: Routine,
  runAt: number,
  over: Partial<RoutineRun> = {},
  // What names the run in its own session key; the gateway uses the run's session id.
  session: string | number = runAt,
): RoutineRun => ({
  jobId: routine.id,
  runId: `run-${routine.id}-${runAt}`,
  runAt,
  status: "ok",
  completion: "succeeded",
  error: null,
  summary: "Three notes from yesterday. The draft for Sam is ready to send.",
  durationMs: 2_600,
  model: "dev-1",
  provider: "scripted",
  inputTokens: 120,
  outputTokens: 80,
  totalTokens: 200,
  // A session-bound routine's runs record the conversation they ran in; isolated
  // and current ones record the run's own key (observed on OpenClaw 2026.10.6),
  // and a main target records none.
  sessionKey:
    routine.target === "main"
      ? null
      : (routine.sharedSessionKey ?? `agent:${routine.botId}:cron:${routine.id}:run:${session}`),
  manual: false,
  ...over,
});

/** Every run the fixture's gateway recorded for a routine, newest first; more than 20 with `routines=many`. */
export function fixtureRuns(routine: Routine, now: number, params: RoutineParams): RoutineRun[] {
  if (routine.lastRunAt === null) return [];
  if (routine.target === "main")
    return [
      run(routine, routine.lastRunAt, {
        summary: routine.text,
        model: null,
        provider: null,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        durationMs: 1_090,
      }),
    ];
  const count = params.state === "many" ? 27 : routine.id === DIGEST ? 6 : 3;
  // A cron schedule naming one weekday runs weekly; the others here run daily.
  const step =
    routine.schedule.kind === "every"
      ? routine.schedule.everyMs!
      : /\s\d$/u.test(routine.schedule.expr ?? "")
        ? 7 * DAY
        : DAY;
  return Array.from({ length: count }, (_, index) => {
    const runAt = routine.lastRunAt! - index * step;
    if (routine.id === DIGEST && index === 1)
      return run(routine, runAt - 3 * HOUR - 20 * MINUTE, {
        manual: true,
        runId: `manual:${routine.id}:${runAt}:1`,
        durationMs: 3_100,
        totalTokens: 214,
      });
    if (routine.id === DIGEST && index === 2)
      return run(routine, runAt, {
        status: "error",
        completion: "failed",
        error: "Channel is required (no configured channels detected).",
      });
    if (routine.id === DIGEST && index === 3)
      return run(routine, runAt, { status: "skipped", summary: null, totalTokens: null });
    if (routine.lastStatus === "error" && index === 0)
      return run(routine, runAt, {
        status: "error",
        completion: "failed",
        error: routine.lastError,
        summary: null,
      });
    if (routine.lastStatus === "skipped" && index === 0)
      return run(routine, runAt, { status: "skipped", summary: null, totalTokens: null });
    return run(routine, runAt);
  });
}

/** A run's conversation, given the instruction it ran with when the gateway kept it. */
function conversation(ran: RoutineRun | undefined, text: string | undefined): RunConversation {
  if (!ran || text === undefined)
    return {
      status: "none",
      reason: "not-kept",
      error: "The recorded cron transcript is unavailable. Refresh the run and try again.",
    };
  return {
    status: "kept",
    message: `${text}\nCurrent time: Monday, November 16th, 2026 - 8:00 AM (America/New_York)\n\nThis is an unattended scheduled run. Nobody is present to clarify or approve, so complete the task with what you have.`,
    messageCut: false,
    items: [
      {
        id: "convo-1",
        role: "assistant",
        timestamp: ran.runAt + 900,
        model: "dev-1",
        blocks: [
          { kind: "reasoning", text: "First I should read yesterday's notes." },
          {
            kind: "tool-call",
            callId: "call-1",
            name: "read",
            argumentsText: '{\n  "path": "notes/yesterday.md"\n}',
            result: { isError: false, text: "Three notes." },
          },
        ],
      },
      {
        id: "convo-2",
        role: "assistant",
        timestamp: ran.runAt + 2_400,
        model: "dev-1",
        blocks: [
          {
            kind: "text",
            text: "Three notes from yesterday. The draft for Sam is ready to send. Two emails need an answer today: the venue's question about numbers and the printer's quote.",
          },
        ],
      },
    ],
    omitted: 0,
  };
}

// As `cron.update`'s patch: only the fields edited from the original, so another edit stays.
const applied = (routine: Routine, original: RoutineFields, edit: RoutineFields): Routine => ({
  ...routine,
  ...Object.fromEntries(changedFields(original, edit).map((key) => [key, edit[key]])),
  updatedAt: Date.now(),
});

const createdId = (key: string) => `routine-${key}`;

/** One fixture bridge's answers to the routine commands, or undefined for any other command. */
export function routineCommands(now: number, params: RoutineParams) {
  /** Creates in doubt whose write has not landed yet, by draft key. */
  const drafts = new Map<string, Routine>();
  /**
   * Each routine's recorded runs, newest first, as first read. A run record is
   * a fact: a later edit or Run now adds to it and never rebuilds it from the
   * routine as it is now.
   */
  const recorded = new Map<string, RoutineRun[]>();
  /** The instruction given to each run whose conversation the gateway keeps, by run id. */
  const transcripts = new Map<RoutineRun["runId"], string>();
  /** Manual runs started here: the `<n>` of the gateway's `manual:<id>:<ms>:<n>`. */
  let manualRuns = 0;
  /** Each id's removals: a removed routine's run never lands on one made again with its id. */
  const removals = new Map<string, number>();
  const runsOf = (routine: Routine) => {
    let runs = recorded.get(routine.id);
    if (!runs) {
      recorded.set(routine.id, (runs = fixtureRuns(routine, now, params)));
      // Of the seeded runs, only the newest one's conversation is within the gateway's retention.
      if (runs[0]) transcripts.set(runs[0].runId, routine.text);
    }
    return runs;
  };
  return (
    command: BridgeCommand,
    get: () => ClawtrateState,
    set: (state: ClawtrateState) => void,
  ): Promise<unknown> | undefined => {
    // The sample list stands in for routines the list omitted, never for one removed here.
    const find = (id: string) =>
      [
        ...get().routines.routines,
        ...(removals.has(id) ? [] : fixtureRoutineList(now, params)),
      ].find((each) => each.id === id);
    // `routinehold` and `routinefail` stand in for a slow or failed gateway, for one routine's reads.
    const answer = (id: string, value: () => unknown): Promise<unknown> => {
      if (params.fail === id)
        return Promise.reject(new Error("The gateway didn't answer in time."));
      if (params.hold === id) return new Promise((resolve) => held.push(() => resolve(value())));
      return Promise.resolve(value());
    };
    // What the gateway keeps now: a deleted routine is not found.
    const kept = (id: string) => get().routines.routines.find((each) => each.id === id);
    const put = (change: (routines: Routine[]) => Routine[]) =>
      set({ ...get(), routines: { ...get().routines, routines: change(get().routines.routines) } });
    // A late answer changes only a routine the gateway still has, never brings back a deleted one.
    const replace = (next: Routine) =>
      put((all) => all.map((each) => (each.id === next.id ? next : each)));
    // A create with a draft key the gateway already has updates that routine, as `cron.add` does.
    const created = (next: Routine) =>
      put((all) =>
        all.some((each) => each.id === next.id)
          ? all.map((each) => (each.id === next.id ? next : each))
          : [...all, next],
      );
    const admin = () => get().connection.canAdmin;
    // A write names the gateway its draft came from, as the engine refuses one
    // that does not (routines.ts `blocked`): a save before the identity is read,
    // or after another gateway confirmed, is not sent.
    const bound = (gateway: string | null) =>
      gateway !== null && gateway === get().connection.gatewayId;
    const later = <T>(ms: number, value: () => T) =>
      new Promise<T>((resolve) => setTimeout(() => resolve(value()), ms));
    // How the next save ends; a refusal or a conflict once, then saves work.
    const outcome = () => {
      const once = params.save ?? null;
      params.save = null;
      return once;
    };
    switch (command.type) {
      case "createRoutine": {
        if (!admin()) return Promise.resolve({ status: "not-sent", reason: "admin" });
        if (!bound(command.gateway))
          return Promise.resolve({ status: "not-sent", reason: "gateway" });
        const input: NewRoutine = command.input;
        const made = base({
          ...input,
          id: createdId(command.key),
          nextRunAt: now + DAY,
        });
        const end = outcome();
        if (end === "refused")
          return later(400, () => ({
            status: "refused",
            error:
              "invalid cron.add params: CronPattern: invalid configuration format ('99 * * *'), exactly five, six, or seven space separated parts are required.",
          }));
        if (end === "noanswer" || end === "changed") {
          drafts.set(
            command.key,
            end === "changed"
              ? { ...made, text: `${made.text} Keep it to three lines.`, updatedAt: now + 1 }
              : made,
          );
          return later(400, () => ({ status: "unknown", error: "gateway request timed out" }));
        }
        return later(400, () => {
          // A retry that lands supersedes an earlier create in doubt with this key.
          drafts.delete(command.key);
          created(made);
          return { status: "saved", routine: made };
        });
      }
      // As the engine does: a check answered on another gateway is refused, and
      // a found routine is compared with what the save sent by `savedAs`.
      case "checkRoutineCreate":
        return later(300, () => null).then(() => {
          if (!bound(command.gateway)) throw new Error("Another gateway is connected now.");
          // The write lands at the first check; a later one reads what the gateway has now.
          const made = drafts.get(command.key);
          drafts.delete(command.key);
          if (made) created(made);
          const routine = kept(createdId(command.key));
          return routine
            ? savedAs(routine, routine.text, { input: command.input })
            : { status: "missing" };
        });
      case "checkRoutineUpdate":
        return later(300, () => null).then(() => {
          if (!bound(command.gateway)) throw new Error("Another gateway is connected now.");
          const routine = kept(command.id);
          return routine ? savedAs(routine, routine.text, command) : { status: "missing" };
        });
      case "readRoutine":
        // As the engine does: a read-back answered on another gateway is refused.
        return answer(command.id, () => null)
          .then(() => later(300, () => null))
          .then(() => {
            if (command.gateway !== undefined && !bound(command.gateway))
              throw new Error("Another gateway is connected now.");
            return kept(command.id) ?? null;
          });
      case "updateRoutine": {
        if (!admin()) return Promise.resolve({ status: "not-sent", reason: "admin" });
        if (!bound(command.gateway))
          return Promise.resolve({ status: "not-sent", reason: "gateway" });
        const routine = kept(command.id);
        if (!routine) return Promise.resolve({ status: "deleted" });
        // Its runs so far ran on the schedule it has now: record them before an edit changes it.
        runsOf(routine);
        const end = outcome();
        if (end === "conflict") {
          const theirs = {
            ...routine,
            text: `${routine.text} Keep it to three lines.`,
            updatedAt: Date.now(),
          };
          replace(theirs);
          return later(300, () => ({ status: "conflict", current: theirs }));
        }
        if (end === "refused")
          return later(400, () => ({
            status: "refused",
            error:
              "invalid cron.update params: CronDate: Failed to convert date to timezone 'Mars/Base'. Please provide a valid IANA timezone.",
          }));
        if (end === "noanswer") {
          replace(applied(routine, command.original, command.edit));
          return later(400, () => ({ status: "unknown", error: "gateway request timed out" }));
        }
        return later(400, () => {
          // Deleted while the update was out: the gateway no longer has it to update.
          const current = kept(command.id);
          if (!current) return { status: "deleted" };
          // Only the edited fields: a run that ended while the edit was out stays ended.
          const next = applied(current, command.original, command.edit);
          replace(next);
          return { status: "saved", routine: next };
        });
      }
      case "setRoutineEnabled": {
        const routine = kept(command.id);
        if (!admin() || !routine) return Promise.resolve({ status: "not-sent", reason: "admin" });
        if (params.pause === "fail")
          return later(500, () => ({ status: "refused", error: "missing scope: operator.admin" }));
        return later(300, () => {
          const current = kept(command.id);
          if (!current) return { status: "deleted" };
          const next = {
            ...current,
            enabled: command.enabled,
            nextRunAt: command.enabled ? now + DAY : null,
          };
          replace(next);
          return { status: "saved", routine: next };
        });
      }
      case "runRoutineNow": {
        const routine = kept(command.id);
        if (!admin() || !routine) return Promise.resolve({ status: "not-sent", reason: "admin" });
        if (params.run === "already") return later(300, () => ({ status: "already-running" }));
        const notFound = () => ({
          status: "refused",
          error: `Automation not found: ${routine.id}. List automations and retry with a current job id.`,
        });
        if (params.run === "fail") return later(300, notFound);
        const removed = removals.get(routine.id);
        return later(300, () => {
          // Deleted before the request reached it: the gateway has no such job to run.
          const current = kept(routine.id);
          if (!current || removals.get(routine.id) !== removed) return notFound();
          const startedAt = Date.now();
          // Counted, as the gateway does, so two runs in one millisecond (a frozen clock) differ.
          const n = (manualRuns += 1);
          const runId = `manual:${routine.id}:${startedAt}:${n}`;
          if (params.run === "held") {
            // The gateway took the request; the run itself starts later, so the
            // view first says the routine is queued, then running.
            setTimeout(() => {
              const held = kept(routine.id);
              if (held && removals.get(routine.id) === removed)
                replace({ ...held, runningAt: Date.now() });
            }, 800);
            return { status: "started", runId };
          }
          // The run's session belongs to the target it started on, even if the routine is edited.
          const completed = run(current, startedAt, { runId, manual: true }, `${startedAt}-${n}`);
          transcripts.set(runId, current.text);
          replace({ ...current, runningAt: startedAt });
          setTimeout(() => {
            const ran = kept(routine.id);
            if (!ran || removals.get(routine.id) !== removed) return;
            // On top of the history as it is now, which a run that ended first may have added to.
            recorded.set(routine.id, [completed, ...runsOf(ran)]);
            replace({ ...ran, runningAt: null, lastRunAt: startedAt, lastStatus: "ok" });
          }, 2500);
          return { status: "started", runId };
        });
      }
      case "removeRoutine": {
        if (!admin()) return Promise.resolve({ status: "not-sent", reason: "admin" });
        if (params.remove === "fail")
          return later(400, () => ({ status: "refused", error: "missing scope: operator.admin" }));
        return later(300, () => {
          put((all) => all.filter((each) => each.id !== command.id));
          recorded.delete(command.id);
          removals.set(command.id, (removals.get(command.id) ?? 0) + 1);
          return { status: "removed" };
        });
      }
      case "readGatewayHooks":
        return Promise.resolve(admin() ? { enabled: params.hooks === true, path: "/hooks" } : null);
      case "refreshRoutines":
        return Promise.resolve();
      case "readBotRoutines":
        return answer(command.botId, () => ({
          routines: [
            ...fixtureRoutineList(now, params),
            ...(params.state === "truncated" ? unkeptRoutines(now) : []),
          ].filter((each) => each.botId === command.botId),
          omitted: params.botOmitted ?? 0,
        }));
      case "readRoutineRuns": {
        // The routine as it is when a held read resumes: one removed and made again since is another.
        return answer(command.id, () => {
          const routine = find(command.id);
          return routine ? runsOf(routine).slice(0, 20) : [];
        });
      }
      case "readCalendarRuns":
        if (params.calendar === "fail")
          return Promise.reject(new Error("The gateway didn't answer in time."));
        return Promise.resolve({
          runs: get()
            .routines.routines.flatMap(runsOf)
            .filter((run) => run.runAt >= command.from && run.runAt < command.to),
          partial: params.calendar === "partial",
        });
      case "readRunConversation": {
        const routine = find(command.id);
        if (!routine) return Promise.reject(new Error("unknown routine"));
        if (!command.sessionKey)
          return Promise.resolve({ status: "none", reason: "no-session", error: null });
        // As the history read: the routine there when a held read resumes, if any.
        return answer(command.id, () => {
          const now = find(command.id);
          // A run the gateway recorded without an id is named by its time.
          const ran =
            now &&
            runsOf(now).find((each) =>
              command.runId === null ? each.runAt === command.runAt : each.runId === command.runId,
            );
          return conversation(ran, ran && transcripts.get(ran.runId));
        });
      }
      default:
        return undefined;
    }
  };
}
