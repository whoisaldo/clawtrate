// The shell's top band (visual-language.md, sections 8 and 12): no bar, round
// controls that float, and in a bot's screens the title pill with its avatar
// and name between them; then the status strip.

import type { Bot, ClawtrateState } from "@clawtrate/core";
import { gatewayDot, gatewayState } from "../presentation/gateway-state.ts";
import type { ReactNode } from "react";
import { View } from "react-native";
import { S, TOUCH, useTheme } from "../theme/index.ts";
import { Avatar } from "./Avatar.tsx";
import { BackIcon, SettingsIcon } from "./icons.tsx";
import { useRuntime } from "../runtime.ts";
import { StatusStrip } from "./Strip.tsx";
import { Dot, RoundButton, Txt } from "./ui.tsx";

/**
 * The protected band at the top of a chat (section 8): 56 points for the
 * floating controls, then 42 for the status strip, 98 in all. The transcript
 * starts below it at rest and scrolls under it.
 */
export const HEADER_BAND = 56;
export const STRIP_BAND = 42;
export const PROTECTED_BAND = HEADER_BAND + STRIP_BAND;

export function Top({
  state,
  left,
  bot,
  taskKey,
  overlay = false,
}: {
  state: ClawtrateState;
  left: ReactNode;
  bot?: Bot;
  taskKey: string | null;
  /**
   * Float over the content below (the chat): the controls sit in the header
   * band, and the strip overlays the transcript under them without moving it.
   */
  overlay?: boolean;
}) {
  const { c } = useTheme();
  if (overlay) {
    return (
      <View pointerEvents="box-none" style={{ position: "absolute", top: 0, left: 0, right: 0 }}>
        <View
          style={{
            height: HEADER_BAND,
            paddingHorizontal: S["space-3"],
            flexDirection: "row",
            alignItems: "center",
            gap: S["space-3"],
            backgroundColor: c.bg,
          }}
        >
          {left}
          {bot && <TitlePill bot={bot} />}
        </View>
        <View pointerEvents="box-none" style={{ paddingHorizontal: S["space-3"], paddingTop: 2 }}>
          <StatusStrip state={state} taskKey={taskKey} />
        </View>
      </View>
    );
  }
  return (
    <View
      style={{ paddingHorizontal: S["space-3"], gap: S["space-2"], paddingBottom: S["space-2"] }}
    >
      <View style={{ height: 56, flexDirection: "row", alignItems: "center", gap: S["space-3"] }}>
        {left}
        {bot && <TitlePill bot={bot} />}
      </View>
      <StatusStrip state={state} taskKey={taskKey} />
    </View>
  );
}

/** Home's round Settings button, with the gateway's presence on it as the dot. */
export function SettingsButton({ state, onPress }: { state: ClawtrateState; onPress: () => void }) {
  const { c } = useTheme();
  const words = gatewayState(state.connection);
  const dot = gatewayDot(words);
  return (
    <View>
      <RoundButton
        label={`Settings. Gateway ${words.toLowerCase()}.`}
        onPress={onPress}
        testID="settings-button"
      >
        <SettingsIcon color={c.text} />
      </RoundButton>
      <View
        testID={`connection-dot-${dot}`}
        pointerEvents="none"
        style={{
          position: "absolute",
          top: 1,
          right: 1,
          padding: 2,
          borderRadius: 7,
          backgroundColor: c.bg,
        }}
      >
        <Dot tone={dot === "disconnected" ? "off" : dot} />
      </View>
    </View>
  );
}

export function BackButton({ label, onPress }: { label: string; onPress: () => void }) {
  const { c } = useTheme();
  return (
    <RoundButton label={label} onPress={onPress} testID="back">
      <BackIcon color={c.text} />
    </RoundButton>
  );
}

/** The title pill: the bot's avatar and name, centred between the floating controls. */
function TitlePill({ bot }: { bot: Bot }) {
  const { c, scheme } = useTheme();
  const { redact } = useRuntime();
  return (
    <View
      testID="title-pill"
      accessible
      accessibilityLabel={redact(bot.name)}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: S["space-2"],
        height: 36,
        paddingLeft: 7,
        paddingRight: S["space-4"],
        borderRadius: 999,
        backgroundColor: c["bg-raised"],
        borderWidth: 1,
        borderColor: scheme === "dark" ? "rgba(255, 255, 255, 0.07)" : "rgba(17, 18, 19, 0.06)",
        maxWidth: 240,
        marginLeft: "auto",
        marginRight: "auto",
        transform: [{ translateX: -(TOUCH.roundButton + S["space-3"]) / 2 }],
      }}
    >
      <Avatar bot={bot} size={S["avatar-pill"]} />
      <Txt size={S["text-md"]} weight="medium" numberOfLines={1}>
        {redact(bot.name)}
      </Txt>
    </View>
  );
}
