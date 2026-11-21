// Behaviour checks for bots.html: creating a bot with its account, connecting
// accounts, a bot's settings with its account and lock, and T3 Code.
// Run from the repository root:  node docs/design/prototype/tools/checks/bots.mjs
import { chromium, pageUrl } from "./browser.mjs";

const base = pageUrl("bots.html") + "?chrome=0&theme=light";
const b = await chromium.launch();
const out = [];
let failed = 0;
const check = (name, ok, extra = "") => {
  if (!ok) failed += 1;
  out.push(`${ok ? "ok  " : "FAIL"} ${name} ${extra}`);
};
const open = async (query = "", viewport = { width: 1440, height: 900 }) => {
  const context = await b.newContext({ viewport });
  // The page's timers run on a paused clock that each step moves on by the time it names, so a
  // check sees the state that time leads to however slowly the machine runs. The pause is set
  // before the context has a page, so it has no deadline to miss.
  await context.clock.install();
  await context.clock.pauseAt(Date.now());
  const p = await context.newPage();
  p.on("pageerror", (e) => out.push("PAGEERROR " + e));
  p.close = () => context.close();
  await p.goto(base + (query ? "&" + query : ""));
  await p.clock.runFor(150);
  return p;
};
const text = (p, sel) => p.evaluate((s) => document.querySelector(s)?.textContent || "", sel);
const dlg = (p, id = "create-dialog") => p.evaluate((i) => document.getElementById(i).open, id);
// The Account step leads to Approvals (controls.md section 10), whose choice Create waits for.
const toCreate = async (p, perm = "ask") => {
  await p.locator('[data-b="to-approvals"]').click({ timeout: 2000 }).catch(() => {});
  await p.locator(`[data-b-perm="${perm}"]`).click({ timeout: 2000 }).catch(() => {});
};
const focused = (p) => p.evaluate(() => document.activeElement?.id || document.activeElement?.dataset?.b || document.activeElement?.tagName);

// Print what ran so far if a step throws, so the failing step can be found.
process.on("uncaughtException", (e) => {
  console.log(out.join("\n"));
  console.log("THREW", e.message.split("\n")[0]);
  process.exit(1);
});

// Part 1: creating a bot ------------------------------------------------------------------------
let p = await open();
await p.click("#new-button");
await p.click('[data-action="new-bot"]');
await p.clock.runFor(60);
check("P1 New bot opens the dialog with focus on the name", (await dlg(p)) && (await focused(p)) === "b-name");
await p.keyboard.type("Viral");
await p.focus('.b-shape[aria-checked="true"]');
await p.keyboard.press("ArrowRight");
check("P1 shapes are one radio group: an arrow moves and chooses", await p.evaluate(() => document.activeElement.dataset.bBody === "gem" && document.activeElement.getAttribute("aria-checked") === "true"));
await p.keyboard.press("Enter").catch(() => {});
await p.click('[data-b="next"]').catch(() => {});
check("P1 Next goes to the Account step", (await text(p, "#create-title")) === "Account");
check("P1 the step keeps the name", (await text(p, "#create-dialog .b-lead")).includes("Viral runs on"));
const order = await p.evaluate(() => [...document.querySelectorAll("#create-dialog .b-group")].map((g) => g.textContent));
check("P1 subscriptions are listed first", order[0] === "Subscriptions" && order[1] === "API keys", order.join(" / "));
check("FM-01 nothing is chosen at first, and Next waits for a choice", await p.evaluate(() => !document.querySelector('#create-dialog [role="radio"][aria-checked="true"]') && document.querySelector('[data-b="to-approvals"]').disabled && !document.querySelector('[data-b="create"]') && document.querySelector("#create-dialog .b-foot").textContent.includes("Choose an account, or let the gateway choose.")));
check("FM-01 Let the gateway choose is the last choice of the one radio group, in words", await p.evaluate(() => { const r = [...document.querySelectorAll('#create-dialog [role="radiogroup"] [role="radio"]')]; const last = r[r.length - 1]; return document.querySelectorAll('#create-dialog [role="radiogroup"]').length === 1 && last.dataset.bChoose === "__gateway" && last.textContent.includes("Let the gateway choose") && last.textContent.includes("picks one of OpenAI's accounts for each run"); }));
check("FM-10 an account kept by one bot is not offered to a new bot", !(await text(p, "#create-dialog")).includes("Pip's key"));
await p.focus("#create-title");
await p.keyboard.press("Tab");
await p.keyboard.press("Tab");
check("FM-17 Tab reaches the account list with nothing chosen: its first row", await p.evaluate(() => document.activeElement.getAttribute("role") === "radio" && document.activeElement.dataset.bChoose === "openai:work"));
await p.keyboard.press("Space");
await p.clock.runFor(60);
check("FM-17 Space chooses the row and focus stays on it", await p.evaluate(() => document.activeElement.dataset.bChoose === "openai:work" && document.activeElement.getAttribute("aria-checked") === "true" && !document.querySelector('[data-b="to-approvals"]').disabled));
check("P1 two accounts of one provider are told apart by label", await p.evaluate(() => { const t = [...document.querySelectorAll("#create-dialog .b-choice-title")].map((x) => x.textContent); return t.includes("OpenAI · Work") && t.includes("OpenAI · Home"); }));
await p.click('[data-b-choose="xai:default"]');
check("P1 choosing an account shows model and effort side by side", await p.evaluate(() => { const m = document.querySelector('#create-dialog [data-b-select="model"]'); const e = document.querySelector('#create-dialog [data-b-select="effort"]'); return m && e && Math.abs(m.getBoundingClientRect().top - e.getBoundingClientRect().top) < 2 && m.textContent.includes("grok-4.7"); }));
await p.click('#create-dialog [data-b-select="model"]');
const models = await p.evaluate(() => [...document.querySelectorAll(".b-menu .menu-item")].map((i) => i.dataset.value));
check("P1 the model menu lists only the account's provider's models", models.length === 4 && models.every((m) => m.startsWith("grok")), models.join(","));
await p.keyboard.press("Escape");
check("P1 Escape closes the menu and not the dialog", (await dlg(p)) && !(await p.evaluate(() => document.querySelector(".b-menu"))) && (await p.evaluate(() => document.activeElement.dataset.bSelect === "model")));
await p.click('[data-b="connect"]');
check("P1 Connect another account opens the providers inside the dialog", (await text(p, "#create-title")) === "Connect an account");
check("P1 the API key path is collapsed and not preselected", await p.evaluate(() => { const d = document.querySelector("#create-dialog .b-disclosure"); return d && !d.open && d.querySelector("summary").textContent.includes("Use an API key instead"); }));
check("P1 the API key path says it is billed per token", (await text(p, "#create-dialog .b-disclosure")).includes("bills each request by the tokens it uses"));
await p.click('[data-b-option="xai/xai-oauth"]');
check("P1 starting: the gateway is asked", (await text(p, "#create-dialog .b-body")).includes("Asking the gateway to start the sign-in"));
await p.clock.runFor(900);
check("P1 waiting: a link and a code the gateway polls for", await p.evaluate(() => document.querySelector("#create-dialog .b-code code")?.textContent === "QK4F-7PZD" && document.querySelector('#create-dialog [data-b="open-link"]') && document.querySelector("#create-dialog .b-wait")));
await p.click('[data-b="cancel-signin"]');
check("FM-05 cancelled: says so, and what the gateway's accounts now show", (await text(p, "#create-dialog .b-result")).includes("Sign-in cancelled") && (await text(p, "#create-dialog")).includes("Clawtrate checked the gateway's accounts"));
await p.click('[data-b="restart-signin"]');
await p.clock.runFor(900);
await p.evaluate(() => window.bots.connectTo("connected"));
await p.clock.runFor(100);
check("P1 connected: the label step, with focus in the field", (await text(p, "#create-dialog .b-result h3")).includes("Connected to xAI") && (await p.evaluate(() => document.activeElement.matches("[data-b-label]"))));
await p.keyboard.type("Studio");
await p.click('[data-b="label-done"]');
check("P1 back on the Account step with the new account chosen and the bot kept", (await text(p, "#create-title")) === "Account" && (await p.evaluate(() => document.querySelector('[role="radio"][aria-checked="true"]')?.textContent.includes("xAI · Studio") && document.querySelector("#create-dialog .b-lead").textContent.includes("Viral"))));
await toCreate(p);
await p.click('[data-b="create"]');
check("P1 Create reads Creating… and is disabled", await p.evaluate(() => { const c = document.querySelector('[data-b="create"]'); return c.disabled && c.textContent === "Creating…"; }));
await p.clock.runFor(1600);
check("P1 after Create the new bot's composer has focus", await p.evaluate(() => document.activeElement.classList.contains("composer-input")));
check("P1 the new bot is created on its account and opened", !(await dlg(p)) && (await p.evaluate(() => document.querySelector("#title-pill").getAttribute("aria-label").startsWith("Viral, Main") && window.bots.accounts().find((a) => a.id === window.bots.binding.viral.account)?.label === "Studio")));
await p.close();

