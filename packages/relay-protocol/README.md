# @clawtrate/relay-protocol

The wire protocol for reaching a gateway through Clawtrate's relay: the frames a phone and a connector exchange end to end, the relay's own messages, the connector's register proof, and the Noise IK channel with phone enrollment. It does no I/O. The relay, the connector and the phone's socket are built on it.

It runs in Node, Electron, Cloudflare Workers and React Native. It uses `@noble/curves`, `@noble/ciphers` and `@noble/hashes`, pinned to exact versions, and three globals besides the language: `TextEncoder`, `TextDecoder` and, for the relay origin on the relay and the connector, `URL` ([`src/globals.d.ts`](src/globals.d.ts)). Random bytes come from `crypto.getRandomValues`; the options that take another source are for tests only. Every time the package compares is a nonnegative whole number of milliseconds; anything else fails closed.

## Who sees what

```
phone (Initiator) ── wss ──► relay ◄── wss ── connector (Responder) ── its own socket ──► gateway
```

- The relay pairs a phone's dial socket with a connector's session socket and passes binary messages unchanged. It sees the frame header (version and type), sizes, timing and addresses. It cannot read or change what the frames carry.
- The phone pins the connector's Noise static key from the pairing code. The connector lets in only phones it has enrolled. Neither grants anything on the gateway: the gateway's own pairing and approval still apply to every device.

## Keys

| Key                   | Held by   | Used for                                                                                                                                          |
| --------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ed25519 registration  | connector | Proving to the relay that it owns its relay id. The relay id is lowercase base32 of the first 16 bytes of SHA-256 over the public key (26 chars). |
| X25519 Noise static   | connector | The responder's static key. The pairing code carries its public half.                                                                             |
| X25519 Noise static   | phone     | The initiator's static key. The connector's allowlist holds its public half.                                                                      |
| 32-byte enroll secret | code      | One-time: enrolls the first phone that presents it before it expires.                                                                             |

## Relay messages (text)

Flat JSON objects with a string type `t`, at most 4,096 bytes. Each direction has its own decoder, which refuses any other type, extra or missing fields, and malformed values ([`src/messages.ts`](src/messages.ts)). A repeated member name is refused, compared after unescaping, so two readers can never disagree about which value counts ([`src/json.ts`](src/json.ts)); the signed register payload is read the same way.

1. The connector opens `/v1/connector/<relayId>`. The relay sends `challenge` with a fresh 32-byte nonce for this socket alone.
2. The connector answers `register` with a proof, `<payload>.<signature>` in base64url. The payload is JSON with `typ` `clawtrate-relay-register/1`, the relay's canonical origin as `aud` (`wss://host[:port]`, lowercase, no default port; the text it comes from may hold nothing but a scheme, a host, a port and a final slash, and `ws:` is allowed only for a loopback host in tests), the relay id, the public key, the nonce, `iat` in seconds and a 16-byte `jti`. The signature is Ed25519 over `"clawtrate relay register proof\n"` followed by the encoded payload.
3. The relay checks it with `ControlRegistration` ([`src/register-proof.ts`](src/register-proof.ts)):
   - the origin is checked and pinned when the socket starts;
   - one attempt per socket, decided before any wait, so overlapping attempts get `already_used`;
   - the challenge is at most 60 seconds old by a clock that wall-clock corrections cannot move back, and one that survives hibernation. The attempt is bound to one in-flight token and checks that it is still current and in time after every wait, before the key claim and before the success is committed; the first clock failure, the attempt's own or the timer's, stays its cause. The relay calls `expire()` from a timer for a quiet socket and `abort()` when the socket closes;
   - the key derives the relay id, the relay id is the socket's, `aud` equals the relay's configured origin in canonical form, the nonce is this socket's challenge, and the signature verifies under strict RFC 8032 rules;
   - `iat` is within 60 seconds of the relay's wall clock, and the `jti` has not been seen for this relay id. The replay store checks and records in one atomic step and keeps the `jti` until the end of the last second the proof could pass;
   - the relay id is pinned to the full public key of the first successful key claim. The key claim is told whether the attempt is still live and records nothing when it is not. A claim made before the success is committed stays even if the registration then fails (`store_failed`, say), and discarding the socket does not release it; the connector retries on a fresh socket with the same key and a new proof.

   A store that fails fails the registration. The relay answers `registered`, or `error` and closes. `MemoryReplayStore` and `MemoryKeyClaims` are reference implementations of the store contracts the relay must meet. The `store` option keeps the registration across hibernation, under the contract below.

