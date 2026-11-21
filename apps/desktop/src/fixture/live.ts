// Live conversation scenes for the fixture: the access request on the read
// tier, and a run in each of its states on the interactive tier. Every run is
// on Otto's "Disk almost full on the media box" task. Invented content only.

import {
  admitApproval,
  APPROVAL_WORDS,
  applyQuestionRequested,
  approvalForPlace,
  listUnreadWords,
  emptyActivity,
  INTERACTIVE_SCOPES,
  newRun,
  parseExecApproval,
  RawTable,
  type ApprovalCard,
  type BridgeCommand,
  type ClawtrateState,
  type OutgoingMessage,
  type QuestionCard,
  type Run,
  type Step,
  type Transcript,
  type TranscriptBlock,
} from "@clawtrate/core";
import { OPEN_TASK } from "./data.ts";

export const LIVE_SCENES = [
  "access-asking",
  "access-requested",
  "access-denied",
  "access-expired",
  "access-error",
  "access-pinned",
  "access-granted",
  "access-waiting-ssh",
  "access-waiting-here",
  "access-waiting-address",
  "access-recovered",
  "access-identity-unread",
  "access-confirming",
  "access-unconfirmed",
  "access-stale",
  "access-other-request",
  "access-identity-changed",
  "access-identity-changed-address",
  "access-list-unread",
  "read-wait",
  "composer",
  "run-thinking",
  "run-working",
  "run-streaming",
  "run-waiting",
  "run-question",
  "run-queued",
  "run-stopping",
  "run-stopped",
  "run-stopped-elsewhere",
  "run-finished-before-stop",
  "run-failed",
  "run-turn-limit",
  "stop-failed",
  "send-failed",
  "send-unknown",
  "stopped-not-sent",
  "queued-refused",
  "offline-send",
  "message-actions",
  "message-actions-read",
  "message-thread-question",
  "message-thread-failed",
  "run-stopped-with",
  "run-stopped-timeouts",
] as const;

export type LiveScene = (typeof LIVE_SCENES)[number];

/** The chat error event the failed scene's run ended with, as its Raw reads it (F-301). */
export const FAILED_EVENT = {
  runId: "run-live",
  sessionKey: "agent:otto:disk-space",
  seq: 14,
  state: "error",
  errorMessage: "The model provider is overloaded.",
  errorKind: "provider",
};

const SECOND = 1000;
const REQUEST_ID = "7c41d09e-52b3-4e8a-9f10-3d6b2a7e9c41";

const withTranscript = (state: ClawtrateState, change: (t: Transcript) => Transcript) => ({
  ...state,
  transcripts: { ...state.transcripts, [OPEN_TASK]: change(state.transcripts[OPEN_TASK]!) },
});

const interactive = (state: ClawtrateState): ClawtrateState => ({
  ...state,
  connection: {
    ...state.connection,
    scopes: [...INTERACTIVE_SCOPES],
    requestedScopes: [...INTERACTIVE_SCOPES],
    canWrite: true,
    canAnswer: true,
    canApprove: true,
  },
});

const upgrade = (
  state: ClawtrateState,
  change: Partial<ClawtrateState["connection"]["upgrade"]>,
) => ({
  ...state,
  connection: {
    ...state.connection,
    upgrade: { ...state.connection.upgrade, scopes: [...INTERACTIVE_SCOPES], ...change },
  },
});

function message(
  id: string,
  text: string,
  at: number,
  change: Partial<OutgoingMessage> = {},
): OutgoingMessage {
  return {
    id,
    text,
    mode: "new",
    status: "sent",
    runId: "run-live",
    messageSeq: null,
    leftAt: null,
    createdAt: at,
    error: null,
    attachments: [],
    ...change,
  };
}

function toolStep(
  id: string,
  name: string,
  args: Record<string, unknown>,
  at: number,
  change: Partial<Step> = {},
): Step {
  const argsText = JSON.stringify(args, null, 2);
  return {
    id: `tool:${id}`,
    kind: "tool",
    title: name,
    toolName: name,
    toolCallId: id,
    status: "running",
    startedAt: at,
    endedAt: null,
    argsText: { text: argsText, totalChars: argsText.length },
    output: null,
    result: null,
    error: null,
    approvalId: null,
    failureKind: null,
    truncated: false,
    replaceable: false,
    correction: 0,
    continuation: null,
    raw: null,
    rawSize: null,
    ...change,
  };
}

