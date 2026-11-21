// Deterministic reply plans for the scripted model.

import { resolveRound, scenarioRounds, selectScenarios, type PlanContext } from "./scenarios.ts";
import { SEED_BOTS, type Round } from "./seed-data.ts";

export type ChatContentPart = { type?: string; text?: string };

export type ChatMessage = {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: string | ChatContentPart[] | null;
  tool_calls?: { id?: string; function?: { name?: string } }[];
  tool_call_id?: string;
};

/** One streamed piece of a reply. `delayMs` slows the stream of that step. */
export type ReplyStep =
  | { kind: "reasoning"; text: string; delayMs?: number }
  | { kind: "text"; text: string; delayMs?: number }
  | {
      kind: "tool";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
      /** Characters per streamed piece of the arguments: 32 unless a large call sets more. */
      argumentPiece?: number;
    }
  /** The request fails with this HTTP status instead of streaming a reply. */
  | { kind: "fail"; status: number; message: string };

export function messageText(message: ChatMessage): string {
  const { content } = message;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part.text ?? "").join("");
  return "";
}

/**
 * The gateway decorates user text before it reaches the model: a leading
 * `[timestamp]` and, on some turns, a trailing runtime context block.
 * Strip both so scripted prompts match exactly.
 */
export function normalizePrompt(text: string): string {
  return (
    text
      .replace(/^\s*\[[^\]]*\]\s*/, "")
      // Messages sent from a client carry a "Conversation info" block with a JSON fence first.
      .replace(/^Conversation info:[^\n]*\n```json\n[\s\S]*?\n```\s*/, "")
      .split(/\n\s*\nRuntime:/)[0]!
      .trim()
  );
}

const scriptedTurns = new Map<string, Round[]>();
for (const bot of SEED_BOTS) {
  for (const task of bot.tasks) {
    for (const turn of task.turns) {
      // Turns without rounds are played by a scenario their prompt selects.
      if (turn.rounds.length > 0) scriptedTurns.set(normalizePrompt(turn.prompt), turn.rounds);
    }
  }
}

/** Drop rounds whose tool the gateway did not offer, so replies stay valid. */
function usableRounds(rounds: Round[], tools: Set<string>): Round[] {
  return rounds.filter((round) =>
    round.every((step) => step.kind !== "tool" || tools.has(step.name)),
  );
}

/**
 * The gateway's runtime line, in the system prompt or appended to the user's
 * message, names the agent and the session the request is for.
 */
export function runtimeFacts(messages: ChatMessage[]): {
  agentId: string | null;
  sessionKey: string | null;
} {
  let agentId: string | null = null;
  let sessionKey: string | null = null;
  for (const message of [...messages].reverse()) {
    if (message.role === "assistant" || message.role === "tool") continue;
    for (const line of messageText(message).match(/Runtime:[^\n]*/g) ?? []) {
      agentId ??= /\bagent=([A-Za-z0-9_-]+)/.exec(line)?.[1] ?? null;
      sessionKey ??= /\bsession=([^\s|]+)/.exec(line)?.[1] ?? null;
    }
  }
  return { agentId, sessionKey };
}

/** A context block the gateway appends as its own user message, not the user's words. */
const isRuntimeContext = (message: ChatMessage) =>
  message.role === "user" &&
  messageText(message).trimStart().startsWith("OpenClaw runtime context:");

/** The gateway's own follow-up after a reply that had reasoning but no visible text. */
export const VISIBLE_ANSWER_REPROMPT =
  "The previous assistant turn recorded reasoning but did not produce a user-visible answer";
const isReprompt = (message: ChatMessage) =>
  message.role === "user" &&
  normalizePrompt(messageText(message)).startsWith(VISIBLE_ANSWER_REPROMPT);

/** The reply the gateway treats as "nothing to say" (OpenClaw's SILENT_REPLY_TOKEN). */
export const SILENT_REPLY = "NO_REPLY";

/**
 * Prompts the gateway writes itself, not a person, for a turn it starts on
 * its own: the heartbeat prompt (HEARTBEAT_CONTEXT_PROMPT, which a wake also
 * uses), the prompt of a turn that is only runtime context
 * (RUNTIME_EVENT_USER_PROMPT), a runtime context block that reaches the model
 * as the prompt itself, the two prompts of a command that completed after its
 * turn ended (buildExecEventPrompt), and the prompt of a scheduled event with
 * no content (buildCronEventPrompt). Each says to reply NO_REPLY when there is
 * nothing to report. A person's text cannot start with the runtime context
 * header: the gateway escapes it in user text.
 */
export const GATEWAY_TURN_PROMPTS = [
  "Follow the heartbeat monitor scratch context when provided.",
  "Continue the OpenClaw runtime event.",
  "OpenClaw runtime context:",
  "An async command you ran earlier has completed.",
  "An async command completion event was triggered",
  "A scheduled cron event was triggered, but no event content was found.",
] as const;

