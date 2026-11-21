// Checks for remote.html: every walk of docs/design/remote-access.md (section
// 10) clicked through to its outcome, with each destination asserted; every
// state's words; the host's confirmations; what each state must not offer;
// widths, both themes and the gallery's link.
// Run from the repository root:  node docs/design/prototype/tools/checks/remote.mjs
import { chromium, pageUrl } from "./browser.mjs";

const base = pageUrl("remote.html") + "?chrome=0";
const b = await chromium.launch();
const out = [];
let failed = 0;
const check = (name, ok, extra = "") => {
  if (!ok) failed += 1;
  out.push(`${ok ? "ok  " : "FAIL"} ${name} ${extra}`);
};
// The page's timers run on a paused clock that the check moves on by the time it names, so a
// wait that plays on is seen however slowly the machine runs. The pause is set before the
// context has a page, so it has no deadline to miss.
const newPage = async (viewport = { width: 1440, height: 900 }) => {
  const context = await b.newContext({ viewport });
  await context.clock.install();
  await context.clock.pauseAt(Date.now());
  const p = await context.newPage();
  p.close = () => context.close();
  return p;
};
const open = async (query, { width = 1440, height = 900, theme } = {}) => {
  const p = await newPage({ width, height });
  const errors = [];
  p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto(`${base}${theme ? `&theme=${theme}` : ""}&${query}`);
  await p.clock.runFor(100);
  p.errors = errors;
  return p;
};
const text = (p, sel = "#root") => p.evaluate((s) => document.querySelector(s)?.textContent.replace(/\s+/g, " ") || "", sel);
const missing = (t, words) => words.filter((w) => !t.includes(w)).join(" | ");
const screenOf = (p) => new URL(p.url()).searchParams.get("screen");
// A screen is reached by a navigation, at once after a click or after a wait that plays on for
// 1.6 s of page time: the clock is moved on in steps until the address names it.
const at = async (p, screen, steps = 20) => {
  const reached = () => new URL(p.url()).searchParams.get("screen") === screen;
  for (let i = 0; i <= steps; i += 1) {
    await p.waitForLoadState("load");
    if (reached()) return true;
    try {
      await p.clock.runFor(200);
    } catch {
      // the page navigated while the clock moved on
    }
  }
  await p.waitForLoadState("load");
  return reached();
};
const hostConfirm = async (p) => {
  await p.waitForSelector("[data-host-dialog]");
  await p.locator("[data-host-confirm]").click();
};
const hostIs = (op) => async (p) => p.waitForSelector(`[data-host-dialog="${op}"]`, { timeout: 5000 });
const link = (name) => (p) => p.getByRole("link", { name, exact: true }).first().click();
const btn = (name) => (p) => p.getByRole("button", { name, exact: true }).first().click();

process.on("uncaughtException", (e) => {
  console.log(out.join("\n"));
  console.log("THREW", e.message.split("\n")[0]);
  process.exit(1);
});

// Part 1: the walks ---------------------------------------------------------------------------
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
  }
  if (ok && end && !(await at(p, end, 30))) {
    ok = false;
    where = `${await screenOf(p)} (expected ${end})`;
  }
  check(`walk: ${name}`, ok && p.errors.length === 0, ok ? "" : `stopped at ${where} ${p.errors.join(" | ")}`);
  await p.close();
}

