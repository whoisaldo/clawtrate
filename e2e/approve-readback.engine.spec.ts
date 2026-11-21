// Approving this device's access on this computer (docs/design/setup.md §9),
// with the engine against a named development instance of OpenClaw
// 2026.10.6 that this file starts and resets itself. The development tool's
// approve command approves; the host's read-back runs the two fixed reads
// (`gateway call gateway.identity.get` and `gateway call device.pair.list`,
// each with `--expect-url`) through the host runner's own command check and
// the tool's guarded runner, for that instance alone; the reconnect with the
// staged token must show exactly the asked scopes before anything is saved.
//
// The instance is recorded before it starts, so a run killed outright is
// cleaned up by the next `pnpm e2e` in this checkout.

import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkPairedRecord,
  type ReadBack,
  type ReadBackRequest,
} from "../packages/core/src/approval.ts";
import { ClawtrateClient } from "../packages/core/src/client.ts";
import { createNodeHost } from "../packages/core/src/node/index.ts";
import { ADMIN_SCOPES, INTERACTIVE_SCOPES, READ_SCOPES } from "../packages/core/src/scopes.ts";
import { checkRequest, type ProgramRequest } from "../apps/desktop/src/setup/programs.ts";
import { readBackHere } from "../apps/desktop/src/setup/read-back.ts";
import { listInstances } from "./global-setup.ts";
import { FORBIDDEN_PORTS } from "./ports.ts";
import { cleanUp, saveRecord, TEMP_PREFIX, type RunRecord } from "./run-record.ts";
import { openInstance, openOperator, readDevConnection } from "../tools/dev-gateway/src/cli.ts";
import { parseJsonOutput } from "../tools/dev-gateway/src/env.ts";
import { newRunId, processIdentity } from "../tools/dev-gateway/src/state-guard.ts";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "tools/dev-gateway/src/cli.ts");
const RECORDS = join(ROOT, "tools/dev-gateway/.run/e2e");
const RUN = randomBytes(4).toString("hex");
const INSTANCE = `e2e-${RUN}-approve`;
const PROFILE = `clawtrate-dev-${INSTANCE}`;

test.describe.configure({ mode: "serial" });

const record: RunRecord = {
  run: RUN,
  runner: { pid: process.pid, identity: "" },
  instances: [],
  host: null,
  dirs: [],
};
let DIR = "";
let URL = "";
let TOKEN = "";

/** The development tool, as `pnpm dev-gateway` runs it, never pointed at another instance. */
const cli = (...args: string[]) =>
  execFileSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key !== "CLAWTRATE_DEV_INSTANCE"),
    ),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });

/** The instance's devices, as its own CLI lists them, through the tool's guarded runner. */
const devices = () =>
  parseJsonOutput<{ pending?: unknown[]; paired?: Array<Record<string, unknown>> }>(
    openInstance(INSTANCE).runner.runSync(["devices", "list", "--json"]).stdout,
  );

/**
 * The host's read-back on this computer, as the app runs it: the program's
 * profile and the verified address, each command passed through the host
 * runner's own check, then run by the tool's guarded runner for this instance.
 */
function hostReadBack(reads: ReadBack[], asked: ReadBackRequest[] = []) {
  return async (url: string, request: ReadBackRequest): Promise<ReadBack | null> => {
    if (url !== URL) return null;
    asked.push(request);
    const read = await readBackHere({
      run: async (request: ProgramRequest) => {
        checkRequest(request);
        expect(request.args.slice(0, 2)).toEqual(["--profile", PROFILE]);
        const out = await openInstance(INSTANCE).runner.run(request.args.slice(2));
        return {
          exitCode: out.status,
          stdout: out.stdout,
          timedOut: false,
          tooLarge: out.stdout.length > request.maxBytes,
          failed: false,
        };
      },
      program: "/opt/homebrew/bin/openclaw",
      profileArgs: ["--profile", PROFILE],
      env: {},
      cwd: DIR,
      url,
      expected: request.expected,
    });
    reads.push(read);
    return read;
  };
}

/** A client of its own, in a data folder of its own, with the host's read-back. */
async function engine(dataDir: string, reads: ReadBack[], asked: ReadBackRequest[] = []) {
  const client = new ClawtrateClient(
    createNodeHost({
      dataDir,
      client: {
        displayName: "Clawtrate e2e approve",
        version: "0.0.0",
        platform: process.platform,
      },
      readBack: hostReadBack(reads, asked),
    }),
    { reconnect: { initialMs: 200, maxMs: 1000 } },
  );
  await client.start();
  return client;
}