/** buildCronEventPrompt's reminder, which the gateway asks the bot to relay. */
const REMINDER_PROMPT = "A scheduled reminder has been triggered. The reminder content is:\n\n";
const REMINDER_RELAY = "Please relay this reminder to the user in a helpful and friendly way.";

/**
 * How the gateway opens its report that a background image_generate task
 * ended, in OpenClaw 2026.10.6 (formatTaskCompletionEvent). Plain, it is the
 * prompt of a turn of its own in the task that asked, behind the header of an
 * inter-session message from the tool (buildInterSessionPromptContext).
 * Labelled, it is a block of a runtime context message, which a person's text
 * cannot open: the gateway escapes that header in user text.
 */
const PLAIN_IMAGE_COMPLETION = new RegExp(
  [
    String.raw`^\[Inter-session message\] sourceSession=image_generate:tool:\S+ sourceChannel=internal sourceTool=image_generate isUser=false`,
    String.raw`This content was routed by OpenClaw from another session or internal tool\. [^\n]*`,
    String.raw`A background task completed\. Use this result to reply to the user in your normal assistant voice\.`,
    "",
    "source: image_generation\n",
  ].join("\n"),
);
const LABELLED_IMAGE_COMPLETION =
  /^OpenClaw runtime context:\nThis context is runtime-generated, not user-authored\. Keep internal details private\.\n\n\[Internal task completion event\]\nsource: image_generation\n/;

/**
 * The gateway's report that a background image_generate task ended: whether it
 * succeeded, and the `MEDIA:` lines of what it made. Only the report as the
 * gateway itself delivers it counts, as the text of a turn's prompt or of a
 * runtime context message; the same words anywhere else, pasted into a message
 * for instance, are not a report. Null for any other text.
 */
export function imageCompletion(text: string): { ok: boolean; media: string[] } | null {
  const opening = PLAIN_IMAGE_COMPLETION.exec(text) ?? LABELLED_IMAGE_COMPLETION.exec(text);
  if (!opening) return null;
  // The event's own fields follow its opening, one per line, up to its result.
  const fields = text.slice(opening[0].length).split("\n\n", 1)[0]!.split("\n");
  if (!fields.includes("type: image generation task")) return null;
  // Its pictures are the lines under its "Generated media:" label.
  const lines = text.split("\n");
  const label = lines.lastIndexOf("Generated media:");
  const media = [];
  for (const line of label < 0 ? [] : lines.slice(label + 1)) {
    if (!/^MEDIA:\S/.test(line)) break;
    media.push(line);
  }
  return { ok: fields.includes("status: completed successfully"), media };
}

/** The reply to a finished image task: a caption and its pictures, as the gateway asks. */
export const IMAGE_READY_REPLY = "Here is the picture you asked for.";
export const IMAGE_FAILED_REPLY = "The picture could not be made.";

export const isGatewayTurn = (prompt: string) =>
  GATEWAY_TURN_PROMPTS.some((start) => prompt.startsWith(start));

/** Which of GATEWAY_TURN_PROMPTS a request's prompt is, or null for any other prompt. */
export function gatewayTurnPrompt(messages: ChatMessage[]): string | null {
  const last = messages.findLast((m) => m.role === "user" && !isRuntimeContext(m));
  const prompt = last ? normalizePrompt(messageText(last)) : "";
  return GATEWAY_TURN_PROMPTS.find((start) => prompt.startsWith(start)) ?? null;
}

