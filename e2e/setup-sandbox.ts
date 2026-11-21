// A sandbox for the look on this computer (docs/development/setup.md): a
// private folder of the account's, made here under the system's temporary
// folder (the app takes any such folder and binds none to a launch),
// holding the look's home and working folder and the description,
// `sandbox.json`, which names a development instance of this checkout's, that
// instance's current run and a scenario, and nothing else. The checks write
// one per launch; a developer writes one with
//
//   node e2e/setup-sandbox.ts --instance <name> [--scenario <scenario>]
//
// which prints the description's path for `--clawtrate-setup-sandbox=` or
// CLAWTRATE_SETUP_SANDBOX. The instance must be running from this checkout.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runDirFor, validateInstanceName } from "../tools/dev-gateway/src/instance.ts";
import { readRunRecord } from "../tools/dev-gateway/src/state-guard.ts";
import { SANDBOX_FILE, SCENARIOS, type Scenario } from "../apps/desktop/src/setup/sandbox.ts";

const ROOT = join(import.meta.dirname, "..");

/** A written sandbox: its description, its folder, the look's home, and the app's data folder. */
export type Sandbox = { file: string; root: string; home: string; appData: string };

/** The run id this checkout recorded when it last started the instance. */
export function currentRun(instance: string, checkout = ROOT): string {
  const record = readRunRecord(
    join(
      runDirFor(validateInstanceName(instance), join(checkout, "tools/dev-gateway/.run")),
      "state.json",
    ),
  );
  if (!record)
    throw new Error(`instance ${instance} has no run of this checkout's: start it first`);
  return record.runId;
}

/**
 * Writes a sandbox in a new private folder under `parent` (the system's
 * temporary folder by default): its home, its working folder and its
 * description. `run` is the instance's current run unless given.
 */
export function writeSandbox(options: {
  instance: string;
  scenario?: Scenario;
  parent?: string;
  run?: string;
}): Sandbox {
  const instance = validateInstanceName(options.instance);
  const root = mkdtempSync(join(options.parent ?? tmpdir(), "clawtrate-setup-"));
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(join(root, "work"), { mode: 0o700 });
  mkdirSync(join(root, "app-data"), { mode: 0o700 });
  const file = join(root, SANDBOX_FILE);
  const description = {
    instance,
    run: options.run ?? currentRun(instance),
    ...(options.scenario ? { scenario: options.scenario } : {}),
  };
  writeFileSync(file, JSON.stringify(description), { mode: 0o600 });
  return { file, root, home, appData: join(root, "app-data") };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { instance: { type: "string" }, scenario: { type: "string" } },
  });
  if (!values.instance) throw new Error("--instance <name> names a development instance of yours");
  const scenario = values.scenario as Scenario | undefined;
  if (scenario !== undefined && !SCENARIOS.includes(scenario))
    throw new Error(`--scenario is one of ${SCENARIOS.join(", ")}`);
  console.log(writeSandbox({ instance: values.instance, ...(scenario ? { scenario } : {}) }).file);
}
