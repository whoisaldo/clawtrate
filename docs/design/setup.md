# Setting up

How a new person gets from a first launch to a connected, read-only Clawtrate: one question, "Where does OpenClaw run?", then Clawtrate looks there and says what it found. It replaces the address-and-token form as the first screen and keeps that form, unchanged, under "Advanced". This is the fourth part of the design, after `visual-language.md`, `conversation.md`, `bots.md` and `work-pane.md`, in the same language and with the same tokens.

What must be true is in `docs/parity.md`, rows F-491 to F-517 with F-001, F-003 and F-009. What the gateway, OpenClaw's installer and `ssh` do is in `docs/research/setup-flow.md`; every state below names the fact it rests on, and section 17 lists them. Section 19 is for builders.

The yardstick is one person's daily case: OpenClaw on a development box, the desktop app on a laptop, "Another computer", the SSH name of the box, and it works, with no Tailscale step, no token typed and no command run by hand on the box. Everything below is measured against that, and against a person who has never run OpenClaw.

This flow installs software, opens tunnels and approves access, so one rule sits above the rest: **where something cannot be proven safe from what is known, the app does less and says so.** A path that ends in "do this one step yourself; here is the exact command" is acceptable. A path that does something on a person's computer on a guess is not.

Four facts from the research shape the design:

- **A first pairing on the gateway's own computer, or through an SSH forward to it, is approved by the gateway without a prompt**, and ends with exactly the scopes the device asks for (research §1, §3).
- **Clawtrate does not read the gateway's shared token.** OpenClaw's commands refuse to show it to a program. The same user could read OpenClaw's configuration file, and the design deliberately does not. Instead the host makes a one-time setup code on the gateway's computer and redeems it at once, after the person's consent (research §1, §3).
- **A setup code is a bearer credential with a ceiling, not a read-only credential.** On loopback a `--limited` code was redeemed for read and write when both were asked for. A `--voice-node` code was redeemed for read, or for read and Talk, and refused write; it is meant for voice clients and carries a node role. So Clawtrate uses `--voice-node` only privately in the host, redeemed at once for its own read request, and never hands a code out (research §3.1).
- **Asking for more than read access through `device.scopes.requestUpgrade` always waits for approval**, even on the gateway's own computer (research §2). In this version the person approves it on the gateway's computer with the command Clawtrate shows, for the named profile.

The prototype walks every path of this version to its outcome: `prototype/setup.html`, with the state in the address (`prototype/README.md`). The styles are in `prototype/css/setup.css`, the behaviour in `prototype/js/setup.js`, and `prototype/tools/checks/setup.mjs` clicks through every walk and asserts where each click leads, as well as the words and structure of every state.

## Contents

1. How the pieces fit
2. Shared rules: safety, the host's confirmation, routes, components, input
3. The first screen
4. Looking on this computer: what "found" means
5. Another computer: the field, the SSH settings Clawtrate uses, the host key
6. What the look found
7. Connecting, with nothing typed
8. The forward's life
9. Approving a request
10. Setting OpenClaw up (macOS and Linux, on this computer)
11. Removing OpenClaw, or leaving it (not in this version)
12. Connect a phone (not in this version)
13. A setup code on the desktop, and the iPhone's first screen
14. Private access with Tailscale (read-only in this version)
15. Several routes to one gateway
16. Widths, themes, keyboard, screen readers, motion
17. What each fact drives
18. Parity rows
19. For builders
20. Not covered here

## 1. How the pieces fit

```
first launch (desktop)            "Where does OpenClaw run?"
  This computer                     look here: find the gateway, its version and its state
                                    (on Windows: Advanced, or another computer)
  Another computer                  one field: an SSH host or alias; the host confirms the account, host and port
    first contact                     the host key, captured without signing in; the host confirms trust
  Have a setup code?                enter a code with a verified encrypted address; then approval on the gateway
  Advanced                          the address-and-token form, as it was (connect.html)
what the look found               one screen, one primary action, or none
  running, tested version           Connect: the host confirms the pairing, then pairs read-only
  running, untested version         Advanced
  installed, proven stopped         Start OpenClaw (the host confirms)
  not found (macOS, Linux, here)    Set up OpenClaw (what is checked and what isn't; the host confirms)
  not found (another computer)      not offered in this version
the app                           read-only; the status strip says when a forward is being restored
  access bar (bots.md §2)           the profile-qualified approve command to run on the gateway's computer
  Settings, Gateway                 the route, Private access with Tailscale (read-only), Remove this gateway
first launch (iPhone)             Scan or Paste a setup code; review the address; wait for approval
```

The first screen keeps what the old one had: the product's mark, the name, the slogan and the row of bots along the foot (`visual-language.md` §10). Only the form below the slogan changes.

## 2. Shared rules

### Safety, as rules

Written so that a builder cannot read them two ways. Every screen below obeys all of them, and section 19 says how.

1. **The interface gains no power.** It may ask the host to look on this computer. Everything that registers a device, mints a code, runs anything on another computer or changes any computer or gateway is an operation the host prepares, shows in its own confirmation dialog, and runs only after that dialog's answer (below). The interface cannot run one by calling the host.
2. **Every argument is validated before use** against the patterns of section 19, which never admit a leading `-`, spaces, quotes or shell characters. Anything else is refused before any program starts.
3. **SSH runs only with a configuration the host writes.** The host reads the person's SSH configuration as a file and takes a short list of settings from it (section 5). A host whose settings use anything else is refused by name. `ssh` is started with `-F <that configuration>` and the host's fixed options, so nothing in the person's files can run a command, forward another port or weaken host-key checking. The host supplies a private app-data directory whose path remains under its control while the SSH route is in use. Before enabling SSH setup, the host must establish that its app-data directory and ancestors cannot be redirected by another account. The remote account is a trust boundary: sshd starts every remote command through the account's login shell, whose startup files run first. Before any remote script runs, the host's dialog names the full resolved account, host and port, and says "This uses the remote account's SSH login environment." Where the account or route can't be trusted, the person uses a setup code or Advanced instead.
4. **Nothing typed and nothing received is ever interpreted by a shell that Clawtrate chooses.** On the other computer the remote command is always the constant `/bin/sh -s`, and the script arrives on its standard input. The script is a constant of the app; the only values in it are a port and a request id that the host itself read and validated. On this computer no shell is used at all.
5. **Read access first.** Every first connection asks for `operator.read` alone. A code the host makes for its own connection is a `--voice-node` code, used only privately by the host and redeemed at once; it is never given to the interface or handed out. The host accepts the first device token only when the gateway granted the operator role and exactly `operator.read`, and stages it in memory until then (section 7).
6. **No credential in a log, a state snapshot, an error message, a process list or the interface,** on either computer: none in a program's arguments or environment, none in a temporary file, none in tracking or a crash report. Program output is parsed by the host, in memory and within size limits, into typed facts; raw output and free-form messages from programs are never kept or shown. What is shown is fixed copy: the step, the error category and the numeric exit code. There are two named exceptions, each deliberate: OpenClaw keeps an issued code in its own state until the code is used or expires, and there is no command to revoke it; and a code the person pastes is in the interface because they typed it, and is sent to the host once, never stored or logged.
7. **What another computer says is data.** Versions, ports, paths, addresses, names and messages are bounded in size, checked against the expected shape, and shown as text. A remote string never becomes a link, a command or a path the host runs.
8. **A host key is trusted only as one act**: the key the computer presented is captured without signing in, its fingerprint is shown, and those same key bytes are pinned after the host's confirmation. From then on the route accepts that key only. A changed key is never replaced by itself (section 5).
9. **Clawtrate removes and stops only what it owns**, and proves ownership first (section 11). A gateway, a service, a folder or a Tailscale route someone else made is never stopped, changed or removed.
10. **An untested OpenClaw version, or a gateway the look couldn't resolve, goes to Advanced.** No code is minted for it and nothing is run on that computer for the person.
11. **Every operation names the selected profile**: the default profile's commands carry no `--profile`, Clawtrate's own carry `--profile clawtrate`.

### The host's confirmation

Every operation that registers a device or changes something is confirmed in a dialog the host draws itself (a native dialog on the desktop), never in the page. The page leads up to it: the screen says what will happen, and its button asks the host. The host then:

1. Prepares the operation from its own state: the exact computer (the full resolved destination: account, host and port, and the name the computer reported), the route, the gateway instance, the parameters, and the facts it observed in the last look.
2. Shows the dialog with those exact words. Some operations add a checkbox the person must tick first; replacing a host key is one.
3. On the answer, reads the facts again; if anything differs from what the dialog showed, nothing runs, and the page says "This changed since you looked. Look again."
4. Runs the operation once. The prepared operation expires after 2 minutes, cannot be repeated, and cannot be changed by the page. A retry is a new operation with a new confirmation, on the same computer.