4. A phone opens `/v1/dial/<relayId>`. The relay sends the connector `dial` with a 16-byte session id and the address it saw. The connector opens `/v1/session/<relayId>/<session>`. The relay sends `open` to both sockets, and binary frames flow between them.

`ping` and `pong` are the fixed texts `{"t":"ping"}` and `{"t":"pong"}` in every direction, so a Worker can answer them without waking.

## Registration across hibernation

`ControlRegistration`'s `store` option (`RegistrationStore`) keeps one control socket's registration while the relay hibernates. `MemoryRegistrationStore` is the reference implementation, and its tests in [`test/register-proof.test.ts`](test/register-proof.test.ts) check the contract. A relay's store must meet all of it:

- **Snapshots.** A snapshot is plain data: `{nonce, issuedAtMs, lastReadingMs, state}`. `persist(snapshot)` stores `challenged`, `verifying` or `failed`, in the order it is called, and never `registered`. It may be asynchronous. On a `registered` record, `lastReadingMs` may trail the reading that authorized the commit by one step, because the store copies the snapshot before it reads `live`; nothing reads it there.
- **What is stored when.** The host stores the initial `challenged` snapshot before it sends the challenge, and stores a snapshot with the latest clock reading before it leaves an idle challenge recoverable. `verifying` is stored before the replay store or the key claims are asked, and stays the stored state while the success is prepared. Every failure of an attempt, whatever caused it, is stored by `register()` before it returns.
- **Publishing a success.** `commitRegistered(snapshot, attempt)` is the only way `registered` is stored, and it is synchronous. It first takes and checks its own copy of the snapshot, then reads `attempt.live` as the last step before writing, with no callback, wait or other work between the reading and the write. False: store nothing and return `cancelled`. True: store the copy and return `committed`. Reading `live` reads the clock and may end the attempt, which then reads false. `register()` checks each reply against the last reading taken through that commit's `live`: `cancelled` counts only after a false reading with the attempt ended, and `committed` only after a true reading with the attempt still current.
- **Completion.** When `commitRegistered` returns `committed`, `register()` sets the state to `registered` in the same turn, with no further reading. That is the registration's completion point. An abort or expiry before it cancels the publication; a socket that ends after it is torn down like any registered socket, and `abort()` and `expire()` then do nothing.
- **Faults.** `cancelled` means only that the liveness reading prevented publication. A store that cannot answer, or cannot confirm a write, throws (`persist` may instead reject). `register()` returns `store_failed` for a throw or rejection from either method, a failed write of `failed`, a reply with no reading or against the reading (`cancelled` for an attempt that was still live, `committed` for one that had ended), and any other answer, a promise included. It observes a promise's rejection only as far as that is safe, and ends the attempt either way.
- **Restore.** Restore uses the latest snapshot stored for that socket, never an older one. `challenged`, `registered` and `failed` come back as they are; any other state, `verifying` included, comes back as `failed`. The last clock reading comes back with it, so a lower reading ends the attempt with `bad_clock`.
- **The recovery gate.** The host makes a socket it discards ineligible for routing and for recovery before it yields, on every path: after `store_failed` (whose record may be wrong: a commit whose outcome is unknown, or a success whose following `failed` was never written), on ordinary teardown, and after an idle terminal write whose outcome is unknown. Whatever the last readable record says, `registered` and `challenged` included, it is not restored. On restore the host uses only a valid record that belongs to the same socket, still eligible and `OPEN`, and closes a socket whose record is missing or invalid. A commit that wrote `registered` and then failed is followed by the `failed` write in the same turn when `persist` is synchronous, so no restart can fall between them. A host whose `persist` is asynchronous treats the socket as unresolved from the start of `commitRegistered` until `register()` returns: it does not restore a `registered` record for that socket unless the success was returned to it.
- **Idle `abort()` and `expire()`.** Neither writes to the store. With an attempt in flight, `register()` stores its outcome. With none (state `challenged`), the host owns it: it closes and discards that socket, or stores its `failed` snapshot, before the socket could be restored. Otherwise a saved challenge comes back after the clock failure that ended it, and can register.
- **How an ended attempt reports.** `abort()` is `aborted`. `expire()` is what its reading saw, kept even if the clock recovers: `bad_clock` for a reading that went back or is not whole milliseconds, `challenge_expired` for a deadline that passed. A denial that arrives after the attempt ended (a replayed proof, say) reports that cause instead. A storage fault is `store_failed`, and wins over the cause.

