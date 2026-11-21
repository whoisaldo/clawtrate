// Where a task's work runs and what it did there (`machine.ts`): three facts
// kept apart, each node's record read now, and the task's recent actions and
// commands from its steps (docs/design/work-pane.md, sections 16 and 19).

import { describe, expect, it } from "vitest";
import {
  approvalTarget,
  browserUse,
  commandRows,
  commandsRanOn,
  readMachine,
  recentActions,
} from "../src/machine.ts";
import { newRun, type Run, type Step } from "../src/runs.ts";
import type { ApprovalCard } from "../src/approvals.ts";
import type { Transcript } from "../src/types.ts";

function step(id: string, toolName: string, at: number, extra: Partial<Step> = {}): Step {
  return {
    id: `tool:${id}`,
    kind: "tool",
    title: toolName,
    toolName,
    toolCallId: id,
    status: "done",
    startedAt: at,
    endedAt: at + 1000,
    argsText: null,
    output: null,
    result: null,
    error: null,
    approvalId: null,
    failureKind: null,
    truncated: false,
    replaceable: false,
    correction: 0,
    continuation: null,
    raw: null,
    rawSize: null,
    ...extra,
  };
}

function transcript(key: string, runs: Run[], extra: Partial<Transcript> = {}) {
  return {
    sessionKey: key,
    runs,
    approvals: [] as ApprovalCard[],
    items: [],
    interSession: [],
    ...extra,
  } as unknown as Transcript;
}

const run = (id: string, steps: Step[], startedAt = 1000) => {
  const r = newRun(id, { state: "completed", origin: "history", bound: true }, startedAt);
  r.steps = steps;
  r.startedAt = startedAt;
  return r;
};

const exec = (
  host: string | null,
  nodeId: string | null,
  createdAt: number,
  status: ApprovalCard["status"],
) => ({ kind: "exec", status, createdAt, exec: { host, nodeId } }) as unknown as ApprovalCard;

