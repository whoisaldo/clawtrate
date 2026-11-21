// The fixture's answers to the search commands (docs/design/search.md),
// shaped as the engine returns them: messages found in the fixture's own
// transcripts, its routines, and made-up file names for each bot's workspace.
//
// Address parameters:
//   search=on        every transcript row carries the gateway's message id, so a
//                    message result can be opened in place
//   src=<a,b>        conditions: msgfail (the first message search fails),
//                    truncated, indexing, archive, eachfail (Pip's own search fails
//                    once), routinesfail, routinesmorefail, routineschanged,
//                    routinesnorev, filesfail (Pip's), filesnoroot (Juniper's),
//                    filestimeout (Juniper's never answers), filescap (Otto's walk
//                    stopped), slow (nothing answers), missing (a match not among
//                    the loaded rows), unlisted (a match in a task the list never held)
//   routinepage=3    the routine page size, so a few routines page
//   marlow=workspace Marlow's workspace can be verified too

import type {
  BridgeCommand,
  ClawtrateState,
  FileSearch,
  MessageHit,
  MessageSearch,
  RoutineSearch,
  Transcript,
} from "@clawtrate/core";
import { unkeptRoutines } from "./routines.ts";

export type SearchParams = {
  ids: boolean;
  src: Set<string>;
  routinePage: number;
  marlow: boolean;
};

export const NO_SEARCH_PARAMS: SearchParams = {
  ids: false,
  src: new Set(),
  routinePage: 50,
  marlow: false,
};

export function searchParams(params: URLSearchParams): SearchParams {
  const page = Number(params.get("routinepage"));
  return {
    ids: params.get("search") === "on",
    src: new Set((params.get("src") ?? "").split(",").filter(Boolean)),
    routinePage: Number.isInteger(page) && page > 0 ? page : 50,
    marlow: params.get("marlow") === "workspace",
  };
}

/** The gateway's id of each row (`__openclaw.id`), as history carries it. */
export function withMessageIds(
  transcripts: Record<string, Transcript>,
): Record<string, Transcript> {
  return Object.fromEntries(
    Object.entries(transcripts).map(([key, transcript]) => [
      key,
      {
        ...transcript,
        items: transcript.items.map((item) => {
          const messageId = `m-${item.id}`;
          if (item.role === "user") return { ...item, messageId };
          if (item.role !== "assistant") return item;
          let n = 0;
          return {
            ...item,
            messageId,
            blocks: item.blocks.map((block) =>
              block.kind === "text" ? { ...block, messageId: `${messageId}-${(n += 1)}` } : block,
            ),
          };
        }),
      },
    ]),
  );
}

const FILES: Record<string, string[]> = {
  main: ["AGENTS.md", "notes/heat-pumps.md", "notes/installer-questions.md"],
  marlow: ["AGENTS.md", "drafts/newsletter-intro.md"],
  otto: ["AGENTS.md", "inventory.md", "notes/media-box.md", "notes/disk-2026-11-16.md"],
  pip: ["AGENTS.md", "lists/mountain-weekend.md", "pictures/trail-map.png"],
  quartermaster: ["lists/errands.md", "lists/school-supplies.md"],
};

const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Up to 48 words around the first piece, as the gateway's snippet is cut. */
function snippet(text: string, piece: string): string {
  const words = text.split(/\s+/);
  const at = Math.max(
    0,
    words.findIndex((word) => fold(word).includes(piece)),
  );
  const from = Math.max(0, at - 16);
  const cut = words.slice(from, from + 48).join(" ");
  return `${from > 0 ? "… " : ""}${cut}${from + 48 < words.length ? " …" : ""}`.slice(0, 500);
}

