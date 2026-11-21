// A task's chat (visual-language.md, sections 8 and 12; conversation.md,
// section 18), for reading. The floating controls sit in a band over the
// transcript and the status strip overlays it under them, so nothing moves when
// the strip comes or goes. A task opens at its start, its title first; the
// stamps, your messages and the bot's as bubbles, the bot's markdown, each of
// its actions as one quiet line in the engine's words, and what a running task
// is doing follow. Jump to latest takes a reader who is not at the end there,
// and where the composer will be is the read-only explanation. Nothing shown
// carries a credential the gateway sent back.

import type { Bot, ClawtrateState, Task } from "@clawtrate/core";
import {
  CONVERSATION_WORDS as W,
  emptyBody,
  readOnlyWords,
} from "../presentation/conversation-words.ts";
import { useEffect, useRef, useState, type ComponentRef, type ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Markdown } from "../components/Markdown.tsx";
import { EyeIcon } from "../components/icons.tsx";
import { BackButton, PROTECTED_BAND, Top } from "../components/Top.tsx";
import { Button, Dot, Txt } from "../components/ui.tsx";
import { useRuntime } from "../runtime.ts";
import { S, TOUCH, useTheme } from "../theme/index.ts";
import { chatRows, runningWords, type ChatRow } from "../transcript.ts";

/** A row's words with any credential this host holds scrubbed out. */
function redactRow(row: ChatRow, redact: (text: string) => string): ChatRow {
  return row.kind === "action"
    ? { ...row, text: redact(row.text), spoken: redact(row.spoken) }
    : { ...row, text: redact(row.text) };
}

/** Within this distance of the end, new content is followed. */
const NEAR_END = 96;

function RowView({ row }: { row: ChatRow }) {
  const { c } = useTheme();
  switch (row.kind) {
    case "stamp":
      return (
        <Txt
          testID="stamp"
          size={S["text-xs"]}
          color="text-faint"
          style={{ textAlign: "center", marginTop: 22, marginBottom: 10 }}
        >
          {row.text}
        </Txt>
      );
    case "user":
      return (
        <View
          testID="turn-user"
          style={{
            alignSelf: "flex-end",
            maxWidth: "78%",
            backgroundColor: c["bubble-user"],
            borderRadius: S["radius-lg"],
            paddingVertical: 9,
            paddingHorizontal: 14,
          }}
        >
          <Txt size={TOUCH.bodyText} color="bubble-user-text" selectable>
            {row.text}
          </Txt>
        </View>
      );
    case "bot":
      return (
        <View
          testID="turn-bot"
          style={{
            alignSelf: "flex-start",
            maxWidth: "86%",
            backgroundColor: c["bg-bubble"],
            borderRadius: S["radius-lg"],
            paddingVertical: 9,
            paddingHorizontal: 14,
          }}
        >
          <Markdown text={row.text} />
        </View>
      );
    case "action":
      return (
        <Txt
          testID="action-line"
          accessibilityLabel={row.spoken}
          size={S["text-sm"]}
          color={row.tone === "danger" ? "danger" : "text-faint"}
          style={{ paddingHorizontal: 14 }}
        >
          {row.text}
        </Txt>
      );
    case "note":
      return (
        <Txt
          testID={row.id === "earlier" ? "earlier-note" : "shortened-note"}
          size={S["text-sm"]}
          color="text-faint"
          style={{ paddingHorizontal: 14, textAlign: row.id === "earlier" ? "center" : "left" }}
        >
          {row.text}
        </Txt>
      );
    case "event":
      return (
        <Txt
          testID="event-line"
          size={S["text-sm"]}
          color="text-faint"
          style={{ textAlign: "center" }}
        >
          {row.text}
        </Txt>
      );
    case "running":
      return (
        <View
          testID="running"
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: S["space-2"],
            paddingHorizontal: 14,
          }}
        >
          <Dot
            tone={row.tone === "live" ? "connected" : row.tone === "lost" ? "connecting" : "off"}
            testID={`running-dot-${row.tone}`}
          />
          <Txt testID="running-text" size={S["text-sm"]} color="text-muted">
            {row.text}
          </Txt>
        </View>
      );
  }
}

/** The task's name, the first line of every transcript. */
function TaskLine({ task }: { task: Task }) {
  const { redact } = useRuntime();
  return (
    <Txt
      testID="task-line"
      accessibilityRole="header"
      size={S["text-base"]}
      weight="medium"
      style={{ textAlign: "center", marginBottom: S["space-2"] }}
    >
      {redact(task.title)}
    </Txt>
  );
}

