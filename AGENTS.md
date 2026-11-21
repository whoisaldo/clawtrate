# Clawtrate

Your OpenClaw agents, orchestrated.

Clawtrate is a desktop and iOS client for OpenClaw. It gives an OpenClaw gateway you already run a bots-first interface: your bots in a sidebar, tasks under each bot, the bot's work beside the conversation, and fine-grained control over each bot. Open source, MIT licensed.

This file is for the coding agents and the people who change Clawtrate. Claude Code, Codex and most other agents load it on their own. [CONTRIBUTING.md](CONTRIBUTING.md) has the same rules from a contributor's side, and [docs/README.md](docs/README.md) lists every document.

## What we never compromise on

### The repository is public

Every commit, pull request title and body, and issue is published the moment it is pushed. Never put any of these in them: secrets or tokens, private hostnames or IP addresses, usernames or home-directory paths, email addresses, personal data, the names or conversations of anyone's real bots, or third-party images and copied assets. Read the diff, the title and the body for these before every push.

### The user's gateway is theirs

Clawtrate is a client, and the agent runtime is the user's OpenClaw gateway. Nothing in this repository may put that gateway at risk. Request the smallest operator scopes a feature needs, and keep a read-only connection useful. Provider credentials stay on the gateway. Clawtrate starts the gateway's own sign-in and never reads, stores or copies them.

### Say only what the gateway established

A screen shows what the gateway confirmed and no more. Where the gateway lacks something a flow needs, add an OpenClaw plugin under `plugins/` instead of making it up in the client.

### Done means a passing check

`docs/parity.md` is the definition of done. Every flow has a stable id such as `F-012`. Work is done when its flow passes an automated check whose title begins with that id.

### Our own identity

The name Clawtrate and the slogan "Your OpenClaw agents, orchestrated." are fixed. Saying what Clawtrate works with, including naming OpenClaw, is fine, and so is matching layout and interaction patterns. Never use OpenClaw's, Grok's or xAI's logos, icons or copied assets. The logo is `assets/brand/logo.png`. App icons, the favicon and the interface's accent color all come from that one file, so it can be swapped in one place.

## What we are building

- The bar is the full user flow of Grok Bot, xAI's personal agent app, plus the controls its users say they lack. Those controls are per-bot model and reasoning effort, per-bot tool permissions and approval rules, an editable memory viewer, a choice of which machine a bot works on, and the raw tool calls behind every card.
- Two things go beyond Grok Bot. Each bot runs on a provider account the user chooses when creating it. Subscription sign-ins come first, and API keys are a secondary option. And a bot can work with T3 Code: start a thread there, follow up and read the result. This integration is optional. It is a switch in settings, off by default, and nothing else depends on it. Its connection belongs to the gateway, so the client never connects to T3 Code itself.
- The conversation reads at the level of what a bot did. Each action shows as a plain-words card, in one family with the "Messaged &lt;bot&gt;" and "Messaged T3 Code" cards, that a person can follow without opening anything. Reasoning text stays folded away behind it, and the raw call is one step further. Grok Bot's handling of this is the model.

## A small glossary

- **Gateway** is the user's OpenClaw gateway. It runs the bots, and Clawtrate connects to it as an operator.
- **Bot** is an OpenClaw agent. A bot has many tasks.
- **Task** is one conversation with a bot. The gateway calls it a session.
- **Run** is one turn of work in a task: the reasoning, the tool calls and the reply.
- **Action card** is one thing a bot did in a run, in plain words, with the raw call one step further. Approvals, questions and the "Messaged" cards belong to the same family.
- **Scope** is an operator permission the gateway grants, such as `operator.read` or `operator.approvals`.
- **Host** is the process that holds the gateway connection and the device key: Electron's main process, or the web preview host.
- **Bridge** is the contract between a host and the interface, in `packages/core/src/bridge.ts`.
- **Development gateway** is a throwaway OpenClaw gateway started by `pnpm dev-gateway`, with a scripted model. One checkout can run several, each an **instance**.
- **Scripted model** is the stand-in model provider in `tools/dev-gateway`. Directives such as `#steps` make it play a scenario.
- **Fixture mode** is the real interface fed fixed sample data, with no gateway. The visual tests run against it.
- **Row** is one behavior in `docs/parity.md`, with its id.

## The three ways to hurt yourself

1. **Touching a real gateway.** Develop only against development gateway instances started by `pnpm dev-gateway`. The default instance is `openclaw --dev`, state in `~/.openclaw-dev`, port 19001. A named instance, chosen with `--instance <name>` or `CLAWTRATE_DEV_INSTANCE`, is `openclaw --profile clawtrate-dev-<name>`, state in `~/.openclaw-clawtrate-dev-<name>`, on free ports the tool chooses and records. Use a named instance when another checkout may be running the default one. `pnpm e2e` always creates its own instance. Never run `openclaw` without `--dev` or `--profile clawtrate-dev-<name>`, never against the default profile, and never read or write `~/.openclaw`. Never copy credentials from another OpenClaw profile. The development gateway uses the scripted model in `tools/dev-gateway`.
2. **Killing by name.** Stop only processes you started, by PID. Never kill by process name. Other checkouts and other agents run development gateways on the same machine.
3. **Publishing something private.** Everything pushed is public at once, and history keeps it after a fix. Check before you push, not after.

## Where code lives

