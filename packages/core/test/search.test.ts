import { describe, expect, it } from "vitest";
import { parseBridgeCommand } from "../src/bridge.ts";
import {
  MAX_FILE_HITS,
  MAX_SEARCH_QUERY_CHARS,
  readRoutineSearch,
  searchFiles,
  searchMessages,
  searchRoutines,
} from "../src/search.ts";

function gateway(answers: Record<string, unknown>) {
  const asked: Array<{ method: string; params: unknown }> = [];
  const request = async (method: string, params: unknown) => {
    asked.push({ method, params });
    const answer = answers[method];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { asked, request };
}

describe("searchMessages", () => {
  it("asks with the task list's filters and 25, and keeps the reply's own coverage facts", async () => {
    const { asked, request } = gateway({
      "sessions.search": {
        results: [
          {
            sessionKey: "agent:otto:disk-space",
            sessionId: "s-1",
            messageId: "m-1",
            role: "user",
            timestamp: 5,
            snippet: "Yes, clear the <em>transcode</em> cache.",
            score: 2,
          },
          // A row whose message id is missing cannot be opened, so it is not a result.
          { sessionKey: "agent:otto:disk-space", role: "assistant", snippet: "x" },
          { sessionKey: "global", messageId: "m-2", role: "user", snippet: "no bot" },
        ],
        sessions: [
          { key: "agent:otto:disk-space", label: "Disk almost full" },
          { key: "agent:pip:other", label: "Not matched" },
        ],
        truncated: true,
        indexing: true,
        archivedTranscriptsExcluded: 4,
      },
    });
    const found = await searchMessages(request, "transcode", null);
    expect(asked).toEqual([
      {
        method: "sessions.search",
        params: {
          query: "transcode",
          scope: { excludeCron: true, excludeSubagents: true },
          limit: 25,
        },
      },
    ]);
    expect(found).toEqual({
      hits: [
        {
          sessionKey: "agent:otto:disk-space",
          sessionId: "s-1",
          messageId: "m-1",
          botId: "otto",
          role: "user",
          timestamp: 5,
          snippet: "Yes, clear the <em>transcode</em> cache.",
        },
      ],
      titles: { "agent:otto:disk-space": "Disk almost full" },
      truncated: true,
      indexing: true,
      archivedExcluded: 4,
    });
    await searchMessages(request, "backup", "pip");
    expect(asked[1]!.params).toEqual({
      query: "backup",
      scope: { excludeCron: true, excludeSubagents: true, agentId: "pip" },
      limit: 25,
    });
  });
});

describe("searchRoutines", () => {
  it("asks for routines on or off, 50 at a time, and keeps the page's revision", async () => {
    const { asked, request } = gateway({
      "cron.list": {
        jobs: [
          { id: "cleanup", name: "Inbox tidy-up", agentId: "pip", enabled: false },
          { id: "digest", name: "Morning digest", agentId: "main", description: "Weekdays" },
          { name: "No id", agentId: "pip" },
        ],
        total: 63,
        hasMore: true,
        nextOffset: 50,
        snapshotRevision: 7,
      },
    });
    const page = await searchRoutines(request, "e", 0);
    expect(asked[0]).toEqual({
      method: "cron.list",
      params: { query: "e", enabled: "all", limit: 50, offset: 0 },
    });
    expect(page).toEqual({
      offset: 0,
      routines: [
        { id: "cleanup", name: "Inbox tidy-up", description: "", botId: "pip", enabled: false },
        {
          id: "digest",
          name: "Morning digest",
          description: "Weekdays",
          botId: "main",
          enabled: true,
        },
      ],
      total: 63,
      hasMore: true,
      nextOffset: 50,
      revision: "7",
    });
  });

  it("names a routine's bot as the Routines view does when the job has no agentId", () => {
    const page = readRoutineSearch(
      {
        jobs: [
          { id: "nightly", name: "Nightly", effectiveAgentId: "otto" },
          { id: "stretch", name: "Stretch break" },
        ],
      },
      0,
    );
    expect(page.routines.map((each) => [each.id, each.botId])).toEqual([
      ["nightly", "otto"],
      ["stretch", "main"],
    ]);
  });

  it("offers no next page at an offset already read", async () => {
    const { request } = gateway({ "cron.list": { jobs: [], hasMore: true, nextOffset: 50 } });
    expect((await searchRoutines(request, "e", 50)).nextOffset).toBeNull();
  });
});

describe("searchFiles", () => {
  const entries = [
    { path: "notes", name: "notes", kind: "directory" },
    { path: "notes/disk.md", name: "disk.md", kind: "file" },
  ];

  it("returns file names only when the task's root is the bot's workspace", async () => {
    const { asked, request } = gateway({
      "sessions.files.list": { root: "/w", browser: { entries, truncated: true } },
      "sessions.describe": { session: { key: "agent:otto:a" } },
    });
    expect(await searchFiles(request, "disk", "otto", "agent:otto:a")).toEqual({
      status: "searched",
      botId: "otto",
      paths: ["notes/disk.md"],
      returned: 1,
      truncated: true,
    });
    expect(asked).toEqual([
      { method: "sessions.files.list", params: { sessionKey: "agent:otto:a", search: "disk" } },
      { method: "sessions.describe", params: { key: "agent:otto:a" } },
    ]);
  });

  it("names a task with a folder of its own, no root, or no task, and searches nothing for them", async () => {
    const own = gateway({
      "sessions.files.list": { root: "/w", browser: { entries } },
      "sessions.describe": { session: { spawnedCwd: "/elsewhere" } },
    });
    expect(await searchFiles(own.request, "disk", "otto", "agent:otto:a")).toEqual({
      status: "unverified",
      botId: "otto",
    });
    const noRoot = gateway({
      "sessions.files.list": { files: [] },
      "sessions.describe": { session: {} },
    });
    expect(await searchFiles(noRoot.request, "disk", "pip", "agent:pip:a")).toEqual({
      status: "no-root",
      botId: "pip",
    });
    const none = gateway({});
    expect(await searchFiles(none.request, "disk", "pip", null)).toEqual({
      status: "unverified",
      botId: "pip",
    });
    expect(none.asked).toEqual([]);
  });

  it(`keeps at most ${MAX_FILE_HITS} names and says how many came back`, async () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ path: `f${i}`, kind: "file" }));
    const { request } = gateway({
      "sessions.files.list": { root: "/w", browser: { entries: many } },
      "sessions.describe": { session: {} },
    });
    const found = await searchFiles(request, "f", "otto", "agent:otto:a");
    expect(found.status === "searched" && [found.paths.length, found.returned]).toEqual([
      MAX_FILE_HITS,
      300,
    ]);
  });
});

