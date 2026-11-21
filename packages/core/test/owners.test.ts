// Everything the host keeps outside its state is named in one registry
// (`owners.ts`) with its bound. These tests reflect over the live client, a
// viewer's bridge session and the waiting files, through their own
// properties and the values of every map, set and array they hold, and fail
// for any collection the registry does not name, any past its count, and any
// object of a class the walk does not know. They also drive the client with
// the inputs that grew private owners before (round 5's A8 reproductions).
// Collections a closure or a module keeps are found in source, in the desktop
// app's `owner-sources.test.ts`, which can read files.

import { describe, expect, it } from "vitest";
import { AttachmentStore } from "../src/attachments.ts";
import { createBridgeSession } from "../src/bridge.ts";
import { worstCase } from "../src/bounds.ts";
import { ClawtrateClient, MAX_FULL_READS } from "../src/client.ts";
import { MAX_PENDING_SAVES, MAX_SAVE_BYTES, PendingSaves } from "../src/files.ts";
import { INTERACTIVE_SCOPES } from "../src/scopes.ts";
import {
  ATTACHMENT_NOT_WALKED,
  ATTACHMENT_OWNERS,
  CLIENT_NOT_WALKED,
  CLIENT_OWNERS,
  CLIENT_PARTS,
  SAVE_OWNERS,
  VIEWER_NOT_WALKED,
  VIEWER_OWNERS,
  type Owner,
} from "../src/owners.ts";
import { APPROVAL, MAX_ID_CHARS, MAX_RUN_TEXT_CHARS, MAX_UNROUTED } from "../src/state-bounds.ts";
import { createStore, MAX_STORE_LISTENERS } from "../src/store.ts";
import { agentEvent, FAST, grantingGateway, KEY, openTask, URL_A } from "./client-harness.ts";
import { deferred, memoryStorage, sleep, testHost, tokenKey, until } from "./fake-gateway.ts";

type Found = { path: string; size: number | null; holder: string };

/** Classes whose instances the walk enters: the host's own. */
const WALKED = new Set([
  "ClawtrateClient",
  "ViewerSession",
  "AttachmentStore",
  "RawTable",
  "ChatTextBaselines",
  "ObservableStore",
  "FileTransfers",
  "PendingSaves",
  "AccountsEngine",
  "RoutinesEngine",
  "UsageEngine",
  "MachinesEngine",
  "WaitingIndex",
  "ComputerViews",
]);
/** Classes whose instances hold no collection of their own: handles. */
const HANDLES = new Set(["Promise", "Timeout", "Immediate"]);

/**
 * Every map, set, array, weak map and weak set reachable through own
 * properties and through the values of maps, sets and arrays, by path (`*`
 * for a value), with the class of the object holding it; and every object of
 * a class the walk does not know.
 */
function collections(
  root: object,
  owners: Record<string, Owner>,
  notWalked: Record<string, string>,
): { found: Found[]; unknown: string[] } {
  const found: Found[] = [];
  const unknown: string[] = [];
  const seen = new Set<object>();
  const className = (value: object) => Object.getPrototypeOf(value)?.constructor?.name ?? "null";
  const visit = (value: unknown, path: string, holder: string): void => {
    if (value === null || typeof value !== "object") return;
    if (path in notWalked || seen.has(value)) return;
    seen.add(value);
    const values = (items: Iterable<unknown>) => {
      if (owners[path]?.opaque) return;
      for (const item of items) visit(item, `${path}.*`, holder);
    };
    if (value instanceof Map) {
      found.push({ path, size: value.size, holder });
      values(value.values());
    } else if (value instanceof Set) {
      found.push({ path, size: value.size, holder });
      values(value.values());
    } else if (Array.isArray(value)) {
      found.push({ path, size: value.length, holder });
      values(value);
    } else if (value instanceof WeakMap || value instanceof WeakSet) {
      found.push({ path, size: null, holder });
    } else {
      const name = className(value);
      if (HANDLES.has(name)) return;
      if (name !== "Object" && name !== "null" && !WALKED.has(name)) {
        unknown.push(`${path} (${name})`);
        return;
      }
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string") continue;
        visit((value as Record<string, unknown>)[key], path ? `${path}.${key}` : key, name);
      }
    }
  };
  visit(root, "", className(root));
  return { found, unknown };
}

