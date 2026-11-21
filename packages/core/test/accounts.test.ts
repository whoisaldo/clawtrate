// The accounts engine (accounts.ts, accounts-engine.ts; bots.md sections 3 to
// 11): the accounts as each bot sees them, the three account states and the
// evidence for a lock, the strict setting and its report, each sign-in kind
// through each ending, the read after a sign-in, the bounds, and a typed key
// leaving no trace.

import { describe, expect, it } from "vitest";
import {
  ACCOUNTS,
  accountWord,
  enforceState,
  evaluateOrder,
  initialState,
  labelProblem,
  lockCommand,
  MAX_ACCOUNTS,
  MAX_SECRET_CHARS,
  parseModelRef,
  readBotView,
  retainedOrder,
  unlockCommand,
  unreadEvidence,
  withoutSecret,
  worstCase,
  type ClawtrateState,
} from "../src/index.ts";
import { createBridgeSession } from "../src/bridge.ts";
import { CLIENT_OWNERS } from "../src/owners.ts";
import { ClawtrateClient } from "../src/client.ts";
import { ADMIN_SCOPES, INTERACTIVE_SCOPES, READ_SCOPES } from "../src/scopes.ts";
import { AccountsGateway, accountsClient, CHOICES } from "./accounts-fake.ts";
import { FAST, URL_A } from "./client-harness.ts";
import {
  deferred,
  GatewayError,
  memoryStorage,
  testHost,
  tokenKey,
  until,
} from "./fake-gateway.ts";

const binding = (state: ClawtrateState["accounts"], botId: string) =>
  state.bindings.find((each) => each.botId === botId)!;

describe("the accounts as each bot sees them", () => {
  it("reads every bot's refreshed view, and tells shared accounts from those one bot keeps", async () => {
    const { client, fake, accounts } = await accountsClient();
    const views = fake.gateway.calls("models.authStatus") as Array<{
      agentId: string;
      refresh?: boolean;
    }>;
    // Sharing is decided only from refreshed answers (row 33).
    expect(views.every((each) => each.refresh === true)).toBe(true);
    expect(new Set(views.map((each) => each.agentId))).toEqual(new Set(["main", "otto", "pip"]));
    const byId = Object.fromEntries(accounts().accounts.map((a) => [a.id, a]));
    expect(byId["acme:work"]).toMatchObject({
      provider: "acme",
      label: "Work",
      keptBy: null,
      kind: "gateway",
    });
    expect(byId["acme:home"]).toMatchObject({ label: "Home", keptBy: null });
    expect(byId["acme:studio"]).toMatchObject({ label: "Studio", keptBy: "otto" });
    expect(accounts().labels).toBe(true);
    expect(accounts().mainShared).toBe(true);
    expect(accounts().defaultModel).toBe("acme/dev-1");
    expect(accounts().methods.map((m) => [m.id, m.flow, m.group])).toEqual([
      [CHOICES.device, "code", "subscription"],
      [CHOICES.browser, "paste", "subscription"],
      [CHOICES.key, "key", "subscription"],
    ]);
    expect(accounts().keyProviders).toEqual([
      { provider: "acme", hasKey: true, method: CHOICES.key },
      { provider: "globex", hasKey: false, method: null },
    ]);
    expect(accounts().models.find((m) => m.provider === "globex")).toMatchObject({
      available: false,
    });
    client.stop();
  });

  it("below admin the gateway sends no labels, so accounts are told apart by their ids", async () => {
    const { client, accounts } = await accountsClient({ scopes: INTERACTIVE_SCOPES });
    expect(accounts().labels).toBe(false);
    expect(accounts().accounts.map((a) => [a.id, a.label])).toEqual([
      ["acme:home", null],
      ["acme:studio", null],
      ["acme:work", null],
    ]);
    // Reads still work at the read tier: bindings and orders come with them.
    expect(binding(accounts(), "otto")).toMatchObject({ mode: "account", account: "acme:work" });
    client.stop();
  });

  it("with a single bot there is no second view, so its own accounts are kept by it", async () => {
    const fake = new AccountsGateway();
    fake.bots = [{ id: "otto", name: "Otto" }];
    const { client, accounts } = await accountsClient({ gateway: fake });
    expect(accounts().accounts.find((a) => a.id === "acme:studio")?.keptBy).toBe("otto");
    // No `main` bot: a sign-in cannot be shared, and that is known before it starts.
    expect(accounts().mainShared).toBe(false);
    client.stop();
  });

  it("an unrefreshed view that lists shared accounts as saved is never read", () => {
    // What the gateway's prepared view can say (row 33). The engine never asks for it.
    const view = readBotView({
      providers: [
        {
          provider: "acme",
          profiles: [{ profileId: "acme:work", source: "saved", type: "api_key" }],
        },
      ],
    });
    expect(view.profiles[0]!.source).toBe("saved");
  });
});

