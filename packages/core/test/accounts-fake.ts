// A gateway with provider accounts, in memory, for the accounts engine's
// tests: a config with merge patches, a shared store and each bot's own store,
// stored orders, and the gateway's sign-in sessions (`models.authLogin`,
// `wizard.next`, `wizard.cancel`) with every ending scripted per session.
// The credentials are made-up development strings.

import { ADMIN_SCOPES } from "../src/scopes.ts";
import { FAST, URL_A } from "./client-harness.ts";
import { ClawtrateClient } from "../src/client.ts";
import {
  FakeGateway,
  GatewayError,
  helloOk,
  memoryStorage,
  testHost,
  tokenKey,
  until,
} from "./fake-gateway.ts";

type Json = Record<string, unknown>;
type Profile = { id: string; provider: string; type: string; label?: string };

export type Ending =
  | { outcome: "approve"; account: string }
  | { outcome: "refuse" }
  | { outcome: "expire" }
  | { outcome: "unconfirmed"; account: string }
  | { outcome: "error"; message: string };

type Session = {
  id: string;
  choice: string;
  agentId: string;
  phase: "start" | "waiting" | "entering" | "note" | "done";
  ending: Ending;
  /** Resolves a `wizard.next` that waits on the person (a device code). */
  release: (() => void) | null;
  result: Json | null;
  answers: unknown[];
};

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

function mergePatch(base: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out: Json =
    base && typeof base === "object" && !Array.isArray(base) ? { ...(base as Json) } : {};
  for (const [key, value] of Object.entries(patch as Json)) {
    if (value === null) delete out[key];
    else out[key] = mergePatch(out[key], value);
  }
  return out;
}

export const CHOICES = {
  device: "dev-signin/acme-device-code",
  browser: "dev-signin/acme-browser",
  key: "dev-signin/acme-api-key",
} as const;

export class AccountsGateway {
  readonly gateway = new FakeGateway();
  admin = true;
  config: Json = {
    agents: {
      defaults: { model: { primary: "acme/dev-1" } },
      entries: {
        main: { workspace: "/w/main" },
        otto: {
          workspace: "/w/otto",
          agentDir: "/s/agents/otto/agent",
          model: { primary: "acme/dev-1@acme:work", fallbacks: [] },
        },
        pip: {
          workspace: "/w/pip",
          model: { primary: "acme/dev-1@acme:home", fallbacks: ["globex/dev-1"] },
        },
      },
    },
    auth: {
      profiles: {
        "acme:work": { provider: "acme", mode: "api_key", displayName: "Work" },
        "acme:home": { provider: "acme", mode: "api_key", displayName: "Home" },
        "acme:studio": { provider: "acme", mode: "api_key", displayName: "Studio" },
      },
    },
  };
  revision = 1;
  bots: Array<{ id: string; name: string }> = [
    { id: "main", name: "Juniper" },
    { id: "otto", name: "Otto" },
    { id: "pip", name: "Pip" },
  ];
  shared: Profile[] = [
    { id: "acme:work", provider: "acme", type: "api_key" },
    { id: "acme:home", provider: "acme", type: "api_key" },
  ];
  own: Record<string, Profile[]> = {
    otto: [{ id: "acme:studio", provider: "acme", type: "api_key" }],
  };
  orders: Record<string, Record<string, string[]>> = {};
  /** An order the gateway's settings give a provider (`auth.order`): reported for every bot, not stored. */
  configuredOrders: Record<string, string[]> = {};
  /** Answer `models.authStatus` as the gateway does when its account status is unavailable. */
  unavailable = false;
  prefs: Json = {};
  sessions = new Map<string, Session>();
  /** The ending the next sign-in gets. */
  nextEnding: Ending = { outcome: "approve", account: "travel" };
  /** Every value a `wizard.next` answered with, and every key `models.authSetApiKey` got. */
  readonly typed: unknown[] = [];
  /** Fail the next `config.patch` with this message. */
  failPatch: string | null = null;
  /** Leave the next `agents.create` unanswered, then make the bot anyway. */
  silentCreate = false;
  /** Refuse the next `wizard.cancel`: the gateway is saving. */
  refuseCancel = false;
  /** Fail `models.authStatus` for this bot. */
  failStatusFor: string | null = null;
  /** Echo what was typed back in a refusal, as a careless gateway might. */
  echoTyped = false;

