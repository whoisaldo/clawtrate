// Pieces the account screens share (docs/design/bots.md, section 2): notes,
// results, the waiting line, commands and codes with their copy buttons, the
// model and effort selects, the access bar for admin, and the announcer.

import { APPROVAL_WORDS, type ConnectionState, type HostInfo } from "@clawtrate/core";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useCommand } from "../bridge.tsx";
import { copyText } from "../clipboard.ts";
import { Menu, type MenuEntry } from "../Menu.tsx";
import {
  CheckIcon,
  ChevronIcon,
  ClockIcon,
  CloseIcon,
  CopyIcon,
  EyeIcon,
  WarnIcon,
} from "../icons.tsx";
import { CopyValue } from "../AccessBar.tsx";
import { approvalShelf, WaitingRow } from "../ApprovalWait.tsx";
import { useOpenSettings } from "../settings-open.tsx";

/** A sentence on a soft fill: neutral, something to act on, or a failure. */
export function Note({
  tone,
  icon,
  children,
  testId,
}: {
  tone?: "warn" | "danger" | undefined;
  icon?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div className="b-note" data-tone={tone} data-testid={testId}>
      {icon ?? (tone ? <WarnIcon /> : <ClockIcon />)}
      <div>{children}</div>
    </div>
  );
}

/** How a stage ended: the empty mark with a state in it, a title and a sentence. */
export function Result({
  tone,
  mark,
  title,
  children,
  focus = true,
}: {
  tone: "ok" | "warn" | "danger" | "";
  mark: "check" | "clock" | "warning" | "x";
  title: string;
  children?: ReactNode;
  /** The title takes focus when the stage shows; not where a field after it should. */
  focus?: boolean;
}) {
  const icon =
    mark === "check" ? (
      <CheckIcon />
    ) : mark === "clock" ? (
      <ClockIcon />
    ) : mark === "x" ? (
      <CloseIcon />
    ) : (
      <WarnIcon />
    );
  return (
    <div className="b-result">
      <span className="empty-mark" data-tone={tone || undefined}>
        {icon}
      </span>
      <h3 tabIndex={-1} data-b-focus={focus ? "" : undefined}>
        {title}
      </h3>
      {children && <p>{children}</p>}
    </div>
  );
}

/** The pairing screen's waiting line, flush left: a live region with the pulsing dot. */
export function Wait({ children }: { children: ReactNode }) {
  return (
    <p className="b-wait" role="status">
      <span className="status-dot" data-status="connecting" />
      {children}
    </p>
  );
}

/** A command to run on the gateway's machine. It breaks between words, never inside one. */
export function CommandBlock({
  command,
  label,
  onCopied,
}: {
  command: string;
  label: string;
  onCopied?: () => void;
}) {
  const [state, setState] = useState<"idle" | "copied" | "manual">("idle");
  const codeRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 1400);
    return () => clearTimeout(timer);
  }, [state]);
  const copy = async () => {
    const result = await copyText(command);
    if (result === "manual" && codeRef.current) {
      const range = document.createRange();
      range.selectNodeContents(codeRef.current);
      const selection = getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    setState(result);
    onCopied?.();
  };
  return (
    <>
      <div className="command command-line" data-testid="command">
        <code ref={codeRef}>
          {command.split(" ").map((token, index) => (
            <span key={index}>
              {index > 0 ? " " : ""}
              <span className="b-tok">{token}</span>
            </span>
          ))}
        </code>
        <button
          type="button"
          className="icon-button copy"
          data-variant="quiet"
          aria-label={label}
          title={state === "copied" ? "Copied" : label}
          data-copied={state === "copied" || undefined}
          onClick={() => void copy()}
        >
          {state === "copied" ? <CheckIcon /> : <CopyIcon />}
        </button>
      </div>
      <p className="visually-hidden" role="status">
        {state === "copied"
          ? "Copied command"
          : state === "manual"
            ? "The command is selected. Copy it with your keyboard."
            : ""}
      </p>
    </>
  );
}

