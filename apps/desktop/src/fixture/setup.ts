// Setting up on this computer, in the fixture (docs/design/setup.md §3 to
// §7): `?setup=<state>` shows the desktop's first screen and what the host
// reports at each step, and the setup commands move through the walk the way
// the host would. Nothing here looks at a computer or makes a code.

import {
  initialSetupState,
  type BridgeCommand,
  type ClawtrateState,
  type HostInfo,
  type RouteStatus,
  type SetupLook,
  type SetupState,
  type SshSetup,
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

/** Another computer (§5): devbox, as the person's SSH configuration resolves it. */
const devbox: SshSetup = {
  destination: "devbox",
  account: "you@devbox.example",
  name: "devbox",
  port: 22,
  invalid: false,
  refusal: null,
  key: null,
  failure: null,
};
const PRESENTED = {
  label: "ED25519",
  fingerprint: "SHA256:Q3v8Lw0eXk2Rj9TaNf5Hc1UbYm7Pd4GsZi6Ko2EaVr8",
};
const TRUSTED = {
  label: "ED25519",
  fingerprint: "SHA256:k4Pq9Zs1Nb7Xc3Vr8Lm2Tw6Yh5Gd0Fj1Ae9Ou4Ri7Kx",
  pinnedAt: "2026-10-02T09:12:00.000Z",
};
const there = (patch: Partial<SetupState>, at: Partial<SshSetup> = {}): SetupState => ({
  ...initialSetupState,
  ...patch,
  there: { ...devbox, ...at },
});
const thereFound = (look: Partial<SetupLook> = {}) =>
  there({ phase: "found", look: { ...running, ...look } });
const thereFailed = (failure: NonNullable<SshSetup["failure"]>, look: SetupLook | null = null) =>
  there({ phase: "failed", look }, { failure });
/** The app's SSH route, as the status strip and Settings read it (§8). */
const route = (phase: RouteStatus["phase"], patch: Partial<RouteStatus> = {}): RouteStatus => ({
  name: "devbox",
  account: "you@devbox.example",
  port: 22,
  phase,
  cause: null,
  profile: "default",
  // A forward waiting for its next try: Retry acts.
  retry: phase === "restoring" || phase === "unreachable",
  ...patch,
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
  "code-failed-shape": failed("code-failed", { exitCode: 0 }),
  // Another computer over SSH.
  there: there({}, { destination: "" }),
  "there-invalid": there(
    {},
    { destination: "-oProxyCommand=x", account: null, name: null, port: null, invalid: true },
  ),
  "there-refused": there(
    {},
    {
      account: null,
      port: null,
      refusal: {
        category: "jump-host",
        setting: "ProxyJump",
        title: "The SSH settings for devbox include ProxyJump.",
        sentence:
          "Clawtrate doesn't connect through another computer. Use a plain SSH alias or Advanced.",
      },
    },
  ),
  "there-looking": there({ phase: "looking", step: 1 }),
  "there-hostkey": there(
    { phase: "key" },
    { key: { state: "first-contact", presented: PRESENTED, trusted: null } },
  ),
  "there-changed": there(
    { phase: "key" },
    { key: { state: "changed", presented: PRESENTED, trusted: TRUSTED } },
  ),
  "there-found": thereFound(),
  "there-found-paired": thereFound({ access: "paired" }),
  "there-stopped": thereFound({ outcome: "stopped", service: "launchagent-stopped" }),
  "there-not-found": thereFound({
    outcome: "not-found",
    version: null,
    profile: null,
    listens: null,
    service: null,
  }),
  "there-connecting": there({ phase: "connecting", step: 1, look: running }),
  "there-starting": there({
    phase: "connecting",
    step: 0,
    look: { ...running, outcome: "stopped", service: "launchagent-stopped" },
  }),
  "there-unreachable": thereFailed({ kind: "unreachable", cause: "connection refused", exit: 255 }),
  "there-sign-in": thereFailed({ kind: "sign-in-refused", cause: null, exit: 255 }),
  "there-code-failed": thereFailed({ kind: "code-failed", cause: null, exit: 1 }, running),
  "there-app-files": thereFailed({ kind: "app-files-unsafe", cause: null, exit: null }),
  "there-contradictory": thereFound({
    outcome: "cant-tell",
    reason: "contradictory",
    version: null,
    profile: null,
    listens: null,
    service: null,
  }),
  // At launch: the saved route opened again with its token, and the same route when it couldn't be.
  "there-resume": {
    ...there({ phase: "connecting", step: 1 }, { resume: true }),
    route: route("restoring"),
  },
  "there-resume-failed": {
    ...thereFailed({ kind: "unreachable", cause: "timed out", exit: 255 }),
    route: route("unreachable"),
  },
  // At launch, the saved route's settings refused by name, or its name leading elsewhere: Remove stays.
  "there-resume-refused": {
    ...there(
      {},
      {
        refusal: {
          category: "jump-host",
          setting: "ProxyJump",
          title: "The SSH settings for devbox include ProxyJump.",
          sentence:
            "Clawtrate doesn't connect through another computer. Use a plain SSH alias or Advanced.",
        },
      },
    ),
    route: route("failed"),
  },
  "there-endpoint-changed": {
    ...there({}, { notice: "endpoint-changed" }),
    route: route("failed"),
  },
  // Replace pressed with its box unticked: nothing replaced, said beside the two keys.
  "there-replace-unticked": there(
    { phase: "key" },
    {
      key: { state: "changed", presented: PRESENTED, trusted: TRUSTED },
      notice: "replace-unticked",
    },
  ),
  // A first forward's own LOOK found the service stopped, or another service at the port.
  "there-gateway-stopped": thereFailed(
    { kind: "gateway-stopped", cause: null, exit: null },
    running,
  ),
  "there-service-changed": thereFailed(
    { kind: "service-changed", cause: null, exit: null },
    running,
  ),
  // Start: refused before its command ran, or ran and not confirmed.
  "there-start-not-run": thereFailed(
    { kind: "start-not-run", cause: null, exit: null },
    { ...running, outcome: "stopped", service: "launchagent-stopped" },
  ),
  "there-start-unconfirmed": thereFailed(
    { kind: "start-unconfirmed", cause: null, exit: null },
    { ...running, outcome: "stopped", service: "launchagent-stopped" },
  ),
  // Remove couldn't delete the saved key: the route stays, and Remove is offered again.
  "there-remove-failed": {
    ...thereFailed({ kind: "remove-failed", cause: null, exit: null }),
    route: route("failed"),
  },
  // The SSH route in the app: the status strip's words, and Settings' Remove (§8).
  "route-restoring": { ...initialSetupState, route: route("restoring") },
  /** Restoring, the forward up and the gateway not yet said who it is: no Retry. */
  "route-restoring-identity": {
    ...initialSetupState,
    route: route("restoring", { retry: false }),
  },
  "route-restored": { ...initialSetupState, route: route("restored") },
  "route-unreachable": {
    ...initialSetupState,
    route: route("unreachable", { cause: "timed out" }),
  },
  "route-key-changed": { ...initialSetupState, route: route("key-changed") },
  "route-failed": { ...initialSetupState, route: route("failed") },
  "route-different": { ...initialSetupState, route: route("different-gateway") },
  "route-up": { ...initialSetupState, route: route("up") },
};

/** A route state shows the app itself, with its strip: the main scene, not the first screen. */
export const isRouteState = (name: string | null) => name !== null && name.startsWith("route-");

export function isSetupState(name: string | null): name is string {
  return name !== null && Object.hasOwn(SETUP_STATES, name);
}

/** The desktop host, offering setup; `windows` is the same app on Windows. */
export function setupInfo(info: HostInfo, name: string): HostInfo {
  return {
    ...info,
    kind: "desktop",
    devGateway: null,
    setup: {
      look: true,
      pair: true,
      platform: name === "windows" ? "win32" : "darwin",
      ssh: true,
    },
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
    case "setupThere": {
      const typed = command.destination.trim();
      if (!/^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,63}@)?[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(typed)) {
        setup(
          there({}, { destination: typed, account: null, name: null, port: null, invalid: true }),
        );
        return true;
      }
      // The fixture has no native dialog: the account is taken as confirmed.
      setup(there({ phase: "looking", step: 0 }, { destination: typed }));
      after(300, () => current().phase === "looking" && setup({ ...current(), step: 1 }));
      after(
        600,
        () =>
          current().phase === "looking" && setup({ ...current(), phase: "found", look: running }),
      );
      return true;
    }
    case "setupTrustKey":
    case "setupReplaceKey":
      setup({ ...current(), phase: "found", look: running, there: { ...devbox } });
      return true;
    case "setupStart":
      setup({ ...current(), phase: "connecting", step: 0 });
      // Only the Start still under way ends on the running card; Back or Reset end it here.
      after(
        600,
        () =>
          current().phase === "connecting" &&
          setup({ ...current(), phase: "found", look: running }),
      );
      return true;
    case "setupRetryRoute":
    case "setupRemoveRoute":
      return true;
    default:
      return false;
  }
}
