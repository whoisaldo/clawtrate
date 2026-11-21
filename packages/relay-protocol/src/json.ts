// A strict reader for the flat JSON objects the protocol exchanges. `JSON.parse` keeps the last
// of two members with the same name, so a check on its result cannot see the first one, and
// another implementation may keep the first. This reader refuses any repeated name, compared
// after unescaping, so `{"t":"a","\u0074":"b"}` is refused too.

import { fail } from "./errors.ts";

export type FlatValue = string | number | boolean | null;

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
// JSON forbids raw control characters (U+0000 to U+001F) inside a string.
// eslint-disable-next-line no-control-regex
const STRING_BODY = /(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9A-Fa-f]{4}))*"/y;

/**
 * Reads one JSON object whose values are strings, numbers, booleans or null. Nested objects and
 * arrays, repeated names and anything after the object are refused with `bad_message`.
 */
export function readFlatObject(text: string): Map<string, FlatValue> {
  const members = new Map<string, FlatValue>();
  let at = skip(text, 0);
  if (text[at] !== "{") bad();
  at = skip(text, at + 1);
  if (text[at] === "}") return end(text, at + 1, members);
  for (;;) {
    const [name, afterName] = readString(text, at);
    at = skip(text, afterName);
    if (text[at] !== ":") bad();
    const [value, afterValue] = readValue(text, skip(text, at + 1));
    if (members.has(name)) bad();
    members.set(name, value);
    at = skip(text, afterValue);
    if (text[at] === "}") return end(text, at + 1, members);
    if (text[at] !== ",") bad();
    at = skip(text, at + 1);
  }
}

function end(text: string, at: number, members: Map<string, FlatValue>): Map<string, FlatValue> {
  if (skip(text, at) !== text.length) bad();
  return members;
}

function skip(text: string, at: number): number {
  while (at < text.length && WHITESPACE.has(text[at]!)) at++;
  return at;
}

function readString(text: string, at: number): [string, number] {
  if (text[at] !== '"') bad();
  STRING_BODY.lastIndex = at + 1;
  if (!STRING_BODY.test(text)) bad();
  const after = STRING_BODY.lastIndex;
  // The token is valid JSON by the pattern above; JSON.parse only unescapes it.
  return [JSON.parse(text.slice(at, after)) as string, after];
}

function readValue(text: string, at: number): [FlatValue, number] {
  const char = text[at];
  if (char === '"') return readString(text, at);
  for (const [word, value] of [
    ["true", true],
    ["false", false],
    ["null", null],
  ] as const) {
    if (text.startsWith(word, at)) return [value, at + word.length];
  }
  NUMBER.lastIndex = at;
  if (NUMBER.test(text)) return [Number(text.slice(at, NUMBER.lastIndex)), NUMBER.lastIndex];
  return bad();
}

function bad(): never {
  return fail("bad_message", "The JSON is not one flat object with distinct member names.");
}
