// The 12-point mark for a bot's or a task's state: a ring in the accent while it
// works, warn while it waits for you, danger when a run failed or is blocked,
// faint when it was stopped or waits its turn. The row's accessible name says
// the state in words; the mark only shows it.

import type { RunState } from "../presentation/summary.ts";
import { View } from "react-native";
import { useTheme } from "../theme/index.ts";

export function StateMark({ state }: { state: RunState }) {
  const { c } = useTheme();
  const color =
    state === "working"
      ? c["accent-line"]
      : state === "waiting"
        ? c.warn
        : state === "failed" || state === "blocked" || state === "done-with-failures"
          ? c.danger
          : c["text-faint"];
  const ring = state === "working" || state === "queued";
  return (
    <View
      testID={`state-${state}`}
      style={{
        width: 12,
        height: 12,
        borderRadius: 6,
        borderWidth: ring ? 2 : 0,
        borderColor: color,
        backgroundColor: ring ? "transparent" : color,
      }}
    />
  );
}
