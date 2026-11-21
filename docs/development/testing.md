# Testing

All of these must pass before work is handed over. `pnpm scenarios` also runs when you change the development gateway or its scenarios.

```bash
pnpm lint        # ESLint and Prettier
pnpm typecheck
pnpm test        # unit tests
pnpm e2e         # end-to-end tests against a development gateway of their own
pnpm visual      # screenshots and behaviour of the fixture mode; the baselines are macOS ones
```

The memory plugin tests in `pnpm test` require OpenClaw 2026.10.6. Install it globally or set `OPENCLAW_PACKAGE_DIR` to the directory of that installed package.

The unit tests include the SSH transport's, some against an `sshd` they start themselves ([The SSH transport's tests](ssh.md)).

The unit tests include the relay's, which run it as a Node process and as a Worker in Miniflare through Wrangler's local test harness, both on 127.0.0.1 and with no Cloudflare account ([the relay's checks](../../services/relay/README.md#checks)).

CI runs lint, typecheck and the unit tests on Linux, `pnpm e2e` on Linux with OpenClaw 2026.10.6 from npm, split by file across three runners, `pnpm visual` on every core and an unsigned `pnpm package:mac` on macOS 15, and on Windows Server 2025 an unsigned `pnpm package:win`, a silent install, a check of the Start menu shortcut, `pnpm check:packaged` against the installed app, and a silent uninstall that must leave nothing the installer made. A pull request that changes only documentation (`docs/`, the Markdown files at the top level, the issue and pull request templates) runs the Linux `check` job alone.

`pnpm test:desktop-updates` runs the desktop update flow on macOS and Windows. It builds a temporary Electron app with a loopback feed, launches it with a fresh profile, and checks the renderer through the real preload and main process. It runs independently of packaging and development gateways.

## The scenario check

`pnpm scenarios` is the scenario check on an instance of its own. It starts an unseeded named instance, connects with the official gateway client as three paired operators (read and write; plus `operator.approvals`; plus `operator.questions`), triggers every scenario above, and asserts what the gateway emitted: each run's lifecycle, the reasoning and tool events in order, the question cards and their answers, the approval requests with the decisions they offer and their resolution, the bot-to-bot tool results and the recipients' runs, the MCP results, stops, steers and queued messages. Event payloads are checked against the schemas in `@openclaw/gateway-protocol`, and every tool call of every run, with its exact arguments, result and item, and every run's outcome, against the scenario that made it; a run the check does not assert fails it. It also checks that the tools the model is offered are exactly the allowed ones, and fails if a directive has no check. Its instance has the scripted provider accounts and sign-ins, and after the scenario checks it runs the account checks ([`tools/dev-gateway/README.md`](../../tools/dev-gateway/README.md#the-account-checks)) with an admin client and a read-only one. It prints one line per check and resets its instance afterwards, also on Ctrl-C. Then it runs the computer checks (`tools/dev-gateway/src/computer-checks.ts`) on a second instance of its own started with `--with-plugin clawtrate-computer`: a bot's own browser, watching, taking over and handing back, expiry, a caller that leaves, a tab that closes, and the browser's confinement to loopback, each asserted from the gateway's answers ([the plugin's page](../../plugins/clawtrate-computer/README.md#on-a-clawtrate-development-gateway) lists them). Then the rules checks (`tools/dev-gateway/src/rules-checks.ts`) on a third, started with `--with-plugin clawtrate-tool-rules`: the rules plugin's methods at each access tier, its cards and who receives them, its denies and limits, and what the gateway does for a routine, a stopped plugin and a message from another bot ([the plugin's page](../../plugins/clawtrate-tool-rules/README.md#on-a-clawtrate-development-gateway)). `pnpm e2e` runs the scenario checks on its own seeded instance (`e2e/scenarios.spec.ts`). What the checks found about the gateway is in [What the scenario check observed](../decisions.md#what-the-scenario-check-observed).

## Without a gateway: the fixture mode and the visual tests

```bash
pnpm fixture   # builds the interface on fixed sample data and serves it on 127.0.0.1:5341 (CLAWTRATE_FIXTURE_PORT picks another)
pnpm visual    # screenshot, legibility and behaviour tests against the fixture mode
```

The fixture mode is the real interface fed a fixed state through the same bridge the hosts use. It needs no gateway and makes no request of its own. Pick what it shows from the address: `?scene=` with `main`, `connect`, `connect-error`, `connecting`, `pairing`, `reconnecting`, `reconnecting-unloaded`, `offline`, `offline-long-address`, `catching-up`, `synced`, `sync-pending`, `sync-failed`, `refresh-failed`, `load-failed`, `loading`, `discovery-error`, `discovering`, `empty`, `partial`, `zero-tasks`, `task-states`, `protocol-mismatch`, `pairing-rejected`, `pairing-expired`, `connect-unreachable`, `disconnected` or `offline-unreachable`; `&bot=otto&task=agent:otto:disk-space` to open a task; `&panel=open`; `&theme=dark`; `&pins=main,otto`, `&hidden=marlow` and `&sort=name` for the rail's arrangement; `&bubbles=neutral`; `&routines=on` shows the gateway routines. Add `&access=admin` to edit them. The [routines fixture](../../apps/desktop/src/fixture/routines.ts) lists the states and controls for saves, pauses, runs and deletions. It is a separate build, never part of the desktop app or the web preview.

For Settings → Updates, choose a [fixture update state](../../apps/desktop/src/fixture/updates.ts) with `?updates=offered`, for example. The fixture has two tracks unless `tracks=one`. Choose the running track with `buildTrack=nightly`, the selected track with `track=nightly`, or a failed selection with `save=failed`. Without an update state, the fixture has no updater.

`pnpm visual` compares screenshots with the baselines in `visual/baselines/`, which are taken on macOS and only valid there. After an intended change, `pnpm visual:update` rewrites them; look at every changed image before committing it.

## The end-to-end tests

`pnpm e2e` never uses the default instance or its ports. Each run creates its own instance named `e2e-<random>`, plus an unseeded second instance so another gateway is always listening while it runs. It starts the gateway, its scripted model and a preview host with a fresh device identity on free ports, approves the pairing request the page raises, and checks that the bots, a task list and a transcript render, and that every other running instance is left as it was. A third, unseeded instance has the scripted provider accounts and a paired machine (`--with-node`), for the account checks and the checks of Settings, Machines and a bot's "Where it runs", which put back every setting they change. Afterwards it removes exactly what it created: its two instances by name and run id, its preview host and its temporary folders, also when a test fails or the run is stopped with Ctrl-C or SIGTERM. A run killed outright, at any point, leaves a record in `tools/dev-gateway/.run/e2e/`, and the next `pnpm e2e` in the same checkout cleans it up once that run is proven to have ended. Every gateway, scripted model and preview host is written to a record before it can run, so none is left that the next run cannot find. A `dev-gateway` command or renderer build that the killed run left behind finishes on its own; the next run's cleanup of an instance waits for that instance's lock. If the next run cannot determine whether the earlier one has ended, or whether its preview host has exited, it leaves the record and the folders alone and says why. Runs in several checkouts, or several in one, can go at the same time.
