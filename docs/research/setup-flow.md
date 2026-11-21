# Setting Clawtrate up: what the gateway and the tools allow

What a first run of Clawtrate can do to find, reach, pair with and install an OpenClaw gateway, checked against OpenClaw 2026.10.6 and the system `ssh`. It settles the "to be confirmed" cells of `docs/parity.md` rows F-491 to F-513 and is the evidence behind `docs/design/setup.md`.

How to read the citations, as in `gateway-capabilities.md`:

- `<openclaw>/…` is a path inside the installed `openclaw` 2026.10.6 npm package, the one the `openclaw` wrapper script runs. Bundled chunk names carry a build hash (`message-handler-CRCo2VX0.mjs`) that changes with every release; search by the `//#region <source path>` marker at the top of each chunk instead. Line numbers are of the 2026.10.6 chunks.
- `schema` is `protocol.schema.json` in `@openclaw/gateway-protocol@2026.10.6`.
- **Live** means it was run, and the result is quoted. **Source** means it was read in shipped code or bundled docs only. **Unverified** marks what was only read and could not be run here, with the reason.

Where things were run:

- **Development instances** of the gateway, named and started by this checkout with `pnpm dev-gateway start --instance <name> --default-local-pairing`. That option (added for this note, `tools/dev-gateway`) leaves `gateway.nodes.pairing.autoApproveLocal` unset, at the gateway's default; every other instance sets it to `false`. The probes are in `setup-flow/pair-probe.ts` and use this project's own client (`packages/core`) where the desktop app would.
- **An `sshd` of my own**, run as my own user on a loopback port, with a host key, a user key, a configuration and a home created for it in a temporary folder, reached with `ssh -F <that configuration>`, `IdentitiesOnly`, that key and that known-hosts file. Nothing of the machine's own SSH setup was read or used.
- **GitHub's hosted runners** (macOS, Ubuntu and Windows), for everything that installs or registers a service, which must never run on a machine with a working gateway. The workflows are `.github/workflows/setup-research.yml` (runs 44415483883 and 44416142360) and `.github/workflows/setup-owned-install.yml` (runs 44432670957 and 44433669562) on the branch `su-research`, which is not merged.

Sections 3.1, 6.8, 6.9 and 7.2 were added after an independent review of the first version, together with narrower wording where it had claimed more than the evidence (sections 1, 2, 3 and 6.6).

## Summary

| # | Question | Answer | Section |
|---|---|---|---|
| 1 | Is this client's first pairing approved silently on loopback, and through an SSH forward to a loopback-only gateway, with `autoApproveLocal` at its default? | Yes, both, for this native client (no `Origin` header, local `Host`). **Live.** OpenClaw's commands refuse to show the shared token to a program (the same user could read its configuration file, which the design deliberately does not do). A setup code made on the gateway's computer with `openclaw qr --url ws://127.0.0.1:<port>` replaces it, and is also approved silently there. **Live.** | 1 |
| 2 | Is a scope upgrade on such a connection approved silently? | Not through the explicit request this client uses: `device.scopes.requestUpgrade` always files a request that waits, whatever the locality. **Live.** `openclaw devices approve <requestId>` on the gateway's computer approves it. **Live.** The pairing page's "silently approve … scope upgrades" is about a reconnect that presents the shared token, a different path. | 2 |
| 3 | Setup codes with this client | A code is base64url JSON `{url, bootstrapToken, expiresAtMs}`, never the shared token, valid for 10 minutes, single use, and not revocable by any command. It is a bearer credential with a ceiling: on loopback a `--limited` code was redeemed for read and write when both were asked for, and a default code for admin; a `--voice-node` code was redeemed for read, or read and Talk, and refused write; it is meant for voice clients and carries a node role, so it may be used only privately by the host and never handed out. **Live** (§3.1). Away from the gateway's computer, only OpenClaw's own clients are approved by the code; this client's connect waits for `devices approve`. **Source.** | 3 |
| 4 | A setup code without a shell? | `device.pair.setupCode` exists, needs `operator.admin`, and is not advertised in `hello-ok`. A read-only connection is refused. **Live.** So a code needs either a shell on the gateway's computer or an admin connection. | 4 |
| 5 | What identifies a gateway apart from its address? | `gateway.identity.get` (`operator.read`): the gateway's own `{deviceId, publicKey}`, stable across addresses and restarts. It identifies a gateway only after a connection has authenticated; nothing proves the key to a client before a credential is sent. | 5 |
| 6 | The installer | `install-cli.sh --runtime-only --npm --version <exact> --prefix <dir> --json` installs a pinned OpenClaw and its own Node into one folder, with NDJSON steps, in 20 to 33 s. Given the checked tarball's path and a checked Node already in place, it installs exactly that tarball with that Node; npm still resolves 345 dependency packages the app can't check. A named profile (`--profile clawtrate`) gets its own state and service, and leaves a default OpenClaw untouched through install and removal (§6.8). `openclaw onboard --non-interactive --accept-risk --auth-choice skip --gateway-bind loopback --gateway-auth token --install-daemon --json` makes a loopback, token, no-model gateway with a launchd or systemd user service in 18 to 28 s. `openclaw uninstall --service --state --workspace --yes --non-interactive` removes it. **Live** on macOS and Ubuntu. On Windows `install.ps1 -Tag <exact>` installs globally (304 s), replacing the computer's Node when it is too old, before it checks the version exists; onboarding makes a Scheduled Task (63 s). **Live.** | 6 |
| 7 | SSH from a shipped app | `BatchMode=yes`, `StrictHostKeyChecking=yes`, `ExitOnForwardFailure=yes`, `ServerAliveInterval`, `ConnectTimeout`. All three failures exit 255 and are told apart by stderr. A first contact's exact key bytes can be captured without signing in (`accept-new` into an empty file, `PreferredAuthentications=none`), and pinned under the route's own alias; an already trusted key is named by file and line (§7.2). A dropped or silent forward exits 255 and the host restarts it. Windows' bundled OpenSSH 9.5 behaves alike, without ControlMaster and without Unix-socket forwards. **Live.** | 7 |
| 8 | Tailscale | `gateway.tailscale.mode: "serve"` keeps the gateway on loopback and has the gateway itself hold a Serve route to a dedicated listener. It needs the `tailscale` program, signed in, with HTTPS certificates on for the tailnet. A connection through it is not local: a new device waits for approval. **Source.** | 8 |

## 1. The first pairing on loopback and through an SSH forward

### What the gateway does

A connection counts as local when its socket comes from a loopback address and it carries no forwarded headers (`resolveGatewayIngressAttribution`, `<openclaw>/dist/ingress-attribution-BQX5Ye8B.mjs` lines 95-118: `direct-local`). `resolvePairingLocality` then calls it `direct_local` (`<openclaw>/dist/node-connect-reconcile-CAkPC2vI.mjs` line 192). `resolveLocalPairingApproval` (`<openclaw>/dist/message-handler-CRCo2VX0.mjs` line 1889) approves a first pairing silently when `shouldAllowSilentLocalPairing` agrees (`node-connect-reconcile-CAkPC2vI.mjs` lines 178-185): not remote, no browser `Origin` header unless the client is OpenClaw's own Control UI, and `autoApproveLocal` not `false`. Unset counts as allowed.

The bundled docs say the same and name the SSH case: "This includes a client reaching a remote loopback-only Gateway through an SSH port forward: the SSH server terminates the connection on the Gateway host, so the Gateway sees the forwarded connection as loopback." (`<openclaw>/docs/gateway/pairing.md` lines 229-246).

Two conditions matter for Clawtrate:

- **No `Origin` header.** The desktop app opens its socket in Electron's main process with Node's built-in `WebSocket` (`packages/core/src/node/index.ts`), which sends none. A socket opened in a renderer or a browser tab would carry one and would not be approved silently.
- **A local `Host` header.** A loopback socket whose `Host` header is not local is treated as remote (`message-handler-CRCo2VX0.mjs` line 3427). An SSH forward is reached as `ws://127.0.0.1:<local port>`, so the header is local.

### Live

