// Checks for setup.html: every walk of docs/design/setup.md clicked through to
// its outcome, with each destination asserted; every state's words and
// structure; the host's confirmations; and the keyboard, phone and
// reduced-motion rules.
// Run from the repository root:  node docs/design/prototype/tools/checks/setup.mjs
import { chromium, pageUrl } from "./browser.mjs";

const base = pageUrl("setup.html") + "?chrome=0";
const b = await chromium.launch();
const out = [];
let failed = 0;
const check = (name, ok, extra = "") => {
  if (!ok) failed += 1;
  out.push(`${ok ? "ok  " : "FAIL"} ${name} ${extra}`);
};
const open = async (query, { width = 1440, height = 900, theme = "light" } = {}) => {
  const p = await b.newPage({ viewport: { width, height } });
  const errors = [];
  p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto(`${base}&theme=${theme}&${query}`);
  await p.waitForTimeout(100);
  p.errors = errors;
  return p;
};
const text = (p, sel = "#root") => p.evaluate((s) => document.querySelector(s)?.textContent.replace(/\s+/g, " ") || "", sel);
const missing = (t, words) => words.filter((w) => !t.includes(w)).join(" | ");
const screenOf = (p) => p.evaluate(() => new URLSearchParams(location.search).get("screen") || location.pathname.split("/").pop());
const at = async (p, screen, timeout = 6000) => {
  try {
    await p.waitForFunction(
      (s) => (s.endsWith(".html") ? location.pathname.endsWith(s.split("?")[0]) : new URLSearchParams(location.search).get("screen") === s),
      screen,
      { timeout },
    );
    return true;
  } catch {
    return false;
  }
};
const click = async (p, selector) => {
  await p.locator(selector).first().click();
  await p.waitForTimeout(80);
};
const hostConfirm = async (p) => {
  await p.waitForSelector("[data-host-dialog]");
  await click(p, "[data-host-confirm]");
};

process.on("uncaughtException", (e) => {
  console.log(out.join("\n"));
  console.log("THREW", e.message.split("\n")[0]);
  process.exit(1);
});

// Part 1: the walks, clicked through, each destination asserted ------------------------------
async function walk(name, start, stepsList, end) {
  const p = await open(`screen=${start}`);
  let ok = true;
  let where = start;
  for (const [action, expect] of stepsList) {
    await action(p);
    if (expect && !(await at(p, expect))) {
      ok = false;
      where = `${await screenOf(p)} (expected ${expect})`;
      break;
    }
    where = expect || where;
  }
  if (ok && end && !(await at(p, end, 7000))) {
    ok = false;
    where = `${await screenOf(p)} (expected ${end})`;
  }
  check(`walk: ${name}`, ok && p.errors.length === 0, ok ? "" : `stopped at ${where} ${p.errors.join(" | ")}`);
  await p.close();
}
const link = (name) => (p) => p.getByRole("link", { name, exact: true }).first().click();
const btn = (name) => (p) => p.getByRole("button", { name, exact: true }).first().click();
const typeHost = (host) => async (p) => {
  await p.fill("#ssh-host", host);
  await p.press("#ssh-host", "Enter");
};
const hostIs = (op) => async (p) => {
  await p.waitForSelector(`[data-host-dialog="${op}"]`, { timeout: 5000 });
};

