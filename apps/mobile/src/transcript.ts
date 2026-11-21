// What a task's chat shows, from its transcript: the task's title first, the
// centred stamps, your messages and the bot's, and each of the bot's actions as
// one line in the engine's own words (`lineOf`, `foldLineOf`, grouped by
// `groupFeed` as the desktop groups them). Reasoning stays folded away, as the
// design says; it is not drawn here. A run that is going on shows its streaming
// text and says what it does in the status line's words, in the past tense
// while the connection is lost or closed, and the history that lands when it
// ends replaces both. A message the engine cut or the gateway truncated, and
// earlier messages not loaded, are said. Pure, so the unit tests cover it.

import {
  activeRun,
  callFromBlock,
  foldLineOf,
  groupFeed,
  lineOf,
  readingContextOf,
  type FeedEntry,
  type Run,
  type Step,
  type Task,
  type Transcript,
  type TranscriptItem,
} from "@clawtrate/core";
import { actionWords } from "@clawtrate/core";
import { CONVERSATION_WORDS, stampBefore } from "./presentation/conversation-words.ts";
import { stampTime } from "../../../packages/ui/src/format.ts";
import { statusLineFor } from "../../../packages/ui/src/live.ts";
import { STATE_WORDS } from "./presentation/summary.ts";

export type ChatRow =
  | { kind: "stamp"; id: string; text: string }
  | { kind: "user"; id: string; text: string }
  | { kind: "bot"; id: string; text: string }
  | {
      kind: "action";
      id: string;
      /** The line's words, as the desktop's card reads them. */
      text: string;
      /** The accessible name. */
      spoken: string;
      tone: "danger" | null;
    }
  | { kind: "event"; id: string; text: string }
  /** A message the engine cut or the gateway truncated, or earlier messages not loaded. */
  | { kind: "note"; id: string; text: string }
  /**
   * A run going on now: what it is doing, in the status line's words. `tone` is
   * the connection's: live while connected, lost while it reconnects, off when
   * the person closed it.
   */
  | { kind: "running"; id: string; text: string; tone: "live" | "lost" | "off" };

/** How the connection stands, for what a run is said to be doing. */
export type Link = { connected: boolean; closed: boolean };

type Ref = { text: string };

/** Every tool step of the task's runs, by tool call id: history's block reads better with it. */
function stepIndex(runs: Run[]): Map<string, { step: Step; run: Run }> {
  const index = new Map<string, { step: Step; run: Run }>();
  for (const run of runs)
    for (const step of run.steps)
      if (step.kind === "tool" && step.toolCallId) index.set(step.toolCallId, { step, run });
  return index;
}

/** One assistant item's record, in order, for the engine's grouping. */
function entriesOf(
  item: TranscriptItem,
  index: Map<string, { step: Step; run: Run }>,
): FeedEntry<Ref>[] {
  const entries: FeedEntry<Ref>[] = [];
  item.blocks.forEach((block, i) => {
    if (block.kind === "text") {
      if (block.text.trim())
        entries.push({ type: "bubble", id: `${item.id}:t${i}`, ref: { text: block.text } });
    } else if (block.kind === "reasoning") {
      entries.push({
        type: "reasoning",
        segment: { id: `${item.id}:r${i}`, text: block.text, startedAt: null, endedAt: null },
      });
    } else {
      const found = index.get(block.callId);
      entries.push({ type: "action", call: callFromBlock(block, found?.step, found?.run) });
    }
  });
  return entries;
}

/**
 * The phrase for a task that runs now, and its tone; null when nothing runs.
 * With no transcript loaded (a task opened while offline), the gateway's row
 * alone says what was last seen.
 */
