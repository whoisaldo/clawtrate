// Service definitions that keep `clawtrate-connector run` going for the signed-in user: a macOS
// LaunchAgent and a systemd user unit. They are written as files for the person to load; the
// connector never runs launchctl or systemctl itself.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const LAUNCH_AGENT_LABEL = "dev.clawtrate.connector";
export const LAUNCH_AGENT_FILE = `${LAUNCH_AGENT_LABEL}.plist`;
export const SYSTEMD_UNIT_FILE = "clawtrate-connector.service";

export interface ServiceSpec {
  /** The Node binary, absolute. */
  readonly node: string;
  /** The connector's command line script, absolute. */
  readonly cli: string;
  /** The state folder, absolute. */
  readonly stateDir: string;
}

function checkSpec(spec: ServiceSpec): void {
  for (const [name, value] of Object.entries(spec)) {
    if (!value.startsWith("/")) throw new Error(`${name} must be an absolute path`);
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${name} holds a control character`);
  }
}

function programArguments(spec: ServiceSpec): string[] {
  return [spec.node, spec.cli, "run", "--state-dir", spec.stateDir];
}

function xml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * A LaunchAgent: started at login, restarted when it exits, at most every 10 seconds, with its
 * output in the state folder.
 */
export function launchAgentPlist(spec: ServiceSpec): string {
  checkSpec(spec);
  const args = programArguments(spec)
    .map((arg) => `    <string>${xml(arg)}</string>`)
    .join("\n");
  const log = xml(join(spec.stateDir, "connector.log"));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;
}

/** One systemd argument: quoted, with `\`, `"`, `%` and `$` escaped as systemd reads them. */
function systemdArg(arg: string): string {
  const escaped = arg
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", "$$$$");
  return `"${escaped}"`;
}

/** A systemd user unit: started with the user's session, restarted when it fails. */
export function systemdUserUnit(spec: ServiceSpec): string {
  checkSpec(spec);
  return `[Unit]
Description=Clawtrate connector (relay access to this computer's OpenClaw gateway)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${programArguments(spec).map(systemdArg).join(" ")}
Restart=on-failure
RestartSec=10
UMask=0077
NoNewPrivileges=yes

[Install]
WantedBy=default.target
`;
}

export interface WrittenService {
  readonly launchAgent: string;
  readonly systemdUnit: string;
}

/** Writes both files into `dir`, which must exist. */
export function writeServiceFiles(dir: string, spec: ServiceSpec): WrittenService {
  const launchAgent = join(dir, LAUNCH_AGENT_FILE);
  const systemdUnit = join(dir, SYSTEMD_UNIT_FILE);
  writeFileSync(launchAgent, launchAgentPlist(spec), { mode: 0o600 });
  writeFileSync(systemdUnit, systemdUserUnit(spec), { mode: 0o600 });
  return { launchAgent, systemdUnit };
}

/** What the person runs to load the service. Printed, never run. */
export function serviceInstructions(written: WrittenService): string[] {
  return [
    "To keep the connector running on macOS:",
    `  cp '${written.launchAgent}' ~/Library/LaunchAgents/ && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${LAUNCH_AGENT_FILE}`,
    "On Linux with systemd:",
    `  mkdir -p ~/.config/systemd/user && cp '${written.systemdUnit}' ~/.config/systemd/user/ && systemctl --user enable --now ${SYSTEMD_UNIT_FILE}`,
  ];
}