// The other two sign-in kinds.
p = await open("open=create&step=connect&name=Viral&connect=openai/openai");
await p.clock.runFor(900);
check("P1 paste: the field is a password field and says the code is not kept", await p.evaluate(() => document.querySelector("[data-b-paste]")?.type === "password" && document.querySelector("#create-dialog").textContent.includes("Clawtrate does not keep it")));
await p.fill("[data-b-paste]", "one-time-code");
await p.click('[data-b="paste-next"]');
check("P1 paste: checking with the provider", (await text(p, "#create-dialog .b-body")).includes("Finishing the sign-in"));
await p.clock.runFor(1000);
check("P1 paste: a second OpenAI account must have a label", await p.evaluate(() => document.querySelector('[data-b="label-done"]').disabled));
await p.keyboard.type("Work");
check("P1 a label already used by that provider is refused", (await text(p, ".b-field-error")).includes("Another OpenAI account is called Work") && (await p.evaluate(() => document.querySelector('[data-b="label-done"]').disabled)));
await p.close();
p = await open("open=create&step=connect&name=Viral&connect=openai/openai-token-sharing&stage=waiting");
check("P1 the gateway's machine: the command to forward the port, ready to copy", await p.evaluate(() => document.querySelector("#create-dialog .command-line code")?.textContent.startsWith("ssh -N -L 8080") && document.querySelector('#create-dialog .copy[aria-label="Copy command"]')));
await p.close();
for (const [stage, words] of [["failed", "Couldn't connect"], ["expired", "The sign-in expired"], ["dropped", "a sign-in ends with its connection"], ["busy", "does one at a time"], ["unconfirmed", "Saved, not confirmed"], ["finishing", "Too late to cancel"], ["same", "No new xAI account appeared: if this was an account you already have, the gateway may have refreshed its sign-in."]]) {
  p = await open(`open=create&step=connect&name=Viral&connect=xai/xai-oauth&stage=${stage}`);
  check(`P1 ${stage}: says so`, (await text(p, "#create-dialog .b-body")).includes(words));
  await p.close();
}
p = await open("open=create&step=connect&name=Viral&connect=xai/xai-oauth&stage=failed");
check("FM-05 an unclean ending never says nothing was saved; it reads the gateway's accounts again", !(await text(p, "#create-dialog")).includes("Nothing was saved") && (await text(p, "#create-dialog")).includes("Clawtrate checked the gateway's accounts: no new xAI account."));
await p.close();
p = await open("open=create&step=connect&name=Viral&connect=xai/xai-oauth&stage=cancelled&saved=1");
check("FM-05 a cancelled sign-in that saved a credential shows the account the gateway now has", (await text(p, "#create-dialog")).includes("The gateway now has a xAI account it didn't have before") && (await p.evaluate(() => !!document.querySelector('[data-b="name-saved"]'))));
await p.click('[data-b="name-saved"]');
check("FM-05 and leads to naming it", await p.evaluate(() => !!document.querySelector("[data-b-label]")));
await p.close();
p = await open("open=settings&section=accounts");
check("FM-10 Settings lists an account kept by one bot under its own heading", (await text(p, "#settings-dialog")).includes("Kept by one bot") && (await text(p, "#settings-dialog")).includes("Only Pip can use it"));
await p.click('[data-b-account="anthropic:pip"]');
check("FM-10 its page says only that bot can use it", (await text(p, "#settings-dialog")).includes("Kept in Pip's own store. Other bots can't use it."));
await p.close();
p = await open("open=settings&section=accounts&account=anthropic:manual");
check("FM-05 an API key's page offers Replace key, not Sign in again", await p.evaluate(() => !!document.querySelector('[data-b="replace-key"]') && !document.querySelector('[data-b="resign"]')));
await p.close();
p = await open("open=create&step=connect&name=Viral&connect=github-copilot/github-copilot-enterprise");
check("P1 Copilot Enterprise asks for the company's address first", (await p.evaluate(() => !!document.querySelector("[data-b-domain]"))));
await p.close();

// No account at all; creating fails; a connection that may not create.
p = await open("open=create&step=account&name=Viral&accounts=none");
check("P1 no accounts: the way to connect one, and Let the gateway choose with the default model", await p.evaluate(() => !!document.querySelector('#create-dialog [data-b="connect"]') && document.querySelector("#create-dialog").textContent.includes("No accounts yet") && document.querySelector('[data-b-choose="__gateway"]').textContent.includes("uses what it has for OpenAI, with its default model, gpt-5.5")));
await p.close();
p = await open("open=create&step=approvals&name=Viral&chosen=xai:default&perm=ask&create=failed");
await p.click('[data-b="create"]');
await p.clock.runFor(900);
check("P1 a failed create keeps the dialog and says so", (await dlg(p)) && (await text(p, "#create-dialog .b-foot")).includes("Could not create the bot. Please try again."));
await p.close();
p = await open("open=create&step=account&name=Viral&access=write");
check("P1 below admin: no Next or Create, the admin request instead", await p.evaluate(() => !document.querySelector('[data-b="create"]') && !document.querySelector('[data-b="to-approvals"]') && document.querySelector("#create-dialog .access-bar").textContent.includes("Admin access needed.")));
await p.click('#create-dialog [data-b="request"]');
check("P1 asking the gateway", (await text(p, "#create-dialog .access-bar")).includes("Asking the gateway"));
await p.clock.runFor(800);
check("P1 requested: the host's command and the request id", await p.evaluate(() => document.querySelector("#create-dialog .access-bar code").textContent === "openclaw devices approve 3f9a2c71" && document.querySelector('#create-dialog [aria-label="Copy request id"]')));
await p.click('#create-dialog [data-b="request-check"]');
check("P1 granted: Next appears, nothing chosen was lost", await p.evaluate(() => !!document.querySelector('[data-b="to-approvals"]') && document.querySelector("#create-dialog .b-lead").textContent.includes("Viral")));
await p.close();
p = await open("access=read");
check("P1 read-only: no way to create a bot", await p.evaluate(() => document.querySelector("#new-button").hidden));
await p.close();

// R2-03: where a sign-in lands is read after it, and said before it when known.
p = await open("open=create&step=connect&name=Viral&connect=xai/xai-oauth&stage=waiting&landed=juniper");
await p.evaluate(() => window.bots.connectTo("connected"));
await p.clock.runFor(100);
check("R2-03 a sign-in that turns out not to be shared says whose it is", (await text(p, "#create-dialog")).includes("Saved for Juniper only. Other bots can't use it."));
await p.keyboard.type("Studio");
await p.click('[data-b="label-done"]');
check("R2-03 and New bot does not offer it, saying why", await p.evaluate(() => !document.querySelector('[data-b-choose^="xai:"][aria-checked="true"]') && !document.querySelector('#create-dialog [data-b-choose="xai:home"]') && document.querySelector("#create-dialog").textContent.includes("was saved for Juniper only, so Viral can't use it.")));
await p.close();
p = await open("open=create&step=connect&name=Viral&connect=xai/xai-oauth&stage=waiting");
await p.evaluate(() => window.bots.connectTo("connected"));
await p.clock.runFor(100);
check("R2-03 a shared sign-in is called available to every bot only from the gateway's views", (await text(p, "#create-dialog")).includes("Every bot can use it: the gateway shows it to other bots as shared."));
await p.close();
p = await open("open=create&step=connect&name=Viral&nomain=1");
check("R2-03 when it is known before the sign-in that it can't be shared, the screen says so first", (await text(p, "#create-dialog")).includes("This gateway keeps this sign-in for Otto only. Other bots, and a bot you are creating, won't be able to use it.") && (await text(p, "#create-dialog")).includes('create it with "Let the gateway choose", then connect from its settings'));
await p.close();

// FM-01: Let the gateway choose, and the default model's own account.
p = await open("open=create&step=account&name=Viral");
await p.click('[data-b-choose="__gateway"]');
check("FM-01 Let the gateway choose enables Next and shows the default model's provider", await p.evaluate(() => !document.querySelector('[data-b="to-approvals"]').disabled && document.querySelector('#create-dialog [data-b-select="model"]').textContent.includes("gpt-5.5")));
await toCreate(p);
await p.click('[data-b="create"]');
await p.clock.runFor(1600);
check("FM-01 the bot is created with no fixed account, in its own state", await p.evaluate(() => window.bots.binding.viral.mode === "gateway" && window.bots.binding.viral.account === null));
await p.evaluate(() => { window.app.setPanel(true); document.querySelector("#tab-settings").click(); });
check("FM-01 its settings say the gateway chooses, not No account", (await text(p, '#panel-settings [data-bs="account"]')).includes("Gateway chooses") && !(await text(p, "#panel-settings")).includes("No account"));
await p.click('#panel-settings [data-bs="account"]');
check("FM-01 its account page says what that means and how to bind it", (await text(p, "#panel-settings")).includes("The gateway chooses. Viral has no fixed account: for each run the gateway picks one of OpenAI's accounts that its account order allows.") && !!(await p.evaluate(() => [...document.querySelectorAll('#panel-settings [data-bs="change"]')].find((b) => b.textContent === "Bind to an account"))));
await p.close();
p = await open("open=create&step=account&name=Viral&defacct=openai:work");
check("FM-01 when the default model names an account, it is chosen, and the step says why", await p.evaluate(() => document.querySelector('[data-b-choose="openai:work"]').getAttribute("aria-checked") === "true" && document.querySelector("#create-dialog").textContent.includes("Chosen because the gateway's default model names it.")));
await p.close();
// The first bot's command policy and the one Create sequence (bots.md section 3, controls.md section 10).
// The host's results come from fixtures in the address, chosen independently of the clicks. A control
// that isn't there fails the check that needs it, not the run.
const tap = (p, sel) => p.locator(sel).first().click({ timeout: 2000 }).then(() => true).catch(() => false);
const evalOr = (p, fn, arg) => p.evaluate(fn, arg).catch(() => null);
// The page's clock is paused: run it until the state shows, or for at most 5 s.
const settled = async (p, state) => {
  for (let i = 0; i < 50; i += 1) {
    if (await p.$(`[data-b-created="${state}"]`).catch(() => null)) return true;
    await p.clock.runFor(100);
  }
  return false;
};
const writesOf = (p) => evalOr(p, () => window.bots.writes?.() ?? null);
const said = async (p) => (await p.clock.runFor(120), evalOr(p, () => document.querySelector("#b-announce")?.textContent || ""));
const held = (p) => evalOr(p, () => { const c = document.querySelector(".composer-input"); return !!c && c.disabled && !!document.querySelector('[data-action="send"]')?.disabled; });
const viralCount = (p) => evalOr(p, () => window.app.bots.filter((b) => b.name === "Viral").length);
// No write log at all is not "nothing written": it is a failure.
const ops = (w) => (Array.isArray(w) ? w.map((x) => x.op + (x.step ? `:${x.step}` : "")).join(",") : "no write log");
const AP = "open=create&step=approvals&name=Viral&chosen=xai:default";
const ASK_LINE = "Sets Viral's command policy to ask for approval when a command misses the machine's allowlist.";
const FULL_LINE = "Sets Viral's command policy to run without routine approval. The machine, the task or a rule can still require approval or block a command.";

