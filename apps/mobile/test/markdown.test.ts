import { describe, expect, it } from "vitest";
import { columnWidths, COLUMN_WIDTH, openableUrl, parseMarkdown } from "../src/markdown.ts";

describe("the bot's markdown on iOS", () => {
  it("reads paragraphs, emphasis, strong, inline code and links", () => {
    expect(
      parseMarkdown(
        "Some *quiet* and **loud** words with `du -sh` and [a link](https://docs.example/a).",
      ),
    ).toEqual([
      {
        t: "p",
        children: [
          { t: "text", text: "Some " },
          { t: "em", children: [{ t: "text", text: "quiet" }] },
          { t: "text", text: " and " },
          { t: "strong", children: [{ t: "text", text: "loud" }] },
          { t: "text", text: " words with " },
          { t: "code", text: "du -sh" },
          { t: "text", text: " and " },
          {
            t: "link",
            url: "https://docs.example/a",
            host: "docs.example",
            plain: false,
            children: [{ t: "text", text: "a link" }],
          },
          { t: "text", text: "." },
        ],
      },
    ]);
  });

  it("reads lists, numbered lists, headings, code blocks, quotes, rules and tables", () => {
    const blocks = parseMarkdown(
      [
        "## Plan",
        "",
        "- one",
        "- two",
        "",
        "3. third",
        "4. fourth",
        "",
        "```sh",
        "du -sh /media",
        "```",
        "",
        "> quoted",
        "",
        "---",
        "",
        "| Folder | Size |",
        "| --- | --- |",
        "| movies | 1.2 TB |",
      ].join("\n"),
    );
    expect(blocks.map((block) => block.t)).toEqual([
      "h",
      "list",
      "list",
      "code",
      "quote",
      "rule",
      "table",
    ]);
    expect(blocks[1]).toMatchObject({ ordered: false, items: [[{ t: "p" }], [{ t: "p" }]] });
    expect(blocks[2]).toMatchObject({ ordered: true, start: 3 });
    expect(blocks[3]).toEqual({ t: "code", text: "du -sh /media" });
    expect(blocks[6]).toEqual({
      t: "table",
      header: [[{ t: "text", text: "Folder" }], [{ t: "text", text: "Size" }]],
      rows: [[[{ t: "text", text: "movies" }], [{ t: "text", text: "1.2 TB" }]]],
    });
  });

  it("opens only http and https addresses that parse, and keeps any other as its text", () => {
    expect(openableUrl("https://a.example")?.href).toBe("https://a.example/");
    expect(openableUrl("http://127.0.0.1:9/x")?.host).toBe("127.0.0.1:9");
    for (const url of [
      "mailto:someone@example.com",
      "javascript:alert(1)",
      "file:///etc/hosts",
      "http://",
      "https://[oops",
      "tel:123",
    ])
      expect(openableUrl(url), url).toBeNull();
    expect(parseMarkdown("[run](javascript:alert(1))")).toEqual([
      { t: "p", children: [{ t: "text", text: "run" }] },
    ]);
    expect(parseMarkdown("Write [me](mailto:someone@example.com).")).toEqual([
      {
        t: "p",
        children: [
          { t: "text", text: "Write " },
          { t: "text", text: "me" },
          { t: "text", text: "." },
        ],
      },
    ]);
  });

  it("marks a link whose text is not its address, so the screen shows the host and asks first", () => {
    const [hidden] = parseMarkdown("[the notes](https://elsewhere.example/n)");
    expect(hidden).toMatchObject({
      children: [{ t: "link", host: "elsewhere.example", plain: false }],
    });
    const [shown] = parseMarkdown(
      "[https://docs.example/a](https://docs.example/a) and https://b.example",
    );
    expect(shown).toMatchObject({
      children: [
        { t: "link", plain: true },
        { t: "text" },
        { t: "link", plain: true, host: "b.example" },
      ],
    });
    // Text that names another address is not its address.
    const [lying] = parseMarkdown("[https://bank.example](https://elsewhere.example)");
    expect(lying).toMatchObject({
      children: [{ t: "link", plain: false, host: "elsewhere.example" }],
    });
  });

  it("asks first when the text differs from its address only in a path's case, a trailing slash or a query's case", () => {
    for (const [shown, target] of [
      ["http://127.0.0.1:47000/Notes", "http://127.0.0.1:47000/notes"],
      ["http://127.0.0.1:47000/notes", "http://127.0.0.1:47000/notes/"],
      ["http://127.0.0.1:47000/view?id=ABC", "http://127.0.0.1:47000/view?id=abc"],
    ]) {
      expect(parseMarkdown(`[${shown}](${target})`)[0]).toMatchObject({
        children: [{ t: "link", plain: false }],
      });
    }
  });

  it("shows raw HTML as text", () => {
    const html = parseMarkdown("<b>bold</b>")[0]!;
    expect(
      html.t === "p" && html.children.map((c) => (c.t === "text" ? c.text : c.t)).join(""),
    ).toBe("<b>bold</b>");
    // Autolinks from GitHub's extension.
    expect(parseMarkdown("see https://b.example")[0]).toMatchObject({
      children: [
        { t: "text", text: "see " },
        { t: "link", url: "https://b.example/", plain: true },
      ],
    });
  });

  it("gives each table column one width in every row, from its longest cell, within the bounds", () => {
    const [table] = parseMarkdown(
      [
        "| A | Medium heading | x |",
        "| --- | --- | --- |",
        `| short | b | ${"wide ".repeat(40)} |`,
      ].join("\n"),
    );
    if (table?.t !== "table") throw new Error("not a table");
    // 15-point text: "short" is narrow, "Medium heading" is 14 × 15 × 0.55 + 16, and 200 characters are capped.
    expect(columnWidths(table, 15)).toEqual([COLUMN_WIDTH.min, 132, COLUMN_WIDTH.max]);
  });
});