| Operation             | The dialog's message                                                  | Its detail                                                                                                                                                                                                                         |
| --------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Use an SSH account    | Look for OpenClaw as you@devbox.example, port 22?                     | "This uses the remote account's SSH login environment."                                                                                                                                                                            |
| Trust a host key      | Trust devbox's key?                                                   | The fingerprint; "Clawtrate will connect to devbox only while it presents this key."                                                                                                                                               |
| Replace a trusted key | Replace devbox's trusted key?                                         | Both fingerprints; checkbox "I checked the new key on devbox itself"                                                                                                                                                               |
| Pair                  | Pair this device read-only with the default gateway on this computer? | "The gateway saves this device."                                                                                                                                                                                                   |
| Start                 | Start OpenClaw on this computer?                                      | The service's name; "It keeps running after Clawtrate closes."                                                                                                                                                                     |
| Set up                | Set up OpenClaw on this computer?                                     | "Clawtrate checks the OpenClaw and Node.js downloads against fingerprints built into this version. Setup also installs code from npm that Clawtrate hasn't pinned or verified. That code can run with your account's permissions." |
| Remove a route        | Remove devbox from Clawtrate?                                         | What is forgotten, and what keeps running                                                                                                                                                                                          |

The web preview host has no native dialogs, so it offers none of these operations. A browser viewing it is on another device, so looking on this computer is off there unless the host is started with an explicit option, and then it looks only in a sandbox (`docs/decisions.md`, "Setting up on this computer").

### Routes

A **route** is how Clawtrate reaches one gateway: the unit Clawtrate saves, and the unit a device token is kept for. Each route has its own token (section 15, `docs/decisions.md`).

| Route         | Made by                          | Its identity                                                                                                         | A shell on the gateway's computer |
| ------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| This computer | "This computer"                  | The OpenClaw profile and its port                                                                                    | Yes, the host's own               |
| SSH           | "Another computer"               | The pinned host key, the resolved SSH target and the gateway's port on that computer; never the forward's local port | Yes, over SSH                     |
| Address       | "Have a setup code?", "Advanced" | The address                                                                                                          | No                                |

### Components used

| Component                                                           | From                               | Used for                                                    |
| ------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------- |
| The connection screen's column, mark, name, slogan and bots         | `visual-language.md` §10           | Every setup screen                                          |
| Pill field (`.input`), primary, default and quiet buttons           | `visual-language.md` §4            | Every control                                               |
| The pairing screen, its command block, copy button and waiting line | `visual-language.md` §10           | Commands, codes, waits, and a pasted code's pending pairing |
| Choice list (`.b-choices`), note (`.b-note`), dialog (`.b-dialog`)  | `bots.md` §2                       | The first question, notes, Settings                         |
| The access bar and its states                                       | `bots.md` §2, `conversation.md` §3 | Asking for more access, with the approve command            |
| The status strip                                                    | `visual-language.md` §11           | A forward being restored; a route that changed              |
| Fact block (`.facts`)                                               | `visual-language.md` §9            | What was found                                              |

### New components

Each is defined once, in `prototype/css/setup.css`, from existing tokens.

| Component                               | What it is                                                                                                                                                                                                                                                                                                                                                                                             | Tokens                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| Step list (`.s-steps`)                  | A vertical list of steps, each a 20 px mark and its words (15). Waiting: a hollow ring in `--text-faint`. Running: the working arc in `--text` (a still ring when motion is reduced) and, after 10 s, the elapsed time (13, faint, tabular). Done: a check in `--text-muted`. Failed: a cross in `--danger` with the step's words in `--danger`. A list, whose running step has `aria-current="step"`. | `--text`, `--text-faint`, `--danger` |
| Fingerprint (`.s-print`)                | A host key's fingerprint: its label (13, faint) over the value in mono, 14 px, in groups of eight, on `--bg-inset`, radius 14, with a copy button. Two of them side by side, or stacked on a phone, compare a pinned key with a new one.                                                                                                                                                               | `--font-mono`, `--bg-inset`          |
| Device code (`.s-device`)               | A device's id shown as two groups of four characters ("7C41-D2E0"), mono, 17 px, so that two screens can be compared by eye.                                                                                                                                                                                                                                                                           | `--font-mono`                        |
| Found card (`.s-found`)                 | What the look found: a 44 px empty mark, a title (17/500), a fact block of at most five rows, and the screen's one primary action under it.                                                                                                                                                                                                                                                            | `--bg-bubble`                        |
| Host dialog (`.s-host`, prototype only) | The prototype's picture of the host's native confirmation: a small sheet with the app's icon, the message, the detail, an optional checkbox, and the buttons. It is a stand-in; the app shows a real native dialog.                                                                                                                                                                                    | `--bg-raised`, `--shadow-pop`        |

No new tokens.

### Input

- Every setup screen is one column; Tab follows reading order; the screen's primary action is the default button, so Enter in its one field is that action.
- Back is the first control of every screen that has somewhere to go back to, including every wait, and keeps what was typed: Back from "Looking on you@devbox.example" returns to the field with "you@devbox.example" still in it.
- In the first screen's choice list, Up and Down move between the two rows, and Home and End go to the ends.
- A screen that changes its content moves focus to its new title (`tabindex="-1"`), and the page's polite live region announces the title.
- A dialog keeps focus inside, makes everything behind it inert, closes with Escape (or Cancel), and returns focus to the control that opened it.
- Copy follows the pairing screen: a check for 1.5 s and "Copied."; when the clipboard refuses, the text is selected and the region says how to copy it.

## 3. The first screen

**Desktop, first launch, and whenever no gateway is saved** (F-001, F-491).

- The mark, "Clawtrate" (28/600), and "Your OpenClaw agents, orchestrated." (15, muted).
- "Where does OpenClaw run?" (17/500), the screen's heading.
- One choice list with two rows, each opening the next screen (a chevron at its end):
  - "This computer", with "Clawtrate looks for OpenClaw here." under it.
  - "Another computer", with "A computer you reach with SSH, such as a server or a desktop at home." under it.
- Under the list, two quiet links on one line: "Have a setup code?" and "Advanced". "Advanced" opens the address-and-token form exactly as it was built (`connect.html`, F-493).
- One hint (13, faint): "New to OpenClaw? Choose where it should run, and Clawtrate offers to set it up there." On Windows the hint is "New to OpenClaw? Choose Another computer to use or set up OpenClaw on a Mac or a Linux computer." (section 10).

The person never chooses between "I already use OpenClaw" and "I am new to OpenClaw"; those are the two results of the look (section 6). The row of bots stands along the foot as before, and is hidden below 640 px of height.

## 4. Looking on this computer: what "found" means

"This computer" starts the look at once on macOS and Linux. There is nothing to confirm, because looking changes nothing. On Windows the look doesn't run: until an existing install's native executable entry is proved, "This computer" leads to the Windows card of section 6, which offers Advanced.

**Which gateways the look covers.** OpenClaw's default profile, and the profile Clawtrate installs (`clawtrate`, section 10). Other profiles can be reached with "Advanced"; the look names them when it sees them (below), and does not connect to them.

**What the host runs**, each with its own time limit, all read-only, never through a shell:

| Step                                  | Program and arguments                                                                                                                                                                                                                                                     | Limit         | Gives                                                                                                                                                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Find OpenClaw                         | The first of these that exists and is a regular executable file: Clawtrate's own install (`<app data>/openclaw/bin/openclaw`), `~/.openclaw/bin/openclaw`, `/opt/homebrew/bin/openclaw`, `/usr/local/bin/openclaw`, `~/.local/bin/openclaw`, `~/.npm-global/bin/openclaw` | 2 s           | A path from that list, or none                                                                                                                                                                                                                       |
| Version                               | `openclaw --version`, once, for the first profile looked at                                                                                                                                                                                                               | 10 s, 4 KiB   | `OpenClaw 2026.10.6 (fe06181)`, checked against the shape `OpenClaw <yyyy>.<m>.<d>`                                                                                                                                                                  |
| The gateway                           | `openclaw gateway status --json` for each profile looked at (with `--profile clawtrate` when that install exists)                                                                                                                                                         | 20 s, 256 KiB | The service as reported (label, loaded, state) and whether the status associates it with this gateway, the port, the configured bind, the config path, the addresses it probed and answered on, `rpc.ok` and the version the running gateway reports |
| Auth mode                             | `openclaw config get gateway.auth.mode --json` for each profile looked at                                                                                                                                                                                                 | 10 s, 4 KiB   | The configured sign-in mode, and nothing secret                                                                                                                                                                                                      |
| Other gateways                        | `openclaw gateway status --json --deep`, once, for the first profile, read for `extraServices` only                                                                                                                                                                       | 20 s, 512 KiB | Names of other OpenClaw services, shown and not used                                                                                                                                                                                                 |
| Signs of OpenClaw without its program | Whether `~/.openclaw` exists and whether a service named `ai.openclaw.gateway` or `openclaw-gateway.service` is registered                                                                                                                                                | 2 s           | Whether OpenClaw seems set up                                                                                                                                                                                                                        |