p = await open("open=create&step=account&name=Viral&chosen=xai:default");
await tap(p, '[data-b="to-approvals"]');
check("AP Next from Account opens Approvals, focused on its title", (await text(p, "#create-title")) === "Approvals" && (await focused(p)) === "create-title");
check("AP its two choices and the lines under them, in the design's words", await evalOr(p, (w) => {
  const t = document.querySelector("#create-dialog").textContent;
  return w.every((x) => t.includes(x)) && !/runs commands without asking first|on the gateway's computer, as Viral|stricter setting wins/.test(t);
}, ["When Viral wants to run a command:", "Ask before acting", ASK_LINE, "Run without routine approvals", FULL_LINE, "Commands use the machine and permissions set by the gateway. Viral's command setting replaces the gateway-wide command mode for this bot. You can change this later in Viral's settings.", "The gateway's approvals file can require approval or block commands."]));
check("AP nothing is chosen at first, and Create is unavailable, saying why", await evalOr(p, () => document.querySelectorAll('#create-dialog [data-b-perm][aria-checked="true"]').length === 0 && document.querySelector('[data-b="create"]').disabled && document.querySelector("#create-dialog .b-foot").textContent.includes("Choose how Viral runs commands.") && !document.querySelector("[data-b-inherits]")));
check("AP the group's accessible name is Approvals", (await p.getByRole("radiogroup", { name: "Approvals", exact: true }).count()) === 1);
check("AP each choice's title is its accessible name and its line its description", (await p.getByRole("radio", { name: "Ask before acting", exact: true }).count()) === 1 && (await p.getByRole("radio", { name: "Run without routine approvals", exact: true }).count()) === 1 && (await evalOr(p, (lines) => ["ask", "full"].every((v, i) => { const r = document.querySelector(`[data-b-perm="${v}"]`); const d = (r?.getAttribute("aria-describedby") || "").split(" ").map((id) => document.getElementById(id)?.textContent || "").join(" ").trim(); return d === lines[i]; }), [ASK_LINE, FULL_LINE])));
check("AP the two choices are one radio group with one tab stop, neither marked as recommended", await evalOr(p, () => { const g = document.querySelectorAll('#create-dialog [role="radiogroup"]'); const r = [...document.querySelectorAll("#create-dialog [data-b-perm]")]; return g.length === 1 && r.length === 2 && r.filter((x) => x.tabIndex === 0).length === 1 && !/recommended/i.test(document.querySelector("#create-dialog").textContent); }));
await p.click('[data-b="create"]', { force: true, timeout: 2000 }).catch(() => {});
await p.clock.runFor(300);
check("AP Create with nothing chosen makes nothing and writes nothing", (await dlg(p)) && (await viralCount(p)) === 0 && ops(await writesOf(p)) === "");
check("AP the host refuses a Create with no command choice: nothing is written", (await evalOr(p, () => window.bots.hostCreate({ name: "Viral", account: "xai:default", perm: null }).refused)) === true && ops(await writesOf(p)) === "");
check("AP the host refuses a Create with no account choice: nothing is written", (await evalOr(p, () => window.bots.hostCreate({ name: "Viral", account: null, perm: "ask" }).refused)) === true && ops(await writesOf(p)) === "");
await p.focus("#create-title");
await p.keyboard.press("Tab");
await p.keyboard.press("Tab");
check("AP Tab reaches the first choice, past Close", await evalOr(p, () => document.activeElement.dataset.bPerm === "ask"));
await p.keyboard.press("ArrowDown");
check("AP an arrow moves and chooses, and Create becomes available", await evalOr(p, () => document.activeElement.dataset.bPerm === "full" && document.activeElement.getAttribute("aria-checked") === "true" && !document.querySelector('[data-b="create"]').disabled));
check("AP once chosen, the line above Create says the bot inherits the gateway's settings first", (await text(p, "[data-b-inherits]")) === "Before Clawtrate sets Viral's policy, the new bot inherits the gateway's settings.");
await tap(p, '[data-b="to-account"]');
check("AP Back returns to Account with its choice kept", (await text(p, "#create-title")) === "Account" && (await evalOr(p, () => document.querySelector('[data-b-choose="xai:default"]').getAttribute("aria-checked") === "true")));
await tap(p, '[data-b="to-approvals"]');
check("AP and Next returns with the approvals choice kept", await evalOr(p, () => document.querySelector('[data-b-perm="full"]').getAttribute("aria-checked") === "true"));
await tap(p, '[data-b-perm="ask"]');
await tap(p, '[data-b="create"]');
const reading = await settled(p, "reading");
check("CR the dialog closes on the returned bot, which says it is checking and holds its composer", reading && !(await dlg(p)) && (await held(p)) && (await text(p, "[data-b-created]")).includes("Checking what was written…") && !(await text(p, "[data-b-created]")).includes("saved command setting"));
const okAsk = await settled(p, "confirmed");
check("CR with Ask: the saved setting and the reported default policy, as two separate facts", okAsk && (await text(p, "[data-b-saved]")) === "Viral's saved command setting is Ask before acting." && (await text(p, "[data-b-label]")) === "The gateway reports that the default command policy asks on an allowlist miss.");
check("CR nothing claims an effective result", !/effective|will still ask|Created with/.test(await text(p, "[data-b-created]")));
check("CR once read back the composer opens, with focus", await evalOr(p, () => { const c = document.querySelector(".composer-input"); return !!c && !c.disabled && document.activeElement === c; }));
check("CR the announcement names the saved setting", (await said(p)).includes("Viral's saved command setting is Ask before acting."));
const w1 = await writesOf(p);
check("CR one sequence: Create once, then the restrictive patch, then the chosen policy, all to the returned id", ops(w1) === "agents.create,config.patch:2,config.patch:3" && w1?.slice(1).every((x) => x.id === "viral"), ops(w1));
check("CR the restrictive patch is Never, the named-tool denies with t3code__*, and an empty fallback list", !!w1?.[1] && w1[1].mode === "deny" && w1[1].deny.includes("t3code__*") && !w1[1].deny.includes("t3code") && JSON.stringify(w1[1].fallbacks) === "[]");
check("CR the policy patch writes Ask, the final list with t3code__*, and names the exact deny path in replacePaths", !!w1?.[2] && w1[2].mode === "ask" && JSON.stringify(w1[2].deny) === '["gateway","plugins","t3code__*"]' && JSON.stringify(w1[2].replacePaths) === '["agents.entries.viral.tools.deny"]');
await p.close();

p = await open(`${AP}&perm=full`);
await tap(p, '[data-b="create"]');
check("CR with Full: its saved setting and the gateway's reported label", (await settled(p, "confirmed")) && (await text(p, "[data-b-saved]")) === "Viral's saved command setting is Run without routine approvals." && (await text(p, "[data-b-label]")) === "The gateway reports no routine approval in the default command policy.");
await p.close();
for (const [label, words] of [["read-only", "The gateway reports that the default command policy disables commands."], ["none", "The gateway didn't report a default command policy for Viral."]]) {
  p = await open(`${AP}&perm=full&label=${label}`);
  await tap(p, '[data-b="create"]');
  check(`CR a reported label of ${label} is said as reported, beside the saved Full`, (await settled(p, "confirmed")) && (await text(p, "[data-b-saved]")).includes("Run without routine approvals") && (await text(p, "[data-b-label]")) === words);
  await p.close();
}
p = await open(`${AP}&approvals=deny`);
check("CR an approvals file that blocks commands is said before Create, in warn", await evalOr(p, () => { const l = document.querySelector('[data-b-file="deny"]'); return l?.dataset.tone === "warn" && l.textContent === "The gateway's approvals file blocks commands." && !document.querySelector("#create-dialog").textContent.includes("can require approval or block"); }));
await p.close();

p = await open(`${AP}&perm=ask&create=timeout`);
await tap(p, '[data-b="create"]');
await p.clock.runFor(1100);
check("CR a lost Create reply: not confirmed, with Review bots", (await dlg(p)) && (await text(p, "#create-dialog .b-foot")).includes("Clawtrate couldn't confirm whether Viral was created. Review the gateway's bot list.") && (await evalOr(p, () => !!document.querySelector('[data-b="review-bots"]') && !document.querySelector('[data-b="create"]'))));
check("CR the lost reply is announced", (await said(p)).includes("Clawtrate couldn't confirm whether Viral was created"), await said(p));
check("CR no policy or model patch is sent from that attempt, and no bot is assumed", ops(await writesOf(p)) === "agents.create" && (await viralCount(p)) === 0);
await tap(p, '[data-b="review-bots"]');
check("CR Review bots closes and shows what the gateway lists", !(await dlg(p)) && (await viralCount(p)) === 0);
await p.close();
p = await open(`${AP}&perm=ask&create=failed`);
await tap(p, '[data-b="create"]');
await p.clock.runFor(1000);
check("CR a refused Create keeps the dialog and writes nothing more", (await dlg(p)) && (await text(p, "#create-dialog .b-foot")).includes("Could not create the bot. Please try again.") && ops(await writesOf(p)) === "agents.create");
await p.close();

