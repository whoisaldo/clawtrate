import type {
  ConnectionError,
  ConnectionState,
  DiscoveryState,
  HostInfo,
  SetupState,
} from "@clawtrate/core";
import { SETUP_PAIRING_APPEARED, SETUP_PAIRING_GONE } from "@clawtrate/core";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import logoUrl from "./assets/logo-mark.png";
import { Character, type CharacterSpec } from "./Avatar.tsx";
import { useCommand } from "./bridge.tsx";
import { copyText, selectContents, type CopyResult } from "./clipboard.ts";
import { useForget } from "./forget.ts";
import { gatewayLabel } from "./format.ts";
import { BackIcon, CheckIcon, CopyIcon, EyeIcon } from "./icons.tsx";
import { SetupFlow, type SetupView } from "./setup/Setup.tsx";

export const PRODUCT_NAME = "Clawtrate";
export const SLOGAN = "Your OpenClaw agents, orchestrated.";

/** A command with a copy button that works over plain http too, or says how to copy by hand. */
export function CommandLine({ command, label }: { command: string; label: string }) {
  const [state, setState] = useState<"idle" | CopyResult>("idle");
  const codeRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (state !== "copied") return;
    const timer = setTimeout(() => setState("idle"), 1500);
    return () => clearTimeout(timer);
  }, [state]);
  const copy = async () => {
    const result = await copyText(command);
    if (result === "manual" && codeRef.current) selectContents(codeRef.current);
    setState(result);
  };
  const shortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘C" : "Ctrl+C";
  return (
    <>
      <div className="command">
        <code ref={codeRef}>{command}</code>
        <button
          type="button"
          className="icon-button"
          data-variant="quiet"
          aria-label={state === "copied" ? "Copied" : label}
          title={state === "copied" ? "Copied" : label}
          onClick={() => void copy()}
        >
          {state === "copied" ? <CheckIcon /> : <CopyIcon />}
        </button>
      </div>
      <p className="copy-status" role="status" aria-live="polite">
        {state === "copied"
          ? "Copied."
          : state === "manual"
            ? `Selected. Press ${shortcut} to copy.`
            : ""}
      </p>
    </>
  );
}

