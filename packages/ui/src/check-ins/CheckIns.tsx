// A bot's check-ins (automation.md section 13): each bot's block, read from
// its heartbeat job, and with admin the dialog that sets it. The Routines
// view shows the one bot's block above its routines and each group head's
// cadence in the list across bots; Settings shows every bot's blocks as a
// section of its own.
//
// The dialog is mounted only while the connection holds admin, whatever
// opened it: below admin there is nothing that changes anything, and admin
// is asked for only by the access bar's button. Its draft (draft.ts) lives in
// the section, not the dialog, so admin that drops and returns finds it again,
// for the same gateway, by its identity, and bot only. A save's outcome is
// shown only in the dialog whose draft made it (`checkIns.save.id`).

import {
  cannotKeep,
  CHECKIN_BOT_DELETED,
  MAX_CHECKIN_PROMPT_CHARS,
  type Bot,
  type CheckInsState,
  type CheckInRead,
  type ConnectionState,
  type HostInfo,
} from "@clawtrate/core";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useBridge } from "../bridge.tsx";
import { Avatar } from "../Avatar.tsx";
import { CheckIcon, CloseIcon } from "../icons.tsx";
import { Dialog } from "../bots/Dialog.tsx";
import { AdminBar, GrantedBar, Note, Select, useGranted } from "../bots/parts.tsx";
import { clock } from "../bots/words.ts";
import type { SectionView } from "../bots/AccountsSection.tsx";
import { draftToSave, openDraft, rebase, type Draft } from "./draft.ts";
import {
  choiceWords,
  promptKind,
  DEFAULT_PROMPT,
  EVERY_CHOICES,
  sentence,
  summary,
  type Choice,
} from "./words.ts";
import "./check-ins.css";

const CHOICES: Array<[Choice, string]> = [
  ["off", "Off"],
  ["daily", "Daily"],
  ["asneeded", "As needed"],
  ["every", "Every…"],
];

export function useCheckInsSection({
  active,
  checkIns,
  bots,
  connection,
  info,
  announce,
  toNav,
}: {
  /** The section is the one shown: entering it, and the connection coming back, read again. */
  active: boolean;
  checkIns: CheckInsState | undefined;
  bots: readonly Bot[];
  connection: ConnectionState;
  info: HostInfo;
  announce: (text: string) => void;
  toNav: ReactNode;
}): SectionView {
  const bridge = useBridge();
  const [draft, setDraft] = useState<Draft | null>(null);
  const granted = useGranted(connection);
  const admin = connection.canAdmin;
  const connected = connection.status === "connected";
  const refresh = () => void bridge.send({ type: "refreshCheckIns" }).catch(() => {});
  // The bots are listed after the connection is: a reconnect reads again once they arrive.
  const roster = bots.map((bot) => bot.id).join("\n");

  useEffect(() => {
    if (active && connected) void bridge.send({ type: "refreshCheckIns" }).catch(() => {});
  }, [bridge, active, connected, roster]);

  const jobOf = (botId: string) => checkIns?.jobs.find((job) => job.botId === botId);
  const editingBot = bots.find((bot) => bot.id === draft?.botId);
  // A draft belongs to the gateway it was made on, by identity; no other one shows it.
  const draftHere =
    draft !== null && connected && draft.gatewayId === checkIns?.gatewayId && editingBot;

  const edit = (bot: Bot) => {
    const next = checkIns && openDraft(checkIns, bot.id);
    if (next) setDraft(next);
  };
  const refreshButton = checkIns && (
    <button
      type="button"
      className="button"
      data-size="sm"
      data-variant="quiet"
      disabled={!connected || checkIns.status === "loading"}
      onClick={refresh}
    >
      Refresh
    </button>
  );

  let body: ReactNode;
  if (!checkIns || (checkIns.status === "loading" && checkIns.jobs.length === 0)) {
    body = <p className="ci-faint">Reading check-ins…</p>;
  } else if (checkIns.status === "error") {
    body = (
      <>
        <div className="form-error" role="alert">
          <strong>Couldn't read check-ins</strong>
          {checkIns.error}
        </div>
        <div className="ci-intro">{refreshButton}</div>
      </>
    );
  } else {
    body = (
      <>
        <div className="ci-intro">
          <p>
            A bot that checks in gets a turn on a schedule to look for anything that needs you. The
            gateway can skip a scheduled attempt.
          </p>
          {refreshButton}
        </div>
        {checkIns.scheduler === false && (
          <Note tone="warn" testId="scheduler-off">
            <p>
              <b>The gateway's scheduler is off,</b> so scheduled check-ins don't run.
            </p>
          </Note>
        )}
        <div className="ci-list" data-testid="check-ins">
          {bots.map((bot) => {
            if (!checkIns.readBotIds?.includes(bot.id)) return null;
            const job = jobOf(bot.id);
            const next =
              job?.enabled && checkIns.scheduler !== false && job.nextRunAtMs !== null
                ? `Next scheduled attempt ${clock(job.nextRunAtMs)}`
                : null;
            return (
              <section
                key={bot.id}
                className="ci-block"
                aria-labelledby={`ci-${bot.id}`}
                data-testid="check-in"
                data-bot={bot.id}
              >
                <div className="ci-head">
                  <Avatar bot={bot} className="ci-avatar" />
                  <h4 id={`ci-${bot.id}`}>{bot.name}</h4>
                  <span className="ci-summary">{summary(job)}</span>
                  {admin && (
                    <button
                      type="button"
                      className="button"
                      data-size="sm"
                      aria-label={`Change ${bot.name}'s check-ins`}
                      disabled={checkIns.gatewayId === null}
                      onClick={() => edit(bot)}
                    >
                      Change
                    </button>
                  )}
                </div>
                <p data-testid="check-in-text">
                  {sentence(bot.name, job, checkIns.settings, checkIns.defaults)}
                </p>
                {next && <p className="ci-faint">{next}</p>}
              </section>
            );
          })}
        </div>
      </>
    );
  }

  return {
    title: "Check-ins",
    back: toNav,
    body: (
      <>
        {body}
        {admin && checkIns && draftHere && (
          <CheckInsDialog
            bot={editingBot}
            bots={bots}
            checkIns={checkIns}
            draft={draft}
            change={(next) =>
              setDraft((each) =>
                each ? { ...each, ...(typeof next === "function" ? next(each) : next) } : each,
              )
            }
            refresh={() => bridge.invoke({ type: "refreshCheckIns", botId: editingBot.id })}
            announce={announce}
            onClose={() => setDraft(null)}
          />
        )}
      </>
    ),
    foot: granted ? (
      <GrantedBar nowShown={connection.upgrade.nowShown === true} />
    ) : admin ? null : (
      <AdminBar connection={connection} info={info} need="Changing check-ins needs admin access." />
    ),
  };
}