p = await open(`${AP}&perm=ask&create=partial`);
await tap(p, '[data-b="create"]');
check("CR the restrictive step not read back: its own state, nothing sent, and no policy write", (await settled(p, "restrictfail")) && (await evalOr(p, () => document.querySelector("[data-b-created]").dataset.tone === "danger")) && (await text(p, "[data-b-created]")).includes("Couldn't confirm Viral's settings. Clawtrate sends nothing to Viral until they are confirmed.") && (await held(p)) && ops(await writesOf(p)) === "agents.create,config.patch:2");
await tap(p, '[data-b="restrict-again"]');
check("CR Write them again repeats only the restrictive write, then the policy, for the same bot", (await settled(p, "confirmed")) && ops(await writesOf(p)) === "agents.create,config.patch:2,config.patch:2,config.patch:3" && (await viralCount(p)) === 1);
await p.close();
p = await open(`${AP}&perm=full&create=conflict`);
await tap(p, '[data-b="create"]');
check("CR a hash conflict before the policy write: it stops, writes no policy, and says it couldn't confirm", (await settled(p, "unconfirmed")) && ops(await writesOf(p)) === "agents.create,config.patch:2" && (await held(p)));
await p.close();
p = await open(`${AP}&perm=ask&readback=pending`);
await tap(p, '[data-b="create"]');
await settled(p, "reading");
await p.clock.runFor(1500);
check("CR a read-back still pending: Checking what was written…, the composer held, announced", (await evalOr(p, () => document.querySelector("[data-b-created]")?.dataset.bCreated)) === "reading" && (await held(p)) && (await said(p)).includes("Checking what was written"));
await p.close();
p = await open(`${AP}&perm=full&readback=mismatch`);
await tap(p, '[data-b="create"]');
check("CR a mismatched read-back: couldn't confirm, with the setting it did read", (await settled(p, "unconfirmed")) && (await text(p, "[data-b-created]")).includes("Clawtrate couldn't confirm Viral's command setting. Review the gateway's settings before sending a task. Its saved command setting is Never.") && (await held(p)));
check("CR the mismatch is announced", (await said(p)).includes("Clawtrate couldn't confirm Viral's command setting"), await said(p));
check("CR with Review settings and, for the identified bot, Write it again", await evalOr(p, () => !!document.querySelector('[data-b="review-settings"]') && !!document.querySelector('[data-b="perm-again"]')));
await tap(p, '[data-b="perm-again"]');
check("CR Write it again repeats only the policy write: no second Create, one Viral", (await settled(p, "confirmed")) && ops(await writesOf(p)) === "agents.create,config.patch:2,config.patch:3,config.patch:3" && (await viralCount(p)) === 1 && (await text(p, "[data-b-saved]")).includes("Run without routine approvals"));
await p.close();
p = await open(`${AP}&perm=ask&readback=fail&retry=fail`);
await tap(p, '[data-b="create"]');
check("CR a failed read: couldn't confirm, naming no setting", (await settled(p, "unconfirmed")) && !(await text(p, "[data-b-created]")).includes("Its saved command setting"));
await tap(p, '[data-b="perm-again"]');
await settled(p, "reading");
check("CR a retry whose read fails stays unconfirmed, the composer held", (await settled(p, "unconfirmed")) && (await held(p)) && (await viralCount(p)) === 1);
await p.close();
p = await open(`${AP}&perm=ask&readback=fail&retry=gone`);
await tap(p, '[data-b="create"]');
check("CR when the bot is no longer identified, no Write it again is offered", (await settled(p, "unconfirmed")) && (await evalOr(p, () => !document.querySelector('[data-b="perm-again"]') && !!document.querySelector('[data-b="review-settings"]'))));
await p.close();
p = await open(`${AP}&perm=ask`);
await evalOr(p, () => window.bots.setAccess("write"));
await p.clock.runFor(100);
check("AP access dropping below admin while the step is open removes the choices and Create", await evalOr(p, () => !document.querySelector("[data-b-perm]") && !document.querySelector('[data-b="create"]') && !!document.querySelector("#create-dialog .access-bar")));
await p.close();

// F-005: the first-bot prompt only on a confirmed unused implicit main.
p = await open("state=nobots");
check("FB the replies confirm an unused implicit main: the first-bot prompt, in place of No bots to show", (await evalOr(p, () => window.bots.first?.().eligible)) === true && (await text(p, "#transcript")).includes("Make your first bot") && (await text(p, "#transcript")).includes("Give it a name and a picture, choose the account it runs on and how it runs commands.") && !(await text(p, "#transcript")).includes("No bots to show"));
await tap(p, '[data-b="first-bot"]');
check("FB New bot on the prompt opens New bot; nothing is created by the prompt", (await dlg(p)) && (await focused(p)) === "b-name" && (await evalOr(p, () => window.app.bots.length === 0)) && ops(await writesOf(p)) === "");
await p.keyboard.type("Viral");
await tap(p, '[data-b="next"]');
await tap(p, '[data-b-choose="xai:default"]');
await tap(p, '[data-b="to-approvals"]');
await tap(p, '[data-b-perm="ask"]');
await tap(p, '[data-b="create"]');
check("FB after Create the rail shows what the gateway lists, the new bot, its task open with Message Viral", (await settled(p, "confirmed")) && (await evalOr(p, () => window.app.bots.map((b) => b.name).join() === "Viral" && !document.querySelector("[data-b-first]") && document.querySelector(".composer-input")?.getAttribute("placeholder") === "Message Viral")));
await p.close();
p = await open("state=nobots&access=read");
check("FB below admin: Main's reported policy, and that creating needs admin", await evalOr(p, () => { const t = document.querySelector("#transcript").textContent; return t.includes("The gateway reports no routine approval in Main's default command policy.") && t.includes("Creating a bot changes the gateway's settings, which needs admin access.") && !!document.querySelector('#transcript [data-b="request"]') && !document.querySelector('[data-b="first-bot"]') && !/Until you make one/.test(t); }));
await tap(p, '#transcript [data-b="request"]');
await p.clock.runFor(800);
check("FB below admin: Request admin access leads to the request", (await text(p, "#transcript .access-bar")).includes("Waiting for the gateway's owner."));
await p.close();
for (const [perm, words] of [["guarded", "The gateway reports that Main's default command policy asks on an allowlist miss."], ["read-only", "The gateway reports that Main's default command policy disables commands."]]) {
  p = await open(`state=nobots&access=write&defperm=${perm}`);
  check(`FB below admin, Main reported ${perm}: said as reported`, (await text(p, "[data-b-default-policy]")) === words);
  await p.close();
}
p = await open("state=nobots&access=write&defperm=none");
check("FB below admin, no label reported: nothing is said about it", await evalOr(p, () => !!document.querySelector("[data-b-first]") && !document.querySelector("[data-b-default-policy]")));
await p.close();
for (const [roster, what, main] of [["used", "an implicit main with tasks", true], ["legacy", "a main configured in the legacy agents.list", true], ["missing", "no session reply", true], ["fail", "a failed roster read", false]]) {
  p = await open(`state=nobots&roster=${roster}`);
  check(`FB ${what}: the normal roster, no first-bot prompt`, (await evalOr(p, () => window.bots.first?.().eligible)) === false && (await evalOr(p, (m) => !document.querySelector("[data-b-first]") && (m ? window.app.bots.map((b) => b.name).join() === "Main" : document.querySelector("#transcript").textContent.includes("No bots to show")), main)));
  await p.close();
}
p = await open();
check("FB a gateway with bots shows no first-bot prompt", await evalOr(p, () => !document.querySelector("[data-b-first]")));
await p.close();

// Both walks at 1440 and phone width, dark (the default) and light.
const openThemed = async (query, viewport, theme) => {
  const q = await b.newPage({ viewport });
  q.on("pageerror", (e) => out.push("PAGEERROR " + e));
  await q.goto(base.replace("theme=light", `theme=${theme}`) + "&" + query);
  await q.clock.runFor(150);
  return q;
};
for (const theme of ["dark", "light"])
  for (const [label, viewport, query] of [["1440", { width: 1440, height: 900 }, ""], ["phone", { width: 390, height: 844 }, "&width=phone"]]) {
    const at = `${label}, ${theme}`;
    p = await openThemed(`${AP}&approvals=deny${query}`, viewport, theme);
    check(`AP at ${at}: the theme is applied`, (await evalOr(p, () => document.documentElement.dataset.theme)) === theme);
    await tap(p, '[data-b-perm="full"]');
    check(`AP at ${at}: the step fits with no sideways scroll, Create in view`, await evalOr(p, () => { const c = document.querySelector('[data-b="create"]').getBoundingClientRect(); return document.documentElement.scrollWidth <= innerWidth + 1 && c.bottom <= innerHeight && c.right <= innerWidth; }));
    check(`AP at ${at}: each choice is at least 48 px tall`, await evalOr(p, () => { const r = [...document.querySelectorAll("[data-b-perm]")]; return r.length === 2 && r.every((x) => x.getBoundingClientRect().height >= 48); }));
    await tap(p, '[data-b="create"]');
    check(`CR at ${at}: the confirmed note fits, with no sideways scroll`, (await settled(p, "confirmed")) && (await evalOr(p, () => { const r = document.querySelector("[data-b-created]").getBoundingClientRect(); return r.width > 0 && r.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth + 1; })));
    await p.close();
    p = await openThemed(`${AP}&perm=full&readback=mismatch${query}`, viewport, theme);
    await tap(p, '[data-b="create"]');
    check(`CR at ${at}: the unconfirmed note and its actions fit`, (await settled(p, "unconfirmed")) && (await evalOr(p, () => [...document.querySelectorAll("[data-b-created], [data-b-created] button")].every((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right <= innerWidth; }) && document.documentElement.scrollWidth <= innerWidth + 1)));
    await p.close();
    p = await openThemed(`state=nobots&access=read${query}`, viewport, theme);
    check(`FB at ${at}: the prompt fits with no sideways scroll`, await evalOr(p, () => { const r = document.querySelector("[data-b-first]")?.getBoundingClientRect(); return !!r && r.width > 0 && document.documentElement.scrollWidth <= innerWidth + 1; }));
    await p.close();
    p = await openThemed(`state=nobots${query}`, viewport, theme);
    check(`FB at ${at}: the prompt's New bot is in view`, await evalOr(p, () => { const r = document.querySelector('[data-b="first-bot"]')?.getBoundingClientRect(); return !!r && r.bottom <= innerHeight && r.right <= innerWidth; }));
    await p.close();
  }