describe("a bot's account: bound, locked, and the gateway choosing", () => {
  it("reads each bot's binding from the gateway's config, with its account suffix", async () => {
    const { client, accounts } = await accountsClient();
    expect(binding(accounts(), "otto")).toMatchObject({
      primary: "acme/dev-1@acme:work",
      provider: "acme",
      model: "dev-1",
      account: "acme:work",
      mode: "account",
      fallbacks: [],
    });
    // A bot with no model of its own uses the gateway's default model.
    expect(binding(accounts(), "main")).toMatchObject({ mode: "default-model", account: null });
    expect(accountWord(binding(accounts(), "otto"))).toBe("bound");
    expect(accountWord(binding(accounts(), "main"))).toBe("default-model");
    client.stop();
  });

  it("is locked only for a stored one-account order naming the bound account, however it arose", async () => {
    const fake = new AccountsGateway();
    fake.orders.otto = { acme: ["acme:work"] };
    const { client, accounts } = await accountsClient({ gateway: fake });
    const otto = () => binding(accounts(), "otto");
    expect(otto().order).toEqual({ ids: ["acme:work"], stored: true, configured: null });
    expect(otto().evidence).toMatchObject({ status: "matched", lostAt: null });
    expect(otto().evidence.checkedAt).not.toBeNull();
    expect(otto().evidence.lastMatchAt).toBe(otto().evidence.checkedAt);
    expect(accountWord(otto())).toBe("locked");

    // The order now lists the bound account and another: not a lock, and the lock is gone.
    fake.orders.otto = { acme: ["acme:work", "acme:home"] };
    await client.checkLock("otto");
    expect(otto().evidence.status).toBe("multi");
    expect(otto().evidence.lostAt).not.toBeNull();
    expect(accountWord(otto())).toBe("bound");

    // Back to one account: locked again.
    fake.orders.otto = { acme: ["acme:work"] };
    await client.checkLock("otto");
    expect(accountWord(otto())).toBe("locked");
    expect(otto().evidence.lostAt).toBeNull();
    client.stop();
  });

  it("an order from the gateway's settings, not the bot's own store, is never a lock, even naming only the bound account", async () => {
    const fake = new AccountsGateway();
    fake.configuredOrders.acme = ["acme:work"];
    const { client, accounts } = await accountsClient({ gateway: fake });
    const otto = binding(accounts(), "otto");
    expect(otto.order).toEqual({ ids: ["acme:work"], stored: false, configured: "auth-config" });
    expect(otto.evidence.status).toBe("configured");
    expect(otto.evidence.lastMatchAt).toBeNull();
    expect(accountWord(otto)).toBe("bound");
    // The bot's own stored order then decides.
    fake.orders.otto = { acme: ["acme:work"] };
    await client.checkLock("otto");
    expect(accountWord(binding(accounts(), "otto"))).toBe("locked");
    client.stop();
  });

  it("an account only another bot can see is not this bot's: no account, never a lock", async () => {
    const fake = new AccountsGateway();
    (
      (fake.config.agents as Record<string, unknown>).entries as Record<
        string,
        Record<string, unknown>
      >
    ).pip!.model = {
      primary: "acme/dev-1@acme:studio",
      fallbacks: [],
    };
    fake.orders.pip = { acme: ["acme:studio"] };
    const { client, accounts } = await accountsClient({ gateway: fake });
    for (const read of ["the first read", "a check of the lock"]) {
      const pip = binding(accounts(), "pip");
      expect({
        read,
        missing: pip.accountMissing,
        word: accountWord(pip),
        status: pip.evidence.status,
      }).toEqual({
        read,
        missing: true,
        word: "no-account",
        status: "none",
      });
      await client.checkLock("pip");
    }
    // The account Otto keeps is listed, as Otto's: Pip's binding does not make it Pip's.
    expect(accounts().accounts.find((a) => a.id === "acme:studio")?.keptBy).toBe("otto");
    client.stop();
  });

  it("an answer that account status is unavailable is not an empty reading: the last good read stands", async () => {
    const fake = new AccountsGateway();
    fake.orders.otto = { acme: ["acme:work"] };
    const { client, accounts } = await accountsClient({ gateway: fake });
    const ids = accounts().accounts.map((a) => a.id);
    const confirmed = binding(accounts(), "otto").evidence.lastMatchAt;
    fake.unavailable = true;
    await client.refreshAccounts();
    expect(accounts()).toMatchObject({ status: "error" });
    expect(accounts().error).toMatch(/unavailable \(PREPARED_MODEL_AUTH_UNAVAILABLE\)/);
    expect(accounts().accounts.map((a) => a.id)).toEqual(ids);
    await client.checkLock("otto");
    const evidence = binding(accounts(), "otto").evidence;
    expect(evidence).toMatchObject({
      status: "unavailable",
      error: "PREPARED_MODEL_AUTH_UNAVAILABLE",
      lastMatchAt: confirmed,
    });
    // The last confirmation stands, as of its time; the page says the status is unavailable.
    expect(accountWord(binding(accounts(), "otto"))).toBe("locked");
    client.stop();
  });

  it("a read that fails keeps the last confirmation, with its time, and says the read failed", async () => {
    const fake = new AccountsGateway();
    fake.orders.otto = { acme: ["acme:work"] };
    const { client, accounts } = await accountsClient({ gateway: fake });
    const confirmed = binding(accounts(), "otto").evidence.lastMatchAt;
    fake.failStatusFor = "otto";
    await client.checkLock("otto");
    const evidence = binding(accounts(), "otto").evidence;
    expect(evidence.status).toBe("failed");
    expect(evidence.error).toMatch(/status unavailable/);
    expect(evidence.lastMatchAt).toBe(confirmed);
    expect(accountWord(binding(accounts(), "otto"))).toBe("locked");
    client.stop();
  });

  it("a one-account order naming another account of the provider is a lock out of date", () => {
    const evidence = evaluateOrder(
      unreadEvidence,
      { account: "acme:home", provider: "acme", mode: "account" },
      { ids: ["acme:work"], stored: true, configured: null },
      true,
      100,
    );
    expect(evidence.status).toBe("other");
    expect(
      accountWord({
        botId: "otto",
        primary: "acme/dev-1@acme:home",
        provider: "acme",
        model: "dev-1",
        account: "acme:home",
        mode: "account",
        fallbacks: [],
        suffixLost: false,
        accountMissing: false,
        effort: null,
        order: { ids: ["acme:work"], stored: true, configured: null },
        evidence,
        fallbacksUnwritten: false,
      }),
    ).toBe("stale");
  });

  it("an account no longer on the gateway is not a lock, whatever the order says", () => {
    const evidence = evaluateOrder(
      unreadEvidence,
      { account: "acme:gone", provider: "acme", mode: "account" },
      { ids: ["acme:gone"], stored: true, configured: null },
      false,
      100,
    );
    expect(evidence.status).not.toBe("matched");
  });

  it("reports a bot whose model lists fallbacks, and one whose account suffix went without Clawtrate", async () => {
    const fake = new AccountsGateway();
    // Clawtrate's own record says it set an account for otto; the gateway's model no longer names one.
    fake.prefs["clawtrate.bot-account.otto"] = { mode: "account", account: "acme:work" };
    (
      (fake.config.agents as Record<string, unknown>).entries as Record<
        string,
        Record<string, unknown>
      >
    ).otto!.model = {
      primary: "acme/dev-1",
      fallbacks: [],
    };
    const { client, accounts } = await accountsClient({ gateway: fake });
    expect(binding(accounts(), "pip").fallbacks).toEqual(["globex/dev-1"]);
    expect(binding(accounts(), "otto")).toMatchObject({ mode: "gateway", suffixLost: true });

    // "Remove fallbacks": the model keeps its account, the list becomes empty.
    await client.removeBotFallbacks("pip");
    const patch = fake.gateway.calls("config.patch").at(-1) as {
      raw: string;
      replacePaths: string[];
    };
    expect(JSON.parse(patch.raw)).toEqual({
      agents: { entries: { pip: { model: { fallbacks: [] } } } },
    });
    expect(patch.replacePaths).toEqual(["agents.entries.pip.model.fallbacks"]);
    expect(binding(accounts(), "pip")).toMatchObject({ fallbacks: [], account: "acme:home" });
    client.stop();
  });

  it("a bot set to let the gateway choose is that, not a difference, and a one-account order still stored is shown", async () => {
    const fake = new AccountsGateway();
    fake.prefs["clawtrate.bot-account.otto"] = { mode: "gateway" };
    fake.orders.otto = { acme: ["acme:work"] };
    const { client, accounts } = await accountsClient({ gateway: fake });
    await client.changeBotAccount("otto", null, "acme", "dev-1", null);
    const otto = binding(accounts(), "otto");
    expect(otto).toMatchObject({
      mode: "gateway",
      account: null,
      fallbacks: [],
      suffixLost: false,
    });
    expect(accountWord(otto)).toBe("gateway");
    // The order is never described as gone until a read shows it gone (row 36).
    expect(retainedOrder(otto)).toBe("acme:work");
    delete fake.orders.otto;
    await client.checkLock("otto");
    expect(retainedOrder(binding(accounts(), "otto"))).toBeNull();
    client.stop();
  });

  it("changing a locked bot to another account of its provider leaves the lock out of date", async () => {
    const fake = new AccountsGateway();
    fake.orders.otto = { acme: ["acme:work"] };
    const { client, accounts } = await accountsClient({ gateway: fake });
    expect(accountWord(binding(accounts(), "otto"))).toBe("locked");
    await client.changeBotAccount("otto", "acme:home", "acme", "dev-1", "high");
    const patch = fake.gateway.calls("config.patch").at(-1) as { raw: string };
    expect(JSON.parse(patch.raw)).toEqual({
      agents: {
        entries: {
          otto: {
            model: { primary: "acme/dev-1@acme:home", fallbacks: [] },
            thinkingDefault: "high",
          },
        },
      },
    });
    expect(accountWord(binding(accounts(), "otto"))).toBe("stale");
    expect(fake.prefs["clawtrate.bot-account.otto"]).toEqual({
      mode: "account",
      account: "acme:home",
    });
    client.stop();
  });

  it("builds the lock and unlock commands in the gateway's own form, with the host's prefix", () => {
    expect(lockCommand("openclaw", { botId: "marlow", provider: "openai" }, "openai:work")).toBe(
      "openclaw models auth order set --provider openai --agent marlow openai:work",
    );
    expect(unlockCommand("openclaw --profile clawtrate-dev-x", "marlow", "openai")).toBe(
      "openclaw --profile clawtrate-dev-x models auth order clear --provider openai --agent marlow",
    );
    expect(parseModelRef("acme/dev-1@acme:home")).toEqual({
      provider: "acme",
      model: "dev-1",
      account: "acme:home",
    });
    expect(parseModelRef("openrouter/openai/gpt-5@openrouter:default")).toEqual({
      provider: "openrouter",
      model: "openai/gpt-5",
      account: "openrouter:default",
    });
    expect(parseModelRef("acme/dev-1")).toEqual({
      provider: "acme",
      model: "dev-1",
      account: null,
    });
  });
});