const ASK = "Can you check the backup log from last night too?";
const REPLY =
  "The backup finished at 02:14 and wrote 41 GB. Two folders were skipped because they were";

function run(now: number, change: Partial<Run>): Run {
  return newRun(
    "run-live",
    {
      state: "running",
      origin: "local",
      bound: true,
      messageId: "msg-1",
      reportedStartAt: now - 42 * SECOND,
      ...change,
    },
    now - 42 * SECOND,
  );
}

/** The transcript with one message sent and its run in the given form. */
function withRun(
  state: ClawtrateState,
  now: number,
  change: Partial<Run>,
  extra: Partial<Transcript> = {},
): ClawtrateState {
  return withTranscript(interactive(state), (transcript) => ({
    ...transcript,
    outbox: [message("msg-1", ASK, now - 42 * SECOND), ...(extra.outbox ?? [])],
    runs: [run(now, change), ...(extra.runs ?? [])],
    approvals: extra.approvals ?? [],
    questions: extra.questions ?? [],
  }));
}

const readStep = (now: number, change: Partial<Step> = {}) =>
  toolStep("call-read-1", "read", { path: "/var/log/backup/backup-2026-11-15.log" }, now, change);

/** The approval the waiting run asked for, read from a gateway-shaped record as the engine reads it. */
function approval(now: number): ApprovalCard {
  return admitApproval(
    parseExecApproval({
      id: "approval-1",
      request: {
        command: "rm -rf /srv/media/cache/thumbs",
        commandArgv: ["rm", "-rf", "/srv/media/cache/thumbs"],
        cwd: "/srv/media",
        host: "node",
        nodeId: "media-box",
        security: "allowlist",
        ask: "on-miss",
        agentId: "otto",
        sessionKey: OPEN_TASK,
        runId: "run-live",
        toolCallId: "call-exec-1",
        allowedDecisions: ["allow-once", "deny"],
      },
      createdAtMs: now - 5 * SECOND,
      expiresAtMs: now + 25 * 60 * SECOND,
    })!,
  );
}

/** The question the waiting run asked, admitted from a gateway-shaped record as the engine admits it. */
function question(now: number): QuestionCard {
  const record = {
    id: "question-1",
    runId: "run-live",
    sessionKey: OPEN_TASK,
    agentId: "otto",
    status: "pending",
    questions: [
      {
        questionId: "keep",
        header: "Old backups",
        question: "Which old backups should I keep?",
        options: [{ label: "The last two weeks" }, { label: "Only the monthly ones" }],
        isOther: true,
      },
    ],
    createdAtMs: now - 5 * SECOND,
    expiresAtMs: now + 10 * 60 * SECOND,
  };
  return applyQuestionRequested(emptyActivity, record, {
    sessionKey: OPEN_TASK,
    now,
    raw: new RawTable(),
  }).questions[0]!;
}

/** The scene's state, from the loaded fixture state. */
/**
 * The open task as history gives it to a connection that reacts and replies: each message names
 * the gateway's row id, the bot's report has reactions, and a later message of yours replies to
 * an earlier answer of Otto's (F-066, F-067, F-283).
 */
function withMessages(state: ClawtrateState): ClawtrateState {
  return withTranscript(state, (transcript) => {
    const items = transcript.items.map((each, index) => {
      if (each.role === "system") return each;
      const messageId = `row-${index + 1}`;
      if (each.role === "user") return { ...each, messageId };
      // The bot's turn: each bubble is a row of its own. The second answer had a progress
      // bubble before its call, a row of its own too, so the turn shows two.
      const blocks: TranscriptBlock[] =
        index === 3
          ? [{ kind: "text", text: "I'll write that down so I don't forget." }, ...each.blocks]
          : each.blocks;
      const texts = blocks.filter((block) => block.kind === "text").length;
      let n = 0;
      return {
        ...each,
        messageId,
        blocks: blocks.map((block) =>
          block.kind === "text"
            ? { ...block, messageId: ++n === texts ? messageId : `${messageId}-${n}` }
            : block,
        ),
      };
    });
    const answers = items.filter((each) => each.role === "assistant");
    const replied = answers[0]!;
    const last = items.at(-1)!;
    const reply = {
      id: "row-reply:99",
      role: "user" as const,
      timestamp: (last.timestamp ?? Date.now()) + 60_000,
      blocks: [{ kind: "text" as const, text: "Could you read the system log another way?" }],
      model: null,
      messageId: "row-reply",
      replyTo: {
        id: replied.messageId!,
        text: "Nothing alarming that I can see from here. The system log is outside my workspace…",
        sender: "Otto",
      },
    };
    const report = answers.at(-1)!;
    return {
      ...transcript,
      items: [...items, reply],
      reactions: {
        [report.messageId!]: [
          { emoji: "👍", count: 2, mine: true },
          { emoji: "🎉", count: 1, mine: false },
        ],
      },
    };
  });
}

