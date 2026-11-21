// The Computer tab's machine reads (`machine-reads.ts`), against a bridge whose answers come when
// the test says: only the newest read's answer or failure is kept, and "Checking…" shows only
// while its own manual read is the newest one still out.

import { describe, expect, it } from "vitest";
import { machineReader } from "../src/work/machine-reads.ts";

function bridge() {
  const asked: Array<{ resolve: (value: string) => void; reject: (error: Error) => void }> = [];
  const ask = () =>
    new Promise<string>((resolve, reject) => {
      asked.push({ resolve, reject });
    });
  const log: string[] = [];
  const checking: boolean[] = [];
  const reader = machineReader<string>({
    keep: (answer, manual) => log.push(`keep ${answer}${manual ? " (manual)" : ""}`),
    fail: () => log.push("fail"),
    checking: (on) => checking.push(on),
  });
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  return { asked, ask, log, checking, reader, settle };
}

describe("machine reads (F-148)", () => {
  it("a stale manual reply changes neither the facts nor a newer manual read's Checking", async () => {
    const b = bridge();
    b.reader.read(b.ask, true);
    b.reader.read(b.ask, true);
    b.asked[0]!.resolve("old");
    await b.settle();
    expect(b.log).toEqual([]);
    // Checking was handed from the first read to the second, and still shows.
    expect(b.checking.at(-1)).toBe(true);
    b.asked[1]!.resolve("new");
    await b.settle();
    expect(b.log).toEqual(["keep new (manual)"]);
    expect(b.checking.at(-1)).toBe(false);
  });

  it("an automatic read that supersedes a manual one clears Checking, and the manual one's late failure changes nothing", async () => {
    const b = bridge();
    b.reader.read(b.ask, true);
    b.reader.read(b.ask, false);
    expect(b.checking).toEqual([true, false]);
    b.asked[0]!.reject(new Error("late"));
    await b.settle();
    expect(b.log).toEqual([]);
    b.asked[1]!.resolve("auto");
    await b.settle();
    expect(b.log).toEqual(["keep auto"]);
  });

  it("a context change retires the read still out, manual or not, and clears Checking", async () => {
    const b = bridge();
    b.reader.read(b.ask, false);
    b.reader.read(b.ask, true);
    b.reader.invalidate();
    expect(b.checking).toEqual([true, false]);
    b.asked[1]!.resolve("for the old nodes");
    b.asked[0]!.reject(new Error("old"));
    await b.settle();
    expect(b.log).toEqual([]);
  });
});