// Settings, Accounts.
p = await open();
await p.click(".gateway-pill");
await p.click('[data-action="b-settings"]');
check("FM-14 Settings opens from the gateway menu on the shell's Gateway pane, kept as built", (await dlg(p, "settings-dialog")) && (await text(p, "#b-section-title")) === "Gateway" && (await text(p, "#settings-dialog .facts")).includes("Granted scopes") && (await p.evaluate(() => !!document.querySelector('#settings-dialog [data-action="disconnect"]'))));
check("FM-14 the sections are Gateway, then Accounts, then Integrations", (await p.evaluate(() => [...document.querySelectorAll(".b-nav-item")].map((n) => n.textContent).join(","))) === "Gateway,Accounts,Integrations");
await p.click('[data-b-section="accounts"]');
await p.click('[data-b-account="openai:work"]');
check("P1 an account's page: label, kind, state, the bots that use it", await p.evaluate(() => { const t = document.querySelector("#settings-dialog .facts").textContent; return t.includes("Work") && t.includes("Subscription") && t.includes("Connected") && t.includes("Otto (locked), Marlow"); }));
await p.click('[data-b="relabel"]');
await p.fill("[data-b-relabel]", "Home");
await p.click('[data-b="relabel-save"]');
check("P1 relabelling to another account's label is refused", await p.evaluate(() => document.querySelector("[data-b-relabel]")?.getAttribute("aria-invalid") === "true"));
await p.fill("[data-b-relabel]", "Office");
await p.click('[data-b="relabel-save"]');
check("P1 a new label is saved and shown", (await text(p, "#b-section-title")) === "OpenAI · Office");
await p.click('[data-b="disconnect"]');
check("P1 disconnecting asks, naming the bots that use it", (await dlg(p, "confirm-dialog")) && (await text(p, "#confirm-text")).includes("Otto and Marlow use it"));
await p.click('[data-b="confirm-ok"]');
check("P1 after disconnecting, those bots have no account", await p.evaluate(() => window.bots.binding.otto.account === null && window.bots.binding.marlow.account === null && !window.bots.accounts().some((a) => a.id === "openai:work")));
// The dialog's close event, which hands focus back to its opener, comes with the browser's next
// frame, not on the page's clock: wait for it, then give the page its usual 50 ms.
await p.evaluate(() => {
  window.settingsClosed = new Promise((closed) => document.querySelector("#settings-dialog").addEventListener("close", closed, { once: true }));
});
await p.keyboard.press("Escape");
await p.evaluate(() => window.settingsClosed);
await p.clock.runFor(50);
check("P1 closing Settings returns focus to the gateway row", !(await dlg(p, "settings-dialog")) && (await p.evaluate(() => document.activeElement.classList.contains("gateway-pill"))));
await p.close();
p = await open("open=settings&section=accounts&access=read");
check("P1 read-only Settings: ids, not labels, and no Connect", await p.evaluate(() => !document.querySelector('#settings-dialog [data-b="connect"]') && document.querySelector("#settings-dialog .b-choice-title .mono")?.textContent === "openai:work" && document.querySelector("#settings-dialog .access-bar").textContent.includes("Read-only.")));
await p.close();

// The phone.
p = await open("open=create&name=Viral", { width: 390, height: 844 });
check("P1 phone: New bot is a full-width sheet", await p.evaluate(() => Math.round(document.querySelector("#create-dialog").getBoundingClientRect().width) === 390));
await p.close();
p = await open("open=settings", { width: 390, height: 844 });
check("P1 phone: Settings opens on its list of sections", await p.evaluate(() => getComputedStyle(document.querySelector(".b-section")).display === "none" && getComputedStyle(document.querySelector(".b-nav")).display !== "none"));
await p.click('[data-b-section="accounts"]');
check("P1 phone: a section replaces the list, with a way back", await p.evaluate(() => getComputedStyle(document.querySelector(".b-nav")).display === "none" && getComputedStyle(document.querySelector('[data-b="to-nav"]')).display !== "none"));
await p.close();

// FM-16 and FM-17 at phone width.
const phone = { width: 390, height: 844 };
p = await open("open=create&step=account&name=Viral", phone);
check("Phone: Let the gateway choose is set apart by 12 px and its whole line is readable", await p.evaluate(() => { const gw = document.querySelector(".b-choices.b-gw"); const prev = gw.previousElementSibling; const sub = gw.querySelector(".b-choice-sub"); return gw.getBoundingClientRect().top - prev.getBoundingClientRect().bottom >= 11.5 && sub.scrollWidth <= sub.clientWidth + 1 && sub.textContent.includes("with its default model, gpt-5.5."); }));
await p.close();
p = await open("open=settings&section=accounts&account=openai:work", phone);
await p.click('[data-b="disconnect"]');
check("FM-16 phone: a confirmation is a card at the foot, as tall as its content", await p.evaluate(() => { const r = document.querySelector("#confirm-dialog").getBoundingClientRect(); return r.height < 360 && Math.abs(innerHeight - r.bottom - 12) < 2; }));
check("FM-16 phone: its buttons are at least 44 px", await p.evaluate(() => [...document.querySelectorAll("#confirm-dialog .button")].every((b) => b.getBoundingClientRect().height >= 44)));
await p.close();
p = await open("open=settings&section=accounts&account=openai:home&long=1", phone);
check("FM-16 phone: a long label wraps, and Edit stays in view", await p.evaluate(() => { const v = document.querySelector(".b-label-value span"); const e = document.querySelector('[data-b="relabel"]'); const r = e.getBoundingClientRect(); return v.scrollWidth <= v.clientWidth + 1 && r.right <= innerWidth && r.width > 0; }));
check("FM-16 phone: small actions are at least 44 px to touch", await p.evaluate(() => [...document.querySelectorAll('#settings-dialog .button[data-size="sm"]')].every((b) => b.getBoundingClientRect().height >= 44)));
await p.close();
p = await open("bot=pip&panel=open&tab=settings&long=1", phone);
check("FM-16 phone: with a long label, the account's state word is shown whole", await p.evaluate(() => { const st = document.querySelector('#panel-settings [data-bs="account"] .b-state'); return st.textContent === "Bound" && st.scrollWidth <= st.clientWidth + 1; }));
await p.click('#panel-settings [data-b-select="model"]');
await p.keyboard.press("Escape");
check("FM-17 phone: Escape in a menu closes the menu and not the Work pane", await p.evaluate(() => !document.querySelector(".b-menu") && window.app.model.panel && document.activeElement.dataset.bSelect === "model"));
await p.close();
p = await open("open=settings", phone);
check("FM-16 phone: the Settings list has its own Close", await p.evaluate(() => { const c = document.querySelector('.b-nav .b-close'); return c && getComputedStyle(c).display !== "none" && c.getBoundingClientRect().width > 0; }));
await p.close();

// The tab bar: tabs that don't fit never wrap or shorten.
p = await open("bot=marlow&panel=open&tab=settings", { width: 1100, height: 800 });
await p.evaluate(() => { const words = ["Einzelheiten", "Dateien", "Computer", "Einstellungen"]; document.querySelectorAll(".work-panel .tab").forEach((t, i) => (t.textContent = words[i])); });
// The tab bar fits itself from the browser's observers and layout, not a page timer.
await p.clock.runFor(100);
check("Tab bar: longer words stay on one row, unshortened, with the chosen tab in view", await p.evaluate(() => { const bar = document.querySelector(".work-panel .tabs"); const tabs = [...bar.querySelectorAll(".tab")]; const on = bar.querySelector('[aria-selected="true"]'); const b = bar.getBoundingClientRect(); const r = on.getBoundingClientRect(); return new Set(tabs.map((t) => Math.round(t.getBoundingClientRect().top))).size === 1 && tabs.every((t) => t.scrollWidth <= t.clientWidth + 1) && r.left >= b.left - 1 && r.right <= b.right + 1 && bar.dataset.fit; }));
await p.close();

// Part 2: a bot's settings ------------------------------------------------------------------------
const pane = (p) => text(p, "#panel-settings");
p = await open("bot=marlow&panel=open&tab=settings");
check("P2 the Work pane has a Settings tab, reached with the arrows", await p.evaluate(() => document.querySelector("#tab-settings").getAttribute("aria-selected") === "true" && !document.querySelector("#panel-settings").hidden));
check("P2 the account row says the account and that it is bound", (await text(p, '#panel-settings [data-bs="account"]')).includes("OpenAI · Work") && (await text(p, '#panel-settings [data-bs="account"]')).includes("Bound"));
check("P2 model and effort sit side by side", await p.evaluate(() => { const [m, e] = document.querySelectorAll("#panel-settings .b-select"); return m && e && Math.abs(m.getBoundingClientRect().top - e.getBoundingClientRect().top) < 2; }));
await p.click('#panel-settings [data-b-select="model"]');
const pm = await p.evaluate(() => [...document.querySelectorAll(".b-menu .menu-item")].map((i) => i.dataset.value));
check("P2 the model menu lists only the account's models", pm.length === 3 && pm.every((m) => m.startsWith("gpt")), pm.join(","));
await p.click('.b-menu [data-value="gpt-5.5-mini"]');
check("P2 a chosen model is saved and focus returns to its select", (await text(p, '#panel-settings [data-b-select="model"]')).includes("gpt-5.5-mini") && (await p.evaluate(() => document.activeElement.dataset.bSelect === "model")));
await p.click('#panel-settings [data-bs="account"]');
await p.clock.runFor(50);
check("P2 Account opens with focus on its title", await p.evaluate(() => document.activeElement.textContent === "Account"));
check("P2 bound: says plainly that the gateway may use another account", (await pane(p)).includes("Bound. Marlow runs on OpenAI · Work. If that account fails, the gateway may use another OpenAI account"));
check("P2 the lock is one command, ready to copy", (await text(p, "#panel-settings .command-line code")) === "openclaw models auth order set --provider openai --agent marlow openai:work" && (await p.evaluate(() => !!document.querySelector('#panel-settings .copy[aria-label="Copy lock command"]'))));
check("P2 bound: says what it cannot see", (await pane(p)).includes("a run can start on another OpenAI account without leaving a record Clawtrate can read"));
check("P2 the ways round a lock are listed, folded", await p.evaluate(() => { const d = [...document.querySelectorAll("#panel-settings .b-disclosure")].find((x) => x.textContent.includes("What a lock doesn't cover")); return d && !d.open && d.querySelectorAll("li").length === 8; }));
await p.click('#panel-settings .copy[aria-label="Copy lock command"]');
await p.clock.runFor(80);
check("P2 copying the command starts checking the gateway", (await text(p, "#panel-settings .b-wait")).includes("Checking the gateway for the lock"));
await p.click('#panel-settings [data-bs="lock-check"]');
check("FM-03 Check now reads the gateway: no order yet, so not locked", !(await pane(p)).includes("Locked.") && (await p.evaluate(() => document.activeElement.dataset.bs === "lock-check")));
await p.focus('#panel-settings [data-bs="main"]');
await p.evaluate(() => (window.botSettings.GW.order.marlow = ["openai:work"]));
await p.clock.runFor(4600);
check("FM-03 once the gateway has the order, the page turns Locked by itself", (await pane(p)).includes("Locked. Marlow's ordinary runs use OpenAI · Work only") && (await pane(p)).includes("Checked with the gateway at"));
check("FM-03 a read in the background does not move focus", await p.evaluate(() => document.activeElement.dataset.bs === "main"));
check("FM-03 Locked says the ordinary-run boundary on the page itself", (await pane(p)).includes("A run started with another account named still goes round it."));
check("P2 locked: the command to unlock, folded", await p.evaluate(() => [...document.querySelectorAll("#panel-settings .b-disclosure")].some((d) => d.textContent.includes("openclaw models auth order clear --provider openai --agent marlow"))));
await p.click('#panel-settings [data-bs="main"]');
check("P2 the account row now says Locked", (await text(p, '#panel-settings [data-bs="account"]')).includes("Locked"));
await p.close();

