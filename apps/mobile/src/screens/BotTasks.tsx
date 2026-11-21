// A bot's task list (visual-language.md, section 12): the bot's avatar and name,
// then its task rows at touch size with the title, the time and at most one
// mark. Back returns to Home. "New task" needs a connection that writes, which
// this build does not ask for, so it is not shown.

import type { Bot, ClawtrateState } from "@clawtrate/core";
import { noTasksBody, TASK_WORDS } from "../presentation/summary.ts";
import type { SeenMap } from "../../../../packages/ui/src/unread.ts";
import { Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Avatar } from "../components/Avatar.tsx";
import { StateMark } from "../components/StateMark.tsx";
import { BackButton, Top } from "../components/Top.tsx";
import { Txt, UnreadDot } from "../components/ui.tsx";
import { TASKS_FAILED, taskRows } from "../lists.ts";
import { useRuntime } from "../runtime.ts";
import { S, stacked, TOUCH, useTheme } from "../theme/index.ts";

export function BotTasks({
  state,
  bot,
  seen,
  now,
  onBack,
  onOpenTask,
}: {
  state: ClawtrateState;
  bot: Bot;
  seen: SeenMap;
  now: number;
  onBack: () => void;
  onOpenTask: (key: string) => void;
}) {
  const { c } = useTheme();
  const { redact } = useRuntime();
  const current = state.connection.status === "connected" && state.discovery.status === "ready";
  const rows = taskRows(state.tasksByBot[bot.id] ?? [], seen, now, current);
  const stack = stacked(useWindowDimensions().fontScale);
  return (
    <SafeAreaView edges={["top"]} style={{ flex: 1, backgroundColor: c.bg }}>
      <Top
        state={state}
        taskKey={null}
        left={<BackButton label={TASK_WORDS.back} onPress={onBack} />}
      />
      <ScrollView
        testID={`bot-tasks-${redact(bot.id)}`}
        accessibilityLabel={redact(`${bot.name}'s tasks`)}
        contentContainerStyle={{ paddingHorizontal: S["space-2"], paddingBottom: S["space-8"] }}
      >
        <View style={{ alignItems: "center", gap: S["space-2"], paddingVertical: S["space-4"] }}>
          <Avatar bot={bot} size={S["avatar-hero"]} primary={bot.isDefault} />
          <Txt testID="bot-name" size={TOUCH.bodyText} weight="medium" accessibilityRole="header">
            {redact(bot.name)}
          </Txt>
          {bot.theme && (
            <Txt size={S["text-sm"]} color="text-faint">
              {redact(bot.theme)}
            </Txt>
          )}
        </View>
        {rows.map((row) => (
          <Pressable
            key={row.task.key}
            testID={`task-${redact(row.task.key)}`}
            accessibilityRole="button"
            accessibilityLabel={redact(row.spoken)}
            onPress={() => onOpenTask(row.task.key)}
            style={({ pressed }) => ({
              minHeight: TOUCH.taskRow,
              flexDirection: "row",
              alignItems: "center",
              gap: S["space-3"],
              paddingHorizontal: S["space-3"],
              paddingVertical: stack ? S["space-2"] : 0,
              borderRadius: S["radius-sm"],
              backgroundColor: pressed ? c["bg-hover"] : "transparent",
            })}
          >
            <View style={{ flex: 1, gap: 2 }}>
              <Txt
                testID={`task-title-${redact(row.task.key)}`}
                size={S["text-base"]}
                color={row.unread || row.state === "working" ? "text" : "text-muted"}
                numberOfLines={stack ? undefined : 1}
              >
                {redact(row.title)}
              </Txt>
              {stack && row.time !== "" && (
                <Txt
                  testID={`task-time-${redact(row.task.key)}`}
                  size={S["text-xs"]}
                  color="text-faint"
                  style={{ fontVariant: ["tabular-nums"] }}
                >
                  {row.time}
                </Txt>
              )}
            </View>
            {!stack && row.time !== "" && (
              <Txt
                testID={`task-time-${redact(row.task.key)}`}
                size={S["text-xs"]}
                color="text-faint"
                style={{ fontVariant: ["tabular-nums"] }}
              >
                {row.time}
              </Txt>
            )}
            <View style={{ width: 12, alignItems: "center" }}>
              {row.state ? <StateMark state={row.state} /> : row.unread ? <UnreadDot /> : null}
            </View>
          </Pressable>
        ))}
        {rows.length === 0 &&
          (state.discovery.status === "ready" ? (
            <View style={{ padding: S["space-3"], gap: S["space-1"] }}>
              <Txt weight="medium">{TASK_WORDS.none}</Txt>
              <Txt size={S["text-sm"]} color="text-faint">
                {redact(noTasksBody(bot.name))}
              </Txt>
            </View>
          ) : state.discovery.status === "error" ? (
            <View style={{ padding: S["space-3"], gap: S["space-1"] }}>
              <Txt weight="medium">{TASKS_FAILED}</Txt>
            </View>
          ) : (
            <Txt size={S["text-sm"]} color="text-faint" style={{ padding: S["space-3"] }}>
              {TASK_WORDS.loading}
            </Txt>
          ))}
      </ScrollView>
    </SafeAreaView>
  );
}
