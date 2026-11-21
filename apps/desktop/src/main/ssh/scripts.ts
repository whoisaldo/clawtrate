// The CODE and START scripts, run on the other computer as `/bin/sh -s` with
// the script on standard input (docs/design/setup.md, section 19), and the
// parser for what they print. Like the LOOK, each is a constant; its only
// values are a request id the host makes, a profile of two fixed names, a
// gateway port of digits, the index of the program place the LOOK found and
// that file's checksum, each assigned in one line the host writes after
// validating it, and checked again by the script before anything runs. Each
// clears every OPENCLAW_ variable as the LOOK does, runs the program at that
// one place only when its checksum is still the LOOK's, runs one fixed
// OpenClaw command, and prints its answer as base64 between a begin and an end
// line carrying the request id. What that answer holds (a one-time code, for
// CODE) is parsed in memory by the caller and never kept or logged here.
// Stopping a gateway over SSH is not offered in this version.

import { randomUUID } from "node:crypto";

import { CLEAR_OPENCLAW, PROGRAM_PLACES, PROGRAM_SUM, type ProgramPlace } from "./look.ts";
import { MAX_LOOK_NOISE } from "./look.ts";

export type ScriptKind = "code" | "start";
export type ScriptProfile = "default" | "clawtrate";

/** What each script keeps of OpenClaw's answer, in bytes, before base64. */
export const SCRIPT_ANSWER_BYTES: Record<ScriptKind, number> = {
  // `qr --json`: a setup code, its URL and a few labels, well under 4 KiB.
  code: 16 * 1024,
  start: 4 * 1024,
};

/** The fixed OpenClaw command of each script, after the profile's options. */
const COMMANDS: Record<ScriptKind, string> = {
  code: 'qr --json --voice-node --url "ws://127.0.0.1:$port"',
  start: "gateway start",
};

/** The part every script shares: the checks of its values, the watchdog, the program's place. */
const PRELUDE = String.raw`set -eu
case "$request_id" in
  *[!0-9a-f-]*|'') exit 64 ;;
esac
case "$profile" in
  default|clawtrate) ;;
  *) exit 64 ;;
esac
case "$port" in
  ''|*[!0-9]*) exit 64 ;;
esac
if [ "$port" -lt 1024 ] || [ "$port" -gt 65535 ]; then exit 64; fi
case "$prog_i" in
  0|1|2|3|4) ;;
  *) exit 64 ;;
esac
case "$prog_sum" in
  ''|*[!0-9\ ]*) exit 64 ;;
esac
${CLEAR_OPENCLAW}
# Stop after 30 seconds, whatever is still running.
( sleep 30 </dev/null >/dev/null 2>&1 & s=$!
  trap 'kill "$s" 2>/dev/null; exit 0' TERM
  wait "$s" && kill -TERM 0 2>/dev/null ) </dev/null >/dev/null 2>&1 &
watchdog=$!
cd "$HOME" 2>/dev/null || cd /
b64() { head -c "$1" | base64 | tr -d '\r\n'; }
line() { printf '{"k":"%s"%s}\n' "$1" "$2"; }
line begin ",\"id\":\"$request_id\""
prog=''
i=0
for p in "$HOME/.openclaw/bin/openclaw" /opt/homebrew/bin/openclaw /usr/local/bin/openclaw "$HOME/.local/bin/openclaw" "$HOME/.npm-global/bin/openclaw"; do
  # The place the LOOK found, and only while it is the same file.
  if [ "$i" = "$prog_i" ] && [ -f "$p" ] && [ -x "$p" ] && [ "$(cksum < "$p" 2>/dev/null || true)" = "$prog_sum" ]; then prog=$p; line program ",\"i\":$i"; fi
  i=$((i + 1))
done
exec 4>&1
`;

/** The script's body for `kind`: the prelude, the one command, the end line. */
function body(kind: ScriptKind): string {
  const bytes = SCRIPT_ANSWER_BYTES[kind];
  const command = COMMANDS[kind];
  return (
    PRELUDE +
    String.raw`if [ -n "$prog" ]; then
  printf '{"k":"answer","v":"'
  code=$( { { if [ "$profile" = clawtrate ]; then "$prog" --profile clawtrate ${command} </dev/null 2>/dev/null && c=0 || c=$?; else "$prog" ${command} </dev/null 2>/dev/null && c=0 || c=$?; fi; printf '%s' "$c" >&3; } | b64 ${bytes} >&4; } 3>&1 )
  case "$code" in ''|*[!0-9]*) code=255 ;; esac
  printf '","exit":%s}\n' "$code"
fi
kill -TERM "$watchdog" 2>/dev/null || true
line end ",\"id\":\"$request_id\""
`
  );
}