- `packages/core` (`@clawtrate/core`) holds the gateway connection, device identity, state stores and the mapping from gateway events to view models. No DOM and no Node-only APIs in shared code. The host injects WebSocket, storage and signing, so the same core runs in Electron, Node and Expo. Node implementations live behind `@clawtrate/core/node`. Its [README](packages/core/README.md) is the guide for building the interface on it.
- `packages/ui` (`@clawtrate/ui`) holds the React interface shared by the desktop app, the web preview and the fixture mode.
- `apps/desktop` is the Electron app: the main process, the preload script, the renderer entry, the web preview host, the fixture mode and the packaging configuration. The same renderer also runs in a browser through the web preview host, for remote review and self-hosted web use.
- The Expo iOS app will live in `apps/mobile` and consume `packages/core`. It is not on `main` yet.
- `packages/relay-protocol` (`@clawtrate/relay-protocol`) holds the wire protocol for reaching a gateway through Clawtrate's relay: frames, relay messages, the connector's register proof and the Noise IK channel. Like shared core, it uses no Node or DOM APIs.
- `services/relay` (`@clawtrate/relay`) is the relay itself: a Cloudflare Worker with a Durable Object per relay id, and a Node runner, on one core. It is run locally only; nothing deploys it yet.
- `packages/connector` (`@clawtrate/connector`) is `clawtrate-connector`, the Node program that runs next to a person's gateway: it keeps a control socket open to the relay, ends each phone's Noise channel, refuses phones it has not enrolled, and bridges the gateway's protocol over a loopback socket it builds itself with `X-Forwarded-For`. It is run locally only; nothing installs it yet.
- `plugins/` holds OpenClaw plugins that fill gateway gaps.
- `tools/dev-gateway` starts, seeds and resets development gateways and runs the scripted model. `tools/brand` makes the icons from the logo.
- `e2e/` holds the end-to-end tests, `e2e-packaged/` the launch check for a packaged app, `visual/` the visual tests and their macOS baselines, and `test/` the repository-wide unit tests, such as the parity check.
- `docs/` holds the plan, the definition of done, the design, the research and the decisions. [docs/README.md](docs/README.md) lists them.

Workspace packages are named under the `@clawtrate` scope. Build on the official `@openclaw/gateway-client` and `@openclaw/gateway-protocol` packages, pinned to an exact version and tested against the gateway version named in `docs/decisions.md`.

A builder may change this layout when it has a reason. Record the reason in `docs/decisions.md`.

## Verifying

TypeScript is strict. `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm e2e` and `pnpm visual` must pass before work is handed over. The visual baselines are macOS ones, so on another system say that in the pull request and let CI's macOS job check it. Run `pnpm scenarios` when you change the development gateway or its scenarios, and `pnpm check:packaged` when you change packaging or the main process. [docs/development/testing.md](docs/development/testing.md) says what each check covers.

A check that fails only sometimes is a defect. Find out whether the app or the check is wrong before you touch the check. CI runs each visual test once more after a failure, and the run's summary lists by name each test that passed only on the retry. Those still need fixing.

## Pull requests and commits

- One issue, one pull request. Start the body with `Closes #<number>`, or `Part of #<number>` when the issue takes more than one.
- `main` gets one squashed commit per pull request, and its whole message is the pull request's title with its number. The title has to make sense on its own in `git log`. The body stays on the pull request.
- The title is `type: what changes for the person using Clawtrate`, under 72 characters. Types are `feat`, `fix`, `docs`, `test`, `ci`, `refactor` and `chore`. Name what someone can now do or what stops going wrong, not the function you changed. `fix: a stopped run no longer restarts after a reconnect` is right. `fix(core): guard the lease generation in releaseControl` is not. Neither is a title that lists every part of the change in one long sentence.
- Describe the problem in a sentence or two, then explain the change and how you checked it. Use short, plain sentences, active voice and concrete words. Delete the template's comments.
- End every Clawtrate PR body with the model and coding harness that did the work. Write `AI: MODEL via HARNESS` using the names the tool shows. If several pairs contributed changes, put each on its own line in the final paragraph. If no AI contributed, end with `No AI used.`
- Before approving or merging, verify the disclosure. If it is missing or incomplete, ask the author to supply it and leave the PR open. Never guess another contributor's model or harness.
- Interface changes need before and after screenshots at desktop and phone width.
- CodeRabbit reviews every pull request into `main` that is not a draft. Treat its comments like any other review: check each against the code, fix the real ones, and reply with the reason when one is wrong. Nothing waits on it.
- Commits on a branch are small and describe the change. Keep the AI disclosure in the PR body. Leave co-author trailers, "generated with" lines and tool credits out of commit messages and PR titles.

## Documentation

- The README is for someone deciding whether to use Clawtrate. Keep it short, and put the detail in `docs/`.
- `docs/development/` explains how to run, test and package Clawtrate. Update it when a command or a flag changes.
- `docs/decisions.md` records why things are the way they are, where the code cannot show it. When a decision changes, rewrite its section instead of adding a second account below it.
- `docs/parity.md` changes only in the rows your work covers. Never renumber a row.
- Research that the plan relies on goes in `docs/research/`. Plans, scratch notes and agent working files stay out of the repository, and work is tracked in issues.
- Do not document what the code already says. Link to the source instead of copying it.
- Write plainly. Use short sentences, the active voice and concrete words, and no marketing language.
