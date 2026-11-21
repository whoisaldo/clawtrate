// OpenClaw's own command line on the gateway's computer: `openclaw qr` for the setup code a
// pairing code carries, and `openclaw config` for `gateway.trustedProxies`. The connector never
// edits OpenClaw's files itself.

import { spawn } from "node:child_process";

export interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs one OpenClaw command with these arguments. Tests and the development tool pass their own. */
export type OpenclawRunner = (args: string[]) => Promise<RunResult>;

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * Runs `<bin> [--profile <profile>] <args>`. The profile is the one setup recorded; an argument
 * that would choose another profile is refused.
 */
export function cliRunner(openclaw: { bin: string; profile: string | null }): OpenclawRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      if (args.some((arg) => /^--(profile|dev)(=|$)/.test(arg))) {
        reject(new Error("the connector never chooses another OpenClaw profile"));
        return;
      }
      const full = [...(openclaw.profile === null ? [] : ["--profile", openclaw.profile]), ...args];
      const child = spawn(openclaw.bin, full, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let bytes = 0;
      const take = (chunk: Buffer, into: "out" | "err") => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) {
          child.kill();
          return;
        }
        if (into === "out") stdout += chunk.toString("utf8");
        else stderr += chunk.toString("utf8");
      };
      child.stdout.on("data", (chunk: Buffer) => take(chunk, "out"));
      child.stderr.on("data", (chunk: Buffer) => take(chunk, "err"));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
}

/**
 * The JSON document that ends a command's output. Log lines may come first, and some of them
 * begin with `[` too (`[plugins] …`), so the first line from which the rest parses is taken.
 */
export function parseJsonOutput(text: string): unknown {
  for (const match of text.matchAll(/^[[{]/gm)) {
    try {
      return JSON.parse(text.slice(match.index));
    } catch {
      // A log line; try the next line that starts like JSON.
    }
  }
  throw new Error("OpenClaw printed no JSON.");
}

/** Runs a command that must succeed and print JSON. */
export async function runJson(run: OpenclawRunner, args: string[]): Promise<unknown> {
  const result = await run(args);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ");
    throw new Error(
      `openclaw ${args.slice(0, 2).join(" ")} failed (exit ${result.status}): ${detail}`,
    );
  }
  return parseJsonOutput(result.stdout);
}