/** The bodies, as constants of the app. */
export const SCRIPT_BODIES: Record<ScriptKind, string> = {
  code: body("code"),
  start: body("start"),
};

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const isGatewayPort = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1024 && value <= 65535;

/** What a script acts on: the profile and port, and the program the LOOK found with its checksum. */
export type ScriptValues = {
  profile: ScriptProfile;
  port: number;
  program: ProgramPlace;
  programSum: string;
};

/** The script as sent: the five assignments the host writes, then the constant body. */
export function remoteScript(
  kind: ScriptKind,
  values: ScriptValues,
  requestId: string = randomUUID(),
): { requestId: string; text: string } {
  if (!REQUEST_ID.test(requestId)) throw new Error("Not a request id.");
  if (values.profile !== "default" && values.profile !== "clawtrate")
    throw new Error("Not a profile Clawtrate uses.");
  if (!isGatewayPort(values.port)) throw new Error("Not a gateway port.");
  const place = PROGRAM_PLACES.indexOf(values.program);
  if (place === -1) throw new Error("Not a program place the LOOK uses.");
  if (!PROGRAM_SUM.test(values.programSum)) throw new Error("Not a program checksum.");
  return {
    requestId,
    text:
      `request_id='${requestId}'\nprofile='${values.profile}'\nport='${values.port}'\n` +
      `prog_i='${place}'\nprog_sum='${values.programSum}'\n` +
      SCRIPT_BODIES[kind],
  };
}

const base64Chars = (bytes: number) => Math.ceil(bytes / 3) * 4;

/** The largest whole output of `kind`: begin, program, the answer at its cut, end. */
export function maxScriptOutput(kind: ScriptKind): number {
  const lineChars = (fixed: string, values: number) => fixed.length + values + 1;
  return (
    lineChars('{"k":"begin","id":""}', 36) +
    lineChars('{"k":"program","i":4}', 0) +
    lineChars('{"k":"answer","v":"","exit":255}', base64Chars(SCRIPT_ANSWER_BYTES[kind])) +
    lineChars('{"k":"end","id":""}', 36) +
    MAX_LOOK_NOISE
  );
}

export type ScriptParse =
  | { ok: true; program: ProgramPlace | null; answer: { text: string; exit: number } | null }
  | { ok: false; reason: "no-begin" | "no-end" | "malformed" | "too-large" | "incomplete" };

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** A script's standard output, parsed in memory: the place of the program and its answer. */
export function parseScriptOutput(
  kind: ScriptKind,
  stdout: string,
  requestId: string,
): ScriptParse {
  if (stdout.length > maxScriptOutput(kind)) return { ok: false, reason: "too-large" };
  const lines = stdout.split("\n").map((line) => line.replace(/\r$/, ""));
  const begin = lines.findIndex((line) => line === `{"k":"begin","id":"${requestId}"}`);
  if (begin === -1) return { ok: false, reason: "no-begin" };
  const noise = lines.slice(0, begin).reduce((sum, line) => sum + line.length + 1, 0);
  if (noise > MAX_LOOK_NOISE) return { ok: false, reason: "too-large" };
  const after = lines.slice(begin + 1);
  after.pop();
  let program: ProgramPlace | null = null;
  let answer: { text: string; exit: number } | null = null;
  const seen = new Set<string>();
  for (const line of after) {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      return { ok: false, reason: "malformed" };
    }
    const fact = record(json);
    const key = fact?.k;
    if (!fact || typeof key !== "string" || seen.has(key))
      return { ok: false, reason: "malformed" };
    seen.add(key);
    if (key === "end") {
      if (fact.id !== requestId) return { ok: false, reason: "malformed" };
      // A program found has an answer; none found has none.
      if ((program === null) !== (answer === null)) return { ok: false, reason: "incomplete" };
      return { ok: true, program, answer };
    }
    if (key === "program") {
      const place = typeof fact.i === "number" ? PROGRAM_PLACES[fact.i] : undefined;
      if (!place || answer) return { ok: false, reason: "malformed" };
      program = place;
      continue;
    }
    if (key === "answer") {
      const value = fact.v;
      const exit = fact.exit;
      if (
        program === null ||
        typeof value !== "string" ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(value) ||
        typeof exit !== "number" ||
        !Number.isInteger(exit)
      )
        return { ok: false, reason: "malformed" };
      const bytes = Buffer.from(value, "base64");
      if (bytes.length > SCRIPT_ANSWER_BYTES[kind]) return { ok: false, reason: "malformed" };
      answer = { text: bytes.toString("utf8"), exit };
      continue;
    }
    return { ok: false, reason: "malformed" };
  }
  return { ok: false, reason: "no-end" };
}
