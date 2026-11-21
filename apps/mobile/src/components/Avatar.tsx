// A bot's avatar: its picture cropped to a circle when the gateway gives one,
// otherwise its character, drawn from the same shapes and hash as the desktop
// (`presentation/character.ts`). The primary bot carries the star at its lower
// right (F-015), a neutral disc as on the desktop.

import type { Bot } from "@clawtrate/core";
import {
  BODIES,
  characterFor,
  eyesOf,
  EYE_COLOR,
  VISOR_COLOR,
  visorOf,
  visorY,
  type CharacterSpec,
  type FaceState,
  type Shape,
} from "../presentation/character.ts";
import { useEffect, useState } from "react";
import { AccessibilityInfo, Animated, Easing, Image, View } from "react-native";
import Svg, { Circle, Ellipse, G, Path, Rect } from "react-native-svg";
import { useTheme } from "../theme/index.ts";
import { StarIcon } from "./icons.tsx";

function ShapeElement({ shape }: { shape: Shape }) {
  const { el, ...attributes } = shape;
  switch (el) {
    case "circle":
      return <Circle {...attributes} />;
    case "ellipse":
      return <Ellipse {...attributes} />;
    case "rect":
      return <Rect {...attributes} />;
    case "path":
      return <Path {...attributes} />;
  }
}

export function Character({
  id,
  spec: given,
  size,
  state = "idle",
}: {
  id?: string;
  spec?: CharacterSpec;
  size: number;
  state?: FaceState;
}) {
  const spec = given ?? characterFor(id ?? "");
  const y = visorY(spec);
  const { el: _el, ...visor } = visorOf(y);
  return (
    <Svg width={size} height={size} viewBox="0 0 40 40">
      <G fill={spec.color} stroke={spec.color} strokeWidth={0}>
        {BODIES[spec.body].map((shape, index) => (
          <ShapeElement key={index} shape={shape} />
        ))}
      </G>
      <G transform={`rotate(${spec.tilt} 20 ${y})`}>
        <Rect {...visor} fill={VISOR_COLOR} />
        <G fill={EYE_COLOR}>
          {eyesOf(state, spec.look, y).map((shape, index) => (
            <ShapeElement key={index} shape={shape} />
          ))}
        </G>
      </G>
    </Svg>
  );
}

/** Whether the person asked the system to reduce motion; it can change while the app runs. */
export function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (live) setReduce(value);
    });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduce);
    return () => {
      live = false;
      subscription.remove();
    };
  }, []);
  return reduce;
}

/** A working bot's body bobs on the working loop (`--loop-work`, 1200 ms); it holds still with reduced motion. */
const LOOP_WORK_MS = 1200;

function useBob(active: boolean): Animated.AnimatedInterpolation<number> {
  const [value] = useState(() => new Animated.Value(0));
  const reduce = useReduceMotion();
  useEffect(() => {
    if (!active || reduce) {
      value.setValue(0);
      return;
    }
    const half = {
      duration: LOOP_WORK_MS / 2,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: true,
    };
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(value, { toValue: 1, ...half }),
        Animated.timing(value, { toValue: 0, ...half }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, reduce, value]);
  const [bob] = useState(() => value.interpolate({ inputRange: [0, 1], outputRange: [0, -3] }));
  return bob;
}

export function Avatar({
  bot,
  size,
  primary = false,
  state = "idle",
}: {
  bot: Bot;
  size: number;
  primary?: boolean;
  state?: FaceState;
}) {
  const { c } = useTheme();
  const bob = useBob(state === "working");
  return (
    <View style={{ width: size, height: size }}>
      <Animated.View
        testID={state === "working" ? "avatar-working" : undefined}
        style={{ transform: [{ translateY: bob }] }}
      >
        {bot.avatarUrl ? (
          <Image
            source={{ uri: bot.avatarUrl }}
            style={{ width: size, height: size, borderRadius: size / 2 }}
            accessibilityIgnoresInvertColors
          />
        ) : (
          <Character id={bot.id} size={size} state={state} />
        )}
      </Animated.View>
      {primary && (
        <View
          testID="primary-star"
          style={{
            position: "absolute",
            right: -2,
            bottom: -2,
            width: 16,
            height: 16,
            borderRadius: 8,
            backgroundColor: c["bg-inverse"],
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <StarIcon color={c["text-inverse"]} size={11} />
        </View>
      )}
    </View>
  );
}