p = await open("bot=marlow&panel=open&tab=settings&bview=change&running=1");
await p.click('#panel-settings [data-b-choose="xai:default"]');
check("P2 changing to an account without the model asks for a model first", await p.evaluate(() => document.querySelector('#panel-settings [data-bs="save-change"]').disabled && document.querySelector("#panel-settings").textContent.includes("xAI doesn't offer gpt-5.5")));
check("P2 a run in progress finishes on the account it started with", (await pane(p)).includes("A run in progress finishes on OpenAI · Work. The next run uses xAI · Personal."));
await p.click('#panel-settings [data-b-select="model"]');
await p.click('.b-menu [data-value="grok-4.7"]');
await p.click('#panel-settings [data-bs="save-change"]');
check("P2 the change posts a grey line in the task", (await text(p, "#transcript")).includes("Marlow now runs on xAI · Personal. The run in progress finishes on OpenAI · Work."));
await p.click('#panel-settings [data-bs="main"]');
check("P2 tools that come with the account appear under its provider", (await pane(p)).includes("From xAI") && (await pane(p)).includes("Search posts on X"));
await p.close();

p = await open("bot=otto&panel=open&tab=settings&bview=change");
await p.click('#panel-settings [data-b-choose="openai:home"]');
check("FM-02 locked to the old account: the new one leads and the old one is still tried", (await pane(p)).includes("Otto is locked to OpenAI · Work. After saving, Otto runs on OpenAI · Home first, and the gateway still tries OpenAI · Work when OpenAI · Home fails"));
await p.click('#panel-settings [data-bs="save-change"]');
check("FM-02 after saving, the lock is out of date, said as the gateway runs it, with the new command", (await pane(p)).includes("The lock is out of date. Otto runs on OpenAI · Home first, but the gateway's order for Otto still lists only OpenAI · Work, so when OpenAI · Home fails the gateway tries OpenAI · Work.") && (await text(p, "#panel-settings .command-line code")).endsWith("--agent otto openai:home"));
check("FM-02 the account row says Lock out of date", await p.evaluate(() => { document.querySelector('#panel-settings [data-bs="main"]').click(); return document.querySelector('#panel-settings [data-bs="account"]').textContent.includes("Lock out of date"); }));
await p.close();

// R2-01: changing a bound bot and a locked bot to "Let the gateway choose".
p = await open("bot=marlow&panel=open&tab=settings&bview=change");
check("R2-01 Change account offers Let the gateway choose, last in the one radio group, naming the bot's own model", await p.evaluate(() => { const r = [...document.querySelectorAll('#panel-settings [role="radiogroup"] [role="radio"]')]; const last = r[r.length - 1]; return last.dataset.bChoose === "__gateway" && last.textContent.includes("as its account order allows, with Marlow's own model, gpt-5.5"); }));
await p.click('#panel-settings [data-b-choose="__gateway"]');
await p.click('#panel-settings [data-bs="save-change"]');
check("R2-01 a bound bot moved to it: Gateway chooses, its own model without an account, and no retained order to report", await p.evaluate(() => { const b = window.bots.binding.marlow; const t = document.querySelector("#panel-settings").textContent; return b.mode === "gateway" && b.account === null && b.model === "gpt-5.5" && t.includes("The gateway chooses.") && !t.includes("still has an order"); }));
check("R2-01 the task's grey line says so", (await text(p, "#transcript")).includes("Marlow now has no fixed account, from the next run."));
await p.close();
p = await open("bot=otto&panel=open&tab=settings&bview=change");
await p.click('#panel-settings [data-b-choose="__gateway"]');
check("R2-01 a locked bot: before saving, the view says the stored order keeps it on its account", (await pane(p)).includes("Otto is locked to OpenAI · Work. The gateway keeps an order for Otto that names only OpenAI · Work, and goes on using that account alone until its owner clears the order on the gateway's machine."));
await p.click('#panel-settings [data-bs="save-change"]');
check("R2-01 after saving: Gateway chooses, with the retained order and the command to clear it", (await pane(p)).includes("The gateway still has an order for Otto that names only OpenAI · Work, so it keeps using that account alone.") && (await p.evaluate(() => [...document.querySelectorAll("#panel-settings .command-line code")].some((c) => c.textContent === "openclaw models auth order clear --provider openai --agent otto"))));
check("R2-01 the account row reads Gateway chooses", (await p.evaluate(() => { document.querySelector('#panel-settings [data-bs="main"]').click(); return document.querySelector('#panel-settings [data-bs="account"]').textContent; })).includes("Gateway chooses"));
await p.evaluate(() => { delete window.botSettings.GW.order.otto; });
await p.click('#panel-settings [data-bs="account"]');
check("R2-01 the line goes when the page's own read finds the order gone", !(await pane(p)).includes("still has an order"));
await p.close();

// FM-03: what the page shows when its evidence of the lock is old, unreadable or gone.
for (const [lock, words, word] of [
  ["readfail", "Couldn't read the gateway's order for Otto. Last confirmed locked at 5:41 PM.", "Locked, as of 5:41 PM"],
  ["gone", "The lock is gone: the gateway's order for Otto changed at or before 5:52 PM.", "Bound"],
  ["old", "Last checked at 5:41 PM. Clawtrate checks again when it reconnects.", "Locked, as of 5:41 PM"],
  ["multi", "lists OpenAI · Work and 1 more account, so it is not a lock", "Bound"],
]) {
  p = await open(`bot=otto&panel=open&tab=settings&lock=${lock}`);
  const row = await text(p, '#panel-settings [data-bs="account"]');
  await p.click('#panel-settings [data-bs="account"]');
  check(`FM-03 lock evidence ${lock}: says so, and the row reads ${word}`, (await pane(p)).includes(words) && row.includes(word), row);
  await p.close();
}

// Served by another account.
p = await open("bot=otto&served=1");
check("P2 the bot's row warns that another account was used", await p.evaluate(() => { const r = document.querySelector('.bot[data-bot="marlow"]'); const pv = r.querySelector(".bot-preview"); return pv.dataset.tone === "warn" && pv.textContent === "Tried another account" && r.getAttribute("aria-label").includes("the gateway tried another account"); }));
await p.click('.bot[data-bot="marlow"]');
check("FM-04 the task's line says only what the log shows: the bound account failed and the gateway tried another", (await text(p, '[data-testid="served-line"] summary')).includes("OpenAI · Work failed (rate limited), and the gateway tried another OpenAI account, likely Home.") && !(await text(p, "#transcript")).includes("finished this run on"));
check("P2 opening the task clears the row's warning", await p.evaluate(() => !document.querySelector('.bot[data-bot="marlow"] .bot-preview[data-tone]')));
await p.click('[data-testid="served-line"] summary');
check("P2 opened, the line says what is inferred and what the gateway does not say", (await text(p, '[data-testid="served-line"]')).includes("It doesn't say which account served the run") && (await text(p, '[data-testid="served-line"]')).includes("Inferred:"));
await p.click('[data-testid="served-line"] [data-bs="raw"]');
check("P2 Raw shows the gateway's log record", (await text(p, '[data-testid="served-line"] .b-raw')).includes('"decision": "rotate_profile"'));
await p.click('[data-testid="served-line"] [data-bs="open-settings"]');
check("P2 the line leads to the bot's account", (await pane(p)).includes("4:58 PM: OpenAI · Work failed (rate limited) and the gateway tried another OpenAI account.") && (await pane(p)).includes("Lock to this account"));
await p.close();

// FM-04: the row's warning clears on a confirmed lock, and what the settings cannot see.
p = await open("bot=otto&served=1");
await p.evaluate(() => { window.botSettings.GW.order.marlow = ["openai:work"]; window.botSettings.readOrder("marlow"); });
await p.click('.bot[data-bot="juniper"]');
check("FM-04 a confirmed lock clears the row's warning", await p.evaluate(() => !document.querySelector('.bot[data-bot="marlow"] .bot-preview[data-tone]')));
await p.close();
p = await open("bot=marlow&panel=open&tab=settings&bview=account&log=none");
check("FM-04 when the gateway's log can't be read, the account page says what it cannot see", (await pane(p)).includes("Clawtrate can't read the gateway's log, so it can't tell you when the gateway tries another account."));
await p.close();
p = await open("bot=marlow&panel=open&tab=settings&bview=account&log=gap");
check("FM-04 when part of the log was missed, it says when", (await pane(p)).includes("Clawtrate missed part of the gateway's log, between 4:10 and 4:30 PM"));
await p.close();

// An account that fails.
p = await open("fail=quota");
check("FM-04 out of quota: the bound account named as bound, and as failed only from the log", (await text(p, '[data-testid="account-error"]')).includes("The gateway reports a billing failure from OpenAI. Otto is bound to OpenAI · Work; the gateway's log names it as the account that failed.") && !(await text(p, '[data-testid="account-error"]')).includes("Otto's account, OpenAI · Work, is out of"));
check("P2 out of quota: Change account and Try again", await p.evaluate(() => [...document.querySelectorAll('[data-testid="account-error"] .button')].map((b) => b.textContent).join("|").startsWith("Change account|Try again")));
check("P2 the bot's row shows the failure", await p.evaluate(() => document.querySelector('.bot[data-bot="otto"] .bot-preview').dataset.tone === "danger"));
await p.click('[data-testid="account-error"] [data-bs="change-account"]');
check("P2 Change account opens the bot's settings on it", (await pane(p)).includes("Change account") && (await p.evaluate(() => document.querySelector("#tab-settings").getAttribute("aria-selected") === "true")));
await p.close();
p = await open("fail=signedout");
await p.click('[data-testid="account-error"] [data-bs="sign-in-again"]');
await p.clock.runFor(900);
check("P2 signed out: Sign in again starts the provider's sign-in in Settings", (await dlg(p, "settings-dialog")) && (await text(p, "#b-section-title")).startsWith("Sign in to ChatGPT"));
await p.close();