/** The token this client saved for the instance's address, as its data folder holds it. */
function saved(dataDir: string): { key: string; token: string; heldScopes: string[] } | null {
  const state = JSON.parse(readFileSync(join(dataDir, "state.json"), "utf8")) as Record<
    string,
    string
  >;
  const key = Object.keys(state).find((each) => each.startsWith("deviceToken:"));
  if (!key) return null;
  const parsed = JSON.parse(state[key]!) as { token: string; heldScopes: string[] };
  return { key, token: parsed.token, heldScopes: parsed.heldScopes };
}

/**
 * Paired read-only, the first pairing approved with the development tool's
 * approve command; then the app relaunched with the connection saved as the
 * host's setup keeps one found on this computer, for its profile (§9): the
 * read-back after an approval comes from that, not from anything this run
 * still holds in memory.
 */
async function pairedHere(dataDir: string, reads: ReadBack[], asked: ReadBackRequest[] = []) {
  const first = await engine(dataDir, reads, asked);
  await first.connect({ url: URL, token: TOKEN });
  await expect
    .poll(() => first.state.connection.status, { timeout: 60_000 })
    .toMatch(/pairing|connected/);
  if (first.state.connection.status === "pairing")
    cli("approve", first.state.connection.pairing!.requestId, "--instance", INSTANCE);
  await expect.poll(() => first.state.connection.status, { timeout: 60_000 }).toBe("connected");
  await expect.poll(() => saved(dataDir)?.token ?? null, { timeout: 30_000 }).toBeTruthy();
  first.stop();
  const file = join(dataDir, "state.json");
  const state = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  state.connection = JSON.stringify({ url: URL, token: null, here: { profile: "clawtrate" } });
  writeFileSync(file, JSON.stringify(state));
  const client = await engine(dataDir, reads, asked);
  await expect.poll(() => client.state.connection.status, { timeout: 60_000 }).toBe("connected");
  expect(client.state.connection.scopes).toEqual([...READ_SCOPES]);
  await expect.poll(() => client.state.connection.gatewayId, { timeout: 30_000 }).toBeTruthy();
  return client;
}

const asSet = (scopes: readonly string[]) => [...scopes].sort();

test.beforeAll(async () => {
  test.setTimeout(240_000);
  const self = processIdentity(process.pid);
  if (self.state !== "alive") throw new Error("could not determine this process's start time");
  record.runner.identity = self.identity;
  DIR = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  record.dirs.push(DIR);
  const runId = newRunId();
  record.instances.push({ name: INSTANCE, runId });
  saveRecord(RECORDS, record);
  // Without --default-local-pairing: the gateway asks its owner before every device.
  cli("start", "--run-id", runId, "--instance", INSTANCE, "--no-seed");
  const mine = listInstances().find((row) => row.name === INSTANCE);
  if (!mine?.gatewayRunning) throw new Error(`instance ${INSTANCE} is not running`);
  for (const port of [mine.gatewayPort, mine.providerPort]) {
    if (port === null || FORBIDDEN_PORTS.includes(port))
      throw new Error(`instance ${INSTANCE} is on port ${port}, which e2e never uses`);
  }
  const connection = readDevConnection(openInstance(INSTANCE).connectionFile)!;
  URL = connection.url;
  TOKEN = connection.token;
});

test.afterAll(() => {
  const problems = cleanUp(RECORDS, record, (name, runId) =>
    cli("reset", "--run-id", runId, "--instance", name),
  );
  expect(problems).toEqual([]);
});

