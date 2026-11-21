// The service definitions, checked as text. They are written into a temporary folder and
// never loaded: nothing here runs launchctl or systemctl.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LAUNCH_AGENT_FILE,
  LAUNCH_AGENT_LABEL,
  launchAgentPlist,
  serviceInstructions,
  SYSTEMD_UNIT_FILE,
  systemdUserUnit,
  writeServiceFiles,
} from "../src/service.ts";
import { tempRoot } from "./helpers.ts";

const SPEC = {
  node: "/opt/node/bin/node",
  cli: "/opt/clawtrate/packages/connector/src/cli.ts",
  stateDir: "/var/lib/clawtrate connector & co",
};

let root: string;
let cleanup: () => void;
beforeEach(() => ({ root, cleanup } = tempRoot()));
afterEach(() => cleanup());

describe("the LaunchAgent", () => {
  it("runs `run --state-dir` at login, keeps it alive, and logs into the state folder", () => {
    const plist = launchAgentPlist(SPEC);
    expect(plist).toContain(`<key>Label</key>\n  <string>${LAUNCH_AGENT_LABEL}</string>`);
    expect(plist).toContain(
      [
        "  <key>ProgramArguments</key>",
        "  <array>",
        "    <string>/opt/node/bin/node</string>",
        "    <string>/opt/clawtrate/packages/connector/src/cli.ts</string>",
        "    <string>run</string>",
        "    <string>--state-dir</string>",
        "    <string>/var/lib/clawtrate connector &amp; co</string>",
        "  </array>",
      ].join("\n"),
    );
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).toContain("<key>ThrottleInterval</key>\n  <integer>10</integer>");
    // 63 is 077: files the connector makes are its owner's alone.
    expect(plist).toContain("<key>Umask</key>\n  <integer>63</integer>");
    expect(plist).toContain("<string>/var/lib/clawtrate connector &amp; co/connector.log</string>");
    expect(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist')).toBe(true);
    expect(plist).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });
});

describe("the systemd user unit", () => {
  it("runs `run --state-dir`, restarts on failure, and is enabled for the user's session", () => {
    const unit = systemdUserUnit(SPEC);
    expect(unit).toContain(
      'ExecStart="/opt/node/bin/node" "/opt/clawtrate/packages/connector/src/cli.ts" "run" "--state-dir" "/var/lib/clawtrate connector & co"\n',
    );
    expect(unit).toContain("[Service]\nType=simple\n");
    expect(unit).toContain("Restart=on-failure\nRestartSec=10\n");
    expect(unit).toContain("UMask=0077\n");
    expect(unit).toContain("NoNewPrivileges=yes\n");
    expect(unit).toContain("[Install]\nWantedBy=default.target\n");
    expect(unit).toContain("After=network-online.target\nWants=network-online.target\n");
  });

  it("escapes what systemd would expand", () => {
    const unit = systemdUserUnit({ ...SPEC, stateDir: '/srv/c/100%"$HOME"\\x' });
    expect(unit).toContain('"/srv/c/100%%\\"$$HOME\\"\\\\x"');
  });
});

describe("both", () => {
  it("refuse a relative path or a control character", () => {
    expect(() => launchAgentPlist({ ...SPEC, cli: "cli.ts" })).toThrow(/absolute/);
    expect(() => systemdUserUnit({ ...SPEC, stateDir: "/a\nExecStartPre=/bin/sh" })).toThrow(
      /control/,
    );
  });

  it("are written as files, owner-only, with instructions that are printed and never run", () => {
    const written = writeServiceFiles(root, SPEC);
    expect(written).toEqual({
      launchAgent: join(root, LAUNCH_AGENT_FILE),
      systemdUnit: join(root, SYSTEMD_UNIT_FILE),
    });
    expect(readFileSync(written.launchAgent, "utf8")).toBe(launchAgentPlist(SPEC));
    expect(readFileSync(written.systemdUnit, "utf8")).toBe(systemdUserUnit(SPEC));
    expect(statSync(written.launchAgent).mode & 0o777).toBe(0o600);
    const lines = serviceInstructions(written).join("\n");
    expect(lines).toContain("launchctl bootstrap gui/$(id -u)");
    expect(lines).toContain(`systemctl --user enable --now ${SYSTEMD_UNIT_FILE}`);
  });
});
