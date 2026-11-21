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
} from "@clawtrate/core";
import { OLDEST_OPENCLAW_VERSION, TESTED_OPENCLAW_VERSION } from "@clawtrate/core";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import logoUrl from "../assets/logo-mark.png";
import { useCommand } from "../bridge.tsx";
import { CommandLine, PRODUCT_NAME, SLOGAN } from "../ConnectScreen.tsx";
import {
  BackIcon,
  CheckIcon,
  ChevronIcon,
  ClockIcon,
  CloseIcon,
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
  systemd: "systemd user service",
  "systemd-stopped": "systemd user service, stopped",
  none: "No matching service reported",
};

/** A fact the look established, or "Not reported". */
const NOT_REPORTED = "Not reported";
const serviceWords = (service: LookService | null) =>
  service ? SERVICE_WORDS[service] : NOT_REPORTED;

function runningFacts(look: SetupLook): Array<[string, string]> {
  return [
    ["Version", look.version ?? NOT_REPORTED],
    ["Profile", look.profile ?? NOT_REPORTED],
    [
      "Listens",
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
};

/** The found card and actions for each result of the look (§6). */
function LookResult({
  look,
  offer,
  onAdvanced,
  onAnother,
  confirming,
}: {
  look: SetupLook;
  offer: NonNullable<HostInfo["setup"]>;
  onAdvanced: () => void;
  onAnother: () => void;
  confirming: boolean;
}) {
  const send = useCommand();
  const lookAgain = () => void send({ type: "setupLook" });
  const advanced = <Primary onClick={onAdvanced}>Use Advanced</Primary>;
  switch (look.outcome) {
    case "running":
      return (
        <Found
          mark={<CheckIcon />}
          tone="ok"
          heading="OpenClaw is running"
          facts={runningFacts(look)}
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
              <Hint>{CONNECT_HINT[look.access ?? "new"]}</Hint>
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
          facts={runningFacts(look)}
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
            ["Port", `No gateway answered on port ${look.port}`],
          ]}
        >
          <Lede>Start OpenClaw yourself, then look again.</Lede>
          <Actions>
            <Primary onClick={lookAgain}>Look again</Primary>
          </Actions>
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
          heading="Clawtrate couldn't tell what is on this computer"
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
    next: "retry" | "look" | "back" | "advanced" | "bots";
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
  bots: {
    lead: "Connected, but Clawtrate couldn't read your bots.",
    text: () => "Try again, or go back.",
    next: "bots",
    step: 2,
  },
  cleanup: {
    lead: "Clawtrate couldn't close the connection it started.",
    text: () => "Go back to try again.",
    next: "back",
    step: 1,
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
  if (view !== "here") return view;
  return `${setup.phase}:${setup.look?.outcome ?? ""}:${setup.failure?.kind ?? ""}`;
}

export function SetupFlow({
  view,
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
    onView("first");
  };
  const lookHere = () => {
    onView("here");
    // A look the host never started (this window's commands refused) shows no progress.
    send({ type: "setupLook" }).catch(() => onView("first"));
  };
  const advanced = () => {
    if (view === "here") void send({ type: "setupReset" });
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
      view === "here" &&
      (setup.phase === "connecting" ||
        (setup.phase === "failed" && setup.failure?.kind !== "refused"))
    )
      backFromConnect();
    else toFirst();
  };

  let body: ReactNode;
  if (view === "first") {
    body = (
      <FirstScreen offer={offer} onThis={lookHere} onAnother={another} onAdvanced={advanced} />
    );
  } else if (view === "another") {
    body = (
      <>
        <Back onBack={toFirst} />
        <Mark />
        <Title id="setup-title">Another computer</Title>
        <Lede>
          Reaching another computer with SSH isn't in this version of Clawtrate yet. Use Advanced
          with that gateway's address and a token.
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
              {copy.next === "look" && (
                <Primary onClick={() => void send({ type: "setupLook" })}>Look again</Primary>
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
