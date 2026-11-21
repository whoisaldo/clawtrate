// The full view of the bot's browser (work-pane.md, sections 17 and 18): a
// modal dialog on the dark theme's tokens, the control bar with its standing
// second line, and input that reaches the page only while this viewer holds
// the lease and the picture has focus. At phone width it is laid out for a
// thumb: zoom and pan on the device, a keyboard field, the controls in a dock.

import {
  barAnswerable,
  computerWords as words,
  type Bot,
  type ComputerInput,
  type ComputerPane,
  type QuestionCard,
} from "@clawtrate/core";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Avatar } from "../Avatar.tsx";
import { CollapseIcon, HandIcon, KeyboardIcon, MinusIcon, PlusIcon } from "../icons.tsx";
import { ONE_PANE_BELOW, useElementWidth } from "../layout.ts";
import { drawnPage, pictureWords, type FrameCanvases, type Picture } from "./frames.ts";
import {
  answered,
  emptyTyping,
  fieldText,
  callParts,
  nextCall,
  restart,
  sendAgain,
  typedInto,
  type Typing,
} from "./phone-typing.ts";

const glyph = (state: string) => <span className="glyph" data-state={state} aria-hidden="true" />;
const domainOf = (url: string) => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

export type ScreenViewProps = {
  bot: Bot;
  pane: ComputerPane;
  question: QuestionCard | null;
  canAnswer: boolean;
  frames: FrameCanvases;
  /** What the shown picture is: live, or the last one and its age. */
  age: Picture;
  onClose: () => void;
  onTake: () => void;
  onWatch: () => void;
  onCancel: () => void;
  onRelease: (answer: { questionId: string; itemId: string; option: number } | null) => void;
  onAnswerInChat: () => void;
  onCheck: () => void;
  onChoose: (targetId: string) => void;
  onShowQuestion: () => void;
  /** Sends input for the held tab; resolves true once the host accepted it, false if refused. */
  onInput: (input: ComputerInput) => Promise<boolean> | void;
};

