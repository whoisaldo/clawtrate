// pnpm preview:web [--dev-gateway] [--no-access-token] [--instance <name>]
//                  [--port 5310] [--host 0.0.0.0] [--data-dir <dir>] [--read-only]
//                  [--setup-look --setup-sandbox <file>]
//
// Serves the Clawtrate renderer to a browser on another machine. The gateway
// connection, the device key and pairing all stay in this process.
// `--instance` (or CLAWTRATE_DEV_INSTANCE) selects the development instance
// whose gateway the development-only modes accept; the default instance otherwise.
// `--read-only` pins the connection to the read tier: the interface shows the
// read-only conversation and never offers to ask for more access.
// `--setup-look` shows the first screen of setup and lets "This computer" look
// on the computer running this host, which is not the viewer's: it is off by
// default, runs only in the sandbox `--setup-sandbox` names, keeps its data in
// that sandbox's run folder, never resumes a saved gateway, and never pairs,
// since this host has no dialog of its own to ask first (docs/decisions.md).

import { realpathSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readDevConnection, selectInstance, startHostRuntime } from "../host/runtime.ts";
import { createAccessToken, startWebHost } from "./server.ts";
import { setupLookChoice } from "./setup-look.ts";
import { webStartup } from "../setup/startup.ts";
import { SetupController } from "../setup/controller.ts";
import { ProgramRunner } from "../setup/programs.ts";
import { sandboxOpener } from "../setup/sandbox.ts";
import { startSyntheticGateway } from "../setup/synthetic-gateway.ts";
import { accountHome } from "../setup/world.ts";

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_ROOT = join(APP_ROOT, "../..");

const { values } = parseArgs({
  options: {
    host: { type: "string", default: "0.0.0.0" },
    port: { type: "string", default: "5310" },
    "data-dir": { type: "string" },
    "static-dir": { type: "string", default: join(APP_ROOT, "out/web") },
    "dev-gateway": { type: "boolean", default: false },
    "no-access-token": { type: "boolean", default: false },
    instance: { type: "string" },
    "read-only": { type: "boolean", default: false },
    "setup-look": { type: "boolean", default: false },
    "setup-sandbox": { type: "string" },
  },
  allowPositionals: false,
});

function defaultDataDir(): string {
  const base = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(base, "clawtrate", "web-host");
}

function networkUrls(port: number, query: string): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === "IPv4" && !entry.internal)
    .map((entry) => `http://${entry!.address}:${port}/${query}`);
}

async function main(): Promise<void> {
  // Decided before anything starts: the setup look's sandbox, or why there is none. A setup
  // look then resolves no development gateway, no ordinary data folder and no saved gateway.
  const context = {
    platform: process.platform,
    home: accountHome(),
    uid: process.getuid?.() ?? null,
  };
  const setupLook = setupLookChoice(values, context);
  if (setupLook.kind === "refused") throw new Error(setupLook.message);
  const instance = setupLook.kind === "off" ? selectInstance(values.instance, process.env) : null;
  const tokenDisabled = values["no-access-token"];
  const start = webStartup(setupLook, {
    devConnection: () => readDevConnection(REPO_ROOT, { instance }),
    dataDir: () => values["data-dir"] ?? defaultDataDir(),
    autoConnectDev: values["dev-gateway"] || tokenDisabled,
  });
  const devGateway = start.devGateway;
  if (tokenDisabled && !devGateway) {
    const flag = instance === null ? "" : ` --instance ${instance}`;
    throw new Error(
      `--no-access-token is only allowed with the development gateway. Run \`pnpm dev-gateway up${flag}\` first.`,
    );
  }
  const port = Number(values.port);
  const runtime = await startHostRuntime({
    kind: "web",
    displayName: "Clawtrate Web",
    dataDir: start.dataDir,
    devGateway,
    autoConnectDev: start.autoConnectDev,
    // Without an access token, anyone who can reach the port can use this host,
    // so it may only ever talk to the local development gateway: saved, typed,
    // retried or otherwise.
    devOnly: tokenDisabled,
    recheckDevGateway: () => readDevConnection(REPO_ROOT, { instance }),
    readOnly: values["read-only"],
    // The setup look never resumes a saved gateway.
    resume: start.resume,
  });
  const programs = new ProgramRunner();
  let closeSetup = async () => {};
  if (setupLook.kind === "sandbox") {
    // A development and review host: it looks only in its sandbox, through the stand-in.
    const opener = sandboxOpener({
      file: setupLook.file,
      sandbox: setupLook.sandbox,
      platform: process.platform,
      context: { ...context, checkout: realpathSync(REPO_ROOT) },
      startGateway: startSyntheticGateway,
      log: (line) => console.log(line),
    });
    closeSetup = opener.close;
    runtime.policy.setup = new SetupController({
      client: runtime.client,
      open: opener.open,
      stopPrograms: () => programs.stopAll(),
      confirm: null,
      log: (line) => console.log(line),
    });
    runtime.info.setup = { look: true, pair: false, platform: process.platform };
  }
  const accessToken = tokenDisabled ? null : createAccessToken();
  const host = startWebHost({
    runtime,
    staticDir: values["static-dir"]!,
    host: values.host!,
    port,
    accessToken,
  });

  host.server.once("listening", () => {
    // With --port 0 the system chooses; print the port actually bound.
    const bound = (host.server.address() as AddressInfo).port;
    const query = accessToken ? `?token=${accessToken}` : "";
    console.log("\nClawtrate web preview");
    console.log(`  Local    http://localhost:${bound}/${query}`);
    for (const url of networkUrls(bound, query)) console.log(`  Network  ${url}`);
    console.log(
      accessToken
        ? "\nThe access token is shown once. Anyone with this link can read the connected gateway's sessions."
        : "\nAccess token disabled: this host only connects to the development gateway.",
    );
    if (values["read-only"])
      console.log("Read-only: this host never sends and never asks for more access.");
    if (devGateway) {
      const which = devGateway.instance === null ? "default" : `instance ${devGateway.instance}`;
      console.log(`Development gateway: ${devGateway.url} (${which})`);
    }
  });

  const shutdown = () => {
    programs.stopAll();
    void closeSetup();
    runtime.client.stop();
    void host.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