await walk(
  "this computer, found: the host confirms the pairing, then the app read-only",
  "first",
  [
    [(p) => p.locator("[data-choice]").first().click(), "looking-here"],
    [() => {}, "found"],
    [btn("Connect"), null],
    [hostIs("pair"), null],
    [hostConfirm, "connecting-here"],
  ],
  "app.html",
);
await walk(
  "another computer, known key: the host confirms the account and the pairing, then the app",
  "there",
  [
    [typeHost("devbox"), null],
    [hostIs("sshAccount"), null],
    [hostConfirm, "looking-there"],
    [() => {}, "found-there"],
    [btn("Connect"), null],
    [hostIs("pairThere"), null],
    [hostConfirm, "connecting-there"],
  ],
  "app.html",
);
await walk(
  "another computer, first contact: account confirmed, key shown, trust confirmed, then found",
  "there",
  [
    [typeHost("newbox"), null],
    [hostIs("sshAccount"), null],
    [hostConfirm, "hostkey"],
    [btn("Trust this key…"), null],
    [hostIs("trustKey"), null],
    [hostConfirm, "looking-there"],
  ],
  "found-there",
);
await walk(
  "a changed key: replaced only through the host's dialog with its checkbox",
  "hostkey-changed",
  [
    [btn("Replace the trusted key…"), null],
    [async (p) => (await p.waitForSelector("[data-host-dialog]"), p.check("[data-host-check]")), null],
    [hostConfirm, "looking-there"],
  ],
);
await walk(
  "another computer, nothing there: no setup offered",
  "there",
  [
    [typeHost("emptybox"), null],
    [hostIs("sshAccount"), null],
    [hostConfirm, "looking-there"],
  ],
  "notfound-there",
);
await walk(
  "this computer, nothing there: set up here after the host's dialog, then what it found",
  "notfound",
  [
    [link("Set up OpenClaw here"), "install-confirm"],
    [btn("Set up OpenClaw…"), null],
    [hostIs("install"), null],
    [hostConfirm, "installing"],
  ],
  "found",
);
await walk("a failed install: Back to the not-found card", "install-failed", [[link("Back"), "notfound"]]);
await walk(
  "Windows, this computer: straight to Advanced or another computer",
  "first&os=windows",
  [
    [(p) => p.locator("[data-choice]").first().click(), "notfound-windows"],
    [link("Use another computer"), "there"],
  ],
);
await walk(
  "a pasted code: validated, then a first pairing naming the address",
  "code",
  [
    [btn("Paste a sample code"), null],
    [link("Connect"), "code-pairing"],
  ],
);
await walk(
  "the iPhone: review the address, then wait for approval",
  "iphone",
  [
    [link("Scan a code"), "iphone-review"],
    [link("Connect"), "iphone-waiting"],
  ],
);
await walk("advanced: the address-and-token form as built", "first", [[link("Advanced"), "connect.html"]]);