describe("creating a bot", () => {
  it("on an account: the model with its suffix, an empty fallback list, and the bot read back", async () => {
    const { client, fake, accounts } = await accountsClient();
    const { botId } = await client.createBot({
      name: "Viral",
      avatar: "data:image/png;base64,iVBORw0KGgo=",
      account: "acme:home",
      provider: "acme",
      model: "dev-1",
      effort: "low",
    });
    expect(botId).toBe("viral");
    expect(fake.gateway.calls("agents.create")).toEqual([
      {
        name: "Viral",
        model: "acme/dev-1@acme:home",
        avatar: "data:image/png;base64,iVBORw0KGgo=",
      },
    ]);
    const patch = fake.gateway.calls("config.patch").at(-1) as {
      raw: string;
      replacePaths: string[];
    };
    expect(JSON.parse(patch.raw)).toEqual({
      agents: {
        entries: {
          viral: {
            model: { primary: "acme/dev-1@acme:home", fallbacks: [] },
            thinkingDefault: "low",
          },
        },
      },
    });
    expect(client.state.bots.map((b) => b.id)).toContain("viral");
    expect(accounts().creation).toMatchObject({ status: "created", botId: "viral" });
    expect(binding(accounts(), "viral")).toMatchObject({
      mode: "account",
      account: "acme:home",
      fallbacks: [],
    });
    client.stop();
  });

  it("with the gateway choosing: no account suffix and an empty fallback list", async () => {
    const { client, fake, accounts } = await accountsClient();
    await client.createBot({
      name: "",
      avatar: null,
      account: null,
      provider: "acme",
      model: "dev-1",
      effort: null,
    });
    expect(fake.gateway.calls("agents.create")).toEqual([{ name: "New bot", model: "acme/dev-1" }]);
    expect(binding(accounts(), "new-bot")).toMatchObject({
      mode: "gateway",
      account: null,
      fallbacks: [],
    });
    expect(accountWord(binding(accounts(), "new-bot"))).toBe("gateway");
    client.stop();
  });

  it("a create that got no answer is never sent twice: the bot list is read for the one it made", async () => {
    const { client, fake, accounts } = await accountsClient();
    // The gateway makes the bot, and the connection drops before its answer.
    fake.silentCreate = true;
    const original = fake.gateway.handlers["agents.create"]!;
    fake.gateway.handlers["agents.create"] = (params) => {
      const answer = original(params);
      setTimeout(() => fake.gateway.dropAll(), 10);
      return answer;
    };
    const { botId } = await client.createBot({
      name: "Viral",
      avatar: null,
      account: "acme:work",
      provider: "acme",
      model: "dev-1",
      effort: null,
    });
    expect(botId).toBe("viral");
    expect(fake.gateway.calls("agents.create")).toHaveLength(1);
    expect(accounts().creation?.status).toBe("created");
    client.stop();
  });

  it("a refused create fails and keeps nothing; a refused fallback write leaves the bot with the write to try again", async () => {
    const { client, fake, accounts } = await accountsClient();
    fake.gateway.handlers["agents.create"] = () => {
      throw new (class extends Error {})("refused");
    };
    await expect(
      client.createBot({
        name: "Viral",
        avatar: null,
        account: "acme:work",
        provider: "acme",
        model: "dev-1",
        effort: null,
      }),
    ).rejects.toThrow();
    expect(accounts().creation?.status).toBe("failed");

    const fresh = await accountsClient();
    fresh.fake.failPatch = "config is locked";
    await fresh.client.createBot({
      name: "Viral",
      avatar: null,
      account: "acme:work",
      provider: "acme",
      model: "dev-1",
      effort: null,
    });
    expect(binding(fresh.accounts(), "viral").fallbacksUnwritten).toBe(true);
    await fresh.client.removeBotFallbacks("viral");
    expect(binding(fresh.accounts(), "viral").fallbacksUnwritten).toBe(false);
    client.stop();
    fresh.client.stop();
  });
});

