// Setting up (docs/design/setup.md §3, §4, §6, §7): the first question,
// the look on this computer and what it found, and Connect. What the look
// found comes from the host (`state.setup`); every sentence here is fixed
// copy, and the only values in it are the facts the host checked.

import type {
  ConnectionState,
  HostInfo,
  LookService,
  SetupFailureKind,
  SetupLook,
  SetupRefusal,
  SetupState,
  ShownHostKey,
  SshSetup,
} from "@clawtrate/core";
import { APPROVAL_WORDS, OLDEST_OPENCLAW_VERSION, TESTED_OPENCLAW_VERSION } from "@clawtrate/core";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import logoUrl from "../assets/logo-mark.png";
import { useCommand } from "../bridge.tsx";
import { copyText, selectContents, type CopyResult } from "../clipboard.ts";
import { CommandLine, PRODUCT_NAME, SLOGAN } from "../ConnectScreen.tsx";
import {
  BackIcon,
  CheckIcon,
  ChevronIcon,
  ClockIcon,
  CloseIcon,
  CopyIcon,
  PauseIcon,
  PlusIcon,
  WarnIcon,
} from "../icons.tsx";
// The `b-` rows and notes come with bots.css, which Shell and Settings load; importing it
// here too would move it ahead in the cascade and change other screens.
import "./setup.css";

/** The screens the person moves between here; the look's own come from the host. */
export type SetupView = "first" | "here" | "another" | "advanced";

const INSTALL_DOCS = "https://docs.openclaw.ai/install";

/** A screen's title: its heading, focused when the screen appears, and announced. */
function Title({ children, id }: { children: ReactNode; id: string }) {
  return (
    <h2 className="s-title" id={id} tabIndex={-1} data-s-title>
      {children}
    </h2>
  );
}

function Back({ onBack }: { onBack: () => void }) {
  return (
    <div className="s-top">
      <button type="button" className="button" data-variant="quiet" data-size="sm" onClick={onBack}>
        <BackIcon />
        Back
      </button>
    </div>
  );
}

const Mark = () => <img className="s-mark" src={logoUrl} alt="" width={44} height={44} />;

type StepState = "waiting" | "running" | "done" | "failed";

/** The step list (§2 "New components"), with the elapsed time on a step running past 10 s. */
function Steps({ steps, current, failed }: { steps: string[]; current: number; failed?: boolean }) {
  // Seconds on the running step, measured from when it started: time the window spent
  // suspended counts too, which counting the timer's calls would miss.
  const [timed, setTimed] = useState({ step: current, seconds: 0 });
  if (timed.step !== current) setTimed({ step: current, seconds: 0 });
  useEffect(() => {
    if (failed) return;
    const at = Date.now();
    const timer = setInterval(
      () => setTimed({ step: current, seconds: Math.floor((Date.now() - at) / 1000) }),
      1000,
    );
    return () => clearInterval(timer);
  }, [current, failed]);
  const elapsed = timed.step === current ? timed.seconds : 0;
  return (
    <>
      {/* The step under way, said when it changes; never its seconds. */}
      <p className="visually-hidden" aria-live="polite" data-testid="setup-step-live">
        {failed ? "" : (steps[current] ?? "")}
      </p>
      <ol className="s-steps" aria-label="Steps" data-testid="setup-step-list">
        {steps.map((text, index) => {
          const state: StepState =
            index < current ? "done" : index > current ? "waiting" : failed ? "failed" : "running";
          return (
            <li
              key={text}
              data-state={state}
              aria-current={state === "running" ? "step" : undefined}
              aria-label={`${text}, ${state}`}
            >
              <span className="s-step-mark" aria-hidden="true">
                {state === "done" ? <CheckIcon /> : state === "failed" ? <CloseIcon /> : null}
              </span>
              <span>{text}</span>
              <span className="s-step-time">
                {state === "running" && elapsed >= 10 ? `${elapsed} s` : ""}
              </span>
            </li>
          );
        })}
      </ol>
    </>
  );
}

function Note({
  tone,
  lead,
  children,
}: {
  tone?: "warn" | "danger";
  lead?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className="b-note"
      data-tone={tone}
      role={tone === "danger" ? "alert" : "status"}
      data-testid="setup-note"
    >
      {tone ? <WarnIcon /> : <ClockIcon />}
      <div>
        <p>
          {lead && <b>{lead}</b>}
          {lead && children ? " " : null}
          {children}
        </p>
      </div>
    </div>
  );
}

type Tone = "ok" | "warn" | "danger" | undefined;