// Part 2: every state, its words ---------------------------------------------------------------
const WORDS = {
  first: ["Where does OpenClaw run?", "This computer", "Clawtrate looks for OpenClaw here.", "Another computer", "A computer you reach with SSH, such as a server or a desktop at home.", "Have a setup code?", "Advanced", "New to OpenClaw? Choose where it should run, and Clawtrate offers to set it up there."],
  "looking-here": ["Looking on this computer", "Finding OpenClaw", "Checking its version", "Asking the gateway"],
  found: ["On this computer", "OpenClaw is running", "2026.10.6", "Profile", "default", "On this computer only", "LaunchAgent, starts when you log in", "Connect", "Connect pairs this computer with the gateway as a device that can only read, and the gateway keeps it. Sending or changing anything is asked for later."],
  "connecting-here": ["Connecting", "Making a one-time code", "Pairing this computer, read-only", "Loading your bots"],
  stopped: ["OpenClaw is installed but not running", "LaunchAgent, stopped", "Nothing listening on 18789", "Start OpenClaw"],
  untested: ["OpenClaw 2026.9.37 isn't the version this Clawtrate is tested with (2026.10.6). Use Advanced to connect to it.", "Use Advanced", "How to update"],
  tooold: ["This OpenClaw is too old for Clawtrate", "OpenClaw 2026.6.2 speaks an older protocol than Clawtrate needs. Update it, then look again.", "Look again"],
  "setup-missing": ["OpenClaw seems to be set up here, but Clawtrate can't find its program", "Clawtrate looked in the usual places."],
  canttell: ["Clawtrate couldn't tell what is on this computer", "Asking the gateway didn't finish in time.", "Use Advanced", "Look again"],
  nottoken: ["This gateway uses another way to sign in", "Clawtrate connects by itself only to gateways that use a token. Use Advanced."],
  notfound: ["Clawtrate didn't find OpenClaw here", "Set up OpenClaw here", "It runs on another computer", "Clawtrate also saw another OpenClaw service here (OpenClaw Gateway (work)). It connects only to the default gateway and its own; use Advanced for others."],
  "notfound-windows": ["Use Advanced on Windows", "Clawtrate can't yet look for OpenClaw on Windows. It doesn't set OpenClaw up on Windows either: OpenClaw's Windows installer can change Node.js or PATH and installs OpenClaw globally.", "Use Advanced", "Use another computer", "OpenClaw's own install instructions"],
  there: ["Another computer", "SSH host or alias", "Clawtrate uses your SSH keys and the host's settings from your SSH configuration, and never asks for a password.", "Look there", "Have a setup code instead?", "Advanced"],
  "there-config": ["devbox is reached through another computer.", "Clawtrate doesn't connect through jump hosts yet. Use a setup code made on devbox, or Advanced.", "Use a setup code", "Advanced"],
  "looking-there": ["Looking on you@devbox.example", "Reaching devbox", "Finding OpenClaw"],
  unreachable: ["Can't reach you@devbox.example", "Nothing answered at devbox.example, port 22 (connection refused).", "Check the name and that the computer is on.", "Try again", "Advanced"],
  refused: ["you@devbox.example didn't accept your key", "The SSH sign-in for you@devbox.example was refused.", "Check that your key is on that computer. A key with a passphrase has to be in your SSH agent first.", "Advanced"],
  hostkey: ["Is this devbox?", "This is the first time Clawtrate connects to devbox. Its key is below. If you can, compare it with the key devbox itself shows before you trust it.", "ED25519", "SHA256:Q3v8Lw0e Xk2Rj9Ta Nf5Hc1Ub Ym7Pd4Gs Zi6Ko2Ea Vr8", "How to compare", "Trust this key…"],
  "hostkey-changed": ["devbox's key has changed", "This happens when a computer is reinstalled, and it is also what someone between you and devbox would cause. Clawtrate won't connect until you decide.", "Trusted", "Presented now", "Replace the trusted key…"],
  "found-there": ["On you@devbox.example", "OpenClaw is running", "On devbox only", "systemd user service, starts with your session", "Connect"],
  "connecting-there": ["Connecting to you@devbox.example", "Making a one-time code on devbox", "Opening a private connection to devbox", "Pairing this computer, read-only", "Loading your bots"],
  "notfound-there": ["On you@devbox.example", "Clawtrate didn't find OpenClaw here", "Setting OpenClaw up on another computer isn't offered in this version.", "Use a setup code", "Advanced"],
  "install-confirm": ["Set up OpenClaw on this computer", "OpenClaw 2026.10.6, the version this Clawtrate is tested with, with its own copy of Node.js 24.22.1", "Clawtrate puts OpenClaw's program and gateway data in its own folders and adds a user service. npm can also write its cache and OpenClaw can write service logs.", "Clawtrate checks the OpenClaw and Node.js downloads against fingerprints built into this version. Setup also installs code from npm that Clawtrate hasn't pinned or verified. That code can run with your account's permissions.", "as a LaunchAgent that starts when you log in", "Nothing is asked for: no account and no model key.", "Removing this gateway in Settings can also stop it; removing OpenClaw isn't offered in this version.", "Set up OpenClaw…"],
  installing: ["Setting up OpenClaw", "Download and check OpenClaw 2026.10.6", "Install Node.js and OpenClaw", "Node.js 24.22.1, checked", "Set up the gateway", "Start and check", "The times are samples."],
  "install-failed": ["Install Node.js and OpenClaw failed.", "The installer didn't use the checked Node.js.", "Show details", "Error", "Node.js check", "Exit status"],
  approve: ["Waiting for the gateway's owner.", "On devbox, approve this request for the default profile:", "openclaw devices approve e5eb4aa8-175f-40f1-bc7a-8f15cfc40942", "Request e5eb4aa8", "Check now", "Cancel request"],
  restoring: ["Restoring the connection to devbox", "· showing saved messages", "Retry now"],
  "route-changed": ["This address now leads to a different gateway", "Review"],
  settings: ["Gateway · devbox", "you@devbox.example over SSH · In use", "Private access with Tailscale", "Set up private access on the gateway using OpenClaw's Tailscale instructions", "OpenClaw's Tailscale instructions", "Remote access", "Connect a phone…", "Remove this gateway…"],
  code: ["Use a setup code", "Setup code"],
  "code-pairing": ["Approve this device", "gateway.example has not seen this device before.", "with --profile <name> if the gateway doesn't use the default profile", "openclaw devices approve", "Read bots, tasks and conversations", "connecting to gateway.example"],
  iphone: ["Connect to your OpenClaw", "Scan a code", "Paste a code", "Get a code from Clawtrate on your computer: Settings, Gateway, Connect a phone. A setup code from the gateway's owner works too.", "Advanced"],
  "iphone-review": ["Connect to devbox?", "This code leads to devbox.tailnet.example, over an encrypted connection.", "Expires at 20:41 (in 9 minutes)", "Connect", "Cancel"],
  "iphone-waiting": ["Waiting for approval", "Connecting to devbox.tailnet.example", "Ask the gateway's owner to approve this iPhone. Its device code is:", "7C41-D2E0", "with --profile <name> if the gateway doesn't use the default profile", "Waiting for approval, checking again in 4s"],
  "iphone-done": ["Future example: this state needs a step that isn't proven yet.", "Connected, read-only"],
};