describe("a bot left half-made", () => {
  const input = {
    name: "Viral",
    avatar: null,
    account: "acme:work",
    provider: "acme",
    model: "dev-1",
    effort: null,
  } as const;

  it("Finish writes everything Create would have: the model with its empty fallback list and its effort", async () => {
    const { client, fake, accounts } = await accountsClient();
    fake.failPatch = "the gateway refused the patch";
    const made = await client.createBot({ ...input, effort: "high" });
    expect(made).toEqual({ botId: "viral", missing: ["fallbacks"] });
    expect(accounts().creation?.error).toMatch(
      /its model with an empty fallback list and its effort were not written/,
    );
    expect(await client.finishBot("viral")).toEqual({ botId: "viral", missing: [] });
    const entries = (fake.config.agents as { entries: Record<string, Record<string, unknown>> })
      .entries;
    expect(entries.viral).toMatchObject({
      model: { primary: "acme/dev-1@acme:work", fallbacks: [] },
      thinkingDefault: "high",
    });
    client.stop();
  });

  it("a record of the bot's account that is not saved leaves it partial, and Finish saves it", async () => {
    const { client, fake, accounts } = await accountsClient();
    const save = fake.gateway.handlers["users.prefs.set"]!;
    fake.gateway.handlers["users.prefs.set"] = () => {
      throw new GatewayError({ code: "UNAVAILABLE", message: "preferences unavailable" });
    };
    expect(await client.createBot({ ...input })).toEqual({
      botId: "viral",
      missing: ["preference"],
    });
    expect(accounts().creation).toMatchObject({ status: "partial", botId: "viral" });
    expect(fake.prefs["clawtrate.bot-account.viral"]).toBeUndefined();
    fake.gateway.handlers["users.prefs.set"] = save;
    expect(await client.finishBot("viral")).toEqual({ botId: "viral", missing: [] });
    expect(fake.prefs["clawtrate.bot-account.viral"]).toEqual({
      mode: "account",
      account: "acme:work",
    });
    client.stop();
  });

  it("a bot list that can't be read after the write is no proof it was created: partial until a read shows it", async () => {
    const { client, fake, accounts } = await accountsClient();
    const list = fake.gateway.handlers["agents.list"]!;
    fake.gateway.handlers["agents.list"] = () => {
      throw new GatewayError({ code: "UNAVAILABLE", message: "cannot list bots" });
    };
    const made = await client.createBot({ ...input });
    expect(made.missing).toContain("listed");
    expect(accounts().creation).toMatchObject({ status: "partial", botId: "viral" });
    expect(accounts().creation?.error).toMatch(/reading the gateway's bot list afterwards failed/);
    fake.gateway.handlers["agents.list"] = list;
    expect((await client.finishBot("viral")).missing).toEqual([]);
    expect(client.state.bots.some((bot) => bot.id === "viral")).toBe(true);
    expect(fake.gateway.calls("agents.create")).toHaveLength(1);
    client.stop();
  });

  it("a read of the bot list asked before a bot is made and answered after it does not hide the bot", async () => {
    const { client, fake } = await accountsClient();
    const list = fake.gateway.handlers["agents.list"]!;
    const held = deferred<void>();
    let asked = false;
    // The next read takes the list as it is now, and answers only when let go.
    fake.gateway.handlers["agents.list"] = async (params) => {
      fake.gateway.handlers["agents.list"] = list;
      asked = true;
      const before = list(params);
      await held.promise;
      return before;
    };
    const reread = client.retryNow();
    await until(() => asked);
    expect(await client.createBot({ ...input })).toEqual({ botId: "viral", missing: [] });
    expect(client.state.bots.some((bot) => bot.id === "viral")).toBe(true);
    held.resolve();
    await reread;
    expect(client.state.bots.some((bot) => bot.id === "viral")).toBe(true);
    client.stop();
  });

  it("an answer lost to a dropped connection is followed by a look that waits for a list read that succeeds", async () => {
    const { client, fake, accounts } = await accountsClient();
    const create = fake.gateway.handlers["agents.create"]!;
    const list = fake.gateway.handlers["agents.list"]!;
    let refused = 0;
    fake.gateway.handlers["agents.create"] = async (params) => {
      await create(params);
      // The gateway made it, and its answer is lost; the first reads of the list fail too.
      fake.gateway.handlers["agents.list"] = (listParams) => {
        if (refused < 2) {
          refused += 1;
          throw new GatewayError({ code: "UNAVAILABLE", message: "gateway restarting" });
        }
        return list(listParams);
      };
      throw new GatewayError({ code: "UNAVAILABLE", message: "gateway restarting" });
    };
    expect((await client.createBot({ ...input })).botId).toBe("viral");
    expect(refused).toBe(2);
    expect(accounts().creation).toMatchObject({ status: "created", botId: "viral" });
    expect(fake.gateway.calls("agents.create")).toHaveLength(1);
    client.stop();
  });

  it("after an answer in doubt, a retry adopts only a bot that was not there before: never an older one of that name", async () => {
    const { client, fake, accounts } = await accountsClient();
    const create = fake.gateway.handlers["agents.create"]!;
    fake.gateway.handlers["agents.create"] = () => {
      throw new GatewayError({ code: "UNAVAILABLE", message: "gateway restarting" });
    };
    // Otto existed before: a Create named Otto that got no answer cannot have made it.
    await expect(client.createBot({ ...input, name: "Otto" })).rejects.toThrow();
    expect(accounts().creation).toMatchObject({ status: "failed", uncertain: true });
    fake.gateway.handlers["agents.create"] = () => {
      throw new GatewayError({ code: "INVALID_REQUEST", message: "agent already exists" });
    };
    await expect(client.createBot({ ...input, name: "Otto" })).rejects.toThrow();
    expect(fake.gateway.calls("config.patch")).toHaveLength(0);
    expect(fake.gateway.calls("sessions.create")).toHaveLength(0);
    expect(fake.prefs["clawtrate.bot-account.otto"]).toBeUndefined();
    // One the first Create made, absent before it and present now, is the one it made.
    const list = fake.gateway.handlers["agents.list"]!;
    fake.gateway.handlers["agents.create"] = async (params) => {
      await create(params);
      // The gateway made it, its answer is lost, and its list doesn't show it yet.
      fake.gateway.handlers["agents.list"] = (listParams) => {
        const answer = list(listParams) as { agents: Array<{ id: string }> };
        return { ...answer, agents: answer.agents.filter((bot) => bot.id !== "viral") };
      };
      throw new GatewayError({ code: "UNAVAILABLE", message: "gateway restarting" });
    };
    await expect(client.createBot({ ...input })).rejects.toThrow();
    expect(accounts().creation).toMatchObject({ status: "failed", uncertain: true });
    fake.gateway.handlers["agents.list"] = list;
    fake.gateway.handlers["agents.create"] = create;
    expect((await client.createBot({ ...input })).botId).toBe("viral");
    expect(fake.gateway.calls("agents.create")).toHaveLength(3);
    client.stop();
  });

  it("a bot written whose first task fails is reported with what exists and what is missing, and is finished by its id", async () => {
    const { client, fake, accounts } = await accountsClient();
    fake.gateway.handlers["sessions.create"] = () => {
      throw new GatewayError({ code: "UNAVAILABLE", message: "Task write failed" });
    };
    expect(await client.createBot({ ...input })).toEqual({ botId: "viral", missing: ["task"] });
    expect(accounts().creation).toMatchObject({
      status: "partial",
      botId: "viral",
      missing: ["task"],
      error: "Viral was created, but its first task was not made: Task write failed.",
    });
    // Create is not offered again for it: it exists.
    await expect(client.createBot({ ...input })).rejects.toThrow(/exists already/);
    fake.gateway.handlers["sessions.create"] = () => ({ ok: true });
    expect(await client.finishBot("viral")).toEqual({ botId: "viral", missing: [] });
    expect(accounts().creation).toMatchObject({ status: "created", missing: [] });
    expect(fake.gateway.calls("agents.create")).toHaveLength(1);
    expect(fake.gateway.calls("sessions.create")).toEqual([
      { key: "agent:viral:main", agentId: "viral", label: "Main" },
      { key: "agent:viral:main", agentId: "viral", label: "Main" },
    ]);
    client.stop();
  });

  it("an answer that the bot was saved but not applied is followed by a look for it, never by Create again", async () => {
    const { client, fake, accounts } = await accountsClient();
    const create = fake.gateway.handlers["agents.create"]!;
    fake.gateway.handlers["agents.create"] = async (params) => {
      await create(params);
      throw new GatewayError({
        code: "UNAVAILABLE",
        message:
          "Agent configuration was saved but its application to the active Gateway was not confirmed",
      });
    };
    expect(await client.createBot({ ...input })).toEqual({ botId: "viral", missing: [] });
    expect(accounts().creation).toMatchObject({ status: "created", botId: "viral" });
    expect(fake.gateway.calls("agents.create")).toHaveLength(1);
    expect(binding(accounts(), "viral")).toMatchObject({ account: "acme:work", fallbacks: [] });
    client.stop();
  });

  it("an answer that settles nothing, with no bot found, fails; the next Create looks for the bot before asking again", async () => {
    const { client, fake, accounts } = await accountsClient();
    fake.gateway.handlers["agents.create"] = () => {
      throw new GatewayError({ code: "UNAVAILABLE", message: "gateway restarting" });
    };
    await expect(client.createBot({ ...input })).rejects.toThrow();
    expect(accounts().creation).toMatchObject({ status: "failed", uncertain: true });
    expect(accounts().creation?.error).toMatch(/did not say whether Viral was made/);
    // The gateway did make it, as it turns out.
    fake.bots.push({ id: "viral", name: "Viral" });
    expect(await client.createBot({ ...input })).toEqual({ botId: "viral", missing: [] });
    expect(fake.gateway.calls("agents.create")).toHaveLength(1);
    client.stop();
  });

  it("a refusal that establishes nothing was written fails at once, and is not uncertain", async () => {
    const { client, fake, accounts } = await accountsClient();
    fake.gateway.handlers["agents.create"] = () => {
      throw new GatewayError({ code: "INVALID_REQUEST", message: 'agent "viral" already exists' });
    };
    await expect(client.createBot({ ...input })).rejects.toThrow(/already exists/);
    expect(accounts().creation).toMatchObject({ status: "failed", uncertain: false });
    client.stop();
  });

  it("a bot Clawtrate set whose model has no fallback list is reported, also after a restart", async () => {
    const fake = new AccountsGateway();
    fake.prefs["clawtrate.bot-account.pip"] = { mode: "account", account: "acme:home" };
    (
      (fake.config.agents as Record<string, unknown>).entries as Record<
        string,
        Record<string, unknown>
      >
    ).pip!.model = "acme/dev-1@acme:home";
    const { client, accounts } = await accountsClient({ gateway: fake });
    expect(binding(accounts(), "pip")).toMatchObject({ fallbacks: null, fallbacksUnwritten: true });
    // A bot Clawtrate never set is not its to report.
    expect(binding(accounts(), "otto").fallbacksUnwritten).toBe(false);
    client.stop();
  });
});

describe("labels", () => {
  it("a label that reads like another's, differing only in spaces or case, is refused", () => {
    const others = [
      {
        id: "acme:home",
        provider: "acme",
        label: "My  plan",
        type: "oauth",
        status: "ok",
        expiresAt: null,
        kind: "subscription" as const,
        made: "sign-in" as const,
        keptBy: null,
        logoutSupported: true,
      },
    ];
    expect(labelProblem(others, "acme:work", "my plan")).toMatch(/Another Acme account/);
    expect(labelProblem(others, "acme:work", " MY   PLAN ")).toMatch(/Another Acme account/);
    expect(labelProblem(others, "acme:work", "My plans")).toBeNull();
  });
});

describe("how an account was made", () => {
  it("a record that says only key says nothing of where it was entered: it is read as not known", async () => {
    const fake = new AccountsGateway();
    fake.prefs["clawtrate.account-kind.acme:work"] = "key";
    const { client, accounts } = await accountsClient({ gateway: fake });
    expect(accounts().accounts.find((a) => a.id === "acme:work")).toMatchObject({
      kind: "key",
      made: null,
    });
    client.stop();
  });

  it("tells a key typed into Clawtrate from a key a browser sign-in saved", async () => {
    const fake = new AccountsGateway();
    fake.prefs["clawtrate.account-kind.acme:work"] = "typed-key";
    fake.prefs["clawtrate.account-kind.acme:home"] = "sign-in-key";
    const { client, accounts } = await accountsClient({ gateway: fake });
    try {
      const find = (id: string) => accounts().accounts.find((a) => a.id === id);
      expect(find("acme:work")).toMatchObject({ kind: "key", made: "typed" });
      expect(find("acme:home")).toMatchObject({ kind: "key", made: "sign-in" });
      // An account Clawtrate has no record of was added on the gateway.
      expect(find("globex:team") ?? find("acme:studio")).toMatchObject({
        kind: "gateway",
        made: null,
      });
    } finally {
      client.stop();
    }
  });
});

describe("sign-ins, through the gateway's own methods", () => {
  it("a link and a code: starting, waiting with the code and the link, connected, and where it landed", async () => {
    const fake = new AccountsGateway();
    fake.orders.otto = { acme: ["acme:work"] };
    const { client, accounts } = await accountsClient({ gateway: fake });
    const started = client.startSignIn(CHOICES.device, "pip");
    expect(accounts().signIn).toMatchObject({
      stage: "starting",
      forBot: "main",
      keptOnly: false,
      flow: "code",
    });
    await started;
    expect(accounts().signIn).toMatchObject({
      stage: "waiting",
      step: {
        code: "QK4F-7PZD",
        expiresInMinutes: 15,
        url: "http://127.0.0.1:1/scripted/signin/device?code=QK4F-7PZD",
      },
    });
    const login = fake.gateway.calls("models.authLogin")[0] as {
      agentId: string;
      authChoice: string;
    };
    expect(login).toMatchObject({ agentId: "main", authChoice: CHOICES.device });
    fake.answerDevice();
    await until(() => accounts().signIn?.stage === "connected");
    // The read after it: the target's view and another bot's, refreshed.
    expect(accounts().signIn?.result).toMatchObject({
      added: ["acme:travel"],
      landed: "shared",
      keptBy: null,
      readFailed: false,
    });
    // Otto's lock was checked after the sign-in.
    expect(accounts().signIn?.result?.locks).toEqual([
      { botId: "otto", account: "acme:work", outcome: "kept" },
    ]);
    expect(fake.prefs["clawtrate.account-kind.acme:travel"]).toBe("subscription");
    expect(accounts().accounts.find((a) => a.id === "acme:travel")).toMatchObject({
      kind: "subscription",
      made: "sign-in",
      keptBy: null,
    });
    client.stop();
  });

  it("a sign-in that adds the new account to a locked bot's order says the lock widened", async () => {
    const fake = new AccountsGateway();
    fake.orders.main = { acme: ["acme:work"] };
    (
      (fake.config.agents as Record<string, unknown>).entries as Record<
        string,
        Record<string, unknown>
      >
    ).main!.model = {
      primary: "acme/dev-1@acme:work",
      fallbacks: [],
    };
    const { client, accounts } = await accountsClient({ gateway: fake });
    expect(accountWord(binding(accounts(), "main"))).toBe("locked");
    await client.startSignIn(CHOICES.device, null);
    fake.answerDevice();
    await until(() => accounts().signIn?.stage === "connected");
    expect(accounts().signIn?.result?.locks).toEqual([
      { botId: "main", account: "acme:work", outcome: "widened" },
    ]);
    client.stop();
  });

  it("a lock check that fails after a sign-in is unchecked: it never says the lock widened", async () => {
    const fake = new AccountsGateway();
    fake.orders.pip = { acme: ["acme:home"] };
    const { client, accounts } = await accountsClient({ gateway: fake });
    expect(accountWord(binding(accounts(), "pip"))).toBe("locked");
    await client.startSignIn(CHOICES.device, null);
    // The read after the sign-in reads main and one other bot; only Pip's own check fails.
    fake.failStatusFor = "pip";
    fake.answerDevice();
    await until(() => accounts().signIn?.stage === "connected");
    expect(accounts().signIn?.result?.locks).toEqual([
      { botId: "pip", account: "acme:home", outcome: "unchecked" },
    ]);
    client.stop();
  });

  for (const [outcome, stage] of [
    ["refuse", "failed"],
    ["expire", "expired"],
  ] as const) {
    it(`a link and a code that ends ${stage}: the gateway's words, and a read of what it now has`, async () => {
      const fake = new AccountsGateway();
      fake.nextEnding = { outcome };
      const { client, accounts } = await accountsClient({ gateway: fake });
      await client.startSignIn(CHOICES.device, null);
      fake.answerDevice();
      await until(
        () => accounts().signIn?.result !== null && accounts().signIn?.result !== undefined,
      );
      expect(accounts().signIn).toMatchObject({ stage });
      expect(accounts().signIn?.error).toMatch(outcome === "refuse" ? /refused/ : /expired/);
      expect(accounts().signIn?.result).toMatchObject({ added: [], readFailed: false });
      client.stop();
    });
  }

  it("cancelled: wizard.cancel, then what the gateway now has", async () => {
    const { client, fake, accounts } = await accountsClient();
    await client.startSignIn(CHOICES.device, null);
    await client.cancelSignIn();
    expect(fake.gateway.calls("wizard.cancel")).toHaveLength(1);
    await until(() => accounts().signIn?.result !== null);
    expect(accounts().signIn).toMatchObject({ stage: "cancelled", result: { added: [] } });
    client.stop();
  });

  it("a sign-in whose read afterwards fails is not called connected: it is unverified until a read shows the account", async () => {
    const { client, fake, accounts } = await accountsClient();
    await client.startSignIn(CHOICES.device, null);
    fake.failStatusFor = "main";
    fake.answerDevice();
    await until(() => accounts().signIn?.result != null);
    expect(accounts().signIn).toMatchObject({
      stage: "unverified",
      result: { readFailed: true, added: [] },
    });
    // Read again, now that the gateway answers: the account is there.
    fake.failStatusFor = null;
    await client.recheckSignIn();
    expect(accounts().signIn).toMatchObject({
      stage: "connected",
      result: { readFailed: false, added: ["acme:travel"], landed: "shared" },
    });
    client.stop();
  });

  it("a sign-in that finishes with no new account is refreshed, not connected", async () => {
    const fake = new AccountsGateway();
    fake.nextEnding = { outcome: "approve", account: "work" };
    const { client, accounts } = await accountsClient({ gateway: fake });
    await client.startSignIn(CHOICES.device, null);
    fake.answerDevice();
    await until(() => accounts().signIn?.result != null);
    expect(accounts().signIn).toMatchObject({ stage: "refreshed", result: { added: [] } });
    client.stop();
  });

  it("a cancel the gateway does not confirm is reported as unknown, never as cancelled or saving; the accounts are read again and the sign-in is kept", async () => {
    const { client, fake, accounts } = await accountsClient();
    await client.startSignIn(CHOICES.device, null);
    fake.gateway.handlers["wizard.cancel"] = () => {
      throw new GatewayError({ code: "UNAVAILABLE", message: "Cancel status unavailable" });
    };
    const reads = fake.gateway.calls("models.authStatus").length;
    expect(await client.cancelSignIn()).toEqual({ cancelled: false });
    expect(accounts().signIn).toMatchObject({
      stage: "waiting",
      saving: false,
      cancelUnknown: true,
      error: "Cancel status unavailable",
    });
    await until(() => fake.gateway.calls("models.authStatus").length > reads);
    // Letting it go would hide a sign-in that may still be running on the gateway.
    expect(await client.dismissSignIn()).toEqual({ dismissed: false });
    expect(accounts().signIn?.stage).toBe("waiting");
    client.stop();
  });

  it("a cancel refused for any reason but saving is unknown: never saving, and the accounts are read again", async () => {
    const { client, fake, accounts } = await accountsClient();
    await client.startSignIn(CHOICES.browser, null);
    fake.gateway.handlers["wizard.cancel"] = () => {
      throw new GatewayError({ code: "INVALID_REQUEST", message: "Cannot cancel: too late" });
    };
    const reads = fake.gateway.calls("models.authStatus").length;
    expect(await client.cancelSignIn()).toEqual({ cancelled: false });
    expect(accounts().signIn).toMatchObject({ cancelUnknown: true, saving: false });
    await until(() => fake.gateway.calls("models.authStatus").length > reads);
    client.stop();
  });

  it("two new accounts after a sign-in that names neither: both are named, and the person's choice is its account", async () => {
    const { client, fake, accounts } = await accountsClient();
    const next = fake.gateway.handlers["wizard.next"]!;
    fake.gateway.handlers["wizard.next"] = (params) => {
      if (!(params as { answer?: unknown }).answer) return next(params);
      fake.shared.push(
        { id: "acme:elsewhere", provider: "acme", type: "oauth" },
        { id: "acme:mine", provider: "acme", type: "oauth" },
      );
      return { done: true, status: "done" };
    };
    await client.startSignIn(CHOICES.browser, null);
    await client.answerSignIn("made-up-code-several");
    expect(accounts().signIn).toMatchObject({
      stage: "several",
      result: { added: ["acme:elsewhere", "acme:mine"] },
    });
    // Nothing is recorded of either until the person says which is theirs.
    expect(Object.keys(fake.prefs).filter((key) => key.includes("acme:elsewhere"))).toEqual([]);
    await client.chooseSignInAccount("acme:mine");
    expect(accounts().signIn).toMatchObject({
      stage: "connected",
      result: { added: ["acme:mine"], landed: "shared" },
    });
    expect(fake.prefs["clawtrate.account-kind.acme:mine"]).toBeDefined();
    expect(fake.prefs["clawtrate.account-kind.acme:elsewhere"]).toBeUndefined();
    await expect(client.chooseSignInAccount("acme:work")).rejects.toThrow();
    client.stop();
  });

  it("a key saved directly whose read afterwards fails is not called saved, and names no account", async () => {
    const { client, fake, accounts } = await accountsClient();
    fake.gateway.handlers["models.authSetApiKey"] = () => ({ profileId: "globex:direct" });
    fake.failStatusFor = "main";
    expect(await client.saveApiKey("globex", "made-up-key-direct-0001", null)).toEqual({
      profileId: null,
    });
    expect(accounts().write).toMatchObject({ what: "key", status: "unverified" });
    expect(accounts().write?.error).toMatch(/reading its accounts afterwards failed/);
    expect(fake.prefs["clawtrate.account-kind.globex:direct"]).toBeUndefined();
    client.stop();
  });

  it("too late to cancel: the gateway refuses because it is saving", async () => {
    const { client, fake, accounts } = await accountsClient();
    await client.startSignIn(CHOICES.device, null);
    fake.refuseCancel = true;
    await client.cancelSignIn();
    expect(accounts().signIn).toMatchObject({ stage: "waiting", saving: true });
    fake.answerDevice();
    await until(() => accounts().signIn?.stage === "connected");
    client.stop();
  });

  it("saved, not confirmed: the gateway saved it and said it could not confirm; the account is read", async () => {
    const fake = new AccountsGateway();
    fake.nextEnding = { outcome: "unconfirmed", account: "spare" };
    const { client, accounts } = await accountsClient({ gateway: fake });
    await client.startSignIn(CHOICES.device, null);
    fake.answerDevice();
    await until(() => accounts().signIn?.result != null);
    expect(accounts().signIn).toMatchObject({
      stage: "unconfirmed",
      result: { added: ["acme:spare"] },
    });
    expect(accounts().signIn?.error).toMatch(/could not confirm/);
    client.stop();
  });

  it("the gateway is busy: it runs one sign-in at a time", async () => {
    const { client, fake, accounts } = await accountsClient();
    fake.sessions.set("other", {
      id: "other",
      choice: CHOICES.device,
      agentId: "main",
      phase: "waiting",
      ending: { outcome: "refuse" },
      release: null,
      result: null,
      answers: [],
    });
    await client.startSignIn(CHOICES.device, null);
    expect(accounts().signIn).toMatchObject({ stage: "busy" });
    expect(accounts().signIn?.error).toMatch(/already in progress/);
    client.stop();
  });

  it("the connection dropped: the sign-in ended with it, and the accounts are read after the reconnect", async () => {
    const { client, fake, accounts } = await accountsClient();
    await client.startSignIn(CHOICES.device, null);
    expect(accounts().signIn?.stage).toBe("waiting");
    fake.gateway.dropAll();
    await until(() => accounts().signIn?.stage === "ended");
    await until(() => client.state.connection.status === "connected");
    await until(() => accounts().signIn?.result !== null);
    expect(accounts().signIn?.result).toMatchObject({ added: [] });
    client.stop();
  });

  it("known beforehand that it can't be shared: no main bot with its own store, so it is started for the bot worked on", async () => {
    const fake = new AccountsGateway();
    (
      (fake.config.agents as Record<string, unknown>).entries as Record<
        string,
        Record<string, unknown>
      >
    ).main!.agentDir = "/s/agents/main/own";
    const { client, accounts } = await accountsClient({ gateway: fake });
    expect(accounts().mainShared).toBe(false);
    await client.startSignIn(CHOICES.device, "pip");
    expect(accounts().signIn).toMatchObject({ forBot: "pip", keptOnly: true });
    fake.answerDevice();
    await until(() => accounts().signIn?.stage === "connected");
    expect(accounts().signIn?.result).toMatchObject({
      added: ["acme:travel"],
      landed: "kept",
      keptBy: "pip",
    });
    expect(accounts().accounts.find((a) => a.id === "acme:travel")?.keptBy).toBe("pip");
    client.stop();
  });

  it("in the browser, the code pasted back: sent once in the next step and kept nowhere", async () => {
    const { client, fake, accounts } = await accountsClient();
    await client.startSignIn(CHOICES.browser, null);
    expect(accounts().signIn).toMatchObject({
      stage: "entering",
      step: {
        sensitive: true,
        placeholder: "Code or address",
        url: "http://127.0.0.1:1/scripted/signin/browser?state=s1",
      },
    });
    const code = "one-time-code-7Q2Z";
    await client.answerSignIn(code);
    await until(() => accounts().signIn?.stage === "connected");
    expect(fake.typed).toContain(code);
    expect(JSON.stringify(client.state)).not.toContain(code);
    client.stop();
  });

  it("a choice the gateway asks that Clawtrate does not offer ends the sign-in rather than guessing", async () => {
    const { client, fake, accounts } = await accountsClient();
    fake.gateway.handlers["wizard.next"] = () => ({
      done: false,
      status: "running",
      step: { id: "s", type: "select", options: [] },
    });
    await client.startSignIn(CHOICES.device, null);
    await until(() => accounts().signIn?.result != null);
    expect(accounts().signIn?.stage).toBe("failed");
    expect(fake.gateway.calls("wizard.cancel")).toHaveLength(1);
    client.stop();
  });
});

/** Every string reachable from `root` through own properties, maps, sets and arrays. */
function reachable(root: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 40) return;
    if (typeof value === "string") return void out.push(value);
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (value instanceof Map)
      for (const [k, v] of value) {
        visit(k, depth + 1);
        visit(v, depth + 1);
      }
    else if (value instanceof Set || Array.isArray(value))
      for (const v of value) visit(v, depth + 1);
    else
      for (const key of Reflect.ownKeys(value))
        visit((value as Record<string | symbol, unknown>)[key], depth + 1);
  };
  visit(root, 0);
  return out;
}

