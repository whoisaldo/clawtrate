// A watch over one bot's browser: the plugin's own connection to the browser
// itself, attached to every tab, with page events on. It tells a take
// whether anything the plugin can see is still unresolved in that browser: a
// download in progress, or a tab still loading a page (including one whose
// page events Chromium holds back because a navigation is pending).
//
// It changes nothing in the browser: `Target.setAutoAttach` without pausing
// new tabs, and `Page.enable` on each tab. It never sets the download
// behaviour, which the gateway's own client owns.
//
// Every command it sends is first allowed by `allow()`: while the watch is
// being set up for a caller, that is the caller's authority, checked right
// before each command; when it says no, the watch sends nothing more and
// closes.

import { CdpError, openBrowserCdp } from "./cdp.js";

/** The watch was not allowed to send a command, so it sent none and closed. */
export class WatchRefused extends CdpError {
  constructor() {
    super("watch_refused", "the watch's command was not allowed");
  }
}

/**
 * Open a watch on `bot`'s browser. Resolves once it is attached to the tabs
 * open now; rejects with a CdpError when the browser cannot be watched.
 * `onChange` is called whenever what it sees changes.
 */
export async function watchBrowser(bot, options = {}) {
  const { onChange = () => {} } = options;
  let allow = options.allow ?? (() => true);
  if (!allow()) throw new WatchRefused();
  const cdp = await openBrowserCdp(bot, options);
  /** Send a command only once `allow()` says so; otherwise close the watch. */
  const command = (method, params, sendOptions) => {
    if (!allow()) {
      cdp.close();
      return Promise.reject(new WatchRefused());
    }
    return cdp.send(method, params, sendOptions);
  };
  /** sessionId -> { targetId, loading: Set<frameId>, enabling: boolean, unwatched: boolean } */
  const tabs = new Map();
  /**
   * download guid -> sessionId of the tab that started it. A download belongs
   * to the browser, not to that tab: it stays here until the browser reports
   * it finished or cancelled, also after the tab closes (Chromium then no
   * longer reports it to the plugin at all). Downloads an earlier watch of
   * this same browser left unfinished are carried over (`carried`).
   */
  const downloads = new Map();
  const browserUrl = cdp.target.url;
  for (const guid of options.carried?.(browserUrl) ?? []) downloads.set(guid, null);
  const changed = () => {
    try {
      onChange();
    } catch {
      // a listener's failure must not stop the watch
    }
  };

  cdp.on((message) => {
    const { method, params = {}, sessionId } = message;
    if (method === "Target.attachedToTarget") {
      const info = params.targetInfo ?? {};
      if (info.type !== "page" || typeof params.sessionId !== "string") return;
      const tab = { targetId: info.targetId, loading: new Set(), enabling: true, unwatched: false };
      tabs.set(params.sessionId, tab);
      changed();
      void enable(params.sessionId, tab);
      return;
    }
    if (method === "Target.detachedFromTarget") {
      // Its downloads stay: they go on in the browser.
      if (tabs.delete(params.sessionId)) changed();
      return;
    }
    const tab = tabs.get(sessionId);
    if (!tab) return;
    if (method === "Page.frameStartedLoading") tab.loading.add(params.frameId);
    else if (method === "Page.frameStoppedLoading") tab.loading.delete(params.frameId);
    else if (method === "Page.downloadWillBegin") downloads.set(params.guid, sessionId);
    else if (method === "Page.downloadProgress") {
      if (params.state === "inProgress") downloads.set(params.guid, sessionId);
      else downloads.delete(params.guid);
    } else return;
    changed();
  });
  cdp.onClose(changed);

  /**
   * Turn on a tab's page events. Chromium answers only once a pending
   * navigation in the tab has ended, so until then the tab counts as loading.
   * A tab that does not answer in time is unwatched, not loading: what it does
   * cannot be seen until it is asked again (`recheck`) and answers.
   */
  function enable(sessionId, tab) {
    tab.enabling = true;
    tab.unwatched = false;
    return command("Page.enable", {}, { sessionId })
      .then(
        () => (tab.enabling = false),
        () => {
          tab.enabling = false;
          tab.unwatched = true;
        },
      )
      .finally(changed);
  }

  try {
    await command("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
  } catch (error) {
    cdp.close();
    throw error;
  }

  if (cdp.closed) throw new WatchRefused();
  return {
    get closed() {
      return cdp.closed;
    },
    /** The browser's own debugger address: another browser, another address. */
    browserUrl,
    /** The downloads it has seen begin and not end. */
    inProgress: () => [...downloads.keys()],
    /** Ask every unwatched tab again; resolves once each has answered or failed again. */
    recheck: () =>
      Promise.all([...tabs].filter(([, tab]) => tab.unwatched).map(([id, tab]) => enable(id, tab))),
    /** Replace what allows the watch's later commands (for tabs opened later). */
    setAllow(fn) {
      allow = fn;
    },
    /**
     * What is unresolved now, or null: "download" while a download is in
     * progress, "loading" while a tab is loading, "unwatched" while a tab did
     * not answer the watch; "closed" once the watch has lost the browser.
     */
    unresolved() {
      if (cdp.closed) return "closed";
      if (downloads.size > 0) return "download";
      for (const tab of tabs.values()) if (tab.enabling || tab.loading.size > 0) return "loading";
      for (const tab of tabs.values()) if (tab.unwatched) return "unwatched";
      return null;
    },
    onClose: (fn) => cdp.onClose(fn),
    close: () => cdp.close(),
  };
}