  constructor() {
    const g = this.gateway;
    g.connectReply = (params) => {
      const { scopes, auth } = params as { scopes: string[]; auth?: { deviceToken?: string } };
      this.admin = scopes.includes("operator.admin");
      return { ok: true, payload: helloOk(scopes, auth?.deviceToken ?? "device-token") };
    };
    g.handlers["question.list"] = () => ({ questions: [] });
    for (const method of ["exec.approval.list", "plugin.approval.list", "openclaw.approval.list"])
      g.handlers[method] = () => [];
    g.handlers["agents.list"] = () => ({
      defaultId: "main",
      agents: this.bots.map((bot) => ({ id: bot.id, identity: { name: bot.name } })),
    });
    g.handlers["config.get"] = () => ({
      config: JSON.parse(JSON.stringify(this.config)) as Json,
      hash: `h${this.revision}`,
      configRevisionHash: `r${this.revision}`,
      appliedConfigHash: `r${this.revision}`,
    });
    g.handlers["config.patch"] = (params) => {
      const { raw, baseHash } = params as { raw: string; baseHash?: string };
      if (this.failPatch) {
        const message = this.failPatch;
        this.failPatch = null;
        throw new GatewayError({ code: "INVALID_REQUEST", message });
      }
      if (baseHash !== `h${this.revision}`)
        throw new GatewayError({ code: "INVALID_REQUEST", message: "config changed" });
      this.config = mergePatch(this.config, JSON.parse(raw)) as Json;
      this.revision += 1;
      return { ok: true };
    };
    g.handlers["users.prefs.get"] = () => ({
      status: "ok",
      entries: JSON.parse(JSON.stringify(this.prefs)) as Json,
    });
    g.handlers["users.prefs.set"] = (params) => {
      Object.assign(this.prefs, (params as { entries: Json }).entries);
      return { status: "ok" };
    };
    g.handlers["models.list"] = () => ({
      models: [
        {
          id: "dev-1",
          provider: "acme",
          thinkingLevels: [{ id: "off" }, { id: "low" }, { id: "high" }],
          thinkingDefault: "low",
          available: true,
        },
        { id: "dev-2", provider: "acme", thinkingLevels: [], available: true },
        { id: "dev-1", provider: "globex", thinkingLevels: [{ id: "low" }], available: false },
      ],
    });
    g.handlers["models.authStatus"] = (params) => {
      const { agentId } = params as { agentId: string };
      if (agentId === this.failStatusFor)
        throw new GatewayError({ code: "UNAVAILABLE", message: "status unavailable" });
      if (this.unavailable)
        return { providers: [], unavailable: { code: "PREPARED_MODEL_AUTH_UNAVAILABLE" } };
      return this.status(agentId);
    };
    g.handlers["agents.create"] = (params) => {
      const { name, model, avatar } = params as { name: string; model?: string; avatar?: string };
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      this.bots.push({ id, name });
      const entries = (this.config.agents as Json).entries as Json;
      entries[id] = {
        name,
        agentDir: `/s/agents/${id}/agent`,
        ...(model ? { model } : {}),
        ...(avatar ? { identity: { avatar } } : {}),
      };
      this.revision += 1;
      if (this.silentCreate) {
        this.silentCreate = false;
        return new Promise(() => {});
      }
      return { ok: true, agentId: id, name, workspace: `/w/${id}`, ...(model ? { model } : {}) };
    };
    g.handlers["sessions.create"] = (params) => {
      const { key } = params as { key: string };
      return { ok: true, key, sessionId: `session-${key}` };
    };
    g.handlers["models.authLogin"] = (params) => {
      const { sessionId, authChoice, agentId } = params as {
        sessionId: string;
        authChoice: string;
        agentId: string;
      };
      if ([...this.sessions.values()].some((s) => s.phase !== "done"))
        throw new GatewayError({
          code: "UNAVAILABLE",
          message: "OpenClaw setup is already in progress; try again when it finishes.",
        });
      this.sessions.set(sessionId, {
        id: sessionId,
        choice: authChoice,
        agentId,
        phase: "start",
        ending: this.nextEnding,
        release: null,
        result: null,
        answers: [],
      });
      return { sessionId, done: false, status: "running" };
    };
    g.handlers["wizard.next"] = (params) =>
      this.next(params as { sessionId: string; answer?: { stepId: string; value: unknown } });
    g.handlers["wizard.cancel"] = (params) => {
      const session = this.sessions.get((params as { sessionId: string }).sessionId);
      if (!session)
        throw new GatewayError({ code: "INVALID_REQUEST", message: "wizard not found" });
      if (this.refuseCancel) {
        this.refuseCancel = false;
        throw new GatewayError({ code: "INVALID_REQUEST", message: "cannot cancel while saving" });
      }
      session.phase = "done";
      session.result = { done: true, status: "cancelled", error: "cancelled" };
      session.release?.();
      return { status: "cancelled", error: "cancelled" };
    };
    g.handlers["models.authSetApiKey"] = (params) => {
      const { provider, apiKey } = params as { provider: string; apiKey: string };
      this.typed.push(apiKey);
      if (apiKey.includes("refused"))
        throw new GatewayError({
          code: "INVALID_REQUEST",
          message: this.echoTyped ? `key ${apiKey} refused` : "key refused",
        });
      const id = `${provider}:manual`;
      if (!this.shared.some((p) => p.id === id))
        this.shared.push({ id, provider, type: "api_key" });
      return { provider, profileId: id };
    };
    g.handlers["models.authLogout"] = (params) => {
      const { profileIds } = params as { profileIds: string[] };
      this.shared = this.shared.filter((p) => !profileIds.includes(p.id));
      for (const bot of Object.keys(this.own))
        this.own[bot] = this.own[bot]!.filter((p) => !profileIds.includes(p.id));
      return { ok: true };
    };
  }