export function runningWords(
  task: Task,
  transcript: Transcript | undefined,
  botName: string,
  link: Link,
): { text: string; tone: "live" | "lost" | "off" } | null {
  const tone = link.connected ? "live" : link.closed ? "off" : "lost";
  const run = transcript ? activeRun(transcript) : null;
  if (run && transcript) {
    const view = statusLineFor(run, transcript, {
      connected: link.connected,
      interactive: false,
    });
    // Text that streams with no tool running is the bot writing, not thinking.
    const writing =
      link.connected &&
      view.callId === null &&
      run.text.trim() !== "" &&
      view.phrase === actionWords.PHRASES.thinking;
    const phrase = link.closed
      ? view.phrase.replace(/^Reconnecting\./, "Disconnected.")
      : view.phrase;
    return { text: writing ? actionWords.PHRASES.writing : phrase, tone };
  }
  if (task.status !== "running") return null;
  // The gateway's row says it runs before this client has seen the run. That is
  // news only while connected; a row kept from before is what was last seen.
  if (link.connected) return { text: `The gateway reports a run for ${botName}.`, tone };
  const phrase = link.closed ? actionWords.PHRASES.disconnected : actionWords.PHRASES.reconnecting;
  return { text: phrase(STATE_WORDS.working), tone };
}

/** What to say under an item the gateway truncated when it stored it, or the engine cut a block of to its bound. */
export function shortenedWords(item: TranscriptItem): string | null {
  if (item.truncated === true) return CONVERSATION_WORDS.truncated;
  return (item.cut ?? []).some((path) => path.startsWith("blocks"))
    ? CONVERSATION_WORDS.shortened
    : null;
}

function noteRow(item: TranscriptItem): ChatRow[] {
  const text = shortenedWords(item);
  return text ? [{ kind: "note", id: `shortened:${item.id}`, text }] : [];
}

export function chatRows(
  task: Task,
  transcript: Transcript,
  botName: string,
  now: number,
  link: Link,
): ChatRow[] {
  const rows: ChatRow[] = [];
  if (transcript.hasMore)
    rows.push({ kind: "note", id: "earlier", text: CONVERSATION_WORDS.earlier });
  const ctx = readingContextOf(transcript);
  const index = stepIndex(transcript.runs);
  let previous: number | null = null;
  for (const item of transcript.items) {
    const at = item.timestamp;
    if (stampBefore(previous, at))
      rows.push({ kind: "stamp", id: `stamp:${item.id}`, text: stampTime(at!, now) });
    if (at !== null) previous = at;
    if (item.role === "system") {
      const text = item.blocks
        .map((block) => (block.kind === "text" ? block.text : ""))
        .join(" ")
        .trim();
      if (text) rows.push({ kind: "event", id: item.id, text });
      rows.push(...noteRow(item));
      continue;
    }
    if (item.role === "user") {
      const text = item.blocks
        .map((block) => (block.kind === "text" ? block.text : ""))
        .join("\n\n")
        .trim();
      if (text) rows.push({ kind: "user", id: item.id, text });
      rows.push(...noteRow(item));
      continue;
    }
    for (const group of groupFeed(entriesOf(item, index), ctx)) {
      if (group.type === "bubble") rows.push({ kind: "bot", id: group.key, text: group.ref.text });
      else if (group.type === "action") {
        const line = lineOf(group.call, ctx);
        rows.push({
          kind: "action",
          id: group.key,
          text: line.title,
          spoken: line.spoken,
          tone: line.problem ? "danger" : null,
        });
      } else if (group.type === "fold") {
        const line = foldLineOf(
          group.members.map((member) => member.call),
          ctx,
        );
        rows.push({
          kind: "action",
          id: group.key,
          text: line.title,
          spoken: line.spoken,
          tone: line.tone === "danger" ? "danger" : null,
        });
      }
    }
    rows.push(...noteRow(item));
  }
  const active = activeRun(transcript);
  // What the run has written so far, before it lands in history.
  if (active && active.text.trim() !== "") {
    rows.push({ kind: "bot", id: `live:${active.id}`, text: active.text });
    if (active.cut?.includes("text"))
      rows.push({
        kind: "note",
        id: `shortened:live:${active.id}`,
        text: CONVERSATION_WORDS.shortened,
      });
  }
  const running = runningWords(task, transcript, botName, link);
  if (running) rows.push({ kind: "running", id: "running", ...running });
  return rows;
}
