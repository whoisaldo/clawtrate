// `pnpm scenarios`: the scenario check on an instance of its own.
//
// It starts an unseeded instance named like an end-to-end run's, `e2e-<run>`,
// and records it in the same run records as `pnpm e2e` before starting it, so
// a run killed outright is cleaned up by the next `pnpm e2e` or `pnpm
// scenarios` in this checkout. It never uses the default instance or its ports.
// Afterwards it resets exactly that instance, also on Ctrl-C or SIGTERM.
//
// The instance has the scripted provider accounts and the development
// sign-in plugin, so the account checks (account-checks.ts) run after the
// scenario checks, with an admin client and a read-only one of their own.
// Then the computer checks (computer-checks.ts) run on a second instance,
// `e2e-<run>-computer`, started with `--with-plugin clawtrate-computer`,
// whose bots Marlow and Pip have browsers of their own, and with
// `--with-images`, so the image checks (image-checks.ts) run there after them;
// and the rules checks (rules-checks.ts) on a third, `e2e-<run>-rules`, started
// with `--with-plugin clawtrate-tool-rules`. Each is recorded and reset the
// same way.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  browserPorts,
  imagesPort,
  instancePorts,
  lockOrder,
  openInstance,
  openOperator,
  readDevConnection,
} from "../tools/dev-gateway/src/cli.ts";
import { ACCOUNT_CLIENTS, runAccountChecks } from "../tools/dev-gateway/src/account-checks.ts";
import {
  COMPUTER_CLIENTS,
  runComputerChecks,
  type ComputerClient,
} from "../tools/dev-gateway/src/computer-checks.ts";
import { loadDevPlugin } from "../tools/dev-gateway/src/dev-plugins.ts";
import { runImageChecks } from "../tools/dev-gateway/src/image-checks.ts";
import {
  RULES_CLIENTS,
  runRulesChecks,
  type RulesClient,
} from "../tools/dev-gateway/src/rules-checks.ts";
import { PLUGIN_RULE } from "../tools/dev-gateway/src/cli.ts";
import type { OperatorSession } from "../tools/dev-gateway/src/operator.ts";
import {
  openCheckClients,
  FAMILY_ROWS,
  ownerAgent,
  runScenarioChecks,
  SEQ_GAP_NOTES,
  UNDECLARED_FIELDS,
} from "../tools/dev-gateway/src/scenario-check.ts";
import { newRunId, processIdentity } from "../tools/dev-gateway/src/state-guard.ts";
import { FORBIDDEN_PORTS, devGateway, listInstances } from "./global-setup.ts";
import { cleanUp, recoverDeadRuns, saveRecord, type RunRecord } from "./run-record.ts";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "tools/dev-gateway/src/cli.ts");
const RECORDS = join(ROOT, "tools/dev-gateway/.run/e2e");
const reset = (name: string, runId: string) => void devGateway(name, "reset", "--run-id", runId);

