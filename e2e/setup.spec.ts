// Setting up on this computer (docs/design/setup.md §3 to §7) in the
// desktop app's development build, driven by Playwright, through sandboxes
// of its own (docs/development/setup.md). Each launch gets a private run
// folder whose description names this file's development instance, its
// current run and a scenario; the host proves that run and answers the
// look's commands with its own stand-in, so no launch here starts a program
// of OpenClaw's. The instance, started for this file with
// --default-local-pairing, gives the look its facts and is where Advanced
// connects. Pairing through "This computer" goes to the host's synthetic
// gateway in the `pairing` scenario, with the stand-in's fixture mint: it
// proves the app's side of pairing, not OpenClaw's. The native dialog is
// answered in the app's main process.
//
// The instance is recorded in a run record of this file's own before it
// starts, so a run killed outright is cleaned up by the next `pnpm e2e`. Only
// the shard that runs this file starts it.
//
// Electron must be installed. On Linux the app runs without Chromium's
// sandbox (CI's runners refuse its namespaces) and needs a display (CI uses xvfb).
import { _electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { devGateway, FORBIDDEN_PORTS, listInstances } from "./global-setup.ts";
import { cleanUp, saveRecord, TEMP_PREFIX, type RunRecord } from "./run-record.ts";
import { writeSandbox } from "./setup-sandbox.ts";
import type { Scenario } from "../apps/desktop/src/setup/sandbox.ts";
import { openInstance, readDevConnection } from "../tools/dev-gateway/src/cli.ts";
import { parseJsonOutput } from "../tools/dev-gateway/src/env.ts";
import { newRunId, processIdentity } from "../tools/dev-gateway/src/state-guard.ts";

const ROOT = join(import.meta.dirname, "..");
const DESKTOP = join(ROOT, "apps/desktop");
const CLI = join(ROOT, "tools/dev-gateway/src/cli.ts");
const RECORDS = join(ROOT, "tools/dev-gateway/.run/e2e");
/** This file's own run: its instance and its folder. */
const RUN = randomBytes(4).toString("hex");
const SETUP = `e2e-${RUN}-setup`;
const PROFILE = `clawtrate-dev-${SETUP}`;

/**
 * Electron's binary, or null where it was never downloaded. Asked only when
 * the checks run: requiring `electron` without its binary starts a download,
 * which must not happen while Playwright only lists the checks.
 */
function electronBinary(): string | null {
  try {
    const path = createRequire(join(DESKTOP, "package.json"))("electron") as string;
    return existsSync(path) ? path : null;
  } catch {
    return null;
  }
}
let ELECTRON: string | null = null;

test.describe.configure({ mode: "serial" });

const record: RunRecord = {
  run: RUN,
  runner: { pid: process.pid, identity: "" },
  instances: [],
  host: null,
  dirs: [],
};
let DIR = "";

let count = 0;
/** A fresh folder of this file's run, for one launch. */
const folder = (name: string) => {
  const dir = join(DIR, `${(count += 1)}-${name}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** The environment the app gets: nothing that points it at a development gateway or changes Electron. */
function appEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !/^(CLAWTRATE_|ELECTRON_|NODE_OPTIONS$|OPENCLAW_)/.test(entry[0]),
    ),
  );
}

type Launched = { app: ElectronApplication; page: Page; log: () => string; data: string };

/** Every app this file launched and hasn't closed: closed after each check, passed or failed. */
const running = new Set<ElectronApplication>();

/**
 * Launches the development build with its own data folder and, unless told
 * not to, a sandbox of `scenario` for this file's instance. `answer` is the
 * native dialog's answer: 0 confirms, 1 cancels. The dialog writes a fixed
 * line to the app's output when it answers, so the output says what came first.
 */
async function launch(
  options: { sandbox?: string | null; scenario?: Scenario; answer?: number } = {},
): Promise<Launched> {
  const dir = folder("app");
  const file =
    options.sandbox === null
      ? null
      : (options.sandbox ??
        writeSandbox({
          instance: SETUP,
          // The run this file started the instance with, from its own record.
          run: record.instances[0]!.runId,
          parent: dir,
          ...(options.scenario ? { scenario: options.scenario } : {}),
        }).file);
  // A sandboxed app keeps its data in the sandbox's own folder; the check passes and reads that one.
  const data = file === null ? join(dir, "user-data") : join(dirname(file), "app-data");
  const args = [DESKTOP, `--user-data-dir=${data}`];
  if (process.platform === "linux") args.push("--no-sandbox");
  if (file !== null) args.push(`--clawtrate-setup-sandbox=${file}`);
  const app = await _electron.launch({ executablePath: ELECTRON!, args, env: appEnv(), cwd: dir });
  running.add(app);
  try {
    return await ready(app, options.answer ?? 0, data);
  } catch (error) {
    // A launch that didn't come up is closed here, before its folders are removed.
    running.delete(app);
    await app.close().catch(() => {});
    throw error;
  }
}

/** The app's output kept, its dialog answered with `answer`, and its first screen up. */
async function ready(app: ElectronApplication, answer: number, data: string): Promise<Launched> {
  let output = "";
  app.process().stdout?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  app.process().stderr?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  // The host's own dialog, answered as the person would; the questions it asked are kept.
  await app.evaluate(({ dialog }, response) => {
    const asked: string[] = [];
    (globalThis as { asked?: string[] }).asked = asked;
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.at(-1) as { message: string; detail: string };
      asked.push(`${options.message} ${options.detail}`);
      console.log(`[e2e] The host's dialog answered ${response}.`);
      return { response, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  }, answer);
  const page = await app.firstWindow();
  await page
    .getByRole("heading", { name: "Where does OpenClaw run?" })
    .waitFor({ timeout: 30_000 });
  return { app, page, log: () => output, data };
}

async function close(launched: Launched): Promise<void> {
  const pid = launched.app.process().pid;
  running.delete(launched.app);
  await launched.app.close();
  // The app and every helper it started are gone.
  if (pid !== undefined) expect(() => process.kill(pid, 0)).toThrow();
}

const asked = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as { asked?: string[] }).asked ?? []);

