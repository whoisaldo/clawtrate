// The status strip (visual-language.md, section 11): one compact pill that says
// what happened to the connection while the shell keeps what it has. Its state
// and words are defined in `presentation/strip.ts`. On the phone it sits
// under the top controls of every shell screen, so a dropped connection is said
// on Home and in a bot's task list as well as in the chat.

import type { ClawtrateState } from "@clawtrate/core";
import {
  STRIP_ACTION_WORDS,
  stripFor,
  stripText,
  SYNCED_FOR_MS,
  taskInSync,
  type SyncPhase,
} from "../presentation/strip.ts";
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { useRuntime } from "../runtime.ts";
import { S, useTheme } from "../theme/index.ts";
import { Dot, Txt, type DotTone } from "./ui.tsx";

/** Dropped from the moment the connection is lost until everything has loaded again, then synced for four seconds. */
export function useSyncPhase(state: ClawtrateState, taskKey: string | null): SyncPhase {
  const connected = state.connection.status === "connected";
  const [phase, setPhase] = useState<SyncPhase>(connected ? "none" : "dropped");
  if (!connected && phase !== "dropped") setPhase("dropped");
  else if (
    connected &&
    phase === "dropped" &&
    state.discovery.status === "ready" &&
    taskInSync(state, taskKey)
  )
    setPhase("synced");
  useEffect(() => {
    if (phase !== "synced") return;
    const timer = setTimeout(() => setPhase("none"), SYNCED_FOR_MS);
    return () => clearTimeout(timer);
  }, [phase]);
  return phase;
}

const TONE: Record<"warn" | "danger" | "ok" | "off", DotTone> = {
  warn: "connecting",
  danger: "error",
  ok: "connected",
  off: "off",
};

export function StatusStrip({ state, taskKey }: { state: ClawtrateState; taskKey: string | null }) {
  const { send, redact } = useRuntime();
  const { c } = useTheme();
  const phase = useSyncPhase(state, taskKey);
  const strip = stripFor(state, phase, taskKey);
  const [now, setNow] = useState(() => Date.now());
  const countdown = strip?.countdown ?? false;
  useEffect(() => {
    if (!countdown) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [countdown]);
  if (!strip) return null;
  const retryAt = state.connection.retryAt;
  const seconds =
    strip.countdown && retryAt !== null ? Math.max(0, Math.ceil((retryAt - now) / 1000)) : null;
  const text = redact(strip.short ?? stripText(strip, seconds));
  const detail = strip.more === null ? null : redact(strip.more);
  const onAction = () => {
    if (strip.action === "reload" && taskKey) {
      void send({ type: "closeSession", key: taskKey }).then(() =>
        send({ type: "openSession", key: taskKey }),
      );
    } else void send({ type: "retry" });
  };
  return (
    <View
      testID="status-strip"
      accessibilityRole="summary"
      accessibilityLabel={detail ? `${text} · ${detail}` : text}
      style={{
        flexDirection: "row",
        alignItems: "center",
        alignSelf: "center",
        gap: S["space-2"],
        minHeight: 34,
        maxWidth: "100%",
        paddingLeft: S["space-3"],
        paddingRight: strip.action ? 4 : S["space-3"],
        borderRadius: 999,
        backgroundColor: c["bg-raised"],
        borderWidth: 1,
        borderColor: c.border,
      }}
    >
      <Dot tone={TONE[strip.tone]} />
      <Txt
        testID="status-strip-text"
        size={S["text-sm"]}
        weight="medium"
        numberOfLines={1}
        style={{ flexShrink: 1 }}
      >
        {text}
        {detail ? <Txt size={S["text-sm"]} color="text-muted">{` · ${detail}`}</Txt> : null}
      </Txt>
      {strip.action && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={STRIP_ACTION_WORDS[strip.action]}
          testID="status-strip-action"
          onPress={onAction}
          hitSlop={9}
          style={{
            height: 26,
            paddingHorizontal: S["space-3"],
            borderRadius: 999,
            justifyContent: "center",
            backgroundColor: c["bg-bubble"],
          }}
        >
          <Txt size={S["text-sm"]} weight="medium">
            {STRIP_ACTION_WORDS[strip.action]}
          </Txt>
        </Pressable>
      )}
    </View>
  );
}
