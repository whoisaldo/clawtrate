// The fixture mode: the real interface on fixed state, with no gateway and no
// host. It is its own Vite entry (vite.fixture.config.ts), so nothing here is
// part of the Electron renderer or the web preview's build.
//
// The address picks what to show:
//   ?scene=main            one of SCENES in bridge-fixture.ts, or of CARD_SCENES in cards.ts
//   &bot=otto&task=<key>   the bot and task to open (stored as the app stores them)
//   &panel=open            the Work pane
//   &theme=dark            the app's own theme override
//   &pins=main,otto        pinned bots, in order (this device's rail arrangement for the gateway)
//   &hidden=marlow         hidden bots
//   &sort=name             the rail's sort order: recent, name or manual
//   &files=loaded          the Work pane's Files states (files.ts), with &checkout=1, &fileload=failed
//   &tab=files             the Work pane's tab
//   &access=admin, &lock=locked, &signin=failed …   accounts (accounts.ts)
//   &checkins=off, &scheduler=off, &cisave=fail …    check-ins (check-ins.ts)
//   &routines=running, &routines=many …            routines (routines.ts)
//   &usage=…, &budget=…, &plimit=…, &uview=usage     usage and budgets (usage.ts)
//   &search=on, &src=…, &routinepage=3 …            search (search.ts)

import { App, BridgeProvider, requestUsagePage, rosterKey, rosterScope } from "@clawtrate/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createFixtureBridge, GATEWAY_ID, GATEWAY_URL, isScene } from "./bridge-fixture.ts";
import { CARD_TASKS, isCardScene } from "./cards.ts";
import { OPEN_BOT, OPEN_TASK } from "./data.ts";
import { fileParams } from "./files.ts";
import { accountParams } from "./accounts.ts";
import { checkInParams } from "./check-ins.ts";
import { releaseRoutineReads, routineParams } from "./routines.ts";
import { usageParams } from "./usage.ts";
import { fixtureUpdates } from "./updates.ts";
import { machineParams } from "./machines.ts";
import { searchParams } from "./search.ts";

const params = new URLSearchParams(location.search);

/** Write the selection the way the app stores it, before it first renders. */
function seedPreferences() {
  const write = (key: string, value: string) => {
    try {
      localStorage.setItem(`clawtrate.${key}`, value);
    } catch {
      // Storage may be unavailable; the app then opens its defaults.
    }
  };
  let stored: string | null = null;
  try {
    stored = localStorage.getItem("clawtrate.bot");
  } catch {
    // As above.
  }
  // A card scene opens its own task unless the address names one.
  const card = isCardScene(params.get("scene"))
    ? params.get("scene")!.startsWith("received")
      ? CARD_TASKS.marlow
      : CARD_TASKS.otto
    : null;
  const bot = params.get("bot") ?? card?.botId ?? (stored === null ? OPEN_BOT : null);
  const task =
    params.get("task") ?? card?.key ?? (bot === OPEN_BOT && !params.has("bot") ? OPEN_TASK : null);
  if (bot) write("bot", bot);
  if (bot && task) write("tasks", JSON.stringify({ [bot]: task }));
  const panel = params.get("panel");
  if (panel === "open" || panel === "closed") write("panel", panel);
  const tab = params.get("tab");
  if (tab) write("workTab", tab);
  const list = (name: string) => params.get(name)?.split(",").filter(Boolean);
  if (params.has("pins") || params.has("hidden") || params.has("sort")) {
    // Kept per gateway, under the fixture gateway's identity.
    write(
      rosterKey(rosterScope({ gatewayId: GATEWAY_ID, gatewayUrl: GATEWAY_URL })!),
      JSON.stringify({
        pinned: list("pins") ?? [],
        hidden: list("hidden") ?? [],
        sort: params.get("sort") ?? "recent",
        manual: list("order") ?? [],
      }),
    );
  }
}

seedPreferences();
document.documentElement.dataset.host = "web";
const sceneName = params.get("scene");
const bridge = createFixtureBridge(isScene(sceneName) ? sceneName : "main", {
  desktopUpdates: fixtureUpdates(params),
  files: fileParams(params),
  accounts: accountParams(params),
  checkIns: checkInParams(params),
  routines: routineParams(params),
  usage: usageParams(params),
  machines: machineParams(params),
  search: searchParams(params),
});
if (params.has("hold")) bridge.hold();
// Otto's Usage page in the Work pane's Settings tab, with the budget form open for `budget=invalid`.
if (params.get("uview") === "usage")
  requestUsagePage(params.get("bot") ?? OPEN_BOT, params.get("budget") === "invalid");
// For tests and manual checks: change the state from the console.
Object.assign(window, { clawtrateFixture: bridge, releaseRoutineReads });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BridgeProvider bridge={bridge}>
      <App info={bridge.info} onUnreadCount={(count) => (bridge.badge = count)} />
    </BridgeProvider>
  </StrictMode>,
);
