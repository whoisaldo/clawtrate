# @clawtrate/connector

`clawtrate-connector` runs next to a person's own OpenClaw gateway and lets their phone reach it from anywhere through Clawtrate's relay, end to end encrypted. It keeps a control socket open to the relay, answers each phone's Noise IK handshake as the responder, refuses any phone not on its allowlist before it touches the gateway, and carries the gateway's own WebSocket protocol unchanged over a loopback socket it builds itself.

```
phone ── wss ──► relay ◄── wss ── clawtrate-connector ── ws://127.0.0.1:<port>, X-Forwarded-For ──► OpenClaw
```

The connector grants nothing. OpenClaw's pairing, approval and scopes decide what every device may do: a relayed phone reaches the gateway as a remote device and waits for its owner's approval, as it would over Tailscale.

The protocol is [`@clawtrate/relay-protocol`](../relay-protocol/README.md) and the relay is [`services/relay`](../../services/relay/README.md).

## Commands

```bash
clawtrate-connector setup --relay wss://relay.example [--gateway-port 18789] [--openclaw-bin <path>] [--openclaw-profile <name>]
clawtrate-connector run                 # in the foreground; the service files run this
clawtrate-connector status [--json]
clawtrate-connector pair-phone [--name "My phone"] [--json]
clawtrate-connector remove-phone <phone key or name>
clawtrate-connector teardown            # puts gateway.trustedProxies back, removes the service files
```

Every command takes `--state-dir <dir>`; the default is `$CLAWTRATE_CONNECTOR_HOME` or `~/.clawtrate-connector`. In this checkout, run it as `node packages/connector/src/cli.ts <command>`.

- **`setup`** creates the state folder and the connector's keys if they are missing, records the relay and the gateway's port, makes sure `gateway.trustedProxies` covers loopback (below), and writes the service files. Running it again keeps the keys, and with them the relay id and every paired phone.
- **`run`** keeps the relay connection up and serves phones until SIGINT or SIGTERM.
- **`status`** prints the relay id, the connector key, whether `run` is up (from the status file it rewrites every 30 seconds), the paired phones, open pairing codes, and what the connector set in `gateway.trustedProxies`.
- **`pair-phone`** asks OpenClaw for a setup code with `openclaw qr --json --limited --url <dial address>`, then prints a relay pairing code as a QR code in the terminal and as text. The code works once, for at most 10 minutes. The phone then waits for its owner to approve it on the gateway (`openclaw devices approve <request id>`).
- **`remove-phone`** takes a phone off the allowlist. A running connector ends that phone's session within 5 seconds. Revoking the device on the gateway (`openclaw devices remove`) is separate and is what OpenClaw itself enforces.

## The pairing code

The code is what core's relay route parses (#270): base64url, unpadded, of one flat JSON object with these members in this order.

| Member         | Value                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------- |
| `v`            | `1`                                                                                             |
| `relay`        | the relay's canonical origin, `wss://host[:port]`                                               |
| `relayId`      | the connector's relay id (26 characters)                                                        |
| `connectorKey` | the connector's Noise static public key, base64url; the phone pins it                           |
| `enroll`       | a fresh 32-byte enrollment secret, base64url                                                    |
| `expiresAtMs`  | when the secret expires: 10 minutes from now, or the setup code's expiry if that comes first    |
| `openclaw`     | OpenClaw's setup code, exactly `{url, bootstrapToken, expiresAtMs}` with `url` the dial address |

`pair-phone` refuses a setup code with other members, for another address, or already expired. Only the SHA-256 of the secret is stored, with its expiry and the phone's name. When the phone's handshake carries the secret, the connector enrolls its key once, in one atomic step under the state folder's lock, exactly as the protocol's enrollment requires: nothing changes before the phone's confirm record, a spent or expired secret is refused, and of two phones that present one secret only the first is enrolled.

## The gateway bridge

A session's gateway socket is opened only after the channel admits the phone. A phone that is not enrolled, or whose secret is refused, never causes a connection to the gateway.

The connector builds that upgrade itself:

- **`X-Forwarded-For`** is always set and never loopback. It is the phone's address as the relay reported it when that is a public unicast address, and `192.0.2.1` (a documentation address) otherwise. The gateway treats a loopback socket with no forwarded headers as `direct-local` and pairs it silently, as if it sat at the gateway's keyboard; a loopback `X-Forwarded-For` it refuses ([`docs/research/relay.md`](../../docs/research/relay.md)).
- **`X-Forwarded-Proto`** is `https` for a `wss:` relay, and **`X-Forwarded-Host`** is the relay's host.
- **Nothing else** is set beyond what WebSocket itself needs: no `Origin`, no compression, and no header from the phone. The relay passes no phone header on, and the connector would not forward one.

Text passes both ways unchanged, so the gateway's protocol, its `connect` signature and its device tokens are the phone's business. A binary message from the gateway closes the session. Sizes come from the protocol: a relay frame is at most `MAX_FRAME_BYTES`, a gateway message at most `MAX_MESSAGE_BYTES` (25 MiB), one `ReceiveBudget` of 64 MiB covers all sessions' unfinished messages, and the partial-message deadline runs on a timer. At most 25 MiB plus 8 MiB may wait to be written to either socket. A gateway that closes is reported to the phone with an authenticated close carrying its code.

## `gateway.trustedProxies`

With `X-Forwarded-For` set, the gateway accepts the connector's loopback socket only when `gateway.trustedProxies` covers loopback; it then attributes it as `trusted-proxy`, which is remote. `setup` handles that through OpenClaw's own command line:

