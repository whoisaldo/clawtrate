# Remote access through the relay

How a person reaches their own OpenClaw gateway from their iPhone, anywhere, through Clawtrate's relay (issue #254): "Connect a phone" on the desktop, "Approve from here" for the phone's request, the "Remote access" row in Settings, Gateway, and the iPhone's screens from scanning a code to the states it shows later. It replaces `setup.md` §12 and extends its §13, in the same language, tokens and components as `setup.md`.

What must be true is in `docs/parity.md`, rows F-500, F-506 and F-507; section 9 lists the rewordings and the questions for a decision. What the gateway, the connector, the relay and the phone do is in [`docs/research/relay-pairing.md`](../research/relay-pairing.md) (cited as "research §n"). Every state below names the fact it rests on, and section 8 lists them.

The pieces are being built in open pull requests and none is on `main`: the protocol (R1, #253), the relay (R2, #281), the connector (R3, #285) and core's relay route (R4, #270). This design matches their commands, messages and close codes as they are on those branches. Where a step depends on one of them it says so, and the claim is read from that branch.

The prototype is `prototype/remote.html`, with the state in the address. Its behaviour is `prototype/js/remote.js`, its few styles `prototype/css/remote.css`, and `prototype/tools/checks/remote.mjs` walks every path to its outcome.

## Contents

1. How the pieces fit
2. Rules for this flow
3. What the relay sees and keeps
4. Connect a phone, on the desktop
5. After the code is used: approving, and what else can happen
6. Settings, Gateway: Remote access
7. The iPhone
8. What each fact drives
9. Parity rows
10. For builders
11. Not covered here

## 1. How the pieces fit

```
desktop, a route with a shell (this computer or SSH)
  Settings, Gateway, Remote access: Off           "Connect a phone…"
    the host confirms turning it on               on the gateway's computer:
      put the connector there                       Clawtrate's connector, in its own folder (waits for a distribution)
      trust this computer's own proxy               clawtrate-connector setup: gateway.trustedProxies ∪ {127.0.0.1, ::1}, read back
      start the connector                           the person runs the printed service command; status read back
    the host confirms making a code               clawtrate-connector pair-phone --json (openclaw qr --voice-node inside)
  the code: QR, text, expiry, the connector's key code; who can use it
  the code is used                                status: a phone was added; then the gateway's devices are read
    a request for read                            "Approve from here…" (the host confirms), or the command
    a request for more                            not approvable here; the reject command
    a device let in by the code alone             said, with Remove
  Remote access: On                               connector status, phones with Remove, Turn off
iPhone
  Scan or paste a code                            a Clawtrate code: the relay route; a setup code: setup.md §13
  review                                          the relay's address, the computer's key code, the expiry
  connecting, waiting for approval                its device code; the approve command
  later                                           relay unreachable, connector offline, removed, revoked
```

A phone reaches the gateway this way:

```
iPhone ── wss ──► relay ◄── wss ── connector on the gateway's computer ── ws://127.0.0.1:<port>, X-Forwarded-For ──► OpenClaw
```

The phone and the connector run a Noise IK channel inside the relay's sockets; the phone pins the connector's key from the code. The connector admits only phones it enrolled with a code, and opens its own loopback socket to the gateway for each, always with `X-Forwarded-For`, so the gateway treats each phone as a remote device (research §1, §5). Nothing in the connector or the relay grants anything on the gateway.

## 2. Rules for this flow

`setup.md` §2 applies in full: the host's confirmation, validated arguments, SSH only with the host's own configuration, no shell chosen by Clawtrate, no credential in a log or the interface, what another computer says is data, and every operation names the profile. These are added:

1. **Only on a route with a shell.** "Connect a phone" and the Remote access row's actions exist on this computer and over SSH, for a gateway of the tested version that the look found (`setup.md` §4). An address route shows the row read-only: "Remote access is set up on the gateway's computer." No code is made with an admin connection in this version.
2. **The relay is named before anything contacts it.** The relay's address is fixed in each Clawtrate build. It is shown on the screen that turns remote access on, in the host's dialog, on the code screen and on the iPhone's review. The app reaches no other host unless the person asked for it on a screen that names it. The examples here use `relay.example`.
3. **A relay code is a bearer credential until a phone uses it.** Anyone who presents it first can pose as one of OpenClaw's own apps and be let in by the code alone, without the owner (research §2). The code screen says so, the code is shown only after the host's dialog, and the desktop reads the gateway after the code is used and says what happened (section 5).
4. **The code inside is `--voice-node`.** Settled in research §3: it gives a code holder the least without approval (the node role with read and Talk), and a request for write is refused before it reaches the owner. R3's `pair-phone` uses `--limited` today; it changes one argument (section 9).
5. **Clawtrate approves only exactly read.** "Approve from here" approves a request only for the operator role with exactly `operator.read`, from the device the person compared by its code, and reads the result back. Anything else is approved, rejected or removed by the person with the gateway's own commands, which the screen shows.
6. **Words about the relay stop at what R1 and R2 establish.** The screens may say that the relay passes the connection on without being able to read it, and that only the computer holding the key in the code can. That rests on R1's Noise IK with the pinned key, its Cacophony vectors and second implementation, and R2's end-to-end check that no frame carries text, secrets or keys in the clear (research §8). They never say "secure", "private" or "end-to-end encrypted", and the line ships only after the independent review of R1 that the plan requires.
7. **Free text from programs is never shown.** The connector's `lastExit`, OpenClaw's error output and the relay's reasons are read into typed facts in memory and shown as fixed copy.

## 3. What the relay sees and keeps

For this design, and for the website's privacy text later (R8 publishes it):

> Clawtrate's relay passes the connection between your iPhone and the connector on your gateway's computer. It sees the addresses of both, when each connects and disconnects, how much each sends and when, and a random id for your connector. It can't read what they send: that is sealed with a key only your connector holds, and your iPhone checks that key against the code it scanned. The relay keeps your connector's id with its public key, so that no other computer can take the id, records of recent sign-ins for an hour, and counts per minute to limit abuse. It keeps nothing of what your phone and your gateway say to each other, and it can't let a phone into your gateway: your gateway decides that. Your phone's address is passed on to your gateway, which records it with the phone's device.

Each sentence comes from R2's README ("What the relay sees", "State and hibernation") and research §8, read from the branch. What a deployed relay logs is decided with its hosting (R8); the paragraph is checked against that before it is published.

## 4. Connect a phone, on the desktop

**Where.** Settings, Gateway, the Remote access row (section 6): "Connect a phone…" when remote access is off, "Connect another phone…" when it is on.

### 4.1 Turning remote access on

The dialog's title is "Connect a phone". It explains, then asks the host.

- "Your iPhone can reach this gateway from anywhere through Clawtrate's relay, relay.example." (15)
- A fact block:

|           |                                                                                                                                                                                              |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Relay     | "relay.example passes the connection on and can't read it. It sees addresses, times and sizes." with a disclosure, "What the relay sees and keeps", holding section 3's paragraph            |
| On devbox | "Clawtrate's connector, in its own folder. It connects to the relay and to the gateway on devbox only."                                                                                      |
| Gateway   | "Clawtrate adds 127.0.0.1 and ::1 to the gateway's trusted proxies, so each phone that comes through the relay waits for your approval. Turning remote access off puts back what was there." |
| Phones    | "Each phone uses a one-time code, then waits for you to approve it, read-only."                                                                                                              |

- A `--warn` note when the look saw a Tailscale Serve route that Clawtrate did not make (`setup.md` §14, F-512): "**A Tailscale route to this gateway that Clawtrate didn't make will start to work too.** The gateway refuses it today because it adds forwarded headers. Once it trusts this computer's own addresses, it accepts it as a remote route, and new devices through it wait for approval." (`setup-flow.md` §3, and R0's note on branch `relay-r0`.)
- "Turn on remote access…" (primary), which asks the host, and "Cancel".

**The host's dialog**: "Turn on remote access for the default gateway on devbox?" (on this computer: "…on this computer?"), with the detail "Clawtrate puts its connector on devbox, which connects to relay.example, and adds 127.0.0.1 and ::1 to gateway.trustedProxies." Over SSH, the account line of `setup.md` rule 3 comes first.

**The steps**, title "Turning on remote access", in a step list (`setup.md` §2):

| Step                                      | What the host runs (section 10)                                                                  | Done when                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| "Putting Clawtrate's connector on devbox" | Waits for a distribution (below)                                                                 | The program answers with its version, the one built with this Clawtrate       |
| "Adding this computer to trusted proxies" | `clawtrate-connector setup --relay <relay> --gateway-port <port> [--openclaw-profile clawtrate]` | `status --json`'s record reads back `applied` covering loopback (research §5) |
| "Starting the connector"                  | Nothing: the person runs the service command (4.2)                                               | `status --json` says `running` is `connecting` or `registered`                |
| "Reaching the relay"                      | `status --json` every 4 s                                                                        | `running` is `registered`                                                     |

Step 2's line under it says what it found, from the record: "Added 127.0.0.1 and ::1 (there were none)", "Added ::1 (127.0.0.1 was there)", or "Already there; nothing changed". The change applies to the running gateway with no restart (research §5).

**Putting the connector there** is the one step this design can't specify to the end: no unit packages the connector yet (R3 is a package in this repository, run with Node). It waits for a distribution, which R5 decides. Whatever it is must meet `setup.md` §10's standard: a version pinned to this Clawtrate, checked against a hash built into it before anything runs, installed into a folder of Clawtrate's own on that computer (never under `~/.openclaw`), and over SSH sent by the constant `/bin/sh -s` script with only validated values. Until then the prototype draws the step and its failure.

### 4.2 Starting the connector

The connector never loads its own service. `setup` writes a LaunchAgent and a systemd user unit and prints the command to load them (research §7). Clawtrate doesn't install services for the person in this version either, so this step is theirs, in the pairing screen's form (`visual-language.md` §10):

- Title "Start the connector on devbox", and "Run this on devbox, in a terminal you trust. It keeps the connector running when you log in." (On Linux: "…when your session starts.")
- The command block with its copy button: the exact line `setup` printed for the computer's system (the LOOK's `uname -s`), for example `cp '<connector folder>/service/dev.clawtrate.connector.plist' ~/Library/LaunchAgents/ && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.clawtrate.connector.plist`.
- The waiting line: "Waiting for the connector, checking again in 4s", and "Check now".

When `status --json` reads `registered`, the steps finish and the next screen opens (4.3). The connector folder in the command is a path the host chose itself, validated as `setup.md` §19 validates paths.

**Failures while turning on**, each a `--danger` note under the step list, in fixed copy, with what is left on the gateway's computer:

| Fact                                                                 | Note                                                                                                                         | What is left                                                                                                    | Actions                                |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| The connector couldn't be put there                                  | **Putting Clawtrate's connector on devbox failed.** "Nothing was changed on the gateway."                                    | Nothing                                                                                                         | "Try again" (a new dialog)             |
| `setup` exits non-zero before writing (`openclaw config get` failed) | **Clawtrate couldn't read the gateway's settings.** "Nothing was changed on the gateway."                                    | The connector's folder and keys                                                                                 | "Try again"                            |
| `setup` refused: the value changed after an earlier `setup`          | **The gateway's trusted proxies changed after Clawtrate set them.** "Clawtrate left them as they are. Check them on devbox." | The value as the other change left it; the connector's record of the earlier value                              | "Look again"                           |
| The value reads back other than the union                            | **The gateway's trusted proxies didn't read back as expected.** "Clawtrate didn't go on."                                    | Whatever the gateway reports, shown as the list it read; the record, so Turn off can put back the earlier value | "Turn off remote access…"              |
| The connector stays `waiting` or `connecting` for 60 s               | **The connector on devbox can't reach relay.example.** "Check that devbox can reach the internet. Clawtrate keeps checking." | The connector running and retrying; the trusted proxies set                                                     | "Check now", "Turn off remote access…" |

Back during the steps stops what the host is running. A step that already finished stays done and is said: the Remote access row shows what is set (section 6).

### 4.3 Making a code

With remote access on, the dialog shows one field, "Phone's name" (a pill field with "iPhone" filled in; 1 to 64 printable characters, as the connector takes it), and "Make a code…" (primary). The host's dialog: "Make a code for a phone to use devbox's gateway?", detail "Until a phone uses it, anyone who scans it can connect to this gateway. It works once, for up to 10 minutes." Then the host runs `clawtrate-connector pair-phone --name <name> --json` and reads `{code, expiresAtMs, relayId}`.

**The code screen**, title "Scan this with Clawtrate on your iPhone":

- The QR code of the code, 240 px, on white with a 16 px margin in both themes.
- "Or paste the code:" over the code in a read-only mono field, with its copy button.
- A fact block: Expires "20:41 (in 9 minutes)", counting down each minute; Relay "relay.example"; Connector key "7Q2F-KWLM" (the key code, section 10), with "Your iPhone shows the same key before it connects."
- A `--warn` note: "**Show this code only to your iPhone.** Until your iPhone uses it, anyone who scans it can connect to this gateway without your approval, posing as one of OpenClaw's own apps."
- The waiting line: "Waiting for a phone to use this code, checking again in 4s".
- "Done" (default). Its hint: "Closing this doesn't cancel the code. It works until 20:41 or until a phone uses it." Neither the connector nor OpenClaw can withdraw a code (`setup-flow.md` §3.1; R3 has no command for it).

**When is it used?** The host reads `status --json` every 4 s. The code is used when a phone with this name appears whose `addedAtMs` is after the code was made, and the open codes count went down. Then the screen goes on (section 5). At the expiry with no such phone, it says "**This code expired at 20:41.** Nothing used it." with "Make a new code…".

**Failures making a code**:

| Fact                                                                | Note                                                                                  | What is left                                                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `openclaw qr` failed inside `pair-phone` (exit non-zero)            | **Couldn't make a one-time code.** "OpenClaw exited with code 1."                     | Nothing new                                                                   |
| `pair-phone` refused: eight codes already open                      | **Too many codes are open.** "Wait until one is used or expires, at most 10 minutes." | The open codes, until they expire                                             |
| `pair-phone` refused: 32 phones                                     | **This connector has 32 phones.** "Remove one in Settings first."                     | Nothing new                                                                   |
| `pair-phone` refused the setup code (other fields, another address) | **OpenClaw made a code Clawtrate can't use.** "Nothing was handed out."               | OpenClaw's own setup code, unused, until it expires (no command withdraws it) |

## 5. After the code is used: approving, and what else can happen

When the connector reports the phone, the host reads the gateway's devices (`openclaw devices list --json`) every 4 s for the code's remaining life, and shows one of these. They are told apart by the gateway's own fields (research §2, §4):

| The gateway lists, made after the code                                                                                                                 | Screen                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| A pending request: `clientId` `gateway-client`, `role` `operator`, `roles` `["operator"]`, `scopes` `["operator.read"]`, not a repair, with `remoteIp` | A phone asks to read (5.1)                                               |
| A pending request with anything else                                                                                                                   | A phone asks for more (5.3)                                              |
| A paired device with `approvedVia` `bootstrap` and a `remoteIp`                                                                                        | Let in by the code (5.4)                                                 |
| Nothing yet                                                                                                                                            | "The phone used the code. Waiting for its request, checking again in 4s" |

### 5.1 A phone asks to read

Title "Approve this iPhone?":

- "A phone used the code and asks the gateway to let it in." (15)
- The phone's device code, large ("7C41-D2E0"), and "Compare it with the code on the iPhone."
- A fact block: Asks for "Read your bots, tasks and conversations"; Name "iPhone" (the name the phone gave, shown as text); Address the relay reported "203.0.113.7".
- "Approve from here…" (primary), and a disclosure "Or approve it on devbox yourself" with `openclaw devices approve <requestId>` for the profile (`setup.md` §9).

### 5.2 Approve from here (F-500)

**Before the dialog**, the host:

1. Reads `openclaw devices list --json` and finds the entry by its request id. It checks the id's form, that the device id matches the one shown, `clientId` `gateway-client`, `role` and `roles` exactly operator, `scopes` exactly `["operator.read"]`, `isRepair` false, and that the device is not already paired.
2. Reads `openclaw gateway call gateway.identity.get --json` on that computer and checks it is the identity this route recorded after its own hello (`setup.md` §15). Over SSH both run through the pinned connection.

**The host's dialog**: "Approve this iPhone read-only on the default gateway on devbox?", detail "Device code 7C41-D2E0. It can read your bots, tasks and conversations, and ask for more later. Asking for more always waits for your approval."

**After confirming**, the host reads the entry again (step 1). If anything differs, nothing runs: "**This request changed since you looked.** Nothing was approved." with the new state shown. Otherwise it runs `openclaw devices approve <requestId> --json` once and checks the answer:

- `requestId` is the one confirmed, there is no `resolved`, and `device` has that device id, role operator and scopes exactly `["operator.read"]`;
- then `openclaw devices list --json` lists the device as paired with `approvedVia` `owner`, roles `["operator"]` and an operator token with exactly `["operator.read"]`.

**What the person sees**: a step list "Checking the request", "Approving it on devbox", "Reading it back"; then "**Approved.** devbox's gateway lists this iPhone with read access." with "Done". The iPhone then reaches hello by itself (its 4-second retry, section 7).

**When the answer differs.** The gateway approves exactly the id it is given. Only the CLI's local fallback can approve a newer request from the same phone, adding at most `operator.pairing`, and it then says so in `resolved` (research §4). The host can't prevent that case, so it says it: "**The gateway approved something other than this request.** It lists this iPhone with: Read, Approve pairing requests." (the scopes read back, as fixed names), with "Remove it from the gateway…" (the host's dialog, then `openclaw devices remove <deviceId> --json` and a read back that it is gone) and "Keep it".

**Failures**: `devices approve` exits non-zero with "No pending device request matches": "**This request is gone.** The phone may have stopped asking, or someone answered it already." The read back fails: "**Clawtrate couldn't read the result.** Look in the gateway's devices before you rely on it." with "Look again".

### 5.3 A phone asks for more

Title "This phone asks for more than read". The device code; the scopes it asks for, as fixed names ("Read", "Send and change", "Approvals"; an unknown one by its id, as text); and "Clawtrate approves only a request for read. Clawtrate on iPhone asks for read alone, so this may not be your iPhone." Then the reject command for the profile, `openclaw devices reject <requestId>`, with its copy button, and "Remove it from remote access…" (6.2). There is no approve button and no approve command. With the `--voice-node` code of rule 4 a request for write is refused before it is filed (research §3), so this screen mostly shows a request for Talk or a role other than operator.

### 5.4 Let in by the code alone

A `--danger` note, title "**A device was let in by this code without your approval.**" "devbox's gateway lists a new device that came through the relay and was approved by the code alone, as OpenClaw's own apps can be. If it isn't yours, remove it." Facts: the device code; it calls itself "node-host" (the client id, as text); Approved "by the code"; Access, the roles and scopes read back. Actions: "Remove it from the gateway…" (the host's dialog, `openclaw devices remove <deviceId> --json`, read back) and "Remove it from remote access…" (6.2). Both say afterwards what is left, step by step.

Clawtrate's own iPhone app never takes this path: it connects as `gateway-client` and asks for read (research §1).

## 6. Settings, Gateway: Remote access

A row in Settings, Gateway, under "Private access with Tailscale" (`setup.md` §14), on a route with a shell. Every value in it is read from `clawtrate-connector status --json` on that computer when Settings opens and every 30 s while it is open, never inferred from what Clawtrate ran (research §7).

### 6.1 The row

| The connector reports                                   | The row                                                                                                                                        | Actions                                             |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| No state folder (`status` exits with "Run setup first") | **Remote access** · "Off. Reach this gateway from your iPhone anywhere, through Clawtrate's relay."                                            | "Connect a phone…"                                  |
| `running` `registered`                                  | **Remote access** · "On. The connector on devbox is connected to relay.example."                                                               | "Connect another phone…", "Turn off remote access…" |
| `running` `connecting` or `waiting`                     | "On. The connector on devbox can't reach relay.example right now. Phones can't connect until it does." (`--warn`)                              | "Check now", "Turn off remote access…"              |
| `running` `stopped` or `not running`                    | "On, but the connector on devbox isn't running. Phones can't connect." (`--warn`), and a disclosure "Start it" with the service command of 4.2 | "Check now", "Turn off remote access…"              |
| `status` failed or printed something else               | "Clawtrate couldn't read the connector's status on devbox." (`--warn`)                                                                         | "Look again"                                        |

Under an "On" row, two groups of facts:

- **Trusted proxies**, from the record: "Clawtrate added 127.0.0.1 and ::1 (there were none before)", or "Already included 127.0.0.1 and ::1; Clawtrate changed nothing".
- **Phones**: one row per phone the connector lets in, its name (as text) and "added 21 Nov", with "Remove…". With none: "No phones yet." A phone the desktop approved from here also shows its device code, from the host's own record (6.2).

### 6.2 Removing a phone

"Remove…" opens the host's dialog "Remove iPhone from remote access on devbox?", detail "It can't reach the gateway through the relay any more. A session it has open ends within seconds." When the host's record links this phone to a gateway device (it approved it from here), the dialog adds a checkbox, unticked: "Also remove its device from devbox's gateway (7C41-D2E0)".

The link is the host's own. When Approve from here approved a request in the same flow in which this phone was added, it records the phone's connector key with the device id. Neither the connector nor the gateway knows the other's id (research §7). Without the record, the checkbox isn't offered and the result says how to remove the device by hand.

**Steps**, each read back:

1. `clawtrate-connector remove-phone <phone key>`; then `status --json` no longer lists the key. A running connector ends the phone's session within 5 seconds (R3); the phone then gets close 4401 (research §6).
2. With the box ticked: `openclaw devices remove <deviceId> --json`; then `devices list --json` no longer lists it.

**What the person sees**: "Removed from remote access." and, with step 2, "Removed from the gateway." Without step 2: "Its device is still on the gateway. To remove it there: `openclaw devices remove <device id>`", with the device id when the record has it. A failure in the middle says what happened to each step: "**Removed from remote access. Removing its device from the gateway failed (exit 1).** The gateway still lists it." with "Try again" for that step alone.

### 6.3 Turning remote access off

"Turn off remote access…" opens the host's dialog "Turn off remote access on devbox?", detail "Phones can't reach the gateway through the relay any more. Clawtrate stops the connector and puts the gateway's trusted proxies back to what they were before (none). The connector's keys and its list of phones stay on devbox, so turning it on again keeps them." The words in brackets are the record's earlier value.

**Steps**, title "Turning off remote access":

| Step                               | What happens                                                                                                                                                                                                                                                                 | Read back                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| "Stopping the connector"           | The person runs the stop command, shown as in 4.2: `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/dev.clawtrate.connector.plist` (Linux: `systemctl --user disable --now clawtrate-connector.service`), with the waiting line. Skipped when it already isn't running | `status --json` says `stopped` or `not running`                                    |
| "Putting back the trusted proxies" | `clawtrate-connector teardown`                                                                                                                                                                                                                                               | `openclaw config get gateway --json` reads the earlier value (absent, or the list) |

The connector is stopped before the setting is restored, so no phone is cut off mid-request by a refused upgrade (research §5, the 1011). The stop commands are the standard ones for a LaunchAgent and a systemd user unit; R3 doesn't print them, and they were not run here (no service may be loaded on this machine).

**Results**, per step:

- "Connector stopped. It reports it isn't running."
- "Trusted proxies put back: none." (or the list). When `teardown` says it changed nothing: "Trusted proxies left as they were: Clawtrate hadn't changed them."
- Someone changed the setting after Clawtrate set it: "**The gateway's trusted proxies changed after Clawtrate set them.** Clawtrate left them as they are: 127.0.0.1, ::1, 198.51.100.0/24. Its record of the earlier value is kept." with "Look again" (research §5).
- The connector still runs after 2 minutes: "**The connector on devbox is still running.**" and the stop command again; the trusted proxies are not touched until it stops.

Afterwards the row reads "Off" from a fresh `status`, and the gateway's devices are untouched: a phone that was approved stays on the gateway until it is removed there.

## 7. The iPhone

### 7.1 The first screen

`setup.md` §13's first screen, with the two buttons "Scan a code" (primary, the camera) and "Paste a code" (default), and the hint "Get a code from Clawtrate on your computer: Settings, Gateway, Connect a phone. A setup code from the gateway's owner works too." Local Network permission isn't needed for the relay.

The host reads what was scanned or pasted, once, in memory. A Clawtrate code is told from a setup code by its fields: R4's `parseRelayCode` reads exactly `v`, `relay`, `relayId`, `connectorKey`, `enroll`, `expiresAtMs` and `openclaw`. A setup code goes to `setup.md` §13's review. For a Clawtrate code that R4 refuses:

| R4's parser says           | Line                                                                            |
| -------------------------- | ------------------------------------------------------------------------------- |
| `expired`                  | "This code has expired. Make a new one in Clawtrate on your computer."          |
| `malformed` or `too_large` | "That isn't a code Clawtrate can use."                                          |
| `bad_expiry`               | "This code's time is wrong. Check the time on this iPhone, or make a new code." |

### 7.2 The review

Title "Connect through Clawtrate's relay?", with Back:

- A fact block: Relay "relay.example"; Computer's key "7Q2F-KWLM"; Expires "20:41 (in 9 minutes)".
- "Clawtrate on your computer shows the same key next to the code. The relay passes this connection on without being able to read it: only the computer holding this key can." (rule 6)
- "Connect" (primary), "Cancel". Nothing is contacted before Connect.

The code carries no name for the gateway's computer, so the review names it by its key. A name in the code would be a label anyone could write; the key is what the phone pins (R4's route).

### 7.3 Connecting and waiting

**Connecting**, title "Connecting", with a step list: "Reaching the relay", "Checking the computer's key", "Asking the gateway to let this iPhone in, read-only". The phone dials the relay, the connector admits it on the code's one-time secret, and the phone connects with the code's bootstrap token as `gateway-client`, asking for `operator.read` alone (R4; research §1).

**Waiting for approval**, title "Waiting for approval", with Back:

- "Approve this iPhone in Clawtrate on your computer. Its device code is:" and the device code "7C41-D2E0".
- A disclosure "Or on the gateway's computer" with `openclaw devices approve <requestId>` and "with `--profile <name>` if the gateway doesn't use the default profile" (`setup.md` §9).
- The waiting line: "Waiting for approval, checking again in 4s". R4 checks every 4 s for 10 minutes, then backs off.

**Connected, read-only**: title "Connected, read-only", "Clawtrate on this iPhone can read your bots, tasks and conversations. Sending or changing anything is asked for later." The app opens with the route stored under the connector's key (R4's route key). A Node phone on core's route reached this end state in research §1; the iPhone app itself is R6.

**Failures while connecting**, in fixed copy:

| R4 reports                                  | Title and line                                                                                                          | Actions                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 4403, the connector refused the code        | **This code was already used, or it expired.** "Make a new code in Clawtrate on your computer."                         | "Scan a code" (first screen) |
| 4502 `relay:connector_offline`              | **The gateway's computer isn't connected to the relay.** "Check that Clawtrate's connector runs there, then try again." | "Try again", Back            |
| 1006, or the 15-second open timeout         | **Can't reach relay.example.** "Check this iPhone's connection, then try again."                                        | "Try again", Back            |
| 4400, 4408, 4413, or 4502 with another code | **The connection to the gateway's computer failed.** "Try again. If it keeps failing, make a new code."                 | "Try again", Back            |
| The gateway refused the bootstrap token     | **The code didn't work.** "Make a new code in Clawtrate on your computer."                                              | "Scan a code"                |

The code's secret and token are wiped once used (R4). "Try again" after the phone has enrolled redials without the secret.

### 7.4 Later

Once connected, the relay route behaves as every route does, with the status strip (`visual-language.md` §11). R4's reconnect policy decides when to try again: backoff from 1–2 s up to 5 minutes, and at once when the app comes to the foreground. It stops on a refusal that only the person can change (research §6).

| What happened                          | R4 or the gateway reports      | The strip                                                                                  | Then                                          |
| -------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------ | --------------------------------------------- |
| No network, or the relay is down       | 1006                           | **Can't reach relay.example** · "showing saved messages", "Retry now"                      | Keeps retrying with backoff                   |
| The connector is stopped or offline    | 4502 `relay:connector_offline` | **Connector offline** · "the gateway's computer isn't connected to the relay", "Retry now" | Keeps retrying with backoff                   |
| The phone was removed at the connector | 4401                           | **Removed from remote access** · "Connect again"                                           | Stops; "Connect again" opens the first screen |
| The device was removed on the gateway  | `AUTH_DEVICE_TOKEN_MISMATCH`   | **Not accepted by the gateway** · "Connect again"                                          | Stops; drops this route's device token        |
| Back after either of the first two     | hello                          | **Connected again** for 4 s                                                                |                                               |

The strip's state words are short so that they show in full at phone width; its explanation shortens first (`visual-language.md` §11). A 1006 can't tell a relay that is down from a phone with no network, so the strip names the relay as what it can't reach and says no more.

## 8. What each fact drives

| Fact                                                                                     | Source      | Shown                                                                   |
| ---------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------- |
| A relayed phone's first pairing waits, then hello with exactly read                      | research §1 | Waiting for approval; Approved; Connected, read-only                    |
| A code holder posing as OpenClaw's app is let in by the code, `approvedVia: "bootstrap"` | research §2 | The code screen's warning; Let in by the code alone                     |
| `--voice-node` refuses a request for write; `--limited` files it                         | research §3 | The code inside is `--voice-node`                                       |
| The pending entry's fields; a request never widens under its id                          | research §4 | Approve from here's checks; "This request changed"                      |
| `devices approve --json` returns `{requestId, device}`; `resolved` on a replacement      | research §4 | Approved; "The gateway approved something other than this request"      |
| `gateway call gateway.identity.get`                                                      | research §4 | The identity check before approving                                     |
| `setup`'s record, union and read back; live without a restart                            | research §5 | "Adding this computer to trusted proxies" and its line; the row's facts |
| `teardown` restores exactly, or refuses a value someone else changed                     | research §5 | Turn off's results                                                      |
| Without trusted proxies the gateway refuses the connector: the phone gets 1011           | research §5 | Stop the connector before restoring                                     |
| 4502 `connector_offline`, 1006, 4403, 4401, `AUTH_DEVICE_TOKEN_MISMATCH`                 | research §6 | The iPhone's failures and its strip                                     |
| `status --json`: `running`, phones, open codes, the record; stale after 90 s             | research §7 | The Remote access row; when a code is used                              |
| The connector never loads its service                                                    | research §7 | Start the connector yourself; stop it yourself                          |
| What the relay sees and keeps; no frame carries plaintext                                | research §8 | Section 3; the review's line                                            |

## 9. Parity rows

Statuses don't change: F-500, F-506 and F-507 stay `todo`.

**Reworded**, in the dependency cell only, with this design's evidence:

- **F-500**: through the relay the pending entry carries `remoteIp`; `devices approve <id> --json` approves that id and returns it with the device; a wider retry gets a new id; the CLI's local fallback may approve a same-device replacement that adds `operator.pairing` (research §4).
- **F-506**: the relay path, `clawtrate-connector pair-phone` (R3, unmerged) with `openclaw qr --url <dial address>`, and that a holder can redeem the code without approval by posing as OpenClaw's app (research §2, §3).
- **F-507**: through the relay, the flow from pending to read-only ran end to end with a Node phone on core's route (research §1).

**For a decision** (not changed; the report proposes wording):

- **F-506's target** says that when the gateway listens only on loopback no code is made, and that a line names "a Tailscale name, an encrypted address, or a local address". Through the relay, a loopback-only gateway is exactly the case where a code is made, and the code leads to the relay. The target needs a relay clause.
- **F-509** says a setup code never gives the device more than read at first. That holds for Clawtrate's phone, which asks for read. A relay code, like any `openclaw qr` code, lets a holder posing as OpenClaw's app take more without approval (research §2). The row is about this client and stays true; this design states the risk instead.
- **The new remote-access row** the plan names (on or off, connector status, phones with Remove, turning it off with each step read back) needs an id: F-518 and F-519 are taken on other branches.
- **R3's `pair-phone`** changes `--limited` to `--voice-node` (rule 4).

## 10. For builders

### What each part uses

| Screen                        | Existing                                                        | New                                                         |
| ----------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------- |
| Connect a phone (dialogs)     | `.b-dialog`, fact block, notes, step list, the host's dialog    | none                                                        |
| Start or stop the connector   | The pairing screen's command block and waiting line             | none                                                        |
| The code                      | Fact block, `.s-code-field`, the copy button                    | QR block (`.r-qr`); the key code in the device code's style |
| Approve, ask for more, let in | Device code (`.s-device`), fact block, notes                    | none                                                        |
| Remote access row             | `.s-rows` in Settings (`setup.md` §14)                          | Phone rows (`.r-phones`)                                    |
| iPhone                        | The connection column, step list, device code, the status strip | none                                                        |

**QR block** (`.r-qr`): the code as a QR code, 240 px square, dark modules on white with a 16 px quiet zone in both themes, radius 14, with `role="img"` and the label "QR code of the code below". The prototype draws a stand-in pattern, labelled as one. **Phone rows** (`.r-phones`): rows of 48 px with the phone's name (15), its date (13, faint), the device code when known (mono, 13), and a small default "Remove…" button. No new tokens.

**The key code** of a connector: the SHA-256 of the connector key's 32 bytes, in RFC 4648 base32, its first eight characters, shown as two groups of four ("7Q2F-KWLM"). Core computes it from the route on the phone, and the host from `status --json`'s `connectorKey` on the desktop.

**The device code**: as in `setup.md` §2, the first eight hexadecimal characters of the device id, upper case, in two groups of four.

### What the host does

New `setup.prepare` operations (`setup.md` §19), each with its dialog:

| Operation                                     | Runs, on the route's computer (this one, or over SSH with the CONNECTOR script)                                 |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `remoteOn {routeId}`                          | puts the connector there; `clawtrate-connector setup …`; then reads `status --json`                             |
| `makeCode {routeId, name}`                    | `clawtrate-connector pair-phone --name <name> --json`                                                           |
| `approvePhone {routeId, requestId, deviceId}` | the reads of 5.2, then `openclaw devices approve <requestId> --json` and the read back                          |
| `removeDevice {routeId, deviceId}`            | `openclaw devices remove <deviceId> --json`, then `devices list --json`                                         |
| `removePhone {routeId, phoneKey, deviceId?}`  | `clawtrate-connector remove-phone <phoneKey>`, then `status`; with `deviceId`, `removeDevice`                   |
| `remoteOff {routeId}`                         | waits for `status` to report not running; then `clawtrate-connector teardown`, then `config get gateway --json` |

Reads, at once: `remote.status {routeId}` (`clawtrate-connector status --json`) and `remote.devices {routeId}` (`openclaw devices list --json`, typed to the fields of section 5).

**Validated values**, besides `setup.md` §19's:

| Value        | Pattern                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------- |
| Phone's name | `^[\x20-\x7e]{1,64}$`, no leading `-`, passed as one argument and never through a shell      |
| Phone key    | `^[A-Za-z0-9_-]{43}$`, decoding to 32 bytes; taken from `status --json`, never from the page |
| Device id    | `^[0-9a-f]{64}$`, taken from `devices list --json`                                           |
| Relay origin | A constant of the build                                                                      |
| Relay code   | R4's `parseRelayCode`, at most 4,096 characters                                              |

**Over SSH**, a CONNECTOR script joins LOOK, CODE, START and STOP (`setup.md` §19): POSIX `sh`, `set -eu`, one fixed connector or OpenClaw command per run chosen by a constant, its only values the validated ones above, assigned by the host, printing one JSON document. The code it prints is read by the host, shown on the code screen and never logged.

**What the host keeps**: per route, whether remote access is on (only as a cache of the last `status`), and the links from phone key to device id that Approve from here recorded. It never keeps a code after its screen closes.

### Order

1. **R3's `--voice-node` change** and the connector's distribution (R5).
2. **The Remote access row, turning on and off** (R5), against an R0 instance, with a Playwright flow checking each read back, including a value changed by someone else.
3. **Making a code and the code screen**, with the "used" and "expired" outcomes.
4. **Approve from here** (F-500), with checks for a stale, a mismatched, a premature and a replaced approval, and for a device let in by the code.
5. **The iPhone** (R6): scan and paste, review, connecting, waiting and the later states, in the Simulator through a local relay.

### The prototype's states and walks

`remote.html?screen=<id>`, with the shared `theme`, `width`, `motion` and `chrome`, and `host=<operation>` to open a host dialog. Dark is this page's default theme. The bar's "State" menu lists every state, and events from outside the app (a phone using the code, the owner approving, the connector reporting) are buttons in a dashed "Prototype" box.

| Walk                                | From                           | Through                                                                                              | To                                                                     |
| ----------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Turn on, then a code                | `settings-off`                 | `intro`, the dialog `remoteOn`, `turning-on`, `start-connector`, `make`, the dialog `makeCode`       | `code`                                                                 |
| The code is used, approve from here | `code`                         | "A phone uses the code", `request`, the dialog `approvePhone`, `approving`                           | `approved`                                                             |
| The request changed                 | `request`                      | "The phone asks again", then the dialog                                                              | `approve-changed`                                                      |
| The answer differs                  | `approving` (`differs=1`)      |                                                                                                      | `approve-differs`, then Remove to `device-removed`                     |
| A request for more                  | `code`                         | "A phone asks for more"                                                                              | `request-more`                                                         |
| Let in by the code                  | `code`                         | "A device is let in by the code"                                                                     | `let-in`, then Remove to `device-removed`                              |
| The code expires                    | `code`                         | "The code expires"                                                                                   | `expired`, then "Make a new code…" to `make`                           |
| Failures turning on                 | `turning-on`                   | "Fail: connector", "Fail: trusted proxies", "Fail: relay"                                            | `fail-install`, `fail-proxies`, `fail-relay`                           |
| Failure making a code               | `make`                         | "Fail: OpenClaw's code", then the dialog                                                             | `fail-code`                                                            |
| Remove a phone                      | `settings-on`                  | "Remove…", the dialog `removePhone` with its box                                                     | `removed`; with `fail=gateway`, `remove-partial`                       |
| Turn off                            | `settings-on`                  | the dialog `remoteOff`, `stop-connector`                                                             | `turned-off`                                                           |
| Turn off, changed elsewhere         | `stop-connector` (`changed=1`) |                                                                                                      | `turn-off-changed`                                                     |
| The connector's states in the row   | `settings-on`                  | "Connector: waiting", "Connector: stopped", "Status unreadable"                                      | `settings-waiting`, `settings-stopped`, `settings-unreadable`          |
| The iPhone, scan                    | `iphone`                       | "Scan a code", `iphone-review`, Connect, `iphone-connecting`, `iphone-waiting`, "The owner approves" | `iphone-done`                                                          |
| The iPhone, paste                   | `iphone`                       | "Paste a code", `iphone-paste`: an expired code, a malformed one, a good one                         | `iphone-review`                                                        |
| The iPhone's connect failures       | `iphone-connecting`            | "Code already used", "Connector offline", "Relay unreachable"                                        | `iphone-used`, `iphone-offline-first`, `iphone-unreachable-first`      |
| The iPhone later                    | `iphone-done`                  | "Relay unreachable", "Connector offline", "Removed", "Revoked"                                       | `later-unreachable`, `later-offline`, `later-removed`, `later-revoked` |

The other states are reached from the bar's State menu or the address: `settings-address` (an address route, the row read-only), `fail-settings`, `fail-readback`, `fail-too-many`, `fail-phones`, `fail-setupcode`, `approve-gone`, `approve-unread`, `iphone-failed`, `iphone-code-refused` and `later-back`; `code-used` is the short wait between a phone using the code and its request; `intro&tailscale=1` adds the Tailscale warning. Every state's words are asserted by the check.

## 11. Not covered here

- Installing the connector: the distribution, its checks and its folder over SSH wait for R5.
- Loading and unloading the connector's service from Clawtrate: the person runs the commands in this version.
- Making a code with an admin connection on an address route (`device.pair.setupCode`), or on a computer without a desktop route; there R3's `pair-phone` prints its own QR code in the terminal.
- A connector filter that refuses a first `connect` from anything but Clawtrate's own client, which would close the gap of section 5.4. It is new machinery and needs a decision.
- Naming the gateway's computer on the phone, and renaming phones.
- A LAN path to the connector, push through the relay (#87), Android, and several relays.
- Listing every device on the gateway; this design shows only those it can tie to the relay flow.
- The relay's hosting, logging and limits in production (R8).
