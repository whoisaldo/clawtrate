// The end-to-end run starts the instance with the computer plugin only when it can run the
// Computer tab's checks: every run with no file filter, and a run whose filters match them.
import { describe, expect, it } from "vitest";
import { runIncludes } from "../e2e/run-record.ts";

const FILE = "e2e/work-computer.spec.ts";
const argv = (...args: string[]) => ["node", "playwright/cli.js", "test", ...args];

describe("which end-to-end runs start the computer instance", () => {
  it("every run without a file filter, sharded or grepped, may run the Computer checks", () => {
    expect(runIncludes(argv(), FILE)).toBe(true);
    expect(runIncludes(argv("--shard=1/3"), FILE)).toBe(true);
    expect(runIncludes(argv("-g", "F-027|F-323", "--repeat-each", "3"), FILE)).toBe(true);
  });

  it("a run of other files does not, and one naming the Computer spec does", () => {
    expect(runIncludes(argv("e2e/preview.spec.ts", "-g", "work-computer"), FILE)).toBe(false);
    expect(runIncludes(argv("e2e/preview.spec.ts", "e2e/rail-tasks.spec.ts"), FILE)).toBe(false);
    expect(runIncludes(argv("e2e/work-computer.spec.ts"), FILE)).toBe(true);
    expect(runIncludes(argv("work-computer"), FILE)).toBe(true);
  });

  it("an option's separate value is not read as a file filter", () => {
    expect(runIncludes(argv("--global-timeout", "900000"), FILE)).toBe(true);
    expect(runIncludes(argv("-G", "F-027", "work-computer"), FILE)).toBe(true);
    expect(runIncludes(argv("-G", "work-computer", "e2e/preview.spec.ts"), FILE)).toBe(false);
    expect(runIncludes(argv("--tsconfig", "tsconfig.json", "--browser", "chromium"), FILE)).toBe(
      true,
    );
    expect(runIncludes(argv("--project", "a", "b", "-g", "x"), FILE)).toBe(true);
    expect(runIncludes(argv("--shuffle", "--project", "a", "work-computer"), FILE)).toBe(true);
  });

  it("a file filter with a line, or a line and column, still names its file", () => {
    expect(runIncludes(argv("e2e/work-computer.spec.ts:42"), FILE)).toBe(true);
    expect(runIncludes(argv("work-computer.spec.ts:42:7"), FILE)).toBe(true);
    expect(runIncludes(argv("e2e/preview.spec.ts:42"), FILE)).toBe(false);
  });
});
