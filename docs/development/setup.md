# The first screen and the look on this computer

The desktop app's first screen asks "Where does OpenClaw run?" ([`docs/design/setup.md`](../design/setup.md)). "This computer" looks for OpenClaw's gateway on the computer the app runs on and pairs with it read-only after the app's own dialog. On a developer's computer that would find, and could pair with, the OpenClaw you use every day. So the look never sees the real computer from a checkout, and no development, test, screenshot or preview run starts a program of OpenClaw's to look.

## What must be sandboxed

A run must be sandboxed when any of these holds (`mustSandbox` in [`apps/desktop/src/setup/world.ts`](../../apps/desktop/src/setup/world.ts)):

- the app is not packaged (`pnpm desktop`, `pnpm desktop:dev`);
- any of the variables `CLAWTRATE_E2E_RUN`, `CLAWTRATE_AUTOMATED`, `CLAWTRATE_SCREENSHOT`, `CLAWTRATE_SETUP_SANDBOX`, `VITEST` or `CI` is present at all, an empty value included;
- the app was started with any of the switches `--remote-debugging-port`, `--remote-debugging-pipe`, `--inspect`, `--inspect-brk` or `--clawtrate-setup-sandbox`.

The desktop app decides this before anything else starts, before its single-instance lock and its connection (`resolveSetupLaunch` in [`apps/desktop/src/setup/sandbox.ts`](../../apps/desktop/src/setup/sandbox.ts)). A run that must be sandboxed never reopens the gateway its data folder remembers; a gateway you choose in Advanced still connects. The web preview's `--setup-look` is always sandboxed.

A packaged app started with none of these is a person's app, and it looks at the real computer. Nothing can tell a packaged app driven by other automation from one a person opened. So **nothing may automate a packaged app without the sandbox switch**. `pnpm check:packaged` gives it one on every launch, the second launch included, and `test/sandboxed-launches.test.ts` checks that it does.

A run that must be sandboxed and was given no sandbox, or one that doesn't pass, is refused before anything is opened: its output gets one fixed line, "The look on this computer refused to start: …", and "This computer" shows "Looking on this computer is off here" with the reason, on macOS and Linux. Windows shows Use Advanced.

## A sandbox

A sandbox is a private folder of your account's, under a temporary root fixed in code, reached without links and outside your home, holding its description, `sandbox.json`:

```json
{ "instance": "look", "run": "<the instance's current run id>", "scenario": "recorded" }
```

The description names a development instance of yours, the run id `pnpm dev-gateway start` recorded for it in this checkout, and a scenario. Nothing else is accepted: no program, no folder, no port. The host computes everything else:

- **The folder.** The description lies directly in a folder below the system's temporary root (`/private/tmp` or `/private/var/folders` on macOS, `/tmp` or `/var/tmp` on Linux; `TMPDIR` only picks a place inside one), with no link anywhere below that root, outside your home, yours and closed to others. The description itself is a small regular file of yours with one link, read without following a link. The look's home is the folder's `home`, its working folder `work`, and the app's data folder `app-data`, a private real folder too: the desktop app takes it as its data folder before its single-instance lock, and the web preview as its data folder. Nothing ties the folder to the launch that wrote it: any such folder of your account is taken, and what its description can select is held by the instance's proof below.
- **The instance.** Your home comes from your account, never from `HOME`. Inside it the only path used is the instance's state folder, `~/.openclaw-clawtrate-dev-<name>`, a real folder of yours. Before anything in it is used, the host proves the run is this checkout's with the dev-gateway tool's own records: the tool's marker, read without following a link and trusted by the tool's own rules, naming the instance and the description's run; this checkout's run record agreeing on the run, the instance, the checkout and the port; a port at the start of an instance's block; a config file, if there is one, that is a regular file with one link; and the gateway the marker recorded, alive with its recorded start time or proven gone. A packaged app has no checkout of its own, so `pnpm check:packaged` names its checkout with `--clawtrate-setup-checkout`.
- **The stand-in.** The host answers the look's commands itself (`standIn` in `sandbox.ts`), for the instance's profile alone: the version and the auth mode from the scenario's fixtures, the status from the proven run (its port, its config's path, loopback, no registered service, and whether the recorded gateway is alive). It starts no program, loads no OpenClaw config and opens no socket. It never answers the deep status, which scans the system's service folders.
- **Pairing.** A development instance is never paired with through "This computer": after the dialog, Connect is refused. The `pairing` scenario's gateway is the host's own synthetic one (`synthetic-gateway.ts`), on loopback, on a port the system chooses, and its one-time codes come from the stand-in's fixture mint. It proves the app's side of pairing, not OpenClaw's.

The scenarios:

| Scenario                 | What the look sees                                      |
| ------------------------ | ------------------------------------------------------- |
| `recorded` (the default) | The instance as its run recorded it, running or stopped |
| `untested-version`       | The same, at OpenClaw 2026.9.37                         |
| `not-found`              | No program, no signs of OpenClaw                        |
| `program-missing`        | No program, with signs of OpenClaw                      |
| `pairing`                | A gateway Connect pairs with: the host's synthetic one  |

What OpenClaw's own `gateway status` would inspect is in [docs/decisions.md](../decisions.md#setting-up-on-this-computer). What the real program prints is covered by recorded outputs in the unit tests.

## Running the first screen against a development instance

