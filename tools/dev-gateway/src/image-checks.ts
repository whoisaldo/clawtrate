// The image checks: the gateway's image_generate tool with the stand-in image
// provider (scripted-images.ts), asserted from the gateway's answers.
// `pnpm scenarios` runs them on the computer checks' instance, which it starts
// with `--with-images` as well. docs/research/image-generation.md says what
// they establish.
//
// Clients: one paired operator with read and write, and one read-only. The
// checks run one after the other, so the stand-in's requests since a check
// began are that check's own.

import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { OperatorSession } from "./operator.ts";
import { IMAGE_MODEL_ID, scriptedPicture, type ImageRequestRecord } from "./scripted-images.ts";
import { IMAGE_PROMPT } from "./scenarios.ts";
import { IMAGE_FAILED_REPLY, IMAGE_READY_REPLY } from "./scripts.ts";

type JsonRecord = Record<string, unknown>;
const rec = (value: unknown): JsonRecord =>
  value !== null && typeof value === "object" ? (value as JsonRecord) : {};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class ImageCheckFailure extends Error {}
function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ImageCheckFailure(message);
}
const show = (value: unknown) => JSON.stringify(value)?.slice(0, 300) ?? String(value);
function same(actual: unknown, expected: unknown, what: string): void {
  expect(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${what}: expected ${show(expected)}, got ${show(actual)}`,
  );
}

export type ImageContext = {
  /** Read and write, with tool events. */
  writer: OperatorSession;
  /** Read only. */
  reader: OperatorSession;
  /** The gateway's own HTTP origin, for the addresses `artifacts.download` names. */
  gatewayOrigin: string;
  /** The stand-in image provider's origin. */
  imagesOrigin: string;
  /** The instance's state folder, where the gateway keeps its files. */
  stateDir: string;
  /** The gateway's own bearer token (`gateway.auth.token`), for its HTTP routes. */
  gatewayToken: string;
  /** The scripted model's log, where its egress proxy records what it refused. */
  providerLog: string;
  /** The gateway's log, where it records what its fetches got back. */
  gatewayLog: string;
  stamp: string;
};

type ImageCheck = { name: string; covers: string[]; run: (ctx: ImageContext) => Promise<void> };

/** The call's `timeoutMs` in `#image-hang` (scenarios.ts). */
const HANG_TIMEOUT_MS = 5000;

/** The id of the run the gateway starts in the task once the image task has ended. */
const completionRun = (taskId: string, outcome: "ok" | "error") =>
  `image_generate:${taskId}:${outcome}:agent-loop`;

async function standInRequests(ctx: ImageContext): Promise<ImageRequestRecord[]> {
  const answer = await fetch(`${ctx.imagesOrigin}/scripted/images/requests`);
  return ((await answer.json()) as { requests: ImageRequestRecord[] }).requests;
}

/** The one request the stand-in received since `since` requests, with the prompt it was sent. */
async function onlyRequestSince(
  ctx: ImageContext,
  since: number,
  prompt: string,
): Promise<ImageRequestRecord> {
  const requests = (await standInRequests(ctx)).slice(since);
  same(
    requests.map((r) => r.prompt),
    [prompt],
    "the stand-in's requests since the check began",
  );
  return requests[0]!;
}

/** Send a directive to a new task of Juniper's and follow it to the completion turn. */
async function imageRun(
  ctx: ImageContext,
  tag: string,
  directive: string,
  outcome: "ok" | "error",
) {
  const op = ctx.writer;
  const key = `agent:main:image-${tag}-${ctx.stamp}`;
  await op.request("sessions.messages.subscribe", { key });
  const from = op.lastSeq;
  const since = (await standInRequests(ctx)).length;
  const sent = rec(await op.send(key, directive));
  const runId = String(sent.runId);
  const end = await op.terminal(runId, 120_000);
  same(end.state, "final", `the ${directive} run's end`);
  const result = op
    .runEvents(runId)
    .map((event) => rec(rec(event.payload).data))
    .find((data) => data.name === "image_generate" && data.phase === "result");
  expect(result, `the ${directive} run has no image_generate result`);
  const details = rec(rec(result.result).details);
  same([details.async, details.status], [true, "started"], "the tool's answer");
  const taskId = String(details.taskId);
  expect(/^tool:image_generate:[0-9a-f-]{36}$/.test(taskId), `task id ${taskId}`);
  const terminal = await op.terminalEvent(completionRun(taskId, outcome), 120_000);
  const completion = rec(terminal.payload);
  same(completion.sessionKey, key, "the completion run's task");
  expect(
    op.events.some((event) => event.seq > from && rec(event.payload).runId === completion.runId),
    "the completion run's events",
  );
  return { key, taskId, completion, completedAt: terminal.at, since, from };
}

/** The task's history, read again until `found` finds what it waits for (at most 30 s). */
async function historyUntil<T>(
  ctx: ImageContext,
  key: string,
  what: string,
  found: (messages: JsonRecord[]) => T | undefined,
): Promise<{ value: T; messages: JsonRecord[] }> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const history = rec(await ctx.writer.request("chat.history", { sessionKey: key, limit: 50 }));
    const messages = (history.messages as JsonRecord[]) ?? [];
    const value = found(messages);
    if (value !== undefined) return { value, messages };
    expect(Date.now() < deadline, `${what} is not in the task's history after 30 s`);
    await sleep(500);
  }
}

