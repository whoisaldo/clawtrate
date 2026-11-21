// Where a bot runs and Settings, Machines (docs/design/controls.md sections 14
// and 15) against a real development gateway: this run's accounts instance,
// started with a paired machine (`--with-node`: the gateway's own node host,
// media-box, declaring only its two approvals commands). One preview host
// writes, as a person drives it; a second, pinned read-only, reads what the
// first saved. What landed is read from the gateway by a paired admin client.
// Everything changed on the gateway is put back afterwards, so no later check
// of the run meets another arrangement.
//
// With CLAWTRATE_MACHINE_SHOTS=<folder outside the repository>, it also saves
// screenshots of what it checked there, at 1440 light and dark and 390 light.
import { expect, test, type Browser, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCOUNT_CLIENTS } from "../tools/dev-gateway/src/account-checks.ts";
import { openInstance, openOperator } from "../tools/dev-gateway/src/cli.ts";
import type { OperatorSession } from "../tools/dev-gateway/src/operator.ts";
import { devGateway, listInstances, startHost, stopChild } from "./global-setup.ts";

const INSTANCE = process.env.CLAWTRATE_E2E_ACCOUNTS!;
const STATIC = process.env.CLAWTRATE_E2E_STATIC!;
const SHOTS = process.env.CLAWTRATE_MACHINE_SHOTS ?? null;

test.describe.configure({ mode: "serial" });

type Json = Record<string, unknown>;
type Host = { child: ChildProcess; url: string; data: string; page: Page };

let admin: OperatorSession;
let writer: Host;
let reader: Host;
let nodeId: string;
/** What the checks change, as it was before, to put back. */
let ottoTools: Json;
let ottoWorkspace: string;
/** Otto's name as the interface shows it: "otto" on an instance that was not seeded. */
let OTTO = "Otto";
/** Otto's stored command host before the checks, as the picker names it. */
let ottoHost = "Not set";

async function config(): Promise<Json> {
  return ((await admin.request<{ config: Json }>("config.get", {})).config ?? {}) as Json;
}
const entry = (cfg: Json, bot: string) =>
  (((cfg.agents as Json).entries as Json)[bot] ?? {}) as Json;

async function approve(): Promise<void> {
  await expect
    .poll(() => devGateway(INSTANCE, "approve"), { timeout: 30_000, intervals: [1000] })
    .toMatch(/^Approved /m);
}

async function shots(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  const size = page.viewportSize()!;
  for (const [width, height, theme] of [
    [1440, 900, "light"],
    [1440, 900, "dark"],
    [390, 844, "light"],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: theme });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, `${name}-${theme}-${width}.png`) });
  }
  await page.setViewportSize(size);
  await page.emulateMedia({ colorScheme: "light" });
}

async function open(browser: Browser, readOnly: boolean): Promise<Host> {
  const data = mkdtempSync(join(tmpdir(), "clawtrate-machines-"));
  const started = startHost(INSTANCE, STATIC, data, { readOnly });
  started.gated.release();
  const url = await started.url;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(url);
  await page.getByRole("button", { name: "Use the development gateway" }).click();
  await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible({
    timeout: 20_000,
  });
  await approve();
  await expect(page.getByTestId("bot").first()).toBeVisible({ timeout: 30_000 });
  return { child: started.host, url, data, page };
}

/** Otto's "Where Otto runs" page, in the Work pane's Settings tab. */
async function runsOn(page: Page) {
  const otto = page
    .getByTestId("bot-list")
    .getByRole("button", { name: new RegExp(`^${OTTO}\\b`) });
  await otto.click();
  if (!(await page.getByTestId("work-panel").isVisible()))
    await page.keyboard.press("ControlOrMeta+\\");
  await page.getByRole("tab", { name: "Settings" }).click();
  const back = page.getByRole("button", { name: "Back to settings" });
  if (await back.isVisible()) await back.click();
  await page
    .getByRole("button", { name: new RegExp(`^Where ${OTTO} runs: `) })
    .click({ timeout: 30_000 });
  await expect(page.getByTestId("runs-on-workspace")).toBeVisible({ timeout: 30_000 });
}

