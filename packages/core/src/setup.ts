// Setting up on this computer (docs/design/setup.md §3 to §7): what the
// host's look found and where the setup stands, as plain data for the
// interface. The host fills it (apps/desktop/src/setup); nothing in it is a
// credential, a raw program output or a path the host runs.

/** The OpenClaw version this build is tested against (`docs/decisions.md`). */
export const TESTED_OPENCLAW_VERSION = "2026.10.6";

/** The gateway protocol the pinned client speaks, for a host's synthetic gateway. */
export { PROTOCOL_VERSION as GATEWAY_PROTOCOL } from "@openclaw/gateway-client/browser";

/** Below this version Clawtrate doesn't offer automatic setup: Clawtrate's choice. */
export const OLDEST_OPENCLAW_VERSION = "2026.7.0";

/**
 * What the look found (§4, §6). `running` is a found gateway of the tested
 * version; `untested` and `too-old` are found gateways of another version;
 * `stopped` is a program and its gateway's config with nothing listening.
 */
export type LookOutcome =
  | "running"
  | "untested"
  | "too-old"
  | "not-token"
  | "stopped"
  | "program-missing"
  | "cant-tell"
  /** The program was found but couldn't be started. */
  | "cant-run"
  | "not-found"
  | "windows";

/** Why the look couldn't tell, each shown in fixed copy. */
export type CantTellReason =
  | "timeout"
  | "shape"
  | "no-answer"
  | "not-set-up"
  /** The status probed, or its RPC answered, somewhere other than this computer's loopback on the gateway's port. */
  | "endpoint"
  /**
   * The installed OpenClaw has no command Clawtrate has verified as read-only:
   * its launcher may repair its own installation before any command runs, so
   * the look runs nothing (docs/decisions.md, "What the look runs").
   */
  | "read-only";

/** The gateway's service, as the status reports it for this gateway. `none`: it reports no matching unit. */
export type LookService =
  "launchagent" | "launchagent-stopped" | "systemd" | "systemd-stopped" | "none";

export type SetupLook = {
  outcome: LookOutcome;
  reason: CantTellReason | null;
  /** The running gateway's version, or the program's when nothing runs. */
  version: string | null;
  /** The profile's name: `default`, `clawtrate`, or a development instance's. */
  profile: string | null;
  /** The configured bind the status reported: `loopback` or `lan`; anything else is not reported. */
  listens: "loopback" | "lan" | null;
  service: LookService | null;
  port: number | null;
  /** For `not-token`: the gateway's other sign-in. */
  authMode: "password" | "none" | "trusted-proxy" | null;
  /** Whether this device has a saved pairing for that address: `new` when it hasn't. */
  access: "new" | "paired" | null;
  /** Other OpenClaw services and profiles the look saw, named and never used. */
  others: string[];
};

/** Where Connect, or the look, failed (§7), each in fixed copy. */
export type SetupFailureKind =
  /** `openclaw qr` didn't make a code; `exitCode` says how it ended. */
  | "code-failed"
  /** The gateway refused the one-time code (`AUTH_BOOTSTRAP_TOKEN_INVALID`). */
  | "code-refused"
  /** The gateway granted another role or other scopes than exactly read. */
  | "grant"
  /** Nothing answered on the gateway's port. */
  | "unreachable"
  /** The facts changed between the host's dialog and its answer, or the dialog expired. */
  | "changed"
  /** This host can't confirm a pairing (the web preview). */
  | "no-dialog"
  /** The look refused to run here (`docs/development/setup.md`); `reason` says why. */
  | "refused"
  /** Connected, but the bots couldn't be read. */
  | "bots"
  /** Back couldn't close the connection setup opened; Back tries again. */
  | "cleanup"
  /** The connection failed in another way; the connection state says how. */
  | "other";

/**
 * Why a run that must look in a sandbox couldn't (`docs/development/setup.md`):
 * it was given none; its description's place or shape; its home and working
 * folder; its development instance's state, ownership or config; or a pairing
 * its scenario doesn't offer.
 */
export type SetupRefusal = "missing" | "file" | "home" | "state" | "pairing";

export type SetupFailure = {
  kind: SetupFailureKind;
  exitCode: number | null;
  port: number | null;
  /** For `refused`: what was refused. */
  reason: SetupRefusal | null;
};

export type SetupPhase =
  /** Nothing under way: the first screen. */
  | "idle"
  | "looking"
  /** The look's result is shown. */
  | "found"
  /** The host's dialog is open. */
  | "confirming"
  | "connecting"
  /** Connected through setup: the app takes over. */
  | "done"
  | "failed";

export type SetupState = {
  phase: SetupPhase;
  /** The step under way while looking or connecting, from 0. */
  step: number;
  /** Set after 8 s of looking (§4). */
  slow: boolean;
  look: SetupLook | null;
  failure: SetupFailure | null;
};

export const initialSetupState: SetupState = {
  phase: "idle",
  step: 0,
  slow: false,
  look: null,
  failure: null,
};

/** Names of other services or profiles the look keeps, and their length. */
export const MAX_LOOK_OTHERS = 5;
export const MAX_LOOK_OTHER_CHARS = 96;

/** What a host that sets up on its own computer offers its viewers (`BridgePolicy.setup`). */
export type SetupHost = {
  /** Start the look on this computer, ending one under way. */
  look(): Promise<void>;
  /** End the look or the connect under way; the host ends its programs by PID. */
  cancel(): void;
  /**
   * Ask the host to pair with what the last look found. The host shows its own
   * dialog and runs nothing unless that dialog's answer is yes.
   */
  connect(): Promise<void>;
  /** Back to the first screen. */
  reset(): void;
};

/**
 * Whether the screens of setup are offered, and which: `look` runs on the
 * host's computer, `pair` needs a native dialog of the host's.
 */
export type SetupOffer = { look: boolean; pair: boolean; platform: string };
