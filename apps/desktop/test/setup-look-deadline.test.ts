// The look's own checks of files share the design's time limit (§4): a file
// check that never answers, as on a hung mount, ends the look as "can't tell"
// instead of keeping the person on "Finding OpenClaw".
import type * as FsPromises from "node:fs/promises";
import { expect, it, vi } from "vitest";

// Any path under a "hangs" folder never answers, one under "held" answers when the
// test lets it go; every other check is the real one.
const gate = vi.hoisted(() => {
  let release: () => void = () => {};
  const opened = new Promise<void>((resolve) => (release = resolve));
  return { opened, release: () => release() };
});
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof FsPromises>();
  const hangs = (path: unknown) => String(path).includes("/hangs/");
  const held = (path: unknown) => String(path).includes("/held/");
  // A program under "flaky" is found as an executable file, then never answers again.
  const flaky = new Map<string, number>();
  const stops = (path: string) => {
    if (!path.includes("/flaky/")) return null;
    const seen = (flaky.get(path) ?? 0) + 1;
    flaky.set(path, seen);
    return seen === 1
      ? Promise.resolve({ isFile: () => true, mode: 0o755 })
      : new Promise(() => {});
  };
  return {
    ...fs,
    stat: (path: string) => (hangs(path) ? new Promise(() => {}) : (stops(path) ?? fs.stat(path))),
    lstat: (path: string) =>
      held(path)
        ? gate.opened.then(() => {
            throw Object.assign(new Error("absent"), { code: "ENOENT" });
          })
        : fs.lstat(path),
  };
});

const { FILE_CHECK_MS, lookHere } = await import("../src/setup/look.ts");
import type { LookWorld } from "../src/setup/world.ts";

function world(values: Partial<LookWorld>): LookWorld {
  return {
    kind: "production",
    platform: "darwin",
    home: "/nowhere/home",
    cwd: "/nowhere/home",
    candidates: [],
    profiles: [],
    env: {},
    serviceFiles: [],
    deep: false,
    portAllowed: () => false,
    pairs: false,
    ...values,
  };
}

it("a program search that never answers ends the look as can't tell, within the file checks' limit, and starts nothing", async () => {
  const run = vi.fn();
  const started = Date.now();
  const result = await lookHere(world({ candidates: ["/hangs/openclaw"] }), run);
  expect(result?.look).toMatchObject({ outcome: "cant-tell", reason: "timeout" });
  expect(Date.now() - started).toBeLessThan(FILE_CHECK_MS + 1_000);
  expect(run).not.toHaveBeenCalled();
});

it("a program file that stops answering when its identity is read ends the look as can't tell, and starts nothing", async () => {
  const run = vi.fn();
  const started = Date.now();
  const result = await lookHere(
    world({
      candidates: ["/flaky/openclaw"],
      profiles: [
        { name: "default", args: [], stateDir: "/nowhere/.openclaw", required: true, env: {} },
      ],
    }),
    run,
  );
  expect(result?.look).toMatchObject({ outcome: "cant-tell", reason: "timeout" });
  expect(Date.now() - started).toBeLessThan(FILE_CHECK_MS + 1_000);
  expect(run).not.toHaveBeenCalled();
});

it("a check for signs of OpenClaw that never answers ends the look as can't tell, and starts nothing", async () => {
  const run = vi.fn();
  const result = await lookHere(
    world({
      candidates: ["/nowhere/openclaw"],
      serviceFiles: ["/hangs/ai.openclaw.gateway.plist"],
    }),
    run,
  );
  expect(result?.look).toMatchObject({ outcome: "cant-tell", reason: "timeout" });
  expect(run).not.toHaveBeenCalled();
});

it("Back while the look checks for another profile's folder starts nothing more", async () => {
  let cancelled = false;
  const asked: string[] = [];
  const program = process.execPath;
  const result = await lookHere(
    world({
      candidates: [program],
      profiles: [
        { name: "default", args: [], stateDir: "/nowhere/.openclaw", required: true, env: {} },
        {
          name: "clawtrate",
          args: ["--profile", "clawtrate"],
          stateDir: "/held/.openclaw-clawtrate",
          required: false,
          env: {},
        },
      ],
    }),
    async (request) => {
      asked.push(request.args.join(" "));
      // Back is pressed while the folder check is still out, then it answers.
      setTimeout(() => {
        cancelled = true;
        gate.release();
      }, 20);
      return {
        exitCode: 0,
        stdout: "OpenClaw 2026.10.6 (fe06181)\n",
        timedOut: false,
        tooLarge: false,
        failed: false,
      };
    },
    { cancelled: () => cancelled },
  );
  expect(result).toBeNull();
  expect(asked).toEqual(["--version"]);
});
