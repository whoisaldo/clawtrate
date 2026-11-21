// Nothing may automate a packaged app without the sandbox switch: started
// with none of the markers, it is a person's app and looks at the real
// computer (docs/development/setup.md). Every launch of the packaged app the
// launch check makes carries `--clawtrate-setup-sandbox`.
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exitedWithin, launchArgs, launchPlace, recordExit } from "../e2e-packaged/global-setup.ts";

const ROOT = join(import.meta.dirname, "..");

describe("the packaged app's launches", () => {
  it("always carry the sandbox switch, beside the data folder and the debugging port", () => {
    expect(launchArgs("/data", "/tmp/run/sandbox.json", "/checkout")).toEqual([
      "--user-data-dir=/data",
      "--remote-debugging-port=0",
      "--clawtrate-setup-sandbox=/tmp/run/sandbox.json",
      "--clawtrate-setup-checkout=/checkout",
    ]);
  });

  it("every spawn of the packaged executable in the launch check names a sandbox", () => {
    const folder = join(ROOT, "e2e-packaged");
    const launches: string[] = [];
    for (const file of readdirSync(folder).filter((name) => name.endsWith(".ts"))) {
      const lines = readFileSync(join(folder, file), "utf8").split("\n");
      lines.forEach((line, index) => {
        if (!/spawn\(|gatedSpawn\(/.test(line)) return;
        const call = lines.slice(index, index + 8).join("\n");
        if (!/packagedExecutable\(|\bexe\b/.test(call)) return;
        launches.push(`${file}:${index + 1}`);
        expect(call, `${file}:${index + 1}`).toMatch(/launchArgs\(|--clawtrate-setup-sandbox=/);
      });
    }
    // The main launch, the Windows launch and the second launch.
    expect(launches.length).toBeGreaterThanOrEqual(3);
  });

  it("every packaged launch, the second included, gets the run's own home, temporary folder and working folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "clawtrate-launch-place-"));
    try {
      const place = launchPlace(dir);
      expect(place.cwd).toBe(join(dir, "work"));
      expect(place.env.HOME).toBe(join(dir, "home"));
      expect(place.env.TMPDIR).toBe(join(dir, "tmp"));
      expect(Object.keys(place.env).filter((key) => key.startsWith("CLAWTRATE_"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const folder = join(ROOT, "e2e-packaged");
    let launches = 0;
    for (const file of readdirSync(folder).filter((name) => name.endsWith(".ts"))) {
      const lines = readFileSync(join(folder, file), "utf8").split("\n");
      lines.forEach((line, index) => {
        if (!/spawn\(|gatedSpawn\(/.test(line)) return;
        const call = lines.slice(index, index + 12).join("\n");
        if (!/packagedExecutable\(|\bexe\b/.test(call)) return;
        launches += 1;
        expect(call, `${file}:${index + 1}`).toMatch(/cwd: place\.cwd/);
        expect(call, `${file}:${index + 1}`).toMatch(/env: place\.env/);
      });
    }
    expect(launches).toBeGreaterThanOrEqual(3);
  });

  it("an app that exited before its teardown asked is seen as exited, from the exit recorded at its spawn", async () => {
    const child = recordExit(spawn(process.execPath, ["-e", ""], { stdio: "ignore" }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const started = Date.now();
    expect(await exitedWithin(child, 5_000)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("an app still running at the end of the wait has not exited", async () => {
    const child = recordExit(
      spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" }),
    );
    try {
      expect(await exitedWithin(child, 300)).toBe(false);
    } finally {
      process.kill(child.pid!, "SIGKILL");
    }
  });
});