let p = await open("screen=first");
const listed = await p.evaluate(() => window.CT.setupScreens);
const hostOps = await p.evaluate(() => window.CT.setupHostDialogs);
check("every state the page offers is checked", listed.every((s) => s in WORDS), listed.filter((s) => !(s in WORDS)).join(", "));
check("every state checked is offered by the page", Object.keys(WORDS).every((s) => listed.includes(s)), Object.keys(WORDS).filter((s) => !listed.includes(s)).join(", "));
await p.close();

for (const [screen, words] of Object.entries(WORDS)) {
  p = await open(`screen=${screen}`);
  const t = await text(p);
  check(`${screen}: its words`, !missing(t, words), missing(t, words));
  check(
    `${screen}: its title or status has focus and is announced`,
    await p.evaluate(() => {
      const h = document.querySelector("[data-s-title]");
      return Boolean(h) && document.activeElement === h && document.getElementById("setup-live").textContent === h.textContent;
    }),
  );
  check(`${screen}: no page errors`, p.errors.length === 0, p.errors.join(" | "));
  check(`${screen}: no field for a shared token`, !(await p.evaluate(() => document.querySelector('input[type="password"]'))));
  await p.close();
}

// Part 3: the host's confirmations ---------------------------------------------------------------
const HOST_WORDS = {
  sshAccount: ["Look for OpenClaw as you@devbox.example, port 22?", "This uses the remote account's SSH login environment."],
  trustKey: ["Trust devbox's key?", "Clawtrate will connect to devbox only while it presents this key."],
  replaceKey: ["Replace devbox's trusted key?", "I checked the new key on devbox itself"],
  pair: ["Pair this device read-only with the default gateway on this computer?", "The gateway saves this device."],
  pairThere: ["Pair this device read-only with the default gateway on you@devbox.example?", "The gateway saves this device."],
  start: ["Start OpenClaw on this computer?", "Starts the LaunchAgent ai.openclaw.gateway. It keeps running after Clawtrate closes."],
  install: ["Set up OpenClaw on this computer?", "Clawtrate checks the OpenClaw and Node.js downloads against fingerprints built into this version. Setup also installs code from npm that Clawtrate hasn't pinned or verified. That code can run with your account's permissions."],
  removeRoute: ["Remove devbox from Clawtrate?", "leaves OpenClaw on devbox running", "Also stop OpenClaw on devbox (Clawtrate started it)"],
};
check("every host dialog is checked", hostOps.every((op) => op in HOST_WORDS) && Object.keys(HOST_WORDS).every((op) => hostOps.includes(op)), hostOps.join(", "));
for (const [op, words] of Object.entries(HOST_WORDS)) {
  p = await open(`screen=first&host=${op}`);
  const t = await text(p, "[data-host-dialog]");
  check(`host dialog ${op}: its words`, !missing(t, words), missing(t, words));
  check(`host dialog ${op}: says it is the app's own dialog, not the page`, t.includes("The app's own dialog, not part of the page"));
  check(`host dialog ${op}: no setup code or count of packages in it`, !/345|setup code/.test(t));
  await p.close();
}

