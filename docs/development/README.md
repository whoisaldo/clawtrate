# Developing Clawtrate

How to run Clawtrate from a checkout. [CONTRIBUTING.md](../../CONTRIBUTING.md) covers how to take part, and these pages cover the tools:

- [The development gateway](dev-gateway.md): the gateway with a scripted model that everything is built against, its instances, plugins, scripted accounts and scenarios.
- [Testing](testing.md): the checks, what each one covers, the fixture mode and the visual tests.
- [The SSH transport's tests](ssh.md): the tests of "Another computer" over SSH, against an `sshd` of their own.
- [Packaging](packaging.md): building the desktop app for macOS and Windows, signing, and the logo and icons.
- [The first screen and the look on this computer](setup.md): why a development build looks only in a sandbox, and how to run "This computer" against a development instance.
- [Desktop release candidates](releases.md) covers stable and nightly builds, signing checks, publication and withdrawal.

## Setup

You need Node.js 26, pnpm 11 and, for anything that talks to a gateway, the OpenClaw CLI (`openclaw`, version 2026.10.6) on your `PATH`.

```bash
pnpm install
pnpm exec playwright install chromium   # once, for the end-to-end and visual tests
pnpm dev-gateway start                  # a fresh development gateway with four sample bots
```

## The web preview

```bash
pnpm preview:web
```

This builds the interface and serves it on `0.0.0.0:5310`. It prints a link with an access token, for example `http://localhost:5310/?token=…`, plus one per network address. Open that link from any machine that can reach this one. The token is generated at each start and printed once. Nothing is served without it.

In the browser, choose **Use the development gateway**. The gateway has not seen this device before, so Clawtrate shows a pairing request. Approve it:

```bash
pnpm dev-gateway approve
```

The page connects within a few seconds of approval. From then on, the device uses its own device token.

The gateway connection, the device key and pairing all live in the preview host process, not in the browser. That is why a plain `http://` page on another machine can pair at all. Useful flags (pnpm passes them through):

- `pnpm preview:web --dev-gateway` connects to the development gateway at startup.
- `pnpm preview:web --no-access-token` turns the access token off. It is only accepted with the development gateway. The host then opens nothing but the development gateway, and refuses to start if its data directory remembers another one; use a separate `--data-dir` for development.
- `pnpm preview:web --instance <name>` (or `CLAWTRATE_DEV_INSTANCE`) makes both of the above use that instance's gateway instead of the default instance's, but only while this checkout's `pnpm dev-gateway start --instance <name>` is provably the instance's current run and its gateway is running. That proof is read again from the instance's marker, this checkout's run file and the live process before every connection: the first one, a reconnect the user asks for, and every automatic retry. If it no longer holds, or cannot be determined, no socket is opened; the host shows that the gateway is not allowed and stops retrying it. The desktop app reads `CLAWTRATE_DEV_INSTANCE` the same way and applies the same proof to its development gateway.
- `pnpm preview:web --read-only` pins the connection to the read tier. The host asks the gateway for `operator.read` alone, even when its device was granted more, and never asks for more access; the interface shows the read-only conversation without "Request access", and every send, stop or answer is refused. Use it to show a gateway you only want watched.
- `--port`, `--host` and `--data-dir` change where it listens and where it keeps the device identity.

## The desktop app

```bash
pnpm desktop
```

This builds and starts the Electron app. The first run downloads the Electron binary. Its first screen asks where OpenClaw runs; **Advanced** opens the address-and-token form. A development build starts without a development gateway, so it doesn't offer **Use the development gateway**: type its address and token, or use the web preview above. "This computer" looks only in a sandbox you give it in a development build: [setup.md](setup.md) says how. A development build doesn't reopen the gateway it was last connected to; choose it again on the first screen.