/** What the look found: a mark, a title, at most five facts. */
function Found({
  mark,
  tone,
  heading,
  facts,
  children,
}: {
  mark: ReactNode;
  tone?: Tone;
  heading: string;
  facts?: Array<[string, string]>;
  children?: ReactNode;
}) {
  return (
    <>
      <div className="s-found" data-testid="setup-found">
        <span className="empty-mark" data-tone={tone} aria-hidden="true">
          {mark}
        </span>
        <h3>{heading}</h3>
        {facts && (
          <dl className="facts">
            {facts.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      {children}
    </>
  );
}

function Lede({ children }: { children: ReactNode }) {
  return <p className="s-lede">{children}</p>;
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="s-hint">{children}</p>;
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="s-actions">{children}</div>;
}

function Primary({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      className="button"
      data-variant="primary"
      data-size="lg"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Quiet({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" className="button" data-variant="quiet" data-size="lg" onClick={onClick}>
      {children}
    </button>
  );
}

function SmallLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" className="button" data-variant="quiet" data-size="sm" onClick={onClick}>
      {children}
    </button>
  );
}

function ExternalLink({ children, href }: { children: ReactNode; href: string }) {
  return (
    <a
      className="button"
      data-variant="quiet"
      data-size="sm"
      href={href}
      target="_blank"
      rel="noreferrer noopener"
    >
      {children}
    </a>
  );
}

function HowToUpdate() {
  return (
    <details className="b-disclosure s-disclosure">
      <summary>How to update</summary>
      <div className="b-disclosure-body">
        <CommandLine command="openclaw update" label="Copy update command" />
        <Hint>Run it yourself when you're ready.</Hint>
      </div>
    </details>
  );
}

const SERVICE_WORDS: Record<LookService, string> = {
  launchagent: "LaunchAgent",
  "launchagent-stopped": "LaunchAgent, stopped",
  systemd: "systemd service",
  "systemd-stopped": "systemd service, stopped",
  "systemd-user": "systemd user service",
  "systemd-user-stopped": "systemd user service, stopped",
  none: "No matching service reported",
};

/** A fact the look established, or "Not reported". */
const NOT_REPORTED = "Not reported";
const serviceWords = (service: LookService | null) =>
  service ? SERVICE_WORDS[service] : NOT_REPORTED;

function runningFacts(look: SetupLook, there: boolean): Array<[string, string]> {
  return [
    ["Version", look.version ?? NOT_REPORTED],
    ["Profile", look.profile ?? NOT_REPORTED],
    [
      // Over SSH the status reports the configured bind, not where the gateway listens now.
      there ? "Configured bind" : "Listens",
      look.listens === "loopback"
        ? "Configured for loopback"
        : look.listens === "lan"
          ? "Configured for LAN"
          : NOT_REPORTED,
    ],
    ["Service", serviceWords(look.service)],
  ];
}

/** What Connect does, said only as far as it is true for this device. */
const CONNECT_HINT: Record<NonNullable<SetupLook["access"]>, string> = {
  new: "Clawtrate asks for read access. The gateway may ask its owner to approve this device.",
  paired: "This device has a saved pairing for this address. Clawtrate asks for read access.",
};
/** Over SSH, a token is only present here until the gateway accepts it. */
const SSH_CONNECT_HINT: Record<NonNullable<SetupLook["access"]>, string> = {
  new: CONNECT_HINT.new,
  paired: "This device has a saved token for this route. Clawtrate asks for read access.",
};

/** An SSH route's account as every prompt and title names it: "you@devbox.example (SSH port 22)". */
const withPort = (account: string, port: number | null) =>
  port === null ? account : `${account} (SSH port ${port})`;

/** Other services and profiles the look saw: named, never used. */
function Others({ others, onAdvanced }: { others: string[]; onAdvanced: () => void }) {
  if (others.length === 0) return null;
  return (
    <>
      <Note>{`Other OpenClaw services or profile folders reported here: ${others.join(", ")}.`}</Note>
      <p className="s-links">
        <SmallLink onClick={onAdvanced}>Advanced</SmallLink>
      </p>
    </>
  );
}

const CANT_TELL: Record<string, string> = {
  timeout: "The look didn't finish in time.",
  shape: "Clawtrate couldn't read the OpenClaw result.",
  "no-answer": "Clawtrate couldn't read a gateway answer.",
  "not-set-up": "OpenClaw didn't report a config file for this profile.",
  endpoint:
    "Clawtrate couldn't confirm where this gateway answers, so it doesn't connect to it by itself. Use Advanced.",
  contradictory: "OpenClaw's status results disagree, or say too little to tell.",
};

/** The found card and actions for each result of the look (§6). */
function LookResult({
  look,
  offer,
  onAdvanced,
  onAnother,
  confirming,
  there = null,
}: {
  look: SetupLook;
  offer: NonNullable<HostInfo["setup"]>;
  onAdvanced: () => void;
  onAnother: () => void;
  confirming: boolean;
  /** Over SSH (§5): the card's few differences, and Look again asks the account again. */
  there?: SshSetup | null;
}) {
  const send = useCommand();
  const lookAgain = () =>
    void send(
      there ? { type: "setupThere", destination: there.destination } : { type: "setupLook" },
    );
  const advanced = <Primary onClick={onAdvanced}>Use Advanced</Primary>;
  switch (look.outcome) {
    case "running":
      return (
        <Found
          mark={<CheckIcon />}
          tone="ok"
          heading="OpenClaw is running"
          facts={runningFacts(look, there !== null)}
        >
          {offer.pair ? (
            <>
              <Actions>
                <button
                  type="button"
                  className="button"
                  data-variant="primary"
                  data-size="lg"
                  aria-disabled={confirming || undefined}
                  onClick={() => {
                    if (!confirming) void send({ type: "setupConnect" });
                  }}
                >
                  Connect read-only
                </button>
              </Actions>
              <Hint>{(there ? SSH_CONNECT_HINT : CONNECT_HINT)[look.access ?? "new"]}</Hint>
            </>
          ) : (
            <>
              <Note>
                Pairing needs the desktop app, which asks you first. In this web preview, use
                Advanced.
              </Note>
              <Actions>{advanced}</Actions>
            </>
          )}
        </Found>
      );
    case "untested":
      return (
        <Found
          mark={<CheckIcon />}
          tone="ok"
          heading="OpenClaw is running"
          facts={runningFacts(look, there !== null)}
        >
          <Note tone="warn">
            {`OpenClaw ${look.version} isn't the version this ${PRODUCT_NAME} is tested with (${TESTED_OPENCLAW_VERSION}). Use Advanced to try connecting.`}
          </Note>
          <Actions>{advanced}</Actions>
          <HowToUpdate />
        </Found>
      );
    case "too-old":
      return (
        <Found
          mark={<CloseIcon />}
          tone="danger"
          heading="This OpenClaw is too old for automatic setup"
        >
          <Lede>{`OpenClaw ${look.version} is below the version this ${PRODUCT_NAME} offers for automatic setup (${OLDEST_OPENCLAW_VERSION}). Update it, then look again.`}</Lede>
          <Actions>
            <Primary onClick={lookAgain}>Look again</Primary>
          </Actions>
          <HowToUpdate />
        </Found>
      );
    case "stopped":
      return (
        <Found
          mark={<PauseIcon />}
          heading="OpenClaw is installed but not running"
          facts={[
            ["Installed program", look.version ?? NOT_REPORTED],
            ["Service", serviceWords(look.service)],
            [
              "Port",
              there
                ? `Nothing is listening on port ${look.port}`
                : `No gateway answered on port ${look.port}`,
            ],
          ]}
        >
          {there ? (
            <>
              <Actions>
                <button
                  type="button"
                  className="button"
                  data-variant="primary"
                  data-size="lg"
                  aria-disabled={confirming || undefined}
                  onClick={() => {
                    if (!confirming) void send({ type: "setupStart" });
                  }}
                >
                  Start OpenClaw…
                </button>
                <Quiet onClick={lookAgain}>Look again</Quiet>
              </Actions>
              <Hint>{`Clawtrate asks before it starts OpenClaw on ${there.account ?? there.name ?? "that computer"}.`}</Hint>
            </>
          ) : (
            <>
              <Lede>Start OpenClaw yourself, then look again.</Lede>
              <Actions>
                <Primary onClick={lookAgain}>Look again</Primary>
              </Actions>
            </>
          )}
          <p className="s-links">
            <SmallLink onClick={onAdvanced}>Advanced</SmallLink>
          </p>
        </Found>
      );
    case "program-missing":
      return (
        <Found
          mark={<WarnIcon />}
          tone="warn"
          heading="OpenClaw seems to be set up here, but Clawtrate can't find its program"
        >
          <Lede>
            Clawtrate looked in the usual places. If you installed OpenClaw somewhere else, use
            Advanced, or run <code>openclaw gateway status</code> here to see where it is.
          </Lede>
          <p className="s-links">
            <SmallLink onClick={onAdvanced}>Advanced</SmallLink>
          </p>
        </Found>
      );
    case "cant-tell":
      return (
        <Found
          mark={<WarnIcon />}
          tone="warn"
          heading={
            there && look.reason === "contradictory"
              ? `Clawtrate couldn't tell whether OpenClaw is running on ${there.account ?? there.destination}.`
              : `Clawtrate couldn't tell what is on ${there ? "that" : "this"} computer`
          }
        >
          <Lede>{CANT_TELL[look.reason ?? "shape"]}</Lede>
          <Actions>
            {advanced}
            <Quiet onClick={lookAgain}>Look again</Quiet>
          </Actions>
        </Found>
      );
    case "cant-run":
      return (
        <Found mark={<WarnIcon />} tone="warn" heading="Clawtrate couldn't run OpenClaw here">
          <Lede>
            Clawtrate found OpenClaw's program, but it didn't start. Check that OpenClaw runs here,
            or use Advanced.
          </Lede>
          <Actions>
            {advanced}
            <Quiet onClick={lookAgain}>Look again</Quiet>
          </Actions>
        </Found>
      );
    case "not-token":
      return (
        <Found mark={<WarnIcon />} tone="warn" heading="This gateway uses another way to sign in">
          <Lede>Clawtrate connects by itself only to gateways that use a token. Use Advanced.</Lede>
          <p className="s-links">
            <SmallLink onClick={onAdvanced}>Advanced</SmallLink>
          </p>
        </Found>
      );
    case "not-found":
      if (there)
        return (
          <Found mark={<PlusIcon />} heading="Clawtrate didn't find OpenClaw here">
            <Lede>Setting OpenClaw up on another computer isn't offered in this version.</Lede>
            <Actions>
              <Primary onClick={lookAgain}>Look again</Primary>
            </Actions>
            <p className="s-links">
              <SmallLink onClick={onAdvanced}>Advanced</SmallLink>
            </p>
          </Found>
        );
      return (
        <Found mark={<PlusIcon />} heading="Clawtrate didn't find OpenClaw here">
          <Lede>
            Setting OpenClaw up from Clawtrate isn't in this version. Install it with OpenClaw's own
            instructions, then look again.
          </Lede>
          <Actions>
            <Primary onClick={lookAgain}>Look again</Primary>
            <Quiet onClick={onAnother}>It runs on another computer</Quiet>
          </Actions>
          <p className="s-links">
            <ExternalLink href={INSTALL_DOCS}>OpenClaw's own install instructions</ExternalLink>
          </p>
        </Found>
      );
    case "windows":
      return (
        <Found mark={<PlusIcon />} heading="Use Advanced on Windows">
          <Lede>
            Clawtrate can't yet look for OpenClaw on Windows. It doesn't set OpenClaw up on Windows
            either: OpenClaw's Windows installer can change Node.js or PATH and installs OpenClaw
            globally.
          </Lede>
          <Actions>
            {advanced}
            <button type="button" className="button" data-size="lg" onClick={onAnother}>
              Use another computer
            </button>
          </Actions>
          <p className="s-links">
            <ExternalLink href={INSTALL_DOCS}>OpenClaw's own install instructions</ExternalLink>
          </p>
        </Found>
      );
  }
}

/** Connect's failures (§7), in fixed copy. */
const FAILURES: Record<
  SetupFailureKind,
  {
    lead: string;
    text?: (port: number | null, exit: number | null) => string;
    /** "review" is "look" in §8's word: that computer's screens again, after a different gateway. */
    next: "retry" | "look" | "review" | "back" | "advanced" | "bots";
    step: number;
  }
> = {
  "code-failed": {
    lead: "Couldn't make a one-time code.",
    text: (_port, exit) =>
      exit === null
        ? ""
        : exit === 0
          ? "OpenClaw didn't return a usable setup code."
          : `OpenClaw exited with code ${exit}.`,
    next: "retry",
    step: 0,
  },
  "code-refused": {
    lead: "The one-time code didn't work.",
    text: () => "Clawtrate makes a new one when you try again.",
    next: "retry",
    step: 1,
  },
  grant: {
    lead: "The gateway granted something other than read access, so Clawtrate disconnected.",
    next: "back",
    step: 1,
  },
  unreachable: {
    lead: "",
    text: () => "The gateway may have just stopped.",
    next: "look",
    step: 1,
  },
  changed: {
    lead: "This changed since you looked.",
    text: () => "Look again.",
    next: "look",
    step: 0,
  },
  "no-dialog": {
    lead: "Pairing needs the desktop app, which asks you first.",
    text: () => "In this web preview, use Advanced.",
    next: "advanced",
    step: 0,
  },
  refused: { lead: "", next: "advanced", step: 0 },
  identity: {
    lead: "A different OpenClaw gateway answered, so Clawtrate disconnected.",
    text: () => "Look again.",
    next: "look",
    step: 2,
  },
  "identity-unread": {
    lead: "Clawtrate couldn't confirm which OpenClaw gateway answered, so it disconnected.",
    text: () => "Look again.",
    next: "look",
    step: 2,
  },
  "pairing-gone": {
    lead: "This device has no usable token for this route any more.",
    text: () => "Look again, then pair again.",
    next: "look",
    step: 2,
  },
  "approval-unconfirmed": {
    lead: APPROVAL_WORDS.unconfirmed.title,
    text: () => APPROVAL_WORDS.unconfirmed.detail,
    next: "look",
    step: 2,
  },
  "approval-identity": {
    lead: APPROVAL_WORDS.identityChanged,
    next: "review",
    step: 2,
  },
  "approval-identity-unread": {
    lead: APPROVAL_WORDS.identityUnread,
    next: "look",
    step: 2,
  },
  stopped: {
    lead: "Stopped waiting for approval.",
    text: () => "The request stays on the gateway. Try again once it's approved.",
    next: "retry",
    step: 1,
  },
  bots: {
    lead: "Connected, but Clawtrate couldn't read your bots.",
    text: () => "Try again, or go back.",
    next: "bots",
    step: 2,
  },
  other: {
    lead: "Clawtrate couldn't connect to the gateway.",
    text: () => "Try again, or use Advanced.",
    next: "retry",
    step: 1,
  },
};

/** Connect's steps: a new pairing, or a device that is already paired there. */
const CONNECT_STEPS: Record<NonNullable<SetupLook["access"]>, string[]> = {
  new: ["Making a one-time code", "Requesting read access", "Loading your bots"],
  paired: ["Checking the gateway", "Requesting read access", "Loading your bots"],
};

/** Why a run that must look in a sandbox couldn't use the one it was given, in words. */
const REFUSED: Record<SetupRefusal, string> = {
  missing: "none was given to this run.",
  file: "its description isn't in a private folder of yours under the system's temporary root, reached without links, or has the wrong shape.",
  home: "its home and working folder must be outside the account's home.",
  state: "its state folder or config didn't pass the run's checks.",
  pairing: "it pairs only in its pairing scenario.",
};
const LOOK_STEPS = ["Finding OpenClaw", "Checking its version", "Asking the gateway"];

/** A screen's identity, so that a new one takes focus and is announced. */
function screenKey(view: SetupView, setup: SetupState): string {
  if (view === "another" && setup.there)
    return `there:${setup.phase === "confirming" && !setup.look ? "idle" : setup.phase}:${setup.there.key?.state ?? ""}:${setup.look?.outcome ?? ""}:${setup.there.failure?.kind ?? setup.failure?.kind ?? ""}`;
  if (view !== "here") return view;
  return `${setup.phase}:${setup.look?.outcome ?? ""}:${setup.failure?.kind ?? ""}`;
}

export function SetupFlow({
  view: chosen,
  onView,
  setup,
  connection,
  info,
}: {
  view: SetupView;
  onView: (view: SetupView) => void;
  setup: SetupState;
  connection: ConnectionState;
  info: HostInfo;
}) {
  const send = useCommand();
  const offer = info.setup!;
  const root = useRef<HTMLDivElement>(null);
  const [announced, setAnnounced] = useState("");
  // Setup on another computer keeps its screens, also after a reload or from another window.
  const view: SetupView = setup.there && chosen === "here" ? "another" : chosen;
  const key = screenKey(view, setup);
  const shown = useRef<string | null>(null);
  useEffect(() => {
    const first = shown.current === null;
    shown.current = key;
    const title = root.current?.querySelector<HTMLElement>("[data-s-title]");
    if (!title) return;
    setAnnounced(title.textContent ?? "");
    // Not on launch: nothing had focus to lose.
    if (!first) title.focus();
  }, [key]);

  const toFirst = () => {
    if (view === "here")
      void send({ type: setup.phase === "looking" ? "setupCancel" : "setupReset" });
    if (view === "another" && setup.there) void send({ type: "setupReset" });
    onView("first");
  };
  const lookHere = () => {
    onView("here");
    // A look the host never started (this window's commands refused) shows no progress.
    send({ type: "setupLook" }).catch(() => onView("first"));
  };
  const advanced = () => {
    if (view === "here" || setup.there) void send({ type: "setupReset" });
    onView("advanced");
  };
  const another = () => {
    if (view === "here") void send({ type: "setupReset" });
    onView("another");
  };
  // Back from a wait or a failure of Connect returns to what the look found.
  const backFromConnect = () => void send({ type: "setupCancel" });
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || view === "first") return;
    event.preventDefault();
    // As each screen's Back: a refused sandbox's goes to the first question.
    if (
      (view === "here" || view === "another") &&
      (setup.phase === "connecting" ||
        (setup.phase === "failed" && setup.failure?.kind !== "refused")) &&
      setup.look
    )
      backFromConnect();
    else if (view === "another" && setup.there && setup.phase !== "idle")
      void send({ type: "setupCancel" });
    else toFirst();
  };

  let body: ReactNode;
  if (view === "first") {
    body = (
      <FirstScreen offer={offer} onThis={lookHere} onAnother={another} onAdvanced={advanced} />
    );
  } else if (view === "another" && offer.ssh) {
    body = (
      <AnotherComputer
        setup={setup}
        offer={offer}
        onFirst={toFirst}
        onAdvanced={advanced}
        onAnother={another}
      />
    );
  } else if (view === "another") {
    body = (
      <>
        <Back onBack={toFirst} />
        <Mark />
        <Title id="setup-title">Another computer</Title>
        <Lede>
          {offer.platform === "win32"
            ? "Clawtrate doesn't reach another computer over SSH on Windows in this version: Windows has no local channel for the SSH forward that Clawtrate can keep private. Use Advanced with that gateway's address and a token."
            : "Reaching another computer with SSH is off in this run: it would use this account's own SSH settings. Use Advanced with that gateway's address and a token."}
        </Lede>
        <Actions>
          <Primary onClick={advanced}>Use Advanced</Primary>
        </Actions>
      </>
    );
  } else if (setup.phase === "looking" || setup.phase === "idle") {
    body = (
      <>
        <Back onBack={toFirst} />
        <Mark />
        <Title id="setup-title">Looking on this computer</Title>
        <Steps steps={LOOK_STEPS} current={setup.step} />
        {setup.slow && (
          <p className="s-slow" role="status">
            Still looking. A gateway that has just started can take a while to answer.
          </p>
        )}
      </>
    );
  } else if (setup.phase === "failed" && setup.failure?.kind === "refused") {
    body = (
      <>
        <Back onBack={toFirst} />
        <Mark />
        <Title id="setup-title">On this computer</Title>
        <Found mark={<WarnIcon />} tone="warn" heading="Looking on this computer is off here">
          <Lede>
            {`This run can only look in a sandbox. ${PRODUCT_NAME} couldn't use this sandbox because ${REFUSED[setup.failure.reason ?? "file"]} Use Advanced.`}
          </Lede>
          <Actions>
            <Primary onClick={advanced}>Use Advanced</Primary>
          </Actions>
        </Found>
      </>
    );
  } else if (
    (setup.phase === "connecting" || setup.phase === "failed" || setup.phase === "done") &&
    connection.status !== "pairing"
  ) {
    const failure = setup.phase === "failed" ? setup.failure : null;
    const copy = failure ? FAILURES[failure.kind] : null;
    const lead =
      failure?.kind === "unreachable"
        ? `Nothing answered on port ${failure.port}.`
        : (copy?.lead ?? "");
    body = (
      <>
        <Back onBack={backFromConnect} />
        <Mark />
        <Title id="setup-title">Connecting</Title>
        <Steps
          steps={CONNECT_STEPS[setup.look?.access ?? "new"]}
          current={failure ? copy!.step : setup.step}
          failed={!!failure}
        />
        {failure && copy && (
          <>
            <Note tone="danger" lead={lead}>
              {copy.text?.(failure.port, failure.exitCode)}
            </Note>
            <Actions>
              {copy.next === "retry" && (
                <Primary onClick={() => void send({ type: "setupConnect" })}>Try again</Primary>
              )}
              {(copy.next === "look" || copy.next === "review") && (
                <Primary onClick={() => void send({ type: "setupLook" })}>
                  {copy.next === "review" ? "Review" : "Look again"}
                </Primary>
              )}
              {copy.next === "advanced" && <Primary onClick={advanced}>Use Advanced</Primary>}
              {copy.next === "back" && <Primary onClick={backFromConnect}>Back</Primary>}
              {copy.next === "bots" && (
                <Primary onClick={() => void send({ type: "retry" })}>Try again</Primary>
              )}
            </Actions>
          </>
        )}
      </>
    );
  } else {
    const look = setup.look!;
    body = (
      <>
        <Back onBack={toFirst} />
        <Mark />
        <Title id="setup-title">On this computer</Title>
        <LookResult
          look={look}
          offer={offer}
          onAdvanced={advanced}
          onAnother={another}
          confirming={setup.phase === "confirming"}
        />
        <Others others={look.others} onAdvanced={advanced} />
      </>
    );
  }
  return (
    <div className="setup" ref={root} onKeyDown={onKeyDown} data-testid="setup" data-screen={key}>
      {body}
      <p className="visually-hidden" aria-live="polite">
        {announced}
      </p>
    </div>
  );
}

/** A fingerprint in groups of eight, as section 2 draws it, with its copy button. */
function Fingerprint({ label, shown }: { label: string; shown: ShownHostKey }) {
  const [state, setState] = useState<"idle" | CopyResult>("idle");
  const codeRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (state !== "copied") return;
    const timer = setTimeout(() => setState("idle"), 1500);
    return () => clearTimeout(timer);
  }, [state]);
  const value = shown.fingerprint;
  const body = value.startsWith("SHA256:") ? value.slice("SHA256:".length) : value;
  const groups = body.match(/.{1,8}/g) ?? [body];
  return (
    <div className="s-print" data-testid="setup-fingerprint">
      <div className="s-print-text">
        <span className="s-print-alg">{label}</span>
        <code ref={codeRef} aria-label={`${shown.label} fingerprint ${value}`}>
          {`SHA256:${groups.join(" ")}`}
        </code>
      </div>
      <button
        type="button"
        className="button"
        data-variant="quiet"
        data-size="sm"
        aria-label="Copy fingerprint"
        onClick={async () => {
          const result = await copyText(value);
          if (result === "manual" && codeRef.current) selectContents(codeRef.current);
          setState(result);
        }}
      >
        {state === "copied" ? <CheckIcon /> : <CopyIcon />}
      </button>
      <span className="visually-hidden" aria-live="polite">
        {state === "copied"
          ? "Copied."
          : state === "manual"
            ? "The fingerprint is selected. Press Command-C or Control-C to copy it."
            : ""}
      </span>
    </div>
  );
}