const imageBlocks = (messages: JsonRecord[]) =>
  messages.flatMap((m) =>
    m.role === "assistant" && Array.isArray(m.content)
      ? (m.content as JsonRecord[]).filter((part) => part.type === "image")
      : [],
  );
const replyText = (message: JsonRecord) =>
  (message.content as JsonRecord[] | undefined)?.find((part) => part.type === "text")?.text;

/** The live events of a run, or of its task's messages, that carry an `image` content part. */
const liveImageParts = (op: OperatorSession, runId: string, key: string, from: number) =>
  op.events.filter((event) => {
    const payload = rec(event.payload);
    return (
      event.seq > from &&
      (payload.runId === runId ||
        (event.event === "session.message" && payload.sessionKey === key)) &&
      JSON.stringify(payload).includes('"type":"image"')
    );
  });

/** A finished image task the provider failed: the bot's words, and no picture. */
function failureCheck(
  kind: "refuse" | "fail" | "hang",
  name: string,
  outcome: ImageRequestRecord["outcome"],
): ImageCheck {
  return {
    name,
    covers: [`#image-${kind}`],
    async run(ctx) {
      const { key, completion, completedAt, since } = await imageRun(
        ctx,
        kind,
        `#image-${kind}`,
        "error",
      );
      same(replyText(rec(completion.message)), IMAGE_FAILED_REPLY, "the completion turn's reply");
      const { messages } = await historyUntil(ctx, key, "the failure's reply", (m) =>
        m.some((x) => x.role === "assistant" && replyText(x) === IMAGE_FAILED_REPLY)
          ? true
          : undefined,
      );
      same(imageBlocks(messages), [], "pictures in the task");
      const request = await onlyRequestSince(ctx, since, `${IMAGE_PROMPT} [scripted: ${kind}]`);
      same(request.outcome, outcome, "the stand-in's outcome");
      if (kind === "hang") {
        // The gateway gave up on the request after the call's own timeout, measured
        // by the stand-in from the request's arrival to its close.
        expect(request.closedAt, "the gateway never closed the request it was not answered");
        const waited = Date.parse(request.closedAt) - Date.parse(request.at);
        expect(
          waited >= HANG_TIMEOUT_MS - 250 && waited < HANG_TIMEOUT_MS + 4000,
          `the gateway closed the unanswered request after ${waited} ms, not after about ${HANG_TIMEOUT_MS}`,
        );
        expect(
          Date.parse(request.closedAt) <= completedAt,
          "the completion ended before the gateway gave up on the request",
        );
      }
    },
  };
}

