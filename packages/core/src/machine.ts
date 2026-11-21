// What the Computer tab says about where a task's work runs, and what it did
// there (docs/design/work-pane.md, sections 16 and 19): three facts kept apart
// (the target an approval proposed, the machine a command's own result names,
// and the bot's setting), each node's record read now, and the task's recent
// actions and commands from its steps. Nothing here is kept in the state:
// `readMachine` reads the gateway and returns; the rest are views over a
// transcript.

import { readCommandPlace, readNodes, type CommandPlace } from "./machines.ts";
import { asRecord } from "./mapping.ts";
import type { Run, Step } from "./runs.ts";
import type { Transcript } from "./types.ts";

// Evidence in the task ----------------------------------------------------------------------

/** The latest exec approval request in the task: a proposed target, not where anything ran. */
export type ApprovalTarget = {
  host: string | null;
  nodeId: string | null;
  requestedAt: number | null;
  status: "pending" | "allowed" | "denied" | "expired" | "cancelled" | "closed";
};

export function approvalTarget(transcript: Pick<Transcript, "approvals">): ApprovalTarget | null {
  let latest: ApprovalTarget | null = null;
  let at = -Infinity;
  for (const card of transcript.approvals) {
    if (card.kind !== "exec" || !card.exec) continue;
    const when = card.createdAt ?? 0;
    if (when < at) continue;
    at = when;
    latest = {
      host: card.exec.host,
      nodeId: card.exec.nodeId,
      requestedAt: card.createdAt,
      status: card.status,
    };
  }
  return latest;
}

const isCommand = (step: Step) =>
  step.toolName === "exec" || step.toolName === "bash" || step.commandBearing === true;

/** The latest command whose own result names the node it ran on, with its exit code. */
export function commandsRanOn(
  transcript: Pick<Transcript, "runs">,
): { nodeId: string; at: number | null } | null {
  let found: { nodeId: string; at: number | null } | null = null;
  let at = -Infinity;
  for (const run of transcript.runs) {
    for (const step of run.steps) {
      if (!isCommand(step)) continue;
      const nodeId = step.details?.nodeId;
      if (typeof nodeId !== "string" || typeof step.details?.exitCode !== "number") continue;
      const when = step.endedAt ?? step.startedAt ?? 0;
      if (when < at) continue;
      at = when;
      found = { nodeId, at: step.endedAt ?? step.startedAt };
    }
  }
  return found;
}

// Recent actions and commands ---------------------------------------------------------------

export type RecentAction = {
  stepId: string;
  at: number | null;
  kind: "web" | "command";
  title: string;
  running: boolean;
  /** What started the run, when the gateway establishes it; null for the person's own message. */
  trigger: { kind: "routine" } | { kind: "bot"; name: string } | null;
};

const isBrowser = (step: Step) => step.toolName === "browser";

/** Whether the task used the browser tool, and whether a browser call is running now (F-139). */
export function browserUse(transcript: Pick<Transcript, "runs"> | undefined): {
  used: boolean;
  active: boolean;
} {
  let used = false;
  let active = false;
  for (const run of transcript?.runs ?? []) {
    for (const step of run.steps) {
      if (!isBrowser(step)) continue;
      used = true;
      if (step.status === "running" || step.status === "waiting") active = true;
    }
  }
  return { used, active };
}

/**
 * A run's trigger, only where something ties it to that run: a routine by the task's own key
 * (every run of a routine's task is the routine's), and another bot by the message the run
 * belongs under (`Run.anchorItemId`, which the gateway's key for the message names). With no
 * such tie it is blank, never the last message before the run.
 */
function triggerOf(
  key: string,
  run: Run,
  transcript: Pick<Transcript, "interSession">,
): RecentAction["trigger"] {
  if (/:cron:[^:]+:run:/.test(key)) return { kind: "routine" };
  if (!run.anchorItemId) return null;
  const message = transcript.interSession.find((each) => each.itemId === run.anchorItemId);
  if (!message) return null;
  const name = message.senderLabel ?? message.senderAgentId;
  return name ? { kind: "bot", name } : null;
}

