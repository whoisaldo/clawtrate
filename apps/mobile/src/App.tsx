// The app: the connection screens until the gateway's bots have loaded, then
// Home, a bot's task list and a task's chat, with Settings as a sheet. The
// shell stays up through every reconnect once it has something to show.

import type { ConnectionError, Task } from "@clawtrate/core";
import { markSeen, type SeenMap } from "../../../packages/ui/src/unread.ts";
import { useCallback, useEffect, useState } from "react";
import { StatusBar, useColorScheme } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { BotTasks } from "./screens/BotTasks.tsx";
import { Chat } from "./screens/Chat.tsx";
import { Address, Pairing, Protocol, Setup, Welcome } from "./screens/Connect.tsx";
import { Home } from "./screens/Home.tsx";
import { Settings } from "./screens/Settings.tsx";
import {
  back,
  connectView,
  current,
  HOME,
  inShell,
  keptMismatch,
  type Route,
} from "./navigation.ts";
import { RuntimeContext, startRuntime, useClawtrateState } from "./runtime.ts";
import { useSwitcherProbe } from "./switcher-probe.ts";
import { ThemeContext, themeFor } from "./theme/index.ts";

/** A clock for the rows' relative times: once a minute is enough. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function Screens() {
  const state = useClawtrateState();
  const now = useMinuteClock();
  const [route, setRoute] = useState<Route>(HOME);
  const [addressOpen, setAddressOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mismatch, setMismatch] = useState<ConnectionError | null>(null);
  // What this viewer has read: the gateway's unread marks need write to change.
  const [seen, setSeen] = useState<SeenMap>({});
  const onRead = useCallback((task: Task) => setSeen((was) => markSeen(was, task)), []);

  const kept = keptMismatch(state, mismatch);
  if (kept !== mismatch) setMismatch(kept);

  const another = () => {
    setMismatch(null);
    setAddressOpen(true);
    setRoute(HOME);
  };

  if (!inShell(state, kept)) {
    const { connection } = state;
    const chooseAnother = () => {
      const { gatewayUrl } = connection;
      if (gatewayUrl !== null) void startRuntime().send({ type: "disconnect", gatewayUrl });
      another();
    };
    switch (connectView(state, kept, addressOpen)) {
      case "protocol":
        return <Protocol connection={connection} error={kept!} onAnother={chooseAnother} />;
      case "pairing":
        return <Pairing connection={connection} onAnother={chooseAnother} />;
      case "setup":
        return (
          <Setup connection={connection} discovery={state.discovery} onAnother={chooseAnother} />
        );
      case "address":
        return <Address connection={connection} onBack={() => setAddressOpen(false)} />;
      case "welcome":
        return <Welcome connection={connection} onConnect={() => setAddressOpen(true)} />;
    }
  }

  const shown = current(route, state);
  const bot = shown.name === "home" ? undefined : state.bots.find((b) => b.id === shown.botId);
  const task =
    shown.name === "task"
      ? (state.tasksByBot[shown.botId] ?? []).find((t) => t.key === shown.key)
      : undefined;
  const settings = (
    <Settings
      connection={state.connection}
      visible={settingsOpen}
      onClose={() => setSettingsOpen(false)}
      onForget={another}
    />
  );
  if (shown.name === "task" && bot && task) {
    return (
      <Chat
        state={state}
        bot={bot}
        task={task}
        now={now}
        onBack={() => setRoute(back(shown))}
        onRead={onRead}
      />
    );
  }
  if (shown.name !== "home" && bot) {
    return (
      <BotTasks
        state={state}
        bot={bot}
        seen={seen}
        now={now}
        onBack={() => setRoute(HOME)}
        onOpenTask={(key) => setRoute({ name: "task", botId: bot.id, key })}
      />
    );
  }
  return (
    <>
      <Home
        state={state}
        seen={seen}
        now={now}
        onOpenBot={(botId) => setRoute({ name: "bot", botId })}
        onSettings={() => setSettingsOpen(true)}
      />
      {settings}
    </>
  );
}

export function App({ switcherProbePort }: { switcherProbePort?: number }) {
  useSwitcherProbe(switcherProbePort);
  const [runtime] = useState(startRuntime);
  const scheme = useColorScheme();
  const theme = themeFor(scheme);
  return (
    <RuntimeContext.Provider value={runtime}>
      <ThemeContext.Provider value={theme}>
        <SafeAreaProvider>
          <StatusBar barStyle={theme.scheme === "dark" ? "light-content" : "dark-content"} />
          <Screens />
        </SafeAreaProvider>
      </ThemeContext.Provider>
    </RuntimeContext.Provider>
  );
}