async function main(): Promise<number> {
  recoverDeadRuns(RECORDS, reset);
  const run = randomBytes(4).toString("hex");
  const name = `e2e-${run}`;
  const runId = newRunId();
  const computerName = `${name}-computer`;
  const computerRunId = newRunId();
  const rulesName = `${name}-rules`;
  const rulesRunId = newRunId();
  const self = processIdentity(process.pid);
  if (self.state !== "alive") throw new Error("could not determine this process's start time");
  const record: RunRecord = {
    run,
    runner: { pid: process.pid, identity: self.identity },
    instances: [
      { name, runId },
      { name: computerName, runId: computerRunId },
      { name: rulesName, runId: rulesRunId },
    ],
    host: null,
    dirs: [],
  };
  saveRecord(RECORDS, record);
  let cleaned = false;
  const cleanUpOnce = () => {
    if (cleaned) return [];
    cleaned = true;
    return cleanUp(RECORDS, record, reset);
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      const problems = cleanUpOnce();
      if (problems.length > 0) console.error(problems.join("\n"));
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
  const startInstance = (instance: string, id: string, extra: string[] = []) =>
    new Promise<void>((resolve, reject) => {
      const env = { ...process.env };
      delete env.CLAWTRATE_DEV_INSTANCE;
      const child = spawn(
        process.execPath,
        [CLI, "start", "--no-seed", "--run-id", id, "--instance", instance, ...extra],
        { cwd: ROOT, env, stdio: ["ignore", "inherit", "inherit"] },
      );
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`start failed (${code})`)),
      );
    });
  try {
    console.log(`Starting instance ${name} for the scenario check`);
    await startInstance(name, runId, ["--with-accounts", "--with-plugin", "clawtrate-dev-signin"]);
    const mine = listInstances().find((row) => row.name === name);
    for (const port of [mine?.gatewayPort, mine?.providerPort]) {
      if (port === null || port === undefined || FORBIDDEN_PORTS.includes(port)) {
        throw new Error(`instance ${name} is on port ${port}, which the check never uses`);
      }
    }
    const inst = openInstance(name);
    const providerUrl = `http://127.0.0.1:${instancePorts(inst).providerPort}`;
    const clients = await openCheckClients((label, scopes, caps) =>
      openOperator(inst, label, scopes, caps),
    );
    let scenariosFailed = 0;
    try {
      const { passed, failed, notes } = await runScenarioChecks(clients, {
        ownerAgent: (botId, key, message) => ownerAgent(inst, botId, key, message),
        providerUrl,
      });
      for (const row of FAMILY_ROWS) console.log(`family ${JSON.stringify(row)}`);
      for (const note of notes) console.log(`note  ${note}`);
      for (const [kind, fields] of [...UNDECLARED_FIELDS].sort()) {
        console.log(
          `note  ${kind} carries fields its schema does not declare: ${[...fields].sort().join(", ")}`,
        );
      }
      if (SEQ_GAP_NOTES.size > 0) {
        console.log(
          `note  agent error "seq gap", without the seq its schema requires, came for ${SEQ_GAP_NOTES.size} run(s) the gateway ran from its queue`,
        );
      }
      console.log(`${passed} of ${passed + failed} scenario checks passed`);
      scenariosFailed = failed;
    } finally {
      for (const op of Object.values(clients)) await op.close();
    }
    const admin = await openOperator(
      inst,
      "Clawtrate account check (admin)",
      [...ACCOUNT_CLIENTS.admin.scopes],
      [...ACCOUNT_CLIENTS.admin.caps],
    );
    const reader = await openOperator(
      inst,
      "Clawtrate account check (reader)",
      [...ACCOUNT_CLIENTS.reader.scopes],
      [...ACCOUNT_CLIENTS.reader.caps],
    );
    let accountsFailed = 0;
    try {
      const accounts = await runAccountChecks({
        admin,
        reader,
        providerUrl,
        stateDir: inst.stateDir,
        lock: (bot, provider, profileId) => lockOrder(inst, { bot, provider, profileId }),
      });
      for (const note of accounts.notes) console.log(`note  ${note}`);
      for (const line of accounts.differences) console.log(`differs from the design  ${line}`);
      console.log(
        `${accounts.passed} of ${accounts.passed + accounts.failed} account checks passed`,
      );
      accountsFailed = accounts.failed;
    } finally {
      await admin.close();
      await reader.close();
    }
    const computer = await computerChecks(computerName, computerRunId, startInstance);
    const rules = await rulesChecks(rulesName, rulesRunId, startInstance);
    return scenariosFailed === 0 && accountsFailed === 0 && computer === 0 && rules === 0 ? 0 : 1;
  } finally {
    const problems = cleanUpOnce();
    if (problems.length > 0) {
      console.error(problems.join("\n"));
      process.exitCode = 1;
    }
  }
}

