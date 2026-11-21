// The app's few building blocks, in the design's tokens (visual-language.md,
// sections 3 and 4): text in one family and two weights, pill buttons, round
// icon buttons and the status dot.

import type { ReactNode } from "react";
import {
  Pressable,
  Text,
  View,
  type StyleProp,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { FONTS, S, TOUCH, useTheme } from "../theme/index.ts";
import type { ColorToken } from "../theme/tokens.ts";

type Weight = "regular" | "medium" | "strong";

export function Txt({
  size = S["text-base"],
  weight = "regular",
  color = "text",
  style,
  ...props
}: TextProps & {
  size?: number;
  weight?: Weight;
  color?: ColorToken;
  style?: StyleProp<TextStyle>;
}) {
  const { c } = useTheme();
  return (
    <Text
      {...props}
      style={[
        {
          fontFamily: FONTS[weight],
          fontSize: size,
          color: c[color],
          // The design's line heights: 1.5 for reading text, 20 px for list lines.
          lineHeight: Math.round(size * (size >= TOUCH.bodyText ? 1.4 : 1.45)),
        },
        style,
      ]}
    />
  );
}

export type ButtonVariant = "primary" | "default" | "quiet";

/** A pill button. Disabled, it takes the raised fill and faint text, never a faded fill. */
export function Button({
  label,
  onPress,
  variant = "default",
  disabled = false,
  busy = false,
  large = false,
  testID,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  /** Working on it: the label says so, and assistive technology hears it is busy. */
  busy?: boolean;
  large?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const { c } = useTheme();
  const fill = disabled
    ? c["bg-bubble"]
    : variant === "primary"
      ? c["bg-inverse"]
      : variant === "default"
        ? c["bg-bubble"]
        : "transparent";
  const text: ColorToken = disabled
    ? "text-faint"
    : variant === "primary"
      ? "text-inverse"
      : variant === "quiet"
        ? "text-muted"
        : "text";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy }}
      disabled={disabled}
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => [
        {
          minHeight: large ? TOUCH.large : TOUCH.roundButton,
          paddingHorizontal: S["space-5"],
          borderRadius: 999,
          backgroundColor: pressed && !disabled ? c["bg-selected"] : fill,
          alignItems: "center",
          justifyContent: "center",
          alignSelf: large ? "stretch" : "flex-start",
        },
        style,
      ]}
    >
      <Txt weight="medium" size={S["text-base"]} color={text}>
        {label}
      </Txt>
    </Pressable>
  );
}

/** A round icon button: the raised fill with its hairline shadow, 40 points on touch. */
export function RoundButton({
  label,
  onPress,
  children,
  testID,
}: {
  label: string;
  onPress: () => void;
  children: ReactNode;
  testID?: string;
}) {
  const { c, scheme } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      onPress={onPress}
      hitSlop={(TOUCH.taskRow - TOUCH.roundButton) / 2}
      style={({ pressed }) => ({
        width: TOUCH.roundButton,
        height: TOUCH.roundButton,
        borderRadius: TOUCH.roundButton / 2,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: pressed ? c["bg-selected"] : c["bg-raised"],
        // --shadow-button: a hairline ring and, in light, a soft drop.
        borderWidth: 1,
        borderColor: scheme === "dark" ? "rgba(255, 255, 255, 0.06)" : "rgba(17, 18, 19, 0.06)",
        shadowColor: "#111213",
        shadowOpacity: scheme === "dark" ? 0 : 0.06,
        shadowRadius: 2,
        shadowOffset: { width: 0, height: 1 },
      })}
    >
      {children}
    </Pressable>
  );
}

export type DotTone = "connected" | "connecting" | "error" | "off";

/** The connection's dot: accent line when connected, warn while connecting, danger when unreachable. */
export function Dot({ tone, size = 8, testID }: { tone: DotTone; size?: number; testID?: string }) {
  const { c } = useTheme();
  const color =
    tone === "connected"
      ? c["accent-line"]
      : tone === "connecting"
        ? c.warn
        : tone === "error"
          ? c.danger
          : c["text-faint"];
  return (
    <View
      testID={testID}
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }}
    />
  );
}

/** The unread dot, in the accent. */
export function UnreadDot() {
  const { c } = useTheme();
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.accent }} />;
}