describe("a typed API key leaves no trace", () => {
  const KEY = "clawtrate-dev-key.acme.made-up-0042";

  async function traceless(
    client: ClawtrateClient,
    storage: { data: Map<string, string> },
    logs: string[],
    key: string,
  ) {
    // The state, what a viewer's snapshot carries, everything the host stores and logs,
    // and every string the client object holds in any field or collection.
    expect(JSON.stringify(client.state)).not.toContain(key);
    expect(JSON.stringify([...storage.data.entries()])).not.toContain(key);
    expect(logs.join("\n")).not.toContain(key);
    expect(reachable(client).some((text) => text.includes(key))).toBe(false);
  }

  async function keyClient(fake = new AccountsGateway()) {
    const logs: string[] = [];
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: null, address: true }),
      [tokenKey(URL_A)]: JSON.stringify({
        token: "device-token",
        grantedScopes: ADMIN_SCOPES,
        heldScopes: INTERACTIVE_SCOPES,
        adminHeld: true,
      }),
    });
    const host = {
      ...testHost(fake.gateway, storage),
      log: (_level: string, message: string) => void logs.push(message),
    };
    const client = new ClawtrateClient(host, FAST);
    await client.start();
    await until(() => client.state.discovery.status === "ready");
    await client.refreshAccounts();
    return { client, storage, logs, fake };
  }

  it("through the provider's key sign-in: saved, sent once, and absent afterwards", async () => {
    const { client, storage, logs, fake } = await keyClient();
    const { profileId } = await client.saveApiKey("acme", KEY, null);
    expect(profileId).toBe("acme:travel");
    expect(fake.typed.filter((value) => value === KEY)).toHaveLength(1);
    expect(client.state.accounts.signIn).toMatchObject({ stage: "connected", byKey: true });
    expect(fake.prefs["clawtrate.account-kind.acme:travel"]).toBe("typed-key");
    await traceless(client, storage, logs, KEY);
    client.stop();
  });

  it("through the provider's key sign-in, refused by a gateway that echoes it: absent from the error and everywhere", async () => {
    const fake = new AccountsGateway();
    fake.nextEnding = { outcome: "refuse" };
    fake.echoTyped = true;
    const { client, storage, logs } = await keyClient(fake);
    await client.saveApiKey("acme", KEY, null);
    expect(client.state.accounts.signIn?.stage).toBe("failed");
    expect(client.state.accounts.signIn?.error).toMatch(/refused/);
    await traceless(client, storage, logs, KEY);
    client.stop();
  });

  it("through models.authSetApiKey: saved, and absent afterwards; refused with an echo, absent from the error", async () => {
    const { client, storage, logs, fake } = await keyClient();
    const { profileId } = await client.saveApiKey("globex", KEY, null);
    expect(profileId).toBe("globex:manual");
    await traceless(client, storage, logs, KEY);

    fake.echoTyped = true;
    const refused = `${KEY}-refused`;
    const error = await client
      .saveApiKey("globex", refused, null)
      .catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/refused/);
    expect((error as Error).message).not.toContain(refused);
    await traceless(client, storage, logs, refused);
    await traceless(client, storage, logs, KEY);
    client.stop();
  });

  it("through the bridge, as a viewer sends it: the command's answer and every snapshot carry none of it", async () => {
    const { client, storage, logs } = await keyClient();
    const viewer = createBridgeSession(client);
    const snapshots: string[] = [];
    const stop = client.store.subscribe((state) => void snapshots.push(JSON.stringify(state)));
    const answer = await viewer.apply({
      type: "saveApiKey",
      provider: "globex",
      key: KEY,
      botId: null,
    });
    stop();
    expect(JSON.stringify(answer)).not.toContain(KEY);
    expect(snapshots.join("")).not.toContain(KEY);
    await traceless(client, storage, logs, KEY);
    viewer.dispose();
    client.stop();
  });

  /** The engine's own copy of what was typed, which must be gone once the sign-in has ended. */
  const held = (client: ClawtrateClient) =>
    (client as unknown as { accounts: { secrets: string[] } }).accounts.secrets;

  it("a later step that echoes a pasted code, in its message or title, shows it to nobody", async () => {
    const { client, storage, logs, fake } = await keyClient();
    const code = "one-time-code-echoed-9Z";
    const next = fake.gateway.handlers["wizard.next"]!;
    fake.gateway.handlers["wizard.next"] = (params) => {
      const { answer } = params as { answer?: { value: string } };
      return answer
        ? {
            done: false,
            status: "running",
            step: {
              id: `retry-${answer.value}`,
              type: "text",
              sensitive: true,
              title: `Code ${answer.value} was not accepted`,
              message: `Code rejected: ${answer.value.trim()}`,
              placeholder: answer.value,
            },
          }
        : next(params);
    };
    await client.startSignIn(CHOICES.browser, null);
    await client.answerSignIn(` ${code} `);
    // Still under way, waiting for another answer: the step is shown, without the code.
    expect(client.state.accounts.signIn).toMatchObject({ stage: "entering" });
    expect(client.state.accounts.signIn?.step?.title).toBe("Code … was not accepted");
    expect(JSON.stringify(client.state)).not.toContain(code);
    // Once the sign-in ends, nothing of it is held.
    await client.dismissSignIn();
    expect(held(client)).toEqual([]);
    await traceless(client, storage, logs, code);
  });

  it("a key echoed by a later step of the key sign-in is shown to nobody, and forgotten when it ends", async () => {
    const { client, storage, logs, fake } = await keyClient();
    const next = fake.gateway.handlers["wizard.next"]!;
    fake.gateway.handlers["wizard.next"] = (params) => {
      const { answer } = params as { answer?: { value: unknown } };
      return answer && typeof answer.value === "string"
        ? {
            done: false,
            status: "running",
            step: {
              id: "again",
              type: "text",
              sensitive: true,
              title: `Key rejected: ${answer.value}`,
            },
          }
        : next(params);
    };
    await client.saveApiKey("acme", KEY, null);
    expect(client.state.accounts.signIn?.step?.title).toBe("Key rejected: …");
    expect(JSON.stringify(client.state)).not.toContain(KEY);
    await client.dismissSignIn();
    expect(held(client)).toEqual([]);
    await traceless(client, storage, logs, KEY);
  });

  it("a failure in the middle that echoes a pasted address's code, decoded, shows none of it", async () => {
    const { client, storage, logs, fake } = await keyClient();
    const address = "http://127.0.0.1:1/callback?code=abc%2Fdef-4417&state=s1";
    const decoded = "abc/def-4417";
    const next = fake.gateway.handlers["wizard.next"]!;
    fake.gateway.handlers["wizard.next"] = (params) => {
      if ((params as { answer?: unknown }).answer)
        throw new GatewayError({
          code: "UNAVAILABLE",
          message: `The provider refused code ${decoded}.`,
        });
      return next(params);
    };
    await client.startSignIn(CHOICES.browser, null);
    await client.answerSignIn(address);
    await until(() => client.state.accounts.signIn?.result != null);
    expect(client.state.accounts.signIn).toMatchObject({
      stage: "failed",
      error: "The provider refused code ….",
    });
    expect(held(client)).toEqual([]);
    for (const form of [address, decoded, "abc%2Fdef-4417"])
      await traceless(client, storage, logs, form);
  });

  it("a pasted address with many query values is held whole first: its pieces never push it out", async () => {
    const { client, storage, logs, fake } = await keyClient();
    const fields = Array.from({ length: 12 }, (_, i) => `f${i}=made-up-value-${i}`).join("&");
    const address = `http://127.0.0.1:1/scripted/back?code=made-up-code-77&${fields}`;
    const next = fake.gateway.handlers["wizard.next"]!;
    fake.gateway.handlers["wizard.next"] = (params) => {
      const { answer } = params as { answer?: { value: string } };
      return answer
        ? {
            done: false,
            status: "running",
            step: { id: "again", type: "text", message: `Got ${answer.value}` },
          }
        : next(params);
    };
    await client.startSignIn(CHOICES.browser, null);
    await client.answerSignIn(address);
    const shown = client.state.accounts.signIn?.step?.message ?? "";
    expect(shown).not.toContain(address);
    expect(shown).not.toContain("made-up-code-77");
    await client.dismissSignIn();
    await traceless(client, storage, logs, address);
  });

  it("the read after a sign-in that fails echoing the pasted code puts none of it in the accounts' error", async () => {
    const { client, fake } = await keyClient();
    const code = "made-up-code-read-after";
    const next = fake.gateway.handlers["wizard.next"]!;
    fake.gateway.handlers["wizard.next"] = (params) => {
      const { answer } = params as { answer?: { value: string } };
      if (!answer) return next(params);
      fake.gateway.handlers["models.authStatus"] = () => {
        throw new GatewayError({
          code: "UNAVAILABLE",
          message: `could not read after ${answer.value}`,
        });
      };
      return { done: true, status: "done" };
    };
    await client.startSignIn(CHOICES.browser, null);
    await client.answerSignIn(code);
    await until(() => client.state.accounts.status === "error");
    expect(client.state.accounts.signIn?.stage).toBe("unverified");
    expect(client.state.accounts.error).toContain("could not read after");
    expect(JSON.stringify(client.state)).not.toContain(code);
  });

  it("a key saved directly holds the key while it lasts: an echoing preference write logs none of it", async () => {
    const { client, storage, logs, fake } = await keyClient();
    const key = "clawtrate-dev-key.globex.made-up-direct";
    fake.gateway.handlers["models.authSetApiKey"] = () => {
      fake.shared.push({ id: "globex:direct", provider: "globex", type: "api_key" });
      return { profileId: "globex:direct" };
    };
    fake.gateway.handlers["users.prefs.set"] = () => {
      throw new GatewayError({ code: "UNAVAILABLE", message: `cannot store ${key}` });
    };
    await client.saveApiKey("globex", key, null);
    expect(logs.some((line) => line.startsWith("could not record an account's kind"))).toBe(true);
    await traceless(client, storage, logs, key);
  });

  it("the safety stop after 64 steps ends the sign-in as failed, says so, and forgets what it was given", async () => {
    const { client, storage, logs, fake } = await keyClient();
    const code = "made-up-code-endless";
    const next = fake.gateway.handlers["wizard.next"]!;
    let answered = false;
    fake.gateway.handlers["wizard.next"] = (params) => {
      answered ||= (params as { answer?: { value: unknown } }).answer?.value === code;
      return answered
        ? { done: false, status: "running", step: { id: "note", type: "note", message: "Noted" } }
        : next(params);
    };
    await client.startSignIn(CHOICES.browser, null);
    await client.answerSignIn(code);
    await until(() => client.state.accounts.signIn?.stage === "failed");
    expect(client.state.accounts.signIn?.error).toMatch(/64 steps/);
    expect(fake.gateway.calls("wizard.cancel")).toHaveLength(1);
    await traceless(client, storage, logs, code);
  });

  it("a log line that echoes the typed key while the sign-in lasts carries none of it", async () => {
    const { client, storage, logs, fake } = await keyClient();
    // The record of how the account was made is written before the sign-in ends; its error echoes the key.
    fake.gateway.handlers["users.prefs.set"] = () => {
      throw new GatewayError({
        code: "UNAVAILABLE",
        message: `cannot store ${String(fake.typed.filter((value) => typeof value === "string").at(-1))}`,
      });
    };
    await client.saveApiKey("acme", KEY, null);
    expect(logs.some((line) => line.startsWith("could not record an account's kind"))).toBe(true);
    await traceless(client, storage, logs, KEY);
  });

  it("withoutSecret takes a key out of anything the gateway answers", () => {
    expect(withoutSecret(`bad key ${KEY} here`, KEY)).toBe("bad key … here");
    expect(withoutSecret(`bad key ${KEY}`, ` ${KEY} `)).toBe("bad key …");
  });
});