describe("the machine (F-147, section 16)", () => {
  it("F-147: the approval target is the latest exec approval's proposal, with its time and status; none is Not reported", () => {
    expect(approvalTarget(transcript("agent:otto:t", []))).toBeNull();
    const t = transcript("agent:otto:t", [], {
      approvals: [exec("gateway", null, 100, "denied"), exec("node", "media-box", 200, "allowed")],
    });
    expect(approvalTarget(t)).toEqual({
      host: "node",
      nodeId: "media-box",
      requestedAt: 200,
      status: "allowed",
    });
  });

  it("F-147: Commands ran on only from a command's own result that names its node and an exit code", () => {
    const none = transcript("agent:otto:t", [
      run("r1", [
        step("a", "exec", 100, { details: { exitCode: 0 } }),
        step("b", "exec", 200, { details: { nodeId: "media-box" } }),
      ]),
    ]);
    expect(commandsRanOn(none)).toBeNull();
    const ran = transcript("agent:otto:t", [
      run("r1", [step("c", "exec", 300, { details: { exitCode: 1, nodeId: "media-box" } })]),
    ]);
    expect(commandsRanOn(ran)).toEqual({ nodeId: "media-box", at: 1300 });
  });

  it("F-147: the bot's setting as the gateway reads it: its own over every bot's; unset and auto are kept as not resolved, never as the gateway's machine", async () => {
    const read = (config: unknown) =>
      readMachine(
        async (method) => (method === "config.get" ? { config } : { nodes: [] }),
        "pip",
        [],
        1,
      ).then((facts) => facts.setting);
    // Nothing stored anywhere: not set, the gateway chooses for each command.
    expect(await read({})).toMatchObject({ host: null, nodeSelector: null });
    expect(await read({ tools: { exec: { host: "auto" } } })).toMatchObject({
      host: "auto",
      inherited: true,
    });
    // A node host with no node named stays that: no machine.
    expect(
      await read({ agents: { entries: { pip: { tools: { exec: { host: "node" } } } } } }),
    ).toMatchObject({ host: "node", nodeSelector: null, inherited: false });
    // Host and node are read apart, as the gateway reads them: the bot's node over every bot's.
    expect(
      await read({
        tools: { exec: { host: "gateway", node: "rack-1" } },
        agents: { entries: { pip: { tools: { exec: { node: "media-box" } } } } },
      }),
    ).toMatchObject({ host: "gateway", inherited: true, nodeSelector: "media-box" });
    // `agents.defaults` is not where the gateway reads it from.
    expect(
      await read({ agents: { defaults: { tools: { exec: { host: "gateway" } } } } }),
    ).toMatchObject({ host: null });
  });

  it("F-148 F-150: a node's record says Connected or Not connected with when it was last seen; a list that couldn't be read is unknown, never Not connected", async () => {
    const answers: Record<string, unknown> = {
      "config.get": {
        config: {
          agents: {
            entries: {
              otto: { tools: { exec: { host: "node", node: "media-box" } } },
              // A node with no host: not set to run there (the gateway chooses).
              pip: { tools: { exec: { node: "media-box" } } },
              juniper: { tools: { exec: { host: "node", node: "media-box" } } },
            },
          },
        },
      },
      "node.list": {
        nodes: [
          {
            nodeId: "media-box",
            displayName: "media-box",
            connected: false,
            lastSeenAtMs: 5_000,
            lastSeenReason: "while going to sleep",
            hostStats: {
              cpuCount: 4,
              loadAverage: [0.6, 0.5, 0.4],
              memoryTotalBytes: 8,
              memoryFreeBytes: 3,
              updatedAtMs: 4_000,
            },
          },
        ],
      },
      "computer.status": { configured: false, available: false },
    };
    const request = async (method: string) => answers[method];
    const facts = await readMachine(request, "otto", [], 10_000);
    expect(facts.setting).toMatchObject({
      host: "node",
      nodeSelector: "media-box",
      inherited: false,
    });
    expect(facts.nodes["media-box"]).toMatchObject({
      connected: false,
      lastSeenAtMs: 5_000,
      lastSeenReason: "while going to sleep",
      stats: { cpuCount: 4, loadAverage: 0.6, diskTotalBytes: null },
    });
    expect(facts.sharedWith).toEqual({ "media-box": ["juniper"] });
    expect(facts.desktop).toBeNull();

    const failing = async (method: string) => {
      if (method === "node.list") throw new Error("unavailable");
      return answers[method];
    };
    expect((await readMachine(failing, "otto", [], 10_000)).nodes["media-box"]).toBe("unknown");
    const unlisted = async (method: string) =>
      method === "node.list" ? { nodes: [] } : answers[method];
    expect((await readMachine(unlisted, "otto", [], 10_000)).nodes["media-box"]).toBe("not-listed");
  });

  it("F-148: a node is matched by its id first; a name is used only when no id matches and one node has it", async () => {
    const node = (nodeId: string, displayName: string, connected: boolean) => ({
      nodeId,
      displayName,
      connected,
    });
    const listing = (nodes: unknown[]) => async (method: string) =>
      method === "node.list" ? { nodes } : method === "config.get" ? { config: {} } : {};
    // An offline node named like the connected node's id comes first in the list.
    const named = await readMachine(
      listing([node("old-box", "media-box", false), node("media-box", "Media box", true)]),
      "otto",
      ["media-box"],
      10_000,
    );
    expect(named.nodes["media-box"]).toMatchObject({ nodeId: "media-box", connected: true });
    const byName = await readMachine(
      listing([node("n-1", "attic", true)]),
      "otto",
      ["attic"],
      10_000,
    );
    expect(byName.nodes["attic"]).toMatchObject({ nodeId: "n-1" });
    const shared = await readMachine(
      listing([node("n-1", "attic", true), node("n-2", "attic", false)]),
      "otto",
      ["attic"],
      10_000,
    );
    expect(shared.nodes["attic"]).toBe("not-listed");
  });

  it("F-150: the gateway's own desktop is read without preparing it, and named only when it is configured", async () => {
    const asked: unknown[] = [];
    const request = async (method: string, params: unknown) => {
      if (method === "computer.status") asked.push(params);
      return method === "computer.status"
        ? { configured: true, available: false, error: "no display" }
        : {};
    };
    const facts = await readMachine(request, "otto", [], 1);
    expect(asked).toEqual([{ probe: false }]);
    expect(facts.desktop).toEqual({ available: false, error: "no display" });
  });
});

