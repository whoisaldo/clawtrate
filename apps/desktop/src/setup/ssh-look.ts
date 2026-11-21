// What the LOOK over SSH found, as the found card says it (docs/design/setup.md
// §6): the same results as on this computer, from the facts the LOOK checked
// (`apps/desktop/src/main/ssh/look.ts`), and nothing the facts don't carry.
// The LOOK reports no auth mode, so the card claims none, and it reports no
// other services, so it names none.

import {
  OLDEST_OPENCLAW_VERSION,
  TESTED_OPENCLAW_VERSION,
  type LookService,
  type SetupLook,
} from "@clawtrate/core";

import {
  provenStopped,
  serviceOnPort,
  type FoundService,
  type GatewayStatus,
  type LookFacts,
  type ProgramPlace,
  type Version,
} from "../main/ssh/look.ts";

export type SshLook = {
  look: SetupLook;
  /** For `running`: the service Connect forwards to and pairs with. */
  found: FoundService | null;
  /** For `stopped`: the gateway Start may start, proven stopped. */
  stopped: {
    profile: "default" | "clawtrate";
    port: number;
    label: GatewayStatus["service"];
    /** The stopped service's configuration file, as its status named it: Start starts that one. */
    configPath: string;
  } | null;
  program: ProgramPlace | null;
  /** The program file's checksum, which CODE and START check before they run it. */
  programSum: string | null;
};

const versionText = (v: Version) => `${v.year}.${v.month}.${v.day}`;
const parts = (text: string) => text.split(".").map(Number) as [number, number, number];
const compare = (a: [number, number, number], b: [number, number, number]) =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

function serviceWord(status: GatewayStatus): LookService | null {
  const service = status.service;
  if (!service) return null;
  const stopped = service.running === false;
  if (service.label === "LaunchAgent") return stopped ? "launchagent-stopped" : "launchagent";
  if (service.label === "systemd user") return stopped ? "systemd-user-stopped" : "systemd-user";
  if (service.label === "systemd") return stopped ? "systemd-stopped" : "systemd";
  return null;
}

const empty = (outcome: SetupLook["outcome"], reason: SetupLook["reason"] = null): SetupLook => ({
  outcome,
  reason,
  version: null,
  profile: null,
  listens: null,
  service: null,
  port: null,
  authMode: null,
  access: null,
  others: [],
});

/** The found card's result from the LOOK's facts, and what Connect or Start would act on. */
export function sshLook(facts: LookFacts): SshLook {
  const program = facts.program;
  const none = { found: null, stopped: null, program, programSum: facts.programSum };
  if (!program) {
    const signs = facts.signs;
    const seen =
      signs.defaultState || signs.defaultService || signs.clawtrateState || signs.clawtrateService;
    return { look: empty(seen ? "program-missing" : "not-found"), ...none };
  }
  if (facts.version === "unreadable" || facts.version === null || facts.programSum === null)
    return { look: empty("cant-tell", "shape"), ...none };
  // The default profile first, then Clawtrate's own: the only two the look covers.
  const statuses = facts.gateways.filter(
    (gateway): gateway is GatewayStatus => !("unreadable" in gateway),
  );
  if (statuses.length !== facts.gateways.length)
    return { look: empty("cant-tell", "shape"), ...none };
  const ordered = ["default", "clawtrate"].flatMap((profile) =>
    statuses.filter((status) => status.profile === profile),
  );
  let unsure = false;
  /** A gateway answering, but not on its loopback endpoint as far as the status shows. */
  let offLoopback = false;
  for (const status of ordered) {
    if (status.port === null) continue;
    // This profile's own status: another profile's on the same port says nothing of this one.
    const found = serviceOnPort(facts, status.port, status.profile);
    if (!found.ok) {
      if (found.reason === "cant-tell") unsure = true;
      if (found.reason === "endpoint") offLoopback = true;
      continue;
    }
    if (found.service.profile !== status.profile) continue;
    const version = status.version ? versionText(status.version) : null;
    if (version === null) return { look: empty("cant-tell", "no-answer"), ...none };
    const outcome =
      version === TESTED_OPENCLAW_VERSION
        ? "running"
        : compare(parts(version), parts(OLDEST_OPENCLAW_VERSION)) < 0
          ? "too-old"
          : "untested";
    return {
      look: {
        ...empty(outcome),
        version,
        profile: status.profile,
        listens:
          status.bindMode === "loopback" ? "loopback" : status.bindMode === "lan" ? "lan" : null,
        service: serviceWord(status),
        port: status.port,
      },
      found: outcome === "running" ? found : null,
      stopped: null,
      program,
      programSum: facts.programSum,
    };
  }
  // A gateway that answered somewhere other than its loopback endpoint: not offered (§6, "endpoint").
  if (offLoopback) return { look: empty("cant-tell", "endpoint"), ...none };
  // The results disagree, or say too little: running or not can't be told.
  if (unsure) return { look: empty("cant-tell", "contradictory"), ...none };
  for (const status of ordered) {
    if (!provenStopped(status, facts.version)) continue;
    return {
      look: {
        ...empty("stopped"),
        version: versionText(facts.version),
        profile: status.profile,
        service: serviceWord(status),
        port: status.port,
      },
      found: null,
      stopped: {
        profile: status.profile,
        port: status.port!,
        label: status.service,
        configPath: status.configPath!,
      },
      program,
      programSum: facts.programSum,
    };
  }
  // A program and no gateway the look could resolve: its configuration missing, or not answering.
  const configured = ordered.some((status) => status.configPath !== null);
  return {
    look: empty("cant-tell", configured ? "contradictory" : "not-set-up"),
    ...none,
  };
}
