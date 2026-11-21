// Whether this process is the gateway of a named development instance that
// Clawtrate's dev-gateway tool started. Until the plugin is ready for other
// gateways (issue #29) it registers nothing anywhere else, whatever the
// gateway's configuration says.
//
// The same check as plugins/clawtrate-dev-signin's, kept as a copy because
// each plugin is installed on its own; a test keeps the two the same.

import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** What the dev-gateway tool leaves in an instance's state folder (state-guard.ts). */
const MARKER_FILE = ".clawtrate-dev-gateway";
const CREATED_BY = "clawtrate tools/dev-gateway";
const STATE_FOLDER = /^\.openclaw-clawtrate-dev-([a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?)$/;

/**
 * Why this process is not the gateway of a named development instance the
 * dev-gateway tool started, or null. The evidence is the tool's own: the
 * state folder and profile the tool runs OpenClaw with, the marker it writes
 * there before it starts the gateway, which records the gateway's process,
 * and the plugin's own code lying inside that folder.
 */
export function developmentInstanceProblem(
  env = process.env,
  pid = process.pid,
  here = fileURLToPath(import.meta.url),
) {
  const stateDir = env.OPENCLAW_STATE_DIR;
  if (!stateDir) return "the gateway runs with no OPENCLAW_STATE_DIR";
  const match = STATE_FOLDER.exec(basename(stateDir));
  if (!match || dirname(stateDir) !== homedir()) {
    return `the gateway's state folder ${stateDir} is not a named development instance's (~/.openclaw-clawtrate-dev-<name>)`;
  }
  const instance = match[1];
  if (env.OPENCLAW_PROFILE !== `clawtrate-dev-${instance}`) {
    return `the gateway's profile is ${JSON.stringify(env.OPENCLAW_PROFILE ?? null)}, not clawtrate-dev-${instance}`;
  }
  let marker;
  try {
    const folder = lstatSync(stateDir);
    if (folder.isSymbolicLink() || !folder.isDirectory() || realpathSync(stateDir) !== stateDir) {
      return `${stateDir} is not a real folder`;
    }
    const file = lstatSync(join(stateDir, MARKER_FILE));
    if (file.isSymbolicLink() || !file.isFile())
      return `${stateDir} has no marker of the dev-gateway tool`;
    marker = JSON.parse(readFileSync(join(stateDir, MARKER_FILE), "utf8"));
  } catch {
    return `${stateDir} has no readable marker of the dev-gateway tool`;
  }
  if (marker?.createdBy !== CREATED_BY || marker.instance !== instance) {
    return `${stateDir}'s marker is not the dev-gateway tool's for instance ${instance}`;
  }
  if (marker.gatewayPid !== pid) {
    return `this process (${pid}) is not the gateway the tool started on ${instance} (${String(marker.gatewayPid)})`;
  }
  let real;
  try {
    real = realpathSync(here);
  } catch {
    return "the plugin cannot find its own file";
  }
  if (!real.startsWith(stateDir + sep)) {
    return `the plugin runs from ${real}, outside the instance's state folder`;
  }
  return null;
}