On instance `su-pair` (started with `--default-local-pairing --no-seed`), `pair-probe.ts pair`, this project's `ClawtrateClient` with the shared token from the tool's run file:

```
connect ws://127.0.0.1:19900 with the shared token
core client: {"status":"connected","scopes":["operator.read"],"requestedScopes":["operator.read"],"paired":true,"pairing":null,"error":null,"gatewayId":"c5fde286cae1"}
gateway devices: {"pending":[],"paired":[{"clientId":"gateway-client","clientMode":"ui","displayName":"Clawtrate Desktop","roles":["operator"],"scopes":["operator.read"],"approvedVia":"silent"}]}
```

`grep -c autoApproveLocal` on the instance's config printed `0`: the setting was at the gateway's default.

**Through an SSH forward.** `ssh … -N -L 127.0.0.1:59237:127.0.0.1:19900 devbox` through the `sshd` of my own (section 7), then the same probe with a new device at `ws://127.0.0.1:59237`:

```
core client: {"status":"connected","url":"ws://127.0.0.1:59237","scopes":["operator.read"],"paired":true,"pairing":null,"error":null,"gatewayId":"c5fde286cae1"}
gateway devices: {… {"displayName":"Clawtrate Desktop","scopes":["operator.read"],"approvedVia":"silent"} …}
```

Both were approved silently, with `operator.read` and nothing more, and both read the same gateway identity (section 5). On an instance with `autoApproveLocal: false`, which every other development instance has, the same connect waits with `PAIRING_REQUIRED` (`docs/research/gateway-capabilities.md`, section 2; F-002).

### The shared token: what OpenClaw's commands show, and what the design does not do

The first connect needs a credential. The pairing row assumed the host reads the shared token itself. OpenClaw's own commands refuse to show it to a program, on purpose:

- `openclaw gateway auth-token --show` refuses "outside an interactive terminal", which it judges as stdin and stdout both being terminals (`<openclaw>/dist/gateway-auth-token-ByElYj5T.mjs` line 13; `terminal-interactivity-D92bdO16.mjs` line 2). **Source.**
- `openclaw config get gateway.auth.token` prints `__OPENCLAW_REDACTED__` (`<openclaw>/docs/install/daytona.md` line 100). **Source.**
- The token can also be a SecretRef that only the gateway resolves.

This is narrower than "a program cannot read it". The same operating-system user can usually read OpenClaw's configuration file, and the bundled pairing page says as much: SSH access already implies that same-user trust (`<openclaw>/docs/gateway/pairing.md` lines 233-236). Allocating a pseudo-terminal to get past the first guard, or parsing the configuration file to get past the second, would go around what OpenClaw put there; the design deliberately does neither.

**What replaces it: a setup code made on the gateway's computer and used only by the host.** `openclaw qr --json --voice-node --url ws://127.0.0.1:<port>` is non-interactive by design, prints a short-lived single-use bootstrap token inside a setup code, and never prints the shared token (section 3). On loopback, a connect with that bootstrap token is approved silently like one with the shared token: `shouldAllowSilentLocalPairing` does not look at the auth method for a first pairing. **Live**, sections 3 and 3.1. Measured with codes: a `--voice-node` code was redeemed for `operator.read`, or for `operator.read` and `operator.talk`, and refused write; a `--limited` code was redeemed for read and write when both were asked for (section 3.1). So the host, after the person's consent, makes a `--voice-node` code over its own shell (this computer, or SSH), keeps it to itself, redeems it at once over loopback or the forward asking for read alone, checks the role and grant before keeping the token, and the shared token never leaves OpenClaw. The code is never handed out.

Plain `openclaw qr` refuses a loopback-only gateway ("Gateway is only bound to loopback. Set gateway.publicOrigin …", `<openclaw>/dist/setup-code-Cj6iw2_8.mjs` line 20); the explicit `--url ws://127.0.0.1:<port>` is accepted, because a loopback URL is allowed for setup (`validateMobilePairingUrl`, same file). **Live** on both runners, section 6.4.

## 2. A scope upgrade on a local connection

`docs/research/gateway-capabilities.md` (section 2, "Scope upgrade") says `device.scopes.requestUpgrade` "creates a pending pairing request even on loopback". `<openclaw>/docs/gateway/pairing.md` lines 238-240 say "trusted local connections silently approve first-time device pairing plus role and scope upgrades". Both are right; they describe two paths:

- **`device.scopes.requestUpgrade` on a live socket**, which this client uses (`docs/decisions.md`, "Scopes, in tiers"). Its handler always calls `requestDevicePairing` with `silent: false` and never asks about locality (`<openclaw>/dist/devices-mOg4_HQd.mjs` lines 37-110). It waits.
- **A reconnect that asks for more scopes.** `authorizeExistingGatewayDevice` files a `scope-upgrade` pairing (`message-handler-CRCo2VX0.mjs` lines 1546-1555, the `requirePairing("scope-upgrade")` call at line 1553), and `shouldAllowSilentLocalPairing` approves it locally only when the connect authenticated with the shared token or password (`node-connect-reconcile-CAkPC2vI.mjs` line 183: `authMethod === "none" || "token" || "password"`). A device token or a bootstrap token does not qualify. Clawtrate never holds the shared token (section 1), so this path is closed to it, and it is not the documented way to ask.

### Live

`pair-probe.ts upgrade --approve` on the device paired in section 1:

```
before:       {"status":"connected","scopes":["operator.read"],"upgrade":{"status":"idle"}}
after asking: {"status":"connected","scopes":["operator.read"],"upgrade":{"status":"pending","requestId":"e5eb4aa8-175f-40f1-bc7a-8f15cfc40942","scopes":["operator.read","operator.write","operator.approvals","operator.questions"]}}
gateway devices: {"pending":[{"requestId":"e5eb4aa8-…","clientId":"gateway-client","clientMode":"ui","displayName":"Clawtrate Desktop","roles":["operator"],"scopes":["operator.approvals","operator.questions","operator.read","operator.write"]}], …}
devices approve e5eb4aa8-175f-40f1-bc7a-8f15cfc40942: exit 0
Approved 5ae23affda58… (e5eb4aa8-175f-40f1-bc7a-8f15cfc40942)
after approval: {"status":"connected","scopes":["operator.read","operator.write","operator.approvals","operator.questions"],"upgrade":{"status":"approved", …}}
```

On a loopback connection with `autoApproveLocal` at its default, the request waited. `openclaw devices approve <requestId>`, run through the development tool's runner (that is, on the gateway's computer), printed one line, `Approved <deviceId> (<requestId>)`, exited 0, and the client, still connected, held the interactive tier. The device's record then read `approvedVia: "owner"`.

So "Approve from here" (F-500) is the gateway's own `openclaw devices approve <requestId>`, run by the host on the gateway's computer (this computer, or over SSH) after the person confirms. The request id comes from `device.scopes.requestUpgrade`.

### 2.1 Approving from the host: what the command checks, and what it follows (live, 2026-11-20)

Added for `docs/design/setup.md` section 9. On instance `addenda` (`--default-local-pairing --no-seed`), `setup-flow/approve-probe.ts`, this project's client paired read-only, then asked for the interactive tier. Every command ran through the tool's guarded runner, so with `--profile clawtrate-dev-addenda`.

**The pending entry** (`devices list --json`, `pending[]`) has exactly these fields: `requestId`, `deviceId`, `publicKey`, `displayName`, `platform`, `clientId`, `clientMode`, `role`, `roles`, `scopes`, `silent`, `isRepair`, `ts`. For this client: `clientId: "gateway-client"`, `clientMode: "ui"`, `role: "operator"`, `roles: ["operator"]`, `isRepair: true` (the device was already paired), `silent: false`, and the four interactive scopes, **sorted differently from the request** (`["operator.approvals","operator.questions","operator.read","operator.write"]`). Scopes compare as sets.