p = await open("screen=hostkey-changed");
await click(p, '[data-host="replaceKey"]');
check("replace key: the host's dialog can't be confirmed before its checkbox is ticked", await p.evaluate(() => document.querySelector("[data-host-confirm]").getAttribute("aria-disabled") === "true"));
// Playwright won't click an aria-disabled control, so the click is dispatched as a person's would be.
await p.evaluate(() => document.querySelector("[data-host-confirm]").click());
await p.waitForTimeout(150);
check("replace key: clicking the unticked confirm does nothing", (await screenOf(p)) === "hostkey-changed");
check("host dialog: everything behind it is inert", await p.evaluate(() => [...document.getElementById("root").children].filter((el) => !el.hasAttribute("data-host-scrim")).every((el) => el.inert)));
check("host dialog: its title has focus", await p.evaluate(() => document.activeElement?.id === "s-host-title"));
for (let i = 0; i < 6; i++) await p.keyboard.press("Tab");
check("host dialog: Tab stays inside it", await p.evaluate(() => Boolean(document.activeElement?.closest("[data-host-dialog]"))));
await p.evaluate(() => document.getElementById("s-host-title").focus());
await p.keyboard.press("Shift+Tab");
check("host dialog: Shift+Tab from its title stays inside it", await p.evaluate(() => Boolean(document.activeElement?.closest("[data-host-dialog]"))));
await p.keyboard.press("Escape");
check("host dialog: Escape closes it and returns focus to the button that opened it", await p.evaluate(() => !document.querySelector("[data-host-scrim]") && document.activeElement?.dataset.host === "replaceKey"));
await p.close();

