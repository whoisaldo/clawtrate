// Bots, accounts and T3 Code: the screens in docs/design/bots.md, on top of the
// shell in app.js. None of this talks to a gateway. Accounts, sign-ins and
// models are local fixtures; the provider labels, links and codes are samples.
//
// The address picks a state, which is how the screenshots are taken:
//   open=create|settings     a dialog to open on load
//   step=look|account|connect (create)   section=accounts (settings)
//   account=<profile id>     an account's page in Settings
//   connect=<auth choice>    a sign-in method, with stage=starting|waiting|entering|
//                            checking|connected|failed|expired|cancelled|dropped|busy|domain
//   apikey=open              the API key form, opened
//   access=read|write|admin  what the connection may do (default admin)
//   req=asking|requested|denied|expired|failed|granted   the request for admin access
//   accounts=none            no account connected yet
//   chosen=<profile id>      the account chosen in the Account step
//   create=creating|slow|failed
//   step=approvals           the Approvals step; perm=ask|full chooses in it (nothing by default)
//   The host's results for Create (bots.md section 3, controls.md section 10), chosen here,
//   independent of what is clicked:
//   create=timeout           agents.create's reply is lost: not confirmed, nothing more is sent
//   create=partial           step 2 (Never, the restrictive list, fallbacks: []) doesn't read back
//   create=conflict          the config's hash changed before step 3: it stops, writing nothing
//   readback=pending|mismatch|fail   step 3's read of the saved mode (mismatch reads Never)
//   label=guarded|full|read-only|none   the gateway's reported default command policy for the
//                            new bot (default: guarded for Ask, full for Full)
//   approvals=deny           the approvals file, read before Create, blocks commands
//   retry=fail|gone          "Write it again": its read-back fails, or the bot is no longer
//                            identified, so the retry isn't offered
//   state=nobots             the gateway's replies for a confirmed unused implicit main: the
//                            first-bot prompt (bots.md section 3). roster=used (main has tasks),
//                            legacy (main in the legacy agents.list), missing (no session reply)
//                            or fail (agents.list failed) each give the normal roster
//   defperm=guarded|full|read-only|none   Main's reported policy, on the prompt below admin
//   name=<text>              the new bot's name