/** The app's width decides the layout, as the rest of the shell does. */
function useAppWidth(): number {
  const width = () => document.querySelector(".app")?.clientWidth ?? window.innerWidth;
  const [value, setValue] = useState(width);
  useEffect(() => {
    const onResize = () => setValue(width());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return value;
}

/** Until the gateway confirms a release, control may still be held: no "Watching", no Take control. */
const holdingStates = [
  "draining",
  "granted",
  "unverified",
  "releasing",
  "unconfirmed",
  "answering",
];

export function ScreenView(props: ScreenViewProps) {
  const { bot, pane, frames } = props;
  const name = bot.name;
  const screenWidth = useAppWidth();
  const phone = screenWidth < ONE_PANE_BELOW;
  const control = pane.control;
  const granted = control.status === "granted";
  const holding = holdingStates.includes(control.status);
  const view = pane.view;
  const tab = pane.tabs.find((each) => each.targetId === pane.shown) ?? pane.tabs[0];
  const title = view?.title || tab?.title || "";
  const url = view?.url || tab?.url || "";
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showHint = (text: string) => {
    setHint(text);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(null), 3000);
  };
  const live = view?.status === "live";
  /** A view is open or opening: only then is anything being watched. */
  const watching = view !== null && view.status !== "ended";

  // The rest of the app is inert while the full view is open; focus starts on its first control.
  useLayoutEffect(() => {
    const shell = document.querySelector<HTMLElement>(".shell");
    if (shell) shell.inert = true;
    dialogRef.current
      ?.querySelector<HTMLElement>('[data-role="primary"], [data-role="close"]')
      ?.focus();
    return () => {
      if (shell) shell.inert = false;
    };
  }, []);

  // Every canvas the picture is drawn on, as it mounts: the phone's layout mounts a new one per mode.
  const showOn = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      canvasRef.current = canvas;
      if (!canvas) return;
      const stop = frames.attach(canvas);
      return () => {
        stop();
        if (canvasRef.current === canvas) canvasRef.current = null;
      };
    },
    [frames],
  );

  // A grant moves focus to the first answer or to Give back control.
  useEffect(() => {
    if (control.status === "granted")
      dialogRef.current
        ?.querySelector<HTMLElement>('[data-role="answer"], [data-role="release"]')
        ?.focus();
    if (control.status === "draining")
      dialogRef.current?.querySelector<HTMLElement>('[data-role="cancel"]')?.focus();
  }, [control.status]);

  /** A point of the picture as the page's own CSS pixels, from the drawn frame's header size. */
  const pagePoint = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const page = canvas && drawnPage(canvas);
    if (!canvas || !page || canvas.width === 0) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    // The picture is letterboxed in its box (object-fit: contain): only the picture counts.
    const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
    const left = rect.left + (rect.width - canvas.width * scale) / 2;
    const top = rect.top + (rect.height - canvas.height * scale) / 2;
    const x = ((clientX - left) / (canvas.width * scale)) * page.width;
    const y = ((clientY - top) / (canvas.height * scale)) * page.height;
    if (x < 0 || y < 0 || x > page.width || y > page.height) return null;
    return { x: Math.round(x), y: Math.round(y) };
  };

  // Input only while this viewer holds the lease, the current view has a drawn picture, and the
  // picture has focus: a view that ended leaves the frame focused with no page to see.
  const canSendInput = granted && live && props.age.kind !== "none";
  const inputAllowed = () => canSendInput && document.activeElement === frameRef.current;
  const wheel = useRef<{ dy: number; dx: number; x: number; y: number; timer: number | null }>({
    dy: 0,
    dx: 0,
    x: 0,
    y: 0,
    timer: null,
  });
  const inputSession = useRef(0);
  // A paste can take several calls. Later page input waits until it finishes.
  const inputOrder = useRef<Promise<void>>(Promise.resolve());
  const queueInput = (input: ComputerInput) => {
    const session = inputSession.current;
    inputOrder.current = inputOrder.current.then(async () => {
      if (session === inputSession.current) await props.onInput(input);
    });
  };
  const flushWheel = () => {
    const w = wheel.current;
    if (w.timer === null) return;
    window.clearTimeout(w.timer);
    w.timer = null;
    const { dx, dy, x, y } = w;
    w.dx = 0;
    w.dy = 0;
    if (inputAllowed() && (dy !== 0 || dx !== 0))
      queueInput({ kind: "scroll", x, y, deltaX: Math.round(dx), deltaY: Math.round(dy) });
  };
  /** A queued scroll or the rest of a paste belongs to the focused picture that received it. */
  const retireInput = () => {
    inputSession.current++;
    const w = wheel.current;
    if (w.timer !== null) window.clearTimeout(w.timer);
    w.timer = null;
    w.dx = 0;
    w.dy = 0;
  };
  useLayoutEffect(() => retireInput, [canSendInput, view?.n]);
  useLayoutEffect(() => {
    const element = frameRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      // As keys and clicks: only while in control and the picture has focus.
      if (!inputAllowed()) return;
      event.preventDefault();
      // Over the letterbox there is no page: nothing is scrolled.
      const point = pagePoint(event.clientX, event.clientY);
      if (!point) return;
      const w = wheel.current;
      w.dy += event.deltaY;
      w.dx += event.deltaX;
      w.x = point.x;
      w.y = point.y;
      if (w.timer !== null) return;
      w.timer = window.setTimeout(flushWheel, 80);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    element.addEventListener("blur", retireInput);
    return () => {
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("blur", retireInput);
    };
  });

  const onKeyDown = (event: KeyboardEvent) => {
    const inFrame = event.target === frameRef.current;
    // While the full view is open its keys are its own: the shell's Escape (which closes the
    // drawer) and its focus trap never see them, so a reflex never leaves the tab or hands back.
    if (event.key === "Escape" || event.key === "Tab" || event.metaKey || event.ctrlKey)
      event.stopImmediatePropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      // In control, Escape never hands back and is never sent to the page.
      if (holding)
        dialogRef.current
          ?.querySelector<HTMLElement>('[data-role="release"], [data-role="cancel"]')
          ?.focus();
      else props.onClose();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      dialogRef.current
        ?.querySelector<HTMLElement>('.control-bar [data-variant="primary"], [data-role="primary"]')
        ?.click();
      return;
    }
    if (inFrame && inputAllowed()) {
      if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        flushWheel();
        queueInput({ kind: "text", text: event.key });
        return;
      }
      if (event.key === "Enter" || event.key === "Backspace" || event.key === "Tab") {
        if (event.key !== "Tab") event.preventDefault();
        showHint(
          event.key === "Enter"
            ? "Enter isn't sent to the page. Click the page's button instead."
            : `${event.key} isn't sent to the page.`,
        );
        if (event.key !== "Tab") return;
      }
    }
    if (event.key === "Tab") {
      const items = [
        ...(dialogRef.current?.querySelectorAll<HTMLElement>(
          "button:not([disabled]), [tabindex='0'], input",
        ) ?? []),
      ];
      const first = items[0];
      const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  };

  // Caught before anything else on the page sees it (the shell listens on the window).
  const keys = useRef(onKeyDown);
  useLayoutEffect(() => {
    keys.current = onKeyDown;
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keys.current(event);
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, []);

  // A paste goes to the page only as an explicit paste, while in control.
  const onPaste = (event: React.ClipboardEvent) => {
    if (!inputAllowed()) return;
    event.preventDefault();
    const text = event.clipboardData.getData("text/plain");
    // In order, one call after another's answer: a refused part stops the rest, so nothing goes
    // after a gap, and what didn't go is said.
    // Flush any earlier wheel motion before adding the paste to the queue.
    flushWheel();
    const parts = callParts(text, 4);
    const session = inputSession.current;
    inputOrder.current = inputOrder.current.then(async () => {
      let sent = 0;
      for (const part of parts) {
        if (session !== inputSession.current) break;
        if ((await Promise.resolve(props.onInput({ kind: "text", text: part }))) === false) break;
        sent += part.length;
      }
      const left = [...text.slice(sent)].length;
      if (left > 0 && dialogRef.current)
        showHint(
          sent === 0
            ? "The paste wasn't sent. Try again in a moment."
            : `Only part of the paste was sent: the last ${left} characters weren't.`,
        );
    });
  };

  const onClick = (event: React.MouseEvent) => {
    if (!granted) return;
    frameRef.current?.focus();
    const point = pagePoint(event.clientX, event.clientY);
    if (point && inputAllowed()) {
      flushWheel();
      queueInput({ kind: "click", ...point });
    }
  };

  const bar = <ControlBar {...props} phone={phone} />;
  const frameName = `${name}'s browser, ${pictureWords(props.age).toLowerCase()}${granted ? ", you have control" : ""}`;
  const picture = (
    <div
      ref={frameRef}
      className="screen-frame"
      data-control={granted}
      tabIndex={0}
      role="application"
      aria-label={frameName}
      aria-describedby={granted ? "control-note" : undefined}
      data-testid="screen-frame"
      data-page-width={view?.width ?? undefined}
      data-page-height={view?.height ?? undefined}
      // Fitted to smaller stages, never larger than the page's own size.
      style={!phone && view?.width ? { maxWidth: view.width } : undefined}
      onClick={onClick}
      onPaste={onPaste}
    >
      {live ? (
        <>
          <canvas ref={showOn} className="screen-canvas" data-frame={view?.frame ?? 0} />
          {/* Live goes unsaid here ("Watching" is in the bar); a picture that isn't says so. */}
          {props.age.kind !== "live" && (
            <span className="screen-live screen-age" data-picture={props.age.kind} role="status">
              {pictureWords(props.age)}
            </span>
          )}
        </>
      ) : (
        <div className="screen-blank">
          {view?.status === "ended" ? (
            <>
              <p role="status">
                {words.viewEndLine(name, view.end ?? "gateway-ended", view.error)}
              </p>
              <button type="button" className="screen-watch" onClick={props.onWatch}>
                Watch again
              </button>
            </>
          ) : view ? (
            <>
              {glyph("working")}
              <p>{words.connectingLine(name)}</p>
            </>
          ) : (
            // No stream open, none opening: nothing is being watched.
            <>
              <p role="status">{words.noViewLine}</p>
              <button type="button" className="screen-watch" onClick={props.onWatch}>
                Watch
              </button>
            </>
          )}
        </div>
      )}
      <span className="screen-hint" role="status" hidden={!hint}>
        {hint}
      </span>
    </div>
  );

  const content = phone ? (
    <PhoneLayout
      key={granted ? "control" : "watching"}
      screenWidth={screenWidth}
      {...props}
      picture={picture}
      bar={bar}
      title={title}
      granted={granted}
      holding={holding}
    />
  ) : (
    <>
      <div className="viewer-bar screen-bar">
        <Avatar bot={bot} />
        <div className="viewer-title">
          <strong>{name}'s browser</strong>
          <span>
            {title}
            {url ? ` · ${domainOf(url)}` : ""}
          </span>
          {!holding && watching && <span className="screen-mode">Watching</span>}
        </div>
        {!holding && control.status !== "checking" && control.status !== "maybe-held" && (
          <button
            type="button"
            className="button"
            data-size="sm"
            data-role="primary"
            onClick={props.onTake}
          >
            <HandIcon />
            Take control
          </button>
        )}
        <button
          type="button"
          className="icon-button"
          data-role="close"
          aria-label="Close the full view (Esc)"
          title="Close (Esc)"
          onClick={props.onClose}
        >
          <CollapseIcon />
        </button>
      </div>
      {bar}
      {pane.tabs.length > 1 && (
        <div className="screen-pills" role="group" aria-label="Tabs">
          {pane.tabs.map((each) => (
            <button
              key={each.targetId}
              type="button"
              className="screen-pill"
              aria-pressed={each.targetId === pane.shown}
              onClick={() => props.onChoose(each.targetId)}
            >
              {each.title || "Untitled"}
            </button>
          ))}
        </div>
      )}
      <div className="screen-stage">{picture}</div>
    </>
  );

  return createPortal(
    <div
      ref={dialogRef}
      className="screen-view computer-dark"
      role="dialog"
      aria-modal="true"
      aria-label={`${name}'s browser`}
      data-layout={phone ? "phone" : undefined}
      data-testid="screen-view"
    >
      {content}
    </div>,
    document.querySelector(".app") ?? document.body,
  );
}