export function liveScene(
  name: LiveScene,
  base: ClawtrateState,
  now: number,
): {
  initial: ClawtrateState;
  steps: Array<{ after: number; change: (s: ClawtrateState) => ClawtrateState }>;
} {
  switch (name) {
    case "access-asking":
      return { initial: upgrade(base, { status: "requesting" }), steps: [] };
    case "access-requested":
      return {
        initial: upgrade(base, {
          status: "pending",
          requestId: REQUEST_ID,
          approveCommand: `openclaw devices approve ${REQUEST_ID}`,
          approveNote: null,
        }),
        steps: [],
      };
    case "access-denied":
      return { initial: upgrade(base, { status: "rejected" }), steps: [] };
    case "access-expired":
      return { initial: upgrade(base, { status: "expired" }), steps: [] };
    case "access-error":
      return {
        initial: upgrade(base, {
          status: "error",
          error: "The gateway did not answer within 60 seconds.",
        }),
        steps: [],
      };
    case "access-pinned":
      return { initial: base, steps: [] };
    case "access-granted":
      return {
        initial: upgrade(base, {
          status: "pending",
          requestId: REQUEST_ID,
          approveCommand: `openclaw devices approve ${REQUEST_ID}`,
        }),
        steps: [
          {
            after: 300,
            change: (state) => upgrade(interactive(state), { status: "approved" }),
          },
        ],
      };
    // Setup §9's waiting state and outcomes, in the words the host and the client give them.
    case "access-waiting-ssh":
    case "access-waiting-here": {
      const words = approvalForPlace(
        name === "access-waiting-ssh"
          ? {
              route: "ssh",
              name: "devbox",
              account: "you@devbox.example",
              port: 22,
              profile: "default",
            }
          : { route: "this-computer", profile: "clawtrate" },
        REQUEST_ID,
      );
      return {
        initial: upgrade(base, {
          status: "pending",
          requestId: REQUEST_ID,
          approveCommand: words.command,
          approveNote: words.note,
          approveTitle: words.title,
          // Where the host can look, the request is also checked on a schedule (§9).
          place: name === "access-waiting-ssh" ? "ssh" : "here",
          checkAt: now + 4 * SECOND,
        }),
        steps: [],
      };
    }
    // An address route: no shell there, so the wait is the gateway's own, with no Check now.
    case "access-waiting-address":
      return {
        initial: upgrade(base, {
          status: "pending",
          requestId: REQUEST_ID,
          approveCommand: `openclaw devices approve ${REQUEST_ID}`,
          approveNote:
            "Run this on the gateway's computer, with `--profile <name>` if the gateway doesn't use the default profile:",
          approveTitle: "Waiting for approval.",
          place: "address",
          checkAt: null,
        }),
        steps: [],
      };
    // A wait this device lost, then confirmed: the strip says so once, then Granted.
    case "access-recovered":
      return {
        initial: upgrade(base, {
          status: "confirming",
          requestId: REQUEST_ID,
          place: "ssh",
        }),
        steps: [
          {
            after: 300,
            change: (state) => upgrade(interactive(state), { status: "approved", nowShown: true }),
          },
        ],
      };
    case "access-confirming":
      return { initial: upgrade(base, { status: "confirming", requestId: REQUEST_ID }), steps: [] };
    case "access-unconfirmed":
    case "access-identity-changed":
    case "access-identity-changed-address":
    case "access-identity-unread": {
      const outcome =
        name === "access-unconfirmed"
          ? "unconfirmed"
          : name === "access-identity-changed" || name === "access-identity-changed-address"
            ? "identity-changed"
            : "identity-unread";
      const state = upgrade(base, {
        status: outcome,
        requestId: REQUEST_ID,
        approveCommand: null,
        place: name === "access-identity-changed-address" ? "address" : "ssh",
      });
      return {
        initial: {
          ...state,
          connection: {
            ...state.connection,
            status: "error",
            error: {
              code:
                outcome === "unconfirmed"
                  ? "APPROVAL_UNCONFIRMED"
                  : outcome === "identity-changed"
                    ? "APPROVAL_IDENTITY_CHANGED"
                    : "APPROVAL_IDENTITY_UNREAD",
              message:
                outcome === "unconfirmed"
                  ? `${APPROVAL_WORDS.unconfirmed.title} ${APPROVAL_WORDS.unconfirmed.detail}`
                  : outcome === "identity-changed"
                    ? APPROVAL_WORDS.identityChanged
                    : APPROVAL_WORDS.identityUnread,
              hint: null,
            },
          },
        },
        steps: [],
      };
    }
    case "access-stale":
      return {
        initial: upgrade(base, { status: "stale", requestId: REQUEST_ID, approveCommand: null }),
        steps: [],
      };
    case "access-other-request":
      return {
        initial: upgrade(base, { status: "other-request", requestId: null, approveCommand: null }),
        steps: [],
      };
    case "access-list-unread":
      return {
        initial: upgrade(base, {
          status: "list-unread",
          requestId: REQUEST_ID,
          approveCommand: `openclaw devices approve ${REQUEST_ID}`,
          error: listUnreadWords("devbox", 2),
        }),
        steps: [],
      };
    case "read-wait":
      return {
        initial: withTranscript(base, (transcript) => ({
          ...transcript,
          runs: [
            newRun(
              "run-elsewhere",
              {
                state: "waiting",
                origin: "gateway",
                bound: true,
                reportedStartAt: now - 75 * SECOND,
              },
              now - 75 * SECOND,
            ),
          ],
        })),
        steps: [],
      };
    case "composer":
      return { initial: interactive(base), steps: [] };
    case "message-actions":
      return { initial: interactive(withMessages(base)), steps: [] };
    case "message-actions-read":
      return { initial: withMessages(base), steps: [] };
    case "message-thread-failed":
      // A reply the gateway refused: in its thread as in the transcript, failed, with recovery.
      return {
        initial: withTranscript(interactive(withMessages(base)), (transcript) => ({
          ...transcript,
          // After the reply: an answer history does not mark as a reply, then one it does.
          items: [
            ...transcript.items,
            {
              id: "row-after:100",
              role: "assistant",
              timestamp: now - 50 * SECOND,
              blocks: [
                {
                  kind: "text",
                  text: "Starting the nightly rotation now.",
                  messageId: "row-after",
                },
              ],
              model: null,
              messageId: "row-after",
            },
            {
              id: "row-delivered:101",
              role: "assistant",
              timestamp: now - 40 * SECOND,
              blocks: [
                {
                  kind: "text",
                  text: "I can read it through the journal instead.",
                  messageId: "row-delivered",
                },
              ],
              model: null,
              messageId: "row-delivered",
              replyTo: { id: "row-2", text: "Nothing alarming that I can see…", sender: "Otto" },
            },
          ],
          outbox: [
            message("msg-reply", "Could you check the backups too?", now - 20 * SECOND, {
              replyToId: "row-2",
              status: "failed",
              error: "The gateway refused the message.",
              runId: null,
            }),
          ],
        })),
        steps: [],
      };
    case "message-thread-question":
      // Replies in a thread while the run waits on a question: held, as any message is (F-468).
      return {
        initial: withMessages(
          withRun(
            base,
            now,
            {
              state: "waiting",
              pendingCards: [{ id: "question-1", kind: "question", since: now - 5 * SECOND }],
            },
            { questions: [question(now)] },
          ),
        ),
        steps: [],
      };
    case "run-thinking":
      return { initial: withRun(base, now, {}), steps: [] };
    case "run-working":
      return { initial: withRun(base, now, { steps: [readStep(now - 3 * SECOND)] }), steps: [] };
    case "run-streaming":
      return {
        initial: withRun(base, now, {
          steps: [readStep(now - 30 * SECOND, { status: "done", endedAt: now - 29 * SECOND })],
          text: REPLY,
        }),
        steps: [],
      };
    case "run-waiting":
      return {
        initial: withRun(
          base,
          now,
          {
            state: "waiting",
            pendingCards: [{ id: "approval-1", kind: "approval", since: now - 5 * SECOND }],
            steps: [
              toolStep(
                "call-exec-1",
                "exec",
                { command: "rm -rf /srv/media/cache/thumbs" },
                now - 6 * SECOND,
                { status: "waiting", approvalId: "approval-1" },
              ),
            ],
          },
          { approvals: [approval(now)] },
        ),
        steps: [],
      };
    case "run-question":
      return {
        initial: withRun(
          base,
          now,
          {
            state: "waiting",
            pendingCards: [{ id: "question-1", kind: "question", since: now - 5 * SECOND }],
          },
          {
            questions: [question(now)],
            outbox: [
              message("msg-2", "Also keep anything from this month.", now - 2 * SECOND, {
                mode: "steer",
                status: "held",
                attachments: [
                  { fileName: "keep-list.txt", mimeType: "text/plain", sizeBytes: 2048 },
                ],
              }),
            ],
          },
        ),
        steps: [],
      };
    case "run-queued":
      return {
        initial: withRun(
          base,
          now,
          { steps: [readStep(now - 3 * SECOND)] },
          {
            outbox: [
              message("msg-2", "Skip the photos folder.", now - 20 * SECOND, { mode: "steer" }),
              message("msg-3", "Then send me a summary.", now - 4 * SECOND, {
                mode: "queue",
                status: "queued",
                runId: null,
              }),
            ],
            runs: [newRun("msg-3", { state: "queued", origin: "local", messageId: "msg-3" }, now)],
          },
        ),
        steps: [],
      };
    case "run-stopping":
      return {
        initial: withRun(
          base,
          now,
          { state: "stopping", stopRequestedAt: now - SECOND, text: REPLY },
          {
            outbox: [
              message("msg-3", "Then send me a summary.", now - 1 * SECOND, {
                mode: "queue",
                status: "queued",
                runId: null,
              }),
            ],
            runs: [newRun("msg-3", { state: "queued", origin: "local", messageId: "msg-3" }, now)],
          },
        ),
        steps: [],
      };
    case "run-stopped":
      return {
        initial: withRun(base, now, {
          state: "stopped",
          stopRequestedAt: now - 2 * SECOND,
          endedAt: now - 2 * SECOND,
          text: REPLY,
          steps: [readStep(now - 30 * SECOND, { status: "done", endedAt: now - 29 * SECOND })],
        }),
        steps: [],
      };
    case "run-stopped-with":
      // As the gateway reported what stopped with it: helpers and Marlow's run.
      return {
        initial: withRun(base, now, {
          state: "stopped",
          stopRequestedAt: now - 2 * SECOND,
          endedAt: now - 2 * SECOND,
          text: REPLY,
          steps: [readStep(now - 30 * SECOND, { status: "done", endedAt: now - 29 * SECOND })],
          stoppedWith: {
            helpers: 1,
            bots: ["agent:marlow:main"],
            uncertain: ["agent:pip:main"],
            refused: [],
            unanswered: [],
            omitted: 0,
            recipientsAsked: true,
          },
        }),
        steps: [],
      };
    case "run-stopped-timeouts":
      // Three commands in a row ran out of time; the client stopped the run.
      return {
        initial: withRun(base, now, {
          state: "stopped",
          stopRequestedAt: now - 2 * SECOND,
          endedAt: now - 2 * SECOND,
          stoppedForTimeouts: 3,
          steps: [1, 2, 3].map((n) =>
            toolStep(
              `call_timeout_${n}`,
              "exec",
              { command: "sleep 5" },
              now - (12 - 3 * n) * SECOND,
              {
                status: "failed",
                endedAt: now - (11 - 3 * n) * SECOND,
                failureKind: "overall-timeout",
                error: "Command timed out after 1 seconds.",
              },
            ),
          ),
        }),
        steps: [],
      };
    case "run-stopped-elsewhere":
      return {
        initial: withRun(base, now, { state: "stopped", endedAt: now - 2 * SECOND, text: REPLY }),
        steps: [],
      };
    case "run-finished-before-stop":
      return {
        initial: withRun(base, now, {
          state: "completed",
          finishedBeforeStop: true,
          stopRequestedAt: now - 2 * SECOND,
          endedAt: now - SECOND,
          textComplete: true,
          text: "The backup finished at 02:14 and wrote 41 GB. Nothing was skipped.",
        }),
        steps: [],
      };
    case "run-failed":
      return {
        initial: withRun(base, now, {
          state: "failed",
          endedAt: now - 2 * SECOND,
          text: REPLY,
          // The id this client gave the chat.send frame that started the run.
          requestId: "b3f0c2a1-4d5e-4f60-8a71-92c3d4e5f607",
          error: {
            message:
              "The model provider is overloaded. Nothing ran after step 1, and steps already completed are not undone.",
            kind: "provider",
            raw: { holds: "chat-event", chars: JSON.stringify(FAILED_EVENT).length },
          },
        }),
        steps: [],
      };
    case "run-turn-limit":
      return {
        initial: withRun(base, now, {
          state: "stopped",
          stopRequestedAt: now - 3 * SECOND,
          endedAt: now - 2 * SECOND,
          turnLimit: 50,
        }),
        steps: [],
      };
    case "stop-failed":
      return {
        initial: withRun(base, now, {
          stopError: "The gateway refused chat.abort: the run is owned by another session.",
          steps: [readStep(now - 3 * SECOND)],
        }),
        steps: [],
      };
    case "send-failed":
      return {
        initial: withTranscript(interactive(base), (transcript) => ({
          ...transcript,
          outbox: [
            message("msg-1", ASK, now - 10 * SECOND, {
              status: "failed",
              runId: null,
              error: "chat.send was refused: the session is archived.",
            }),
          ],
        })),
        steps: [],
      };
    case "stopped-not-sent":
      return {
        initial: withRun(
          base,
          now,
          {
            state: "stopped",
            stopRequestedAt: now - 3 * SECOND,
            endedAt: now - 2 * SECOND,
            text: REPLY,
          },
          {
            outbox: [
              message("msg-3", "Then send me a summary.", now - 3 * SECOND, {
                mode: "queue",
                status: "not-sent",
                runId: null,
              }),
            ],
          },
        ),
        steps: [],
      };
    case "queued-refused":
      return {
        initial: withTranscript(interactive(base), (transcript) => ({
          ...transcript,
          outbox: [
            message("msg-3", "Then send me a summary.", now - 10 * SECOND, {
              mode: "queue",
              status: "failed",
              runId: null,
              error: "The gateway refused to start it: the session's budget is used up.",
            }),
          ],
        })),
        steps: [],
      };
    case "send-unknown":
      return {
        initial: withTranscript(interactive(base), (transcript) => ({
          ...transcript,
          outbox: [
            message("msg-1", ASK, now - 10 * SECOND, {
              status: "unknown",
              runId: null,
              error:
                "No answer came from the gateway, and its history does not show this message. Whether it was received is not known.",
            }),
          ],
        })),
        steps: [],
      };
    case "offline-send":
      return {
        initial: withRun(
          {
            ...base,
            connection: {
              ...base.connection,
              status: "reconnecting",
              retryAt: now + 4 * SECOND,
            },
          },
          now,
          { steps: [readStep(now - 3 * SECOND)] },
          {
            outbox: [
              message("msg-2", "Skip the photos folder.", now - 1 * SECOND, {
                mode: "steer",
                status: "awaiting-access",
              }),
            ],
          },
        ),
        steps: [],
      };
  }
}