function Empty({
  title,
  body,
  children,
}: {
  title: string;
  body: string | null;
  children?: ReactNode;
}) {
  return (
    <View
      testID="chat-empty"
      style={{ alignItems: "center", gap: S["space-2"], paddingTop: S["space-10"] }}
    >
      <Txt weight="medium" accessibilityRole="header">
        {title}
      </Txt>
      {body && (
        <Txt size={S["text-sm"]} color="text-faint" style={{ textAlign: "center" }}>
          {body}
        </Txt>
      )}
      {children}
    </View>
  );
}

/** The read-only explanation, in the composer's place at the foot (visual-language.md, section 8). */
function ReadOnly({ botName }: { botName: string }) {
  const { c } = useTheme();
  const { redact } = useRuntime();
  const words = readOnlyWords(botName);
  return (
    <View
      testID="read-only"
      accessible
      accessibilityLabel={redact(`${words.lead}${words.rest}`)}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: S["space-2"],
        marginHorizontal: S["space-4"],
        marginBottom: S["space-2"],
        paddingHorizontal: S["space-4"],
        paddingVertical: S["space-3"],
        borderRadius: 24,
        backgroundColor: c["bg-bubble"],
      }}
    >
      <EyeIcon color={c["text-muted"]} />
      <Txt size={S["text-sm"]} color="text-muted" style={{ flex: 1 }}>
        <Txt size={S["text-sm"]} weight="medium">
          {redact(words.lead)}
        </Txt>
        {redact(words.rest)}
      </Txt>
    </View>
  );
}

/** Jump to latest (conversation.md, section 18): while a run goes on, its phrase; else the words. */
function JumpToLatest({ phrase, onPress }: { phrase: string | null; onPress: () => void }) {
  const { c, scheme } = useTheme();
  const label = phrase ?? W.jumpToLatest;
  return (
    <View
      pointerEvents="box-none"
      style={{ position: "absolute", left: 0, right: 0, bottom: 10, alignItems: "center" }}
    >
      <Pressable
        testID="jump-to-latest"
        accessibilityRole="button"
        accessibilityLabel={phrase ? `${phrase}. ${W.jumpToLatest}` : W.jumpToLatest}
        onPress={onPress}
        style={{
          minHeight: TOUCH.taskRow,
          maxWidth: 380,
          paddingHorizontal: S["space-4"],
          borderRadius: 999,
          justifyContent: "center",
          backgroundColor: c["bg-raised"],
          borderWidth: 1,
          borderColor: scheme === "dark" ? "rgba(255, 255, 255, 0.07)" : "rgba(17, 18, 19, 0.06)",
          shadowColor: "#111213",
          shadowOpacity: scheme === "dark" ? 0.6 : 0.16,
          shadowRadius: 18,
          shadowOffset: { width: 0, height: 12 },
        }}
      >
        <Txt size={S["text-md"]} weight="medium" numberOfLines={1}>
          {`${label} ↓`}
        </Txt>
      </Pressable>
    </View>
  );
}