// Part 4: what each state may and may not offer ---------------------------------------------------
const offers = async (query, label, fn) => {
  p = await open(query);
  check(label, await p.evaluate(fn));
  await p.close();
};
await offers("screen=found", "found: Connect asks the host; nothing pairs from the page", () => document.querySelector('[data-host="pair"]')?.textContent === "Connect" && !document.querySelector('a[href*="connecting"]'));
await offers("screen=found-there", "found over SSH: Connect asks the host", () => document.querySelector('[data-host="pairThere"]') !== null && !document.querySelector('a[href*="connecting"]'));
await offers("screen=connecting-here", "connecting here: says nothing about SSH or another computer", () => !/SSH|devbox|private connection/.test(document.getElementById("root").textContent));
await offers("screen=there", "there, first visit: no remembered computers", () => !document.querySelector(".s-remembered"));
await offers("screen=there&returning=1", "there, return visit: the remembered computer, by its full destination", () => document.querySelector(".s-remembered")?.textContent.includes("you@devbox.example"));
await offers("screen=hostkey-changed", "changed key: no way to trust it without the host's dialog", () => !document.querySelector('a[href*="found-there"]') && document.querySelector('[data-host="replaceKey"]') !== null);
await offers("screen=unreachable", "SSH refusal: Try again submits the field, and Advanced is a direct link", () => document.querySelector('#ssh-form button[type="submit"]')?.textContent === "Try again" && [...document.querySelectorAll("a")].some((a) => a.getAttribute("href") === "connect.html"));
await offers("screen=refused", "sign-in refused: a direct Advanced link", () => [...document.querySelectorAll("a")].some((a) => a.getAttribute("href") === "connect.html"));
await offers("screen=there-config", "a refused setting: a direct Advanced link", () => [...document.querySelectorAll("a")].some((a) => a.getAttribute("href") === "connect.html"));
await offers("screen=approve", "approve: no automatic approval, the profile named", () => !document.querySelector("[data-host]") && document.body.textContent.includes("for the default profile"));
await offers("screen=untested", "untested version: Advanced, and no Connect or code", () => [...document.querySelectorAll("a")].some((a) => a.getAttribute("href") === "connect.html") && !document.querySelector('[data-host="pair"]') && !document.querySelector('a[href*="connecting"]'));
await offers("screen=canttell", "can't tell: Advanced, and no Start", () => [...document.querySelectorAll("a")].some((a) => a.getAttribute("href") === "connect.html") && !document.querySelector('[data-host="start"]'));
await offers("screen=stopped", "proven stopped: Start asks the host", () => document.querySelector('[data-host="start"]') !== null);
await offers("screen=notfound-windows", "Windows: no setup, no look; Advanced and another computer", () => !/Set up OpenClaw/.test(document.getElementById("root").textContent) && [...document.querySelectorAll("a")].some((a) => a.getAttribute("href") === "connect.html"));
await offers("screen=first&os=windows", "Windows first screen: This computer doesn't start a look", () => document.querySelector("[data-choice]").getAttribute("href").includes("screen=notfound-windows"));
await offers("screen=notfound-there", "another computer, nothing there: no setup offered", () => !/Set up OpenClaw/.test(document.getElementById("root").textContent));
await offers("screen=install-confirm", "install: no pointer to removing OpenClaw in Settings", () => !/Remove it in Settings/.test(document.getElementById("root").textContent));
await offers("screen=installing", "installing: no Cancel in this version", () => !/Cancel/.test(document.getElementById("root").textContent));
await offers("screen=install-failed", "a failed install: no Try again in this version, details are fixed copy", () => !document.querySelector("[data-host]") && !/Try again/.test(document.getElementById("root").textContent) && !/event|said/i.test(document.querySelector(".s-disclosure").textContent));
await offers("screen=install-failed", "a failed step is drawn failed and the later ones wait", () => [...document.querySelectorAll(".s-steps li")].map((li) => li.dataset.state).join(",") === "done,failed,waiting,waiting");
await offers("screen=settings", "settings: Tailscale is read-only, with OpenClaw's instructions; no switch", () => !document.querySelector('[role="switch"]') && [...document.querySelectorAll("a")].some((a) => a.href === "https://docs.openclaw.ai/gateway/tailscale"));
await offers("screen=settings", "settings: no removal of OpenClaw in this version", () => !/Remove OpenClaw/.test(document.getElementById("root").textContent));
await offers("screen=settings", "settings: Connect a phone leads to the remote access page", () => [...document.querySelectorAll("a")].some((a) => a.getAttribute("href")?.startsWith("remote.html") && a.getAttribute("href").includes("screen=intro")));
await offers("screen=iphone-waiting", "iPhone waiting: no simulated approval", () => !document.querySelector("[data-simulate]") && !document.querySelector('a[href*="iphone-done"]'));
await offers("screen=code-pairing&addr=gateway.example", "pasted code pending: no simulated approval, the address named", () => !document.querySelector("[data-simulate]") && document.body.textContent.includes("gateway.example has not seen this device before."));

for (const [screen, running] of [
  ["looking-here", "Checking its version"],
  ["looking-there", "Finding OpenClaw"],
  ["connecting-here", "Pairing this computer, read-only"],
  ["connecting-there", "Opening a private connection to devbox"],
  ["installing", "Install Node.js and OpenClaw"],
]) {
  p = await open(`screen=${screen}`);
  const steps = await p.evaluate(() => [...document.querySelectorAll(".s-steps li")].map((li) => ({ state: li.dataset.state, label: li.getAttribute("aria-label"), current: li.getAttribute("aria-current") })));
  const current = steps.filter((s) => s.current === "step");
  check(`${screen}: one running step, marked as the current step`, current.length === 1 && current[0].label === `${running}, running`);
  check(`${screen}: each step's state is in its name`, steps.every((s) => s.label.endsWith(`, ${s.state}`)));
  await p.close();
}
for (const screen of ["looking-here", "looking-there", "connecting-here", "connecting-there"]) {
  await offers(`screen=${screen}`, `${screen}: has a way back`, () => Boolean(document.querySelector("[data-back]")));
}