/**
 * Commands the fixture answers in live scenes, following the engine's rules
 * closely enough for interface checks: a send starts a run, steers or
 * queues; Stop goes through stopping to stopped. Returns undefined for a
 * command it does not handle.
 */
export function liveCommand(
  command: BridgeCommand,
  get: () => ClawtrateState,
  set: (state: ClawtrateState) => void,
  files: Map<string, OutgoingMessage["attachments"][number]> = new Map(),
  /** Runs a delayed answer; the fixture's own lets a test hold it (`hold`, `release`). */
  later: (run: () => void, ms: number) => void = (run, ms) => void setTimeout(run, ms),
): Promise<unknown> | undefined {
  const now = Date.now();
  const update = (change: (t: Transcript) => Transcript) => set(withTranscript(get(), change));
  switch (command.type) {
    case "requestAccess": {
      set(upgrade(get(), { status: "requesting" }));
      later(() => {
        if (get().connection.upgrade.status !== "requesting") return;
        set(
          upgrade(get(), {
            status: "pending",
            requestId: REQUEST_ID,
            approveCommand: `openclaw devices approve ${REQUEST_ID}`,
          }),
        );
      }, 300);
      return Promise.resolve();
    }
    case "sendMessage": {
      const id = `msg-${Math.random().toString(36).slice(2, 8)}`;
      const attachments = command.attachmentIds.flatMap((each) => {
        const file = files.get(each);
        return file ? [file] : [];
      });
      update((transcript) => {
        const active = transcript.runs.find((each) =>
          ["running", "waiting", "stopping"].includes(each.state),
        );
        const asking = active && transcript.questions.some((card) => card.status === "pending");
        if (!active) {
          return {
            ...transcript,
            outbox: [
              ...transcript.outbox,
              message(id, command.text, now, {
                runId: id,
                attachments,
                ...(command.replyToId ? { replyToId: command.replyToId } : {}),
              }),
            ],
            runs: [
              ...transcript.runs,
              newRun(id, { state: "running", origin: "local", bound: true, messageId: id }, now),
            ],
          };
        }
        if (active.state === "stopping" || (command.mode === "queue" && !asking)) {
          return {
            ...transcript,
            outbox: [
              ...transcript.outbox,
              message(id, command.text, now, { mode: "queue", status: "queued", runId: null }),
            ],
            runs: [
              ...transcript.runs,
              newRun(id, { state: "queued", origin: "local", messageId: id }, now),
            ],
          };
        }
        return {
          ...transcript,
          outbox: [
            ...transcript.outbox,
            message(id, command.text, now, {
              ...(command.replyToId ? { replyToId: command.replyToId } : {}),
              mode: command.mode === "queue" ? "queue" : "steer",
              status: asking ? "held" : "sent",
              runId: active.id,
            }),
          ],
        };
      });
      return Promise.resolve({ messageId: id });
    }
    case "stopRun": {
      update((transcript) => ({
        ...transcript,
        runs: transcript.runs.map((each) =>
          each.id === command.runId ? { ...each, state: "stopping", stopRequestedAt: now } : each,
        ),
      }));
      later(
        () =>
          update((transcript) => ({
            ...transcript,
            runs: transcript.runs.map((each) =>
              each.id === command.runId && each.state === "stopping"
                ? { ...each, state: "stopped", endedAt: Date.now() }
                : each.state === "queued"
                  ? { ...each, state: "cancelled" }
                  : each,
            ),
            // As the engine does: nothing starts by itself after a confirmed Stop.
            outbox: transcript.outbox.map((each) =>
              each.status === "queued" || each.status === "held"
                ? { ...each, status: "not-sent", runId: null }
                : each,
            ),
          })),
        400,
      );
      return Promise.resolve();
    }
    case "cancelQueued":
      update((transcript) => ({
        ...transcript,
        outbox: transcript.outbox.map((each) =>
          each.id === command.messageId ? { ...each, status: "cancelled" } : each,
        ),
        runs: transcript.runs.map((each) =>
          each.id === command.messageId && each.state === "queued"
            ? { ...each, state: "cancelled" }
            : each,
        ),
      }));
      return Promise.resolve();
    case "sendQueuedNow":
      update((transcript) => ({
        ...transcript,
        outbox: transcript.outbox.map((each) =>
          each.id === command.messageId
            ? { ...each, status: "sent", mode: "steer", runId: "run-live" }
            : each,
        ),
        runs: transcript.runs.filter((each) => each.id !== command.messageId),
      }));
      return Promise.resolve();
    case "takeBackMessage": {
      const taken = get().transcripts[OPEN_TASK]?.outbox.find(
        (each) => each.id === command.messageId,
      );
      if (!taken || (taken.status !== "held" && taken.status !== "queued"))
        return Promise.reject(new Error("That message can no longer be edited."));
      update((transcript) => ({
        ...transcript,
        outbox: transcript.outbox.map((each) =>
          each.id === command.messageId ? { ...each, status: "cancelled" } : each,
        ),
        runs: transcript.runs.map((each) =>
          each.id === command.messageId && each.state === "queued"
            ? { ...each, state: "cancelled" }
            : each,
        ),
      }));
      const attachments = taken.attachments.map((file, index) => {
        const info = { id: `back-${command.messageId}-${index}`, ...file };
        files.set(info.id, file);
        return info;
      });
      return Promise.resolve({ text: taken.text, attachments });
    }
    case "sendAgain": {
      const original = get().transcripts[OPEN_TASK]?.outbox.find(
        (each) => each.id === command.messageId,
      );
      if (!original) return Promise.reject(new Error("That message is no longer held here."));
      const id = `msg-${Math.random().toString(36).slice(2, 8)}`;
      update((transcript) => ({
        ...transcript,
        outbox: [
          ...transcript.outbox,
          message(id, original.text, now, { runId: id, attachments: original.attachments }),
        ],
        runs: [
          ...transcript.runs,
          newRun(id, { state: "running", origin: "local", bound: true, messageId: id }, now),
        ],
      }));
      return Promise.resolve({ messageId: id });
    }
    case "retryMessage":
      update((transcript) => ({
        ...transcript,
        outbox: transcript.outbox.map((each) =>
          each.id === command.messageId
            ? { ...each, status: "sending", error: null, runId: command.messageId }
            : each,
        ),
        runs: transcript.runs.some((each) =>
          ["running", "waiting", "stopping"].includes(each.state),
        )
          ? transcript.runs
          : [
              ...transcript.runs,
              newRun(
                command.messageId,
                { state: "running", origin: "local", messageId: command.messageId },
                now,
              ),
            ],
      }));
      return Promise.resolve();
    case "deleteMessage":
      update((transcript) => ({
        ...transcript,
        outbox: transcript.outbox.filter((each) => each.id !== command.messageId),
      }));
      return Promise.resolve();
    case "createTask":
      return Promise.resolve({ key: "agent:otto:new-task" });
    case "setTurnLimit":
      set({ ...get(), turnLimitMinutes: command.minutes });
      return Promise.resolve();
    case "readComposerMenu":
      // As the gateway lists them for Otto: its skills and commands, or the bots and a routine.
      return Promise.resolve(
        command.trigger === "/"
          ? [
              {
                kind: "skill",
                name: "healthcheck",
                description: "Check the health of this machine and its services.",
                insert: "/healthcheck",
              },
              {
                kind: "skill",
                name: "weather",
                description: "Get the weather for a place.",
                insert: "/weather",
              },
              {
                kind: "command",
                name: "status",
                description: "Show the session's status.",
                insert: "/status",
              },
              {
                kind: "command",
                name: "compact",
                description: "Compact the session's context.",
                insert: "/compact",
              },
            ]
          : [
              ...get().bots.map((bot) => ({
                kind: "bot" as const,
                name: bot.name,
                description: null,
                insert: `@${bot.name}`,
              })),
              {
                kind: "routine",
                name: "Morning disk check",
                description: null,
                insert: "@Morning disk check",
              },
            ],
      );
    case "setReaction":
      // As the gateway answers: the message's reactions now, this person's marked.
      update((transcript) => {
        const list = transcript.reactions?.[command.messageId] ?? [];
        const existing = list.find((each) => each.emoji === command.emoji);
        const next = command.remove
          ? list.flatMap((each) =>
              each.emoji !== command.emoji || !each.mine
                ? [each]
                : each.count > 1
                  ? [{ ...each, count: each.count - 1, mine: false }]
                  : [],
            )
          : existing
            ? list.map((each) =>
                each.emoji === command.emoji && !each.mine
                  ? { ...each, count: each.count + 1, mine: true }
                  : each,
              )
            : [...list, { emoji: command.emoji, count: 1, mine: true }];
        const reactions = { ...transcript.reactions };
        if (next.length > 0) reactions[command.messageId] = next;
        else delete reactions[command.messageId];
        return { ...transcript, reactions };
      });
      return Promise.resolve();
    default:
      return undefined;
  }
}