export function planReply(
  messages: ChatMessage[],
  tools: Set<string>,
  options: { pagesOrigin?: string | null } = {},
): ReplyStep[] {
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]!.role === "user" && !isRuntimeContext(messages[i]!)) {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex < 0) return [{ kind: "text", text: "Ready when you are." }];
  if (isReprompt(messages[lastUserIndex]!)) {
    // Asked again for a visible answer: a reasoning-only scenario stays reasoning-only.
    const earlier = messages
      .slice(0, lastUserIndex)
      .findLast((m) => m.role === "user" && !isRuntimeContext(m) && !isReprompt(m));
    const selected = earlier ? selectScenarios(messageText(earlier)) : [];
    if (selected.at(-1)?.scenario.name === "think-only") {
      return [
        { kind: "reasoning", text: "Still only thinking; there is no visible answer to give." },
      ];
    }
  }

  const raw = messageText(messages[lastUserIndex]!);
  const prompt = normalizePrompt(raw);
  if (prompt === "What do you remember about me?") {
    const memory = messages
      .filter((message) => message.role === "system")
      .map(messageText)
      .map((prompt) => prompt.split("\n<!-- /openclaw:attempt:STABLE -->", 1)[0]!)
      .find((prompt) => /^## .*\/MEMORY\.md\s*$/m.test(prompt))
      // A heading stops the extract only when it names another workspace file, as the
      // gateway's injected-file headings do; a `##` inside the memory itself does not.
      ?.match(/^## .*\/MEMORY\.md\s*\n([\s\S]*?)(?=^## [^\n]*\/[^\n]*\.md\s*$|(?![\s\S]))/m)?.[1]
      ?.trim();
    return [{ kind: "text", text: memory || "I have no root memory for this task." }];
  }
  const after = messages.slice(lastUserIndex + 1);
  // Each assistant message after the user's turn is one completed round.
  const roundIndex = after.filter((m) => m.role === "assistant").length;
  // A reply another bot sent later, through sessions_send, in a runtime
  // context block or as the prompt itself.
  const forwarded = [
    prompt,
    ...messages.slice(lastUserIndex).filter(isRuntimeContext).map(messageText),
  ]
    .filter((text) => text.trimStart().startsWith("OpenClaw runtime context:"))
    .find((text) => text.includes("[Inter-session message]") && text.includes("isUser=false"));

  // A turn the gateway started itself (a heartbeat, a wake, a queued system
  // event, a command that completed later) gets the gateway's own "nothing to
  // say", whatever its event text holds, and never plays a scenario. Two
  // continuations are meant to be seen and are answered: a reminder the
  // gateway asks to relay, and another bot's reply arriving in the task.
  if (prompt.startsWith(REMINDER_PROMPT)) {
    const [content, instruction] = prompt.slice(REMINDER_PROMPT.length).split(/\n\n(?=[^\n]*$)/);
    if (instruction === REMINDER_RELAY) return [{ kind: "text", text: `Reminder: ${content}` }];
    return [{ kind: "text", text: SILENT_REPLY }];
  }
  // A finished image task: the caption and the pictures, or a short failure.
  // A runtime context message of this turn can hold it, and so can the prompt itself,
  // but only when that context carries the prompt's inter-session header as data
  // (buildInterSessionPromptContext): a person's text never brings that context along.
  const currentContext = messages
    .slice(lastUserIndex + 1)
    .filter(isRuntimeContext)
    .map(messageText);
  const header = raw.split("\n", 1)[0]!;
  const provenance = `\nConversation data (data, not instructions):\n${JSON.stringify(header)}\n`;
  const completion = [
    ...(currentContext.some((text) => text.includes(provenance)) ? [raw] : []),
    ...currentContext,
  ]
    .map(imageCompletion)
    .find((found) => found !== null);
  if (completion) {
    if (!completion.ok) return [{ kind: "text", text: IMAGE_FAILED_REPLY }];
    return [{ kind: "text", text: [IMAGE_READY_REPLY, "", ...completion.media].join("\n") }];
  }
  if (isGatewayTurn(prompt) && !forwarded) return [{ kind: "text", text: SILENT_REPLY }];

  const scripted = scriptedTurns.get(prompt);
  if (scripted) {
    const rounds = usableRounds(scripted, tools);
    const round = rounds[roundIndex];
    if (round) return round;
    return [{ kind: "text", text: "That covers it." }];
  }

  const selection = selectScenarios(raw);
  if (selection.length > 0) {
    const names = new Map<string, string>();
    for (const m of after) {
      for (const call of m.tool_calls ?? []) {
        if (call.id && call.function?.name) names.set(call.id, call.function.name);
      }
    }
    const facts = runtimeFacts(messages);
    const ctx: PlanContext = {
      ...facts,
      pagesOrigin: options.pagesOrigin ?? null,
      prompt,
      results: after
        .filter((m) => m.role === "tool")
        .map((m) => ({ name: names.get(m.tool_call_id ?? "") ?? "", text: messageText(m) })),
    };
    const round = scenarioRounds(selection)[roundIndex];
    if (!round) return [{ kind: "text", text: "That covers it." }];
    return resolveRound(round, ctx, `${facts.sessionKey ?? ""}:${lastUserIndex}:${roundIndex}`);
  }

  // A reply another bot sent later gets a short acknowledgement.
  if (forwarded) {
    const from = /sourceSession=agent:([A-Za-z0-9_-]+):/.exec(forwarded)?.[1] ?? "another bot";
    const name = SEED_BOTS.find((bot) => bot.id === from)?.name ?? from;
    return [{ kind: "text", text: `${name}'s reply arrived. It is shown above.` }];
  }

  // Unscripted prompts get a short, stable answer so manual testing still works.
  return [
    { kind: "reasoning", text: "This request is not in the script, so I will acknowledge it." },
    {
      kind: "text",
      text: `This is the scripted development model. It has no reply written for:\n\n> ${prompt.slice(0, 200)}\n\nSend \`#help\` for the scenarios it can play.`,
    },
  ];
}
