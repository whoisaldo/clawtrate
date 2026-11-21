// The bot's markdown inside its bubble (visual-language.md, section 8):
// paragraphs, headings at the message size in the strong weight, lists, inline
// code on the code fill, code blocks on the stage, tables with row rules, and
// links in the accent that open in the system browser.

import { Fragment, useMemo } from "react";
import { Alert, Linking, ScrollView, View } from "react-native";
import {
  columnWidths,
  inlineText,
  LINK_WORDS,
  parseMarkdown,
  type Block,
  type Inline,
} from "../markdown.ts";
import { REDACTED } from "../host/secrets.ts";
import { useRuntime } from "../runtime.ts";
import { FONTS, S, TOUCH, useTheme } from "../theme/index.ts";
import { Txt } from "./ui.tsx";

/**
 * Leave the app for a link. One whose visible text is its address opens; any
 * other asks first, showing the address it goes to.
 */
function openLink(url: string, plain: boolean) {
  const open = () => void Linking.openURL(url).catch(() => {});
  if (plain) return open();
  Alert.alert(LINK_WORDS.ask, url, [
    { text: LINK_WORDS.cancel, style: "cancel" },
    { text: LINK_WORDS.open, onPress: open },
  ]);
}

/** The address as written and decoded where it decodes: a scrubbed credential shows in either. */
function decoded(url: string): string {
  try {
    return decodeURI(url);
  } catch {
    return url;
  }
}

function Inlines({ nodes }: { nodes: Inline[] }) {
  const { c } = useTheme();
  const { redact } = useRuntime();
  return (
    <>
      {nodes.map((node, index) => {
        switch (node.t) {
          case "text":
            return <Fragment key={index}>{node.text}</Fragment>;
          case "break":
            return <Fragment key={index}>{"\n"}</Fragment>;
          case "strong":
            return (
              <Txt key={index} weight="strong" size={TOUCH.bodyText}>
                <Inlines nodes={node.children} />
              </Txt>
            );
          case "em":
            return (
              <Txt key={index} size={TOUCH.bodyText} style={{ fontFamily: FONTS.italic }}>
                <Inlines nodes={node.children} />
              </Txt>
            );
          case "del":
            return (
              <Txt key={index} size={TOUCH.bodyText} style={{ textDecorationLine: "line-through" }}>
                <Inlines nodes={node.children} />
              </Txt>
            );
          case "code":
            return (
              <Txt
                key={index}
                size={TOUCH.bodyText * 0.88}
                style={{ fontFamily: FONTS.mono, backgroundColor: c["bg-code"] }}
              >
                {node.text}
              </Txt>
            );
          case "link": {
            // An address that carries a known credential, or one already scrubbed, is
            // never handed to the system: the link is its text.
            const shown = decoded(node.url);
            if (
              redact(node.url) !== node.url ||
              redact(shown) !== shown ||
              node.url.includes(REDACTED) ||
              shown.includes(REDACTED)
            )
              return <Inlines key={index} nodes={node.children} />;
            return (
              <Fragment key={index}>
                <Txt
                  size={TOUCH.bodyText}
                  color="accent"
                  accessibilityRole="link"
                  accessibilityLabel={LINK_WORDS.spoken(inlineText(node.children), node.host)}
                  style={{ textDecorationLine: "underline" }}
                  onPress={() => openLink(node.url, node.plain)}
                >
                  <Inlines nodes={node.children} />
                </Txt>
                {!node.plain && (
                  <Txt size={TOUCH.bodyText} color="text-muted">{` (${node.host})`}</Txt>
                )}
              </Fragment>
            );
          }
        }
      })}
    </>
  );
}

function Blocks({ blocks }: { blocks: Block[] }) {
  const { c } = useTheme();
  return (
    <View style={{ gap: S["space-2"] }}>
      {blocks.map((block, index) => {
        switch (block.t) {
          case "p":
            return (
              <Txt key={index} size={TOUCH.bodyText}>
                <Inlines nodes={block.children} />
              </Txt>
            );
          case "h":
            return (
              <Txt key={index} size={TOUCH.bodyText} weight="strong" accessibilityRole="header">
                <Inlines nodes={block.children} />
              </Txt>
            );
          case "list":
            return (
              <View key={index} style={{ gap: S["space-1"] }}>
                {block.items.map((item, i) => (
                  <View key={i} style={{ flexDirection: "row", gap: S["space-2"] }}>
                    <Txt size={TOUCH.bodyText} color="text-muted" style={{ minWidth: 14 }}>
                      {block.ordered ? `${block.start + i}.` : "•"}
                    </Txt>
                    <View style={{ flex: 1 }}>
                      <Blocks blocks={item} />
                    </View>
                  </View>
                ))}
              </View>
            );
          case "code":
            return (
              <ScrollView
                key={index}
                horizontal
                style={{ flexGrow: 0, backgroundColor: c.bg, borderRadius: S["radius-sm"] }}
                contentContainerStyle={{ padding: S["space-3"] }}
              >
                <Txt size={S["text-sm"]} style={{ fontFamily: FONTS.mono }} selectable>
                  {block.text}
                </Txt>
              </ScrollView>
            );
          case "quote":
            return (
              <View
                key={index}
                style={{
                  borderLeftWidth: 2,
                  borderLeftColor: c["border-strong"],
                  paddingLeft: S["space-3"],
                }}
              >
                <Blocks blocks={block.children} />
              </View>
            );
          case "rule":
            return <View key={index} style={{ height: 1, backgroundColor: c.border }} />;
          case "table": {
            const widths = columnWidths(block, S["text-base"]);
            return (
              // A horizontal scroller keeps the base style's flexGrow, which lets it grow
              // down the bubble; it is as tall as its rows.
              <ScrollView key={index} horizontal testID="md-table" style={{ flexGrow: 0 }}>
                <View>
                  {[block.header, ...block.rows].map((row, r) => (
                    <View
                      key={r}
                      style={{
                        flexDirection: "row",
                        borderBottomWidth: r < block.rows.length ? 1 : 0,
                        borderBottomColor: c.border,
                      }}
                    >
                      {row.map((cell, k) => (
                        <View
                          key={k}
                          style={{
                            width: widths[k],
                            paddingVertical: 6,
                            paddingRight: S["space-4"],
                          }}
                        >
                          <Txt size={S["text-base"]} weight={r === 0 ? "medium" : "regular"}>
                            <Inlines nodes={cell} />
                          </Txt>
                        </View>
                      ))}
                    </View>
                  ))}
                </View>
              </ScrollView>
            );
          }
        }
      })}
    </View>
  );
}

export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <Blocks blocks={blocks} />;
}
