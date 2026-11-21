# Pairing a phone through the relay: what the gateway, the connector and the phone do

What the screens of built-in remote access (issue #254) can rest on: the desktop's "Connect a phone", "Approve from here" for a phone's request, the "Remote access" row in Settings, Gateway, and the iPhone's scan, review, waiting and later states. It checks OpenClaw 2026.10.6, the relay connector and core's relay route against a development gateway, and it is the evidence behind [`docs/design/remote-access.md`](../design/remote-access.md).

Citations follow [`setup-flow.md`](setup-flow.md): `<openclaw>/…` is a path in the installed `openclaw` 2026.10.6 npm package, with line numbers of the 2026.10.6 chunks. **Live** means it was run and the result is quoted. **Source** means it was read in shipped code or bundled docs only. **Read from a branch** marks code that is in an open pull request and not on `main`:

- R0, the trusted loopback proxy for development instances and its note `docs/research/relay.md`: branch `relay-r0`.
- R1, `packages/relay-protocol` (#253): branch `relay-r1`.
- R2, `services/relay` (#281): branch `relay-r2`.
- R3, `packages/connector` (#285): branch `relay-r3`.
- R4, core's relay route (#270): branch `relay-r4`.

Where it was run: a scratch checkout of `relay-r3` with `relay-r4` merged in, never pushed, removed afterwards. Two development instances of my own, started by that checkout's `pnpm dev-gateway`, both stopped and reset at the end:

- `rdpair`: `--trust-loopback-proxy --no-seed`, so `gateway.trustedProxies` is `["127.0.0.1", "::1"]` from the start, and `autoApproveLocal` is `false` as on every instance.
- `rdplain`: `--no-seed`, with no `trustedProxies`.

The relay is R2's Node runner on a free loopback port. The connector is R3's `clawtrate-connector`, its `run` started as its own process in the foreground with a state folder in a temporary directory. No service was installed or loaded. The phone is core's `RelaySocket` (R4) under OpenClaw's own `GatewayClient`, the pinned client, as the iPhone app will use it, with a fresh Ed25519 device key per phone. The probe is [`relay-pairing/probe.ts`](relay-pairing/probe.ts).

## Summary

| # | Question | Answer | Section |
|---|---|---|---|
| 1 | Does the whole path work: code, enrollment, a pairing that waits, approval, hello with read? | Yes. R3's own end-to-end passed on `rdpair`: the phone's request waited with `remoteIp: "192.0.2.1"`, `devices approve` led to hello with exactly `["operator.read"]`, `approvedVia: "owner"`, and a stranger was refused before any gateway connection. **Live.** | 1 |
| 2 | Is a relay code a credential that needs the owner's approval? | **No.** Whoever presents the code first can pose as one of OpenClaw's own apps and be approved by the code alone, without the owner. With R3's `--limited` code that holder got the node role and an operator token with `approvals`, `questions`, `read`, `talk.secrets` and `write`. With a `--voice-node` code, the node role and `read` and `talk`. **Live**, through the relay. | 2 |
| 3 | Which `qr` profile? | `--voice-node` is narrower on both counts that matter: what a holder gets without approval (read and Talk, against read, write, approvals, questions and Talk secrets), and what reaches the owner (a request for write is refused at the gateway instead of waiting for a manual approve). Both allow the node role. **Live.** | 3 |
| 4 | Can "Approve from here" approve exactly one request? | The gateway's own approve (`device.pair.approve {requestId}`) approves exactly that id, and a request never widens under its id: a retry with more scopes gets a new id and the old one disappears. `openclaw devices approve <id> --json` uses it and returns `{requestId, device}`. Its one exception is a fallback in the CLI, used only when the CLI's own connection is refused for pairing: it may approve a newer request from the same device, adding at most `operator.pairing`, and says so in `resolved`. `openclaw gateway call device.pair.approve` can't be used: it connects without `operator.read`. **Live** and **source.** | 4 |
| 5 | Turning `trustedProxies` on and off | R3's `setup` records the earlier value, sets the union with loopback through `openclaw config set … --expect-current-*`, and reads it back; the change applies to a running gateway with no restart. `teardown` puts back exactly the earlier value, read back, and refuses to touch a value someone else changed. **Live.** | 5 |
| 6 | What the phone sees later | The connector stopped: close 4502 `relay:connector_offline`. The relay stopped: 1006. A used code: 4403. A phone removed at the connector: 4401. A device removed on the gateway: `AUTH_DEVICE_TOKEN_MISMATCH`. **Live.** | 6 |
| 7 | What the connector reports | `status --json`: `running` (`registered`, `connecting`, `waiting`, `stopped`, or `not running` when the status file is over 90 s old), `sessions`, the phones (name, key, date), open codes, and the `trustedProxies` record. `lastExit` is free text. **Live.** | 7 |
| 8 | What the relay can read | Frame headers, sizes, timing and both ends' addresses. R2's end-to-end test checks that no frame carries the text, the enrollment secret or the phone's key in the clear. The Noise IK implementation has not had the independent review the plan asks for. **Live** (the test) and **read from a branch.** | 8 |

## 1. The whole path

`node packages/connector/e2e/dev-gateway.ts --instance rdpair`, R3's own check, on the scratch checkout:

```
connector-e2e: gateway.trustedProxies already covers loopback: ["127.0.0.1","::1"].
connector-e2e: ok: the connector registered with the relay (pid 48959)
connector-e2e: ok: the setup code carries the relay dial address
connector-e2e: first connect: {"outcome":"refused","message":"device pairing required (requestId: …)","code":"NOT_PAIRED"}
connector-e2e: ok: the request carries the connector's forwarded address, so the gateway saw a remote device
connector-e2e: ok: it asks for operator.read alone
connector-e2e: after approval: {"outcome":"hello","role":"operator","scopes":["operator.read"],"deviceToken":true,"roundTrip":true,"agents":4}
connector-e2e: ok: the pairing was approved, not silent (owner)
connector-e2e: ok: the connector refused a phone that is not enrolled
connector-e2e: ok: the gateway got no connection for it
connector-e2e: ok: teardown left gateway.trustedProxies as it was
connector-e2e: PASS
```

So the iPhone's first pairing through the relay ends as `setup.md` §13 expected for an address route: it waits, and after the owner's approval it reaches hello with read alone. This closes the gap `setup.md` §13 left open ("not proven off loopback yet") for this route. R0's note found the same through a plain loopback proxy.

## 2. A relay code is a bearer credential

`setup-flow.md` §3 lists the cases where a code approves a device by itself off loopback: OpenClaw's own iOS and Android apps as nodes, its node host with a node-only code, its ESP32 voice clients with a voice code, and its Control UI. The test is in `resolvePairingApprovalPlan` (`<openclaw>/dist/message-handler-CRCo2VX0.mjs` lines 1916-1969): a first connect with a bootstrap token, `role: "node"`, `mode: "node"`, no scopes, and a client id, platform and device family that match one of OpenClaw's apps for the code's profile (`isSetupCodeHandoffBootstrapClient`, line 834). Nothing in it checks where the connection came from. The client id and platform are what the client says about itself. **Source.**

So the question is whether the connector's `trusted-proxy` attribution changes that. It does not. `probe.ts impersonate` on `rdpair`, with a code made exactly as R3's `pair-phone` makes it, presented first by a phone that says it is OpenClaw's iOS app:

```
[impersonate] a holder of a --limited code connects as openclaw-ios, role node, through the relay:
  {"outcome":"hello","role":"node","scopes":[],"deviceToken":true,
   "deviceTokens":[{"role":"operator","scopes":["operator.approvals","operator.questions","operator.read","operator.talk.secrets","operator.write"]}]}
[impersonate] gateway pending for it: undefined
[impersonate] gateway paired for it: {"clientId":"openclaw-ios","clientMode":"node","platform":"ios","role":"node","roles":["node","operator"],
  "scopes":["operator.approvals","operator.questions","operator.read","operator.talk.secrets","operator.write"],"remoteIp":"192.0.2.1","approvedVia":"bootstrap"}
```

And with a `--voice-node` code, a phone that says it is OpenClaw's ESP32 voice node:

```
[impersonate] openclaw qr --voice-node: {"status":0,"access":"limited"}
[impersonate] a holder of a --voice-node code connects as node-host, role node, through the relay:
  {"outcome":"hello","role":"node","scopes":[],"deviceToken":true,"deviceTokens":[{"role":"operator","scopes":["operator.read","operator.talk"]}]}
[impersonate] gateway paired for it: {"clientId":"node-host","clientMode":"node","platform":"esp32","role":"node","roles":["node","operator"],
  "scopes":["operator.read","operator.talk"],"remoteIp":"192.0.2.1","approvedVia":"bootstrap"}
```

No request was filed and nobody approved anything. The gateway's own record says how: `approvedVia: "bootstrap"`. **Live.**

What limits this:

- **One phone per code.** The code's enrollment secret is spent by the first phone the connector admits (R3's allowlist, R1's enrollment). A second phone presenting the same code got close 4403 (section 6), so it never reached the gateway. The window is from when the code is shown until a phone uses it, or until it expires, 10 minutes at most.
- **No other way in.** The gateway behind the connector listens on loopback. A holder needs the relay, the code's connector key and its secret, which only the code carries. If the gateway can also be reached some other way (a LAN or Tailscale address), the bootstrap token inside the code can be redeemed there too, once, by the same rules. **Source.**
- **It shows.** The gateway lists such a device as paired, with `approvedVia: "bootstrap"`, the forwarded address in `remoteIp`, and the client id it claimed. `openclaw devices list --json` shows it to the host. **Live.**

What this means for the design: a relay code can't be described as needing the owner's approval. It needs approval only when the phone that uses it is Clawtrate asking for read, which is the case the design is for. The screen that shows a code says who can use it, and the desktop reads the gateway after the code is used and says what happened (`remote-access.md` §5).

Upstream, a `qr` profile that hands nothing off by the code alone, or a check that a `trusted-proxy` connection never takes the handoff path, would close this. Neither exists in 2026.10.6.

## 3. Which `qr` profile

The scope's open question was `--limited` or `--voice-node` for the code inside a relay code. R3's `pair-phone` uses `--limited`. The profiles are in `<openclaw>/dist/device-bootstrap-profile-DQKf7Vz1.mjs` lines 25-58:

| Profile | Roles | Operator scopes it may hand off | Taken by itself, off loopback, for | **Source** |
|---|---|---|---|---|
| default | node, operator | admin, approvals, questions, read, talk.secrets, write | OpenClaw's iOS and Android apps | lines 37-41 |
| `--limited` | node, operator | approvals, questions, read, talk.secrets, write | OpenClaw's iOS and Android apps | lines 27-30 |
| `--voice-node` | node, operator | read, talk | OpenClaw's ESP32 voice node | lines 53-57 |

Both allow the node role. They differ in what a holder gets without approval (section 2) and in what a Clawtrate-shaped request can ask for (`probe.ts impersonate`, second half):

```
[impersonate] a --limited code, gateway-client asking for read and write:
  {"outcome":"refused","message":"device pairing required (requestId: <id>)","detail":"PAIRING_REQUIRED","reason":"not-paired"}
[impersonate] gateway pending for it: {"clientId":"gateway-client","role":"operator","scopes":["operator.read","operator.write"],"remoteIp":"192.0.2.1"}

[impersonate] a --voice-node code, gateway-client asking for read and write:
  {"outcome":"refused","message":"unauthorized: setup code invalid, expired, revoked, or already used …","detail":"AUTH_BOOTSTRAP_TOKEN_INVALID"}
[impersonate] gateway pending for it: undefined
```

With `--limited`, a request for write reaches the owner, and the manual `openclaw devices approve` would grant it. With `--voice-node` it is refused before it is filed. **Live.**

Settled: **`--voice-node`**, the narrower code on both counts. It changes one argument in R3's `pair-phone`. `setup.md` §2 rule 5 kept voice codes inside the host because a code handed out alone can't be described as read-only; that stays true, and section 2 shows the same of `--limited`. What makes handing one out acceptable here is the connector's one-time enrollment, which limits the code to the first phone, together with the screen saying so.

## 4. Approving exactly one request

### What the gateway does

- `device.pair.approve {requestId}` (`<openclaw>/dist/devices-mOg4_HQd.mjs` lines 355-413) looks the id up and approves that pending entry, or answers `unknown requestId`. **Source.**
- A pending entry never widens under its id. A retry from the same device keeps the id only when its public key, role and browser origin are the same and its scopes are within the entry's; the display name, platform, client id and mode may change in place. Anything else deletes the entry and files a new one with a new id (`canRefreshPendingDevicePairingRequest` and `requestDevicePairingInWorker`, `<openclaw>/dist/device-pairing-core.worker-B-kYFMQS.mjs` lines 240-325). **Source.**
- `openclaw devices approve <id>` calls that method with the scopes the request needs plus `operator.pairing` (`<openclaw>/dist/devices-cli.runtime-CllfBpVQ.mjs` lines 173-177, 300-308). Only when that call fails because the CLI's own connection needs pairing, on the local loopback gateway with no `--url`, does it fall back to the gateway's files, and there it may approve a newer pending request from the same device and key, same role, whose scopes cover the original's plus at most `operator.pairing` (lines 125-137, 186-231, 266-287). Its JSON then carries `resolved: {kind: "same-device-replacement", requestedRequestId, approvedRequestId}`. **Source.**
- `--url` would rule the fallback out, but it requires the shared token on the command line, which Clawtrate never reads: "gateway url override requires explicit credentials". **Live.**

### Live

`probe.ts approve` on `rdpair`, and the CLI by hand on the same instance:

```
[approve] devices list --json, the pending entry (all its fields): ["clientId","clientMode","deviceFamily","deviceId","displayName","isRepair","platform","publicKey","remoteIp","requestId","role","roles","scopes","silent","ts"]
[approve] the pending entry: {"clientId":"gateway-client","clientMode":"ui","platform":"ios","role":"operator","roles":["operator"],"scopes":["operator.read"],"remoteIp":"192.0.2.1","isRepair":false}
[approve] the same phone asks again for read and write: {"outcome":"refused", …,"detail":"AUTH_BOOTSTRAP_TOKEN_INVALID"}
[approve] the earlier request id still pending: true
gateway call device.pair.approve {requestId: <pending>}: exit 1, {"ok":false,"error":{"code":"INVALID_REQUEST","message":"missing scope: operator.read"}}
gateway call device.pair.approve {requestId: <not pending>}: exit 1, "device pairing approval denied"
devices approve <id> --json: exit 1, "No pending device request matches 00000000-…. Run openclaw --profile clawtrate-dev-rdpair devices list and retry with the current request ID."
devices approve <pending id> --json: exit 0
  {"requestId":"<the same id>","device":{"role":"operator","roles":["operator"],"scopes":["operator.read"],"approvedVia":"owner","remoteIp":"192.0.2.1","tokens":[{"role":"operator","scopes":["operator.read"]}], …}}
devices list --json, paired: {"approvedVia":"owner","scopes":["operator.read"],"tokens":[{"role":"operator","scopes":["operator.read"]}]}
gateway call gateway.identity.get --json: exit 0, {"deviceId":"675f3eee…","publicKey":"<redacted>"}
```

Once the bootstrap token has filed a request for read, the same phone can't use it to ask for more. `gateway call` can't approve this request at all. `devices approve --json` returns the id it approved and the device as approved, and `devices list --json` reads the result back.

So "Approve from here" can: read the pending entry; check its id, device, client, role and scopes; check the gateway's identity with `gateway call gateway.identity.get`; read it again after the person confirms; run `devices approve <id> --json`; and check both the answer and a fresh `devices list`. It cannot keep the CLI's fallback from approving a newer request from the same phone with `operator.pairing` added. It can see that it happened (`resolved`, or the scopes read back) and say so, and offer to remove the device.

## 5. `gateway.trustedProxies`

`probe.ts proxies` on `rdplain`, which starts with no `trustedProxies`:

```
[proxies] before setup, gateway.trustedProxies: absent
[proxies] setup --no-trusted-proxies: 0
[proxies] a phone connects before trustedProxies is set: {"outcome":"no answer in 20 s"}
[proxies] how the relay route ended: {"code":1011,"reason":"the gateway refused the connection"}
[proxies] setup: {"code":0,"lines":["gateway.trustedProxies set to [\"127.0.0.1\",\"::1\"] (it was absent); teardown puts it back."]}
[proxies] after setup, gateway.trustedProxies: ["127.0.0.1","::1"]
[proxies] a phone connects after setup, no restart: {"outcome":"refused","message":"device pairing required (requestId: <id>)", …}
[proxies] pending: {"clientId":"gateway-client","role":"operator","scopes":["operator.read"],"remoteIp":"192.0.2.1"}
[proxies] teardown: {"code":0,"lines":["gateway.trustedProxies is back to its earlier value, read back to check."]}
[proxies] after teardown, gateway.trustedProxies: absent
[proxies] teardown after another change: {"code":1,"lines":["clawtrate-connector teardown: gateway.trustedProxies is now [\"127.0.0.1\",\"::1\",\"198.51.100.0/24\"], which the connector did not set; it was left as it is."]}
[proxies] gateway.trustedProxies then: ["127.0.0.1","::1","198.51.100.0/24"]
[proxies] status trustedProxies record: {"earlier":{"present":false},"applied":["127.0.0.1","::1"],"changed":true}
```

All **live**. Without the setting, the gateway refuses the connector's forwarded upgrade and the phone's route ends with 1011; the phone's client gets no answer at all. The change applies to the running gateway without a restart, which R0 left unproven. Teardown restores the exact earlier value, and when someone else changed it after `setup`, it leaves it alone and keeps its record. The instance's value was then unset by hand.

R3's `setup` refuses to go on when its record exists and the live value differs ("gateway.trustedProxies changed after the connector set it"), so running it again never overwrites someone else's change. **Read from a branch** (`packages/connector/src/trusted-proxies.ts`).

## 6. What the phone sees later

`probe.ts states` on `rdpair`, a phone enrolled and approved, then:

```
[states] paired phone reconnects without the secret: {"outcome":"hello","role":"operator","scopes":["operator.read"],"deviceToken":true}
[states] dial with the connector stopped: {"code":4502,"reason":"relay:connector_offline"}
[states] dial with the relay stopped: {"code":1006,"reason":"The relay connection ended."}
[states] after relay and connector are back: {"outcome":"hello","role":"operator","scopes":["operator.read"],"deviceToken":true}
[states] a second phone presents the same code: {"code":4403,"reason":"The connector refused this pairing code: it was used, expired or wrong."}
[states] remove-phone: ["Removed Probe phone (<phone key>).","A running connector ends its session within seconds. To revoke the device on the gateway too: openclaw devices remove <device id>"]
[states] the removed phone dials: {"code":4401,"reason":"This phone is not enrolled with the connector."}
[states] devices remove on the gateway: {"status":0}
[states] the revoked phone reconnects with its device token: {"outcome":"refused","message":"unauthorized: device token mismatch (rotate/reissue device token)","detail":"AUTH_DEVICE_TOKEN_MISMATCH"}
```

All **live**. The close codes are R4's (`RELAY_CLOSE`, `packages/core/src/relay/socket.ts`). R4's reconnect policy treats 4401 and 4403 as permanent and stops; everything else retries with backoff, from 1–2 s to 5 minutes, and a pending approval is checked every 4 s for 10 minutes (`packages/core/src/relay/reconnect.ts`). **Read from a branch.**

A 1006 means the phone's socket to the relay ended without a word from the connector. The phone can't tell a relay that is down from a network that is down.

## 7. What the connector reports

`status --json` while a phone is connected (`probe.ts states`), then with the relay stopped and the connector stopped (`probe.ts connector-view`):

```
{"relayOrigin":"ws://127.0.0.1:64610","relayId":"2xerse2j…","connectorKey":"JA8Y2zn0…","gatewayPort":19500,"running":"registered","sessions":1,"lastExit":null,
 "phones":[{"name":"Probe phone","key":"cjZvZhbQ…","addedAtMs":1795271591278}],"openPairingCodes":0,
 "trustedProxies":{"earlier":{"present":true,"value":["127.0.0.1","::1"]},"applied":["127.0.0.1","::1"],"changed":false}}
status 4 s after the relay stopped: {"running":"waiting","sessions":0,"lastExit":"socket_error:connect ECONNREFUSED 127.0.0.1:49532"}
status right after the connector stopped: {"running":"stopped","sessions":0,"lastExit":"socket_error:connect ECONNREFUSED 127.0.0.1:49532"}
```

All **live**. `running` comes from a status file the running connector rewrites on every change and every 30 s; `status` reports `not running` once the file is more than 90 s old (`STATUS_STALE_MS`, `packages/connector/src/daemon.ts`). `lastExit` is free text with addresses in it. The connector never loads its own service: `setup` writes a LaunchAgent and a systemd user unit and prints the command to load them (`packages/connector/src/service.ts` lines 127-133). Its phones carry the name given to `pair-phone --name`, a key and a date; the gateway's device id is not recorded anywhere in the connector. **Read from a branch.**

## 8. What the relay can read

R2 lists what the relay sees: relay ids, the phone's and the connector's addresses, when sockets open and close, message sizes and timing, and the two header bytes of each frame (`services/relay/README.md`, "What the relay sees"). The phone's address goes on to the connector in each `dial` and from there into `X-Forwarded-For`, so the gateway keeps it as the device's `remoteIp` (sections 1 and 4). The relay keeps, in SQLite, each relay id's pinned registration key, register-proof ids for an hour after their expiry, and per-minute counts; per socket, its role, session, registration state, last-heard time and bytes sent, discarded with the socket. **Read from a branch.**

`pnpm exec vitest run services/relay/test/e2e.test.ts` on the scratch checkout, the case "opens a Noise session and round-trips text, and the relay carries only ciphertext": 2 tests passed. It checks that every frame the relay carried arrived unchanged and that none contains the question, the answer, the enrollment secret or the phone's key in the clear. **Live.**

The channel is `Noise_IK_25519_ChaChaPoly_SHA256`, the phone pinning the connector's static key from the code, checked against the Cacophony vectors and a second implementation (R1's README). The plan requires an independent review of that implementation before R4 merges; it has not happened yet.

## 9. What could not be shown here

| What | Why | What the design does |
|---|---|---|
| A real iPhone, cellular, a deployed relay | Nothing is deployed; the phone was Node on this machine | Uses only what the Node phone showed |
| Loading the connector's service | No service may be installed here, and R3 never loads one | The person runs the printed command; the desktop reads `status` back |
| Installing the connector on another computer | No unit packages the connector yet | The step is in the design with its failure, marked as waiting for a distribution (R5) |
| The CLI's local fallback approving a replacement | Needs the CLI's own device to be refused for pairing, which this instance didn't do | The desktop reads the approval back and says when it differs |
| The independent review of R1's Noise IK | Not done yet | The words about what the relay can't read ship with that review |

## Files

| File | What it is |
|---|---|
| `relay-pairing/probe.ts` | The probes for sections 2 to 7: `impersonate --profile limited\|voice-node`, `approve`, `states`, `connector-view` and `proxies`. It needs R1 to R4 and runs from `packages/connector/e2e/` on a checkout that has them. It acts only on a named instance, runs OpenClaw only through the development tool's guarded runner, removes its temporary folders and the devices it paired, and redacts every token it prints. |