export function Chat({
  state,
  bot,
  task,
  now,
  onBack,
  onRead,
}: {
  state: ClawtrateState;
  bot: Bot;
  task: Task;
  now: number;
  onBack: () => void;
  /** The task has been read as of what it now shows. */
  onRead: (task: Task) => void;
}) {
  const { send, redact } = useRuntime();
  const { c } = useTheme();
  const transcript = state.transcripts[task.key];
  const online = state.connection.status === "connected";
  const link = { connected: online, closed: state.connection.status === "disconnected" };
  const scroller = useRef<ComponentRef<typeof ScrollView>>(null);
  // A task opens at its start, its title in view; the reader follows the end
  // once they reach it, as section 18 has it.
  const following = useRef(false);
  const [atEnd, setAtEnd] = useState(false);
  const [contentHeight, setContentHeight] = useState(0);
  const [viewHeight, setViewHeight] = useState(0);

  // The task is open while its chat is on screen.
  useEffect(() => {
    void send({ type: "openSession", key: task.key }).catch(() => {});
    return () => {
      void send({ type: "closeSession", key: task.key }).catch(() => {});
    };
  }, [send, task.key]);

  // What is on screen has been read.
  const ready = transcript?.status === "ready";
  useEffect(() => {
    if (ready) onRead(task);
  }, [ready, task, onRead]);

  const reload = () => {
    void send({ type: "closeSession", key: task.key })
      .then(() => send({ type: "openSession", key: task.key }))
      .catch(() => {});
  };

  const items = transcript?.items.length ?? 0;
  const rows = transcript
    ? chatRows(task, transcript, bot.name, now, link).map((row) => redactRow(row, redact))
    : [];
  const hasConversation = items > 0 || rows.some((row) => row.kind === "bot");
  const running = rows.find((row) => row.kind === "running");
  let body: ReactNode;
  if (!online && !hasConversation) {
    // Nothing loaded to show; what the task was last seen doing is still said.
    const last = runningWords(task, transcript, bot.name, link);
    body = (
      <View>
        <Empty title={W.waitingTitle} body={W.waitingBody} />
        {last && <RowView row={redactRow({ kind: "running", id: "running", ...last }, redact)} />}
      </View>
    );
  } else if (!transcript || (transcript.status === "loading" && !hasConversation)) {
    body = (
      <View
        accessibilityLabel={W.loading}
        testID="chat-loading"
        style={{ gap: S["space-4"], paddingTop: S["space-4"] }}
      >
        <View
          style={{
            alignSelf: "flex-end",
            width: "46%",
            height: 40,
            borderRadius: S["radius-lg"],
            backgroundColor: c["bg-bubble"],
          }}
        />
        <View
          style={{
            width: "62%",
            height: 88,
            borderRadius: S["radius-lg"],
            backgroundColor: c["bg-bubble"],
          }}
        />
        <View
          style={{
            width: "38%",
            height: 40,
            borderRadius: S["radius-lg"],
            backgroundColor: c["bg-bubble"],
          }}
        />
      </View>
    );
  } else if (transcript.status === "error" && !hasConversation) {
    body = (
      <Empty
        title={W.loadFailed}
        body={transcript.error === null ? null : redact(transcript.error)}
      >
        <Button label={W.tryAgain} onPress={reload} testID="chat-try-again" />
      </Empty>
    );
  } else if (rows.length === 0) {
    body = <Empty title={W.emptyTitle} body={redact(emptyBody(bot.name))} />;
  } else {
    body = (
      <View style={{ gap: 4 }}>
        {transcript.status === "error" && (
          <View
            accessibilityRole="alert"
            style={{
              backgroundColor: c["danger-soft"],
              borderRadius: S["radius-md"],
              padding: S["space-3"],
              gap: S["space-2"],
            }}
          >
            <Txt size={S["text-sm"]}>{W.refreshFailed}</Txt>
            <Button label={W.tryAgain} onPress={reload} />
          </View>
        )}
        {rows.map((row, index) => {
          const previous = rows[index - 1];
          // 16 points when the sender changes, 4 within one sender.
          const changes =
            previous !== undefined &&
            previous.kind !== "stamp" &&
            (previous.kind === "user") !== (row.kind === "user");
          return (
            <View key={`${row.kind}:${row.id}`} style={{ marginTop: changes ? 12 : 0 }}>
              <RowView row={row} />
            </View>
          );
        })}
      </View>
    );
  }

  const toEnd = () => {
    following.current = true;
    scroller.current?.scrollToEnd({ animated: true });
  };

  return (
    <SafeAreaView edges={["top", "bottom"]} style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={{ flex: 1 }}>
        <ScrollView
          ref={scroller}
          testID="transcript"
          accessibilityLabel="Conversation"
          contentContainerStyle={{
            paddingTop: PROTECTED_BAND,
            paddingHorizontal: S["space-4"],
            paddingBottom: S["space-6"],
          }}
          scrollEventThrottle={64}
          onScroll={({ nativeEvent }) => {
            const { contentOffset, contentSize, layoutMeasurement } = nativeEvent;
            // Before the view has its height, nothing says where the reader is.
            if (layoutMeasurement.height === 0) return;
            const end =
              contentSize.height - (contentOffset.y + layoutMeasurement.height) < NEAR_END;
            following.current = end;
            setAtEnd(end);
          }}
          onLayout={({ nativeEvent }) => setViewHeight(nativeEvent.layout.height)}
          onContentSizeChange={(_width, height) => {
            setContentHeight(height);
            if (following.current) scroller.current?.scrollToEnd({ animated: false });
          }}
        >
          <TaskLine task={task} />
          {body}
        </ScrollView>
        {!atEnd && contentHeight > viewHeight && (
          <JumpToLatest
            phrase={running?.kind === "running" ? running.text : null}
            onPress={toEnd}
          />
        )}
        <Top
          overlay
          state={state}
          taskKey={task.key}
          bot={bot}
          left={<BackButton label={redact(`Back to ${bot.name}'s tasks`)} onPress={onBack} />}
        />
      </View>
      <ReadOnly botName={bot.name} />
    </SafeAreaView>
  );
}