function CheckInsDialog({
  bot,
  bots,
  checkIns,
  draft,
  change,
  refresh,
  announce,
  onClose,
}: {
  bot: Bot;
  bots: readonly Bot[];
  checkIns: CheckInsState;
  draft: Draft;
  change: (next: Partial<Draft> | ((draft: Draft) => Partial<Draft>)) => void;
  refresh: () => Promise<CheckInRead | null>;
  announce: (text: string) => void;
  onClose: () => void;
}) {
  const bridge = useBridge();
  const setting = checkIns.settings?.find((each) => each.botId === bot.id);
  const { choice, every, prompt, saveId, refused, base, touched } = draft;
  // The id of a save sent but not yet published by the host; it blocks a second click in the same frame.
  const submitting = useRef<string | null>(null);
  const [pending, setPending] = useState(false);
  const groupRef = useRef<HTMLUListElement>(null);
  const save = checkIns.save?.id === saveId ? checkIns.save : null;
  // Once the host publishes this save, its status decides, even before the command settles.
  const saving = save ? save.status === "saving" : pending;
  const unpublished = () => submitting.current !== null && checkIns.save?.id !== submitting.current;
  const waitingForBase = save?.status === "conflict" && draft.rebased !== save.id;
  const deleted = save?.status === "conflict" && save.error === CHECKIN_BOT_DELETED;
  const [checking, setChecking] = useState(false);
  const setChoice = (next: Choice) =>
    change({ choice: next, touched: { ...touched, every: true } });

  // After a conflict, wait for the snapshot that shows what changed.
  const rebaseOn =
    save && draft.rebased !== save.id && checkIns.status === "ready" && save.status === "conflict"
      ? save.id
      : null;
  useEffect(() => {
    if (rebaseOn) change({ ...rebase(draft, checkIns), rebased: rebaseOn });
  }, [rebaseOn, draft, checkIns, change]);

  useEffect(() => {
    if (save?.status !== "saved") return;
    announce("Check-ins saved");
    void bridge.send({ type: "dismissCheckInSave", saveId: save.id }).catch(() => {});
    onClose();
  }, [save?.status, save?.id, announce, bridge, onClose]);

  const ended =
    refused !== null ||
    save?.status === "failed" ||
    save?.status === "unknown" ||
    save?.status === "conflict";
  const outcomeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ended) outcomeRef.current?.scrollIntoView({ block: "nearest" });
  }, [ended, save?.status, draft.rebased]);

  // While a save is under way the dialog waits for its answer, Escape included.
  const close = () => {
    if (saving || unpublished()) return;
    if (saveId) void bridge.send({ type: "dismissCheckInSave", saveId }).catch(() => {});
    onClose();
  };
  const submit = () => {
    if (saving || unpublished() || waitingForBase) return;
    const id = crypto.randomUUID();
    submitting.current = id;
    setPending(true);
    change({ saveId: id, refused: null });
    bridge
      .send({ type: "saveCheckIn", saveId: id, botId: bot.id, ...draftToSave(draft) })
      .catch((error: unknown) => {
        const refused = error instanceof Error ? error.message : String(error);
        change((current) => (current.saveId === id ? { refused } : {}));
      })
      .finally(() => {
        // A later save owns the lock now; this one's late answer must not release it.
        if (submitting.current !== id) return;
        submitting.current = null;
        setPending(false);
      });
  };
  // Reads only: whether the change landed is the gateway's to say, and saving again is the person's.
  const check = () => {
    if (!save) return;
    setChecking(true);
    void refresh()
      .then((fresh) => {
        if (fresh?.gatewayId === draft.gatewayId)
          change((current) =>
            current.saveId === save.id ? { ...rebase(current, fresh), rebased: save.id } : current,
          );
      })
      .catch(() => {})
      .finally(() => setChecking(false));
  };

  const onKey = (event: KeyboardEvent<HTMLUListElement>) => {
    const index = CHOICES.findIndex(([value]) => value === choice);
    let next: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight")
      next = (index + 1) % CHOICES.length;
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft")
      next = (index - 1 + CHOICES.length) % CHOICES.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = CHOICES.length - 1;
    if (next === null || saving) return;
    event.preventDefault();
    const value = CHOICES[next]![0];
    setChoice(value);
    groupRef.current?.querySelector<HTMLElement>(`[data-value="${value}"]`)?.focus();
  };

  const kept = base.kept;
  const blocked = cannotKeep(bot.id, checkIns.settings, checkIns.defaults);
  const names =
    kept.map((each) => bots.find((one) => one.id === each.botId)?.name ?? each.botId).join(", ") +
    (checkIns.defaults?.inheritedCut ? " and others" : "");
  const many = kept.length > 1 || checkIns.defaults?.inheritedCut;
  const selfByDefault =
    setting === undefined && checkIns.defaults?.inherited.includes(bot.id) === true;
  const everyChoices = EVERY_CHOICES.some((each) => each.value === every)
    ? EVERY_CHOICES
    : [...EVERY_CHOICES, { value: every, label: `${every} (as set now)` }];
  const inheritedPrompt = checkIns.defaults?.prompt ?? null;
  // Said from what is known of the prompt in effect, never from its wording.
  const kind = promptKind(prompt.trim() === "" ? null : prompt, checkIns.defaults);
  const typed = kind === "own";
  const checkedHere = save?.status === "unknown" && draft.rebased === save.id;
  const title = `${bot.name}'s check-ins`;

  return (
    <Dialog kind="create" labelledBy="ci-title" onClose={close} testId="check-ins-dialog">
      <div className="b-sheet">
        <header className="b-head">
          <h2 id="ci-title" tabIndex={-1}>
            {title}
          </h2>
          <button type="button" className="icon-button b-close" aria-label="Close" onClick={close}>
            <CloseIcon />
          </button>
        </header>
        <div className="b-body ci-body">
          <ul
            className="b-choices"
            role="radiogroup"
            aria-label="Check-ins"
            ref={groupRef}
            onKeyDown={onKey}
          >
            {CHOICES.map(([value, label]) => (
              <li key={value}>
                <button
                  type="button"
                  className="b-choice"
                  role="radio"
                  aria-checked={choice === value}
                  aria-disabled={saving || undefined}
                  tabIndex={choice === value ? 0 : -1}
                  data-value={value}
                  data-b-focus={choice === value ? "" : undefined}
                  onClick={() => !saving && setChoice(value)}
                >
                  <span className="b-choice-text">
                    <span className="b-choice-title">{label}</span>
                    <span className="b-choice-sub">{choiceWords(value, bot.name, kind)}</span>
                  </span>
                  <CheckIcon className="b-tick" />
                </button>
              </li>
            ))}
          </ul>
          {choice === "every" && (
            <div className="ci-every">
              <span>Every</span>
              <Select
                label="How often"
                value={every}
                choices={everyChoices}
                onChoose={(next) => change({ every: next, touched: { ...touched, every: true } })}
                disabled={saving}
                testId="ci-every"
              />
            </div>
          )}
          {choice === "off" && (
            <p className="ci-hint" data-testid="off-note">
              {bot.name} still reports when a command it started in the background finishes: Off
              stops only the schedule, and the gateway starts that turn.
            </p>
          )}
          <details className="ci-prompt" open={Boolean(base.was.prompt || prompt) || undefined}>
            <summary>What to check</summary>
            <label htmlFor="ci-prompt-field" className="ci-label">
              Prompt
            </label>
            <textarea
              id="ci-prompt-field"
              className="input"
              rows={4}
              value={prompt}
              readOnly={base.promptCut || saving}
              maxLength={MAX_CHECKIN_PROMPT_CHARS}
              placeholder={inheritedPrompt ?? DEFAULT_PROMPT}
              aria-describedby={typed ? "ci-prompt-note ci-prompt-hint" : "ci-prompt-hint"}
              onChange={(event) =>
                change({ prompt: event.target.value, touched: { ...touched, prompt: true } })
              }
            />
            {typed && (
              <p className="ci-hint" id="ci-prompt-note" data-testid="prompt-note">
                {promptKind(null, checkIns.defaults) === "builtin"
                  ? `This prompt replaces the gateway's own, which asks ${bot.name} to reply NO_REPLY when nothing needs attention.`
                  : "This prompt replaces the gateway's default for this bot."}{" "}
                Whether {bot.name} stays quiet depends on what this prompt asks.
              </p>
            )}
            <p className="ci-hint" id="ci-prompt-hint">
              {base.promptCut
                ? "This prompt is longer than Clawtrate edits. Saving leaves it as it is."
                : inheritedPrompt !== null
                  ? `Empty uses the prompt the gateway sets for every bot. Up to ${MAX_CHECKIN_PROMPT_CHARS.toLocaleString("en-US")} characters.`
                  : `Empty uses the gateway's built-in prompt, which asks the bot to reply NO_REPLY when nothing needs attention. Up to ${MAX_CHECKIN_PROMPT_CHARS.toLocaleString("en-US")} characters.`}
            </p>
          </details>
          {blocked && (
            <Note tone="warn" testId="catch-blocked">
              <p>
                <b>Can't save here.</b> {blocked} Saving would have to give each bot that checks in
                through the default a setting of its own, so Save is off.
              </p>
            </Note>
          )}
          {kept.length > 0 && !blocked && (
            <Note testId="catch-note">
              <p>
                {names} {many ? "check" : "checks"} in now through the gateway's default. Once any
                bot has a setting of its own, only those bots check in, so saving also gives {names}{" "}
                a setting of its own with the same cadence.
              </p>
            </Note>
          )}
          {selfByDefault && (
            <Note testId="catch-self">
              <p>
                {bot.name} checks in now through the gateway's default. Saving gives {bot.name} a
                setting of its own.
              </p>
            </Note>
          )}
          <div ref={outcomeRef} role="alert">
            {(refused || save?.status === "failed") && (
              <Note tone="danger" testId="save-failed">
                <p>
                  <b>Couldn't save.</b> {refused ?? save?.error} Nothing changed.
                </p>
              </Note>
            )}
            {save?.status === "conflict" && (
              <Note tone="warn" testId="save-conflict">
                <p>
                  <b>Not saved.</b> {save.error}
                  {!deleted &&
                    " Your changes are kept; the rest of this dialog, and the check-ins behind it, show what the gateway has now. Save again to apply your changes over it."}
                </p>
              </Note>
            )}
            {save?.status === "unknown" && !checkedHere && (
              <Note tone="warn" testId="save-unknown">
                <p>
                  <b>Not confirmed.</b> {save.error} The gateway may have applied it. Check reads
                  what it has now and changes nothing; saving again is a separate change.
                </p>
              </Note>
            )}
            {checkedHere && (
              <Note testId="save-checked">
                <p>
                  <b>Checked.</b> This dialog now starts from what the gateway has, and keeps the
                  changes of yours it doesn't have. Save sends those.
                </p>
              </Note>
            )}
          </div>
        </div>
        <footer className="b-foot">
          <div className="b-actions">
            <button type="button" className="button" data-variant="quiet" onClick={close}>
              Cancel
            </button>
            {save?.status === "unknown" && !checkedHere && (
              <button type="button" className="button" disabled={checking} onClick={check}>
                {checking ? "Checking…" : "Check"}
              </button>
            )}
            <button
              type="button"
              className="button"
              data-variant="primary"
              disabled={saving || waitingForBase || deleted || blocked !== null}
              onClick={submit}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </footer>
      </div>
    </Dialog>
  );
}