await walk(
  "turn on, then a code: the host confirms each, the person starts the connector",
  "settings-off",
  [
    [link("Connect a phone…"), "intro"],
    [btn("Turn on remote access…"), null],
    [hostIs("remoteOn"), null],
    [hostConfirm, "turning-on"],
    [() => {}, "start-connector"],
    [link("The connector reaches the relay"), "make"],
    [btn("Make a code…"), null],
    [hostIs("makeCode"), null],
  ],
  null,
);
await walk("making a code ends on the code", "make", [[btn("Make a code…"), null], [hostConfirm, null]], "code");
await walk(
  "the code is used, then approve from here, read back",
  "code",
  [
    [link("A phone uses the code"), "code-used"],
    [() => {}, "request"],
    [btn("Approve from here…"), null],
    [hostIs("approvePhone"), null],
    [hostConfirm, "approving"],
  ],
  "approved",
);
await walk("the request changed: nothing is approved", "request", [[link("The phone asks again"), "request"], [btn("Approve from here…"), null], [hostConfirm, null]], "approve-changed");
await walk("the answer differs: remove it from the gateway", "approving&play=1&differs=1", [[() => {}, "approve-differs"], [btn("Remove it from the gateway…"), null], [hostIs("removeDevice"), null], [hostConfirm, null]], "device-removed");
await walk("a request for more", "code", [[link("A phone asks for more"), null]], "request-more");
await walk("let in by the code: remove it", "code", [[link("A device is let in by the code"), "let-in"], [btn("Remove it from the gateway…"), null], [hostConfirm, null]], "device-removed");
await walk("the code expires, then a new one", "code", [[link("The code expires"), "expired"], [link("Make a new code…"), null]], "make");
for (const [label, to] of [["Fail: connector", "fail-install"], ["Fail: gateway settings", "fail-settings"], ["Fail: trusted proxies", "fail-proxies"], ["Fail: read back", "fail-readback"], ["Fail: relay", "fail-relay"]]) {
  await walk(`turning on fails: ${to}`, "turning-on", [[link(label), null]], to);
}
await walk("making a code fails", "make", [[link("Fail: OpenClaw's code"), "make"], [btn("Make a code…"), null], [hostConfirm, null]], "fail-code");
await walk("remove a phone only from the connector", "settings-on", [[btn("Remove…"), null], [hostIs("removePhone"), null], [hostConfirm, null]], "removed");
await walk("remove a phone and its device", "settings-on", [[btn("Remove…"), null], [(p) => p.check("[data-host-check]"), null], [hostConfirm, null]], "removed-both");
await walk("removing its device fails in the middle", "settings-on", [[link("Fail: gateway step"), "settings-on"], [btn("Remove…"), null], [(p) => p.check("[data-host-check]"), null], [hostConfirm, null]], "remove-partial");
await walk("turn off: stop, then put back", "settings-on", [[btn("Turn off remote access…"), null], [hostIs("remoteOff"), null], [hostConfirm, "stop-connector"], [link("The connector stops"), null]], "turned-off");
await walk("turn off, changed elsewhere", "stop-connector", [[link("Someone changed the proxies"), "stop-connector"], [link("The connector stops"), null]], "turn-off-changed");
await walk("turn off, the connector keeps running", "stop-connector", [[link("Still running after 2 minutes"), null]], "turn-off-running");
for (const [label, to] of [["Connector: waiting", "settings-waiting"], ["Connector: stopped", "settings-stopped"], ["Status unreadable", "settings-unreadable"]]) {
  await walk(`the row: ${to}`, "settings-on", [[link(label), null]], to);
}
await walk(
  "the iPhone, scan: review, connect, wait, approved",
  "iphone",
  [
    [link("Scan a code"), "iphone-review"],
    [link("Connect"), "iphone-connecting"],
    [() => {}, "iphone-waiting"],
    [link("The owner approves"), null],
  ],
  "iphone-done",
);
await walk(
  "the iPhone, paste: refused codes, then a good one",
  "iphone",
  [
    [link("Paste a code"), "iphone-paste"],
    [btn("Paste an expired code"), null],
    [btn("Paste a good code"), null],
    [link("Continue"), null],
  ],
  "iphone-review",
);
for (const [label, to] of [["Code already used", "iphone-used"], ["Connector offline", "iphone-offline-first"], ["Relay unreachable", "iphone-unreachable-first"], ["Channel failed", "iphone-failed"], ["Token refused", "iphone-code-refused"]]) {
  await walk(`the iPhone's connect fails: ${to}`, "iphone-connecting", [[link(label), null]], to);
}
for (const [label, to] of [["Relay unreachable", "later-unreachable"], ["Connector offline", "later-offline"], ["Removed", "later-removed"], ["Revoked", "later-revoked"]]) {
  await walk(`the iPhone later: ${to}`, "iphone-done", [[link(label), null]], to);
}
await walk("removed: connect again leads to the first screen", "later-removed", [[link("Connect again"), null]], "iphone");
await walk("unreachable, then back", "later-unreachable", [[link("Back"), null]], "later-back");

