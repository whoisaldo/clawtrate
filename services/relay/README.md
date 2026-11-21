# @clawtrate/relay

The relay that lets a phone reach a gateway from anywhere. A connector next to the gateway keeps a control socket open to the relay; a phone dials the connector's relay id; the relay splices the phone's socket to a session socket the connector opens for it. The phone and the connector speak Noise IK end to end through it ([`@clawtrate/relay-protocol`](../../packages/relay-protocol/README.md)), so the relay passes binary frames it cannot read and grants nothing.

It runs two ways, on one core ([`src/core`](src/core)):

- **A Cloudflare Worker with a Durable Object per relay id** ([`src/worker`](src/worker/index.ts)), using SQLite storage and hibernatable WebSockets. Nothing is deployed yet. [`wrangler.toml`](wrangler.toml) is for local development only: `pnpm --filter @clawtrate/relay dev:worker` runs it in Miniflare on `127.0.0.1:8787`, with no account.
- **A Node process** ([`src/node`](src/node/server.ts)): `pnpm --filter @clawtrate/relay start`, on `127.0.0.1:8788` by default. It listens on loopback only (`--host ::1` is the other choice); `--origin` names a `wss://` origin when a TLS proxy sits in front of it, and `--database <file>` keeps its SQLite tables on disk.

## Paths

| Path                              | Who           | What                                                        |
| --------------------------------- | ------------- | ----------------------------------------------------------- |
| `GET /health`                     | anyone        | `{"ok":true,"protocol":1}`. Nothing about any relay id.     |
| `/v1/connector/<relayId>`         | the connector | Its control socket: register, then hear of dials.           |
| `/v1/dial/<relayId>`              | a phone       | Asks for the connector; spliced once the connector answers. |
| `/v1/session/<relayId>/<session>` | the connector | Answers one dial; spliced to that phone's socket.           |

Socket paths take a WebSocket upgrade with `GET`. Anything else is 404, a socket path without an upgrade 426, and another method 405.

## What happens

1. **Register.** A control socket gets one fresh challenge. The connector answers with a register proof, checked by the protocol's `ControlRegistration`: the challenge lasts 60 seconds, one attempt per socket, the proof names this relay's origin and this relay id, its `jti` is new, and the relay id is pinned to the first full key that registers it. The relay answers `registered`, or an error and a close. A newer registration with the same key replaces the older one (`replaced`), and phones still waiting for the older one are announced to it.
2. **Dial.** A phone's dial is counted (below), needs a registered connector (`connector_offline` otherwise) and a free session (`session_limit`). The connector hears `dial` with a fresh 16-byte session id and the phone's address as the relay saw it.
3. **Splice.** When the connector opens the session socket for a waiting dial, both get `open`. From then on each binary message from one goes to the other unchanged. The relay reads its size, never its contents.
4. **Ends.** When one end of a splice goes, the other gets `peer_gone`. When the last registered connector goes, waiting phones get `connector_offline`.

Each error is a relay `error` message, then a close:

| Error               | Close | When                                                                                                         |
| ------------------- | ----- | ------------------------------------------------------------------------------------------------------------ |
| `bad_proof`         | 1008  | The register proof fails, a second attempt on the same socket, or a key the id is not pinned to.             |
| `bad_message`       | 1008  | Text the direction may not carry or over 4,096 bytes, binary on a control socket, binary before `open`.      |
| `rate_limited`      | 1008  | Over a per-minute count, too many unregistered control sockets, a session's byte budget or queued bytes.     |
| `session_limit`     | 1008  | The relay id has its most sessions.                                                                          |
| `connector_offline` | 1008  | No registered connector for the relay id.                                                                    |
| `frame_too_large`   | 1009  | A binary message over 65,537 bytes. The Node runner closes with 1009 before reading it, without the message. |
| `idle_timeout`      | 1000  | A challenge with no answer, or a registered connector or a session with no traffic.                          |
| `dial_timeout`      | 1000  | The connector did not open the session in time.                                                              |
| `peer_gone`         | 1000  | The other end left, or a session socket for no waiting dial.                                                 |
| `replaced`          | 1000  | A newer registration of the same key.                                                                        |
| `internal`          | 1011  | A store failed, or the relay could not go on. A store that fails fails the registration.                     |

## Limits

| Limit                                          | Value                                  | Where                                    |
| ---------------------------------------------- | -------------------------------------- | ---------------------------------------- |
| Binary message                                 | 65,537 bytes                           | the protocol's `MAX_FRAME_BYTES`         |
| Relay text message                             | 4,096 bytes                            | the protocol's `MAX_RELAY_MESSAGE_BYTES` |
| Challenge                                      | 60 seconds                             | the protocol's `REGISTER_CHALLENGE_MS`   |
| Dial waiting for the connector                 | 15 seconds                             | [`limits.ts`](src/core/limits.ts)        |
| Idle connector or session                      | 2 minutes                              |                                          |
| Sessions per relay id (dialing or spliced)     | 8                                      |                                          |
| Unregistered control sockets per relay id      | 4                                      |                                          |
| Control connections per relay id               | 12 a minute                            |                                          |
| Dials per relay id                             | 30 a minute (session sockets the same) |                                          |
| Dials per relay id from one address            | 10 a minute; IPv6 counted by its /64   |                                          |
| Bytes one session carries, both ways           | 1 GiB                                  |                                          |
| Bytes waiting to be written to one socket      | 25 MiB + 8 MiB (Node only)             |                                          |
| A register proof's `jti` kept after its expiry | 1 hour                                 |                                          |