1. It reads the `gateway` section (`openclaw config get gateway --json`) and records the exact earlier value of `trustedProxies`: absent, or the list as it was, in order. The record is written before anything changes.
2. If loopback is not covered, it sets the union of the earlier list with `127.0.0.1` and `::1`, conditional on the value it read (`--expect-current-absent` or `--expect-current-json`), so a change made in between is refused rather than overwritten.
3. It reads the value back and fails unless it is exactly the union.

`teardown` puts back exactly the recorded value (removing the key if it was absent), again conditional on what the connector set, and reads it back. If someone changed the setting after the connector set it, nothing is overwritten and the record is kept. "Restored" is never inferred from having written a command. `--no-trusted-proxies` skips this for a gateway whose owner manages the setting.

The local processes on the gateway's computer that send no forwarded headers stay `direct-local`, so the desktop app there still pairs as before.

## Supervision

The control socket's supervision is ported from T3 Code's cloudflared supervision:

- **Restarts.** A link that ends restarts at once, then after 1 second, doubling to 60 seconds while it keeps ending within 30 seconds of starting. One that stayed up 30 seconds restarts at once and resets the ladder. Applying the same settings again keeps the backoff.
- **Registration.** A link that has not registered after 90 seconds is restarted.
- **Readiness.** Every 30 seconds the connector asks whether the relay was heard since the last reading. It pings every 25 seconds and the relay answers, so a quiet link counts as not ready. Six not-ready readings in a row restart it, and the threshold then doubles up to 60. A ready reading resets both. A link that is not registered yet says nothing.
- **Shutdown.** SIGINT or SIGTERM closes the link and every session, and nothing restarts.

## State folder

| File                   | What                                                                          |
| ---------------------- | ----------------------------------------------------------------------------- |
| `keys.json`            | the Ed25519 registration key (the relay id derives from it) and the Noise key |
| `connector.json`       | the relay origin, the gateway's port, how to run OpenClaw                     |
| `phones.json`          | the allowlist and the pending offers (secret hashes)                          |
| `trusted-proxies.json` | what `setup` found and set in `gateway.trustedProxies`                        |
| `status.json`          | the running connector's state, rewritten every 30 seconds                     |
| `service/`             | the generated LaunchAgent and systemd unit                                    |

The folder is mode 700 and every file mode 600, owned by the user. Each file is written whole to a new file, flushed and renamed over the old one. A file that is not exactly what this version writes (bad JSON, other fields or values), a link, or a file or folder others can read is refused, never repaired. The folder may not be inside an OpenClaw folder: any path part starting with `.openclaw`, or `$OPENCLAW_STATE_DIR` or `$OPENCLAW_HOME`.

## Service files

`setup` writes `dev.clawtrate.connector.plist` (a LaunchAgent: run at login, kept alive, at most every 10 seconds, umask 077, output to `connector.log` in the state folder) and `clawtrate-connector.service` (a systemd user unit: restarted on failure, `UMask=0077`, `NoNewPrivileges=yes`). They run `node <cli.ts> run --state-dir <folder>`. The connector never loads them: it prints the `launchctl bootstrap` or `systemctl --user enable --now` command for the person to run.

## Checks

`pnpm vitest run packages/connector` (part of `pnpm test`):

- [`test/state.test.ts`](test/state.test.ts): owner-only modes, atomic replacement, corrupt and unsafe files refused, no folder inside OpenClaw's, the lock.
- [`test/allowlist.test.ts`](test/allowlist.test.ts): with the protocol's initiator and responder, enrollment once, a replayed or expired secret refused at the handshake and at the commit, two phones confirming one secret, a dead attempt committing nothing, only the secret's hash on disk, removal.
- [`test/bridge.test.ts`](test/bridge.test.ts): over real sockets, the upgrade's exact header set with `X-Forwarded-For` on every upgrade whatever address the relay reports, nothing from the phone passing into it, text unchanged both ways, no gateway connection for a refused phone, the size limits, a gateway close carried to the phone.
- [`test/supervisor.test.ts`](test/supervisor.test.ts): T3's supervision scenarios on a clock the test holds.
- [`test/envelope.test.ts`](test/envelope.test.ts): the pairing code's exact form, core's own parser when it is in the tree, setup code refusals, the QR code, and `pair-phone` with OpenClaw played by a stand-in.
- [`test/trusted-proxies.test.ts`](test/trusted-proxies.test.ts): record, set, verify and restore against a config stand-in, and the exact `openclaw config` command lines.
- [`test/service.test.ts`](test/service.test.ts): both service files as text, with escaping. Nothing is loaded.
- [`test/relay.test.ts`](test/relay.test.ts): the running connector against the relay's Node runner: registration, enrollment, a round trip, a stranger refused with no gateway connection, a removed phone cut off, and registration again after the relay restarts.

[`e2e/dev-gateway.ts`](e2e/dev-gateway.ts) runs it against a named development gateway:

```bash
pnpm dev-gateway start --instance <name> --trust-loopback-proxy --no-seed
node packages/connector/e2e/dev-gateway.ts --instance <name>
pnpm dev-gateway reset --instance <name>
```

It starts the relay's Node runner, runs `setup` (reading the gateway's real `trustedProxies`), starts `run` as its own process, makes a code with `pair-phone` (a real `openclaw qr --limited`), and has a Node phone on the protocol's initiator redeem its bootstrap token with OpenClaw's own client through the relay. It checks that the gateway makes the phone wait with the connector's forwarded address, that after `devices approve` it says hello with exactly `operator.read` and answers a request, that the pairing was not silent, and that a phone that is not enrolled is refused with no connection reaching the gateway (counted by a pass-through in front of its port). It removes the phone's device afterwards.

## Licence

[`src/supervisor.ts`](src/supervisor.ts) and [`test/supervisor.test.ts`](test/supervisor.test.ts) port logic and test scenarios from T3 Code under the MIT licence; each keeps its notice, and [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) lists them.
