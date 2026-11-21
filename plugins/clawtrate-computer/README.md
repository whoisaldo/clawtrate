# Clawtrate computer plugin

`clawtrate-computer` is a plugin for an OpenClaw gateway. It gives each bot you choose a browser of its own, lets the people who can use that bot watch the browser live, and lets one of them take it over (to sign in, or get past a captcha) and hand it back.

Clawtrate is an independent open-source project. It is not made by, affiliated with or endorsed by OpenClaw.

> **Status: development gateways only.** This plugin is written from the requirements in Clawtrate's [gateway capability map](../../docs/research/gateway-capabilities.md#requirements-for-the-shipped-plugin), and its tests cover each of them. It has not yet had a security review of its own. It registers nothing on a gateway that is not a named development instance started by Clawtrate's `pnpm dev-gateway` (the instance's state folder, profile and marker, and the plugin's copy inside that folder): there it adds no method, route, hook or service, whatever the configuration says, and logs why. Installing it on any other gateway is not supported yet; that is issue #29.

## What it adds

Without the plugin, a device has two routes to a bot's browser, and neither gives a person a tab to themselves:

- **The gateway's session dashboard**, `browser.dashboard.request`, is on the write tier (`operator.write`) and admitted per task, for a task whose policy allows the browser tool. It reaches one tab only, the dashboard tab bound to that task: open it, watch it as a screencast, read it, navigate it and act in it. It cannot list or watch the bot's other tabs or choose another profile or tab, and it does not stop the bot: a person and the bot can act in that tab at the same time.
- **The admin route**, `browser.request`, reaches every profile and every tab, and needs full admin access to the gateway (`operator.admin`).

With the plugin:

- **One browser per bot.** Every `browser` tool call of a configured bot is sent to that bot's own browser profile on the gateway's machine. Other agents cannot use a configured bot's profile.
- **Watching.** Anyone whose device may use one of the bot's tasks can list the bot's tabs and watch one live.
- **Taking over.** One person at a time can take control of a tab. What a granted take guarantees is exactly what the plugin says in its answer, and no more: input from the person reaches the page; new browser calls from this bot are refused while control is held, in every one of its tasks, and the tool's result tells the bot so; work the bot had already started can still affect the page. Handing back unblocks the bot.
- **No admin access for the device.** The device needs `operator.read` and `operator.write`, the same as for chatting with the bot.

## What it needs

- OpenClaw 2026.10.6 (the version it is tested against). Plugin interfaces are marked experimental, so pin that version.
- The gateway's bundled browser plugin, enabled (the default), and a Chromium-based browser on the gateway's machine for the gateway to launch.
- One free loopback port per bot, for that bot's browser.

## Installing and configuring it

1. Start a development instance with it: `pnpm dev-gateway start --instance <name> --with-plugin clawtrate-computer`. The tool copies the plugin into the instance and writes the configuration below. Installing it into any other gateway's profile is not supported yet (issue #29): the plugin would load and register nothing.

2. Give each bot a managed browser profile of its own, on a port of its own, in the gateway's config. The profile must use the managed driver (no `cdpUrl`, no `driver`), and the default profile must not be a bot's:

   ```json5
   {
     browser: {
       defaultProfile: "openclaw",
       profiles: {
         openclaw: { cdpPort: 18800 },
         "bot-juniper": { cdpPort: 18811 },
         "bot-otto": { cdpPort: 18812 },
       },
     },
   }
   ```

3. Tell the plugin which bot owns which profile, at which address (always `http://127.0.0.1:<the profile's cdpPort>` or `http://[::1]:<port>`):

   ```json5
   {
     plugins: {
       entries: {
         "clawtrate-computer": {
           enabled: true,
           config: {
             bots: {
               juniper: { profile: "bot-juniper", cdpUrl: "http://127.0.0.1:18811" },
               otto: { profile: "bot-otto", cdpUrl: "http://127.0.0.1:18812" },
             },
             // Optional. How long a request for control waits for the bot's
             // running browser call to finish (1000 to 60000, default 15000).
             drainTimeoutMs: 15000,
             // Optional. How long a view or a held tab lives without being
             // renewed (5000 to 60000, default 20000).
             renewTimeoutMs: 20000,
           },
         },
       },
     },
   }
   ```