function Countdown({ until }: { until: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  // No retry waiting means an attempt is under way.
  if (until === null) return <> now</>;
  const seconds = Math.max(0, Math.ceil((until - now) / 1000));
  return <>{seconds > 0 ? ` in ${seconds}s` : " now"}</>;
}

type StepState = "done" | "current" | "pending";

/**
 * Setting up a gateway, one step at a time: connecting, pairing this device,
 * loading its bots. The app opens as soon as the bots have loaded.
 */
function SetupSteps({
  connection,
  loadingBots,
  pairingText,
}: {
  connection: ConnectionState;
  loadingBots: boolean;
  /** While pairing, the step says what it is waiting for. */
  pairingText?: ReactNode;
}) {
  const gateway = gatewayLabel(connection.gatewayUrl);
  const pairing = connection.status === "pairing";
  const reached = pairing || loadingBots;
  const steps: Array<{ state: StepState; label: ReactNode; waiting?: boolean }> = [
    reached
      ? { state: "done", label: `Connected to ${gateway}` }
      : { state: "current", label: `Connecting to ${gateway}` },
    loadingBots || (connection.paired && !pairing)
      ? { state: "done", label: "This device is paired" }
      : pairing
        ? { state: "current", label: pairingText ?? "Waiting for approval", waiting: true }
        : { state: "pending", label: "Pair this device" },
    loadingBots
      ? { state: "current", label: "Loading bots" }
      : { state: "pending", label: "Load bots" },
  ];
  return (
    <ol className="setup-steps" aria-label="Setting up" data-testid="setup-steps">
      {steps.map((step, index) => (
        <li
          key={index}
          data-state={step.state}
          aria-current={step.state === "current" ? "step" : undefined}
        >
          {step.waiting ? (
            <span className="status-dot" data-status="pairing" aria-hidden="true" />
          ) : (
            <span
              className="glyph"
              data-state={
                step.state === "done" ? "done" : step.state === "current" ? "working" : "queued"
              }
              aria-hidden="true"
            />
          )}
          <span role={step.state === "current" ? "status" : undefined}>{step.label}</span>
        </li>
      ))}
    </ol>
  );
}

/** A connection failure's title. */
export function failureTitle(code: string | null | undefined): string {
  switch (code) {
    case "PAIRING_ENDED":
      return "The pairing request is no longer pending";
    default:
      return "Could not connect";
  }
}

/** What a requested scope lets this device do, in plain words. */
const SCOPE_WORDS: Record<string, string> = {
  "operator.read": "Read bots, tasks and conversations",
};

function PairingPanel({ connection }: { connection: ConnectionState }) {
  const send = useCommand();
  const { forget, failure } = useForget();
  const gatewayUrl = connection.gatewayUrl;
  const pairing = connection.pairing!;
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  // While it checks, the button stays focusable (aria-disabled, not disabled),
  // so keyboard focus is still on it when a check finds nothing.
  const check = async () => {
    if (checking) return;
    setChecking(true);
    try {
      await send({ type: "retry" });
    } finally {
      setChecking(false);
      setChecked(true);
    }
  };
  return (
    <section className="panel" aria-labelledby="pair-title">
      <h2 id="pair-title">Approve this device</h2>
      <p className="panel-lede">
        {gatewayLabel(connection.gatewayUrl)} has not seen this device before. Approve it once on
        the gateway's machine and {PRODUCT_NAME} connects by itself.
      </p>
      {pairing.approveNote && <p className="approve-note">{pairing.approveNote}</p>}
      <CommandLine command={pairing.approveCommand} label="Copy approve command" />
      <SetupSteps
        connection={connection}
        loadingBots={false}
        pairingText={
          <>
            {checked ? "Not approved yet, checking again" : "Waiting for approval, checking again"}
            <Countdown until={connection.retryAt} />
          </>
        }
      />
      <ul className="scopes" aria-label="This device asks to">
        {pairing.requestedScopes.map((scope) => (
          <li key={scope} data-scope={scope}>
            <EyeIcon />
            {SCOPE_WORDS[scope] ?? scope}
          </li>
        ))}
      </ul>
      <div className="actions">
        <button
          type="button"
          className="button"
          data-size="lg"
          aria-disabled={checking || undefined}
          onClick={() => void check()}
        >
          {checking ? "Checking…" : "Check now"}
        </button>
        {gatewayUrl && (
          <button
            type="button"
            className="button"
            data-variant="quiet"
            data-size="lg"
            onClick={() => void forget(gatewayUrl)}
          >
            Use another gateway
          </button>
        )}
      </div>
      {failure && (
        <div className="form-error" role="alert" data-testid="forget-problem">
          {failure}
        </div>
      )}
    </section>
  );
}

function ConnectForm({ connection, info }: { connection: ConnectionState; info: HostInfo }) {
  const send = useCommand();
  const [url, setUrl] = useState(connection.gatewayUrl ?? info.devGateway?.url ?? "");
  const [token, setToken] = useState("");
  const [submitError, setSubmitError] = useState<{ title: string; message: string } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const busy = connection.status === "connecting";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!url.trim()) {
      setSubmitError({
        title: "Enter the gateway's address",
        message: "It looks like ws://host:port or wss://host.",
      });
      return;
    }
    setSubmitError(null);
    send({ type: "connect", url: url.trim(), token: token || null }).catch((error: unknown) =>
      setSubmitError({
        title: "Could not connect",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  const error = submitError
    ? { ...submitError, hint: null, code: null }
    : connection.error
      ? {
          title: failureTitle(connection.error.code),
          message: connection.error.message,
          hint: connection.error.hint,
          code: connection.error.code,
        }
      : null;
  // Try again repeats what failed: the saved gateway's connection, or this form.
  const tryAgain = () => {
    if (!submitError && connection.error && connection.gatewayUrl) void send({ type: "retry" });
    else formRef.current?.requestSubmit();
  };

  return (
    <section className="panel" aria-labelledby="connect-title">
      <h2 id="connect-title" className="visually-hidden">
        Connect to your gateway
      </h2>
      <form onSubmit={submit} noValidate ref={formRef}>
        <label className="field">
          <span className="visually-hidden">Gateway address</span>
          <input
            className="input"
            name="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="Gateway address"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span className="visually-hidden">Gateway token, for pairing</span>
          <input
            className="input"
            name="token"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="Gateway token, for pairing"
            autoComplete="off"
          />
        </label>
        {error && (
          <div className="form-error" role="alert">
            <strong>{error.title}</strong>
            {error.message}
            {error.hint && ` ${error.hint}`}
            {error.code && <span className="form-error-code">{error.code}</span>}
            <button type="button" className="button" data-size="sm" onClick={tryAgain}>
              Try again
            </button>
          </div>
        )}
        <div className="actions">
          <button
            type="submit"
            className="button"
            data-variant="primary"
            data-size="lg"
            disabled={busy}
          >
            {busy ? "Connecting…" : "Connect a gateway"}
          </button>
          {info.devGateway && (
            <button
              type="button"
              className="button"
              data-variant="quiet"
              data-size="lg"
              disabled={busy}
              title={`${gatewayLabel(info.devGateway.url)}, started with pnpm dev-gateway up`}
              onClick={() => void send({ type: "connectDevGateway" })}
            >
              Use the development gateway
            </button>
          )}
        </div>
        <p className="field-hint">
          {PRODUCT_NAME} works with an OpenClaw gateway you already run. It asks for read access
          only.
        </p>
      </form>
    </section>
  );
}

/** Connecting for the first time, and loading the bots once connected. */
function SetupPanel({
  connection,
  loadingBots,
}: {
  connection: ConnectionState;
  loadingBots: boolean;
}) {
  const send = useCommand();
  const { forget, failure } = useForget();
  const gatewayUrl = connection.gatewayUrl;
  const error = connection.error;
  return (
    <section className="panel" aria-labelledby="setup-title">
      <h2 id="setup-title" className="visually-hidden">
        Setting up {gatewayLabel(connection.gatewayUrl)}
      </h2>
      <SetupSteps connection={connection} loadingBots={loadingBots} />
      {error && !loadingBots && (
        <div className="form-error" role="alert">
          <strong>{failureTitle(error.code)}</strong>
          {error.message}
          {error.hint && ` ${error.hint}`}
          <button
            type="button"
            className="button"
            data-size="sm"
            onClick={() => void send({ type: "retry" })}
          >
            Try again
          </button>
        </div>
      )}
      {gatewayUrl && (
        <div className="actions">
          <button
            type="button"
            className="button"
            data-variant="quiet"
            data-size="lg"
            onClick={() => void forget(gatewayUrl)}
          >
            Use another gateway
          </button>
        </div>
      )}
      {failure && (
        <div className="form-error" role="alert" data-testid="forget-problem">
          {failure}
        </div>
      )}
    </section>
  );
}

/** The gateway speaks a protocol this client does not: nothing is asked of it. */
function ProtocolNotice({
  connection,
  error,
}: {
  connection: ConnectionState;
  error: ConnectionError;
}) {
  const send = useCommand();
  const { forget, failure } = useForget();
  const gatewayUrl = connection.gatewayUrl;
  const protocol = error.protocol;
  const retrying = connection.status === "connecting" || connection.status === "reconnecting";
  const gateway = gatewayLabel(connection.gatewayUrl);
  return (
    <section className="panel" aria-labelledby="protocol-title" data-testid="protocol-notice">
      <h2 id="protocol-title">This gateway speaks another protocol</h2>
      <p className="panel-lede">
        {protocol?.gateway === null || protocol?.gateway === undefined
          ? `${gateway} does not speak protocol ${protocol?.client ?? ""}, the one this version of ${PRODUCT_NAME} speaks.`
          : `${gateway} speaks protocol ${protocol.gateway}. This version of ${PRODUCT_NAME} speaks protocol ${protocol.client}.`}{" "}
        Update the one that is older, then retry.
      </p>
      <div className="actions">
        <button
          type="button"
          className="button"
          data-size="lg"
          aria-disabled={retrying || undefined}
          onClick={() => {
            if (!retrying) void send({ type: "retry" });
          }}
        >
          {retrying ? "Retrying…" : "Retry"}
        </button>
        {gatewayUrl && (
          <button
            type="button"
            className="button"
            data-variant="quiet"
            data-size="lg"
            onClick={() => void forget(gatewayUrl)}
          >
            Choose another gateway
          </button>
        )}
      </div>
      {failure && (
        <div className="form-error" role="alert" data-testid="forget-problem">
          {failure}
        </div>
      )}
    </section>
  );
}

/** The characters along the foot of the connection screens. Decoration only. */
const ENSEMBLE: Array<CharacterSpec & { size: number; sink: number; lean: number }> = [
  {
    body: "drop",
    color: "#45bdf5",
    tilt: 3,
    look: [0.3, 0.5],
    lift: 1,
    size: 132,
    sink: -0.3,
    lean: -8,
  },
  {
    body: "arch",
    color: "#ff8552",
    tilt: 5,
    look: [-0.7, 0.3],
    lift: -1.5,
    size: 176,
    sink: -0.26,
    lean: 5,
  },
  { body: "disc", color: "#f6bd3b", tilt: 6, look: [0.8, 0], size: 118, sink: -0.2, lean: -4 },
  { body: "block", color: "#5b8dff", tilt: 0, look: [0.9, 0.2], size: 204, sink: -0.3, lean: 3 },
  {
    body: "pebble",
    color: "#58c26f",
    tilt: -7,
    look: [0.6, -0.3],
    size: 160,
    sink: -0.24,
    lean: -6,
  },
  { body: "hex", color: "#ff6f9c", tilt: -4, look: [-0.8, 0.2], size: 124, sink: -0.26, lean: 7 },
  { body: "bloom", color: "#a98bff", tilt: -5, look: [0, -0.5], size: 186, sink: -0.28, lean: -3 },
  { body: "gem", color: "#a5d955", tilt: 0, look: [-0.4, -0.4], size: 122, sink: -0.24, lean: 4 },
];

function Ensemble() {
  return (
    <div className="ensemble" aria-hidden="true">
      {ENSEMBLE.map(({ size, sink, lean, ...spec }, index) => (
        <span
          key={index}
          className="avatar"
          style={
            {
              "--size": `${size}px`,
              "--sink": sink,
              "--tilt": `${lean}deg`,
            } as CSSProperties
          }
        >
          <Character spec={spec} />
        </span>
      ))}
    </div>
  );
}

export function ConnectScreen({
  connection,
  discovery,
  info,
  setup,
  mismatch = null,
  inert = false,
}: {
  connection: ConnectionState;
  discovery: DiscoveryState;
  info: HostInfo;
  /** Setting up on the host's computer, where the host offers it (`info.setup`). */
  setup?: SetupState | undefined;
  /** The latest protocol mismatch, kept while a retry repeats the handshake. */
  mismatch?: ConnectionError | null;
  /** Set while Settings covers the screen. */
  inert?: boolean;
}) {
  const pairing = connection.status === "pairing" && connection.pairing;
  const host = `${info.kind === "web" ? "Web preview" : "Desktop"} ${info.version}`;
  const loadingBots = connection.status === "connected" && discovery.status === "loading";
  const settingUp = loadingBots || connection.status === "connecting";
  // The first question, when the host offers setup and no gateway is saved (docs/design/setup.md §3).
  // A setup the host has under way (another window, or a reload) opens where it stands.
  const [view, setView] = useState<SetupView>(() =>
    setup && setup.phase !== "idle" ? "here" : "first",
  );
  const setupOwns =
    setup !== undefined &&
    (setup.phase === "confirming" ||
      setup.phase === "connecting" ||
      setup.phase === "failed" ||
      (setup.phase === "done" && connection.status !== "connected") ||
      // A saved pairing gone or appeared under setup's connection: its card asks again.
      (setup.phase === "found" &&
        (connection.error?.code === SETUP_PAIRING_GONE ||
          connection.error?.code === SETUP_PAIRING_APPEARED)));
  const noGateway = connection.status === "idle" && connection.gatewayUrl === null;
  const showSetup =
    info.setup !== undefined &&
    setup !== undefined &&
    (setupOwns || (noGateway && view !== "advanced"));
  // Advanced: the address-and-token form as it was, with Back to the first question.
  const advancedBack =
    info.setup !== undefined && view === "advanced" && noGateway ? () => setView("first") : null;
  // Advanced replaces the setup screens on the same screen, so focus moves here: to the
  // address field going in, to the question's title coming back. Not on launch.
  const card = useRef<HTMLDivElement>(null);
  const lastView = useRef(view);
  useEffect(() => {
    const from = lastView.current;
    lastView.current = view;
    if (from === view) return;
    if (view === "advanced") card.current?.querySelector<HTMLElement>("input")?.focus();
    else if (from === "advanced")
      card.current?.querySelector<HTMLElement>("[data-s-title]")?.focus();
  }, [view]);
  return (
    <main className="connect" inert={inert}>
      <div className="connect-drag" />
      <div className="connect-card" ref={card}>
        {mismatch ? (
          <>
            <header className="connect-brand">
              <img src={logoUrl} alt={PRODUCT_NAME} width={56} height={56} />
            </header>
            <ProtocolNotice connection={connection} error={mismatch} />
            <p className="connect-foot">
              {gatewayLabel(connection.gatewayUrl)}
              {connection.serverVersion ? ` · OpenClaw ${connection.serverVersion}` : ""} · {host}
            </p>
          </>
        ) : pairing ? (
          <>
            <header className="connect-brand">
              <img src={logoUrl} alt={PRODUCT_NAME} width={56} height={56} />
            </header>
            <PairingPanel connection={connection} />
            <p className="connect-foot">
              Request {pairing.requestId.slice(0, 8)} · this device{" "}
              {(connection.deviceId ?? pairing.deviceId).slice(0, 8)} · {host}
            </p>
          </>
        ) : showSetup ? (
          <SetupFlow
            view={view === "advanced" ? "here" : view}
            onView={setView}
            setup={setup!}
            connection={connection}
            info={info}
          />
        ) : (
          <>
            {advancedBack && (
              <div className="s-top">
                <button
                  type="button"
                  className="button"
                  data-variant="quiet"
                  data-size="sm"
                  onClick={advancedBack}
                >
                  <BackIcon />
                  Back
                </button>
              </div>
            )}
            <header className="connect-brand">
              <img src={logoUrl} alt="" width={56} height={56} />
              <h1>{PRODUCT_NAME}</h1>
              <p>{SLOGAN}</p>
            </header>
            {settingUp ? (
              <SetupPanel connection={connection} loadingBots={loadingBots} />
            ) : (
              <ConnectForm connection={connection} info={info} />
            )}
            <p className="connect-foot">
              {connection.deviceId
                ? `This device ${connection.deviceId.slice(0, 8)}`
                : "Preparing device identity…"}
              {" · "}
              {host}
            </p>
          </>
        )}
      </div>
      <Ensemble />
    </main>
  );
}