describe("parseBridgeCommand for search", () => {
  it("takes a trimmed query within the gateway's limit, and never puts it in an error", () => {
    expect(parseBridgeCommand({ type: "searchMessages", query: "disk", botId: null })).toEqual({
      type: "searchMessages",
      query: "disk",
      botId: null,
    });
    expect(parseBridgeCommand({ type: "searchFiles", query: "md", botId: "otto" })).toEqual({
      type: "searchFiles",
      query: "md",
      botId: "otto",
    });
    expect(parseBridgeCommand({ type: "searchRoutines", query: "e", offset: 50 })).toEqual({
      type: "searchRoutines",
      query: "e",
      offset: 50,
    });
    const refused = (command: unknown) => {
      try {
        parseBridgeCommand(command);
      } catch (error) {
        return (error as Error).message;
      }
      return null;
    };
    expect(refused({ type: "searchMessages", query: " secret ", botId: null })).toBe(
      "invalid search",
    );
    expect(refused({ type: "searchMessages", query: "", botId: null })).toBe("invalid search");
    expect(
      refused({
        type: "searchMessages",
        query: "x".repeat(MAX_SEARCH_QUERY_CHARS + 1),
        botId: null,
      }),
    ).toBe("invalid search");
    expect(refused({ type: "searchFiles", query: "md", botId: "../x" })).toBe("invalid bot id");
    expect(refused({ type: "searchRoutines", query: "e", offset: -1 })).toBe("invalid offset");
  });
});
