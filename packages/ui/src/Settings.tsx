// Settings, opened with Cmd/Ctrl+, from any screen (bots.md section 7). Two
// panes: the list of sections, and the chosen one. Its Gateway pane shows the
// connection as it is (address, state, this device, the scopes the gateway
// granted) and offers Reconnect and Disconnect; Accounts lists the gateway's
// accounts; Check-ins shows each bot's check-ins. A modal dialog: focus stays
// inside it, Escape closes it, and focus returns to where it was.

import {
  INTERACTIVE_SCOPES,
  isApprovalDisconnect,
  scopeSatisfied,
  type AccountsState,
  type Bot,
  type CheckInsState,
  type ConnectionState,
  type RouteStatus,
  type HostInfo,
} from "@clawtrate/core";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import type { useDesktopUpdateSnapshot } from "./update-reading.ts";
import { Updates } from "./Updates.tsx";
import { useClawtrateState, useCommand } from "./bridge.tsx";
import { useAccountsSection } from "./bots/AccountsSection.tsx";
import { useCheckInsSection } from "./check-ins/CheckIns.tsx";
import { useUsageSection } from "./usage/UsageSection.tsx";
import { useMachinesSection } from "./machines/Machines.tsx";
import { Dialog } from "./bots/Dialog.tsx";
import { recall, remember } from "./bots/memory.ts";
import { useAnnouncer } from "./bots/parts.tsx";
import "./bots/bots.css";
import { CopyValue } from "./AccessBar.tsx";
import { CommandLine, failureTitle } from "./ConnectScreen.tsx";
import { gatewayLabel } from "./format.ts";
import { useForget } from "./forget.ts";
import { BackIcon, ChevronIcon, CloseIcon } from "./icons.tsx";

/** The connection's state, as the Gateway pane names it. */
export function gatewayState(connection: ConnectionState): string {
  switch (connection.status) {
    case "connected":
      // Re-pairing: the gateway holds this device's new authorization until its owner decides.
      return connection.upgrade.status === "requesting" || connection.upgrade.status === "pending"
        ? "Pairing pending"
        : "Connected";
    case "pairing":
      return "Pairing pending";
    case "disconnected":
      return "Disconnected";
    case "idle":
      return "Not connected";
    case "error":
      return "Offline";
    case "connecting":
    case "reconnecting":
      // An attempt under way is connecting; waiting for the next one is offline.
      return connection.retryAt === null ? "Connecting" : "Offline";
  }
}

/** The pane's error line: pairing rejected or expired, unreachable, protocol incompatible. */
function gatewayProblem(connection: ConnectionState): { title: string; message: string } | null {
  const error = connection.error;
  if (!error) return null;
  if (error.code === "PROTOCOL_MISMATCH") {
    return { title: "This gateway speaks another protocol", message: error.message };
  }
  if (error.code === "PAIRING_ENDED") {
    return { title: failureTitle(error.code), message: error.message };
  }
  if (connection.status === "connected") return null;
  if (isApprovalDisconnect(error.code)) return { title: "Disconnected", message: error.message };
  return {
    title: "Can't reach the gateway",
    message: [error.message, error.hint].filter(Boolean).join(" "),
  };
}

type Section =
  "gateway" | "accounts" | "conversation" | "usage" | "machines" | "checkins" | "updates";
const SECTIONS: Array<[Section, string]> = [
  ["gateway", "Gateway"],
  ["accounts", "Accounts"],
  ["conversation", "Conversation"],
  ["usage", "Usage"],
  ["machines", "Machines"],
  ["checkins", "Check-ins"],
  ["updates", "Updates"],
];

/** How long a bot's turn may run before Clawtrate stops it, in minutes; 50 by default (F-100). */
function ConversationPane({ announce }: { announce: (text: string) => void }) {
  const send = useCommand();
  const minutes = useClawtrateState().turnLimitMinutes ?? 50;
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const next = Number(draft);
    if (!Number.isInteger(next) || next < 1 || next > 1440) {
      setError("A turn time limit is a whole number of minutes from 1 to 1440.");
      return;
    }
    setError(null);
    setDraft(null);
    if (next === minutes) return;
    void send({ type: "setTurnLimit", minutes: next }).then(
      () => announce(`Turn time limit set to ${next} minutes`),
      (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)),
    );
  };
  return (
    <>
      <label className="b-field">
        <span>Turn time limit</span>
        <span className="turn-limit-field">
          <input
            className="input"
            type="number"
            inputMode="numeric"
            min={1}
            max={1440}
            step={1}
            value={draft ?? String(minutes)}
            data-testid="turn-limit"
            aria-describedby="turn-limit-note"
            aria-invalid={error ? true : undefined}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") commit();
            }}
          />
          <span aria-hidden="true">minutes</span>
        </span>
      </label>
      <p className="b-hint" id="turn-limit-note">
        Minutes. 50 by default. At the limit Clawtrate asks the gateway to stop the turn so it does
        not hang, and once the gateway confirms, the turn ends with a note naming the limit. Send a
        message to pick up where it left off. It applies to turns this device starts.
      </p>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
    </>
  );
}