**What "found" means.** A gateway is found when all of these are known: which profile (`default` or `clawtrate`), its config path, its port and its configured bind, its auth mode, and an `rpc.ok` answer that carries its version, probed and answered at exactly `ws://127.0.0.1:<port>`, from the one listener on that endpoint that the host can identify, with the service's reported config, when the status reports one, the same as the CLI's (`docs/decisions.md`, "Connect goes to an exact local endpoint"). The service is a separate fact: named only when the status reports it and associates it with this gateway. Anything less is one of the other results of section 6, and nothing is offered on it but what that result allows. A program that answers `--version` is not a gateway; a running service is not a gateway that answers.

**The results**, from what the steps gave:

| Result                    | When                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Running, tested           | Found, and the running gateway's version is 2026.10.6                                                                                                  |
| Running, untested         | Found, with another version                                                                                                                            |
| Too old                   | The reported version is below the version this Clawtrate offers for automatic setup, or the handshake is refused with a protocol mismatch              |
| Installed, proven stopped | A program and a registered service that is loaded and stopped, and nothing listening on its port                                                       |
| Set up, program missing   | No program in the list, but `~/.openclaw` or the service exists                                                                                        |
| Can't tell                | A step timed out, a program answered with something of the wrong shape, or the gateway didn't answer while its service runs (an auth refusal included) |
| Not found                 | No program, no `~/.openclaw`, no service: a bounded search that missed                                                                                 |
| Not token sign-in         | Found, but `gateway.auth.mode` is `password`, `none` or `trusted-proxy`                                                                                |

**What the person sees** in place of the choice list: Back, the title "Looking on this computer", and a step list: "Finding OpenClaw", "Checking its version", "Asking the gateway". It usually takes one to three seconds. After 8 s the screen adds "Still looking. A gateway that has just started can take a while to answer." Back stops the look; the host ends its programs by PID.

## 5. Another computer: the field, the SSH settings Clawtrate uses, the host key

**The field** (F-495). Back, the title "Another computer", and one pill field labelled "SSH host or alias", with the placeholder "devbox or you@devbox.example". Under it (13, faint): "Clawtrate uses your SSH keys and the host's settings from your SSH configuration, and never asks for a password." The primary button is "Look there", and under it two quiet links, "Have a setup code instead?" and "Advanced".