describe("recent actions and commands (F-153, F-154, F-139)", () => {
  const steps = [
    step("w1", "browser", 1_000),
    step("x1", "exec", 2_000, {
      args: { command: "du -sh /var/lib/*\nmore" },
      details: { exitCode: 0, durationMs: 6200 },
    }),
    step("x2", "exec", 3_000, { args: { command: "sleep 100" }, status: "running", endedAt: null }),
    step("x3", "exec", 4_000, {
      args: { command: "make" },
      failureKind: "overall-timeout",
      details: { exitCode: 124 },
    }),
    step("r1", "read", 5_000),
  ];

  it("F-153: lists each command the bot ran in the task, one line, how it ended and how long it took, newest first", () => {
    expect(commandRows(transcript("agent:otto:t", [run("r", steps)]))).toEqual([
      {
        stepId: "tool:x3",
        command: "make",
        end: { kind: "timed-out" },
        durationMs: 1000,
        running: false,
      },
      { stepId: "tool:x2", command: "sleep 100", end: null, durationMs: null, running: true },
      {
        stepId: "tool:x1",
        command: "du -sh /var/lib/*",
        end: { kind: "exit", code: 0 },
        durationMs: 6200,
        running: false,
      },
    ]);
  });

  it("F-154: lists the task's browser and command actions newest first, a routine's run marked by its key, the person's own run unlabelled", () => {
    const title = (s: Step) => s.toolName ?? "";
    const own = recentActions(transcript("agent:otto:t", [run("r", steps)]), title);
    expect(own.map((a) => a.stepId)).toEqual(["tool:x3", "tool:x2", "tool:x1", "tool:w1"]);
    expect(own.every((a) => a.trigger === null)).toBe(true);
    expect(own[1]!.running).toBe(true);
    const routine = recentActions(
      transcript("agent:otto:cron:job-1:run:abc", [run("r", steps)]),
      title,
    );
    expect(routine.every((a) => a.trigger?.kind === "routine")).toBe(true);
  });

  it("F-154: a run carries another bot only through the message it belongs under; with nothing tying them, the trigger is blank", () => {
    const marlow = {
      itemId: "item-1",
      text: "plan it",
      sourceSessionKey: "agent:marlow:main",
      sourceTool: "sessions_send",
      senderLabel: "Marlow",
      senderAgentId: "marlow",
      timestamp: 1_400,
    };
    const items = [
      { id: "item-1", role: "user" as const, timestamp: 1_400, blocks: [], model: null },
    ];
    // Tied: the run belongs under Marlow's message (the gateway's `${runId}:user` key named it).
    const tied = run("r", [step("w2", "browser", 2_000)], 1_500);
    tied.anchorItemId = "item-1";
    expect(
      recentActions(
        transcript("agent:pip:main", [tied], { items, interSession: [marlow] }),
        () => "x",
      )[0]!.trigger,
    ).toEqual({ kind: "bot", name: "Marlow" });
    // Not tied: a retry, or a run started another way, after Marlow's message is not Marlow's.
    const after = run("r2", [step("w3", "browser", 2_000)], 1_500);
    expect(
      recentActions(
        transcript("agent:pip:main", [after], { items, interSession: [marlow] }),
        () => "x",
      )[0]!.trigger,
    ).toBeNull();
    // Tied to the person's own message: no trigger.
    const own = run("r3", [step("w4", "browser", 2_000)], 1_500);
    own.anchorItemId = "item-2";
    expect(
      recentActions(
        transcript("agent:pip:main", [own], { items, interSession: [marlow] }),
        () => "x",
      )[0]!.trigger,
    ).toBeNull();
  });

  it("F-139: the computer button shows once the task used the browser tool, and its dot while a browser call runs", () => {
    expect(browserUse(undefined)).toEqual({ used: false, active: false });
    expect(browserUse(transcript("k", [run("r", [step("e", "exec", 1)])]))).toEqual({
      used: false,
      active: false,
    });
    expect(browserUse(transcript("k", [run("r", [step("b", "browser", 1)])]))).toEqual({
      used: true,
      active: false,
    });
    expect(
      browserUse(
        transcript("k", [
          run("r", [step("b", "browser", 1, { status: "running", endedAt: null })]),
        ]),
      ),
    ).toEqual({ used: true, active: true });
  });
});
