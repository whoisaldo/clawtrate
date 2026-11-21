// Setting up on this computer, in the fixture (docs/design/setup.md §3 to
// §7): `?setup=<state>` shows the desktop's first screen and what the host
// reports at each step, and the setup commands move through the walk the way
// the host would. Nothing here looks at a computer or makes a code.

import {
  initialSetupState,
  type BridgeCommand,
  type ClawtrateState,
  type HostInfo,
  type SetupLook,
  type SetupState,
} from "@clawtrate/core";

const running: SetupLook = {
  outcome: "running",
  reason: null,
  version: "2026.10.6",
  profile: "default",
  listens: "loopback",
  service: "launchagent",
  port: 18789,
  authMode: null,
  access: "new",
  others: [],
};

const looked = (look: Partial<SetupLook>): SetupState => ({
  ...initialSetupState,
  phase: "found",
  look: { ...running, ...look },
});

const failed = (kind: NonNullable<SetupState["failure"]>["kind"], extra = {}): SetupState => ({
  ...initialSetupState,
  phase: "failed",
  look: running,
  failure: { kind, exitCode: null, port: null, reason: null, ...extra },
});

/** Every setup state the fixture shows, by the name used in `?setup=`. */
export const SETUP_STATES: Record<string, SetupState> = {
  first: initialSetupState,
  looking: { ...initialSetupState, phase: "looking", step: 1 },
  "looking-slow": { ...initialSetupState, phase: "looking", step: 2, slow: true },
  found: looked({}),
  "found-others": looked({ others: ["service com.example.openclaw-gateway", "profile work"] }),
  confirming: { ...looked({}), phase: "confirming" },
  untested: looked({ outcome: "untested", version: "2026.9.37" }),
  "too-old": looked({ outcome: "too-old", version: "2026.6.2" }),
  stopped: looked({ outcome: "stopped", service: "launchagent-stopped" }),
  "stopped-by-hand": looked({ outcome: "stopped", service: "none" }),
  "program-missing": looked({ outcome: "program-missing" }),
  "cant-tell": looked({ outcome: "cant-tell", reason: "timeout" }),
  "cant-tell-shape": looked({ outcome: "cant-tell", reason: "shape" }),
  "not-token": looked({ outcome: "not-token", authMode: "password" }),
  "not-found": looked({ outcome: "not-found" }),
  windows: looked({ outcome: "windows" }),
  connecting: { ...looked({}), phase: "connecting", step: 1 },
  "code-failed": failed("code-failed", { exitCode: 1 }),
  "code-refused": failed("code-refused"),
  grant: failed("grant"),
  unreachable: failed("unreachable", { port: 18789 }),
  changed: failed("changed"),
  refused: {
    ...initialSetupState,
    phase: "failed",
    failure: { kind: "refused", exitCode: null, port: null, reason: "file" },
  },
  "refused-home": {
    ...initialSetupState,
    phase: "failed",
    failure: { kind: "refused", exitCode: null, port: null, reason: "home" },
  },
  "refused-state": {
    ...initialSetupState,
    phase: "failed",
    failure: { kind: "refused", exitCode: null, port: null, reason: "state" },
  },
  "refused-missing": {
    ...initialSetupState,
    phase: "failed",
    failure: { kind: "refused", exitCode: null, port: null, reason: "missing" },
  },
  "found-paired": looked({ access: "paired" }),
  "found-not-reported": looked({ listens: null, service: null }),
  "cant-run": looked({ outcome: "cant-run", version: null, profile: null }),
  endpoint: looked({ outcome: "cant-tell", reason: "endpoint" }),
  bots: failed("bots", { port: 18789 }),
  "found-profile-only": looked({ others: ["profile work"] }),
  /** A found gateway whose Connect ends in the handshake's protocol mismatch. */
  "found-protocol": looked({}),
  "cant-tell-not-set-up": looked({ outcome: "cant-tell", reason: "not-set-up" }),
  "cant-tell-no-answer": looked({ outcome: "cant-tell", reason: "no-answer" }),
  "cant-tell-read-only": looked({
    outcome: "cant-tell",
    reason: "read-only",
    version: "2026.10.6",
  }),
  "code-failed-shape": failed("code-failed", { exitCode: 0 }),
};

export function isSetupState(name: string | null): name is string {
  return name !== null && Object.hasOwn(SETUP_STATES, name);
}

/** The desktop host, offering setup; `windows` is the same app on Windows. */
export function setupInfo(info: HostInfo, name: string): HostInfo {
  return {
    ...info,
    kind: "desktop",
    devGateway: null,
    setup: { look: true, pair: true, platform: name === "windows" ? "win32" : "darwin" },
  };
}

/**
 * Each fixture's setup attempt, by its `set`: every setup command starts a new
 * one, and a delayed step of an earlier attempt does nothing.
 */
const attempts = new WeakMap<object, number>();

/**
 * The setup commands, answered as the host would: the look's steps, then
 * the running card; Connect's steps, then the app. The fixture has no
 * native dialog, so Connect goes straight to its steps.
 */
export function setupCommand(
  command: BridgeCommand,
  get: () => ClawtrateState,
  set: (state: ClawtrateState) => void,
  connected: () => ClawtrateState,
  later: (ms: number, run: () => void) => void,
  /** How Connect ends: the app opens, or the gateway refuses its protocol. */
  ending: "connected" | "protocol" = "connected",
): boolean {
  const setup = (next: SetupState) => set({ ...get(), setup: next });
  const current = () => get().setup ?? initialSetupState;
  if (!command.type.startsWith("setup")) return false;
  const attempt = (attempts.get(set) ?? 0) + 1;
  attempts.set(set, attempt);
  const after = (ms: number, run: () => void) =>
    later(ms, () => {
      if (attempts.get(set) === attempt) run();
    });
  switch (command.type) {
    case "setupLook": {
      setup({ ...initialSetupState, phase: "looking", step: 0 });
      after(300, () => current().phase === "looking" && setup({ ...current(), step: 1 }));
      after(600, () => current().phase === "looking" && setup({ ...current(), step: 2 }));
      after(900, () => current().phase === "looking" && setup(looked({})));
      return true;
    }
    case "setupConnect": {
      setup({ ...current(), phase: "connecting", step: 0, failure: null });
      after(300, () => current().phase === "connecting" && setup({ ...current(), step: 1 }));
      after(600, () => current().phase === "connecting" && setup({ ...current(), step: 2 }));
      after(900, () => {
        if (current().phase !== "connecting") return;
        if (ending === "protocol") {
          // As the client publishes a handshake refused for its protocol.
          const state = get();
          set({
            ...state,
            connection: {
              ...state.connection,
              status: "error",
              gatewayUrl: "ws://127.0.0.1:18789",
              retryAt: null,
              protocol: 5,
              error: {
                code: "PROTOCOL_MISMATCH",
                message:
                  "This gateway speaks protocol 5. This version of Clawtrate speaks protocol 4.",
                hint: null,
                protocol: { gateway: 5, client: 4 },
              },
            },
            setup: {
              ...current(),
              phase: "failed",
              failure: { kind: "other", exitCode: null, port: null, reason: null },
            },
          });
          return;
        }
        set({ ...connected(), setup: { ...current(), phase: "done" } });
      });
      return true;
    }
    case "setupCancel": {
      const { phase, look } = current();
      setup(
        phase === "looking" || !look
          ? initialSetupState
          : { ...initialSetupState, phase: "found", look },
      );
      return true;
    }
    case "setupReset":
      setup(initialSetupState);
      return true;
    default:
      return false;
  }
}
