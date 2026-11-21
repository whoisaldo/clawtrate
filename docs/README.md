# Documentation

Every document in the repository, by what you want to do.

## Run or change Clawtrate

- [Developing Clawtrate](development/README.md): setup, the web preview and the desktop app.
- [The development gateway](development/dev-gateway.md): the gateway with a scripted model that everything is built against, its instances, plugins, scripted accounts and scenarios.
- [Testing](development/testing.md): each check, what CI runs, the fixture mode and the visual tests.
- [The SSH transport's tests](development/ssh.md): running the tests of "Another computer" over SSH against an `sshd` of their own.
- [Packaging](development/packaging.md): building the desktop app for macOS and Windows, signing, and the logo and icons.
- [Desktop release candidates](development/releases.md) covers stable and nightly builds, signing checks, publication and withdrawal.
- [CONTRIBUTING.md](../CONTRIBUTING.md): how to pick up work and open a pull request.
- [AGENTS.md](../AGENTS.md): the rules every change follows, written for coding agents and people alike.

## Understand how it works

- [Architecture](architecture.md): the pieces and how they talk to each other.
- [Decisions](decisions.md): versions, protocol choices and the reasons behind them.
- [The engine's guide](../packages/core/README.md): the bridge, the commands the interface sends and the state it reads, for building the interface on `@clawtrate/core`.
- [The relay protocol](../packages/relay-protocol/README.md): frames, relay messages, the connector's register proof and the end-to-end Noise channel for reaching a gateway through the relay.
- [The development gateway tool](../tools/dev-gateway/README.md): scripted provider accounts, sign-ins and the account checks.
- [The computer plugin](../plugins/clawtrate-computer/README.md): a bot's own browser, watched live and taken over by a person.
- [The rules plugin](../plugins/clawtrate-tool-rules/README.md): what each bot may do with its tools, asked first or never, while the plugin runs.

## The plan

- [Roadmap](roadmap.md): what is left to build, by milestone, and how to take a part of it.
- [Parity checklist](parity.md): the definition of done, one behavior and one automated check per row.

## Design

- [Visual language](design/visual-language.md): tokens, type, surfaces, the rail and the plain transcript.
- [Conversation](design/conversation.md): how a running turn looks, moves and reads.
- [Work pane](design/work-pane.md): what sits beside the conversation, a task's files, what a bot made and the bot's computer.
- [Bots](design/bots.md): creating a bot on an account, connecting accounts, a bot's settings and the optional T3 Code integration.
- [Controls](design/controls.md): what each bot may do and who enforces it, saved approvals, activity, memory, where a bot runs, usage and warning budgets.
- [Setting up](design/setup.md): the first run, where OpenClaw runs and what Clawtrate found there, connecting on this computer or over SSH, installing OpenClaw, setup codes and approvals.
- [Search](design/search.md): the Cmd/Ctrl+K palette, what each source covers, opening a result in its place, and the iPhone's scopes.
- [Prototype](design/prototype/README.md): static pages that show the design working.

## Research

- [Grok Bot flows](research/grok-bot-flows.md): how the reference app behaves on desktop and iOS, from public material.
- [Gateway capabilities](research/gateway-capabilities.md): what a client can do against an OpenClaw gateway, method by method.
- [Provider accounts and T3 Code](research/provider-accounts-and-t3-code.md): how OpenClaw handles provider accounts, and how a bot can work with T3 Code.
- [The setup flow](research/setup-flow.md): first pairing, setup codes, the gateway's identity, installing and removing OpenClaw, SSH from a shipped app, and Tailscale, from OpenClaw's source and live runs.
- `research/setup-flow/`: the probe behind the setup flow note.
- [Search](research/search.md): what the gateway's message search matches, its order and limits, what a narrower search finds, its cost, and the file and routine lists, from OpenClaw's source and a development instance.
- `research/search/`: the probe behind the search note.
- [Addresses a gateway hands the client](research/remote-content.md): every picture, link, file, page and sign-in address a gateway can hand Clawtrate, who writes it, what each app does with it today, and what Electron, the browser and iOS can enforce.
- `research/dev-gateway/`: the probes and prototypes behind the capability map.

## Writing docs

[AGENTS.md](../AGENTS.md#documentation) has the rules: what goes where, and how to write it.