On a Cloudflare Durable Object:

- **Attachments.** A synchronous WebSocket attachment write (`serializeAttachment`) meets the contract per socket. `getWebSockets()` can return sockets that are still `CLOSING`, so the host filters it to eligible `OPEN` sockets before restoring any attachment.
- **SQLite.** A store on the Durable Object's SQLite binds each row to a unique socket id, reads `live` immediately before the write inside `transactionSync`, and restores only rows matched to eligible open sockets.
- **Durability.** `committed` is the synchronous transaction's result. Cloudflare's output gate stays the durable confirmation: no success leaves the object before the write it depends on is confirmed.

On a Node runner, the socket's own state in memory meets the contract.

## Frames (binary)

Every binary message on a spliced session is a frame: one version byte (`1`), one type byte, then a Noise message. At most 65,537 bytes in all ([`src/frames.ts`](src/frames.ts), [`src/limits.ts`](src/limits.ts)).

| Type | Name       | From      | Carries                                 | Body bytes   |
| ---- | ---------- | --------- | --------------------------------------- | ------------ |
| 1    | handshake1 | phone     | Noise IK message 1, payload: the hello  | 96 to 160    |
| 2    | handshake2 | connector | Noise IK message 2, payload: the answer | 48 to 112    |
| 3    | transport  | either    | one encrypted record                    | 17 to 65,535 |

## The channel

`Noise_IK_25519_ChaChaPoly_SHA256` ([`src/noise.ts`](src/noise.ts)), written from the Noise specification, revision 34, and checked against the Cacophony test vectors. The prologue is `clawtrate-relay/<version>\n<relayId>`, with the frame version, so a session spliced to another relay id fails.

