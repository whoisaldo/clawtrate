// The app page, driven by a small local model. No gateway, no network.
//
// Tracked separately, as the design specifies: the selected bot, the selected
// task, which bots in the list are unfolded, and which pinned bot owns the pin
// grid's one task block. One state object also holds the connection, so the
// status strip, the rail's footer and the composer always agree.
//
// States can be set from the address, which is how the screenshots are taken:
//   ?bot=juniper&task=j2      open a bot and one of its tasks
//   ?unfold=juniper           unfold more bots than the selected one
//   ?fold=otto                fold the selected bot
//   ?showall=otto             lift the six-row cap for a bot
//   ?pin=pip,juniper,otto     pin bots (?rail=pinned pins Pip and Juniper)
//   ?pinopen=juniper          which pinned bot's tasks show
//   ?panel=open&tab=files     the Work pane and its tab
//   ?view=list                the one-pane layout's list
//   ?banner=reconnecting      the connection: reconnecting, offline, syncing, synced, failed
//   ?state=empty              no task selected; also: loading, readonly, newtask,
//                             loaderror, nobots, discovering, zerotasks
//   ?menu=new                 open a menu: new, bot, gateway

(function () {
  const CT = window.CT;
  const params = CT.params;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (text) =>
    String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const icon = (name, cls) => CT.icon(name, cls);
  const list = (name) => (params.get(name) || "").split(",").filter(Boolean);
  const state0 = params.get("state");

  // Fixtures --------------------------------------------------------------------

  // One transcript item: its bubbles and its folded work, in order.
  const turn = (role, html) => `<div class="turn" data-role="${role}" data-testid="transcript-turn">${html}</div>`;
  const bubble = (role, html, md = false) => `<div class="msg" data-role="${role}"><div class="bubble${md ? " md" : ""}">${html}</div></div>`;

  // A turn's thoughts and tool calls: one folded line. Each row inside still
  // opens to the full reasoning, or to the call's arguments and result.
  const tool = (name, summary, args, result, error = false) =>
    `<details class="step" data-testid="tool-call"><summary>${icon("chevron", "icon step-chevron")}<span class="step-tool-name">${name}</span>` +
    `<span class="step-summary">${esc(summary)}</span><span class="step-state" data-error="${error}">${error ? "failed" : result === null ? "no result" : "done"}</span></summary>` +
    `<div class="step-body"><p class="code-label">Arguments</p><pre class="code-block">${esc(args)}</pre>` +
    (result === null ? "" : `<p class="code-label">${error ? "Error" : "Result"}</p><pre class="code-block">${esc(result)}</pre>`) +
    `</div></details>`;
  const thought = (text) =>
    `<details class="step"><summary>${icon("chevron", "icon step-chevron")}<span class="step-kind">Thought</span>` +
    `<span class="step-reasoning-preview">${esc(text.split("\n")[0])}</span></summary><div class="step-body"><p class="reasoning">${esc(text)}</p></div></details>`;
  const steps = (label, rows) =>
    `<details class="steps"><summary class="event-line">${label} ${icon("chevron")}</summary><div class="steps-list">${rows.join("")}</div></details>`;

  const diskTranscript =
    `<div class="stamp">Today 5:31 PM</div>` +
    turn("user", bubble("user", "The media box says the disk is 94% full. What is eating the space?")) +
    turn(
      "assistant",
      steps("Thought, used 2 tools", [
        thought("I should look at the workspace inventory I keep for the server before guessing.\nThen re-read my instructions so I report in the agreed order."),
        tool("ls", "path: .", '{\n  "path": "."\n}', "AGENTS.md\ninventory.md\nnotes/"),
        tool("read", "path: AGENTS.md", '{\n  "path": "AGENTS.md"\n}', "# Otto\n\nYou are Otto, the operator for a small home server.\n\n- Check before you change. Read logs and configs first.\n- Report in this order: what you found, what you changed, what is left."),
      ]) +
        bubble(
          "assistant",
          `<h3>Found</h3><p>The usual suspects on a media box, largest first:</p>` +
            `<ol><li><code>/var/lib/transcode-cache</code>, about 180 GB of temporary transcodes that were never cleaned up.</li>` +
            `<li>Old container images, about 40 GB across 12 unused tags.</li><li>Rotated logs, about 6 GB, mostly from one noisy service.</li></ol>` +
            `<h3>Changed</h3><p>Nothing yet.</p><h3>Left</h3><ul><li>Clearing the transcode cache is safe and frees the most. Its files are regenerated on demand.</li>` +
            `<li>Pruning unused images is also safe, but the next update will download them again.</li></ul>` +
            `<p>Should I clear the transcode cache? I will move it aside first so it can be restored.</p>`,
          true,
        ),
    ) +
    `<div class="stamp">Today 5:36 PM</div>` +
    turn("user", bubble("user", "Yes, clear the transcode cache.")) +
    turn(
      "assistant",
      steps("Used 1 tool", [tool("write", "path: notes/disk-2026-11-16.md", '{\n  "path": "notes/disk-2026-11-16.md",\n  "content": "Moved the transcode cache aside…"\n}', "Wrote 6 lines.")]) +
        bubble(
          "assistant",
          `<p>Done. The disk is now at 61%.</p><table><thead><tr><th>What</th><th>Before</th><th>After</th></tr></thead>` +
            `<tbody><tr><td>Disk used</td><td>94%</td><td>61%</td></tr><tr><td>Transcode cache</td><td>180 GB</td><td>0 GB</td></tr><tr><td>Free space</td><td>33 GB</td><td>213 GB</td></tr></tbody></table>` +
            `<p>I moved the cache to <code>transcode-cache.old</code> instead of deleting it. To undo, move it back. I will remove it in a week unless you say otherwise.</p>`,
          true,
        ),
    );

  // at: minutes, for ordering by latest activity. when: how the time reads.
  const task = (id, title, at, when, preview, extra = {}) => ({ id, title, at, when, preview, unread: false, status: "idle", ...extra });

  // Bots keep the order the gateway gives them; only tasks are ordered by activity.
  let bots = [
    {
      id: "juniper",
      name: "Juniper",
      label: "Research",
      tasks: [
        task("j1", "Heat pump vs. gas furnace", 1044, "5:24 PM", "Ask these five, and get the answers in writing.", { ask: "What should I ask an installer before signing anything?" }),
        task("j2", "Library e-book apps compared", 902, "3:02 PM", "Most public libraries use one of three lending platforms.", { unread: true, ask: "Which e-book app does my library use, and is it any good?" }),
        task("j3", "Caffeine cutoff time", -3, "Sun", "Short answer: stop about 8 hours before bed."),
      ],
    },
    {
      id: "marlow",
      name: "Marlow",
      label: "Writing",
      tasks: [task("m1", "Main", 1018, "4:58 PM", "Tightened the intro and cut about 80 words.", { ask: "Can you tighten the intro of the newsletter draft?" })],
    },
    {
      id: "otto",
      name: "Otto",
      label: "Operations",
      tasks: [
        task("o1", "Disk almost full on the media box", 1056, "5:36 PM", "Done. The disk is now at 61%.", { html: diskTranscript }),
        task("o2", "Rotate the logs on every machine in the rack before the disks fill up again", 1100, "now", "Rotating logs on rack-2", { status: "running", ask: "Rotate the logs on every machine in the rack before the disks fill up again." }),
        task("o3", "Weekly backup check", 854, "2:14 PM", "Yes. Last night's backup finished at 3:25 AM.", { unread: true, ask: "Did last night's backup finish?" }),
        task("o4", "Certificate renewal warning", -1, "Mon", "A little. Renewal normally happens with 30 days left."),
        task("o5", "Router firmware", -2, "Mon", "The router is two releases behind. Neither is urgent."),
        task("o6", "Printer offline again", -3, "Sun", "It had fallen off the network. It is back, with a fixed address."),
        task("o7", "NAS scrub schedule", -4, "Sat", "The scrub now runs on the first Sunday of the month."),
        task("o8", "Why does the garage camera drop off the network every night around two", -5, "Fri", "It loses its lease at 2:04 every night. A reservation fixes it."),
        task("o9", "UPS battery report", -6, "Nov 6", "The battery holds 41 minutes at the current load."),
        task("o10", "Guest Wi-Fi password", -7, "Nov 5", "Changed, and the old one no longer works."),
        task("o11", "Media server update", -8, "Nov 3", "Updated. Two plugins needed their settings again."),
        task("o12", "Thermostat schedule", -9, "Nov 2", "Weekdays now start warming at 6:30."),
        task("o13", "DNS blocklist review", -10, "Oct 30", "Removed three lists that blocked the school's site."),
        task("o14", "Old tickets cleanup", -11, "Oct 28", "Closed 19 that were already done."),
      ],
    },
    {
      id: "pip",
      name: "Pip",
      label: "Planning",
      tasks: [
        task("p1", "Plan the week", 910, "3:10 PM", "Here is the week, with Thursday kept clear.", { unread: true, ask: "Plan my week. Keep Thursday clear." }),
        task("p2", "Trip to the coast in March", -1, "Mon", "Two options, both under four hours by train.", { status: "failed" }),
        task("p3", "Birthday dinner", -4, "Sat", "Booked for eight people at 7:30."),
        task("p4", "Reading list for the spring", -9, "Nov 2", "Twelve books, shortest first."),
      ],
    },
  ];
  if (state0 === "nobots" || state0 === "discovering") bots = [];
  if (state0 === "zerotasks") bots.find((b) => b.id === "marlow").tasks = [];
  // A page built on this one (work.html) may add its own fixtures and fill the
  // Work pane's Files and Computer tabs. app.html has no extension.
  const ext = CT.appExtension || {};
  ext.fixtures?.(bots, task);

  // The model ------------------------------------------------------------------------

  const model = {
    selectedBot: params.get("bot") || (state0 === "zerotasks" ? "marlow" : "otto"),
    selectedTask: null, // set at first paint
    remembered: { otto: "o1" }, // the last task opened for each bot; it wins over the most recent
    unfolded: new Set(), // list bots unfolded because they are open
    held: new Set(), // list bots the user unfolded by hand; they stay unfolded
    pinOwner: params.get("pinopen") || null, // the pinned bot whose tasks the pin grid's one block shows
    pinHeld: Boolean(params.get("pinopen")), // true when that block was opened by hand
    showAll: new Set(list("showall")),
    pinned: new Set(params.get("rail") === "pinned" ? ["pip", "juniper"] : list("pin")),
    connection: "connected",
    access: state0 === "readonly" ? "read" : "write",
    loading: state0 === "loading",
    loadError: state0 === "loaderror",
    panel: false,
    tab: params.get("tab") || "details",
    drafts: {},
    newCount: 0,
  };

  const bot = (id = model.selectedBot) => bots.find((b) => b.id === id);
  const sorted = (b) => [...b.tasks].sort((x, y) => y.at - x.at);
  const currentTask = () => bot()?.tasks.find((t) => t.id === model.selectedTask) || null;
  const canWrite = () => model.access === "write"; // may this connection send and create tasks
  const offline = () => model.connection === "reconnecting" || model.connection === "offline";

  // What a bot's row or tile says about all of its tasks. The three signals are
  // independent, and safe for a bot with no tasks.
  function summary(b) {
    const tasks = sorted(b);
    const latest = tasks[0];
    const onScreen = (t) => b.id === model.selectedBot && t.id === model.selectedTask;
    return {
      preview: latest ? latest.preview : "No tasks yet", // the latest activity in any task
      when: latest ? latest.when : "",
      unread: tasks.some((t) => t.unread && !onScreen(t)), // any unread task
      state: tasks.some((t) => t.status === "failed") ? "failed" : tasks.some((t) => t.status === "running") ? "running" : "idle", // by priority
      // An account notice (bots.md): replaces line two's preview, in its own tone.
      notice: b.notice || null,
    };
  }
  const stateMark = (state) =>
    state === "running"
      ? `<span class="glyph" data-state="working" aria-hidden="true"></span>`
      : state === "failed"
        ? `<span class="glyph" data-state="failed" aria-hidden="true"></span>`
        : "";

  // The rows shown under an unfolded bot: six, then "Show all".
  function visible(b) {
    const tasks = sorted(b);
    if (tasks.length <= 6 || model.showAll.has(b.id)) return tasks;
    const top = tasks.slice(0, 6);
    const current = tasks.find((t) => t.id === model.selectedTask && b.id === model.selectedBot);
    if (current && !top.includes(current)) top[5] = current; // the current task is always in view
    return top;
  }

  const isPinned = (b) => model.pinned.has(b.id);
  const isOpen = (b) =>
    b.tasks.length > 1 && (isPinned(b) ? model.pinOwner === b.id : model.unfolded.has(b.id) || model.held.has(b.id));
  const onePane = () => getComputedStyle($(".back-button")).display !== "none";
  const shell = $(".shell");

  // Rail ---------------------------------------------------------------------------------

  function taskRows(b) {
    const rows = visible(b)
      .map((t) => {
        const current = b.id === model.selectedBot && t.id === model.selectedTask;
        const mark = stateMark(t.status) || (t.unread && !current ? `<span class="unread-dot" aria-hidden="true"></span>` : "");
        const spoken =
          `${t.title}, ${t.when}` + (t.status === "running" ? ", working" : t.status === "failed" ? ", last run failed" : t.unread && !current ? ", unread" : "");
        return (
          `<li><button type="button" class="task" data-bot="${b.id}" data-task="${t.id}" data-key="t:${t.id}" aria-current="${current}"` +
          ` data-status="${t.status}" data-unread="${t.unread && !current}" data-full="${esc(t.title)}"` +
          ` aria-label="${esc(spoken)}" data-testid="task"><span class="task-title">${esc(t.title)}</span>` +
          `<time class="task-time">${t.when}</time>${mark}</button></li>`
        );
      })
      .join("");
    const more =
      b.tasks.length > 6
        ? `<li><button type="button" class="task task-more" data-more="${b.id}" data-key="more:${b.id}"><span class="task-title">` +
          `${model.showAll.has(b.id) ? "Show fewer" : `Show all ${b.tasks.length}`}</span></button></li>`
        : "";
    // New task is offered only where the connection may create one.
    const fresh = canWrite()
      ? `<li><button type="button" class="task task-new" data-new="${b.id}" data-key="new:${b.id}">${icon("plus")}<span class="task-title">New task</span></button></li>`
      : "";
    return rows + more + fresh;
  }

  const spokenBot = (b, s) =>
    `${b.name}, ${b.tasks.length} ${b.tasks.length === 1 ? "task" : "tasks"}` +
    (s.state === "running" ? ", working" : s.state === "failed" ? ", a run failed" : "") +
    (s.notice ? `, ${s.notice.spoken}` : "") +
    (s.unread ? ", unread" : "");

  function renderRail() {
    const focusKey = document.activeElement?.dataset?.key;
    const el = $("#bot-list");
    if (!bots.length) {
      el.innerHTML =
        state0 === "discovering"
          ? `<li class="rail-empty" aria-busy="true"><strong>Loading bots</strong>Loading this gateway's bots.</li>`
          : `<li class="rail-empty"><strong>No bots</strong>Bots appear here once the gateway has one.</li>`;
      return;
    }
    const pinned = bots.filter(isPinned);
    const rest = bots.filter((b) => !isPinned(b));
    let html = "";

    if (pinned.length) {
      html +=
        `<li><ul class="pin-grid" aria-label="Pinned bots">` +
        pinned
          .map((b) => {
            const s = summary(b);
            // The run state on the avatar and the unread dot by the name are independent.
            return (
              `<li><button type="button" class="pin" data-bot="${b.id}" data-key="b:${b.id}" aria-current="${b.id === model.selectedBot}"` +
              `${b.tasks.length > 1 ? ` aria-expanded="${isOpen(b)}"` : ""} aria-label="${esc(spokenBot(b, s))}" data-testid="bot">` +
              `<span class="pin-avatar"><span class="avatar" data-bot="${b.id}"></span>${stateMark(s.state)}</span>` +
              `<span class="pin-name"><span>${b.name}</span>${s.unread ? '<span class="unread-dot" aria-hidden="true"></span>' : ""}</span></button></li>`
            );
          })
          .join("") +
        `</ul></li>`;
      // One task block for the grid, owned by one pinned bot, and labelled with its name.
      const owner = pinned.find((b) => isOpen(b));
      if (owner) {
        html +=
          `<li class="pin-tasks"><p class="pin-tasks-label" id="pin-tasks-label"><span class="avatar" data-bot="${owner.id}"></span>${owner.name}</p>` +
          `<ul class="task-list" aria-labelledby="pin-tasks-label" data-testid="task-list">${taskRows(owner)}</ul></li>`;
      }
    }

    html += rest
      .map((b) => {
        const s = summary(b);
        const open = isOpen(b);
        const several = b.tasks.length > 1;
        const selected = b.id === model.selectedBot;
        return (
          `<li class="bot-group"${open ? ' data-open="true"' : ""}>` +
          `<button type="button" class="bot" data-bot="${b.id}" data-key="b:${b.id}" aria-current="${selected && !open}"` +
          `${several ? ` aria-expanded="${open}"` : ""} aria-label="${esc(spokenBot(b, s))}" data-testid="bot">` +
          `<span class="avatar" data-bot="${b.id}"></span>` +
          `<span class="bot-text"><span class="bot-line"><span class="bot-name">${b.name}</span><time class="bot-time">${s.when}</time></span>` +
          `<span class="bot-line">${stateMark(s.state)}<span class="bot-preview"${s.notice ? ` data-tone="${s.notice.tone}"` : ""}>${esc(s.notice ? s.notice.text : s.preview)}</span>${s.unread ? '<span class="unread-dot"></span>' : ""}</span></span></button>` +
          (several
            ? `<button type="button" class="icon-button bot-toggle" data-toggle="${b.id}" tabindex="-1" aria-label="${open ? "Hide" : "Show"} ${b.name}'s tasks">${icon("chevron")}</button>`
            : "") +
          (open ? `<ul class="task-list" aria-label="${b.name}'s tasks" data-testid="task-list">${taskRows(b)}</ul>` : "") +
          `</li>`
        );
      })
      .join("");

    el.innerHTML = html;
    CT.hydrate(el);
    if (focusKey) $(`[data-key="${focusKey}"]`, el)?.focus();
  }

  // Selecting, folding, new task ---------------------------------------------------------

  // Opening a bot: its remembered task, or else its most recent one.
  function selectBot(id) {
    const b = bot(id);
    const taskId = b.tasks.find((t) => t.id === model.remembered[id])?.id || sorted(b)[0]?.id || null;
    openTask(id, taskId);
  }

  // One atomic selection: the bot, its task, and what unfolds with it.
  function openTask(botId, taskId) {
    const b = bot(botId);
    if (botId !== model.selectedBot) model.unfolded.clear(); // a bot unfolded by being open folds when another opens
    model.selectedBot = botId;
    model.selectedTask = taskId;
    if (taskId) model.remembered[botId] = taskId;
    if (isPinned(b)) {
      // The pin grid's one block follows the open pinned bot.
      if (b.tasks.length > 1) {
        model.pinOwner = botId;
        model.pinHeld = false;
      } else if (!model.pinHeld) model.pinOwner = null;
    } else {
      model.unfolded.add(botId);
      if (!model.pinHeld) model.pinOwner = null; // a block opened by selection folds when another bot opens
    }
    const t = currentTask();
    if (t) t.unread = false; // opening a task marks it read
    model.loading = false;
    model.loadError = false;
    shell.dataset.view = "detail";
    render();
    const transcript = $("#transcript");
    transcript.scrollTop = transcript.scrollHeight;
  }

  // Fold or unfold by hand, without changing what is selected.
  function toggleFold(id) {
    const b = bot(id);
    if (b.tasks.length < 2) return;
    if (isPinned(b)) {
      // Only one pinned bot owns the block: unfolding one takes it from another.
      if (model.pinOwner === id) model.pinOwner = null;
      else model.pinOwner = id;
      model.pinHeld = model.pinOwner !== null;
    } else if (isOpen(b)) {
      model.unfolded.delete(id);
      model.held.delete(id);
    } else {
      model.held.add(id);
    }
    renderRail();
  }

  function togglePin(id) {
    const b = bot(id);
    const wasOpen = isOpen(b);
    if (isPinned(b)) {
      model.pinned.delete(id);
      if (model.pinOwner === id) model.pinOwner = null;
      if (wasOpen) model.held.add(id);
    } else {
      model.pinned.add(id);
      model.unfolded.delete(id);
      model.held.delete(id);
      if (wasOpen || id === model.selectedBot) model.pinOwner = b.tasks.length > 1 ? id : model.pinOwner;
    }
    renderRail();
  }

  function newTask(id) {
    if (!canWrite()) return note("This device can read but not start tasks.");
    const b = bot(id);
    model.newCount += 1;
    const t = task(`n${model.newCount}`, "New task", 2000 + model.newCount, "now", "No messages yet.", { html: "", fresh: true });
    b.tasks.push(t);
    openTask(id, t.id);
    $(".composer-input")?.focus();
    note(`New task: ${b.name} now has ${b.tasks.length} tasks. The new one is selected and the composer has focus.`);
  }

  // Conversation -------------------------------------------------------------------------

  function renderHeader() {
    const b = bot();
    const t = currentTask();
    const pill = $("#title-pill");
    pill.hidden = !b;
    $("#panel-button").hidden = !b; // with no bot there is nothing for the Work pane to describe
    if (!b) return;
    pill.innerHTML =
      `<span class="avatar" data-bot="${b.id}"></span><span class="title-pill-name">${b.name}</span>` +
      (t ? `<span class="title-pill-task">${esc(t.title)}</span>` : "");
    pill.setAttribute("aria-label", t ? `${b.name}, ${t.title}. Show details.` : `${b.name}. Show details.`);
    pill.title = t ? t.title : "";
    CT.hydrate(pill);
    ext.header?.(b, t);
  }

  const emptyState = (b, title, text, actions = "") =>
    `<div class="empty"><div>${b ? `<span class="avatar" data-bot="${b.id}"></span>` : ""}<h1>${title}</h1><p>${text}</p>` +
    (actions ? `<div class="empty-actions">${actions}</div>` : "") +
    `</div></div>`;

  function renderTranscript() {
    const b = bot();
    const t = currentTask();
    const el = $("#transcript");
    const newButton = b && canWrite() ? `<button type="button" class="button" data-variant="primary" data-new="${b.id}">New task</button>` : "";
    const choose = onePane() ? `<button type="button" class="button" data-action="back">Choose a task</button>` : "";
    if (!b) {
      // A page built on this one may draw its own prompt for a gateway with no bots (bots.html: the first bot).
      const prompt = state0 === "discovering" ? null : CT.emptyGateway?.();
      el.innerHTML = prompt || emptyState(null, state0 === "discovering" ? "Loading" : "No bots to show", state0 === "discovering" ? "Loading this gateway's bots." : "This gateway has no bots yet.");
    } else if (!b.tasks.length) {
      el.innerHTML = emptyState(b, "No tasks yet", canWrite() ? `Start a task and ${b.name} will take it from there.` : `Conversations with ${b.name} will be listed here.`, newButton);
    } else if (!t) {
      el.innerHTML = emptyState(b, "Pick a task", canWrite() ? `Choose one of ${b.name}'s tasks, or start a new one.` : `Choose one of ${b.name}'s tasks to read the conversation.`, newButton + choose);
    } else if (model.loading) {
      el.innerHTML =
        `<div class="transcript-inner" aria-busy="true" aria-label="Loading conversation"><h1 class="task-line">${esc(t.title)}</h1>` +
        `<div class="skeleton" style="width:46%;margin-left:auto;margin-top:22px"></div>` +
        `<div class="skeleton" style="width:62%;height:88px;margin-top:16px"></div><div class="skeleton" style="width:38%"></div></div>`;
    } else if (t.fresh && !t.html) {
      el.innerHTML = emptyState(b, "Nothing here yet", `Say what you need, and ${b.name} will take it from there.`) + (t.note || "");
    } else {
      const body =
        t.html ??
        `<div class="stamp">${t.at > 0 ? "Today " : ""}${t.when}</div>` +
          turn("user", bubble("user", esc(t.ask || t.title + "?"))) +
          turn("assistant", bubble("assistant", esc(t.preview)));
      // When a refresh fails, what was last loaded stays, under one line that says so.
      const error = model.loadError
        ? `<p class="load-note" role="alert">Couldn't refresh this conversation. Showing what was loaded before.` +
          `<button type="button" class="button" data-size="sm" data-action="reload">Try again</button></p>`
        : "";
      // The task's own name is the conversation's heading.
      el.innerHTML = `<div class="transcript-inner"><h1 class="task-line">${esc(t.title)}</h1>${error}${body}</div>`;
    }
    CT.hydrate(el);
  }

  function renderComposer() {
    const b = bot();
    const t = currentTask();
    const el = $("#composer");
    el.hidden = !t; // with no task there is nothing to send to
    if (!t) return;
    if (!canWrite()) {
      el.dataset.readonly = "true";
      el.innerHTML = `<div class="composer-inner"><div class="composer-box">${icon("eye")}<span>This device can read but not send. Ask the gateway owner for write access.</span></div></div>`;
      return;
    }
    delete el.dataset.readonly;
    const draft = model.drafts[t.id] || "";
    // A page built on this one can hold a task's composer until it has read something back (bots.html: a new bot's command setting).
    const held = t.hold ? " disabled" : "";
    el.innerHTML =
      `<div class="composer-inner"><div class="composer-box">` +
      `<button type="button" class="icon-button" data-action="attach" aria-label="Attach files">${icon("plus")}</button>` +
      `<textarea class="composer-input" rows="1" aria-label="Message ${b.name}" placeholder="${offline() ? "Offline. Messages send when you reconnect." : `Message ${b.name}`}"${held}>${esc(draft)}</textarea>` +
      `<button type="button" class="icon-button send-button" data-action="send" aria-label="Send"${canSend() ? "" : " disabled"}>${icon("arrow-up")}</button>` +
      `</div></div>`;
  }

  // One guard for every way of sending: the button, Enter, anything else.
  function canSend() {
    const t = currentTask();
    return Boolean(t && canWrite() && !t.hold && (model.drafts[t.id] || "").trim());
  }

  function send() {
    if (!canSend()) return false; // nothing changes: no bubble, and the draft stays
    const t = currentTask();
    const text = model.drafts[t.id].trim();
    const existing = t.html ?? $("#transcript .transcript-inner").innerHTML.replace(/<h1 class="task-line">.*?<\/h1>/, "");
    // Offline, the message is accepted and waits; it is sent once on reconnect.
    t.html =
      existing +
      (offline()
        ? `<div class="turn" data-role="user" data-waiting="true" data-testid="transcript-turn"><div class="msg" data-role="user"><div class="bubble">${esc(text)}</div></div>` +
          `<div class="event-line" data-side="end">Sends when reconnected</div></div>`
        : turn("user", bubble("user", esc(text))) + `<div class="event-line">Sent. This prototype has no gateway, so nothing answers.</div>`);
    t.preview = text;
    t.fresh = false;
    model.drafts[t.id] = "";
    render();
    const transcript = $("#transcript");
    transcript.scrollTop = transcript.scrollHeight;
    $(".composer-input")?.focus();
    return true;
  }

  // Work pane ---------------------------------------------------------------------------------

  const panel = $("#work-panel");
  const overlaying = () => getComputedStyle(panel).position === "absolute";
  let opener = null;

  function renderPanel() {
    const b = bot();
    const t = currentTask();
    if (!b) return;
    $("#work-hero").innerHTML = `<span class="avatar" data-bot="${b.id}"></span><h2>${b.name}</h2><p>${b.label}</p>`;
    CT.hydrate($("#work-hero"));
    $("#panel-details").innerHTML = t
      ? `<p class="work-task">${esc(t.title)}</p>` +
        `<dl class="facts"><div><dt>Model</dt><dd>scripted/dev-1</dd></div><div><dt>Runs on</dt><dd>Gateway host</dd></div>` +
        `<div><dt>Last activity</dt><dd>${t.at > 0 ? "Today, " : ""}${t.when}</dd></div></dl>` +
        `<section class="work-section"><h3>Routines</h3><p class="work-note">None yet. Ask ${b.name} to do something on a schedule.</p></section>`
      : `<p class="work-note">No task is open. Pick one of ${b.name}'s tasks to see its details.</p>`;
    if (ext.panel) ext.panel(b, t);
    else {
      $("#files-empty").textContent = `Files ${b.name} reads or writes in this task appear here.`;
      $("#computer-empty").textContent = `When ${b.name} uses a browser or a desktop, you can watch it here.`;
    }
    setTab(model.tab);
  }

  function setTab(name, focus = false) {
    model.tab = name;
    $$("[data-tab]").forEach((tab) => {
      const on = tab.dataset.tab === name;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1; // one tab stop; arrows move between tabs
      if (on && focus) tab.focus();
    });
    $$('.work-sections > [role="tabpanel"]').forEach((p) => (p.hidden = p.id !== `panel-${name}`));
    ext.tabChanged?.(name);
  }

  // Opening or closing the pane keeps the reader's place: the bottom stays the
  // bottom, and otherwise the first message in view stays where it was.
  function holdPlace(change) {
    const el = $("#transcript");
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
    const top = el.getBoundingClientRect().top + 70;
    const anchor = atEnd ? null : $$(".msg, .stamp, .steps", el).find((node) => node.getBoundingClientRect().bottom > top);
    const before = anchor?.getBoundingClientRect().top;
    change();
    if (atEnd) el.scrollTop = el.scrollHeight;
    else if (anchor) el.scrollTop += anchor.getBoundingClientRect().top - before;
  }

  // As a drawer the pane is modal: focus moves in and stays in, and what is
  // behind it is inert. Docked, it is an ordinary part of the page.
  let wasModal = false;
  function applyModality() {
    const modal = model.panel && overlaying();
    $(".rail").inert = modal;
    $(".conversation").inert = modal;
    if (modal) {
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");
      // Entering drawer mode with the pane already open: focus must not be left
      // on something that has just become inert.
      if (!wasModal && !panel.contains(document.activeElement)) $(".work-close").focus();
    } else {
      panel.removeAttribute("role");
      panel.removeAttribute("aria-modal");
    }
    wasModal = modal;
    return modal;
  }

  function setPanel(open) {
    if (open === model.panel) return;
    if (open) opener = document.activeElement;
    holdPlace(() => {
      model.panel = open;
      shell.dataset.panel = open ? "open" : "closed";
    });
    const button = $("#panel-button");
    button.setAttribute("aria-pressed", String(open));
    button.setAttribute("aria-label", open ? "Hide work panel" : "Show work panel");
    ext.panelChanged?.(open);
    const closedModal = !open && wasModal;
    applyModality();
    if (closedModal) (opener && document.contains(opener) ? opener : button).focus(); // a drawer gives focus back
  }

  // Crossing the docking width while the pane is open changes whether it is modal.
  new ResizeObserver(() => {
    applyModality();
    const el = $("#transcript");
    if (el.dataset.atEnd === "true") el.scrollTop = el.scrollHeight; // the bottom stays the bottom through any reflow
  }).observe($(".main-pane"));

  // Connection ------------------------------------------------------------------------------------
  // dot: the gateway's presence, shown in the rail. tone: the strip's own state.

  const connections = {
    connected: { dot: "connected", footer: "Connected" },
    reconnecting: { dot: "reconnecting", footer: "Reconnecting…", tone: "warn", text: "Reconnecting in 4s", more: "showing saved messages", action: "Retry now" },
    offline: { dot: "error", footer: "Can't reach the gateway", tone: "danger", text: "Can't reach Home gateway", more: "showing saved messages", action: "Retry now" },
    syncing: { dot: "connecting", footer: "Catching up", tone: "warn", text: "Connected", more: "catching up" },
    synced: { dot: "connected", footer: "Connected", tone: "ok", text: "Synced", more: "1 new in this task" },
    failed: { dot: "connected", footer: "Connected", tone: "danger", text: "Couldn't sync this task", action: "Try again" },
  };
  let connectionTimer = null;

  function setConnection(name) {
    clearTimeout(connectionTimer);
    model.connection = name;
    const c = connections[name];
    // One state drives the strip, both rail dots, the footer and the composer.
    $$(".rail .status-dot").forEach((dot) => (dot.dataset.status = c.dot));
    $("#gateway-state").textContent = c.footer;
    $("#gateway-menu-state").textContent = `${c.footer} · gateway.local`;
    $$('[data-action="gateway-menu"]').forEach((button) => button.setAttribute("aria-label", `Home gateway, ${c.footer.toLowerCase().replace("…", "")}. Open the gateway menu.`));
    const strip = $("#status-strip");
    strip.hidden = !c.text;
    $(".conversation").dataset.strip = String(Boolean(c.text));
    if (c.text) {
      strip.dataset.tone = c.tone;
      strip.title = c.more ? `${c.text} · ${c.more}` : c.text; // the explanation can shorten; the tooltip never does
      // The strip's dot takes the strip's tone, not the gateway's presence.
      strip.innerHTML =
        `<span class="status-dot"></span><span class="status-strip-text">${c.text}` +
        `${c.more ? `<span>· ${c.more}</span>` : ""}</span>${c.action ? `<button type="button" data-action="retry">${c.action}</button>` : ""}`;
    }
    renderComposer();
    ext.connectionChanged?.(name);
    if (name === "syncing") connectionTimer = setTimeout(() => arrive(), 900);
    if (name === "synced") connectionTimer = setTimeout(() => setConnection("connected"), 4000); // leaves after 4 seconds
  }

  // What was missed arrives: merged into the open task, without moving the reader.
  // Messages written offline are sent now, once.
  function arrive() {
    const t = currentTask();
    const el = $("#transcript");
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
    bots.forEach((b) =>
      b.tasks.forEach((other) => {
        if (other.html) other.html = other.html.replace(/ data-waiting="true"/g, "").replace(/<div class="event-line" data-side="end">Sends when reconnected<\/div>/g, "");
      }),
    );
    if (t && t.html !== undefined && !t.fresh) {
      t.html += turn("assistant", bubble("assistant", "While you were offline: the old cache folder is still untouched. I will remove it next Monday."));
      const top = el.scrollTop;
      renderTranscript();
      el.scrollTop = atEnd ? el.scrollHeight : top;
      $("#jump-latest").hidden = atEnd;
    }
    setConnection("synced");
  }

  // Everything ------------------------------------------------------------------------------------

  function render() {
    $("#new-button").hidden = !canWrite(); // creating is offered only where the connection may write
    renderRail();
    renderHeader();
    renderTranscript();
    renderComposer();
    renderPanel();
  }

  function note(text) {
    const node = $("#run-caption");
    if (node) node.textContent = text;
  }

  // Menus ------------------------------------------------------------------------------------------

  const gatewayMenu = $("#gateway-menu");
  const railMenu = $("#rail-menu");
  let menuOpener = null;

  function setGatewayMenu(open, from) {
    gatewayMenu.hidden = !open;
    $$('[data-action="gateway-menu"]').forEach((button) => button.setAttribute("aria-expanded", String(open)));
    if (open) {
      menuOpener = from;
      const stored = CT.settings.followSystem ? "system" : CT.settings.theme;
      $$("[data-theme-choice]").forEach((item) => item.setAttribute("aria-checked", String(item.dataset.themeChoice === stored)));
      ($('[data-theme-choice][aria-checked="true"]') || $(".menu-item", gatewayMenu)).focus();
    } else if (menuOpener) {
      menuOpener.focus();
      menuOpener = null;
    }
  }

  const item = (label, attrs, keys = "", tone = "") =>
    `<li role="none"><button type="button" class="menu-item" role="menuitem"${tone ? ` data-tone="${tone}"` : ""} ${attrs}>${label}${keys ? `<kbd>${keys}</kbd>` : ""}</button></li>`;

  // The "+" menu: a new task for the open bot, and a new bot.
  // A bot's context menu: new task, fold, pin.
  function openRailMenu(kind, from, x, y) {
    const b = kind === "new" ? bot() : bot(from.dataset.bot);
    railMenu.innerHTML =
      kind === "new"
        ? (b && canWrite() ? item(`New task for ${b.name}`, `data-new="${b.id}"`, "⌘T") : "") + item("New bot", 'data-action="new-bot"', "⌘N")
        : (canWrite() ? item("New task", `data-new="${b.id}"`) : "") +
          (b.tasks.length > 1 ? item(isOpen(b) ? "Hide tasks" : "Show tasks", `data-toggle="${b.id}"`) : "") +
          item(isPinned(b) ? "Unpin" : "Pin", `data-pin="${b.id}"`);
    railMenu.setAttribute("aria-label", kind === "new" ? "New" : `${b.name}`);
    railMenu.hidden = false;
    railMenu.style.left = `${Math.max(8, Math.min(x, innerWidth - 244))}px`;
    railMenu.style.top = `${Math.min(y, innerHeight - railMenu.offsetHeight - 8)}px`;
    menuOpener = from;
    if (kind === "new") from.setAttribute("aria-expanded", "true");
    $(".menu-item", railMenu).focus();
  }

  function closeRailMenu(refocus = true) {
    if (railMenu.hidden) return;
    railMenu.hidden = true;
    $("#new-button").setAttribute("aria-expanded", "false");
    if (refocus && menuOpener && document.contains(menuOpener)) menuOpener.focus();
    menuOpener = null;
  }

  // Wiring --------------------------------------------------------------------------------------------

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!gatewayMenu.hidden && !target.closest("#gateway-menu, [data-action='gateway-menu']")) setGatewayMenu(false);
    const inRailMenu = target.closest("#rail-menu");
    if (!railMenu.hidden && !inRailMenu && !target.closest('[data-action="new-menu"]')) closeRailMenu(false);

    const pin = target.closest("[data-pin]");
    if (pin) {
      closeRailMenu(false);
      return togglePin(pin.dataset.pin);
    }

    const toggle = target.closest("[data-toggle]");
    if (toggle) {
      closeRailMenu(false);
      return toggleFold(toggle.dataset.toggle);
    }

    const more = target.closest("[data-more]");
    if (more) {
      const id = more.dataset.more;
      if (model.showAll.has(id)) model.showAll.delete(id);
      else model.showAll.add(id);
      return renderRail();
    }

    const fresh = target.closest("[data-new]");
    if (fresh) {
      closeRailMenu(false);
      return newTask(fresh.dataset.new);
    }

    const row = target.closest(".task[data-task]");
    if (row) return openTask(row.dataset.bot, row.dataset.task);

    const botRow = target.closest(".bot, .pin");
    if (botRow) {
      const id = botRow.dataset.bot;
      const b = bot(id);
      if (b.tasks.length < 2) return selectBot(id);
      // One pane: a bot with several tasks unfolds in place; a task opens.
      if (onePane()) return toggleFold(id);
      // Two panes: opening a bot opens its task and unfolds it; the open bot folds and unfolds.
      if (id === model.selectedBot) return toggleFold(id);
      return selectBot(id);
    }

    const theme = target.closest("[data-theme-choice]");
    if (theme) {
      CT.setTheme(theme.dataset.themeChoice);
      return setGatewayMenu(false);
    }

    const tab = target.closest("[data-tab]");
    if (tab) return setTab(tab.dataset.tab);

    const action = target.closest("[data-action]")?.dataset.action;
    if (action === "panel") setPanel(!model.panel);
    if (action === "panel-close") setPanel(false);
    if (action === "back") {
      shell.dataset.view = "list";
      renderRail();
    }
    if (action === "gateway-menu") setGatewayMenu(gatewayMenu.hidden, target.closest("button"));
    if (action === "new-menu") {
      const button = target.closest("button");
      if (!railMenu.hidden) return closeRailMenu();
      const rect = button.getBoundingClientRect();
      openRailMenu("new", button, rect.right - 232, rect.bottom + 6);
    }
    if (action === "disconnect") location.href = "connect.html" + location.search;
    if (action === "retry") setConnection("syncing");
    if (action === "reload") {
      model.loadError = false;
      renderTranscript();
      note("Try again: the conversation loaded.");
    }
    if (action === "send") send();
    if (action === "jump") {
      const el = $("#transcript");
      el.scrollTop = el.scrollHeight;
    }
    if (action === "search") note("Search is not part of this prototype.");
    if (action === "new-bot") {
      closeRailMenu();
      note("Creating a bot is not part of this prototype.");
    }
    if (action === "attach") note("Attaching files is not part of this prototype.");
  });

  // A bot's context menu: right-click, or the menu key on a focused row.
  document.addEventListener("contextmenu", (event) => {
    const row = event.target.closest("#bot-list .bot, #bot-list .pin");
    if (!row) return;
    event.preventDefault();
    const rect = row.getBoundingClientRect();
    openRailMenu("bot", row, event.clientX || rect.left + 40, event.clientY || rect.bottom);
  });

  document.addEventListener("input", (event) => {
    if (!event.target.classList.contains("composer-input")) return;
    model.drafts[currentTask().id] = event.target.value;
    $(".send-button").disabled = !canSend();
  });

  $("#transcript").addEventListener("scroll", (event) => {
    const el = event.currentTarget;
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
    el.dataset.atEnd = String(atEnd);
    if (atEnd) $("#jump-latest").hidden = true;
  });

  document.addEventListener("keydown", (event) => {
    const target = event.target;

    if ((event.metaKey || event.ctrlKey) && event.key === "\\") {
      event.preventDefault();
      return setPanel(!model.panel);
    }
    // New task: ⌘T in the desktop app. A browser keeps ⌘T for itself, so ⌥T does the same there.
    if ((event.metaKey || event.ctrlKey || event.altKey) && event.code === "KeyT" && bot()) {
      event.preventDefault();
      return newTask(model.selectedBot);
    }
    if (event.key === "Escape") {
      if (!railMenu.hidden) return closeRailMenu();
      if (!gatewayMenu.hidden) return setGatewayMenu(false);
      if (model.panel && overlaying()) return setPanel(false);
    }
    // Enter and the Send button are the same guarded operation.
    if (event.key === "Enter" && !event.shiftKey && target.classList?.contains("composer-input")) {
      event.preventDefault();
      return send();
    }

    // The drawer keeps focus inside itself.
    if (event.key === "Tab" && model.panel && overlaying()) {
      const items = $$("button, [tabindex='0']", panel).filter((el) => !el.closest("[hidden]") && el.tabIndex >= 0);
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    // Tabs: Left and Right move and select; Home and End go to the ends.
    if (target.matches?.("[data-tab]") && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const tabs = $$("[data-tab]");
      const index = tabs.indexOf(target);
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      return setTab(tabs[next].dataset.tab, true);
    }

    // The gateway menu opens from its button with Up or Down, as well as Enter and Space.
    if (gatewayMenu.hidden && target.matches?.('[data-action="gateway-menu"]') && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      return setGatewayMenu(true, target);
    }

    // An open menu: Up and Down move between items; Tab closes it.
    const openMenu = !gatewayMenu.hidden ? gatewayMenu : !railMenu.hidden ? railMenu : null;
    if (openMenu && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const items = $$(".menu-item", openMenu);
      const index = items.indexOf(document.activeElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      return items[next].focus();
    }
    if (openMenu && event.key === "Tab") {
      if (openMenu === railMenu) closeRailMenu();
      else setGatewayMenu(false);
    }

    // The rail: Up and Down move through the rows; Right unfolds a bot, Left folds it.
    const row = target.closest?.("#bot-list .bot, #bot-list .pin, #bot-list .task");
    if (row) {
      const rows = $$("#bot-list .bot, #bot-list .pin, #bot-list .task");
      const index = rows.indexOf(row);
      const isBot = row.dataset.bot && !row.dataset.task;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        rows[Math.min(rows.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))].focus();
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        rows[event.key === "Home" ? 0 : rows.length - 1].focus();
      } else if (event.key === "ArrowRight" && isBot && !isOpen(bot(row.dataset.bot))) {
        event.preventDefault();
        toggleFold(row.dataset.bot);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        if (row.classList.contains("task")) {
          const owner = row.dataset.bot || row.dataset.more || row.dataset.new;
          $(`[data-key="b:${owner}"]`)?.focus();
        } else if (isOpen(bot(row.dataset.bot))) {
          toggleFold(row.dataset.bot);
        }
      } else if (isBot && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
        event.preventDefault();
        const rect = row.getBoundingClientRect();
        openRailMenu("bot", row, rect.left + 40, rect.bottom);
      }
    }
  });

  // The full title of a truncated task, on hover and on keyboard focus.
  const tip = $("#rail-tooltip");
  function showTip(row) {
    const title = $(".task-title", row);
    if (!row.dataset.full || title.scrollWidth <= title.clientWidth) return hideTip();
    const rect = row.getBoundingClientRect();
    tip.textContent = row.dataset.full;
    tip.hidden = false;
    const fits = rect.right + 12 + tip.offsetWidth < innerWidth;
    tip.style.left = fits ? `${rect.right + 8}px` : `${Math.max(8, rect.left)}px`;
    tip.style.top = fits ? `${rect.top + rect.height / 2}px` : `${rect.bottom + 18}px`;
  }
  const hideTip = () => (tip.hidden = true);
  $("#bot-list").addEventListener("mouseover", (event) => {
    const row = event.target.closest(".task[data-task]");
    if (row) showTip(row);
    else hideTip();
  });
  $("#bot-list").addEventListener("mouseleave", hideTip);
  $("#bot-list").addEventListener("focusin", (event) => {
    const row = event.target.closest(".task[data-task]");
    if (row && row.matches(":focus-visible")) showTip(row);
    else hideTip();
  });
  $("#bot-list").addEventListener("focusout", hideTip);
  $("#bot-list").addEventListener("scroll", hideTip);

  // First paint -----------------------------------------------------------------------------------------

  const startBot = bot();
  if (startBot) {
    model.selectedTask = state0 === "empty" ? null : params.get("task") || model.remembered[startBot.id] || sorted(startBot)[0]?.id || null;
    if (isPinned(startBot)) {
      if (!params.get("pinopen") && startBot.tasks.length > 1 && !list("fold").includes(startBot.id)) model.pinOwner = startBot.id;
    } else if (!list("fold").includes(startBot.id)) model.unfolded.add(startBot.id);
    list("unfold").forEach((id) => model.held.add(id));
    const opened = currentTask();
    if (opened) opened.unread = false;
  } else {
    model.selectedBot = null;
  }
  if (params.get("view")) shell.dataset.view = params.get("view");

  render();
  setConnection(params.get("banner") || "connected");
  if (state0 === "newtask") newTask(startBot.id);
  if (params.get("panel") === "open") setPanel(true);
  const transcript = $("#transcript");
  transcript.scrollTop = transcript.scrollHeight;
  transcript.dataset.atEnd = "true";
  if (params.get("menu") === "new") $("#new-button").click();
  if (params.get("menu") === "gateway") $(".gateway-pill").click();
  if (params.get("menu") === "bot") {
    const row = $(`[data-key="b:${params.get("menubot") || "marlow"}"]`);
    const rect = row.getBoundingClientRect();
    openRailMenu("bot", row, rect.left + 60, rect.bottom - 6);
  }

  // Controls in the prototype's bar, for the states that have no control in the app.
  const extra = $("#proto-extra");
  if (extra) {
    extra.innerHTML =
      `<span class="run-controls"><button type="button" data-fixture="pins">Pins</button>` +
      `<button type="button" data-fixture="offline">Go offline</button>` +
      `<button type="button" data-fixture="readonly">Read-only</button>` +
      `<button type="button" data-fixture="notask">No task</button>` +
      `<span id="run-caption">Click bots and tasks; right-click a bot for its menu. Arrow keys move through the rail.</span></span>`;
    extra.addEventListener("click", (event) => {
      const fixture = event.target.closest("[data-fixture]")?.dataset.fixture;
      if (fixture === "pins") {
        if (model.pinned.size) {
          model.pinned.clear();
          model.pinOwner = null;
          model.unfolded.add(model.selectedBot);
        } else {
          ["pip", "juniper"].forEach((id) => model.pinned.add(id));
          if (isPinned(bot())) model.pinOwner = model.selectedBot;
        }
        renderRail();
      }
      if (fixture === "offline") setConnection(model.connection === "connected" ? "reconnecting" : "connected");
      if (fixture === "readonly") {
        model.access = canWrite() ? "read" : "write";
        render();
      }
      if (fixture === "notask") {
        model.selectedTask = null;
        render();
      }
    });
  }

  window.app = { model, bots, render, setConnection, setPanel, setTab, openTask, selectBot, toggleFold, togglePin, newTask, send, holdPlace, overlaying };
  ext.ready?.(window.app);
})();
