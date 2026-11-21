// The stand-in image provider of an instance started with `--with-images`: a
// loopback server that answers the OpenAI-style image endpoint the gateway's
// bundled LiteLLM image provider calls (`POST <baseUrl>/images/generations`,
// a bearer key, `{model, prompt, n, size}`), with one fixed picture this file
// draws. No image comes from anywhere else and nothing leaves the machine.
//
// A marker in the prompt scripts the outcome, so the scripted model's `#image`
// directives (scenarios.ts) can play each case:
//
//   (none)                a picture for each of `n`
//   [scripted: refuse]    400, the provider's content-policy refusal
//   [scripted: fail]      500, a provider error
//   [scripted: hang]      no answer at all, until the gateway gives up

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { crc32, deflateSync } from "node:zlib";

/** The bundled provider the gateway calls: its config entry is `models.providers.litellm`. */
export const IMAGE_PROVIDER_ID = "litellm";
export const IMAGE_MODEL_ID = "scripted-image-1";
export const IMAGE_MODEL_REF = `${IMAGE_PROVIDER_ID}/${IMAGE_MODEL_ID}`;
/** A made-up key: the provider sends no request without one. */
export const IMAGE_API_KEY = "example-image-key";

export const IMAGE_OUTCOMES = ["picture", "refuse", "fail", "hang"] as const;
export type ImageOutcome = (typeof IMAGE_OUTCOMES)[number];
export const outcomeMarker = (outcome: Exclude<ImageOutcome, "picture">) =>
  `[scripted: ${outcome}]`;

export function imageOutcome(prompt: string): ImageOutcome {
  for (const outcome of ["refuse", "fail", "hang"] as const) {
    if (prompt.includes(outcomeMarker(outcome))) return outcome;
  }
  return "picture";
}

export const REFUSAL_MESSAGE = "Your request was rejected by the safety system (scripted).";
export const FAILURE_MESSAGE = "The scripted image provider failed.";

/** The fixed picture's side, in pixels: the size the gateway asks for by default. */
export const PICTURE_SIZE = 1024;

const BACKGROUND = [0x1f, 0x3a, 0x5f];
const SUN = [0xf2, 0xb8, 0x3c];
const HILL = [0x3f, 0x8f, 0x6b];
const GROUND = [0x2b, 0x5e, 0x47];

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A PNG of solid shapes: a sky, a sun, a hill and the ground. The same bytes every time. */
export function scriptedPicture(size: number = PICTURE_SIZE): Buffer {
  const row = 1 + size * 3;
  const raw = Buffer.alloc(row * size);
  const sun = { x: size * 0.7, y: size * 0.3, r: size * 0.12 };
  for (let y = 0; y < size; y += 1) {
    raw[y * row] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      const hill = (x - size * 0.35) ** 2 + (y - size * 0.95) ** 2 < (size * 0.45) ** 2;
      const color =
        y > size * 0.8
          ? GROUND
          : hill
            ? HILL
            : (x - sun.x) ** 2 + (y - sun.y) ** 2 < sun.r ** 2
              ? SUN
              : BACKGROUND;
      raw.set(color, y * row + 1 + x * 3);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** One request the stand-in received, as `GET /scripted/images/requests` lists it. */
export type ImageRequestRecord = {
  seq: number;
  at: string;
  path: string;
  authorized: boolean;
  model: string | null;
  prompt: string | null;
  n: number | null;
  size: string | null;
  outcome: ImageOutcome | "unauthorized" | "malformed";
  /** For a request left without an answer: when the gateway closed it. */
  closedAt?: string;
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const parts: Buffer[] = [];
  for await (const part of req) parts.push(part as Buffer);
  return Buffer.concat(parts).toString("utf8");
}

export function startScriptedImages(options: {
  port: number;
  log?: (line: string) => void;
}): Server {
  const log = options.log ?? (() => {});
  const requests: ImageRequestRecord[] = [];
  const picture = scriptedPicture().toString("base64");
  /** Requests left without an answer, ended when the server closes. */
  const hanging = new Set<ServerResponse>();

  const server = createServer((req, res) => {
    const url = URL.parse(req.url ?? "/", "http://127.0.0.1");
    if (!url) {
      sendJson(res, 400, {
        error: { message: "invalid request target", type: "invalid_request_error" },
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/scripted/images/requests") {
      sendJson(res, 200, { requests });
      return;
    }
    // The model list, in case the provider's catalogue asks: no chat models here.
    if (req.method === "GET" && url.pathname === "/v1/models") {
      sendJson(res, 200, { object: "list", data: [] });
      return;
    }
    if (req.method !== "POST" || url.pathname !== "/v1/images/generations") {
      sendJson(res, 404, { error: { message: `no such endpoint: ${req.method} ${url.pathname}` } });
      return;
    }
    const answer = (text: string) => {
      const record: ImageRequestRecord = {
        seq: requests.length + 1,
        at: new Date().toISOString(),
        path: url.pathname,
        authorized: req.headers.authorization === `Bearer ${IMAGE_API_KEY}`,
        model: null,
        prompt: null,
        n: null,
        size: null,
        outcome: "malformed",
      };
      requests.push(record);
      if (!record.authorized) {
        record.outcome = "unauthorized";
        sendJson(res, 401, {
          error: { message: "Invalid API key (scripted)", type: "auth_error" },
        });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        sendJson(res, 400, {
          error: { message: "body is not JSON", type: "invalid_request_error" },
        });
        return;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        sendJson(res, 400, {
          error: { message: "body is not a JSON object", type: "invalid_request_error" },
        });
        return;
      }
      const body = parsed as Record<string, unknown>;
      record.model = typeof body.model === "string" ? body.model : null;
      record.prompt = typeof body.prompt === "string" ? body.prompt : null;
      record.n = typeof body.n === "number" ? body.n : null;
      record.size = typeof body.size === "string" ? body.size : null;
      if (record.prompt === null) {
        sendJson(res, 400, {
          error: { message: "prompt is required", type: "invalid_request_error" },
        });
        return;
      }
      record.outcome = imageOutcome(record.prompt);
      log(`image request ${record.seq}: ${record.outcome}, n=${String(record.n)}`);
      switch (record.outcome) {
        case "refuse":
          sendJson(res, 400, {
            error: {
              message: REFUSAL_MESSAGE,
              type: "invalid_request_error",
              code: "content_policy_violation",
            },
          });
          return;
        case "fail":
          sendJson(res, 500, { error: { message: FAILURE_MESSAGE, type: "server_error" } });
          return;
        case "hang":
          hanging.add(res);
          res.on("close", () => {
            hanging.delete(res);
            record.closedAt = new Date().toISOString();
          });
          return;
        default: {
          const count = Math.min(Math.max(Math.trunc(record.n ?? 1), 1), 4);
          sendJson(res, 200, {
            created: Math.floor(Date.now() / 1000),
            data: Array.from({ length: count }, () => ({ b64_json: picture })),
          });
        }
      }
    };
    // A body that cannot be read, a request cut off for instance, is answered
    // if the connection still allows it, and never ends the process.
    readBody(req).then(answer, (error: unknown) => {
      log(`image request unreadable: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent && !res.destroyed) {
        sendJson(res, 400, {
          error: { message: "the body could not be read", type: "invalid_request_error" },
        });
      }
    });
  });
  const close = server.close.bind(server);
  server.close = (callback?: (error?: Error) => void) => {
    for (const res of hanging) res.destroy();
    return close(callback);
  };
  server.listen(options.port, "127.0.0.1");
  return server;
}