// Part 5: the SSH field, the destination as text, Back, and the pasted code -----------------------
p = await open("screen=there");
for (const bad of ["-oProxyCommand=sh", "-user@host", "devbox; rm", "host name", "user@host:22", ".hidden"]) {
  await p.fill("#ssh-host", bad);
  await p.press("#ssh-host", "Enter");
  await p.waitForTimeout(40);
  check(`there: "${bad}" is refused before anything runs`, (await text(p)).includes("That isn't an SSH host or alias Clawtrate can use.") && (await screenOf(p)) === "there" && !(await p.evaluate(() => document.querySelector("[data-host-dialog]"))));
}
await p.fill("#ssh-host", "devbox");
await p.press("#ssh-host", "Enter");
await p.waitForSelector('[data-host-dialog="sshAccount"]');
await hostConfirm(p);
await at(p, "looking-there");
await click(p, "[data-back]");
check("Back from the look keeps the typed host", (await at(p, "there")) && (await p.inputValue("#ssh-host")) === "devbox");
await p.close();

for (const screen of ["unreachable", "refused"]) {
  p = await open(`screen=${screen}&name=oldbox`);
  await p.fill("#ssh-host", "otherbox");
  await btn("Try again")(p);
  await p.waitForSelector('[data-host-dialog="sshAccount"]', { timeout: 5000 });
  check(`${screen}: Try again asks the host for the destination now in the field`, (await text(p, "[data-host-dialog]")).includes("you@otherbox.example") && !(await text(p, "[data-host-dialog]")).includes("oldbox"));
  await p.close();
}

p = await open(`screen=looking-there&name=${encodeURIComponent('<img src=x onerror="window.hacked=1">')}`);
check("a destination from the address is shown as text, never as markup", await p.evaluate(() => !document.querySelector("#setup-root img:not(.s-mark)") && !window.hacked && document.body.textContent.includes("<img src=x")));
await p.close();

p = await open("screen=code");
const where = () => text(p, "#code-where");
const connectOff = () => p.evaluate(() => document.getElementById("code-connect").getAttribute("aria-disabled") === "true" && !document.getElementById("code-connect").hasAttribute("href"));
const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const FUTURE = 4102444800000;
check("code: Connect is unavailable before a code", await connectOff());
const unsafe = "That address can't be used safely. Clawtrate needs an encrypted address that isn't this computer's own.";
for (const [label, value, expect] of [
  ["not a code", "invalid", "That isn't a setup code Clawtrate can use."],
  ["no token", enc({ url: "wss://gateway.example", expiresAtMs: FUTURE }), "That isn't a setup code Clawtrate can use."],
  ["no expiry", enc({ url: "wss://gateway.example", bootstrapToken: "sample" }), "That isn't a setup code Clawtrate can use."],
  ["plain ws://", enc({ url: "ws://devbox.local:18789", bootstrapToken: "sample", expiresAtMs: FUTURE }), unsafe],
  ["127.0.0.1", enc({ url: "wss://127.0.0.1:18789", bootstrapToken: "sample", expiresAtMs: FUTURE }), unsafe],
  ["another loopback address", enc({ url: "wss://127.5.5.5", bootstrapToken: "sample", expiresAtMs: FUTURE }), unsafe],
  ["::1", enc({ url: "wss://[::1]:18789", bootstrapToken: "sample", expiresAtMs: FUTURE }), unsafe],
  ["localhost", enc({ url: "wss://localhost", bootstrapToken: "sample", expiresAtMs: FUTURE }), unsafe],
  ["credentials in the address", enc({ url: "wss://user:pw@gateway.example", bootstrapToken: "sample", expiresAtMs: FUTURE }), unsafe],
  ["a query", enc({ url: "wss://gateway.example/?x=1", bootstrapToken: "sample", expiresAtMs: FUTURE }), unsafe],
  ["a fragment", enc({ url: "wss://gateway.example/#x", bootstrapToken: "sample", expiresAtMs: FUTURE }), unsafe],
  ["a path", enc({ url: "wss://gateway.example/other", bootstrapToken: "sample", expiresAtMs: FUTURE }), unsafe],
  ["expired", enc({ url: "wss://gateway.example", bootstrapToken: "sample", expiresAtMs: 1000 }), "This code has expired. Make a new one on the gateway's computer."],
]) {
  await p.fill("#setup-code", value);
  check(`code: ${label} is refused, and Connect stays unavailable`, (await where()) === expect && (await connectOff()), await where());
}
await p.fill("#setup-code", enc({ url: "wss://gateway.example", bootstrapToken: "sample", expiresAtMs: FUTURE }));
check("code: an encrypted address is named, and Connect is available", (await where()) === "Connects to gateway.example, over an encrypted connection. Expires at 20:41." && !(await connectOff()));
check("code: the token is never shown", !(await text(p, "#code-where")).includes("sample"));
await p.close();