/** Settings, Machines. */
async function machines(page: Page) {
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Machines", exact: true }).click();
  await expect(page.getByTestId("machine-list")).toBeVisible({ timeout: 30_000 });
  return settings;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  expect(INSTANCE, "this run's accounts instance").toMatch(/^e2e-[0-9a-f]{8}-acct$/);
  expect(listInstances().find((each) => each.name === INSTANCE)?.gatewayRunning).toBe(true);
  admin = await openOperator(
    openInstance(INSTANCE),
    "Clawtrate machines check",
    [...ACCOUNT_CLIENTS.admin.scopes, "operator.pairing"],
    [...ACCOUNT_CLIENTS.admin.caps],
  );
  // The paired machine, as the gateway lists it to a read client.
  const nodes = await admin.request<{ nodes: Json[] }>("node.list", {});
  const media = nodes.nodes.find((node) => node.displayName === "media-box");
  expect(media, "the instance's paired machine").toBeTruthy();
  expect(media).toMatchObject({ connected: true, approvalState: "approved" });
  expect(media!.commands).toEqual(["system.execApprovals.get", "system.execApprovals.set"]);
  nodeId = media!.nodeId as string;
  const listed = await admin.request<{ agents: Json[] }>("agents.list", {});
  const row = listed.agents.find((agent) => agent.id === "otto") ?? {};
  OTTO = String((row.identity as Json | undefined)?.name ?? row.name ?? "otto");
  const cfg = await config();
  ottoTools = (entry(cfg, "otto").tools ?? {}) as Json;
  ottoWorkspace = entry(cfg, "otto").workspace as string;
  const stored =
    ((ottoTools.exec as Json | undefined)?.host as string | undefined) ??
    (((cfg.tools as Json | undefined)?.exec as Json | undefined)?.host as string | undefined);
  ottoHost =
    stored === undefined ? "Not set" : stored === "gateway" ? "The gateway's machine" : stored;
  // Otto's first task, so its Work pane has a task to show beside it.
  await admin
    .request("sessions.create", { key: "agent:otto:main", agentId: "otto", label: "Main" })
    .catch(() => {});
  writer = await open(browser, false);
  reader = await open(browser, true);
});

test.afterAll(async () => {
  // Put back Otto's settings: its command placement, its deny list and its workspace. Only
  // what beforeAll recorded is put back; a failure here is reported after everything is closed.
  let restoreError: unknown = null;
  if (admin && ottoTools) {
    try {
      const cfg = await admin.request<{ hash: string }>("config.get", {}).catch(() => null);
      const exec = (ottoTools.exec ?? {}) as Json;
      const deny = ottoTools.deny as string[] | undefined;
      if (cfg)
        await admin.request("config.patch", {
          raw: JSON.stringify({
            agents: {
              entries: {
                otto: {
                  tools: {
                    exec: { ...exec, host: exec.host ?? null, node: exec.node ?? null },
                    deny: deny ?? null,
                  },
                },
              },
            },
          }),
          baseHash: cfg.hash,
          // The list is replaced, or removed when Otto had none: either way its path is named.
          replacePaths: ["agents.entries.otto.tools.deny"],
        });
      const back = (entry(await config(), "otto").tools ?? {}) as Json;
      expect(back.exec ?? null, "Otto's command placement put back").toEqual(
        ottoTools.exec ?? null,
      );
      expect(back.deny ?? null, "Otto's deny list put back").toEqual(ottoTools.deny ?? null);
      if (ottoWorkspace)
        await admin
          .request("agents.update", { agentId: "otto", workspace: ottoWorkspace })
          .catch(() => {});
    } catch (error) {
      restoreError = error;
    }
  }
  // Each resource is released on its own, so one failure leaves none of the others behind.
  const steps: Array<() => unknown> = [() => admin?.close()];
  for (const host of [writer, reader]) {
    if (!host) continue;
    steps.push(
      () => host.page.context().close(),
      () => stopChild(host.child),
      () => rmSync(host.data, { recursive: true, force: true }),
    );
  }
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      console.warn(`machines cleanup: ${String(error)}`);
    }
  }
  if (restoreError) throw restoreError;
});

test("F-046 F-047: below admin every place shows, nothing can change, and the bar asks for admin only when the person asks", async () => {
  const page = writer.page;
  const pending = async () =>
    (await admin.request<{ pending: Json[] }>("device.pair.list", {})).pending;
  const before = await pending();
  // The web host may already have a read-only repair pending from pairing in setup.
  for (const request of before) {
    expect(request).toMatchObject({
      displayName: "Clawtrate Web",
      isRepair: true,
      role: "operator",
      scopes: ["operator.read"],
    });
  }
  await runsOn(page);
  await expect(page.getByTestId("runs-on-machine")).toBeDisabled();
  await expect(page.getByTestId("runs-on-machine")).toHaveAccessibleName(
    `${OTTO}'s command machine: ${ottoHost}`,
  );
  await expect(page.getByTestId("runs-on-workspace")).toContainText(ottoWorkspace);
  await expect(page.getByTestId("runs-on-page")).not.toContainText("enforces");
  await expect(page.getByTestId("inventory-secrets")).toHaveText("Needs admin access");
  await expect(page.getByTestId("admin-bar")).toContainText(
    `Changing where ${OTTO} runs needs admin access.`,
  );
  // An earlier request may have cleared. Reading must not create or change one.
  for (const request of await pending()) {
    expect(before, "reading machine settings created or changed a pairing request").toContainEqual(
      request,
    );
  }
  await shots(page, "runs-on-below-admin");
});