describe("labels", () => {
  it("are written as the gateway's display name, and refused when another account of the provider has one", async () => {
    const { client, fake, accounts } = await accountsClient();
    await expect(client.setAccountLabel("acme:home", "work")).rejects.toThrow(
      /Another Acme account is called Work/,
    );
    expect(labelProblem(accounts().accounts, "acme:home", "  ")).toMatch(/another Acme account/);
    await client.setAccountLabel("acme:home", "  Studio  Two ");
    const patch = fake.gateway.calls("config.patch").at(-1) as { raw: string };
    expect(JSON.parse(patch.raw)).toEqual({
      auth: { profiles: { "acme:home": { displayName: "Studio Two" } } },
    });
    expect(accounts().accounts.find((a) => a.id === "acme:home")?.label).toBe("Studio Two");
    client.stop();
  });

  it("a profile the config does not list gets its provider and mode with the label", async () => {
    const { client, fake } = await accountsClient();
    await client.startSignIn(CHOICES.device, null);
    fake.answerDevice();
    await until(() => client.state.accounts.signIn?.stage === "connected");
    await client.setAccountLabel("acme:travel", "Travel");
    const patch = fake.gateway.calls("config.patch").at(-1) as { raw: string };
    expect(JSON.parse(patch.raw)).toEqual({
      auth: {
        profiles: { "acme:travel": { displayName: "Travel", provider: "acme", mode: "oauth" } },
      },
    });
    client.stop();
  });
});