/** Fails for a collection the registry does not name, one past its count, or an unknown object. */
function expectRegistered(
  root: object,
  owners: Record<string, Owner>,
  notWalked: Record<string, string>,
): Found[] {
  const { found, unknown } = collections(root, owners, notWalked);
  expect(unknown, "objects of classes the walk does not know").toEqual([]);
  const unnamed = found.filter((each) => !(each.path in owners)).map((each) => each.path);
  expect([...new Set(unnamed)], "collections the registry does not name").toEqual([]);
  for (const each of found) {
    const owner = owners[each.path]!;
    if (owner.weak) expect(each.size, each.path).toBeNull();
    else expect(each.size, each.path).toBeLessThanOrEqual(owner.max);
  }
  // Each own field the registry names exists, held by the class it says.
  const paths = new Set(found.map((each) => each.path));
  for (const path of Object.keys(owners).filter((each) => !each.includes("*")))
    expect(paths.has(path), path).toBe(true);
  for (const each of found) {
    const part = each.path.split(".");
    if (part.length === 2 && CLIENT_PARTS[part[0]!])
      expect(each.holder).toBe(CLIENT_PARTS[part[0]!]);
  }
  return found;
}

const size = (value: unknown) => JSON.stringify(value).length;

describe("the registry of what the host keeps", () => {
  it("names every collection of a client in use, inside map values too, and each is within its count", async () => {
    const gateway = grantingGateway();
    const command = "c".repeat(10_000);
    gateway.handlers["exec.approval.list"] = () => [
      {
        id: "cut",
        request: { sessionKey: KEY, command, allowedDecisions: ["allow-once", "deny"] },
        createdAtMs: 1,
        expiresAtMs: 9e12,
      },
    ];
    const held = deferred<unknown>();
    gateway.handlers["sessions.create"] = () => held.promise;
    const { client, transcript } = await openTask({ gateway });
    const viewer = createBridgeSession(client);
    try {
      await viewer.apply({ type: "openSession", key: KEY });
      await until(() => transcript().approvals.length === 1);
      // Streams, runs, unrouted approvals, outcomes, foreign runs, spawn links, a whole read,
      // a creation with a caller joined, files kept for a message, and a recipient link.
      gateway.emit("chat", {
        sessionKey: KEY,
        runId: "streaming",
        seq: 1,
        state: "delta",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      });
      gateway.emit("exec.approval.requested", {
        id: "elsewhere",
        request: { sessionKey: "agent:otto:unopened", command: "ls" },
        createdAtMs: 1,
        expiresAtMs: 9e12,
      });
      gateway.emit("exec.approval.resolved", { id: "gone", decision: "deny" });
      gateway.emit(
        "agent",
        agentEvent("other", 1, "lifecycle", { phase: "start" }, "agent:otto:other"),
      );
      gateway.emit("agent", {
        ...agentEvent("helper", 1, "lifecycle", { phase: "start" }, "agent:otto:helper"),
        spawnedBy: KEY,
      });
      gateway.emit(
        "agent",
        agentEvent("streaming", 2, "tool", {
          phase: "result",
          name: "sessions_send",
          toolCallId: "send-1",
          isError: false,
          result: {
            content: [{ type: "text", text: "sent" }],
            details: { status: "ok", runId: "far-run", sessionKey: "agent:marlow:main" },
          },
        }),
      );
      await viewer.apply({ type: "readApprovalText", key: KEY, approvalId: "cut" });
      client.sendMessage(KEY, "hello", {
        attachments: [{ type: "file", mimeType: "text/plain", fileName: "a.txt", content: "aGk=" }],
      });
      const first = client.createTask("otto", "one").catch(() => {});
      const joined = client.createTask("otto", "one").catch(() => {});
      await until(() => client.state.unroutedApprovals.length === 1);
      await sleep(50);
      const found = expectRegistered(client, CLIENT_OWNERS, CLIENT_NOT_WALKED);
      // The walk reached inside map values.
      for (const path of [
        "recipients.*.runs",
        "approvalReads.*",
        "creationWaiters.*",
        "foreign.*.runs",
      ])
        expect(
          found.map((each) => each.path),
          path,
        ).toContain(path);
      expectRegistered(viewer, VIEWER_OWNERS, VIEWER_NOT_WALKED);
      held.resolve({ key: "agent:otto:made" });
      await Promise.all([first, joined]);
    } finally {
      viewer.dispose();
      client.stop();
    }
  });

  it("names the waiting files' collections", () => {
    const store = new AttachmentStore({ newId: () => "a" });
    expectRegistered(store, ATTACHMENT_OWNERS, ATTACHMENT_NOT_WALKED);
  });

  it("names the files waiting for a save dialog, full, and refuses one more", () => {
    const saves = new PendingSaves();
    for (let window = 1; window <= MAX_PENDING_SAVES; window += 1)
      saves.hold(window, new ArrayBuffer(MAX_SAVE_BYTES));
    expectRegistered(saves, SAVE_OWNERS, {});
    expect(() => saves.hold(MAX_PENDING_SAVES + 1, new ArrayBuffer(1))).toThrow(/waiting/);
    expect(saves.size).toBe(MAX_PENDING_SAVES);
  });

  it("fails for a collection added without a bound, as a field or inside a map's values", async () => {
    const { client } = await openTask();
    try {
      (client as unknown as { added: Map<string, string> }).added = new Map();
      (client as unknown as { recipients: Map<string, unknown> }).recipients.set("x", {
        runs: new Set(),
        sessions: new Set(),
        hidden: new Map(),
      });
      const { found } = collections(client, CLIENT_OWNERS, CLIENT_NOT_WALKED);
      expect(
        found.filter((each) => !(each.path in CLIENT_OWNERS)).map((each) => each.path),
      ).toEqual(
        ["recipients.*.hidden", "added"].sort((a, b) =>
          a === "added" ? 1 : b === "added" ? -1 : 0,
        ),
      );
    } finally {
      client.stop();
    }
  });

  it("finds an object of a class it does not know rather than pass over it", async () => {
    const { client } = await openTask();
    try {
      class Hidden {
        readonly kept = new Map([["a", "b"]]);
      }
      (client as unknown as { other: Hidden }).other = new Hidden();
      expect(collections(client, CLIENT_OWNERS, CLIENT_NOT_WALKED).unknown).toEqual([
        "other (Hidden)",
      ]);
    } finally {
      client.stop();
    }
  });

  it("sees the store's listeners, and refuses one past their count", async () => {
    const { client } = await openTask();
    const off: Array<() => void> = [];
    try {
      for (let i = 0; i < 5; i += 1) off.push(client.store.subscribe(() => {}));
      const { found } = collections(client, CLIENT_OWNERS, CLIENT_NOT_WALKED);
      expect(found.find((each) => each.path === "store.listeners")?.size).toBe(5);
      const store = createStore(0);
      for (let i = 0; i < MAX_STORE_LISTENERS; i += 1) store.subscribe(() => {});
      expect(() => store.subscribe(() => {})).toThrow(`${MAX_STORE_LISTENERS} listeners`);
      // A host passes `subscribe` on its own.
      const { subscribe } = createStore(1);
      const unsubscribe = subscribe(() => {});
      unsubscribe();
    } finally {
      off.forEach((each) => each());
      client.stop();
    }
  });
});

