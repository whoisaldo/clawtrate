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
  /** Over SSH: the status results disagree, or say too little to tell running from stopped. */
  | "contradictory";

/** The gateway's service, as the status reports it for this gateway. `none`: it reports no matching unit. */
export type LookService =
  | "launchagent"
  | "launchagent-stopped"
  | "systemd"
  | "systemd-stopped"
  /** The status named a systemd user unit. */
  | "systemd-user"
  | "systemd-user-stopped"
  | "none";

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
  /** Over SSH: the gateway answered with another identity than the route's. */
  | "identity"
  /** Over SSH: the gateway's identity couldn't be read after its hello. */
  | "identity-unread"
  /** Over SSH: the route's saved token is gone or was refused; a new pairing is needed. */
  | "pairing-gone"
  /**
   * After the owner approved a first pairing, the read-back or the reconnect
   * showed anything but the operator role and exactly read, or couldn't be
   * read (§9): disconnected, nothing saved.
   */
  | "approval-unconfirmed"
  /** After an approval, the identity read is a different gateway's (§9). */
  | "approval-identity"
  /** After an approval, the gateway's identity couldn't be read (§9). */
  | "approval-identity-unread"
  /** The person chose Stop waiting on the pairing screen (§9): the request stays on the gateway. */
  | "stopped"
  /** Connected, but the bots couldn't be read. */
  | "bots"
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
  /** Over SSH: a first contact's key, or a changed key, waits for the person (§5). */
  | "key"
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
  /** Another computer over SSH (§5), while setup is there; absent on this computer. */
  there?: SshSetup | null;
  /** The SSH route the app is connected through, for the status strip and Settings (§8). */
  route?: RouteStatus | null;
};

export const initialSetupState: SetupState = {
  phase: "idle",
  step: 0,
  slow: false,
  look: null,
  failure: null,
};

/** Why an SSH destination's settings were refused, by name (§5). */
export type SshRefusalCategory =
  "jump-host" | "command-or-forward" | "host-key" | "unsupported" | "invalid-value" | "unreadable";

/** What `ssh` and the host found that ended a step over SSH (§5, §7, §8), in fixed copy. */
export type SshFailureKind =
  | "unreachable"
  | "sign-in-refused"
  | "ssh-stopped"
  | "timed-out"
  | "spawn-failed"
  /** This computer's `ssh` can't be used (missing, too old, an unknown system). */
  | "not-supported"
  /** The host couldn't establish that its own SSH files are private: Advanced. */
  | "app-files-unsafe"
  | "forwarding-refused"
  | "gateway-not-answering"
  /** The forward's LOOK found the gateway's service proven stopped (`provenStopped`). */
  | "gateway-stopped"
  /** The forward's LOOK found another service at the gateway's port than the card named. */
  | "service-changed"
  /** The forward's LOOK couldn't tell what answers at the gateway's port. */
  | "service-cant-tell"
  /** The key presented when the forward opened isn't the pinned one. */
  | "key-changed"
  /** This computer can't keep a route's device token encrypted: no pairing over SSH. */
  | "no-token-storage"
  /** The one-time code wasn't made on that computer; `exit` is OpenClaw's. */
  | "code-failed"
  /** Remove couldn't delete the route's pinned key: nothing else was forgotten. */
  | "remove-failed"
  /** OpenClaw's start command ran and exited with an error (`exit`). */
  | "start-failed"
  /** The start command didn't run there: its program was no longer the one the look named. */
  | "start-not-run"
  /** The start command ran, and Clawtrate couldn't establish afterwards that the gateway runs. */
  | "start-unconfirmed";

export type UnreachableWords =
  "connection refused" | "no such name" | "timed out" | "network unreachable";

/** A host key as the person sees it: its type and fingerprint, never its bytes. */
export type ShownHostKey = { label: string; fingerprint: string };

/**
 * Another computer, as far as the host established it. Every string is the
 * host's: the account, host and port as resolved from the person's SSH
 * configuration, and fixed copy naming them.
 */
export type SshSetup = {
  /** What was typed, once it matched the destination pattern; kept for Back. */
  destination: string;
  /** "you@devbox.example", once resolved. */
  account: string | null;
  /** The name typed, without the user: "devbox". */
  name: string | null;
  /** The SSH port, once resolved. */
  port: number | null;
  /** What was typed isn't a destination Clawtrate can use. */
  invalid: boolean;
  /** The person's settings for that name were refused: the setting and the engine's fixed note. */
  refusal: {
    category: SshRefusalCategory;
    setting: string;
    title: string;
    sentence: string;
  } | null;
  /** First contact, or a changed key, waiting for the person (§5). */
  key: {
    state: "first-contact" | "changed";
    presented: ShownHostKey;
    trusted: (ShownHostKey & { pinnedAt: string }) | null;
  } | null;
  failure: { kind: SshFailureKind; cause: UnreachableWords | null; exit: number | null } | null;
  /** At launch: the saved route is being opened again with its saved token, no new pairing. */
  resume?: boolean;
  /**
   * Something the screen says beside its usual words: Replace stopped with
   * its box unticked, so nothing was replaced; or, at launch, the saved
   * route's name now resolves to another account, host or port.
   */
  notice?: "replace-unticked" | "endpoint-changed" | null;
};

