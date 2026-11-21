// Whether a checkout may treat an instance's gateway as its development
// gateway, for example to open it without an access token. Two files agreeing
// is not enough: the instance's folder must be the tool's own, its marker valid
// and naming the instance, the marker's run id, instance and checkout must
// agree with this checkout's run file and connection file, the port must be
// the instance's, and the recorded gateway must be the live process the tool
// spawned. Hosts call this when they connect and again before every reconnect.

import { join } from "node:path";
import { DEFAULT_GATEWAY_PORT, stateDirFor, validateInstanceName } from "./instance.ts";
import {
  markerProblems,
  ownership,
  processIdentity,
  processState,
  readJsonFile,
  readMarker,
  readRunRecord,
  runMatches,
  type Identify,
} from "./state-guard.ts";

export type ProvenEndpoint = { url: string; token: string; instance: string | null };

export function provenEndpoint(options: {
  instance: string | null;
  home: string;
  /** This checkout's run folder for the instance. */
  runDir: string;
  /** This checkout, as the tool records it (a real path). */
  checkout: string;
  identify?: Identify;
  /** If set, prove the same run for the life of an operation. */
  expectedRunId?: string;
}): ProvenEndpoint | { refusal: string } {
  const instance = options.instance === null ? null : validateInstanceName(options.instance);
  const stateDir = stateDirFor(instance, options.home);
  if (ownership(stateDir) !== "owned") {
    return { refusal: `${stateDir} is not a state folder this tool created` };
  }
  const marker = readMarker(stateDir)!;
  const problems = markerProblems(marker, instance);
  if (problems.length > 0)
    return { refusal: `its marker cannot be trusted: ${problems.join("; ")}` };
  const run = readRunRecord(join(options.runDir, "state.json"));
  if (!runMatches(run, marker, instance, options.checkout)) {
    return { refusal: "this checkout's run file does not match the instance's current run" };
  }
  if (options.expectedRunId !== undefined && run!.runId !== options.expectedRunId) {
    return { refusal: "the instance restarted during this operation" };
  }
  const port = instance === null ? DEFAULT_GATEWAY_PORT : marker.gatewayPort;
  if (run!.gatewayPort !== port) return { refusal: "the recorded gateway ports disagree" };
  const gateway = processState(
    marker.gatewayPid,
    marker.gatewayIdentity,
    options.identify ?? processIdentity,
  );
  if (gateway !== "alive")
    return { refusal: "the gateway recorded for the instance is not running" };
  const url = `ws://127.0.0.1:${port}`;
  const connection = readJsonFile(join(options.runDir, "connection.json"));
  if (
    !connection ||
    connection.url !== url ||
    (connection.instance ?? null) !== instance ||
    connection.runId !== run!.runId ||
    typeof connection.token !== "string" ||
    connection.token === ""
  ) {
    return { refusal: "the connection file does not match the instance's current run" };
  }
  return { url, token: connection.token, instance };
}