/** A code to type on the provider's page: large, mono, read in parts. */
export function CodeBlock({ code }: { code: string }) {
  return (
    <div className="b-code" role="group" aria-label={`Code ${code.replace(/-/g, " ")}`}>
      <code>{code}</code>
      <CopyValue value={code} label="Copy code" />
    </div>
  );
}

/** A select: a label over its value and a chevron, opening a `.menu` of choices under it. */
export function Select({
  label,
  value,
  choices,
  onChoose,
  disabled,
  testId,
}: {
  label: string;
  value: string;
  choices: Array<{ value: string; label: string; disabled?: boolean; note?: string }>;
  onChoose: (value: string) => void;
  disabled?: boolean;
  testId?: string;
}) {
  // Where the menu opens: the select's own box, taken when it opens.
  const [anchor, setAnchor] = useState<{ rect: DOMRect; element: HTMLButtonElement } | null>(null);
  const open = anchor !== null;
  const close = useCallback(
    (refocus: boolean) => {
      const element = anchor?.element;
      setAnchor(null);
      if (refocus) element?.focus();
    },
    [anchor],
  );
  const openFrom = (element: HTMLButtonElement) =>
    setAnchor({ rect: element.getBoundingClientRect(), element });
  const entries: MenuEntry[] = choices.map((choice) => ({
    kind: "radio",
    label: choice.label,
    checked: choice.value === value,
    ...(choice.note ? { note: choice.note } : {}),
    onSelect: () => {
      if (choice.disabled) return;
      close(true);
      onChoose(choice.value);
    },
  }));
  const shown = choices.find((choice) => choice.value === value)?.label ?? value;
  const rect = anchor?.rect ?? null;
  return (
    <>
      <button
        type="button"
        className="b-select"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label}: ${shown}`}
        disabled={disabled || choices.length === 0}
        data-testid={testId}
        onClick={(event) => (open ? setAnchor(null) : openFrom(event.currentTarget))}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            openFrom(event.currentTarget);
          }
        }}
      >
        <small>{label}</small>
        <span>{shown}</span>
        <ChevronIcon />
      </button>
      {open && rect && anchor && (
        <Menu
          label={label}
          entries={entries}
          onClose={close}
          trigger={anchor.element}
          className="b-menu"
          style={{
            position: "fixed",
            left: Math.max(8, Math.min(rect.left, innerWidth - 228)),
            top: Math.min(rect.bottom + 6, innerHeight - 8 - 36 * choices.length),
            minWidth: Math.max(200, rect.width),
          }}
        />
      )}
    </>
  );
}

/** One polite live region and a way to speak into it. */
export function useAnnouncer(): [ReactNode, (text: string) => void] {
  const [text, setText] = useState("");
  const announce = useCallback((next: string) => {
    setText("");
    requestAnimationFrame(() => setText(next));
  }, []);
  const node = (
    <p className="visually-hidden" role="status" aria-live="polite" data-testid="b-announcer">
      {text}
    </p>
  );
  return [node, announce];
}

/** Whether the request under way asks for admin. */
export function askingAdmin(connection: ConnectionState): boolean {
  return connection.upgrade.scopes.includes("operator.admin");
}

/**
 * The access bar of conversation.md section 3, asking for admin, with this
 * screen's words (bots.md section 2). The command and the request id are the
 * host's. The engine waits on the gateway's answer continuously, as the
 * conversation's bar says, so there is no countdown; "Check now" and "Stop
 * waiting" are setup.md §9's.
 */
export function AdminBar({
  connection,
  info,
  need,
}: {
  connection: ConnectionState;
  info: HostInfo;
  need: string;
}) {
  const send = useCommand();
  const openSettings = useOpenSettings();
  const ask = () => void send({ type: "requestAccess", tier: "admin" }).catch(() => {});
  const upgrade = connection.upgrade;
  const mine = askingAdmin(connection);
  const status = mine ? upgrade.status : "idle";
  const readOnly = info.readOnly || !connection.canWrite;
  let body: ReactNode;
  let action: ReactNode = null;
  let tone: "danger" | undefined;
  const shelf =
    info.readOnly || !mine
      ? null
      : approvalShelf(connection, send, ask, "sm", info.setup !== undefined, openSettings);
  if (info.readOnly) {
    body = (
      <>
        <b>Read-only.</b> {need} This connection only reads.
      </>
    );
  } else if (shelf) {
    body = shelf.body;
    action = shelf.action;
    tone = shelf.tone;
  } else if (status === "requesting") body = "Asking the gateway…";
  else if (status === "rejected") {
    body = (
      <>
        <b>The request was denied.</b> Nothing changed. This device keeps the access it had.
      </>
    );
    action = (
      <button type="button" className="button" data-size="sm" onClick={ask}>
        Request again
      </button>
    );
  } else if (status === "expired") {
    body = (
      <>
        <b>The request expired</b> before it was approved.
      </>
    );
    action = (
      <button type="button" className="button" data-size="sm" onClick={ask}>
        Request again
      </button>
    );
  } else if (status === "error") {
    tone = "danger";
    body = (
      <>
        <b>Couldn't send the request.</b> {upgrade.error}
      </>
    );
    action = (
      <button type="button" className="button" data-size="sm" onClick={ask}>
        Try again
      </button>
    );
  } else {
    body = (
      <>
        <b>{readOnly ? "Read-only." : "Admin access needed."}</b> {need}
      </>
    );
    action = (
      <button type="button" className="button" data-variant="primary" data-size="sm" onClick={ask}>
        Request admin access
      </button>
    );
  }
  if ((connection.status !== "connected" && !shelf?.offline) || info.readOnly) action = null;
  const pending = status === "pending";
  return (
    <section
      className="access-bar"
      role="region"
      aria-label="Access"
      data-tone={tone}
      data-status={info.readOnly ? "pinned" : status}
      data-testid="admin-bar"
    >
      <div className="access-row">
        <EyeIcon />
        <span className="shelf-text" aria-live="polite">
          {body}
        </span>
        {action}
      </div>
      {pending && upgrade.approveCommand && (
        <CommandBlock command={upgrade.approveCommand} label="Copy approve command" />
      )}
      {pending && (
        <p className="access-wait">
          This changes by itself as soon as the owner approves or denies the request, or it expires.
        </p>
      )}
      {pending && (
        <WaitingRow
          upgrade={upgrade}
          copy={
            upgrade.requestId && <CopyValue value={upgrade.requestId} label="Copy request id" />
          }
        />
      )}
    </section>
  );
}

/**
 * "Admin access granted. You can change this now." for 4 seconds after the
 * grant, then the screen's own action takes the bar's place.
 */
export function useGranted(connection: ConnectionState): boolean {
  const [granted, setGranted] = useState(false);
  const [had, setHad] = useState(connection.canAdmin);
  if (connection.canAdmin !== had) {
    setHad(connection.canAdmin);
    if (connection.canAdmin && askingAdmin(connection) && connection.upgrade.status === "approved")
      setGranted(true);
  }
  useEffect(() => {
    if (!granted) return;
    const timer = setTimeout(() => setGranted(false), 4000);
    return () => clearTimeout(timer);
  }, [granted]);
  return granted;
}

/** How long the bar says the gateway now shows the access, after a wait it lost, before Granted. */
export const RECOVERED_FOR_MS = 2000;

/**
 * Granted. After a wait this device lost (`nowShown`, setup §9), it first
 * says, once, in its live region, that the gateway now shows the requested
 * access.
 */
export function GrantedBar({ nowShown = false }: { nowShown?: boolean }) {
  const [recovered, setRecovered] = useState(nowShown);
  useEffect(() => {
    if (!recovered) return;
    const timer = setTimeout(() => setRecovered(false), RECOVERED_FOR_MS);
    return () => clearTimeout(timer);
  }, [recovered]);
  return (
    <section
      className="access-bar"
      role="region"
      aria-label="Access"
      data-status="granted"
      data-testid="admin-bar"
    >
      <div className="access-row">
        <CheckIcon />
        <span className="shelf-text" role="status">
          {recovered ? (
            APPROVAL_WORDS.nowShown
          ) : (
            <>
              <b>Admin access granted.</b> You can change this now.
            </>
          )}
        </span>
      </div>
    </section>
  );
}
