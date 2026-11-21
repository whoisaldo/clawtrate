// What the palette matches itself (search.md §5).
import type { Transcript } from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { findIn, indexLinks } from "../src/search/match.ts";

const transcript = (text: string) =>
  ({
    status: "ready",
    items: [{ role: "user", messageId: "m-1", blocks: [{ kind: "text", text }] }],
  }) as unknown as Transcript;

describe("findIn", () => {
  it("marks only the character a supplementary match covers", () => {
    expect(findIn("A\u{10400}Z", "\u{10428}")).toEqual([1, 3]);
  });

  it("ignores case and accents", () => {
    expect(findIn("Café notes", "CAFE")).toEqual([0, 4]);
  });
});

describe("indexLinks", () => {
  it("reads www. in any case as a web address, and keeps one result per address in a message", () => {
    const links = indexLinks({
      "agent:pip:week": transcript("See WWW.Example.com and again WWW.Example.com"),
    });
    expect(links).toEqual([
      {
        address: "http://www.example.com/",
        host: "www.example.com",
        refused: null,
        sessionKey: "agent:pip:week",
        messageId: "m-1",
        role: "user",
      },
    ]);
  });
});