/** Where the app's SSH route stands (§8): the status strip's words come from it. */
export type RouteStatus = {
  /** The name typed for that computer: "devbox". */
  name: string;
  /** The full account, as resolved: "you@devbox.example". */
  account: string;
  /** Its SSH port. */
  port: number;
  phase:
    | "up"
    /** The forward dropped, or is up again and the gateway hasn't answered as itself yet. */
    | "restoring"
    /** Back after a drop, the gateway's identity read again: said for a moment. */
    | "restored"
    /** Two minutes without the forward. */
    | "unreachable"
    | "key-changed"
    /** The LOOK found another service at the gateway's port, before any identity was read. */
    | "service-changed"
    /** The gateway answered with another identity than the route's. */
    | "different-gateway"
    /** The forward stays up and the LOOK reports the service stopped. */
    | "stopped"
    /** The route couldn't be restored for a reason other than reaching the computer. */
    | "failed"
    /** The person chose Disconnect: the route is kept, and only Reconnect opens it again. */
    | "disconnected";
  /** For `unreachable`: the cause in brackets, as section 5 words it. */
  cause: UnreachableWords | null;
  profile: "default" | "clawtrate";
  /** Whether "Retry now" does something now: only while the forward waits for its next try. */
  retry: boolean;
};

/**
 * Where the gateway's owner approves a request (§9): this computer, or the
 * SSH route's account and port, and the profile, for the approve command.
 * "Approve from here" (F-500) plugs in on the same place: it is offered only
 * where a place is known.
 */
export type ApprovalPlace =
  | { route: "this-computer"; profile: "default" | "clawtrate" }
  | {
      route: "ssh";
      /** The name typed, without the user, as the words name the computer: "devbox". */
      name?: string;
      /** The route's full account, as resolved: "you@devbox.example". */
      account: string;
      /** Its SSH port. */
      port: number;
      profile: "default" | "clawtrate";
    };

/** A gateway's pairing request id, as OpenClaw makes them: a UUID. Anything else is never put in a command. */
export const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The waiting state's words and command for a place (§9, "The waiting
 * state"): where the request waits, the selected profile by name, and the
 * approve command for exactly the request id this client holds. Only a
 * request id of the gateway's shape is put in the command; without one, the
 * command lists the pending devices and the line says to match this device's
 * id. The profile is one of two fixed names, never text from elsewhere.
 */
export function approvalForPlace(
  place: ApprovalPlace,
  requestId: string,
): { command: string; note: string; title: string; where: string } {
  const profileArgs = place.profile === "clawtrate" ? "--profile clawtrate " : "";
  const profile = place.profile === "clawtrate" ? "Clawtrate's profile" : "the default profile";
  const known = REQUEST_ID.test(requestId);
  const command = known
    ? `openclaw ${profileArgs}devices approve ${requestId}`
    : `openclaw ${profileArgs}devices list`;
  const there =
    place.route === "this-computer"
      ? { where: "this computer", on: "In Terminal on this computer" }
      : {
          where: place.name || place.account,
          on: `On ${place.account} (SSH port ${place.port})`,
        };
  return {
    command,
    title: `Waiting for approval on ${there.where}.`,
    where: there.where,
    note: known
      ? `${there.on}, run this for ${profile}:`
      : `${there.on}, list pending devices for ${profile} and match this device ID before you approve.`,
  };
}

/** An SSH destination, account or name: a user of 64 and a host of 253, an `@` and a margin. */
export const MAX_DESTINATION_CHARS = 320;
/** A fingerprint as shown: `SHA256:` and 43 base64 characters. */
export const MAX_FINGERPRINT_CHARS = 64;
/** The host's fixed note for a refused SSH setting, naming the host twice. */
export const MAX_SSH_NOTE_CHARS = 1_024;

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
  /**
   * Another computer (§5): look there for what was typed. The host resolves
   * it, refuses it by name, or asks its own dialog for the account first.
   */
  there?(destination: string): Promise<void>;
  /**
   * Review and Look again after an approval for a gateway set up on this
   * computer (§9): the look for the connection's saved profile alone,
   * checking that its gateway is still at the saved address.
   */
  reviewHere?(): Promise<void>;
  /** Trust the key first contact captured, after the host's own dialog. */
  trustKey?(): Promise<void>;
  /** Replace a changed key, after the host's dialog and its checkbox. */
  replaceKey?(): Promise<void>;
  /** Start OpenClaw there when the look proved it stopped, after the host's dialog. */
  start?(): Promise<void>;
  /** The status strip's "Retry now": restore the route's forward at once. */
  retryRoute?(): Promise<void>;
  /**
   * Settings, Gateway, "Remove this gateway…", or the same on a route that
   * couldn't be restored, after the host's dialog: local only.
   */
  removeRoute?(): Promise<void>;
};

/**
 * Whether the screens of setup are offered, and which: `look` runs on the
 * host's computer, `pair` needs a native dialog of the host's.
 */
export type SetupOffer = {
  look: boolean;
  pair: boolean;
  platform: string;
  /** Another computer over SSH is offered (§5): the host can confirm and has a transport. */
  ssh?: boolean;
};