  /** A bot's refreshed view: shared accounts inherited, its own saved, its stored orders. */
  status(agentId: string): Json {
    const own = this.own[agentId] ?? [];
    const profiles = [
      ...this.shared.map((p) => ({ ...p, source: "inherited" })),
      ...own.map((p) => ({ ...p, source: "saved" })),
    ];
    const providers = ["acme", "globex"].map((provider) => {
      const order = this.orders[agentId]?.[provider];
      return {
        provider,
        displayName: provider,
        status: "static",
        profiles: profiles
          .filter((p) => p.provider === provider)
          .map((p) => ({
            profileId: p.id,
            type: p.type,
            status: p.type === "oauth" ? "ok" : "static",
            source: p.source,
            logoutSupported: true,
            ...(this.admin ? { displayName: this.label(p.id) } : {}),
          })),
        ...(order
          ? { profileOrder: order, profileOrderStored: true }
          : this.configuredOrders[provider]
            ? { profileOrder: this.configuredOrders[provider], profileOrderLocked: "auth-config" }
            : {}),
      };
    });
    return {
      ts: 1,
      providers,
      providerCapabilities: [
        {
          provider: "acme",
          apiKeySupported: true,
          loginOptions: [
            { id: CHOICES.device, label: "Acme", hint: "a link and a code", kind: "device-code" },
            {
              id: CHOICES.browser,
              label: "Acme in the browser",
              hint: "paste the code back",
              kind: "oauth",
            },
            { id: CHOICES.key, label: "Acme API key", hint: "billed per token", kind: "secret" },
          ],
        },
        { provider: "globex", apiKeySupported: true },
      ],
    };
  }

  private label(id: string): string | undefined {
    const profiles = (this.config.auth as Json).profiles as Record<string, Json>;
    return profiles[id]?.displayName as string | undefined;
  }

  /** Where a sign-in for `agentId` lands: shared for a `main` with no folder of its own. */
  private save(agentId: string, profile: Profile): void {
    const main = ((this.config.agents as Json).entries as Json).main as Json | undefined;
    if (agentId === "main" && main && !main.agentDir) this.shared.push(profile);
    else (this.own[agentId] ??= []).push(profile);
  }