/** The gateway's own list of devices, read with the dev-gateway tool's runner. */
function devices(): {
  paired: Array<{ deviceId: string; scopes?: string[]; approvedVia?: string; roles?: string[] }>;
  pending: unknown[];
} {
  const result = openInstance(SETUP).runner.runSync(["devices", "list", "--json"]);
  if (result.status !== 0) throw new Error(`devices list exited ${result.status}`);
  return parseJsonOutput(`${result.stdout}`);
}

const thisComputer = (page: Page) =>
  page
    .getByRole("list", { name: "Where does OpenClaw run?" })
    .getByRole("button", { name: /This computer/ });

/** What the app stored: its key-value file, `state.json` in its data folder, as text. */
function readStore(data: string): string {
  const path = join(data, "gateway/state.json");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

const cli = (...args: string[]) =>
  execFileSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key !== "CLAWTRATE_DEV_INSTANCE"),
    ),
    stdio: ["ignore", "inherit", "inherit"],
  });

test.beforeAll(async () => {
  test.setTimeout(600_000);
  ELECTRON = electronBinary();
  if (ELECTRON === null) throw new Error("Electron's binary is missing: run pnpm install with it");
  // Recorded before anything starts, so a killed run is cleaned up by the next one.
  const self = processIdentity(process.pid);
  if (self.state !== "alive") throw new Error("could not determine this process's start time");
  record.runner.identity = self.identity;
  DIR = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  record.dirs.push(DIR);
  const runId = newRunId();
  record.instances.push({ name: SETUP, runId });
  saveRecord(RECORDS, record);
  cli("start", "--run-id", runId, "--instance", SETUP, "--default-local-pairing", "--no-seed");
  const mine = listInstances().find((row) => row.name === SETUP);
  if (!mine?.gatewayRunning) throw new Error(`instance ${SETUP} is not running`);
  for (const port of [mine.gatewayPort, mine.providerPort]) {
    if (port === null || FORBIDDEN_PORTS.includes(port)) {
      throw new Error(`instance ${SETUP} is on port ${port}, which e2e never uses`);
    }
  }
  // The development build of the desktop app, into its own output folder.
  execFileSync("pnpm", ["--filter", "@clawtrate/desktop", "exec", "electron-vite", "build"], {
    cwd: ROOT,
    stdio: "ignore",
  });
});

// A check that failed before its own close leaves no app running into the suite's cleanup.
test.afterEach(async () => {
  for (const app of running) await app.close().catch(() => {});
  running.clear();
});