describe("private owners hold only what is bounded (A8)", () => {
  it("unrouted approvals keep the bounded card, not the one received", async () => {
    const { client, gateway, transcript } = await openTask();
    try {
      await until(() => transcript().approvalAccess === "ready");
      for (let i = 0; i < 16; i += 1) {
        gateway.emit("exec.approval.requested", {
          id: `u${i}`,
          request: { sessionKey: "agent:otto:unopened", command: `${i}:${"x".repeat(2_100_000)}` },
          createdAtMs: 1,
          expiresAtMs: 9e12,
        });
      }
      await until(() => client.state.unroutedApprovals.length === 16);
      const held = [...(client as unknown as { unrouted: Map<string, unknown> }).unrouted.values()];
      expect(size(held)).toBeLessThanOrEqual(MAX_UNROUTED * (worstCase(APPROVAL) + 1) + 2);
      // The very objects the state shows: nothing whole is kept beside them.
      expect(held).toEqual(client.state.unroutedApprovals);
      held.forEach((card, i) => expect(card).toBe(client.state.unroutedApprovals[i]));
    } finally {
      client.stop();
    }
  }, 30_000);

  it("stream baselines have a count per task and leave with their runs", async () => {
    const { client, gateway, transcript } = await openTask();
    const streams = () => (client as unknown as { streams: { size: number } }).streams.size;
    try {
      for (let i = 0; i < 100; i += 1) {
        gateway.emit("chat", {
          sessionKey: KEY,
          runId: `baseline-${i}`,
          seq: 1,
          state: "delta",
          message: { role: "assistant", content: [{ type: "text", text: "a".repeat(1000) }] },
        });
      }
      await until(() => transcript().runs.length === 32);
      expect(streams()).toBeLessThanOrEqual(2);
      // A run's lifecycle end, on the agent stream, retires its text.
      gateway.emit("agent", agentEvent("baseline-99", 2, "lifecycle", { phase: "end" }));
      await until(
        () => transcript().runs.find((run) => run.id === "baseline-99")?.state !== "running",
      );
      expect(streams()).toBeLessThanOrEqual(1);
    } finally {
      client.stop();
    }
  });

  it("a short reply cannot keep a large message beside it", async () => {
    const { client, gateway } = await openTask();
    const runs = () => [
      ...(client as unknown as { streams: { runs: Map<string, unknown> } }).streams.runs.values(),
    ];
    try {
      gateway.emit("chat", {
        sessionKey: KEY,
        runId: "extra",
        seq: 1,
        state: "delta",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "ok" },
            { type: "image", data: "y".repeat(1_000_000) },
          ],
          extra: "x".repeat(1_000_000),
        },
      });
      await until(() => runs().length === 1);
      expect(size(runs()[0])).toBeLessThanOrEqual(3 * MAX_ID_CHARS + MAX_RUN_TEXT_CHARS + 64);
      expect(runs()[0]).toMatchObject({ text: "ok" });
    } finally {
      client.stop();
    }
  });

  it("an appended delta builds on the text kept, and a resync starts again", async () => {
    const gateway = grantingGateway();
    const { client, transcript } = await openTask({ gateway });
    try {
      const delta = (seq: number, extra: Record<string, unknown>) =>
        gateway.emit("chat", { sessionKey: KEY, runId: "appended", seq, state: "delta", ...extra });
      delta(1, { message: { role: "assistant", content: [{ type: "text", text: "Hel" }] } });
      delta(2, { deltaText: "lo" });
      await until(() => transcript().runs[0]?.text === "Hello");
      delta(3, { deltaText: "!", replace: true });
      await until(() => transcript().runs[0]?.text === "!");
    } finally {
      client.stop();
    }
  });

  it("session pages are bounded as they arrive, not after they accumulate", async () => {
    const gateway = grantingGateway();
    let pages = 0;
    const page = (offset: number) => {
      pages += 1;
      return {
        sessions: Array.from({ length: 200 }, (_, i) => ({
          key: `agent:otto:page-${offset + i}`,
          agentId: "otto",
          updatedAt: offset + i,
          derivedTitle: "t".repeat(100_000),
          unrelated: "u".repeat(100_000),
        })),
        hasMore: offset < 2_000,
        nextOffset: offset + 200,
      };
    };
    gateway.handlers["sessions.subscribe"] = () => ({ list: page(0) });
    // The seventh page is held: the rows read so far are looked at while it waits.
    const later = deferred<void>();
    let seen: Array<Map<string, Record<string, unknown>>> = [];
    gateway.handlers["sessions.list"] = async (params) => {
      const offset = (params as { offset: number }).offset;
      if (offset === 1_200) {
        seen = [
          ...(client as unknown as { listings: Set<Map<string, Record<string, unknown>>> })
            .listings,
        ];
        await later.promise;
      }
      return page(offset);
    };
    const client = new ClawtrateClient(
      testHost(
        gateway,
        memoryStorage({
          connection: JSON.stringify({ url: URL_A, token: null }),
          [tokenKey(URL_A)]: JSON.stringify({
            token: "device-token",
            grantedScopes: INTERACTIVE_SCOPES,
            heldScopes: INTERACTIVE_SCOPES,
          }),
        }),
      ),
      FAST,
    );
    void client.start();
    await until(() => seen.length > 0);
    // Six pages, 1,200 rows of 200,000 characters each, have arrived; what is kept is already
    // the newest 500, only the fields read.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.size).toBeLessThanOrEqual(CLIENT_OWNERS.rows!.max);
    expect(size([...seen[0]!.values()])).toBeLessThanOrEqual(
      CLIENT_OWNERS["listings.*"]!.max * CLIENT_OWNERS["listings.*"]!.each,
    );
    for (const row of seen[0]!.values()) expect(row.unrelated).toBeUndefined();
    later.resolve();
    await until(() => client.state.discovery.status === "ready");
    try {
      expect(pages).toBeGreaterThan(5);
      const rows = (client as unknown as { rows: Map<string, Record<string, unknown>> }).rows;
      expect(rows.size).toBeLessThanOrEqual(CLIENT_OWNERS.rows!.max);
      for (const row of rows.values()) {
        expect(row.unrelated).toBeUndefined();
        expect(size(row)).toBeLessThanOrEqual(CLIENT_OWNERS.rows!.each);
      }
      // The newest are kept.
      expect(rows.has("agent:otto:page-2199")).toBe(true);
    } finally {
      client.stop();
    }
  }, 30_000);

  it("whole approval reads share the gate of the other whole reads", async () => {
    const gateway = grantingGateway();
    const record = {
      id: "large-ap",
      request: {
        sessionKey: KEY,
        command: "c".repeat(100_000),
        allowedDecisions: ["allow-once", "deny"],
      },
      createdAtMs: 1,
      expiresAtMs: 9e12,
    };
    gateway.handlers["exec.approval.list"] = () => [record];
    const { client, transcript } = await openTask({ gateway });
    const viewer = createBridgeSession(client);
    try {
      await viewer.apply({ type: "openSession", key: KEY });
      await until(() => transcript().approvals.length === 1);
      const before = gateway.calls("exec.approval.list").length;
      const reads = await Promise.allSettled(
        Array.from({ length: 16 }, () =>
          viewer.apply({ type: "readApprovalText", key: KEY, approvalId: "large-ap" }),
        ),
      );
      // The reviewer's sixteen simultaneous reads: at most `MAX_FULL_READS` lists are asked for.
      expect(gateway.calls("exec.approval.list").length - before).toBe(MAX_FULL_READS);
      expect(reads.filter((each) => each.status === "fulfilled")).toHaveLength(MAX_FULL_READS);
      for (const each of reads.filter((read) => read.status === "rejected"))
        expect(String((each as PromiseRejectedResult).reason)).toMatch(/being read/);
    } finally {
      viewer.dispose();
      client.stop();
    }
  });

  it("keys of the client's maps pass the id cap", async () => {
    const { client, gateway, transcript } = await openTask();
    try {
      await until(() => transcript().approvalAccess === "ready");
      const long = `agent:otto:${"k".repeat(5_000)}`;
      gateway.emit("agent", {
        ...agentEvent("far", 1, "lifecycle", { phase: "start" }, long),
        spawnedBy: long + "x",
      });
      gateway.emit("exec.approval.resolved", { id: "i".repeat(5_000), decision: "deny" });
      await sleep(50);
      const keysOf = (name: string) => [
        ...(client as unknown as Record<string, Map<string, unknown>>)[name]!.keys(),
      ];
      for (const name of ["foreign", "spawnedBy", "approvalOutcomes"]) {
        for (const key of keysOf(name))
          expect(JSON.stringify(key).length).toBeLessThanOrEqual(MAX_ID_CHARS);
      }
      for (const value of (
        client as unknown as { spawnedBy: Map<string, string> }
      ).spawnedBy.values())
        expect(JSON.stringify(value).length).toBeLessThanOrEqual(MAX_ID_CHARS);
      expect(() => client.openSession(long)).toThrow("too long");
    } finally {
      client.stop();
    }
  });
});