Start an instance:

```bash
pnpm dev-gateway start --instance look
```

Write a sandbox for it; this prints the description's path:

```bash
node e2e/setup-sandbox.ts --instance look --scenario recorded
```

Start the desktop app with it:

```bash
CLAWTRATE_SETUP_SANDBOX=<that path> pnpm desktop
```

"This computer" finds the instance and names its version, profile, its configured bind ("Configured for loopback") and its service ("No matching service reported"). Write the sandbox while the instance runs; it stays valid after `pnpm dev-gateway stop --instance look`, and then shows "installed but not running". A folder `.openclaw-work` in the sandbox's `home` is named as another profile and not used. Write a sandbox with another `--scenario` to see the other results; `pairing` follows Connect to the end. The sandbox stays valid until the instance is started again.

The web preview shows the same screens, without pairing, with its data in the sandbox's folder:

```bash
pnpm preview:web --setup-look --setup-sandbox <that path>
```

Reset the instance when you are done: `pnpm dev-gateway reset --instance look`.

## The fixture

`pnpm fixture` serves every state on fixed data, with no host and no gateway: `?setup=first`, `looking`, `found`, `found-paired`, `untested`, `stopped`, `cant-run`, `endpoint`, `not-found`, `connecting`, `code-failed`, `bots` and the others listed in [`apps/desktop/src/fixture/setup.ts`](../../apps/desktop/src/fixture/setup.ts). The visual tests take their baselines from these.

## The checks

- `apps/desktop/test/setup-look.test.ts` runs the look on recorded outputs of OpenClaw 2026.10.6, with every command checked against the runner's exact list. Its sandbox tests use three fake homes and two runs, and prove each refusal with a case that only that check catches, counting what was read and which processes were asked.
- `apps/desktop/test/setup-stand-in.test.ts` runs the stand-in and a sandboxed setup from the look to Connect, counting every program, socket and request the process makes: none outside the pairing scenario.
- `apps/desktop/test/setup-host-start.test.ts` checks that a sandboxed start never resumes a saved gateway, that Advanced still connects, and the web preview's `--setup-look`.
- `apps/desktop/test/setup-connect.test.ts` runs Connect with a fake `openclaw` and the core's fake gateway:
  - the dialog comes first, in the words that are true for this device;
  - the facts are checked again after the dialog, and the code is used once;
  - the code reaches none of the places it must never go;
  - a cancel starts nothing more;
  - the runner's exact commands, working folder and kill after a grace hold.
- `packages/core/test/setup-token-gate.test.ts` covers the core's part:
  - the first token is written only for exactly read;
  - a later grant is held to what was asked;
  - nothing the gateway echoes reaches state or a log.
- `e2e/setup.spec.ts` starts an instance of its own, `e2e-<run>-setup`, and records it before it starts. It drives the development build of the desktop app through sandboxes of that instance, and pairs in the `pairing` scenario. It needs Electron's binary and a display.
- `pnpm check:packaged` gives the packaged app a sandbox of the run's instance on every launch, and checks that the look sees that instance only.

## Another computer

A development build, and every run that must be sandboxed, offers no SSH: "Another computer" says it is off in this run, because its SSH world would be this account's own `~/.ssh` (`docs/decisions.md`, "Another computer: the setup host"). Only a person's packaged app reaches another computer. The checks make a world of their own instead: a temporary home with its own SSH configuration, keys and known-hosts file, and an `sshd` started as the current user on a loopback port (`apps/desktop/test/ssh/harness.ts`).

- `apps/desktop/test/ssh/remote-setup.test.ts` drives the setup host against that `sshd`, a stand-in `openclaw` in the test's home and the core's fake gateway: refusals by name before anything connects, the account's dialog, first contact, a key already trusted and a changed key, the failures, Connect and its token in the route store, a refused grant, the forward's restore after the `sshd` drops its sessions, a different gateway, Start, Remove, and the app-data privacy check.
- `apps/desktop/test/ssh/route-gateway.test.ts` is the same route end to end against a real development instance of its own, `e2e-<run>-ssh`, started with `--default-local-pairing` and reset at the end, recorded before it starts like the end-to-end runs. The stand-in answers the LOOK from the instance's recorded facts and makes the one-time code with the real program through the development tool's guarded runner (`mint-code.ts`). It needs `sshd` and OpenClaw 2026.10.6 on PATH, and skips without them.
- `apps/desktop/test/ssh/scripts.test.ts` runs the CODE and START scripts under `/bin/sh`, and `apps/desktop/test/setup-routes.test.ts` covers the sealed route store, the privacy check at the host's own entry point (a redirected folder, an ancestor another account can write, a real macOS access control list), the found card's words and the approve command. The tests' `sshd` turns off OpenSSH 9.8's per-source penalties, which the tests' many credential-free key probes would otherwise trip; it is the tests' own.

`pnpm fixture` shows the screens on fixed data: `?setup=there`, `there-invalid`, `there-refused`, `there-looking`, `there-hostkey`, `there-changed`, `there-found`, `there-stopped`, `there-not-found`, `there-connecting`, `there-starting`, `there-unreachable`, `there-sign-in`, `there-code-failed`, `there-app-files`, and the app with its route's strip: `route-restoring`, `route-restored`, `route-unreachable`, `route-key-changed`, `route-up` (Settings then offers Remove).