**`devices approve <id> --json`** exited 0 and printed one JSON object, `{requestId, device}`. `requestId` is the id given. `device` is the paired record with `deviceId`, `clientId`, `role`, `roles`, `scopes`, `approvedVia: "owner"`, `approvedAtMs`, and `tokens: [{role, scopes, createdAtMs, rotatedAtMs}]`, with no token value. The record read back from `devices list --json` agreed: the operator role, exactly the four interactive scopes, `approvedVia: "owner"`. The client, still connected, held the interactive tier.

**Stale, premature, superseded.** Each of these exited 1 with `{"ok": false, "error": {"type": "cli_error", "message": "No pending device request matches <id>. Run openclaw --profile clawtrate-dev-addenda devices list and retry with the current request ID."}}`, and approved nothing:

- the same id approved a second time;
- an id that was never pending;
- the first of two requests. The client asked for the interactive tier, then for admin. The gateway replaced the first entry with a new id whose scopes are the union (`requestDevicePairingInWorker`, `<openclaw>/dist/device-pairing-core.worker-B-kYFMQS.mjs` lines 279-325: a request that asks for more is a new id and the device's other pending entries are deleted). The new entry stayed pending, untouched, and was then rejected.

**What "follows a compatible replacement" means** (source, `<openclaw>/dist/devices-cli.runtime-CllfBpVQ.mjs` lines 173-232 and 259-288). The command first approves through the gateway (`device.pair.approve {requestId}`), which approves only that exact pending row or nothing (`withPendingDevicePairingApproval`, worker lines 79-89). There is one exception. When the CLI's own call to a loopback gateway is refused with `PAIRING_REQUIRED`, the CLI falls back to the local store. If the gateway named another request id there, the CLI may approve that other request instead. The replacement must have the same device and public key, the same role, and client fields that don't contradict the original's. Its scopes must include the original's and may add `operator.pairing`, and nothing else. Its JSON then carries a different `requestId` and `resolved: {kind: "same-device-replacement", requestedRequestId, approvedRequestId}`. Not reproduced live: the CLI on the instance is itself paired, so the fallback never ran.

A refresh of a pending entry keeps its id and its stored scopes, and is allowed only for the same public key and for scopes the entry already covers (worker lines 240-273). It copies the newer client fields, so `clientId` and `clientMode` under an id are the request's reported client and mode, and don't prove where the row came from.

**Is there an exact path with no fallback?** (live, 2026-11-20, instance `addenda2`, `setup-flow/approve-probe.ts exact`). The client paired read-only and asked for the interactive tier. Then each candidate was run against that one live request:

| Candidate (all with `--profile clawtrate-dev-addenda2`)                                       | Result                                                                                                         |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `gateway call gateway.identity.get --expect-url <the instance's address> --json`              | Exit 0, the gateway's `{deviceId, publicKey}`                                                                  |
| `gateway call device.pair.list --expect-url <address> --json`                                 | Exit 0, the pending entry, field for field as above                                                            |
| `gateway call device.pair.approve --params '{"requestId": …}' --expect-url <address> --json`  | Exit 1, `{"ok": false, "error": {"code": "INVALID_REQUEST", "message": "missing scope: operator.approvals"}}` |
| `devices approve <id> --url <address> --json`, no token                                       | Exit 1, "gateway url override requires explicit credentials … pass --token or --password"                      |

The request was still pending afterwards, with the same scopes, and was then rejected. `gateway call` runs every method through `callGatewayReadOnlyCli` (`<openclaw>/dist/gateway-cli-BZjyGF7k.mjs` lines 170-175, 380-394) and has no option to ask for more. `devices` takes `--url` but no `--expect-url` (`devices-cli-D8tMnGzp.mjs` line 21). An address from `OPENCLAW_GATEWAY_URL` is an override like `--url` (`connection-details-CTnJF3zY.mjs` line 80).

So on 2026.10.6 no command approves an exact request id, bound to a verified endpoint, with no fallback and with the gateway's own authorization on its computer. The exact-id server path exists (`device.pair.approve` through an already authorized admin connection approves one id once), but the host's CLI can't reach it that way. The `gateway call` reads above, `gateway.identity.get` and `device.pair.list` bound by `--expect-url`, are what the host can use to check the endpoint and read a device's record after a manual approval.

`devices remove <deviceId>` deletes the device's whole paired record and its pending requests (worker lines 343-354). It cannot undo one grant.

### 2.2 A new bot's command policy, written and read back (live, 2026-11-20)

Added for `docs/design/controls.md` section 10, on the same instance, through the tool's admin operator.

| Write (`config.patch`, `operator.admin`)       | `config.get` reads back                                       | Effective (`openclaw approvals get --json`)                          | `agents.list` (`operator.read`) |
| ---------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------- |
| None: `agents.create` alone                    | no `tools.exec.mode` for the bot; the instance's global `deny` | `deny` (the global)                                                  | `read-only`                     |
| `agents.entries.<bot>.tools.exec.mode: "ask"`  | `"ask"`                                                       | `mode: ask, security: allowlist, ask: on-miss, askFallback: deny`    | `guarded` (Otto, also `ask`)    |
| `agents.entries.<bot>.tools.exec.mode: "full"` | `"full"`                                                      | `mode: full, security: full, ask: off, askFallback: deny`            | `full`                          |
| `"full"`, then the host's approvals file's `defaults` set to `security: allowlist, ask: on-miss` (`exec.approvals.set`, admin) | `"full"` | `mode: ask, security: allowlist, ask: on-miss`: the stricter file wins | (not read)                      |

The other bots read back as before each write (`otto` `ask`, `main` `deny`), and the approvals file was restored afterwards. `exec.approvals.get` (`operator.admin`) returned `{path, exists, file, hash, resolvedDefaults}`, with `file.defaults: {}` and `resolvedDefaults: {security: full, ask: off, askFallback: deny, autoAllowSkills: false}` on this instance. That is the empty-file default of section 6's installs too.

`agents.list` gives every bot a `defaultPermissionMode` at `operator.read`. The gateway resolves it from the config and the gateway host's approvals file together, and leaves it out when the bot is sandboxed or its pair is not one of the canonical modes (`resolvedPermissionLabel`, `<openclaw>/dist/session-utils-store-C-0MBZ3E.mjs` lines 203-246). It is the gateway's reported default command policy for that bot, readable without admin. It is not the whole outcome for a command: an approvals-file entry for that bot, a task's permission mode or a plugin rule can still ask or block, and the label doesn't say which.

**A gateway with no configured bots** (source, `<openclaw>/dist/agent-list-NuNAO01y.mjs` lines 10-85, `agent-roster-CIplRONg.mjs` lines 47-84). `agents.list` is not empty then: with no roster in the config (neither `agents.entries` nor the legacy `agents.list`), it lists the gateway's implicit default agent, `main`, with no name, and `defaultId: "main"`. It also lists agent ids found on disk under the state folder, and can add the configured session main key. Once a configured entry exists, the implicit `main` is listed only if it is configured too. So an unnamed `main` alone, with no roster in the config, identifies a gateway whose only agent is that implicit `main`; whether it was ever used is a separate read (its sessions). A fresh install of section 6 is expected to look like that, but this was not reproduced live: every development instance is seeded with an explicit roster by its contract.

## 3. Setup codes

### What a code is

`openclaw qr` encodes `{url, bootstrapToken, expiresAtMs}` (and `tlsFingerprint` for a pinned `wss://` gateway) as base64url JSON (`encodePairingSetupCode`, `<openclaw>/dist/setup-code-Cj6iw2_8.mjs` lines 188-190; payload, lines 288-298). An `oc-pair://` prefix is accepted when reading one (same file, lines 191-197). The bootstrap token is minted by the CLI into the gateway's state (`issueDevicePairSetupBootstrapToken`, line 284). The `--json` result adds `gatewayUrl`, `auth` (the label `token`, `password` or `trusted-proxy`, never the value), `access` (`full`, `limited` or `node`), `accessDowngraded` and `urlSource` (`<openclaw>/docs/cli/qr.md` line 45).

Profiles (`<openclaw>/dist/device-bootstrap-profile-DQKf7Vz1.mjs`): the default asks for `operator.admin` plus the handoff scopes (`full`); `--limited` drops `operator.admin`; a plain `ws://` LAN address is downgraded to `limited` by itself. These are ceilings for OpenClaw's own mobile handoff. They are not what this client is granted: it is granted what it asks for, below.

### Live

`pair-probe.ts code`, on instance `su-pair`:

```
openclaw qr --json --url ws://127.0.0.1:19900: exit 0
result keys: setupCode, gatewayUrl, auth, urlSource, access   access: full   auth: token
payload keys: url, bootstrapToken, expiresAtMs   url: ws://127.0.0.1:19900   bootstrapToken length: 43
shared token in the code: false
lives for seconds: 593
first device redeems it for operator.read: {"outcome":"hello","role":"operator","scopes":["operator.read"],"deviceToken":true}
gateway devices: {… {"displayName":"Clawtrate research first","scopes":["operator.read"],"approvedVia":"silent"} …}
second device, same code: {"outcome":"refused","message":"unauthorized: setup code invalid, expired, revoked, or already used (create a new code; review `openclaw devices list`)","code":"INVALID_REQUEST","details":{"code":"AUTH_BOOTSTRAP_TOKEN_INVALID","authReason":"bootstrap_token_invalid","canRetryWithDeviceToken":false}}
```

With `--limited`, made and redeemed through the SSH forward (`--url ws://127.0.0.1:59237`): `access: limited`, lives 596 s, redeemed silently for `operator.read` alone, and refused the second time the same way.

So, with this client and a code:

- **The connect does not stay pending on loopback** or through an SSH forward: it is approved silently.
- **A device can redeem a code and hold `operator.read` only**: the gateway grants what `connect` asks for, below the code's ceiling (`full` or `limited`).
- **A code lives 10 minutes** (593 and 596 s left a moment after it was made) **and is single use**.
- **It contains** `url`, `bootstrapToken` (43 characters) and `expiresAtMs`, **never the shared token**.

On both runners (section 6.4) a code made with `--url ws://127.0.0.1:18789` had the keys `url`, `bootstrapToken` (43 characters) and `expiresAtMs`, `access: "full"` without `--limited`, and did not contain the shared token.

### Away from the gateway's computer (source)

Off loopback the code alone approves a device only in three cases (`resolvePairingApprovalPlan`, `message-handler-CRCo2VX0.mjs` lines 1916-1969; `isSetupCodeHandoffBootstrapClient`, line 834; `isMobileNodeBootstrapConnect`, line 858): OpenClaw's own iOS and Android apps connecting with role `node` and mode `node`; OpenClaw's node host with a node-only code; OpenClaw's own Control UI with its owner profile. A `gateway-client` connect with role `operator` from a phone matches none of them, so its pairing waits and its owner approves it with `openclaw devices approve <requestId>` (the docs say as much: "If a request remains pending (for example, for a non-official client …), review and approve it", `<openclaw>/docs/cli/qr.md` lines 25-32). **Unverified live:** a loopback-only development instance cannot be reached from a non-loopback address, and a proxy that adds `X-Forwarded-For` is refused outright (below), so a phone's connect could not be reproduced here.

Connecting as a mobile node to be approved by the code is not an option for Clawtrate: it is OpenClaw's own app identity, it gives the device a node role, and its operator handoff carries write scopes, against F-509.

The waiting is short in practice when the code was made from a desktop that has a shell on the gateway's computer: that desktop can list the pending request (`openclaw devices list --json`) and approve it (`openclaw devices approve <requestId>`) after the person confirms, the same "Approve from here" as section 2.

### 3.1 A code's ceiling, and the narrowest code (live)

The review of the first version found, and this run confirms, that a code is not a read-only credential: on loopback the gateway grants the device what it asks for, up to the code's profile. `pair-probe.ts code --scopes …` on instance `su-r1` (`--default-local-pairing`):

| Code | The device asked for | Outcome |
|---|---|---|
| `--limited` | `operator.read` | hello, `["operator.read"]` |
| `--limited` | `operator.read`, `operator.write` | hello, `["operator.read","operator.write"]` |
| `--limited` | `operator.read`, `operator.admin` | refused, `AUTH_BOOTSTRAP_TOKEN_INVALID` |
| default (`full`) | read, write, approvals, questions, admin | hello, all five |
| `--voice-node` | `operator.read` | hello, `["operator.read"]` |
| `--voice-node` | `operator.read`, `operator.write` | refused, `AUTH_BOOTSTRAP_TOKEN_INVALID` |

So the host must be the one that asks: it keeps a code it made for its own connection, asks for `operator.read` alone, and checks the role and grant before it writes the token. `--voice-node` (profile roles `node` and `operator`, scopes `operator.read` and `operator.talk`, `<openclaw>/dist/device-bootstrap-profile-DQKf7Vz1.mjs`) is the narrowest code OpenClaw offers, but it is meant for embedded and room voice clients: the confirming review redeemed one for `operator.read` and `operator.talk` together, and a holder can also connect as a node; the CLI labels it `limited`, like a `--limited` code. A distributable voice code therefore can't be described as read-only. The design uses a `--voice-node` code only privately in the host, redeemed at once for its own read request, and never hands one out.

**Codes can't be withdrawn.** The gateway revokes bootstrap tokens internally (`revokeDeviceBootstrapToken`, `<openclaw>/dist/device-bootstrap-OyKJUibk.mjs` line 134, used by cloud workers), but no command offers it to a person: `openclaw qr` and `openclaw devices` have none. An unused code stays valid in OpenClaw's own state until it expires, 10 minutes after it was made. **Source.**

**Off loopback**, the exceptions that let a code alone approve a device are OpenClaw's own clients only (above): its iOS and Android apps as nodes, its node host, its Control UI, and its voice clients (`isSetupCodeVoiceNodeBootstrapClient`). On an instance with `autoApproveLocal: false`, the review saw this client's read request stay pending with exactly `operator.read` (review evidence, `bootstrap-scope.mjs`).

### A proxy route made by hand

`pair-probe.ts proxy`: the client connects through a loopback proxy that adds `X-Forwarded-For: 192.0.2.10`, as Tailscale Serve or another reverse proxy pointed at the ordinary listener does:

```
core client: {"status":"connecting","error":{"code":"UNREACHABLE","message":"Nothing answered at 127.0.0.1:61042."}}
gateway log: [gateway] observed unattributable proxy-shaped traffic from 127.0.0.1; Gateway-authenticated routes reject it, while plugin-authenticated routes ignore forwarded claims. Configure gateway.trustedProxies narrowly and make the proxy overwrite or safely rebuild forwarded client headers.
```

The same upgrade sent straight to the gateway with `curl` and `X-Forwarded-For: 192.0.2.10` is answered `HTTP/1.1 403 Forbidden` with `{"error":{"message":"Proxy client attribution is required. …","type":"proxy_attribution_required"}}`; without the header it is `101 Switching Protocols`. Node's `WebSocket` does not expose the status of a refused upgrade, which is why the core client reports "Nothing answered"; telling this case apart needs the host to read the HTTP answer (for builders, `docs/design/setup.md` §19).

This is `unattributableProxy` (`ingress-attribution-BQX5Ye8B.mjs` line 116): with forwarded headers and no `gateway.trustedProxies`, the gateway refuses to attribute the connection. That is F-512's evidence: a Serve route Clawtrate did not make does not work until its owner configures `trustedProxies`, and even then it is remote, never local.

## 4. A setup code without a shell

The gateway has a method: `device.pair.setupCode` (`schema` `methods`: scope `operator.admin`, since `<=2026.7`; `<openclaw>/dist/core-method-policy-DkntKRY_.mjs` lines 1445-1450, with `advertise: false`, so it is not in `hello-ok.features.methods`). Its handler (`<openclaw>/dist/device-pair-setup-DIJSs_9O.mjs` lines 28-89) takes `{publicUrl?, preferRemoteUrl?, includeQr?, bootstrapProfile?: "limited" | "node" | "voice-node", joinUrl?}` and returns `{setupId, expiresAtMs, setupCode, joinUrl?, qrDataUrl?, gatewayUrl, gatewayUrls?, auth, urlSource, access, accessDowngraded?}` (`schema` `DevicePairSetupCodeResult`). `device.pair.setupStatus {setupId}` (also admin) reports whether the code was redeemed and by which device.

### Live

`pair-probe.ts method` on the read-only device of section 1:

```
scopes: ["operator.read"]
device.pair.setupCode refused: GatewayProtocolRequestError: missing scope: operator.admin
```

So a code can be made either with a shell on the gateway's computer or, with no shell, by `device.pair.setupCode` on a connection that already holds `operator.admin`. Measured: a `--limited` code allows read and write if they are asked for, and a `--voice-node` code allows read and Talk and carries a node role (section 3.1). Neither is a read-only code to hand to another device, so the design hands no code out in this version (F-506, `todo`).

## 5. What identifies a gateway apart from its address

- **`gateway.identity.get`** (`operator.read`; handler `<openclaw>/dist/system-C_-PvNDr.mjs` lines 350-356) returns `{deviceId, publicKey}` of the gateway process's own device identity, created once in its state folder (`loadOrCreateProcessDeviceIdentityAsync`). It is the same over every address and across restarts; the core already reads it (`ConnectionState.gatewayId`, `packages/core/src/types.ts`) and keys the rail's arrangement by it (`docs/decisions.md`, "The rail's arrangement is this device's").
- `hello-ok` carries no stable identity: `server.bootId` is new at every start, `buildId` names the build, `connId` the connection (`schema` `HelloOk.server`).
- **What it cannot do.** The identity is read after a connection has authenticated, and no method found here signs a client's challenge with the gateway's key (`connect.challenge` carries the gateway's nonce for the client to sign, not the reverse). So it tells Clawtrate that two authenticated routes reach the same gateway; it cannot tell Clawtrate, before a device token is sent to a new address, that the address is that gateway. A device token sent to an impostor is a credential lost.
- **OpenClaw's own position** is the same: "Unidentified, manually forwarded loopback URLs cannot safely reuse a device token saved only for that URL: the same port may now lead to another Gateway" and "SSH aliases … remain operator-owned route selections, not cryptographic Gateway identifiers" (`<openclaw>/docs/gateway/remote.md` lines 103-116). OpenClaw keys a client-managed tunnel's credentials by SSH target and remote port, not by the local forwarded port (same file, lines 91-102).

### What in `docs/decisions.md` changes and what must not

"Device tokens are scoped to one gateway URL" and "A credential never crosses gateways" (section "Connecting to the gateway"):

- **Must not change.** A device token is offered only where it was issued. No route is given a token because a gateway claims an identity. A credential never crosses from one gateway to another.
- **Has to change.** "One gateway URL" becomes "one route". A forwarded `ws://127.0.0.1:<port>` changes port every time the forward is made, so for an SSH route the key is the route's own identity: the host key's fingerprint, the SSH target as resolved, and the gateway's port on that computer. A changed host key is a different route. For a direct route the key stays its URL.
- **Can be added.** Routes are grouped into one gateway, for the person, by the `deviceId` that `gateway.identity.get` returns over each route once it has authenticated there. Each route pairs once by itself (silently for this computer and SSH, by a setup code otherwise), so the grouping never moves a credential.
- **Continuity.** A route key alone cannot stop a token being offered to whatever answers there later: another process can take a forwarded or local port, and an address can be reassigned, and an SSH host key with a port is not the gateway's identity. So each route keeps its own token and pairs for itself; no two routes share one. On a route whose gateway can't be authenticated before the token is sent, the token isn't sent automatically. After every connection the gateway's identity is compared with the one recorded for that route; a different one means a different gateway, and that route's token is dropped (the comparison comes after authentication, so it limits reuse rather than preventing a first send). On this computer, a process of the same user taking the gateway's port is inside the trust boundary the gateway itself assumes for local connections (`<openclaw>/docs/gateway/pairing.md` line 248). Over SSH the forward reaches the gateway's port on the computer the pinned key authenticated, as a loopback connection (§1): the same boundary on that computer, and no stronger, since another account there could take the port while the gateway is stopped. The existing generation checks stay through every wait.

## 6. Installing, onboarding and removing OpenClaw

**Never run on this machine.** Everything below that installs, onboards or uninstalls was run on GitHub's hosted runners only; the scripts were read in the installed package.

### 6.1 The three scripts

| Script | Where it comes from | What it does | Needs | Writes |
|---|---|---|---|---|
| `install.sh` | `https://openclaw.ai/install.sh` only; not in the npm package | Installs Node if needed (Homebrew on macOS, NodeSource on Linux), Git, then OpenClaw globally with npm or from a Git checkout; can run onboarding; on an existing install refreshes the service and runs `doctor --fix` (`<openclaw>/docs/install/installer.md` lines 117-156) | `curl`, `bash`, `sudo` for system packages | System Node, global npm prefix, `~/.openclaw` after onboarding |
| `install-cli.sh` | the npm package's `scripts/install-cli.sh` with `scripts/install-policy.sh` beside it, or the website's assembled copy | Downloads a pinned Node (`24.22.1`) into `<prefix>/tools`, verifies its SHA-256, installs OpenClaw under the prefix, writes `<prefix>/bin/openclaw`, checks `--version`; `--runtime-only` skips service work and onboarding (`installer.md` lines 284-349; `<openclaw>/scripts/install-cli.sh` lines 1298-1365) | `bash`, `curl` or `wget`, `tar`, a SHA-256 tool; no root | Only the prefix (default `~/.openclaw`) |
| `install.ps1` | `https://openclaw.ai/install.ps1`, also in the npm package | Installs Node with winget, Chocolatey or Scoop, else a portable Node; installs OpenClaw globally with npm; adds to the user PATH; refreshes a loaded service (`installer.md` lines 431-466) | PowerShell 5+ | System or portable Node, global npm prefix, user PATH |

**Pinning.** `--version <exact>` (`install.sh`, `install-cli.sh`) and `-Tag <exact>` (`install.ps1`) install that version instead of `latest` (`installer.md` lines 248, 397, 508). Clawtrate takes the installer from the pinned release itself: the npm registry's `openclaw-2026.10.6.tgz`, checked against its published integrity (`sha512-jSpQPa2J…qrxwA==`), holds `scripts/install-cli.sh` (SHA-256 `11e97095…dcffc`) and `scripts/install-policy.sh` (`704d7467…879cc6`). **Live**: run 44415483883, both runners. The website's `install-cli.sh` is a different file (1,991 lines, assembled with the policy inlined, SHA-256 `f5042f59…05d85b` on the day of the run) and can change at any time; running a script fetched live is what pinning avoids.

**NDJSON.** With `--json`, `install-cli.sh` writes one event per line: `{"event":"step","name":"node"|"openclaw"|"git"|"gateway-service"|…,"status":"start"|"ok"|"skip"|"warn",…}`, `{"event":"error","message":…}`, and `{"event":"done","ok":true,"version":…}` (`emit_json`, `<openclaw>/scripts/install-cli.sh` lines 230-254). A step list can be driven from it directly.

### 6.2 Installing, live

Run 44415483883, `install-cli.sh --json --runtime-only --npm --version 2026.10.6 --prefix "$RUNNER_TEMP/oc"`:

| | macOS (arm64, Node 24.22.3 on the runner) | Ubuntu |
|---|---|---|
| Exit | 0 | 0 |
| Time | 33 s | 20 s |
| Events | `node start`, `node ok 24.22.1`, `openclaw start 2026.10.6`, `openclaw ok`, `gateway-service skip runtime-only`, `done OpenClaw 2026.10.6 (fe06181)` | the same |
| Size | 808 MB | 825 MB |
| Wrote outside the prefix | nothing (`~/.openclaw` still absent) | nothing |

**A version that does not exist** (`--version 2026.99.99`): exit 1, events `node start`, `node ok`, `openclaw start`, then `{"event":"error","message":"npm install did not produce a usable OpenClaw package"}`, with npm's `ETARGET` on stderr, after one retry. The prefix keeps the downloaded Node in `tools/`. **Live**, both runners.

### 6.3 Onboarding without a model, live

`openclaw onboard --non-interactive --accept-risk --auth-choice skip --gateway-bind loopback --gateway-auth token --install-daemon --skip-skills --json`, run with the prefix's `openclaw`:

| | macOS | Ubuntu |
|---|---|---|
| Exit | 0 | 0 |
| Time | 28 s | 18 s |
| Service | `Installed LaunchAgent: ~/Library/LaunchAgents/ai.openclaw.gateway.plist` | `Installed systemd service: ~/.config/systemd/user/openclaw-gateway.service` |
| JSON | `{"ok":true,"mode":"local","workspace":…,"authChoice":"skip","gateway":{"port":18789,"bind":"loopback","authMode":"token","tailscaleMode":"off"},"installDaemon":true,"daemonInstall":{"requested":true,"installed":true},…}` | the same |

- `--auth-choice skip` is also the default when no provider flag is given (`<openclaw>/dist/onboard-non-interactive-Hx4CQstr.mjs` line 274); no model key is asked for or written.
- The success JSON names port, bind, auth mode and Tailscale mode, never the token (lines 455-470). A failure is `{"ok":false,"phase":…,"message":…,"classification":"auth-mismatch"|"module-missing"|"service-missing"|"service-stopped"|"startup-blocked"|"not-listening",…,"hints":[…]}`, with secrets redacted (lines 75-148). A service that cannot be installed, such as a Linux session without systemd user services, ends with exit 1 and `skippedReason: "systemd-user-unavailable"` (lines 335-361). **Source**; the runners had working service managers.
- `--install-daemon` on native Windows tries a Scheduled Task first and falls back to a Startup-folder login item (`<openclaw>/docs/cli/onboard.md` line 427). **Source** (section 6.6).

### 6.4 Looking at it, live

`openclaw gateway status --json` (exit 0) has the top-level keys `cli`, `logFile`, `service`, `config`, `gateway`, `hostDesktop`, `port`, `rpc`, `extraServices`, `pluginVersionDrift`. The parts the design reads:

- `service`: `{label: "LaunchAgent" | "systemd user", loaded: true, loadedText, runtime: {status: "running", pid, …}}`
- `gateway`: `{version: "2026.10.6", bindMode: "loopback", bindHost: "127.0.0.1", port: 18789, probeUrl: "ws://127.0.0.1:18789"}`
- `rpc`: `{ok: true, url: "ws://127.0.0.1:18789"}`

The command reuses a cached CLI device token and never creates a device identity or pairing record to check (`<openclaw>/docs/cli/gateway/query.md`, "Status semantics"). `openclaw devices list --json` on a fresh gateway: `{"pending":[],"paired":[]}`. `openclaw qr --json`: exit 1 with the loopback error (section 1); `openclaw qr --json --url ws://127.0.0.1:18789`: exit 0, as in section 3.

### 6.5 Removing it, live

`openclaw uninstall --service --state --workspace --yes --non-interactive`: exit 0 on both. Ubuntu printed "Stopped systemd service: openclaw-gateway.service", "Removed systemd service: …" and each removed folder; afterwards no `~/.openclaw`, no user unit, and on macOS no launchd job. The CLI itself is not removed by `uninstall` ("There is no separate CLI-removal scope", `<openclaw>/docs/cli/uninstall.md`); for an app-owned prefix, deleting the prefix removes it. `--state` refuses while an unmanaged gateway still runs on that state (same doc).

### 6.6 Windows

Both Windows runs executed `install.ps1` from the website (SHA-256 `E2813A79…7D27C6`, 2,665 lines). That is not the script in the pinned tarball (`scripts/install.ps1`, SHA-256 `2b2344ea…ce47bb`, 2,488 lines), which has the same Node-first and global-install behaviour when read but was never run. Run 44415483883:

- `-DryRun -Tag 2026.10.6 -NoOnboard` printed "[OK] Windows detected", "[OK] Dry run", "[OK] Install method: npm", "[OK] Onboard: skipped".
- **`-Tag 2026.99.99` changed the machine before it failed.** The runner's Node 22.23.4 is unsupported, so the script first installed Node 26.13.1 machine-wide with winget ("Found Node.js (LTS) [OpenJS.NodeJS.LTS] Version 26.13.1 … Successfully installed"), and only then ran npm, which failed with `ETARGET`; exit 1. A missing version is found after the system's Node has been replaced.
- `install.ps1` has no prefix option: OpenClaw goes into the global npm prefix. There is no Windows counterpart of `install-cli.sh`'s app-owned prefix; `-NodeOnly -NodePrefix <dir>` installs a private Node only (`installer.md` lines 468-470).

Run 44416142360 went on past the failure (Node 26.13.1 was now installed):

| Step | What came back |
|---|---|
| `install.ps1 -Tag 2026.10.6 -NoOnboard` | exit 0 after 304 s: "[OK] Node.js v26.13.1 found", "[*] Installing OpenClaw (openclaw@2026.10.6)...", "OpenClaw installed successfully (OpenClaw 2026.10.6 (fe06181))!"; `openclaw.cmd` in the global npm prefix |
| `onboard … --install-daemon --json` (as in 6.3) | exit 0 after 63 s: "Installed Scheduled Task: OpenClaw Gateway", "Startup mode: Unattended (S4U; boot and logon; no stored password)", the same JSON as macOS and Ubuntu; `schtasks` showed the task "Running" |
| `gateway status --json` | `service: {label: "Scheduled Task", loaded: true, loadedText: "registered"}`, `gateway` and `rpc` as on the others |
| `uninstall --service --state --workspace --yes --non-interactive` | removed the task script and every folder inside `~\.openclaw`, then "State cleanup failed: EBUSY: resource busy or locked, rmdir '<home>\.openclaw'" and "Workspace cleanup blocked because state cleanup could not safely complete."; exit 1. The task was gone; the empty folder stayed |
| `npm uninstall -g openclaw` | exit 0, "removed 493 packages" |

So on Windows: the version pin works; the install changes the machine's Node and global npm prefix; onboarding makes a Scheduled Task; removal can end with exit 1 over an empty, locked folder, which the next install does not trip on (a fresh `~\.openclaw` is created inside it).

### 6.8 An install that owns what it makes, from checked files (live)

Runs 44432670957 and 44433669562 (macOS arm64 and Ubuntu x64), workflow `setup-owned-install.yml`. A decoy `~/.openclaw/keep-me` was made first, standing for a person's own OpenClaw.

1. **Checked before anything ran.** The npm tarball matched its published integrity, and Node.js 24.22.1's tarball for the runner matched its published SHA-256 (from nodejs.org's `SHASUMS256.txt`, written into the workflow). The checked Node.js was extracted to `<prefix>/tools/node-v24.22.1`, and a record `.clawtrate-install.json` was written into the empty prefix.
2. **Installed exactly that.** `install-cli.sh --json --runtime-only --npm --version <path to the checked tarball> --prefix <prefix>`, with `NPM_CONFIG_USERCONFIG` and `NPM_CONFIG_GLOBALCONFIG` pointing at two empty files and `npm_config_registry=https://registry.npmjs.org/`:
   - `{"event":"step","name":"node","status":"skip","path":"<prefix>/tools/node-v24.22.1"}`: the installer used the checked Node.js (`linked_node_is_usable`, `<openclaw>/scripts/install-cli.sh` lines 908-912);
   - `added 345 packages`, then `openclaw ok` and `done OpenClaw 2026.10.6 (fe06181)`; exit 0 in 30 s (Ubuntu) and 38 s (macOS);
   - the installed `dist/entry.js` had the same SHA-256 as the checked tarball's (`84d9ae45…ce0d08`), and `<prefix>/tools/node` pointed at the checked Node.js.
3. **What remains unchecked.** OpenClaw has no shrinkwrap: its 66 direct dependencies are pinned exactly in its `package.json`, and npm resolves the rest at install time, 345 packages in all. The app can't verify those. On Alpine and other musl Linux the installer uses the system's `apk` (`install_alpine_node`, line 709), so the app offers no install there.
4. **A named profile of its own.** `openclaw --profile clawtrate onboard --non-interactive --accept-risk --auth-choice skip --gateway-bind loopback --gateway-auth token --gateway-port <free port> --install-daemon --skip-skills --json`: exit 0 (21 s, 22 s). The service was the profile's own, `openclaw-gateway-clawtrate.service` ("OpenClaw Gateway (profile: clawtrate)") and `ai.openclaw.clawtrate`; the state was `~/.openclaw-clawtrate`. `gateway status --json --profile clawtrate` showed the service running with the prefix's program and the chosen port, and `rpc.ok`. The default profile's service was not loaded, and `~/.openclaw/keep-me` was untouched.
5. **Removal touched only the profile.** `openclaw --profile clawtrate uninstall --service --state --workspace --yes --non-interactive`: exit 0. It stopped and removed only the profile's service, removed `~/.openclaw-clawtrate` (with the owner file written into it), and nothing listened on the port afterwards. The decoy still read "the person's own". On macOS the LaunchAgent's file was **moved to the Trash** ("Moved LaunchAgent to Trash: ~/.Trash/ai.openclaw.clawtrate.plist"), not deleted. The macOS log file `~/Library/Logs/openclaw/gateway-clawtrate.log` was not checked, and removal must report it if it remains.
6. **Two traps found.** npm refuses one file as both user and global configuration ("double-loading config … previously loaded as user"). Then the installer's Node check fails, and the installer **deletes the pre-placed folder** and downloads Node.js itself (run 44432670957). An installer whose Node.js step does not report `skip` must therefore be treated as a failure.

### 6.9 What the look can know

- `extraServices` is filled only with `--deep` (`<openclaw>/dist/status.gather-Adzoi3Iz.mjs` line 427). Those entries are services found on the machine; they don't say whether each runs, on which port, or which profile's commands control it. The design names them and does not connect to them.
- "Not on PATH" is not "not installed": a person's install can be in a place the app doesn't look. The look checks a fixed list of places, and separately whether `~/.openclaw` or a default service exists. A missing program with either present is "set up, program missing", which offers no install.
- A version from `--version` describes the program; `rpc.ok` with `gateway.version` describes the running gateway. `hello-ok.protocol` describes a handshake that succeeded and cannot explain a refused one; a refusal arrives as the connect's protocol error.

### 6.7 What each failure looks like, and undoing it

| Failure | How it shows | Undo |
|---|---|---|
| No network, or a download stalls | `install-cli.sh` allows five minutes per connection or stalled transfer (`UPDATE_NETWORK_TIMEOUT_SECONDS=300`); then an `error` event and exit 1 | Delete the prefix |
| Version missing | `error` "npm install did not produce a usable OpenClaw package" | Delete the prefix |
| Not enough disk | `disk-space` step `warn` or a failing npm step (`preflight_fresh_git_disk_space`, git method only) | Delete the prefix |
| Node cannot be provisioned | `node` step fails, or "Private Node.js recovery is unavailable on musl Linux" | Nothing written but the prefix |
| Onboarding cannot install the service | onboarding JSON `ok:false`, `daemonInstall.skippedReason` | `<prefix>/bin/openclaw --profile clawtrate uninstall --service --state --workspace --yes --non-interactive` (in §6.8 it stopped and removed only the profile's service and state), then delete the prefix |
| The gateway does not come up | onboarding JSON `ok:false` with `classification` | `<prefix>/bin/openclaw --profile clawtrate gateway status --json`, then the same uninstall and the prefix |
| Cancelled midway | the process is stopped by its PID; npm may leave a partial package, which `install-cli.sh` detects on the next run (`.openclaw-lifecycle-pending`, retried once) | If onboarding had begun, the same uninstall; then delete the prefix. Only the prefix and the `clawtrate` profile (`~/.openclaw-clawtrate`, its service) are the install's; `~/.openclaw` is never touched |

## 7. SSH from a shipped desktop app

### Options

| Option | Why |
|---|---|
| `BatchMode=yes` | Never prompts for a password, a passphrase or a host key; a key that needs a passphrase and is not in an agent is refused ("Permission denied (publickey)") instead of prompting. **Live.** |
| `StrictHostKeyChecking=yes` | Never accepts an unknown or changed host key by itself. **Live.** |
| `ExitOnForwardFailure=yes` | A forward that cannot listen ends the process with exit 255 instead of running without it. **Live.** |
| `ServerAliveInterval=15`, `ServerAliveCountMax=3` | A forward over a dead network ends within about 45 s instead of hanging. **Live** with 2 and 2: "Timeout, server 127.0.0.1 not responding.", exit 255. |
| `ConnectTimeout=10` | An address that does not answer fails in seconds. |
| `-N -L 127.0.0.1:<free port>:127.0.0.1:<gateway port>` | Port forward only, no remote command; bound to loopback. |
| `-o ControlMaster=no -o ControlPath=none`, `-o ForwardAgent=no`, `-T` | No shared master the person's own sessions could ride, no agent forwarding, no terminal. |
| `ClearAllForwardings=yes` for looks and commands; `-o ClearAllForwardings=no` only on the dedicated `-N -L` invocation | With `ClearAllForwardings yes`, `ssh` stayed up and no local forward listened; with `no` on that one invocation, from a generated configuration that holds no forwards, the one explicit loopback forward reached the gateway and paired read-only. **Live** in the confirming review. |
| `-F <a configuration the host writes>` | The person's configuration file is read by the host as text and never given to `ssh` as input; `ssh -G` is not used, because it evaluates `Match exec` (section 7.2). |

Which of the person's settings are taken, and how, is in `docs/design/setup.md` §5: a short list read from their file, written into the host's own configuration.

**A local port of 0 is refused** for `-L` ("Bad local forwarding specification '127.0.0.1:0:127.0.0.1:…'"). **Live.** The host picks a free loopback port, and `ExitOnForwardFailure` turns a lost race into exit 255 ("bind [127.0.0.1]:…: Address already in use … Could not request local forwarding."), after which it picks another. **Live.** A Unix-socket forward (`-L <path>:127.0.0.1:<port>`) works on macOS (**live**, with `StreamLocalBindMask=0177`) but not on Windows (below), so the design uses a loopback TCP port everywhere.

**A forward to a port where nothing listens** does not fail when it is made: each connection through it fails, and `ssh` prints "channel 1: open failed: connect failed: Connection refused" and keeps running. **Live.** So "is the gateway running there?" is answered by `openclaw gateway status --json` over SSH before forwarding, not by the forward.

### The three failures (all exit 255), live

| Failure | stderr (macOS and Linux) | Windows (OpenSSH_for_Windows_9.5p2) |
|---|---|---|
| Cannot be reached: refused | `ssh: connect to host 127.0.0.1 port 1: Connection refused` | `banner exchange: Connection to UNKNOWN port -1: Connection refused` |
| Cannot be reached: no such name | `ssh: Could not resolve hostname nonexistent.invalid: nodename nor servname provided, or not known` (Linux: `Name or service not known`) | `ssh: Could not resolve hostname nonexistent.invalid: No such host is known.` |
| Cannot be reached: no answer | `ssh: connect to host 192.0.2.1 port …: Operation timed out` | not run |
| Sign-in refused | `<user>@<host>: Permission denied (publickey).` | the same |
| Host key not known | `No ED25519 host key is known for [127.0.0.1]:<port> and you have requested strict checking.` then `Host key verification failed.` | the same |
| Host key changed | `WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!` … `The fingerprint for the ED25519 key sent by the remote host is SHA256:…` … `Host key verification failed.` | not run |
| A running forward drops | `Connection to 127.0.0.1 closed by remote host.` | not run |
| A running forward goes silent | `Timeout, server 127.0.0.1 not responding.` | not run |

Telling them apart: exit 255 always; then "Host key verification failed" → host key; "Permission denied" → sign-in; "Could not resolve hostname", "Connection refused", "timed out", "No route to host", "Network is unreachable" → cannot be reached. Anything else is "ssh stopped (exit 255)", in fixed copy, with no line of `ssh`'s output kept or shown.

**The fingerprint.** With `-v`, `ssh` prints `debug1: Server host key: ssh-ed25519 SHA256:<fingerprint>` before it refuses an unknown key. **Live** on all three systems. What is shown and pinned is not that line, nor a second scan: it is the key record captured on the connection itself (section 7.2).

### 7.2 The key, captured and pinned as one act; a constant remote command (live)

Against an `sshd` of my own (as in section 7), with a configuration file written for the test (`ssh -F`, which also drops the system configuration: "If a configuration file is given on the command line, the system-wide configuration file (/etc/ssh/ssh_config) will be ignored", `man ssh`):

- **First contact, without signing in.** `ssh -F <file> -o HostKeyAlias=clawtrate-route-1 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=<empty capture file> -o PreferredAuthentications=none -o NumberOfPasswordPrompts=0 -T devbox true` printed "Warning: Permanently added 'clawtrate-route-1' (ED25519) to the list of known hosts." and "Permission denied (publickey).", exit 255. The capture file held one line, `clawtrate-route-1 ssh-ed25519 AAAAC3…`, whose fingerprint equalled the server's host key. The server logged "Connection closed by authenticating user … [preauth]" and "connections without attempting authentication": no key of the person's was offered. These bytes are the key negotiated on that very connection, whatever the route, so a renamed alias or another key type can't make it the wrong key. The design runs the capture with `-NT` (no command, no session, no terminal) and closes it once the key is written: the probe offers no credentials and opens no session. `ssh` still sends the initial `none` sign-in request, which a server could accept. What is pinned is the captured record itself, with its resolved endpoint and algorithm, never a fingerprint supplied by the page.
- **Pinned.** The same alias with `StrictHostKeyChecking=yes` and only that file connected and ran its command (exit 0).
- **Already trusted elsewhere.** With an empty app file and a stand-in for the person's known-hosts file listed second, `-v` printed `Host '[127.0.0.1]:<port>' is known and matches the ED25519 host key.` and `Found key in <file>:2`. This lookup used the real host and port. Under the route's `HostKeyAlias`, a normal entry for the host and port is not found: the alias replaces the lookup name, including for host certificates (`man ssh_config`; confirmed in the review's probe). So prior trust is looked up for the resolved host and port, without the alias; the verified literal key is then stored under the alias. A certificate-authority or marker line is never treated as literal pin bytes.
- **Changed.** After `sshd` was restarted with another host key, the pinned connection failed with "REMOTE HOST IDENTIFICATION HAS CHANGED" and the new fingerprint. A fresh capture, as in the first point, gave that new key's fingerprint, matching the new host key. So both keys can be shown side by side, and the new one pinned only by decision.
- **A constant remote command.** The command string `/bin/sh -s`, with the script on standard input, ran the same under `sh`, `bash`, `zsh`, `dash`, `ksh`, `csh` and `tcsh` as the outer shell (`<shell> -c '/bin/sh -s' < script`), and over `ssh` (fish was not installed). Values reach the script only as assignments the host writes after validation. This proves how the constant parses, not control over the remote account: sshd starts the command through the account's login shell, and in the confirming review a zsh startup file ran before the fixed script. The account is a trust boundary, confirmed by the person before any remote command runs.
- The review saw `ssh -v`'s debug lines end in CRLF on its system; a parser must accept both.

### Windows

**Live**, run 44416142360: `C:\Windows\System32\OpenSSH\ssh.exe` is present, `OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2`; the `ssh-agent` service is `Stopped`, start type `Disabled`. The same options work and the same messages come back, except: "Connection refused" reads `banner exchange: Connection to UNKNOWN port -1: Connection refused`; `ControlMaster=auto` fails ("getsockname failed: Not a socket", exit -1); a Unix-socket forward is refused ("Bad local forwarding specification 'D:/a/_temp/fwd.sock:127.0.0.1:18789'"). With the agent disabled, a key that has a passphrase cannot be used without a prompt; the person enables the agent service and adds the key once. Windows also ships `ssh-keyscan.exe` and `ssh-keygen.exe`.

## 8. Tailscale

From `<openclaw>/docs/gateway/tailscale.md` and the ingress source only. **No `tailscale` program was run.**

- `gateway.tailscale.mode`: `off` (default), `serve` (tailnet only) or `funnel` (public, needs password auth) (lines 15-23). With `serve` the gateway stays on `127.0.0.1` and holds the Serve route itself, as a foreground claim, to a dedicated `127.0.0.1:<ephemeral>` listener; stopping the gateway releases the route (lines 133, 148).
- Needs: the `tailscale` CLI installed and signed in (line 130); HTTPS certificates enabled for the tailnet (line 145); MagicDNS. A daemon reporting `Stopped` prevents gateway start (line 150); "Serve not enabled on the tailnet" leaves the loopback gateway running and warns (line 133). On Linux a non-root gateway needs Tailscale operator rights (`sudo tailscale set --operator=$USER`, line 134).
- A connection through managed Serve is `tailscale-serve` ingress (`resolveManagedTailscaleIngress`, `ingress-attribution-BQX5Ye8B.mjs` lines 55-93), never `direct-local`: a new device's pairing waits for approval like any remote one. Tailscale identity headers sign in only OpenClaw's own Control UI (lines 110-120).
- `openclaw qr` advertises the Tailscale address only when OpenClaw owns the route (`<openclaw>/docs/cli/qr.md` line 69), which makes it the setup-code address for a phone away from home.
- A route someone made by hand to the ordinary listener is generic proxy ingress and needs `gateway.trustedProxies` (lines 122-126); without it the gateway refuses it (section 3, "A proxy route made by hand").
- Turning it on is `openclaw config set gateway.tailscale.mode serve` and a restart of the gateway (`openclaw gateway restart`). Putting it back means restoring the exact earlier value of `gateway.tailscale`, which may be absent, not writing `off`. What the failures look like is read from `tailscale status --json` before the change and the gateway's warning after the restart; their exact words are **unverified**, because the program may not be run here. The design names them from Tailscale's own states, kept apart: not installed (the program is not found), stopped (`BackendState` `Stopped`), signed out (`NeedsLogin`), HTTPS not enabled (no certificate domain), and, on Linux, no operator permission (line 134).
- `openclaw qr --remote` is not an observation: it can prefer `gateway.remote.url`, and it mints a code (`<openclaw>/docs/cli/qr.md` lines 36, 79-81). Whether the managed route exists is read from `tailscale serve status --json`; whether it answers, from the gateway's unauthenticated `/healthz` through it (`<openclaw>/docs/gateway/health.md`, "HTTP checks").

## 9. What could not be proven here

| What | Why | What the design does about it |
|---|---|---|
| A phone's setup-code connect from another address waits for approval | The development instance listens on loopback only, and a header-adding proxy is refused outright | Treats it as waiting, with "Approve from here" on the desktop (source, section 3) |
| The pinned tarball's own `install.ps1` | Never run; both Windows runs used the website's | The design doesn't install on Windows at all (F-517) |
| A reboot after install | Runners aren't rebooted | The design describes each service by what it is ("starts when you log in"), not by a promise about boot |
| Tailscale's rollback, end to end | No `tailscale` program may run here | The design restores the recorded value and checks the original route before saying so, and says when it couldn't |
| Tailscale's three failures, in OpenClaw's words | No `tailscale` program may run on this machine; the runners are not on a tailnet | Named from Tailscale's own states, worded by Clawtrate |
| A gateway signing a client's challenge with its identity key | No such method found | Each route pairs by itself; routes are grouped after authentication (section 5) |
| `install.sh` | Not in the npm package; only served by the website | Not used: `install-cli.sh` from the pinned tarball covers macOS and Linux |

## Files

| File | What it is |
|---|---|
| `setup-flow/pair-probe.ts` | The probes for sections 1 to 4 and 3.1: `pair`, `upgrade`, `code` (with `--limited`, `--voice` and `--scopes`), `method`, `proxy`. Acts only on a named instance started with `--default-local-pairing`; runs `openclaw` only through the development tool's guarded runner; refuses a `--port` unless its one listener is an `ssh` forwarding exactly that port to the instance; removes the scratch client folder it makes; redacts every token it prints. |