function findMessages(
  state: ClawtrateState,
  query: string,
  botId: string | null,
  params: SearchParams,
): MessageSearch {
  const pieces = query.split(/\s+/).map(fold).filter(Boolean);
  const hits: MessageHit[] = [];
  const titles: Record<string, string> = {};
  for (const [bot, tasks] of Object.entries(state.tasksByBot)) {
    if (botId !== null && bot !== botId) continue;
    for (const task of tasks) {
      const transcript = state.transcripts[task.key];
      for (const item of transcript?.items ?? []) {
        if (item.role === "system") continue;
        for (const block of item.blocks) {
          const messageId =
            item.role === "user"
              ? item.messageId
              : block.kind === "text"
                ? block.messageId
                : undefined;
          if (block.kind !== "text" || !messageId) continue;
          const text = fold(block.text);
          if (!pieces.every((piece) => text.includes(piece))) continue;
          hits.push({
            sessionKey: task.key,
            sessionId: task.sessionId,
            messageId,
            botId: bot,
            role: item.role,
            timestamp: item.timestamp,
            snippet: snippet(block.text, pieces[0]!),
          });
          titles[task.key] = task.title;
        }
      }
    }
  }
  if (params.src.has("missing") && pieces.includes("transcode") && botId === null)
    hits.push({
      sessionKey: "agent:otto:disk-space",
      sessionId: "otto-disk-space",
      messageId: "m-not-loaded",
      botId: "otto",
      role: "assistant",
      timestamp: Date.now() - 2 * 60_000,
      snippet: "The transcode cache is back under 20 GB.",
    });
  if (params.src.has("unlisted") && pieces.includes("transcode") && botId === null) {
    hits.push({
      sessionKey: "agent:otto:x-old",
      sessionId: "otto-x-old",
      messageId: "m-x-1",
      botId: "otto",
      role: "assistant",
      timestamp: Date.now() - 400 * 86_400_000,
      snippet: "The transcode settings from last year are in the old notes folder.",
    });
    titles["agent:otto:x-old"] = "Old transcode settings";
  }
  return {
    hits: hits.slice(0, 25),
    titles,
    truncated: hits.length > 25 || (botId === null && params.src.has("truncated")),
    indexing: params.src.has("indexing") && botId !== "marlow",
    archivedExcluded: params.src.has("archive") && botId === null ? 4 : 0,
  };
}

const never = () => new Promise<never>(() => {});

/** The fixture's answer to a search command, or undefined for any other command. */
export function searchCommands(
  params: SearchParams,
  deferred: (run: () => void, ms: number) => void,
) {
  // Answers wait as the bridge's other delayed answers do, so a test's hold() keeps them.
  const answer = <T>(value: () => T) =>
    new Promise<T>((resolve) => deferred(() => resolve(value()), 120));
  let messageSearches = 0;
  let eachFailed = false;
  let routinesFailed = false;
  let moreFailed = false;
  let filesFailed = false;
  return (command: BridgeCommand, get: () => ClawtrateState): Promise<unknown> | undefined => {
    const { src } = params;
    switch (command.type) {
      case "searchMessages": {
        if (src.has("slow")) return never();
        if (command.botId === null && src.has("msgfail") && (messageSearches += 1) === 1)
          return Promise.reject(new Error("the gateway didn't answer in time"));
        if (command.botId === "pip" && src.has("eachfail") && !eachFailed) {
          eachFailed = true;
          return Promise.reject(new Error("the search index is busy"));
        }
        return answer(() => findMessages(get(), command.query, command.botId, params));
      }
      case "searchRoutines": {
        if (src.has("slow")) return never();
        if (command.offset === 0 && src.has("routinesfail") && !routinesFailed) {
          routinesFailed = true;
          return Promise.reject(new Error("the gateway didn't answer in time"));
        }
        if (command.offset > 0 && src.has("routinesmorefail") && !moreFailed) {
          moreFailed = true;
          return Promise.reject(new Error("the gateway didn't answer in time"));
        }
        return answer((): RoutineSearch => {
          const state = get();
          const q = command.query.toLowerCase();
          const names = new Map(state.bots.map((bot) => [bot.id, bot.name]));
          const gateway = [
            ...state.routines.routines,
            ...(state.routines.omitted > 0 ? unkeptRoutines(Date.now()) : []),
          ];
          const all = gateway.filter((routine) =>
            [routine.id, routine.name, routine.botId, names.get(routine.botId) ?? ""]
              .join("\n")
              .toLowerCase()
              .includes(q),
          );
          const page = all.slice(command.offset, command.offset + params.routinePage);
          const next = command.offset + page.length;
          const changed = src.has("routineschanged") && command.offset > 0;
          return {
            offset: command.offset,
            routines: page.map((routine) => ({
              id: routine.id,
              name: routine.name,
              description: "",
              botId: routine.botId,
              enabled: routine.enabled,
            })),
            total: all.length,
            hasMore: next < all.length,
            nextOffset: next < all.length ? next : null,
            revision: src.has("routinesnorev") ? null : changed ? "2" : "1",
          };
        });
      }
      case "searchFiles": {
        const { botId } = command;
        if (src.has("slow") || (botId === "main" && src.has("filestimeout"))) return never();
        if (botId === "pip" && src.has("filesfail") && !filesFailed) {
          filesFailed = true;
          return Promise.reject(new Error("permission denied"));
        }
        return answer((): FileSearch => {
          if (botId === "marlow" && !params.marlow) return { status: "unverified", botId };
          if (botId === "main" && src.has("filesnoroot")) return { status: "no-root", botId };
          const q = command.query.toLowerCase();
          const paths = (FILES[botId] ?? []).filter((path) => path.toLowerCase().includes(q));
          return {
            status: "searched",
            botId,
            paths,
            returned: paths.length,
            truncated: botId === "otto" && src.has("filescap"),
          };
        });
      }
      default:
        return undefined;
    }
  };
}