- **Accepted**: an alias from the person's SSH configuration, a host name, or `user@host`, matching the pattern of section 19. A value that fails says "That isn't an SSH host or alias Clawtrate can use." under the field, and nothing runs.
- **Remembered computers**, at most three, appear above the field only once one has worked: rows such as "you@devbox.example" with "OpenClaw 2026.10.6 · last used today".
- **The full destination** (account, host and port, as resolved from the person's configuration) is shown, as text, in every name that comes before consent: the account dialog, the titles of the look, and the failure notes.

**The SSH settings Clawtrate uses.** The host reads the person's SSH configuration file (`~/.ssh/config` and the files it includes) as text, finds the `Host` block for the name typed, and takes only these settings from it: `HostName`, `User`, `Port`, `IdentityFile`, `IdentitiesOnly`, `CertificateFile`, `IdentityAgent` and `PubkeyAuthentication`. It writes one validated value per directive into its own configuration, which contains no forwards, with its fixed options (section 19), and starts `ssh -F <that file>`. The person's file is never handed to `ssh` as an input configuration, and `ssh -G` is not used. With no IdentityFile configured, Clawtrate looks for id_rsa, id_ecdsa, id_ecdsa_sk, id_ed25519 and id_ed25519_sk under your home and adds each existing eligible file explicitly. With no eligible file, it sets IdentityFile none. Clawtrate also checks the companion paths OpenSSH can derive from each key.

A block that uses any other setting that matters is refused before anything connects, and the screen says which setting and why, with a direct "Advanced" link. These are refused: `Match`, `ProxyCommand`, `ProxyJump`, `LocalCommand`, `PermitLocalCommand`, `LocalForward`, `RemoteForward`, `DynamicForward`, `SendEnv`, `SetEnv`, `ForwardAgent`, `ForwardX11`, `StrictHostKeyChecking`, `UserKnownHostsFile`, `GlobalKnownHostsFile`, `KnownHostsCommand`, `UpdateHostKeys`, `HostKeyAlias`, `ControlMaster`, `ControlPath`, `RemoteCommand` and `Include` inside a matching block.

| Refused setting                                                                               | The note                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ProxyJump`, `ProxyCommand`                                                                   | **devbox is reached through another computer.** "Clawtrate doesn't connect through jump hosts yet. Use a setup code made on devbox, or Advanced."                                                   |
| A command or a forward (`LocalCommand`, `RemoteCommand`, `*Forward`, `Match`)                 | **devbox's SSH settings run a command or open other forwards.** "Clawtrate only opens one forward, with no commands of yours. Add a plain alias for devbox to your SSH configuration and use that." |
| Host-key settings (`StrictHostKeyChecking`, `*KnownHosts*`, `UpdateHostKeys`, `HostKeyAlias`) | **devbox's SSH settings change how its key is checked.** "Clawtrate checks host keys its own way. Add a plain alias for devbox and use that."                                                       |

On macOS and Linux Clawtrate can use a selected key-agent socket to sign in, without forwarding it. BatchMode does not prompt for a passphrase. On Windows Clawtrate leaves the bundled client's default agent setting in place. Agent sign-in through that default and an explicitly configured pipe remain unverified.

**The account, confirmed before anything runs there.** "Look there" opens the host's dialog "Look for OpenClaw as you@devbox.example, port 22?", with the detail "This uses the remote account's SSH login environment." (rule 3). Cancel returns to the field, where the setup code and Advanced links stay.

**The look over SSH.** Back, the title "Looking on you@devbox.example", and a step list: "Reaching devbox", "Finding OpenClaw", "Checking its version", "Asking the gateway". The host runs `ssh -F <its file> <fixed options> -- clawtrate-route-<id> /bin/sh -s` with the LOOK script on standard input (section 19). The script looks only in fixed places, like section 4, prints one JSON line per fact, and stops after 30 s. The host reads at most the largest whole output the script can print, plus a bounded allowance for what login files print first, and validates each fact.

**The three failures.** `ssh` exits with 255 for all three; the host tells them apart from its error output, in memory, and keeps only the category and the one cause in brackets (research §7). Each failure replaces the step list with a note with a direct "Advanced" link, and the field stays filled.

| Failure                | Note (title, then sentence)                                                                                                                                                                                 | Next                                                                                                                                                                        | Actions                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Cannot be reached      | **Can't reach you@devbox.example** · "Nothing answered at devbox.example, port 22 (connection refused)." The words in brackets are one of: connection refused, no such name, timed out, network unreachable | "Check the name and that the computer is on."                                                                                                                               | "Try again" (primary, a new confirmation), Back, Advanced |
| Sign-in refused        | **you@devbox.example didn't accept your key** · "The SSH sign-in for you@devbox.example was refused."                                                                                                       | "Check that your key is on that computer. A key with a passphrase has to be in your SSH agent first." On Windows, add "Key-agent sign-in has not been verified on Windows." | "Try again" (primary, a new confirmation), Back, Advanced |
| Host key not known yet | Below                                                                                                                                                                                                       |                                                                                                                                                                             |                                                           |

Anything else `ssh` reports is "ssh stopped (exit 255)", fixed copy, with no line of its output.

**First contact: the key, as one act** (rule 8). When the computer's key is in neither Clawtrate's own file nor the person's known-hosts file, the host connects once with `-NT`, `StrictHostKeyChecking=accept-new` into an empty capture file, under the route's own alias, and with `PreferredAuthentications=none`, and closes the connection as soon as the key is written. The probe offers no credentials and opens no session (research §7.2). The screen then shows:

- the title "Is this devbox?", and "This is the first time Clawtrate connects to devbox. Its key is below. If you can, compare it with the key devbox itself shows before you trust it."
- the fingerprint of that captured key: "ED25519" over `SHA256:Q3v8Lw0e Xk2Rj9Ta Nf5Hc1Ub Ym7Pd4Gs Zi6Ko2Ea Vr8`.
- a disclosure, "How to compare": "On devbox, in a session you already trust, `ssh-keygen -lf` with the key file shows its fingerprint. The file depends on the key's type, for example `/etc/ssh/ssh_host_ed25519_key.pub`."
- the primary button "Trust this key…", which asks the host (the dialog "Trust devbox's key?"), and the default button Back.

On confirmation the host moves exactly the captured record (its resolved endpoint, algorithm and key bytes; never a fingerprint from the page) into Clawtrate's own known-hosts file, under the route's alias. Every later connection runs with `StrictHostKeyChecking=yes` and that file alone, so it accepts that key only. Then the look continues.

**A key the person already trusts.** Before creating the route's pin, the host looks up prior normal trust for the resolved host and port, without the route's alias: a strict connection with the person's known-hosts file and `-v`. When it succeeds, `ssh` names the file and line that matched ("Found key in …:2"), and the host stores that verified literal key under the route's alias, so the route is pinned from then on (research §7.2). A certificate-authority or marker line is never treated as literal pin bytes; such a host goes through first contact.

**A changed key.** A `--danger` note, **devbox's key has changed**: "The key devbox presented is not the one Clawtrate trusted. This happens when a computer is reinstalled, and it is also what someone between you and devbox would cause. Clawtrate won't connect until you decide." The host captures the new key the same way, without signing in. The screen shows both fingerprints, "Trusted" and "Presented now", with the date the trusted one was pinned. Actions: "Try again" (primary) and Back, and, as a quiet button, "Replace the trusted key…". That opens the host's dialog "Replace devbox's trusted key?", with both fingerprints and the checkbox "I checked the new key on devbox itself"; Replace stays unavailable until it is ticked. Nothing ever replaces the key by itself, and a key in the person's own known-hosts file is never edited.

## 6. What the look found

One screen for both computers. The title says where ("On this computer", "On you@devbox.example"), a found card says what was found, and there is one primary action, or none.

| Result                                      | Card                                                                                     | Facts                                                                                                                                                                                                                                                 | Primary                                   | Also                                                                                                                                                                  |
| ------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Running, tested**                         | A check mark, "OpenClaw is running"                                                      | Version "2026.10.6"; Profile "default"; Listens "On this computer only" ("On devbox only"); Service, as observed: "LaunchAgent, starts when you log in" (macOS), "systemd user service, starts with your session" (Linux), or "None, started by hand" | "Connect" (the host confirms the pairing) | "Connect pairs this computer with the gateway as a device that can only read, and the gateway keeps it. Sending or changing anything is asked for later." (13, faint) |
| **Running, untested**                       | The running card, with a `--warn` note                                                   | "OpenClaw 2026.9.37 isn't the version this Clawtrate is tested with (2026.10.6). Use Advanced to connect to it."                                                                                                                                      | "Use Advanced"                            | "How to update" opens a disclosure with `openclaw update` and "Run it yourself when you're ready."                                                                    |
| **Too old**                                 | A cross mark, "This OpenClaw is too old for Clawtrate"                                   | "OpenClaw 2026.6.2 speaks an older protocol than Clawtrate needs. Update it, then look again."                                                                                                                                                        | "Look again"                              | "How to update"                                                                                                                                                       |
| **Installed, proven stopped**               | A pause mark, "OpenClaw is installed but not running"                                    | Version; Service: "LaunchAgent, stopped"; Port: "Nothing listening on 18789"                                                                                                                                                                          | "Start OpenClaw" (the host confirms)      | Start is shown only for this result                                                                                                                                   |
| **Set up, program missing**                 | A warning mark, "OpenClaw seems to be set up here, but Clawtrate can't find its program" | "Clawtrate looked in the usual places. If you installed OpenClaw somewhere else, use Advanced, or run `openclaw gateway status` here to see where it is."                                                                                             | none                                      | Back                                                                                                                                                                  |
| **Can't tell**                              | A warning mark, "Clawtrate couldn't tell what is on this computer"                       | "Asking the gateway didn't finish in time." or "OpenClaw answered in a way Clawtrate doesn't understand."                                                                                                                                             | "Use Advanced"                            | "Look again" (quiet)                                                                                                                                                  |
| **Not found** (macOS, Linux, this computer) | An empty mark with a plus, "Clawtrate didn't find OpenClaw here"                         | none                                                                                                                                                                                                                                                  | "Set up OpenClaw here"                    | "It runs on another computer" (quiet)                                                                                                                                 |
| **Not found** (another computer)            | An empty mark, "Clawtrate didn't find OpenClaw here"                                     | "Setting OpenClaw up on another computer isn't offered in this version."                                                                                                                                                                              | none                                      | Back, and "Use a setup code" and "Advanced" (quiet)                                                                                                                   |
| **Windows, this computer**                  | An empty mark, "Use Advanced on Windows"                                                 | "Clawtrate can't yet look for OpenClaw on Windows. It doesn't set OpenClaw up on Windows either: OpenClaw's Windows installer can change Node.js or PATH and installs OpenClaw globally."                                                             | "Use Advanced"                            | "Use another computer"; a link, "OpenClaw's own install instructions", which opens docs.openclaw.ai in the browser                                                    |
| **Not token sign-in**                       | A warning mark, "This gateway uses another way to sign in"                               | "Clawtrate connects by itself only to gateways that use a token. Use Advanced."                                                                                                                                                                       | none                                      | "Advanced"                                                                                                                                                            |
| **Other gateways seen**                     | Under any card, a neutral note                                                           | "Clawtrate also saw another OpenClaw service here (OpenClaw Gateway (work)). It connects only to the default gateway and its own; use Advanced for others."                                                                                           |                                           |                                                                                                                                                                       |

**Start OpenClaw** (F-497). Offered only when the selected service is proven stopped. The host's dialog: "Start OpenClaw on this computer?", with the detail "Starts the LaunchAgent ai.openclaw.gateway. It keeps running after Clawtrate closes." On confirmation: a step list, "Starting the gateway" and "Asking the gateway", then the running card. If it doesn't come up, a `--danger` note: "**OpenClaw didn't start.**" and the classification in words (`service-missing`: "The service isn't installed."; `startup-blocked`: "The gateway reported a problem when starting."; `not-listening`: "Nothing is listening yet."), with "Try again" (a new confirmation). The host records that it started this gateway (rule 9).

## 7. Connecting, with nothing typed

"Connect" on a running gateway of the tested version (F-492, F-496) opens the host's dialog "Pair this device read-only with the default gateway on this computer?" (over SSH: "…on you@devbox.example?"), with the detail "The gateway saves this device." Nothing is minted or registered before the answer.

**On this computer**, after confirmation:

1. The host reads `gateway status --json` and the auth mode again for the selected profile, each within its limit, and goes on only if they match what the dialog named. Then it runs `openclaw qr --json --voice-node --url ws://127.0.0.1:<port>` (20 s, 16 KiB), `<port>` from the look, with the selected profile. It parses the result in memory, decodes the code's bootstrap token, and checks the code's address is exactly that loopback address.
2. The host's client connects to `ws://127.0.0.1:<port>` with that bootstrap token, asking for `operator.read`.
3. The gateway approves the first pairing without a prompt and returns a device token. The host stages the token in memory and writes it only if the gateway granted the operator role and exactly `["operator.read"]`; anything else (another role, no scopes, more scopes) writes nothing, closes the connection, and Connect fails as "The gateway granted something other than read access, so Clawtrate disconnected." The bootstrap token is forgotten either way.
4. Bots load, and the app opens read-only. The route is not yet grouped by the gateway's identity (section 15).

**Over SSH**, the same, with two differences. The code is made on devbox by the CODE script through the pinned connection, and before step 2 the host starts the forward (`ssh -N -L 127.0.0.1:<free port>:127.0.0.1:<port>`, section 8) and connects through it.

**What the person sees** after confirmation.

- On this computer: Back, the title "Connecting", and a step list: "Making a one-time code", "Pairing this computer, read-only", "Loading your bots".
- Over SSH: Back, the title "Connecting to you@devbox.example", and a step list: "Making a one-time code on devbox", "Opening a private connection to devbox", "Pairing this computer, read-only", "Loading your bots".

It takes one to three seconds; then the app opens read-only, with the access bar where a write would be (`conversation.md` §3). Back during connecting stops it and returns to the found card. If the device was already paired by then, it stays paired and the next Connect reuses it.

**The shared token** stays in OpenClaw's configuration on the gateway's computer. Clawtrate never reads it and never asks for it outside "Advanced", where the person may type it themselves (F-494).

**If the gateway asks before every device** (`gateway.nodes.pairing.autoApproveLocal: false`): the connect returns `PAIRING_REQUIRED`, and the pairing screen of `visual-language.md` §10 appears with the profile-qualified approve command (section 9).

**Failures** (F-009, F-492), in fixed copy:

| Fact                                                      | Note                                                                                 | Actions                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------- |
| `openclaw qr` failed                                      | **Couldn't make a one-time code.** "OpenClaw exited with code 1."                    | "Try again" (a new confirmation) |
| The code was refused (`AUTH_BOOTSTRAP_TOKEN_INVALID`)     | **The one-time code didn't work.** "Clawtrate makes a new one when you try again."   | "Try again" (a new confirmation) |
| Other than the operator role and exactly read was granted | **The gateway granted something other than read access, so Clawtrate disconnected.** | Back                             |
| The forward could not start                               | the SSH failure of section 5                                                         | as there                         |
| Nothing answered on the port                              | **Nothing answered on port 18789.** "The gateway may have just stopped."             | "Look again"                     |
| The pairing was rejected or expired                       | the pairing screen's own states (F-009)                                              | as there                         |

## 8. The forward's life

Each SSH route has one forward, owned by the host: one `ssh -N -L` process per route, started on connect, its PID recorded, always with the pinned key (F-498, F-499).

| Event                                          | What `ssh` does (research §7)                                                               | What the host does                                                                                                                                                                                     | What the person sees                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| The computer sleeps, or the network changes    | Exits 255 with "Timeout, server … not responding." or "Connection … closed by remote host." | Starts the forward again at once on wake or on a network change, otherwise after 1, 2, 4, 8 and 16 s, then every 30 s; each time with the pinned key, and after hello it checks the gateway's identity | The status strip: **Restoring the connection to devbox** · showing saved messages, with "Retry now"; then **Connected to devbox again** for 4 s |
| The local port was taken meanwhile             | Exits 255, "Address already in use"                                                         | Picks another free port and starts again                                                                                                                                                               | Nothing more                                                                                                                                    |
| devbox stops answering for good                | Exits 255 each time                                                                         | Keeps the backoff                                                                                                                                                                                      | After 2 minutes, **Can't reach devbox** · the cause, with "Retry now"                                                                           |
| The key changed                                | Exits 255, "REMOTE HOST IDENTIFICATION HAS CHANGED"                                         | Stops retrying                                                                                                                                                                                         | **devbox's key has changed**, with "Review", which opens section 5's screen                                                                     |
| A different gateway answers (another identity) |                                                                                             | Disconnects, and drops this route's device token                                                                                                                                                       | **This address now leads to a different gateway**, with "Review"                                                                                |
| The gateway on devbox stopped                  | The forward stays up; each connection through it fails                                      | Runs the LOOK script once. If the forwarded connection fails, the host says the port didn't answer. It shows "OpenClaw stopped" only when the LOOK reports the service stopped                         | **OpenClaw stopped on devbox**, with "Start" when it is proven stopped (the host confirms)                                                      |
| Clawtrate quits                                |                                                                                             | Ends its `ssh` processes by PID                                                                                                                                                                        |                                                                                                                                                 |

After OpenSSH reports that it is setting up the local listener, Clawtrate probes the allocated loopback port with a credential-free HTTP request. A complete status line establishes that the port answered as HTTP at that moment. The probe alone does not verify who owns that listener. A credential-free probe confirms that the forward's loopback port answered as HTTP, and a repeated LOOK confirms that the pinned SSH account still reports the expected service at that moment, while the listener's ownership and the gateway's identity remain unverified.

**Removing the route** (Settings, Gateway, "Remove this gateway…") goes through the host's dialog "Remove devbox from Clawtrate?", with the detail "Clawtrate disconnects, forgets this route and its pinned key, and leaves OpenClaw on devbox running." When Clawtrate's record says it started or installed that gateway, the dialog adds a checkbox, unticked: "Also stop OpenClaw on devbox (Clawtrate started it)." The forward is stopped by its PID; the gateway is stopped only with the box ticked, and never when Clawtrate didn't start it.

## 9. Approving a request

Wherever the gateway waits for its owner (F-500): the access bar's "Requested" state (`bots.md` §2), the pairing screen of section 7, a pasted code's pairing (section 13) and the iPhone's waiting screen.

In this version the approval is manual. The page shows the approve command for the selected profile, in the command block with its copy button, and says where to run it: "On devbox, approve this request for the default profile:" over `openclaw devices approve e5eb4aa8-175f-40f1-bc7a-8f15cfc40942` (Clawtrate's own profile: `openclaw --profile clawtrate devices approve …`). On an address route, where Clawtrate doesn't know the profile: "Run this on the gateway's computer, with `--profile <name>` if the gateway doesn't use the default profile." The waiting line and "Check now" follow the pairing screen; the waiting and retry state is as built.

"Approve from here", which would run the approve command for the person, is not in this version: OpenClaw's approve command can follow a compatible replacement of the request, so the exact request, device, role and scopes can't yet be enforced at the moment of approval (research §2). It waits for that check (F-500, `todo`).

## 10. Setting OpenClaw up (macOS and Linux, on this computer)

"Set up OpenClaw here" (F-501 to F-505). Offered on this computer only, on macOS (Apple silicon and Intel) and on Linux with glibc (x64 and arm64). Elsewhere, including Windows, Alpine and other musl Linux, FreeBSD and another computer over SSH, the not-found card says what is offered instead (section 6, F-517). Setting up over SSH, cancelling a setup and removing OpenClaw are `todo`: they wait until the archive and script boundary over SSH and each attempt's ownership are proved (section 11).

**What Clawtrate owns.** An install is Clawtrate's when all four of these are true, and removal and rollback rely on nothing else (section 11):

- **A program folder of its own**, `<app data>/openclaw`. It is created empty by the install, and holds a record, `.clawtrate-install.json`, with the install's id, the version and the profile.
- **An OpenClaw profile of its own**, `clawtrate`: its state is `~/.openclaw-clawtrate`, which holds an owner file, `.clawtrate-owner.json`, with the same id, written after onboarding. Its service is the profile's own: `ai.openclaw.clawtrate` (LaunchAgent), `openclaw-gateway-clawtrate.service` (systemd user unit). Its port is one the host picked free.
- **Clawtrate's own record** of that install: the computer, the id, the folders, the service and the port.
- **Nothing there before.** The install refuses to start if either folder or the service already exists: "Something named clawtrate is already set up on this computer. Clawtrate won't change it."

A default OpenClaw (`~/.openclaw`, `ai.openclaw.gateway`) is never touched: proven on both systems with a decoy default folder that came through install and removal unchanged (research §6.8).

**What is verified, fail-closed** (research §6.8). Before anything runs, the host downloads two files and checks each against a hash built into this Clawtrate: OpenClaw 2026.10.6's npm tarball (its published `sha512` integrity) and Node.js 24.22.1 for the computer's system (its published SHA-256). A mismatch aborts explicitly, before anything is extracted. The host extracts `install-cli.sh` and `install-policy.sh` directly from that checked tarball, where they run. It puts the checked Node.js where the installer looks first, and has the installer install the checked tarball itself, not a version fetched again. Install is enabled only when the installer's Node.js download fallback is unreachable: before invoking the installer, the host runs the installer's own Node.js check against the checked runtime (the script can be sourced without running, `OPENCLAW_INSTALL_CLI_SH_NO_RUN=1`) and doesn't start it unless that check passes. An installer whose Node.js step then doesn't report `skip` is a failure. npm then downloads the packages OpenClaw depends on from the npm registry; Clawtrate can't check them. npm's own configuration is replaced by empty files for this install, so a registry or a setting of the person's isn't used.

**Before anything is downloaded** (F-501): the title "Set up OpenClaw on this computer", and a fact block:

|         |                                                                                                                                                                                                                                            |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| What    | "OpenClaw 2026.10.6, the version this Clawtrate is tested with, with its own copy of Node.js 24.22.1"                                                                                                                                      |
| Where   | "Clawtrate puts OpenClaw's program and gateway data in its own folders and adds a user service. npm can also write its cache and OpenClaw can write service logs."                                                                         |
| Checked | "Clawtrate checks the OpenClaw and Node.js downloads against fingerprints built into this version. Setup also installs code from npm that Clawtrate hasn't pinned or verified. That code can run with your account's permissions."         |
| Then    | "A gateway that listens on this computer only, as a LaunchAgent that starts when you log in, with no AI provider yet. You sign in to one when you make your first bot." (Linux: "as a systemd user service that starts with your session") |

Under the facts (13, faint): "Nothing is asked for: no account and no model key." and "OpenClaw keeps running if you remove Clawtrate. Removing this gateway in Settings can also stop it; removing OpenClaw isn't offered in this version." Then "Set up OpenClaw…" (primary), which opens the host's dialog repeating the dependency sentence, and "Cancel".

**The steps** (F-502), title "Setting up OpenClaw":

| Step                                    | What the host runs (section 19)                                                                                                                                                                    | Its failure, in fixed copy                                                                                                |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| "Download and check OpenClaw 2026.10.6" | Fetches the tarball and Node.js and checks both hashes                                                                                                                                             | "The download didn't finish." · "A download didn't match the fingerprint built into Clawtrate, so nothing was installed." |
| "Install Node.js and OpenClaw"          | `install-cli.sh --json --runtime-only --npm --version <the checked tarball> --prefix <program folder>`; its NDJSON step names drive the step's line ("Node.js 24.22.1, checked")                   | "The installer stopped (exit 1)."; or "The installer didn't use the checked Node.js."                                     |
| "Set up the gateway"                    | `openclaw --profile clawtrate onboard --non-interactive --accept-risk --auth-choice skip --gateway-bind loopback --gateway-auth token --gateway-port <port> --install-daemon --skip-skills --json` | The result's `classification` in words, as in section 6                                                                   |
| "Start and check"                       | `openclaw --profile clawtrate gateway status --json` until `rpc.ok` with version 2026.10.6, at most 60 s                                                                                           | "The gateway didn't answer after it was set up."                                                                          |

The step list shows elapsed time after 10 s on the running step. An install takes about a minute (research §6.2, §6.8; the times in the prototype are samples). When every step is done, the look's running card for the `clawtrate` profile appears, and Connect pairs as in section 7.

**A failed step** is drawn failed, the steps after it stay waiting, and a `--danger` note under the list says "**<the step's words> failed.**" and the fixed cause. "Show details" opens the step's typed record: step, error category, and numeric exit code. Back returns to the not-found card. Trying again is `todo` with Cancel (F-502): a new install refuses while anything this attempt made is there ("Nothing there before", above), and removing it waits until each attempt's ownership is proved (F-514).

**Cancel** (`todo`, not in this version): the host's dialog "Stop setting up OpenClaw?", with the detail "Clawtrate will stop this setup and remove what it can verify this attempt created. It will list anything left." It reports only cleanup it verified.

## 11. Removing OpenClaw, or leaving it (not in this version)

Removing OpenClaw is `todo` (F-514): it waits until each attempt's ownership is proved, including an install stopped before its owner file was written. When it comes, it works as follows, and reports only verified cleanup.

**Ownership, proven again before anything is removed.** All of these must hold, or nothing is removed and the page says "Clawtrate can't prove it installed this OpenClaw, so it won't remove it.":

- the install record in the program folder, the owner file in the profile's state folder and Clawtrate's own record carry the same id;
- the profile is `clawtrate`;
- the service's label is the profile's own;
- the service's command runs the program in Clawtrate's program folder.

**The page** names the computer by the full destination and the name it reports, and lists exactly what will be removed: the service, the program folder, and the gateway's settings, bots and conversations in `~/.openclaw-clawtrate`, with a checkbox, unticked: "Keep the gateway's settings, bots and conversations". The host's dialog repeats the list. What runs is `openclaw --profile clawtrate uninstall --service --yes --non-interactive`, with `--state --workspace` unless Keep is ticked, then removal of the program folder. The host then checks each item and reports exactly what is left, including the LaunchAgent's file that macOS moves to the Trash (research §6.8) and any log file.

**Leaving it**: removing the Clawtrate app does not remove OpenClaw. The install's sheet says so once.

## 12. Connect a phone (not in this version)

Clawtrate doesn't hand a code to a phone in this version, and approves nothing for the person (F-506, F-507 and F-500, `todo`). A code Clawtrate makes is a `--voice-node` code meant for voice clients, with a node role and Talk; it is used only privately by the host for its own read request (research §3.1).

Settings, Gateway, "Connect a phone" opens a dialog that says so, and how a phone connects instead:

- "Clawtrate doesn't make codes for phones yet."
- "A phone needs an encrypted address it can reach. Set one up with OpenClaw's network-exposure instructions." with a link to `https://docs.openclaw.ai/gateway/security/network-exposure`.
- "On the iPhone, scan or paste a setup code, then approve the phone on the gateway's computer. A setup code stays valid until it is used or expires, even after you close where it was shown."

## 13. A setup code on the desktop, and the iPhone's first screen

**On the desktop** (F-508): "Have a setup code?" on the first screen, and "Have a setup code instead?" under the SSH field. Back, the title "Use a setup code", and one field (mono, three lines), labelled "Setup code", with the placeholder "Paste a setup code". The field's text goes to the host once, which decodes and validates it. A code is not sent to any computer before Connect, and it is never stored or logged.

**What the host accepts**, before any credential is sent: a well-formed code (`url`, `bootstrapToken` and `expiresAtMs`, each of the right type); a `wss://` address with a valid TLS certificate the host can verify for that name; no user name or password, query or fragment in the address, and no path other than `/`; not a loopback name or address (`localhost`, `127.0.0.0/8`, `::1`) for a code from another computer; not expired; and no redirect when connecting. Anything else is refused.

| The host found                                                                                                                                        | Line                                                                                                      | Connect     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------- |
| A valid code, with a verified encrypted address, not expired                                                                                          | "Connects to gateway.example, over an encrypted connection. Expires at 20:41."                            | Available   |
| A code with a `ws://` address, a loopback address, credentials, a query or fragment in the address, or an address whose certificate can't be verified | "That address can't be used safely. Clawtrate needs an encrypted address that isn't this computer's own." | Unavailable |
| Expired                                                                                                                                               | "This code has expired. Make a new one on the gateway's computer."                                        | Unavailable |
| Not a well-formed code                                                                                                                                | "That isn't a setup code Clawtrate can use."                                                              | Unavailable |

Off loopback the gateway does not approve a device by its code alone (research §3), so Connect ends on the pairing screen: "Approve this device", naming the validated address, with the approve command (section 9), the request id and this computer's device code (`visual-language.md` §10). This is a first pairing of this device, read-only. It is not a request for more access.

**On iPhone** (F-001, F-507), first launch:

- The mark, the name, the slogan, then "Connect to your OpenClaw" (17/500).
- "Scan a setup code" (primary, opens the camera), and "Paste a setup code" (default).
- A hint: "Get a setup code from the gateway's owner, made on the gateway's computer."
- "Advanced" (quiet link): the address-and-token form.

After a scan or a paste comes a review screen, with Back: the title "Connect to devbox?", the validated address ("This code leads to devbox.tailnet.example, over an encrypted connection."), the expiry, and "Connect" (primary) and "Cancel". Nothing connects until Connect. The same validation applies as on the desktop.

**Waiting for approval**, with Back: the title "Waiting for approval", the validated address, "Ask the gateway's owner to approve this iPhone. Its device code is:", the device code "7C41-D2E0", and the approve command (section 9) with the request id. The waiting line follows. Approval opening the app read-only (F-509) is not proven off loopback yet; the prototype draws that end state only as a labelled future example.

## 14. Private access with Tailscale (read-only in this version)

Settings, Gateway, on a route with a shell, shows a row "Private access with Tailscale", with "Set up private access on the gateway using OpenClaw's Tailscale instructions" and a link to `https://docs.openclaw.ai/gateway/tailscale`. There is no switch, and Clawtrate changes nothing about Tailscale in this version (F-510 to F-512, `todo`).

When the switch comes, it must verify which gateway owns a route and that a setting was actually put back; it never infers "restored" from having written a command, or "this gateway" from a health response (research §8).

## 15. Several routes to one gateway

One gateway can be reached by several routes: this computer, SSH, an address on the local network, a Tailscale address (F-513). This is built after the iPhone work, as the owner ordered, and it is designed now so that nothing before it has to change.

**Each route pairs for itself.** A route uses its own device token and no other: silently for this computer and SSH, by a setup code and approval otherwise.

**No automatic reuse where the gateway can't be authenticated first.** On a route whose gateway can't be authenticated before the token is sent (an address without verified TLS, as Advanced may have), Clawtrate doesn't send the saved token by itself; it waits for the person to reconnect. On this computer and over SSH the token goes only to the gateway's port on a computer that is authenticated first, this one or devbox by its pinned key, and Clawtrate sends it by itself there, as section 8 does when it restores a forward: that is the local boundary OpenClaw trusts when it pairs a loopback connection silently (research §1, §5). It doesn't prove which process holds the port. Another account on that computer could take it while the gateway is stopped, and the identity check after hello then drops the route's token, after it was sent.

**Grouping and continuity.** After each connection the host reads `gateway.identity.get`. Routes that report the same identity are one gateway in the rail and in Settings. A route that reports a different identity than it did before is not that gateway any more: the host disconnects, drops that route's token, and the strip says "This address now leads to a different gateway". A credential is never sent on a route because another route reported the same identity (research §5).

**Failover and failback.** Settings, Gateway lists the gateway's routes in an order the person can change, with "In use" on one:

- Clawtrate connects over the first route, in that order, that answers, accepts that route's own token and reports the identity recorded for it; one that doesn't answer within 3 s is skipped, and so is a route where the token isn't sent by itself (above), until the person reconnects over it.
- While connected over a later route, it checks the earlier ones it may use by itself on a network change, on wake, and every minute, and moves back as soon as one works. The move keeps everything open, as a reconnect does.
- A route whose sign-in is refused is marked "Sign-in refused", with "Pair again".

**Adding a route** is a button, "Add route", that pairs over the new route. A route the gateway reports about itself (its Tailscale address) is offered as a suggestion, never added by itself.

## 16. Widths, themes, keyboard, screen readers, motion

| Concern                            | Rule                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1440 and 1100 px                   | The 360 px column centred on the stage, as `visual-language.md` §10; dialogs centred                                                                                                                                                                                                                                  |
| 800 px                             | The same; the bots along the foot scale as the connection screen's do                                                                                                                                                                                                                                                 |
| Phone (390 px, and the iPhone app) | The column fills the width less 16 px a side; rows are 64 px, buttons 48 px; the bots hide below 640 px of height; dialogs become sheets (`bots.md` §2); fingerprints stack                                                                                                                                           |
| Light and dark                     | Tokens only                                                                                                                                                                                                                                                                                                           |
| Keyboard                           | Section 2, Input: reading order, Up and Down in the choice list, Enter as the primary action, Escape as Back on a step screen and Cancel in a dialog, focus kept in a dialog and returned after it                                                                                                                    |
| Screen readers                     | Each screen's title is its heading and takes focus when it appears; the step list is a list with the running step `aria-current="step"` and each step's state in its name ("Asking the gateway, running"); failures are `role="alert"`, other notes `role="status"`; fingerprints and device codes are read in groups |
| Reduced motion                     | The running step's arc is a still ring; the waiting dot stops pulsing; nothing slides                                                                                                                                                                                                                                 |
| Branding                           | Clawtrate's mark and bots only; OpenClaw and Tailscale named in text, with no logo or colour of theirs                                                                                                                                                                                                                |

## 17. What each fact drives

| Fact                                                                               | Source (research) | Shown                                                                                          |
| ---------------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------- |
| No program in the fixed places, no `~/.openclaw`, no service                       | §6.4, §6.9        | "Clawtrate didn't find OpenClaw here"                                                          |
| No program, but state or a service                                                 | §6.9              | "OpenClaw seems to be set up here, but Clawtrate can't find its program"                       |
| `openclaw --version`, `gateway.version` from `gateway status --json`               | §6.4              | The version; tested, untested or too old                                                       |
| `service.label`, `loaded`, `runtime.status`                                        | §6.4, §6.8        | The service fact, as observed; Start only when proven stopped                                  |
| `gateway.port`, `bindMode`, `rpc.ok`                                               | §6.4              | "OpenClaw is running", or "installed but not running"                                          |
| `extraServices` (with `--deep` only)                                               | §6.9              | "Clawtrate also saw another OpenClaw service here"                                             |
| `ssh` exit 255 and its error output                                                | §7                | The three failures; "key has changed"; anything else "ssh stopped (exit 255)"                  |
| The capture file written with `-NT`, `accept-new`, `PreferredAuthentications=none` | §7.2              | The fingerprint of first contact; "Presented now"                                              |
| `Found key in <file>:<line>`, from a lookup on the resolved host and port          | §7.2              | A key the person already trusts, pinned silently                                               |
| `openclaw qr --json --voice-node`, host-private                                    | §3.1              | Connect's code, never shown                                                                    |
| The operator role and exactly `operator.read` granted                              | §1, §3.1          | Connected, read-only                                                                           |
| `AUTH_BOOTSTRAP_TOKEN_INVALID`                                                     | §3                | "The one-time code didn't work"                                                                |
| `device.scopes.requestUpgrade` request id, pending                                 | §2                | The access bar's Requested state with the profile-qualified command                            |
| `install-cli.sh` NDJSON step names, Node step `skip`                               | §6.2, §6.8        | The install's steps; "The installer didn't use the checked Node.js"                            |
| Installed `entry.js` equals the checked tarball's                                  | §6.8              | (a check of the builder's tests, not a screen)                                                 |
| Onboarding JSON `ok`, `classification`                                             | §6.3              | "Set up the gateway" done or failed                                                            |
| `gateway.identity.get`                                                             | §5                | Routes grouped; "leads to a different gateway"                                                 |
| HTTP 403 `proxy_attribution_required`                                              | §3                | "The gateway only accepts connections through a proxy it trusts" (shown on Advanced's failure) |

## 18. Parity rows

The rows this design governs are in `docs/parity.md`. Statuses do not change. In this version:

- **F-500, F-506 and F-507** stay `todo`: no code is handed to a phone and nothing is approved for the person.
- **F-510 to F-512** stay `todo`: the Tailscale row is read-only, with OpenClaw's own instructions.
- **F-501 to F-505** are macOS and Linux only, on this computer; remote setup, cancelling (F-502) and removal (F-514) wait for their proofs. **F-517** is for installing on Windows, `todo`.
- **F-513** keeps ordered failover and failback, with one token per route.
- **F-003 and F-009** keep their `desktop done` scope for what the existing check drives.

## 19. For builders

### What each part uses

| Screen                          | Existing                                                    | New                      |
| ------------------------------- | ----------------------------------------------------------- | ------------------------ |
| First screen                    | The connection column, mark, bots, choice list, quiet links | none                     |
| Looking, connecting, setting up | The connection column, notes, disclosure                    | Step list                |
| Another computer                | `.input`, notes, the copy button                            | Fingerprint              |
| What the look found             | Fact block, notes, buttons                                  | Found card               |
| Approving a request             | The access bar, the pairing screen                          | Device code              |
| Settings, Gateway               | Settings frame (`bots.md`), notes                           | none                     |
| iPhone first screen             | The connection column                                       | Device code              |
| Every confirmation              | none                                                        | The host's native dialog |

### What the host does

**Commands the interface may send.** Reads run at once; everything that registers, mints, runs remotely or changes is a two-step operation that only the host's dialog completes.

| Command                                 | Kind    | Does                                                                                                                                      |
| --------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `setup.look {where: "here"}`            | read    | Section 4; returns the typed facts of section 17                                                                                          |
| `setup.cancel {lookId}`                 | read    | Ends the host's local process for the look by PID. On an SSH route, remote command exit is unconfirmed.                                   |
| `setup.readCode {text}`                 | read    | Decodes and validates a pasted code in the host; returns its address, expiry and validity, never its token                                |
| `setup.prepare {operation, routeId, …}` | prepare | Builds the operation from the host's own state and shows the host's dialog; the interface gets only "confirmed", "cancelled" or "changed" |

Operations: `sshAccount {destination}` (then the look over SSH), `trustKey`, `replaceKey`, `pair`, `start`, `install`, `removeRoute {stopGateway}`. A retry is a new `setup.prepare`.

**Validated arguments** (rule 2):

| Value                    | Pattern                                                                                                                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SSH destination          | `^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,63}@)?[A-Za-z0-9][A-Za-z0-9.-]{0,252}$`: the user, when present, never starts with `-`; the host never starts with `-` or `.`; no `:`, `/`, spaces or quotes |
| Request id               | `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`                                                                                                                               |
| Port                     | An integer from 1024 to 65535, read from `gateway status --json`                                                                                                                               |
| Fingerprint              | `^SHA256:[A-Za-z0-9+/]{43}$`, computed by the host from captured key bytes, never taken from the interface                                                                                     |
| Version                  | `^OpenClaw (\d{4})\.(\d{1,2})\.(\d{1,3})( \([0-9a-f]{7,12}\))?$`                                                                                                                               |
| Address in a pasted code | Section 13: `wss://` with a verified certificate; no credentials, query, fragment or path; not loopback; no redirect                                                                           |
| A remote path            | One of the fixed candidate paths, compared exactly                                                                                                                                             |

**SSH, the host's configuration.** The host writes one file per route, with one directive per line and one validated value per directive, paths resolved and checked to stay under the person's home, and no configuration syntax or expansion characters in any value:

```
Host clawtrate-route-<id>
  HostName <HostName from the person's block, or the typed host>
  User <User>
  Port <Port>
  IdentityFile <one line for each>
  IdentitiesOnly <value>
  CertificateFile <one line for each>
  HostKeyAlias clawtrate-route-<id>
  UserKnownHostsFile <app data>/known_hosts
  GlobalKnownHostsFile none
  StrictHostKeyChecking yes
  UpdateHostKeys no
  BatchMode yes
  ConnectTimeout 10
  ServerAliveInterval 15
  ServerAliveCountMax 3
  ExitOnForwardFailure yes
  ClearAllForwardings yes
  ForwardAgent no
  ForwardX11 no
  PermitLocalCommand no
  ControlMaster no
  ControlPath none
  RequestTTY no
```

`ClearAllForwardings yes` holds for the looks and commands. The dedicated forward invocation alone adds `-o ClearAllForwardings=no`, so its one `-L` is kept; the file itself contains no forwards (research §7). For first contact, the host runs `-NT` with `StrictHostKeyChecking accept-new`, `UserKnownHostsFile <a new empty capture file>`, `PreferredAuthentications none` and `NumberOfPasswordPrompts 0`, and closes the connection after capture: the probe offers no credentials and opens no session. To find a key the person already trusts, it checks the resolved host and port, without `HostKeyAlias`, against the person's `~/.ssh/known_hosts` with `-v`, reads only the lines `Server host key:`, `is known and matches`, `Found key in` and the failure lines (accepting `\r\n` line ends), and then stores the verified literal key under the route's alias; certificate-authority and marker lines are never pinned. On Windows the program is `%WINDIR%\System32\OpenSSH\ssh.exe`.

**Programs**, each started with an argument array, never through a shell, each with the selected profile:

| Program                         | Arguments                                                                                                                   | When                                                                |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `ssh`                           | `-F <file> [-v] -- clawtrate-route-<id> /bin/sh -s`, a script on standard input                                             | Every remote step, after the account's confirmation                 |
| `ssh`                           | `-F <file> -o ClearAllForwardings=no -N -L 127.0.0.1:<free port>:127.0.0.1:<port> -- clawtrate-route-<id>`                  | The forward                                                         |
| `ssh-keygen`                    | `-lf <capture file>`                                                                                                        | The fingerprint of captured key bytes                               |
| `openclaw`                      | `[--profile clawtrate] --version`; `[--profile clawtrate] gateway status --json [--deep]`                                   | This computer, reads                                                |
| `openclaw`                      | `[--profile clawtrate] qr --json --voice-node --url ws://127.0.0.1:<port>`                                                  | This computer, Connect, after the host's dialog                     |
| `openclaw`                      | `[--profile clawtrate] gateway start`                                                                                       | This computer, after the host's dialog                              |
| `/bin/bash`                     | `<program folder>/install/install-cli.sh --json --runtime-only --npm --version <checked tarball> --prefix <program folder>` | Install, macOS and Linux, after the host's dialog and the pre-check |
| `<program folder>/bin/openclaw` | `--profile clawtrate onboard …` (section 10)                                                                                | Install                                                             |

**The install's environment**: `NPM_CONFIG_USERCONFIG` and `NPM_CONFIG_GLOBALCONFIG` each point at its own empty file (npm refuses one file for both, research §6.8); `npm_config_registry=https://registry.npmjs.org/`; `PATH` is the system's plus the prefix; nothing else of the person's environment is passed, and no credential is in it.

**Scripts over SSH**, constants in the host's source. Each is POSIX `sh`, starts with `set -eu`, takes its only values (a port of digits, a request id of hex and hyphens) from assignments the host writes after validating them, and prints one JSON line per fact.

- LOOK finds the program in the fixed places only; prints `uname -s`, `uname -m`, `uname -n`, `--version`, `gateway status --json`, and whether `~/.openclaw` and a service exist.
- CODE runs `openclaw qr --json --voice-node --url "ws://127.0.0.1:$port"` for the selected profile.
- START and STOP follow the same pattern, one fixed OpenClaw command each.

**Remote output**: bounded per script (for the LOOK, its largest whole output and a separate allowance for login noise) and 30 s, parsed line by line as JSON; a line that isn't valid JSON of the expected shape ends the step as "Can't tell".

**What the host keeps**: routes (section 2), each with its own device token, its pinned key in Clawtrate's own known-hosts file, and the gateway's identity; the records of installs and started gateways. Of a failed step it keeps only the typed record: step, error category and exit code. Bootstrap and device credentials stay out of tracking, snapshots and child environments.

**Telling a proxy refusal apart.** After a connect fails before any frame, the host sends one plain HTTP upgrade request to the same address and reads its status: `403` with `proxy_attribution_required` is the proxy refusal (research §3).

**`docs/decisions.md`** says, under "Connecting to the gateway", what changes with routes when package 2 is built: one token per route, and the identity check after every connection, with the existing generation checks kept through every wait.

### What the engine supplies

| Need                                                           | Supplied by                                                                                                                                                                                                                                                                                                                                                        | Notes                                                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Connect with a bootstrap token                                 | The host's client: `connect({url, bootstrapToken})`, passed to the pinned lifecycle's `buildPlan({bootstrapToken})`                                                                                                                                                                                                                                                | Never in the interface; dropped after hello                                        |
| Write the first token only for exact read                      | The host's persistence boundary. The pinned SDK stores the device token before `onHelloOk`, and the core runs `acceptHello` before `handleHello`, so a check after hello is too late. The host stages the receipt in memory, keeps generic store and reconnect callbacks from publishing it, and writes it only for the operator role with exactly `operator.read` | Tests: a wrong role, zero scopes, extra scopes and cancellation each write nothing |
| A device token per route                                       | The token store keyed by route                                                                                                                                                                                                                                                                                                                                     | Section 15                                                                         |
| The gateway's identity per route                               | `gateway.identity.get`, already read                                                                                                                                                                                                                                                                                                                               | Grouping and continuity                                                            |
| `PAIRING_REQUIRED`, the upgrade's request id, this device's id | As today                                                                                                                                                                                                                                                                                                                                                           | The approve command uses them                                                      |

### Order

The packages, in this order, each with checks of its security and failure cases as well as its happy path:

1. **This computer, found** (F-491 to F-494, F-515, F-516): the first screen; the look and what "found" means; the pairing consent; Connect with a host-private voice-node code; the token written only for exact read; Advanced.
2. **Another computer over SSH** (F-495 to F-499): the configuration subset and its refusals; the account's confirmation; the LOOK script; the three failures; first contact, an already trusted key, a changed key; the forward and its life. Checks run against an `sshd` the test starts.
3. **Setting up on this computer, macOS and Linux** (F-501 to F-505): ownership; the fail-closed verified chain; the steps. A real install runs only on hosted runners. Cancelling, removal and setting up over SSH follow their proofs.
4. **A computer without SSH, and the iPhone** (F-507 to F-509): the validated code entry; the pending screens; the manual, profile-qualified approval.
5. **Several routes** (F-513), after the iPhone work: per-route pairing, grouping and continuity, failover and failback.

### The prototype's states and walks

`setup.html?screen=<id>`, with the shared `theme`, `width`, `motion` and `chrome` parameters, and `returning=1` for a return visit. The bar's "State" menu lists every state. The check walks these paths by clicking, and asserts each destination:

| Walk                            | From                    | Through                                                                                                  | To                                                         |
| ------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| This computer, found            | `first`                 | `looking-here`, `found`, the host's pairing dialog, `connecting-here`                                    | the app, read-only                                         |
| Another computer, known key     | `there`                 | the host's account dialog, `looking-there`, `found-there`, the host's pairing dialog, `connecting-there` | the app, read-only                                         |
| Another computer, first contact | `there` (a new host)    | the host's account dialog, `hostkey`, the host's trust dialog, `looking-there`                           | `found-there`                                              |
| A changed key                   | `hostkey-changed`       | the host's dialog with its checkbox                                                                      | `looking-there`                                            |
| Another computer, nothing there | `there` (an empty host) | the host's account dialog, `looking-there`                                                               | `notfound-there`                                           |
| This computer, nothing there    | `notfound`              | `install-confirm`, the host's dialog, `installing`                                                       | `found`                                                    |
| A failed install                | `install-failed`        | Back                                                                                                     | `notfound`                                                 |
| Windows, this computer          | `first` on Windows      | "This computer"                                                                                          | `notfound-windows`, then "Use another computer" to `there` |
| A pasted code                   | `code`                  | an invalid code (Connect unavailable), a valid one                                                       | `code-pairing`, naming the address                         |
| The iPhone                      | `iphone`                | `iphone-review`                                                                                          | `iphone-waiting`                                           |
| Advanced                        | `first`                 | "Advanced"                                                                                               | `connect.html`, the form as built                          |

`iphone-done` is drawn as a labelled future example: no walk reaches it.

## 20. Not covered here

- Setting OpenClaw up on Windows (F-517), on musl Linux or FreeBSD, or on another computer over SSH; cancelling a setup; removing OpenClaw (F-514).
- Handing a code to a phone (F-506), approving for the person (F-500), and the Tailscale switch (F-510 to F-512).
- SSH through a jump host (`ProxyJump`, `ProxyCommand`), and settings outside the subset of section 5. The person uses a setup code or Advanced.
- OpenClaw profiles other than the default and `clawtrate`: Advanced reaches them.
- Updating OpenClaw from Clawtrate, and changing the gateway's bind.
- A relay of Clawtrate's own: this design has none, and nothing in it depends on one.
- "Another computer" over SSH on iPhone.
- The pairing screen itself, which `visual-language.md` §10 keeps as it is.
