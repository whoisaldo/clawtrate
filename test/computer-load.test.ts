// `computer.ts` imports `runs.ts`, which imports the state's schema (`state-bounds.ts`), which
// reads the Computer tab's limits. Node must be able to load `computer.ts` first. Vitest's module
// runner hides a limit read before it is set (it reads `undefined`), so the load runs in Node.

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const load = (file: string) =>
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(new URL(file, import.meta.url).href)});`,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );

describe("the Computer engine loads on its own", () => {
  it("computer.ts first, before the state's schema", () => {
    expect(() => load("../packages/core/src/computer.ts")).not.toThrow();
  });
});