4. Give those bots the `browser` tool (and keep it from bots that should not have one). A device can watch only a bot whose task policy allows the browser tool.

The plugin refuses to load when its config does not match the gateway's browser config: an unknown setting, a profile or port given to two bots, an address that is not literal loopback, a bot profile that is not declared under `browser.profiles` on exactly that port, or a bot profile as the default. It reads the gateway's browser config the way the gateway resolves it (OpenClaw 2026.10.6), so it decides on endpoints, not on how a URL is written:

- each bot's profile must resolve to exactly the plugin's endpoint for that bot (scheme, host and port), as a managed Chromium profile the gateway starts itself. A bot profile inherits its host and scheme from `browser.cdpUrl`, so a `browser.cdpUrl` on another host, `localhost`, `[::1]` or `https` makes it resolve elsewhere, and `attachOnly` makes the gateway attach to whatever answers on the port; each is refused with the two endpoints in the reason;
- no other profile may reach a bot's browser: any profile, including the default one and the ones the gateway adds by itself (`openclaw` on `browser.cdpUrl`'s port or the first port of its range, `user`, `chrome`), that resolves to a bot's port on loopback, on the unspecified address or by any name (a name can point at this machine) is refused, however its URL is written (a leading zero in the port, a path, a query or a fragment, another spelling of a loopback address, another scheme) and whatever its driver. It checks the gateway's config again on every call; if a bot's profile was changed afterwards, the plugin ends that bot's views and held tabs and refuses its browser calls until the two agree again.

## What a device can do with it

Every method is on the write tier (`operator.write`) and admitted by the gateway per session: the call names one of the bot's tasks (`sessionKey`), the gateway checks that this device may use that task and that the task's tool policy allows the browser tool, and the plugin then serves that task's bot. A read-only connection is refused every method, so it never receives a tab list, a ticket, a frame or a way to send input. Every reader does receive the control events.

