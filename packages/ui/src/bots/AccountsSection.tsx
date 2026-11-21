// Settings → Accounts (bots.md section 7): every account in its group with
// its kind, state and the bots on it; an account's page with its label, kind,
// state, who uses it and its id; connecting, renaming and disconnecting.

import {
  labelProblem,
  normalizeLabel,
  type AccountsState,
  type Bot,
  type ConnectionState,
  type GatewayAccount,
  type HostInfo,
} from "@clawtrate/core";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useBridge } from "../bridge.tsx";
import { BackIcon, CheckIcon, LockIcon, WarnIcon } from "../icons.tsx";
import { AccountRow } from "./AccountChoices.tsx";
import { Connect, keptLabel } from "./Connect.tsx";
import { Confirm } from "./Dialog.tsx";
import { AdminBar, GrantedBar, useGranted } from "./parts.tsx";
import {
  accountGroups,
  accountName,
  howMade,
  kindWord,
  lockText,
  providerName,
  stateWord,
  usedBy,
} from "./words.ts";

export type SectionView = { title: string; back: ReactNode; body: ReactNode; foot: ReactNode };

/** The section's page: the list, an account, or the connect component. */
type Page =
  | { page: "list" }
  | { page: "account"; id: string }
  | { page: "connect"; startWith: string | null };