test("F-157: with device access alone, the gateway lists this device's own record only, and the page says so", async () => {
  test.setTimeout(120_000);
  const page = writer.page;
  const settings = await machines(page);
  await settings.getByTestId("device-bar").getByRole("button", { name: "Request access" }).click();
  await expect(settings.getByTestId("device-bar")).toContainText(
    "Waiting for the gateway's owner.",
    {
      timeout: 15_000,
    },
  );
  await approve();
  const list = settings.getByTestId("device-list");
  await expect(list).toBeVisible({ timeout: 30_000 });
  // The gateway holds other paired devices (the admin client, the reader), and lists none of them.
  const all = await admin.request<{ paired: Json[] }>("device.pair.list", {});
  expect(all.paired.filter((device) => device.role !== "node").length).toBeGreaterThan(1);
  await expect(list.locator("dt")).toHaveCount(1);
  await expect(list.locator("dt")).toHaveText("This device");
  await expect(settings.getByTestId("devices-own-only")).toHaveText(
    "Without admin access, the gateway lists only this device.",
  );
  await page.keyboard.press("Escape");
});

test("F-046: admin asked for explicitly sets Otto's commands to media-box; it is read back, and a read-only connection sees it", async () => {
  test.setTimeout(180_000);
  const page = writer.page;
  const bar = page.getByTestId("admin-bar");
  await bar.getByRole("button", { name: "Request admin access" }).click();
  // The admin bar's waiting state, in setup.md §9's words for where the request waits.
  await expect(bar).toContainText("Waiting for approval.", { timeout: 15_000 });
  await approve();
  await expect(page.getByTestId("runs-on-machine")).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId("runs-on-machine").click();
  await page.getByRole("menuitemradio", { name: "media-box · Connected" }).click();
  const announcer = page.getByTestId("work-announcer");
  await expect(announcer).toHaveText(
    new RegExp(
      `^Saved(?: and applied|\\. The gateway doesn't report it applied yet)\\. ${OTTO}'s command machine setting: media-box$`,
    ),
    { timeout: 30_000 },
  );
  // On the gateway: Otto's own entry names the machine by its id, and "applied" is said
  // only when the gateway reports the saved revision active.
  const read = await admin.request<{
    config: Json;
    configRevisionHash: string;
    appliedConfigHash: string;
  }>("config.get", {});
  expect((entry(read.config, "otto").tools as Json).exec).toMatchObject({
    host: "node",
    node: nodeId,
  });
  if ((await announcer.textContent())!.startsWith("Saved and applied"))
    expect(read.appliedConfigHash).toBe(read.configRevisionHash);
  // media-box declares no system.run: the page says so, and nothing about what follows.
  await expect(page.getByTestId("runs-on-no-run")).toHaveText(
    "media-box doesn't list system.run among its commands.",
  );
  await shots(page, "runs-on-media-box");
  // A second connection, pinned to reading, reads the same.
  await runsOn(reader.page);
  await expect(reader.page.getByTestId("runs-on-machine")).toHaveAccessibleName(
    `${OTTO}'s command machine: media-box · Connected`,
  );
  await expect(reader.page.getByTestId("runs-on-machine")).toBeDisabled();
  await expect(reader.page.getByTestId("admin-bar")).toContainText("This connection only reads.");
  await reader.page.getByRole("button", { name: "Back to settings" }).click();
  await expect(reader.page.getByTestId("runs-on-value")).toHaveText("Command setting: media-box");
  await shots(reader.page, "runs-on-read-only");
});

test("F-046: a host pinned to reading refuses a change sent anyway, and the gateway keeps what it had", async () => {
  const before = (entry(await config(), "otto").tools as Json).exec;
  const answer = await reader.page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const socket = new WebSocket(`ws://${location.host}/bridge`);
        socket.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as Record<string, unknown>;
          if (message.type === "hello")
            socket.send(
              JSON.stringify({
                type: "command",
                id: "do",
                command: {
                  type: "setCommandMachine",
                  botId: "otto",
                  host: "gateway",
                  nodeId: null,
                  baseHash: null,
                },
              }),
            );
          else if (message.id === "do") {
            socket.close();
            resolve(message.ok ? "accepted" : String(message.error));
          }
        };
      }),
  );
  expect(answer).toMatch(/only reads/);
  expect((entry(await config(), "otto").tools as Json).exec).toEqual(before);
});