// Part 2: every state's words ------------------------------------------------------------------
const WORDS = {
  "settings-off": ["Gateway · devbox", "Private access with Tailscale", "Remote access", "Off. Reach this gateway from your iPhone anywhere, through Clawtrate's relay.", "Connect a phone…"],
  "settings-address": ["Remote access", "Remote access is set up on the gateway's computer."],
  "settings-on": ["On. The connector on devbox is connected to relay.example.", "Trusted proxies", "Clawtrate added 127.0.0.1 and ::1 (there were none before)", "Phones", "iPhone", "added 21 Nov", "7C41-D2E0", "Remove…", "Connect another phone…", "Turn off remote access…"],
  "settings-waiting": ["On. The connector on devbox can't reach relay.example right now. Phones can't connect until it does.", "Check now", "Turn off remote access…"],
  "settings-stopped": ["On, but the connector on devbox isn't running. Phones can't connect.", "Start it", "launchctl bootstrap", "Turn off remote access…"],
  "settings-unreadable": ["Clawtrate couldn't read the connector's status on devbox.", "Look again"],
  intro: ["Connect a phone", "Your iPhone can reach this gateway from anywhere through Clawtrate's relay, relay.example.", "relay.example passes the connection on and can't read it. It sees addresses, times and sizes.", "Clawtrate's connector, in its own folder.", "Clawtrate adds 127.0.0.1 and ::1 to the gateway's trusted proxies, so each phone that comes through the relay waits for your approval. Turning remote access off puts back what was there.", "Each phone uses a one-time code, then waits for you to approve it, read-only.", "What the relay sees and keeps", "Turn on remote access…", "Cancel"],
  "turning-on": ["Turning on remote access", "Putting Clawtrate's connector on devbox", "Adding this computer to trusted proxies", "Starting the connector", "Reaching the relay"],
  "start-connector": ["Start the connector on devbox", "Added 127.0.0.1 and ::1 (there were none)", "Run this on devbox, in a terminal you trust. It keeps the connector running when you log in.", "launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.clawtrate.connector.plist", "Waiting for the connector, checking again in 4s", "Check now"],
  "fail-install": ["Putting Clawtrate's connector on devbox failed.", "Nothing was changed on the gateway.", "Try again"],
  "fail-settings": ["Clawtrate couldn't read the gateway's settings.", "Nothing was changed on the gateway.", "Try again"],
  "fail-proxies": ["The gateway's trusted proxies changed after Clawtrate set them.", "Clawtrate left them as they are. Check them on devbox.", "Look again"],
  "fail-readback": ["The gateway's trusted proxies didn't read back as expected.", "Clawtrate didn't go on.", "Turn off remote access…"],
  "fail-relay": ["The connector on devbox can't reach relay.example.", "Check that devbox can reach the internet. Clawtrate keeps checking.", "Check now", "Turn off remote access…"],
  make: ["Connect a phone", "Phone's name", "Make a code…"],
  "fail-code": ["Couldn't make a one-time code.", "OpenClaw exited with code 1."],
  "fail-too-many": ["Too many codes are open.", "Wait until one is used or expires, at most 10 minutes."],
  "fail-phones": ["This connector has 32 phones.", "Remove one in Settings first."],
  "fail-setupcode": ["OpenClaw made a code Clawtrate can't use.", "Nothing was handed out."],
  code: ["Scan this with Clawtrate on your iPhone", "Or paste the code:", "Expires", "20:41 (in 9 minutes)", "Relay", "relay.example", "Connector key", "7Q2F-KWLM", "Your iPhone shows the same key before it connects.", "Show this code only to your iPhone.", "Until your iPhone uses it, anyone who scans it can connect to this gateway without your approval, posing as one of OpenClaw's own apps.", "Waiting for a phone to use this code, checking again in 4s", "Done", "Closing this doesn't cancel the code. It works until 20:41 or until a phone uses it."],
  "code-used": ["The phone used the code. Waiting for its request, checking again in 4s"],
  expired: ["This code expired at 20:41.", "Nothing used it.", "Make a new code…"],
  request: ["Approve this iPhone?", "A phone used the code and asks the gateway to let it in.", "7C41-D2E0", "Compare it with the code on the iPhone.", "Read your bots, tasks and conversations", "Address the relay reported", "203.0.113.7", "Approve from here…", "Or approve it on devbox yourself"],
  approving: ["Checking the request", "Approving it on devbox", "Reading it back"],
  approved: ["Approved.", "devbox's gateway lists this iPhone with read access.", "Done"],
  "approve-changed": ["This request changed since you looked.", "Nothing was approved."],
  "approve-differs": ["The gateway approved something other than this request.", "It lists this iPhone with: Read, Approve pairing requests.", "Remove it from the gateway…", "Keep it"],
  "approve-gone": ["This request is gone.", "The phone may have stopped asking, or someone answered it already."],
  "approve-unread": ["Clawtrate couldn't read the result.", "Look in the gateway's devices before you rely on it.", "Look again"],
  "request-more": ["This phone asks for more than read", "7C41-D2E0", "Clawtrate approves only a request for read. Clawtrate on iPhone asks for read alone, so this may not be your iPhone.", "openclaw devices reject", "Remove it from remote access…"],
  "let-in": ["A device was let in by this code without your approval", "devbox's gateway lists a new device that came through the relay and was approved by the code alone, as OpenClaw's own apps can be. If it isn't yours, remove it.", "node-host", "by the code", "Remove it from the gateway…", "Remove it from remote access…"],
  "device-removed": ["Removed from the gateway.", "devbox's gateway no longer lists it."],
  removed: ["Removed from remote access.", "Its device is still on the gateway. To remove it there:", "openclaw devices remove", "No phones yet."],
  "removed-both": ["Removed from remote access. Removed from the gateway."],
  "remove-partial": ["Removed from remote access. Removing its device from the gateway failed (exit 1).", "The gateway still lists it.", "Try again"],
  "stop-connector": ["Turning off remote access", "Stopping the connector", "Putting back the trusted proxies", "launchctl bootout", "Waiting for the connector to stop, checking again in 4s"],
  "turned-off": ["Connector stopped. It reports it isn't running.", "Trusted proxies put back: none."],
  "turn-off-changed": ["The gateway's trusted proxies changed after Clawtrate set them.", "Clawtrate left them as they are: 127.0.0.1, ::1, 198.51.100.0/24. Its record of the earlier value is kept.", "Look again"],
  "turn-off-running": ["The connector on devbox is still running.", "launchctl bootout"],
  iphone: ["Connect to your OpenClaw", "Scan a code", "Paste a code", "Get a code from Clawtrate on your computer: Settings, Gateway, Connect a phone. A setup code from the gateway's owner works too.", "Advanced"],
  "iphone-paste": ["Paste a code", "Code", "Continue"],
  "iphone-review": ["Connect through Clawtrate's relay?", "Relay", "relay.example", "Computer's key", "7Q2F-KWLM", "Expires", "20:41 (in 9 minutes)", "Clawtrate on your computer shows the same key next to the code. The relay passes this connection on without being able to read it: only the computer holding this key can.", "Connect", "Cancel"],
  "iphone-connecting": ["Connecting", "Reaching the relay", "Checking the computer's key", "Asking the gateway to let this iPhone in, read-only"],
  "iphone-waiting": ["Waiting for approval", "Approve this iPhone in Clawtrate on your computer. Its device code is:", "7C41-D2E0", "Or on the gateway's computer", "if the gateway doesn't use the default profile", "Waiting for approval, checking again in 4s"],
  "iphone-done": ["Connected, read-only", "Clawtrate on this iPhone can read your bots, tasks and conversations. Sending or changing anything is asked for later."],
  "iphone-used": ["This code was already used, or it expired.", "Make a new code in Clawtrate on your computer.", "Scan a code"],
  "iphone-offline-first": ["The gateway's computer isn't connected to the relay.", "Check that Clawtrate's connector runs there, then try again.", "Try again"],
  "iphone-unreachable-first": ["Can't reach relay.example.", "Check this iPhone's connection, then try again.", "Try again"],
  "iphone-failed": ["The connection to the gateway's computer failed.", "Try again. If it keeps failing, make a new code."],
  "iphone-code-refused": ["The code didn't work.", "Make a new code in Clawtrate on your computer."],
  "later-unreachable": ["Can't reach relay.example", "showing saved messages", "Retry now"],
  "later-offline": ["Connector offline", "the gateway's computer isn't connected to the relay", "Retry now"],
  "later-removed": ["Removed from remote access", "Connect again"],
  "later-revoked": ["Not accepted by the gateway", "Connect again"],
  "later-back": ["Connected again"],
};