test.afterAll(() => {
  const problems = cleanUp(RECORDS, record, (name, runId) =>
    cli("reset", "--run-id", runId, "--instance", name),
  );
  expect(problems).toEqual([]);
});

const MINTED = "[setup] The stand-in made a one-time code for the synthetic gateway.";
const ANSWERED = (response: number) => `[e2e] The host's dialog answered ${response}.`;
/** A one-time code's shape, as the fixture mint makes them: exactly 43 base64url characters. */
const CODE_SHAPE = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/;

test("an automated launch without a sandbox is refused, loudly, and looks at nothing", async () => {
  const launched = await launch({ sandbox: null });
  await thisComputer(launched.page).click();
  await expect(
    launched.page.getByRole("heading", { name: "Looking on this computer is off here" }),
  ).toBeVisible();
  await expect(launched.page.getByText(/because none was given to this run\./)).toBeVisible();
  await expect
    .poll(launched.log)
    .toContain(
      "The look on this computer refused to start: this run must look in a sandbox and was given none.",
    );
  await close(launched);
});

test("a description that names a program is refused before anything is read or run", async () => {
  const dir = folder("refused");
  const sandbox = writeSandbox({ instance: SETUP, run: record.instances[0]!.runId, parent: dir });
  const file = JSON.parse(readFileSync(sandbox.file, "utf8")) as Record<string, string>;
  writeFileSync(sandbox.file, JSON.stringify({ ...file, openclaw: "/usr/local/bin/openclaw" }));
  const launched = await launch({ sandbox: sandbox.file });
  await thisComputer(launched.page).click();
  await expect(
    launched.page.getByRole("heading", { name: "Looking on this computer is off here" }),
  ).toBeVisible();
  await expect(launched.page.getByText(/or has the wrong shape\./)).toBeVisible();
  await close(launched);
});

test("F-492: the look names this run's instance from its own records, with nothing typed", async () => {
  const launched = await launch();
  const { page } = launched;
  await thisComputer(page).click();
  await expect(page.getByRole("heading", { name: "OpenClaw is running" })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByTestId("setup-found").locator("dl > div")).toHaveText([
    "Version2026.10.6",
    `Profile${PROFILE}`,
    "ListensConfigured for loopback",
    "ServiceNo matching service reported",
  ]);
  await expect(page.locator("input")).toHaveCount(0);
  // A development instance is never paired with: after the dialog, a fixed refusal.
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByText(/because it pairs only in its pairing scenario\./)).toBeVisible();
  expect(launched.log()).not.toContain(MINTED);
  expect(readStore(launched.data)).not.toContain("deviceToken:");
  await close(launched);
});

test("F-492: the consent declined makes no code and pairs nothing", async () => {
  const launched = await launch({ scenario: "pairing", answer: 1 });
  await thisComputer(launched.page).click();
  await expect(launched.page.getByRole("heading", { name: "OpenClaw is running" })).toBeVisible({
    timeout: 60_000,
  });
  await launched.page.getByRole("button", { name: "Connect" }).click();
  await expect.poll(() => asked(launched.app)).toHaveLength(1);
  await expect(launched.page.getByRole("heading", { name: "OpenClaw is running" })).toBeVisible();
  await expect(launched.page.getByRole("button", { name: "Connect" })).toBeVisible();
  expect(launched.log()).toContain(ANSWERED(1));
  expect(launched.log()).not.toContain(MINTED);
  expect(readStore(launched.data)).not.toContain("deviceToken:");
  await close(launched);
});

test("F-492: Connect pairs read-only with nothing typed, after the host's dialog, and opens on the bots", async () => {
  const launched = await launch({ scenario: "pairing" });
  const { page } = launched;
  await thisComputer(page).click();
  await expect(page.getByRole("heading", { name: "OpenClaw is running" })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.locator("input")).toHaveCount(0);
  await page.getByRole("button", { name: "Connect" }).click();
  // The app opens on its bots, read-only, with nothing typed.
  await expect(page.locator(".shell")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("bot-list").getByText("Juniper")).toBeVisible();
  expect(await asked(launched.app)).toEqual([
    `Pair this device read-only with the ${PROFILE} gateway on this computer? Clawtrate asks for read access. The gateway may ask its owner to approve this device.`,
  ]);
  // The dialog answered before any code was made.
  const output = launched.log();
  expect(output.indexOf(ANSWERED(0))).toBeGreaterThan(-1);
  expect(output.indexOf(MINTED)).toBeGreaterThan(output.indexOf(ANSWERED(0)));
  // Exactly read is what this device keeps.
  const store = JSON.parse(readStore(launched.data)) as Record<string, string>;
  const tokens = Object.entries(store).filter(([key]) => key.startsWith("deviceToken:"));
  expect(tokens).toHaveLength(1);
  expect(JSON.parse(tokens[0]![1]).heldScopes).toEqual(["operator.read"]);
  await close(launched);
});