describe("admin access", () => {
  it("is asked for only when the person asks, through the same request, and held once granted", async () => {
    const fake = new AccountsGateway();
    const wait = deferred<unknown>();
    fake.gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-9" });
    fake.gateway.handlers["device.scopes.waitUpgrade"] = () => wait.promise;
    const { client, storage, accounts } = await accountsClient({
      gateway: fake,
      scopes: INTERACTIVE_SCOPES,
    });
    expect(fake.gateway.calls("device.scopes.requestUpgrade")).toEqual([]);
    // A write below admin is refused before anything is sent.
    await expect(
      client.createBot({
        name: "Viral",
        avatar: null,
        account: "acme:work",
        provider: "acme",
        model: "dev-1",
        effort: null,
      }),
    ).rejects.toThrow(/needs admin access/);
    expect(fake.gateway.calls("agents.create")).toEqual([]);
    expect(accounts().accounts.length).toBeGreaterThan(0);

    await client.requestAccess("admin");
    await until(() => client.state.connection.upgrade.status === "pending");
    expect(fake.gateway.calls("device.scopes.requestUpgrade")).toEqual([
      { scopes: [...ADMIN_SCOPES] },
    ]);
    expect(client.state.connection.upgrade.scopes).toEqual([...ADMIN_SCOPES]);
    wait.resolve({
      status: "approved",
      requestId: "up-9",
      deviceToken: "rotated",
      scopes: [...ADMIN_SCOPES],
    });
    await until(() => client.state.connection.canAdmin);
    const stored = JSON.parse(storage.data.get(tokenKey(URL_A))!);
    expect(stored).toMatchObject({ adminHeld: true, heldScopes: [...ADMIN_SCOPES] });
    // Every later connect asks for what was granted.
    fake.gateway.dropAll();
    await until(
      () => client.state.connection.status === "connected" && client.state.connection.canAdmin,
    );
    const connects = fake.gateway.connects as Array<{ scopes: string[] }>;
    expect(connects.at(-1)!.scopes).toEqual([...ADMIN_SCOPES]);
    client.stop();
  });

  it("a read-only connection keeps every account screen's values", async () => {
    const { client, accounts } = await accountsClient({ scopes: READ_SCOPES });
    expect(accounts().status).toBe("ready");
    expect(accounts().bindings.length).toBe(3);
    await expect(client.startSignIn(CHOICES.device, null)).rejects.toThrow(/needs admin access/);
    client.stop();
  });
});

