# Clawtrate prototype

Static pages for the design in `docs/design/`. Open `index.html` in a browser. There is no build step and the pages make no network requests.

| Page | Shows |
|---|---|
| `setup.html` | Setting up, specified in `docs/design/setup.md`, as far as this version goes: the first screen ("Where does OpenClaw run?"), what the look found on this computer or over SSH (after the host confirms the SSH account), the host key at first contact and when it changes, connecting after the host confirms the pairing, setting OpenClaw up on this computer on macOS and Linux (and Advanced on Windows), a waiting request approved by the profile-qualified command and what Clawtrate keeps after its read-back, with each outcome ("Approve from here" drawn only as a future example, `exact=1`), a forward being restored, a setup code on the desktop and the iPhone's screens up to waiting for approval, and Settings with Tailscale read-only and "Connect a phone" saying it isn't offered yet. Every path can be walked by clicking to its outcome; a wait reached by a click plays on, and from the address it holds. The host's own confirmations are drawn as a stand-in marked as such. A state that needs an unproven step is labelled as a future example. In the SSH field, "newbox" is a first contact, "emptybox" has no OpenClaw and "jumpbox" uses a jump host. |
| `device.html` | This Mac and This iPhone as devices bots can ask, specified in `docs/design/device-node.md`: turning it on with a node-only sign-in from an admin connection and its read-backs, the apps with what this device decided and what the gateway listed, the owner's choice for the apps outside the defaults, Stop and Turn off, the permission card with each acknowledgement and the request records, other devices asking in Machines, the iPhone in the background, the share sheet with a lost reply, and Siri's List Bots and Send Message on a locked phone. `?screen=` picks a state; section 15 of `device-node.md` lists them. |
| `links.html` | Links into a bot’s chat, specified in `docs/design/links.md`. Use the state picker in the bar and run `node docs/design/prototype/tools/checks/links.mjs` from the repository root. |
| `connect.html` | The address-and-token form, which `setup.md` keeps under "Advanced". `?state=error` and `?state=busy` show a failed and a running attempt. |
| `pairing.html` | Waiting for the gateway's owner to approve this device. `?state=copied` and `?state=selected` show the copy button's two outcomes. |
| `app.html` | The main view: bots with their tasks, a conversation, the Work pane. It runs on a small local model, so selecting, folding, pinning, the menus, sending, the connection states and the Work pane all work. Right-click a bot for its menu. |
| `gallery.html` | Every conversation component in every state, the action cards of every kind among them, and the three runs that test them. Steps and cards work as they do in the app: they open, Raw opens, copy copies, approvals and questions resolve. The composer, the access bar and the rail rows are pictures of each state there. |
| `bots.html` | The app with what `bots.md` adds: "New bot" in the "+" menu (⌘N) with its Account step, connecting an account (inside New bot and in Settings), Settings from the gateway menu (⌘,), a bot's Settings tab in the Work pane with its account and lock, and T3 Code. The prototype bar's "Sign-in approved", "Expire", "Refuse" and "Drop connection" end a sign-in that is waiting, and "T3 approved" signs the gateway in to T3 Code. |
| `conversation.html` | One scripted turn, played inside the shell: Play, Step, Drop the connection and Restart are in the bar. The approval and the question pause it until you answer; Stop, steer, queue, hold and the send menu work at any point. "Start read-only" plays it on a read-only connection, with the access bar and the request for access. With `?scene=short`, `?scene=long`, `?scene=thought` or `?scene=t3` it plays one of the runs that test the action cards instead; `t3` plays a T3 Code thread from a launch known only by its result to a stop. |
| `routines.html` | The Routines view of `automation.md`: every routine across bots or one bot's with its check-ins, the calendar (Day, 3 days, Week), a routine's page with its runs, a run's conversation, the editor, pause, run now and delete, the request for admin access, and the away card. Right-click a routine, or press Shift+F10 on it, for its menu. `?transcript=checkin` shows a conversation with a check-in's reply. |
| `work.html` | The app with the Work pane's contents, specified in `docs/design/work-pane.md`: a task's files and the bot's workspace, the reader and its changes, the way from a step to its file and back; the cards for what a bot sends, their menu, and the media viewer; and the bot's computer: watching its browser, taking control and handing it back, the machine and its state (Juniper's task "Library e-book apps compared" has every kind of card and the browser). The bar has the events the pane reacts to ("Otto edits the notes", "The write finishes", "Otto runs a command", "Juniper closes its tab", "The lease ends"). Open Otto's task "Disk almost full on the media box", then the Work pane. |
| `search.html` | The app with what `search.md` adds: the search palette (⌘K, or the rail's search button), what each source covers, its groups and their partial, failed and offline states, opening each kind of result in its place or saying why it can't, "Search each bot for more", the link confirmation, and at phone width the full-screen search with scopes. `search.md`, section 15, lists its states and the queries that show each path; `tools/checks/search.mjs` checks them. |
| `controls.html` | The app with what `controls.md` adds: in a bot's Settings tab, what it may do (each line opens its rule, with rules about what a tool acts on), messaging other bots, its memory, its usage and budget, and where it runs; in Settings, Permissions (rules for every bot, saved approvals, activity), shared Memory, Usage and Machines. `controls.md`, section 23, lists its states; the gallery's Controls section links to each. |

The dark bar at the top is prototype chrome, not part of the product. It switches the theme, the width of the frame the app sits in (full, 1100, 800, phone) and reduced motion.

## States from the address

Every setting can be given in the address, which is how the screenshots are taken. Add `chrome=0` to drop the bar and let the app fill the window.

| Parameter | Values |
|---|---|
| `theme` | `light`, `dark` |
| `width` | `full`, `1100`, `800`, `phone` |
| `motion` | `full`, `reduce` |
| `bot`, `task` | A bot and one of its tasks to open, for example `bot=juniper&task=j2` (app) |
| `unfold`, `fold` | Bots to unfold or fold, by id (app) |
| `showall` | A bot whose six-row cap is lifted (app) |
| `pin`, `pinopen` | Bots to pin, by id, and the pinned bot whose tasks show, for example `pin=pip,juniper,otto&pinopen=pip`; `rail=pinned` pins Pip and Juniper (app) |
| `menu` | `new`, `gateway`, or `bot` with `menubot=<id>` (app) |
| `panel` | `open` (app) |
| `tab` | `details`, `files`, `computer` (app) |
| `view` | `list`, `detail` (app, one-pane layout) |
| `banner` | `reconnecting`, `offline`, `syncing`, `synced`, `failed` (app) |
| `screen`, `slow`, `returning`, `os`, `host`, `name`, `addr` | One state of `setup.html`, by id (section 19 of `setup.md` lists them and the walks); `slow=1`: the "Still looking" line; `returning=1`: a return visit with a remembered computer; `os=windows`: the Windows first screen; `host=<operation>`: that state with the host's confirmation open, for example `host=trustKey`; `name`: the SSH destination in the walk, always shown as text; `addr`: the validated address a pasted code leads to (setup) |
| `state` | `empty`, `loading`, `readonly`, `newtask`, `loaderror`, `nobots`, `discovering`, `zerotasks` (app); `error`, `busy` (connect); `copied`, `selected` (pairing) |
| `section` | One section of the gallery, by id (gallery) |
| `tier` | `read`, to start the scripted run on a read-only connection (scripted run) |
| `scene`, `at` | `short`, `long`, `thought`, `t3`: one of the test runs in place of the scripted run; `at=end` draws its end at once (scripted run) |
| `stopfail` | `1`, to make the first Stop request fail (scripted run) |
| `files` | `loading`, `empty`, `error`, `stale`, `writing`, `commands`, `many` (Work pane) |
| `folder` | A workspace folder to open: `/`, `notes`, `logs` (Work pane) |
| `file`, `fileview` | A file to open in the reader, for example `file=notes/disk-2026-11-16.md&fileview=changes`; views are `preview`, `source`, `changes` (Work pane) |
| `artifact`, `viewer` | An item the bot sent, opened in the pane or in the media viewer, for example `bot=juniper&task=j2&artifact=a-terms` or `viewer=a-usage` (Work pane) |
| `artifactload`, `thumbs` | `failed`: the first opening of an item fails; the gateway's thumbnail for a large picture fails. `thumbs=original`: the thumbnail comes back as the original, over 2 MB (Work pane) |
| `computer` | `noplugin`, `unconfigured`, `unused`, `closed`, `watching`, `full`, `draining`, `control`, `busy`, `unsettled`, `conflict`, `ended`, `offline`, `nodeunknown`, `stuck`, `active`, `elsewhere`, `releasefail`, `releaseunknown`, `complexquestion`; with `firstwatch=1` for the one-time note, and `takerace=grant` for a grant that wins the race against a withdrawn take (Work pane) |
| `checkout` | `1`: Changes adds the checkout's comparison (Work pane) |
| `repo`, `taskroot` | `repo=1`: the task works in a repository the gateway keeps; `taskroot=worktree`: an ordinary folder of its own, not established as the bot's workspace (Work pane) |
| `open` | `create` or `settings`, a dialog to open (bots) |
| `step` | `look`, `account`, `approvals`, `connect` (bots, New bot) |
| `perm`, `approvals`, `readback`, `label`, `retry`, `roster`, `defperm` | The host's results for New bot's Approvals step and Create, chosen independently of the clicks (bots, `bots.md` §3, `controls.md` §10): `perm=ask` or `full`, the choice (nothing is chosen by default); `approvals=deny`, the approvals file read before Create blocks commands; `readback=pending`, `mismatch` (it reads Never) or `fail`, the read of the saved setting; `label=guarded`, `full`, `read-only` or `none`, the gateway's reported default command policy; `retry=fail` or `gone`, what Write it again finds; with `state=nobots`, `roster=used`, `legacy`, `missing` or `fail`, replies that aren't a confirmed unused implicit main; `defperm=guarded`, `full`, `read-only` or `none`, Main's reported policy on the first-bot prompt below admin |
| `section`, `account` | A Settings section, `accounts` or `integrations`, and an account's page by its id, for example `account=openai:work` (bots) |
| `connect`, `stage` | A sign-in method by its id, for example `connect=xai/xai-oauth`, and its stage: `starting`, `waiting`, `checking`, `connected`, `failed`, `expired`, `cancelled`, `dropped`, `busy`, `domain` (bots) |
| `apikey` | `open`, the API key path opened (bots) |
| `access` | `read`, `write` or `admin` (the default), what the connection may do (bots) |
| `req` | The request for admin access: `asking`, `requested`, `denied`, `expired`, `failed` (bots) |
| `accounts`, `chosen`, `name`, `create` | `accounts=none` for no accounts; the account chosen in the Account step; the new bot's name; `create=creating`, `slow`, `failed`, `timeout` (Create's reply lost: not confirmed), `partial` (the restrictive step didn't read back) or `conflict` (the config's hash changed before the policy write) (bots); `state=nobots` on `bots.html`: the gateway's replies for a confirmed unused implicit main, and the first-bot prompt |
| `tab=settings`, `bview` | The bot's Settings tab in the Work pane (with `panel=open`), and a page in it: `account`, `change`, `t3` (bots) |
| `lock` | What the page last read of the open bot's lock: `bound`, `watching`, `locked`, `stale`, `gone`, `readfail`, `old`, `multi` (bots). The prototype bar's "Gateway: lock set", "Gateway: lock cleared" and "Gateway: order unreadable" change the gateway's side, which the page then reads by itself |
| `defacct`, `accts`, `saved`, `log`, `xaitools` | `defacct=<id>`: the gateway's default model names that account; `accts=loading` or `error`: the Account step's list; `saved=1`: an unclean sign-in that saved a credential; `log=none` or `gap`: the gateway's log unreadable or partly missed; `xaitools=1`: xAI's tools switched on for every model (bots) |
| `served`, `fail`, `differs`, `running`, `long`, `bstate` | `served=1`: Marlow's last run was served by another account; `fail=quota` or `signedout`: Otto's last run failed on its account; `differs=1`: Pip's model has fallbacks; `running=1`: the open bot has a run in progress; `long=1`: a long account label; `bstate=loading` or `error` (bots) |
| `t3`, `t3server`, `t3obs`, `t3signin`, `t3origin`, `t3listing`, `t3plugin`, `t3found`, `t3withheld`, `t3catalog`, `t3write` | `t3=on` turns the integration on for this person; `t3server=none`; `t3obs=none`, `saved`, `worked`, `refused`: what Clawtrate last observed of the gateway's sign-in; `t3signin=starting`, `waiting`, `failed`, `expired`, `cancelled`: the app-started sign-in; `t3origin=1` when this connection can start it; `t3listing=notconnected` or `stale`; `t3plugin=0` without Clawtrate's plugin; `t3found=1` a bot with the tools that was not turned on; `t3withheld=1` a bot turned on whose tools the gateway withholds; `t3catalog=loading` or `error`; `t3write=refused`, `timeout` or `partial`: how the next gateway write ends (bots) |

`device.html` takes `theme`, `width`, `motion` and `chrome`, and `screen`, `access` (`read`, `write`, `admin`) and the state parameters that `device-node.md`, section 15, lists. `work.html` takes every parameter `app.html` takes; `work-pane.md`, section 22, lists its own. `routines.html` takes `theme`, `width`, `motion` and `chrome`; `automation.md`, section 18, lists its own. `controls.html` takes every parameter `bots.html` takes; `controls.md`, section 23, lists its own.

## Checks

The pages' behaviour is checked in a headless browser, from disk, with no server and no network. From the repository root, after `pnpm install` and, once, `pnpm exec playwright install chromium`:

```
node docs/design/prototype/tools/checks/shell.mjs
node docs/design/prototype/tools/checks/conversation.mjs
node docs/design/prototype/tools/checks/work.mjs
node docs/design/prototype/tools/checks/bots.mjs
node docs/design/prototype/tools/checks/actions.mjs
node docs/design/prototype/tools/checks/routines.mjs
node docs/design/prototype/tools/checks/setup.mjs
node docs/design/prototype/tools/checks/controls.mjs
node docs/design/prototype/tools/checks/device.mjs
```

Each prints one line for every check, `ok` or `FAIL`, then a count, and exits with a failure when any check fails. `shell.mjs` covers the rail, tasks, pins, menus, the Work pane, the status strip and the pairing screen. `bots.mjs` covers `bots.html`: creating a bot with its account and its command policy (the Approvals step, the one Create sequence and its write log, each read-back outcome and retry, the first-bot prompt and the replies that keep the normal roster), every stage of the three kinds of sign-in, the API key path, labels, the request for admin access, Settings and its Accounts section, a bot's settings with bound and locked accounts, changing an account, the served line, failures on an account, T3 Code on and off, and the phone width. `conversation.mjs` plays the scripted run through its visible controls and covers action cards and Raw, copy, the Messaged cards, approvals and their form, questions, held and queued messages, Stop, a lost connection, the read-only tier, the phone width and the gallery. `actions.mjs` covers the action cards: every kind's label in order, outcomes that are not done, real operation shapes, states, levels, folds with mixed states and what breaks them, the general card, T3 Code recognition and thread identity, a launch becoming the T3 Code card in place with its open state and focus, joining, every joined call's own Raw, navigation by identity, reasoning, the run line, the test runs, the cards in the scripted run, the read-only tier, and the phone, where every state keeps its object readable. `setup.mjs` covers `setup.html`: it clicks through every walk of `setup.md` section 19 and asserts where each click leads, checks every state's words, its title taking focus and being announced, every host confirmation's words, that a confirmation with a checkbox cannot be confirmed before it is ticked, that focus stays inside it and everything behind it is inert, that Escape returns focus, what each state may and may not offer (no pairing without the host's dialog, no Approve from here on 2026.10.6, the command with Copy and each read-back outcome after a manual approval, the future exact path's dialog and outcomes, no code for a phone, no Tailscale switch, no setup over SSH or on Windows, Advanced for an untested version or an uncertain look, retries through a new confirmation), the SSH field refusing what is not an SSH destination, a destination from the address shown as text, Back keeping the typed host, a pasted code refused for every unsafe case without showing its token, the step lists, Up, Down and Home in the first screen's list, no sideways scroll at 1100, 800 and phone width, and reduced motion. `controls.mjs` covers `controls.html`: what a bot may do and every state of that page, one line's rule and its saves, rules about what a tool acts on and their limits, messaging policy, rules for every bot, saved approvals and revoking, activity and its filters, memory with editing, import and clearing, shared memory, where a bot runs, machines and devices, usage, daily and weekly warning budgets, the conversation's lines, the gallery's Controls section, and the phone width. `work.mjs` covers the Work pane: the Files tab and the workspace, the reader, downloads, the states the gateway's limits produce, the way between steps and files, the cards, their menu and the viewer, watching and control, every state where watching is not available, the machine, and its keyboard paths. `device.mjs` covers `device.html`: every walk of `device-node.md` clicked through to where it leads (turning on with admin on both devices and its failures, unavailable below admin; the owner's choice for each app in both orders with this device's own decision, and its failures; Turn off and removing from the allowlist; Stop with the gateway reachable, unreachable and removed; approving, rejecting and a vanished request for another device; the permission card to each acknowledgement, the timing rule, two requests, and the route at 61 minutes; the share sheet with an edited note, a known no-send, a lost reply and Cancel; Send Message locked, handed off, cancelled and sent), each state's words, what each tier is not offered, that no state names who asked or says whose chat, that supplied names stay text, the dialogs' focus, Tab trap, inertness and Escape, the radio group's keys, and every state at 1440, 1100, 800 and 390 in both themes with no sideways scroll, no page error, none of the words the design rules out and no claim of where a request came from. [The routines checks](tools/checks/routines.mjs) cover reading, editing, running and deleting routines, check-ins, responsive layout and the gallery. Set `OPENCLAW_PACKAGE_DIR` to compare the cron expressions and requests with the pinned gateway.

## Files

| File | What it is |
|---|---|
| `css/tokens.css` | The token set to copy into `packages/ui/src/styles/tokens.css`. Step 2 of the change list in `visual-language.md` names the four layout sizes that change later. |
| `css/app.css` | The shell's styles, written against the shell's own markup and in the order of the change list in `visual-language.md`. |
| `css/conversation.css` | The conversation components' styles. |
| `css/bots.css` | The styles `bots.md` adds: dialogs, the picture picker, choice rows, model and effort, sign-in stages, switches, Settings. |
| `css/prototype.css` | The control bar, the frame and the gallery's layout. Not product code. |
| `js/icons.js` | The icon set and the bot characters, drawn for Clawtrate. |
| `js/prototype.js` | The theme, width and motion controls. |
| `js/app.js` | The local model behind `app.html`: bots, tasks, selection, folding, pins, menus, sending, the connection, the Work pane. |
| `js/connect.js` | What the buttons on the connection screens do. |
| `js/components.js`, `js/samples.js`, `js/behaviors.js` | The conversation components' markup, their sample content, and their behaviour: the two views of a step, Raw, copy, the approval form, question cards and the keyboard paths. |
| `js/kinds.js` | The action cards: the table from a tool's name to a kind and its words, each kind's result adapter, the card, the fold, the "Thought" line, the run line, and the small engine that places and folds cards. The prototype of the core's mapping. |
| `js/scenes.js` | The runs that test the action cards, and their player. |
| `js/gallery.js`, `js/run.js` | The gallery and the scripted run. |
| `css/work.css`, `js/work.js`, `js/work-artifacts.js`, `js/work-computer.js` | The Work pane's contents and their local model: files in `work.js`, artifacts and media in `work-artifacts.js`, the computer in `work-computer.js`. The browser page shown in the computer view is drawn here; its site is invented. `work.js` extends `app.js` through `CT.appExtension`, a set of optional hooks that `app.html` does not use. |
| `js/bots.js`, `js/bot-settings.js`, `js/t3.js` | The screens of `bots.md` on top of `app.js`, one file per part: New bot, connecting accounts and Settings; a bot's settings with its account and lock, the served line and failures; T3 Code. Accounts, sign-ins and models are local fixtures. |
| `css/routines.css`, `js/routines.js` | The screens of `automation.md` and their local model: routines, runs, check-ins and the clock, fixed at Wednesday, Nov 18, 2026, 10:12 AM in New York. The schedule words and the calendar's occurrences are computed here from each fixture's schedule. |
| `css/controls.css`, `js/controls.js`, `js/controls-memory.js`, `js/controls-usage.js` | The screens of `controls.md` on top of `bots.js`, `bot-settings.js` and `t3.js`: permissions, rules, saved approvals, activity and messaging; memory; usage, budgets and machines. Every rule, grant, memory item and figure is a local fixture. `bot-settings.js` calls their optional hooks (`CT.botsToolsRows`, `CT.botsExtraGroups`, `CT.botsRunsOn`, `CT.botsPageViews`, `CT.botsPageNeeds`), which `bots.html` does not define. |
| `css/setup.css`, `js/setup.js` | The setup screens of `setup.md`: the step list, the fingerprint, the found card, the QR code and the countdown, and every state as a function of `?screen=`. The QR code is a picture with the right look, drawn from the code's characters; the app draws a real one. The fingerprints and setup codes are invented, and the codes carry the word "sample" where a token would be. |
| `css/device.css`, `js/device.js` | The screens of `device-node.md`: This Mac and This iPhone, the owner's choice, the permission card, Machines' block, the share sheet and the Siri panel, every state a function of `?screen=`. The host's dialog, the sharing app and Siri's panel are stand-ins; device names, request ids and the trail site are invented. |
| `tools/make-local-fonts.mjs` | Builds the ignored local font stylesheet. |
| `tools/checks/` | Headless checks of the pages' behaviour: `device.mjs` for the device page, `shell.mjs` for the app and pairing pages, `conversation.mjs` for the scripted run and the gallery, `actions.mjs` for the action cards and the three test runs, `work.mjs` for the Work pane, `bots.mjs` for the bots page, `routines.mjs` for the routines page, `controls.mjs` for the controls page, `setup.mjs` for the setup page. |

## Fonts

The design uses Figtree and JetBrains Mono. Both are under the SIL Open Font License 1.1. No font file is in this repository, so a fresh copy of the pages falls back to system fonts, and text widths and wrapping then differ from the design.

To render the pages in the design's faces, run this once from `docs/design/prototype/`:

```
node tools/make-local-fonts.mjs
```

It fetches `@fontsource-variable/figtree@5.3.0` and `@fontsource-variable/jetbrains-mono@5.3.0` from the npm registry with `npm pack`, and writes `fonts.local.css` beside the pages with both faces embedded. That file is ignored by git. The script is the only thing here that uses the network; the pages never do.

Before taking screenshots, check that the face loaded. In the browser's console:

```
document.fonts.check('15px "Figtree Variable"') && [...document.fonts].some((f) => f.family.includes("Figtree") && f.status === "loaded")
```

## The product mark

The connection screens show the product's own mark, `packages/ui/src/assets/logo-mark.png`, by relative path. It is never copied here or redrawn.

## What is drawn here and what is not

Every icon and avatar was drawn for this project. The product mark is the app's own file and is not copied here. Bot names come from the development gateway's seed data. The tasks, the machines and the text in the conversations are invented. On the bots page, the account labels, profile ids, codes, links (`sign-in.example`), model names and the sign-in methods' wording are samples; providers are named in text, with no logo.