test("F-494: the one-time code of a pairing reaches none of the app's output or stored data", async () => {
  const launched = await launch({ scenario: "pairing" });
  const { page } = launched;
  await thisComputer(page).click();
  await expect(page.getByRole("heading", { name: "OpenClaw is running" })).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.locator(".shell")).toBeVisible({ timeout: 60_000 });
  expect(launched.log()).toContain(MINTED);
  // No string of a one-time code's shape in the output or the store; the device token and id are not.
  expect(launched.log()).not.toMatch(CODE_SHAPE);
  expect(readStore(launched.data)).not.toMatch(CODE_SHAPE);
  await close(launched);
});

test("F-515: another version is named, offers Advanced, and runs nothing for the person", async () => {
  const launched = await launch({ scenario: "untested-version" });
  await thisComputer(launched.page).click();
  await expect(launched.page.getByRole("status").filter({ hasText: "2026.9.37" })).toHaveText(
    "OpenClaw 2026.9.37 isn't the version this Clawtrate is tested with (2026.10.6). Use Advanced to try connecting.",
    { timeout: 60_000 },
  );
  await expect(launched.page.getByRole("button", { name: "Connect" })).toHaveCount(0);
  await expect(launched.page.getByRole("button", { name: "Use Advanced" })).toBeVisible();
  expect(await asked(launched.app)).toEqual([]);
  await close(launched);
});

test("F-516: another profile is named and not connected to", async () => {
  const dir = folder("others");
  const sandbox = writeSandbox({ instance: SETUP, run: record.instances[0]!.runId, parent: dir });
  mkdirSync(join(sandbox.home, ".openclaw-work"));
  const launched = await launch({ sandbox: sandbox.file });
  await thisComputer(launched.page).click();
  await expect(launched.page.getByRole("status").filter({ hasText: "reported here" })).toHaveText(
    "Other OpenClaw services or profile folders reported here: profile work.",
    { timeout: 60_000 },
  );
  // What the card offers to connect to is this file's instance, by its profile.
  await expect(launched.page.getByTestId("setup-found").locator("dl > div").nth(1)).toHaveText(
    `Profile${PROFILE}`,
  );
  await close(launched);
});

test("F-493: Advanced is the address-and-token form, and it still connects", async () => {
  const before = devices().paired.map((device) => device.deviceId);
  const launched = await launch();
  const { page } = launched;
  await page.getByRole("button", { name: "Advanced" }).click();
  const connection = readDevConnection(openInstance(SETUP).connectionFile)!;
  await page.getByPlaceholder("Gateway address").fill(connection.url);
  await page.getByPlaceholder("Gateway token, for pairing").fill(connection.token);
  await page.getByRole("button", { name: "Connect a gateway" }).click();
  await expect(page.locator(".shell")).toBeVisible({ timeout: 60_000 });
  const added = devices().paired.filter((device) => !before.includes(device.deviceId));
  expect(added).toHaveLength(1);
  expect(added[0]!.scopes).toEqual(["operator.read"]);
  expect(await asked(launched.app)).toEqual([]);
  await close(launched);
});

test("a gateway that is stopped is installed but not running, with nothing listening on its port", async () => {
  devGateway(SETUP, "stop");
  const launched = await launch();
  await thisComputer(launched.page).click();
  await expect(
    launched.page.getByRole("heading", { name: "OpenClaw is installed but not running" }),
  ).toBeVisible({ timeout: 60_000 });
  const facts = launched.page.getByTestId("setup-found").locator("dl > div");
  await expect(facts.nth(0)).toHaveText("Installed program2026.10.6");
  await expect(facts.nth(1)).toHaveText("ServiceNo matching service reported");
  await expect(facts.nth(2)).toHaveText(/^PortNo gateway answered on port 19\d\d\d$/);
  await expect(launched.page.getByRole("button", { name: "Connect" })).toHaveCount(0);
  await close(launched);
});