/** The control bar: every moment of section 18's table, in words. */
function ControlBar(props: ScreenViewProps & { phone: boolean }) {
  const { bot, pane, question, canAnswer } = props;
  const name = bot.name;
  const control = pane.control;
  const bar = (
    state: string | undefined,
    children: ReactNode,
    role: "status" | "alert" = "status",
  ) => (
    <div className="control-bar" data-state={state} role={role} data-testid="control-bar">
      {children}
    </div>
  );
  const button = (
    label: ReactNode,
    onClick: () => void,
    variant?: "primary" | "quiet",
    role?: string,
  ) => (
    <button
      type="button"
      className="button"
      data-size={props.phone ? undefined : "sm"}
      data-variant={variant}
      data-role={role}
      onClick={onClick}
    >
      {label}
    </button>
  );
  const elsewhere = pane.tabs.find((each) => each.targetId === pane.shown)?.lease;
  let body: ReactNode = null;
  switch (control.status) {
    case "draining":
      body = bar(
        undefined,
        <>
          {glyph("working")}
          <span>{words.waitingLine(name)}</span>
          <span className="spacer" />
          {button("Cancel", props.onCancel, undefined, "cancel")}
        </>,
      );
      break;
    case "busy":
    case "unsettled":
      body = bar(
        "refused",
        <>
          <span>{words.busyLine(name, control.busyReason)}</span>
          <span className="spacer" />
          {button("Try again", props.onTake, undefined, "primary")}
        </>,
        "alert",
      );
      break;
    case "conflict": {
      // Who has the tab, and how far, only from a read made after the refusal (the engine keeps
      // the tab's lease empty until then): asking is never said to be control.
      const held = pane.tabs.find((each) => each.targetId === control.targetId)?.lease;
      body = bar(
        undefined,
        <span>
          {!held || held.holder === "this-viewer"
            ? words.requestHeldLine
            : held.holder === "elsewhere"
              ? held.state === "draining"
                ? words.takingElsewhereLine(name)
                : words.elsewhereLine(name)
              : held.state === "draining"
                ? words.takingOtherWindowLine(name)
                : words.otherWindowLine(name)}
        </span>,
      );
      break;
    }
    case "ended":
      body = bar(
        undefined,
        <>
          <span>{words.controlEndedLine(control.endCause)}</span>
          {control.outcome && (
            <span className="control-gone">{words.outcomeLine(name, control.outcome)}</span>
          )}
          <span className="spacer" />
          {button(
            <>
              <HandIcon />
              Take control
            </>,
            props.onTake,
            undefined,
            "primary",
          )}
        </>,
        "alert",
      );
      break;
    case "releasing":
      body = bar(
        undefined,
        <>
          {glyph("working")}
          <span>{words.releasingLine}</span>
        </>,
      );
      break;
    case "unconfirmed":
      body = bar(
        "unconfirmed",
        <>
          <span>{words.unconfirmedLine(name)}</span>
          {control.outcome && (
            <span className="control-gone">{words.outcomeLine(name, control.outcome)}</span>
          )}
          <span className="spacer" />
          {button("Try again", () => props.onRelease(null), undefined, "release")}
          {button("Check", props.onCheck)}
        </>,
        "alert",
      );
      break;
    // A drop left the lease unknown: it is read before anything is offered, Take control too.
    case "maybe-held":
      body = bar("unconfirmed", <span>{words.droppedLine}</span>, "alert");
      break;
    case "checking":
      body = bar(
        undefined,
        <>
          {glyph("working")}
          <span>{words.checkingLine(name)}</span>
        </>,
      );
      break;
    case "unverified":
      body = bar(
        "unconfirmed",
        <>
          <span>{words.unverifiedLine(name)}</span>
          <span className="spacer" />
          {button("Check", props.onCheck, undefined, "primary")}
          {button("Give back control", () => props.onRelease(null), undefined, "release")}
        </>,
        "alert",
      );
      break;
    case "answering":
      body = bar(
        undefined,
        <>
          {glyph("working")}
          <span>{words.answeringLine}</span>
        </>,
      );
      break;
    case "granted": {
      const simple = canAnswer && barAnswerable(question);
      const item = question?.questions[0];
      const answers =
        simple && item
          ? item.options.map((option, i) => (
              <button
                key={option.index}
                type="button"
                className="button"
                data-size={props.phone ? undefined : "sm"}
                data-variant={i === 0 ? "primary" : undefined}
                data-role="answer"
                onClick={() =>
                  props.onRelease({
                    questionId: question!.id,
                    itemId: item.id,
                    option: option.index,
                  })
                }
              >
                {option.label}
              </button>
            ))
          : question && canAnswer
            ? button("Give back control and answer", props.onAnswerInChat, "primary", "answer")
            : null;
      body = (
        <>
          {bar(
            "control",
            <>
              <HandIcon />
              <strong>You have control</strong>
              {/* Read with it, right after it: what a grant guarantees, and no more. */}
              <span className="control-paused">{words.pausedLine(name)}</span>
              {control.questionGone && (
                <span className="control-gone">
                  {words.questionGoneLine(name, control.questionGone)}
                </span>
              )}
              <span className="spacer" />
              {control.questionGone ? null : answers}
              {button(
                "Give back control",
                () => props.onRelease(null),
                question && !control.questionGone && canAnswer ? "quiet" : "primary",
                "release",
              )}
            </>,
          )}
          {control.stillHeld && (
            <p className="control-note" role="status">
              {words.stillHeldLine}
            </p>
          )}
          {!props.phone && (
            <p className="control-note" id="control-note">
              {words.reachLine(name)}
            </p>
          )}
        </>
      );
      break;
    }
    default:
      if (control.outcome)
        body = bar(
          undefined,
          <>
            <span>{words.outcomeLine(name, control.outcome)}</span>
            {control.outcome === "answer-failed" && (
              <>
                <span className="spacer" />
                {button("Show the question", props.onShowQuestion)}
              </>
            )}
          </>,
        );
      else if (control.refusal)
        body = bar(undefined, <span>Couldn't ask for control. {control.refusal}</span>, "alert");
      else if (elsewhere && elsewhere.holder !== "this-viewer")
        body = bar(
          undefined,
          <span>
            {elsewhere.holder === "elsewhere"
              ? elsewhere.state === "draining"
                ? words.takingElsewhereLine(name)
                : words.elsewhereLine(name)
              : elsewhere.state === "draining"
                ? words.takingOtherWindowLine(name)
                : words.otherWindowLine(name)}
          </span>,
        );
      else if (props.phone)
        body = bar(
          undefined,
          button(
            <>
              <HandIcon />
              Take control
            </>,
            props.onTake,
            "primary",
            "primary",
          ),
        );
  }
  return <>{body}</>;
}

/** The phone's full view: zoom and pan are the device's alone (section 18, "On the phone"). */
function PhoneLayout(
  props: ScreenViewProps & {
    picture: ReactNode;
    bar: ReactNode;
    title: string;
    granted: boolean;
    holding: boolean;
    screenWidth: number;
  },
) {
  const { bot, pane, granted } = props;
  const name = bot.name;
  const zoomRef = useRef<HTMLDivElement | null>(null);
  const measured = useElementWidth(zoomRef);
  const [tabsOpen, setTabsOpen] = useState(false);
  const [typing, setTyping] = useState(false);
  // What the field holds and where each part of it is (`phone-typing.ts`): read in handlers.
  const [text, setText] = useState<Typing>(emptyTyping);
  /** The field's text while an input method composes; null otherwise. */
  const [composing, setComposing] = useState<string | null>(null);
  /** The field's text when the input method started composing. */
  const composedFrom = useRef<string | null>(null);
  const textRef = useRef<Typing>(emptyTyping);
  useLayoutEffect(() => {
    return () => {
      // Closing the full view retires the field just as Done does.
      textRef.current = restart(textRef.current);
    };
  }, []);
  const setTyped = (next: Typing) => {
    textRef.current = next;
    setText(next);
  };
  // Page input goes only while control is held and the current view has a drawn picture: the
  // field as much as the picture itself. Kept for handlers that answer later.
  const pageInput = granted && pane.view?.status === "live" && props.age.kind !== "none";
  const pageInputRef = useRef(pageInput);
  useLayoutEffect(() => {
    pageInputRef.current = pageInput;
  });
  /** Send the oldest text not accepted, one call at a time, in order. */
  const pump = () => {
    if (!pageInputRef.current) {
      // Nothing goes to a page that can't be seen: it waits, shown as not sent.
      if (textRef.current.unsent) setTyped({ ...textRef.current, held: true });
      return;
    }
    const call = nextCall(textRef.current);
    if (!call) return;
    setTyped(call.typing);
    void Promise.resolve(props.onInput({ kind: "text", text: call.text })).then((sent) => {
      // A call of a field closed since (Done, reopened, or the full view gone) says nothing of
      // the text typed now: no state is changed and nothing more is sent.
      if (call.session !== textRef.current.session) return;
      const ok = sent === true;
      setTyped(answered(textRef.current, ok, call.session));
      if (ok) pump();
      else {
        setHint("That wasn't taken: it waits below. Send it again in a moment.");
        setTimeout(() => setHint(null), 3000);
      }
    });
  };
  const [hint, setHint] = useState<string | null>(null);
  const pageWidth = pane.view?.width ?? 1280;
  const fit = Math.max(200, (measured ?? props.screenWidth) - 16);
  const levels = [...new Set([fit, fit * 2, pageWidth, fit * 4])].sort((a, b) => a - b);
  // Watching opens fitted; in control it opens at the page's own size.
  // Each mode starts its own layout (the component is keyed by it): the zoom, the field, the sheet.
  const [zoom, setZoom] = useState(() => (granted ? Math.max(0, levels.indexOf(pageWidth)) : 0));
  const width = levels[Math.min(zoom, levels.length - 1)]!;
  // In control the page opens at its own size, centred: this device does not know where the bot
  // last acted, so the middle of the page stands for it.
  useLayoutEffect(() => {
    const box = zoomRef.current;
    if (!box || !granted) return;
    box.scrollLeft = Math.max(0, (box.scrollWidth - box.clientWidth) / 2);
    box.scrollTop = Math.max(0, (box.scrollHeight - box.clientHeight) / 2);
  }, [granted, width]);
  return (
    <>
      <div className="viewer-bar screen-bar">
        <Avatar bot={bot} />
        <div className="viewer-title">
          <strong aria-label={`${name}'s browser`}>{name}</strong>
          <span className="screen-mode">
            {granted
              ? "You have control"
              : props.holding
                ? "Control"
                : props.pane.view && props.pane.view.status !== "ended"
                  ? "Watching"
                  : words.noViewLine}
          </span>
        </div>
        {pane.tabs.length > 1 && (
          <button
            type="button"
            className="screen-pill"
            aria-expanded={tabsOpen}
            aria-label={`${pane.tabs.length} tabs, showing ${props.title}`}
            onClick={() => setTabsOpen(!tabsOpen)}
          >
            {pane.tabs.length} tabs
          </button>
        )}
        <button
          type="button"
          className="icon-button"
          data-role="close"
          aria-label="Close the full view"
          title="Close"
          onClick={props.onClose}
        >
          <CollapseIcon />
        </button>
      </div>
      {tabsOpen && (
        <ul className="menu screen-tabs-sheet" role="menu" aria-label="Tabs">
          {pane.tabs.map((each) => (
            <li key={each.targetId} role="none">
              <button
                type="button"
                className="menu-item"
                role="menuitemradio"
                aria-checked={each.targetId === pane.shown}
                onClick={() => {
                  setTabsOpen(false);
                  props.onChoose(each.targetId);
                }}
              >
                {each.title || "Untitled"}
                <span>{domainOf(each.url)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="screen-stage">
        <div className="screen-zoom" ref={zoomRef} data-level={zoom}>
          {/* The picture is `width` wide: its 8 px margins each side are outside it. */}
          <div className="screen-zoom-inner" style={{ width: width + 16 }}>
            {props.picture}
          </div>
        </div>
        <div className="zoom-controls" role="group" aria-label="Zoom">
          <button
            type="button"
            className="icon-button"
            aria-label="Zoom out"
            disabled={zoom === 0}
            onClick={() => setZoom(Math.max(0, zoom - 1))}
          >
            <MinusIcon />
          </button>
          <button
            type="button"
            className="zoom-fit"
            aria-label="Fit the page to the screen"
            onClick={() => setZoom(0)}
          >
            Fit
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Zoom in"
            disabled={zoom >= levels.length - 1}
            onClick={() => setZoom(Math.min(levels.length - 1, zoom + 1))}
          >
            <PlusIcon />
          </button>
        </div>
        {granted && (
          <button
            type="button"
            className="icon-button keyboard-button"
            aria-label="Type into the page"
            aria-expanded={typing}
            onClick={() => {
              setTyping(!typing);
              setTyped(restart(textRef.current));
            }}
          >
            <KeyboardIcon />
          </button>
        )}
        {hint && (
          <span className="screen-hint" role="status">
            {hint}
          </span>
        )}
      </div>
      {granted && (
        <details className="control-help">
          <summary>What reaches the page</summary>
          <p id="control-note">{words.reachLine(name)}</p>
        </details>
      )}
      <div className="control-dock">{props.bar}</div>
      {granted && typing && (
        <div className="type-bar">
          <label className="visually-hidden" htmlFor="type-input">
            Type into the page
          </label>
          <input
            className="input"
            id="type-input"
            type="text"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="Type into the page"
            value={composing ?? fieldText(text)}
            autoFocus
            // An input method's text is the person's only once it is committed: until then the
            // field holds it as it is being composed, and nothing goes.
            onCompositionStart={(event) => {
              composedFrom.current = event.currentTarget.value;
              setComposing(event.currentTarget.value);
            }}
            onCompositionEnd={(event) => {
              setComposing(null);
              // Only what the input method added: text refused meanwhile is already held.
              const from = composedFrom.current ?? fieldText(textRef.current);
              composedFrom.current = null;
              setTyped(typedInto(textRef.current, event.currentTarget.value, from));
              pump();
            }}
            onChange={(event) => {
              if (composing !== null || (event.nativeEvent as InputEvent).isComposing) {
                setComposing(event.target.value);
                return;
              }
              // Each character typed goes as text, in order, once the host took the one before.
              setTyped(typedInto(textRef.current, event.target.value));
              pump();
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === "Enter") {
                event.preventDefault();
                setHint("Enter isn't sent to the page. Tap the page's button instead.");
                setTimeout(() => setHint(null), 3000);
              }
            }}
          />
          <button
            type="button"
            className="button"
            data-size="sm"
            onClick={() => {
              setTyping(false);
              setTyped(restart(textRef.current));
            }}
          >
            Done
          </button>
          {text.unsent && text.held && (
            <p className="type-unsent" role="status" data-testid="type-unsent">
              Not sent yet: <code>{text.unsent}</code>{" "}
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setTyped(sendAgain(textRef.current));
                  pump();
                }}
              >
                Send again
              </button>
            </p>
          )}
        </div>
      )}
    </>
  );
}