// Part 6: keyboard ----------------------------------------------------------------------------
p = await open("screen=first");
await p.keyboard.press("Tab");
check("first: Tab reaches This computer after the title", await p.evaluate(() => document.activeElement.textContent.includes("This computer")));
await p.keyboard.press("ArrowDown");
check("first: Down moves to Another computer", await p.evaluate(() => document.activeElement.textContent.includes("Another computer")));
await p.keyboard.press("Home");
check("first: Home goes back to This computer", await p.evaluate(() => document.activeElement.textContent.includes("This computer")));
await p.close();

// Part 7: widths, themes, motion -----------------------------------------------------------------
for (const [label, width] of [["1100", 1100], ["800", 800], ["phone", 390]]) {
  for (const screen of ["first", "found", "hostkey", "hostkey-changed", "install-confirm", "installing", "approve", "settings", "code-pairing"]) {
    p = await open(`screen=${screen}&width=${label === "phone" ? "phone" : "full"}`, { width, height: 844 });
    check(`${screen} at ${label}: no sideways scroll`, await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await p.close();
  }
}
await offers("screen=first&width=phone", "first at phone width: rows are touch-sized", () => document.querySelector(".b-choice").getBoundingClientRect().height >= 64);
await offers("screen=iphone", "iphone: shown at phone width with touch sizes", () => document.documentElement.dataset.width === "phone" && document.documentElement.dataset.input === "touch");
p = await open("screen=installing", { theme: "dark" });
check("installing, dark: the page uses the dark theme", await p.evaluate(() => document.documentElement.dataset.theme === "dark" && getComputedStyle(document.body).backgroundColor !== "rgb(255, 255, 255)"));
await p.close();
await offers("screen=installing&motion=reduce", "installing, reduced motion: the running step stands still", () => getComputedStyle(document.querySelector('[data-state="running"] .s-step-mark'), "::before").animationName === "none");
await offers("screen=installing", "installing: the running step turns with full motion", () => getComputedStyle(document.querySelector('[data-state="running"] .s-step-mark'), "::before").animationName === "s-turn");
p = await open("screen=looking-here");
await p.waitForTimeout(2800);
check("a wait reached from the address holds, so it can be looked at", (await screenOf(p)) === "looking-here");
await p.close();

// Part 8: the gallery and the bar reach this page -----------------------------------------------
p = await b.newPage();
await p.goto(pageUrl("gallery.html") + "?chrome=1");
await p.waitForTimeout(100);
check("gallery: links to the setup page", await p.evaluate(() => [...document.querySelectorAll("a")].some((a) => a.getAttribute("href")?.startsWith("setup.html"))));
check("the prototype bar links to the setup page", await p.evaluate(() => [...document.querySelectorAll("#proto-bar a")].some((a) => a.getAttribute("href") === "setup.html")));
await p.close();

await b.close();
console.log(out.join("\n"));
console.log(`${out.filter((l) => l.startsWith("ok")).length} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