  private async next(params: {
    sessionId: string;
    answer?: { stepId: string; value: unknown };
  }): Promise<Json> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new GatewayError({ code: "INVALID_REQUEST", message: "wizard not found" });
    if (params.answer) {
      session.answers.push(params.answer.value);
      this.typed.push(params.answer.value);
    }
    if (session.result) return session.result;
    const kind =
      session.choice === CHOICES.device
        ? "device"
        : session.choice === CHOICES.browser
          ? "browser"
          : "key";
    if (session.phase === "start") {
      if (kind === "device") {
        session.phase = "waiting";
        return {
          done: false,
          status: "running",
          step: {
            id: "code",
            type: "progress",
            executor: "gateway",
            externalUrl: "http://127.0.0.1:1/scripted/signin/device?code=QK4F-7PZD",
            deviceCode: { code: "QK4F-7PZD", expiresInMinutes: 15 },
          },
        };
      }
      session.phase = "entering";
      return {
        done: false,
        status: "running",
        step: {
          id: "paste",
          type: "text",
          sensitive: true,
          placeholder: kind === "browser" ? "Code or address" : "API key",
          ...(kind === "browser"
            ? { externalUrl: "http://127.0.0.1:1/scripted/signin/browser?state=s1" }
            : {}),
        },
      };
    }
    if (session.phase === "waiting") {
      // The gateway polls the provider: this answer waits for the person.
      const wait = deferred();
      session.release = wait.resolve;
      await wait.promise;
      session.release = null;
      if (session.result) return session.result;
      return this.end(session);
    }
    if (session.phase === "entering") {
      if (!params.answer)
        return {
          done: false,
          status: "running",
          step: { id: "paste", type: "text", sensitive: true },
        };
      return this.end(session);
    }
    if (session.phase === "note") {
      session.phase = "done";
      session.result = { done: true, status: "done" };
      return session.result;
    }
    return { done: true, status: "done" };
  }

  private end(session: Session): Json {
    const ending = session.ending;
    const typed = session.answers.at(-1);
    const type = session.choice === CHOICES.key ? "api_key" : "oauth";
    if (ending.outcome === "approve" || ending.outcome === "unconfirmed") {
      this.save(session.agentId, { id: `acme:${ending.account}`, provider: "acme", type });
      const orders = (this.orders[session.agentId] ??= {});
      if (orders.acme)
        orders.acme = [
          `acme:${ending.account}`,
          ...orders.acme.filter((id) => id !== `acme:${ending.account}`),
        ];
      if (ending.outcome === "unconfirmed") {
        session.phase = "done";
        session.result = {
          done: true,
          status: "error",
          error: "Saved the sign-in, but could not confirm it is active. Run the sign-in again.",
        };
        return session.result;
      }
      session.phase = "note";
      return {
        done: false,
        status: "running",
        step: { id: "note", type: "note", executor: "client", title: "Provider notes" },
      };
    }
    session.phase = "done";
    const echo = this.echoTyped && typeof typed === "string" ? ` (${typed})` : "";
    const error =
      ending.outcome === "refuse"
        ? `Acme refused the sign-in: the code was not accepted${echo}.`
        : ending.outcome === "expire"
          ? `Acme sign-in expired: The code expired before the sign-in finished${echo}.`
          : `${ending.message}${echo}`;
    session.result = { done: true, status: "error", error };
    return session.result;
  }

  /** The person approves or refuses on the provider's page. */
  answerDevice(sessionId?: string): void {
    const session = sessionId ? this.sessions.get(sessionId) : [...this.sessions.values()].at(-1);
    session?.release?.();
  }
}

/** A client on the accounts gateway, holding `scopes`, with the accounts read once. */
export async function accountsClient(
  options: { scopes?: readonly string[]; gateway?: AccountsGateway; adminHeld?: boolean } = {},
) {
  const fake = options.gateway ?? new AccountsGateway();
  const scopes = options.scopes ?? ADMIN_SCOPES;
  const storage = memoryStorage({
    connection: JSON.stringify({ url: URL_A, token: null, address: true }),
    [tokenKey(URL_A)]: JSON.stringify({
      token: "device-token",
      grantedScopes: scopes,
      heldScopes: scopes.filter((scope) => scope !== "operator.admin"),
      ...((options.adminHeld ?? scopes.includes("operator.admin")) ? { adminHeld: true } : {}),
    }),
  });
  const client = new ClawtrateClient(testHost(fake.gateway, storage), FAST);
  await client.start();
  await until(() => client.state.discovery.status === "ready");
  await client.refreshAccounts();
  return { client, fake, storage, accounts: () => client.state.accounts };
}
