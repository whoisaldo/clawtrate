// Behaviour for remote.html: every state of docs/design/remote-access.md,
// chosen with ?screen=<id> (SCREENS below). No program runs and nothing is
// contacted. Each action goes where the real one would lead, so every path
// can be walked to its outcome by clicking; a wait reached by a click plays
// on, and from the address it holds.
//
// The host's confirmation is drawn as a stand-in (.s-host), as on setup.html.
// Events from outside the app (a phone using the code, the owner approving,
// the connector reporting) are links in a dashed "Prototype" box, not product.

(function () {
  const CT = window.CT;
  const params = CT.params;
  const icon = (name) => CT.icon(name);
  const esc = (text) =>
    String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  // Dark is this page's default theme, unless the address or the bar chose.
  let storedTheme = null;
  try {
    storedTheme = localStorage.getItem("ct-proto-theme");
  } catch {
    storedTheme = null;
  }
  if (!params.get("theme") && !storedTheme) {
    CT.settings.theme = "dark";
    document.documentElement.dataset.theme = "dark";
  }

  const TRANSIENT = ["play", "host", "changed", "differs", "fail", "both", "tailscale"];
  const go = (to, extra = {}) => {
    const next = new URLSearchParams(location.search);
    next.set("screen", to);
    for (const key of TRANSIENT) next.delete(key);
    for (const [key, value] of Object.entries(extra)) next.set(key, value);
    return `remote.html?${next}`;
  };

  // Samples, invented. The code decodes to the word "sample" in every field.
  const RELAY = "relay.example";
  const KEY_CODE = "7Q2F-KWLM";
  const DEVICE = "7C41-D2E0";
  const REQUEST = "7c41d2e0-9a3b-4f0e-8c55-2d6e1b0a9f34";
  const DEVICE_ID = "7c41d2e0b5a14f6e9d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e";
  const FAR_FUTURE = 4102444800000;
  const b64u = (text) => btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const SAMPLE_CODE = b64u(
    JSON.stringify({ v: 1, relay: "wss://relay.example", relayId: "sample", connectorKey: "sample", enroll: "sample", expiresAtMs: FAR_FUTURE, openclaw: "sample" }),
  );
  const START_MAC = "cp '~/.clawtrate-connector/service/dev.clawtrate.connector.plist' ~/Library/LaunchAgents/ && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.clawtrate.connector.plist";
  const STOP_MAC = "launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/dev.clawtrate.connector.plist";

  // Pieces, as on setup.html -------------------------------------------------------

  const logo = "../../../packages/ui/src/assets/logo-mark.png";
  const brand = () =>
    `<header class="connect-brand"><img src="${logo}" alt="" width="56" height="56" />` +
    `<h1>Clawtrate</h1><p>Your OpenClaw agents, orchestrated.</p></header>`;
  const mark = () => `<img class="s-mark" src="${logo}" alt="" width="44" height="44" />`;
  const back = (to) =>
    `<div class="s-top"><a class="button" data-variant="quiet" data-size="sm" href="${go(to)}" data-back>${icon("back")}Back</a></div>`;
  const title = (text) => `<h2 class="s-title" tabindex="-1" data-s-title>${text}</h2>`;
  const lede = (html) => `<p class="s-lede">${html}</p>`;
  const hint = (html) => `<p class="s-hint">${html}</p>`;
  const button = (label, { variant, to, size = "lg", host, extra = {}, attrs = "" } = {}) => {
    const base = `class="button"${variant ? ` data-variant="${variant}"` : ""} data-size="${size}"${attrs ? ` ${attrs}` : ""}`;
    if (host) return `<button type="button" ${base} data-host="${host}">${label}</button>`;
    if (to) return `<a ${base} href="${go(to, extra)}">${label}</a>`;
    return `<button type="button" ${base}>${label}</button>`;
  };
  const actions = (...buttons) => `<div class="s-actions">${buttons.join("")}</div>`;
  const note = (tone, lead, text, extra = "") =>
    `<div class="b-note"${tone ? ` data-tone="${tone}"` : ""} role="${tone === "danger" ? "alert" : "status"}">` +
    `${icon(tone ? "warning" : "clock")}<div><p>${lead ? `<b>${lead}</b>` : ""}${lead && text ? " " : ""}${text}</p>${extra}</div></div>`;
  const steps = (list) =>
    `<ol class="s-steps" aria-label="Steps">` +
    list
      .map(([text, state, sub]) => {
        const markIcon = state === "done" ? icon("check") : state === "failed" ? icon("x") : "";
        return (
          `<li data-state="${state}"${state === "running" ? ' aria-current="step"' : ""} aria-label="${esc(text)}, ${state}">` +
          `<span class="s-step-mark">${markIcon}</span><span>${text}</span><span class="s-step-time"></span>` +
          (sub ? `<span class="s-step-sub">${sub}</span>` : "") +
          `</li>`
        );
      })
      .join("") +
    `</ol>`;
  const sentenceFacts = (rows) => `<dl class="s-facts">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>`;
  const facts = (rows) => `<dl class="facts">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>`;
  const copyButton = (label, text) =>
    `<button type="button" class="icon-button copy" aria-label="${label}" data-copy="${esc(text)}">${icon("copy")}</button>`;
  const command = (text, label) =>
    `<div class="command"><code>${esc(text)}</code>${copyButton(label, text)}</div><p class="copy-status" aria-live="polite"></p>`;
  const deviceCode = (code, label) => `<p class="s-device" aria-label="${label}: ${code.split("").join(" ")}">${code}</p>`;
  const disclosure = (label, body) =>
    `<details class="b-disclosure s-disclosure"><summary>${label}</summary><div class="b-disclosure-body">${body}</div></details>`;
  const waiting = (text) => `<p class="waiting" role="status"><span class="status-dot" data-status="connecting"></span>${text}</p>`;
  const events = (...links) =>
    `<p class="s-proto-hint r-events" data-events><span>Prototype:</span>${links
      .map(([label, to, extra = {}]) => `<a href="${go(to, extra)}" data-simulate>${label}</a>`)
      .join("")}</p>`;
  const dialog = (kind, heading, body, foot, closeTo) =>
    `<div class="s-scrim"><div class="b-dialog" ${kind ? `data-kind="${kind}" ` : ""}role="dialog" aria-modal="true" aria-labelledby="s-dialog-title" open>` +
    `<header class="b-head"><h2 id="s-dialog-title" tabindex="-1" data-s-title>${heading}</h2>` +
    (closeTo ? `<a class="icon-button b-close" href="${go(closeTo)}" aria-label="Close">${icon("x")}</a>` : "") +
    `</header><div class="b-body">${body}</div>${foot ? `<div class="b-foot">${foot}</div>` : ""}</div></div>`;
  const mockApp = (strip, inner = "") =>
    `<div class="s-mock"><div class="conversation"><div class="s-mock-title"><span class="s-mock-pill">Disk almost full on the media box</span></div>` +
    (strip || "") +
    `<div class="s-mock-messages" aria-hidden="true"><div class="s-mock-line" style="width:72%"></div><div class="s-mock-line" style="width:54%"></div><div class="s-mock-line" style="width:63%"></div></div>${inner}</div></div>`;
  const strip = (tone, lead, sub, action) =>
    `<div class="status-strip" data-tone="${tone}" role="status" data-s-title tabindex="-1"><span class="status-dot"></span>` +
    `<span class="status-strip-text"><b>${lead}</b>${sub ? `<span>· ${sub}</span>` : ""}</span>${action || ""}</div>`;

  // A QR code's place: a stand-in pattern, labelled as one. Seeded, so the
  // screenshots don't change.
  const qr = () => {
    const n = 29;
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed / 2147483648);
    let cells = "";
    const finder = (x, y) => (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const v = rnd() > 0.52;
        if (finder(x, y)) continue;
        if (v) cells += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
      }
    const eye = (x, y) =>
      `<rect x="${x}" y="${y}" width="7" height="7"/><rect x="${x + 1}" y="${y + 1}" width="5" height="5" fill="#fff"/><rect x="${x + 2}" y="${y + 2}" width="3" height="3"/>`;
    return (
      `<div class="r-qr" role="img" aria-label="QR code of the code below"><svg viewBox="0 0 ${n} ${n}" fill="#111" shape-rendering="crispEdges" aria-hidden="true">` +
      cells + eye(0, 0) + eye(n - 7, 0) + eye(0, n - 7) +
      `</svg></div><p class="r-qr-label">Prototype: a stand-in pattern, not a code anything can scan.</p>`
    );
  };

  // The host's confirmations --------------------------------------------------------

  const HOST = {
    remoteOn: {
      message: "Turn on remote access for the default gateway on devbox?",
      detail: `<p>This uses the remote account's SSH login environment.</p><p>Clawtrate puts its connector on devbox, which connects to ${RELAY}, and adds 127.0.0.1 and ::1 to gateway.trustedProxies.</p>`,
      confirm: "Turn on",
      to: () => go("turning-on", { play: "1" }),
    },
    makeCode: {
      message: "Make a code for a phone to use devbox's gateway?",
      detail: "<p>Until a phone uses it, anyone who scans it can connect to this gateway. It works once, for up to 10 minutes.</p>",
      confirm: "Make the code",
      to: () => go(params.get("fail") === "code" ? "fail-code" : "code"),
    },
    approvePhone: {
      message: "Approve this iPhone read-only on the default gateway on devbox?",
      detail: `<p>Device code ${DEVICE}. It can read your bots, tasks and conversations, and ask for more later. Asking for more always waits for your approval.</p>`,
      confirm: "Approve",
      to: () => (params.get("changed") === "1" ? go("approve-changed") : go("approving", { play: "1" })),
    },
    removeDevice: {
      message: "Remove this device from devbox's gateway?",
      detail: `<p>Device code ${DEVICE}. It can't connect to the gateway any more until it is approved again.</p>`,
      confirm: "Remove",
      to: () => go("device-removed"),
    },
    removePhone: {
      message: "Remove iPhone from remote access on devbox?",
      detail: "<p>It can't reach the gateway through the relay any more. A session it has open ends within seconds.</p>",
      checkbox: `Also remove its device from devbox's gateway (${DEVICE})`,
      optional: true,
      confirm: "Remove",
      to: (both) => (params.get("fail") === "gateway" && both ? go("remove-partial") : go(both ? "removed-both" : "removed")),
    },
    remoteOff: {
      message: "Turn off remote access on devbox?",
      detail:
        "<p>Phones can't reach the gateway through the relay any more. Clawtrate stops the connector and puts the gateway's trusted proxies back to what they were before (none). The connector's keys and its list of phones stay on devbox, so turning it on again keeps them.</p>",
      confirm: "Turn off",
      to: () => go("stop-connector"),
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
      `<a class="button" data-variant="primary" data-size="sm" href="${d.to(false)}" data-host-confirm>${d.confirm}</a></div></div></div>`
    );
  };

  // Desktop: Settings, Gateway, and the dialogs over it ----------------------------------

  const row = (t, sub, extra = "") =>
    `<li><span class="s-row-text"><span class="s-row-title">${t}</span><span class="s-row-sub">${sub}</span></span>${extra}</li>`;
  const phones = (list) =>
    list.length
      ? `<ul class="r-phones" aria-label="Phones">` +
        list
          .map(
            ([name, date, code]) =>
              `<li><span class="r-phone-text"><span class="r-phone-name">${esc(name)}</span><span class="r-phone-sub">added ${date}${code ? ` · <span class="r-phone-code">${code}</span>` : ""}</span></span>` +
              `<button type="button" class="button" data-size="sm" data-host="removePhone">Remove…</button></li>`,
          )
          .join("") +
        `</ul>`
      : `<p class="r-row-facts">No phones yet.</p>`;
  const remoteRow = (state, phoneList = [["iPhone", "21 Nov", DEVICE]]) => {
    const head = (sub, tone) =>
      `<span class="r-row-head"><span class="s-row-text"><span class="s-row-title">Remote access</span><span class="s-row-sub"${tone ? ' data-tone="warn"' : ""}>${sub}</span></span></span>`;
    const proxies = `<p class="r-row-facts"><b>Trusted proxies</b> · Clawtrate added 127.0.0.1 and ::1 (there were none before)</p>`;
    const onActions = (...b) => `<div class="r-row-actions">${b.join("")}</div>`;
    const off = button("Turn off remote access…", { variant: "quiet", size: "sm", host: "remoteOff" });
    const body = {
      off: head("Off. Reach this gateway from your iPhone anywhere, through Clawtrate's relay.") + onActions(button("Connect a phone…", { size: "sm", to: "intro" })),
      address: head("Remote access is set up on the gateway's computer."),
      on: head(`On. The connector on devbox is connected to ${RELAY}.`) + proxies + `<p class="r-row-facts"><b>Phones</b></p>` + phones(phoneList) + onActions(button("Connect another phone…", { size: "sm", to: "make" }), off),
      waiting:
        head(`On. The connector on devbox can't reach ${RELAY} right now. Phones can't connect until it does.`, "warn") +
        proxies +
        onActions(button("Check now", { size: "sm" }), off),
      stopped:
        head("On, but the connector on devbox isn't running. Phones can't connect.", "warn") +
        disclosure("Start it", command(START_MAC, "Copy start command")) +
        onActions(button("Check now", { size: "sm" }), off),
      unreadable: head("Clawtrate couldn't read the connector's status on devbox.", "warn") + onActions(button("Look again", { size: "sm" })),
    }[state];
    return `<li class="r-row-block" data-remote-row="${state}">${body}</li>`;
  };
  const settings = (state, extra = "", reached = "you@devbox.example over SSH · In use", phoneList) =>
    mockApp() +
    dialog(
      "settings-lite",
      "Gateway · devbox",
      `<ul class="s-rows" aria-label="Gateway">` +
        row("Reached through", reached) +
        row(
          "Private access with Tailscale",
          "Set up private access on the gateway using OpenClaw's Tailscale instructions",
          `<a class="button" data-size="sm" href="https://docs.openclaw.ai/gateway/tailscale" target="_blank" rel="noreferrer noopener">OpenClaw's Tailscale instructions</a>`,
        ) +
        remoteRow(state, phoneList) +
        `</ul>` +
        extra,
      "",
      "",
    );
  const over = (heading, body, closeTo = "settings-off") => mockApp() + dialog("settings-lite", heading, body, "", closeTo);

  const turningOn = (states, sub2) =>
    steps([
      ["Putting Clawtrate's connector on devbox", states[0]],
      ["Adding this computer to trusted proxies", states[1], sub2],
      ["Starting the connector", states[2]],
      ["Reaching the relay", states[3]],
    ]);
  const ADDED = "Added 127.0.0.1 and ::1 (there were none)";
  const relaySees =
    "Clawtrate's relay passes the connection between your iPhone and the connector on your gateway's computer. It sees the addresses of both, when each connects and disconnects, how much each sends and when, and a random id for your connector. It can't read what they send: that is sealed with a key only your connector holds, and your iPhone checks that key against the code it scanned. The relay keeps your connector's id with its public key, so that no other computer can take the id, records of recent sign-ins for an hour, and counts per minute to limit abuse. It keeps nothing of what your phone and your gateway say to each other, and it can't let a phone into your gateway: your gateway decides that. Your phone's address is passed on to your gateway, which records it with the phone's device.";

  const failTurningOn = (failedAt, lead, text, acts, sub2) => {
    const states = ["done", "done", "done", "done"].map((s, i) => (i < failedAt ? "done" : i === failedAt ? "failed" : "waiting"));
    return over("Turning on remote access", turningOn(states, sub2) + note("danger", lead, text) + actions(...acts));
  };
  const codeFail = (lead, text) => over("Connect a phone", note("danger", lead, text) + actions(button("Back", { to: "make" })));
  const requestFacts = () =>
    facts([
      ["Asks for", "Read your bots, tasks and conversations"],
      ["Name", "iPhone"],
      ["Address the relay reported", "203.0.113.7"],
    ]);

  const DESKTOP = {
    "settings-off": () => settings("off"),
    "settings-address": () => settings("address", "", "gateway.example, an address · In use"),
    "settings-on": () => settings("on", events(["Connector: waiting", "settings-waiting"], ["Connector: stopped", "settings-stopped"], ["Status unreadable", "settings-unreadable"], ["Fail: gateway step", "settings-on", { fail: "gateway" }])),
    "settings-waiting": () => settings("waiting"),
    "settings-stopped": () => settings("stopped"),
    "settings-unreadable": () => settings("unreadable"),

    intro: () =>
      over(
        "Connect a phone",
        lede(`Your iPhone can reach this gateway from anywhere through Clawtrate's relay, ${RELAY}.`) +
          sentenceFacts([
            ["Relay", `${RELAY} passes the connection on and can't read it. It sees addresses, times and sizes.`],
            ["On devbox", "Clawtrate's connector, in its own folder. It connects to the relay and to the gateway on devbox only."],
            ["Gateway", "Clawtrate adds 127.0.0.1 and ::1 to the gateway's trusted proxies, so each phone that comes through the relay waits for your approval. Turning remote access off puts back what was there."],
            ["Phones", "Each phone uses a one-time code, then waits for you to approve it, read-only."],
          ]) +
          disclosure("What the relay sees and keeps", `<p class="s-hint" style="text-align:left">${relaySees}</p>`) +
          (params.get("tailscale") === "1"
            ? note(
                "warn",
                "A Tailscale route to this gateway that Clawtrate didn't make will start to work too.",
                "The gateway refuses it today because it adds forwarded headers. Once it trusts this computer's own addresses, it accepts it as a remote route, and new devices through it wait for approval.",
              )
            : "") +
          actions(button("Turn on remote access…", { variant: "primary", host: "remoteOn" }), button("Cancel", { to: "settings-off" })),
      ),
    "turning-on": () =>
      over("Turning on remote access", turningOn(["done", "running", "waiting", "waiting"]) + events(["Fail: connector", "fail-install"], ["Fail: gateway settings", "fail-settings"], ["Fail: trusted proxies", "fail-proxies"], ["Fail: read back", "fail-readback"], ["Fail: relay", "fail-relay"])),
    "start-connector": () =>
      over(
        "Start the connector on devbox",
        turningOn(["done", "done", "running", "waiting"], ADDED) +
          lede("Run this on devbox, in a terminal you trust. It keeps the connector running when you log in.") +
          command(START_MAC, "Copy start command") +
          waiting("Waiting for the connector, checking again in 4s") +
          actions(button("Check now", { size: "sm" })) +
          events(["The connector reaches the relay", "make"]),
      ),
    "fail-install": () => failTurningOn(0, "Putting Clawtrate's connector on devbox failed.", "Nothing was changed on the gateway.", [button("Try again", { variant: "primary", host: "remoteOn" })]),
    "fail-settings": () => failTurningOn(1, "Clawtrate couldn't read the gateway's settings.", "Nothing was changed on the gateway.", [button("Try again", { variant: "primary", host: "remoteOn" })]),
    "fail-proxies": () => failTurningOn(1, "The gateway's trusted proxies changed after Clawtrate set them.", "Clawtrate left them as they are. Check them on devbox.", [button("Look again", { variant: "primary" })]),
    "fail-readback": () =>
      failTurningOn(1, "The gateway's trusted proxies didn't read back as expected.", "Clawtrate didn't go on. The gateway reports: 127.0.0.1.", [button("Turn off remote access…", { host: "remoteOff" })]),
    "fail-relay": () =>
      over(
        "Turning on remote access",
        turningOn(["done", "done", "done", "failed"], ADDED) +
          note("danger", `The connector on devbox can't reach ${RELAY}.`, "Check that devbox can reach the internet. Clawtrate keeps checking.") +
          actions(button("Check now"), button("Turn off remote access…", { host: "remoteOff" })),
      ),

    make: () =>
      over(
        "Connect a phone",
        `<label class="field"><span class="s-field-label">Phone's name</span><input class="input" id="phone-name" type="text" value="iPhone" maxlength="64" autocomplete="off" spellcheck="false" /></label>` +
          actions(button("Make a code…", { variant: "primary", host: "makeCode" })) +
          events(["Fail: OpenClaw's code", "make", { fail: "code" }]),
        "settings-on",
      ),
    "fail-code": () => codeFail("Couldn't make a one-time code.", "OpenClaw exited with code 1."),
    "fail-too-many": () => codeFail("Too many codes are open.", "Wait until one is used or expires, at most 10 minutes."),
    "fail-phones": () => codeFail("This connector has 32 phones.", "Remove one in Settings first."),
    "fail-setupcode": () => codeFail("OpenClaw made a code Clawtrate can't use.", "Nothing was handed out."),
    code: () =>
      over(
        "Scan this with Clawtrate on your iPhone",
        qr() +
          `<p class="s-field-label">Or paste the code:</p>` +
          `<div class="command r-code"><code>${SAMPLE_CODE}</code>${copyButton("Copy the code", SAMPLE_CODE)}</div><p class="copy-status" aria-live="polite"></p>` +
          facts([
            ["Expires", "20:41 (in 9 minutes)"],
            ["Relay", RELAY],
            ["Connector key", KEY_CODE],
          ]) +
          hint("Your iPhone shows the same key before it connects.") +
          note("warn", "Show this code only to your iPhone.", "Until your iPhone uses it, anyone who scans it can connect to this gateway without your approval, posing as one of OpenClaw's own apps.") +
          waiting("Waiting for a phone to use this code, checking again in 4s") +
          actions(button("Done", { to: "settings-on" })) +
          hint("Closing this doesn't cancel the code. It works until 20:41 or until a phone uses it.") +
          events(["A phone uses the code", "code-used", { play: "1" }], ["A phone asks for more", "request-more"], ["A device is let in by the code", "let-in"], ["The code expires", "expired"]),
        "settings-on",
      ),
    "code-used": () => over("Connect a phone", waiting("The phone used the code. Waiting for its request, checking again in 4s"), "settings-on"),
    expired: () => over("Connect a phone", note("", "This code expired at 20:41.", "Nothing used it.") + actions(button("Make a new code…", { variant: "primary", to: "make" })), "settings-on"),

    request: () =>
      over(
        "Approve this iPhone?",
        lede("A phone used the code and asks the gateway to let it in.") +
          deviceCode(DEVICE, "The phone's device code") +
          hint("Compare it with the code on the iPhone.") +
          requestFacts() +
          actions(button("Approve from here…", { variant: "primary", host: "approvePhone" })) +
          disclosure("Or approve it on devbox yourself", command(`openclaw devices approve ${REQUEST}`, "Copy approve command")) +
          events(["The phone asks again", "request", { changed: "1" }]),
        "settings-on",
      ),
    approving: () =>
      over("Approve this iPhone?", steps([["Checking the request", "done"], ["Approving it on devbox", "running"], ["Reading it back", "waiting"]]), "settings-on"),
    approved: () =>
      over("Approve this iPhone?", steps([["Checking the request", "done"], ["Approving it on devbox", "done"], ["Reading it back", "done"]]) + note("", "Approved.", "devbox's gateway lists this iPhone with read access.") + actions(button("Done", { variant: "primary", to: "settings-on" })), "settings-on"),
    "approve-changed": () =>
      over("Approve this iPhone?", note("danger", "This request changed since you looked.", "Nothing was approved.") + requestFacts() + actions(button("Back", { to: "settings-on" })), "settings-on"),
    "approve-differs": () =>
      over(
        "Approve this iPhone?",
        note("danger", "The gateway approved something other than this request.", "It lists this iPhone with: Read, Approve pairing requests.") +
          actions(button("Remove it from the gateway…", { variant: "primary", host: "removeDevice" }), button("Keep it", { to: "settings-on" })),
        "settings-on",
      ),
    "approve-gone": () => over("Approve this iPhone?", note("danger", "This request is gone.", "The phone may have stopped asking, or someone answered it already.") + actions(button("Back", { to: "settings-on" })), "settings-on"),
    "approve-unread": () =>
      over("Approve this iPhone?", note("danger", "Clawtrate couldn't read the result.", "Look in the gateway's devices before you rely on it.") + actions(button("Look again", { variant: "primary" })), "settings-on"),
    "request-more": () =>
      over(
        "This phone asks for more than read",
        deviceCode(DEVICE, "The phone's device code") +
          facts([["Asks for", "Read, Talk"]]) +
          lede("Clawtrate approves only a request for read. Clawtrate on iPhone asks for read alone, so this may not be your iPhone.") +
          command(`openclaw devices reject ${REQUEST}`, "Copy reject command") +
          actions(button("Remove it from remote access…", { host: "removePhone" })),
        "settings-on",
      ),
    "let-in": () =>
      over(
        "Connect a phone",
        note("danger", "A device was let in by this code without your approval.", "devbox's gateway lists a new device that came through the relay and was approved by the code alone, as OpenClaw's own apps can be. If it isn't yours, remove it.") +
          deviceCode(DEVICE, "Its device code") +
          facts([
            ["Calls itself", "node-host"],
            ["Approved", "by the code"],
            ["Access", "node; Read, Talk"],
          ]) +
          actions(button("Remove it from the gateway…", { variant: "primary", host: "removeDevice" }), button("Remove it from remote access…", { host: "removePhone" })),
        "settings-on",
      ),
    "device-removed": () =>
      over("Remove this device", steps([["Removing it from devbox's gateway", "done"], ["Reading it back", "done"]]) + note("", "Removed from the gateway.", "devbox's gateway no longer lists it.") + actions(button("Done", { variant: "primary", to: "settings-on" })), "settings-on"),

    removed: () =>
      settings(
        "on",
        note("", "Removed from remote access.", "Its device is still on the gateway. To remove it there:", command(`openclaw devices remove ${DEVICE_ID}`, "Copy remove command")),
        undefined,
        [],
      ),
    "removed-both": () => settings("on", note("", "Removed from remote access. Removed from the gateway.", ""), undefined, []),
    "remove-partial": () =>
      settings(
        "on",
        note("danger", "Removed from remote access. Removing its device from the gateway failed (exit 1).", "The gateway still lists it.") + actions(button("Try again", { size: "sm", host: "removeDevice" })),
        undefined,
        [],
      ),
    "stop-connector": () =>
      over(
        "Turning off remote access",
        steps([["Stopping the connector", "running"], ["Putting back the trusted proxies", "waiting"]]) +
          lede("Run this on devbox, in a terminal you trust:") +
          command(STOP_MAC, "Copy stop command") +
          waiting("Waiting for the connector to stop, checking again in 4s") +
          events(["The connector stops", params.get("changed") === "1" ? "turn-off-changed" : "turned-off"], ["Still running after 2 minutes", "turn-off-running"], ["Someone changed the proxies", "stop-connector", { changed: "1" }]),
        "settings-on",
      ),
    "turned-off": () =>
      over(
        "Turning off remote access",
        steps([
          ["Stopping the connector", "done", "Connector stopped. It reports it isn't running."],
          ["Putting back the trusted proxies", "done", "Trusted proxies put back: none."],
        ]) + actions(button("Done", { variant: "primary", to: "settings-off" })),
      ),
    "turn-off-changed": () =>
      over(
        "Turning off remote access",
        steps([
          ["Stopping the connector", "done", "Connector stopped. It reports it isn't running."],
          ["Putting back the trusted proxies", "failed"],
        ]) +
          note("danger", "The gateway's trusted proxies changed after Clawtrate set them.", "Clawtrate left them as they are: 127.0.0.1, ::1, 198.51.100.0/24. Its record of the earlier value is kept.") +
          actions(button("Look again", { variant: "primary" })),
      ),
    "turn-off-running": () =>
      over(
        "Turning off remote access",
        steps([["Stopping the connector", "failed"], ["Putting back the trusted proxies", "waiting"]]) +
          note("danger", "The connector on devbox is still running.", "Run this on devbox to stop it. The trusted proxies stay as they are until it stops.") +
          command(STOP_MAC, "Copy stop command"),
        "settings-on",
      ),
  };

  // The iPhone ------------------------------------------------------------------------

  const firstScreen = () =>
    brand() +
    `<h2 class="s-title s-question" tabindex="-1" data-s-title>Connect to your OpenClaw</h2>` +
    actions(button("Scan a code", { variant: "primary", to: "iphone-review" }), button("Paste a code", { to: "iphone-paste" })) +
    hint("Get a code from Clawtrate on your computer: Settings, Gateway, Connect a phone. A setup code from the gateway's owner works too.") +
    `<p class="s-links"><a class="button" data-variant="quiet" data-size="sm" href="connect.html?width=phone">Advanced</a></p>`;
  const connectFail = (lead, text, primary) =>
    mark() + title(lead) + lede(text) + actions(primary, button("Back", { to: "iphone-review" }));
  const tryAgain = button("Try again", { variant: "primary", to: "iphone-connecting", extra: { play: "1" } });
  const scanAgain = button("Scan a code", { variant: "primary", to: "iphone" });
  const appStrip = (tone, lead, sub, action, inner = "") => mockApp(strip(tone, lead, sub, action), inner);

  const PHONE = {
    iphone: firstScreen,
    "iphone-paste": () =>
      back("iphone") +
      mark() +
      title("Paste a code") +
      `<label class="field"><span class="s-field-label">Code</span><textarea class="s-code-field" id="relay-code" spellcheck="false" placeholder="Paste a code"></textarea></label>` +
      `<p class="s-hint" id="code-line" role="status"></p>` +
      actions(`<a class="button" data-variant="primary" data-size="lg" id="code-next" aria-disabled="true">Continue</a>`) +
      `<p class="s-proto-hint">Prototype: <button type="button" class="button" data-size="sm" data-sample="good">Paste a good code</button> <button type="button" class="button" data-size="sm" data-sample="expired">Paste an expired code</button> <button type="button" class="button" data-size="sm" data-sample="malformed">Paste a malformed code</button> <button type="button" class="button" data-size="sm" data-sample="future">Paste a code whose time is wrong</button></p>`,
    "iphone-review": () =>
      back("iphone") +
      mark() +
      title("Connect through Clawtrate's relay?") +
      facts([
        ["Relay", RELAY],
        ["Computer's key", KEY_CODE],
        ["Expires", "20:41 (in 9 minutes)"],
      ]) +
      lede("Clawtrate on your computer shows the same key next to the code. The relay passes this connection on without being able to read it: only the computer holding this key can.") +
      actions(button("Connect", { variant: "primary", to: "iphone-connecting", extra: { play: "1" } }), button("Cancel", { to: "iphone" })),
    "iphone-connecting": () =>
      back("iphone-review") +
      mark() +
      title("Connecting") +
      steps([
        ["Reaching the relay", "done"],
        ["Checking the computer's key", "running"],
        ["Asking the gateway to let this iPhone in, read-only", "waiting"],
      ]) +
      events(["Code already used", "iphone-used"], ["Connector offline", "iphone-offline-first"], ["Relay unreachable", "iphone-unreachable-first"], ["Channel failed", "iphone-failed"], ["Token refused", "iphone-code-refused"]),
    "iphone-waiting": () =>
      back("iphone-review") +
      mark() +
      title("Waiting for approval") +
      lede("Approve this iPhone in Clawtrate on your computer. Its device code is:") +
      deviceCode(DEVICE, "This iPhone's device code") +
      disclosure(
        "Or on the gateway's computer",
        `<p class="s-hint">With <code>--profile &lt;name&gt;</code> if the gateway doesn't use the default profile:</p>` + command(`openclaw devices approve ${REQUEST}`, "Copy approve command"),
      ) +
      waiting("Waiting for approval, checking again in 4s") +
      events(["The owner approves", "iphone-done"]),
    "iphone-done": () =>
      mark() +
      title("Connected, read-only") +
      lede("Clawtrate on this iPhone can read your bots, tasks and conversations. Sending or changing anything is asked for later.") +
      actions(button("Open Clawtrate", { variant: "primary", to: "later-back" })) +
      events(["Relay unreachable", "later-unreachable"], ["Connector offline", "later-offline"], ["Removed", "later-removed"], ["Revoked", "later-revoked"]),
    "iphone-used": () => connectFail("This code was already used, or it expired.", "Make a new code in Clawtrate on your computer.", scanAgain),
    "iphone-offline-first": () => connectFail("The gateway's computer isn't connected to the relay.", "Check that Clawtrate's connector runs there, then try again.", tryAgain),
    "iphone-unreachable-first": () => connectFail(`Can't reach ${RELAY}.`, "Check this iPhone's connection, then try again.", tryAgain),
    "iphone-failed": () => connectFail("The connection to the gateway's computer failed.", "Try again. If it keeps failing, make a new code.", tryAgain),
    "iphone-code-refused": () => connectFail("The code didn't work.", "Make a new code in Clawtrate on your computer.", scanAgain),
  };
  const LATER = {
    "later-unreachable": () => appStrip("warn", `Can't reach ${RELAY}`, "showing saved messages", `<button type="button">Retry now</button>`, events(["Back", "later-back"])),
    "later-offline": () => appStrip("warn", "Connector offline", "the gateway's computer isn't connected to the relay", `<button type="button">Retry now</button>`, events(["Back", "later-back"])),
    "later-removed": () => appStrip("danger", "Removed from remote access", "", `<a class="s-strip-link" href="${go("iphone")}">Connect again</a>`),
    "later-revoked": () => appStrip("danger", "Not accepted by the gateway", "", `<a class="s-strip-link" href="${go("iphone")}">Connect again</a>`),
    "later-back": () => appStrip("ok", "Connected again", ""),
  };

  // Render ----------------------------------------------------------------------------

  const known = { ...DESKTOP, ...PHONE, ...LATER };
  const screen = params.get("screen") || "settings-off";
  const id = known[screen] ? screen : "settings-off";
  const root = document.getElementById("setup-root");
  const card = document.getElementById("setup-card");
  root.dataset.screen = id;
  const phoneScreen = id.startsWith("iphone") || id.startsWith("later");
  if (phoneScreen && !params.get("width")) {
    CT.settings.width = "phone";
    document.documentElement.dataset.width = "phone";
    document.documentElement.dataset.input = "touch";
  }
  if (PHONE[id]) card.innerHTML = PHONE[id]();
  else {
    root.innerHTML = known[id]();
    root.classList.add("s-over");
  }

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
    check?.addEventListener("change", () => (confirm.href = HOST[op].to(check.checked)));
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

  const heading = root.querySelector("[data-s-title]");
  const live = document.getElementById("setup-live");
  if (heading) {
    if (params.get("focus") !== "0") heading.focus({ preventScroll: true });
    live.textContent = heading.textContent;
  }
  if (params.get("host")) openHost(params.get("host"));

  // Waits reached through the flow play on; reached from the address they hold.
  const NEXT = {
    "turning-on": () => go("start-connector"),
    approving: () => go(params.get("differs") === "1" ? "approve-differs" : "approved"),
    "code-used": () => go("request"),
    "iphone-connecting": () => go("iphone-waiting"),
  };
  if (params.get("play") === "1" && id in NEXT) setTimeout(() => (location.href = NEXT[id]()), 1600);

  // Pasting a code: R4's parser, pictured. A good code goes on to the review.
  const field = document.getElementById("relay-code");
  if (field) {
    const line = document.getElementById("code-line");
    const next = document.getElementById("code-next");
    const allow = (ok) => {
      if (ok) {
        next.removeAttribute("aria-disabled");
        next.href = go("iphone-review");
      } else {
        next.setAttribute("aria-disabled", "true");
        next.removeAttribute("href");
      }
    };
    const read = () => {
      const text = field.value.trim();
      if (!text) return ((line.textContent = ""), allow(false));
      let json;
      try {
        json = JSON.parse(atob(text.replace(/-/g, "+").replace(/_/g, "/")));
        const keys = Object.keys(json).sort().join(",");
        if (keys !== "connectorKey,enroll,expiresAtMs,openclaw,relay,relayId,v" || json.v !== 1) throw new Error("shape");
      } catch {
        line.textContent = "That isn't a code Clawtrate can use.";
        return allow(false);
      }
      if (json.expiresAtMs <= Date.now()) {
        line.textContent = "This code has expired. Make a new one in Clawtrate on your computer.";
        return allow(false);
      }
      if (json.expiresAtMs - Date.now() > 60 * 60 * 1000 && json.expiresAtMs !== FAR_FUTURE) {
        line.textContent = "This code's time is wrong. Check the time on this iPhone, or make a new code.";
        return allow(false);
      }
      line.textContent = `A code for ${RELAY}.`;
      allow(true);
    };
    field.addEventListener("input", read);
    const SAMPLES = {
      good: SAMPLE_CODE,
      expired: b64u(JSON.stringify({ v: 1, relay: "wss://relay.example", relayId: "sample", connectorKey: "sample", enroll: "sample", expiresAtMs: 1000, openclaw: "sample" })),
      malformed: b64u(JSON.stringify({ url: "wss://gateway.example", token: "sample" })),
      future: b64u(JSON.stringify({ v: 1, relay: "wss://relay.example", relayId: "sample", connectorKey: "sample", enroll: "sample", expiresAtMs: 4102444800001, openclaw: "sample" })),
    };
    root.querySelectorAll("[data-sample]").forEach((b) =>
      b.addEventListener("click", () => {
        field.value = SAMPLES[b.dataset.sample];
        read();
      }),
    );
    next.addEventListener("click", (event) => {
      if (next.getAttribute("aria-disabled") === "true") event.preventDefault();
    });
  }

  // Copy says what happened, as on the pairing screen.
  root.addEventListener("click", async (event) => {
    const copy = event.target.closest("[data-copy]");
    if (!copy) return;
    const status = copy.closest(".command")?.nextElementSibling;
    try {
      await navigator.clipboard.writeText(copy.dataset.copy);
      if (status) status.textContent = "Copied.";
    } catch {
      if (status) status.textContent = `Selected. Press ${/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘C" : "Ctrl+C"} to copy.`;
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || document.querySelector("[data-host-scrim]")) return;
    const target = root.querySelector(".b-close") || root.querySelector("[data-back]");
    if (target?.href) location.href = target.href;
  });

  document.addEventListener("DOMContentLoaded", () => {
    const extra = document.getElementById("proto-extra");
    if (!extra) return;
    extra.innerHTML =
      `<label class="proto-seg">State <select id="remote-state" aria-label="Remote access state">` +
      Object.keys(known).map((key) => `<option value="${key}"${key === id ? " selected" : ""}>${key}</option>`).join("") +
      `</select></label>`;
    document.getElementById("remote-state").addEventListener("change", (event) => (location.href = go(event.target.value)));
  });

  CT.remoteScreens = Object.keys(known);
  CT.remoteHostDialogs = Object.keys(HOST);
})();