/** What `ssh` and the forward ended on (§5, §8), in fixed copy naming what the host resolved. */
function sshFailureCopy(
  there: SshSetup,
  platform: string,
): { lead: string; text: string; next: string | null; retry: boolean } {
  const failure = there.failure!;
  const account = there.account ?? there.destination;
  const hostName = account.includes("@") ? account.slice(account.indexOf("@") + 1) : account;
  const port = there.port ?? 22;
  switch (failure.kind) {
    case "unreachable":
      return {
        lead: `Can't reach ${withPort(account, there.port)}`,
        // The cause only as ssh's output classified it.
        text: `Nothing answered at ${hostName}, port ${port}${failure.cause ? ` (${failure.cause})` : ""}.`,
        next: "Check the name and that the computer is on.",
        retry: true,
      };
    case "sign-in-refused":
      return {
        lead: `SSH sign-in was refused for ${account}, port ${port}.`,
        text: "Check that the public key is authorized for that account.",
        next:
          "A key with a passphrase has to be in your SSH agent first." +
          (platform === "win32" ? " Key-agent sign-in has not been verified on Windows." : ""),
        retry: true,
      };
    case "timed-out":
      return { lead: "ssh stopped", text: "ssh didn't finish in time.", next: null, retry: true };
    case "spawn-failed":
      return {
        lead: "ssh couldn't start",
        text: "Clawtrate couldn't start ssh on this computer.",
        next: null,
        retry: true,
      };
    case "not-supported":
      return {
        lead: "Clawtrate couldn't use this computer's SSH client.",
        text: "Use Advanced with that gateway's address and a token.",
        next: null,
        retry: false,
      };
    case "app-files-unsafe":
      return {
        lead: "Clawtrate can't keep its SSH files private here",
        text: "It couldn't confirm that no other account can change its own SSH folder, so it doesn't use SSH on this computer.",
        next: null,
        retry: false,
      };
    case "no-token-storage":
      return {
        lead: "Clawtrate can't keep a device token encrypted on this computer",
        text: "So it doesn't pair over SSH here. Use Advanced with that gateway's address and a token.",
        next: null,
        retry: false,
      };
    case "forwarding-refused":
      return {
        lead: `The SSH server refused this forward to OpenClaw on ${withPort(account, there.port)}.`,
        text: "Check whether its SSH configuration and your key allow forwarding to the gateway port.",
        next: null,
        retry: true,
      };
    case "gateway-not-answering":
      return {
        lead: `Nothing answered through SSH at the gateway port on ${withPort(account, there.port)}.`,
        text: "OpenClaw did not answer through the SSH forward.",
        next: null,
        retry: true,
      };
    case "gateway-stopped":
      return {
        lead: `OpenClaw stopped on ${withPort(account, there.port)}`,
        text: "Its service reports itself stopped and nothing listens on its port. Look again to start it.",
        next: null,
        retry: true,
      };
    case "service-changed":
      return {
        lead: "Another service answered at the gateway's port",
        text: "What answered when the private connection opened isn't the service the look named. Clawtrate didn't connect. Look again.",
        next: null,
        retry: true,
      };
    case "service-cant-tell":
      return {
        lead: "Clawtrate couldn't tell what answers at the gateway's port",
        text: "OpenClaw's status there didn't say whether its service runs. Clawtrate didn't connect. Look again, or use Advanced.",
        next: null,
        retry: true,
      };
    case "key-changed":
      return {
        lead: `${withPort(account, there.port)}'s key has changed`,
        text: "The key presented when the private connection opened isn't the trusted one. Clawtrate didn't connect. Look again to compare the keys.",
        next: null,
        retry: true,
      };
    case "remove-failed":
      return {
        lead: "Clawtrate couldn't remove this route",
        text: "Its trusted key couldn't be deleted from Clawtrate's own SSH files, so the route, its key and its token are kept. Try Remove again.",
        next: null,
        retry: false,
      };
    case "code-failed":
      return {
        lead: "Couldn't make a one-time code.",
        text:
          failure.exit === null
            ? `OpenClaw on ${account} didn't return a usable setup code.`
            : failure.exit === 0
              ? "OpenClaw didn't return a usable setup code."
              : `OpenClaw exited with code ${failure.exit}.`,
        next: null,
        retry: true,
      };
    case "start-failed":
      return {
        lead: "OpenClaw didn't start.",
        text: `Its start command ran on ${withPort(account, there.port)} and exited with code ${failure.exit ?? "unknown"}.`,
        next: null,
        retry: true,
      };
    case "start-not-run":
      return {
        lead: "Clawtrate didn't start OpenClaw.",
        text: `OpenClaw's program on ${withPort(account, there.port)} changed since the look, so the start command didn't run. Nothing was changed there. Look again.`,
        next: null,
        retry: true,
      };
    case "start-unconfirmed":
      return {
        lead: "Clawtrate couldn't confirm OpenClaw started.",
        text: `It asked OpenClaw on ${withPort(account, there.port)} to start, and couldn't establish afterwards that the gateway runs. Look again.`,
        next: null,
        retry: true,
      };
    default:
      return {
        lead: "ssh stopped",
        text: `ssh stopped (exit ${failure.exit ?? "unknown"}).`,
        next: null,
        retry: true,
      };
  }
}