test("F-500: write access the development tool approves is kept only after the read-back and the reconnect show exactly what was asked", async () => {
  test.setTimeout(180_000);
  const dataDir = mkdtempSync(join(DIR, "write-"));
  const reads: ReadBack[] = [];
  const asked: ReadBackRequest[] = [];
  const client = await pairedHere(dataDir, reads, asked);
  const before = saved(dataDir)!;
  expect(before.heldScopes).toEqual([...READ_SCOPES]);

  await client.requestAccess();
  await expect
    .poll(() => client.state.connection.upgrade.status, { timeout: 30_000 })
    .toBe("pending");
  const requestId = client.state.connection.upgrade.requestId!;
  expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  expect(client.state.connection.upgrade.approveCommand).toBe(
    `openclaw devices approve ${requestId}`,
  );
  // Nothing was read back, and nothing changed, while the request waited.
  expect(reads).toEqual([]);
  expect(saved(dataDir)).toEqual(before);

  // The person approves on the gateway's computer, with the development tool's command.
  cli("approve", requestId, "--instance", INSTANCE);
  await expect.poll(() => client.state.connection.canWrite, { timeout: 60_000 }).toBe(true);

  // The read-back ran once: the identity at the verified address is the connection's gateway,
  // and this device's record holds the operator role alone and exactly the interactive scopes.
  expect(reads).toHaveLength(1);
  // Asked after a relaunch, from the profile kept with the connection, for the gateway
  // identity established before the approval.
  expect(asked).toEqual([
    { expected: client.state.connection.gatewayId, here: { profile: "clawtrate" } },
  ]);
  const read = reads[0]!;
  if (!read.ok) throw new Error(`the read-back failed at ${read.step}`);
  expect(read.identity.deviceId).toBe(client.state.connection.gatewayId);
  const deviceId = client.state.connection.deviceId!;
  const publicKey = (
    read.list as { paired: Array<{ deviceId: string; publicKey: string }> }
  ).paired.find((each) => each.deviceId === deviceId)!.publicKey;
  expect(checkPairedRecord(read.list, { deviceId, publicKey, scopes: INTERACTIVE_SCOPES })).toBe(
    "exact",
  );

  // The reconnect holds exactly those scopes, and only now is the new token saved.
  expect(asSet(client.state.connection.scopes)).toEqual(asSet(INTERACTIVE_SCOPES));
  expect(client.state.connection.upgrade.status).toBe("approved");
  const after = saved(dataDir)!;
  expect(after.token).not.toBe(before.token);
  expect(asSet(after.heldScopes)).toEqual(asSet(INTERACTIVE_SCOPES));
  // The gateway's own list agrees, and this device is still paired: nothing was removed.
  const mine = (devices().paired ?? []).filter((each) => each.deviceId === deviceId);
  expect(mine).toHaveLength(1);
  expect(asSet(mine[0]!.scopes as string[])).toEqual(asSet(INTERACTIVE_SCOPES));
  client.stop();
});

test("F-500: a grant broader than asked disconnects and saves no token", async () => {
  test.setTimeout(180_000);
  const dataDir = mkdtempSync(join(DIR, "broader-"));
  const reads: ReadBack[] = [];
  let client = await pairedHere(dataDir, reads);
  // Earlier, this device was granted admin on this gateway.
  await client.requestAccess("admin");
  await expect
    .poll(() => client.state.connection.upgrade.status, { timeout: 30_000 })
    .toBe("pending");
  cli("approve", client.state.connection.upgrade.requestId!, "--instance", INSTANCE);
  await expect.poll(() => client.state.connection.canAdmin, { timeout: 60_000 }).toBe(true);
  client.stop();
  // Clawtrate's saved record holds read alone, as one that doesn't know of that grant would:
  // set by hand here, the token as the gateway issued it.
  const held = saved(dataDir)!;
  const state = JSON.parse(readFileSync(join(dataDir, "state.json"), "utf8")) as Record<
    string,
    string
  >;
  state[held.key] = JSON.stringify({
    token: held.token,
    grantedScopes: [...READ_SCOPES],
    heldScopes: [...READ_SCOPES],
  });
  writeFileSync(join(dataDir, "state.json"), JSON.stringify(state));
  const before = saved(dataDir);

  client = await engine(dataDir, reads);
  await expect.poll(() => client.state.connection.status, { timeout: 60_000 }).toBe("connected");
  expect(client.state.connection.scopes).toEqual([...READ_SCOPES]);
  await client.requestAccess();
  await expect
    .poll(() => client.state.connection.upgrade.status, { timeout: 30_000 })
    .toBe("pending");
  const requestId = client.state.connection.upgrade.requestId!;
  // The owner approves with the gateway's admin authority (the CLI's own approval refuses a
  // device that already holds admin): the gateway grants this device everything it holds.
  const owner = await openOperator(
    openInstance(INSTANCE),
    "Clawtrate e2e owner",
    [...ADMIN_SCOPES, "operator.pairing"],
    [],
  );
  try {
    await owner.request("device.pair.approve", { requestId });
  } finally {
    await owner.close();
  }
  await expect
    .poll(() => client.state.connection.upgrade.status, { timeout: 60_000 })
    .toBe("unconfirmed");
  expect(client.state.connection.status).toBe("error");
  expect(client.state.connection.error?.message).toBe(
    "Clawtrate disconnected. It couldn't confirm what this request granted. Review this device's access on the gateway before reconnecting.",
  );
  expect(client.state.connection.canWrite).toBe(false);
  // No new token was saved: the saved record is the one from before the request.
  expect(saved(dataDir)).toEqual(before);
  // The gateway did grant more than asked, and the device is still paired: nothing was removed.
  const deviceId = client.state.connection.deviceId!;
  const mine = (devices().paired ?? []).filter((each) => each.deviceId === deviceId);
  expect(mine).toHaveLength(1);
  expect(mine[0]!.scopes as string[]).toContain("operator.admin");
  client.stop();
});