test("F-047: with coder denied to Otto, a read-only connection sees coder denied for Otto and secrets needing admin", async () => {
  const cfg = await admin.request<{ hash: string; config: Json }>("config.get", {});
  const deny = ((entry(cfg.config, "otto").tools as Json).deny as string[] | undefined) ?? [];
  await admin.request("config.patch", {
    raw: JSON.stringify({
      agents: { entries: { otto: { tools: { deny: [...deny, "coder__*"] } } } },
    }),
    baseHash: cfg.hash,
  });
  const page = reader.page;
  await runsOn(page);
  await expect(page.getByTestId("inventory-servers")).toContainText(
    `coder (${OTTO}'s deny list: coder__*)`,
    { timeout: 20_000 },
  );
  await expect(page.getByTestId("inventory-secrets")).toHaveText("Needs admin access");
  await expect(page.getByTestId("inventory-signins")).toHaveText("Needs admin access");
  await expect(
    page.getByText(`Inventory. Whether ${OTTO} can use each isn't reported.`),
  ).toBeVisible();
  await shots(page, "runs-on-inventory");
});

test("F-274: admin chooses a new workspace folder for Otto; the gateway creates it and reads it back", async () => {
  const page = writer.page;
  await runsOn(page);
  await expect(
    page.getByText("This control sets the bot's workspace in the gateway's settings."),
  ).toBeVisible();
  const moved = join(openInstance(INSTANCE).stateDir, "workspaces", `otto-moved-${Date.now()}`);
  expect(existsSync(moved)).toBe(false);
  await page.getByRole("button", { name: "Change…" }).click();
  const field = page.getByRole("textbox", { name: /path on the gateway's machine/ });
  // Beside the field, Otto's folder as it is now, not a fixed example.
  await expect(page.locator('label[for="m-workspace"]')).toContainText(`Now: ${ottoWorkspace}`);
  await field.fill(moved);
  await page.getByRole("button", { name: "Save folder" }).click();
  await expect(page.getByTestId("work-announcer")).toHaveText(
    `Saved. ${OTTO}'s workspace: ${moved}`,
    {
      timeout: 30_000,
    },
  );
  const agents = await admin.request<{ agents: Json[] }>("agents.list", {});
  expect(agents.agents.find((agent) => agent.id === "otto")?.workspace).toBe(moved);
  expect(existsSync(moved)).toBe(true);
  await expect(page.getByTestId("runs-on-workspace")).toContainText(moved);
  // A path the gateway can't use is refused in its own words, and the workspace stays.
  const file = join(moved, "not-a-folder");
  writeFileSync(file, "");
  await page.getByRole("button", { name: "Change…" }).click();
  await field.fill(join(file, "child"));
  await page.getByRole("button", { name: "Save folder" }).click();
  await expect(page.locator("#m-workspace-error")).toContainText("ENOTDIR", { timeout: 30_000 });
  const after = await admin.request<{ agents: Json[] }>("agents.list", {});
  expect(after.agents.find((agent) => agent.id === "otto")?.workspace).toBe(moved);
  await expect(page.getByTestId("runs-on-workspace")).toContainText(moved);
});

test("F-156: admin sets media-box's defaults to Ask every time; the file reads back with a new hash, shown as the file's setting", async () => {
  test.setTimeout(120_000);
  const before = await admin.request<{ hash: string; file: Json }>("exec.approvals.node.get", {
    nodeId,
  });
  const page = writer.page;
  const settings = await machines(page);
  await expect(page.locator('[data-machine="media-box"]').first()).toContainText(
    `Connected · Lists no system.run command · Node ID stored in the settings of ${OTTO}`,
  );
  const file = settings.locator('[data-testid="approvals-file"][data-machine="media-box"]');
  await file.getByRole("radio", { name: "Ask every time" }).click();
  await expect(settings.getByTestId("b-announcer")).toHaveText("Saved. media-box: Ask every time", {
    timeout: 30_000,
  });
  const after = await admin.request<{ hash: string; file: Json }>("exec.approvals.node.get", {
    nodeId,
  });
  expect(after.hash).not.toBe(before.hash);
  expect((after.file.defaults as Json) ?? {}).toMatchObject({
    security: "allowlist",
    ask: "always",
  });
  await expect(file.getByRole("radio", { checked: true })).toHaveAccessibleName("Ask every time", {
    timeout: 20_000,
  });
  // The file's setting, and no outcome of a command worked out from it.
  await expect(page.getByTestId("machines")).not.toContainText("Effective");
  await shots(page, "machines-ask-every-time");

  // A file changed on the gateway after the page read it: the save is refused, nothing changes.
  await admin.request("exec.approvals.node.set", {
    nodeId,
    baseHash: after.hash,
    file: { version: 1, defaults: { security: "deny", ask: "off" }, agents: {} },
  });
  const changed = await admin.request<{ hash: string }>("exec.approvals.node.get", { nodeId });
  await file.getByRole("radio", { name: "Allow every command" }).click();
  await expect(file.getByTestId("approvals-error")).toContainText("changed since it was read", {
    timeout: 20_000,
  });
  expect((await admin.request<{ hash: string }>("exec.approvals.node.get", { nodeId })).hash).toBe(
    changed.hash,
  );
  // Put the file back as it was.
  await admin.request("exec.approvals.node.set", {
    nodeId,
    baseHash: changed.hash,
    file: { ...before.file, socket: undefined },
  });
  await page.keyboard.press("Escape");
});

test("F-157: machines and paired devices as last seen; with admin, a machine and a device are renamed and an offline device removed, each read back from the whole listing", async () => {
  test.setTimeout(120_000);
  // A device that pairs and goes away: offline, to be removed.
  const gone = await openOperator(
    openInstance(INSTANCE),
    "Clawtrate old laptop",
    ["operator.read"],
    [],
  );
  await gone.close();
  const page = writer.page;
  const settings = await machines(page);
  const list = settings.getByTestId("device-list");
  await expect(list.locator("dt").first()).toHaveText("This device");
  await expect(list).toContainText("Clawtrate old laptop");
  await expect(list).toContainText(/Last seen/);
  // Rename the machine, read back, and back again.
  await settings
    .locator('[data-machine="media-box"]')
    .getByRole("button", { name: "Rename" })
    .click();
  await settings.getByRole("textbox", { name: "New name for media-box" }).fill("media-shelf");
  await page.keyboard.press("Enter");
  await expect(settings.getByTestId("b-announcer")).toHaveText("Renamed", { timeout: 20_000 });
  expect(
    (await admin.request<{ nodes: Json[] }>("node.list", {})).nodes.find((n) => n.nodeId === nodeId)
      ?.displayName,
  ).toBe("media-shelf");
  await admin.request("node.rename", { nodeId, displayName: "media-box" });
  // Rename the offline device, then remove it after the confirmation.
  const row = list.locator("div", { hasText: "Clawtrate old laptop" }).last();
  await row.getByRole("button", { name: "Rename" }).click();
  await settings
    .getByRole("textbox", { name: /New name for Clawtrate old laptop/ })
    .fill("Old laptop");
  await page.keyboard.press("Enter");
  await expect(list).toContainText("Old laptop", { timeout: 20_000 });
  const devices = await admin.request<{ paired: Json[] }>("device.pair.list", {});
  expect(devices.paired.find((d) => d.deviceId === gone.deviceId)?.operatorLabel).toBe(
    "Old laptop",
  );
  await shots(page, "machines-devices");
  await list
    .locator("div", { hasText: "Old laptop" })
    .last()
    .getByRole("button", { name: "Remove" })
    .click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("Asks the gateway to remove Old laptop's pairing.");
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirm.getByRole("button", { name: "Remove" }).click();
  await expect(settings.getByTestId("b-announcer")).toHaveText("Removed", { timeout: 20_000 });
  await expect(list).not.toContainText("Old laptop", { timeout: 20_000 });
  const after = await admin.request<{ paired: Json[] }>("device.pair.list", {});
  expect(after.paired.some((d) => d.deviceId === gone.deviceId)).toBe(false);
  await page.keyboard.press("Escape");
});

test("F-157: a read-only connection sees the machines, and paired devices and approvals files only say which access they need", async () => {
  const page = reader.page;
  const settings = await machines(page);
  await expect(settings.getByTestId("machine-list")).toContainText("media-box");
  await expect(settings.getByTestId("devices-unavailable")).toHaveText(
    "Seeing paired devices needs device access.",
  );
  await expect(settings.getByTestId("approvals-unavailable").first()).toHaveText(
    "Seeing a machine's approvals needs admin access.",
  );
  await expect(settings.getByRole("radiogroup")).toHaveCount(0);
  await expect(settings.getByRole("button", { name: "Rename" })).toHaveCount(0);
  await expect(settings.getByTestId("device-bar")).toContainText("This connection only reads.");
  await shots(page, "machines-read-only");
  await page.keyboard.press("Escape");
});