export function useAccountsSection({
  accounts,
  refreshOnOpen,
  bots,
  connection,
  info,
  announce,
  toNav,
}: {
  accounts: AccountsState;
  refreshOnOpen: boolean;
  bots: readonly Bot[];
  connection: ConnectionState;
  info: HostInfo;
  announce: (text: string) => void;
  toNav: ReactNode;
}): { view: SectionView | null; connect: ReactNode | null } {
  const bridge = useBridge();
  // A label step left open comes back where it was left (section 6).
  const [page, setPage] = useState<Page>(() =>
    keptLabel(accounts) ? { page: "connect", startWith: null } : { page: "list" },
  );
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState("");
  const [labelError, setLabelError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<GatewayAccount | null>(null);
  const [busy, setBusy] = useState(false);
  const [now] = useState(() => Date.now());
  const granted = useGranted(connection);
  const admin = connection.canAdmin;

  // Settings reads the accounts when it opens, and so the locks of the bots on them.
  const refreshed = useRef(false);
  useEffect(() => {
    if (!refreshOnOpen || refreshed.current) return;
    refreshed.current = true;
    void bridge.send({ type: "refreshAccounts" }).catch(() => {});
  }, [bridge, refreshOnOpen]);

  const focusTitle = () =>
    requestAnimationFrame(() => document.querySelector<HTMLElement>("#b-section-title")?.focus());
  const go = (next: Page) => {
    setPage(next);
    setEditing(false);
    setLabelError(null);
    focusTitle();
  };
  const back = (label: string, to: () => void) => (
    <button
      type="button"
      className="icon-button b-back"
      data-variant="quiet"
      aria-label={label}
      onClick={to}
    >
      <BackIcon />
    </button>
  );
  const adminFoot = granted ? (
    <GrantedBar nowShown={connection.upgrade.nowShown === true} />
  ) : admin ? null : (
    <AdminBar
      connection={connection}
      info={info}
      need="Connecting and changing accounts needs admin access."
    />
  );

  if (page.page === "connect") {
    return {
      view: null,
      connect: (
        <Connect
          from="settings"
          draftName={null}
          forBot={null}
          accounts={accounts}
          bots={bots}
          connection={connection}
          info={info}
          announce={announce}
          onDone={() => go({ page: "list" })}
          onLeave={() => go({ page: "list" })}
          {...(page.startWith ? { startWith: page.startWith } : {})}
        >
          {(view) => (
            <>
              <header className="b-section-head">
                {back(view.backLabel, view.onBack)}
                <h3 id="b-section-title" tabIndex={-1}>
                  {view.title}
                </h3>
              </header>
              <div className="b-section-body">{view.body}</div>
              {view.foot && <footer className="b-section-foot">{view.foot}</footer>}
            </>
          )}
        </Connect>
      ),
    };
  }

  const account =
    page.page === "account" ? accounts.accounts.find((each) => each.id === page.id) : undefined;
  if (page.page === "account" && account) {
    const users = usedBy(account.id, accounts.bindings, bots, {
      now,
      connected: connection.status === "connected",
      connectedAt: connection.connectedAt,
    });
    const { tone, word } = stateWord(account, now);
    const keeper = account.keptBy
      ? (bots.find((bot) => bot.id === account.keptBy)?.name ?? account.keptBy)
      : null;
    const method = accounts.methods.find(
      (m) => m.provider === account.provider && m.flow !== "key",
    );
    const keyed = accounts.keyProviders.some((k) => k.provider === account.provider);
    const save = async () => {
      const value = normalizeLabel(label);
      const problem = labelProblem(accounts.accounts, account.id, value);
      if (problem) {
        setLabelError(problem);
        announce(problem);
        return;
      }
      setBusy(true);
      try {
        await bridge.invoke({ type: "setAccountLabel", profileId: account.id, label: value });
        announce("Label saved");
        setEditing(false);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setLabelError(message);
        announce(message);
      } finally {
        setBusy(false);
      }
    };
    const body = (
      <>
        <dl className="facts" data-testid="account-facts">
          <div>
            <dt>Provider</dt>
            <dd>{providerName(account.provider)}</dd>
          </div>
          {editing ? (
            <div className="b-row b-edit-row">
              <dt>Label</dt>
              <dd className="b-edit">
                <input
                  className="input"
                  maxLength={32}
                  value={label}
                  aria-label="Label"
                  aria-invalid={labelError ? true : undefined}
                  aria-describedby={labelError ? "b-relabel-error" : undefined}
                  autoFocus
                  onChange={(event) => {
                    setLabel(event.target.value);
                    setLabelError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void save();
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setEditing(false);
                    }
                  }}
                />
                <button
                  type="button"
                  className="button"
                  data-variant="primary"
                  data-size="sm"
                  disabled={busy}
                  onClick={() => void save()}
                >
                  Save
                </button>
                <button
                  type="button"
                  className="button"
                  data-variant="quiet"
                  data-size="sm"
                  onClick={() => setEditing(false)}
                >
                  Cancel
                </button>
              </dd>
            </div>
          ) : (
            <div className="b-row">
              <dt>Label</dt>
              <dd className="b-wrap-value b-label-value">
                {accounts.labels ? (
                  <>
                    <span>{account.label ?? "None"}</span>
                    {admin && (
                      <button
                        type="button"
                        className="button"
                        data-variant="quiet"
                        data-size="sm"
                        aria-label={account.label ? "Edit label" : "Add a label"}
                        onClick={() => {
                          setLabel(account.label ?? "");
                          setEditing(true);
                        }}
                      >
                        {account.label ? "Edit" : "Add a label"}
                      </button>
                    )}
                  </>
                ) : (
                  "Shown to admin connections"
                )}
              </dd>
            </div>
          )}
          <div>
            <dt>Kind</dt>
            <dd>{kindWord(account)}</dd>
          </div>
          <div>
            <dt>State</dt>
            <dd>
              <span className="b-state" data-tone={tone ?? "ok"}>
                {tone ? <WarnIcon /> : <CheckIcon />}
                {word}
              </span>
            </dd>
          </div>
          <div>
            <dt>Used by</dt>
            <dd>
              {account.keptBy
                ? `Only ${keeper} can use it`
                : users.length > 0
                  ? users
                      .map((each) =>
                        each.lock
                          ? `${each.bot.name} (${lockText(each.lock, true)})`
                          : each.bot.name,
                      )
                      .join(", ")
                  : "No bots"}
            </dd>
          </div>
          <div>
            <dt>On the gateway</dt>
            <dd className="mono b-wrap-value">{account.id}</dd>
          </div>
        </dl>
        {labelError && (
          <p className="b-field-error" id="b-relabel-error" role="alert">
            {labelError}
          </p>
        )}
        <p className="b-hint">
          {howMade(account)}. The gateway keeps the sign-in; Clawtrate can't read it.
          {keeper ? ` Kept in ${keeper}'s own store. Other bots can't use it.` : ""}
        </p>
        {admin && (
          <div className="b-actions" style={{ marginTop: 18 }}>
            {account.kind === "subscription" && method ? (
              <button
                type="button"
                className="button"
                data-size="sm"
                data-variant={tone ? "primary" : undefined}
                onClick={() => go({ page: "connect", startWith: method.id })}
              >
                Sign in again
              </button>
            ) : account.kind === "key" && keyed && !account.keptBy ? (
              <button
                type="button"
                className="button"
                data-size="sm"
                onClick={() => go({ page: "connect", startWith: null })}
              >
                Replace key
              </button>
            ) : (
              <span className="b-hint" style={{ margin: 0 }}>
                Signed in on the gateway. Sign it in again there.
              </span>
            )}
            <span className="spacer" />
            {account.logoutSupported && (
              <button
                type="button"
                className="button"
                data-variant="quiet"
                data-size="sm"
                data-tone="danger"
                onClick={() => setConfirm(account)}
              >
                Disconnect…
              </button>
            )}
          </div>
        )}
        {confirm && (
          <Confirm
            title={`Disconnect ${accountName(confirm, accounts)}?`}
            text={(() => {
              const names = users.map((each) => each.bot.name);
              return names.length > 0
                ? `${names.join(" and ")} ${names.length === 1 ? "uses" : "use"} it. ${names.length === 1 ? "It shows" : "They show"} No account until you choose another, and Clawtrate doesn't start ${names.length === 1 ? "it" : "them"} until then. Your gateway removes the sign-in.`
                : "No bot uses it. Your gateway removes the sign-in.";
            })()}
            action="Disconnect"
            busy={busy}
            onCancel={() => setConfirm(null)}
            onAction={() => {
              const target = confirm;
              setBusy(true);
              void bridge
                .invoke({ type: "disconnectAccount", profileId: target.id })
                .then(
                  () => {
                    announce(`Disconnected ${accountName(target, accounts)}`);
                    setConfirm(null);
                    go({ page: "list" });
                  },
                  (error: unknown) =>
                    announce(error instanceof Error ? error.message : String(error)),
                )
                .finally(() => setBusy(false));
            }}
          />
        )}
      </>
    );
    return {
      view: {
        title: accountName(account, accounts),
        back: back("Back to accounts", () => go({ page: "list" })),
        body,
        foot: adminFoot,
      },
      connect: null,
    };
  }

  const groups = accountGroups(accounts.accounts, true);
  const loading = accounts.status === "loading" || accounts.status === "idle";
  const body = (
    <>
      <div className="b-headrow">
        <p className="b-lead" style={{ margin: 0 }}>
          Your bots run on these. Your gateway signs in and keeps each sign-in; Clawtrate never sees
          a password or keeps a sign-in.
        </p>
        {admin && accounts.accounts.length > 0 && (
          <button
            type="button"
            className="button"
            data-size="sm"
            onClick={() => go({ page: "connect", startWith: null })}
          >
            Connect an account
          </button>
        )}
      </div>
      {loading && accounts.accounts.length === 0 ? (
        <div aria-busy="true" aria-label="Loading accounts" style={{ marginTop: 16 }}>
          <div className="skeleton" style={{ height: 58, width: "100%" }} />
          <div className="skeleton" style={{ height: 58, width: "100%" }} />
        </div>
      ) : accounts.status === "error" && accounts.accounts.length === 0 ? (
        <div className="work-empty">
          <span className="empty-mark">
            <WarnIcon />
          </span>
          <h4>Couldn't load the gateway's accounts</h4>
          <p>{accounts.error}</p>
          <div style={{ marginTop: 10 }}>
            <button
              type="button"
              className="button"
              data-size="sm"
              onClick={() => void bridge.send({ type: "refreshAccounts" })}
            >
              Try again
            </button>
          </div>
        </div>
      ) : groups.length > 0 ? (
        groups.map((group) => (
          <div key={group.title}>
            <h4 className="b-group">{group.title}</h4>
            <ul className="b-choices">
              {group.accounts.map((each) => (
                <AccountRow
                  key={each.id}
                  account={each}
                  accounts={accounts}
                  bots={bots}
                  now={now}
                  onOpen={() => go({ page: "account", id: each.id })}
                  {...(admin
                    ? {
                        // Straight to the label field, which takes the focus.
                        onLabel: () => {
                          setPage({ page: "account", id: each.id });
                          setLabel("");
                          setLabelError(null);
                          setEditing(true);
                        },
                      }
                    : {})}
                />
              ))}
            </ul>
          </div>
        ))
      ) : (
        <div className="work-empty">
          <span className="empty-mark">
            <LockIcon />
          </span>
          <h4>No accounts yet</h4>
          <p>Connect a subscription you already have, and choose it when you create a bot.</p>
          {admin && (
            <div style={{ marginTop: 12 }}>
              <button
                type="button"
                className="button"
                data-variant="primary"
                onClick={() => go({ page: "connect", startWith: null })}
              >
                Connect an account
              </button>
            </div>
          )}
        </div>
      )}
      {!accounts.labels && accounts.accounts.length > 0 && (
        <p className="b-hint">
          Labels are shown to admin connections only, so accounts are named by provider and id here.
        </p>
      )}
    </>
  );
  return { view: { title: "Accounts", back: toNav, body, foot: adminFoot }, connect: null };
}