export const IMAGE_CHECKS: ImageCheck[] = [
  {
    name: "a bot's picture arrives in a later turn of the task, as an artifact",
    covers: ["#image"],
    async run(ctx) {
      const { key, completion, since, from } = await imageRun(ctx, "picture", "#image", "ok");
      same(
        replyText(rec(completion.message)),
        IMAGE_READY_REPLY,
        "the completion turn's text, its MEDIA line taken out",
      );
      const picture = scriptedPicture();
      const { value: blocks } = await historyUntil(ctx, key, "the image block", (m) => {
        const found = imageBlocks(m);
        return found.length > 0 ? found : undefined;
      });
      same(blocks.length, 1, "image blocks in the task");
      const block = blocks[0]!;
      same(
        [block.mimeType, block.width, block.height, block.sizeBytes],
        ["image/png", 1024, 1024, picture.length],
        "the image block",
      );
      expect(
        /^artifact_managed_image_/.test(String(block.artifactId)),
        `id ${show(block.artifactId)}`,
      );
      const listed = rec(
        await ctx.writer.request("artifacts.list", { sessionKey: key, messageRole: "assistant" }),
      );
      const record = ((listed.artifacts as JsonRecord[]) ?? []).find(
        (a) => a.id === block.artifactId,
      );
      expect(record, `artifacts.list does not list it: ${show(listed)}`);
      same(
        [record.type, record.mimeType, record.sizeBytes, rec(record.download).mode],
        ["image", "image/png", picture.length, "url"],
        "the artifact record",
      );
      same(record.runId, completion.runId, "the artifact's run, the gateway's completion turn");
      const download = rec(
        await ctx.writer.request("artifacts.download", { sessionKey: key, artifactId: record.id }),
      );
      const address = String(download.url ?? "");
      expect(address.startsWith("/api/chat/media/outgoing/"), `download address ${address}`);
      const fetched = Buffer.from(
        await (await fetch(`${ctx.gatewayOrigin}${address}`)).arrayBuffer(),
      );
      expect(fetched.equals(picture), "the downloaded bytes are not the stand-in's picture");
      same(
        liveImageParts(ctx.writer, String(completion.runId), key, from).length,
        0,
        "live events of the completion run or task carrying an image part",
      );
      const request = await onlyRequestSince(ctx, since, IMAGE_PROMPT);
      same(
        [request.authorized, request.model, request.n, request.size, request.outcome],
        [true, IMAGE_MODEL_ID, 1, "1024x1024", "picture"],
        "what the gateway asked the stand-in",
      );
    },
  },
  failureCheck("refuse", "a picture the provider refuses ends in the bot's words alone", "refuse"),
  failureCheck(
    "fail",
    "a picture the provider fails to make ends in the bot's words alone",
    "fail",
  ),
  failureCheck(
    "hang",
    "a picture the provider never answers ends after the call's timeout",
    "hang",
  ),
  {
    name: "tools.invoke on a task never created makes a picture at once, a file on the gateway's machine read over its HTTP route",
    covers: [],
    async run(ctx) {
      const key = `agent:main:image-invoke-${ctx.stamp}`;
      const since = (await standInRequests(ctx)).length;
      const params = { name: "image_generate", args: { prompt: IMAGE_PROMPT }, sessionKey: key };
      const answer = rec(await ctx.writer.request("tools.invoke", params, 60_000));
      same([answer.ok, answer.toolName], [true, "image_generate"], "the invoke answer");
      const details = rec(rec(answer.output).details);
      const [attachment] = (details.attachments as JsonRecord[]) ?? [];
      const picture = scriptedPicture();
      same(
        [details.count, attachment?.type, attachment?.mimeType, attachment?.sizeBytes],
        [1, "image", "image/png", picture.length],
        "the invoke's attachment",
      );
      same(details.async, undefined, "a background task on a task never created");
      const path = String(attachment?.path ?? "");
      const folder = `${ctx.stateDir}/media/tool-image-generation/`;
      expect(
        isAbsolute(path) && path.startsWith(folder) && !path.slice(folder.length).includes("/"),
        `the attachment's path ${path} is not a file of the gateway's in ${folder}`,
      );
      expect(readFileSync(path).equals(picture), "the file the path names is not the picture");
      await onlyRequestSince(ctx, since, IMAGE_PROMPT);
      // The gateway's assistant media route serves the file by its path, with its bearer token.
      const route = `${ctx.gatewayOrigin}/__openclaw__/assistant-media?source=${encodeURIComponent(path)}`;
      const authorized = await fetch(route, {
        headers: { authorization: `Bearer ${ctx.gatewayToken}` },
      });
      same(
        [authorized.status, authorized.headers.get("content-type")],
        [200, "image/png"],
        "the assistant media route with the gateway's token",
      );
      expect(
        Buffer.from(await authorized.arrayBuffer()).equals(picture),
        "the assistant media route's bytes are not the picture",
      );
      same((await fetch(route)).status, 401, "the assistant media route without a token");
      const history = rec(await ctx.writer.request("chat.history", { sessionKey: key, limit: 5 }));
      same(history.messages, [], "the invoked task's history");
      const refused = await ctx.reader.request("tools.invoke", params).then(
        () => "answered",
        (error: unknown) => String(error),
      );
      expect(/missing scope: operator\.write/.test(refused), `a read-only invoke: ${refused}`);
    },
  },
  {
    name: "a reference picture at an outside address goes to the instance's egress proxy, which refuses it",
    covers: [],
    async run(ctx) {
      // A name in a reserved domain: the gateway hands it to its egress proxy
      // (the scripted model) without looking it up, and the proxy refuses the tunnel.
      const host = `pictures-${ctx.stamp}.example`;
      const reference = `http://${host}/hill.png`;
      const since = (await standInRequests(ctx)).length;
      const logged = readFileSync(ctx.providerLog, "utf8").length;
      const beforeGateway = readFileSync(ctx.gatewayLog, "utf8").length;
      const answer = rec(
        await ctx.writer.request(
          "tools.invoke",
          {
            name: "image_generate",
            args: { prompt: IMAGE_PROMPT, image: reference },
            sessionKey: `agent:main:image-reference-${ctx.stamp}`,
          },
          60_000,
        ),
      );
      same(answer.ok, false, "the invoke with an outside reference");
      // The gateway asks its proxy for a tunnel to the reference's host.
      const refusal = `refused a request beyond loopback: CONNECT ${host}:80`;
      const lines = readFileSync(ctx.providerLog, "utf8").slice(logged);
      expect(lines.includes(refusal), `the egress proxy did not record "${refusal}"`);
      const diagnostics = readFileSync(ctx.gatewayLog, "utf8").slice(beforeGateway).split("\n");
      expect(
        diagnostics.some(
          (line) =>
            line.includes(reference) &&
            line.includes("Proxy response (403) !== 200 when HTTP Tunneling"),
        ),
        "the gateway did not observe HTTP 403 for this reference",
      );
      same(
        (await standInRequests(ctx)).slice(since),
        [],
        "the stand-in's requests for the refused reference",
      );
    },
  },
];

export async function runImageChecks(
  ctx: ImageContext,
  log: (line: string) => void = console.log,
): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;
  for (const check of IMAGE_CHECKS) {
    try {
      await check.run(ctx);
      passed += 1;
      log(`ok    ${check.name}`);
    } catch (error) {
      failed += 1;
      log(`FAIL  ${check.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { passed, failed };
}