/** Another computer over SSH (§5 to §7): the field, the key, the look, Connect and Start. */
function AnotherComputer({
  setup,
  offer,
  onFirst,
  onAdvanced,
  onAnother,
}: {
  setup: SetupState;
  offer: NonNullable<HostInfo["setup"]>;
  onFirst: () => void;
  onAdvanced: () => void;
  onAnother: () => void;
}) {
  const send = useCommand();
  const there = setup.there ?? null;
  const [typed, setTyped] = useState(there?.destination ?? "");
  const cancel = () => void send({ type: "setupCancel" });
  const lookThere = () => {
    const destination = typed.trim();
    if (destination) void send({ type: "setupThere", destination });
  };
  const name = there?.name ?? there?.destination ?? "";
  const account = there?.account ?? there?.destination ?? "";
  const advancedLink = (
    <p className="s-links">
      <SmallLink onClick={onAdvanced}>Advanced</SmallLink>
    </p>
  );
  // A saved route that couldn't be restored can be removed here, with no connection (§8).
  const removeSaved = setup.route ? (
    <p className="s-links">
      <SmallLink onClick={() => void send({ type: "setupRemoveRoute" })}>
        {`Remove ${setup.route.account} from Clawtrate…`}
      </SmallLink>
    </p>
  ) : null;

  // The field: nothing under way, or the account's dialog open over it.
  if (!there || setup.phase === "idle" || (setup.phase === "confirming" && !setup.look)) {
    const confirming = setup.phase === "confirming";
    return (
      <>
        <Back onBack={onFirst} />
        <Mark />
        <Title id="setup-title">Another computer</Title>
        <form
          className="s-field"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (!confirming) lookThere();
          }}
        >
          <label className="field">
            <span className="s-field-label">SSH host or alias</span>
            <input
              className="input"
              name="destination"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              placeholder="devbox or you@devbox.example"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-invalid={there?.invalid || undefined}
              aria-describedby="setup-ssh-hint"
            />
          </label>
          {there?.invalid && (
            <p className="s-field-error" role="alert">
              That isn't an SSH host or alias Clawtrate can use.
            </p>
          )}
          <Hint>
            <span id="setup-ssh-hint">
              Clawtrate uses SSH keys and a limited set of settings from your SSH configuration. It
              never asks for a password.
            </span>
          </Hint>
          {there?.refusal && (
            <Note tone="warn" lead={there.refusal.title}>
              {there.refusal.sentence}
            </Note>
          )}
          {there?.notice === "endpoint-changed" && setup.route && (
            <Note
              tone="warn"
              lead={`The SSH settings for ${there.destination} no longer lead to ${withPort(setup.route.account, setup.route.port)}.`}
            >
              Clawtrate didn't connect. Look there to check where they lead now, or remove the saved
              route.
            </Note>
          )}
          <Actions>
            <button
              type="submit"
              className="button"
              data-variant="primary"
              data-size="lg"
              aria-disabled={confirming || undefined}
            >
              Look there
            </button>
          </Actions>
        </form>
        {advancedLink}
        {removeSaved}
      </>
    );
  }

  if (setup.phase === "looking") {
    return (
      <>
        <Back onBack={cancel} />
        <Mark />
        <Title id="setup-title">{`Looking on ${withPort(account, there.port)}`}</Title>
        <Steps
          steps={[
            `Reaching ${account}`,
            "Finding OpenClaw",
            "Checking its version",
            "Asking the gateway",
          ]}
          current={setup.step}
        />
      </>
    );
  }

  if (setup.phase === "key" && there.key) {
    const key = there.key;
    if (key.state === "first-contact")
      return (
        <>
          <Back onBack={cancel} />
          <Mark />
          <Title id="setup-title">{`Is this ${name}?`}</Title>
          <Lede>
            {`Clawtrate has no trusted key for ${account}, SSH port ${there.port ?? 22}. This is the key SSH presented. If you can, compare it with the key ${name} itself shows before you trust it.`}
          </Lede>
          <Fingerprint label={key.presented.label} shown={key.presented} />
          <details className="b-disclosure s-disclosure">
            <summary>How to compare</summary>
            <div className="b-disclosure-body">
              <Hint>
                {`On ${name}, in a session you already trust, `}
                <code>ssh-keygen -lf</code>
                {
                  " with the key file shows its fingerprint. The file depends on the key's type, for example "
                }
                <code>/etc/ssh/ssh_host_ed25519_key.pub</code>.
              </Hint>
            </div>
          </details>
          <Actions>
            <Primary onClick={() => void send({ type: "setupTrustKey" })}>Trust this key…</Primary>
            <button type="button" className="button" data-size="lg" onClick={cancel}>
              Back
            </button>
          </Actions>
        </>
      );
    return (
      <>
        <Back onBack={cancel} />
        <Mark />
        <Title id="setup-title">{`On ${withPort(account, there.port)}`}</Title>
        <Note
          tone="danger"
          lead={`SSH presented a key that differs from the saved key for ${withPort(account, there.port)}.`}
        >
          {`This happens when a computer is reinstalled, and it is also what someone between you and ${account} would cause. Clawtrate won't connect until you decide.`}
        </Note>
        {there.notice === "replace-unticked" && (
          <Note lead="Nothing was replaced.">{`The saved key is replaced only when the dialog's box "I checked the new key on ${account} itself" is ticked.`}</Note>
        )}
        <div className="s-prints">
          {key.trusted && (
            <Fingerprint
              label={`Saved ${key.trusted.label} key, pinned ${key.trusted.pinnedAt.slice(0, 10)}`}
              shown={key.trusted}
            />
          )}
          <Fingerprint label={`Presented now: ${key.presented.label} key`} shown={key.presented} />
        </div>
        <Actions>
          <Primary
            onClick={() => void send({ type: "setupThere", destination: there.destination })}
          >
            Try again
          </Primary>
          <button type="button" className="button" data-size="lg" onClick={cancel}>
            Back
          </button>
        </Actions>
        <p className="s-links">
          <SmallLink onClick={() => void send({ type: "setupReplaceKey" })}>
            Replace the saved key…
          </SmallLink>
        </p>
        {removeSaved}
      </>
    );
  }

  // A failure of ssh or of the forward, before or during Connect or Start.
  if (setup.phase === "failed" && there.failure) {
    const copy = sshFailureCopy(there, offer.platform);
    const atConnect = setup.look !== null;
    return (
      <>
        <Back onBack={atConnect ? cancel : onFirst} />
        <Mark />
        <Title id="setup-title">
          {there.failure.kind.startsWith("start-")
            ? `Starting OpenClaw on ${withPort(account, there.port)}`
            : atConnect
              ? `Connecting to ${withPort(account, there.port)}`
              : `Looking on ${withPort(account, there.port)}`}
        </Title>
        <Note tone="danger" lead={copy.lead}>
          {copy.text}
          {copy.next ? ` ${copy.next}` : ""}
        </Note>
        <Actions>
          {copy.retry && (
            <Primary
              onClick={() => void send({ type: "setupThere", destination: there.destination })}
            >
              Try again
            </Primary>
          )}
          {there.failure.kind === "remove-failed" ? (
            <Primary onClick={() => void send({ type: "setupRemoveRoute" })}>Remove again…</Primary>
          ) : (
            !copy.retry && <Primary onClick={onAdvanced}>Use Advanced</Primary>
          )}
        </Actions>
        {copy.retry && advancedLink}
        {there.failure.kind !== "remove-failed" && removeSaved}
      </>
    );
  }

  const starting = setup.look?.outcome === "stopped";
  if (setup.phase === "connecting" || setup.phase === "failed" || setup.phase === "done") {
    const failure = setup.phase === "failed" ? setup.failure : null;
    const copy = failure ? FAILURES[failure.kind] : null;
    const steps = starting
      ? ["Starting the gateway", "Asking the gateway"]
      : there.resume
        ? [
            `Checking ${account}`,
            "Opening the SSH forward",
            "Connecting with the saved device token",
            "Loading your bots",
          ]
        : setup.look?.access === "paired"
          ? [
              `Checking ${account}`,
              `Opening an SSH forward to ${account}`,
              "Requesting read access",
              "Loading your bots",
            ]
          : [
              `Making a one-time code on ${account}`,
              `Opening an SSH forward to ${account}`,
              "Requesting read access",
              "Loading your bots",
            ];
    const lead =
      failure?.kind === "unreachable"
        ? "OpenClaw did not answer through the SSH forward."
        : failure?.kind === "grant"
          ? "Clawtrate couldn't confirm a read-only pairing, so it disconnected."
          : (copy?.lead ?? "");
    return (
      <>
        <Back onBack={setup.look ? cancel : onFirst} />
        <Mark />
        <Title id="setup-title">
          {starting
            ? `Starting OpenClaw on ${withPort(account, there.port)}`
            : `Connecting to ${withPort(account, there.port)}`}
        </Title>
        <Steps
          steps={steps}
          current={
            failure && copy
              ? Math.min(copy.step + (starting ? 0 : 1), steps.length - 1)
              : setup.step
          }
          failed={!!failure}
        />
        {failure && copy && (
          <>
            <Note tone="danger" lead={lead}>
              {failure.kind === "unreachable"
                ? "The gateway may have just stopped."
                : copy.text?.(failure.port, failure.exitCode)}
            </Note>
            <Actions>
              {(copy.next === "retry" || copy.next === "look" || copy.next === "review") && (
                <Primary
                  onClick={() => void send({ type: "setupThere", destination: there.destination })}
                >
                  {copy.next === "retry"
                    ? "Try again"
                    : copy.next === "review"
                      ? "Review"
                      : "Look again"}
                </Primary>
              )}
              {copy.next === "back" && <Primary onClick={cancel}>Back</Primary>}
              {copy.next === "bots" && (
                <Primary onClick={() => void send({ type: "retry" })}>Try again</Primary>
              )}
              {copy.next === "advanced" && <Primary onClick={onAdvanced}>Use Advanced</Primary>}
            </Actions>
            {removeSaved}
          </>
        )}
      </>
    );
  }

  const look = setup.look;
  if (!look) return null;
  return (
    <>
      <Back onBack={onFirst} />
      <Mark />
      <Title id="setup-title">{`On ${withPort(account, there.port)}`}</Title>
      <LookResult
        look={look}
        offer={offer}
        onAdvanced={onAdvanced}
        onAnother={onAnother}
        confirming={setup.phase === "confirming"}
        there={there}
      />
      {removeSaved}
    </>
  );
}

