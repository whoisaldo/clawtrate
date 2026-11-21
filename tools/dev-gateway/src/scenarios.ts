// Scenarios for the scripted model: deterministic replies that put a run into
// each situation the live conversation view must show. A user message selects
// one by directive (`#steps`) or by a plain-language phrase ("show your work").
// Several directives in one message run one after the other, so
// `#think #mcp #ask` reasons, calls the coding agent, then asks a question.
// The README lists them all; `SCENARIOS` is the single source.
//
// Shell commands appear only in the shell-bot scenarios, and only from the
// fixed list in `SHELL_COMMANDS`. They run only for that bot, and only once a
// person approves each one; every other bot's exec is denied by the gateway.

import { createHash } from "node:crypto";
import type { ReplyStep } from "./scripts.ts";
import { MESSAGING_PAIR, messagingPartner, SEED_BOTS } from "./seed-data.ts";
import { CODING_AGENT_SERVER } from "./coding-agent-mcp.ts";
import { PICTURE_PATH } from "./seed-files.ts";
import { outcomeMarker } from "./scripted-images.ts";

/** What a scenario may look at: who is answering, and what its tools returned so far. */
export type PlanContext = {
  agentId: string | null;
  sessionKey: string | null;
  /** Tool results since the user's message, in order. */
  results: { name: string; text: string }[];
  /** The user's message, as the scripted model matched it. */
  prompt?: string;
  /**
   * The origin of the instance's scripted pages, when its bots have browsers
   * of their own (scripted-pages.ts); null otherwise.
   */
  pagesOrigin?: string | null;
};

/**
 * A step; text built from the context once the tool results are in (a
 * function, never a tool call); or a tool call built from the context.
 */
export type Step =
  | ReplyStep
  | ((ctx: PlanContext) => ReplyStep[])
  | { kind: "tool-from"; build: (ctx: PlanContext) => ReplyStep };

const PAGES = "/scripted/pages/";
/** An address outside loopback, in a documentation range nothing answers. */
export const OUTSIDE_ADDRESS = "http://192.0.2.1/";
/** Another loopback port than the scripted pages' (one Chromium does not refuse itself): not theirs, so refused. */
export const OTHER_LOOPBACK = "http://127.0.0.1:2/scripted/pages/sign-in";

const isToolStep = (step: Step) =>
  typeof step !== "function" && (step.kind === "tool" || step.kind === "tool-from");

export type Scenario = {
  /** The directive, without `#`. */
  name: string;
  /**
   * A plain-language phrase that selects it, matched case-insensitively anywhere in the message.
   * None for a scenario chosen only by its directive.
   */
  phrase?: string;
  /** Takes a number after the directive, such as `#slow 5`, with this default. */
  defaultArg?: number;
  maxArg?: number;
  /** One line for the README. */
  summary: string;
  /** Which bots it is meant for, for the README. */
  bots?: string;
  steps: (arg: number) => Step[];
};

const think = (text: string, delayMs?: number): ReplyStep => ({
  kind: "reasoning",
  text,
  ...(delayMs ? { delayMs } : {}),
});
const say = (text: string, delayMs?: number): ReplyStep => ({
  kind: "text",
  text,
  ...(delayMs ? { delayMs } : {}),
});
/**
 * A browser call built from the scripted pages' origin, or a plain reply on
 * an instance without browsers of their own.
 */
const browserCall = (args: (origin: string) => Record<string, unknown>): Step => ({
  kind: "tool-from",
  build: (ctx) =>
    ctx.pagesOrigin
      ? { kind: "tool", id: "", name: "browser", arguments: args(ctx.pagesOrigin) }
      : { kind: "text", text: "This instance has no scripted pages." },
});

/** The reply after browser calls: what the last one says when the gateway refused it. */
const afterBrowser =
  (text: string): Step =>
  (ctx) => {
    const result = [...ctx.results].reverse().find((r) => r.name === "browser");
    if (!result) return [];
    if (/has control of this bot's browser/i.test(result.text)) {
      return [say("A person has control of my browser, so I left it alone.")];
    }
    return [say(text)];
  };

/** Tool call ids are filled in by the planner, so they are unique in a session. */
const tool = (name: string, args: Record<string, unknown>): ReplyStep => ({
  kind: "tool",
  id: "",
  name,
  arguments: args,
});
const mcp = (name: string, args: Record<string, unknown>) =>
  tool(`${CODING_AGENT_SERVER}__${name}`, args);

