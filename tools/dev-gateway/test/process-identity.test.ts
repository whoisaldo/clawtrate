// A process is identified by the system's own ps, run by its fixed path with a
// fixed environment, so a PATH or a locale of the caller's can't change which
// program answers or how it writes the start time.
import type * as ChildProcess from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";

const launch = vi.hoisted(() =>
  vi.fn(() => ({ error: undefined, status: 0, stdout: "S Mon Nov 16 21:27:01 2026\n" })),
);
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof ChildProcess>()),
  spawnSync: launch,
}));

const { processIdentity } = await import("../src/state-guard.ts");

afterEach(() => vi.restoreAllMocks());

it("S5: setup identifies processes by absolute system ps with a fixed environment", () => {
  vi.spyOn(process, "kill").mockReturnValue(true);
  vi.stubEnv("PATH", "/tmp/elsewhere");
  vi.stubEnv("LANG", "de_DE.UTF-8");
  try {
    expect(processIdentity(4343)).toEqual({ state: "alive", identity: "Mon Nov 16 21:27:01 2026" });
  } finally {
    vi.unstubAllEnvs();
  }
  expect(launch).toHaveBeenCalledTimes(1);
  const [program, argv, options] = launch.mock.calls[0] as unknown as [
    string,
    string[],
    { env: NodeJS.ProcessEnv },
  ];
  expect(["/bin/ps", "/usr/bin/ps"]).toContain(program);
  expect(argv).toEqual(["-o", "stat=", "-o", "lstart=", "-p", "4343"]);
  expect(Object.hasOwn(options.env, "PATH")).toBe(false);
  expect(Object.hasOwn(options.env, "LANG")).toBe(false);
  expect(options.env.LC_ALL).toBe("C");
});