(function () {
  const CT = window.CT;
  const app = window.app;
  const params = CT.params;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (text) =>
    String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const icon = (name, cls) => CT.icon(name, cls);
  const p = (name) => params.get(name);

  // Fixtures -------------------------------------------------------------------------------------

  const PROVIDERS = { xai: "xAI", openai: "OpenAI", "github-copilot": "GitHub Copilot", anthropic: "Anthropic", minimax: "MiniMax", openrouter: "OpenRouter" };

  // kind: subscription (a sign-in Clawtrate started and knows is a plan), key
  // (an API key, or a sign-in that saves one), gateway (added on the gateway;
  // its storage type alone does not say how it is billed).
  let accounts = [
    { id: "openai:work", provider: "openai", label: "Work", kind: "subscription", type: "oauth", how: "ChatGPT sign-in with a code", status: "ok" },
    { id: "openai:home", provider: "openai", label: "Home", kind: "subscription", type: "oauth", how: "ChatGPT sign-in in the browser", status: "ok" },
    { id: "xai:default", provider: "xai", label: "Personal", kind: "subscription", type: "oauth", how: "xAI sign-in with a code", status: "ok" },
    { id: "github-copilot:github", provider: "github-copilot", label: "", kind: "subscription", type: "token", how: "GitHub sign-in with a code", status: "expiring", expiry: "in 3 days", expiryDate: "Nov 20" },
    { id: "anthropic:manual", provider: "anthropic", label: "Lab key", kind: "key", type: "api_key", how: "API key, entered in Clawtrate", status: "static" },
    // Kept in one bot's own store: only that bot can use it.
    { id: "anthropic:pip", provider: "anthropic", label: "Pip's key", kind: "key", type: "api_key", how: "API key, added on the gateway for Pip", status: "static", owner: "pip" },
  ];
  const shared = () => accounts.filter((a) => !a.owner);
  if (p("accounts") === "none") accounts = [];

  // Each bot's binding: its account, model and effort, and whether the gateway
  // has a one-account order for it (locked). account null: no account of its own.
  const binding = {
    otto: { account: "openai:work", model: "gpt-5.5", effort: "Medium", locked: true },
    marlow: { account: "openai:work", model: "gpt-5.5", effort: "Low", locked: false },
    pip: { account: "openai:home", model: "gpt-5.5-mini", effort: "Low", locked: false },
    juniper: { account: "anthropic:manual", model: "claude-sonnet-5.5", effort: "High", locked: false },
  };
  if (p("accounts") === "none") Object.values(binding).forEach((b) => Object.assign(b, { account: null, mode: "gateway" }));

  // Models the gateway lists for each provider, and the effort levels it offers.
  const MODELS = {
    xai: ["grok-4.7", "grok-4.6", "grok-4.5", "grok-build-0.1"],
    openai: ["gpt-5.5", "gpt-5.5-mini", "gpt-5.5-codex"],
    "github-copilot": ["gpt-5.5", "claude-sonnet-5.5"],
    anthropic: ["claude-sonnet-5.5", "claude-opus-5.5"],
    minimax: ["minimax-m3"],
    openrouter: ["openrouter/auto"],
  };
  const EFFORTS = ["Off", "Low", "Medium", "High"];
  // agents.defaults.model.primary. defacct=<id> gives it an @account, as a gateway may.
  const DEFAULT_MODEL = { provider: "openai", model: "gpt-5.5", account: p("defacct") || null };
  const GATEWAY = "__gateway"; // "Let the gateway choose": the provider's model, no fixed account

  // The sign-in methods the gateway can start, as it lists them. flow is what
  // the person does: code (open a link, enter a code; the gateway polls), paste
  // (open a link, paste a code back), host (finishes on the gateway's machine),
  // domain (a company address first, then a code).
  const OPTIONS = [
    { id: "xai/xai-oauth", provider: "xai", label: "xAI", hint: "SuperGrok or X Premium", flow: "code", group: "sub" },
    { id: "openai/openai-device-code", provider: "openai", label: "ChatGPT", hint: "Plus, Pro or Business", flow: "code", group: "sub" },
    { id: "openai/openai", provider: "openai", label: "ChatGPT in the browser", hint: "Plus, Pro or Business", flow: "paste", group: "sub" },
    { id: "openai/openai-token-sharing", provider: "openai", label: "Sign in with ChatGPT", hint: "Plus, Pro or Business", flow: "host", group: "sub" },
    { id: "github-copilot/github-copilot", provider: "github-copilot", label: "GitHub Copilot", hint: "Copilot subscription", flow: "code", group: "sub" },
    { id: "github-copilot/github-copilot-enterprise", provider: "github-copilot", label: "GitHub Copilot Enterprise", hint: "Your company's GitHub", flow: "domain", group: "sub" },
    { id: "minimax/minimax-global-oauth", provider: "minimax", label: "MiniMax", hint: "Coding plan", flow: "code", group: "sub" },
    { id: "openrouter/openrouter-oauth", provider: "openrouter", label: "OpenRouter", hint: "Credits", flow: "paste", group: "token" },
  ];
  const FLOW_WORDS = {
    code: "Open a page and enter a code",
    paste: "Open a page, then paste a code back here",
    host: "Finishes in a browser on the gateway's machine",
    domain: "Your company's GitHub address, then a code",
  };
  const KEY_PROVIDERS = ["openai", "anthropic", "xai", "openrouter", "minimax"];
  // Where a sign-in lands is read after it, from each bot's view (section 5).
  // nomain=1: the gateway has no main bot without a folder of its own, so it is
  // known before the sign-in that the account will be kept by one bot.
  const NO_MAIN = p("nomain") === "1";
  const LANDED = p("landed") || (NO_MAIN ? "otto" : null);

  const BOT_ART_BODIES = ["pebble", "block", "arch", "bloom", "disc", "hex", "drop", "gem"];
  const BOT_ART_COLORS = ["#58c26f", "#5b8dff", "#ff8552", "#a98bff", "#f6bd3b", "#ff6f9c", "#45bdf5", "#a5d955"];

  // State ------------------------------------------------------------------------------------------

  const B = {
    access: ["read", "write", "admin"].includes(p("access")) ? p("access") : "admin",
    req: p("req") || "none", // the request for admin access
    draft: { name: p("name") ?? "", body: "drop", color: "#ff6f9c", account: p("chosen") || DEFAULT_MODEL.account || null, model: null, effort: "Medium", perm: ["ask", "full"].includes(p("perm")) ? p("perm") : null },
    create: { step: p("step") || "look", status: p("create") || "idle", opener: null },
    connect: null, // { from, view, option, stage, ... }
    settings: { section: p("section") || "gateway", account: p("account") || null, pane: p("account") || p("section") ? "section" : "nav", edit: false },
    seconds: 4,
    grantedNote: false,
    accountsState: p("accts") || "ready", // loading, error
  };
  if (B.draft.account) B.draft.model = firstModel(draftProvider());

  function draftProvider() {
    return B.draft.account === GATEWAY ? DEFAULT_MODEL.provider : acct(B.draft.account)?.provider;
  }
  // The gateway's default model when it belongs to the provider, else the provider's first.
  function firstModel(provider) {
    if (!provider) return null;
    return provider === DEFAULT_MODEL.provider ? DEFAULT_MODEL.model : MODELS[provider][0];
  }
  function acct(id) {
    return accounts.find((a) => a.id === id) || null;
  }
  const isAdmin = () => B.access === "admin";
  const providerName = (id) => PROVIDERS[id] || id;
  // Labels reach admin connections only, so below admin an account is its provider.
  const acctName = (a) => (!a ? "No account" : isAdmin() ? `${providerName(a.provider)}${a.label ? ` · ${a.label}` : ""}` : `${providerName(a.provider)} ${a.id}`);
  // Below admin the gateway sends no label, so the row shows the account's id
  // on the gateway, which is what tells two accounts of one provider apart there.
  const acctTitle = (a) =>
    isAdmin()
      ? a.label
        ? `${esc(providerName(a.provider))} <span>· ${esc(a.label)}</span>`
        : esc(providerName(a.provider))
      : `${esc(providerName(a.provider))} <span class="mono">${esc(a.id)}</span>`;
  const kindWord = (a) => ({ subscription: "Subscription", key: "API key", gateway: "Added on the gateway" })[a.kind];
  const usedBy = (id) =>
    Object.entries(binding)
      .filter(([, b]) => b.account === id)
      .map(([bot]) => app.bots.find((x) => x.id === bot)?.name)
      .filter(Boolean);
  // A sign-in the gateway renews by itself (oauth) shows no expiry: an expired
  // access token is refreshed when it is next used. Only a token it cannot renew does.
  const stateOf = (a) => {
    if (a.status === "missing") return ["warn", "Needs sign-in"];
    if (a.type === "token" && a.status === "expiring") return ["warn", `Expires ${a.expiry}`];
    if (a.type === "token" && a.status === "expired") return ["warn", "Expired"];
    return ["", "Connected"];
  };
  const ordered = () => [...accounts].sort((x, y) => ["subscription", "key", "gateway"].indexOf(x.kind) - ["subscription", "key", "gateway"].indexOf(y.kind));

  function announce(text) {
    const live = $("#b-announce");
    live.textContent = "";
    setTimeout(() => (live.textContent = text), 30);
  }

  // Small pieces -----------------------------------------------------------------------------------

  const button = (label, attrs = "", variant = "") =>
    `<button type="button" class="button"${variant ? ` data-variant="${variant}"` : ""} ${attrs}>${label}</button>`;
  const close = (label) => `<button type="button" class="icon-button b-close" data-b="close" aria-label="${label}">${icon("x")}</button>`;
  const back = (label, action) => `<button type="button" class="icon-button b-back" data-b="${action}" aria-label="${label}">${icon("back")}</button>`;
  const copy = (what, text) => CT.copyButton ? CT.copyButton(what, text) : `<button type="button" class="copy" aria-label="Copy ${esc(what)}" data-what="${esc(what)}" data-copy="${esc(text)}">${icon("copy")}</button>`;
  const note = (html, tone = "", lead = "") =>
    `<div class="b-note"${tone ? ` data-tone="${tone}"` : ""}>${lead || icon(tone ? "warning" : "clock")}<div>${html}</div></div>`;
  const glyph = (state) => `<span class="glyph" data-state="${state}" aria-hidden="true"></span>`;
  const wait = (text) => `<p class="b-wait" role="status"><span class="status-dot" data-status="connecting"></span>${text}</p>`;
  const result = (tone, mark, title, text) =>
    `<div class="b-result"><span class="empty-mark" data-tone="${tone}">${icon(mark)}</span><h3 tabindex="-1" data-b-focus>${title}</h3><p>${text}</p></div>`;

  // A character drawn from the draft's body and colour, through the shell's own drawing.
  function draftArt() {
    CT.botArt.__draft = { body: B.draft.body, color: B.draft.color, tilt: 0, look: [0.6, 0] };
    return CT.character("__draft");
  }

  // The request for admin access: the access bar of conversation.md section 3,
  // with words for what this screen needs.
  const REQUEST = "3f9a2c71";
  function adminBar(need) {
    if (B.grantedNote)
      return `<section class="access-bar" role="region" aria-label="Access" data-state="granted"><div class="access-row">${glyph("done")}<span class="shelf-text"><b>Admin access granted.</b> You can change this now.</span></div></section>`;
    const rows = {
      none: [`${icon("eye")}<span class="shelf-text"><b>${B.access === "read" ? "Read-only." : "Admin access needed."}</b> ${need}</span>`, button("Request admin access", 'data-b="request" data-size="sm"', "primary")],
      asking: [`${glyph("sending")}<span class="shelf-text" aria-busy="true">Asking the gateway…</span>`, ""],
      requested: [`${glyph("waiting")}<span class="shelf-text"><b>Waiting for the gateway's owner.</b> Approve this request on the gateway's machine:</span>`, ""],
      denied: [`${glyph("stopped")}<span class="shelf-text"><b>The request was denied.</b> Nothing changed. This device keeps the access it had.</span>`, button("Request again", 'data-b="request" data-size="sm"')],
      expired: [`${glyph("stopped")}<span class="shelf-text"><b>The request expired</b> before it was approved.</span>`, button("Request again", 'data-b="request" data-size="sm"')],
      failed: [`${icon("warning")}<span class="shelf-text"><b>Couldn't send the request.</b> The gateway did not answer.</span>`, button("Try again", 'data-b="request" data-size="sm"')],
    };
    const [text, actions] = rows[B.req] || rows.none;
    const command = `openclaw devices approve ${REQUEST}`;
    return (
      `<section class="access-bar" role="region" aria-label="Access" data-state="${B.req}"${B.req === "failed" ? ' data-tone="danger"' : ""}>` +
      `<div class="access-row">${text}${actions}</div>` +
      (B.req === "requested"
        ? `<div class="command-line"><code>${command}</code>${copy("approve command", command)}</div>` +
          `<div class="access-row"><span class="access-id">Request <span class="mono">${REQUEST}</span>${copy("request id", REQUEST)}` +
          `<span class="access-wait">checking again in ${B.seconds}s</span></span><span class="spacer"></span>` +
          button("Check now", 'data-b="request-check" data-size="sm"') +
          button("Stop waiting", 'data-b="request-cancel" data-size="sm"', "quiet") +
          `</div>`
        : "") +
      `</section>`
    );
  }

  // The account rows: the Account step, changing a bot's account, and Settings.
  function accountRow(a, { choose = false, checked = false, open = false } = {}) {
    const [tone, word] = stateOf(a);
    const users = usedBy(a.id);
    const sub =
      `${kindWord(a)}` +
      (tone ? ` · <span data-tone="${tone}">${word}</span>` : "") +
      ` · ${a.owner ? `Only ${esc(app.bots.find((x) => x.id === a.owner)?.name || a.owner)} can use it` : users.length ? esc(users.join(", ")) : "Not used yet"}`;
    const text = `<span class="b-choice-text"><span class="b-choice-title">${acctTitle(a)}</span><span class="b-choice-sub">${sub}</span></span>`;
    if (choose)
      return `<li><button type="button" class="b-choice" role="radio" aria-checked="${checked}" tabindex="${checked ? 0 : -1}" data-b-choose="${a.id}"${isAdmin() ? "" : ' aria-disabled="true"'}>${text}${icon("check", "icon b-tick")}</button></li>`;
    if (open) return `<li><button type="button" class="b-choice" data-b-account="${a.id}">${text}${icon("chevron")}</button></li>`;
    return `<li><div class="b-choice">${text}</div></li>`;
  }

  // The account blocks. A caller that makes them a radio group wraps them in
  // one element with role="radiogroup", so the group has one tab stop.
  function accountGroups(render, list = shared()) {
    const groups = [
      ["Subscriptions", list.filter((a) => a.kind === "subscription" && !a.owner)],
      ["API keys", list.filter((a) => a.kind === "key" && !a.owner)],
      ["Added on the gateway", list.filter((a) => a.kind === "gateway" && !a.owner)],
      ["Kept by one bot", list.filter((a) => a.owner)],
    ].filter(([, l]) => l.length);
    return groups.map(([title, l]) => `<h4 class="b-group">${title}</h4><ul class="b-choices">${l.map(render.row).join("")}</ul>`).join("");
  }

  // "Let the gateway choose": last in the group, set apart, in words.
  // For an existing bot, own = its model: the row then names that model, not the default.
  function gatewayRow(checked, provider = DEFAULT_MODEL.provider, own = null) {
    const who = esc(providerName(provider));
    const model = own ? `${esc(own.name)}'s own model, ${esc(own.model)}` : `its default model, ${esc(DEFAULT_MODEL.model)}`;
    const line = shared().some((a) => a.provider === provider)
      ? `No fixed account. The gateway picks one of ${who}'s accounts for each run, as its account order allows, with ${model}.`
      : `No fixed account. The gateway uses what it has for ${who}, with ${model}.`;
    return (
      `<ul class="b-choices b-gw"><li><button type="button" class="b-choice" role="radio" aria-checked="${checked}" tabindex="-1" data-b-choose="${GATEWAY}"${isAdmin() ? "" : ' aria-disabled="true"'}>` +
      `<span class="b-choice-text"><span class="b-choice-title">Let the gateway choose</span><span class="b-choice-sub b-wrap">${line}</span></span>${icon("check", "icon b-tick")}</button></li></ul>`
    );
  }

  // One tab stop per radio group: the checked radio, or the first when none is.
  function rove(root) {
    $$('[role="radiogroup"]', root).forEach((group) => {
      const radios = $$('[role="radio"]', group);
      const on = radios.find((r) => r.getAttribute("aria-checked") === "true") || radios[0];
      radios.forEach((r) => (r.tabIndex = r === on ? 0 : -1));
    });
  }

  // Re-rendering keeps focus on the same control: it is found again by its data.
  const KEYS = ["bChoose", "bPerm", "bBody", "bColor", "bSelect", "bOption", "bAccount", "bSection", "t3", "c", "bs", "b"];
  function keep(root, render) {
    const el = document.activeElement;
    let selector = null;
    if (el && root.contains(el) && el !== root) {
      if (el.id) selector = `#${el.id}`;
      else {
        const key = KEYS.find((k) => el.dataset[k] !== undefined);
        if (key) {
          const attr = `data-${key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}`;
          selector = `[${attr}="${el.dataset[key]}"]` + (el.dataset.value ? `[data-value="${el.dataset.value}"]` : "");
        }
      }
    }
    render();
    rove(root);
    if (selector) $(selector, root)?.focus();
  }

  // New bot -------------------------------------------------------------------------------------------

  const createDialog = $("#create-dialog");

  function openCreate(opener) {
    B.create.opener = opener || document.activeElement;
    // An attempt in flight, or one whose reply settled nothing, stays as it is when New bot reopens:
    // only "Review bots" ends an unconfirmed attempt. A refusal can be tried again.
    if (!["creating", "slow", "unconfirmed"].includes(B.create.status)) B.create.status = p("create") && !B.create.opened ? p("create") : "idle";
    B.create.opened = true;
    renderCreate();
    if (!createDialog.open) createDialog.showModal();
    focusFirst(createDialog);
  }

  function renderCreate() {
    const step = B.create.step;
    let head = "";
    let body = "";
    let foot = "";
    if (step === "look") {
      head = `<header class="b-head"><h2 id="create-title" tabindex="-1">New bot</h2>${close("Close")}</header>`;
      body =
        `<span class="b-preview" role="img" aria-label="${esc(B.draft.name || "New bot")}'s picture">${draftArt()}</span>` +
        `<label class="visually-hidden" for="b-name">Name</label>` +
        `<input class="input b-name" id="b-name" data-b-focus autocomplete="off" maxlength="40" placeholder="Name" value="${esc(B.draft.name)}" />` +
        `<p class="b-label" id="b-shape-label">Shape</p><div class="b-shapes" role="radiogroup" aria-labelledby="b-shape-label">` +
        BOT_ART_BODIES.map((body) => {
          CT.botArt.__shape = { body, color: B.draft.color, tilt: 0, look: [0.6, 0] };
          const on = body === B.draft.body;
          return `<button type="button" class="b-shape" role="radio" aria-checked="${on}" tabindex="${on ? 0 : -1}" aria-label="${body}" data-b-body="${body}">${CT.character("__shape")}</button>`;
        }).join("") +
        `</div><p class="b-label" id="b-color-label">Colour</p><div class="b-colors" role="radiogroup" aria-labelledby="b-color-label">` +
        BOT_ART_COLORS.map((color, i) => {
          const on = color === B.draft.color;
          const names = ["Green", "Blue", "Orange", "Violet", "Yellow", "Pink", "Sky", "Lime"];
          return `<button type="button" class="b-color" role="radio" aria-checked="${on}" tabindex="${on ? 0 : -1}" aria-label="${names[i]}" style="--swatch:${color}" data-b-color="${color}"></button>`;
        }).join("") +
        `</div>`;
      foot = button("Next", 'data-b="next" data-size="lg"', "primary");
    } else if (step === "account") {
      const name = B.draft.name.trim() || "New bot";
      head = `<header class="b-head">${back("Back to the picture", "to-look")}<h2 id="create-title" tabindex="-1">Account</h2>${close("Close")}</header>`;
      body =
        `<span class="b-preview" style="--avatar-create:56px;margin-bottom:10px" aria-hidden="true">${draftArt()}</span>` +
        `<p class="b-lead">Choose the account ${esc(name)} runs on. The sign-in stays on your gateway.</p>` +
        (B.accountsState === "loading"
          ? `<div aria-busy="true" aria-label="Loading accounts"><div class="skeleton" style="height:58px;width:100%"></div><div class="skeleton" style="height:58px;width:100%"></div><div class="skeleton" style="height:58px;width:100%"></div></div>`
          : B.accountsState === "error"
            ? note(`<p><b>Couldn't load the gateway's accounts.</b></p><div class="b-actions">${button("Try again", 'data-b="accounts-retry" data-size="sm"')}</div>`, "danger")
            : "") +
        `<div role="radiogroup" aria-label="Accounts">` +
        (B.accountsState === "loading" || B.accountsState === "error"
          ? ""
          : shared().length
            ? accountGroups({ row: (a) => accountRow(a, { choose: true, checked: a.id === B.draft.account }) })
            : `<div class="work-empty"><span class="empty-mark">${icon("lock")}</span><h4>No accounts yet</h4><p>Sign in with a subscription you already have, and ${esc(name)} runs on it.</p></div>`) +
        gatewayRow(B.draft.account === GATEWAY) +
        `</div>` +
        (B.accountsState === "loading" || B.accountsState === "error"
          ? ""
          : `<ul class="b-choices" style="margin-top:12px"><li><button type="button" class="b-choice" data-kind="add" data-b="connect"${isAdmin() ? "" : ' aria-disabled="true" disabled'}>${icon("plus")}<span class="b-choice-text"><span class="b-choice-title">${shared().length ? "Connect another account" : "Connect an account"}</span></span></button></li></ul>`) +
        (DEFAULT_MODEL.account && B.draft.account === DEFAULT_MODEL.account ? `<p class="b-hint">Chosen because the gateway's default model names it.</p>` : "") +
        (B.createNote ? note(`<p>${esc(B.createNote)}</p>`) : "") +
        chosenPart(name);
      const none = !B.draft.account;
      foot = !isAdmin()
        ? adminBar("Creating a bot changes the gateway's settings, which needs admin access. What you chose stays here while you ask.")
        : button("Next", `data-b="to-approvals" data-size="lg"${none ? " disabled" : ""}`, "primary") +
          (none ? `<p class="b-hint" style="text-align:center;margin:0">Choose an account, or let the gateway choose.</p>` : "");
    } else if (step === "approvals") {
      // controls.md section 10: nothing is chosen at first; Create waits for a choice.
      // Below admin the choices aren't drawn at all, even if access drops while the step is open.
      const name = B.draft.name.trim() || "New bot";
      const n = esc(name);
      head = `<header class="b-head">${back("Back to accounts", "to-account")}<h2 id="create-title" tabindex="-1">Approvals</h2>${close("Close")}</header>`;
      const row = (value, title, line) =>
        `<li><button type="button" class="b-choice" role="radio" aria-checked="${B.draft.perm === value}" tabindex="-1" data-b-perm="${value}" aria-labelledby="b-perm-${value}-t" aria-describedby="b-perm-${value}-d">` +
        `<span class="b-choice-text"><span class="b-choice-title" id="b-perm-${value}-t">${title}</span><span class="b-choice-sub b-wrap" id="b-perm-${value}-d">${line}</span></span>${icon("check", "icon b-tick")}</button></li>`;
      const blocks = p("approvals") === "deny";
      body =
        `<span class="b-preview" style="--avatar-create:56px;margin-bottom:10px" aria-hidden="true">${draftArt()}</span>` +
        `<p class="b-lead">When ${n} wants to run a command:</p>` +
        (isAdmin()
          ? `<div role="radiogroup" aria-label="Approvals"><ul class="b-choices">` +
            row("ask", "Ask before acting", `Sets ${n}'s command policy to ask for approval when a command misses the machine's allowlist.`) +
            row("full", "Run without routine approvals", `Sets ${n}'s command policy to run without routine approval. The machine, the task or a rule can still require approval or block a command.`) +
            `</ul></div>` +
            `<p class="b-hint">Commands use the machine and permissions set by the gateway. ${n}'s command setting replaces the gateway-wide command mode for this bot. You can change this later in ${n}'s settings.</p>` +
            (blocks ? `<p class="b-hint" data-tone="warn" data-b-file="deny">The gateway's approvals file blocks commands.</p>` : `<p class="b-hint" data-b-file>The gateway's approvals file can require approval or block commands.</p>`)
          : "");
      const busy = ["creating", "slow"].includes(B.create.status);
      const none = !B.draft.perm;
      const unconfirmed = B.create.status === "unconfirmed";
      foot = !isAdmin()
        ? adminBar("Creating a bot changes the gateway's settings, which needs admin access. What you chose stays here while you ask.")
        : unconfirmed
          ? note(`<p><b>Clawtrate couldn't confirm whether ${n} was created.</b> Review the gateway's bot list.</p><div class="b-actions">${button("Review bots", 'data-b="review-bots" data-size="sm"')}</div>`, "warn")
          : (B.create.status === "failed" ? note(`<p><b>Could not create the bot.</b> Please try again.</p>`, "danger") : "") +
            (!none && !busy ? `<p class="b-hint" style="text-align:center;margin:0" data-b-inherits>Before Clawtrate sets ${n}'s policy, the new bot inherits the gateway's settings.</p>` : "") +
            button(busy ? "Creating…" : "Create", `data-b="create" data-size="lg"${busy || none ? " disabled" : ""}`, "primary") +
            (none && !busy ? `<p class="b-hint" style="text-align:center;margin:0" data-b-perm-hint>Choose how ${n} runs commands.</p>` : "") +
            (B.create.status === "slow" ? `<p class="b-hint" role="status" style="text-align:center;margin:0">Still creating. What you entered is kept.</p>` : "");
    } else {
      const view = renderConnect();
      head = `<header class="b-head">${back(view.backLabel, "connect-back")}<h2 id="create-title" tabindex="-1">${view.title}</h2>${close("Close")}</header>`;
      body = view.body;
      foot = view.foot;
    }
    keep(createDialog, () => {
      createDialog.innerHTML = `<div class="b-sheet">${head}<div class="b-body">${body}</div>${foot ? `<footer class="b-foot">${foot}</footer>` : ""}</div>`;
      CT.hydrate(createDialog);
    });
  }

  // Under the list: the model and effort once an account is chosen, or what
  // happens with nothing chosen.
  function chosenPart(name) {
    const provider = draftProvider();
    if (!provider) return "";
    const a = acct(B.draft.account);
    const who = esc(providerName(provider));
    const [tone, word] = a ? stateOf(a) : [""];
    return (
      `<h4 class="b-group">Model</h4>` +
      `<div class="b-pair">${select("model", "Model", B.draft.model)}${select("effort", "Effort", B.draft.effort)}</div>` +
      `<p class="b-hint">${who}'s models, as the gateway lists them. Which ones ${a ? "this account" : "an account"} may use is ${who}'s decision. Change either later in ${esc(name)}'s settings.</p>` +
      (tone ? note(`<p>${esc(acctName(a))}: ${word.toLowerCase()}. The gateway can't renew this kind of sign-in by itself; sign in again before then.</p>`, "warn") : "")
    );
  }

  const select = (what, label, value) =>
    `<button type="button" class="b-select" data-b-select="${what}" aria-haspopup="menu" aria-expanded="false" aria-label="${label}: ${esc(value || "none")}"${isAdmin() ? "" : " disabled"}>` +
    `<small>${label}</small><span>${esc(value || "—")}</span>${icon("chevron")}</button>`;

  // Create is one admin host operation (bots.md section 3). The host itself refuses a
  // Create without an explicit Ask or Full and an account choice, whatever the page
  // sends. Every write it makes is recorded, so the checks can see what was sent.
  const writes = [];
  function hostCreate(draft) {
    if (!isAdmin() || !["ask", "full"].includes(draft?.perm) || !draft?.account) return { refused: true };
    writes.push({ op: "agents.create", name: draft.name.trim() || "New bot" });
    return { refused: false };
  }

  function create() {
    if (["creating", "slow", "unconfirmed"].includes(B.create.status)) return;
    if (hostCreate(B.draft).refused) return;
    const want = p("create");
    B.create.status = "creating";
    renderCreate();
    announce("Creating the bot");
    const slow = setTimeout(() => {
      if (B.create.status === "creating") {
        B.create.status = "slow";
        renderCreate();
      }
    }, want === "slow" ? 300 : 4000);
    setTimeout(
      () => {
        clearTimeout(slow);
        if (want === "failed" || want === "slow") {
          B.create.status = want === "slow" ? "slow" : "failed";
          renderCreate();
          if (want === "failed") announce("Could not create the bot");
          return;
        }
        // A lost or ambiguous reply: not confirmed. Nothing more is sent from this attempt,
        // and a bot of that name found later is not taken to be this one.
        if (want === "timeout") {
          B.create.status = "unconfirmed";
          renderCreate();
          announce(`Clawtrate couldn't confirm whether ${B.draft.name.trim() || "New bot"} was created`);
          return;
        }
        created();
      },
      want === "slow" ? 600 : 700,
    );
  }

  // The new bot's first task: one note that follows the reads (controls.md section 10).
  const PERM_WORDS = { ask: "Ask before acting", full: "Run without routine approvals", deny: "Never" };
  const LABEL_WORDS = {
    guarded: "The gateway reports that the default command policy asks on an allowlist miss.",
    full: "The gateway reports no routine approval in the default command policy.",
    "read-only": "The gateway reports that the default command policy disables commands.",
  };
  // Each new bot's own recovery: a retry acts on the bot whose note it is in, never on the last one made.
  const recovery = {};
  function taskNote(n, s, id = "") {
    const retry = (label, action) => (s.identified && isAdmin() ? button(label, `data-b="${action}" data-bot="${id}" data-size="sm"`) : "");
    const box = (tone, state, html, actions = "") =>
      `<div class="b-note b-created"${tone ? ` data-tone="${tone}"` : ""} data-b-created="${state}">${icon(tone ? "warning" : state === "reading" ? "clock" : "check")}<div>${html}${actions ? `<div class="b-actions">${actions}</div>` : ""}</div></div>`;
    if (s.state === "reading") return box("", "reading", `<p>Checking what was written…</p>`);
    if (s.state === "restrictfail")
      return box("danger", "restrictfail", `<p><b>Couldn't confirm ${n}'s settings.</b> Clawtrate sends nothing to ${n} until they are confirmed.</p>`, retry("Write them again", "restrict-again"));
    if (s.state === "unconfirmed")
      return box(
        "warn",
        "unconfirmed",
        `<p><b>Clawtrate couldn't confirm ${n}'s command setting.</b> Review the gateway's settings before sending a task.${s.read ? ` Its saved command setting is ${PERM_WORDS[s.read]}.` : ""}</p>`,
        button("Review settings", 'data-b="review-settings" data-size="sm"') + retry("Write it again", "perm-again"),
      );
    return box("", "confirmed", `<p data-b-saved>${n}'s saved command setting is ${PERM_WORDS[s.read]}.</p><p data-b-label>${s.label === "none" ? `The gateway didn't report a default command policy for ${n}.` : LABEL_WORDS[s.label]}</p>`);
  }
  const plain = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  // Step 1 confirmed, with the id it returned: the dialog closes on the new bot, whose
  // composer is held until its command setting reads back.
  function created() {
    const name = B.draft.name.trim() || "New bot";
    let id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "new-bot";
    while (app.bots.some((b) => b.id === id)) id += "-2";
    CT.botArt[id] = { body: B.draft.body, color: B.draft.color, tilt: 0, look: [0.6, 0] };
    const a = acct(B.draft.account);
    // An account: its model with @account. "Let the gateway choose": the model, no account.
    binding[id] = { account: a ? a.id : null, mode: a ? "account" : "gateway", model: B.draft.model, effort: B.draft.effort, locked: false };
    const perm = B.draft.perm;
    const task = { id: `${id}-1`, title: "Main", at: 3000, when: "now", preview: "No messages yet.", unread: false, status: "idle", html: "", fresh: true, hold: true };
    app.bots.push({ id, name, label: "", tasks: [task] });
    B.created = recovery[id] = { id, name, perm, task };
    B.create = { step: "look", status: "idle", opener: null, created: true };
    B.draft = { name: "", body: "drop", color: "#ff6f9c", account: null, model: null, effort: "Medium", perm: null };
    createDialog.close();
    app.selectBot(id);
    announce(`Created ${name}`);
    noteOn(task, name, { state: "reading" });
    restrictive(id, name, perm, task);
  }

  // A change of access redraws each new bot's note, so its retry is offered only with admin.
  function refreshNotes() {
    for (const r of Object.values(recovery)) if (r.task.noteState) r.task.note = taskNote(esc(r.name), r.task.noteState, r.id);
    app.render();
  }

  function noteOn(task, name, s) {
    const id = Object.values(recovery).find((r) => r.task === task)?.id || "";
    task.noteState = s;
    task.note = taskNote(esc(name), s, id);
    task.hold = s.state !== "confirmed";
    app.render();
  }

  // Step 2: Never, the restrictive deny list and fallbacks: [], in one hash-guarded patch.
  function restrictive(id, name, perm, task) {
    writes.push({ op: "config.patch", step: 2, id, mode: "deny", deny: ["gateway", "plugins", "automations", "browser", "message", "t3code__*"], fallbacks: [] });
    setTimeout(() => {
      if (p("create") === "partial" && !recovery[id].restrictRetried) {
        recovery[id].restrictRetried = true;
        noteOn(task, name, { state: "restrictfail", identified: p("retry") !== "gone" });
        announce(`Couldn't confirm ${name}'s settings`);
        return;
      }
      policy(id, name, perm, task);
    }, 400);
  }

  // Step 3: the chosen mode and the final deny list, after a fresh read of the target and its hash.
  function policy(id, name, perm, task, again = false) {
    const fixture = again ? (p("retry") === "fail" ? "fail" : "ok") : p("readback") || "ok";
    const conflict = !again && p("create") === "conflict";
    if (!conflict) writes.push({ op: "config.patch", step: 3, id, mode: perm, deny: ["gateway", "plugins", "t3code__*"], replacePaths: [`agents.entries.${id}.tools.deny`] });
    setTimeout(() => {
      if (fixture === "pending" && !conflict) {
        announce("Checking what was written");
        return; // the note stays at "Checking what was written…", and the composer held
      }
      const s =
        conflict || fixture !== "ok"
          ? { state: "unconfirmed", read: fixture === "mismatch" ? "deny" : null, identified: p("retry") !== "gone" }
          : { state: "confirmed", read: perm, label: p("label") || (perm === "ask" ? "guarded" : "full") };
      noteOn(task, name, s);
      if (s.state === "confirmed") $(".composer-input")?.focus();
      announce(plain(taskNote(esc(name), s)).split(/(?<=\.) /)[0]);
    }, 500);
  }

  // Connecting an account: the same component in New bot and in Settings -----------------------------

  function startConnect(from, optionId, stage) {
    B.connect = { from, view: optionId ? "flow" : "providers", option: optionId || null, stage: stage || null, pasted: "", domain: "", label: "", error: "", apikey: { provider: "openai", key: "" }, saved: p("saved") ? `${OPTIONS.find((o) => o.id === optionId)?.provider || "openai"}:second` : null };
  }

  function option() {
    return OPTIONS.find((o) => o.id === B.connect.option);
  }

  function renderConnect() {
    const c = B.connect;
    if (c.view === "providers") return providersView();
    if (c.view === "label") return labelView();
    return flowView();
  }

  function providersView() {
    const row = (o) =>
      `<li><button type="button" class="b-choice" data-b-option="${o.id}"${isAdmin() ? "" : ' aria-disabled="true"'}>` +
      `<span class="b-choice-text"><span class="b-choice-title">${esc(o.label)} <span>· ${esc(o.hint)}</span></span>` +
      `<span class="b-choice-sub">${FLOW_WORDS[o.flow]}</span></span>${icon("chevron")}</button></li>`;
    const has = accounts.some((a) => a.provider === B.connect.apikey.provider && a.kind === "key");
    const target = app.bots.find((x) => x.id === LANDED)?.name || "Otto";
    const draftName = B.draft.name.trim() || "the new bot";
    const body =
      (NO_MAIN
        ? note(
            `<p>This gateway keeps this sign-in for ${esc(target)} only. Other bots, and a bot you are creating, won't be able to use it.</p>` +
              (B.connect.from === "create" ? `<p>To give ${esc(draftName)} an account of its own, create it with "Let the gateway choose", then connect from its settings.</p>` : ""),
          )
        : "") +
      `<p class="b-lead">Sign in with a subscription you already pay for. Your gateway does the sign-in and keeps it; Clawtrate never sees your password and never keeps the sign-in.</p>` +
      `<h4 class="b-group">Subscriptions</h4><ul class="b-choices">${OPTIONS.filter((o) => o.group === "sub").map(row).join("")}</ul>` +
      `<h4 class="b-group">Billed per token</h4><ul class="b-choices">${OPTIONS.filter((o) => o.group === "token").map(row).join("")}</ul>` +
      `<details class="b-disclosure"${p("apikey") === "open" ? " open" : ""}><summary>${icon("chevron")}Use an API key instead</summary><div class="b-disclosure-body">` +
      `<p class="b-hint" style="margin-top:4px">With an API key, the provider bills each request by the tokens it uses, apart from any subscription you have. Most people don't need one.</p>` +
      `<label class="b-field"><span>Provider</span><select class="input" data-b-keyprovider${isAdmin() ? "" : " disabled"}>` +
      KEY_PROVIDERS.map((id) => `<option value="${id}"${id === B.connect.apikey.provider ? " selected" : ""}>${providerName(id)}</option>`).join("") +
      `</select></label>` +
      `<label class="b-field"><span>Key</span><input class="input" type="password" autocomplete="off" spellcheck="false" data-b-key placeholder="Paste the key"${isAdmin() ? "" : " disabled"} /></label>` +
      (has
        ? note(`<p>This replaces the ${esc(providerName(B.connect.apikey.provider))} key your gateway already has. Bots that use it switch to the new key. To keep both, add the second on the gateway's machine.</p>`, "warn")
        : "") +
      `<p class="b-hint">The key goes to your gateway, which keeps it. It is not kept on this device, and Clawtrate can't read it back.</p>` +
      `<div class="b-actions" style="margin-top:12px">${button("Save key", `data-b="save-key" data-size="sm"${isAdmin() ? "" : " disabled"}`)}</div>` +
      `</div></details>`;
    return { title: "Connect an account", backLabel: B.connect.from === "create" ? "Back to accounts" : "Back to accounts", body, foot: isAdmin() ? "" : adminBar("Connecting an account needs admin access. The gateway lets only admin connections start a sign-in.") };
  }

  function flowView() {
    const c = B.connect;
    const o = option();
    const who = providerName(o.provider);
    const title = `Sign in to ${o.label}`;
    const cancel = button("Cancel", 'data-b="cancel-signin"', "quiet");
    const again = button("Start again", 'data-b="restart-signin"');
    const choose = button("Choose another way", 'data-b="to-providers"', "quiet");
    const link = (text) => `${button(`${text} ${icon("external")}`, 'data-b="open-link"')}`;
    let body = "";
    let foot = "";
    const stage = c.stage;
    if (!isAdmin()) {
      return { title, backLabel: "Back to sign-in methods", body: `<p class="b-lead">${FLOW_WORDS[o.flow]}.</p>`, foot: adminBar("Signing in needs admin access. The gateway lets only admin connections start a sign-in.") };
    }
    if (stage === "busy") {
      body = result("warn", "clock", "The gateway is busy", "It is already running a sign-in or a setup, and does one at a time. Try again when that one finishes.");
      foot = button("Try again", 'data-b="restart-signin" data-size="lg"', "primary") + choose;
    } else if (stage === "domain") {
      body =
        `<p class="b-lead">Enter your company's GitHub address. The gateway then shows a code to enter there.</p>` +
        `<label class="b-field"><span>GitHub Enterprise address</span><input class="input" data-b-domain data-b-focus placeholder="github.example.com" value="${esc(c.domain)}" /></label>`;
      foot = button("Continue", 'data-b="domain-next" data-size="lg"', "primary") + cancel;
    } else if (stage === "starting") {
      body = `<p class="b-lead">${FLOW_WORDS[o.flow]}.</p>` + wait("Asking the gateway to start the sign-in…");
      foot = cancel;
    } else if (stage === "waiting" && (o.flow === "code" || o.flow === "domain")) {
      body =
        `<ol class="b-steps"><li><p>Open ${esc(who)}'s sign-in page.</p>${link(`Open ${esc(who)}'s page`)}<p class="b-hint" style="margin-top:6px">sign-in.example/device</p></li>` +
        `<li><p>Enter this code there, and approve.</p><div class="b-code"><code aria-label="Code QK4F 7PZD">QK4F-7PZD</code>${copy("code", "QK4F-7PZD")}</div></li></ol>` +
        wait(`Waiting for ${esc(who)}. The code works for 15 minutes.`) +
        `<p class="b-hint">Keep this open until it finishes. Closing Clawtrate or losing the connection to the gateway ends the sign-in.</p>`;
      foot = cancel;
    } else if (stage === "waiting" && o.flow === "paste") {
      body =
        `<ol class="b-steps"><li><p>Open ${esc(who)}'s sign-in page and sign in.</p>${link(`Open ${esc(who)}'s page`)}</li>` +
        `<li><p>The page then shows a code, or your browser lands on an address that does not open. Copy the code, or that whole address, and paste it here.</p>` +
        `<label class="b-field"><span>Code or address</span><input class="input" type="password" autocomplete="off" spellcheck="false" data-b-paste data-b-focus placeholder="Paste here" /></label></li></ol>` +
        `<p class="b-hint">It goes straight to your gateway, which finishes the sign-in. Clawtrate does not keep it.</p>`;
      foot = button("Continue", 'data-b="paste-next" data-size="lg"', "primary") + cancel;
    } else if (stage === "checking") {
      body = wait(`Finishing the sign-in with ${esc(who)}…`);
      foot = cancel;
    } else if (stage === "waiting" && o.flow === "host") {
      const step = "ssh -N -L 8080:127.0.0.1:8080 gateway-host";
      body =
        `<p class="b-lead">This sign-in finishes on the gateway's machine: ${esc(who)} sends your browser back to an address there. The gateway says:</p>` +
        `<ol class="b-steps"><li><p>On a computer that isn't the gateway, forward its port first:</p><div class="command-line"><code>${step}</code>${copy("command", step)}</div></li>` +
        `<li><p>Then open the sign-in page in that computer's browser.</p>${link(`Open ${esc(who)}'s page`)}</li></ol>` +
        wait(`Waiting for ${esc(who)} to send your browser back to the gateway…`);
      foot = cancel + choose;
    } else if (stage === "connected") {
      return labelView();
    } else if (stage === "failed") {
      body = result("danger", "warning", "Couldn't connect", `${esc(who)} refused the sign-in: the code was not accepted.`) + reread(who);
      foot = button("Try again", 'data-b="restart-signin" data-size="lg"', "primary") + choose;
    } else if (stage === "expired") {
      body = result("warn", "clock", "The sign-in expired", "It wasn't finished in time. Start again for a new code.") + reread(who);
      foot = button("Start again", 'data-b="restart-signin" data-size="lg"', "primary") + choose;
    } else if (stage === "cancelled") {
      body = result("", "x", "Sign-in cancelled", "") + reread(who);
      foot = again + choose;
    } else if (stage === "dropped") {
      body = result("warn", "warning", "The sign-in ended", "The connection to the gateway dropped, and a sign-in ends with its connection.") + reread(who);
      foot = button("Start again", 'data-b="restart-signin" data-size="lg"', "primary") + choose;
    } else if (stage === "unconfirmed") {
      // The gateway's own message, as it sends it.
      body = result("warn", "clock", "Saved, not confirmed", "Your sign-in was saved, but the connection update could not be confirmed. Send /login refresh in chat to try again.");
      foot = button("Continue", 'data-b="name-saved" data-size="lg"', "primary");
    } else if (stage === "finishing") {
      body = wait(`Saving the sign-in with ${esc(who)}…`) + `<p class="b-hint">Too late to cancel: the gateway is saving the sign-in.</p>`;
      foot = button("Saving…", 'data-size="lg" disabled', "quiet");
    } else if (stage === "same") {
      body = result("ok", "check", "Signed in", `No new ${esc(who)} account appeared: if this was an account you already have, the gateway may have refreshed its sign-in.`);
      foot = button("Done", 'data-b="same-done" data-size="lg"', "primary");
    }
    return { title, backLabel: "Back to sign-in methods", body, foot };
  }

  // After a sign-in that did not end cleanly, the gateway's accounts are read
  // again and the screen says what is there, and nothing else.
  function reread(who) {
    if (B.connect.saved)
      return note(
        `<p>The gateway now has a ${who} account it didn't have before, <span class="mono">${esc(B.connect.saved)}</span>. It may not be ready to use.</p>` +
          `<div class="b-actions">${button("Name it", 'data-b="name-saved" data-size="sm"')}${button("Disconnect it…", 'data-b="drop-saved" data-size="sm" data-tone="danger"', "quiet")}</div>`,
        "warn",
      );
    return `<p class="b-hint" style="text-align:center">Clawtrate checked the gateway's accounts: no new ${who} account.</p>`;
  }

  function labelView() {
    const c = B.connect;
    const provider = c.keyProvider || option().provider;
    const others = accounts.filter((a) => a.provider === provider && a.id !== c.newId);
    const who = providerName(provider);
    const clash = others.find((a) => a.label.trim().toLowerCase() === c.label.trim().toLowerCase() && c.label.trim());
    const locked = Object.entries(binding).filter(([, b]) => b.evidence?.state === "matched" && acct(b.account)?.provider === provider);
    const body =
      result("ok", "check", c.keyProvider ? "Key saved" : `Connected to ${esc(who)}`, c.keyProvider ? `Your gateway keeps the key.` : `Your gateway keeps the sign-in.`).replace(" data-b-focus", "") +
      (() => {
        const owner = acct(c.newId)?.owner;
        const name = app.bots.find((x) => x.id === owner)?.name;
        return owner
          ? `<p class="b-hint" role="status" style="text-align:center">Saved for ${esc(name)} only. Other bots can't use it.</p>`
          : `<p class="b-hint" role="status" style="text-align:center">Every bot can use it: the gateway shows it to other bots as shared.</p>`;
      })() +
      `<label class="b-field"><span>Label</span><input class="input" data-b-label data-b-focus maxlength="32" placeholder="${others.length ? "For example, Home or Studio" : "For example, Personal"}" value="${esc(c.label)}" aria-describedby="b-label-help" /></label>` +
      (clash
        ? `<p class="b-field-error" id="b-label-help">Another ${esc(who)} account is called ${esc(clash.label)}. Choose a different label.</p>`
        : `<p class="b-hint" id="b-label-help">${others.length ? `You have another ${esc(who)} account, ${esc(acctName(others[0]))}. A label tells them apart everywhere.` : "Shown wherever this account is, so you can tell accounts apart."}</p>`) +
      locked
        .map(([bot]) => {
          const name = app.bots.find((x) => x.id === bot)?.name;
          return note(`<p>Clawtrate checked ${esc(name)}'s lock after this sign-in. It still allows only ${esc(acctName(acct(binding[bot].account)))}.</p>`, "", icon("lock"));
        })
        .join("");
    const foot = button("Done", `data-b="label-done" data-size="lg"${(others.length && !c.label.trim()) || clash ? " disabled" : ""}`, "primary");
    return { title: c.keyProvider ? "API key" : `Sign in to ${option().label}`, backLabel: "Back", body, foot };
  }

  function connectTo(stage) {
    B.connect.stage = stage;
    rerender();
    if (stage === "connected") {
      const o = option();
      const id = `${o.provider}:${["home", "studio", "second", "third"].find((x) => !acct(`${o.provider}:${x}`)) || Date.now()}`;
      // landed=<bot>: the gateway's views show the account in that bot's store only.
      accounts.push({ id, provider: o.provider, label: "", kind: o.group === "token" ? "key" : "subscription", how: `${o.label}: ${FLOW_WORDS[o.flow].toLowerCase()}`, status: "ok", fresh: true, ...(LANDED ? { owner: LANDED } : {}) });
      B.connect.newId = id;
      B.connect.view = "label";
      announce(`Connected to ${providerName(o.provider)}`);
      rerender(true);
    }
  }

  let flowTimer = null;
  function beginSignIn(optionId) {
    clearTimeout(flowTimer);
    B.connect.view = "flow";
    B.connect.option = optionId;
    const o = option();
    B.connect.stage = o.flow === "domain" && !B.connect.domain ? "domain" : "starting";
    rerender(true);
    if (B.connect.stage === "starting") flowTimer = setTimeout(() => connectTo("waiting"), 700);
  }

  // Settings --------------------------------------------------------------------------------------------

  const settingsDialog = $("#settings-dialog");
  // The shell's built Settings has the Gateway pane; this design adds the rest after it.
  const SECTIONS = [["gateway", "Gateway"], ["accounts", "Accounts"]];
  CT.botsSections = SECTIONS;

  function openSettings(opener, section) {
    B.settings.opener = opener || document.activeElement;
    if (section) {
      B.settings.section = section;
      B.settings.pane = "section";
    }
    renderSettings();
    if (!settingsDialog.open) settingsDialog.showModal();
    focusFirst(settingsDialog);
  }

  function renderSettings() {
    const s = B.settings;
    const nav =
      `<nav class="b-nav" aria-label="Settings"><div class="b-nav-head"><h2 id="settings-title">Settings</h2>${close("Close settings")}</div>` +
      SECTIONS.map(([id, label]) => `<button type="button" class="b-nav-item" data-b-section="${id}"${id === s.section ? ' aria-current="page"' : ""}>${label}${icon("chevron")}</button>`).join("") +
      `</nav>`;
    const section = sectionView();
    keep(settingsDialog, () => {
      settingsDialog.innerHTML =
        `<div class="b-settings" data-pane="${s.pane}">${nav}<section class="b-section" aria-labelledby="b-section-title">${close("Close settings")}` +
        `<header class="b-section-head">${section.back || ""}<h3 id="b-section-title" tabindex="-1">${section.title}</h3></header>` +
        `<div class="b-section-body">${section.body}</div>${section.foot ? `<footer class="b-section-foot">${section.foot}</footer>` : ""}</section></div>`;
      CT.hydrate(settingsDialog);
    });
  }

  const toNav = () => back("Back to settings", "to-nav");

  function sectionView() {
    const s = B.settings;
    if (s.section === "gateway") return gatewayPane();
    if (s.section === "accounts") {
      if (B.connect && B.connect.from === "settings") {
        const view = renderConnect();
        return { title: view.title, back: back(view.backLabel, "connect-back"), body: view.body, foot: view.foot };
      }
      if (s.account && acct(s.account)) return accountPage(acct(s.account));
      return accountsList();
    }
    return (CT.botsSectionViews?.[s.section] || (() => ({ title: "", body: "" })))({ back: toNav(), isAdmin, adminBar, button, note, esc, icon });
  }

  // The Gateway pane as built (packages/ui/src/Settings.tsx), unchanged.
  function gatewayPane() {
    const scopes = { read: ["operator.read"], write: ["operator.read", "operator.write", "operator.approvals", "operator.questions"], admin: ["operator.read", "operator.write", "operator.approvals", "operator.questions", "operator.admin"] }[B.access];
    const body =
      `<dl class="facts"><div><dt>Address</dt><dd>gateway.local</dd></div><div><dt>State</dt><dd>Connected</dd></div>` +
      `<div><dt>This device</dt><dd class="mono">device 9c2e41</dd></div><div><dt>Granted scopes</dt><dd class="b-wrap-value">${scopes.join(", ")}</dd></div>` +
      `<div><dt>Gateway</dt><dd>OpenClaw 2026.10.6</dd></div></dl>` +
      `<div class="b-actions" style="margin-top:16px">${button("Disconnect", 'data-action="disconnect" data-size="sm"')}${button("Use another gateway", 'data-action="disconnect" data-size="sm"', "quiet")}</div>`;
    return { title: "Gateway", back: toNav(), body };
  }

  function accountsList() {
    const body =
      `<div class="b-headrow"><p class="b-lead" style="margin:0">Your bots run on these. Your gateway signs in and keeps each sign-in; Clawtrate never sees a password or keeps a sign-in.</p>` +
      `${isAdmin() ? button("Connect an account", 'data-b="connect" data-size="sm"') : ""}</div>` +
      (accounts.length
        ? accountGroups({ row: (a) => accountRow(a, { open: true }) }, accounts)
        : `<div class="work-empty"><span class="empty-mark">${icon("lock")}</span><h4>No accounts yet</h4><p>Connect a subscription you already have, and choose it when you create a bot.</p>` +
          (isAdmin() ? `<div style="margin-top:12px">${button("Connect an account", 'data-b="connect"', "primary")}</div>` : "") +
          `</div>`) +
      (isAdmin() ? "" : `<p class="b-hint">Labels are shown to admin connections only, so accounts are named by provider here.</p>`);
    return { title: "Accounts", back: toNav(), body, foot: isAdmin() ? "" : adminBar("Connecting and changing accounts needs admin access.") };
  }

  function accountPage(a) {
    const users = usedBy(a.id);
    const [tone, word] = stateOf(a);
    const edit = B.settings.edit;
    const lockedBy = users.filter((name) => binding[app.bots.find((x) => x.name === name)?.id]?.evidence?.state === "matched");
    const labelRow = edit
      ? `<div class="b-row b-edit-row"><dt>Label</dt><dd class="b-edit"><input class="input" data-b-relabel data-b-focus maxlength="32" value="${esc(a.label)}" aria-label="Label" />` +
        `${button("Save", 'data-b="relabel-save" data-size="sm"', "primary")}${button("Cancel", 'data-b="relabel-cancel" data-size="sm"', "quiet")}</dd></div>`
      : `<div class="b-row"><dt>Label</dt><dd class="b-wrap-value b-label-value">${isAdmin() ? `<span>${esc(a.label || "None")}</span>${button("Edit", 'data-b="relabel" data-size="sm" aria-label="Edit label"', "quiet")}` : "Shown to admin connections"}</dd></div>`;
    const body =
      `<dl class="facts"><div><dt>Provider</dt><dd>${esc(providerName(a.provider))}</dd></div>${labelRow}` +
      `<div><dt>Kind</dt><dd>${kindWord(a)}</dd></div>` +
      `<div><dt>State</dt><dd><span class="b-state"${tone ? ` data-tone="${tone}"` : ' data-tone="ok"'}>${tone ? icon("warning") : icon("check")}${word}${a.expiryDate ? `, ${a.expiryDate}` : ""}</span></dd></div>` +
      `<div><dt>Used by</dt><dd>${users.length ? esc(users.map((n) => (lockedBy.includes(n) ? `${n} (locked)` : n)).join(", ")) : "No bots"}</dd></div>` +
      `<div><dt>On the gateway</dt><dd class="mono">${esc(a.id)}</dd></div></dl>` +
      `<p class="b-hint">${esc(a.how)}. The gateway keeps the sign-in; Clawtrate can't read it.${a.owner ? ` Kept in ${esc(app.bots.find((x) => x.id === a.owner)?.name || a.owner)}'s own store. Other bots can't use it.` : ""}</p>` +
      (isAdmin()
        ? `<div class="b-actions" style="margin-top:18px">${a.kind === "subscription" ? button("Sign in again", 'data-b="resign" data-size="sm"', tone ? "primary" : "") : a.kind === "key" && !a.owner ? button("Replace key", 'data-b="replace-key" data-size="sm"') : `<span class="b-hint" style="margin:0">Signed in on the gateway. Sign it in again there.</span>`}<span class="spacer"></span>` +
          `${button("Disconnect…", 'data-b="disconnect" data-size="sm" data-tone="danger"', "quiet")}</div>`
        : "");
    return { title: acctName(a), back: back("Back to accounts", "to-accounts"), body, foot: isAdmin() ? "" : adminBar("Changing an account needs admin access.") };
  }

  // Confirmation ------------------------------------------------------------------------------------------

  const confirmDialog = $("#confirm-dialog");
  let confirmAction = null;
  // A confirmation: Cancel, an optional second action (alt), and the action itself.
  let confirmAlt = null;
  function confirmBox({ title, text, action, label, run, alt }) {
    confirmAction = run;
    confirmAlt = alt ? alt[1] : null;
    confirmDialog.innerHTML =
      `<div class="b-confirm"><h2 id="confirm-title">${title}</h2><p id="confirm-text">${text}</p>` +
      `<div class="b-actions">${button("Cancel", 'data-b="confirm-cancel"', "quiet")}${alt ? button(alt[0], 'data-b="confirm-alt"') : ""}${button(label, `data-b="confirm-ok"${action ? ` data-tone="${action}"` : ""}`)}</div></div>`;
    confirmDialog.showModal();
    $('[data-b="confirm-cancel"]', confirmDialog).focus();
  }

  function disconnect(a) {
    const users = usedBy(a.id);
    confirmBox({
      title: `Disconnect ${acctName(a)}?`,
      text: users.length
        ? `${users.join(" and ")} ${users.length === 1 ? "uses" : "use"} it. ${users.length === 1 ? "It shows" : "They show"} No account until you choose another, and Clawtrate doesn't start ${users.length === 1 ? "it" : "them"} until then. Your gateway removes the sign-in.`
        : "No bot uses it. Your gateway removes the sign-in.",
      action: "danger",
      label: "Disconnect",
      run: () => {
        Object.values(binding).forEach((b) => {
          if (b.account === a.id) {
            b.account = null;
            delete b.evidence;
            b.removed = true;
          }
        });
        accounts = accounts.filter((x) => x.id !== a.id);
        B.settings.account = null;
        renderSettings();
        focusFirst(settingsDialog);
        announce(`Disconnected ${acctName(a)}`);
        CT.botsChanged?.();
      },
    });
  }

  // Menus for model and effort ---------------------------------------------------------------------------

  let menu = null;
  function openSelect(buttonEl, items, current, pick) {
    closeSelect();
    menu = document.createElement("ul");
    menu.className = "menu b-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", buttonEl.querySelector("small").textContent);
    menu.innerHTML = items
      .map(([value, sub]) => `<li role="none"><button type="button" class="menu-item" role="menuitemradio" aria-checked="${value === current}" data-value="${esc(value)}">${esc(value)}${sub ? `<small>${esc(sub)}</small>` : ""}</button></li>`)
      .join("");
    buttonEl.closest("dialog, aside").append(menu);
    const r = buttonEl.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - 220))}px`;
    menu.style.top = `${Math.min(r.bottom + 6, innerHeight - menu.offsetHeight - 8)}px`;
    menu.style.minWidth = `${Math.max(200, r.width)}px`;
    buttonEl.setAttribute("aria-expanded", "true");
    menu.opener = buttonEl;
    menu.pick = pick;
    ($('[aria-checked="true"]', menu) || $(".menu-item", menu)).focus();
  }
  function closeSelect(refocus) {
    if (!menu) return false;
    menu.opener.setAttribute("aria-expanded", "false");
    if (refocus) menu.opener.focus();
    menu.remove();
    menu = null;
    return true;
  }
  CT.botsSelect = openSelect;

  // Wiring -------------------------------------------------------------------------------------------------

  // Focus moves at once, in the same task as the change it follows, so a key
  // pressed straight after cannot be overtaken by it.
  function focusFirst(dialog) {
    const target = $("[data-b-focus]", dialog) || $("h2[tabindex], h3[tabindex]", dialog);
    target?.focus();
  }

  // Re-render whichever dialog shows the connect component.
  function rerender(focus) {
    CT.botsRender?.();
    if (!app.bots.length) app.render();
    if (createDialog.open) {
      renderCreate();
      if (focus) focusFirst(createDialog);
    }
    if (settingsDialog.open) {
      renderSettings();
      if (focus) focusFirst(settingsDialog);
    }
  }

  function requestAdmin() {
    B.req = "asking";
    rerender();
    announce("Asking the gateway");
    setTimeout(() => {
      B.req = "requested";
      rerender();
      announce("Access requested");
    }, 600);
  }

  function grantAdmin() {
    B.access = "admin";
    B.req = "none";
    B.grantedNote = true;
    refreshNotes();
    rerender();
    announce("Admin access granted. You can change settings.");
    CT.botsChanged?.();
    setTimeout(() => {
      B.grantedNote = false;
      rerender();
    }, 4000);
  }

  // New bot from the "+" menu and from ⌘N; Settings from the gateway menu and ⌘,.
  document.addEventListener(
    "click",
    (event) => {
      const t = event.target;
      if (t.closest('[data-action="new-bot"]')) {
        event.stopPropagation();
        $("#rail-menu").hidden = true;
        $("#new-button").setAttribute("aria-expanded", "false");
        openCreate($("#new-button"));
      } else if (t.closest('[data-action="b-settings"]')) {
        event.stopPropagation();
        $("#gateway-menu").hidden = true;
        $$('[data-action="gateway-menu"]').forEach((b) => b.setAttribute("aria-expanded", "false"));
        openSettings($(".gateway-pill"));
      }
    },
    true,
  );

  document.addEventListener("keydown", (event) => {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === "n" && !createDialog.open && app.model.access === "write") {
      event.preventDefault();
      openCreate(document.activeElement);
    }
    if (mod && event.key === "," && !settingsDialog.open) {
      event.preventDefault();
      openSettings(document.activeElement);
    }
  });

  // Radio groups: one tab stop; arrows move and choose.
  document.addEventListener("keydown", (event) => {
    const radio = event.target.closest?.('[role="radio"]');
    if (radio && ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"].includes(event.key)) {
      const group = radio.closest('[role="radiogroup"]');
      if (!group) return;
      event.preventDefault();
      const radios = $$('[role="radio"]', group).filter((r) => !r.disabled);
      const i = radios.indexOf(radio);
      const n = event.key === "Home" ? 0 : event.key === "End" ? radios.length - 1 : (i + (["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : -1) + radios.length) % radios.length;
      radios[n].focus();
      radios[n].click();
    }
    // A closed select opens with Down, as with Enter and Space.
    if (!menu && event.key === "ArrowDown" && event.target.matches?.("[data-b-select]") && !event.target.disabled) {
      event.preventDefault();
      event.target.click();
      return;
    }
    // An open select menu: arrows move, Escape closes it before anything else.
    if (menu && menu.contains(event.target)) {
      const items = $$(".menu-item", menu);
      const i = items.indexOf(event.target);
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const n = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (i + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[n].focus();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeSelect(true);
      }
      if (event.key === "Tab") closeSelect(false);
    }
    if (event.key === "Enter" && event.target.matches?.("#b-name")) {
      event.preventDefault();
      $('[data-b="next"]', createDialog)?.click();
    }
  });

  // Escape belongs to the innermost thing that is open: a menu, then a dialog,
  // and only then the shell (the Work pane drawer, the rail's menus).
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape") return;
      if (menu) {
        event.preventDefault();
        event.stopPropagation();
        closeSelect(true);
      } else if (document.querySelector(".b-dialog[open]")) event.stopPropagation();
    },
    true,
  );

  // The Work pane's tab bar: the tabs never wrap or shorten. When they don't fit,
  // their padding tightens; when they still don't, the row scrolls sideways with
  // the chosen tab kept in view.
  function fitTabs() {
    const bar = $(".work-panel .tabs");
    if (!bar || !bar.offsetParent) return;
    delete bar.dataset.fit;
    if (bar.scrollWidth > bar.clientWidth + 1) bar.dataset.fit = "tight";
    if (bar.scrollWidth > bar.clientWidth + 1) bar.dataset.fit = "scroll";
    const on = $('.tab[aria-selected="true"]', bar);
    if (on && bar.dataset.fit === "scroll") {
      const l = on.offsetLeft - bar.offsetLeft;
      if (l < bar.scrollLeft || l + on.offsetWidth > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = l - 16;
    }
  }
  new ResizeObserver(fitTabs).observe($("#work-panel"));
  new MutationObserver(fitTabs).observe($(".work-panel .tabs"), { subtree: true, attributes: true, attributeFilter: ["aria-selected"], childList: true, characterData: true });
  CT.botsFitTabs = fitTabs;

  [createDialog, settingsDialog, confirmDialog].forEach((dialog) =>
    dialog.addEventListener("cancel", (event) => {
      if (menu) {
        event.preventDefault();
        closeSelect(true);
      }
    }),
  );
  createDialog.addEventListener("close", () => {
    clearTimeout(flowTimer);
    if (B.create.step === "connect") B.create.step = "account";
    B.connect = null;
    // After Create the new bot's composer has focus; otherwise focus goes back to the opener.
    if (B.create.created) return void (B.create.created = false);
    const to = B.create.opener && document.contains(B.create.opener) && B.create.opener.offsetParent ? B.create.opener : $("#new-button");
    setTimeout(() => to?.focus?.(), 0);
  });
  settingsDialog.addEventListener("close", () => {
    clearTimeout(flowTimer);
    B.connect = null;
    B.settings.edit = false;
    // Focus returns within the close event itself. The browser has already put focus back where
    // it was before the dialog opened (a menu item now hidden, so the page's body), and the close
    // event can arrive well after the dialog closes, so nothing may wait for a later task.
    const to = B.settings.opener && document.contains(B.settings.opener) && B.settings.opener.offsetParent ? B.settings.opener : $(".gateway-pill");
    to?.focus?.();
  });

  document.addEventListener("input", (event) => {
    const t = event.target;
    if (t.id === "b-name") {
      B.draft.name = t.value;
      $(".b-preview", createDialog)?.setAttribute("aria-label", `${t.value || "New bot"}'s picture`);
    }
    if (t.matches("[data-b-label]")) {
      B.connect.label = t.value;
      const pos = t.selectionStart;
      rerender();
      const field = $("[data-b-label]", createDialog.open ? createDialog : settingsDialog);
      field.focus();
      field.setSelectionRange(pos, pos);
    }
    if (t.matches("[data-b-domain]")) B.connect.domain = t.value;
    if (t.matches("[data-b-key]")) B.connect.apikey.key = t.value;
  });
  document.addEventListener("change", (event) => {
    if (event.target.matches("[data-b-keyprovider]")) {
      B.connect.apikey.provider = event.target.value;
      rerender();
      const details = $(".b-disclosure", createDialog.open ? createDialog : settingsDialog);
      if (details) details.open = true;
      $("[data-b-keyprovider]", createDialog.open ? createDialog : settingsDialog)?.focus();
    }
  });

  document.addEventListener("click", (event) => {
    const t = event.target;
    if (menu && !menu.contains(t) && !t.closest("[data-b-select]")) closeSelect(false);
    if (menu && t.closest(".b-menu .menu-item")) {
      const value = t.closest(".menu-item").dataset.value;
      const pick = menu.pick;
      closeSelect(true);
      pick(value);
      return;
    }
    const inDialog = t.closest(".b-dialog");
    const shape = t.closest("[data-b-body]");
    if (shape) {
      shape.focus();
      B.draft.body = shape.dataset.bBody;
      renderCreate();
      return;
    }
    const color = t.closest("[data-b-color]");
    if (color) {
      color.focus();
      B.draft.color = color.dataset.bColor;
      renderCreate();
      return;
    }
    const choose = t.closest("[data-b-choose]");
    if (choose && !choose.closest("aside")) {
      if (!isAdmin()) return;
      choose.focus();
      B.draft.account = choose.dataset.bChoose;
      const provider = draftProvider();
      if (!MODELS[provider].includes(B.draft.model)) B.draft.model = firstModel(provider);
      renderCreate();
      return;
    }
    const perm = t.closest("[data-b-perm]");
    if (perm) {
      if (!isAdmin()) return;
      perm.focus();
      B.draft.perm = perm.dataset.bPerm;
      renderCreate();
      return;
    }
    const sel = t.closest("[data-b-select]");
    if (sel && inDialog === createDialog) {
      if (menu && menu.opener === sel) return closeSelect(true);
      if (sel.dataset.bSelect === "model")
        openSelect(sel, MODELS[draftProvider()].map((m) => [m, ""]), B.draft.model, (v) => {
          B.draft.model = v;
          renderCreate();
          $('[data-b-select="model"]', createDialog).focus();
        });
      else
        openSelect(sel, EFFORTS.map((e) => [e, ""]), B.draft.effort, (v) => {
          B.draft.effort = v;
          renderCreate();
          $('[data-b-select="effort"]', createDialog).focus();
        });
      return;
    }
    const opt = t.closest("[data-b-option]");
    if (opt) {
      if (!isAdmin()) return;
      return beginSignIn(opt.dataset.bOption);
    }
    const section = t.closest("[data-b-section]");
    if (section) {
      B.settings.section = section.dataset.bSection;
      B.settings.account = null;
      B.settings.pane = "section";
      B.connect = null;
      renderSettings();
      focusFirst(settingsDialog);
      return;
    }
    const accountLink = t.closest("[data-b-account]");
    if (accountLink) {
      B.settings.account = accountLink.dataset.bAccount;
      B.settings.edit = false;
      renderSettings();
      focusFirst(settingsDialog);
      return;
    }
    const action = t.closest("[data-b]")?.dataset.b;
    if (!action) return;
    const c = B.connect;
    switch (action) {
      case "close":
        t.closest("dialog").close();
        break;
      case "next":
        B.create.step = "account";
        renderCreate();
        focusFirst(createDialog);
        break;
      case "to-look":
        B.create.step = "look";
        renderCreate();
        focusFirst(createDialog);
        break;
      case "to-approvals":
        if (!B.draft.account) break;
        B.create.step = "approvals";
        renderCreate();
        focusFirst(createDialog);
        break;
      case "to-account":
        B.create.step = "account";
        renderCreate();
        focusFirst(createDialog);
        break;
      case "first-bot":
        openCreate(t.closest("button"));
        break;
      case "create":
        create();
        break;
      case "review-bots":
        // Close and refresh the rail: what the gateway lists, nothing assumed. The attempt ends,
        // and what was entered for it goes with it: another bot starts from a new draft.
        B.create = { step: "look", status: "idle", opener: null };
        B.draft = { name: "", body: "drop", color: "#ff6f9c", account: null, model: null, effort: "Medium", perm: null };
        createDialog.close();
        app.render();
        break;
      case "review-settings":
        app.setPanel(true);
        $("#tab-settings")?.click();
        break;
      case "perm-again":
      case "restrict-again": {
        // Only for the bot whose note this is, after a fresh read identifies it, and only with admin:
        // one write, never Create.
        const c = recovery[t.closest("[data-b]").dataset.bot];
        if (!c || !isAdmin() || p("retry") === "gone") break;
        noteOn(c.task, c.name, { state: "reading" });
        if (action === "restrict-again") restrictive(c.id, c.name, c.perm, c.task);
        else policy(c.id, c.name, c.perm, c.task, true);
        break;
      }
      case "accounts-retry":
        B.accountsState = "ready";
        renderCreate();
        break;
      case "connect":
        startConnect(inDialog === createDialog ? "create" : "settings");
        if (inDialog === createDialog) B.create.step = "connect";
        rerender(true);
        break;
      case "connect-back":
        clearTimeout(flowTimer);
        if (c && c.view !== "providers" && !(c.view === "label")) {
          B.connect.view = "providers";
          B.connect.stage = null;
        } else {
          B.connect = null;
          if (inDialog === createDialog) B.create.step = "account";
        }
        rerender(true);
        break;
      case "to-providers":
        clearTimeout(flowTimer);
        B.connect.view = "providers";
        B.connect.stage = null;
        rerender(true);
        break;
      case "cancel-signin":
        clearTimeout(flowTimer);
        connectTo("cancelled");
        announce("Sign-in cancelled");
        focusFirst(inDialog);
        break;
      case "restart-signin":
        beginSignIn(c.option);
        break;
      case "domain-next":
        if (!c.domain.trim()) return;
        c.stage = "starting";
        rerender(true);
        flowTimer = setTimeout(() => connectTo("waiting"), 700);
        break;
      case "paste-next": {
        const value = $("[data-b-paste]", inDialog).value.trim();
        if (!value) return;
        c.stage = "checking";
        rerender(true);
        flowTimer = setTimeout(() => connectTo(value === "bad" ? "failed" : "connected"), 800);
        break;
      }
      case "open-link":
        announce("Opened in your browser");
        break;
      case "save-key": {
        const field = $("[data-b-key]", inDialog);
        if (!field.value.trim()) return field.focus();
        const provider = c.apikey.provider;
        let existing = accounts.find((a) => a.provider === provider && a.kind === "key");
        if (!existing) {
          existing = { id: `${provider}:manual`, provider, label: "", kind: "key", how: "API key, entered in Clawtrate", status: "static" };
          accounts.push(existing);
        }
        field.value = "";
        c.keyProvider = provider;
        c.newId = existing.id;
        c.label = existing.label;
        c.view = "label";
        rerender(true);
        announce("Key saved");
        break;
      }
      case "name-saved": {
        const o = option();
        const id = c.saved || `${o.provider}:second`;
        if (!acct(id)) accounts.push({ id, provider: o.provider, label: "", kind: o.group === "token" ? "key" : "subscription", type: "oauth", how: `${o.label}: ${FLOW_WORDS[o.flow].toLowerCase()}`, status: "ok" });
        c.newId = id;
        c.view = "label";
        rerender(true);
        break;
      }
      case "drop-saved":
        accounts = accounts.filter((a) => a.id !== c.saved);
        c.saved = null;
        rerender(true);
        announce("Disconnected");
        break;
      case "same-done":
        B.connect = null;
        if (inDialog === createDialog) B.create.step = "account";
        rerender(true);
        break;
      case "label-done": {
        const a = acct(c.newId);
        a.label = c.label.trim();
        delete a.fresh;
        const from = c.from;
        B.connect = null;
        if (from === "create") {
          B.create.step = "account";
          if (a.owner) B.createNote = `${acctName(a)} was saved for ${app.bots.find((x) => x.id === a.owner)?.name} only, so ${B.draft.name.trim() || "the new bot"} can't use it.`;
          else {
            B.draft.account = a.id;
            B.draft.model = MODELS[a.provider][0];
          }
        }
        rerender(true);
        CT.botsChanged?.();
        break;
      }
      case "to-nav":
        B.settings.pane = "nav";
        B.connect = null;
        renderSettings();
        $(`[data-b-section="${B.settings.section}"]`, settingsDialog)?.focus();
        break;
      case "to-accounts":
        B.settings.account = null;
        renderSettings();
        focusFirst(settingsDialog);
        break;
      case "relabel":
        B.settings.edit = true;
        renderSettings();
        focusFirst(settingsDialog);
        break;
      case "relabel-cancel":
        B.settings.edit = false;
        renderSettings();
        $('[data-b="relabel"]', settingsDialog)?.focus();
        break;
      case "relabel-save": {
        const a = acct(B.settings.account);
        const value = $("[data-b-relabel]", settingsDialog).value.trim();
        // A label can't be cleared while another account of its provider needs telling apart.
        if (!value && accounts.some((x) => x !== a && x.provider === a.provider)) {
          $("[data-b-relabel]", settingsDialog).setAttribute("aria-invalid", "true");
          return announce(`A label is needed: you have another ${providerName(a.provider)} account`);
        }
        if (accounts.some((x) => x !== a && x.provider === a.provider && x.label.toLowerCase() === value.toLowerCase())) {
          $("[data-b-relabel]", settingsDialog).setAttribute("aria-invalid", "true");
          return announce(`Another ${providerName(a.provider)} account is called ${value}`);
        }
        a.label = value;
        B.settings.edit = false;
        renderSettings();
        $('[data-b="relabel"]', settingsDialog)?.focus();
        announce("Label saved");
        CT.botsChanged?.();
        break;
      }
      case "replace-key": {
        const a = acct(B.settings.account);
        startConnect("settings");
        B.connect.apikey.provider = a.provider;
        rerender(true);
        const d = $(".b-disclosure", settingsDialog);
        if (d) d.open = true;
        $("[data-b-key]", settingsDialog)?.focus();
        break;
      }
      case "resign": {
        const a = acct(B.settings.account);
        startConnect("settings");
        beginSignIn(OPTIONS.find((o) => o.provider === a.provider).id);
        break;
      }
      case "disconnect":
        disconnect(acct(B.settings.account));
        break;
      case "confirm-cancel":
        confirmDialog.close();
        break;
      case "confirm-ok":
        confirmDialog.close();
        confirmAction?.();
        break;
      case "confirm-alt":
        confirmDialog.close();
        confirmAlt?.();
        break;
      case "request-write":
        // The interactive tier's request (conversation.md section 3), granted here at once.
        B.access = "write";
        app.model.access = "write";
        rerender();
        announce("Access granted. You can send, stop and answer.");
        break;
      case "request":
        requestAdmin();
        break;
      case "request-check":
        grantAdmin();
        break;
      case "request-cancel":
        B.req = "none";
        rerender();
        announce("Request cancelled");
        break;
    }
  });

  // Copy says what happened: a check when the clipboard took it; otherwise the
  // text is selected and the announcer says how to copy it.
  document.addEventListener("click", async (event) => {
    const button = event.target.closest(".b-dialog .copy[data-copy], #work-panel .copy[data-copy]");
    if (!button) return;
    const what = button.dataset.what;
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.dataset.copied = "true";
      announce(`Copied ${what}`);
    } catch {
      const code = button.parentElement.querySelector("code");
      if (code) getSelection().selectAllChildren(code);
      button.dataset.copied = "failed";
      announce("Couldn't copy. The text is selected.");
    }
    setTimeout(() => delete button.dataset.copied, 1400);
  });

  // The countdown on a pending request.
  setInterval(() => {
    if (B.req !== "requested") return;
    B.seconds = B.seconds <= 1 ? 4 : B.seconds - 1;
    $$(".access-wait").forEach((el) => (el.textContent = `checking again in ${B.seconds}s`));
  }, 1000);

  // Prototype controls in the dark bar, for the stages a real provider would cause.
  const extra = $("#proto-extra .run-controls");
  if (extra) {
    extra.insertAdjacentHTML(
      "afterbegin",
      `<button type="button" data-b-proto="approve">Sign-in approved</button><button type="button" data-b-proto="expire">Expire</button>` +
        `<button type="button" data-b-proto="fail">Refuse</button><button type="button" data-b-proto="drop">Drop connection</button>`,
    );
    extra.addEventListener("click", (event) => {
      const what = event.target.closest("[data-b-proto]")?.dataset.bProto;
      if (!what || !B.connect || B.connect.view !== "flow") return;
      clearTimeout(flowTimer);
      connectTo({ approve: "connected", expire: "expired", fail: "failed", drop: "dropped" }[what]);
    });
  }

  // Shared with the later parts of this file.
  Object.assign(CT, { botsKeep: keep, botsRove: rove, botsData: { B, GATEWAY, DEFAULT_MODEL, shared, firstModel, gatewayRow, accounts: () => accounts, binding, MODELS, EFFORTS, PROVIDERS, OPTIONS, acct, acctName, acctTitle, accountRow, accountGroups, providerName, stateOf, usedBy, kindWord, isAdmin, adminBar, button, note, copy, glyph, wait, result, back, close, select, announce, rerender, openSettings, openCreate, startConnect, beginSignIn, renderSettings, focusFirst, openSelect, closeSelect, confirmBox } });

  // First paint from the address --------------------------------------------------------------------------

  // The shell's own question, "may this connection write?", follows the tier.
  if (B.access === "read") {
    app.model.access = "read";
    if (app.bots.length) app.selectBot(app.model.selectedBot);
  }
  if (p("open") === "create") {
    if (B.create.step === "connect") startConnect("create", p("connect"), p("stage"));
    openCreate($("#new-button"));
    if (B.connect?.option && !p("stage")) beginSignIn(B.connect.option);
    if (B.connect?.stage === "connected") connectTo("connected");
  }
  if (p("open") === "settings") {
    if (p("connect") || p("step") === "connect") startConnect("settings", p("connect"), p("stage"));
    openSettings($(".gateway-pill"));
    if (B.connect?.stage === "connected") connectTo("connected");
  }
  // The first-bot prompt (bots.md section 3, F-005) rests on the gateway's replies, not on an
  // empty rail: exactly one user-visible agent, an unnamed, non-degraded main with defaultId main;
  // a config with neither agents.entries nor the legacy agents.list; and a complete, unfiltered
  // session list for main with no tasks. Anything else, or a missing reply, is the normal roster.
  const roster = p("state") === "nobots" ? p("roster") || "unused" : null;
  const REPLIES = roster && {
    agents: roster === "fail" ? null : { agents: [{ id: "main", name: null, degraded: false }], defaultId: "main" },
    config: { entries: false, legacyList: roster === "legacy" },
    sessions: roster === "missing" ? null : { complete: true, filtered: false, count: roster === "used" ? 2 : 0 },
  };
  const firstBot = (r) =>
    Boolean(
      r?.agents && r.agents.defaultId === "main" && r.agents.agents.length === 1 && r.agents.agents[0].id === "main" && !r.agents.agents[0].name && !r.agents.agents[0].degraded &&
        r.config && !r.config.entries && !r.config.legacyList &&
        r.sessions && r.sessions.complete && !r.sessions.filtered && r.sessions.count === 0,
    );
  const FIRST = { eligible: firstBot(REPLIES) };
  // Not confirmed, with the agent listed: main is shown as a bot, named Main, as today.
  if (REPLIES && !FIRST.eligible && REPLIES.agents) {
    CT.botArt.main = CT.botArt.main || { body: "drop", color: "#5b8dff", tilt: 0, look: [0.6, 0] };
    const tasks = roster === "used" ? [{ id: "main-1", title: "Main", at: 2000, when: "yesterday", preview: "Earlier work.", unread: false, status: "idle", html: "" }] : [];
    app.bots.push({ id: "main", name: "Main", label: "", tasks });
    app.selectBot("main");
  }
  const MAIN_POLICY = {
    guarded: "The gateway reports that Main's default command policy asks on an allowlist miss.",
    full: "The gateway reports no routine approval in Main's default command policy.",
    "read-only": "The gateway reports that Main's default command policy disables commands.",
  };
  CT.emptyGateway = () => {
    if (!FIRST.eligible) return null;
    const said = MAIN_POLICY[p("defperm") || "full"] || "";
    return (
      `<div class="empty b-first" data-b-first><div>` +
      `<span class="b-preview" aria-hidden="true">${draftArt()}</span>` +
      `<h1>Make your first bot</h1><p>Give it a name and a picture, choose the account it runs on and how it runs commands.</p>` +
      (isAdmin()
        ? `<div class="empty-actions">${button("New bot", 'data-b="first-bot"', "primary")}</div>`
        : (said ? `<p class="b-hint" data-b-default-policy>${said}</p>` : "") +
          `<div class="b-first-bar">${adminBar("Creating a bot changes the gateway's settings, which needs admin access.")}</div>`) +
      `</div></div>`
    );
  };
  if (!app.bots.length) app.render();

  // For the checks: what the host wrote, its Create guard, a change of access while a dialog is open, and the first-bot reading.
  const setAccess = (tier) => {
    B.access = tier;
    refreshNotes();
    if (createDialog.open) renderCreate();
  };
  window.bots = { B, accounts: () => accounts, binding, openCreate, create, openSettings, connectTo, grantAdmin, writes: () => writes.map((w) => ({ ...w })), hostCreate, setAccess, first: () => ({ eligible: FIRST.eligible }) };
})();
