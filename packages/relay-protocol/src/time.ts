import { fail } from "./errors.ts";

/** True for a nonnegative safe integer: a time in milliseconds this package will compare. */
export function isMillis(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Returns the value if it is a nonnegative safe integer number of milliseconds, and fails with
 * `bad_time` otherwise, so a NaN or fractional clock can never make an expiry check pass.
 */
export function checkMillis(value: unknown, what: string): number {
  if (!isMillis(value))
    fail("bad_time", `${what} is not a nonnegative whole number of milliseconds.`);
  return value;
}