let p = await open("screen=settings-off");
const listed = await p.evaluate(() => window.CT.remoteScreens);
const hostOps = await p.evaluate(() => window.CT.remoteHostDialogs);
check("every state the page offers is checked", listed.every((s) => s in WORDS), listed.filter((s) => !(s in WORDS)).join(", "));
check("every state checked is offered by the page", Object.keys(WORDS).every((s) => listed.includes(s)), Object.keys(WORDS).filter((s) => !listed.includes(s)).join(", "));
check("dark is the page's default theme", await p.evaluate(() => document.documentElement.dataset.theme === "dark"));
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
  check(`${screen}: never says secure, private, verified or end-to-end`, !/\b(secure|private|verified|end-to-end)\b/i.test(t.replace(/private access/gi, "")));
  await p.close();
}

// Part 3: the host's confirmations --------------------------------------------------------------
const HOST_WORDS = {
  remoteOn: ["Turn on remote access for the default gateway on devbox?", "This uses the remote account's SSH login environment.", "Clawtrate puts its connector on devbox, which connects to relay.example, and adds 127.0.0.1 and ::1 to gateway.trustedProxies."],
  makeCode: ["Make a code for a phone to use devbox's gateway?", "Until a phone uses it, anyone who scans it can connect to this gateway. It works once, for up to 10 minutes."],
  approvePhone: ["Approve this iPhone read-only on the default gateway on devbox?", "Device code 7C41-D2E0. It can read your bots, tasks and conversations, and ask for more later. Asking for more always waits for your approval."],
  removeDevice: ["Remove this device from devbox's gateway?", "7C41-D2E0"],
  removePhone: ["Remove iPhone from remote access on devbox?", "It can't reach the gateway through the relay any more. A session it has open ends within seconds.", "Also remove its device from devbox's gateway (7C41-D2E0)"],
  remoteOff: ["Turn off remote access on devbox?", "Clawtrate stops the connector and puts the gateway's trusted proxies back to what they were before (none). The connector's keys and its list of phones stay on devbox, so turning it on again keeps them."],
};
check("every host dialog is checked", hostOps.every((op) => op in HOST_WORDS) && Object.keys(HOST_WORDS).every((op) => hostOps.includes(op)), hostOps.join(", "));
for (const [op, words] of Object.entries(HOST_WORDS)) {
  p = await open(`screen=settings-on&host=${op}`);
  const t = await text(p, "[data-host-dialog]");
  check(`host dialog ${op}: its words`, !missing(t, words), missing(t, words));
  check(`host dialog ${op}: marked as a stand-in for the app's own dialog`, t.includes("a stand-in for the native dialog"));
  await p.keyboard.press("Escape");
  check(`host dialog ${op}: Escape closes it`, !(await p.evaluate(() => document.querySelector("[data-host-dialog]"))));
  await p.close();
}

