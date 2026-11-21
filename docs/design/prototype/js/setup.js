// Behaviour for setup.html: every screen of docs/design/setup.md, chosen with
// ?screen=<id> (SCREENS below; the README lists them). No program runs and
// nothing is contacted. Each action goes where the real one would lead, so
// every path can be walked to its outcome by clicking; a wait reached through
// a click plays on to what it leads to, and from the address it holds.
//
// The host's confirmation is drawn here as a stand-in (.s-host): in the app it
// is a native dialog the page cannot draw or answer. Events that come from
// outside the app (the gateway's owner approving, a phone scanning) are
// buttons in a dashed "Prototype" box, which is not product.

(function () {
  const CT = window.CT;
  const params = CT.params;
  const screen = params.get("screen") || "first";
  const icon = (name) => CT.icon(name);
  const esc = (text) =>
    String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  // Every other setting of the address is kept when moving between screens.
  const TRANSIENT = ["slow", "chosen", "play", "host", "next", "to", "keep", "name"];
  const go = (to, extra = {}) => {
    const next = new URLSearchParams(location.search);
    next.set("screen", to);
    for (const key of TRANSIENT) next.delete(key);
    for (const [key, value] of Object.entries(extra)) next.set(key, value);
    return `setup.html?${next}`;
  };
  // The destination typed in the field, carried through the walk (Back keeps
  // it), always shown escaped. `host` is its host part; `full` is the account,
  // host and port as resolved (in the prototype: "you@<host>.example", port 22).
  const typedRaw = params.get("name") || "devbox";
  const typed = esc(typedRaw);
  const hostRaw = typedRaw.split("@").pop();
  const host = esc(hostRaw.split(".")[0]);
  const resolvedRaw = typedRaw.includes("@") ? typedRaw : `you@${hostRaw.includes(".") ? hostRaw : `${hostRaw}.example`}`;
  const full = esc(resolvedRaw);

  // Samples. Fingerprints, device codes and setup codes are invented; the codes
  // decode to an address and the word "sample", never a token.
  const PRINT = "SHA256:Q3v8Lw0e Xk2Rj9Ta Nf5Hc1Ub Ym7Pd4Gs Zi6Ko2Ea Vr8";
  const PRINT_NEW = "SHA256:Hb2Wq9Lx Tn4Ce7Ry Mk1Pz5Vd Fs8Ja3Ug Ow6Ni0Ek Tc5";
  const REQUEST = "e5eb4aa8-175f-40f1-bc7a-8f15cfc40942";
  const PHONE_REQUEST = "7c41d2e0-9a3b-4f0e-8c55-2d6e1b0a9f34";
  const PHONE_DEVICE = "7C41-D2E0";
  const ADVANCED = "connect.html";
  const FAR_FUTURE = 4102444800000; // 2100: the samples never expire while looked at

  // Pieces ----------------------------------------------------------------------

  const logo = "../../../packages/ui/src/assets/logo-mark.png";
  const brand = () =>
    `<header class="connect-brand"><img src="${logo}" alt="" width="56" height="56" />` +
    `<h1>Clawtrate</h1><p>Your OpenClaw agents, orchestrated.</p></header>`;
  const mark = () => `<img class="s-mark" src="${logo}" alt="" width="44" height="44" />`;
  const back = (to, extra = {}) =>
    `<div class="s-top"><a class="button" data-variant="quiet" data-size="sm" href="${go(to, extra)}" data-back>${icon("back")}Back</a></div>`;
  const title = (text) => `<h2 class="s-title" tabindex="-1" data-s-title>${text}</h2>`;
  const lede = (html) => `<p class="s-lede">${html}</p>`;
  const hint = (html) => `<p class="s-hint">${html}</p>`;

  const button = (label, { variant, to, size = "lg", disabled = false, id, play, extra = {}, host, attrs = "" } = {}) => {
    const base = `class="button"${variant ? ` data-variant="${variant}"` : ""} data-size="${size}"${id ? ` id="${id}"` : ""}${attrs ? ` ${attrs}` : ""}`;
    if (host) return `<button type="button" ${base} data-host="${host}"${disabled ? " disabled" : ""}>${label}</button>`;
    if (to && !disabled) return `<a ${base} href="${go(to, { ...extra, ...(play ? { play: "1" } : {}) })}">${label}</a>`;
    return `<button type="button" ${base}${disabled ? " disabled" : ""}>${label}</button>`;
  };
  const actions = (...buttons) => `<div class="s-actions">${buttons.join("")}</div>`;

  const note = (tone, lead, text, extra = "") =>
    `<div class="b-note"${tone ? ` data-tone="${tone}"` : ""} role="${tone === "danger" ? "alert" : "status"}">` +
    `${icon(tone ? "warning" : "clock")}<div><p>${lead ? `<b>${lead}</b>` : ""}${lead && text ? " " : ""}${text}</p>${extra}</div></div>`;

  const steps = (list) =>
    `<ol class="s-steps" aria-label="Steps">` +
    list
      .map(([text, state, sub, time]) => {
        const markIcon = state === "done" ? icon("check") : state === "failed" ? icon("x") : "";
        return (
          `<li data-state="${state}"${state === "running" ? ' aria-current="step"' : ""} aria-label="${esc(text)}, ${state}">` +
          `<span class="s-step-mark">${markIcon}</span><span>${text}</span><span class="s-step-time">${time || ""}</span>` +
          (sub ? `<span class="s-step-sub">${sub}</span>` : "") +
          `</li>`
        );
      })
      .join("") +
    `</ol>`;

  const facts = (rows) => `<dl class="facts">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>`;
  const sentenceFacts = (rows) =>
    `<dl class="s-facts">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>`;
  const found = (markName, tone, heading, rows, after = "") =>
    `<div class="s-found"><span class="empty-mark"${tone ? ` data-tone="${tone}"` : ""}>${icon(markName)}</span>` +
    `<h3>${heading}</h3>${rows ? facts(rows) : ""}</div>${after}`;

  const copyButton = (label, text) =>
    `<button type="button" class="icon-button copy" aria-label="${label}" data-copy="${esc(text)}">${icon("copy")}</button>`;
  const command = (text, label) =>
    `<div class="command"><code>${esc(text)}</code>${copyButton(label, text)}</div><p class="copy-status" aria-live="polite"></p>`;
  const fingerprint = (label, value) =>
    `<div class="s-print"><div class="s-print-text"><span class="s-print-alg">${label}</span>` +
    `<code aria-label="${esc(value.replace(/ /g, ", "))}">${value}</code></div>${copyButton(`Copy the ${label.toLowerCase()} fingerprint`, value.replace(/ /g, ""))}</div>`;
  const deviceCode = (code, label) =>
    `<p class="s-device" aria-label="${label}: ${code.split("").join(" ")}">${code}</p>`;
  const disclosure = (label, body) =>
    `<details class="b-disclosure s-disclosure"><summary>${label}</summary><div class="b-disclosure-body">${body}</div></details>`;
  // The display settings, carried to another page of the prototype.
  const display = () => {
    const kept = new URLSearchParams([...params].filter(([k]) => ["theme", "width", "motion", "chrome"].includes(k)));
    return kept.size ? `?${kept}` : "";
  };

  const choiceRow = ({ title: t, sub, to, radio, checked, extra = {}, play }) => {
    const inner =
      `<span class="b-choice-text"><span class="b-choice-title">${t}</span>${sub ? `<span class="b-choice-sub">${sub}</span>` : ""}</span>` +
      (radio ? icon("check").replace('class="icon"', 'class="icon b-tick"') : icon("chevron"));
    if (radio)
      return `<li><button type="button" class="b-choice" role="radio" aria-checked="${checked ? "true" : "false"}" data-radio>${inner}</button></li>`;
    return `<li><a class="b-choice" href="${go(to, { ...extra, ...(play ? { play: "1" } : {}) })}" data-choice>${inner}</a></li>`;
  };

  const dialog = (kind, heading, body, foot, closeTo) =>
    `<div class="s-scrim"><div class="b-dialog" ${kind ? `data-kind="${kind}" ` : ""}role="dialog" aria-modal="true" aria-labelledby="s-dialog-title" open>` +
    `<header class="b-head"><h2 id="s-dialog-title" tabindex="-1" data-s-title>${heading}</h2>` +
    (closeTo ? `<a class="icon-button b-close" href="${go(closeTo)}" aria-label="Close">${icon("x")}</a>` : "") +
    `</header><div class="b-body">${body}</div>${foot ? `<div class="b-foot">${foot}</div>` : ""}</div></div>`;

  // The host's confirmations ---------------------------------------------------
  // Each: the message, the detail, an optional checkbox that must be ticked,
  // the confirming button's words, and where it leads.

  // Approving a request (setup.md section 9). The route: SSH on devbox (default),
  // this computer (approve-here), or an address (approve-address). The flow: a
  // write upgrade (default), admin (flow=admin) or a first pairing
  // (approve-pairing). exact=1 draws the future "Approve from here", which needs
  // an exact approval path that OpenClaw 2026.10.6 doesn't have.
  const approveRoute = screen === "approve-here" ? "here" : screen === "approve-address" ? "address" : "ssh";
  const approveFlow = screen === "approve-pairing" ? "pairing" : params.get("flow") === "admin" ? "admin" : "upgrade";
  const approveCommand = () => `openclaw ${approveRoute === "here" ? "--profile clawtrate " : ""}devices approve ${REQUEST}`;
  const ADDED = {
    upgrade: ["Send messages and start tasks", "Answer approvals", "Answer questions"],
    admin: ["Send messages and start tasks", "Answer approvals", "Answer questions", "Change the gateway's settings, bots and accounts. This is admin access."],
    pairing: ["Read bots, tasks and conversations."],
  };

  const HOST = {
    sshAccount: {
      message: `Look for OpenClaw as ${full}, port 22?`,
      detail: "<p>This uses the remote account's SSH login environment.</p>",
      confirm: "Continue",
      to: () =>
        hostRaw.split(".")[0] === "newbox"
          ? go("hostkey", { name: typedRaw })
          : go("looking-there", { play: "1", name: typedRaw, next: hostRaw.split(".")[0] === "emptybox" ? "notfound-there" : "found-there" }),
    },
    trustKey: {
      message: `Trust ${host}'s key?`,
      detail: `<p>ED25519 ${PRINT}</p><p>Clawtrate will connect to ${host} only while it presents this key.</p>`,
      confirm: "Trust",
      to: () => go("looking-there", { play: "1", next: "found-there", name: typedRaw }),
    },
    replaceKey: {
      message: `Replace ${host}'s trusted key?`,
      detail: `<p>Trusted: ${PRINT}</p><p>Presented now: ${PRINT_NEW}</p>`,
      checkbox: `I checked the new key on ${host} itself`,
      confirm: "Replace",
      to: () => go("looking-there", { play: "1", next: "found-there", name: typedRaw }),
    },
    pair: {
      message: "Pair this device read-only with the default gateway on this computer?",
      detail: "<p>The gateway saves this device.</p>",
      confirm: "Pair",
      to: () => go("connecting-here", { play: "1" }),
    },
    pairThere: {
      message: `Pair this device read-only with the default gateway on ${full}?`,
      detail: "<p>The gateway saves this device.</p>",
      confirm: "Pair",
      to: () => go("connecting-there", { play: "1", name: typedRaw }),
    },
    start: {
      message: "Start OpenClaw on this computer?",
      detail: "<p>Starts the LaunchAgent ai.openclaw.gateway. It keeps running after Clawtrate closes.</p>",
      confirm: "Start",
      to: () => go("found"),
    },
    install: {
      message: "Set up OpenClaw on this computer?",
      detail:
        "<p>Clawtrate checks the OpenClaw and Node.js downloads against fingerprints built into this version. Setup also installs code from npm that Clawtrate hasn't pinned or verified. That code can run with your account's permissions.</p>",
      confirm: "Set up",
      to: () => go("installing", { play: "1" }),
    },
    // "Approve from here" (setup.md section 9), drawn only with exact=1: it needs
    // an exact approval path the running OpenClaw proves. Confirming runs the
    // host-result fixture in the page (approval controller below).
    approveRequest: {
      message:
        approveFlow === "pairing"
          ? `Pair this device with the default gateway on ${approveRoute === "here" ? "this computer" : full}?`
          : `Approve this device's request on the ${approveRoute === "here" ? "Clawtrate gateway on this computer" : `default gateway on ${full}`}?`,
      detail:
        `<p>Profile: ${approveRoute === "here" ? "clawtrate" : "default"}${approveRoute === "here" ? "" : ` · ${full}, port 22`} · this device <span class="s-device-inline">5AE2-3AFF</span></p>` +
        (approveFlow === "pairing" ? "" : `<p>It adds:</p>`) +
        `<ul class="s-host-list" data-added>${ADDED[approveFlow].map((x) => `<li>${x}</li>`).join("")}</ul>` +
        `<p>Clawtrate approves request e5eb4aa8 on ${approveRoute === "here" ? "this computer" : host}, then checks what the gateway granted.</p>`,
      confirm: approveFlow === "pairing" ? "Pair" : "Approve",
      onConfirm: () => CT.approval?.confirm(),
    },
    removeRoute: {
      message: "Remove devbox from Clawtrate?",
      detail: "<p>Clawtrate disconnects, forgets this route and its pinned key, and leaves OpenClaw on devbox running.</p>",
      checkbox: "Also stop OpenClaw on devbox (Clawtrate started it)",
      optional: true,
      confirm: "Remove",
      to: () => go("first"),
    },
  };

  const hostDialog = (op) => {
    const d = HOST[op];
    return (
      `<div class="s-host-scrim" data-host-scrim><div class="s-host" role="alertdialog" aria-modal="true" aria-labelledby="s-host-title" aria-describedby="s-host-detail" data-host-dialog="${op}">` +
      `<p class="s-host-caption">The app's own dialog, not part of the page (a stand-in for the native dialog)</p>` +
      `<div class="s-host-body"><img src="${logo}" alt="" width="40" height="40" /><div>` +
      `<h2 id="s-host-title" tabindex="-1">${d.message}</h2><div id="s-host-detail" class="s-host-detail">${d.detail}</div>` +
      (d.checkbox ? `<label class="s-check"><input type="checkbox" data-host-check /> <span>${d.checkbox}</span></label>` : "") +
      `</div></div><div class="s-host-buttons"><button type="button" class="button" data-size="sm" data-host-cancel>Cancel</button>` +
      (d.onConfirm
        ? `<button type="button" class="button" data-variant="primary" data-size="sm" data-host-confirm>${d.confirm}</button>`
        : `<a class="button" data-variant="primary" data-size="sm" href="${d.to()}" data-host-confirm${d.checkbox && !d.optional ? ' aria-disabled="true"' : ""}>${d.confirm}</a>`) +
      `</div></div></div>`
    );
  };

  // Screens -----------------------------------------------------------------------

  const runningFacts = (where = "On this computer only", version = "2026.10.6") => [
    ["Version", version],
    ["Profile", "default"],
    ["Listens", where],
    ["Service", "LaunchAgent, starts when you log in"],
  ];
  const connectHint = hint(
    "Connect pairs this computer with the gateway as a device that can only read, and the gateway keeps it. Sending or changing anything is asked for later.",
  );
  const howToUpdate = disclosure(
    "How to update",
    command("openclaw update", "Copy update command") + `<p class="s-hint">Run it yourself when you're ready.</p>`,
  );
  const sshField = (value = "", error = "") =>
    `<label class="field"><span class="s-field-label">SSH host or alias</span>` +
    `<input class="input" id="ssh-host" name="ssh-host" type="text" placeholder="devbox or you@devbox.example" autocomplete="off" spellcheck="false" value="${esc(value)}" /></label>` +
    (error ? `<p class="s-field-error" id="ssh-error" role="alert">${error}</p>` : "") +
    hint("Clawtrate uses your SSH keys and the host's settings from your SSH configuration, and never asks for a password.");

  const windows = params.get("os") === "windows";

  const SCREENS = {
    first: () =>
      brand() +
      `<h2 class="s-title s-question" tabindex="-1" data-s-title>Where does OpenClaw run?</h2>` +
      `<ul class="b-choices" aria-label="Where does OpenClaw run?" data-choice-list>` +
      choiceRow(
        windows
          ? { title: "This computer", sub: "Clawtrate looks for OpenClaw here.", to: "notfound-windows", extra: { os: "windows" } }
          : { title: "This computer", sub: "Clawtrate looks for OpenClaw here.", to: "looking-here", play: true },
      ) +
      choiceRow({ title: "Another computer", sub: "A computer you reach with SSH, such as a server or a desktop at home.", to: "there" }) +
      `</ul>` +
      `<p class="s-links">${button("Have a setup code?", { variant: "quiet", size: "sm", to: "code" })}<a class="button" data-variant="quiet" data-size="sm" href="connect.html${display()}" id="advanced-link">Advanced</a></p>` +
      hint(
        windows
          ? "New to OpenClaw? Choose Another computer to use or set up OpenClaw on a Mac or a Linux computer."
          : "New to OpenClaw? Choose where it should run, and Clawtrate offers to set it up there.",
      ),

    "looking-here": () =>
      back("first") +
      mark() +
      title("Looking on this computer") +
      steps([
        ["Finding OpenClaw", "done"],
        ["Checking its version", "running"],
        ["Asking the gateway", "waiting"],
      ]) +
      (params.get("slow") === "1" ? `<p class="s-slow" role="status">Still looking. A gateway that has just started can take a while to answer.</p>` : ""),

    found: () =>
      back("first") +
      mark() +
      title("On this computer") +
      found("check", "ok", "OpenClaw is running", runningFacts()) +
      actions(button("Connect", { variant: "primary", host: "pair" })) +
      connectHint,

    "connecting-here": () =>
      back("found") +
      mark() +
      title("Connecting") +
      steps([
        ["Making a one-time code", "done"],
        ["Pairing this computer, read-only", "running"],
        ["Loading your bots", "waiting"],
      ]),

    stopped: () =>
      back("first") +
      mark() +
      title("On this computer") +
      found("pause", "", "OpenClaw is installed but not running", [
        ["Version", "2026.10.6"],
        ["Service", "LaunchAgent, stopped"],
        ["Port", "Nothing listening on 18789"],
      ]) +
      actions(button("Start OpenClaw", { variant: "primary", host: "start" })),

    untested: () =>
      back("first") +
      mark() +
      title("On this computer") +
      found("check", "ok", "OpenClaw is running", runningFacts("On this computer only", "2026.9.37")) +
      note(
        "warn",
        "",
        "OpenClaw 2026.9.37 isn't the version this Clawtrate is tested with (2026.10.6). Use Advanced to connect to it.",
      ) +
      actions(`<a class="button" data-variant="primary" data-size="lg" href="${ADVANCED}">Use Advanced</a>`) +
      howToUpdate,

    tooold: () =>
      back("first") +
      mark() +
      title("On this computer") +
      found("x", "danger", "This OpenClaw is too old for Clawtrate", null, lede("OpenClaw 2026.6.2 speaks an older protocol than Clawtrate needs. Update it, then look again.")) +
      actions(button("Look again", { variant: "primary", to: "looking-here", play: true })) +
      howToUpdate,

    "setup-missing": () =>
      back("first") +
      mark() +
      title("On this computer") +
      found(
        "warning",
        "warn",
        "OpenClaw seems to be set up here, but Clawtrate can't find its program",
        null,
        lede("Clawtrate looked in the usual places. If you installed OpenClaw somewhere else, use Advanced, or run <code>openclaw gateway status</code> here to see where it is."),
      ),

    canttell: () =>
      back("first") +
      mark() +
      title("On this computer") +
      found("warning", "warn", "Clawtrate couldn't tell what is on this computer", null, lede("Asking the gateway didn't finish in time.")) +
      actions(
        `<a class="button" data-variant="primary" data-size="lg" href="${ADVANCED}">Use Advanced</a>`,
        button("Look again", { variant: "quiet", to: "looking-here", play: true }),
      ),

    nottoken: () =>
      back("first") +
      mark() +
      title("On this computer") +
      found("warning", "warn", "This gateway uses another way to sign in", null, lede("Clawtrate connects by itself only to gateways that use a token. Use Advanced.")) +
      `<p class="s-links"><a class="button" data-variant="quiet" data-size="sm" href="connect.html">Advanced</a></p>`,

    notfound: () =>
      back("first") +
      mark() +
      title("On this computer") +
      found("plus", "", "Clawtrate didn't find OpenClaw here", null) +
      actions(
        button("Set up OpenClaw here", { variant: "primary", to: "install-confirm" }),
        button("It runs on another computer", { variant: "quiet", to: "there" }),
      ) +
      note("", "", "Clawtrate also saw another OpenClaw service here (OpenClaw Gateway (work)). It connects only to the default gateway and its own; use Advanced for others."),

    "notfound-windows": () =>
      back("first", { os: "windows" }) +
      mark() +
      title("On this computer") +
      found(
        "plus",
        "",
        "Use Advanced on Windows",
        null,
        lede("Clawtrate can't yet look for OpenClaw on Windows. It doesn't set OpenClaw up on Windows either: OpenClaw's Windows installer can change Node.js or PATH and installs OpenClaw globally."),
      ) +
      actions(
        `<a class="button" data-variant="primary" data-size="lg" href="${ADVANCED}">Use Advanced</a>`,
        button("Use another computer", { to: "there" }),
      ) +
      `<p class="s-links"><a class="button" data-variant="quiet" data-size="sm" href="https://docs.openclaw.ai/install" target="_blank" rel="noreferrer noopener">OpenClaw's own install instructions</a></p>`,

    there: () => {
      const returning = params.get("returning") === "1";
      return (
        back("first") +
        mark() +
        title("Another computer") +
        (returning
          ? `<ul class="b-choices s-remembered" aria-label="Computers you used before">` +
            `<li><a class="b-choice" href="${go("there", { name: "you@devbox.example", keep: "you@devbox.example", returning: "1", host: "sshAccount" })}" data-choice><span class="b-choice-text"><span class="b-choice-title">you@devbox.example</span><span class="b-choice-sub">OpenClaw 2026.10.6 · last used today</span></span>${icon("chevron")}</a></li>` +
            `</ul>`
          : "") +
        `<form id="ssh-form" novalidate>${sshField(params.get("keep") || "")}` +
        actions(`<button type="submit" class="button" data-variant="primary" data-size="lg">Look there</button>`) +
        `</form><p class="s-links">${button("Have a setup code instead?", { variant: "quiet", size: "sm", to: "code" })}<a class="button" data-variant="quiet" data-size="sm" href="${ADVANCED}">Advanced</a></p>` +
        `<p class="s-proto-hint">Prototype: “newbox” is a first contact, “emptybox” has no OpenClaw, “jumpbox” uses a jump host, anything else is found.</p>`
      );
    },

    "there-config": () =>
      back("there", { keep: typedRaw }) +
      mark() +
      title("Another computer") +
      sshField(typedRaw) +
      note(
        "warn",
        `${host} is reached through another computer.`,
        `Clawtrate doesn't connect through jump hosts yet. Use a setup code made on ${host}, or Advanced.`,
      ) +
      actions(button("Use a setup code", { variant: "primary", to: "code" })) +
      `<p class="s-links"><a class="button" data-variant="quiet" data-size="sm" href="${ADVANCED}">Advanced</a></p>`,

    "looking-there": () =>
      back("there", { keep: typedRaw }) +
      mark() +
      title(`Looking on ${full}`) +
      steps([
        [`Reaching ${host}`, "done"],
        ["Finding OpenClaw", "running"],
        ["Checking its version", "waiting"],
        ["Asking the gateway", "waiting"],
      ]),

    unreachable: () =>
      back("there", { keep: typedRaw }) +
      mark() +
      title("Another computer") +
      `<form id="ssh-form" novalidate>${sshField(typedRaw)}` +
      note("danger", `Can't reach ${full}`, `Nothing answered at ${esc(resolvedRaw.split("@").pop())}, port 22 (connection refused).`, `<p>Check the name and that the computer is on.</p>`) +
      actions(`<button type="submit" class="button" data-variant="primary" data-size="lg">Try again</button>`) +
      `</form>` +
      `<p class="s-links"><a class="button" data-variant="quiet" data-size="sm" href="${ADVANCED}">Advanced</a></p>`,

    refused: () =>
      back("there", { keep: typedRaw }) +
      mark() +
      title("Another computer") +
      `<form id="ssh-form" novalidate>${sshField(typedRaw)}` +
      note(
        "danger",
        `${full} didn't accept your key`,
        `The SSH sign-in for ${full} was refused.`,
        `<p>Check that your key is on that computer. A key with a passphrase has to be in your SSH agent first.</p>`,
      ) +
      actions(`<button type="submit" class="button" data-variant="primary" data-size="lg">Try again</button>`) +
      `</form>` +
      `<p class="s-links"><a class="button" data-variant="quiet" data-size="sm" href="${ADVANCED}">Advanced</a></p>`,

    hostkey: () =>
      back("there", { keep: typedRaw }) +
      mark() +
      title(`Is this ${host}?`) +
      lede(`This is the first time Clawtrate connects to ${host}. Its key is below. If you can, compare it with the key ${host} itself shows before you trust it.`) +
      fingerprint("ED25519", PRINT) +
      disclosure(
        "How to compare",
        `<p class="s-hint">On ${host}, in a session you already trust, <code>ssh-keygen -lf</code> with the key file shows its fingerprint. The file depends on the key's type, for example <code>/etc/ssh/ssh_host_ed25519_key.pub</code>.</p>`,
      ) +
      actions(button("Trust this key…", { variant: "primary", host: "trustKey" }), button("Back", { to: "there", extra: { keep: typedRaw } })),

    "hostkey-changed": () =>
      back("there", { keep: typedRaw }) +
      mark() +
      title("Another computer") +
      note(
        "danger",
        `${host}'s key has changed`,
        `The key ${host} presented is not the one Clawtrate trusted. This happens when a computer is reinstalled, and it is also what someone between you and ${host} would cause. Clawtrate won't connect until you decide.`,
      ) +
      `<div class="s-prints">${fingerprint("Trusted", PRINT)}${fingerprint("Presented now", PRINT_NEW)}</div>` +
      `<p class="s-print-label">Trusted since 3 November</p>` +
      actions(button("Try again", { variant: "primary", host: "sshAccount" }), button("Back", { to: "there" })) +
      `<p class="s-links">${button("Replace the trusted key…", { variant: "quiet", size: "sm", host: "replaceKey" })}</p>`,

    "found-there": () =>
      back("there", { keep: typedRaw }) +
      mark() +
      title(`On ${full}`) +
      found("check", "ok", "OpenClaw is running", [
        ["Version", "2026.10.6"],
        ["Profile", "default"],
        ["Listens", `On ${host} only`],
        ["Service", "systemd user service, starts with your session"],
      ]) +
      actions(button("Connect", { variant: "primary", host: "pairThere" })) +
      connectHint,

    "connecting-there": () =>
      back("found-there", { name: typedRaw }) +
      mark() +
      title(`Connecting to ${full}`) +
      steps([
        [`Making a one-time code on ${host}`, "done"],
        [`Opening a private connection to ${host}`, "running"],
        ["Pairing this computer, read-only", "waiting"],
        ["Loading your bots", "waiting"],
      ]),

    "notfound-there": () =>
      back("there", { keep: typedRaw }) +
      mark() +
      title(`On ${full}`) +
      found("plus", "", "Clawtrate didn't find OpenClaw here", null, lede("Setting OpenClaw up on another computer isn't offered in this version.")) +
      `<p class="s-links">${button("Use a setup code", { variant: "quiet", size: "sm", to: "code" })}<a class="button" data-variant="quiet" data-size="sm" href="${ADVANCED}">Advanced</a></p>`,

    "install-confirm": () =>
      back("notfound") +
      mark() +
      title("Set up OpenClaw on this computer") +
      sentenceFacts([
        ["What", "OpenClaw 2026.10.6, the version this Clawtrate is tested with, with its own copy of Node.js 24.22.1"],
        ["Where", "Clawtrate puts OpenClaw's program and gateway data in its own folders and adds a user service. npm can also write its cache and OpenClaw can write service logs."],
        [
          "Checked",
          "Clawtrate checks the OpenClaw and Node.js downloads against fingerprints built into this version. Setup also installs code from npm that Clawtrate hasn't pinned or verified. That code can run with your account's permissions.",
        ],
        [
          "Then",
          "A gateway that listens on this computer only, as a LaunchAgent that starts when you log in, with no AI provider yet. You sign in to one when you make your first bot.",
        ],
      ]) +
      hint("Nothing is asked for: no account and no model key.") +
      hint("OpenClaw keeps running if you remove Clawtrate. Removing this gateway in Settings can also stop it; removing OpenClaw isn't offered in this version.") +
      actions(button("Set up OpenClaw…", { variant: "primary", host: "install" }), button("Cancel", { to: "notfound" })),

    installing: () =>
      mark() +
      title("Setting up OpenClaw") +
      steps([
        ["Download and check OpenClaw 2026.10.6", "done"],
        ["Install Node.js and OpenClaw", "running", "Node.js 24.22.1, checked", "0:14"],
        ["Set up the gateway", "waiting"],
        ["Start and check", "waiting"],
      ]) +
      hint("The times are samples."),

    "install-failed": () =>
      back("notfound") +
      mark() +
      title("Setting up OpenClaw") +
      steps([
        ["Download and check OpenClaw 2026.10.6", "done"],
        ["Install Node.js and OpenClaw", "failed"],
        ["Set up the gateway", "waiting"],
        ["Start and check", "waiting"],
      ]) +
      note("danger", "Install Node.js and OpenClaw failed.", "The installer didn't use the checked Node.js.") +
      disclosure("Show details", sentenceFacts([["Step", "Install Node.js and OpenClaw"], ["Error", "Node.js check"], ["Exit status", "1"]])),
  };

  // Screens over the app: the access bar, the strip, Settings and the phone. -----

  const mockApp = (strip, foot) =>
    `<div class="s-mock"><div class="conversation"><div class="s-mock-title"><span class="s-mock-pill">Disk almost full on the media box</span></div>` +
    (strip || "") +
    `<div class="s-mock-messages" aria-hidden="true"><div class="s-mock-line" style="width:72%"></div><div class="s-mock-line" style="width:54%"></div><div class="s-mock-line" style="width:63%"></div></div></div>` +
    (foot ? `<div class="s-mock-foot">${foot}</div>` : "") +
    `</div>`;

  const gatewayRows = () =>
    `<ul class="s-rows" aria-label="Gateway">` +
    `<li><span class="s-row-text"><span class="s-row-title">Reached through</span><span class="s-row-sub">you@devbox.example over SSH · In use</span></span></li>` +
    `<li><span class="s-row-text"><span class="s-row-title">Private access with Tailscale</span><span class="s-row-sub">Set up private access on the gateway using OpenClaw's Tailscale instructions</span></span>` +
    `<a class="button" data-size="sm" href="https://docs.openclaw.ai/gateway/tailscale" target="_blank" rel="noreferrer noopener">OpenClaw's Tailscale instructions</a></li>` +
    `<li><span class="s-row-text"><span class="s-row-title">Connect a phone</span><span class="s-row-sub">Not in this version</span></span>` +
    `<a class="button" data-size="sm" href="${go("phone")}">Connect a phone</a></li>` +
    `<li><button type="button" class="button" data-variant="quiet" data-size="sm" data-host="removeRoute">Remove this gateway…</button></li>` +
    `</ul>`;

  const settings = (body) => mockApp() + dialog("settings-lite", "Gateway · devbox", body, "", "first");

  const OVER = {
    approve: () => mockApp("", `<div data-approval></div>`),
    "approve-here": () => mockApp("", `<div data-approval></div>`),
    "approve-address": () => mockApp("", `<div data-approval></div>`),
    restoring: () =>
      mockApp(
        `<div class="status-strip" data-tone="warn" role="status" data-s-title tabindex="-1"><span class="status-dot"></span>` +
          `<span class="status-strip-text"><b>Restoring the connection to devbox</b><span>· showing saved messages</span></span><button type="button">Retry now</button></div>`,
      ),
    "route-changed": () =>
      mockApp(
        `<div class="status-strip" data-tone="danger" role="status" data-s-title tabindex="-1"><span class="status-dot"></span>` +
          `<span class="status-strip-text"><b>This address now leads to a different gateway</b><span>· disconnected</span></span><a class="s-strip-link" href="${go("there")}">Review</a></div>`,
      ),
    phone: () =>
      mockApp() +
      dialog(
        "",
        "Connect a phone",
        note("", "Clawtrate doesn't make codes for phones yet.", "") +
          `<p class="s-hint" style="text-align:left">A phone needs an encrypted address it can reach. Set one up with OpenClaw's network-exposure instructions.</p>` +
          `<p class="s-links"><a class="button" data-size="sm" href="https://docs.openclaw.ai/gateway/security/network-exposure" target="_blank" rel="noreferrer noopener">OpenClaw's network-exposure instructions</a></p>` +
          `<p class="s-hint" style="text-align:left">On the iPhone, scan or paste a setup code, then approve the phone on the gateway's computer. A setup code stays valid until it is used or expires, even after you close where it was shown.</p>`,
        "",
        "settings",
      ),
    settings: () => settings(gatewayRows()),
  };

  // The desktop's pasted code and the iPhone's screens, in the column. -------------

  const addrRaw = params.get("addr") || "gateway.example";
  const addr = esc(addrRaw);
  const futureLabel = `<p class="s-future" role="note">Future example: this state needs a step that isn't proven yet.</p>`;

  Object.assign(SCREENS, {
    code: () =>
      back("first") +
      mark() +
      title("Use a setup code") +
      `<label class="field"><span class="s-field-label">Setup code</span>` +
      `<textarea class="s-code-field" id="setup-code" spellcheck="false" placeholder="Paste a setup code"></textarea></label>` +
      `<p class="s-hint" id="code-where" role="status"></p>` +
      actions(`<a class="button" data-variant="primary" data-size="lg" id="code-connect" aria-disabled="true">Connect</a>`) +
      `<p class="s-proto-hint">Prototype: paste a sample code to see it read. <button type="button" class="button" data-size="sm" data-sample-code>Paste a sample code</button></p>`,

    "code-pairing": () =>
      back("code") +
      mark() +
      title("Approve this device") +
      lede(`${addr} has not seen this device before. Ask the gateway's owner to approve it; Clawtrate then connects by itself.`) +
      `<p class="s-hint">Run this on the gateway's computer, with <code>--profile &lt;name&gt;</code> if the gateway doesn't use the default profile.</p>` +
      command(`openclaw devices approve ${REQUEST}`, "Copy approve command") +
      `<p class="waiting" role="status"><span class="status-dot" data-status="connecting"></span>Waiting for approval, checking again in 4s</p>` +
      `<ul class="scopes"><li>${icon("read")}Read bots, tasks and conversations</li></ul>` +
      `<p class="connect-foot">Request e5eb4aa8 · connecting to ${addr}</p>`,

    iphone: () =>
      brand() +
      `<h2 class="s-title s-question" tabindex="-1" data-s-title>Connect to your OpenClaw</h2>` +
      actions(button("Scan a setup code", { variant: "primary", to: "iphone-review" }), button("Paste a setup code", { to: "iphone-review" })) +
      hint("Get a setup code from the gateway's owner, made on the gateway's computer.") +
      `<p class="s-links"><a class="button" data-variant="quiet" data-size="sm" href="connect.html?width=phone">Advanced</a></p>`,

    "iphone-review": () =>
      back("iphone") +
      mark() +
      title("Connect to devbox?") +
      `<p class="s-where">This code leads to devbox.tailnet.example, over an encrypted connection.</p>` +
      `<p class="s-expiry">Expires at 20:41 (in 9 minutes)</p>` +
      actions(button("Connect", { variant: "primary", to: "iphone-waiting" }), button("Cancel", { to: "iphone" })),

    "iphone-waiting": () =>
      back("iphone-review") +
      mark() +
      title("Waiting for approval") +
      `<p class="s-where">Connecting to devbox.tailnet.example</p>` +
      lede("Ask the gateway's owner to approve this iPhone. Its device code is:") +
      deviceCode(PHONE_DEVICE, "This iPhone's device code") +
      `<p class="s-hint">On the gateway's computer, with <code>--profile &lt;name&gt;</code> if the gateway doesn't use the default profile:</p>` +
      command(`openclaw devices approve ${PHONE_REQUEST}`, "Copy approve command") +
      `<p class="waiting" role="status"><span class="status-dot" data-status="connecting"></span>Waiting for approval, checking again in 4s</p>`,

    // A first pairing on a gateway that asks before every device (section 7):
    // the pairing screen, with the same approval panel as the access bar.
    "approve-pairing": () => back("found-there") + mark() + title("Approve this device") + `<div data-approval></div>`,

    "iphone-done": () =>
      futureLabel +
      mark() +
      title("Connected, read-only") +
      lede("Clawtrate on this iPhone can read your bots, tasks and conversations. Sending or changing anything is asked for later."),
  });

  // Render ------------------------------------------------------------------------

  const root = document.getElementById("setup-root");
  const card = document.getElementById("setup-card");
  const known = { ...SCREENS, ...OVER };
  const id = known[screen] ? screen : "first";
  root.dataset.screen = id;

  // The iPhone's screens are shown at phone width unless the address says otherwise.
  if (id.startsWith("iphone") && !params.get("width")) {
    CT.settings.width = "phone";
    document.documentElement.dataset.width = "phone";
    document.documentElement.dataset.input = "touch";
  }

  if (OVER[id]) {
    root.innerHTML = OVER[id]();
    root.classList.add("s-over");
  } else {
    card.innerHTML = SCREENS[id]();
  }

  // The host's dialog, opened from a button with data-host (or ?host= for a picture).
  const openHost = (op, opener) => {
    if (!HOST[op]) return;
    document.querySelector("[data-host-scrim]")?.remove();
    const app = document.getElementById("root");
    app.insertAdjacentHTML("beforeend", hostDialog(op));
    for (const el of app.children) if (!el.hasAttribute("data-host-scrim")) el.inert = true;
    const scrim = app.querySelector("[data-host-scrim]");
    CT.hydrate(scrim);
    const confirm = scrim.querySelector("[data-host-confirm]");
    const check = scrim.querySelector("[data-host-check]");
    if (check && confirm.hasAttribute("aria-disabled")) {
      check.addEventListener("change", () => {
        if (check.checked) confirm.removeAttribute("aria-disabled");
        else confirm.setAttribute("aria-disabled", "true");
      });
    }
    confirm.addEventListener("click", (event) => {
      if (confirm.getAttribute("aria-disabled") === "true") return event.preventDefault();
      if (HOST[op].onConfirm) {
        close();
        HOST[op].onConfirm();
      }
    });
    const close = () => {
      scrim.remove();
      for (const el of app.children) el.inert = false;
      (opener || root.querySelector("[data-s-title]"))?.focus();
    };
    scrim.querySelector("[data-host-cancel]").addEventListener("click", close);
    scrim.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
      if (event.key === "Tab") {
        // Focus stays inside the dialog.
        // The title, focused on open, counts as the start.
        const items = [...scrim.querySelectorAll("button, a[href], input")];
        const first = items[0];
        const last = items[items.length - 1];
        const atStart = document.activeElement === first || document.activeElement?.id === "s-host-title";
        if (event.shiftKey && atStart) (event.preventDefault(), last.focus());
        else if (!event.shiftKey && document.activeElement === last) (event.preventDefault(), first.focus());
      }
    });
    scrim.querySelector("#s-host-title").focus();
  };
  root.addEventListener("click", (event) => {
    const opener = event.target.closest("[data-host]");
    if (opener && !opener.disabled) openHost(opener.dataset.host, opener);
  });

  CT.hydrate(root);

  // Focus and announce the screen's title, as the design says.
  const heading = root.querySelector("[data-s-title]");
  const live = document.getElementById("setup-live");
  if (heading) {
    if (params.get("focus") !== "0") heading.focus({ preventScroll: true });
    live.textContent = heading.textContent;
  }
  // The approval controller (setup.md section 9) --------------------------------
  // Renders the waiting state, the read-back after an approval and its
  // outcome, in the page. What a host would do is counted in CT.approvalLog, so
  // the checks can assert that nothing was approved, saved or removed when it
  // shouldn't be. Fixtures, chosen in the address and never by a click:
  //   result=     the read-back after the owner's own approval: exact (default),
  //               other, unread, gone, already, rejected, mismatch, identity,
  //               different, listfail (with code=<n> when an exit code was recorded)
  //   hostresult= the exact path's outcome, with exact=1: granted (default),
  //               changed, refused, refused-granted, uncertain, readback
  const panel = root.querySelector("[data-approval]");
  if (panel) {
    const where = approveRoute === "here" ? "this computer" : approveRoute === "ssh" ? host : null;
    const exactPath = params.get("exact") === "1" && approveRoute !== "address";
    const log = (CT.approvalLog = { approveCalls: 0, tokenSaved: false, removeCalls: 0, listReads: 0 });
    const state = { phase: "waiting", outcome: null };
    const live = document.getElementById("setup-live");
    const act = (label, action, variant = "") =>
      `<button type="button" class="button"${variant ? ` data-variant="${variant}"` : ""} data-size="sm" data-act="${action}">${label}</button>`;
    const asked = `<ul class="scopes" aria-label="Asked for">${ADDED[approveFlow].map((x) => `<li>${icon(approveFlow === "pairing" ? "read" : "check")}${x.replace(/\.$/, "")}</li>`).join("")}</ul>`;
    const commandBlock = () =>
      `<p class="s-hint s-left" data-where>` +
      (approveRoute === "address"
        ? "Run this on the gateway's computer, with <code>--profile &lt;name&gt;</code> if the gateway doesn't use the default profile:"
        : approveRoute === "here"
          ? "In Terminal on this computer, run this for Clawtrate's profile:"
          : `On ${host}, run this for the default profile:`) +
      `</p>` +
      command(approveCommand(), "Copy approve command");
    const granted = () =>
      approveFlow === "pairing"
        ? "<b>Paired, read-only.</b> Clawtrate can read your bots, tasks and conversations."
        : approveFlow === "admin"
          ? "<b>Admin access granted.</b> You can change this now."
          : "<b>Access granted</b> · you can send, stop and answer";
    // The read-back after an approval: what Clawtrate keeps (section 9).
    const OUTCOMES = {
      exact: { text: granted(), granted: true },
      already: { text: `The gateway now shows the requested access. ${granted()}`, granted: true },
      other: { tone: "danger", text: "<b>Clawtrate disconnected.</b> It couldn't confirm what this request granted. Review this device's access on the gateway before reconnecting.", actions: () => lookAgain() },
      unread: { tone: "danger", text: "<b>Clawtrate disconnected.</b> It couldn't confirm what this request granted. Review this device's access on the gateway before reconnecting.", actions: () => lookAgain() },
      gone: { text: "Clawtrate couldn't find this request in the gateway's pending list.", actions: () => act("Check again", "check") + act("Request again", "request") },
      rejected: { text: "<b>The request was denied.</b> Nothing changed. This device keeps the access it had.", actions: () => act("Request again", "request") },
      mismatch: { text: "The gateway's pending request for this device isn't the one Clawtrate asked for.", actions: () => act("Request again", "request") },
      identity: { text: "Clawtrate couldn't confirm this gateway's identity or version.", actions: () => lookAgain() },
      different: { tone: "danger", text: "This route now leads to a different gateway.", actions: () => `<a class="button" data-size="sm" href="${go("there")}">Review</a>` },
      listfail: { text: `Couldn't read the gateway's requests on ${where || "the gateway's computer"}.${params.get("code") ? ` OpenClaw exited with code ${esc(params.get("code"))}.` : ""}`, actions: () => act("Check again", "check") },
      // The exact path's own outcomes.
      changed: { text: "This changed since you looked. Look again.", actions: () => act("Look again", "request") },
      refused: { text: "Clawtrate did not approve this request.", actions: () => act("Request again", "request") },
      "refused-granted": { text: `Clawtrate did not approve this request. The gateway now shows the requested access. ${granted()}`, granted: true },
      uncertain: { text: `Couldn't confirm approval on ${where}. The outcome isn't known yet.`, actions: () => act("Check again", "recheck") },
    };
    const lookAgain = () => `<a class="button" data-size="sm" href="${go(approveRoute === "here" ? "found" : "found-there")}">Look again</a>`;
    const render = () => {
      let html = "";
      if (state.phase === "waiting") {
        const lead = approveRoute === "address" ? "Waiting for approval." : `Waiting for approval on ${where}.`;
        html =
          `<div class="access-row">${icon("clock")}<span class="shelf-text" data-approval-lead><b>${lead}</b></span></div>` +
          (exactPath
            ? `<p class="s-future" role="note">Future example: this needs an exact approval path that OpenClaw 2026.10.6 doesn't offer.</p>` +
              `<div class="access-row s-approve-row"><button type="button" class="button" data-variant="primary" data-size="sm" data-host="approveRequest">Approve from here…</button></div>`
            : "") +
          commandBlock() +
          (approveFlow === "pairing" ? asked : "") +
          `<div class="access-row"><span class="access-id">Request e5eb4aa8<span class="access-wait">checking again in 4s</span></span><span class="spacer"></span>` +
          act("Check now", "check", "quiet") +
          act("Stop waiting", "stop", "quiet") +
          `</div>` +
          `<div class="s-proto-event"><span>Prototype, not product:</span> <button type="button" class="button" data-size="sm" data-act="owner">The owner approves on ${where || "the gateway's computer"}</button></div>`;
      } else if (state.phase === "checking") {
        html = `<div class="access-row">${icon("clock")}<span class="shelf-text" aria-busy="true" data-approval-busy>${state.busy}</span></div>`;
      } else if (state.phase === "stopped") {
        html = `<div class="access-row">${icon("clock")}<span class="shelf-text">Stopped waiting. The request may still be pending on the gateway.</span></div><div class="access-row s-approve-row">${act("Check again", "check")}</div>`;
      } else {
        const o = OUTCOMES[state.outcome];
        html = `<div class="access-row">${icon(o.tone === "danger" ? "warning" : o.granted ? "check" : "clock")}<span class="shelf-text">${o.text}</span></div>` + (o.actions ? `<div class="access-row s-approve-row">${o.actions()}</div>` : "");
        if (o.granted && approveFlow !== "pairing") html += `<div class="s-mock-composer" aria-label="Message Otto">Message Otto</div>`;
      }
      const tone = state.phase === "outcome" && OUTCOMES[state.outcome].tone;
      panel.innerHTML = `<div class="access-bar s-approval" data-phase="${state.phase}"${state.outcome ? ` data-outcome="${state.outcome}"` : ""}${tone ? ` data-tone="${tone}"` : ""} role="status" data-s-title tabindex="-1">${html}</div>`;
      CT.hydrate(panel);
    };
    const settle = (outcome) => {
      state.phase = "outcome";
      state.outcome = outcome;
      if (OUTCOMES[outcome].granted) log.tokenSaved = true;
      render();
      live.textContent = panel.textContent.trim().split(/(?<=\.) /)[0];
    };
    const busy = (text, then, ms = 500) => {
      state.phase = "checking";
      state.busy = text;
      render();
      setTimeout(then, ms);
    };
    // The owner approved by the command: read the record, reconnect, then decide.
    const afterOwner = () => {
      log.listReads += 1;
      busy(`Checking what this request granted on ${where || "the gateway"}…`, () => settle(OUTCOMES[params.get("result")] ? params.get("result") : "exact"));
    };
    CT.approval = {
      state,
      // The exact path: list again, approve once, read back.
      confirm: () => {
        log.listReads += 1;
        const r = params.get("hostresult") || "granted";
        if (r === "changed") return settle("changed");
        log.approveCalls += 1;
        busy(`Approving on ${where}…`, () =>
          busy("Checking what the gateway granted…", () => {
            if (r === "granted") return settle("exact");
            if (r === "readback") return settle("other");
            settle(r);
          }),
        );
      },
    };
    panel.addEventListener("click", (event) => {
      const a = event.target.closest("[data-act]")?.dataset.act;
      if (!a) return;
      if (a === "owner") afterOwner();
      if (a === "stop") ((state.phase = "stopped"), render());
      // Requests and checks read again; they never reissue an approval.
      if (a === "request" || a === "check") ((log.listReads += 1), (state.phase = "waiting"), (state.outcome = null), render());
      if (a === "recheck") ((log.listReads += 1), busy(`Checking on ${where}…`, () => settle("gone")));
    });
    render();
    const heading = root.querySelector("[data-s-title]");
    if (heading && params.get("focus") !== "0") heading.focus({ preventScroll: true });
    if (heading) live.textContent = heading.textContent;
  }
  if (params.get("host")) openHost(params.get("host"));

  // A wait reached through the flow plays on to what it leads to; reached from
  // the address it holds, so every state can be looked at.
  const NEXT = {
    "looking-here": params.get("next") || "found",
    "looking-there": params.get("next") || "found-there",
    "connecting-here": "app",
    "connecting-there": "app",
    installing: "found",
  };
  if (params.get("play") === "1" && id in NEXT) {
    setTimeout(() => {
      const to = NEXT[id];
      location.href = to === "app" ? "app.html?state=readonly" : go(to, { name: typedRaw });
    }, 2400);
  }

  // The SSH field: a value that is not an SSH destination is refused before
  // anything runs (setup.md section 19). The samples choose the walk. After a
  // failure, Try again submits the field as it stands now.
  const form = document.getElementById("ssh-form");
  if (form) {
    const DESTINATION = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,63}@)?[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const input = document.getElementById("ssh-host");
      const value = input.value.trim();
      form.querySelector(".s-field-error")?.remove();
      if (!DESTINATION.test(value)) {
        input.insertAdjacentHTML("afterend", `<p class="s-field-error" id="ssh-error" role="alert">That isn't an SSH host or alias Clawtrate can use.</p>`);
        input.setAttribute("aria-describedby", "ssh-error");
        return input.focus();
      }
      // The host confirms the account before anything runs there; the
      // prototype's sample names choose the walk.
      if (value.split("@").pop().split(".")[0] === "jumpbox") location.href = go("there-config", { name: value });
      else location.href = go("there", { name: value, keep: value, host: "sshAccount" });
    });
  }

  // A pasted setup code is read in the host (here, in the page), never sent
  // anywhere before Connect, and its token is never shown.
  const codeField = document.getElementById("setup-code");
  if (codeField) {
    const where = document.getElementById("code-where");
    const connect = document.getElementById("code-connect");
    const allow = (ok) => {
      if (ok) {
        connect.removeAttribute("aria-disabled");
        connect.href = go("code-pairing", { addr: connect.dataset.addr || "" });
      } else {
        connect.setAttribute("aria-disabled", "true");
        connect.removeAttribute("href");
      }
    };
    // Section 13: a well-formed code, a wss:// address the host can verify,
    // no credentials, query, fragment or path, not loopback, not expired.
    const LOOPBACK = (h) => h === "localhost" || h.endsWith(".localhost") || /^127\./.test(h) || h === "[::1]" || h === "::1" || h === "0.0.0.0";
    const read = () => {
      const text = codeField.value.trim();
      if (!text) return ((where.textContent = ""), allow(false));
      let json;
      try {
        if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error("shape");
        json = JSON.parse(atob(text.replace(/-/g, "+").replace(/_/g, "/")));
        if (!json || typeof json.url !== "string" || typeof json.bootstrapToken !== "string" || !json.bootstrapToken || typeof json.expiresAtMs !== "number") throw new Error("shape");
      } catch {
        where.textContent = "That isn't a setup code Clawtrate can use.";
        return allow(false);
      }
      let url;
      try {
        url = new URL(json.url);
      } catch {
        where.textContent = "That isn't a setup code Clawtrate can use.";
        return allow(false);
      }
      if (url.protocol !== "wss:" || url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== "/") || LOOPBACK(url.hostname)) {
        where.textContent = "That address can't be used safely. Clawtrate needs an encrypted address that isn't this computer's own.";
        return allow(false);
      }
      if (json.expiresAtMs <= Date.now()) {
        where.textContent = "This code has expired. Make a new one on the gateway's computer.";
        return allow(false);
      }
      where.textContent = `Connects to ${url.hostname}, over an encrypted connection. Expires at 20:41.`;
      connect.dataset.addr = url.hostname;
      allow(true);
    };
    codeField.addEventListener("input", read);
    root.querySelector("[data-sample-code]")?.addEventListener("click", () => {
      codeField.value = btoa(JSON.stringify({ url: "wss://gateway.example", bootstrapToken: "sample", expiresAtMs: FAR_FUTURE }))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      read();
    });
    connect.addEventListener("click", (event) => {
      if (connect.getAttribute("aria-disabled") === "true") event.preventDefault();
    });
  }


  // Radio rows: choosing one enables what waits for it.
  root.querySelectorAll("[data-radio]").forEach((row, _i, rows) =>
    row.addEventListener("click", () => rows.forEach((other) => other.setAttribute("aria-checked", String(other === row)))),
  );

  // The first screen's choice list: Up and Down move, Home and End go to the ends.
  root.querySelector("[data-choice-list]")?.addEventListener("keydown", (event) => {
    const rows = [...root.querySelectorAll("[data-choice]")];
    const at = rows.indexOf(document.activeElement);
    if (at < 0) return;
    const to = { ArrowDown: Math.min(at + 1, rows.length - 1), ArrowUp: Math.max(at - 1, 0), Home: 0, End: rows.length - 1 }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    rows[to].focus();
  });

  // Copy says what happened, as on the pairing screen.
  root.addEventListener("click", async (event) => {
    const copy = event.target.closest("[data-copy]");
    if (!copy) return;
    const status = copy.closest(".command")?.nextElementSibling;
    try {
      await navigator.clipboard.writeText(copy.dataset.copy);
      if (status) status.textContent = "Copied.";
    } catch {
      const code = copy.parentElement.querySelector("code");
      const range = document.createRange();
      range.selectNodeContents(code);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      if (status) status.textContent = `Selected. Press ${/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘C" : "Ctrl+C"} to copy.`;
    }
  });

  // Escape is Back on a step screen, and Close in a page dialog.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || document.querySelector("[data-host-scrim]")) return;
    const target = root.querySelector(".b-close") || root.querySelector("[data-back]");
    if (target?.href) location.href = target.href;
  });

  // The prototype bar: every state, one choice away.
  document.addEventListener("DOMContentLoaded", () => {
    const extra = document.getElementById("proto-extra");
    if (!extra) return;
    extra.innerHTML =
      `<label class="proto-seg">State <select id="setup-state" aria-label="Setup state">` +
      Object.keys(known).map((key) => `<option value="${key}"${key === id ? " selected" : ""}>${key}</option>`).join("") +
      `</select></label>`;
    document.getElementById("setup-state").addEventListener("change", (event) => (location.href = go(event.target.value)));
  });

  CT.setupScreens = Object.keys(known);
  CT.setupHostDialogs = Object.keys(HOST);
})();