- **Hello** (message 1's payload): version `1`, flags `0`, or flags `1` followed by the 32-byte enroll secret.
- **Answer** (message 2's payload): version `1`, then `0` accepted, `1` not enrolled, or `2` enrollment refused. A refusal is final and both sides close. "Accepted" is provisional.
- **The opening** ([`src/channel.ts`](src/channel.ts)):
  1. At message 1 the connector asks its gate, read-only: is the key enrolled, or does its secret match a live offer? If it matches, the gate names the offer with an opaque candidate, never the secret. Nothing changes. The gate is asked only after message 1 decrypts; it gets copies of the key and secret, wiped when it returns, and may not call back into the channel. An answer it may not give, or an abort from inside it, fails the channel before message 2 is sealed.
  2. The phone's first transport record is `confirm`. Message 1 can be replayed by whoever recorded it, and the connector cannot tell a replay from a fresh one; a replay cannot produce the confirm record, because the answer used a fresh ephemeral key.
  3. On `confirm` the connector reports `admit` with a one-use `Admission` handle that carries no key and no secret. The host passes it to `beginAdmission`, which hands its transaction a copy of the authenticated key and the gate's candidate. In one atomic step the transaction checks `attempt.live`, rechecks the offer's expiry and its own policy, and spends the offer and adds the key (or finds the key still enrolled). Then the host calls `settle` with the result. Only "enrolled" admits; an answer it may not give, or a changed key, fails the channel. Once the channel ends the handle and the attempt are dead: nothing more can be committed through them, and `settle` sends nothing, while an enrollment already committed stays. A failed transaction, or a failed write of the admission frame, is an `abort()`. The host acts only on the key `settle` returns and opens no gateway socket before it.
  4. The connector's first record is `admission`, accepted or refused. The phone reports `open` only on an accepted admission.
- **Records** (each transport payload): one kind byte, then data.
  - `confirm` (empty) and `admission` (one status byte) open the channel.
  - `text-part` carries exactly 65,518 bytes and `text-end` up to 65,518, so a text message, at most 25 MiB (the gateway's own frame ceiling), takes at most 401 records. UTF-8 is checked once the message is whole.
  - `ping` and `pong` carry up to 32 bytes.
  - `close` carries a WebSocket close code an endpoint may send and a reason of up to 123 bytes. A close in the middle of a message cancels that message.
- **Buffered text.** A host can give its channels one `ReceiveBudget` for all the unfinished messages they hold. Joining a message makes a second copy, so the channel reserves room for it before allocating and gives it back afterwards, even when the text is not valid UTF-8. The text returned, and the host's own write queues, need bounds of their own.
- **The deadline.** With the host's monotonic clock, in whole milliseconds and never going back, a message may continue until `partialMessageDeadline`, `MAX_PARTIAL_MESSAGE_MS` (5 minutes) after its first record. Any record after that, keep-alives included, fails the channel. A peer that goes quiet sends nothing to check, so once a message begins the host arms a timer for just after the deadline that calls `expirePartialMessage()`, and cancels it when the message completes or the channel ends.
- **Failure is final.** A frame that fails to decode or decrypt, comes in the wrong state, or is replayed, reordered, dropped or reflected fails the channel. So does a send the key cannot finish, which is caught before anything is encrypted. Nonces are implicit, so any of these shows as a failed decryption. Every end wipes, best effort in JavaScript, the handshake's ephemeral secret, chaining key and cipher, the transport keys, buffered text and any pending admission; the handshake hash is kept for channel binding, and the static keys belong to the caller. The handshake's own secrets are wiped as soon as it splits, and the channel owns the split keys from that moment, so even a malformed answer in message 2 leaves none behind.
- **`abort()`** is how the host ends a channel when its socket closes, a write fails or a deadline passes. It is safe in any state and returns true only if an authenticated close or refusal came first; a socket that ends without one ended abnormally, and a message it was carrying is discarded. True describes this end of the channel only: after `close()` it is true even if the close frame was never written or never reached the peer, so the host judges a failed write from the socket, not from `abort()`.
- **Counters.** Each direction's key takes 2^53-1 records, fewer than the 2^64-1 Noise allows; a new handshake starts new keys. There is no rekey.

What the handshake does not give: message 1's payload (the hello, with the secret) is encrypted only to the connector's static key, so whoever later steals that key can read old enroll secrets, which by then are spent or expired. Message 1 can be replayed, which is why nothing changes on the connector before `confirm`. The size of message 1 shows whether it carried an enroll secret.

## Checks

`test/` holds the Cacophony vector, an interoperation check against a second IK implementation on Node's OpenSSL bindings with each on either end, the channel and enrollment cases (dropped handshakes, an offer expiring between the two checks, two phones confirming with one secret, a failed commit), single-bit tampering of every byte of every handshake and transport frame, replay, reordering, dropping and reflection, the reassembly, budget, deadline and exhaustion limits, the register proof's rejection cases and the control socket's registration, and seeded fuzzing of every decoder.

## Licence

`src/register-proof.ts` and `test/register-proof.test.ts` port logic and test cases from T3 Code under the MIT licence; each keeps its notice, and [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) lists them. The test vectors come from Cacophony, which is in the public domain.
