# A relay connector on the gateway's computer: what the gateway trusts

A relay that carries a phone's connection to the gateway ends, on the gateway's computer, in a connector: a program that opens its own WebSocket to the gateway's loopback port and passes the phone's frames through. This note settles how OpenClaw 2026.10.6 treats such a connection: as local, which would pair every relayed phone silently, or as remote, which makes each new phone wait for its owner's approval. It also corrects a claim in `setup-flow.md` §1 about the `Host` header.

Citations follow `setup-flow.md`: `<openclaw>/…` is a path in the installed `openclaw` 2026.10.6 npm package, with line numbers of the 2026.10.6 chunks. **Live** means it was run and the result is quoted. **Source** means it was read in shipped code or bundled docs.

Where it was run: two development instances started by this checkout, with the probes in `relay/probe.ts`:

- `r0trust`: `pnpm dev-gateway start --instance r0trust --default-local-pairing --trust-loopback-proxy --no-seed`. The config's `gateway` had `trustedProxies: ["127.0.0.1", "::1"]` and no `autoApproveLocal`.
- `r0plain`: the same without `--trust-loopback-proxy`, as the control.

`--trust-loopback-proxy` was added to `tools/dev-gateway` for this note ([the development gateway](../development/dev-gateway.md#a-trusted-loopback-proxy)). Both instances were reset afterwards.

The stand-in connector is a loopback proxy that forwards each upgrade to the gateway's port. It either forwards it unchanged, rewrites `Host` to `gw-0123abcd.relay.example`, or also adds `X-Forwarded-For: 203.0.113.7` (a documentation address standing for the phone), `X-Forwarded-Proto: https` and `X-Forwarded-Host`. The client is this project's `ClawtrateClient` with the shared token, as the desktop app connects, except in the setup-code row.

## Summary

| Connection | `trustedProxies` | Gateway's answer | First pairing |
|---|---|---|---|
| The desktop app, straight to the gateway's port | loopback | 101 | silent (`approvedVia: "silent"`) |
| Through the connector, upgrade unchanged | loopback | 101 | silent |
| Through the connector, `Host` rewritten, no forwarded headers | loopback | 101; the log says "Treating it as remote" | **silent** |
| Through the connector, with `X-Forwarded-For` | loopback | 101 | **waits** with `PAIRING_REQUIRED`; the request carries `remoteIp: "203.0.113.7"`; `devices approve` → hello, `approvedVia: "owner"` |
| Through the connector, with `X-Forwarded-For: 127.0.0.1` | loopback | 403 on every attempt | none |
| A `--limited` setup code redeemed through the connector with `X-Forwarded-For`, asking for `operator.read` | loopback | 101 | waits; `devices approve` → hello, `["operator.read"]` |
| Through the connector, `Host` rewritten, no forwarded headers | none | 101 | silent |
| Through the connector, with `X-Forwarded-For` | none | 403 on every attempt | none |

All **live**. So a connector must build every upgrade itself with a non-loopback `X-Forwarded-For`, and the gateway's owner must set `gateway.trustedProxies` to loopback. Then each relayed phone waits for approval and the desktop on the gateway's computer still pairs silently.

## 1. What the gateway does

`resolveGatewayIngressAttribution` (`<openclaw>/dist/ingress-attribution-BQX5Ye8B.mjs` lines 95-118) decides, in this order:

1. A loopback socket with no forwarded headers (`X-Forwarded-For`, `X-Real-IP` and the like) and no Tailscale headers is `direct-local` (line 107). `Host` plays no part.
2. A socket from an address in `gateway.trustedProxies` is `trusted-proxy`, with the client address read from `X-Forwarded-For` (lines 108-115). If that address is missing or loopback, the connection is unattributable instead (line 110).
3. Any other connection with forwarded headers is unattributable (line 116), and the WebSocket upgrade is refused with 403 `proxy_attribution_required`.

The message handler then sets `isLocalClient = ingressAttribution.kind === "direct-local"` (`<openclaw>/dist/message-handler-CRCo2VX0.mjs` line 3419). `resolvePairingLocality` (`<openclaw>/dist/node-connect-reconcile-CAkPC2vI.mjs` lines 192-197) turns that into `direct_local`, and `shouldAllowSilentLocalPairing` (lines 178-185) approves a first pairing silently unless the locality is `remote`, the connection has a browser `Origin`, or `autoApproveLocal` is `false`. A `trusted-proxy` connection is not local, and with forwarded headers it can't be `shared_secret_loopback_local` either, so its locality is `remote` and its pairing waits. **Source**, matching every row above.

The client address is the right-most hop in `X-Forwarded-For` that is neither loopback nor itself a trusted proxy (`resolveForwardedClientIp`, `<openclaw>/dist/net-CpjDDLK3.mjs` lines 86-100). A connector that passed a phone's own `X-Forwarded-For` on would let the phone choose the address the gateway records and rate-limits. The connector has to write the header itself. **Source.**

`gateway.trustedProxies` is not the `trusted-proxy` auth mode. That mode (`gateway.auth.mode: "trusted-proxy"`) takes the user's identity from proxy headers and refuses loopback sources unless `allowLoopback` is set (`<openclaw>/docs/gateway/trusted-proxy-auth.md` lines 93-95). Token auth stays as it is here, and only the attribution changes. **Source.**

## 2. The `Host` header does not make a connection remote

`setup-flow.md` §1 said that "a loopback socket whose Host header is not local is treated as remote", citing line 3427 of the message handler. That line only logs a warning: "Loopback connection with non-local Host header. Treating it as remote. If you're behind a reverse proxy, set gateway.trustedProxies …". `isLocalClient` is set eight lines earlier from the attribution alone. **Live**, on both instances:

```
[host] upgrade answers the connector saw: [101]
[host] core client: {"status":"connected","scopes":["operator.read"],"paired":true,"pairing":null,"error":null,"gatewayId":"32340d78e525"}
[host] gateway devices: {"pending":[],"paired":[{"deviceId":"215c2e2d9b46","displayName":"Clawtrate Desktop","roles":["operator"],"scopes":["operator.read"],"approvedVia":"silent"}, …]}
[host] gateway log: ["… [ws] Loopback connection with non-local Host header. Treating it as remote. If you're behind a reverse proxy, set gateway.trustedProxies and forward X-Forwarded-For/X-Real-IP.","… [gateway] device pairing auto-approved device=215c2e2d9b46… role=operator"]
```

The log says remote, and the same connection is paired silently. On 2026.10.6, a connector that forwards to loopback without `X-Forwarded-For` hands every relayed device the trust of a program on the gateway's own computer, whatever `Host` it sends. This is worth reporting upstream: the warning claims a protection the code does not apply.

## 3. With `X-Forwarded-For` and a trusted loopback proxy

`probe.ts xff --approve` on `r0trust`:

```
[xff] upgrade answers the connector saw: [101]
[xff] core client: {"status":"pairing","scopes":[],"paired":false,"pairing":{"requestId":"705027e0-…","requestedScopes":["operator.read"]},"error":null,"gatewayId":null}
[xff] gateway devices: {"pending":[{"deviceId":"babc34bba29f","requestId":"705027e0-…","displayName":"Clawtrate Desktop","roles":["operator"],"scopes":["operator.read"],"remoteIp":"203.0.113.7"}], …}
devices approve 705027e0-…: exit 0
[xff] after approval: {"status":"connected","scopes":["operator.read"],"paired":true,"pairing":null,"error":null,"gatewayId":"32340d78e525"}
[xff] gateway devices: {"pending":[],"paired":[{"deviceId":"babc34bba29f",…,"scopes":["operator.read"],"approvedVia":"owner","remoteIp":"203.0.113.7"}, …]}
[xff] gateway log: ["… [ws] closed before connect … remote=127.0.0.1 fwd=203.0.113.7 origin=n/a host=gw-0123abcd.relay.example … cause=pairing-required …","… [gateway] device pairing approved device=babc34bba29f… role=operator"]
```

The gateway recorded the forwarded address as the device's `remoteIp`, which it reports only for a connection that is not `direct-local` (`reportedClientIp`, `message-handler-CRCo2VX0.mjs` line 3420). The client's own 3-second pairing retry reached hello after the approval, with `operator.read` and nothing more.

**The desktop on the gateway's computer stays silent.** `probe.ts desktop` on the same instance, before and again after the relayed devices paired, connected a new device straight to the gateway's port and was approved silently both times (`approvedVia: "silent"`, log "device pairing auto-approved"). The no-headers branch is checked before the trusted-proxy one, so setting `trustedProxies` takes nothing from local clients that send no forwarded headers.

**A loopback `X-Forwarded-For` is refused.** `probe.ts xff-loopback`: eight upgrades, each answered 403, no pending request, and the log line "observed unattributable proxy-shaped traffic from 127.0.0.1". A connector that has no public address for the phone must send some non-loopback stand-in, not a loopback one.

**Without `trustedProxies`, `X-Forwarded-For` is refused.** `probe.ts xff` on `r0plain`: eight upgrades answered 403 and the same log line, as `setup-flow.md` §3 found for a proxy route made by hand.

## 4. A setup code redeemed through the relay

`probe.ts code --approve` on `r0trust` ran `openclaw qr --json --limited --url wss://gw-0123abcd.relay.example`. It exited 0, with `access: "limited"`, `urlSource: "plugins.entries.device-pair.config.publicUrl"` and the relay address as the payload's `url`. A new device then redeemed the code through the connector with `X-Forwarded-For`, as `gateway-client` in `ui` mode with platform `ios`, asking for `operator.read`:

```
[code via xff connector] first connect, asking for operator.read: {"outcome":"refused","message":"device pairing required (requestId: 167f718a-…)","code":"NOT_PAIRED","details":{"code":"PAIRING_REQUIRED","reason":"not-paired",…,"requestedRole":"operator","requestedScopes":["operator.read"]}}
[code via xff connector] gateway devices: {"pending":[{"deviceId":"b7f5dbd69e51","requestId":"167f718a-…","displayName":"Clawtrate relay research phone","roles":["operator"],"scopes":["operator.read"],"remoteIp":"203.0.113.7"}], …}
devices approve 167f718a-…: exit 0
[code via xff connector] the same device connects again: {"outcome":"hello","role":"operator","scopes":["operator.read"],"deviceToken":true}
[code via xff connector] gateway devices: {… {"deviceId":"b7f5dbd69e51",…,"scopes":["operator.read"],"approvedVia":"owner","remoteIp":"203.0.113.7"} …}
```

This settles a row `setup-flow.md` §9 left unverified: away from the gateway's computer, a code does not approve this client by itself. The pairing waits for the owner, and the same code, presented again by the same device after approval, reaches hello with only what was asked for. **Live.**

## 5. What this does not show

- **A real relay, phone or network.** The connector here is a plain loopback proxy, and the client is Node on the gateway's computer.
- **Live reload of `trustedProxies`.** The instance was started with the setting in place. The docs say a change applies without a restart when live reload is on (`<openclaw>/docs/gateway/trusted-proxy-auth.md` line 150). **Source.**
- **Other gateway versions.** Everything is 2026.10.6. The attribution order and the `Host` warning are worth checking again when the pinned version changes.

## Files

| File | What it is |
|---|---|
| `relay/probe.ts` | The probes for sections 2 to 4: `desktop`, `plain`, `host`, `xff`, `xff-loopback` and `code`, with `--approve` for the last two. Acts only on a named instance started with `--default-local-pairing`, and reports whether `--trust-loopback-proxy` was set. It runs `openclaw` only through the development tool's guarded runner, removes the scratch client folders it makes, and redacts every token it prints. |