/**
 * The latest result of a tool, parsed as JSON. Some tools put a summary
 * before the JSON (ask_user does), so the first JSON object in it counts.
 */
function lastResult(ctx: PlanContext, name: string): Record<string, unknown> | null {
  const found = [...ctx.results].reverse().find((result) => result.name === name);
  if (!found) return null;
  // The JSON may be the whole text, or follow a summary, or be followed by
  // the tool's own text: try each object that starts a line, up to each "}"
  // that ends one.
  const starts = [...found.text.matchAll(/^\{/gm)].map((m) => m.index);
  const ends = [...found.text.matchAll(/^\}/gm)].map((m) => m.index + 1).reverse();
  for (const start of starts) {
    for (const end of [found.text.length, ...ends]) {
      if (end <= start) continue;
      try {
        const parsed: unknown = JSON.parse(found.text.slice(start, end));
        if (parsed !== null && typeof parsed === "object") return parsed as Record<string, unknown>;
      } catch {
        // try the next candidate
      }
    }
  }
  return null;
}

const rec = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

/** Every bot's workspace starts with these five files, so six reads need one twice. */
const SIX_READS = [
  { path: "AGENTS.md" },
  { path: "SOUL.md" },
  { path: "IDENTITY.md" },
  { path: "USER.md" },
  { path: "BOOTSTRAP.md" },
  { path: "AGENTS.md", offset: 3 },
];

/** The only shell commands any scenario emits. All are harmless and stay in the bot's workspace. */
export const SHELL_COMMANDS = {
  list: "ls",
  print: "echo 'Hello from Otto.'",
  missing: "ls missing-folder",
  sleep: (seconds: number) => `sleep ${seconds}`,
} as const;

/** The large write's file and size: over the 262,144-byte preview limit of the gateway's readers. */
export const LARGE_LOG_PATH = "logs/transcode.log";
export const LARGE_LOG_BYTES = 300_000;
/** The large write's content: numbered transcode lines, exactly `LARGE_LOG_BYTES` long. */
export function largeLog(): string {
  const lines: string[] = [];
  let length = 0;
  for (let i = 1; length < LARGE_LOG_BYTES; i += 1) {
    const line = `${String(i).padStart(6, "0")} transcode job finished: episode ${i % 97}, 1080p, kept in cache\n`;
    lines.push(line);
    length += line.length;
  }
  return lines.join("").slice(0, LARGE_LOG_BYTES);
}

/**
 * The large log in two calls: the lines up to about half of it (ending with a
 * whole line, its last one unique), then the rest, appended after that line.
 */
export function largeLogParts(): { first: string; lastLine: string; rest: string } {
  const log = largeLog();
  const cut = log.indexOf("\n", LARGE_LOG_BYTES / 2) + 1;
  const first = log.slice(0, cut);
  const lastLine = first.slice(first.lastIndexOf("\n", first.length - 2) + 1);
  return { first, lastLine, rest: log.slice(cut) };
}

const exec = (command: string, extra: Record<string, unknown> = {}) =>
  tool("exec", { command, workdir: ".", ...extra });

/** The text after a shell command, unless the gateway refused to run it. */
const afterExec =
  (text: string): Step =>
  (ctx) => {
    const result = [...ctx.results].reverse().find((r) => r.name === "exec");
    if (
      result &&
      /exec denied|approval/i.test(result.text) &&
      !/exited with code/.test(result.text)
    ) {
      return [say("The gateway did not let the command run.")];
    }
    return [say(text)];
  };

/** A slow stream: about four pieces a second for the given number of seconds. */
function slowText(seconds: number): ReplyStep {
  const pieces = Array.from(
    { length: seconds * 4 },
    (_, i) => `Still writing, part ${i + 1} of ${seconds * 4}. `,
  );
  return say(`Here is a long answer, streamed slowly.\n\n${pieces.join("")}\n\nDone.`, 250);
}

function partnerOf(ctx: PlanContext): string {
  // A bot outside the pair writes to the first of it, and the gateway refuses.
  return (ctx.agentId && messagingPartner(ctx.agentId)) ?? MESSAGING_PAIR[0];
}