The Node runner refuses a binary message over the cap from its header, before buffering any of it. A Worker is handed whole messages, up to the platform's own limit, which is far above the cap (local workerd passed a 2,000,000-byte message), and the room then refuses any over 65,537 bytes. The protocol cuts every text message into records, so the largest message the gateway sends, 25 MiB, crosses as at most 401 frames of at most 65,537 bytes. Workers do not report bytes waiting to be written, so that cap is the Node runner's alone.

## What a connector and a phone do

- **Ping as soon as the socket opens, then at least every 30 seconds**: the exact text `{"t":"ping"}`. A ping counts as traffic, and on a Worker the runtime answers it without waking the object. The first ping matters on Workers: when the client of a hibernatable socket has sent nothing yet, workerd takes about 10 seconds to finish a close the relay starts (measured locally; one message from the client makes it immediate). The `error` before the close still arrives at once.
- **Treat an `error` as final.** The relay closes the socket after it.

## State and hibernation

- Each socket's state (its role, its session, its registration snapshot, when it was last heard and the bytes it sent) is saved on the socket: on a Worker, the WebSocket's attachment, which survives hibernation and is discarded with the socket. It is written synchronously, before any await. Only the latest state exists, so an older one cannot replace it.
- The registration's store is that state ([`src/core/registration-store.ts`](src/core/registration-store.ts)), meeting the protocol's `RegistrationStore` contract (its README, "Registration across hibernation") with synchronous writes. It copies each snapshot and checks it as the protocol does before anything else. `verifying` is saved before any other store is asked and stays saved while the success is prepared. The success is saved only by the commit: it copies and checks the snapshot, reads whether the attempt is still live, and writes, with nothing between that reading and the write. A socket's close (which aborts the registration) and the room's alarm (which expires it) are other events of the same object, so they come before the commit, which then saves nothing, or after it. A write refused for a socket that no longer holds the registration fails it.
- A registration that was waiting on a store when the object went away is not resumed: the relay ends that socket. So is a socket whose commit or failure could not be written (the protocol answers `store_failed`): the relay closes it with `internal`. A socket the relay closed is discarded: its record, whatever it says (`registered` and `challenged` included), is never read for recovery again, because the room skips any socket that is not open, and a message that arrives while the close finishes is ignored. The relay owns the idle cases too: `abort()` and `expire()` write nothing, so a challenge that expires, or a socket that closes, with no attempt in flight is closed and discarded rather than saved as failed.
- A relay id's pins, proof `jti`s and per-minute counts are in SQLite: the Durable Object's storage, or `node:sqlite` in the Node runner. The `jti` check and its insert are one step, and so are the pin check and its insert, which records nothing for an attempt no longer live.
- The room sets an alarm (on Node, a timer) for its next deadline, so a challenge, a dial or an idle session ends with nothing arriving.
- The room clock: on Node, `performance.now()`. Workers have no elapsed-time clock that survives hibernation, so the Worker uses `Date.now()`, never letting it read earlier than any time saved on a socket or read before; a clock set back stalls the room clock instead of moving it back.
- The Node runner keeps its tables in memory unless given `--database`. A restart forgets pins and `jti`s; challenges are per socket, so no proof from before the restart can answer one after it.

## What the relay sees

Relay ids, the phone's and the connector's addresses, when sockets open and close, message sizes and timing, and the two header bytes of each frame (version and type). It cannot read or change what the frames carry, and it cannot get a phone past the connector or a device past the gateway.

## Checks

`pnpm vitest run services/relay` (they are part of `pnpm test`):

- [`test/relay.test.ts`](test/relay.test.ts) runs every case on both runtimes through real WebSockets on 127.0.0.1: the Node runner, and the Worker and its object in Miniflare through Wrangler's local test harness. Health and paths; registration, refused proofs, a pinned id, replacement; dial, splice and frames passed unchanged both ways; the largest frame and one byte more; relay text at 4,096 and 4,097 bytes; binary and text where they do not belong; session sockets for no dial; every count and cap; the byte budget; hibernation (on the Worker, the object is evicted with its sockets hibernated) at the challenge, after registration and mid-splice; a challenge, a dial and idle sockets ending with nothing arriving, on a room clock run 30 times faster; a failing replay store and a failing pin store.
- [`test/e2e.test.ts`](test/e2e.test.ts) runs a connector stand-in and a phone stand-in on the protocol package through each runtime: enrollment, the Noise IK opening, text both ways (one message in several records), every frame arriving unchanged and in order, and none holding the text, the enrollment secret or the phone's key in the clear.
- [`test/room.test.ts`](test/room.test.ts) runs the room with sockets and a clock the test holds: dials counted across addresses and by /64, `verifying` saved before a store is asked, a challenge that outlives a slow store, a registration cut off by hibernation, a room rebuilt between every step, deadlines, the queued-bytes cap, a failing store, and a socket closed and discarded when its success or failure cannot be written.
- [`test/registration-store.test.ts`](test/registration-store.test.ts) runs the registration store's contract cases ([`test/fixtures/registration-contract.ts`](test/fixtures/registration-contract.ts), ported from the protocol package's cases for `MemoryRegistrationStore`) on both runtimes: over the Node runner's socket, and inside the Durable Object over its own hibernatable sockets' attachments. A success only through a commit that finds the attempt live; the snapshot copied and checked before that reading; no write for a socket that no longer holds the registration; `verifying` kept while the success is prepared; an abort or an expiry before the commit, or at its own reading, cancelling it; a committed success restored with its clock reading, and a lower reading refused.
- [`test/store.test.ts`](test/store.test.ts) and [`test/routes.test.ts`](test/routes.test.ts): the SQLite store, paths and addresses.

## Licence

[`src/core/store.ts`](src/core/store.ts) and [`test/store.test.ts`](test/store.test.ts) port logic and test cases from T3 Code under the MIT licence; each keeps its notice, and [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) lists them.