function FirstScreen({
  offer,
  onThis,
  onAnother,
  onAdvanced,
}: {
  offer: NonNullable<HostInfo["setup"]>;
  onThis: () => void;
  onAnother: () => void;
  onAdvanced: () => void;
}) {
  // Up and Down move between the two rows, Home and End go to the ends (§2 "Input").
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button.b-choice")];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "ArrowDown"
        ? Math.min(at + 1, rows.length - 1)
        : event.key === "ArrowUp"
          ? Math.max(at - 1, 0)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? rows.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    rows[next]?.focus();
  };
  const row = (title: string, sub: string, onClick: () => void) => (
    <li>
      <button type="button" className="b-choice" onClick={onClick}>
        <span className="b-choice-text">
          <span className="b-choice-title">{title}</span>
          <span className="b-choice-sub">{sub}</span>
        </span>
        <ChevronIcon />
      </button>
    </li>
  );
  return (
    <>
      <header className="connect-brand">
        <img src={logoUrl} alt="" width={56} height={56} />
        <h1>{PRODUCT_NAME}</h1>
        <p>{SLOGAN}</p>
      </header>
      <h2 className="s-title s-question" id="setup-title" tabIndex={-1} data-s-title>
        Where does OpenClaw run?
      </h2>
      <ul className="b-choices" aria-labelledby="setup-title" onKeyDown={onKeyDown}>
        {row("This computer", "Clawtrate looks for OpenClaw here.", onThis)}
        {row(
          "Another computer",
          "A computer you reach with SSH, such as a server or a desktop at home.",
          onAnother,
        )}
      </ul>
      <p className="s-links">
        <SmallLink onClick={onAdvanced}>Advanced</SmallLink>
      </p>
      <Hint>
        {offer.platform === "win32"
          ? "New to OpenClaw? Clawtrate doesn't set it up on Windows. Use Advanced with a gateway on a Mac or a Linux computer."
          : "New to OpenClaw? Choose where it should run, and Clawtrate says what it finds there."}
      </Hint>
    </>
  );
}