/** A bot-to-bot message whose text tells the recipient which scenario to play. */
function message(recipientDirective: string, request: string, timeoutSeconds: number): Step[] {
  return [
    (ctx) => [
      think(
        `I will ask ${SEED_BOTS.find((bot) => bot.id === partnerOf(ctx))?.name ?? partnerOf(ctx)} for help with this.`,
      ),
    ],
    {
      kind: "tool-from",
      build: (ctx) =>
        tool("sessions_send", {
          // With only an agent id the gateway uses that bot's main session.
          agentId: partnerOf(ctx),
          message: `${recipientDirective} ${request}`,
          timeoutSeconds,
        }),
    },
    (ctx) => {
      const result = lastResult(ctx, "sessions_send");
      const id = partnerOf(ctx);
      const who = SEED_BOTS.find((bot) => bot.id === id)?.name ?? id;
      const status = typeof result?.status === "string" ? result.status : "unknown";
      if (status === "ok") return [say(`${who} replied:\n\n> ${String(result?.reply ?? "")}`)];
      if (status === "accepted") {
        return [say(`${who} is still working on it. Their reply will arrive in this task.`)];
      }
      if (result?.sentBeforeError === true) {
        return [say(`${who} got the message, but their run failed.`)];
      }
      return [say(`The message to ${who} did not get through (${status}).`)];
    },
  ];
}

const QUESTION_ROUTE = {
  id: "route",
  header: "Route",
  question: "Which route should I plan for Saturday?",
  options: [
    { label: "Lake loop", description: "3 miles, mostly flat" },
    { label: "Ridge trail", description: "6 miles, one steep climb" },
    { label: "Town walk" },
  ],
};

function answerText(ctx: PlanContext): ReplyStep[] {
  const result = lastResult(ctx, "ask_user");
  // The tool reports `{status, answers: {answers: {<questionId>: [...]}}}`.
  const outer = (result?.answers ?? {}) as Record<string, unknown>;
  const answers = ((outer.answers ?? outer) as Record<string, unknown>) ?? {};
  const lines = Object.entries(answers).map(
    ([id, value]) => `- ${id}: ${Array.isArray(value) ? value.join(", ") : String(value)}`,
  );
  if (result?.status !== "answered" || lines.length === 0) {
    return [say("No answer came back, so I will go with my best judgment.")];
  }
  return [say(`Thanks. You answered:\n\n${lines.join("\n")}`)];
}

const ask = (questions: unknown[]): Step[] => [
  think("I need a decision from you before I go on."),
  tool("ask_user", { questions, timeoutSeconds: 600 }),
  answerText,
];

/** What every `#image` scenario asks the image tool to draw. */
export const IMAGE_PROMPT = "A sun over a green hill, in flat solid colours";

/** The reply after an image_generate call: what the tool's result says happened. */
const afterImage: Step = (ctx) => {
  const result = [...ctx.results].reverse().find((r) => r.name === "image_generate");
  if (!result) return [];
  if (/Background task started/.test(result.text)) {
    return [say("I asked for the picture. It will arrive in this task when it is ready.")];
  }
  if (/not found|not available|denied/i.test(result.text)) {
    return [say("I have no image tool here.")];
  }
  return [say(`The image tool answered: ${result.text.split("\n")[0]!.slice(0, 200)}`)];
};

/**
 * One scenario per outcome of the stand-in image provider (scripted-images.ts),
 * which reads the outcome from a marker in the prompt. Only an instance
 * started with `--with-images` offers the tool. Each is chosen by its
 * directive alone: no ordinary sentence asks for a picture.
 */
function imageScenarios(): Scenario[] {
  const call = (suffix: string, extra: Record<string, unknown> = {}): Step[] => [
    think("I will ask the image tool for a picture."),
    tool("image_generate", { prompt: `${IMAGE_PROMPT}${suffix}`, ...extra }),
    afterImage,
  ];
  const bots = "any bot, on an instance started with `--with-images`";
  return [
    {
      name: "image",
      summary:
        "Asks the image tool for a picture. The tool starts a background task; the picture arrives in a later turn of the same task.",
      bots,
      steps: () => call(""),
    },
    {
      name: "image-refuse",
      summary: "Asks for a picture the stand-in image provider refuses (400, content policy).",
      bots,
      steps: () => call(` ${outcomeMarker("refuse")}`),
    },
    {
      name: "image-fail",
      summary: "Asks for a picture the stand-in image provider fails to make (500).",
      bots,
      steps: () => call(` ${outcomeMarker("fail")}`),
    },
    {
      name: "image-hang",
      summary:
        "Asks for a picture the stand-in image provider never answers; the call gives up after 5 seconds.",
      bots,
      steps: () => call(` ${outcomeMarker("hang")}`, { timeoutMs: 5000 }),
    },
  ];
}