// Part 4: what each state offers, and doesn't ---------------------------------------------------
async function offers(query, name, fn) {
  const page = await open(query);
  check(name, await page.evaluate(fn));
  await page.close();
}
await offers("screen=request-more", "a request for more: no approve button and no approve command", () => !document.querySelector('[data-host="approvePhone"]') && !/devices approve/.test(document.getElementById("root").textContent));
await offers("screen=let-in", "let in by the code: no approve, Remove from the gateway asks the host", () => !document.querySelector('[data-host="approvePhone"]') && Boolean(document.querySelector('[data-host="removeDevice"]')));
await offers("screen=code", "the code: the warning is shown with the code, and Done leaves it valid", () => Boolean(document.querySelector('.b-note[data-tone="warn"]')) && /Closing this doesn't cancel the code/.test(document.body.textContent));
await offers("screen=code", "the code: the QR stand-in is labelled as one", () => Boolean(document.querySelector('.r-qr[role="img"]')) && /stand-in pattern/.test(document.body.textContent));
await offers("screen=intro", "intro: the code is not made before the host's dialog", () => !document.querySelector(".r-qr") && Boolean(document.querySelector('[data-host="remoteOn"]')));
await offers("screen=intro&tailscale=1", "intro with a Tailscale route Clawtrate didn't make: the warning", () => /A Tailscale route to this gateway that Clawtrate didn't make will start to work too/.test(document.body.textContent));
await offers("screen=intro", "intro without one: no Tailscale warning", () => !/will start to work too/.test(document.body.textContent));
await offers("screen=settings-address", "an address route: the row is read-only", () => !document.querySelector('[data-remote-row] [data-host], [data-remote-row] a.button'));
await offers("screen=settings-unreadable", "status unreadable: no Turn off or Connect, only Look again", () => !document.querySelector('[data-host="remoteOff"]') && !/Connect a phone/.test(document.querySelector("[data-remote-row]").textContent));
await offers("screen=iphone-waiting", "iPhone waiting: approval is an event from outside, in the prototype box", () => [...document.querySelectorAll("[data-simulate]")].every((a) => a.closest("[data-events]")));
await offers("screen=iphone-review", "the review: nothing connects before Connect", () => !document.querySelector(".s-steps"));
await offers("screen=fail-install", "a failed step is drawn failed and the later ones wait", () => [...document.querySelectorAll(".s-steps li")].map((li) => li.dataset.state).join(",") === "failed,waiting,waiting,waiting");
await offers("screen=turn-off-changed", "turn off, changed elsewhere: the connector step done, the proxies step failed", () => [...document.querySelectorAll(".s-steps li")].map((li) => li.dataset.state).join(",") === "done,failed");
await offers("screen=settings-on", "the row: the free-text last exit is never shown", () => !/socket_error|ECONNREFUSED/.test(document.body.textContent));
p = await open("screen=turning-on");
await p.clock.runFor(2200);
check("a wait reached from the address holds", (await screenOf(p)) === "turning-on");
await p.close();
p = await open("screen=settings-on&host=removePhone");
const before = await p.evaluate(() => document.querySelector("[data-host-confirm]").getAttribute("href"));
await p.check("[data-host-check]");
const after = await p.evaluate(() => document.querySelector("[data-host-confirm]").getAttribute("href"));
check("remove a phone: the device box is optional and changes what runs", before.includes("screen=removed") && after.includes("screen=removed-both"));
await p.close();

// Part 5: widths and themes ----------------------------------------------------------------------
for (const [label, width] of [["1440", 1440], ["800", 800], ["phone", 390]]) {
  for (const screen of ["settings-on", "intro", "start-connector", "code", "request", "let-in", "turned-off", "iphone-review", "iphone-waiting", "later-offline"]) {
    p = await open(`screen=${screen}&width=${label === "phone" ? "phone" : "full"}`, { width, height: 844 });
    check(`${screen} at ${label}: no sideways scroll`, await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await p.close();
  }
}
for (const theme of ["light", "dark"]) {
  p = await open("screen=code", { theme });
  check(`code, ${theme}: the theme applies and the QR stays on white`, await p.evaluate((t) => document.documentElement.dataset.theme === t && getComputedStyle(document.querySelector(".r-qr")).backgroundColor === "rgb(255, 255, 255)", theme));
  await p.close();
}
await offers("screen=iphone", "iphone: shown at phone width with touch sizes", () => document.documentElement.dataset.width === "phone" && document.documentElement.dataset.input === "touch");

// Part 6: the gallery and setup reach this page -------------------------------------------------
p = await newPage();
await p.goto(pageUrl("gallery.html") + "?chrome=1");
await p.clock.runFor(100);
check("gallery: links to the remote access page", await p.evaluate(() => [...document.querySelectorAll("a")].some((a) => a.getAttribute("href")?.startsWith("remote.html"))));
await p.close();
p = await newPage();
await p.goto(pageUrl("setup.html") + "?chrome=0&screen=settings");
await p.clock.runFor(100);
check("setup's Settings: Connect a phone leads here", await p.evaluate(() => [...document.querySelectorAll("a")].some((a) => a.getAttribute("href")?.startsWith("remote.html"))));
await p.close();

await b.close();
console.log(out.join("\n"));
console.log(`${out.filter((l) => l.startsWith("ok")).length} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