| Method                               | Parameters                                                                                                                                       | Answer                                                                                                                                                                                                                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clawtrate-computer.tabs`            | `sessionKey`                                                                                                                                     | `{agentId, profile, browser: "running" \| "not-running", reason?, tabs: [{targetId, url, title, lease: null \| {state: "draining" \| "granted", mine}}]}`                                                                                                                                                        |
| `clawtrate-computer.view.open`       | `sessionKey, targetId`                                                                                                                           | `{streamId, wsPath, expiresAtMs, renewWithinMs, targetId}`                                                                                                                                                                                                                                                       |
| `clawtrate-computer.view.renew`      | `sessionKey, targetId, streamId?, generation?` (at least one)                                                                                    | `{ok: true, renewWithinMs, streamRenewed, leaseRenewed}`                                                                                                                                                                                                                                                         |
| `clawtrate-computer.control.take`    | `sessionKey, targetId`                                                                                                                           | once, after the bot's running browser call ends and nothing the plugin can see is unresolved, or at a deadline: `{state: "granted", generation, renewWithinMs, targetId, guarantee}` or `{state: "busy", reason, cause, runningCalls, generation}` (`reason` is a sentence; `cause` is the control event's code) |
| `clawtrate-computer.input`           | `sessionKey, targetId, generation, kind: "click" \| "scroll" \| "text"`, and `x, y` (click), `x?, y?, deltaX?, deltaY` (scroll) or `text` (text) | `{ok: true}`                                                                                                                                                                                                                                                                                                     |
| `clawtrate-computer.control.release` | `sessionKey, targetId, generation`                                                                                                               | `{state: "released", generation, targetId}`                                                                                                                                                                                                                                                                      |

Coordinates are the page's own CSS pixels (a frame's header gives the page's size). Text is 1 to 2000 characters per call. Input is applied one call at a time, in order.

**Refusals** carry one of the gateway's codes and a `details.reason`:

| Code              | `details.reason`                                                   | When                                                                                                        |
| ----------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `UNAVAILABLE`     | `bot_not_configured`                                               | the task's bot has the browser tool but no browser of its own in this plugin                                |
| `UNAVAILABLE`     | `browser_config_mismatch`                                          | the gateway's browser config no longer matches the plugin's                                                 |
| `UNAVAILABLE`     | `browser_unavailable`, `discovery_timeout`, `discovery_failed`     | the bot's browser is not running or did not answer in time                                                  |
| `UNAVAILABLE`     | `control_held`                                                     | someone has, or is taking, control of the tab                                                               |
| `UNAVAILABLE`     | `control_request_ended`                                            | a take ended before it was granted (the caller left, the tab closed, the plugin stopped)                    |
| `UNAVAILABLE`     | `input_not_delivered`                                              | an input could not be applied (control ended meanwhile, or the tab did not answer)                          |
| `UNAVAILABLE`     | `too_many_views`, `connection_closed`                              | a connection opened 8 views (64 in all), or the calling connection has closed                               |
| `FORBIDDEN`       | `tab_not_in_bots_browser`                                          | the tab is not in this bot's browser (another bot's, or closed)                                             |
| `FORBIDDEN`       | `not_holder`                                                       | input or a release without the lease: another connection, a wrong generation, or a lease that already ended |
| `FORBIDDEN`       | `session_access_required`, `session_access_ended`, `no_connection` | no task was admitted, its access ended, or the call has no connection                                       |
| `INVALID_REQUEST` | `bad_target`, `bad_input`, `bad_request`                           | a malformed tab id, input or renewal                                                                        |

A bot whose task policy denies the browser tool is refused by the gateway itself, before the plugin answers (`FORBIDDEN`, `details.code: "SESSION_RESOURCE_TOOL_POLICY"`). A refused release proves nothing about who holds the tab: it is refused for a lease that expired, was replaced, or was never this device's.

**The stream.** `view.open` returns a ticket in `wsPath`. Open a WebSocket to the gateway's own address plus `wsPath`; a ticket opens one stream once, and a used or expired one opens nothing.

- **The ticket is a bearer capability.** Whoever presents it gets the stream, from any connection, with or without a gateway login of its own; the plugin does not check who presents it. Keep it on the device that asked for it, and never log, share or put it in a link. The stream it opens still belongs to the view: it ends when the connection that called `view.open` closes, when the view is not renewed, or when that task's access ends.
- **Two deadlines.** The ticket must be used by `expiresAtMs` (60 seconds after `view.open`), and nothing extends that. The view itself ends if it is not renewed within `renewWithinMs` (20 seconds by default), and its unused ticket with it, even if the 60 seconds have not passed. Renewing keeps the view and its stream alive; it does not give an unused ticket more time. The stream sends text messages `{type: "ready", targetId, url, title}` and, when the page navigates, `{type: "meta", url}`; and binary frames in the gateway's own screencast layout: a 4-byte big-endian length, a JSON header `{url, cssWidth, cssHeight, scrollX, scrollY, ts}`, then a JPEG. It is view-only: a viewer that sends anything but a ping or a close is disconnected. Close codes: `1000` closed, `4004 target_closed` (the tab closed), `4006 authority_revoked` (not renewed, the task's access ended, or the caller's connection closed), `1011 browser_unavailable`, `1012 shutdown`. The plugin writes no frame to a log.

**The control event**, `plugin.clawtrate-computer.control`, on the read tier: `{agentId, profile, targetId, holder: "user" | "bot", state, generation, reason?}`. `state` is `draining` (a take is waiting for the bot's call and for the tab to be quiet), `granted`, `busy` (the take was refused: `reason` `bot-still-acting` at the drain deadline, `bot-calls-unconfirmed` at the drain deadline when every call still counted has gone two minutes without reporting its end, `browser-not-quiet` while a page is loading, `download-in-progress` while a download is, or `browser-not-watched` when the plugin cannot see the browser, a tab of it did not answer when asked again, or a command of its proof went unanswered with no load or download seen), `released`, `expired` (not renewed), `revoked` (the holder's connection closed, the task's access ended, the browser config changed or the plugin stopped; `reason` says which) or `tab-closed`. Every event carries the `generation` of the lease it is about, so a device can tell its own lease's events from another's. A release is confirmed by the device's own `control.release` succeeding, or by a `released` event with its own generation.

## How long things last

- **Renew** a view and a held tab with `view.renew` well within `renewWithinMs` (every 5 seconds with the default). A view or a held tab that is not renewed ends.
- **A device that disconnects** loses its views and its held tab at once: the plugin ends them when the gateway reports the connection closed.
- **A request for control** waits at most `drainTimeoutMs` for the bot's running browser call. If the call is still running then, the answer is `busy` and nothing is granted. A call counts as running from the start of its `before_tool_call` check, before anything is awaited, until its `after_tool_call`, its run's `agent_end` or its cancellation, whichever comes first and in whatever order the gateway sends them; an end that arrives first is remembered, so a late check records nothing. A call that has gone two minutes without reporting its end makes the answer `bot-calls-unconfirmed`, not `bot-still-acting`. A tab that did not answer the watch in time (Chromium answers `Page.enable` only once a pending navigation ends) is not counted as loading: it is asked again at each request, and until it answers the request is refused as `browser-not-watched`. New browser calls of the bot are blocked from the moment of the request. The holder can withdraw its own request before the answer with `control.release` and the generation from the `draining` event.
- **Then the plugin looks at the browser.** A finished tool result, a cancelled call or a stopped task is not proof that the bot's work has settled: the gateway's own browser work can go on after all three. What the plugin can see, it does not grant over:
  - a browser call of the bot that has no result yet (above);
  - a navigation pending in the tab: the plugin stops it (`Page.stopLoading`, at the browser), turns on the tab's page events, stops again, and requires half a second in which no navigation starts or commits in the tab; one that does is stopped and the half second starts over. Stopping also stops whatever the page itself was still loading, such as a frame of a sign-in form; reload the page if part of it is missing;
  - another of the bot's tabs still loading a page, and the downloads described next: the plugin does not stop these, it waits for them;
  - **the downloads a take waits for**: every download the plugin has seen begin in the bot's browser, from when it began until the browser reports it finished or cancelled, also after the tab that started it has closed. Chromium reports a download's progress to the plugin only through the tab that started it, so once that tab has closed the plugin never sees the end, and a take on any tab of that browser is refused as `busy` until that browser or the gateway is restarted. It does not wait for a download it did not see begin: one that began before the plugin was watching the browser, in the moments after the bot's first browser call starts it;
  - the browser connection the grant would hand over: a command must be answered on it after the last stop, and it must still be open at the moment of the grant.

  The plugin sees downloads and loading through a watch of its own on the bot's browser: a connection to the browser, attached to every tab with page events on, opened before each of the bot's browser calls runs (waiting at most 2 seconds) and kept while the browser runs. It changes nothing in the browser: it never sets how downloads are handled, which the gateway's own client owns, and it does not pause new tabs. If anything above is still unresolved after 5 seconds, or the browser does not answer, or the plugin cannot watch the browser, the take is refused as `busy`, with the reason in its answer, and nothing is granted.

- **Every wait has a deadline**: listing the browser's tabs (3 s), connecting to a tab (3 s), and every command to it (5 s). Ending a lease (released, expired, revoked, tab closed, the plugin stopping) never waits on the browser: input still queued is cancelled and nothing is sent after the lease ends, and only then is the bot unblocked.
- **A tab that closes** ends that tab's views (`4004`) and its lease (`tab-closed`) as soon as the plugin notices: at once through its own connection to a held or watched tab, otherwise at the next list or renewal. A connection to the tab that closes is reported as the tab closing only when the bot's browser still answers and no longer lists the tab (or the browser itself says the tab closed); when the browser does not answer, or still lists the tab, the view closes with `1011 browser_unavailable` and the lease ends `revoked` with `browser-unavailable`.

## What it guarantees, and what it cannot

It guarantees, for each configured bot:

- the bot's `browser` calls go to its own profile on the gateway's machine (`target: "host"`), whatever profile, node, sandbox, dashboard or import destination the call asks for; such routing is refused, not redirected;
- the bot may use only tab actions: `status`, `start`, `tabs`, `open`, `focus`, `close`, `snapshot`, `screenshot`, `navigate`, `text` and `act`. Profile import, downloads, uploads, `stop` and every other action are refused;
- no other agent's `browser` call can reach the bot's browser: not by naming its profile in any spelling, not through another profile or the default one that the gateway resolves to the bot's endpoint, and not as an import destination; and no other agent may use browser dashboards while bots have browsers of their own;
- a device can list, watch and take only the tabs that the bot's own browser lists right now, for a task it may use; nothing in a tool result grants anything;
- while a person holds a tab, every new `browser` call of that bot, from all of its tasks, is refused with "A person has control of this bot's browser. Wait until they give it back."; one holder at a time, and only the holder's own connection, with the lease's generation, can send input or release;
- a granted take answers with `guarantee`, exactly these three statements: "Input from the person reaches the page." "New browser calls from this bot are refused while control is held." "Work the bot had already started can still affect the page."

**What stays open while a person holds control.** The block covers the bot's `browser` tool calls and nothing else. These routes to a bot's browser stay open:

1. **Operator browser controls.** `browser.request` (for devices with `operator.admin`) and `browser.dashboard.request` (for a browser dashboard widget in a task) are gateway methods; no plugin hook sees them, so such a device can still drive the bot's browser. A dashboard widget can name any browser profile, and the plugin blocks only the browser tool's dashboard selector, not the `dashboard` tool that creates widgets. If that matters, deny the `dashboard` tool, and give `operator.admin` to no device you would not let drive the bot's browser.
2. **The browser's debugging port.** Each bot's browser listens on its loopback port without authentication. Any process on the gateway's machine can drive it there, including a command a bot runs with `exec`, `process` or `code_execution` on the gateway host. Deny those tools, or run them in a sandbox, for every agent that should not reach the bots' browsers.
3. **Other tools that drive a screen or a browser,** such as the `computer` tool, act outside the `browser` tool hook. Deny them where they could reach the bots' browsers.
4. **Other plugins.** This plugin registers its `browser` hook with priority 1000, a priority chosen to be above the usual ones; it is not a guarantee of running first. The gateway runs hooks in order of priority, highest first, and any plugin can choose a higher one. A hook that runs before this one sees the call before it is pinned to the bot's profile, and one that runs after it can rewrite the call's profile again; the plugin logs a warning when a bot's call ran with another profile, but cannot stop it.

**Other limits.**

- Isolation is per bot, not per task: all of a bot's tasks share its browser, its sign-ins and its tabs, and a hold blocks the bot in all of them. Tabs an admin opens in the bot's profile are part of that browser and can be watched from its tasks.
- A person's input and the frames go straight to the browser, so they skip the gateway's navigation policy: a click can follow a link the bot itself could not open.
- A bot call that never finishes keeps that bot's browser `busy` until the gateway restarts. A cancelled call stops counting as running; the take then still looks at the browser (above) before granting.
- **Work the bot had already started can still affect the page after a grant.** The plugin sees a call without its result, a pending navigation, a download it saw begin and a tab still loading. It cannot see a timer or a script that an earlier action of the bot left on the page, which can navigate or change the page later, nor other work the gateway may still be doing for a cancelled call, such as an action still waiting for an element to appear; the gateway gives a plugin no way to cancel that. A form the bot submitted stays submitted: stopping the tab does not undo a request the server has already received. A download the plugin did not see begin, because it began before the plugin was watching the browser, is not waited for (the downloads a take waits for are listed above).
- Without a connection-closed signal from the gateway (older gateways), views and held tabs end by renewal only.

## Removing it

1. Remove `clawtrate-computer` from `plugins.entries`, and its folder from `plugins.load.paths` (or run `openclaw plugins uninstall clawtrate-computer`). When the plugin stops, it ends every view (`1012`) and held tab (`revoked`), so no bot stays blocked.
2. Optionally remove the bots' profiles from `browser.profiles`. Each profile's data, including its sign-ins, is in the gateway's state folder under `browser/<profile>/`; delete those folders to remove them.
3. Restore the tool policy you want for the browser tool.

## On a Clawtrate development gateway

The development gateway of this repository loads the plugin on a named instance:

```bash
pnpm dev-gateway start --instance <name> --with-plugin clawtrate-computer
pnpm dev-gateway reset --instance <name>     # when you are done
```

Its [`clawtrate-dev-contract.json`](clawtrate-dev-contract.json) gives Marlow and Pip browsers of their own (`botBrowsers`, a closed declaration: seeded bots only, at most four, a drain of 2, 5 or 15 seconds and a renewal of 6, 10 or 20 seconds). From it the tool writes the whole browser setup: the browser tool for those two bots only, a headless managed profile each on ports of the instance's own block, Playwright's Chromium (never a browser of the machine's owner), no script evaluation, no cookie import from a system browser, and each profile's data inside the instance's state folder. The guard refuses any other browser setting.

**The development browser reaches only the scripted pages on loopback.** Two layers enforce it:

- the gateway's own configuration: `browser.ssrfPolicy` allows `127.0.0.1` and keeps every other private, link-local and special-use address refused, and the gateway refuses every hostname navigation it cannot pin; and
- the tool: the browser is started with `--host-rules=MAP * 127.0.0.1:<pages port>`, so every connection it makes, to any host, address or port, goes to the instance's scripted pages instead, which serve their own pages (`/scripted/pages/sign-in`, `/scripted/pages/welcome`, a slow page) only when asked for by their own origin, and answer anything else with "Refused by the development gateway". TLS to anywhere fails there.

`tools/dev-gateway/test/computer.test.ts` proves the second layer with a real Chromium: addresses outside loopback (in documentation ranges nothing answers), other loopback ports where a server of the test's own listens, and other hostnames all end at the refusal page, and that server is never reached. `pnpm scenarios` proves both on a real gateway (below).

`pnpm scenarios` runs the computer checks on an instance of their own: a bot opens a scripted loopback page in its own browser; a second bot's browser is not visible through the first bot's task; a read-only connection gets no tabs, tickets, frames or input path; a watcher gets a ticket and frames; taking control blocks the bot's browser tool, and the tool's result says so; input reaches the page; a release with a wrong generation is refused; a release with the right one frees the bot and its event carries that generation; a lease that is not renewed expires; a take while the bot acts past the drain deadline answers `busy`; a stopped task's slow navigation does not commit after a person is granted control; a take is not granted while a download the bot started is still in progress; a caller that leaves mid-take leaves nothing granted or streaming; closing the tab ends the view and the lease; an outside address is refused; and every socket of the instance's browser processes, sampled for several seconds while they run, is on loopback at both ends. Chromium makes connections of its own (a time service, for one) even with background networking off; under the host rule they reach only the scripted pages.

The plugin's own tests run with `pnpm test` (`plugins/clawtrate-computer/test`).