/** The task's browser and command actions, newest first. */
export function recentActions(
  transcript: Pick<Transcript, "runs" | "interSession" | "sessionKey">,
  title: (step: Step, run: Run) => string,
): RecentAction[] {
  const out: RecentAction[] = [];
  for (const run of transcript.runs) {
    const trigger = triggerOf(transcript.sessionKey, run, transcript);
    for (const step of run.steps) {
      const web = isBrowser(step);
      if (!web && !isCommand(step)) continue;
      out.push({
        stepId: step.id,
        at: step.startedAt ?? step.endedAt,
        kind: web ? "web" : "command",
        title: title(step, run),
        running: step.status === "running" || step.status === "waiting",
        trigger,
      });
    }
  }
  return out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

export type CommandRow = {
  stepId: string;
  command: string;
  /** "exit 0", "Timed out", or null while it runs or when nothing says. */
  end: { kind: "exit"; code: number } | { kind: "timed-out" } | null;
  durationMs: number | null;
  running: boolean;
};

/** The commands the bot ran in this task, newest first (F-153). */
export function commandRows(transcript: Pick<Transcript, "runs">): CommandRow[] {
  const out: Array<CommandRow & { at: number }> = [];
  for (const run of transcript.runs) {
    for (const step of run.steps) {
      if (!isCommand(step)) continue;
      const command = typeof step.args?.command === "string" ? step.args.command : null;
      if (!command) continue;
      const d = step.details ?? {};
      const exit = typeof d.exitCode === "number" ? d.exitCode : null;
      const timedOut = d.timedOut === true || step.failureKind === "overall-timeout";
      const duration =
        typeof d.durationMs === "number"
          ? d.durationMs
          : step.startedAt !== null && step.endedAt !== null && !step.rowTimes
            ? step.endedAt - step.startedAt
            : null;
      out.push({
        stepId: step.id,
        command: command.split("\n")[0]!,
        end: timedOut ? { kind: "timed-out" } : exit !== null ? { kind: "exit", code: exit } : null,
        durationMs: duration,
        running: step.status === "running" || step.status === "waiting",
        at: step.startedAt ?? step.endedAt ?? 0,
      });
    }
  }
  return out.sort((a, b) => b.at - a.at).map(({ at: _at, ...row }) => row);
}

// The gateway's records, read now ----------------------------------------------------------

export type NodeStats = {
  cpuCount: number | null;
  loadAverage: number | null;
  memoryTotalBytes: number | null;
  memoryFreeBytes: number | null;
  diskTotalBytes: number | null;
  diskAvailableBytes: number | null;
  updatedAtMs: number | null;
};

export type NodeRecord = {
  nodeId: string;
  name: string | null;
  connected: boolean;
  lastSeenAtMs: number | null;
  lastSeenReason: string | null;
  stats: NodeStats | null;
};

export type MachineFacts = {
  /**
   * Where the bot's commands are set to run, as the gateway reads its settings
   * (`readCommandPlace`): the bot's own over every bot's; null when unreadable.
   * Unset and `auto` are not resolved: the gateway chooses for each command.
   */
  setting: CommandPlace | null;
  /**
   * Each node named by the setting or the evidence: its record; `unknown`
   * when the list couldn't be read (never "not connected"); `not-listed` when
   * the gateway's list does not hold it.
   */
  nodes: Record<string, NodeRecord | "unknown" | "not-listed">;
  /** Other bots set to run commands on each named node, by node. */
  sharedWith: Record<string, string[]>;
  /** The gateway's own desktop (`computer.status {probe: false}`), when it has one configured. */
  desktop: { available: boolean; error: string | null } | null;
  readAt: number;
};

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const text = (value: unknown, max = 256): string | null =>
  typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;

export function nodeRecord(raw: unknown): NodeRecord | null {
  const r = asRecord(raw);
  const nodeId = text(r?.nodeId) ?? text(r?.id);
  if (!r || !nodeId) return null;
  const s = asRecord(r.hostStats);
  return {
    nodeId,
    name: text(r.displayName) ?? text(r.name),
    connected: r.connected === true,
    lastSeenAtMs: num(r.lastSeenAtMs),
    lastSeenReason: text(r.lastSeenReason),
    stats: s
      ? {
          cpuCount: num(s.cpuCount),
          loadAverage: Array.isArray(s.loadAverage) ? num(s.loadAverage[0]) : num(s.loadAverage),
          memoryTotalBytes: num(s.memoryTotalBytes),
          memoryFreeBytes: num(s.memoryFreeBytes),
          diskTotalBytes: num(s.diskTotalBytes),
          diskAvailableBytes: num(s.diskAvailableBytes),
          updatedAtMs: num(s.updatedAtMs),
        }
      : null,
  };
}

/**
 * Read where the bot's commands are set to run, the records of the nodes the
 * setting and the task's evidence name, and the gateway's own desktop. All
 * `operator.read`. A read that fails leaves its part null: never "not connected".
 */
export async function readMachine(
  request: (method: string, params: unknown) => Promise<unknown>,
  botId: string,
  named: string[],
  now: number,
): Promise<MachineFacts> {
  const [config, nodes, desktop] = await Promise.allSettled([
    request("config.get", {}),
    request("node.list", {}),
    request("computer.status", { probe: false }),
  ]);
  let setting: MachineFacts["setting"] = null;
  const sharedWith: Record<string, string[]> = {};
  if (config.status === "fulfilled") {
    const root = asRecord(asRecord(config.value)?.config) ?? {};
    const machines = nodes.status === "fulfilled" ? readNodes(nodes.value).nodes : [];
    setting = readCommandPlace(root, botId, machines);
    // Other bots whose stored setting names the same node: a setting, not where they ran.
    const entries = asRecord(asRecord(root.agents)?.entries) ?? {};
    for (const id of Object.keys(entries).slice(0, 64)) {
      if (id === botId) continue;
      const place = readCommandPlace(root, id, machines);
      if (place.host === "node" && place.nodeSelector)
        (sharedWith[place.nodeSelector] ??= []).push(id);
    }
  }
  const wanted = new Set(named.filter(Boolean));
  if (setting?.nodeSelector) wanted.add(setting.nodeSelector);
  const records: MachineFacts["nodes"] = {};
  const listed =
    nodes.status === "fulfilled"
      ? (Array.isArray(asRecord(nodes.value)?.nodes)
          ? (asRecord(nodes.value)!.nodes as unknown[])
          : []
        )
          .map(nodeRecord)
          .filter((each): each is NodeRecord => each !== null)
      : null;
  // By id first: a name only when no node has that id and exactly one node has that name.
  const byName = (id: string) => {
    const matches = listed!.filter((n) => n.name === id);
    return matches.length === 1 ? matches[0] : undefined;
  };
  for (const id of [...wanted].slice(0, 8)) {
    records[id] = listed
      ? (listed.find((n) => n.nodeId === id) ?? byName(id) ?? "not-listed")
      : "unknown";
  }
  const d = desktop.status === "fulfilled" ? asRecord(desktop.value) : null;
  return {
    setting,
    nodes: records,
    sharedWith,
    desktop:
      d?.configured === true
        ? { available: d.available === true, error: text(d.error, 512) }
        : null,
    readAt: now,
  };
}