describe("the bounds", () => {
  it("keeps at most the bounded number of accounts, and the state within its schema", async () => {
    const fake = new AccountsGateway();
    for (let i = 0; i < 100; i += 1)
      fake.shared.push({ id: `acme:extra${i}`, provider: "acme", type: "api_key" });
    const { client, accounts } = await accountsClient({ gateway: fake });
    expect(accounts().accounts.length).toBeLessThanOrEqual(MAX_ACCOUNTS);
    expect(JSON.stringify(accounts()).length).toBeLessThanOrEqual(worstCase(ACCOUNTS));
    client.stop();
  });

  it("a state past every account bound is brought within them", () => {
    const huge = "x".repeat(5000);
    const state: ClawtrateState = {
      ...initialState,
      accounts: {
        ...initialState.accounts,
        error: huge,
        accounts: Array.from({ length: 200 }, (_, i) => ({
          id: `acme:${i}`,
          provider: "acme",
          label: huge,
          type: "oauth",
          status: "ok",
          expiresAt: 1,
          kind: "subscription",
          made: "sign-in",
          keptBy: null,
          logoutSupported: true,
        })),
      },
    };
    const enforced = enforceState(state);
    expect(enforced.accounts.accounts.length).toBe(MAX_ACCOUNTS);
    expect(JSON.stringify(enforced.accounts).length).toBeLessThanOrEqual(worstCase(ACCOUNTS));
  });

  it("preference entries Clawtrate did not write are not kept, so each record stays within its registered size", async () => {
    const fake = new AccountsGateway();
    const longId = `acme:${"x".repeat(3_000)}`;
    const largeAccount = `acme:${"y".repeat(3_500)}`;
    fake.prefs[`clawtrate.account-kind.${longId}`] = "subscription";
    fake.prefs["clawtrate.account-kind.acme:fine"] = "key";
    fake.prefs["clawtrate.bot-account.otto"] = { mode: "account", account: largeAccount };
    fake.prefs[`clawtrate.bot-account.${"b".repeat(400)}`] = { mode: "gateway" };
    fake.prefs["clawtrate.bot-account.pip"] = { mode: "account", account: "acme:home" };
    const { client } = await accountsClient({ gateway: fake });
    const engine = (
      client as unknown as {
        accounts: { kinds: Map<string, unknown>; intents: Map<string, unknown> };
      }
    ).accounts;
    expect([...engine.kinds.keys()]).toEqual(["acme:fine"]);
    expect([...engine.intents.keys()]).toEqual(["pip"]);
    for (const [path, map] of [
      ["accounts.kinds", engine.kinds],
      ["accounts.intents", engine.intents],
    ] as const) {
      for (const entry of map) {
        expect(JSON.stringify(entry).length, path).toBeLessThanOrEqual(CLIENT_OWNERS[path]!.each);
      }
    }
    client.stop();
  });

  it("an id that is short but grows when serialized is measured as it is kept, and is not kept", async () => {
    const fake = new AccountsGateway();
    // 125 characters as written, 727 as JSON: each control character is six.
    const grows = `acme:${"\u0002".repeat(120)}`;
    fake.prefs[`clawtrate.account-kind.${grows}`] = "subscription";
    fake.prefs["clawtrate.bot-account.otto"] = { mode: "account", account: grows };
    fake.prefs["clawtrate.bot-account.pip"] = { mode: "account", account: "acme:home" };
    const { client } = await accountsClient({ gateway: fake });
    const engine = (
      client as unknown as {
        accounts: { kinds: Map<string, unknown>; intents: Map<string, unknown> };
      }
    ).accounts;
    expect([...engine.kinds.keys()]).not.toContain(grows);
    expect([...engine.intents.keys()]).toEqual(["pip"]);
    client.stop();
  });

  it("a typed value held for a sign-in fits its registered size however it serializes", async () => {
    const { client, fake } = await accountsClient();
    const engine = (client as unknown as { accounts: { secrets: string[] } }).accounts;
    const next = fake.gateway.handlers["wizard.next"]!;
    fake.gateway.handlers["wizard.next"] = (params) =>
      (params as { answer?: unknown }).answer
        ? { done: false, status: "running", step: { id: "wait", type: "text", message: "Wait" } }
        : next(params);
    await client.startSignIn(CHOICES.browser, null);
    await client.answerSignIn("\u0003".repeat(MAX_SECRET_CHARS));
    expect(engine.secrets).toHaveLength(1);
    expect(JSON.stringify(engine.secrets[0]).length).toBeLessThanOrEqual(
      CLIENT_OWNERS["accounts.secrets"]!.each,
    );
    client.stop();
  });

  it("the engine's own records stay within their counts", async () => {
    const fake = new AccountsGateway();
    for (let i = 0; i < 100; i += 1)
      fake.prefs[`clawtrate.account-kind.acme:k${i}`] = "subscription";
    const { client } = await accountsClient({ gateway: fake });
    const engine = (client as unknown as { accounts: { kinds: Map<string, unknown> } }).accounts;
    expect(engine.kinds.size).toBeLessThanOrEqual(MAX_ACCOUNTS);
    client.stop();
  });
});
