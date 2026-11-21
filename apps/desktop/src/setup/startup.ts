// What a host starts on, chosen from how setup resolved before anything else
// runs (docs/development/setup.md): its data folder, whether it may reach a
// development gateway, and whether it reopens a saved gateway. A sandboxed or
// refused start never resolves the development gateway, the ordinary data
// folder or a saved connection: a sandbox keeps its data in its own checked
// `app-data`, a refused or automated Windows start in the folder its launch named with
// `--user-data-dir`, or else in a fresh private temporary folder.

import type { DevGatewayConnection } from "../host/runtime.ts";
import type { SetupLaunch } from "./sandbox.ts";
import type { SetupLookChoice } from "../web-host/setup-look.ts";

export type DesktopStartup = {
  /** The data folder to use instead of the ordinary one, set before the single-instance lock. */
  userData: string | null;
  devGateway: DevGatewayConnection | null;
  autoConnectDev: boolean;
  resume: boolean;
};

export function desktopStartup(
  launch: SetupLaunch,
  options: {
    packaged: boolean;
    /** The development gateway, read only for a development build that isn't sandboxed. */
    devConnection: () => DevGatewayConnection | null;
    autoConnectDev: () => boolean;
    /** The data folder the launch itself named (`--user-data-dir`), kept when setup is unavailable. */
    launchData: () => string | null;
    /** A fresh private temporary folder, when an isolated launch named none. */
    privateData: () => string;
  },
): DesktopStartup {
  const sealed = { devGateway: null, autoConnectDev: false, resume: false } as const;
  switch (launch.kind) {
    case "sandbox":
      return { userData: launch.sandbox.appData, ...sealed };
    case "refused":
    case "windows":
      return { userData: options.launchData() ?? options.privateData(), ...sealed };
    case "production":
      return {
        userData: null,
        devGateway: options.packaged ? null : options.devConnection(),
        autoConnectDev: !options.packaged && options.autoConnectDev(),
        resume: true,
      };
  }
}

export type WebStartup = {
  dataDir: string;
  devGateway: DevGatewayConnection | null;
  autoConnectDev: boolean;
  resume: boolean;
};

/** The web host's start, once `--setup-look` is decided: the setup look gets none of the rest. */
export function webStartup(
  setupLook: Exclude<SetupLookChoice, { kind: "refused" }>,
  options: {
    devConnection: () => DevGatewayConnection | null;
    dataDir: () => string;
    autoConnectDev: boolean;
  },
): WebStartup {
  if (setupLook.kind === "sandbox")
    return { dataDir: setupLook.dataDir, devGateway: null, autoConnectDev: false, resume: false };
  const devGateway = options.devConnection();
  return {
    dataDir: options.dataDir(),
    devGateway,
    autoConnectDev: options.autoConnectDev,
    resume: true,
  };
}