/** ⌘, opens on the section last shown, Gateway the first time. */
const SHOWN_LAST = "settings-section";

/** The section Settings opens on: the one asked for, else the one shown last, else Gateway. */
export function openingSection<S extends string>(
  asked: S | null,
  remembered: S | null | undefined,
): S | "gateway" {
  return asked ?? remembered ?? "gateway";
}

function GatewayConnectionButton({ action }: { action: "retry" | "suspend" }) {
  const send = useCommand();
  const [failed, setFailed] = useState(false);
  const reconnect = action === "retry";
  const apply = () => {
    setFailed(false);
    void send({ type: action }).then(
      () => setFailed(false),
      () => setFailed(true),
    );
  };
  return (
    <>
      <button
        type="button"
        className="button"
        data-variant={reconnect ? "primary" : undefined}
        onClick={apply}
      >
        {reconnect ? "Reconnect" : "Disconnect"}
      </button>
      {failed && (
        <div className="form-error" role="alert">
          {reconnect
            ? "Could not reconnect to this gateway."
            : "Could not disconnect from this gateway."}
        </div>
      )}
    </>
  );
}

export function Settings({
  connection,
  info,
  accounts,
  checkIns,
  bots,
  initialUpdates,
  initialGateway = false,
  updateReading,
  onClose,
  route = null,
}: {
  connection: ConnectionState;
  /** The SSH route the app is connected through, when it is one (docs/design/setup.md §8). */
  route?: RouteStatus | null;
  info: HostInfo;
  accounts: AccountsState;
  checkIns: CheckInsState | undefined;
  bots: readonly Bot[];
  initialUpdates: boolean;
  /** Opened for the Gateway pane itself (an address route's Review, setup.md §9). */
  initialGateway?: boolean;
  updateReading: ReturnType<typeof useDesktopUpdateSnapshot>;
  onClose: () => void;
}) {
  const send = useCommand();
  const dialogRef = useRef<HTMLDivElement>(null);
  const asked = initialUpdates ? "updates" : initialGateway ? "gateway" : null;
  const [section, setSectionState] = useState<Section>(() =>
    openingSection(asked, recall<Section>(SHOWN_LAST)),
  );
  // On a phone the list comes first; a section asked for replaces it.
  const [pane, setPane] = useState<"nav" | "section">(asked ? "section" : "nav");
  const [announcer, announce] = useAnnouncer();
  const setSection = (next: Section) => {
    remember(SHOWN_LAST, next);
    // Focus the mounted heading during navigation, before the next key can reach a control.
    flushSync(() => {
      setSectionState(next);
      setPane("section");
    });
    dialogRef.current?.querySelector<HTMLElement>("#b-section-title")?.focus();
  };
  const { forget, failure: forgetProblem } = useForget();
  const gatewayUrl = connection.gatewayUrl;
  const state = gatewayState(connection);
  const problem = gatewayProblem(connection);
  const canReconnect = state === "Offline" || state === "Disconnected";
  const canDisconnect =
    connection.status === "connected" ||
    connection.status === "connecting" ||
    connection.status === "reconnecting";
  const deviceName =
    info.deviceName ?? (info.kind === "desktop" ? "Clawtrate Desktop" : "Clawtrate Web");
  // Re-pair (F-456): ask the gateway's owner for this device's interactive access. The old
  // authorization keeps working until they approve; then the new one replaces it.
  const upgrade = connection.upgrade;
  const holdsAll =
    connection.status === "connected" &&
    INTERACTIVE_SCOPES.every((scope) => scopeSatisfied(connection.scopes, scope));
  const rePairing = upgrade.status === "requesting" || upgrade.status === "pending";
  const canRePair = !info.readOnly && connection.status === "connected" && !holdsAll && !rePairing;
  const rePairProblem =
    upgrade.status === "rejected"
      ? "The gateway's owner rejected the new pairing. This device keeps its earlier access."
      : upgrade.status === "expired"
        ? "The pairing request expired before it was approved. This device keeps its earlier access."
        : upgrade.status === "error"
          ? `Couldn't re-pair. ${upgrade.error ?? ""}`.trim()
          : null;

  useEffect(() => {
    const dialog = dialogRef.current;
    const close = [...(dialog?.querySelectorAll<HTMLElement>(".settings-close") ?? [])].find(
      (each) => each.getClientRects().length > 0,
    );
    close?.focus();
  }, []);

  // An action replaces its own button (Disconnect gives way to Reconnect, and
  // back), which drops focus out of the dialog. Put it on the action that took
  // its place, or on Close, so focus and Escape stay in the dialog.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.contains(document.activeElement)) return;
    (
      dialog.querySelector<HTMLElement>(".settings-actions .button") ??
      dialog.querySelector<HTMLElement>(".settings-close")
    )?.focus();
  });

  const dot =
    state === "Connected"
      ? "connected"
      : state === "Connecting" || state === "Pairing pending"
        ? "connecting"
        : state === "Offline"
          ? "error"
          : "disconnected";

  const toNav = (
    <button
      type="button"
      className="icon-button b-back"
      data-variant="quiet"
      data-b="to-nav"
      aria-label="Back to settings"
      onClick={() => {
        setPane("nav");
        requestAnimationFrame(() =>
          dialogRef.current
            ?.querySelector<HTMLElement>('.b-nav-item[aria-current="page"]')
            ?.focus(),
        );
      }}
    >
      <BackIcon />
    </button>
  );
  const closeButton = (
    <button
      type="button"
      className="icon-button b-close settings-close"
      aria-label="Close settings"
      title="Close (Esc)"
      onClick={onClose}
    >
      <CloseIcon />
    </button>
  );

  const accountsSection = useAccountsSection({
    refreshOnOpen: !initialUpdates || section !== "updates",
    accounts,
    bots,
    connection,
    info,
    announce,
    toNav,
  });
  const usageSection = useUsageSection({ bots, connection, info, announce, toNav });
  const machinesSection = useMachinesSection({
    active: section === "machines",
    connection,
    info,
    bots,
    announce,
    toNav,
  });
  const checkInsSection = useCheckInsSection({
    active: section === "checkins",
    checkIns,
    bots,
    connection,
    info,
    announce,
    toNav,
  });

  const gatewayPane = (
    <>
      <dl className="facts" data-testid="gateway-facts">
        {route ? (
          <div>
            <dt>Route</dt>
            <dd className="b-wrap-value">{`Over SSH to ${route.account}, ${route.profile} profile`}</dd>
          </div>
        ) : (
          <div>
            <dt>Address</dt>
            <dd title={connection.gatewayUrl ?? undefined}>
              {connection.gatewayUrl ?? "None yet"}
            </dd>
          </div>
        )}
        <div>
          <dt>State</dt>
          <dd className="settings-state" data-testid="gateway-state">
            <span className="status-dot" data-status={dot} aria-hidden="true" />
            {state}
          </dd>
        </div>
        <div>
          <dt>This device</dt>
          <dd>
            {deviceName}
            {connection.deviceId ? ` · ${connection.deviceId.slice(0, 8)}` : ""}
          </dd>
        </div>
        <div>
          <dt>Granted scopes</dt>
          <dd data-testid="granted-scopes" className="b-wrap-value">
            {connection.status === "connected" && connection.scopes.length > 0
              ? connection.scopes.join(", ")
              : "None while not connected"}
          </dd>
        </div>
        {connection.serverVersion && (
          <div>
            <dt>Gateway</dt>
            <dd>
              OpenClaw {connection.serverVersion}
              {connection.protocol !== null ? ` · protocol ${connection.protocol}` : ""}
            </dd>
          </div>
        )}
      </dl>
      {problem && (
        <div className="form-error" role="alert" data-testid="gateway-problem">
          <strong>{problem.title}</strong>
          {problem.message}
        </div>
      )}
      {!info.readOnly && rePairProblem && !holdsAll && (
        <div className="form-error" role="alert" data-testid="repair-problem">
          {rePairProblem}
        </div>
      )}
      {!info.readOnly && connection.status === "connected" && rePairing && (
        <div className="settings-repair" data-testid="repair-pending">
          <p>
            Waiting for the gateway's owner to approve this device's new pairing. It changes by
            itself once they approve or reject it; until then this device keeps its earlier access.
          </p>
          {upgrade.approveCommand && (upgrade.approveTitle || upgrade.approveNote) && (
            <p className="approve-note">
              {upgrade.approveTitle && <b>{upgrade.approveTitle}</b>}
              {upgrade.approveTitle && upgrade.approveNote ? " " : ""}
              {upgrade.approveNote}
            </p>
          )}
          {upgrade.approveCommand && (
            <CommandLine command={upgrade.approveCommand} label="Copy approve command" />
          )}
          {upgrade.requestId && (
            <div className="access-id">
              <span className="mono">Request {upgrade.requestId.slice(0, 8)}</span>
              <CopyValue value={upgrade.requestId} label="Copy request id" />
            </div>
          )}
        </div>
      )}
      <div className="settings-actions">
        {canReconnect && <GatewayConnectionButton key={`retry:${gatewayUrl}`} action="retry" />}
        {canDisconnect && (
          <GatewayConnectionButton key={`suspend:${gatewayUrl}`} action="suspend" />
        )}
        {gatewayUrl && !route && (
          <button
            type="button"
            className="button"
            data-variant="quiet"
            onClick={() => {
              // Settings stays open until the gateway is forgotten, to say if it was not.
              void forget(gatewayUrl).then((forgotten) => {
                if (forgotten) onClose();
              });
            }}
          >
            Use another gateway
          </button>
        )}
        {route && (
          <button
            type="button"
            className="button"
            data-variant="quiet"
            onClick={() => void send({ type: "setupRemoveRoute" })}
          >
            Remove this gateway…
          </button>
        )}
      </div>
      {forgetProblem && (
        <div className="form-error" role="alert" data-testid="forget-problem">
          {forgetProblem}
        </div>
      )}
      {canRePair && (
        <div className="settings-repair-actions">
          <button
            type="button"
            className="button"
            data-size="sm"
            onClick={() => void send({ type: "requestAccess" }).catch(() => {})}
          >
            Re-pair
          </button>
        </div>
      )}
      {connection.gatewayUrl && (
        <p className="settings-note">
          {gatewayLabel(connection.gatewayUrl)} keeps this device's pairing while it is
          disconnected.{" "}
          {connection.canAdmin
            ? "This device holds admin access, which it asked for to change bots and accounts."
            : holdsAll
              ? "This device can send, stop and answer."
              : info.readOnly
                ? "This device asks for read access only."
                : "This device reads. Re-pair to ask for sending, stopping and answering."}
        </p>
      )}
    </>
  );

  let content: ReactNode;
  if (section === "accounts" && accountsSection.connect) content = accountsSection.connect;
  else {
    const view =
      section === "accounts" && accountsSection.view
        ? accountsSection.view
        : section === "checkins"
          ? checkInsSection
          : section === "conversation"
            ? {
                title: "Conversation",
                back: toNav,
                body: <ConversationPane announce={announce} />,
                foot: null,
              }
            : section === "usage"
              ? usageSection
              : section === "machines"
                ? machinesSection
                : section === "updates"
                  ? {
                      title: "Updates",
                      back: toNav,
                      foot: null,
                      body: <Updates {...updateReading} />,
                    }
                  : { title: "Gateway", back: toNav, body: gatewayPane, foot: null };
    content = (
      <>
        <header className="b-section-head">
          {view.back}
          <h3 id="b-section-title" tabIndex={-1}>
            {view.title}
          </h3>
        </header>
        <div className="b-section-body">{view.body}</div>
        {view.foot && <footer className="b-section-foot">{view.foot}</footer>}
      </>
    );
  }

  return (
    <Dialog kind="settings" labelledBy="settings-title" onClose={onClose} testId="settings">
      <div className="b-settings" data-pane={pane} ref={dialogRef}>
        <nav className="b-nav" aria-label="Settings">
          <div className="b-nav-head">
            <h2 id="settings-title">Settings</h2>
            {closeButton}
          </div>
          {SECTIONS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className="b-nav-item"
              aria-current={id === section ? "page" : undefined}
              onClick={() => setSection(id)}
            >
              {label}
              <ChevronIcon />
            </button>
          ))}
        </nav>
        <section className="b-section" aria-labelledby="b-section-title">
          {closeButton}
          {content}
        </section>
        {section !== "updates" && announcer}
      </div>
    </Dialog>
  );
}