// FM-11: which catalogue the model list shows, and effort following the model.
p = await open("bot=marlow&panel=open&tab=settings");
check("FM-11 a bot with a task: the models the gateway lists for its account in its latest task", (await text(p, "#b-model-line")).includes("The models OpenAI · Work offers, as the gateway lists them for Marlow's latest task."));
await p.click('#panel-settings [data-b-select="model"]');
check("FM-11 a model the gateway lists as unavailable is shown, marked", (await text(p, '.b-menu [data-value="gpt-5.5-codex"]')).includes("Not available"));
await p.keyboard.press("Escape");
check("FM-17 Escape in the menu closes the menu alone and returns focus to the select", await p.evaluate(() => !document.querySelector(".b-menu") && document.activeElement.dataset.bSelect === "model" && window.app.model.panel));
await p.evaluate(() => (window.bots.binding.marlow.effort = "High"));
await p.click('#panel-settings [data-b-select="model"]');
await p.click('.b-menu [data-value="gpt-5.5-mini"]');
check("FM-11 changing to a model without the effort takes one it offers, and says so", (await text(p, "#b-model-line")).includes("Effort is now Low: gpt-5.5-mini doesn't offer High.") && (await text(p, '#panel-settings [data-b-select="effort"]')).includes("Low"));
await p.focus('#panel-settings [data-b-select="effort"]');
await p.keyboard.press("ArrowDown");
check("FM-17 Down opens a closed select", await p.evaluate(() => !!document.querySelector(".b-menu")));
await p.close();
p = await open("open=create&step=account&name=Viral&chosen=xai:default");
check("FM-11 a new bot: the provider's models, and whose decision the rest is", (await text(p, "#create-dialog")).includes("xAI's models, as the gateway lists them. Which ones this account may use is xAI's decision."));
await p.close();

// FM-12: provider tools from the gateway's inventory.
p = await open("bot=juniper&panel=open&tab=settings&xaitools=1");
check("FM-12 xAI's tools can be listed for a bot on another provider, from the gateway's tool list", (await text(p, "#panel-settings")).includes("From xAI") && (await text(p, "#panel-settings")).includes("From the gateway's tool list for Juniper's latest task"));
check("FM-12 no Ask without the rules plugin, and it says so", !(await text(p, "#panel-settings .facts:has([title=x_search])")).includes("Ask") && (await text(p, "#panel-settings")).includes("Asking first needs Clawtrate's rules plugin."));
await p.close();
p = await open("bot=juniper&panel=open&tab=settings");
check("FM-12 on another provider without the tools switched on, none are listed", !(await text(p, "#panel-settings")).includes("From xAI"));
await p.close();

// Checks, the access tiers, loading, errors, no account.
p = await open("bot=pip&panel=open&tab=settings&bview=account&differs=1");
check("P2 a bot whose model has fallbacks is reported", (await pane(p)).includes("Pip can move to another model."));
await p.click('#panel-settings [data-bs="no-fallbacks"]');
check("P2 Remove fallbacks clears it", !(await pane(p)).includes("Pip can move to another model."));
await p.close();
p = await open("bot=marlow&panel=open&tab=settings&access=read");
check("P2 read-only: values shown, nothing to change, the admin request", await p.evaluate(() => [...document.querySelectorAll("#panel-settings .b-select")].every((s) => s.disabled) && document.querySelector("#panel-settings .access-bar").textContent.includes("Changing Marlow's settings needs admin access.")));
await p.click('#panel-settings [data-bs="account"]');
check("P2 read-only: no Change account", !(await p.evaluate(() => document.querySelector('#panel-settings [data-bs="change"]'))));
await p.close();
p = await open("bot=marlow&panel=open&tab=settings&bstate=loading");
check("P2 loading", await p.evaluate(() => !!document.querySelector('#panel-settings [aria-busy="true"]')));
await p.close();
p = await open("bot=marlow&panel=open&tab=settings&bstate=error");
check("P2 could not load", (await pane(p)).includes("Couldn't load Marlow's settings"));
await p.click('#panel-settings [data-bs="reload"]');
check("P2 Try again loads", (await pane(p)).includes("Account"));
await p.close();
p = await open("open=settings&section=accounts&account=openai:home&bot=pip&panel=open&tab=settings");
await p.click('[data-b="disconnect"]');
await p.click('[data-b="confirm-ok"]');
await p.keyboard.press("Escape");
await p.click('#panel-settings [data-bs="account"]');
check("P2 after its account is disconnected, the bot has No account and is not started", (await pane(p)).includes("No account. Pip's account was disconnected. Clawtrate won't start Pip until you choose one."));
await p.close();
p = await open("bot=marlow&panel=open&tab=details");
await p.focus("#tab-details");
await p.keyboard.press("End");
check("P2 keyboard: End reaches the Settings tab", await p.evaluate(() => document.activeElement.id === "tab-settings" && !document.querySelector("#panel-settings").hidden));
await p.close();
p = await open("bot=marlow&panel=open&tab=settings", { width: 390, height: 844 });
check("P2 phone: the settings are a full-width sheet", await p.evaluate(() => Math.round(document.querySelector("#work-panel").getBoundingClientRect().width) === 390));
await p.close();