export const SCENARIOS: Scenario[] = [
  {
    name: "help",
    phrase: "what scenarios can you play",
    summary: "Lists every directive and phrase.",
    steps: () => [
      () => [
        say(
          `Send a directive or a phrase. Several directives run in order.\n\n${SCENARIOS.filter(
            (s) => s.name !== "help",
          )
            .map(
              (s) =>
                `- \`#${s.name}${s.defaultArg === undefined ? "" : " [seconds]"}\`${s.phrase === undefined ? "" : ` or "${s.phrase}"`}: ${s.summary}`,
            )
            .join("\n")}`,
        ),
      ],
    ],
  },
  {
    name: "text",
    phrase: "reply in plain text",
    summary: "Streamed text, no reasoning.",
    steps: () => [say("Here is a plain reply, streamed in small pieces with no reasoning first.")],
  },
  {
    name: "think",
    phrase: "think before you answer",
    summary: "Reasoning, then text.",
    steps: () => [
      think("The user wants to see reasoning first. I will reason briefly, then answer."),
      say("I thought it over first. This is the answer that follows the reasoning."),
    ],
  },
  {
    name: "think-only",
    phrase: "think without answering",
    summary:
      "Reasoning only: no text and no tool. The gateway asks twice more for a visible answer, then ends the run in an error.",
    steps: () => [think("I am only thinking here and will not write a visible answer.")],
  },
  {
    name: "steps",
    phrase: "show your work",
    summary: "Reasoning, a tool call, more reasoning, another tool call, then text.",
    steps: () => [
      think("First I should see what is in my workspace."),
      tool("ls", { path: "." }),
      think("My instructions file is there. I will read it before answering."),
      tool("read", { path: "AGENTS.md" }),
      say("I listed my workspace and read my instructions. Both steps are shown above."),
    ],
  },
  {
    name: "slow",
    phrase: "take your time",
    defaultArg: 20,
    maxArg: 300,
    summary:
      "Reasoning, then text streamed slowly for N seconds (default 20): stop it, or queue a message behind it.",
    steps: (seconds) => [
      think("This will take a while, so I will stream it slowly.", 250),
      slowText(seconds),
    ],
  },
  {
    name: "stream",
    phrase: "stream a long answer",
    defaultArg: 10,
    maxArg: 300,
    summary:
      "Text streamed slowly for N seconds (default 10), with no reasoning first: a run still going when a client quits and opens again.",
    steps: (seconds) => [slowText(seconds)],
  },
  {
    name: "slow-tool",
    phrase: "run a slow tool",
    defaultArg: 20,
    maxArg: 600,
    summary:
      "A tool call that takes N seconds (default 20): steer into it, stop it or queue behind it.",
    steps: (seconds) => [
      think(
        "This tool takes a while. You can stop the run, steer it or queue a message behind it.",
      ),
      mcp("slow_task", { seconds }),
      say("The slow tool finished."),
    ],
  },
  {
    name: "tool-fail",
    phrase: "use a tool that fails",
    summary: "A tool call that fails (reading a file that does not exist), then text.",
    steps: () => [
      think("I will read my old notes. They may not exist."),
      tool("read", { path: "missing/old-notes.md" }),
      say("That file does not exist, so the step failed. I will carry on without it."),
    ],
  },
  {
    name: "long-output",
    phrase: "print a long output",
    summary: "A tool whose output is long enough for the gateway to cut it (20,000 lines).",
    steps: () => [
      think("This tool prints a lot. The gateway will shorten what it keeps."),
      mcp("long_output", { lines: 20_000 }),
      say("The tool printed 20,000 lines. Only part of them was kept."),
    ],
  },
  {
    name: "read",
    phrase: "read your instructions",
    summary: "One file read: the bot's own AGENTS.md.",
    steps: () => [
      think("I will read my instructions."),
      tool("read", { path: "AGENTS.md" }),
      say("I read my instructions file."),
    ],
  },
  {
    name: "reply-to",
    phrase: "answer that message",
    summary:
      "Text beside a folder listing, then an answer tagged as a reply to the message id after the directive. The gateway keeps that id on the answer's row (`openclawDelivery.replyToId`), never on a row with a call.",
    steps: () => [
      say("I will look first, then answer that message."),
      tool("ls", { path: "." }),
      (ctx) => {
        const id = /#reply-to\s+([\w-]+)/.exec(ctx.prompt ?? "")?.[1];
        const text = `This answers ${id ?? "no message: none was named"}.`;
        return [say(id ? `[[reply_to:${id}]] ${text}` : text)];
      },
    ],
  },
  {
    name: "read-six",
    phrase: "read six files",
    summary: "Six file reads in a row, with nothing between them.",
    steps: () => [
      think("I will read through my workspace files one after another."),
      ...SIX_READS.map((args) => tool("read", args)),
      say("I read six files in my workspace."),
    ],
  },
  {
    name: "list",
    phrase: "list your files",
    summary: "One folder listing of the bot's workspace.",
    steps: () => [tool("ls", { path: "." }), say("Those are the files in my workspace.")],
  },
  {
    name: "write",
    phrase: "write a note",
    summary: "One file write in the bot's workspace (notes/scratch.md).",
    steps: () => [
      tool("write", { path: "notes/scratch.md", content: "# Scratch\n\n- Check the trail map.\n" }),
      say("I wrote notes/scratch.md."),
    ],
  },
  {
    name: "edit",
    phrase: "edit a note",
    summary: "A file write, then an edit of the same file (notes/edit-me.md).",
    steps: () => [
      tool("write", { path: "notes/edit-me.md", content: "Leave at 9:00.\n" }),
      tool("edit", {
        path: "notes/edit-me.md",
        edits: [{ oldText: "Leave at 9:00.", newText: "Leave at 8:30." }],
      }),
      say("I changed the departure time in notes/edit-me.md."),
    ],
  },
  {
    name: "write-large",
    phrase: "write a long log",
    summary: `A file write, then an edit that appends to it, leaving it over the gateway's 256 KiB preview limit (logs/transcode.log, ${LARGE_LOG_BYTES.toLocaleString("en-US")} bytes): the Work pane says it is too large to show, with the limit. Two calls, because the gateway takes at most 256,000 bytes of arguments in one.`,
    steps: () => {
      const { first, lastLine, rest } = largeLogParts();
      return [
        // Streamed in 16 KB pieces: at the usual 32 characters it would take minutes.
        { ...tool("write", { path: LARGE_LOG_PATH, content: first }), argumentPiece: 16_384 },
        {
          ...tool("edit", {
            path: LARGE_LOG_PATH,
            edits: [{ oldText: lastLine, newText: lastLine + rest }],
          }),
          argumentPiece: 16_384,
        },
        say("I wrote the transcode log to logs/transcode.log."),
      ];
    },
  },
  {
    name: "picture",
    phrase: "look at the trail map",
    summary: `One file read of the picture seeded in Pip's workspace (${PICTURE_PATH}).`,
    bots: "Pip",
    steps: () => [
      tool("read", { path: PICTURE_PATH }),
      say("That is the trail map in my workspace."),
    ],
  },
  {
    name: "remember",
    phrase: "save this to memory",
    summary: "A memory note: a write to the bot's daily memory file (memory/2026-11-17.md).",
    steps: () => [
      think("This is worth remembering. I will add it to today's memory notes."),
      tool("write", {
        path: "memory/2026-11-17.md",
        content: "- Prefers the lake loop on relaxed weekends.\n",
      }),
      say("Saved to memory: you prefer the lake loop on relaxed weekends."),
    ],
  },
  {
    name: "search",
    phrase: "search the web",
    summary: "A web search, answered by the scripted server (no network).",
    steps: () => [
      think("I will search the web for this."),
      tool("web_search", { query: "cold climate heat pump performance", count: 3 }),
      say("I found three results; they are shown above."),
    ],
  },
  {
    name: "sessions",
    phrase: "list your tasks",
    summary: "A look at the bot's sessions (sessions_list).",
    steps: () => [tool("sessions_list", { limit: 5 }), say("Those are my recent tasks.")],
  },
  {
    name: "schedule",
    phrase: "schedule a reminder",
    summary:
      'Creates a routine, then removes it (automations). The gateway offers this tool only in runs started as its owner, as the scenario check does through the CLI; a paired client\'s run gets "Tool automations not found".',
    steps: () => [
      think("I will set up a routine, then remove it again."),
      tool("automations", {
        action: "add",
        job: {
          name: "Scripted reminder",
          schedule: { kind: "at", at: "2035-01-01T09:00:00Z" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "Reminder: check the trail conditions." },
        },
      }),
      {
        kind: "tool-from",
        build: (ctx) => {
          const added = lastResult(ctx, "automations");
          const id = added?.id ?? rec(added?.job).id ?? added?.jobId ?? "unknown";
          return tool("automations", { action: "remove", jobId: String(id) });
        },
      },
      (ctx) => [
        say(
          lastResult(ctx, "automations")?.removed === true
            ? "I created the routine and removed it again."
            : "The routine could not be set up here; the gateway offers routines only to its owner.",
        ),
      ],
    ],
  },
  {
    name: "plan",
    phrase: "show a plan",
    summary: "A tool with no kind of its own: a progress card with a finished three-step plan.",
    steps: () => [
      tool("progress_card", {
        plan: [
          { step: "Check the weather", status: "completed" },
          { step: "Book the cabin", status: "completed" },
          { step: "Pack", status: "completed" },
        ],
      }),
      say("The plan is on the card above."),
    ],
  },
  {
    name: "approve",
    phrase: "run a command I can approve",
    bots: "Otto",
    summary: `Asks to run \`${SHELL_COMMANDS.list}\` in Otto's workspace. The approval offers a reusable rule (allow-always).`,
    steps: () => [
      think("I will list my workspace with the shell. That needs your approval."),
      exec(SHELL_COMMANDS.list),
      afterExec("The command ran once you approved it, and its output is shown above."),
    ],
  },
  {
    name: "approve-once",
    phrase: "run a command I approve every time",
    bots: "Otto",
    summary: `Asks to run \`${SHELL_COMMANDS.print}\` with per-call ask "always": the approval offers no reusable rule.`,
    steps: () => [
      think("I will print a line with the shell and ask every time."),
      exec(SHELL_COMMANDS.print, { ask: "always" }),
      afterExec("That command needs a new approval every time it runs."),
    ],
  },
  {
    name: "exit-code",
    phrase: "run a command that fails",
    bots: "Otto",
    summary: `Asks to run \`${SHELL_COMMANDS.missing}\`, which exits non-zero.`,
    steps: () => [
      think("I will list a folder that does not exist."),
      exec(SHELL_COMMANDS.missing),
      afterExec("The command exited with an error code, which the result shows."),
    ],
  },
  {
    name: "exec-timeout",
    phrase: "run a command that times out",
    bots: "Otto",
    summary: `Asks to run \`${SHELL_COMMANDS.sleep(5)}\` with a 1 second limit, so it is stopped.`,
    steps: () => [
      think("I will start a command with a time limit shorter than it needs."),
      exec(SHELL_COMMANDS.sleep(5), { timeoutSeconds: 1 }),
      afterExec("The command ran past its time limit and was stopped."),
    ],
  },
  {
    name: "sleep",
    phrase: "run a slow command",
    bots: "Otto",
    defaultArg: 20,
    maxArg: 120,
    summary: "Asks to run `sleep N` (default 20, at most 120): a slow shell command.",
    steps: (seconds) => [
      think("I will run a slow shell command."),
      exec(SHELL_COMMANDS.sleep(seconds)),
      afterExec("The slow command finished."),
    ],
  },
  {
    name: "ask",
    phrase: "ask me a question",
    summary: "One question with options, through the gateway's question tool.",
    steps: () => ask([QUESTION_ROUTE]),
  },
  {
    name: "ask-many",
    phrase: "ask me several questions",
    summary: "Three questions in one card.",
    steps: () =>
      ask([
        QUESTION_ROUTE,
        {
          id: "start_time",
          header: "Start",
          question: "When should we leave?",
          options: [{ label: "8:00" }, { label: "9:30" }, { label: "11:00" }],
        },
        {
          id: "lunch",
          header: "Lunch",
          question: "Should I book lunch?",
          options: [{ label: "Yes" }, { label: "No" }],
        },
      ]),
  },
  {
    name: "ask-multi",
    phrase: "let me pick several",
    summary: "One multi-select question.",
    steps: () =>
      ask([
        {
          id: "packing",
          header: "Packing",
          question: "What should go on the packing list?",
          options: [
            { label: "Rain shell" },
            { label: "Headlamp" },
            { label: "Snacks" },
            { label: "Map" },
          ],
          multiSelect: true,
        },
      ]),
  },
  {
    name: "ask-text",
    phrase: "ask me to type an answer",
    summary:
      "A question meant to be answered in free text (every question also accepts typed text).",
    steps: () =>
      ask([
        {
          id: "trip_name",
          header: "Name",
          question: "What should I call this trip? Type any name.",
          options: [{ label: "Mountain weekend" }, { label: "Lake getaway" }],
        },
      ]),
  },
  {
    name: "reply",
    phrase: "reply with a note",
    summary: "A short note; what a bot answers when the other bot messages it.",
    steps: () => [say("Happy to help. The plan looks sound; I would leave half an hour earlier.")],
  },
  {
    name: "message",
    phrase: "message your partner",
    bots: "Marlow or Pip",
    summary: "A message to the other bot of the pair, answered in the same call.",
    steps: () => message("#reply", "Could you look over the plan?", 30),
  },
  {
    name: "message-slow",
    phrase: "message your slow partner",
    bots: "Marlow or Pip",
    summary:
      "A message to the other bot, which takes 15 seconds; the call returns before it answers, and the reply arrives later in the same task.",
    steps: () => message("#slow 15", "Could you write a long note on the plan?", 3),
  },
  {
    name: "message-fail",
    phrase: "message your failing partner",
    bots: "Marlow or Pip",
    summary: "A message to the other bot, whose run ends in a model error.",
    steps: () => message("#model-error", "Could you check the plan?", 30),
  },
  {
    name: "message-ask",
    phrase: "message your partner who asks",
    bots: "Marlow or Pip",
    summary: "A message to the other bot, which asks its own user a question before replying.",
    steps: () => message("#ask", "Which route should we plan for?", 5),
  },
  {
    name: "message-read",
    phrase: "message your partner who reads",
    bots: "Marlow or Pip",
    summary:
      "A message to the other bot, which reads its own instructions file before replying: a tool call in a run another bot's message started.",
    steps: () => message("#read", "Could you check your instructions?", 30),
  },
  {
    name: "mcp",
    phrase: "ask the coding agent",
    summary: "A call to the stand-in coding agent over MCP; the result carries a link.",
    steps: () => [
      think("This is a coding change. I will hand it to the coding agent."),
      mcp("send_message", { message: "Add a dark mode toggle to the settings page." }),
      (ctx) => {
        const result = lastResult(ctx, `${CODING_AGENT_SERVER}__send_message`);
        return [say(`The coding agent picked it up: ${String(result?.url ?? "no link returned")}`)];
      },
    ],
  },
  {
    name: "mcp-slow",
    phrase: "ask the coding agent something slow",
    defaultArg: 20,
    maxArg: 600,
    summary: "A call to the coding agent that takes N seconds (default 20) to reply.",
    steps: (seconds) => [
      think("This change is larger. The coding agent will take a while."),
      mcp("send_message", {
        message: "Refactor the settings page into sections.",
        delaySeconds: seconds,
      }),
      (ctx) => {
        const result = lastResult(ctx, `${CODING_AGENT_SERVER}__send_message`);
        return [say(`The coding agent finished: ${String(result?.url ?? "no link returned")}`)];
      },
    ],
  },
  {
    name: "mcp-error",
    phrase: "ask the coding agent to run the checks",
    summary: "A call to the coding agent that returns an error.",
    steps: () => [
      think("I will ask the coding agent to run the checks."),
      mcp("run_checks", {}),
      say("The coding agent reported that the checks failed."),
    ],
  },
  {
    name: "mcp-stop",
    phrase: "start a coding task I can stop",
    summary: "A call to the coding agent that does not finish for an hour: stop the run mid-call.",
    steps: () => [
      think("This coding task runs for a long time. Stop the run to cancel it."),
      mcp("slow_task", { seconds: 3600 }),
      say("The long coding task finished."),
    ],
  },
  {
    name: "model-error",
    phrase: "fail with a model error",
    summary: "The model request fails, so the run ends in an error.",
    steps: () => [{ kind: "fail", status: 400, message: "The scripted model was asked to fail." }],
  },
  {
    name: "browse",
    phrase: "open the scripted sign in page",
    summary: "Opens the scripted sign-in page in a new tab of the bot's own browser.",
    bots: "a bot with a browser of its own",
    steps: () => [
      browserCall((origin) => ({ action: "open", url: `${origin}${PAGES}sign-in` })),
      afterBrowser("Opened the scripted sign-in page."),
    ],
  },
  {
    name: "browse-read",
    phrase: "read the open page",
    summary: "Reads the text of the bot's current tab.",
    bots: "a bot with a browser of its own",
    steps: () => [browserCall(() => ({ action: "text" })), afterBrowser("Read the page.")],
  },
  {
    name: "browse-slow",
    phrase: "open the slow scripted page",
    summary: "Navigates the current tab to a scripted page that takes eight seconds to load.",
    bots: "a bot with a browser of its own",
    steps: () => [
      browserCall((origin) => ({ action: "navigate", url: `${origin}${PAGES}slow` })),
      afterBrowser("The slow page loaded."),
    ],
  },
  {
    name: "browse-download",
    phrase: "download the scripted file",
    summary:
      "Navigates the current tab to a scripted file that downloads slowly, over eight seconds.",
    bots: "a bot with a browser of its own",
    steps: () => [
      browserCall((origin) => ({ action: "navigate", url: `${origin}${PAGES}download` })),
      afterBrowser("Started the download."),
    ],
  },
  {
    name: "browse-outside",
    phrase: "open an outside address",
    summary: `Navigates to ${OUTSIDE_ADDRESS}, then to another loopback port (${OTHER_LOOPBACK}), and reads what the tab shows; both are refused.`,
    bots: "a bot with a browser of its own",
    steps: () => [
      browserCall(() => ({ action: "navigate", url: OUTSIDE_ADDRESS })),
      browserCall(() => ({ action: "navigate", url: OTHER_LOOPBACK })),
      browserCall(() => ({ action: "text" })),
      afterBrowser("Tried both addresses."),
    ],
  },
  ...imageScenarios(),
];

const BY_NAME = new Map(SCENARIOS.map((scenario) => [scenario.name, scenario]));
const BY_PHRASE = SCENARIOS.filter(
  (scenario): scenario is Scenario & { phrase: string } => scenario.phrase !== undefined,
).sort((a, b) => b.phrase.length - a.phrase.length);

export type Selection = { scenario: Scenario; arg: number };

/**
 * The scenarios a message selects: every known `#directive` in order, or else
 * the longest phrase it contains (a scenario without a phrase is chosen by its
 * directive only). Unknown directives are ignored.
 */
export function selectScenarios(prompt: string): Selection[] {
  const selected: Selection[] = [];
  for (const match of prompt.matchAll(/(?:^|\s)#([a-z][a-z-]*)(?:\s+(\d+))?/g)) {
    const scenario = BY_NAME.get(match[1]!);
    if (!scenario) continue;
    const raw = match[2] === undefined ? (scenario.defaultArg ?? 0) : Number(match[2]);
    const arg = Math.min(
      scenario.maxArg ?? raw,
      Math.max(scenario.defaultArg === undefined ? 0 : 1, raw),
    );
    selected.push({ scenario, arg });
  }
  if (selected.length > 0) return selected;
  const text = prompt
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ");
  const phrase = BY_PHRASE.find((scenario) =>
    ` ${text} `.includes(` ${scenario.phrase.toLowerCase()} `),
  );
  return phrase ? [{ scenario: phrase, arg: phrase.defaultArg ?? 0 }] : [];
}

/**
 * The rounds of the selected scenarios, run one after the other. A round is
 * one model call; it ends after a tool call, and steps before the next tool
 * call join the round that leads to it.
 */
export function scenarioRounds(selection: Selection[]): Step[][] {
  const rounds: Step[][] = [[]];
  for (const { scenario, arg } of selection) {
    for (const step of scenario.steps(arg)) {
      rounds.at(-1)!.push(step);
      if (isToolStep(step)) rounds.push([]);
    }
  }
  if (rounds.at(-1)!.length === 0) rounds.pop();
  return rounds;
}

/** Resolve a round's steps and give each tool call an id unique in its session. */
export function resolveRound(round: Step[], ctx: PlanContext, callSeed: string): ReplyStep[] {
  let index = 0;
  const resolved = round.flatMap((step): ReplyStep[] =>
    typeof step === "function" ? step(ctx) : step.kind === "tool-from" ? [step.build(ctx)] : [step],
  );
  return resolved.map((step) => {
    if (step.kind !== "tool" || step.id) return step;
    index += 1;
    const id = createHash("sha256").update(`${callSeed}:${index}`).digest("hex").slice(0, 16);
    return { ...step, id: `call_${id}` };
  });
}

/** The scenarios that emit a shell command. They are meant for the shell bot only. */
export const SHELL_SCENARIOS = SCENARIOS.filter((scenario) =>
  scenario
    .steps(scenario.defaultArg ?? 1)
    .some((step) => typeof step !== "function" && step.kind === "tool" && step.name === "exec"),
).map((scenario) => scenario.name);