/** Start the computer instance, run the computer checks on it, and return how many failed. */
async function computerChecks(
  name: string,
  runId: string,
  startInstance: (instance: string, id: string, extra: string[]) => Promise<void>,
): Promise<number> {
  const declaration = loadDevPlugin("clawtrate-computer", ROOT, PLUGIN_RULE).botBrowsers;
  if (!declaration) throw new Error("clawtrate-computer declares no bot browsers");
  console.log(`Starting instance ${name} for the computer checks`);
  await startInstance(name, runId, ["--with-plugin", "clawtrate-computer", "--with-images"]);
  const inst = openInstance(name);
  const ports = instancePorts(inst);
  const { pagesPort, botCdpPorts } = browserPorts(ports, declaration.bots);
  const standIn = imagesPort(ports);
  for (const port of [ports.gatewayPort, ports.providerPort, pagesPort, ...botCdpPorts, standIn]) {
    if (FORBIDDEN_PORTS.includes(port)) {
      throw new Error(`instance ${name} is on port ${port}, which the check never uses`);
    }
  }
  const clients: Partial<Record<ComputerClient, OperatorSession>> = {};
  try {
    for (const [client, { scopes, caps }] of Object.entries(COMPUTER_CLIENTS)) {
      clients[client as ComputerClient] = await openOperator(
        inst,
        `Clawtrate computer check (${client})`,
        [...scopes],
        [...caps],
      );
    }
    // Pip acts first; Marlow is the second bot whose browser Pip's session must not see.
    const order = ["pip", "marlow"].filter((bot) => declaration.bots.includes(bot));
    const { passed, failed } = await runComputerChecks({
      clients: clients as Record<ComputerClient, OperatorSession>,
      openExtra: (label) =>
        openOperator(inst, label, ["operator.read", "operator.write"], ["tool-events"]),
      gatewayPort: ports.gatewayPort,
      stateDir: inst.stateDir,
      pagesOrigin: `http://127.0.0.1:${pagesPort}`,
      bots: order.map((id) => ({ id, cdpPort: botCdpPorts[declaration.bots.indexOf(id)]! })),
      renewTimeoutMs: declaration.renewTimeoutMs,
      drainTimeoutMs: declaration.drainTimeoutMs,
    });
    console.log(`${passed} of ${passed + failed} computer checks passed`);
    const images = await runImageChecks({
      writer: clients.holder!,
      reader: clients.reader!,
      gatewayOrigin: `http://127.0.0.1:${ports.gatewayPort}`,
      imagesOrigin: `http://127.0.0.1:${standIn}`,
      stateDir: inst.stateDir,
      gatewayToken: readDevConnection(inst.connectionFile)!.token,
      providerLog: join(inst.runDir, "provider.log"),
      gatewayLog: join(inst.runDir, "gateway.log"),
      stamp: Date.now().toString(36),
    });
    console.log(`${images.passed} of ${images.passed + images.failed} image checks passed`);
    return failed + images.failed;
  } finally {
    for (const op of Object.values(clients)) await op.close();
  }
}

/** Start the rules instance, run the rules checks on it, and return how many failed. */
async function rulesChecks(
  name: string,
  runId: string,
  startInstance: (instance: string, id: string, extra: string[]) => Promise<void>,
): Promise<number> {
  console.log(`Starting instance ${name} for the rules checks`);
  await startInstance(name, runId, ["--with-plugin", "clawtrate-tool-rules"]);
  const inst = openInstance(name);
  const ports = instancePorts(inst);
  for (const port of [ports.gatewayPort, ports.providerPort]) {
    if (FORBIDDEN_PORTS.includes(port)) {
      throw new Error(`instance ${name} is on port ${port}, which the check never uses`);
    }
  }
  const clients: Partial<Record<RulesClient, OperatorSession>> = {};
  try {
    for (const [client, { scopes, caps }] of Object.entries(RULES_CLIENTS)) {
      clients[client as RulesClient] = await openOperator(
        inst,
        `Clawtrate rules check (${client})`,
        [...scopes],
        [...caps],
      );
    }
    const { passed, failed } = await runRulesChecks({
      clients: clients as Record<RulesClient, OperatorSession>,
      gatewayLog: join(inst.runDir, "gateway.log"),
      stateDir: inst.stateDir,
    });
    console.log(`${passed} of ${passed + failed} rules checks passed`);
    return failed;
  } finally {
    for (const op of Object.values(clients)) await op.close();
  }
}

main().then(
  (code) => {
    process.exitCode ||= code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