// Part 3: T3 Code ----------------------------------------------------------------------------------
p = await open("open=settings&section=integrations");
check("P3 Settings has Integrations with the T3 Code switch, off", await p.evaluate(() => document.querySelector('[data-t3="toggle"]').getAttribute("aria-checked") === "false" && document.querySelector('[data-t3="toggle"]').getAttribute("role") === "switch"));
check("P3 off: nothing else about T3 Code in Settings", await p.evaluate(() => !document.querySelector("#settings-dialog [data-t3-address]") && !document.querySelector("#settings-dialog").textContent.includes("The gateway's sign-in")));
await p.keyboard.press("Escape");
await p.evaluate(() => { window.app.setPanel(true); document.querySelector("#tab-settings").click(); });
check("P3 off: nothing about T3 Code in a bot's settings", !(await text(p, "#panel-settings")).includes("T3 Code"));
await p.close();
p = await open("open=settings&section=integrations&t3server=none");
await p.click('[data-t3="toggle"]');
check("P3 on: the server's address is asked for", await p.evaluate(() => document.querySelector('[data-t3="toggle"]').getAttribute("aria-checked") === "true" && !!document.querySelector("[data-t3-address]")));
await p.fill("[data-t3-address]", "http://code.example.net");
await p.click('[data-t3="add"]');
check("P3 a plain-http address is refused, and why", (await text(p, "#t3-error")).includes("only over https, or on localhost"));
await p.fill("[data-t3-address]", "https://code.example.net");
await p.click('[data-t3="add"]');
check("FM-09 added: the gateway's command-line sign-in in full, with the --code continuation", await p.evaluate(() => { const c = [...document.querySelectorAll("#settings-dialog .command-line code")].map((x) => x.textContent); const t = document.querySelector("#settings-dialog").textContent; return c[0] === "openclaw mcp login t3code" && c[1] === "openclaw mcp login t3code --code <code>" && t.includes("it waits 5 minutes") && t.includes("MCP OAuth credentials saved"); }));
check("FM-07 nothing observed yet, and how it will be learned", (await text(p, "#settings-dialog")).includes("Not observed yet") && (await text(p, "#settings-dialog")).includes("when a bot with T3 Code on makes its first T3 Code call"));
await p.keyboard.press("Escape");
await p.evaluate(() => { window.app.setPanel(true); document.querySelector("#tab-settings").click(); });
check("FM-06 a bot's switch works once the server is added, before any sign-in is observed", await p.evaluate(() => { const s = document.querySelector('#panel-settings [data-t3="bot-toggle"]'); return s && !s.disabled && document.querySelector("#panel-settings").textContent.includes("Whether the gateway's sign-in works shows with the first call."); }));
await p.close();
p = await open("open=settings&section=integrations&t3=on&t3obs=none&t3origin=1");
await p.click('[data-t3="signin"]');
check("P3 a qualifying connection starts the gateway's sign-in", (await text(p, "#settings-dialog .b-section-body")).includes("Asking the gateway to start the sign-in"));
await p.clock.runFor(900);
check("P3 waiting: approve on T3 Code's page, or a pairing code", (await text(p, "#settings-dialog .b-section-body")).includes("enter a pairing code") && (await text(p, "#settings-dialog .b-wait")).includes("10 minutes"));
await p.click('[data-t3="cancel"]');
check("FM-05 a cancelled T3 Code sign-in claims nothing about what was saved", (await text(p, "#settings-dialog .b-result")).includes("Sign-in cancelled") && !(await text(p, "#settings-dialog")).includes("Nothing was saved"));
await p.evaluate(() => window.t3.observe("saved"));
check("FM-07 saved by Clawtrate's own sign-in: when, and the date it ends", await p.evaluate(() => { const t = document.querySelector("#settings-dialog .b-section-body").textContent; return t.includes("Saved by Clawtrate's sign-in, Nov 17, 5:36 PM") && t.includes("By Dec 17 (T3 Code ends a sign-in after 30 days)"); }));
await p.close();
p = await open("open=settings&section=integrations&t3=on");
check("FM-07 never Signed in from cached tools: what was observed, the listing marked as cached, and what it cannot see", await p.evaluate(() => { const t = document.querySelector("#settings-dialog .b-section-body").textContent; return !t.includes("Signed in") && t.includes("Worked: Otto's T3 Code call returned") && t.includes("a cached list, not a check of the sign-in") && t.includes("Unknown: Clawtrate didn't see this sign-in made.") && t.includes("can't see a sign-in that was revoked or ended in T3 Code until a call is refused"); }));
await p.close();
for (const [q, words] of [["t3obs=refused", "Refused: Otto's T3 Code call"], ["t3listing=notconnected", "The gateway says: not connected"], ["t3signin=failed&t3origin=1", "Couldn't sign in"], ["t3signin=expired&t3origin=1", "The sign-in expired"]]) {
  p = await open(`open=settings&section=integrations&t3=on&${q}`);
  check(`P3 ${q}: says so`, (await text(p, "#settings-dialog .b-section-body")).includes(words));
  await p.close();
}
p = await open("open=settings&section=integrations&t3=on&t3found=1");
check("P3 a bot with the tools that was not turned on is reported", (await text(p, "#settings-dialog")).includes("Pip has the T3 Code tools without being turned on"));
await p.click('[data-t3="deny"]');
check("P3 and can be turned off for it", !(await text(p, "#settings-dialog")).includes("Pip has the T3 Code tools"));
await p.click('[data-t3="toggle"]');
check("FM-08 admin: turning the switch off asks, says bots are shared, and offers to only hide it", (await dlg(p, "confirm-dialog")) && (await text(p, "#confirm-text")).includes("Bots are shared: turning it off for Otto turns it off for everyone who uses it") && (await p.evaluate(() => [...document.querySelectorAll("#confirm-dialog .button")].map((b) => b.textContent).join("|"))) === "Cancel|Only hide it|Turn off for Otto too");
await p.click('[data-b="confirm-alt"]');
check("FM-08 Only hide it hides T3 Code for this person and leaves Otto's on", await p.evaluate(() => document.querySelector('[data-t3="toggle"]').getAttribute("aria-checked") === "false" && window.bots.binding.otto.t3.on && document.querySelector("#settings-dialog").textContent.includes("Off for you. Otto has T3 Code on at the gateway; this doesn't change that.")));
await p.close();
p = await open("open=settings&section=integrations&t3=on");
await p.click('[data-t3="toggle"]');
await p.click('[data-b="confirm-ok"]');
check("FM-08 Turn off for Otto too turns it off at the gateway as well", await p.evaluate(() => document.querySelector('[data-t3="toggle"]').getAttribute("aria-checked") === "false" && !window.bots.binding.otto.t3.on));
await p.close();
p = await open("open=settings&section=integrations&t3=on&access=write");
await p.click('[data-t3="toggle"]');
check("FM-08 interactive: turning it off only hides it, and says Otto keeps it", (await text(p, "#confirm-text")).includes("Otto has T3 Code on at the gateway, and keeps it: turning it off for it needs admin access. This only hides T3 Code in Clawtrate for you.") && (await p.evaluate(() => !document.querySelector('#confirm-dialog [data-b="confirm-alt"]'))));
await p.close();
p = await open("open=settings&section=integrations&t3=on&t3write=partial");
await p.click('[data-t3="toggle"]');
await p.click('[data-b="confirm-ok"]');
check("FM-13 turning off for bots that partly fails names the bot still on, with Try again for it", (await text(p, "#settings-dialog")).includes("T3 Code is still on for Otto.") && (await p.evaluate(() => !!document.querySelector('[data-t3="retry-off"]'))));
await p.close();
p = await open("open=settings&section=integrations&t3=on&t3server=none&t3write=refused");
await p.fill("[data-t3-address]", "https://code.example.net");
await p.click('[data-t3="add"]');
check("FM-13 a refused Add says nothing changed and offers Try again", (await text(p, "#settings-dialog")).includes("Couldn't add T3 Code: the gateway refused the change. Nothing changed.") && (await text(p, '[data-t3="add"]')) === "Try again");
await p.close();
p = await open("open=settings&section=integrations&t3=on&t3server=none&t3write=timeout");
await p.fill("[data-t3-address]", "https://code.example.net");
await p.click('[data-t3="add"]');
check("FM-13 an unanswered Add is read back before anything is sent again", (await text(p, "#settings-dialog")).includes("Checking whether T3 Code was added"));
await p.close();
p = await open("t3=on&bot=marlow&panel=open&tab=settings");
check("P3 a bot's switch is a plain switch, with no picture in it", await p.evaluate(() => !document.querySelector('#panel-settings [data-t3="bot-toggle"] svg')));
check("P3 each bot has its own T3 Code switch, off by default", await p.evaluate(() => document.querySelector('#panel-settings [data-t3="bot-toggle"]').getAttribute("aria-checked") === "false"));
await p.click('#panel-settings [data-t3="bot-toggle"]');
check("P3 turned on, the bot gets its limits", (await text(p, '#panel-settings [data-bs="t3"]')).includes("All projects, asks first"));
await p.click('#panel-settings [data-bs="t3"]');
check("P3 limits: projects, providers and models, and asking first, on by default", await p.evaluate(() => { const t = document.querySelector("#panel-settings").textContent; return t.includes("Projects") && t.includes("Providers and models") && document.querySelector('[data-t3="ask"]').getAttribute("aria-checked") === "true"; }));
check("FM-17 the projects group has one tab stop", await p.evaluate(() => [...document.querySelectorAll('#panel-settings [data-t3="projects"]')].filter((b) => b.tabIndex === 0).length === 1));
await p.click('#panel-settings [data-t3="projects"][data-value="some"]');
check("P3 only some projects needs at least one, and nothing is saved until then", (await text(p, "#panel-settings")).includes("Choose at least one project, or allow all. Nothing is saved until then."));
await p.click('#panel-settings [data-bs="main"]');
await p.clock.runFor(60);
check("FM-17 Back returns focus to the row that opened the page", await p.evaluate(() => document.activeElement.dataset.bs === "t3"));
await p.close();
// R2-04: a bot that follows the gateway's default skill list.
p = await open("t3=on&skilldef=1&bot=marlow&panel=open&tab=settings");
await p.click('#panel-settings [data-t3="bot-toggle"]');
check("R2-04 enabling for a bot on a default list without the skill asks first, saying it stops following the default", (await dlg(p, "confirm-dialog")) && (await text(p, "#confirm-text")).includes("Marlow follows the gateway's default list of skills. To give Marlow the T3 Code skill, Clawtrate gives Marlow a list of its own: today's default list plus T3 Code. From then on, Marlow stops following the gateway's default list"));
await p.click('[data-b="confirm-ok"]');
check("R2-04 the bot's own list is the default list plus the skill, read back before it is said to be in place", await p.evaluate(() => JSON.stringify(window.bots.binding.marlow.skills) === JSON.stringify(["github", "weather", "clawtrate-t3"]) && document.querySelector("#panel-settings").textContent.includes("It no longer follows the default list.")));
await p.click('#panel-settings [data-t3="bot-toggle"]');
check("R2-04 turning it off, with the list unchanged since, removes the list: the bot follows the default again", await p.evaluate(() => window.bots.binding.marlow.skills === undefined));
await p.close();
p = await open("t3=on&skilldef=1&skillchanged=1&bot=marlow&panel=open&tab=settings");
await p.click('#panel-settings [data-t3="bot-toggle"]');
await p.click('[data-b="confirm-ok"]');
await p.click('#panel-settings [data-t3="bot-toggle"]');
check("R2-04 when the person changed the list since, turning off removes only the skill", await p.evaluate(() => JSON.stringify(window.bots.binding.marlow.skills) === JSON.stringify(["github", "weather", "docs-search"])));
await p.close();
p = await open("t3=on&skilldef=1&skillread=fail&bot=marlow&panel=open&tab=settings");
await p.click('#panel-settings [data-t3="bot-toggle"]');
await p.click('[data-b="confirm-ok"]');
check("R2-04 when the read-back doesn't show the skill, the switch says so", (await text(p, "#panel-settings")).includes("On. Clawtrate couldn't confirm the T3 Code skill for Marlow."));
await p.close();
p = await open("t3=on&bot=marlow&panel=open&tab=settings");
await p.click('#panel-settings [data-t3="bot-toggle"]');
check("R2-04 with no default list (every loaded skill visible), nothing is written and no confirmation is asked", await p.evaluate(() => !document.querySelector("#confirm-dialog").open && window.bots.binding.marlow.skills === undefined));
await p.close();
p = await open("t3=on&t3withheld=1&bot=otto&panel=open&tab=settings");
check("FM-15 on, but withheld by the gateway's policy: said with the gateway's notice", (await text(p, "#panel-settings")).includes("On, but the gateway doesn't offer Otto the T3 Code tools: not connected."));
await p.close();
p = await open("t3=on&t3plugin=0&bot=otto&panel=open&tab=settings");
check("FM-15 without Clawtrate's plugin, the switch says there are no instructions", (await text(p, "#panel-settings")).includes("Without Clawtrate's plugin, Otto gets the T3 Code tools without Clawtrate's instructions for them."));
await p.close();
p = await open("t3=on&t3plugin=0&bot=otto&panel=open&tab=settings&bview=t3");
check("P3 without Clawtrate's plugin, the limits say what that means", (await text(p, "#panel-settings")).includes("Limits need Clawtrate's plugin on the gateway."));
await p.close();
p = await open("t3=on&t3catalog=error&bot=otto&panel=open&tab=settings&bview=t3");
check("FM-15 the lists couldn't load: said, with the saved limits still in force", (await text(p, "#panel-settings")).includes("Couldn't load T3 Code's projects") && (await text(p, "#panel-settings")).includes("The saved limits still apply: website."));
await p.close();
p = await open("t3=on&t3server=none&bot=marlow&panel=open&tab=settings");
check("P3 before the server is added, a bot's switch is disabled and says why", await p.evaluate(() => document.querySelector('#panel-settings [data-t3="bot-toggle"]').disabled && document.querySelector("#panel-settings").textContent.includes("Add T3 Code in Settings first.")));
await p.close();
p = await open("open=settings&section=integrations&t3=on&access=write");
check("P3 below admin: the admin request; the switch itself still works", await p.evaluate(() => !document.querySelector('[data-t3="toggle"]').disabled && document.querySelector("#settings-dialog .access-bar").textContent.includes("Adding T3 Code to the gateway needs admin access.")));
await p.close();
p = await open("open=settings&section=integrations&access=read");
check("FM-08 read-only: the switch is disabled, and the request is for sending, not admin", await p.evaluate(() => document.querySelector('[data-t3="toggle"]').disabled && document.querySelector("#settings-dialog .access-bar").textContent.includes("This is your own preference; saving it needs this device to be able to send.") && !document.querySelector("#settings-dialog .access-bar").textContent.includes("admin")));
await p.click('[data-b="request-write"]');
check("FM-08 granted the interactive tier, the switch can be turned on", await p.evaluate(() => !document.querySelector('[data-t3="toggle"]').disabled));
await p.close();

await b.close();
console.log(out.join("\n"));
const oks = out.filter((l) => l.startsWith("ok")).length;
console.log(`\n${oks} ok, ${failed} not ok`);
process.exit(failed || out.some((l) => l.startsWith("PAGEERROR")) ? 1 : 0);
